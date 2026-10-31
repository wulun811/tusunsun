#!/usr/bin/env node
// rc.35 —— 把专家 rc.34 裁决给的 R34-A（无执行器纯对话 Cell 永远关不完）做成随包可跑的探针。
//
// 与专家原件的关系：他给的是 `rc34-pure-chat-close-repro.mjs`（在 rc.34 上 exit 1 / 修复后
// exit 0）。这里保留他**要证明的那件事**，并补上三组他没测、但「把 gate 义务从"有没有
// dropGate"改成"还数不数得到残留"」必须同时成立的边界 —— 否则修法会退化成「一律算清」：
//
//   G1 纯对话、无执行器：close 必须真完成，重试 already，只发一次 cell.closed，无残留锁；
//   G2 半装配（dispatch 钩子被拒）：不许留下无主钩子，close 仍必须能完成；
//   G3 有执行器：门先真在（pre/dispatch/租约都可核），关闭后必须确证为零；
//   G4 在飞强制关闭：门与锁都留着、不发 cell.closed，静默后重试才真闭合。
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

const tmp = () => mkdtempSync(join(tmpdir(), 'rc35-probe-'));

const spec = (workspace, over = {}) => ({
  schema_version: 'tusunsun.cell/v0', cell_id: 'c1', workspace,
  capabilities: ['tool.read'], permission_mode: 'auto',
  runtime: { kind: 'process' }, limits: { max_active_tasks: 1, max_children: 0 }, ...over,
});
const taskOf = (id, required = []) => ({
  schema_version: 'tusunsun.task/v0', task_id: id, attempt: 1, target_cell_id: 'c1',
  goal: `goal ${id}`, inputs: [], required_capabilities: required,
  budget: { max_steps: 3, wall_ms: 10000 }, acceptance: { required_artifacts: [], checks: [] },
});
const lockOf = (base) => join(base, 'state', 'cells', 'owner.lock');

/** 真装配；`executor` 取 'none' | 'ok' | 'broken'（broken = dispatch 钩子一装就抛）。 */
async function host(base, { executor = 'ok', chat } = {}) {
  const { Core } = await imp('src/core/core.js');
  const ws = join(base, 'ws');
  mkdirSync(ws, { recursive: true });
  const core = new Core({ stateDir: join(base, 'state') });
  core.log = () => {};
  core.setData('agent.workDir', ws);
  await (await imp('plugins/workspace.js')).default.init(core);
  core.registerCapability('tool.read', { owner: 'probe', handler: async () => ({ ok: true }) });
  core.registerCapability('chat.handle', { owner: 'probe', handler: chat || (async () => ({ reply: 'hi' })) });
  const Cls = (await imp('plugins/tool-executor.js')).default.constructor;
  const Broken = class extends Cls {
    registerDispatchHook() { throw Object.assign(new Error('dispatch hook refused'), { code: 'boom' }); }
  };
  let exec = null;
  if (executor === 'ok') { exec = new Cls(); await exec.init(core); }
  if (executor === 'broken') { exec = new Broken(); core.registerService('tool-executor', exec); }
  await (await imp('plugins/cell-runtime.js')).default.init(core);
  const svc = core.getService('cell-runtime');
  const events = { closed: 0, closing: 0 };
  core.on('cell.closed', () => { events.closed++; });
  core.on('cell.closing', () => { events.closing++; });
  return {
    core, svc, events, ws,
    create: (over = {}) => svc.create(spec(ws, over), { trusted: true }),
    hooks: () => (exec ? exec.hookCountFor('cell:c1') : { pre: 0, dispatch: 0, post: 0 }),
    gate: () => svc.describe('c1').capability_gate,
  };
}

/** G1：专家主反例 —— 没有执行器，仍然必须能真的关完。 */
async function g1() {
  const base = tmp();
  try {
    const h = await host(base, { executor: 'none' });
    await h.create({ capabilities: [] });
    h.svc.accept('c1', taskOf('chat-A'));
    const ran = await h.svc.execute('c1');
    const once = await h.svc.close('c1');
    const twice = await h.svc.close('c1');
    const ok = ran.task_id === 'chat-A'
      && once.execution_revoked === true && once.cleanup_done === true && once.closed === true
      && Array.isArray(once.cleanup_pending) && once.cleanup_pending.length === 0
      && twice.already === true && twice.closed === true
      && h.events.closed === 1 && existsSync(lockOf(base)) === false;
    record('G1 纯对话无执行器', ok,
      `closed=${once.closed} cleanup_done=${once.cleanup_done} pending=${JSON.stringify(once.cleanup_pending)} `
      + `already=${twice.already} closedEvents=${h.events.closed} lockLeft=${existsSync(lockOf(base))}`);
    return ok;
  } finally { rmSync(base, { recursive: true, force: true }); }
}

