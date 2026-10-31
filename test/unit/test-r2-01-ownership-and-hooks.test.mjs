/**
 * R2-01（v0.15.4）：**权属与接点**收口的回归锁。
 *
 * 对应专家《v0.15.3 内核与 Hook 架构独立审查》§6 的 R2 硬阻断四条：
 *   K3     合法状态转移（`advance()` 此前是一个裸赋值）
 *   K4+X04 服务归属原子化（此前对象能换成 B 而归属记录还是 A）
 *   H-01   订阅按**单次注册**记 owner（此前写在函数对象上，跨 owner 误删）
 *   H-03   已提交事实的通知隔离观察者异常（此前 start() reject 而 running=true）
 * 外加 §6「可同轮完成的小接缝」里的 H-02（管道对称注销）与 H-04（assembly-lock 归属 + stop）。
 *
 * 纪律（延续 R1-01）：
 *   ① 每条缺陷配**合法正例**，防"一律拒绝/一律降级"式假修复；
 *   ② 判据必须能看见它的目标：能读到真实记录就不读"看起来对"的状态名；
 *   ③ 断言失败必须说清"哪一件事被谁看见了"；
 *   ④ 只断言**合同**，不断言实现细节（内部状态一律走公开方法核对）。
 */
import { TestRunner } from '../harness.mjs';
import { assert, assertEquals } from '../harness.mjs';
import strict from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { Core, createRuntime } from '../../src/core/core.js';
import { SceneController } from '../../src/core/scene-controller.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const src = (rel) => readFileSync(join(ROOT, rel), 'utf8');

