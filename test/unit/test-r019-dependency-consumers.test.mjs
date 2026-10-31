/**
 * R019：依赖关系**所有消费者**的回归锁。
 *
 * 一条关系只能有一种解释。`buildDAG`（启动）与 `computeStopOrder`（停机）在 rc.5 已统一，
 * 但同一种语义还有两个外围消费者各解释一套：
 *   R19-01 运行中卸载：`_step1CheckDependents` 只比 `requires[pluginName]`，
 *          服务名依赖直接穿透 —— 提供者被卸、服务消失，依赖方还 running。
 *   R19-02 懒加载闭包：`resolveLazyChain` 只按 `pending.get(depName)` 递归，
 *          服务名依赖的提供者永远进不了闭包，依赖方单独 init 后在缺服务上失败。
 *
 * 纪律：每条缺陷配合法正例（无关提供者可卸、optional 不阻止、独立懒插件不被连带），
 * 防止"一律拒绝/一律全装"式假修复。
 */
import { TestRunner, assert, assertEquals } from '../harness.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Core } from '../../src/core/core.js';
import { PluginManager } from '../../src/core/plugin-manager.js';

const pluginOf = (name, extra = {}) => ({
  name, version: '1.0.0', state: 'registered',
  init: async () => {}, start: async () => {}, stop: async () => {},
  ...extra,
});

