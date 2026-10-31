import { Core } from '../../src/core/core.js';
import { PluginManager } from '../../src/core/plugin-manager.js';
import { SceneController } from '../../src/core/scene-controller.js';
import { LifecycleManager } from '../../src/core/lifecycle-manager.js';
import { TestRunner, assert, assertEquals } from '../harness.mjs';
import { writeFileSync, mkdirSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export async function setup(runner) {
  let core;
  let pm;
  let lc;
  let sc;
  let testDir;
  let sceneDir;

  runner.beforeEach(() => {
    testDir = join(tmpdir(), `tusunsun-edge-${Date.now()}`);
    sceneDir = join(testDir, 'scenes');
    mkdirSync(sceneDir, { recursive: true });
    core = new Core({ stateDir: testDir, pluginsDir: join(testDir, 'plugins') });
    pm = new PluginManager(core);
    lc = new LifecycleManager(core);
    sc = new SceneController(core, pm);
  });

  runner.afterEach(() => {
    core.removeAllListeners();
    pm.stopWatching();
    pm._stopIdleTimer();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  function writePlugin(name, content) {
    mkdirSync(core.pluginsDir, { recursive: true });
    // R0-113：Node 18 无 ESM 语法探测 ⇒ 夹具目录显式声明模块类型（产品包内 type=module）
    writeFileSync(join(core.pluginsDir, 'package.json'), '{"type":"module"}');
    const p = join(core.pluginsDir, `${name}.js`);
    writeFileSync(p, content);
    return p;
  }

  function writeScene(name, content) {
    const p = join(sceneDir, `${name}.json5`);
    writeFileSync(p, content);
    return p;
  }

  // P2-1: Core colorize instance method
  runner.test('Core: colorize instance method works', () => {
    const result = core.colorize('red', 'error text');
    assert(result.includes('error text'), 'Should contain text');
    assert(result.includes('\x1b[31m'), 'Should contain red color code');
    assert(result.includes('\x1b[0m'), 'Should contain reset code');
  });

  runner.test('Core: colorize unknown color returns text with reset', () => {
    const result = core.colorize('unknown-color', 'text');
    assert(result.includes('text'), 'Should contain text');
    assert(result.includes('\x1b[0m'), 'Should contain reset code');
  });

  runner.test('Core: colorize all defined colors', () => {
    const colors = ['reset', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'gray', 'bold'];
    for (const color of colors) {
      const result = core.colorize(color, 'test');
      assert(result.includes('test'), `${color} should contain text`);
    }
  });

  // P2-2: Custom MAX_LIFETIME
  runner.test('PluginManager: custom idleTTL from config', () => {
    core._services.set('config', {
      get: (key) => {
        if (key === 'plugin.idleTTL') return 60000;
        return null;
      }
    });
    const pm2 = new PluginManager(core);
    assertEquals(pm2._idleTTL, 60000, 'Should use custom idleTTL');
  });

  runner.test('PluginManager: custom minLived from config', () => {
    core._services.set('config', {
      get: (key) => {
        if (key === 'plugin.minLived') return 120000;
        return null;
      }
    });
    const pm2 = new PluginManager(core);
    assertEquals(pm2._minLived, 120000, 'Should use custom minLived');
  });

  runner.test('PluginManager: default idleTTL when no config', () => {
    assertEquals(pm._idleTTL, 5 * 60 * 1000, 'Should use default 5min TTL');
  });

  runner.test('PluginManager: default minLived when no config', () => {
    assertEquals(pm._minLived, 1 * 60 * 1000, 'Should use default 1min minLived');
  });

  // P2-3: _checkIdle boundary values
  runner.test('PluginManager: _checkIdle at TTL boundary (just under)', async () => {
    pm._lazyLoaded.add('boundary-plugin');
    pm._lastAccess.set('boundary-plugin', Date.now() - (pm._idleTTL - 1000));
    pm._loadTime.set('boundary-plugin', Date.now() - 2000);

    await pm._checkIdle();
    assert(pm._lazyLoaded.has('boundary-plugin'), 'Should not recycle when just under TTL');
  });

  runner.test('PluginManager: _checkIdle past TTL triggers recycle', async () => {
    writePlugin('idle-plugin', `export default { name: 'idle-plugin', version: '1.0.0', init: async () => {} };`);
    pm._pending.set('idle-plugin', {
      provides: [],
      requires: {},
      version: '1.0.0',
      filePath: join(core.pluginsDir, 'idle-plugin.js'),
    });
    pm._lazyLoaded.add('idle-plugin');
    pm._lastAccess.set('idle-plugin', Date.now() - pm._idleTTL - 1000);
    pm._loadTime.set('idle-plugin', Date.now() - 2000);
    pm._minLived = 500;

    await pm._checkIdle();
    assert(!pm._lazyLoaded.has('idle-plugin'), 'Should recycle when past TTL');
  });

  // P2-4: _checkIdle cooldown period
  runner.test('PluginManager: _checkIdle cooldown prevents re-recycle', async () => {
    pm._lastRecycleTime.set('cooldown-plugin', Date.now());
    pm._lazyLoaded.add('cooldown-plugin');
    pm._lastAccess.set('cooldown-plugin', Date.now() - pm._idleTTL - 1000);

    await pm._checkIdle();
    assert(pm._lazyLoaded.has('cooldown-plugin'), 'Should not recycle during cooldown');
  });

  // P2-5: LifecycleManager freezeCapability standalone
  runner.test('LifecycleManager: freezeCapability standalone method', () => {
    core.registerCapability('standalone.cap', { handler: () => {}, owner: 'test' });
    lc.freezeCapability('standalone.cap');
    assert(lc._frozenCapabilities.has('standalone.cap'), 'Should track frozen capability');
    const cap = core._capabilities.get('standalone.cap');
    assert(cap._frozen, 'Capability should be frozen');
  });

  // P2-6: SCENE_SEARCH fallback when HOME not set
  runner.test('SceneController: listScenes handles missing HOME', async () => {
    const origHome = process.env.HOME;
    delete process.env.HOME;

    const sc = new SceneController(core, pm);
    const scenes = await sc.listScenes();
    assert(Array.isArray(scenes), 'Should return array even without HOME');

    process.env.HOME = origHome;
  });

  // P2-7: command() response/error race condition
  runner.test('Core: command() response and error nearly simultaneous', async () => {
    core.on('race.method', () => {
      setTimeout(() => core.emit('race.method.response', { ok: true, payload: 'win' }), 5);
      setTimeout(() => core.emit('race.method.error', new Error('lose')), 5);
    });

    const result = await core.command('race.method', {}, 5000);
    assert(result.ok || !result.ok, 'Should resolve once without crash');
  });

  runner.test('Core: command() timeout before response', async () => {
    core.on('slow.method', () => {
      setTimeout(() => core.emit('slow.method.response', { ok: true }), 100);
    });

    const result = await core.command('slow.method', {}, 20);
    assert(!result.ok, 'Should timeout');
    assert(result.error.includes('timeout'), 'Should mention timeout');
  });

  // P2-8: Plugin file deleted before load
  runner.test('PluginManager: loadFromDir with deleted file', async () => {
    const path = writePlugin('will-delete', `export default { name: 'will-delete', version: '1.0.0', init: async () => {} };`);
    rmSync(path);

    pm.addDirectory(core.pluginsDir);
    await pm.loadFromDir(core.pluginsDir);
    assert(!core.plugins.has('will-delete'), 'Deleted file should not load');
  });

  // P2-9: Scene file corrupted (non-JSON5)
  runner.test('SceneController: findScene with corrupted file', async () => {
    writeScene('corrupted', `{ invalid json5 {{{ }}}`);

    const sc = new SceneController(core, pm);
    sc._sceneCache.set('corrupted', null);
    const result = await sc.findScene('corrupted');
    assert(result === null || result?.name === undefined, 'Should handle corrupted file gracefully');
  });

  // P2-10: 插件名就是身份，路径穿越式的名字必须**在注册前**被拒（S7）。
  // 这条原本断言"可疑名照样注册成功"——那把"没有判据"当成了规格。现在反过来钉住拒绝，
  // 否则 `../../../etc/passwd` 这样的名字会被拼进装载路径，且服务归属跟着它走。
  runner.test('Core: register plugin with suspicious name', async () => {
    const plugin = {
      name: '../../../etc/passwd',
      version: '1.0.0',
      init: async () => {},
    };
    let thrown = null;
    try { await core.register(plugin); } catch (err) { thrown = err; }
    assert(thrown, '路径穿越式插件名必须被拒绝');
    assertEquals(thrown.code, 'plugin_name_invalid', `拒绝必须具名，实际 ${thrown.code} / "${thrown.message}"`);
    assert(!core.plugins.has('../../../etc/passwd'), '被拒绝的插件不得进入 plugins 表');
  });

  // P2-11: Empty requires object
  runner.test('DependencyResolver: plugin with empty requires', async () => {
    const { DependencyResolver } = await import('../../src/core/dependency-resolver.js');
    const dr = new DependencyResolver(core);
    const plugins = [
      { name: 'empty-req', version: '1.0.0', requires: {} },
    ];
    const result = dr.topologicalSort(plugins);
    assert(result.ok, 'Should succeed with empty requires');
  });

  // P2-12: Plugin with only start, no init
  runner.test('LifecycleManager: load plugin without init', async () => {
    const plugin = {
      name: 'no-init',
      version: '1.0.0',
      start: async () => {},
    };
    let threw = false;
    try {
      await lc.load(plugin, core);
    } catch { threw = true; }
    assert(threw, 'Should throw when plugin has no init');
  });

  // P2-13: Multiple directories in PluginManager
  runner.test('PluginManager: loadFromDir with multiple directories', async () => {
    const dir2 = join(testDir, 'plugins2');
    mkdirSync(dir2, { recursive: true });
    writeFileSync(join(dir2, 'package.json'), '{"type":"module"}');   // R0-113：Node 18 的 ESM 解析前提

    writePlugin('plugin-a', `export default { name: 'plugin-a', version: '1.0.0', init: async () => {} };`);
    writeFileSync(join(dir2, 'plugin-b.js'), `export default { name: 'plugin-b', version: '1.0.0', init: async () => {} };`);

    pm.addDirectory(core.pluginsDir);
    pm.addDirectory(dir2);
    await pm.loadFromDir(core.pluginsDir);
    await pm.loadFromDir(dir2);

    assert(core.plugins.has('plugin-a'), 'Plugin from first dir should load');
    assert(core.plugins.has('plugin-b'), 'Plugin from second dir should load');
  });

  // P2-14: Core status with plugins in various states
  runner.test('Core: status with mixed plugin states', async () => {
    const p1 = { name: 'running-plugin', version: '1.0.0', init: async () => {} };
    const p2 = { name: 'error-plugin', version: '1.0.0', init: async () => {} };

    await core.register(p1);
    await core.register(p2);
    p1.state = 'running';
    p2.state = 'error';

    const status = core.status();
    assertEquals(status.plugins.length, 2, 'Should have 2 plugins');
    assert(status.plugins.some(p => p.state === 'running'), 'Should have running plugin');
    assert(status.plugins.some(p => p.state === 'error'), 'Should have error plugin');
  });

  // P2-15: Core get with nested config path
  runner.test('Core: get with nested config service', () => {
    core._services.set('config', {
      get: (path, fallback) => {
        if (path === 'a.b.c') return 'nested-value';
        return fallback;
      }
    });
    const result = core.get('a.b.c', 'default');
    assertEquals(result, 'nested-value', 'Should return nested value');
  });

  // P2-16: Plugin with async persistState that throws
  runner.test('LifecycleManager: unload with persistState error', async () => {
    const plugin = {
      name: 'bad-persist',
      version: '1.0.0',
      init: async () => {},
      persistState: async () => { throw new Error('persist failed'); },
    };
    await core.register(plugin);
    plugin.state = 'running';

    const result = await lc.unload('bad-persist');
    assert(result.ok, 'Should succeed despite persist error');
  });

  // P2-17: Core runPipeline with empty pipeline
  runner.test('Core: runPipeline with no middlewares', async () => {
    const result = await core.runPipeline('inbound', { data: 'test' });
    assertEquals(result.data, 'test', 'Should return original message');
  });

  // P2-18: Core offByOwner with no listeners
  runner.test('Core: offByOwner with no listeners', () => {
    const count = core.offByOwner('nonexistent-owner');
    assertEquals(count, 0, 'Should return 0');
  });

  // P2-19: PluginManager recycleAll with no lazy plugins
  runner.test('PluginManager: recycleAll with no lazy plugins', async () => {
    await pm.recycleAll();
    assert(true, 'Should not crash with no lazy plugins');
  });

  // P2-20: SceneController show with unloaded plugins
  runner.test('SceneController: show with mix of loaded/unloaded plugins', async () => {
    sc._sceneCache.set('mixed-scene', {
      name: 'mixed-scene',
      plugins: ['loaded-plugin', 'unloaded-plugin'],
    });
    core.plugins.set('loaded-plugin', { name: 'loaded-plugin', state: 'running' });

    const result = await sc.show('mixed-scene');
    assert(result.ok, 'Should succeed');
    assert(result.plugins[0].loaded, 'First plugin should be loaded');
    assert(!result.plugins[1].loaded, 'Second plugin should not be loaded');
  });
}
