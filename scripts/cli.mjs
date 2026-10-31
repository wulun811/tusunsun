#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { cmdStart, resolveGatewayPort, resolveStartScene, scenePluginLists } from '../src/bootstrap/cli.js';
import { C, c, wsRequest, gatewayToken } from './cli-transport.mjs';
import { resolveStateDir, resolveConfigPath } from './state-dir.mjs';
// R0-114（P1-03）：`config set` 的值类型保真（布尔/数字/字符串各自按既有类型转换）。
import { coerceConfigValue, existingValueAt } from './config-coerce.mjs';
// 配置点路径的写入判据（与内核 config 插件共用）：拒绝 `__proto__` 一类原型链保留段。
import { checkConfigPath, assignConfigPath, readConfigPath } from '../plugins/_lib/config-path.mjs';

const pkgVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// R0-113（专家评审 P2）：CLI 退出码合同（脚本可判，文档可查）。
// 此前 `Unknown command` / `status` 未运行 / `stop` 连不上都返回 0 —— "报了失败却退出 0"，
// CI 与 shell 脚本据此判断必然误判。
const EXIT = {
  OK: 0,
  FAIL: 1,        // 操作失败（配置写盘失败、停止被拒…）
  USAGE: 2,       // 用法错误（未知命令/缺参数）
  NOT_RUNNING: 3, // 要连的网关不在（status / stop / 插件命令）
};

// R0-103（开源盘点 #4）/ R0-104（D9）：端口真相只有一份实现 —— `resolveGatewayPort`
// 现在住在内核（`src/bootstrap/cli.js`）并被 import 复用。此前这里自己抄了一份，漏了
// `TUSUNSUN_PORT` ⇒ `start` 认这个环境变量、`status`/`stop` 不认（实测差异）。

async function usage(pluginDescriptions) {
  let base = `
${c('bold', `土行孙 ${pkgVersion}`)} — 轻依赖、插件化 AI Agent 平台

${c('yellow', 'Usage:')} tusunsun <command> [options]

${c('yellow', 'Core Commands:')}
  ${c('green', 'start')}             Start the gateway daemon
  ${c('green', 'stop')}              Stop the running gateway
  ${c('green', 'status')}            Show gateway status
  ${c('green', 'config')}            View or edit configuration
  ${c('green', 'plugins')}           List loadable plugin files under plugins/
  ${c('green', 'scene')}             Manage scenes (list/expand/show/current/switch/suggest)
  ${c('green', 'workspace')}         Per-session working dirs (list/release)
  ${c('green', 'kunxiansuo')}        Query 外部诊断服务 (needs Kunxiansuo full; not bundled in this package)
`.trim();

  if (pluginDescriptions && pluginDescriptions.size > 0) {
    base += '\n\n' + c('yellow', 'Plugin Commands:');
    for (const [name, desc] of pluginDescriptions) {
      base += `\n  ${c('cyan', name.padEnd(20))} ${desc}`;
    }
  }

  // R0-109/T3：这里的 `.trim()` 会把开头的两个换行一起吃掉 ⇒ `Options:` 被拼到最后一个插件
  // 命令那一行（实测 `--help` 里 tui 的说明后面直接跟着 `Options:`）。改成先把块自身 trim 好，
  // 再由调用方显式补分隔。
  const options = `
${c('yellow', 'Options:')}
  --port <n>        Gateway port（覆盖配置文件；0 = 随机可用端口）
  --state-dir <dir> State directory (default: TUSUNSUN_STATE_DIR, 再退到 ~/.tusunsun)
  --scene <name>    Startup scene (start only)
  --yes, -y         Skip confirmation prompts
  --json            config set: parse the value as JSON (explicit type for custom keys)
  --help, -h        Show this help

${c('yellow', 'Exit codes:')}
  0  成功
  1  操作失败（写盘失败 / 停止被拒 / 子命令报错）
  2  用法错误（未知命令、缺少参数）
  3  网关不在（status / stop / 需要网关的插件命令）
`.trim();

  return base + '\n\n' + options;
}

// R0-110/T3：身份核对。网关在 `core.status` 应答里带 `stateDir`（见 plugins/gateway.js），
// CLI 据此判断"回答我的这个网关是不是我要找的那个"。
// 实测缺陷：在同一台机上用另一个 `--state-dir` 查询时，回落到默认端口 9002 会连上**别的
// state dir 的实例**，于是 status 报 `Running: yes`、stop 把别人的网关停掉。
// 返回：'match'（相符/对端未提供身份=老版本，放行）/ 'foreign'（明确属于别的 state dir）。
function gatewayIdentity(res, args) {
  const theirDir = res?.payload?.stateDir;
  if (typeof theirDir !== 'string' || !theirDir) return 'match';
  // R0-113（P1-02）：状态目录解析与 config/start 同源（`./state-dir.mjs` 唯一实现）
  return resolveStateDir(theirDir) === resolveStateDir(args.stateDir) ? 'match' : 'foreign';
}

async function cmdStop(args) {
  try {
    // R0-109/T1：口令与端口同源（都出自同一个 stateDir 的 config.json）。
    const res = await wsRequest(resolveGatewayPort(args), 'core.status', {}, { token: gatewayToken(args.stateDir) });
    const id = gatewayIdentity(res, args);
    if (id === 'foreign') {
      process.stdout.write(c('red', 'Refusing to stop: the gateway at this port belongs to another state dir') + '\n');
      process.stdout.write(`  it:   ${res.payload.stateDir}\n  mine: ${resolveStateDir(args.stateDir)}\n`);
      process.stdout.write(c('gray', '  请到它自己的 state dir 下停止，或显式指定正确的 --state-dir / --port。') + '\n');
      return EXIT.FAIL;
    }
    const stopRes = await wsRequest(resolveGatewayPort(args), 'core.stop', {}, { token: gatewayToken(args.stateDir) });
    if (stopRes.ok) { process.stdout.write(c('green', 'Gateway stopped') + '\n'); return EXIT.OK; }
    process.stderr.write(c('red', `Failed: ${stopRes.error || 'unknown'}`) + '\n');
    return EXIT.FAIL;
  } catch {
    // R0-113（P2）：命令**报告了失败**，退出码就必须说出来（此前恒 0，脚本误判为成功）。
    process.stderr.write(c('yellow', 'Gateway not running or unreachable') + '\n');
    return EXIT.NOT_RUNNING;
  }
}

