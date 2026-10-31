import { randomUUID } from 'node:crypto';

const ESC = '\x1b';
const CSI = `${ESC}[`;

const ansi = {
  reset: `${CSI}0m`, bold: `${CSI}1m`, dim: `${CSI}2m`, underline: `${CSI}4m`,
  blink: `${CSI}5m`, reverse: `${CSI}7m`, noBlink: `${CSI}25m`, noUnderline: `${CSI}24m`,
  hide: `${CSI}?25l`, show: `${CSI}?25h`,
  altScreen: `${CSI}?1049h`, mainScreen: `${CSI}?1049l`,
  home: `${CSI}H`, clear: `${CSI}2J`, clearLine: `${CSI}2K`,
  fg: { black: `${CSI}30m`, red: `${CSI}31m`, green: `${CSI}32m`, yellow: `${CSI}33m`,
    blue: `${CSI}34m`, magenta: `${CSI}35m`, cyan: `${CSI}36m`, white: `${CSI}37m`,
    gray: `${CSI}90m`, brightRed: `${CSI}91m`, brightGreen: `${CSI}92m`,
    brightYellow: `${CSI}93m`, brightBlue: `${CSI}94m`, brightCyan: `${CSI}96m` },
  bg: { black: `${CSI}40m`, red: `${CSI}41m`, green: `${CSI}42m`, yellow: `${CSI}43m`,
    blue: `${CSI}44m`, cyan: `${CSI}46m`, white: `${CSI}47m`, gray: `${CSI}100m` },
};

function cursor(row, col) { return `${CSI}${row};${col}H`; }
function stripAnsi(s) { return s.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\[\?[0-9;]*[a-zA-Z]/g, ''); }
function pad(s, w) { const l = stripAnsi(s).length; return l >= w ? s : s + ' '.repeat(w - l); }
function trunc(s, w) {
  const vis = stripAnsi(s);
  if (vis.length <= w) return s;
  let vc = 0, i = 0;
  while (i < s.length && vc < w - 1) {
    if (s[i] === '\x1b') { while (i < s.length && s[i] !== 'm') i++; i++; }
    else { vc++; i++; }
  }
  return s.slice(0, i) + '…';
}

class WsClient {
  constructor(port, token = null) {
    this.port = port;
    this.token = token || null;
    this.socket = null;
    this.handlers = new Map();
    this.connected = false;
    this._reconnectTimer = null;
    this._closed = false;
    this._reqId = 0;
  }

  async connect() {
    // R0-109/T1：与 `scripts/cli-transport.mjs` 同一个根因 —— 此前这里是裸 TCP + 手搓帧，
    // 没有 RFC 6455 握手，而网关只认 `GET /ws` + Upgrade 头 ⇒ 连接必被 HTTP 解析器断掉，
    // 面板永远连不上（而且断连只走 'close'，调用方拿不到任何结果）。改用内置 `ws`
    // （vendor/ws，R0-117 起随仓，不再从 npm 安装）做标准握手：open 才算连上。
    //
    // R0-118（第四轮报告"TUI 未验收"背后藏着的真缺陷）：这里过去**不带口令**握手。
    // 网关一旦配了 `gateway.apiKey`（R0-113 起 status/stop 的常规形态），`/ws` 升级会被
    // 直接 `socket.end()`，客户端只看到 `socket hang up` ⇒ `tusunsun tui` 在**任何开鉴权的
    // 部署上根本连不上**。`scripts/cli.mjs` 早就把绑定口令的 `wsRequest` 下发给了插件命令，
    // 唯独 TUI 自己另开了一条不带口令的连接。现在与 `cli-transport.wsRequest` 完全同款：
    // 口令走 `Sec-WebSocket-Protocol` 子协议（不进 URL、不进日志、不进 shell 历史）。
    const { WebSocket } = await import('../vendor/ws/wrapper.mjs');
    const protocols = this.token
      ? ['tusunsun.v1', `tusunsun.token.${Buffer.from(this.token, 'utf8').toString('base64url')}`]
      : undefined;
    return new Promise((resolve, reject) => {
      this.socket = protocols
        ? new WebSocket(`ws://127.0.0.1:${this.port}/ws`, protocols)
        : new WebSocket(`ws://127.0.0.1:${this.port}/ws`);
      this.socket.on('open', () => {
        this.connected = true;
        this._closed = false;
        resolve();
      });
      this.socket.on('message', (raw) => this._onData(raw.toString()));
      this.socket.on('error', (err) => {
        this.connected = false;
        reject(err);
      });
      this.socket.on('close', () => {
        this.connected = false;
        if (!this._closed) this._scheduleReconnect();
      });
    });
  }

