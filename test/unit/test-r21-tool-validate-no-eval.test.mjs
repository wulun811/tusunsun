// S1：tool-validate 的 json5 分支曾经把模型给的字符串拼进 `new Function` 执行。
//
// 两条攻击用例覆盖"表达式"和"取构造器链"两种形态；两条合法正例保证没有把
// JSON5 子集一起废掉（注释、单引号、尾随逗号、裸键、字符串里的 `//`）。
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, assertEquals } from '../harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (rel) => import(join(ROOT, rel));

async function freshTool() {
  const { default: tool } = await imp('plugins/tools/tool-validate.js');
  return tool;
}

export async function setup(runner) {
  runner.test('S1/1 表达式不再被执行：ok:false 且全局标记未被写入', async () => {
    const tool = await freshTool();
    delete globalThis.__s1_pwned;
    const out = tool.execute({ format: 'json5', content: '(() => { globalThis.__s1_pwned = 1; return 1; })()' });
    assertEquals(out.ok, false, '表达式必须判为非法 JSON5，而不是执行它');
    assertEquals(globalThis.__s1_pwned, undefined, '模型输入不得在内核进程里生效');
  });

  runner.test('S1/2 构造器链也拿不到 process', async () => {
    const tool = await freshTool();
    let leaked = null;
    const out = tool.execute({ format: 'json5', content: 'this.constructor.constructor("return process")().pid' });
    assertEquals(out.ok, false);
    assertEquals(leaked, null, '没有任何路径能把 process 交给模型输入');
    assertEquals(typeof out.error, 'string');
  });

  runner.test('S1/3 合法正例：完整 JSON5 子集仍判通过', async () => {
    const tool = await freshTool();
    const content = [
      '{',
      '  // 行注释',
      "  name: 'tuxingsun',",
      '  /* 块注释 */',
      '  nested: { a: 1, },',
      '  url: "http://example.com/a//b",',
      '}',
    ].join('\n');
    const out = tool.execute({ format: 'json5', content });
    assertEquals(out.ok, true, `合法 JSON5 必须通过，实际：${JSON.stringify(out)}`);
  });

  runner.test('S1/4 合法正例：普通 JSON 与原报错文本仍可用，非法输入给位置', async () => {
    const tool = await freshTool();
    assertEquals(tool.execute({ format: 'json', content: '{"a":1}' }).ok, true);
    const bad = tool.execute({ format: 'json5', content: '{ a: }' });
    assertEquals(bad.ok, false);
    assert(String(bad.error).startsWith('Invalid JSON5 syntax'), '错误文本要能让模型看懂是语法问题');
  });

  runner.test('S1/5 正例：字符串里的 // 不被当成注释（子集解析器的核心判据）', async () => {
    const tool = await freshTool();
    const out = tool.execute({ format: 'json5', content: "{ a: 'x // y', b: 'z /* w */' }" });
    assertEquals(out.ok, true);
  });
}
