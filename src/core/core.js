import { readEnv, jsonLogEnabled } from './env.js';
import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import { types } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { LifecycleManager } from './lifecycle-manager.js';
import { computeStopOrder, dependentsOf } from './dependency-resolver.js';
import { isValidPluginName } from './plugin-meta.js';

const COLORS = {
  reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', gray: '\x1b[90m',
  bold: '\x1b[1m',
};

function colorize(color, text) {
  return `${COLORS[color] || ''}${text}${COLORS.reset}`;
}

// 插件 init 的服务追踪上下文：ALS 按调用链隔离，并发懒加载不互踩单例全局态。
const _svcTracking = new AsyncLocalStorage();

// 宿主归属标记。`@` 开头不是合法插件名（`isValidPluginName` 在 register/loadOne/indexLazy
// 三处强制，不靠注释），于是"这条服务谁都不能按名卸载"可判定。
const HOST_OWNER = '@host';

/**
 * 宿主控制体：**模块私有**，构造期一次性绑定本实例。
 *
 * 为什么不是 Core 上的字段、也不是 `core.issueHostHandle()`：
 * 字段可读即可复制，发证函数可调即可自封。本表在模块作用域内，外部只能经
 * `createRuntime()` 拿到与**某个已存在实例**绑定的那个对象；插件即便持有 core 引用，
 * 也问不出「这个实例的控制体是什么」—— 发证与验证因此不对称。
 */
const HOST_CONTROLS = new WeakMap();
// 注册即拒的 schema 关键字：静默忽略会让"声明了约束"与"约束生效"脱节。
const UNSUPPORTED_SCHEMA_KEYWORDS = ('enum const oneOf anyOf allOf not pattern format minimum maximum exclusiveMinimum exclusiveMaximum multipleOf minLength maxLength items minItems maxItems uniqueItems $ref').split(' ');
// schema 支持面白名单（rc.33 / R32-05）：字面上就是 `_schemaViolation` 真正会执行的那点东西。
// 根对象允许 4 个**约束**关键字 + 2 个**注释**关键字，属性子表只允许 `type` + 注释；
// 不在这里“猜调用方意图”——出现白名单外的关键字 ⇒ 注册期具名拒绝，绝不静默忽略。
//
// 为什么放 `title`/`description`/`default` 进来：它们不携带任何**断言**（不是“没校验”，而是
// “没有可校验的东西”）。把它们也拒掉，等于逼 80 个插件删掉自己的参数说明 —— 为了让判据看起来
// 更严，去牺牲可读性，那是另一种形式的偷懒。`pattern`/`enum`/`$ref` 这类**能改变准入结论**的
// 关键字一个都不放：那才是“声明了却不管”。
// `default` 特别说明：本内核**从不填充默认值**（谁用谁填，见 contract 的 no-op 列表），
// 所以它只是文档，不是“缺失即补”的承诺。
const ROOT_SCHEMA_KEYWORDS = ['type', 'required', 'properties', 'additionalProperties', 'title', 'description', 'default'];
const PROPERTY_SCHEMA_KEYWORDS = ['type', 'title', 'description', 'default'];
const SCHEMA_ANNOTATION_KEYWORDS = ['title', 'description'];
const JSON_SCHEMA_TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'];
// scope 等级（read < write < admin）：admin 蕴含 write，write 蕴含 read。
// **null 原型**：`in` 与裸下标会沿着原型链找到 `toString`/`constructor`/`__proto__`；
// 一旦有人把 `'toString'` 当 scope 传进来，`(函数 ?? 0)` 不是数字，任何大小比较都返回
// `false` —— 「等级不足」这条判据对非法值**恒假**，就是 fail-open。
const SCOPE_RANK = Object.assign(Object.create(null), { read: 1, write: 2, admin: 3 });

// 日志/失败载荷的**格式级**密钥形状探测，命中才替换：只保证"不把明显密钥形状原样写进
// 日志"，不构成凭据识别能力的承诺。
const SECRET_SHAPE = /(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-|eyJ[A-Za-z0-9_-]{10,}\.|Bearer\s)/;

// 调用结果的**具名码 → 状态**映射（合同层，稳定不删）。三态必现；`cancelled` 是**保留
// 类型**：当前不存在可证明的 Abort 合同（取消请求 ≠ 副作用已撤销），实现不得产生它。
const CAPABILITY_CODE_STATE = {
  capability_not_found: 'failed',
  // 两个"名字不存在"必须分开：前者是**装配缺陷**（failed，去查装配），后者是**请求无效**
  // （denied，去改调用）。共用一个 code 会让 core 判 failed、执行器判 rejected。
  tool_not_registered: 'denied',
  capability_frozen: 'denied',
  capability_denied: 'denied',
  out_of_bounds: 'denied',
  // 与"路径越界"同级：信任边界拒绝（具名、可审计），网关据此回 400 而不是 200。
  invalid_session_id: 'denied',
  invalid_input: 'failed',
  resource_error: 'failed',
  handler_threw: 'failed',
  timeout_no_abort: 'failed',      // command() 超时竞速返回：副作用未撤销，故为 failed 而非 cancelled
};

/**
 * 拒绝码**不能**自带执行阶段：`err.code` 是任意插件都能赋的字符串，谁也证明不了它来自
 * 哪条前置检查。唯一判据是**谁能证明** —— 只有 Core 在 dispatch 之前产出的拒绝才是
 * `denied`（显式标 `dispatched:false`），从 handler 冒出来的一律 `failed` +
 * `side_effect:'unknown_or_possible'`，原始 `code` 原样保留（下游原因仍可见，但它不再是
 * 时间线的证据）。内置工具"越界时确实没碰资源"由工具自己的测试保证，不由 Core 背书。
 *
 * 七类归一：`code` 说"什么原因"，`category` 说"该找谁"。未登记的 code 返回 `null`，
 * **不猜** —— 把插件自定义码硬塞进 `internal` 等于把"我不知道"说成"我方有缺陷"。
 */
const CODE_CATEGORY = {
  // request：调用方给的东西不对 ⇒ 改调用参数
  invalid_input: 'request', tool_not_registered: 'request',
  invalid_session_id: 'request', out_of_bounds: 'request',
  // assembly：装的这套东西不成立 ⇒ 查装配/场景/依赖
  capability_not_found: 'assembly', missing_required_service: 'assembly',
  dependency_cycle: 'assembly', plugin_source_not_found: 'assembly',
  // 缺了这两条 categorizeCode 会返回 null。
  lazy_load_failed: 'assembly', lazy_load_timeout: 'assembly',
  // 装配在停止之后才完成 / 同名不同实例：都不是 capability_not_found。
  assembly_superseded: 'assembly', plugin_name_conflict: 'assembly', plugin_name_mismatch: 'assembly',
  // environment：宿主环境不支持或未就绪 ⇒ 查平台/版本/配置
  plugin_module_not_esm: 'environment', workspace_unavailable: 'environment',
  unsupported_restricted_shell: 'environment',
  // 归 environment 不归 security：不是"你没权限"，是"机器已经关机了"，restart 后能成功。
  core_not_running: 'environment',
  // resource：有配额、被限流、超预算 ⇒ 等、扩容、缩请求
  quota_exceeded: 'resource', rate_limited: 'resource',
  context_budget_exceeded: 'resource', circuit_open: 'resource',
  // security：被信任边界拒绝 ⇒ **不要重试**，查权限
  capability_denied: 'security', capability_frozen: 'security',
  sandbox_path_denied: 'security', receipt_not_yours: 'security',
  // upstream：下游/模型/流失败 ⇒ 查下游
  model_error: 'upstream', stream_error: 'upstream', api_version_conflict: 'upstream',
  // internal：我方代码出错 ⇒ 报缺陷
  handler_threw: 'internal', no_binding: 'internal',
  declared_but_missing: 'internal', drain_timeout: 'internal',
  // 归 internal：码名就写着 "no_abort" —— 超时之所以只能"不知道"，是因为我方没有可证明的
  // Abort 合同，要改的是实现。调用方该做什么由 `result_kind:'indeterminate'` 表达。
  timeout_no_abort: 'internal',
};

/** code → 七类之一；未登记返回 `null`（不猜）。 */
export function categorizeCode(code) {
  return typeof code === 'string' ? (CODE_CATEGORY[code] ?? null) : null;
}

/**
 * `result_kind` 补 `state` 表达不了的区分，**不是 `state` 的别名**：
 *   denied 没执行、确定无副作用（只有 Core 亲眼所见的前置拒绝能给）；
 *   failed 调用失败，**跑没跑要看 `dispatched`**，副作用可能已发生；
 *   indeterminate 不知道执行到哪、副作用未知（等候超时仍在跑、排空被打断）。
 * 两者不互相推导：`failed` 不等于"执行了但失败"（枚举都没派发也报 failed）；
 * `timeout_no_abort` 与 `handler_threw` 同为 failed，但前者是"不知道"、后者是"知道失败"。
 */
const INDETERMINATE_CODES = new Set(['timeout_no_abort', 'drain_timeout', 'lazy_load_timeout']);

/**
 * `result_kind` 的**唯一实现**（导出是必须的：执行器的对外信封要用同一张真相，不在外围
 * 再拄一份表）。
 */
export function resultKindOf(state, code, extra) {
  if (state === 'denied') return 'denied';
  if (INDETERMINATE_CODES.has(code)) return 'indeterminate';
  if (extra?.execution_outcome === 'unknown' || extra?.still_running_at_return === true) return 'indeterminate';
  return 'failed';
}

function ts() {
  return new Date().toISOString().slice(11, 23);
}

class Core extends EventEmitter {
  constructor(options = {}) {
    super();
    this.setMaxListeners(0);
    const opts = options || {};
    this.stateDir = opts.stateDir || readEnv('STATE_DIR') || `${process.env.HOME}/.tusunsun`;
    this.configPath = opts.configPath || `${this.stateDir}/config.json`;
    // CLI 的 `--port` 是**会话级覆盖**：config 插件 init 时用它覆盖 gateway.port
    // （只改内存、不落盘），于是 `--port 1234` 与 `--port 0`（随机可用端口）都真正生效。
    // null/undefined = 未指定，沿用配置文件。
    this.port = opts.port ?? null;
    // 用 fileURLToPath 而非 decodeURIComponent(.pathname)：后者在 Windows 上会留下前导斜杠（/C:/...）
    this.pluginsDir = opts.pluginsDir || fileURLToPath(new URL('../../plugins', import.meta.url));
    this.plugins = new Map();
    this.running = false;
    this._startTime = null;
    // `attempt_token` 的唯一性**只在单个 Core 实例内成立**（单实例自增）。若把它当跨进程/
    // 跨 Cell 的全局标识传给天桥之类的证据库，就会撞号。所以另给 `incarnation_id`：
    // 进程启动时生成一次，同一进程的多个 Core 也各不相同（含随机段）。
    // 复合标识 = `${incarnation_id}/${attempt_token}`，跨进程唯一性由前者承担。
    // 不改变 `attempt_token` 的格式 —— 那会破坏既有解析。
    this.incarnationId = opts.incarnationId || `inc-${process.pid.toString(36)}-${randomUUID().slice(0, 8)}`;

    this._capabilities = new Map();
    // 单次登记身份与定向撤销凭据（专家 RC14-IDENT/S6 裁决 A）。凭据只存 WeakMap：
    // `listCapabilities` / JSON / 日志 / 事件都取不到；可列举的字符串一律不作授权。
    this._capHandles = new WeakMap();
    this._capSeq = 0;
    this._services = new Map();
    // 受信调用主体登记表（服务端侧），替代"调用方自报 opts._trusted"的旁路。
    this._trustedCallers = new Map();
    // 身份授权令牌由**宿主在构造时注入**（不是 core 自己签发），见 assertIdentity 的边界。
    this._identityAuthority = opts.identityAuthority ?? null;
    this._pipelines = { inbound: [], outbound: [] };
    // 订阅账按**单次注册**记 owner，且按 **entry** 寻址。
    // 把 owner 与事件名写在函数对象上时，"同一个回调被两个 owner 各订阅一次"没有地方存，
    // `offByOwner('A')` 只能按函数删，会把 B 那条一起删掉。按 entry 寻址再撤销：
    // `super.removeListener(event, fn)` 删的是**最后一条同名函数**，不是账本指的那一条。
    // 所以每次带 owner 的注册都生成**唯一 wrapper**，账本记住它，撤销按它精确删。
    this._subs = new Set();            // Set<entry>：entry = {id, event, fn, owner, wrapper, once}
    this._subsByOwner = new Map();     // Map<ownerKey, Set<entry>>（**派生索引**，可由 _subs 重建）
    this._subSeq = 0;
    // 中间件同样按**注册 token** 记账（与 `_subs` 同一个 entry 对象，
    // 不做第二份"谁是谁"的推断）：用 `lastIndexOf(fn)` 删管道里的一条、又从 owner 账本
    // 删另一条时，两套结构各自猜同一个函数指哪一次注册，必然删错。
    this._pipelineOwners = new Map();  // Map<ownerKey, Array<entry>>（**派生索引**，可由 _pipelines 重建）
    this._pipeSeq = 0;
    // 已提交事实通知里被隔离下来的观察者异常（不静默，也不改写已提交结论）。
    // 异步观察者的拒绝也进这里：同步 try/catch 捕不到 Promise 拒绝。
    this._observerErrors = [];
    this._observerPendingAsync = 0;
    // 不是纯数据的事实载荷（含服务对象/文件句柄/环）只能退回浅冻结 ——
    // 把"不可变承诺没生效"记在账上，而不是假装已经保护了。
    this._factDegraded = new Map();    // Map<event, count>
    this._data = new Map();
    this._inflight = new Map();
    // I-04：插件状态跃迁的唯一执行者（见 function-ownership.md 事实 #4）。
    // 清场通道只在这里交出去一次：**构造期注入**，公开面上没有签发入口。
    this.lifecycle = new LifecycleManager(this, this.#reap);
    // 装配期失败记录（插件对象已被 unload 移除，但失败这件事要留下 —— 只读视图靠它）。
    this._startFailures = new Map();
    this._serviceOwners = new Map();
    // 服务登记实例：与 `_serviceOwners` 同一原子块写入，供实例级清场再叠一层身份匹配。
    this._serviceRegistrar = new Map();
    // 宿主显式接管服务的覆盖记录："对象已经换人"要能查，不能只留在归属字符串里。
    this._serviceTakeovers = new Map();
    // 单次登记身份：释放判据是 `compare-and-delete(registrationId)`，不是服务名 ——
    // 旧凭据打在同名新登记上必须是 stale，绝不误删后继（ABA）。
    this._serviceRegIds = new Map();
    this._svcSeq = 0;
    this._initOwner = null;
    // 宿主控制体：构造期绑定本实例，**不挂在公开面上**。
    HOST_CONTROLS.set(this, Object.freeze(Object.create(null)));
    // Core 的**运行世代**：一次装配开始时绑定它，停止时递增 ——
    // 于是"迟到完成的装配"能被一个整数判出来，不必为此新增第四个状态机。
    // 它与 `running` 不是同一个事实：`running` 回答"现在能不能派发"，
    // `_epoch` 回答"**这笔装配**还有没有提交权"。
    this._epoch = 0;
    this._stopping = false;
    this._stopped = false;
    // 在途装配登记（只登记、不判断；判断一律用 `_epoch`）。`Core.stop` 用它给出 outstanding_assembly。
    this._assemblies = new Set();
    // 停止时给在途装配的收尾窗口。**必须有界**：装配可能卡在插件自己的 init 上，
    // Core 不能因此永久挂住关机；但"我继续了"不能报成"资源已释放"（见 stop 的 outstanding）。
    this._stopAssemblyDrainMs = 800;
    // 并发 stop() 共享同一笔停机（见 `stop`）。null = 没有正在进行的停机。
    this._stopPromise = null;
    // 停止段按插件取独占区的**有界**等待：插件在自己的 stop() 里去卸别的插件就是
    // "持 P 等 Q"，无界等待会把关机变成永久挂住。超时只降级这一条，不放弃整次停机。
    this._stopLockMs = 2000;
    this._msgCount = 0;
    this._lazyHook = null;
    this._trackServiceAccess = false;
    this._trackedServices = new Set();
    this._confirmCount = 0;
    this._taskConfirmCounts = [];
    this._currentTaskConfirms = 0;

    this.on('error', (err) => {
      let msg;
      try { msg = err?.message ?? String(err); } catch { msg = '[unprintable error]'; }
      this.log('error', `[core] ${msg}`);
      if (err?.stack) this.log('debug', err.stack);
    });
  }

  _safeStringify(v) {
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v); } catch { return String(v); }
  }

  logJSON(level, message, extra = {}) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      msg: message,
      ...extra,
    };
    process.stdout.write(JSON.stringify(entry) + '\n');
  }

  log(level, ...args) {
    const msg = this._redactSecrets(args.map(a => this._safeStringify(a)).join(' '));
    // 两条流不同时写同一事件：人读走 stderr（恒），JSONL 只在机器模式下发 stdout
    // （见 env.js 的 jsonLogEnabled）；TTY 下只有一份。
    if (jsonLogEnabled()) this.logJSON(level, msg);
    const ts_str = colorize('gray', `[${ts()}]`);
    const lvl = colorize(
      level === 'error' ? 'red' : level === 'warn' ? 'yellow' : level === 'info' ? 'green' : 'gray',
      `[${level}]`.padEnd(7)
    );
    process.stderr.write(`${ts_str} ${lvl} ${msg}\n`);
  }

  /**
   * 插件自报的错误文本会经 `log()` / `core.stopped` 原样外泄：插件把凭据写进
   * `Error.message` 就等于写进日志。只做**格式级**脱敏 —— 命中高熵形状才替换，
   * 其余文本逐字节不变（先用 SECRET_SHAPE 探一次，不给每条日志都跑 5 条正则）。
   * 它是**兜底**，不是权限边界，不承诺识别所有密钥形状。
   */
  _redactSecrets(text) {
    if (typeof text !== 'string' || text.length === 0) return text;
    if (!SECRET_SHAPE.test(text)) return text;
    return text
      .replace(/\b(sk-[A-Za-z0-9_-]{16,})/g, '[REDACTED]')
      .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,})/g, '[REDACTED]')
      .replace(/\b(xox[baprs]-[A-Za-z0-9-]{10,})/g, '[REDACTED]')
      .replace(/\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})/g, '[REDACTED]')
      .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, '$1[REDACTED]');
  }

  colorize = colorize;

  /**
   * 订阅 = **一次注册**，不是一个函数的属性；注册身份 = **一个 wrapper**。
   * Node 的 removeListener 只按函数匹配，同一函数注册两次就无法区分"删哪一条"，
   * 所以每次注册给一个物理身份。
   *
   * 公开行为保持 EventEmitter 兼容：`on` 返回 this；`off(event, fn)` 仍按 (事件, 函数)
   * 删**最后一条**（与 Node 一致）。变化只在账本：每次注册一条 entry，撤销按 entry。
   */
  _recordSub(event, listener, owner, opts = {}) {
    if (owner === undefined || owner === null) return null;
    const key = String(owner);
    const entry = { id: ++this._subSeq, event, fn: listener, owner: key, once: opts.once === true, wrapper: null };
    const self = this;
    entry.wrapper = function (...args) {
      // once：先从 EventEmitter 与账本上同时摘掉自己（只删账不删监听 = 每触发一次多留一条），
      // 再执行用户回调。
      if (entry.once) self._removeEntry(entry);
      return entry.fn.apply(this, args);
    };
    entry.wrapper.listener = listener;   // Node 约定：listeners() 据此还原原函数
    this._subs.add(entry);
    this._indexSub(entry);
    return entry;
  }

  _indexSub(entry) {
    let set = this._subsByOwner.get(entry.owner);
    if (!set) { set = new Set(); this._subsByOwner.set(entry.owner, set); }
    set.add(entry);
  }

  _unindexSub(entry) {
    const set = this._subsByOwner.get(entry.owner);
    if (set) { set.delete(entry); if (!set.size) this._subsByOwner.delete(entry.owner); }
  }

  /** 精确摘掉一条 entry：账本、派生索引、EventEmitter 三处同一次提交。 */
  _removeEntry(entry) {
    if (!this._subs.delete(entry)) return false;
    this._unindexSub(entry);
    super.removeListener(entry.event, entry.wrapper);
    return true;
  }

  /** 找"最后一次注册"的 entry：Node 的 removeListener 删的就是最后一条。 */
  _findEntry(event, listener) {
    let hit = null;
    for (const entry of this._subs) {
      if (entry.event !== event) continue;
      if (entry.fn !== listener && entry.wrapper !== listener) continue;
      hit = entry;
    }
    return hit;
  }

  /**
   * **派生索引可重建**：`_subsByOwner` / `_pipelineOwners` 只是 `_subs` / `_pipelines` 的
   * 派生视图，权威事实是 entry 本身。丢掉索引再重建，语义必须一模一样 ——
   * 这条测试防的正是"两套手写可变真相慢慢漂移"。
   */
  _rebuildOwnerIndex() {
    this._subsByOwner.clear();
    for (const entry of this._subs) this._indexSub(entry);
    this._pipelineOwners.clear();
    let middleware = 0;
    for (const stage of Object.keys(this._pipelines)) {
      for (const entry of this._pipelines[stage]) {
        if (!entry.owner) continue;
        let list = this._pipelineOwners.get(entry.owner);
        if (!list) { list = []; this._pipelineOwners.set(entry.owner, list); }
        list.push(entry);
        middleware++;
      }
    }
    return { subs: this._subs.size, middleware };
  }

  _hasSubscribed(event, listener) {
    return this.rawListeners(event).some((f) => f === listener || f.listener === listener);
  }

  on(event, listener, opts = {}) {
    if (typeof event === 'object') {
      const { event: ev, owner, ...rest } = event;
      event = ev;
      opts = { owner: opts.owner || rest.owner, ...rest };
    }
    if (typeof listener !== 'function') return this;
    // owner 必须按同一把尺子归一：`get(String(owner))` 却 `set(opts.owner)` 时，
    // 数字 owner 会把同一份账拆成两条。
    const entry = this._recordSub(event, listener, opts?.owner);
    return super.on(event, entry ? entry.wrapper : listener);
  }

  /**
   * `once` 的注册同样要有身份，且触发后要把自己的记录摘掉：
   * 带 owner 的 `once` 走同一个 entry 机制（`once:true` 由 wrapper 自行摘除）。
   */
  once(event, listener, opts = {}) {
    if (typeof listener !== 'function') return super.once(event, listener);
    const entry = this._recordSub(event, listener, opts?.owner, { once: true });
    if (!entry) return super.once(event, listener);
    return super.on(event, entry.wrapper);
  }

  off(event, listener) {
    const entry = this._findEntry(event, listener);
    if (entry) { this._removeEntry(entry); return this; }
    return super.off(event, listener);
  }

  removeListener(event, listener) {
    return this.off(event, listener);
  }

  removeAllListeners(event) {
    if (event === undefined) {
      this._subs.clear();
      this._subsByOwner.clear();
    } else {
      for (const entry of [...this._subs]) {
        if (entry.event !== event) continue;
        this._subs.delete(entry);
        this._unindexSub(entry);
      }
    }
    return super.removeAllListeners(event);
  }

  /**
   * 只撤销**这个 owner 的确切订阅记录**。
   * 按函数删（`for (ev of fn._events) this.off(ev, fn)`）时，同一个函数被别的 owner
   * 订阅的那条会被一并删掉 —— 删记录，不删函数。
   */
  offByOwner(owner) {
    const key = String(owner);
    const recs = this._subsByOwner.get(key);
    if (!recs || recs.size === 0) return 0;
    let count = 0;
    // 按 entry 精确删：每条 wrapper 唯一对应一次注册，删它不会碰到同一函数的别的注册。
    // 已经不在了的（once 已自行摘除）不计数 —— 返回的数字要能被 listenerCount 核对上。
    for (const entry of [...recs]) if (this._removeEntry(entry)) count++;
    this._subsByOwner.delete(key);
    this.log('info', `Cleaned ${count} listeners for owner: ${this.colorize('cyan', key)}`);
    return count;
  }

  emit(event, payload) {
    if (typeof event !== 'string') return false;
    if (event !== 'error' && !event.includes('.')) {
      this.log('warn', `Event rejected: name must contain "." — got "${event}"`);
      return false;
    }
    this._msgCount++;
    if (payload && typeof payload === 'object') {
      if (!('timestamp' in payload)) payload.timestamp = new Date().toISOString();
      if (!('sourcePlugin' in payload)) {
        this.log('warn', `Event "${event}" payload missing "sourcePlugin"`);
      }
      if (Object.getPrototypeOf(payload) === Object.prototype) {
        return super.emit(event, Object.freeze({ ...payload }));
      }
    }
    return super.emit(event, payload);
  }

  /**
   * **已提交事实**的通知面：观察者的异常不得把已经发生的事倒写成失败。能不能提交由 Core
   * 判断，有没有人看、看得好不好，不改变已提交的事实。
   *
   * 不是"所有 emit 一律吞错"：只有登记在案的**观察类事实**走这条路；Guard 与安全钩子
   * 保持 fail-closed，`emit()` 原样未改。隔离下来的异常进 `getObserverErrors()` —— 不静默。
   */
  emitFact(event, payload) {
    this._msgCount++;
    // 对外是**一份观察者改不动的快照**（只做浅冻结时，嵌套数组/对象仍与事实源共享引用）。
    const arg = this._snapshotFact(payload, event);
    const errors = [];
    let delivered = 0;
    for (const listener of this.rawListeners(event).slice()) {
      let ret;
      try { ret = listener.call(this, arg); }
      catch (err) { this._recordObserverError(errors, event, err, 'sync'); continue; }
      delivered++;
      // 异步观察者的拒绝捕不到。**不等待**（非关键遥测不得拖住已提交的操作），
      // 但必须消费它的 rejection —— 否则宿主会收到进程级 unhandledRejection。
      // 安全/策略钩子不适用这条：它们按同步派发合同判定（见 hook-guard-event.md）。
      let thenable = false;
      try { thenable = !!ret && typeof ret.then === 'function'; } catch { thenable = false; }
      if (thenable) {
        this._observerPendingAsync++;
        Promise.resolve(ret).then(undefined, (err) => {
          this._recordObserverError(null, event, err, 'async');
        }).finally(() => { this._observerPendingAsync--; });
      }
    }
    if (errors.length) this._pushObserverErrors(errors);
    return { delivered, errors, asyncPending: this._observerPendingAsync };
  }

  /**
   * 把"已提交事实"变成观察者**改不动**的一份快照（只做浅冻结时，嵌套对象仍与事实源
   * 共享引用：第一个观察者写进去，后面的人和事实源都跟着变）。
   *
   * 判环用**当前祖先路径**而非"曾经访问过"：`{a:shared,b:shared}` 是合法共享引用，误判成
   * 环就会退化成浅冻结 —— 那恰好是观察者能改到事实源的那条路。
   * 边界：只对**纯数据**深拷 + 深冻结；服务对象/句柄/Map/Set/函数/真环不深拷（会改语义），
   * 退回浅冻结并记账（`_factDegraded`）—— "不可变承诺没生效"要被看见，不许假装已保护。
   */
  _snapshotFact(payload, event) {
    if (payload === null || typeof payload !== 'object') return payload;
    const path = new Set();        // 只装当前递归**祖先**，出栈即删 ⇒ 共享引用与环被判成不同结论
    const certified = new Map();   // 节点 → 认证为纯数据时的深度：浅处认证覆盖深处查询，共享子树只走一遍
    let nodes = 0;
    const pureData = (v, depth) => {
      if (v === null) return true;
      const t = typeof v;
      if (t === 'string' || t === 'boolean') return true;
      if (t === 'number') return Number.isFinite(v);
      if (t !== 'object') return false;      // function / symbol / bigint / undefined
      if (depth > 8) return false;
      if (path.has(v)) return false;         // 真环：不深拷，也不猜
      const done = certified.get(v);
      if (done !== undefined && done >= depth) return true;
      if (++nodes > 2000) return false;      // 病态载荷不得拖住提交
      path.add(v);
      let ok = true;
      try {
        if (Array.isArray(v)) {
          for (const item of v) { if (!pureData(item, depth + 1)) { ok = false; break; } }
        } else {
          const proto = Object.getPrototypeOf(v);
          if (proto !== Object.prototype && proto !== null) ok = false;
          else for (const k of Object.keys(v)) { if (!pureData(v[k], depth + 1)) { ok = false; break; } }
        }
      } finally { path.delete(v); }
      if (ok) certified.set(v, depth);
      return ok;
    };
    if (!pureData(payload, 0)) {
      this._factDegraded.set(event, (this._factDegraded.get(event) || 0) + 1);
      return Object.getPrototypeOf(payload) === Object.prototype ? Object.freeze({ ...payload }) : payload;
    }
    return this._freezeClone(payload);
  }

  _freezeClone(v) {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return Object.freeze(v.map((x) => this._freezeClone(x)));
    const out = {};
    for (const k of Object.keys(v)) out[k] = this._freezeClone(v[k]);
    return Object.freeze(out);
  }

  /**
   * 登记类声明（`permissions` / `input_schema` / `output_schema`）的**权威快照**：
   * 深复制（否则准入判据的写权留在登记方）+ 深冻结（否则副本还能被改回权威值）+
   * 不支持的载荷**具名拒绝**（禁止"克隆失败就浅冻结"—— 那样 `properties` 仍是同一对象，
   * 「独立快照」在最需要它的那条分支上恰好不成立）。
   *
   * 不复用 `_snapshotFact` 的"允许降级但记账"：事件载荷可以是什么都行，拒收等于丢掉已发生
   * 的事实；声明是**准入判据**，拿不准的不该被接受，更不该接受后还宣称已隔离。
   */
  _lockDecl(v, which) {
    if (v === null || typeof v !== 'object') return v;
    return this._declSnapshot(v, which);
  }

  /**
   * **一次遍历**完成「判纯度 + 复制 + 冻结」，返回的副本就是权威值本身。
   *
   * 为什么不能先校验再复制（rc.32 / RC31-C1 的根因）：两趟之间声明可能给出不同读数。
   * 实测把 `properties` 做成 enumerable getter，三次读分别返回合规/合规/含 `pattern`，
   * 于是「支持面校验」看到的是纯数据、「权威快照」存进去的是带 `pattern` 的对象 ——
   * 一个声明没被校验却被记成「已校验」。用 property descriptor 读**一次** `value`，
   * 判据与副本必然来自同一个读数。
   *
   * 访问器一律拒绝（不是「尽量判稳」）：getter 的返回值由被审对象决定，而快照要求
   * 「同一份声明任意次读取给出同一结论」。Proxy 单独判 —— 它的读取行为同样不受登记方控制。
   */
  _declSnapshot(v, which) {
    const stack = new Set();
    let nodes = 0;
    const bad = (why) => {
      const err = new Error(`declaration_not_pure_data: ${which} 只能由纯数据构成（${why}）`
        + '——访问器/函数/环/过深/超量/Proxy 做不出「任一次读取都给同一结论」的快照，登记期具名拒绝；'
        + '不做「先审一个对象、再提交另一个对象」的两趟校验');
      err.code = 'declaration_not_pure_data';
      throw err;
    };
    const walk = (x, depth, path) => {
      if (x === null) return null;
      const t = typeof x;
      if (t === 'string' || t === 'boolean') return x;
      if (t === 'number') { if (!Number.isFinite(x)) bad(`${path} 是非有限数字`); return x; }
      if (t !== 'object') bad(`${path} 是 ${t}`);
      if (types.isProxy(x)) bad(`${path} 是 Proxy（属性读取不受登记方控制）`);
      if (depth > 8) bad(`${path} 嵌套超过 8 层`);
      if (stack.has(x)) bad(`${path} 构成环`);
      if (++nodes > 2000) bad(`${path} 起超过 2000 个节点`);
      if (Object.getOwnPropertySymbols(x).length > 0) bad(`${path} 含 symbol 键（JSON 无此概念）`);
      stack.add(x);
      try {
        if (Array.isArray(x)) {
          const out = [];
          for (let i = 0; i < x.length; i++) {
            const d = Object.getOwnPropertyDescriptor(x, String(i));
            if (!d) bad(`${path}[${i}] 是空位`);
            if (!('value' in d)) bad(`${path}[${i}] 是访问器`);
            out.push(walk(d.value, depth + 1, `${path}[${i}]`));
          }
          return Object.freeze(out);
        }
        const proto = Object.getPrototypeOf(x);
        if (proto !== Object.prototype && proto !== null) {
          bad(`${path} 不是普通对象（原型 ${proto?.constructor?.name ?? 'null'}）`);
        }
        const out = {};
        for (const k of Object.keys(x)) {
          const d = Object.getOwnPropertyDescriptor(x, k);
          if (!d) bad(`${path}.${k} 在枚举之后消失`);
          if (!('value' in d)) bad(`${path}.${k} 是访问器（getter 每次读可以不同）`);
          // 用 `defineProperty` 而不是 `out[k] =`：对 `__proto__` 赋值会改原型而不是写一个键，
          // 「JSON 里的 __proto__ 键」在快照里会被静默丢掉。这里保留它的 JSON 含义。
          Object.defineProperty(out, k, {
            value: walk(d.value, depth + 1, `${path}.${k}`), enumerable: true, writable: true, configurable: true,
          });
        }
        return Object.freeze(out);
      } finally { stack.delete(x); }
    };
    return walk(v, 0, which);
  }

  /**
   * 只读视图的取值口径：**独立副本**。
   *
   * 存入端已保证是纯数据的深冻结快照（见 `_lockDecl`），所以 `structuredClone` 必然成功；
   * 这里**故意不写**「失败就浅复制」的回退：浅复制与权威值共享嵌套对象，“视图”于是成了
   * 第二个写入面。万一将来有东西绕开 `_lockDecl` 存进来，让它在这里抛出来（调用点看得见），
   * 好过静默交出一份假的“副本”。
   */
  _copyDecl(v) {
    if (v === null || typeof v !== 'object') return v;
    return structuredClone(v);
  }

  /** 事实载荷降级记录：哪些事件不是纯数据、各降级了几次（取证用）。 */
  getFactDegraded() {
    return [...this._factDegraded.entries()].map(([event, count]) => ({ event, count }));
  }

  _recordObserverError(bucket, event, err, phase) {
    const message = this._redactSecrets(err?.message || String(err));
    const entry = { event, code: err?.code ? String(err.code) : 'observer_error', message, phase };
    // 同步路径进本次的 bucket，由 emitFact 统一落账（不重复记账）；
    // 异步路径没有 bucket，直接进有界诊断面。
    if (bucket) bucket.push(entry);
    else this._pushObserverErrors([entry]);
    this.log('warn', `[observer] "${event}" 的观察者（${phase}）抛错（已隔离，不改写已提交事实）：${message}`);
  }

  _pushObserverErrors(list) {
    this._observerErrors.push(...list);
    // 诊断面必须有界：观察者持续抛错不能变成内存增长。
    if (this._observerErrors.length > 200) this._observerErrors.splice(0, this._observerErrors.length - 200);
  }

  /**
   * **只读快照**，不是内部引用：`.slice()` 只换数组壳，元素仍是同一对象 ——
   * "数组不可变"不等于"元素不可变"，判据要落到元素上。
   * 元素是纯数据，深复制不丢信息；混入不可克隆载荷时退化为浅复制 + 冻结（下方标明），
   * 而不是静默交出一个可写引用。
   */
  getObserverErrors() {
    return this._observerErrors.map((e) => {
      try { return structuredClone(e); }
      catch { return Object.freeze({ ...e }); }   // SNAPSHOT_DEGRADED：含不可克隆载荷时
    });
  }

  clearObserverErrors() {
    const n = this._observerErrors.length;
    this._observerErrors = [];
    return n;
  }

  emitFast(event, payload) {
    if (typeof event !== 'string') return false;
    this._msgCount++;
    return super.emit(event, payload);
  }

  getMsgCount() {
    return this._msgCount;
  }

  // 返回值：true = 本次真的注册；false = 同名已存在，**具名跳过**。
  // 调用方（PluginManager）据此决定是否把插件计入本次装载集合——否则重名会污染
  // 拓扑排序的输入长度，被误报成"环"（见 dependency-resolver 的 not-orderable 分支）。
  async register(plugin) {
    if (!plugin || typeof plugin !== 'object' || !plugin.name || typeof plugin.init !== 'function') {
      throw new Error(`Plugin invalid: must have { name, init(core) }`);
    }
    // 名字就是身份：它决定服务归属、与宿主标记对照，还会被拼进文件路径。
    // 「非空」远远不够——`@host` 非空，且一注册就变成"谁都不能卸"的宿主。
    if (!isValidPluginName(plugin.name)) {
      const err = new Error(`plugin_name_invalid: "${plugin.name}" 不是合法插件名`
        + '（要求 /^[a-z0-9][a-z0-9._-]*$/；`@` 前缀保留给宿主接管标记）');
      err.code = 'plugin_name_invalid';
      throw err;
    }
    if (this.plugins.has(plugin.name)) {
      this.log('warn', `Plugin "${plugin.name}" already registered, skipping`);
      this.emit('core:plugin.conflict', { pluginName: plugin.name, timestamp: new Date().toISOString(), sourcePlugin: 'core' });
      return false;
    }
    plugin.state = 'registered';
    this.plugins.set(plugin.name, plugin);
    this.log('info', `Plugin registered: ${colorize('cyan', plugin.name)} v${plugin.version || '0.0.0'}`);
    return true;
  }

  async start() {
    if (this.running) return;
    // **停机进行中不得重新武装闸门**：`_stopLocked` 开头就把 `running` 置 false，而
    // `_stopped` 要到收尾才置 true —— 中间整段（排空 + 逐个停 + 有界等锁）两个都是 false。
    // 窗口里 start() 会写 `running=true/_stopping=false/_epoch+=1`，把刚关上的闸门重新打开；
    // 随后 `_stopLocked` 跑完又写 `_stopped=true`，于是这台 Core 既 running 又 stopped，
    // 永远派发不了、也永远停不下来（实测：新装载的插件在表里 running，`stop()` 一次没被调）。
    if (this._stopping || this._stopPromise) {
      const err = new Error('core_start_during_stop: 停机正在进行；请等 stop() 完成后再新建 Core');
      err.code = 'core_start_during_stop';
      throw err;
    }
    // "重新 start（若产品允许重启）" —— 本产品**不允许**。
    // 依据不是口味：插件是模块级单例，再次 `init()` 会撞上它自己上次注册的能力
    // （`capability_conflict`），于是"重启"只会半启动。静默半启动比拒绝更糟，所以具名拒绝。
    // 要重启请新建 Core —— CLI 一直就是这么做的（进程级重启）。
    if (this._stopped) {
      const err = new Error('core_restart_not_supported: 本实例已 stop()，不支持原地重启；请新建 Core');
      err.code = 'core_restart_not_supported';
      throw err;
    }
    this.running = true;
    // 每次 start 开一个新世代：上一世代遗留的在途装配自此失去提交权 ——
    // "重启之后被上一代迟到的 init 悄悄补一个能力"与"停止后复活"是同一个缺陷。
    this._epoch += 1;
    this._stopping = false;
    this._stopped = false;
    this._startTime = Date.now();
    this.log('info', colorize('bold', '土行孙 starting...'));
    this.log('info', `State dir: ${this.stateDir}`);

    const requiredFailed = [];
    for (const [name, plugin] of this.plugins) {
      const r = await this._startPlugin(name, plugin);
      // 装配失败后插件已被 unload 移出 `plugins`，但"它失败过"这条事实必须留下来 ——
      // 否则只读视图（readiness 等）扫不到它，只能得出 "ready"：清理把证据一起删了。
      if (r) this._startFailures.set(name, r);
      if (r?.requiredFailed) requiredFailed.push(name);
    }

    // **必需**插件失败时不得宣告"一切正常"，也不能干脆不发 `core.ready`：不发会让挂在它上面
    // 做初始化的插件（assembly-lock / readiness）在失败场景彻底不执行。取舍是照发、载荷具名 status。
    // eager 循环跨了大量 await：期间的 stop 可能已发过 `core.stopped`，这里再补一句 "ready"
    // 会让事件序变成 stopped → ready，只读视图把一台已停止的 Core 标成就绪。
    if (this._stopping || this._stopped) return;
    const status = requiredFailed.length ? 'unavailable' : 'ready';
    this.log(requiredFailed.length ? 'error' : 'info', colorize('bold',
      `土行孙 ${status} (${this.plugins.size} plugins${requiredFailed.length ? `, required failed: ${requiredFailed.join(', ')}` : ''})`));
    this.emitFact('core.ready', {
      plugins: this.plugins.size,
      status,
      requiredFailed,
      timestamp: Date.now(),
      sourcePlugin: 'core',
    });
  }

  async _startPlugin(name, plugin) {
    if (plugin.state === 'running' || plugin.state === 'started') return null; // early-load 等已初始化的插件不重复 init
    const t0 = Date.now();
    // eager 装配同样绑定世代："stop 期间正在 start 的那个插件"与懒加载是同一个缺陷，
    // 只修懒加载那一条入口正是"判据看不见它的目标"。
    const asm = this.beginAssembly(name);
    try {
      this.log('info', `Starting plugin: ${colorize('cyan', name)}`);
      // 状态跃迁只有 LifecycleManager 一个写入者（见 function-ownership.md 事实 #4）：
      // 这里自己 init/start 并自己写 started/running/error 就会成为第 3 条装配路径，
      // 与 `lc.load` 重复且各自解释状态。
      await this.lifecycle.load(plugin, this, { epoch: asm.epoch });
      return null;
    } catch (err) {
      this.log('error', `Plugin "${name}" failed to start: ${err.message}`);
      // plugin.state 已由 lc.load 的 catch 置为 'error'，这里只负责对外报事实。
      this.emit('plugin.init_failed', {
        pluginName: name,
        error: err.message,
        // 一个叫 initTimeMs 的字段必须是耗时，不能是 epoch 量级的时间戳。
        initTimeMs: Date.now() - t0,
        timestamp: new Date().toISOString(),
        sourcePlugin: 'core',
      });
      // I-04：插件是否"必需"只有它自己的 manifest 说得清（degraded_policy）。
      // Core 不猜：没声明 block_startup 的一律按 optional，避免把可选失败说成不可用。
      return { requiredFailed: plugin.manifest?.degraded_policy === 'block_startup' };
    } finally {
      this.endAssembly(asm);
    }
  }

  /**
   * 停机入口。**幂等与共享是两件事**：已停 ⇒ 幂等返回；正在停 ⇒ 返回同一个 Promise。
   * 早返回会让第二个调用方在插件停完之前 resolve，紧接着的 `process.exit()` 截断插件收尾。
   */
  async stop() {
    if (this._stopped) return;
    if (this._stopPromise) return this._stopPromise;
    if (!this.running) return;                     // 从未 start：没有可停的东西
    this._stopPromise = this._stopLocked().finally(() => { this._stopPromise = null; });
    return this._stopPromise;
  }

  /**
   * 停产时序列：**关闸 → 排空 → 逐个停**。三段各有独占权纪律：
   *   ① 关闸：同步写完 `running/_stopping/_epoch`，无 await —— 全流程唯一的原子点。
   *   ② 排空：**不持任何锁**。等的是别人在跑的装配，它们可能正排在任意一把锁的队列里；
   *      持锁等待即成环，关机永久挂住。
   *   ③ 逐个停：**只取该插件自己的 key，不嵌套**。不取时 `core.stop()` 正在 `await Q.stop()`，
   *      并发的 `pm.unload(Q)` 会再调一次 `Q.stop()` 并推出第二个终态（见 D20-04/05）。
   */
  async _stopLocked() {
    this.running = false;
    // 进入 stopping 就**当场**开启新世代 —— 在途装配的提交权此刻失效，不等它跑完。
    // 只把 `running` 置 false 只管住**下一笔**派发，管不住**已经起跑**的装配：
    // 它的 init 返回后照样 `advance('running')` 并注册能力，而 plugin.stop 一次都没被调。
    this._stopping = true;
    this._epoch += 1;
    this.log('info', colorize('bold', '土行孙 stopping...'));

    // 内核**自身持有**的资源必须对称释放：PluginManager 的 idle 巡检 interval 由
    // `_startIdleTimer` 创建，不在 stop 里清掉，进程就无法自然退出。
    // 放在插件停止**之前**：即使后续某插件 stop 抛错，本实例持有的资源仍已被释放；
    // 且只记录、不吞错，也不把失败报成成功（插件异常仍走下方各自的 error 日志）。
    try {
      this.getService('plugin-manager')?._stopIdleTimer?.();
    } catch (err) {
      this.log('error', `[core.stop] idle timer cleanup failed: ${err.message}`);
    }

    // 先给在途装配一个**有界**的收尾窗口，再停插件。
    // 顺序理由：世代已经递增 ⇒ 这些装配醒来后只会走"迟到撤销"分支并自行清理；
    // 等它们一下，能让"停止"看到的是清理后的状态，而不是一堆 registered 残骸。
    const outstanding = await this._drainAssemblies();

    const stopFailures = [];
    // 按**逆拓扑序**停止：先让依赖方退出，再释放提供方（插入序下 dependent 的 stop() 会看到
    // 一个已经死掉的 provider）。运行期卸载有 `_step1CheckDependents` 拦，所以这是**关机
    // 这一条路径**上的顺序错误。
    //
    // **顺序 ≠ 停在**：`hold_timeout` 之后插件仍是 running 却可能还在用提供方的服务，此时
    // 往下停提供方就是把依赖方脚下的地拆了，而 `stopOrder` 读起来像"按正确顺序停好了"。
    // 故每轮重判：**还有依赖方没真停好就不许停它的提供方**，改记 `skipped_dependents_pending`。
    const skipped = [];
    for (const name of this._stopOrder()) {
      const blockers = this._pendingDependentsOf(name);
      if (blockers.length) {
        // 这是**有意的跳过**，不是失败：没有任何东西被拆掉，资源仍在依赖方手里。
        // 报成 failure 会让"我没动它"与"我试着停但停不下"混成同一件事。
        skipped.push({ plugin: name, code: 'skipped_dependents_pending', dependents: blockers });
        this.log('warn', `[core.stop] 跳过 "${name}"：依赖方 ${blockers.join(', ')} 尚未真正停止 —— `
          + '停止不等于调用返回，继续停会拆掉仍在被使用的提供方');
        continue;
      }
      const failure = await this._stopOnePlugin(name);
      if (failure) stopFailures.push(failure);
    }
    this._stopFailures = stopFailures;
    this._stopSkipped = skipped;

    // 窗口到点仍在跑的装配，其对象**不可能**再成为 running（世代已变）。
    // 不删它们（删除会让迟到的清理找不到对象），只如实标 unavailable ——
    // "已停止的 Core 里有一个永远不会跑的对象"必须能从状态读出来，不能靠猜。
    for (const a of outstanding) {
      const p = this.plugins.get(a.name);
      // 在途装配降级：这是停止路径上的**尽力标注**，不得反过来把 stop() 抹成 reject。
      // 非法转移会被 guard 记进 `_illegalTransitions`（测试断言它为 0），而不是抛到这里。
      if (p && p.state !== 'running' && p.state !== 'started') this.lifecycle.advance(p, 'unavailable', { bestEffort: true });
    }
    this._stopping = false;
    this._stopped = true;

    this.log('info', colorize('bold', '土行孙 stopped'));
    this.emitFact('core.stopped', {
      plugins: this.plugins.size,
      stopFailures,
      // 停止返回 ≠ 资源已完全释放：窗口内没跑完的装配逐条列在这里，调用方不必从日志猜。
      outstandingAssembly: outstanding,
      assemblyDrainMs: this._stopAssemblyDrainMs,
      // 顺序是"关系决定"还是"退路"必须可分辨。没有依赖信息时用插入序，
      // 这不是"正确的顺序"，只是**没有依据时唯一能做的事** —— 所以要标注出来。
      stopOrder: this._lastStopOrder,
      stopOrderBasis: this._lastStopOrderBasis,
      // 缺席的提供者与环必须能被调用方看见：只报"有序"不报"凭什么有序"时，
      // 排错只能从日志猜。
      stopOrderUnresolved: this._lastStopOrderUnresolved || [],
      stopOrderCycles: this._lastStopOrderCycles || [],
      // 因依赖方尚未真正停止而**没被停**的提供方。与 stopFailures 分开：
      // 一个是「试着停但没停成」，一个是「根本没动，因为动了就会拆坏东西」。
      stopSkipped: skipped,
      timestamp: Date.now(),
      sourcePlugin: 'core',
    });
  }

  /**
   * 停一个插件（时序列第 ③ 段）。成功返回 null，失败返回记录。
   * 状态在**取锁之后**才读：排队期间并发的 unload 可能已把它移出表，那时什么都不该做。
   * 有界取锁：插件在 stop() 里去卸别的插件就是"持 P 等 Q"；超时降级为可观测失败，
   * 因为停机路径上"永久卡住"比"停不下一个并说出来"更糟。
   */
  async _stopOnePlugin(name) {
    let failure = null;
    // 快路：绝大多数的名字此刻根本不在 running/started 上（已失败、已卸载、仍在装配）。
    // 那类对象不需要独占区 —— 它们要么由 `lc.load` 的失败清理收掉，要么已经被移出表。
    // 不为它们排一次有界等待，关机才不会因为几个"名字还在表里"而白等几秒。
    const peek = this.plugins.get(name);
    if (!(peek?.state === 'running' || peek?.state === 'started')) return null;
    try {
      await this.lifecycle.runExclusive(name, async () => {
        const plugin = this.plugins.get(name);
        if (!(plugin?.state === 'running' || plugin?.state === 'started') || !plugin.stop) return;
        try {
          await plugin.stop();
          // 停止也是状态跃迁，唯一写入者是 Lifecycle（见 lifecycle-manager.advance）。
          this.lifecycle.advance(plugin, 'stopped');
        } catch (err) {
          // 停止失败必须**可观测**：只写日志既不抛、不进事件、也不影响退出码，
          // 调用方无法区分"全部干净停止"与"有插件停止失败"。
          // 记入 stopFailures 并向 core.stopped 载荷暴露；失败插件 state 保持非 'stopped'。
          // 载荷里的 message 是**插件自报文本**，必须与日志同样脱敏，否则事件订阅方仍能拿到明文。
          failure = this._stopFailure(name, err);
          this.log('error', `Plugin "${name}" failed to stop: ${failure.message}`);
        }
      // **两个阶段分别有界**（专家 H8）：只约束"等锁"时，一个永不返回的 `stop()`
      // 会让 `Core.stop()` 永不返回 —— 那时兜底的只剩进程被 SIGKILL，插件一条收尾都跑不完。
      }, { timeoutMs: this._stopLockMs, holdMs: this._stopLockMs });
    } catch (err) {
      failure = this._stopFailure(name, err);
      this.log('error', `Plugin "${name}" could not be stopped: ${failure.message}`);
    }
    return failure;
  }

  /**
   * 停机失败的**分阶段**回执（专家 H8）。超时只证明"调用方的等待有界"，既不证明
   * 底层 `stop()` 停了，也不证明资源已释放 —— 三个阶段必须各报各的，否则
   * "有界返回"会被读成"已经停干净"：
   *   lock_wait   没拿到独占区，`stop()` 一次都没被调 ⇒ 副作用**确定未发生**；
   *   stop_call   `stop()` 抛出了 ⇒ 调用了，但清理做到哪一步 `UNKNOWN`；
   *   stop_return `stop()` 到点没返回 ⇒ 仍在跑，副作用 `UNKNOWN`（尤其不得报 stopped）。
   */
  _stopFailure(name, err) {
    const message = this._redactSecrets(err?.message || String(err));
    const code = err?.code;
    const phase = code === 'lock_timeout' ? 'lock_wait' : (code === 'hold_timeout' ? 'stop_return' : 'stop_call');
    return { plugin: name, message, phase, execution_outcome: phase === 'lock_wait' ? 'none' : 'unknown' };
  }

  /** 本 Core 当前的装配世代：装配入口用它绑定"我是哪一代"。 */
  get assemblyEpoch() { return this._epoch; }

  /**
   * 登记一笔装配，绑定**当前世代**。
   *
   * 用登记而不是让调用方自己传世代：装配入口不止一条（`Core.start` 的 eager、
   * `PluginManager` 的懒加载、`loadOne`、场景切换），漏一条就等于没做。
   * 登记与判据都收在 Core 这一处，调用方只负责"开始时报到、结束时销号"。
   */
  beginAssembly(name, instance = null) {
    const rec = { name, epoch: this._epoch, startedAt: Date.now(), instance };
    this._assemblies.add(rec);
    return rec;
  }

  endAssembly(rec) {
    if (rec) this._assemblies.delete(rec);
  }

  /** 这笔装配**现在**还有没有提交权：世代一致、没在停止、没停过。 */
  isAssemblyCurrent(epoch) {
    if (epoch == null) return true;
    return epoch === this._epoch && !this._stopping && !this._stopped;
  }

  /** 等一个**有界**的装配收尾窗口；返回窗口结束时仍在跑的装配（= outstanding_assembly）。 */
  async _drainAssemblies() {
    const t0 = Date.now();
    const limit = this._stopAssemblyDrainMs;
    while (this._assemblies.size && Date.now() - t0 < limit) {
      await new Promise((r) => setTimeout(r, 5));
    }
    return [...this._assemblies].map((a) => ({
      name: a.name, epoch: a.epoch, startedAt: a.startedAt, waitedMs: Date.now() - t0,
    }));
  }

  /**
   * 撤销一笔装配已经发布出去的东西：按装配上下文自己记下的 id / serviceName 精确删除。
   * 不能靠"按 owner 名删"——插件可以自报一个与插件名不同的 owner，那时会漏删。
   * 这不是回滚：插件 init 对外部世界做过的事不会被撤销，只把**已发布的登记**收回去。
   */
  discardAssemblyArtifacts(store) {
    if (!store) return { capabilities: [], services: [] };
    // 账上记的是**句柄**，不是 id：同 ID 的下一笔登记已经顶掉这一笔时，旧账只能判 stale，
    // 删不到后来那笔（专家 ID-09 的 ABA）。判据就是 `releaseRegistration` 里那句身份比较。
    const capabilities = [];
    for (const handle of [...(store.capabilities || [])]) {
      const rec = this._capHandles.get(handle);
      if (rec && this.releaseRegistration(handle)) capabilities.push(rec.id);
    }
    // 服务侧同理，而且必须用**同一条判据**：账上记的是 `{name, registrationId, instance}` 收据，
    // 不是名字。按名字删会让"旧装配失败"把后来那笔合法宿主接管一起抹掉 —— 名字后到者可以
    // 共用，登记 ID 不能。没有 ID 可核的旧账一律不动：宁可不收，也不许擦掉别人的登记。
    const services = [];
    const receipts = store.serviceNames instanceof Map ? [...store.serviceNames.values()] : [];
    for (const receipt of receipts) {
      if (this._discardServiceReceipt(receipt).ok === true) services.push(receipt.name);
    }
    return { capabilities, services };
  }

  /** 登记闸门：停止中/已停的 Core 不得再发布任何登记，与这笔装配有没有世代无关。 */
  _assertRegistrationOpen(kind, name) {
    if (!this._stopping && !this._stopped) return;
    throw Object.assign(new Error(`core_stopped: ${kind} "${name}" 不得在 Core ${this._stopping ? 'stopping' : 'stopped'} 之后登记`), { code: 'core_stopped' });
  }

  /** 派发闸门。停止中/已停止的 Core 不得再派发 —— `callCapability` 与 `command` 共用。 */
  _refuseIfNotAccepting(opts, entry) {
    if (!this._stopping && !this._stopped) return null;
    return this._failureResult(opts, {
      state: 'denied', code: 'core_not_running',
      error: `Core is ${this._stopping ? 'stopping' : 'stopped'}; ${entry} refused (no dispatch, no side effect)`,
      execution_stage: 'pre_dispatch', dispatched: false, side_effect: 'none',
    });
  }

  /**
   * 停机途中：还有哪些**确实没停好**的依赖方在等这个提供方。
   *
   * 判据是 `state`（running/started），不是"这次调用有没有报错"：超时之后状态不会被改成
   * stopped，所以状态是唯一可信的事实源 ——「stop() 到点没返回」≠「它停了」。
   *
   * 环的豁免只限**同一个强连通分量**（环内互为依赖，谁都等对方先停会挂住停机）。这是
   * **有损例外**，不是"满足 F06"：环仍必须被具名报出。判据不能放宽成"出现在任意环里"——
   * 那样两个互不相干的环之间那条真实依赖边会被一起豁免，账面有序而事实已拆。
   * SCC 由 `computeStopOrder` 在同一张解析后的依赖图上算，不让第二个消费者各写一套解释。
   */
  _pendingDependentsOf(name) {
    const comp = this._lastStopOrderComponents || new Map();
    const out = [];
    for (const { plugin } of dependentsOf(name, [...this.plugins.values()], this._serviceOwners)) {
      if (plugin === name) continue;
      // 只有同一 SCC 内的边豁免；跨分量的依赖仍是**活依赖**，提供方一次都不许先走。
      if (comp.get(name) != null && comp.get(name) === comp.get(plugin)) continue;
      const st = this.plugins.get(plugin)?.state;
      if (st === 'running' || st === 'started') out.push(plugin);
    }
    return out;
  }

  /**
   * 停止顺序 = 依赖图的**逆**拓扑序（先 dependent，后 provider）。依赖的解释与启动排序
   * 共用 `computeStopOrder`：`requires` 的键可能是**服务名**，只认插件名会把
   * `requires:{'db-service':…}` 当成"没有依赖"，让"看起来有顺序"的停机退回插入序。
   *
   * 缺席的提供者与环都不阻止停机（否则关机会挂住），但必须**交出来**，进 `core.stopped`。
   */
  _stopOrder() {
    // 运行时服务归属优先于 `provides` 声明：声明是承诺，归属是事实。
    const r = computeStopOrder([...this.plugins.values()], this._serviceOwners);
    this._lastStopOrder = r.order;
    this._lastStopOrderBasis = r.basis;
    this._lastStopOrderUnresolved = r.unresolved;
    this._lastStopOrderCycles = r.cycles;
    // SCC 编号与 `cycles` 同源同图：豁免判据只认它，不再从环路径字符串里重新拼节点集合。
    this._lastStopOrderComponents = r.components;
    return r.order;
  }

  // 重复注册默认具名拒绝：直接 set() 覆盖无检查时，chat.handle 被 4 处注册而表 size 恒 1。
  // 允许替换：同一 owner + override:true，或原 owner 已 releaseCapability。
  registerCapability(id, config = {}) {
    if (!config || typeof config.handler !== 'function') {
      throw new Error(`registerCapability: config must have { handler }`);
    }
    // **可能产生能力注册的边界**必须 fail-closed：init 内部先注册、再 await，停止正好发生
    // 在这个 await 里，能力就已经漏进去了 —— 闸门放在注册这一行本身。
    const asm = _svcTracking.getStore();
    if (asm?.epoch != null && !this.isAssemblyCurrent(asm.epoch)) {
      const err = new Error(`assembly_superseded: capability "${id}" 的注册来自世代 ${asm.epoch} 的装配，`
        + `当前世代 ${this._epoch}（${this._stopping ? 'stopping' : this._stopped ? 'stopped' : 'running'}）不得发布新能力`);
      err.code = 'assembly_superseded';
      throw err;
    }
    // 停机闸门与世代闸门是**两个事实**：世代回答"这笔装配还有没有提交权"，停机回答
    // "这台 Core 还收不收登记"。`runServiceTracking` 的 store 是 `epoch:null`，不能因此放行。
    this._assertRegistrationOpen('capability', id);
    // permissions 必须被保存：解构白名单会把它静默丢掉（"声明不执行"实为"从未保存"）。
    const { description, handler, owner, tags, input_schema, output_schema, perf, override, permissions } = config;
    // **先取快照，再在快照上校验**（rc.32 / RC31-C1）：反过来的话，两次读取之间声明可以给出
    // 不同读数 —— 实测 getter 前两次返回合规 schema、第三次返回带 `pattern` 的 schema，于是
    // 「支持面校验」看到的与「权威快照」存下的不是同一份声明。
    const lockedInput = this._lockDecl(input_schema, 'input_schema');
    const lockedOutput = this._lockDecl(output_schema, 'output_schema');
    const lockedPerms = this._lockDecl(permissions, 'permissions');
    // R0-28：注册时具名拒绝不支持的 schema 关键字。判据读的是**已经冻结的那份副本**——
    // 校验与提交因此是同一个对象，不存在“审 A、存 B”。
    this._assertSchemaSupported(id, lockedInput, 'input_schema');
    this._assertSchemaSupported(id, lockedOutput, 'output_schema');
    // 记账身份由**装配上下文**给出（插件名来自装载器）；`owner` 只是声明。两者冲突时以上下文
    // 为准并记一条日志 —— 自填的 owner 不能决定生命周期按哪个名字找它。
    //
    // `provider` **只**来自受信装配上下文：公开 `runServiceTracking(owner, fn)` 传的 store 是
    // `epoch:null` ⇒ trusted=false ⇒ provider=null。否则任何插件都能用
    // `core.runServiceTracking('A', fn)` 铸造一个“来自 A”的上下文，把 A 的能力顶掉。
    const trusted = asm?.trusted === true;
    const provider = trusted ? asm.owner : null;
    if (asm?.owner && owner != null && String(owner) !== String(asm.owner)) {
      this.log('warn', `[core] capability "${id}" 声明 owner=${owner}，装配上下文为 "${asm.owner}"；按装配身份记账`);
    }
    const existing = this._capabilities.get(id);
    if (existing) {
      // 覆盖是**对某一笔登记**的处置，所以它要的是那笔登记的管理凭据（`overrideBy`），
      // 不是"名字看起来一样"。`owner` / `provider` 都在 `listCapabilities()` 里公开可列举 ——
      // 拿可列举的字符串当口令，等价于没有口令（专家 S6 裁决 §2.2.1）。
      const replacing = this._capHandles.get(config.overrideBy);
      if (replacing !== existing) {
        const reason = `能力 "${id}" 已由 ${existing.owner ?? 'unknown'} 登记；覆盖须持该笔登记的凭据`
          + `（registerCapability 的返回值，作为 overrideBy 传入），不接受 owner/provider 字符串`
          + `（声明 owner=${owner ?? 'unknown'}、受信来源=${provider ?? 'none'}、override=${Boolean(override)}）`;
        this.log('warn', `Capability provider conflict: ${colorize('magenta', id)} — ${reason}`);
        this.emit('core:capability.conflict', { capability: id, existingOwner: existing.owner ?? null, attemptedOwner: owner ?? null, reason, timestamp: new Date().toISOString(), sourcePlugin: 'core' });
        // `code` 必须真的挂在错误对象上，不能只写在 message 前缀里：
        // `core:service.conflict` 那条路径（registerService）是挂的，这条却不是 ——
        // 于是按 `err.code` 分支的调用方（以及形式化重放）拿到的永远是 undefined。
        // 所有既有用例都只断言 message，所以这个不对称一直没被发现。
        const conflict = new Error(`capability_conflict: ${reason}`);
        conflict.code = 'capability_conflict';
        throw conflict;
      }
      this.log('info', `Capability replaced by registration handle: ${colorize('magenta', id)} (${owner ?? existing.owner})`);
    }
    // override 不得静默丢**任何**合同字段：只继承 `permissions` 时，不写 input_schema 的
    // override 会让 `required` 约束整体消失。未声明 ⇒ 继承旧值；显式声明 ⇒ 覆盖。
    const inherit = (v, k) => (v !== undefined ? v : existing?.[k]);
    // 三个声明都在**上面**取好了权威快照（`lockedInput` / `lockedOutput` / `lockedPerms`），
    // 这里只决定“用新的还是继承旧的”。派生属性不许再写快照逻辑 —— 那等于给同一个字段
    // 第二个冻结口，两面迟早不同步。
    const inherited = (v, which, locked) => (v !== undefined ? locked
      : (existing ? this._lockDecl(existing[which], which) : locked));
    const record = {
      // 记录里同时存 id：句柄反查到记录之后还要回答"删的是哪个能力"。
      // 不存的话 `compare-and-delete` 拿不到键，旧句柄会变成永远不匹配的 false。
      id,
      description: inherit(description, 'description'),
      handler, owner: inherit(owner, 'owner'), provider,
      tags: inherit(tags, 'tags'),
      // `input_schema` 与 `permissions` / `output_schema` **同一个口径**：三者都是登记之后
      // 会被实际使用于派发的判据，三者都必须是登记期的独立深冻结快照。
      //
      // 三者缺一不可：只锁其中两个时，真正在派发前**做准入**的那个仍留在调用方手里，
      // 于是登记后一句 `schema.properties.n.type = 'string'` 就能在同一登记号下把原本被拒的
      // 非法入参变成 succeeded（handler 真执行），同时让原本合法的 `{n:1}` 变成 invalid_input。
      // 既可放松准入，也可无声改变合法调用的含义。
      input_schema: inherited(input_schema, 'input_schema', lockedInput),
      output_schema: inherited(output_schema, 'output_schema', lockedOutput),
      perf: inherit(perf, 'perf'),
      // **授权判据存权威快照**：存调用方原对象时，登记后一句
      // `config.permissions.require_identity = false` 就改掉了将来的每一次派发 ——
      // 登记对象在登记完成之后仍然是调用方可写的。
      permissions: inherited(permissions, 'permissions', lockedPerms),
      // 单次登记身份：撤销判据是 `compare-and-delete(registrationId)`，不是名字。
      registrationId: ++this._capSeq,
      // 登记实例（受信装配给的那个对象引用）：生命周期按它精确清场，不按名字猜。
      // 不跟 `trusted` 绑定：公开的 `runServiceTracking` 根本不传 instance（租户不可自造），
      // 而只有 LifecycleManager 会传 —— 拿它当清场键不会把那道闸门再开一遍。
      registrar: asm?.instance ?? null,
    };
    // 先入表、再铸句柄：句柄反查到的记录必须与表里**同一对象**，"覆盖后旧句柄作废"就靠这个。
    this._capabilities.set(id, record);
    const handle = Object.freeze(Object.create(null));
    this._capHandles.set(handle, record);
    // 记进**本次装配的账**：账上记句柄，迟到清理按身份 compare-and-delete（防 ABA，ID-09）。
    if (asm) asm.capabilities?.add(handle);
    this.log('info', `Capability registered: ${colorize('magenta', id)}`);
    return handle;
  }

  /**
   * schema 支持面校验：**整棵树**在注册期按白名单判，不校验的关键字一律具名拒绝。
   *
   * 修前的形状只枚举 `schema.properties` 的**第一层**，于是根上的 `$ref`、以及
   * `properties.x.properties.admin.$ref` 这种深层写法**照样被接收并执行成功** —— 而合同
   * 写明 `$ref` 是注册期必须拒绝的（rc.33 / R32-05）。只扫第一层等于“只看我能看到的那一层”。
   *
   * 白名单（与 `_schemaViolation` 的执行面一一对应）：
   *   · 根：`type` / `required` / `properties` / `additionalProperties` + 注释 `title`/`description`/`default`；
   *   · 属性子表：**只有** `type` + 同样的注释（本内核不递归校验对象子结构，嵌套 `properties`/`items` 拒）；
   *   · `additionalProperties` 允许出现但**不执行约束**；`default` 只是文档，**从不填充**（合同里明写）。
   * 校验对象是**登记期冻结的纯数据快照**，不存在“第二遍读用户对象”的问题（见 `_declSnapshot`）。
   */
  _assertSchemaSupported(id, schema, which) {
    if (schema == null) return;
    // 拒绝本身必须具名：`$ref`/`pattern` 这类关键字是安全关键的，静默当没有就等于声明了却不管。
    const fail = (path, kw, hint) => {
      const known = UNSUPPORTED_SCHEMA_KEYWORDS.includes(kw) ? '已知但本内核不校验的关键字' : '不在支持面内';
      throw new Error(`schema_unsupported：能力 "${id}" 的 ${which} 在 ${path} 使用了${known} '${kw}'${hint ? `（${hint}）` : ''}：`
        + '受支持的形状只有 根{type,required,properties,additionalProperties} 与 属性{type}，'
        + '外加不携带断言的 title/description/default（支持表见 contracts/capability-identity-v1.md）');
    };
    const invalid = (path, why) => {
      throw new Error(`schema_invalid：能力 "${id}" 的 ${which} 在 ${path} ${why}`);
    };
    // 注释关键字只接受字符串：让它同时是“注释”和“对象”会让读者以为那里还能放断言。
    const checkAnnotations = (node, at) => {
      for (const kw of SCHEMA_ANNOTATION_KEYWORDS) {
        if (node[kw] !== undefined && typeof node[kw] !== 'string') invalid(`${at}.${kw}`.replace('$.', '$.'), '注释关键字只接受字符串');
      }
    };
    if (typeof schema !== 'object' || Array.isArray(schema)) invalid('$', '必须是对象');
    for (const kw of Object.keys(schema)) if (!ROOT_SCHEMA_KEYWORDS.includes(kw)) fail('$', kw);
    checkAnnotations(schema, '$');
    if (schema.type !== undefined) {
      if (!JSON_SCHEMA_TYPES.includes(schema.type)) invalid('$.type', `必须是 ${JSON_SCHEMA_TYPES.join('/')} 之一，实际 ${JSON.stringify(schema.type)}`);
      if (schema.type !== 'object' && (schema.required !== undefined || schema.properties !== undefined)) {
        invalid('$', `声明了 required/properties 但 type='${schema.type}'；本内核只校验对象形状`);
      }
    }
    if (schema.required !== undefined) {
      if (!Array.isArray(schema.required) || schema.required.some((k) => typeof k !== 'string' || !k)) {
        invalid('$.required', '必须是非空字符串数组');
      }
      if (new Set(schema.required).size !== schema.required.length) invalid('$.required', '有重复项');
    }
    if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
      invalid('$.additionalProperties', '只接受 boolean（且不参与校验）');
    }
    if (schema.properties !== undefined) {
      if (typeof schema.properties !== 'object' || schema.properties === null || Array.isArray(schema.properties)) {
        invalid('$.properties', '必须是对象');
      }
      for (const [name, spec] of Object.entries(schema.properties)) {
        const at = `$.properties.${name}`;
        if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) invalid(at, '必须是对象');
        for (const kw of Object.keys(spec)) {
          if (!PROPERTY_SCHEMA_KEYWORDS.includes(kw)) {
            fail(at, kw, kw === 'properties' || kw === 'items' ? '本内核不递归校验子结构' : undefined);
          }
        }
        checkAnnotations(spec, at);
        if (spec.type !== undefined && !JSON_SCHEMA_TYPES.includes(spec.type)) {
          invalid(`${at}.type`, `必须是 ${JSON_SCHEMA_TYPES.join('/')} 之一`);
        }
      }
    }
  }

  /**
   * 撤销**一笔**登记。凭据是 `registerCapability` 交回的对象，不是能力名。
   * 判据是 `compare-and-delete(registrationId)`：句柄反查到的那条记录必须**仍是该 id 当前**
   * 那条；被覆盖 / 已释放 / 来自别的 Core ⇒ stale（false），绝不误删后继登记（ID-07/08/15）。
   */
  releaseRegistration(handle) {
    const rec = handle && typeof handle === 'object' ? this._capHandles.get(handle) : null;
    if (!rec || this._capabilities.get(rec.id) !== rec) return false;
    this._capabilities.delete(rec.id);
    this.log('info', `Capability released: ${colorize('magenta', rec.id)}`);
    return true;
  }

  /**
   * 旧签名 `releaseCapability(id, owner)` **不再是授权形式**：owner 是可公开列举的字符串。
   * 签名保留只为给出具名拒绝（`capability_release_denied`），合法路径是
   * `releaseRegistration(handle)`，或由生命周期按登记实例身份托底清场。
   */
  releaseCapability(id, credential) {
    if (!this._capabilities.has(id)) return false;
    // **目标与凭据必须指向同一笔登记**：`releaseRegistration` 只按凭据那笔撤，
    // 它不知道调用方点的名字。只做 `has(id)` 就交出去 = "要撤 A 却删了 B"，且返回 true
    // 凭据有资格撤另一笔时这是"点错名"而非越权，故返回 false、一笔未动。
    const rec = credential && typeof credential === 'object' ? this._capHandles.get(credential) : null;
    if (rec && rec.id !== id) {
      this.log('warn', `Capability release target mismatch: 请求撤销 "${colorize('magenta', id)}"，`
        + `凭据指向 "${colorize('magenta', rec.id)}"；一笔未动`);
      return false;
    }
    if (this.releaseRegistration(credential)) return true;
    const err = new Error(`capability_release_denied: 能力 "${id}" 的撤销须持该次登记的凭据`
      + '（registerCapability 的返回值 → releaseRegistration）；owner/provider 字符串不构成授权');
    err.code = 'capability_release_denied';
    throw err;
  }

  getInflight(owner) {
    return this._inflight.get(owner) || 0;
  }

  // 自报不可作为授权依据：`opts._trusted` 旁路已删，caller/scope 一律取登记值，
  // 越权自报具名拒绝（登记后自报 admin 直接放行并执行 handler 的路径不复存在）。
  _invocationContext(cap, id, opts, params) {
    const perms = cap.permissions;
    const rec = opts.principal != null ? this._trustedCallers.get(String(opts.principal)) : undefined;
    // 拒绝必须**分型**：权限/策略拒绝 = capability_denied(denied)；
    // 参数/schema 违规 = invalid_input(failed)。同一字符串路径无法机器判定。
    const deny = (why, code = 'capability_denied') => ({ ok: false, error: `capability_denied: ${id} ${why}`, code });
    const ctx = { caller: rec?.caller ?? null, scope: rec?.scope ?? null, source: opts.source ?? 'plugin', identity_verified: Boolean(rec) };
    // schema 校验**必须先于** permissions 分支：排在 `if (!perms) return` 之后时，
    // 未声明 permissions 的能力，其 input_schema 被整体静默忽略
    // （声明 {n:{type:'integer'}} 的能力传 1.5 / '1' / null 全部放行）。
    const bad = this._schemaViolation(cap.input_schema, params);
    if (bad) return deny(bad, 'invalid_input');
    if (!perms || typeof perms !== 'object') return { ok: true, ctx };
    // 顺序要紧：先判"身份是否经证实"，再判"是否给了 caller"。反过来的话，一个声称了未登记 principal
    // 的调用会得到"未提供 caller"这一误导性结论（掩盖了"身份未经证实"这个真正的拒绝理由）。
    if ((perms.require_identity === true || perms.scope) && !ctx.identity_verified) return deny(`身份未经证实（caller='${opts.caller ?? ''}' scope='${opts.scope ?? ''}' 由调用方自报，principal=${opts.principal ?? '未提供'}）——受保护能力要求经受信通道断言的身份`);
    if (perms.require_identity === true && !ctx.caller) return deny('要求调用身份（permissions.require_identity），但未提供 caller');
    if (rec && opts.scope != null && (Object.hasOwn(SCOPE_RANK, opts.scope) ? SCOPE_RANK[opts.scope] : Infinity) > (Object.hasOwn(SCOPE_RANK, rec.scope) ? SCOPE_RANK[rec.scope] : 0)) return deny(`调用方自报 scope '${opts.scope}' 超出受信主体 '${opts.principal}' 的登记授权 '${rec.scope ?? '无'}'——授权等级以登记值为准`);
    if (perms.scope && (Object.hasOwn(SCOPE_RANK, ctx.scope) ? SCOPE_RANK[ctx.scope] : 0) < (Object.hasOwn(SCOPE_RANK, perms.scope) ? SCOPE_RANK[perms.scope] : 99)) return deny(`要求 scope '${perms.scope}'，调用方 ${ctx.scope ? `'${ctx.scope}'` : '未声明'} 权限不足`);
    return { ok: true, ctx };
  }

  /**
   * input_schema 子集校验（与 permissions 无关，声明了就必须生效）。返回违规说明或 null。
   *
   * 判据是**声明**：声明了根 `type` 就判根类型，声明了 `required` 就判必填，声明了
   * `properties.x.type` 就判该属性类型；没声明的一律不判 —— 不校验不等于全拒。
   *
   * 两处都必须读 **own** 属性：`params[k]` 走原型链，`required:['__proto__']` 在 `params={}`
   * 上会被读成「给了，而且正好是 object」（`{}` 的 `__proto__` 就是继承来的那个对象，
   * `constructor`/`toString` 同理）。所以用 `Object.getOwnPropertyDescriptor` 读**一次**：
   * 它同时回答「有没有」与「值是什么」，访问器在这一步具名拒绝 —— 否则准入结论由输入
   * 自己决定，同一份入参每次读可以不同。根 `type` 同理：支持的必须真判，`{type:'object'}`
   * 不能放行 'str'，声明的类型和执行的判定必须是同一条。
   */
  _schemaViolation(s, params) {
    if (!s) return null;
    const t = params === null ? 'null' : Array.isArray(params) ? 'array' : typeof params;
    // ① 根类型。`integer` 不是 `typeof` 的取值，必须走 Number.isInteger，否则合法整数也被拒。
    if (s.type) {
      const ok = s.type === 'integer' ? Number.isInteger(params) : t === s.type;
      if (!ok) {
        return `参数根类型应为 ${s.type}${s.type === 'object' ? '（本能力声明了结构化输入契约）' : ''}，实际 ${t}`;
      }
    }
    // ② 声明了结构化契约（required/properties）却没声明根 type 时，根仍必须是对象。
    const structured = Array.isArray(s.required) || (s.properties && typeof s.properties === 'object');
    if (!s.type && structured && t !== 'object') {
      return `参数根类型应为 object（本能力声明了结构化输入契约），实际 ${t}`;
    }
    if (t !== 'object') return null;   // 根标量：类型已判过，没有属性可查
    // ③ 纯数据边界：要按属性判，参数就必须是纯数据对象。类实例的自定义原型、Proxy 的读取
    // 都不受登记方控制；`Object.create(null)` 是纯数据，放行。
    if (types.isProxy(params)) return '参数根不得是 Proxy（属性读取不受本内核控制）';
    const proto = Object.getPrototypeOf(params);
    if (proto !== Object.prototype && proto !== null) {
      return `参数根必须是纯数据对象（实际原型 ${proto?.constructor?.name ?? 'null'}），类实例/自定义原型不进准入判据`;
    }
    const own = (k) => Object.getOwnPropertyDescriptor(params, k);
    // ④ 必填：own 属性存在**且**有值。`{a: undefined}` 不算给了 —— JSON 里没有 undefined。
    // 「原型链上有同名属性」不算给了：`{}` 上所有人都有 `toString`/`constructor`。
    for (const k of s.required || []) {
      const d = own(k);
      if (!d) return `缺少必填参数 '${k}'`;
      if (!('value' in d)) return `必填参数 '${k}' 是访问器（只接受纯数据输入）`;
      if (d.value === undefined) return `必填参数 '${k}' 的 own 属性存在但值为 undefined（JSON 无 undefined，视同未提供）`;
    }
    // ⑤ 属性类型：只判 own 的属性。
    for (const [k, spec] of Object.entries(s.properties || {})) {
      const d = own(k);
      if (!d) continue;
      if (!('value' in d)) return `参数 '${k}' 是访问器（只接受纯数据输入）`;
      const v = d.value;
      if (v === undefined) return `参数 '${k}' 为 undefined（JSON 无此值）`;
      if (!spec?.type) continue;
      const vt = Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
      // integer 必须 Number.isInteger：接受任意 number 时 1.5 会放行。
      if (spec.type === 'integer') {
        if (!Number.isInteger(v)) return `参数 '${k}' 应为 integer，实际 ${vt}${typeof v === 'number' ? ` ${v}（非整数）` : ''}`;
        continue;
      }
      if (vt !== spec.type) return `参数 '${k}' 应为 ${spec.type}，实际 ${vt}`;
    }
    return null;
  }

  /**
   * 登记受信调用主体。**授权等级以本方法登记值为准**，调用时的自报值只用于比对。
   *
   * 令牌由宿主在 `new Core({ identityAuthority })` 时注入，**不是 core 自己签发** ——
   * 若由首个调用者领取，等于"谁先来谁就是身份权威"，只是把自报换成先到先得。
   *
   * 诚实边界：进程内 JS 没有安全隔离，能读到 `_identityAuthority` 的代码仍可自证。
   * 本方法消除的是**静默自证**，**不构成安全边界**；真正的隔离需插件出进程执行。
   */
  assertIdentity(principal, { caller = null, scope = null, issuer = null } = {}) {
    if (this._identityAuthority == null) throw new Error('identity_authority_unavailable：本实例未注入身份授权令牌（构造时传 identityAuthority），拒绝登记任何 principal');
    if (issuer !== this._identityAuthority) throw new Error(`identity_authority_denied：assertIdentity 仅供持授权令牌的宿主引导通道调用（拒绝为 '${principal}' 颁发身份）——见 contracts/capability-identity-v1.md`);
    if (typeof principal !== 'string' || principal.length === 0) throw new Error('assertIdentity：principal 必须是非空字符串');
    if (scope != null && !Object.hasOwn(SCOPE_RANK, scope)) throw new Error(`assertIdentity：未知 scope '${scope}'——仅接受 read/write/admin`);
    this._trustedCallers.set(principal, { caller, scope });
    this.log('info', `Identity asserted: ${colorize('magenta', principal)} (caller=${caller ?? '-'} scope=${scope ?? '-'})`);
    return true;
  }
  // 统一拒绝处置（callCapability 与 command 共用，防两路径行为漂移）
  _denyCapability(id, opts, reason, meta = {}) {
    // 拒绝事实走隔离面：观察者同步抛错时，它不得把 `{ok:false,state:'denied'}` 换成一句
    // 别人的报错。两类事件出口不能混 —— 派发钩子（hook-guard）出错必须阻断，那是"决定
    // 是否放行"的一环，fail-closed 是对的；而"我刚才拒绝了"是**已经成立的记录**，
    // 记录方不能反过来改写结论。无 handler 被派发，故从未越权，但事实
    // 必须以约定结构反馈给调用方。
    this.emitFact('core:capability.denied', { capability: id, caller: opts?.caller ?? null, scope: opts?.scope ?? null, reason, timestamp: new Date().toISOString(), sourcePlugin: 'core' });
    this.log('warn', `Capability denied: ${colorize('magenta', id)} — ${reason}`);
    return this._failureResult(opts, {
      state: CAPABILITY_CODE_STATE[meta.code] || 'denied',
      code: meta.code || 'capability_denied',
      error: reason,
      eventEmitted: true,
      caller: meta.caller ?? null,
      // 这里是 Core **自己在 dispatch 之前**拒绝的唯一出口之一，
      // 因此可以承诺"handler 没跑、副作用为零"——这是 Core 亲眼所见，不是从 code 推断的。
      // （另一处是同函数的兄弟 `_dispatchCapability` 的 `_frozen` 早退。）
      dispatched: false, side_effect: 'none',
    });
  }

  /**
   * **准入判定**：只回答"这次调用准不准"，不执行 handler、不产生副作用。
   *
   * 执行后端有四种（真 handler / sandbox / 结果缓存 / legacy 直连），判据只维护这一份：
   * 换一条更快的路径不等于换一套判据，别处只能**问**它，不能**抄**它。
   *
   * 诚实边界：给出的是**此刻**的判定，不是永久票据 —— 调用方在判定与下发之间 await 了
   * 别的，窗口仍在，那要靠调用点把判定挪到最后一步，而不是靠本方法延长有效期。
   *
   * @returns {{ok: true, ctx: object}|{ok: false, code: string, error: string}}
   */
  admitCapability(id, opts = {}, params = undefined) {
    const cap = this._capabilities.get(id);
    if (!cap) return { ok: false, code: 'capability_not_found', error: `Capability not found: ${id}` };
    // 冻结是**准入**的一条，不是执行的一条：沙箱与缓存都不能绕过它。
    if (cap._frozen) return { ok: false, code: 'capability_frozen', error: `capability.frozen: ${id}` };
    const inv = this._invocationContext(cap, id, opts, params);
    if (!inv.ok) return { ok: false, code: inv.code, error: inv.error };
    return { ok: true, ctx: inv.ctx };
  }

  /**
   * 一次登记**此刻**的当代性事实：登记号与只读性。缓存与沙箱用它判"还是不是同一笔东西"。
   * `registrationId` 被同名替换就变 —— 判据必须挂在登记号上，否则旧 handler 的结果会冒充
   * 新 handler 的。
   */
  capabilityRegistration(id) {
    const cap = this._capabilities.get(id);
    if (!cap) return null;
    return { id, registrationId: cap.registrationId ?? null, frozen: cap._frozen === true };
  }

  /**
   * 这笔登记的权限声明（**只读视图**）；未声明返回 null。交的是独立副本 ——
   * 返回内部对象的公开 getter 会成为改写派发判据的第二授权面。
   * 改判据必须走重登记（`registerCapability` + `overrideBy`），那是有身份与冲突检查的入口。
   */
  capabilityPermissions(id) {
    return this._copyDecl(this._capabilities.get(id)?.permissions ?? null);
  }

  // 统一**结果信封**，字段全部**加性**（旧消费者 `!result.error` 判成功仍成立）：
  //   · 不变式 ok === (state==='succeeded')；denied/failed 时 payload 必须为 null
  //   · call_id 只是**关联 ID**，不是幂等键（重试不去重）；attempt 是逻辑序号不是唯一标识
  //   · attempt_token 是本实例内**物理尝试**的唯一标识；跨实例靠 incarnationId，
  //     对外联合标识是 `attempt_key`（加性）；`attempt_id` 仍按 `call_id#attempt` 关联
  //   · caller 仅作审计回显；授权一律依据受信宿主上下文（_trustedCallers 登记值）
  //   · evidence.persisted='unknown'：发行包内是 null sink，不得据此宣称 durable
  _callIds(opts, caller) {
    const callId = opts?.traceId || `call-${(this._callSeq = (this._callSeq || 0) + 1)}-${Date.now().toString(36)}`;
    const attempt = Number.isInteger(opts?.attempt) && opts.attempt > 0 ? opts.attempt : 1;
    // 单调序号**不复用** `_callSeq`：call_id 可由调用方指定（traceId），一旦调用方
    // 给同一个 traceId，call_id 就不再唯一，拿它做 token 的一部分会再次撞号。
    const attempt_token = `at-${(this._attemptSeq = (this._attemptSeq || 0) + 1)}`;
    // 加性字段：把"实例作用域"显式写进信封，读者不必猜 token 的唯一性边界在哪。
    const attempt_key = `${this.incarnationId}/${attempt_token}`;
    return { call_id: callId, attempt, attempt_id: `${callId}#${attempt}`, attempt_token, attempt_key, caller: caller ?? null };
  }

  _successResult(opts, payload, caller = null) {
    return {
      ok: true, state: 'succeeded', code: null, error: null, payload,
      ...this._callIds(opts, caller),
      evidence: { trace_id: opts?.traceId || null, event_emitted: false, persisted: 'unknown' },
    };
  }

  _failureResult(opts, { state, code, error, eventEmitted = false, caller = null, ...extra }) {
    const ids = this._callIds(opts, caller);
    return {
      ok: false, state, code, error, payload: null,
      ...ids,
      // 两个**加性**归一字段，`code`/`state` 一个字不改。
      // 放在 `...extra` 之前，显式传入的值（若有）优先 —— 调用方比本函数更清楚分类。
      category: categorizeCode(code),
      result_kind: resultKindOf(state, code, extra),
      // `extra` 只承载**加性**事实（execution_outcome / still_running_at_return）。
      // 旧三态 state/code 的语义一个字不改 —— code↔state 表因此不需要动。
      ...extra,
      evidence: { trace_id: ids.call_id, event_emitted: eventEmitted, persisted: 'unknown' },
    };
  }

  /**
   * handler 抛出后的失败信封。**不得由 code 推断"没执行过"**：handler 先写文件再抛
   * `err.code='capability_denied'`，报 `state:'denied'` 就把"执行完再被下游拒绝"讲成"从未开始"。
   *
   * 阶段由**调用方**传 `dispatched`（它比任何 code 都清楚）：
   *   · `false` —— 可以按 code 归类（此时 code 是唯一线索）；
   *   · `true`  —— handler 已经跑过：拒绝型 code 只描述下游原因，状态必须是执行后失败。
   */
  _failureFromThrown(opts, err, caller = null, id = null, dispatched = true) {
    const code = typeof err?.code === 'string' && err.code ? err.code : 'handler_threw';
    // 兼容：事件式错误响应的载荷是普通对象（{ok:false,error:'…'}），没有 message 字段
    const message = err?.message
      ?? (typeof err?.error === 'string' ? err.error : null)
      ?? String(err);
    const declared = CAPABILITY_CODE_STATE[code] || 'failed';
    // 判据不是"这个码通常意味着什么"，而是"Core 能不能证明它发生在副作用之前" —— 对
    // handler 抛出的字符串答案是**不能**（`err.code` 是插件任意赋的值）。
    const downgraded = dispatched === true && declared === 'denied';
    const state = downgraded ? 'failed' : declared;
    // **工具级拒绝也必须发拒绝事件**，否则"拒绝"在事件面不可见；但事件可发 ≠ 已持久化，
    // evidence.persisted 仍只能是 'unknown'。
    if (state === 'denied' && id) {
      // 与 `_denyCapability` 同一出口纪律：观察者抛错不得替换这里的拒绝结论。
      this.emitFact('core:capability.denied', {
        capability: id, caller: opts?.caller ?? null, scope: opts?.scope ?? null,
        reason: message, code, timestamp: new Date().toISOString(), sourcePlugin: 'core',
      });
      this.log('warn', `Capability denied: ${colorize('magenta', id)} — ${message} (code=${code})`);
    }
    return this._failureResult(opts, {
      state, code, error: message, caller, eventEmitted: state === 'denied',
      // 加性字段：把"handler 是否真的跑过、副作用能不能被排除"写进信封，
      // 调用方不必再从 code 猜：验收就落在 side_effect 上。
      // **只要是从 handler 冒出来的就必须写**，不能只在"拒绝码被降级"时写 ——
      // 那样 `handler_threw`（最常见的形状）反而一条执行阶段证据都没有，正是 M6 的缺口。
      ...(dispatched === true
        ? { dispatched: true, execution_stage: 'post_dispatch', side_effect: 'unknown_or_possible' }
        : { dispatched: false, side_effect: 'none' }),
    });
  }

  // 懒加载钩子的**唯一取用口**：数据面 `_lazyHook` 是权威（gateway/chat-ui 也读它），
  // 实例字段只作兼容别名 —— 分两处读会静默漏装懒插件（调用方只看到 capability_not_found）。
  _lazyResolver() {
    const hook = this.getData('_lazyHook') || this._lazyHook;
    return typeof hook === 'function' ? hook : null;
  }

  // 能力**是否可得** —— 已注册，或能经懒加载解析出来（与 `command()` 的解析路径一致，
  // 否则会把"懒加载能补上"的场景误判为缺能力）。网关据此在无 provider 时快速拒绝，
  // 而不是发一条事件等满超时。
  async hasCapability(id) {
    // 停止中/已停的 Core 上"可得"没有意义；也不得借这条路径触发懒加载（那是副作用）。
    if (this._stopping || this._stopped) return false;
    if (this._capabilities.has(id)) return true;
    // 装载失败也是"不可得"：`_resolveLazily` 不再抛（失败被收进返回值），这里只看结果。
    await this._resolveLazily(id);
    return this._capabilities.has(id);
  }

  // 枚举接口：`hasCapability` 只回答单个能力的布尔值，没有它调用方只能去读 `_capabilities`。
  // 实测三处（cell-runtime 权限交集、tool-executor 两条旁路封堵）正是这么做的 —— 私有字段
  // 一改结构，三处同时静默失效。这里给一个只读枚举面：返回 `{ id, owner }` 的快照副本，
  // **不做懒加载解析**（枚举是同步快照；要"能否解析出来"用 hasCapability）。
  listCapabilities({ prefix = null } = {}) {
    const out = [];
    for (const [id, cap] of this._capabilities) {
      if (prefix != null && !id.startsWith(prefix)) continue;
      out.push({ id, owner: cap?.owner ?? null, provider: cap?.provider ?? null });
    }
    return out;
  }

  async callCapability(id, params, opts = {}) {
    // 停止中/已停止一律拒绝。这是**派发前**的拒绝，可以承诺零副作用。
    const refused = this._refuseIfNotAccepting(opts, 'callCapability');
    if (refused) return refused;
    // 快路径必须**同步**取到 cap：in-flight 的登记要与 handler 启动紧邻，
    // 中间不能插一个不必要的 await（否则调用方在 `callCapability(...)` 之后同步读
    // `getInflight()` 会读到 0 —— 这是既有测试锁定的可观测性质，也是 I-03 的判据）。
    let cap = this._capabilities.get(id);
    if (!cap) {
      const r = await this._resolveLazily(id);
      cap = r.cap;
      // 装载**尝试过并失败** ⇒ 用具名信封回答。
      // 直接把 loader 的 rejection 抛出去时，"第一次懒加载失败"是唯一一种
      // 形状不同的失败（Promise reject 而不是 ok/state/code 信封），调用方只能各自 catch。
      if (!cap && r.error) return this._failureResult(opts, this._lazyFailureFacts(r.error));
    }
    // 懒加载尝试后仍找不到 ⇒ **返回具名失败信封，不再抛**。
    // 派发前的失败也要写明"没派发、零副作用" —— `dispatched`/`side_effect`
    // 是**执行事实**，`result_kind` 是**调用结论**，两者不互相推导。
    if (!cap) return this._failureResult(opts, {
      state: 'failed', code: 'capability_not_found', error: `Capability not found: ${id}`,
      execution_stage: 'pre_dispatch', dispatched: false, side_effect: 'none',
    });
    return this._dispatchCapability(cap, id, params, opts, null);
  }

  /**
   * **唯一的执行结算点**（`callCapability` 与 `command` 共用）：in-flight 在 handler 启动
   * 紧邻处登记、只在真正 settle 时释放；`waiterMs` 只结束**等候方**的等待 —— "等候结束"
   * 不等于"执行结束"，而重载/drain 闸门读的正是这个计数。超时用加性字段
   * `execution_outcome` / `still_running_at_return` 表达"仍可能继续"。
   *
   * @param {number|null} waiterMs 等候上限；null = 一直等到 handler settle
   */
  async _dispatchCapability(cap, id, params, opts, waiterMs) {
    // 与 `_denyCapability` 同为 Core **dispatch 之前**的拒绝 ⇒ 可承诺零副作用。
    if (cap._frozen) return this._failureResult(opts, {
      state: 'denied', code: 'capability_frozen', error: `capability.frozen: ${id}`,
      dispatched: false, side_effect: 'none',
    });

    // 授权边界强制校验：在 handler 之前，副作用不落地。
    const inv = this._invocationContext(cap, id, opts, params);
    if (!inv.ok) return this._denyCapability(id, opts, inv.error, { code: inv.code });

    // 记账/归属一律用**装配身份**：`owner` 是注册方自填的声明，拿它当键时一个自称他人
    // owner 的能力会让 drain / reload-busy / idle 三处判据同时找不到它。
    const provider = cap.provider ?? cap.owner ?? null;
    const pm = this._services.get('plugin-manager');
    if (pm && provider) {
      pm._touchAccess(provider);
      // 微内核不得点名下游/商业插件。此处原为对某个**厂商专用记忆插件**的
      // 两个专用调用（reportAccess / reportCapabilityHeat）；改为发一个**通用观测事件**，
      // 谁需要谁订阅（该插件在自己的 init 里订阅）。功能等价、内核零厂商名。
      // 无订阅者时只付一次 listenerCount 查找，比原先两次 getService 更省（热路径）。
      if (this.listenerCount('core:capability.invoked') > 0) {
        // 观测**不得**击穿主路径：任一订阅者抛错都必须被吞掉并告警，绝不冒泡回 capability 调用。
        try {
          this.emit('core:capability.invoked', {
            plugin: provider, capability: id, traceId: opts.traceId ?? null, sourcePlugin: 'core',
          });
        } catch (e) {
          this.log('warn', `[core] observer of "core:capability.invoked" threw: ${e?.message || e}`);
        }
      }
    }

    // 先登记 in-flight，再启动 handler —— 两者之间**没有** await（I-03 的判据就落在这一点上）。
    const owner = provider || 'unknown';
    const settle = { done: false };
    this._inflight.set(owner, (this._inflight.get(owner) || 0) + 1);
    // 把"settle 才算结束"写在一个地方：成功、失败、超时三条路径共用。
    const attempt = (async () => cap.handler(params))()
      .then((payload) => ({ ok: true, payload }), (err) => ({ ok: false, err }))
      .finally(() => {
        settle.done = true;
        const count = this._inflight.get(owner) - 1;
        if (count <= 0) this._inflight.delete(owner);
        else this._inflight.set(owner, count);
      });

    let timer = null;
    if (!(waiterMs > 0)) {
      const out = await attempt;
      return out.ok
        ? this._successResult(opts, out.payload, inv.ctx?.caller ?? null)
        : this._failureFromThrown(opts, out.err, inv.ctx?.caller ?? null, id);
    }

    const timeout = Symbol('waiter-timeout');
    const waited = await Promise.race([
      attempt,
      new Promise((resolve) => { timer = setTimeout(() => resolve(timeout), waiterMs); }),
    ]);
    if (timer) clearTimeout(timer);
    if (waited !== timeout) {
      return waited.ok
        ? this._successResult(opts, waited.payload, inv.ctx?.caller ?? null)
        : this._failureFromThrown(opts, waited.err, inv.ctx?.caller ?? null, id);
    }
    // 等候超时：Attempt 仍在跑，in-flight **保持不减**（由 attempt 自己的 finally 负责）。
    // 超时是"副作用未撤销"，故归 failed/timeout_no_abort，绝不归 cancelled。
    return this._failureResult(opts, {
      state: 'failed', code: 'timeout_no_abort', error: `Command timeout: ${id}`,
      caller: inv.ctx?.caller ?? null,
      // 加性字段：把"还在跑"这个事实写进信封，调用方不必去猜。
      execution_outcome: 'unknown',
      still_running_at_return: !settle.done,
    });
  }

  /**
   * 懒加载解析。返回 `{ cap, error }`：
   *   · `cap` 非空 ⇒ 解析到了；
   *   · `cap` 为空、`error` 非空 ⇒ **装载尝试过并失败**（调用方要用它出信封，
   *     不能退化成 `capability_not_found` —— 那会把"插件坏了"报成"没这个能力"）；
   *   · 两者皆空 ⇒ 没有懒加载可解析。
   */
  async _resolveLazily(id) {
    const hook = this._lazyResolver();
    if (!hook) return { cap: this._capabilities.get(id) || null, error: null };
    try { await hook(id); } catch (err) { return { cap: this._capabilities.get(id) || null, error: err }; }
    return { cap: this._capabilities.get(id) || null, error: null };
  }

  /**
   * 装载失败/超时的统一失败信封。
   *
   * 两个事实**分开**写，不许互相推导：
   *   `dispatched: false`            能力 handler 一次都没跑；
   *   `side_effect: 'unknown_or_possible'` 但插件 `init()` 可能已经跑了一半。
   * "没派发"不等于"没副作用" —— 这正是单靠 `state` 说不出来的东西。
   */
  _lazyFailureFacts(err) {
    const code = typeof err?.code === 'string' && err.code ? err.code : 'lazy_load_failed';
    return {
      state: 'failed', code, error: err?.message || String(err),
      execution_stage: 'assembly', dispatched: false, side_effect: 'unknown_or_possible',
    };
  }

  // `output_schema` 的只读出口：只在注册时校验形状并存储、执行期无人看时，偏差无法被观测。
  // 于是"声明 type:string 而返回对象"这类偏差不可观测。执行器用它做**告警**（不阻断）。
  // 与 `permissions` 同一个口径：交副本，不交权威引用（存入时已深冻结）。
  getCapabilityOutputSchema(id) { return this._copyDecl(this._capabilities.get(id)?.output_schema ?? null); }

  freezeCapability(id) {
    const cap = this._capabilities.get(id);
    if (cap) cap._frozen = true;
    // `_frozen` 只被 callCapability/command 读 —— 绕过它们的执行器缓存看不见，故广播。
    if (cap) this.emit('core:capability.frozen', { capability: id, sourcePlugin: 'core' });
  }

  async command(method, params, timeout = 30000, opts = {}) {
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) timeout = 30000;
    // 与 `callCapability` 同一个闸门 —— 两条入口拒绝的条件必须一致，
    // 否则"停止后还能通过事件式命令派发"就是一条更隐蔽的同类缺陷。
    const refused = this._refuseIfNotAccepting(opts, 'command');
    if (refused) return refused;
    let cap = this._capabilities.get(method);
    if (!cap) {
      const r = await this._resolveLazily(method);
      cap = r.cap;
      // 与 `callCapability` 同一个出口合同 —— 装载失败不得变成事件式命令的 30s 空等。
      if (!cap && r.error) return this._failureResult(opts, this._lazyFailureFacts(r.error));
    }
    // freeze 必须在这里也生效：`command()` 是所有 chat 入口走的那条路，冻不住就等于
    // 热重载期间旧代码还在跑。判据与 callCapability 同源 —— 两条入口现在共用
    // `_dispatchCapability`，不存在语义漂移的可能（见 core-transition-contracts.md §1）。
    if (cap) return this._dispatchCapability(cap, method, params, opts, timeout);

    // 无能力承载 ⇒ 事件式命令。三条结算路径（响应/错误/超时）统一走 finish，
    // 无人可答 ⇒ 立刻具名失败。`emit` 是同步的：此刻既没有 method 的监听者，也没有
    // response 的等待者，这条命令不可能被任何人兑现（在 start() 里自调未注册的能力即此类）。
    if (!this.listenerCount(method) && !this.listenerCount(`${method}.response`)) {
      return this._failureResult(opts, {
        state: 'failed', code: 'command_unhandled', error: `Command has no handler: ${method}`,
        execution_stage: 'pre_dispatch', dispatched: false, side_effect: 'none',
      });
    }
    // 超时路径必须摘掉 `.error` 监听器，否则每次超时都多留一个。
    return new Promise((resolve) => {
      const finish = (payload) => {
        clearTimeout(timer);
        this.off(`${method}.response`, onResponse);
        this.off(`${method}.error`, onError);
        resolve(payload);
      };
      const timer = setTimeout(() => finish(this._failureResult(opts, {
        state: 'failed', code: 'timeout_no_abort', error: `Command timeout: ${method}`,
        // 事件式命令没有 Attempt 可跟踪，故"是否仍在跑"只能如实标 unknown。
        execution_outcome: 'unknown',
      })), timeout);
      const onResponse = (result) => finish(result);
      const onError = (err) => finish(this._failureFromThrown(opts, err));

      this.once(`${method}.response`, onResponse);
      this.once(`${method}.error`, onError);
      this.emit(method, params);
    });
  }

  /**
   * 服务登记 = **对象**与**归属**同一次操作提交（两个 Map 要么一起改，要么都不改）。
   * 四种情况分开定义：① 原本无主 → 允许并登记本次归属；② 同 owner 更新 → 允许，归属不变；
   * ③ 匿名覆写已归属 → **拒绝**；④ 异主接管 → **只认本实例的宿主控制体**。
   *
   * `@host` 是**结果标签**，不是可申请的归属：自封、受信装配上下文、`service.allowOverride`
   * 一律不构成授权（后两者插件能自造）。糊成一个布尔表达式时，匿名覆写会被当成合法 ——
   * `getService(name)` 返回 B 而归属仍是 A。
   */
  registerService(name, obj, opts = {}) {
    // 插件面入口：**永不**携带宿主控制体，故永远走不到跨 owner 接管那条路。
    this._commitService(name, obj, opts, null);
  }

  /**
   * 服务登记的**唯一**提交点：插件面与宿主控制面共用，区别只有一条 ——
   * 调用方有没有**本实例**的宿主控制体。
   *
   * 判据 `hostCtl` 不是布尔开关，而是对象身份（`HOST_CONTROLS.get(this) === hostCtl`）。
   */
  _commitService(name, obj, opts, hostCtl) {
    // 服务也是"对外发布的东西"：同一个停机闸门管它，"有没有世代"不影响这条。
    this._assertRegistrationOpen('service', name);
    const ctx0 = _svcTracking.getStore();
    if (ctx0?.epoch != null && !this.isAssemblyCurrent(ctx0.epoch)) {
      const err = new Error(`assembly_superseded: service "${name}" 的注册来自世代 ${ctx0.epoch} 的装配，`
        + `当前世代 ${this._epoch}（${this._stopping ? 'stopping' : this._stopped ? 'stopped' : 'running'}）不得发布新服务`);
      err.code = 'assembly_superseded';
      throw err;
    }
    const isHost = hostCtl != null && HOST_CONTROLS.get(this) === hostCtl;
    const claimant = isHost ? HOST_OWNER : (ctx0?.owner || this._initOwner || null);
    if (!isHost && claimant === HOST_OWNER) {
      // 自封宿主：`@host` 是不可登主的保留归属。
      const err = new Error(`host_authority_required: 服务 "${name}" 的归属 "@host" 不可自封；`
        + '宿主登记须经 createRuntime() 交出的 host 控制面');
      err.code = 'host_authority_required';
      throw err;
    }
    const prevOwner = this._serviceOwners.get(name) ?? null;
    const prevId = this._serviceRegIds.get(name) ?? null;
    // 「同一 owner 更新」的授权口径：**不能**是 `claimant === prevOwner` 字符串相等。
    // 公开的 `runServiceTracking(owner, fn)` 让调用方自报 owner 且 store 是 `trusted:false`，
    // 实测 `runServiceTracking('victim', () => registerService('db', {who:'attacker'}))` 一路成功
    // —— 对象换成 attacker，归属记录还写着 victim。可自报的字符串不构成授权，所以这里只认
    // 两个**对象身份**：本实例宿主控制体，或登记这笔服务时的那个装配实例。
    const reg = this._serviceRegistrar.get(name) ?? null;
    const sameOwner = claimant === prevOwner
      && (isHost || (ctx0?.trusted === true && ctx0.instance != null && ctx0.instance === reg));
    let nextOwner = claimant;
    let conflict = null;
    if (this._services.has(name)) {
      let allowed;
      let reason;
      if (prevOwner == null) { allowed = true; reason = 'unowned_adopted'; nextOwner = claimant; }
      else if (sameOwner) { allowed = true; reason = 'same_owner'; nextOwner = prevOwner; }
      else if (claimant === prevOwner) { allowed = false; reason = 'same_owner_untrusted'; nextOwner = prevOwner; }
      else if (opts?.takeover !== true) {
        allowed = false;
        reason = claimant == null ? 'anonymous_overwrite_denied' : 'cross_owner_denied';
        nextOwner = prevOwner;
      } else {
        // 跨 owner 接管：**只认本实例的宿主控制体**。没有它一律拒绝，不降级、不猜。
        allowed = isHost;
        reason = isHost ? 'host_takeover' : 'host_authority_required';
        nextOwner = isHost ? HOST_OWNER : prevOwner;
      }
      conflict = {
        service: name, owner: claimant || 'unknown', previousOwner: prevOwner, allowed, reason,
        timestamp: new Date().toISOString(), sourcePlugin: 'core',
      };
      if (!allowed) {
        // 拒绝不是已提交事实，也不是可中止的协调点（结论由下面的 throw 给出）；观察者的异常
        // 不得把它替换成一句别人的报错，故两条路径共用同一个隔离面，只是拒绝路径不等提交。
        this.emitFact('core:service.conflict', conflict);
        const code = reason === 'host_authority_required' ? 'host_authority_required' : 'service_conflict';
        const err = new Error(`${code}: 服务 "${name}" 已由 ${prevOwner} 注册，`
          + `${claimant ?? '未声明 owner 的调用方'} 不得静默覆写（${reason}）`);
        err.code = code;
        throw err;
      }
      this.log('warn', `Service provider conflict: "${name}" ${reason} ⇒ ${nextOwner ?? '(anonymous)'}`);
    }
    // 原子提交：从这四行到下一条语句之间不得有 await / throw —— 对象与归属不许分叉，就靠这一条。
    const registrationId = ++this._svcSeq;
    this._services.set(name, obj);
    if (nextOwner == null) this._serviceOwners.delete(name);
    else this._serviceOwners.set(name, nextOwner);
    this._serviceRegistrar.set(name, ctx0?.instance ?? null);
    this._serviceRegIds.set(name, registrationId);
    // 接管回执只有**这一个**构造点：字段集必须与 `getServiceOwnership` 冻结出的形状逐一对应，
    // 两处各写一份字面量 ⇒ 将来加一个字段只会加进其中一支（读的人拿不到该字段，且不会报错）。
    // `at` 每次调用现取：回执描述的是"这一次提交"。
    const takeoverReceipt = (previousRegistrationId) => ({
      service: name, previousRegistrationId, newRegistrationId: registrationId,
      previousOwner: prevOwner, newOwner: HOST_OWNER, actorClass: 'host',
      reason: opts?.reason ?? null, outcome: 'committed', at: new Date().toISOString(),
    });
    if (nextOwner === HOST_OWNER && prevOwner !== HOST_OWNER) {
      // 接管回执：`actorClass` 由**授权通道**决定（宿主控制面），不是调用方传来的标签。
      this._serviceTakeovers.set(name, takeoverReceipt(prevId));
    } else if (nextOwner === HOST_OWNER) {
      // 宿主**再次**登记同名服务（Host→Host 续期）：回执必须跟着走，否则它一边被当作
      // "当前宿主登记证明"读，一边指着上一笔已经作废的 ID。
      // `previousRegistrationId` 保持**首次接管时**那一笔 —— 那是既往事实，不该被续期改写。
      // 两种口径不能同时成立：要么回执=当前证明（这里同步 ID），要么回执=一次既往事件
      // （那就不能拿 `newRegistrationId` 当当前 ID 用）。本内核取前者。
      const rec = this._serviceTakeovers.get(name);
      if (rec) rec.newRegistrationId = registrationId;
      else {
        // 没有既有回执但归属已是宿主（例如从持久状态恢复）：补一份"当前证明"。
        this._serviceTakeovers.set(name, takeoverReceipt(prevId));
      }
    } else if (nextOwner !== HOST_OWNER && this._serviceTakeovers.has(name)) {
      // 归属已被非宿主改写：旧的接管回执不能再留着充当"现在是宿主的东西"。
      this._serviceTakeovers.delete(name);
    }
    if (ctx0?.serviceNames instanceof Map && !isHost) {
      // 收据 = 名字 + **本次提交出来的**登记 ID + 登记实例。ID 只来自上面那行自增，
      // 插件自报的编号一律不采信；失败清理拿它判 ABA，不拿名字。
      //
      // `!isHost` 是**记账来源**判据，不是比较条件：宿主控制面的登记若落进
      // 当前正在跑的插件装配账，旧插件 init 一旦失败，清理就会"精确地"删掉宿主刚接管的那笔
      // —— 收据上的 ID 完全对得上，compare-and-delete 一点毛病都没有。根因是**它本不该
      // 记进这本账**：`host.takeoverService()` 可能被合法地调用在插件装配的 async 链里，
      // 但宿主的登记不属于那次装配，也不该被那次失败连坐。
      ctx0.serviceNames.set(name, { name, registrationId, instance: ctx0.instance ?? null });
    }
    // 已提交事实的通知面：观察者同步抛错或异步拒绝，都不能把这次提交倒写成失败。
    if (conflict) this.emitFact('core:service.conflict', conflict);
    this.log('info', `Service registered: ${colorize('yellow', name)}`);
  }

  /** **可核对面**：对象、归属、登记身份、接管回执四件事由这一个方法回答。 */
  getServiceOwnership(name) {
    // 回执必须交**快照**，不是内部对象：直接交出引用时，调用方一句
    // `getServiceOwnership('db').takeover.newRegistrationId = 987654` 就改写了下一份
    // 权属证据 —— 查询变成写入，而"权威记录"还在被别处当真相读。
    const takeover = this._serviceTakeovers.get(name);
    return {
      name,
      owner: this._serviceOwners.get(name) ?? null,
      registered: this._services.has(name),
      registrationId: this._serviceRegIds.get(name) ?? null,
      takeover: takeover ? Object.freeze({ ...takeover }) : null,
    };
  }

  /**
   * 服务登记的**唯一**删除点：先比登记身份，再一次性清五个账。
   *
   * 判据是登记 ID 相等，不是名字相等 —— 名字后到者可以共用，ID 不能。比不中就是 stale：
   * 服务本体、它的新归属、接管回执一律不动；也不许留下"对象没了但登记 ID 还在"的幽灵账
   * （那种账会让按旧 ID 的释放对一个已经不存在的服务返回成功）。
   */
  _discardServiceReceipt(receipt) {
    const name = receipt?.name;
    const id = receipt?.registrationId;
    if (name == null || id == null) return { ok: false, code: 'stale_registration', service: name ?? null };
    if (this._serviceRegIds.get(name) !== id) return { ok: false, code: 'stale_registration', service: name };
    const registrar = receipt.instance ?? null;
    if (registrar != null && this._serviceRegistrar.get(name) !== registrar) {
      return { ok: false, code: 'stale_registration', service: name };
    }
    // 原子：五行之间没有 await / throw。比较成功就一起清，比较失败就一个都不动。
    this._services.delete(name);
    this._serviceOwners.delete(name);
    this._serviceTakeovers.delete(name);
    this._serviceRegistrar.delete(name);
    this._serviceRegIds.delete(name);
    return { ok: true, service: name, registrationId: id };
  }

  /**
   * 宿主按**单次登记**撤销服务。判据是 `compare-and-delete(registrationId)`：
   * 登记 ID 已被后继覆盖 ⇒ stale，绝不误删新登记（ABA）。
   */
  _releaseHostService(name, registrationId, hostCtl) {
    if (HOST_CONTROLS.get(this) !== hostCtl) {
      const err = new Error(`host_authority_required: 撤销服务 "${name}" 须持本实例的宿主控制面`);
      err.code = 'host_authority_required';
      throw err;
    }
    return this._discardServiceReceipt({ name, registrationId });
  }

  /**
   * 服务清场（内部）：只由 `_reapRegistrations` 调用，返回真的删掉了哪些。**容器只由 Core 自己的方法改**。
   * 生命周期层直接 `_services.delete()` + `_serviceOwners.delete()` 会留下对象与归属分叉。
   * 并顺带按 `svc.name` 匹配：名字巧合相同就删掉别人的资源（§5.4 的"粗放清场"）。
   * 现在只能撤销**归属确为该 owner** 的条目，返回真的删掉了哪些，供调用方核对。
   * 宿主接管的条目（`@host`）不在此列：没有任何插件能按名把它拆走。
   */
  #releaseServicesByOwner(owner, instance) {
    const key = owner == null ? null : String(owner);
    if (key == null || key === HOST_OWNER) return [];
    // **登记实例是必要条件**：owner 是可列举的字符串，单凭它清场就是「猜对名字即放权」。
    // 此前 `instance` 为 null 时整行身份匹配被跳过（`if (instance && …)`），于是任何能调
    // `issueLifecycleReaper()` 的调用方一句 `reaper('victim', null)` 就能清掉别人的服务。
    if (instance == null) return [];
    const released = [];
    for (const [name, o] of [...this._serviceOwners]) {
      if (o !== key) continue;
      // 归属名来自受信装配（插件不能自选），再叠一层登记实例身份：
      // 同名新实例不会被旧实例的迟到清理误删（服务侧的 ABA）。
      if (this._serviceRegistrar.get(name) !== instance) continue;
      // 清场也走同一个比较删除：比的是此刻账上的 ID，等价于"只回收自己这笔"。
      const r = this._discardServiceReceipt({ name, registrationId: this._serviceRegIds.get(name), instance });
      if (r.ok === true) released.push(name);
    }
    return released;
  }

  /**
   * 生命周期清场的**唯一**通道：`#` 字段，构造期一次交给 `core.lifecycle`（曾是公开的
   * `issueLifecycleReaper()`：拿到 Core 引用就能领一张"管理员证件"，而 `core.plugins`
   * 是公开 Map，"要传真实 instance"于是不构成授权条件）。
   *
   * 边界照旧：同进程代码仍能直接改私有表，这不是 OS 隔离；它保证的是**受管 API 入口**的
   * 纪律。
   */
  #reap = (pluginName, instance) => this.#reapRegistrations(pluginName, instance);

  #reapRegistrations(pluginName, instance) {
    const capabilities = [];
    // 同理：没有登记实例就没有可核对的资产，不按名字猜。
    if (instance == null) return { capabilities, services: [] };
    for (const [id, rec] of [...this._capabilities]) {
      if (rec?.registrar !== instance) continue;
      if (this._capabilities.delete(id)) capabilities.push(id);
    }
    const services = pluginName == null ? [] : this.#releaseServicesByOwner(pluginName, instance);
    return { capabilities, services };
  }

  // **已知缺口，本轮不假装闭合** —— getService 直接返回服务对象，调用方随即绕过能力层校验；无进程隔离时 JS 级检查挡不住同进程不可信插件（真正闭合需 R1 进程/权限隔离）。现状：仅允许可信插件进程内运行；受保护能力已要求 identity_verified（见 _invocationContext）。
  getService(name) {
    const ctx = _svcTracking.getStore();
    if (ctx) {
      ctx.services.add(name);
    } else if (this._trackServiceAccess) {
      this._trackedServices.add(name);
    }
    return this._services.get(name);
  }

  // 在服务追踪上下文中执行 fn（插件 init 用）：返回本次链路消费的服务名集合。
  // 并发安全：每个 run() 独立 store，交错加载互不可见（B-04）。
  async runServiceTracking(owner, fn) {
    const store = await this._runAssemblyContext(owner, fn, null);
    return store.services;
  }

  /**
   * 装配上下文（内部）。与 `runServiceTracking` 同一个 ALS store，只是**多记两笔账**：
   * `epoch`（这笔装配属于哪个世代）与 `capabilities/serviceNames`（它发布了什么）。
   *
   * 为什么不给 `runServiceTracking` 加返回字段：它是公开入口，返回值已被消费者当
   * `Set<string>` 用（单测就这么写）。改返回值等于把"加一个闸门"变成一次 API 破坏。
   */
  async _runAssemblyContext(owner, fn, epoch, instance = null) {
    // `instance` 是**登记实例**（插件对象），不是可枚举的字符串：清场按它精确匹配。
    // **来源继承**（F05）：`runServiceTracking` 是公开入口，传的 `epoch` 是 null。内层若就此
    // 重置成「无世代、无实例」，旧世代插件在 init 里调一次公开入口就拿到无世代 store，世代闸门
    // 被 `asm?.epoch != null` 短路 —— 实测服务与能力双双 ALLOWED。故世代/实例只能由外层下传，
    // 账也复用外层那两个 Set，否则内层登记逃出外层失败清理（实测清理后仍在表里）。
    // 反之 `owner`/`trusted` **不**继承：署名与受信只属于本层显式声明的世代，继承它们等于
    // 让任意插件冒充别人的署名，把 S6「可列举的字符串不构成授权」作废。
    const outer = _svcTracking.getStore();
    // **嵌套不得改写受信归属，但受信本身不能继承** —— 两件事混在一起就会按下葫芦浮起瓢：
    //   · `owner` 是"谁为这笔登记负责、卸载按谁清场"，外层已受信时沿用外层；否则公开的
    //     `runServiceTracking('subcomponent')` 会让 owner 与 registrar 对不上，按
    //     (owner, instance) 清场时两边都清不掉，留下无主飞地。
    //   · `trusted` 是 provider 的铸造权，**只看本层是否显式给了世代**：跟着外层继承，
    //     任何插件都能冒名顶替他人署名（S6：可列举的字符串不构成授权）。
    const nestedInTrusted = epoch == null && outer?.trusted === true;
    const store = {
      owner: nestedInTrusted ? outer.owner : owner,
      services: new Set(), epoch: epoch ?? outer?.epoch ?? null,
      trusted: epoch != null,
      instance: instance ?? outer?.instance ?? null,
      capabilities: outer?.capabilities ?? new Set(), serviceNames: outer?.serviceNames ?? new Map(),
    };
    // 失败也必须把**本次装配的账**交出去：`_load` 的清理要按 id 精确收回已发布的东西，
    // 拿不到 store 时 `discardAssemblyArtifacts(null)` 是空转，能力会留在表里。
    try { await _svcTracking.run(store, fn); }
    catch (err) { if (err && typeof err === 'object' && !err.assemblyStore) err.assemblyStore = store; throw err; }
    return store;
  }

  /** 当前装配的只读快照（门面用它记"这一笔目录项是谁登记的"）。它不是授权对象。 */
  currentAssembly() {
    const s = _svcTracking.getStore();
    return s ? { owner: s.owner ?? null, instance: s.instance ?? null, trusted: s.trusted === true } : null;
  }

  /**
   * 中间件也要有身份和对称注销入口：只塞裸函数时，`offByOwner` 之后该变换器照样执行 ——
   * 插件卸载后旧变换器仍在解释最终消息。现在返回 disposer 并给出 `unuse` /
   * `offPipelineByOwner`；不传 owner 的旧调用行为不变。
   *
   * 边界：管道是**外围消息变换**，不是内核状态守卫，不得用来绕过 Guard。
   */
  use(stage, fn, opts = {}) {
    if (!this._pipelines[stage]) this._pipelines[stage] = [];
    // 归属来源与 `registerService` 同一条规则：显式 `opts.owner` 优先，否则用**当前装配上下文**。
    // 于是插件在 init/start 里 `use()` 的中间件天然有主，卸载时会被 `_step5CleanListeners` 撤销 ——
    // 不需要每个插件自己记得传 owner（记得传是一件会被忘掉的事）。
    const owner = opts?.owner ?? _svcTracking.getStore()?.owner ?? this._initOwner ?? null;
    // 每次注册一个 entry（token），管道数组与 owner 索引**存同一个对象** ——
    // 不再有"按函数名在两个结构里各猜一次"的余地。
    const entry = { token: ++this._pipeSeq, stage, fn, owner: owner == null ? null : String(owner) };
    this._pipelines[stage].push(entry);
    if (entry.owner) {
      let list = this._pipelineOwners.get(entry.owner);
      if (!list) { list = []; this._pipelineOwners.set(entry.owner, list); }
      list.push(entry);
    }
    this.log('info', `Middleware registered: ${colorize('yellow', stage)}`);
    // disposer 关的是**这一次注册**（entry），不是"数组里最后一个同名函数"。
    return () => this._removePipelineEntry(entry);
  }

  /** 精确撤掉一条中间件 entry：管道数组与 owner 索引同一次提交。 */
  _removePipelineEntry(entry) {
    const list = this._pipelines[entry.stage];
    const i = list ? list.indexOf(entry) : -1;
    if (i < 0) return false;
    list.splice(i, 1);
    if (entry.owner) {
      const recs = this._pipelineOwners.get(entry.owner);
      const j = recs ? recs.indexOf(entry) : -1;
      if (j >= 0) recs.splice(j, 1);
      if (recs && !recs.length) this._pipelineOwners.delete(entry.owner);
    }
    return true;
  }

  unuse(stage, fn) {
    const list = this._pipelines[stage];
    if (!list) return false;
    // Node 口径：删**最后一条**同名注册，而账本删的就是同一条（不再各删各的）。
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].fn === fn) return this._removePipelineEntry(list[i]);
    }
    return false;
  }

  offPipelineByOwner(owner) {
    const key = String(owner);
    const recs = this._pipelineOwners.get(key);
    if (!recs || !recs.length) return 0;
    let n = 0;
    for (const entry of [...recs]) if (this._removePipelineEntry(entry)) n++;
    this._pipelineOwners.delete(key);
    if (n > 0) this.log('info', `Cleaned ${n} middleware for owner: ${this.colorize('cyan', key)}`);
    return n;
  }

  async runPipeline(stage, msg, ctx = {}) {
    const pipeline = this._pipelines[stage];
    if (!pipeline) return msg;
    for (const entry of pipeline) {
      msg = await entry.fn(msg, ctx);
      if (msg === false) {
        this.emit('pipeline.blocked', {
          stage, ctx,
          timestamp: new Date().toISOString(),
          sourcePlugin: 'core',
        });
        return null;
      }
    }
    return msg;
  }

  get(path, fallback) {
    const cfg = this._services.get('config');
    if (cfg?.get) return cfg.get(path, fallback);
    return fallback;
  }

  setData(key, value) {
    if (value === null || value === undefined) {
      this._data.delete(key);
    } else {
      this._data.set(key, value);
    }
  }

  getData(key, fallback) {
    return this._data.get(key) ?? fallback;
  }

  async confirm(question, timeoutMs = 30000) {
    const actionTypes = this.get('privacy.requireConfirmFor') || [];
    this._confirmCount++;
    this._currentTaskConfirms++;
    // 事件带 `reason`：上层要能区分"用户拒绝"（改请求）与"无人在场"（要么拿授权、要么别跑）。
    const emitConfirm = (approved, reason) => this.emit('core.confirm', {
      question, count: this._confirmCount, approved, reason, sourcePlugin: 'core',
    });
    this.log('info', `[confirm #${this._confirmCount}] ${question}`);

    // **无人在场时不得替人点头**：`!isTTY ⇒ return true` 会让 CI/守护进程/管道里
    // 系统替人做了"同意"的决定，而调用方据此真的落地了动作。
    // 三分支：显式可信自动批准 > 无 TTY 拒绝 > 有 TTY 交互。
    // 逃生门只能来自配置（不能由模型自报），默认关 —— "没人反对"≠"有人同意"。
    if (actionTypes.length === 0) {
      this.log('info', '[confirm] No requireConfirmFor configured, auto-approved');
      emitConfirm(true, 'no_require_confirm_for');
      return true;
    }

    if (!process.stdin.isTTY) {
      if (this.get('privacy.trustedAutoApprove') === true) {
        this.log('warn', '[confirm] Non-TTY + privacy.trustedAutoApprove=true ⇒ 按宿主显式授权放行（已留证据）');
        emitConfirm(true, 'trusted_auto_approved');
        return true;
      }
      this.log('warn', '[confirm] Non-TTY 且无可信批准来源 ⇒ 拒绝（不自动同意）');
      emitConfirm(false, 'no_tty_refused');
      return false;
    }

    const readline = await import('node:readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await Promise.race([
        new Promise(resolve => rl.question(`\x1b[33m❓ ${question} (y/N): \x1b[0m`, resolve)),
        new Promise(resolve => setTimeout(() => resolve(''), timeoutMs)),
      ]);
      const approved = answer.toLowerCase().startsWith('y');
      if (!approved) this.log('info', `[confirm] Rejected by user${answer === '' ? ' (timeout)' : ''}`);
      emitConfirm(approved, answer === '' ? 'timeout' : (approved ? 'user_approved' : 'user_rejected'));
      return approved;
    } finally {
      rl.close();
    }
  }

  getConfirmMetrics() {
    // `tasks` 必须是副本：它是**聚合的输入**，交出活数组等于把平均值交给调用方改写
    // （push 一个 987654，下一次 `averagePerTask` 就成了 493827.0）。
    const tasks = [...this._taskConfirmCounts];
    return {
      totalConfirmations: this._confirmCount,
      currentTask: this._currentTaskConfirms,
      tasks,
      averagePerTask: tasks.length > 0
        ? (tasks.reduce((a, b) => a + b, 0) / tasks.length).toFixed(1)
        : null,
    };
  }

  startTask(taskId) {
    this._currentTaskConfirms = 0;
  }

  endTask(taskId) {
    this._taskConfirmCounts.push(this._currentTaskConfirms);
    this._currentTaskConfirms = 0;
  }

  status() {
    const uptime = this._startTime ? `${Math.floor((Date.now() - this._startTime) / 1000)}s` : 'not started';
    return {
      running: this.running,
      uptime,
      plugins: Array.from(this.plugins).map(([name, p]) => ({
        name,
        version: p.version || '0.0.0',
        state: p.state,
        metrics: p._metrics || null,
      })),
    };
  }
}

