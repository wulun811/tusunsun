#!/usr/bin/env node
// R0-116（第三轮 P1）：**干净安装 + 完整 CLI/WebSocket 旅程**的验收跑手。
// R0-117：ws 改为随仓内置（vendor/ws）后，本跑手的安装步骤升级为**离线安装**——
//         它现在同时是"发布物自包含"的正向证据。
//
// ── 为什么需要它 ─────────────────────────────────────────────────────────
// 第三轮评审在无网络的容器里 `npm install <tgz>` 失败（`getaddrinfo EAI_AGAIN`），于是
// `ws` 没装；而 `status` / `stop` / `tui` 全部**经 WebSocket** 与网关对话。结论因此只能写
// "UNVERIFIED"，并且单测/集成各有 3 项红在 `ws` 缺失上 —— 这不是源码缺陷，但也**不能**
// 用"原生 HTTP 通了"来替代：那批旅程确实一次都没在干净机器上跑过。
// 根因是"发布物不自包含"：唯一依赖要靠网络去 registry 取。R0-117 把 ws 内置进包，
// 于是同样的无网络环境不再是一种意外，而是被本跑手**主动构造**出来的验收条件。
//
// 本跑手把"最后一公里"变成可复现的一条命令：
//   ① 用给定的 tgz 在**干净目录**里 `npm install --offline`：断言零依赖、零生命周期脚本，
//      且内置副本真的落盘、`scripts/verify-vendor.mjs` 逐文件哈希自证通过；
//   ② 逐个 Node 版本跑完整旅程：
//        start → status（正确口令） → status（错误口令，必须失败） →
//        HTTP 非流式对话 → HTTP 流式对话 → WebSocket `agent.chat` →  stop → status（必须 3）
//   ③ 每个 Node 版本跑完清点**残留进程**（网关 / 外部引擎引擎），有残留即判失败。
//
// ── 用法 ─────────────────────────────────────────────────────────────────
//   node scripts/install-acceptance.mjs                     # 自己 pack（探测系统 npm），再跑 18/20/22
//   node scripts/install-acceptance.mjs --tgz path/to.tgz
//   node scripts/install-acceptance.mjs --nodes 22          # 只跑某个 Node
//   node scripts/install-acceptance.mjs --json out.json     # 额外写机器可读结果
//   node scripts/install-acceptance.mjs --gate --json r.json # **发布门禁**模式（CI 签字用）
//   node scripts/install-acceptance.mjs --pack-only         # 只验"能定位 npm 并 pack 出制品"
//   node scripts/install-acceptance.mjs --npm-cli /usr/bin/npm   # 显式指定 npm CLI
//
// ── 退出码（R0-118 起，第四轮 P1-02）──────────────────────────────────────
//   0 = 有通过、无失败（门禁模式下还要求：每个指定 Node 在场 + 无跳过）
//   1 = 有失败（门禁模式下含"指定的 Node 版本缺失"）
//   2 = **一条有效验收都没跑**（全部跳过），或找不到可用的 npm CLI
// 旧实现在"只有 Node 22 的机器上跑 --nodes 18,20"时得到"通过 0 / 失败 0 / 跳过 2 / exit 0"，
// 于是 CI 可以把"一个用例都没跑"当成绿色 —— 这正是本轮要修的那类"门禁存在但不执行"。
//
// ── 边界（诚实记录）──────────────────────────────────────────────────────
// · R0-117 起**不需要网络**（`--offline` 会证明这一点）；但 npm 自身的本地缓存/日志目录
//   仍被写入，且本机需有对应 Node 版本。诊断模式下缺版本报 skipped；**门禁模式下报失败**。
// · 支持 Windows / POSIX；每次运行的 JSON 只证明当前 platform/Node 的实际覆盖。
// · `tui` 是交互式 TUI，无法非交互驱动 —— 这里用**同一条 WebSocket 数据面**
//   （`agent.chat`）代替，并把它单列为一项，不假装跑过 TUI 界面本身。
// · "空闲自动退出"在土行孙里**不存在**这个功能，因此不设该项断言（不声称未实现的能力）。
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve, delimiter } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const args = process.argv.slice(2);
function argValue(name, dflt = null) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const TGZ_ARG = argValue('--tgz');
// R3（v0.16.0-rc）：默认 Node 列表从 `18,20,22` 改为 **`22`**。
// 理由：ADR-12 已经把 18/20 正式放弃（`engines: >=22`），而旧的默认值仍然要求它们“跑完旅程”——
// 于是一个**故意拒绝在 18/20 上启动**的正确行为被记成了 FAIL，发布门禁永远不可能通过。
// 若要显式验证“18/20 被正确拒绝”，用 `--nodes 18,20`：那条路径现在会把“预期拒绝”记成 PASS（见下面的 start 步骤）。
const NODES_ARG = argValue('--nodes', '22');
const JSON_OUT = argValue('--json');
const NPM_CLI_ARG = argValue('--npm-cli');
const GATE_MODE = args.includes('--gate');
const PACK_ONLY = args.includes('--pack-only');
const GATEWAY_KEY = 'acceptance-key-r0116';

