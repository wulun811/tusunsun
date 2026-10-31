import { semverSatisfies } from '../../src/core/dependency-resolver.js';
import { DependencyResolver } from '../../src/core/dependency-resolver.js';
import { TestRunner, assert, assertEquals } from '../harness.mjs';

export async function setup(runner) {
  runner.test('Semver: caret ^ matches same major', () => {
    assert(semverSatisfies('1.2.3', '^1.0.0'), '1.2.3 should satisfy ^1.0.0');
    assert(semverSatisfies('1.9.9', '^1.0.0'), '1.9.9 should satisfy ^1.0.0');
    assert(!semverSatisfies('2.0.0', '^1.0.0'), '2.0.0 should NOT satisfy ^1.0.0');
  });

  runner.test('Semver: caret ^ with no operator', () => {
    assert(semverSatisfies('1.2.3', '1.0.0'), '1.2.3 should satisfy 1.0.0 (default caret)');
    assert(!semverSatisfies('2.0.0', '1.0.0'), '2.0.0 should NOT satisfy 1.0.0');
  });

  runner.test('Semver: tilde ~ matches same major.minor', () => {
    assert(semverSatisfies('1.2.3', '~1.2.0'), '1.2.3 should satisfy ~1.2.0');
    assert(semverSatisfies('1.2.9', '~1.2.0'), '1.2.9 should satisfy ~1.2.0');
    assert(!semverSatisfies('1.3.0', '~1.2.0'), '1.3.0 should NOT satisfy ~1.2.0');
  });

  runner.test('Semver: >= operator', () => {
    assert(semverSatisfies('2.0.0', '>=1.0.0'), '2.0.0 should satisfy >=1.0.0');
    assert(semverSatisfies('1.0.0', '>=1.0.0'), '1.0.0 should satisfy >=1.0.0');
    assert(!semverSatisfies('0.9.0', '>=1.0.0'), '0.9.0 should NOT satisfy >=1.0.0');
  });

  runner.test('Semver: v prefix handling', () => {
    assert(semverSatisfies('v1.2.3', '^1.0.0'), 'v1.2.3 should satisfy ^1.0.0');
    assert(semverSatisfies('1.2.3', '^v1.0.0'), '1.2.3 should satisfy ^v1.0.0');
  });

  // v0.12.0（K-11）契约变更：本用例原来断言**非法输入应当放行**（lenient）。
  // 那条行为本身就是缺陷：`!m || !r ⇒ return true` 让"解析失败"变成"满足"，
  // 于是任何写错版本号或范围的插件都会被判为依赖成立（探针 K-11 实测：
  // `abc` / `>=garbage` / `nonsense` 全部返回 true）。
  // 现在改为严格子集：**解析失败 = 不满足**。见 ADR-06。
  runner.test('Semver: invalid input is NOT satisfying (v0.12.0 起严格；旧行为是缺陷)', () => {
    assert(!semverSatisfies('invalid', '^1.0.0'), '非法版本不得视为满足（修前 lenient，是缺陷）');
    assert(!semverSatisfies('1.0.0', 'invalid'), '非法范围不得视为满足（修前 lenient，是缺陷）');
    assert(!semverSatisfies('1.0.0', ''), '空范围不得视为满足');
    assert(!semverSatisfies('1.0.0', '>=garbage'), '认不出的操作符组合不得视为满足');
  });

  // K-11 的第二半：`^0.x` 必须锁 minor（0.x 语义），修前 `^0.2.0` 接受 `0.3.0`。
  runner.test('Semver: caret 对 0.x 锁 minor（修前接受 0.3.0，是缺陷）', () => {
    assert(semverSatisfies('0.2.5', '^0.2.0'), '0.2.5 应满足 ^0.2.0');
    assert(!semverSatisfies('0.3.0', '^0.2.0'), '0.3.0 不得满足 ^0.2.0（0.x 锁 minor）');
    assert(semverSatisfies('0.0.3', '^0.0.3'), '0.0.3 应满足 ^0.0.3');
    assert(!semverSatisfies('0.0.9', '^0.0.3'), '0.0.9 不得满足 ^0.0.3');
  });

  runner.test('DependencyResolver: fallback with missing dependency', async () => {
    const mockCore = {
      log: () => {},
      emit: () => {},
    };
    const resolver = new DependencyResolver(mockCore);

    const plugins = [
      { name: 'a', version: '1.0.0', requires: { missing: '^1.0.0' } },
      { name: 'b', version: '1.0.0', requires: {} },
    ];

    const result = await resolver.resolveWithFallback(plugins, { missing: 'b' });
    assert(!result.ok, 'Fallback has known bug: filters by dep name instead of plugin name');
    assert(result.error.includes('missing'), 'Should still report missing dependency');
  });

  runner.test('DependencyResolver: fallback with no valid fallback', async () => {
    const mockCore = {
      log: () => {},
      emit: () => {},
    };
    const resolver = new DependencyResolver(mockCore);

    const plugins = [
      { name: 'a', version: '1.0.0', requires: { missing: '^1.0.0' } },
    ];

    const result = await resolver.resolveWithFallback(plugins, { missing: 'nonexistent' });
    assert(!result.ok, 'Should fail when no valid fallback');
  });

  runner.test('DependencyResolver: complex DAG (7 nodes)', () => {
    const mockCore = { log: () => {}, emit: () => {} };
    const resolver = new DependencyResolver(mockCore);

    const plugins = [
      { name: 'core', version: '1.0.0', requires: {} },
      { name: 'auth', version: '1.0.0', requires: { core: '^1.0.0' } },
      { name: 'db', version: '1.0.0', requires: { core: '^1.0.0' } },
      { name: 'cache', version: '1.0.0', requires: { db: '^1.0.0' } },
      { name: 'api', version: '1.0.0', requires: { auth: '^1.0.0', db: '^1.0.0' } },
      { name: 'worker', version: '1.0.0', requires: { db: '^1.0.0', cache: '^1.0.0' } },
      { name: 'gateway', version: '1.0.0', requires: { api: '^1.0.0', auth: '^1.0.0' } },
    ];

    const result = resolver.topologicalSort(plugins);
    assert(result.ok, 'Should resolve complex DAG');
    assertEquals(result.order.length, 7, 'All 7 nodes should be resolved');

    const order = result.order;
    assert(order.indexOf('core') < order.indexOf('auth'), 'core before auth');
    assert(order.indexOf('core') < order.indexOf('db'), 'core before db');
    assert(order.indexOf('db') < order.indexOf('cache'), 'db before cache');
    assert(order.indexOf('auth') < order.indexOf('api'), 'auth before api');
    assert(order.indexOf('db') < order.indexOf('api'), 'db before api');
    assert(order.indexOf('db') < order.indexOf('worker'), 'db before worker');
    assert(order.indexOf('cache') < order.indexOf('worker'), 'cache before worker');
    assert(order.indexOf('api') < order.indexOf('gateway'), 'api before gateway');
    assert(order.indexOf('auth') < order.indexOf('gateway'), 'auth before gateway');
  });

  runner.test('DependencyResolver: version mismatch detected', () => {
    const mockCore = { log: () => {}, emit: () => {} };
    const resolver = new DependencyResolver(mockCore);

    const plugins = [
      { name: 'core', version: '2.0.0', requires: {} },
      { name: 'plugin', version: '1.0.0', requires: { core: '^1.0.0' } },
    ];

    const result = resolver.topologicalSort(plugins);
    assert(!result.ok, 'Should fail on version mismatch');
    assert(result.error.includes('Version mismatch'), 'Should report version mismatch');
  });
}
