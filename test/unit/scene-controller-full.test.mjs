import { SceneController } from '../../src/core/scene-controller.js';
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
  let sceneDir;
  let sc;

  runner.beforeEach(() => {
    testDir = join(tmpdir(), `tusunsun-sc-test-${Date.now()}`);
    sceneDir = join(testDir, 'scenes');
    mkdirSync(sceneDir, { recursive: true });

    core = new Core({ stateDir: testDir, pluginsDir: join(testDir, 'plugins') });
    pm = new PluginManager(core);
    sc = new SceneController(core, pm);
  });

  runner.afterEach(async () => {
    core.removeAllListeners();
    pm.stopWatching();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  function writeScene(name, content) {
    const p = join(sceneDir, `${name}.json5`);
    writeFileSync(p, content);
    return p;
  }

  function writePlugin(name, content) {
    mkdirSync(core.pluginsDir, { recursive: true });
    // R0-113：Node 18 没有 ESM 语法探测（Node 22 才有）——临时目录不是模块包时，
    // 里面用 ESM 写的 `.js` 夹具会被当 CJS 解析（实测 11 例红）。放一个 type:module 即可，
    // 夹具内容一字不改；这也正是产品插件目录（包内 type=module）的真实形态。
    writeFileSync(join(core.pluginsDir, 'package.json'), '{"type":"module"}');
    const p = join(core.pluginsDir, `${name}.js`);
    writeFileSync(p, content);
    return p;
  }

  runner.test('SceneController: findScene not found', async () => {
    const result = await sc.findScene('nonexistent-scene');
    assertEquals(result, null, 'Should return null for nonexistent scene');
  });

  runner.test('SceneController: findScene cache hit', async () => {
    sc._sceneCache.set('cached-scene', { name: 'cached', plugins: ['a'] });
    const result = await sc.findScene('cached-scene');
    assertEquals(result.name, 'cached', 'Should return cached result');
  });

  runner.test('SceneController: findScene cache returns full config', async () => {
    const cachedCfg = { name: 'full-cached', plugins: ['a', 'b'], optional: ['c'], eager: ['d'] };
    sc._sceneCache.set('full-cached', cachedCfg);
    const result = await sc.findScene('full-cached');
    assertEquals(result.plugins.length, 2, 'Should return cached plugins');
  });

  runner.test('SceneController: switchTo diff mode (no yes)', async () => {
    writePlugin('plugin-a', `export default { name: 'plugin-a', version: '1.0.0', init: async () => {} };`);
    writePlugin('plugin-b', `export default { name: 'plugin-b', version: '1.0.0', init: async () => {} };`);

    core.plugins.set('plugin-a', { name: 'plugin-a', state: 'started' });
    core.plugins.set('plugin-b', { name: 'plugin-b', state: 'started' });
    core.plugins.set('config', { name: 'config' });

    sc._sceneCache.set('new-scene', {
      name: 'new-scene',
      eager: ['plugin-b', 'plugin-c'],
    });

    const result = await sc.switchTo('new-scene');
    assert(result.ok, 'Switch should succeed in diff mode');
    assert(result.diff === true, 'Should be diff mode');
    assert(result.toRemove.includes('plugin-a'), 'plugin-a should be in toRemove');
    assert(result.toAdd.includes('plugin-c'), 'plugin-c should be in toAdd');
  });

  runner.test('SceneController: switchTo scene not found', async () => {
    const result = await sc.switchTo('nonexistent');
    assert(!result.ok, 'Should fail');
    assert(result.error.includes('not found'), 'Error should mention not found');
  });

  runner.test('SceneController: switchTo no changes', async () => {
    core.plugins.set('plugin-a', { name: 'plugin-a', state: 'started' });
    core.plugins.set('config', { name: 'config' });

    sc._sceneCache.set('same-scene', {
      name: 'same-scene',
      plugins: ['plugin-a'],
    });

    const result = await sc.switchTo('same-scene');
    assert(result.ok, 'Should succeed');
    assertEquals(result.toRemove.length, 0, 'Nothing to remove');
    assertEquals(result.toAdd.length, 0, 'Nothing to add');
  });

  runner.test('SceneController: switchTo full mode (yes=true) executes unload+load', async () => {
    writePlugin('plugin-c', `export default { name: 'plugin-c', version: '1.0.0', init: async () => {}, start: async () => {} };`);

    core.plugins.set('plugin-a', { name: 'plugin-a', state: 'started', stop: async () => {} });
    core.plugins.set('config', { name: 'config' });

    sc._sceneCache.set('full-scene', {
      name: 'full-scene',
      plugins: ['plugin-c'],
    });

    const result = await sc.switchTo('full-scene', { yes: true });
    assert(result.ok, 'Switch should succeed');
    assert(!core.plugins.has('plugin-a'), 'plugin-a should be unloaded');
  });

  runner.test('SceneController: listScenes returns array', async () => {
    const scenes = await sc.listScenes();
    assert(Array.isArray(scenes), 'Should return array');
  });

  runner.test('SceneController: show scene not found', async () => {
    const result = await sc.show('nonexistent');
    assert(!result.ok, 'Should fail');
    assert(result.error.includes('not found'), 'Error should mention not found');
  });

  runner.test('SceneController: show scene with cached config', async () => {
    sc._sceneCache.set('show-scene', {
      name: 'show-scene',
      plugins: ['plugin-x'],
    });
    core.plugins.set('plugin-x', { name: 'plugin-x', state: 'running', _metrics: { initTime: 10 } });

    const result = await sc.show('show-scene');
    assert(result.ok, 'Should succeed');
    assertEquals(result.plugins.length, 1, 'Should have 1 plugin');
    assertEquals(result.plugins[0].name, 'plugin-x', 'Plugin name should match');
    assert(result.plugins[0].loaded, 'Plugin should be loaded');
  });

  runner.test('SceneController: _expandIncludes missing include', async () => {
    const cfg = {
      name: 'test',
      plugins: ['a'],
      include: ['missing-scene'],
    };
    const result = await sc._expandIncludes(cfg);
    assert(result.plugins.includes('a'), 'Original plugins preserved');
  });

  runner.test('SceneController: _expandIncludes with valid include', async () => {
    sc._sceneCache.set('base-scene', {
      name: 'base-scene',
      plugins: ['base-plugin'],
      optional: ['opt-plugin'],
      eager: ['eager-plugin'],
    });

    const cfg = {
      name: 'child',
      plugins: ['child-plugin'],
      include: ['base-scene'],
    };
    const result = await sc._expandIncludes(cfg);
    assert(result.plugins.includes('child-plugin'), 'Child plugin preserved');
    assert(result.plugins.includes('base-plugin'), 'Base plugin included');
    assert(result.optional.includes('opt-plugin'), 'Optional included');
    assert(result.eager.includes('eager-plugin'), 'Eager included');
  });

  runner.test('SceneController: _expandIncludes no includes', async () => {
    const cfg = { name: 'no-include', plugins: ['a'] };
    const result = await sc._expandIncludes(cfg);
    assertEquals(result, cfg, 'Should return same config when no includes');
  });

  runner.test('SceneController: _loadSingle file not found', async () => {
    await sc._loadSingle('nonexistent-plugin');
    assert(!core.plugins.has('nonexistent-plugin'), 'Should not load');
  });

  runner.test('SceneController: _loadSingle valid plugin', async () => {
    writePlugin('single-plugin', `
      export default {
        name: 'single-plugin',
        version: '1.0.0',
        init: async () => {},
        start: async () => {},
      };
    `);

    await sc._loadSingle('single-plugin');
    assert(core.plugins.has('single-plugin'), 'Plugin should be loaded');
  });

  runner.test('SceneController: _loadSingle invalid plugin', async () => {
    writePlugin('bad-plugin', `
      export default { notAPlugin: true };
    `);

    await sc._loadSingle('bad-plugin');
    assert(!core.plugins.has('bad-plugin'), 'Invalid plugin should not be loaded');
  });

  runner.test('SceneController: currentScene tracking', async () => {
    assertEquals(sc.currentScene, null, 'Initial scene should be null');
  });

  runner.test('SceneController: _sceneCache starts empty', async () => {
    assertEquals(sc._sceneCache.size, 0, 'Cache should be empty initially');
  });
}