  _scheduleReconnect() {
    if (this._closed || this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect().catch(() => {});
    }, 3000);
  }

  _onData(text) {
    // `ws` 的 message 事件已经是**完整一帧**，不必再自己拼缓冲、解帧。
    let parsed;
    try { parsed = JSON.parse(text); } catch { return; } // 坏帧忽略
    if (parsed.type === 'event' && parsed.event) {
      const h = this.handlers.get(parsed.event);
      if (h) for (const fn of h) fn(parsed.payload);
    } else if (parsed.type === 'res' && parsed.id != null) {
      const h = this.handlers.get(`_res_${parsed.id}`);
      if (h) { for (const fn of h) fn(parsed); this.handlers.delete(`_res_${parsed.id}`); }
    } else if (parsed.type === 'stream_chunk' && parsed.id != null) {
      const h = this.handlers.get(`_chunk_${parsed.id}`);
      if (h) for (const fn of h) fn(parsed.content);
    }
  }

  request(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.connected) return reject(new Error('Not connected'));
      const id = ++this._reqId;
      this.handlers.set(`_res_${id}`, [resolve]);
      this.socket.send(JSON.stringify({ type: 'req', id, method, params }));
      setTimeout(() => { this.handlers.delete(`_res_${id}`); reject(new Error('Timeout')); }, 10000);
    });
  }

  requestStream(method, params, onChunk) {
    return new Promise((resolve, reject) => {
      if (!this.connected) return reject(new Error('Not connected'));
      const id = ++this._reqId;
      this.handlers.set(`_chunk_${id}`, [onChunk]);
      this.handlers.set(`_res_${id}`, [(res) => { this.handlers.delete(`_chunk_${id}`); resolve(res); }]);
      this.socket.send(JSON.stringify({ type: 'req', id, method, params: { ...params, stream: true } }));
      setTimeout(() => {
        this.handlers.delete(`_chunk_${id}`); this.handlers.delete(`_res_${id}`);
        reject(new Error('Timeout'));
      }, 120000);
    });
  }

  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(fn);
  }

  close() {
    // 显式关闭后不再自动重连：此前 `destroy()` 触发的 'close' 会立刻把连接拉回来。
    this._closed = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this.socket) { try { this.socket.close(); } catch { /* 已关 */ } this.socket = null; }
    this.connected = false;
  }
}

class ScreenManager {
  constructor() {
    this.cols = process.stdout.columns || 80;
    this.rows = process.stdout.rows || 24;
    this._dirty = new Set(['all']);
    this._renderFn = null;
    this._renderTimer = null;
    this._logBuffer = [];
    this._maxLogs = 100;
  }

  start(renderFn) {
    this._renderFn = renderFn;
    process.stdout.write(ansi.altScreen + ansi.hide);
    process.stdout.write(ansi.clear + ansi.home);
    process.on('resize', () => {
      this.cols = process.stdout.columns || 80;
      this.rows = process.stdout.rows || 24;
      this.markDirty('all');
    });
    this._renderTimer = setInterval(() => { if (this._dirty.size > 0) this._render(); }, 50);
  }

  stop() {
    if (this._renderTimer) { clearInterval(this._renderTimer); this._renderTimer = null; }
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(ansi.show + ansi.mainScreen + ansi.reset);
  }

  markDirty(region) { this._dirty.add(region); }

  addLog(level, msg) {
    const time = new Date().toLocaleTimeString('en-GB');
    this._logBuffer.push({ time, level, msg });
    if (this._logBuffer.length > this._maxLogs) this._logBuffer.shift();
    this.markDirty('log');
  }

  _render() {
    this._dirty.clear();
    if (this._renderFn) this._renderFn();
  }

  out(s) { process.stdout.write(s); }
  at(row, col, s) { process.stdout.write(cursor(row, col) + s); }
  clearLine(row) { process.stdout.write(cursor(row, 1) + ansi.clearLine); }

