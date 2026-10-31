/**
 * 专家 0.15.1 复审 §3：lazy 的**真实装载 Attempt** 与**各等候方**必须分开记账。
 *
 * 修前四条缺陷（LAZY-01～04）都来自同一个混淆：把"等候方结束了"当成"加载结束了"。
 *   · LAZY-01/02：`Promise.race` 的定时器从不清除 ⇒ 记录已结算后仍被旧定时器改写；
 *   · LAZY-03   ：`finally` 里删掉 single-flight 句柄 ⇒ 真实装载还在跑，第二个请求又起一笔；
 *   · LAZY-04   ：装载失败直接 reject 到 `callCapability` ⇒ 漏出异常，不是失败信封。
 *
 * 本轮纪律（延续）：
 *   ① 每条缺陷配**合法正例**，防止"一律超时/一律失败"式假修复；
 *   ② 用真实 Core / PluginManager / LifecycleManager，插件是真文件、真 import；
 *   ③ 计数点放在**真实装配出口**（`LifecycleManager.load`），不放在等候方那一侧；
 *   ④ 超时值取 45ms 只为让故障可驱动，合同不随超时长短改变；
 *   ⑤ 探针自身出错单独报 PROBE-ERROR（退出码 2），不计入 FIXED。
 *
 * 退出码：0 = 全部已修，1 = 仍有缺陷，2 = 探针自身出错。
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TIMEOUT = 45;
const results = [];
const probe = async (id, title, fn) => {
  try {
    const r = await fn();
    results.push({ id, title, status: r.ok ? 'FIXED' : 'BROKEN', detail: r.detail });
  } catch (err) {
    results.push({ id, title, status: 'PROBE-ERROR', detail: err.stack || err.message });
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { Core } = await import('../../src/core/core.js');
const { PluginManager } = await import('../../src/core/plugin-manager.js');
const { LifecycleManager } = await import('../../src/core/lifecycle-manager.js');

// 真实 init 计数：插件模块每次装载都会重新 import（带 cache-bust），但 globalThis 不变。
globalThis.__lazyProbe = { inits: 0, lastInitAt: 0, fail: false };

function pluginSrc({ delay = 0, fail = false } = {}) {
  const delayLine = delay > 0 ? `    await new Promise((r) => setTimeout(r, ${delay}));` : '';
  // 失败开关读 globalThis：同一个插件文件可以在"重试成功"的用例里第二次装载时不再抛。
  const failLine = fail
    ? `    if (globalThis.__lazyProbe.fail !== false) throw new Error('init-intentionally-failed');`
    : '';
  return `export class Slow {
  name = 'slow';
  version = '1.0.0';
  provides = ['slow.work'];
  tags = [];
  description = '';
  async init(core) {
    globalThis.__lazyProbe.inits += 1;
    globalThis.__lazyProbe.lastInitAt = Date.now();
${delayLine}
${failLine}
    core.registerCapability('slow.work', { owner: 'slow', handler: () => 'slow-done' });
  }
  async stop() {}
}
export default new Slow();
`;
}

const hosts = [];
async function makeHost(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'r017-'));
  const plugDir = join(dir, 'plugins');
  mkdirSync(plugDir, { recursive: true });
  writeFileSync(join(plugDir, 'slow.js'), pluginSrc(opts));
  globalThis.__lazyProbe = { inits: 0, lastInitAt: 0, fail: !!opts.fail };
  const core = new Core({ stateDir: dir });
  core.log = () => {};
  core.lifecycle = new LifecycleManager(core);
  const pm = new PluginManager(core);
  pm.dirs = [plugDir];
  pm._loadTimeoutMs = opts.timeout ?? TIMEOUT;
  // 用**产品自己的**装配入口：`loadAll` 扫目录并把 `slow` 登记进 `_pending`（只读文件头、
  // 不 import），尾部再装 `_lazyHook`。不自己 setData 一个等价钩子 —— 那测的是我写的桩。
  await pm.loadAll([], ['slow']);
  // 真实装配出口计数（eager 与 lazy 都经过它）。
  const counter = { n: 0 };
  const origLoad = pm.lc.load.bind(pm.lc);
  pm.lc.load = async (p, c, o) => { counter.n += 1; return origLoad(p, c, o); };
  const host = { core, pm, dir, counter, stop: () => { try { pm._stopIdleTimer(); } catch { /* 老版本没有该方法 */ } } };
  hosts.push(host);
  return host;
}