const results = [];
/** 真的走完了八段旅程的 Node 大版本。`present` 只能看这个，不能看“有过任意一条 record”。 */
const journeys = new Set();
function record(node, step, ok, detail) {
  results.push({ node, step, ok, detail });
  const tag = ok === true ? '\x1b[32mPASS\x1b[0m' : ok === false ? '\x1b[31mFAIL\x1b[0m' : '\x1b[33mSKIP\x1b[0m';
  process.stdout.write(`  ${tag} [node${node}] ${step}${detail ? ' — ' + String(detail).slice(0, 220) : ''}\n`);
}

/** 找到某个大版本对应的 node 可执行文件目录（nvm 布局；也接受系统 PATH）。 */
function nodeBinDir(major) {
  const nvm = join(homedir(), '.nvm', 'versions', 'node');
  if (existsSync(nvm)) {
    const hit = readdirSync(nvm).find((d) => d === `v${major}.` + d.slice(d.indexOf('.') + 1) || d.startsWith(`v${major}.`));
    if (hit) return join(nvm, hit, 'bin');
  }
  if (process.versions.node.startsWith(`${major}.`)) return dirname(process.execPath);
  return null;
}

/**
 * 定位一个**可用的 npm CLI**（R0-118 / 第四轮 P1-01）。
 *
 * 旧实现硬编码 `join(ROOT, 'node_modules', 'npm', 'bin', 'npm-cli.js')` —— 那是"在开发树里
 * 用 `npm` 跑本脚本"的偶然事实，发布包里根本没有 `node_modules/npm`，于是官方推荐的
 * `node scripts/install-acceptance.mjs`（不带 --tgz）**在联网之前就以 MODULE_NOT_FOUND 退出**。
 * 评审实测踩到；而随包用例一直传 `--tgz`，所以从没暴露。
 *
 * 现在按可用性依次探测，全部失败就**明确报错**（而不是抛一个看不懂的模块路径）：
 *   ① `--npm-cli` 显式指定；② 与当前 node 同目录的 npm / npm.cmd（nvm、官方安装器、Windows）；
 *   ③ PATH 上的 npm / npm.cmd；④ `<nodeDir>/../lib/node_modules/npm/bin/npm-cli.js`（用 node 执行）；
 *   ⑤ `npm_execpath`（被 `npm run` 调用时由 npm 自己注入）。
 * @returns {{cmd:string, argv:string[], source:string}|null}
 */
