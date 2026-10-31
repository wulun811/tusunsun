// R0-72/B2（专家 P0-2 追加要求）：用**真实物理测试文件**在干净子进程验证钩子隔离与全局状态复原。
//
// 专家原话：「metamorphic 反例里的"假文件"若绕过真正文件路径归属/真实注册器，不能单独证明跨文件
// 测试隔离完成。用至少两个实际物理测试文件在干净子进程跑回归，验证 import/注册时文件归属正确，
// afterAll 抛错/测试中断时 cleanup，process.chdir/stderr.write 等是否由 harness 或 fixture
// 真实恢复（**不能把测试自己复位当作 harness 保证**）。」
//
// 因此本文件不自己合成 TestRunner，也不调 setCurrentFile('/fake/...')：
//   · 在临时目录写两个**真实物理测试文件**（a-mutates / b-observer），外加一个 afterAll 抛错的文件；
//   · 用**真实运行器** `test/run-one.mjs --group <fileA> <fileB>` 在**独立子进程**里跑（真实 import、
//     真实 setCurrentFile 归属登记、真实 run() 路径）；
//   · 断言只读子进程的 trace 与 JSON 报告——文件归属、钩子边界、复原责任都在报告里可判。
//
// 关键反例：a-mutates 在 beforeEach 里 chdir + 劫持 process.stderr.write 且**自己从不复位**
// （trace 只有 'A:mutated' 没有 'A:restored'）。b-observer 随后必须看到**干净**的进程状态——
// 这只可能来自 harness 级的文件边界复原（R0-75 新增），fixture 自律被排除。

import { TestRunner, assert, assertEquals } from '../harness.mjs';
import { writeFileSync, readFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..', '..');
const HARNESS_URL = new URL('../harness.mjs', import.meta.url).href;
const RUN_ONE = join(ROOT, 'test', 'run-one.mjs');

// 真实物理测试文件 A：全局变更 + 矛盾钩子，**自己不复位**
const A_SRC = `
import { assert } from ${JSON.stringify(HARNESS_URL)};
import { appendFileSync } from 'node:fs';
const log = (s) => appendFileSync(process.env.R072_TRACE, s + '\\n');
export async function setup(runner) {
  runner.beforeAll(() => log('A:all-before'));
  runner.beforeEach(() => {
    process.chdir(process.env.R072_SCRATCH);       // 进程级全局变更
    process.stderr.write = () => true;             // 进程级全局变更
    log('A:before');
  });
  runner.afterEach(() => log('A:after'));          // 只记录，**不复位**（trace 里没有 A:restored）
  runner.test('A1', () => { log('A1'); assert(true); });
  runner.test('A2', () => { log('A2'); assert(true); });
  runner.afterAll(() => log('A:all-after'));
}
`;

// 真实物理测试文件 B：只观测，不做任何复原
const B_SRC = `
import { appendFileSync } from 'node:fs';
const log = (s) => appendFileSync(process.env.R072_TRACE, s + '\\n');
const stderrWriteAtImport = process.stderr.write;
export async function setup(runner) {
  runner.beforeEach(() => log('B:before'));
  runner.afterEach(() => log('B:after'));
  runner.test('B1', () => {
    log('B:cwd-clean=' + (process.cwd() === process.env.R072_ORIGIN_CWD));
    log('B:stderr-clean=' + (process.stderr.write === stderrWriteAtImport));
    log('B1');
  });
}
`;

// 真实物理测试文件 C：afterAll 抛错（清理失败必须对 CI 可见）
const C_SRC = `
import { appendFileSync } from 'node:fs';
const log = (s) => appendFileSync(process.env.R072_TRACE, s + '\\n');
export async function setup(runner) {
  runner.test('C1', () => { log('C1'); });
  runner.afterAll(() => { log('C:all-after'); throw new Error('注入的清理失败（afterAll）'); });
}
`;

// 真实物理测试文件 D：用例抛错 → 同文件的 afterAll 仍必须执行（中断时 cleanup 保证）
const D_SRC = `
import { appendFileSync } from 'node:fs';
const log = (s) => appendFileSync(process.env.R072_TRACE, s + '\\n');
export async function setup(runner) {
  runner.test('D1-ok', () => { log('D1'); });
  runner.test('D2-boom', () => { log('D2'); throw new Error('注入的用例失败'); });
  runner.afterAll(() => log('D:all-after'));
}
`;

function writeSuite(dir) {
  const files = {
    a: join(dir, 'a-mutates.test.mjs'),
    b: join(dir, 'b-observer.test.mjs'),
    c: join(dir, 'c-afterall-throws.test.mjs'),
    d: join(dir, 'd-interrupt.test.mjs'),
  };
  writeFileSync(files.a, A_SRC, 'utf8');
  writeFileSync(files.b, B_SRC, 'utf8');
  writeFileSync(files.c, C_SRC, 'utf8');
  writeFileSync(files.d, D_SRC, 'utf8');
  return files;
}

function runGroup(dir, testFiles, extraEnv = {}) {
  const trace = join(dir, `trace-${Math.random().toString(36).slice(2, 8)}.txt`);
  const report = join(dir, `report-${Math.random().toString(36).slice(2, 8)}.json`);
  writeFileSync(trace, '');
  const r = spawnSync(process.execPath, [RUN_ONE, '--group', ...testFiles], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    env: {
      ...process.env,
      TT_REPORT: report,
      R072_TRACE: trace,
      R072_SCRATCH: join(dir, 'scratch'),
      R072_ORIGIN_CWD: ROOT,
      ...extraEnv,
    },
  });
  return {
    code: r.status ?? (r.error ? 127 : 0),
    // 去掉 ANSI 颜色码：断言必须匹配**语义文本**，不能因为彩色转义而误判（R0-72 实测踩过）
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, ''),
    trace: existsSync(trace) ? readFileSync(trace, 'utf8').split('\n').filter(Boolean) : [],
    report: existsSync(report) ? JSON.parse(readFileSync(report, 'utf8')) : null,
  };
}

