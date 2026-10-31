/**
 * 专家《土行孙 v0.15.2：发布前独立深审与三轮精修执行总计划 v1.0》§2 的四个
 * **跨状态机反例** X01～X04 —— 我方独立自写的复现探针（不是原文附件那份脚本）。
 *
 * 为什么自己重写一遍：原文附带的脚本没有随意见送达。若只按结论去改代码，
 * 就等于"判据看不见它的目标"——这是本项目已经犯过九次的同一种错。
 * 因此这里按意见里的**行为描述**逐条重建，跑出与专家一致的红色，再据此施工。
 *
 * 四条反例的共同形状（专家 §9）：动作有真实生命周期，但没有合法的**提交时机**、
 * 明确的**归属**与有效的**装配范围**。
 *
 *   X01 停止之后，迟到懒加载重新公布能力      （装配提交时机）
 *   X02 同名注册被拒后，未登记实例仍完成初始化（归属）
 *   X03 启动期 lazy 源索引跨场景残留          （装配范围）
 *   X04 未声明权属的服务覆写使对象与 owner 分叉（归属）
 *
 * 纪律（延续 r017）：
 *   ① 每条缺陷配**合法正例**，防"一律拒绝/一律降级"式假修复；
 *   ② 用真实 Core / PluginManager / LifecycleManager / SceneController，插件是真文件真 import；
 *   ③ 顺序用 **Promise barrier**（`gate`）控制，不用固定睡眠碰运气（专家 §6.3）；
 *   ④ 探针自身出错单独报 PROBE-ERROR（退出码 2），不计入 BROKEN；
 *   ⑤ 打印**基线指纹**（探针自身 + 8 个核心文件 sha256），防止"同一版本不同字节"。
 *
 * 用法：`node test/probes/x01-x04-cross-state-machine.mjs [package根目录]`
 * 退出码：0 = 四项均不再复现；1 = 仍有缺陷复现；2 = 探针自身出错。
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = process.argv[2] ? resolve(process.argv[2]) : resolve(HERE, '../..');

// `scene-controller` 在**模块加载时**按 `$HOME` 计算场景搜索路径 ⇒ 必须先改再 import。
const ROOT = mkdtempSync(join(tmpdir(), 'x01x04-'));
process.env.HOME = join(ROOT, 'home');
const SCENE_DIR = join(process.env.HOME, '.tusunsun', 'scenes');
mkdirSync(SCENE_DIR, { recursive: true });

const imp = (rel) => import(pathToFileURL(join(PKG, rel)).href);
const { Core } = await imp('src/core/core.js');
const { PluginManager } = await imp('src/core/plugin-manager.js');
const { SceneController } = await imp('src/core/scene-controller.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => sleep(0);

function deferred() {
  let resolveFn;
  const promise = new Promise((r) => { resolveFn = r; });
  return { promise, resolve: resolveFn };
}

async function waitFor(pred, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await sleep(1);
  }
  return pred();
}

// ── 场景与插件（真文件、真 import）──────────────────────────────────────────
// 两个**极小**场景：一个完全不声明 legacy，一个把 legacy 声明为 lazy。
writeFileSync(join(SCENE_DIR, 'empty.json5'), '{ name: "empty", eager: [], plugins: [] }\n');
writeFileSync(join(SCENE_DIR, 'with-legacy.json5'), '{ name: "with-legacy", eager: [], lazy: ["legacy"] }\n');

const PLUGIN_SRC = {
  // X01：init 卡在 barrier 上。gate 由探针在**另一个状态机转移之后**才放行，
  // 这样"停止"与"装配完成"的先后是确定的，不靠 160ms 的睡眠。
  'slow.js': `export class Slow {
  name = 'slow';
  version = '1.0.0';
  provides = ['slow.work'];
  async init(core) {
    globalThis.__x.inits += 1;
    await globalThis.__x.gate;
    if (globalThis.__x.fail) throw new Error('init-intentionally-failed');
    core.registerCapability('slow.work', { owner: 'slow', handler: () => 'slow-done' });
  }
  async stop() { globalThis.__x.stops += 1; }
}
export default new Slow();
`,
  'legacy.js': `export class Legacy {
  name = 'legacy';
  version = '1.0.0';
  provides = ['legacy.work'];
  async init(core) {
    globalThis.__x.legacyInits += 1;
    core.registerCapability('legacy.work', { owner: 'legacy', handler: () => 'legacy-done' });
  }
  async stop() {}
}
export default new Legacy();
`,
  // X02/d：文件名是 dup.js，但对象自报名字是 other —— 请求名/实现名不一致。
  'dup.js': `export class Other {
  name = 'other';
  version = '1.0.0';
  provides = ['other.work'];
  async init(core) {
    globalThis.__x.otherInits += 1;
    core.registerCapability('other.work', { owner: 'other', handler: () => 'other-done' });
  }
  async stop() {}
}
export default new Other();
`,
};

const hosts = [];
async function makeHost(opts = {}) {
  const dir = mkdtempSync(join(ROOT, 'host-'));
  const plugDir = join(dir, 'plugins');
  mkdirSync(plugDir, { recursive: true });
  for (const [f, src] of Object.entries(PLUGIN_SRC)) writeFileSync(join(plugDir, f), src);
  const gate = deferred();
  globalThis.__x = { inits: 0, stops: 0, legacyInits: 0, otherInits: 0, gate: gate.promise, fail: false };
  const core = new Core({ stateDir: dir });
  core.log = () => {};
  // 收尾窗口在探针里调小：合同不随窗口长短改变，但 800ms × 多组用例会拖慢套件。
  core._stopAssemblyDrainMs = opts.drainMs ?? 60;
  const pm = new PluginManager(core);
  pm.dirs = [plugDir];
  pm._loadTimeoutMs = opts.timeout ?? 60;
  const host = { core, pm, dir, plugDir, gate, sc: new SceneController(core, pm) };
  hosts.push(host);
  return host;
}

function cleanup() {
  for (const h of hosts) {
    try { h.pm._stopIdleTimer?.(); } catch { /* 老版本没有该方法 */ }
    try { rmSync(h.dir, { recursive: true, force: true }); } catch { /* 清理失败不影响判据 */ }
  }
  hosts.length = 0;
}

