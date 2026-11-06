// R0-180：多会话轻任务的**控制面** —— 按会话取消、按会话预算、按会话能力、
// 无历史会话、按会话观测。
//
// R0-182：流式终态必须是**机器可判的事件**（`tusunsun_state`），不能靠解析正文文案。
//
// 每条都写成"两个会话同时在跑"的形状：单会话的测试证明不了"只影响目标会话"，
// 而"一个任务卡住就杀掉整个进程"正是这张工单要修的东西。
//
// 假模型而不是真模型：取消与预算的判据必须可复现，且单测不该花 token。
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TestRunner, assert, assertEquals } from '../harness.mjs';

const imp = (rel) => import(new URL(`../../${rel}`, import.meta.url).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeoutMs = 5000, stepMs = 10 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    await sleep(stepMs);
  }
}

/**
 * 最小装配：真 Core + 真 session + 真 haotian-lite + 假 model。
 *
 * `script` 是按调用顺序消费的模型响应队列（未给就一律返回 `DONE`）；
 * `usage` 给每次调用附加**真实形状**的 token 用量（`inputTokens`/`outputTokens`）。
 */
async function makeHost({ script = null, delayMs = 0, usage = null } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'tss-sessctl-'));
  const { Core } = await imp('src/core/core.js');
  const core = new Core({ stateDir: join(d, 'state') });
  core.log = () => {};
  core.setData('agent.workDir', d);

  const session = Object.create((await imp('plugins/session.js')).default);
  await session.init(core);
  const ht = Object.create((await imp('plugins/haotian-lite.js')).default);
  await ht.init(core);

  const state = { calls: 0, seen: [], ids: new Set() };
  // 记下所有出现过的会话 id：会话落盘是**异步排队**的（`saveHistory` 由 `_end` fire-and-forget），
  // 断言文件前必须等队列排空，否则断言的是"写没写"的时序，不是"该不该写"。
  const origCommand = core.command.bind(core);
  core.command = (method, params, timeout, opts) => {
    const sid = params?.sessionId ?? params?.session_id;
    if (sid) state.ids.add(String(sid));
    return origCommand(method, params, timeout, opts);
  };
  const settle = () => Promise.all([...state.ids].map((id) => session._writeQueue.pending(id)));
  const queue = Array.isArray(script) ? [...script] : null;
  core.registerService('model', {
    async callTier(tier, messages) {
      state.calls++;
      state.seen.push(messages.map((m) => ({ role: m.role, content: m.content })));
      const step = queue ? (queue.shift() || { content: 'DONE' }) : null;
      const wait = step?.delayMs ?? delayMs;
      if (wait) await sleep(wait);
      const out = step ? step.result : { content: 'DONE' };
      return { ...out, ...(usage ? { usage: { ...usage } } : {}) };
    },
    // 流式路径（R0-182）：内容/工具调用/用量按真实分块吐，让网关的 SSE 分支拿到真形状。
    async *streamChatTier(tier, messages) {
      state.calls++;
      state.seen.push(messages.map((m) => ({ role: m.role, content: m.content })));
      const step = queue ? (queue.shift() || { content: 'DONE' }) : null;
      const wait = step?.delayMs ?? delayMs;
      if (wait) await sleep(wait);
      const out = step ? step.result : { content: 'DONE' };
      if (out?.tool_calls) { yield { tool_calls: out.tool_calls }; return; }
      if (out?.content) yield { content: out.content };
      if (usage) yield { usage: { ...usage } };
    },
  });

  return {
    d, core, session, ht, state, settle,
    files: () => {
      try { return readdirSync(join(d, 'state', 'sessions')).sort(); } catch { return []; }
    },
    // 先等写队列排空再删目录：会话写盘是 fire-and-forget 的，抢在它前面删目录会得到
    // 一条"目录被外部换成了符号链接"的误报（实测）。
    close: async () => {
      await settle();
      try { rmSync(d, { recursive: true, force: true }); } catch { /* 已删 */ }
    },
  };
}