export async function setup(runner) {
  let dirs = [];
  let cores = [];

  const makeCore = () => {
    const dir = mkdtempSync(join(tmpdir(), 'tusunsun-r019-'));
    dirs.push(dir);
    const core = new Core({ stateDir: dir });
    core.log = () => {};
    core._stopAssemblyDrainMs = 20;
    cores.push(core);
    return core;
  };

  const unload = async (core, name) => {
    try { return await core.lifecycle.unload(name); } catch (err) { return { ok: false, error: err.message }; }
  };

  runner.beforeEach(() => { dirs = []; cores = []; });
  runner.afterEach(async () => {
    for (const core of cores) { try { core.removeAllListeners(); } catch { /* 已清理 */ } }
    for (const dir of dirs) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 已清理 */ } }
  });

  runner.test('R019-01 卸载仍被运行中插件依赖的服务提供者必须被拒', async () => {
    const core = makeCore();
    await core.register(pluginOf('provider', {
      provides: ['db-service'],
      init: async (c) => { c.registerService('db-service', { ok: true }, { owner: 'provider' }); },
    }));
    await core.register(pluginOf('dependent', {
      requires: { 'db-service': '*' },
      init: async (c) => { if (!c.getService('db-service')) throw new Error('MISSING_DB_SERVICE'); },
    }));
    await core.start();
    const r = await unload(core, 'provider');
    assertEquals(r.ok, false, `服务名依赖必须拦住卸载，实测 ${JSON.stringify(r)}`);
    assert(String(r.error).includes('dependent'), `拒绝信息要点名依赖方：${r.error}`);
    assert(core.plugins.has('provider'), '拒绝之后 provider 必须还在');
    assertEquals(core.plugins.get('dependent').state, 'running');
  });

  runner.test('R019-02 插件名依赖的拦截不回归', async () => {
    const core = makeCore();
    await core.register(pluginOf('prov'));
    await core.register(pluginOf('dep', { requires: { prov: '^1.0.0' } }));
    await core.start();
    const r = await unload(core, 'prov');
    assertEquals(r.ok, false, `插件名依赖同样必须拦（实测 ${JSON.stringify(r)}）`);
    assertEquals(core.plugins.get('dep').state, 'running');
  });

  runner.test('R019-03【正例】没有依赖方的服务提供者可以正常卸载', async () => {
    const core = makeCore();
    await core.register(pluginOf('lonely', { provides: ['lonely-svc'] }));
    await core.start();
    const r = await unload(core, 'lonely');
    assertEquals(r.ok, true, `无关提供者必须能卸（实测 ${JSON.stringify(r)}）`);
    assert(!core.plugins.has('lonely'));
  });

  runner.test('R019-04【正例】optional 依赖不阻止卸载', async () => {
    const core = makeCore();
    await core.register(pluginOf('prov', { provides: ['opt-svc'] }));
    await core.register(pluginOf('user', { optional: { 'opt-svc': '*' } }));
    await core.start();
    const r = await unload(core, 'prov');
    assertEquals(r.ok, true, `可选依赖不该被当成硬依赖（实测 ${JSON.stringify(r)}）`);
  });

  runner.test('R019-05 依赖方已停止时，提供者可以卸载（拦截只针对 still-running）', async () => {
    const core = makeCore();
    await core.register(pluginOf('prov', { provides: ['db-service'] }));
    await core.register(pluginOf('dep', { requires: { 'db-service': '*' } }));
    await core.start();
    // 手工把依赖方降级为 stopped：它不再使用该服务，就不该再拦住提供者。
    core.lifecycle.advance(core.plugins.get('dep'), 'stopped');
    const r = await unload(core, 'prov');
    assertEquals(r.ok, true, `依赖方已停，提供者应可卸（实测 ${JSON.stringify(r)}）`);
  });

  runner.test('R019-06 懒加载闭包必须把服务提供者拉进来，且先于依赖方 init', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tusunsun-r019-lazy-'));
    dirs.push(dir);
    const pluginDir = join(dir, 'plugins');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'package.json'), '{"type":"module"}');
    writeFileSync(join(pluginDir, 'provider.mjs'), `
export const name = 'provider';
export const version = '1.0.0';
export const provides = ['db-service'];
export default {
  name, version, provides,
  init: async (core) => {
    core.setData('r19.order', [...(core.getData('r19.order') || []), 'provider']);
    core.registerService('db-service', { ok: true }, { owner: 'provider' });
  },
};
`);
    writeFileSync(join(pluginDir, 'dependent.mjs'), `
export const name = 'dependent';
export const version = '1.0.0';
export const provides = ['dependent.work'];
export const requires = { 'db-service': '*' };
export default {
  name, version, provides, requires,
  init: async (core) => {
    if (!core.getService('db-service')) throw new Error('MISSING_DB_SERVICE');
    core.setData('r19.order', [...(core.getData('r19.order') || []), 'dependent']);
    core.registerCapability('dependent.work', { handler: async () => ({ ok: true }) });
  },
};
`);
    const core = new Core({ stateDir: dir, pluginsDir: pluginDir });
    core.log = () => {};
    cores.push(core);
    const pm = new PluginManager(core);
    pm.addDirectory(pluginDir);
    await pm.loadAll([], ['provider', 'dependent']);
    await pm._resolveLazy('dependent.work');
    assertEquals(core.plugins.get('provider')?.state, 'running', '提供者必须先被装进来');
    assertEquals(core.plugins.get('dependent')?.state, 'running', '依赖方必须装载成功');
    assertEquals((core.getData('r19.order') || []).join('->'), 'provider->dependent',
      'init 顺序必须是提供者先');
  });

  runner.test('R019-07【正例】独立懒插件不被连带，也不连带别人', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tusunsun-r019-lazy2-'));
    dirs.push(dir);
    const pluginDir = join(dir, 'plugins');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'package.json'), '{"type":"module"}');
    writeFileSync(join(pluginDir, 'provider.mjs'), `
export const name = 'provider';
export const version = '1.0.0';
export const provides = ['db-service'];
export default { name, version, provides, init: async (core) => { core.registerService('db-service', {}, { owner: 'provider' }); } };
`);
    writeFileSync(join(pluginDir, 'dependent.mjs'), `
export const name = 'dependent';
export const version = '1.0.0';
export const provides = ['dependent.work'];
export const requires = { 'db-service': '*' };
export default { name, version, provides, requires, init: async () => {} };
`);
    writeFileSync(join(pluginDir, 'standalone.mjs'), `
export const name = 'standalone';
export const version = '1.0.0';
export const provides = ['standalone.cap'];
export default { name, version, provides, init: async (core) => { core.registerCapability('standalone.cap', { handler: async () => ({ ok: true }) }); } };
`);
    const core = new Core({ stateDir: dir, pluginsDir: pluginDir });
    core.log = () => {};
    cores.push(core);
    const pm = new PluginManager(core);
    pm.addDirectory(pluginDir);
    await pm.loadAll([], ['provider', 'dependent', 'standalone']);
    await pm._resolveLazy('standalone.cap');
    assert(core.plugins.has('standalone'), 'standalone 必须装载');
    assert(!core.plugins.has('dependent'), '不得连带装载 dependent');
    assert(!core.plugins.has('provider'), '不得连带装载 provider');
  });

  runner.test('R019-08【正例】服务名依赖的启动排序仍正确（buildDAG 未回归）', async () => {
    const core = makeCore();
    const pm = new PluginManager(core);
    const order = [];
    await core.register(pluginOf('provider', { provides: ['svc-a'], init: async () => { order.push('provider'); } }));
    await core.register(pluginOf('dependent', { requires: { 'svc-a': '*' }, init: async () => { order.push('dependent'); } }));
    const sorted = pm.resolver.topologicalSort([...core.plugins.values()]);
    assert(sorted.ok, `启动排序必须成功：${JSON.stringify(sorted)}`);
    assertEquals(sorted.order.join('->'), 'provider->dependent', '启动：提供者先装');
  });
}

export default setup;
