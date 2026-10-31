#!/usr/bin/env node
// 土行孙 rc.36 微基准：量**已经过验收的真实路径**，不掺假、不绕过任何一道门。
//
// 为什么需要这个文件：初次测性能时我报出过 `executeOne` p50 = 0.005ms（14 万次/秒），
// 那个数字是假的 —— 连错三次，每次原因都不同（见 README.md 的「三次读错」）。一个
// 基准最危险的失败不是慢，是**量到了错的那条路还把它当结论**。所以这里的每一步都带
// 前置断言：断言不成立就抛错，而不是把拒绝路径的耗时当成绩效。
//
// 运行：node verification/perf/bench.mjs
// 输出：JSON（stdout），可供 CI 或人工对账。约 3 秒。
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(join(ROOT, rel));
const now = () => Number(process.hrtime.bigint()) / 1e6;

const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const stat = (arr) => ({
  n: arr.length,
  p50_ms: +pct(arr, 0.5).toFixed(3),
  p95_ms: +pct(arr, 0.95).toFixed(3),
  max_ms: +Math.max(...arr).toFixed(3),
  ops_per_sec: Math.round(1000 / (arr.reduce((a, b) => a + b, 0) / arr.length)),
});

/**
 * 装配一个真宿主。
 *
 * `config` 壳说明：`core.get()` 委托给 config 服务，本基准不装 config 插件，
 * 于是执行器读到的限流上限恒为默认 30 次/60 秒。要量吞吐必须先把这个上限抬高 ——
 * 同时把默认值本身记进结果，因为它是**产品的一部分**，不是要绕开的障碍。
 */
async function host(base, { executor = 'ok', raiseRateLimit = false } = {}) {
  const { Core } = await imp('src/core/core.js');
  const wsDir = join(base, 'ws');
  mkdirSync(wsDir, { recursive: true });
  const core = new Core({ stateDir: join(base, 'state') });
  core.log = () => {};
  core.setData('agent.workDir', wsDir);
  if (raiseRateLimit) {
    core.registerService('config', {
      get: (path, fb) => (path === 'tools.rateLimit.maxCalls' ? 1_000_000 : fb),
    });
  }
  await (await imp('plugins/workspace.js')).default.init(core);
  let exec = null;
  if (executor === 'ok') {
    const Cls = (await imp('plugins/tool-executor.js')).default.constructor;
    exec = new Cls();
    await exec.init(core);
  }
  const rt = (await imp('plugins/cell-runtime.js')).default;
  await rt.init(core);
  return { core, exec, wsDir, svc: core.getService('cell-runtime') };
}

const specOf = (ws, over = {}) => ({
  schema_version: 'tusunsun.cell/v0', cell_id: 'c1', workspace: ws,
  capabilities: ['tool.read'], permission_mode: 'auto',
  runtime: { kind: 'process' }, limits: { max_active_tasks: 1, max_children: 0 }, ...over,
});

/**
 * 在**真任务**里跑工具派发。
 *
 * 为什么必须在任务里：门的判据是 `task_not_active` —— 任务外派发一律被拒，量到的不是
 * 门的开销。为什么逐次换文件：只读能力有 30s 结果缓存，同参数连打量到的是缓存命中
 * （而且工具参数会被 schema 过滤，塞一个不存在的 `n` 也打不散缓存键）。
 */
async function toolLoop({ taskCaps, N, handlerDoesIO }) {
  const WARMUP = 200;
  const base = mkdtempSync(join(tmpdir(), 'bench-tool-'));
  try {
    const h = await host(base, { raiseRateLimit: true });
    const FILES = WARMUP + N + 100;
    for (let i = 0; i < FILES; i++) writeFileSync(join(h.wsDir, `p${i}.txt`), 'y'.repeat(4096));
    let handlerRuns = 0;
    h.core.registerCapability('tool.read', {
      owner: 'bench',
      handler: async (args) => {
        handlerRuns++;
        if (!handlerDoesIO) return { ok: true, bytes: 4096 };
        const buf = await readFile(join(h.wsDir, args.path));
        return { ok: true, bytes: buf.length, sha: createHash('sha256').update(buf).digest('hex').slice(0, 16) };
      },
    });
    const samples = [];
    let lastShape = null;
    h.core.registerCapability('chat.handle', {
      owner: 'bench',
      handler: async () => {
        for (let i = 0; i < WARMUP; i++) await h.exec.executeOne('tool-read', { path: `p${i}.txt` }, 'cell-c1');
        for (let i = 0; i < N; i++) {
          const a = now();
          lastShape = await h.exec.executeOne('tool-read', { path: `p${WARMUP + i}.txt` }, 'cell-c1');
          samples.push(now() - a);
        }
        return { reply: 'ok' };
      },
    });
    await h.svc.create(specOf(h.wsDir), { trusted: true });
    h.svc.accept('c1', {
      schema_version: 'tusunsun.task/v0', task_id: 'T1', attempt: 1, target_cell_id: 'c1',
      goal: 'g', inputs: [], required_capabilities: taskCaps,
      budget: { max_steps: N + 500, wall_ms: 120000 }, acceptance: { required_artifacts: [], checks: [] },
    });
    const r = await h.svc.execute('c1');
    // 前置断言：每次调用都真的到了 handler，且最后一次是成功 —— 否则宁可抛错也不报数。
    // `handlerRuns` 含 WARMUP 次预热，所以比的是 samples + WARMUP，不是 samples。
    const dispatched = samples.length + WARMUP === handlerRuns;
    if (!dispatched) {
      throw new Error(`基准自检失败：${samples.length} 次调用只触发 ${handlerRuns} 次 handler `
        + `（缓存命中或限流介入），这样的数字不能当性能。last=${JSON.stringify(lastShape)?.slice(0, 200)}`);
    }
    if (lastShape?.ok !== true) {
      throw new Error(`基准自检失败：最后一次派发没有成功：${JSON.stringify(lastShape)?.slice(0, 200)}`);
    }
    // 只取后 90%：前几条带着首次 JIT 与懒加载
    const t = samples.slice(Math.floor(samples.length * 0.1));
    return { ...stat(t), exec_state: r.execution_state, handler_runs: handlerRuns, dispatched_to_handler: true };
  } finally { rmSync(base, { recursive: true, force: true }); }
}

