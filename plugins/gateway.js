import { networkInterfaces } from 'node:os';
import { timingSafeEqual } from 'node:crypto';
import { readEnv } from '../src/core/env.js';
// 会话标识是外部输入，在 HTTP/WS 边界就判：攻击请求既不落盘、也不触发模型调用。
import { assertSessionId } from './tools/lib/session-id.mjs';
// 免 key 本地端点的判据与 model 插件共用一份实现（ready 与真实调用不得背离）。
import { isKeylessEndpoint } from './_lib/model-endpoint.js';

// Bearer/WS token 用常数时间比较，消除时序侧信道。
/**
 * 路由判据一律取**路径**，不带查询串/锚点。
 * 路径与查询串只在 `pathnameOf` 一处分开，分派、健康检查、`/api/*` 判定、`/ws` 升级共用它；
 * 否则带查询串的请求（`?token=`、监控加时间戳）会全部落到 404。
 */
function pathnameOf(req) {
  const raw = req.url || '/';
  let end = raw.length;
  for (const sep of ['?', '#']) {
    const i = raw.indexOf(sep);
    if (i >= 0 && i < end) end = i;
  }
  const path = raw.slice(0, end);
  return path || '/';
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

class TokenBucket {
  constructor(capacity = 100, refillPerSec = 20) {
    this.capacity = capacity
    this.tokens = capacity
    this.refillRate = refillPerSec
    this.lastRefill = Date.now()
  }
  _refill() {
    const now = Date.now()
    const elapsed = (now - this.lastRefill) / 1000
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate)
    this.lastRefill = now
  }
  take() {
    this._refill()
    if (this.tokens < 1) return false
    this.tokens--
    return true
  }
}

class GatewayPlugin {
  name = 'gateway';
  // 0.5.0（R0-180）：新增 `POST /api/session/cancel` 与 `GET /api/session/stats`；
  // OpenAI 兼容面接受 `budget` / `stateless` / `capabilities` / `permission_mode` 扩展字段。
  version = '0.5.0';
  permissions = ['net.listen'];
  // `registerService('gateway', this)` 与这里声明的服务名必须一致：
  // chat-ui 的 `requires = { gateway }` 在准入闸门里靠它找 provider。
  provides = [{ name: 'gateway', removable: false }];

  constructor() {
    this.httpServer = null;
    this.wsServer = null;
    this.requestId = 0;
    this.handlers = new Map();
    this._limiter = new TokenBucket(100, 20);
  }

  // 暴露**实际绑定**端口：`--port 0` / 配置 `port: 0` 时端口由内核分配，
  // 只有 listen 之后才有真值，消费方不得硬编码 9002。
  get port() {
    return this.httpServer?.address()?.port ?? null;
  }

  async init(core) {
    this.core = core;
    this.clients = new Map();
    core.registerService('gateway', this);
    const broadcastEvents = [
      'request.start', 'request.end',
      'tool.progress', 'tool.execute', 'tool.result', 'tool.registered', 'tool.awaiting-approval',
      'chat.stream.chunk', 'chat.stream.reasoning', 'chat.stream.reasoning_end', 'chat.messages_built',
      'scene.switched', 'config.reloaded',
      'health.ok', 'health.fail', 'health.critical',
      'core:plugin.loaded', 'core:plugin.unloading', 'plugin.init_failed',
    ];
    for (const evt of broadcastEvents) {
      core.on(evt, (data) => this.broadcast(evt, data), { owner: 'gateway' });
    }
    // 会话 ↔ 工作目录的观测面：必须能回答"我在哪个目录里干活"，而不是靠推测。
    this.addHandler('GET', '/api/sessions', (req, res) => this._handleSessionsGet(req, res));
    // 工具审计的**读取面**：控制面鉴权与其余 `/api/*` 同门（`_guardControlPlane`），
    // 不是新的暴露面。
    // 上下文读数与手动压缩：控制面同门；会话由调用方指名，没有"列出所有会话"的入口。
    this.addHandler('GET', '/api/context', (req, res) => this._handleContextGet(req, res));
    this.addHandler('POST', '/api/context/compact', (req, res) => this._handleContextCompact(req, res));
    this.addHandler('GET', '/api/audit', (req, res) => this._handleAuditGet(req, res));
    // 轻任务控制面（R0-180）：按会话取消 + 按会话观测。
    // 注意路径：`/api/sessions` 已经被"会话↔工作目录绑定"占用（workspace.list），
    // 新面必须换名字 —— 复用同一个路径会让现有客户端的读法在一夜之间改变含义。
    this.addHandler('POST', '/api/session/cancel', (req, res) => this._handleSessionCancel(req, res));
    this.addHandler('GET', '/api/session/stats', (req, res) => this._handleSessionStats(req, res));
  }

