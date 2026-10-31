import { Core } from '../../src/core/core.js';
import { TestRunner, assert, assertEquals, assertRejects } from '../harness.mjs';

export async function setup(runner) {
  let core;

  runner.beforeEach(() => {
    core = new Core({ stateDir: '/tmp/test-core' });
  });

  runner.afterEach(() => {
    core.removeAllListeners();
  });

  runner.test('Middleware: register inbound stage', () => {
    const fn = async (msg) => msg;
    core.use('inbound', fn);
    assertEquals(core._pipelines.inbound.length, 1, 'Should have 1 inbound middleware');
  });

  runner.test('Middleware: register outbound stage', () => {
    const fn = async (msg) => msg;
    core.use('outbound', fn);
    assertEquals(core._pipelines.outbound.length, 1, 'Should have 1 outbound middleware');
  });

  runner.test('Middleware: runPipeline passes message through', async () => {
    core.use('inbound', async (msg) => ({ ...msg, enriched: true }));
    const result = await core.runPipeline('inbound', { text: 'hello' });
    assert(result.enriched, 'Message should be enriched');
    assertEquals(result.text, 'hello', 'Original text should be preserved');
  });

  runner.test('Middleware: runPipeline blocks on false return', async () => {
    let blocked = false;
    core.on('pipeline.blocked', () => { blocked = true; });
    core.use('inbound', async () => false);
    const result = await core.runPipeline('inbound', { text: 'hello' });
    assertEquals(result, null, 'Should return null when blocked');
    assert(blocked, 'Should emit pipeline.blocked event');
  });

  runner.test('Middleware: multiple middlewares execute in order', async () => {
    const order = [];
    core.use('inbound', async (msg) => { order.push(1); return { ...msg, step1: true }; });
    core.use('inbound', async (msg) => { order.push(2); return { ...msg, step2: true }; });
    core.use('inbound', async (msg) => { order.push(3); return { ...msg, step3: true }; });
    const result = await core.runPipeline('inbound', {});
    assertEquals(order.join(','), '1,2,3', 'Middlewares should execute in order');
    assert(result.step1 && result.step2 && result.step3, 'All steps should be applied');
  });

  runner.test('Middleware: async middleware support', async () => {
    core.use('inbound', async (msg) => {
      await new Promise(r => setTimeout(r, 10));
      return { ...msg, async: true };
    });
    const result = await core.runPipeline('inbound', {});
    assert(result.async, 'Async middleware should work');
  });

  runner.test('Middleware: second middleware receives transformed message', async () => {
    core.use('inbound', async (msg) => ({ ...msg, value: 1 }));
    core.use('inbound', async (msg) => ({ ...msg, value: msg.value + 1 }));
    const result = await core.runPipeline('inbound', {});
    assertEquals(result.value, 2, 'Second middleware should receive transformed message');
  });

  runner.test('Middleware: empty pipeline returns original message', async () => {
    const msg = { text: 'hello' };
    const result = await core.runPipeline('inbound', msg);
    assertEquals(result, msg, 'Should return original message when no middlewares');
  });

  runner.test('Middleware: unknown stage creates new pipeline', async () => {
    core.use('preprocess', async (msg) => ({ ...msg, processed: true }));
    assert(core._pipelines.preprocess, 'Unknown stage should be created');
    assertEquals(core._pipelines.preprocess.length, 1, 'Should have 1 middleware');
  });
}