export async function setup(runner) {
  let tmpDirs = [];
  let cores = [];

  const makeCore = () => {
    const dir = mkdtempSync(join(tmpdir(), 'tusunsun-r2-'));
    tmpDirs.push(dir);
    const core = new Core({ stateDir: dir });
    core.log = () => {};
    core._stopAssemblyDrainMs = 20;
    cores.push(core);
    return { core, dir };
  };

  const makePlugin = (name, extra = {}) => ({
    name,
    version: '1.0.0',
    async init() {},
    async start() {},
    async stop() {},
    ...extra,
  });

  const assertThrowsCode = (core, plugin, to) => {
    let err = null;
    try { core.lifecycle.advance(plugin, to); } catch (e) { err = e; }
    assert(err, `该转移必须被拒：${to}`);
    assertEquals(err.code, 'invalid_state_transition');
  };

  runner.beforeEach(() => {
    tmpDirs = [];
    cores = [];
  });

  runner.afterEach(async () => {
    for (const c of cores) {
      try { if (c.running) await c.stop(); } catch { /* 已停或本来就起不来 */ }
    }
    for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ } }
  });

  // ══════════════════════════════════════════════════════════════════
  // K3：合法转移表
  // ══════════════════════════════════════════════════════════════════

  runner.test('R2-01/K3-1 非法转移必须具名拒绝（advance 不再是一个裸赋值）', () => {
    const { core } = makeCore();
    const p = { name: 'k3a', state: 'registered' };
    let err = null;
    try { core.lifecycle.advance(p, 'running'); } catch (e) { err = e; }
    assert(err, 'registered → running 跳过了 started，必须被拒');
    assertEquals(err.code, 'invalid_state_transition');
    assertEquals(err.from, 'registered');
    assertEquals(err.to, 'running');
    assertEquals(p.state, 'registered', '被拒之后状态不得改变');
    assertEquals(core.lifecycle.getIllegalTransitionCount(), 1);
    assert(/合法出口/.test(err.message), '拒绝必须告诉调用方合法出口是什么');
  });

  runner.test('R2-01/K3-2 【正例】真实装配的每一步都在表里：registered→started→running→unloaded', async () => {
    const { core } = makeCore();
    const p = makePlugin('k3b');
    await core.register(p);
    assertEquals(p.state, 'registered', '初始值由 core.register 写，不是跃迁');

    await core.lifecycle.load(p, core);
    assertEquals(p.state, 'running');

    const edges = core.lifecycle.getTransitions()
      .filter((t) => t.name === 'k3b').map((t) => `${t.from}→${t.to}`);
    // 注意：harness 的 `assertEquals` 是严格 ===，数组必须用 deepEqual。
    strict.deepEqual(edges, ['registered→started', 'started→running'], '装载只该有这两条边');

    await core.lifecycle.unload('k3b');
    assertEquals(p.state, 'unloaded');
    assertEquals(core.plugins.has('k3b'), false, 'unloaded 的实例必须已出册');
    assertEquals(core.lifecycle.getIllegalTransitionCount(), 0, '正常流程不得出现非法转移');
  });

  runner.test('R2-01/K3-3 【正例】故障出口仍可用：error / unavailable 都是合法出口（不是"一律拒绝"）', () => {
    const { core } = makeCore();
    const p = { name: 'k3c', state: 'registered' };
    core.lifecycle.advance(p, 'error');
    assertEquals(p.state, 'error');
    core.lifecycle.advance(p, 'started');          // 同一对象重试装配
    assertEquals(p.state, 'started');
    core.lifecycle.advance(p, 'error');
    core.lifecycle.advance(p, 'unavailable');      // reload 失败后的旧实例
    assertEquals(p.state, 'unavailable');
    core.lifecycle.advance(p, 'unloaded');         // 终态
    assertEquals(p.state, 'unloaded');
    assertEquals(core.lifecycle.getIllegalTransitionCount(), 0);
  });

  runner.test('R2-01/K3-4 unloaded 是终态：不得原地复活成 running / started', () => {
    const { core } = makeCore();
    const p = { name: 'k3d', state: 'unloaded' };
    assertThrowsCode(core, p, 'running');
    assertThrowsCode(core, p, 'started');
    assertEquals(p.state, 'unloaded');
  });

  runner.test('R2-01/K3-5 bestEffort：失败/停止路径只记账不抛，真正的原因不被覆盖', () => {
    const { core } = makeCore();
    const p = { name: 'k3e', state: 'unloaded' };
    core.lifecycle.advance(p, 'running', { bestEffort: true });
    assertEquals(p.state, 'unloaded', 'bestEffort 不得把非法转移写进去');
    assertEquals(core.lifecycle.getIllegalTransitionCount(), 1, '但仍要记账（可断言），不能静默');
  });

  runner.test('R2-01/K3-6 结构判据：src/ 里直写 plugin.state 的地方只剩 core.register 的初始值', () => {
    const files = [
      'src/core/core.js', 'src/core/lifecycle-manager.js', 'src/core/plugin-manager.js',
      'src/core/scene-controller.js', 'src/bootstrap/cli.js',
    ];
    const hits = [];
    for (const f of files) {
      src(f).split('\n').forEach((line, i) => {
        if (line.trim().startsWith('//')) return;
        if (/plugin\.state\s*=\s*['"]/.test(line)) hits.push(`${f}:${i + 1}`);
      });
    }
    assertEquals(hits.length, 1, `只允许 core.register 写初始值，实测：${hits.join(', ') || '(无)'}`);
    assert(hits[0].startsWith('src/core/core.js:'), `初始值必须在 core.register 里，实测 ${hits[0]}`);
  });

  runner.test('R2-01/K3-7 cli.js 的早加载不再跳级：走 started → running 两条合法边', () => {
    const cli = src('src/bootstrap/cli.js');
    // 只春**代码行**：文档注释里会引用修前的写法（`plugin.state = 'running'`），
    // 拿整份文本做正则会把注释当成缺陷 —— 这正是“判据看不见它的目标”的又一个形状。
    const code = cli.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    assert(!/plugin\.state\s*=\s*'running'/.test(code), '早加载不得再直写 running');
    assert(/lifecycle\.advance\(plugin, 'started'\)/.test(code), '必须显式走 started');
    assert(/lifecycle\.advance\(plugin, 'running'\)/.test(code), '必须显式走 running');
    assert(/if \(!\(await core\.register\(plugin\)\)\)/.test(code), '注册被拒时不得再对未入册实例 init');
  });

  runner.test('R2-01/K3-8 【正例】完整 start/stop 之后非法转移计数必须是 0', async () => {
    const { core } = makeCore();
    await core.register(makePlugin('k3f'));
    await core.start();
    assertEquals(core.running, true);
    await core.stop();
    assertEquals(core.lifecycle.getIllegalTransitionCount(), 0,
      `正常 start/stop 不该出现非法转移，实测 ${JSON.stringify(core.lifecycle.getTransitions())}`);
    const edges = core.lifecycle.getTransitions().filter((t) => t.name === 'k3f').map((t) => `${t.from}→${t.to}`);
    strict.deepEqual(edges, ['registered→started', 'started→running', 'running→stopped']);
  });

  // ══════════════════════════════════════════════════════════════════
  // X04 / K4：服务归属
  // ══════════════════════════════════════════════════════════════════

  const owned = (core, owner, fn, instance = null) => (instance
    ? core._runAssemblyContext(owner, fn, core.assemblyEpoch, instance)
    : core.runServiceTracking(owner, fn));

  runner.test('R2-02/X04-a 匿名覆写已归属服务：必须拒绝，且对象与归属都不变（专家反例）', async () => {
    const { core } = makeCore();
    const A = { name: 'A' };
    const B = { name: 'B' };
    await owned(core, 'owner-A', async () => core.registerService('svc', A));

    let err = null;
    try { core.registerService('svc', B); } catch (e) { err = e; }
    assert(err, '匿名覆写必须被拒（修前被当成"没声明 owner ⇒ 随便改"）');
    assertEquals(err.code, 'service_conflict');
    assertEquals(core.getService('svc'), A, '被拒后对象不得改变');
    const own = core.getServiceOwnership('svc');
    assertEquals(own.owner, 'owner-A', '被拒后归属不得改变');
    assertEquals(own.registered, true);
  });

  runner.test('R2-02/X04-b 【正例】同一 owner 替换：允许，对象与归属一起更新', async () => {
    const { core } = makeCore();
    const A1 = { name: 'A1' };
    const A2 = { name: 'A2' };
    // 正例的调用姿势（专家 R15-03 之后）：同 owner 更新 = **同一个受信装配实例**更新它
    // 自己那笔登记，不是“自报一个相同字符串”。`runServiceTracking` 只用于观测服务访问。
    const inst = { name: 'owner-A' };
    await owned(core, 'owner-A', async () => core.registerService('svc', A1), inst);
    await owned(core, 'owner-A', async () => core.registerService('svc', A2), inst);
    assertEquals(core.getService('svc'), A2);
    assertEquals(core.getServiceOwnership('svc').owner, 'owner-A');
  });

  runner.test('R2-02/X04-c 【正例】异主覆写：必须拒绝（v0.15.2 已绿，防回归）', async () => {
    const { core } = makeCore();
    const A = { name: 'A' };
    const B = { name: 'B' };
    await owned(core, 'owner-A', async () => core.registerService('svc', A));
    let err = null;
    try { await owned(core, 'owner-B', async () => core.registerService('svc', B)); } catch (e) { err = e; }
    assert(err, '异主覆写必须被拒');
    assertEquals(core.getService('svc'), A);
    assertEquals(core.getServiceOwnership('svc').owner, 'owner-A');
  });

  runner.test('R2-02/X04-d 【正例】宿主显式接管：允许，归属变 @host 且留记录，插件卸载拆不走', async () => {
    // 本用例的**需求**没变（合法宿主接管后插件无法拆走），变的是调用姿势：
    // 接管只能由构造期领到控制体的宿主发起，`core.registerService(..., {takeover:true})` 不再算数。
    const dir = mkdtempSync(join(tmpdir(), 'tusunsun-r2-'));
    tmpDirs.push(dir);
    const { core, host } = createRuntime({ stateDir: dir });
    core.log = () => {};
    cores.push(core);
    const A = { name: 'A' };
    const H = { name: 'H' };
    const aInst = { name: 'owner-A' };
    await owned(core, 'owner-A', async () => core.registerService('svc', A), aInst);
    await host.takeoverService('svc', H, { reason: 'bootstrap-recovery' });
    const own = core.getServiceOwnership('svc');
    assertEquals(core.getService('svc'), H);
    assertEquals(own.owner, '@host');
    assert(own.takeover, '接管必须留下可查的覆盖记录');
    assertEquals(own.takeover.previousOwner, 'owner-A');
    assertEquals(own.takeover.actorClass, 'host', '归责来自授权通道，不是调用方传来的标签');

    // 公开的按名批量入口已删除（专家 ID-10）；连生命周期清场也拆不走 @host。
    assertEquals(core.releaseServicesByOwner, undefined, '按名的批量服务入口必须消失');
    strict.deepEqual(core.lifecycle._reap('owner-A', aInst), { capabilities: [], services: [] }, '@host 的服务不得被任何实例按名拆走');
    strict.deepEqual(core.lifecycle._reap('@host', aInst), { capabilities: [], services: [] }, '@host 自己也不能被清');
    assertEquals(core.getService('svc'), H, '宿主接管后归属稳定');
  });

  runner.test('R2-02/K4-1 实例清场只撤销自己的：名字巧合不等于归属', async () => {
    const { core } = makeCore();
    const svc = { name: 'evil' };
    const aInst = { name: 'owner-A' };
    await owned(core, 'owner-A', async () => core.registerService('evil', svc), aInst);
    // 模拟 Lifecycle 在卸载插件 "evil" 时的清场：名字巧合（svc.name === 'evil'）不得成为依据
    strict.deepEqual(core.lifecycle._reap('evil', { name: 'evil' }), { capabilities: [], services: [] });
    assertEquals(core.getService('evil'), svc, '删别人的服务就是 §5.4 的"粗放清场"');
    strict.deepEqual(core.lifecycle._reap('owner-A', aInst).services, ['evil']);
    assertEquals(core.getService('evil'), undefined);
  });

  runner.test('R2-02/K4-2 实例清场只撤销自己登记的：两个 owner 同一 Core 互不牵连', async () => {
    const { core } = makeCore();
    const aInst = { name: 'owner-A' };
    const bInst = { name: 'owner-B' };
    await owned(core, 'owner-A', async () => core.registerCapability('cap.a', { handler: () => 1, owner: 'owner-A' }), aInst);
    await owned(core, 'owner-B', async () => core.registerCapability('cap.b', { handler: () => 2, owner: 'owner-B' }), bInst);
    strict.deepEqual(core.lifecycle._reap('owner-A', aInst).capabilities, ['cap.a']);
    assertEquals(core._capabilities.has('cap.a'), false);
    assert(core._capabilities.has('cap.b'), '别人的能力不得被连带删除');
    assertEquals(core.releaseCapabilitiesByOwner, undefined, '按名的批量入口必须消失（ID-10）');
  });

  runner.test('R2-02/K4-3 【正例】真实插件卸载：自己的服务与能力被释放，别人的一个都不动', async () => {
    const { core } = makeCore();
    const foreign = { name: 'svcfull' };
    await owned(core, 'someone-else', async () => core.registerService('foreign.svc', foreign));

    const p = makePlugin('svcfull', {
      async init(c) {
        c.registerService('svcfull.svc', { mine: true });
        c.registerCapability('svcfull.cap', { handler: () => 'ok', owner: 'svcfull' });
      },
    });
    await core.register(p);
    await core.lifecycle.load(p, core);
    assert(core.getService('svcfull.svc'), '装载后自己的服务应在');

    await core.lifecycle.unload('svcfull');
    assertEquals(core.getService('svcfull.svc'), undefined, '自己的服务必须释放');
    assertEquals(core._capabilities.has('svcfull.cap'), false, '自己的能力必须释放');
    assertEquals(core.getService('foreign.svc'), foreign, '别人的服务不得被连带释放');
  });

  // ══════════════════════════════════════════════════════════════════
  // H-01：订阅归属按单次注册
  // ══════════════════════════════════════════════════════════════════

  runner.test('R2-03/H-01-1 同回调两 owner（不同事件）：释放 A 不得删掉 B（专家反例）', () => {
    const { core } = makeCore();
    let beta = 0;
    const reused = () => { beta++; };
    core.on('a.event', reused, { owner: 'owner-A' });
    core.on('b.event', reused, { owner: 'owner-B' });
    assertEquals(core.offByOwner('owner-A'), 1);
    assertEquals(core.listenerCount('b.event'), 1, 'B 的订阅还在');
    core.emit('b.event', { sourcePlugin: 'test' });
    assertEquals(beta, 1, 'B 必须仍能收到事件（修前 ownerB_calls=0）');
  });

  runner.test('R2-03/H-01-2 同回调、同事件、两 owner：释放 A 只去掉一条', () => {
    const { core } = makeCore();
    let n = 0;
    const fn = () => { n++; };
    core.on('c.event', fn, { owner: 'owner-A' });
    core.on('c.event', fn, { owner: 'owner-B' });
    assertEquals(core.listenerCount('c.event'), 2, '两条独立注册');
    assertEquals(core.offByOwner('owner-A'), 1);
    assertEquals(core.listenerCount('c.event'), 1);
    core.emit('c.event', { sourcePlugin: 'test' });
    assertEquals(n, 1, 'B 那条仍生效且只生效一次');
    assertEquals(core.offByOwner('owner-B'), 1);
    assertEquals(core.listenerCount('c.event'), 0);
  });

  runner.test('R2-03/H-01-3 once 带 owner：触发后自行摘账，不得重复计数', () => {
    const { core } = makeCore();
    let n = 0;
    core.once('d.once', () => { n++; }, { owner: 'owner-D' });
    core.emit('d.once', { sourcePlugin: 'test' });
    assertEquals(n, 1);
    assertEquals(core.listenerCount('d.once'), 0);
    assertEquals(core.offByOwner('owner-D'), 0, '已经触发掉的订阅不能再算一次"清理"');
  });

  runner.test('R2-03/H-01-4 off / removeAllListeners 必须同步登记表（不留幽灵记录）', () => {
    const { core } = makeCore();
    const fn = () => {};
    core.on('e.off', fn, { owner: 'owner-E' });
    core.off('e.off', fn);
    assertEquals(core.offByOwner('owner-E'), 0, 'off 之后登记表里不该还有它');

    core.on('e.one', fn, { owner: 'owner-F' });
    core.on('e.two', fn, { owner: 'owner-F' });
    core.removeAllListeners('e.one');
    assertEquals(core.offByOwner('owner-F'), 1, '只剩 e.two 那条可清');
    assertEquals(core.listenerCount('e.two'), 0);
  });

  runner.test('R2-03/H-01-5 【正例】单 owner 多事件多回调：清理数必须等于实际删除数', () => {
    const { core } = makeCore();
    const f1 = () => {};
    const f2 = () => {};
    core.on('g.1', f1, { owner: 'owner-G' });
    core.on('g.2', f1, { owner: 'owner-G' });
    core.on('g.3', f2, { owner: 'owner-G' });
    assertEquals(core.listenerCount('g.1') + core.listenerCount('g.2') + core.listenerCount('g.3'), 3);
    assertEquals(core.offByOwner('owner-G'), 3);
    assertEquals(core.listenerCount('g.1') + core.listenerCount('g.2') + core.listenerCount('g.3'), 0);
  });

  // ══════════════════════════════════════════════════════════════════
  // H-03：已提交事实的通知隔离
  // ══════════════════════════════════════════════════════════════════

  runner.test('R2-04/H-03-1 core.ready 观察者抛错不得把已提交的 start 改写成失败（专家反例）', async () => {
    const { core } = makeCore();
    core.on('core.ready', () => { throw new Error('probe-listener-throws'); }, { owner: 'observer' });
    let rejected = null;
    try { await core.start(); } catch (e) { rejected = e; }
    assertEquals(rejected, null, 'start() 不得因为观察者抛错而 reject');
    assertEquals(core.running, true, '事实：确实已经启动了');
    const errs = core.getObserverErrors().filter((e) => e.event === 'core.ready');
    assertEquals(errs.length, 1, '但异常必须被记下来，不能静默吞掉');
    assertEquals(errs[0].code, 'observer_error');
    assertEquals(errs[0].message, 'probe-listener-throws');
  });

  runner.test('R2-04/H-03-2 core.stopped 同理：stop() 不得因为观察者抛错而 reject', async () => {
    const { core } = makeCore();
    await core.start();
    core.on('core.stopped', () => { throw new Error('stop-listener-throws'); }, { owner: 'observer' });
    let rejected = null;
    try { await core.stop(); } catch (e) { rejected = e; }
    assertEquals(rejected, null);
    assert(core.getObserverErrors().some((e) => e.event === 'core.stopped'));
  });

  runner.test('R2-04/H-03-3 scene.switched 观察者抛错不得把已提交的切换改写成失败', async () => {
    const { core } = makeCore();
    core.registerService('config', { get: () => null, set: () => {}, setAndSave: async () => {} });
    const pm = {
      indexLazy: () => {},
      reconcileLazy: () => ({ dropped: [], reattributed: [] }),
      loadOne: async () => ({ ok: true }),
      unload: async () => ({ ok: true }),
    };
    const sc = new SceneController(core, pm);
    sc.findScene = async (n) => ({ name: n, plugins: [], eager: [], lazy: [] });
    core.on('scene.switched', () => { throw new Error('scene-observer-throws'); }, { owner: 'observer' });
    const r = await sc.switchTo('empty', { yes: true });
    assertEquals(r.ok, true, '切换已经提交，返回值不得被观察者改写');
    assert(core.getObserverErrors().some((e) => e.event === 'scene.switched'), '观察者异常必须留下诊断');
  });

  runner.test('R2-04/H-03-4 反例对照：普通 emit 仍然大声失败（没有把"所有异常一律吞掉"）', () => {
    const { core } = makeCore();
    core.on('x.event', () => { throw new Error('loud'); }, { owner: 'observer' });
    let err = null;
    try { core.emit('x.event', { sourcePlugin: 'test' }); } catch (e) { err = e; }
    assert(err && err.message === 'loud', '非事实类事件必须保持 fail-loud（§5.2）');
    assertEquals(core.getObserverErrors().length, 0, '也没进诊断面 —— 它就不属于被隔离的那一类');
  });

  // ══════════════════════════════════════════════════════════════════
  // H-02：管道对称注销
  // ══════════════════════════════════════════════════════════════════

  runner.test('R2-05/H-02-1 带 owner 的中间件可被 owner 撤销（专家反例的修复点）', async () => {
    const { core } = makeCore();
    core.use('inbound', (m) => ({ ...m, marked: true }), { owner: 'pipeline-demo' });
    let r = await core.runPipeline('inbound', { hello: 1 });
    assertEquals(r.marked, true);
    assertEquals(core.offPipelineByOwner('pipeline-demo'), 1);
    r = await core.runPipeline('inbound', { hello: 1 });
    assertEquals(r.marked, undefined, '撤销后不得再执行');
  });

  runner.test('R2-05/H-02-2 【正例】装配上下文里的 use() 自动有主：按 owner 即可撤销', async () => {
    const { core } = makeCore();
    await core.runServiceTracking('ctx-owner', async () => {
      core.use('outbound', (m) => ({ ...m, ctx: 1 }));
    });
    assertEquals(core.offPipelineByOwner('ctx-owner'), 1, '上下文归属必须被记录');
    const r = await core.runPipeline('outbound', { a: 1 });
    assertEquals(r.ctx, undefined);
  });

  runner.test('R2-05/H-02-3 兼容：无 owner 的旧式 use() 仍执行，且不被任何 owner 清理误删', async () => {
    const { core } = makeCore();
    const off = core.use('inbound', (m) => ({ ...m, legacy: true }));
    assertEquals(typeof off, 'function', 'use() 现在返回 disposer（对旧调用方是向后兼容的）');
    assertEquals(core.offPipelineByOwner('anybody'), 0);
    const r = await core.runPipeline('inbound', { a: 1 });
    assertEquals(r.legacy, true, '旧式注册仍生效');
    assertEquals(off(), true, 'disposer 必须真的能摘掉它');
  });

  runner.test('R2-05/H-02-4 重复安装不得叠加：disposer 只摘自己那一条', async () => {
    const { core } = makeCore();
    const fn = (m) => ({ ...m, n: (m.n || 0) + 1 });
    const off1 = core.use('inbound', fn);
    core.use('inbound', fn);
    let r = await core.runPipeline('inbound', {});
    assertEquals(r.n, 2, '两条都在');
    off1();
    r = await core.runPipeline('inbound', {});
    assertEquals(r.n, 1, '只摘一条，不是 removeAll');
  });

  // ══════════════════════════════════════════════════════════════════
  // H-04：assembly-lock 的归属与 stop
  // ══════════════════════════════════════════════════════════════════

  runner.test('R2-06/H-04-1 真实 assembly-lock：四条监听有主，owner 释放能清干净', async () => {
    const { core } = makeCore();
    const mod = await import('../../plugins/assembly-lock.js');
    await mod.init(core);
    const names = ['core:service.conflict', 'core:plugin.conflict', 'core.ready', 'core:plugin.loaded'];
    strict.deepEqual(names.map((n) => core.listenerCount(n)), [1, 1, 1, 1], '四条监听');
    assertEquals(core.offByOwner('assembly-lock'), 4, '修前这里是 0');
    strict.deepEqual(names.map((n) => core.listenerCount(n)), [0, 0, 0, 0]);
    await mod.stop();
  });

  runner.test('R2-06/H-04-2 assembly-lock 必须导出 stop（可卸载的前提是资源能收尾）', async () => {
    const mod = await import('../../plugins/assembly-lock.js');
    assertEquals(typeof mod.stop, 'function');
    assertEquals(typeof mod.init, 'function');
  });
}

export default setup;
