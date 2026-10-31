#!/usr/bin/env node
/**
 * P01 产品旅程探针：README 承诺的三件事，在**文档写的入口**上真的成立吗？
 *
 * 承诺与出处：
 *   ① 按场景组装（README「为什么做土行孙」/`scene show`）——
 *      文档说"启动装配清单用 `scene show` 查看"。那么它报的**启动即装**数，
 *      必须等于启动日志里 `土行孙 ready (N plugins)` 的 N；否则清单看的是另一套东西。
 *   ② 按需加载（同上 / scene-system.md「字段语义」）——
 *      写在 `plugins`（懒池）里的工具插件，应当在**第一次能力调用**时才装载。
 *   ③ 随工作调整（README「让每个会话在自己的目录里干活」）——
 *      会话声明目录后，工具落盘落在那里，`GET /api/sessions` 看得见。
 *
 * 判据全部走**外部可观测面**：CLI 文本、启动日志、HTTP 响应、磁盘。不读内核私有状态。
 * 模型上游是本地 mock（`/v1/chat/completions`），所以整条链路不需要网络与 key。
 *
 * 退出码：0 = 全部通过；1 = 有判据失败；2 = 探针自身异常。
 * 用法：node test/probes/p01-product-journey.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRY = join(ROOT, 'tusunsun.mjs');
const strip = (s) => s.replace(/\u001b\[[0-9;]*m/g, '');

const results = [];
function record(id, title, ok, detail) {
  results.push({ id, title, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} ${title}${detail ? ` — ${detail}` : ''}`);
}

/** 跑一条 CLI，带回退出码与输出（去 ANSI）。 */
function cli(args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [ENTRY, ...args], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...(opts.env || {}) },
    });
    let out = '';
    p.stdout.on('data', (b) => { out += b.toString(); });
    p.stderr.on('data', (b) => { out += b.toString(); });
    p.on('close', (code) => resolve({ code, out: strip(out) }));
  });
}

const waitFor = async (fn, ms, step = 50) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await new Promise((r) => setTimeout(r, step));
  }
};

