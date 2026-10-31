#!/usr/bin/env node
// rc.36 —— 把专家 rc.35 裁决的唯一新缺陷 R35-P2-A（并发 close 重复发布完成事实）做成随包探针。
//
// 与专家原件的关系：他给的是 `rc35-concurrent-close-repro.mjs`（rc.35 上两种形态都实测到
// `events:2` + 两条 `already:false`）。这里保留他要证明的那件事，并补上「修成单飞之后
// 最容易退化的三个方向」——否则修法会退化成「一律合并成一个 Promise」或「一律 already」：
//
//   G1 无执行器、两条并发：cell.closed 恰 1 次，一真 already，close_id 一致；
//   G2 有执行器、两条并发：同上，且钩子/租约**确证**为零（不是「调过 dropGate 就算」）；
//   G3 close 与 force close 交错：非 force 在飞被拒（不是被排队吞），force 穿过且不早发
//      cell.closed，静默后重试才真闭合，整轮仍只一次事件；
//   G4 落盘 EIO 后并发重试：失败链不卡死，重试接着做完，事件仍只一次。
//
// 退出码：0 = 四组都成立；1 = 有反例仍成立；3 = 本形态跑不了（缺 core 等）。
// 发布门禁会自动发现它（`scripts/release-gate.mjs` 扫描 `test/probes/*.mjs`）。
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(join(ROOT, rel));