/** 调用结果：不抛 = 信封；抛了也记下来（"漏成异常"本身就是一种缺陷形状）。 */
async function callSafely(core, id, params = {}) {
  try { return { threw: false, res: await core.callCapability(id, params) }; }
  catch (e) { return { threw: true, err: e }; }
}
const codeOf = (r) => (r.threw ? `throw:${r.err?.message}` : (r.res?.ok ? 'ok' : String(r.res?.code)));

const results = [];
const probe = async (id, title, fn) => {
  try {
    const r = await fn();
    results.push({ id, title, status: r.ok ? 'FIXED' : 'BROKEN', detail: r.detail });
  } catch (err) {
    results.push({ id, title, status: 'PROBE-ERROR', detail: err.stack || err.message });
  }
};

function mkPlugin(name, tag) {
  const p = {
    name, version: '1.0.0', tag,
    async init() { globalThis.__x[`${tag}Inits`] = (globalThis.__x[`${tag}Inits`] || 0) + 1; },
    async start() {},
    async stop() {},
  };
  return p;
}

// ═══════════════════════════════════════════════════════════════════
// X01 — 停止之后，迟到懒加载重新公布能力（P0）
// ═══════════════════════════════════════════════════════════════════
await probe('X01/a', '停止后迟到 init 完成：不得变成 running，不得发布可派发的能力', async () => {
  const h = await makeHost({ timeout: 50 });
  const { core, pm } = h;
  await pm.loadAll([], ['slow']);
  await core.start();
  const call1 = callSafely(core, 'slow.work');       // 触发懒装配，卡在 init barrier
  await waitFor(() => core.plugins.has('slow'));
  const stateDuring = core.plugins.get('slow')?.state;
  const r1 = await call1;                             // 50ms 等候超时
  const attempt = pm._loading.get('slow');
  await core.stop();                                  // ← 另一个状态机转移
  const runningAfterStop = core.running;
  h.gate.resolve();                                   // ← 迟到完成
  await attempt?.catch(() => {});
  await tick();
  const lateState = core.plugins.get('slow')?.state;
  const r2 = await callSafely(core, 'slow.work');
  const ok = runningAfterStop === false
    && stateDuring === 'registered'
    && lateState !== 'running'
    && r2.res?.ok !== true
    && typeof r2.res?.code === 'string' && r2.res.code.length > 0;
  return {
    ok,
    detail: `停止前=${stateDuring} 首次调用=${codeOf(r1)} 停止后running=${runningAfterStop} `
      + `迟到后状态=${lateState} 停止后再调用=${codeOf(r2)} 真实init=${globalThis.__x.inits} `
      + `plugin.stop=${globalThis.__x.stops}`
      + `${lateState === 'running' ? ' ⇒ 【缺陷】停止后对象复活成 running' : ''}`
      + `${r2.res?.ok === true ? ' ⇒ 【缺陷】停止后仍能派发' : ''}`,
  };
});

