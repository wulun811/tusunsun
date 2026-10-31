// 压测公共库：计时、分位、表格、判据、报告落盘。
//
// 三条纪律（本文件存在的理由）：
//   1) **预热**：所有 ns/op 先空跑 warmup 次再计时。JIT 没热时的数字通常高一个数量级，
//      混进结果能凭空调出"优化 10 倍"的假结论。
//   2) **跑固定次数，不跑固定时长**：跑"满 N 秒"会让慢机器少跑次数，分位数因此不可比。
//   3) **硬门禁必须硬件无关**：凡与机器快慢强相关的指标一律记 R（记录型），
//      只把结构性事实（漏判数、泄漏、崩溃、挂死）记 H（硬门禁）。
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus, totalmem, platform, arch } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
export const stressDir = dirname(here);                       // test/stress
export const projectRoot = dirname(dirname(stressDir));       // 仓库根
export const resultsDir = join(projectRoot, 'test-results', 'stress');

// ── 统计 ────────────────────────────────────────────────────────

/** 最近秩分位（nearest-rank）。对排序后的数组取第 ceil(p/100·n) 个。 */
export function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return NaN;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const idx = Math.min(Math.max(rank - 1, 0), sortedAsc.length - 1);
  return sortedAsc[idx];
}

export function summarize(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    min: s[0],
    p50: percentile(s, 50),
    p95: percentile(s, 95),
    p99: percentile(s, 99),
    max: s[s.length - 1],
    mean: sum / s.length,
  };
}

// ── 计时 ────────────────────────────────────────────────────────

const now = () => Number(process.hrtime.bigint());

/**
 * 单次操作均摊耗时（纳秒）。批量循环计时 —— 循环本身的开销远小于每次调 hrtime。
 * @returns {number} ns/op
 */
export function nsOp(fn, { iters = 20000, warmup = 2000 } = {}) {
  for (let i = 0; i < warmup; i++) fn(i);
  const t0 = now();
  for (let i = 0; i < iters; i++) fn(i);
  return (now() - t0) / iters;
}

/** 逐次采样（纳秒数组）。每次 hrtime 约 20–40ns 开销，用于 µs 级以上操作才不失真。 */
export function sampleOp(fn, { iters = 2000, warmup = 200 } = {}) {
  for (let i = 0; i < warmup; i++) fn(i);
  const out = new Array(iters);
  for (let i = 0; i < iters; i++) {
    const t0 = now();
    fn(i);
    out[i] = now() - t0;
  }
  return out;
}

export async function nsOpAsync(fn, { iters = 500, warmup = 50 } = {}) {
  for (let i = 0; i < warmup; i++) await fn(i);
  const t0 = now();
  for (let i = 0; i < iters; i++) await fn(i);
  return (now() - t0) / iters;
}

export async function sampleOpAsync(fn, { iters = 500, warmup = 50 } = {}) {
  for (let i = 0; i < warmup; i++) await fn(i);
  const out = new Array(iters);
  for (let i = 0; i < iters; i++) {
    const t0 = now();
    await fn(i);
    out[i] = now() - t0;
  }
  return out;
}

/** 限时执行：超时直接判失败，不干等（ReDoS 场景必须这样，否则挂死的是压测本身）。 */
export async function withDeadline(fn, ms) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`deadline ${ms}ms exceeded`)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([Promise.resolve().then(fn), guard]);
  } finally {
    clearTimeout(timer);
  }
}

// ── 内存 ────────────────────────────────────────────────────────

export const canGc = typeof globalThis.gc === 'function';
export function gcNow() { if (canGc) { globalThis.gc(); globalThis.gc(); } }
export function rssMB() { return Math.round(process.memoryUsage().rss / 1048576 * 10) / 10; }

// ── 表格渲染（按显示宽度对齐，中文算 2 列）─────────────────────

function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    // CJK 统一表意文字 / 全角标点 / 常见中日韩区段
    w += (c >= 0x1100 && (c <= 0x115f || c === 0x2329 || c === 0x232a ||
      (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1f300 && c <= 0x1f64f))) ? 2 : 1;
  }
  return w;
}

function pad(s, width, align = 'left') {
  const gap = Math.max(0, width - displayWidth(s));
  return align === 'right' ? ' '.repeat(gap) + s : s + ' '.repeat(gap);
}

