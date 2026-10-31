// R21：core 生命周期十一条审查发现（code-review-0.16.0-rc.7 §2 P1/P2）的回归锁。
//
// 每条修复配成对用例：**缺陷用例**（修前红）与**合法正例**（防止"一律拒绝/一律降级"式假修复）。
// 计数点一律落在被测路径上：in-flight 直接读 `getInflight(装配名)`，监听器直接读
// `listenerCount`，拒绝原因直接读 `err.code` —— 不从日志或"看起来对"的状态猜。
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assert, assertEquals } from '../harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (rel) => import(join(ROOT, rel));

/** 同步可捕获的错误码：返回 `err.code`（无码时返回消息），不透传异常本身。 */
function codeOf(fn) {
  try { const r = fn(); return r && typeof r.then === 'function' ? 'returned-promise' : 'no-throw'; }
  catch (err) { return err.code || err.message; }
}

export async function setup(runner) {
  const { Core } = await imp('src/core/core.js');
  const { PluginManager } = await imp('src/core/plugin-manager.js');
  const { SceneController } = await imp('src/core/scene-controller.js');

  let tmp;
  runner.beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'r21-'));
    mkdirSync(join(tmp, 'plugins'), { recursive: true });
  });
  runner.afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不改变断言 */ } });

  const makeCore = () => {
    const c = new Core({ stateDir: tmp, pluginsDir: join(tmp, 'plugins') });
    c.log = () => {};
    c._stopAssemblyDrainMs = 20;
    return c;
  };
  const writePlugin = (file, body) => {
    const p = join(tmp, 'plugins', file);
    writeFileSync(p, body);
    return p;
  };
  const deferred = () => { const d = {}; d.promise = new Promise((res) => { d.release = res; }); return d; };

  // ══ A-2：停机后的登记闸门 ═══════════════════════════════════════════════
  runner.test('A-2/1 停机后 registerCapability/registerService 一律 core_stopped（epoch:null 的 store 也不是后门）', async () => {
    const core = makeCore();
    await core.register({ name: 'a2', version: '1.0.0', init: (c) => { c.registerCapability('a2.ok', { handler: () => 1, owner: 'a2' }); } });
    await core.start();
    await core.stop();
    const codes = [];
    codes.push(codeOf(() => core.registerCapability('a2.late', { handler: () => 1, owner: 'a2' })));
    codes.push(codeOf(() => core.registerService('a2-svc', {}, { owner: 'a2' })));
    // `runServiceTracking` 建的 store 正是 `epoch:null`：它没有世代，但停机仍然成立。
    let trackedCode = null;
    try { await core.runServiceTracking('a2', () => core.registerCapability('a2.viaTracking', { handler: () => 1 })); }
    catch (err) { trackedCode = err.code || err.message; }
    assertEquals(JSON.stringify(codes), JSON.stringify(['core_stopped', 'core_stopped']),
      `停机后的直接登记必须具名拒绝：${JSON.stringify(codes)}`);
    assertEquals(trackedCode, 'core_stopped', 'runServiceTracking 里注册（epoch===null）同样必须被停机闸门拦住');
    assert(!core.listCapabilities().some((c) => c.id.startsWith('a2.late') || c.id.startsWith('a2.viaTracking')),
      '被拒的登记一个都不许落进能力表');
  });

  runner.test('A-2/2 正例：运行期的同一路径照常可用（不误杀 epoch:null 的合法 store）', async () => {
    const core = makeCore();
    await core.start();
    core.registerCapability('a2.live', { handler: () => 7, owner: 'a2' });
    const consumed = await core.runServiceTracking('a2', () => { core.getService('nope'); });
    assert(consumed.has('nope'), '运行中的追踪上下文照常记账');
    assertEquals((await core.callCapability('a2.live', {})).payload, 7);
    await core.stop();
  });

  // ══ A-3：in-flight 按**装配身份**记账，不按注册方自填的 owner ══════════
  runner.test('A-3/1 能力自报他人 owner 时，in-flight 仍记在装配身份（插件名）上', async () => {
    const core = makeCore();
    const warns = [];
    core.log = (level, ...args) => { if (level === 'warn') warns.push(args.join(' ')); };
    const gate = deferred();
    await core.register({
      name: 'alpha', version: '1.0.0',
      init: (c) => { c.registerCapability('alpha.work', { handler: async () => { await gate.promise; return 'done'; }, owner: 'beta' }); },
    });
    await core.start();
    const call = core.callCapability('alpha.work', {});
    assertEquals(core.getInflight('alpha'), 1,
      '在途必须记在装配身份 alpha 上 —— 修前记在自报的 beta 上，drain / reload-busy / idle 三处判据同时找不到它');
    assertEquals(core.getInflight('beta'), 0, '自报的 owner 不得成为记账键');
    assert(warns.some((w) => w.includes('alpha') && w.includes('beta')), '冲突必须以装配上下文为准并留下一条日志');
    gate.release();
    assertEquals((await call).ok, true);
    assertEquals(core.getInflight('alpha'), 0, 'settle 之后在途必须归零');
    await core.stop();
  });

  runner.test('A-3/2 正例：owner 与装配身份一致时记账不变；无装配上下文时按声明记账', async () => {
    const core = makeCore();
    const g = deferred();
    await core.register({
      name: 'gamma', version: '1.0.0',
      init: (c) => { c.registerCapability('gamma.a', { handler: async () => { await g.promise; }, owner: 'gamma' }); },
    });
    const g2 = deferred();
    await core.start();
    core.registerCapability('host.cap', { handler: async () => { await g2.promise; }, owner: 'hostish' });
    const c1 = core.callCapability('gamma.a', {});
    const c2 = core.callCapability('host.cap', {});
    assertEquals(core.getInflight('gamma'), 1, '声明与装配身份一致时行为不变');
    assertEquals(core.getInflight('hostish'), 1, '宿主登记（无装配上下文）只能按声明记账');
    g.release(); g2.release();
    await Promise.all([c1, c2]);
    await core.stop();
  });

  // ══ A-4 / A-5：装配失败不得留下能力与僵尸插件 ═══════════════════════════
  runner.test('A-4/1 init 抛错且清理被依赖方反拦：能力与监听器都不得残留', async () => {
    const core = makeCore();
    await core.register({
      name: 'keeper', version: '1.0.0', requires: { boom: '^1.0.0' },
      init: (c) => { c.on('keeper.tick', () => {}, { owner: 'keeper' }); },
    });
    await core.register({
      name: 'boom', version: '1.0.0',
      init: (c) => {
        c.registerCapability('boom.cap', { handler: () => 1, owner: 'boom' });
        c.registerService('boom-svc', { ok: true }, { owner: 'boom' });
        c.on('boom.tick', () => {}, { owner: 'boom' });
        c.use('inbound', (m) => m, { owner: 'boom' });
        throw new Error('init exploded');
      },
    });
    await core.start();
    assertEquals(core.plugins.has('boom'), false,
      '装配失败的对象必须离开插件表 —— 修前 unload 被依赖闸门反拦 + 异常被吞，留下 state=error 的僵尸');
    assertEquals(core.listenerCount('boom.tick'), 0, '失败插件的监听器不得活过装配失败');
    assertEquals(core.offPipelineByOwner('boom'), 0, '失败插件的中间件同样不得残留');
    assert(!core.listCapabilities().some((c) => c.id === 'boom.cap'), '本次装配注册的能力必须被收回');
    assertEquals(core.getService('boom-svc'), undefined, '本次装配注册的服务必须被收回');
    assertEquals(core.plugins.get('keeper')?.state, 'running', '正例：无关的依赖方不受影响');
    assertEquals(core.listenerCount('keeper.tick'), 1, '正例：无关插件的订阅不得被连带清掉');
    await core.stop();
    assertEquals(core.listenerCount('boom.tick'), 0, 'core.stop() 之后失败插件的监听器数必须为 0');
  });

  runner.test('A-4/2 卸载本身失败时，本次装配已发布的东西也要按装配账收回', async () => {
    const core = makeCore();
    await core.register({
      name: 'boom2', version: '1.0.0',
      init: (c) => {
        c.registerCapability('boom2.cap', { handler: () => 1, owner: 'boom2' });
        c.registerService('boom2-svc', {}, { owner: 'boom2' });
        throw new Error('init exploded after publishing');
      },
    });
    core.lifecycle.unload = async () => { throw new Error('模拟：卸载路径自身失败'); };
    await core.start();
    assert(!core.listCapabilities().some((c) => c.id === 'boom2.cap'),
      '修前 tracked 只在 _loadDependencies 成功返回后才有值 ⇒ discardAssemblyArtifacts(null) 空转，能力留在表里');
    assertEquals(core.getService('boom2-svc'), undefined, '服务同样不得残留');
  });

  runner.test('A-5 正例：运行中的依赖方仍拦得住正常卸载（force 只给失败清理用）', async () => {
    const core = makeCore();
    await core.register({
      name: 'keeper2', version: '1.0.0', requires: { victim: '^1.0.0' },
      init: (c) => { c.on('keeper2.tick', () => {}, { owner: 'keeper2' }); },
    });
    await core.register({
      name: 'victim', version: '1.0.0',
      init: (c) => { c.on('victim.tick', () => {}, { owner: 'victim' }); },
    });
    await core.start();
    let err = null;
    try { await core.lifecycle.unload('victim'); } catch (e) { err = e; }
    assert(err && /requires/.test(err.message), '依赖闸门必须仍然生效（否则就是"一律放行"式假修复）');
    assertEquals(core.plugins.get('victim')?.state, 'running', '被拒的卸载不得拆掉 victim');
    assertEquals(core.listenerCount('victim.tick'), 1, '被拒的卸载不得清理 victim 的监听器');
    await core.stop();
  });

  // ══ D-1：hasCapability 的停机闸门 ═══════════════════════════════════════
  runner.test('D-1/1 core.stop() 之后 hasCapability 必须为 false，且不得再触发懒加载', async () => {
    const core = makeCore();
    let lazyCalls = 0;
    core.setData('_lazyHook', async () => { lazyCalls++; });
    await core.register({ name: 'd1', version: '1.0.0', init: (c) => { c.registerCapability('d1.work', { handler: () => 1 }); } });
    await core.start();
    assertEquals(await core.hasCapability('d1.work'), true, '正例：运行期可得为真');
    assertEquals(await core.hasCapability('d1.never'), false, '正例：没注册的仍然为假');
    const before = lazyCalls;
    await core.stop();
    assertEquals(await core.hasCapability('d1.work'), false, '修前停机后仍返回 true');
    assertEquals(await core.hasCapability('d1.never'), false, '停机后一律不可得');
    assertEquals(lazyCalls, before, '停机后不得借 hasCapability 触发懒加载（那是副作用）');
  });

  // ══ D-2（登记为 FP 的契约锁）：started 可卸载，但必须先 stop ═══════════
  runner.test('D-2 契约：started 状态可被 unload，且卸载路径先调用 stop（不是缺陷）', async () => {
    const core = makeCore();
    const calls = [];
    const p = { name: 'started-only', version: '1.0.0', init: () => {}, stop: () => { calls.push('stop'); } };
    await core.register(p);
    core.lifecycle.advance(p, 'started');       // init 已返回、start 尚未返回
    const r = await core.lifecycle.unload('started-only');
    assertEquals(r.ok, true, 'started → unloaded 是合法边');
    assertEquals(JSON.stringify(calls), JSON.stringify(['stop']), '卸载 started 插件必须先 stop（否则监听器活过一个从未 stop 的实例）');
    assertEquals(p.state, 'unloaded');
  });

  // ══ D-3：命令无人可答时必须快速具名失败，不得硬等超时 ══════════════════
  runner.test('D-3/1 没有处理器也没有响应等待者的命令必须快速具名失败', async () => {
    const core = makeCore();
    await core.start();
    const t0 = Date.now();
    const env = await core.command('nobody.handles', {}, 2000);
    const ms = Date.now() - t0;
    assertEquals(env.ok, false);
    assertEquals(env.code, 'command_unhandled', `必须具名说明没人能兑现这条命令：${JSON.stringify(env)}`);
    assertEquals(env.dispatched, false, '没派发是可证明的事实');
    assertEquals(env.side_effect, 'none');
    assert(ms < 500, `必须快速拒绝（修前等满 2000ms 超时才失败）：实测 ${ms}ms`);
    await core.stop();
  });

  runner.test('D-3/2 正例：有监听者的命令照常应答；已注册能力照常派发', async () => {
    const core = makeCore();
    await core.start();
    core.on('demo.work', (p) => { core.emit('demo.work.response', { ok: true, payload: p.n * 2 }); });
    const env = await core.command('demo.work', { n: 21 }, 1000);
    assertEquals(env.ok, true, `有处理器就必须正常应答：${JSON.stringify(env)}`);
    assertEquals(env.payload, 42);
    core.registerCapability('demo.cap', { handler: ({ n }) => n + 1 });
    assertEquals((await core.command('demo.cap', { n: 1 }, 1000)).payload, 2, '能力路径不受事件兜底改动影响');
    await core.stop();
  });

  // ══ D-4：{ok:false, forced_partial} 必须被当成"部分完成"，不得当成成功 ══
  runner.test('D-4/1 重载：卸载被迫部分完成时不得换上新版本，必须具名上报', async () => {
    const core = makeCore();
    const pm = new PluginManager(core);
    pm.dirs = [join(tmp, 'plugins')];
    const file = writePlugin('vic.mjs', "export default { name: 'vic', version: '1.0.0', init() {} };\n");
    await pm.loadOne('vic');
    const realUnload = core.lifecycle.unload.bind(core.lifecycle);
    core.lifecycle.unload = async (n) => {
      const r = await realUnload(n);
      return n === 'vic' ? { ok: false, code: 'drain_timeout', forced_partial: true, inflight: 1, released: true } : r;
    };
    const r = await pm._reloadPlugin('vic', file, 'test');
    assertEquals(r.ok, false, `部分卸载不得报成功：${JSON.stringify(r)}`);
    assertEquals(r.code, 'reload_unload_partial', '必须具备名码');
    assertEquals(core.plugins.has('vic'), false, '旧实例已卸干净、新版本不得被静默装上（两个实例就是两个真相）');
  });

  runner.test('D-4/2 场景切换：toRemove 的卸载被迫部分完成时不得提交 ok:true', async () => {
    const core = makeCore();
    const pm = new PluginManager(core);
    pm.dirs = [join(tmp, 'plugins')];
    writePlugin('keep2.mjs', "export default { name: 'keep2', version: '1.0.0', init() {} };\n");
    await core.register({ name: 'vic2', version: '1.0.0', init: () => {} });
    await core.start();
    const sc = new SceneController(core, pm);
    sc.findScene = async () => ({ name: 'target2', plugins: [], eager: ['keep2'], optional: [] });
    const realUnload = core.lifecycle.unload.bind(core.lifecycle);
    core.lifecycle.unload = async (n) => {
      const r = await realUnload(n);
      return n === 'vic2' ? { ok: false, code: 'drain_timeout', forced_partial: true, inflight: 1, released: true } : r;
    };
    const r = await sc.switchTo('target2', { yes: true });
    assertEquals(r.ok, false, `修复前 _switchToLocked 丢弃了卸载返回值 ⇒ ok:true：${JSON.stringify(r)}`);
    assertEquals(r.code, 'scene_unload_incomplete', '必须具名说明是卸载不干净，不是插件不可解析');
    assertEquals(r.unload_incomplete?.[0]?.name, 'vic2', '必须点名哪个插件没卸干净');
    assertEquals(sc.currentScene, null, '卸不干净就不得提交场景身份');
  });

  runner.test('D-4/3 回收：卸载被迫部分完成时不得重新登记懒索引', async () => {
    const core = makeCore();
    const pm = new PluginManager(core);
    pm._lazyLoaded.add('lazy9');
    core.lifecycle.unload = async () => ({ ok: false, code: 'drain_timeout', forced_partial: true, inflight: 1, released: true });
    await pm._recycle('lazy9');
    assertEquals(pm._pending.has('lazy9'), false, '在途被打断时旧实例可能仍在跑，不得立刻把它登记成"可再装"');
    assertEquals(pm._lazyLoaded.has('lazy9'), false, 'unload 返回 released:true 且已把插件移出 core.plugins ⇒ 不得再记成“已装载”');
    assertEquals(pm._lastRecycleTime.has('lazy9'), false, '未干净卸载不得推进回收时间戳（不要假装回收完成）');
  });

  // ══ D-5（登记为 FP 的契约锁）：register 写 state 是初值，不是跃迁 ══════
  runner.test('D-5 契约：register 只写初值；同名已注册对象的状态不被改写', async () => {
    const core = makeCore();
    const p = { name: 'p5', init: () => {} };
    await core.register(p);
    assertEquals(p.state, 'registered');
    assertEquals(core.lifecycle.getTransitions().length, 0, '注册不是状态转移，不得进转移轨迹');
    core.lifecycle.advance(p, 'started');
    assertEquals(await core.register({ name: 'p5', init: () => {} }), false, '重名注册必须是具名跳过');
    assertEquals(p.state, 'started', '重名注册不得把运行中的对象改回 registered');
    assertEquals(core.lifecycle.getIllegalTransitionCount(), 0, '这条路径一次非法转移都不该产生');
  });

  // ══ D-6：Plan 快照与 Apply 之间可插入懒加载 ═════════════════════════════
  runner.test('D-6/1 快照之后插进来的懒加载不得留在目标场景的运行态里', async () => {
    const core = makeCore();
    const pm = new PluginManager(core);
    pm.dirs = [join(tmp, 'plugins')];
    writePlugin('keep.mjs', "export default { name: 'keep', version: '1.0.0', init() {} };\n");
    writePlugin('sneak.mjs', "export default { name: 'sneak', version: '1.0.0', init() {} };\n");
    await core.register({ name: 'old', version: '1.0.0', init: () => {} });
    await core.start();
    const sc = new SceneController(core, pm);
    sc.findScene = async () => ({ name: 'target', plugins: [], eager: ['keep'], optional: [] });
    let injected = false;
    const realLoad = sc._loadSingle.bind(sc);
    // 模拟"Plan 之后、Apply 期间"插进来的一次懒加载（懒加载不持 `__scene__` 锁）。
    sc._loadSingle = async (n) => { if (!injected) { injected = true; await pm.loadOne('sneak'); } return realLoad(n); };
    const r = await sc.switchTo('target', { yes: true });
    assertEquals(r.ok, true, `切换本身应当成功：${JSON.stringify(r)}`);
    assertEquals(core.plugins.has('sneak'), false,
      '修前只按 Plan 快照卸载 ⇒ 目标场景没声明的 sneak 在切换后仍在跑（Verify 只看必需集合，看不见它）');
    assert((r.toRemove || []).includes('sneak'), '实际被卸载的名字必须出现在 toRemove 里（不让计划与执行分叉）');
    assertEquals(core.plugins.get('keep')?.state, 'running', '正例：目标场景声明的插件正常在跑');
    assertEquals(sc.currentScene, 'target');
  });

  // ══ D-7：idle 回收不得复活已撤销的懒索引 ═══════════════════════════════
  runner.test('D-7/1 场景已撤销的懒索引不得被一次回收写回来', async () => {
    const core = makeCore();
    const pm = new PluginManager(core);
    pm._lazyLoaded.add('lazy1');
    pm.reconcileLazy([], 'other');                       // 目标场景不声明它
    core.lifecycle.unload = async () => ({ ok: true, pluginName: 'lazy1' });
    await pm._recycle('lazy1');
    assertEquals(pm._pending.has('lazy1'), false,
      '修前 _recycle 无条件回写 _pending ⇒ 在没有声明的场景里它又能被按需激活');
    assertEquals(pm._lazyLoaded.has('lazy1'), false);
  });

  runner.test('D-7/2 正例：未被撤销的懒插件回收后必须仍可按需再装载', async () => {
    const core = makeCore();
    const pm = new PluginManager(core);
    pm._lazyLoaded.add('lazy1');
    pm.reconcileLazy(['lazy1'], 'same');                 // 场景仍声明它
    core.lifecycle.unload = async () => ({ ok: true, pluginName: 'lazy1' });
    await pm._recycle('lazy1');
    assertEquals(pm._pending.has('lazy1'), true, '未被撤销 ⇒ 回收必须回到"可再激活"状态（否则懒加载永久失效）');
    assertEquals(pm._lazyLoaded.has('lazy1'), false, '回收完成 ⇒ 不再按已装载记账');
  });
}
