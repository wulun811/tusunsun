// cell-runtime — Cell 运行时适配门面：把"一个 Cell"接到**现有的**执行链上。
//
// 这个文件**不实现** Agent loop：不调模型、不执行工具、不保存对话。它只做四件事：
//   1. 拥有身份与生命周期（CellSpec → 一个说话算数的 `cell_id` + `incarnation_id`）；
//   2. 把 Cell 的工作目录钉进 workspace 服务（唯一真值，见 plugins/workspace.js）；
//   3. 在**执行前**做能力交集（HostPolicy ∩ Cell ∩ Task），不允许模型自授；
//   4. 收集结果与证据，交给独立验收器，产出 WorkResult（执行事实）。
//
// 为什么它必须薄：`src/core/` 有硬行数门禁（scripts/core-limits.mjs），任何"把 Cell 塞进
// 内核"的方案都要先破坏它。Cell 是**部署与合同的形状**，不是内核语义：内核只需要继续提供
// 插件/能力/事件，Cell 由这一层和宿主脚本组合出来 —— 先抽象 Cell，再实现协作。
//
// v0 约束（明确拒绝而不是假装支持）：
//   · 1 Cell : 1 Core : 1 OS process。本文件**不**在进程内创建第二个 Cell，
//     也不接受 `runtime.kind !== 'process'`（见 contract.js 的 `unsupported_runtime`）。
//   · 一个 Cell 一次只跑一个 Task（`max_active_tasks=1`）：这让"哪个任务写了这个文件"可回答。
//   · `max_children` 默认 0：分裂不是 Cell 自己能做的系统调用，是上层提 Spec、薄协调器审查后创建。
import { createHash, randomUUID } from 'node:crypto';
import { rename, rm, readFile, writeFile, mkdir, chmod, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hostname } from 'node:os';
import { realpath } from 'node:fs/promises';
import {
  validateCellSpec, validateTaskEnvelope, intersectCapabilities,
  assertTransition, resolveAfterRestart, contractError,
  CELL_SCHEMA, CELL_STATUS_SCHEMA,
} from './_lib/cell/contract.js';
// 只读工具名单的单一真相（`plugins/_lib/tool-policy.js`）：执行器与本文件读同一份，不各写一份。
import { isReadonlyCapability } from './_lib/tool-policy.js';
// 任务执行票据（rc.31 / K30-01）：`sessionId` 是**身份**不是票据，任务维度必须由 ALS 携带。
import { runInTaskContext } from './_lib/call-context.mjs';

/** 每个 core 一份 Cell 注册表（WeakMap：多 core 共存时不串，且随 core 回收）。 */
const _regs = new WeakMap();

/**
 * 进程内的 incarnation 序号。**唯一性的最后一层**：时间戳到秒、pid 区分进程，
 * 序号区分"同一进程同一秒内的多次创建"。三者合起来才保证"两世运行不可能撞名"——
 * 而"旧结果不能冒充新运行"整个判据都建立在这个唯一性上。
 */
let _incarnationSeq = 0;

/** 门代际：同一进程里每装一次门 +1，用于回答"这一刻生效的是第几代门"（见 describe）。 */
let _gateGeneration = 0;

/** 元数据落盘文件名（在 `<stateDir>/cells/<cell_id>/` 下）。 */
const CELL_FILE = 'cell.json';
const RESULT_FILE = 'results.jsonl';
const LOCK_FILE = 'owner.lock';
/** 结果追加的**有界**重试次数：瞬态错误不该直接变成永久缺证据，无限重试又不该让执行永不结束。 */
const RESULT_APPEND_ATTEMPTS = 3;
/**
 * 未结算清单的上界。为什么需要上界：这是内存里的诊断面，不是日志 ——
 * 持续失败时无界增长等于把“磁盘满”变成“内存泄漏”。超出就滚掉最旧的，因为它至少还
 * 活在事件流里（`cell.task.unsettled`）。
 */
const UNSETTLED_MAX = 16;

/**
 * **进程内活属主登记**（rc.33 / R32-01）：键是 `stateDir/cells` 的真实路径，值是那个
 * **Core 实例**（连同它名下还活着的 cell_id）。
 *
 * 为什么需要它：`owner.lock` 靠 `mkdir` 的原子性只能回答"两个**进程**能不能同时拥有同一个
 * stateDir"，回答不了"同一个进程里两个 Core"。而 1 Cell : 1 Core : 1 进程是**部署约束**，
 * 不是代码可以假定的事实 —— 把判据放进代码，约束才有执行者。
 */
const STATE_DIR_OWNERS = new Map();

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** 同主机上的进程是否还活着（信号 0 不发信号，只做存在检查）。 */
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}


class CellRuntime {
  name = 'cell-runtime';
  version = '0.1.0';
  provides = [{ name: 'cell-runtime', type: 'service' }];
  description = 'Cell 适配门面（describe/accept/execute/report/close），驱动既有 chat.handle 与会话服务';

  async init(core) {
    const reg = { core, cells: new Map(), policy: core.get?.('cells') || {} };
    _regs.set(core, reg);
    // 执行器**迟到**时补门：`cell` 场景里 `cell-runtime` 与 `tool-executor` 的装载次序由场景
    // DAG 决定，自定义装配里也可能是先建 Cell。订阅已提交事实，而不是假设"它应该先装"。
    core.on?.('core:plugin.loaded', (e) => {
      if (e?.pluginName === 'tool-executor' || e?.name === 'tool-executor') this._installGatesForExisting(core);
    });
    // 注册的是**绑定该 core** 的门面（与 workspace 同因：插件是模块级单例）
    core.registerService('cell-runtime', {
      describe: (id) => this.describe(core, reg, id),
      list: () => this.list(reg),
      create: (spec, opts) => this.create(core, reg, spec, opts),
      accept: (id, task) => this.accept(core, reg, id, task),
      execute: (id, task, opts) => this.execute(core, reg, id, task, opts),
      report: (id) => this.report(reg, id),
      // 结果行的**归并读取**（rc.33 / R32-04）：按 `record_id` 去重，不按行数。
      // “一次执行写了两行”在物理上是可能的（追加成功、确认丢失、跨进程同时追加），
      // 所以消费方不得把行数当完成次数 —— 这个入口就是给它用的那一份口径。
      resultRecords: (id) => this.resultRecords(core, reg, id),
      // 按**会话**反查 Cell 的权威入口：问**权威登记表**，不按 `cell-<id>` 的命名约定切字符串。
      // 名字派生只能猜 —— 「判据读的名字 ≠ 事实的持有者」。`sessionId` 是 `create()` 时写进
      // rec 的那个值，全等比较；不匹配返回 null（调用方必须自己决定“没有归因”怎么表达）。
      cellForSession: (sessionId) => this.cellForSession(reg, sessionId),
      // 派发期的**会话资格判决**（rc.30 / K29-01）：授权只有一个来源 —— 登记表。
      // 执行器、haotian-lite、以后任何一处派发点都问这里，不各写一份状态机：
      // 三份判据必然漂移，而漂移的那一份就是旁路。
      sessionEligibility: (sessionId) => this.sessionEligibility(reg, sessionId),
      // **派发**资格（rc.31 / K30-01）：会话资格 + 任务维度。名字分开是因为它们回答两个问题：
      // 「这个会话还是不是那个 Cell」（身份）与「这一次调用是不是当前那个任务」（派发）。
      // 合成一个函数就会让「会话还活着」被读成「这次调用可以」—— 那正是 K30-01。
      dispatchEligibility: (sessionId, taskCtx) => this.dispatchEligibility(reg, sessionId, taskCtx),
      // 门的**身份**（rc.31 / K30-02）：不是「有没有一条活租约」，而是「活着的还是不是
      // 我当初装的那道门」。回执、实例、代际缺一不可。
      gateIdentity: (sessionId) => this.gateIdentity(reg, sessionId),
      // 宿主发起的认知调用要用**当前任务**的票据（rc.31）：票据由这里构造，调用方不能指定 epoch。
      runInActiveTask: (sessionId, fn) => this.runInActiveTask(reg, sessionId, fn),
      close: (id, opts) => this.close(core, reg, id, opts),
      verify: (id, task, opts) => this.verify(core, reg, id, task, opts),
    });
    core.log('info', `[cell] Cell 运行时已就绪：v0 支持 1 Cell : 1 Core : 1 进程；`
      + `能力上限由宿主策略给出，分裂需上层提 Spec（max_children 默认 0）`);
  }

  /** 宿主授予的**能力上限**（Cell 只能是它的子集；Spec 不能把上限抬高）。 */
  _hostCapabilities(core, reg) {
    const raw = reg.policy?.hostCapabilities
      ?? core.get?.('cells.hostCapabilities')
      ?? null;
    if (Array.isArray(raw)) return raw.filter((c) => typeof c === 'string' && c);
    // 默认上限 = 这个宿主**能提供**的能力，有两个来源，缺一不可：
    //   ① 已注册的能力（eager 装配的，或已被懒加载触发注册的）；
    //   ② 懒加载索引里**声明**的 provides（工具插件大多在懒加载池里：调用时才注册能力）。
    // 只看 ① 会把"能懒加载的工具"判成没权限 —— tool.read 还没被任何调用触发注册时，
    // 两个任务都会被 capability_denied 拒掉。
    // 只看 ② 又会让"场景根本没装配这个工具"漏过去，所以两个来源取并集，
    // 真正的拦截仍发生在**执行时**（执行器找不到能力就具名失败）。
    const out = new Set();
    // 只用核心的公开枚举面 `listCapabilities({ prefix })`；读私有 Map 会把另一个插件的内部字段当合同。
    for (const { id } of (core?.listCapabilities?.({ prefix: 'tool.' }) ?? [])) out.add(id);
    const lazyIndex = core.getData?.('_lazyIndex');
    const pending = typeof lazyIndex === 'function' ? lazyIndex() : null;
    if (pending && typeof pending.forEach === 'function') {
      pending.forEach((entry) => {
        for (const p of (Array.isArray(entry?.provides) ? entry.provides : [])) {
          const name = typeof p === 'string' ? p : p?.name;
          if (typeof name === 'string' && name.startsWith('tool.')) out.add(name);
        }
      });
    }
    return [...out].sort();
  }

  _cellDir(core, cellId) {
    return join(core.stateDir, 'cells', cellId);
  }

  /**
   * **同一 stateDir 只能有一个活着的属主**（rc.32 / RC31-D1）。
   *
   * 修前的形状：`create()` 只查本进程的 `_regs` 与 `reg.cells.size`。两个进程指向同一个
   * stateDir、同一个 cell_id 时，**双方都 create 成功**、各自拿到一个 incarnation，
   * 而 `cell.json` 最后只留一个 —— 两个“同一身份”的执行者同时在跑，
   * 各自相信自己是唯一。`tmp+rename` 只保证单次替换原子，不保证只有一个写者。
   *
   * 判据选**目录的独占创建**（`mkdir` 原子）而不是 PID 文件：PID 可以复用、可以过期，
   * “文件最后写入者赢”又是一个竞态。这里写入的 `owner.json` 只用于**解释**锁归谁
   * （谁、哪个进程、什么时候），**不用它判断能不能拿锁** —— 判断只靠 mkdir 的成功/失败。
   *
   * 僵尸处理：持锁者已不在（同主机、`pid` 不存活）时不静默抢占，而是**具名拒绝**，
   * 让操作者显式选择 `forceOwner` 或换 stateDir —— “自动清理”在误判时会直接导致双活。
   */
  async _acquireStateDirOwner(core, cellId, opts = {}) {
    const root = join(core.stateDir, 'cells');
    await mkdir(root, { recursive: true, mode: 0o700 });
    // 键取**真实路径**：`stateDir` 可能是符号链接、可能带 `..`，同一目录的两种写法各拿一份
    // “独占”等于没有独占（进程内没人拦得住两个不同的字符串）。
    let key = root;
    try { key = await realpath(root); } catch { /* 刚建好、取不到真值：用原样路径，进程内仍一致 */ }
    const cellIdStr = String(cellId);
    // `token` 是**这一次取得**的凭据（不是 pid、不是 cell_id）：`forceOwner` 接管之后，旧属主
    // 手里那个句柄的 `release()` 必须认不出新锁 —— 否则它一收尾就把别人的锁 rm 掉（ABA）。
    const meta = { pid: process.pid, cell_id: cellIdStr, host: hostname(), at: new Date().toISOString(), incarnation: null, token: randomUUID() };

    // ── ① 进程内活属主：属主是 **Core 实例**，不是 pid（rc.33 / R32-01）────────────
    // 修前的形状：`holder.pid === process.pid` 直接返回 `shared:true` 放行。于是同一个进程里
    // 两个 Core 指着同一个 stateDir、同一个 cell_id 时**双双 create 成功**、各自拿到一个
    // incarnation，而 `cell.json` 最后只留一个 —— 两个“同一身份”的执行者同时在跑，
    // 各自相信自己是唯一（B 关闭时还会报 `state_dir_released:false`，保护不了任何人）。
    // PID 相同只说明“同一个进程”，不说明“同一个属主”。
    //
    // 同一个 Core 又回来拿同一把锁，只有一种合法情形：上一次 create 在**拿到锁之后**失败，
    // 而它的 `release()` 没把目录删掉（rm 失败）。这时重建不该被自己的残留锁拒掉 ——
    // 但**只接受同一个 cell_id**：v0 强制 1 Cell : 1 Core（见 create 的 cell_quota_exceeded），
    // 所以同 Core 不同 cell 的“共享”根本没有合法形态，直接拒。
    const existing = STATE_DIR_OWNERS.get(key);
    if (existing && opts.forceOwner === true && existing.core !== core) {
      // **显式接管**：进程内唯一能表达“旧 Core 已不再使用这个 stateDir”的动作。真实的进程重启由
      // 进程退出完成；这里服务的是“同一进程内模拟重启”的调用方 —— 它必须自己说出来，不能靠
      // pid 相同自动放行（那正是 R32-01）。旧条目就此作废，旧句柄的 `release()` 会被 token 挡住。
      STATE_DIR_OWNERS.delete(key);
      core.log?.('warn', `[cell] stateDir ${root} 的进程内属主已按 forceOwner 接管（旧 Core 的 cell=${existing.cellId}）`);
    } else if (existing) {
      if (existing.core !== core) {
        throw contractError(
          `stateDir ${root} is already owned by another Core instance in this process `
          + `(cell: ${existing.cellId}). Same pid is not same owner: v0 supports exactly one live Core per stateDir, `
          + 'and two Cores cannot both be authoritative for the same state files. '
          + 'Use a different stateDir for the other Core, close the owning Core first, or pass { forceOwner: true } '
          + 'if that Core is really abandoned (this is the only way to say "process restart" from inside one process).',
          'state_dir_owned');
      }
      if (existing.cellId !== cellIdStr) {
        throw contractError(
          `stateDir ${root} is owned by this Core for cell "${existing.cellId}"; refusing to share it with "${cellIdStr}". `
          + 'v0 runs one cell per Core; another cell needs its own Core and its own stateDir.',
          'state_dir_owned');
      }
      await this._writeOwnerMeta(existing.lockDir, existing);
      return this._ownerHandle(existing, cellIdStr);
    }

    const lockDir = join(root, LOCK_FILE);
    try {
      await mkdir(lockDir, { mode: 0o700 });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let holder = null;
      try { holder = JSON.parse(await readFile(join(lockDir, 'owner.json'), 'utf8')); } catch { /* 锁目录在、元数据不在：当未知属主处理 */ }
      const sameHost = Boolean(holder) && holder.host === meta.host;
      const sameProc = sameHost && holder.pid === process.pid;
      const alive = sameHost && Number.isInteger(holder?.pid) ? processAlive(holder.pid) : false;
      // `forceOwner` 是宿主的显式决定（不是自动清理）：只接受“锁声称的进程确实不在了”，或
      // “锁是本进程留下的、但进程内已经没有 Core 认领它”（上一次释放失败）。
      // 没有锁身份的 CAS，所以**两个同时强抢占**不构成原子替换 —— 这一条不作为已认证能力，
      // 只作为人工介入的出口（见 docs/reference/cell-api.md 的边界）。
      if (opts.forceOwner === true && (!alive || sameProc)) {
        await rm(lockDir, { recursive: true, force: true });
        await mkdir(lockDir, { mode: 0o700 });
        core.log?.('warn', `[cell] stateDir 属主锁已按 forceOwner 接管（旧属主 pid=${holder?.pid ?? '?'} 已不在）`);
      } else {
        const who = holder ? `pid=${holder.pid} host=${holder.host} cell=${holder.cell_id} since=${holder.at}` : 'unknown holder';
        throw contractError(
          `stateDir ${root} is already owned by a live process (${who}${alive ? '' : ', which does not appear to be running'}). `
          + 'v0 supports exactly one live owner per stateDir: concurrent cells on the same stateDir cannot both be authoritative. '
          + (sameProc
            ? 'The lock belongs to this process but no live Core claims it (a previous release must have failed); pass { forceOwner: true } after confirming that.'
            : `Use a different stateDir per process (see examples/cells/dual-cell.mjs), ${alive ? 'stop the other process' : 'or pass { forceOwner: true } after confirming that process is really gone'}.`),
          'state_dir_owned');
      }
    }
    const entry = { core, cellId: cellIdStr, lockDir, root, key, meta };
    STATE_DIR_OWNERS.set(key, entry);
    await this._writeOwnerMeta(lockDir, entry);
    return this._ownerHandle(entry, cellIdStr);
  }

