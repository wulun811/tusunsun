import { Core } from '../../src/core/core.js';
import { TestRunner, assert, assertEquals } from '../harness.mjs';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export async function setup(runner) {
  let core;
  let testDir;

  runner.beforeEach(() => {
    testDir = join(tmpdir(), `tusunsun-tool-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    core = new Core({ stateDir: '/tmp/test-core' });
  });

  runner.afterEach(() => {
    core.removeAllListeners();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  runner.test('Tool chain: register → execute → result', async () => {
    let executed = false;
    let executionArgs = null;

    core.registerCapability('tool.execute', {
      handler: (params) => {
        executed = true;
        executionArgs = params;
        return { output: 'success', exitCode: 0 };
      },
      owner: 'tool-executor',
    });

    const result = await core.callCapability('tool.execute', {
      tool: 'tool-read',
      args: { path: 'package.json' },
    });

    assert(executed, 'Tool should be executed');
    assertEquals(executionArgs.tool, 'tool-read', 'Tool name should be passed');
    assert(result.ok, 'Execution should succeed');
  });

  runner.test('Tool chain: error in tool execution returns error payload', async () => {
    core.registerCapability('tool.execute', {
      handler: () => { throw new Error('tool failed'); },
      owner: 'tool-executor',
    });

    const result = await core.callCapability('tool.execute', { tool: 'test', args: {} });
    assert(!result.ok, 'Should fail');
    assert(result.error, 'Should have error message');
  });

  runner.test('Tool chain: file read tool integration', async () => {
    const testFile = join(testDir, 'test.txt');
    writeFileSync(testFile, 'Hello from test');

    core.registerCapability('tool.execute', {
      handler: (params) => {
        if (params.tool === 'tool-read') {
          const content = readFileSync(params.args.path, 'utf-8');
          return { output: content, exitCode: 0 };
        }
        return { output: 'unknown tool', exitCode: 1 };
      },
      owner: 'tool-executor',
    });

    const result = await core.callCapability('tool.execute', {
      tool: 'tool-read',
      args: { path: testFile },
    });

    assert(result.ok, 'File read should succeed');
    assertEquals(result.payload.output, 'Hello from test', 'File content should match');
  });

  runner.test('Tool chain: file write tool integration', async () => {
    const testFile = join(testDir, 'output.txt');

    core.registerCapability('tool.execute', {
      handler: (params) => {
        if (params.tool === 'tool-write') {
          writeFileSync(params.args.path, params.args.content);
          return { output: 'written', exitCode: 0 };
        }
        return { output: 'unknown tool', exitCode: 1 };
      },
      owner: 'tool-executor',
    });

    const result = await core.callCapability('tool.execute', {
      tool: 'tool-write',
      args: { path: testFile, content: 'test content' },
    });

    assert(result.ok, 'File write should succeed');
    assert(existsSync(testFile), 'File should exist');
    assertEquals(readFileSync(testFile, 'utf-8'), 'test content', 'File content should match');
  });

  runner.test('Tool chain: parallel tool execution', async () => {
    const executionTimes = [];

    core.registerCapability('tool.execute', {
      handler: async (params) => {
        const start = Date.now();
        await new Promise(r => setTimeout(r, params.args.delay || 10));
        executionTimes.push(Date.now() - start);
        return { output: `done-${params.tool}`, exitCode: 0 };
      },
      owner: 'tool-executor',
    });

    const p1 = core.callCapability('tool.execute', { tool: 't1', args: { delay: 50 } });
    const p2 = core.callCapability('tool.execute', { tool: 't2', args: { delay: 50 } });
    const p3 = core.callCapability('tool.execute', { tool: 't3', args: { delay: 50 } });

    const results = await Promise.all([p1, p2, p3]);

    assert(results.every(r => r.ok), 'All parallel calls should succeed');
    assert(executionTimes.length === 3, 'All 3 tools should execute');
  });

  runner.test('Tool chain: tool not found returns error', async () => {
    const result = await core.callCapability('tool.execute', {
      tool: 'nonexistent',
      args: {},
    });

    assert(!result.ok, 'Should return error for unknown tool');
  });

  runner.test('Tool chain: inflight tracking during tool execution', async () => {
    core.registerCapability('tool.execute', {
      handler: async () => {
        await new Promise(r => setTimeout(r, 20));
        return { output: 'done' };
      },
      owner: 'tool-executor',
    });

    const promise = core.callCapability('tool.execute', { tool: 'test', args: {} });
    assertEquals(core.getInflight('tool-executor'), 1, 'Inflight should be 1 during execution');

    await promise;
    assertEquals(core.getInflight('tool-executor'), 0, 'Inflight should be 0 after completion');
  });

  runner.test('Tool chain: capability freeze blocks tool execution', async () => {
    core.registerCapability('tool.execute', {
      handler: () => ({ output: 'done' }),
      owner: 'tool-executor',
    });

    const result1 = await core.callCapability('tool.execute', { tool: 'test', args: {} });
    assert(result1.ok, 'Call before freeze should succeed');

    core.freezeCapability('tool.execute');

    const result2 = await core.callCapability('tool.execute', { tool: 'test', args: {} });
    assert(!result2.ok, 'Call after freeze should fail');
  });

  runner.test('Tool chain: multiple tools registered by same owner', async () => {
    core.registerCapability('tool.read', {
      handler: () => ({ output: 'read' }),
      owner: 'tool-executor',
    });
    core.registerCapability('tool.write', {
      handler: () => ({ output: 'write' }),
      owner: 'tool-executor',
    });

    const r1 = await core.callCapability('tool.read', {});
    const r2 = await core.callCapability('tool.write', {});

    assert(r1.ok && r2.ok, 'Both tools should execute');
    assertEquals(core.getInflight('tool-executor'), 0, 'No inflight after completion');
  });

  runner.test('Tool chain: tool execution with complex args', async () => {
    let capturedArgs = null;

    core.registerCapability('tool.execute', {
      handler: (params) => {
        capturedArgs = params.args;
        return { output: 'done' };
      },
      owner: 'tool-executor',
    });

    await core.callCapability('tool.execute', {
      tool: 'complex',
      args: {
        path: '/tmp/test.txt',
        content: 'hello',
        options: { overwrite: true, encoding: 'utf-8' },
      },
    });

    assertEquals(capturedArgs.path, '/tmp/test.txt', 'Path should be passed');
    assertEquals(capturedArgs.options.overwrite, true, 'Nested options should be passed');
  });
}