export async function setup(runner) {
  const dir = mkdtempSync(join(tmpdir(), 'r072b-real-files-'));
  mkdirSync(join(dir, 'scratch'), { recursive: true });
  const files = writeSuite(dir);

  runner.afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  runner.test('R0-72/B2-1 真实物理文件经真实运行器 import → 报告里的 file 归属正确（非 (default)）', () => {
    const r = runGroup(dir, [files.a, files.b]);
    assertEquals(r.code, 0, `两个真实文件应全绿退出 0；输出=${r.out.slice(-400)}`);
    assert(r.report, '真实运行器必须落盘 JSON 报告（TT_REPORT）');
    const got = r.report.tests.map((t) => `${t.name}@${t.file}`);
    assertEquals(got.join('|'), [`A1@${files.a}`, `A2@${files.a}`, `B1@${files.b}`].join('|'),
      `归属必须由真实 import 时的 setCurrentFile 登记；实际=${got.join('|')}`);
    assert(!r.report.tests.some((t) => !t.file || t.file === '(default)'), '不得出现无归属用例');
    console.log(`       [实测] ${got.length} 个用例的 file 归属 = 两个真实物理路径（无 (default)）`);
  });

  runner.test('R0-72/B2-2 真实文件之间钩子不越界（矛盾 beforeEach/afterEach 各自生效）', () => {
    const r = runGroup(dir, [files.a, files.b]);
    const lines = r.trace;
    assertEquals(lines.join('|'),
      ['A:all-before', 'A:before', 'A1', 'A:after', 'A:before', 'A2', 'A:after', 'A:all-after',
        'B:before', 'B:cwd-clean=true', 'B:stderr-clean=true', 'B1', 'B:after'].join('|'),
      `真实文件之间的钩子顺序/边界必须稳定；实际=${lines.join('|')}`);
    const bIdx = lines.indexOf('B1');
    assert(!lines.slice(bIdx + 1).some((l) => l.startsWith('A:')), 'B1 之后不得再出现 A 的钩子');
    console.log('       [实测] A/B 两个真实文件的钩子完全隔离，beforeAll/afterAll 各一次');
  });

  runner.test('R0-72/B2-3 chdir / stderr.write 由**harness**在文件边界复原（不是 fixture 自律）', () => {
    const r = runGroup(dir, [files.a, files.b]);
    // 反证：A 自己从不复位（trace 中只有 A:mutated 语义的钩子，且无任何 A:restored 标记）
    assert(!r.trace.includes('A:restored'), 'A 文件本身不应做任何复位（否则不能证明是 harness 的保证）');
    assertEquals(r.trace.find((l) => l.startsWith('B:cwd-clean=')), 'B:cwd-clean=true',
      'A 之后的下一个真实文件必须看到未污染的 cwd');
    assertEquals(r.trace.find((l) => l.startsWith('B:stderr-clean=')), 'B:stderr-clean=true',
      'A 之后的下一个真实文件必须看到未污染的 process.stderr.write');
    assert(r.report?.globalRestores, '报告必须记录 harness 级复原证据 globalRestores');
    assert(r.report.globalRestores.chdir >= 1, `harness 必须至少复原 cwd 一次；实际=${JSON.stringify(r.report.globalRestores)}`);
    assert(r.report.globalRestores.stderrWrite >= 1, `harness 必须至少复原 stderr.write 一次；实际=${JSON.stringify(r.report.globalRestores)}`);
    console.log(`       [实测] harness 文件边界复原计数 = ${JSON.stringify(r.report.globalRestores)}（fixture 未做任何复位）`);
  });

  runner.test('R0-72/B2-4 afterAll 抛错（清理失败）对 CI 可见：非零退出 + 报告计数', () => {
    const r = runGroup(dir, [files.c]);
    assert(r.code !== 0, `afterAll 抛错必须阻断（此前只打印、退出码仍 0）；实际 exit=${r.code}`);
    assert(/ERROR in afterAll/.test(r.out), `必须打印具名钩子错误；输出=${r.out.slice(-300)}`);
    assert((r.report?.hookErrors ?? 0) >= 1, `报告必须记录 hookErrors；实际=${JSON.stringify(r.report?.hookErrors)}`);
    console.log(`       [实测] afterAll 抛错 → exit=${r.code}，hookErrors=${r.report?.hookErrors}`);
  });

  runner.test('R0-72/B2-5 用例失败（中断）时同文件 afterAll 仍执行，运行器退出码非零', () => {
    const r = runGroup(dir, [files.d]);
    assertEquals(r.code, 1, `有用例失败必须 exit 1；输出=${r.out.slice(-300)}`);
    assert(r.trace.includes('D2'), `应执行到抛错用例；实际=${r.trace.join('|')}`);
    assert(r.trace.includes('D:all-after'), `用例失败后同文件 afterAll 必须仍执行（清理保证）；实际=${r.trace.join('|')}`);
    console.log('       [实测] 用例抛错后 afterAll 仍执行，且运行器退出码非零');
  });
}
