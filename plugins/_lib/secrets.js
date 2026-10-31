import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { readEnv } from '../../src/core/env.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const ITERATIONS = 100000;
const KEY_DIGEST = 'sha512';

/** 具名失败：`code` 是给调用方判别的，`hint` 是给人看的下一步。 */
function secretError(code, ...lines) {
  const cause = lines.find((l) => l && typeof l === 'object');
  const text = lines.filter((l) => typeof l === 'string').join('');
  return Object.assign(new Error(text), { code, contractError: true, ...(cause ? { cause } : {}) });
}

class SecretsManager {
  constructor(core) {
    this.core = core;
    this._cache = new Map();
    // 解不开的条目：记住名字，避免每次 get() 都重跑一遍 PBKDF2+GCM 再失败。
    this._undecryptable = new Map();
    this._masterKey = this._deriveMasterKey();
  }

  _loadOrCreateSalt() {
    const saltPath = `${this.core.stateDir}/secrets-salt.bin`;
    if (existsSync(saltPath)) return readFileSync(saltPath);
    const salt = randomBytes(16);
    try {
      writeFileSync(saltPath, salt, { mode: 0o600 });
    } catch (e) {
      this.core.log('warn', `[secrets] Failed to persist salt: ${e.message}`);
    }
    return salt;
  }

  _deriveMasterKey() {
    const raw = this._readMasterKey();
    if (!raw) {
      this._ephemeralKey = true;
      this.core.log('warn', '[secrets] No master key found, generating ephemeral key (secrets lost on restart)');
      return randomBytes(KEY_LENGTH);
    }
    this._ephemeralKey = false;
    const salt = this._loadOrCreateSalt();
    return pbkdf2Sync(raw, salt, ITERATIONS, KEY_LENGTH, KEY_DIGEST);
  }

  _readMasterKey() {
    const filePath = readEnv('SECRET_KEY_FILE');
    if (filePath && existsSync(filePath)) {
      try {
        return readFileSync(filePath, 'utf8').trim();
      } catch (e) {
        this.core.log('warn', `[secrets] Failed to read key file: ${e.message}`);
      }
    }
    return readEnv('SECRET_KEY') || null;
  }

  encrypt(value) {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this._masterKey, iv);
    let encrypted = cipher.update(value, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return JSON.stringify({ iv: iv.toString('hex'), encrypted, authTag });
  }

