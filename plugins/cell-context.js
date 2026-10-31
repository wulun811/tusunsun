// CTX-2（PR-1/PR-4）：Cell 认知配置的**可信绑定**与受限加载。
//
// 这个插件只做四件事，每件都对应一条"不能靠配置文件自己说了算"的判断：
//
//   ① profile 从**宿主声明的根**里读，且必须在根内、是普通文件、大小有上限、经 realpath 追过
//      符号链接。`local:prompts/x.md` 是一个逻辑引用，不是"读任意路径"的许可。
//   ② 绑定是 `cell_id → profile_id + version + sha256` 的**落盘记录**。sha256 记的是
//      **实际注入的系统提示词内容**，不是文件名 —— 只记名字的回执无法证明"跑的是哪一版"。
//   ③ 在飞 Task 拿的是**冻结快照**：accept 时取一次，之后换 profile 不影响它。
//      没有这条，"热更新"会在任务中途换掉工作身份，而任务完成后的结果无法对应到任何一份配置。
//   ④ 一切"读不到/校验失败"都走具名失败并可在回执里看见，**不静默回落**成默认提示词 ——
//      静默回落会让一次配置事故表现得像一次正常运行。
//
// 与 core 的关系：本插件不改内核、不加核心行数；它注册的是服务与被 haotian-lite 查询的
// 一个只读接缝（`profileForSession`）。没有它时，haotian-lite 走原来的 `agent.systemPrompt`
// 路径，行为与 v0.9.21 逐字节相同。
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, chmod, rename, stat, realpath, readdir, appendFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep, dirname } from 'node:path';
import {
  validateContextProfile, validateContextBinding, validateContextReceipt,
  validateCompactionRecord, CONTEXT_BINDING_SCHEMA, CONTEXT_RECEIPT_SCHEMA,
  COMPACTION_RECORD_SCHEMA, CONTEXT_PROFILE_SCHEMA,
} from './_lib/cell/context-contract.js';
import { contractError, checkOpaqueId } from './_lib/cell/contract.js';

/** profile 文件名上限：配置不是数据仓库，超过这个尺寸的多半放错了地方。 */
const PROFILE_MAX_BYTES = 256 * 1024;
/** 系统提示词上限。一个"工作身份"超过 64KB 已经不像身份，更像把文档塞进了系统提示。 */
const PROMPT_MAX_BYTES = 64 * 1024;
/** 回执保留上限（行）。超出后滚动截断，避免 receipts.jsonl 无限增长。 */
const RECEIPT_MAX_LINES = 5000;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** 目标（或其最近的已存在祖先）真实路径必须仍在 root 真实路径之内。 */
async function realInside(root, target) {
  const rootReal = await realpath(root).catch(() => null);
  if (!rootReal) return null;
  let probe = target;
  for (;;) {
    const real = await realpath(probe).catch(() => null);
    if (real) {
      const rel = relative(rootReal, real);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
      return { real, rootReal };
    }
    const up = dirname(probe);
    if (up === probe) return null;
    probe = up;
  }
}

class CellContext {
  name = 'cell-context';
  version = '0.1.0';
  provides = [{ name: 'cell-context', type: 'service' }];
  requires = { 'cell-runtime': '>=0.1.0' };
  description = 'Cell 级 ContextProfile 绑定、受限系统提示词加载、装配回执与 Cell 范围内摘要';

  constructor() {
    /** cellId → 落盘绑定（内存镜像，重启由 loadBinding 恢复）。 */
    this._bindings = new Map();
    /** sessionId → { frozen, cellId, taskId, epoch }：仅在本 Cell 的一次 execute 期间存在。 */
    this._scopes = new Map();
  }