  drawBox(row, col, width, height, title) {
    const t = title ? `─ ${title} ` : '';
    const padLen = Math.max(0, width - 2 - t.length);
    this.at(row, col, `${ansi.fg.cyan}┌${t}${'─'.repeat(padLen)}┐${ansi.reset}`);
    for (let i = 1; i < height - 1; i++) {
      this.at(row + i, col, `${ansi.fg.cyan}│${' '.repeat(width - 2)}│${ansi.reset}`);
    }
    this.at(row + height - 1, col, `${ansi.fg.cyan}${'└' + '─'.repeat(width - 2) + '┘'}${ansi.reset}`);
  }

  drawFooter(row, items) {
    const text = items.join('  ');
    const padded = pad(trunc(text, this.cols), this.cols);
    this.at(row, 1, `${ansi.bg.gray}${ansi.fg.brightCyan}${padded}${ansi.reset}`);
  }
}

class MonitorView {
  constructor(screen, ws) { this.screen = screen; this.ws = ws; this.status = null; this.memUsage = null; }

  async refresh() {
    try {
      const res = await this.ws.request('core.status');
      if (res.ok) this.status = res.payload;
    } catch { /* 轮询刷新失败保留旧值 */ }
    this.memUsage = process.memoryUsage();
    this.screen.markDirty('monitor');
  }

  render() {
    const { cols, rows } = this.screen;
    const w = cols;
    const h = rows;
    this.screen.drawBox(1, 1, w, h - 2, `土行孙 TUI`);

    if (this.status) {
      this._renderMonitorStatus(w, h);
    } else {
      this.screen.at(3, 3, `${ansi.fg.yellow}Connecting...${ansi.reset}`);
    }

    this._renderMonitorFooter(h);
  }

  _renderMonitorStatus(w, h) {
    const st = this.status;
    const running = st.running ? `${ansi.fg.green}● running${ansi.reset}` : `${ansi.fg.red}○ stopped${ansi.reset}`;
    const mem = this.memUsage ? `${Math.round(this.memUsage.rss / 1024 / 1024)}MB` : '—';
    this.screen.at(2, 3, `${running}  uptime ${st.uptime}  plugins ${st.plugins.length}  mem ${mem}`);

    const midX = Math.floor(w / 2) + 1;
    const listH = h - 6;
    this.screen.at(3, 3, `${ansi.bold}${ansi.fg.brightYellow}Plugins${ansi.reset}`);
    this.screen.at(3, midX, `${ansi.bold}${ansi.fg.brightYellow}Events${ansi.reset}`);

    for (let r = 4; r < 4 + listH; r++) {
      this.screen.at(r, midX - 1, `${ansi.fg.cyan}│${ansi.reset}`);
    }

    for (let i = 0; i < Math.min(st.plugins.length, listH); i++) {
      const p = st.plugins[i];
      const dot = p.state === 'running' ? `${ansi.fg.green}●${ansi.reset}` : `${ansi.fg.gray}○${ansi.reset}`;
      this.screen.at(4 + i, 3, `${dot} ${pad(trunc(p.name, 16), 16)} ${pad(p.version || '—', 8)} ${pad(p.state || '—', 10)}`);
    }

    const logs = this.screen._logBuffer.slice(-listH);
    for (let i = 0; i < Math.min(logs.length, listH); i++) {
      const l = logs[i];
      const lvlColor = l.level === 'error' ? ansi.fg.red : l.level === 'warn' ? ansi.fg.yellow : ansi.fg.gray;
      this.screen.at(4 + i, midX + 1, `${ansi.fg.gray}[${l.time}]${ansi.reset} ${lvlColor}${trunc(l.msg, w - midX - 14)}${ansi.reset}`);
    }
  }

  _renderMonitorFooter(h) {
    this.screen.drawFooter(h - 1, [
      `${ansi.fg.brightCyan}[1]${ansi.reset}监控`, `${ansi.fg.brightCyan}[2]${ansi.reset}插件`,
      `${ansi.fg.brightCyan}[3]${ansi.reset}场景`, `${ansi.fg.brightCyan}[4]${ansi.reset}配置`,
      `${ansi.fg.brightCyan}[5]${ansi.reset}聊天`, `${ansi.fg.brightRed}[q]${ansi.reset}退出`,
      `  ${ansi.fg.gray}↑↓滚动${ansi.reset}`,
    ]);
  }
}

