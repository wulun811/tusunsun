import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createWriteStream } from 'node:fs';
import { mkdir, chmod, stat } from 'node:fs/promises';
import { matchDangerousCommand as matchBuiltinDangerousCommand } from './_lib/danger-patterns.js';
import { DestructiveGate, ACK_FIELD } from './_lib/destructive-gate.js';
// 只读名单的单一真相：与 cell-runtime 的 Cell 级只读门同源，不要再各写一份。
import {
  isReadonlyTool, isReadonlyCapability,
  isModelInvocableCapability, isCacheableCapability,
} from './_lib/tool-policy.js';
// `category` / `result_kind` 的唯一真相在内核：这里只引用两个纯函数，不另抄七类表。
// 方向是 插件 → 内核（内核从不 import 外围），不会成环。
// `resultKindOf` 只认 state 与证据：code 回答“哪一步报的”，不回答“跑没跑”。
import { categorizeCode, resultKindOf } from '../src/core/core.js';
// **按调用**绑定的可信上下文：回执交付、会话归因、Cell 归因都从这里取，
// 绝不从“工具实例的最近一次”或“模型给的 args”取。
import { runInCallContext, currentSession, currentTask, takeReceipt } from './_lib/call-context.mjs';

function _toolArgsHash(args) {
  try { return createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 16); }
  catch { return '0'.repeat(16); }
}

// 围栏的**所有者**：登记表按 owner 记账，install 返回 token，remove 必须拿 token/owner 来摘。
// 只能摘自己装的那一份，摘完若列表为空才真的变成“无护栏”；执行时按执行器自己的 core 解析归属。
// 不能是模块级变量：同进程两个装配会互相串；也不能是**模块级** Map —— 装载器给每个插件 import
// 加 `?pmN` 标签，插件互相 import 拿到的是另一个模块实例，模块级表会分成两份（实测：状态报
// installed:true，判据一次都没跑）。硬边界仍是「1 Cell : 1 Core : 1 进程」，不宣称多租户已安全。
const _fences = (globalThis[Symbol.for('tusunsun.tool-executor.fences')] ??= new Map());   // token → { fence, owner, core, at }
const _fenceSeqState = (globalThis[Symbol.for('tusunsun.tool-executor.fenceSeq')] ??= { n: 0 });

/** 兜底护栏：无 owner 的旧调用方（`setFence(fence)` 单参）仍可用，但要能被观测到。 */
const LEGACY_OWNER = '__legacy__';

/**
 * 同名替换的**资格判据**。撤销与替换必须同源：`removeFence` 已经要求 disposer，
 * 而 `setFence` 曾允许"只要 owner 字符串相同就顶掉旧围栏" —— 同一种管理操作的第二个
 * 入口绕过了第一条安全规则。
 *
 * 允许的只有两条，都不以可列举的字符串为凭：
 *   ① 持原登记凭据：`opts.disposer` 是装它时交回的那个对象（对象身份，推不出来）；
 *   ② 同名受信装配中重装：reload 后新实例手里本来就没有旧 token，要求持旧凭据会让
 *      "崩溃后重装护栏"变成不可能。判据是**当前装配上下文**的 owner 等于本围栏的 owner
 *      且该装配受信 —— 这个 owner 由装载器按插件名给出，插件不能自选，于是在别人的
 *      init 里冒名会被这里拒掉。
 * 旧调用方形态（单参 `setFence(fence)`）没有"别人的"可言：它装的是全局兜底，owner 恒为
 * 常量，故按兼容语义放行，不把老代码逼成错误。
 */
function mayReplaceFence(rec, opts) {
  if (rec.owner === LEGACY_OWNER) return true;
  if (opts?.disposer != null && rec.disposer === opts.disposer) return true;
  let asm = null;
  try { asm = opts?.core?.currentAssembly?.() ?? null; } catch { asm = null; }
  return asm != null && asm.trusted === true && asm.owner === rec.owner;
}

/**
 * 装配/替换一份围栏。
 * @param {object} fence 需实现 `preCheck(tool, args, sessionId, chainId, fenceCtx)` /
 *        `postCheck(tool, output, duration, ok, sessionId, chainId)`：位置是**契约**，多声明只会静默收到 `undefined`。
 * @param {{owner?: string, core?: object}} [opts] `core` 给了就只对该 core 生效；
 *        不给则作为**全局**兜底（旧调用方形态，日志会注明）。
 * @returns {{token: string}} 凭据，`removeFence()` 时用它证明"我是装它的那个人"
 */
export function setFence(fence, opts = {}) {
  const owner = String(opts.owner || LEGACY_OWNER);
  // 位置参数是契约：平台只传 5 个，声明更多的槽永远收不到值，`fenceCtx` 也不会自动挪位。
  if (typeof fence?.preCheck === 'function' && fence.preCheck.length > 5) {
    process.emitWarning(`fence "${owner}" 的 preCheck 声明了 ${fence.preCheck.length} 个位置参数，`
      + '平台只传 5 个（tool, args, sessionId, chainId, fenceCtx）', 'TusunFenceArity');
  }
  // **token 必须不可猜**：原值是 `${owner}#${seq}`，owner 是公开字符串、
  // seq 从 1 递增 —— 等于"知道名字就能推出凭据"。凭据要能证明"我是装它的那个人"，
  // 就不能由任何人复算出来。改用 CSPRNG；`seq` 只留在内部用于观测，不参与凭据。
  const token = `${owner}#${randomUUID()}`;
  // 同一个 owner 重复装配 = 替换自己那一份（reload 场景），不该越堆越多。
  // 但**替换权不等于撤销权**：这里必须校验资格，否则"知道公开 owner 字符串"就等于
  // 拿到了顶掉别人安全围栏的权限 —— 与 `removeFence` 已要求 disposer 的规则自相矛盾
  // 不合格的替换**拒绝且原围栏保持有效**，不静默降级。
  for (const [t, rec] of _fences) {
    if (rec.owner !== owner || rec.core !== (opts.core || null)) continue;
    if (!mayReplaceFence(rec, opts)) {
      const err = new Error(`fence_replace_denied: owner "${owner}" 的围栏已存在，替换须持其 disposer，`
        + '或在同名受信装配中重装（可列举的 owner 字符串不构成授权）');
      err.code = 'fence_replace_denied';
      throw err;
    }
    _fences.delete(t);
  }
  // **disposer 是不可伪造的撤销凭据**：对象身份，只能从返回值拿到，不能由 owner/seq 推出。
  // token 保留下来是为了兼容既有调用方（`{token}` 形态与 reload 场景的观测）。
  const disposer = Object.freeze(Object.create(null, {
    token: { value: token, enumerable: true },
    owner: { value: owner, enumerable: true },
  }));
  _fences.set(token, { fence, owner, core: opts.core || null, at: Date.now(), seq: ++_fenceSeqState.n, disposer });
  return { token, disposer };
}

/**
 * 摘掉围栏。带 token/owner 时**只摘自己那一份**；不带时摘"无 owner 的全局兜底"。
 * @param {{token?: string, owner?: string, core?: object}} [opts]
 * @returns {boolean} 是否真的摘掉了什么（false = 没装过/已被替换，别把 no-op 报成成功）
 */
export function removeFence(opts = {}) {
  if (opts.token) {
    // `{token}` 形态仍收（既有调用方与 expert-originals 都在用），但**不能连归属一起无视**：
    // 给了 `core` 就必须是该 core 那一份。否则 `{token}` 成了一个"只认字符串、不认范围"的
    // 入口 —— 与 `{owner}` 分支已经要求 disposer 的说法不一致。
    //
    // 真正的修法在于**不再把 token 发出去**（见 `resolveFence`）：随机 UUID 不可猜，
    // 但一个由公开解析函数直接交出的凭据，随机与否已无关。这里只是把范围判据补齐。
    const rec = _fences.get(opts.token);
    if (!rec) return false;
    if (opts.core && rec.core !== opts.core) return false;
    return _fences.delete(opts.token);
  }
  if (opts.owner) {
    // **按 owner 删除必须带权属证明**：owner 是可公开列举的字符串，
    // 允许 `removeFence({owner:'guardian'})` 摘掉别人的安全围栏，等于把护栏的撤销权
    // 交给"知道名字"的任何人 —— 而护栏正是用来兜住那些不受信的调用方的。
    //
    // 保留的合法形态只有一条：`opts.disposer` 是**安装时拿到的那个 disposer 对象**
    // （对象身份，不可伪造、不可由名字推导）。返回值里的 `token` 仍可用于 `{token}` 形态。
    if (opts.disposer == null || typeof opts.disposer !== 'object') {
      return false;
    }
    const rec = _fences.get(opts.disposer.token);
    if (!rec || rec.disposer !== opts.disposer) return false;
    if (rec.owner !== opts.owner) return false;
    if (opts.core && rec.core !== opts.core) return false;
    return _fences.delete(opts.disposer.token);
  }
  // 无参数：只摘"无 core 归属的全局兜底"（旧调用方语义）。
  // 有 core 归属的护栏必须由装它的人带 token/owner 摘 —— 否则又回到"任意一方 stop 就全清"。
  let removed = false;
  for (const [t, rec] of _fences) if (rec.owner === LEGACY_OWNER) { _fences.delete(t); removed = true; }
  return removed;
}

/**
 * 解析"这次执行该用谁的护栏"：core 专属优先，其次全局兜底。
 *
 * **只给执行用，不给管理用**：
 *   · **不返回 token**。token 是撤销凭据。把一个凭据交给每个普通调用方，它就失去凭据的
 *     含义：不用猜，公接口直接发。随机 UUID 只挡“推导”，挡不住“发给你”。
 *     实测只需 `removeFence({ token: resolveFence(core).token })` 就能摘掉别人的安全围栏，
 *     随后同一条执行从 blocked 变 succeeded、handler 真的被调一次。
 *   · **不返回活围栏对象**。只删 token 还不够：安装者传进来的那个对象上带着它自己的方法
 *     （实测 `resolveFence(c).fence.stop()` 真会跑到安装者的 `stop()` 上）。
 *     于是返回的只能是一个**只含准入所必需方法的只读视图**：`preCheck` / `postCheck`，
 *     绑到原对象上调用；拿不到原对象、拿不到它的其它属性、也改不到它。
 *
 * 管理面（撤/替换）只认 `removeFence` / `setFence` 的凭据路径：安装时拿到的 `disposer`。
 * 内部分配用 `_resolveFenceRecord()`，它照旧返回登记记录 —— 不导出，外部拿不到。
 * @returns {{fence: {preCheck?: Function, postCheck?: Function}, owner: string}|null}
 */
export function resolveFence(core = null) {
  const rec = _resolveFenceRecord(core);
  if (!rec) return null;
  return { fence: _fenceView(rec.fence), owner: rec.owner };
}

/** 内部解析：返回登记记录（含 token/core/disposer）。**不导出** —— 它才是管理面。 */
function _resolveFenceRecord(core = null) {
  let fallback = null;
  for (const rec of _fences.values()) {
    if (core && rec.core === core) return rec;
    if (!rec.core && !fallback) fallback = rec;
  }
  return fallback;
}

/**
 * 围栏对象的**只读执行视图**：只转发准入/记账两个方法，不交出原对象。
 *
 * 为什么不直接返回原对象：围栏是安装者的实例，它上面还有什么方法是安装者的事，
 * 但"解析得到围栏"不应等于"拿到安装者的实例"。这里白名单两个名字，其余一律不可达；
 * 方法用 `apply` 绑到原对象上，所以 `this` 语义不变（护栏自己的状态照常读写）。
 */
function _fenceView(fence) {
  if (!fence || typeof fence !== 'object') return fence;
  const view = Object.create(null);
  for (const name of ['preCheck', 'postCheck']) {
    if (typeof fence[name] !== 'function') continue;
    Object.defineProperty(view, name, {
      value: (...a) => fence[name](...a), enumerable: true, writable: false, configurable: false,
    });
  }
  return Object.freeze(view);
}

/** 观测面：现在装着谁的护栏（诊断/日志/`/health` 用；count/all 按传入的 core 过滤，不传才是进程级；不返回围栏对象与 token）。 */
export function fenceStatus(core = null) {
  const active = _resolveFenceRecord(core);
  const scoped = core ? [..._fences.values()].filter((r) => !r.core || r.core === core) : [..._fences.values()];
  return {
    installed: Boolean(active),
    owner: active?.owner || null,
    scope: active ? (active.core ? 'core' : 'process') : 'none',
    count: scoped.length,
    all: scoped.map((r) => ({ owner: r.owner, scope: r.core ? 'core' : 'process', at: r.at })),
  };
}

/**
 * **显式声明**哪些主体的返回值是 ExecutionResult：只有它们的 `ok`/`error`/`code`/`state`
 * 被解释为执行状态，其余一律视为**不透明业务数据**（含同名 `error`/`ok` 也绝不判失败）。
 * 新能力请自报 `provides[].resultContract==='execution_result'`，不要让消费方去猜；
 * 代价是加进这张表后，它的同名字段从此算执行状态。
 */
const EXECUTION_RESULT_SUBJECTS = new Set([
  'tool.db', 'tool.grep', 'tool.search', 'tool.validate',
  'tool-db', 'tool-grep', 'tool-search', 'tool-validate',
  'agent.spawn', 'agent.kill', 'agent.list', 'agent.consume', 'agent.submitTask',
  // tool-bash 返回结构化控制信封，故必须在此声明：未声明主体在 `_isStructuredFailure` 里
  // 按业务数据判成功，`{ok:false,code:'nonzero_exit'}` 就会被吞掉。
  'tool-bash',
  // tool-code-fixer 同理：未声明主体一律判成功，“改代码一次都没成功”会被报成成功。
  'tool-code-fixer',
]);

// 执行器自产失败的标记必须是 **Symbol**：普通字符串键会被业务数据碰撞（载荷含
// `_executorFailure:true` 即误判失败），而 Symbol 不可由 JSON 构造、不进 JSON.stringify / Object.keys。
const EXECUTOR_FAILURE = Symbol('tusunsun.executorFailure');

// **执行前的拒绝**（rejected）与**执行中的失败**（failed）分开，只影响 state 粒度 ——
// 两者都是非成功。判据只读执行器自己产出的具名 code，**不从错误文本猜**。
const EXECUTOR_REJECTION_CODES = new Set([
  'capability_denied', 'capability_not_found', 'tool_not_registered', 'permission_denied',
  'scope_denied', 'identity_required', 'blocked', 'rate_limited',
  // 执行资格被撤销是**拒绝**（从未执行）：记成 failed 会让上层去重试一个必然再被拒的调用。
  'execution_revoked',
  // 判据故障 / 判据拦截也是拒绝：handler 一次都没跑，记成 failed 会被读成“执行出错”。
  'HOOK_ERROR', 'HOOK_BLOCKED',
  // 任务维度拒绝（rc.31 / K30-01）：这一族都是**派发之前**判的，handler 一次都没跑。
  // 记成 failed 会让上层去重试一个“因为不属于当前任务所以不该发生”的调用，
  // 而真正的处置是查调用方为何还持有旧回调，不是重试。
  'task_scope_required', 'task_not_active', 'stale_task_epoch', 'task_scope_mismatch',
  // 门身份不可证（rc.31 / K30-02）：存在一条活租约却证不出“它就是原门”，同样是派发前拒绝。
  'cell_gate_unavailable',
  // 冻结是拒绝：core 的 `CAPABILITY_CODE_STATE` 也判 `denied`，同一个 code 不许有两个 state。
  'capability_frozen',
  // 沙箱开启但工具未声明 op ⇒ **拒绝**（handler 从未执行），不是失败。
  'sandbox_op_undeclared',
  // 这张表只装**执行器自己产出的、且它亲眼所见发生在派发之前**的 code：工具在 handler
  // 内部抛出的码（`out_of_bounds` / `invalid_session_id`）不能进来 —— 没有一方能证明副作用为零。
  //
  // `capability_not_found` 是**有意分歧**，不是漏项：core 判 failed（服务端配置问题），
  // 执行器判 rejected（这次调用从未执行）。别“顺手对齐”任何一边，两边各有测试钉住。
]);

// 导出**类**（不只有默认实例）：回归要与生产实例隔离地测信封，默认实例的导出不变。
export class ToolExecutor {
  name = 'tool-executor';
  // 0.8.5（R0-180）：新增按会话的能力/只读策略（`setSessionPolicy` 等，派发期生效）。
  version = '0.8.5';
  manifest = {
    schema_version: 'tusunsun.plugin/v2',
    name: 'tool-executor',
    version: '0.8.5',
    api_version: '1',
    owner: 'platform',
    provides: [
      { service: 'tool-executor', api_version: '1.0.0' },
      { service: 'tool.compose', api_version: '1.0.0', type: 'capability' },
      { service: 'action.inspect', api_version: '1.0.0', type: 'capability' },
    ],
    requires: [
      { service: 'tool-registry', range: '>=0.4.0', optional: false },
      { service: 'tool-guard', range: '>=0.4.0', optional: false },
    ],
    surfaces: ['internal'],
    degraded_policy: 'block_startup', // 交付执行关键路径
  };
  // 类字段的 requires/provides 必须与 manifest 一致、且用**实际注册名**（`tool-registry`，不是点号）：
  // 写错不会当场报错，只会在「删掉 manifest」时变成静默回归。
  requires = { 'tool-registry': '>=0.4.0', 'tool-guard': '>=0.4.0' };
  permissions = [];
  provides = [
    { name: 'tool-executor', type: 'service', removable: false },
    { name: 'tool.compose', type: 'capability', removable: true },
    // A0-b：按需展开 Action Receipt。声明为 capability 才会进能力表，
    // 模型才**看得到**、也才走得上 Cell 能力门（否则它是只有代码在用的死接口）。
    { name: 'action.inspect', type: 'capability', removable: true },
  ];

  constructor() {
    this._preHooks = [];
    this._postHooks = [];
    this._dispatchHooks = [];
    this._frozenCaps = new Set();
    // 初始化状态机（H26-02）：'ready' 之前的状态一律不得当作"已装配"。
    this._initState = 'new';
    this._initCore = null;
    this._frozenSubscribed = false;
    // 钩子登记簿的**实例身份与代际**（rc.28）：token 只在这个实例、这一代内有效。
    // 没有它们，"我把门装上了"就只是一句自述 —— 同一个 owner 再装一条也能顶替它。
    this._hookSeq = 0;
    this._hookGeneration = 0;
    this._instanceId = `te-${randomUUID().slice(0, 8)}`;
    // 保护性注册租约（rc.29 / R28-A）：**与钩子表分离**的一张表。
    //
    // 钩子被摘掉之后，钩子表已经不记得“这个会话本来必须有门”—— 它只会安静地少一条记录，
    // 派发时遍历到零条就放行。租约是那条**不会被普通摘钩一起清空**的要求：会话被谁保护过、
    // 拿什么回执证明，都留在这里；派发期逐个验回执，验不过就拒绝。
    this._guardLeases = new Map();
    // 会话级策略（R0-180 / P1）：sessionId → {capIds, mode, source, at}。
    // 与 `_guardLeases` 分开：租约回答“这个会话有没有门”，策略回答“这个会话能调什么”。
    this._sessionPolicies = new Map();
    // 构造即成立的值：init 会按配置覆盖，但“没 init 就用”不得静默变成 0 并发/无超时。
    this._maxParallel = 5;
    this._timeout = 30000;
    this._contracts = new Map();       // 主体（工具名/能力 id）→ 结果契约
    this._contractGaps = new Set();    // 已告警过的"返回 {ok:false} 却未声明契约"的主体
    this._rateCalls = new Map();
    this._rateCleanTimer = null;
    this._metrics = new Map();
    this._auditLog = new Map();
    this._cache = new Map();
    this._cacheOrder = [];
    this._cacheTTL = 30000;
    this._cacheMax = 50;
    // A0-b：Action Receipt 留档（供 `action.inspect` 按需展开）。与审计同样有界 ——
    // 无限增长的内存记录等于一种慢速内存泄漏，而这里存的还是带 hash 的结构化对象。
    this._receipts = new Map();
    this._receiptMax = 100;
    this._preferences = new Map();
    this._prefCleanTimer = null;
    this._debugStream = null;
    this._sensitiveKeywords = [
      'password', 'passwd', 'pwd', 'secret', 'api_key', 'apikey', 'api-key',
      'token', 'access_token', 'refresh_token', 'private_key', 'privatekey', 'private-key',
      'credential', 'auth', 'authorization', 'key', 'pass',
    ];
  }

