// R0-72（B 包）：harness 钩子作用域与异常清理的**最小可信度反例**（metamorphic tests）。
//
// 专家原话：「971个测试每次执行全部58个文件钩子，本身说明旧的971/971可能存在无关钩子污染；
// 按注册文件分桶正确但还不足以认定作用域语义闭合。请补一组最小的、独立可理解的 harness
// metamorphic tests：不同文件各设互相矛盾的 beforeEach/afterEach，只在各自测试生效；
// 异常/失败时 cleanup 保证；嵌套 suite、同文件多个 hook 的顺序稳定；
// process.stderr.write/process.chdir 等全局变更结束后恢复。」
//
// 做法：每个场景在**独立子进程**里构造一个合成的 TestRunner（两个"假文件"，各自注册
// 互相矛盾的钩子），跑**真实**的 runner.run() 路径，钩子与用例把执行顺序追加写进 trace 文件。
// 父进程只读 trace 做断言——因此即使场景中故意有失败用例（run() 会 process.exit(1)），
// trace 依然完好可判。

import { TestRunner, assert, assertEquals } from '../harness.mjs';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const HARNESS = join(HERE, '..', 'harness.mjs');

// 子进程脚本：argv[2]=场景名 argv[3]=trace 路径 argv[4]=harness 路径
const CHILD_SRC = `
import { TestRunner } from ${JSON.stringify(pathToFileURL(HARNESS).href)};
import { appendFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scenario = process.argv[2];
const tracePath = process.argv[3];
const log = (s) => appendFileSync(tracePath, s + '\\n');

const runner = new TestRunner({ name: 'Meta' });

if (scenario === 'scope') {
  // 两个"假文件"注册**互相矛盾**的钩子：各自只应作用于自己的用例
  runner.setCurrentFile('/fake/A.test.mjs');
  runner.beforeEach(() => log('A:before'));
  runner.afterEach(() => log('A:after'));
  runner.test('A1', () => log('A1'));
  runner.test('A2', () => log('A2'));

  runner.setCurrentFile('/fake/B.test.mjs');
  runner.beforeEach(() => log('B:before'));
  runner.afterEach(() => log('B:after'));
  runner.test('B1', () => log('B1'));
}

if (scenario === 'exception-cleanup') {
  runner.setCurrentFile('/fake/A.test.mjs');
  runner.beforeEach(() => log('A:before'));
  runner.afterEach(() => log('A:after'));
  runner.test('A-ok', () => log('A-ok'));
  runner.test('A-boom', () => { log('A-boom'); throw new Error('boom'); });

  // B 文件**没有**钩子：A 的钩子不得越界作用到 B
  runner.setCurrentFile('/fake/B.test.mjs');
  runner.test('B1', () => log('B1'));
}

if (scenario === 'order-and-boundary') {
  runner.setCurrentFile('/fake/A.test.mjs');
  runner.beforeAll(() => log('A:all-before'));
  runner.beforeEach(() => log('A:b1'));
  runner.beforeEach(() => log('A:b2'));
  runner.test('A1', () => log('A1'));
  runner.test('A2', () => log('A2'));
  runner.afterAll(() => log('A:all-after'));

  runner.setCurrentFile('/fake/B.test.mjs');
  runner.beforeAll(() => log('B:all-before'));
  runner.beforeEach(() => log('B:before'));
  runner.test('B1', () => log('B1'));
  runner.afterAll(() => log('B:all-after'));
}

if (scenario === 'global-mutation-restore') {
  const originalCwd = process.cwd();
  const originalWrite = process.stderr.write;
  const scratch = mkdtempSync(join(tmpdir(), 'r072-scratch-'));

  runner.setCurrentFile('/fake/A.test.mjs');
  runner.beforeEach(() => {
    process.chdir(scratch);                       // 进程级全局变更
    process.stderr.write = () => true;            // 进程级全局变更
    log('A:mutated');
  });
  runner.afterEach(() => {
    process.chdir(originalCwd);
    process.stderr.write = originalWrite;
    log('A:restored');
  });
  runner.test('A1', () => log('A1'));

  // 下一个"文件"必须看到**未被污染**的进程状态
  runner.setCurrentFile('/fake/B.test.mjs');
  runner.test('B1', () => {
    log('B:cwd-clean=' + (process.cwd() === originalCwd));
    log('B:stderr-clean=' + (process.stderr.write === originalWrite));
  });
}

await runner.run();
`;

