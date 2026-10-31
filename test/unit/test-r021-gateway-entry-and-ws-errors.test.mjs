// R0-021（rc.15）：网关两个入口的判据（专家 rc.14 复审 S8 / S9）。
//
// 两条都不是「算错了」，而是「判据放错了地方 / 没有接上线」：
//
//   S9  `_sameOrigin` 本体是对的（跨站 Origin、DNS rebinding Host 都被拒）。问题是
//       **它只挂在 `/api/*` 上**：`/v1/chat/completions` 与 `/ming/push` 从来不经过它。
//       默认无 apiKey 部署下，任意网页 `fetch` 就能触发一次真实 chat（写文件、跑命令、
//       烧额度）；响应因缺 CORS 头读不到 —— 但**读不到不等于没发生**。
//
//   S8  WebSocket 是 EventEmitter，`emit('error')` 无监听者就抛。`connection` 只挂了
//       message/close，于是 vendor/ws 收到一个 RSV1 置位的 3 字节帧就把它抛成了
//       未捕获异常，经 cli.js 的 `uncaughtException` 把整个网关进程 exit 1。
//
// 所以本文件必须证明两件事，缺一条就是假修：
//   ① 该死的地方死：跨站 `/v1` 403 且 **chat handler 一次都没被调用**（只断言 403 不够，
//      修前也可能因限流/凭证返回 403）；
//   ② 不该死的地方不死：合法同源 `/v1`、跨站 `/health`、`/api/*` 自己的守卫、
//      以及**一个畸形帧之后的服务器仍然能接受新握手**。
//
// S8 的行为判据必须放在**子进程**里：修前那个未捕获异常会在本进程里直接杀掉整个
// 测试文件（proc.mjs 的 uncaughtException 会回收子进程后 exit 1），一条 FAIL 都打不出来。
// 子进程死不死，才是「一个帧杀一个进程」这句话的本来意思。
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assert, assertEquals } from '../harness.mjs';
import { spawnManaged } from '../lib/proc.mjs';
import GW from '../../plugins/gateway.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

// **升级后的连接不在 `closeAllConnections()` 的覆盖范围内**：断言抛在 `sock.destroy()` 之前时，
// `server.close()` 会永久等一个还活着的 WS 连接 —— 实测修前就卡在这里（rc=137 被外层 timeout 杀）。
// 所以 teardown 必须自己把升级连接收完。
async function closeServer(server, sockets = []) {
  for (const socket of sockets) { try { socket.destroy(); } catch { /* 已关 */ } }
  try { server.closeAllConnections?.(); } catch { /* 已关 */ }
  await new Promise((resolve) => server.close(() => resolve()));
}

/** 网关桩：只提供被跳到的服务，`log` / `emitFast` 都记下来供断言。 */
function makeCore() {
  const logs = [];
  const httpErrors = [];
  const core = {
    getService: (name) => (name === 'config' ? { get: () => undefined } : null),
    log: (level, msg) => logs.push({ level, msg }),
    emitFast: (event, data) => { if (event === 'http.error') httpErrors.push(data); },
    status: () => ({ uptime: 1 }),
    plugins: new Map(),
  };
  return { core, logs, httpErrors };
}

/** 真 HTTP server + 真请求路径：走 `_handleHttpRequest`，不直接调子函数。 */
async function startHttpHost() {
  const rec = makeCore();
  const gw = Object.create(GW);
  gw.clients = new Map();
  gw.requestId = 0;
  gw.core = rec.core;
  gw._limiter = { take: () => true };
  gw._readinessMissing = async () => [];
  rec.chats = 0;
  gw._handleOpenAIChat = async (req, res) => { rec.chats += 1; gw._sendJson(res, 200, { ok: true }); };
  const server = createServer((req, res) => { gw._handleHttpRequest(req, res); });
  gw.httpServer = server;
  const port = await listen(server);
  return { gw, port, rec, close: () => closeServer(server) };
}