  async init(core) {
    // **初始化不得先破坏仍然生效的授权门**（H26-02）。
    //
    // 旧版头两行是 `this._dispatchHooks = []` / `this._frozenCaps = new Set()`，随后才
    // `registerCapability('action.inspect')` —— 后者在重复初始化时抛 `capability_conflict`，
    // 于是"失败"留下的不是旧状态，而是**半个执行器**：pre 钩子还在（不在这两行里被清），
    // 派发期钩子已空。pre 阶段只能拿名字派生的猜测 id，最终判据在派发期 —— 门被清掉之后，
    // 只读 Cell 的真实工具调用照样写盘。
    //
    // 三条合同：同 Core 重复 init **幂等早退**（不动任何状态，旧门原样在位）；换 Core 的重入
    // 在改动任何状态**之前**具名拒绝（旧实例保持安全）；真正初始化中途失败时按快照回滚。
    if (this._initState === 'ready' && this._initCore === core) {
      core.log?.('warn', '[tool-executor] init() called again on the same Core; keeping the existing authorisation hooks');
      return;
    }
    if (this._initState === 'ready') {
      throw Object.assign(new Error('tool-executor is already initialised against a different Core; refusing to rebind '
        + 'while its authorisation hooks are live (create a new executor instance for another Core)'),
      { code: 'tool_executor_core_rebind' });
    }
    const snapshot = {
      state: this._initState, initCore: this._initCore,
      pre: this._preHooks, post: this._postHooks, dispatch: this._dispatchHooks,
      frozenCaps: this._frozenCaps, hookErrors: this._hookErrors,
      generation: this._hookGeneration,
    };
    this._adoptOwnState();
    this._initState = 'initializing';
    this._initCore = core;
    this.core = core;
    this._hookErrors = 0;   // HOOK_ERROR 的累计次数（安全监测读数，见 getSecurityStats）
    // 订阅 core 的冻结广播（判据见 `_capabilityIsFrozen`）。重复 init 不再订阅一次：
    // 一份事实两条订阅，冻结会触发两次处理（计数与告警都会重复）。
    if (!this._frozenSubscribed) {
      core.on?.('core:capability.frozen', (e) => this._onCapabilityFrozen(e), { owner: 'tool-executor' });
      this._frozenSubscribed = true;
    }
    try {
      // 新一代登记簿：上一代签出的 token 从这里开始失效（失败时回滚恢复旧值，见 `_rollbackInit`）。
      // 代际只前进不后退，且只在**真正装配**时前进 —— 幂等早退不走这一条。
      this._hookGeneration++;
      this._maxParallel = core.get('tools.maxParallel') || 5;
      this._timeout = core.get('tools.timeout') || 30000;
      this._useSandbox = core.get('sandbox.enabled') || false;
      this._startRateCleanTimer();
      this._startPrefCleanTimer();
      await this._initDebugStream();
      // A0-b：把 `action.inspect` 注册成能力 —— 工具输出里的
      // "（明细：action.inspect act-xxx）" 才有东西可调。
      // **放在最后两步**：这一处与 `registerService` 会抛（能力/服务冲突），放在前面任何一步
      // 之后都会让"失败"留下一半装配（定时器、日志流、能力）。
      core.registerCapability('action.inspect', {
        description: 'Expand one action receipt by id (the "action.inspect <id>" hint in tool output). '
          + 'Returns the full structured receipt: what was actually applied, before/after hashes, '
          + 'whether it was verified, and whether it can be undone. Session-scoped.',
        owner: 'tool-executor',
        // 作用域**只从可信调用上下文取**，不从 args 取：`_sessionId` 是模型可控入参，
        // 抄一个别人的 sessionId 就能读到别人的回执。
        handler: async (args) => this.inspectAction(args?.action_id, currentSession(), args?.budget),
      });
      core.registerService('tool-executor', this);
      this._initState = 'ready';
    } catch (err) {
      this._rollbackInit(snapshot);
      throw err;
    }
  }

  /**
   * 每个实例必须**拥有**自己的可变状态表（H26-02 的另一半，删掉“开头清空”之后必须补上）。
   *
   * 插件默认导出是模块级单例，而嵌入方/测试常用 `Object.create(默认导出)` 造一个“新执行器”：
   * 读属性会穿透到父对象，写属性才落成自己的。旧版 init 开头那句 `this._dispatchHooks = []`
   * 恰好把“穿透读到的数组”截断成自己的 —— 修 H26-02 时如果只是删掉那行，父子就**共用一个
   * 数组**，一条钩子会被写进别人的表里（实测：同名 Cell 的两个宿主互相拿对方的门判会话）。
   *
   * 所以拆成两件事：**认领自己的表**（没有就新建，不动已有内容）与**不得清空仍生效的门**
   * （H26-02：同 Core 幂等早退 + 失败回滚）。
   */
  _adoptOwnState() {
    if (!Object.hasOwn(this, '_preHooks')) this._preHooks = [];
    if (!Object.hasOwn(this, '_postHooks')) this._postHooks = [];
    if (!Object.hasOwn(this, '_dispatchHooks')) this._dispatchHooks = [];
    if (!Object.hasOwn(this, '_frozenCaps')) this._frozenCaps = new Set();
    if (!Object.hasOwn(this, '_initState')) { this._initState = 'new'; this._initCore = null; }
    if (!Object.hasOwn(this, '_frozenSubscribed')) this._frozenSubscribed = false;
    // 登记簿的坐标也必须是自己的一份：否则两个伪实例会拿到同一个 `_instanceId`，
    // 回执就分不出"谁装的"（这正是 token 要回答的问题）。
    if (!Object.hasOwn(this, '_hookSeq')) {
      this._hookSeq = 0;
      this._hookGeneration = 0;
      this._instanceId = `te-${randomUUID().slice(0, 8)}`;
    }
    if (!Object.hasOwn(this, '_guardLeases')) this._guardLeases = new Map();
    // 会话策略同理：穿透读会拿到父实例的 Map，`set` 写进去就是两个宿主互相改对方的授权面。
    if (!Object.hasOwn(this, '_sessionPolicies')) this._sessionPolicies = new Map();
  }

  /**
   * 给一条钩子签一个**回执**：token + 实例 + 代际 + 归属。
   *
   * 为什么需要它：`registerPreHook` 以前返回 undefined，装配方唯一能说的是"我调过了"。
   * 而"调过了"、"此刻还在"、"还是我这一代装的那一条"是三件事 —— 中间可能被
   * `removeHooksByOwner` 摘掉、被重复 `init()` 换代、或者压根装到了另一个执行器实例上。
   * 回执把这三件事压成一个可核验的对象（`verifyHook` 是它的唯一读者）。
   */
  _hookStamp(kind, owner) {
    const token = `${this._instanceId}#${++this._hookSeq}`;
    const stamp = { token, generation: this._hookGeneration, instance: this._instanceId };
    return { stamp, receipt: Object.freeze({ ...stamp, kind, owner }) };
  }

  /**
   * 核对一个回执**此刻仍然有效**：同一个实例、同一代、那条记录还在表里、owner 没变。
   *
   * 回执的每一半都能被伪造，但伪造不了"表里真有一条带这个 token 的记录" —— 而那张表只能由
   * 本实例的注册方法写入。这是装配方能拿到的、不依赖对方自述的唯一证据。
   */
  verifyHook(receipt) {
    if (!receipt || typeof receipt !== 'object' || typeof receipt.token !== 'string') {
      return { ok: false, reason: 'no_receipt' };
    }
    if (receipt.instance !== this._instanceId) return { ok: false, reason: 'wrong_instance' };
    if (receipt.generation !== this._hookGeneration) return { ok: false, reason: 'stale_generation' };
    const table = receipt.kind === 'pre' ? this._preHooks
      : receipt.kind === 'post' ? this._postHooks
        : receipt.kind === 'dispatch' ? this._dispatchHooks : null;
    if (!table) return { ok: false, reason: 'unknown_kind' };
    const hit = table.find((h) => h.token === receipt.token);
    if (!hit) return { ok: false, reason: 'not_registered' };
    if (hit.owner !== receipt.owner) return { ok: false, reason: 'owner_changed' };
    return { ok: true, owner: hit.owner, kind: receipt.kind, generation: receipt.generation };
  }

  /** 失败的 init 必须回到"旧门仍在、没有半装配"的形态（H26-02）。 */
  _rollbackInit(snapshot) {
    this._preHooks = snapshot.pre;
    this._postHooks = snapshot.post;
    this._dispatchHooks = snapshot.dispatch;
    this._frozenCaps = snapshot.frozenCaps;
    this._hookErrors = snapshot.hookErrors;
    if (this._rateCleanTimer) { clearInterval(this._rateCleanTimer); this._rateCleanTimer = null; }
    if (this._prefCleanTimer) { clearInterval(this._prefCleanTimer); this._prefCleanTimer = null; }
    try { this._debugStream?.destroy?.(); } catch { /* 关闭失败不影响回滚 */ }
    this._debugStream = null;
    this._initState = snapshot.state;
    this._initCore = snapshot.initCore;
    this._hookGeneration = snapshot.generation;
  }

  /** 不可恢复操作软闸：懒建一次，实例跨调用复用（确认状态要能跨轮次对上）。 */
  _destructiveGate() {
    if (!this._gate) this._gate = new DestructiveGate();
    return this._gate;
  }

  /** 开关：默认开；`tools.destructiveGate = false` 可关（关掉即退回"只硬拦"的旧行为）。 */
  _destructiveGateEnabled() {
    return this.core?.get?.('tools.destructiveGate') !== false;
  }

  /**
   * 执行器认的“工作区根”：**会话级 > 数据面 > 配置面 > cwd**（与文件工具同口径）。
   * 会话这一层不能省：破坏面测量与捆仙索的相对路径展开都按它算，去掉就变成
   * “会话 B 的 `rm -r d0` 按会话 A 的目录估算影响面”，挑战文案里列的是别人的文件。
   */
  _effectiveWorkDir(sessionId) {
    const scoped = this.core?.getService?.('workspace')?.root?.(sessionId);
    if (scoped) return scoped;
    return this.core?.getData?.('agent.workDir')
      || this.core?.get?.('agent.workDir')
      || process.cwd();
  }

  async stop() {
    if (this._rateCleanTimer) {
      clearInterval(this._rateCleanTimer);
      this._rateCleanTimer = null;
    }
    if (this._prefCleanTimer) {
      clearInterval(this._prefCleanTimer);
      this._prefCleanTimer = null;
    }
    if (this._debugStream) {
      this._debugStream.end();
      this._debugStream = null;
    }
  }

  _startRateCleanTimer() {
    if (this._rateCleanTimer) return;
    this._rateCleanTimer = setInterval(() => {
      const now = Date.now();
      const windowMs = this.core.get('tools.rateLimit.windowMs') || 60000;
      for (const [key, calls] of this._rateCalls) {
        while (calls.length && now - calls[0] > windowMs) calls.shift();
        if (!calls.length) this._rateCalls.delete(key);
      }
    }, 60000);
    // 限流窗口清理是**后台维护**，不是“还有请求在飞”——不 unref 就等于装过本插件的进程永不退出。
    // 真正的待完成操作有自己的句柄，不会因为这里 unref 而丢。
    this._rateCleanTimer.unref?.();
  }

  _startPrefCleanTimer() {
    if (this._prefCleanTimer) return;
    this._prefCleanTimer = setInterval(() => {
      for (const [sessionId, prefs] of this._preferences) {
        if (Object.keys(prefs).length === 0) this._preferences.delete(sessionId);
      }
    }, 300000);
    // 同 `_startRateCleanTimer`——空偏好清理不得钉住进程。
    this._prefCleanTimer.unref?.();
  }

  async _initDebugStream() {
    if (!this.core.get('tools.debug')) return;
    try {
      const logsDir = join(this.core.dataDir, 'logs');
      await mkdir(logsDir, { recursive: true });
      const date = new Date().toISOString().slice(0, 10);
      const logFile = join(logsDir, `tool-debug-${date}.jsonl`);
      this._debugStream = createWriteStream(logFile, { flags: 'a' });
      await chmod(logFile, 0o600);
    } catch (err) {
      this.core.log('warn', `Failed to init debug stream: ${err.message}`);
    }
  }

  /**
   * 注册一条执行前钩子。
   *
   * `failClosed` 默认 false，不能改默认值：`registerPreHook` 是公开接线口，
   * 已有调用方靠“钩子抛错不拦路”活着，改默认值等于悄悄改变一批未知钩子的语义。
   * 授权判据类钩子必须显式声明 `failClosed: true`：钩子里一次意外异常（属性访问 NPE、
   * Set 未初始化）就会让撤销门/只读门/能力门整条失效，而调用方看到的是**正常执行**。
   * 声明后出错即 `blocked`，错误里带 `hook_error`，便于区分“策略拒绝”与“判据坏了”。
   */
  /**
   * 消费一个**已被拒绝**的 thenable：不改变决策、不产生 unhandledRejection。
   *
   * 只在同步判定已经做出"拒绝"之后调用 —— 此时结果是 `HOOK_ERROR`，异步侧发生什么都不
   * 能也不应该改变它。恶意/异常 thenable（getter 抛、`then` 本身抛）也在这里吃掉：一个
   * 不合作的返回值不能让派发期复核自己崩掉。
   */
  _consumeRejectedThenable(r, owner) {
    const onRejected = (err) => {
      try {
        this.core?.log?.('debug', `[tool-executor] async dispatch hook (${owner}) rejected after the synchronous decision: ${err?.message ?? String(err)}`);
      } catch { /* 日志失败不影响决策 */ }
    };
    try {
      const then = r.then;
      if (typeof then !== 'function') return;
      then.call(r, undefined, onRejected);
    } catch { /* thenable 自身抛错：同步决策已经是否决，无需再做什么 */ }
  }

  registerPreHook(fn, owner, priority = 100, opts = {}) {
    const { stamp, receipt } = this._hookStamp('pre', owner);
    this._preHooks.push({ fn, owner, priority, failClosed: opts.failClosed === true, ...stamp });
    this._preHooks.sort((a, b) => a.priority - b.priority);
    // 返回**回执**（rc.28）：调用方可以无视，但授权类装配应该拿它去核账（`verifyHook`）。
    return receipt;
  }

  /**
   * 安全检查自身的可观测读数。`_hookErrors` 只增不减，没有读者时它和不存在没区别：
   * 运维要能回答“这期间有没有调用是因为**判据坏了**而不是策略拒绝被拦下的”，
   * 那正是“系统正常”与“所有 Cell 都在无保护运行”的区别。
   */
  getSecurityStats() {
    return {
      hook_errors: this._hookErrors,
      dispatch_hooks: this._dispatchHooks.length,
      pre_hooks: this._preHooks.length,
      fail_closed_hooks: this._preHooks.filter((h) => h.failClosed).length,
    };
  }

  /**
   * 按 owner 数**此刻真的在表里**的钩子。给装配方（Cell 门、护栏）核账用：
   *
   * `registerPreHook` 返回 undefined，装配方除了"我调过了"没有别的证据；而"调过"与
   * "在表里、且没被后来的 init/removeHooksByOwner 摘掉"是两件事。这个读数是那句声明
   * 唯一可核验的形态（H26-01/H26-02 的观测面）。
   */
  hookCountFor(owner) {
    return {
      pre: this._preHooks.filter((h) => h.owner === owner).length,
      post: this._postHooks.filter((h) => h.owner === owner).length,
      dispatch: this._dispatchHooks.filter((h) => h.owner === owner).length,
    };
  }

  registerPostHook(fn, owner, priority = 100) {
    const { stamp, receipt } = this._hookStamp('post', owner);
    this._postHooks.push({ fn, owner, priority, ...stamp });
    this._postHooks.sort((a, b) => a.priority - b.priority);
    return receipt;
  }

  /**
   * 注册一条**派发期**钩子 —— 在能力已解析、即将真正调用 handler 的那一行之前同步调用。
   *
   * 存在的唯一理由是一个窗口：`registerPreHook` 跑在 `_checkPreFlight` 里，之后还有
   * `_resolveCapability`（可能 await 懒加载）与 `_executeViaCapability`（可能 await 超时竞速）
   * 两次异步 —— 能力门放行后 close(force) 就能让 handler 照常启动并写盘。
   * 派发钩子跑在 `cap.handler(params)` **紧邻的上游**，中间不再有 await 点。
   *
   * 不把 `_checkPreFlight` 挪到最后：它还要承担硬拦、软闸、护栏 preCheck、限流 ——
   * 那些必须在懒加载与真实调用之前跑。安全检查分两段是对的，错的是“最后一段之后还有异步”。
   *
   * 签名 `(toolName, capId, args, sessionId)`：`capId` 是**解析出的真实能力**，授权以它为准。
   */
  registerDispatchHook(fn, owner) {
    const { stamp, receipt } = this._hookStamp('dispatch', owner);
    this._dispatchHooks.push({ fn, owner, ...stamp });
    return receipt;
  }

  removeHooksByOwner(owner) {
    this._preHooks = this._preHooks.filter(h => h.owner !== owner);
    this._postHooks = this._postHooks.filter(h => h.owner !== owner);
    this._dispatchHooks = this._dispatchHooks.filter(h => h.owner !== owner);
    // **租约故意不在这里清**（R28-A）：一次“摘钩”如果连“这个会话必须有门”一起清掉，
    // 摘钩就成了最省事的放行手段。撤销租约是另一个动作（`leaseGuard()` 返回的 `release`），
    // 只能由装门的人在确认拆除之后调用。
  }

  /**
   * 按**回执**精确撤销一条登记 —— 撤销动作与登记动作用同一个身份（rc.29）。
   *
   * `removeHooksByOwner` 是“把这一族全清掉”，适合回滚半个装配；但在“同一个 Cell 的第二世”
   * 场景里，清族会把前一世仍在生效的门一起清掉，于是上一世未停的执行链重新变成无人约束。
   * 按 token 删只影响**这一次**注册。
   */
  removeHook(receipt) {
    if (!receipt || typeof receipt.token !== 'string' || receipt.instance !== this._instanceId) return false;
    const pick = (arr) => {
      const i = arr.findIndex((h) => h.token === receipt.token);
      if (i < 0) return false;
      arr.splice(i, 1);
      return true;
    };
    if (receipt.kind === 'pre') return pick(this._preHooks);
    if (receipt.kind === 'post') return pick(this._postHooks);
    if (receipt.kind === 'dispatch') return pick(this._dispatchHooks);
    return false;
  }

  /**
   * 给一个会话挂一张**保护性注册租约**：在收到 `release()` 之前，这个会话的每一次派发都要能
   * 证明“当初那条门还在”，证明不了就拒绝（R28-A）。
   *
   * 与 `registerDispatchHook` 的分工：钩子负责**判定**（这条调用准不准），租约负责**存续**
   * （判据还在不在）。钩子没了，判定就没了，但租约还记得“这里必须有判定”。
   *
   * 租约按 `sessionId + owner` 定位：同一会话上重新装门（迟到的执行器、合法恢复）是**替换**，
   * 不是叠加 —— 新回执替旧回执，旧门失效不会把恢复后的执行一直卡住。
   */
  leaseGuard(owner, sessionId, receipts) {
    const sid = String(sessionId ?? '');
    if (!sid) throw Object.assign(new Error('leaseGuard requires a sessionId'), { code: 'invalid_lease' });
    if (!receipts || typeof receipts !== 'object' || Object.keys(receipts).length === 0) {
      throw Object.assign(new Error('leaseGuard requires the receipts of the hooks it guards'), { code: 'invalid_lease' });
    }
    const key = `${sid}\u0000${owner}`;
    const lease = Object.freeze({
      key, owner, sessionId: sid, receipts: Object.freeze({ ...receipts }),
      instance: this._instanceId, generation: this._hookGeneration, at: Date.now(),
    });
    this._guardLeases.set(key, lease);
    return Object.freeze({
      key,
      release: () => {
        if (this._guardLeases.get(key) === lease) this._guardLeases.delete(key);
      },
    });
  }

  /** 只读观测：这个会话上还挂着哪些租约（`describe()`/事故排查要看的那一面）。 */
  guardLeasesFor(sessionId) {
    const sid = String(sessionId ?? '');
    return [...this._guardLeases.values()]
      .filter((l) => l.sessionId === sid)
      .map((l) => ({ owner: l.owner, generation: l.generation, live: this._leaseIsLive(l) }));
  }

