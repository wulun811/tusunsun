/**
 * R2.5 事实通知与注册身份探针（v0.15.5）—— 对专家《v0.15.4 综合独立复审》§3 六条新反例
 * （H154-01 ~ H154-06）的**逐条复现与回应**。
 *
 * 为什么另写一份而不是改专家的脚本：专家脚本是他们的证据，动它等于篡改证物。
 * 这里按报告 §3 表格的**逐条文字**重建等价场景（诊断路径不同、判据相同），
 * 条目名沿用他们的编号，方便逐行对照。
 *
 * 六条缺陷的共同性质（专家 §0 的判词）：都不是"缺功能"，而是**同一个事实有两个答案**：
 *   · H154-06 已提交的装载结果被一个旁观者抛错倒写成失败；
 *   · H154-04 异步旁观者的拒绝逸出到进程级（诊断数为 0）；
 *   · H154-05 浅冻结让第一个旁观者改掉后来者看到的"事实"；
 *   · H154-01/02/03 按函数名而不是按**那一次注册**撤销，于是删掉了别人的器官。
 *
 * 三条正例（H154-G1~G3）是反向锁：修法不能变成"一律吞错""一律不准匿名注册"。
 *
 * 用法：`node test/probes/r25-fact-and-entry-identity.mjs [package根目录]`
 * 退出码：0 = 全部合同成立；1 = 仍有 BROKEN；2 = 探针自身出错。
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = process.argv[2] ? resolve(process.argv[2]) : resolve(HERE, '../..');
const ROOT = mkdtempSync(join(tmpdir(), 'r25-probe-'));

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
const { Core } = await imp('src/core/core.js');

let coreSeq = 0;
const create = () => {
  const dir = join(ROOT, `c${++coreSeq}`);
  const core = new Core({ stateDir: dir });
  core.log = () => {};
  core._stopAssemblyDrainMs = 20;
  return core;
};

/** 等待"下一轮"：同步观察者之后才发生的异步拒绝必须有机会落地。 */
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// ── 正例（防止修法变成"一律吞错 / 一律禁止匿名"）─────────────────────
await probe('H154-G1', '【正例】普通 emit 仍然 fail-loud：观察者异常必须抛回调用方', async () => {
  const c = create();
  c.on('plain.event', () => { throw new Error('plain-boom'); });
  let threw = false;
  try { c.emit('plain.event', { sourcePlugin: 'probe' }); }
  catch (e) { threw = e.message === 'plain-boom'; }
  return { ok: threw, detail: `emit_threw=${threw}（这条不许被 emitFact 的修法吃掉）` };
});

await probe('H154-G2', '【正例】真实装载失败仍然必须报失败（不得因为通知隔离而说成成功）', async () => {
  const c = create();
  const bad = { name: 'bad-init', version: '1.0.0', async init() { throw new Error('init-boom'); } };
  let code = null;
  await c.lifecycle.load(bad, c).catch((e) => { code = e.message; });
  return {
    // 状态词只能是 7 个真实状态之一；失败后**卸载清理**会把它推进到 unloaded，
    // 所以判据是"不 running、未登记、错误原因原样"—— 而不是钉死某个中间态。
    ok: code === 'init-boom' && bad.state !== 'running' && !c.plugins.has('bad-init'),
    detail: `rejected_with=${code} state=${bad.state} registered=${c.plugins.has('bad-init')}`,
  };
});

await probe('H154-G3', '【正例】匿名中间件仍按旧语义执行，且不被任何 offByOwner 误删', async () => {
  const c = create();
  let calls = 0;
  c.use('inbound', (m) => { calls++; return m; });          // 旧式：不声明 owner
  c.offByOwner('pipeline-demo');                             // 与它无关的 owner
  await c.runPipeline('inbound', { v: 1 });
  return { ok: calls === 1, detail: `anon_calls=${calls}（兼容边界：匿名注册不属于任何 owner）` };
});

// ── H154-06：已提交事实被旁观者倒写成失败 ────────────────────────────
await probe('H154-06', 'core:plugin.loaded 观察者同步抛错：装载必须仍为成功，错误进诊断', async () => {
  const c = create();
  const p = { name: 'obs-load', version: '1.0.0', async init() {}, async start() {}, async stop() {} };
  c.on('core:plugin.loaded', () => { throw new Error('observer-boom'); });
  let rejected = null;
  let result = null;
  try { result = await c.lifecycle.load(p, c); } catch (e) { rejected = e?.message || String(e); }
  const errors = c.getObserverErrors();
  const running = p.state === 'running';
  const registered = c.plugins.get('obs-load') === p;
  return {
    ok: rejected === null && result?.ok === true && running && registered
      && errors.length === 1 && errors[0].message === 'observer-boom',
    detail: `load_rejected=${rejected} ok=${result?.ok} state=${p.state} registered=${registered} `
      + `observerErrors=${errors.length}`,
  };
});

