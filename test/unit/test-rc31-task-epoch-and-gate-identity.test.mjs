// rc.31 —— rc.30 独立复审给出的 K30-01 / K30-02 的正式回归判据。
//
// 两条反例是**同一个错误的两个面**：把一个"身份"当成了"票据"。
//   K30-01  `sessionId` 是 Cell 的**身份**，在 Cell 活着的整段时间里不变。执行器却拿它当
//           "这一次调用属于哪个任务"的凭据。于是任务 A 留下的迟到回调，在任务 B 执行期间
//           拿同一个字符串、得到同一个 `ok:true`，借到了 B 的授权并真的写盘。
//   K30-02  一条**活着的**租约证明了"有人要过门"，但没有证明"这就是 Cell 当初装的那道门"。
//           同名 owner 用新回执覆盖旧租约的 key 之后，`describe().capability_gate.live=false`
//           与 `lease.live=true` 可以同时成立 —— 存在性被当成了身份。
//
// 修法不是一个更强的判断，而是**换一个主语**：
//   K30-01  任务票据由 `cell-runtime.execute()` 自己签发（ALS），调用方只能读，模型给的
//           `args` 进不了那条通道。判据从"同一个会话"变成"同一次执行"。
//   K30-02  判据从"有没有活租约"变成"活着的是不是那一条"：实例身份 + 回执 token + 租约 key
//           三者都要对上，`cell-runtime` 交出它自己登记的那组，执行器拿回来核。
//
// 边界（诚实）：真 Core / 真 workspace / 真 cell-runtime / 真 tool-executor / 真写盘。
// 反例走的是**本进程内有权调用 ToolExecutor 的宿主/插件 API**，并**不**声称普通模型能
// 随意安排脱离执行 Promise 的回调 —— 这条前提与专家原文一致，写进 §5 的"不声称"清单。
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
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
 * 真装配。`onChat` 由每个用例自己安排，因为两条反例的差别正在于**回调在什么时候跑**。
 *
 * 执行器一律 `new` 新实例：模块单例跨用例复用会撞上"已绑定另一 Core 不得重入"的合同。
 */
async function makeHost(base, { executor = 'real' } = {}) {
  const { Core } = await imp('src/core/core.js');
  const wsDir = join(base, 'ws');
  mkdirSync(wsDir, { recursive: true });
  const core = new Core({ stateDir: join(base, 'state') });
  core.log = () => {};
  core.setData('agent.workDir', wsDir);
  await (await imp('plugins/workspace.js')).default.init(core);

  core.registerCapability('tool.read', { owner: 'test', handler: async () => ({ ok: true, value: 'R' }) });
  // **真的写盘**：这就是"未经授权的 tool-write 会造成的副作用"。
  core.registerCapability('tool.write', {
    owner: 'test',
    handler: async () => { writeFileSync(join(wsDir, 'written.txt'), 'x'); return { ok: true }; },
  });

  const rt = (await imp('plugins/cell-runtime.js')).default;
  await rt.init(core);

  const ctx = { exec: null, onChat: null, last: null };
  core.registerCapability('chat.handle', {
    owner: 'test',
    handler: async (params) => {
      if (ctx.onChat) return ctx.onChat(params);
      return { reply: 'no tool calls' };
    },
  });

  const Cls = (await imp('plugins/tool-executor.js')).default.constructor;
  if (executor === 'real') {
    ctx.exec = new Cls();
    await ctx.exec.init(core);
  }

  return {
    core, wsDir, ctx,
    svc: core.getService('cell-runtime'),
    create(over = {}) { return this.svc.create(spec('c1', wsDir, over), { trusted: true }); },
    run(taskId, over = {}) {
      this.svc.accept('c1', task(taskId, 'c1', over));
      return this.svc.execute('c1', null, {});
    },
  };
}

const tmp = () => mkdtempSync(join(tmpdir(), 'rc31-epoch-'));
const wrote = (host) => existsSync(join(host.wsDir, 'written.txt'));

/** 统一的"这次派发必须被拒"：非成功 + 有名有姓 + 零写盘。 */
function assertRefused(host, r, where, expectCode = null) {
  assertEquals(r?.ok, false, `${where}：必须被拒，实际 ${JSON.stringify(r).slice(0, 220)}`);
  assert(typeof r?.code === 'string' && r.code.length > 0,
    `${where}：拒绝必须具名（code），实际 ${JSON.stringify(r).slice(0, 220)}`);
  if (expectCode) assertEquals(r.code, expectCode, `${where}：拒绝理由必须是 ${expectCode}，实际 ${r.code}`);
  assertEquals(wrote(host), false, `${where}：拒绝必须发生在副作用之前 —— 磁盘不得有写入`);
  return r;
}

