// R0-174：上下文读数与手动压缩的公开面
//
// `token_usage` 只在流式 SSE 里出现，非流式只有 `tusunsun_context`，外部拿不到
// “当前用了多少 / 摘要是谁生成的 / 能不能手动压缩”。这里把三件事做成**控制面**：
//   `GET  /api/context?session_id=` → used/max/percent + summary{text,source_range,generator,degraded}
//   `POST /api/context/compact`     → 立即压缩一次，回报前/后用量
//
// 四条锁的都是行为而不是形状：
//   T1 读数与 `context.getUsage()` 同源（不另算一套预算）
//   T2 端点语义：缺参数 400 / 非法 id 400 / 不在本进程 404 / 正常 200 / 跨源 403
//   T3 压缩真的变小，且摘要**不写进会话**（否则下一轮会二次注入）
//   T4 摘不到摘要时**不动会话**（409 summary_unavailable），不静默丢轮次
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assert, assertEquals } from '../harness.mjs';
import GW from '../../plugins/gateway.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(pathToFileURL(join(ROOT, rel)).href);

/** 一条足够长的会话：system + N 轮，每轮 ~8k 字符（估算 ~2000 tokens），远超默认预算。 */
function longHistory(turns = 6) {
  const msgs = [{ role: 'system', content: 'SYS-PROMPT' }];
  for (let i = 0; i < turns; i++) {
    msgs.push({ role: 'user', content: `U${i}-` + 'x'.repeat(4000) });
    msgs.push({ role: 'assistant', content: `A${i}-` + 'y'.repeat(4000) });
  }
  return msgs;
}

