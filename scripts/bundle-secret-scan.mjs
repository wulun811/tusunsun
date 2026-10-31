#!/usr/bin/env node
/**
 * 送审/发行包的**内容级**敏感文件扫描。
 *
 * 为什么必须存在（rc.17 事故）：`.env` 已经在 `.gitignore` 里、也从未被 git 跟踪，
 * 但送审 ZIP 是**按目录 tar**打出来的 —— `.gitignore` 只约束 git，不约束 tar。
 * 于是 rc.17 的源码 ZIP 根目录带上了开发者本机的 `.env`（真实 API key，51 字符），
 * 还一并写进了 `MANIFEST.sha256`，于是 `sha256sum -c` 会开心地报告"清单完整"。
 *
 * 清单完整性 ≠ 内容安全。判据必须落在**打包产物本身**上，且不能依赖打包脚本记得加
 * `--exclude`：漏一个 `--exclude` 是静默的，而这里失败是响的。
 *
 * 用法：
 *   node scripts/bundle-secret-scan.mjs <pack.zip|pack.tgz> [...]
 *   node scripts/bundle-secret-scan.mjs --list <pack.zip>   # 只列命中，不判值
 *
 * 退出码：0 = 干净；1 = 命中（必须修包）；2 = 扫描器自身出错（不当作干净）。
 *
 * 边界：这里查的是**文件名/路径**这类确定判据，以及"密钥字段是否像占位符"。
 * 它不做熵检测、不猜内容 —— 猜出来的命中会制造假绿和假红两种债。真值判断归人。
 */
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import zlib from 'node:zlib';

/** 无论内容如何都不许进包的**文件名**（小写比对，含 `.env.*` 变体）。 */
const FORBIDDEN_BASENAMES = new Set([
  '.env', '.env.local', '.env.production', '.env.development', '.env.test',
  '.npmrc', '.pypirc', '.netrc', '.git-credentials', 'id_rsa', 'id_ed25519',
  'credentials.json', 'service-account.json',
]);

/** 文件名命中即判定的扩展名（私钥/证书仓库）。 */
const FORBIDDEN_EXTS = new Set(['.pem', '.key', '.p12', '.pfx', '.keystore', '.jks']);

/** 目录段命中即判定（不该出现在发行物里的路径）。 */
const FORBIDDEN_SEGMENTS = new Set(['.git', '.ssh', '.gnupg', '.aws']);

/** 字段名像凭据时，值再满足这些条件就算"疑似真值"。 */
const CRED_FIELD = /(KEY|TOKEN|SECRET|PASS|CREDENTIAL|AUTH)/i;
const PLACEHOLDER = /(placeholder|your[_-]|example|replace[_-]?me|dummy|xxxx|changeme|<.*>|^\$\{.*\}$|^\.\.\.$)/i;

/**
 * 内容级扫描**只作用于 env 类载体**，不扫源码。
 *
 * 为什么收窄（第一版教训）：把"含 KEY/TOKEN 的赋值行"套到全部源码上，会把
 * `const key = args.path` / `for (const k of Object.keys(...))` / 注释里的
 * `?token=` 全判成疑似凭据 —— 一次报出 100+ 条，全是假红。假红比漏报更坏：
 * 它训练人忽略这个门禁，于是真命中也会被跳过。
 *
 * 判据分层：文件名（确定性，零假红）→ 目录段（确定性）→ env 类载体的
 * `UPPER_SNAKE=value`（高信噪比）。源码里的密钥不归这里管，归代码评审。
 */
const ENV_LIKE = /(^\.env|\.env$|\.env\.|^\.npmrc$|^\.pypirc$|^\.netrc$|^\.git-credentials$|^credentials\.json$|^service-account\.json$)/;
/** dotenv 形状：整行必须是 `UPPER_SNAKE=...`，且允许 `export ` 前缀。 */
const ENV_ASSIGN = /^(?:export\s+)?([A-Z][A-Z0-9_]{2,})\s*=\s*(.*)$/;

/**
 * 抽出 env 类载体里的凭据字段名与长度。
 * 契约：**只返回值长度与字段名，绝不返回值** —— 扫描报告不能变成第二处泄露，
 * 也不能被贴进工单/日志/专家回复里当作证据。
 * @param {string|undefined} text
 * @returns {Array<{key_name: string, value_length: number}>}
 */
