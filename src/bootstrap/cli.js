import { readEnv } from '../core/env.js';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

// 全局错误处理器
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

// R0-112 缺陷 5：横幅（起始/终止提示）是**进度信息**，不是数据 ⇒ 一律走 stderr。
// 这样 `tusunsun start > x` 得到的 stdout 只有 JSONL（机器模式）或空（终端），
// 不再出现"横幅混进机器流"；终端里两条流都打到屏幕，观感不变。

async function _earlyLoadConfig(core) {
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { pathToFileURL, fileURLToPath } = await import('node:url');
  // 必须用 fileURLToPath：安装路径含非 ASCII（中文目录/用户名）时 .pathname 保留
  // 百分号编码，existsSync/import 直接 ENOENT。
  // v0.9.24：直指真身 `plugins/config.js`。此前经 `src/builtin/config.js` 的再导出壳，
  // 那个壳只是为了"产物形态下路径可解析"，代价是同一插件有两个文件路径 —— 去重判据
  // （realpath 或字节相等）对它恒为 false，`__source` 只能靠这里手工赋值来弥补。
  const configPath = fileURLToPath(new URL('../../plugins/config.js', import.meta.url));
  if (!existsSync(configPath)) return;
  try {
    const mod = await import(pathToFileURL(configPath).href);
    const plugin = mod.default || mod;
    if (plugin.name === 'config' && typeof plugin.init === 'function') {
      // R0-104：早加载路径是**唯一**绕过 PluginManager 的注册点，必须同样记 `__source`
      // ——否则通用发现扫到 config.js 时“同一份实现”判不出来，启动会刷
      // `Plugin "config" already registered, skipping`（产物里两份副本 ⇒ 刷两条）。
      plugin.__source = configPath;
      // X02 同一条规则：注册被拒时不得再对**未入册**的实例跑 init。
      // 修前这里 `await core.register(plugin)` 丢弃返回值，接着就对未入册的对象 init，
      // 然后又直接写 `plugin.state = 'running'` —— “一个 Core 不承认的对象自称在跑”。
      if (!(await core.register(plugin))) {
        core.log('warn', `[cli] config early load skipped: "${plugin.name}" 已注册（不重复 init 未入册实例）`);
        return;
      }
      await plugin.init(core);
      // K3（v0.15.4）：修前这里直接写 `plugin.state = 'running'`，跳过了 'started' ——
      // 全仓仅剩的越界状态写入点。现在走 Lifecycle 的两条合法边（init 已完成 ⇒ registered → started → running）。
      core.lifecycle.advance(plugin, 'started');
      core.lifecycle.advance(plugin, 'running');
    }
  } catch (e) { core.log('error', `config early load failed: ${e.message}`); }
}

// R0-104（D9）：端口只有一个真相 —— 这是**唯一**的解析实现，`scripts/cli.mjs` 直接复用。
// 此前 CLI 自己抄了一份，漏了 `TUSUNSUN_PORT`（`start` 认、`status`/`stop` 不认）。
//
// R0-109/T1：新增"运行期文件"这一级。理由：`start --port 0`（`--help` 明确承诺
// "0 = 随机可用端口"）或 `start --port 19302` 之后，**实际**绑定端口只存在于运行中的进程里，
// 而 status/stop 只看配置文件 ⇒ 前者永远找不到、后者去探 9002（实测：网关在 19302 上听，
// `status` 却报 "Gateway is not running"，`stop` 报 "not running or unreachable"，网关继续活着）。
// 现在网关启动后把实际端口写进 `<stateDir>/gateway.runtime.json`，此处兜底读取。
//
// 优先级：`--port` > `TUSUNSUN_PORT` > 运行期文件（pid 仍活）> `<stateDir>/config.json` 的
// gateway.port > 9002。`port: 0`（随机可用端口）是合法意图 ⇒ 数值判断不用真值判断。
export const GATEWAY_RUNTIME_FILE = 'gateway.runtime.json';

