// L2 工具路径压测：安全判据的延迟 + 准确率。
//
// 这一层是本方案的重心。判据跑在**每一次工具调用**的必经路径上，是唯一"既有延迟成本、
// 又有正确性成本"的模块。性能优化若以漏判为代价就是负收益 —— 所以本文件把延迟和准确率
// 放在同一张表里看，不接受"快了但漏了"。
//
// 分层：
//   · 纯函数（危险归类 / 影响面抽取）：ns–µs 级，看的是正则有没有退化；
//   · 软闸 check()：µs–ms 级，看的是状态机（_pending）与文件系统扫描；
//   · 执行器全链路：µs 级，看的是热路径上的固定开销。
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  Bench, nsOp, nsOpAsync, fmtInt, parseArgs, selected, projectRoot, renderTable,
} from './lib/bench.mjs';
import { buildCorpus, OUT_OF_SCOPE, EXPECTED_BLOCK } from './lib/corpus.mjs';
import { matchDangerousCommand, classifyIrreversible } from '../../plugins/_lib/danger-patterns.js';
import { DestructiveGate } from '../../plugins/_lib/destructive-gate.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const opts = parseArgs();
if (!selected(opts, 'L2')) process.exit(2);

const covered = (cmd) => !!(matchDangerousCommand(cmd) || classifyIrreversible(cmd));
const bench = new Bench('L2-toolpath', {
  title: 'L2 工具路径：危险判定 / 软闸 / 执行器热路径',
  notes: ['判据跑在每次工具调用上：延迟和准确率必须一起看，缺一个都不能上线。'],
});

// ── 固件 ────────────────────────────────────────────────────────

const tmpRoot = mkdtempSync(join(tmpdir(), 'tt-stress-l2-'));
process.on('exit', () => { try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ } });

/** 造一棵小工作区：根 5 个文件 + 两个子目录各 5 个。 */
function makeWorkspace(name, dirs = 2, filesPerDir = 5) {
  const ws = join(tmpRoot, name);
  mkdirSync(ws, { recursive: true });
  for (let i = 0; i < filesPerDir; i++) writeFileSync(join(ws, `f${i}.js`), 'x');
  for (let d = 0; d < dirs; d++) {
    const sub = join(ws, `d${d}`);
    mkdirSync(sub, { recursive: true });
    for (let i = 0; i < filesPerDir; i++) writeFileSync(join(sub, `g${i}.js`), 'x');
  }
  return ws;
}

const wsSmall = makeWorkspace('small');

// ── L2-01 / L2-02 纯函数判定延迟 ────────────────────────────────

{
  const { dangerous, benign } = buildCorpus();
  const cyc = (arr) => { let i = 0; return () => arr[(i++) % arr.length].cmd; };

  const benignNext = cyc(benign);
  const nsBenign = nsOp(() => { matchDangerousCommand(benignNext()); classifyIrreversible(benignNext()); },
    { iters: 20000, warmup: 2000 });

  const dangerNext = cyc(dangerous);
  const nsDanger = nsOp(() => { matchDangerousCommand(dangerNext()); classifyIrreversible(dangerNext()); },
    { iters: 20000, warmup: 2000 });

  bench.record({ id: 'L2-01', scene: '危险判定·良性命令', metric: '两层判定合计', value: nsBenign / 1000, unit: 'µs', kind: 'R' });
  bench.record({ id: 'L2-02', scene: '危险判定·危险命令', metric: '两层判定合计', value: nsDanger / 1000, unit: 'µs', kind: 'R' });
}