const TOOL_CALL_TURN = { content: '', tool_calls: [{ id: 'tc-1', name: 'tool-missing', arguments: '{}' }] };

/** SSE 终态事件允许的字段（R0-182 的安全面：白名单，不是"随便透传"）。 */
const TERMINAL_KEYS = new Set([
  'type', 'state', 'code', 'reason', 'budget', 'turns', 'tokens',
  'tools_dispatched', 'cancel_requested_at', 'request_reason',
]);

/** 把 SSE 正文切成一条条 `data:` 负载（保留 `[DONE]` 原文，顺序即协议）。 */
const sseData = (text) => text.split('\n\n').filter(Boolean).map((b) => b.replace(/^data: /, ''));
const jsonOrNull = (s) => { try { return JSON.parse(s); } catch { return null; } };

/**
 * 真实 HTTP 网关：流式终态必须在**传输层**验（SSE 分帧、`[DONE]` 次序、断开行为），
 * 直接调私有方法证明不了这些。
 */
async function makeGatewayHost(opts) {
  const host = await makeHost(opts);
  const gw = Object.create((await imp('plugins/gateway.js')).default);
  gw.handlers = new Map(); gw.clients = new Map(); gw.requestId = 0;
  await gw.init(host.core);
  await gw.start();
  const base = `http://127.0.0.1:${gw.port}`;
  const post = (body, init = {}) => fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
    ...init,
  });
  return {
    ...host, gw, base, post,
    close: async () => {
      await new Promise((resolve) => gw.httpServer.close(resolve));
      await host.close();
    },
  };
}

