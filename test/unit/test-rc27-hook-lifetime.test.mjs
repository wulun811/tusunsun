// rc.27 —— Hook 接点的**全生命周期存续**（H26-01 / H26-02 / H26-03 的回归判据）。
//
// 为什么需要这一份：rc.26 之前所有“Cell 能力门”用例验证的都是**门装上之后**的行为，没有一条
// 判据回答“门到底装上了没有”“装完还在不在”。于是三个真实缺陷可以同时存在而全绿：
//   H26-01 先建 Cell、后装执行器 ⇒ 创建报 created，却一条门都没有；
//   H26-02 执行器重复 init ⇒ 先清空派发期钩子，再因能力冲突失败（留下半个执行器）；
//   H26-03 派发期钩子返回 rejected Promise ⇒ 决策正确，但进程级多一个 unhandledRejection。
//
// 边界（诚实）：真实的 Core / tool-executor / cell-runtime / workspace，真实的钩子表与事件，
// 真的写盘。工具实现用 test 注册的 `tool.write`（真写文件），不是 plugins/tools/tool-write.js
// —— 那份还要装配 tool-registry/tool-guard，与本案判据无关；判据看的是“门在不在、拦不拦”。
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TestRunner, assert, assertEquals } from '../harness.mjs';

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
  goal: 'write one file',
  inputs: [],
  required_capabilities: ['tool.write'],
  budget: { max_steps: 5, wall_ms: 30000 },
  acceptance: { required_artifacts: [], checks: [] },
  ...over,
});

/**
 * 造一套真装配。`ctx.exec` 是**可变**的：H26-01 的形态就是“创建时还没有执行器”。
 *
 * 执行器一律 `new` 一个新实例（不从模块单例取）：插件默认导出是单例，跨用例复用同一个实例
 * 会撞上“已绑定另一 Core 不得重入”的新合同，而那是 rc.27 特意加的保护，不是被测对象。
 */
async function makeHost(base, { executor = 'real' } = {}) {
  const { Core } = await imp('src/core/core.js');
  const wsDir = join(base, 'ws');
  mkdirSync(wsDir, { recursive: true });
  const core = new Core({ stateDir: join(base, 'state') });
  core.log = () => {};
  core.setData('agent.workDir', wsDir);
  await (await imp('plugins/workspace.js')).default.init(core);
  core.registerCapability('tool.read', { owner: 'test', handler: async () => ({ ok: true }) });
  // **真的写盘**：这条能力就是“未经授权的 tool-write 会造成的副作用”。
  core.registerCapability('tool.write', {
    owner: 'test',
    handler: async (args) => { writeFileSync(join(args.dir, 'written.txt'), 'x'); return { ok: true }; },
  });
  const rt = (await imp('plugins/cell-runtime.js')).default;
  await rt.init(core);

  const ctx = { exec: null, toolResult: null, chatSession: null };
  // 执行链末端：cell.execute → core.command('chat.handle') → 这次工具调用。
  core.registerCapability('chat.handle', {
    owner: 'test',
    handler: async (params) => {
      ctx.chatSession = params?.sessionId ?? null;
      ctx.toolResult = await ctx.exec.executeOne('tool-write', { dir: wsDir, content: 'x' }, params?.sessionId);
      return { reply: 'attempted tool-write' };
    },
  });

  const Cls = (await imp('plugins/tool-executor.js')).default.constructor;
  if (executor === 'real') {
    ctx.exec = new Cls();
    await ctx.exec.init(core);
  } else if (executor === 'crippled') {
    // 有 pre 接点、没有派发期接点：门永远只能装一半。
    ctx.exec = { registerPreHook() {}, removeHooksByOwner() {} };
    core.registerService('tool-executor', ctx.exec);
  } else if (executor === 'liar') {
    // 三个接点都在、也接受注册，但**核账永远报 0**：装没装上它说了不算。
    const hooks = [];
    ctx.exec = {
      registerPreHook(fn, owner) { hooks.push({ stage: 'pre', fn, owner }); },
      registerDispatchHook(fn, owner) { hooks.push({ stage: 'dispatch', fn, owner }); },
      removeHooksByOwner(owner) { for (let i = hooks.length - 1; i >= 0; i--) if (hooks[i].owner === owner) hooks.splice(i, 1); },
      hookCountFor() { return { pre: 0, post: 0, dispatch: 0 }; },
      // 回执核账也撒谎：接受注册、却否认表里有这一条（rc.28 起判据就是它）。
      verifyHook() { return { ok: false, reason: 'not_registered' }; },
      // rc.29 起 `leaseGuard` 是**必需接点**（没有它就无法在派发期发现“门被摘了”）。
      // 这个桩要测的是“装完核账不过”，所以它得在场——否则会在更靠前的一层被拒。
      leaseGuard() { return { key: 'fake', release() {} }; },
    };
    core.registerService('tool-executor', ctx.exec);
  }

  return {
    core, wsDir, ctx,
    svc: core.getService('cell-runtime'),
    wsSvc: core.getService('workspace'),
    /** 迟到装配：把真执行器装进来（H26-01 的触发动作）。 */
    async installExecutor() {
      ctx.exec = new Cls();
      await ctx.exec.init(core);
      return ctx.exec;
    },
    /** 建一个 Cell。`trusted` 由**宿主**给（测试代码就是宿主），与 CLI 同一条路径。 */
    create(over = {}) {
      return this.svc.create(spec('c1', wsDir, over), { trusted: true });
    },
  };
}