function envFields(text) {
  if (typeof text !== 'string') return [];
  const fields = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const m = ENV_ASSIGN.exec(s);
    if (!m) continue;
    const k = m[1];
    const v = m[2].trim().replace(/^["']|["']$/g, '');
    if (!CRED_FIELD.test(k) || !v) continue;
    if (PLACEHOLDER.test(v)) continue;
    fields.push({ key_name: k, value_length: v.length });
  }
  return fields;
}

/**
 * 扫一个文件列表（`{path, text}`），返回命中。
 * @param {Array<{path: string, text?: string}>} entries
 * @returns {Array<{path: string, reason: string, detail?: object}>}
 */
export function scanEntries(entries) {
  const findings = [];
  for (const { path, text } of entries) {
    const parts = path.split('/');
    const base = (parts[parts.length - 1] || '').toLowerCase();
    const segs = parts.slice(0, -1).map((s) => s.toLowerCase());

    if (FORBIDDEN_BASENAMES.has(base) || base.startsWith('.env.')) {
      // 文件名已经定性，但**附上字段名/长度**才有处置价值：运维要知道该轮换哪一把。
      // 这也是为什么这一条不 `continue` —— 值仍然永不回显。
      findings.push({ path, reason: 'forbidden_filename', detail: envFields(text) });
      continue;
    }
    if (FORBIDDEN_EXTS.has(extname(base))) {
      findings.push({ path, reason: 'forbidden_extension' });
      continue;
    }
    const badSeg = segs.find((s) => FORBIDDEN_SEGMENTS.has(s));
    if (badSeg) {
      findings.push({ path, reason: 'forbidden_directory', detail: { segment: badSeg } });
      continue;
    }
    // 内容级：**只查 env 类载体**，且只认 dotenv 形状（整行 `UPPER_SNAKE=值`）。
    // 源码不在这里扫 —— 见 ENV_LIKE 的注释（第一版扫全仓报 100+ 条假红）。
    if (typeof text !== 'string' || !ENV_LIKE.test(base)) continue;
    const fields = envFields(text);
    if (fields.length) findings.push({ path, reason: 'credential_assignment', detail: { fields } });
  }
  return findings;
}

/** 从 zip 读条目（只读，不落盘）。 */
function readZip(buf) {
  const entries = [];
  // 找 EOCD
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not_a_zip: EOCD not found');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('not_a_zip: bad central directory');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    let text;
    try {
      text = method === 0 ? raw.toString('utf8') : zlib.inflateRawSync(raw).toString('utf8');
    } catch { text = undefined; }
    entries.push({ path: name, text });
  }
  return entries;
}

/** 从 tgz 读条目（只读，不落盘）。 */
function readTgz(buf) {
  const tar = zlib.gunzipSync(buf);
  const entries = [];
  let off = 0;
  while (off + 512 <= tar.length) {
    const name = tar.toString('utf8', off, off + 100).replace(/\0.*$/, '');
    if (!name) { off += 512; continue; }
    const sizeOctal = tar.toString('utf8', off + 124, off + 136).replace(/\0.*$/, '').trim();
    const size = parseInt(sizeOctal || '0', 8) || 0;
    const type = String.fromCharCode(tar[off + 156] || 48);
    const body = tar.subarray(off + 512, off + 512 + size);
    if (type === '0' || type === '\0') entries.push({ path: name, text: body.toString('utf8') });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function main(argv) {
  const files = argv.filter((a) => !a.startsWith('--'));
  if (!files.length) {
    console.error('usage: node scripts/bundle-secret-scan.mjs <pack.zip|pack.tgz> [...]');
    return 2;
  }
  let bad = 0;
  for (const f of files) {
    let entries;
    try {
      const buf = readFileSync(f);
      entries = f.endsWith('.tgz') || f.endsWith('.tar.gz') ? readTgz(buf) : readZip(buf);
    } catch (err) {
      console.error(JSON.stringify({ file: f, status: 'SCAN_ERROR', error: String(err?.message || err) }));
      bad = 2;
      continue;
    }
    const findings = scanEntries(entries);
    const verdict = findings.length ? 'SECRET_EXPOSURE' : 'CLEAN';
    console.log(JSON.stringify({ file: f, status: verdict, entries: entries.length, findings }, null, 2));
    if (findings.length) bad = 1;
  }
  return bad;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main(process.argv.slice(2));
