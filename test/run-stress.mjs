// 压测编排器：跑 test/stress/bench-*.mjs，汇总成一份报告。
//
// 三态退出码沿用全仓约定：0 = 全绿，1 = 有失败，2 = 什么都没跑（**不是通过**）。
//
// R0-113 的教训必须保留：本包（开源产物）**不含** test/stress/。此前这里打印
// "No stress tests found." 并 exit 0，于是"跑过压测、全绿"可以被一条空命令伪造。
// 缺资产必须非零退出并可读地说清。
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { globFiles } from './glob-files.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const resultsDir = join(projectRoot, 'test-results', 'stress');

const C = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[90m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m' };

async function findBenches() {
  // 只认 bench-*.mjs：test/stress/lib/ 里是公共库与子进程探针，不是用例
  const files = await globFiles(join(projectRoot, 'test/stress/bench-*.mjs'));
  return [...new Set(files)].sort();
}

function runOne(file, args, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ['--expose-gc', file, ...args], {
      cwd: projectRoot, stdio: ['ignore', 'inherit', 'inherit'],
    });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, duration: Date.now() - started });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, duration: Date.now() - started, error: e.message });
    });
  });
}

function loadReports() {
  if (!existsSync(resultsDir)) return [];
  const out = [];
  for (const f of readdirSync(resultsDir)) {
    if (!f.endsWith('.json')) continue;
    try { out.push(JSON.parse(readFileSync(join(resultsDir, f), 'utf8'))); } catch { /* 坏文件跳过 */ }
  }
  return out;
}

function fmt(v, unit) {
  if (typeof v !== 'number') return String(v);
  if (unit === 'ns') return v < 1000 ? `${v.toFixed(0)}ns` : `${(v / 1000).toFixed(2)}µs`;
  if (unit === 'µs') return v < 1000 ? `${v.toFixed(2)}µs` : `${(v / 1000).toFixed(2)}ms`;
  if (unit === 'ms') return v < 1000 ? `${v.toFixed(2)}ms` : `${(v / 1000).toFixed(2)}s`;
  if (unit === 'req/s' || unit === 'ops/s') return `${Math.round(v).toLocaleString('en-US')} ${unit}`;
  if (unit === 'MB') return `${v.toFixed(1)}MB`;
  if (unit === '×') return `${v.toFixed(2)}×`;
  if (unit === '%') return `${v.toFixed(1)}%`;
  return v.toLocaleString('en-US');
}