  /** `owner.json` 只用于**解释**锁归谁（谁、哪个进程、哪个 Cell）——判断能不能拿锁只看 mkdir。 */
  async _writeOwnerMeta(lockDir, entry) {
    const body = `${JSON.stringify({ ...entry.meta, cell_id: entry.cellId, cells: [entry.cellId] }, null, 2)}\n`;
    try {
      await writeFile(join(lockDir, 'owner.json'), body, { mode: 0o600 });
      await chmod(join(lockDir, 'owner.json'), 0o600).catch(() => {});
    } catch { /* 解释面写不进去不影响独占：独占由 mkdir 承担，元数据不是判据 */ }
  }

  /**
   * 属主句柄。`release()` 只释放**自己这一个 Cell** 的锁。
   *
   * 返回值是“锁目录这次被删掉了吗”，不是“这次调用成功了吗”：调用失败（rm 报错）时前者为
   * false 而后者也可能是 false，把两者混用会让 `close()` 误报“已释放”（旧版的形状）。
   */
  _ownerHandle(entry, cellId) {
    const release = async () => {
      if (entry.cellId !== cellId) return false;          // 不是我的锁，一概不碰
      if (STATE_DIR_OWNERS.get(entry.key) === entry) {
        STATE_DIR_OWNERS.delete(entry.key);
        try { await rm(entry.lockDir, { recursive: true, force: true }); } catch { return false; }
        return true;
      }
      // 登记已被别的路径清掉（例如 `forceOwner` 接管）：只按 owner.json 里的**取锁 token**
      // 确认“这仍是我那一把”，绝不无条件 rmdir —— 那会把后来属主的锁一起删掉。
      try {
        const cur = JSON.parse(await readFile(join(entry.lockDir, 'owner.json'), 'utf8'));
        if (!cur?.token || cur.token !== entry.meta.token) return false;
      } catch { return false; }
      try { await rm(entry.lockDir, { recursive: true, force: true }); } catch { return false; }
      return true;
    };
    return { release, dir: entry.lockDir, meta: entry.meta, cellId: entry.cellId, inProcess: true };
  }


  // ── describe ────────────────────────────────────────────────────────
  /** 对外状态**必须来自运行事实**：workspace 真实路径、实际注册的能力、实际装着的围栏。 */
  describe(core, reg, cellId) {
    const rec = reg.cells.get(String(cellId));
    if (!rec) throw contractError(`unknown cell: ${cellId}`, 'unknown_cell');
    const ws = core.getService?.('workspace');
    // 优先取绑定表里的真值；绑定已释放（close 之后）时用创建时的快照，**不**回落到
    // 进程默认根 —— 那个目录与这个 Cell 无关。
    let wsReal = rec.workspaceReal || rec.spec.workspace;
    // 只有**确实还有一条 bound 记录**时才采信 `root()`：解绑之后 `root()` 会回落到进程默认根
    // （它无法区分"从未绑定"与"刚被解绑"），那个值不属于这个 Cell。
    try {
      const st = ws?.status?.(rec.sessionId);
      if (st === 'bound' || st === 'unavailable') wsReal = ws.root(rec.sessionId) || wsReal;
    } catch { /* 绑定不可用：用快照 */ }
    const fence = core.getService?.('kunxiansuo.local')?.fenceStatus?.() || { installed: false, owner: null, scope: 'none' };
    const hostCaps = this._hostCapabilities(core, reg);
    const effective = rec.spec.capabilities.filter((c) => hostCaps.includes(c));
    return {
      schema_version: CELL_STATUS_SCHEMA,
      cell_id: rec.spec.cell_id,
      incarnation_id: rec.incarnationId,
      state: rec.state,
      // 内部阶段（rc.33 / R32-02）：`preparing` / `committed` / `settling` / null。
      // 结算期间 `state` 保持 `busy`，所以不会出现“state=ready 但还在写结果”的自相矛盾；
      // 两个字段各自回答一个问题，`accept` 的判据也只看得到同一个事实。
      phase: rec.prepare?.phase ?? null,
      workspace_realpath: wsReal,
      capabilities_effective: effective,
      capabilities_withheld: rec.spec.capabilities.filter((c) => !hostCaps.includes(c)),
      fence: { installed: !!fence.installed, mode: rec.spec.permission_mode, scope: fence.scope || 'process', owner: fence.owner || null },
      // 执行期授权接点的**真实状态**（H26-01 观测面）：不是"场景里有执行器"，而是
      // "这个 Cell 的门此刻装着没有、owner 是谁、装了几条、第几代"。
      capability_gate: (() => {
        const g = rec.gate;
        const exec = core.getService?.('tool-executor');
        const counts = g?.owner && typeof exec?.hookCountFor === 'function'
          ? exec.hookCountFor(g.owner) : { pre: 0, dispatch: 0, post: 0 };
        const receipts = Object.values(g?.receipts || {});
        // `installed` = 当初装上了；`live` = **此刻**还在（拿回执现问执行器）。两个都报，
        // 是因为它们会分叉：装配之后被摘掉/重初始化，`installed` 仍为真而 `live` 已假。
        const live = typeof exec?.verifyHook === 'function' && receipts.length > 0
          && receipts.every((r) => exec.verifyHook(r).ok);
        // 租约（rc.29 / R28-A）：`live` 说"回执还在"，`lease` 说"派发期还认这条门"。
        // 两个面分开报，因为钩子被摘掉之后它们会分叉 —— 而分叉本身就是要被看见的事实。
        const leases = typeof exec?.guardLeasesFor === 'function' ? exec.guardLeasesFor(rec.sessionId) : [];
        const lease = leases.find((l) => l.owner === (g?.owner ?? null)) || leases[0] || null;
        return {
          installed: !!g?.installed, live, owner: g?.owner ?? null, generation: g?.generation ?? 0,
          pre: counts.pre, dispatch: counts.dispatch, post: counts.post ?? 0,
          executor_present: !!exec,
          tokens: receipts.map((r) => r.token),
          // `lease` 是**派发期**的存续要求：非 null 而 `live:false` = 门被摘了、下一次派发必拒。
          lease, lease_live: !!lease?.live,
          reinstalls: rec.gateReinstalls || 0,
        };
      })(),
      active_task_id: rec.activeTask?.task_id ?? null,
      // **未结算清单**（rc.32 / RC31-B1）：这些执行真的发生过，但持久回执写失败了。
      // 它不进 WorksResult、也不当证据用 —— 它是一个“别把这件事静默丢掉”的观测面。
      // 有界、只在内存：重启后由 `results.jsonl` 与 `faulted` 收敛判断，不靠它。
      unsettled: (rec.unsettled || []).slice(),
      ...(rec.faultReason ? { fault_reason: rec.faultReason } : {}),
    };
  }

  list(reg) {
    return [...reg.cells.values()].map((r) => ({
      cell_id: r.spec.cell_id, state: r.state, workspace: r.spec.workspace,
      incarnation_id: r.incarnationId, active_task: r.activeTask?.task_id ?? null,
    }));
  }

  /**
   * 按**内部会话**反查 Cell。
   *
   * 调用方（`cell-file-txn`）能拿到的可信标识只有执行器下发的 `sessionId`。
   * 按 `cell-<id>` 约定切字符串会误判（手工命名成 `cell-x` 的普通对话）也会漏（改过名
   * 的 Cell）；问登记表则是拿 `create()` 真的写进去的 `rec.sessionId` 做全等比较。
   * 查不到返回 null —— 调用方必须把“没有归因”写成 null，不能编一个 id。
   */
  cellForSession(reg, sessionId) {
    const sid = sessionId == null ? '' : String(sessionId);
    if (!sid) return null;
    for (const r of reg.cells.values()) {
      if (r.sessionId === sid) {
        return {
          cell_id: r.spec.cell_id,
          incarnation_id: r.incarnationId,
          state: r.state,
          task_id: r.activeTask?.task_id ?? null,
          // 执行资格是否已被撤销（单向水位）。只报 `state` 不够：wall_ms 超时之后
          // 状态会回到 `ready`，而那次执行的撤销**不会**跟着回滚 —— 「看起来还能跑」
          // 与「这张票还有效」是两件事，派发期要的是后者。
          execution_revoked: r.revokedEpoch >= r.epoch,
        };
      }
    }
    return null;
  }

  /**
   * 派发期的**会话资格判决**（rc.30 / K29-01）。
   *
   * 授权只有一个来源：`create()` 真的写进 `reg.cells` 的 `rec.sessionId`；查询也只有一处：
   * 这张登记表。rc.29 的判据是「有租约就验、没租约不管」，反例正在后半个分句 —— Cell 正常
   * 关闭后 `dropGate()` 把钩子和租约一起收走（那是对的），此后表里什么都不剩，执行器就把
   * 同一会话当成了普通会话。**判据不是错了，是随对象一起消失了。**
   *
   * 返回：
   *   · `null` —— 不是本 Core 登记的 Cell 会话。调用方**不得**据此推任何结论，更不得按
   *     `cell-` 前缀猜身份；保持它原有的判据。
   *   · `{ok:true, cell_id, state}` —— 生命周期还允许它派发。**门在不在**由执行器回答
   *     （租约是执行器的知识），这里不越界替它表态。
   *   · `{ok:false, code, reason}` —— 生命周期已经不允许：已关闭/排空中/故障中，或执行资格
   *     已被撤销。正常关闭**也不得**退回普通会话 —— 关闭是「这个身份不再产生副作用」，
   *     不是「这个身份不再受约束」。
   */
  sessionEligibility(reg, sessionId) {
    const cell = this.cellForSession(reg, sessionId);
    if (!cell) return null;
    const label = `cell "${cell.cell_id}"`;
    if (cell.execution_revoked) {
      return {
        ok: false, code: 'execution_revoked', cell_id: cell.cell_id, state: cell.state,
        reason: `execution_revoked: ${label} execution is no longer valid (state=${cell.state}). `
          + 'The run was closed, faulted or timed out; a revoked identity must not keep producing side effects. '
          + 'A closed Cell does not become an ordinary session.',
      };
    }
    if (cell.state !== 'ready' && cell.state !== 'busy') {
      return {
        ok: false, code: 'cell_gate_unavailable', cell_id: cell.cell_id, state: cell.state,
        reason: `cell_gate_unavailable: ${label} is ${cell.state}; only ready/busy may dispatch tools. `
          + 'Refusing instead of treating the session as ungated.',
      };
    }
    return { ok: true, cell_id: cell.cell_id, state: cell.state };
  }

  /**
   * 派发期的**任务维度**判决（rc.31 / K30-01）。
   *
   * `sessionEligibility` 回答的是「这个会话还是不是那个 Cell」—— 那是**身份**。身份在 Cell
   * 活着的整段时间里**不变**，所以它无法区分「任务 A 的迟到回调」与「任务 B 正在执行」：
   * 两者拿的是同一个 `sessionId`、同一个 `ok:true`。专家反例正是这一点 ——
   * A 留下的回调在 B `busy` 期间借到了 B 的授权，真写盘。
   *
   * 所以这里再问一层：**这一次调用是不是当前那个任务**。票据（`taskCtx`）由 `execute()`
   * 在分配 epoch 之后经 `runInTaskContext` 签发，执行器只能读；模型给的 JSON 进不了 ALS。
   *
   * 返回：
   *   · `null` —— 不是本 Core 的 Cell 会话（普通会话，保持原行为）。
   *   · `{ok:false, code}` —— 身份层或任务层任一不成立。两者的 code 必须不同，
   *     否则"已关闭"与"旧任务迟到"会共用同一个码，处置动作就分不开了。
   */
  dispatchEligibility(reg, sessionId, taskCtx) {
    const base = this.sessionEligibility(reg, sessionId);
    if (!base) return null;
    if (base.ok === false) return base;
    const rec = reg.cells.get(base.cell_id);
    if (!rec) return null;
    const deny = (code, why) => ({ ok: false, code, cell_id: base.cell_id, state: base.state, reason: why });
    const label = `cell "${base.cell_id}"`;

    // ① 没有任何任务票据：Cell 活着、`ready`，但这次调用不来自某一次执行。
    //    A 结束到 B 开始之间的空隙就是这一格。**不得**沿用上一任务的授权 ——
    //    "重置 `gateAllowed`"只挡住这一格，挡不住下一格（B 进行中时它已经有值了）。
    if (!taskCtx || !Number.isInteger(taskCtx.epoch)) {
      return deny('task_scope_required',
        `task_scope_required: ${label} is ${base.state}, but this dispatch carries no task execution context. `
        + 'A Cell identity is not a task credential: without an active task there is no authorisation to inherit.');
    }
    // ② 票据属于别的 Cell / 别的 incarnation：陈旧票据不得在另一个身份上通行。
    if (taskCtx.cellId !== base.cell_id || (taskCtx.sessionId && taskCtx.sessionId !== rec.sessionId)) {
      return deny('task_scope_mismatch',
        `task_scope_mismatch: the dispatch context belongs to cell "${taskCtx.cellId}", not ${label}. `
        + 'A task credential is not transferable across cell identities.');
    }
    if (taskCtx.incarnationId && taskCtx.incarnationId !== rec.incarnationId) {
      return deny('task_scope_mismatch',
        `task_scope_mismatch: the dispatch context belongs to incarnation "${taskCtx.incarnationId}", `
        + `but ${label} is now "${rec.incarnationId}". A credential from a previous run must not survive it.`);
    }
    // ③ 此刻没有任务在跑：上一任务已收尾。迟到的回调落在这里。
    if (!rec.activeTask) {
      return deny('task_not_active',
        `task_not_active: ${label} has no task executing right now (state=${base.state}). `
        + 'A dispatch that arrives after its task finished cannot inherit the next task\'s capabilities.');
    }
    // ④ 票据的 epoch 必须**就是**当前任务的 epoch。旧任务的异步链拿的是旧 epoch，不匹配。
    if (taskCtx.epoch !== rec.activeTask.epoch) {
      return deny('stale_task_epoch',
        `stale_task_epoch: the dispatch context carries epoch ${taskCtx.epoch}, but ${label} is executing `
        + `task "${rec.activeTask.task_id}" at epoch ${rec.activeTask.epoch}. A late call from a previous task `
        + 'must not borrow the current task\'s capabilities.');
    }
    if (taskCtx.taskId != null && taskCtx.taskId !== rec.activeTask.task_id) {
      return deny('stale_task_epoch',
        `stale_task_epoch: the dispatch context belongs to task "${taskCtx.taskId}", but ${label} is executing `
        + `"${rec.activeTask.task_id}".`);
    }
    return { ok: true, cell_id: base.cell_id, state: base.state, epoch: rec.activeTask.epoch, task_id: rec.activeTask.task_id };
  }

  /**
   * 这个会话当前**原始那道门**的身份（rc.31 / K30-02）。
   *
   * 专家反例：`describe().capability_gate.live=false` 而新造租约 `live=true`，写盘照样通过。
   * 因为执行器那时只问「有没有一条活租约」—— 那是**存在性**，不是**身份**：
   * 同名 owner 用新回执覆盖旧租约，表中就出现一条"活着但不是我装的那道门"的记录。
   *
   * 所以这里把**自己登记的那套回执**原样交出去，由执行器拿它们回自己表里核：
   * 同一个实例、同一代、同一个 token、同一个 owner。证不出来就是没有门，而不是"有某条活租约"。
   *
   * 返回 `null` = 这个会话不是本 Core 的 Cell。`installed:false` = Cell 存在但从未装上门。
   */
  gateIdentity(reg, sessionId) {
    const sid = String(sessionId ?? '');
    let rec = null;
    for (const r of reg.cells.values()) if (r.sessionId === sid) { rec = r; break; }
    if (!rec) return null;
    const g = rec.gate;
    if (!g?.installed) {
      return { cell_id: rec.spec.cell_id, installed: false, live: false, reason: 'gate_not_installed' };
    }
    const receipts = g.receipts || {};
    return {
      cell_id: rec.spec.cell_id,
      installed: true,
      owner: g.owner,
      generation: g.generation,
      // 实例身份是"同一台执行器"的凭据：换实例之后旧回执一律不算数。
      instance: g.executor?._instanceId ?? null,
      executor: g.executor ?? null,
      receipts: { ...receipts },
      tokens: Object.values(receipts).map((r) => r?.token ?? null),
      lease_key: typeof g.lease?.key === 'string' ? g.lease.key : null,
    };
  }

