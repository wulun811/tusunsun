/**
 * R1-01（v0.15.3）：**跨状态机提交边界**的回归锁。
 *
 * 对应专家《0.15.2 发布前独立深审》§2 的四条反例里属于 R1 的三条：
 *   X01 停止之后，迟到懒加载重新公布能力   （装配的**提交时机**）
 *   X02 同名注册被拒后，未登记实例仍完成初始化（对象的**归属**）
 *   X03 启动期 lazy 源索引跨场景残留        （装配的**有效范围**）
 * X04（服务 owner 漂移）属 R2，不在这里。
 *
 * 三条共用一个根因，也正是本轮唯一新增的机制：**装配成功 ≠ 有权提交**。
 * 修法是一个整数（`Core._epoch`）+ 一条闸门（`isAssemblyCurrent`），
 * 没有新增 Manager、没有第四个状态机、没有可配置转移表。
 *
 * 纪律（延续 LAZY-01～04）：
 *   ① 每条缺陷配**合法正例**，防"一律拒绝/一律降级"式假修复；
 *   ② 顺序由 **Promise barrier** 控制，不靠固定睡眠（专家 §6.3）；
 *   ③ 计数点放在**真实装配出口**，不放在被测判据自己身上；
 *   ④ 断言失败必须能说出"哪一件事被谁看见了"（每条 assert 都带消息）。
 */
import { TestRunner } from '../harness.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Core } from '../../src/core/core.js';
import { PluginManager } from '../../src/core/plugin-manager.js';
import { LifecycleManager } from '../../src/core/lifecycle-manager.js';
import { SceneController } from '../../src/core/scene-controller.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => sleep(0);

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

async function waitFor(pred, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await sleep(1);
  }
  return pred();
}

/** 调用一次能力，**不抛**：抛了也记下来（"漏成异常"本身就是一种缺陷形状）。 */
async function callSafely(core, id, params = {}) {
  try { return { threw: false, res: await core.callCapability(id, params) }; }
  catch (e) { return { threw: true, err: e }; }
}

