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
    testDir = join(tmpdir(), `tusunsun-lifecycle-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    mkdirSync(join(testDir, 'plugins'), { recursive: true });
    // R0-115（Node 18 兼容）：临时插件目录必须自证是 ESM 包。
    //
    // 实测：Node 20/22 默认"检测模块语法"（detect-module），无 package.json 的目录里
    // 含 `export` 的 `.js` 也能当 ESM 载入；**Node 18 不会** —— 它按 CommonJS 解析，
    // 直接 `Unexpected token 'export'` ⇒ 本文件 3 个用例在 Node 18 上必红
    // （净室产物实测：Node 18 失败 3 件，Node 20/22 全绿）。
    // 真实插件始终位于带 `"type": "module"` 的包内，所以这里补一份 package.json
    // 既贴合真实形态，也让 Node 18 的声明得到真实覆盖。
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({ type: 'module' }));

    core = new Core({
      stateDir: testDir,
      pluginsDir: join(testDir, 'plugins'),
    });
    pm = new PluginManager(core);
    pm.addDirectory(core.pluginsDir);
  });

  runner.afterEach(() => {
    core.removeAllListeners();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  function writePlugin(name, content) {
    const path = join(core.pluginsDir, `${name}.js`);
    writeFileSync(path, content);
    return path;
  }

  runner.test('Lifecycle: full load → start → stop → unload cycle', async () => {
    const events = [];
    core.on('core:plugin.loaded', (p) => { events.push(`loaded:${p.pluginName}`); });
    core.on('core:plugin.unloading', (p) => { events.push(`unloading:${p.pluginName}`); });

    writePlugin('my-plugin', `
      export default {
        name: 'my-plugin',
        version: '1.0.0',
        async init() {},
        async stop() {},
      };
    `);

    await pm.loadAll();
    await core.start();
    assert(core.plugins.has('my-plugin'), 'Plugin should be loaded');

    await pm.unload('my-plugin');
    assert(!core.plugins.has('my-plugin'), 'Plugin should be unloaded');

    assert(events.includes('loaded:my-plugin'), 'Load event should fire');
    assert(events.includes('unloading:my-plugin'), 'Unload event should fire');
  });

  runner.test('Lifecycle: plugin with capabilities clean up on unload', async () => {
    writePlugin('cap-plugin', `
      export default {
        name: 'cap-plugin',
        version: '1.0.0',
        async init(core) {
          core.registerCapability('cap-plugin.action', {
            handler: () => 'done',
            owner: 'cap-plugin',
          });
        },
        async stop() {},
      };
    `);

    await pm.loadAll();
    await core.start();
    assert(core._capabilities.has('cap-plugin.action'), 'Capability should be registered');

    await pm.unload('cap-plugin');
    assert(!core._capabilities.has('cap-plugin.action'), 'Capability should be removed');
  });

  runner.test('Lifecycle: plugin with services clean up on unload', async () => {
    writePlugin('svc-plugin', `
      export default {
        name: 'svc-plugin',
        version: '1.0.0',
        async init(core) {
          core.registerService('my-service', { ping: () => 'pong' });
        },
        async stop() {},
      };
    `);

    await pm.loadAll();
    await core.start();
    assert(core.getService('my-service') !== undefined, 'Service should be registered');

    await pm.unload('svc-plugin');
    assertEquals(core.getService('my-service'), undefined, 'Service should be removed');
  });

  runner.test('Lifecycle: plugin with listeners clean up on unload', async () => {
    writePlugin('listener-plugin', `
      export default {
        name: 'listener-plugin',
        version: '1.0.0',
        async init(core) {
          core.on('test.event', () => {}, { owner: 'listener-plugin' });
          core.on('test.event2', () => {}, { owner: 'listener-plugin' });
        },
        async stop() {},
      };
    `);

    await pm.loadAll();
    await core.start();
    assertEquals(core.listenerCount('test.event'), 1, 'Listener should be registered');

    await pm.unload('listener-plugin');
    assertEquals(core.listenerCount('test.event'), 0, 'Listener should be removed');
  });

  runner.test('Lifecycle: plugin with persistState saves on unload', async () => {
    writePlugin('state-plugin', `
      export default {
        name: 'state-plugin',
        version: '1.0.0',
        async init() {},
        async persistState() {
          globalThis.__persistStateCalled = true;
        },
        async stop() {},
      };
    `);

    await pm.loadAll();
    await core.start();
    await pm.unload('state-plugin');

    assert(globalThis.__persistStateCalled, 'persistState should be called');
    delete globalThis.__persistStateCalled;
  });

  runner.test('Lifecycle: dependent plugin cannot be unloaded', async () => {
    writePlugin('base', `
      export default {
        name: 'base',
        version: '1.0.0',
        requires: {},
        async init() {},
      };
    `);

    writePlugin('dependent', `
      export default {
        name: 'dependent',
        version: '1.0.0',
        requires: { base: '^1.0.0' },
        async init() {},
      };
    `);

    await pm.loadAll();
    await core.start();
    assert(core.plugins.has('base'), 'Base should be loaded');
    assert(core.plugins.has('dependent'), 'Dependent should be loaded');

    let thrownError = null;
    try {
      await pm.unload('base');
    } catch (e) {
      thrownError = e;
    }
    assert(thrownError !== null, 'Should throw when dependent is running');
    assert(thrownError.message.includes('dependent'), 'Should mention dependent');
  });

  runner.test('Lifecycle: multiple plugins unload in correct order', async () => {
    writePlugin('base', `
      export default {
        name: 'base',
        version: '1.0.0',
        async init() {},
        async stop() { globalThis.__unloadOrder = (globalThis.__unloadOrder || []).concat('base'); },
      };
    `);

    writePlugin('ext', `
      export default {
        name: 'ext',
        version: '1.0.0',
        requires: { base: '^1.0.0' },
        async init() {},
        async stop() { globalThis.__unloadOrder = (globalThis.__unloadOrder || []).concat('ext'); },
      };
    `);

    await pm.loadAll();
    await core.start();
    await pm.unload('ext');
    await pm.unload('base');

    const order = globalThis.__unloadOrder || [];
    assertEquals(order.join(','), 'ext,base', 'Plugins should stop in reverse dependency order');
    delete globalThis.__unloadOrder;
  });

  runner.test('Lifecycle: plugin error during start does not crash system', async () => {
    let initFailedEvent = null;
    core.on('plugin.init_failed', (p) => { initFailedEvent = p; });

    writePlugin('broken', `
      export default {
        name: 'broken',
        version: '1.0.0',
        async init() { throw new Error('init failed'); },
      };
    `);

    writePlugin('working', `
      export default {
        name: 'working',
        version: '1.0.0',
        async init() {},
      };
    `);

    await pm.loadAll();
    await core.start();

    assert(core.plugins.has('working'), 'Working plugin should load');
    assert(initFailedEvent !== null, 'init_failed event should fire');
    assertEquals(initFailedEvent.pluginName, 'broken', 'Event should mention broken plugin');
  });

  runner.test('Lifecycle: core start/stop emits events', async () => {
    let readyEvent = null;
    let stoppedEvent = null;

    core.on('core.ready', (p) => { readyEvent = p; });
    core.on('core.stopped', (p) => { stoppedEvent = p; });

    writePlugin('test', `
      export default {
        name: 'test',
        version: '1.0.0',
        async init() {},
      };
    `);

    await pm.loadAll();
    await core.start();

    assert(readyEvent !== null, 'core.ready event should fire');
    assertEquals(readyEvent.plugins, 1, 'Should report 1 plugin');

    await core.stop();
    assert(stoppedEvent !== null, 'core.stopped event should fire');
  });

  runner.test('Lifecycle: status returns correct plugin states', async () => {
    writePlugin('running-plugin', `
      export default {
        name: 'running-plugin',
        version: '1.0.0',
        async init() {},
      };
    `);

    await pm.loadAll();
    await core.start();

    const status = core.status();
    assert(status.running, 'Core should be running');
    assert(status.uptime, 'Should have uptime');
    assert(status.plugins.length > 0, 'Should list plugins');

    const plugin = status.plugins.find(p => p.name === 'running-plugin');
    assert(plugin !== undefined, 'Should find running-plugin');
    assertEquals(plugin.state, 'running', 'Plugin should be running');
    assert(plugin.metrics !== null, 'Should have metrics');
  });
}