  // ── 会话级策略（R0-180 / P1）────────────────────────────────
  /**
   * 给一个会话绑定**更窄**的能力/只读策略。
   *
   * 为什么需要它：`tools.allowlist` 与 `tools.permissionMode` 都是**进程级**的。一个网关同时
   * 承载只读调查与写入任务时，只读会话不仅能看见写工具，也能真的调它 —— 想让边界成立只能拆
   * “同类任务专用进程”。这里补的是按会话的那一层，判据落在**派发期**（`_dispatchGuard`），
   * 不是提示词里的可见性。
   *
   * 三条不变式：
   *   ① **只能收窄**：与进程级 `tools.permissionMode`、Cell 能力门取交集，永不覆盖它们；
   *      名单里写进程没有的能力不会让它变得可用。
   *   ② **按解析出的能力判**：登记时把名字解析成能力 id（解析不出来当场拒绝），派发时只比
   *      能力 id —— 否则“名字安全、能力危险”的别名又能穿过去（R0-142 的形状）。
   *   ③ **按会话隔离**：键就是 sessionId，一个会话的策略不改变另一个会话的判据。
   *
   * 本层**不判“谁有权设置”**：设置方是宿主（`chat.handle` 的调用方），这里保证的只有
   * “它只能变窄”。真正的租户边界在网关鉴权层。
   */
  async setSessionPolicy(sessionId, policy = {}) {
    const sid = String(sessionId ?? '');
    if (!sid) {
      throw Object.assign(new Error('invalid_session_id: setSessionPolicy needs a session id'),
        { code: 'invalid_session_id' });
    }
    const raw = policy?.capabilities;
    let capIds = null;
    if (raw !== undefined && raw !== null) {
      if (!Array.isArray(raw)) {
        throw Object.assign(new Error('invalid_session_policy: "capabilities" must be an array of capability ids or tool names'),
          { code: 'invalid_session_policy' });
      }
      const resolved = new Set();
      const unknown = [];
      for (const name of raw) {
        if (typeof name !== 'string' || !name) { unknown.push(String(name)); continue; }
        if (this._hasCapability(name)) { resolved.add(name); continue; }
        let capId = null;
        try { capId = (await this._resolveCapability(name)).capId; } catch { capId = null; }
        if (capId && this._hasCapability(capId)) resolved.add(capId);
        else unknown.push(name);
      }
      if (unknown.length) {
        // **不静默丢弃**：名单里写错一个名字，静默忽略会让宿主以为它“限制了”，实际没有。
        throw Object.assign(new Error(
          `invalid_session_policy: ${unknown.join(', ')} resolve to no registered capability; `
          + 'an entry that cannot be resolved would silently grant nothing and prove nothing'),
        { code: 'invalid_session_policy', unknown });
      }
      capIds = resolved;
    }
    const mode = policy?.permission_mode ?? policy?.mode ?? null;
    if (mode !== null && mode !== 'read-only') {
      // 只接受**收窄方向**。ask/auto/full-auto 是 Cell Spec 的模式；让会话自己声明它们
      // 就等于让会话给自己提权。
      throw Object.assign(new Error(
        `unsupported_permission_mode: a session policy may only narrow (accepts "read-only"); got "${String(mode).slice(0, 40)}"`),
      { code: 'unsupported_permission_mode' });
    }
    if (capIds === null && mode === null) {
      throw Object.assign(new Error('invalid_session_policy: a session policy needs "capabilities" and/or permission_mode="read-only"'),
        { code: 'invalid_session_policy' });
    }
    const record = {
      sessionId: sid, capIds, mode,
      source: String(policy?.source ?? 'host').slice(0, 64),
      at: Date.now(),
    };
    this._sessionPolicies.set(sid, record);
    this.core?.emitFast?.('tool.session_policy_bound', {
      sessionId: sid, capabilities: capIds ? [...capIds] : null, permission_mode: mode,
      source: record.source, timestamp: record.at, sourcePlugin: 'tool-executor',
    });
    return this.getSessionPolicy(sid);
  }

  /** 撤销会话策略。给出 `source` 时只撤自己那一份（不误删别人的）。返回是否真的撤了。 */
  clearSessionPolicy(sessionId, { source = null } = {}) {
    const sid = String(sessionId ?? '');
    const cur = this._sessionPolicies.get(sid);
    if (!cur) return false;
    if (source != null && cur.source !== String(source)) return false;
    this._sessionPolicies.delete(sid);
    return true;
  }

  /** 只读视图（副本）：这个会话当前绑着什么策略。 */
  getSessionPolicy(sessionId) {
    const pol = this._sessionPolicies.get(String(sessionId ?? ''));
    if (!pol) return null;
    return {
      session_id: pol.sessionId,
      capabilities: pol.capIds ? [...pol.capIds].sort() : null,
      permission_mode: pol.mode,
      source: pol.source,
      at: pol.at,
    };
  }

  /**
   * 会话策略的派发期判决（**同步**，与 `_dispatchGuard` 同一个契约）。
   * 返回 `null` = 无异议；否则返回与其它派发拒绝同形状的 `{block,code,reason}`。
   */
  _sessionPolicyRefusal(toolName, capId, sessionId) {
    const pol = this._sessionPolicies.get(String(sessionId ?? ''));
    if (!pol) return null;
    const sid = pol.sessionId;
    if (pol.mode === 'read-only' && !this._capabilityIsReadOnly(capId)) {
      return {
        block: true, code: 'permission_denied',
        reason: `permission_denied: session "${sid}" is bound to a read-only session policy, but "${toolName}" resolves to `
          + `${capId == null ? 'an unresolved target' : `"${capId}"`}, which is not a read-only capability.`,
      };
    }
    if (capId == null) {
      return {
        block: true, code: 'capability_denied',
        reason: `capability_denied: session "${sid}" has a session capability policy, and "${toolName}" does not resolve to a `
          + 'registered capability. An unresolved target cannot be proven to be inside the policy.',
      };
    }
    if (pol.capIds && !pol.capIds.has(capId)) {
      return {
        block: true, code: 'capability_denied',
        reason: `capability_denied: capability "${capId}" is not in the session capability policy of "${sid}" `
          + `(allowed: ${[...pol.capIds].sort().join(', ') || '(none)'}). The policy is matched against the resolved `
          + 'capability id and can only narrow what the process already grants.',
      };
    }
    return null;
  }

  /**
   * 按会话策略过滤**展示**用的工具表。
   *
   * 这不是权限门（门在 `_dispatchGuard`）：它只避免“看得见、点了必失败”的谎 —— 模型会据此
   * 反复重试，并把“策略禁止”误判成“工具坏了”。因此解析不出能力的工具**保留**（fail-open）：
   * 展示层的失败不该让一个本来可用的工具消失，真正的拒绝在派发期。
   */
  async visibleToolsForSession(sessionId, tools) {
    const pol = this._sessionPolicies.get(String(sessionId ?? ''));
    if (!pol || !pol.capIds || !Array.isArray(tools) || tools.length === 0) return tools;
    const kept = [];
    const hidden = [];
    for (const t of tools) {
      const name = t?.name ?? t?.function?.name;
      let capId = null;
      try { capId = (await this._resolveCapability(name)).capId; } catch { capId = null; }
      if (capId == null || pol.capIds.has(capId)) kept.push(t);
      else hidden.push(name);
    }
    if (hidden.length) {
      this.core?.log?.('debug', `[tool-executor] tools hidden by session policy of ${pol.sessionId}: ${hidden.join(',')}`);
    }
    return kept;
  }

  /**
   * 这个会话是否处在“必须有门”的保护之下（rc.29）。
   *
   * 有租约就说明有一个 Cell 在守它。这个读数用在一条**没有能力解析**的通路上：legacy 直连
   * 不知道这次调用要落到哪个能力上，所以门无法表态 —— 无法表态就等于不放过。
   *
   * rc.30：**归属也算保护**。关闭后租约被撤（那是正确的），但“曾被登记为 Cell 会话”这件事
   * 不会随租约一起消失；只按租约判会让关闭后的会话变成普通会话（K29-01）。
   */
  isProtectedSession(sessionId) {
    const sid = String(sessionId ?? '');
    if (!sid) return false;
    for (const l of this._guardLeases.values()) if (l.sessionId === sid) return true;
    const rt = this.core.getService?.('cell-runtime');
    return !!(typeof rt?.cellForSession === 'function' && rt.cellForSession(sid));
  }

  /**
   * 派发期的**会话资格**判决（rc.30 / K29-01）：生命周期 + 门存续，一次问完。
   *
   * rc.29 的判据是「有租约就验、没租约不管」。反例正在后半个分句：Cell 正常关闭时
   * `dropGate()` 把钩子和租约一起收走（那是对的 —— 关闭后没有主体再受它保护），此后租约表
   * 里什么都不剩，同一个 sessionId 就被当成了普通会话。**判据不是错了，是随对象一起消失了。**
   *
   * 归属只有一个来源：`cell-runtime` 的登记表（`create()` 真的写进去的 `rec.sessionId`），
   * 不按 `cell-` 前缀猜 —— 前缀既是误判源（手工命名成 `cell-x` 的普通对话）也是漏判源（改过名的 Cell）。
   *
   * 返回 `null` 表示“与本 Core 的 Cell 无关”，调用方必须保持它原有的判据，不据此推任何结论。
   */
  _cellSessionRefusal(sessionId) {
    const sid = String(sessionId ?? '');
    if (!sid) return null;
    const rt = this.core.getService?.('cell-runtime');
    // 生命周期先表态（rc.30 / K29-01）：已关闭/排空中/故障中/执行资格已撤，与门在不在无关。
    const lifecycle = typeof rt?.sessionEligibility === 'function' ? rt.sessionEligibility(sid) : null;
    if (lifecycle && lifecycle.ok === false) {
      return { block: true, code: lifecycle.code || 'execution_revoked', reason: lifecycle.reason };
    }
    const leases = this.guardLeasesFor(sid);
    if (!lifecycle) {
      // 不是本 Core 的 Cell。若这个会话上确实挂着租约（某方主动要求的存续约束），
      // 就按旧判据要求它至少有一条活着的；零租约则是真·普通会话，交回原有判据。
      if (leases.some((l) => l.live)) return null;
      if (leases.length === 0) return null;
      return {
        block: true,
        code: 'cell_gate_unavailable',
        reason: `cell_gate_unavailable: session "${sid}" is under a capability gate lease whose authorisation `
          + 'hooks are no longer live. A dispatch that cannot prove its authorisation contact is in place '
          + 'must be refused, not treated as an ungated session.',
      };
    }
    // **门身份**（rc.31 / K30-02）："有一条活租约"不等于"这是这个 Cell 的那道门"。
    // 同名 owner 可以用新回执覆盖旧租约的 key：表里于是出现一条"活着、但不是我装的门"的记录，
    // 而 `describe().capability_gate.live` 同时是 false。存在性证明必须换成身份证明。
    //
    // 顺序上排在**任务维度之前**：门根本没有，是比"没有任务票据"更结构、也更好处置的事实；
    // 反过来会用一个上层理由盖住下层缺陷（"反正也拒了"），而"拒对了、理由不对"在下一次
    // 改动时就会变成"拒错了"。
    const why = this._gateIdentityFailure(rt?.gateIdentity?.(sid) ?? null, sid);
    if (why) return { block: true, code: 'cell_gate_unavailable', reason: why };
    // **任务维度**（rc.31 / K30-01）：门是好的，但这次调用未必属于当前那个任务。
    const taskCtx = currentTask();
    const dispatch = typeof rt?.dispatchEligibility === 'function'
      ? rt.dispatchEligibility(sid, taskCtx)
      : (typeof rt?.sessionEligibility === 'function' ? rt.sessionEligibility(sid) : null);
    if (dispatch && dispatch.ok === false) {
      return { block: true, code: dispatch.code || 'task_scope_required', reason: dispatch.reason };
    }
    return null;
  }

  /**
   * 门身份核验（rc.31 / K30-02）：活着的必须**就是** `cell-runtime` 当初登记的那道门。
   *
   * 四层，缺一不可：
   *   ① 同一台执行器（实例身份）—— 换了实例，旧回执一律不算数；
   *   ② 回执本身仍能核过（`verifyHook`）—— 被 `removeHooksByOwner` 摘掉就不算；
   *   ③ 这个会话上还挂着**那一条**租约（同一个 key、同一组回执 token）—— 不是"任意一条活租约"；
   *   ④ 那条租约此刻成立（它保的回执都还能核过）。
   *
   * 返回 `null` = 门身份成立；否则返回具名理由（调用方原样拒绝）。
   */
  _gateIdentityFailure(gate, sid) {
    const deny = (why) => `cell_gate_unavailable: session "${sid}" ${why}`;
    if (!gate) return deny('belongs to a registered Cell, but this executor can read no gate identity for it. '
      + 'Without the identity of the original gate there is nothing to verify.');
    if (!gate.installed) {
      return deny(`belongs to cell "${gate.cell_id}", but its capability gate was never installed `
        + 'on this executor (the executor arrived late and no legal re-assembly has happened since).');
    }
    // ① 实例身份：`gate.executor` 是装配时那台执行器的**对象身份**，不可由名字伪造。
    if (gate.executor && gate.executor !== this) {
      return deny(`belongs to cell "${gate.cell_id}", whose capability gate was installed on a different `
        + 'tool-executor instance. A gate installed elsewhere does not constrain this one.');
    }
    if (gate.instance && gate.instance !== this._instanceId) {
      return deny(`belongs to cell "${gate.cell_id}", whose gate was signed by executor instance "${gate.instance}" `
        + `(this one is "${this._instanceId}").`);
    }
    // ② 回执本身：拿**它自己登记的那组**去核，不数 owner 有几条。
    const dead = [];
    for (const [kind, receipt] of Object.entries(gate.receipts || {})) {
      const v = this.verifyHook(receipt);
      if (!v.ok) dead.push(`${kind}:${v.reason}`);
    }
    if (dead.length > 0) {
      return deny(`belongs to cell "${gate.cell_id}", but its own gate receipts are no longer live `
        + `(${dead.join(', ')}). The gate was removed, replaced, or this executor was re-initialised behind it.`);
    }
    // ③ 租约身份：必须是**那一条**，不是"任意一条活着"。
    const lease = gate.lease_key ? this._guardLeases.get(gate.lease_key) : null;
    if (!lease) {
      return deny(`belongs to cell "${gate.cell_id}", but no lease guards its gate key any more. `
        + 'The registration that proved the gate must outlive the dispatch was released.');
    }
    if (lease.sessionId !== sid) {
      return deny('has a gate lease that belongs to a different session; leases are not transferable.');
    }
    const want = gate.tokens.filter(Boolean).sort().join('');
    const have = Object.values(lease.receipts || {}).map((r) => r?.token).filter(Boolean).sort().join('');
    if (want !== have) {
      return deny(`belongs to cell "${gate.cell_id}", but a different lease now occupies its gate key `
        + `(owner "${lease.owner}"). A live lease whose receipts are not the ones this Cell registered is not `
        + 'this Cell\'s gate: existence is not identity.');
    }
    // ④ 租约此刻成立。
    if (!this._leaseIsLive(lease)) {
      return deny(`belongs to cell "${gate.cell_id}", but the lease guarding its gate no longer verifies.`);
    }
    return null;
  }

  /**
   * 公开的派发判决（rc.31）：haotian-lite 等调用方问这里，不各自重写一份状态机。
   * 返回值与 `_dispatchGuard` 的拒绝形状一致（`null` = 放行）。
   */
  cellDispatchVerdict(sessionId) {
    return this._cellSessionRefusal(sessionId);
  }

  /** 租约此刻成立吗：它保的每一条回执都要能核过。 */
  _leaseIsLive(lease) {
    return Object.values(lease.receipts).every((r) => this.verifyHook(r).ok);
  }

  /**
   * 派发前的最后一道复核。**同步**、无 await —— 有 await 就又会开一个窗口。
   * 返回非空即拒绝（形状与 pre-hook 的 `{block, reason, code}` 一致）。
   *
   * 这里的钩子**一律 fail-closed**（没有开关）：出错意味着“无法证明这次调用仍被授权”，
   * 此时放行的代价是不可撤销的副作用；出错单独计数并发事件，让“判据坏了”与“策略拒绝”分开可见。
   */
  _dispatchGuard(toolName, capId, args, sessionId) {
    // ① 执行器**自己**的只读判据，按解析出的能力而不是请求的工具名。
    // 不能只留在 `_checkPreFlight`：那里的 `_checkModeReadOnly` 也看名字，而名字会撒谎 ——
    // 工具名 `read_file` 在只读清单里、`provides: tool.write`，预检按名字放行、这里按能力写盘。
    // 放在派发期：只有到这一步才知道这次调用真正落到哪个能力上。
    const mode = this.core.get?.('tools.permissionMode') || 'auto';
    if (mode === 'read-only' && !this._capabilityIsReadOnly(capId)) {
      return {
        block: true,
        reason: `permission_denied: tools.permissionMode is read-only, but "${toolName}" resolves to `
          + `${capId == null ? 'an unresolved target' : `"${capId}"`}, which is not a read-only capability.`,
        code: 'permission_denied',
      };
    }

    // ② 会话级策略（R0-180 / P1）：只能比上一段**更窄**，不可能更宽。
    // 放在能力已解析之后、任何 await 之前：这里比的是解析出的能力 id，不是请求名。
    const sessionRefusal = this._sessionPolicyRefusal(toolName, capId, sessionId);
    if (sessionRefusal) return sessionRefusal;

    // ③ 宿主/上层注册的派发期复核。
    for (const hook of this._dispatchHooks) {
      try {
        const r = hook.fn(toolName, capId, args, sessionId);
        // 同步契约：返回 Promise 说明这个钩子做不了"此刻"的判定。await 它会重新打开窗口，
        // 把它当放行会让所有调用绕过复核。**明确拒绝**是唯一不撒谎的选择。
        //
        // `typeof r.then` 本身也可能是攻击面（getter 抛错）：
        // 取不到就等于"无法证明它是同步的"，按 Promise 处理（拒绝），不让它把复核自己炸掉。
        let thenable = false;
        try { thenable = !!r && typeof r.then === 'function'; } catch { thenable = true; }
        if (thenable) {
          this._hookErrors++;
          // **拒绝之后还必须收尸**（H26-03）：这条钩子已被判为"做不了此刻的判定"，但它返回的
          // Promise 仍然存在。不接 rejection 处理，`async () => { throw }` 就在决策之外再抛一次
          // 进程级 unhandledRejection —— 一次本已拒绝的调用顺手把进程带走。决策不变，只是消费掉。
          this._consumeRejectedThenable(r, hook.owner);
          this.core.log('warn', `[tool-executor] dispatch hook (${hook.owner}) returned a Promise; dispatch hooks must be synchronous`);
          return {
            block: true,
            reason: `hook_error: dispatch hook (${hook.owner}) returned a Promise; a dispatch-time check must be `
              + 'synchronous — awaiting it would reopen the very window this hook exists to close',
            code: 'HOOK_ERROR',
          };
        }
        if (r && r.block) return r;
      } catch (err) {
        this._hookErrors++;
        this.core.log('warn', `[tool-executor] dispatch hook (${hook.owner}) threw: ${err.message}`);
        this.core.emitFast?.('tool.dispatch_hook_error', {
          tool: toolName, capability: capId, owner: hook.owner, error: err.message,
          timestamp: Date.now(), sourcePlugin: 'tool-executor',
        });
        return {
          block: true,
          reason: `hook_error: the dispatch-time authorisation check for this call (${hook.owner}) failed to complete: ${err.message}`,
          code: 'HOOK_ERROR',
        };
      }
    }

    // ③ 保护性注册租约：**判据还在不在**（R28-A）。
    //
    // 上面两步只回答“此刻表里有哪些判据、它们说什么”。钩子被摘掉时，表里就是零条 ——
    // 遍历不到任何拒绝，于是放行。这不是判据说错，而是**判据消失了却没人记得它该在**。
    // 租约就是那个记忆：这个会话被保护过，就必须拿得出当初的回执；拿不出就拒绝。
    // 检查放在最后、且同步：这里与 handler 之间没有 await。
    const sid = String(sessionId ?? '');
    if (sid) {
      const broken = [];
      for (const lease of this._guardLeases.values()) {
        if (lease.sessionId !== sid) continue;
        const missing = Object.entries(lease.receipts)
          .filter(([, r]) => !this.verifyHook(r).ok)
          .map(([kind, r]) => `${kind}:${this.verifyHook(r).reason}`);
        if (missing.length > 0) broken.push(`${lease.owner}(${missing.join(',')})`);
      }
      if (broken.length > 0) {
        return {
          block: true,
          reason: `cell_gate_unavailable: session "${sid}" is under a capability gate lease whose authorisation `
            + `hooks are no longer live (${broken.join('; ')}). The gate was removed after the task started; `
            + 'a dispatch that cannot prove its authorisation contact is still in place must be refused, '
            + 'not allowed to fall back to an ungated path.',
          code: 'cell_gate_unavailable',
        };
      }

      // ④ 会话归属（rc.30 / K29-01）：**表里没有租约 ≠ 这个会话可以被当成普通会话**。
      // 上面三步回答的都是“表里此刻有什么”；这一步回答“这个会话本来属于谁”。
      // 关闭后的 Cell、迟到的执行器（从未装过门）、换代后留在旧实例上的租约，
      // 在租约表里都是“零条”，而零条不是放行理由。
      const ownership = this._cellSessionRefusal(sid);
      if (ownership) return ownership;
    }
    return null;
  }

