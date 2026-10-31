/**
 * R018：**权威唯一性**的回归锁（两件事，一个判据）。
 *
 * ① 独占区只有一份：`pm.lc` 与 `core.lifecycle` 必须是同一个实例。
 *    两个实例各自"串行"没有意义 —— 同一 key 落在两把锁上就不再串行，
 *    状态轨迹与非法计数也各记一本；`getTransitions()` 只看得见自己那本。
 *
 * ② 依赖边只有一个解释位置：启动排序与停机排序必须对同一份 `requires` 得出
 *    同一种"谁依赖谁"。只认插件名时，`requires: { 'db-service': ... }` 会被当成
 *    "没有依赖"，停机退回插入序 —— 提供方先于依赖方停，而载荷仍写着"有序"。
 *
 * 纪律：每条断言都指向可复现的**行为**（并发峰值、真实 stop 顺序、事件载荷），
 * 不只断言内部字段；每条缺陷配一条合法正例（同 key 不同名可并行、正常依赖顺序）。
 */
import { TestRunner, assert, assertEquals } from '../harness.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Core } from '../../src/core/core.js';
import { PluginManager } from '../../src/core/plugin-manager.js';
import { computeStopOrder } from '../../src/core/dependency-resolver.js';

const pluginOf = (name, extra = {}) => ({
  name, version: '1.0.0',
  init: async () => {}, start: async () => {}, stop: async () => {},
  ...extra,
});