// ── H154-04：异步观察者的拒绝逸出 ────────────────────────────────────
await probe('H154-04', 'emitFact 的 async 观察者 reject：不得产生 unhandledRejection，诊断必须记到', async () => {
  const c = create();
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e?.message || String(e));
  process.on('unhandledRejection', onUnhandled);
  try {
    c.on('fact.async', async () => { throw new Error('async-boom'); });
    const r = c.emitFact('fact.async', { sourcePlugin: 'probe' });
    await settle(50);
    const errors = c.getObserverErrors();
    return {
      ok: r.delivered === 1 && unhandled.length === 0 && errors.length === 1
        && errors[0].phase === 'async' && errors[0].message === 'async-boom',
      detail: `delivered=${r.delivered} unhandledRejection=${unhandled.length} `
        + `observerErrors=${errors.length} phase=${errors[0]?.phase}（修前 unhandled=1、诊断=0）`,
    };
  } finally { process.off('unhandledRejection', onUnhandled); }
});

// ── H154-05：事实载荷被第一个观察者改写 ──────────────────────────────
await probe('H154-05', '观察者改嵌套载荷：后续观察者与原始事实都不得看见', async () => {
  const c = create();
  const source = { requiredFailed: ['a'], nested: { deep: 1 }, sourcePlugin: 'probe' };
  const seenByB = [];
  c.on('fact.snapshot', (p) => {
    // 严格模式下改冻结对象会抛 —— 两种失败形态都算"事实没被改写"
    try { p.nested.deep = 999; } catch { /* frozen */ }
    try { p.requiredFailed.push('b'); } catch { /* frozen */ }
  }, { owner: 'owner-A' });
  c.on('fact.snapshot', (p) => { seenByB.push({ deep: p.nested.deep, len: p.requiredFailed.length }); }, { owner: 'owner-B' });
  const r = c.emitFact('fact.snapshot', source);
  const b = seenByB[0] || {};
  return {
    ok: b.deep === 1 && b.len === 1 && source.nested.deep === 1 && source.requiredFailed.length === 1,
    detail: `B_seen={deep:${b.deep},requiredFailed:${b.len}} source={deep:${source.nested.deep},len:${source.requiredFailed.length}} `
      + `delivered=${r.delivered} events=${c.getObserverErrors().length}`,
  };
});

// ── H154-01：订阅按函数名撤销，删错那一条 ────────────────────────────
await probe('H154-01', '同回调双 owner + 中间插一条：释放 A 后次序必须是 [C, fn]', async () => {
  const c = create();
  const order = [];
  const fn = () => order.push('fn');
  const mid = () => order.push('mid');
  c.on('evt.order', fn, { owner: 'owner-A' });
  c.on('evt.order', mid, { owner: 'owner-C' });
  c.on('evt.order', fn, { owner: 'owner-B' });
  c.offByOwner('owner-A');
  c.emitFast('evt.order', { sourcePlugin: 'probe' });
  return {
    ok: order.join(',') === 'mid,fn',
    detail: `order=[${order.join(',')}]（期望 [mid,fn]；修前是 [fn,mid]）`,
  };
});

// ── H154-02：管道按 lastIndexOf 删除，与账本指向不同一条 ──────────────
await probe('H154-02', '管道同回调双 owner + 中间插一条：按 owner A 删除后次序必须是 [C, fn]', async () => {
  const c = create();
  const order = [];
  const fn = (m) => { order.push('fn'); return m; };
  const mid = (m) => { order.push('mid'); return m; };
  c.use('inbound', fn, { owner: 'owner-A' });
  c.use('inbound', mid, { owner: 'owner-C' });
  c.use('inbound', fn, { owner: 'owner-B' });
  c.offPipelineByOwner('owner-A');
  await c.runPipeline('inbound', { v: 1 });
  return {
    ok: order.join(',') === 'mid,fn',
    detail: `order=[${order.join(',')}]（期望 [mid,fn]）`,
  };
});

// ── H154-03：disposer 拆掉别人的器官 ─────────────────────────────────
await probe('H154-03', 'A 的 use() disposer 只能撤销 A 那一次注册（与 C 夹在中间时次序可辨）', async () => {
  const c = create();
  const order = [];
  const fn = (m) => { order.push('fn'); return m; };
  const mid = (m) => { order.push('mid'); return m; };
  const dispA = c.use('inbound', fn, { owner: 'owner-A' });
  c.use('inbound', mid, { owner: 'owner-C' });
  c.use('inbound', fn, { owner: 'owner-B' });
  dispA();
  const leftA = c._pipelineOwners.get('owner-A')?.length ?? 0;
  const leftB = c._pipelineOwners.get('owner-B')?.length ?? 0;
  await c.runPipeline('inbound', { v: 1 });
  return {
    ok: leftA === 0 && leftB === 1 && order.join(',') === 'mid,fn',
    detail: `order=[${order.join(',')}] A_账=${leftA} B_账=${leftB}（期望 [mid,fn]；`
      + '修前 disposer 走 lastIndexOf 删掉了 B 那条、只剩 A 那条 → [fn,mid]）',
  };
});

// ── 汇总 ─────────────────────────────────────────────────────────────
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const CORE_FILES = ['core.js', 'plugin-manager.js', 'lifecycle-manager.js', 'scene-controller.js',
  'dependency-resolver.js', 'plugin-meta.js', 'json5-loader.js', 'env.js'];
const fixed = results.filter((r) => r.status === 'FIXED').length;
const broken = results.filter((r) => r.status === 'BROKEN').length;
const errored = results.filter((r) => r.status === 'PROBE-ERROR').length;

console.log('\n══════════ R2.5 事实通知与注册身份探针（v0.15.5）══════════\n');
for (const r of results) {
  console.log(`${r.status.padEnd(11)} ${r.id.padEnd(11)} ${r.title}`);
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