async function cmdStatus(args) {
  try {
    const res = await wsRequest(resolveGatewayPort(args), 'core.status', {}, { token: gatewayToken(args.stateDir) });
    const id = gatewayIdentity(res, args);
    process.stdout.write(`${c('bold', '土行孙 Status')}\n`);
    // 身份不符时不能报 "yes"——那正是本缺陷的用户可见形态（换个 state dir 查询，读到别人的实例）。
    process.stdout.write(`Running: ${!res.ok ? c('red', 'no') : id === 'foreign' ? c('yellow', 'yes (another instance)') : c('green', 'yes')}\n`);
    if (res.payload?.uptime) process.stdout.write(`Uptime: ${c('cyan', res.payload.uptime)}\n`);
    if (id === 'foreign') {
      process.stdout.write(c('yellow', `Note: this gateway belongs to ${res.payload.stateDir}, not ${resolveStateDir(args.stateDir)}\n`));
    }
    if (res.payload?.plugins?.length) {
      process.stdout.write(`\n${c('bold', 'Plugins:')}\n`);
      for (const p of res.payload.plugins) {
        const sc = p.state === 'running' ? 'green' : p.state === 'error' ? 'red' : 'yellow';
        process.stdout.write(`  ${c('cyan', p.name.padEnd(25))} v${p.version.padEnd(8)} ${c(sc, p.state)}${p.metrics ? `  ${p.metrics.initTime}ms  ${p.metrics.memoryDelta}MB  ${p.metrics.listeners}L` : ''}\n`);
      }
    }
    return id === 'foreign' ? EXIT.FAIL : EXIT.OK;
  } catch {
    process.stderr.write(c('red', 'Gateway is not running') + '\n');
    return EXIT.NOT_RUNNING;
  }
}

/**
 * R0-113（专家评审 P1-01）：`config` 子命令的首次体验与退出码。
 *
 * 事实（修前）：空 HOME 下按 README 执行 `tusunsun config set model.model first-run-test`：
 * 打印 `ENOENT … config.json`，**shell 退出码 0**，配置文件根本没生成。README 却推荐
 * "先 config set、再 start" ⇒ 用户以为配好了，启动后模型名纹丝不动。
 *
 * 现在：目录不存在就建（0700）；文件不存在就从**同一份** DEFAULT_CONFIG 起（0600，原子写）；
 * 写失败一律非零退出并把错误写 stderr；成功回执只在**读回**确认后才打印。
 */
