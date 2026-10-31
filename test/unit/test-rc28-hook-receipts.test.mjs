// rc.28 —— 钩子资格从“函数名存在”升级为**可审计的注册回执**（token / 实例 / 代际 / 归属）。
//
// 为什么这一版要做：专家 rc.26 复审的后置项写的是“把 Hook 资格从‘是否存在函数名’提升为
// 可审计的注册 token/owner/装配代际/执行器实例绑定”。rc.27 只做了半个：`hookCountFor` 能数
// “这个 owner 有几条”，但数出来的 1 可能来自**别人的同 owner 登记**，也可能来自一个已经换了代
// 的旧表 —— 装配方仍然在相信一句自述。
//
// 本文件的判据全部是“回执还能不能认”：`verifyHook` 逐条回答 同实例 / 同代 / 记录在表 / 归属没变。
// 边界（诚实）：无法替换 Core 上的 `tool-executor` 服务（插件面不支持接管），所以“实例被换掉”
// 在服务层测不到 —— 它和 `wrong_instance` 是同一条性质，后者在回执层可测，见 `R3`。
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
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
  capabilities: ['tool.read'],
  permission_mode: 'auto',
  runtime: { kind: 'process' },
  limits: { max_active_tasks: 1, max_children: 0 },
  ...over,
});

const task = (id, cellId) => ({
  schema_version: 'tusunsun.task/v0',
  task_id: id,
  attempt: 1,
  target_cell_id: cellId,
  goal: 'noop',
  inputs: [],
  required_capabilities: ['tool.read'],
  budget: { max_steps: 3, wall_ms: 30000 },
  acceptance: { required_artifacts: [], checks: [] },
});

/**
 * `mode: 'real'` —— 真执行器（真的签回执）；
 * `mode: 'lie'` —— 冒充执行器：**计数说装好了、回执说查无此项**。用来证明判据已经从
 * “数 owner”换成“核回执”（数法在 lie 上是绿的，回执法是红的）。
 */
async function makeHost(base, { mode = 'real' } = {}) {
  const { Core } = await imp('src/core/core.js');
  const wsDir = join(base, 'ws');
  mkdirSync(wsDir, { recursive: true });
  const core = new Core({ stateDir: join(base, 'state') });
  core.log = () => {};
  core.setData('agent.workDir', wsDir);
  await (await imp('plugins/workspace.js')).default.init(core);
  core.registerCapability('tool.read', { owner: 'test', handler: async () => 'ok' });
  core.registerCapability('tool.write', { owner: 'test', handler: async () => 'ok' });

  const Cls = (await imp('plugins/tool-executor.js')).default.constructor;
  let exec = null;
  if (mode === 'real') {
    exec = new Cls();
    await exec.init(core);
  } else {
    exec = {
      registerPreHook(fn, owner) { this._n = (this._n || 0) + 1; return { token: 'fake#1', kind: 'pre', owner }; },
      registerDispatchHook(fn, owner) { return { token: 'fake#2', kind: 'dispatch', owner }; },
      removeHooksByOwner() {},
      hookCountFor() { return { pre: 1, post: 0, dispatch: 1 }; },
      verifyHook() { return { ok: false, reason: 'not_registered' }; },
      // rc.29：`leaseGuard` 与服务租约同为必需接点（否则“门被摘了”在派发期无人看得见）。
      leaseGuard() { return { key: 'fake', release() {} }; },
    };
    core.registerService('tool-executor', exec);
  }

  const rt = (await imp('plugins/cell-runtime.js')).default;
  await rt.init(core);
  return { core, exec, wsDir, svc: core.getService('cell-runtime') };
}

const tmp = () => mkdtempSync(join(tmpdir(), 'rc28-receipt-'));

