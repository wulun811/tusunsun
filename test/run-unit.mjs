import { TestRunner } from './harness.mjs';
import { spawnSync } from 'node:child_process';
import { globFiles } from './glob-files.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { takeCoverage } from 'node:v8';

const __dirname = dirname(fileURLToPath(import.meta.url));

const OLD_STYLE_TESTS = [

];

async function findUnitTests() {
  const patterns = ['unit/**/*.test.mjs'];
  const files = new Set();
  for (const pattern of patterns) {
    for (const f of await globFiles(join(__dirname, pattern))) files.add(f);
  }
  return [...files].sort();
}

async function runOldStyleTests() {
  let allPassed = true;
  for (const file of OLD_STYLE_TESTS) {
    const fullPath = join(__dirname, file);
    const result = spawnSync('node', [fullPath], {
      cwd: join(__dirname, '..'),
      stdio: 'inherit',
      encoding: 'utf-8',
      timeout: 60000,
    });
    if (result.status !== 0) allPassed = false;
  }
  return allPassed;
}

async function main() {
  // Run old-style tests first (they use process.exit directly)
  const oldPassed = await runOldStyleTests();

  const testFiles = await findUnitTests();
  if (testFiles.length === 0 && OLD_STYLE_TESTS.length === 0) {
    console.error('[run-unit][FAIL] 在 test/unit/ 下未发现任何用例 —— 0 用例不等于通过');
    process.exit(1);
  }

  const runner = new TestRunner({ name: 'Unit Tests' });

  // 每个匹配 *.test.mjs 的文件都必须真的产生用例：import 失败或缺 default/setup 时，
  // harness 看不到任何用例；不把它计入失败，文件坏没坏都不影响退出码。
  const badFiles = [];
  for (const file of testFiles) {
    try {
      runner.setCurrentFile(file);
      const mod = await import(pathToFileURL(file).href);
      if (mod.default && typeof mod.default === 'function') {
        await mod.default(runner);
      } else if (mod.setup && typeof mod.setup === 'function') {
        await mod.setup(runner);
      } else {
        badFiles.push(file);
        console.error(`[run-unit] 测试文件无合法入口（缺 default/setup 导出）：${file}`);
      }
    } catch (e) {
      console.error(`Failed to load ${file}: ${e.message}`);
      badFiles.push(file);
    }
  }
  if (badFiles.length > 0) {
    console.error(`\n[run-unit] ${badFiles.length} 个测试文件未被实际执行（静默跳过会导致覆盖率假象）：`);
    for (const f of badFiles) console.error(`  - ${f}`);
    console.error('[run-unit] 约定：导出 `export async function setup(runner)` 或 `export default function(runner)`。\n');
    process.exitCode = 1;
  }

  if (runner.tests.length === 0) {
    console.error('[run-unit][FAIL] 测试文件存在但没有注册任何用例 —— 0 用例不等于通过');
    process.exitCode = 1;
  }

  await runner.run();

  // 必验收模式（发布档门禁以 TT_REQUIRE_PRECONDITIONS=1 调用）：任何 SKIP 都阻断。
  if (process.env.TT_REQUIRE_PRECONDITIONS === '1' && runner.results.skipped > 0) {
    console.error(`\n[run-unit][FAIL] TT_REQUIRE_PRECONDITIONS=1：存在 ${runner.results.skipped} 个 SKIP —— 必验收模式下不得跳过（产物/前置缺失一律阻断）`);
    process.exitCode = 1;
  }

  // 用 exitCode 而非 process.exit()：后者跳过 NODE_V8_COVERAGE 落盘，函数级覆盖率会被低估。
  if (!oldPassed && runner.results.failed === 0) process.exitCode = 1;

  // 收尾保险丝：用例结束后事件循环仍可能被时序性句柄钉住；10s 后打印仍然活着的
  // 资源类型（process.getActiveResourcesInfo），并按当前退出码强制退出。
  // 覆盖率模式下先 takeCoverage() 落盘再退，避免截断已收集的数据。
  // TT_ASSERT_DRAIN=1 把“未排空”升级为失败 —— “测试跑完”与“资源回收完”是两条断言。
  const fuse = setTimeout(() => {
    const alive = process.getActiveResourcesInfo();
    console.error(`[run-unit] 测试已全部结束但事件循环 10s 未排空 ——强制退出（退出码 ${process.exitCode ?? 0}）`);
    console.error(`[run-unit] 仍然活着的资源：${JSON.stringify(alive)}`);
    if (process.env.TT_ASSERT_DRAIN === '1') {
      console.error('[run-unit][FAIL] TT_ASSERT_DRAIN=1：资源回收未完成（测试完成 ≠ 资源回收完成）');
      process.exitCode = 1;
    }
    try { takeCoverage(); } catch { /* 非覆盖模式：忽略 */ }
    process.exit(process.exitCode ?? 0);
  }, 10_000);
  fuse.unref();
}

main().catch(e => { console.error(e); process.exit(1); });