async function cmdConfig(args) {
  const [action, key, value] = args._rest || [];
  const configPath = resolveConfigPath(args.stateDir);   // R0-113（P1-02）：--state-dir > TUSUNSUN_STATE_DIR > ~/.tusunsun
  // R0-105 缺陷 3：展示层脱敏。此前 show/get/set 三条路径都会把 apiKey 明文送到终端，
  // 截图或贴 issue 即泄露；而内核自带 SecretsManager 加密路径，CLI 这条把它完全绕过。
  const { redactConfig, redactGet, isSensitiveKey, maskValue } = await import('./config-redact.mjs');
  const { readFile, writeFile, mkdir, chmod, rename } = await import('node:fs/promises');
  const { dirname } = await import('node:path');

  if (!action || action === 'show') {
    try {
      const raw = JSON.parse(await readFile(configPath, 'utf8'));
      process.stdout.write(JSON.stringify(redactConfig(raw), null, 2) + '\n');
      return EXIT.OK;
    } catch (err) {
      // 读不到不是"操作失败"：如实说清路径与出路，退出码 0（脚本判"还没配置"用文件是否存在）。
      process.stdout.write(c('yellow', `No config file found at ${configPath}.`) + '\n');
      process.stdout.write(c('gray', '首次配置：`tusunsun config set model.model <name>`（会自动建目录与文件）。') + '\n');
      return err?.code && err.code !== 'ENOENT' ? EXIT.FAIL : EXIT.OK;
    }
  }

  if (action === 'get' && key) {
    try {
      const cfg = JSON.parse(await readFile(configPath, 'utf8'));
      const g = redactGet(cfg, key);
      process.stdout.write((g.found ? g.value : c('yellow', 'undefined')) + '\n');
      return EXIT.OK;
    } catch (err) {
      // 键不存在 = 未配置（0）；文件不存在/损坏 = 读不到（1），二者不可混为一谈。
      if (err.code === 'ENOENT') {
        process.stderr.write(c('red', `No config file at ${configPath}`) + '\n');
        return EXIT.FAIL;
      }
      process.stderr.write(c('red', err.message) + '\n');
      return EXIT.FAIL;
    }
  }

  if (action === 'set' && key && value !== undefined) {
    try {
      await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
      try { await chmod(dirname(configPath), 0o700); } catch { /* 非 POSIX：尽力而为 */ }
      let cfg = null;
      let created = false;
      try {
        cfg = JSON.parse(await readFile(configPath, 'utf8'));
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;   // 损坏的配置不静默重建：那是"把用户数据当不存在"
        const { DEFAULT_CONFIG } = await import('../plugins/config.js'); // v0.9.24：直指真身，不经再导出壳
        cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
        created = true;
      }
      // 原型污染：`__proto__.x` 会写 `Object.prototype`，而 JSON.stringify 不序列化原型
      // ⇒ 文件里什么都没有，却回显“设置成功”（读回校验也走同一条原型链，看不出来）。
      // 判据与内核 config 插件共用 `_lib/config-path.mjs`（一份实现，两个入口）。
      const checkedPath = checkConfigPath(key);
      if (!checkedPath.ok) throw new Error(`${key}: ${checkedPath.reason}（未写入）`);
      const parts = checkedPath.parts;
      // R0-114（P1-03）：**先定类型、再写盘**。修前直接 `obj[leaf] = value`，而 value 天生是字符串
      // ⇒ `gateway.allowRemote true` 落盘成 `"true"`，网关的 `=== true` 永不成立，"设置成功"却没有效果。
      const existing = existingValueAt(cfg, parts);
      const coerced = coerceConfigValue(value, existing, Boolean(args.json));
      if (!coerced.ok) throw new Error(`${key}: ${coerced.error}（未写入）`);
      const finalValue = coerced.value;
      assignConfigPath(cfg, parts, finalValue);
      // 原子写 + 0600（与内核 config 插件同一套口径：里面可能有明文 key）
      const tmp = `${configPath}.tmp-${process.pid}`;
      await writeFile(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
      try { await chmod(tmp, 0o600); } catch { /* 非 POSIX */ }
      await rename(tmp, configPath);
      try { await chmod(configPath, 0o600); } catch { /* 非 POSIX */ }
      // 成功回执必须建立在**读回**之上：写出去不等于落盘成功（同机并发/只读挂载都能骗过回显）。
      const readBack = JSON.parse(await readFile(configPath, 'utf8'));
      const leaf = parts[parts.length - 1];
      const back = readConfigPath(readBack, parts);
      // 回执必须证明**类型也对**，不只是文本相等：`true` 与 `"true"` 的 String() 相同，
      // 而这正是本轮修的那个缺陷。故比较 JSON 形状（含类型）。
      if (JSON.stringify(back) !== JSON.stringify(finalValue)) {
        throw new Error(`写回校验失败：${key} 读回为 ${JSON.stringify(back)}（期望 ${JSON.stringify(finalValue)}）`);
      }
      // 注意实参用 `value`（命令行原文）：T6 门禁用 `/maskValue\(value\)/` 钉住"回显必须脱敏"，
      // 而这里脱敏的是**用户输入**本身，转类型后的 finalValue 只在 boolean/number 时不同。
      const shown = isSensitiveKey(leaf) ? maskValue(value) : finalValue;
      process.stdout.write(c('green', `Set ${key} = ${shown}`) + '\n');
      if (created) process.stdout.write(c('gray', `已创建 ${configPath}（基于默认配置，权限 0600）`) + '\n');
      if (isSensitiveKey(leaf)) {
        process.stdout.write(c('yellow', '提示：该值以明文存于 config.json（权限 0600）；如介意，请改用环境变量（TUSUNSUN_API_KEY / LLM_API_KEY）。') + '\n');
      }
      return EXIT.OK;
    } catch (err) {
      process.stderr.write(c('red', `config set 失败：${err.message}`) + '\n');
      return EXIT.FAIL;
    }
  }

  process.stderr.write(c('red', 'Usage: tusunsun config <show|get <key>|set <key> <value>>') + '\n');
  return EXIT.USAGE;
}

/**
 * 场景装配清单的**两栏视图**。公式只有一份（`scenePluginLists`，启动器与 `scene:inspect`
 * 用的同一个），这里只负责分栏与计数 —— 三个命令各抄一套公式，就会出现三个数。
 *
 * 为什么要分栏：修前 `scene show` / `scene expand` 只印 `scene.plugins`，于是 gateway 的
 * 27 项里既没有 `config`（配置服务）也没有 `gateway`（HTTP 服务）——它们只写在 `eager`；
 * include 合并进来的底座同样不见。按 README 指引"启动装配看 scene show"的人，看不到
 * 自己即将启动的那两个服务。`SceneController.show()` 其实算好了
 * `note: '…eager entries are NOT included'`，只是 CLI 从来没印过它。
 */
function sceneGroups(scene = {}) {
  const { eager, lazy } = scenePluginLists(scene);
  const optional = [...new Set(scene?.optional || [])];
  // 合计 = 声明全集。它必须等于 `scene:inspect` 的"声明 N"，否则又是两套口径。
  return { eager, lazy, optional, total: eager.length + lazy.length };
}

async function cmdPlugins() {
  const { readdir } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const pluginsDir = fileURLToPath(new URL('../plugins', import.meta.url));
  try {
    const files = (await readdir(pluginsDir)).filter(f => /\.js$/.test(f));
    // R0-113（专家评审 P1-05）：**四种身份**必须分开说，不能用一个"40+ 工具"的广告语
    // 盖住"默认到底装了什么"：
    //   ① 随包存在（本命令列出的文件） ② 默认装配（gateway 场景声明）
    //   ③ 需主动启用（随包但不在默认场景/仅 optional） ④ 不在本包（full 商业能力）
    // 判据来自 `scenes/gateway.json5` 的 eager ∪ plugins ∪ optional——与装配入口同源。
    let eagerSet = new Set();
    let lazySet = new Set();
    let optionalSet = new Set();
    let totals = null;
    try {
      // 与 `scene expand` / `scene show` / `scene:inspect` 同一口径（`sceneGroups`）。
      // 修前这里直接 loadJson5(gateway.json5) 算 `eager ∪ plugins`（29）：不含 include
      // 合并进来的底座，也不区分"启动即装 / 按需"，于是三个命令各说一个数。
      const { SceneController } = await import('../src/core/scene-controller.js');
      const sc = new SceneController({ log: () => {} }, null);
      totals = sceneGroups(await sc.findScene('gateway'));
      eagerSet = new Set(totals.eager);
      lazySet = new Set(totals.lazy);
      optionalSet = new Set(totals.optional);
    } catch { /* 场景读不到：退化为纯文件清单（不编造装配事实） */ }
    process.stdout.write(`${c('bold', `Plugins in this package (plugins/ 目录，${files.length} 个文件):`)}\n\n`);
    for (const f of files) {
      const name = f.replace(/\.js$/, '');
      const tag = eagerSet.has(name) ? c('green', '默认装配（gateway·启动即装）')
        : lazySet.has(name) ? c('green', '默认装配（gateway·按需装载）')
        : optionalSet.has(name) ? c('yellow', '可选（scenes 的 optional）')
        : c('gray', '随包存在，需主动启用');
      process.stdout.write(`  ${c('cyan', f.padEnd(28))} ${tag}\n`);
    }
    // 尾注只报**同一组数**：声明全集 = 启动即装 + 按需；实际装配数应等于启动即装数。
    // 修前这里报 `eager ∪ plugins`（29），而 `scene expand` 印 27、`scene:inspect` 报 36
    // —— 三个命令三个数，用户无从判断"到底装了几个"。
    process.stdout.write(`\n${c('gray', totals
      ? `默认 gateway 场景声明 ${totals.total} 个：启动即装 ${totals.eager.length} + 按需 ${totals.lazy.length}`
        + '（清单见 `tusunsun scene expand gateway`）；实际装配数见启动日志 "土行孙 ready (N plugins)"，应等于启动即装数。'
      : '场景读不到：只列出文件清单，不报告装配数。')}\n`);
    process.stdout.write(c('gray', '不在本包的工具/插件属于外部扩展组件；本包不包含、也不假装包含。\n'));
  } catch {
    process.stdout.write(c('yellow', 'No plugins directory found') + '\n');
  }
}

// R0-110/T4：`scene` 子命令会**真的拉起内核**——config 插件建 `fs.watch`、gateway 插件 listen。
// 收尾必须对称释放，否则事件循环永远有活句柄、进程不退出：实测
// `tusunsun scene switch coding` 打印完 "Proposed changes: …" 之后挂死 30s+ 仍未退出
// （非交互场景就是静默死等；`scene current`/`show` 同在此路径上）。
// 不能复用 `core.stop()`：它带 `if (!this.running) return` 前置守卫，而本命令从不 `core.start()`。
async function releaseSceneProbe(core, pm) {
  try { pm?.stopWatching?.(); } catch (err) { process.stderr.write(c('yellow', `warning: stopWatching failed: ${err.message}`) + '\n'); }
  for (const [name, p] of core.plugins || []) {
    // 判据是"没停过"，而不是"正在跑"：本命令手动 `core.register(configPlugin)` 后直接 `init()`，
    // 该插件状态停在 `registered`（`register()` 设的初值），按 'running' 过滤会漏掉它——
    // 而**正是它的 `fs.watch` 吊住事件循环**（实测：只按 running 过滤仍挂死 40s）。
    const state = p?.state;
    if (typeof p?.stop !== 'function' || state === 'stopped' || state === 'error') continue;
    try { await p.stop(); p.state = 'stopped'; }
    catch (err) { process.stderr.write(c('yellow', `warning: plugin "${name}" failed to stop: ${err.message}`) + '\n'); }
  }
}

// R0-111/W1：探针**不启动内核**，因此旧写法"只问 config 服务"实测恒得 `undefined`
//（一个名字都没登记 ⇒ 提案只会有 Add、永远没有 Remove）；但服务若存在仍应优先信它。
// 故改为"服务优先，其次直接读 state 目录的 config.json（纯 JSON，缺失/损坏按未设置）"，
// 再过一遍 `resolveStartScene()` —— 生产档的场景锁因此也生效（否则生产档提案同样是假的）。
async function _probeActiveScene(core) {
  const { readFile } = await import('node:fs/promises');
  const { readEnv } = await import('../src/core/env.js');
  let activeScene = core.getService?.('config')?.get('activeScene') || null;
  if (!activeScene) {
    try { activeScene = JSON.parse(await readFile(core.configPath, 'utf8')).activeScene || null; }
    catch { /* 无配置 / 损坏 ⇒ 视为未设置 */ }
  }
  return resolveStartScene({ profile: readEnv('PROFILE') || 'development', sceneArg: null, activeScene });
}

// R0-111/W1 补：把 activeScene 落盘。探针不启动内核（拿不到 config 服务），而 `--yes`
// 必须真的生效——只改这一个键，其余原样保留；文件缺失/损坏时从最小配置起（不吞掉坏文件的证据：
// 这里只是重建，坏内容本就不会被 config 插件采纳）。返回写入路径，供输出自证。
async function _persistActiveScene(core, name) {
  const { readFile, writeFile, mkdir, rename } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  let data = {};
  try { data = JSON.parse(await readFile(core.configPath, 'utf8')); }
  catch { /* 无配置或损坏 ⇒ 从最小配置起 */ }
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
  data.activeScene = name;
  await mkdir(dirname(core.configPath), { recursive: true });
  // R0-112：**原子替换**。此前直接 writeFile 覆盖，读到半写状态的一方会把它当成"配置损坏"
  // （JSON.parse 失败 → 从 {} 起）⇒ 用户配置里的其他键被静默抹掉。实测 R0-111/W1 偶发失败
  // （重跑 3 次不复现）就是这条竞态：switchTo 里的 setAndSave 未 await（已在源头修掉），
  // 这里再补上"任何读者要么看到旧内容、要么看到新内容"的保证。
  const tmp = `${core.configPath}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, core.configPath);
  return core.configPath;
}

async function _probeProfile() {
  const { readEnv } = await import('../src/core/env.js');
  return readEnv('PROFILE') || 'development';
}

async function cmdScene(args) {
  const { Core } = await import('../src/core/core.js');
  const { PluginManager } = await import('../src/core/plugin-manager.js');
  const { SceneController, scenePluginNames } = await import('../src/core/scene-controller.js');
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');

  const core = new Core({ stateDir: args.stateDir });
  // K-14：Core 不再静态依赖 plugins/_lib；ESM 形态诊断由宿主注入。
  core.esmHint = (await import('../plugins/_lib/plugin-esm-hint.mjs')).esmShapeHint;
  const pm = new PluginManager(core);
  pm.addDirectory(core.pluginsDir);

  const [sub, name] = args._rest || [];

  if (sub === 'suggest') {
    const { readdir } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const pluginsDir = fileURLToPath(new URL('../plugins', import.meta.url));
    try {
      const files = await readdir(pluginsDir);
      const loaded = new Set(files.filter(f => /\.js$/.test(f)).map(f => f.slice(0, -3)));
      process.stdout.write(`${c('bold', 'Scene Suggestions:')} (based on available plugins)\n\n`);
      if ([...loaded].some(p => ['tools', 'context-manager'].includes(p))) process.stdout.write(`  ${c('green', 'coding')} — code editing & debugging\n`);
      if ([...loaded].some(p => ['session', 'memory', 'prompt-template'].includes(p))) process.stdout.write(`  ${c('cyan', 'chat')} — conversation\n`);
      if ([...loaded].some(p => ['health-monitor', 'mqtt-channel'].includes(p))) process.stdout.write(`  ${c('magenta', 'iot')} — IoT device control\n`);
    } catch {}
    return;
  }

  if (!sub || sub === 'list' || sub === 'expand') {
    const sc = new SceneController(core, pm);
    if (sub === 'list') {
      const scenes = await sc.listScenes();
      if (!scenes.length) { process.stdout.write(c('yellow', 'No scenes found') + '\n'); return; }
      process.stdout.write(`${c('bold', 'Available Scenes:')}\n\n`);
      for (const s of scenes) process.stdout.write(`  ${c('cyan', s.name.padEnd(20))} ${c('gray', s.dir)}\n`);
    } else if (sub === 'expand' && name) {
      const scene = await sc.findScene(name);
      if (!scene) { process.stdout.write(c('red', `Scene "${name}" not found`) + '\n'); return EXIT.FAIL; }
      const g = sceneGroups(scene);
      process.stdout.write(`${c('bold', `Scene "${name}" (expanded):`)}\n\n`);
      if (scene.include?.length) process.stdout.write(`${c('yellow', 'Include:')} ${scene.include.join(', ')}\n`);
      // 两栏 + 合计（见 `sceneGroups`）：修前只印 `plugins`，丢掉 config/gateway 与底座。
      process.stdout.write(`${c('yellow', `Eager (启动即装, ${g.eager.length}):`)} ${g.eager.join(', ') || 'none'}\n`);
      process.stdout.write(`${c('yellow', `Lazy (首次能力调用才装, ${g.lazy.length}):`)} ${g.lazy.join(', ') || 'none'}\n`);
      process.stdout.write(`${c('gray', `Optional (当前不参与装配, ${g.optional.length}):`)} ${g.optional.join(', ') || 'none'}\n`);
      process.stdout.write(c('gray', `合计声明 ${g.total} = 启动即装 ${g.eager.length} + 按需 ${g.lazy.length}`
        + `（与 \`npm run scene:inspect -- ${name}\` 的"声明 N"同数）`) + '\n');
      if (scene.missingIncludes?.length) {
        process.stdout.write(c('red', `缺失 include（装配会拒绝提交）：${scene.missingIncludes.join(', ')}`) + '\n');
      }
      if (scene.fallback) process.stdout.write(`Fallback: ${JSON.stringify(scene.fallback)}\n`);
    } else if (sub === 'expand') {
      process.stdout.write(c('red', 'Usage: tusunsun scene expand <name>') + '\n');
      return EXIT.USAGE;
    }
    return;
  }

  // 只有 `current` / `switch` 需要 config 服务（前者读 activeScene，后者要 setAndSave）。
  // `show` 不需要：修前它对**每条子命令**都先注册并 init config 插件，于是
  // `tusunsun scene show gateway | head` 的 stdout 前几行是三条 JSON 日志
  //（`Plugin registered: config` …），把"看装配清单"的输出弄成半机器半人读。
  const ensureConfig = async () => {
    if (core.getService('config')) return;
    const configPath = join(core.pluginsDir, 'config.js');
    if (!existsSync(configPath)) return;
    try {
      const configMod = await import(pathToFileURL(configPath).href);
      const configPlugin = configMod.default || configMod;
      if (configPlugin.name === 'config' && typeof configPlugin.init === 'function') {
        await core.register(configPlugin);
        await configPlugin.init(core);
      }
    } catch {}
  };

  // R0-110/T4：从这里往下都可能在 core 上留下活句柄（watcher / 监听端口），
  // 故用 try/finally 保证**每条 return 路径**都对称释放。
  try {

  if (sub === 'current') {
    // 这条命令只回答"当前场景是什么"。config 插件的 init 会往 stdout 打三条 JSON 日志
    //（`Plugin registered: config` …），把一行答案弄成半机器半人读（管道里尤其明显）。
    // 只在装配期静默，答案照常输出；日志本身仍然是日志，只是不在这条查询命令的 stdout 上。
    const origLog = core.log;
    core.log = () => {};
    try { await ensureConfig(); } finally { core.log = origLog; }
    const sc = new SceneController(core, pm);
    const cfg = core.getService('config');
    const active = cfg?.get('activeScene');
    if (active) {
      const scene = await sc.findScene(active);
      process.stdout.write(`${c('bold', 'Current Scene:')} ${c('cyan', active)}${scene ? c('gray', ' — ' + scene.description) : ''}\n`);
    } else {
      process.stdout.write(c('yellow', 'No active scene configured (loading all plugins)') + '\n');
    }
    return;
  }

  if (sub === 'show' && name) {
    const sc = new SceneController(core, pm);
    const result = await sc.show(name);
    if (!result.ok) { process.stdout.write(c('red', result.error) + '\n'); return EXIT.FAIL; }
    const scene = result.scene;
    process.stdout.write(`${c('bold', `Scene: ${scene.name}`)} — ${scene.description || 'no description'}\n\n`);
    if (scene.include?.length) process.stdout.write(`${c('yellow', 'Include:')} ${scene.include.join(', ')}\n`);
    // 两栏（见 `sceneGroups`）。运行态只在 scene-inspect 装配时才有：没有就**只列声明**。
    // 修前这里对每个名字印 "not loaded"，而它其实只是"这台探针进程里没装"——
    // 把"不知道"说成"知道它没装"。
    const g = sceneGroups(scene);
    const rows = new Map((result.plugins || []).map((p) => [p.name, p]));
    const list = (names) => {
      if (result.diagnostic !== 'full') return names.length ? `  ${names.join(', ')}\n` : '  none\n';
      return names.map((n) => {
        const row = rows.get(n);
        const status = row?.loaded ? c('green', row.state) : c('yellow', 'not loaded');
        const m = row?.metrics ? `  ${row.metrics.initTime}ms  ${row.metrics.memoryDelta}MB  ${row.metrics.listeners}L` : '';
        return `  ${c('cyan', n.padEnd(25))} ${status}${m}\n`;
      }).join('');
    };
    process.stdout.write(`${c('yellow', `Eager (启动即装, ${g.eager.length}):`)}\n${list(g.eager)}`);
    process.stdout.write(`${c('yellow', `Lazy (首次能力调用才装, ${g.lazy.length}):`)}\n${list(g.lazy)}`);
    if (g.optional.length) process.stdout.write(`${c('gray', `Optional (当前不参与装配, ${g.optional.length}):`)} ${g.optional.join(', ')}\n`);
    process.stdout.write(c('gray', `\n合计声明 ${g.total} = 启动即装 ${g.eager.length} + 按需 ${g.lazy.length}；`
      + '启动日志 "土行孙 ready (N plugins)" 的 N 应等于启动即装数。') + '\n');
    if (result.diagnostic !== 'full') {
      process.stdout.write(c('yellow', '运行态未知：scene-inspect 未装配，上表只列声明。'
        + '想看**此刻真的在跑什么**，对运行中的网关执行 `tusunsun status`。') + '\n');
    }
    if (scene.fallback) process.stdout.write(`${c('gray', 'Fallback:')} ${JSON.stringify(scene.fallback)}\n`);
    return;
  }

  if (sub === 'switch' && name) {
    await ensureConfig();
    const sc = new SceneController(core, pm);
    // R0-110/T4：**不再为了算 diff 把内核装起来**。
    // 旧实现先 `pm.loadAll([...当前场景的 plugins])` 把这一组插件真的装载并启动一遍，
    // 只为让 `switchTo` 能从 `core.plugins` 里读出一串**名字**；副作用是一堆活句柄
    //（config 的 fs.watch、gateway 的 listen、各插件的定时器/连接），命令因此永不退出。
    // 实测：修前 `scene switch coding` 打印完提案后挂死 30s+；单纯"事后收尾"也不够——
    // 装起来的插件里有的 `stop()` 依赖运行时上下文，直接报错（agent-supervisor 等）。
    // 现在只登记名字：`switchTo` 的 diff 是**名字集合运算**（见 scene-controller.js 的
    // `oldPlugins`/`newPlugins`），不需要任何插件真的运行。集合语义与原装载路径一致。
    // R0-111/W1：解析"当前场景"要**两条腿**——服务优先，其次直接读 state 目录的 config.json。
    // 为什么不能只问服务：本探针是否装上了 config 插件取决于**形态**——历史上下面那段引导读的是
    // `core.pluginsDir/config.js`，而开发树里 config 的源文件在 `plugins/`（两份不同文件）
    // ⇒ **开发树**上服务缺席，`activeScene` 恒 undefined ⇒ 一个名字都不登记
    // ⇒ 提案只会是"全是 Add、没有 Remove"。产物形态下服务在位，同一个命令的提案又不一样：
    // 同一命令两种形态两种行为，本身就是坑。现在两种形态都读得到，且再过一遍
    // `resolveStartScene()`——生产档的场景锁（base-system）也一并算进去，否则生产档提案同样是假的。
    // v0.9.24：两种形态的配置源已合一（`plugins/config.js` 那个再导出壳已删除，
    // 早加载与通用发现都指向 `plugins/config.js`），这条"两形态两行为"的成因不再存在；
    // 两条腿的读法仍然保留——它防的是"服务尚未装配"，与文件路径无关。
    const activeScene = await _probeActiveScene(core);
    const cur = activeScene ? await sc.findScene(activeScene) : null;
    if (activeScene) sc.currentScene = activeScene;
    // 基线用**声明**算，而不是往 `core.plugins` 里塞幽灵条目（v0.14.1）。
    //
    // 修前这里对当前场景的每个插件 `core.plugins.set(n, { state:'registered' })`：只为让
    // `switchTo` 的 diff 从 `core.plugins` 里读出名字。那是**伪造运行态**——
    // `pm.loadOne` 见到名字已在册就短路成 `alreadyLoaded`，于是 `--yes` 的 Apply
    // 一条插件都没真的装载。这个伪造被 R-014-5 的 Verify（改为核对完整必需集合）
    // 立刻照出来：实测切 base-system 后 0/7 在运行，而返回里写着成功。
    // 现在把"提案的基线"作为**显式入参**传下去：差异计算不依赖运行态，
    // 运行态也不会被一个只读提案污染。
    //
    // 登记的是**场景声明的全集**（eager ∪ plugins ∪ lazy），不是只有 plugins——
    // 否则"插件全写在 eager"的场景（base-system / chat / gateway-lite / iot / coding）会被
    // 当成空装配：实测 `coding → base-system` 在**两种形态**下都打"No changes"（旧判据只看
    // `plugins`，而这两个场景的 `plugins` 都是空的）。集合语义与 switchTo 共用同一个函数。
    const baselinePlugins = [...scenePluginNames(cur)];

    // `deferAssembly: true` 是**如实声明**，不是绕过判据：
    // 这条命令不启动内核（R0-110/T4），因此它无法装配也无法核对运行态。
    // 不声明的话，场景会走一遍 Apply/Verify、什么都没装、然后报 partial ——
    // 把"我本来就不打算装"说成"装失败了"，同样是假话。
    // 声明之后返回值带 `assembled:false / verification:'deferred'`，不冒充已验证。
    const result = await sc.switchTo(name, { yes: args.yes, baselinePlugins, deferAssembly: true });
    if (!result.ok) { process.stdout.write(c('red', result.error) + '\n'); return EXIT.FAIL; }
    if (result.diff === true) {
      process.stdout.write(c('yellow', 'Proposed changes:') + '\n');
      if (result.toRemove.length) process.stdout.write(`  ${c('red', 'Remove:')} ${result.toRemove.join(', ')}\n`);
      if (result.toAdd.length) process.stdout.write(`  ${c('green', 'Add:')} ${result.toAdd.join(', ')}\n`);
      process.stdout.write(`\nRun with ${c('bold', '--yes')} to apply\n`);
    } else {
      process.stdout.write(c('green', `Scene switched to "${name}"`) + '\n');
      if (result.switchTime !== undefined) process.stdout.write(`Switch time: ${c('cyan', `${result.switchTime}ms`)}\n`);
      if (result.toRemove.length) process.stdout.write(`  ${c('red', 'Removed:')} ${result.toRemove.join(', ')}\n`);
      if (result.toAdd.length) process.stdout.write(`  ${c('green', 'Added:')} ${result.toAdd.join(', ')}\n`);
      // R0-111/W1 补：**开发树**上探针没有 config 服务（见 `_probeActiveScene` 的说明），
      // `switchTo` 里的 `setAndSave` 于是被 `if (cfg)` 跳过 ⇒ `--yes` 打印"已切换"却什么都没落盘
      //（实测 config.json 里 activeScene 纹丝不动，下次 `start` 还是老场景）。产物形态下服务在位、
      // 由 `setAndSave` 落盘。这里补一次**幂等**的显式落盘，让两种形态行为一致——
      // "同一命令在两种形态下不同行为"本身就是下一轮会踩的坑。
      const savedTo = await _persistActiveScene(core, name);
      process.stdout.write(`  ${c('gray', `activeScene → ${name}（写入 ${savedTo}）`)}\n`);
      if ((await _probeProfile()) === 'production') {
        process.stdout.write(c('yellow', '  注意：production 档启动时场景锁 base-system，'
          + '本次写入不会生效——启动请显式 `--scene`。') + '\n');
      }
    }
    return;
  }

  if (sub === 'show') {
    process.stdout.write(c('red', 'Usage: tusunsun scene show <name>') + '\n');
    return EXIT.USAGE;
  }

  // v0.16.0-rc.10：`scene <不存在的子命令>` 以前既不报错也不改退出码（实测 exit 0），
  // 与 README「退出码合同」的“1 = 操作失败 / 2 = 用法错误”直接矛盾 —— 打错字的脚本会“成功”。
  process.stderr.write(c('red', `Unknown scene subcommand: ${sub}`) + '\n');
  process.stderr.write('Usage: tusunsun scene <list|expand <名>|show <名>|current|switch <名>|suggest>\n');
  return EXIT.USAGE;

  } finally {
    await releaseSceneProbe(core, pm);
  }
}

