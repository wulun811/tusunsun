import { TestRunner, assert, assertEquals, createMockCore } from '../harness.mjs';
import { Core } from '../../src/core/core.js';
import { rejectNodeTestContext } from '../lib/node-test-guard.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// node --test 不调用 setup()：不在这里拒绝，10 条产品断言会被记成 1 个“通过的文件”。
rejectNodeTestContext('test/unit/core-bus.test.mjs');

let core;
let stateDir;

export async function setup(runner) {
  // 断言对象必须是产品实现：Core 的总线 / 能力 / 服务语义只在真实实现上成立。
  runner.beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'core-bus-'));
    core = new Core({ stateDir });
    core.log = () => {};
  });
  runner.afterEach(() => {
    try { core?.removeAllListeners(); } catch { /* 清理失败不改变用例结论 */ }
    rmSync(stateDir, { recursive: true, force: true });
  });

  runner.test('Event bus: 含点号的合法事件名送达监听器', () => {
    let received = null;
    core.on('test.event', (payload) => { received = payload; });
    const delivered = core.emit('test.event', { sourcePlugin: 'test', value: 1 });
    assertEquals(delivered, true, '有监听器时 emit 必须返回 true');
    assertEquals(received.value, 1, '监听器必须收到载荷');
  });

  runner.test('Event bus: 不含点号的事件名被拒绝且不派发', () => {
    let called = false;
    core.on('invalidEvent', () => { called = true; });
    const delivered = core.emit('invalidEvent', { sourcePlugin: 'test' });
    assertEquals(delivered, false, '非法事件名必须返回 false');
    assertEquals(called, false, '非法事件名不得派发');
  });

  runner.test('Event bus: emitFast 跳过名称校验', () => {
    let received = null;
    core.on('fastEvent', (payload) => { received = payload; });
    const delivered = core.emitFast('fastEvent', { sourcePlugin: 'test', value: 2 });
    assertEquals(delivered, true, 'emitFast 必须派发');
    assertEquals(received.value, 2, 'emitFast 必须送达监听器');
  });

  runner.test('Event bus: offByOwner 只撤销该 owner 的订阅', () => {
    let a = 0;
    let b = 0;
    core.on('test.event', () => { a++; }, { owner: 'plugin-a' });
    core.on('test.event', () => { b++; }, { owner: 'plugin-b' });
    assertEquals(core.offByOwner('plugin-a'), 1, '应只撤销 plugin-a 的一条订阅');
    core.emit('test.event', { sourcePlugin: 'test' });
    assertEquals(a, 0, 'plugin-a 的监听器必须已撤销');
    assertEquals(b, 1, 'plugin-b 的监听器必须保留');
  });

  runner.test('Capability: 注册并经 command 调用返回统一信封', async () => {
    core.registerCapability('test.cap', {
      owner: 'test-owner',
      handler: (params) => `Hello ${params.name}`,
    });
    const result = await core.command('test.cap', { name: 'World' });
    assertEquals(result.ok, true, '成功调用 ok 必须为 true');
    assertEquals(result.state, 'succeeded', '成功调用 state 必须为 succeeded');
    assertEquals(result.payload, 'Hello World', 'handler 返回值必须进 payload');
  });

  runner.test('Capability: 重复注册具名拒绝（capability_conflict）', () => {
    core.registerCapability('test.cap', { owner: 'test-owner', handler: () => 'x' });
    let message = '';
    try {
      core.registerCapability('test.cap', { owner: 'test-owner', handler: () => 'y' });
    } catch (e) { message = e.message; }
    assert(message.startsWith('capability_conflict:'),
      `重复注册必须报 capability_conflict，实际：${message || '(未抛错)'}`);
  });

  runner.test('Capability: 未注册能力返回 capability_not_found（不是抛错）', async () => {
    const r = await core.callCapability('nonexistent', {});
    assertEquals(r.ok, false, '缺失能力必须是失败信封');
    assertEquals(r.code, 'capability_not_found', '失败码必须具名');
    assertEquals(r.state, 'failed', '缺失能力是已证实的失败');
    assertEquals(r.dispatched, false, '未派发必须如实写 dispatched:false');
    assertEquals(r.side_effect, 'none', '未派发才能承诺零副作用');
  });

  runner.test('Service: 注册后可取回同一个对象并记录归属', () => {
    const svc = { name: 'test' };
    core.registerService('test-svc', svc);
    assertEquals(core.getService('test-svc'), svc, 'Service 必须是同一个对象');
    const own = core.getServiceOwnership('test-svc');
    assertEquals(own.registered, true, '归属查询必须显示已注册');
    assertEquals(own.owner, null, '匿名注册的归属必须如实为 null');
  });

  runner.test('Service: 缺失服务返回 undefined（不是 null / 空对象）', () => {
    assertEquals(core.getService('nonexistent'), undefined,
      'Core.getService 未注册时返回 undefined —— 断言 null 会把产品行为写错');
  });

  runner.test('[harness] createMockCore 的 command 同步返回 handler 结果（mock 契约，不是产品断言）', () => {
    const mock = createMockCore();
    mock.registerCapability('mock.cap', { handler: () => 'raw' });
    assertEquals(mock.command('mock.cap', {}), 'raw', 'mock 的 command 是同步 raw 返回，仅供 harness 自测');
  });
}
