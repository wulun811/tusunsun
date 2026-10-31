// R0-109/T1：CLI ↔ 网关的传输层 —— 唯一入口，必须走**真正的** RFC 6455 握手。
//
// 这里此前是手搓帧 + 裸 TCP：`createConnection()` 之后直接把 0x81 帧写出去，没有 HTTP Upgrade。
// 而网关侧是 `WebSocketServer({ noServer: true })` + `handleUpgrade`（`plugins/gateway.js`，
// 且只认 `req.url` 以 `/ws` 开头的请求）⇒ 裸帧被 HTTP 解析器判为坏请求、对端直接断连。
//
// 更致命的是当时只挂了 'data' / 'error'，**没有 'close'**：socket 被对端关掉时 promise 永不
// settle，事件循环随即排空 ⇒ node 以 **exit 0 且零输出**退场。
// 实测（R0-109 复现）：网关明明在 9002 上听，`tusunsun status` / `stop` 零输出、0.085s 退出；
// `tusunsun chat` 打印完 "Agent:" 就静默退出——消息被丢弃，既不回答也不报错。
// 于是三个命令恰好"网关活着时失效、网关没起时才报错"，方向完全反了。
//
// 现在直接用运行期依赖 `ws`（本来就在 dependencies 里）做标准握手，并把
// open → send → res / error / close / 超时 每条路径都收束到**同一个 settle**：
// 无论成功还是失败，调用方一定拿到结果，不允许再出现"静默 exit 0"。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveStateDir } from './state-dir.mjs';
import { readEnv } from '../src/core/env.js';

export const C = {
  reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', gray: '\x1b[90m', bold: '\x1b[1m',
};

export function c(color, text) {
  return `${C[color] || ''}${text}${C.reset}`;
}

/** status / stop 这类一问一答的兜底超时。 */
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * 对话的兜底超时：网关侧预算是 `gateway.chatTimeoutMs`，默认 600000（10 分钟，多步工具循环
 * 需要这么久）。客户端刻意比它略长，让**网关自己**的超时先到，从而拿到一条可读的错误，
 * 而不是客户端提前跑掉留下半截状态。
 */
export const CHAT_TIMEOUT_MS = 620000;

/**
 * 取网关口令（配置里的 `gateway.apiKey`）。未配置 = null（默认无鉴权）。
 * 与端口同源：都从同一个 stateDir 的 config.json 读，避免"端口认得、口令不认"的第二次分叉。
 * R0-113（P1-02）：状态目录解析统一走 `./state-dir.mjs`（`--state-dir > TUSUNSUN_STATE_DIR > ~/.tusunsun`）。
 */
export function gatewayToken(stateDir) {
  // 内核的优先级是 env 覆盖配置（见 config.applyEnvOverrides）⇒ CLI 也要先看 env，
  // 否则纯 env 部署（TUSUNSUN_GATEWAY_KEY=…）下官方 CLI 会被自己的网关 401 挡住。
  const envKey = readEnv('GATEWAY_KEY');
  if (envKey) return envKey;
  const dir = resolveStateDir(stateDir);
  try {
    return JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))?.gateway?.apiKey || null;
  } catch { return null; }
}

/**
 * 一次请求-响应。**任何路径都必须 settle**（这是 R0-109 的核心教训）。
 * @param {number} port 网关端口
 * @param {string} method 形如 `core.status` / `core.stop` / `agent.chat`
 * @param {object} params
 * @param {{token?: string|null, timeoutMs?: number}} [opts]
 * @returns {Promise<{type:'res', id:number, ok:boolean, payload?:any, error?:string}>}
 */
export async function wsRequest(port, method, params = {}, opts = {}) {
  // R0-117：内置 ws（vendor/ws），发布物不再需要 npm 安装任何运行时依赖
  const { WebSocket } = await import('../vendor/ws/wrapper.mjs');
  const token = opts.token || null;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // R0-113（P0-01）：口令走 **Sec-WebSocket-Protocol 请求头**，不再拼进 URL
  // （URL 会进 shell 历史、代理日志、Referer）。`?token=` 服务端仍兼容读取，但官方客户端不用了。
  const url = `ws://127.0.0.1:${port}/ws`;
  const protocols = token
    ? ['tusunsun.v1', `tusunsun.token.${Buffer.from(token, 'utf8').toString('base64url')}`]
    : undefined;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const ws = protocols ? new WebSocket(url, protocols) : new WebSocket(url);

    const settle = (err, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { ws.terminate(); } catch { /* 已关闭 */ }
      if (err) reject(err); else resolve(value);
    };

    timer = setTimeout(
      () => settle(new Error(`等待 ${method} 超时（${timeoutMs}ms，端口 ${port}）`)),
      timeoutMs,
    );
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'req', id: 1, method, params, ...(token ? { token } : {}) }));
    });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; } // 坏帧忽略，由超时兜底
      if (msg.type === 'res' && msg.id === 1) settle(null, msg);
    });
    ws.on('error', (err) => settle(err));
    // 关键分支：对端"没回复就关连"也必须给出可读结果——此前正是缺少这一支导致静默 exit 0。
    ws.on('close', () => settle(new Error(`网关在回复 ${method} 之前关闭了连接（端口 ${port}）`)));
  });
}