export async function setup(runner) {
  let dirs = [];
  let cores = [];

  const makeCore = () => {
    const dir = mkdtempSync(join(tmpdir(), 'tusunsun-r018-'));
    dirs.push(dir);
    const core = new Core({ stateDir: dir });
    core.log = () => {};
    core._stopAssemblyDrainMs = 20;
    cores.push(core);
    const pm = new PluginManager(core);
    return { core, pm };
  };

  runner.beforeEach(() => { dirs = []; cores = []; });

  runner.afterEach(async () => {
    for (const core of cores) { try { core.removeAllListeners(); } catch { /* 已清理 */ } }
    for (const dir of dirs) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 已清理 */ } }
  });

  // ── ① 独占区只有一份 ──────────────────────────────────────────────

  runner.test('R018-01 插件管理器不得自建第二个 LifecycleManager', async () => {
    const { core, pm } = makeCore();
    assert(pm.lc === core.lifecycle,
      `必须同一个实例：两个实例各自"串行"不等于同一把锁（实测 pm.lc=${pm.lc === core.lifecycle ? 'same' : 'different'}）`);
    assertEquals(pm.lc.constructor.name, 'LifecycleManager');
  });

  runner.test('R018-02 同一 key 从两条入口并发进入时，峰值并发必须是 1', async () => {
    const { core, pm } = makeCore();
    let inside = 0;
    let peak = 0;
    const job = async () => {
      inside += 1;
      peak = Math.max(peak, inside);
      await new Promise((r) => setTimeout(r, 30));
      inside -= 1;
    };
    await Promise.all([
      core.lifecycle.runExclusive('same-key', job),
      pm.lc.runExclusive('same-key', job),
    ]);
    assertEquals(peak, 1,
      `同一 key 必须串行；峰值 2 说明两条入口各持一把锁，同一插件可被两个生命周期操作同时改（实测 ${peak}）`);
  });

  runner.test('R018-03 不同名字仍可并行（串行化不能退化成全局锁）', async () => {
    const { pm } = makeCore();
    let inside = 0;
    let peak = 0;
    const job = async () => {
      inside += 1;
      peak = Math.max(peak, inside);
      await new Promise((r) => setTimeout(r, 30));
      inside -= 1;
    };
    await Promise.all([pm.lc.runExclusive('k-a', job), pm.lc.runExclusive('k-b', job)]);
    assertEquals(peak, 2, `不同 key 必须并行，否则一个卡死的插件会拖住整个启动（实测 ${peak}）`);
  });

  runner.test('R018-04 经插件管理器装载的插件，轨迹必须记在 core.lifecycle 账上', async () => {
    const { core, pm } = makeCore();
    const plugin = pluginOf('trace-probe');
    await pm.lc.load(plugin, core);
    const edges = core.lifecycle.getTransitions()
      .filter((t) => t.name === 'trace-probe').map((t) => `${t.from}->${t.to}`);
    assertEquals(edges.join(','), 'registered->started,started->running',
      `状态轨迹只能有一本账；分两本时 getTransitions() 会漏掉经另一条入口发生的跃迁（实测 ${JSON.stringify(edges)}）`);
  });

  runner.test('R018-05 经插件管理器发生的非法跃迁，也必须计入同一套计数', async () => {
    const { core, pm } = makeCore();
    const plugin = pluginOf('illegal-probe');
    await pm.lc.load(plugin, core);
    assertEquals(core.lifecycle.getIllegalTransitionCount(), 0, '正常装载不得产生非法跃迁');
    pm.lc.advance(plugin, 'registered', { bestEffort: true });   // running → registered 非法
    assertEquals(core.lifecycle.getIllegalTransitionCount(), 1,
      '非法跃迁计数只有一本：计数点必须放在被测路径上，不能只统计"自己那条入口"');
  });

  runner.test('R018-06 同一插件从两条入口并发装载，init 只能执行一次', async () => {
    const { core, pm } = makeCore();
    let inits = 0;
    const plugin = pluginOf('once', {
      init: async () => { inits += 1; await new Promise((r) => setTimeout(r, 20)); },
    });
    const [a, b] = await Promise.all([
      core.lifecycle.load(plugin, core),
      pm.lc.load(plugin, core),
    ]);
    assertEquals(inits, 1, `同一插件的装配只能有一个执行者（实测 init ${inits} 次）`);
    assert(a.ok !== false && b.ok !== false, `两次调用都应返回 ok：${JSON.stringify([a, b])}`);
    assertEquals(plugin.state, 'running');
  });

  // ── ② 依赖边只有一个解释位置 ──────────────────────────────────────

  runner.test('R018-07 停机顺序必须解析服务名依赖（依赖方先停）', async () => {
    const { core } = makeCore();
    const order = [];
    await core.register(pluginOf('dependent', {
      requires: { 'db-service': '*' },
      stop: async () => { order.push('dependent'); },
    }));
    await core.register(pluginOf('provider', {
      provides: ['db-service'],
      stop: async () => { order.push('provider'); },
    }));
    await core.start();
    await core.stop();
    assertEquals(order.join('->'), 'dependent->provider',
      `requires 的键是服务名时也必须建边，否则退回插入序、提供方先停（实测 ${order.join('->')}）`);
    assertEquals(core._lastStopOrderBasis, 'dependency', '有可解析的边就必须标成 dependency');
    assertEquals(core._lastStopOrderUnresolved.length, 0);
  });

  runner.test('R018-08 插件名依赖的停机顺序不回归', async () => {
    const { core } = makeCore();
    const order = [];
    await core.register(pluginOf('p1', { stop: async () => { order.push('p1'); } }));
    await core.register(pluginOf('p2', {
      requires: { p1: '^1.0.0' },
      stop: async () => { order.push('p2'); },
    }));
    await core.start();
    await core.stop();
    assertEquals(order.join('->'), 'p2->p1', `插件名依赖同样必须逆序（实测 ${order.join('->')}）`);
  });

  runner.test('R018-09 环不得挂住停机，但必须如实交出环路径', async () => {
    const { core } = makeCore();
    await core.register(pluginOf('a', { requires: { 'b-svc': '*' }, provides: ['a-svc'] }));
    await core.register(pluginOf('b', { requires: { 'a-svc': '*' }, provides: ['b-svc'] }));
    const order = core._stopOrder();   // 直接取顺序：环上不能无限递归
    assertEquals(order.length, 2, `环上仍要给出顺序（实测 ${JSON.stringify(order)}）`);
    assert(core._lastStopOrderCycles.length > 0,
      '停机时出现环必须记下来，不能"排出来了"就当没环');
  });

  runner.test('R018-10 缺席的提供者不建边，但要交给调用方', async () => {
    const { core } = makeCore();
    await core.register(pluginOf('needy', { requires: { 'ghost-service': '*' } }));
    await core.register(pluginOf('other'));
    const order = core._stopOrder();
    assertEquals(order.length, 2);
    assertEquals(core._lastStopOrderUnresolved.length, 1, '缺席的提供者必须出现在 unresolved 里');
    assertEquals(core._lastStopOrderUnresolved[0].dep, 'ghost-service');
    assertEquals(core._lastStopOrderBasis, 'insertion',
      '一条边都建不出来时只能是插入序，必须标注 —— 不能因为"顺序不为空"就说有序');
  });

  runner.test('R018-11 optional 边同样参与停机排序', async () => {
    const { core } = makeCore();
    await core.register(pluginOf('user', { optional: { 'cache-service': '*' } }));
    await core.register(pluginOf('cache', { provides: ['cache-service'] }));
    const order = core._stopOrder();
    assertEquals(order.join('->'), 'user->cache',
      `optional 指向的提供方同样要后停（实测 ${order.join('->')}）`);
    assertEquals(core._lastStopOrderBasis, 'dependency');
  });

  runner.test('R018-12 启动排序与停机排序共用同一份解释（服务名解析）', async () => {
    const dependent = pluginOf('dependent', { requires: { 'db-service': '^1.0.0' } });
    const provider = pluginOf('provider', { provides: [{ name: 'db-service', api_version: '1.2.0' }] });
    const dag = computeStopOrder([provider, dependent]);
    assertEquals(dag.order.join('->'), 'dependent->provider', '停机：依赖方先停');
    // 启动方向由 DependencyResolver.buildDAG 决定，这里只核对"边存在且方向相反"。
    const { core, pm } = makeCore();
    core.plugins.set('dependent', dependent);
    core.plugins.set('provider', provider);
    const startOrder = pm.resolver.topologicalSort([provider, dependent]);
    assert(startOrder.ok, `启动排序必须成功：${JSON.stringify(startOrder)}`);
    assertEquals(startOrder.order.join('->'), 'provider->dependent', '启动：提供方先装');
  });

  runner.test('R018-13 认不出的依赖名在启动排序里仍是硬失败（不得静默放行）', async () => {
    const { pm } = makeCore();
    const r = pm.resolver.topologicalSort([pluginOf('x', { requires: { 'no-such-service': '*' } })]);
    assertEquals(r.ok, false, '启动期认不出的依赖是硬失败；停机期的宽松不应泄漏到启动');
    assert(String(r.error).includes('no-such-service'), `错误串必须点名，实测 ${r.error}`);
  });

  runner.test('R018-14 core.stopped 载荷必须同时交出顺序、依据、缺席与环', async () => {
    const { core } = makeCore();
    let payload = null;
    core.on('core.stopped', (p) => { payload = p; });
    await core.register(pluginOf('solo'));
    await core.start();
    await core.stop();
    assert(payload, 'core.stopped 必须发布');
    for (const key of ['stopOrder', 'stopOrderBasis', 'stopOrderUnresolved', 'stopOrderCycles']) {
      assert(key in payload, `载荷缺字段 ${key}（实测 ${Object.keys(payload).join(',')}）`);
    }
    assertEquals(payload.stopOrderBasis, 'insertion');
    // assertEquals 是严格相等（两个空数组的引用必然不等），所以断言长度而不是数组本身。
    assertEquals(payload.stopOrderUnresolved.length, 0);
    assertEquals(payload.stopOrderCycles.length, 0);
  });

  runner.test('R018-15 三个插件的链式依赖：停机必须整体逆序', async () => {
    const { core } = makeCore();
    const order = [];
    await core.register(pluginOf('base', { provides: ['base-svc'], stop: async () => { order.push('base'); } }));
    await core.register(pluginOf('mid', {
      requires: { 'base-svc': '*' }, provides: ['mid-svc'], stop: async () => { order.push('mid'); },
    }));
    await core.register(pluginOf('top', {
      requires: { 'mid-svc': '*' }, stop: async () => { order.push('top'); },
    }));
    await core.start();
    await core.stop();
    assertEquals(order.join('->'), 'top->mid->base',
      `链式依赖必须整体逆序（实测 ${order.join('->')}）`);
  });
}

export default setup;