await probe('X01/b', '停止期间装配抛错：不得留下 running 对象，也不得把失败报成成功', async () => {
  const h = await makeHost({ timeout: 50 });
  const { core, pm } = h;
  globalThis.__x.fail = true;
  await pm.loadAll([], ['slow']);
  await core.start();
  const call1 = callSafely(core, 'slow.work');
  await waitFor(() => core.plugins.has('slow'));
  const r1 = await call1;
  const attempt = pm._loading.get('slow');
  await core.stop();
  h.gate.resolve();
  let threw = null;
  try { await attempt; } catch (e) { threw = e; }
  await tick();
  const inMap = core.plugins.has('slow');
  const state = core.plugins.get('slow')?.state ?? '(已移出 plugins)';
  const ok = r1.res?.ok !== true && state !== 'running'
    && (threw !== null || inMap === false);
  return {
    ok,
    detail: `首次调用=${codeOf(r1)} 真实装载${threw ? '按预期失败' : '竟然成功'} `
      + `仍在册=${inMap} 状态=${state}${state === 'running' ? ' ⇒ 【缺陷】失败装配仍是 running' : ''}`,
  };
});

await probe('X01/c', '【正例】正常启动→懒加载完成→停止：能力可用且 plugin.stop 恰好一次', async () => {
  const h = await makeHost({ timeout: 2000 });
  const { core, pm } = h;
  await pm.loadAll([], ['slow']);
  await core.start();
  h.gate.resolve();                                   // 立刻放行，装配正常完成
  const r1 = await callSafely(core, 'slow.work');
  await core.stop();
  const state = core.plugins.get('slow')?.state;
  const ok = r1.res?.ok === true && r1.res.payload === 'slow-done'
    && globalThis.__x.stops === 1 && state === 'stopped';
  return {
    ok,
    detail: `调用=${codeOf(r1)} payload=${JSON.stringify(r1.res?.payload)} `
      + `plugin.stop次数=${globalThis.__x.stops} 停止后状态=${state}`
      + `${r1.res?.ok !== true ? ' ⇒ 【缺陷】正常懒加载被误伤' : ''}`,
  };
});

await probe('X01/d', '停止后 callCapability 与 command 都必须拒绝（不得派发到已停止的插件）', async () => {
  const h = await makeHost({ timeout: 2000 });
  const { core, pm } = h;
  await pm.loadAll([], ['slow']);
  await core.start();
  h.gate.resolve();
  await callSafely(core, 'slow.work');                // 先让它正常跑起来
  await core.stop();
  const before = globalThis.__x.stops;
  const r2 = await callSafely(core, 'slow.work');
  let cmd = null;
  try { cmd = await core.command('slow.work', {}, 300); } catch (e) { cmd = { threw: true, error: e.message }; }
  const ok = r2.res?.ok !== true && cmd?.ok !== true;
  return {
    ok,
    detail: `停止后 callCapability=${codeOf(r2)} command=${cmd?.ok ? 'ok' : (cmd?.code ?? cmd?.error)} `
      + `plugin.stop=${before}`
      + `${r2.res?.ok === true ? ' ⇒ 【缺陷】停止后 callCapability 仍派发' : ''}`
      + `${cmd?.ok === true ? ' ⇒ 【缺陷】停止后 command 仍派发' : ''}`,
  };
});

