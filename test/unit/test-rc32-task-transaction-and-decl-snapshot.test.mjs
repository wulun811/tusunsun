// rc.32 —— 专家 rc.31 源码级全面发布审查（H1-H6）给出的五条反例的正式回归判据。
//
// 五条里四条是同一句话：**把一个"回答 A 的判据"拿去回答 B，并且因为它对 A 答得对，
// 就以为它对 B 也对**。
//   RC31-A1  判据是"有没有 activeTask"，但它**在第一个 await 之后**才赋值 ⇒
//            两条并发 execute 都能通过检查，同一个 Cell 上跑起两个任务。
//   RC31-A2  判据是"任务有没有占位"，但没问"占位是不是**已提交**" ⇒ 落盘一失败，
//            内存里占着、盘上没有，Cell 永久 busy。
//   RC31-B1  判据是"执行成功了吗" ⇒ 写证据失败时，真实执行成功、持久证据缺席、
//            API 抛错三件事同时为真，却没有一个共同可核对的结算。
//   RC31-C1  判据是"声明的**某一次读**是否合规" ⇒ getter 三次读给出不同值，
//            于是"审的那份"与"存的那份"不是同一份。
//   RC31-D1  判据是"本进程有没有这个 Cell" ⇒ 跨进程时两个进程都 create 成功，
//            各自相信自己独占同一个 stateDir。
//
// 修法一律是**换主语**，不是把判据写得更严 —— 与专家 §2/§4 的要求一致。
//
// 边界（诚实）：
//   · 全部进程内直测（真 Core / 真 workspace / 真 cell-runtime / 真 tool-executor / 真写盘）；
//   · 故障注入走**受信任的测试桩**（覆写 `_persist` / `_appendResult` / `freezeForTask`），
//     **不**声称模型能注入 Node 代码或安排自己的异步回调；
//   · D 组的"两个进程"用**真的两个 Node 子进程**，因为同进程内的锁语义不同（那条边界
//     本身就写在实现里）。
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assert, assertEquals } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(join(ROOT, rel));

const spec = (id, workspace, over = {}) => ({
  schema_version: 'tusunsun.cell/v0',
  cell_id: id,
  workspace,
  capabilities: ['tool.read', 'tool.write'],
  permission_mode: 'auto',
  runtime: { kind: 'process' },
  limits: { max_active_tasks: 1, max_children: 0 },
  ...over,
});

const task = (id, cellId, over = {}) => ({
  schema_version: 'tusunsun.task/v0',
  task_id: id,
  attempt: 1,
  target_cell_id: cellId,
  goal: `goal ${id}`,
  inputs: [],
  required_capabilities: ['tool.write'],
  budget: { max_steps: 5, wall_ms: 30000 },
  acceptance: { required_artifacts: [], checks: [] },
  ...over,
});

/**
 * 真装配。`onChat` / `contextService` 由每个用例自己安排：
 * A 组要控制"冻结在哪一刻返回"，所以 `cell-context` 是**可注入的**而不是固定的。
 */
async function makeHost(base, { withContext = false, core: ext = null } = {}) {
  const { Core } = await imp('src/core/core.js');
  const wsDir = join(base, 'ws');
  mkdirSync(wsDir, { recursive: true });
  const core = ext || new Core({ stateDir: join(base, 'state') });
  core.log = () => {};
  if (!ext) core.setData('agent.workDir', wsDir);
  await (await imp('plugins/workspace.js')).default.init(core);

  core.registerCapability('tool.read', { owner: 'test', handler: async () => ({ ok: true, value: 'R' }) });
  core.registerCapability('tool.write', {
    owner: 'test',
    handler: async () => { writeFileSync(join(wsDir, 'written.txt'), 'x'); return { ok: true }; },
  });

  const rt = (await imp('plugins/cell-runtime.js')).default;
  await rt.init(core);

  const ctx = { onChat: null, freeze: null };
  if (withContext) {
    // 一个最小但**真实形态**的 cell-context：只实现 execute 用到的那两个成员。
    // `freezeForTask` 由用例决定什么时候 resolve —— 这就是反例的时间窗。
    core.registerService('cell-context', {
      freezeForTask: (...args) => (ctx.freeze ? ctx.freeze(...args) : Promise.resolve(null)),
      enterExecution: () => {},
      exitExecution: () => {},
    });
  }
  core.registerCapability('chat.handle', {
    owner: 'test',
    handler: async (params) => (ctx.onChat ? ctx.onChat(params) : { reply: 'no tool calls' }),
  });

  const Cls = (await imp('plugins/tool-executor.js')).default.constructor;
  const exec = new Cls();
  await exec.init(core);

  return {
    core, wsDir, ctx, exec, rt,
    svc: core.getService('cell-runtime'),
    create(over = {}, opts = {}) { return this.svc.create(spec('c1', wsDir, over), { trusted: true, ...opts }); },
    run(taskId, over = {}) {
      this.svc.accept('c1', task(taskId, 'c1', over));
      return this.svc.execute('c1', null, {});
    },
  };
}


/**
 * 有界等待。**为什么测试里需要它**：这几条判据的"红"正是"两条执行同时活着" —— 在旧代码上
 * 它们会互相等待而不报错。没有上界的话，红表现为**挂住**（跑手只能超时杀掉，看不出是哪一条），
 * 那会把"具名失败"退化成"环境不对"。有了上界，红就是一条带名字的断言失败。
 */
function withTimeout(promise, ms, what) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise).finally(() => { if (timer) clearTimeout(timer); }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`timeout ${ms}ms: ${what}`), { code: 'test_timeout' })), ms);
    }),
  ]);
}

