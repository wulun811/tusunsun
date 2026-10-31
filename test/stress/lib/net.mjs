// 本地负载生成与 HTTP 小工具。
//
// 只依赖 node:http(s)，不引第三方压测库：压测工具的依赖本身会污染被测进程的 CPU/内存画像，
// 而这个仓库的规矩是 vendor 里只放必要件（见 scripts/verify-vendor.mjs）。
import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';

function libFor(u) { return u.protocol === 'https:' ? https : http; }

/**
 * 发一次请求并读干响应体。resolve { status, body, headers }。
 *
 * 抗噪是本函数的职责：大请求体 + 服务端主动 `destroy()`（413 路径就是这样）会让 socket
 * 在写出过程中被重置，Node 既可能在 request 上 emmit 'error'，也可能直接抛在写回调里。
 * 抽测里这些都必须落成"一次失败的请求"，而不是整个压测进程的未捕获异常。
 */
export function requestOnce(url, { method = 'GET', body = null, headers = {}, agent = null, timeoutMs = 15000 } = {}) {
  const u = new URL(url);
  const lib = libFor(u);
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      try { req.destroy(); } catch { /* 已销毁 */ }
      reject(e);
    };
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    const req = lib.request(u, { method, headers, agent }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => done({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
      res.on('error', fail);
      res.on('aborted', () => fail(new Error('response aborted')));
    });

    req.setTimeout(timeoutMs, () => fail(new Error(`request timeout ${timeoutMs}ms`)));
    req.on('error', fail);

    if (body != null) {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
      const CHUNK = 64 * 1024;
      for (let i = 0; i < buf.length; i += CHUNK) {
        try {
          req.write(buf.subarray(i, i + CHUNK), (err) => { if (err) fail(err); });
        } catch (e) { fail(e); return; }
      }
    }
    try { req.end(); } catch (e) { fail(e); }
  });
}

/** 轮询直到 predicate 为真；超时抛错。用于等 /ready。 */
export async function waitFor(label, fn, { timeoutMs = 30000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { lastErr = e; }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`等待 ${label} 超时（${timeoutMs}ms）${lastErr ? `：${lastErr.message}` : ''}`);
}

/**
 * 固定并发、固定总请求数的闭环压测。
 *
 * 为什么是"闭环"而不是"固定速率开环"：开环要精确的定时器，Node 单线程里定时器本身抖动
 * 就在毫秒级，会盖住我们要测的微秒级差异。闭环模式下并发数就是可控变量，结果可比。
 */
export async function runLoad({
  url, concurrency = 32, total = 2000, method = 'GET', body = null,
  headers = {}, timeoutMs = 15000, keepAlive = true,
} = {}) {
  const u = new URL(url);
  const lib = libFor(u);
  const agent = new lib.Agent({ keepAlive, maxSockets: concurrency });
  const latencies = [];
  const statuses = Object.create(null);
  const errors = Object.create(null);
  let issued = 0;

  async function worker() {
    while (true) {
      const i = issued++;
      if (i >= total) return;
      const t = performance.now();
      try {
        const res = await requestOnce(url, { method, body, headers, agent, timeoutMs });
        latencies.push(performance.now() - t);
        statuses[res.status] = (statuses[res.status] || 0) + 1;
      } catch (e) {
        latencies.push(performance.now() - t);
        const k = e.code || e.message;
        errors[k] = (errors[k] || 0) + 1;
      }
    }
  }

  const t0 = performance.now();
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const durationMs = performance.now() - t0;
  agent.destroy();

  const sorted = [...latencies].sort((a, b) => a - b);
  const pct = (p) => {
    if (!sorted.length) return NaN;
    const idx = Math.min(Math.max(Math.ceil((p / 100) * sorted.length) - 1, 0), sorted.length - 1);
    return sorted[idx];
  };
  const errCount = Object.values(errors).reduce((a, b) => a + b, 0);

  return {
    total, concurrency, durationMs,
    rps: (total - errCount) / (durationMs / 1000),
    p50: pct(50), p95: pct(95), p99: pct(99), max: sorted[sorted.length - 1] || NaN,
    statuses, errors, errorCount: errCount,
    ok: errCount === 0,
  };
}

/** 当前进程打开的 fd 数（Linux）；取不到返回 NaN。 */
export async function openFdCount() {
  try {
    const { readdir } = await import('node:fs/promises');
    return (await readdir('/proc/self/fd')).length;
  } catch { return NaN; }
}
