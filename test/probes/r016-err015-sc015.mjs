/**
 * 专家 0.15.0 复审：ERR-015（拒绝码不能证明执行阶段）与 SC-015（fresh lazy）的独立复现。
 *
 * 上一轮的教训继续沿用：
 *   ① 每条缺陷配一条**合法正例**，防止"一律降级/一律拒绝"式的假修复；
 *   ② 用**真实** Core / SceneController / PluginManager，场景走真实 findScene（真的读文件）；
 *   ③ 断言"事实"，不消费品自己打出的说法；
 *   ④ 期望值硬编码，改产品代码不会顺带改判据；
 *   ⑤ 探针自身出错必须与产品缺陷**分开报**（PROBE-ERROR 不计入 FIXED）。
 *
 * 本轮的额外纪律（SC-015 的教训）：**测试的前置状态必须是产品承诺的那个状态**。
 * 上一版 SC-03 先 `core.plugins.set('lazyone', ...)` 造了一个"已登记"的假起点，
 * 于是 toAdd 为空、真正待测的装载路径一次都没跑，却报 FIXED。
 * 这里一律从**从未装载**开始。
 *
 * 退出码（与其他探针一致）：0 = 全部已修，1 = 仍有缺陷，2 = 探针自身出错。
 */
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const results = [];
const probe = async (id, title, fn) => {
  try {
    const r = await fn();
    results.push({ id, title, status: r.ok ? 'FIXED' : 'BROKEN', detail: r.detail });
  } catch (err) {
    results.push({ id, title, status: 'PROBE-ERROR', detail: err.stack || err.message });
  }
};

const { Core } = await import('../../src/core/core.js');
const { SceneController } = await import('../../src/core/scene-controller.js');
const { PluginManager } = await import('../../src/core/plugin-manager.js');
const { LifecycleManager } = await import('../../src/core/lifecycle-manager.js');

function makeCore() {
  const dir = mkdtempSync(join(tmpdir(), 'r016-'));
  const core = new Core({ stateDir: dir });
  core.log = () => {};
  core.lifecycle = new LifecycleManager(core);
  return { core, dir };
}

/** SCENE_SEARCH 在模块加载时冻结，测试场景必须写进仓库真实的 scenes/ 目录。 */
const SCENE_DIR = join(ROOT, 'scenes');
const createdScenes = [];
function withScenes(scenes) {
  for (const [name, body] of Object.entries(scenes)) {
    const f = join(SCENE_DIR, `__probe_${name}.json5`);
    writeFileSync(f, JSON.stringify(body));
    createdScenes.push(f);
  }
  return SCENE_DIR;
}
function cleanupScenes() {
  for (const f of createdScenes) { try { rmSync(f, { force: true }); } catch { /* 清理失败不影响判据 */ } }
  createdScenes.length = 0;
}

// ═══════════════════════════════════════════════════════════
// ERR-015｜四个"合同保证在副作用前"的码，从 handler 里抛出时不得再报 denied
// ═══════════════════════════════════════════════════════════
const PRE_EFFECT_CODES = ['out_of_bounds', 'capability_frozen', 'tool_not_registered', 'invalid_session_id'];

await probe('ERR-015/a', 'handler 写完文件再抛这四个码，一律不得宣称"执行前/零副作用"', async () => {
  const { core, dir } = makeCore();
  const rows = [];
  let lied = 0;
  for (const code of PRE_EFFECT_CODES) {
    const marker = join(dir, `effect-${code}.txt`);
    core.registerCapability(`probe.${code}`, {
      owner: 'probe',
      handler: async () => {
        writeFileSync(marker, 'I really ran');       // 先产生副作用
        const err = new Error(`plugin says ${code}`);
        err.code = code;                              // 再抛一个"拒绝型"码
        throw err;
      },
    });
    const r = await core.callCapability(`probe.${code}`, {});
    const hadEffect = existsSync(marker);
    const bad = hadEffect && (r.state === 'denied' || r.side_effect === 'none' || r.dispatched === false);
    if (bad) lied += 1;
    rows.push(`${code}: state=${r.state} dispatched=${r.dispatched} side_effect=${r.side_effect} 副作用=${hadEffect}`);
  }
  rmSync(dir, { recursive: true, force: true });
  return { ok: lied === 0, detail: `${rows.join(' | ')}${lied ? ` ⇒ 【缺陷】${lied}/4 把已执行报成执行前` : ''}` };
});

