import { DependencyResolver } from '../../src/core/dependency-resolver.js';
import { TestRunner, assert, assertEquals } from '../harness.mjs';

export async function setup(runner) {
  let resolver;

  runner.beforeAll(() => {
    const mockCore = { log: () => {}, emit: () => {} };
    resolver = new DependencyResolver(mockCore);
  });

  function makePlugin(name, requires = {}, optional = {}) {
    return { name, version: '1.0.0', requires, optional };
  }

  runner.test('DependencyResolver: simple linear chain', () => {
    const plugins = [
      makePlugin('a'),
      makePlugin('b', { a: '^1.0.0' }),
      makePlugin('c', { b: '^1.0.0' }),
    ];
    const result = resolver.topologicalSort(plugins);
    assert(result.ok, 'Should resolve successfully');
    assert(result.order.indexOf('a') < result.order.indexOf('b'), 'a before b');
    assert(result.order.indexOf('b') < result.order.indexOf('c'), 'b before c');
  });

  runner.test('DependencyResolver: diamond dependency', () => {
    const plugins = [
      makePlugin('a'),
      makePlugin('b', { a: '^1.0.0' }),
      makePlugin('c', { a: '^1.0.0' }),
      makePlugin('d', { b: '^1.0.0', c: '^1.0.0' }),
    ];
    const result = resolver.topologicalSort(plugins);
    assert(result.ok, 'Should resolve successfully');
    assert(result.order.indexOf('a') < result.order.indexOf('d'), 'a before d');
    assert(result.order.indexOf('b') < result.order.indexOf('d'), 'b before d');
    assert(result.order.indexOf('c') < result.order.indexOf('d'), 'c before d');
  });

  runner.test('DependencyResolver: circular dependency detection', () => {
    const plugins = [
      makePlugin('a', { b: '^1.0.0' }),
      makePlugin('b', { c: '^1.0.0' }),
      makePlugin('c', { a: '^1.0.0' }),
    ];
    const result = resolver.topologicalSort(plugins);
    assert(!result.ok, 'Should fail on circular dependency');
    assert(result.error.includes('Circular'), 'Should report circular dependency');
  });

  runner.test('DependencyResolver: no dependencies', () => {
    const plugins = [
      makePlugin('a'),
      makePlugin('b'),
      makePlugin('c'),
    ];
    const result = resolver.topologicalSort(plugins);
    assert(result.ok, 'Should resolve successfully');
    assertEquals(result.order.length, 3, 'All nodes should be resolved');
  });

  runner.test('DependencyResolver: missing required dependency', () => {
    const plugins = [
      makePlugin('a', { missing: '^1.0.0' }),
    ];
    const result = resolver.topologicalSort(plugins);
    assert(!result.ok, 'Should fail on missing dependency');
    assert(result.error.includes('missing'), 'Should mention missing dependency');
  });

  runner.test('DependencyResolver: optional dependency present', () => {
    const plugins = [
      makePlugin('a'),
      makePlugin('b', {}, { a: '^1.0.0' }),
    ];
    const result = resolver.topologicalSort(plugins);
    assert(result.ok, 'Should resolve with optional dep');
    assert(result.order.indexOf('a') < result.order.indexOf('b'), 'a before b');
  });

  runner.test('DependencyResolver: optional dependency missing (warn only)', () => {
    const plugins = [
      makePlugin('b', {}, { missing: '^1.0.0' }),
    ];
    const result = resolver.topologicalSort(plugins);
    assert(result.ok, 'Should resolve even with missing optional dep');
  });
}