export async function setup(runner) {
  let tmp;
  let hosts;

  const PLUGINS = {
    // X01：init 卡在 barrier 上，gate 由用例在**另一个状态机转移之后**才放行。
    'slow.js': `export class Slow {
  name = 'slow';
  version = '1.0.0';
  provides = ['slow.work'];
  async init(core) {
    globalThis.__r1.inits += 1;
    await globalThis.__r1.gate;
    if (globalThis.__r1.fail) throw new Error('init-intentionally-failed');
    core.registerCapability('slow.work', { owner: 'slow', handler: () => 'slow-done' });
  }
  async stop() { globalThis.__r1.stops += 1; }
}
export default new Slow();
`,
    // R1-05/2：**先注册、再等待** —— 专家明确点名的"假修复"入口：
    // 只在 init 返回之后看 core.running，是拦不住这一条的。
    'early.js': `export class Early {
  name = 'early';
  version = '1.0.0';
  provides = ['early.work'];
  async init(core) {
    globalThis.__r1.inits += 1;
    core.registerCapability('early.work', { owner: 'early', handler: () => 'early-done' });
    core.registerService('early-svc', { name: 'early' });
    await globalThis.__r1.gate;
  }
  async stop() { globalThis.__r1.stops += 1; }
}
export default new Early();
`,
    // R1-05/4：eager 插件，start() 卡 barrier —— 用来测"stop 期间正在 start"。
    'eager.js': `export class Eager {
  name = 'eager';
  version = '1.0.0';
  provides = ['eager.work'];
  async init(core) { globalThis.__r1.eagerInits += 1; }
  async start() { await globalThis.__r1.gate; }
  async stop() { globalThis.__r1.stops += 1; }
}
export default new Eager();
`,
    'legacy.js': `export class Legacy {
  name = 'legacy';
  version = '1.0.0';
  provides = ['legacy.work'];
  async init(core) {
    globalThis.__r1.legacyInits += 1;
    core.registerCapability('legacy.work', { owner: 'legacy', handler: () => 'legacy-done' });
  }
  async stop() {}
}
export default new Legacy();
`,
    // X02/4：文件名 dup.js，但对象自报 name='other'。
    'dup.js': `export class Other {
  name = 'other';
  version = '1.0.0';
  provides = ['other.work'];
  async init(core) { globalThis.__r1.otherInits += 1; }
  async stop() {}
}
export default new Other();
`,
    // R1-05/6：init **立即返回**（装配成功），但它在 init 里挂了一条**延迟注册**。
    // 这条注册发生在另一个状态机转移之后，而且不在 `_load` 的 catch 覆盖范围内 ——
    // 它是 `registerCapability` 那一道闸门**唯一**能被单独验证的场景。
    'late.js': `export class Late {
  name = 'late';
  version = '1.0.0';
  provides = ['late.work'];
  async init(core) {
    globalThis.__r1.inits += 1;
    globalThis.__r1.late = globalThis.__r1.gate.then(() => {
      try {
        core.registerCapability('late.work', { owner: 'late', handler: () => 'late-done' });
        globalThis.__r1.lateOk = true;
      } catch (e) { globalThis.__r1.lateErr = e; }
    });
  }
  async stop() { globalThis.__r1.stops += 1; }
}
export default new Late();
`,
  };

  const makeHost = (opts = {}) => {
    const dir = mkdtempSync(join(tmp, 'host-'));
    const plugDir = join(dir, 'plugins');
    mkdirSync(plugDir, { recursive: true });
    for (const [f, src] of Object.entries(PLUGINS)) writeFileSync(join(plugDir, f), src);
    const gate = deferred();
    globalThis.__r1 = {
      inits: 0, stops: 0, legacyInits: 0, otherInits: 0, eagerInits: 0,
      gate: gate.promise, fail: false,
    };
    const core = new Core({ stateDir: dir });
    core.log = () => {};
    // 收尾窗口调小：合同不随窗口长短改变，但 800ms × 18 条用例会拖慢套件。
    core._stopAssemblyDrainMs = opts.drainMs ?? 50;
    const pm = new PluginManager(core);
    pm.dirs = [plugDir];
    pm._loadTimeoutMs = opts.timeout ?? 60;
    // 场景用注入的声明（与既有 K-04 系列同一个做法），不写真实 scenes/ 目录。
    const sc = new SceneController(core, pm);
    sc.findScene = async (n) => opts.scenes?.[n] ?? null;
    // `switchTo` 的持久化段需要一个 config 服务；这里给一个只读桩。
    core._services.set('config', { get: () => null, set: () => {}, setAndSave: async () => {} });
    const host = { core, pm, sc, dir, plugDir, gate };
    hosts.push(host);
    return host;
  };

  runner.beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'tusunsun-r1-'));
    hosts = [];
  });

  runner.afterEach(() => {
    for (const h of hosts) {
      try { h.pm._stopIdleTimer?.(); } catch { /* 老版本没有该方法 */ }
    }
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    hosts = [];
  });

  // ═══════════════════════════════════════════════════════════════
  // X01 —— 停止之后，迟到懒加载重新公布能力
  // ═══════════════════════════════════════════════════════════════
  runner.test('X01/1 停止后迟到 init 完成：不得变成 running，不得发布可派发的能力', async () => {
    const { core, pm, gate } = makeHost({ timeout: 50 });
    await pm.loadAll([], ['slow']);
    await core.start();
    const call1 = callSafely(core, 'slow.work');          // 触发懒装配，卡在 barrier
    await waitFor(() => core.plugins.has('slow'));
    assert.equal(core.plugins.get('slow')?.state, 'registered', '停止前必须确实处于 registered（否则测的不是这条路径）');
    const r1 = await call1;                                // 等候超时
    const attempt = pm._loading.get('slow');
    await core.stop();                                     // ← 另一个状态机转移
    assert.equal(core.running, false, 'stop 之后 running 必须为 false');
    gate.resolve();                                        // ← 迟到完成
    await attempt?.catch(() => {});
    await tick();
    assert.notEqual(core.plugins.get('slow')?.state, 'running',
      '迟到完成的装配不得把对象变成 running（修前实测正是 running）');
    const r2 = await callSafely(core, 'slow.work');
    assert.equal(r2.res?.ok, false, '停止之后不得再派发能力（修前实测 succeeded）');
    assert.equal(r2.res?.code, 'core_not_running', '拒绝必须具名，不能吞成 capability_not_found');
    assert.equal(r1.res?.code, 'lazy_load_timeout', '首次调用仍是"等候超时"，不得因停止而改口径');
  });

  runner.test('X01/2 停止期间装配抛错：不得留下 running，也不得把失败报成成功', async () => {
    const { core, pm, gate } = makeHost({ timeout: 50 });
    globalThis.__r1.fail = true;
    await pm.loadAll([], ['slow']);
    await core.start();
    const call1 = callSafely(core, 'slow.work');
    await waitFor(() => core.plugins.has('slow'));
    const r1 = await call1;
    const attempt = pm._loading.get('slow');
    await core.stop();
    gate.resolve();
    let threw = null;
    try { await attempt; } catch (e) { threw = e; }
    await tick();
    assert.equal(r1.res?.ok, false, '首次调用不得因为"正在停止"而报成功');
    assert.notEqual(core.plugins.get('slow')?.state, 'running', '失败装配不得停在 running');
    assert.notEqual(threw, null, '真实装载失败必须让 Attempt reject（迟到对账靠它）');
  });

  runner.test('X01/3 【正例】正常启动→懒加载完成→停止：能力可用且 plugin.stop 恰好一次', async () => {
    const { core, pm, gate } = makeHost({ timeout: 2000 });
    await pm.loadAll([], ['slow']);
    await core.start();
    gate.resolve();                                        // 装配正常完成
    const r1 = await callSafely(core, 'slow.work');
    assert.equal(r1.res?.ok, true, '正常运行中的懒加载不得被停止闸门误伤');
    assert.equal(r1.res?.payload, 'slow-done');
    await core.stop();
    assert.equal(globalThis.__r1.stops, 1, 'plugin.stop 必须恰好一次');
    assert.equal(core.plugins.get('slow')?.state, 'stopped', '正常停止后状态必须是 stopped');
  });

  runner.test('X01/4 停止后 callCapability 与 command 都必须拒绝', async () => {
    const { core, pm, gate } = makeHost({ timeout: 2000 });
    await pm.loadAll([], ['slow']);
    await core.start();
    gate.resolve();
    await callSafely(core, 'slow.work');
    await core.stop();
    const r2 = await callSafely(core, 'slow.work');
    const cmd = await core.command('slow.work', {}, 300);
    assert.equal(r2.res?.ok, false, '停止后 callCapability 不得派发');
    assert.equal(cmd?.ok, false, '停止后 command 不得派发（两条入口的拒绝条件必须一致）');
    assert.equal(r2.res?.dispatched, false, '派发前拒绝必须写 dispatched:false');
    assert.equal(r2.res?.side_effect, 'none', 'Core 自己的派发前拒绝可以承诺零副作用');
  });

  runner.test('X01/5 【正例】二次 stop 幂等：不抛、不重复调用 plugin.stop', async () => {
    const { core, pm, gate } = makeHost({ timeout: 2000 });
    await pm.loadAll([], ['slow']);
    await core.start();
    gate.resolve();
    await callSafely(core, 'slow.work');
    await core.stop();
    await core.stop();
    assert.equal(globalThis.__r1.stops, 1, '二次 stop 不得再调一次 plugin.stop');
  });

  runner.test('X01/6 【正例】无在途装配时 stop 立即返回，outstandingAssembly 为空', async () => {
    const { core } = makeHost({ drainMs: 5000 });
    await core.start();
    const t0 = Date.now();
    const seen = [];
    core.once('core.stopped', (p) => seen.push(p));
    await core.stop();
    const took = Date.now() - t0;
    assert.ok(took < 1000, `没有在途装配时不得等满收尾窗口（实测 ${took}ms）`);
    assert.deepEqual(seen[0]?.outstandingAssembly, [], '没有在途装配时 outstandingAssembly 必须是空数组');
  });

  // ═══════════════════════════════════════════════════════════════
  // X02 —— 同名注册被拒后，未登记实例仍完成初始化
  // ═══════════════════════════════════════════════════════════════
  runner.test('X02/1 同名不同实例：注册被拒必须在 init 之前中止', async () => {
    const { core } = makeHost();
    const A = { name: 'dup', version: '1.0.0', async init() {}, async start() {}, async stop() {} };
    const B = { name: 'dup', version: '2.0.0', async init() { globalThis.__r1.bInits = (globalThis.__r1.bInits || 0) + 1; }, async start() {}, async stop() {} };
    await core.register(A);
    A.state = 'running';
    await assert.rejects(
      () => core.lifecycle.load(B, core),
      (err) => err.code === 'plugin_name_conflict',
      '同名不同实例必须在 init 之前具名中止（修前实测 init 跑了、state 被写成 running、还返回 ok:true）',
    );
    assert.equal(globalThis.__r1.bInits || 0, 0, 'B 的 init 一次都不许跑');
    assert.notEqual(B.state, 'running', '未被 Core 承认的对象不得报告 running');
    assert.equal(core.plugins.get('dup'), A, 'Map 里必须仍是 A');
  });

  runner.test('X02/2 同一实例重复 load：必须幂等，不得再次 init', async () => {
    const { core } = makeHost();
    let inits = 0;
    const A = { name: 'dup', version: '1.0.0', async init() { inits += 1; }, async start() {}, async stop() {} };
    await core.register(A);
    const r1 = await core.lifecycle.load(A, core);
    const r2 = await core.lifecycle.load(A, core);
    assert.equal(r1.ok, true, '首次 load 必须成功');
    assert.equal(r2.ok, true, '同一实例的重复 load 必须幂等（不得变成失败）');
    assert.equal(inits, 1, '重复 load 不得再跑一次 init（修前实测 1 → 2）');
  });

  runner.test('X02/3 【正例】拒绝 B 之后：A 的能力仍可调用，B 的副作用为 0', async () => {
    const { core } = makeHost();
    const A = {
      name: 'dup', version: '1.0.0',
      async init(c) { c.registerCapability('dup.work', { owner: 'dup', handler: () => 'A-done' }); },
      async start() {}, async stop() {},
    };
    await core.register(A);
    await core.lifecycle.load(A, core);
    const B = { name: 'dup', version: '2.0.0', async init() { globalThis.__r1.bInits = (globalThis.__r1.bInits || 0) + 1; }, async start() {}, async stop() {} };
    await core.lifecycle.load(B, core).catch(() => {});
    const r = await callSafely(core, 'dup.work');
    assert.equal(r.res?.payload, 'A-done', '拒绝 B 不得卸掉合法的老实例 A（修前会去 unload(A)）');
    assert.equal(globalThis.__r1.bInits || 0, 0, 'B 的副作用必须为 0');
  });

  runner.test('X02/4 请求名与实现名不一致：loadOne 必须拒绝', async () => {
    const { core, pm } = makeHost();
    const r = await pm.loadOne('dup');
    assert.equal(r.ok, false, '名字不符不得报成装载成功（修前实测 {ok:true,name:"other"}）');
    assert.equal(r.code, 'plugin_name_mismatch', '拒绝必须具名');
    assert.equal(core.plugins.has('other'), false, '不得把 other 装进 Core');
  });

  // ═══════════════════════════════════════════════════════════════
  // X03 —— 启动期 lazy 源索引跨场景残留
  // ═══════════════════════════════════════════════════════════════
  const SCENES = {
    empty: { name: 'empty', eager: [], plugins: [] },
    'with-legacy': { name: 'with-legacy', eager: [], lazy: ['legacy'] },
  };

  runner.test('X03/1 启动期 lazy 索引：切到不声明它的场景后必须撤销', async () => {
    const { core, pm, sc } = makeHost({ scenes: SCENES });
    await pm.loadAll([], ['legacy']);
    assert.equal(pm._pending.has('legacy'), true, '启动后必须确实建立了索引');
    const sw = await sc.switchTo('empty', { yes: true });
    assert.equal(sw.ok, true, '切换本身必须成功');
    assert.equal(pm._pending.has('legacy'), false,
      '目标场景不声明它 ⇒ 索引必须撤销（修前 `_sceneLazy` 初值 null，启动期索引永远没人撤）');
    const r = await callSafely(core, 'legacy.work');
    assert.equal(r.res?.ok, false, '旧场景私有的 lazy 不得再被激活（修前实测装载成功）');
    assert.equal(globalThis.__r1.legacyInits, 0, '真实装载次数必须为 0');
  });

  runner.test('X03/2 【正例】目标场景自己声明了该 lazy：必须保留索引且可按需装载', async () => {
    const { core, pm, sc } = makeHost({ scenes: SCENES });
    await pm.loadAll([], ['legacy']);
    const sw = await sc.switchTo('with-legacy', { yes: true });
    assert.equal(sw.ok, true);
    assert.equal(pm._pending.has('legacy'), true, '多场景共同声明的来源不得被误删');
    const r = await callSafely(core, 'legacy.work');
    assert.equal(r.res?.ok, true, '合法共享的 lazy 必须仍能按需装载');
  });

  runner.test('X03/3 【正例】往返：boot lazy → empty（撤销）→ with-legacy（重建）→ 可用', async () => {
    const { core, pm, sc } = makeHost({ scenes: SCENES });
    await pm.loadAll([], ['legacy']);
    await sc.switchTo('empty', { yes: true });
    assert.equal(pm._pending.has('legacy'), false, '切出后必须撤销');
    await sc.switchTo('with-legacy', { yes: true });
    assert.equal(pm._pending.has('legacy'), true, '切回后必须重建');
    const r = await callSafely(core, 'legacy.work');
    assert.equal(r.res?.ok, true, '重建之后必须可用（撤销不能是不可逆的）');
  });

  // ═══════════════════════════════════════════════════════════════
  // R1-05：组合反例（专家 §6.1 的矩阵里最容易漏的几格）
  // ═══════════════════════════════════════════════════════════════
  runner.test('R1-05/1 多等候方 + 停止：只允许一笔真实装载，停止后无人拿到成功', async () => {
    const { core, pm, gate } = makeHost({ timeout: 40 });
    await pm.loadAll([], ['slow']);
    await core.start();
    const calls = [callSafely(core, 'slow.work'), callSafely(core, 'slow.work'), callSafely(core, 'slow.work')];
    await waitFor(() => core.plugins.has('slow'));
    const attempt = pm._loading.get('slow');
    const rs = await Promise.all(calls);
    await core.stop();
    gate.resolve();
    await attempt?.catch(() => {});
    await tick();
    assert.equal(globalThis.__r1.inits, 1, '三个等候方只能对应一笔真实装载（LAZY-03 的并发形态）');
    for (const r of rs) assert.equal(r.res?.ok, false, '停止前等候超时的三个调用都不得报成功');
    assert.notEqual(core.plugins.get('slow')?.state, 'running', '停止后不得复活');
  });

  runner.test('R1-05/2 init 先注册能力再等待：停止后该能力必须被撤销', async () => {
    const { core, pm, gate } = makeHost({ timeout: 40 });
    await pm.loadAll([], ['early']);
    await core.start();
    const call1 = callSafely(core, 'early.work');
    // 关键：能力在**等待之前**就已经注册了 —— 只检查"init 返回后 core.running"的修法拦不住它。
    assert.equal(await waitFor(() => core._capabilities.has('early.work')), true, '必须确实先注册过（否则测的不是这条路径）');
    const attempt = pm._loading.get('early');
    await call1;
    await core.stop();
    gate.resolve();
    await attempt?.catch(() => {});
    await tick();
    assert.equal(core._capabilities.has('early.work'), false,
      '停止之后，迟到装配在 init 里注册的能力必须被收回（不是回滚外部副作用，是收回已发布的登记）');
    assert.equal(core._services.has('early-svc'), false, '服务同理');
    assert.notEqual(core.plugins.get('early')?.state, 'running');
  });

  runner.test('R1-05/3 stop 期间正在 start 的 eager 插件：不得成为 running', async () => {
    const { core, gate } = makeHost();
    const { readFileSync } = await import('node:fs');
    const { pathToFileURL } = await import('node:url');
    const mod = await import(`${pathToFileURL(join(hosts[0].plugDir, 'eager.js')).href}?t=${Date.now()}`);
    void readFileSync;
    const plugin = mod.default;
    await core.register(plugin);
    const starting = core.start();                      // 会在 plugin.start() 里卡住
    assert.equal(await waitFor(() => plugin.state === 'started'), true, '必须确实进入 started（否则测的不是这条路径）');
    await core.stop();
    gate.resolve();
    await starting.catch(() => {});
    await tick();
    assert.notEqual(plugin.state, 'running', '停止期间完成的 eager 装配同样不得提交');
  });

  runner.test('R1-05/4 停止之后原地 restart：必须具名拒绝，不得半启动', async () => {
    const { core, pm, gate } = makeHost({ timeout: 2000 });
    await pm.loadAll([], ['slow']);
    await core.start();
    gate.resolve();
    await callSafely(core, 'slow.work');
    await core.stop();
    // 产品裁决（v0.15.3）：插件是模块级单例，原地重启会撞上它自己上次注册的能力。
    // 所以这里要的是**具名拒绝**，不是"试着重启然后半启动"。
    await assert.rejects(
      () => core.start(),
      (err) => err.code === 'core_restart_not_supported',
      '原地重启必须具名拒绝（修前会进入半启动：部分插件 init 失败、部分成功）',
    );
    assert.equal(core.running, false, '拒绝之后必须仍然处于已停止');
    const r = await callSafely(core, 'slow.work');
    assert.equal(r.res?.ok, false, '拒绝重启之后也不得派发');
  });

  runner.test('R1-05/6 init 里挂起的延迟注册：Core 已停止后不得漏进去（闸门的单独验证）', async () => {
    // 这条用例是 MUT-R1c 抓出来的洞：只靠 `_load` 的 catch + 精确撤销，也能让 X01/1 变绿；
    // 那样 `registerCapability` 的世代闸门就是冗余的，被删掉也不会有人发现。
    // 但装配**成功之后**才发生的注册不在 catch 覆盖范围内 —— 只有闸门能拦。
    // 先验证“运行中允许”（否则闸门可能是“一律拒绝”的假修复）。
    const ok1 = makeHost();
    await ok1.pm.loadAll([], ['late']);
    await ok1.core.start();
    await ok1.pm._lazyLoadOne('late');
    ok1.gate.resolve();
    await globalThis.__r1.late;
    assert.equal(globalThis.__r1.lateOk, true, '运行中挂起的延迟注册必须被允许（闸门不是“一律拒绝”）');
    assert.equal(ok1.core._capabilities.has('late.work'), true);
    await ok1.core.stop();

    // 再验证“停止之后拒绝”。
    const h = makeHost();
    await h.pm.loadAll([], ['late']);
    await h.core.start();
    await h.pm._lazyLoadOne('late');
    assert.equal(h.core.plugins.get('late')?.state, 'running', '装配本身必须先成功（否则测的是另一条路径）');
    await h.core.stop();
    h.gate.resolve();
    await globalThis.__r1.late;
    await tick();
    assert.equal(h.core._capabilities.has('late.work'), false,
      'Core 已停止后，init 里挂起的注册不得漏进去（装配已结束，没有 catch 能收它）');
    assert.equal(globalThis.__r1.lateErr?.code, 'assembly_superseded', '拒绝必须具名');
  });

  runner.test('R1-05/5 停止时的 outstanding_assembly 如实上报，且此后仍不发布能力', async () => {
    const { core, pm, gate } = makeHost({ timeout: 40, drainMs: 40 });
    await pm.loadAll([], ['slow']);
    await core.start();
    const call1 = callSafely(core, 'slow.work');
    await waitFor(() => core.plugins.has('slow'));
    const attempt = pm._loading.get('slow');
    let payload = null;
    core.once('core.stopped', (p) => { payload = p; });
    await call1;
    await core.stop();                                   // 窗口内不会完成
    assert.equal(Array.isArray(payload?.outstandingAssembly), true, 'core.stopped 必须带 outstandingAssembly');
    assert.equal(payload.outstandingAssembly.length, 1, '卡住的装配必须被逐条列出，不能只说"已停止"');
    assert.equal(payload.outstandingAssembly[0].name, 'slow');
    gate.resolve();
    await attempt?.catch(() => {});
    await tick();
    assert.equal(core._capabilities.has('slow.work'), false, '上报 outstanding 之后仍然不得发布能力');
  });
}
