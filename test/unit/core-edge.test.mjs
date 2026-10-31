import { Core } from '../../src/core/core.js';
import { TestRunner, assert, assertEquals, createMockCore } from '../harness.mjs';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export async function setup(runner) {
  let core;
  let testDir;
  let stderrOutput;
  let originalStderrWrite;

  runner.beforeEach(() => {
    testDir = join(tmpdir(), `tusunsun-core-edge-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    stderrOutput = '';
    originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => { stderrOutput += chunk; return true; };
    core = new Core({ stateDir: testDir, pluginsDir: join(testDir, 'plugins') });
  });

  runner.afterEach(() => {
    core.removeAllListeners();
    process.stderr.write = originalStderrWrite;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  runner.test('Core: duplicate plugin registration warns', async () => {
    const plugin = { name: 'dup-plugin', version: '1.0.0', init: async () => {} };
    await core.register(plugin);
    await core.register(plugin);
    assert(core.plugins.has('dup-plugin'), 'Plugin should be registered');
    assertEquals(core.plugins.size, 1, 'Should only have one instance');
  });

  runner.test('Core: emit without sourcePlugin warns', () => {
    let warnCalled = false;
    core.on('warn.test', () => { warnCalled = true; });
    core.emit('test.event', { foo: 'bar' });
    assert(true, 'Emit should succeed even without sourcePlugin');
  });

  runner.test('Core: emit with sourcePlugin no warn', () => {
    core.emit('test.event', { foo: 'bar', sourcePlugin: 'test' });
    assert(!stderrOutput.includes('missing "sourcePlugin"'), 'Should not warn');
  });

  runner.test('Core: getMsgCount increments on emit', () => {
    assertEquals(core.getMsgCount(), 0, 'Initial count should be 0');
    core.emit('test.event', { sourcePlugin: 'test' });
    assertEquals(core.getMsgCount(), 1, 'Should increment after emit');
    core.emitFast('fast.event', {});
    assertEquals(core.getMsgCount(), 2, 'Should increment after emitFast');
  });

  // R0-103（开源盘点 #1）：原用例断言"懒加载失败要抛"。这与 R0-76 合同冲突——`callCapability`
  // 的失败必须走 `ok/state/code` 信封，否则同一输入在"挂/不挂 PluginManager"两种装配下
  // 会产生两种失败形状（钩子接上后真实运行必抛）。现在断言两件事：钩子**确实被调用**
  // （这正是修复前缺失的行为），且失败以具名信封返回。
  runner.test('Core: lazy loading 钩子被调用，失败走具名信封', async () => {
    const seen = [];
    core._lazyHook = async (id) => { seen.push(id); };
    const r = await core.callCapability('nonexistent.cap', {});
    assert(seen.includes('nonexistent.cap'), '懒加载钩子必须被调用（修复前 _lazyHook 是死代码）');
    assertEquals(r.ok, false, '缺失能力必须失败');
    assertEquals(r.state, 'failed');
    assertEquals(r.code, 'capability_not_found');
  });

  runner.test('Core: start() idempotent', async () => {
    await core.start();
    assert(core.running, 'Should be running');
    const startTime = core._startTime;
    await core.start();
    assertEquals(core._startTime, startTime, 'Start time should not change');
  });

  runner.test('Core: stop() idempotent', async () => {
    await core.stop();
    assert(!core.running, 'Should not be running');
    await core.stop();
    assert(!core.running, 'Should still not be running');
  });

  runner.test('Core: registerService owner tracking', async () => {
    const plugin = { name: 'owner-plugin', version: '1.0.0', init: async (c) => {
      c.registerService('tracked-svc', {});
    }};
    await core.register(plugin);
    await core._startPlugin('owner-plugin', plugin);
    assertEquals(core._serviceOwners.get('tracked-svc'), 'owner-plugin', 'Owner should be tracked');
  });

  runner.test('Core: getService with tracking enabled', () => {
    core._trackServiceAccess = true;
    core.registerService('my-svc', {});
    core.getService('my-svc');
    assert(core._trackedServices.has('my-svc'), 'Service access should be tracked');
  });

  runner.test('Core: colorize instance method', () => {
    const result = core.colorize('red', 'error text');
    assert(result.includes('error text'), 'Should contain text');
    assert(result.includes('\x1b[31m'), 'Should contain red color code');
  });

  runner.test('Core: error event listener', () => {
    let errorHandlerCalled = false;
    core.on('error', (err) => { errorHandlerCalled = true; });
    core.emit('error', new Error('test error'));
    assert(errorHandlerCalled, 'Error event should be handled');
  });

  runner.test('Core: emit invalid event name', () => {
    const result = core.emit('invalidNoDot', {});
    assertEquals(result, false, 'Should return false for invalid event');
  });

  runner.test('Core: emit adds timestamp to payload', () => {
    const payload = { sourcePlugin: 'test' };
    core.emit('test.event', payload);
    assert('timestamp' in payload, 'Should add timestamp');
  });

  runner.test('Core: emit does not overwrite existing timestamp', () => {
    const payload = { sourcePlugin: 'test', timestamp: '2020-01-01T00:00:00.000Z' };
    core.emit('test.event', payload);
    assertEquals(payload.timestamp, '2020-01-01T00:00:00.000Z', 'Should preserve existing timestamp');
  });

  runner.test('Core: freezeCapability blocks invocation', async () => {
    core.registerCapability('frozen.cap', { handler: () => 'ok' });
    core.freezeCapability('frozen.cap');
    const result = await core.callCapability('frozen.cap', {});
    assert(!result.ok, 'Should fail');
    assert(result.error.includes('frozen'), 'Should mention frozen');
  });

  runner.test('Core: callCapability inflight tracking', async () => {
    let resolveHandler;
    const promise = new Promise(r => { resolveHandler = r; });
    core.registerCapability('slow.cap', { handler: () => promise, owner: 'test-owner' });

    const callPromise = core.callCapability('slow.cap', {});
    assertEquals(core.getInflight('test-owner'), 1, 'Should have 1 inflight');

    resolveHandler('done');
    await callPromise;
    assertEquals(core.getInflight('test-owner'), 0, 'Should have 0 inflight after completion');
  });

  runner.test('Core: callCapability handles null error', async () => {
    core.registerCapability('null.cap', { handler: () => { throw null; } });
    const result = await core.callCapability('null.cap', {});
    assert(!result.ok, 'Should fail');
    assertEquals(result.error, 'null', 'Should convert null to string');
  });

  runner.test('Core: callCapability handles undefined error', async () => {
    core.registerCapability('undef.cap', { handler: () => { throw undefined; } });
    const result = await core.callCapability('undef.cap', {});
    assert(!result.ok, 'Should fail');
    assertEquals(result.error, 'undefined', 'Should convert undefined to string');
  });

  runner.test('Core: callCapability handles string error', async () => {
    core.registerCapability('str.cap', { handler: () => { throw 'string error'; } });
    const result = await core.callCapability('str.cap', {});
    assert(!result.ok, 'Should fail');
    assertEquals(result.error, 'string error', 'Should use string error');
  });

  runner.test('Core: command handles null error', async () => {
    core.registerCapability('null.cmd', { handler: () => { throw null; } });
    const result = await core.command('null.cmd', {}, 5000);
    assert(!result.ok, 'Should fail');
    assertEquals(result.error, 'null', 'Should convert null to string');
  });

  runner.test('Core: command handles undefined error', async () => {
    core.registerCapability('undef.cmd', { handler: () => { throw undefined; } });
    const result = await core.command('undef.cmd', {}, 5000);
    assert(!result.ok, 'Should fail');
    assertEquals(result.error, 'undefined', 'Should convert undefined to string');
  });

  runner.test('Core: command timeout', async () => {
    // 有人听得见但不应答 ⇒ 才轮到超时；“没人听得见”现在是另一条具名失败（command_unhandled）。
    core.on('never.called', () => {});
    const result = await core.command('never.called', {}, 50);
    assert(!result.ok, 'Should fail');
    assert(result.error.includes('timeout'), 'Should mention timeout');
  });

  runner.test('Core: command via response event', async () => {
    core.on('my.method', (params) => {
      setTimeout(() => core.emit('my.method.response', { ok: true, payload: 'result' }), 10);
    });
    const result = await core.command('my.method', {}, 5000);
    assert(result.ok, 'Should succeed');
    assertEquals(result.payload, 'result', 'Should return correct payload');
  });

  runner.test('Core: command via error event', async () => {
    core.on('fail.method', () => {
      setTimeout(() => core.emit('fail.method.error', new Error('boom')), 10);
    });
    const result = await core.command('fail.method', {}, 5000);
    assert(!result.ok, 'Should fail');
    assertEquals(result.error, 'boom', 'Should return error message');
  });

  runner.test('Core: status when not started', () => {
    const status = core.status();
    assertEquals(status.running, false, 'Should not be running');
    assertEquals(status.uptime, 'not started', 'Uptime should show not started');
  });

  runner.test('Core: status when running', async () => {
    await core.start();
    const status = core.status();
    assertEquals(status.running, true, 'Should be running');
    assert(status.uptime !== 'not started', 'Uptime should show time');
  });

  runner.test('Core: use and runPipeline inbound', async () => {
    core.use('inbound', async (msg) => ({ ...msg, transformed: true }));
    const result = await core.runPipeline('inbound', { data: 'test' });
    assert(result.transformed, 'Should be transformed');
  });

  runner.test('Core: runPipeline blocked', async () => {
    core.use('inbound', async () => false);
    const result = await core.runPipeline('inbound', { data: 'test' });
    assertEquals(result, null, 'Should return null when blocked');
  });

  runner.test('Core: get without config service', () => {
    const result = core.get('some.key', 'fallback');
    assertEquals(result, 'fallback', 'Should return fallback');
  });
}
