// R0-116：**真实浏览器**安全回归的极简 CDP 客户端（零新增依赖）。
//
// ── 为什么不用 Playwright/Puppeteer ────────────────────────────────────────
// 土行孙的对外承诺是"运行期只有一个依赖 `ws`"。为了一个门禁往 `package.json` 里塞
// 一整套浏览器驱动，代价（供应链、安装体积、`npm install` 失败面）比收益大得多。
// 而"启动 headless Chromium + 走 DevTools 协议"这件事本身只需要两样东西：
//   ① 一个 Chromium 可执行文件（容器/CI 里有就用，没有就 `noteSkip`，不假装通过）；
//   ② 一条 WebSocket —— 这正是已有的 `ws`。
// 所以这里手写一个最小 CDP 客户端（约 150 行），只用 `Target` / `Page` / `Runtime` 三个域。
//
// ── 边界（诚实记录）──────────────────────────────────────────────────────
// · 只验证 **Chromium 系**语义；Firefox/WebKit 的解析差异不在覆盖范围内。
// · 只发送本文件列出的 CDP 命令；不做网络拦截、不做下载、不做多标签并发。
// · 没有可执行文件时**必须**由调用方 `noteSkip`，不得静默当作通过。
import { existsSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
// R0-115：浏览器进程同样走受管 spawn —— 独立进程组 + 统一回收，绝不留下孤儿。
import { spawnManaged } from './proc.mjs';

/** 在常见位置找 Chromium 系可执行文件；找不到返回 null（调用方据此 SKIP）。 */
export function findBrowser() {
  const fromEnv = process.env.TUSUNSUN_CHROME_PATH || process.env.CHROME_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const candidates = [];
  const cacheRoots = [
    join(homedir(), '.cache', 'ms-playwright'),
    join(homedir(), 'Library', 'Caches', 'ms-playwright'),
    process.env.PLAYWRIGHT_BROWSERS_PATH || '',
  ].filter(Boolean);
  for (const root of cacheRoots) {
    if (!existsSync(root)) continue;
    let entries = [];
    try { entries = readdirSync(root); } catch { continue; }
    for (const entry of entries) {
      candidates.push(join(root, entry, 'chrome-headless-shell-linux64', 'chrome-headless-shell'));
      candidates.push(join(root, entry, 'chrome-linux', 'chrome'));
      candidates.push(join(root, entry, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'));
      candidates.push(join(root, entry, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'));
    }
  }
  for (const p of [
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable', '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]) candidates.push(p);
  for (const p of candidates) if (p && existsSync(p)) return p;
  return null;
}

/** 内置 `ws`（vendor/ws）是否可加载；加载不到则浏览器门禁如实 noteSkip。 */
export async function loadWs() {
  try {
    const mod = await import('../../vendor/ws/wrapper.mjs');
    return mod.default || mod;
  } catch {
    return null;
  }
}

/**
 * 启动一个 headless 浏览器并连上 browser 级 WebSocket。
 * @returns {Promise<Browser>} 用完必须 `await close()`（同进程内也会被 proc.mjs 兜底回收）。
 */
export async function launchBrowser({ timeoutMs = 30000, extraArgs = [] } = {}) {
  const exe = findBrowser();
  if (!exe) throw Object.assign(new Error('未找到 Chromium 系可执行文件'), { code: 'no_browser' });
  const WebSocket = await loadWs();
  if (!WebSocket) throw Object.assign(new Error("未安装 `ws`，无法连接 CDP"), { code: 'no_ws' });

  const profileDir = mkdtempSync(join(tmpdir(), 'tusunsun-cdp-'));
  const args = [
    '--headless', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, 'about:blank',
    ...extraArgs,
  ];
  const child = spawnManaged(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`浏览器未在 ${timeoutMs}ms 内报出 DevTools 地址：${buf.slice(-400)}`)), timeoutMs);
    const scan = (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    };
    child.stdout?.on('data', scan);
    child.stderr?.on('data', scan);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`浏览器提前退出 code=${code}`)); });
  }).catch((err) => { child.reap().catch(() => {}); throw err; });

  const browser = new Browser(WebSocket, wsUrl, child, profileDir);
  await browser._connect();
  return browser;
}

/** 极简 CDP 客户端：`Target` / `Page` / `Runtime` 三个域够用。 */
/**
 * 导航失败（`Page.navigate` 的 `errorText`）。带 `errorText` 便于调用方判定
 * "这是环境策略阻断，不是产品缺陷"。
 */
export class NavigationError extends Error {
  constructor(url, errorText) {
    super(`导航失败 ${errorText}（${url}）`);
    this.name = 'NavigationError';
    this.url = url;
    this.errorText = errorText;
  }
}

/**
 * 是不是**环境策略**挡住了导航（企业策略 / 沙箱 / 管理员白名单），而不是站点打不开。
 * 只有明确属于这一类才允许记 NOT_RUN —— 其它错误（连不上、证书、DNS）必须照常失败，
 * 否则"环境"会变成万能的免检理由。
 */
export function isNavigationBlockedByPolicy(err) {
  const code = String((err && err.errorText) || '');
  return /^net::(ERR_BLOCKED_BY_ADMINISTRATOR|ERR_ACCESS_DENIED|ERR_BLOCKED_BY_CLIENT)$/.test(code);
}

