import { rename, cp, unlink, mkdir, readdir, stat, rm, lstat, readFile } from 'node:fs/promises';
import { declarableSchema } from './lib/schema.mjs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { resolveWorkspacePath } from './lib/workspace.mjs';
import { readEnv } from '../../src/core/env.js';

/**
 * 回收站的保留与清理策略 —— **唯一的**策略来源，也是回执里如实告知的那一份。
 *
 * 上一版（rc.22）在每次删除后按条数无条件清理到 500 条。它修掉了"只增不减"，
 * 但把"可恢复"变成了**有条件**的承诺而没说：实测删 `important.txt` → `ok:true` +
 * `trashed:<路径>`，再删 505 个文件，那条 `trashed` 路径就没了，
 * 文件被自动永久删除 —— 而回执仍然指着它。
 *
 * 一个指向已消失文件的回执，比没有回执更糟：它让"可恢复"显得已验证。
 * 所以本版把三件事绑在一起：
 *   ① 默认**不做任何不可逆清理**（`retention.autoPrune=false`）；
 *   ② 保留期与条数上限是**显式策略**，能在配置里看见、能在回执里读到；
 *   ③ 清理必须由上层显式授权（`trash.prune` 能力），且逐条留审计记录，
 *      清理失败**不隐藏**（写不进去就报错，不 catch 成空）。
 */
const DEFAULT_RETENTION = {
  /** 自动清理默认关闭：没有上层授权，就不发生不可逆操作。 */
  autoPrune: false,
  /** 允许被自动清理的最小条目年龄（天）。只在 autoPrune=true 时起作用。 */
  maxAgeDays: 30,
  /** 硬上限（条数）。只在 autoPrune=true 时起作用，且只作为按年龄清理之外的护栏。 */
  maxEntries: 500,
};

class ToolRm {
  name = 'tool-rm';
  version = '0.3.0';
  permissions = ['fs.write'];
  provides = [{ name: 'tool.rm', removable: true }];
  cohesion = 'atomic';
  description = 'Move files to trash. Deleted items stay recoverable until an explicit prune (see trash.retention in the receipt). IMPORTANT: path must be RELATIVE to workspace.';
  parameters = {
    type: 'object',
    properties: { path: { type: 'string', description: 'RELATIVE file path from workspace' } },
    required: ['path'],
  };

  async init(core) {
    this.core = core;
    // R0-113（P1-02 连带）：回收站属于**本次实例的状态目录**，不能恒写 `~/.tusunsun`
    // （多实例/自定义 --state-dir 时会把 A 实例删的文件丢进 B 实例的垃圾桶）。
    this._trashDir = join(core?.stateDir || join(homedir(), '.tusunsun'), 'trash');
    if (!existsSync(this._trashDir)) await mkdir(this._trashDir, { recursive: true, mode: 0o700 }).catch(() => {});
    // 审计日志：清理是**不可逆**的，所以每一次都要有可读的落盘记录。
    // 放回收站同级、不进回收站本身（否则日志会占掉回收站的名额）。
    this._pruneLog = join(core?.stateDir || join(homedir(), '.tusunsun'), 'trash-prune.log');
    core.registerCapability('tool.rm', {
      description: 'Move files to trash (recoverable until an explicit prune)',
      handler: (args) => this.execute(args),
      // R0-152：只把内核**真能校验**的部分作为 input_schema（`parameters` 里的 enum/items
      // 等给模型看的约束不进校验层，否则注册会被 core 具名拒绝，工具直接装不上）。
      input_schema: declarableSchema(this.parameters),
      owner: 'tool-rm',
    });
    // 清理是**独立的、需显式调用**的能力：不挂在 tool.rm 上，模型删文件时不会顺带触发。
    core.registerCapability('trash.prune', {
      description: 'Permanently delete trash entries older than the retention policy (irreversible; explicit call only)',
      handler: (args) => this.prune(args),
      input_schema: declarableSchema({
        type: 'object',
        properties: {
          maxAgeDays: { type: 'number', description: 'Override the retention age in days (must be >= 0)' },
          dryRun: { type: 'boolean', description: 'Report what would be deleted without deleting' },
        },
        required: [],
      }),
      owner: 'tool-rm',
    });
    // 启动对账（R23-B）：账上有 INTENT、现在磁盘上还有没有。
    // 只告警、只读 —— 对账不是自动清理，发现遗留不得自己动手删。
    const { unresolved } = await this.reconcileIntents();
    if (unresolved.length) {
      core.log('warn', `[tool-rm] ${unresolved.length} prune intent(s) never got a committed record: `
        + unresolved.map((u) => `${basename(u.path)} (${u.present ? 'still present' : 'gone'})`).join(', ')
        + ' — see trash-prune.log; nothing was deleted automatically');
    }
  }