  async init(core) {
    this.core = core;
    core.registerService('cell-context', {
      bind: (cellId, opts) => this.bind(core, cellId, opts),
      unbind: (cellId) => this.unbind(core, cellId),
      bindingOf: (cellId) => this.bindingOf(core, cellId),
      // 异步读盘版：网关 `cell.context.binding` 与 cell-runtime.create 的恢复路径都要它。
      // 修前**没有这个成员** —— 于是 `cc.loadBinding(...)` 在服务对象上是 undefined，
      // 网关那条端点恒回 `no_binding`（实测），而 create() 里的 `if (ctxSvc?.loadBinding)`
      // 恒假 ⇒ 重启后 `bindingSnapshot()` 拿到 null ⇒ accept 钉不住任何版本。
      // 两个调用点都以"属性可选"的方式写（`?.`），所以缺了它**不会报错，只会静默不恢复**，
      // 正是本项目反复出现的"接口存在但不生效"形状。
      loadBinding: (cellId) => this.loadBinding(core, cellId),
      // 同步快照：accept() 用它钉住版本（accept 不能是 async，见 bindingSnapshot 注释）
      bindingSnapshot: (cellId) => this.bindingSnapshot(cellId),
      loadProfile: (profileId) => this.loadProfile(core, profileId),
      // 执行期接缝：cell-runtime 在 accept/execute 时调用，haotian-lite 只读。
      // 注意：`pinned` 必须原样透传。适配层少写一个参数，上层就会"看起来调了、
      // 实际用的是当前绑定"——CTX-E05 第一次失败正是这个形状：快照钉对了，但没送到。
      freezeForTask: (cellId, taskId, incarnationId, pinned) => this.freezeForTask(core, cellId, taskId, incarnationId, pinned),
      enterExecution: (sessionId, frozen) => this.enterExecution(sessionId, frozen),
      exitExecution: (sessionId) => this.exitExecution(sessionId),
      profileForSession: (sessionId) => this._scopes.get(String(sessionId)) || null,
      // 装配回执 / 摘要（PR-2/PR-4 的落点）
      appendReceipt: (receipt) => this.appendReceipt(core, receipt),
      readReceipts: (cellId, limit) => this.readReceipts(core, cellId, limit),
      saveSummary: (cellId, sessionId, record) => this.saveSummary(core, cellId, sessionId, record),
      loadSummary: (cellId, sessionId) => this.loadSummary(core, cellId, sessionId),
      listSummaries: (cellId) => this.listSummaries(core, cellId),
      // 供工具层构造 ExecutionScope（**只从 sessionId 派生，不接受模型传入的 cell_id**）
      scopeForSession: (sessionId) => this.scopeForSession(sessionId),
    });
    core.log('info', '[cell-context] ContextProfile 绑定服务已就绪（默认不绑定 ⇒ 行为与旧版本一致）');
  }

  // ── 宿主策略 ─────────────────────────────────────────────────────────
  /**
   * 宿主策略读取。**所有默认值都是"关闭"**：没显式开启就没有 profile 根、没有资源根，
   * 于是 bind() 会具名拒绝而不是"用进程 cwd 猜一个"。
   */
  _policy(core) {
    const raw = core.get?.('cells.context') || core.getData?.('cells.context') || {};
    const p = (raw && typeof raw === 'object') ? raw : {};
    return {
      enabled: p.enabled === true,
      profileRoot: typeof p.profileRoot === 'string' && p.profileRoot ? p.profileRoot : null,
      resourceRoot: typeof p.resourceRoot === 'string' && p.resourceRoot ? p.resourceRoot : null,
      allowedProfiles: Array.isArray(p.allowedProfiles) ? p.allowedProfiles.filter((x) => typeof x === 'string' && x) : null,
    };
  }

  _roots(core) {
    const pol = this._policy(core);
    // 未声明根时**不回落**到 cwd：那个目录与这个 Cell 无关，而且会让"配置缺失"表现为
    // "读到了某个恰好存在的文件"。
    const profileRoot = pol.profileRoot ? resolve(pol.profileRoot) : null;
    const resourceRoot = pol.resourceRoot ? resolve(pol.resourceRoot) : null;
    return { pol, profileRoot, resourceRoot };
  }

  _cellDir(core, cellId) {
    return join(core.stateDir, 'cells', this._safeCellId(cellId));
  }

  /**
   * 所有落盘路径的**唯一** cell_id 入口：必须是 opaque id。
   *
   * 修前这里是 `join(core.stateDir, 'cells', String(cellId))`，而 cellId 来自网关参数 ——
   * 实测 `readReceipts('../../outside')` 能读到 state 目录**之外**的任意 `receipts.jsonl`
   * （构造好同名文件即可），`listSummaries` / `loadSummary` / `saveSummary` 同一形状。
   * 这与 Cell 合同里 `checkOpaqueId`（禁 `/`、`\`、`.`、`..`）是同一条判据，只是当时
   * 没在这条通道上执行。放在这里而不是各调用点：漏一处就等于漏全部。
   */
  _safeCellId(cellId) {
    return checkOpaqueId(String(cellId), 'cell_id');
  }