export async function setup(runner) {
  // ── P0 取消 ─────────────────────────────────────────────────────────
  runner.test('R0-180/P0 取消：只停目标会话，另一个照常完成，进程不回滚', async () => {
    const host = await makeHost({ delayMs: 80 });
    try {
      const pA = host.core.command('chat.handle', { message: 'A', sessionId: 'sess-a' }, 10000);
      const pB = host.core.command('chat.handle', { message: 'B', sessionId: 'sess-b' }, 10000);
      await waitFor(() => host.ht.stat('sess-a')?.state === 'running' && host.ht.stat('sess-b')?.state === 'running');

      const req = host.ht.cancel('sess-a', { reason: 'test' });
      assertEquals(req.accepted, true, '停止请求必须被登记');
      assertEquals(req.state, 'cancelling', 'accepted 只表示"请求已登记"，不是"已经停了"');

      const [ra, rb] = await Promise.all([pA, pB]);
      assertEquals(ra.ok, true);
      assertEquals(ra.payload.state, 'cancelled', '未派发任何工具 ⇒ 可以证明无副作用，终态是 cancelled');
      assert(/^\[cancelled\]/.test(ra.payload.reply), `终态要有可机器识别的标记，实际 ${ra.payload.reply}`);
      assertEquals(rb.payload.reply, 'DONE', '另一个会话必须不受影响');
      assertEquals(rb.payload.state, undefined, '正常完成不得带终态字段（旧形状逐字段不变）');

      // 被取消的那一轮**不留半截历史**：只有 loadSession 写进内存的那一段的副本被回滚
      await host.settle();
      assertEquals(host.files().join(','), 'sess-b.jsonl', '取消的轮次不落盘，另一个会话照常落盘');
      assert(!host.files().includes('sess-a.jsonl'));
    } finally { host.close(); }
  });

  runner.test('R0-180/P0 取消：工具已派发时终态只能是 unknown（副作用不撤销）', async () => {
    const host = await makeHost({
      script: [
        { result: { content: '', tool_calls: [{ id: 'tc-1', name: 'tool-write', arguments: '{"path":"x.txt"}' }] } },
        { delayMs: 60, result: { content: 'DONE' } },
      ],
    });
    try {
      let sideEffects = 0;
      // 取消**从工具内部**发起：这正好是"派发之后才到达"的那一刻，也是唯一不能诚实
      // 声称 cancelled 的时刻。
      host.core.registerCapability('tool.write', {
        owner: 'tool-write',
        handler: async () => {
          sideEffects++;
          host.ht.cancel('sess-tool', { reason: 'during-dispatch' });
          return { content: 'written' };
        },
      });
      host.core.registerService('tools', {
        get: (n) => (n === 'tool-write' ? { name: 'tool-write', provides: [{ name: 'tool.write' }] } : null),
      });

      const r = await host.core.command('chat.handle', { message: 'write', sessionId: 'sess-tool' }, 10000);
      assertEquals(sideEffects, 1, '副作用真的发生过 —— 这是 unknown 的依据');
      assertEquals(r.payload.state, 'unknown');
      assertEquals(r.payload.code, 'cancel_unknown');
      assertEquals(r.payload.tools_dispatched, 1);
      assert(/not rolled back/.test(r.payload.reason), `理由要说明副作用未撤销，实际 ${r.payload.reason}`);
    } finally { host.close(); }
  });

  runner.test('R0-180/P0 取消：对没有在跑的会话返回 accepted:false，不伪造"已停止"', async () => {
    const host = await makeHost();
    try {
      const r = host.ht.cancel('nobody', { reason: 'test' });
      assertEquals(r.accepted, false);
      assertEquals(r.state, 'not_running');
      // 公开能力面（WS `agent.cancel` 走的就是这一条）
      const viaCap = await host.core.command('agent.cancel', { sessionId: 'nobody' });
      assertEquals(viaCap.ok, true);
      assertEquals(viaCap.payload.state, 'not_running');
    } finally { host.close(); }
  });

  // ── P0 预算 ─────────────────────────────────────────────────────────
  runner.test('R0-180/P0 预算：max_turns 按会话生效（A=2 轮，B=4 轮，互不影响）', async () => {
    const host = await makeHost({ script: Array.from({ length: 8 }, () => ({ result: TOOL_CALL_TURN })) });
    try {
      const [ra, rb] = await Promise.all([
        host.core.command('chat.handle', { message: 'A', sessionId: 'sess-a', budget: { max_turns: 2 } }, 10000),
        host.core.command('chat.handle', { message: 'B', sessionId: 'sess-b', budget: { max_turns: 4 } }, 10000),
      ]);
      assertEquals(ra.payload.state, 'budget_exhausted');
      assertEquals(ra.payload.code, 'budget_exhausted');
      assertEquals(ra.payload.budget.kind, 'max_turns');
      assertEquals(ra.payload.budget.limit, 2);
      assertEquals(ra.payload.turns, 2, 'A 必须在第 2 轮停下');
      assertEquals(rb.payload.budget.limit, 4);
      assertEquals(rb.payload.turns, 4, 'B 的预算是 4 轮 —— 不能被 A 的预算改小');
    } finally { host.close(); }
  });

  runner.test('R0-180/P0 预算：wall_ms 在模型调用返回后判定，并如实报出超出量', async () => {
    const host = await makeHost({ delayMs: 45 });
    try {
      const r = await host.core.command('chat.handle', { message: 'slow', sessionId: 'sess-wall', budget: { wall_ms: 10 } }, 10000);
      assertEquals(r.payload.state, 'budget_exhausted');
      assertEquals(r.payload.budget.kind, 'wall_ms');
      assertEquals(r.payload.budget.limit, 10);
      assert(r.payload.budget.overrun_ms >= 0, '超出量必须可读，不能只报"超时了"');
      assert(/not aborted/.test(r.payload.reason), '必须承认在飞的那次模型调用没有被中止');
      assertEquals(host.state.calls, 1, 'wall_ms 判定之后不得再发第二次模型调用');
    } finally { host.close(); }
  });

  runner.test('R0-180/P0 预算：max_tokens 按上游回报的真实用量判定', async () => {
    const host = await makeHost({ usage: { inputTokens: 100, outputTokens: 50 } });
    try {
      const r = await host.core.command('chat.handle', { message: 'x', sessionId: 'sess-tok', budget: { max_tokens: 10 } }, 10000);
      assertEquals(r.payload.state, 'budget_exhausted');
      assertEquals(r.payload.budget.kind, 'max_tokens');
      assertEquals(r.payload.budget.used, 150, 'used 必须是上游回报的总量（100+50），不是估算');
      assertEquals(r.payload.tokens, 150);
    } finally { host.close(); }
  });

  runner.test('R0-180/P0 预算：非法/无法执行的预算在**任何模型调用之前**具名拒绝', async () => {
    const host = await makeHost();
    try {
      const cases = [
        [{ max_turns: 0 }, 'invalid_budget'],
        [{ max_turns: 1.5 }, 'invalid_budget'],
        [{ wall_ms: -1 }, 'invalid_budget'],
        [{ nope: 1 }, 'invalid_budget'],
        [{ max_cost_units: 5 }, 'budget_unsupported'],
        ['not-an-object', 'invalid_budget'],
      ];
      for (const [budget, code] of cases) {
        const r = await host.core.command('chat.handle', { message: 'x', sessionId: 'sess-bad', budget }, 10000);
        assertEquals(r.ok, false, `${JSON.stringify(budget)} 应当被拒绝`);
        assertEquals(r.code, code, `${JSON.stringify(budget)} 的 code`);
      }
      assertEquals(host.state.calls, 0, '预算不合法时一次模型调用都不该发生');
    } finally { host.close(); }
  });

  // ── P1 无历史会话 ───────────────────────────────────────────────────
  runner.test('R0-180/P1 stateless：不写历史、也不读历史（同一 id 的旧历史不得回流）', async () => {
    const host = await makeHost();
    try {
      for (let i = 0; i < 3; i++) {
        const r = await host.core.command('chat.handle', { message: `probe-${i}`, sessionId: `probe-${i}`, stateless: true }, 10000);
        assertEquals(r.payload.reply, 'DONE');
      }
      await host.settle();
      assertEquals(host.files().join(','), '', 'stateless 调用一次会话文件都不该新增');

      await host.core.command('chat.handle', { message: 'kept', sessionId: 'sess-keep' }, 10000);
      await host.settle();
      assertEquals(host.files().join(','), 'sess-keep.jsonl', '普通调用照常落盘');

      const before = host.state.seen.length;
      await host.core.command('chat.handle', { message: 'again', sessionId: 'sess-keep', stateless: true }, 10000);
      const msgs = host.state.seen[before];
      assertEquals(msgs.filter((m) => m.role === 'user').length, 1, '一次性会话只该有本次的用户消息');
      assert(!msgs.some((m) => String(m.content).includes('kept')), '旧历史不得被带进一次性会话');
      await host.settle();
      assertEquals(host.files().join(','), 'sess-keep.jsonl', 'stateless 不覆盖、也不删除已有历史');
    } finally { host.close(); }
  });

  // ── P1 可观测 ───────────────────────────────────────────────────────
  runner.test('R0-180/P1 观测：per-session 排队/在跑/轮次/错误可读，且不含正文', async () => {
    const host = await makeHost({ delayMs: 60 });
    try {
      const p1 = host.core.command('chat.handle', { message: 'first', sessionId: 'sess-q' }, 10000);
      const p2 = host.core.command('chat.handle', { message: 'second', sessionId: 'sess-q' }, 10000);
      await waitFor(() => host.ht.stat('sess-q')?.in_flight === 1);

      const row = host.ht.stat('sess-q');
      assertEquals(row.queue_depth, 1, '排队中的第二轮必须被看见（不是"没这个人"）');
      assertEquals(row.state, 'running');
      assertEquals(row.stateless, false);
      for (const forbidden of ['reply', 'prompt', 'message', 'content']) {
        assert(!(forbidden in row), `观测面不得包含 ${forbidden}`);
      }

      const snap = host.ht.snapshot();
      assertEquals(snap.stats_scope, 'process-local', '必须明说这是进程内读数');
      assertEquals(snap.in_flight, 1);
      assert(snap.sessions.some((s) => s.session_id === 'sess-q'));
      const viaCap = await host.core.command('agent.sessions', {});
      assertEquals(viaCap.ok, true);
      assert(Array.isArray(viaCap.payload.sessions));

      await Promise.all([p1, p2]);
      const done = host.ht.stat('sess-q');
      assertEquals(done.state, 'completed');
      assertEquals(done.in_flight, 0);
      assertEquals(done.queue_depth, 0);
      assertEquals(done.turns, 1);
      assertEquals(host.ht.stat('never-seen'), null, '没见过的会话是 null，不是一行全 0');
    } finally { host.close(); }
  });

  // ── P1 能力隔离 ─────────────────────────────────────────────────────
  runner.test('R0-180/P1 能力：会话策略在**派发期**生效，且只影响该会话', async () => {
    const d = mkdtempSync(join(tmpdir(), 'tss-policy-'));
    const { Core } = await imp('src/core/core.js');
    const core = new Core({ stateDir: join(d, 'state') });
    core.log = () => {};
    try {
      const T = (await imp('plugins/tool-executor.js')).default;
      const ex = Object.create(T);
      ex._preHooks = []; ex._postHooks = []; ex._dispatchHooks = [];
      ex._rateCalls = new Map(); ex._cache = new Map(); ex._auditLog = new Map();
      ex._receipts = new Map(); ex._receiptMax = 100; ex._metrics = new Map();
      ex._preferences = new Map(); ex._debugStream = null;
      await ex.init(core);

      let wrote = 0;
      // 真实的装配里工具名 → 能力 id 的映射由 tool-registry 提供（`tool-read` ⇒ `tool.read`）；
      // 没有它，执行器只能按同名能力判，而"名字恰好等于能力 id"并不是模型实际看到的那一面。
      core.registerService('tool-registry', {
        get: (n) => ({ name: n, provides: [{ name: String(n).replace(/^tool-([a-z]+)$/, 'tool.$1') }] }),
        list: () => [],
      });
      core.registerCapability('tool.read', { owner: 'tool-read', handler: async () => ({ content: 'r' }) });
      core.registerCapability('tool.write', { owner: 'tool-write', handler: async () => { wrote++; return { content: 'w' }; } });

      const bound = await ex.setSessionPolicy('ro-1', { capabilities: ['tool.read'], source: 'test' });
      assertEquals(bound.capabilities.join(','), 'tool.read', '名单按**解析出的能力 id** 存，不按请求名');

      const denied = await ex.executeOne('tool-write', {}, 'ro-1', 'ro-1');
      assertEquals(denied.code, 'capability_denied');
      assertEquals(denied.state, 'rejected', '拒绝发生在派发之前，state 不能写成 failed');
      assertEquals(wrote, 0, '被策略拒绝的调用不得执行 handler');

      const allowed = await ex.executeOne('tool-read', {}, 'ro-1', 'ro-1');
      assert(!allowed.error, `名单内的只读能力必须仍可用：${allowed.error}`);

      const other = await ex.executeOne('tool-write', {}, 'rw-1', 'rw-1');
      assert(!other.error, `未绑定策略的会话照常可写：${other.error}`);
      assertEquals(wrote, 1);

      // 空名单 = 一个都不给 —— 不是"没限制"。这是最容易写反的一格。
      await ex.setSessionPolicy('ro-2', { capabilities: [] });
      assertEquals((await ex.executeOne('tool-read', {}, 'ro-2', 'ro-2')).code, 'capability_denied');

      // 名单里写错一个名字：拒绝绑定，不静默忽略（静默忽略会让宿主以为"限上了"）
      let badName = null;
      try { await ex.setSessionPolicy('ro-3', { capabilities: ['tool.nope'] }); } catch (e) { badName = e; }
      assertEquals(badName?.code, 'invalid_session_policy');

      // 只接受收窄方向：`full-auto` 是提权，不是"更严格的模式"
      let widened = null;
      try { await ex.setSessionPolicy('ro-4', { permission_mode: 'full-auto' }); } catch (e) { widened = e; }
      assertEquals(widened?.code, 'unsupported_permission_mode');

      // 只读模式按**解析出的能力**判，不按工具名
      await ex.setSessionPolicy('ro-5', { permission_mode: 'read-only' });
      assertEquals((await ex.executeOne('tool-write', {}, 'ro-5', 'ro-5')).code, 'permission_denied');
      assert(!(await ex.executeOne('tool-read', {}, 'ro-5', 'ro-5')).error);

      // 解绑按 owner：别人的策略不会被顺手删掉
      assertEquals(ex.clearSessionPolicy('ro-1', { source: 'someone-else' }), false);
      assertEquals(ex.clearSessionPolicy('ro-1', { source: 'test' }), true);
      assertEquals(ex.getSessionPolicy('ro-1'), null);
      // 策略表必须是**本实例自己的一份**（`Object.create` 的伪实例不能共用父对象的 Map）
      ex._sessionPolicies.set('host-a', { sessionId: 'host-a', capIds: new Set(['tool.read']), mode: null, source: 't', at: 1 });
      assertEquals(T._sessionPolicies?.has('host-a') ?? false, false, '策略表不得穿透到默认实例');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  // ── 控制面端点（真实 HTTP）───────────────────────────────────────────
  runner.test('R0-180/P1 端点：/api/session/cancel 与 /api/session/stats 的真实 HTTP 形状', async () => {
    const d = mkdtempSync(join(tmpdir(), 'tss-endpoint-'));
    const { Core } = await imp('src/core/core.js');
    const core = new Core({ stateDir: join(d, 'state') });
    core.log = () => {};
    // `_startListening` 读的是 config **服务**（不是 core.get）：port 0 = 让内核分配。
    core.registerService('config', {
      data: { gateway: { host: '127.0.0.1', port: 0 } },
      get: (k) => ({ 'gateway.host': '127.0.0.1', 'gateway.port': 0 })[k],
    });
    const gw = Object.create((await imp('plugins/gateway.js')).default);
    gw.handlers = new Map(); gw.clients = new Map(); gw.requestId = 0;
    await gw.init(core);
    await gw.start();
    const base = `http://127.0.0.1:${gw.port}`;
    const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    try {
      // ① 没有 chat-control 时必须是 501，而不是一个空的 accepted:false
      let r = await fetch(`${base}/api/session/stats`);
      assertEquals(r.status, 501);
      assertEquals((await r.json()).code, 'session_control_unsupported');

      // ② 装上控制面（假实现只验接线；行为由上面十条用例锁）
      const calls = [];
      core.registerService('chat-control', {
        cancel: (sid, opts) => { calls.push([sid, opts]); return { accepted: true, session_id: sid, state: 'cancelling' }; },
        snapshot: () => ({ sessions: [{ session_id: 'x' }], in_flight: 0, queue_depth: 0, stats_scope: 'process-local' }),
        stat: (sid) => (sid === 'known' ? { session_id: 'known', turns: 1 } : null),
      });

      r = await fetch(`${base}/api/session/cancel`, json({ session_id: 's3', reason: 'test' }));
      assertEquals(r.status, 202, '202 = 请求已登记；200 会被读成“已经停了”');
      assertEquals((await r.json()).accepted, true);
      assertEquals(calls[0][0], 's3');
      assertEquals(calls[0][1].reason, 'test');

      r = await fetch(`${base}/api/session/stats`);
      assertEquals(r.status, 200);
      assertEquals((await r.json()).stats_scope, 'process-local');

      r = await fetch(`${base}/api/session/stats?session_id=known`);
      assertEquals(r.status, 200);
      assertEquals((await r.json()).session_id, 'known');
      r = await fetch(`${base}/api/session/stats?session_id=seen-nothing`);
      assertEquals(r.status, 404, '没见过就是 404，不是一行全 0');

      r = await fetch(`${base}/api/session/cancel`, json({}));
      assertEquals(r.status, 400, '缺 session_id 是 400');
      // 旧路径不能被新面顶掉：`/api/sessions` 仍然是“会话↔工作目录绑定”
      r = await fetch(`${base}/api/sessions`);
      assertEquals(r.status, 501);
      assertEquals((await r.json()).code, 'workspace_unsupported', '无 workspace 时旧端点仍按自己的合同报错');
    } finally {
      await new Promise((resolve) => gw.httpServer.close(resolve));
      rmSync(d, { recursive: true, force: true });
    }
  });

  // ── R0-182/P0：流式终态（真实 SSE，按字节判）────────────────────────
  // 四条终态各有自己的判据；正常完成必须**一个字节都不多**。

  const terminalOf = (text) => sseData(text).map(jsonOrNull).find((e) => e?.type === 'tusunsun_state');

  runner.test('R0-182/P0 预算：max_tokens 流式超限在 [DONE] 之前发 tusunsun_state', async () => {
    const host = await makeGatewayHost({ usage: { inputTokens: 100, outputTokens: 50 } });
    try {
      const r = await host.post({
        messages: [{ role: 'user', content: 'x' }], session_id: 'stream-tok',
        stream: true, budget: { max_tokens: 10 },
      });
      assertEquals(r.status, 200);
      const text = await r.text();
      const data = sseData(text);
      assertEquals(data.at(-1), '[DONE]', '`[DONE]` 仍必须是最后一条');
      const ev = terminalOf(text);
      assert(ev, `缺流式终态事件，尾部是：${JSON.stringify(text.slice(-300))}`);
      assertEquals(ev.state, 'budget_exhausted');
      assertEquals(ev.code, 'budget_exhausted');
      assertEquals(ev.budget.kind, 'max_tokens');
      assertEquals(ev.budget.limit, 10);
      assertEquals(ev.budget.used, 150, 'used 必须是上游回报的真实总量（100+50），不是估算');
      assertEquals(ev.tokens, 150);
      assertEquals(ev.tools_dispatched, 0);
      assert(/max_tokens=10/.test(ev.reason), `理由要点名哪一个预算，实际 ${ev.reason}`);
      for (const k of Object.keys(ev)) assert(TERMINAL_KEYS.has(k), `终态事件不许出现白名单外字段：${k}`);
      assert(!/BUDGET_EXHAUSTED\]/.test(JSON.stringify(ev)), '状态播报正文不得混进终态事件');
      // 旧客户端形状不变：正文仍是 OpenAI delta 分块
      assert(data.map(jsonOrNull).some((e) => e?.choices?.[0]?.delta?.content === 'DONE'), '正文分块必须保留');
    } finally { await host.close(); }
  });

  runner.test('R0-182/P0 预算：wall_ms 流式超时带 budget.kind=wall_ms 与 overrun_ms', async () => {
    const host = await makeGatewayHost({ delayMs: 45 });
    try {
      const r = await host.post({
        messages: [{ role: 'user', content: 'slow' }], session_id: 'stream-wall',
        stream: true, budget: { wall_ms: 10 },
      });
      assertEquals(r.status, 200);
      const ev = terminalOf(await r.text());
      assert(ev, 'wall_ms 超时同样要有流式终态');
      assertEquals(ev.state, 'budget_exhausted');
      assertEquals(ev.budget.kind, 'wall_ms');
      assertEquals(ev.budget.limit, 10);
      assert(ev.budget.overrun_ms >= 0, '超出量必须可读');
      assert(/not aborted/.test(ev.reason), '必须承认在飞的那次模型调用没有被中止');
    } finally { await host.close(); }
  });

  runner.test('R0-182/P0 取消：未派发工具 ⇒ cancelled 且 tools_dispatched=0', async () => {
    const host = await makeGatewayHost({ delayMs: 120 });
    try {
      const p = host.post({
        messages: [{ role: 'user', content: 'stop me' }], session_id: 'stream-cancel', stream: true,
      });
      await waitFor(() => host.ht.stat('stream-cancel')?.state === 'running');
      host.ht.cancel('stream-cancel', { reason: 'test' });
      const text = await (await p).text();
      assertEquals(sseData(text).at(-1), '[DONE]', '取消也必须以 [DONE] 收尾');
      const ev = terminalOf(text);
      assert(ev, `取消必须在流内可见，实际尾部：${JSON.stringify(text.slice(-300))}`);
      assertEquals(ev.state, 'cancelled');
      assertEquals(ev.code, 'cancelled');
      assertEquals(ev.tools_dispatched, 0);
      assert(ev.cancel_requested_at > 0, '取消时间戳必须可读（事后对账要用）');
    } finally { await host.close(); }
  });

  runner.test('R0-182/P0 取消：已派发工具 ⇒ unknown/cancel_unknown，不谎称已撤销', async () => {
    const host = await makeGatewayHost({
      script: [{ result: { content: '', tool_calls: [{ id: 'tc-1', name: 'tool-write', arguments: '{"path":"x.txt"}' }] } }],
    });
    try {
      host.core.registerCapability('tool.write', {
        owner: 'tool-write',
        handler: async () => {
          host.ht.cancel('stream-tool', { reason: 'during-dispatch' });
          return { content: 'written' };
        },
      });
      host.core.registerService('tools', {
        get: (n) => (n === 'tool-write' ? { name: 'tool-write', provides: [{ name: 'tool.write' }] } : null),
      });
      const text = await (await host.post({
        messages: [{ role: 'user', content: 'write' }], session_id: 'stream-tool', stream: true,
      })).text();
      const ev = terminalOf(text);
      assert(ev, 'stream 分支没有把终态透出来');
      assertEquals(ev.state, 'unknown', '派发过工具就只剩 unknown');
      assertEquals(ev.code, 'cancel_unknown');
      assert(ev.tools_dispatched > 0, 'tools_dispatched 必须如实计数');
      assert(/not rolled back/.test(ev.reason), `理由要说明副作用未撤销，实际 ${ev.reason}`);
    } finally { await host.close(); }
  });

  runner.test('R0-182/P0 正常完成：不出现 tusunsun_state，旧形状逐字段不变', async () => {
    const host = await makeGatewayHost({ usage: { inputTokens: 3, outputTokens: 5 } });
    try {
      const r = await host.post({
        messages: [{ role: 'user', content: 'hi' }], session_id: 'stream-ok', stream: true,
      });
      assertEquals(r.status, 200);
      const text = await r.text();
      const data = sseData(text);
      assertEquals(data.at(-1), '[DONE]');
      assert(!data.map(jsonOrNull).some((e) => e?.type === 'tusunsun_state'), '正常完成不得出现终态事件');
      const usage = data.map(jsonOrNull).find((e) => e?.usage)?.usage;
      assert(usage && usage.total_tokens === 8, `usage 必须仍是 OpenAI token 形状，实际 ${JSON.stringify(usage)}`);
    } finally { await host.close(); }
  });

  runner.test('R0-182/P0 客户端提前断开：不伪造 cancelled，统计面照常收尾', async () => {
    const host = await makeGatewayHost({ delayMs: 60 });
    try {
      const ac = new AbortController();
      const res = await host.post({
        messages: [{ role: 'user', content: 'bye' }], session_id: 'stream-abort', stream: true,
      }, { signal: ac.signal });
      ac.abort();
      try { await res.body?.cancel(); } catch { /* 已断开 */ }
      // 断开是传输层事件，不是取消请求：这一轮必须照常跑完并记为 completed。
      await waitFor(() => {
        const row = host.ht.stat('stream-abort');
        return row && row.state !== 'running' ? row : null;
      }, { timeoutMs: 5000 });
      assertEquals(host.ht.stat('stream-abort').state, 'completed', '客户端断开不得被记成 cancelled');
      const again = await host.post({ messages: [{ role: 'user', content: 'again' }], session_id: 'stream-after', stream: true });
      assertEquals(again.status, 200, '一次断开不得把服务端带崩');
      assertEquals(sseData(await again.text()).at(-1), '[DONE]');
    } finally { await host.close(); }
  });
}