class PluginView {
  constructor(screen, ws) { this.screen = screen; this.ws = ws; this.plugins = []; this.cursor = 0; this.scrollOffset = 0; }

  async refresh() {
    try {
      const res = await this.ws.request('core.status');
      if (res.ok) this.plugins = res.payload.plugins || [];
    } catch { /* 轮询刷新失败保留旧值 */ }
    this.screen.markDirty('plugin');
  }

  render() {
    const { cols, rows } = this.screen;
    const w = cols; const h = rows;
    this.screen.drawBox(1, 1, w, h - 2, '插件管理');

    const header = `${ansi.bold}${pad('名称', 18)}${pad('版本', 10)}${pad('状态', 12)}${ansi.reset}`;
    this.screen.at(2, 3, header);
    this.screen.at(3, 3, `${ansi.fg.gray}${'─'.repeat(w - 6)}${ansi.reset}`);

    const maxRows = h - 6;
    if (this.cursor >= this.plugins.length) this.cursor = Math.max(0, this.plugins.length - 1);
    if (this.cursor < this.scrollOffset) this.scrollOffset = this.cursor;
    if (this.cursor >= this.scrollOffset + maxRows) this.scrollOffset = this.cursor - maxRows + 1;

    const visible = this.plugins.slice(this.scrollOffset, this.scrollOffset + maxRows);
    for (let i = 0; i < visible.length; i++) {
      const p = visible[i];
      const row = 4 + i;
      const idx = this.scrollOffset + i;
      const sel = idx === this.cursor ? `${ansi.reverse}` : '';
      const rst = idx === this.cursor ? ansi.reset : '';
      const dot = p.state === 'running' ? `${ansi.fg.green}●${ansi.reset}` : `${ansi.fg.gray}○${ansi.reset}`;
      this.screen.at(row, 3, `${sel}${dot} ${pad(trunc(p.name, 16), 16)}${pad(p.version || '—', 10)}${pad(p.state || '—', 12)}${rst}`);
    }

    this.screen.drawFooter(h - 1, [
      `${ansi.fg.brightCyan}[↑↓]${ansi.reset}移动`,
      `${ansi.fg.brightCyan}[r]${ansi.reset}重载`,
      `${ansi.fg.brightCyan}[s]${ansi.reset}启停`,
      `${ansi.fg.brightCyan}[←]${ansi.reset}返回`,
    ]);
  }

  async handleKey(key) {
    if (key === 'up' && this.cursor > 0) this.cursor--;
    else if (key === 'down' && this.cursor < this.plugins.length - 1) this.cursor++;
    else if (key === 'r' && this.plugins[this.cursor]) {
      const name = this.plugins[this.cursor].name;
      try {
        await this.ws.request('plugin.reload', { name });
        this.screen.addLog('info', `Reloaded: ${name}`);
        await this.refresh();
      } catch (e) { this.screen.addLog('error', `Reload failed: ${e.message}`); }
    }
    this.screen.markDirty('plugin');
  }
}

class SceneView {
  constructor(screen, ws) { this.screen = screen; this.ws = ws; this.scenes = []; this.current = ''; this.cursor = 0; }

  async refresh() {
    try {
      const res = await this.ws.request('scene.list');
      if (res.ok) {
        this.scenes = res.payload?.scenes || res.payload || [];
        this.current = res.payload?.current || '';
      }
    } catch { /* 轮询刷新失败保留旧值 */ }
    this.screen.markDirty('scene');
  }

  render() {
    const { cols, rows } = this.screen;
    const w = cols; const h = rows;
    this.screen.drawBox(1, 1, w, h - 2, '场景管理');

    if (this.current) this.screen.at(2, 3, `当前场景: ${ansi.fg.green}${ansi.bold}${this.current}${ansi.reset}`);

    for (let i = 0; i < this.scenes.length; i++) {
      const s = this.scenes[i];
      const name = typeof s === 'string' ? s : s.name;
      const isCurrent = name === this.current;
      const sel = i === this.cursor ? ansi.reverse : '';
      const rst = i === this.cursor ? ansi.reset : '';
      const dot = isCurrent ? `${ansi.fg.green}●${ansi.reset}` : `${ansi.fg.gray}○${ansi.reset}`;
      this.screen.at(4 + i, 3, `${sel}${dot} ${pad(trunc(name, 30), 30)}${rst}`);
    }

    this.screen.drawFooter(h - 1, [
      `${ansi.fg.brightCyan}[↑↓]${ansi.reset}移动`,
      `${ansi.fg.brightCyan}[s]${ansi.reset}切换`,
      `${ansi.fg.brightCyan}[←]${ansi.reset}返回`,
    ]);
  }

