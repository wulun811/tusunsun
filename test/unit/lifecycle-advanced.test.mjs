import { Core } from '../../src/core/core.js';
import { LifecycleManager } from '../../src/core/lifecycle-manager.js';
import { TestRunner, assert, assertEquals } from '../harness.mjs';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export async function setup(runner) {
  let core;
  let lc;
  let testDir;
  let stderrOutput;
  let originalStderrWrite;

  runner.beforeEach(() => {
    testDir = join(tmpdir(), `tusunsun-lc-adv-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    stderrOutput = '';
    originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => { stderrOutput += chunk; return true; };
    core = new Core({ stateDir: testDir, pluginsDir: join(testDir, 'plugins') });
    lc = new LifecycleManager(core);
  });

  runner.afterEach(() => {
    core.removeAllListeners();
    process.stderr.write = originalStderrWrite;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  runner.test('LifecycleManager: _loadDependencies init failure cleans up', async () => {
    const plugin = {
      name: 'fail-init',
      version: '1.0.0',
      init: async () => { throw new Error('init failed'); },
    };
    await core.register(plugin);

    let threw = false;
    try {
      await lc._loadDependencies(plugin, core, { svcIndex: new Map(), pending: new Map(), lazyLoadOne: async () => {} });
    } catch { threw = true; }

    assert(threw, 'Should throw on init failure');
    assert(core._initOwner === null, 'Init owner should be reset');
    assert(core._trackServiceAccess === false, 'Tracking should be disabled');
  });

  runner.test('LifecycleManager: _loadDependencies auto-loads service provider', async () => {
    const lazyLoaded = [];
    const plugin = {
      name: 'svc-user',
      version: '1.0.0',
      requires: {},
      init: async (c) => {
        c.getService('auto-svc');
      },
    };

    const svcIndex = new Map([['auto-svc', 'auto-provider']]);
    const pending = new Map([['auto-provider', { provides: ['auto-svc'], requires: {}, version: '1.0.0', filePath: '' }]]);

    await lc._loadDependencies(plugin, core, { svcIndex, pending, lazyLoadOne: async (n) => { lazyLoaded.push(n); } });

    assert(lazyLoaded.includes('auto-provider'), 'Should auto-load service provider');
  });

  runner.test('LifecycleManager: load start failure cleans up', async () => {
    const plugin = {
      name: 'fail-start',
      version: '1.0.0',
      init: async () => {},
      start: async () => { throw new Error('start failed'); },
    };

    let threw = false;
    try {
      await lc.load(plugin, core);
    } catch { threw = true; }

    assert(threw, 'Should throw on start failure');
    assert(!core.plugins.has('fail-start'), 'Plugin should be unloaded');
  });

  // 本用例需要一个“stop 时留下未清理定时器”的插件，断言审计看得到它。
  //
  // 但那个定时器**必须被清掉**：写成 `setTimeout(() => {}, 99999)` 不 unref，
  // 就是一个**固定 100 秒的 ref 句柄**。旧版整套跑 158s，它会在套件结束前自然到期，
  // 于是一直没被发现问题；一旦套件变快（实测 158s → 90s），它就会跨过末尾，
  // 把 `TT_ASSERT_DRAIN=1` 的保险丝打红 —— 一个**测试自造的资源泄漏**，
  // 而不是产品的问题。修法：用完自己清掉。
  runner.test('LifecycleManager: _auditSideEffects in debug mode', async () => {
    core.registerService('config', { get: (k) => k === 'debug' ? true : null });

    let leakedTimer = null;
    const plugin = {
      name: 'timer-plugin',
      version: '1.0.0',
      init: async () => {},
      stop: async () => {
        // 故意留下一个未清理的定时器（审计要看到它），但登记句柄供本用例收尾清理。
        leakedTimer = setTimeout(() => {}, 99999);
      },
    };

    try {
      await core.register(plugin);
      await lc._step4StopPlugin('timer-plugin', plugin);
      assert(stderrOutput.includes('active timers') || stderrOutput.includes('timer-plugin'), 'Should audit timers in debug mode');
    } finally {
      if (leakedTimer) clearTimeout(leakedTimer);
    }
  });

  runner.test('LifecycleManager: freezeCapability via LC', () => {
    core.registerCapability('test.cap', { handler: () => {}, owner: 'test' });
    lc.freezeCapability('test.cap');
    const cap = core._capabilities.get('test.cap');
    assert(cap._frozen, 'Should be frozen');
    assert(lc._frozenCapabilities.has('test.cap'), 'Should be tracked in LC');
  });

  runner.test('LifecycleManager: unload plugin not found', async () => {
    const result = await lc.unload('nonexistent');
    assert(!result.ok, 'Should fail');
    assert(result.error.includes('not found'), 'Should mention not found');
  });

  runner.test('LifecycleManager: unload with dependents throws', async () => {
    const base = { name: 'base', version: '1.0.0', requires: {}, init: async () => {} };
    const dependent = { name: 'dependent', version: '1.0.0', requires: { base: '^1.0.0' }, init: async () => {} };

    await core.register(base);
    await core.register(dependent);
    base.state = 'running';
    dependent.state = 'running';

    let threw = false;
    try { await lc.unload('base'); } catch { threw = true; }
    assert(threw, 'Should throw when dependents exist');
  });

  runner.test('LifecycleManager: unload removes plugin from core.plugins', async () => {
    const plugin = { name: 'to-unload', version: '1.0.0', init: async () => {} };
    await core.register(plugin);
    plugin.state = 'running';

    const result = await lc.unload('to-unload');
    assert(result.ok, 'Should succeed');
    assert(!core.plugins.has('to-unload'), 'Plugin should be removed');
  });

  runner.test('LifecycleManager: unload emits unloading event', async () => {
    let emitted = false;
    core.on('core:plugin.unloading', () => { emitted = true; });

    const plugin = { name: 'emit-unload', version: '1.0.0', init: async () => {} };
    await core.register(plugin);
    plugin.state = 'running';

    await lc.unload('emit-unload');
    assert(emitted, 'Should emit unloading event');
  });

  runner.test('LifecycleManager: _step4StopPlugin handles stop error gracefully', async () => {
    const plugin = {
      name: 'bad-stop',
      version: '1.0.0',
      init: async () => {},
      stop: async () => { throw new Error('stop error'); },
    };
    await lc._step4StopPlugin('bad-stop', plugin);
    assert(stderrOutput.includes('stop error'), 'Should log stop error');
  });
}
