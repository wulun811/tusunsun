// L4 网关压测：吞吐、并发上限、健壮性路径。
//
// 测的是**真的起一个网关进程**再打它，不在进程内 mock。理由：网关的性能问题几乎都出在
// 真实 HTTP 栈上（连接复用、背压、fd 泄漏），进程内 mock 恰好绕开了这些。
//
// 注意：loopback 上的数字是**上限**。真实部署要过网络，不能直接拿去承诺 SLA。
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Bench, parseArgs, selected, projectRoot, summarize } from './lib/bench.mjs';
import { runLoad, requestOnce, waitFor } from './lib/net.mjs';
import { connect } from 'node:net';
import { spawnManaged } from '../lib/proc.mjs';

const opts = parseArgs();
if (!selected(opts, 'L4')) process.exit(2);

const bench = new Bench('L4-gateway', {
  title: 'L4 网关：吞吐 / 并发 / 健壮性',
  notes: ['loopback 数字是上限值；真实网络要打折。'],
});

// ── 起网关 ─────────────────────────────────────────────────────
const stateDir = mkdtempSync(join(tmpdir(), 'tt-stress-l4-'));
// **前提显式化**：本套件测的是 HTTP 栈（吞吐/并发/413/fd/内存），不是模型凭证。
// 但 `/ready` 的合同是"有 chat 能力 + 有可用模型配置"，缺 key 时**按设计**返回 503。
// 旧版在这里干等 200，于是"前提没给"被记成"网关起不来"：L4-00 假红，而它掩盖的
// 恰好是真正要看的东西（真挂了与没给前提长得一样）。
// 现在：默认注入一个**非密钥**占位符让 readiness 合同被满足；要真跑模型用 --live。
const childEnv = { ...process.env };
if (!opts.live) childEnv.TUSUNSUN_API_KEY = 'local-test-nonsecret';   // 仅满足 /ready，不送往任何真实上游
const child = spawnManaged(process.execPath, [
  'tusunsun.mjs', 'start', '--scene', 'gateway-lite', '--port', '0', '--state-dir', stateDir,
], { cwd: projectRoot, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], label: 'stress:gateway' });

let buf = '';
child.stdout.on('data', (d) => { buf += d.toString(); });
child.stderr.on('data', (d) => { buf += d.toString(); });

const pid = child.pid;
const rssMB = () => {
  try {
    const m = readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+) kB/);
    return m ? Math.round(parseInt(m[1], 10) / 1024 * 10) / 10 : NaN;
  } catch { return NaN; }
};
const fdCount = () => {
  try { return readdirSync(`/proc/${pid}/fd`).length; } catch { return NaN; }
};

let port = null;
let base = null;
try {
  await waitFor('ready', () => /土行孙 ready \(\d+ plugins\)/.test(buf), { timeoutMs: 60000 });
  const rtPath = join(stateDir, 'gateway.runtime.json');
  await waitFor('运行期端口文件', () => existsSync(rtPath), { timeoutMs: 20000 });
  port = JSON.parse(readFileSync(rtPath, 'utf8')).port;
  base = `http://127.0.0.1:${port}`;
  await waitFor('/ready 200', async () => (await requestOnce(`${base}/ready`)).status === 200, { timeoutMs: 20000 });
} catch (e) {
  // **分清两种"没就绪"**：进程没起来（bind 失败/插件崩了）与 readiness 前提不满足
  // （缺 chat 能力或缺模型配置，按合同 503）。两者的处置完全不同 ——
  // 前者是发布阻断，后者是本套件的前提没准备好。混成一句话就已经丢掉了一半信息。
  let diag = '';
  try {
    const h = await requestOnce(`${base}/health`, { timeoutMs: 3000 });
    if (h.status === 200) {
      const r = await requestOnce(`${base}/ready`, { timeoutMs: 3000 });
      const body = (() => { try { return JSON.parse(r.body); } catch { return null; } })();
      diag = ` | /health=200（进程活着）但 /ready=${r.status}`
        + `${body?.missing ? `，missing=${JSON.stringify(body.missing)}` : ''}`
        + '；这是 readiness 前提问题（缺 chat 能力 / 模型配置），不是启动故障。'
        + '本套件默认注入非密钥占位符以满足该合同；若仍失败，说明合同本身变了。';
    }
  } catch { /* /health 都拿不到 = 真没起来，保留原始错误 */ }
  bench.fail('L4-00', '网关启动', `${e.message}${diag}；日志尾部：${buf.slice(-400).replace(/\x1b\[[0-9;]*m/g, '')}`);
  bench.finish();
}

async function shutdown() { await child.reap({ graceMs: 1500, killWaitMs: 2000 }); }

/** 裸 socket 发一个超大 body，只读状态行。返回数字状态码（-1 = 没拿到响应）。 */
function postOversized(portNo, path, bytes) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port: portNo });
    let out = '';
    let finished = false;
    const finish = (code) => { if (finished) return; finished = true; try { socket.destroy(); } catch { /* 已关 */ } resolve(code); };

    socket.setTimeout(30000, () => finish(-1));
    socket.on('error', () => finish(-1));            // 对端先关 = 预期路径之一
    socket.on('data', (d) => {
      out += d.toString();
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(out);
      if (m) finish(parseInt(m[1], 10));
    });
    socket.on('connect', () => {
      const head = `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${portNo}\r\n`
        + 'Content-Type: application/json\r\n'
        + `Content-Length: ${bytes}\r\n\r\n`;
      try { socket.write(head); } catch { finish(-1); return; }
      const chunk = Buffer.alloc(64 * 1024, 0x78);
      let sent = 0;
      const pump = () => {
        while (sent < bytes && !finished) {
          sent += chunk.length;
          let ok = true;
          try { ok = socket.write(chunk); } catch { finish(-1); return; }
          if (!ok) { socket.once('drain', pump); return; }   // 背压：等可写再续
        }
      };
      pump();
    });
  });
}
process.on('exit', () => { try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* best effort */ } });

