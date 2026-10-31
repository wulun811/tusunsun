// L5 端到端：一次完整的"请求 → 内核 → 上游模型 → 回包"要多久。
//
// 关键设计：默认用**本地 mock 上游**，不是真模型。原因不是偷懒，是可归因 ——
// 免费档的延迟由网络和排队决定，把那个数字贴出来只能证明"别人家服务器忙"。
// mock 上游的可控延迟让我们能把总耗时拆成三段：
//
//     总耗时 = 上游延迟（我们设的） + 内核开销（要测的） + HTTP 往返（单独测）
//
// `--live` 才打真实免费模型，且必须同时给出"直连上游"的对照，否则无法归因。
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Bench, parseArgs, selected, projectRoot, summarize } from './lib/bench.mjs';
import { requestOnce, waitFor } from './lib/net.mjs';
import { spawnManaged } from '../lib/proc.mjs';

const opts = parseArgs();
if (!selected(opts, 'L5')) process.exit(2);

const bench = new Bench('L5-e2e', {
  title: 'L5 端到端：内核开销的可归因测量',
  notes: [
    '默认打本地 mock 上游（可控延迟），因此「内核开销」= 总耗时 − 上游延迟，是可归因的。',
    '--live 才打真实免费模型；它的绝对值受网络与厂商排队支配，只作趋势参考，不作容量依据。',
  ],
});

const CHAT = { model: 'x', messages: [{ role: 'user', content: '你好' }], stream: false };

function mockUpstream(delayMs) {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-bench',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'bench-mock',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
      }, delayMs);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function startGateway(env) {
  const stateDir = mkdtempSync(join(tmpdir(), 'tt-stress-l5-'));
  const child = spawnManaged(process.execPath, [
    'tusunsun.mjs', 'start', '--scene', 'gateway-lite', '--port', '0', '--state-dir', stateDir,
  ], { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env }, label: 'stress:e2e' });

  let buf = '';
  child.stdout.on('data', (d) => { buf += d.toString(); });
  child.stderr.on('data', (d) => { buf += d.toString(); });

  await waitFor('ready', () => /土行孙 ready \(\d+ plugins\)/.test(buf), { timeoutMs: 60000 });
  const rtPath = join(stateDir, 'gateway.runtime.json');
  await waitFor('运行期端口文件', () => existsSync(rtPath), { timeoutMs: 20000 });
  const port = JSON.parse(readFileSync(rtPath, 'utf8')).port;
  const base = `http://127.0.0.1:${port}`;
  await waitFor('/ready', async () => (await requestOnce(`${base}/ready`)).status === 200, { timeoutMs: 20000 });
  return { child, base, stateDir, buf: () => buf };
}

async function chatOnce(base) {
  const t0 = Number(process.hrtime.bigint());
  const r = await requestOnce(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(CHAT), timeoutMs: 120000,
  });
  return { ms: (Number(process.hrtime.bigint()) - t0) / 1e6, status: r.status, body: r.body };
}