  /**
   * 在**当前任务**的执行上下文里跑一段宿主发起的认知调用（rc.31）。
   *
   * 为什么需要它：K30-01 的修法是“派发必须有任务票据”，而 `cell.context.experience`
   * （主动求教）是**宿主**发起的 —— 它可能发生在任务之外，也可能发生在任务中。
   * 前者本来就该被拒（没有活跃任务时，没有任何东西可以给这次调用背书）；
   * 后者应当与模型调用受同样约束：**带上当前任务的票据**，而不是绕开判据。
   *
   * 关键：票据由本方法从**自己的登记记录**构造，网关只能选择“用当前任务”或“不用”，
   * 不能选择“用哪个任务” —— 一个能指定 epoch 的参数就是一张自签票据。
   * 返回 `{ok:false, code}` 表示此刻没有可用任务（调用方必须如实拒绝，不得降级）。
   */
  runInActiveTask(reg, sessionId, fn) {
    const sid = String(sessionId ?? '');
    let rec = null;
    for (const r of reg.cells.values()) if (r.sessionId === sid) { rec = r; break; }
    if (!rec) return { ok: false, code: 'unknown_cell', reason: `session "${sid}" is not a registered Cell session` };
    const at = rec.activeTask;
    if (!at) {
      return {
        ok: false, code: 'task_not_active',
        reason: `task_not_active: cell "${rec.spec.cell_id}" has no task executing right now. `
          + 'A host-initiated cognition call still needs an active task to inherit authorisation from; '
          + 'without one there is nothing to authorise it.',
      };
    }
    return {
      ok: true,
      value: runInTaskContext({
        cellId: rec.spec.cell_id,
        sessionId: rec.sessionId,
        incarnationId: rec.incarnationId,
        epoch: at.epoch,
        taskId: at.task_id,
        attempt: at.attempt,
      }, fn),
    };
  }

  // ── create ──────────────────────────────────────────────────────────
  /**
   * 创建（或从磁盘恢复）一个 Cell。
   *
   * `opts.trusted` 由**宿主**判定（CLI/协调器在本机调用即为可信），绝不从 Spec 里读 ——
   * 否则"我在 JSON 里写 trusted:true"就成了提权路径。
   */
  async create(core, reg, spec, opts = {}) {
    const maxChildrenCap = Number.isInteger(opts.maxChildrenCap) ? opts.maxChildrenCap : (reg.policy?.maxChildrenCap ?? 0);
    const allowFullAuto = opts.allowFullAuto ?? (reg.policy?.allowFullAuto === true);
    const norm = validateCellSpec(spec, { maxChildrenCap, allowFullAuto });

    if (reg.cells.has(norm.cell_id)) {
      throw contractError(`cell "${norm.cell_id}" already exists in this process`, 'cell_id_conflict');
    }
    // 兑现部署约束 **1 Cell : 1 Core : 1 OS process**：只判"同 cell_id 冲突"会让同一个 Core
    // 里出现**两个填着 `runtime.kind:'process'`** 的 Cell，Spec 那句 kind 就成了谎话 ——
    // 两个 Cell 共享进程、场景状态与能力注册表，而 Cell 级隔离没有实现。
    // 要同进程多 Cell 是另一版特性，需要自己的隔离机制与验收，不能靠"没人拦所以能建"。
    if (reg.cells.size > 0) {
      const other = [...reg.cells.keys()][0];
      throw contractError(
        `this Core already hosts cell "${other}"; v0 requires 1 Cell : 1 Core : 1 OS process. `
        + 'Refusing to register a second cell in the same process (its runtime.kind "process" would be a lie: '
        + 'scenario state, plugin state and the capability registry are not cell-isolated yet). '
        + 'Start another process for another cell.',
        'cell_quota_exceeded');
    }

    // 工作区：必须是已存在的真实目录；绑定进 workspace 服务（唯一真值），
    // 之后这个 Cell 的**所有**内部会话都用它 —— 它们不能各自再声明别的目录。
    let realWs;
    try {
      const s = await stat(norm.workspace);
      if (!s.isDirectory()) throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
      realWs = await realpath(norm.workspace);
    } catch (err) {
      throw contractError(
        `cell workspace is not usable: ${norm.workspace} (${err.code || err.message})`,
        err.code === 'ENOENT' ? 'invalid_cell_spec' : 'workspace_binding_unavailable');
    }

    // **门资格在产生任何副作用之前判定**（H26-01）：执行器已经注册、但两个接点不全时，门
    // 永远装不上，而这个 Cell 仍会自称 created —— 那是最糟的形态。当场拒绝。
    // 执行器**还没注册**是另一回事：先建 Cell、记 pending，第一次执行前补装
    // （`_ensureGate`），并在 `core:plugin.loaded` 时主动补一次。
    const eligAtCreate = this._gateEligibility(core);
    if (!eligAtCreate.ok && !eligAtCreate.absent) {
      throw contractError(
        `cell "${norm.cell_id}" cannot be created: the registered tool-executor cannot host its capability gate `
        + `(${eligAtCreate.reason}). A Cell whose gate cannot be installed must not be announced as created.`,
        'cell_gate_unavailable');
    }

    const cellDir = this._cellDir(core, norm.cell_id);
    await mkdir(cellDir, { recursive: true, mode: 0o700 });
    await chmod(cellDir, 0o700).catch(() => {});

    // 重启后旧状态的收敛：`busy` 的执行者已经不在了 ⇒ faulted + unknown（不自动 succeeded）
    let prevState = null;
    let prevWorkspace = null;
    try {
      const raw = JSON.parse(await readFile(join(cellDir, CELL_FILE), 'utf8'));
      prevState = raw?.state || null;
      prevWorkspace = typeof raw?.workspace_realpath === 'string' && raw.workspace_realpath
        ? raw.workspace_realpath : null;
    } catch (err) {
      if (err.code !== 'ENOENT') throw contractError(`cell state is unreadable: ${join(cellDir, CELL_FILE)} (${err.code || err.message})`, 'invalid_cell_state');
    }
    const after = prevState ? resolveAfterRestart(prevState) : { state: 'ready', task_state: null };

    // **Cell 身份带着它的工作目录**，重启不得静默换根：同一 stateDir 上"同 cell_id、不同
    // workspace"的第二次创建必须被拒，否则回报的工作区会变成新目录。这与 workspace 层的
    // `workspace_conflict`（"一个会话绑定在它产生的那个目录"）是同一条不变式。
    //
    // 不做目录迁移：需要换目录就换一个 Cell 身份，旧身份的执行归档 —— 迁移要单独验权、审计，
    // 并先证明旧任务全都停了，不是这一版能诚实交付的东西。
    if (prevWorkspace && realWs && prevWorkspace !== realWs) {
      throw contractError(
        `cell "${norm.cell_id}" is already bound to workspace ${prevWorkspace}; refusing to rebind it to ${realWs}. `
        + 'A cell identity owns the directory its history was produced in. '
        + 'Create a cell with a different cell_id for another directory (this build has no migration API).',
        'cell_identity_conflict');
    }

    // **独占属主锁：从这一行开始，restart/create 才是独占的**（rc.32 / RC31-D1）。
    // 放在身份冲突判定**之后**（那一步一个字节都不写、不需要锁），放在一切写入之前。
    // 拿到之后它就是本次 create 的提交资源：后面每一步失败都要还（见 `_rollbackCreate`）。
    const owner = await this._acquireStateDirOwner(core, norm.cell_id, { forceOwner: opts.forceOwner === true });

    // incarnation_id 必须能区分"重启后的新运行"与旧运行：时间戳 + pid 不够（同一进程同一秒
    // 内重建会撞名），所以加一个进程内单调序号 —— 进程内绝不复用，跨进程由 pid 区分。
    const incarnationId = `run-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${process.pid}-${++_incarnationSeq}`;
    const rec = {
      spec: norm,
      state: after.state,
      incarnationId,
      sessionId: `cell-${norm.cell_id}`,     // Cell 的**内部**会话（一个 Cell 可以有多段，但不因此变成多个 Cell）
      activeTask: null,
      faultReason: after.task_state === 'unknown' ? after.reason : null,
      createdAt: Date.now(),
      // 创建时的工作区真值快照。`close()` 会解绑 workspace 绑定，此后 `ws.root()` 不再
      // 回到"映射失效即抛"，而是回落到**进程默认根**（它并不知道这个会话刚被解绑）——
      // 于是 describe 会报一个从没属于过这个 Cell 的目录。留一份快照，观测面才不会说谎。
      workspaceReal: realWs || prevWorkspace,
      lastTask: null,
      // 执行资格的水位与撤销锚点（见 _installCapabilityGate / _revokeExecution）。
      epoch: 0,
      revokedEpoch: -1,      // -1 = 从未撤销（任何 epoch ≥ 0 都还合法）
      revokeReason: null,
      inflight: 0,           // 尚未真正停下的旧异步链计数（quiesce 判据）
      quiesceWaiters: [],
    };
    // 注册**推迟到工作区绑定成功之后**：先 `set()` 再 `declare()` 时，声明被策略拒绝
    // （`workspace_denied` 等）会抛出，但记录已经进了注册表 —— `list()` 里留下一个
    // `state:"ready"` 的 Cell，还能 `describe`/`accept`，而它的工作区**从未绑定过**。
    // "失败的 create 不得留下半个 Cell" 在"目录不存在"之外同样成立。

    // 固定工作区：声明 Cell 的目录到这个 Cell 的会话上。
    // `trusted` 必须**来自宿主**，不能写死 `true`：写死会让 `workspaces.policy` 的白名单对
    // Cell 形同虚设（同一个 roots 外目录，直接 declare 被拒，走 cell.create 却能成功）。
    // 现在原样透传：缺省 false（fail-closed），漏传的后果是远端被拒，不是任意目录放行。
    const ws = core.getService?.('workspace');
    if (ws?.declare) {
      try {
        await ws.declare(rec.sessionId, realWs, { via: 'cell', trusted: opts.trusted === true, force: true });
      } catch (err) {
        // 绑定被拒（白名单）是什么都没留下的失败：属主锁必须当场还，否则“拒绝一个非法
        // create”会把整个 stateDir 弄成永久 state_dir_owned（实测：紧接着的合法 create 失败）。
        await owner.release().catch(() => {});
        throw err;
      }
    }
    // 能力/权限门在**创建时**装上，此后随 Cell 生命存续（见 _installCapabilityGate）：
    // 随每次 execute 装卸的话，"拆掉之后"正是迟到副作用发生的时间窗。
    //
    // 装门必须在 `set()` **之前**：`set()` 之后才装的话，装失败就留下一个"已登记、无门"的
    // Cell —— 它能出现在 `list()`/`describe()` 里，却没有任何执行期约束。失败要**什么都不留**：
    // 登记表里没有它，工作区绑定也按 sessionId 精确退掉（只退这一次创建的那条）。
    if (eligAtCreate.ok) {
      try {
        rec.dropGate = this._installCapabilityGate(core, rec);
      } catch (err) {
        try { await ws?.release?.(rec.sessionId, { via: 'cell-create-failed', force: true }); } catch { /* 尽力而为 */ }
        await owner.release().catch(() => {});
        throw err;
      }
    } else {
      core.log('warn', `[cell] ${norm.cell_id} created before tool-executor (${eligAtCreate.reason}); `
        + 'the capability gate is pending and will be installed before the first execution');
    }
    reg.cells.set(norm.cell_id, rec);
    // **从这里到 create 返回是一个提交边界**（R28-C）：认知绑定读取与状态落盘都可能抛错，
    // 而它们发生在登记之后。旧版没有统一回退，于是 create 报错、`list()` 里却有一个 ready 的
    // Cell（能 accept、能执行、门还装着）—— "创建失败"与"有一个可用的 Cell"同时为真。
    try {
      // CTX-3（PR-1）：把磁盘上的认知绑定载入内存。**必须在 create 里做**，不能等到第一次
      // accept：`accept()` 是同步 API，它要能同步拿到"当前是哪一版"，而同步代码无法读盘。
      // 这里失败不阻断 Cell 创建（认知配置缺失等价于"没绑 profile"，Cell 仍可执行）；
      // 但**损坏**的绑定会具名上抛 —— 一个读不懂的绑定比没有绑定更危险。
      const ctxSvc = core.getService?.('cell-context');
      if (ctxSvc?.loadBinding) {
        // 服务面签名是 `loadBinding(cellId)`（`core` 由插件闭包持有）。
        // 不能多传 `core`：服务上没有这个成员时 `if` 恒假，参数错位不会被执行到；
        // 一旦补上成员，它就会把 core 对象当 cell_id 去拼路径。
        const b = await ctxSvc.loadBinding(norm.cell_id);
        if (b) core.log('info', `[cell] ${norm.cell_id} 认知绑定已恢复：${b.profile_id}@v${b.version}`);
      }
      await this._persist(core, rec);
    } catch (err) {
      await this._rollbackCreate(core, reg, rec, { ws, owner });
      throw err;
    }

    // 属主锁随 Cell 的生命存续：挂在 rec 上，由 `close()` 释放。这不是“用完就放开”的文件句柄，
    // 而是“这个 stateDir 归谁”的一条事实 —— 提前释放就等于允许第二个进程插手。
    rec.stateDirOwner = owner;

    core.log('info', `[cell] ${norm.cell_id} created：workspace=${realWs} incarnation=${incarnationId}`
      + `${prevState ? `（上一世 state=${prevState} → ${after.state}${after.task_state ? `, task=${after.task_state}` : ''}）` : ''}`);
    return this.describe(core, reg, norm.cell_id);
  }

  /**
   * 失败的 create 的**整体回退**（R28-C）。
   *
   * 只退**这一次创建**动过的东西：登记表里的这条记录、这次装的这道门（撤销钩子 + 释放租约）、
   * 以及这个 sessionId 上的工作区绑定。回退**不是**「把目录清空重来」—— 那会把不属于这次
   * 创建的状怱一起删掉（同一个 stateDir 下还有别的 Cell 目录、别的插件的文件）。
   *
   * 磁盘不在这里动：`_persist` 是 tmp + rename，失败时磁盘上要么是旧值、要么是本次完整的新值
   * （不存在「半截 JSON」）。所以回退不需要补偿落盘，也不需要盲删旧状态。
   */
  async _rollbackCreate(core, reg, rec, { ws = null, owner = null } = {}) {
    if (reg.cells.get(rec.spec.cell_id) === rec) reg.cells.delete(rec.spec.cell_id);
    try { if (typeof rec.dropGate === 'function') rec.dropGate(); } catch { /* 尽力而为 */ }
    try {
      await ws?.release?.(rec.sessionId, { via: 'cell-create-rolled-back', force: true });
    } catch { /* 解绑失败不影响回退本身 */ }
    // 属主锁是**这一次 create** 拿的资源：回退必须还，否则“重试”会撞上自己的锁
    // （而那正好把“失败的 create 可以重来”变成“永久 state_dir_owned”）。
    try { await owner?.release?.(); } catch { /* 释放失败由 pid 存活性兼容 */ }
    core.log?.('warn', `[cell] ${rec.spec.cell_id} create rolled back: registry, gate and workspace binding released`);
  }

