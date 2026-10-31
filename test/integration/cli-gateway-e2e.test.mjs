// R0-109/T1：CLI ↔ 网关端到端 —— 这条缝此前是**零覆盖**。
//
// 为什么非要有它：R0-109 审计发现 `status` / `stop` / `chat` 三个命令在"网关活着"时全部
// **静默失效**（零输出 + exit 0），而在"网关没起"时反而能正确报错；根因是 CLI 侧写裸
// WebSocket 帧、没有 RFC 6455 握手（网关只认 `GET /ws` + Upgrade 头），且缺 'close' 分支
// 导致 promise 永不 settle、事件循环排空后 node 静默退场。
// 而当时全套 354 条单测 + 41 条集成用例里，`grep wsRequest|cli-transport` 在 test/ 下
// **0 命中** —— 所以它能一直活着。这条用例按"用户实际怎么用"把整条链路跑一遍。
//
// 形态说明（v0.9.25 起**只有一种布局**，此前有两种）：
//   历史上"产物形态"会把 `plugins/sancai/haotian/haotian-lite.js` 平铺成
//   `plugins/haotian-lite.js`，于是 `chat` 只在产物里才是可发现的 CLI 命令
//   （命令发现只扫装配根的**一层**）。现在本仓就是单一布局：`haotian-lite.js` 一直在顶层，
//   `chat` 一直是命令，所以这条分支实际恒为真。
// 保留探测逻辑而不写死，是因为下游兼容树仍把插件放在两级目录下。
// 判据不变："声明即行为"——**承诺了就必须能用**，没承诺就不假装测过。
//
// 反向证据（改这四处，本用例必红，已逐一实测）：
//   ① 还原历史根因（无握手 + 缺 close 分支）→ T1a 的 status 断言红
//   ② 去掉 `--port 0` 的运行期端口文件          → T1a 卡在端口发现
//   ③ 去掉 chat 的 stdin-EOF 守卫              → T1b 红（未捕获拒绝）
//   ④ 去掉运行期文件的 exit 清理               → T1a 卡在收尾清除

// R0-115：子进程一律走受管 spawn（独立进程组 + 登记回收）。
import { spawnManaged } from '../lib/proc.mjs';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestRunner, assert, assertEquals } from '../harness.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ENTRY = join(ROOT, 'tusunsun.mjs');
const RUNTIME_FILE = 'gateway.runtime.json';

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');

/**
 * 子进程环境必须干净：`TUSUNSUN_PORT`/`TUSUNSUN_STATE_DIR` 会盖过 `--state-dir` 与运行期文件。
 *
 * R0-113：**模型配置也必须干净**。本机工作目录若放了 `.env`（开发/交付树常见），
 * `tusunsun.mjs` 会自动加载它，于是"没 key 的实例"变成"有 key"、`/ready` 的判据随环境漂移
 * ——实测交付树的 `.env`（指向某免费模型端点）就是这样让两条 readiness 断言变成假红/假绿。
 * `.env` 只在对应环境变量**未定义**时才生效（见 tusunsun.mjs 的 loadDotenvFile），
 * 故这里显式置空：`''` 被 `readEnv` 当作未设置，同时挡住 `.env` 的注入。
 */
const HERMETIC = {
  TUSUNSUN_STATE_DIR: '', TUSUNSUN_PORT: '',
  TUSUNSUN_API_KEY: '', LLM_API_KEY: '', TUSUNSUN_BASE_URL: '', TUSUNSUN_MODEL: '',
  TUSUNSUN_GATEWAY_KEY: '', TUSUNSUN_ALLOW_REMOTE: '', TUSUNSUN_MODEL_HEADERS: '', TUSUNSUN_PROFILE: '',
};
function cleanEnv() {
  return { ...process.env, ...HERMETIC };
}

/** 跑一次 CLI 子进程并收全量输出（stdout+stderr 合一——断言的正是用户真正看到的东西）。 */
function runCli(args, { input = null, timeoutMs = 90000 } = {}) {
  return new Promise((resolve) => {
    const child = spawnManaged(process.execPath, [ENTRY, ...args], {
      cwd: ROOT, env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.stderr.on('data', (b) => { out += b.toString(); });
    // R0-115：超时用整组回收（kill 只打子进程，孙进程会孤儿化）。
    const timer = setTimeout(() => { child.reap().catch(() => {}); }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out: stripAnsi(out) });
    });
    child.stdin.end(input ?? '');
  });
}

