import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const GRAY = '\x1b[90m';
const YELLOW = '\x1b[33m';

// 套件退出码三态：0 = PASS，2 = SKIP（前置缺失，一个用例都没跑），其余 = FAIL。
// 退出码 0 还必须附一份 `Total: N`（N > 0）用例计数：没有计数就无法证明它真的跑过，
// 也就不能把「套件目录消失」记成 PASS。
const SKIP_EXIT = 2;

const suites = [
  { name: 'Smoke', script: 'run-smoke.mjs' },
  { name: 'Unit', script: 'run-unit.mjs' },
  { name: 'Integration', script: 'run-integration.mjs' },
];

const args = process.argv.slice(2);
const quickMode = args.includes('--quick') || args.includes('-q');
const suiteFilter = args.filter(a => !a.startsWith('-'));

if (quickMode) console.log(`\n${GRAY}Quick mode: 单套超时放宽到覆盖实测耗时；套件组合不变（stress 本就不在本跑手内）${RESET}`);
if (suiteFilter.length > 0) console.log(`${GRAY}Running suites: ${suiteFilter.join(', ')}${RESET}`);

const PKG_VERSION = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version;
console.log(`\n${BOLD}=== Tusunsun Test Suite v${PKG_VERSION} ===${RESET}\n`);

/** 最后一条 `Total: N`：harness 与各语言跑手的汇总行同形。 */
function lastTotal(output) {
  const hits = [...output.matchAll(/Total:\s*(\d+)/g)].map((m) => Number(m[1]));
  return hits.length ? hits[hits.length - 1] : null;
}

