import { Core } from '../../src/core/core.js';
import { PluginManager } from '../../src/core/plugin-manager.js';
import { TestRunner, assert, assertEquals } from '../harness.mjs';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export async function setup(runner) {
  let core;
  let pm;
  let testDir;

  runner.beforeEach(() => {
    testDir = join(tmpdir(), `tusunsun-pm-adv-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    core = new Core({ stateDir: testDir, pluginsDir: join(testDir, 'plugins') });
    pm = new PluginManager(core);
  });

  runner.afterEach(() => {
    core.removeAllListeners();
    pm.stopWatching();
    pm._stopIdleTimer();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  function writePlugin(name, content) {
    mkdirSync(core.pluginsDir, { recursive: true });
    // R0-113：Node 18 无 ESM 语法探测 ⇒ 夹具目录显式声明模块类型（产品包内 type=module）。
    // 放在 writePlugin 里：本文件所有夹具目录都经它创建。
    writeFileSync(join(core.pluginsDir, 'package.json'), '{"type":"module"}');
    const p = join(core.pluginsDir, `${name}.js`);
    writeFileSync(p, content);
    return p;
  }

  runner.test('PluginManager: 已删除的外接引擎写路径不得复活', () => {
    assert(typeof pm._writeToExternalEngine === 'undefined', '死代码不得复活');
    assert(pm._externalEngineOnline === undefined, '死字段不得复活');
  });

  runner.test('PluginManager: _resolveLazy wildcard match', async () => {
    pm._wildcardIndex.set('tool.', 'tool-plugin');
    pm._pending.set('tool-plugin', {
      provides: ['tool.read', 'tool.write'],
      requires: {},
      version: '1.0.0',
      filePath: writePlugin('tool-plugin', `
        export default { name: 'tool-plugin', version: '1.0.0', provides: ['tool.read'], init: async () => {} };
      `),
    });

    await pm._resolveLazy('tool.read');
    assert(pm._lazyLoaded.has('tool-plugin') || pm._loading.has('tool-plugin'), 'Should attempt to load tool-plugin');
  });

  runner.test('PluginManager: _resolveLazy not found returns undefined', async () => {
    const result = await pm._resolveLazy('nonexistent.capability');
    assertEquals(result, undefined, 'Should return undefined for unknown capability');
  });

  runner.test('PluginManager: _resolveLazy plugin not in pending', async () => {
    pm._providesIndex.set('some.cap', 'missing-plugin');
    const result = await pm._resolveLazy('some.cap');
    assertEquals(result, undefined, 'Should return undefined when not in pending');
  });

  runner.test('PluginManager: _lazyLoadOne deduplication', async () => {
    writePlugin('dedup-plugin', `
      export default { name: 'dedup-plugin', version: '1.0.0', provides: ['dedup'], init: async () => {} };
    `);
    pm._pending.set('dedup-plugin', {
      provides: ['dedup'],
      requires: {},
      version: '1.0.0',
      filePath: join(core.pluginsDir, 'dedup-plugin.js'),
    });

    const [r1, r2] = await Promise.all([
      pm._lazyLoadOne('dedup-plugin'),
      pm._lazyLoadOne('dedup-plugin'),
    ]);
    assert(pm._lazyLoaded.has('dedup-plugin'), 'Should be loaded once');
  });

  runner.test('PluginManager: _lazyLoadOne eager skip', async () => {
    pm._eager.add('eager-skip');
    await pm._lazyLoadOne('eager-skip');
    assert(!pm._lazyLoaded.has('eager-skip'), 'Eager plugins should not be lazy loaded');
  });

  runner.test('PluginManager: _lazyLoadOne not in pending throws', async () => {
    let threw = false;
    try { await pm._lazyLoadOne('nonexistent'); } catch { threw = true; }
    assert(threw, 'Should throw when not in pending');
  });

  runner.test('PluginManager: _lazyLoadOne no file path throws', async () => {
    pm._pending.set('no-path', { provides: [], requires: {}, version: '1.0.0', filePath: null });
    let threw = false;
    try { await pm._lazyLoadOne('no-path'); } catch { threw = true; }
    assert(threw, 'Should throw when file path missing');
  });

  runner.test('PluginManager: _lazyLoadOne invalid plugin file throws', async () => {
    const path = writePlugin('invalid-lazy', `export default { notAPlugin: true };`);
    pm._pending.set('invalid-lazy', {
      provides: [{ name: 'inv' }],
      requires: {},
      version: '1.0.0',
      filePath: path,
    });
    let threw = false;
    try { await pm._lazyLoadOne('invalid-lazy'); } catch { threw = true; }
    assert(threw, 'Should throw for invalid plugin');
    assert(!pm._loading.has('invalid-lazy'), 'Should clean up _loading on failure');
  });

  runner.test('PluginManager: _recycle error handling', async () => {
    pm._pending.set('recycle-test', { provides: [], requires: {}, version: '1.0.0', filePath: '' });
    pm._lazyLoaded.add('recycle-test');
    await pm._recycle('recycle-test');
    assert(!pm._lazyLoaded.has('recycle-test'), 'Should remove from lazyLoaded even on error');
  });

  runner.test('PluginManager: _startIdleTimer idempotent', () => {
    pm._startIdleTimer();
    const timer1 = pm._idleTimer;
    pm._startIdleTimer();
    const timer2 = pm._idleTimer;
    assertEquals(timer1, timer2, 'Should not create second timer');
    pm._stopIdleTimer();
  });

  runner.test('PluginManager: recycleAll', async () => {
    pm._lazyLoaded.add('lazy-a');
    pm._lazyLoaded.add('lazy-b');
    pm._eager.add('lazy-b');
    pm._pending.set('lazy-a', { provides: [], requires: {}, version: '1.0.0', filePath: '' });

    await pm.recycleAll();
    assert(!pm._lazyLoaded.has('lazy-a'), 'lazy-a should be recycled');
    assert(pm._lazyLoaded.has('lazy-b'), 'eager plugin should not be recycled');
  });

  runner.test('PluginManager: getLastAccess', () => {
    pm._touchAccess('test-plugin');
    const access = pm.getLastAccess('test-plugin');
    assert(typeof access === 'number', 'Should return timestamp');
    assert(access > 0, 'Timestamp should be positive');
  });

  runner.test('PluginManager: getLastAccess unknown returns undefined', () => {
    assertEquals(pm.getLastAccess('unknown'), undefined, 'Should return undefined for unknown');
  });

  runner.test('PluginManager: _indexLazyPlugin no name skips', async () => {
    const path = writePlugin('no-name', `export default { version: '1.0.0' };`);
    await pm._indexLazyPlugin('no-name.js', path);
    assert(!pm._pending.has('no-name'), 'Should not be indexed');
  });

  runner.test('PluginManager: _indexLazyPlugin valid plugin', async () => {
    const path = writePlugin('indexed', `
      export const name = 'indexed';
      export const version = '1.0.0';
      export const provides = [{ name: 'cap.a' }];
      export async function init(core) {}
    `);
    await pm._indexLazyPlugin('indexed.js', path);
    assert(pm._pending.has('indexed'), 'Should be indexed');
    assertEquals(pm._pluginFilePaths.get('indexed'), path, 'File path should be stored');
  });

  runner.test('PluginManager: _indexProvides wildcard', () => {
    pm._indexProvides({ name: 'wild-plugin', provides: [{ name: 'tool.*' }] });
    assertEquals(pm._wildcardIndex.get('tool'), 'wild-plugin', 'Should index wildcard');
  });

  runner.test('PluginManager: _indexProvides service type', () => {
    pm._indexProvides({ name: 'svc-plugin', provides: [{ name: 'db', type: 'service' }] });
    assertEquals(pm._svcIndex.get('db'), 'svc-plugin', 'Should index service');
  });

  runner.test('PluginManager: _warnMissingProvides', async () => {
    pm._pending.set('empty-provides', { provides: [], requires: {}, version: '1.0.0', filePath: '' });
    pm._warnMissingProvides();
    assert(true, 'Should not crash');
  });

  runner.test('PluginManager: watchForChanges ignores non-js files', async () => {
    mkdirSync(core.pluginsDir, { recursive: true });
    writeFileSync(join(core.pluginsDir, 'readme.txt'), 'not a plugin');
    pm.addDirectory(core.pluginsDir);
    pm.watchForChanges();

    const txtPath = join(core.pluginsDir, 'readme.txt');
    writeFileSync(txtPath, 'updated content');
    await new Promise(r => setTimeout(r, 100));

    assert(!core.plugins.has('readme'), 'Non-js file should not trigger load');
    pm.stopWatching();
  });
}
