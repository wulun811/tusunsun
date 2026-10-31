/**
 * rc.26 探针：`recycle-advisor` 参考实现的**真实装载**端到端。
 *
 * 与单测（`test-rc26-dedup-equivalence` L/M）的分工：单测用桩证明契约，这里用**真的 Core、
 * 真的 PluginManager、真的装载器、真的 facts 总线**证明"这只能跑"。差别不是仪式——
 * 桩不会暴露"插件导出成类所以装载器不收"（S7 那次）或"provides 没换成 service 索引"这两类错。
 *
 * 两条用例，正好构成一对：
 *   E2E/1 装了 advisor：刚被访问过（TTL 判据不成立）、但按配置已超龄的懒插件**被回收**；
 *   E2E/2 不装 advisor：同样状态**一动不动** —— 否则"听了"和"一律回收"都能变绿。
 *
 * 年龄靠**配置**（`recycleAdvisor.maxAgeMs = 1`）而非改插件内部状态：
 * 一旦去摸 `_loadedAt`，这个探针就不再证明"公开面够用"了。
 *
 * 用法：`node test/probes/r26-recycle-advisor-e2e.mjs [package根目录]`
 * 退出码：0 = 合同成立；1 = 有 BROKEN；2 = 探针自身出错。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = process.argv[2] ? resolve(process.argv[2]) : resolve(HERE, '../..');
const imp = (rel) => import(pathToFileURL(join(PKG, rel)).href);

const { Core } = await imp('src/core/core.js');
const { PluginManager } = await imp('src/core/plugin-manager.js');

const results = [];
const probe = async (id, title, fn) => {
  try {
    const r = await fn();
    results.push({ id, title, status: r.ok ? 'FIXED' : 'BROKEN', detail: r.detail });
  } catch (err) {
    results.push({ id, title, status: 'PROBE-ERROR', detail: err?.stack || String(err) });
  }
};

const VICTIM_SRC = `class Victim {
  name = 'victim';
  provides = ['victim.work'];
  async init(core) {
    core.registerCapability('victim.work', { owner: 'victim', handler: () => 'victim-done' });
  }
  async stop() {}
}
// 导出**实例**：装载器问的是对象上的 name + init（类的 init 在 prototype 上）。
// 这一行本身就是本探针抓到的第一类错：插件写成类、却指望装载器收下。
export default new Victim();
`;

const hosts = [];

/**
 * @param {boolean} withAdvisor  装不装参考实现（两条用例只差这一件事）
 */
async function makeHost(withAdvisor) {
  const dir = mkdtempSync(join(tmpdir(), 'r26-e2e-'));
  const plugDir = join(dir, 'plugins');
  mkdirSync(plugDir, { recursive: true });
  writeFileSync(join(plugDir, 'victim.js'), VICTIM_SRC);

  const core = new Core({ stateDir: dir });
  core.log = () => {};
  // 年龄压到 1ms：靠**配置**让"刚装完就超龄"，不碰插件内部状态。
  const realGet = core.get.bind(core);
  core.get = (k, d) => (k === 'recycleAdvisor' ? { maxAgeMs: 1, cooldownMs: 0 } : realGet(k, d));

  const pm = new PluginManager(core);
  // 第二个目录指向**包里的真插件**：装的是交付物里那一份，不是探针里重写的副本。
  pm.dirs = [plugDir, join(PKG, 'plugins')];
  pm._loadTimeoutMs = 2000;
  const host = { core, pm, dir };
  hosts.push(host);

  if (withAdvisor) await pm.loadAll(['recycle-advisor'], ['victim']);
  else await pm.loadAll([], ['victim']);          // 不装 advisor：走内核自己的硬上限 + TTL
  await core.start();
  return host;
}

function cleanup() {
  for (const h of hosts) {
    try { h.pm._stopIdleTimer?.(); } catch { /* 老版本没有布该法 */ }
    try { rmSync(h.dir, { recursive: true, force: true }); } catch { /* 清理失败不影响判据 */ }
  }
  hosts.length = 0;
}

const recycledNames = (core) => core
  .rawListeners('core:plugin.recycled').length;  // 只用于探针自身健全性；实际判定看事实账

// ═══════════════════════════════════════════════════════════════════
await probe('E2E/0', '前提：参考实现经真装载器装上了，并且真的注册了 recycle-advisor 服务', async () => {
  const { core } = await makeHost(true);
  const { default: advisorExport } = await imp('plugins/recycle-advisor.js');
  const okShape = typeof advisorExport?.name === 'string' && typeof advisorExport?.init === 'function';
  const svc = core.getService('recycle-advisor');
  return {
    ok: okShape && !!svc && typeof svc.pollRecycleDecisions === 'function' && core.plugins.has('recycle-advisor'),
    detail: `导出 isPlugin=${okShape}，已注册=${core.plugins.has('recycle-advisor')}，服务=${!!svc}`,
  };
});

await probe('E2E/1', '装了 advisor：刚访问过但已超龄的懒插件必须被回收（不是 TTL 路径）', async () => {
  const { core, pm } = await makeHost(true);
  // 真懒加载：真的走过 `_dispatchCapability` → `_loadLazy` → 真的 `core:plugin.loaded` 事实
  const call = await core.callCapability('victim.work');
  if (!(call?.ok ?? call?.result === 'victim-done')) {
    return { ok: false, detail: `懒加载没成功，探针前提不成立：${JSON.stringify(call).slice(0, 120)}` };
  }
  if (!pm._lazyLoaded.has('victim')) return { ok: false, detail: '懒加载后 victim 不在 _lazyLoaded' };

  await new Promise((r) => setTimeout(r, 10));   // 跨过 1ms 的年龄上限
  pm._lastAccess.set('victim', Date.now());       // 刚访问过 ⇒ TTL 判据不成立
  const before = core.plugins.has('victim');
  await pm._checkIdle();
  const after = core.plugins.has('victim');

  return {
    ok: before === true && after === false && !pm._lazyLoaded.has('victim'),
    detail: `回收前装着=${before}，回收后装着=${after}，懒账本还有=${pm._lazyLoaded.has('victim')}`,
  };
});

await probe('E2E/2', '不装 advisor：同样的状态必须一动不动（否则“听了”与“一律回收”都能变绿）', async () => {
  const { core, pm } = await makeHost(false);
  const call = await core.callCapability('victim.work');
  if (!(call?.ok ?? call?.result === 'victim-done')) return { ok: false, detail: '懒加载没成功，探针前提不成立' };
  await new Promise((r) => setTimeout(r, 10));
  pm._lastAccess.set('victim', Date.now());
  await pm._checkIdle();
  const stillThere = core.plugins.has('victim');
  return { ok: stillThere, detail: `没有 advisor 且刚访问过 ⇒ 装着=${stillThere}（必须 true）` };
});

cleanup();

const broken = results.filter((r) => r.status !== 'FIXED');
for (const r of results) {
  const mark = r.status === 'FIXED' ? 'PASS' : r.status;
  console.log(`[${mark}] ${r.id}: ${r.title}\n        ${r.detail}`);
}
console.log(`\nr26 e2e: ${results.length - broken.length} PASS, ${broken.length} BROKEN`);
process.exit(broken.length ? 1 : 0);
