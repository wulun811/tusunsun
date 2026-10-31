// 单文件测试运行器：一个文件一个进程，隔离更强，也天然得到每文件耗时。
//
// 用法：node test/run-one.mjs <test-file>
//       node test/run-one.mjs --group <file...>   # 不自治的文件同进程跑
// 环境：
//   TT_REPORT=<path>  把 JSON 报告写到指定路径（默认 test-results/）
//   TT_QUIET=1        抑制逐用例输出（失败信息仍由协调器汇总）

import { TestRunner } from './harness.mjs';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
// 退出时同步回收本进程组的残留子进程：上层协调器只等本进程退出，不会替它收尸。
import { installReapOnExit } from './lib/proc.mjs';

installReapOnExit();

const file = process.argv[2];
if (!file) {
  console.error('Usage: node test/run-one.mjs <test-file>');
  process.exit(2);
}

// 注意：**不**在这里抑制 console.log。
// 协调器会捕获每个子进程的输出，只在失败时打印尾部、或 --verbose 时全量打印；
// 若在此处把 console.log 置空，harness 的 FAIL 行会被一起吞掉，失败将无法诊断。
const quiet = process.env.TT_QUIET === '1';

// 组模式：`--group f1 f2 ...` 把若干文件 import 进同一个进程 / 同一个 runner。
// 个别文件依赖共享的进程内环境（遗留 socket、先前文件设置的模块级状态），
// 独立进程会改变它们的通过性；这些文件编成"非自治组"同进程运行。
const groupIdx = process.argv.indexOf('--group');
const groupFiles = groupIdx >= 0 ? process.argv.slice(groupIdx + 1) : null;

if (groupFiles) {
  const runner = new TestRunner({ name: process.env.TT_SUITE_NAME || 'Unit Tests' });
  const bad = [];
  for (const f of groupFiles) {
    const abs = resolve(f);
    runner.setCurrentFile(abs);   // 钩子按文件归属（各文件的 beforeEach 只作用于自己的用例）
    let mod;
    try {
      mod = await import(pathToFileURL(abs).href);
    } catch (e) {
      console.error(`Failed to load ${abs}: ${e.message}`);
      bad.push(abs);
      continue;
    }
    if (mod.default && typeof mod.default === 'function') await mod.default(runner);
    else if (mod.setup && typeof mod.setup === 'function') await mod.setup(runner);
    else { console.error(`[run-one] 测试文件无合法入口（缺 default/setup 导出）：${abs}`); bad.push(abs); }
  }
  if (runner.tests.length === 0) {
    console.error('[run-one][FAIL] 没有注册任何用例 —— 0 用例不等于通过');
    process.exit(1);
  }
  await runner.run();
  try {
    const { takeCoverage } = await import('node:v8');
    takeCoverage();
  } catch { /* 非覆盖率模式 */ }
  process.exit(bad.length ? 1 : (process.exitCode ?? 0));
}

const abs = resolve(file);
// 旧式检查脚本（自带主程序、不导出 setup）不是 harness 用例：按子进程退出码判。
// 先看源文本再决定，避免“先 import（已经买了单）再发现没入口”的双跑。
const head = readFileSync(abs, 'utf8');
const harnessStyle = /export\s+(?:async\s+)?function\s+setup\b|export\s+default\s+(?:async\s+)?function/.test(head);
if (!harnessStyle) {
  console.log(`[run-one] 旧式自跑脚本，按子进程退出码判：${abs}`);
  const r = spawnSync(process.execPath, [abs], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

const runner = new TestRunner({ name: process.env.TT_SUITE_NAME || 'Unit Tests' });
runner.setCurrentFile(abs);

let mod;
try {
  mod = await import(pathToFileURL(abs).href);
} catch (e) {
  console.error(`Failed to load ${abs}: ${e.message}`);
  process.exit(1);
}

// 测试文件必须导出 `setup(runner)` 或 `default(runner)`；缺入口或注册 0 用例都明确失败，
// 静默跳过会让覆盖率报告比真实覆盖更大。
if (mod.default && typeof mod.default === 'function') {
  await mod.default(runner);
} else if (mod.setup && typeof mod.setup === 'function') {
  await mod.setup(runner);
} else {
  console.error(`[run-one] 测试文件无合法入口（缺 default/setup 导出）：${abs}`);
  console.error('[run-one] 约定：导出 `export async function setup(runner)` 或 `export default function(runner)`。');
  process.exit(1);
}

if (runner.tests.length === 0) {
  console.error('[run-one][FAIL] 没有注册任何用例 —— 0 用例不等于通过');
  process.exit(1);
}

await runner.run();

// ── 收尾 ───────────────────────────────────────────────────────────────
// 用例与钩子均已结束、报告已由 run() 同步落盘；部分文件会遗留句柄/定时器/监听，
// 由本运行器统一收尾，避免单文件进程挂住不退出。
try {
  const { takeCoverage } = await import('node:v8');
  takeCoverage();   // 覆盖率模式下强制落盘（避免 process.exit 截断 NODE_V8_COVERAGE）
} catch { /* 非覆盖率模式：无此 API 或未启用，忽略 */ }
process.exit(process.exitCode ?? 0);
