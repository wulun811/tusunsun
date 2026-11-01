#!/usr/bin/env node
// 系统级基准（stage 1/2/4）：量的是「装配一个能接活的运行时」要付多少代价，
// 不是内核内部的微秒级派发（那是 verification/perf/bench.mjs 的事）。
//
// 为什么需要这个文件：README 与插图里长期挂着「启动 8.2s / 0.9s」「常驻 70% / 12%」
// 「并行 1× / 8×」这类数字，而仓里没有任何脚本能产出它们 —— 没有脚本的数字就是编的。
// 这个文件把其中三组变成可复跑的实测：
//
//   stage3-context  上下文税：把模型端点指向本地 recorder，抓「第一回合真正发出去的请求体」，
//                   数 system prompt、工具 schema、总字节 —— 全程不碰真模型
//
//   stage1-startup  进程 spawn → HTTP 就绪端点返回 200（外部口径，不采信任何一方自报）
//   stage2-rss      就绪后 1.2s 的常驻内存（VmRSS）
//   stage4-density  同时拉起 N 个实例：总内存、逐个就绪时间、失败数
//
// 刻意不做的：
//   · 不调模型、不用 key、不联网。所以它可以在任何机器上离线复跑。
//   · 不比「智能」，只比「装配与常驻的税」。opencode 那侧带 TUI/LSP/MCP/会话库，
//     土行孙这侧只有场景声明的插件 —— 能力面不同，报告里必须写明，不许当成同量级对打。
//   · 不报「快 N 倍」当结论，只报两列实测值和地板（`node -e ""`），让读者自己减。
//
// 每跑完一个 stage 立刻落盘一份 JSON（默认 verification/perf/results/<时间戳>/）。
// 中途崩了也不丢已完成的阶段 —— 数据比结论先落地。
//
// 用法：
//   node verification/perf/system-bench.mjs                    # 三个 stage 全跑
//   node verification/perf/system-bench.mjs --only=startup     # 只跑一个
//   node verification/perf/system-bench.mjs --n=30             # 改每组的样本数
//   node verification/perf/system-bench.mjs --no-opencode      # 只量土行孙
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { cpus, tmpdir, totalmem, release as osRelease, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const RESULTS = join(HERE, 'results');

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const ONLY = String(flag('only', 'startup,rss,density,context')).split(',').map((s) => s.trim()).filter(Boolean);
const N = Number(flag('n', '30'));
const WITH_OPENCODE = !argv.includes('--no-opencode');
// 真实模型只允许一个：用户 2026-10-31 的授权是「可以走 zen 的 go 端点，但只能 deepseek-v4.1-flash」。
const ALLOW_LLM = argv.includes('--allow-llm');
const ALLOWED_MODEL = 'deepseek-v4.1-flash';

if (!Number.isInteger(N) || N < 1) {
  console.error(`[system-bench] --n 必须是正整数（收到 ${flag('n', '30')}）`);
  process.exit(2);
}

const nowMs = () => Number(process.hrtime.bigint()) / 1e6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null;
};
const round = (v, d = 1) => (v == null ? null : +Number(v).toFixed(d));
const summarize = (name, unit, arr) => ({
  name, unit, n: arr.length,
  p50: round(pct(arr, 0.5)), p95: round(pct(arr, 0.95)),
  min: round(Math.min(...arr)), max: round(Math.max(...arr)),
});

/** 常驻内存（kB → MB）。读不到就返回 null，绝不猜一个数出来。 */
function rssMb(pid) {
  try {
    const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
    return m ? +(Number(m[1]) / 1024).toFixed(1) : null;
  } catch {
    return null;
  }
}

const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = join(RESULTS, STAMP);

function writeStage(stage, payload) {
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, `${stage}.json`);
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`       [落盘] ${file.replace(`${ROOT}/`, '')}`);
  return file;
}