export class Browser {
  constructor(WebSocket, wsUrl, child, profileDir) {
    this._WebSocket = WebSocket;
    this._wsUrl = wsUrl;
    this._child = child;
    this._profileDir = profileDir;
    this._seq = 0;
    this._pending = new Map();
    this._events = new Map();
    this._closed = false;
  }

  _connect() {
    return new Promise((resolve, reject) => {
      const ws = new this._WebSocket(this._wsUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
      this._ws = ws;
      const timer = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), 15000);
      ws.on('open', () => { clearTimeout(timer); resolve(); });
      ws.on('error', (err) => { clearTimeout(timer); reject(err); });
      ws.on('message', (data) => this._onMessage(data));
      ws.on('close', () => {
        this._closed = true;
        for (const { reject: rej } of this._pending.values()) rej(new Error('CDP 连接已关闭'));
        this._pending.clear();
      });
    });
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.id !== undefined) {
      const slot = this._pending.get(msg.id);
      if (!slot) return;
      this._pending.delete(msg.id);
      if (msg.error) slot.reject(new Error(`CDP ${slot.method}: ${msg.error.message || JSON.stringify(msg.error)}`));
      else slot.resolve(msg.result);
      return;
    }
    const key = msg.method;
    for (const fn of (this._events.get(key) || [])) fn(msg.params, msg.sessionId);
  }

  /**
   * 发一条 CDP 命令。`sessionId` 为扁平模式下的会话（页级命令必须带）。
   *
   * 每条命令都有**独立超时**（默认 30s）。这不是锦上添花：`Page.reload` 会销毁执行上下文，
   * 此时仍在途的 `Runtime.evaluate` 响应可能永远不来 —— 没有超时的话 promise 永不 settle，
   * 事件环排空后 node 会**静默 exit 0**，门禁看着"通过"其实什么都没验。实测踩到过。
   */
  send(method, params = {}, sessionId = undefined, { timeoutMs = 30000 } = {}) {
    if (this._closed) return Promise.reject(new Error('CDP 连接已关闭'));
    const id = ++this._seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this._pending.has(id)) return;
        this._pending.delete(id);
        reject(new Error(`CDP ${method} 超时（${timeoutMs}ms 无响应；上下文可能已被导航销毁）`));
      }, timeoutMs);
      this._pending.set(id, {
        method,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this._ws.send(JSON.stringify(payload));
    });
  }

  on(method, fn) {
    if (!this._events.has(method)) this._events.set(method, []);
    this._events.get(method).push(fn);
  }

  /** 新建并 attach 一个页面，返回扁平会话 id。 */
  async newPage(url = 'about:blank') {
    const { targetId } = await this.send('Target.createTarget', { url });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    await this.send('Page.enable', {}, sessionId);
    await this.send('Runtime.enable', {}, sessionId);
    return { targetId, sessionId };
  }

  /** 在页面里求值，返回结构化结果（`returnByValue`）。异常会**抛出**，不静默。 */
  async evaluate(sessionId, expression, { awaitPromise = true } = {}) {
    const res = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise, userGesture: true,
    }, sessionId);
    if (res.exceptionDetails) {
      const text = res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'evaluate failed';
      throw new Error(`页面内求值异常：${text}`);
    }
    return res.result?.value;
  }

  /** 等待页面 `document.readyState==='complete'`（不用事件，轮询更抗竞态）。 */
  async waitForReady(sessionId, { timeoutMs = 20000 } = {}) {
    const t0 = Date.now();
    for (;;) {
      const state = await this.evaluate(sessionId, 'document.readyState');
      if (state === 'complete') return;
      if (Date.now() - t0 > timeoutMs) throw new Error('等待页面 readyState=complete 超时');
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async goto(sessionId, url) {
    const r = await this.send('Page.navigate', { url }, sessionId);
    // R0-118：`Page.navigate` 用 **结果里的 errorText** 表示导航失败（不是 CDP error）。
    // 以前忽略它 ⇒ 页面其实还停在 about:blank，后面的等待全都会以"超时"的面貌失败，
    // 看起来像产品 bug。现在原样抛出，让调用方能区分"环境阻断"与"页面真的坏了"。
    if (r && r.errorText) throw new NavigationError(url, r.errorText);
    await this.waitForReady(sessionId);
  }

  async reload(sessionId) {
    const r = await this.send('Page.reload', { ignoreCache: true }, sessionId);
    if (r && r.errorText) throw new NavigationError('reload', r.errorText);
    await this.waitForReady(sessionId);
  }

  /** 轮询页面里的表达式直到为真。 */
  async waitFor(sessionId, expression, { timeoutMs = 20000, what = '条件' } = {}) {
    const t0 = Date.now();
    for (;;) {
      if (await this.evaluate(sessionId, expression)) return;
      if (Date.now() - t0 > timeoutMs) throw new Error(`等待${what}超时（${timeoutMs}ms）：${expression.slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  async close() {
    try { if (this._ws && this._ws.readyState === 1) this._ws.close(); } catch { /* 已断开 */ }
    try { await this._child.reap(); } catch { /* 已回收 */ }
    try { rmSync(this._profileDir, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
  }
}