await probe('ERR-015/b', 'Core 自己在 dispatch 之前拒绝（冻结）→ 仍必须是 denied + side_effect:none + handler 0 次', async () => {
  const { core, dir } = makeCore();
  let ran = 0;
  core.registerCapability('probe.frozen', { owner: 'probe', handler: () => { ran += 1; return 'x'; } });
  core.freezeCapability('probe.frozen');
  const r = await core.callCapability('probe.frozen', {});
  const ok = ran === 0 && r.state === 'denied' && r.code === 'capability_frozen'
    && r.dispatched === false && r.side_effect === 'none';
  rmSync(dir, { recursive: true, force: true });
  return { ok, detail: `handler 运行 ${ran} 次，state=${r.state} code=${r.code} `
    + `dispatched=${r.dispatched} side_effect=${r.side_effect}` };
});

await probe('ERR-015/c', '授权拒绝（身份未证实）→ 仍必须是 denied + handler 0 次', async () => {
  const { core, dir } = makeCore();
  let ran = 0;
  core.registerCapability('probe.guarded', {
    owner: 'probe', permissions: { require_identity: true },
    handler: () => { ran += 1; return 'secret'; },
  });
  const r = await core.callCapability('probe.guarded', {}, { caller: 'self-reported' });
  const ok = ran === 0 && r.state === 'denied' && r.dispatched === false && r.side_effect === 'none';
  rmSync(dir, { recursive: true, force: true });
  return { ok, detail: `handler 运行 ${ran} 次，state=${r.state} code=${r.code} `
    + `dispatched=${r.dispatched} side_effect=${r.side_effect}` };
});

await probe('ERR-015/d', '内置工具越界：仍是具名 out_of_bounds，但不得宣称零副作用；越界读写都不落地', async () => {
  const { core, dir } = makeCore();
  const W = (await import('../../plugins/tools/tool-write.js')).default;
  const R = (await import('../../plugins/tools/tool-read.js')).default;
  await W.init(core); await R.init(core);
  const w = await core.callCapability('tool.write', { path: '../escaped-r016.txt', content: 'x' });
  const r = await core.callCapability('tool.read', { path: '../../etc/passwd', limit: 5 });
  const escaped = existsSync(join(dir, '..', 'escaped-r016.txt'));
  const ok = w.ok === false && w.code === 'out_of_bounds' && w.state === 'failed'
    && r.payload === null && !escaped;
  rmSync(dir, { recursive: true, force: true });
  return { ok, detail: `write: state=${w.state} code=${w.code}；read: payload=${r.payload}；越界落盘=${escaped}` };
});

// ═══════════════════════════════════════════════════════════
// SC-015｜fresh lazy：切场景不装载，首次能力调用才装载
// ═══════════════════════════════════════════════════════════
const PLUGIN_SRC = `class LazyOne {
  name = 'lazyone';
  version = '0.0.1';
  provides = [{ name: 'lazyone.work', removable: true }];
  tags = ['probe'];
  description = 'probe lazy plugin';
  async init(core) {
    core.registerCapability('lazyone.work', { owner: 'lazyone', handler: () => 'lazy-done' });
  }
}
export default new LazyOne();
`;

const livePms = [];
async function makeLazyHost() {
  const { core, dir } = makeCore();
  const plugDir = join(dir, 'plugins');
  mkdirSync(plugDir, { recursive: true });
  writeFileSync(join(plugDir, 'lazyone.js'), PLUGIN_SRC);
  const pm = new PluginManager(core);
  pm.dirs = [plugDir];
  // 用**产品自己的**接线装 `_lazyHook` / `_lazyIndex`（`loadAll` 尾部也会调它）。
  // 不自己 setData 一个等价钩子：那会让探针测到"我写的桩"而不是产品的路径。
  await pm._ensureLazyInfrastructure();
  livePms.push(pm);
  const sc = new SceneController(core, pm);
  // 统计**真实装载次数**：包在 `LifecycleManager.load` 外面 —— 那是全仓唯一的装配出口，
  // eager（loadOne → lc.load）与 lazy（_lazyLoadOne → lc.load）都会经过它。
  // 上一版包在 `pm.loadOne` 上，于是懒加载路径一次都数不到，把"装了一次"读成"没装"
  //（正是"判据看不见目标"的第 N 次复现：计数点选在了被测路径之外）。
  const counter = { n: 0 };
  const origLoad = pm.lc.load.bind(pm.lc);
  pm.lc.load = async (plugin, core2, opts) => { counter.n += 1; return origLoad(plugin, core2, opts); };
  return { core, pm, sc, dir, counter };
}