await probe('X01/e', '【正例】二次 stop 是幂等的：不抛、不重复调用 plugin.stop', async () => {
  const h = await makeHost({ timeout: 2000 });
  const { core, pm } = h;
  await pm.loadAll([], ['slow']);
  await core.start();
  h.gate.resolve();
  await callSafely(core, 'slow.work');
  await core.stop();
  let threw = null;
  try { await core.stop(); } catch (e) { threw = e; }
  const ok = threw === null && globalThis.__x.stops === 1;
  return { ok, detail: `二次 stop ${threw ? `抛出 ${threw.message}` : '未抛'} plugin.stop 次数=${globalThis.__x.stops}` };
});

// ═══════════════════════════════════════════════════════════════════
// X02 — 同名注册被拒后，未登记实例仍完成初始化（P0/P1）
// ═══════════════════════════════════════════════════════════════════
await probe('X02/a', '同名不同实例：注册被拒必须在 init 之前中止，不得报 ok:true', async () => {
  const h = await makeHost();
  const { core } = h;
  const A = mkPlugin('dup', 'a');
  const B = mkPlugin('dup', 'b');
  await core.register(A);
  A.state = 'running';                                 // 老实例确实在跑
  const r = await core.lifecycle.load(B, core).then((v) => ({ v }), (e) => ({ e }));
  const bInits = globalThis.__x.bInits || 0;
  // 两种合法收口都接受：具名拒绝（throw 且带 code）或 `{ok:false}`。
  // 不合法的是"返回 ok:true 且 B.init 跑过"—— 那才是 X02 的缺陷形状。
  const rejected = (r.e && r.e.code === 'plugin_name_conflict') || r.v?.ok === false;
  const ok = bInits === 0 && B.state !== 'running' && core.plugins.get('dup') === A && rejected;
  return {
    ok,
    detail: `load返回=${r.e ? `throw:${r.e.code}` : JSON.stringify(r.v)} B.init次数=${bInits} B.state=${B.state} `
      + `Map里仍是A=${core.plugins.get('dup') === A}`
      + `${bInits > 0 ? ' ⇒ 【缺陷】未被承认的实例仍执行了 init' : ''}`
      + `${r.v?.ok === true ? ' ⇒ 【缺陷】未登记对象被报成装载成功' : ''}`,
  };
});

await probe('X02/b', '同一实例重复 load：必须幂等或具名拒绝，不得再次 init', async () => {
  const h = await makeHost();
  const { core } = h;
  const A = mkPlugin('dup', 'a');
  await core.register(A);
  const r1 = await core.lifecycle.load(A, core);
  const inits1 = globalThis.__x.aInits || 0;
  const r2 = await core.lifecycle.load(A, core);
  const inits2 = globalThis.__x.aInits || 0;
  const ok = r1.ok === true && inits1 === 1
    && (r2.ok === false || (r2.ok === true && inits2 === inits1));
  return {
    ok,
    detail: `首次=${JSON.stringify(r1)} 二次=${JSON.stringify(r2)} init次数 ${inits1} → ${inits2}`
      + `${inits2 > inits1 ? ' ⇒ 【缺陷】重复 load 又跑了一遍 init' : ''}`,
  };
});

await probe('X02/c', '【正例】拒绝 B 之后：A 的能力仍可调用，B 的副作用为 0', async () => {
  const h = await makeHost();
  const { core } = h;
  const A = mkPlugin('dup', 'a');
  A.init = async (c) => { globalThis.__x.aInits = (globalThis.__x.aInits || 0) + 1; c.registerCapability('dup.work', { owner: 'dup', handler: () => 'A-done' }); };
  await core.register(A);
  await core.lifecycle.load(A, core);
  const B = mkPlugin('dup', 'b');
  await core.lifecycle.load(B, core).catch(() => {});
  const r = await callSafely(core, 'dup.work');
  const ok = r.res?.ok === true && r.res.payload === 'A-done' && (globalThis.__x.bInits || 0) === 0;
  return {
    ok,
    detail: `A 能力=${codeOf(r)} payload=${JSON.stringify(r.res?.payload)} B.init=${globalThis.__x.bInits || 0}`
      + `${r.res?.payload !== 'A-done' ? ' ⇒ 【缺陷】老实例被顶掉/被卸载' : ''}`,
  };
});

