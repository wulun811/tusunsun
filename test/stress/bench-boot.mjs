// L0 冷启动压测：进程起来到"可服务"要多久、占多少内存。
//
// 测的是**用户能感知到的那个时刻**：从 `spawn` 到日志打出 `土行孙 ready (N plugins)`。
// 不测 `import` 单个模块 —— 那只是装配的一部分，用户不关心，也不该作为承诺。
// 每个场景取多次分位，因为首跑会额外付 OS 页缓存/动态导入缓存的成本。
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Bench, parseArgs, selected, projectRoot, summarize } from './lib/bench.mjs';
import { spawnManaged } from '../lib/proc.mjs';

const opts = parseArgs();
if (!selected(opts, 'L0')) process.exit(2);

const bench = new Bench('L0-boot', {
  title: 'L0 冷启动：装配到可服务',
  notes: ['测 spawn → `土行孙 ready` 的墙钟；RSS 取 ready 那一刻。首次运行含页缓存冷启动，故跑多次取分位。'],
});

const SCENES = [
  { id: 'L0-01', scene: 'base-system', why: '最小装配（8 插件）' },
  { id: 'L0-02', scene: 'chat', why: '对话场景' },
  { id: 'L0-03', scene: 'coding', why: '编码场景（工具全开）' },
  { id: 'L0-04', scene: 'gateway-lite', why: '轻量网关' },
];

const RUNS = opts.quick ? 3 : 5;

/** 读子进程 RSS（KB → MB）；读不到返回 NaN。 */
function childRssMB(pid) {
  try {
    const m = readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+) kB/);
    return m ? Math.round(parseInt(m[1], 10) / 1024 * 10) / 10 : NaN;
  } catch { return NaN; }
}

/** 起一次进程，等 ready 行，抓 RSS，然后整组收掉。 */
async function bootOnce(scene) {
  const stateDir = mkdtempSync(join(tmpdir(), `tt-boot-${scene}-`));
  const t0 = Number(process.hrtime.bigint());
  const child = spawnManaged(process.execPath, [
    'tusunsun.mjs', 'start', '--scene', scene, '--port', '0', '--state-dir', stateDir,
  ], { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'], label: `boot:${scene}` });

  let buf = '';
  let readyMs = NaN;
  let plugins = NaN;

  const onData = (d) => {
    buf += d.toString();
    const m = /土行孙 ready \((\d+) plugins\)/.exec(buf);
    if (m && Number.isNaN(readyMs)) {
      readyMs = (Number(process.hrtime.bigint()) - t0) / 1e6;
      plugins = parseInt(m[1], 10);
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  const deadline = Date.now() + 60000;
  while (Number.isNaN(readyMs) && Date.now() < deadline) {
    if (child.exitCode != null) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const rss = Number.isNaN(readyMs) ? NaN : childRssMB(child.pid);

  await child.reap({ graceMs: 800, killWaitMs: 1500 });
  try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* best effort */ }

  if (Number.isNaN(readyMs)) {
    throw new Error(`未等到 ready：${buf.slice(-300).replace(/\x1b\[[0-9;]*m/g, '')}`);
  }
  return { readyMs, rss, plugins };
}

for (const s of SCENES) {
  const samples = [];
  let rss = NaN;
  let plugins = NaN;
  let failure = null;
  for (let i = 0; i < RUNS; i++) {
    try {
      // 第一次是"冷"启动（页缓存未必命中），保留在样本里 —— 那正是用户第一次启动的体验
      const r = await bootOnce(s.scene);
      samples.push(r.readyMs);
      rss = r.rss;
      plugins = r.plugins;
    } catch (e) { failure = e; break; }
  }

  if (failure) {
    bench.fail(s.id, `${s.scene}（${s.why}）`, failure.message);
    continue;
  }
  const st = summarize(samples);
  bench.record({ id: s.id, scene: `${s.scene} · ${s.why}`, metric: 't_ready p50', value: st.p50, unit: 'ms', kind: 'R', note: `${plugins} 个插件` });
  bench.record({ id: `${s.id}b`, scene: `${s.scene} · p95`, metric: 't_ready p95', value: st.p95, unit: 'ms', kind: 'R' });
  bench.record({ id: `${s.id}c`, scene: `${s.scene} · 峰值 RSS`, metric: 'RSS@ready', value: rss, unit: 'MB', kind: 'R' });

  // L0-05：稳定性只看极差/中位。超过 3 倍说明测量本身不稳（或有并发干扰），数字不可信
  const spread = (st.max - st.min) / st.p50;
  bench.record({ id: `${s.id}d`, scene: `${s.scene} · 稳定性`, metric: '(max−min)/p50', value: spread, unit: '×', kind: 'R' });
}

bench.finish();