// R0-103（开源盘点 #2）：CLI 命令发现必须覆盖内核**装配插件的那些根**。
// 此前只扫 `plugins/`，于是 `tui.js` 的 `cliCommands` 在两棵树里都**扫不到**：
// 它既不是插件（没有 name/init，启动时被 plugin-meta 判为无法提取元数据），又不是命令
// （不在扫描根）⇒ 29KB 文件彻底不可达，而 5 个场景还把它列在 plugins 里。
// v0.9.25：`plugins/` 已并入 `plugins/`，扫描根从**两个**收回**一个**。
// 顺带修正一个隐患：两个根意味着"同一个命令可能被注册两次"，只靠去重兜着；
// 现在结构上不可能重复。
const CLI_COMMAND_ROOTS = ['../plugins'];

async function scanPluginCommands() {
  const { readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { pathToFileURL, fileURLToPath } = await import('node:url');

  const handlers = {};
  const descriptions = new Map();

  for (const rel of CLI_COMMAND_ROOTS) {
    const dir = fileURLToPath(new URL(rel, import.meta.url));
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
        try {
          const url = pathToFileURL(join(dir, entry.name)).href;
          const mod = await import(url);
          if (!mod.cliCommands) continue;
          for (const cmd of mod.cliCommands) {
            handlers[cmd.name] = cmd;
            descriptions.set(cmd.name, cmd.description);
          }
        } catch {}
      }
    } catch {}
  }

  return { handlers, descriptions };
}