  _checkBashCommand(cmd, mode) {
    if (mode !== 'auto-edit') return { ok: true };

    const cmdNoQuotes = cmd.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '');
    const dangerousPatterns = [
      // H6：**分隔符就是第二条命令**。修前这里只认管道与重定向，而首词判定又只看
      // `cmd.split(/\s+/)[0]`，于是 `cat a.txt; touch /tmp/x` 的首词是 `cat` ⇒ 整条放行，
      // 连 `_checkModeAutoEdit` 里的 privacy.confirmAction 也一起绕过。
      // `&&`/`||` 排在 `&`/`|` 前面：两个都是拒绝，只是理由要说对。
      { pattern: /;/, reason: 'Command separator ";" not allowed' },
      { pattern: /&&/, reason: 'Command separator "&&" not allowed' },
      { pattern: /\|\|/, reason: 'Command separator "||" not allowed' },
      { pattern: /[\r\n]/, reason: 'Newline in command not allowed' },
      { pattern: /(^|[^&])&([^&]|$)/, reason: 'Background "&" not allowed' },
      { pattern: /\|/, reason: 'Pipe not allowed' },
      { pattern: />>?/, reason: 'Redirect not allowed' },
      { pattern: /<[^<]/, reason: 'Input redirect not allowed' },
      { pattern: /&>>|>&/, reason: 'Compound redirect not allowed' },
      { pattern: /<\(|>\(/, reason: 'Process substitution not allowed' },
      { pattern: /-exec|-execdir/, reason: 'Subcommand not allowed' },
      { pattern: /xargs/, reason: 'xargs not allowed' },
      { pattern: /\$\(/, reason: 'Command substitution not allowed' },
      { pattern: /\$\{/, reason: 'Variable substitution not allowed' },
      { pattern: /\$\w+/, reason: 'Environment variable not allowed' },
      { pattern: /`/, reason: 'Backtick substitution not allowed' },
    ];
    for (const { pattern, reason } of dangerousPatterns) {
      if (pattern.test(cmdNoQuotes)) {
        return { ok: false, reason: `Bash command blocked: ${reason}` };
      }
    }

    const firstWord = cmd.trim().split(/\s+/)[0].toLowerCase();
    const READ_OPS = [
      'cat', 'head', 'tail', 'less', 'more', 'wc', 'ls', 'find', 'grep',
      'stat', 'file', 'du', 'diff', 'echo', 'printf', 'which', 'type',
      'env', 'pwd', 'date', 'whoami', 'id', 'tree', 'sort', 'uniq', 'cut',
    ];
    const WRITE_OPS = [
      'mkdir', 'touch', 'cp', 'mv', 'rm', 'rmdir', 'chmod', 'chown', 'ln',
      'dd', 'shred', 'truncate', 'tee', 'awk', 'sed',
    ];
    const NET_OPS = ['curl', 'wget', 'nc', 'ssh', 'scp', 'sftp', 'rsync', 'ftp', 'telnet'];
    const SYS_OPS = ['kill', 'pkill', 'killall', 'reboot', 'shutdown', 'systemctl', 'service', 'init'];

    if (READ_OPS.includes(firstWord)) return { ok: true };
    if (WRITE_OPS.includes(firstWord) || NET_OPS.includes(firstWord) || SYS_OPS.includes(firstWord)) {
      return { ok: false, reason: `Auto-edit mode: "${firstWord}" requires confirmation` };
    }
    return { ok: false, reason: `Auto-edit mode: unknown command "${firstWord}" requires confirmation` };
  }

  _sanitizeOutput(content) {
    if (content === null || content === undefined) return content;
    if (typeof content === 'string') return this._sanitizeString(content);
    if (Array.isArray(content)) return content.map(item => this._sanitizeOutput(item));
    if (typeof content === 'object') {
      const result = {};
      for (const [key, value] of Object.entries(content)) {
        result[key] = this._sanitizeOutput(value);
      }
      return result;
    }
    return content;
  }

  _sanitizeString(str) {
    return str
      .replace(/<\|im_start\|>/gi, '[im_start]')
      .replace(/<\|im_end\|>/gi, '[im_end]')
      .replace(/<\|system\|>/gi, '[system]')
      .replace(/<\|user\|>/gi, '[user]')
      .replace(/<\|assistant\|>/gi, '[assistant]')
      .replace(/<\/s>/gi, '[/s]')
      .replace(/<system>/gi, '[system]')
      .replace(/<user>/gi, '[user]')
      .replace(/<assistant>/gi, '[assistant]')
      .replace(/<script[^>]*>/gi, '[script]')
      .replace(/<\/script>/gi, '[/script]')
      .replace(/<img[^>]*onerror\s*=/gi, '[img blocked]')
      .replace(/<iframe[^>]*>/gi, '[iframe blocked]')
      .replace(/javascript:/gi, 'blocked:')
      .replace(/\s+on[a-z]+\s*=/gi, ' blocked=')
      .replace(/data:/gi, 'blocked:')
      .slice(0, 50000);
  }

  _filterSensitive(obj) {
    const filterString = (str) => {
      if (typeof str !== 'string') return str;
      let result = str;
      for (const kw of this._sensitiveKeywords) {
        const patterns = [
          new RegExp(`"${kw}"\\s*:\\s*"[^"]*"`, 'gi'),
          new RegExp(`"${kw}"\\s*=\\s*"[^"]*"`, 'gi'),
          new RegExp(`${kw}\\s*=\\s*[^\\s&]+`, 'gi'),
          new RegExp(`${kw}\\s*:\\s*[^\\s\\n]+`, 'gi'),
          new RegExp(`"${kw}":\\s*[^,}\\n]+`, 'gi'),
        ];
        for (const regex of patterns) {
          result = result.replace(regex, `${kw}=[REDACTED]`);
        }
      }
      return result.slice(0, 500);
    };

    const filterObject = (o) => {
      if (o === null || o === undefined) return o;
      if (typeof o === 'string') return filterString(o);
      if (Array.isArray(o)) return o.map(item => filterObject(item));
      if (typeof o === 'object') {
        const result = {};
        for (const [key, value] of Object.entries(o)) {
          if (this._sensitiveKeywords.some(kw => key.toLowerCase().includes(kw))) {
            result[key] = '[REDACTED]';
          } else {
            result[key] = filterObject(value);
          }
        }
        return result;
      }
      return o;
    };

    const filtered = filterObject(obj);
    return JSON.stringify(filtered).slice(0, 500);
  }

  _checkRateLimit(toolName, sessionId) {
    const maxCalls = this.core.get('tools.rateLimit.maxCalls') || 30;
    const windowMs = this.core.get('tools.rateLimit.windowMs') || 60000;
    // 计数必须按**会话**分桶：键里只有工具名时两个会话共用额度，“一个 agent 饿死另一个”就成立。
    const key = `${sessionId || '__anon__'}:${toolName}`;
    const now = Date.now();
    let calls = this._rateCalls.get(key) || [];
    while (calls.length && now - calls[0] > windowMs) calls.shift();
    if (calls.length >= maxCalls) {
      return { ok: false, reason: `Rate limit exceeded for ${toolName}`, sessionId: sessionId || null };
    }
    calls.push(now);
    this._rateCalls.set(key, calls);
    return { ok: true };
  }

  _normalizeResult(raw, { preserve = false } = {}) {
    if (raw === null || raw === undefined) return { ok: false, content: 'no result' };
    // 已判定为成功、但含同名业务字段的载荷，**原样保留完整载荷**：
    // 不能被 `if (raw.error)` 分支吞掉其它业务字段（那会让消费方看不到真实数据）。
    if (preserve) {
      if (typeof raw === 'string') return { ok: true, content: raw };
      try { return { ok: true, content: JSON.stringify(raw) }; } catch { return { ok: true, content: String(raw) }; }
    }
    if (typeof raw === 'string') return { ok: true, content: raw };
    if (typeof raw !== 'object') return { ok: true, content: String(raw) };
    if (raw.ok === true && raw.content !== undefined) return raw;
    if (raw.ok === false && raw.error !== undefined) return { ok: false, content: raw.error };
    if (raw.error) return { ok: false, content: raw.error };
    if (raw.content !== undefined) return { ok: true, content: raw.content };
    if (raw.result !== undefined) return { ok: true, content: raw.result };
    if (raw.status === 200 || raw.status === 'success') {
      return { ok: true, content: raw.body || raw.data || JSON.stringify(raw) };
    }
    return { ok: true, content: JSON.stringify(raw) };
  }

  /**
   * Cell 的**执行资格**判据（只对 `cell-<id>` 会话生效）。
   * 返回 `null` = 无异议（不是 Cell 会话 / Cell 仍在册）；返回对象 = 具名拒绝。
   * 三种拒绝分开命名，因为含义不同：`receipt_cell_closed` 回执仍可审计但不该再由模型读，
   * `receipt_cell_faulted` 状态不可信先修 Cell，`receipt_cell_unknown` 可能是别的进程的 Cell。
   */
  _cellEligibilityFor(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId.startsWith('cell-')) return null;
    const rt = this.core?.getService?.('cell-runtime');
    if (!rt || typeof rt.describe !== 'function') return null;   // 未装配 Cell 运行时：这条门不存在
    const cellId = sessionId.slice('cell-'.length);
    let info = null;
    try { info = rt.describe(cellId); } catch { info = null; }
    if (!info) {
      return { ok: false, code: 'receipt_cell_unknown',
        error: `action.inspect: session "${sessionId}" looks like a Cell session but the Cell runtime `
          + `does not know cell "${cellId}" (another process, or already removed) — refusing to disclose` };
    }
    if (info.state === 'stopped') {
      return { ok: false, code: 'receipt_cell_closed',
        error: `action.inspect: cell "${cellId}" has been closed (state=stopped); its receipts stay auditable `
          + 'by the host, but are no longer disclosed to the model' };
    }
    if (info.state === 'faulted') {
      return { ok: false, code: 'receipt_cell_faulted',
        error: `action.inspect: cell "${cellId}" is faulted${info.fault_reason ? ' (' + info.fault_reason + ')' : ''}; `
          + 'its recorded state is not trustworthy — repair the Cell before reading receipts' };
    }
    return null;
  }

  // 三条约束：**按 session 隔离**（只能读自己会话的回执，跨会话是信息越权）；有预算，超了
  // 截断并**明说被截断**（不静默丢字段）；查不到就具名失败，不返回空对象冒充“没有事情发生”。
  inspectAction(actionId, trustedSessionId, budget = 2000) {
    const sessionId = trustedSessionId == null || trustedSessionId === '' ? null : String(trustedSessionId);
    if (sessionId === null) {
      return { ok: false, code: 'receipt_scope_missing',
        error: 'action.inspect requires a trusted caller scope; the calling session could not be established '
          + '(the scope must come from the host execution context, never from a tool argument) — refusing to disclose' };
    }
    const rec = this._receipts.get(String(actionId));
    if (!rec) {
      return { ok: false, code: 'receipt_not_found',
        error: `No action receipt "${actionId}" in memory (it may have been evicted, or produced by another session/process). `
          + 'Receipts are volatile by design — see ADR-04.' };
    }
    // 归属缺失的留档（`sessionId === null`）同样不得被任何人读到：
    // "不知道是谁的"不等于"谁都可以看"。伪造/异常路径产生的记录按最严处理。
    if (rec.sessionId == null) {
      return { ok: false, code: 'receipt_not_yours',
        error: `Action receipt "${actionId}" has no recorded owner; an unowned record is not disclosable` };
    }
    if (String(rec.sessionId) !== sessionId) {
      // 跨会话读别人的动作明细 = 信息越权。与能力门同一立场：看不见别人的东西。
      return { ok: false, code: 'receipt_not_yours',
        error: `Action receipt "${actionId}" belongs to another session; refusing to disclose it` };
    }
    // **执行资格**判据 —— 会话对上了还不够，产生这条回执的那个 Cell 必须仍在册且未收口：
    // 会话标识是长期的，Cell 的执行资格是阶段性的。判据取运行事实 `cell-runtime.describe()`，
    // 不取回执里的自述字段；只对 `cell-<id>` 生效 —— 普通对话没有 Cell 记录，
    // 不能因为“查不到 Cell”就拒绝，那会把所有非 Cell 用法一起打死。
    const cellGate = this._cellEligibilityFor(sessionId);
    if (cellGate) return cellGate;
    const full = JSON.stringify(rec.receipt, null, 1);
    const cap = Number.isInteger(budget) && budget > 0 ? budget : 2000;
    if (full.length <= cap) return { ok: true, receipt: rec.receipt, truncated: false };
    return {
      ok: true, truncated: true, full_length: full.length, budget: cap,
      note: `truncated to ${cap} chars; the fields below are the head of the JSON, not the whole truth`,
      receipt_text: full.slice(0, cap),
    };
  }

  /**
   * 把**本次调用**的回执转成一行附注，并留档供 `action.inspect` 展开。
   * 回执由工具经 `publishReceipt()` 投进调用上下文，这里取走 —— 不能改成读工具实例上的
   * “最近一次”：工具是单例，两个会话并发时会把别人的回执当自己的附注报出去。
   */
  _receiptNote(sessionId) {
    const r = takeReceipt();
    if (!r || typeof r !== 'object' || !r.action_id) return null;
    // 留档：**内存 + 有界**，不落盘（与回执自身的 `persistence: 'volatile'` 一致）。
    // 归属取**宿主**给的 `sessionId`，不取回执内容里的字段 —— 两者不一致时以宿主为准。
    this._receipts.set(r.action_id, { receipt: r, sessionId: sessionId || null, at: Date.now() });
    while (this._receipts.size > this._receiptMax) {
      this._receipts.delete(this._receipts.keys().next().value);
    }
    const parts = [];
    if (r.application === 'applied') {
      const e = r.effect || {};
      const kind = e.created === true ? '新建'
        : (e.before_sha256 && e.before_sha256 !== e.after_sha256 ? '修改' : '写入');
      parts.push(`${kind} ${r.target?.path ?? '?'}`);
      if (typeof e.changed_bytes === 'number') parts.push(`差异 ${e.changed_bytes} 字节`);
      if (e.mismatch) parts.push('磁盘内容与预期不符');
    } else {
      parts.push(`应用状态=${r.application || '?'}`);
    }
    if (r.verification === 'not_run') parts.push('验证未执行');
    else if (r.verification) parts.push(`验证=${r.verification}`);
    if (r.recovery?.supported !== true) parts.push('不可撤销');
    if (r.persistence === 'volatile') parts.push('回执未持久化');
    const body = parts.join('；').slice(0, 200);
    return `[回执 ${r.action_id}] ${body}（明细：action.inspect ${r.action_id}）`.slice(0, 300);
  }

  _recordMetrics(toolName, duration, ok) {
    if (!(this._metrics instanceof Map)) {
      this._metrics = new Map();
    }
    let m = this._metrics.get(toolName);
    if (!m) {
      m = { count: 0, errors: 0, totalTime: 0 };
      this._metrics.set(toolName, m);
    }
    m.count++;
    m.totalTime += duration;
    if (!ok) m.errors++;
  }

  getMetrics() {
    const r = {};
    for (const [name, m] of this._metrics) {
      r[name] = {
        count: m.count,
        errors: m.errors,
        errorRate: m.count ? (m.errors / m.count).toFixed(2) : 0,
        avgTimeMs: m.count ? Math.round(m.totalTime / m.count) : 0,
      };
    }
    return r;
  }

  _addAudit({ tool, sessionId, args, result, duration, status, code, reason, fence_error }) {
    if (!(this._auditLog instanceof Map)) this._auditLog = new Map();
    let entries = this._auditLog.get(sessionId);
    if (!entries) {
      entries = [];
      this._auditLog.set(sessionId, entries);
    }
    entries.push({
      tool,
      sessionId,
      ...(code ? { code } : {}),
      ...(reason ? { reason: String(reason).slice(0, 200) } : {}),
      // 围栏故障是**异常证据**，不是执行状态：留在条目里，才能回答“那次到底是工具坏了还是围栏坏了”。
      ...(fence_error ? { fence_error } : {}),
      args: this._filterSensitive(args),
      result: this._filterSensitive(result),
      duration,
      status,
      timestamp: Date.now(),
    });
    while (entries.length > 500) entries.shift();
  }

  /**
   * 审计读取面：**独立快照**，不是内部记录。
   *
   * `.slice(-limit)` 只换了数组壳，元素仍是同一条内部记录 —— `getAuditLog('s')[0].status =
   * 'forged-success'` 就把已存在的证据改掉了，而"审计"这个名字的全部意义就是**只读**。
   * 与 Core 的 `getObserverErrors` 同一个口径：判据落到元素上，不是落到数组上。
   *
   * 条目里的 `args` / `result` 由 `_filterSensitive` 产出，本来就是字符串；其余字段是
   * 字符串/数字/布尔，故深复制不丢信息。万一将来混入不可克隆载荷，退化为浅复制并冻结，
   * 仍不交出可写引用。
   */
  getAuditLog(sessionId, limit = 50) {
    const entries = this._auditLog.get(sessionId) || [];
    return entries.slice(-limit).map((e) => {
      try { return structuredClone(e); }
      catch { return Object.freeze({ ...e }); }   // SNAPSHOT_DEGRADED：含不可克隆载荷时
    });
  }

  clearAuditLog(sessionId) {
    this._auditLog.delete(sessionId);
  }