await probe('X02/d', '请求名与实现名不一致（loadOne("dup") 装到 other）：必须拒绝', async () => {
  const h = await makeHost();
  const { core, pm } = h;
  const r = await pm.loadOne('dup');
  const ok = r.ok === false && !core.plugins.has('other');
  return {
    ok,
    detail: `loadOne("dup")=${JSON.stringify(r)} 装进了 other=${core.plugins.has('other')} `
      + `other.init=${globalThis.__x.otherInits || 0}`
      + `${r.ok === true ? ' ⇒ 【缺陷】名字不符仍被当成装载成功' : ''}`,
  };
});

// ═══════════════════════════════════════════════════════════════════
// X03 — 启动期 lazy 源索引跨场景残留（P1）
// ═══════════════════════════════════════════════════════════════════
await probe('X03/a', '启动期 lazy 索引：切到不声明它的场景后必须撤销，旧能力不得再被激活', async () => {
  const h = await makeHost();
  const { core, pm, sc } = h;
  await pm.loadAll([], ['legacy']);
  const before = pm._pending.has('legacy');
  const sw = await sc.switchTo('empty', { yes: true });
  const stillPending = pm._pending.has('legacy');
  const r = await callSafely(core, 'legacy.work');
  const ok = before === true && sw.ok === true && stillPending === false && r.res?.ok !== true;
  return {
    ok,
    detail: `启动后索引=${before} 切场景=${sw.ok ? 'ok' : sw.code} 切换后仍在索引=${stillPending} `
      + `旧能力调用=${codeOf(r)} 实际装载=${globalThis.__x.legacyInits}`
      + `${r.res?.ok === true ? ' ⇒ 【缺陷】旧场景私有 lazy 仍可激活' : ''}`,
  };
});

await probe('X03/b', '【正例】目标场景自己声明了该 lazy：必须保留索引且可按需装载', async () => {
  const h = await makeHost();
  const { core, pm, sc } = h;
  await pm.loadAll([], ['legacy']);
  const sw = await sc.switchTo('with-legacy', { yes: true });
  const pending = pm._pending.has('legacy');
  const r = await callSafely(core, 'legacy.work');
  const ok = sw.ok === true && pending === true && r.res?.ok === true;
  return {
    ok,
    detail: `切场景=${sw.ok ? 'ok' : sw.code} 仍在索引=${pending} 调用=${codeOf(r)}`
      + `${r.res?.ok !== true ? ' ⇒ 【缺陷】合法共享 lazy 被误删' : ''}`,
  };
});

await probe('X03/c', '【正例】往返：boot lazy → empty（撤销）→ with-legacy（重建）→ 可用', async () => {
  const h = await makeHost();
  const { core, pm, sc } = h;
  await pm.loadAll([], ['legacy']);
  const s1 = await sc.switchTo('empty', { yes: true });
  const dropped = pm._pending.has('legacy');
  const s2 = await sc.switchTo('with-legacy', { yes: true });
  const reindexed = pm._pending.has('legacy');
  const r = await callSafely(core, 'legacy.work');
  const ok = s1.ok === true && s2.ok === true && dropped === false
    && reindexed === true && r.res?.ok === true;
  return {
    ok,
    detail: `切 empty=${s1.ok ? 'ok' : s1.code} 撤销=${!dropped} 切回=${s2.ok ? 'ok' : s2.code} `
      + `重建=${reindexed} 调用=${codeOf(r)}`,
  };
});