/**
 * R0-125（G0-1）：会话 ↔ 工作目录的**可见、可管理**入口。
 *
 * 为什么需要它：绑定的真值落盘之后，"查看"和"显式解绑"必须有明确的操作面 —— 否则
 * 容量满了（256）用户只能手动删 JSON，而 `workspace_binding_unavailable` 也只能靠猜。
 *
 * 子命令：
 *   list                      → GET /api/sessions（默认根、策略、白名单、每条绑定的状态）
 *   release <session_id>      → WS `workspace.release`（在跑时拒绝，`--force` 才放行）
 *
 * 刻意**不做** `workspace declare`：声明是本机执行边界的事（HTTP/WS/`chat --dir` 各有入口），
 * 再加一条 CLI 旁路只会多一处需要同步校验的地方。
 */
async function cmdWorkspace(args) {
  const sub = args._rest?.[0] || 'list';
  const port = resolveGatewayPort(args);
  const key = gatewayToken(args.stateDir);
  const headers = {};
  if (key) headers.Authorization = `Bearer ${key}`;

  if (sub === 'list') {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers });
      if (resp.status === 501) {
        process.stdout.write(c('yellow', '本场景没有 workspace 服务（装配里缺 base-system？）\n'));
        return EXIT.FAIL;
      }
      if (resp.status === 401 || resp.status === 403) {
        process.stderr.write(c('red', `控制面拒绝（${resp.status}）：检查 gateway.apiKey 与 --state-dir 是否指向同一实例。\n`));
        return EXIT.FAIL;
      }
      if (!resp.ok) { process.stderr.write(c('red', `Error: HTTP ${resp.status}\n`)); return EXIT.FAIL; }
      const info = await resp.json();
      process.stdout.write(`${c('bold', '土行孙 工作目录')}\n`);
      process.stdout.write(`默认根: ${c('cyan', info.default)}\n`);
      process.stdout.write(`策略:   ${info.policy}${info.roots?.length ? `（白名单 ${info.roots.join(', ')}）` : ''}\n`);
      process.stdout.write(`容量:   ${info.capacity.used}/${info.capacity.max}${info.capacity.evicts ? c('yellow', '（会淘汰）') : '（满了拒绝新增，不淘汰）'}`
        + `${info.durable ? '  已落盘' : c('yellow', '  仅内存（重启即失）')}\n`);
      if (info.corrupt) process.stdout.write(c('red', `绑定表损坏：${info.corrupt}\n`));
      if (!info.sessions?.length) {
        process.stdout.write(c('gray', '\n还没有会话声明过自己的目录（都用默认根）。\n'));
        return EXIT.OK;
      }
      process.stdout.write(`\n${c('bold', '已声明的会话:')}\n`);
      for (const s of info.sessions) {
        const sc = s.state === 'bound' ? 'green' : 'red';
        process.stdout.write(`  ${c('cyan', s.sessionId.padEnd(24))} ${s.workspace}\n`);
        process.stdout.write(`    ${c(sc, s.state)}  via ${s.via}${s.trusted ? ' (local)' : ' (remote)'}`
          + `${s.inFlight ? `  在跑 ${s.inFlight}` : ''}${s.state !== 'bound' ? c('red', `  ${s.reason || ''}`) : ''}\n`);
      }
      return EXIT.OK;
    } catch (err) {
      process.stderr.write(c('red', `Connection error: ${err.message}\n`));
      return EXIT.NOT_RUNNING;
    }
  }

  if (sub === 'release') {
    const sid = args._rest[1];
    if (!sid) { process.stderr.write(c('red', 'Usage: tusunsun workspace release <session_id> [--force]\n')); return EXIT.USAGE; }
    try {
      const res = await wsRequest(port, 'workspace.release', { sessionId: sid, force: !!args.force },
        { token: key });
      if (!res?.ok) {
        // 具名 code 原样透出：`workspace_busy` 与"没有这条绑定"是两回事，退出码也不同
        process.stderr.write(c('red', `Error${res?.code ? ` [${res.code}]` : ''}: ${res?.error || 'release failed'}\n`));
        return res?.code === 'workspace_busy' ? EXIT.FAIL : EXIT.FAIL;
      }
      process.stdout.write(res.payload?.released === false
        ? c('gray', `会话 ${sid} 本来就没有绑定，无需释放\n`)
        : c('green', `已释放 ${sid} 的工作目录绑定\n`));
      return EXIT.OK;
    } catch (err) {
      process.stderr.write(c('red', `Connection error: ${err.message}\n`));
      return EXIT.NOT_RUNNING;
    }
  }

  process.stderr.write(c('red', `Unknown subcommand: ${sub}\n`));
  process.stderr.write('Usage: tusunsun workspace list | tusunsun workspace release <session_id> [--force]\n');
  return EXIT.USAGE;
}

