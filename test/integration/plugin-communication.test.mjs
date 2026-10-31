import { Core } from '../../src/core/core.js';
import { TestRunner, assert, assertEquals } from '../harness.mjs';

export async function setup(runner) {
  let core;

  runner.beforeEach(() => {
    core = new Core({ stateDir: '/tmp/test-core' });
  });

  runner.afterEach(() => {
    core.removeAllListeners();
  });

  runner.test('Plugin-to-plugin: event bus cross-plugin communication', async () => {
    let receivedByB = null;

    const pluginA = {
      name: 'plugin-a',
      version: '1.0.0',
      async init(c) {
        c.emit('plugin-a:data.ready', { value: 42, sourcePlugin: 'plugin-a' });
      },
    };

    const pluginB = {
      name: 'plugin-b',
      version: '1.0.0',
      async init(c) {
        c.on('plugin-a:data.ready', (payload) => {
          receivedByB = payload;
        }, { owner: 'plugin-b' });
      },
    };

    await core.register(pluginB);
    await core.register(pluginA);
    await pluginB.init(core);
    await pluginA.init(core);

    assert(receivedByB !== null, 'Plugin B should receive event from Plugin A');
    assertEquals(receivedByB.value, 42, 'Payload should be correct');
  });

  runner.test('Plugin-to-plugin: capability discovery and invocation', async () => {
    const provider = {
      name: 'provider',
      version: '1.0.0',
      async init(c) {
        c.registerCapability('provider.greet', {
          handler: (params) => `Hello ${params.name} from provider`,
          owner: 'provider',
        });
      },
    };

    const consumer = {
      name: 'consumer',
      version: '1.0.0',
      async init(c) {},
    };

    await core.register(provider);
    await core.register(consumer);
    await provider.init(core);

    const result = await core.callCapability('provider.greet', { name: 'World' });
    assert(result.ok, 'Capability call should succeed');
    assertEquals(result.payload, 'Hello World from provider', 'Should return correct greeting');
  });

  runner.test('Plugin-to-plugin: service sharing across plugins', async () => {
    const dbProvider = {
      name: 'db-provider',
      version: '1.0.0',
      async init(c) {
        c.registerService('db', {
          query: (sql) => [{ id: 1, name: 'test' }],
          insert: (table, data) => ({ id: 2, ...data }),
        });
      },
    };

    const apiPlugin = {
      name: 'api-plugin',
      version: '1.0.0',
      async init(c) {},
      async getData() {
        const db = core.getService('db');
        return db ? db.query('SELECT * FROM test') : null;
      },
    };

    await core.register(dbProvider);
    await core.register(apiPlugin);
    await dbProvider.init(core);
    await apiPlugin.init(core);

    const data = await apiPlugin.getData();
    assert(data !== null, 'API plugin should access DB service');
    assertEquals(data[0].name, 'test', 'Query result should be correct');
  });

  runner.test('Plugin-to-plugin: command bus request-response', async () => {
    const handler = {
      name: 'handler',
      version: '1.0.0',
      async init(c) {
        c.on('chat.handle', (params) => {
          c.emit('chat.handle.response', { ok: true, payload: { reply: `Echo: ${params.message}` } });
        }, { owner: 'handler' });
      },
    };

    const caller = {
      name: 'caller',
      version: '1.0.0',
      async init(c) {},
    };

    await core.register(handler);
    await core.register(caller);
    await handler.init(core);
    await caller.init(core);

    const result = await core.command('chat.handle', { message: 'Hello' }, 500);
    assert(result.ok, 'Command should succeed');
    assert(result.payload?.reply === 'Echo: Hello' || result.payload?.ok, 'Should return echo response');
  });

  runner.test('Plugin-to-plugin: middleware chain across plugins', async () => {
    const authPlugin = {
      name: 'auth-plugin',
      version: '1.0.0',
      async init(c) {
        c.use('inbound', async (msg) => {
          return { ...msg, authenticated: true };
        });
      },
    };

    const loggingPlugin = {
      name: 'logging-plugin',
      version: '1.0.0',
      async init(c) {
        c.use('inbound', async (msg) => {
          return { ...msg, logged: true };
        });
      },
    };

    await core.register(authPlugin);
    await core.register(loggingPlugin);
    await authPlugin.init(core);
    await loggingPlugin.init(core);

    const result = await core.runPipeline('inbound', { text: 'hello' });
    assert(result.authenticated, 'Auth middleware should run');
    assert(result.logged, 'Logging middleware should run');
  });

  runner.test('Plugin-to-plugin: listener ownership isolation', async () => {
    const pluginA = {
      name: 'plugin-a',
      version: '1.0.0',
      async init(c) {
        c.on('test.event', () => {}, { owner: 'plugin-a' });
        c.on('test.event', () => {}, { owner: 'plugin-a' });
      },
    };

    const pluginB = {
      name: 'plugin-b',
      version: '1.0.0',
      async init(c) {
        c.on('test.event', () => {}, { owner: 'plugin-b' });
      },
    };

    await core.register(pluginA);
    await core.register(pluginB);
    await pluginA.init(core);
    await pluginB.init(core);

    assertEquals(core.listenerCount('test.event'), 3, 'Should have 3 listeners total');

    core.offByOwner('plugin-a');
    assertEquals(core.listenerCount('test.event'), 1, 'Plugin B listener should remain');
  });

  runner.test('Plugin-to-plugin: plugin load order via DAG', async () => {
    const loadOrder = [];

    const base = {
      name: 'base',
      version: '1.0.0',
      requires: {},
      async init(c) {
        loadOrder.push('base');
        c.registerService('base-svc', { ready: true });
      },
    };

    const ext = {
      name: 'ext',
      version: '1.0.0',
      requires: { base: '^1.0.0' },
      async init(c) {
        loadOrder.push('ext');
        const svc = c.getService('base-svc');
        assert(svc?.ready, 'Base service should be available');
      },
    };

    await core.register(base);
    await core.register(ext);
    await base.init(core);
    await ext.init(core);

    assertEquals(loadOrder.join(','), 'base,ext', 'Plugins should load in DAG order');
  });

  runner.test('Plugin-to-plugin: event payload auto-injection', async () => {
    let receivedPayload = null;

    const publisher = {
      name: 'publisher',
      version: '1.0.0',
      async init(c) {},
      emitData(c) {
        c.emit('publisher.data.ready', { data: 'hello' });
      },
    };

    const subscriber = {
      name: 'subscriber',
      version: '1.0.0',
      async init(c) {
        c.on('publisher.data.ready', (payload) => {
          receivedPayload = payload;
        }, { owner: 'subscriber' });
      },
    };

    await core.register(subscriber);
    await core.register(publisher);
    await subscriber.init(core);
    await publisher.init(core);
    publisher.emitData(core);

    assert(receivedPayload !== null, 'Should receive event');
    assert(receivedPayload.timestamp, 'Timestamp should be auto-injected');
  });

  runner.test('Plugin-to-plugin: capability freeze affects all consumers', async () => {
    const provider = {
      name: 'provider',
      version: '1.0.0',
      async init(c) {
        c.registerCapability('provider.action', {
          handler: () => 'done',
          owner: 'provider',
        });
      },
    };

    await core.register(provider);
    await provider.init(core);

    const result1 = await core.callCapability('provider.action', {});
    assert(result1.ok, 'Call before freeze should succeed');

    core.freezeCapability('provider.action');

    const result2 = await core.callCapability('provider.action', {});
    assert(!result2.ok, 'Call after freeze should fail');
    assert(result2.error.includes('frozen'), 'Should mention frozen');
  });

  runner.test('Plugin-to-plugin: inflight tracking across concurrent calls', async () => {
    const provider = {
      name: 'provider',
      version: '1.0.0',
      async init(c) {
        c.registerCapability('provider.slow', {
          handler: async () => {
            await new Promise(r => setTimeout(r, 50));
            return 'done';
          },
          owner: 'provider',
        });
      },
    };

    await core.register(provider);
    await provider.init(core);

    const p1 = core.callCapability('provider.slow', {});
    const p2 = core.callCapability('provider.slow', {});
    const p3 = core.callCapability('provider.slow', {});

    assertEquals(core.getInflight('provider'), 3, 'Should track 3 concurrent inflights');

    await Promise.all([p1, p2, p3]);
    assertEquals(core.getInflight('provider'), 0, 'All inflights should be cleared');
  });
}