function findNpmCli(explicit = null, nodeDir = dirname(process.execPath)) {
  const isWin = process.platform === 'win32';
  const exeNames = isWin ? ['npm.cmd', 'npm.exe', 'npm'] : ['npm'];
  const probe = (cmd, argv) => {
    // Windows batch files cannot be spawned directly. Execute npm's JS entry
    // with the selected Node, keeping paths/arguments out of a shell entirely.
    if (isWin && /npm(?:\.cmd|\.ps1)?$/i.test(cmd)) {
      const cli = join(dirname(resolve(cmd)), 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (!existsSync(cli)) return null;
      cmd = join(nodeDir, 'node.exe');
      argv = [cli];
    }
    const r = spawnSync(cmd, [...argv, '--version'], { encoding: 'utf8', timeout: 60000 });
    if (r.status !== 0) return null;
    const v = String(r.stdout || '').trim();
    return v ? { cmd, argv, version: v } : null;
  };

  if (explicit) {
    const direct = probe(explicit, []);
    if (direct) return { ...direct, source: '--npm-cli' };
    const viaNode = probe(join(nodeDir, isWin ? 'node.exe' : 'node'), [explicit]);
    if (viaNode) return { ...viaNode, source: '--npm-cli (node 执行)' };
    return null;
  }

  const candidates = [];
  const nodeExe = join(nodeDir, isWin ? 'node.exe' : 'node');
  candidates.push({ cmd: nodeExe, argv: [join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')], source: 'node 自带 node_modules/npm' });
  for (const name of exeNames) candidates.push({ cmd: join(nodeDir, name), argv: [], source: `与 node 同目录 (${nodeDir})` });
  for (const name of exeNames) candidates.push({ cmd: name, argv: [], source: 'PATH' });
  candidates.push({
    cmd: nodeExe,
    argv: [join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')],
    source: 'node 自带 lib/node_modules/npm',
  });
  if (process.env.npm_execpath) {
    candidates.push({ cmd: nodeExe, argv: [process.env.npm_execpath], source: 'npm_execpath' });
  }
  if (isWin) {
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH');
    for (const dir of (process.env[pathKey] || '').split(delimiter).filter(Boolean)) {
      candidates.push({ cmd: join(dir, 'npm.cmd'), argv: [], source: 'PATH (npm JS entry)' });
    }
  }
  // 只有"文件存在"才值得探（避免 spawn 一个必然 ENOENT 的路径）
  for (const c of candidates) {
    const looksExplicit = c.cmd !== 'npm' && c.cmd !== 'npm.cmd' && c.cmd !== 'npm.exe';
    if (looksExplicit && !existsSync(c.cmd) && !existsSync(c.argv[0] || '')) continue;
    const ok = probe(c.cmd, c.argv);
    if (ok) return { ...ok, source: c.source };
  }
  return null;
}

function run(cmd, argv, { cwd, env, timeoutMs = 120000, binDir = null } = {}) {
  return new Promise((resolvePromise) => {
    const merged = { ...process.env, ...(env || {}) };
    const pathKey = Object.keys(merged).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    if (binDir) merged[pathKey] = `${binDir}${delimiter}${merged[pathKey] || ''}`;
    const child = spawn(cmd, argv, { cwd, env: merged, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.stderr.on('data', (b) => { err += b.toString(); });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }, timeoutMs);
    child.on('error', (error) => { err += `${error.code || 'SPAWN_ERROR'}: ${error.message}`; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, out: stripAnsi(out), err: stripAnsi(err) });
    });
  });
}
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');

/** 假模型：OpenAI 兼容，支持非流式与 SSE。 */
function startMockModel() {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c.toString(); });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch { /* 忽略 */ }
      const users = (parsed.messages || []).filter((m) => m.role === 'user');
      const last = String(users.length ? users[users.length - 1].content : '');
      const reply = last.includes('STREAM') ? 'ACCEPT_STREAM_OK' : 'ACCEPT_HTTP_OK';
      if (!parsed.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      for (const piece of reply.match(/.{1,5}/g) || [reply]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece }, index: 0 }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return {
    server,
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', r)),
    close: () => new Promise((r) => server.close(r)),
    port: () => server.address().port,
  };
}

/** 一次 WebSocket 请求-响应（走真正的 RFC 6455 握手 + 子协议口令）。 */
async function wsRequest(port, method, params, { token = null, timeoutMs = 60000 } = {}) {
  const { WebSocket } = await import('../vendor/ws/wrapper.mjs');
  const protocols = token
    ? ['tusunsun.v1', `tusunsun.token.${Buffer.from(token, 'utf8').toString('base64url')}`]
    : undefined;
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const ws = protocols ? new WebSocket(`ws://127.0.0.1:${port}/ws`, protocols) : new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); try { ws.close(); } catch { /* 已关 */ } fn(v); };
    const timer = setTimeout(() => done(reject, new Error(`ws ${method} 超时`)), timeoutMs);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'req', id: 1, method, params: params || {} })));
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      // 网关在应答之前会推 `type:'event'`（request.start / chat.messages_built / request.end…）。
      // 只取 `type:'res'` 且 id 对得上的那一条 —— 拿事件当应答是脚本 bug，不是产品 bug。
      if (msg.type !== 'res' || (msg.id !== undefined && msg.id !== 1)) return;
      done(resolvePromise, msg);
    });
    ws.on('error', (e) => done(reject, e));
    ws.on('close', () => done(reject, new Error(`ws ${method} 被对端关闭（无应答）`)));
  });
}

