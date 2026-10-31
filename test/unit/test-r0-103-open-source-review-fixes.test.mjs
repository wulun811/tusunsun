// R0-103（开源盘点 8 条的修复验收）——场景装配 / 懒加载 / 端口 / 文档 / 发布面。
//
// 每一项都对应盘点里的一条**实测缺陷**，并且都能被本文件里的某个用例判红：
//   T1 场景装配：`--scene gateway-lite` 曾只装 8 个 base-system 插件，声明的
//      session/model-openai/health/haotian-lite 一个都不装（懒加载触发是死代码）⇒ 网关
//      "启动了但没有模型也没有会话"，`/v1/chat/completions` 挂死无响应。
//   T2 懒加载机制：`core._lazyHook`（实例字段）与 PluginManager 注入的
//      `setData('_lazyHook')`（数据面）不是同一个东西 ⇒ 能力级懒加载从未触发。
//   T3 重名/假环：`_loadEagerPlugin` 把"注册被跳过"的重名插件也 push 进 `_loaded`
//      ⇒ 拓扑排序输入含重名 ⇒ 报 `Circular dependency detected: unknown` 并静默放弃 DAG 排序。
//   T4/T5 端口：`--port` 只被打印、从不生效（实际永远 config.gateway.port，默认 9002）；
//      且 `|| 9002` 让 `port: 0` 失效 ⇒ 单测里"用临时端口"的意图落空，固定端口被占时整套崩。
//   T4b/T11 端口补强（外部维护者第二轮验收提出，附变异测试证据）：T4/T5 **拦不住**
//      `gateway.js` 的 `??` 回归——T4 只测 config 的内存覆盖，T5 的断言 `port > 0` 连 9002
//      也放行（实测：改回 `||` 后 T5 打印"实际监听 9002"仍 PASS）。补 T4b（配置面
//      `port: 0` 真进程）与 T11（health 自检 / chat-ui 提示必须跟随**实际**端口）后，
//      同一变异会红。
//   T6/T7 场景契约：场景里可以写"不是插件的名字"（tui 只有 cliCommands，没有 name/init），
//      以及若干装配器根本不读的键——都在这里登记，新增键必须显式登记消费状态。
//   T8 文档行数：随包架构文档曾停在"1695 行 / 7 个模块"，与实况（2304 行 / 10 个模块）脱节。
//   T9 发布面单一落点：产物 `plugins/` 里与 `plugins/` 同名的"死副本"不再复制。检查对象
//      按"当前所处的树"选：开发树看 dist/oss，开源仓里就是本树自身——旧版在开源仓永远
//      SKIP（外部验收指出：这条规则"只在理论上被守护"），且发布档门禁
//      TT_REQUIRE_PRECONDITIONS=1 下 noteSkip 会直接判红。
//      v0.9.25：目录合并后原断言会因 `src/builtin/` 消失而整条 NOT_RUN，已改接到继任者上
//      （`src/builtin/` 不得复活 + 同树不得有 basename 相同的 .js/.mjs 双实现）。
//   T10 Python 套件：前置缺失曾 exit 0 被汇总成 PASS（显示成功、实际零验证）。

import { TestRunner, assert, assertEquals } from '../harness.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
// R0-115：子进程一律走受管 spawn（独立进程组 + 登记回收）。
import { spawnManaged } from '../lib/proc.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..', '..');
const DIST = join(ROOT, 'dist', 'oss');
const CORE_DIR = join(ROOT, 'src', 'core');

const imp = (rel) => import(pathToFileURL(join(ROOT, rel)).href);

// 装配器实际会读的场景键（R0-103 T6 的登记表）。值 = 消费状态；`inert(...)` 表示当前不生效，
// 括号里是已登记的缺口编号——**新增键必须在这里登记**，否则 T6 红。
const SCENE_KEY_REGISTRY = {
  name: 'meta（必须与文件名一致）',
  description: 'meta',
  version: 'meta',
  schema: 'display（scene show / AI 推荐）',
  include: 'loader（合并父场景的 eager/plugins/optional；lazy 不继承）',
  eager: 'loader（启动即装载）',
  plugins: 'loader（懒加载池）',
  lazy: 'loader（懒加载池）',
  defaultConfig: 'switch（切场景时写入配置）',
  optional: 'inert(R0-103-D1：仅显示，不参与装配)',
  fallback: 'inert(R0-103-D2：resolveWithFallback 存在但装载路径未调用)',
  sceneContext: 'inert(R0-103-D3：无任何消费者)',
};