/** 裸 socket 握手：要发畸形帧就不能用合规客户端库。 */
function rawHandshake(port) {
  return new Promise((resolve) => {
    const sock = connect(port, '127.0.0.1');
    let buf = '';
    sock.on('error', () => resolve({ sock, status: 0 }));
    const onData = (chunk) => {
      buf += chunk.toString('latin1');
      if (!buf.includes('\r\n\r\n')) return;
      sock.removeListener('data', onData);
      resolve({ sock, status: Number((buf.split(' ')[1] || '0')) });
    };
    sock.on('data', onData);
    sock.on('connect', () => {
      sock.write([
        'GET /ws HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${Buffer.from('0123456789abcdef').toString('base64')}`,
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Protocol: tusunsun.v1',
        '', '',
      ].join('\r\n'));
    });
  });
}

/** 子进程里的网关：它死没死，就是 S8 的判据本体。 */
const CHILD_SRC = `
import { createServer } from 'node:http';
import GW from ${JSON.stringify(join(ROOT, 'plugins', 'gateway.js'))};
const gw = Object.create(GW);
gw.clients = new Map();
gw.requestId = 0;
gw.core = { getService: () => ({ get: () => undefined }), log: () => {}, emitFast: () => {} };
const server = createServer((req, res) => { res.writeHead(404); res.end(); });
server.on('upgrade', (req, socket, head) => gw._handleWsUpgrade(req, socket, head));
gw.httpServer = server;
server.listen(0, '127.0.0.1', () => process.stdout.write('PORT ' + server.address().port + '\\n'));
`;

async function startChildHost(tmp) {
  const file = join(tmp, 'ws-host.mjs');
  writeFileSync(file, CHILD_SRC);
  const child = spawnManaged(process.execPath, [file], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => { out += c.toString(); });
  child.stderr.on('data', (c) => { err += c.toString(); });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !/^PORT \d+$/m.test(out)) {
    if (child.exitCode !== null) break;
    await sleep(20);
  }
  const port = Number((out.match(/^PORT (\d+)$/m) || [])[1] || 0);
  return { child, port, stdout: () => out, stderr: () => err };
}