/**
 * 读运行期记录（身份校验用）：文件不存在 / 内容损坏 / pid 已消失 / **记录属于别的 state dir**
 * 都算"没有"。R0-110/T3：此前记录只有 {port,pid}，两个实例共用目录时无从分辨谁写的 ——
 * 现在写入方带 stateDir，读取方核对；老记录无此字段 ⇒ 按"未知"放行（不破坏兼容读取）。
 */
export function readGatewayRuntime(stateDir) {
  try {
    const rt = JSON.parse(readFileSync(join(stateDir, GATEWAY_RUNTIME_FILE), 'utf8'));
    if (typeof rt?.port !== 'number' || rt.port <= 0) return null;
    if (typeof rt.stateDir === 'string' && resolve(rt.stateDir) !== resolve(stateDir)) return null;
    if (typeof rt.pid === 'number') {
      try { process.kill(rt.pid, 0); } catch { return null; } // 进程已不在 → 陈旧
    }
    return rt;
  } catch { return null; }
}

function readGatewayRuntimePort(stateDir) {
  return readGatewayRuntime(stateDir)?.port ?? null;
}

export function resolveGatewayPort(args = {}) {
  if (args.port != null) return args.port;
  // R0-111/W6：走 `readEnv()`（规范名优先、历史前缀兜底）。手写规范名 = 只认一种名字，
  // 只用别名的部署会静默丢端口/状态目录设置——"start 认、status 不认"这类老毛病由此而来。
  const envPort = readEnv('PORT');
  if (envPort) {
    const n = parseInt(envPort, 10);
    if (!Number.isNaN(n)) return n;
  }
  const stateDir = args.stateDir || readEnv('STATE_DIR') || join(homedir(), '.tusunsun');
  const running = readGatewayRuntimePort(stateDir);
  if (running != null) return running;
  try {
    const cfg = JSON.parse(readFileSync(join(stateDir, 'config.json'), 'utf8'));
    if (typeof cfg?.gateway?.port === 'number') return cfg.gateway.port;
  } catch { /* 配置文件缺失/损坏 → 退回默认 */ }
  return 9002;
}

// 启动 scene 解析（纯函数，可单测）：
// production 不读 config 存储里的 activeScene（那是开发机残留状态，会破坏冻结命令的可复现性），
// 未显式 --scene 时锁定 base-system——与 Base Gate 取证的 8 插件最小装配一致。
export function resolveStartScene({ profile, sceneArg, activeScene } = {}) {
  if (profile === 'production') return sceneArg || 'base-system';
  return sceneArg || activeScene || null;
}

// R0-103（开源盘点 #1）：场景 → 装载清单的映射，抽成**纯函数**供门禁直接调用。
// 语义（与随包文档 `updocs/guides/scene-system.md` 的"字段语义"表一致）：
//   `eager`       启动即装载（服务型插件必须在这里——同步 getService 无法按需触发懒加载）
//   `plugins`     场景插件清单，按需装载（懒加载池）
//   `lazy`        同 plugins，语义显式
// 两份清单**互斥**：同时出现在 eager 与 plugins 里的名字按 eager 处理（装载器本来就先看 eager），
// 从懒清单里剔除只是让"谁在什么时候装载"这件事可被断言。
export function scenePluginLists(scene = {}) {
  const eager = [...new Set(scene.eager || [])];
  const eagerSet = new Set(eager);
  const lazy = [...new Set([...(scene.plugins || []), ...(scene.lazy || [])])].filter((n) => !eagerSet.has(n));
  return { eager, lazy };
}

async function _loadScenePlugins(core, pm, sceneArg) {
  const { SceneController } = await import('../core/scene-controller.js');
  const cfg = core.getService('config');
  const profile = readEnv('PROFILE') || 'development';
  const scene = resolveStartScene({ profile, sceneArg, activeScene: cfg?.get('activeScene') });
  if (profile === 'production') {
    core.log('info', `[start] production profile: scene locked to "${scene}"（不读 config.activeScene）`);
  }
  if (!scene) { await pm.loadAll(); return; }
  const sc = new SceneController(core, pm);
  const s = await sc.findScene(scene);
  if (s) {
    const { eager, lazy } = scenePluginLists(s);
    await pm.loadAll(eager, lazy);
  } else {
    core.log('warn', `scene not found: ${scene}, loading all plugins`);
    await pm.loadAll();
  }
}