async function waitFor(fn, { timeoutMs = 30000, what = '条件' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待${what}超时（${timeoutMs}ms）`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** 端口是否已无人监听（网关真的退了，而不只是"命令说退了"）。 */
function portFree(port) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

/** 发一个 JSON 请求并计时——T1 的判据是"**快**速拒绝"，所以耗时是断言的一部分。 */
async function postJson(port, path, body, { timeoutMs = 15000 } = {}) {
  const t0 = Date.now();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  return { status: res.status, text, ms: Date.now() - t0 };
}

/**
 * 起一个 `--port 0` 的网关（端口由内核分配），返回句柄。
 * 端口只能从**运行期文件**得知——这正是 T1 补上的那条可发现性。
 */
async function startGateway(extraArgs = [], extraEnv = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'r0109-cli-gw-'));
  const runtimePath = join(stateDir, RUNTIME_FILE);
  const gw = spawnManaged(process.execPath, [ENTRY, 'start', '--port', '0', '--state-dir', stateDir, '--yes', ...extraArgs], {
    cwd: ROOT, env: { ...cleanEnv(), ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  gw.stdout.on('data', (b) => { out += b.toString(); });
  gw.stderr.on('data', (b) => { out += b.toString(); });

  let port;
  try {
    port = await waitFor(() => {
      if (!existsSync(runtimePath)) return null;
      try {
        const rt = JSON.parse(readFileSync(runtimePath, 'utf8'));
        return typeof rt.port === 'number' && rt.port > 0 ? rt.port : null;
      } catch { return null; }
    }, { what: '运行期端口文件（gateway.runtime.json）' });
  } catch (e) {
    if (gw.exitCode !== null) throw new Error(`网关提前退出（code=${gw.exitCode}）：${stripAnsi(out).slice(-1200)}`);
    throw e;
  }

  const stopEverything = async () => {
    // R0-115：整组回收，连网关 spawn 的 python 引擎一起带走（此前只 SIGKILL 网关本身，
    // 引擎被 PID 1 收养后永久空转）。仍有进程未回收 → 抛错，不让用例带着孤儿过关。
    const leaked = await gw.reap();
    if (leaked.length > 0) throw new Error(`网关子进程未能回收：${leaked.map((r) => r.pid).join(',')}`);
    rmSync(stateDir, { recursive: true, force: true });
  };
  return { gw, stateDir, runtimePath, port, startOut: () => stripAnsi(out), stopEverything };
}

export async function setup(runner) {
  // 形态探测：见文件头「形态说明」。单一布局下恒为 true；下游兼容树里可能为 false。
  const ossForm = existsSync(join(ROOT, 'plugins', 'haotian-lite.js'));
  const help = await runCli(['--help']);
  const advertises = (name) => new RegExp(`^\\s*${name}\\s`, 'm').test(help.out);

  runner.test('R0-109/T1a CLI↔网关：status 能发现 --port 0 的网关、stop 真停且不留残余', async () => {
    const g = await startGateway();
    try {
      assert(g.port !== 9002, `--port 0 必须是内核分配的端口，不得回落 9002（实际 ${g.port}）`);
      const rt = JSON.parse(readFileSync(g.runtimePath, 'utf8'));
      assertEquals(rt.pid, g.gw.pid, '运行期文件里的 pid 必须是网关进程');
      assert(new RegExp(`实际监听 ${g.port}`).test(g.startOut()),
        `启动横幅必须报出实际绑定端口 ${g.port}，实际输出：${JSON.stringify(g.startOut().slice(-400))}`);

      // 修复前：网关明明在听，这条命令**零输出**且 exit 0（本用例的核心断言）。
      const status = await runCli(['status', '--state-dir', g.stateDir]);
      assert(/Running:\s*yes/.test(status.out),
        `status 必须报 Running: yes（修复前此处零输出且 exit 0），实际输出：${JSON.stringify(status.out)}`);
      assert(/gateway/.test(status.out),
        `status 必须列出实际装配的插件，实际输出：${JSON.stringify(status.out)}`);
      assertEquals(status.code, 0, 'status 退出码应为 0');
      console.log(`       [实测] --port 0 → 运行期文件报 ${g.port}；status 报 Running: yes（修复前：零输出 + exit 0）`);

      // 没承诺 chat 的形态（开发树）不得假装测过；承诺了的形态必须在下面的 T1b 里被真正验证。
      if (ossForm) {
        assert(advertises('chat'), '产物形态必须把 chat 登记为可用命令（`--help` 里应列出），否则下面的端到端验证会静默消失');
      }

      const stop = await runCli(['stop', '--state-dir', g.stateDir]);
      assert(/Gateway stopped/.test(stop.out), `stop 必须报告已停止，实际输出：${JSON.stringify(stop.out)}`);

      // 注意：不能拿 `exitCode` 本身当"满足条件"——退出码 0 是**假值**，waitFor 会一直等下去
      // （本用例第一版就栽在这里：网关早已退出，测试却在等它退出）。
      const gwExit = await waitFor(() => (g.gw.exitCode !== null ? { code: g.gw.exitCode } : null),
        { timeoutMs: 15000, what: '网关进程退出' });
      assertEquals(gwExit.code, 0, '网关收到 core.stop 后应以 0 退出');
      await waitFor(() => portFree(g.port), { timeoutMs: 15000, what: `端口 ${g.port} 释放` });
      await waitFor(() => !existsSync(g.runtimePath), { timeoutMs: 10000, what: '运行期文件清除' });
      console.log(`       [实测] stop → 网关退出(0)、端口 ${g.port} 释放、运行期文件清除`);

      // 停完之后必须回到"如实报没在跑"，不能留下一个永远说 yes 的假状态。
      // 注意：运行期记录已被清除 ⇒ 端口回落到该 state dir 的 config（默认 9002）。如果**开发机
      // 上恰好有别的网关**在 9002（或它属于别的 state dir），报 "another instance" 也是诚实答案；
      // 这里要拦的是"对自己的网关说 yes"的那种假状态。
      const afterStop = await runCli(['status', '--state-dir', g.stateDir]);
      assert(/Gateway is not running/.test(afterStop.out) || /another instance/.test(afterStop.out),
        `停完再 status 必须如实报没在跑（或明确标注那是别的实例），实际输出：${JSON.stringify(afterStop.out.slice(0, 400))}`);
    } finally {
      await g.stopEverything();
    }
  });

  if (advertises('chat')) {
    runner.test('R0-109/T1b chat：管道喂消息必须拿回答复或可读错误，不得静默丢弃、不得抛未捕获拒绝', async () => {
      const g = await startGateway();
      try {
        const chat = await runCli(['chat', '--state-dir', g.stateDir], { input: '说三个字\n' });
        const after = chat.out.split(/Agent:/).slice(1).join('Agent:').trim();
        assert(after.length > 0,
          `chat 必须在 "Agent:" 之后给出答复或可读错误（修复前：打印完 "Agent:" 就静默退出），实际输出：${JSON.stringify(chat.out)}`);
        assert(!/Unhandled Rejection|ERR_USE_AFTER_CLOSE/.test(chat.out),
          `chat 在 stdin 结束（管道/EOF）后不得抛未捕获拒绝，实际输出：${JSON.stringify(chat.out)}`);
        assertEquals(chat.code, 0, 'chat 正常结束应返回 0');
        console.log(`       [实测] chat 拿回真实结果：${JSON.stringify(after.slice(0, 80))}`);
      } finally {
        await g.stopEverything();
      }
    });
  } else {
    // 不注册而不是"注册后跳过"：`noteSkip` 在必验收模式（TT_REQUIRE_PRECONDITIONS=1）下会硬红，
    // 而这里根本不是"前置缺失"，是这个形态**结构上就没有** chat 命令。
    console.log(`       [NOT_RUN] 本形态未承诺 chat 命令（ossForm=${ossForm}），T1b 不注册`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // R0-110：三条"门面不许骗人"的回归锁。都来自**真实使用**里撞到的缺陷。
  // ══════════════════════════════════════════════════════════════════════

  runner.test('R0-110/T1 无对话能力的装配：/health 必须降级、chat 端点必须秒级 503（不得挂满 600s）', async () => {
    // base-system = 8 插件的内核底座，**没有** model / haotian-lite / 工具 ⇒ 无 chat.handle。
    // 这正是 `TUSUNSUN_PROFILE=production` 默认锁定的装配（README 未写，缺陷由此而来）。
    const g = await startGateway(['--scene', 'base-system']);
    try {
      const health = await (await fetch(`http://127.0.0.1:${g.port}/health`, { signal: AbortSignal.timeout(10000) })).json();
      assertEquals(health.status, 'degraded', `/health 在无对话能力时必须降级，实际：${JSON.stringify(health)}`);
      assert(Array.isArray(health.missing) && health.missing.includes('chat.handle'),
        `/health 必须列出缺失能力，实际：${JSON.stringify(health)}`);
      assert(g.startOut().includes('no chat capability'),
        `启动日志必须在**启动期**就说清缺对话能力，实际：${JSON.stringify(g.startOut().slice(-500))}`);

      // 修复前：本端点 60s 内零字节，命令超时 600s 之后还会走到 `result.payload?.reply` 为
      // undefined ⇒ HTTP 200 + 空正文（比挂住更糟：调用方以为模型没话说）。
      const r = await postJson(g.port, '/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] });
      assertEquals(r.status, 503, `无对话能力时必须 503，实际 ${r.status}：${r.text.slice(0, 200)}`);
      assert(r.ms < 5000, `必须**快速**拒绝（实测 ${r.ms}ms；修复前是 600s 超时）`);
      assert(r.text.includes('chat.handle') && r.text.includes('--scene'),
        `503 正文必须点名缺什么并给出下一步，实际：${r.text.slice(0, 300)}`);
      console.log(`       [实测] base-system：health=${health.status}、chat → ${r.status} in ${r.ms}ms`);
    } finally {
      await g.stopEverything();
    }
  });

  runner.test('R0-111/W3 liveness 与 readiness 分离：/health 恒 200，/ready 缺能力时 503', async () => {
    // 判"活着"与判"能干活"是两件事，此前只有 /health 且永远 200 ⇒ 接负载均衡的部署
    // 没有任何机器可判的信号可以摘掉坏实例（只能靠人读正文）。
    const get = async (port, path) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(10000) });
      return { status: res.status, body: await res.json().catch(() => null) };
    };

    const bad = await startGateway(['--scene', 'base-system']);
    try {
      const h = await get(bad.port, '/health');
      assertEquals(h.status, 200, `/health 是 liveness：进程还在服务就必须 200，实际 ${h.status}`);
      assertEquals(h.body.status, 'degraded', '/health 正文仍须如实降级');
      const r = await get(bad.port, '/ready');
      assertEquals(r.status, 503, `/ready 缺对话能力时必须 503（LB 据此摘流量），实际 ${r.status}`);
      assertEquals(r.body.ready, false, '/ready 必须带 ready:false');
      assert(Array.isArray(r.body.missing) && r.body.missing.includes('chat.handle'),
        `/ready 必须列出缺什么，实际：${JSON.stringify(r.body)}`);
      assert(typeof r.body.error === 'string' && r.body.error.includes('--scene'),
        `/ready 正文必须可操作（给出 --scene 出路），实际：${JSON.stringify(r.body.error)}`);
      console.log(`       [实测] base-system：/health ${h.status} ${h.body.status}、/ready ${r.status} ready=${r.body.ready}`);
    } finally {
      await bad.stopEverything();
    }

    // R0-113（专家评审 P1-04）：`/ready` 现在按 L2 判——"本地条件是否足以真的对话"。
    // 默认模型的端点在公网且没有 key ⇒ **必须** 503 且 missing 点名 model.apiKey；
    // /health 仍须 200（进程活着），否则就把 liveness 和 readiness 又混成一条。
    const noKey = await startGateway();
    try {
      const h2 = await get(noKey.port, '/health');
      assertEquals(h2.status, 200, '/health 是 liveness，缺凭证也必须 200');
      const r2 = await get(noKey.port, '/ready');
      assertEquals(r2.status, 503, `缺模型凭证时 /ready 必须 503（修复前报 200 ready:true，而真实对话 502），实际 ${r2.status}`);
      assertEquals(r2.body.ready, false, '/ready 必须带 ready:false');
      assert(Array.isArray(r2.body.missing) && r2.body.missing.includes('model.apiKey'),
        `/ready 必须点名 model.apiKey，实际：${JSON.stringify(r2.body)}`);
      assert(/TUSUNSUN_API_KEY|config set model.apiKey/.test(String(r2.body.error)),
        `/ready 正文要给出可操作的下一步，实际：${JSON.stringify(r2.body.error)}`);
      console.log(`       [实测] 无模型凭证：/health ${h2.status} ${h2.body.status}、/ready ${r2.status} missing=${JSON.stringify(r2.body.missing)}`);
    } finally {
      await noKey.stopEverything();
    }

    // 给一个（假的）模型 key ⇒ 本地条件齐备，/ready 才能 200（不真的调用模型）
    const ok = await startGateway([], { TUSUNSUN_API_KEY: 'r0-113-dummy-key' });
    try {
      const r = await get(ok.port, '/ready');
      assertEquals(r.status, 200, `健康装配的 /ready 必须 200，实际 ${r.status}：${JSON.stringify(r.body)}`);
      assertEquals(r.body.ready, true, '/ready 必须带 ready:true');
      assertEquals(r.body.status, 'ok', '/ready 正文 status 应为 ok');
      assert(!r.body.error, '/ready 就绪时不应带 error 字段');
      console.log(`       [实测] 默认场景 + 模型凭证：/ready ${r.status} ready=${r.body.ready}（/health 与 /ready 同源同真）`);
    } finally {
      await ok.stopEverything();
    }
  });

  runner.test('R0-110/T3 同一 state dir 的第二个实例必须 fail-closed，且不得污染第一个的发现记录', async () => {
    const a = await startGateway();
    try {
      const rt = JSON.parse(readFileSync(a.runtimePath, 'utf8'));
      assertEquals(rt.pid, a.gw.pid, '前置：运行期记录应属于第一个实例');
      assert(rt.stateDir && rt.stateDir.length > 0, '运行期记录必须带 stateDir（身份），实际：' + JSON.stringify(rt));

      // 修复前：第二个实例要么 EADDRINUSE 后继续跑并**覆盖**记录，要么换端口起来跟第一个争记录；
      // 两种都会让 status/stop 指向错误对象。
      const dup = await runCli(['start', '--port', '0', '--state-dir', a.stateDir], { timeoutMs: 25000 });
      assertEquals(dup.code, 1, `同 state dir 的重复启动必须非 0 退出，实际 code=${dup.code}：${dup.out.slice(-300)}`);
      assert(/已有存活网关/.test(dup.out), `重复启动必须说明原因与下一步，实际：${JSON.stringify(dup.out.slice(-300))}`);

      const rtAfter = JSON.parse(readFileSync(a.runtimePath, 'utf8'));
      assertEquals(rtAfter.pid, a.gw.pid, '第一个实例的运行期记录不得被覆盖');

      const st = await runCli(['status', '--state-dir', a.stateDir]);
      assert(/Running:\s*yes/.test(st.out), `第一个实例必须仍然可被发现，实际：${JSON.stringify(st.out.slice(0, 300))}`);

      // 身份核对（T3 的用户可见形态）：显式指向 A 的端口、却声明另一个 state dir ⇒ 不得报平白的 yes。
      const otherDir = mkdtempSync(join(tmpdir(), 'r0110-other-'));
      try {
        const foreign = await runCli(['status', '--port', String(a.port), '--state-dir', otherDir]);
        assert(/another instance/.test(foreign.out),
          `跨 state dir 查询必须标注 "another instance"，实际：${JSON.stringify(foreign.out.slice(0, 300))}`);
        assert(/belongs to/.test(foreign.out), `必须说明它属于哪个 state dir，实际：${JSON.stringify(foreign.out.slice(0, 300))}`);

        const refuse = await runCli(['stop', '--port', String(a.port), '--state-dir', otherDir]);
        assert(/Refusing to stop/.test(refuse.out), `跨 state dir 的 stop 必须拒绝，实际：${JSON.stringify(refuse.out.slice(0, 300))}`);
        // 拒绝之后 A 必须还活着——这是"拒绝"与"假装拒绝但已经停了"的区别。
        const still = await runCli(['status', '--state-dir', a.stateDir]);
        assert(/Running:\s*yes/.test(still.out), '被拒绝的 stop 不得真的停掉别人的网关');
        console.log('       [实测] 跨 state dir：status → another instance；stop → Refusing to stop（目标仍存活）');
      } finally { rmSync(otherDir, { recursive: true, force: true }); }
      console.log(`       [实测] 重复启动 exit=${dup.code}，记录仍属 pid ${rtAfter.pid}，status 仍报 Running: yes`);
    } finally {
      await a.stopEverything();
    }
  });

  runner.test('R0-110/T4 scene 子命令必须退出：不得为算 diff 把内核拉起来后挂死', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'r0110-scene-'));
    try {
      const cases = [
        [['scene', 'list'], /Available Scenes/, 'scene list'],
        [['scene', 'current', '--state-dir', stateDir], /Current Scene|No active scene/, 'scene current'],
        [['scene', 'show', 'gateway', '--state-dir', stateDir], /Scene:\s*gateway/, 'scene show gateway'],
        [['scene', 'switch', 'coding', '--state-dir', stateDir], /Proposed changes|No changes|Scene switched/, 'scene switch coding'],
      ];
      for (const [args, want, label] of cases) {
        const t0 = Date.now();
        const r = await runCli(args, { timeoutMs: 20000 });
        const dt = Date.now() - t0;
        // 挂死时 runCli 会 SIGKILL，code 为 null ⇒ 这条断言直接把"没退出"判红。
        assertEquals(r.code, 0, `${label} 必须正常退出（code=${r.code}，输出：${JSON.stringify(r.out.slice(-300))}）`);
        assert(dt < 15000, `${label} 必须在 15s 内退出（实测 ${dt}ms；修复前 scene switch 挂死 30s+）`);
        assert(want.test(r.out), `${label} 输出不符合预期：${JSON.stringify(r.out.slice(-300))}`);
        console.log(`       [实测] ${label} → exit 0 in ${dt}ms`);
      }
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  runner.test('R0-110/T4b 场景命令的失败必须体现在退出码上（不能“报错却 exit 0”）', async () => {
    // 实测（rc.10 之前）：`scene show nope` / `scene expand nope` / `scene switch nope`
    // 都打印“not found”却退出 **0**；`scene bogus` 更是什么都不说、也退出 0。
    // 与 README「退出码合同」（1 = 操作失败、2 = 用法错误）直接矛盾：打错字的脚本会“成功”。
    const cases = [
      [['scene', 'show', 'no-such-scene'], 1, /not found/, 'scene show 不存在'],
      [['scene', 'expand', 'no-such-scene'], 1, /not found/, 'scene expand 不存在'],
      [['scene', 'switch', 'no-such-scene'], 1, /not found/, 'scene switch 不存在'],
      [['scene', 'bogus-subcommand'], 2, /Unknown scene subcommand/, 'scene 未知子命令'],
      [['scene', 'show'], 2, /Usage/, 'scene show 缺参数'],
      // 合法正例：正常路径不得被“一律非零”误伤
      [['scene', 'list'], 0, /Available Scenes/, 'scene list（合法正例）'],
    ];
    for (const [args, wantCode, wantOut, label] of cases) {
      const r = await runCli(args, { timeoutMs: 20000 });
      assertEquals(r.code, wantCode, `${label} 应退出 ${wantCode}，实测 ${r.code}（输出：${JSON.stringify(r.out.slice(-200))}）`);
      assert(wantOut.test(r.out), `${label} 输出不符合预期：${JSON.stringify(r.out.slice(-200))}`);
      console.log(`       [实测] ${label} → exit ${r.code}`);
    }
  });

  runner.test('R0-111/W1 场景提案必须说真话：增删按 eager∪plugins、--yes 真的落盘', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'r0111-scene-'));
    try {
      // 从 coding（插件全写在 eager、plugins 为空）切到 base-system：
      // 旧实现这里恒打"No changes"——提案与真实装配完全脱节。
      // 用一个**没有任何环境变量能覆盖**的键来验"落盘不冲掉其他键"。
      // （曾用 `model.model`：交付仓的 `.env` 里有 `TUSUNSUN_MODEL`，按"环境变量 > .env > config.json"
      // 的既定优先级它**本就该**被覆盖——那样测的就不是落盘行为，而是优先级了。）
      writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ activeScene: 'coding', probeKeep: { k: 1 } }));

      const propose = await runCli(['scene', 'switch', 'base-system', '--state-dir', stateDir], { timeoutMs: 20000 });
      assertEquals(propose.code, 0, `提案必须正常退出（code=${propose.code}）`);
      assert(/Remove:/.test(propose.out),
        `提案必须列出会被卸载的插件（旧实现只看 plugins ⇒ coding 的 eager 全被忽略 ⇒ "No changes"）：${JSON.stringify(propose.out.slice(-300))}`);
      assertEquals(JSON.parse(readFileSync(join(stateDir, 'config.json'), 'utf8')).activeScene, 'coding',
        '提案（不带 --yes）不得改动配置');

      const apply = await runCli(['scene', 'switch', 'base-system', '--yes', '--state-dir', stateDir], { timeoutMs: 30000 });
      assertEquals(apply.code, 0, `--yes 必须正常退出（code=${apply.code}）：${JSON.stringify(apply.out.slice(-300))}`);
      const after = JSON.parse(readFileSync(join(stateDir, 'config.json'), 'utf8'));
      // 修复前：探针没有 config 服务 ⇒ setAndSave 是空操作 ⇒ 打印"已切换"但 activeScene 纹丝不动，
      // 下次 start 还是老场景（说了做了其实没做）。
      assertEquals(after.activeScene, 'base-system', `--yes 必须真的落盘 activeScene，实际 ${JSON.stringify(after)}`);
      assertEquals(after.probeKeep?.k, 1, `落盘不得冲掉配置里的其他键，实际 ${JSON.stringify(after)}`);
      console.log('       [实测] 提案列出 Remove/Add 且不改配置；--yes 落盘 activeScene 且保留其余键');
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  // R0-112/F3：OpenAI 兼容端点的错误体必须是**对象**形状。
  //
  // 修前实测：非流式路径一律返回 `{"error":"<字符串>"}`（如 `{"error":"missing messages"}`），
  // 客户端 SDK 读 `error.message` 拿到 undefined ⇒ 只能报一句无信息的失败；而**同一条链路的
  // 流式**错误早就是对象形状（`{"error":{"message","code"}}`）——两条路径形状不一致。
  runner.test('R0-112/Y1 OpenAI 兼容端点：错误体是 {"error":{"message",…}} 而非字符串', async () => {
    const g = await startGateway();
    try {
      const post = async (raw) => {
        const res = await fetch(`http://127.0.0.1:${g.port}/v1/chat/completions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw,
          signal: AbortSignal.timeout(15000),
        });
        return { status: res.status, text: await res.text() };
      };
      const check = (r, what) => {
        let body;
        try { body = JSON.parse(r.text); }
        catch { throw new Error(`${what}：正文不是 JSON：${JSON.stringify(r.text.slice(0, 200))}`); }
        assert(body && typeof body.error === 'object' && body.error !== null,
          `${what}：error 必须是对象（OpenAI 规范），实际 ${JSON.stringify(body).slice(0, 200)}`);
        assert(typeof body.error.message === 'string' && body.error.message.length > 0,
          `${what}：error.message 必须是非空字符串（SDK 就是读它），实际 ${JSON.stringify(body.error)}`);
        assert(typeof body.error.type === 'string',
          `${what}：error.type 必须存在（4xx=invalid_request_error / 5xx=api_error）`);
        return body;
      };

      const bad = await post('{oops');
      const b1 = check(bad, '非法 JSON');
      assertEquals(bad.status, 400, '非法 JSON 必须 400');
      assertEquals(b1.error.type, 'invalid_request_error', '4xx 的 type 必须是 invalid_request_error');

      const noMsg = await post(JSON.stringify({ messages: [] }));
      const b2 = check(noMsg, '缺 messages');
      assertEquals(noMsg.status, 400, '缺 messages 必须 400');
      assert(/messages/.test(b2.error.message), `正文要点名缺了什么：${JSON.stringify(b2.error.message)}`);
      console.log(`       [实测] 非法 JSON / 缺 messages 均返回对象形状（message="${b2.error.message}"）`);
    } finally {
      await g.stopEverything();
    }
  });
}