function cleanup() {
  for (const h of hosts) {
    h.stop();
    try { rmSync(h.dir, { recursive: true, force: true }); } catch { /* 清理失败不影响判据 */ }
  }
  hosts.length = 0;
}

const inits = () => globalThis.__lazyProbe.inits;

/** 统一读一次调用结果：不抛 = 信封；抛了也记下来（LAZY-04 就是"抛了"）。 */
async function callSafely(core, id, params = {}) {
  try {
    return { threw: false, res: await core.callCapability(id, params) };
  } catch (e) {
    return { threw: true, err: e };
  }
}

// ═══════════════════════════════════════════════════════════
// LAZY-01：真实装载在阈值前结算 ⇒ 旧定时器不得回头改写已结算记录
// ═══════════════════════════════════════════════════════════
// 这两条刻意走 `_lazyLoadOne`（装配机制本身），不走 `callCapability`：
// 记录被改写与"失败信封漏成异常"是两个缺陷，判据必须各看各的目标，
// 否则 LAZY-04 一修，LAZY-01 就跟着"变绿"而根本没测到定时器。
await probe('LAZY-01/a', '成功在阈值前完成：越过阈值后仍是 loaded，settledAt 不得被改写', async () => {
  const { core, pm } = await makeHost({ delay: 5 });
  let threw = null;
  try { await pm._lazyLoadOne('slow'); } catch (e) { threw = e; }
  const atSettle = pm.describeLazyLoad('slow');
  await sleep(TIMEOUT * 3);
  const after = pm.describeLazyLoad('slow');
  const ok = threw === null && after?.state === 'loaded'
    && after.settledAt === atSettle?.settledAt && after.error === null;
  return { ok, detail: `装载${threw ? '抛出' : '成功'} 结算后=${atSettle?.state} `
    + `${TIMEOUT * 3}ms 后=${after?.state} settledAt变化=${after?.settledAt !== atSettle?.settledAt}`
    + `${after?.state !== 'loaded' ? ' ⇒ 【缺陷】已结算记录被旧定时器改写' : ''}` };
});

await probe('LAZY-01/b', '失败在阈值前完成：越过阈值后仍是 failed，不得变成"仍在飞"', async () => {
  const { pm } = await makeHost({ fail: true });
  let threw = null;
  try { await pm._lazyLoadOne('slow'); } catch (e) { threw = e; }
  const atSettle = pm.describeLazyLoad('slow');
  await sleep(TIMEOUT * 3);
  const after = pm.describeLazyLoad('slow');
  const ok = threw !== null && after?.state === 'failed'
    && after.settledAt === atSettle?.settledAt;
  return { ok, detail: `装载${threw ? '按预期失败' : '竟然成功'} 结算后=${atSettle?.state} `
    + `${TIMEOUT * 3}ms 后=${after?.state}${after?.state !== 'failed' ? ' ⇒ 【缺陷】明确失败被改写' : ''}` };
});

// ═══════════════════════════════════════════════════════════
// LAZY-02：超时之后的**迟到结果**必须能落到记录上，且区分"等候"与"加载"
// ═══════════════════════════════════════════════════════════
await probe('LAZY-02/a', '等候超时后迟到成功：最终 loaded，且超时期间可查到"仍在飞"', async () => {
  const { pm } = await makeHost({ delay: 150 });
  let err = null;
  try { await pm._lazyLoadOne('slow'); } catch (e) { err = e; }
  const during = pm.describeLazyLoad('slow');
  await sleep(220);
  const after = pm.describeLazyLoad('slow');
  const ok = err !== null && /timeout/i.test(err.message)
    && during?.state === 'in_flight_after_timeout' && after?.state === 'loaded'
    && after.registered === true;
  return { ok, detail: `等候方=${err ? '超时' : '竟然等到'} 超时期间=${during?.state} 迟到后=${after?.state} `
    + `已注册=${after?.registered}` };
});