  async handleKey(key) {
    if (key === 'up' && this.cursor > 0) this.cursor--;
    else if (key === 'down' && this.cursor < this.scenes.length - 1) this.cursor++;
    else if (key === 's' && this.scenes[this.cursor]) {
      const name = typeof this.scenes[this.cursor] === 'string' ? this.scenes[this.cursor] : this.scenes[this.cursor].name;
      try {
        await this.ws.request('scene.switch', { name, yes: true });
        this.screen.addLog('info', `Switched to: ${name}`);
        this.current = name;
        await this.refresh();
      } catch (e) { this.screen.addLog('error', `Switch failed: ${e.message}`); }
    }
    this.screen.markDirty('scene');
  }
}

class ConfigView {
  constructor(screen, ws) { this.screen = screen; this.ws = ws; this.items = []; this.cursor = 0; this.scrollOffset = 0; }

  async refresh() {
    try {
      const res = await this.ws.request('config.get');
      if (res.ok) this.items = this._flatten(res.payload || {});
    } catch { /* 轮询刷新失败保留旧值 */ }
    this.screen.markDirty('config');
  }

  _flatten(obj, prefix = '') {
    const result = [];
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) result.push(...this._flatten(v, path));
      else result.push({ path, value: v });
    }
    return result;
  }

  render() {
    const { cols, rows } = this.screen;
    const w = cols; const h = rows;
    this.screen.drawBox(1, 1, w, h - 2, '配置管理');

    const maxRows = h - 5;
    if (this.cursor >= this.items.length) this.cursor = Math.max(0, this.items.length - 1);
    if (this.cursor < this.scrollOffset) this.scrollOffset = this.cursor;
    if (this.cursor >= this.scrollOffset + maxRows) this.scrollOffset = this.cursor - maxRows + 1;

    const visible = this.items.slice(this.scrollOffset, this.scrollOffset + maxRows);
    for (let i = 0; i < visible.length; i++) {
      const item = visible[i];
      const row = 2 + i;
      const idx = this.scrollOffset + i;
      const sel = idx === this.cursor ? ansi.reverse : '';
      const rst = idx === this.cursor ? ansi.reset : '';
      const val = item.value == null ? `${ansi.fg.gray}null${ansi.reset}` : String(item.value);
      this.screen.at(row, 3, `${sel}${ansi.fg.cyan}${pad(trunc(item.path, 28), 28)}${ansi.reset} ${trunc(val, w - 34)}${rst}`);
    }

    this.screen.drawFooter(h - 1, [
      `${ansi.fg.brightCyan}[↑↓]${ansi.reset}移动`,
      `${ansi.fg.brightCyan}[e]${ansi.reset}编辑`,
      `${ansi.fg.brightCyan}[←]${ansi.reset}返回`,
    ]);
  }

  handleKey(key) {
    if (key === 'up' && this.cursor > 0) this.cursor--;
    else if (key === 'down' && this.cursor < this.items.length - 1) this.cursor++;
    this.screen.markDirty('config');
  }
}

class ChatView {
  constructor(screen, ws) {
    this.screen = screen; this.ws = ws;
    this.messages = []; this.input = ''; this.cursorPos = 0;
    this.sessionId = `tui_${randomUUID().slice(0, 8)}`;
    this.streaming = false; this.streamBuffer = '';
    this.toolCalls = []; this.scrollOffset = 0;
    this._historyIdx = -1; this._inputHistory = [];
  }

  async init() {
    this.ws.on('chat.stream.reasoning', (data) => {
      if (data.sessionId !== this.sessionId) return;
      this.screen.markDirty('chat');
    });
    this.ws.on('tool.progress', (data) => {
      this.toolCalls.push({ name: data.name || 'tool', status: data.status || 'running', ts: Date.now() });
      this.screen.markDirty('chat');
    });
  }