  // ── accept ──────────────────────────────────────────────────────────
  /**
   * 接任务：**先判能力与状态，再改任何状态**。
   *
   * 拒绝必须发生在模型/工具执行之前 —— 这是"任务准入"的意义：等到执行到一半才发现没有
   * 权限，副作用已经发生了。
   */
  accept(core, reg, cellId, task) {
    const rec = reg.cells.get(String(cellId));
    if (!rec) throw contractError(`unknown cell: ${cellId}`, 'unknown_cell');
    const t = validateTaskEnvelope(task);
    if (t.target_cell_id !== rec.spec.cell_id) {
      throw contractError(`task targets "${t.target_cell_id}" but was delivered to "${rec.spec.cell_id}"`, 'task_rejected');
    }
    if (rec.state === 'stopped' || rec.state === 'faulted') {
      throw contractError(`cell "${rec.spec.cell_id}" is ${rec.state}; it cannot accept tasks`, 'cell_not_ready');
    }
    // draining = "执行资格已撤销、旧链可能还在跑"：此时接新任务会让两段执行并存。
    if (rec.state === 'draining' || rec.inflight > 0) {
      throw contractError(
        `cell "${rec.spec.cell_id}" is draining (a closed or timed-out run has not quiesced yet); ` 
        + 'it cannot accept a new task until the previous execution is confirmed stopped',
        'cell_not_ready');
    }
    if (rec.state === 'busy' || rec.activeTask) {
      throw contractError(
        `cell "${rec.spec.cell_id}" is busy with task "${rec.activeTask?.task_id}"; v0 runs one task at a time`,
        'cell_not_ready');
    }
    // **准备期也是“在跑”**（rc.32 / RC31-A1）：冻结是一段 await，此时 `activeTask` 还没占上，
    // 但那个任务已经把所有判据锁死了。如果 accept 在这里放行，pending 会被改写，
    // 冻结回来的那一条只能失败 —— 结果是一个**后到的任务取消了先到的任务**。
    // 这一条只在 accept 的同步段里判得了，所以放在这里而不是 `_prepareStillValid`。
    if (rec.prepare) {
      throw contractError(
        `cell "${rec.spec.cell_id}" is preparing task "${rec.prepare.task_id}" (phase=${rec.prepare.phase}); `
        + 'it cannot take another task until that one is dispatched or abandoned. v0 runs one task at a time',
        'cell_busy');
    }
    // 门存续断言（H26-02 的任务级兜底）：门被摘掉/被重初始化清空时，**接任务**就已经该被拒
    // —— 不能等到派发期才发现这一趟没有判据。
    this._ensureGate(core, rec, 'accept a task');
    // 能力交集：任一方没有 ⇒ 在**执行前**拒绝（不是执行到一半再说）
    const host = this._hostCapabilities(core, reg);
    const intersect = intersectCapabilities({ host, cell: rec.spec.capabilities, task: t.required_capabilities });
    if (!intersect.ok) {
      throw contractError(intersect.message, intersect.code || 'capability_denied');
    }
    // 预算：Spec 与 Task 取更严的那个（Spec 是"这个 Cell 的常态上限"）
    const budget = {
      max_steps: minNullable(rec.spec.limits.max_steps, t.budget.max_steps),
      wall_ms: minNullable(rec.spec.limits.wall_ms, t.budget.wall_ms),
    };
    rec.pending = { task: t, budget, effective: intersect.effective };
    // pending 的**版本号**：每次 accept 自增。冻结是异步的，返回时必须能回答
    // “我当初占的那个 pending 还是不是现在这个”——旧版直接读 `rec.pending`，于是
    // accept(B) 之后再冻结回来的 A 会拿到 B 的 effective/gateAllowed（rc.32 / RC31-A1 的后半段）。
    rec.pendingRev = (rec.pendingRev || 0) + 1;
    rec.pending.rev = rec.pendingRev;
    // 记住任务信封本身：`verify(id)` 不带 task 时必须回落到**上一次被接下的任务**，
    // 不能把 `rec.lastResult`（一个 WorkResult）当成 Task 去校验 —— 那是必然抛
    // `unsupported_schema_version` 的公开方法。
    rec.lastTask = t;

    // CTX-3（PR-1）：在 accept 时**同步钉住**认知绑定的版本。
    //
    // 只钉版本、不读内容：`accept()` 是同步 API（30+ 调用方依赖它同步抛错），读 profile
    // 与提示词都要读盘。内容留到 execute 再读，读时用这个钉住的 hash 校验。
    //
    // 不能在 execute 时才取"当前绑定"：accept 之后换绑，执行时用的就是**新** profile ——
    // 那个任务的身份在接下之后被悄悄换掉了。在飞 Task 的 prompt profile 必须保持冻结。
    //
    // 无绑定 / 无 cell-context 服务 ⇒ null ⇒ 执行时走旧的 `agent.systemPrompt` 路径。
    const ctxSvcAccept = core.getService?.('cell-context');
    if (ctxSvcAccept?.bindingSnapshot) {
      rec.pending.frozenBinding = ctxSvcAccept.bindingSnapshot(rec.spec.cell_id);
    }
    return { accepted: true, task_id: t.task_id, attempt: t.attempt, effective_capabilities: intersect.effective, budget };
  }

  /**
   * 把一个 Cell 的**生效能力**钉进执行链，并返回撤销函数。
   *
   * "生效能力 = Host ∩ Cell ∩ Task"必须在**执行处**也成立，不能只在 `accept()` 里算一次、
   * 存进 `rec.pending.effective` 却没有执行期读者。否则模型（提示词注入、幻觉、被污染的
   * 上下文）只要点一个宿主装了但 Cell 没声明的工具就能用。
   *
   * 为什么用 pre-hook 而不是改执行器：执行器是平台插件（`plugins/tool-executor.js`），
   * 而"这次执行属于哪个 Cell、它能用什么"是 Cell 层的知识。执行器已经提供了
   * `registerPreHook` 这条既有接线口（捆仙索、工具护栏都走它），复用它比让内核认识 Cell 更对。
   *
   * 边界（诚实）：这是**工具调用层的授权**，不是 OS 沙箱。它挡的是"模型调用了未被授予的工具"，
   * 挡不住"被授予的工具内部越界"（那由工具自己的 `resolveWorkspacePath` 判）。
   */
  /**
   * 门资格**先问再说**：执行器在不在、两个接点是不是真的可调用、装完能不能核账。
   *
   * 为什么单独一个方法：`create()` 必须在产生**任何副作用之前**回答这个问题。旧版把判定
   * 留在装门函数里（`if (!exec?.registerPreHook) return null`），而它在登记之后才跑 ——
   * "执行器迟到"的结果是一个**自称 created、实际一条门都没装**的 Cell，此后它的执行链里
   * 每一次工具调用都无人约束（H26-01 的反例形状）。
   *
   * `registerDispatchHook` 是**必需**接点而不是可选增强：pre 阶段只能拿名字派生的猜测能力
   * id，真正"已解析目标"的判据在派发期；缺它等于只读门与能力门都只剩一半。
   * `hookCountFor` 同样必需：没有回执就无法证明钩子真的进了表，只能相信"调用没抛错"。
   */
  _gateEligibility(core) {
    const exec = core.getService?.('tool-executor');
    if (!exec) return { ok: false, absent: true, reason: 'tool-executor service is not registered yet' };
    if (typeof exec.registerPreHook !== 'function') {
      return { ok: false, reason: 'tool-executor has no registerPreHook (the pre-flight gate cannot be installed)' };
    }
    if (typeof exec.registerDispatchHook !== 'function') {
      return { ok: false, reason: 'tool-executor has no registerDispatchHook (the dispatch-time gate cannot be installed)' };
    }
    // 核账口（rc.28）：`verifyHook` 按**回执**核对"这一条还在吗"；`hookCountFor` 只能数
    // "这个 owner 有几条" —— 数出来的 1 可能来自别人的同 owner 登记，回执只认自己签出去的那一条。
    if (typeof exec.hookCountFor !== 'function' || typeof exec.verifyHook !== 'function') {
      return { ok: false, reason: 'tool-executor has no hookCountFor/verifyHook (an installed gate cannot be verified, only assumed)' };
    }
    // 租约接点（rc.29 / R28-A）：没有它，门只活在钩子表里 —— 表被人摘掉之后，派发期就没有任何
    // 东西记得“这个会话必须有门”。它不是可选增强，是把“存续”从口头变成可判据的那一半。
    if (typeof exec.leaseGuard !== 'function') {
      return { ok: false, reason: 'tool-executor has no leaseGuard (a removed gate could not be noticed at dispatch time)' };
    }
    return { ok: true, exec };
  }

  /**
   * 执行前的门存续断言：**已装，且此刻还在**。
   *
   * 装过一次不等于永远在那儿：执行器重复 `init()`、插件重装、`removeHooksByOwner` 都可能把
   * 钩子摘掉，而 Cell 这边只记得"当初装过"。所以每次 accept/execute 都按 owner 向执行器
   * **重新数一遍**，数不到就具名拒绝 —— 宁可拒绝一次执行，也不在没有判据的链上跑。
   *
   * 执行器**根本不在**时不拒绝：这条 Core 上没有任何工具派发路径，门无从装、也无从被绕过。
   * 这不是放行，而是"没有可放行的东西"；它一旦出现（迟到装配），第一次执行之前就会补装。
   */
  _ensureGate(core, rec, where) {
    const deny = (why) => contractError(
      `cell "${rec.spec.cell_id}" cannot ${where}: capability gate is not installed (${why}). `
      + 'A Cell must not run work while the authorisation contact that constrains it is absent.',
      'cell_gate_unavailable');
    const elig = this._gateEligibility(core);
    if (!elig.ok) {
      if (elig.absent) return { gated: false, reason: elig.reason };
      throw deny(elig.reason);
    }
    if (!rec.gate?.installed) {
      // 迟到的执行器：在**第一次执行之前**把门装上并核账（同步，不开窗口）。
      rec.dropGate = this._installCapabilityGate(core, rec);
      return { gated: true, installed_now: true };
    }
    if (rec.gate.executor !== elig.exec) throw deny('the executor instance was replaced; the gate receipts belong to the old one');
    const stale = this._staleGateReceipts(rec);
    if (stale.length > 0) {
      throw deny(`the gate's own registration receipt(s) are no longer live (${stale.join(', ')}); `
        + "they were removed, or the executor was re-initialised behind the Cell's back");
    }
    return { gated: true };
  }

  /**
   * 拿**自己签出的回执**逐条核账：同一个实例、同一代、记录还在表里。
   *
   * 只数 owner 的话，别人同名登记一条就能把"门还在"这句话填满。返回空数组 = 门仍成立；
   * 每一项是 `kind:reason`，reason 决定还能不能恢复（见 `_installGatesForExisting`）。
   */
  _staleGateReceipts(rec) {
    const exec = rec.gate?.executor;
    if (!exec || typeof exec.verifyHook !== 'function') return ['executor:gone'];
    const stale = [];
    for (const [kind, receipt] of Object.entries(rec.gate.receipts || {})) {
      const v = exec.verifyHook(receipt);
      if (!v.ok) stale.push(`${kind}:${v.reason}`);
    }
    return stale;
  }

  /**
   * 执行器迟到时给**已经存在**的 Cell 补门（`core:plugin.loaded` 订阅的落点）。
   *
   * 只装在"还没装过"的 Cell 上；装失败只记日志不抛 —— 订阅者抛错会打断别人的装载流程，
   * 而真正的兜底是 `_ensureGate`：没有门的 Cell 在下一次 accept/execute 时一定会被拒。
   *
   * 回执失效（被摘掉、执行器换代）也算"没装"：这里是**唯一**的合法重装入口 —— 热装配
   * 回来一次就装一次。accept/execute 不会自己重装（H26-02 要求那里必须拒），所以"恢复"
   * 只能来自一次真的重新装配，而不是某一次执行顺手把门补上。
   */
  _installGatesForExisting(core) {
    const reg = _regs.get(core);
    if (!reg) return 0;
    let installed = 0;
    for (const rec of reg.cells.values()) {
      // 已完成的关闭不再要门：没有旧链可约束，把钩子/租约装回去只会让 `already:true`
      // 这句回执变成假话（门又活着了），而没有任何执行会用到它。
      if (rec.cleanupDone === true) continue;
      if (rec.gate?.installed && this._staleGateReceipts(rec).length === 0) continue;
      try {
        // 重装前先把**已知失效**的那套摘掉（按回执精确撤销）：留着的话它们只是表里的死记录，
        // 但 `hookCountFor` 会把它们数进去，"门装了几条"就开始说假话。
        const oldExecutor = rec.gate?.executor;
        for (const r of Object.values(rec.gate?.receipts || {})) {
          try { oldExecutor?.removeHook?.(r); } catch { /* 尽力而为 */ }
        }
        try { rec.gate?.lease?.release?.(); } catch { /* 尽力而为 */ }
        const previous = rec.gate?.generation ?? 0;
        rec.dropGate = this._installCapabilityGate(core, rec);
        if (previous) rec.gateReinstalls = (rec.gateReinstalls || 0) + 1;
        installed++;
      } catch (err) {
        core.log?.('warn', `[cell] ${rec.spec.cell_id}: capability gate still unavailable after tool-executor loaded: ${err.message}`);
      }
    }
    return installed;
  }

