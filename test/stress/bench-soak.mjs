// G 稳定性（soak）：跑一段时间，看内存/监听器/内部状态表有没有只涨不落。
//
// 单测里"跑 3 条消息"永远看不出泄漏 —— 泄漏的定义是**单位时间的净增长**，
// 必须跑够时间才有可能与被测代码的规模拉开差距。
//
// 判据用的是"后半段对前半段"的漂移，不是"相对进程启动"。理由：V8 堆在负载初期会
// 自然扩张一次，把它算成泄漏会让每次压测都红；而**稳态中的增长**才是泄漏。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Bench, parseArgs, selected, gcNow, rssMB, canGc, sleep } from './lib/bench.mjs';
import { buildCorpus } from './lib/corpus.mjs';
import { matchDangerousCommand, classifyIrreversible } from '../../plugins/_lib/danger-patterns.js';
import { DestructiveGate } from '../../plugins/_lib/destructive-gate.js';

const opts = parseArgs();
if (!selected(opts, 'G')) process.exit(2);

const DURATION = opts.soak ? 600 : (opts.quick ? 20 : 120);

const bench = new Bench('G-soak', {
  title: `G 稳定性：${DURATION}s 持续负载`,
  notes: [
    canGc ? '已启用 --expose-gc，采样前强制回收。' : '未启用 --expose-gc：内存数字含未回收垃圾，只看趋势不看绝对值。',
    '判据取「后半段 vs 前半段」的漂移，不取「相对启动」——启动初期的堆扩张不是泄漏。',
  ],
});

const dir = mkdtempSync(join(tmpdir(), 'tt-stress-soak-'));
process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

const ws = join(dir, 'ws');
mkdirSync(join(ws, 'd0'), { recursive: true });
for (let i = 0; i < 20; i++) writeFileSync(join(ws, `f${i}.js`), 'x');
for (let i = 0; i < 20; i++) writeFileSync(join(ws, 'd0', `g${i}.js`), 'x');

const { Core } = await import('../../src/core/core.js');
const core = new Core({ stateDir: dir });
core.log = () => {};
for (let i = 0; i < 8; i++) core.on('soak.tick', () => {});

const gate = new DestructiveGate();
const { dangerous, benign } = buildCorpus({ quick: true });
const all = [...dangerous, ...benign].map((x) => x.cmd);

// ── 采样 ────────────────────────────────────────────────────
const samples = [];
async function sample(label) {
  gcNow();
  await sleep(50);                                  // 让 finalizer/GC 收口
  samples.push({
    label,
    t: Date.now(),
    // RSS 不是泄漏的好指标：V8 把回收后的页留在 committed 里，不还给 OS，
    // 于是一次正常的堆扩张看起来就像"涨了 15MB"。强制 GC 之后的 heapUsed 才是活对象量。
    heap: Math.round(process.memoryUsage().heapUsed / 1048576 * 10) / 10,
    rss: rssMB(),
    listeners: core.listenerCount('soak.tick'),
    pending: gate._pending?.size ?? 0,
    msgCount: core.getMsgCount(),
  });
}

await sample('t0');                                  // 预热后基线
const started = Date.now();
const SAMPLE_EVERY = (DURATION * 1000) / 4;
let nextSampleAt = SAMPLE_EVERY;
let ops = 0;
let round = 0;

while (Date.now() - started < DURATION * 1000) {
  // 一轮 = 2000 次事件 + 200 次判定 + 10 次软闸 + 少量真实计数
  for (let i = 0; i < 2000; i++) core.emitFast('soak.tick', { n: i });
  for (let i = 0; i < 200; i++) {
    const c = all[(round * 200 + i) % all.length];
    matchDangerousCommand(c);
    classifyIrreversible(c);
  }
  for (let i = 0; i < 10; i++) {
    gate.check('tool-bash', { command: 'rm -rf d0' }, ws, { sessionId: `soak-${i % 4}`, mode: 'auto', enabled: true });
  }
  ops += 2210;
  round++;

  if (Date.now() - started >= nextSampleAt) {
    await sample(`t${samples.length}`);
    nextSampleAt += SAMPLE_EVERY;
  }
  await sleep(0);
}
await sample('end');

// 采样序列打出来：只看首尾会掩盖"涨-平-涨"这种锯齿，而那正是 GC 与泄漏的分界
console.log('\n  heap 序列：' + samples.map((x) => `${x.label}=${x.heap}MB`).join(' → '));
console.log('  RSS  序列：' + samples.map((x) => `${x.label}=${x.rss}MB`).join(' → '));

// ── 判定 ────────────────────────────────────────────────────
const mid = samples[Math.floor(samples.length / 2)];
const last = samples[samples.length - 1];

const heapDrift = mid.heap > 0 ? ((last.heap - mid.heap) / mid.heap) * 100 : NaN;
bench.record({
  id: 'G-01', scene: `后半段活对象漂移（${mid.label} → ${last.label}，GC 后）`, metric: '变化',
  value: heapDrift, unit: '%', kind: 'H', limit: 10, cmp: '<=',
  note: `heapUsed ${mid.heap} MB → ${last.heap} MB（${Math.round(ops / 1000)}k 次操作）`,
});

const rssDrift = mid.rss > 0 ? ((last.rss - mid.rss) / mid.rss) * 100 : NaN;
bench.record({
  id: 'G-01b', scene: '后半段 RSS 漂移（含 V8 保留页）', metric: '变化',
  value: rssDrift, unit: '%', kind: 'R',
  note: `${mid.rss} MB → ${last.rss} MB`,
});

const listenerDrift = last.listeners - samples[0].listeners;
bench.record({
  id: 'G-02', scene: '监听器数量漂移', metric: '变化', value: listenerDrift, unit: 'count',
  kind: 'H', limit: 0, cmp: '==', note: `${samples[0].listeners} → ${last.listeners}`,
});

// 软闸的 _pending：命令文本固定 1 条，理论上最多 4 个会话各一条；涨上去就是过期清理没生效
bench.record({
  id: 'G-03', scene: '软闸 _pending 表大小', metric: '条目数', value: last.pending, unit: 'count',
  kind: 'H', limit: 64, cmp: '<=',
});

bench.record({ id: 'G-04', scene: `持续 ${DURATION}s`, metric: '总操作数', value: ops, unit: 'count', kind: 'R' });
bench.record({ id: 'G-05', scene: '结束 RSS', metric: 'RSS', value: last.rss, unit: 'MB', kind: 'R' });

bench.finish();
