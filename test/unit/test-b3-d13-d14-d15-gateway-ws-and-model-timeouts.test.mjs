// B-3 / D-13 / D-14 / D-15 回归：网关 WS 同源闸门、模型响应体超时、错误契约字段、调试落盘。
// 每条缺陷配一条合法正例，避免“一律拒绝/一律降级”的假修复。
import { createServer } from 'node:http';
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, assertEquals } from '../harness.mjs';
import GW from '../../plugins/gateway.js';
import Model from '../../plugins/model-openai.js';
import { WebSocket } from '../../vendor/ws/wrapper.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(20);
  }
  return predicate();
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function closeServer(server, sockets = []) {
  for (const socket of sockets) { try { socket.destroy(); } catch { /* 已关 */ } }
  try { server.closeAllConnections?.(); } catch { /* 已关 */ }
  await new Promise((resolve) => server.close(() => resolve()));
}

/** 真网关进程内的 WS 升级：真实 HTTP server + 真实 ws 握手，避免“只调函数”的假绿。 */
async function startGatewayHost({ apiKey } = {}) {
  const gw = Object.create(GW);
  gw.clients = new Map();
  gw.requestId = 0;
  const httpErrors = [];
  gw.core = {
    getService: (name) => (name === 'config'
      ? { get: (key) => (key === 'gateway.apiKey' ? apiKey : undefined) }
      : null),
    log: () => {},
    emitFast: (event, data) => { if (event === 'http.error') httpErrors.push(data); },
  };
  const server = createServer((req, res) => { res.writeHead(404); res.end(); });
  const sockets = new Set();
  server.on('upgrade', (req, socket, head) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    gw._handleWsUpgrade(req, socket, head);
  });
  gw.httpServer = server;
  const port = await listen(server);
  return { gw, port, httpErrors, close: () => closeServer(server, sockets) };
}

/** 客户端握手：不传 origin 表示浏览器以外的客户端（不带 Origin）。 */
function wsHandshake(port, { origin, apiKey } = {}) {
  const protocols = ['tusunsun.v1'];
  if (apiKey) protocols.push(`tusunsun.token.${Buffer.from(apiKey).toString('base64url')}`);
  const options = { handshakeTimeout: 2000 };
  if (origin) options.origin = origin;
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, protocols, options);
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => { try { ws.terminate(); } catch { /* 已关 */ } done({ outcome: 'timeout' }); }, 3000);
    ws.on('open', () => { const protocol = ws.protocol; ws.close(); done({ outcome: 'open', protocol }); });
    ws.on('unexpected-response', (req, res) => { res.resume(); done({ outcome: 'rejected', statusCode: res.statusCode }); });
    ws.on('error', (err) => done({ outcome: 'error', message: err.message }));
  });
}

function modelWith(baseUrl, apiKey = 'sk-test') {
  const model = Object.create(Model);
  model.core = {
    getService: (name) => (name === 'config'
      ? { get: (key) => (key === 'model.baseUrl' ? baseUrl : key === 'model.apiKey' ? apiKey : key === 'model.model' ? 'm' : undefined) }
      : null),
    emit: () => {},
    log: () => {},
  };
  return model;
}

