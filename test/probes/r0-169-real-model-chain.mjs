#!/usr/bin/env node
/**
 * test/probes/r0-169-real-model-chain.mjs
 *
 * 「真实模型链路」的端到端探针 —— 用的是**免费模型**，不是付费端点。
 *
 * ── 为什么要有这一条 ──────────────────────────────────────────────────
 * 门禁里这一项长期写着 `NOT_RUN`，理由是"本轮只用免费模型，未在付费端点实测"。
 * 这句话把两件事混成了一件：
 *
 *   · **开发代理跑在哪个模型上** —— 受"只用免费模型"约束，那是工具链环境；
 *   · **产品能不能接真实上游** —— 与前者无关，且用免费模型完全测得了。
 *
 * 实测：`.env` 里配的就是免费模型 `deepseek-v4.1-flash` + 真实端点，产品经网关打
 * 真实请求返回 200，上游 `usage.cost: 0`。所以"没在付费端点实测"从来不是这条链路的
 * 拦路石 —— 付费与否是**账号计费方式**，不是**代码路径**。
 *
 * 把它记成 NOT_RUN 的真实后果：没有任何一条门禁项在验证"真实上游接得上"。
 * 全部用 mock 上游时，"URL 拼错""鉴权头漏了""上游 400 被吞成成功"这类缺陷
 * 会一路绿灯到发布。
 *
 * ── 边界（诚实记录）──────────────────────────────────────────────────
 * · 只验证**一个**真实上游、**一个**模型、一次非流式往返。不做容量与延迟结论 ——
 *   免费档的延迟由厂商排队支配，把它当性能指标等于测别人家服务器忙不忙。
 * · 需要 `.env`（或环境变量）提供 `TUSUNSUN_BASE_URL` / `TUSUNSUN_API_KEY`。
 *   缺了就退出码 3（NOT_RUN），**绝不**降级成"跳过即通过"。
 * · 任何输出都不回显密钥，只打长度与主机名。
 *
 * 退出码：0 通过；1 违约；2 探针自身出错；3 前置缺失（一条都没执行）。
 */
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = [];
const ok = (name, detail) => out.push({ name, ok: true, detail });
const fail = (name, detail) => out.push({ name, ok: false, detail });

/** 读 `.env`（不覆盖已有环境变量，与 `tusunsun.mjs` 的语义一致）。 */
function loadConfig() {
  const cfg = { ...process.env };
  try {
    for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq <= 0) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if (v.length > 1 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1);
      if (cfg[k] === undefined) cfg[k] = v;
    }
  } catch { /* 没有 .env 是常态：靠环境变量 */ }
  return cfg;
}

const cfg = loadConfig();
const baseUrl = cfg.TUSUNSUN_BASE_URL || '';
const apiKey = cfg.TUSUNSUN_API_KEY || '';
const model = cfg.TUSUNSUN_MODEL || '';

const emit = (code) => {
  for (const c of out) console.log(JSON.stringify(c));
  process.exitCode = code;
};

// ── 前置缺失 ⇒ 退出码 3（NOT_RUN）。不折算通过，也不假装失败。 ─────────
if (!baseUrl || !apiKey) {
  console.log(JSON.stringify({
    name: 'precondition', ok: false, skipped: true,
    detail: '未配置 TUSUNSUN_BASE_URL / TUSUNSUN_API_KEY（.env 或环境变量）—— 一条都没执行',
  }));
  process.exit(3);
}

let host = null;
try { host = new URL(baseUrl).host; } catch { /* 下面判 */ }