  render() {
    const { cols, rows } = this.screen;
    const w = cols; const h = rows;
    const inputH = 3;
    const contentH = h - inputH - 2;

    this.screen.drawBox(1, 1, w, contentH + 1, `聊天 (${this.sessionId})`);

    const displayMsgs = this._buildChatMessages();
    const maxVisible = contentH - 1;
    if (displayMsgs.length > maxVisible) this.scrollOffset = Math.max(0, displayMsgs.length - maxVisible);
    else this.scrollOffset = 0;

    const visible = displayMsgs.slice(this.scrollOffset, this.scrollOffset + maxVisible);
    for (let i = 0; i < visible.length; i++) {
      this.screen.clearLine(2 + i);
      this.screen.at(2 + i, 3, trunc(visible[i].text, w - 4));
    }

    this._renderChatInput(contentH, w);
    this._renderChatFooter(h);
  }

  _buildChatMessages() {
    const displayMsgs = [];
    for (const m of this.messages) {
      const role = m.role === 'user' ? `${ansi.fg.green}你${ansi.reset}` : `${ansi.fg.brightCyan}土行孙${ansi.reset}`;
      displayMsgs.push({ type: 'header', text: `${role}:` });
      for (const line of (m.content || '').split('\n')) displayMsgs.push({ type: 'body', text: line });
      displayMsgs.push({ type: 'spacer', text: '' });
    }
    if (this.streaming && this.streamBuffer) {
      displayMsgs.push({ type: 'header', text: `${ansi.fg.brightCyan}土行孙:${ansi.reset} ${ansi.fg.gray}(streaming...)${ansi.reset}` });
      for (const line of this.streamBuffer.split('\n')) displayMsgs.push({ type: 'body', text: line });
    }
    for (const tc of this.toolCalls.slice(-5)) {
      const icon = tc.status === 'done' ? `${ansi.fg.green}✓${ansi.reset}` : `${ansi.fg.yellow}⟳${ansi.reset}`;
      displayMsgs.push({ type: 'tool', text: `${icon} ${tc.name} (${tc.status})` });
    }
    return displayMsgs;
  }

  _renderChatInput(contentH, w) {
    const inputRow = contentH + 2;
    this.screen.at(inputRow - 1, 1, `${ansi.fg.cyan}${'─'.repeat(w)}${ansi.reset}`);
    this.screen.at(inputRow, 3, `${ansi.fg.brightGreen}> ${ansi.reset}${this.input} `);
    process.stdout.write(cursor(inputRow, 5 + this.cursorPos));
  }

  _renderChatFooter(h) {
    this.screen.drawFooter(h - 1, [
      `${ansi.fg.brightCyan}[Enter]${ansi.reset}发送`,
      `${ansi.fg.brightCyan}[n]${ansi.reset}新会话`,
      `${ansi.fg.brightCyan}[↑↓]${ansi.reset}历史`,
      `${ansi.fg.brightCyan}[←]${ansi.reset}返回`,
    ]);
  }

  async sendMessage() {
    const msg = this.input.trim();
    if (!msg || this.streaming) return;
    this._inputHistory.push(msg);
    this._historyIdx = -1;
    this.messages.push({ role: 'user', content: msg });
    this.input = ''; this.cursorPos = 0;
    this.streamBuffer = ''; this.toolCalls = [];
    this.streaming = true;
    this.screen.markDirty('chat');

    try {
      const res = await this.ws.requestStream('agent.chat', { message: msg, sessionId: this.sessionId }, (chunk) => {
        if (typeof chunk === 'string') this.streamBuffer += chunk;
        else if (chunk?.content) this.streamBuffer += chunk.content;
        this.screen.markDirty('chat');
      });
      const reply = res.payload?.reply || this.streamBuffer || '';
      this.messages.push({ role: 'assistant', content: reply || '(no response)' });
    } catch (e) {
      this.messages.push({ role: 'assistant', content: `${ansi.fg.red}Error: ${e.message}${ansi.reset}` });
    }
    this.streamBuffer = '';
    this.streaming = false;
    this.screen.markDirty('chat');
  }