  async _getFromCache(toolName, args, scope = null) {
    const key = await this._cacheKey(toolName, args, scope);
    const entry = this._cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expireAt) {
      this._cache.delete(key);
      this._cacheOrder = this._cacheOrder.filter(k => k !== key);
      return null;
    }
    this._cacheOrder = this._cacheOrder.filter(k => k !== key);
    this._cacheOrder.push(key);
    return entry.value;
  }

  _setCache(toolName, args, value, scope = null) {
    this._cacheKey(toolName, args, scope).then(key => {
      if (this._cache.size >= this._cacheMax && !this._cache.has(key)) {
        const oldest = this._cacheOrder.shift();
        if (oldest) this._cache.delete(oldest);
      }
      this._cache.set(key, { value, expireAt: Date.now() + this._cacheTTL });
      this._cacheOrder.push(key);
    }).catch(err => { this.core?.log?.('warn', '[ToolExecutor] Failed to set cache: ' + (err?.message || 'unknown')); });
  }

  async _cacheKey(toolName, args, scope = null) {
    let mtime = 0;
    // 相对路径按**本调用的会话根**（`_effectiveWorkDir`）解析，不用 process.cwd()：子代理的
    // args.path 是仓库根相对路径，用 cwd 会 stat 到 ENOENT ⇒ mtime 恒 0 ⇒ 缓存永不因文件变化失效；
    // 按会话取还让同一 `a.txt` 在两个会话里不会互相冒用 30s 的旧内容。
    const workDir = this._effectiveWorkDir(args?._sessionId);
    const p = args.path || args.filePath || args.file_path;
    if (p) {
      try {
        const full = p.startsWith('/') ? p : join(workDir, p);
        const s = await stat(full);
        mtime = s.mtimeMs;
      } catch (err) { this.core?.log?.('warn', '[ToolExecutor] Failed to stat path for cache key: ' + (err?.message || 'unknown')); }
    }
    // 缓存键必须**只排掉纯传输元数据** `_tcId` / `_traceId`：它们每次调用都不同，算进键里
    // 缓存就永不命中（`executeBatch` 每个 tool_call 都给新 `_tcId`）。
    // **判据字段必须留在键里**（`_principal` / `_caller` / `_scope` / `_sessionId`）：排掉它们
    // 等于把“缓存”变成“越权读取”（不同主体拿到同一份结果）。别顺手扩大这个名单 ——
    // 扩大之后不会有任何测试变红。
    const cacheArgs = { ...args };
    delete cacheArgs._tcId;
    delete cacheArgs._traceId;
    // **授权维度必须进键**：`args` 里的 `_principal` / `_caller` / `_scope`
    // 早就被 `_executeOneV2` 入口剥掉了（模型能填的字段不能当判据），所以真实主体只能
    // 由宿主从**可信通道**传进来 —— 走 `scope` 参数，不走 `args`。
    // 缓存键里没有主体 ⇒ 甲的只读结果会被乙命中，而真 handler 只跑过一次。
    // **登记号也必须进键**（DA-13）：能力被撤销后按同名重新登记，旧 handler 的结果仍在
    // 缓存里，新 handler 从未执行 —— 名字没变，但"这是谁算的"已经变了。
    const hash = createHash('sha256')
      .update(JSON.stringify({
        tool: toolName, args: cacheArgs, mtime,
        principal: scope?.principal ?? null,
        caller: scope?.caller ?? null,
        scope: scope?.scope ?? null,
        registrationId: scope?.registrationId ?? null,
      }))
      .digest('hex')
      .slice(0, 16);
    return hash;
  }

  _debugLog(toolName, args, result, duration) {
    if (!this._debugStream) return;
    const line = JSON.stringify({
      tool: toolName,
      args: this._filterSensitive(args),
      result: this._filterSensitive(typeof result === 'string' ? { content: result.slice(0, 1000) } : result),
      duration,
      timestamp: Date.now(),
    });
    this._debugStream.write(line + '\n');
  }

  _recordPreference(sessionId, toolName) {
    let prefs = this._preferences.get(sessionId);
    if (!prefs) {
      prefs = {};
      this._preferences.set(sessionId, prefs);
    }
    prefs[toolName] = (prefs[toolName] || 0) + 1;
  }

  getPreferredTools(sessionId, minCount = 3) {
    const prefs = this._preferences.get(sessionId) || {};
    return Object.entries(prefs)
      .filter(([, count]) => count >= minCount)
      .sort((a, b) => b[1] - a[1])
      .map(([tool]) => tool);
  }

  clearPreferences(sessionId) {
    this._preferences.delete(sessionId);
  }

  _checkComposeRisk(steps) {
    const hasFetch = steps.some(s => s.tool === 'tool-fetch');
    const readTools = [
      'tool-read', 'tool-bash', 'tool-grep', 'tool-glob', 'tool-db',
      'tool-git', 'tool-search', 'tool-stat', 'tool-list', 'tool-diff',
    ];
    const hasRead = steps.some(s => readTools.includes(s.tool));
    if (hasFetch && hasRead) {
      return {
        ok: false,
        reason: 'Compose risk: reading files/system data and sending to external network requires confirmation',
      };
    }
    return { ok: true };
  }

  async executeCompose(steps, context) {
    if (steps.some(s => s.tool === 'tool-compose')) {
      return { ok: false, error: 'Recursive compose not allowed' };
    }
    const riskCheck = this._checkComposeRisk(steps);
    if (!riskCheck.ok) {
      return { ok: false, error: riskCheck.reason };
    }
    const timeout = context.timeout || 90000;
    const start = Date.now();
    const results = [];
    for (const step of steps) {
      if (Date.now() - start > timeout) {
        return { results, error: 'Compose timeout', completedSteps: results.length };
      }
      const result = await this.executeOne(step.tool, step.args, context.sessionId, context.chainId);
      results.push(result);
      if (result.error && !step.continueOnError) {
        return { results, error: result.error, completedSteps: results.length };
      }
    }
    return { results, completed: true };
  }

  async _checkPermissionMode(mode, toolName, args, sessionId) {
    const VALID_MODES = ['ask', 'read-only', 'auto-edit', 'auto', 'full-auto'];
    // **未知模式必须 fail-closed**：不能“警告一句再当 auto 放行” —— `Read-Only` / `read_Only`
    // 这类写法差异会把整条权限链变成 no-op（同一份配置换个大小写就从 blocked 变 succeeded）。
    // 配置写错是**宿主**的事，不该由模型的一次写盘来买单。
    if (!VALID_MODES.includes(mode)) {
      this.core.log('error', `[ToolExecutor] 未知 permissionMode "${mode}"（合法值：${VALID_MODES.join('/')}）→ 拒绝执行`);
      return {
        ok: false,
        reason: `Unknown permission mode "${mode}": refusing to guess (valid: ${VALID_MODES.join('/')})`,
      };
    }
    if (mode === 'full-auto') return this._checkModeFullAuto(toolName, args);
    if (mode === 'auto') return { ok: true };
    if (mode === 'read-only') return this._checkModeReadOnly(toolName);
    if (mode === 'auto-edit') return this._checkModeAutoEdit(toolName, args);
    if (mode === 'ask') return this._checkModeAsk(toolName, args);
    return { ok: true };
  }

  _checkModeFullAuto(toolName, args) {
    this.core.log('warn', '[AUDIT] full-auto tool executed', {
      tool: toolName, args: JSON.stringify(args).slice(0, 500), timestamp: Date.now(), mode: 'full-auto',
    });
    return { ok: true };
  }

  _checkModeReadOnly(toolName) {
    // 名单来自 `./tool-policy.js` 的单一真相（与 cell-runtime 的 Cell 级只读门同源），不要各写一份。
    if (isReadonlyTool(toolName)) return { ok: true };
    // 请求名本身就是一个**已登记的只读能力 id** 时也放行：否则 `action.inspect`（纯内存读取）
    // 在只读 Cell 里被拒，而工具输出每条回执都在提示模型去调它。
    if (isReadonlyCapability(toolName)) return { ok: true };
    return { ok: false, reason: `Read-only mode: "${toolName}" is not allowed` };
  }

  /**
   * 只读模式的**能力判据** —— 派发期用真实能力复核。
   *
   * 不能只有 `_checkModeReadOnly`：它判**工具名**，真正被调用的是**能力**，两者不是一一对应
   * （命名约定 / `provides[]` / `owner` 反查三条映射来源）。例子：`permissionMode='read-only'`
   * 的 Cell 调 `execute_command`，它 `provides: tool.write` —— 名字看着不像写，能力是写。
   * 判据取“未登记即非只读”（见 `isReadonlyCapability`）。
   */
  _capabilityIsReadOnly(capId) {
    if (capId == null) return false;   // 目标不明 ⇒ 不能声称它只读
    return isReadonlyCapability(capId);
  }

  /**
   * 能力是否已被冻结。
   *
   * 判据不自己算：冻结状态住在 core 的私有 Map 里（插件读它就是门禁禁止的形状），
   * 由 core 广播 `core:capability.frozen`，执行器订阅后记进 `_frozenCaps`。
   * 语义上也更对：冻结的意思是“从现在起不再用旧结果”，正确动作是收到通知就**丢弃缓存**。
   * 边界：这是**进程内**通知，别的进程上发生的冻结本执行器看不到。
   */
  _capabilityIsFrozen(capId) {
    if (capId == null) return false;
    return this._frozenCaps.has(capId);
  }

  /** 冻结事件的处理：记下能力 id，并**丢弃**它此前的结果缓存。 */
  _onCapabilityFrozen({ capability } = {}) {
    if (capability == null) return;
    this._frozenCaps.add(capability);
    // 缓存键是 (toolName, args, mtime) 的哈希，不含能力 id —— 故只能整体清空。
    // 这是刻意的：宁可清多一点（只读缓存重建成本很低），也不要漏掉一条已失效的结果。
    this._cache.clear();
    this._cacheOrder = [];
  }

  async _checkModeAutoEdit(toolName, args) {
    if (toolName !== 'tool-bash' && toolName !== 'execute_command') return { ok: true };
    // 与硬拦同口径：`command ?? cmd ?? script`。四处（本层/硬拦/围栏/tool-bash）必须是同一取法 ——
    // 同一个概念两套取法，就一定有一层漏掉（`_raw` 那条旁路就是这么进来的）。
    const cmd = args?.command ?? args?.cmd ?? args?.script ?? '';
    const bashCheck = this._checkBashCommand(cmd, 'auto-edit');
    if (bashCheck.ok) return { ok: true };
    const privacy = this.core.getService('privacy');
    if (privacy) {
      const confirmResult = await privacy.confirmAction(cmd);
      if (confirmResult.ok) return { ok: true };
      return { ok: false, reason: confirmResult.reason };
    }
    return { ok: false, reason: `Confirmed blocked: ${bashCheck.reason}` };
  }

  _checkModeAsk(toolName, args) {
    this.core.emitFast('tool.awaiting-approval', { tool: toolName, args, timestamp: Date.now(), sourcePlugin: 'tool-executor' });
    return { ok: false, reason: 'Ask mode: tool execution requires human approval' };
  }

  async executeOne(toolName, args, sessionId, chainId, trusted = null) {
    return this._executeOneV2(toolName, args, sessionId, chainId, trusted);
  }

  async _executeOneV2(toolName, args, sessionId, chainId, trusted = null) {
    const t0 = Date.now();
    const callId = toolName + '_' + t0;

    // 会话标识随参数下发：`core.callCapability` 的合同是 `handler(params)`，工具拿不到
    // sessionId，`tool-todo` 这类“按会话分桶”的工具就只能退回进程级数组、两个会话共用一份。
    //
    // **先剥掉模型自报的同名控制字段，再由宿主写**：控制字段是**宿主→工具**的单向下行通道，
    // 不是工具入参。模型能给它赋值，它就成了上行提权通道（传 `_sessionId:'sess-B'` 就能按
    // 别人的工作区解析、把文件写进别人的目录）。一律先删后写：有宿主值就写，没有就保证不存在。
    delete args._sessionId;
    delete args._principal;
    delete args._caller;
    delete args._scope;
    delete args._cellId;
    delete args._taskId;
    delete args._incarnationId;
    delete args._attempt;
    // `_traceId` 不在此剥离：`executeBatch` 在调 `executeOne` 之前就用宿主值覆写了它，
    // 模型经真实入口自报的值到不了这里。判断“能不能伪造”必须走真实入口，绕开入口的探针结论是假的。
    //
    // `_raw` 必须剥离：`tool-bash` 执行 `command || _raw`，而三层判据都读 `command ?? cmd ?? script`，
    // 于是 `{command:'', _raw:'<任意危险命令>'}` 一层都拦不住，工具照常执行。
    // 修法取**入口剥离**而不是逐层补 `|| args._raw`：补 `||` 只是让三层暂时对齐，下一个读命令的
    // 地方仍会漏；剥掉之后“命令只从 `command` 来”成为唯一事实。本仓没有宿主写 `_raw` 的位置。
    delete args._raw;
    // 宿主注入的会话标识（不是模型给的）。空值不注入：工具自己回落到进程默认根，而不是看到 `null`。
    if (sessionId) args._sessionId = sessionId;

    // AR-C01：把整次执行放进**本次调用**的上下文里。
    // 回执从这里取出，会话归因从这里取，两者都不再依赖"工具实例的最近一次"。
    return runInCallContext({ callId, sessionId: sessionId || null, tool: toolName },
      () => this._executeOneInner(toolName, args, sessionId, chainId, callId, t0, trusted));
  }

  async _executeOneInner(toolName, args, sessionId, chainId, callId, t0, trusted = null) {
    const blocked = await this._checkPreFlight(toolName, args, sessionId, chainId);
    if (blocked) return blocked;

    this._emitToolStart(toolName, args, sessionId, callId);

    // 结果契约由派发方解析（它才持有 tool 对象与 capId），成功判定用它，不再二次猜。
    const meta = {};
    try {
      const result = await this._doToolExecute(toolName, args, sessionId, trusted, meta);
      return await this._finishExecuteSuccess(toolName, args, result, sessionId, chainId, callId, t0, meta);
    } catch (err) {
      return await this._finishExecuteError(toolName, args, err, sessionId, chainId, callId, t0);
    }
  }

  async _checkPreFlight(toolName, args, sessionId, chainId) {
    const mode = this.core.get('tools.permissionMode') || 'auto';
    if (mode === 'full-auto') {
      this.core.log('warn', '[AUDIT] full-auto tool executed', {
        tool: toolName,
        args: JSON.stringify(args).slice(0, 500),
        sessionId: sessionId || 'N/A',
        timestamp: Date.now(),
        mode: 'full-auto',
      });
    } else {
      const permCheck = await this._checkPermissionMode(mode, toolName, args, sessionId);
      if (!permCheck.ok) return this._blockedResponse(args._tcId, toolName, 'PERMISSION_DENIED', permCheck.reason, `Switch with: tusunsun config set tools.permissionMode auto`, sessionId);
    }

    // 最低防线：安全不应取决于“用户挑了哪个场景” —— 有 bundle 时 bundle 先跑（更严格、带熔断与
    // 限流），没装配时这一层兜底，否则 `gateway-lite` 下 `cat /etc/passwd` 与 `curl` 外网整段被跳过。
    //
    // **硬拦（Y024）不随 `full-auto` 豁免**：full-auto 豁免的是**确认/打断**（软闸、权限清点），
    // 而 Y024 是**明确形态清单**（读系统凭据、外联、远程内容直接执行、递归强删根、写块设备、
    // fork 炸弹、格式化），这些在任何权限模式下都没有正当日常用途。确需放行就显式关掉整个
    // Y024（`tools.builtinDangerCheck: false`），而不是用笼统的 full-auto 顺带绕过。
    if (this.core?.get?.('tools.builtinDangerCheck') !== false) {
      const cmd = args?.command ?? args?.cmd ?? args?.script;
      // cwd 必须是**本会话的工作根**，不能留给 process.cwd()。
      // 实测：工作区在 /tmp/proj 时 `cat ../../../proc/self/environ`，不传 cwd 的判据把相对路径
      // 按进程 cwd 解析（落到 /home/.../proc/…，不敏感）⇒ 放行；传 cwd 后正确解成
      // /proc/self/environ ⇒ 拦下。内置 tool-bash 自己会再判一次（带 cwd），但任何**第三方
      // 注册的命令工具**只过这一道，所以这里不能少。
      const builtinHit = matchBuiltinDangerousCommand(cmd, { cwd: this._effectiveWorkDir(sessionId) });
      if (builtinHit) {
        return { tool_call_id: args._tcId, tool: toolName, result: null, status: 'blocked',
          error: `Command violates safety policy: ${builtinHit.why}`,
          diagnostic: { code: 'Y024', reason: `Command violates safety policy: ${builtinHit.why}`,
            hint: '本内核定位 trusted-local-only：越界读取系统文件、外联、递归强删等一律拒绝'
              + '（这条不随 permissionMode 变化；确需关闭请显式设 tools.builtinDangerCheck=false）',
            alternatives: [], command: typeof cmd === 'string' ? cmd.slice(0, 200) : undefined } };
      }
    }

    if (mode !== 'full-auto') {
      // 第二层：**不可恢复操作软闸**（Y025）。与上面的硬拦分工：
      //   · 硬拦 = 明确的越界/破坏，直接拒绝；
      //   · 软闸 = 日常但不可撤销的操作（rm -r、find -delete、git reset --hard、> 覆盖…），
      //     不拒绝，但要求调用方先核对内核**实测**的影响面。
      // 只对"能装任意命令"的工具生效：tool-rm 走回收站，不受此约束。
      const gate = this._destructiveGate();
      // sessionId 传进软闸：确认状态按会话隔离（否则 A 会话用尽机会，B 会话继承拒绝）
      // 影响面按**本会话**的根目录实测（挑战文案列的文件必须是这个会话的）
      const gateResult = gate.check(toolName, args, this._effectiveWorkDir(sessionId), {
        mode, enabled: this._destructiveGateEnabled(), sessionId: sessionId || null,
      });
      if (gateResult && !gateResult.__ack) {
        return {
          tool_call_id: args._tcId,
          tool: toolName,
          result: null,
          status: gateResult.status,
          error: gateResult.error,
          diagnostic: gateResult.diagnostic,
          challenge: gateResult.challenge,
        };
      }
      if (gateResult && gateResult.__ack) {
        // 记在实例上，供捆仙索复述。确认标记**必须带会话**：裸实例字段会让另一个会话的
        // 同一工具调用继承它。
        this._fenceConfirmed = { sessionId: sessionId || null, toolName, command: String(gateResult.record.command) };
        this.core.log('warn', `[AUDIT] irreversible op confirmed: ${gateResult.record.intent}`, {
          command: String(gateResult.record.command).slice(0, 300),
          measured: gateResult.record.measured,
          ack: gateResult.record.ack,
          // 这次「确认」是**模型复述了内核实测的影响面**，不是人类批准，也不是沙箱放行。
          // 审计里把这两件事分开记，读日志的人才不会把 Y025 当成审批流。
          ack_by: 'model-restatement',
          human_approved: false,
          sessionId: sessionId || 'N/A',
          timestamp: Date.now(),
        });
      } else {
        this._fenceConfirmed = null;
      }
    }

    // Y025 的确认字段是**软闸元数据**，不是工具业务参数：无论上面走的是确认路径、
    // `full-auto` 豁免，还是根本没进软闸（工具本身不可装命令），都不得漏进 handler 入参
    // 或能力 schema 校验。位置必须在软闸之后、派发之前 —— 软闸自己已从 `args` 读过它。
    if (Object.hasOwn(args, ACK_FIELD)) delete args[ACK_FIELD];

    const _activeFence = resolveFence(this.core);
    const _fence = _activeFence?.fence || null;
    if (_fence) {
      // 展开相对路径供捆仙索检查
      const expandedArgs = { ...args }
      if (expandedArgs.path && !expandedArgs.path.startsWith('/')) {
        // 按本会话的根展开（否则同一 `a.txt` 在两个会话里被判成同一个绝对路径，
        // “写前必读”的读记录与写入目标会错位）
        const workDir = this._effectiveWorkDir(sessionId || args._sessionId)
        expandedArgs.path = join(workDir, expandedArgs.path)
      }
      // 已通过软闸确认的那条命令，允许护栏跳过**它自己的**不可恢复操作判据：`checkCommand` 把
      // `rm|mv|shred|dd` 一律判 CMD_GUARD、不看是否确认过，两者同开会变成“确认了也没用”。
      // full-auto 等价于「已预授权不可恢复操作」，只享这条豁免；其余判据（敏感路径、越界、写前必读、熔断、限流）照跑。
      const acked = (this._fenceConfirmed && this._fenceConfirmed.toolName === toolName
        && this._fenceConfirmed.sessionId === (sessionId || null)) || mode === 'full-auto';
      const fenceCtx = acked
        ? { ...(this.core?._fenceContext || {}), irreversibleAcknowledged: true }
        : this.core?._fenceContext;
      const pre = await _fence.preCheck(toolName, expandedArgs, sessionId || null, chainId || null, fenceCtx);
      if (!pre.ok) {
        // 围栏回包形状不统一：`{ok:false, result: 诊断卡}` 与平铺 `{ok:false, code, reason}` 都要认，否则诊断码永远 `UNKNOWN`。
        const card = pre.result || pre || {};
        return { tool_call_id: args._tcId, tool: toolName, result: null, status: 'blocked', error: card.reason || 'Tool blocked',
          diagnostic: { code: card.code || 'UNKNOWN', reason: card.reason || 'Tool blocked',
            hint: card.hint || '', alternatives: card.alternatives || [], path: card.path, command: card.command } };
      }
    }

    const rateCheck = this._checkRateLimit(toolName, sessionId);
    if (!rateCheck.ok) return { tool_call_id: args._tcId, tool: toolName, error: rateCheck.reason, status: 'blocked' };

    for (const hook of this._preHooks) {
      try {
        const preResult = await hook.fn(toolName, args, sessionId, chainId);
        if (preResult?.block) {
          return { tool_call_id: args._tcId, tool: toolName, status: 'blocked', error: preResult.reason || 'Blocked by pre-hook',
            diagnostic: { code: 'HOOK_BLOCKED', reason: preResult.reason || 'Blocked by pre-hook', hint: `Blocked by hook: ${hook.owner}` } };
        }
      } catch (err) {
        // `HOOK_ERROR` **单独计数并发事件**，不能只是一条普通 warn：fail-open 钩子出错只是
        // “warn + 继续”，而 fail-closed 钩子出错意味着这次调用无法证明被授权 —— 两者运维含义
        // 差一个数量级，不能共用一条日志级别。
        this._hookErrors++;
        this.core.emitFast?.('tool.hook_error', {
          tool: toolName, owner: hook.owner, failClosed: hook.failClosed === true,
          error: err.message, timestamp: Date.now(), sourcePlugin: 'tool-executor',
        });
        if (hook.failClosed) {
          // 安全钩子出错 = 无法证明这次调用被授权 ⇒ 拒绝。**不得**降级为"继续执行"。
          this.core.log('error', `PreToolUse hook (${hook.owner}) threw in fail-closed mode: ${err.message}`);
          return {
            tool_call_id: args._tcId, tool: toolName, status: 'blocked',
            error: `hook_error: the authorisation check for this call (${hook.owner}) failed to complete: ${err.message}`,
            diagnostic: { code: 'HOOK_ERROR', reason: err.message, hint: `Hook ${hook.owner} must complete for this tool to be authorised`, retryable: false },
          };
        }
        this.core.log('warn', `PreToolUse hook (${hook.owner}) error: ${err.message}`);
      }
    }

    const guard = this.core.getService('tool-guard');
    if (guard && !guard.allow(toolName)) {
      const th = _toolArgsHash(args);
      this.core.emitFast('tool.execute', { tool: toolName, sessionId: sessionId || 'unknown', traceId: args._traceId || null, toolArgsHash: th, timestamp: Date.now(), sourcePlugin: 'tool-executor' });
      this.core.emitFast('tool.result', { tool: toolName, error: 'Tool blocked by guard', duration: 0, sessionId: sessionId || 'unknown', traceId: args._traceId || null, toolArgsHash: th, ok: false, timestamp: Date.now(), sourcePlugin: 'tool-executor' });
      return { tool_call_id: args._tcId, tool: toolName, error: 'Tool blocked by guard' };
    }
    return null;
  }

  _blockedResponse(tcId, tool, code, reason, hint, sessionId) {
    // **拒绝也必须进审计**：只记录成功与失败的审计回答不了“最近有哪些调用被拒了、为什么”，
    // 而那正是安全审计最该回答的。事件不能代替记录 —— 发出后没人订阅就等于不存在。
    this._addAudit({ tool, sessionId: sessionId || 'unknown', args: null, result: null, duration: 0,
      status: 'blocked', code: code || null, reason: reason || null });
    return { tool_call_id: tcId, tool, status: 'blocked',
      // 这条路径是**执行器自己亲眼所见**的“没派发”（在 _doToolExecute 之前返回），
      // 所以 `dispatched:false` 是证据而不是推断，`result_kind:'denied'` 站得住。
      category: categorizeCode(code), result_kind: 'denied', dispatched: false, side_effect: 'none',
      diagnostic: { code, reason, hint, retryable: true } };
  }

  _emitToolStart(toolName, args, sessionId, callId) {
    this.core.emitFast('tool.progress', { tool: toolName, status: 'executing', argsPreview: JSON.stringify(args).slice(0, 200), callId, timestamp: Date.now(), sourcePlugin: 'tool-executor' });
    this.core.emitFast('tool.execute', { tool: toolName, sessionId: sessionId || 'unknown', traceId: args._traceId || null, toolArgsHash: _toolArgsHash(args), timestamp: Date.now(), sourcePlugin: 'tool-executor' });
  }

  /**
   * 向 **Core** 要一次准入判定（沙箱分支与缓存命中都要用它）。
   *
   * 为什么不在这里自己判：判据只该有一份。抄一份权限表到这里，等于让"沙箱是否检查身份"
   * 变成执行器的一个本地决定 —— 而 Core 改了判据时，抄来的那份不会跟着改。
   *
   * `trusted` 是宿主显式传入的真实主体；`args` 里的 `_principal` / `_caller` / `_scope`
   * 在 `_executeOneV2` 入口已被剥掉，所以模型无法自报身份通过这道判据。
   */
  _admitForDispatch(capId, args, sessionId, trusted = null) {
    const admit = this.core?.admitCapability;
    if (typeof admit !== 'function') {
      // 老 Core / 测试替身没有这个入口：**不静默放行**。沙箱与缓存都是"绕过真 handler
      // 直接交付结果"的路径，判据缺失时无法证明这次调用仍被授权。
      return { ok: false, code: 'admission_unavailable', error: 'Core 未提供 admitCapability，拒绝在无法判定授权的情况下派发' };
    }
    const opts = { traceId: args?._traceId ?? null };
    if (trusted?.principal != null) opts.principal = trusted.principal;
    if (trusted?.caller != null) opts.caller = trusted.caller;
    if (trusted?.scope != null) opts.scope = trusted.scope;
    return admit.call(this.core, capId, opts, args);
  }

  /** 准入被拒时的统一回执：具名、可审计、**零副作用**（handler 与沙箱一次都没跑）。 */
  _admissionRefusal(admit, toolName, capId, sessionId) {
    const code = admit?.code || 'capability_denied';
    const reason = admit?.error || `capability_denied: ${capId}`;
    this.core?.log?.('warn', `[ToolExecutor] dispatch refused for "${toolName}" → ${capId}: ${reason}`);
    return this._blockedResponse(null, toolName, code, reason,
      '受保护能力必须由宿主断言身份（trusted 参数），沙箱与缓存不改变授权结论', sessionId);
  }

  /**
   * 缓存键的**授权维度**：谁在问、问的是哪一笔登记。
   *
   * 为什么不能从 `args` 取主体：`_executeOneV2` 在入口就剥掉了
   * `_principal` / `_caller` / `_scope` —— 那是**对的**（模型能填的字段不能当判据），
   * 但代价是缓存键里再也拿不到真实主体。修法不是把 `args` 捡回来，而是从**可信通道**
   * （`trusted` 参数）取，并让"求不出来"成为**不缓存**，而不是"缓存但少一个维度"。
   *
   * 边界写清：`eligible:false` 只影响**缓存**，不影响执行 —— 求不出主体的调用照常走
   * `callCapability`，由 Core 判它准不准。这里拒绝的是"把结果存起来给下一次用"。
   */
  _cacheScope(capId, trusted = null) {
    const reg = typeof this.core?.capabilityRegistration === 'function'
      ? this.core.capabilityRegistration(capId) : null;
    const principal = trusted?.principal ?? null;
    const caller = trusted?.caller ?? null;
    const scope = trusted?.scope ?? null;
    // 受保护能力**必须有真实主体**才能缓存：没有主体时缓存键里的授权维度是空的，
    // 等于所有匿名调用共用一个桶 —— 那正是 DA-09 的形状。
    const needsIdentity = this._capabilityRequiresIdentity(capId);
    const eligible = !(needsIdentity && principal == null) && reg != null;
    return { eligible, principal, caller, scope, registrationId: reg?.registrationId ?? null };
  }

  /** 能力是否声明了权限要求（决定缓存是否额外需要主体维度）。 */
  _capabilityRequiresIdentity(capId) {
    if (capId == null) return false;
    const perms = this.core?.capabilityPermissions;
    if (typeof perms === 'function') return perms.call(this.core, capId) != null;
    // 老 Core 没有这个视图：**保守视为需要身份** —— 少存一份缓存，比少判一次授权便宜。
    return true;
  }

  async _doToolExecute(toolName, args, sessionId, trusted = null, meta = null) {
    // **能力优先**：`core.callCapability` 是唯一带权限门 / schema / 身份校验的入口；
    // 直连 tool-registry 默认关闭（见 _executeViaLegacyRegistry）。
    const resolved = await this._resolveCapability(toolName);
    if (meta) meta.contract = this._contractFor(resolved.tool, resolved.capId);

    // **结果缓存不能是授权旁路**，两条缺一不可：
    //   · 命中缓存也必须先过派发期复核与 allowlist —— 缓存回答的是“上次算出来是什么”，
    //     不是“这次还准不准做”；少了这一步，撤销资格后同参数再调仍返回 succeeded。
    //   · **只有只读且可缓存的能力**才允许缓存（按解析出的能力判，不按工具名）。写/删/改
    //     重复执行才是正确语义；缓存它们等于“第二次调用报成功但 handler 只跑过一次”。
    let cached = null;
    // 缓存键的**授权维度**：主体只能来自 `trusted`（宿主显式传入、模型不可达），
    // 登记号来自 Core 的权威视图。两者都必须在，否则缓存就成了跨主体/跨代际的旁路。
    const cacheScope = this._cacheScope(resolved.capId, trusted);
    // 判据是“只读**且可缓存**”：`action.inspect` 只读，但返回值含 `current_sha256` 这类
    // **磁盘此刻的事实**，缓存 30s 等于让“查当前真相”的工具回报旧真相。
    // **求不出授权主体就不缓存**（DA-09 修复合同）：宁可不命中，也不许把甲的结果交给乙。
    if (resolved.capId && isCacheableCapability(resolved.capId) && cacheScope.eligible) {
      const hit = await this._getFromCache(toolName, args, cacheScope);
      if (hit) {
        // 走的是"将要返回这个结果"的那一次授权，所以复核必须真的跑。
        // 注意：这条路径与 `_executeViaCapability` 内部的复核**互斥**，不会双跑钩子。
        const guard = this._dispatchGuard(toolName, resolved.capId, args, sessionId);
        if (guard) this._refuseAtDispatch(guard, toolName, resolved.capId, sessionId);
        // **allowlist 也要按解析出的能力判**：`tool-guard.allow(toolName)` 判的是请求名，
        // 别名 / provides / owner 反查都能让“名字安全”的工具落到“能力危险”的目标上。
        // 缓存命中同样要过这一道 —— 它和真正的执行一样是一次“要交付结果”的决定。
        this._assertCapabilityAllowed(resolved.capId);

        // **冻结语义不能被缓存绕过**：缓存命中路径完全不经过 core，不在这里重判就会让冻结后的
        // 同参数调用照样返回 succeeded。只读能力才可能走到这里，所以“文件被改过”那一层由缓存键
        // 的 mtime 负责，这里补的是**授权/可用性**那一层。
        if (this._capabilityIsFrozen(resolved.capId)) {
          throw Object.assign(new Error(`capability.frozen: ${resolved.capId}`), { code: 'capability_frozen' });
        }

        // **交付即授权**：缓存命中的这一次也是一次"要把结果交给某个主体"的
        // 决定，授权检查必须对**每一次结果交付**有效，而不是只对"第一次算出来"有效。
        // 这里原先只复核了派发钩子/allowlist/冻结 —— 全是"这个能力此刻还能不能用"，
        // 没有一条回答"**你**还能不能用"：同一 session 里先由已登记主体读到敏感只读结果，
        // 随后不带身份者命中缓存直接拿到同一份数据，而真 handler 只跑过 1 次。
        const admit = this._admitForDispatch(resolved.capId, args, sessionId, trusted);
        if (!admit.ok) {
          // 拒绝不是"返回空缓存"：那会让调用方以为工具没结果。具名拒绝、零副作用。
          const refusal = this._admissionRefusal(admit, toolName, resolved.capId, sessionId);
          return refusal;
        }
        cached = hit;
      }
    }
    if (cached !== null) return cached;

    const result = resolved.capId
      ? await this._executeViaCapability(toolName, resolved.capId, args, sessionId, trusted)
      : await this._executeViaLegacyRegistry(toolName, args, resolved.tool, sessionId);

    // Error 前缀字符串是**执行器判定**的失败，必须带标记，否则未声明主体（大多数工具）会被
    // 当成业务数据而把失败当成功。但它是**启发式**（无法区分合法的文本前缀 Error），
    // 故显式标 source='legacy-heuristic'，让消费方能区别处置，而不是冒充权威判定。
    if (typeof result === 'string' && /^Error\b/i.test(result)) return this._failureResult(result, null, 'legacy-heuristic');
    // 成功判定必须**显式化**且**不误杀业务数据**：只看 `!result.error` 会把 `{ok:false,code}`
    // 判成功；反过来业务数据也可能合法含 `ok:false`，凭一个字段名就判失败同样是误杀。
    // 判据：只有“看起来是结构化执行结果”才算失败（有 error，或 ok:false **且**带 code/state）。
    if (!this._isStructuredFailure(result, toolName)) {
      // **只缓存只读能力**：写类调用重复执行才是正确语义；缓存它们等于“第二次调用报成功
      // 但没干活”（`tool-write` 的 handler 只跑 1 次）。
      if (resolved.capId && this._capabilityIsReadOnly(resolved.capId) && cacheScope.eligible) {
        // 写回时用**与读取相同的 scope**：登记号若在 handler 执行期间被替换，这条结果
        // 就不该再被任何人命中（那时 `registrationId` 已变，键自然对不上）。
        this._setCache(toolName, args, result, cacheScope);
      }
    }
    return result;
  }

  /**
   * 派发期拒绝的**唯一**处置：两个调用点（能力路径、缓存命中路径）共用，各写一份必然漂移。
   */
  _refuseAtDispatch(guard, toolName, capId, sessionId) {
    // 与 pre-hook 的 HOOK_BLOCKED / HOOK_ERROR 保持同一套可区分语义。
    const code = guard.code || 'HOOK_BLOCKED';
    this.core.emitFast?.('tool.blocked', {
      tool: toolName, capability: capId, code, reason: guard.reason,
      timestamp: Date.now(), sourcePlugin: 'tool-executor',
    });
    // 派发期拒绝**也进审计**：撤销/只读/能力不足全都从这里出，只发事件不落审计、
    // 而事件又没有订阅者，等于这条路径不可观测。
    this._addAudit({ tool: toolName, sessionId: sessionId || 'unknown', args: null, result: null,
      duration: 0, status: 'blocked', code, reason: guard.reason });
    // 抛出的错误要带**自己看到的事实**（它在调用 handler 之前抛出）：不带 `dispatched`，
    // `_finishExecuteError` 就只能靠 code 表猜执行阶段。
    throw Object.assign(new Error(guard.reason || 'Blocked at dispatch'),
      { code, dispatched: false, side_effect: 'none' });
  }

  /**
   * **执行器自产的失败**（Error 前缀字符串、超时、工具缺失、沙箱失败）—— 与“业务数据里恰好
   * 叫 error 的字段”不同，无论主体是否已声明为 ExecutionResult 都**必须**计为失败。
   * 带 `EXECUTOR_FAILURE` Symbol，`_isStructuredFailure` 才可靠区分二者。
   * `ok`/`state`/`code`/`source` 是纯增量的控制平面字段；`error`/`code` 的落位与取值不变。
   */
  _failureResult(message, code = null, source = 'executor') {
    const state = source === 'legacy-heuristic' ? 'failed' : (EXECUTOR_REJECTION_CODES.has(code) ? 'rejected' : 'failed');
    // `result_kind` 在**没有派发证据**时一律不是 `denied`（哪怕 state 是 rejected）：
    // `denied` 是“已证明没有副作用”，这里唯一能说的是“这步失败了”。
    // `timeout` 是“我们不等了、那头可能还在跑” ⇒ unknown 而不是 failed。
    return {
      error: String(message),
      ...(code ? { code } : {}),
      ok: false,
      state,
      source,
      category: categorizeCode(code),
      result_kind: resultKindOf(state, code, code === 'timeout' ? { execution_outcome: 'unknown' } : undefined),
      [EXECUTOR_FAILURE]: true,
    };
  }

  /**
   * 声明某主体的结果契约：`execution_result`（其 `{ok:false}` / `{error}` 是执行状态）
   * 或 `opaque`（一律当业务数据）。插件可在 `provides[].resultContract` 自报，也可调本方法。
   */
  declareResultContract(subject, contract) {
    if (!subject) throw new Error('declareResultContract: subject is required');
    if (contract !== 'execution_result' && contract !== 'opaque') {
      throw new Error(`declareResultContract: unknown contract "${contract}"`);
    }
    this._contracts.set(String(subject), contract);
    return this;
  }

  /** 契约来源：插件自报 → 显式声明 → 内建声明表。都没有就是 null（不知道，不是成功）。 */
  _contractFor(tool, capId) {
    const fromProvides = (Array.isArray(tool?.provides) ? tool.provides : [])
      .map((p) => p?.resultContract).find(Boolean);
    const explicit = tool?.resultContract || fromProvides
      || this._contracts.get(capId) || this._contracts.get(tool?.name);
    if (explicit) return explicit;
    if ((capId && EXECUTION_RESULT_SUBJECTS.has(capId))
      || (tool?.name && EXECUTION_RESULT_SUBJECTS.has(tool.name))) return 'execution_result';
    return null;
  }

  /** 未声明契约却返回 `{ok:false}`：判不了，但必须让这件事可见（每个主体只报一次）。 */
  _noteContractGap(toolName, r, contract) {
    if (contract || !r || typeof r !== 'object' || r.ok !== false) return;
    const key = String(toolName);
    if (this._contractGaps.has(key)) return;
    this._contractGaps.add(key);
    this.core?.log?.('warn', `[ToolExecutor] "${key}" returned {ok:false} without a resultContract; `
      + 'treating it as business data. Declare provides[].resultContract="execution_result" '
      + `or call executor.declareResultContract("${key}", "execution_result").`);
    this.core?.emitFast?.('tool.result_contract_gap', {
      tool: key, timestamp: Date.now(), sourcePlugin: 'tool-executor',
    });
  }

  /** 把工具自己报的失败包成执行器错误，交给唯一那条错误出口去造信封。 */
  _toolFailure(r) {
    const err = new Error(String(r?.error ?? r?.message ?? 'tool reported failure'));
    err.code = r?.code || 'EXEC_RESULT_NOT_OK';   // 旧信封就是这个默认码，不改它
    err.dispatched = r?.dispatched !== undefined ? r.dispatched : true;
    if (r?.side_effect) err.side_effect = r.side_effect;
    if (r?.result_kind) err.result_kind = r.result_kind;
    return err;
  }

  _isStructuredFailure(r, subject = null, contract = null) {
    if (!r || typeof r !== 'object') return false;
    if (r[EXECUTOR_FAILURE] === true) return true;   // Symbol 不可被业务数据伪造
    if (contract === 'execution_result') {
      if (r.ok === false) return true;
      return r.error != null && r.error !== '';
    }
    if (contract === 'opaque') return false;
    const declared = (contract != null) || (subject != null && EXECUTION_RESULT_SUBJECTS.has(subject));
    if (declared) {
      if (r.ok === false) return true;
      return r.error != null && r.error !== '';
    }
    if (subject != null) return false;
    if (r.error != null && r.error !== '') return true;
    return r.ok === false && (r.code != null || r.state != null);
  }

  /** `tool-read` → `tool.read`（仅命名约定；权威来源是工具声明的 provides）。 */
  _capabilityIdFor(toolName) {
    return typeof toolName === 'string' && toolName.startsWith('tool-') ? `tool.${toolName.slice(5)}` : null;
  }

  _hasCapability(id) {
    // 用核心公开枚举面 `listCapabilities()`，不读私有 `core._capabilities`。
    if (!id || typeof this.core?.listCapabilities !== 'function') return false;
    return this.core.listCapabilities().some((c) => c.id === id);
  }

  /**
   * 列出与某工具关联的**已注册**能力 id。三条来源合并，任一命中即认为“该工具已有能力”：
   *   1. 命名约定 `tool-<x>` → `tool.<x>`；
   *   2. 工具自报的 `provides[].name`；
   *   3. **按 `owner` 反查** —— 能力名与工具名不成约定时（`tool-swe-docker-test` →
   *      `tool.sweDockerTest`）前两条都查不到，漏掉这条就会走进 legacy 直连、绕过能力权限门。
   * 只要这里非空，就**绝不允许** legacy 直连执行 handler。
   */
  _capabilityIdsForTool(toolName, tool) {
    const ids = new Set();
    // **最先**取门面显式登记的能力 id：`registerTool({capabilityId})` 允许注册与名字无关的能力
    // （`tool-liuhe-anchor` → `liuhe.readAnchor`），三条派生来源全落空时 `capId=null`，
    // 模型点这个工具名就永远得到 `capability_denied`。
    // 顺序有实际后果：`ids[0]` 就是认定的目标能力，显式登记的那条最具体。
    if (tool?._capabilityId) ids.add(tool._capabilityId);
    const direct = this._capabilityIdFor(toolName);
    if (direct) ids.add(direct);
    for (const p of (Array.isArray(tool?.provides) ? tool.provides : [])) if (p?.name) ids.add(p.name);
    // 同上：只用公开枚举面，不读私有字段。
    for (const { id, owner } of (this.core?.listCapabilities?.() ?? [])) {
      if (owner && (owner === toolName || (tool?.name && owner === tool.name))) ids.add(id);
    }
    return [...ids].filter((id) => this._hasCapability(id));
  }

  /**
   * 认定工具对应的**已注册能力 id**。
   * 若能力已存在（含宿主加固过的注册）则**不触碰 registry**，避免重复 init 把权限门覆盖掉。
   * 若尚不存在，才经 registry 触发懒加载（tool.init 会 registerCapability），再按 provides/owner 认定。
   */
  async _resolveCapability(toolName) {
    const direct = this._capabilityIdFor(toolName);
    if (direct && this._hasCapability(direct)) return { capId: direct, tool: null };
    // **懒加载插件提供的模型工具**：懒加载的触发入口是 `core.callCapability(id)`（按能力 id），
    // 而模型手里是**工具名** —— 插件装载前工具不在 registry 里，`_capabilityIdsForTool` 为空，
    // 就掉进 legacy 直连被身份门拒绝（模型看到的是“需经受信 principal”，与真因无关）。
    // 桥只需一步：名字能派生出能力 id 时，用那个 id **问一次懒加载钩子**再判一次。
    // 钩子幂等、查不到就返回，只认登记过的提供者（不会把没装配的插件变出来）；
    // 位置仍在 `_checkPreFlight` 之后、`_dispatchGuard` 之前，没有新开授权窗口。
    if (direct) {
      const hook = this.core.getData?.('_lazyHook');
      if (typeof hook === 'function') {
        try { await hook(direct); } catch (err) {
          this.core?.log?.('warn', `[tool-executor] lazy load for "${direct}" failed: ${err?.message || 'unknown'}`);
        }
        if (this._hasCapability(direct)) return { capId: direct, tool: null };
      }
    }
    // 请求名**本身就是**一个白名单能力 id（如 `action.inspect`）：三条派生来源都要求先有工具
    // 对象，而执行器自注册的能力没有工具、owner 是 `tool-executor`，三条全落空 ⇒ 掉进 legacy
    // 直连被拒，工具输出里那句“明细：action.inspect xxx”永远兑不了。
    // 只认白名单（见 tool-policy.js 的 MODEL_INVOCABLE_CAPABILITIES），不放开“任何已注册能力
    // 都可点名” —— 那会把能力表整体变成模型可调面。
    if (typeof toolName === 'string' && isModelInvocableCapability(toolName) && this._hasCapability(toolName)) {
      return { capId: toolName, tool: null };
    }

    const registry = this.core.getService('tool-registry');
    if (!registry || typeof registry.get !== 'function') return { capId: null, tool: null };
    let tool = null;
    try { tool = await registry.get(toolName); }
    catch (err) { this.core?.log?.('warn', `[ToolExecutor] registry.get(${toolName}) 失败：${err?.message || 'unknown'}`); }

    const ids = this._capabilityIdsForTool(toolName, tool);
    if (ids.length > 0) return { capId: ids[0], tool };
    return { capId: null, tool };
  }

  /**
   * 能力路径。拒绝/失败**原样具名上抛**（经 _finishExecuteError 透传 code），不回落 registry。
   * `_dispatchGuard` 必须在这里、且在 `callCapability` 之前：这一段是“能力已解析、handler 还没跑”，
   * 到 `cap.handler(params)` 之间**没有 await 点** —— `registerDispatchHook` 的同步契约就是守它。
   */
  async _executeViaCapability(toolName, capId, args, sessionId, trusted = null) {
    const guard = this._dispatchGuard(toolName, capId, args, sessionId);
    if (guard) this._refuseAtDispatch(guard, toolName, capId, sessionId);
    // allowlist 按能力判（详见 `_assertCapabilityAllowed`）。
    this._assertCapabilityAllowed(capId);

    // **沙箱是执行后端，不是授权主体**。
    //
    // 原先 `_useSandbox` 时直接走 `_maybeSandbox` 并**提前返回**，全程没问过 Core 的
    // 身份/权限判据 —— 同一个 `tool.write`，直连 `callCapability` 得到 `capability_denied`，
    // 走执行器却 succeeded 并真的调了 sandbox backend。这不是"恶意 JS 读私有 Map"，
    // 是**受管执行器自己的正常分支**里少了一道判据。
    //
    // 判据只问 Core（`admitCapability`），不在这里手抄一份权限表：抄一份就等于维护
    // 两套判据，哪天 Core 改了这里不会跟着改。`trusted` 才是真实主体来源 —— 它是宿主
    // 显式传入的参数，不在模型可达面上（`args` 里的同名 `_` 字段在入口就被剥掉了）。
    if (this._useSandbox) {
      // **所有判据都排在最后一个 await 之后**：原先这里先判 `_dispatchGuard`、
      // 再 `await _toolForCapability(...)`，于是"查询期间把 permissionMode 改成 read-only"
      // 这条路能穿过去 —— 判定用的是 await 之前的世界，下发发生在 await 之后的世界。
      // 判据的位置本身就是判据的一部分：「派发前已重判」若在时间上不成立，那句话就是假的。
      const sandboxTool = await this._toolForCapability(capId, toolName);
      const sandboxGuard = this._dispatchGuard(toolName, capId, args, sessionId);
      if (sandboxGuard) this._refuseAtDispatch(sandboxGuard, toolName, capId, sessionId);
      const admit = this._admitForDispatch(capId, args, sessionId, trusted);
      if (!admit.ok) return this._admissionRefusal(admit, toolName, capId, sessionId);
      // 把工具的声明一并交进去：能力路径上没有 `tool` 对象，按 owner 反查一次（与
      // `_capabilityIdsForTool` 同源、方向相反）。查不到就传 null —— 那时按“未声明”拒绝，不是放行。
      const sandboxResult = await this._maybeSandbox(toolName, args, sandboxTool);
      // 这里之后**不需要**再复核：`_maybeSandbox` 要么接管要么拒绝，控制流不会从沙箱落到真
      // handler；而 null 路径上没有 await 过沙箱，也不存在新窗口。
      if (sandboxResult) return sandboxResult;
      // 只有"沙箱未启用/未装配"（null）才会走到这里，此时控制流回到下面的真 handler；
      // 而这条 null 路径上**没有 await 过沙箱**，所以不存在新的窗口。
    }

    // **身份只能由宿主断言，不得从 args 取**：args 是模型给的 JSON，把 `_principal` / `_caller` /
    // `_scope` 原样递进 opts，等于让“只有管理员能调”的能力被任意调用方拿到（自报 `_principal=admin`
    // 就直接 succeeded）。判据不能放在**被测对象能填的字段**上。
    // `args` 是**模型命名空间**，任何 `_` 前缀控制字段在入口就被剥掉（见 `_executeOneV2`）；
    // 宿主要断言身份就走 `trusted` 参数（显式、不在模型可达面上）。
    const opts = { traceId: args._traceId ?? null };
    if (trusted?.principal != null) opts.principal = trusted.principal;
    if (trusted?.caller != null) opts.caller = trusted.caller;
    if (trusted?.scope != null) opts.scope = trusted.scope;

    let timedOut = false;
    let raceTimer = null;
    // 竞速定时器两条路径都要清：漏清会把进程自然退出拖到超时时间。
    const racePromise = new Promise((_, reject) => { raceTimer = setTimeout(() => { timedOut = true; reject(new Error('timeout')); }, this._timeout); });
    // 迟到的拒绝已经没人接收（race 已结算），必须自己吞掉，否则它是 unhandledRejection。
    const callPromise = this.core.callCapability(capId, args, opts);
    callPromise.catch(() => {});
    let envelope;
    try {
      envelope = await Promise.race([callPromise, racePromise]);
    } catch (err) {
      if (timedOut) {
        this.core?.log?.('warn', `[ToolExecutor] ${toolName} timed out after ${this._timeout}ms`);
        return this._failureResult(`Tool "${toolName}" timed out after ${this._timeout}ms`, 'timeout');
      }
      throw err;
    } finally {
      if (raceTimer) { clearTimeout(raceTimer); raceTimer = null; }
    }
    // 合同：ok === (state === 'succeeded')。成功回载荷，失败/拒绝**必须**带码上抛。
    if (envelope?.state === 'succeeded') {
      // `output_schema` 的执行期可观测性：只告警不阻断 —— 阻断会让一个写错的声明变成线上故障，
      // 而声明是契约文档、不是判据，返回值形状的业务正确性归工具自己。
      // 但“违规”必须**可观测**，否则等于没声明（声明 `type:'string'` 却返回对象这种情况）。
      this._warnOnOutputSchemaMismatch(capId, envelope.payload);
      return envelope.payload;
    }
    // **把 Core 的证据一起带上抛**，不要只留 code：只搬 code 会让下游 `_finishExecuteError`
    // 重新退化成“按字符串猜执行阶段” —— Core 明明给了 `dispatched`/`side_effect`，却在交接点被丢掉。
    throw Object.assign(new Error(envelope?.error || `Tool "${toolName}" 失败`), {
      code: envelope?.code || 'handler_threw',
      dispatched: envelope?.dispatched,
      side_effect: envelope?.side_effect,
      state: envelope?.state,
    });
  }

  /**
   * **回退**直连 tool-registry。默认关闭，需同时满足：
   *   1. `tools.legacyRegistryFallback === true`；
   *   2. 工具名在 `tools.legacyRegistryFallbackAllowlist` 内；
   *   3. **该工具确无任何已注册能力**（含 owner 反查）——否则直接拒绝，不得绕过能力权限门；
   *   4. 受信授权上下文：core 若有身份权威（`_trustedCallers`），principal 必须已登记。
   * 任一不满足即**失败关闭**，并留审计事件 `tool.legacy_fallback`（含 `identity_verified`）。
   * 注意：审计事件**不能取代拒绝**——它只记录已发生的拒绝/放行，不提供任何授权。
   */
  async _executeViaLegacyRegistry(toolName, args, resolvedTool, sessionId) {
    // 受保护的会话不得从 legacy 直连出去（rc.29 / 合同第 2 条）。专家在 R28-A 的验收里点名
    // 要覆盖“缓存命中 / 沙箱 / legacy”三条路径：前两条都过 `_dispatchGuard`，只有这一条不过 ——
    // 因为它**没有能力解析结果**，门的判据没有主语。主语不存在的调用不能被当作授权通过。
    const ownership = this._cellSessionRefusal(sessionId);
    if (ownership) this._refuseAtDispatch(ownership, toolName, null, sessionId);
    if (this.isProtectedSession(sessionId)) {
      this._refuseAtDispatch({
        block: true,
        code: 'capability_denied',
        reason: `capability_denied: session "${sessionId}" is protected by a Cell capability gate, but `
          + `"${toolName}" resolves to no registered capability. The gate cannot authorise an unresolved target, `
          + 'and the legacy registry path is not a way around it.',
      }, toolName, null, sessionId);
    }
    const enabled = this.core.get('tools.legacyRegistryFallback') === true;
    const list = this.core.get('tools.legacyRegistryFallbackAllowlist');
    const allowlisted = Array.isArray(list) && list.includes(toolName);

    // 回退前**重新**认定（TOCTOU）：期间/别名/重注册产生的能力一律优先，否则会绕过能力权限门。
    const ids = this._capabilityIdsForTool(toolName, resolvedTool);
    if (ids.length > 0) {
      this.core.emitFast('tool.legacy_fallback', { tool: toolName, allowed: false, reason: 'capability_exists', capability: ids[0], timestamp: Date.now(), sourcePlugin: 'tool-executor' });
      throw Object.assign(new Error(`Tool "${toolName}" 已注册为能力 '${ids[0]}'，拒绝走 legacy 直连（不得绕过能力权限门）`), { code: 'capability_denied' });
    }

    // 受信授权上下文：core 有身份权威时 principal 必须已登记；**无身份权威（旧 core）时默认 DENY** ——
    // 不能把 UNKNOWN 当“已认证”放行敏感 legacy 工作。仅当宿主**显式**开启
    // `tools.legacyRegistryFallbackNoAuthorityApproved === true`（维护者逐项批准的受限兼容入口）
    // 才放行，否则一律拒绝。
    const trustees = this.core?._trustedCallers;
    const principal = args?._principal ?? null;
    const hasAuthority = Boolean(trustees && typeof trustees.get === 'function');
    const identityVerified = hasAuthority ? Boolean(principal != null && trustees.get(String(principal))) : null;
    if (hasAuthority && !identityVerified) {
      this.core.emitFast('tool.legacy_fallback', { tool: toolName, allowed: false, reason: 'identity_required', principal, timestamp: Date.now(), sourcePlugin: 'tool-executor' });
      throw Object.assign(new Error(`Tool "${toolName}" 走 legacy 直连需经受信 principal（未提供或未登记）；拒绝（R0-81 P0-A）`), { code: 'capability_denied' });
    }
    if (!hasAuthority) {
      const approved = this.core.get('tools.legacyRegistryFallbackNoAuthorityApproved') === true;
      this.core.emitFast('tool.legacy_fallback', { tool: toolName, allowed: approved, reason: approved ? 'no_authority_maintainer_approved' : 'no_identity_authority', identity_verified: null, timestamp: Date.now(), sourcePlugin: 'tool-executor' });
      if (!approved) {
        throw Object.assign(new Error(`Tool "${toolName}" 宿主无身份权威（旧 core），无法证实调用方身份 → 默认 DENY（R0-83）；如确需受限兼容，须由维护者逐项批准并开启 tools.legacyRegistryFallbackNoAuthorityApproved`), { code: 'capability_denied' });
      }
    }

    if (!enabled || !allowlisted) {
      this.core.emitFast('tool.legacy_fallback', { tool: toolName, allowed: false, reason: !enabled ? 'disabled' : 'not_allowlisted', identity_verified: identityVerified, timestamp: Date.now(), sourcePlugin: 'tool-executor' });
      // 这里报 `tool_not_registered` 而不是 `capability_not_found`：“这个工具名没有能力承载” ⇒
      // 请求无效 ⇒ **拒绝**（从未执行）；`capability_not_found` 保留给“该有的能力装配后没有” ⇒
      // 装配缺陷 ⇒ **失败**。拆开之后同一个 code 不会有两个 state。
      throw Object.assign(new Error(`Tool "${toolName}" 未注册为能力；tools.legacyRegistryFallback=${enabled}、allowlist命中=${allowlisted} → 拒绝直连 tool-registry（R0-81 P0-A）`), { code: 'tool_not_registered' });
    }
    this.core.emitFast('tool.legacy_fallback', { tool: toolName, allowed: true, identity_verified: identityVerified, timestamp: Date.now(), sourcePlugin: 'tool-executor' });

    const registry = this.core.getService('tool-registry');
    // 先把工具解析出来，再交给沙箱 —— 沙箱要读工具自己声明的 `sandboxOp`；
    // 顺序换过来不是形式问题：不知道这是什么工具就无法判断该不该放行。
    const tool = resolvedTool || await registry?.get(toolName);
    if (!tool) return this._failureResult(`Tool "${toolName}" not found`, 'resource_error');

    const sandboxResult = await this._maybeSandbox(toolName, args, tool);
    if (sandboxResult) return sandboxResult;
    // 工具**实际身份**校验：registry 返回对象的 name 必须与请求名一致
    if (tool.name && tool.name !== toolName) {
      throw Object.assign(new Error(`Tool "${toolName}" 的身份不符：registry 返回 '${tool.name}' → 拒绝执行`), { code: 'capability_denied' });
    }

    let timedOut = false;
    // legacy 路径同样要过派发复核，且卡在 `tool.execute(args)` 的紧邻上游。
    // 这条路径上没有能力 id，传 null —— 复核方看到 null 必须按“目标不明”处理（默认拒绝），
    // 而不是“没有能力所以不管”。
    const legacyGuard = this._dispatchGuard(toolName, null, args, sessionId);
    if (legacyGuard) this._refuseAtDispatch(legacyGuard, toolName, null, sessionId);
    const execPromise = tool.execute(args);
    // 超时只是"我们不等了"，不是说那头停了：给迟到的拒绝一个接收方，
    // 并给工具一次取消的机会。
    execPromise.catch(() => {});
    let raceTimer = null;
    const racePromise = new Promise((_, reject) => { raceTimer = setTimeout(() => { timedOut = true; reject(new Error('timeout')); }, this._timeout); });
    let result;
    try {
      result = await Promise.race([execPromise, racePromise]);
    } catch (err) {
      if (timedOut) {
        this.core?.log?.('warn', `[ToolExecutor] ${toolName} timed out after ${this._timeout}ms`);
        try { await tool.abort?.(args); } catch { /* 尽力而为，不改变"不知道"的结论 */ }
        result = this._failureResult(`Tool "${toolName}" timed out after ${this._timeout}ms`, 'timeout');
      } else {
        throw err;
      }
    } finally {
      if (raceTimer) { clearTimeout(raceTimer); raceTimer = null; }
    }
    return result;
  }

  /**
   * 调围栏的 `postCheck`：它是**观察**，不是**事实源**。
   *
   * 走到这里时工具已经跑完了 —— "跑过没有、结果是什么"是过去的事实，围栏的职责只有两件：
   * 记熔断（观察）与改写输出（脱敏）。于是：
   *   · 它抛错 ⇒ **不改写结局**。两处调用点原先都是裸 `await`：成功路径上异常穿到 `_executeOneInner`
   *     的 catch，被当成执行失败（磁盘上明明已经写完），调用方据此重试就是重复写；错误路径上
   *     原始错误被整个顶掉，超时/`execution_outcome:unknown` 这些“最不能丢”的证据一起消失。
   *   · 它抛错也**不能被吞掉**：只吞不记等于“围栏一直是坏的，而所有人以为它好着”。
   *     故故障同时写进结果信封、审计条目与 `tool.fence_error` 事件（三处同形）。
   *   · 它返回非字符串 ⇒ 视为“没有新输出”。`undefined` 不等于“输出为空”：一次笔误不该
   *     让模型看不见工具刚干了什么。
   *
   * 方向与前置围栏**相反**：`preCheck` 抛错是**拒绝**（fail-closed，那是准入判断的一部分），
   * `postCheck` 抛错是**记账**（不改写事实）。两者不可一起吞，故分开写、不共用一个 catch。
   *
   * @returns {{output: any, error: null | {stage: string, fence: string|null, tool: string, message: string, success: boolean}}}
   */
  async _runPostFence(toolName, output, duration, success, sessionId, chainId) {
    const active = resolveFence(this.core);
    const fence = active?.fence;
    // 不实现 postCheck 的围栏 = 没有后置观察面；这不是故障，不报错（前置围栏另有 `preCheck`）。
    if (!fence || typeof fence.postCheck !== 'function') return { output, error: null };
    try {
      const next = await fence.postCheck(toolName, output, duration, success, sessionId || null, chainId || null);
      return { output: typeof next === 'string' ? next : output, error: null };
    } catch (err) {
      const error = {
        stage: 'post',
        fence: active.owner || null,
        tool: toolName,
        // 有界：故障文本会进结果信封、审计与事件三处，不能因为围栏吐一个超长对象把日志吃尽。
        message: String(err?.message ?? err).slice(0, 500),
        // 同一个故障在成功/失败两条路上含义不同（成功路=“输出没脱敏”，失败路=“失败原因没登记”），
        // 故必须带上当时的判定，否则读日志的人无从区分。
        success,
      };
      this.core?.log?.('warn', `[ToolExecutor] 围栏 postCheck 故障（${active.owner || '未知 owner'}）：${error.message}`);
      this.core?.emitFast?.('tool.fence_error', {
        ...error, sessionId: sessionId || 'unknown', timestamp: Date.now(), sourcePlugin: 'tool-executor',
      });
      return { output, error };
    }
  }

  async _finishExecuteSuccess(toolName, args, result, sessionId, chainId, callId, t0, meta = null) {
    const duration = Date.now() - t0;
    const contract = meta?.contract ?? null;
    const success = !this._isStructuredFailure(result, toolName, contract);
    // 失败不是"成功载荷里带一句 error"：外层判定必须与内层一致，
    // 否则 tool.result / 审计 / 捆仙索三处都会把失败记成成功。
    if (!success) {
      return this._finishExecuteError(toolName, args, this._toolFailure(result), sessionId, chainId, callId, t0);
    }
    this._noteContractGap(toolName, result, contract);
    // 成功但载荷含同名 `error` 字段（业务数据）时按原样保留，不归一到错误字符串。
    const ambiguousErrorField = success && result && typeof result === 'object' && result.error != null && result.error !== '';
    const normalized = this._normalizeResult(result?.result || result, { preserve: ambiguousErrorField });
    const sanitized = this._sanitizeOutput(normalized.content);

    // posthook 的第 7 参 `success` 不能省：捆仙索靠它区分“读成功了才记已读”—— 否则失败的
    // tool-read（超时/文件不存在/权限）也会 markRead，模型没看到内容却拿到“已读”资格。
    for (const hook of this._postHooks) {
      try { await hook.fn(toolName, args, sanitized, sessionId, chainId, duration, success); }
      catch (err) { this.core.log('warn', `PostToolUse hook (${hook.owner}) error: ${err.message}`); }
    }

    // 围栏在**工具已经跑完之后**才被调用 —— 它是观察，不是事实源（见 `_runPostFence`）。
    // 它故障时 `filtered` 保持原值：宁可少脱敏一次，也不把已发生的执行改写成失败。
    const _fenced = await this._runPostFence(toolName, sanitized, duration, success, sessionId, chainId);
    let filtered = _fenced.output;
    const fenceError = _fenced.error;

    // 把 Action Receipt 的**一句话摘要**附在工具输出之后，让模型看得见自己造成的变化。
    // ① 只有工具确实产出了回执才追加 —— 没有回执的工具输出**字节不变**；
    // ② 摘要受预算限制，完整回执留给 `action.inspect` 按需展开，不把文件内容塞进上下文；
    // ③ 回执只从 `runInCallContext` 那层取：不能按工具实例反查“最近一次”，那是共享槽。
    const receiptNote = this._receiptNote(sessionId);
    if (receiptNote) filtered = `${filtered}\n${receiptNote}`;

    try { this._recordMetrics(toolName, duration, success); } catch (e) { this.core.log('error', `_recordMetrics error: ${e.message}`); }
    this._addAudit({ tool: toolName, sessionId: sessionId || 'unknown', args, result: filtered, duration, status: success ? 'success' : 'error', fence_error: fenceError });
    this._debugLog(toolName, args, filtered, duration);
    if (sessionId) this._recordPreference(sessionId, toolName);

    this.core.emitFast('tool.result', { tool: toolName, duration, sessionId: sessionId || 'unknown', traceId: args._traceId || null, toolArgsHash: _toolArgsHash(args), ok: success, timestamp: Date.now(), sourcePlugin: 'tool-executor' });
    this.core.emitFast('tool.progress', { tool: toolName, status: 'done', duration, ok: success, callId, argsPreview: JSON.stringify(args).slice(0, 200), resultPreview: success ? String(filtered).slice(0, 200) : (result?.error || 'unknown error'), timestamp: Date.now(), sourcePlugin: 'tool-executor' });

    // 仅当**确实判定为失败**时才回错误形状并**透传 code**：成功不得因同名 error 字段被回成错误，
    // 失败也不得被压成 result。`result`/`error` 的落位与取值不变（送进 LLM 的文本**字节不变**），
    // 只补 `ok`/`state`/`code`/`source`，让“事件流报 ok:false 而返回体是成功形状”不再可能。
    const ctl = success
      ? { ok: true, state: 'succeeded', source: 'executor' }
      : {
          ok: false,
          state: result?.state || (EXECUTOR_REJECTION_CODES.has(result?.code) ? 'rejected' : 'failed'),
          code: result?.code || 'EXEC_RESULT_NOT_OK',
          source: result?.source || 'executor',
        };
    // `fence_error` 是**附带证据**，不是结论：`ok` / `state` / `source` 一律不因它变（M2）。
    const fencePatch = fenceError ? { fence_error: fenceError } : {};
    if (result?.error && !success) return { tool_call_id: args._tcId, tool: toolName, ...ctl, ...fencePatch, error: result.error, duration };
    return { tool_call_id: args._tcId, tool: toolName, ...ctl, ...fencePatch, result: filtered, duration };
  }

  async _finishExecuteError(toolName, args, err, sessionId, chainId, callId, t0) {
    const duration = Date.now() - t0;

    for (const hook of this._postHooks) {
      try { await hook.fn(toolName, args, null, sessionId, chainId, duration, false); }
      catch (hookErr) { this.core.log('warn', `PostToolUse hook (${hook.owner}) error: ${hookErr.message}`); }
    }

    // 错误路径同样只记不改写：围栏在这里抛错若冒泡出去，原始错误（`code` / `dispatched` /
    // `execution_outcome`）会被顶掉，连下面的 `tool.result` 都发不出去 —— 那才是真的丢证据。
    const fenceError = (await this._runPostFence(toolName, null, duration, false, sessionId, chainId)).error;

    try { this._recordMetrics(toolName, duration, false); } catch (e) { this.core.log('error', `_recordMetrics error: ${e.message}`); }
    // **同一次调用不得记两条审计**：派发期拒绝（`_refuseAtDispatch`）已经写过 `status:'blocked'`，
    // 它抛出的错误又流到这里，再写一条 `status:'error'` 会让计数翻倍、把“被拒”说成“出错”。
    // 故属于**执行前拒绝**的具名 code 不再重复记。
    const _alreadyAudited = EXECUTOR_REJECTION_CODES.has(err?.code);
    if (!_alreadyAudited) {
      this._addAudit({ tool: toolName, sessionId: sessionId || 'unknown', args, result: null, duration, status: 'error', fence_error: fenceError });
    }
    this._debugLog(toolName, args, { error: err.message }, duration);

    this.core.emitFast('tool.result', { tool: toolName, error: err.message, duration, sessionId: sessionId || 'unknown', traceId: args._traceId || null, toolArgsHash: _toolArgsHash(args), ok: false, timestamp: Date.now(), sourcePlugin: 'tool-executor' });
    this.core.emitFast('tool.progress', { tool: toolName, status: 'done', duration, ok: false, callId, argsPreview: JSON.stringify(args).slice(0, 200), resultPreview: err.message || 'unknown error', timestamp: Date.now(), sourcePlugin: 'tool-executor' });

    // 把工具的具名错误码透传到上层（越界/无效输入/资源故障可机器判定）。`state` 由**执行器
    // 自产的具名 code** 分类（拒绝=执行前被拦；失败=执行中出错），只影响粒度、不影响放行。
    //
    // **证据优先于 code**：Core 说 handler 跑没跑过（`dispatched`）时，不许再拿 code 查表猜阶段 ——
    //   · `dispatched === false` ⇒ 没调用 handler ⇒ rejected（可安全判“别重试”）
    //   · `dispatched === true`  ⇒ handler 跑过、副作用可能已发生 ⇒ failed
    //   · 两者都没有 ⇒ 执行器自己产生的错误（`_refuseAtDispatch` 等），此时 code 表才是唯一线索
    const _attested = err?.dispatched === false ? 'rejected' : err?.dispatched === true ? 'failed' : null;
    const errCode = err?.code || null;
    const computedState = _attested ?? (EXECUTOR_REJECTION_CODES.has(errCode) ? 'rejected' : 'failed');
    // `result_kind` **只认证据**：
    //   · `dispatched === false`（Core 或执行器亲眼所见）⇒ denied；
    //   · 超时/未知效果 ⇒ indeterminate；
    //   · 其余（包括“code 表说是拒绝”）⇒ failed —— **不允许用错误码决定“未执行”**。
    const resultKind = err?.result_kind || (err?.dispatched === false ? 'denied'
      : (errCode === 'timeout' || err?.execution_outcome === 'unknown' || err?.still_running_at_return === true)
        ? 'indeterminate' : 'failed');
    return {
      tool_call_id: args._tcId, tool: toolName, error: err.message,
      ok: false,
      state: computedState,
      source: 'executor',
      duration,
      ...(errCode ? { code: errCode } : {}),
      category: categorizeCode(errCode),
      result_kind: resultKind,
      ...(err?.dispatched !== undefined ? { dispatched: err.dispatched === true } : {}),
      ...(err?.side_effect ? { side_effect: err.side_effect } : {}),
      ...(fenceError ? { fence_error: fenceError } : {}),
    };
  }

  // `tool_calls` 有**两种**形状，都必须在这里归一：
  //   · 扁平（本仓内部约定，`_parseApiResult` 产出）：{ id, name, arguments }
  //   · OpenAI 原生（流式 delta 累积后**原样** yield 出去的形状）：
  //       { id, type:'function', function: { name, arguments } }
  // 只归一其中一种，另一种的 `tc.name` 就是 undefined，模型会收到一句内部报错再去编理由。
  // 归一必须做在**消费端入口**：只在某一个产出端做，新增产出端就会漏。
  normalizeToolCall(tc) {
    // 实例方法而非 static：本模块 `export default new ToolExecutor()` 导出的是**实例**，
    // static 方法挂在类上，消费端与门禁都摸不到（默认实例上没有它）。
    if (!tc || typeof tc !== 'object') return { id: undefined, name: undefined, arguments: '{}' };
    const fn = tc.function && typeof tc.function === 'object' ? tc.function : null;
    const rawName = typeof tc.name === 'string' ? tc.name : (fn && typeof fn.name === 'string' ? fn.name : undefined);
    const rawArgs = tc.arguments !== undefined && tc.arguments !== null
      ? tc.arguments
      : (fn ? fn.arguments : undefined);
    return {
      id: tc.id,
      name: typeof rawName === 'string' && rawName.trim() ? rawName.trim() : undefined,
      // arguments 可能是字符串（标准）、也可能是已解析对象（部分适配器）——两种都接住
      arguments: rawArgs === undefined || rawArgs === null
        ? '{}'
        : (typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs)),
    };
  }

  async executeBatch(toolCalls, options = {}) {
    const sessionId = options.sessionId;
    const chainId = options.chainId;
    const traceId = options.traceId;
    const results = [];
    const calls = Array.isArray(toolCalls) ? toolCalls.map((tc) => this.normalizeToolCall(tc)) : [];
    for (let i = 0; i < calls.length; i += this._maxParallel) {
      const batch = calls.slice(i, i + this._maxParallel);
      const batchResults = await Promise.all(
        batch.map(tc => {
          let args;
          try {
            args = JSON.parse(tc.arguments || '{}');
          } catch {
            args = null;
          }
          // 参数必须是 JSON 对象：null / 数字 / 数组都挂不住控制字段，
          // 而"解析失败就当空对象"会让模型拿到一次它没描述的执行。
          if (!args || typeof args !== 'object' || Array.isArray(args)) {
            return Promise.resolve({
              tool_call_id: tc.id, tool: tc.name, ok: false, state: 'rejected',
              code: 'invalid_arguments',
              error: `Invalid tool arguments for "${tc.name}": expected a JSON object, got `
                + (args === null ? 'null or unparsable JSON' : Array.isArray(args) ? 'array' : typeof args),
            });
          }
          args._tcId = tc.id;
          args._traceId = traceId || null;
          return this.executeOne(tc.name, args, sessionId, chainId).catch(err => ({
            tool_call_id: tc.id,
            tool: tc.name,
            error: err.message || 'Batch execution failed',
          }));
        })
      );
      results.push(...batchResults);
    }
    return results;
  }

  /**
   * `output_schema` 的**执行期可观测性**（只告警，不阻断）。
   * 放在这里是因为这是执行器唯一同时持有“能力 id”与“真实返回值”的位置；
   * 不阻断的理由见调用点：声明是契约文档，不是判据。
   */
  _warnOnOutputSchemaMismatch(capId, payload) {
    if (typeof this.core?.getCapabilityOutputSchema !== 'function') return;   // 旧 core：不做，也不假装做了
    const decl = this.core.getCapabilityOutputSchema(capId);
    if (!decl || !decl.type) return;
    const actual = Array.isArray(payload) ? 'array' : payload === null ? 'null' : typeof payload;
    if (actual === decl.type) return;
    this.core?.log?.('warn',
      `[ToolExecutor] output_schema mismatch for "${capId}": declared type=${decl.type}, got ${actual}. `
      + 'The declaration is a contract document, so this is reported (not blocked) — fix the tool or the declaration.');
    this.core?.emitFast?.('tool.output_schema_mismatch', {
      capability: capId, declared: decl.type, actual, timestamp: Date.now(), sourcePlugin: 'tool-executor',
    });
  }

  /**
   * allowlist 的**能力判据**。`tool-guard.allow(toolName)` 判的是请求名，而真正被执行的是能力：
   * `tools.allowlist=['safe-wrapper']` + 一个 `provides: tool.write` 的 `safe-wrapper`，
   * 预检按名字放行、这里按能力写盘。
   *
   * 判据交给 `tool-guard.allowCapability(capId)`（它才持有名单），执行器只负责**在正确的时机**
   * （能力已解析之后）问它，名单仍然只有一份。tool-guard 未提供该方法时**不**静默放行。
   */
  _assertCapabilityAllowed(capId) {
    const guard = this.core?.getService?.('tool-guard');
    if (!guard) return;                       // 未装配 tool-guard：这条门不存在
    if (typeof guard.allowCapability !== 'function') {
      // tool-guard 没有能力判据时**不能**当作“允许”：配了 allowlist 时“按名字放行”正是本缺陷；
      // 但没有名单信息时也无法判，故只在**确实配了 allowlist** 时失败关闭。
      const list = this.core?.get?.('tools.allowlist');
      if (Array.isArray(list) && list.length) {
        throw Object.assign(new Error(
          'capability_denied: tools.allowlist is configured but this tool-guard cannot ' +
          'evaluate a resolved capability id; refusing rather than falling back to a name check ' +
          '(see R0-142)'), { code: 'capability_denied' });
      }
      return;
    }
    if (!guard.allowCapability(capId)) {
      throw Object.assign(new Error(
        `capability_denied: capability "${capId ?? '(unresolved)'}" is not in tools.allowlist `
        + '(the allowlist is matched against the resolved capability, not the requested tool name)'),
        { code: 'capability_denied' });
    }
  }

  /**
   * 按能力 id 反查工具对象，供沙箱读工具自己声明的 `sandboxOp`。
   * 反查关系与 `_capabilityIdsForTool` 同源、方向相反：那边是“工具 → 能力”，这边是“能力 → owner → 工具”。
   * 查不到返回 null —— 调用方会把 null 当作“未声明”，按**拒绝**处理，不当作放行。
   */
  async _toolForCapability(capId, toolName) {
    const registry = this.core?.getService?.('tool-registry');
    if (!registry || typeof registry.get !== 'function') return null;
    // ① 先按请求名直接取（绝大多数情况工具名 = 请求名）
    try {
      const byName = await registry.get(toolName);
      if (byName) return byName;
    } catch { /* 取不到就继续反查 */ }
    // ② 再按能力登记的 owner 反查
    const owner = (this.core?.listCapabilities?.() ?? [])
      .find((c) => c.id === capId)?.owner;
    if (!owner) return null;
    try { return await registry.get(owner); } catch { return null; }
  }

  async _maybeSandbox(toolName, args, tool = null) {
    if (!this._useSandbox) return null;
    const sandbox = this.core.getService('sandbox');
    if (!sandbox) return null;

    // 内建工具的 op 映射 —— 只是快捷表，**不是唯一来源**。
    //
    // 判据顺序：① 工具自己声明了 `sandboxOp`（第三方显式接线点，推荐）→ 用它；
    // ② 否则查内建表；③ 两者都没有 → **不是放行，而是拒绝**（`sandbox_op_undeclared`）。
    // “开了沙箱却有一类工具不受它管”比“开了沙箱导致某工具不能用”危险得多 —— 失败模式要选可以
    // 立刻被用户看见的那个。
    //
    // M5：值写成 `null` 表示“这个工具**需要**沙箱接管，但本构建没有实现对应的 op”。
    // 修前这张表给 cp/mv/rm/todo/validate 各写了一个名字，而子进程的 switch 里根本没有它们，
    // 于是“沙箱已覆盖”只发生在发布表里：op 照样下发给子进程，换回一句 "Unknown op"，
    // 父进程再把它压成 `resource_error` —— 读起来像“资源暂时不可用”，实际是“这个 op 不存在”。
    // “没声明”与“声明了但没实现”是两件事，必须两个码。
    const opMap = {
      'tool-bash': 'bash',
      'tool-read': 'read',
      'tool-write': 'write',
      'tool-list': 'list',
      'tool-stat': 'stat',
      'tool-cp': null,
      'tool-mv': null,
      'tool-rm': null,
      'tool-todo': null,
      'tool-validate': null,
    };

    // 本构建**真能下发**的 op = 子进程 `_lib/sandbox/bootstrap.mjs` 的 switch 里存在的那些。
    // 两张表必须逐项一致：结构判据钉在 `test/unit/test-r027-sandbox-op-registry.test.mjs` /2；
    // 任何一侧新增都要同时改另一侧。
    const IMPLEMENTED = new Set(['bash', 'read', 'write', 'list', 'stat']);

    const declared = typeof tool?.sandboxOp === 'string' && tool.sandboxOp.trim() ? tool.sandboxOp.trim() : null;
    // `null` 与“表里没这个名字”在取值上一模一样，但它们是两件事：
    //   · 表里有这个工具、值是 null ⇒ 它**需要**沙箱接管，只是本构建没实现那个 op；
    //   · 表里根本没这个名字、工具也没声明 ⇒ 它没有沙箱覆盖（`sandbox_op_undeclared`）。
    const inTable = Object.hasOwn(opMap, toolName);
    const op = declared || (inTable ? opMap[toolName] : null) || null;
    // 表里有这个工具、值却是 null ⇒ 它**需要**沙箱接管，只是本构建没实现那个 op；
    // 表里根本没这个名字、工具也没声明 ⇒ 它没有沙箱覆盖。两者是两个码，不是一个。
    if (!op) {
      if (inTable) {
        return this._failureResult(
          `Sandbox operation for tool "${toolName}" is listed in the built-in table but this build has no `
          + `implementation for it (implemented: ${[...IMPLEMENTED].join(', ')}). Refusing here instead of `
          + 'sending an unknown op to the sandbox child — a named refusal is actionable, "Unknown op" is not.',
          'sandbox_op_not_implemented');
      }
      return this._failureResult(
        `Sandbox is enabled but tool "${toolName}" declares no sandbox operation `
        + '(set `sandboxOp` on the tool, or disable sandbox.enabled). '
        + 'A tool that the sandbox does not cover must not silently run unsandboxed.',
        'sandbox_op_undeclared');
    }
    // **只对“我们自己公布的那张表”要求有实现**：工具自报的 `sandboxOp` 是第三方接线点，
    // 那个 op 存不存在只有它接的沙箱实现说了算（R0-137/b 就是靠这条扩展点建的）。
    // 内建表不一样 —— 它是对外宣称“这几个工具已被沙箱接管”的唯一依据，
    // 而它列的五个 op 子进程里根本没有。判据放在**调用沙箱之前**：
    // 既然这个 op 永远跑不了，就不该先让 `_guard` 为它逐路径判定并放行。
    if (!declared && !IMPLEMENTED.has(op)) {
      return this._failureResult(
        `Sandbox operation "${op}" is declared for tool "${toolName}" but this build has no `
        + `implementation for it (implemented: ${[...IMPLEMENTED].join(', ')}). Refusing here instead of sending `
        + 'an unknown op down to the sandbox child, which would only answer "Unknown op" and get flattened '
        + 'into a generic resource_error — a named refusal is actionable, that is not.',
        'sandbox_op_not_implemented');
    }

    const result = await sandbox.execute(op, args);
    // 超时的回执**不能**被压成普通的 `failed`：沙箱超时的真实含义是“我们不等了，但那一头可能
    // 还在写”（`execution_state` 是 `unknown_or_running`）。压成 failed 会让上层当成“无副作用”
    // 而重试一个**可能已经产生副作用**的操作。故 `state` 用 `unknown` —— 它与 `failed`/`rejected`
    // 在合同里是并列的，不是同义词。
    if (!result.ok) {
      const out = this._failureResult(result.error, result.code || 'resource_error');
      if (result.request_state || result.execution_state) {
        out.state = 'unknown';
        // `state:unknown` 与 `result_kind:indeterminate` 是同一件事的两个说法，不能一个说
        // “不知道”而另一个说“失败了”。
        out.result_kind = 'indeterminate';
        out.request_state = result.request_state || null;
        out.execution_state = result.execution_state || null;
        out.execution_may_continue = result.execution_may_continue === true;
        out.terminated_confirmed = result.terminated_confirmed === true;
        if (result.request_id) out.request_id = result.request_id;
      }
      return out;
    }
    return { result: result.data };
  }
}

export default new ToolExecutor();