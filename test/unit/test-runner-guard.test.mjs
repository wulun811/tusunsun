import { TestRunner, assert, assertEquals } from '../harness.mjs';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rejectNodeTestContext, scanHarnessTests } from '../lib/node-test-guard.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARD_URL = new URL('../lib/node-test-guard.mjs', import.meta.url).href;

// 本文件被 `node --test` 加载时在这里直接失败：node --test 不调用 setup()，
// 让它把「0 个断言」记成通过，正是本护栏要阻止的假绿。
rejectNodeTestContext('test/unit/test-runner-guard.test.mjs');

export async function setup(runner) {
  runner.test('Runner guard: test/unit 与 test/integration 没有导入 node:test 的用例', () => {
    const { files, violations } = scanHarnessTests(ROOT);
    assert(files.length > 0, '扫描目标为空 —— 护栏没看见任何 harness 用例');
    assertEquals(violations.length, 0,
      `发现 node:test 误用：${violations.map((v) => v.file).join(', ') || '(none)'}`);
  });

  runner.test('Runner guard: fixture 里的 node:test 误用必须被抓到', () => {
    const dir = mkdtempSync(join(tmpdir(), 'runner-guard-'));
    try {
      mkdirSync(join(dir, 'test/unit'), { recursive: true });
      writeFileSync(join(dir, 'test/unit/bad.test.mjs'), "import test from 'node:test';\ntest('x', () => {});\n");
      const { files, violations } = scanHarnessTests(dir);
      assertEquals(files.length, 1, '扫描目标应包含 fixture 用例');
      assertEquals(violations.length, 1, 'fixture 的 node:test 导入必须被记为违规');
      assertEquals(violations[0].file, 'test/unit/bad.test.mjs');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  runner.test('Runner guard: 未 import harness 也未调用 guard 的用例必须被标记', () => {
    const dir = mkdtempSync(join(tmpdir(), 'runner-guard-unguarded-'));
    try {
      mkdirSync(join(dir, 'test/unit'), { recursive: true });
      writeFileSync(join(dir, 'test/unit/unguarded.test.mjs'),
        "export async function setup(runner) { runner.test('x', () => {}); }\n");
      const { violations } = scanHarnessTests(dir);
      assertEquals(violations.length, 1, '未接线的用例必须被记为违规');
      assertEquals(violations[0].file, 'test/unit/unguarded.test.mjs');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  runner.test('Runner guard: node --test 驱动 harness 用例时必须非 0 退出', () => {
    const dir = mkdtempSync(join(tmpdir(), 'runner-guard-nt-'));
    try {
      const probe = join(dir, 'probe.test.mjs');
      writeFileSync(probe,
        `import { rejectNodeTestContext } from ${JSON.stringify(GUARD_URL)};\n`
        + "rejectNodeTestContext('probe.test.mjs');\n"
        + 'export async function setup() {}\n');
      const r = spawnSync(process.execPath, ['--test', probe], { encoding: 'utf8', timeout: 30000 });
      const out = `${r.stdout || ''}${r.stderr || ''}`;
      assert(r.status !== 0, `node --test 应当非 0，实际 ${r.status}；输出：${out}`);
      assert(out.includes('runner-guard'), `错误信息必须指向 runner-guard；输出：${out}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  runner.test('Runner guard: harness 跑手本身不处于 node --test 上下文', () => {
    assertEquals(process.env.NODE_TEST_CONTEXT, undefined,
      '本套件必须由 node test/run-unit.mjs 驱动，而不是 node --test');
  });
}
