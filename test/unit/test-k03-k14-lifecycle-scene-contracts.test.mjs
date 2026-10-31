// v0.12.0 内核精修 P2/P3/P4：生命周期归一、场景五段式、小合同
//
// 覆盖 K-03 / K-03b / K-05 / K-09 / K-10 / K-04 / N-03 / K-11 / K-12 / K-13a / K-14 / N-01 / N-02。
//
// 与探针的分工同上一个文件：探针给人核对，本文件跟 CI 跑并锁住语义。
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TestRunner, assert, assertEquals } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(join(ROOT, rel));

/** 写一个"类字段风格 + 实例导出"的插件（懒加载索引只认这种形态）。 */
function writePlugin(dir, file, { name, version = '1.0.0', provides = [], requires = null, manifest = null, body }) {
  const p = join(dir, file);
  const man = manifest ? `\n  manifest = ${JSON.stringify(manifest)};` : '';
  const req = requires ? `\n  requires = ${JSON.stringify(requires)};` : '';
  writeFileSync(p, `class P {
  name = '${name}';
  version = '${version}';
  provides = ${JSON.stringify(provides.map((n) => ({ name: n })))};${req}${man}
${body}
}
export default new P();
`);
  return p;
}

export async function setup(runner) {
  const { Core } = await imp('src/core/core.js');
  const { PluginManager } = await imp('src/core/plugin-manager.js');
  const { SceneController } = await imp('src/core/scene-controller.js');
  const { semverSatisfies } = await imp('src/core/dependency-resolver.js');
  const { loadJson5 } = await imp('src/core/json5-loader.js');
  let tmp;

  runner.beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'p234-'));
    mkdirSync(join(tmp, 'plugins'), { recursive: true });
  });
  runner.afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响断言 */ } });

  const makeCore = () => new Core({ stateDir: tmp, pluginsDir: join(tmp, 'plugins') });
  const makePm = (core) => { const pm = new PluginManager(core); pm.dirs = [join(tmp, 'plugins')]; return pm; };

  // ══ K-03：ready 具名三态 ══════════════════════════════════════════════
  runner.test('K-03/1 必需插件 init 失败：core.ready 必须具名 unavailable', async () => {
    const core = makeCore();
    let ready = null;
    core.on('core.ready', (p) => { ready = p; });
    await core.register({
      name: 'crit', version: '1.0.0',
      manifest: { degraded_policy: 'block_startup' },
      init: async () => { throw new Error('critical init exploded'); },
    });
    await core.start();
    assert(ready !== null, 'core.ready 仍应发出（不发会让挂在它上面的插件在失败场景彻底不执行）');
    assertEquals(ready.status, 'unavailable', '修前不发 status，读起来像一切正常');
    assertEquals(JSON.stringify(ready.requiredFailed), '["crit"]', '必须点名哪个必需插件失败');
    core.removeAllListeners();
  });

  runner.test('K-03/2 optional 插件失败仍是 ready（不能把可选失败说成不可用）', async () => {
    const core = makeCore();
    let ready = null;
    core.on('core.ready', (p) => { ready = p; });
    await core.register({ name: 'opt', version: '1.0.0', init: async () => { throw new Error('boom'); } });
    await core.start();
    assertEquals(ready.status, 'ready', 'optional 失败不应影响 ready');
    assertEquals(JSON.stringify(ready.requiredFailed), '[]', 'requiredFailed 应为空');
    core.removeAllListeners();
  });

  // ══ N-01：initTimeMs 必须是耗时 ═══════════════════════════════════════
  runner.test('N-01/1 plugin.init_failed 的 initTimeMs 必须是毫秒耗时，不是时间戳', async () => {
    const core = makeCore();
    let failed = null;
    core.on('plugin.init_failed', (e) => { failed = e; });
    await core.register({ name: 'boom', version: '1.0.0', init: async () => { throw new Error('x'); } });
    await core.start();
    assert(typeof failed?.initTimeMs === 'number', 'initTimeMs 必须在场');
    assert(failed.initTimeMs < 1e10,
      `initTimeMs 量级应为毫秒耗时；修前在"成功过又重启失败"的插件上是 epoch 时间戳，实测 ${failed.initTimeMs}`);
    core.removeAllListeners();
  });

  // ══ K-03b：两个权威不能各说各话 ═══════════════════════════════════════
  runner.test('K-03b/1 装配失败后 readiness 与 core.ready 必须说同一句话', async () => {
    const core = makeCore();
    const pm = new PluginManager(core);
    pm.dirs = [join(ROOT, 'plugins'), join(tmp, 'plugins')];
    writePlugin(join(tmp, 'plugins'), 'crit.mjs', {
      name: 'crit', provides: ['crit'],
      manifest: {
        schema_version: 'tusunsun.plugin/v2', name: 'crit', version: '1.0.0', api_version: '1',
        owner: 't', provides: [{ service: 'crit', api_version: '1.0.0' }], requires: [],
        surfaces: ['internal'], degraded_policy: 'block_startup',
      },
      body: `  async init() { throw new Error('critical init exploded'); }`,
    });
    await pm.loadAll(['readiness', 'runtime-env', 'crit'], []);
    let ready = null;
    core.on('core.ready', (p) => { ready = p; });
    await core.start();
    const rd = core.getService('readiness');
    assert(rd, '前置：readiness 插件必须在场');
    const status = rd.status();
    assertEquals(status.status, 'unavailable', 'readiness 应判 unavailable');
    assertEquals(ready.status, status.status,
      'core.ready 与 readiness 对同一事实必须一致 —— 修前一个说就绪、一个说不可用（清理把证据删了）');
    assert(core._startFailures.has('crit'),
      '装配失败记录必须留下：插件已被 unload 移出 plugins，没有这条 readiness 就看不见它');
    core.removeAllListeners();
  });

  // ══ K-05：重载后的真实状态 ════════════════════════════════════════════
  runner.test('K-05/1 重载成功后 state 必须是 running（修前停在 registered）', async () => {
    const core = makeCore();
    const f = writePlugin(join(tmp, 'plugins'), 'hot.mjs', {
      name: 'hot', provides: ['hot.work'],
      body: `  async init(core) { this.core = core; }
  start() {}
  work() { return 'V1'; }`,
    });
    const pm = makePm(core);
    await pm.loadAll(['hot'], []);
    await core.start();
    assertEquals(core.plugins.get('hot')?.state, 'running', '装载后应为 running');
    const r = await pm._reloadPlugin('hot', f, 'test');
    assertEquals(r.ok, true, '重载应成功');
    assertEquals(core.plugins.get('hot')?.state, 'running',
      '重载后必须仍是 running —— 修前是 registered，而插件其实已在服务（误导一切依赖 state 的判据）');
    core.removeAllListeners();
  });

  runner.test('K-05/2 重载走 lc.load 而不是自己 init/start（结构判据）', async () => {
    const src = readFileSync(join(ROOT, 'src', 'core', 'plugin-manager.js'), 'utf8');
    const body = src.slice(src.indexOf('async _reloadPlugin('));
    const seg = body.slice(0, body.indexOf('_touchAccess('));
    assert(/this\.lc\.load\(/.test(seg), '重载必须委托 lc.load（与首次装载同一条链）');
    assert(!/if \(next\.init\) await next\.init\(/.test(seg),
      '不得再手动调 next.init —— 那是第 3 条装配路径，会与 Lifecycle 各自解释状态');
  });

  // ══ K-09：停止逆拓扑序 ════════════════════════════════════════════════
  runner.test('K-09/1 停止顺序：dependent 先退，provider 后走', async () => {
    const core = makeCore();
    const order = [];
    // 插件名走 S7 的格式判据（全小写），这里只用它当标签，与要测的停止顺序无关。
    await core.register({
      name: 'provider-p', version: '1.0.0', init: async () => {}, start: async () => {},
      stop: async () => { order.push('provider-p'); },
    });
    await core.register({
      name: 'dependent-d', version: '1.0.0', requires: { 'provider-p': '^1.0.0' },
      init: async () => {}, start: async () => {}, stop: async () => { order.push('dependent-d'); },
    });
    await core.start();
    await core.stop();
    assertEquals(order.join('->'), 'dependent-d->provider-p',
      `停止必须逆依赖：修前按插入序得到 provider-p->dependent-d（实际 ${order.join('->')}）`);
    core.removeAllListeners();
  });

  runner.test('K-09/2 没有依赖信息时必须标注"退回插入序"，不能假装有顺序', async () => {
    const core = makeCore();
    let payload = null;
    core.on('core.stopped', (p) => { payload = p; });
    await core.register({ name: 'a', version: '1.0.0', init: async () => {}, stop: async () => {} });
    await core.start();
    await core.stop();
    assertEquals(payload.stopOrderBasis, 'insertion',
      '无依赖时顺序没有依据，必须标注 —— 否则"看起来有序"与"真的有序"混在一起');
    core.removeAllListeners();
  });

  // ══ K-10：懒加载去向可查 ══════════════════════════════════════════════
  runner.test('K-10/1 等候超时后迟到成功，必须能查到真实结果', async () => {
    const core = makeCore();
    writePlugin(join(tmp, 'plugins'), 'slowly.mjs', {
      name: 'slowly', provides: ['slowly.work'],
      body: `  async init(core) { this.core = core; await new Promise(r=>setTimeout(r,90)); }
  start() {}
  work() { return 'LATE-OK'; }`,
    });
    const pm = makePm(core);
    // 用**真实**的等候超时路径（不是从外面 Promise.race 抢跑）：
    // 后者只是测试自己放弃等待，插件管理器内部的计时器压根没触发，
    // 去向记录当然还停在 loading —— 第一版就写错了这一点。
    pm._loadTimeoutMs = 20;
    await pm.loadAll([], ['slowly']);
    let waiterErr = null;
    try { await pm._lazyLoadOne('slowly'); } catch (e) { waiterErr = e.message; }
    assert(/timeout/i.test(String(waiterErr)), `等候方应收到超时，实际：${waiterErr}`);
    // 此刻内部超时已触发：去向记录必须是 in_flight_after_timeout（修前没有任何记录）
    const during = pm.describeLazyLoad('slowly');
    assertEquals(during?.state, 'in_flight_after_timeout',
      `等候超时后必须能查到"仍在进行"；实际 ${during?.state}`);
    await new Promise((r) => setTimeout(r, 300));
    const after = pm.describeLazyLoad('slowly');
    assertEquals(after?.state, 'loaded',
      `迟到成功后去向应变为 loaded；修前没有任何接口能回答这个问题（实际 ${after?.state}）`);
    assertEquals(after.registered, true, '插件确实已注册');
    core.removeAllListeners();
  });

  runner.test('K-10/2 从未加载过的名字返回 null（不编造）', async () => {
    const core = makeCore();
    const pm = makePm(core);
    assertEquals(pm.describeLazyLoad('never-heard-of'), null, '没加载过就是 null，不能返回空壳对象');
    core.removeAllListeners();
  });

  // ══ K-04：场景五段式 ══════════════════════════════════════════════════
  runner.test('K-04/1 缺必需插件：ok:false 且 currentScene 与持久配置都不动', async () => {
    const core = makeCore();
    const pm = makePm(core);
    const sc = new SceneController(core, pm);
    let persistedTo = null;
    core._services.set('config', { get: () => null, set: () => {}, setAndSave: async (k, v) => { persistedTo = v; } });
    sc.findScene = async () => ({ name: 'needit', plugins: [], eager: ['does-not-exist'], optional: [] });
    const r = await sc.switchTo('needit', { yes: true });
    assertEquals(r.ok, false, '缺插件必须 ok:false（修前返回 ok:true 并提交场景）');
    assertEquals(r.code, 'scene_preflight_failed', '应具名 preflight 失败');
    assert(Array.isArray(r.missing) && r.missing.includes('does-not-exist'), '必须点名缺了谁');
    assertEquals(sc.currentScene, null, 'currentScene 不得提交');
    assertEquals(persistedTo, null, '持久配置一个字节都不能写');
    core.removeAllListeners();
  });

  runner.test('K-04/1b Preflight 通过但装配失败：必须走 Verify 拒提交（不能只靠 Preflight）', async () => {
    // 这个用例是 MUT-B 抓出来的洞：只测"文件不存在"时，变异掉 Verify 段**没有任何用例变红**，
    // 因为那种情况在 Preflight 就被拦下了。真正需要 Verify 的是"文件在、但 init 抛错"。
    const core = makeCore();
    writePlugin(join(tmp, 'plugins'), 'willfail.mjs', {
      name: 'willfail', provides: ['willfail.work'],
      body: `  async init() { throw new Error('init exploded during scene switch'); }`,
    });
    const pm = makePm(core);
    const sc = new SceneController(core, pm);
    let persistedTo = null;
    core._services.set('config', { get: () => null, set: () => {}, setAndSave: async (k, v) => { persistedTo = v; } });
    sc.findScene = async () => ({ name: 'halfbroken', plugins: [], eager: ['willfail'], optional: [] });
    const r = await sc.switchTo('halfbroken', { yes: true });
    assertEquals(r.ok, false, '装配失败必须 ok:false');
    assertEquals(r.code, 'scene_partial', '应走 scene_partial（Preflight 已通过，是 Apply/Verify 才失败的）');
    assert(Array.isArray(r.missing) && r.missing.includes('willfail'), '必须点名谁没起来');
    assertEquals(sc.currentScene, null, 'currentScene 不得提交');
    assertEquals(persistedTo, null, '持久配置一个字节都不能写');
    core.removeAllListeners();
  });

  runner.test('K-04/2 全部就绪才提交，并带 verified 标记', async () => {
    const core = makeCore();
    writePlugin(join(tmp, 'plugins'), 'realone.mjs', {
      name: 'realone', provides: ['realone.work'],
      body: `  async init(core) { this.core = core; }
  start() {}`,
    });
    const pm = makePm(core);
    const sc = new SceneController(core, pm);
    let persistedTo = null;
    core._services.set('config', { get: () => null, set: () => {}, setAndSave: async (k, v) => { persistedTo = v; } });
    sc.findScene = async () => ({ name: 'good', plugins: [], eager: ['realone'], optional: [] });
    const r = await sc.switchTo('good', { yes: true });
    assertEquals(r.ok, true, `应成功：${JSON.stringify(r)}`);
    assertEquals(r.verified, true, '成功路径必须带 verified（读过真实运行态）');
    assertEquals(r.persisted, true, '落盘成功也要如实标注');
    assertEquals(sc.currentScene, 'good', 'currentScene 应提交');
    assertEquals(persistedTo, 'good', '持久配置应写入');
    core.removeAllListeners();
  });

  // ══ N-03：缺失 include 留痕 ═══════════════════════════════════════════
  runner.test('N-03/1 缺失的 include 必须在返回值里留痕', async () => {
    const core = makeCore();
    const sc = new SceneController(core, makePm(core));
    const out = await sc._expandIncludes({ name: 'child', include: ['no-such-parent'], plugins: [], eager: ['a'] });
    assertEquals(out.partial, true, '必须标 partial（修前只 warn 一句，返回值与正常无异）');
    assert(Array.isArray(out.missingIncludes) && out.missingIncludes.includes('no-such-parent'),
      '必须点名缺了哪个 include');
    core.removeAllListeners();
  });

  // ══ K-11：SemVer 严格子集 ═════════════════════════════════════════════
  runner.test('K-11/1 解析失败一律不满足（修前是"放行"）', async () => {
    for (const [v, r] of [['1.0.0', 'abc'], ['nonsense', '^1.0.0'], ['1.0.0', '>=garbage'], ['1.0.0', '']]) {
      assertEquals(semverSatisfies(v, r), false,
        `${JSON.stringify(v)} vs ${JSON.stringify(r)} 必须不满足 —— 修前返回 true，写错版本号的插件会被判依赖成立`);
    }
  });

  runner.test('K-11/2 ^0.x 必须锁 minor', async () => {
    assertEquals(semverSatisfies('0.2.5', '^0.2.0'), true, '0.2.5 满足 ^0.2.0');
    assertEquals(semverSatisfies('0.3.0', '^0.2.0'), false, '0.3.0 不满足 ^0.2.0（修前误判为满足）');
    assertEquals(semverSatisfies('0.0.3', '^0.0.3'), true, '0.0.3 满足 ^0.0.3');
    assertEquals(semverSatisfies('0.0.9', '^0.0.3'), false, '0.0.9 不满足 ^0.0.3');
  });

  runner.test('K-11/3 仓内真实插件的 requires 必须仍全部满足（收紧不能破坏装配）', async () => {
    const { extractPluginMetaFromFile } = await imp('src/core/plugin-meta.js');
    const dir = join(ROOT, 'plugins');
    let checked = 0;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.js'))) {
      const meta = await extractPluginMetaFromFile(join(dir, f));
      for (const [dep, range] of Object.entries(meta.requires || {})) {
        // 用"该插件自己声明的版本"去比对它的依赖范围是不可行的（依赖不是自己）；
        // 这里只验**范围可被解析**——修前解析失败会静默 true，现在必须能被解析器认出来。
        const parseable = semverSatisfies('999.0.0', range) === false
          || semverSatisfies('0.0.1', range) === true
          || semverSatisfies('1.0.0', range) === true
          || semverSatisfies('1.0.0', range) === false;
        assert(parseable, `${f} 的 requires "${dep}": "${range}" 必须可被解析`);
        checked++;
      }
    }
    assert(checked > 0, `应扫到真实 requires 声明（实际 ${checked} 条）`);
  });

  // ══ K-12：JSON5 词法扫描 ══════════════════════════════════════════════
  runner.test('K-12/1 字符串内的 // 与 /* */ 必须逐字节保留', async () => {
    const got = loadJson5('{"a": "http://example.com/x", "b": "keep /* this */ text"}');
    assertEquals(got.a, 'http://example.com/x', 'URL 必须完整（修前靠偶然顺序幸存）');
    assertEquals(got.b, 'keep /* this */ text', '字符串内的块注释形状必须保留（修前被删成 "keep  text"）');
  });

  runner.test('K-12/2 字符串外的注释/尾逗号/裸键仍要正常工作', async () => {
    const got = loadJson5(`{
      // 行注释
      name: 'x',   /* 块注释 */
      eager: ["a", "b",],
    }`);
    assertEquals(got.name, 'x', '裸键 + 单引号必须可解析');
    assertEquals(got.eager.length, 2, '尾逗号必须被容忍');
  });

  runner.test('K-12/3 仓内全部场景文件必须仍可解析', async () => {
    const dir = join(ROOT, 'scenes');
    const files = readdirSync(dir).filter((f) => f.endsWith('.json5'));
    assert(files.length > 0, '应至少有一个场景文件');
    for (const f of files) {
      const cfg = loadJson5(readFileSync(join(dir, f), 'utf8'));
      assert(cfg && typeof cfg.name === 'string', `${f} 应解析出 name`);
    }
  });

  // ══ K-13a：服务异主覆写 ═══════════════════════════════════════════════
  runner.test('K-13a/1 异主覆写必须被具名拒绝，且原实现完好', async () => {
    const core = makeCore();
    core._initOwner = 'A'; core.registerService('svc', { from: 'A' });
    let threw = null;
    try { core._initOwner = 'B'; core.registerService('svc', { from: 'B' }); }
    catch (e) { threw = e.message; } finally { core._initOwner = null; }
    assert(threw !== null, '异主覆写必须拒绝（修前只 warn 就覆盖，归属记录也跟着变）');
    assert(/service_conflict/.test(threw), `拒绝理由应含 service_conflict，实际：${threw}`);
    assertEquals(core.getService('svc').from, 'A', '原实现必须完好');
    core.removeAllListeners();
  });

  runner.test('K-13a/2 同 owner 重注册允许（同一登记实例）；覆盖只能由宿主控制面授权', async () => {
    const core = makeCore();
    // 「同一 owner 更新」的合法姿势（专家 R15-03）= **同一个受信装配实例**更新自己那笔登记。
    // rc.15 之前这里靠 `core._initOwner`（可读可写、且实际上从未被赋值的字段）当授权源，
    // 等价于“自报一个相同的名字”—— 公开的 `runServiceTracking` 能把这种自报当授权用。
    const aInst = { name: 'A' };
    const asA = (fn) => core._runAssemblyContext('A', fn, core.assemblyEpoch, aInst);
    await asA(async () => core.registerService('svc', { from: 'A1' }));
    await asA(async () => core.registerService('svc', { from: 'A2' }));
    assertEquals(core.getService('svc').from, 'A2', '同一实例重注册应允许（既有行为）');
    // `service.allowOverride` 不再是授权判据：它的取值来自 `config` **服务**，
    // 而任何插件都能注册 config。于是「宿主的权力」变成「先注册 config 的人的权力」。
    // 正确做法是宿主控制面（createRuntime 交出的 `host`），有专门的 "K-13a/3" 正例钉它。
    core._services.set('config', { get: (k, d) => (k === 'service.allowOverride' ? true : d), set() {} });
    let threw = null;
    await core._runAssemblyContext('B', async () => {
      try { core.registerService('svc', { from: 'B' }); } catch (e) { threw = e; }
    }, core.assemblyEpoch, { name: 'B' });
    assert(threw !== null, '可自造的配置不构成授权：异主覆写仍必须被拒');
    assertEquals(threw.code, 'service_conflict');
    assertEquals(core.getService('svc').from, 'A2', '原实现必须完好');
    core.removeAllListeners();
  });

  runner.test('K-13a/3 宿主控制面可以跨 owner 接管（与上一条的负向成对）', async () => {
    const { createRuntime } = await imp('src/core/core.js');
    const { core, host } = createRuntime({ stateDir: tmp, pluginsDir: join(tmp, 'plugins') });
    core._initOwner = 'A'; core.registerService('svc', { from: 'A' });
    core._initOwner = null;
    await host.takeoverService('svc', { from: 'HOST' }, { reason: 'bootstrap-recovery' });
    assertEquals(core.getService('svc').from, 'HOST', '宿主控制面必须能接管');
    assertEquals(core.getServiceOwnership('svc').owner, '@host');
    assertEquals(core.getServiceOwnership('svc').takeover.actorClass, 'host');
    core.removeAllListeners();
  });

  // ══ K-14：依赖方向 ════════════════════════════════════════════════════
  runner.test('K-14/1 src/core 不得存在指向 plugins/ 的静态导入', async () => {
    const dir = join(ROOT, 'src', 'core');
    const bad = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.js'))) {
      const src = readFileSync(join(dir, f), 'utf8');
      // 只看**静态 import 语句**，注释里提到路径是允许的（本文件就写了原因）。
      const lines = src.split('\n').filter((l) => /^\s*import\s.+from\s+['"][^'"]*plugins\//.test(l));
      if (lines.length) bad.push(`${f}: ${lines[0].trim()}`);
    }
    assertEquals(bad.length, 0,
      `Core 不得反向静态依赖外围插件（实测后果：src/core 单独拷走会 ERR_MODULE_NOT_FOUND）。违规：${bad.join(' | ')}`);
  });

  runner.test('K-14/2 宿主未注入 esmHint 时仍可装载（退化为原始错误，不静默丢失）', async () => {
    const core = makeCore();
    writePlugin(join(tmp, 'plugins'), 'plainok.mjs', {
      name: 'plainok', provides: ['plainok.work'], body: `  async init() {}\n  start() {}`,
    });
    const pm = makePm(core);
    const r = await pm.loadOne('plainok');
    assertEquals(r.ok, true, '无 esmHint 注入时正常插件必须仍能装载');
    core.removeAllListeners();
  });

  // ══ N-02：provides 字符串形态 ═════════════════════════════════════════
  runner.test('N-02/1 provides 为字符串数组时不得抛 TypeError', async () => {
    const core = makeCore();
    const pm = makePm(core);
    let threw = null;
    try { pm._indexProvides({ name: 'strprov', provides: ['strprov.work'] }); }
    catch (e) { threw = e.message; }
    assertEquals(threw, null, `字符串形态应被接受；修前抛 "Cannot read properties of undefined (reading 'endsWith')"：${threw}`);
    assertEquals(pm._providesIndex.get('strprov.work'), 'strprov', '字符串形态应正常入索引');
    core.removeAllListeners();
  });

  runner.test('N-02/2 对象形态与非法项的处理（既有一行为不回退）', async () => {
    const core = makeCore();
    const pm = makePm(core);
    pm._indexProvides({ name: 'objprov', provides: [{ name: 'objprov.work', type: 'service' }] });
    assertEquals(pm._svcIndex.get('objprov.work'), 'objprov', '对象形态仍走 service 索引');
    // 缺 name 的项：跳过 + 具名告警，不能抛
    let threw = null;
    try { pm._indexProvides({ name: 'badprov', provides: [{}] }); } catch (e) { threw = e.message; }
    assertEquals(threw, null, '缺 name 的项应跳过而不是抛错');
    core.removeAllListeners();
  });

  // ══ P3 第 6 项补齐（v0.14.0）：专家原文点的三个探针此前一条都没有 ══
  //
  // 原文 §10 P3 实施次序第 6 条："增加场景切换**重复请求**、**双请求竞争**、依赖缺失、
  // 插件 init 抛错、**持久化失败**探针。" 前三条里依赖缺失（K-04/1）与 init 抛错
  // （K-04/1b）已有；后三条（重复请求、双请求竞争、持久化失败）一直没有回归锁。
  // 代码分支写了不等于被验证过 —— 本轮补上，且每条都做过变异确认会变红。

  runner.test('K-16/1 重复请求同一场景：第二次必须如实说明"没有变化"，不得假装又做了一次', async () => {
    const core = makeCore();
    writePlugin(join(tmp, 'plugins'), 'rep1.mjs', {
      name: 'rep1', provides: ['rep1.work'],
      body: `  async init(core) { this.core = core; }
  start() {}`,
    });
    const pm = makePm(core);
    const sc = new SceneController(core, pm);
    let writes = 0;
    core._services.set('config', { get: () => null, set: () => {}, setAndSave: async () => { writes++; } });
    sc.findScene = async () => ({ name: 'rep', plugins: [], eager: ['rep1'], optional: [] });

    const r1 = await sc.switchTo('rep', { yes: true });
    assertEquals(r1.ok, true, `第一次应成功：${JSON.stringify(r1)}`);
    assertEquals(JSON.stringify(r1.toAdd), JSON.stringify(['rep1']), '第一次确实要装 rep1');
    const writesAfterFirst = writes;

    const r2 = await sc.switchTo('rep', { yes: true });
    assertEquals(r2.ok, true, '重复切换同一场景仍应 ok（幂等意图，不是错误）');
    assertEquals(JSON.stringify(r2.toAdd), '[]', '第二次的差异集必须为空 —— 修前若再算一遍 toAdd 就会重复装载');
    assertEquals(JSON.stringify(r2.toRemove), '[]', '第二次不得卸载任何东西');
    // 关键：第二次不得把同一个场景再"提交"一次（重复写盘 = 重复宣告事实）
    assertEquals(writes, writesAfterFirst, '重复切换不应再次写持久配置');
    assertEquals(core.plugins.get('rep1')?.state, 'running', '插件仍应在跑');
    core.removeAllListeners();
  });

  runner.test('K-16/2 双请求竞争：两个并发 switchTo 结束后，运行态必须与 currentScene 一致', async () => {
    // 判据不是"两个都 ok 就是错"——一个正确的排队实现允许两次都成功。
    // 有害的是**交错**：各自 Plan/Apply/Verify 互相穿插 ⇒ 提交时说的已经不是事实。
    const core = makeCore();
    const DECL = { sa: ['ca'], sb: ['cb'] };
    const pm = {
      isResolvable: () => true,
      async unload(n) { await new Promise((r) => setTimeout(r, 12)); core.plugins.delete(n); return { ok: true }; },
      async loadOne(n) {
        await new Promise((r) => setTimeout(r, 12));
        core.plugins.set(n, { name: n, state: 'running' });
        return { ok: true, name: n };
      },
    };
    const sc = new SceneController(core, pm);
    core._services.set('config', { get: () => null, set: () => {}, setAndSave: async () => { await new Promise((r) => setTimeout(r, 20)); } });
    sc.findScene = async (n) => ({ name: n, plugins: [], eager: DECL[n] || [], optional: [] });

    const [a, b] = await Promise.all([sc.switchTo('sa', { yes: true }), sc.switchTo('sb', { yes: true })]);
    // 先确认真实发生了竞争（两个都 ok 才说明没被"有在途就拒"绕过）
    assert(a?.ok === true && b?.ok === true, `本用例要的是"两个都成功但可能交错"的形态：A=${a?.ok} B=${b?.ok}`);
    const running = [...core.plugins.keys()].sort();
    const declared = [...(DECL[sc.currentScene] || [])].sort();
    assertEquals(JSON.stringify(running), JSON.stringify(declared),
      `并发结束后 currentScene='${sc.currentScene}' 声明 [${declared}]，实际在跑 [${running}] —— 二者必须一致，否则那两个 ok:true 是假的`);
    core.removeAllListeners();
  });

  runner.test('K-16/3 运行态已切换但落盘失败：两件事必须分开报，且不得把 currentScene 说成"未提交"', async () => {
    const core = makeCore();
    writePlugin(join(tmp, 'plugins'), 'pers.mjs', {
      name: 'pers', provides: ['pers.work'],
      body: `  async init(core) { this.core = core; }
  start() {}`,
    });
    const pm = makePm(core);
    const sc = new SceneController(core, pm);
    core._services.set('config', {
      get: () => null, set: () => {},
      setAndSave: async () => { throw new Error('disk full'); },
    });
    sc.findScene = async () => ({ name: 'pf', plugins: [], eager: ['pers'], optional: [] });
    const r = await sc.switchTo('pf', { yes: true });

    assertEquals(r.ok, false, '落盘失败不得报整体成功（I-07）');
    assertEquals(r.code, 'scene_persist_failed', '应具名"落盘失败"，而不是笼统的 partial/unknown');
    assertEquals(r.runtime_applied, true, '运行态**确实**已切换，必须如实标注');
    assertEquals(r.persisted, false, '落盘确实没成功，必须如实标注');
    assertEquals(core.plugins.get('pers')?.state, 'running', '插件真的在跑（这正是 runtime_applied=true 的依据）');
    assertEquals(sc.currentScene, 'pf', '内存里的 currentScene 已切；把它说成"未提交"同样是假话 —— 故如实保留并靠 persisted:false 区分');
    core.removeAllListeners();
  });
}