// ── 受控模式：本地 mock 上游 ──────────────────────────────────
if (!opts.live) {
  const DELAYS = [0, 50, 200];
  const measured = new Map();

  for (const delay of DELAYS) {
    const server = await mockUpstream(delay);
    const mockPort = server.address().port;
    const mockUrl = `http://127.0.0.1:${mockPort}/v1/chat/completions`;
    const gw = await startGateway({
      TUSUNSUN_BASE_URL: mockUrl,
      TUSUNSUN_API_KEY: 'bench-key',
      TUSUNSUN_MODEL: 'bench-mock',
    });

    try {
      // 直连上游的对照：同样带上 mock 的延迟，所以 e2e − direct 剩下的才是内核自己的开销
      const directSamples = [];
      for (let i = 0; i < 5; i++) {
        const t0 = Number(process.hrtime.bigint());
        await requestOnce(mockUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(CHAT) });
        directSamples.push((Number(process.hrtime.bigint()) - t0) / 1e6);
      }

      await chatOnce(gw.base);                        // 预热：首轮要付模块懒加载/连接建立
      const samples = [];
      for (let i = 0; i < 7; i++) {
        const r = await chatOnce(gw.base);
        if (r.status !== 200) {
          bench.fail(`L5-${delay}`, `mock 上游 delay=${delay}ms`, `网关返回 ${r.status}：${r.body.slice(0, 200)}`);
          break;
        }
        samples.push(r.ms);
      }
      if (!samples.length) continue;

      const st = summarize(samples);
      const ds = summarize(directSamples);
      measured.set(delay, { e2e: st.p50, direct: ds.p50 });
      bench.record({
        id: `L5-01-d${delay}`, scene: `mock 上游 delay=${delay}ms`,
        metric: 'e2e p50', value: st.p50, unit: 'ms', kind: 'R',
      });
      bench.record({
        id: `L5-01-d${delay}-ov`, scene: `mock 上游 delay=${delay}ms`,
        metric: '内核开销（e2e − 直连）', value: Math.max(0, st.p50 - ds.p50), unit: 'ms', kind: 'R',
        note: `直连同上游 p50=${ds.p50.toFixed(2)}ms`,
      });
    } finally {
      await gw.child.reap({ graceMs: 1500, killWaitMs: 2000 });
      server.close();
      try { rmSync(gw.stateDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  // 延迟可加性：设 200ms 与设 0ms 的差应接近 200ms。差得远 ⇒ 内核里有与上游延迟耦合的东西
  if (measured.has(0) && measured.has(200)) {
    const delta = measured.get(200).e2e - measured.get(0).e2e;
    const deviation = Math.abs(delta - 200);
    bench.record({
      id: 'L5-02', scene: '上游延迟可加性（200ms − 0ms）', metric: '偏离理论值', value: deviation, unit: 'ms', kind: 'H',
      limit: 60, cmp: '<=', note: `实测差 ${delta.toFixed(1)}ms，理论 200ms`,
    });
  }

  // ── 3 并发会话 ────────────────────────────────────────────
  {
    const server = await mockUpstream(20);
    const gw = await startGateway({
      TUSUNSUN_BASE_URL: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
      TUSUNSUN_API_KEY: 'bench-key',
      TUSUNSUN_MODEL: 'bench-mock',
    });
    try {
      await chatOnce(gw.base);
      const rs = await Promise.allSettled([
        chatOnce(gw.base), chatOnce(gw.base), chatOnce(gw.base),
      ]);
      const ok = rs.filter((r) => r.status === 'fulfilled' && r.value.status === 200).length;
      bench.record({ id: 'L5-03', scene: '3 并发会话（免费档不压更高）', metric: '成功数', value: ok, unit: 'count', kind: 'H', limit: 3, cmp: '==' });
    } finally {
      await gw.child.reap({ graceMs: 1500, killWaitMs: 2000 });
      server.close();
      try { rmSync(gw.stateDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  bench.finish();
}

// ── 真实免费模型模式 ──────────────────────────────────────────
const apiKey = process.env.TUSUNSUN_API_KEY || '';
const baseUrl = process.env.TUSUNSUN_BASE_URL || '';
if (!apiKey || !baseUrl) {
  bench.skip('L5-live', '真实免费模型', '[NOT_RUN] 未配置 TUSUNSUN_API_KEY / TUSUNSUN_BASE_URL（.env 缺失）');
  bench.finish();
}

{
  const gw = await startGateway({});
  try {
    await chatOnce(gw.base).catch(() => null);
    const samples = [];
    for (let i = 0; i < 3; i++) {
      const r = await chatOnce(gw.base);
      if (r.status !== 200) { bench.fail('L5-live', '真实模型', `status=${r.status} ${r.body.slice(0, 160)}`); break; }
      samples.push(r.ms);
    }
    if (samples.length) {
      const st = summarize(samples);
      bench.record({ id: 'L5-live', scene: `真实模型 ${process.env.TUSUNSUN_MODEL || '?'}`, metric: 'e2e p50', value: st.p50, unit: 'ms', kind: 'R' });
      bench.record({ id: 'L5-live-b', scene: '真实模型 · 波动', metric: 'max/min', value: st.max / Math.max(st.min, 1), unit: '×', kind: 'R' });
    }
  } finally {
    await gw.child.reap({ graceMs: 1500, killWaitMs: 2000 });
    try { rmSync(gw.stateDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  bench.finish();
}