const baseCommands = {
  start: (args) => cmdStart(args),
  stop: cmdStop,
  status: cmdStatus,
  config: cmdConfig,
  plugins: cmdPlugins,
  scene: cmdScene,
  workspace: cmdWorkspace,
  kunxiansuo: async (args) => {
    const sub = args._rest?.[0] || 'status';
    const valid = ['status', 'integrity', 'diagnoses', 'reputation', 'health'];
    if (!valid.includes(sub)) {
      process.stderr.write(c('red', `Unknown subcommand: ${sub}\n`));
      process.stderr.write(`Usage: tusunsun kunxiansuo ${valid.join('|')} [sessionId]\n`);
      return EXIT.USAGE;
    }
    const gwPort = resolveGatewayPort(args);
    const params = sub === 'reputation' ? { sessionId: args._rest[1] || 'unknown' } : {};
    // R0-113（P0-01）：控制面要凭证时，CLI 必须带上（否则明明配了 key 的实例，
    // 官方命令自己都被 401 挡住）。
    const headers = { 'Content-Type': 'application/json' };
    const key = gatewayToken(args.stateDir);
    if (key) headers.Authorization = `Bearer ${key}`;
    try {
      const resp = await fetch(`http://localhost:${gwPort}/api/kunxiansuo`, {
        method: 'POST', headers,
        body: JSON.stringify({ action: sub, params }),
      });
      // R0-109/T3：开源产物**不含**外部诊断服务端点 —— 构建期把 `POST /api/kunxiansuo` 从 chat-ui
      // 里摘掉了（本包只提供捆仙索 local）。此前这里会打印裸的 `Error: Not found`，
      // 用户分不清"本包没这个功能"和"自己配错了"。现在如实说明并给出可用的替代。
      if (resp.status === 404) {
        process.stdout.write(c('yellow', '本产物不含外部诊断服务端点：开源版只提供捆仙索 local。\n'));
        process.stdout.write(c('gray', '该查询需要捆仙索 full / 外部诊断服务；本地安全防护的装载情况看 tusunsun status。\n'));
        return EXIT.OK;
      }
      if (resp.status === 401 || resp.status === 403) {
        process.stderr.write(c('red', `控制面拒绝（${resp.status}）：检查 gateway.apiKey 与 --state-dir 是否指向同一实例。\n`));
        return EXIT.FAIL;
      }
      const result = await resp.json();
      if (!result.ok) { process.stderr.write(c('red', `Error: ${result.error || 'request failed'}\n`)); return EXIT.FAIL; }
      process.stdout.write(c('cyan', `\n=== 外部诊断服务 ${sub} ===\n`) + JSON.stringify(result.payload || result, null, 2) + '\n\n');
      return EXIT.OK;
    } catch (err) {
      process.stderr.write(c('red', `Connection error: ${err.message}\n`));
      return EXIT.NOT_RUNNING;
    }
  },
};