/** G2：半装配不得留下无主钩子，且 close 仍必须能完成（没有门可拆 ≠ 清理未完成）。 */
async function g2() {
  const a = tmp();
  const b = tmp();
  try {
    let orphan = null;
    const ha = await host(a, { executor: 'broken' });
    try { await ha.create(); } catch { /* 前提：create 必须失败 */ }
    const c = ha.hooks();
    orphan = c.pre + c.dispatch + c.post;
    const leftHalf = ha.svc.list().length;
    rmSync(a, { recursive: true, force: true });

    const hb = await host(b, { executor: 'none' });
    await hb.create({ capabilities: [] });
    hb.svc.accept('c1', taskOf('chat-A'));
    await hb.svc.execute('c1');
    const closes = await hb.svc.close('c1');
    const ok = orphan === 0 && leftHalf === 0
      && closes.closed === true && closes.cleanup_done === true;
    record('G2 半装配不留残留', ok,
      `orphanHooks=${orphan} halfCells=${leftHalf} closedAfterEmptyGate=${closes.closed}`);
    return ok;
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
}

/** G3：门真在 → 关闭后钩子与租约都必须确证为零（不许「调过 dropGate 就算」）。 */
async function g3() {
  const base = tmp();
  try {
    const h = await host(base, { executor: 'ok' });
    await h.create();
    const before = h.gate();
    h.svc.accept('c1', taskOf('A', ['tool.read']));
    await h.svc.execute('c1');
    const closed = await h.svc.close('c1');
    const after = h.gate();
    const liveBefore = before.installed === true && before.live === true
      && before.pre >= 1 && before.dispatch >= 1 && before.lease_live === true;
    const deadAfter = after.pre + after.dispatch + after.post === 0 && after.lease_live === false;
    const ok = liveBefore && deadAfter && closed.closed === true;
    record('G3 有执行器确证拆除', ok,
      `before(pre=${before.pre},dispatch=${before.dispatch},lease=${before.lease_live}) `
      + `after(pre=${after.pre},dispatch=${after.dispatch},lease=${after.lease_live}) closed=${closed.closed}`);
    return ok;
  } finally { rmSync(base, { recursive: true, force: true }); }
}

/** G4：在飞强制关闭 —— 门与锁留着，静默后重试才真闭合（旧链不得成为无门裸奔）。 */
async function g4() {
  const base = tmp();
  let release = () => {};
  let began = () => {};
  try {
    const hold = new Promise((r) => { release = r; });
    const started = new Promise((r) => { began = r; });
    const h = await host(base, {
      executor: 'ok',
      chat: async () => { began(); await hold; return { reply: 'done' }; },
    });
    await h.create();
    h.svc.accept('c1', taskOf('A', ['tool.read']));
    const running = h.svc.execute('c1').catch((e) => ({ code: e?.code }));
    await started;
    const inflight = await h.svc.close('c1', { force: true, quiesceMs: 20 });
    const mid = h.gate();
    const lockAtMid = existsSync(lockOf(base));   // 必须在 release 之前取：之后的读数是重试的结论
    const heldSafe = inflight.closed === false && inflight.closing === true
      && inflight.execution_revoked === true
      && Array.isArray(inflight.cleanup_pending) && inflight.cleanup_pending.includes('gate')
      && mid.pre >= 1 && mid.lease_live === true && lockAtMid === true
      && h.events.closed === 0 && h.events.closing >= 1;
    release();
    await running;
    const retried = await h.svc.close('c1');
    const end = h.gate();
    const settled = retried.closed === true && end.pre + end.dispatch === 0
      && end.lease_live === false && h.events.closed === 1 && existsSync(lockOf(base)) === false;
    record('G4 在飞强制关闭', heldSafe && settled,
      `inflight(closed=${inflight.closed},closing=${inflight.closing},pending=${JSON.stringify(inflight.cleanup_pending)},`
      + `hooks=${mid.pre},lease=${mid.lease_live},lock=${lockAtMid}) `
      + `retry(closed=${retried.closed},hooks=${end.pre + end.dispatch},lease=${end.lease_live})`);
    return heldSafe && settled;
  } finally {
    release();
    rmSync(base, { recursive: true, force: true });
  }
}

let exitCode = 0;
try {
  await imp('src/core/core.js');
} catch (err) {
  console.log(`[NOT_RUN] 本形态缺 src/core：${err.code || err.message}`);
  process.exit(3);
}
console.log('专家 rc.34 裁决 R34-A（无执行器纯对话 Cell 关不完）的本包探针：');
const all = [];
for (const fn of [g1, g2, g3, g4]) {
  try { all.push(await fn()); }
  catch (err) {
    record(fn.name, false, `探针自身出错：${err?.code || err?.message}`);
    all.push(false);
  }
}
const passed = all.filter(Boolean).length;
console.log(`\n四组：${passed}/${all.length} 成立`);
if (passed !== all.length) exitCode = 1;
process.exit(exitCode);
