import { TestRunner, assert, assertEquals } from '../harness.mjs';
import { loadJson5 } from '../../src/core/json5-loader.js';

export async function setup(runner) {
  runner.test('SceneController: loadJson5 with unquoted keys', () => {
    const input = `{ name: "test", plugins: ["a", "b"] }`;
    const result = loadJson5(input);
    assertEquals(result.name, 'test', 'Name should be parsed');
    assertEquals(result.plugins.length, 2, 'Plugins array should have 2 items');
  });

  runner.test('SceneController: loadJson5 with comments', () => {
    const input = `{
      // This is a comment
      "name": "test", // inline comment
      "plugins": ["a", "b"]
    }`;
    const result = loadJson5(input);
    assertEquals(result.name, 'test', 'Name should be parsed');
  });

  runner.test('SceneController: loadJson5 with trailing commas', () => {
    const input = `{ "name": "test", "plugins": ["a", "b",], }`;
    const result = loadJson5(input);
    assertEquals(result.name, 'test', 'Name should be parsed');
  });
}