function runScenario(scenario) {
  const d = mkdtempSync(join(tmpdir(), `r072-${scenario}-`));
  const child = join(d, 'child.mjs');
  const trace = join(d, 'trace.txt');
  writeFileSync(child, CHILD_SRC, 'utf8');
  writeFileSync(trace, '');
  const r = spawnSync(process.execPath, [child, scenario, trace, HARNESS], {
    encoding: 'utf8', timeout: 60000,
    env: { ...process.env, TT_REPORT: join(d, 'report.json') },
  });
  const lines = existsSync(trace) ? readFileSync(trace, 'utf8').split('\n').filter(Boolean) : [];
  return { lines, code: r.status, err: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

export async function setup(runner) {
  runner.test('R0-72/M1 互相矛盾的钩子只在各自文件生效（作用域不越界）', () => {
    const { lines } = runScenario('scope');
    assertEquals(lines.join('|'),
      ['A:before', 'A1', 'A:after', 'A:before', 'A2', 'A:after', 'B:before', 'B1', 'B:after'].join('|'),
      `钩子必须按文件隔离；实际=${lines.join('|')}`);
    // 反向断言：A 的钩子绝不出现在 B 的用例周围
    const bIdx = lines.indexOf('B1');
    assert(!lines.slice(bIdx - 1, bIdx + 2).some((l) => l.startsWith('A:')), 'A 的钩子不得触及 B 的用例');
    console.log('       [实测] A/B 两文件钩子完全隔离，顺序为 before→用例→after');
  });

  runner.test('R0-72/M2 异常/失败时 cleanup 仍执行，且不把别的文件卷进来', () => {
    const { lines, code } = runScenario('exception-cleanup');
    const boomIdx = lines.indexOf('A-boom');
    assert(boomIdx >= 0, `应执行到 A-boom；实际=${lines.join('|')}`);
    assertEquals(lines[boomIdx + 1], 'A:after', '用例抛错后 afterEach 必须仍执行（清理保证）');
    assert(lines.includes('B1'), 'B 文件的用例仍应执行');
    const bIdx = lines.indexOf('B1');
    // 语义澄清：B1 **之前**那一行是 A 文件最后一个用例的 afterEach（合法，属 A 的边界内）；
    // 越界的判据是"B1 执行之后不得再触发 A 的钩子"。
    assert(!lines.slice(bIdx + 1).some((l) => l.startsWith('A:')),
      `B1 之后不得再出现 A 的钩子；实际=${lines.slice(bIdx).join('|')}`);
    assertEquals(code, 1, '有用例失败时 run() 必须退出码非零（真实退出码语义）');
    console.log('       [实测] 抛错用例的 afterEach 已执行；退出码非零；钩子未越界');
  });

  runner.test('R0-72/M3 同文件多钩子顺序稳定，beforeAll/afterAll 每文件各一次', () => {
    const { lines } = runScenario('order-and-boundary');
    assertEquals(lines.join('|'),
      ['A:all-before', 'A:b1', 'A:b2', 'A1', 'A:b1', 'A:b2', 'A2', 'A:all-after',
        'B:all-before', 'B:before', 'B1', 'B:all-after'].join('|'),
      `钩子顺序/边界必须稳定；实际=${lines.join('|')}`);
    assertEquals(lines.filter((l) => l === 'A:all-before').length, 1, 'beforeAll 每文件只跑一次');
    assertEquals(lines.filter((l) => l === 'A:all-after').length, 1, 'afterAll 每文件只跑一次');
    console.log('       [实测] 注册顺序稳定；beforeAll/afterAll 各文件恰好一次');
  });

  runner.test('R0-72/M4 全局变更（chdir / stderr.write）在本文件结束后复原，不泄漏给下一个文件', () => {
    const { lines } = runScenario('global-mutation-restore');
    assert(lines.includes('A:mutated') && lines.includes('A:restored'), `钩子应执行；实际=${lines.join('|')}`);
    assertEquals(lines.find((l) => l.startsWith('B:cwd-clean=')), 'B:cwd-clean=true', 'cwd 必须已复原');
    assertEquals(lines.find((l) => l.startsWith('B:stderr-clean=')), 'B:stderr-clean=true',
      'process.stderr.write 必须已复原');
    console.log('       [实测] chdir 与 stderr.write 未跨文件泄漏');
  });
}
