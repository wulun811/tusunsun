/**
 * 专家 0.14.1-post 复审：本轮新增反例（INV-01、SC-01～05）的独立复现。
 *
 * 规矩（上一轮吃过三次亏：判据看不见自己的目标）：
 *   ① 每条缺陷配一条**合法正例**，防止"一律拒绝/一律失败"式的假修复；
 *   ② 用**真实** Core / SceneController，场景走真实 findScene（真的读 JSON 文件）；
 *   ③ 断言"事实"，不消费品自己打出的说法；
 *   ④ 期望值硬编码，改产品代码不会顺带改判据；
 *   ⑤ 探针自身出错必须与产品缺陷**分开报**（否则桩写错会被伪装成"已修"）。
 *
 * 退出码（与其他探针一致）：0 = 全部已修，1 = 仍有缺陷，2 = 探针自身出错。
 */
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const results = [];
const probe = async (id, title, fn) => {
  try {
    const r = await fn();
    results.push({ id, title, status: r.ok ? 'FIXED' : 'BROKEN', detail: r.detail });
  } catch (err) {
    // 探针自身坏了 ≠ 产品有缺陷。单列出来，避免"桩写错"被当成"已修"。
    results.push({ id, title, status: 'PROBE-ERROR', detail: err.message });
  }
};

const { Core } = await import('../../src/core/core.js');
const { SceneController } = await import('../../src/core/scene-controller.js');
const { LifecycleManager } = await import('../../src/core/lifecycle-manager.js');

function makeCore() {
  const dir = mkdtempSync(join(tmpdir(), 'r015-'));
  const core = new Core({ stateDir: dir });
  core.log = () => {};
  core.lifecycle = new LifecycleManager(core);
  return { core, dir };
}

/**
 * SCENE_SEARCH 是**模块加载时**冻结的常量（src/core/scene-controller.js:7），chdir 改不了它。
 * 所以测试场景必须写进仓库真实的 scenes/ 目录，且名字加前缀避免撞到真实场景，跑完即删。
 */
const SCENE_DIR = join(ROOT, 'scenes');
const createdScenes = [];
function withSceneDir(_dir, scenes) {
  for (const [name, body] of Object.entries(scenes)) {
    const f = join(SCENE_DIR, `__probe_${name}.json5`);
    writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body));
    createdScenes.push(f);
  }
  return SCENE_DIR;
}
function cleanupScenes() {
  for (const f of createdScenes) { try { rmSync(f, { force: true }); } catch { /* 清理失败不影响判据 */ } }
  createdScenes.length = 0;
}

/**
 * 可编程失败的配置服务：前 failTimes 次**落盘**抛错；set 只进内存。
 *
 * 判据统计的是"落盘**尝试**次数"，不绑死 `setAndSave` 这个名字 ——
 * 上一版探针只数 setAndSave，产品改成 save() 之后判据立刻失明，
 * 把"已经修好"读成了"调用 0 次"。那正是同一类"判据看不见目标"的错误。
 */
function makeFlakyConfig({ failTimes = 1 } = {}) {
  const mem = new Map();
  const disk = new Map();
  let attempts = 0;
  const commit = () => {
    attempts += 1;
    if (attempts <= failTimes) throw new Error('disk full (injected)');
    for (const [k, v] of mem) disk.set(k, v);
  };
  return {
    attempts: () => attempts,                       // 落盘尝试次数（无论走哪个 API）
    disk: () => Object.fromEntries(disk),
    async set(k, v) { mem.set(k, v); },
    async get(k) { return mem.get(k); },
    // 兼容只认 setAndSave 的调用方
    async setAndSave(k, v) { mem.set(k, v); commit(); },
    async save() { commit(); },
  };
}

// ═══════════════════════════════════════════════════════════
// INV-01｜handler 已产生副作用，却因抛出的 code 被报成"预执行拒绝"
// ═══════════════════════════════════════════════════════════
await probe('INV-01', 'handler 已产生副作用后抛 capability_denied，不得报 state:denied', async () => {
  const { core, dir } = makeCore();
  const marker = join(dir, 'side-effect.txt');
  let ran = 0;
  core.registerCapability('probe.effectful', {
    owner: 'probe',
    handler: async () => {
      ran += 1;
      writeFileSync(marker, 'I really ran');
      const err = new Error('downstream says denied');
      err.code = 'capability_denied';      // 拒绝型 code，但执行过了
      throw err;
    },
  });
  const r = await core.callCapability('probe.effectful', {}, { caller: 'test' });
  const hadEffect = existsSync(marker);
  const lied = r.state === 'denied';
  const ok = ran === 1 && hadEffect && !lied;
  rmSync(dir, { recursive: true, force: true });
  return { ok, detail: `handler 运行 ${ran} 次，副作用存在=${hadEffect}，`
    + `state=${JSON.stringify(r.state)} code=${JSON.stringify(r.code)}`
    + `${lied ? ' ⇒ 【缺陷】已执行却被报成预执行拒绝' : ''}` };
});