export default async function (runner) {
  // ── 回执本身的语义 ─────────────────────────────────────────────────
  runner.test('rc.28/R1 注册方法必须签回执：token 唯一、带实例与代际，且能核回表里那一条', async () => {
    const base = tmp();
    try {
      const { exec } = await makeHost(base);
      const pre = exec.registerPreHook(() => undefined, 'owner-a', 10, { failClosed: true });
      const dispatch = exec.registerDispatchHook(() => undefined, 'owner-a');
      const post = exec.registerPostHook(() => undefined, 'owner-a');

      for (const [name, r] of Object.entries({ pre, dispatch, post })) {
        assert(r && typeof r.token === 'string' && /#\d+$/.test(r.token), `${name} 回执必须带 token：${JSON.stringify(r)}`);
        assertEquals(r.owner, 'owner-a', `${name} 回执必须记归属`);
        assert(Number.isInteger(r.generation), `${name} 回执必须带代际`);
        assertEquals(exec.verifyHook(r).ok, true, `${name} 回执必须能核回表里那一条`);
      }
      assertEquals(new Set([pre.token, dispatch.token, post.token]).size, 3, '三条回执的 token 不得重复');
      assertEquals(pre.instance, dispatch.instance, '同一实例签出的回执必须同实例');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.28/R2 钩子被按 owner 摘掉之后，回执必须失效（not_registered）', async () => {
    const base = tmp();
    try {
      const { exec } = await makeHost(base);
      const r = exec.registerDispatchHook(() => undefined, 'owner-b');
      assertEquals(exec.verifyHook(r).ok, true, '前提：先有效');
      exec.removeHooksByOwner('owner-b');
      assertEquals(exec.verifyHook(r).reason, 'not_registered', '摘掉之后必须说“查无此项”');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.28/R3 别的执行器实例签的回执不认（wrong_instance）', async () => {
    const base = tmp();
    try {
      const a = await makeHost(join(base, 'a'));
      const b = await makeHost(join(base, 'b'));
      mkdirSync(join(base, 'a'), { recursive: true });
      mkdirSync(join(base, 'b'), { recursive: true });
      const fromB = b.exec.registerPreHook(() => undefined, 'owner-c');
      // 同一份回执拿到 A 上核：token 可能恰好同名，但实例身份不同 ⇒ 不认。
      assertEquals(a.exec.verifyHook(fromB).reason, 'wrong_instance', '换实例必须不认');
      assertEquals(b.exec.verifyHook(fromB).ok, true, '在它自己的实例上仍然有效（反向自检）');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.28/R4 伪造/过期回执的三种形态：stale_generation / owner_changed / unknown_kind', async () => {
    const base = tmp();
    try {
      const { exec } = await makeHost(base);
      const r = exec.registerPreHook(() => undefined, 'owner-d');
      assertEquals(exec.verifyHook({ ...r, generation: r.generation + 1 }).reason, 'stale_generation',
        '代际对不上必须判过期（将来允许换代装配时，旧回执不得当新回执用）');
      assertEquals(exec.verifyHook({ ...r, owner: 'someone-else' }).reason, 'owner_changed',
        '归属变了必须不认（同 token 被别人接手）');
      assertEquals(exec.verifyHook({ ...r, kind: 'nope' }).reason, 'unknown_kind', '未知钩子类型必须不认');
      assertEquals(exec.verifyHook(null).reason, 'no_receipt', '没有回执就不能当作“已装”');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  // ── 装配方（Cell 门）拿回执核账 ────────────────────────────────────
  runner.test('rc.28/R5 判据已从“数 owner”换成“核回执”：计数撒谎的执行器不得让 Cell 创建成功', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base, { mode: 'lie' });
      const gate = host.svc.create(spec('c1', host.wsDir), { trusted: true });
      let err = null;
      // 计数法是绿的（pre=1/dispatch=1），回执法必须红 —— 这条用例就是两者的分水岭。
      try { await gate; } catch (e) { err = e; }
      assertEquals(err?.code, 'cell_gate_unavailable', '回执核不上必须具名拒绝');
      assert(/not_registered/.test(err.message), `拒绝理由必须带回执失效原因：${err.message}`);
      assertEquals(host.svc.list().length, 0, '失败不留半个 Cell');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.28/R6 describe 必须区分“当初装上了”与“此刻还在”：live 要跟着回执走', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base);
      await host.svc.create(spec('c1', host.wsDir), { trusted: true });
      const before = host.svc.describe('c1').capability_gate;
      assertEquals(before.installed, true, 'installed 表示当初装上了');
      assertEquals(before.live, true, 'live 表示此刻还在');
      assertEquals(before.tokens.length, 2, '两个接点各一个 token');
      assert(before.tokens.every((t) => typeof t === 'string' && t.includes('#')), 'token 必须可审计');

      host.exec.removeHooksByOwner('cell:c1');
      const after = host.svc.describe('c1').capability_gate;
      assertEquals(after.installed, true, 'installed 不变（历史事实）');
      assertEquals(after.live, false, 'live 必须立刻变假（此刻的事实）');

      let err = null;
      try { host.svc.accept('c1', task('t1', 'c1')); } catch (e) { err = e; }
      assertEquals(err?.code, 'cell_gate_unavailable', '没有回执的 Cell 不得接任务');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.28/R7 同 Core 幂等重入不得换代：旧回执必须继续有效', async () => {
    const base = tmp();
    try {
      const { exec, core } = await makeHost(base);
      const r = exec.registerPreHook(() => undefined, 'owner-e');
      await exec.init(core);
      assertEquals(exec.verifyHook(r).ok, true, '幂等早退不得把已签出的回执变成废纸');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.28/R8 init 中途失败必须回滚代际：先前的回执不得因为一次失败的装配而失效', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base, { mode: 'lie' });
      const ExecCls = (await imp('plugins/tool-executor.js')).default.constructor;
      const exec = new ExecCls();
      const r = exec.registerPreHook(() => undefined, 'owner-f');
      assertEquals(exec.verifyHook(r).ok, true, '前提：装配之前它就是有效的');
      // 让 init 在最后一步失败：`action.inspect` 被别的 owner 占着。
      host.core.registerCapability('action.inspect', { owner: 'other', handler: async () => ({}) });
      let err = null;
      try { await exec.init(host.core); } catch (e) { err = e; }
      assert(err, 'init 必须失败');
      assertEquals(exec.verifyHook(r).ok, true, '失败的 init 不得把代际往前推（否则旧回执全变废纸）');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.28/R9 三个接点的回执都进安全读数：谁装的、几代、还在不在都能答', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base);
      await host.svc.create(spec('c1', host.wsDir), { trusted: true });
      const stats = host.exec.getSecurityStats();
      assertEquals(stats.pre_hooks >= 1, true, 'pre 钩子必须进读数');
      assertEquals(stats.dispatch_hooks >= 1, true, '派发期钩子必须进读数');
      // 回执是**独立于计数**的证据：把表清空，计数归零、回执也该失效，两者不得一真一假。
      host.exec.removeHooksByOwner('cell:c1');
      const after = host.exec.getSecurityStats();
      assertEquals(after.dispatch_hooks, 0, '摘掉之后计数必须归零');
      assertEquals(host.svc.describe('c1').capability_gate.live, false, '摘掉之后 live 必须为假');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
}