function markdown(reports, env, crashed = []) {
  const lines = [];
  lines.push('# 土行孙压测报告');
  lines.push('');
  lines.push(`- 时间：${new Date().toISOString()}`);
  lines.push(`- 环境：${env.cpu} · ${env.cores} vCPU · ${env.memGiB} GiB · Node ${env.node} · ${env.platform}/${env.arch}`);
  lines.push('- 口径：H = 硬门禁（硬件无关，必须过）；R = 记录型（存基线，供下轮比对）');
  lines.push('');
  for (const r of reports) {
    lines.push(`## ${r.title}`);
    lines.push('');
    lines.push('| ID | 场景 | 指标 | 数值 | 判据 | 结论 |');
    lines.push('| --- | --- | --- | ---: | --- | --- |');
    for (const row of r.rows) {
      const limit = row.kind === 'H' ? `${row.cmp || '<='} ${fmt(Number(row.limit), row.unit)}` : '—';
      lines.push(`| ${row.id} | ${row.scene} | ${row.metric} | ${typeof row.value === 'number' ? fmt(row.value, row.unit) : row.value} | ${limit} | ${row.verdict} |`);
    }
    lines.push('');
    if (r.failures?.length) {
      lines.push('失败项：');
      for (const f of r.failures) lines.push(`- \`${f.id}\` ${f.scene} · ${f.metric} = ${fmt(f.value, f.unit)}${f.note ? `（${f.note}）` : ''}`);
      lines.push('');
    }
    if (r.skips?.length) {
      lines.push('跳过：');
      for (const s of r.skips) lines.push(`- \`${s.id}\` ${s.scene} · ${s.reason}`);
      lines.push('');
    }
  }
  if (crashed.length) {
    lines.push('## 套件级失败（非零退出，未产出可用报告）');
    lines.push('');
    lines.push('| 套件 | 退出码 | 说明 |');
    lines.push('| --- | ---: | --- |');
    for (const c of crashed) lines.push(`| ${c.name} | ${c.code} | ${c.error || '无报告'} |`);
    lines.push('');
  }
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const quick = args.includes('--quick') || args.includes('-q');
  const passThrough = args.filter((a) => a === '--quick' || a === '-q' || a === '--live' || a === '--soak' || a.startsWith('--only='));

  const files = await findBenches();
  if (files.length === 0) {
    // R0-113（专家评审 P2）：本包（开源产物）**不含** test/stress/ —— 此前这里打印
    // "No stress tests found." 并 exit 0，于是"跑过压测、全绿"可以被一条空命令伪造。
    // 缺资产必须非零退出并可读地说清，不能伪装成通过。
    console.error('No stress tests found in this package: test/stress/ 不随开源包发布。');
    console.error('压测证据必须来自开发树（`npm run test:stress`），本命令不得作为发布证据。');
    process.exit(1);
  }

  // 清掉上一轮的报告：旧结果留在目录里，很容易被当成本轮结论读走
  if (existsSync(resultsDir)) {
    for (const f of readdirSync(resultsDir)) {
      try { rmSync(join(resultsDir, f), { force: true }); } catch { /* best effort */ }
    }
  }
  mkdirSync(resultsDir, { recursive: true });

  const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
  console.log(`\n${C.bold}=== 土行孙压测 v${pkg.version} ===${C.reset}${quick ? ` ${C.dim}(quick)${C.reset}` : ''}`);
  console.log(`${C.dim}共 ${files.length} 个套件${passThrough.length ? ` · 参数 ${passThrough.join(' ')}` : ''}${C.reset}`);

  const results = [];
  for (const file of files) {
    const name = file.slice(file.lastIndexOf('/') + 1);
    const timeout = quick ? 180000 : 900000;
    process.stdout.write(`\n${C.cyan}▶ ${name}${C.reset}\n`);
    const r = await runOne(file, passThrough, timeout);
    results.push({ name, ...r });
    if (r.code !== 0 && r.code !== 2) {
      console.log(`${C.red}✗ ${name} 退出码 ${r.code}${r.error ? `（${r.error}）` : ''}${C.reset}`);
    } else if (r.code === 2) {
      console.log(`${C.yellow}○ ${name} SKIP${C.reset}`);
    }
  }

  // ── 汇总 ──────────────────────────────────────────────────
  const reports = loadReports().filter((r) => Array.isArray(r.rows));
  if (!reports.length) {
    console.log(`\n${C.red}没有任何报告产出：压测没有真正执行。${C.reset}`);
    process.exit(2);
  }

  const env = reports[0].env;
  let hPass = 0;
  let hFail = 0;
  let recorded = 0;
  let skipped = 0;
  for (const r of reports) {
    for (const row of r.rows) {
      if (row.kind === 'H') { if (row.verdict === 'PASS') hPass++; else if (row.verdict === 'FAIL') hFail++; }
      else if (row.verdict === '记录') recorded++;
      else if (row.verdict === 'SKIP') skipped++;
    }
  }

  // **套件级失败必须进汇总**：崩溃/断言退出的套件**不写报告**，于是旧版的三个计数器
  // 完全看不见它 —— 进程 exit 1，而汇总打印「硬门禁失败 0」。两个输出说的是两件事，
  // 读者只会看汇总。判据是"退出码非 0/2 且有产出过报告"，即它记了东西但结论是坏的。
  const crashed = results.filter((r) => r.code !== 0 && r.code !== 2);
  const crashFailures = crashed.map((r) => ({
    suite: r.name.replace(/^bench-|\.mjs$/g, ''),
    id: 'SUITE-CRASH', scene: r.name, metric: '套件退出码', value: r.code, unit: '',
    note: r.error || '该套件没有产出可用报告（崩溃/断言失败）',
  }));

  console.log(`\n${C.bold}=== 汇总 ===${C.reset}`);
  console.log(`  ${C.green}硬门禁通过 ${hPass}${C.reset} · ${hFail || crashed.length ? C.red : C.dim}硬门禁失败 ${hFail}${C.reset}`
    + `${crashed.length ? ` · ${C.red}套件级失败 ${crashed.length}${C.reset}` : ''} · ${C.dim}记录型 ${recorded}${C.reset} · ${C.yellow}跳过 ${skipped}${C.reset}`);
  if (crashed.length) {
    console.log(`  ${C.red}整体结论 FAIL${C.reset}${C.dim}（有套件以非零退出，其内部判据未进上面的计数）${C.reset}`);
  }

  const failures = [...reports.flatMap((r) => (r.failures || []).map((f) => ({ suite: r.suite, ...f }))), ...crashFailures];
  if (failures.length) {
    console.log(`\n${C.red}${C.bold}失败明细${C.reset}`);
    for (const f of failures) {
      console.log(`  ${C.red}✗${C.reset} [${f.suite}] ${f.id} ${f.scene} · ${f.metric} = ${fmt(f.value, f.unit)}${f.note ? ` ${C.dim}(${f.note})${C.reset}` : ''}`);
    }
  }

  try {
    writeFileSync(join(resultsDir, 'report.md'), markdown(reports, env, crashed));
    console.log(`\n${C.dim}报告：test-results/stress/report.md / *.json${C.reset}`);
  } catch (e) {
    console.log(`${C.yellow}报告落盘失败：${e.message}${C.reset}`);
  }

  if (hFail > 0 || crashed.length) process.exit(1);
  if (hPass === 0 && recorded === 0) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(1); });