// 插件目录装配（R0-100 去下游耦合）：微内核**不认识任何下游工程**。
//  ① 通用发现：`plugins/` 下的一级子目录，**以下划线开头者除外**；
//  ② 可选声明：平台根 `data/plugin-dirs.json`（缺省不存在 ⇒ 纯通用发现）。
//     允许字段：`discover`(bool，默认 true)、`exclude`(目录名数组)、`extra`(相对平台根的路径数组)。
// 此前这里硬编码了 12 个具体目录（其中若干属于下游工程），逼得开源发布必须先"改写内核"
// （旧 build-oss 的 transformCoreCli）。改由数据文件声明后，OSS 与开发树跑同一份内核代码。
//
// R0-103（开源盘点 #2）：把这份规则抽成**导出的纯函数**，让门禁能用同一份规则校验
// "场景里写的插件名是否真的可解析"——在测试里复制一份规则必然漂移，等于没有门禁。
//
// v0.9.25：加 `_` 前缀约定（`plugins/_lib/` 这类内部模块容器）。此前 `_lib` 也被逐个扫描、
// 每个文件都被尝试当插件加载后无声跳过——**v0.9.24 说"一级条目语义唯一：是插件，或是 _lib"，
// 但那句话当时只是命名约定，代码根本没执行它**。现在它被真的执行了：
// `_` 开头 ⇒ 不是插件目录。这条约定同时是给第三方看的：往 `plugins/` 放东西时，
// 不加 `_` 就是插件，加了就是内部模块。
export async function resolvePluginDirs({ platformRoot, pluginsDir, log } = {}) {
  const { readdirSync, existsSync, readFileSync } = await import('node:fs');
  const { join, resolve } = await import('node:path');
  const dirs = [];
  let policy = null;
  const policyPath = join(platformRoot, 'data', 'plugin-dirs.json');
  if (existsSync(policyPath)) {
    try { policy = JSON.parse(readFileSync(policyPath, 'utf8')); }
    catch (err) { log?.('warn', `plugin-dirs.json 解析失败，退回通用发现：${err.message}`); }
  }
  if (policy?.discover !== false) {
    if (existsSync(pluginsDir)) {
      const excluded = new Set(policy?.exclude || []);
      for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (excluded.has(entry.name)) continue;
        if (entry.name.startsWith('_')) continue; // 内部模块容器，不是插件目录
        dirs.push(join(pluginsDir, entry.name));
      }
    } else {
      log?.('warn', `plugins 目录不存在，跳过通用发现：${pluginsDir}`);
    }
  }
  for (const rel of policy?.extra || []) dirs.push(resolve(platformRoot, rel));
  return dirs;
}

async function _assemblePluginDirs(core, pm, platformRoot) {
  const dirs = await resolvePluginDirs({
    platformRoot,
    pluginsDir: core.pluginsDir,
    log: (level, msg) => core.log(level, msg),
  });
  for (const dir of dirs) pm.addDirectory(dir);
}