// ═══════════════════════════════════════════════════════════
// INV-02（正例）｜真正的 pre-dispatch 拒绝，handler 必须 0 次执行
// INV-01 的反向判据：防止"一律不许 denied"式假修复
// ═══════════════════════════════════════════════════════════
await probe('INV-02', '真正预执行拒绝：handler 执行 0 次且 state 仍为 denied', async () => {
  const { core, dir } = makeCore();
  let ran = 0;
  // 真实机制：permissions.scope + 受信主体登记（不是 roles）
  core.registerCapability('probe.guarded', {
    owner: 'probe',
    permissions: { scope: 'admin' },
    handler: async () => { ran += 1; return 'ok'; },
  });
  // 未登记 principal ⇒ 身份未经证实 ⇒ pre-dispatch 拒绝
  const r = await core.callCapability('probe.guarded', {}, { caller: 'nobody', principal: 'ghost' });
  rmSync(dir, { recursive: true, force: true });
  const ok = ran === 0 && r.state === 'denied';
  return { ok, detail: `handler 运行 ${ran} 次（应 0），state=${JSON.stringify(r.state)}（应 denied）` };
});

// ═══════════════════════════════════════════════════════════
// INV-02b｜**v0.15.1 反转**：v0.15 这条"反向判据"本身是错的
//
// v0.15 的判据是：handler 只抛 out_of_bounds、什么都没碰 ⇒ 必须仍是 denied。
// 专家 ERR-015 证明它**不可判定**：Core 手上只有一个字符串，无从知道 handler 在抛之前
// 是否碰过资源。要求 Core 按 code 相信"这是副作用前的拒绝"，等于让它相信插件自报的阶段。
// 真实例证（工具自身实现）仍然成立 —— tool.read 先 resolveWorkspacePath（:48）再
// readFile（:55），越界时零副作用；但那是**工具的事实**，不是 Core 能背书的**全局语义**。
//
// 现在反向钉住：handler 抛出的拒绝码一律 failed + dispatched:true +
// side_effect:'unknown_or_possible'。真正的 pre-dispatch 拒绝仍必须是 denied —— 见 INV-02，
// 以及 test/probes/r016-err015-sc015.mjs 的完整矩阵。
// ═══════════════════════════════════════════════════════════
await probe('INV-02b', 'handler 抛出的拒绝码不得宣称"执行前"（v0.15.1 反转）', async () => {
  const { core, dir } = makeCore();
  core.registerCapability('probe.boundsFirst', {
    owner: 'probe',
    handler: async () => {
      // 模拟"先做边界检查、不碰任何资源，然后拒绝"——**但这只是插件的说法**
      const err = new Error('path escapes the workspace');
      err.code = 'out_of_bounds';
      throw err;
    },
  });
  const r = await core.callCapability('probe.boundsFirst', {}, { caller: 't' });
  rmSync(dir, { recursive: true, force: true });
  const ok = r.state === 'failed' && r.code === 'out_of_bounds'
    && r.dispatched === true && r.side_effect === 'unknown_or_possible';
  return { ok, detail: `state=${JSON.stringify(r.state)}（应 failed）dispatched=${r.dispatched} `
    + `side_effect=${r.side_effect} code=${JSON.stringify(r.code)}`
    + `${r.state === 'denied' ? ' ⇒ 【缺陷】仅凭 code 就宣称零副作用' : ''}` };
});

// ═══════════════════════════════════════════════════════════
// INV-03｜纯抛出 / 副作用后抛出，都必须 failed
// ═══════════════════════════════════════════════════════════
await probe('INV-03', '普通 handler_threw 与副作用后抛出都不得归 denied', async () => {
  const { core, dir } = makeCore();
  const a = join(dir, 'a.txt');
  core.registerCapability('probe.plainThrow', {
    owner: 'probe', handler: async () => { throw new Error('boom'); },
  });
  core.registerCapability('probe.threwAfterEffect', {
    owner: 'probe',
    handler: async () => { writeFileSync(a, 'x'); const e = new Error('after'); e.code = 'resource_error'; throw e; },
  });
  const r1 = await core.callCapability('probe.plainThrow', {}, { caller: 't' });
  const r2 = await core.callCapability('probe.threwAfterEffect', {}, { caller: 't' });
  const hadEffect = existsSync(a);
  rmSync(dir, { recursive: true, force: true });
  const ok = r1.state === 'failed' && r2.state === 'failed' && hadEffect;
  return { ok, detail: `plainThrow=${JSON.stringify(r1.state)} threwAfterEffect=${JSON.stringify(r2.state)} `
    + `副作用存在=${hadEffect}` };
});

