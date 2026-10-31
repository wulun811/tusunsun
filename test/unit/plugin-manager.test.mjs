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
    testDir = join(tmpdir(), `tusunsun-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    // R0-113：Node 18 没有 ESM 语法探测（Node 22 才有）——临时目录不是模块包时，
    // 里面用 ESM 写的 `.js` 夹具会被当 CJS 解析（实测 11 例红）。放一个 type:module 即可，
    // 夹具内容一字不改；这也正是产品插件目录（包内 type=module）的真实形态。
    writeFileSync(join(testDir, 'package.json'), '{"type":"module"}');
    core = new Core({ stateDir: '/tmp/test-core', pluginsDir: testDir });
    pm = new PluginManager(core);
  });

  runner.afterEach(() => {
    core.removeAllListeners();
    pm.stopWatching();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  function writePlugin(name, content) {
    const path = join(testDir, `${name}.js`);
    writeFileSync(path, content);
    return path;
  }

  runner.test('PluginManager: addDirectory registers path', () => {
    pm.addDirectory('/some/path');
    assertEquals(pm.dirs.length, 1, 'Should have 1 directory');
    assertEquals(pm.dirs[0], '/some/path', 'Directory should match');
  });

  runner.test('PluginManager: addDirectory supports multiple paths', () => {
    pm.addDirectory('/path/1');
    pm.addDirectory('/path/2');
    assertEquals(pm.dirs.length, 2, 'Should have 2 directories');
  });

  runner.test('PluginManager: loadFromDir with valid plugin', async () => {
    writePlugin('test-plugin', `
      export default {
        name: 'test-plugin',
        version: '1.0.0',
        init: async () => {},
      };
    `);

    pm.addDirectory(testDir);
    await pm.loadAll();
    assert(core.plugins.has('test-plugin'), 'Plugin should be loaded');
  });

  runner.test('PluginManager: loadFromDir skips non-plugin files', async () => {
    writePlugin('not-a-plugin', `
      export default { foo: 'bar' };
    `);

    pm.addDirectory(testDir);
    await pm.loadAll();
    assert(!core.plugins.has('not-a-plugin'), 'Non-plugin should be skipped');
  });

  runner.test('PluginManager: loadFromDir skips non-js files', async () => {
    writeFileSync(join(testDir, 'readme.txt'), 'not a plugin');

    pm.addDirectory(testDir);
    await pm.loadAll();
    assertEquals(core.plugins.size, 0, 'No plugins should be loaded');
  });

  runner.test('PluginManager: loadFromDir handles invalid JS', async () => {
    writePlugin('broken', `
      export default { syntax error here!!!
    `);

    pm.addDirectory(testDir);
    await pm.loadAll();
    assert(!core.plugins.has('broken'), 'Broken plugin should be skipped');
  });

  runner.test('PluginManager: loadFromDir with nonexistent directory', async () => {
    pm.addDirectory('/nonexistent/path');
    await pm.loadAll();
    assertEquals(core.plugins.size, 0, 'No plugins should be loaded');
  });

  runner.test('PluginManager: loadAll with whitelist', async () => {
    writePlugin('plugin-a', `
      export default { name: 'plugin-a', version: '1.0.0', init: async () => {} };
    `);
    writePlugin('plugin-b', `
      export default { name: 'plugin-b', version: '1.0.0', init: async () => {} };
    `);

    pm.addDirectory(testDir);
    await pm.loadAll(['plugin-a']);
    assert(core.plugins.has('plugin-a'), 'Whitelisted plugin should be loaded');
    assert(!core.plugins.has('plugin-b'), 'Non-whitelisted plugin should be skipped');
  });

  runner.test('PluginManager: topological sort on load', async () => {
    writePlugin('core', `
      export default { name: 'core', version: '1.0.0', requires: {}, init: async () => {} };
    `);
    writePlugin('auth', `
      export default { name: 'auth', version: '1.0.0', requires: { core: '^1.0.0' }, init: async () => {} };
    `);

    pm.addDirectory(testDir);
    await pm.loadAll();

    const corePlugin = core.plugins.get('core');
    const authPlugin = core.plugins.get('auth');
    assert(corePlugin, 'core should be loaded');
    assert(authPlugin, 'auth should be loaded');
  });

  runner.test('PluginManager: unload delegates to LifecycleManager', async () => {
    writePlugin('my-plugin', `
      export default { name: 'my-plugin', version: '1.0.0', init: async () => {} };
    `);

    pm.addDirectory(testDir);
    await pm.loadAll();
    assert(core.plugins.has('my-plugin'), 'Plugin should be loaded');

    const result = await pm.unload('my-plugin');
    assert(result.ok, 'Unload should succeed');
    assert(!core.plugins.has('my-plugin'), 'Plugin should be removed');
  });

  runner.test('PluginManager: unload plugin not found', async () => {
    const result = await pm.unload('nonexistent');
    assert(!result.ok, 'Should fail');
    assert(result.error.includes('not found'), 'Should mention not found');
  });

  runner.test('PluginManager: stopWatching without watcher', () => {
    pm.stopWatching();
    assertEquals(pm.watcher, null, 'Watcher should be null');
  });
}