export async function cmdStart(args) {
  const stateDir = args.stateDir;

  // R0-110/T3：**一个 state dir 只允许一个活着的网关**（fail-closed）。单文件发现记录无法
  // 表达"两个实例"，而实测两种下场都会让门面指错对象：① 同端口 EADDRINUSE —— gateway 插件
  // state='error' 却继续跑，还把记录覆盖成自己；② 换端口起来 —— 与第一个争记录，谁先退出谁
  // 删掉它，另一个从此不可发现。
  const resolvedStateDir = stateDir || join(homedir(), '.tusunsun');
  const live = readGatewayRuntime(resolvedStateDir);
  if (live) {
    process.stderr.write(`✗ 该 state dir 已有存活网关：port=${live.port} pid=${live.pid} stateDir=${resolvedStateDir}\n`
      + '  一个 state dir 只能对应一个运行中的网关（发现记录是单条的）。\n'
      + '  请先 `tusunsun stop`，或换一个 `--state-dir`。\n');
    process.exitCode = 1;
    return;
  }

  process.stderr.write('土行孙 starting...\n');
  process.stderr.write(`State: ${stateDir || '~/.tusunsun'}\n`);
  process.stderr.write('Press Ctrl+C to stop\n\n');

  const { Core } = await import('../core/core.js');
  const { PluginManager } = await import('../core/plugin-manager.js');
  // `join` 用模块级导入（R0-110 踩过：此处同名 `const { join }` 会让函数开头的 `join()` 落进 TDZ）。
  const { fileURLToPath } = await import('node:url');

  // R0-103（开源盘点 #4）：`--port` 必须真的传进内核（此前只打印、从不生效）。
  // null = 未指定，端口由 config 插件按「环境变量 > 配置文件 > 9002」决定。
  const core = new Core({ stateDir, port: args.port ?? null });
  // K-14：Core 不再静态依赖 plugins/_lib。ESM 形态诊断由**宿主**注入 ——
  // 依赖方向因此是"外围 → Core"，而不是反过来。不注入也能跑（只是少了那条建议文本）。
  core.esmHint = (await import('../../plugins/_lib/plugin-esm-hint.mjs')).esmShapeHint;
  const pm = new PluginManager(core);
  core.registerService('plugin-manager', pm);
  pm.addDirectory(core.pluginsDir);
  // 一律用 fileURLToPath：安装路径含非 ASCII 时 .pathname 会保留百分号编码导致 scandir ENOENT
  const dir = (rel) => fileURLToPath(new URL(rel, import.meta.url));
  // v0.9.25：这里曾有 `pm.addDirectory(dir('../builtin'))`。`src/builtin/` 合并进 `plugins/` 后，
  // 平台插件随 `core.pluginsDir` 一起装载，装配点从**两处**变回**一处**。
  await _assemblePluginDirs(core, pm, dir('../../'));

  await _earlyLoadConfig(core);
  // 端口在 config 装配完成后才有真值——横幅放在这里，避免"打印 18789、实际监听 9002"。
  const effectivePort = core.getService('config')?.get('gateway.port') ?? 9002;
  process.stderr.write(`Port: ${effectivePort}${args.port != null ? ' (--port)' : ''}\n`);
  await _loadScenePlugins(core, pm, args.scene);
  pm.registerCapabilities();

  // R0-88②（维护者授权）：停止失败必须影响退出码——此前无条件 exit(0)，
  // 使「有插件停止失败」与「全部干净停止」对调用方**不可区分**（实测的“错误成功”）。
  const _gracefulExit = async (code = 0) => {
    pm.stopWatching();
    await core.stop();
    const failures = core._stopFailures || [];
    if (failures.length) {
      core.log('error', `[exit] ${failures.length} 个插件未能干净停止：${failures.map((f) => f.plugin).join(', ')}`);
      process.exit(1);
    }
    process.exit(code);
  };
  process.on('SIGINT', () => _gracefulExit(0));
  process.on('SIGTERM', () => _gracefulExit(0));
  process.title = 'tusunsun-gw';
  await core.start();

  // R0-109/T1：启动完成后把**实际绑定端口**落到运行期文件，供 status/stop/chat 发现。
  // 这是 `--port 0` 与自定义端口唯一的可发现途径——此前它只出现在日志里，命令侧无从得知。
  const gw = core.getService('gateway');
  const boundPort = gw?.port ?? effectivePort;
  const runtimePath = join(core.stateDir, GATEWAY_RUNTIME_FILE);
  const { writeFileSync, rmSync } = await import('node:fs');
  // R0-110/T3：**只有真的在听**才写这条记录。
  // 实测缺陷：同端口的第二个实例 EADDRINUSE（gateway 插件 state='error'）时进程不退，还打印
  // `ready (18 plugins)`，并把运行期文件覆盖成自己的 pid ⇒ 此后所有 status/stop 都指向一个
  // 根本没在监听的进程；再后来它退出，又把文件删掉，让**仍在服务**的实例变得不可发现。
  const gatewayFailed = core.plugins?.get('gateway')?.state === 'error'
    || core._startFailures?.has?.('gateway') === true;   // 失败后已被清理出插件表，事实仍留在 _startFailures
  const listening = gw?.httpServer?.listening === true;
  // R0-110/T1：装配完成后才判"有没有对话能力"——在插件 start() 里判会误报（gateway 通常早于
  // haotian-lite 启动，此刻 chat.handle 还没注册；实测健康装配也打假告警）。旧世界是 /health
  // ok + status yes + READY，却在第一个对话请求上挂满超时。
  if (listening && !(await core.hasCapability('chat.handle'))) {
    core.log('warn', `[start] ${gw?._missingChatMessage?.() || "no chat capability: 'chat.handle' has no provider"}`);
  }
  if (gatewayFailed) {
    process.stderr.write('✗ gateway 插件启动失败（端口被占用、或安全策略拒绝对外监听）；'
      + `未写入 ${GATEWAY_RUNTIME_FILE}，进程以退出码 1 退出。\n`);
    // R0-113（P2）：这里此前调 `_gracefulExit()` 走的是 exit(0) —— 注释写着"退出码非 0"，
    // 实际"启动失败"与"正常运行结束"对脚本不可区分（实测对外监听被拒后 exit=0）。
    await _gracefulExit(1);
  } else if (!listening) {
    core.log('warn', '未装配 gateway 插件（无监听端口）⇒ 不写运行期端口文件');
  } else {
    try {
      // R0-110/T3：记录里带 `stateDir`，让读取方能判断"这条记录是不是我的"。
      writeFileSync(runtimePath, JSON.stringify({
        port: boundPort, pid: process.pid, stateDir: core.stateDir, startedAt: new Date().toISOString(),
      }, null, 2));
      // 清理挂在 `exit` 而不是只挂 SIGINT/SIGTERM：`tusunsun stop` 走的是 WS 的 `core.stop`
      // → 网关自己 `process.exit(0)`（见 `plugins/gateway.js` 的 core.stop 分支），
      // 只挂信号处理会让运行期文件在"正常停止"之后残留（实测过一次：stop 成功、文件还在）。
      process.on('exit', () => {
        try {
          // R0-110/T3：只删**自己写的那条**。无条件 rm 会误删别人的记录（实测：后启动的实例
          // 退出后，仍在服务的实例失去可发现性，status 转而报出另一个 state dir 的网关）。
          const cur = JSON.parse(readFileSync(runtimePath, 'utf8'));
          if (cur?.pid === process.pid) rmSync(runtimePath, { force: true });
        } catch { /* 文件已不在或已损坏：无需清理 */ }
      });
    } catch (e) {
      core.log('warn', `运行期端口文件写入失败（不影响运行，但 status/stop 可能定位不到）：${e.message}`);
    }
  }
  if (boundPort !== effectivePort) {
    process.stderr.write(`Port: ${effectivePort} → 实际监听 ${boundPort}（--port 0 时由内核分配）\n`);
  }

  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
    setTimeout(() => globalThis.gc(), 100);
  }

  pm.watchForChanges();
}