try {
  // ── L4-01 吞吐与分位 ────────────────────────────────────────
  const levels = opts.quick ? [1, 32] : [1, 8, 32, 128];
  for (const c of levels) {
    const total = c >= 128 ? 2000 : 3000;
    const r = await runLoad({ url: `${base}/health`, concurrency: c, total });
    bench.record({ id: `L4-01-c${c}`, scene: `/health 并发 ${c}`, metric: '吞吐', value: r.rps, unit: 'req/s', kind: 'R' });
    bench.record({ id: `L4-01-c${c}-p`, scene: `/health 并发 ${c}`, metric: 'p95', value: r.p95, unit: 'ms', kind: 'R' });
    if (r.errorCount > 0) bench.fail(`L4-01-c${c}-err`, `/health 并发 ${c}`, `错误 ${r.errorCount}：${JSON.stringify(r.errors)}`);
  }

  // ── L4-02 并发连接突刺 ──────────────────────────────────────
  {
    const N = 500;
    const result = await Promise.allSettled(
      Array.from({ length: N }, () => requestOnce(`${base}/health`, { timeoutMs: 20000 })),
    );
    const ok = result.filter((r) => r.status === 'fulfilled' && r.value.status === 200).length;
    const alive = child.exitCode == null;
    bench.record({ id: 'L4-02', scene: `${N} 并发连接突刺`, metric: '成功率', value: (ok / N) * 100, unit: '%', kind: 'H', limit: 90, cmp: '>=' });
    bench.record({ id: 'L4-02b', scene: `${N} 并发连接突刺`, metric: '进程存活', value: alive ? 0 : 1, unit: 'count', kind: 'H', limit: 0, cmp: '==' });
  }

  // ── L4-03 长连接复用 + fd 泄漏 ─────────────────────────────
  {
    const fdBefore = fdCount();
    const r = await runLoad({ url: `${base}/health`, concurrency: 64, total: 4000 });
    const fdAfter = fdCount();
    bench.record({ id: 'L4-03', scene: '64 并发 × 4000 请求（keep-alive）', metric: '错误数', value: r.errorCount, unit: 'count', kind: 'H', limit: 0, cmp: '==', note: r.errorCount ? JSON.stringify(r.errors) : undefined });
    bench.record({ id: 'L4-03b', scene: '同上 · p99', metric: 'p99', value: r.p99, unit: 'ms', kind: 'R' });
    bench.record({ id: 'L4-03c', scene: '请求前后 fd 增量', metric: 'fd 泄漏', value: fdAfter - fdBefore, unit: 'count', kind: 'R' });
  }

  // ── L4-04 超大请求体 ────────────────────────────────────────
  // 用裸 socket 而不是 http.request：被测的是**服务端的 413 路径**，而 http.request 在
  // 服务端提前 destroy() 时会从内部把 ECONNRESET 抛成未捕获异常 —— 那会把压测进程带走，
  // 掩盖掉真正要看的东西。裸 socket 下"写到一半对端关了"是可控的、预期的。
  {
    const status = await postOversized(port, '/v1/chat/completions', 11 * 1024 * 1024);
    bench.record({ id: 'L4-04', scene: '11 MiB 请求体（上限 10 MiB）', metric: '是否回 413', value: status === 413 ? 0 : 1, unit: 'count', kind: 'H', limit: 0, cmp: '==', note: `实际 status=${status}` });
    // 413 之后进程必须还活着：`req.destroy()` 之后没有兜底的实现会在这里暴露
    const alive = child.exitCode == null && (await requestOnce(`${base}/health`, { timeoutMs: 5000 })).status === 200;
    bench.record({ id: 'L4-04b', scene: '413 之后仍可服务', metric: '健康检查通过', value: alive ? 0 : 1, unit: 'count', kind: 'H', limit: 0, cmp: '==' });
  }

  // ── L4-05 控制面同源守卫 ────────────────────────────────────
  {
    const r = await requestOnce(`${base}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example', host: `127.0.0.1:${port}` },
      body: '{}', timeoutMs: 10000,
    });
    bench.record({ id: 'L4-05', scene: '伪造 Origin 访问控制面', metric: '是否 403', value: r.status === 403 ? 0 : 1, unit: 'count', kind: 'H', limit: 0, cmp: '==', note: `实际 status=${r.status}` });
  }

  // ── L4-06 稳态内存漂移 ────────────────────────────────────
  {
    const seconds = opts.soak ? 300 : (opts.quick ? 0 : 30);
    if (!seconds) {
      bench.skip('L4-06', '稳态内存漂移', '--quick 跳过');
    } else {
      const warm = rssMB();
      const t0 = Date.now();
      let rounds = 0;
      while (Date.now() - t0 < seconds * 1000) {
        await runLoad({ url: `${base}/health`, concurrency: 8, total: 400 });
        rounds++;
      }
      const after = rssMB();
      const drift = warm > 0 ? ((after - warm) / warm) * 100 : NaN;
      bench.record({ id: 'L4-06', scene: `${seconds}s 稳态（${rounds} 轮 × 400 请求）`, metric: 'RSS 漂移', value: drift, unit: '%', kind: 'H', limit: 20, cmp: '<=', note: `${warm} MB → ${after} MB` });
    }
  }
} finally {
  await shutdown();
}

bench.finish();
