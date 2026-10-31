import { Core } from '../../src/core/core.js';
import { LifecycleManager } from '../../src/core/lifecycle-manager.js';
import { TestRunner, assert, assertEquals } from '../harness.mjs';

export async function setup(runner) {
  let core;
  let lm;

  runner.beforeEach(() => {
    core = new Core({ stateDir: '/tmp/test-core' });
    lm = new LifecycleManager(core);
  });

  runner.afterEach(() => {
    core.removeAllListeners();
  });

  function makePlugin(name, options = {}) {
    return {
      name,
      version: '1.0.0',
      requires: options.requires || {},
      state: 'running',
      init: async () => {},
      stop: options.stop || null,
      persistState: options.persistState || null,
    };
  }

  runner.test('Lifecycle: unload plugin not found', async () => {
    const result = await lm.unload('nonexistent');
    assert(!result.ok, 'Should fail');
    assert(result.error.includes('not found'), 'Should mention not found');
  });

  runner.test('Lifecycle: step1 blocks if dependent is running', async () => {
    const dep = makePlugin('dep');
    const consumer = makePlugin('consumer', { requires: { dep: '^1.0.0' } });
    await core.register(dep);
    await core.register(consumer);
    dep.state = 'running';
    consumer.state = 'running';

    let thrownError = null;
    try {
      await lm.unload('dep');
    } catch (e) {
      thrownError = e;
    }
    assert(thrownError !== null, 'Should throw when dependent is running');
    assert(thrownError.message.includes('consumer'), 'Should mention dependent plugin name');
  });

  runner.test('Lifecycle: step1 allows unload if no dependents', async () => {
    const plugin = makePlugin('standalone');
    await core.register(plugin);

    const result = await lm.unload('standalone');
    assert(result.ok, 'Should succeed');
    assert(!core.plugins.has('standalone'), 'Plugin should be removed');
  });

  runner.test('Lifecycle: step2 freezes capabilities before removal', async () => {
    const plugin = makePlugin('my-plugin');
    await core.register(plugin);
    // 登记发生在该插件自己的受信装配上下文里（真路径由 lifecycle 的 _loadDependencies 提供实例）：
    // 清场按**登记实例**匹配，宿主直接挂在 Core 上的条目不属于任何插件。
    await core._runAssemblyContext('my-plugin', async () => {
      core.registerCapability('my-plugin.cap', { handler: () => {}, owner: 'my-plugin' });
    }, core.assemblyEpoch, plugin);

    // Verify capability exists before unload
    assert(core._capabilities.has('my-plugin.cap'), 'Capability should exist before unload');

    await lm.unload('my-plugin');
    // After full unload, capability is removed (step6), so we verify it was processed
    assert(!core._capabilities.has('my-plugin.cap'), 'Capability should be removed after unload');
  });

  runner.test('Lifecycle: step3 drains inflight requests', async () => {
    const plugin = makePlugin('my-plugin');
    await core.register(plugin);
    core._inflight.set('my-plugin', 2);

    setTimeout(() => {
      core._inflight.set('my-plugin', 0);
    }, 60);

    const start = Date.now();
    await lm.unload('my-plugin');
    const elapsed = Date.now() - start;
    assert(elapsed >= 50, 'Should wait for drain');
  });

  runner.test('Lifecycle: step3 drain timeout', async () => {
    const plugin = makePlugin('my-plugin');
    await core.register(plugin);
    core._inflight.set('my-plugin', 1);

    const start = Date.now();
    await lm.unload('my-plugin');
    const elapsed = Date.now() - start;
    assert(elapsed < 5100, 'Should timeout within 5s');
  });

  runner.test('Lifecycle: step4 calls plugin.stop', async () => {
    let stopped = false;
    const plugin = makePlugin('my-plugin', {
      stop: async () => { stopped = true; },
    });
    await core.register(plugin);

    await lm.unload('my-plugin');
    assert(stopped, 'plugin.stop should be called');
  });

  runner.test('Lifecycle: step4 handles stop error gracefully', async () => {
    const plugin = makePlugin('my-plugin', {
      stop: async () => { throw new Error('stop failed'); },
    });
    await core.register(plugin);

    const result = await lm.unload('my-plugin');
    assert(result.ok, 'Should succeed despite stop error');
  });

  runner.test('Lifecycle: step5 cleans listeners', async () => {
    const plugin = makePlugin('my-plugin');
    await core.register(plugin);
    core.on('test.event', () => {}, { owner: 'my-plugin' });
    core.on('test.event2', () => {}, { owner: 'my-plugin' });

    await lm.unload('my-plugin');
    assertEquals(core.listenerCount('test.event'), 0, 'Listeners should be removed');
  });

  runner.test('Lifecycle: step6 removes services and capabilities by ownership (not by name)', async () => {
    const plugin = makePlugin('my-plugin');
    await core.register(plugin);
    // v0.15.4（K4）：服务要按**归属**登记。修前这个用例匿名注册、靠 `svc.name === 插件名`
    // 兜底删除 —— 那正是专家 §5.4 明令禁止的"按名字粗放清场"。现在归属是唯一判据。
    await core._runAssemblyContext('my-plugin', async () => {
      core.registerService('my-svc', { name: 'my-plugin' });
      core.registerCapability('my-cap', { handler: () => {}, owner: 'my-plugin' });
    }, core.assemblyEpoch, plugin);
    // 名字巧合反例：归属是另一家的服务，即便对象自称 my-plugin 也不得被连带删掉。
    await core._runAssemblyContext('other-owner', async () => {
      core.registerService('not-mine', { name: 'my-plugin' });
    }, core.assemblyEpoch, { name: 'other-owner' });

    await lm.unload('my-plugin');
    assertEquals(core.getService('my-svc'), undefined, '归属为 my-plugin 的服务应被释放');
    assertEquals(core._capabilities.has('my-cap'), false, 'Capability should be removed');
    assert(core.getService('not-mine'), '名字巧合但归属是 other-owner ⇒ 不得被连带删除');
  });

  runner.test('Lifecycle: step7 calls persistState', async () => {
    let persisted = false;
    const plugin = makePlugin('my-plugin', {
      persistState: async () => { persisted = true; },
    });
    await core.register(plugin);

    await lm.unload('my-plugin');
    assert(persisted, 'persistState should be called');
  });

  runner.test('Lifecycle: step7 handles persist error gracefully', async () => {
    const plugin = makePlugin('my-plugin', {
      persistState: async () => { throw new Error('persist failed'); },
    });
    await core.register(plugin);

    const result = await lm.unload('my-plugin');
    assert(result.ok, 'Should succeed despite persist error');
  });

  runner.test('Lifecycle: full 7-step sequence', async () => {
    let events = [];
    core.on('core:plugin.unloading', () => { events.push('unloading'); });

    const plugin = makePlugin('full-plugin', {
      stop: async () => { events.push('stop'); },
      persistState: async () => { events.push('persist'); },
    });
    await core.register(plugin);
    core.registerCapability('full-plugin.cap', { handler: () => {}, owner: 'full-plugin' });
    core.on('test.event', () => {}, { owner: 'full-plugin' });

    const result = await lm.unload('full-plugin');
    assert(result.ok, 'Full unload should succeed');
    assert(events.includes('unloading'), 'Should emit unloading event');
    assert(events.includes('stop'), 'Should call stop');
    assert(events.includes('persist'), 'Should call persistState');
    assert(!core.plugins.has('full-plugin'), 'Plugin should be removed');
    assertEquals(plugin.state, 'unloaded', 'State should be unloaded');
  });
}