await probe('LAZY-02/b', '等候超时后迟到失败：最终 failed（不得编造 timeout_then_failed 这种混合态）', async () => {
  const { pm } = await makeHost({ delay: 150, fail: true });
  let err = null;
  try { await pm._lazyLoadOne('slow'); } catch (e) { err = e; }
  await sleep(220);
  const after = pm.describeLazyLoad('slow');
  const ok = err !== null && after?.state === 'failed' && !!after?.error
    && after.registered === false;
  return { ok, detail: `等候方=${err ? '超时' : '竟然等到'} 迟到后=${after?.state} error=${after?.error} `
    + `已注册=${after?.registered}${after?.state !== 'failed' ? ' ⇒ 【缺陷】失败事实被写成混合态' : ''}` };
});

// ═══════════════════════════════════════════════════════════
// LAZY-03：同一来源**只允许一笔**真实装载
// ═══════════════════════════════════════════════════════════
await probe('LAZY-03/a', '首个等候方超时、真实装载仍在跑：第二个请求不得再起一笔 init', async () => {
  const { core, pm } = await makeHost({ delay: 100, timeout: 45 });
  const r1 = await callSafely(core, 'slow.work');   // t=0，45ms 超时
  await sleep(20);                                   // t=65
  const r2 = await callSafely(core, 'slow.work');   // 加入同一笔真实装载：t=100 结算，r2 应成功
  await sleep(120);
  const after = pm.describeLazyLoad('slow');
  const ok = r1.threw === false && r1.res.code === 'lazy_load_timeout'
    && r2.threw === false && r2.res.ok === true && inits() === 1
    && after?.state === 'loaded';
  return { ok, detail: `第一次=${r1.res?.ok ? 'ok' : r1.res?.code} 第二次=${r2.res?.ok ? 'ok' : r2.res?.code} `
    + `真实init次数=${inits()} 最终=${after?.state}${inits() > 1 ? ' ⇒ 【缺陷】重复真实装载' : ''}` };
});

await probe('LAZY-03/b', '两请求同时入队：只允许一笔真实装载，两个等候方都拿到同一结果', async () => {
  const { core, pm } = await makeHost({ delay: 60, timeout: 500 });
  const [a, b] = await Promise.all([callSafely(core, 'slow.work'), callSafely(core, 'slow.work')]);
  const ok = a.res?.ok === true && b.res?.ok === true && inits() === 1
    && pm.describeLazyLoad('slow')?.state === 'loaded';
  return { ok, detail: `a=${JSON.stringify(a.res?.payload)} b=${JSON.stringify(b.res?.payload)} `
    + `真实init次数=${inits()}${inits() > 1 ? ' ⇒ 【缺陷】并发重复装载' : ''}` };
});

// ═══════════════════════════════════════════════════════════
// LAZY-04：装载失败/超时不得漏成异常，必须走统一失败信封
// ═══════════════════════════════════════════════════════════
await probe('LAZY-04/a', 'init 明确失败：callCapability 返回失败信封，不得 reject', async () => {
  const { core } = await makeHost({ fail: true });
  const r = await callSafely(core, 'slow.work');
  const res = r.res || {};
  const ok = r.threw === false && res.ok === false && res.state === 'failed'
    && res.code === 'lazy_load_failed' && res.category === 'assembly'
    && res.dispatched === false && res.side_effect === 'unknown_or_possible'
    && /init-intentionally-failed/.test(String(res.error));
  return { ok, detail: r.threw
    ? `【缺陷】异常漏出：${r.err?.message}`
    : `code=${res.code} state=${res.state} category=${res.category} dispatched=${res.dispatched} `
      + `side_effect=${res.side_effect} result_kind=${res.result_kind}` };
});