  handleKey(key, char) {
    if (key === 'return') { this.sendMessage(); return; }
    if (key === 'backspace') {
      if (this.cursorPos > 0) {
        this.input = this.input.slice(0, this.cursorPos - 1) + this.input.slice(this.cursorPos);
        this.cursorPos--;
      }
    } else if (key === 'left') { if (this.cursorPos > 0) this.cursorPos--; }
    else if (key === 'right') { if (this.cursorPos < this.input.length) this.cursorPos++; }
    else if (key === 'up') {
      if (this._inputHistory.length > 0) {
        if (this._historyIdx < 0) this._historyIdx = this._inputHistory.length - 1;
        else if (this._historyIdx > 0) this._historyIdx--;
        this.input = this._inputHistory[this._historyIdx] || '';
        this.cursorPos = this.input.length;
      }
    } else if (key === 'down') {
      if (this._historyIdx >= 0) {
        this._historyIdx++;
        if (this._historyIdx >= this._inputHistory.length) { this._historyIdx = -1; this.input = ''; }
        else this.input = this._inputHistory[this._historyIdx] || '';
        this.cursorPos = this.input.length;
      }
    } else if (char && char.length === 1 && !char.match(/[\x00-\x1f]/)) {
      this.input = this.input.slice(0, this.cursorPos) + char + this.input.slice(this.cursorPos);
      this.cursorPos++;
    }
    this.screen.markDirty('chat');
  }
}

class TUIApp {
  constructor(port, token = null) {
    this.ws = new WsClient(port, token);
    this.screen = new ScreenManager();
    this.views = {};
    this.currentView = 'monitor';
    this._pollTimers = [];
  }

  async run() {
    try {
      await this.ws.connect();
    } catch (err) {
      process.stderr.write(`\x1b[31m无法连接 daemon (端口 ${this.ws.port}): ${err.message}\x1b[0m\n`);
      process.stderr.write(`请先运行: tusunsun start\n`);
      process.exit(1);
    }

    this.views.monitor = new MonitorView(this.screen, this.ws);
    this.views.plugin = new PluginView(this.screen, this.ws);
    this.views.scene = new SceneView(this.screen, this.ws);
    this.views.config = new ConfigView(this.screen, this.ws);
    this.views.chat = new ChatView(this.screen, this.ws);
    await this.views.chat.init();

    this._setupEvents();
    this._setupExit();

    this.screen.start(() => this._renderCurrentView());

    this.views.monitor.refresh();
    this._pollTimers.push(setInterval(() => {
      if (this.currentView === 'monitor') this.views.monitor.refresh();
      else if (this.currentView === 'plugin') this.views.plugin.refresh();
      else if (this.currentView === 'scene') this.views.scene.refresh();
      else if (this.currentView === 'config') this.views.config.refresh();
    }, 2000));

    this._startInput();
  }

  _setupEvents() {
    const logEvents = [
      'core:plugin.loaded', 'core:plugin.unloading', 'plugin.init_failed',
      'tool.registered', 'tool.execute', 'tool.result',
      'scene.switched', 'config.reloaded',
      'health.ok', 'health.fail', 'health.critical',
    ];
    for (const evt of logEvents) {
      this.ws.on(evt, (data) => {
        const short = typeof data === 'object' ? (data.pluginName || data.name || data.to || evt) : String(data);
        this.screen.addLog('info', `${evt}: ${short}`);
      });
    }
    this.ws.on('chat.stream.chunk', (data) => { this.screen.addLog('info', `stream chunk (${(data.delta || data.content || '').length} chars)`); });
    this.ws.on('tool.progress', (data) => { this.screen.addLog('info', `tool: ${data.name} ${data.status}`); });
  }

  _setupExit() {
    const restore = () => {
      for (const t of this._pollTimers) clearInterval(t);
      this._pollTimers.length = 0;
      this.screen.stop();
      this.ws.close();
    };
    process.on('exit', restore);
    process.on('SIGINT', () => { restore(); process.exit(0); });
    process.on('SIGTERM', () => { restore(); process.exit(0); });
    process.on('uncaughtException', (err) => { restore(); console.error(err); process.exit(1); });
  }

  _renderCurrentView() {
    process.stdout.write(ansi.clear + ansi.home);
    const view = this.views[this.currentView];
    if (view) view.render();
  }