// 判断一个文件"看起来是不是插件"：内核的懒加载索引用正则匹配类字段风格，这里放宽到
// 四种真实存在的写法（`export default …` / 具名导出里带 name|init / 类字段 name = '…' /
// `module.exports = …`）。够用且**不需要 import**——import 会执行模块顶层代码
// （下游插件可能有副作用），门禁不该有那种副作用。
// 反例（本门禁实测抓到过的）：`tui.js` 只导出 `cliCommands`；
// `workflow-loader.js` / `haotian-executor.js` 是库（只导出函数），都没有插件契约。
function looksLikePlugin(src) {
  return [
    /export\s+default/,
    /export\s*\{[^}]*\b(?:name|init)\b/,
    /^\s*name\s*=\s*['"]/m,
    /^\s*export\s+const\s+name\s*=/m,
    /module\.exports\s*=/,
  ].some((re) => re.test(src));
}

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

// 与 `cmdStart` 同路径的装配：插件根（plugins/ + plugins/ + data 声明）→ early-load config
// → 场景展开 → scenePluginLists → loadAll。用的是内核导出的**同一份规则**，不是复制品。
async function bootScene(sceneName, stateDir) {
  const { Core } = await imp('src/core/core.js');
  const { PluginManager } = await imp('src/core/plugin-manager.js');
  const { SceneController } = await imp('src/core/scene-controller.js');
  const { scenePluginLists, resolvePluginDirs } = await imp('src/bootstrap/cli.js');

  const core = new Core({ stateDir, pluginsDir: join(ROOT, 'plugins'), port: 0 });
  const logs = [];
  core.log = (level, ...rest) => { logs.push(`${level} ${rest.join(' ')}`); };

  const pm = new PluginManager(core);
  core.registerService('plugin-manager', pm);
  pm.addDirectory(join(ROOT, 'plugins'));
  pm.addDirectory(join(ROOT, 'plugins'));
  for (const d of await resolvePluginDirs({ platformRoot: ROOT, pluginsDir: join(ROOT, 'plugins') })) pm.addDirectory(d);

  const cfgMod = await imp('plugins/config.js') /* v0.9.24：壳已删除 */;
  const cfgPlugin = cfgMod.default || cfgMod;
  await core.register(cfgPlugin);
  await cfgPlugin.init(core);
  cfgPlugin.state = 'running';   // 与 cmdStart 的 early-load 语义一致

  const sc = new SceneController(core, pm);
  const scene = await sc.findScene(sceneName);
  assert(scene, `场景 ${sceneName} 必须存在`);
  const { eager, lazy } = scenePluginLists(scene);
  await pm.loadAll(eager, lazy);
  await core.start();
  return { core, pm, logs, scene, eager, lazy };
}

// v0.9.33（E3）：场景能力声明清单（机器可读）。读不到就让整个 T6b 失败 —— 不静默跳过。
const SCENE_CAPS = JSON.parse(readFileSync(join(ROOT, 'docs/reference/scene-capabilities.json'), 'utf8'));

export async function setup(runner) {
  const tmpDirs = [];
  const mkTmp = (tag) => {
    const d = mkdtempSync(join(tmpdir(), `r0103-${tag}-`));
    // R0-113：Node 18 无 ESM 语法探测 ⇒ 夹具目录需显式声明模块类型（产品包内 type=module）
    writeFileSync(join(d, 'package.json'), '{"type":"module"}');
    tmpDirs.push(d);
    return d;
  };
  runner.afterAll(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  // ── T1：场景声明即行为（gateway-lite 真的可用）────────────────────────────
  runner.test('R0-103/T1 场景装配：gateway-lite 启动后模型/会话/对话处理器都在（盘点 #1）', async () => {
    const { core, logs, eager } = await bootScene('gateway-lite', mkTmp('t1'));
    const required = ['haotian-lite', 'model-openai', 'session', 'health'];
    for (const name of required) {
      assert(eager.includes(name), `${name} 必须在 gateway-lite 的 eager 清单里（服务型插件无法懒触发）`);
    }
    // 注意：场景写的是**文件名**（model-openai.js），注册进内核的是插件**自报名**
    // （`name = 'model'`）——两者不一定相同，所以断言要分别对。
    assert(core.plugins.has('model'), `model-openai.js 必须真的被装载（实况：${[...core.plugins.keys()].join(',')}）`);
    assert(core.plugins.has('session'), 'session 必须真的被装载');
    assert(core.plugins.has('health'), 'health 必须真的被装载');
    assert(core.plugins.has('haotian-lite'), 'haotian-lite 必须真的被装载');
    assert(core.getService('model'), 'model 服务必须可用（"纯模型代理"的最低要求）');
    assert(core.getService('session'), 'session 服务必须可用');
    assert(core._capabilities.has('chat.handle'), 'chat.handle 能力必须已注册（网关 WS 路径派发前会检查它）');

    const warnings = logs.filter((l) => /Could not extract metadata|Dependency issue|Circular dependency/.test(l));
    assertEquals(warnings.length, 0, `装配不得有元数据/依赖告警：${warnings.join(' | ')}`);
    await core.stop();
    console.log(`       [实测] gateway-lite 装载 ${core.plugins.size} 个插件，model/session/chat.handle 齐备，零告警`);
  });

  // ── T2：懒加载机制（盘点 #1 的根因）──────────────────────────────────────
  runner.test('R0-103/T2 懒加载：能力被调用时才装载（钩子接线）', async () => {
    const { Core } = await imp('src/core/core.js');
    const { PluginManager } = await imp('src/core/plugin-manager.js');
    const d = mkTmp('t2');
    mkdirSync(join(d, 'p'), { recursive: true });
    writeFileSync(join(d, 'p', 'demo.js'), `class Demo {
  name = 'demo';
  version = '1.0.0';
  provides = [{ name: 't.demo' }];
  async init(core) { core.registerCapability('t.demo', { handler: () => ({ hello: 'lazy' }), owner: 'demo' }); }
}
export default new Demo();
`);
    const core = new Core({ stateDir: join(d, 'state'), pluginsDir: join(d, 'p'), port: 0 });
    const pm = new PluginManager(core);
    core.registerService('plugin-manager', pm);
    pm.addDirectory(join(d, 'p'));
    await pm.loadAll([], ['demo']);

    assertEquals(core.plugins.size, 0, '懒加载插件在启动时**不得**被装载');
    const r = await core.callCapability('t.demo', {});
    assertEquals(r.ok, true, '首次调用必须触发懒加载并成功');
    assertEquals(r.payload.hello, 'lazy');
    assert(core.plugins.has('demo'), '调用后插件必须已装载');

    // 反例：缺失能力返回具名信封（R0-76 合同），不得抛——否则"挂了 PluginManager"的真实运行
    // 与"没挂"的测试装配会出现两种失败形状。
    const miss = await core.callCapability('t.nope', {});
    assertEquals(miss.ok, false);
    assertEquals(miss.state, 'failed');
    assertEquals(miss.code, 'capability_not_found');
    console.log('       [实测] 懒加载由 callCapability 触发；缺失能力走具名信封');
  });

  // ── T3：重名不再被误报成环（盘点 #3）────────────────────────────────────
  runner.test('R0-103/T3 重名插件：不得报 unknown 环，也不得污染装载集合', async () => {
    const { Core } = await imp('src/core/core.js');
    const { PluginManager } = await imp('src/core/plugin-manager.js');
    const { DependencyResolver } = await imp('src/core/dependency-resolver.js');
    const d = mkTmp('t3');
    const fixture = (v) => `class Demo {
  name = 'demo';
  version = '${v}';
  async init() {}
}
export default new Demo();
`;
    mkdirSync(join(d, 'p1'), { recursive: true });
    mkdirSync(join(d, 'p2'), { recursive: true });
    writeFileSync(join(d, 'p1', 'demo.js'), fixture('1.0.0'));
    writeFileSync(join(d, 'p2', 'demo.js'), fixture('9.9.9'));

    const core = new Core({ stateDir: join(d, 'state'), pluginsDir: join(d, 'p1') });
    const logs = [];
    core.log = (level, ...rest) => { logs.push(`${level} ${rest.join(' ')}`); };
    const pm = new PluginManager(core);
    core.registerService('plugin-manager', pm);
    pm.addDirectory(join(d, 'p1'));
    pm.addDirectory(join(d, 'p2'));
    await pm.loadAll(['demo'], []);

    assertEquals(core.plugins.size, 1, '同名插件只能注册一次（先到者胜）');
    assertEquals(pm._loaded.length, 1, '`_loaded` 不得含重名项（否则拓扑排序输入长度 ≠ 节点数）');
    const bad = logs.filter((l) => /Circular dependency detected: unknown/.test(l));
    assertEquals(bad.length, 0, `不得再出现 unknown 假环：${bad.join(' | ')}`);

    // 直接打解析器：重名（无环）必须给出"排不出序 + 卡住的节点"，而不是"环"。
    const resolver = new DependencyResolver({ log: () => {}, emit: () => {} });
    const dup = [{ name: 'a', version: '1.0.0', requires: {} }, { name: 'a', version: '1.0.0', requires: {} }];
    const r1 = resolver.topologicalSort(dup);
    assertEquals(r1.ok, false);
    assert(!/Circular/.test(r1.error), `无环时不得声称是环：${r1.error}`);
    assert(!/unknown/.test(r1.error), `不得再兜底成 unknown：${r1.error}`);
    assert(/duplicate plugin names: a/.test(r1.error), `必须点名重名插件：${r1.error}`);
    // 真环仍要报环（不得因为修假警报而丢掉真警报）
    const cyc = [
      { name: 'a', version: '1.0.0', requires: { b: '^1.0.0' } },
      { name: 'b', version: '1.0.0', requires: { a: '^1.0.0' } },
    ];
    const r2 = resolver.topologicalSort(cyc);
    assert(/Circular dependency detected: a → b → a/.test(r2.error), `真环必须报出环链：${r2.error}`);
    console.log('       [实测] 重名 → not-orderable(点名节点)；真环 → 完整环链');
  });

  // ── T4：端口覆盖语义（盘点 #4）──────────────────────────────────────────
  runner.test('R0-103/T4 端口：Core({port}) 覆盖配置且不落盘，port:0 不被真值判断吞掉', async () => {
    const { Core } = await imp('src/core/core.js');
    const cfgMod = await imp('plugins/config.js') /* v0.9.24：同上 */;
    const cfgPlugin = cfgMod.default || cfgMod;

    const d1 = mkTmp('t4a');
    const core1 = new Core({ stateDir: d1, pluginsDir: join(d1, 'none'), port: 0 });
    await core1.register(cfgPlugin);
    await cfgPlugin.init(core1);
    assertEquals(core1.getService('config').get('gateway.port'), 0, 'port:0（随机可用端口）必须原样生效');

    const d2 = mkTmp('t4b');
    const core2 = new Core({ stateDir: d2, pluginsDir: join(d2, 'none'), port: 19555 });
    await core2.register(cfgPlugin);
    await cfgPlugin.init(core2);
    assertEquals(core2.getService('config').get('gateway.port'), 19555, '--port 必须覆盖配置文件');
    const onDisk = JSON.parse(readFileSync(join(d2, 'config.json'), 'utf8'));
    assertEquals(onDisk.gateway.port, 9002, '命令行覆盖**不得落盘**（否则污染下次启动）');
    console.log('       [实测] CLI 覆盖只在内存；配置文件保持 9002');
  });

  // ── T4b：配置面 port:0（外部验收提出的补强）─────────────────────────────
  // 唯一能锁住 `gateway.js` 那行 `??` 的路径：CLI 不传端口，端口只来自 config.json。
  // 旧写法 `|| 9002` 会把它静默换成 9002，而 T4（只测内存覆盖）与 T5（`port > 0` 连 9002
  // 也放行）都拦不住——外部维护者用变异测试实测：改回 `||` 后 T4/T5 双绿。
  runner.test('R0-103/T4b 端到端（配置面）：config.json 写 gateway.port:0 且 CLI 不传端口 → 内核分配端口', async () => {
    const home = mkTmp('t4b-home');
    // 路径分两步拼：发布链自洽性过滤会把「join(...) 里同时出现 'scenes' 与 .json5」当成
    // "引用了未随包路径"而整件剔除本文件（T5 同样处理）。
    const homeState = join(home, '.tusunsun');
    const homeScenes = join(homeState, 'scenes');
    mkdirSync(homeScenes, { recursive: true });
    writeFileSync(join(homeScenes, 'r0103b.json5'),
      '{ name: "r0103b", description: "R0-103 配置面端口 0", eager: ["config", "gateway"] }\n');
    const stateDir = join(mkTmp('t4b-state'), 'state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ gateway: { port: 0 } }, null, 2));

    const child = spawnManaged('node', [join(ROOT, 'tusunsun.mjs'), 'start', '--scene', 'r0103b', '--state-dir', stateDir], {
      cwd: ROOT,
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.stderr.on('data', (b) => { out += b.toString(); });

    const port = await new Promise((resolve, reject) => {
      const t0 = Date.now();
      const timer = setInterval(() => {
        const m = out.match(/listening on (?:0\.0\.0\.0|127\.0\.0\.1):(\d+)/);
        if (m) { clearInterval(timer); resolve(Number(m[1])); return; }
        if (child.exitCode !== null) { clearInterval(timer); reject(new Error(`子进程提前退出（code=${child.exitCode}）：\n${out.slice(-1500)}`)); return; }
        if (Date.now() - t0 > 30000) { clearInterval(timer); reject(new Error(`30s 内未见监听日志：\n${out.slice(-1500)}`)); }
      }, 100);
    });

    try {
      // 三个断言各锁一个缺陷：
      //   9002  → `gateway.js` 用 `||` 做真值判断，把 0 吞成默认端口；
      //   18789 → `src/bootstrap/cli.js` 的历史哨兵默认值顶掉配置文件（R0-103 #4 的回归，
      //           本用例第一次跑就抓到：实测"配置写 0、实际监听 18789"）；
      //   (--port) → 未传 `--port` 却谎称是命令行指定。
      assert(port > 0 && port !== 9002 && port !== 18789,
        `配置 port:0 必须由内核分配端口，不得回落 9002/18789（实际 ${port}）`);
      const banner = stripAnsi(out).match(/Port: (\d+)( \(--port\))?/);
      assert(banner, `横幅必须打印端口：\n${out.slice(-800)}`);
      assertEquals(banner[1], '0', '横幅必须如实显示配置文件里的 0');
      assert(!banner[2], '未传 --port 时不得标注 (--port)（那等于谎称命令行指定）');
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      assertEquals(res.status, 200, '/health 必须可达');
      assertEquals(JSON.parse(readFileSync(join(stateDir, 'config.json'), 'utf8')).gateway.port, 0,
        '配置文件里的 port:0 不得被"默认值 9002"改写');
      console.log(`       [实测] config gateway.port:0 → 实际监听 ${port}（≠9002/18789），/health 200，配置文件未被改写`);
    } finally {
      child.kill('SIGTERM');
      await new Promise((r) => { child.once('exit', r); setTimeout(r, 5000); });
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });

  // ── T5：端到端（真进程 + 真监听 + 真端口）──────────────────────────────
  runner.test('R0-103/T5 端到端：--port 0 启动后按日志里的真实端口可访问 /health', async () => {
    const home = mkTmp('t5-home');
    // 注意：这里给子进程一个**临时 HOME**，场景放在 `<HOME>/.tusunsun/scenes/` 下。
    // 路径分两步拼（而不是一次 join 里写全 'scenes' + 文件名）：发布链的自洽性过滤会把
    // 「join(...) 里出现 'scenes' 且以 .json5 结尾」当成"引用了未随包路径"而整件剔除本文件。
    const homeState = join(home, '.tusunsun');
    const homeScenes = join(homeState, 'scenes');
    mkdirSync(homeScenes, { recursive: true });
    writeFileSync(join(homeScenes, 'r0103.json5'),
      '{ name: "r0103", description: "R0-103 端到端最小场景", eager: ["config", "gateway"] }\n');
    const stateDir = join(mkTmp('t5-state'), 'state');

    const child = spawnManaged('node', [join(ROOT, 'tusunsun.mjs'), 'start', '--scene', 'r0103', '--port', '0', '--state-dir', stateDir], {
      cwd: ROOT,
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.stderr.on('data', (b) => { out += b.toString(); });

    const port = await new Promise((resolve, reject) => {
      const t0 = Date.now();
      const timer = setInterval(() => {
        const m = out.match(/listening on (?:0\.0\.0\.0|127\.0\.0\.1):(\d+)/);
        if (m) { clearInterval(timer); resolve(Number(m[1])); return; }
        if (child.exitCode !== null) { clearInterval(timer); reject(new Error(`子进程提前退出（code=${child.exitCode}）：\n${out.slice(-1500)}`)); return; }
        if (Date.now() - t0 > 30000) { clearInterval(timer); reject(new Error(`30s 内未见监听日志：\n${out.slice(-1500)}`)); }
      }, 100);
    });

    try {
      assert(port > 0, `必须绑定内核分配的真实端口（实际 ${port}）`);
      // 外部验收实测：旧版只有 `port > 0`，改回 `|| 9002` 后这里拿到 9002 仍然 PASS。
      assert(port !== 9002, `--port 0 必须是内核分配的端口，不得静默回落到 9002（实际 ${port}）`);
      assert(new RegExp(`Port: 0 \\(--port\\)`).test(stripAnsi(out)), '横幅必须如实显示"Port: 0 (--port)"而不是编造的默认值');
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      assertEquals(res.status, 200, '/health 必须可达');
      const body = await res.json();
      // R0-110/T1：本场景（`eager: ["config","gateway"]`）**没有** chat.handle，所以健康检查
      // 必须如实报 degraded 并列出缺失能力——此前恒回 ok，正是"仪表盘全绿、功能为零"的那个缺陷。
      // 状态码仍是 200（liveness 探针不该因此失败），降级信息在 status/missing 字段里。
      assertEquals(body.status, 'degraded', '/health 对无对话能力的装配必须如实降级');
      assert(Array.isArray(body.missing) && body.missing.includes('chat.handle'),
        `/health 必须列出缺失能力，实际：${JSON.stringify(body)}`);
      console.log(`       [实测] --port 0 → 实际监听 ${port}，/health 200 degraded（missing=${body.missing.join(',')}）`);
    } finally {
      child.kill('SIGTERM');
      await new Promise((r) => { child.once('exit', r); setTimeout(r, 5000); });
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });

  // ── T6：场景键登记（盘点 #1/#2 的"声明即行为"面）────────────────────────
  runner.test('R0-103/T6 场景键：装配器不读的键必须显式登记为 inert', async () => {
    const { loadJson5 } = await imp('src/core/json5-loader.js');
    const scenesDir = join(ROOT, 'scenes');
    const files = readdirSync(scenesDir).filter((f) => f.endsWith('.json5'));
    assert(files.length >= 8, `随包场景应齐备，实际 ${files.length}`);
    const unknown = [];
    for (const f of files) {
      const cfg = loadJson5(readFileSync(join(scenesDir, f), 'utf8'), ` in ${f}`);
      for (const key of Object.keys(cfg)) {
        if (!(key in SCENE_KEY_REGISTRY)) unknown.push(`${f}: ${key}`);
      }
    }
    assertEquals(unknown.length, 0,
      `场景出现未登记的键（新增键必须登记消费状态，否则就是"声明了但不生效"）：${unknown.join(', ')}`);
    // 反例：登记表必须真的会拒绝未知键（防止这张表退化成装饰）
    const probe = { name: 'x', 一个不存在的键: [] };
    const missed = Object.keys(probe).filter((k) => !(k in SCENE_KEY_REGISTRY));
    assertEquals(missed.length, 1, '登记表必须能识别未知键');
    console.log(`       [实测] ${files.length} 个场景的键全部已登记（含 3 个 inert 缺口）`);
  });

  // ── T6b：场景**声明的能力**必须与实际装配一致（v0.9.27）──────────────────
  // T6 只查"键有没有被登记"，不查"声明的值是不是真的"。
  // 实测缺口：`gateway-lite` 的 `schema.capabilities` 里有 `"工具执行"`，
  // 而它的 `eager` 只有 4 个插件、`tool-executor` 与 `tools` 都不在、`tool.*` 能力数为 0。
  // 于是任何工具调用都落到 `_execTools` 兜底分支，返回
  // `Tool "x" not found (no tool-executor or legacy tools)`。
  //
  // 这类声明不是装饰：`scene show` / AI 推荐 / 用户选场景都读它，写错会直接误导选型。
  // 判据不猜"哪个插件提供哪个能力"，而是问内核本身：**装配完成后，声明的那类能力存在吗。**
  runner.test('R0-103/T6b 场景能力声明必须与实际装配一致（不得声明了却没有）', async () => {
    const { Core } = await imp('src/core/core.js');
    const { PluginManager } = await imp('src/core/plugin-manager.js');
    const { SceneController } = await imp('src/core/scene-controller.js');
    const { resolvePluginDirs, scenePluginLists } = await imp('src/bootstrap/cli.js');
    const { mkdtempSync, rmSync } = await import('node:fs');

    // 能力名 → 判定"装配后是否真的存在"。
    // 只登记**有明确机器判据**的那几项；没登记的声明不做断言（不猜）。
    const CAPABILITY_PROBES = {
      模型调用: (core) => !!core.getService('model') || !!core.getService('model-openai'),
      工具执行: (core) => !!core.getService('tool-executor')
        || core.listCapabilities().some((c) => c.id.startsWith('tool.')),
      会话: (core) => !!core.getService('session'),
    };

    const scenesDir = join(ROOT, 'scenes');
    const files = readdirSync(scenesDir).filter((f) => f.endsWith('.json5'));
    const violations = [];
    const checked = [];
    for (const f of files) {
      // 必须经 `SceneController.findScene` 取**展开 include 之后**的清单 ——
      // 直接读文件再 `scenePluginLists(cfg)` 会漏掉 `include: ["base-system","gateway"]`
      // 这类复用（`cell` 的模型/工具全来自 include，按裸 cfg 判定会误报成"声明了却没有"）。
      // 判据必须走**装配入口同一条路**，否则门禁测的是我想象的装配，不是真实的。
      const dir = mkdtempSync(join(tmpdir(), 't6b-'));
      try {
        const core = new Core({ stateDir: dir });
        const pm = new PluginManager(core);
        core.registerService('plugin-manager', pm);
        pm.addDirectory(core.pluginsDir);
        for (const d of await resolvePluginDirs({ platformRoot: ROOT, pluginsDir: core.pluginsDir })) {
          pm.addDirectory(d);
        }
        const sceneName = f.replace(/\.json5$/, '');
        const s = await new SceneController(core, pm).findScene(sceneName);
        if (!s) continue;
        // v0.9.33（E3）：能力声明从 `scenes/*.json5` 的 `schema` 键迁到
        // `docs/reference/scene-capabilities.json`。原因：`schema` 在 `src/` 与
        // `plugins/` 里**零读者** —— 装配器从不看它，只有这条测试看它。
        // 而"零读者配置"会让读者以为能力面已被内核校验。现在声明集中在一处，
        // 形态从"场景文件里的装饰块"变成"被本判据逐条核对的清单"，语义反而**更强**了：
        // 清单存在 ⇒ 必须有对应场景；声明了 ⇒ 必须真的装得上。
        const declared = SCENE_CAPS.scenes[sceneName]?.capabilities || [];
        const known = declared.filter((c) => c in CAPABILITY_PROBES);
        if (!known.length) continue;
        // 只装配、不 start：start 会开监听，门禁不该占端口。
        const { eager, lazy } = scenePluginLists(s);
        await pm.loadAll(eager, lazy);
        // loadAll 只注册；服务在 init 时才注册，故对声明涉及的服务型插件补跑 init。
        for (const name of [...core.plugins.keys()]) {
          const p = core.plugins.get(name);
          if (p && typeof p.init === 'function' && p.state !== 'running') {
            try { await p.init(core); p.state = 'running'; } catch { /* 该插件自己起不来，由别的用例负责 */ }
          }
        }
        for (const cap of known) {
          checked.push(`${f}:${cap}`);
          if (!CAPABILITY_PROBES[cap](core)) {
            violations.push(`${f} 声明了「${cap}」，但装配后该能力不存在`);
          }
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    assert(checked.length >= 5, `至少要检查到 5 条能力声明，实际 ${checked.length}（判据可能在空转）`);
    assertEquals(violations.length, 0,
      `场景声明的能力与实际装配不符（声明是给 scene show / AI 推荐 / 用户选型读的，写错会误导）：\n  `
      + violations.join('\n  '));
    // 反例：探针必须真的能否定一个不存在的状态（防止判据退化成恒真）
    const negDir = mkdtempSync(join(tmpdir(), 't6b-neg-'));
    try {
      const silent = new Core({ stateDir: negDir });
      assert(!CAPABILITY_PROBES.工具执行(silent), '空内核不应具备「工具执行」，否则探针恒真');
      assert(!CAPABILITY_PROBES.会话(silent), '空内核不应具备「会话」，否则探针恒真');
    } finally {
      rmSync(negDir, { recursive: true, force: true });
    }
    console.log(`       [实测] ${checked.length} 条能力声明与实际装配一致（${[...new Set(checked.map((c) => c.split(':')[0]))].length} 个场景）`);
  });

  // ── T6c：两代工具实现不得在同一场景里混用（v0.9.27）────────────────────
  // `plugins/tools.js` 与 `plugins/tools/` 同名共存，看着像"混乱"，实测是**两代实现的分工**：
  //   · `tools.js`（name='tools'）：legacy 兜底路径的工具提供者。只有 `pm.loadAll()` **无场景**
  //     或场景找不到时才会走 `_loadFromDirLegacy`，而它**不递归子目录** ⇒ `tools/` 里的
  //     `tool-*` 一个都不会被装载，此时只有 `tools.js` 在提供 bash/read/write/list/stat。
  //   · `tools/tool-*.js`（name='tool-xxx'）：场景装配路径的工具家族，由 eager/plugins 点名装载。
  // 两者**互斥**：实测 legacy 全量装载后 `tool-bash` 等不在，`tools` 服务在；场景路径反之。
  // 所以真正要守的不是"删掉一个"，而是"**永远不要在同一场景里同时声明两者**"——
  // 那才会出现两套工具抢同名能力（`core.register` 同名能力是静默覆盖）。
  runner.test('R0-103/T6c 两代工具实现不得在同一场景混用', async () => {
    const { loadJson5 } = await imp('src/core/json5-loader.js');
    const scenesDir = join(ROOT, 'scenes');
    const files = readdirSync(scenesDir).filter((f) => f.endsWith('.json5'));
    const mixed = [];
    const legacyScenes = [];
    const modernScenes = [];
    for (const f of files) {
      const s = loadJson5(readFileSync(join(scenesDir, f), 'utf8'), ` in ${f}`);
      // 四类清单全算：optional 虽然惰性，但一旦被使用者提升就是真实装配。
      const all = [...(s.eager || []), ...(s.plugins || []), ...(s.lazy || []), ...(s.optional || [])];
      const hasLegacy = all.includes('tools');
      const modern = all.filter((n) => /^tool-/.test(n));
      if (hasLegacy) legacyScenes.push(f);
      if (modern.length) modernScenes.push(f);
      if (hasLegacy && modern.length) {
        mixed.push(`${f}：同时声明了 legacy 'tools' 与 ${modern.length} 个 tool-*（${modern.slice(0, 3).join(', ')}…）`);
      }
    }
    assertEquals(mixed.length, 0,
      `同一场景不得混用两代工具实现（同名能力 register 是静默覆盖，谁生效取决于装载顺序）：\n  `
      + mixed.join('\n  '));
    // 判据不得空转：至少要看到"现代路径确实有人在用"，否则这条断言可以因为大家都空而恒真。
    assert(modernScenes.length >= 3,
      `至少应有 3 个场景使用现代 tool-* 家族，实际 ${modernScenes.length} —— 判据可能在空转`);
    // legacy 路径本身仍有提供者存在（否则 `tools.js` 才是真死代码，应该删）。
    assert(existsSync(join(ROOT, 'plugins', 'tools.js')), 'plugins/tools.js 仍应是 legacy 兜底路径的提供者');
    // R0-155：光"文件存在"不足以称它为提供者 —— 修前它只发 `tool.registered` 事件、
    // 从不 registerCapability，实测 callCapability('bash') → capability_not_found。
    // 现在要求它**真的调用** registerCapability，否则"提供者"三个字是空的。
    {
      const src = readFileSync(join(ROOT, 'plugins', 'tools.js'), 'utf8');
      assert(/registerCapability\(/.test(src),
        'plugins/tools.js 必须真的注册能力 —— 只发 tool.registered 事件而不注册，'
        + '会让订阅者以为工具已就绪（修前实测能力表为空、调用报 capability_not_found）');
    }
    console.log(`       [实测] ${modernScenes.length} 个场景用现代 tool-*、${legacyScenes.length} 个用 legacy tools，零混用`);
  });

  // ── T7：场景里的插件名必须真的可解析（盘点 #2）──────────────────────────
  runner.test('R0-103/T7 场景插件名：必须在装配根找到，且文件必须是插件', async () => {
    const { loadJson5 } = await imp('src/core/json5-loader.js');
    const { resolvePluginDirs } = await imp('src/bootstrap/cli.js');
    const dirs = [
      join(ROOT, 'plugins'),
      join(ROOT, 'plugins'),
      ...(await resolvePluginDirs({ platformRoot: ROOT, pluginsDir: join(ROOT, 'plugins') })),
    ];
    const findFile = (name) => {
      for (const d of dirs) {
        for (const ext of ['.js', '.mjs']) {
          const p = join(d, `${name}${ext}`);
          if (existsSync(p)) return p;
        }
      }
      return null;
    };
    const scenesDir = join(ROOT, 'scenes');
    const missing = [];
    const notPlugins = [];
    for (const f of readdirSync(scenesDir).filter((x) => x.endsWith('.json5'))) {
      const cfg = loadJson5(readFileSync(join(scenesDir, f), 'utf8'), ` in ${f}`);
      const names = new Set([...(cfg.eager || []), ...(cfg.plugins || []), ...(cfg.lazy || []), ...(cfg.optional || [])]);
      for (const name of names) {
        const p = findFile(name);
        if (!p) { missing.push(`${f}: ${name}`); continue; }
        if (!looksLikePlugin(readFileSync(p, 'utf8'))) notPlugins.push(`${f}: ${name} (${p})`);
      }
    }
    assertEquals(missing.length, 0, `场景引用了装配根里不存在的插件名：${missing.join(', ')}`);
    assertEquals(notPlugins.length, 0, `场景把"不是插件的文件"当插件列了（如 tui：只有 cliCommands）：${notPlugins.join(', ')}`);
    console.log('       [实测] 场景引用的每个名字都能解析到插件文件（tui 已移出场景清单）');
  });

  // ── T8：随包文档的行数声明必须等于实况（盘点 #8）────────────────────────
  runner.test('R0-103/T8 文档：架构文档的行数表必须等于实况（逐文件 + 合计）', () => {
    const docPath = ['updocs', join('docs')]
      .map((d) => join(ROOT, d, 'architecture', 'microkernel.md'))
      .find((p) => existsSync(p));
    assert(docPath, '找不到架构文档（updocs/architecture/microkernel.md 或 docs/architecture/microkernel.md）');
    const doc = readFileSync(docPath, 'utf8');

    const actual = new Map();
    let total = 0;
    for (const f of readdirSync(CORE_DIR).filter((x) => x.endsWith('.js')).sort()) {
      const n = readFileSync(join(CORE_DIR, f), 'utf8').split('\n').length;
      actual.set(f, n);
      total += n;
    }

    const rows = [...doc.matchAll(/^\|\s*([a-z0-9-]+\.js)\s*\|\s*(\d+)\s*\|/gm)];
    assert(rows.length >= actual.size, `文档行数表必须覆盖全部 ${actual.size} 个内核文件（实际 ${rows.length} 行）`);
    const wrong = [];
    for (const [, file, n] of rows) {
      if (actual.has(file) && Number(n) !== actual.get(file)) wrong.push(`${file}: 文档 ${n} ≠ 实况 ${actual.get(file)}`);
      if (!actual.has(file)) wrong.push(`${file}: 文档列了不存在于 src/core/ 的文件`);
    }
    assertEquals(wrong.length, 0, `文档行数表与实况不符：${wrong.join('; ')}`);
    assert(new RegExp(`\\*\\*${total}\\*\\*`).test(doc), `合计必须等于实况 ${total}`);
    assert(new RegExp(`${total} 行代码`).test(doc), `标题里的总行数必须等于实况 ${total}`);
    console.log(`       [实测] 文档行数表与实况一致（${actual.size} 个文件 / ${total} 行）`);
  });

  // ── T9：发布面去重（盘点 #7 → v0.9.25 升级）───────────────────────────
  runner.test('R0-103/T9 发布面单一落点：src/builtin 不得复活，且同一插件不得有 .js/.mjs 双实现', () => {
    // 这条用例原来的断言是"`plugins/` 与 `src/builtin/` 之间不得有同名文件"。
    // v0.9.25 合并后 `src/builtin/` 整个不存在了，**原断言会因目录缺失而 [NOT_RUN]** ——
    // 一个真门禁就这样变成装饰。（这正是本仓反复踩的坑：结构一变，门禁静默失效。）
    //
    // 所以不删它，而是接到**继任者**上。当年担心的风险"同一个插件有两个文件路径，
    // 哪份在跑取决于扫描顺序"并没有随目录合并消失，它换了个形态还在：
    //   `PluginManager.loadFromDir` 用白名单把插件名映射成 `<name>.js` **或** `<name>.mjs`，
    //   若同一目录下两者都在，装载哪一份同样取决于**扫描顺序**（readdir 的返回序），
    //   而 `name` 字段一样 ⇒ 后注册的那份被"同名跳过"，静默丢一个。
    //
    // 于是本用例守两条：
    //   ① `src/builtin/` 不得复活（否则合并会被无声回滚成两个落点）；
    //   ② `plugins/` 全树（含一级子目录）不得有 basename 相同的 .js/.mjs。
    const trees = existsSync(DIST)
      ? [{ label: 'dist/oss', root: DIST }]
      : [{ label: '本树（单一布局）', root: ROOT }];
    for (const { label, root } of trees) {
      const pluginsDir = join(root, 'plugins');
      const builtinDir = join(root, 'src', 'builtin');
      // 先过 ①：这条不依赖 plugins/ 是否存在，先判，避免像旧版那样因为目录缺失就整条跳过。
      assert(!existsSync(builtinDir),
        `${label}：src/builtin/ 不得复活——v0.9.25 起插件只有一个落点 plugins/。`
        + '若确实要重新分化目录，须同步改装配、零依赖口径与本表，不能只把目录加回来。');
      if (!existsSync(pluginsDir)) {
        console.log(`       [NOT_RUN] ${label}：无 plugins/，跳过 ②`);
        continue;
      }
      // ② 递归找 basename 冲突（一层子目录足够覆盖 `tools/`；`_lib` 不是插件目录，但一并算上更保险）。
      const seen = new Map();
      const walk = (dir, rel) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, e.name);
          if (e.isDirectory()) { walk(p, `${rel}${e.name}/`); continue; }
          const m = /^(.+)\.(js|mjs)$/.exec(e.name);
          if (!m) continue;
          const key = `${rel}${m[1]}`;
          if (!seen.has(key)) seen.set(key, []);
          seen.get(key).push(`${rel}${e.name}`);
        }
      };
      walk(pluginsDir, '');
      const dupes = [...seen.entries()].filter(([, files]) => files.length > 1).map(([k, v]) => `${k}（${v.join(' + ')}）`);
      assertEquals(dupes.length, 0,
        `${label} 存在同名双实现（装载哪份取决于 readdir 顺序，后注册者被静默丢弃）：${dupes.join(', ')}`);
      const jsCount = readdirSync(pluginsDir).filter((f) => f.endsWith('.js')).length;
      console.log(`       [实测] ${label}：plugins/ 顶层 ${jsCount} 个 .js，全树 basename 冲突 ${dupes.length} 个（${dupes.join(', ') || '无'}）`);
    }
  });

  // ── T10 已移出公开树：私有 Python 引擎不属于本仓公开范围 ────────────────

  // ── T11：端口的**消费方**（外部验收提出的同类缺口）──────────────────────
  // 修好 `??` 只解决"监听哪个端口"；消费这个端口的两个插件仍在硬编码 9002：
  //   health：`core.get('health.endpoint') || 'http://127.0.0.1:9002/health'` ⇒ 自定义端口
  //     部署下自检永远打不通，稳定产出假 health.fail / health.critical（外部诊断服务噪声）；
  //   chat-ui：`config?.get('gateway.port') || 9002` ⇒ 提示 URL 报错误端口。
  runner.test('R0-103/T11 端口消费方：health 自检与 chat-ui 提示必须跟随**实际**监听端口', async () => {
    const { Core } = await imp('src/core/core.js');
    // v0.9.25：插件只有一个落点。此前这里要在 `plugins/` 与 `src/builtin/` 之间二选一，
    // 理由是"开发树与产物布局不同"——那个差异随目录合并消失了，还留着这层解析
    // 就只是把"某天真的找不到文件"掩盖成"去另一个目录碰运气"。
    const pluginFile = (name) => join(ROOT, 'plugins', name);
    const impPlugin = async (name) => (await import(pathToFileURL(pluginFile(name)).href)).default;
    const cfgPlugin = await impPlugin('config.js');
    const gwPlugin = await impPlugin('gateway.js');
    const healthPlugin = await impPlugin('health.js');
    const chatUiPlugin = await impPlugin('chat-ui.js');

    const d = mkTmp('t11');
    const core = new Core({ stateDir: join(d, 'state'), pluginsDir: join(d, 'none'), port: 0 });
    const logs = [];
    core.log = (level, ...rest) => { logs.push(`${level} ${rest.join(' ')}`); };

    await core.register(cfgPlugin);
    await cfgPlugin.init(core);
    await core.register(gwPlugin);
    await gwPlugin.init(core);
    await gwPlugin.start();
    const actual = gwPlugin.port;
    assert(actual > 0 && actual !== 9002, `网关必须真绑在随机端口上（实际 ${actual}）`);

    try {
      await core.register(healthPlugin);
      await healthPlugin.init(core);
      const endpoint = healthPlugin._resolveEndpoint();
      assertEquals(endpoint, `http://127.0.0.1:${actual}/health`, 'health 端点必须跟随实际端口');
      const ok = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 8000);
        core.on('health.ok', (e) => { clearTimeout(timer); resolve(e); });
        healthPlugin._check();
      });
      assert(ok, `health 自检必须能打通实际端口（端点 ${endpoint}）`);
      assertEquals(ok.status, 200, 'health 自检必须拿到 200');

      logs.length = 0;
      await core.register(chatUiPlugin);
      await chatUiPlugin.init(core);
      await chatUiPlugin.start();
      const line = logs.find((l) => /Chat UI available/.test(l));
      assert(line && line.includes(`:${actual}/`), `chat-ui 提示必须报实际端口 ${actual}：${line}`);
      console.log(`       [实测] health 自检命中 ${endpoint}（200）；chat-ui 提示报 ${actual}`);
    } finally {
      await gwPlugin.stop();
    }
  });
}