/**
 * 运行时的**正规构造方式**：一次构造，把「插件能看到的 core」与「只交给启动程序的 host」
 * 分开交付。插件经 `init(core)` 只拿到前者；`core` 上没有任何"发一枚宿主令牌"的方法。
 *
 * 普通 `new Core()` 仍然合法（工具链与测试大量使用），但它**不交出 host** ——
 * 没有控制体就没有管理别人服务的能力。这是默认拒绝，不是缺陷。
 */
export function createRuntime(options = {}) {
  const core = new Core(options);
  const control = HOST_CONTROLS.get(core);
  const guard = (fn) => {
    if (core._stopping || core._stopped) {
      const err = new Error('host_authority_required: 运行时已停止，宿主控制面不再接受提交');
      err.code = 'host_authority_required';
      throw err;
    }
    return fn();
  };
  const host = Object.freeze({
    registerService: (name, obj, opts = {}) => guard(() => core._commitService(name, obj, opts, control)),
    takeoverService: (name, obj, opts = {}) => guard(
      () => core._commitService(name, obj, { ...opts, takeover: true }, control),
    ),
    releaseService: (name, registrationId) => guard(() => core._releaseHostService(name, registrationId, control)),
    ownership: (name) => core.getServiceOwnership(name),
  });
  return { core, host };
}

export { Core, colorize };
