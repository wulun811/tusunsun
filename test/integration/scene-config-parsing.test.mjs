import { TestRunner, assert, assertEquals } from '../harness.mjs';
import { loadJson5 } from '../../src/core/json5-loader.js';
import {
  SceneController, scenePluginNames, sceneRequiredNames,
} from '../../src/core/scene-controller.js';

const loadError = (raw) => {
  try { loadJson5(raw); return null; } catch (e) { return e; }
};

// 判据落在产品实现上：这里既不重写 JSON5 解析，也不重写 include 展开与 diff。
// 替换 src/core/json5-loader.js 或 scene-controller.js 的对应实现，这些用例必须变红。
export async function setup(runner) {
  runner.test('Scene: JSON5 裸键与引号值由产品解析器处理', () => {
    const result = loadJson5(`{ name: "coding", plugins: ["plugin-a", "plugin-b"] }`);
    assertEquals(result.name, 'coding', '裸键 name 必须被解析');
    assertEquals(result.plugins.length, 2, '数组必须被解析');
  });

  runner.test('Scene: 字符串外的 // 与 /* */ 注释被跳过', () => {
    const result = loadJson5(`{
      // 行注释
      name: "chat", // 行尾注释
      /* 块注释 */ plugins: ["gateway", "model"]
    }`);
    assertEquals(result.name, 'chat');
    assertEquals(result.plugins.length, 2);
  });

  runner.test('Scene: 尾随逗号（含闭合符前隔着注释）', () => {
    assertEquals(loadJson5(`{ name: "analysis", plugins: ["a", "b",], }`).plugins.length, 2);
    assertEquals(loadJson5(`{ a: 1, // 注释\n }`).a, 1);
  });

  runner.test('Scene: 嵌套对象', () => {
    const result = loadJson5(`{ name: "test", config: { key: "value", nested: { a: "b" } } }`);
    assertEquals(result.config.key, 'value');
    assertEquals(result.config.nested.a, 'b');
  });

  runner.test('Scene: 布尔值', () => {
    const result = loadJson5(`{ enabled: true, disabled: false }`);
    assertEquals(result.enabled, true);
    assertEquals(result.disabled, false);
  });

  runner.test('Scene: 数字值', () => {
    const result = loadJson5(`{ count: 42, ratio: 3.14 }`);
    assertEquals(result.count, 42);
    assertEquals(result.ratio, 3.14);
  });

  runner.test('Scene: 含空格的字符串', () => {
    assertEquals(loadJson5(`{ name: "my scene" }`).name, 'my scene');
  });

  runner.test('Scene: 字符串内的 // 不得被当作注释（URL）', () => {
    assertEquals(loadJson5(`{ url: "http://example.com/a//b" }`).url, 'http://example.com/a//b');
  });

  runner.test('Scene: 字符串内的 /* */ 不得被吞掉', () => {
    assertEquals(loadJson5(`{ note: "a /* b */ c" }`).note, 'a /* b */ c');
  });

  runner.test('Scene: 单引号字符串（含内部双引号）', () => {
    assertEquals(loadJson5(`{ name: 'chat' }`).name, 'chat');
    assertEquals(loadJson5(`{ note: 'say "hi"' }`).note, 'say "hi"');
  });

  runner.test('Scene: 非法输入必须抛 Invalid scene config', () => {
    const e = loadError(`{ name: "test", plugins: [broken }`);
    assert(e, '非法 JSON5 必须抛错');
    assert(e.message.startsWith('Invalid scene config:'), `错误消息应带前缀，实际：${e.message}`);
  });

  runner.test('Scene: 非字符串输入必须具名拒绝', () => {
    const e = loadError(42);
    assert(e && e.message.includes('输入必须是字符串'), '非字符串输入必须抛 Invalid scene config');
  });

  const controller = () => new SceneController({ log() {}, plugins: new Map(), lifecycle: null }, null);

  runner.test('Scene: include 展开走真实场景文件（agent-platform → base-system）', async () => {
    const scene = await controller().findScene('agent-platform');
    assert(scene, 'agent-platform 场景必须存在');
    assertEquals(scene.include.join(','), 'base-system');
    assert(scene.eager.includes('admission-gate'), `include 的 eager 未合并：${scene.eager.join(',')}`);
    assert(scene.partial === undefined, '完整 include 不应标记 partial');
  });

  runner.test('Scene: 缺失 include 必须留下 partial / missingIncludes', async () => {
    const scene = await controller()._expandIncludes({
      name: 'probe', include: ['definitely-missing-scene'], plugins: ['p'], optional: [], eager: [],
    });
    assertEquals(scene.partial, true, '缺失 include 必须标记 partial');
    assertEquals(scene.missingIncludes.join(','), 'definitely-missing-scene');
  });

  runner.test('Scene: 切换 diff 由产品计算（toRemove / toAdd / lazy）', async () => {
    const proposal = await controller().switchTo('base-system', {
      baselinePlugins: ['session', 'model-openai', 'stale-plugin'],
    });
    assertEquals(proposal.ok, true);
    assertEquals(proposal.diff, true, '未确认的切换只返回提案');
    assertEquals(proposal.toRemove.sort().join(','), 'model-openai,session,stale-plugin');
    assert(proposal.toAdd.includes('admission-gate'), `toAdd 应来自目标场景 eager：${proposal.toAdd}`);
    assertEquals(proposal.lazy.length, 0);
  });

  runner.test('Scene: 目标集合相同时 diff 为空', async () => {
    const sc = controller();
    const base = await sc.findScene('base-system');
    const baselinePlugins = base.eager.filter((n) => n !== 'config' && n !== 'gateway');
    const proposal = await sc.switchTo('base-system', { baselinePlugins });
    assertEquals(proposal.toRemove.length, 0);
    assertEquals(proposal.toAdd.length, 0);
  });

  runner.test('Scene: diff 的集合口径 = eager ∪ plugins ∪ lazy，必需集合 = eager', () => {
    const scene = { eager: ['a', 'config'], plugins: ['b'], lazy: ['c', 'a'] };
    assertEquals([...scenePluginNames(scene)].sort().join(','), 'a,b,c');
    assertEquals([...sceneRequiredNames(scene)].join(','), 'a');
  });
}