// ═══════════════════════════════════════════════════════════════════
// X04 — 未声明权属的服务覆写使对象与 owner 记录不一致（P1/P2）
// ═══════════════════════════════════════════════════════════════════
await probe('X04/a', '匿名（无追踪上下文）覆写已归属服务：对象与 owner 记录不得分叉', async () => {
  const h = await makeHost();
  const { core } = h;
  const A = { name: 'A' };
  const B = { name: 'B' };
  await core.runServiceTracking('owner-A', async () => { core.registerService('svc', A); });
  let threw = null;
  try { core.registerService('svc', B); } catch (e) { threw = e; }
  const actual = core.getService('svc');
  const owner = core._serviceOwners.get('svc');
  const consistent = (actual === A && owner === 'owner-A') || (actual === B && owner !== 'owner-A');
  const ok = consistent;
  return {
    ok,
    detail: `实际对象=${actual?.name} owner记录=${owner} 匿名覆写${threw ? '被拒' : '被接受'} `
      + `一致=${consistent}${consistent ? '' : ' ⇒ 【缺陷】对象与 owner 记录分叉'}`,
  };
});

await probe('X04/b', '【正例】同一装配实例替换：允许，且 owner 记录保持一致', async () => {
  const h = await makeHost();
  const { core } = h;
  const A1 = { name: 'A1' };
  const A2 = { name: 'A2' };
  // 同 owner 更新 = **同一受信装配实例**更新自己那笔；自报 owner 字符串不授权（R15-03）。
  const inst = { name: 'owner-A' };
  const asA = (fn) => core._runAssemblyContext('owner-A', fn, core.assemblyEpoch, inst);
  await asA(async () => { core.registerService('svc', A1); });
  let threw = null;
  try { await asA(async () => { core.registerService('svc', A2); }); }
  catch (e) { threw = e; }
  const actual = core.getService('svc');
  const owner = core._serviceOwners.get('svc');
  const ok = threw === null && actual === A2 && owner === 'owner-A';
  return { ok, detail: `替换${threw ? `被拒(${threw.message})` : '成功'} 实际=${actual?.name} owner=${owner}` };
});

await probe('X04/c', '【正例】异主追踪上下文覆写：必须拒绝（v0.15.2 已绿，防回归）', async () => {
  const h = await makeHost();
  const { core } = h;
  const A = { name: 'A' };
  const B = { name: 'B' };
  await core.runServiceTracking('owner-A', async () => { core.registerService('svc', A); });
  let threw = null;
  try { await core.runServiceTracking('owner-B', async () => { core.registerService('svc', B); }); }
  catch (e) { threw = e; }
  const actual = core.getService('svc');
  const ok = threw !== null && actual === A;
  return { ok, detail: `异主覆写=${threw ? '被拒' : '竟然成功'} 实际=${actual?.name}${threw ? '' : ' ⇒ 【缺陷】异主覆写未被拒'}` };
});

// ═══════════════════════════════════════════════════════════════════
cleanup();

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const CORE_FILES = ['core.js', 'plugin-manager.js', 'lifecycle-manager.js', 'scene-controller.js',
  'dependency-resolver.js', 'plugin-meta.js', 'json5-loader.js', 'env.js'];
console.log('\n═══ 基线指纹 ═══');
console.log(`package      ${PKG}`);
console.log(`probe        sha256:${sha(fileURLToPath(import.meta.url))}`);
let combined = '';
for (const f of CORE_FILES) {
  const h = sha(join(PKG, 'src/core', f));
  combined += h;
  console.log(`core/${f.padEnd(22)} sha256:${h}`);
}
console.log(`core(8合1)   sha256:${createHash('sha256').update(combined).digest('hex')}`);

const broken = results.filter((r) => r.status === 'BROKEN');
const perr = results.filter((r) => r.status === 'PROBE-ERROR');
console.log('\n═══ v0.15.2 跨状态机反例（X01～X04）═══\n');
for (const r of results) {
  console.log(`${r.status.padEnd(11)} ${r.id.padEnd(9)} ${r.title}`);
  console.log(`             ${r.detail}\n`);
}
console.log(`合计 ${results.length}｜FIXED ${results.length - broken.length - perr.length}｜BROKEN ${broken.length}｜PROBE-ERROR ${perr.length}`);
process.exitCode = perr.length > 0 ? 2 : (broken.length > 0 ? 1 : 0);
