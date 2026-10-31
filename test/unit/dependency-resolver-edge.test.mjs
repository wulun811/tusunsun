import { DependencyResolver, semverSatisfies } from '../../src/core/dependency-resolver.js';
import { TestRunner, assert, assertEquals } from '../harness.mjs';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export async function setup(runner) {
  let resolver;
  let testDir;
  let core;

  runner.beforeEach(() => {
    testDir = join(tmpdir(), `tusunsun-dr-edge-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    core = {
      plugins: new Map(),
      _capabilities: new Map(),
      _services: new Map(),
      _listenerOwners: new Map(),
      _inflight: new Map(),
      _serviceOwners: new Map(),
      log: () => {},
      on: () => {},
      emit: () => {},
      off: () => {},
      offByOwner: () => 0,
      getInflight: () => 0,
      freezeCapability: () => {},
      colorize: (_, t) => t,
    };

    resolver = new DependencyResolver(core);
  });

  runner.afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  runner.test('semverSatisfies: > operator', () => {
    assert(semverSatisfies('1.0.1', '>1.0.0'), '1.0.1 should satisfy >1.0.0');
    assert(!semverSatisfies('1.0.0', '>1.0.0'), '1.0.0 should not satisfy >1.0.0');
    assert(!semverSatisfies('0.9.9', '>1.0.0'), '0.9.9 should not satisfy >1.0.0');
    assert(semverSatisfies('2.0.0', '>1.0.0'), '2.0.0 should satisfy >1.0.0');
  });

  // v0.12.0（K-11）契约变更：原断言"两者都非法时返回 true"（lenient）。
  // 那正是 K-11 的核心缺陷 —— 解析失败被当成"满足"，于是写错版本号的插件被判依赖成立。
  // 现在严格：无法解析 = 不满足。见 ADR-06。
  runner.test('semverSatisfies: 无法解析一律不满足（v0.12.0 起严格）', () => {
    assert(!semverSatisfies(null, null), 'Both null must NOT satisfy');
    assert(!semverSatisfies('', ''), 'Both empty must NOT satisfy');
    assert(!semverSatisfies(undefined, '*'), 'undefined version must NOT satisfy even *');
  });

  runner.test('semverSatisfies: ^ operator', () => {
    assert(semverSatisfies('1.2.3', '^1.2.0'), '1.2.3 should satisfy ^1.2.0');
    assert(!semverSatisfies('2.0.0', '^1.2.0'), '2.0.0 should not satisfy ^1.2.0');
  });

  runner.test('semverSatisfies: ~ operator', () => {
    assert(semverSatisfies('1.2.3', '~1.2.0'), '1.2.3 should satisfy ~1.2.0');
    assert(!semverSatisfies('1.3.0', '~1.2.0'), '1.3.0 should not satisfy ~1.2.0');
  });

  runner.test('semverSatisfies: >= operator', () => {
    assert(semverSatisfies('2.0.0', '>=1.0.0'), '2.0.0 should satisfy >=1.0.0');
    assert(semverSatisfies('1.0.0', '>=1.0.0'), '1.0.0 should satisfy >=1.0.0');
    assert(!semverSatisfies('0.9.9', '>=1.0.0'), '0.9.9 should not satisfy >=1.0.0');
  });

  runner.test('resolveWithFallback: successful fallback', async () => {
    let emitted = false;
    core.emit = (event) => { if (event === 'scene.fallback') emitted = true; };

    const plugins = [
      { name: 'main', version: '1.0.0', requires: { missing: '^1.0.0' } },
      { name: 'fallback-plugin', version: '1.0.0', requires: {} },
    ];

    const result = await resolver.resolveWithFallback(plugins, { missing: 'fallback-plugin' });
    assert(emitted, 'Should emit fallback event');
  });

  runner.test('resolveWithFallback: no fallback available', async () => {
    const plugins = [
      { name: 'main', version: '1.0.0', requires: { missing: '^1.0.0' } },
    ];

    const result = await resolver.resolveWithFallback(plugins, { missing: 'nonexistent' });
    assert(!result.ok, 'Should fail when no fallback available');
  });

  runner.test('resolveLazyChain: normal resolution', () => {
    const pending = new Map([
      ['a', { name: 'a', version: '1.0.0', requires: { b: '^1.0.0' }, provides: ['cap.a'] }],
      ['b', { name: 'b', version: '1.0.0', requires: {}, provides: ['cap.b'] }],
    ]);

    const result = resolver.resolveLazyChain('a', pending);
    assert(result.ok, 'Should succeed');
    assert(result.order.indexOf('b') < result.order.indexOf('a'), 'b should come before a');
  });

  runner.test('resolveLazyChain: not in pending', () => {
    const pending = new Map();
    const result = resolver.resolveLazyChain('missing', pending);
    assert(!result.ok, 'Should fail');
    assert(result.error.includes('not in pending'), 'Should mention not in pending');
  });

  runner.test('resolveLazyChain: single plugin no deps', () => {
    const pending = new Map([
      ['solo', { name: 'solo', version: '1.0.0', requires: {}, provides: ['solo.cap'] }],
    ]);

    const result = resolver.resolveLazyChain('solo', pending);
    assert(result.ok, 'Should succeed');
    assertEquals(result.order.length, 1, 'Should have one plugin');
    assertEquals(result.order[0], 'solo', 'Should be solo');
  });

  runner.test('topologicalSort: circular dependency detected', () => {
    const plugins = [
      { name: 'a', version: '1.0.0', requires: { b: '^1.0.0' } },
      { name: 'b', version: '1.0.0', requires: { a: '^1.0.0' } },
    ];

    const result = resolver.topologicalSort(plugins);
    assert(!result.ok, 'Should fail');
    assert(result.error.includes('Circular'), 'Should mention circular');
  });

  runner.test('topologicalSort: missing dependency', () => {
    const plugins = [
      { name: 'a', version: '1.0.0', requires: { missing: '^1.0.0' } },
    ];

    const result = resolver.topologicalSort(plugins);
    assert(!result.ok, 'Should fail');
    assert(result.error.includes('not available'), 'Should mention not available');
  });

  runner.test('topologicalSort: version mismatch', () => {
    const plugins = [
      { name: 'base', version: '1.0.0', requires: {} },
      { name: 'consumer', version: '1.0.0', requires: { base: '^2.0.0' } },
    ];

    const result = resolver.topologicalSort(plugins);
    assert(!result.ok, 'Should fail');
    assert(result.error.includes('Version mismatch'), 'Should mention version mismatch');
  });

  runner.test('topologicalSort: optional dependency missing logs warning', () => {
    let warned = false;
    core.log = (level, msg) => { if (level === 'warn') warned = true; };

    const plugins = [
      { name: 'a', version: '1.0.0', requires: {}, optional: { missing: '^1.0.0' } },
    ];

    const result = resolver.topologicalSort(plugins);
    assert(result.ok, 'Should succeed with optional missing');
    assert(warned, 'Should log warning about optional dependency');
  });

  runner.test('buildDAG: empty plugins', () => {
    const result = resolver.buildDAG([]);
    assert(result.ok, 'Should succeed with empty array');
  });

  runner.test('buildDAG: no dependencies', () => {
    const plugins = [
      { name: 'a', version: '1.0.0', requires: {} },
      { name: 'b', version: '1.0.0', requires: {} },
    ];
    const result = resolver.buildDAG(plugins);
    assert(result.ok, 'Should succeed');
    assertEquals(result.inDegree.get('a'), 0, 'a should have 0 in-degree');
    assertEquals(result.inDegree.get('b'), 0, 'b should have 0 in-degree');
  });
}