await probe('LAZY-04/b', 'init 等候超时：返回 lazy_load_timeout 信封，且标注仍在装配', async () => {
  const { core } = await makeHost({ delay: 150 });
  const r = await callSafely(core, 'slow.work');
  const res = r.res || {};
  const ok = r.threw === false && res.ok === false && res.code === 'lazy_load_timeout'
    && res.state === 'failed' && res.category === 'assembly'
    && res.dispatched === false && res.side_effect === 'unknown_or_possible';
  return { ok, detail: r.threw ? `【缺陷】异常漏出：${r.err?.message}`
    : `code=${res.code} state=${res.state} dispatched=${res.dispatched} side_effect=${res.side_effect}` };
});

// ═══════════════════════════════════════════════════════════
// 合法正例：不得为了"防重复"把正常路径也堵死
// ═══════════════════════════════════════════════════════════
await probe('LAZY-05', '明确失败之后允许安全重试：第二次装载成功，次数为 2', async () => {
  const { core, pm } = await makeHost({ fail: true });
  const r1 = await callSafely(core, 'slow.work');
  await sleep(TIMEOUT * 2);
  globalThis.__lazyProbe.fail = false;             // 修好"插件"，重试
  const r2 = await callSafely(core, 'slow.work');
  const ok = r1.res?.ok === false && r2.res?.ok === true && inits() === 2
    && pm.describeLazyLoad('slow')?.state === 'loaded';
  return { ok, detail: `第一次=${r1.res?.code} 重试=${r2.res?.ok ? 'ok' : r2.res?.code} `
    + `真实init次数=${inits()}${r2.res?.ok !== true ? ' ⇒ 【缺陷】失败后无法重试' : ''}` };
});

await probe('LAZY-06', '已运行插件再调用：不重复装载（正例，防止"防重复"把正常读也堵死）', async () => {
  const { core, pm } = await makeHost({ delay: 5 });
  await callSafely(core, 'slow.work');
  const mid = inits();
  const r2 = await callSafely(core, 'slow.work');
  const ok = r2.res?.ok === true && inits() === mid && mid === 1;
  return { ok, detail: `第二次 payload=${JSON.stringify(r2.res?.payload)} 装载次数 ${mid} → ${inits()}` };
});

await probe('LAZY-07', '装载进行中卸载：不得崩溃，记录仍可查（迟到结果有地方落）', async () => {
  const { core, pm } = await makeHost({ delay: 120 });
  const p = callSafely(core, 'slow.work');         // 不等它
  await sleep(10);
  await pm.unload('slow');                          // 此刻真实装载仍在跑
  const r = await p;
  await sleep(180);
  const after = pm.describeLazyLoad('slow');
  const ok = r.threw === false && after != null && after.settledAt != null;
  return { ok, detail: `调用=${r.threw ? '抛出' : (r.res?.ok ? 'ok' : r.res?.code)} `
    + `记录=${after?.state ?? 'null'} 已结算=${after?.settledAt != null}` };
});

// ═══════════════════════════════════════════════════════════
cleanup();
const broken = results.filter((r) => r.status === 'BROKEN');
const perr = results.filter((r) => r.status === 'PROBE-ERROR');
console.log('\n═══ v0.15.2 lazy 真实装载事实（LAZY-01～04）═══\n');
for (const r of results) {
  console.log(`${r.status.padEnd(11)} ${r.id.padEnd(11)} ${r.title}`);
  console.log(`             ${r.detail}\n`);
}
console.log(`合计 ${results.length}｜FIXED ${results.length - broken.length - perr.length}｜BROKEN ${broken.length}｜PROBE-ERROR ${perr.length}`);
process.exitCode = perr.length > 0 ? 2 : (broken.length > 0 ? 1 : 0);