  _installCapabilityGate(core, rec) {
    const elig = this._gateEligibility(core);
    if (!elig.ok) {
      throw contractError(`cell "${rec.spec.cell_id}" cannot be gated: ${elig.reason}`, 'cell_gate_unavailable');
    }
    const exec = elig.exec;
    const owner = `cell:${rec.spec.cell_id}`;
    // 只读模式：白名单之外的**一个都不许**通过。名单来自 `plugins/_lib/tool-policy.js` 的
    // 单一真相，与执行器 `_checkModeReadOnly` 读的是同一份。
    //
    // 这个**名字派生**只允许用于"早退"（能确定要拒就早点拒），不能用于"确定要放"：
    // 名字与能力不是一一对应（执行器还认 `provides[]` / owner 反查，这里只认命名约定）。
    // 叫 `execute_command` 而 `provides: tool.write` 的工具，名字派生出 null；把 null 当
    // "不归这条门管"就是放行。所以 null 一律**延后到派发期**用真实能力判。
    const capIdOf = (toolName) => (typeof toolName === 'string' && toolName.startsWith('tool-')
      ? `tool.${toolName.slice(5)}` : null);

    /**
     * pre 阶段的能力认定：**名字派生只当提示，不当结论**。
     *
     * `registerTool({capabilityId})` 允许工具登记一个**与名字无关**的能力
     * （`tool-liuhe-anchor` → `liuhe.read_anchor`）；此时名字派生出 `tool.liuhe-anchor`，
     * 一个**根本不存在**的能力 id。拿它去做 `allowed.has(...)` 判定必然 false，于是显式
     * 登记了 `liuhe.read_anchor` 的 Cell 也会被 `capability_denied`。
     *
     * 这里返回 `authoritative: false`：pre 阶段没有权威 id，判定延后到 dispatch
     * （执行器在那里一定拿得到真实能力）。**宁可晚一点拒，也不为早拒去耦合
     * `tool-registry` 的私有 Map（`_tools`）。**
     *
     * pre 阶段的意义在别处：撤销判定（`execution_revoked`）与 null 目标处理都不依赖 capId，
     * 仍然在执行前生效。
     */
    const resolveCapId = (toolName) => ({ capId: capIdOf(toolName), authoritative: false });

    // 判据的唯一实现。`stage` 只影响"证据不足时怎么办"：
    //   · 'pre'      —— 发生在 `_checkPreFlight`。此时能力尚未解析（解析要 await 懒加载），
    //                   所以 `capId` 可能为 null。null ⇒ 这一层不表态，交给 'dispatch'。
    //   · 'dispatch' —— 发生在 handler 紧邻上游，`capId` 已是执行器解析出的真实目标。
    //                   此时 null 意味着"目标不明"，默认拒绝（fail-closed）。
    const evaluate = (stage, toolName, capId, sessionId, authoritative = true) => {
      // 只对**本 Cell 的内部会话**生效：普通对话（网关上的其它 sessionId）完全不受影响。
      if (String(sessionId ?? '') !== rec.sessionId) return undefined;

      // 撤销之后：本 Cell 会话的一切工具调用一律 fail-closed（**不看** toolName 前缀 ——
      // "执行资格没了"比"能力不够"更靠前）。
      if (rec.revokedEpoch >= rec.epoch) {
        return {
          block: true,
          reason: `execution_revoked: cell "${rec.spec.cell_id}" execution is no longer valid `
            + `(cell state=${rec.state}${rec.revokeReason ? `, ${rec.revokeReason}` : ''}). `
            + 'The run was closed or timed out; late side effects are refused.',
          code: 'execution_revoked',
        };
      }

      if (!capId) {
        // 非工具能力（chat.handle 等）不归这条门管 —— 但**只有**在名字明确不是工具时才能这么判。
        // 派发期已拿到真实能力，null 表示执行器没能认定目标（legacy 直连），同样按不明处理。
        if (stage === 'pre') return undefined;
        return {
          block: true,
          reason: `capability_denied: cell "${rec.spec.cell_id}" call to "${toolName}" has no resolvable `
            + 'capability identity; an unresolved target cannot be authorised.',
          code: 'capability_denied',
        };
      }

      // `CellSpec.permission_mode` 必须是执行链真读的约束，不能只回显在 `describe().fence.mode`：
      // "声明了却零读者"的安全字段比没有更糟 —— 调用方会据此相信它被限制了。
      //
      // 判据是"**能力**是否属只读类别"，不是"工具名是否在只读清单"：名字可以伪装
      // （别名、provides、owner 反查），能力名不能 —— 它就是执行器真正要调的东西。
      //
      // `authoritative === false` 时这个 capId 是**猜的**。拿猜出来的 id 做只读判定与做
      // granted 判定一样糟：只读能力被猜成 `tool.liuhe-anchor`（不在只读清单里）⇒ 只读
      // Cell 被 `permission_denied` 拒，只能盲写。所以这一层**只对权威 id 表态**。
      if (rec.spec.permission_mode === 'read-only' && !isReadonlyCapability(capId)) {
        if (!authoritative) return undefined;
        return {
          block: true,
          reason: `permission_denied: cell "${rec.spec.cell_id}" is read-only; "${toolName}" resolves to `
            + `"${capId}", which is not a read-only capability. `
            + 'permission_mode is enforced against the resolved capability, not the requested tool name.',
          code: 'permission_denied',
        };
      }
      const allowed = rec.gateAllowed || new Set();
      if (!allowed.has(capId)) {
        // pre 阶段的 id 可能是**猜测**（名字派生）：猜错就放行到 dispatch 复核，
        // 而不是拿一个猜出来的 id 去拒人 —— 后者会把"显式登记能力"的工具全部误杀。
        if (!authoritative) return undefined;
        return {
          block: true,
          reason: `capability_denied: cell "${rec.spec.cell_id}" did not grant "${capId}" `
            + `(effective: ${allowed.size ? [...allowed].join(', ') : '(none)'}). `
            + 'A tool must be granted by HostPolicy ∩ CellSpec ∩ Task before the model may call it.',
          code: 'capability_denied',
        };
      }
      return undefined;
    };

    // 这条门**在 create 时装上、直到 Cell 结束都不拆**。
    //
    // 每次 execute 装一次、finally 里拆掉的话，拆掉的瞬间才是最有特权的时刻：超时结束
    // race → finally 拆门 → 旧对话链迟到的 tool-write 面前**一条门都不剩**，还可能因为
    // 工作区绑定已被释放而落到宿主默认根。"撤销执行资格"不能靠"拆掉检查器"实现。
    //
    // 门常在，判据在闭包里读三个可变真值 —— 撤销水位、当前任务生效能力、只读模式。
    // 撤销是单向的（revokedEpoch 只增），所以晚到的调用只会更确定地被拒。
    // pre 阶段用 `resolveCapId`（名字派生 + `authoritative:false`），把这个标记一并传下去：
    // `evaluate` 要靠它区分"确定不够"（拒）与"猜的、可能猜错"（不表态）。
    // 三个接点（pre 钩子 / dispatch 钩子 / 租约）按顺序装，**任何一步抛错都当场回滚整族**：
    // 装门失败时 `rec.gate` 还没赋值，调用方拿不到 `dropGate`，留下的钩子从此无人认领 ——
    // close 那边会永远数得到残留，合法关闭于是永远完不成（R34-A 的另一半）。
    const rollback = () => { try { exec.removeHooksByOwner?.(owner); } catch { /* 回滚尽力而为 */ } };
    let receiptPre; let receiptDispatch; let lease;
    try {
      receiptPre = exec.registerPreHook((toolName, _args, sessionId) => {
        const r = resolveCapId(toolName);
        return evaluate('pre', toolName, r.capId, sessionId, r.authoritative);
      }, owner, 10, { failClosed: true });

      // **派发期复核**：pre-hook 之后还有两次 await（懒加载解析、能力超时竞速），窗口里
      // 可能发生“门已放行 → 后续钩子挂起 → close(force) → handler 照常启动并写盘”。
      // 这条钩子跑在 handler 紧邻上游且**同步**，"检查通过"与"开始执行"之间没有可外插的时间。
      // dispatch 阶段 `capId` 由执行器解析（`_capabilityIdsForTool` 优先取 `_capabilityId`），
      // **一律权威** —— 这里 authoritative 恒 true，与 pre 阶段的猜测区分开。
      receiptDispatch = exec.registerDispatchHook((toolName, capId, _args, sessionId) => evaluate('dispatch', toolName, capId, sessionId, true), owner);

      // 装完**当场核账**：拿回执去问执行器"这一条还在吗"，而不是数 owner 有几条。
      // 数出来的 1 可能来自别人的同 owner 登记；回执只认自己签出去的那一条。
      // 数不对就回滚并具名失败：只装了一半的门比没有门更危险，因为它看起来像有。
      const landed = { pre: exec.verifyHook(receiptPre), dispatch: exec.verifyHook(receiptDispatch) };
      if (!landed.pre.ok || !landed.dispatch.ok) {
        throw contractError(
          `cell "${rec.spec.cell_id}" capability gate did not land: `
          + `pre=${landed.pre.ok ? 'live' : landed.pre.reason}/dispatch=${landed.dispatch.ok ? 'live' : landed.dispatch.reason}`,
          'cell_gate_unavailable');
      }
      // 租约（R28-A）：把"这个会话必须在门后有判据"写成一条**独立于钩子表**的要求。
      // 装在核账之后：先证明门真的进了表，再让它成为一条别人摘钩也带不走的前提。
      lease = exec.leaseGuard(owner, rec.sessionId, { pre: receiptPre, dispatch: receiptDispatch });
    } catch (err) {
      rollback();
      // 抛错的一方可能是执行器本身（接点被拒、租约签名不全）。对外仍然只有一个结论：
      // 「这条 Cell 的门装不上」—— 调用方不该去读一个它没听说过的内部错误码。
      if (err?.code === 'cell_gate_unavailable') throw err;
      throw contractError(`cell "${rec.spec.cell_id}" capability gate could not be installed: `
        + `${err?.code ? `${err.code}: ` : ''}${err?.message ?? err}`, 'cell_gate_unavailable');
    }

    rec.gate = {
      installed: true, owner, executor: exec, generation: ++_gateGeneration, at: Date.now(),
      // 回执就是这套门的**身份**：此后每一次 accept/execute 都拿它们回来核账（见 `_ensureGate`）。
      receipts: { pre: receiptPre, dispatch: receiptDispatch },
      lease,
    };

    // 只返回"撤销这一整套门"的函数；v0 里 Cell 的生命周期与 core 相同，正常路径不调用它。
    // 这里按 **owner 清族**（不是按回执）：`dropGate` 的语义是这个 Cell **不再要门**了
    // （close 之后没有主体再受它保护），留在表里的每一条都该走 —— 包括重装前失效的那些。
    return () => {
      try { exec.removeHooksByOwner?.(owner); } catch { /* 撤销尽力而为 */ }
      try { rec.gate?.lease?.release?.(); } catch { /* 租约释放尽力而为 */ }
      if (rec.gate) rec.gate.installed = false;
    };
  }

  /**
   * **撤销**这个 Cell 当前的执行资格（单向、幂等、同步）。
   *
   * `close(force)` 与 `wall_ms` 超时都只结束了一段 Promise，**没有**停止仍在运行的
   * 对话链；旧链之后每一次工具调用都必须被拒，否则"已关闭的 Cell 还在写盘"、
   * "已超时的任务仍产生副作用"都会发生。
   *
   * 判据是 `rec.revokedEpoch`（单调水位），**不是** `rec.activeTask`：activeTask 会在
   * 收尾时被清空，用它当开关等于"收尾即解除限制"。
   */
  _revokeExecution(rec, reason) {
    rec.revokedEpoch = Math.max(rec.revokedEpoch, rec.epoch);
    rec.revokeReason = reason || rec.revokeReason;
    if (rec.activeTask) rec.activeTask.revoked = true;
    return rec.revokedEpoch;
  }


