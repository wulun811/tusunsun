/**
 * R2 权属接点探针（v0.15.4）—— 对专家《v0.15.3 内核与 Hook 架构独立审查》四条 Hook 反例
 * 与 X04 的**逐条回应**。
 *
 * 为什么另写一份而不是改专家的脚本：专家脚本是他们的证据，动它等于篡改证物。
 * 这里保留他们那四个反例的**原样场景**，只在必要处补上"要声明 owner 才能撤销"这一步，
 * 并把差异写在条目名里（`/a` 是原样，`/b` 是补上 owner 后的合法正例）。
 *
 * 三条结论（跑完自行对照）：
 *   1. HOOK-R01 / H-03 / H-04 与 X04/a：原样场景直接转 FIXED；
 *   2. HOOK-R02：**原样**仍 BROKEN —— 因为它从未声明 owner（`c.use('inbound', fn)`
 *      之后调用 `offByOwner('pipeline-demo')`）。按专家自己的建议（§6「保持原
 *      `use(stage, fn)` 语义兼容；动态扩展必须使用 owner」），补上 owner 后即 FIXED；
 *      不补而要求"按名字删裸函数"，就是 §5.4 明令禁止的粗放清场。
 *   3. 兼容边界：无 owner 的旧式 `use(fn)` 仍会执行，且**不会**被任何 `offByOwner` 误删。
 *
 * 用法：`node test/probes/r2-hook-ownership.mjs [package根目录]`
 * 退出码：0 = 本探针全部合同成立；1 = 仍有 BROKEN；2 = 探针自身出错。
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = process.argv[2] ? resolve(process.argv[2]) : resolve(HERE, '../..');
const ROOT = mkdtempSync(join(tmpdir(), 'r2-hook-'));

const results = [];
const probe = async (id, title, fn) => {
  try {
    const r = await fn();
    results.push({ id, title, status: r.ok ? 'FIXED' : 'BROKEN', detail: r.detail });
  } catch (e) {
    results.push({ id, title, status: 'PROBE-ERROR', detail: String(e?.stack || e) });
  }
};

const imp = (rel) => import(pathToFileURL(join(PKG, rel)).href);
const { Core, createRuntime } = await imp('src/core/core.js');

let coreSeq = 0;
const create = () => {
  const dir = join(ROOT, `c${++coreSeq}`);
  const core = new Core({ stateDir: dir });
  core.log = () => {};
  core._stopAssemblyDrainMs = 20;
  return core;
};

/** 带宿主控制面的运行时：跨 owner 接管只能经它发起。 */
const createWithHost = () => {
  const dir = join(ROOT, `ch${++coreSeq}`);
  const { core, host } = createRuntime({ stateDir: dir });
  core.log = () => {};
  core._stopAssemblyDrainMs = 20;
  return { core, host };
};

// ── H-01：订阅归属按单次注册 ───────────────────────────────────────────
await probe('R2-H01/a', '同回调、不同 owner（专家 HOOK-R01 原样）：释放 A 不得删掉 B', async () => {
  const c = create();
  let beta = 0;
  const reused = () => { beta++; };
  c.on('a.event', reused, { owner: 'owner-A' });
  c.on('b.event', reused, { owner: 'owner-B' });
  c.offByOwner('owner-A');
  c.emit('b.event', { sourcePlugin: 'probe' });
  const count = c.listenerCount('b.event');
  return { ok: beta === 1 && count === 1, detail: `ownerB_calls=${beta} listenerCount=${count}` };
});

await probe('R2-H01/b', '同回调、同事件、两个 owner：只去掉一条', async () => {
  const c = create();
  let n = 0;
  const fn = () => { n++; };
  c.on('c.event', fn, { owner: 'owner-A' });
  c.on('c.event', fn, { owner: 'owner-B' });
  const removed = c.offByOwner('owner-A');
  c.emit('c.event', { sourcePlugin: 'probe' });
  return { ok: removed === 1 && n === 1 && c.listenerCount('c.event') === 1, detail: `removed=${removed} calls=${n}` };
});

await probe('R2-H01/c', '【正例】一个 owner 的多条订阅：清理数 = 实际删除数 = listenerCount 差值', async () => {
  const c = create();
  const f1 = () => {};
  const f2 = () => {};
  c.on('g.1', f1, { owner: 'owner-G' });
  c.on('g.2', f1, { owner: 'owner-G' });
  c.on('g.3', f2, { owner: 'owner-G' });
  const before = c.listenerCount('g.1') + c.listenerCount('g.2') + c.listenerCount('g.3');
  const removed = c.offByOwner('owner-G');
  const after = c.listenerCount('g.1') + c.listenerCount('g.2') + c.listenerCount('g.3');
  return { ok: before === 3 && removed === 3 && after === 0, detail: `before=${before} removed=${removed} after=${after}` };
});

