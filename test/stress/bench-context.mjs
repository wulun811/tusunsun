// L3 上下文与会话压测：窗口裁剪的规模行为、会话持久化的追加成本。
//
// 两个都容易在"数据变大"时悄悄变成 O(n²)：
//   · `trimMessages` 每次请求都要对整个历史算一次 token 估算；
//   · `saveHistory` 是增量追加，但"从第几条开始增量"这个游标一旦算错，
//     就会退化成每次全量重写 —— 单测里 3 条消息永远看不出来。
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Bench, sampleOpAsync, summarize, parseArgs, selected } from './lib/bench.mjs';
import { Core } from '../../src/core/core.js';
import contextManager from '../../plugins/context-manager.js';
import sessionPlugin from '../../plugins/session.js';

const opts = parseArgs();
if (!selected(opts, 'L3')) process.exit(2);

const bench = new Bench('L3-context', {
  title: 'L3 上下文与会话：窗口裁剪 / 持久化',
  notes: ['阈值取"是否爆栈/是否 O(n²)"这类结构性事实；绝对毫秒数只做记录。'],
});

const dir = mkdtempSync(join(tmpdir(), 'tt-stress-l3-'));
process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

const core = new Core({ stateDir: dir });
core.log = () => {};

await contextManager.init(core);

// ── 语料：一条消息约 50 token（200 字符）──────────────────────
function makeHistory(n, size = 200) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ role: i % 2 ? 'assistant' : 'user', content: `${i}:` + 'x'.repeat(size) });
  }
  return out;
}

const SYSTEM = 'You are 土行孙.';
const TOOLS = [{ name: 'tool-bash', description: 'run', parameters: { type: 'object', properties: {} } }];

// ── L3-01 窗口裁剪随规模的耗时 ────────────────────────────────
const SIZES = opts.quick ? [100, 1000] : [100, 1000, 5000, 10000];
for (const n of SIZES) {
  const history = makeHistory(n);
  const iters = n <= 1000 ? 100 : 20;
  const samples = await sampleOpAsync(
    () => contextManager.trimMessages(history, SYSTEM, TOOLS),
    { iters, warmup: 5 },
  );
  const st = summarize(samples);
  bench.record({ id: `L3-01-${n}`, scene: `${n} 条历史 · 滑动窗口裁剪`, metric: 'p50', value: st.p50 / 1e6, unit: 'ms', kind: 'R' });
  if (n === SIZES[SIZES.length - 1]) {
    bench.record({ id: 'L3-01', scene: `${n} 条历史（最大档）`, metric: 'p50', value: st.p50 / 1e6, unit: 'ms', kind: 'H', limit: 200, cmp: '<=' });
    const kept = (await contextManager.trimMessages(history, SYSTEM, TOOLS)).length;
    bench.record({ id: 'L3-01b', scene: `${n} 条历史 · 裁剪后保留`, metric: '保留条数', value: kept, unit: 'count', kind: 'H', limit: 1, cmp: '>=' });
  }
}

// ── L3-02 预算为 0 的退化路径 ─────────────────────────────────
{
  const saved = contextManager.maxTokens;
  contextManager.maxTokens = 10;                       // 系统提示本身就超预算 ⇒ available <= 0
  const history = makeHistory(1000);
  let ok = true; let len = -1; let err = null;
  try { len = (await contextManager.trimMessages(history, SYSTEM, TOOLS)).length; } catch (e) { ok = false; err = e.message; }
  contextManager.maxTokens = saved;
  bench.record({ id: 'L3-02', scene: '预算为 0（available ≤ 0）', metric: '不抛异常且退到最小集', value: ok && len >= 1 && len <= 3 ? 0 : 1, unit: 'count', kind: 'H', limit: 0, cmp: '==', note: err || `保留 ${len} 条` });
}

// ── L3-03 巨型单条消息 ───────────────────────────────────────
{
  const history = makeHistory(50);
  history.push({ role: 'user', content: 'y'.repeat(1024 * 1024) });   // 1 MiB 单条
  let ok = true; let ms = 0; let err = null;
  const t0 = performance.now();
  try { await contextManager.trimMessages(history, SYSTEM, TOOLS); } catch (e) { ok = false; err = e.message; }
  ms = performance.now() - t0;
  bench.record({ id: 'L3-03', scene: '单条消息 1 MiB', metric: '不崩且能裁剪', value: ok ? 0 : 1, unit: 'count', kind: 'H', limit: 0, cmp: '==', note: err || undefined });
  bench.record({ id: 'L3-03b', scene: '单条消息 1 MiB', metric: '耗时', value: ms, unit: 'ms', kind: 'R' });
}