async function runTask(host, cellId, taskId, over = {}) {
  host.svc.accept(cellId, task(taskId, cellId, over));
  return host.svc.execute(cellId, null, {});
}

function tmp() {
  return mkdtempSync(join(tmpdir(), 'rc27-hook-'));
}

/** 装上“未处理拒绝”监听：H26-03 的判据就是它在派发之后必须仍然为空。 */
function watchRejections() {
  const seen = [];
  const onRej = (e) => seen.push(e);
  process.on('unhandledRejection', onRej);
  return {
    seen,
    // 未处理拒绝是**下一轮事件循环**才报到进程的：必须等过一轮，不能同步断言。
    async settle() { await new Promise((r) => setTimeout(r, 60)); },
    stop() { process.off('unhandledRejection', onRej); },
  };
}

export default async function (runner) {
  // ── H26-01 ────────────────────────────────────────────────────────
  runner.test('rc.27/H26-01a 先建只读 Cell、后装执行器：第一次执行之前必须补上门，tool.write 不得写盘', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base, { executor: 'none' });
      // 反例的真实形状：只读 Cell 只被授予 tool.read，执行器此时根本不在。
      await host.create({ capabilities: ['tool.read'], permission_mode: 'read-only' });
      assertEquals(host.svc.list().length, 1, 'Cell 必须创建成功（执行器缺席不是创建错误）');
      assertEquals(host.svc.describe('c1').capability_gate.installed, false, '此刻还没有门，状态必须说实话');

      await host.installExecutor();
      const r = await runTask(host, 'c1', 't1', { required_capabilities: ['tool.read'] });

      assertEquals(host.ctx.chatSession, 'cell-c1', '判据必须作用在 Cell 的内部会话上');
      assertEquals(host.ctx.toolResult?.ok, false, '只读 Cell 的 tool.write 必须被拒');
      assertEquals(host.ctx.toolResult?.code, 'permission_denied', '拒绝理由必须是只读门');
      assertEquals(existsSync(join(host.wsDir, 'written.txt')), false, '磁盘上不得出现任何写入');
      assertEquals(host.svc.describe('c1').capability_gate.installed, true, '执行前必须补上门');
      assertEquals(r.execution_state, 'succeeded', '任务本身可以完成（工具调用被拒不等于任务失败）');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.27/H26-01b 执行器在、但缺派发期接点：create 必须具名拒绝，且不留半个 Cell', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base, { executor: 'crippled' });
      let err = null;
      try { await host.create(); } catch (e) { err = e; }
      assert(err, '缺接点时创建必须失败');
      assertEquals(err.code, 'cell_gate_unavailable', '必须具名 cell_gate_unavailable');
      assertEquals(host.svc.list().length, 0, '失败的 create 不得在登记表里留下 Cell');
      assertEquals(host.wsSvc.has('cell-c1'), false, '失败的 create 不得留下工作区绑定');
      let de = null;
      try { host.svc.describe('c1'); } catch (e) { de = e; }
      assertEquals(de?.code, 'unknown_cell', 'describe 必须报 unknown_cell（不能给出半个 Cell 的状态）');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.27/H26-01c 装完门要核账：hookCountFor 报 0 时 create 失败、绑定退掉、钩子回滚', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base, { executor: 'liar' });
      let err = null;
      try { await host.create(); } catch (e) { err = e; }
      assertEquals(err?.code, 'cell_gate_unavailable', '核账不通过必须具名拒绝');
      assert(/did not land/.test(err.message), `理由必须说清是“没落地”：${err.message}`);
      assertEquals(host.svc.list().length, 0, '失败不留登记');
      assertEquals(host.wsSvc.has('cell-c1'), false, '失败不留工作区绑定');
      assert(/pre=not_registered/.test(err.message), '拒绝理由必须带可核对的回执状态');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.27/H26-01d describe 必须报门的真实状态，不以“场景里有执行器”代替“已接线”', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base, { executor: 'real' });
      await host.create();
      const gate = host.svc.describe('c1').capability_gate;
      assertEquals(gate.installed, true, 'installed 必须为真');
      assertEquals(gate.owner, 'cell:c1', 'owner 必须是这个 Cell');
      assertEquals(gate.pre, 1, 'pre 钩子必须恰好一条');
      assertEquals(gate.dispatch, 1, '派发期钩子必须恰好一条（不能只装 pre）');
      assert(gate.generation >= 1, '代际必须是正数');
      assertEquals(gate.executor_present, true, '执行器必须在场');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  // ── H26-02 ────────────────────────────────────────────────────────
  runner.test('rc.27/H26-02a 同一 Core 重复 init：幂等早退，派发期钩子与判据原样在位', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base, { executor: 'real' });
      await host.create({ capabilities: ['tool.read'] });
      const owner = 'cell:c1';
      const before = host.ctx.exec.hookCountFor(owner);
      assertEquals(before.dispatch, 1, '前提：派发期钩子已在表里');

      // 反例的真实形状：对同一实例再来一次 init（旧版这里会抛 capability_conflict）。
      await host.ctx.exec.init(host.core);
      const after = host.ctx.exec.hookCountFor(owner);
      assertEquals(after.pre, before.pre, 'pre 钩子不得被初始化清掉');
      assertEquals(after.dispatch, before.dispatch, '**派发期钩子尤其不得被清掉**');

      const r = await runTask(host, 'c1', 't1', { required_capabilities: ['tool.read'] });
      assertEquals(host.ctx.toolResult?.ok, false, '门必须仍然有效：未授权的 tool.write 照样被拒');
      assertEquals(existsSync(join(host.wsDir, 'written.txt')), false, '磁盘上不得出现写入');
      assert(r, '执行必须返回结果而不是崩掉');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.27/H26-02b init 中途失败：钩子表按快照回滚，不留半个执行器', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base, { executor: 'none' });
      const ExecCls = (await imp('plugins/tool-executor.js')).default.constructor;
      const exec = new ExecCls();
      // 一个已经装上门的执行器（模拟真实运行中）：两条钩子都必须在失败后存活。
      exec.registerPreHook(() => undefined, 'cell:c1', 10, { failClosed: true });
      exec.registerDispatchHook(() => undefined, 'cell:c1');
      // 让 init 在中途失败：`action.inspect` 已被别的 owner 占用 ⇒ registerCapability 抛冲突。
      host.core.registerCapability('action.inspect', { owner: 'other', handler: async () => ({}) });
      let err = null;
      try { await exec.init(host.core); } catch (e) { err = e; }
      assert(err, 'init 必须失败');
      const counts = exec.hookCountFor('cell:c1');
      assertEquals(counts.pre, 1, '失败后 pre 钩子必须原样在位');
      assertEquals(counts.dispatch, 1, '失败后派发期钩子必须原样在位（旧版这里已被清零）');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.27/H26-02c 门被从执行器侧摘掉：accept 必须直接拒，不等派发期才发现', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base, { executor: 'real' });
      await host.create();
      // 模拟“重装配/重载把钩子摘掉”的后果：门没了，Cell 自己并不知道。
      host.ctx.exec.removeHooksByOwner('cell:c1');
      let err = null;
      try { host.svc.accept('c1', task('t1', 'c1')); } catch (e) { err = e; }
      assertEquals(err?.code, 'cell_gate_unavailable', 'accept 必须具名拒绝');
      assert(/not_registered/.test(err.message), `拒绝理由必须带回执失效原因：${err.message}`);
      assertEquals(existsSync(join(host.wsDir, 'written.txt')), false, '未执行就必须没有写入');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  // ── H26-03 ────────────────────────────────────────────────────────
  runner.test('rc.27/H26-03a 异步派发钩子 reject：决策 HOOK_ERROR，且不产生 unhandledRejection', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base, { executor: 'real' });
      host.ctx.exec.registerDispatchHook(async () => { throw new Error('ASYNC_DISPATCH_REJECTION'); }, 'async-owner');
      const watch = watchRejections();
      let r = null;
      try {
        r = await host.ctx.exec.executeOne('tool-write', { dir: host.wsDir }, 'plain-session');
        await watch.settle();
      } finally { watch.stop(); }
      assertEquals(r?.ok, false, '必须拒绝');
      assertEquals(r?.code, 'HOOK_ERROR', '拒绝码必须可区分“判据坏了”与“策略拒绝”');
      assertEquals(watch.seen.length, 0, `不得留下进程级 unhandledRejection：${watch.seen.map(String).join('; ')}`);
      assertEquals(existsSync(join(host.wsDir, 'written.txt')), false, '拒绝即不派发：不得写盘');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.27/H26-03b then getter 抛错的恶意 thenable：同步拒绝，不把复核自己炸掉', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base, { executor: 'real' });
      host.ctx.exec.registerDispatchHook(() => ({ get then() { throw new Error('HOSTILE_THENABLE'); } }), 'hostile-owner');
      const watch = watchRejections();
      let r = null;
      try {
        r = await host.ctx.exec.executeOne('tool-write', { dir: host.wsDir }, 'plain-session');
        await watch.settle();
      } finally { watch.stop(); }
      assertEquals(r?.ok, false, '取不到 then 就等于无法证明它是同步的 ⇒ 必须拒绝');
      assertEquals(r?.code, 'HOOK_ERROR', '拒绝码必须是 HOOK_ERROR');
      assertEquals(watch.seen.length, 0, '不得留下未处理拒绝');
      assertEquals(existsSync(join(host.wsDir, 'written.txt')), false, '不得写盘');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.27/H26-03c 派发钩子五种返回形状的语义：fulfilled/rejected/sync-throw/sync-block/sync-allow', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base, { executor: 'real' });
      const exec = host.ctx.exec;
      const run = async () => exec.executeOne('tool-write', { dir: host.wsDir }, 'plain-session');

      // ① fulfilled Promise：仍然是“做不了此刻的判定”，必须拒绝。
      exec.registerDispatchHook(async () => undefined, 'k1');
      let r = await run();
      assertEquals([r.ok, r.code].join('/'), 'false/HOOK_ERROR', 'fulfilled Promise 也必须拒绝');
      exec.removeHooksByOwner('k1');

      // ② rejected Promise：同上，且不得留 unhandledRejection。
      const watch = watchRejections();
      try {
        exec.registerDispatchHook(async () => { throw new Error('REJECTED'); }, 'k2');
        r = await run();
        await watch.settle();
      } finally { watch.stop(); }
      assertEquals([r.ok, r.code].join('/'), 'false/HOOK_ERROR', 'rejected Promise 必须拒绝');
      assertEquals(watch.seen.length, 0, 'rejected Promise 不得逃到进程级');
      exec.removeHooksByOwner('k2');

      // ③ 同步 throw：判据坏了 ⇒ fail-closed。
      exec.registerDispatchHook(() => { throw new TypeError('sync boom'); }, 'k3');
      r = await run();
      assertEquals([r.ok, r.code].join('/'), 'false/HOOK_ERROR', '同步抛错必须 fail-closed');
      exec.removeHooksByOwner('k3');

      // ④ 同步拒绝：策略拒绝，不是 HOOK_ERROR。
      exec.registerDispatchHook(() => ({ block: true, reason: 'policy says no', code: 'capability_denied' }), 'k4');
      r = await run();
      assertEquals([r.ok, r.code].join('/'), 'false/capability_denied', '策略拒绝必须原样传出，不得折成 HOOK_ERROR');
      exec.removeHooksByOwner('k4');

      // ⑤ 同步允许：必须真的执行（否则“拒绝一切”也能让前四条全绿）。
      exec.registerDispatchHook(() => undefined, 'k5');
      r = await run();
      assertEquals(r.ok, true, `同步允许时必须真的执行：${JSON.stringify(r).slice(0, 200)}`);
      assertEquals(existsSync(join(host.wsDir, 'written.txt')), true, '允许即派发：写盘必须真的发生');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
}
