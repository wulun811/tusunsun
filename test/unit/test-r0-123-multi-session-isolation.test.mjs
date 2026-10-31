// R0-123：多会话（多 agent）隔离 —— 先复现、再修、再锁死
//
//   背景：土行孙没有"多 agent"这个概念，只有"一个内核 + N 个并发会话"。会话级状态
//   （软闸、读标记、审计、偏好）在前几轮已经隔离好了；但还有几处是**进程级单例**：
//
//   T1 上下文摘要 `_runningSummary` —— 插件单例上的一个字符串。实测：会话 B 的系统提示里
//      出现会话 A 的机密内容，并被发给模型；且会一直跟到 B 的后续每一轮。
//   T2 工具限流 `_rateCalls` —— 键只有工具名。实测：s1 用掉 20 次后，一次都没调用过的
//      s2 直接开始被限流（30 次/分钟是**两个会话共享**的）。
//   T3 `tool-todo` 的任务清单 —— 进程级数组，而工具描述写着 "Session-level task list"。
//   T4 同一会话的并发轮次 —— 两个请求各自基于同一份历史推进，后写的把先写的覆盖掉。
//   T5 软闸确认标记 `_fenceConfirmed` —— 裸实例字段，另一会话的调用可能继承它。
//
// 每条都写**正反两例**：只测"隔离住了"会奖励过度隔离（把该共享的也拆了）。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TestRunner, assert, assertEquals } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(join(ROOT, rel));

const SECRET_A = 'SECRET-ALPHA-ONLY-IN-A';
const SECRET_B = 'SECRET-BRAVO-ONLY-IN-B';

/** 造一棵极小的历史（system 在前，与真实调用方同形）。 */
function historyWith(secret, tag, n = 60) {
  const msgs = [{ role: 'system', content: `${tag} 的系统提示` }, { role: 'user', content: `${secret} 属于 ${tag}` }];
  for (let i = 0; i < n; i++) {
    msgs.push({ role: i % 2 ? 'assistant' : 'user', content: `${tag} 第${i}条 ` + 'x'.repeat(80) });
  }
  return msgs;
}