// ── 会话 ─────────────────────────────────────────────────────
const sdir = mkdtempSync(join(tmpdir(), 'tt-stress-sess-'));
process.on('exit', () => { try { rmSync(sdir, { recursive: true, force: true }); } catch { /* best effort */ } });
const sc = new Core({ stateDir: sdir });
sc.log = () => {};
await sessionPlugin.init(sc);

// ── L3-04 追加写：1000 次 ───────────────────────────────────
{
  const msgs = [];
  const t0 = performance.now();
  for (let i = 0; i < 1000; i++) {
    msgs.push({ role: 'user', content: `m${i}` });
    await sessionPlugin.saveHistory('bench-a', msgs);
  }
  const ms = performance.now() - t0;
  bench.record({ id: 'L3-04', scene: '单会话追加写 1000 次', metric: '总耗时', value: ms, unit: 'ms', kind: 'H', limit: 5000, cmp: '<=' });

  const loaded = await sessionPlugin.loadSession('bench-a');
  bench.record({ id: 'L3-04b', scene: '追加写后可读回', metric: '读回条数', value: loaded.length, unit: 'count', kind: 'H', limit: 1, cmp: '>=' });

  // 文件必须是**可解析**的 JSONL：坏掉的文件在下次启动时会被静默丢弃
  const file = join(sdir, 'sessions', 'bench-a.jsonl');
  let parseOk = 0;
  if (existsSync(file)) {
    let bad = 0;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { JSON.parse(line); } catch { bad++; }
    }
    parseOk = bad === 0 ? 0 : 1;
  } else {
    parseOk = 1;
  }
  bench.record({ id: 'L3-04c', scene: '会话文件 JSONL 完整性', metric: '坏行数', value: parseOk, unit: 'count', kind: 'H', limit: 0, cmp: '==' });
}

// ── L3-05 读回成本 ──────────────────────────────────────────
{
  const samples = await sampleOpAsync(() => sessionPlugin.loadSession('bench-a'), { iters: 50, warmup: 5 });
  const st = summarize(samples);
  bench.record({ id: 'L3-05', scene: '读回 1000 条历史（OS 页缓存已热）', metric: 'p50', value: st.p50 / 1000, unit: 'µs', kind: 'R' });
}

// ── L3-06 32 会话并行写：串话检查 ────────────────────────────
{
  const N = 32;
  const M = 100;
  const t0 = performance.now();
  const errors = [];
  await Promise.all(Array.from({ length: N }, async (_, i) => {
    const sid = `par-${i}`;
    const arr = [];
    for (let j = 0; j < M; j++) {
      arr.push({ role: 'user', content: `sess${i}-msg${j}` });
      try { await sessionPlugin.saveHistory(sid, arr); } catch (e) { errors.push(`${sid}:${e.message}`); break; }
    }
  }));
  const ms = performance.now() - t0;

  let crossTalk = 0;
  for (let i = 0; i < N; i++) {
    const got = await sessionPlugin.loadSession(`par-${i}`);
    if (!got.length) { crossTalk++; continue; }
    const last = got[got.length - 1].content || '';
    if (!last.startsWith(`sess${i}-`)) crossTalk++;
  }

  bench.record({ id: 'L3-06', scene: `${N} 会话 × ${M} 次并行追加`, metric: '写入错误数', value: errors.length, unit: 'count', kind: 'H', limit: 0, cmp: '==', note: errors.slice(0, 2).join(' / ') || undefined });
  bench.record({ id: 'L3-06b', scene: `${N} 会话并行写`, metric: '串话会话数', value: crossTalk, unit: 'count', kind: 'H', limit: 0, cmp: '==' });
  bench.record({ id: 'L3-06c', scene: `${N} 会话 × ${M} 次并行追加`, metric: '总耗时', value: ms, unit: 'ms', kind: 'R' });
}

bench.finish();