  /**
   * 回收站当前规模。用于**告警**而不是**清理**：
   * 「不自动删」不能变成「悄悄把盘写满」，但把盘写满的解法也不能是未经授权删用户数据。
   * 所以越过水位线时，回执里带一条具名告警，把决定权交回上层。
   */
  /**
   * 清理账本的对账面：把 `trash-prune.log` 里的 INTENT 与 COMMITTED/FAILED 逐条相减。
   *
   * 日志记的是**意图**，真相在磁盘上 —— 所以每条未结算的意图都再 `stat` 一次，
   * 回答"账上说要删、它现在还在不在"。只读，不改任何文件。
   */
  async reconcileIntents() {
    let raw;
    try { raw = await readFile(this._pruneLog, 'utf8'); } catch { return { unresolved: [], log: this._pruneLog }; }
    const intents = new Map();   // runId -> paths[]
    const settled = new Map();   // runId -> Set<path>
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row?.action !== 'prune' || !row.runId) continue;
      if (row.phase === 'intent') {
        intents.set(row.runId, (intents.get(row.runId) || []).concat(row.targets || []));
      } else if (row.path) {
        if (!settled.has(row.runId)) settled.set(row.runId, new Set());
        settled.get(row.runId).add(row.path);
      }
    }
    const unresolved = [];
    for (const [runId, paths] of intents) {
      const done = settled.get(runId) || new Set();
      for (const p of paths) if (!done.has(p)) unresolved.push({ runId, path: p, present: existsSync(p) });
    }
    return { unresolved, log: this._pruneLog };
  }

  async _trashUsage() {
    let names;
    try { names = await readdir(this._trashDir); } catch { names = []; }
    const policy = this.retention();
    const over = names.length > policy.maxEntries;
    return {
      entries: names.length,
      maxEntries: policy.maxEntries,
      ...(over ? {
        warning: `trash holds ${names.length} entries (watermark ${policy.maxEntries}) and auto-prune is `
          + `${policy.autoPrune ? 'on' : 'OFF'} — nothing was deleted. Run \`trash.prune\` (dryRun first) to release space.`,
      } : {}),
    };
  }

  /** 当前生效的保留策略：配置面 > 环境变量 > 默认（默认 = 不自动清理）。 */
  retention() {
    const cfg = this.core.getService?.('config');
    const auto = cfg?.get('trash.retention.autoPrune');
    const age = cfg?.get('trash.retention.maxAgeDays');
    const max = cfg?.get('trash.retention.maxEntries');
    const envAuto = readEnv('TRASH_AUTO_PRUNE');
    return {
      autoPrune: auto === true || (auto == null && String(envAuto || '').toLowerCase() === 'true'),
      maxAgeDays: Number.isFinite(Number(age)) ? Number(age) : DEFAULT_RETENTION.maxAgeDays,
      maxEntries: Number.isFinite(Number(max)) ? Number(max) : DEFAULT_RETENTION.maxEntries,
      /** 回执里给读者的一句话，避免"可恢复"被读成"永远可恢复"。 */
      statement: 'Trash entries are kept until an explicit `trash.prune`. '
        + 'Auto-prune is OFF unless trash.retention.autoPrune=true is configured.',
    };
  }

  async _uniqueTrashName(fullPath) {
    const ts = Date.now();
    const crypto = await import('node:crypto');
    const rnd = crypto.randomBytes(6).toString('hex');
    return `${basename(fullPath)}_${ts}_${rnd}`;
  }

  /** 逐条写审计记录（JSONL）；写不进去就**抛**——不可逆操作没有账等于没做。 */
  async _audit(rows) {
    if (!rows.length) return;
    const { appendFile } = await import('node:fs/promises');
    const lines = rows.map((r) => JSON.stringify({ at: new Date().toISOString(), ...r })).join('\n') + '\n';
    await appendFile(this._pruneLog, lines, { mode: 0o600 });
  }

  /**
   * 显式清理。**不存在**"顺手清一下"的调用路径。
   *
   * 顺序是判据，不是风格：**先记账，后删除**。rc.23 是先 `rm` 完再单次 `_audit` ——
   * 审计盘写不进去（EISDIR / 只读挂载）时文件已经没了，账本上却什么也没有：
   * "不可逆操作没有账等于没做"在最需要它的那一刻不成立（R23-B）。
   *
   * 现在三段：① INTENT 一次落盘，列出本次准备删的全部路径，**写不进去就一条都不删**；
   * ② 逐项删除并逐项落 COMMITTED/FAILED（不攒到最后，否则中途崩溃就分不清删没删）；
   * ③ ②写失败就停手，把"已删但没记上"的条目如实报出 —— 它在 INTENT 里已有名字，
   * 所以不是无记录删除，但必须能被 `reconcileIntents` 对出来。
   * @returns {{deleted:string[], kept:number, dryRun:boolean, policy:object}}
   */
  async prune(args = {}) {
    const policy = this.retention();
    const maxAgeDays = Number.isFinite(Number(args.maxAgeDays)) ? Number(args.maxAgeDays) : policy.maxAgeDays;
    if (maxAgeDays < 0) throw Object.assign(new Error('Error: maxAgeDays must be >= 0'), { code: 'invalid_input', contractError: true });
    let names;
    try { names = await readdir(this._trashDir); } catch { names = []; }
    const cutoff = Date.now() - maxAgeDays * 86400_000;
    const withTime = await Promise.all(names.map(async (name) => {
      const abs = join(this._trashDir, name);
      try { const st = await lstat(abs); return { abs, name, mtime: st.mtimeMs }; } catch { return null; }
    }));
    const expired = withTime.filter(Boolean).filter((e) => e.mtime < cutoff).sort((a, b) => a.mtime - b.mtime);
    if (args.dryRun === true) {
      return { deleted: expired.map((e) => e.abs), kept: names.length - expired.length, dryRun: true, policy: { ...policy, maxAgeDays } };
    }
    const runId = `${Date.now()}-${process.pid}`;
    // ① 审计通道必须**先证明可用**：INTENT 写不进去，一条都不删。
    if (expired.length) {
      await this._audit([{ action: 'prune', phase: 'intent', runId, maxAgeDays,
        targets: expired.map((e) => e.abs), authorized: 'trash.prune' }]);
    }
    const deleted = [];
    const failed = [];
    const unrecorded = [];
    for (const e of expired) {
      let removed = true;
      let why = null;
      try {
        await rm(e.abs, { recursive: true, force: false });   // force:false —— 删不掉要如实失败
      } catch (err) {
        removed = false;
        why = err.code || String(err.message);
        failed.push({ path: e.abs, error: why });
      }
      if (removed) deleted.push(e.abs);
      try {
        await this._audit([removed
          ? { action: 'prune', phase: 'committed', runId, path: e.abs }
          : { action: 'prune', phase: 'failed', runId, path: e.abs, error: why }]);
      } catch (auditErr) {
        // 删除之后审计才坏：这一条只剩 INTENT 里那个名字。停手，不再制造更多。
        if (removed) unrecorded.push(e.abs);
        throw Object.assign(new Error(
          `Error: the prune audit log became unwritable (${auditErr.code || auditErr.message}) after `
          + `${deleted.length} entr${deleted.length === 1 ? 'y' : 'ies'} had been removed. `
          + `${unrecorded.length} removal(s) have no committed record: ${unrecorded.join(', ') || '(none)'} — `
          + 'they are named in the durable INTENT record; run `trash.prune` reconciliation to compare log vs disk.'),
        { code: 'prune_audit_failed', contractError: true, deleted, failed, unrecorded,
          intents: expired.map((e) => e.abs), log: this._pruneLog });
      }
    }
    if (failed.length) {
      throw Object.assign(new Error(
        `Error: prune removed ${deleted.length} entr${deleted.length === 1 ? 'y' : 'ies'} but ${failed.length} could not be removed: `
        + failed.map((f) => `${basename(f.path)} (${f.error})`).join(', ')),
      { code: 'prune_partial', contractError: true, deleted, failed });
    }
    return { deleted, kept: names.length - deleted.length, dryRun: false, runId, policy: { ...policy, maxAgeDays } };
  }

  /**
   * 跨设备移动：**按源条目类型收尾**。
   *
   * rc.22 的形态是 `cp(recursive:true)` 之后固定 `unlink(fullPath)` —— 源是目录时 unlink 抛 EISDIR，
   * 于是原件与回收站副本**同时存在**，而工具报 resource_error。重试一次就多一份副本。
   * 现在：目录用 rm(recursive) 收尾；收尾失败就把刚写出的副本撤掉并如实报错，
   * 让"原件在、副本不在"成为失败时的**确定**状态（而不是两种都留）。
   */
  async _moveAcrossDevices(fullPath, trashPath, opts = {}) {
    const removeOriginal = opts.removeOriginal || (async (st) => {
      if (st.isDirectory()) await rm(fullPath, { recursive: true, force: false });
      else await unlink(fullPath);
    });
    const st = await lstat(fullPath);
    // 复制先到**私有暂存名**：复制半途失败时，正式回收站条目**根本不存在**。
    // 直接在正式名上 cp 时，FIFO / 读错误 / ENOSPC 都停在 `try { rm(original) }` 之前，
    // 撤回逻辑没机会执行 —— 源目录还在，回收站里却已有一份半截副本（R23-C）。
    const staging = `${trashPath}.partial`;
    try {
      await cp(fullPath, staging, { recursive: true, errorOnExist: true, force: false });
      await rename(staging, trashPath);
    } catch (err) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      await rm(trashPath, { recursive: true, force: true }).catch(() => {});   // rename 之后才失败的情形
      throw Object.assign(new Error(
        `Error: could not copy to trash (${err.code || err.message}): "${fullPath}". `
        + 'Nothing was removed: the original is untouched and no trash entry was created.'),
      { code: 'resource_error', contractError: true, rolled_back: true, trash_entry_created: false });
    }
    try {
      await removeOriginal(st);
    } catch (err) {
      // **不撤副本**：`rm` 可能已经删掉一部分再报错，此刻回收站里那份才是唯一完整的。
      // 撤掉它就是真丢数据 —— 数据存活率优先于"失败回执整洁"。两份都点名，让人对账。
      const stillThere = existsSync(fullPath);
      throw Object.assign(new Error(
        `Error: copied to trash but could not remove the original (${err.code || err.message}): "${fullPath}". `
        + `The complete copy was KEPT at "${trashPath}" because removing the original may have destroyed part of it`
        + `${stillThere ? ' (the original path still exists — check both before deleting either)' : ' (the original path is gone)'}.`),
      { code: 'resource_error', contractError: true, rolled_back: false, partial_removal: true,
        trash_copy: trashPath, original_exists: stillThere });
    }
  }

  async execute(args) {
    const workDir = this.core.getService?.('workspace')?.root(args?._sessionId) || this.core.getData('agent.workDir') || process.cwd(); // R0-124：会话根目录 > 进程默认
    try {
      const { path } = args;
      if (!path) throw Object.assign(new Error('Error: path is required'), { code: 'invalid_input', contractError: true });

      // R0-113（P0-02）：边界判定统一走 resolver（移入回收站同样不许越界）
      const fullPath = await resolveWorkspacePath(workDir, path);

      for (let attempt = 0; ; attempt++) {
        const trashPath = join(this._trashDir, await this._uniqueTrashName(fullPath));
        try {
          await rename(fullPath, trashPath);
          return { ok: true, trashed: trashPath, retention: this.retention(), trash: await this._trashUsage() };
        } catch (err) {
          if (err.code === 'EXDEV') {
            if (existsSync(trashPath)) continue;
            await this._moveAcrossDevices(fullPath, trashPath);
            return { ok: true, trashed: trashPath, retention: this.retention(), trash: await this._trashUsage(), cross_device: true };
          }
          if (err.code === 'EEXIST' && attempt < 32) continue;
          throw err;
        }
      }
    } catch (err) {
      if (err?.contractError) throw err;   // 本契约的具名失败原样上抛；系统错误码（ENOENT 等）不在此列
      throw Object.assign(new Error(`Error: ${err.message}`), { code: 'resource_error', contractError: true });
    }
  }
}

export default new ToolRm();