  // ── execute ─────────────────────────────────────────────────────────
  /**
   * 执行一个已经 accept 的任务。真正干活的是**现有的** `chat.handle`（经 `core.command`），
   * 本方法只负责：状态迁移、预算真执行、产物与证据收集、结果落盘。
   *
   * 诚实边界：`wall_ms` 到期若只是 Promise 超时而无法中断工具侧副作用，结果标 `timed_out`
   * 并在 `error` 里说明回收状态 —— 不谎称"已取消"。
   */
  async execute(core, reg, cellId, task, opts = {}) {
    const rec = reg.cells.get(String(cellId));
    if (!rec) throw contractError(`unknown cell: ${cellId}`, 'unknown_cell');
    const t = task ? validateTaskEnvelope(task) : rec.pending?.task;
    if (!t) throw contractError('no task accepted yet; call accept() first', 'task_rejected');
    // 直接 execute（没先 accept）也走**同一套准入**：能力/状态/预算的判定只有一处实现。
    // 已经 accept 过的同一任务（同 task_id + attempt）不重复准入，否则第二次会把 pending 覆盖掉。
    if (!rec.pending || rec.pending.task.task_id !== t.task_id || rec.pending.task.attempt !== t.attempt) {
      this.accept(core, reg, String(cellId), t);
    }

    // ── 占位（rc.32 / RC31-A1）：**第一个 await 之前**、同一个同步段内完成 ──────────
    //
    // 修前的形状：先判 `activeTask`/`inflight`，再 `await freezeForTask(...)`，之后才赋值。
    // 两条并发 `execute` 都能在冻结**之前**通过检查，于是同一个 Cell 上跑起两个任务、
    // `maxConcurrentChats` 实测 2。epoch 只能保证“旧任务不能用新任务的权”，保证不了
    // “一个 Cell 只有一个任务”——那是另一条不变式。
    //
    // 占位记录（`rec.prepare`）是这条不变式的**唯一真值**，它有三个字段回答三个问题：
    //   · `token`      —— 这一次准备的身份（compare-and-commit 只认它，不认“现在是谁在跑”）；
    //   · `pendingRev` —— 占位时 pending 的版本；冻结返回时若 pending 已被改写则不得继续；
    //   · `phase`      —— `prepared`（未落盘）/ `committed`（已落盘、已派发）。
    // 三者缺一，都会让“冻结返回后到底是哪一个任务”重新变成不可回答。
    if (rec.prepare) {
      throw contractError(
        `cell "${rec.spec.cell_id}" is already preparing task "${rec.prepare.task_id}" `
        + `(phase=${rec.prepare.phase}); v0 runs one task at a time`,
        'cell_busy');
    }
    if (rec.activeTask) {
      throw contractError(
        `cell "${rec.spec.cell_id}" is already executing task "${rec.activeTask.task_id}"; v0 runs one task at a time`,
        'cell_not_ready');
    }
    // 还有旧异步链没停下时，绝不能开始新任务 —— 否则两段执行同时在跑，
    // "哪个任务写了这个文件"重新变成不可回答。draining 就是为这条不变式存在的状态。
    if (rec.inflight > 0) {
      throw contractError(
        `cell "${rec.spec.cell_id}" is draining (${rec.inflight} previous run(s) still alive); `
        + 'refusing to start a new task until the revoked execution is quiesced',
        'cell_not_ready');
    }
    // 同一道门存续断言放在执行入口（accept 之后门仍可能被摘掉）：见 `_ensureGate`。
    this._ensureGate(core, rec, 'execute a task');
    const pre = rec.state;
    assertTransition(pre, 'busy');

    const token = randomUUID();
    // epoch 在**占位时**就分配：冻结期间旧链的迟到调用必须已经能被判为“属于上一代”，
    // 而不是等冻结回来才提水位 —— 那个窗口里“旧链还有权”是真的。
    const epoch = ++rec.epoch;
    rec.prepare = {
      token,
      task_id: t.task_id,
      attempt: t.attempt,
      phase: 'prepared',
      pendingRev: rec.pendingRev || 0,
      startedAt: Date.now(),
    };
    // 预启动阶段的故障必须**回滚到原状**。回滚的范围是**这一次准备动过的全部内存真值**：
    // 占位记录、activeTask、inflight、运行态。少回一样，“已经抛错”与“Cell 还卡着”就会同时为真。
    //
    // 边界（诚实）：它只适用于**提交点之前**。一旦 `_persist` 成功（见下面的提交点），
    // 就不能再调它 —— 那时任务已经落盘、票据可能已发出，回滚是伪装，不是修正。
    const rollbackPrepare = (reason, epochAt = null) => {
      if (rec.prepare?.token !== token) return false;
      rec.prepare = null;
      rec.prepareFailure = reason || null;
      if (epochAt != null && rec.activeTask?.epoch === epochAt) rec.activeTask = null;
      if (epochAt != null && rec.inflight > 0) rec.inflight--;
      if (rec.state === 'busy') rec.state = pre;
      return true;
    };

    // CTX-3（PR-1）：**冻结认知配置**，位置在占位之后、提交之前。
    //
    // 两个判断都在这里：
    //   · 必须在**任何持久状态改变之前** —— 冻结读文件，可能失败（profile 被删、内容漂移、
    //     系统提示词越界）。失败必须让 Cell 保持原状态，不能留下一个"busy 但永远不跑"的壳。
    //   · 必须在**执行开始之前**而不是 accept —— `accept()` 是同步 API（30+ 调用方依赖它
    //     同步抛错），而冻结需要读盘。把它塞进 accept 就得把 accept 改成 async，
    //     那是一次静默的签名破坏：现有 `try { svc.accept(...) } catch` 会**捕不到**异步拒绝。
    //
    // 没有 cell-context 服务、或这个 Cell 没绑 profile ⇒ null ⇒ haotian-lite 走原来的
    // `agent.systemPrompt` 路径，既有部署行为不变。
    const ctxSvc = core.getService?.('cell-context');
    let frozenCtx = rec.pending?.frozenContext || null;
    if (!frozenCtx && ctxSvc?.freezeForTask) {
      try {
        // accept 时钉住的版本优先（见 accept 的 CTX-3 说明）。没有钉住（旧调用方直接 execute）
        // 就按当前绑定冻结 —— 那仍然是一个确定的版本，只是"版本"取的是执行时刻。
        frozenCtx = await ctxSvc.freezeForTask(
          rec.spec.cell_id, t.task_id, rec.incarnationId, rec.pending?.frozenBinding || null);
      } catch (err) {
        // 冻结失败：状态没变过、没有副作用 ⇒ 安全重试（第二次 execute 必须能跑）。
        rollbackPrepare('context_freeze_failed');
        throw err;
      }
      // **compare-and-commit**：冻结期间可能发生了别的 accept / close / 重装。
      // 只有同一张令牌、同一个 pending 版本、且 Cell 仍是我们当初看到的那个状态，才继续。
      // 不比令牌的话，“A 冻结返回时 B 已经就位”会让 A 用 B 的 pending 继续跑（旧版的形状）。
      const why = this._prepareStillValid(rec, token, pre);
      if (why) {
        rollbackPrepare(why);
        throw contractError(
          `cell "${rec.spec.cell_id}" prepare for task "${t.task_id}" was invalidated while freezing `
          + `the context profile (${why}); refusing to continue with another task's snapshot`,
          'cell_not_ready');
      }
      if (frozenCtx && rec.pending) rec.pending.frozenContext = frozenCtx;
    } else {
      // 不走冻结也要过同一道 compare-and-commit：没有 await 不代表没人改过它。
      const why = this._prepareStillValid(rec, token, pre);
      if (why) {
        rollbackPrepare(why);
        throw contractError(`cell "${rec.spec.cell_id}" prepare was invalidated (${why})`, 'cell_not_ready');
      }
    }
    rec.state = 'busy';
    // 每次执行拿一个新的 epoch（已在占位时分配）。撤销是"把 revokedEpoch 提到当前 epoch"，
    // 与 activeTask 无关：清空 activeTask 不会让旧 epoch 重新变合法。
    rec.activeTask = { task_id: t.task_id, attempt: t.attempt, startedAt: Date.now(), effective: rec.pending.effective, epoch };
    // 在飞计数在**提交点之前**就要加上：它回答的是“这个 Cell 上还有没有一段执行没真正停下”、
    // 而不是“它有没有落盘”。落盘失败的回滚分支会把它减回去（见下）。
    rec.inflight++;
    rec.prepare.phase = 'committing';
    // ── **提交点**（rc.32 / RC31-A2）──────────────────────────────────────
    // `_persist` 是“这个任务已经存在”的第一条持久证据，也是**预启动与执行中的分界**：
    // 它成功之前，没有任何外部副作用，失败可以完整回滚（不谎称 busy）；
    // 它成功之后，任务已落盘、票据可能已经发出，失败只能往“可恢复/不确定”走，
    // 不允许伪装成“从没开始过”。两条分支目的相反，不能共用一个 catch。
    try {
      await this._persist(core, rec);
    } catch (err) {
      // 预启动失败：撤回内存里的槽位/在飞计数/运行态，让下一次 execute 能真的重试。
      // 磁盘上要么是旧值要么是本次完整值（tmp+rename），所以不需要补偿落盘。
      const rolled = rollbackPrepare('prestart_persist_failed', epoch);
      this._noteRunsState(core, rec, { phase: 'prestart_persist_failed', rolled });
      throw err;
    }
    rec.prepare.phase = 'committed';

    const t0 = Date.now();
    const budget = rec.pending.budget;
    const stepsBefore = rec.stepsUsed || 0;
    let executionState = 'succeeded';
    let error = null;
    let reply = null;

    // 预算真执行（步骤）：Cell 的每一步模型/工具循环都经 chat.handle 的 `agent.step` 事件计数，
    // 不是事后估算（事后算出来的"用了几步"没有任何约束力）。
    const stepCounter = { n: 0 };
    const onStep = (evt) => {
      // `agent.step` 是**进程级**事件，必须按会话过滤：无差别计数会把别的会话
      // （网关上的普通对话）的步数算进本 Cell 的预算，让只走 1 步的任务被判 `budget_exhausted`。
      const sid = evt?.sessionId ?? null;
      if (sid !== null && sid !== rec.sessionId) return;
      stepCounter.n++;
    };
    core.on?.('agent.step', onStep);
    const retain = core.getService?.('workspace')?.retain?.(rec.sessionId);
    // `inflight` 必须在**真实对话链**结束时递减，而不是在 Promise.race 结束时：
    // 超时让 race 先返回，但底层 chat.handle 还要再跑；此时若认为"已静默"，
    // draining 会被立刻放回 ready，旧链仍在跑。
    let runPromise = null;
    let quiesced = false;
    const markQuiesced = () => { if (!quiesced) { quiesced = true; this._markQuiesced(rec); } };
    // 生效能力钉进执行链：门是常驻的，这里只更新它读的那个集合 ——
    // 安装/拆除的时机由 create/close 决定，不由单次 execute 决定。
    rec.gateAllowed = new Set(rec.pending.effective);
    // CTX-4（PR-1）：把刚冻结的认知快照挂到本 Cell 的会话上，直到这条执行链结束。
    //
    // 作用域按**会话**而不是按 Cell 挂：haotian-lite 只拿得到 sessionId，让它去猜 cell_id
    // 等于把"我是谁"交给调用方。挂上之后 haotian-lite 用它取系统提示词；不挂就走旧路径。
    // 退出放在 `runPromise` settle 之后（不是 finally），与 quiesce 同一口径 ——
    // 提前摘掉会让一条仍在跑的旧链在收尾阶段退回宿主默认身份。
    if (ctxSvc?.enterExecution && frozenCtx) ctxSvc.enterExecution(rec.sessionId, frozenCtx);
    try {
      const chat = core.getService?.('tool-executor');   // 仅用于确认执行链存在（能力判定见下）
      void chat;
      if (!(await core.hasCapability?.('chat.handle'))) {
        throw contractError('this assembly has no chat.handle; a cell cannot execute tasks without an agent loop', 'cell_not_ready');
      }
      const result = await this._runWithBudget(core, rec, t, budget, () => {
        // **任务执行票据在这里签发**（rc.31 / K30-01）：`epoch` 刚分配、`activeTask` 刚占位，
        // 从这一行开始整条 agent 循环（含它在 `chat.handle` 里安排的延迟回调）都带着同一张票。
        // 票据内容全部来自 CellRuntime 自己的登记记录，**不接受任何外部参数**：
        // 模型给的 `args`、调用方给的 `sessionId` 都无法构造它 —— 那正是它可作凭据的原因。
        runPromise = runInTaskContext({
          cellId: rec.spec.cell_id,
          sessionId: rec.sessionId,
          incarnationId: rec.incarnationId,
          epoch,
          taskId: t.task_id,
          attempt: t.attempt,
        }, () => core.command('chat.handle', { message: t.goal, sessionId: rec.sessionId }, this._chatTimeout(budget)));
        // 无论 race 谁赢，只要这条链自己 settle 了，就记一次"少一条在飞链"（重复调用由 quiesced 去抖）。
        // CTX-4：认知作用域与在飞计数**同源**收尾 —— 两者都表示"这条链不再产出新动作"。
        // 分开写就会出现"工具已被撤销、但 context.pull 还能读到东西"的窗口。
        runPromise.then(() => {
          if (ctxSvc?.exitExecution) { try { ctxSvc.exitExecution(rec.sessionId); } catch { /* 摘除失败不影响撤销 */ } }
          markQuiesced();
        }, () => {
          if (ctxSvc?.exitExecution) { try { ctxSvc.exitExecution(rec.sessionId); } catch { /* 同上 */ } }
          markQuiesced();
        });
        return runPromise;
      }, stepCounter);
      reply = result?.payload?.reply ?? null;
      if (!result?.ok) {
        // `state === 'denied'` 必须是 `rejected`，不是 `failed`：
        // failed = 执行了但没成功；rejected = **压根没被执行**。
        // "能力被冻结/身份不通过/越界"这些**从未发生副作用**的拒绝若记成"执行失败"，
        // 上层会据此重试一个必然再被拒的调用。
        // denied 的来源见 core `CAPABILITY_CODE_STATE`（capability_frozen / capability_denied /
        // out_of_bounds / invalid_session_id），全部是"拒绝执行"而非"执行出错"。
        executionState = result?.state === 'denied' ? 'rejected'
          : (result?.code === 'timeout_no_abort' ? 'timed_out' : 'failed');
        error = result?.error || 'chat.handle failed';
      }
      // 预算超限（步骤）：如实标失败，不把"跑超了但看起来完成了"当成功
      if (budget.max_steps != null && stepCounter.n > budget.max_steps) {
        executionState = 'failed';
        error = `budget_exhausted: used ${stepCounter.n} steps, limit ${budget.max_steps}`;
      }
    } catch (err) {
      // budget_exhausted 必须按耗尽维度分开，不能一律标 `timed_out`：
      // 墙钟没到点就不是超时 —— 把"步数用尽"叫超时，会让上层以为环境慢、去调大超时重试，
      // 而真正的处置是缩小任务或提高步数上限。
      //   · 墙钟到点 ⇒ `timed_out`（任务可能做对了一半，副作用未回滚）；
      //   · 步数用尽 ⇒ `failed`（预算被跑穿，是任务形态问题，不是等得不够久）。
      // `rejected` 只用于"这个任务根本不该被执行"（能力/装配不足）。
      if (err?.code === 'budget_exhausted') executionState = err?.kind === 'steps' ? 'failed' : 'timed_out';
      else if (err?.code === 'cell_not_ready') executionState = 'rejected';
      else executionState = 'failed';
      error = err?.message ? String(err.message) : String(err);
    } finally {
      core.off?.('agent.step', onStep);
      if (typeof retain === 'function') retain();
      // 链没被启动（例如缺 chat.handle）时也要把在飞计数还回去，否则 Cell 会永远停在 draining。
      // CTX-4：同一处摘掉认知作用域 —— 没有 runPromise 就说明根本没有在跑的链。
      if (!runPromise) {
        if (ctxSvc?.exitExecution) { try { ctxSvc.exitExecution(rec.sessionId); } catch { /* 摘除失败不影响撤销 */ } }
        markQuiesced();
      }
    }
    const wallMs = Date.now() - t0;

    // 产物与证据：**只认工作区里真实存在、可哈希的文件**（自报路径不算证据）
    const wsReal = this._workspaceOf(core, rec);
    const artifacts = [];
    const evidence = [];
    for (const rel of t.acceptance.required_artifacts) {
      let abs;
      try {
        // 产物路径必须走**同一个**真实路径判据（见 _resolveArtifact）。
        abs = await this._resolveArtifact(wsReal, rel);
      } catch (err) {
        executionState = executionState === 'succeeded' ? 'failed' : executionState;
        error = error || `${err.code || 'artifact_rejected'}: ${rel} (${err.message})`;
        continue;
      }
      try {
        const buf = await readFile(abs);
        artifacts.push({ path: rel, sha256: sha256Hex(buf), bytes: buf.length });
      } catch (err) {
        // 缺产物本身就是**执行不完整**的证据。注意：这只把它标成 failed，
        // "验收是否通过"仍由独立验收器判（见 verify()）。
        if (executionState === 'succeeded') {
          executionState = 'failed';
          error = `missing required artifact: ${rel} (${err.code || err.message})`;
        }
      }
    }

    // 这段执行若在跑的过程中被撤销（close(force) 或墙钟超时），**不得**对外宣称它成功
    // 提交了 —— 它产生的副作用没有任何机制能划定边界。`unknown` 就是合同里为这件事保留的状态。
    if (rec.revokedEpoch >= epoch && executionState === 'succeeded') {
      executionState = 'unknown';
      error = `execution_revoked: ${rec.revokeReason || 'the run was revoked'}; side effects are indeterminate`;
    }


    const usage = { steps: Math.max(stepCounter.n, 0), model_calls: null, wall_ms: wallMs };
    const result = {
      schema_version: 'tusunsun.result/v0',
      task_id: t.task_id,
      attempt: t.attempt,
      cell_id: rec.spec.cell_id,
      incarnation_id: rec.incarnationId,
      execution_state: executionState,
      artifacts,
      evidence,
      usage,
      error,
      _reply: reply,           // 仅进程内可见（不落盘、不进 WorkResult 的对外形状）
    };

    rec.stepsUsed = stepsBefore + stepCounter.n;
    // **执行结束 ≠ 任务已结算**（rc.33 / R32-02）。执行结束只说明“干了什么”定了；结算
    // （追加结果行 → 落状态 → 播事件）还没做。修前的形状在这里就交还占位、把状态推回 ready，
    // 于是 A 还在结算时 accept(B) 已经成功、B 也跑完了：`results.jsonl` 里是 B,A，而
    // `report().last_result` 最终又变回 A —— 晚结算的那一笔覆盖了“最后一个任务”。
    // 现在：占位**留到结算完成**，整个结算窗口里 accept/execute 都拿得到具名拒绝。
    rec.activeTask = null;
    if (rec.prepare?.token === token) rec.prepare.phase = 'settling';
    // 超时/撤销的执行**不得**一路回到 ready —— 那会让第二个任务直接开始，而旧链还在跑。
    // 仍有在飞链（inflight>0）或本执行已被撤销 ⇒ 停在 draining，等静默后由 _markQuiesced 放回。
    const revoked = rec.revokedEpoch >= epoch;
    if (revoked || rec.inflight > 0) rec.drainByTimeout = true;
    // 交还占位与运行态的**唯一出口**：成功、失败、未结算、被 close(force) 打断，全走这里。
    // 少写一处就是“Cell 永久 busy”，所以它是 finally，而不是若干处 await 之后的顺手一行。
    // **不能**把已经不在手里的状态改回去：执行中途 `close(force)` 若在这里无条件写成 ready，
    // `stopped` 就会被执行流程自己推翻，那个 Cell 还能继续接任务。只有 busy 才回落。
    const computeFinalState = () => {
      if (rec.state === 'busy') rec.state = (revoked || rec.inflight > 0) ? 'draining' : 'ready';
      else if (rec.state === 'ready' && (revoked || rec.inflight > 0)) rec.state = 'draining';
    };
    const releasePrepare = () => { if (rec.prepare?.token === token) rec.prepare = null; };
    // “算状态”和“交还占位”是两件事，必须能分开调用：落盘要写**最终**状态，而占位要一直握到落盘
    // 之后。合成一个函数就会出现“占位还握着、盘上却已经把 busy 写死了”的中间态。
    const settleWindowDone = () => { releasePrepare(); computeFinalState(); };
    try {
      // ── **结算**（rc.32 / RC31-B1）：执行事实 / 持久证据 / 对外回执是三件事 ────────
      //
      // 修前的形状：先清 activeTask、先回 ready、先写 `lastResult`，然后 `await _appendResult` +
      // `await _persist`。追加一抛，调用方只收到错误，而内部已经有一个“本轮成功”的结果、
      // 下一个任务也已经被接下 —— 实测：`execute` 抛 EIO、Cell ready、`accept(B)` 成功，
      // 而 A 的 results.jsonl 里没有这一笔。三件事没有一个可以对齐的结算。
      //
      // 现在分两个字段回答两个问题：
      //   · `execution_outcome` —— 这趟活到底干成了什么（不因写证据失败而被删除）；
      //   · `durability_outcome` —— 它有没有变成可核对的持久记录（不因执行成功就被假定为有）。
      // 两者都进 WorkResult，也进 `cell.task.finished`。调用方必须分别看，不能拿一个推另一个。
      let durability = { state: 'persisted', attempts: 0, error: null };
      const recordId = `${rec.incarnationId}:${t.task_id}#${t.attempt}`;
      // 结果行带上**记录身份**：重启重放时“这一笔是哪一个任务”不靠行位置猜。
      const durableResult = { ...stripPrivate(result), record_id: recordId };
      for (let attempt = 1; attempt <= RESULT_APPEND_ATTEMPTS; attempt++) {
        durability.attempts = attempt;
        // **重试前先问盘上有没有**（rc.33 / R32-04）：上一次“失败”可能只是确认丢了
        // （写成功、返回 EIO）。不看盘就再写一次，一次执行会变成两条完成记录。
        if (attempt > 1 && await this._hasResultRecord(core, rec, recordId)) {
          durability = { state: 'persisted', attempts: attempt, error: null, recovered: 'readback' };
          break;
        }
        try {
          await this._appendResult(core, rec, durableResult);
          durability = { state: 'persisted', attempts: attempt, error: null };
          break;
        } catch (err) {
          durability = { state: 'evidence_unavailable', attempts: attempt, error: err?.code || err?.message || String(err) };
          // 只在有界预算内重试：无限重试会让一次执行永远“没结束”，而不重试会让瞬态错误
          // 变成永久缺证据。两者都不得冒充成功。
          // 定时器**不得 unref**：这个 Promise 正在被 await，放开引用会让进程在“还有一笔
          // 结算没做完”的时候直接退出（实测：顶层 await 永不 settle，进程静默结束）。
          if (attempt < RESULT_APPEND_ATTEMPTS) await new Promise((r) => { setTimeout(r, 10 * attempt); });
        }
      }
      if (durability.state !== 'persisted') {
        // 写证据失败**不是**执行失败：真实副作用已经发生，把它报成 failed 等于删掉历史。
        // 但也不能当可信交付：对外必须说出“这次没有持久回执”。
        //
        // **不得被下一个任务静默覆盖**（专家 §3 的“避免覆盖未结算状态”）：`rec.lastResult` 很快
        // 会被下一笔取代，所以这里另外留一份**有界**的未结算清单。
        // 诚实边界：它只在内存里 —— 重启就没了。所以它**不能**被当作持久证据；
        // 它的全部作用是“不要让这一笔在进程内凭空消失”，并让 `describe`/`report` 能报出来。
        rec.unsettled = [...(rec.unsettled || []), {
          record_id: recordId, task_id: t.task_id, attempt: t.attempt,
          execution_state: executionState, durability_outcome: durability,
          at: new Date().toISOString(),
        }].slice(-UNSETTLED_MAX);
        rec.lastResult = { ...durableResult, durability_outcome: durability };
        // 结算失败也要让**盘上的状态**跟上内存：否则下一次启动读到的是“永远在飞”，
        // 把一个其实已经跑完（只是没留下回执）的执行收敛成 `faulted`。落盘本身再失败就算了 ——
        // 这一条的结论（没有持久回执）不因它改变。
        computeFinalState();
        try { await this._persist(core, rec); } catch { /* 状态落盘也失败：不改写本条结论 */ }
        const e = contractError(
          `evidence_unavailable: task "${t.task_id}#${t.attempt}" finished with execution_state="${executionState}" `
          + `but its result record could not be written (${durability.error} after ${durability.attempts} attempt(s)). `
          + 'The execution happened; the durable receipt for it does not exist. Do not treat this run as reliably delivered.',
          'evidence_unavailable');
        e.execution_outcome = { state: executionState, error };
        e.durability_outcome = durability;
        e.result = { ...durableResult, durability_outcome: durability };
        // 不播 `cell.task.finished`（它宣告的是“已结算”），改播一条**未结算**的事实：
        // 两者混用会让下游把“有事件”读成“已落盘”。
        try {
          core.emit?.('cell.task.unsettled', {
            cell_id: rec.spec.cell_id, task_id: t.task_id, attempt: t.attempt, record_id: recordId,
            execution_state: executionState, durability_outcome: durability,
            timestamp: new Date().toISOString(), sourcePlugin: 'cell-runtime',
          });
        } catch { /* 观测不得改写“未结算”这个结论 */ }
        throw e;
      }
      // 持久证据已到。现在才把“已结算”写进状态：状态落盘同样可能失败，**它也不等于**结果丢 ——
      // 结果行已经在盘上，重启之后 `results.jsonl` 能回答“刚才发生了什么”。
      // 结果行已落盘。**先算出最终状态，再落盘**：这一行写的必须是“结算完之后 Cell 是什么样”，
      // 而不是“结算途中还是 busy”—— 写 busy 会让一次**成功**的执行在重启后收敛成 `faulted`
      // （实测 CTX-E03：干净跑完的任务，重启后 `cannot accept tasks`）。
      // 占位仍握在手里（到这里为止 accept/execute 仍被拒），落盘完成才由 finally 交还。
      computeFinalState();
      let statePersisted = true;
      try {
        await this._persist(core, rec);
      } catch (err) {
        statePersisted = false;
        durability = { ...durability, state_persist_error: err?.code || err?.message || String(err) };
        core.log?.('warn', `[cell] ${rec.spec.cell_id}: 结果已落盘但 Cell 状态未落盘（${durability.state_persist_error}）；`
          + '重启后会按“上一世在飞”收敛，结果行仍可查');
      }
      rec.lastResult = { ...durableResult, durability_outcome: durability, state_persisted: statePersisted };
      core.emit?.('cell.task.finished', {
        cell_id: rec.spec.cell_id, task_id: t.task_id, attempt: t.attempt, record_id: recordId,
        execution_state: executionState, durability_outcome: durability, state_persisted: statePersisted,
        timestamp: new Date().toISOString(), sourcePlugin: 'cell-runtime',
      });
      // 返回值必须保留 `_reply`：它不进落盘、不进 WorkResult 对外形状，但**调用方要读它**
      // （测试与网关靠它回答“模型看到了什么拒绝”）。把 `durableResult`（已剥离）当返回值
      // 会让每一个下游只在“成功路径上有 reply”这件事静默失效。
      return { ...result, ...durableResult, durability_outcome: durability, state_persisted: statePersisted };
    } finally {
      // 退出顺序是合同的一部分：先交还占位与运行态，再让 Promise 结算给调用方 ——
      // 调用方 await 到的那一刻，这个 Cell 已经回到可以被 accept 的状态（或如实地停在 draining）。
      settleWindowDone();
    }
  }