export async function setup(runner) {
  let tmp;
  runner.beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'r021-')); });
  runner.afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ } });

  // ══ S9：同源判定的位置就是它的覆盖面 ═══════════════════════════════
  runner.test('R0-021/1 跨站 Origin 的 /v1 必须 403，且 chat handler 一次都不得被调用', async () => {
    const h = await startHttpHost();
    try {
      const r = await fetch(`http://127.0.0.1:${h.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { origin: 'http://evil.example', 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      });
      assertEquals(r.status, 403, `跨站 POST /v1 必须 403，实得 ${r.status}`);
      assertEquals(h.rec.chats, 0,
        '跨站请求必须一次都不触达 chat handler —— 否则「响应读不到」就成了「副作用已发生」');
      assertEquals(h.rec.httpErrors.filter((e) => e.statusCode === 403).length, 1,
        '拒绝必须落一条 403 http.error（默不作声的拒绝运维看不见）');
      const body = await r.json();
      assertEquals(body.error, 'cross-origin request rejected', '拒绝原因必须写清楚是跨源');
    } finally { await h.close(); }
  });

  runner.test('R0-021/2 反向判据：同源 /v1 必须真的进到 chat（不得一律拒绝）', async () => {
    const h = await startHttpHost();
    try {
      const r = await fetch(`http://127.0.0.1:${h.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { origin: `http://127.0.0.1:${h.port}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      });
      assertEquals(r.status, 200, `同源 POST /v1 必须放行，实得 ${r.status}`);
      assertEquals(h.rec.chats, 1, `同源请求必须真的进 chat handler，实际调用 ${h.rec.chats} 次`);
    } finally { await h.close(); }
  });

  runner.test('R0-021/3 健康面不得被同源判据拦（探针本身就是跨站/无 Origin 的）', async () => {
    const h = await startHttpHost();
    try {
      for (const path of ['/health', '/ready']) {
        // eslint-disable-next-line no-await-in-loop
        const r = await fetch(`http://127.0.0.1:${h.port}${path}`, { headers: { origin: 'http://evil.example' } });
        assertEquals(r.status, 200, `${path} 不得因跨站 Origin 变成 403，实得 ${r.status}`);
      }
    } finally { await h.close(); }
  });

  runner.test('R0-021/4 /api/* 仍走它自己的守卫（新闸门不得替它改语义）', async () => {
    const h = await startHttpHost();
    try {
      const r = await fetch(`http://127.0.0.1:${h.port}/api/status`, { headers: { origin: 'http://evil.example' } });
      assertEquals(r.status, 403, `跨站 /api/* 必须 403，实得 ${r.status}`);
      const last = h.rec.httpErrors.at(-1);
      assertEquals(last?.error, 'cross-origin control-plane request rejected',
        `必须仍由 _guardControlPlane 拒绝（它还要判凭证与 JSON），实际记的是 ${last?.error}`);
    } finally { await h.close(); }
  });

  // ══ S8：一个畸形帧不得杀掉网关进程 ═════════════════════════════════
  runner.test('R0-021/5 3 字节畸形帧（RSV1 置位）不得杀死网关进程，之后仍能握手', async () => {
    const host = await startChildHost(tmp);
    try {
      assert(host.port > 0, `子进程网关没有报出端口，本用例无法判定：${host.stdout()}${host.stderr()}`);
      const first = await rawHandshake(host.port);
      assertEquals(first.status, 101, '前提：合法握手必须成功（否则测到的不是畸形帧）');
      await sleep(30);
      // FIN | RSV1 | opcode=1(text)，长度 1，载荷 'x'：3 字节。
      first.sock.write(Buffer.from([0xc1, 0x01, 0x78]));
      await sleep(250);
      assert(host.child.exitCode === null,
        `一个 3 字节帧就把网关进程杀了（exit ${host.child.exitCode}）——这正是 S8；`
        + `stderr: ${host.stderr().slice(0, 400)}`);
      assert(!/RSV1/.test(host.stderr()),
        `未捕获帧错误不得出现在 stderr 的崩溃堆栈里：${host.stderr().slice(0, 400)}`);
      const second = await rawHandshake(host.port);
      assertEquals(second.status, 101, '畸形帧之后，服务器必须仍能接受新的 WS 握手');
      try { second.sock.destroy(); } catch { /* 已关 */ }
      try { first.sock.destroy(); } catch { /* 已关 */ }
    } finally {
      try { host.child.kill('SIGKILL'); } catch { /* 已退出 */ }
      await host.child.reap?.();
    }
  });

  runner.test('R0-021/6 反向判据：error 监听者必须真的挂在服务端对象上，且合法连接照常', async () => {
    const rec = makeCore();
    const gw = Object.create(GW);
    gw.clients = new Map();
    gw.requestId = 0;
    gw.core = rec.core;
    const server = createServer((req, res) => { res.writeHead(404); res.end(); });
    const sockets = new Set();
    server.on('upgrade', (req, socket, head) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      gw._handleWsUpgrade(req, socket, head);
    });
    gw.httpServer = server;
    const port = await listen(server);
    try {
      const { sock, status } = await rawHandshake(port);
      assertEquals(status, 101, `合法握手必须成功，实得 ${status}`);
      const conn = [...gw.clients.values()][0];
      const serverHasErrorListener = (gw.wsServer?.listenerCount('error') ?? 0) >= 1;
      const connHasErrorListener = conn ? conn.listenerCount('error') >= 1 : false;
      try { sock.destroy(); } catch { /* 已关 */ }
      assert(conn, '握手后必须登记到 clients（本判据需要一个真实连接对象）');
      assert(serverHasErrorListener,
        'wsServer 上必须挂 error 监听者（服务级错误同样会 emit 成未捕获异常）');
      assert(connHasErrorListener,
        '连接对象上必须挂 error 监听者 —— 修前就是这里零监听者，一个畸形帧变成进程级异常');
    } finally {
      // 先取快照再销毁：`close` 回调会把条目从集合里删掉，边遍历边删会漏收。
      const live = [...sockets];
      await closeServer(server, live);
    }
  });
}