let dir;
let child;
let exit = 2;
try {
  // ① 配置形状。
  if (host) ok('config-url-parsable', { host });
  else fail('config-url-parsable', { baseUrl: String(baseUrl).slice(0, 40) });
  if (apiKey.length >= 8) ok('config-key-present', { length: apiKey.length });
  else fail('config-key-present', { length: apiKey.length });
  if (model) ok('config-model-present', { model });
  else fail('config-model-present', { model });

  // ② 经**产品自己的网关**打真实上游（不是裸 fetch）。
  //    裸 fetch 只能证明"上游可达"，证明不了"土行孙拼的请求上游认"——
  //    鉴权头、body 形状、错误透传都在网关与内核里。
  dir = mkdtempSync(join(tmpdir(), 'probe-r0-169-'));
  const port = 39800 + Math.floor(Math.random() * 150);
  const env = {
    ...process.env,
    TUSUNSUN_STATE_DIR: join(dir, 'state'),
    TUSUNSUN_PORT: String(port),
    TUSUNSUN_BASE_URL: baseUrl,
    TUSUNSUN_API_KEY: apiKey,
    TUSUNSUN_MODEL: model,
    TUSUNSUN_GATEWAY_KEY: '',
    TUSUNSUN_ALLOW_REMOTE: '',
  };
  if (cfg.TUSUNSUN_MODEL_HEADERS) env.TUSUNSUN_MODEL_HEADERS = cfg.TUSUNSUN_MODEL_HEADERS;

  // 异步起网关：`start` 是常驻进程，用 spawnSync 会先把它堵死再 kill，
  // 之后再去探测端口注定失败（第一版就是这么写错的）。
  child = spawn(process.execPath, [join(ROOT, 'tusunsun.mjs'), 'start'], {
    cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let gwOut = '';
  child.stdout?.on('data', (c) => { gwOut += c.toString(); });
  child.stderr?.on('data', (c) => { gwOut += c.toString(); });

  const base = `http://127.0.0.1:${port}`;
  const waitReady = async (ms) => {
    const t0 = Date.now();
    for (;;) {
      try {
        const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
        if (r.ok) return true;
      } catch { /* 还没起来 */ }
      if (Date.now() - t0 > ms) return false;
      await new Promise((r) => setTimeout(r, 300));
    }
  };

  const up = await waitReady(45000);
  if (up) ok('gateway-up', { port });
  else fail('gateway-up', { port, tail: gwOut.slice(-400) });

  // ③ 一次真实往返。判据不是"200 就行"：**200 但回复为空**是真实存在的失败形态
  //    （上游改了响应形状），只看状态码会把它当成功。
  if (up) {
    let status = null;
    let reply = null;
    try {
      const r = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'origin': base },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'reply with the single word: ok' }],
          stream: false,
        }),
        signal: AbortSignal.timeout(120 * 1000),
      });
      status = r.status;
      const text = await r.text();
      try {
        const j = JSON.parse(text);
        reply = j.choices?.[0]?.message?.content ?? j.reply ?? null;
      } catch { reply = text.slice(0, 200); }
    } catch (e) {
      fail('chat-roundtrip', { error: e.name, message: String(e.message).slice(0, 200) });
    }
    if (status === 200 && typeof reply === 'string' && reply.trim().length > 0) {
      ok('chat-roundtrip', { status, replyChars: reply.trim().length, model });
    } else if (status !== null) {
      fail('chat-roundtrip', { status, reply: typeof reply === 'string' ? reply.slice(0, 160) : reply });
    }
  }

  // ④ 反向自检：坏凭据必须被上游拒绝。
  //    防的是"网关把上游 401 吞成 200 空回复"—— 那样上面的 ③ 就是假绿。
  try {
    const r = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer definitely-invalid-key-000' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ok' }], stream: false }),
      signal: AbortSignal.timeout(60 * 1000),
    });
    if (r.status !== 200) ok('bad-credential-rejected', { status: r.status });
    else fail('bad-credential-rejected', { status: r.status, note: '坏凭据返回 200 —— 鉴权没生效' });
  } catch (e) {
    ok('bad-credential-rejected', { error: e.name });
  }

  exit = out.every((c) => c.ok) ? 0 : 1;
} catch (e) {
  exit = 2;
  console.error('PROBE_ERROR', e?.stack || e);
} finally {
  try { child?.kill('SIGTERM'); } catch { /* 已退出 */ }
  await new Promise((r) => setTimeout(r, 500));
  try { child?.kill('SIGKILL'); } catch { /* 已退出 */ }
  emit(exit);
  if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 尽力而为 */ } }
}