const tmp = () => mkdtempSync(join(tmpdir(), 'rc32-txn-'));
const resultsOf = (base, id = 'c1') => join(base, 'state', 'cells', id, 'results.jsonl');
const readResults = (base, id = 'c1') => {
  const p = resultsOf(base, id);
  return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

export default async function (runner) {
  // ══ A. 任务执行事务：占位在第一个 await 之前 ══════════════════════════
  //
  // 专家 RC31-A1 的验收 ①-⑥ 逐条对应 A1-A6。

  runner.test('rc.32/RC31-A1 冻结期间第二条 execute 必须被具名拒绝，chat.handle 最多 1 次（验收①）', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base, { withContext: true });
      let chats = 0;
      host.ctx.onChat = async () => { chats++; return { reply: 'ok' }; };
      // 冻结可控：A 卡在这里，正是旧版两条 execute 都能通过检查的那个窗口。
      let releaseFreeze;
      const frozen = new Promise((r) => { releaseFreeze = r; });
      let freezeCalls = 0;
      host.ctx.freeze = async () => { freezeCalls++; await frozen; return null; };

      await host.create();
      host.svc.accept('c1', task('A', 'c1', { required_capabilities: ['tool.read'] }));
      const pA = host.svc.execute('c1', null, {});
      await new Promise((r) => setTimeout(r, 20));

      // 冻结尚未返回：第二个任务**在 accept 这一道同步判据上**就必须被拒 ——
      // 准备期的任务已经把 pending/能力集锁死，放它进来只能让先到的那个失败，
      // 那是"后到的任务取消先到的任务"，方向反了。
      let second = null;
      try {
        host.svc.accept('c1', task('B', 'c1'));
        second = { accepted: true };
      } catch (e) { second = { accepted: false, code: e.code }; }
      assertEquals(second.accepted, false, '准备期不得再接下第二个任务');
      assertEquals(second.code, 'cell_busy', `必须具名 cell_busy，实际 ${second.code}`);
      // 即便调用方绕过 accept 直接 execute，也必须被占位挡住（两条入口都要判）。

      // execute 是 async 方法：拒绝以 rejected Promise 的形式到达，必须**当场挂上 catch**，
      // 否则在 await 之前它就是一个未处理的拒绝（本仓库的跑手会把它记成进程级失败）。
      const pB = host.svc.execute('c1', null, {}).then(
        (v) => ({ value: v }), (e) => ({ error: e.code, message: e.message }));
      await new Promise((r) => setTimeout(r, 20));

      releaseFreeze();
      const [a, bRaw] = await withTimeout(Promise.all([pA, pB]), 5000, 'A1 两条 execute 收敛');
      const b = bRaw.value || bRaw;

      assertEquals(freezeCalls, 1, `冻结只该为一个任务发生，实际 ${freezeCalls} 次（旧版 2 次 ⇒ 两个任务都进了准备期）`);
      assertEquals(chats <= 1, true, `chat.handle 最多 1 次，实际 ${chats} 次 —— “一个 Cell 一个任务”不是文档措辞`);
      assertEquals(a.execution_state, 'succeeded', `A 必须正常完成，实际 ${a.execution_state}`);
      assert(b.error || b.execution_state !== 'succeeded',
        `B 不得也报成功，实际 ${JSON.stringify(bRaw).slice(0, 200)}`);
      assertEquals(b.error, 'cell_busy', `第二条 execute 必须具名 cell_busy，实际 ${b.error}`);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.32/RC31-A1 冻结失败：不得遗留 busy，第二次 execute 必须能跑（验收②）', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base, { withContext: true });
      let chats = 0;
      host.ctx.onChat = async () => { chats++; return { reply: 'ok' }; };
      let n = 0;
      host.ctx.freeze = async () => {
        n++;
        if (n === 1) throw Object.assign(new Error('profile drifted'), { code: 'profile_drift' });
        return null;
      };
      await host.create();
      host.svc.accept('c1', task('A', 'c1'));
      let first = null;
      try { await host.svc.execute('c1', null, {}); } catch (e) { first = e; }
      assertEquals(first?.code, 'profile_drift', '冻结失败必须原样上抛（不得吞成别的码）');
      assertEquals(chats, 0, '冻结失败时一次模型链都不得启动');

      const st = host.svc.describe('c1');
      assertEquals(st.state, 'ready', `冻结失败后不得遗留 busy，实际 ${st.state}`);
      assertEquals(st.active_task_id, null, `不得遗留 activeTask，实际 ${st.active_task_id}`);

      // 同一任务重试必须能真的跑起来（"安全重试"不是措辞）
      const again = await host.svc.execute('c1', null, {});
      assertEquals(again.execution_state, 'succeeded', `重试必须成功，实际 ${again.execution_state}`);
      assertEquals(chats, 1, '重试只该跑一次模型链');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.32/RC31-A1 冻结期间被 close：不得在已关闭的 Cell 上继续派发（验收③）', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base, { withContext: true });
      let chats = 0;
      host.ctx.onChat = async () => { chats++; return { reply: 'ok' }; };
      let releaseFreeze;
      const frozen = new Promise((r) => { releaseFreeze = r; });
      host.ctx.freeze = async () => { await frozen; return null; };

      await host.create();
      host.svc.accept('c1', task('A', 'c1'));
      const running = host.svc.execute('c1', null, {});
      await new Promise((r) => setTimeout(r, 20));
      // 准备中不许静默 close（force 才允许），这条本身也是合同的一部分。
      let plain = null;
      try { await host.svc.close('c1', {}); } catch (e) { plain = e.code; }
      assertEquals(plain, 'cell_busy', `准备期未 force 的 close 必须被拒，实际 ${plain}`);
      await host.svc.close('c1', { force: true });

      releaseFreeze();
      let err = null;
      try { await withTimeout(running, 5000, 'A3 冻结返回后收敛'); } catch (e) { err = e; }
      assertEquals(chats, 0, `关闭之后不得启动模型链，实际 ${chats} 次`);
      assert(err && /prepare|closed|no_longer_available/i.test(`${err.code} ${err.message}`),
        `冻结返回后必须具名拒绝继续，实际 ${err?.code} ${err?.message}`);
      assertEquals(host.svc.describe('c1').state, 'stopped', 'Cell 必须保持 stopped（关闭指令不得被推翻）');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.32/RC31-A1 同 task_id 不同 attempt：不得撞占位（验收④）', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base, { withContext: true });
      let chats = 0;
      host.ctx.onChat = async () => { chats++; return { reply: 'ok' }; };
      let releaseFreeze;
      const frozen = new Promise((r) => { releaseFreeze = r; });
      let freezeCalls = 0;
      host.ctx.freeze = async () => { freezeCalls++; await frozen; return null; };

      await host.create();
      host.svc.accept('c1', task('T', 'c1', { attempt: 1 }));
      const p1 = host.svc.execute('c1', null, {});
      await new Promise((r) => setTimeout(r, 20));

      // 同一个 task_id、不同 attempt：**仍然是两条执行**，不能靠 "id 一样" 就当成同一次。
      let err = null;
      try {
        host.svc.accept('c1', task('T', 'c1', { attempt: 2 }));
        const p2 = host.svc.execute('c1', null, {});
        await new Promise((r) => setTimeout(r, 20));
        await withTimeout(p2, 5000, 'A4 B 收敛');
      } catch (e) { err = e; }
      releaseFreeze();
      await withTimeout(p1, 5000, 'A4 A 收敛');

      assertEquals(freezeCalls, 1, `同 id 不同 attempt 不得共享一次准备，实际冻结 ${freezeCalls} 次`);
      assert(err && err.code === 'cell_busy', `必须具名 cell_busy，实际 ${err?.code}`);
      assertEquals(chats, 1, `只能有一条模型链，实际 ${chats}`);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.32/RC31-A1 compare-and-commit 四道判据：每一种失效都有具名理由（验收⑤）', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base);
      await host.create();
      // 这一条测的是**判据本身**，因为正常路径上 `accept` 已经在准备期拒了第二个任务
      // （见 A1）。compare-and-commit 是那道闸门被进程内绕过时的第二道 —— 它必须自己成立，
      // 不能靠"上面那道还在"来证明。
      const token = 'tok-1';
      const pre = 'ready';
      const mk = (over = {}) => ({
        spec: { cell_id: 'c1' }, state: 'ready', prepare: { token, phase: 'prepared', pendingRev: 3 },
        pendingRev: 3, ...over,
      });
      const valid = host.rt._prepareStillValid(mk(), token, pre);
      assertEquals(valid, null, `同一令牌 + 同一 pendingRev + 状态未变 ⇒ 可以继续，实际 ${valid}`);

      assertEquals(host.rt._prepareStillValid(mk({ prepare: { token: 'other', phase: 'prepared', pendingRev: 3 } }), token, pre),
        'prepare_superseded', '占位被另一张令牌顶掉必须报 prepare_superseded');
      assertEquals(host.rt._prepareStillValid(mk({ pendingRev: 4 }), token, pre),
        'pending_changed', 'pending 版本变了必须报 pending_changed（否则会拿别人的能力集跑）');
      assertEquals(host.rt._prepareStillValid(mk({ state: 'stopped' }), token, pre),
        'cell_no_longer_available', '冻结期间被 close 必须报 cell_no_longer_available');
      assertEquals(host.rt._prepareStillValid(mk({ state: 'faulted' }), token, pre),
        'cell_no_longer_available', 'faulted 同样是"不再可用"');
      assertEquals(host.rt._prepareStillValid(mk({ state: 'draining' }), token, pre),
        'state_drifted', '状态漂到别处必须报 state_drifted（不是"看起来还行就继续"）');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.32/RC31-A1 真的 freezeForTask 迟到 + 抛错 + 被拒：三种形态各有具名结果（验收⑥）', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base, { withContext: true });
      const modes = [];
      host.ctx.onChat = async () => ({ reply: 'ok' });

      // ① 迟到 ② 抛错 ③ 返回 null（无绑定）—— 三种都是真的 freezeForTask 行为，不是模拟。
      for (const [name, fn] of [
        ['late', async () => { await new Promise((r) => setTimeout(r, 30)); return null; }],
        ['throws', async () => { throw Object.assign(new Error('prompt unreadable'), { code: 'prompt_unreadable' }); }],
        ['unbound', async () => null],
      ]) {
        host.ctx.freeze = fn;
        await host.create({ cell_id: 'c1' }).catch(() => {});
        host.svc.accept('c1', task(`T-${name}`, 'c1'));
        let out = null;
        try { out = await host.svc.execute('c1', null, {}); } catch (e) { out = { error: e.code }; }
        modes.push({ name, ok: out?.execution_state || null, code: out?.error || out?.code || null });
        const st = host.svc.describe('c1');
        assertEquals(st.state, 'ready', `${name}：完成后 Cell 必须回 ready，实际 ${st.state}`);
        assertEquals(st.active_task_id, null, `${name}：不得遗留 activeTask`);
      }
      assertEquals(modes[0].ok, 'succeeded', `迟到必须照常成功，实际 ${JSON.stringify(modes[0])}`);
      assertEquals(modes[1].code, 'prompt_unreadable', `抛错必须原样上抛，实际 ${JSON.stringify(modes[1])}`);
      assertEquals(modes[2].ok, 'succeeded', `无绑定必须走旧路径并成功，实际 ${JSON.stringify(modes[2])}`);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  // ══ A2. 提交点前后的两种补偿必须相反 ═══════════════════════════════

  runner.test('rc.32/RC31-A2 预启动落盘失败：execute 抛错但 Cell 必须可重试（不得永久 busy）', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base);
      let chats = 0;
      host.ctx.onChat = async () => { chats++; return { reply: 'ok' }; };
      await host.create();
      host.svc.accept('c1', task('A', 'c1'));

      const real = host.rt._persist.bind(host.rt);
      let faults = 0;
      host.rt._persist = async (...a) => {
        faults++;
        if (faults === 1) throw Object.assign(new Error('simulated EIO'), { code: 'EIO' });
        return real(...a);
      };
      let err = null;
      try { await host.svc.execute('c1', null, {}); } catch (e) { err = e; }
      host.rt._persist = real;

      assertEquals(err?.code, 'EIO', '落盘错误必须原样上抛');
      assertEquals(chats, 0, '预启动失败时一次模型链都不得启动');
      const st = host.svc.describe('c1');
      assertEquals(st.state, 'ready', `预启动失败必须回到原状态，而不是留一个 busy 的壳；实际 ${st.state}`);
      assertEquals(st.active_task_id, null, `不得遗留 activeTask，实际 ${st.active_task_id}`);

      // 真的能重试：不是"描述上 ready，实际下一次还是被自己挡住"。
      const again = await host.svc.execute('c1', null, {});
      assertEquals(again.execution_state, 'succeeded', `重试必须成功，实际 ${again.execution_state}`);
      assertEquals(chats, 1, `重试只该跑一次模型链，实际 ${chats}`);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.32/RC31-A2 预启动失败必须记一条可审计事实（cell.task.prestart_failed）', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base);
      const seen = [];
      host.core.on('cell.task.prestart_failed', (e) => seen.push(e));
      await host.create();
      host.svc.accept('c1', task('A', 'c1'));
      const real = host.rt._persist.bind(host.rt);
      host.rt._persist = async () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); };
      try { await host.svc.execute('c1', null, {}); } catch { /* 期望抛 */ }
      host.rt._persist = real;
      assertEquals(seen.length, 1, `必须记一条预启动失败事实，实际 ${seen.length}`);
      assertEquals(seen[0].phase, 'prestart_persist_failed', '事件的 phase 必须能区分"预启动"与"执行中"');
      assertEquals(seen[0].rolled, true, '事件必须如实说"已回滚"');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  // ══ B. 执行结果 / 持久证据 / 回执不是一个东西 ══════════════════════════

  runner.test('rc.32/RC31-B1 结果追加失败：必须 evidence_unavailable，且不得同时给出可信的 accepted（专家主反例）', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base);
      const fin = []; const unsettled = [];
      host.core.on('cell.task.finished', (e) => fin.push(e));
      host.core.on('cell.task.unsettled', (e) => unsettled.push(e));
      let chats = 0;
      host.ctx.onChat = async () => { chats++; return { reply: 'ok' }; };
      await host.create();
      host.svc.accept('c1', task('A', 'c1'));

      const real = host.rt._appendResult.bind(host.rt);
      host.rt._appendResult = async () => { throw Object.assign(new Error('simulated EIO at append'), { code: 'EIO' }); };
      let err = null;
      try { await host.svc.execute('c1', null, {}); } catch (e) { err = e; }
      host.rt._appendResult = real;

      assertEquals(chats, 1, '执行本身真的跑过了（这正是"不能把它报成执行失败"的原因）');
      assertEquals(err?.code, 'evidence_unavailable', `必须具名 evidence_unavailable，实际 ${err?.code}`);
      // 执行事实不得因为写证据失败而被删除：错误对象上必须仍带着它。
      assertEquals(err?.execution_outcome?.state, 'succeeded',
        `execution_outcome 必须如实保留"执行成功"，实际 ${JSON.stringify(err?.execution_outcome)}`);
      assertEquals(err?.durability_outcome?.state, 'evidence_unavailable',
        'durability_outcome 必须与 execution_outcome 分开报');
      assertEquals(fin.length, 0, '不得播 cell.task.finished —— 它宣告的是"已结算"');
      assertEquals(unsettled.length, 1, '必须播一条 cell.task.unsettled');

      const res = readResults(base);
      assertEquals(res.length, 0, '证据确实没落盘（这就是被报出来的那件事）');
      // 执行已经结束 ⇒ 下一个任务可接（不是"Cell 坏了"），但**上一笔的未结算必须还看得见**：
      // `lastResult` 会被下一笔取代，所以另有一份有界清单（专家 §3 的"避免覆盖未结算状态"）。
      const st = host.svc.describe('c1');
      assertEquals(st.state, 'ready', `执行结束后状态必须可解释，实际 ${st.state}`);
      assertEquals(st.unsettled.length, 1, `未结算清单必须能报出来，实际 ${JSON.stringify(st.unsettled)}`);
      assertEquals(st.unsettled[0].record_id, err.record_id ?? st.unsettled[0].record_id,
        '未结算条目必须指向那一笔（record_id）');
      assertEquals(st.unsettled[0].task_id, 'A');
      // 再接一个会失败的任务：未结算那笔**不得被覆盖**，两笔要能分开看见。
      host.ctx.onChat = async () => { throw Object.assign(new Error('second run'), { code: 'chat_failed' }); };
      const r2 = await host.run('B', { required_capabilities: ['tool.read'] });
      assertEquals(r2.execution_state, 'failed');
      const st2 = host.svc.describe('c1');
      assertEquals(st2.unsettled.length, 1,
        `上一笔未结算不得被下一个任务清掉（B 自己成功落盘，不该往清单里加）；实际 ${JSON.stringify(st2.unsettled)}`);
      assertEquals(st2.unsettled[0].task_id, 'A', '清单里仍必须是 A 那一笔');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.32/RC31-B1 正常路径：结果行带 record_id，三种结局字段都在', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base);
      let chats = 0;
      host.ctx.onChat = async () => { chats++; return { reply: 'ok' }; };
      await host.create();
      const r = await host.run('A', { required_capabilities: ['tool.write'] });
      assertEquals(r.execution_state, 'succeeded');
      assertEquals(r.durability_outcome?.state, 'persisted', `durability 必须报 persisted，实际 ${JSON.stringify(r.durability_outcome)}`);
      assertEquals(r.state_persisted, true, '状态落盘必须如实报');

      const lines = readResults(base);
      assertEquals(lines.length, 1, `必须恰好一条结果行，实际 ${lines.length}`);
      const line = lines[0];
      assert(typeof line.record_id === 'string' && line.record_id.length > 0,
        `结果行必须带 record_id（重启重放靠它，不靠行位置猜），实际 ${JSON.stringify(line).slice(0, 160)}`);
      assert(/:A#1$/.test(line.record_id), `record_id 必须能回答"哪个任务哪次尝试"，实际 ${line.record_id}`);
      assertEquals(line._reply, undefined, '`_reply` 只是进程内字段，不得进落盘');
      assertEquals(chats, 1);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.32/RC31-B1 追加瞬态失败：有界重试后成功，且不重复记两次', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base);
      host.ctx.onChat = async () => ({ reply: 'ok' });
      await host.create();
      const real = host.rt._appendResult.bind(host.rt);
      let calls = 0;
      host.rt._appendResult = async (...a) => {
        calls++;
        if (calls === 1) throw Object.assign(new Error('transient EIO'), { code: 'EIO' });
        return real(...a);
      };
      const r = await host.run('A', { required_capabilities: ['tool.read'] });
      host.rt._appendResult = real;
      assertEquals(r.execution_state, 'succeeded');
      assertEquals(r.durability_outcome.state, 'persisted', '瞬态失败重试成功后必须报 persisted');
      assertEquals(r.durability_outcome.attempts, 2, `必须如实报第几次成功，实际 ${r.durability_outcome.attempts}`);
      const lines = readResults(base);
      assertEquals(lines.length, 1, `重试不得写出两条结果行，实际 ${lines.length}`);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.32/RC31-B1 结果已落盘但状态落盘失败：不得说"没有回执"（state_persisted 单独回答）', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base);
      host.ctx.onChat = async () => ({ reply: 'ok' });
      await host.create();
      // 第一次 _persist 是预启动提交点（必须成功），第二次是结算；只让第二次失败。
      const real = host.rt._persist.bind(host.rt);
      let n = 0;
      host.rt._persist = async (...a) => {
        n++;
        if (n === 2) throw Object.assign(new Error('state EIO'), { code: 'EIO' });
        return real(...a);
      };
      let out = null; let err = null;
      try { out = await host.run('A', { required_capabilities: ['tool.read'] }); } catch (e) { err = e; }
      host.rt._persist = real;

      assertEquals(err, null, `状态落盘失败不得让执行结果变成异常；实际 ${err?.code}`);
      assertEquals(out.execution_state, 'succeeded');
      assertEquals(out.state_persisted, false, 'state_persisted 必须如实报 false');
      const lines = readResults(base);
      assertEquals(lines.length, 1, '结果行已经在盘上（这正是"不能报成没回执"的理由）');
      assertEquals(lines[0].record_id, out.record_id, '盘上那条必须就是返回值那条');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.32/RC31-B1 失败/拒绝同样落盘：证据不因结局难看而缺席', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base);
      host.ctx.onChat = async () => { throw Object.assign(new Error('agent loop exploded'), { code: 'chat_failed' }); };
      await host.create();
      const r = await host.run('A', { required_capabilities: ['tool.read'] });
      assertEquals(r.execution_state, 'failed', `必须如实记 failed，实际 ${r.execution_state}`);
      const lines = readResults(base);
      assertEquals(lines.length, 1, `失败也必须有一行证据，实际 ${lines.length}`);
      assertEquals(lines[0].execution_state, 'failed');
      assertEquals(lines[0].record_id, r.record_id);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  // ══ C. Core 声明：一次遍历、审的就是存的 ══════════════════════════════

  runner.test('rc.32/RC31-C1 交替值的 getter 声明：登记期具名拒绝，且一次都没被"读进去"（专家主反例）', async () => {
    const { Core } = await imp('src/core/core.js');
    const core = new Core({ stateDir: join(tmp(), 'state') });
    core.log = () => {};
    let reads = 0;
    const schema = { required: ['x'] };
    Object.defineProperty(schema, 'properties', {
      enumerable: true,
      get() {
        reads++;
        // 前两次给合规的，第三次给出被禁止的 pattern —— 旧版正是三次读里"审一次、存另一次"。
        return reads <= 2 ? { x: { type: 'string' } } : { x: { type: 'string', pattern: '^a+$' } };
      },
    });
    let code = null;
    try {
      core.registerCapability('test.getter', { owner: 'test', handler: async (x) => x, input_schema: schema });
      code = 'ACCEPTED';
    } catch (e) { code = e.code; }
    assertEquals(code, 'declaration_not_pure_data',
      `访问器声明必须在登记期具名拒绝（实测旧版 ACCEPTED 且 pattern 进了权威记录），实际 ${code}`);
    assertEquals(reads, 0, `访问器不得被"先读进来再看看"——判据是一次遍历里读 descriptor；实际读了 ${reads} 次`);
    // 拒绝之后不得留下半笔登记
    assertEquals(core.listCapabilities({ prefix: 'test.' }).length, 0, '被拒的声明不得留下半笔登记');
  });

  runner.test('rc.32/RC31-C1 getter 抛异常：同样具名拒绝，不得把异常泄漏成别的错误', async () => {
    const { Core } = await imp('src/core/core.js');
    const core = new Core({ stateDir: join(tmp(), 'state') });
    core.log = () => {};
    const schema = {};
    Object.defineProperty(schema, 'properties', { enumerable: true, get() { throw new Error('boom'); } });
    let code = null; let msg = '';
    try {
      core.registerCapability('test.boom', { owner: 'test', handler: async () => 1, input_schema: schema });
      code = 'ACCEPTED';
    } catch (e) { code = e.code; msg = e.message; }
    assertEquals(code, 'declaration_not_pure_data', `必须是具名的 declaration_not_pure_data，实际 ${code}: ${msg}`);
  });

  runner.test('rc.32/RC31-C1 pattern / $ref / minimum 的动态声明：一律不得进权威记录', async () => {
    const { Core } = await imp('src/core/core.js');
    const core = new Core({ stateDir: join(tmp(), 'state') });
    core.log = () => {};
    const forbidden = [['pattern', '^a+$'], ['$ref', '#/x'], ['minimum', 1], ['enum', ['a']]];
    for (const [kw, val] of forbidden) {
      // 静态写法：登记成功，但必须被记成未生效约束（支持面不再拒绝登记，R0-177 守）
      core.registerCapability(`test.static.${kw}`, {
        owner: 'test', handler: async () => 1,
        input_schema: { properties: { x: { type: 'string', [kw]: val } } },
      });
      const stat = (core._capabilities.get(`test.static.${kw}`)?.schema_unvalidated || []).map((i) => i.keyword);
      assert(stat.includes(kw), `${kw} 静态写法必须被记成未生效约束，实际 ${JSON.stringify(stat)}`);

      // 动态写法：getter 换值一律连登记都进不去
      let dyn = null;
      const s = {};
      Object.defineProperty(s, 'properties', { enumerable: true, get: () => ({ x: { type: 'string', [kw]: val } }) });
      try {
        core.registerCapability(`test.dyn.${kw}`, { owner: 'test', handler: async () => 1, input_schema: s });
        dyn = 'ACCEPTED';
      } catch (e) { dyn = e.code; }
      assertEquals(dyn, 'declaration_not_pure_data', `${kw} 动态写法必须 declaration_not_pure_data，实际 ${dyn}`);
    }
  });

  runner.test('rc.32/RC31-C1 Proxy / symbol 键 / 稀疏数组 / 非有限数字：四种边界的确定结局', async () => {
    const { Core } = await imp('src/core/core.js');
    const core = new Core({ stateDir: join(tmp(), 'state') });
    core.log = () => {};
    const cases = [
      ['proxy', new Proxy({ x: { type: 'string' } }, {})],
      ['symbol', Object.assign({ x: { type: 'string' } }, { [Symbol('s')]: 1 })],
      ['sparse', (() => { const a = [1]; a[3] = 2; return { x: { type: 'string' }, e: a }; })()],
      ['nan', { x: { type: 'string' }, n: NaN }],
      ['inf', { x: { type: 'string' }, n: Infinity }],
      ['fn', { x: { type: 'string' }, f: () => 1 }],
    ];
    for (const [name, v] of cases) {
      let code = null;
      try { core.registerCapability(`test.${name}`, { owner: 'test', handler: async () => 1, input_schema: v }); code = 'ACCEPTED'; }
      catch (e) { code = e.code; }
      assertEquals(code, 'declaration_not_pure_data', `${name} 必须具名拒绝，实际 ${code}`);
    }
    // 正例：普通纯数据 + 共享引用（不是环）必须照常接受 —— 否则只是"一律拒绝"
    const shared = { type: 'string' };
    let ok = null;
    try { core.registerCapability('test.shared', { owner: 'test', handler: async () => 1, input_schema: { type: 'object', properties: { a: shared, b: shared } } }); ok = 'ACCEPTED'; }
    catch (e) { ok = e.code; }
    assertEquals(ok, 'ACCEPTED', `共享非环对象是合法纯数据，必须接受，实际 ${ok}`);
  });

  runner.test('rc.32/RC31-C1 纯数据快照与调用方原对象彻底隔离（含 __proto__ 键保真）', async () => {
    const { Core } = await imp('src/core/core.js');
    const core = new Core({ stateDir: join(tmp(), 'state') });
    core.log = () => {};
    // `__proto__` 作为**普通 JSON 键**必须被保留：用 `out[k] =` 会改原型、把这个键静默丢掉。
    // 它是 `properties` 里的一个**属性名**（不是 schema 关键字）—— rc.33 的 schema 白名单只
    // 约束关键字，属性名照旧是任意字符串，所以这条不变式的形状必须落在这里。
    const src = JSON.parse('{"required":["x"],"properties":{"x":{"type":"string"},"__proto__":{"type":"string"}}}');
    core.registerCapability('test.proto', { owner: 'test', handler: async () => 1, input_schema: src });
    const rec = core._capabilities.get('test.proto');
    assert(Object.keys(rec.input_schema.properties).includes('__proto__'),
      `__proto__ 必须作为一个普通键保留，实际键 ${JSON.stringify(Object.keys(rec.input_schema.properties))}`);
    assertEquals(rec.input_schema.properties.__proto__.type, 'string', '__proto__ 里的内容必须原样保留');
    assertEquals(Object.getPrototypeOf(rec.input_schema.properties), Object.prototype, '快照本身不得被改成异形原型');

    // 登记后改原对象：权威值不得跟着动
    src.properties.x.type = 'number';
    assertEquals(rec.input_schema.properties.x.type, 'string', '登记后改原对象不得改动权威快照');
    const bad = await core.callCapability('test.proto', { x: 123 });
    assertEquals(bad.ok, false, `权威 schema 必须仍然生效（123 不是 string），实际 ${JSON.stringify(bad).slice(0, 160)}`);
    assertEquals(bad.code, 'invalid_input');
  });

  runner.test('rc.32/RC31-C1 支持面校验读的是已冻结副本（不是原对象）', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(join(ROOT, 'src/core/core.js'), 'utf8');
    const chk = src.match(/_schemaIssues\(([A-Za-z_$][\w$]*),\s*'input_schema'\)/);
    assert(chk, '找不到 input_schema 的支持面体检调用');
    assertEquals(chk[1], 'finalInput',
      `支持面体检必须读已冻结/已继承的副本（读原对象 = 审一个、存另一个），实际读 ${chk[1]}`);
    assert(/const finalInput = inherited\(input_schema, 'input_schema', lockedInput\)/.test(src),
      'finalInput 必须由冻结副本 lockedInput 派生');
    assert(!/_schemaIssues\(\s*input_schema\b/.test(src), '不得直接体检调用方的原对象');
    assert(!/_declImpurity\s*\(/.test(src),
      '`_declImpurity` 必须已被删除：两趟遍历正是"审一个、存另一个"的形状');
  });

  // ══ D. stateDir 独占：跨进程必须只能有一个属主 ═════════════════════════
  //
  // 用**真的两个 Node 子进程**：同进程内的锁语义不同（那条边界写在实现里），
  // 在同一个进程里模拟跨进程，等于用错的主语去证明这件事。

  const childProbe = (base, tag, cellId) => new Promise((resolve) => {
    const code = `
      const base = ${JSON.stringify(base)}, tag = ${JSON.stringify(tag)}, cellId = ${JSON.stringify(cellId)};
      const { join } = await import('node:path');
      const { Core } = await import(${JSON.stringify(join(ROOT, 'src/core/core.js'))});
      const core = new Core({ stateDir: join(base, 'state') });
      core.log = () => {};
      core.setData('agent.workDir', join(base, 'ws'));
      await (await import(${JSON.stringify(join(ROOT, 'plugins/workspace.js'))})).default.init(core);
      await (await import(${JSON.stringify(join(ROOT, 'plugins/cell-runtime.js'))})).default.init(core);
      const Cls = (await import(${JSON.stringify(join(ROOT, 'plugins/tool-executor.js'))})).default.constructor;
      const exec = new Cls(); await exec.init(core);
      const svc = core.getService('cell-runtime');
      let out;
      try {
        const st = await svc.create({ schema_version: 'tusunsun.cell/v0', cell_id: cellId,
          workspace: join(base, 'ws'), capabilities: ['tool.read'], permission_mode: 'auto',
          runtime: { kind: 'process' }, limits: { max_active_tasks: 1, max_children: 0 } }, { trusted: true });
        out = { tag, ok: true, incarnation: st.incarnation_id, state: st.state };
      } catch (e) { out = { tag, ok: false, code: e.code }; }
      console.log(JSON.stringify(out));
      await new Promise((r) => setTimeout(r, 400));
    `;
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, encoding: 'utf8' });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', () => {
      const line = out.split('\n').find((l) => l.trim().startsWith('{'));
      try { resolve(JSON.parse(line)); } catch { resolve({ tag, ok: false, code: 'probe_error', raw: out.slice(0, 400) }); }
    });
  });

  runner.test('rc.32/RC31-D1 两个进程同 stateDir 同 cell_id：只能有一个成功（专家主反例）', async () => {
    const base = tmp();
    try {
      mkdirSync(join(base, 'ws'), { recursive: true });
      // 真的并发：两个进程几乎同时 create。
      const [a, b] = await Promise.all([childProbe(base, 'A', 'shared'), childProbe(base, 'B', 'shared')]);
      const ok = [a, b].filter((x) => x.ok);
      const refused = [a, b].filter((x) => !x.ok);
      assertEquals(ok.length, 1,
        `必须恰好一个成功（旧版两个都 ok:true，各自拿到 incarnation），实际 ${JSON.stringify([a, b])}`);
      assertEquals(refused.length, 1, `另一个必须具名拒绝，实际 ${JSON.stringify(refused)}`);
      assertEquals(refused[0].code, 'state_dir_owned',
        `拒因必须是 state_dir_owned（说清"这个目录有另一个活属主"），实际 ${refused[0].code}`);
      // 落盘里只能有一个 incarnation，且就是那个成功的
      const persisted = JSON.parse(readFileSync(join(base, 'state', 'cells', 'shared', 'cell.json'), 'utf8'));
      assertEquals(persisted.incarnation_id, ok[0].incarnation,
        '最终落盘必须是被允许的那个属主（不是"最后写者赢"）');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.32/RC31-D1 属主已不在：不静默抢占，但 forceOwner 可以显式接管', async () => {
    const base = tmp();
    try {
      mkdirSync(join(base, 'ws'), { recursive: true });
      const first = await childProbe(base, 'A', 'shared');
      assertEquals(first.ok, true, '第一个进程必须成功');
      // 子进程已退出（持锁者不在了）。默认路径仍然不得自动抢占 —— 误判就是双活。
      const host = await makeHost(base, { withContext: false });
      let err = null;
      try {
        await host.svc.create(spec('shared', host.wsDir), { trusted: true });
      } catch (e) { err = e; }
      assertEquals(err?.code, 'state_dir_owned',
        `持锁者不在时默认仍须具名拒绝（"自动清理"在误判时直接导致双活），实际 ${err?.code}`);
      // 显式接管：调用方确认过那个进程真的没了。
      const st = await host.svc.create(spec('shared', host.wsDir), { trusted: true, forceOwner: true });
      assertEquals(st.state, 'ready', 'forceOwner 之后必须能建');
      assertEquals(st.cell_id, 'shared');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.32/RC31-D1 属主锁随 Cell 生命存续：close 之后才释放，且只释放自己的', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base);
      await host.create();
      const lockDir = join(base, 'state', 'cells', 'owner.lock');
      assertEquals(existsSync(lockDir), true, 'create 之后属主锁必须在（否则第二个进程随时能插手）');
      const owner = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8'));
      assertEquals(owner.pid, process.pid, 'owner.json 必须记下真实 pid（用于解释锁归谁）');
      assertEquals(owner.cell_id, 'c1', 'owner.json 必须记下 cell_id');

      const closed = await host.svc.close('c1', {});
      assertEquals(closed.state_dir_released, true, `静默关闭必须释放属主锁，实际 ${JSON.stringify(closed)}`);
      assertEquals(existsSync(lockDir), false, '释放之后锁目录必须消失（下一次重启才能拿到）');

      // 只释放自己的：手工放一个**别人的**锁，再用它自己的 owner.json 去问 release 的判据。
      // 判据是"owner.json 的 pid+cell_id 是不是我"，不是"锁目录存不存在"——
      // 后者会把后来属主的锁一起 rmdir 掉。
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid + 1, cell_id: 'c1', host: 'other', at: 'now' }));
      const mine = { release: null };
      // 重新走一次 _acquireStateDirOwner：别人的活锁必须具名拒绝，且**不碰**那个目录。
      let refused = null;
      try { await host.rt._acquireStateDirOwner(host.core, 'c1', {}); } catch (e) { refused = e.code; }
      assertEquals(refused, 'state_dir_owned', `别人的锁必须具名拒绝，实际 ${refused}`);
      const kept = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8'));
      assertEquals(kept.pid, process.pid + 1, '被拒的那一次不得改动别人的 owner.json');
      void mine;
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.32/RC31-D1 同进程两个 Core 争同一 stateDir：必须被拒，旧属主 close 之后才能重建（rc.33/R32-01 收紧）', async () => {
    const base = tmp();
    try {
      // rc.32 曾把"同 PID"当成"同属主"放行 —— 那时两个 Core 会**双双 create 成功**、各自
      // 拿到 incarnation，而 cell.json 最后只留一个（专家 rc.32 审查的 R32-01）。
      // 现在属主身份是 **Core 实例**：同进程换一个 Core 就是换一个属主。
      const h1 = await makeHost(base);
      await h1.create();
      const h2 = await makeHost(base);   // 新 Core、同 stateDir、同 cell_id
      let err = null;
      try { await h2.svc.create(spec('c1', h2.wsDir), { trusted: true }); } catch (e) { err = e; }
      assertEquals(err?.code, 'state_dir_owned',
        `同进程两个 Core 争同一 stateDir 必须具名拒绝，实际 ${err?.code ?? 'ACCEPTED'}`);
      // 合法重启：旧属主**确认释放之后**，同一个 stateDir 必须能被新的属主接手。
      // 注意同 `cell_id` 是**终态**（close 不是暂停，`resolveAfterRestart('stopped')` 仍是 stopped），
      // 所以这里用另一个 cell 身份验证“锁真的还回去了”—— 那才是这条判据要证明的事。
      const closed = await h1.svc.close('c1', {});
      assertEquals(closed.cleanup_done, true, `旧属主必须干净关闭，实际 ${JSON.stringify(closed)}`);
      assertEquals(existsSync(join(base, 'state', 'cells', 'owner.lock')), false, '旧属主关闭必须真的释放属主锁');
      const st = await h2.svc.create(spec('c9', h2.wsDir), { trusted: true });
      assertEquals(st.state, 'ready', '旧属主关闭后，同 stateDir 必须能被新的属主接手（锁已释放）');
      assertEquals(h2.svc.describe('c9').incarnation_id, st.incarnation_id, '接手的是新的 incarnation');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.32/RC31-D1 被拒的 create 不得把 stateDir 弄成永久 owned', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base);
      // 工作区不存在：在拿锁之前就被拒（这一步一个字节都不写）。
      let early = null;
      try { await host.svc.create(spec('c1', join(base, 'nope')), { trusted: true }); } catch (e) { early = e.code; }
      assert(early, '工作区不存在必须被拒');
      // 然后合法的 create 必须成功 —— 早拒不能留下任何残留资源。
      const st = await host.svc.create(spec('c1', host.wsDir), { trusted: true });
      assertEquals(st.state, 'ready', '早拒之后合法 create 必须成功（不得 state_dir_owned）');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
}