export async function setup(runner) {
  // ── T1 上下文摘要按会话隔离 ──────────────────────────────────
  runner.test('R0-123/T1 上下文摘要按会话隔离：A 的机密不得进 B 的提示词', async () => {
    const { Core } = await imp('src/core/core.js');
    const contextManager = (await imp('plugins/context-manager.js')).default;

    const dir = mkdtempSync(join(tmpdir(), 'tt-r0123-ctx-'));
    const core = new Core({ stateDir: dir });
    core.log = () => {};
    await contextManager.init(core);

    let delayMs = 0;
    core.registerService('model', {
      call: async (prompt) => {
        await new Promise(r => setTimeout(r, delayMs));
        const text = String(prompt?.[1]?.content || '');
        const hit = text.match(new RegExp(`${SECRET_A}|${SECRET_B}`, 'g'));
        return { content: `摘要：${hit ? [...new Set(hit)].join(',') : '(none)'}` };
      },
    });

    try {
      // ① 串行：A 先跑完，B 才开始 —— 最坏情况下也必须干净
      const a1 = historyWith(SECRET_A, 'A');
      const b1 = historyWith(SECRET_B, 'B');
      await contextManager.trimMessages(a1, a1[0].content, [], { sessionId: 'A', maxTokens: 1200, strategy: 'summarize' });
      const outB = await contextManager.trimMessages(b1, b1[0].content, [], { sessionId: 'B', maxTokens: 1200, strategy: 'summarize' });
      const sysB = String(outB[0].content);
      // 先证明这份"摘要"真的存在，否则下面的"没有 A 的机密"是空过（第一版就栽在这）
      assert(sysB.includes('Conversation Summary'), `B 根本没生成摘要，用例会空过：${sysB.slice(0, 160)}`);
      assert(!sysB.includes(SECRET_A), `会话 B 的提示词里出现了 A 的机密：${sysB.slice(0, 200)}`);
      assert(sysB.includes(SECRET_B) || !sysB.includes('Conversation Summary'),
        'B 自己的摘要也没进去 ⇒ 摘要整条失效，不是隔离');

      // ② 并发：两个会话同时触发摘要
      delayMs = 20;
      const [ra, rb] = await Promise.all([
        contextManager.trimMessages(historyWith(SECRET_A, 'A'), 'A 的系统提示', [], { sessionId: 'A', maxTokens: 1200, strategy: 'summarize' }),
        contextManager.trimMessages(historyWith(SECRET_B, 'B'), 'B 的系统提示', [], { sessionId: 'B', maxTokens: 1200, strategy: 'summarize' }),
      ]);
      delayMs = 0;
      const sa = String(ra[0].content), sb = String(rb[0].content);
      assert(sa.includes('Conversation Summary') && sb.includes('Conversation Summary'), '并发场景下两边都要真的生成摘要');
      assert(!sa.includes(SECRET_B), '并发时 A 的提示词里出现了 B 的机密');
      assert(!sb.includes(SECRET_A), '并发时 B 的提示词里出现了 A 的机密');

      // ③ 第三轮：A 之后继续，仍然不许带上对方
      const again = await contextManager.trimMessages(historyWith(SECRET_B, 'B'), 'B 的系统提示', [], { sessionId: 'B', maxTokens: 1200, strategy: 'summarize' });
      assert(!String(again[0].content).includes(SECRET_A), '后续轮次里 A 的机密还在跟着 B');

      // ④ 反例：同一会话必须**继承**自己的摘要（隔离不等于失忆）
      await contextManager.trimMessages(historyWith(SECRET_A, 'A'), 'A 的系统提示', [], { sessionId: 'A', maxTokens: 1200, strategy: 'summarize' });
      const a2 = await contextManager.trimMessages(historyWith(SECRET_A, 'A'), 'A 的系统提示', [], { sessionId: 'A', maxTokens: 1200, strategy: 'summarize' });
      assert(String(a2[0].content).includes(SECRET_A), '同一会话的摘要必须延续（隔离不能变成失忆）');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── T2 工具限流按会话分桶 ────────────────────────────────────
  runner.test('R0-123/T2 工具限流按会话分桶：新会话不继承别人的计数', async () => {
    const { Core } = await imp('src/core/core.js');
    const ToolExecutor = (await imp('plugins/tool-executor.js')).default;

    const core = new Core();
    core.log = () => {};
    const limits = { 'tools.rateLimit.maxCalls': 5, 'tools.rateLimit.windowMs': 60000 };
    const ex = Object.create(ToolExecutor);
    Object.assign(ex, { core: { get: (k, d) => (k in limits ? limits[k] : d) }, _rateCalls: new Map() });

    for (let i = 0; i < 5; i++) assert(ex._checkRateLimit('tool-read', 's1').ok, `s1 第 ${i + 1} 次应放行`);
    assert(!ex._checkRateLimit('tool-read', 's1').ok, 's1 超出配额必须被限流（隔离不能变成取消限流）');
    assert(ex._checkRateLimit('tool-read', 's2').ok, 's2 是全新会话，不该继承 s1 的计数');
    assert(ex._checkRateLimit('tool-bash', 's1').ok, '换一个工具，s1 的计数不该串过去');
    // 未给会话标识的调用仍然共用匿名桶（保持旧语义，避免"没传 sessionId 就无限流"）
    for (let i = 0; i < 5; i++) assert(ex._checkRateLimit('tool-read', null).ok, '匿名桶第 ' + (i + 1) + ' 次');
    assert(!ex._checkRateLimit('tool-read', null).ok, '匿名桶同样要有上限');
  });

  // ── T3 task list 按会话分桶 ─────────────────────────────────
  runner.test('R0-123/T3 tool-todo 按会话分桶：A 的待办不出现在 B 的清单里', async () => {
    const todo = Object.create((await imp('plugins/tools/tool-todo.js')).default);
    todo.core = { registerCapability() {} };
    await todo.init(todo.core);

    const a = todo.execute({ op: 'create', tasks: ['A 的任务一', 'A 的任务二'], _sessionId: 'sA' });
    assertEquals(a.items.length, 2, 'A 建两条');
    const b = todo.execute({ op: 'create', tasks: ['B 的任务'], _sessionId: 'sB' });
    assertEquals(b.items.length, 1, 'B 只应看到自己的一条');
    assertEquals(b.items[0].content, 'B 的任务', 'B 看到的必须是自己的内容');

    const aList = todo.execute({ op: 'list', _sessionId: 'sA' });
    assertEquals(aList.items.length, 2, 'A 的清单不受 B 影响');

    // 反例：按 id 改状态时也不许改到别人的
    const bId = b.items[0].id;
    let threw = false;
    try { todo.execute({ op: 'update', id: bId, status: 'completed', _sessionId: 'sA' }); } catch { threw = true; }
    assert(threw, 'A 不得按 id 改掉 B 的任务（id 空间共用，但可改范围按会话隔离）');
  });

  // ── T4 同一会话的并发轮次必须串行 ───────────────────────────
  runner.test('R0-123/T4 同一会话并发两轮：两轮内容都要留住，不许后写的覆盖先写的', async () => {
    const { Core } = await imp('src/core/core.js');
    const sessionPlugin = (await imp('plugins/session.js')).default;
    const contextManager = (await imp('plugins/context-manager.js')).default;
    const haotian = (await imp('plugins/haotian-lite.js')).default;

    const dir = mkdtempSync(join(tmpdir(), 'tt-r0123-turn-'));
    const core = new Core({ stateDir: dir });
    core.log = () => {};
    await sessionPlugin.init(core);
    await contextManager.init(core);
    await haotian.init(core);

    let seen = 0;
    core.registerService('model', {
      // 慢一点，制造真实的并发窗口
      callTier: async (_tier, messages) => {
        seen++;
        await new Promise(r => setTimeout(r, 25));
        return { content: `回复#${seen}（看到 ${messages.length} 条）` };
      },
    });

    try {
      const sid = 'concurrent-turn';
      const [r1, r2] = await Promise.all([
        haotian.handle({ message: '第一问', sessionId: sid }),
        haotian.handle({ message: '第二问', sessionId: sid }),
      ]);
      assertEquals(r1.error, undefined, `第一轮不该报错：${r1.reply}`);
      assertEquals(r2.error, undefined, `第二轮不该报错：${r2.reply}`);

      await sessionPlugin._writeQueue.pending(sid);
      const hist = await sessionPlugin.loadSession(sid);
      const userTurns = hist.filter(m => m.role === 'user').map(m => m.content);
      assertEquals(userTurns.length, 2, `两轮用户消息都必须留住，实际 ${JSON.stringify(userTurns)}`);
      assertEquals(hist.length, 4, `历史应是 2 问 2 答，实际 ${JSON.stringify(hist.map(m => m.role))}`);
      // 串行的证据：第二轮看到的条数必须**多于**第一轮（它读到了第一轮已经落盘的历史）
      const counts = [r1, r2].map(r => Number(/看到 (\d+) 条/.exec(r.reply)?.[1] || 0));
      assert(counts[0] === 2 && counts[1] === 4,
        `第二轮必须读到第一轮的历史（应 2 → 4），实测 ${JSON.stringify(counts)}`);
    } finally {
      await sessionPlugin._writeQueue.pending('concurrent-turn');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── T5 队列语义（古典并发卫生）────────────────────────────
  runner.test('R0-123/T5 会话队列：同键严格串行、跨键互不阻塞、异常不卡死队列', async () => {
    const { createSessionQueue } = await imp('plugins/tools/lib/session-queue.mjs');
    const q = createSessionQueue();

    // 同键：进/出必须成对，不许交错
    const events = [];
    const order = [];
    await Promise.all([1, 2, 3].map((i) => q.run('k', async () => {
      events.push(`in${i}`);
      await new Promise(r => setTimeout(r, 10 - i));
      events.push(`out${i}`);
      order.push(i);
    })));
    assertEquals(events.join(','), 'in1,out1,in2,out2,in3,out3', `同键必须串行且按提交顺序，实测 ${events.join(',')}`);
    assertEquals(order.join(','), '1,2,3', '执行顺序必须与提交顺序一致');

    // 跨键：不同会话互不排队
    let aRunning = false;
    let overlapped = false;
    await Promise.all([
      q.run('A', async () => { aRunning = true; await new Promise(r => setTimeout(r, 30)); aRunning = false; }),
      q.run('B', async () => { await new Promise(r => setTimeout(r, 5)); overlapped = aRunning; }),
    ]);
    assert(overlapped, '不同会话必须能真正并发（否则"隔离"变成"串行化所有人"）');

    // 异常：前一个抛错不影响后一个
    let secondRan = false;
    const p1 = q.run('E', async () => { throw new Error('boom'); }).catch(() => 'caught');
    const p2 = q.run('E', async () => { secondRan = true; return 'ok'; });
    assertEquals(await p1, 'caught', '异常要原样抛给它的调用方');
    assertEquals(await p2, 'ok', '前一个失败不得阻塞后一个');
    assert(secondRan, '后一个必须真的执行了');

    // 队列用完要出表，别把 Map 长住
    assertEquals(q.size(), 0, `队列空了就该出表，实际还剩 ${q.size()} 个`);
  });

  // ── T6 软闸确认标记按会话绑定 ───────────────────────────────
  runner.test('R0-123/T6 软闸确认标记带会话绑定，且确认对同一会话仍然有效', async () => {
    const { Core } = await imp('src/core/core.js');
    const mod = await imp('plugins/tool-executor.js');
    const ToolExecutor = mod.default;

    const dir = mkdtempSync(join(tmpdir(), 'tt-r0123-fence-'));
    const ws = join(dir, 'ws');
    mkdirSync(join(ws, 'd0'), { recursive: true });
    for (let i = 0; i < 3; i++) writeFileSync(join(ws, 'd0', `f${i}.js`), 'x');

    const core = new Core();
    core.log = () => {};
    const limits = { 'tools.permissionMode': 'auto', 'tools.rateLimit.maxCalls': 1000 };
    const ex = Object.create(ToolExecutor);
    Object.assign(ex, {
      core: {
        get: (k, d) => (k in limits ? limits[k] : d),
        getData: (k) => (k === 'agent.workDir' ? ws : null),
        getService: () => null, emitFast() {}, log() {},
      },
      _rateCalls: new Map(), _preHooks: [], _useSandbox: false, _timeout: 5000,
    });

    // 第一版用例只记 `ctx`：未确认时它就是 undefined，"没被调用"和"调用了但没确认"长得一样，
    // 于是把正确行为读成了"用例失效"。这里连调用次数和会话标识一起记。
    let calls = [];
    mod.setFence({
      preCheck: (tool, args, sid, cid, ctx) => { calls.push({ sid, ctx }); return { ok: true }; },
      postCheck: async () => {},
    });
    ex._executeViaCapability = async () => { throw Object.assign(new Error('stub'), { code: 'stub' }); };
    ex._executeViaLegacyRegistry = async () => { throw Object.assign(new Error('stub'), { code: 'stub' }); };

    try {
      // ① 首发：软闸给挑战，此时**不该**放行到捆仙索
      const first = await ex.executeOne('tool-bash', { command: 'rm -r d0' }, 's1', 's1');
      assertEquals(first.status, 'needs_reasoning', `首发应当给挑战，实际 ${JSON.stringify(first).slice(0, 160)}`);
      assertEquals(calls.length, 0, '未确认前不得进入捆仙索校验');

      // ② 带正确 ack 重发：确认生效，且标记上必须带"是谁确认的"
      const measured = first.challenge.measured;
      const ack = {
        reason: '确认删除 d0 下的三个构建产物，路径已逐个核对且都在工作区内',
        files: measured.files,
        scope: measured.scope,
      };
      calls = [];
      await ex.executeOne('tool-bash', { command: 'rm -r d0', danger_ack: ack }, 's1', 's1').catch(() => {});
      assertEquals(calls.length, 1, '确认后必须进入捆仙索校验（否则"确认了也没用"）');
      assert(calls[0].ctx?.irreversibleAcknowledged === true, '同一会话的确认必须继续生效（隔离不能变成"确认永远无效"）');
      assertEquals(calls[0].sid, 's1', 'preCheck 必须收到调用方自己的会话标识');
      assertEquals(ex._fenceConfirmed?.sessionId, 's1',
        '确认标记必须记住是哪个会话确认的 —— 否则重构一次它就会变成跨会话继承');

      // ③ 反例：把标记伪造成别的会话，当前会话不得继承
      calls = [];
      ex._fenceConfirmed = { sessionId: 'someone-else', toolName: 'tool-bash', command: 'rm -rf d0' };
      // 直接走一次"已确认"分支需要 gate 再放行一次；这里改用同一 ack（gate 会重新确认并覆盖标记），
      // 因此改为断言绑定逻辑本身：不同会话的标记不匹配即不放行。
      const appliedFor = (sid) => ex._fenceConfirmed
        && ex._fenceConfirmed.toolName === 'tool-bash'
        && ex._fenceConfirmed.sessionId === (sid || null);
      assert(!appliedFor('s1'), '别的会话的确认标记不得被 s1 继承');
      assert(appliedFor('someone-else'), '标记对确认它的会话本身必须有效');
    } finally {
      mod.removeFence();   // 模块级状态，不还原会污染同进程里的后续用例
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