/** 响应头已发出、body 永不完结：只有“等到响应头”的超时会在这里挂住。 */
async function startHangingBodyServer() {
  let closed = false;
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"choices":[{"message":{"content":"partial');
    req.socket.on('close', () => { closed = true; });
  });
  const port = await listen(server);
  return { port, wasClosed: () => closed, close: () => closeServer(server) };
}

/** 一轮完整 SSE 响应，用于证明调试落盘/不落盘都不影响流本身。 */
async function startSseServer() {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push(body);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  const port = await listen(server);
  return { port, seen, close: () => closeServer(server) };
}

function debugArtifacts() {
  return new Set(readdirSync(tmpdir()).filter((name) => name.includes('stream-body')));
}

async function drain(iterable) {
  const chunks = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

export async function setup(runner) {
  // ══ B-3：WS 升级与 /api/* 共用同源判据 ═══════════════════════════════
  runner.test('B-3 跨站 Origin 的 WS 升级必须 403、不建立连接、记一条 http.error', async () => {
    const host = await startGatewayHost();
    try {
      const result = await wsHandshake(host.port, { origin: 'http://evil.example' });
      const rejected = result.outcome === 'rejected'
        ? result.statusCode === 403
        : result.outcome === 'error' && /403/.test(result.message || '');
      assert(rejected, `跨站 Origin 必须被拒（403），实际 ${JSON.stringify(result)}`);
      assertEquals(host.gw.clients.size, 0, '被拒的跨站升级不得创建 WS 连接');
      assertEquals(host.httpErrors.filter((entry) => entry.statusCode === 403).length, 1,
        '拒绝必须落一条 403 http.error');
    } finally { await host.close(); }
  });

  runner.test('B-3 无 Origin 的 CLI 连接照常升级，子协议协商不受影响', async () => {
    const host = await startGatewayHost();
    try {
      const result = await wsHandshake(host.port);
      assertEquals(result.outcome, 'open', `无 Origin 的 CLI 必须放行，实际 ${JSON.stringify(result)}`);
      assertEquals(result.protocol, 'tusunsun.v1', 'Sec-WebSocket-Protocol 协商不得被同源校验破坏');
    } finally { await host.close(); }
  });

  runner.test('B-3 同源浏览器 Origin 照常升级', async () => {
    const host = await startGatewayHost();
    try {
      const result = await wsHandshake(host.port, { origin: `http://127.0.0.1:${host.port}` });
      assertEquals(result.outcome, 'open', `同源 Origin 必须放行，实际 ${JSON.stringify(result)}`);
      assertEquals(result.protocol, 'tusunsun.v1', '同源连接同样要完成子协议协商');
    } finally { await host.close(); }
  });

  runner.test('B-3 口令正确但 Origin 跨站：仍在口令校验前被拒', async () => {
    const apiKey = 'ws-key';
    const host = await startGatewayHost({ apiKey });
    try {
      const evil = await wsHandshake(host.port, { origin: 'http://evil.example', apiKey });
      assert(evil.outcome === 'rejected' && evil.statusCode === 403,
        `跨站 + 正确口令必须仍被 403，实际 ${JSON.stringify(evil)}`);
      const same = await wsHandshake(host.port, { origin: `http://127.0.0.1:${host.port}`, apiKey });
      assertEquals(same.outcome, 'open', `同源 + 正确口令必须放行，实际 ${JSON.stringify(same)}`);
    } finally { await host.close(); }
  });

  // ══ D-13：响应体读取有总时长上限，超时真的断开连接 ═════════════════
  runner.test('D-13 响应体永不发完：按 body 超时失败并真的断开连接', async () => {
    const stub = await startHangingBodyServer();
    const saved = process.env.TUSUNSUN_MODEL_TIMEOUT_MS;
    process.env.TUSUNSUN_MODEL_TIMEOUT_MS = '300';
    try {
      const model = modelWith(`http://127.0.0.1:${stub.port}/v1`);
      const startedAt = Date.now();
      const result = await model.call([{ role: 'user', content: 'hi' }]);
      const elapsed = Date.now() - startedAt;
      assertEquals(result.error, true, `body 超时必须自证失败（error:true），实际 ${JSON.stringify(result)}`);
      assert(/timeout .*response body/i.test(result.content || ''), `错误文案应指明 body 超时，实际 ${result.content}`);
      assert(elapsed < 2000, `body 超时必须结束等待（期望 < 2000ms，实际 ${elapsed}ms）`);
      assertEquals(await waitFor(() => stub.wasClosed(), 2000), true, '超时必须销毁底层连接，而不只是结束等待');
    } finally {
      if (saved === undefined) delete process.env.TUSUNSUN_MODEL_TIMEOUT_MS;
      else process.env.TUSUNSUN_MODEL_TIMEOUT_MS = saved;
      await stub.close();
    }
  });

  runner.test('D-13 响应体慢但发完：在超时预算内正常返回（不是一律超时）', async () => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      setTimeout(() => {
        res.write('{"choices":[{"message":{"content":"slow-but-complete"},"finish_reason":"stop"}]}');
        res.end();
      }, 80);
    });
    const port = await listen(server);
    const saved = process.env.TUSUNSUN_MODEL_TIMEOUT_MS;
    process.env.TUSUNSUN_MODEL_TIMEOUT_MS = '1000';
    try {
      const model = modelWith(`http://127.0.0.1:${port}/v1`);
      const result = await model.call([{ role: 'user', content: 'hi' }]);
      assertEquals(result.error, undefined, `慢响应在预算内必须成功，实际 ${JSON.stringify(result)}`);
      assertEquals(result.content, 'slow-but-complete', '必须读到完整 body');
    } finally {
      if (saved === undefined) delete process.env.TUSUNSUN_MODEL_TIMEOUT_MS;
      else process.env.TUSUNSUN_MODEL_TIMEOUT_MS = saved;
      await closeServer(server);
    }
  });

  // ══ D-14：错误契约字段以存量最多的 error:true 为准 ═════════════════
  runner.test('D-14 call() 的非法 baseUrl 与其它错误分支同契约：error:true', async () => {
    const model = modelWith('not-a-url');
    const result = await model.call([{ role: 'user', content: 'hi' }]);
    assertEquals(result.error, true, `非法 baseUrl 必须 error:true，实际 ${JSON.stringify(result)}`);
    assert(/Invalid base URL/i.test(result.content || ''), '文案必须点明非法 baseUrl');
  });

  runner.test('D-14 callWithConfig() 的非法 baseUrl 同一契约', async () => {
    const model = modelWith('not-a-url');
    const result = await model.callWithConfig(
      { baseUrl: 'not-a-url', apiKey: 'sk-test', model: 'm' },
      [{ role: 'user', content: 'hi' }],
    );
    assertEquals(result.error, true, `两条路径必须同契约，实际 ${JSON.stringify(result)}`);
  });

  runner.test('D-14 合法 baseUrl 正常返回且不带 error 标记', async () => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'fine' }, finish_reason: 'stop' }] }));
    });
    const port = await listen(server);
    try {
      const model = modelWith(`http://127.0.0.1:${port}/v1`);
      const result = await model.call([{ role: 'user', content: 'hi' }]);
      assertEquals(result.error, undefined, `成功结果不得带 error 标记，实际 ${JSON.stringify(result)}`);
      assertEquals(result.content, 'fine', '合法端点必须正常返回内容');
    } finally { await closeServer(server); }
  });

  // ══ D-15：调试落盘默认关闭，开启时限制权限并脱敏 ═══════════════════
  runner.test('D-15 DEBUG_STREAM_BODY 未开启：不写盘，流式结果不变', async () => {
    const stub = await startSseServer();
    const saved = process.env.TUSUNSUN_DEBUG_STREAM_BODY;
    delete process.env.TUSUNSUN_DEBUG_STREAM_BODY;
    try {
      const before = debugArtifacts();
      const model = modelWith(`http://127.0.0.1:${stub.port}/v1`);
      const chunks = await drain(model.streamChatWithConfig(
        { baseUrl: `http://127.0.0.1:${stub.port}/v1`, apiKey: 'sk-test', model: 'm' },
        [{ role: 'user', content: 'hello' }], [], {},
      ));
      const added = [...debugArtifacts()].filter((name) => !before.has(name));
      assertEquals(added.length, 0, `未开启调试时不得落盘，实际新增 ${JSON.stringify(added)}`);
      assertEquals(chunks.some((chunk) => chunk.content === 'ok'), true, '不落盘不应影响流式输出');
    } finally {
      if (saved === undefined) delete process.env.TUSUNSUN_DEBUG_STREAM_BODY;
      else process.env.TUSUNSUN_DEBUG_STREAM_BODY = saved;
      await stub.close();
    }
  });

  runner.test('D-15 DEBUG_STREAM_BODY 开启：mkdtemp + 0600 + 日志路径 + 脱敏', async () => {
    const stub = await startSseServer();
    const saved = process.env.TUSUNSUN_DEBUG_STREAM_BODY;
    const before = debugArtifacts();
    const logs = [];
    process.env.TUSUNSUN_DEBUG_STREAM_BODY = '1';
    try {
      const model = Object.create(Model);
      model.core = { getService: () => null, emit: () => {}, log: (level, msg) => logs.push(String(msg)) };
      const tools = [{
        name: 't', description: 'd',
        parameters: { type: 'object', properties: { authorization: { type: 'string' }, api_key: { type: 'string' }, q: { type: 'string' } } },
      }];
      await drain(model.streamChatWithConfig(
        { baseUrl: `http://127.0.0.1:${stub.port}/v1`, apiKey: 'sk-very-secret', model: 'm' },
        [{ role: 'user', content: 'PROMPT-MARKER' }], tools, {},
      ));
      const dirs = [...debugArtifacts()].filter((name) => !before.has(name) && name.startsWith('tusunsun-stream-body-'));
      assertEquals(dirs.length, 1, `应产生一个 mkdtemp 调试目录，实际 ${JSON.stringify(dirs)}`);
      const dir = join(tmpdir(), dirs[0]);
      assertEquals((statSync(dir).mode & 0o777).toString(8), '700', 'mkdtemp 目录必须是 0700');
      const files = readdirSync(dir);
      assertEquals(files.length, 1, `一轮流式请求应写一个 body 文件，实际 ${JSON.stringify(files)}`);
      const file = join(dir, files[0]);
      assertEquals((statSync(file).mode & 0o777).toString(8), '600', '调试文件必须是 0600');
      const content = readFileSync(file, 'utf8');
      assert(content.includes('PROMPT-MARKER'), '调试文件必须能定位到请求内容');
      assert(!content.includes('sk-very-secret'), '调试文件不得包含模型 key');
      assert(content.includes('"authorization": "[REDACTED]"'), 'authorization 字段值必须脱敏');
      assert(content.includes('"api_key": "[REDACTED]"'), 'api_key 字段值必须脱敏');
      assert(logs.some((line) => line.includes(file)), '路径必须打进日志，不能静默落盘');
    } finally {
      if (saved === undefined) delete process.env.TUSUNSUN_DEBUG_STREAM_BODY;
      else process.env.TUSUNSUN_DEBUG_STREAM_BODY = saved;
      for (const name of debugArtifacts()) {
        if (!before.has(name) && name.startsWith('tusunsun-stream-body-')) {
          rmSync(join(tmpdir(), name), { recursive: true, force: true });
        }
      }
      await stub.close();
    }
  });
}