  _chatTimeout(budget) {
    const wall = budget?.wall_ms;
    // 给内核命令的超时**略大于**预算，让"预算超时"由我们自己判并如实标 timed_out；
    // 否则内核先超时，我们只看到 timeout_no_abort，说不出到底是哪一层超的。
    return Number.isInteger(wall) ? wall + 5000 : 10 * 60 * 1000;
  }

  /** 预算真执行：wall_ms 到期即返回 timed_out，并**如实**说明副作用未被中断。 */
  async _runWithBudget(core, rec, task, budget, run, stepCounter) {
    if (!Number.isInteger(budget?.wall_ms)) return run();
    let timer = null;
    const timeout = new Promise((res) => {
      timer = setTimeout(() => res({ __budgetTimeout: true }), budget.wall_ms);
    });
    try {
      const out = await Promise.race([run(), timeout]);
      if (out && out.__budgetTimeout) {
        // 墙钟到点**必须同时撤销执行资格**，而不只是让 Promise.race 失败：
        // 只结束 race 的话，仍在跑的对话链继续拿到工具权限 —— 超时后迟到的 tool-write
        // 照样写盘，即使 Cell 只授予了 tool.read 且 permission_mode=read-only。
        this._revokeExecution(rec, `wall_ms ${budget.wall_ms} elapsed`);
        const e = contractError(
          `budget_exhausted: wall_ms ${budget.wall_ms} elapsed; the agent loop was abandoned and its execution `
          + 'credential revoked. Tool calls from that run are now refused, but side effects already performed are '
          + 'NOT rolled back (this build cannot interrupt a running tool)',
          'budget_exhausted');
        e.kind = 'wall';
        throw e;
      }
      if (budget.max_steps != null && stepCounter.n > budget.max_steps) {
        const e = contractError(`budget_exhausted: steps ${stepCounter.n} > ${budget.max_steps}`, 'budget_exhausted');
        e.kind = 'steps';
        throw e;
      }
      return out;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * “这个 Cell 现在的真实工作区” —— 执行产物收集与验收复核**必须用同一个值**。
   *
   * 必须用同一个值：分别写 `root() || spec.workspace` 时，`root()` 在绑定被释放后会回落到
   * 进程默认根（见 describe 的注释）。于是 `close()` 之后再做一次 `verify()`，复核的是默认根
   * 里的同名文件 —— 要么 `inconclusive`，要么读到一个**恰好同名**的文件并给出结论。
   */
  _workspaceOf(core, rec) {
    const fallback = rec.workspaceReal || rec.spec.workspace;
    const ws = core.getService?.('workspace');
    try {
      const st = ws?.status?.(rec.sessionId);
      if (st === 'bound' || st === 'unavailable') return ws.root(rec.sessionId) || fallback;
    } catch { /* 不可用：退回快照 */ }
    return fallback;
  }

  /**
   * 一条执行链真正结束（或确认已停）时调用 —— 递减在飞计数并唤醒等待者。
   *
   * "静默"（quiesced）的定义刻意保守：本运行时里能发工具调用的只有 `chat.handle` 这一段
   * Promise，它 settle 了就认为这条链不再产生新副作用。这不是通用异步取消框架，
   * 也不假装能证明进程外的东西已经停下 —— 那是独立进程模式才有的能力（见 W1 的说明）。
   */
  _markQuiesced(rec) {
    if (rec.inflight > 0) rec.inflight--;
    if (rec.inflight > 0) return;
    // 旧链确实停了：若 Cell 因为"超时、旧链未停"而停在 draining，现在可以放回 ready。
    // 只认 execute 自己造成的 draining（`drainByTimeout`）——close 造成的 stopped 不能被这里推翻。
    if (rec.state === 'draining' && rec.drainByTimeout) {
      rec.state = 'ready';
      rec.drainByTimeout = false;
      rec.revokeReason = null;
      // 未撤销 = 恢复了执行资格；撤销水位保持不变（下一 epoch 仍会比它大）。
      rec.revokedEpoch = -1;
    }
    const waiters = rec.quiesceWaiters || [];
    rec.quiesceWaiters = [];
    for (const w of waiters) { try { w(); } catch { /* 唤醒失败无关紧要 */ } }
  }

  /**
   * **compare-and-commit**：冻结（唯一的 await）返回后，这一次准备还能不能继续。
   *
   * 返回 null = 可以继续；返回一个字符串 = 不能继续的具名原因。
   * 判据全部来自**登记记录**，不来自调用方参数 —— 调用方无法“声明自己仍然是那个任务”。
   *
   * 四个判据各屏蔽一种已被实测的形状：
   *   · `prepare_superseded`：占位已被另一次准备顶掉（并发 execute）；
   *   · `pending_changed`：pending 版本变了（冻结期间被 accept 改写 ⇒ 不能用别人的能力集）；
   *   · `cell_no_longer_available`：Cell 在冻结期间被 close/停止（不能“关完了继续拿权”）；
   *   · `state_drifted`：状态被外部改到不是我们当初看到的那一个（faulted 等）。
   */
  _prepareStillValid(rec, token, pre) {
    if (rec.prepare?.token !== token) return 'prepare_superseded';
    if ((rec.pendingRev || 0) !== rec.prepare.pendingRev) return 'pending_changed';
    if (rec.state === 'stopped' || rec.state === 'faulted') return 'cell_no_longer_available';
    if (rec.state !== pre) return 'state_drifted';
    return null;
  }

  /**
   * 把“一次执行预启动失败的补偿”记成可审计事实，而不是只活在返回值里。
   * 事件是**降级观测**：抛出仍然以错误为准；这里只保证“发生了什么”事后能查到。
   */
  _noteRunsState(core, rec, detail) {
    try {
      core?.emit?.('cell.task.prestart_failed', {
        cell_id: rec.spec.cell_id,
        ...detail,
        timestamp: new Date().toISOString(),
        sourcePlugin: 'cell-runtime',
      });
    } catch { /* 观测不得影响“失败已经发生”这件事本身 */ }
  }


  /**
   * 等到 `rec.inflight` 归零（有界）。返回 true = 已静默，false = 有界等待内仍未停。
   * 故意**不**无界等待：真实调用方（网关/CLI）不能因为一条卡死的链而永久挂住。
   */
  async _awaitQuiesce(rec, timeoutMs = 5000) {
    if (rec.inflight <= 0) return true;
    await new Promise((res) => {
      const timer = setTimeout(res, timeoutMs);
      if (timer.unref) timer.unref();
      rec.quiesceWaiters.push(() => { clearTimeout(timer); res(); });
    });
    return rec.inflight <= 0;
  }

  /**
   * 把 Task 里声明的产物路径解析为**真实位于工作区内**的绝对路径。
   *
   * 词法包含判断（`resolve()` + `startsWith`）不够：随后 `stat()`/`readFile()` 会**跟随
   * 符号链接**，工作区里 `report.txt -> /outside/external-secret.txt` 会被读穿，
   * 中间目录符号链接（`sub/ -> /outside`）同样通过。
   *
   * 复用工具层那**唯一一份**判据 `resolveWorkspacePath`（它处理了"目标不存在时取最近
   * 已存在祖先求真实路径"），末级与中间目录的符号链接都会被追到真实位置再判包含。
   *
   * 边界（诚实）：
   *   · 这是信任边界不是沙箱，`realpath` 与随后的 `readFile` 之间仍有 TOCTOU 窗口
   *     （同一用户下的本地攻击者）—— 这里的处置是"判完立刻读"，不额外声称原子性；
   *   · hash 一致只能证明"此刻内容与记录相同"，**不能**单独证明它由本次 Task 亲自创建。
   *     来源认证需要执行前后快照，不在这一轮的范围里（README/RFC 已按此措辞收敛）。
   */
  async _resolveArtifact(wsReal, rel) {
    const { resolveWorkspacePath } = await import('./tools/lib/workspace.mjs');
    return resolveWorkspacePath(wsReal, String(rel));
  }

  // ── verify（独立验收） ───────────────────────────────────────────────
  /**
   * 独立验收：**执行状态 ≠ 验收结论**。
   *
   * 规则（首版刻意保守）：
   *   · 执行没成功 ⇒ `rejected`（没有可验收的交付物）；
   *   · 产物 hash/大小与落盘记录不一致 ⇒ `inconclusive`（证据被替换过或读错了）；
   *   · `acceptance.checks` 里的命令**不执行**：v0 不在验收里跑任意 shell
   *     （那等于把"模型生成的命令"当验收器）。它们只作为"要求"记录在案，
   *     真正的判定是产物齐备 + 执行状态。要跑测试请显式调用外部脚本 —— 见 README。
   */
  async verify(core, reg, cellId, task, opts = {}) {
    const rec = reg.cells.get(String(cellId));
    if (!rec) throw contractError(`unknown cell: ${cellId}`, 'unknown_cell');
    const source = task || rec.lastTask;
    if (!source) throw contractError('no task to verify: pass a TaskEnvelope or accept() one first', 'task_rejected');
    const t = validateTaskEnvelope(source);
    const res = rec.lastResult;
    const { makeAcceptanceDecision } = await import('./_lib/cell/contract.js');
    if (!res || res.task_id !== t.task_id || res.attempt !== t.attempt) {
      return makeAcceptanceDecision({
        decision: 'rejected', task_id: t.task_id, attempt: t.attempt,
        reason: 'no result recorded for this task/attempt', by: opts.by || 'local-acceptor',
      });
    }
    if (res.execution_state !== 'succeeded') {
      return makeAcceptanceDecision({
        decision: 'rejected', task_id: t.task_id, attempt: t.attempt,
        reason: `execution_state=${res.execution_state}${res.error ? `（${res.error}）` : ''}`,
        by: opts.by || 'local-acceptor',
      });
    }
    // 产物复核：记录里的 hash 必须与磁盘现状一致（防止"结果落盘后文件被换掉"）
    const wsReal = this._workspaceOf(core, rec);
    const checked = [];
    for (const a of res.artifacts) {
      // 复核也用**同一个**真实路径判据：只用词法 `isInside` 的话，
      // "记录时是普通文件、复核时已被换成指向工作区外的符号链接"会被读穿并通过。
      let abs;
      try {
        abs = await this._resolveArtifact(wsReal, a.path);
      } catch (err) {
        return makeAcceptanceDecision({
          decision: 'inconclusive', task_id: t.task_id, attempt: t.attempt,
          reason: `artifact path escapes workspace: ${a.path} (${err.message})`, by: opts.by || 'local-acceptor',
        });
      }
      let buf;
      try { buf = await readFile(abs); } catch (err) {
        return makeAcceptanceDecision({ decision: 'inconclusive', task_id: t.task_id, attempt: t.attempt, reason: `artifact unreadable: ${a.path} (${err.code || err.message})`, by: opts.by || 'local-acceptor' });
      }
      if (sha256Hex(buf) !== a.sha256) {
        return makeAcceptanceDecision({ decision: 'inconclusive', task_id: t.task_id, attempt: t.attempt, reason: `artifact changed after the result was recorded: ${a.path}`, by: opts.by || 'local-acceptor' });
      }
      checked.push(a.path);
    }
    for (const need of t.acceptance.required_artifacts) {
      if (!res.artifacts.some((a) => a.path === need)) {
        return makeAcceptanceDecision({ decision: 'rejected', task_id: t.task_id, attempt: t.attempt, reason: `required artifact missing: ${need}`, by: opts.by || 'local-acceptor' });
      }
    }
    return makeAcceptanceDecision({
      decision: 'accepted', task_id: t.task_id, attempt: t.attempt,
      reason: `execution succeeded；${checked.length} artifact(s) hash-verified`, by: opts.by || 'local-acceptor', checked,
    });
  }

  /**
   * 读回 `results.jsonl` 并按 `record_id` **归并**（rc.33 / R32-04）。
   *
   * 为什么是“归并”而不是“去重写入”：普通 append 承诺不了物理 exactly-once（崩溃、确认丢失、
   * 跨进程追加都可能让同一笔出现两次）。能让消费方安全的那一层是**逻辑身份**：`record_id`
   * 是 `${incarnation_id}:${task_id}#${attempt}`，同一笔无论写几次都是同一个 id。
   * 所以行数不是完成次数，这里的 `records` 才是。
   *
   * 诚实边界：
   *   · 没有 `record_id` 的旧行（rc.32 之前写的）不参与归并 —— 给它补一个 id 就是造假；
   *   · 坏行/半行计入 `unreadable_lines`，**不**静默丢弃（否则“写坏了”和“没写过”长得一样）；
   *   · 同一 id 多行时保留最后一行的内容，但**不**宣称它更新 —— 它们本应是同一份事实。
   */
  async resultRecords(core, reg, cellId) {
    const rec = reg.cells.get(String(cellId));
    if (!rec) throw contractError(`unknown cell: ${cellId}`, 'unknown_cell');
    let raw = '';
    try { raw = await readFile(join(this._cellDir(core, rec.spec.cell_id), RESULT_FILE), 'utf8'); } catch (err) {
      if (err.code === 'ENOENT') {
        return { cell_id: rec.spec.cell_id, records: [], raw_lines: 0, duplicate_lines: 0, unreadable_lines: 0 };
      }
      throw err;
    }
    const lines = raw.split('\n').filter((l) => l.length > 0);
    const byId = new Map();
    let withId = 0;
    let unreadable = 0;
    let anonymous = 0;
    for (const line of lines) {
      let row = null;
      try { row = JSON.parse(line); } catch { unreadable++; continue; }   // 坏行单独计数，不静默丢
      const id = typeof row?.record_id === 'string' && row.record_id ? row.record_id : null;
      if (!id) { byId.set(`anon:${anonymous++}`, row); continue; }          // 旧行：保留但不归并
      withId++;
      byId.set(id, row);
    }
    return {
      cell_id: rec.spec.cell_id,
      records: [...byId.values()],
      raw_lines: lines.length,
      duplicate_lines: withId - (byId.size - anonymous),
      unreadable_lines: unreadable,
    };
  }

  // ── report / close ──────────────────────────────────────────────────
  report(reg, cellId) {
    const rec = reg.cells.get(String(cellId));
    if (!rec) throw contractError(`unknown cell: ${cellId}`, 'unknown_cell');
    return {
      cell: this.describe(reg.core, reg, String(cellId)),
      last_result: rec.lastResult ? stripPrivate(rec.lastResult) : null,
    };
  }

  /**
   * 门这项清理义务还剩什么 —— 判据是「执行器那边还数不数得到本 Cell 的门/回执/租约」。
   * 「没有 `dropGate` ⇔ 没有义务」把两件事混成一件：执行器缺席的纯对话 Cell（一条公开
   * 支持的路径）从来装不上门，于是永远欠着一项、永远关不完（R34-A）。反过来也不能糊：
   * **数得到残留就不能算清**，否则等于用伪 `closed:true` 把「钩子未撤」这件事盖住。
   * 三个答案：`dropped`（拆过门）/ `empty`（从来没有门）—— 后两个都必须核账为零才成立。
   */
  _gateObligation(core, rec) {
    const owner = `cell:${rec.spec.cell_id}`;
    if (typeof rec.dropGate === 'function') rec.dropGate();   // 幂等：按 owner 清族 + 放租约
    // 要核账的执行器：装过门的那一个（可能已被换下）＋此刻拿得到的那一个，两边都得干净。
    const execs = [...new Set([rec.gate?.executor, this._gateEligibility(core).exec].filter(Boolean))];
    if (execs.length === 0) return { cleared: true, how: rec.gate ? 'dropped' : 'empty' };
    let hooks = 0;
    let leases = 0;
    for (const exec of execs) {
      if (typeof exec.hookCountFor !== 'function') {
        return { cleared: false, why: 'the executor cannot count hooks (hookCountFor missing)' };
      }
      const c = exec.hookCountFor(owner) || {};
      hooks += (c.pre || 0) + (c.dispatch || 0) + (c.post || 0);
      leases += typeof exec.guardLeasesFor === 'function'
        ? exec.guardLeasesFor(rec.sessionId).filter((l) => l.owner === owner && l.live).length : 0;
    }
    if (hooks === 0 && leases === 0) return { cleared: true, how: rec.gate ? 'dropped' : 'empty' };
    return { cleared: false, why: `${hooks} hook(s)/${leases} lease(s) still live under ${owner}` };
  }

  /**
   * 关闭：状态迁移到 stopped，此后**不能再执行工具**（describe 会报 stopped，accept 会拒绝）。
   *
   * 三个事实，三个答案：①执行资格已撤销（立刻生效，`execution_revoked:true`）；②正在清理
   * （`closed:false, closing:true, cleanup_pending:[...]` + `cell.closing`）；③清理已完成
   * （`closed:true` + `cell.closed`，只在此发）。`closed` 与 `cleanup_done` 同源 —— 不进
   * 这一行，就不给那个结论。
   */
  async close(core, reg, cellId, opts = {}) {
    const rec = reg.cells.get(String(cellId));
    if (!rec) throw contractError(`unknown cell: ${cellId}`, 'unknown_cell');
    if (rec.cleanupDone === true) return this._alreadyClosed(rec);
    // **单飞**：「关完了」只有一个事实，所以「结算」只能有一条在飞的路径。并发到达的调用
    // **排到前一条后面**逐次结算，而不是各自拿同一张责任表各发一次完成事件 —— 后者会把
    // 同一次关闭发表两遍（P2-A）。排队而不是合并，是因为 force 不能被别人的非 force
    // 结算吞掉；轮到它时若已关完，它自然走 already，答案仍是它自己那一次询问。
    if (rec.closeChain) {
      const queued = rec.closeChain.then(
        () => this._closeSettlement(core, reg, rec, opts),
        () => this._closeSettlement(core, reg, rec, opts),
      );
      return this._trackCloseChain(rec, queued);
    }
    // 走直连（而不是再跳一次 then）：撤销与状态迁移必须在本轮同步段里就生效。
    return this._trackCloseChain(rec, this._closeSettlement(core, reg, rec, opts));
  }

  /** 记在飞的结算链；链尾自清，免得后续调用白白多等一跳微任务。 */
  _trackCloseChain(rec, run) {
    const chain = run.then(() => undefined, () => undefined);
    rec.closeChain = chain;
    chain.then(() => { if (rec.closeChain === chain) rec.closeChain = null; });
    return run;
  }

  /** 已经关完的答案：带可重放的关闭身份，供消费方按身份去重。 */
  _alreadyClosed(rec) {
    return {
      closed: true, closing: false, already: true, cell_id: rec.spec.cell_id, state: 'stopped',
      execution_revoked: true, cleanup_done: true, cleanup_pending: [],
      close_id: rec.closeId || null, closed_at: rec.closedAt || null, incarnation_id: rec.incarnationId,
    };
  }

  /** 一次关闭结算（只由 `close()` 排队调用，不在别处直达）。 */
  async _closeSettlement(core, reg, rec, opts = {}) {
    if (rec.cleanupDone === true) return this._alreadyClosed(rec);
    // **“已关闭”是清理完成，不是内存里一个字符串**（rc.33 / R32-03）。
    // 修前的形状：入口 `if (rec.state === 'stopped') return { already: true }`，而状态在
    // `await _persist()` **之前**就被写成 stopped —— 落盘一抛 EIO，第二次 close() 立刻回
    // “已关闭”，锁目录与工作区绑定全部留在原地，外部拿到一个错误的回执。
    if (rec.activeTask && !opts.force) {
      throw contractError(
        `cell "${rec.spec.cell_id}" is running task "${rec.activeTask.task_id}"; refusing to close `
        + '(its side effects would outlive the identity that produced them). Wait, or pass force.',
        'cell_busy');
    }
    // **准备期也算在跑**（rc.32 / RC31-A1）：`close()` 不能把一段正在冻结/即将派发的执行
    // 当成“空闲”。否则 close 之后冻结返回、compare-and-commit 才发现状态变了 ——
    // 那时候要么拒（白跑一趟），要么继续（在已关闭的 Cell 上派发）。这里同步清掉占位，
    // 让 `_prepareStillValid` 在上层具名失败。
    if (rec.prepare && !opts.force) {
      throw contractError(
        `cell "${rec.spec.cell_id}" is preparing task "${rec.prepare.task_id}" (phase=${rec.prepare.phase}); `
        + 'refusing to close while a task is being prepared (its gate could still be dispatched). Wait, or pass force.',
        'cell_busy');
    }
    rec.prepare = null;
    const from = rec.closeFrom || rec.state;
    rec.closeFrom = from;
    // 先**撤销执行资格**，再谈状态与解绑。顺序是有意义的 ——
    // 撤销必须在任何"看起来已经停下"的对外回报之前生效，否则报告与事实之间有一个窗口。
    this._revokeExecution(rec, opts.force ? 'cell closed (force)' : 'cell closed');
    if (rec.state !== 'stopped') {
      // draining 是合法中间态；直接从 busy/ready 到 stopped 也允许（close 是显式动作）
      if (rec.state === 'busy' && !opts.force) throw contractError('cell is busy; pass force to close anyway', 'cell_busy');
      if (rec.state !== 'draining') rec.state = 'draining';
      rec.state = 'stopped';
    }
    rec.activeTask = null;
    // **清理责任表**：每一项都可重试，只有真的做完才记 true。`already:true` 只在整张表都
    // 满足时才返回 —— “执行资格已撤销”与“清理已完成”是两件事，不能用一个 stopped 同时回答。
    const cleanup = rec.cleanup || (rec.cleanup = { persist: false, quiesce: false, workspace: false, gate: false, owner: false });
    const pending = () => Object.entries(cleanup).filter(([, v]) => !v).map(([k]) => k);
    // ① 落盘“已关闭”。先钉一个 `closed_at`：重试时用它**读回**判断上一次 rename 到底生效没有 ——
    // rename 前后模糊失败只能由盘上的事实回答，不能靠内存状态推断“应该写成功了”。
    if (!cleanup.persist) {
      rec.closedAt = rec.closedAt || new Date().toISOString();
      try {
        await this._persist(core, rec);
        cleanup.persist = true;
      } catch (err) {
        rec.closeError = err?.code || err?.message || String(err);
        const onDisk = await this._readCellState(core, rec.spec.cell_id).catch(() => null);
        cleanup.persist = Boolean(onDisk && onDisk.incarnation_id === rec.incarnationId && onDisk.closed_at === rec.closedAt);
        if (!cleanup.persist) {
          const e = contractError(
            `close_incomplete: cell "${rec.spec.cell_id}" had its execution eligibility revoked (state=stopped), `
            + `but the "closed" record could not be persisted (${rec.closeError}); cleanup has NOT completed. `
            + 'Call close() again to retry the remaining cleanup (persist / quiesce / workspace / gate / owner lock) — '
            + 'do not treat this cell as closed.',
            'close_incomplete');
          e.execution_revoked = true;
          e.cleanup_pending = pending();
          throw e;
        }
        core.log?.('warn', `[cell] ${rec.spec.cell_id}: close 落盘报错（${rec.closeError}），但读回确认 closed_at 已生效`);
      }
    }
    // ② 等旧异步链静默。不静默就不释放任何东西：宁可占一个绑定槽位，也不让迟到的写入落到错误目录。
    const quiesced = await this._awaitQuiesce(rec, opts.quiesceMs ?? 5000);
    cleanup.quiesce = quiesced;
    if (quiesced) {
      // 释放工作区绑定：Cell 结束，它的"工作身份"也就不该继续占着目录
      // （保留会占掉 256 的容量，而且没有主体会再用它）。
      try {
        await core.getService?.('workspace')?.release?.(rec.sessionId, { via: 'cell-close', force: true });
        cleanup.workspace = true;
      } catch { cleanup.workspace = false; }
    }
    // 关键：**只有确认静默之后**才拆门 —— 无条件拆会让"拆掉门"恰好发生在旧对话链还活着时，
    // 迟到的 tool-write 面前一条检查都不剩。没静默就留着门：它已经因为撤销而 fail-closed。
    // 义务的判据是「执行器那边还数不数得到本 Cell 的门/回执/租约」，不是「dropGate 是不是
    // 函数」：执行器缺席的纯对话 Cell 从来没有门可拆，按旧判据就永远欠着这一项（R34-A）。
    if (quiesced) {
      const g = this._gateObligation(core, rec);
      cleanup.gate = g.cleared;
      if (!g.cleared) core.log?.('warn', `[cell] ${rec.spec.cell_id}: 门未清干净（${g.why}），close 不当作完成`);
    }
    if (quiesced && !rec.stateDirOwner) cleanup.owner = true;
    // 属主锁只在**确认静默**之后才释放：旧链还在跑时放开锁，等于请第二个进程来插手一个
    // “看起来已经停了”的 stateDir。
    if (quiesced && rec.stateDirOwner) {
      let released = false;
      try { released = await rec.stateDirOwner.release(); } catch { released = false; }
      if (released) rec.stateDirOwner = null;
      cleanup.owner = released;             // 只有“锁真的被删掉”才算这一步做完
    }
    rec.cleanupDone = pending().length === 0;
    // 关闭身份：一次结算只认一个 `close_id`。它可重放（进事件、进回执、进 already 路径），
    // 消费方据此去重，而不必依赖墙钟先后。
    if (rec.cleanupDone) rec.closeId = rec.closeId || `${rec.incarnationId}:closed`;
    // **三个事实，三个答案**：`closed` 与 `cleanup_done` 同源；没做完只说「执行资格已撤销、
    // 还在清理」，不回 `closed:true`，也不发 `cell.closed`。
    const common = {
      cell_id: rec.spec.cell_id, from, to: 'stopped',
      execution_revoked: true, quiesced,
      workspace_released: cleanup.workspace, state_dir_released: cleanup.owner, inflight: rec.inflight,
      cleanup_done: rec.cleanupDone, cleanup_pending: pending(), already: false,
      close_id: rec.cleanupDone ? rec.closeId : null, closed_at: rec.closedAt || null,
      incarnation_id: rec.incarnationId,
    };
    if (rec.cleanupDone) {
      core.emit?.('cell.closed', {
        cell_id: rec.spec.cell_id, from, timestamp: new Date().toISOString(),
        close_id: rec.closeId, incarnation_id: rec.incarnationId, closed_at: rec.closedAt || null,
        quiesced, workspaceReleased: cleanup.workspace, ownerReleased: cleanup.owner, sourcePlugin: 'cell-runtime',
      });
      core.log('info', `[cell] ${rec.spec.cell_id} closed（${from} → stopped）`);
      return { ...common, closed: true, closing: false };
    }
    core.emit?.('cell.closing', {
      cell_id: rec.spec.cell_id, from, timestamp: new Date().toISOString(),
      cleanup_pending: common.cleanup_pending, inflight: rec.inflight, quiesced,
      execution_revoked: true, sourcePlugin: 'cell-runtime',
    });
    core.log('warn', `[cell] ${rec.spec.cell_id} 执行资格已撤销（${from} → stopped），但清理未完成：`
      + `${common.cleanup_pending.join('/')}；仍有 ${rec.inflight} 条旧执行链未停 —— 这不是「已关闭」，可再调 close() 重试`);
    return { ...common, closed: false, closing: true };
  }

  // ── 落盘 ────────────────────────────────────────────────────────────
  /** 读回盘上的 `cell.json`：读不到/坏掉都返回 null —— **不**把它当“已经完成”。 */
  async _readCellState(core, cellId) {
    try { return JSON.parse(await readFile(join(this._cellDir(core, cellId), CELL_FILE), 'utf8')); } catch { return null; }
  }

  async _persist(core, rec) {
    const dir = this._cellDir(core, rec.spec.cell_id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const body = JSON.stringify({
      schema_version: 'tusunsun.cell-state/v0',
      spec: rec.spec,
      state: rec.state,
      incarnation_id: rec.incarnationId,
      session_id: rec.sessionId,
      // 工作区真值随状态一起落盘 —— 重启后即便绑定表恢复失败，观测面报的也是
      // 这个 Cell 当初的工作区，而不是进程默认根。
      workspace_realpath: rec.workspaceReal || rec.spec.workspace,
      updated_at: new Date().toISOString(),
      ...(rec.faultReason ? { fault_reason: rec.faultReason } : {}),
      // `closed_at` 是**关闭落盘的就位标记**：close 的重试靠读回它判断上一次 rename 生效没有
      // （rc.33 / R32-03）。只在关闭路径上出现，普通状态落盘不带这个字段。
      ...(rec.closedAt ? { closed_at: rec.closedAt } : {}),
    }, null, 2);
    // 临时名必须唯一：同目录并发（含多进程）下，先完成的那次会把自己的 .tmp rename 走。
    const tmp = join(dir, `${CELL_FILE}.tmp-${process.pid}-${randomUUID()}`);
    try {
      await writeFile(tmp, body, { mode: 0o600 });
      await chmod(tmp, 0o600).catch(() => {});
      await rename(tmp, join(dir, CELL_FILE));
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});   // 失败不留半截 .tmp 给下一次落盘误读
      throw err;
    }
  }

  /** 结果按行追加（可审计、可回看；原子性由"整行写完 + rename 无关"这条简化承担）。 */
  async _appendResult(core, rec, result) {
    const dir = this._cellDir(core, rec.spec.cell_id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, RESULT_FILE);
    const line = `${JSON.stringify(stripPrivate(result))}\n`;
    // 追加前先确认文件**以换行结尾**（rc.33 / R32-04）：上一次写到一半就崩了的时候，直接
    // `flag:'a'` 会把新行黏到半行后面，结果是两行都读不出来 —— 把一个缺失行变成一整段损坏。
    let prefix = '';
    try {
      const buf = await readFile(file);
      if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) prefix = '\n';
    } catch (err) { if (err.code !== 'ENOENT') throw err; }
    await writeFile(file, prefix + line, { flag: 'a', mode: 0o600 });
    await chmod(file, 0o600).catch(() => {});
  }