export async function main() {
  const args = process.argv.slice(2);
  // R0-103（#4 回归修复，由外部验收建议的 T4b 实测抓到）：这里**不得**给 port 兜底默认值。
  // 旧值 18789 是"只用来打印"的历史哨兵（当时 cmdStart 根本没把它传给 Core）；#4 把 port
  // 接进 Core 之后它就变成真的覆盖 ⇒ 不带 `--port` 启动时 `<stateDir>/config.json` 的
  // gateway.port 被顶掉，横幅还会谎称 `(--port)`。null = 未指定，端口交回 config 插件
  // 按「TUSUNSUN_PORT > 配置文件 > 9002」决定。
  const parsed = { port: null, stateDir: readEnv('STATE_DIR') };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--version' || args[i] === '-v') {
      const { readFileSync } = await import('node:fs');
      const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
      process.stdout.write(`土行孙 ${pkg.version}\n`);
      return;
    }
    if (args[i] === '--port' && args[i + 1]) { parsed.port = parseInt(args[++i]); continue; }
    if (args[i] === '--state-dir' && args[i + 1]) { parsed.stateDir = args[++i]; continue; }
    if (args[i] === '--scene' && args[i + 1]) { parsed.scene = args[++i]; continue; }
  }

  await cmdStart(parsed);
}