withScenes({
  lazy: { name: '__probe_lazy', eager: [], plugins: [], lazy: ['lazyone'] },
  plug: { name: '__probe_plug', eager: [], plugins: ['lazyone'], lazy: [] },
  eager: { name: '__probe_eager', eager: ['lazyone'], plugins: [], lazy: [] },
  bare: { name: '__probe_bare', eager: [], plugins: [], lazy: [] },
});

await probe('SC-015/a', 'fresh lazy：切到声明 lazy 的场景，插件**不得**被装载，但必须进懒加载索引', async () => {
  const { core, pm, sc, dir, counter } = await makeLazyHost();
  const r = await sc.switchTo('__probe_lazy', { yes: true });
  const running = core.plugins.get('lazyone');
  const indexed = pm._pending.has('lazyone');
  const ok = r.ok === true && running === undefined && indexed && counter.n === 0;
  rmSync(dir, { recursive: true, force: true });
  return { ok, detail: `ok=${r.ok} loadOne调用=${counter.n} 运行态=${running?.state ?? '未装载'} `
    + `_pending=${indexed} lazy=${JSON.stringify(r.lazy)}${r.ok && running ? ' ⇒ 【缺陷】切场景即装载' : ''}` };
});

await probe('SC-015/b', '首次能力调用触发懒加载：装载 1 次，插件变 running，返回值正确', async () => {
  const { core, pm, sc, dir, counter } = await makeLazyHost();
  await sc.switchTo('__probe_lazy', { yes: true });
  const before = counter.n;
  const r = await core.callCapability('lazyone.work', {});
  const after = counter.n;
  const ok = r.ok === true && r.payload === 'lazy-done' && after - before === 1
    && core.plugins.get('lazyone')?.state === 'running' && pm._lazyLoaded.has('lazyone');
  rmSync(dir, { recursive: true, force: true });
  return { ok, detail: `payload=${JSON.stringify(r.payload)} 新增装载=${after - before} `
    + `state=${core.plugins.get('lazyone')?.state ?? '未装载'}` };
});

await probe('SC-015/c', '重复能力调用不得重复装载（幂等）', async () => {
  const { core, sc, dir, counter } = await makeLazyHost();
  await sc.switchTo('__probe_lazy', { yes: true });
  await core.callCapability('lazyone.work', {});
  const mid = counter.n;
  const r2 = await core.callCapability('lazyone.work', {});
  const ok = r2.ok === true && counter.n === mid;
  rmSync(dir, { recursive: true, force: true });
  return { ok, detail: `第二次 payload=${JSON.stringify(r2.payload)} 装载次数 ${mid} → ${counter.n}` };
});

await probe('SC-015/d', '切出不包含它的场景：插件被卸载，懒加载索引一并撤销', async () => {
  const { core, pm, sc, dir } = await makeLazyHost();
  await sc.switchTo('__probe_lazy', { yes: true });
  await core.callCapability('lazyone.work', {});
  const r = await sc.switchTo('__probe_bare', { yes: true });
  const stillRunning = core.plugins.has('lazyone');
  const stillIndexed = pm._pending.has('lazyone');
  const ok = r.ok === true && !stillRunning && !stillIndexed;
  rmSync(dir, { recursive: true, force: true });
  return { ok, detail: `切换 ok=${r.ok} 仍在运行=${stillRunning} 仍在索引=${stillIndexed}` };
});