function runSuite(script, { timeout }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(__dirname, script), ...(quickMode ? ['--quick'] : [])], {
      // 从仓库根运行：部分用例用仓库根相对路径读开发树契约文件。
      cwd: join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let output = '';
    const timer = setTimeout(() => {
      output += `\n[run-all] 超时 ${timeout}ms，终止 ${script}\n`;
      child.kill('SIGKILL');
    }, timeout);
    child.stdout.on('data', (d) => { output += d.toString(); process.stdout.write(d); });
    child.stderr.on('data', (d) => { output += d.toString(); process.stderr.write(d); });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ status: null, output: `${output}\n${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ status: code, output });
    });
  });
}

async function main() {
  let totalPassed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;
  const results = [];

  for (const suite of suites) {
    if (suiteFilter.length > 0 && !suiteFilter.includes(suite.name)) continue;
    console.log(`\n${CYAN}Running ${suite.name} tests...${RESET}`);
    // 看门狗只该抓「挂死了」，不该抓「慢」。此前 quick 档写死 120s，而单测实测约 151s
    // ——于是 `npm run test:quick` **必然**把 Unit 判成「进程未正常退出」，配置值一改就红。
    // 超时按套件给，并留足余量：压测那类才是真正需要短看门狗的地方，本跑手不含它。
    const timeout = quickMode ? 300000 : 900000;
    const result = await runSuite(suite.script, { timeout });
    const total = lastTotal(result.output);
    let status;
    let reason = null;
    if (result.status === null) { status = 'fail'; reason = '进程未正常退出'; }
    else if (result.status === SKIP_EXIT) status = 'skip';
    else if (result.status !== 0) { status = 'fail'; reason = `退出码 ${result.status}`; }
    else if (total === null) { status = 'fail'; reason = '退出码 0 但没有用例计数（Total: N）'; }
    else if (total === 0) { status = 'fail'; reason = '0 用例'; }
    else status = 'pass';

    results.push({ name: suite.name, status, total, reason });
    if (status === 'pass') totalPassed++;
    else if (status === 'skip') totalSkipped++;
    else totalFailed++;
  }

  console.log(`\n${BOLD}=== Final Summary ===${RESET}`);
  for (const r of results) {
    const icon = r.status === 'pass' ? `${GREEN}PASS${RESET}` : r.status === 'skip' ? `${YELLOW}SKIP${RESET}` : `${RED}FAIL${RESET}`;
    const total = r.total == null ? '' : `（${r.total} 用例）`;
    const why = r.reason ? ` — ${r.reason}` : '';
    console.log(`  ${icon} ${r.name}${total}${why}`);
  }
  if (totalSkipped > 0) console.log(`${GRAY}  （SKIP = 前置缺失、未执行任何用例；不是通过）${RESET}`);
  if (results.length === 0) console.log(`${RED}没有匹配到任何套件 —— 0 个套件不等于通过${RESET}`);

  // **用例数棘轮**：退出码与 `Total: N` 只能证明「跑了一次」，不能证明「跑的是原来那个量」。
  //
  // 实测旧行为：删掉 105 个单测文件里的 102 个，剩下的 15 个用例照样打印 `Total: 15`，
  // 照样 `All suites passed`、rc=0。于是「1143 用例全绿」这句话在事实层面可以是假的，
  // 而没有任何一条判据会发现。
  //
  // 现在：每套至少该有多少用例 / 多少个测试文件，记在 tracked 的 `test/baseline-counts.json` 里。
  // 只增不减——新增用例不会红（棘轮方向是“不许变少”），删除会。
  const countDiffs = [];
  try {
    const base = JSON.parse(readFileSync(join(__dirname, 'baseline-counts.json'), 'utf8')).suites || {};
    for (const r of results) {
      if (r.status === 'skip') continue;
      const want = base[r.name];
      if (!want) { countDiffs.push(`${r.name}：未登记用例数基线（新套件必须先入基线）`); continue; }
      if (typeof want.min_cases === 'number' && (r.total ?? 0) < want.min_cases) {
        countDiffs.push(`${r.name}：用例 ${r.total ?? '?'} < 基线 ${want.min_cases}`);
      }
      if (want.dir) {
        const got = readdirSync(join(__dirname, want.dir)).filter((f) => f.endsWith('.test.mjs')).length;
        if (typeof want.min_files === 'number' && got < want.min_files) {
          countDiffs.push(`${r.name}：测试文件 ${got} < 基线 ${want.min_files}（test/${want.dir}）`);
        }
      }
    }
    // 只在全量运行时查“基线里的套件都跑了吗”：带套件名过滤时少跑是预期。
    if (suiteFilter.length === 0) {
      for (const name of Object.keys(base)) {
        if (!results.some((r) => r.name === name)) countDiffs.push(`${name}：基线里有，但本次没有跑到`);
      }
    }
  } catch (e) {
    countDiffs.push(`读不到 test/baseline-counts.json：${e.message}`);
  }
  if (countDiffs.length > 0) {
    console.log(`\n${RED}用例数低于基线 —— 不是「少跑了几个」，是「少了一批用例却仍然全绿」${RESET}`);
    for (const d of countDiffs) console.log(`  · ${d}`);
  }

  // 必验收模式（TT_REQUIRE_PRECONDITIONS=1）下 SKIP 与 FAIL 同等阻断。
  const skipBlocks = process.env.TT_REQUIRE_PRECONDITIONS === '1' && totalSkipped > 0;
  const allPassed = results.length > 0 && totalFailed === 0 && !skipBlocks && countDiffs.length === 0;
  if (skipBlocks) console.log(`\n${RED}TT_REQUIRE_PRECONDITIONS=1：有 ${totalSkipped} 个套件被跳过 —— 必验收模式下不得跳过${RESET}`);
  // 失败原因必须逐条点名。旧版只会写 `N suite(s) failed`：当失败来自别的判据时，
  // 它会打出 `0 suite(s) failed` 却同时是红的 —— 那种自相矛盾的输出比不说更糟。
  const why = [
    totalFailed > 0 ? `${totalFailed} suite(s) failed` : null,
    skipBlocks ? `${totalSkipped} skipped (blocked)` : null,
    countDiffs.length > 0 ? `${countDiffs.length} 项低于用例数基线` : null,
  ].filter(Boolean).join('；');
  console.log(`\n${BOLD}${allPassed ? GREEN + 'All suites passed' : RED + (why || '失败原因未登记（这本身是 bug）')}${RESET}${RESET}`);

  process.exit(allPassed ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
