// L1 内核原语压测：事件总线、能力派发、服务查找。
//
// 这几个是**每个插件、每次调用**都要经过的东西，单位是纳秒。
// 注意 L1-03：`core.emit` 比 `emitFast` 多做两件事 —— `Object.freeze({...payload})` 和
// 自动补 `timestamp`（见 src/core/core.js:183）。那是**有意**的（事件不可变、时间统一），
// 这里量它，是为了让"要不要动它"有据可依，而不是凭手感优化掉。
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Bench, nsOp, nsOpAsync, parseArgs, selected } from './lib/bench.mjs';
import { Core } from '../../src/core/core.js';

const opts = parseArgs();
if (!selected(opts, 'L1')) process.exit(2);

const bench = new Bench('L1-kernel', {
  title: 'L1 内核原语：事件 / 能力 / 服务',
  notes: ['纳秒级指标，全部先跑 2000 次预热；这批数字用于**版本间比对**，不设绝对门禁。'],
});

const dir = mkdtempSync(join(tmpdir(), 'tt-stress-l1-'));
process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

const core = new Core({ stateDir: dir });
core.log = () => {};                    // 日志格式化不能进被测路径

const ITERS = opts.quick ? 5000 : 50000;

// ── L1-01 emit 无监听器 ────────────────────────────────────────
{
  const ns = nsOp(() => core.emit('bench.plain', { sourcePlugin: 'bench' }), { iters: ITERS, warmup: 2000 });
  bench.record({ id: 'L1-01', scene: 'emit · 无监听器', metric: '单次', value: ns, unit: 'ns', kind: 'R' });
}

// ── L1-02 emit 10 监听器扇出 ───────────────────────────────────
{
  const hits = { n: 0 };
  for (let i = 0; i < 10; i++) core.on('bench.fanout', () => { hits.n++; });
  const ns = nsOp(() => core.emit('bench.fanout', { sourcePlugin: 'bench' }), { iters: ITERS, warmup: 2000 });
  bench.record({ id: 'L1-02', scene: 'emit · 10 监听器扇出', metric: '单次（含 10 次回调）', value: ns, unit: 'ns', kind: 'R' });
  const perListener = ns / 10;
  bench.record({ id: 'L1-02b', scene: 'emit · 摊到每个监听器', metric: '单次回调', value: perListener, unit: 'ns', kind: 'R' });
  if (hits.n === 0) bench.fail('L1-02c', 'emit 扇出', '监听器一次都没被调用');
}

// ── L1-03 emitFast ───────────────────────────────────────────
{
  for (let i = 0; i < 10; i++) core.on('bench.fast', () => {});
  const nsFast = nsOp(() => core.emitFast('bench.fast', { sourcePlugin: 'bench' }), { iters: ITERS, warmup: 2000 });
  const nsFull = nsOp(() => core.emit('bench.fast', { sourcePlugin: 'bench' }), { iters: ITERS, warmup: 2000 });
  bench.record({ id: 'L1-03', scene: 'emitFast · 10 监听器', metric: '单次', value: nsFast, unit: 'ns', kind: 'R' });
  bench.record({ id: 'L1-03b', scene: 'emit vs emitFast（同一事件）', metric: '慢多少倍', value: nsFull / nsFast, unit: '×', kind: 'R' });
}

// ── L1-04 能力派发 ───────────────────────────────────────────
{
  core.registerCapability('bench.echo', {
    description: 'bench',
    owner: 'bench',
    handler: (p) => ({ ok: true, p }),
  });
  // 先量一遍 await 自身的底噪：不扣掉它，微秒级指标会全是 Promise 的开销
  const nsBaseline = await nsOpAsync(() => Promise.resolve(), { iters: 20000, warmup: 2000 });
  const nsCall = await nsOpAsync(() => core.callCapability('bench.echo', { x: 1 }), { iters: 20000, warmup: 2000 });
  bench.record({ id: 'L1-04', scene: 'callCapability · 已注册能力', metric: '单次（含 await 底噪）', value: nsCall, unit: 'ns', kind: 'R' });
  bench.record({ id: 'L1-04b', scene: 'await 底噪（同法测得）', metric: '单次', value: nsBaseline, unit: 'ns', kind: 'R' });
  bench.record({ id: 'L1-04c', scene: 'callCapability · 扣底噪', metric: '净开销', value: nsCall - nsBaseline, unit: 'ns', kind: 'R' });
}

// ── L1-05 服务查找 ───────────────────────────────────────────
{
  core.registerService('bench', { hi: () => 1 });
  const ns = nsOp(() => core.getService('bench'), { iters: ITERS, warmup: 2000 });
  bench.record({ id: 'L1-05', scene: 'getService · 命中', metric: '单次', value: ns, unit: 'ns', kind: 'R' });
  const nsMiss = nsOp(() => core.getService('nope'), { iters: ITERS, warmup: 2000 });
  bench.record({ id: 'L1-05b', scene: 'getService · 未命中', metric: '单次', value: nsMiss, unit: 'ns', kind: 'R' });
}

// ── L1-06 监听器注册/注销不泄漏（硬门禁）──────────────────────
{
  const ROUNDS = 2000;
  const BEFORE = core.listenerCount('bench.leak');
  for (let i = 0; i < ROUNDS; i++) {
    core.on('bench.leak', () => {}, { owner: 'leaky-plugin' });
  }
  const peak = core.listenerCount('bench.leak');
  const cleaned = core.offByOwner('leaky-plugin');
  const after = core.listenerCount('bench.leak');

  bench.record({ id: 'L1-06', scene: `注册 ${ROUNDS} 次后按 owner 注销`, metric: '残留监听器', value: after - BEFORE, unit: 'count', kind: 'H', limit: 0, cmp: '==' });
  bench.record({ id: 'L1-06b', scene: '注销返回的清理条数', metric: '条数', value: cleaned, unit: 'count', kind: 'H', limit: ROUNDS, cmp: '==' });
  bench.record({ id: 'L1-06c', scene: '注册峰值', metric: '监听器数', value: peak, unit: 'count', kind: 'R' });

  // EventEmitter 的默认上限是 10：超过会打 process 警告。内核自己也不该触发它
  const warn = [];
  const origWarn = process.emitWarning;
  process.emitWarning = (w) => { warn.push(String(w)); };
  for (let i = 0; i < 50; i++) core.on('bench.warn', () => {});
  core.emit('bench.warn', { sourcePlugin: 'bench' });
  process.emitWarning = origWarn;
  bench.record({ id: 'L1-06d', scene: '50 监听器时是否触发 MaxListeners 警告', metric: '警告数', value: warn.length, unit: 'count', kind: 'R' });
}

bench.finish();