/** 清点残留：本机上的 tusunsun 网关进程与外部引擎引擎。 */
function countResidue(stateDir, gatewayPid) {
  if (process.platform === 'win32') {
    const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'],
    { encoding: 'utf8', timeout: 30000, windowsHide: true });
    if (ps.status !== 0) throw new Error(`Cannot inspect Windows processes: ${ps.error?.message || ps.stderr}`);
    const rows = JSON.parse(ps.stdout || '[]');
    const processes = Array.isArray(rows) ? rows : [rows];
    const owned = new Set([gatewayPid]);
    for (let i = 0; i < processes.length; i++) {
      for (const p of processes) if (owned.has(p.ParentProcessId)) owned.add(p.ProcessId);
    }
    const scoped = processes.filter((p) => owned.has(p.ProcessId) || String(p.CommandLine || '').includes(stateDir));
    return { gw: scoped.filter((p) => p.ProcessId === gatewayPid || /tusunsun\.mjs.*start/.test(p.CommandLine || '')).length };
  }
  const ps = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  if (ps.status !== 0) throw new Error(`Cannot inspect processes: ${ps.error?.message || ps.stderr}`);
  const lines = String(ps.stdout || '').split('\n');
  const gw = lines.filter((l) => l.includes('tusunsun.mjs') && l.includes('start') && l.includes(stateDir)).length;
  return { gw };
}