// ═══════════════════════════════════════════════════════════
// INV-04｜软超时：Waiter 超时 ≠ Attempt 结束
// ═══════════════════════════════════════════════════════════
await probe('INV-04', '软超时后 in-flight 仍 > 0，settle 后归零', async () => {
  const { core, dir } = makeCore();
  let release;
  const gate = new Promise((r) => { release = r; });
  let settled = false;
  core.registerCapability('probe.slow', {
    owner: 'probe',
    handler: async () => { await gate; settled = true; return 'done'; },
  });
  // 超时只存在于 command() 的第三个位置参数（callCapability 无超时语义）。
  const r = await core.command('probe.slow', {}, 30, { caller: 't' });
  const during = core._inflight.get('probe') || 0;
  release();
  await new Promise((rr) => setTimeout(rr, 100));
  const after = core._inflight.get('probe') || 0;
  rmSync(dir, { recursive: true, force: true });
  const ok = during > 0 && after === 0 && r.execution_outcome === 'unknown' && settled;
  return { ok, detail: `超时返回时 in-flight=${during}（应>0），settle 后=${after}（应=0），`
    + `execution_outcome=${JSON.stringify(r.execution_outcome)}` };
});

// ═══════════════════════════════════════════════════════════
// SC 组
// ═══════════════════════════════════════════════════════════
/** 空场景会让第一次切换立即命中 unchanged 早返回，测不到提交路径 —— 必须有真实声明。 */
const WITH_PLUGINS = { plugins: ['pa'], eager: [], lazy: [] };
const STUB_PM = { isResolvable: () => true, loadOne: async () => ({ ok: true }), unload: async () => ({ ok: true }) };

async function sceneRun(scenes, { failTimes = 0, switches, pm } = {}) {
  const { core, dir } = makeCore();
  const cfg = makeFlakyConfig({ failTimes });
  core.registerService('config', cfg, { pluginName: 'config' });
  withSceneDir(dir, scenes);
  const sc = new SceneController(core, pm || STUB_PM);
  const outs = [];
  for (const [n, o] of switches) outs.push(await sc.switchTo(n, o));
  const calls = cfg.attempts();
  const disk = cfg.disk();
  cleanupScenes();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响判据 */ }
  return { outs, calls, disk };
}

await probe('SC-01', '持久化失败后，同名重试必须还有提交机会', async () => {
  const r = await sceneRun({ A: WITH_PLUGINS }, {
    failTimes: 1,
    switches: [['__probe_A', { yes: true, deferAssembly: true }], ['__probe_A', { yes: true, deferAssembly: true }]],
  });
  const [r1, r2] = r.outs;
  const ok = r.calls >= 2;
  return { ok, detail: `第一次=${r1.code || 'ok'}，第二次 ok=${!!r2.ok} unchanged=${!!r2.unchanged}；`
    + `setAndSave 实际调用 ${r.calls} 次（应 ≥2）`
    + `${!ok ? ' ⇒ 【缺陷】失败后再也拿不到提交机会' : ''}` };
});

await probe('SC-02', 'deferAssembly 下任何路径都不得返回 verified:true', async () => {
  const r = await sceneRun({ B: WITH_PLUGINS }, {
    switches: [['__probe_B', { yes: true, deferAssembly: true }], ['__probe_B', { yes: true, deferAssembly: true }]],
  });
  const [r1, r2] = r.outs;
  const ok = r1.verified === false && r2.verified === false;
  return { ok, detail: `第一次 verified=${JSON.stringify(r1.verified)}，第二次 verified=${JSON.stringify(r2.verified)} `
    + `verification=${JSON.stringify(r2.verification)}`
    + `${r2.verified === true ? ' ⇒ 【缺陷】没装配没核验却报 verified:true' : ''}` };
});

