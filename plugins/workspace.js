// R0-124：会话级工作目录 —— 一个内核、多个会话，各自在不同目录里干活。
// R0-125（G0-1）：**绑定是真值，不是缓存**。修前这一层的三处 P0（已实测复现）：
//
//   ① 容量淘汰静默换目录 —— 声明的第 257 个会话把最久未用的那个**挤掉**，被挤掉的会话
//      随后 `root()` 未命中 ⇒ 回落 `agent.workDir`。实测：s-first 绑 B，灌进 300 个会话后
//      `root('s-first')` 变成 A（默认根），**没有任何日志、没有任何错误**。
//   ② 重启即失忆 —— 绑定只在进程内 `Map` 里。重启后同一会话的**历史还在**（jsonl 在磁盘上），
//      工作目录却悄悄回到默认根：模型接着聊上次的事，文件写到另一个项目里。
//   ③ 目录消失后照样回默认 —— 没有"绑定存在但不可用"这个状态，于是"失效"和"从未绑定"
//      长得一模一样，两者都走默认根。
//
// 现在（不变式）：**一条绑定一旦形成，只有在显式 release 或经批准迁移时才改变。**
//   · 真值落盘：`<stateDir>/workspace-bindings.json`（0600、临时文件 + rename 原子写）；
//   · 容量满了**具名拒绝新绑定**（`workspace_capacity_exhausted`），绝不挤掉老绑定；
//   · 重启时逐条重新校验（存在性 / 目录 / realpath 未变 / 策略），失败的记为
//     `unavailable` 并**拒绝**该会话的相对路径操作（`workspace_binding_unavailable`），
//     不回退默认根 —— "不知道它该在哪" 的正确反应是停下，不是猜一个；
//   · 元数据损坏同样 fail-closed：整个会话面拒绝（而不是把"曾经绑过"读成"从未绑过"）；
//   · `release` 是显式操作；仍有任务在跑时拒绝（`workspace_busy`），force 才放行。
//
// 边界（诚实优先）：
//   · 这是"相对路径的基准"，**不是沙箱**。`tool-bash` 仍可 `cd` 到任何地方，绝对路径不受限；
//   · 声明只接受**已存在**的目录（不替调用方 mkdir —— 打错一个字就静默造一棵空树更糟）；
//   · 它挡的是**误落盘**与**越权委派**（远端客户端不能凭一个请求把模型指向任意目录），
//     不是本机同用户攻击：本进程与调用方同用户，能声明的目录本来就是调用方能读的。
//
// 形态：本文件导出的是一个**插件**，而注册给 `core` 的是一层**绑定该 core 的门面**。
// 为什么不直接 `registerService('workspace', this)`：插件是模块级单例（`export default new X()`），
// `init(core)` 会把 `this.core` 重绑到最后一次 init 的 core 上。单核进程里看不出问题，但只要
// 同一进程里有两个 core（单测一次 import 全部用例文件、宿主内嵌内核），先 init 的那个 core
// 拿到的服务就会读到**另一个 core** 的配置——实测表现是"工具明明拿到了正确的工作目录，却按
// 别人的默认目录落盘"。门面把 `core` 与状态闭包进去，`this` 之后被重绑也不影响已注册的那一份。
import { resolve, relative, isAbsolute, sep, join } from 'node:path';
import { realpath, stat, readFile, writeFile, mkdir, chmod, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { assertSessionId } from './tools/lib/session-id.mjs';
import { sensitivePathOf } from './_lib/sensitive-paths.js';

/** 绑定表硬上限：**满了就拒绝新绑定**，不淘汰老的（淘汰 = 静默换目录，见文件头 ①）。 */
const MAX_SESSIONS = 256;

/** 落盘文件名（在 stateDir 下；与 config.json 同级，权限同为 0600）。 */
const STORE_FILE = 'workspace-bindings.json';
const STORE_VERSION = 'tusunsun.workspace-bindings/v0';

/** core → 该 core 的工作目录状态。WeakMap：core 被回收时状态一起走，且互不串。 */
const _states = new WeakMap();

/** 具名契约错误：调用方据此回 4xx，而不是"一段看起来像回答的错误文案"。 */
function contractError(message, code) {
  return Object.assign(new Error(message), { code, contractError: true });
}

/** `root` 与 `target` 的真实包含关系（不是字符串前缀 —— 见 R0-113/P0-02）。 */
function isInside(root, target) {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** 进程默认根：数据面 > 配置面 > cwd（与文件工具、执行器同一口径，见 R0-105/T2）。 */
function defaultRootOf(core) {
  return core?.getData?.('agent.workDir')
    || core?.get?.('agent.workDir')
    || process.cwd();
}

class WorkspacePlugin {
  name = 'workspace';
  version = '0.3.0';
  permissions = ['fs.read', 'fs.write'];
  provides = [{ name: 'workspace', type: 'service' }];
  description = '会话级工作目录（相对路径的基准），绑定落盘可恢复，带目录校验与来源策略';

  async init(core) {
    const st = {
      bound: new Map(),        // sessionId → { sessionId, dir, real, via, trusted, at, state, reason? }
      policy: 'local',
      roots: [],               // 允许被声明的根（真实路径）
      stateDir: core.stateDir ? resolve(core.stateDir) : '',
      storePath: core.stateDir ? join(resolve(core.stateDir), STORE_FILE) : '',
      home: '',
      retained: new Map(),     // sessionId → 在跑的任务数（release 保护）
      corrupt: null,           // 元数据损坏时记原因：此后任何会话操作一律拒绝
      writeChain: Promise.resolve(),
      writeSeq: 0,
      recovered: { ok: 0, unavailable: 0 },
    };
    try { st.home = await realpath(homedir()); } catch { st.home = resolve(homedir()); }

    const cfg = core.get?.('workspaces') || {};
    // 策略：
    //   local  —— 本机（回环）调用方可以声明任意已存在目录；远端调用方必须落在 roots 里（默认）
    //   rooted —— 所有人（含本机）都必须落在 roots 里
    //   off    —— 不提供会话级目录，一律沿用 agent.workDir
    st.policy = ['local', 'rooted', 'off'].includes(cfg.policy) ? cfg.policy : 'local';
    st.roots = await this._canonicalRoots(core, cfg.roots);
    _states.set(core, st);

    // 注册的是**绑定该 core** 的门面，不是插件对象本身（见文件头"形态"）
    core.registerService('workspace', {
      root: (sessionId) => this._root(core, st, sessionId),
      defaultRoot: () => defaultRootOf(core),
      has: (sessionId) => st.bound.has(String(sessionId)),
      status: (sessionId) => this._status(st, sessionId),
      assertUsable: (sessionId) => this._assertUsable(st, sessionId),
      declare: (sessionId, dir, opts) => this.declare(core, sessionId, dir, opts),
      release: (sessionId, opts) => this.release(core, sessionId, opts),
      retain: (sessionId) => this.retain(st, sessionId),
      reload: () => this.reload(core, st),
      list: () => this._list(core, st),
    });

    // 恢复发生在**服务可用之前**：任何读者拿到的第一手 `root()` 就已经是恢复后的真值。
    // （若放到首次请求时懒恢复，一次早到的工具调用会先看到"未绑定"并落到默认根。）
    await this.reload(core, st);

    // 发现入口：功能存在但没人知道 = 没有。这条日志必须在**装配期**打，而不是等第一个请求
    // —— 实测网关的 listen 回调早于本插件的 init，写在那边会静默消失。
    const how = st.policy === 'off'
      ? '会话级目录已关闭（workspaces.policy=off）'
      : `会话可声明自己的目录（policy=${st.policy}）：请求体 workspace / 请求头 X-Tusunsun-Workspace / \`tusunsun chat --dir <路径>\``;
    core.log('info', `[workspace] 默认根 ${defaultRootOf(core)}；${how}；已声明的见 GET /api/sessions`);
    if (st.policy !== 'local') {
      core.log('info', `[workspace] 允许的根：${st.roots.join(', ') || '(空 ⇒ 仅默认目录)'}`);
    }
    if (st.recovered.ok || st.recovered.unavailable) {
      core.log('info', `[workspace] 从 ${st.storePath} 恢复绑定：可用 ${st.recovered.ok}、不可用 ${st.recovered.unavailable}`
        + (st.recovered.unavailable ? '（不可用的会话会被拒绝，不回退默认根）' : ''));
    }
  }

  /** roots 配置项 → 真实路径；配错的条目**跳过并报错**（安全白名单宁可少不会多）。 */
  async _canonicalRoots(core, raw) {
    const list = Array.isArray(raw) ? raw : (typeof raw === 'string' && raw ? [raw] : []);
    const out = [];
    for (const item of list) {
      if (typeof item !== 'string' || !item.trim()) continue;
      const p = item.trim();
      if (!isAbsolute(p)) {
        core?.log?.('error', `[workspace] workspaces.roots 里的 "${p}" 不是绝对路径，已忽略`);
        continue;
      }
      try {
        const s = await stat(p);
        if (!s.isDirectory()) throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
        out.push(await realpath(p));
      } catch (err) {
        core?.log?.('error', `[workspace] workspaces.roots 里的 "${p}" 不可用（${err.code || err.message}），已忽略`);
      }
    }
    return out;
  }

  // ── 恢复 ────────────────────────────────────────────────────────────
  /**
   * 从磁盘重读绑定并**逐条重新校验**。启动时调一次；也可在运行期显式调用（换挂载点后）。
   * 校验项：目录仍存在且是目录 / realpath 与声明时一致 / 来源策略仍允许。
   * 任一不满足 ⇒ 该会话记为 `unavailable`（保留记录，不回退默认根）。
   */
  async reload(core, st) {
    st.bound.clear();
    st.recovered = { ok: 0, unavailable: 0 };
    st.corrupt = null;
    if (!st.storePath) return;
    let raw;
    try {
      raw = await readFile(st.storePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return;   // 首次运行：没有绑定，也就没有"曾绑定"可言
      st.corrupt = `读取失败：${err.code || err.message}`;
      core.log('error', `[workspace] 绑定表不可读（${st.corrupt}）⇒ 会话级目录一律拒绝（不回退默认根）`);
      return;
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch (err) {
      st.corrupt = `不是合法 JSON：${err.message}`;
      core.log('error', `[workspace] 绑定表损坏（${st.corrupt}）⇒ 会话级目录一律拒绝。修好或删除 ${st.storePath} 再启动。`);
      return;
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.sessions)) {
      st.corrupt = '结构不符（缺少 sessions 数组）';
      core.log('error', `[workspace] 绑定表损坏（${st.corrupt}）⇒ 会话级目录一律拒绝。修好或删除 ${st.storePath} 再启动。`);
      return;
    }
    for (const rec of parsed.sessions) {
      if (!rec || typeof rec.sessionId !== 'string' || typeof rec.real !== 'string') {
        core.log('warn', '[workspace] 绑定表里有一条结构不合法的记录，已跳过（该会话按从未绑定处理）');
        continue;
      }
      let sid;
      try { sid = assertSessionId(rec.sessionId); } catch { core.log('warn', `[workspace] 绑定表里的会话标识不合法（${String(rec.sessionId).slice(0, 40)}），已跳过`); continue; }
      const verified = await this._verify(st, rec);
      if (verified.ok) { st.bound.set(sid, verified.rec); st.recovered.ok++; }
      else { st.bound.set(sid, verified.rec); st.recovered.unavailable++; core.log('error', `[workspace] 会话 "${sid}" 的绑定不可用：${verified.reason}（该会话的相对路径操作将被拒绝，不回退默认根）`); }
    }
  }

  /** 复核一条绑定是否仍然成立。返回 `{ok, rec, reason?}`；`rec.state` 标 bound/unavailable。 */
  async _verify(st, rec) {
    const base = {
      sessionId: rec.sessionId, dir: rec.dir, real: rec.real,
      via: rec.via, trusted: !!rec.trusted, at: rec.at,
    };
    let s;
    try {
      s = await stat(rec.real);
    } catch (err) {
      const reason = `目录已不存在或不可访问（${err.code || err.message}）`;
      return { ok: false, reason, rec: { ...base, state: 'unavailable', unavailable: reason, reason: 'workspace_binding_unavailable' } };
    }
    if (!s.isDirectory()) {
      const reason = '该路径已不是目录';
      return { ok: false, reason, rec: { ...base, state: 'unavailable', unavailable: reason, reason: 'workspace_binding_unavailable' } };
    }
    let real;
    try { real = await realpath(rec.real); } catch (err) {
      const reason = `realpath 失败（${err.code || err.message}）`;
      return { ok: false, reason, rec: { ...base, state: 'unavailable', unavailable: reason, reason: 'workspace_binding_unavailable' } };
    }
    // 换过符号链接/重新挂载：真实落点变了 ⇒ 不再指向"当初那个项目"，按不可用处理
    if (real !== rec.real) {
      const reason = `真实路径已改变（${rec.real} → ${real}）`;
      return { ok: false, reason, rec: { ...base, state: 'unavailable', unavailable: reason, reason: 'workspace_binding_unavailable' } };
    }
    try {
      this._assertAllowed(st, real, rec.dir || real, !!rec.trusted);
    } catch (err) {
      const reason = `按当前策略不再允许（${err.code || 'denied'}：${err.message}）`;
      return { ok: false, reason, rec: { ...base, state: 'unavailable', unavailable: reason, reason: 'workspace_binding_unavailable' } };
    }
    return { ok: true, rec: { ...base, real, state: 'bound' } };
  }

  // ── 读 ──────────────────────────────────────────────────────────────
  /**
   * 该会话的相对路径基准。**同步**、热路径可用：声明/恢复时已算好真实路径，这里只做一次查找。
   *
   * 三种结果（刻意不用同一个值表示三种含义）：
   *   · 有记录且可用   → 该记录的真实路径；
   *   · 没有记录       → 进程默认根（老部署行为不变：从未绑定 ≠ 绑定丢了）；
   *   · 有记录但不可用 → **抛** `workspace_binding_unavailable`（不回退默认根）。
   */
  _root(core, st, sessionId) {
    if (sessionId === undefined || sessionId === null || sessionId === '') return defaultRootOf(core);
    const sid = String(sessionId);
    const rec = st.bound.get(sid);
    if (!rec) {
      if (st.corrupt) {
        throw contractError(
          `Session "${sid}" has no usable workspace binding: the binding store is corrupted (${st.corrupt}). `
          + `Refusing to fall back to the process default (${defaultRootOf(core)}). Fix or remove ${st.storePath}, then restart.`,
          'workspace_binding_unavailable');
      }
      return defaultRootOf(core);
    }
    if (rec.state !== 'bound') {
      throw contractError(
        `Session "${sid}" is bound to ${rec.real}, but that binding is no longer usable (${rec.unavailable || 'see log'}). `
        + 'Refusing to silently fall back to the process default. Restore the directory, or release the binding with an explicit action.',
        'workspace_binding_unavailable');
    }
    return rec.real;
  }

  /** `unbound` / `bound` / `unavailable` / `corrupt` —— 观测面用，不抛。 */
  _status(st, sessionId) {
    if (st.corrupt) return 'corrupt';
    if (sessionId === undefined || sessionId === null || sessionId === '') return 'unbound';
    const rec = st.bound.get(String(sessionId));
    if (!rec) return 'unbound';
    return rec.state === 'bound' ? 'bound' : 'unavailable';
  }

  /** 边界用：执行前确认这个会话的工作区可用；不可用即具名拒绝（在产生任何副作用之前）。 */
  _assertUsable(st, sessionId) {
    const state = this._status(st, sessionId);
    if (state === 'bound' || state === 'unbound') return { ok: true, state };
    if (state === 'corrupt') {
      throw contractError(`workspace binding store is corrupted; refusing session "${sessionId}" (see log)`, 'workspace_binding_unavailable');
    }
    const rec = st.bound.get(String(sessionId));
    throw contractError(
      `Session "${sessionId}" is bound to ${rec?.real}, but that binding is no longer usable. `
      + 'Refusing to fall back to the process default.',
      'workspace_binding_unavailable');
  }

  // ── 写 ──────────────────────────────────────────────────────────────
  /**
   * 声明/复核某个会话的工作目录。
   * @param {object} core 目标内核
   * @param {string} sessionId 会话标识（复用 R0-114 的校验：非法标识不得成为注册表键）
   * @param {string} dir 绝对路径
   * @param {{via?:string, trusted?:boolean, force?:boolean}} opts
   *        `trusted` = 调用方来自本机回环（由网关按 socket 地址判定，不采信请求头自报）。
   *        缺省 `false`（fail-closed）：漏传的后果是"远端被拒 400"，不是"任意目录放行"。
   * @returns {Promise<object>} 绑定记录
   */
  async declare(core, sessionId, dir, opts = {}) {
    const st = _states.get(core);
    if (!st) throw contractError('workspace service is not initialized for this core', 'workspace_unsupported');
    const { via = 'api', trusted = false, force = false } = opts;
    const sid = assertSessionId(sessionId);
    if (st.corrupt) {
      throw contractError(`binding store is corrupted (${st.corrupt}); refusing to declare a workspace until it is fixed`, 'workspace_binding_unavailable');
    }
    if (st.policy === 'off') {
      throw contractError('Per-session workspace is disabled (workspaces.policy=off); the process-wide agent.workDir is used instead.', 'workspace_disabled');
    }
    const raw = typeof dir === 'string' ? dir.trim() : '';
    if (!raw) throw contractError('workspace must be a non-empty path', 'invalid_workspace');
    if (!isAbsolute(raw)) {
      throw contractError(`workspace must be an ABSOLUTE path (got "${raw}"). Relative paths are ambiguous: they would resolve against the server process, not your shell.`, 'invalid_workspace');
    }
    const real = await this._canonicalize(raw);
    this._assertAllowed(st, real, raw, trusted);

    const prev = st.bound.get(sid);
    if (prev && prev.real !== real && !force) {
      throw contractError(
        `Session "${sid}" is already bound to ${prev.real}; refusing to move it to ${real}. `
        + 'Use a NEW session_id for another directory (a session\'s history belongs to the directory it was produced in).',
        'workspace_conflict');
    }

    // 幂等：同一个目录重复声明（CLI 每轮都带 `--dir`、客户端每轮都带请求头）是常态，
    // 不该每轮都写一条日志、发一个事件 —— 否则"日志里全是 workspace 绑定"会淹没真正的新绑定。
    if (prev && prev.real === real && prev.state === 'bound') {
      prev.at = Date.now();
      st.bound.delete(sid); st.bound.set(sid, prev);   // 触达一次（保持插入序最新）
      return prev;
    }

    // 容量：**拒绝新绑定**，不淘汰老的。淘汰 = 让一个已经绑定的会话静默换目录（P0 ①）。
    if (!prev && st.bound.size >= MAX_SESSIONS) {
      throw contractError(
        `workspace binding table is full (${st.bound.size}/${MAX_SESSIONS}). `
        + 'Refusing to evict an existing binding: that would silently move another session to a different directory. '
        + 'Release stale bindings explicitly (tusunsun workspace release <session_id>) or raise the limit in a future release.',
        'workspace_capacity_exhausted');
    }

    const rec = { sessionId: sid, dir: raw, real, via: String(via || 'api'), trusted: !!trusted, at: Date.now(), state: 'bound' };
    // 内存与盘必须一起前进或一起后退：
    //   · 只写内存不写盘 ⇒ "本次运行看起来绑上了，重启后消失"（P0 ②）；
    //   · 只写盘不写内存 ⇒ 磁盘说绑了、进程还按默认根干活。
    // 因此：先改内存（同步，保证并发 declare 不会互相覆盖快照），再在串行链里落盘；
    // 落盘失败则回滚内存并把具名失败抛给调用方。
    const prevRec = st.bound.get(sid);
    st.bound.delete(sid);
    st.bound.set(sid, rec);
    try {
      await this._persist(st);
    } catch (err) {
      st.bound.delete(sid);
      if (prevRec) st.bound.set(sid, prevRec);
      throw err;
    }
    core?.emit?.('workspace.bound', { ...rec, timestamp: new Date().toISOString(), sourcePlugin: 'workspace' });
    core?.log?.('info', `[workspace] session "${sid}" → ${real} (via ${rec.via}${trusted ? ', local' : ', remote'})`);
    return rec;
  }

  /**
   * 显式解绑。仍在跑的会话拒绝（`workspace_busy`）——正是 P0 的另一面：
   * 任务执行到一半把它的绑定摘掉，后面的工具调用就会落到默认根。
   * @param {{force?:boolean, via?:string}} [opts]
   */
  async release(core, sessionId, opts = {}) {
    const st = _states.get(core);
    if (!st) throw contractError('workspace service is not initialized for this core', 'workspace_unsupported');
    const sid = assertSessionId(sessionId);
    const inFlight = st.retained.get(sid) || 0;
    if (inFlight > 0 && !opts.force) {
      throw contractError(
        `Session "${sid}" has ${inFlight} task(s) in flight; refusing to release its workspace binding `
        + '(the running task would fall back to the process default mid-flight). Wait for it to finish, or pass force.',
        'workspace_busy');
    }
    if (!st.bound.has(sid)) return { released: false, sessionId: sid };
    const prevRec = st.bound.get(sid);
    st.bound.delete(sid);
    try {
      await this._persist(st);
    } catch (err) {
      st.bound.set(sid, prevRec);
      throw err;
    }
    core?.emit?.('workspace.released', { sessionId: sid, via: opts.via || 'api', timestamp: new Date().toISOString(), sourcePlugin: 'workspace' });
    core?.log?.('info', `[workspace] session "${sid}" released (via ${opts.via || 'api'})`);
    return { released: true, sessionId: sid };
  }

  /** 标记"这个会话正在干活"；返回的幂等函数负责减计数。用于阻止 release 把在跑的任务掀翻。 */
  retain(st, sessionId) {
    const sid = String(sessionId ?? '');
    if (!sid) return () => {};
    st.retained.set(sid, (st.retained.get(sid) || 0) + 1);
    let done = false;
    return () => {
      if (done) return;   // 幂等：调用方在 finally 里多调一次不该把计数减成负数
      done = true;
      const n = (st.retained.get(sid) || 1) - 1;
      if (n <= 0) st.retained.delete(sid); else st.retained.set(sid, n);
    };
  }

  /** 原子落盘：临时文件 + rename（同 config.json 的口径，含 0600）。失败即抛，不吞。 */
  async _persist(st) {
    if (!st.storePath) {
      throw contractError('no state directory configured; refusing to keep a workspace binding that cannot survive a restart', 'workspace_persist_failed');
    }
    // 快照在**入队时**取：调用方已把内存改好，所以这里拿到的是"要落盘的那一份"。
    const payload = {
      schema_version: STORE_VERSION,
      updated_at: new Date().toISOString(),
      sessions: [...st.bound.values()].map(({ sessionId, dir, real, via, trusted, at }) => ({ sessionId, dir, real, via, trusted, at })),
    };
    const body = JSON.stringify(payload, null, 2);
    const write = async () => {
      try {
        await mkdir(st.stateDir, { recursive: true, mode: 0o700 });
        try { await chmod(st.stateDir, 0o700); } catch { /* 非 POSIX：尽力而为 */ }
        const tmp = `${st.storePath}.tmp-${process.pid}-${++st.writeSeq}`;
        await writeFile(tmp, body, { mode: 0o600 });
        try { await chmod(tmp, 0o600); } catch { /* 同上 */ }
        await rename(tmp, st.storePath);
      } catch (err) {
        throw contractError(`cannot persist workspace bindings to ${st.storePath} (${err.code || err.message})`, 'workspace_persist_failed');
      }
    };
    // 串行化：两个并发 declare 各自在内存里落位后，两次写按提交顺序执行，后一次写包含前一次的结果。
    const p = st.writeChain.then(write, write);
    st.writeChain = p.catch(() => {});
    await p;
  }

  /** 目录必须**已存在**且是目录；返回真实路径（符号链接追一层，后续包含关系才判得准）。 */
  async _canonicalize(raw) {
    let s;
    try {
      s = await stat(raw);
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
        throw contractError(`workspace does not exist: ${raw}（不会替你创建目录：路径打错时静默造一棵空树比拒绝更糟）`, 'workspace_not_found');
      }
      throw contractError(`workspace is not accessible: ${raw} (${err.code || err.message})`, 'invalid_workspace');
    }
    if (!s.isDirectory()) throw contractError(`workspace is not a directory: ${raw}`, 'workspace_not_dir');
    try { return await realpath(raw); } catch { return resolve(raw); }
  }

  /** 拒收的根目录：没有"项目"含义，或一旦当根就把密钥/系统文件放进可达范围。 */
  _assertAllowed(st, real, raw, trusted) {
    if (real === resolve('/') || real === sep) {
      throw contractError(`workspace "${raw}" is the filesystem root; pick a project directory instead.`, 'workspace_denied');
    }
    if (st.stateDir && isInside(st.stateDir, real)) {
      throw contractError(`workspace "${raw}" is inside the state directory (${st.stateDir}); that tree holds sessions and credentials.`, 'workspace_denied');
    }
    if (st.home && real === st.home) {
      throw contractError(`workspace "${raw}" is the home directory itself. Pick a project subdirectory (e.g. ${st.home}/code/my-repo): the whole home contains ~/.ssh and ~/.tusunsun.`, 'workspace_denied');
    }
    // 敏感目录不是审美问题：把 ~/.ssh 或 /etc 当根，之后所有相对路径读写都会落在
    // 密钥/系统配置里。判据与文件护栏、bash 读围栏共用 `sensitive-paths.js` 的一份名单。
    const sensitive = sensitivePathOf(real);
    if (sensitive) {
      throw contractError(`workspace "${raw}" resolves into sensitive path "${sensitive}" (credentials, keys, or system config); pick a project directory instead.`, 'workspace_denied');
    }
    // 来源策略：远端（非回环）调用方永远要有白名单；`rooted` 策略下本机也一样。
    const needsAllowlist = st.policy === 'rooted' || !trusted;
    if (!needsAllowlist) return;
    if (!st.roots.length) {
      throw contractError(
        `workspace "${raw}" is not allowed from a non-local client. `
        + 'Set workspaces.roots to the directories remote sessions may use, or declare it from the machine running the kernel.',
        'workspace_not_allowed');
    }
    if (!st.roots.some(r => isInside(r, real))) {
      throw contractError(`workspace "${raw}" is outside the allowed roots (${st.roots.join(', ')}).`, 'workspace_not_allowed');
    }
  }

  /** 观测面：默认根、策略、白名单、绑定（含不可用项与在跑任务数）与容量。 */
  _list(core, st) {
    return {
      default: defaultRootOf(core),
      policy: st.policy,
      roots: [...st.roots],
      capacity: { used: st.bound.size, max: MAX_SESSIONS, evicts: false },
      durable: Boolean(st.storePath),
      corrupt: st.corrupt || null,
      sessions: [...st.bound.values()].map(r => ({
        sessionId: r.sessionId, workspace: r.real, via: r.via, trusted: r.trusted, at: r.at,
        state: r.state, ...(r.state === 'bound' ? {} : { reason: r.reason || 'workspace_binding_unavailable' }),
        inFlight: st.retained.get(r.sessionId) || 0,
      })),
    };
  }
}

export default new WorkspacePlugin();