export default async function (runner) {
  // ══ K30-01：旧任务的授权不得被下一个任务继承 ══════════════════════════
  runner.test('rc.31/K30-A1 任务 A 结束后、任务 B 开始前：同一 session 的工具调用必须按“无任务”拒绝', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base);
      await host.create();
      // A 正常跑完（不做任何工具调用），Cell 回到 ready。
      const a = await host.run('A', { required_capabilities: ['tool.read'] });
      assertEquals(a.execution_state, 'succeeded', `前置：任务 A 必须成功，实际 ${a.execution_state}`);
      assertEquals(host.svc.describe('c1').state, 'ready', '前置：A 结束后 Cell 回到 ready');

      // **反例本体之一**：A 与 B 之间的空隙。旧版这里 `ok:true` —— 因为 A 的 `gateAllowed`
      // 还钉在登记记录上，"没有活跃任务"根本没有被当成判据。
      const between = await host.ctx.exec.executeOne('tool-read', {}, 'cell-c1');
      assertRefused(host, between, 'A 与 B 之间', 'task_scope_required');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.31/K30-A2 A 的迟到回调落在 B 执行期：只能拿到 stale_task_epoch，零写盘（专家主反例）', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base);
      await host.create();

      let releaseOld; const oldArmed = new Promise((res) => { releaseOld = res; });
      let oldResult = null;
      let signalB; const bStarted = new Promise((res) => { signalB = res; });
      let finishB; const bDone = new Promise((res) => { finishB = res; });

      host.ctx.onChat = async ({ message, sessionId }) => {
        if (message === 'goal A') {
          // A 里安排一条**脱离执行 Promise** 的回调：它捕获的是 A 的异步上下文。
          oldArmed.then(async () => { oldResult = await host.ctx.exec.executeOne('tool-write', {}, sessionId); });
          return { reply: 'A done, detached callback armed' };
        }
        if (message === 'goal B') {
          signalB();
          await bDone;
          return { reply: 'B done' };
        }
        return { reply: 'other' };
      };

      // 任务 A 只授权 tool.read；写完就结束，Cell 回 ready。
      const a = await host.run('A', { required_capabilities: ['tool.read'] });
      assertEquals(a.execution_state, 'succeeded', `前置：A 必须成功，实际 ${a.execution_state}`);
      assertEquals(wrote(host), false, '前置：A 自己不得写盘');

      // 任务 B 授权 tool.write，进入 busy 但**不结束**。
      host.svc.accept('c1', task('B', 'c1', { required_capabilities: ['tool.write'] }));
      const bPromise = host.svc.execute('c1', null, {});
      await bStarted;

      // 现在放开 A 的迟到回调：它带着 A 的票据，但 B 正在用同一 session 执行。
      releaseOld();
      await new Promise((r) => setTimeout(r, 60));
      assertRefused(host, oldResult, 'B 执行期触发 A 的迟到回调', 'stale_task_epoch');

      finishB();
      const b = await bPromise;
      assertEquals(b.execution_state, 'succeeded', `前提：B 自己必须正常结束，实际 ${b.execution_state}`);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.31/K30-A3 B 自身在任务内用它的授权能力：必须照常执行并真的写盘（不得连坐）', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base);
      await host.create();
      host.ctx.onChat = async ({ sessionId }) => {
        host.ctx.last = await host.ctx.exec.executeOne('tool-write', {}, sessionId);
        return { reply: 'wrote inside task' };
      };
      const r = await host.run('B', { required_capabilities: ['tool.write'] });
      assertEquals(r.execution_state, 'succeeded', `任务内派发必须成功，实际 ${r.execution_state}`);
      assertEquals(host.ctx.last?.ok, true, `任务内派发不得被任务判据误伤，实际 ${JSON.stringify(host.ctx.last).slice(0, 200)}`);
      assertEquals(wrote(host), true, '任务内授权调用必须真的写盘 —— 否则只是“一律拒绝”');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.31/K30-A4 两个任务的能力交集相同也不得混淆归属：A 的回调仍必须是 stale_task_epoch', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base);
      await host.create();
      // 两个任务都授权 tool.write —— 这一条专门排除"因为能力不同所以被拒"的解释。
      let releaseOld; const armed = new Promise((res) => { releaseOld = res; });
      let oldResult = null;
      let signalB; const bStarted = new Promise((res) => { signalB = res; });
      let finishB; const bDone = new Promise((res) => { finishB = res; });
      host.ctx.onChat = async ({ message, sessionId }) => {
        if (message === 'goal A') {
          armed.then(async () => { oldResult = await host.ctx.exec.executeOne('tool-write', {}, sessionId); });
          return { reply: 'A armed' };
        }
        if (message === 'goal B') { signalB(); await bDone; return { reply: 'B done' }; }
        return { reply: 'other' };
      };

      await host.run('A', { required_capabilities: ['tool.write'] });
      assertEquals(wrote(host), false, '前置：A 只安排了回调，自己没有写');

      host.svc.accept('c1', task('B', 'c1', { required_capabilities: ['tool.write'] }));
      const bPromise = host.svc.execute('c1', null, {});
      await bStarted;
      releaseOld();
      await new Promise((r) => setTimeout(r, 60));

      assertRefused(host, oldResult, '同能力交集下 A 的迟到回调', 'stale_task_epoch');
      finishB();
      await bPromise;
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.31/K30-A5 撤销/关闭/重试都不得让旧票据复活：close 后 A 的回调必须按生命周期拒绝', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base);
      await host.create();
      let releaseOld; const armed = new Promise((res) => { releaseOld = res; });
      let oldResult = null;
      host.ctx.onChat = async ({ message, sessionId }) => {
        if (message === 'goal A') {
          armed.then(async () => { oldResult = await host.ctx.exec.executeOne('tool-write', {}, sessionId); });
          return { reply: 'A armed' };
        }
        return { reply: 'other' };
      };
      await host.run('A', { required_capabilities: ['tool.write'] });
      await host.svc.close('c1', {});

      releaseOld();
      await new Promise((r) => setTimeout(r, 60));
      // 生命周期比任务维度更靠前：已关闭时说"没有任务"是次要的，说"资格已撤"才是处置依据。
      assertRefused(host, oldResult, '关闭后 A 的迟到回调', 'execution_revoked');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.31/K30-A6 任务凭据是签发的，不是自报的：args/_sessionId/模型可见字段都伪造不出它', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base);
      await host.create();
      // 先跑一个**真的授权 tool.write** 的任务：否则更靠前的 pre-hook 会先按能力不足拒
      // （`capability_denied`），测到的就不是任务维度了。
      await host.run('A', { required_capabilities: ['tool.read', 'tool.write'] });
      // 任务之外调用，并把所有"看起来像控制字段"的东西都填上。它们进不了 ALS 通道。
      const forged = await host.ctx.exec.executeOne('tool-write', {
        _taskId: 'A', _attempt: 1, _cellId: 'c1', _epoch: 1, _sessionId: 'cell-c1',
      }, 'cell-c1');
      assertRefused(host, forged, '自报任务字段', 'task_scope_required');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.31/K30-A7 普通会话不受任务维度影响：无 Cell 归属的会话照常执行并写盘', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base);
      await host.create();
      // 非 Cell 会话既没有登记记录，也没有任何任务票据 —— 它本来就不该被这套判据管。
      const plain = await host.ctx.exec.executeOne('tool-write', {}, 'rest_api_session');
      assertEquals(plain?.ok, true, `普通会话不得被误伤，实际 ${JSON.stringify(plain).slice(0, 200)}`);
      assertEquals(wrote(host), true, '普通会话应当真的写盘');
      assertEquals(host.svc.dispatchEligibility('rest_api_session', null), null,
        '非 Cell 会话的派发判决必须是 null（"不知道"不是"不允许"）');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.31/K30-A8 重试 attempt 不得恢复旧执行凭据：同一 task_id 的第二次 attempt 拿不到上一次的票', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base);
      await host.create();
      // 第一趟：把票据交出去，但不立即用掉（模拟一条活到下一次尝试的回调）。
      let releaseOld; const armed = new Promise((res) => { releaseOld = res; });
      let oldResult = null;
      let signalB; const bStarted = new Promise((res) => { signalB = res; });
      let finishB; const bDone = new Promise((res) => { finishB = res; });
      let calls = 0;
      host.ctx.onChat = async ({ sessionId }) => {
        calls++;
        if (calls === 1) {
          // 第一趟：把票据交出去，但不立即用掉（模拟一条活到下一次尝试的回调）。
          armed.then(async () => { oldResult = await host.ctx.exec.executeOne('tool-write', {}, sessionId); });
          return { reply: 'attempt-1 armed' };
        }
        signalB();
        await bDone;
        return { reply: 'attempt-2 done' };
      };

      // attempt 1 正常完成。
      const t1 = await host.run('T', { required_capabilities: ['tool.write'] });
      assertEquals(t1.execution_state, 'succeeded', `前置：attempt-1 必须成功，实际 ${t1.execution_state}`);
      assertEquals(t1.attempt, 1, '前置：第一次是 attempt 1');

      // 同一 task_id 的 attempt 2（Cell 自己不能并发，所以先确认它真的能接下一个任务）。
      host.svc.accept('c1', task('T', 'c1', { attempt: 2, required_capabilities: ['tool.write'] }));
      const bPromise = host.svc.execute('c1', null, {});
      await bStarted;

      releaseOld();
      await new Promise((r) => setTimeout(r, 60));
      // 两个任务的 task_id **相同**，所以这一条不能靠 taskId 区分 ——
      // 必须由 epoch 把它拉开。这正是“重试不得恢复旧凭据”的最小形状。
      assertRefused(host, oldResult, 'attempt-1 的迟到回调在 attempt-2 执行期', 'stale_task_epoch');

      finishB();
      const t2 = await bPromise;
      assertEquals(t2.execution_state, 'succeeded', `前提：attempt-2 自己必须正常结束，实际 ${t2.execution_state}`);
      assertEquals(t2.attempt, 2, '前提：第二次确实是 attempt 2');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  // ══ K30-02：活租约的"存在"不等于原授权门的"身份" ═══════════════════
  /** 复刻专家的替身：摘掉原钩子，再用**同名 owner** 装一条无约束的门并覆盖租约 key。 */
  const forgeGate = (host) => {
    const exec = host.ctx.exec;
    exec.removeHooksByOwner('cell:c1');
    const pre = exec.registerPreHook(() => undefined, 'cell:c1');
    const dispatch = exec.registerDispatchHook(() => undefined, 'cell:c1');
    exec.leaseGuard('cell:c1', 'cell-c1', { pre, dispatch });
    return exec.describe ? null : null;
  };

  runner.test('rc.31/K30-B1 原门被摘、同名无约束替身租约活着：必须仍拒且零写盘（专家主反例）', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base);
      await host.create({ capabilities: ['tool.read'], permission_mode: 'read-only' });

      // 前置：原门此刻是活的，替身还没来。
      const gate0 = host.svc.describe('c1').capability_gate;
      assertEquals(gate0.live, true, '前置：原门必须是活的');

      forgeGate(host);
      const gate1 = host.svc.describe('c1').capability_gate;
      // 这两个数同时为真，正是反例的观测特征 —— 先断言它，免得测的是别的东西。
      assertEquals(gate1.live, false, '前置：替身换上之后原门必须报"不在"');
      assertEquals(gate1.lease_live, true, '前置：同名租约必须报"活着"（否则测不到本条的窗口）');

      const r = await host.ctx.exec.executeOne('tool-write', {}, 'cell-c1');
      assertRefused(host, r, '同名无约束替身', 'cell_gate_unavailable');
      // 理由必须点明"身份"而不是"没有租约" —— 租约是有的，问题恰恰在于它不是那道门。
      assert(/different lease|not this Cell|existence is not identity|receipts are no longer live|never installed/i.test(String(r.error || '')),
        `拒绝理由必须说明是门身份问题，实际：${String(r.error).slice(0, 300)}`);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.31/K30-B2 原门活着时：授权能力照常执行（门身份判据不得把正常装配也拒掉）', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base);
      await host.create();
      const gate = host.svc.describe('c1').capability_gate;
      assertEquals(gate.live, true, '前置：门必须是活的');
      assertEquals(gate.lease_live, true, '前置：租约必须是活的');

      host.ctx.onChat = async ({ sessionId }) => {
        host.ctx.last = await host.ctx.exec.executeOne('tool-write', {}, sessionId);
        return { reply: 'wrote' };
      };
      const r = await host.run('T', { required_capabilities: ['tool.write'] });
      assertEquals(r.execution_state, 'succeeded', `正当装配必须能执行，实际 ${r.execution_state}`);
      assertEquals(host.ctx.last?.ok, true, `原门活着时不得拒，实际 ${JSON.stringify(host.ctx.last).slice(0, 200)}`);
      assertEquals(wrote(host), true, '原门活着时必须真的写盘');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.31/K30-B3 故障后合法重装形成新一代门：恢复可用（拒绝不等于永久废掉）', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base);
      await host.create();
      // 制造一次真实故障：摘掉整族钩子。
      host.ctx.exec.removeHooksByOwner('cell:c1');
      assertEquals(host.svc.describe('c1').capability_gate.live, false, '前置：门已不在');

      // 唯一合法的恢复入口：一次真的重新装配。
      host.core.emit('core:plugin.loaded', { pluginName: 'tool-executor', sourcePlugin: 'test' });
      const gate = host.svc.describe('c1').capability_gate;
      assertEquals(gate.live, true, '重新装配之后门必须重新落地');
      assertEquals(gate.lease_live, true, '租约必须跟着新回执重建');
      assert(gate.reinstalls >= 1, `describe 必须报出重装次数，实际 ${gate.reinstalls}`);

      host.ctx.onChat = async ({ sessionId }) => {
        host.ctx.last = await host.ctx.exec.executeOne('tool-write', {}, sessionId);
        return { reply: 'wrote after reassembly' };
      };
      const r = await host.run('T2', { required_capabilities: ['tool.write'] });
      assertEquals(r.execution_state, 'succeeded', `重装之后必须恢复执行，实际 ${r.execution_state}`);
      assertEquals(host.ctx.last?.ok, true, `重装之后不得拒，实际 ${JSON.stringify(host.ctx.last).slice(0, 200)}`);
      assertEquals(wrote(host), true, '恢复必须落到真实副作用，不能只是 live:true');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.31/K30-B4 旧回执不得在新执行器实例上通行：换实例即失效', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base);
      await host.create();
      const gateId = host.svc.gateIdentity('cell-c1');
      assertEquals(gateId.installed, true, '前置：门必须已装');
      assertEquals(typeof gateId.instance, 'string', '门身份必须带出实例身份');

      // 另一台执行器实例（**不 init**：同一个 Core 上二次 init 会撞能力登记冲突，
      // 那条冲突是保护，与本条无关）。它自带新的 `_instanceId`，旧回执在它这儿一条都核不过。
      const Cls = (await imp('plugins/tool-executor.js')).default.constructor;
      const other = new Cls();
      other.core = host.core;
      assertEquals(other._instanceId === gateId.instance, false, '前置：两台执行器的实例身份必须不同');

      // ① 回执层：旧回执在新实例上必须报 wrong_instance。
      for (const [kind, receipt] of Object.entries(gateId.receipts)) {
        const v = other.verifyHook(receipt);
        assertEquals(v.ok, false, `${kind} 旧回执不得在新实例上核过`);
        assertEquals(v.reason, 'wrong_instance', `${kind} 必须报 wrong_instance，实际 ${v.reason}`);
      }
      // ② 门身份层：判据必须拒，且理由指向"另一台执行器"。
      const why = other._gateIdentityFailure(gateId, 'cell-c1');
      assert(typeof why === 'string' && why.length > 0, '换实例之后门身份判据必须拒');
      assert(/different tool-executor instance|executor instance/i.test(why),
        `理由必须指向实例不同，实际：${why.slice(0, 300)}`);
      assertEquals(wrote(host), false, '不得产生写盘');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.31/K30-B5 不同 Cell / 普通会话的租约不得互相充当', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base);
      await host.create();
      const exec = host.ctx.exec;
      // 在**另一个会话**上挂一条完全合法的租约：它会"活着"，但与 cell-c1 无关。
      const p = exec.registerPreHook(() => undefined, 'other-owner');
      const d = exec.registerDispatchHook(() => undefined, 'other-owner');
      exec.leaseGuard('other-owner', 'another-session', { pre: p, dispatch: d });
      assertEquals(exec.guardLeasesFor('another-session').some((l) => l.live), true,
        '前置：另一条租约必须是活的（否则测不到"跨会话代签"）');

      // cell-c1 的门之所以成立，只能因为**它自己**那条租约还在，不能因为"表里有活租约"。
      const gate = host.svc.describe('c1').capability_gate;
      assertEquals(gate.lease?.owner, 'cell:c1', 'describe 必须报本 Cell 的租约，不是别人的');

      // 把本 Cell 的租约撤掉，别人的仍然活着 —— 必须拒。
      host.ctx.exec.removeHooksByOwner('cell:c1');
      const r = await host.ctx.exec.executeOne('tool-write', {}, 'cell-c1');
      assertRefused(host, r, '本 Cell 租约已撤而别处租约仍活', 'cell_gate_unavailable');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  // ══ 跨入口：模型面也必须按同一判决 ═════════════════════════════════
  runner.test('rc.31/K30-C1 haotian 模型工具面复用同一判决：任务之外的 Cell 模型调用同样被拒', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base);
      await host.create();
      const haotian = Object.create((await imp('plugins/haotian-lite.js')).default);
      haotian.core = host.core;
      const history = [];
      // 任务之外（没有任何 ALS 票据）的模型工具调用。
      await haotian._execTools([{ name: 'tool-write', arguments: '{}', id: 'tc1' }], history, 1, 'cell-c1', 'tr');
      const text = history.map((h) => String(h.content)).join('\n');
      assert(/task_scope_required|cell_gate_unavailable|task_not_active/.test(text),
        `模型面必须收到具名拒绝，实际 ${text.slice(0, 300)}`);
      assertEquals(wrote(host), false, '模型面不得产生写入');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.31/K30-C3 宿主发起的认知调用（主动求教）：任务外拒、任务内用当前任务票据通行', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base);
      await host.create();

      // ① 任务之外：没有任何可继承的授权 ⇒ 如实拒绝，且理由指向“没有活跃任务”。
      const outside = host.svc.runInActiveTask('cell-c1', async () => 'should not run');
      assertEquals(outside.ok, false, '任务外不得放行');
      assertEquals(outside.code, 'task_not_active', `理由必须是任务不在活跃，实际 ${outside.code}`);

      // ② 任务之内：同一入口应当真的跑起来，且拿到的是**当前任务**的票据。
      let seen = null;
      host.ctx.onChat = async () => {
        const scoped = host.svc.runInActiveTask('cell-c1', async () => {
          const { currentTask } = await imp('plugins/_lib/call-context.mjs');
          return currentTask();
        });
        seen = scoped.ok ? await scoped.value : { error: scoped.code };
        return { reply: 'asked' };
      };
      const r = await host.run('T', { required_capabilities: ['tool.read'] });
      assertEquals(r.execution_state, 'succeeded', `前置：任务必须成功，实际 ${r.execution_state}`);
      assert(seen && seen.cellId === 'c1', `任务内必须拿到本 Cell 的票据，实际 ${JSON.stringify(seen)}`);
      assertEquals(seen.taskId, 'T', `票据必须指向当前任务，实际 ${seen?.taskId}`);

      // ③ 未登记为 Cell 的会话：返回 unknown_cell，不是一个含糊的“没任务”。
      const other = host.svc.runInActiveTask('not-a-cell', async () => 'x');
      assertEquals(other.ok, false, '非 Cell 会话不得通过');
      assertEquals(other.code, 'unknown_cell', `理由必须是未知 Cell，实际 ${other.code}`);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.31/K30-C2 普通会话的模型工具面不回归：非 Cell 会话照旧执行', async () => {
    const base = tmp();
    try {
      // 与 rc.29/R28-B2 同一前提：**没有执行器**的宿主。有执行器时这条路径要过 legacy 的
      // 受信 principal 判据（R0-81），那是另一条不变式；本条要证的是"任务判据没有误伤普通会话"。
      const host = await makeHost(base, { executor: 'none' });
      await host.create();
      host.core.registerService('tools', {
        get(name) {
          if (name === 'write_file') return { name, _capabilityId: 'tool.write', provides: [{ name: 'tool.write' }] };
          return null;
        },
      });
      // 基础装配里的 `tool.write` 本来就会真写盘，不需要再登记一次
      // （重复登记会撞 `capability_conflict` —— 那是保护，不是障碍）。
      const haotian = Object.create((await imp('plugins/haotian-lite.js')).default);
      haotian.core = host.core;
      const history = [];
      await haotian._execTools([{ name: 'write_file', arguments: '{}', id: 'tc2' }], history, 1, 'plain-session', 'tr');
      const text = history.map((h) => String(h.content)).join('\n');
      assertEquals(wrote(host), true, `非 Cell 会话的 legacy 路径必须保持原样（不得被任务判据误伤）；模型收到：${text.slice(0, 200)}`);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
}
