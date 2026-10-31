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

  runner.test('Capability: callCapability returns ok:true on success', async () => {
    core.registerCapability('test.cap', {
      handler: (params) => ({ result: params.value * 2 }),
    });
    const result = await core.callCapability('test.cap', { value: 5 });
    assert(result.ok, 'Should succeed');
    assertEquals(result.payload.result, 10, 'Should return doubled value');
  });

  runner.test('Capability: callCapability returns ok:false on missing', async () => {
    const result = await core.callCapability('nonexistent', {});
    assert(!result.ok, 'Should fail');
    assert(result.error.includes('not found'), 'Should mention not found');
  });

  runner.test('Capability: freezeCapability blocks calls', async () => {
    core.registerCapability('test.cap', {
      handler: () => 'ok',
    });
    core.freezeCapability('test.cap');
    const result = await core.callCapability('test.cap', {});
    assert(!result.ok, 'Should fail after freeze');
    assert(result.error.includes('frozen'), 'Should mention frozen');
  });

  runner.test('Capability: inflight counter increments on call', async () => {
    let capturedInflight = 0;
    core.registerCapability('test.cap', {
      handler: async () => {
        capturedInflight = core.getInflight('unknown');
        await new Promise(r => setTimeout(r, 10));
        return 'ok';
      },
    });
    const promise = core.callCapability('test.cap', {});
    assertEquals(capturedInflight, 1, 'Inflight should be 1 during execution');
    await promise;
    assertEquals(core.getInflight('unknown'), 0, 'Inflight should be 0 after completion');
  });

  runner.test('Capability: inflight decrements on error', async () => {
    core.registerCapability('test.cap', {
      handler: () => { throw new Error('fail'); },
    });
    await core.callCapability('test.cap', {});
    assertEquals(core.getInflight('unknown'), 0, 'Inflight should be 0 after error');
  });

  runner.test('Capability: inflight tracks per-owner', async () => {
    core.registerCapability('test.cap', {
      handler: async () => { await new Promise(r => setTimeout(r, 10)); return 'ok'; },
      owner: 'plugin-a',
    });
    core.callCapability('test.cap', {});
    assertEquals(core.getInflight('plugin-a'), 1, 'Owner inflight should be 1');
    await new Promise(r => setTimeout(r, 20));
    assertEquals(core.getInflight('plugin-a'), 0, 'Owner inflight should be 0 after done');
  });

  runner.test('Command: capability call with timeout', async () => {
    core.registerCapability('test.cmd', {
      handler: (params) => `Hello ${params.name}`,
    });
    const result = await core.command('test.cmd', { name: 'World' }, 5000);
    assert(result.ok, 'Should succeed');
    assertEquals(result.payload, 'Hello World', 'Should return correct result');
  });

  runner.test('Command: timeout on slow handler', async () => {
    core.registerCapability('test.slow', {
      handler: async () => { await new Promise(r => setTimeout(r, 10000)); return 'ok'; },
    });
    const result = await core.command('test.slow', {}, 50);
    assert(!result.ok, 'Should timeout');
    assert(result.error.includes('timeout'), 'Should mention timeout');
  });

  runner.test('Command: error from handler', async () => {
    core.registerCapability('test.fail', {
      handler: () => { throw new Error('handler error'); },
    });
    const result = await core.command('test.fail', {}, 5000);
    assert(!result.ok, 'Should fail');
    assertEquals(result.error, 'handler error', 'Should return error message');
  });

  runner.test('Command: event-based fallback for unknown capability', async () => {
    core.on('unknown.method', () => {
      setTimeout(() => {
        core.emit('unknown.method.response', { ok: true, payload: 'from event' });
      }, 10);
    });
    const result = await core.command('unknown.method', {}, 500);
    assert(result.ok, 'Should succeed via event');
    assertEquals(result.payload, 'from event', 'Should return event payload');
  });

  runner.test('Command: event-based error response', async () => {
    core.on('fail.method', () => {
      setTimeout(() => {
        core.emit('fail.method.error', { ok: false, error: 'remote error' });
      }, 10);
    });
    const result = await core.command('fail.method', {}, 500);
    assert(!result.ok, 'Should fail');
    assert(result.error === 'remote error' || (result.error && result.error.error === 'remote error'), 'Should return error message');
  });

  runner.test('Command: event-based timeout', async () => {
    core.on('slow.method', () => {});   // 有人听得见、但不应答
    const result = await core.command('slow.method', {}, 50);
    assert(!result.ok, 'Should timeout');
    assert(result.error.includes('timeout'), 'Should mention timeout');
  });

  // v0.9.24：这条用例此前**把缺陷当规格**——名字直说 "does not block command"，
  // 断言 `result.ok === true`（冻结后仍然执行）。于是 freeze 在 `command()` 入口上失效
  // 这件事，被一个字面正确的绿灯锁死了整整几轮。
  // 事实：`freezeCapability` 的语义是"停止服务、等在飞请求排空"（插件卸载/热重载的第 2 步），
  // 而 `command()` 正是所有 chat 入口（gateway 六处、cell-runtime、channel-base、heartbeat）
  // 走的那条路 —— 冻不住等于卸载期间旧代码还在跑。
  // 修真阳性时被这条用例拦下，是关键信号：**绿灯不等于正确，只等于"与断言一致"**。
  runner.test('Command: freezeCapability 必须同样阻断 command（两条入口语义一致）', async () => {
    let hits = 0;
    core.registerCapability('test.frozen', { handler: () => { hits++; return 'ok'; } });

    const before = await core.command('test.frozen', {}, 500);
    assert(before.ok, '未冻结时应正常执行');

    core.freezeCapability('test.frozen');
    const result = await core.command('test.frozen', {}, 500);
    assert(!result.ok, '冻结后 command() 不得执行 handler');
    assertEquals(result.state, 'denied', '状态应为 denied（拒绝执行），不是 failed');
    assertEquals(result.code, 'capability_frozen', '应给出与 callCapability 相同的具名 code');

    const viaCap = await core.callCapability('test.frozen');
    assertEquals(viaCap.code, result.code, '两条入口的拒绝理由必须一致（否则上层无法统一处置）');
    assertEquals(hits, 1, '冻结后 handler 不得再被调用（计数停在未冻结那一次）');
  });
}