await probe('SC-015/e', '切回后再次调用：能重新装载并成功（不是"永久不可调用"）', async () => {
  const { core, sc, dir, counter } = await makeLazyHost();
  await sc.switchTo('__probe_lazy', { yes: true });
  await core.callCapability('lazyone.work', {});
  await sc.switchTo('__probe_bare', { yes: true });
  const back = await sc.switchTo('__probe_lazy', { yes: true });
  const before = counter.n;
  const r = await core.callCapability('lazyone.work', {});
  const ok = back.ok === true && r.ok === true && r.payload === 'lazy-done' && counter.n - before === 1;
  rmSync(dir, { recursive: true, force: true });
  return { ok, detail: `切回 ok=${back.ok}；再次调用 ok=${r.ok} payload=${JSON.stringify(r.payload)} `
    + `新增装载=${counter.n - before}` };
});

await probe('SC-015/f', '正例：eager 声明仍然切场景即装载（不得把 lazy 的修法套到 eager 上）', async () => {
  const { core, sc, dir } = await makeLazyHost();
  const r = await sc.switchTo('__probe_eager', { yes: true });
  const running = core.plugins.get('lazyone')?.state;
  const ok = r.ok === true && running === 'running';
  rmSync(dir, { recursive: true, force: true });
  return { ok, detail: `ok=${r.ok} 运行态=${running ?? '未装载'} verified=${r.verified}` };
});

await probe('SC-015/g', '推迟装配（CLI 提案）：不装载任何插件，也不得冒充已核对', async () => {
  const { core, sc, dir, counter } = await makeLazyHost();
  const r = await sc.switchTo('__probe_eager', { yes: true, deferAssembly: true });
  const ok = r.ok === true && r.verified === false && r.verification === 'deferred'
    && core.plugins.has('lazyone') === false && counter.n === 0;
  rmSync(dir, { recursive: true, force: true });
  return { ok, detail: `ok=${r.ok} verified=${r.verified} verification=${r.verification} `
    + `装载=${counter.n} 运行态=${core.plugins.get('lazyone')?.state ?? '未装载'}` };
});

await probe('SC-015/h', '`plugins` 字段与 `lazy` 同义（启动器口径）：切场景不装载，首次调用才装载', async () => {
  const { core, pm, sc, dir, counter } = await makeLazyHost();
  const r = await sc.switchTo('__probe_plug', { yes: true });
  const afterSwitch = { running: core.plugins.get('lazyone')?.state ?? '未装载', loads: counter.n, indexed: pm._pending.has('lazyone') };
  const call = await core.callCapability('lazyone.work', {});
  const ok = r.ok === true && afterSwitch.running === '未装载' && afterSwitch.indexed
    && call.ok === true && counter.n === 1;
  rmSync(dir, { recursive: true, force: true });
  return { ok, detail: `切换后：运行态=${afterSwitch.running} 装载=${afterSwitch.loads} 索引=${afterSwitch.indexed}；`
    + `调用后 payload=${JSON.stringify(call.payload)} 装载=${counter.n}`
    + `${afterSwitch.running === 'running' ? ' ⇒ 【缺陷】plugins 在切换时被当 eager' : ''}` };
});

cleanupScenes();
// `_ensureLazyInfrastructure` 会起 30s 的 idle 巡检定时器（未 unref）——探针必须收掉，
// 否则进程被它挂住。这是探针的收尾责任，不是产品缺陷。
for (const pm of livePms) { try { pm._stopIdleTimer(); } catch { /* 已停 */ } }

// ═══════════════════════════════════════════════════════════
const fixed = results.filter((r) => r.status === 'FIXED').length;
const broken = results.filter((r) => r.status === 'BROKEN');
const brokenProbe = results.filter((r) => r.status === 'PROBE-ERROR');
for (const r of results) {
  const tag = r.status === 'FIXED' ? '\x1b[32mFIXED\x1b[0m'
    : r.status === 'BROKEN' ? '\x1b[31mBROKEN\x1b[0m' : '\x1b[33mPROBE-ERROR\x1b[0m';
  console.log(`${tag} ${r.id}  ${r.title}`);
  console.log(`        ${r.detail}`);
}
console.log(`\n${fixed}/${results.length} FIXED`
  + (broken.length ? ` | ${broken.length} BROKEN` : '')
  + (brokenProbe.length ? ` | ${brokenProbe.length} PROBE-ERROR` : ''));
// 探针自身坏掉是**第三种**结果：既不算已修，也不该被当成产品缺陷。
if (brokenProbe.length) process.exit(2);
process.exit(broken.length ? 1 : 0);