const results = [];
const record = (id, pass, detail) => {
  results.push({ id, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'} ${id}  ${detail}`);
};

const tmp = () => mkdtempSync(join(tmpdir(), 'rc36-probe-'));
const lockOf = (base) => join(base, 'state', 'cells', 'owner.lock');

const spec = (workspace, over = {}) => ({
  schema_version: 'tusunsun.cell/v0', cell_id: 'c1', workspace,
  capabilities: ['tool.read'], permission_mode: 'auto',
  runtime: { kind: 'process' }, limits: { max_active_tasks: 1, max_children: 0 }, ...over,
});
const taskOf = (id) => ({
  schema_version: 'tusunsun.task/v0', task_id: id, attempt: 1, target_cell_id: 'c1',
  goal: `goal ${id}`, inputs: [], required_capabilities: [],
  budget: { max_steps: 3, wall_ms: 10000 }, acceptance: { required_artifacts: [], checks: [] },
});

async function host(base, { executor = 'ok', chat } = {}) {
  const { Core } = await imp('src/core/core.js');
  const wsDir = join(base, 'ws');
  mkdirSync(wsDir, { recursive: true });
  const core = new Core({ stateDir: join(base, 'state') });
  core.log = () => {};
  core.setData('agent.workDir', wsDir);
  await (await imp('plugins/workspace.js')).default.init(core);
  core.registerCapability('chat.handle', { owner: 'probe', handler: chat || (async () => ({ reply: 'ok' })) });
  core.registerCapability('tool.read', { owner: 'probe', handler: async () => ({ ok: true }) });
  let exec = null;
  if (executor === 'ok') {
    const Cls = (await imp('plugins/tool-executor.js')).default.constructor;
    exec = new Cls();
    await exec.init(core);
  }
  const rt = (await imp('plugins/cell-runtime.js')).default;
  await rt.init(core);
  const events = { closed: 0, payloads: [] };
  core.on('cell.closed', (x) => { events.closed++; events.payloads.push(x); });
  const svc = core.getService('cell-runtime');
  return {
    core, exec, rt, events, svc, wsDir,
    create: (over = {}) => svc.create(spec(wsDir, over), { trusted: true }),
    hooks: () => (exec ? exec.hookCountFor('cell:c1') : null),
  };
}

const isDone = (f) => f?.closed === true && f?.already === false;

async function g1() {
  const base = tmp();
  try {
    const h = await host(base, { executor: 'none' });
    await h.create({ capabilities: [] });
    const [a, b] = await Promise.all([h.svc.close('c1'), h.svc.close('c1')]);
    const ok = h.events.closed === 1
      && [a, b].filter(isDone).length === 1
      && [a, b].filter((f) => f.already === true).length === 1
      && a.close_id && a.close_id === b.close_id
      && h.events.payloads[0]?.close_id === a.close_id
      && existsSync(lockOf(base)) === false;
    record('G1 无执行器并发 close', ok,
      `events=${h.events.closed} already=${[a.already, b.already].join('/')} lock=${existsSync(lockOf(base))} close_id=${a.close_id === b.close_id}`);
  } finally { rmSync(base, { recursive: true, force: true }); }
}

async function g2() {
  const base = tmp();
  try {
    const h = await host(base, { executor: 'ok' });
    await h.create();
    const pre = h.hooks();
    const [a, b] = await Promise.all([h.svc.close('c1'), h.svc.close('c1')]);
    const after = h.hooks();
    const live = h.exec.guardLeasesFor('cell-c1').filter((l) => l.live).length;
    const ok = pre.pre > 0 && h.events.closed === 1
      && [a, b].filter(isDone).length === 1
      && after.pre === 0 && after.dispatch === 0 && live === 0
      && existsSync(lockOf(base)) === false;
    record('G2 有执行器并发 close', ok,
      `events=${h.events.closed} gate实装=${pre.pre} 关闭后 pre=${after.pre} dispatch=${after.dispatch} lease_live=${live} lock=${existsSync(lockOf(base))}`);
  } finally { rmSync(base, { recursive: true, force: true }); }
}

async function g3() {
  const base = tmp();
  try {
    let release = null;
    const latched = new Promise((r) => { release = r; });
    const h = await host(base, { executor: 'none', chat: async () => { await latched; return { reply: 'ok' }; } });
    await h.create({ capabilities: [] });
    h.svc.accept('c1', taskOf('T-busy'));
    const inflight = h.svc.execute('c1').catch(() => {});
    await new Promise((r) => setTimeout(r, 60));
    let plain = null;
    try { plain = await h.svc.close('c1'); } catch (err) { plain = { error: err.code }; }
    const forced = await h.svc.close('c1', { force: true, quiesceMs: 150 });
    const midEvents = h.events.closed;
    release();
    await inflight;
    const after = await h.svc.close('c1', { force: true, quiesceMs: 2000 });
    const again = await h.svc.close('c1');
    const ok = plain?.error === 'cell_busy'
      && forced.execution_revoked === true && forced.closed === false && forced.closing === true
      && midEvents === 0
      && after.closed === true && again.already === true
      && h.events.closed === 1;
    record('G3 close 与 force 交错', ok,
      `在飞非force=${plain?.error} force.closed=${forced.closed} 中途events=${midEvents} 静默后closed=${after.closed} events=${h.events.closed}`);
  } finally { rmSync(base, { recursive: true, force: true }); }
}

async function g4() {
  const base = tmp();
  try {
    const h = await host(base, { executor: 'none' });
    await h.create({ capabilities: [] });
    const orig = h.rt._persist.bind(h.rt);
    let failNext = true;
    h.rt._persist = async (core, rec) => {
      if (failNext) { failNext = false; throw Object.assign(new Error('EIO: injected'), { code: 'EIO' }); }
      return orig(core, rec);
    };
    let failed = null;
    try { await h.svc.close('c1'); } catch (err) { failed = err; }
    h.rt._persist = orig;
    const midEvents = h.events.closed;
    const [a, b] = await Promise.all([h.svc.close('c1'), h.svc.close('c1')]);
    const ok = failed?.code === 'close_incomplete' && midEvents === 0
      && h.events.closed === 1 && [a, b].filter(isDone).length === 1
      && existsSync(lockOf(base)) === false;
    record('G4 EIO 后并发重试', ok,
      `首轮=${failed?.code} 首轮events=${midEvents} 重试events=${h.events.closed} 一次完成=${[a, b].filter(isDone).length} lock=${existsSync(lockOf(base))}`);
  } finally { rmSync(base, { recursive: true, force: true }); }
}

async function main() {
  try { await imp('src/core/core.js'); } catch (err) {
    console.error(`[NOT_RUN] 本形态缺 src/core/core.js：${err.code || err.message}`);
    process.exit(3);
  }
  console.log('rc.36 探针：同一 Cell 的关闭结算必须是单飞（P2-A）');
  for (const g of [g1, g2, g3, g4]) {
    try { await g(); } catch (err) {
      record(g.name, false, `抛错：${err?.code || err?.message || String(err)}`);
    }
  }
  const bad = results.filter((r) => !r.pass);
  console.log(`\n结果：${results.length - bad.length}/${results.length} 组成立`);
  if (bad.length === 0) { console.log('PASS: 关闭完成事实唯一（单飞结算成立）'); process.exit(0); }
  console.log(`FAIL: ${bad.map((r) => r.id).join('、')} 仍成立`);
  process.exit(1);
}

main();