/** 本地 mock 上游：第一轮点工具，第二轮收尾。 */
function startMockModel() {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      let msgs = [];
      try { msgs = JSON.parse(body).messages || []; } catch { /* 坏请求按空处理 */ }
      const msg = (m, finish) => ({ id: 'mock', object: 'chat.completion', model: 'mock',
        choices: [{ index: 0, message: m, finish_reason: finish }] });
      if (msgs[msgs.length - 1]?.role === 'tool') return send(msg({ role: 'assistant', content: 'DONE' }, 'stop'));
      const text = [...msgs].reverse().find((m) => m.role === 'user')?.content || '';
      const w = /WRITE:(\S+)/.exec(text);
      if (w) {
        return send(msg({ role: 'assistant', content: null, tool_calls: [{
          id: 'call-1', type: 'function',
          function: { name: 'tool-write', arguments: JSON.stringify({ path: `${w[1]}.txt`, content: 'from-probe' }) },
        }] }, 'tool_calls'));
      }
      return send(msg({ role: 'assistant', content: 'OK' }, 'stop'));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  // ── 判据 ①：三个命令说同一个数，且"启动即装"真的等于装配数 ────────────────
  const expanded = await cli(['scene', 'expand', 'gateway']);
  const mEager = /Eager \(启动即装, (\d+)\)/.exec(expanded.out);
  const mLazy = /Lazy \(首次能力调用才装, (\d+)\)/.exec(expanded.out);
  const mTotal = /合计声明 (\d+) = 启动即装 (\d+) \+ 按需 (\d+)/.exec(expanded.out);

  const inspected = await new Promise((resolve) => {
    const p = spawn(process.execPath, [join(ROOT, 'scripts/scene-inspect.mjs'), 'gateway', '--json'],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (b) => { out += b.toString(); });
    p.on('close', () => {
      try { resolve(JSON.parse(out).plugins.length); } catch { resolve(null); }
    });
  });

  const footered = await cli(['plugins']);
  const mFooter = /默认 gateway 场景声明 (\d+) 个：启动即装 (\d+) \+ 按需 (\d+)/.exec(footered.out);

  const eagerN = mEager ? Number(mEager[1]) : null;
  const lazyN = mLazy ? Number(mLazy[1]) : null;
  const totalN = mTotal ? Number(mTotal[1]) : null;
  record('J1-1', 'scene expand 报出 eager/lazy/合计三个数（不再只印 plugins 一栏）',
    eagerN != null && lazyN != null && totalN != null,
    `eager=${eagerN} lazy=${lazyN} total=${totalN}`);
  record('J1-2', '合计 = 启动即装 + 按需 = scene:inspect 的"声明 N"',
    totalN != null && totalN === eagerN + lazyN && totalN === inspected,
    `expand=${totalN} inspect=${inspected} eager+lazy=${eagerN + lazyN}`);
  record('J1-3', '`plugins` 尾注与 scene expand 同数（修前是 29 / 27 / 36 三个数）',
    mFooter != null && Number(mFooter[1]) === totalN && Number(mFooter[2]) === eagerN,
    `plugins=${mFooter ? mFooter[1] : 'n/a'} expand=${totalN}`);
  // 修前这两个名字根本不在清单里：config 是配置服务，gateway 是 HTTP 服务本身。
  const eagerLine = expanded.out.split('\n').find((l) => l.includes('Eager')) || '';
  record('J1-4', '清单里看得见 config 与 gateway（只写在 eager 的那两个）',
    /\bconfig\b/.test(eagerLine) && /\bgateway\b/.test(eagerLine),
    eagerLine.slice(0, 96));

  // ── 判据 ②③：真起一个网关，接 mock 模型，走 README 里那条 curl ──────────────
  const base = mkdtempSync(join(tmpdir(), 'p01-journey-'));
  const state = join(base, 'state');
  const repoA = join(base, 'repo-a');
  const repoB = join(base, 'repo-b');
  mkdirSync(state, { recursive: true });
  mkdirSync(repoA, { recursive: true });
  mkdirSync(repoB, { recursive: true });

  const mock = await startMockModel();
  writeFileSync(join(state, 'config.json'), JSON.stringify({
    activeScene: 'gateway',
    gateway: { host: '127.0.0.1', port: 0 },
    model: { model: 'mock', baseUrl: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'mock-key' },
    agent: { workDir: repoA },
  }, null, 2));

  const gw = spawn(process.execPath, [ENTRY, 'start', '--port', '0', '--state-dir', state, '--yes'], {
    // **净室化**：cwd 选在临时目录（不读仓里的 `.env`），再用环境变量把模型钉在 mock 上。
    // 少了这一步，探针会拿开发机 `.env` 里的真模型/真 key 去联网（实测：拿到 502 与
    // "missing x-opencode-session"，因为那些 header 在另一份配置里）。
    cwd: base,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      TUSUNSUN_BASE_URL: `http://127.0.0.1:${mock.port}/v1`,
      TUSUNSUN_MODEL: 'mock',
      TUSUNSUN_API_KEY: 'mock-key',
      TUSUNSUN_MODEL_HEADERS: '{}',
      TUSUNSUN_STATE_DIR: state,
    },
  });
  let log = '';
  gw.stdout.on('data', (b) => { log += b.toString(); });
  gw.stderr.on('data', (b) => { log += b.toString(); });
  const logText = () => strip(log);

  try {
    const runtimePath = join(state, 'gateway.runtime.json');
    const port = await waitFor(() => {
      if (!existsSync(runtimePath)) return null;
      try { return JSON.parse(readFileSync(runtimePath, 'utf8')).port || null; } catch { return null; }
    }, 20000);
    if (!port) throw new Error(`网关没起来（20s 内没有 ${runtimePath}）\n${logText().slice(-1200)}`);

    await waitFor(() => /土行孙 ready \(\d+ plugins\)/.test(logText()), 10000);
    const mReady = /土行孙 ready \((\d+) plugins\)/.exec(logText());
    const readyN = mReady ? Number(mReady[1]) : null;
    record('J2-1', '启动日志的 ready 装配数 = scene expand 的"启动即装"数',
      readyN != null && readyN === eagerN, `ready=${readyN} eager=${eagerN}`);

    // 懒加载判据的前置状态：此刻 tool-write 还没被装载（它写在 plugins 懒池里）。
    const lazyHitsBefore = (logText().match(/Lazy loaded plugin: tool-write/g) || []).length;
    record('J2-2', '对话之前 tool-write 尚未装载（懒池语义的前置状态）',
      lazyHitsBefore === 0 && /Registered lazy plugin: tool-write\.js/.test(logText()),
      `lazyLoaded=${lazyHitsBefore} registered=${/Registered lazy plugin: tool-write\.js/.test(logText())}`);

    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tusunsun-Workspace': repoB },
      body: JSON.stringify({ session_id: 'p01', messages: [{ role: 'user', content: 'WRITE:note' }] }),
    });
    const body = await res.json().catch(() => ({}));
    const reply = body?.choices?.[0]?.message?.content;
    record('J3-1', '文档里那条 HTTP 对话真的返回了模型答复（含一次工具往返）',
      res.status === 200 && reply === 'DONE', `status=${res.status} reply=${JSON.stringify(reply)}`);

    const wrote = existsSync(join(repoB, 'note.txt')) ? readFileSync(join(repoB, 'note.txt'), 'utf8') : null;
    record('J3-2', '工具落盘落在**会话声明的目录**，不在进程默认根',
      wrote === 'from-probe' && !existsSync(join(repoA, 'note.txt')),
      `repo-b/note.txt=${JSON.stringify(wrote)} repo-a=${existsSync(join(repoA, 'note.txt'))}`);

    const lazyHitsAfter = (logText().match(/Lazy loaded plugin: tool-write/g) || []).length;
    record('J3-3', '按需加载真的发生在第一次能力调用（懒加载日志恰一次）',
      lazyHitsAfter === 1,
      `lazyLoaded=${lazyHitsAfter}（ready 在日志第 ${logText().split('\n').findIndex((l) => /土行孙 ready/.test(l))} 行）`);

    const sess = await (await fetch(`http://127.0.0.1:${port}/api/sessions`)).json().catch(() => ({}));
    const row = (sess.sessions || []).find((s) => s.sessionId === 'p01');
    record('J3-4', 'GET /api/sessions 报告"哪个会话在哪个目录"',
      !!row && realpathSync(row.workspace) === realpathSync(repoB),
      row ? `${row.sessionId} → ${row.workspace}（${row.state}）` : '未找到 p01');
  } finally {
    gw.kill('SIGTERM');
    await new Promise((r) => { gw.on('close', r); setTimeout(r, 8000); });
    try { gw.kill('SIGKILL'); } catch { /* 已退出 */ }
    mock.server.close();
    rmSync(base, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (err) {
  console.error(`[probe-error] ${err?.stack || err}`);
  process.exitCode = 2;
}

if (process.exitCode !== 2) {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (process.argv.includes('--json')) console.log(JSON.stringify({ results }, null, 2));
  process.exitCode = failed.length ? 1 : 0;
}