export function renderTable(headers, rows, aligns = []) {
  const widths = headers.map((h, i) => Math.max(displayWidth(h), ...rows.map(r => displayWidth(r[i] ?? ''))));
  const line = (cells) => '  ' + cells.map((c, i) => pad(c ?? '', widths[i], aligns[i] || (i === 0 ? 'left' : 'right'))).join('  ');
  const out = [line(headers), '  ' + widths.map(w => '─'.repeat(w)).join('  ')];
  for (const r of rows) out.push(line(r));
  return out.join('\n');
}

// ── 数值格式化 ──────────────────────────────────────────────────

export function fmtNs(ns) {
  if (!Number.isFinite(ns)) return 'n/a';
  if (ns < 1000) return `${ns.toFixed(1)} ns`;
  if (ns < 1e6) return `${(ns / 1000).toFixed(2)} µs`;
  return `${(ns / 1e6).toFixed(2)} ms`;
}

export function fmtMs(ms) {
  if (!Number.isFinite(ms)) return 'n/a';
  if (ms < 1000) return `${ms.toFixed(2)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function fmtInt(n) {
  return Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : 'n/a';
}

// ── 环境指纹（报告必须带，否则数字不可比）──────────────────────

export function envInfo(extra = {}) {
  const c = cpus();
  return {
    node: process.version,
    platform: platform(),
    arch: arch(),
    cpu: c[0]?.model?.trim() || 'unknown',
    cores: c.length,
    memGiB: Math.round(totalmem() / 1073741824 * 10) / 10,
    gcExposed: canGc,
    ...extra,
  };
}

// ── 套件 ────────────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[90m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};

export class Bench {
  /**
   * @param {string} name 套件名（也是报告文件名）
   * @param {object} opts { title, notes }
   */
  constructor(name, opts = {}) {
    this.name = name;
    this.title = opts.title || name;
    this.notes = opts.notes || [];
    this.rows = [];
    this.failures = [];
    this.skips = [];
    this.startedAt = Date.now();
  }

  /**
   * 记一条结果。
   * @param {object} e
   *   id     场景编号（L2-03）
   *   scene  场景描述
   *   metric 指标名
   *   value  数值（数字或字符串）
   *   unit   'ms' | 'µs' | 'ns' | 'req/s' | 'ops/s' | 'count' | 'MB' | '×'
   *   kind   'H' 硬门禁 | 'R' 记录型
   *   limit  门禁阈值（kind==='H' 时必填）
   *   cmp    '<' | '<=' | '>' | '>=' | '=='
   *   extra  附加说明
   */
  record(e) {
    if (!e.id) throw new Error('record() 需要 id');
    let pass = true;
    let verdict = '记录';
    if (e.kind === 'H') {
      if (e.limit == null) throw new Error(`${e.id}: 硬门禁必须给 limit`);
      pass = compare(e.value, e.cmp || '<=', e.limit);
      verdict = pass ? 'PASS' : 'FAIL';
      if (!pass) {
        this.failures.push({ id: e.id, scene: e.scene, metric: e.metric, value: e.value, unit: e.unit, limit: e.limit, cmp: e.cmp || '<=', note: e.note });
      }
    }
    this.rows.push({ ...e, pass, verdict });
    return pass;
  }

  /** 显式失败（不是数值越界，而是"这件事发生了"）。 */
  fail(id, scene, reason) {
    this.failures.push({ id, scene, metric: '断言', value: reason, unit: '', limit: '', cmp: '', note: reason });
    this.rows.push({ id, scene, metric: '断言', value: reason, unit: '', kind: 'H', verdict: 'FAIL', pass: false });
  }

  skip(id, scene, reason) {
    this.skips.push({ id, scene, reason });
    this.rows.push({ id, scene, metric: '—', value: 'SKIP', unit: '', kind: '—', verdict: 'SKIP', pass: true, note: reason });
  }

  /** 打印结果、落盘报告、设定退出码。 */
  finish({ exit = true } = {}) {
    const elapsed = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    const env = envInfo();

    console.log(`\n${C.bold}=== ${this.title} ===${C.reset}`);
    console.log(`${C.dim}${env.cpu} · ${env.cores} vCPU · ${env.memGiB} GiB · ${env.node}${env.gcExposed ? '' : ' · 无 --expose-gc（内存数字偏高）'}${C.reset}`);

    for (const note of this.notes) console.log(`${C.dim}${note}${C.reset}`);

    const rows = this.rows.map(r => [
      r.id, r.scene, r.metric,
      typeof r.value === 'number' ? formatByUnit(r.value, r.unit) : String(r.value),
      r.kind === 'H' ? `${r.cmp || '<='} ${formatByUnit(Number(r.limit), r.unit)}` : '—',
      r.kind === 'H' ? (r.verdict === 'PASS' ? `${C.green}PASS${C.reset}` : `${C.red}FAIL${C.reset}`) : `${C.dim}${r.verdict}${C.reset}`,
    ]);
    if (rows.length) console.log('\n' + renderTable(['ID', '场景', '指标', '数值', '判据', '结论'], rows, ['left', 'left', 'left', 'right', 'right', 'right']));

    if (this.failures.length) {
      console.log(`\n${C.red}${C.bold}失败项（${this.failures.length}）${C.reset}`);
      for (const f of this.failures) {
        console.log(`  ${C.red}✗${C.reset} ${f.id} ${f.scene} · ${f.metric} = ${typeof f.value === 'number' ? formatByUnit(f.value, f.unit) : f.value}` +
          (f.limit !== '' && f.limit != null ? `（判据 ${f.cmp} ${formatByUnit(Number(f.limit), f.unit)}）` : ''));
        if (f.note) console.log(`      ${C.dim}${f.note}${C.reset}`);
      }
    }
    if (this.skips.length) {
      console.log(`\n${C.yellow}跳过（${this.skips.length}）${C.reset}`);
      for (const s of this.skips) console.log(`  ${C.yellow}○${C.reset} ${s.id} ${s.scene} · ${s.reason}`);
    }

    const verdict = this.failures.length ? `${C.red}FAIL${C.reset}` : `${C.green}PASS${C.reset}`;
    console.log(`\n${C.bold}结论${C.reset} ${verdict} · ${this.rows.length} 项 / 失败 ${this.failures.length} / 跳过 ${this.skips.length} · 用时 ${elapsed}s`);

    const payload = {
      suite: this.name,
      title: this.title,
      startedAt: new Date(this.startedAt).toISOString(),
      durationSec: Number(elapsed),
      env,
      rows: this.rows,
      failures: this.failures,
      skips: this.skips,
      passed: this.failures.length === 0,
    };
    try {
      mkdirSync(resultsDir, { recursive: true });
      writeFileSync(join(resultsDir, `${this.name}.json`), JSON.stringify(payload, null, 2));
    } catch (e) {
      console.log(`${C.yellow}报告落盘失败（不影响结论）：${e.message}${C.reset}`);
    }

    // 全跳过 = 什么都没验证。按 R0-103 的三态约定 exit 2，绝不当成通过。
    const code = this.failures.length ? 1 : (this.rows.length > 0 && this.skips.length === this.rows.length ? 2 : 0);
    if (exit) process.exit(code);
    return code;
  }
}

function compare(value, cmp, limit) {
  const v = Number(value);
  switch (cmp) {
    case '<': return v < limit;
    case '<=': return v <= limit;
    case '>': return v > limit;
    case '>=': return v >= limit;
    case '==': return v === limit;
    default: throw new Error(`未知比较符: ${cmp}`);
  }
}

export function formatByUnit(v, unit) {
  if (unit === 'ns') return fmtNs(v);
  if (unit === 'µs') return v >= 1000 ? fmtMs(v / 1000) : `${v.toFixed(2)} µs`;
  if (unit === 'ms') return fmtMs(v);
  if (unit === 'count') return `${fmtInt(v)} 条`;
  if (unit === 'MB') return `${v.toFixed(1)} MB`;
  if (unit === 'req/s' || unit === 'ops/s') return `${fmtInt(v)} ${unit}`;
  if (unit === 'files/s' || unit === 'sessions') return `${fmtInt(v)} ${unit}`;
  if (unit === '×') return `${v.toFixed(2)}×`;
  if (unit === '%') return `${v.toFixed(1)}%`;
  return Number.isFinite(v) ? `${fmtInt(v)} ${unit}`.trim() : String(v);
}

/** 读取 CLI 选项：--quick / --only=L2 / --live / --soak */
export function parseArgs(argv = process.argv.slice(2)) {
  const opts = { quick: false, live: false, soak: false, only: null, iters: null };
  for (const a of argv) {
    if (a === '--quick' || a === '-q') opts.quick = true;
    else if (a === '--live') opts.live = true;
    else if (a === '--soak') opts.soak = true;
    else if (a.startsWith('--only=')) opts.only = a.slice(7).toUpperCase();
    else if (a.startsWith('--iters=')) opts.iters = parseInt(a.slice(8), 10);
  }
  return opts;
}

/** 该层是否被 --only 选中 */
export function selected(opts, layer) {
  return !opts.only || opts.only === layer || layer.startsWith(opts.only) || opts.only.startsWith(layer);
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