// ── H-02：管道对称注销 ────────────────────────────────────────────────
await probe('R2-H02/a', '中间件带 owner（专家 HOOK-R02 补上 owner 那一步）：撤销后不得再执行', async () => {
  const c = create();
  c.use('inbound', (m) => ({ ...m, marked: true }), { owner: 'pipeline-demo' });
  const before = await c.runPipeline('inbound', { hello: 1 });
  const removed = c.offPipelineByOwner('pipeline-demo');
  const after = await c.runPipeline('inbound', { hello: 1 });
  return { ok: before.marked === true && removed === 1 && after.marked === undefined, detail: `before=${before.marked} removed=${removed} after=${after.marked}` };
});

await probe('R2-H02/b', '【正例】装配上下文里的 use() 自动归属（插件不需要记得传 owner）', async () => {
  const c = create();
  await c.runServiceTracking('ctx-owner', async () => {
    c.use('outbound', (m) => ({ ...m, ctx: 1 }));
  });
  const removed = c.offPipelineByOwner('ctx-owner');
  const after = await c.runPipeline('outbound', { a: 1 });
  return { ok: removed === 1 && after.ctx === undefined, detail: `removed=${removed} after=${after.ctx}` };
});

await probe('R2-H02/c', '【兼容边界】无 owner 的旧式 use() 仍执行，且不被无关 owner 误删', async () => {
  const c = create();
  const off = c.use('inbound', (m) => ({ ...m, legacy: true }));
  const stray = c.offPipelineByOwner('somebody-else');
  const r = await c.runPipeline('inbound', {});
  const disposed = off();
  const after = await c.runPipeline('inbound', {});
  return {
    ok: r.legacy === true && stray === 0 && disposed === true && after.legacy === undefined,
    detail: `still_active=${r.legacy} stray_removed=${stray} disposed=${disposed} after=${after.legacy}`,
  };
});

// ── H-03：已提交事实的通知隔离 ────────────────────────────────────────
await probe('R2-H03/a', 'core.ready 观察者抛错（专家 HOOK-R03 原样）：start 不得 reject', async () => {
  const c = create();
  c.on('core.ready', () => { throw new Error('probe-listener-throws'); }, { owner: 'observer' });
  let rejected = false;
  try { await c.start(); } catch { rejected = true; }
  const running = c.running;
  const diag = c.getObserverErrors().filter((e) => e.event === 'core.ready').length;
  c.offByOwner('observer');
  await c.stop();
  return { ok: rejected === false && running === true && diag === 1, detail: `start_rejected=${rejected} running=${running} diagnostics=${diag}` };
});

await probe('R2-H03/b', '【反例对照】普通事件仍然 fail-loud（没有"一律吞掉"）', async () => {
  const c = create();
  c.on('x.event', () => { throw new Error('loud'); }, { owner: 'observer' });
  let thrown = false;
  try { c.emit('x.event', { sourcePlugin: 'probe' }); } catch { thrown = true; }
  return { ok: thrown === true && c.getObserverErrors().length === 0, detail: `thrown=${thrown} diagnostics=${c.getObserverErrors().length}` };
});

// ── H-04：assembly-lock 的归属 ────────────────────────────────────────
await probe('R2-H04/a', '真实 assembly-lock（专家 HOOK-R04 原样）：四条监听有主，owner 释放能清干净', async () => {
  const c = create();
  const mod = await imp('plugins/assembly-lock.js');
  await mod.init(c);
  const names = ['core:service.conflict', 'core:plugin.conflict', 'core.ready', 'core:plugin.loaded'];
  const before = names.map((x) => c.listenerCount(x));
  const removed = c.offByOwner('assembly-lock');
  const after = names.map((x) => c.listenerCount(x));
  await mod.stop?.();
  return {
    ok: removed === 4 && after.every((x) => x === 0),
    detail: `before=${JSON.stringify(before)} after=${JSON.stringify(after)} removed=${removed}`,
  };
});