  decrypt(packageStr) {
    try {
      const { iv, encrypted, authTag } = JSON.parse(packageStr);
      const decipher = createDecipheriv(ALGORITHM, this._masterKey, Buffer.from(iv, 'hex'));
      decipher.setAuthTag(Buffer.from(authTag, 'hex'));
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch {
      return null;
    }
  }

  get(name) {
    if (this._cache.has(name)) return this._cache.get(name);
    const config = this.core.getService('config');
    const raw = config?.get(name);
    if (!raw) return null;
    if (typeof raw === 'string' && raw.startsWith('{"iv":"')) {
      const decrypted = this.decrypt(raw);
      if (decrypted !== null) {
        this._cache.set(name, decrypted);
        return decrypted;
      }
      // 解不开就是解不开：绝不能把密文当明文交出去。上一版 `return raw` 把
      // `{"iv":…}` 当成 API key 发给上游，用户看到的是一次鉴权失败，而真相是密钥没读到。
      // 这里具名留痕并在本次进程内记住失败，不再反复尝试昂贵的 PBKDF2/GCM。
      this._undecryptable.set(name, true);
      this.core.log('error', `[secrets] '${name}' 无法解密（master key 已变、salt 丢失，或密文损坏）。`
        + '已拒绝把它当明文返回。请重新设置该密钥，或恢复原来的 TUSUNSUN_SECRET_KEY / secrets-salt.bin。');
      return null;
    }
    return raw;
  }

  // B-09（试点004 审查）：set/delete 原先用 config.set 只改内存、永不落盘——密文重启即失、
  // delete 重启后复活。改走 setAndSave（原子写配置文件）。
  //
  // R22-C：上一版只把落盘失败降级成一条 warn 就 resolve。实测注入 EACCES 后
  // `await secrets.set('model.apiKey','SENSITIVE')` **正常完成**：本进程从缓存读得到，
  // 磁盘上什么都没有。调用方看到"设置成功"，下一次重启就是没有这个密钥 ——
  // 「设置保存后能在重启后读到」这条最基本的期待被静默违反。
  //
  // 现在：**只有落盘成功才对外承诺成功**。落盘失败则回滚内存缓存并把具名错误抛出去；
  // 调用方拿到的要么是 persisted:true，要么是一个必须处理的异常。
  async set(name, value) {
    const config = this.core.getService('config');
    if (!config?.setAndSave) {
      // 没有 config 服务 = 没有任何持久化能力。**不能**假装存住了。
      throw secretError('secrets_unavailable',
        `无法保存密钥 '${name}'：config 服务不可用，本进程无处持久化。`
        + '在这个实例上设置密钥不会被保存。');
    }
    if (this._ephemeralKey) {
      // 无稳定主密钥 ⇒ 密文只能用一次性密钥解开，写进去的是一条**下次启动注定读不回**的数据。
      // 与其存一条骗人的密文，不如拒绝并要求先配好稳定密钥。
      throw secretError('secrets_ephemeral_key',
        `无法保存密钥 '${name}'：当前实例没有稳定的主密钥（未设置 TUSUNSUN_SECRET_KEY，`,
        '且 secrets-salt.bin 也不足以重建），加密结果重启后必然解不开。',
        '请先设置 TUSUNSUN_SECRET_KEY（或用 TUSUNSUN_SECRET_KEY_FILE 指向一个稳定的密钥文件），再重新设置。');
    }
    const encrypted = this.encrypt(value);
    const previous = this._cache.has(name) ? this._cache.get(name) : undefined;
    const hadPrevious = this._cache.has(name);
    this._cache.set(name, value);   // 先写缓存，失败再回滚 —— 读路径不能因为写盘慢而看不到刚设的值
    try {
      await config.setAndSave(name, encrypted);
    } catch (e) {
      // 回滚：缓存与磁盘必须给出同一个答案。
      if (hadPrevious) this._cache.set(name, previous); else this._cache.delete(name);
      this.core.log('error', `[secrets] Failed to persist secret '${name}': ${e.message}`);
      throw secretError('secrets_persist_failed',
        `密钥 '${name}' 没有保存成功（落盘失败：${e.code || e.message}）。`,
        '内存中的值已回滚，因此这次设置**没有生效**。请修复配置目录的写权限后重试。',
        e);
    }
    return { persisted: true, name };
  }

  has(name) {
    if (this._cache.has(name)) return true;
    const config = this.core.getService('config');
    return config?.get(name) != null;
  }

  async delete(name) {
    const config = this.core.getService('config');
    if (!config?.setAndSave) {
      throw secretError('secrets_unavailable',
        `无法删除密钥 '${name}'：config 服务不可用，本次删除没有落盘。`);
    }
    const previous = this._cache.has(name) ? this._cache.get(name) : undefined;
    const hadPrevious = this._cache.has(name);
    this._cache.delete(name);
    try {
      await config.setAndSave(name, undefined);
    } catch (e) {
      // 删不掉就把缓存恢复：否则本进程"删掉了"、重启后密钥又回来，是最难查的一种不一致。
      if (hadPrevious) this._cache.set(name, previous);
      this.core.log('error', `[secrets] Failed to persist secret deletion '${name}': ${e.message}`);
      throw secretError('secrets_persist_failed',
        `密钥 '${name}' 没有删除成功（落盘失败：${e.code || e.message}）：它仍存在，且重启后依然存在。`,
        undefined, e);
    }
    return { deleted: true, name };
  }

  async init() {
    this.core.registerService('secrets', this);
    this.core.log('info', '[secrets] Secrets manager ready');
  }
}

export { SecretsManager };
export default SecretsManager;