async function main() {
  process.stdout.write('\x1b[1m土行孙 干净安装 + CLI/WebSocket 验收（R0-116 起；R0-117 起为**离线**安装 + 零依赖断言；R0-118 起默认命令可用、全跳过不再算通过）\x1b[0m\n');
  const work = mkdtempSync(join(tmpdir(), 'tusunsun-accept-'));

  // ── 0) 取制品（不给 --tgz 时自己 pack；npm CLI 必须**探测**，不能假设开发树布局）──
  let tgz = TGZ_ARG ? resolve(TGZ_ARG) : null;
  if (!tgz) {
    process.stdout.write('· 未给 --tgz，先 `npm pack` 当前树…\n');
    const npm = findNpmCli(NPM_CLI_ARG);
    if (!npm) {
      // 第四轮 P1-01：这里过去是 `join(ROOT,'node_modules','npm',...)` 硬编码 —— 发布包里没有它，
      // 于是默认命令在联网之前就 MODULE_NOT_FOUND。现在把"找不到 npm"说清楚，并给出解法。
      process.stdout.write(
        '\x1b[31m找不到可用的 npm CLI\x1b[0m：请把 npm 放进 PATH，或用 `--npm-cli <path>` / `--tgz <已有制品>` 指定。\n'
        + `（已尝试：与 node 同目录 ${dirname(process.execPath)}、PATH、node 自带 lib/node_modules/npm、npm_execpath）\n`,
      );
      process.exit(2);
    }
    process.stdout.write(`· 使用 npm ${npm.version}（来源：${npm.source}）\n`);
    const packed = await run(npm.cmd, [...npm.argv, 'pack', '--pack-destination', work],
      { cwd: ROOT, timeoutMs: 180000 });
    if (packed.code !== 0) {
      process.stdout.write(`\x1b[31m npm pack 失败（exit=${packed.code}）\x1b[0m\n${stripAnsi(packed.err).slice(-800)}\n`);
      process.exit(1);
    }
    const name = stripAnsi(packed.out).trim().split('\n').pop().trim();
    tgz = join(work, name);
  }
  if (!existsSync(tgz)) { process.stdout.write(`找不到制品：${tgz}\n`); process.exit(1); }
  const sha = createHash('sha256').update(readFileSync(tgz)).digest('hex');
  process.stdout.write(`· 制品：${tgz}\n  sha256=${sha}\n`);
  if (PACK_ONLY) {
    // 只验"默认命令能定位 npm 并真的 pack 出制品"这条路径（R0-118 G1 用它做真跑判据）。
    process.stdout.write(`· --pack-only：已产出制品，退出（${tgz}）\n`);
    if (!args.includes('--keep-tmp')) { try { rmSync(work, { recursive: true, force: true }); } catch { /* 尽力而为 */ } }
    process.exit(0);
  }
  const pkgVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

  const mock = startMockModel();
  await mock.listen();

  const wanted = NODES_ARG.split(',').map((s) => s.trim()).filter(Boolean);
  for (const major of wanted) {
    process.stdout.write(`\n\x1b[1m── Node ${major} ──\x1b[0m\n`);
    const binDir = nodeBinDir(major);
    if (!binDir) {
      // 第四轮 P1-02：门禁模式下"本机没有这个 Node 版本"是**失败**，不是"跳过"。
      // 旧实现在只有 Node 22 的机器上跑 `--nodes 18,20` 会得到"通过 0 / 失败 0 / 跳过 2"且 exit 0，
      // 也就是 CI 可以把"一个用例都没跑"当成绿色。
      if (GATE_MODE) {
        record(major, 'toolchain', false, `门禁模式要求 Node ${major} 必须在场（本机没有）`);
      } else {
        record(major, 'toolchain', null, `本机没有 Node ${major}，跳过（不是通过）`);
      }
      continue;
    }
    const nodeExe = join(binDir, process.platform === 'win32' ? 'node.exe' : 'node');
    const nodeV = spawnSync(nodeExe, ['-v'], { encoding: 'utf8' }).stdout.trim();
    // npm 也要按该版本自己的目录定位：nvm 每个版本各带一份 npm / npm-cli.js。
    const npmCli = findNpmCli(NPM_CLI_ARG, binDir);
    if (!npmCli) { record(major, 'toolchain', false, '找不到可用的 npm CLI'); continue; }

    const dir = join(work, `node${major}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'acceptance-host', private: true }, null, 2));

    // ── 1) 干净安装（R0-117：**离线**安装，证明自包含）────────────────────
    // `--offline` 强制只用本地缓存、绝不联网取元数据。发布物若还有任何 npm 依赖，
    // 这一步就会失败 —— 也就是说这条断言测的不是"装上了"，而是"**不需要装**"。
    const install = await run(npmCli.cmd, [...npmCli.argv, 'install', '--offline', '--no-audit', '--no-fund', tgz], {
      cwd: dir, binDir, timeoutMs: 300000,
    });
    if (install.code !== 0) {
      record(major, `install --offline (${nodeV})`, false, `exit=${install.code} ${stripAnsi(install.err).slice(-300)}`);
      continue;
    }
    const installedPkg = join(dir, 'node_modules', 'tusunsun', 'package.json');
    if (!existsSync(installedPkg)) { record(major, 'install', false, '未装出 node_modules/tusunsun'); continue; }
    const installed = JSON.parse(readFileSync(installedPkg, 'utf8'));
    // 自包含的**反向**断言：不许再落任何依赖（哪怕 ws 曾经是唯一那个）。
    const depNames = Object.keys(installed.dependencies || {});
    const depsOnDisk = readdirSync(join(dir, 'node_modules')).filter((n) => n !== 'tusunsun' && !n.startsWith('.'));
    if (depNames.length || depsOnDisk.length) {
      record(major, '自包含（零依赖）', false,
        `package.json deps=${JSON.stringify(depNames)} 落盘目录=${JSON.stringify(depsOnDisk)}`);
      continue;
    }
    const scripts = ['preinstall', 'install', 'postinstall'].filter((k) => installed.scripts && installed.scripts[k]);
    record(major, `install --offline (${nodeV})`, true,
      `tusunsun ${installed.version}，零依赖、离线装成${scripts.length ? ' ⚠ 生命周期脚本: ' + scripts.join(',') : ''}`);
    if (installed.version !== pkgVersion) record(major, 'version 一致', false, `包里 ${installed.version} ≠ 源码 ${pkgVersion}`);
    if (scripts.length) record(major, '无 install 生命周期脚本', false, scripts.join(','));

    // 内置依赖必须落盘且哈希可复核（拿包的人能自己验，而不是只能信我们）
    const vendorProbe = join(dir, 'node_modules', 'tusunsun', 'vendor', 'ws', 'wrapper.mjs');
    if (!existsSync(vendorProbe)) {
      record(major, '内置 ws 随包落盘', false, '缺少 vendor/ws/wrapper.mjs（网关与 WS 旅程都会废）');
      continue;
    }
    const vendorCheck = await run(nodeExe,
      [join(dir, 'node_modules', 'tusunsun', 'scripts', 'verify-vendor.mjs')], { cwd: dir, binDir, timeoutMs: 60000 });
    record(major, '内置 ws 完整性自证（verify-vendor）', vendorCheck.code === 0,
      (vendorCheck.out || vendorCheck.err).trim().split('\n').slice(-1)[0]);

    // ── 2) 旅程 ──────────────────────────────────────────────────────
    const ENTRY = join(dir, 'node_modules', 'tusunsun', 'tusunsun.mjs');
    const stateDir = join(dir, 'state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
      activeScene: 'gateway',
      gateway: { host: '127.0.0.1', port: 0, apiKey: GATEWAY_KEY },
      model: { model: 'mock', baseUrl: `http://127.0.0.1:${mock.port()}/v1`, apiKey: 'mock-key' },
    }, null, 2));
    // 隔离：不让宿主 .env / 环境变量渗进被测实例
    const HERMETIC = {
      TUSUNSUN_STATE_DIR: stateDir, TUSUNSUN_API_KEY: '', LLM_API_KEY: '',
      TUSUNSUN_BASE_URL: '', TUSUNSUN_MODEL: '', TUSUNSUN_ALLOW_REMOTE: '',
      TUSUNSUN_MODEL_HEADERS: '', TUSUNSUN_PROFILE: '', TUSUNSUN_GATEWAY_KEY: '',
    };
    const cli = (argv, extraEnv = {}, timeoutMs = 90000) => run(nodeExe, [ENTRY, ...argv], {
      cwd: dir, binDir, timeoutMs, env: { ...HERMETIC, ...extraEnv },
    });

    const runtimePath = join(stateDir, 'gateway.runtime.json');
    const gw = spawn(nodeExe, [ENTRY, 'start', '--port', '0', '--state-dir', stateDir, '--yes'], {
      cwd: dir, env: { ...process.env, ...HERMETIC }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let gwOut = '';
    gw.stdout.on('data', (b) => { gwOut += b.toString(); });
    gw.stderr.on('data', (b) => { gwOut += b.toString(); });
    let port = null;
    for (let i = 0; i < 500; i++) {
      if (existsSync(runtimePath)) {
        try { const rt = JSON.parse(readFileSync(runtimePath, 'utf8')); if (rt.port > 0) { port = rt.port; break; } } catch { /* 正在写 */ }
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    if (!port) {
      const out = stripAnsi(gwOut);
      // R3（v0.16.0-rc）：低于引擎下限的 Node **拒绝启动是正确行为**。
      // 把它记成 FAIL 会让门禁要求我们重新支持一个已放弃的平台（ADR-12），
      // 所以这里把它记成 PASS 并写明“这是引擎门禁生效”，然后跳过这个版本的后续旅程。
      if (Number(major) < 22 && /Node\.js 22\+ required/.test(out)) {
        // 「按设计拒绝启动」是**正确的产品行为**，但它同时意味着**这次旅程没跑**。
        // 旧代码把它记成 PASS，于是 `--gate --nodes 18` 在零旅程的情况下报到 `门禁判定：通过`：
        // 产品行为对、验收不成立，两件事必须分开记。
        record(major, 'start（按 ADR-12 预期拒绝：引擎门禁生效）', null,
          `engines 门禁生效，本次旅程未执行：${out.trim().split('\n')[0]}`);
        try { gw.kill('SIGKILL'); } catch { /* 已退出 */ }
        continue;
      }
      record(major, 'start', false, `未就绪：${out.slice(-300)}`);
      try { gw.kill('SIGKILL'); } catch { /* 已退出 */ }
      continue;
    }
    record(major, `start（port=${port}）`, true);

    try {
      // status：正确口令
      const st = await cli(['status', '--state-dir', stateDir, '--port', String(port)]);
      // 判据：退出码 0 且明确报"在运行"。**不判端口**——`status` 的输出里本来就不含端口
      // （它打的是 Running/Uptime/插件表），拿端口去比对是判据写错。
      const stOk = st.code === 0 && /Running:\s*yes/.test(st.out);
      record(major, 'status（正确口令，经 WebSocket）', stOk,
        stOk ? '' : `exit=${st.code} ${(st.out + st.err).replace(/\n/g, ' ').slice(0, 200)}`);

      // status：错误口令（env 覆盖优先级最高）
      const bad = await cli(['status', '--state-dir', stateDir, '--port', String(port)], { TUSUNSUN_GATEWAY_KEY: 'definitely-wrong-key' });
      const badOk = bad.code !== 0 && !/Running:\s*yes/.test(bad.out);
      record(major, 'status（错误口令必须失败）', badOk, badOk ? `exit=${bad.code}` : `exit=${bad.code} 输出=${(bad.out + bad.err).slice(0, 200)}`);

      // HTTP 数据面：非流式 + 流式
      const nonStream = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GATEWAY_KEY}` },
        body: JSON.stringify({ model: 'tusunsun', messages: [{ role: 'user', content: 'hello non-stream' }] }),
      });
      const nonBody = await nonStream.json().catch(() => ({}));
      const nonText = nonBody?.choices?.[0]?.message?.content || '';
      record(major, 'HTTP 非流式对话', nonStream.status === 200 && nonText.includes('ACCEPT_HTTP_OK'),
        `status=${nonStream.status} content=${JSON.stringify(nonText).slice(0, 80)}`);

      const streamRes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GATEWAY_KEY}` },
        body: JSON.stringify({ model: 'tusunsun', messages: [{ role: 'user', content: 'STREAM please' }], stream: true }),
      });
      const sse = await streamRes.text();
      // 按 SSE 语义把增量拼起来再判：流式正文本来就会被切成多片，原始报文里
      // `ACCEPT_STREAM_OK` 必然不连续（分片之间隔着 JSON 结构）。
      let streamed = '';
      let sawDone = false;
      for (const line of sse.split('\n')) {
        if (line.trim() === 'data: [DONE]') { sawDone = true; continue; }
        if (!line.startsWith('data: ')) continue;
        try {
          const j = JSON.parse(line.slice(6));
          streamed += j.choices?.[0]?.delta?.content || '';
        } catch { /* 非 JSON 行忽略 */ }
      }
      const streamOk = streamRes.status === 200 && streamed.includes('ACCEPT_STREAM_OK') && sawDone;
      record(major, 'HTTP 流式对话（SSE）', streamOk,
        `status=${streamRes.status} 拼装后=${JSON.stringify(streamed).slice(0, 60)} 含[DONE]=${sawDone}`);

      // WebSocket 数据面：`agent.chat`（tui 走的就是这条；证明 `ws` 真的可用）
      const wsRes = await wsRequest(port, 'agent.chat', { message: 'hello over websocket', sessionId: 'accept_ws' }, { token: GATEWAY_KEY });
      const wsText = wsRes?.payload?.reply || '';
      record(major, 'WebSocket agent.chat', wsRes?.ok === true && wsText.includes('ACCEPT_HTTP_OK'),
        `ok=${wsRes?.ok} reply=${JSON.stringify(wsText).slice(0, 80)}`);

      // stop → status（必须 3）
      const stop = await cli(['stop', '--state-dir', stateDir, '--port', String(port)]);
      record(major, 'stop（经 WebSocket）', stop.code === 0, `exit=${stop.code} ${(stop.out + stop.err).slice(0, 160)}`);
      let gone = false;
      for (let i = 0; i < 100; i++) {
        if (!existsSync(runtimePath)) { gone = true; break; }
        await new Promise((r) => setTimeout(r, 150));
      }
      record(major, '停止后运行期文件被清理', gone, gone ? '' : 'runtime.json 仍在');
      const after = await cli(['status', '--state-dir', stateDir, '--port', String(port)]);
      record(major, '停止后 status 必须非零（约定 3）', after.code === 3, `exit=${after.code}`);
    } finally {
      try { gw.kill('SIGTERM'); } catch { /* 已退出 */ }
      await new Promise((r) => setTimeout(r, 800));
      try { gw.kill('SIGKILL'); } catch { /* 已退出 */ }
      const residue = countResidue(stateDir, gw.pid);
      record(major, '无残留进程（网关）', residue.gw === 0,
        `gw=${residue.gw}`);
    }
    // 能走到这里 = 八段旅程真的跑过了（start/stop 失败会在上面 continue）。
    journeys.add(Number(major));
  }

  await mock.close();

  // ── 汇总 ────────────────────────────────────────────────────────────
  // R0-118（第四轮 P1-02）：退出码不能只看 failed.length。
  // 旧语义下"所有 Node 版本都不在场 ⇒ 跳过 2、通过 0、失败 0 ⇒ exit 0"，
  // 也就是 CI 可以把**一条验收都没跑**当成绿色门禁。现在分三档：
  //   · 有失败                     → 1
  //   · 通过数为 0（全跳过/全没跑） → 2（"没有跑任何有效验收"，绝不能当通过）
  //   · 门禁模式且任一被要求的前置缺失/被跳过 → 1
  const passed = results.filter((r) => r.ok === true);
  const failed = results.filter((r) => r.ok === false);
  const skipped = results.filter((r) => r.ok === null);
  const requested = NODES_ARG.split(',').map((s) => s.trim()).filter(Boolean);
  // 在场 = **真的走完了旅程**。旧算法是「有过任意一条 step !== 'toolchain' 的 record」，
  // 于是「预期拒绝启动」（一条 PASS）就足以让一个零旅程的 Node 算作在场。
  const present = requested.filter((m) => journeys.has(Number(m)));
  const gateOk = failed.length === 0 && skipped.length === 0 && passed.length > 0
    && present.length === requested.length;
  process.stdout.write('\n\x1b[1m=== 汇总 ===\x1b[0m\n');
  process.stdout.write(`  模式：${GATE_MODE ? '发布门禁 (--gate)' : '诊断（默认）'}\n`);
  process.stdout.write(`  通过 ${passed.length} | 失败 ${failed.length} | 跳过 ${skipped.length}\n`);
  process.stdout.write(`  要求的 Node：${requested.join(',')} ｜ 真正跑完旅程的：${present.join(',') || '（无）'}\n`);
  if (GATE_MODE) {
    process.stdout.write(`  门禁判定：${gateOk ? '\x1b[32m通过\x1b[0m' : '\x1b[31m不通过\x1b[0m'}`
      + `${gateOk ? '' : '（要求：每个指定 Node 在场、无跳过、无失败、至少跑完一次真实安装）'}\n`);
  }
  if (JSON_OUT) {
    mkdirSync(dirname(resolve(JSON_OUT)), { recursive: true });
    writeFileSync(JSON_OUT, JSON.stringify({
      tgz, sha256: sha, version: pkgVersion, platform: process.platform, node: process.version,
      mode: GATE_MODE ? 'gate' : 'diagnostic',
      gate: { ok: gateOk, requested_nodes: requested, ran_nodes: present,
        passed: passed.length, failed: failed.length, skipped: skipped.length },
      results,
    }, null, 2));
    process.stdout.write(`  机器可读结果：${JSON_OUT}\n`);
  }
  if (!args.includes('--keep-tmp')) { try { rmSync(work, { recursive: true, force: true }); } catch { /* 尽力而为 */ } }

  if (failed.length) process.exit(1);
  if (GATE_MODE && !gateOk) process.exit(1);
  if (passed.length === 0) {
    process.stdout.write('\x1b[31m  没有任何有效验收被执行（通过 0）—— 这不是通过，退出码 2\x1b[0m\n');
    process.exit(2);
  }
  process.exit(0);
}

main().catch((err) => { process.stdout.write(`\x1b[31m验收跑手自身出错：${err.stack}\x1b[0m\n`); process.exit(1); });