  _contextDir(core, cellId) {
    return join(this._cellDir(core, cellId), 'context');
  }

  // ── profile 加载 ─────────────────────────────────────────────────────
  /**
   * 从宿主声明的 profileRoot 读一份 profile 并校验。
   *
   * 每一步拒绝都具名：`context_disabled` / `profile_not_allowed` / `profile_unreadable`
   * / `profile_invalid` / `profile_too_large` / `profile_out_of_bounds`。
   * 这里刻意不做"读不到就用默认"——那会把一次配置事故伪装成正常运行。
   */
  async loadProfile(core, profileId, { allowListCheck = true } = {}) {
    const { pol, profileRoot } = this._roots(core);
    if (!pol.enabled || !profileRoot) {
      throw contractError(
        'cell context is not enabled on this host: set cells.context.enabled=true and cells.context.profileRoot '
        + '(this build never guesses a profile directory from the process cwd)',
        'context_disabled');
    }
    if (typeof profileId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._@+-]*$/.test(profileId) || profileId.length > 128) {
      throw contractError(`invalid profile id: ${JSON.stringify(String(profileId).slice(0, 64))}`, 'invalid_profile_id');
    }
    if (allowListCheck && Array.isArray(pol.allowedProfiles) && !pol.allowedProfiles.includes(profileId)) {
      throw contractError(
        `profile "${profileId}" is not in the host allowlist (cells.context.allowedProfiles). `
        + 'A profile must be authorised by the host; a caller cannot widen its own context by naming a file.',
        'profile_not_allowed');
    }
    const file = join(profileRoot, `${profileId}.json`);
    // 真实路径必须在根内：`reviewer-v1.json -> /etc/passwd` 这类链接不因为"名字合法"就放行。
    const inside = await realInside(profileRoot, file);
    if (!inside) {
      throw contractError(`profile "${profileId}" resolves outside the host profile root`, 'profile_out_of_bounds');
    }
    let buf;
    try {
      const s = await stat(inside.real);
      if (!s.isFile()) throw contractError(`profile "${profileId}" is not a regular file`, 'profile_unreadable');
      if (s.size > PROFILE_MAX_BYTES) {
        throw contractError(`profile "${profileId}" too large（${s.size} > ${PROFILE_MAX_BYTES} bytes）`, 'profile_too_large');
      }
      buf = await readFile(inside.real);
    } catch (err) {
      if (err?.contractError) throw err;
      throw contractError(`profile "${profileId}" is unreadable: ${err.code || err.message}`, 'profile_unreadable');
    }
    let parsed;
    try {
      parsed = JSON.parse(buf.toString('utf8'));
    } catch (err) {
      throw contractError(`profile "${profileId}" is not valid JSON: ${err.message}`, 'profile_invalid');
    }
    let normalized;
    try {
      normalized = validateContextProfile(parsed);
    } catch (err) {
      const e = contractError(`profile "${profileId}" failed contract validation: ${err.message}`, 'profile_invalid');
      e.cause = err;
      throw e;
    }
    if (normalized.profile_id !== profileId) {
      // 文件名与内部 id 不一致时，绑定表记的 id 与实际生效的配置会分叉。
      throw contractError(
        `profile file "${profileId}.json" declares profile_id "${normalized.profile_id}"; `
        + 'refusing to bind a profile under a name it does not claim', 'profile_invalid');
    }
    return { profile: normalized, file: inside.real, profile_sha256: sha256(buf) };
  }

  /**
   * 解析 `system_prompt_ref`（`local:<相对路径>`）为**文本 + 内容哈希**。
   *
   * 与 profile 读取同一套边界：授权根内、普通文件、大小上限、realpath 追链。
   * 额外两条：
   *   · 空文件拒绝 —— 一个空系统提示词不是"极简"，是"绑定漏了内容"；
   *   · 返回的 sha256 是**注入内容**的哈希，进回执后可复核"跑的是哪一版"。
   */
  async resolveSystemPrompt(core, ref) {
    const { pol, resourceRoot } = this._roots(core);
    if (!pol.enabled || !resourceRoot) {
      throw contractError('cells.context.resourceRoot is not configured; cannot resolve system_prompt_ref', 'context_disabled');
    }
    const m = /^local:(.+)$/.exec(String(ref || ''));
    if (!m) throw contractError(`system_prompt_ref must be "local:<relative/path>"（收到 "${String(ref).slice(0, 80)}"）`, 'invalid_ref');
    const target = join(resourceRoot, m[1]);
    const inside = await realInside(resourceRoot, target);
    if (!inside) throw contractError(`system prompt "${m[1]}" resolves outside the host resource root`, 'prompt_out_of_bounds');
    let buf;
    try {
      const s = await stat(inside.real);
      if (!s.isFile()) throw contractError(`system prompt "${m[1]}" is not a regular file`, 'prompt_unreadable');
      if (s.size > PROMPT_MAX_BYTES) {
        throw contractError(`system prompt too large（${s.size} > ${PROMPT_MAX_BYTES} bytes）`, 'prompt_too_large');
      }
      buf = await readFile(inside.real);
    } catch (err) {
      if (err?.contractError) throw err;
      throw contractError(`system prompt "${m[1]}" is unreadable: ${err.code || err.message}`, 'prompt_unreadable');
    }
    const text = buf.toString('utf8');
    if (!text.trim()) throw contractError(`system prompt "${m[1]}" is empty`, 'prompt_empty');
    return { text, sha256: sha256(buf), path: inside.real, bytes: buf.length };
  }

  // ── 绑定 ─────────────────────────────────────────────────────────────
  /**
   * 把 profile 绑到一个 Cell 身份上（**宿主动作**，不接受远端/模型自选）。
   *
   * `opts.expectedVersion` 是乐观并发：两个宿主同时改同一个 Cell 的 profile 时，
   * 后一个会拿到 `binding_conflict` 而不是静默覆盖前一个。
   * 换绑记录 `previous`（old id/version/sha + 时间），这是"谁在什么时候换了什么"的唯一证据。
   */
  async bind(core, cellId, opts = {}) {
    const profileId = opts.profileId;
    const { profile, profile_sha256 } = await this.loadProfile(core, profileId);
    // 绑定记的是**注入内容**的哈希，不是 profile 文件的哈希。
    // 两者用途不同（见 context-contract 的 validateContextBinding），混用会让漂移检查恒为假阳性。
    // 这里立刻解析一次提示词：如果它现在就读不到，绑定就不该成功 —— 否则会落一个"绑上了但跑不起来"的配置。
    const prompt = await this.resolveSystemPrompt(core, profile.system_prompt_ref);
    // 绑定目标必须是**这个宿主上真实存在的 Cell**，否则绑定会变成一张没有主体的表。
    const runtime = core.getService?.('cell-runtime');
    if (!runtime?.describe) throw contractError('cell-runtime is not assembled; cell-context binding has no subject', 'cell_not_ready');
    runtime.describe(cellId);   // 未知 Cell 会抛 unknown_cell

    const prev = this._bindings.get(String(cellId)) || null;
    if (opts.expectedVersion != null && prev && prev.version !== opts.expectedVersion) {
      throw contractError(
        `binding for cell "${cellId}" is at version ${prev.version}, expected ${opts.expectedVersion}. `
        + 'Re-read the current binding before changing it (a blind overwrite would silently swap a running cell\'s identity).',
        'binding_conflict');
    }
    const version = (prev?.version || 0) + 1;
    const binding = validateContextBinding({
      schema_version: CONTEXT_BINDING_SCHEMA,
      cell_id: String(cellId),
      profile_id: profile.profile_id,
      version,
      system_prompt_sha256: prompt.sha256,
      profile_sha256,
      bound_at: new Date().toISOString(),
      ...(prev ? { previous: { profile_id: prev.profile_id, version: prev.version, system_prompt_sha256: prev.system_prompt_sha256, profile_sha256: prev.profile_sha256, bound_at: prev.bound_at } } : {}),
    });
    await this._writeBinding(core, binding);
    this._bindings.set(String(cellId), binding);
    core.emit?.('cell.context.bound', {
      cell_id: String(cellId), profile_id: profile.profile_id, version,
      previous_profile_id: prev?.profile_id ?? null, timestamp: new Date().toISOString(), sourcePlugin: 'cell-context',
    });
    core.log('info', `[cell-context] ${cellId} → ${profile.profile_id}@v${version}（prompt sha256=${prompt.sha256.slice(0, 12)}…）`);
    return binding;
  }

  async unbind(core, cellId) {
    const prev = this._bindings.get(String(cellId)) || null;
    this._bindings.delete(String(cellId));
    try {
      const f = join(this._contextDir(core, cellId), 'binding.json');
      await rename(f, `${f}.removed-${Date.now()}`).catch(() => {});
    } catch { /* 删不掉不影响内存态；文件已不可达 */ }
    core.emit?.('cell.context.unbound', {
      cell_id: String(cellId), previous_profile_id: prev?.profile_id ?? null,
      timestamp: new Date().toISOString(), sourcePlugin: 'cell-context',
    });
    return { unbound: true, previous_profile_id: prev?.profile_id ?? null };
  }

  /** 读绑定：内存优先，未命中则从磁盘恢复（重启后绑定必须一致）。 */
  bindingOf(core, cellId) {
    const id = String(cellId);
    if (this._bindings.has(id)) return this._bindings.get(id);
    return null;
  }

  /**
   * **同步**取绑定快照（不读盘）。`accept()` 用它钉住"这个任务被接下时是哪一版"。
   *
   * 为什么必须有这个同步入口：`accept()` 是同步 API（30+ 调用方依赖它同步抛错），
   * 而解析 profile 需要读盘。若把冻结推迟到 `execute()` 再读"当前绑定"，那么
   * accept 与 execute 之间的一次换绑就会改变**已经接下**的那个任务的身份 ——
   * 实测正是如此（accept 后换 v2，执行时用的是 v2）。计划要求"在飞 Task 保持冻结"，
   * 所以这里把版本钉在 accept，内容留到 execute 再读（读的时候还要验 hash）。
   *
   * 依赖：create() 时会把磁盘上的绑定载入内存，因此重启后这里也能拿到值。
   */
  bindingSnapshot(cellId) {
    const b = this._bindings.get(String(cellId));
    return b ? { ...b } : null;
  }

  async loadBinding(core, cellId) {
    const id = String(cellId);
    if (this._bindings.has(id)) return this._bindings.get(id);
    const file = join(this._contextDir(core, id), 'binding.json');
    let raw;
    try {
      raw = JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw contractError(`binding for cell "${id}" is unreadable: ${err.code || err.message}`, 'invalid_cell_state');
    }
    let b;
    try {
      b = validateContextBinding(raw);
    } catch (err) {
      throw contractError(`binding for cell "${id}" is invalid: ${err.message}`, 'invalid_cell_state');
    }
    this._bindings.set(id, b);
    return b;
  }

  async _writeBinding(core, binding) {
    const dir = this._contextDir(core, binding.cell_id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => {});
    const tmp = join(dir, `binding.json.tmp-${process.pid}`);
    await writeFile(tmp, JSON.stringify(binding, null, 2), { mode: 0o600 });
    await chmod(tmp, 0o600).catch(() => {});
    await rename(tmp, join(dir, 'binding.json'));
  }

  // ── 执行期冻结 ───────────────────────────────────────────────────────
  /**
   * accept 时调用：把"这一版 profile"钉进这个 Task。
   *
   * 返回的对象是**值快照**，不是对绑定表的引用 —— 之后宿主换绑不会影响它。
   * 没有绑定 ⇒ 返回 null（调用方走旧的 `agent.systemPrompt` 路径，行为不变）。
   */
  /**
   * 冻结认知配置。`pinned` 是 accept 时钉住的绑定快照；不传则用当前绑定。
   *
   * 返回的对象是**值快照**，不是对绑定表的引用 —— 之后宿主换绑不会影响它。
   * 没有绑定 ⇒ 返回 null（调用方走旧的 `agent.systemPrompt` 路径，行为不变）。
   *
   * 两步校验，缺一不可：
   *   ① `pinned` 存在时，profile_id **必须**与快照一致（换绑不得影响已接下的任务）；
   *   ② 读到的提示词 hash **必须**与钉住版本一致（内容漂移必须具名失败）。
   */
  async freezeForTask(core, cellId, taskId, incarnationId, pinned = null) {
    const current = await this.loadBinding(core, cellId);
    // 修前这里是 `if (!current) return null`，于是 accept 之后的一次 `unbind` 会让
    // **已经接下**的任务在 execute 时拿到 null ⇒ 退回宿主默认 `agent.systemPrompt`。
    // 也就是说：解绑一个 Cell 的认知配置，会悄悄改变一个在飞任务的工作身份，
    // 而报告里没有任何一个字显示这件事发生过（实测：accept 后 unbind，freeze 返回 null）。
    // 钉住的快照就是我们**承诺过**这个任务要用哪一版 —— 它必须能被独立读出来，
    // 不能以"当前还有没有绑定"为前提。现在的语义：
    //   · 有钉住版本 ⇒ 按钉住版本冻结（解绑不影响它，解绑只影响之后 accept 的任务）；
    //   · 无钉住版本且当前无绑定 ⇒ null（走旧路径，与 v0.9.21 一致）；
    //   · 有钉住版本但读不到内容 ⇒ 具名失败，**不**静默退回默认提示词。
    if (!current && !pinned) return null;
    const binding = pinned || current;
    if (pinned && !current) {
      core.log('info', `[cell-context] ${cellId}/${taskId} 按 accept 时钉住的 ${pinned.profile_id}@v${pinned.version} 冻结`
        + '（该 Cell 的绑定已被解绑；解绑只影响此后 accept 的任务）');
    }
    if (pinned && current && current.profile_id !== pinned.profile_id) {
      // 这**不是**错误：accept 之后换绑是合法操作，旧任务继续用它当初的版本。
      // 记一条日志便于审计"这个任务跑的是旧版本"。
      core.log('info', `[cell-context] ${cellId}/${taskId} 使用冻结版本 ${pinned.profile_id}@v${pinned.version}`
        + `（当前绑定已变为 ${current.profile_id}@v${current.version}）`);
    }
    const { profile } = await this.loadProfile(core, binding.profile_id);
    let prompt;
    try {
      prompt = await this.resolveSystemPrompt(core, profile.system_prompt_ref);
    } catch (err) {
      const e = contractError(
        `cannot freeze context profile for cell "${cellId}": ${err.message}`, err.code || 'prompt_unreadable');
      e.cell_id = String(cellId);
      throw e;
    }
    if (prompt.sha256 !== binding.system_prompt_sha256) {
      throw contractError(
        `system prompt for profile "${profile.profile_id}" changed since it was bound `
        + `(bound ${binding.system_prompt_sha256.slice(0, 12)}…, now ${prompt.sha256.slice(0, 12)}…). `
        + 'Re-bind explicitly so the change is recorded with old/new and a timestamp.',
        'profile_drift');
    }
    return Object.freeze({
      cell_id: String(cellId),
      task_id: String(taskId),
      incarnation_id: String(incarnationId),
      profile: Object.freeze(profile),
      profile_sha256: binding.profile_sha256 ?? null,
      system_prompt: prompt.text,
      system_prompt_sha256: prompt.sha256,
      bound_version: binding.version,
      frozen_at: new Date().toISOString(),
    });
  }

  /** execute 开始时把冻结快照挂到会话上；haotian-lite 据此取系统提示词。 */
  enterExecution(sessionId, frozen) {
    if (!frozen) return;
    this._scopes.set(String(sessionId), frozen);
  }

  exitExecution(sessionId) {
    this._scopes.delete(String(sessionId));
  }

  /** 从会话反查 ExecutionScope —— 模型只能影响"取什么"，不能影响"我是谁"。 */
  scopeForSession(sessionId) {
    const frozen = this._scopes.get(String(sessionId));
    if (!frozen) {
      throw contractError(
        'no active cell execution scope for this session: context/experience access is only available '
        + 'inside a running cell task (a bare session is not a cell)', 'no_execution_scope');
    }
    return frozen;
  }

  // ── 回执 ─────────────────────────────────────────────────────────────
  /** 追加一条装配回执。**只记元数据**：系统提示词与检索正文不落在这里。 */
  async appendReceipt(core, receipt) {
    const rec = validateContextReceipt(receipt);
    const dir = this._contextDir(core, rec.cell_id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, 'receipts.jsonl');
    await appendFile(file, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
    await chmod(file, 0o600).catch(() => {});
    // 滚动截断：回执是审计材料，不是无限日志。截断本身留一条说明，避免"文件变小了"无从解释。
    try {
      const text = await readFile(file, 'utf8');
      const lines = text.split('\n').filter(Boolean);
      if (lines.length > RECEIPT_MAX_LINES) {
        const keep = lines.slice(-Math.floor(RECEIPT_MAX_LINES * 0.8));
        await writeFile(file, `${keep.join('\n')}\n`, { mode: 0o600 });
        await chmod(file, 0o600).catch(() => {});
        core.log('info', `[cell-context] receipts.jsonl truncated: ${lines.length} → ${keep.length} lines`);
      }
    } catch { /* 截断失败不影响已写入的回执 */ }
    return rec;
  }

  async readReceipts(core, cellId, limit = 20) {
    const file = join(this._contextDir(core, cellId), 'receipts.jsonl');
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const lines = text.split('\n').filter(Boolean).slice(-Math.max(1, Math.min(500, limit)));
    const out = [];
    for (const line of lines) {
      try { out.push(JSON.parse(line)); } catch { /* 坏行跳过（截断时可能留下半行） */ }
    }
    return out;
  }

  // ── 摘要（PR-4）─────────────────────────────────────────────────────
  /**
   * 摘要**按 Cell + Session 归属**落盘。
   *
   * 修前 `context-manager` 的摘要是插件单例上的一个 Map：进程重启即丢，且 256 上限按
   * "最早写入"淘汰 —— 两个 Cell 各自跑几百轮之后，被淘汰的可能是另一个 Cell 正在用的那段。
   * 这里把归属写进路径：`cells/<cell_id>/context/summaries/<session_id>.json`，
   * 于是"A 的摘要出现在 B 的提示词里"在**路径上**就不可能发生。
   */
  async saveSummary(core, cellId, sessionId, record) {
    const rec = validateCompactionRecord({ ...record, cell_id: String(cellId), session_id: String(sessionId) });
    const dir = join(this._contextDir(core, cellId), 'summaries');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${rec.session_id}.json`);
    // 覆盖前读旧版本号：摘要版本必须单调，不能"新写一条就当 1"。
    let version = 1;
    try {
      const prev = JSON.parse(await readFile(file, 'utf8'));
      if (Number.isInteger(prev?.summary_version) && prev.summary_version >= 1) version = prev.summary_version + 1;
    } catch { /* 没有旧摘要或旧摘要已坏：从 1 开始，坏文件被覆盖 */ }
    const body = JSON.stringify({ ...rec, summary_version: version }, null, 2);
    const tmp = `${file}.tmp-${process.pid}`;
    await writeFile(tmp, body, { mode: 0o600 });
    await chmod(tmp, 0o600).catch(() => {});
    await rename(tmp, file);
    return { ...rec, summary_version: version };
  }

  async loadSummary(core, cellId, sessionId) {
    const file = join(this._contextDir(core, cellId), 'summaries', `${sessionId}.json`);
    let raw;
    try {
      raw = JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      // 损坏的摘要**不得静默注入**：调用方拿到具名错误后才能决定"回退到原始窗口"。
      throw contractError(`summary for ${cellId}/${sessionId} is unreadable: ${err.code || err.message}`, 'summary_corrupt');
    }
    try {
      return validateCompactionRecord(raw);
    } catch (err) {
      throw contractError(`summary for ${cellId}/${sessionId} is invalid: ${err.message}`, 'summary_corrupt');
    }
  }

  async listSummaries(core, cellId) {
    const dir = join(this._contextDir(core, cellId), 'summaries');
    let files;
    try { files = await readdir(dir); } catch { return []; }
    return files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length));
  }
}

export default new CellContext();
export { COMPACTION_RECORD_SCHEMA, CONTEXT_PROFILE_SCHEMA };