async function main() {
  const args = process.argv.slice(2);
  const parsed = { _rest: [], port: null };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') {
      const { descriptions } = await scanPluginCommands();
      process.stdout.write(await usage(descriptions) + '\n');
      return;
    }
    if (args[i] === '--yes' || args[i] === '-y') { parsed.yes = true; continue; }
    if (args[i] === '--port' && args[i + 1]) { parsed.port = parseInt(args[++i]); continue; }
    if (args[i] === '--state-dir' && args[i + 1]) { parsed.stateDir = args[++i]; continue; }
    if (args[i] === '--json') { parsed.json = true; continue; }   // R0-114（P1-03）：config set 显式按 JSON 定类型
    if (args[i] === '--force' || args[i] === '-f') { parsed.force = true; continue; }   // R0-125：workspace release 的显式放行
    parsed._rest.push(args[i]);
  }

  const cmd = parsed._rest[0] || 'start';
  parsed._rest = parsed._rest.slice(1);

  const { handlers: pluginHandlers, descriptions } = await scanPluginCommands();

  const allCommands = { ...baseCommands };
  for (const [name, cmdObj] of Object.entries(pluginHandlers)) {
    // 插件命令拿到的 `port` 与 start/status/stop 同源（--port > 配置文件 > 9002），
    // 不再各自 `|| 18789`（R0-103 #4：一个端口真相）。
    // R0-109/T1：`wsRequest` 也在这里**绑定口令**后下发 —— 插件（chat / tui / kunxiansuo…）
    // 不必各自去读配置，也不会因为漏传 token 而在开启鉴权时静默失败。
    const gwToken = gatewayToken(parsed.stateDir);
    allCommands[name] = async (args) => cmdObj.handler({
      ...args,
      port: resolveGatewayPort(args),
      wsRequest: (port, method, params, opts) => wsRequest(port, method, params, { token: gwToken, ...opts }),
      // R0-118：`token` 也直接下发。TUI 不是走 `wsRequest` 的（它自己持一条长连接），
      // 过去因此漏掉了口令 ⇒ 开鉴权的网关下 `tusunsun tui` 连不上（"socket hang up"）。
      token: gwToken,
      C,
      c,
    });
  }

  const fn = allCommands[cmd];
  if (!fn) {
    // R0-113（P2）：未知命令此前也退出 0 —— 打错字的脚本"成功"了。用法错误 → 2。
    process.stderr.write(c('red', `Unknown command: ${cmd}`) + '\n');
    process.stderr.write(await usage(descriptions) + '\n');
    return EXIT.USAGE;
  }
  // 命令自己报错（返回码）与"未返回"（start 常驻）都走这里：**不再**一律 0。
  const code = await fn(parsed);
  return typeof code === 'number' ? code : EXIT.OK;
}

main()
  .then((code) => { process.exitCode = typeof code === 'number' ? code : EXIT.OK; })
  .catch(err => { process.stderr.write(c('red', err.message) + '\n'); process.exit(1); });