  /**
   * `GET /api/audit?session=<id>&limit=<n>` → 该会话的工具审计（含**被拒**的调用）。
   * 安全审计要回答"最近哪些调用被拒了、为什么"，被权限门拦下的调用也要留痕。
   *
   * 边界：这是**进程内**环形缓冲（每会话最多 500 条），不是持久化审计；
   * 发行包里 event-sink 是 null sink，因此这里**不**声称 durable。
   */
  _handleAuditGet(req, res) {
    const ex = this.core.getService?.('tool-executor');
    if (!ex || typeof ex.getAuditLog !== 'function') {
      this._sendJson(res, 501, { error: 'tool-executor not loaded', code: 'audit_unsupported' });
      return;
    }
    const q = new URL(req.url, 'http://localhost').searchParams;
    const sessionId = q.get('session');
    if (!sessionId) {
      this._sendJson(res, 400, { error: 'query "session" is required', code: 'invalid_input' });
      return;
    }
    const rawLimit = Number(q.get('limit'));
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 500) : 50;
    this._sendJson(res, 200, {
      session: sessionId, limit, entries: ex.getAuditLog(sessionId, limit),
      // 诚实标注：进程内、非持久
      durable: false,
    });
  }

  /**
   * `GET /api/context?session_id=<id>` → 该会话的上下文用量与摘要元数据（只读）。
   * 会话不在本进程（没有内存里的会话）时 404 `unknown_session`：不拿“空数组算出的 0”冒充“没在跑”。
   */
  async _handleContextGet(req, res) {
    const ctx = this.core.getService?.('context');
    if (typeof ctx?.snapshot !== 'function') {
      this._sendJson(res, 501, { error: 'context service not loaded', code: 'context_unsupported' });
      return;
    }
    const raw = new URL(req.url, 'http://localhost').searchParams.get('session_id');
    if (!raw) {
      this._sendJson(res, 400, { error: 'query "session_id" is required', code: 'session_required' });
      return;
    }
    let id;
    try { id = assertSessionId(raw); }
    catch (err) { this._sendError(res, 400, err.message, err.code || 'invalid_session_id'); return; }
    const snap = await ctx.snapshot(id);
    if (!snap.messages) {
      this._sendJson(res, 404, { error: `unknown session "${id}": no history in this process`, code: 'unknown_session' });
      return;
    }
    this._sendJson(res, 200, snap);
  }

  /** `POST /api/context/compact` {session_id} → 立即压缩一次，回报前/后用量与摘要元数据。 */
  async _handleContextCompact(req, res) {
    const ctx = this.core.getService?.('context');
    if (typeof ctx?.compact !== 'function') {
      this._sendJson(res, 501, { error: 'context service not loaded', code: 'context_unsupported' });
      return;
    }
    let body;
    try { body = JSON.parse((await this._collectBody(req, res)) || '{}'); }
    catch { this._sendError(res, 400, 'invalid JSON body', 'invalid_json'); return; }
    const raw = body?.session_id;
    if (!raw) {
      this._sendJson(res, 400, { error: 'body "session_id" is required', code: 'session_required' });
      return;
    }
    let id;
    try { id = assertSessionId(raw); }
    catch (err) { this._sendError(res, 400, err.message, err.code || 'invalid_session_id'); return; }
    try {
      this._sendJson(res, 200, await ctx.compact(id));
    } catch (err) {
      const code = err?.code || 'compact_failed';
      const status = code === 'unknown_session' ? 404 : (code === 'summary_unavailable' ? 409 : 500);
      this._sendJson(res, status, { error: err.message, code });
    }
  }

  /** `GET /api/sessions` → 默认根、策略、白名单、当前绑定（控制面鉴权与 `/api/*` 同门）。 */
  _handleSessionsGet(req, res) {
    const ws = this.core.getService('workspace');
    if (!ws) {
      this._sendJson(res, 501, { error: 'workspace service not loaded (scene without base-system?)', code: 'workspace_unsupported' });
      return;
    }
    this._sendJson(res, 200, ws.list());
  }

  /**
   * 400 类（调用方输入不合法）与 5xx 类（网关/模型/超时）的分界。
   *
   * 只认**具名 code**，不靠错误文案前缀：文案会变，code 是合同。少列一个 code 的代价是
   * “请求写错了”被报成 502/504 —— 客户端会去重试一个永远不会成功的请求。
   */
  _isContractCode(code) {
    return code === 'invalid_session_id' || code === 'out_of_bounds'
      || code === 'invalid_budget' || code === 'budget_unsupported'
      || code === 'invalid_session_policy' || code === 'unsupported_permission_mode'
      || code === 'session_policy_unavailable';
  }

  /**
   * `POST /api/session/cancel` {session_id, reason} → 停止某一个会话的当前轮次。
   *
   * **202 表示“请求已登记”，不表示“已经停了”** —— 200 会被读成后者。终态（`cancelled` /
   * `unknown`）只出现在那条 `chat.handle` 的返回值里，这里不回收、不伪造。
   */
  async _handleSessionCancel(req, res) {
    const svc = this.core.getService?.('chat-control');
    if (!svc || typeof svc.cancel !== 'function') {
      this._sendJson(res, 501, {
        error: 'chat-control is not present in this assembly (haotian-lite is not the chat provider); '
          + 'per-session cancel is unavailable',
        code: 'session_control_unsupported',
      });
      return;
    }
    let body;
    try { body = JSON.parse((await this._collectBody(req, res)) || '{}'); }
    catch { this._sendError(res, 400, 'invalid JSON body', 'invalid_json'); return; }
    const raw = body?.session_id ?? body?.sessionId;
    if (!raw) { this._sendJson(res, 400, { error: 'body "session_id" is required', code: 'session_required' }); return; }
    let id;
    try { id = assertSessionId(raw); }
    catch (err) { this._sendError(res, 400, err.message, err.code || 'invalid_session_id'); return; }
    try {
      const out = svc.cancel(id, { reason: body?.reason });
      this._sendJson(res, out?.accepted ? 202 : 200, out);
    } catch (err) {
      this._sendJson(res, 500, { error: err.message, code: err.code || 'cancel_failed' });
    }
  }

  /**
   * `GET /api/session/stats[?session_id=<id>]` → 进程内每会话的排队/在跑/轮次/token/最后错误。
   *
   * 边界与 `/api/audit` 相同：这是**进程内**读数（`stats_scope:"process-local"`），不是跨进程
   * 聚合，也不含 prompt/回复正文。会话不给就返回全部；给了但本进程没见过 → 404，
   * 不拿一个全 0 的行冒充“它没在跑”。
   */
  _handleSessionStats(req, res) {
    const svc = this.core.getService?.('chat-control');
    if (!svc || typeof svc.snapshot !== 'function') {
      this._sendJson(res, 501, {
        error: 'chat-control is not present in this assembly (haotian-lite is not the chat provider)',
        code: 'session_control_unsupported',
      });
      return;
    }
    const q = new URL(req.url, 'http://localhost').searchParams;
    const raw = q.get('session_id') || q.get('session');
    if (raw) {
      let id;
      try { id = assertSessionId(raw); }
      catch (err) { this._sendError(res, 400, err.message, err.code || 'invalid_session_id'); return; }
      const row = svc.stat(id);
      if (!row) {
        this._sendJson(res, 404, { error: `unknown session "${id}": no turn in this process`, code: 'unknown_session' });
        return;
      }
      this._sendJson(res, 200, row);
      return;
    }
    this._sendJson(res, 200, svc.snapshot());
  }

  /**
   * OpenAI 兼容面上的**扩展字段**（R0-180）：`budget` / `stateless` /
   * `capabilities` / `permission_mode`。
   *
   * 未给就不传 —— 不传与传 `null` 在 `chat.handle` 里是两件事（后者会被当成“给了个空预算”）。
   */
  _budgetFloorMs(data) {
    const wall = Number(data?.budget?.wall_ms);
    return Number.isFinite(wall) && wall > 0 ? wall + 30000 : 0;
  }

  _sessionParams(data) {
    const out = {};
    if (data?.budget !== undefined) out.budget = data.budget;
    if (data?.stateless !== undefined) out.stateless = data.stateless === true;
    if (data?.capabilities !== undefined) out.capabilities = data.capabilities;
    if (data?.permission_mode !== undefined) out.permission_mode = data.permission_mode;
    return out;
  }

  /**
   * 判定调用方是否**本机**。`remoteAddress` 在 IPv4-mapped 形态下是 `::ffff:127.0.0.1`，
   * 必须先去掉映射前缀，否则本机调用方会被当成远端。
   */
  _isLoopbackAddr(addr) {
    const a = String(addr || '').replace(/^::ffff:/i, '');
    return this._isLoopbackHost(a);
  }

  addHandler(method, path, handler) {
    this.handlers.set(`${method}:${path}`, handler);
  }

  // 跨源策略**默认收敛**：缺省不发任何 CORS 头（同源）；
  // 只有显式配置 `gateway.corsOrigins` 白名单时才回显被允许的 Origin，白名单里的 `*`
  // 同样要通过管理面的同源检查。
  _cors(req, res) {
    const allowed = this.core?.get?.('gateway.corsOrigins');
    const origin = req.headers['origin'];
    if (!Array.isArray(allowed) || !allowed.length) return true; // 同源 only：不发头，浏览器自会拦住跨源读取
    const ok = allowed.includes(origin) || allowed.includes('*');
    if (!ok) return false;
    res.setHeader('Access-Control-Allow-Origin', origin || allowed[0]);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Ming-Token');
    return true;
  }

  // 控制面地址判据：只认回环。`localhost` 交给系统解析（不出网卡）。
  _isLoopbackHost(host) {
    const h = String(host || '').replace(/^\[|\]$/g, '');
    return h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1' || h.startsWith('127.');
  }

  /**
   * **可信 Host 白名单**：`_sameOrigin` 比对的 Host 必须落在**我们自己算出来的**集合里，
   * 不能让 Origin 与 Host 互相自证。集合包含：
   *   · 回环名 + 实际监听端口（默认部署的全部合法形态）；
   *   · 显式配置的对外地址：`gateway.corsOrigins` 与 `gateway.trustedHosts` 里的 host[:port]；
   *   · 非回环监听时，实际绑定的那个 host:port（否则自己都进不来）。
   * 反向代理部署要用的外部域名请显式写进 `gateway.trustedHosts`，不要靠"任意 Host 自证"。
   */
  _trustedHosts() {
    const cfg = this.core.getService('config');
    const port = this.port;
    const set = new Set();
    if (port) {
      for (const h of ['127.0.0.1', 'localhost', '[::1]', '::1']) set.add(`${h}:${port}`);
      const bind = cfg?.get('gateway.host');
      if (bind && !this._isLoopbackHost(bind)) {
        set.add(bind.includes(':') && !bind.startsWith('[') ? `[${bind}]:${port}` : `${bind}:${port}`);
      }
    }
    const extra = []
      .concat(cfg?.get('gateway.trustedHosts') || [])
      .concat(cfg?.get('gateway.corsOrigins') || []);
    for (const raw of extra) {
      if (typeof raw !== 'string' || raw === '*') continue;   // `*` 不是可信来源，忽略而非放行
      try {
        const u = new URL(raw.includes('://') ? raw : `http://${raw}`);
        set.add(u.host);
      } catch { /* 非法条目忽略：宁可拒绝，不可放宽 */ }
    }
    return set;
  }

  /**
   * 请求的 Origin（若有）必须与 Host 同源，**且** Host 必须在可信集合里。
   * `curl`（无 Origin）不受影响；浏览器跨站写请求与 DNS rebinding 伪造都拦在这里。
   */
  _sameOrigin(req) {
    const host = String(req.headers['host'] || '');
    if (!this._trustedHosts().has(host)) return false;
    const origin = req.headers['origin'];
    if (!origin) return true;
    try {
      const u = new URL(origin);
      // 同时比 scheme + host + port：只比 host 会放过 `https://` → `http://` 之类的降级。
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      return u.host === host;
    } catch { return false; }
  }

  // 管理/控制面鉴权：配了 `gateway.apiKey` ⇒ 控制面一律要 `Authorization: Bearer <key>`
  // （常数时间比较）；没配 ⇒ 仅回环部署可用，且写请求必须是同源 + `application/json`
  // （挡住跨站简单请求）。
  _controlAuth(req) {
    return this._auth(req);
  }

  /**
   * 解析请求里的 `session_id`，非法即具名 400。
   * 缺省（undefined/null）走 `fallback`（不是攻击，是"没给"）；给了不合法一律拒绝。
   * 返回 `{ ok:true, id }` 或 `{ ok:false }`（已写好响应）。
   */
  _sessionIdOr400(res, raw, fallback) {
    try {
      return { ok: true, id: assertSessionId(raw, { fallback }) };
    } catch (err) {
      this._sendError(res, 400, err.message, err.code || 'invalid_session_id');
      return { ok: false };
    }
  }

  /**
   * 会话级工作目录的**声明**（REST 入口）。
   *
   * 两个入口都收：
   *   · 请求体 `workspace`（`extra_body` 能发字段的客户端用）；
   *   · 请求头 `X-Tusunsun-Workspace`（OpenAI 兼容客户端一般不透传自定义请求体字段，
   *     `extra_headers` 是各家 SDK 都支持的形态）。
   * 缺省 = 不声明 ⇒ 沿用进程默认根。
   *
   * 失败**必须具名**：静默忽略会让用户以为在 projB 干活、文件却落在 projA。
   */
  async _declareWorkspace(req, data, sessionId) {
    // **每个**请求都要复核一次"这个会话的工作区现在可用吗"：绑定可能因目录被删/挂载丢失/策略收窄
    // 而在两次请求之间失效，必须在调模型、动文件之前具名拒绝。
    const usable = this._workspaceUsable(sessionId);
    if (!usable.ok) return usable;
    let raw = data?.workspace;
    if (raw === undefined || raw === null || raw === '') raw = req?.headers?.['x-tusunsun-workspace'];
    if (raw === undefined || raw === null || raw === '') return { ok: true, declared: false };
    if (Array.isArray(raw)) {
      return { ok: false, status: 400, code: 'invalid_workspace', message: 'workspace must be a single path (duplicate headers received)' };
    }
    const ws = this.core.getService('workspace');
    if (!ws) {
      return { ok: false, status: 501, code: 'workspace_unsupported', message: 'workspace service not loaded (scene without base-system?)' };
    }
    try {
      await ws.declare(sessionId, raw, { via: 'http', trusted: this._isLoopbackAddr(req?.socket?.remoteAddress) });
      return { ok: true, declared: true };
    } catch (err) {
      if (err?.contractError) {
        // 容量满 ⇒ 507（状态冲突）；绑定不可恢复 ⇒ 409（请求本身没错，是服务端那条绑定坏了）。
        const status = err.code === 'workspace_conflict' || err.code === 'workspace_binding_unavailable'
          ? 409 : err.code === 'workspace_capacity_exhausted' ? 507 : 400;
        return { ok: false, status, code: err.code || 'invalid_workspace', message: err.message };
      }
      this.core.log('error', `[Gateway] workspace declare failed: ${err?.message || err}`);
      return { ok: false, status: 500, code: 'workspace_error', message: String(err?.message || err) };
    }
  }

  /**
   * 工作区可用性复核（纯判定，无副作用）。绑定失效 ⇒ 409 + `workspace_binding_unavailable`。
   * 不抛：网关要把"拒绝"变成**具名响应**，而不是 500 或一段模型自述。
   */
  _workspaceUsable(sessionId) {
    const ws = this.core.getService('workspace');
    if (!ws || typeof ws.assertUsable !== 'function') return { ok: true };
    try {
      ws.assertUsable(sessionId);
      return { ok: true };
    } catch (err) {
      if (err?.contractError) {
        return { ok: false, status: 409, code: err.code || 'workspace_binding_unavailable', message: err.message };
      }
      this.core.log('error', `[Gateway] workspace check failed: ${err?.message || err}`);
      return { ok: true };   // 判定本身出错不改变既有行为（真正的拦截在工具入口）
    }
  }

  _auth(req) {
    const apiKey = this.core.getService('config')?.get('gateway.apiKey');
    if (!apiKey) return null;
    const header = req.headers['authorization'];
    if (!header) return 'Missing Authorization header';
    const parts = header.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') return 'Invalid Authorization format';
    if (!safeEqual(parts[1], apiKey)) return 'Invalid API key';
    return null;
  }

  /**
   * `/api/*` 统一入口守卫：返回 null 表示放行，否则已写好响应并返回状态码。
   * 顺序刻意如此：先判同源（跨源一律 403，**即使带了正确凭证**——凭证不该被跨站页面借道），
   * 再判凭证（401/403），最后要求写请求是 JSON（挡住无需预检的跨站简单请求）。
   */
  _guardControlPlane(req, res) {
    if (!this._sameOrigin(req)) {
      this._sendJson(res, 403, { error: 'cross-origin request rejected' });
      this._emitError(req, 403, 'cross-origin control-plane request rejected');
      return 403;
    }
    const apiKey = this.core.getService('config')?.get('gateway.apiKey');
    const authErr = this._controlAuth(req);
    if (authErr) {
      this._sendJson(res, 401, { error: authErr, hint: '控制面需要 Authorization: Bearer <gateway.apiKey>' });
      this._emitError(req, 401, authErr);
      return 401;
    }
    if (req.method === 'POST' && !/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
      this._sendJson(res, 415, { error: 'Content-Type must be application/json' });
      return 415;
    }
    if (!apiKey) {
      // 无凭证 = 仅限本机自用。回环之外的部署在启动期已被拒绝（见 _startListening），
      // 这里再判一次请求的来源地址，防止"配置成回环、由代理转发进来"的意外暴露。
      const remote = req.socket?.remoteAddress || '';
      if (!this._isLoopbackHost(remote)) {
        this._sendJson(res, 403, { error: 'control plane is loopback-only when gateway.apiKey is unset' });
        this._emitError(req, 403, 'control plane refused non-loopback client');
        return 403;
      }
    }
    return null;
  }

  _sendJson(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  // OpenAI 兼容端点的错误体是**对象**：
  //   {"error":{"message":"…","type":"invalid_request_error","param":null,"code":null}}
  // 非流式与流式必须同形：客户端 SDK 读 `error.message`，字符串形状会让它只能报无信息的失败。
  _sendError(res, status, message, code = null) {
    this._sendJson(res, status, {
      error: {
        message: String(message ?? ''),
        type: status >= 500 ? 'api_error' : 'invalid_request_error',
        param: null,
        code: code ?? null,
      },
    });
  }

  _collectBody(req, res, maxBytes = 10 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      let body = ''
      req.on('data', chunk => {
        body += chunk
        if (body.length > maxBytes) {
          res.writeHead(413, { 'content-type': 'application/json' })
          // 同一条 OpenAI 兼容链路，错误体一律走规范对象形状
          res.end(JSON.stringify({ error: { message: 'request too large', type: 'invalid_request_error', param: null, code: 'request_too_large' } }))
          req.destroy()
          reject(new Error('request body too large'))
        }
      })
      req.on('end', () => resolve(body))
      req.on('error', reject)
    })
  }

  _emitError(req, status, error) {
    this.core.emitFast('http.error', {
      method: req.method, url: req.url, statusCode: status, error,
      timestamp: Date.now(), sourcePlugin: 'gateway',
    });
  }

  async start() {
    const { createServer } = await import('node:http');
    this.httpServer = createServer((req, res) => this._handleHttpRequest(req, res));
    this.httpServer.maxConnections = 500;
    this.httpServer.on('upgrade', (req, socket, head) => this._handleWsUpgrade(req, socket, head));
    await this._startListening();
    // 不在 `start()` 里判定有没有对话能力：本插件通常早于 haotian-lite 启动，此刻
    // `chat.handle` 还没注册。启动期的判断放在装配完成之后（cli 的 cmdStart），
    // 请求期的判断在那三条 503/health 分支里。
  }

  // 无对话能力时的**可操作**文案（现状 + 原因 + 下一步），三条入口共用一份，避免两套话术。
  _missingChatMessage() {
    const profile = readEnv('PROFILE') || 'development';
    const scene = this.core.getService('config')?.get('activeScene') || '(none)';
    return `no chat capability: 'chat.handle' has no provider `
      + `(profile=${profile}, plugins=${this.core.plugins?.size ?? 0}, config.activeScene=${scene}). `
      + '本次装配没有对话插件（model / haotian-lite）；请改用含对话能力的场景启动，'
      + '例如 `tusunsun start --scene gateway`（生产档默认锁 base-system，需显式 --scene）。';
  }

  /** 就绪度不足时的**可操作**说明（哪一层缺什么、下一步怎么做）。 */
  _readinessMessage(missing) {
    if (missing.includes('chat.handle')) return this._missingChatMessage();
    if (missing.includes('model.apiKey')) {
      const baseUrl = this.core.getService('config')?.get('model.baseUrl') || '(未设置)';
      return 'model.apiKey 未配置：网关能启动但对话必然 502。'
        + `当前端点 ${baseUrl} 不在回环地址上，需要凭证。`
        + '设置 `TUSUNSUN_API_KEY`（或 `tusunsun config set model.apiKey <key>`）；'
        + '若端点本身免 key（本地 ollama/llama.cpp），请把 model.baseUrl 指向 127.0.0.1。';
    }
    return `缺少：${missing.join(', ')}`;
  }

  // readiness 分层。
  //   L1 `/health` —— 进程活着（恒 200）。
  //   L2 `/ready`  —— **本地**具备"能真的对话"的条件：有 chat 能力 + 有可用的模型配置。
  // 只查 `chat.handle` 会让没配模型的实例也报 ready:true，接 LB 的部署不会摘流量。
  // L3（真连一次上游）刻意不做：每次探针都调计费模型不可接受，需要时由使用者自行探活。
  _modelReady() {
    const cfg = this.core.getService('config');
    const apiKey = cfg?.get('model.apiKey') || readEnv('API_KEY') || process.env.LLM_API_KEY;
    if (apiKey) return { ok: true };
    // 本地端点免 key 的部署（ollama / llama.cpp / 本地 mock）算就绪：
    // `model-openai.js` 用同一判据，并在这种情况下真的不带 Authorization 发请求。
    const baseUrl = cfg?.get('model.baseUrl') || '';
    if (isKeylessEndpoint(baseUrl, apiKey)) return { ok: true, keyless: true };
    return { ok: false, reason: 'model.apiKey' };
  }

  async _readinessMissing() {
    const missing = [];
    if (!(await this.core.hasCapability('chat.handle'))) missing.push('chat.handle');
    else if (!this._modelReady().ok) missing.push('model.apiKey');
    return missing;
  }

  async _handleHttpRequest(req, res) {
    if (!this._cors(req, res)) { this._sendJson(res, 403, { error: 'CORS origin not allowed' }); return; }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const pathname = pathnameOf(req);   // 路由只看路径（见 pathnameOf）
    if (req.method === 'POST' && pathname === '/ming/push') {
      await this._handleMingPush(req, res); return;
    }
    if (pathname === '/health' || pathname === '/ready') {
      // 健康检查不能只说"进程活着"：status 只在"能干活"时为 ok，缺能力时降级为 degraded
      // 并列出缺了什么（字段是加法，老客户端读 status 仍安全）。
      //
      // `/health` 与 `/ready` 分开，各管一件事（k8s 的 liveness/readiness 分工）：
      //   `/health` 恒 200 —— 进程还在服务、事件循环没死。判"活着"用它可以，判"能干活"不行。
      //   `/ready`  缺条件时 503 —— 负载均衡/编排器据此摘流量。
      const missing = await this._readinessMissing();
      const body = {
        status: missing.length ? 'degraded' : 'ok',
        uptime: this.core.status().uptime,
        plugins: this.core.plugins?.size ?? 0,
        ...(missing.length ? { missing } : {}),
        // 把执行器的**安全判据读数**放到健康面上：`hook_errors` 回答"有没有哪次调用是
        // **判据坏了**被拦下的，而不是策略拒绝"。两者都表现为"调用被拦"，但前者意味着
        // **所有 Cell 都在没有保护地运行**；非 0 即需要人看。
        // 这里只放**计数**，不放任何入参/命令/路径 —— 健康面默认无鉴权，不得泄露内容。
        security: (() => {
          try {
            const ex = this.core.getService?.('tool-executor');
            return typeof ex?.getSecurityStats === 'function' ? ex.getSecurityStats() : null;
          } catch { return null; }
        })(),
      };
      if (pathname === '/health') { this._sendJson(res, 200, body); return; }
      this._sendJson(res, missing.length ? 503 : 200, {
        ready: missing.length === 0, ...body,
        ...(missing.length ? { error: this._readinessMessage(missing) } : {}),
      });
      return;
    }
    // **同源判定的位置就是它的覆盖面**（专家 S9）。修前它只挂在 `/api/*` 上，
    // 于是 `/v1/chat/completions` 与 `/ming/push` 从来没过它：默认无 apiKey 部署下，任意网页
    // `fetch` 就能触发一次真实 chat（写文件、跑命令、烧额度）——响应因缺 CORS 头读不到，
    // 但**读不到不等于没发生**。健康面放行：它不含业务副作用。
    if (!pathname.startsWith('/api/') && pathname !== '/health' && pathname !== '/ready'
      && !this._sameOrigin(req)) {
      this._sendJson(res, 403, { error: 'cross-origin request rejected' });
      this._emitError(req, 403, 'cross-origin request rejected');
      return;
    }
    if (pathname.startsWith('/api/')) {
      const refused = this._guardControlPlane(req, res);
      if (refused) return;
    }
    if (pathname === '/v1/chat/completions' && req.method === 'POST') {
      if (!this._limiter.take()) {
        this._sendError(res, 429, 'rate limit exceeded', 'rate_limit_exceeded');
        this._emitError(req, 429, 'rate limit exceeded'); return;
      }
      const authErr = this._auth(req);
      if (authErr) { this._sendError(res, 401, authErr, 'invalid_api_key'); this._emitError(req, 401, authErr); return; }
      await this._handleOpenAIChat(req, res); return;
    }

    const handler = this.handlers.get(`${req.method}:${pathname}`);
    if (handler) {
      try { await handler(req, res); }
      catch (err) {
        this._sendJson(res, 500, { error: err.message });
        this.core.log('error', `Handler ${req.url}: ${err.message}`);
        this._emitError(req, 500, err.message);
      }
      return;
    }

    if (typeof this.core.getData('_lazyHook') === 'function') {
      await this.core.getData('_lazyHook')('route.' + pathname);
      const retry = this.handlers.get(`${req.method}:${pathname}`);
      if (retry) {
        try { await retry(req, res); } catch (err) {
          this._sendJson(res, 500, { error: err.message });
          this.core.log('error', `Handler ${req.url}: ${err.message}`);
          this._emitError(req, 500, err.message);
        }
        return;
      }
    }
    this._sendJson(res, 404, { error: 'Not found' });
    this._emitError(req, 404, 'Not found');
  }

  /**
   * WS 升级口令来源：优先 `Sec-WebSocket-Protocol` 里的子协议
   * （`tusunsun.v1` 声明协议版本，`tusunsun.token.<base64url(key)>` 携带口令，走请求头不进 URL）；
   * `?token=` 仍兼容老客户端。
   */
  _wsToken(req) {
    const proto = String(req.headers['sec-websocket-protocol'] || '');
    const parts = proto.split(',').map((s) => s.trim()).filter(Boolean);
    const tagged = parts.find((p) => p.startsWith('tusunsun.token.'));
    if (tagged) {
      const raw = tagged.slice('tusunsun.token.'.length);
      try { return Buffer.from(raw, 'base64url').toString('utf8'); } catch { return raw; }
    }
    return new URL(req.url, 'http://localhost').searchParams.get('token');
  }

  _wsProtocols(req) {
    const proto = String(req.headers['sec-websocket-protocol'] || '');
    return proto.split(',').map((s) => s.trim()).filter(Boolean);
  }

  async _handleWsUpgrade(req, socket, head) {
    if (!pathnameOf(req).startsWith('/ws')) { socket.end(); return; }
    // 浏览器发起的跨站 WebSocket 不受同源策略限制，所以升级请求与 `/api/*` 同门：
    // Origin 必须与可信 Host 同源；无 Origin 的非浏览器客户端（CLI/curl）放行。
    // 判在口令之前：被拒的跨站请求不进入口令比较，也不创建连接。
    if (!this._sameOrigin(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.end();
      this._emitError(req, 403, 'cross-origin websocket upgrade rejected');
      return;
    }
    const apiKey = this.core.getService('config')?.get('gateway.apiKey');
    if (apiKey) {
      if (!safeEqual(this._wsToken(req), apiKey)) { socket.end(); return; }
    }
    if (!this.wsServer) {
      // ws 随仓内置（vendor/ws，npm 发布物原样复制），发布物零安装依赖、断网可装；
      // 完整性由 scripts/verify-vendor.mjs 逐文件 sha256 校验。
      const { WebSocketServer } = await import('../vendor/ws/wrapper.mjs');
      this.wsServer = new WebSocketServer({
        noServer: true,
        // 客户端声明了子协议就必须回选一个，否则浏览器按规范断开连接。
        handleProtocols: (protocols) => (protocols.has('tusunsun.v1') ? 'tusunsun.v1' : false),
      });
      // 服务级与连接级的 `error` 都必须有监听者：EventEmitter 无监听者即抛，
      // 而这里抛出的会经 cli.js 的 uncaughtException 杀掉整个网关（专家 S8）。
      this.wsServer.on('error', (err) => this.core.log('error', `WS server error: ${err?.message || err}`));
      this.wsServer.on('connection', (conn, req) => {
        const id = `conn_${++this.requestId}`;
        this.clients.set(id, conn);
        // WS 上的"工作目录声明"按**连接来源**判本机/远端（不采信请求里自报的身份）
        conn._wsPeer = req?.socket?.remoteAddress || '';
        conn._wsAuthd = true;
        this.core.log('info', `WS connected: ${id}`);
        conn.on('message', (raw) => this._handleMessage(id, raw.toString(), conn));
        conn.on('close', () => { this.clients.delete(id); this.core.log('info', `WS disconnected: ${id}`); });
        // **一个畸形帧不得杀掉整个网关**（专家 S8）。修前实测：握手后发一个 RSV1 置位的
        // 3 字节帧，vendor/ws 的 `emit('error')` 无人接 ⇒ 未捕获异常 ⇒ 进程退出，
        // 配了 apiKey 也一样（任何已认证客户端都能杀服务）。关闭交给 ws 自己，这里只摘广播表。
        conn.on('error', (err) => {
          this.clients.delete(id);
          this.core.log('error', `WS ${id} error: ${err?.message || err}`);
        });
      });
    }
    this.wsServer.handleUpgrade(req, socket, head, (conn) => { this.wsServer.emit('connection', conn, req); });
  }

  async _startListening() {
    const cfg = this.core.getService('config');
    const host = cfg?.get('gateway.host') || '127.0.0.1';
    const apiKey = cfg?.get('gateway.apiKey');
    // 默认只听回环；要对外必须**显式** opt-in（配置或 env）且配了凭证，
    // 否则同一局域网内任何机器都能改配置、白用模型额度。
    const allowRemote = cfg?.get('gateway.allowRemote') === true || readEnv('ALLOW_REMOTE') === '1';
    if (!this._isLoopbackHost(host)) {
      if (!allowRemote) {
        throw new Error(`Gateway refuses to bind ${host}: 非回环地址需要显式 opt-in`
          + '（配置 gateway.allowRemote: true 或环境变量 TUSUNSUN_ALLOW_REMOTE=1）。'
          + '默认只监听 127.0.0.1。');
      }
      if (!apiKey) {
        throw new Error(`Gateway refuses to bind ${host}: 对外监听必须配置 gateway.apiKey`
          + '（否则管理面/模型额度对全网开放）。设置 TUSUNSUN_GATEWAY_KEY 或 '
          + '`tusunsun config set gateway.apiKey <key>`。');
      }
    }
    // `??` 而非 `||`：`port: 0` 是"随机可用端口"的合法意图，不能被真值判断吞成 9002。
    const port = cfg?.get('gateway.port') ?? 9002;
    return new Promise((resolve, reject) => {
      // listen 失败必须有 'error' 监听并具名拒绝：端口被占时抛出未捕获 'error'
      // 会让整个进程崩溃，而不是"某个用例失败"。
      const onError = (err) => {
        this.httpServer.removeListener('listening', onListening);
        reject(new Error(`Gateway listen failed on ${host}:${port}: ${err.code || err.message}`));
      };
      const onListening = () => {
        this.httpServer.removeListener('error', onError);
        // 真实绑定端口（`--port 0` 时内核分配，日志必须报实际值而不是 0）
        const actual = this.httpServer.address()?.port ?? port;
        const lanIp = this._getLanIp();
        this.core.log('info', `Gateway v${this.version} listening on ${host}:${actual}`);
        // 只有**真的**对外监听时才宣传局域网地址；控制面鉴权状态必须写在启动日志里。
        if (lanIp && !this._isLoopbackHost(host)) this.core.log('info', `  LAN:    http://${lanIp}:${actual}/`);
        if (lanIp && !this._isLoopbackHost(host)) {
          this.core.log('warn', `  对外监听已开启（gateway.allowRemote）；控制面鉴权：${apiKey ? '已启用（Bearer）' : '未启用'}`);
        } else {
          this.core.log('info', `  Control: 仅回环可访问（${apiKey ? 'Bearer 鉴权已启用' : '未设置 gateway.apiKey'}）`);
        }
        this.core.log('info', `  WS:     ws://localhost:${actual}/ws`);
        this.core.log('info', `  Health: http://localhost:${actual}/health`);
        this.core.log('info', `  Ready:  http://localhost:${actual}/ready`);
        this.core.log('info', `  OpenAI: http://localhost:${actual}/v1/chat/completions`);
        // 在"服务已就绪"的位置把两件**默认事实**说清楚：文件工具的基准目录
        // （~/.tusunsun/workspace，全局共享）与模型端点。用 core.log ⇒ 复用脱敏
        // （baseUrl 可能带 key），机器模式下自动成为一条 JSONL。
        const workDir = this.core.getData('agent.workDir') || this.core.get('agent.workDir') || '(未设置)';
        this.core.log('info', `  Work dir: ${workDir}（会话默认基准；不是沙箱，绝对路径不受限）`);
        this.core.log('info', `  Model: ${this.core.get('model.model') || '(默认)'} @ ${this.core.get('model.baseUrl') || '(默认)'}`);
        resolve();
      };
      this.httpServer.once('error', onError);
      this.httpServer.once('listening', onListening);
      this.httpServer.listen(port, host);
    });
  }

  _handleMessage(connId, raw, conn) {
    let msg;
    try { msg = JSON.parse(raw); } catch (err) { this.core?.log?.('warn', '[Gateway] Failed to parse WS message: ' + (err?.message || 'unknown')); return; }

    if (msg.type === 'req') {
      const apiKey = this.core.getService('config')?.get('gateway.apiKey');
      if (apiKey && !conn._wsAuthd) {
        if (safeEqual(msg.token, apiKey)) {
          conn._wsAuthd = true;
        } else {
          if (conn && conn.readyState === 1) {
            conn.send(JSON.stringify({ type: 'res', id: msg.id, ok: false, error: 'Unauthorized' }));
          }
          return;
        }
      }
      this._handleRequest(connId, msg);
    }
  }

  // `core.command()` 默认 30s，多步 agent 循环 + 推理模型单轮常超时；对话超时须按会话级预算给足，
  // 且可由配置覆盖——否则会出现"报超时但工具副作用还在继续跑"。
  _chatTimeoutMs(floorMs = 0) {
    const cfg = this.core.get('gateway.chatTimeoutMs');
    let base = 600000; // 10 分钟：足够多步工具循环，又不至于挂死
    if (Number.isFinite(cfg) && cfg > 0) base = cfg;
    else {
      const env = Number(readEnv('CHAT_TIMEOUT_MS'));
      if (Number.isFinite(env) && env > 0) base = env;
    }
    // `budget.wall_ms` 必须**先于**传输层超时到达：否则调用方拿到的是 `timeout_no_abort`
    // （命令超时、底层还在跑），而不是 `budget_exhausted` —— 两件完全不同的事。
    return Math.max(base, Number.isFinite(floorMs) ? floorMs : 0);
  }

  async _handleRequest(connId, msg) {
    const { id, method, params } = msg;
    let result;

    try {
      // WS 侧同一道门：`agent.chat` 等命令的 `params.sessionId` 会一路走到会话持久化，非法即 ok:false，不执行命令。
      if (params && typeof params === 'object' && params.sessionId !== undefined) {
        try { params.sessionId = assertSessionId(params.sessionId); }
        catch (err) {
          const badConn = this.clients.get(connId);
          if (badConn && badConn.readyState === 1) {
            badConn.send(JSON.stringify({ type: 'res', id, ok: false, error: err.message, code: err.code || 'invalid_session_id' }));
          }
          return;
        }
      }

      // WS 入口的会话级工作目录声明：与 REST 同一套校验、同一套 code，合法性在**执行命令之前**判完。
      if (params && typeof params === 'object' && params.workspace !== undefined && params.workspace !== null && params.workspace !== '') {
        const badConn = this.clients.get(connId);
        const ws = this.core.getService('workspace');
        try {
          if (!ws) throw Object.assign(new Error('workspace service not loaded (scene without base-system?)'), { code: 'workspace_unsupported' });
          params.sessionId = assertSessionId(params.sessionId);
          await ws.declare(params.sessionId, params.workspace, {
            via: 'ws', trusted: this._isLoopbackAddr(badConn?._wsPeer),
          });
        } catch (err) {
          if (badConn && badConn.readyState === 1) {
            badConn.send(JSON.stringify({ type: 'res', id, ok: false, error: err.message, code: err.code || 'invalid_workspace' }));
          }
          return;
        }
      }

      if (method === 'workspace.declare') {
        // "先声明、再对话"的入口（`tusunsun chat --dir` 用它把非法目录挡在进入对话之前）；返回实际生效的目录。
        const cws = this.core.getService('workspace');
        if (!cws) {
          result = { ok: false, code: 'workspace_unsupported', error: 'workspace service not loaded (scene without base-system?)' };
        } else {
          try {
            const sid = assertSessionId(params?.sessionId, { fallback: 'rest_api' });
            const rec = await cws.declare(sid, params?.workspace, {
              via: 'ws', trusted: this._isLoopbackAddr(this.clients.get(connId)?._wsPeer),
            });
            result = { ok: true, payload: { sessionId: rec.sessionId, workspace: rec.real } };
          } catch (err) {
            result = { ok: false, code: err.code || 'invalid_workspace', error: err.message };
          }
        }
      } else if (method === 'workspace.release') {
        // 显式解绑（`tusunsun workspace release`）：在跑时拒绝，否则后面的工具调用会落到默认根。
        const cws = this.core.getService('workspace');
        if (!cws?.release) {
          result = { ok: false, code: 'workspace_unsupported', error: 'workspace service not loaded (scene without base-system?)' };
        } else {
          try {
            const sid = assertSessionId(params?.sessionId);
            result = { ok: true, payload: await cws.release(sid, { via: 'ws', force: params?.force === true }) };
          } catch (err) {
            result = { ok: false, code: err.code || 'invalid_session_id', error: err.message };
          }
        }
      } else if (method === 'workspace.status') {
        // 诊断入口：回答"以后这个会话还能不能干活"，而不是让调用方从一次失败里猜。
        const cws = this.core.getService('workspace');
        if (!cws?.status) {
          result = { ok: false, code: 'workspace_unsupported', error: 'workspace service not loaded' };
        } else if (!cws.status()) {
          result = { ok: false, code: 'workspace_unsupported', error: 'workspace service not loaded' };
        } else {
          try {
            const sid = assertSessionId(params?.sessionId, { fallback: 'rest_api' });
            const rec = cws.status(sid);
            result = { ok: true, payload: { sessionId: sid, state: rec, root: (() => { try { return cws.root(sid); } catch { return null; } })() } };
          } catch (err) {
            result = { ok: false, code: err.code || 'invalid_session_id', error: err.message };
          }
        }
      } else if (method.startsWith('cell.')) {
        // Cell 控制面：**不在这里实现任何 Cell 语义**，全部转给 `cell-runtime` 服务
        // （合同校验/能力交集/生命周期只有一份实现）。
        // 未装配（场景不是 `cell`）时具名 501 语义，而不是"命令不存在"。
        const cr = this.core.getService('cell-runtime');
        if (!cr) {
          result = { ok: false, code: 'cell_unsupported', error: 'cell-runtime service not loaded（用 --scene cell 启动）' };
        } else {
          try {
            switch (method) {
              case 'cell.create':
                result = { ok: true, payload: await cr.create(params?.spec, { trusted: this._isLoopbackAddr(this.clients.get(connId)?._wsPeer) }) };
                break;
              case 'cell.accept':
                result = { ok: true, payload: cr.accept(params?.cellId, params?.task) };
                break;
              case 'cell.execute':
                result = { ok: true, payload: await cr.execute(params?.cellId, params?.task) };
                break;
              case 'cell.verify':
                result = { ok: true, payload: await cr.verify(params?.cellId, params?.task) };
                break;
              case 'cell.report':
                result = { ok: true, payload: cr.report(params?.cellId) };
                break;
              case 'cell.close':
                result = { ok: true, payload: await cr.close(params?.cellId, { force: params?.force === true }) };
                break;
              case 'cell.describe':
                result = { ok: true, payload: cr.describe(params?.cellId) };
                break;
              case 'cell.list':
                result = { ok: true, payload: cr.list() };
                break;
              // Cell 认知配置的三个端点。
              // `bind` 是**宿主动作**（它决定这个 Cell 以什么身份工作），因此只允许回环调用 ——
              // 与 `cell.create` 用同一条 `_isLoopbackAddr` 判据：远端能改 profile 等于远端能改身份。
              case 'cell.context.bind': {
                if (!this._isLoopbackAddr(this.clients.get(connId)?._wsPeer)) {
                  result = { ok: false, code: 'profile_bind_local_only', error: 'cell.context.bind is a host action; only loopback callers may bind a context profile' };
                  break;
                }
                const cc = this.core.getService('cell-context');
                if (!cc) { result = { ok: false, code: 'cell_unsupported', error: 'cell-context service not loaded（用 --scene cell 启动）' }; break; }
                result = { ok: true, payload: await cc.bind(params?.cellId, { profileId: params?.profileId, expectedVersion: params?.expectedVersion }) };
                break;
              }
              case 'cell.context.binding': {
                const cc = this.core.getService('cell-context');
                if (!cc) { result = { ok: false, code: 'cell_unsupported', error: 'cell-context service not loaded' }; break; }
                const b = await cc.loadBinding(params?.cellId);
                result = b
                  ? { ok: true, payload: b }
                  : { ok: false, code: 'no_binding', error: `cell "${params?.cellId}" has no context profile bound` };
                break;
              }
              // 主动求教：**经 ToolExecutor** 走与模型完全相同的那条链路（能力门/预算/撤销都在里面）。
              // 这里不直接调 experience-port.read —— 那会绕开执行资格，而计划明确要求
              // "认知调用同样服从执行资格"。
              case 'cell.context.experience': {
                const exec = this.core.getService('tool-executor');
                if (!exec?.executeOne) {
                  result = { ok: false, code: 'cell_unsupported', error: 'tool-executor not loaded' };
                  break;
                }
                const cellId = params?.cellId;
                const cr = this.core.getService('cell-runtime');
                const rec = cellId ? cr?.describe(cellId) : null;
                if (!rec) { result = { ok: false, code: 'unknown_cell', error: `unknown cell: ${cellId}` }; break; }
                const sid = `cell-${rec.cell_id}`;
                // rc.31：派发必须有**任务票据**。主动求教仍服从执行资格（它的设计初衷），
                // 所以这里不绕开判据，而是带上**当前任务**的票据 —— 票据由 cell-runtime
                // 从自己的登记记录构造，网关不能选择“用哪个任务”。
                // 没有活跃任务时如实拒绝：任务之外的认知调用没有可继承的授权，
                // 让它以“以前能调”为理由继续存在，就是把同一个洞换个入口。
                if (typeof cr?.runInActiveTask !== 'function') {
                  result = { ok: false, code: 'cell_unsupported', error: 'cell-runtime cannot issue a task execution credential' };
                  break;
                }
                const scoped = cr.runInActiveTask(sid, async () => exec.executeOne(
                  'tool-experience-pull',
                  { ref: params?.ref, focus: params?.focus, _sessionId: sid },
                  sid, sid));
                if (!scoped.ok) { result = { ok: false, code: scoped.code, error: scoped.reason }; break; }
                const r = await scoped.value;
                if (r?.error) { result = { ok: false, code: r.diagnostic?.code || 'experience_error', error: r.error }; break; }
                try { result = { ok: true, payload: JSON.parse(r.result) }; }
                catch { result = { ok: true, payload: r.result }; }
                break;
              }
              case 'cell.context.receipts': {
                const cc = this.core.getService('cell-context');
                if (!cc) { result = { ok: false, code: 'cell_unsupported', error: 'cell-context service not loaded' }; break; }
                result = { ok: true, payload: await cc.readReceipts(params?.cellId, params?.limit ?? 20) };
                break;
              }
              default:
                result = { ok: false, code: 'unknown_method', error: `unknown cell method: ${method}` };
            }
          } catch (err) {
            // 合同错误原样带 code 回去：调用方据此判断"是任务不合法"还是"Cell 状态不对"
            result = { ok: false, code: err.code || 'cell_error', error: err.message, contractError: !!err.contractError };
          }
        }
      } else if (method === 'core.status') {
        // 应答里带上**身份**（pid / stateDir / port），CLI 才能判断"回答我的这个网关"是不是它要找的那个。
        result = { ok: true, payload: { ...this.core.status(), pid: process.pid, stateDir: this.core.stateDir, port: this.port } };
      } else if (method === 'core.stop') {
        const conn = this.clients.get(connId);
        if (conn && conn.readyState === 1) {
          conn.send(JSON.stringify({ type: 'res', id, ok: true, payload: {} }));
        }
        this.core.log('info', 'Stop command received from client');
        setTimeout(async () => {
          // 本内核没有 `shutdown` 方法：可选链只会让这行静默成空操作，紧接着 process.exit(0)
          // ⇒ 所有插件 stop() 一次都不会被调用。走 core.stop()（CLI 信号路径用的是同一个）。
          try { await this.core.stop?.(); } catch (e) { this.core.log('error', `[gateway] stop failed: ${e.message}`); }
          process.exit(0);
        }, 500);
        return;
      } else if (method === 'agent.chat') {
        if (!(await this.core.hasCapability('chat.handle'))) {
          result = { ok: false, error: this._missingChatMessage() };
        } else if (params?.stream) {
          await this._handleStreamingChat(connId, id, params);
          return;
        } else {
          const doneWithWorkspace = this._retainWorkspace(params?.sessionId);
          try {
            result = await this.core.command('chat.handle', params, this._chatTimeoutMs());
          } finally {
            doneWithWorkspace();
          }
        }
      } else {
        const raw = await this.core.command(method, params);
        result = raw && typeof raw === 'object' && 'ok' in raw ? raw : { ok: true, payload: raw };
      }
    } catch (err) {
      result = { ok: false, error: err.message };
    }

    const conn = this.clients.get(connId);
    if (conn && conn.readyState === 1) {
      conn.send(JSON.stringify({ type: 'res', id, ...result }));
    }
  }

  async _handleStreamingChat(connId, id, params) {
    const conn = this.clients.get(connId);
    const result = await this.core.command('chat.handle', {
      ...params, stream: true,
      onChunk: (content) => {
        if (conn && conn.readyState === 1) {
          conn.send(JSON.stringify({ type: 'stream_chunk', id, content }));
        }
      },
    }, this._chatTimeoutMs());
    if (conn && conn.readyState === 1) {
      conn.send(JSON.stringify({ type: 'res', id, ...result }));
    }
  }

  async _handleOpenAIChat(req, res) {
    // **无 provider 必须快速拒绝**，不能"发一条 chat.handle 事件然后等超时"：
    // 否则 /health 说 ok、readiness 说 READY，而本端点 60s 内**零字节**，命令超时后还会回 HTTP 200 + 空正文。
    if (!(await this.core.hasCapability('chat.handle'))) {
      const msg = this._missingChatMessage();
      this._sendError(res, 503, msg, 'chat_unavailable');
      this._emitError(req, 503, msg);
      return;
    }
    let body
    try { body = await this._collectBody(req, res) }
    catch (err) { this.core?.log?.('warn', '[Gateway] Failed to collect body (OpenAI chat): ' + (err?.message || 'unknown')); return }

    let data
    try { data = JSON.parse(body) }
    catch (err) { this._sendError(res, 400, 'invalid json'); return }

    const lastMsg = data.messages?.at(-1)
    if (!lastMsg?.content) {
      this._sendError(res, 400, 'missing messages')
      this._emitError(req, 400, 'missing messages')
      return
    }

    // 会话标识在**进入业务之前**判完：非法即 400 + 具名 code，既不落盘也不触发模型请求。
    // 缺省（undefined / null / 空串）按"没给"处理 ⇒ 落到 `rest_api`；显式给了但**不合法**
    // （含分隔符、`..`、控制字符、超长、非字符串）一律 400。把缺省也判 400 会让所有不传
    // session_id 的客户端（OpenAI SDK 默认行为）直接断掉。
    const rawSid = data.session_id
    const sid = this._sessionIdOr400(res, (rawSid === undefined || rawSid === null || rawSid === '') ? undefined : rawSid, 'rest_api')
    if (!sid.ok) { this._emitError(req, 400, 'invalid session_id'); return }

    // 会话级工作目录：声明失败**必须**具名拒绝，不能静默忽略后让文件落到另一个目录。
    const decl = await this._declareWorkspace(req, data, sid.id)
    if (!decl.ok) {
      this._sendError(res, decl.status, decl.message, decl.code)
      this._emitError(req, decl.status, `workspace: ${decl.message}`)
      return
    }

    if (data.stream) {
      await this._handleStreamingChatCompletion(req, res, data, lastMsg, sid.id)
    } else {
      await this._handleNonStreamingChatCompletion(req, res, data, lastMsg, sid.id)
    }
  }

  /**
   * 把"这个会话正在干活"告诉 workspace 服务：网关的 `/v1/chat/completions` 与 WS `agent.chat`
   * 是绝大多数真实流量，不 retain 的话 `workspace.release` 的 `workspace_busy` 保护对普通对话无效。
   *
   * 返回的函数是幂等的（`workspace.retain` 自己保证），调用方在 `finally` 里调一次即可。
   */
  _retainWorkspace(sessionId) {
    try {
      const ws = this.core.getService?.('workspace');
      const release = ws?.retain?.(sessionId);
      return typeof release === 'function' ? release : () => {};
    } catch { return () => {}; }
  }

  async _handleStreamingChatCompletion(req, res, data, lastMsg, sessionId) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive',
    })
    const doneWithWorkspace = this._retainWorkspace(sessionId)
    try {
      const cmdResult = await this.core.command('chat.handle', {
        message: lastMsg.content, sessionId, stream: true,
        ...this._sessionParams(data),
        onChunk: (chunk) => {
          const delta = {}
          if (typeof chunk === 'string') delta.content = chunk
          else if (chunk?.reasoning) delta.reasoning_content = chunk.reasoning
          else if (chunk?.content) delta.content = chunk.content
          res.write(`data: ${JSON.stringify({ choices: [{ delta, index: 0 }] })}\n\n`)
        },
      }, this._chatTimeoutMs(this._budgetFloorMs(data)))
      // 流式路径同样要把"模型层失败"标出来：正文可能已经流出去一部分，不能改状态码，
      // 但必须发一条机器可判的 error 事件。
      if (!cmdResult?.ok || cmdResult.payload?.error) {
        const msg = cmdResult?.payload?.reply || cmdResult?.error || 'chat command failed'
        // 流式已发出 200 头，改不了状态码；至少把**契约拒绝**与模型故障分开，
        // 客户端据 code 判定是自己输入错还是上游挂了。
        const contract = this._isContractCode(cmdResult?.code)
        this._emitError(req, contract ? 400 : 502, msg)
        res.write(`data: ${JSON.stringify({ error: { message: msg, type: contract ? 'invalid_request_error' : 'api_error', param: null, code: cmdResult?.code || 'model_error' } })}\n\n`)
      } else if (cmdResult?.payload?.usage || cmdResult?.payload?.tokenUsage) {
        // `usage` 必须走 OpenAI 的 token 形状；上下文预算是另一码事，单独用 `context` 事件发给控制台。
        // 上游没报 token 用量时**不发** usage 块，也不拿预算冒充。
        const u = cmdResult.payload.usage
        if (u) res.write(`data: ${JSON.stringify({ choices: [], usage: u })}\n\n`)
        if (cmdResult.payload.tokenUsage) {
          res.write(`data: ${JSON.stringify({ type: 'token_usage', ...cmdResult.payload.tokenUsage })}\n\n`)
        }
      }
    } catch (err) {
      this._emitError(req, 500, err.message)
      res.write(`data: ${JSON.stringify({ error: { message: err.message, type: 'api_error', param: null, code: 'stream_error' } })}\n\n`)
    } finally {
      doneWithWorkspace()
    }
    res.write('data: [DONE]\n\n')
    res.end()
  }

  async _handleNonStreamingChatCompletion(req, res, data, lastMsg, sessionId) {
    const doneWithWorkspace = this._retainWorkspace(sessionId)
    try {
      const result = await this.core.command('chat.handle', {
        message: lastMsg.content, sessionId,
        ...this._sessionParams(data),
      }, this._chatTimeoutMs(this._budgetFloorMs(data)))
      // 失败不许伪装成成功：命令超时 / 模型报错必须按语义分派状态码，不能落到下面的 200 分支。
      if (!result?.ok) {
        const msg = result?.error || 'chat command failed'
        // **调用方输入非法**不是网关故障，更不是超时：400 与 504 在监控上完全不同。
        if (this._isContractCode(result?.code)) {
          this._sendError(res, 400, msg, result.code)
          this._emitError(req, 400, msg)
          return
        }
        this._sendError(res, 504, msg, result?.code || 'chat_timeout')
        this._emitError(req, 504, msg)
        return
      }
      if (result.payload?.error) {
        const msg = result.payload.reply || 'model error'
        this._sendError(res, 502, msg, 'model_error')
        this._emitError(req, 502, msg)
        return
      }
      this._sendJson(res, 200, {
        id: `chat_${Date.now()}`, object: 'chat.completion', created: Date.now(),
        model: this.core.getService('config')?.get('model.model') || 'unknown',
        choices: [{ index: 0, message: { role: 'assistant', content: result.payload?.reply || '' }, finish_reason: 'stop' }],
        // `usage` 是 OpenAI 的 token 形状；上下文预算另立 `tusunsun_context`，上游没报用量就**不出** usage 字段。
        ...(result.payload?.usage ? { usage: result.payload.usage } : {}),
        // 终态（取消 / 预算耗尽）走 200 + 具名字段：它**不是**模型错误，也不是 HTTP 错误。
        // `finish_reason` 保持 `stop`，以免只认 OpenAI 枚举的客户端把一条正常响应判成异常。
        ...(result.payload?.state ? { tusunsun_state: result.payload.state, tusunsun_code: result.payload.code } : {}),
        ...(result.payload?.tokenUsage ? { tusunsun_context: result.payload.tokenUsage } : {}),
        // 把**实际生效**的工作目录回给调用方：真值来自 workspace 服务，不是把请求里的字符串原样回显。
        ...(() => {
          // `root()` 在"绑定不可用"时会抛；这里只是回显，不该把一条已经成功的对话变成 500。
          try {
            const root = this.core.getService('workspace')?.root(sessionId)
            return root ? { tusunsun_workspace: root } : {}
          } catch { return { tusunsun_workspace_unavailable: true } }
        })(),
      })
    } catch (err) {
      this._sendError(res, 500, err.message)
      this._emitError(req, 500, err.message)
    } finally {
      doneWithWorkspace()
    }
  }

  _getLanIp() {
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const iface of nets[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
    return null;
  }

  async _handleMingPush(req, res) {
    const token = req.headers['x-ming-token'];
    const expected = this.core.get('ming.pushToken');
    if (!token || token !== expected) {
      this._sendJson(res, 403, { error: 'forbidden' });
      this._emitError(req, 403, 'forbidden — invalid x-ming-token');
      return;
    }
    let body
    try {
      body = await this._collectBody(req, res)
    } catch (err) {
      this.core?.log?.('warn', '[Gateway] Failed to collect body (Ming push): ' + (err?.message || 'unknown'));
      return
    }
    try {
      const msg = JSON.parse(body);
        if (msg.type === 'ming.diagnosis') {
          this.core.emitFast('ming.diagnosis', msg);
          this._sendJson(res, 200, { ok: true });
        } else {
          this._sendJson(res, 400, { error: 'unknown type' });
          this._emitError(req, 400, 'unknown ming push type');
        }
      } catch (err) {
        this.core?.log?.('warn', '[Gateway] Invalid Ming push JSON: ' + (err?.message || 'unknown'));
        this._sendJson(res, 400, { error: 'invalid json' });
      }
  }

  broadcast(event, payload) {
    const msg = JSON.stringify({ type: 'event', event, payload });
    for (const [id, conn] of this.clients) {
      if (conn.readyState === 1 && conn.bufferedAmount < 1024 * 1024) conn.send(msg);
    }
  }

  async stop() {
    for (const conn of this.clients.values()) {
      conn.close(1001);
    }
    this.clients.clear();
    if (this.wsServer) this.wsServer.close();
    if (this.httpServer) {
      return new Promise((resolve) => this.httpServer.close(resolve));
    }
  }
}

export default new GatewayPlugin();