const out = {};

// ── 1. Core 能力直调（无 Cell 门）：内核分发本身的开销 ────────────────
{
  const base = mkdtempSync(join(tmpdir(), 'bench-cap-'));
  try {
    const h = await host(base, { executor: 'none' });
    h.core.registerCapability('echo.fast', { owner: 'bench', handler: async (p) => ({ ok: true, n: p?.n }) });
    const N = 20000;
    for (let i = 0; i < 500; i++) await h.core.callCapability('echo.fast', { n: i });
    const t = [];
    for (let i = 0; i < N; i++) { const a = now(); await h.core.callCapability('echo.fast', { n: i }); t.push(now() - a); }
    out.capability_direct = stat(t);
  } finally { rmSync(base, { recursive: true, force: true }); }
}

// ── 2. 受门保护的派发：handler 近空（量门本身）────────────────────────
out.tool_gated_dispatch_only = await toolLoop({ taskCaps: ['tool.read'], N: 1500, handlerDoesIO: false });

// ── 3. 受门保护的派发：handler 真读 4KB + sha256（量端到端）────────────
out.tool_gated_with_io = await toolLoop({ taskCaps: ['tool.read'], N: 800, handlerDoesIO: true });

// ── 4. Cell 全生命周期：create + accept + execute + close ─────────────
{
  const N = 100;
  const t = [];
  for (let i = 0; i < N; i++) {
    const base = mkdtempSync(join(tmpdir(), 'bench-life-'));
    try {
      const a = now();
      const h = await host(base);
      h.core.registerCapability('chat.handle', { owner: 'bench', handler: async () => ({ reply: 'ok' }) });
      await h.svc.create(specOf(h.wsDir), { trusted: true });
      h.svc.accept('c1', {
        schema_version: 'tusunsun.task/v0', task_id: 'T1', attempt: 1, target_cell_id: 'c1',
        goal: 'g', inputs: [], required_capabilities: [],
        budget: { max_steps: 3, wall_ms: 10000 }, acceptance: { required_artifacts: [], checks: [] },
      });
      await h.svc.execute('c1');
      await h.svc.close('c1');
      t.push(now() - a);
    } finally { rmSync(base, { recursive: true, force: true }); }
  }
  out.cell_lifecycle = stat(t);
}

// ── 5. close()：单条 vs 两条并发（rc.36 单飞结算的开销）───────────────
{
  const measure = async (double) => {
    const t = [];
    for (let i = 0; i < 60; i++) {
      const b = mkdtempSync(join(tmpdir(), 'bench-close-'));
      try {
        const hh = await host(b, { executor: 'none' });
        await hh.svc.create(specOf(hh.wsDir, { capabilities: [] }), { trusted: true });
        const a = now();
        if (double) await Promise.all([hh.svc.close('c1'), hh.svc.close('c1')]);
        else await hh.svc.close('c1');
        t.push(now() - a);
      } finally { rmSync(b, { recursive: true, force: true }); }
    }
    return stat(t);
  };
  out.close_single = await measure(false);
  out.close_double_concurrent = await measure(true);
  out.close_singleflight_overhead_ms =
    +(out.close_double_concurrent.p50_ms - out.close_single.p50_ms).toFixed(3);
}

// ── 6. 事件 emit（关闭事实的对外通道）────────────────────────────────
{
  const base = mkdtempSync(join(tmpdir(), 'bench-emit-'));
  try {
    const h = await host(base, { executor: 'none' });
    let n = 0;
    h.core.on('bench.ping', () => { n++; });
    const N = 50000;
    const t = [];
    for (let i = 0; i < N; i++) { const a = now(); h.core.emit('bench.ping', { i }); t.push(now() - a); }
    out.event_emit = { ...stat(t), delivered: n === N };
  } finally { rmSync(base, { recursive: true, force: true }); }
}

out.meta = {
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  note: '单线程、进程内、tmpfs、无网络、无模型；只能横向比较，不可当 SLA',
  default_rate_limit: '30 calls / 60000 ms per (session, tool)，未抬高时的产品默认值',
};

console.log(JSON.stringify(out, null, 2));