await probe('SC-03', '仅声明 lazy 的插件，切场景时不得被装成 running', async () => {
  const { core, dir } = makeCore();
  const cfg = makeFlakyConfig({ failTimes: 0 });
  core.registerService('config', cfg, { pluginName: 'config' });
  withSceneDir(dir, { L: { plugins: [], eager: [], lazy: ['lazyone'] } });
  core.plugins.set('lazyone', { name: 'lazyone', state: 'registered', async start() {} });
  const sc = new SceneController(core, {
    isResolvable: () => true,
    loadOne: async (n) => {
      const p = core.plugins.get(n);
      if (p) core.lifecycle.advance(p, 'running');
      return { ok: true };
    },
    unload: async () => ({ ok: true }),
  });
  await sc.switchTo('__probe_L', { yes: true });
  const st = core.plugins.get('lazyone')?.state;
  cleanupScenes();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 同上 */ }
  return { ok: st !== 'running', detail: `切换后 lazyone.state=${JSON.stringify(st)}`
    + `${st === 'running' ? ' ⇒ 【缺陷/待裁决】"lazy" 被当场装成 running' : ''}` };
});

await probe('SC-04', 'persisted:true 必须意味着本次要写的全部配置都已落盘', async () => {
  // 这条必须用**严格快照桩**：`setAndSave` 落盘、`save` 落盘，两者互不补台。
  // 上一版用宽松桩（save 会把内存全部刷一遍），于是"先 setAndSave 再 set 默认键"的顺序缺陷
  // 被后一次 save 掩盖 —— 变异 M30 全绿，正是"判据看不见目标"。严格桩下每次落盘只写
  // **调用当时**要求写的那个键，顺序错了就立刻暴露。
  const mem = new Map();
  const disk = new Map();
  let commits = 0;
  const strictCfg = {
    commits: () => commits,
    disk: () => Object.fromEntries(disk),
    async set(k, v) { mem.set(k, v); },
    async get(k) { return mem.get(k); },
    async setAndSave(k, v) { commits += 1; mem.set(k, v); disk.set(k, v); },   // 只落这一个键
    async save() { commits += 1; for (const [k, v] of mem) disk.set(k, v); },
  };

  const { core, dir } = makeCore();
  core.registerService('config', strictCfg, { pluginName: 'config' });
  withSceneDir(dir, { D: { plugins: [], eager: [], lazy: [], defaultConfig: { theme: 'dark', autoSave: true } } });
  const sc = new SceneController(core, STUB_PM);
  const out = await sc.switchTo('__probe_D', { yes: true, deferAssembly: true });
  cleanupScenes();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响判据 */ }

  const hasAll = 'theme' in strictCfg.disk() && 'autoSave' in strictCfg.disk();
  const ok = !(out.persisted === true && !hasAll);
  return { ok, detail: `persisted=${JSON.stringify(out.persisted)}，落盘键=${JSON.stringify(Object.keys(strictCfg.disk()))}`
    + `，落盘次数=${strictCfg.commits()}`
    + `${out.persisted === true && !hasAll ? ' ⇒ 【缺陷】报持久成功但默认配置没落盘' : ''}` };
});

await probe('SC-05', '正常无变化请求不得重复写盘（SC-01 的反向判据）', async () => {
  const r = await sceneRun({ N: WITH_PLUGINS }, {
    switches: [['__probe_N', { yes: true, deferAssembly: true }], ['__probe_N', { yes: true, deferAssembly: true }]],
  });
  const r2 = r.outs[1];
  const ok = r.calls === 1 && r2.unchanged === true;
  return { ok, detail: `两次切换后 setAndSave 累计 ${r.calls} 次（应=1）；第二次 unchanged=${JSON.stringify(r2.unchanged)}`
    + `${r.calls > 1 ? ' ⇒ 【退化】无变化请求重复写盘' : ''}` };
});

// ───────────────────────────────────────────────────────────
const fixed = results.filter((r) => r.status === 'FIXED').length;
const broken = results.filter((r) => r.status === 'BROKEN').length;
const errs = results.filter((r) => r.status === 'PROBE-ERROR').length;
console.log('\n' + '═'.repeat(74));
console.log('专家 0.14.1-post 复审 · 新增反例复现');
console.log('═'.repeat(74));
for (const r of results) {
  console.log(`  ${r.status.padEnd(11)} ${r.id}  ${r.title}`);
  console.log(`              ${r.detail}`);
}
console.log('─'.repeat(74));
console.log(`合计 ${results.length}：${fixed} 已修 / ${broken} 仍缺陷 / ${errs} 探针自身出错`);
if (errs) console.log('⚠ 探针自身出错的不计入"已修"，必须先修探针再判断。');
console.log('═'.repeat(74) + '\n');
process.exit(errs ? 2 : (broken === 0 ? 0 : 1));