// ── L2-03 ReDoS ────────────────────────────────────────────────
// 放子进程里跑：真出现灾难性回溯时，父进程能按墙钟超时判红，而不是陪着挂死。
{
  const child = spawn(process.execPath, [join(HERE, 'lib', 'redos-child.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const deadline = 30000;
  const timer = setTimeout(() => { child.kill('SIGKILL'); }, deadline);
  const code = await new Promise((r) => child.on('close', r));
  clearTimeout(timer);

  if (code !== 0) {
    bench.fail('L2-03', '对抗输入（ReDoS）', `子进程异常退出 code=${code}${err ? `：${err.slice(0, 300)}` : ''}`);
  } else {
    let report;
    try { report = JSON.parse(out); } catch { report = null; }
    if (!report) {
      bench.fail('L2-03', '对抗输入（ReDoS）', `子进程输出不可解析：${out.slice(0, 200)}`);
    } else {
      bench.record({
        id: 'L2-03a', scene: `ReDoS 放大比（5k→60k，${report.scaleCases} 组形态）`, metric: '最坏放大比',
        value: report.worstRatio, unit: '\u00d7', kind: 'H', limit: 20, cmp: '<=',
        note: report.worstScale ? `最差：${report.worstScale.label} 5k=${report.worstScale.smallMs}ms → 60k=${report.worstScale.largeMs}ms` : undefined,
      });
      bench.record({
        id: 'L2-03b', scene: `ReDoS 绝对上限（${report.cases} 组 6 万字符输入）`, metric: '最坏单次',
        value: report.maxMs, unit: 'ms', kind: 'H', limit: 50, cmp: '<=',
        note: report.slowest ? `最慢：${report.slowest.label} = ${report.slowest.ms}ms` : undefined,
      });
      bench.record({ id: 'L2-03c', scene: 'ReDoS 全组总耗时', metric: '总耗时', value: report.totalMs, unit: 'ms', kind: 'R' });
    }
  }
}

// ── L2-04 软闸良性路径 ─────────────────────────────────────────

const gate = new DestructiveGate();
{
  const ns = nsOp(() => gate.check('tool-bash', { command: 'ls -la src/' }, wsSmall, { mode: 'auto', enabled: true, sessionId: 's1' }),
    { iters: 20000, warmup: 2000 });
  bench.record({ id: 'L2-04', scene: '软闸 check()·良性命令', metric: '单次', value: ns / 1000, unit: 'µs', kind: 'R' });
}

// ── L2-05 影响面扫描：大目录 ───────────────────────────────────
{
  if (opts.quick) {
    bench.skip('L2-05', '软闸计数·大目录', '--quick 跳过（要造 1 万个文件）');
  } else {
    const big = join(tmpRoot, 'big');
    mkdirSync(big, { recursive: true });
    for (let i = 0; i < 10000; i++) writeFileSync(join(big, `n${i}.js`), '');
    const t0 = Date.now();
    const res = gate.check('tool-bash', { command: 'rm -rf big' }, join(tmpRoot), { mode: 'auto', enabled: true, sessionId: 's2' });
    const ms = Date.now() - t0;
    bench.record({ id: 'L2-05', scene: '软闸计数·1 万文件目录', metric: '单次挑战生成', value: ms, unit: 'ms', kind: 'R' });
    // 扫描上限 MAX_COUNT = 2000：一万个文件必然算不全，此时**唯一诚实的答案**是
    // "unbounded"（如实说算不出来），而不是给一个自信的小数字。所以判据不是"报满一万"。
    const files = res?.challenge?.measured?.files;
    const honest = files === 'unbounded' || (typeof files === 'number' && files >= 2000);
    bench.record({ id: 'L2-05b', scene: '软闸计数·1 万文件目录', metric: '算不全时是否如实说', value: honest ? 0 : 1, unit: 'count', kind: 'H', limit: 0, cmp: '==', note: `报出：${files}` });
  }
}

// ── L2-06 执行器全链路（只读工具）──────────────────────────────
{
  const { buildExecutor } = await import('./lib/executor.mjs');
  const { ex, core } = await buildExecutor({ workDir: wsSmall });
  try {
    const ns = await nsOpAsync(() => ex.executeOne('tool-read', { path: 'f0.js' }, 'bench-session', null),
      { iters: 3000, warmup: 300 });
    bench.record({ id: 'L2-06', scene: '工具执行全链路·tool-read', metric: '单次', value: ns / 1000, unit: 'µs', kind: 'R' });

    // 危险命令走完整链路（硬拦）——这是最坏情况，也要有数字
    const nsBlocked = await nsOpAsync(() => ex.executeOne('tool-bash', { command: 'rm -rf /' }, 'bench-session', null),
      { iters: 2000, warmup: 200 });
    bench.record({ id: 'L2-06b', scene: '工具执行全链路·硬拦命中', metric: '单次', value: nsBlocked / 1000, unit: 'µs', kind: 'R' });
  } finally {
    await ex.stop?.();
    core.removeAllListeners?.();
  }
}

// ── L2-07 / L2-08 准确率（硬门禁）──────────────────────────────

const { dangerous, benign } = buildCorpus();
{
  const miss = dangerous.filter((d) => !covered(d.cmd));
  bench.record({ id: 'L2-07', scene: `危险语料漏判（${dangerous.length} 条）`, metric: '漏判数', value: miss.length, unit: 'count', kind: 'H', limit: 0, cmp: '==',
    note: miss.length ? `例：${miss.slice(0, 3).map((m) => JSON.stringify(m.cmd)).join(' / ')}` : undefined });

  const fp = benign.filter((b) => covered(b.cmd));
  bench.record({ id: 'L2-08', scene: `良性语料误判（${benign.length} 条）`, metric: '误判数', value: fp.length, unit: 'count', kind: 'H', limit: 0, cmp: '==',
    note: fp.length ? `例：${fp.slice(0, 3).map((m) => JSON.stringify(m.cmd)).join(' / ')}` : undefined });

  // 射程外 / 有意保守：只报告，不判失败 —— 但必须可见，不能装作没有
  const oos = OUT_OF_SCOPE.filter((o) => covered(o.cmd));
  bench.record({ id: 'L2-07x', scene: `射程外条目已被覆盖（${OUT_OF_SCOPE.length} 条，应保持 0）`, metric: '条目数', value: oos.length, unit: 'count', kind: 'R' });
  const eb = EXPECTED_BLOCK.filter((o) => covered(o.cmd));
  bench.record({ id: 'L2-08x', scene: `有意保守拦截仍生效（${EXPECTED_BLOCK.length} 条）`, metric: '条目数', value: eb.length, unit: 'count', kind: 'R' });
}

// ── L2-09 高负载后判定不变 ─────────────────────────────────────

{
  const before = { miss: dangerous.filter((d) => !covered(d.cmd)).length, fp: benign.filter((b) => covered(b.cmd)).length };
  const all = [...dangerous, ...benign].map((x) => x.cmd);
  for (let round = 0; round < 100; round++) {
    for (const cmd of all) covered(cmd);
  }
  const after = { miss: dangerous.filter((d) => !covered(d.cmd)).length, fp: benign.filter((b) => covered(b.cmd)).length };
  const drift = Math.abs(after.miss - before.miss) + Math.abs(after.fp - before.fp);
  bench.record({ id: 'L2-09', scene: `判定结果稳定性（${fmtInt(all.length * 100)} 次混合后复测）`, metric: '判定漂移', value: drift, unit: 'count', kind: 'H', limit: 0, cmp: '==' });
}

// ── L2-10 并发判定隔离 ─────────────────────────────────────────

{
  const g = new DestructiveGate();
  const cmd = 'rm -rf d0';
  const sessions = Array.from({ length: 8 }, (_, i) => `sess-${i}`);

  // 8 个会话交错地各失败 3 次：每个会话都必须自己把自己锁死（而不是被别人带锁）
  const results = await Promise.all(sessions.map(async (sid) => {
    // 首发不带 ack ⇒ 只领挑战、attempts 从 0 起；此后每次带错误 ack 记一次失败。
    // MAX_ATTEMPTS = 3 ⇒ 第 4 次（首发 + 3 次错误）才落到 blocked。
    const seen = [];
    for (let a = 0; a < 4; a++) {
      const r = await g.check('tool-bash', { command: cmd, danger_ack: { reason: '错的理由', files: 0, scope: 'x' } }, wsSmall, { sessionId: sid });
      seen.push(r && !r.__ack ? (r.status === 'blocked' ? 'reject' : 'challenge') : 'ack');
    }
    return seen;
  }));
  const allLocked = results.every((r) => r[r.length - 1] === 'reject');
  bench.record({ id: 'L2-10', scene: '8 会话交错锁定（JS 单线程，交错即真实并发形态）', metric: '每个会话独立锁死', value: allLocked ? 0 : 1, unit: 'count', kind: 'H', limit: 0, cmp: '==',
    note: allLocked ? undefined : JSON.stringify(results) });

  // 新会话不受影响：仍应拿到挑战（不是继承拒绝）
  const fresh = await g.check('tool-bash', { command: cmd }, wsSmall, { sessionId: 'sess-fresh' });
  const freshOk = !!(fresh && fresh.status === 'needs_reasoning');
  bench.record({ id: 'L2-10b', scene: '新会话不被他人锁定牵连', metric: '拿到挑战', value: freshOk ? 0 : 1, unit: 'count', kind: 'H', limit: 0, cmp: '==' });
}

bench.finish();