  _startInput() {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.resume();

    let escBuf = '';
    let escTimer = null;
    const flushEsc = () => {
      if (escBuf) { this._handleKey('escape'); escBuf = ''; }
      escTimer = null;
    };
    process.stdin.on('data', (data) => {
      for (let i = 0; i < data.length; i++) {
        const ch = data[i];
        if (ch === '\x1b') {
          if (escTimer) clearTimeout(escTimer);
          escBuf = '\x1b';
          escTimer = setTimeout(flushEsc, 50);
          continue;
        }
        if (escBuf) {
          if (escTimer) { clearTimeout(escTimer); escTimer = null; }
          escBuf += ch;
          if (escBuf === '\x1b[') continue;
          if (escBuf.length >= 3) {
            const seq = escBuf;
            escBuf = '';
            if (seq === '\x1b[A') this._handleKey('up');
            else if (seq === '\x1b[B') this._handleKey('down');
            else if (seq === '\x1b[C') this._handleKey('right');
            else if (seq === '\x1b[D') this._handleKey('left');
          }
          continue;
        }
        escBuf = '';
        if (ch === '\x03') { process.emit('SIGINT'); return; }
        if (ch === '\x7f' || ch === '\x08') { this._handleKey('backspace'); continue; }
        if (ch === '\r' || ch === '\n') { this._handleKey('return'); continue; }
        this._handleKey(null, ch);
      }
    });
  }

  _handleKey(key, char) {
    // R0-118（第四轮"TUI 未验收"背后藏着的第二个真缺陷）：
    // `_startInput()` 对普通字符调用的是 `_handleKey(null, ch)`（chat 视图需要 char 原文），
    // 而下面的命令判定全部在比 `key === 'q' / '1'…'5' / 'n'` —— 于是**键盘上的单键命令一条都不生效**：
    // 按 q 退不出去、1~5 切不了视图、n 开不了新会话。面板能渲染，但是没有一处能用键盘操作。
    // 现在把"普通字符"统一提升为命令键 `cmd`（char 仍原样保留给 chat 视图）。
    const cmd = key ?? (typeof char === 'string' && char.length === 1 ? char : null);
    const inChat = this.currentView === 'chat';
    // chat 视图里，除视图切换键、escape、n（新会话）之外的**可打印字符**都进输入框。
    // 特别地：`q` 在 chat 视图里是**普通字母**，不是退出（否则消息里打不出 q —— 那是拿功能换命令）。
    if (inChat && cmd !== '1' && cmd !== '2' && cmd !== '3' && cmd !== '4' && cmd !== '5'
        && cmd !== 'escape' && cmd !== 'n') {
      this.views.chat.handleKey(key, char);
      return;
    }

    if (cmd === 'q') { process.emit('SIGINT'); return; }
    if (cmd === 'n' && inChat) {
      this.views.chat.sessionId = `tui_${randomUUID().slice(0, 8)}`;
      this.views.chat.messages = [];
      this.views.chat.streamBuffer = '';
      this.views.chat.toolCalls = [];
      this.screen.markDirty('chat');
      return;
    }
    if (cmd === '1') this._switchView('monitor');
    else if (cmd === '2') { this.views.plugin.refresh(); this._switchView('plugin'); }
    else if (cmd === '3') { this.views.scene.refresh(); this._switchView('scene'); }
    else if (cmd === '4') { this.views.config.refresh(); this._switchView('config'); }
    else if (cmd === '5') this._switchView('chat');
    else if (cmd === 'escape' || cmd === 'backspace') this._switchView('monitor');
    else if (this.currentView === 'plugin') this.views.plugin.handleKey(cmd);
    else if (this.currentView === 'scene') this.views.scene.handleKey(cmd);
    else if (this.currentView === 'config') this.views.config.handleKey(cmd);
  }

  _switchView(name) {
    this.currentView = name;
    this.screen.markDirty('all');
    this._renderCurrentView();
  }
}

// 注意：本文件**不是插件**（没有 name/init，不进任何场景的 plugins 列表）——它是 CLI 命令提供者，
// 由 `scripts/cli.mjs` 扫描装配根（v0.9.25 起只有 `plugins/` 一处）时注册为 `tusunsun tui`（R0-103 #2）。
// 端口与其它命令同源：调用方注入已解析的网关端口，兜底 9002（R0-103 #4）。
export const cliCommands = [{
  name: 'tui',
  description: '启动终端 TUI 面板（监控 + 管理 + 聊天）',
  // R0-118：口令由 `scripts/cli.mjs` 统一解析后注入（与 status/stop 同源：
  // env `TUSUNSUN_GATEWAY_KEY` > 配置文件 `gateway.apiKey`），TUI 不再自己发明一套。
  handler: async ({ port, token }) => {
    const app = new TUIApp(port ?? 9002, token ?? null);
    await app.run();
  },
}];