function gitHead() {
  try {
    const r = spawn('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    r.stdout.on('data', (d) => { out += d; });
    return new Promise((res) => r.on('close', () => res(out.trim() || null)));
  } catch { return Promise.resolve(null); }
}

async function toolVersion(cmd, args = ['--version']) {
  return new Promise((res) => {
    try {
      const c = spawn(cmd, args, { cwd: tmpdir(), stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      c.stdout.on('data', (d) => { out += d; });
      c.on('error', () => res(null));
      c.on('close', () => res(out.trim().split('\n')[0] || null));
    } catch { res(null); }
  });
}

/** spawn 到「HTTP 端口应答」的墙钟毫秒；顺带返回就绪后 RSS。超时抛错，不返回假数。 */
async function toServe({ cmd, args, cwd, portRe, path = '/', timeoutMs = 60000, settleMs = 1200 }) {
  const t0 = nowMs();
  const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const onData = (d) => { out += d.toString(); };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const exited = new Promise((res) => child.on('close', (code) => res(code)));

  try {
    let port = null;
    while (nowMs() - t0 < timeoutMs) {
      if (!port) {
        const m = portRe.exec(out);
        if (m) port = Number(m[1]);
      }
      if (port) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(500) });
          if (res.status < 500) {
            const ms = nowMs() - t0;
            await sleep(settleMs);
            return { ms: +ms.toFixed(1), rss_mb: rssMb(child.pid), port };
          }
        } catch { /* 端口还没起来 */ }
      }
      if (child.exitCode !== null) {
        throw new Error(`进程提前退出（code=${child.exitCode}）：${out.slice(-300)}`);
      }
      await sleep(10);
    }
    throw new Error(`等待就绪超时（${timeoutMs}ms）：${out.slice(-300)}`);
  } finally {
    child.kill('SIGKILL');
    await Promise.race([exited, sleep(1500)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

/** 一次性命令的墙钟（含进程创建与退出），用来量地板。 */
function runOnce(cmd, args, cwd) {
  return new Promise((res, rej) => {
    const t0 = nowMs();
    const c = spawn(cmd, args, { cwd, stdio: 'ignore' });
    c.on('error', rej);
    c.on('close', (code) => res({ ms: +(nowMs() - t0).toFixed(1), code }));
  });
}

const SIDECAR = () => ['tusunsun.mjs', 'start', '--port', '0', '--scene', 'gateway'];

/** stage 1 + stage 2：就绪时间与常驻内存。两者出自同一次运行，所以只起停一次进程。 */
async function stageStartupAndRss(meta) {
  const runs = { floor_node: [], tusunsun_cli: [], tusunsun_gateway: [], opencode_cli: [], opencode_serve: [] };

  for (let i = 0; i < N; i++) {
    runs.floor_node.push((await runOnce(process.execPath, ['-e', ''], ROOT)).ms);
    process.stdout.write(`\r       floor ${i + 1}/${N}`);
  }
  console.log();

  for (let i = 0; i < N; i++) {
    runs.tusunsun_cli.push((await runOnce(process.execPath, ['tusunsun.mjs', '--version'], ROOT)).ms);
    process.stdout.write(`\r       tusunsun --version ${i + 1}/${N}`);
  }
  console.log();

  for (let i = 0; i < N; i++) {
    const stateDir = mkdtempSync(join(tmpdir(), 'ts-bench-'));
    try {
      runs.tusunsun_gateway.push(await toServe({
        cmd: process.execPath, args: [...SIDECAR(), '--state-dir', stateDir], cwd: ROOT,
        portRe: /listening on [\d.]+:(\d+)/, path: '/ready',
      }));
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
    process.stdout.write(`\r       tusunsun gateway→ready ${i + 1}/${N}`);
  }
  console.log();

  if (WITH_OPENCODE) {
    for (let i = 0; i < N; i++) {
      runs.opencode_cli.push((await runOnce('opencode', ['--version'], tmpdir())).ms);
      process.stdout.write(`\r       opencode --version ${i + 1}/${N}`);
    }
    console.log();
    for (let i = 0; i < N; i++) {
      runs.opencode_serve.push(await toServe({
        cmd: 'opencode', args: ['serve', '--port', String(4200 + i), '--hostname', '127.0.0.1'], cwd: tmpdir(),
        portRe: /listening on http:\/\/[\d.]+:(\d+)/, path: '/', settleMs: 1500,
      }));
      process.stdout.write(`\r       opencode serve→ready ${i + 1}/${N}`);
    }
    console.log();
  }

  const startup = {
    schema: 'tusunsun.perf.system-bench/v1',
    stage: 'startup',
    meta,
    config: { n: N, with_opencode: WITH_OPENCODE, criterion: 'spawn → HTTP 就绪端点返回 <500 的墙钟毫秒' },
    samples: Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, v.map((x) => x.ms ?? x)])),
    summary: [
      summarize('地板：node -e ""', 'ms', runs.floor_node),
      summarize('tusunsun --version', 'ms', runs.tusunsun_cli),
      summarize('tusunsun gateway → /ready', 'ms', runs.tusunsun_gateway.map((r) => r.ms)),
      ...(WITH_OPENCODE ? [
        summarize('opencode --version', 'ms', runs.opencode_cli),
        summarize('opencode serve → /', 'ms', runs.opencode_serve.map((r) => r.ms)),
      ] : []),
    ],
  };

  const rss = {
    schema: 'tusunsun.perf.system-bench/v1',
    stage: 'rss',
    meta,
    config: { n: N, settle_ms: 1200, note: '就绪后 1.2s 取 VmRSS；opencode 侧 settle 1.5s' },
    samples: {
      tusunsun_gateway: runs.tusunsun_gateway.map((r) => r.rss_mb),
      ...(WITH_OPENCODE ? { opencode_serve: runs.opencode_serve.map((r) => r.rss_mb) } : {}),
    },
    summary: [
      summarize('tusunsun gateway', 'MB', runs.tusunsun_gateway.map((r) => r.rss_mb)),
      ...(WITH_OPENCODE ? [summarize('opencode serve', 'MB', runs.opencode_serve.map((r) => r.rss_mb))] : []),
    ],
  };

  return { startup, rss };
}

/** stage 4：同时拉起 N 个实例，看总内存与就绪时间怎么走。 */
async function stageDensity(meta) {
  const levels = [1, 4, 8, 16];
  const out = [];
  for (const n of levels) {
    const t0 = nowMs();
    const stateDirs = [];
    const procs = [];
    try {
      for (let i = 0; i < n; i++) {
        const stateDir = mkdtempSync(join(tmpdir(), 'ts-dense-'));
        stateDirs.push(stateDir);
        procs.push(toServe({
          cmd: process.execPath, args: [...SIDECAR(), '--state-dir', stateDir], cwd: ROOT,
          portRe: /listening on [\d.]+:(\d+)/, path: '/ready', settleMs: 800,
        }));
      }
      const settled = await Promise.allSettled(procs);
      const ok = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
      const totalRss = ok.reduce((a, r) => a + (r.rss_mb || 0), 0);
      out.push({
        instances: n,
        started_ok: ok.length,
        wall_ms: +(nowMs() - t0).toFixed(0),
        ready_ms_p50: ok.length ? round(pct(ok.map((r) => r.ms), 0.5)) : null,
        ready_ms_max: ok.length ? round(Math.max(...ok.map((r) => r.ms))) : null,
        total_rss_mb: +totalRss.toFixed(1),
        rss_per_instance_mb: ok.length ? +(totalRss / ok.length).toFixed(1) : null,
        failures: settled.length - ok.length,
      });
      console.log(`       N=${n}：起 ${ok.length}/${n}，总 ${totalRss.toFixed(0)} MB，p50 ${out.at(-1).ready_ms_p50} ms`);
    } finally {
      for (const s of stateDirs) rmSync(s, { recursive: true, force: true });
    }
  }
  return {
    schema: 'tusunsun.perf.system-bench/v1',
    stage: 'density',
    meta,
    config: { levels, scene: 'gateway', note: '同一台机器上同时拉起 N 个独立进程；不含模型推理' },
    rows: out,
    summary: out.map((r) => ({
      name: `N=${r.instances}`, unit: 'MB', n: r.started_ok,
      p50: r.rss_per_instance_mb, p95: r.total_rss_mb, min: r.ready_ms_p50, max: r.ready_ms_max,
    })),
  };
}

/* ── stage 3：上下文税 ──────────────────────────────────────────
 *
 * 手法：把模型端点指到本地 recorder，触发一回合，把**真正发出去的请求体**接住，
 * 数三件事：system prompt 字符数、工具 schema 字符数、整个请求体字符数。
 *
 * 为什么量这三个：它们是「每个回合都要付、且与模型与任务无关」的固定开销，
 * 也是「微内核 vs 一体化产品」唯一能公平对比的那一维。
 *
 * 前置断言（没有它这个 stage 一文不值）：recorder 必须真的收到请求；收不到就抛错，
 * 绝不把「没量到」写成「很小」。这条来自 verification/perf/README.md 的「三次读错」。
 */

/** 统一口径的 token 估算：CJK 1.5 字符/token，其余 4 字符/token（与 context-manager 同口径）。 */
function estTokens(s) {
  let cjk = 0;
  for (const ch of s) if (ch.codePointAt(0) > 0x2e7f) cjk += 1;
  return Math.round(cjk / 1.5 + (s.length - cjk) / 4);
}

/** 本地 recorder：把收到的请求体接着；响应给一个最小可用的 chat.completion。 */
async function withRecorder(fn) {
  const captured = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      captured.push({ url: req.url, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'rec', object: 'chat.completion', created: 0, model: 'rec',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/v1/chat/completions`;
  try {
    return await fn(url, captured);
  } finally {
    srv.close();
  }
}

/** 从请求体里抽出事实；解析不了就抛错，不猜。 */
function contextFacts(raw) {
  const j = JSON.parse(raw);
  const messages = Array.isArray(j.messages) ? j.messages : [];
  const system = messages
    .filter((m) => m.role === 'system' || m.role === 'developer')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
  const tools = Array.isArray(j.tools) ? j.tools : [];
  const toolJson = tools.length ? JSON.stringify(tools) : '';
  return {
    body_chars: raw.length,
    system_chars: system.length,
    tools_count: tools.length,
    tools_chars: toolJson.length,
    messages_count: messages.length,
    tool_names: tools.map((t) => t.function?.name || t.name || '?'),
    est_tokens_body: estTokens(raw),
    est_tokens_system: estTokens(system),
    est_tokens_tools: toolJson ? estTokens(toolJson) : 0,
  };
}

async function captureTusunsun(recUrl, captured) {
  const stateDir = mkdtempSync(join(tmpdir(), 'ts-ctx-'));
  const workDir = join(stateDir, 'workspace');
  mkdirSync(workDir, { recursive: true });
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
    activeScene: 'gateway',
    gateway: { host: '127.0.0.1', port: 0, token: null, apiKey: null, allowRemote: false },
    model: { provider: 'openai', model: 'rec-model', baseUrl: recUrl, apiKey: 'bench-dummy' },
    agent: { workDir },
    tools: {},
  }, null, 2));
  // 关键：环境变量优先级高于 config.json（tusunsun.mjs 会读 cwd 的 .env，config 插件再用
  // readEnv() 覆盖）。所以这里显式用 env 把端点钉在 recorder 上，而不是只改 config.json ——
  // 只改 config 的话，一次「本地抓包」会静默变成一次真实模型调用。
  const env = {
    ...process.env,
    TUSUNSUN_BASE_URL: recUrl, TUSUNSUN_API_KEY: 'bench-dummy',
    TUSUNSUN_MODEL: 'rec-model', TUSUNSUN_MODEL_HEADERS: '',
  };
  const gw = spawn(process.execPath, ['tusunsun.mjs', 'start', '--port', '0', '--scene', 'gateway', '--state-dir', stateDir],
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  gw.stdout.on('data', (d) => { out += d; });
  gw.stderr.on('data', (d) => { out += d; });
  const t0 = nowMs();
  let port = null;
  while (nowMs() - t0 < 30000) {
    const m = /listening on [\d.]+:(\d+)/.exec(out);
    if (m) { port = Number(m[1]); break; }
    await sleep(20);
  }
  if (!port) {
    gw.kill('SIGKILL');
    rmSync(stateDir, { recursive: true, force: true });
    throw new Error(`gateway 未就绪：${out.slice(-300)}`);
  }
  await sleep(300);

  const chat = spawn(process.execPath, ['tusunsun.mjs', 'chat', '--state-dir', stateDir],
    { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let chatOut = '';
  chat.stdout.on('data', (d) => { chatOut += d; });
  chat.stderr.on('data', (d) => { chatOut += d; });
  chat.stdin.write('你好，请回答一个字\n');
  try {
    const deadline = nowMs() + 30000;
    while (nowMs() < deadline && captured.length === 0) await sleep(50);
  } finally {
    chat.stdin.end();
    chat.kill('SIGKILL');
    gw.kill('SIGKILL');
    await sleep(200);
    rmSync(stateDir, { recursive: true, force: true });
  }
  if (captured.length === 0) throw new Error(`tusunsun 未发出请求：${chatOut.slice(-300)}`);
  return captured;
}

async function captureOpencode(recUrl, captured) {
  const home = mkdtempSync(join(tmpdir(), 'oc-ctx-'));
  const cfgDir = join(home, '.config', 'opencode');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'opencode.json'), JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    model: 'bench/rec-model',
    provider: {
      bench: {
        npm: '@ai-sdk/openai-compatible',
        name: 'bench',
        options: { baseURL: recUrl.replace(/\/v1\/chat\/completions$/, '/v1'), apiKey: 'bench-dummy' },
        models: { 'rec-model': { name: 'rec-model' } },
      },
    },
  }, null, 2));
  const child = spawn('opencode', ['run', '--model', 'bench/rec-model', '你好'], {
    cwd: tmpdir(), env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  try {
    // 等「带工具的主回合」而不是「第一个请求」：opencode 第一发往往是不带工具的辅助调用
    // （标题/摘要之类），拿它去和土行孙的主回合比是不对等的。
    const deadline = nowMs() + 45000;
    const hasTools = (c) => {
      try { return (JSON.parse(c.body).tools || []).length > 0; } catch { return false; }
    };
    while (nowMs() < deadline && !captured.some(hasTools)) await sleep(50);
  } finally {
    // opencode 对我们的最小响应会重试；抓到目标就立刻掐断，免得刷满磁盘（实测一次会发上千个）。
    child.kill('SIGKILL');
    await sleep(300);
    rmSync(home, { recursive: true, force: true });
  }
  if (captured.length === 0) throw new Error(`opencode 未发出请求：${out.slice(-300)}`);
  return captured;
}

async function stageContext(meta) {
  const rows = [];
  const scenarios = [
    { id: 'tusunsun:gateway', run: captureTusunsun },
    ...(WITH_OPENCODE ? [{ id: 'opencode:run', run: captureOpencode }] : []),
  ];
  for (const s of scenarios) {
    try {
      const caps = await withRecorder((url, captured) => s.run(url, captured));
      // 一个用户回合可能拆成多个请求（辅助调用 + 主回合）。取最大那份作为「主回合」，
      // 并把一共看到几个请求写进结果 —— 选哪份、看没看全，读者能自己复核。
      const cap = caps.reduce((a, b) => (a.body.length >= b.body.length ? a : b));
      const f = contextFacts(cap.body);
      rows.push({ id: s.id, ok: true, requests_seen: caps.length, ...f });
      console.log(`       ${s.id}: 主回合 system ${f.system_chars} 字符 / 工具 ${f.tools_count} 个 ${f.tools_chars} 字符 / 合计 ${f.body_chars} 字符 ≈ ${f.est_tokens_body} tokens（共看到 ${caps.length} 个请求）`);
    } catch (e) {
      rows.push({ id: s.id, ok: false, error: String(e.message || e).slice(0, 400) });
      console.log(`       ${s.id}: NOT_MAPPED —— ${String(e.message || e).slice(0, 160)}`);
    }
  }
  return {
    schema: 'tusunsun.perf.system-bench/v1',
    stage: 'context',
    meta,
    config: {
      method: '模型端点指向本地 recorder，抓第一回合真实请求体；不调模型、不联网',
      est_tokens_rule: '统一口径：CJK 1.5 字符/token，其余 4 字符/token（与 context-manager 同）',
      caveat: '两边工具集不同（土行孙 10 个文件类工具；opencode 含 task/skill/webfetch 等），比的是装配税不是能力',
    },
    rows,
  };
}

/* ── stage 5：用真实模型校准 token 估算（默认关闭，需 --allow-llm）───────────
 *
 * stage 3 报的 token 是**估算**（CJK 1.5 字符/token、其余 4 字符/token）。估得准不准，
 * 不能自己说了算。这一层把 stage 3 抓到的**原请求体**原样重放给真模型一次，读响应的
 * `usage.prompt_tokens`，与估算值对比 —— 只花一次输入，不跑对话。
 *
 * 硬门：模型必须是 ALLOWED_MODEL（用户授权写死在代码里）；key 只从环境变量读，绝不进报告。
 * 报告里只写 token 数与比值，不写 key、不写 header。
 */
async function stageCalibrate(meta) {
  // .env 自己读，不用 shell `source`：shell 会把 `{"k":"v"}` 里的双引号当引号剥掉，
  // 于是 TUSUNSUN_MODEL_HEADERS 变成非法 JSON（实测踩过）。这里只做「取等号右边原文」。
  const dotenv = (() => {
    const p = join(ROOT, '.env');
    if (!existsSync(p)) return {};
    const out = {};
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      out[m[1]] = v;
    }
    return out;
  })();
  const envVal = (k) => process.env[k] || dotenv[k] || '';
  const base = envVal('TUSUNSUN_BASE_URL');
  const key = envVal('TUSUNSUN_API_KEY');
  const model = envVal('TUSUNSUN_MODEL') || ALLOWED_MODEL;
  if (!base || !key) throw new Error('需要 TUSUNSUN_BASE_URL + TUSUNSUN_API_KEY（放 .env，不进库）');
  if (model !== ALLOWED_MODEL) throw new Error(`只允许 ${ALLOWED_MODEL}，当前 TUSUNSUN_MODEL=${model}`);

  // 端点要求与网关一致的自定义头（本机的 zen 端点要 x-opencode-session）。
  // 与 plugins/model-openai.js 同源；只读不打印值。
  let extraHeaders = {};
  const rawHeaders = envVal('TUSUNSUN_MODEL_HEADERS');
  if (rawHeaders) {
    try { extraHeaders = JSON.parse(rawHeaders); } catch { throw new Error('TUSUNSUN_MODEL_HEADERS 不是合法 JSON'); }
  }
  const headerNames = Object.keys(extraHeaders).join(',');
  if (headerNames) console.log(`       [模型] 额外头：${headerNames}（值不落盘）`);

  const rows = [];
  const scenarios = [
    { id: 'tusunsun:gateway', run: captureTusunsun },
    ...(WITH_OPENCODE ? [{ id: 'opencode:run', run: captureOpencode }] : []),
  ];
  for (const s of scenarios) {
    const caps = await withRecorder((url, captured) => s.run(url, captured));
    const cap = caps.reduce((a, b) => (a.body.length >= b.body.length ? a : b));
    const body = JSON.parse(cap.body);
    // 只改两处不影响 prompt 的字段：模型名校正、关流式（方便直接读 usage）。
    body.model = model;
    body.stream = false;
    delete body.stream_options;
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...extraHeaders },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${s.id} 调真模型失败 HTTP ${res.status}：${text.slice(0, 300)}`);
    const j = JSON.parse(text);
    const real = j.usage?.prompt_tokens ?? null;
    const est = estTokens(JSON.stringify({ messages: body.messages, tools: body.tools }));
    rows.push({
      id: s.id, model: j.model || model,
      est_tokens: est, real_prompt_tokens: real,
      ratio: real ? +(est / real).toFixed(2) : null,
      chars: JSON.stringify({ messages: body.messages, tools: body.tools }).length,
    });
    const r = rows.at(-1);
    console.log(`       ${s.id}: 估算 ${r.est_tokens} / 真实 ${r.real_prompt_tokens} prompt_tokens（估算/真实 = ${r.ratio}）`);
  }
  return {
    schema: 'tusunsun.perf.system-bench/v1',
    stage: 'calibrate',
    meta,
    config: { model, allowed_model: ALLOWED_MODEL, method: '把 stage3 的原请求体重放给真模型一次，读 usage.prompt_tokens', cost: '每侧一次输入，不跑对话' },
    rows,
  };
}

async function main() {
  const meta = {
    stamp: STAMP,
    git_head: await gitHead(),
    node: process.version,
    platform: `${platform()} ${osRelease()}`,
    cpu: cpus()[0]?.model ?? null,
    cpu_count: cpus().length,
    total_mem_gb: +(totalmem() / 1024 ** 3).toFixed(1),
    opencode: WITH_OPENCODE ? await toolVersion('opencode') : null,
    truthfulness: '本文件只报本机实测；换机器/换版本必须重跑，不得引用别处的绝对值',
  };
  console.log(`[system-bench] N=${N}，stage=${ONLY.join(',')}，落盘目录 ${OUT.replace(`${ROOT}/`, '')}`);
  if (meta.opencode === null && WITH_OPENCODE) console.log('[system-bench][注意] 找不到 opencode，那一列会缺');

  if (ONLY.includes('startup') || ONLY.includes('rss')) {
    const { startup, rss } = await stageStartupAndRss(meta);
    if (ONLY.includes('startup')) writeStage('startup', startup);
    if (ONLY.includes('rss')) writeStage('rss', rss);
    for (const s of [startup.summary, rss.summary].flat()) {
      console.log(`  ${String(s.name).padEnd(34)} p50 ${String(s.p50).padStart(8)} ${s.unit}  p95 ${String(s.p95).padStart(8)}  n=${s.n}`);
    }
  }

  if (ONLY.includes('density')) {
    const density = await stageDensity(meta);
    writeStage('density', density);
  }

  if (ONLY.includes('context')) {
    const context = await stageContext(meta);
    writeStage('context', context);
  }

  if (ONLY.includes('calibrate')) {
    if (!ALLOW_LLM) {
      console.log('[system-bench] calibrate 需要 --allow-llm（会真的调一次模型）；已跳过');
    } else {
      const cal = await stageCalibrate(meta);
      writeStage('calibrate', cal);
    }
  }

  console.log(`[system-bench] 完成：${OUT}`);
}

await main();