export async function setup(runner) {
  const tmp = mkdtempSync(join(tmpdir(), 'tt-r0174-'));
  runner.afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const boot = async () => {
    const { createRuntime } = await imp('src/core/core.js');
    const { PluginManager } = await imp('src/core/plugin-manager.js');
    const stateDir = join(mkdtempSync(join(tmp, 'state-')), 's');
    const rt = createRuntime({ stateDir, pluginsDir: join(ROOT, 'plugins') });
    const pm = new PluginManager(rt.core);
    rt.core.registerService('plugin-manager', pm);
    pm.addDirectory(join(ROOT, 'plugins'));
    await pm.loadAll(['config', 'session', 'context-manager']);
    await rt.core.start();
    return { rt, session: rt.core.getService('session'), ctx: rt.core.getService('context') };
  };

  /** 真 HTTP 宿主：走 `_handleHttpRequest` 的真路径（不直接调 handler），才能测到同源/控制面守卫。 */
  const host = async (rt) => {
    const gw = Object.create(GW);
    gw.clients = new Map();
    gw.requestId = 0;
    gw.handlers = new Map();
    gw.core = rt.core;
    gw._limiter = { take: () => true };
    gw._readinessMissing = async () => [];
    gw.addHandler('GET', '/api/context', (req, res) => gw._handleContextGet(req, res));
    gw.addHandler('POST', '/api/context/compact', (req, res) => gw._handleContextCompact(req, res));
    const server = createServer((req, res) => gw._handleHttpRequest(req, res));
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    // 同源判定的可信 Host 表是**按实际端口**现算的（`get port()` 读 `httpServer`）：不挂上就全判跨源。
    gw.httpServer = server;
    const base = `http://127.0.0.1:${server.address().port}`;
    const close = async () => {
      try { server.closeAllConnections?.(); } catch { /* 已关 */ }
      await new Promise((resolve) => server.close(resolve));
    };
    return { gw, base, close };
  };

  runner.test('R0-174/T1 读数必须与 context.getUsage 同源（不另算一套预算）', async () => {
    const { rt, session, ctx } = await boot();
    try {
      const history = longHistory(2);
      await session.saveHistory('s-ctx', history);
      const snap = await ctx.snapshot('s-ctx');
      const direct = ctx.getUsage(session.getHistory('s-ctx'), ctx._toolList());
      assertEquals(snap.session_id, 's-ctx');
      assertEquals(snap.used, direct.used, 'used 必须来自同一份预算函数');
      assertEquals(snap.max, direct.max);
      assertEquals(snap.percent, direct.percent);
      assertEquals(snap.messages, history.length);
      assertEquals(snap.summary.text, '', '还没压缩过就没有摘要');
      assertEquals(snap.summary.degraded, true);
      assertEquals(snap.summary.reason, 'no_summary');
      console.log(`       [实测] used=${snap.used}/${snap.max} (${snap.percent}%)，与 getUsage 同源；无摘要时 reason=no_summary`);
    } finally { await rt.core.stop(); }
  });

  runner.test('R0-174/T2 端点语义：400/404/200/403，不拿空数组冒充“会话没在跑”', async () => {
    const { rt, session } = await boot();
    const h = await host(rt);
    try {
      await session.saveHistory('s-http', longHistory(1));
      const get = async (path, headers = {}) => {
        const r = await fetch(h.base + path, { headers });
        return { status: r.status, body: await r.json() };
      };
      assertEquals((await get('/api/context')).status, 400, '缺 session_id 必须 400');
      assertEquals((await get('/api/context')).body.code, 'session_required');
      assertEquals((await get('/api/context?session_id=a%2Fb')).status, 400, '非法 id 必须 400');
      const unknown = await get('/api/context?session_id=not-loaded');
      assertEquals(unknown.status, 404, '不在本进程的会话必须 404，不得返回 0');
      assertEquals(unknown.body.code, 'unknown_session');
      const ok = await get('/api/context?session_id=s-http');
      assertEquals(ok.status, 200);
      assert(Number.isFinite(ok.body.used) && ok.body.used > 0, 'used 必须是实数');
      assert(ok.body.summary && typeof ok.body.summary.text === 'string', '必须带 summary 元数据');
      const cross = await get('/api/context?session_id=s-http', { Origin: 'http://evil.example' });
      assertEquals(cross.status, 403, '跨源必须拒（与其余 /api/* 同门）');
      console.log('       [实测] 400/400/404/200/403 五条语义全部成立');
    } finally { await h.close(); await rt.core.stop(); }
  });

  runner.test('R0-174/T3 压缩：会话真的变小，且摘要不写进会话（下一轮不二次注入）', async () => {
    const { rt, session, ctx } = await boot();
    const h = await host(rt);
    rt.core.registerService('model', {
      call: async () => ({ tool_calls: [{ arguments: JSON.stringify({ summary: 'SUMMARY-FACT-42' }) }] }),
    });
    try {
      const before = longHistory(6);
      await session.saveHistory('s-compact', before);
      const r = await fetch(h.base + '/api/context/compact', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 's-compact' }),
      });
      const body = await r.json();
      assertEquals(r.status, 200, `压缩失败：${JSON.stringify(body)}`);
      assertEquals(body.compacted, true);
      assert(body.messages.after < body.messages.before, `会话必须真的变小：${body.messages.before} → ${body.messages.after}`);
      assert(body.used.after < body.used.before, '用量必须下降');
      assert(/SUMMARY-FACT-42/.test(body.summary.text), '必须回报摘要正文');
      const saved = session.getHistory('s-compact');
      assertEquals(saved.length, body.messages.after, '落盘的会话长度必须与回报一致');
      assert(!/## Conversation Summary/.test(saved[0].content || ''), '摘要不得写进会话（否则下一轮会再注入一次）');
      const snap = await ctx.snapshot('s-compact');
      assert(/SUMMARY-FACT-42/.test(snap.summary.text), '压缩后读数里必须能看到摘要');
      assertEquals(snap.summary.generator, 'in-memory');
      assertEquals(snap.summary.degraded, true, '内存摘要不可回读，必须如实标降级');
      console.log(`       [实测] ${body.messages.before} → ${body.messages.after} 条，用量 ${body.used.before} → ${body.used.after}，摘要留在摘要位`);
    } finally { await h.close(); await rt.core.stop(); }
  });

  runner.test('R0-174/T4 摘不到摘要时不得丢会话：409 且会话不变', async () => {
    const { rt, session } = await boot();
    const h = await host(rt);
    try {
      const before = longHistory(6);
      await session.saveHistory('s-nosum', before);
      const r = await fetch(h.base + '/api/context/compact', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 's-nosum' }),
      });
      const body = await r.json();
      assertEquals(r.status, 409, '没有模型就没有摘要，必须 409 而不是静默丢轮次');
      assertEquals(body.code, 'summary_unavailable');
      assertEquals(session.getHistory('s-nosum').length, before.length, '会话必须一字未动');
      console.log('       [实测] 无模型时 409 summary_unavailable，会话长度不变');
    } finally { await h.close(); await rt.core.stop(); }
  });
}
