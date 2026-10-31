import { PluginManager } from '../../src/core/plugin-manager.js';
import { LifecycleManager } from '../../src/core/lifecycle-manager.js';
import { Core } from '../../src/core/core.js';
import { TestRunner, assertEquals, assert } from '../harness.mjs';

export async function setup(runner) {
  let pm;
  let core;

  runner.beforeEach(() => {
    core = {
      _capabilities: new Map(),
      _services: new Map(),
      _inflight: new Map(),
      plugins: new Map(),
      _lazyHook: null,
      get: () => undefined,
      getService: () => null,
      log() {},
      emit() {},
      colorize: () => '',
    };
    // Core 的合同：每个 Core 恰好一份生命周期独占区。测试替身必须满足这条合同 ——
    // 否则 PluginManager 拿到的是 undefined，而那不是"可选的依赖"。
    core.lifecycle = new LifecycleManager(core);
    pm = new PluginManager(core);
  });

  runner.test('_touchAccess: records timestamp', () => {
    pm._touchAccess('plugin-a');
    assert(pm._lastAccess.has('plugin-a'), 'Timestamp recorded');
    const ts = pm._lastAccess.get('plugin-a');
    assert(ts > 0, 'Timestamp is positive');

    pm._touchAccess('plugin-a');
    const ts2 = pm._lastAccess.get('plugin-a');
    assert(ts2 >= ts, 'Timestamp updated on second call');
  });

  runner.test('_touchAccess: separate plugins are independent', () => {
    pm._touchAccess('plugin-a');
    pm._touchAccess('plugin-b');
    assert(pm._lastAccess.has('plugin-a'), 'plugin-a recorded');
    assert(pm._lastAccess.has('plugin-b'), 'plugin-b recorded');
  });

  runner.test('_checkIdle: basic idle TTL recycle', async () => {
    const name = 'idle-plugin';
    pm._lazyLoaded.add(name);
    pm._lastAccess.set(name, Date.now() - 310_000); // >5min idle
    pm._loadTime.set(name, Date.now() - 600_000);   // loaded 10min ago

    let recycled = false;
    const origUnload = pm.lc.unload;
    pm.lc.unload = async () => { recycled = true; return { ok: true }; };  // 真实合同形状

    await pm._checkIdle();
    assert(recycled, 'Plugin recycled after idle TTL exceeded');
    assert(!pm._lazyLoaded.has(name), 'Removed from lazyLoaded');

    pm.lc.unload = origUnload;
  });

  runner.test('_checkIdle: does not recycle within TTL', async () => {
    const name = 'active-plugin';
    pm._lazyLoaded.add(name);
    pm._lastAccess.set(name, Date.now() - 60_000); // 1min idle (< 5min TTL)
    pm._loadTime.set(name, Date.now() - 120_000);

    let recycled = false;
    const origUnload = pm.lc.unload;
    pm.lc.unload = async () => { recycled = true; return { ok: true }; };  // 真实合同形状

    await pm._checkIdle();
    assert(!recycled, 'Plugin NOT recycled within TTL');

    pm.lc.unload = origUnload;
  });

  runner.test('_checkIdle: 24h hard limit recycle', async () => {
    const name = 'ancient-plugin';
    pm._lazyLoaded.add(name);
    pm._lastAccess.set(name, Date.now() - 1000); // recently accessed
    pm._loadTime.set(name, Date.now() - 86400_001); // loaded >24h ago

    let recycled = false;
    const origUnload = pm.lc.unload;
    pm.lc.unload = async () => { recycled = true; return { ok: true }; };  // 真实合同形状

    await pm._checkIdle();
    assert(recycled, 'Plugin recycled at 24h hard limit');

    pm.lc.unload = origUnload;
  });

  runner.test('_checkIdle: recycleCooldown prevents thrash', async () => {
    const name = 'cooldown-plugin';
    pm._lazyLoaded.add(name);
    pm._lastAccess.set(name, Date.now() - 310_000); // >5min idle
    pm._loadTime.set(name, Date.now() - 600_000);
    pm._lastRecycleTime.set(name, Date.now() - 30_000); // recycled 30s ago (< 60s cooldown)

    let recycled = false;
    const origUnload = pm.lc.unload;
    pm.lc.unload = async () => { recycled = true; return { ok: true }; };  // 真实合同形状

    await pm._checkIdle();
    assert(!recycled, 'Plugin NOT recycled within cooldown period');

    pm.lc.unload = origUnload;
  });

  runner.test('_recycle: cleans up plugin data', async () => {
    const name = 'recycled-plugin';
    pm._lazyLoaded.add(name);
    pm._lastAccess.set(name, Date.now());
    pm._loadTime.set(name, Date.now());
    pm._pending.set(name, { provides: [], requires: {}, version: '1.0.0', filePath: '', plugin: null });

    const origUnload = pm.lc.unload;
    pm.lc.unload = async () => ({ ok: true });

    await pm._recycle(name);
    assert(!pm._lazyLoaded.has(name), 'Removed from lazyLoaded');
    assert(!pm._lastAccess.has(name), 'lastAccess cleaned');
    assert(!pm._loadTime.has(name), 'loadTime cleaned');
    assert(pm._lastRecycleTime.has(name), 'Recycle time recorded');

    pm.lc.unload = origUnload;
  });

  runner.test('_checkIdle: eager plugins are skipped', async () => {
    const name = 'eager-plugin';
    pm._lazyLoaded.add(name);
    pm._eager.add(name);
    pm._lastAccess.set(name, Date.now() - 600_000); // very old

    let recycled = false;
    const origUnload = pm.lc.unload;
    pm.lc.unload = async () => { recycled = true; return { ok: true }; };  // 真实合同形状

    await pm._checkIdle();
    assert(!recycled, 'Eager plugin NOT recycled');

    pm.lc.unload = origUnload;
  });

  runner.test('callCapability: _touchAccess called on invoke', async () => {
    const realCore = new Core({ stateDir: '/tmp/test-daoists', pluginsDir: '/tmp' });
    const realPm = new PluginManager(realCore);
    realCore._services.set('plugin-manager', realPm);

    realCore.registerCapability('tool.read', { owner: 'reader', handler: async () => 'ok' });
    await realCore.callCapability('tool.read', {});

    assert(realPm._lastAccess.has('reader'), '_touchAccess called for owner');
    assert(realPm._lastAccess.get('reader') > 0, 'Timestamp is positive');
  });
}