// ── X04：服务对象与归属 ──────────────────────────────────────────────
await probe('R2-X04/a', '匿名覆写已归属服务（专家 X04/a 原样）：拒绝且对象/归属都不变', async () => {
  const c = create();
  const A = { name: 'A' };
  const B = { name: 'B' };
  await c.runServiceTracking('owner-A', async () => { c.registerService('svc', A); });
  let threw = false;
  try { c.registerService('svc', B); } catch { threw = true; }
  const obj = c.getService('svc');
  const own = c.getServiceOwnership('svc');
  return {
    ok: threw === true && obj === A && own.owner === 'owner-A',
    detail: `匿名覆写=${threw ? '被拒' : '被接受'} 实际对象=${obj?.name} owner记录=${own.owner}`,
  };
});

await probe('R2-X04/b', '【正例】同一装配实例替换：允许，对象与归属一起更新', async () => {
  const c = create();
  const A1 = { name: 'A1' };
  const A2 = { name: 'A2' };
  // 合法姿势：**同一个受信装配实例**更新自己那笔登记。`runServiceTracking` 的自报 owner
  // 只用于观测，不构成授权（专家 R15-03 / 本仓 r15-03 探针的结论）。
  const inst = { name: 'owner-A' };
  const asA = (fn) => c._runAssemblyContext('owner-A', fn, c.assemblyEpoch, inst);
  await asA(async () => { c.registerService('svc', A1); });
  await asA(async () => { c.registerService('svc', A2); });
  const own = c.getServiceOwnership('svc');
  return { ok: c.getService('svc') === A2 && own.owner === 'owner-A', detail: `实际=${c.getService('svc')?.name} owner=${own.owner}` };
});

await probe('R2-X04/c', '【正例】宿主显式接管：归属变 @host 且留覆盖记录', async () => {
  // 需求不变（合法宿主接管后旧主拆不走），调用姿势变了：接管只认构造期领到的控制体。
  const { core: c, host } = createWithHost();
  const A = { name: 'A' };
  const H = { name: 'H' };
  await c.runServiceTracking('owner-A', async () => { c.registerService('svc', A); });
  await host.takeoverService('svc', H, { reason: 'bootstrap-recovery' });
  const own = c.getServiceOwnership('svc');
  // S6 裁决 A 之后，公开的按名批量入口 `releaseServicesByOwner` 已删除（ID-10）：
  // 它本身就是“猜对名字即放权”。本用例要证的性质没变 —— “旧主不再拥有这条服务、
  // 它的清理不得连带删掉已被宿主接管的那一条” —— 但入口换成生命周期清场闭包。
  // 公开的 `issueLifecycleReaper()` 已删除（专家 R15-02）：清场通道只在 Core 构造期
  // 向 `core.lifecycle` 注入一次。这里用注入的那一份验“旧主清理不连带删掉宿主接管的服务”。
  const reaper = typeof c.lifecycle?._reap === 'function' ? c.lifecycle._reap.bind(c.lifecycle) : null;
  const removed = reaper ? reaper('owner-A', null) : { services: [] };
  return {
    ok: c.getService('svc') === H && own.owner === '@host'
      && own.takeover?.previousOwner === 'owner-A'
      && (removed.services || []).length === 0
      && c.getService('svc') === H,
    detail: `owner=${own.owner} takeover_from=${own.takeover?.previousOwner} `
      + `旧主清理数=${(removed.services || []).length} 服务仍在=${c.getService('svc') === H}`,
  };
});

// ── 汇总 ─────────────────────────────────────────────────────────────
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const CORE_FILES = ['core.js', 'plugin-manager.js', 'lifecycle-manager.js', 'scene-controller.js',
  'dependency-resolver.js', 'plugin-meta.js', 'json5-loader.js', 'env.js'];
const fixed = results.filter((r) => r.status === 'FIXED').length;
const broken = results.filter((r) => r.status === 'BROKEN').length;
const errored = results.filter((r) => r.status === 'PROBE-ERROR').length;

console.log('\n══════════ R2 权属接点探针（v0.15.4）══════════\n');
for (const r of results) {
  console.log(`${r.status.padEnd(11)} ${r.id.padEnd(12)} ${r.title}`);
  console.log(`            ${r.detail}`);
}
console.log(`\n合计 ${results.length}｜FIXED ${fixed}｜BROKEN ${broken}｜PROBE-ERROR ${errored}\n`);
console.log('═══ 基线指纹（防"同一版本不同字节"）═══');
console.log(`package   ${PKG}`);
console.log(`probe     ${sha(fileURLToPath(import.meta.url))}`);
for (const f of CORE_FILES) console.log(`core/${f.padEnd(22)} ${sha(join(PKG, 'src/core', f))}`);

rmSync(ROOT, { recursive: true, force: true });
if (errored) process.exitCode = 2;
else if (broken) process.exitCode = 1;