  /**
   * 这一笔结果**是否已经在盘上**（按 `record_id` 判，不按行号）。
   *
   * 追加成功但确认丢失（写进去了、返回 EIO）时，重试**不得**再写一行 —— 那会让一次执行变成
   * 两条完成记录（rc.33 / R32-04）。
   *
   * 诚实边界：这是**读回校核**，不是物理 exactly-once。跨进程同时追加同一 `record_id` 仍可能
   * 各写一行，所以消费方必须按 `record_id` 归并；`writeFile` 成功也不等于已 fsync，所以
   * “持久”只按“已确认写入并读得回”这一层表述。
   */
  async _hasResultRecord(core, rec, recordId) {
    if (!recordId) return false;
    let raw = '';
    try { raw = await readFile(join(this._cellDir(core, rec.spec.cell_id), RESULT_FILE), 'utf8'); } catch { return false; }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try { if (JSON.parse(line)?.record_id === recordId) return true; } catch { /* 半行/坏行跳过，不影响其他行 */ }
    }
    return false;
  }
}

/** 内部字段（`_reply` 等）不得进落盘/对外形状。 */
function stripPrivate(result) {
  const { _reply, ...rest } = result || {};
  return rest;
}

function minNullable(a, b) {
  if (a == null) return b ?? null;
  if (b == null) return a;
  return Math.min(a, b);
}

export default new CellRuntime();
export { CELL_SCHEMA };
