// R0-116（P0-01）：CSP nonce 需要密码学随机源；`node:crypto` 是内置模块，不增加依赖。
import { randomBytes } from 'node:crypto';

class ChatUIPlugin {
  name = 'chat-ui';
  version = '0.2.0';
  requires = { 'gateway': '>=0.3.0' };
  provides = [
    { name: 'route./', type: 'capability' },
    { name: 'route./chat', type: 'capability' },
    { name: 'route./api/config', type: 'capability' },
  ];

  async init(core) {
    this.core = core;
  }

  async start() {
    const gw = this.core.plugins.get('gateway');
    if (gw?.addHandler) {
      gw.addHandler('GET', '/', (req, res) => this._serveChat(req, res));
      gw.addHandler('GET', '/chat', (req, res) => this._serveChat(req, res));
      gw.addHandler('GET', '/api/config', (req, res) => this._handleConfigGet(req, res));
      gw.addHandler('POST', '/api/config', (req, res) => this._handleConfigPost(req, res));
      gw.addHandler('POST', '/api/context/compact', (req, res) => this._handleCompact(req, res));
          } else {
      this.core.log('warn', 'chat-ui: gateway has no addHandler, skipped');
    }
    const config = this.core.getService('config');
    const host = config?.get('gateway.host') || '0.0.0.0';
    const port = this.core.getService('gateway')?.port ?? config?.get('gateway.port') ?? 9002;
    const displayHost = host === '0.0.0.0' ? 'localhost' : host;
    // R0-103（#4 连带）：优先报网关**实际绑定**端口；`port: 0` 时端口由内核分配，
    // 尚未 listen 就不要编造 9002（旧写法 `|| 9002` 在自定义端口下会打印错误 URL）。
    const uiAuth = config?.get('gateway.apiKey');
    // R0-114（P2-01）：URL 里带凭证会进浏览器历史、代理日志、Referer。故**不再**把它当推荐路径：
    // 页面优先用登录框（口令只存在 sessionStorage，随标签页关闭而消失）；`?token=` 仅作兼容。
    if (port) this.core.log('info', `Chat UI available at http://${displayHost}:${port}/`);
    else this.core.log('info', `Chat UI available on ${displayHost}（端口由内核分配，见 gateway 日志）`);
    if (uiAuth) this.core.log('info', '  本实例已启用 gateway.apiKey：打开页面后输入该口令即可（存于 sessionStorage，不进 URL/历史）；'
      + '控制面（/api/*）未带凭证一律 401。`?token=` 仍兼容但已不推荐（会留在浏览器历史里）。');
  }

  _handleConfigGet(req, res) {
    const config = this.core.getService('config');
    const model = config?.data?.model || {};
    const apiKey = model.apiKey;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const ctxMax = config?.get('context.maxTokens') || 8000;
    res.end(JSON.stringify({
      model: model.model || 'gpt-4o-mini',
      baseUrl: model.baseUrl || 'https://api.openai.com/v1',
      apiKey: apiKey ? `sk-...${apiKey.slice(-4)}` : null,
      configured: !!apiKey,
      maxTokens: ctxMax,
    }));
  }

  async _handleConfigPost(req, res) {
    let body = '';
    req.on('data', (chunk) => body += chunk);
    req.on('end', async () => {
      try {
        const { model, baseUrl, apiKey, maxTokens } = JSON.parse(body);
        const config = this.core.getService('config');
        if (model) config.set('model.model', model);
        if (baseUrl) config.set('model.baseUrl', baseUrl);
        if (apiKey && apiKey !== '') config.set('model.apiKey', apiKey);
        if (maxTokens) config.set('context.maxTokens', Number(maxTokens));
        await config.save();
        this.core.log('info', 'Config updated via chat-ui');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
  }

  
  async _handleCompact(req, res) {
    let body = '';
    req.on('data', (chunk) => body += chunk);
    req.on('end', async () => {
      try {
        const { sessionId } = JSON.parse(body);
        if (!sessionId) { res.writeHead(400); res.end(JSON.stringify({ error: 'sessionId required' })); return; }

        const session = this.core.getService('session');
        let ctx = this.core.getService('context');
        if (!ctx) {
          const hook = this.core.getData('_lazyHook');
          if (typeof hook === 'function') await hook('context-manager');
          ctx = this.core.getService('context');
        }
        if (!ctx) { res.writeHead(503); res.end(JSON.stringify({ error: 'context manager not available' })); return; }

        const tools = this.core.getService('tool-registry')?.list() || [];
        const history = await session?.loadSession?.(sessionId) || [];
        if (!history.length) { res.end(JSON.stringify({ ok: true, compressed: false, reason: 'empty' })); return; }

        const systemPrompt = this.core.get('agent.systemPrompt') || '';
        const systemMsg = { role: 'system', content: systemPrompt };
        // R0-123：**不许**临时改写 ctx.maxTokens / ctx.strategy —— 那是共享对象上的全局开关，
        // 另一个会话在同一时刻裁剪时就会用上这里的 800 token 预算 + 摘要策略（实测可复现）。
        // 改成按调用传参，压缩只影响这一次、只影响这个会话。
        const trimmed = await ctx.trimMessages([systemMsg, ...history], systemPrompt, tools,
          { sessionId, maxTokens: 800, strategy: 'summarize' });

        const newHistory = trimmed.filter(m => m.role !== 'system');
        await session?.saveHistory?.(sessionId, newHistory);

        const usage = ctx.getUsage?.(newHistory, tools) || {};
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, compressed: true, tokenUsage: usage }));
      } catch (err) {
        this.core.log('warn', `compact error: ${err.message}`);
        // R0-114（P0-01）：会话标识非法是**调用方错误**（400 + 具名 code），不是服务端故障。
        // 契约错误一律原样透出 code，UI 才能给出"这个会话名不合法"而不是"压缩失败"。
        const status = err.contractError ? 400 : 500;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message, ...(err.code ? { code: err.code } : {}) }));
      }
    });
  }

  _serveChat(req, res) {
    // R0-116（P0-01）第二道防线：CSP。**它不是应用层净化的替代品**——本插件已做到
    // "不可信数据绝不拼 HTML"（见 renderMarkdown/appendTodoList/renderPrompt，且本文件
    // `innerHTML` 出现次数被随包用例钉为 0）。之所以仍要加：
    //   ① `script-src 'nonce-…'` **不含** `'unsafe-inline'` ⇒ 内联事件处理属性（`onerror=`
    //      以及注入的 `<script>`）整体不可执行。即使将来有人把某个 sink 改回字符串拼接，
    //      攻击载荷也**不会执行**，只会变成一个不生效的属性；
    //   ② `default-src 'none'` 关掉一切未显式声明的加载面，`object-src`/`frame-ancestors`
    //      关掉插件嵌入与点击劫持。
    // nonce 每请求重新生成（不缓存）：`Cache-Control: no-store` 已在下方设置。
    const nonce = randomBytes(16).toString('base64');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; `
        + "style-src 'unsafe-inline'; img-src 'self' http: https:; connect-src 'self' ws: wss:; "
        + "base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(String.raw`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>土行孙</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font: 14px/1.6 "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: #2c2c34; color: #d0d0d8; display: flex; min-height: 100vh; }
#left-panel { width: 400px; height: 100vh; background: #252530; border-right: 1px solid #3e3e4a;
  display: flex; flex-direction: column; flex-shrink: 0; overflow: hidden; }
#prompt-viewer { flex: 1; overflow-y: auto; padding: 12px; border-bottom: 1px solid #3e3e4a; }
#prompt-viewer-header { color: #b87a7a; font-size: 13px; margin-bottom: 8px; font-weight: bold; }
#prompt-content { font-size: 12px; color: #b0b0b8; white-space: pre-wrap; word-break: break-word; }
#prompt-content .role-tag { color: #7a9a8a; font-weight: bold; margin: 8px 0 4px; }
#prompt-content .role-tag.system { color: #b87a7a; }
#prompt-content .role-tag.user { color: #7a9a8a; }
#prompt-content .role-tag.assistant { color: #8a8a96; }
#prompt-content .role-tag.tool { color: #c4a87a; }
/* R0-116（P0-01）：这些原本是内联 style="" 属性，随 innerHTML 字符串一起拼出来。
   改成类名后，renderPrompt 可以**只用 DOM 构造**——而属性白名单里没有 style，
   于是"从数据里注入样式/事件"这条路在结构上被关掉。 */
#prompt-content .prompt-pre { margin: 4px 0 12px; padding: 8px; background: #262630; color: #a0b0c0;
  font-size: 11px; max-height: 200px; overflow-y: auto; white-space: pre-wrap; word-break: break-word; }
#prompt-content .prompt-details { margin-top: 8px; }
#prompt-content .prompt-summary { cursor: pointer; color: #7a9a8a; font-size: 12px; font-weight: bold; }
#prompt-content .prompt-details.plain > .prompt-summary { color: #6a6a76; font-weight: normal; }
#prompt-content .prompt-tool { margin: 4px 0 8px; padding: 6px 8px; background: #2e2e38; border-radius: 4px; }
#prompt-content .prompt-tool-name { color: #b87a7a; font-size: 11px; font-weight: bold; }
#prompt-content .prompt-tool-desc { color: #8a8a96; font-size: 10px; margin-top: 2px;
  white-space: pre-wrap; word-break: break-word; }
#prompt-content .prompt-hist-text { font-size: 11px; color: #8a8a96; margin: 2px 0 6px;
  white-space: pre-wrap; word-break: break-word; }
#prompt-content .prompt-hist-tag { margin-top: 8px; }
/* 协议不被允许的链接：降级为不可点文本（不留 href）。 */
.msg.agent .blocked-link { color: #b87a7a; text-decoration: line-through; cursor: not-allowed; }
#reserved-area { height: 50%; border-top: 1px solid #3e3e4a; display: flex; align-items: center;
  justify-content: center; color: #5a5a66; font-size: 12px; }
#app { flex: 1; max-width: 800px; display: flex; flex-direction: column; height: 100vh; }
#header { padding: 12px 20px; background: #32323e; border-bottom: 1px solid #3e3e4a;
  display: flex; justify-content: space-between; align-items: center; }
#header h1 { font-size: 18px; color: #b87a7a; display: flex; align-items: baseline; gap: 10px; }
#header h1 .tagline { font-size: 12px; color: #8a8a96; font-weight: normal; }
#header-right { display: flex; align-items: center; gap: 12px; }
#tool-stats { font-size: 11px; color: #7a9a8a; transition: opacity 0.5s; white-space: nowrap; }
#tool-stats.hidden { opacity: 0; }
#status { font-size: 11px; color: #5a5a66; }
#status.ok { color: #7a9a8a; }
#gear { cursor: pointer; font-size: 18px; color: #5a5a66; background: none; border: none; padding: 4px; line-height: 1; }
#gear:hover { color: #b87a7a; }
#messages { flex: 1; overflow-y: auto; padding: 16px 20px; display: flex; flex-direction: column; gap: 10px; }
.msg { max-width: 85%; padding: 10px 16px; border-radius: 10px; word-break: break-word; line-height: 1.65; }
.msg.user { align-self: flex-end; background: #4a4a5a; color: #d0d0d8; }
.msg.agent { align-self: flex-start; background: #3a3a44; color: #c8c8d0; }
.msg.error { align-self: center; background: #4a3030; color: #c88a8a; font-size: 12px; max-width: 95%; }
.msg.setup { align-self: stretch; background: #2a3a2a; border: 1px solid #3a4a3a; border-radius: 10px; padding: 16px;
  color: #b0c0b0; font-size: 13px; }
.msg.setup .setup-title { color: #7a9a8a; font-size: 14px; margin-bottom: 8px; }
.msg.setup button { margin-top: 10px; padding: 6px 16px; border: none; border-radius: 6px;
  background: #7a9a8a; color: #2c2c34; font: inherit; cursor: pointer; }
.msg.setup button:hover { opacity: .85; }
.msg.progress { align-self: center; background: #343440; color: #8a8a96; font-size: 12px; max-width: 95%; opacity: .9; }
.msg.progress.error { background: #4a3030; color: #c88a8a; }
.msg.reasoning { align-self: flex-start; background: #2a3440; border: 1px solid #3a4450; border-radius: 10px; padding: 12px; max-width: 90%; }
.msg.reasoning summary { cursor: pointer; color: #8a9aa6; font-size: 13px; }
.tool-group { align-self: stretch; margin: 4px 0; }
.tool-group summary { cursor: pointer; color: #6a6a7a; font-size: 12px; padding: 4px 8px; border-radius: 4px; background: #2e2e38; user-select: none; }
.tool-group summary:hover { background: #3a3a46; }
.tool-group[open] summary { margin-bottom: 6px; }
.tool-group .msg.progress { margin: 2px 0 2px 20px; }
.msg.reasoning pre { margin: 8px 0 0; padding: 8px; background: #1e2830; color: #a0b0c0; font-size: 11px; max-height: 150px; overflow-y: auto; white-space: pre-wrap; word-break: break-word; }

.session-row { display: flex; align-items: center; gap: 8px; padding: 8px; border-radius: 6px; cursor: pointer; transition: background .2s; }
.session-row:hover { background: #2a3440; }
.session-row.active { background: #4a4a5a; }
.session-row input { flex: 1; padding: 4px 8px; border: 1px solid #3e3e4a; border-radius: 4px; background: #2c2c34; color: #d0d0d8; font-size: 13px; outline: none; }
.session-actions { display: flex; gap: 4px; }
.session-actions button { padding: 4px; border: none; border-radius: 4px; background: transparent; color: #6a7a8a; cursor: pointer; font-size: 12px; }
.session-actions button:hover { color: #b87a7a; }
#input-row { padding: 12px 20px; background: #32323e; border-top: 1px solid #3e3e4a; display: flex; gap: 8px; }
#input { flex: 1; padding: 10px 14px; border: 1px solid #3e3e4a; border-radius: 8px;
  background: #2c2c34; color: #d0d0d8; font: inherit; resize: none; outline: none;
  transition: border-color .2s; }
#input:focus { border-color: #b87a7a; }
#send { padding: 8px 20px; border: none; border-radius: 8px; background: #b87a7a; color: #fff;
  font: inherit; cursor: pointer; transition: opacity .2s; }
#send:hover { opacity: .85; }
#send:disabled { opacity: .4; cursor: not-allowed; }
.spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid #d0d0d8;
  border-top-color: #b87a7a; border-radius: 50%; animation: spin .6s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.todo-list { align-self: stretch; background: #3a3a44; border: 1px solid #3e3e4a; border-radius: 10px; padding: 12px 16px; max-width: 100%; }
.todo-list .todo-title { color: #b87a7a; font-size: 13px; margin-bottom: 8px; }
.todo-list .todo-item { display: flex; align-items: center; gap: 8px; padding: 4px 0; cursor: pointer; }
.todo-list .todo-item:hover { background: #444450; border-radius: 4px; }
.todo-list .todo-cb { width: 18px; height: 18px; accent-color: #7a9a8a; cursor: pointer; }
.todo-list .todo-text { font-size: 13px; color: #d0d0d8; }
.todo-list .todo-text.done { text-decoration: line-through; color: #6a6a76; }
.loading-msg { align-self: flex-start; padding: 8px 14px; }
.overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%;
  background: rgba(0,0,0,.7); z-index: 10; justify-content: center; align-items: center; }
.overlay.show { display: flex; }
.modal { background: #32323e; border: 1px solid #3e3e4a; border-radius: 14px; padding: 28px;
  max-width: 420px; width: 90%; }
.modal h2 { color: #b87a7a; font-size: 16px; margin-bottom: 20px; }
.modal label { display: block; color: #8a8a96; font-size: 11px; margin-bottom: 4px; margin-top: 14px; }
.modal input { width: 100%; padding: 8px 12px; border: 1px solid #3e3e4a; border-radius: 8px;
  background: #2c2c34; color: #d0d0d8; font: inherit; outline: none; }
.modal input:focus { border-color: #b87a7a; }
.modal .hint { font-size: 11px; color: #5a5a66; margin-top: 4px; }
.modal .btn-row { display: flex; gap: 8px; margin-top: 20px; }
.modal .btn-save { flex: 1; padding: 10px; border: none; border-radius: 8px; background: #7a9a8a;
  color: #2c2c34; font: inherit; cursor: pointer; font-weight: bold; }
.modal .btn-save:hover { opacity: .85; }
.modal .btn-cancel { flex: 1; padding: 10px; border: 1px solid #3e3e4a; border-radius: 8px;
  background: transparent; color: #8a8a96; font: inherit; cursor: pointer; }
.modal .btn-cancel:hover { color: #d0d0d8; }
.modal .save-status { font-size: 11px; color: #7a9a8a; text-align: center; margin-top: 10px;
  min-height: 16px; }
.modal .save-status.err { color: #b87a7a; }
#token-bar { display: flex; align-items: center; gap: 10px; padding: 4px 20px; background: #252530; border-bottom: 1px solid #3e3e4a; font-size: 11px; }
#token-bar-fill { height: 6px; border-radius: 3px; flex: 1; max-width: 200px; background: #3a3a46; transition: width .3s, background .3s; }
#token-bar-label { color: #8a8a96; white-space: nowrap; }
#token-bar.green #token-bar-fill { background: #7a9a8a; }
#token-bar.yellow #token-bar-fill { background: #c4a87a; }
#token-bar.red #token-bar-fill { background: #b87a7a; }

/* Markdown rendering styles */
.msg.agent h1, .msg.agent h2, .msg.agent h3, .msg.agent h4, .msg.agent h5, .msg.agent h6 {
  color: #d8d8e0; margin: 12px 0 6px; font-weight: 600; line-height: 1.4; }
.msg.agent h1 { font-size: 1.4em; border-bottom: 1px solid #4a4a56; padding-bottom: 6px; }
.msg.agent h2 { font-size: 1.2em; border-bottom: 1px solid #4a4a56; padding-bottom: 4px; }
.msg.agent h3 { font-size: 1.1em; }
.msg.agent h4 { font-size: 1em; }
.msg.agent p { margin: 6px 0; }
.msg.agent ul, .msg.agent ol { margin: 6px 0; padding-left: 20px; }
.msg.agent li { margin: 3px 0; }
.msg.agent a { color: #8aa0b0; text-decoration: underline; }
.msg.agent a:hover { color: #a0b8c8; }
.msg.agent blockquote {
  margin: 8px 0; padding: 8px 14px; border-left: 3px solid #7a9a8a;
  background: #343440; border-radius: 0 6px 6px 0; color: #a8a8b4; }
.msg.agent hr { border: none; border-top: 1px solid #4a4a56; margin: 12px 0; }
.msg.agent table { border-collapse: collapse; margin: 8px 0; width: 100%; font-size: 0.92em; }
.msg.agent th, .msg.agent td { border: 1px solid #4a4a56; padding: 6px 10px; text-align: left; }
.msg.agent th { background: #343440; font-weight: 600; color: #d0d0d8; }
.msg.agent td { color: #b8b8c2; }
.msg.agent tr:nth-child(even) td { background: #32323e; }
.msg.agent img { max-width: 100%; border-radius: 6px; margin: 6px 0; }

/* Code blocks */
.msg.agent code {
  font-family: "SF Mono", "Fira Code", "Cascadia Code", Menlo, Consolas, monospace;
  font-size: 0.88em; background: #2e2e38; padding: 2px 5px; border-radius: 4px;
  color: #c4a87a; }
.msg.agent pre {
  margin: 10px 0; padding: 14px 16px; background: #262630; border-radius: 8px;
  overflow-x: auto; border: 1px solid #3e3e4a; }
.msg.agent pre code {
  background: none; padding: 0; color: #c0c0c8; font-size: 0.85em; line-height: 1.5; }
.msg.agent pre .code-lang {
  display: block; text-align: right; font-size: 0.8em; color: #6a6a76;
  margin-bottom: 6px; padding-bottom: 6px; border-bottom: 1px solid #3e3e4a; }

/* Syntax highlighting tokens */
.msg.agent pre .kw { color: #b87a7a; }
.msg.agent pre .str { color: #7a9a8a; }
.msg.agent pre .num { color: #c4a87a; }
.msg.agent pre .cmt { color: #6a6a76; font-style: italic; }
.msg.agent pre .fn { color: #8aa0b0; }
.msg.agent pre .op { color: #a0a0a8; }

.msg.task-complete { background: #2a3a2a !important; color: #7a9a8a !important; border: 1px solid #3a4a3a; }
</style>
</head>
<body>
<div id="left-panel">
  <div id="prompt-viewer">
    <div id="prompt-viewer-header"> 提示词原文</div>
    <div id="prompt-content">等待请求...</div>
  </div>
  <div id="reserved-area">预留区域</div>
</div>
<div id="auth-panel" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:60;align-items:center;justify-content:center">
  <div style="background:#252530;border:1px solid #3e3e4a;border-radius:8px;padding:18px 20px;width:360px">
    <h3 style="margin:0 0 6px;font-size:14px;color:#d0d0d8">登录</h3>
    <p style="margin:0 0 10px;font-size:11px;color:#8a8a96;line-height:1.5">本实例设置了 gateway.apiKey。口令只保存在本标签页的 sessionStorage，不写入 URL、不进浏览器历史。</p>
    <input id="auth-input" type="password" placeholder="gateway.apiKey" style="width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid #3e3e4a;border-radius:4px;background:#2c2c34;color:#d0d0d8;font-size:12px;outline:none">
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
      <button type="button" id="auth-cancel" style="padding:6px 12px;border:1px solid #3e3e4a;border-radius:4px;background:#2c2c34;color:#c0c0c8;font-size:12px;cursor:pointer">取消</button>
      <button type="button" id="auth-save" style="padding:6px 12px;border:1px solid #4a6b5a;border-radius:4px;background:#2f4438;color:#cfe6d8;font-size:12px;cursor:pointer">保存并重连</button>
    </div>
  </div>
</div>
<div id="app">
  <div id="header">
    <h1>    土行孙 <span class="tagline">小小身材，内有乾坤</span></h1>
    <div id="header-right">
      <select id="sessionSelect" style="padding: 4px 8px; border: 1px solid #3e3e4a; border-radius: 4px; background: #2c2c34; color: #d0d0d8; font-size: 12px; outline: none;">
      </select>
      <div id="tool-stats"></div>
      <div id="status">连接中...</div>
      <button id="authbtn" title="登录（填 gateway.apiKey）" style="display:none">&#128273;</button>
      <button id="gear" title="设置">&#9881;</button>
    </div>
  </div>
  <div id="token-bar" style="display:flex;align-items:center;gap:10px;padding:4px 20px;background:#252530;border-bottom:1px solid #3e3e4a;font-size:11px;cursor:pointer" title="点击手动压缩上下文">
    <div id="token-bar-fill" style="height:6px;border-radius:3px;flex:1;max-width:200px;background:#3a3a46;transition:width .3s,background .3s;"></div>
    <span id="token-bar-label" style="color:#8a8a96;white-space:nowrap;">等待回复...</span>
  </div>
  <div id="messages">
    <div class="msg agent">欢迎使用土行孙 AI 网关。<br>在下方输入消息开始对话。</div>
  </div>
  <div id="input-row">
    <textarea id="input" rows="2" placeholder="输入消息...(Enter 发送, Shift+Enter 换行)" autofocus></textarea>
    <button id="send" type="button">发送</button>
  </div>
</div>
<div class="overlay" id="settingsOverlay">
  <div class="modal">
    <h2> 模型配置</h2>
    <label>API Key</label>
    <input type="password" id="cfgApiKey" placeholder="sk-...">
    <div class="hint">必填。密钥仅存本地，不会上传。</div>
    <label>Model</label>
    <input type="text" id="cfgModel" placeholder="gpt-4o-mini">
    <label>Base URL</label>
    <input type="text" id="cfgBaseUrl" placeholder="https://api.openai.com/v1">
    <div class="hint">兼容 OpenAI 协议的 API 地址均可。</div>
    <label>Context Max Tokens</label>
    <input type="number" id="cfgMaxTokens" placeholder="8000" min="1000" max="128000">
    <div class="hint">上下文窗口上限，达到 90% 自动压缩。</div>
    <div class="btn-row">
      <button class="btn-cancel" id="settings-cancel">取消</button>
      <button class="btn-save" id="settings-save">保存并生效</button>
    </div>
    <div class="save-status" id="saveStatus"></div>
  </div>
</div>
<script nonce="${nonce}">
console.log('[tusunsun] chat-ui loaded');
const API = '/v1/chat/completions';
const msgs = document.getElementById('messages');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const statusEl = document.getElementById('status');
const overlay = document.getElementById('settingsOverlay');
let loading = false;
let apiConfigured = true;
const progressMsgs = new Map();
let currentReasoningBlock = null;
let currentToolDetail = null;
let currentTokenUsage = null;
let contextMaxTokens = 8000;
let ws = null;
let reconnectTimer = null;
let currentReader = null;
let toolRoundStarted = false;
let sessionCounter = 0;
let currentSessionId = 'session_0';
const sessions = { 'session_0': { name: '默认会话', messages: [] } };
let toolStats = { count: 0, duration: 0 };
let modelName = 'gpt-4o-mini';
let currentPrompt = null;
let currentTools = [];
let currentModel = 'gpt-4o-mini';
let currentBaseUrl = '';
let currentStream = true;
let currentToolChoice = 'auto';
// R0-113（P0-01）：控制面/数据面凭证。若用户按文档用 ?token=<gateway.apiKey> 打开页面，
// 页面把口令放进**请求头**（Authorization）与 WS 子协议（Sec-WebSocket-Protocol），
// 不再拼进 URL —— URL 会留在浏览器历史、代理日志与 Referer 里。
// R0-114（P2-01）：凭证的**首选**来源是登录框（sessionStorage），URL 上的 token 查询参数降级为兼容路径。
// 理由：URL 会进浏览器历史/代理日志/Referer；而 sessionStorage 随标签页关闭即消失。
function readAuthToken() {
  try {
    const saved = sessionStorage.getItem('tusunsun_auth_token');
    if (saved) return saved;
  } catch { /* 隐私模式下 sessionStorage 不可用 */ }
  const fromQuery = new URLSearchParams(location.search).get('token') || '';
  if (fromQuery) {
    try { sessionStorage.setItem('tusunsun_auth_token', fromQuery); } catch { /* 同上 */ }
    // 从地址栏抹掉，避免它被复制/被 Referer 带走（history.replaceState 不触发新请求）。
    try {
      const u = new URL(location.href); u.searchParams.delete('token');
      history.replaceState(null, '', u.pathname + (u.search ? u.search : '') + u.hash);
    } catch { /* 老浏览器忽略 */ }
  }
  return fromQuery;
}
let AUTH_TOKEN = readAuthToken();
let authHeaders = AUTH_TOKEN ? { Authorization: 'Bearer ' + AUTH_TOKEN } : {};

// R0-116（P0-01）：script-src 走 nonce 且不含 unsafe-inline，于是**内联事件处理属性**
// 整体失效，所以模板里原有的 'onclick='/'onchange=' 必须改成 addEventListener。这既是启用 CSP
// 的前提，也顺手消灭了"把 JS 写进属性字符串"这一形态——它和本轮修的 DOM 注入是同一类问题。
// 下面引用的全是函数声明（已提升），因此此段放在定义之前也能工作。
const on = (id, type, fn) => { const n = document.getElementById(id); if (n) n.addEventListener(type, fn); };
on('auth-cancel', 'click', closeAuth);
on('auth-save', 'click', saveAuth);
on('authbtn', 'click', openAuth);
on('gear', 'click', openSettings);
on('settings-cancel', 'click', closeSettings);
on('settings-save', 'click', saveSettings);
on('token-bar', 'click', compactContext);
on('sessionSelect', 'change', (ev) => {
  const sel = ev.target;
  // 语义与旧写法一致（旧写法是每次渲染都重新给 select.onchange 赋值；property 赋值虽不受
  // CSP 限制，但"每渲染一次重挂一次"没必要，且新旧两处都挂会重复处理）。
  if (sel.value === '__new__') { createSession(); sel.value = currentSessionId; return; }
  switchSession(sel.value);
});

function connectWS() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const host = location.host;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = proto + '://' + host + '/ws';
  const protocols = AUTH_TOKEN
    ? ['tusunsun.v1', 'tusunsun.token.' + btoa(AUTH_TOKEN).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')]
    : ['tusunsun.v1'];
  ws = new WebSocket(wsUrl, protocols);
  ws.onopen = () => {
    console.log('WS connected');
    if (reconnectTimer) clearTimeout(reconnectTimer);
  };
  ws.onclose = () => reconnectTimer = setTimeout(connectWS, 3000);
  ws.onerror = (err) => console.error('WS error', err);
  ws.onmessage = (msg) => {
    try {
      const data = JSON.parse(msg.data);
      if (data.type === 'event' && data.event === 'request.end') {
        showTaskComplete();
      }
      if (data.type === 'event' && data.event === 'tool.progress') {
        handleToolProgress(data.payload);
      }
      if (data.type === 'event' && data.event === 'chat.stream.reasoning') {
        handleReasoning(data.payload);
      }
      if (data.type === 'event' && data.event === 'chat.stream.reasoning_end') {
        currentReasoningBlock = null;
      }
      if (data.type === 'event' && data.event === 'chat.messages_built') {
        console.log('[WS] chat.messages_built received, sessionId:', data.payload.sessionId, 'msgCount:', data.payload.messages?.length);
        handleMessagesBuilt(data.payload);
      }
    } catch (e) {
      console.error('[WS] parse error:', e);
    }
  };
}

function handleToolProgress(payload) {
  const { tool, status, callId, argsPreview } = payload;
  const chatKey = callId || tool + '-' + payload.timestamp;
  if (status === 'executing') return _showToolStart(tool, argsPreview, chatKey);
  if (status === 'done') _showToolDone(tool, payload, chatKey);
}

function _showToolStart(tool, argsPreview, key) {
  toolRoundStarted = true;
  if (!currentToolDetail) {
    currentToolDetail = document.createElement('details');
    currentToolDetail.className = 'tool-group';
    const summary = document.createElement('summary');
    summary.textContent = ' 工具调用';
    currentToolDetail.appendChild(summary);
    msgs.appendChild(currentToolDetail);
    msgs.scrollTop = msgs.scrollHeight;
  }
  const div = document.createElement('div');
  div.className = 'msg progress';
  div.id = 'progress-' + key;
  const preview = argsPreview ? argsPreview.slice(0, 50) : '';   // textContent 已在下方兜底，勿重复转义
  div.textContent = '⏳ ' + tool + (preview ? ' ' + preview : '') + '...';
  currentToolDetail.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  progressMsgs.set(key, div);
}

function _showToolDone(tool, payload, key) {
  const div = progressMsgs.get(key);
  if (!div) return;
  const { duration, ok, resultPreview } = payload;
  const icon = ok ? '[OK]' : '[ERR]';
  let text = icon + ' ' + tool + ' (' + duration + 'ms)';
  if (resultPreview && ok) {
    const writeMatch = resultPreview.match(/Written (\d+) bytes to (.+)/);
    if (writeMatch) {
      text = icon + ' ' + tool + ' → ' + writeMatch[2] + ' (' + writeMatch[1] + ' bytes, ' + duration + 'ms)';
    } else {
      text = icon + ' ' + tool + ' → ' + resultPreview.slice(0, 50) + ' (' + duration + 'ms)';
    }
  } else if (resultPreview && !ok) {
    text = icon + ' ' + tool + ' → ' + resultPreview.slice(0, 50) + ' (' + duration + 'ms)';
  }
  div.textContent = text;
  if (!ok) div.classList.add('error');
  toolStats.count++;
  toolStats.duration += duration;
  progressMsgs.delete(key);
  saveMessage(currentSessionId, { role: 'tool', text, timestamp: Date.now() });
}

function showTaskComplete() {
  loading = false;
  sendBtn.textContent = '发送';
  sendBtn.style.background = '#7a9a8a';
  input.focus();
  input._sending = false;
  
  // 移除思考动画并显示完成提示
  const thinking = document.getElementById('thinking');
  if (thinking) {
    thinking.textContent = '[任务完成]';
    thinking.className = 'msg agent task-complete';
    setTimeout(() => thinking.remove(), 2000);
  }
}

function handleReasoning(payload) {
  const { reasoning, sessionId } = payload;
  if (!currentReasoningBlock) {
    const container = document.createElement('div');
    container.className = 'msg reasoning';
    appendAll(container, el('details', null, [
      el('summary', null, '思考过程'), el('pre'),
    ]));
    msgs.appendChild(container);
    msgs.scrollTop = msgs.scrollHeight;
    currentReasoningBlock = container.querySelector('pre');
  }
  currentReasoningBlock.textContent += reasoning;
}

function handleMessagesBuilt(payload) {
  const { sessionId, messages, tools, model, baseUrl, stream, tool_choice } = payload;
  if (sessionId !== currentSessionId) {
    console.log('[prompt-viewer] sessionId mismatch:', sessionId, '!==', currentSessionId);
    return;
  }
  currentPrompt = messages;
  currentTools = tools || [];
  currentModel = model || 'gpt-4o-mini';
  currentBaseUrl = baseUrl || '';
  currentStream = stream !== false;
  currentToolChoice = tool_choice || 'auto';
  renderPrompt();
}

function renderSchema(schema) {
  if (!schema?.properties) return '';
  let text = '';
  const required = schema.required || [];
  for (const [name, prop] of Object.entries(schema.properties)) {
    const isReq = required.includes(name);
    const type = prop.type || 'any';
    const desc = prop.description || '';
    text += '      ' + name + ': ' + type + (isReq ? ' (必填)' : '');
    if (desc) text += ' - ' + desc;
    text += '\n';
  }
  return text;
}

function renderPrompt() {
  // 变量名故意不叫 'el'：全局的 'el()' 是 DOM 构造助手，同名会把它遮蔽掉。
  const el0 = document.getElementById('prompt-content');
  if (!el0) return;
  if (!currentPrompt) { el0.textContent = '等待请求...'; return; }

  // R0-116：本段原先也是"拼 HTML 字符串 + innerHTML"，且有两处**未转义**的插入点
  // （'msg.role' 拼进 class 属性、'tcName' 拼进元素内容）。现全部改成 DOM 构造，
  // 样式从内联 'style=""' 移到类名（见样式表里的 '.prompt-*'）。
  const host = el('div');
  const systemParts = [];
  let historyCount = 0;

  currentPrompt.forEach(msg => {
    if (msg.role === 'system') {
      systemParts.push(String(msg.content == null ? '' : msg.content));
    } else if (msg.role === 'assistant' || msg.role === 'tool' || msg.role === 'user') {
      historyCount++;
    }
  });

  host.appendChild(el('div', { class: 'role-tag system' }, '[SYSTEM]'));
  host.appendChild(el('pre', { class: 'prompt-pre' }, systemParts.join('\n') || '(无)'));

  if (currentTools.length > 0) {
    const toolsBox = el('details', { class: 'prompt-details', open: '' },
      el('summary', { class: 'prompt-summary' }, '可用工具 (' + currentTools.length + ' 个)'));
    currentTools.forEach(t => {
      const toolName = t && t.name != null ? String(t.name) : '';
      let toolDesc = t && t.description != null ? String(t.description) : '';
      if (toolDesc.length > 150) toolDesc = toolDesc.slice(0, 150) + '...';
      toolsBox.appendChild(el('div', { class: 'prompt-tool' }, [
        el('div', { class: 'prompt-tool-name' }, toolName),
        el('div', { class: 'prompt-tool-desc' }, toolDesc),
      ]));
    });
    host.appendChild(toolsBox);
  }

  if (historyCount > 0) {
    const histBox = el('details', { class: 'prompt-details plain' },
      el('summary', { class: 'prompt-summary' }, '对话历史 (' + historyCount + ' 条)'));
    currentPrompt.forEach(msg => {
      if (msg.role !== 'user' && msg.role !== 'assistant' && msg.role !== 'tool') return;
      const role = msg.role;                               // 只可能是上面三者之一（已白名单化）
      histBox.appendChild(el('div', { class: 'role-tag ' + role + ' prompt-hist-tag' },
        '[' + role.toUpperCase() + ']'));
      if (msg.content) {
        let body = String(msg.content);
        if (body.length > 200) body = body.slice(0, 200) + '...';
        histBox.appendChild(el('div', { class: 'prompt-hist-text' }, body));
      }
      if (Array.isArray(msg.tool_calls)) {
        msg.tool_calls.forEach(tc => {
          const tcName = tc && (tc.name || (tc.function && tc.function.name)) || 'unknown';
          histBox.appendChild(el('div', { class: 'role-tag tool' }, '[TOOL_CALL: ' + String(tcName) + ']'));
        });
      }
    });
    host.appendChild(histBox);
  }

  clearNode(el0);
  el0.appendChild(host);
}

function handleTokenUsage(usage) {
  currentTokenUsage = usage;
  const bar = document.getElementById('token-bar');
  const fill = document.getElementById('token-bar-fill');
  const label = document.getElementById('token-bar-label');
  if (!bar || !fill || !label) return;
  const pct = usage.percent || 0;
  const cls = pct >= 80 ? 'red' : pct >= 60 ? 'yellow' : 'green';
  bar.className = cls;
  bar.style.display = 'flex';
  fill.style.width = Math.min(pct, 100) + '%';
  const compactHint = pct >= 60 ? ' 点击手动压缩' : '';
  label.textContent = pct + '% used (' + (usage.used || 0) + '/' + (usage.max || 8000) + ')' + compactHint;
  try { localStorage.setItem('tusunsun_token_usage', JSON.stringify(usage)); } catch { /* localStorage 不可用（隐私/配额）时静默降级 */ }
}

async function compactContext() {
  if (!currentSessionId) return;
  const label = document.getElementById('token-bar-label');
  if (label) label.textContent = '压缩中...';
  try {
    const resp = await fetch('/api/context/compact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ sessionId: currentSessionId }),
    });
    const result = await resp.json();
    if (result.ok && result.tokenUsage) {
      handleTokenUsage(result.tokenUsage);
    }
  } catch (e) { console.error('compactContext failed:', e); }
}

if (typeof WebSocket !== 'undefined') connectWS();

// R0-114（P2-01）：登录后要能**立刻**重新拉配置，故把初始化体抽成具名函数（可重入）。
async function loadConfig() {
  try {
    const resp = await fetch('/api/config', { headers: { ...authHeaders } });
    if (resp.status === 401 || resp.status === 403) {
      // 有口令保护但当前标签页还没有（或口令错了）：亮出钥匙按钮，其余保持只读。
      const btn = document.getElementById('authbtn');
      if (btn) btn.style.display = '';
      return;
    }
    const cfg = await resp.json();
    document.getElementById('cfgApiKey').value = cfg.apiKey || '';
    document.getElementById('cfgModel').value = cfg.model || 'gpt-4o-mini';
    document.getElementById('cfgBaseUrl').value = cfg.baseUrl || 'https://api.openai.com/v1';
    document.getElementById('cfgMaxTokens').value = cfg.maxTokens || 8000;
    contextMaxTokens = cfg.maxTokens || 8000;
    apiConfigured = cfg.configured;
    modelName = cfg.model || 'gpt-4o-mini';
    updateStatus();
  } catch { /* 配置加载失败走默认值 */ }
  
  loadSessions();
  loadHistory(currentSessionId);
  updateSessionSelect();
  checkHealth();
  renderPrompt();
  try {
    const saved = localStorage.getItem('tusunsun_token_usage');
    if (saved) handleTokenUsage(JSON.parse(saved));
  } catch { /* 缓存解析失败忽略 */ }
}

loadConfig();

// ─────────────────────────────────────────────────────────────────────────────
// R0-116（P0-01）：内置网页 UI 的 **HTML 注入边界**
//
// 事实（在 0.9.7 原始制品上实测复现）：'renderInline()' 先把 '& < >' 转义，随后却用字符串
// 模板把 Markdown 的图片/链接**拼成 HTML 字符串**，再交给 'innerHTML'：
//     ![demo](broken" onerror="window.__qa_marker=1)
// 产出 '<img src="broken" onerror="window.__qa_marker=1" alt="demo">'——按 HTML 解析语义这是
// **两个属性**，不是一段文本。链接同理可带上 'javascript:'。由于网关口令存在 sessionStorage，
// 事件处理属性一旦被浏览器执行，同源脚本就能读到该凭证。
//
// 根因不是"少转义了一个引号"，而是**把不可信数据当成了 HTML 源码**。所以本版不修"某个字符
// 没转义"，而是釜底抽薪：
//   ① 不可信字符串**只经 textContent / createTextNode** 进 DOM。本文件的 innerHTML 出现
//      次数必须为 **0**——由随包用例 'test-r0-116' 钉住，改回字符串拼接即变红；
//   ② 属性名走**白名单** 'SAFE_ATTRS'，'on*' / 'style' / 'srcdoc' 等天然进不来；
//   ③ 属性值走 'setAttribute()'——它不做 HTML 解析，值里的引号无法"逃出"属性；
//   ④ URL 走**协议白名单**：先剥掉控制字符与零宽字符（挡 'java\tscript:' 这类绕过）再判协议，
//      不在白名单的一律**不赋值**（链接降级为不可点文本，并带上说明）。
// 第二道防线是 CSP（见 '_serveChat'）：'script-src 'nonce-…'' 不含 ''unsafe-inline''，
// 内联事件处理属性整体不可执行。CSP 是纵深，**不是**本层的替代品。
// ─────────────────────────────────────────────────────────────────────────────

/** 允许出现在 'el()' 里的属性名。不在表内的一律**静默丢弃**（不是转义）。 */
const SAFE_ATTRS = new Set([
  'class', 'id', 'title', 'alt', 'href', 'src', 'target', 'rel',
  'type', 'value', 'checked', 'disabled', 'selected', 'open',
  'colspan', 'rowspan', 'data-id', 'data-blocked-url', 'data-blocked-src',
]);

/** 链接允许的协议（相对路径/锚点无协议，另走一条分支）。 */
const LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);
/** 图片允许的协议——**不含 'data:'**：'data:' 可承载 'image/svg+xml'，而 SVG 里能带脚本。 */
const IMG_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * URL 清洗。返回可赋给 'href'/'src' 的字符串，或 'null'（调用方**必须不赋值**）。
 * 拒绝 'javascript:' 'data:' 'vbscript:' 'blob:' 'file:' 及一切未知协议与解析失败者。
 */
function safeUrl(raw, kind) {
  let s = String(raw == null ? '' : raw);
  // 'java\tscript:alert(1)'、'\njavascript:'、' javascript:'、零宽字符插入都靠这一步归一化。
  s = s.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029]/g, '').trim();
  if (!s) return null;
  if (!/^[A-Za-z][A-Za-z0-9+.\-]*:/.test(s)) return s;   // 相对路径 / 锚点 / 查询串：无协议，放行
  let proto;
  try { proto = new URL(s).protocol; } catch { return null; }
  return (kind === 'img' ? IMG_PROTOCOLS : LINK_PROTOCOLS).has(proto) ? s : null;
}

/**
 * 建元素。属性走白名单 + 'setAttribute'；子节点里字符串一律变成**文本节点**。
 * 这是本文件唯一允许的"把不可信数据放进 DOM"的方式。
 */
function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [name, value] of Object.entries(attrs)) {
      if (value === undefined || value === null) continue;
      if (!SAFE_ATTRS.has(name)) continue;               // on* / style / srcdoc 到不了这里
      if (name === 'href' || name === 'src') {
        const kind = name === 'src' ? 'img' : 'link';
        const safe = safeUrl(value, kind);
        // 不合法就**不写这个属性**，只留一条可审计的痕迹；绝不"转义后照写"。
        node.setAttribute(safe === null ? (kind === 'img' ? 'data-blocked-src' : 'data-blocked-url')
          : name, safe === null ? String(value).slice(0, 200) : safe);
        continue;
      }
      node.setAttribute(name, String(value));
    }
  }
  return appendAll(node, children);
}

/** 追加子节点：字符串 → 文本节点（不可信内容唯一的入口）。 */
function appendAll(node, children) {
  if (children === undefined || children === null) return node;
  for (const child of (Array.isArray(children) ? children : [children])) {
    if (child === undefined || child === null) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/** 清空节点（替代 innerHTML 赋值）。 */
function clearNode(node) {
  if (node) node.replaceChildren();
  return node;
}

const MD_LANGS = /^(js|javascript|typescript|ts|python|py|go|rust|rs|java|c|cpp|cs|ruby|rb|php|sh|bash|json|yaml|yml|toml|xml|html|css|sql|diff|markdown|md)$/;

// 行内语法**单趟**扫描，顺序即优先级：代码 > 图片 > 链接 > 强调。
// 用单趟而不是"连续多次 replace"，是为了不再出现"上一轮的替换产物被下一轮当成源码"
// ——原实现正是这样把数据拼进了属性里。
//
// 这里只存**模式源**，每次调用现建一个带 'g' 的正则实例。为什么不能共用一个模块级 '/g'
// 正则：'renderInline()' 对链接文字会**递归**调用自己（'[**粗**](url)'），而 'g' 正则的
// 'lastIndex' 是**对象上的可变状态** —— 内层递归结束时把它复位成 0，外层循环下一轮就从
// 字符串**开头**重新匹配，'last' 再也回不到尾部 ⇒ **死循环**（渲染线程被占满，浏览器
// 整页卡死；实测表现为"消息区不更新、CDP 求值永不返回"）。任何含链接的回复都会命中。
// 每次调用新建实例后，递归各自持有独立游标，不再互相踩踏。
const MD_INLINE_SOURCE = '\x60([^\x60\n]+)\x60|!\\[([^\\]]*)\\]\\(([^)]+)\\)|\\[([^\\]]+)\\]\\(([^)]+)\\)|\\*\\*\\*([^*\n]+)\\*\\*\\*|\\*\\*([^*\n]+)\\*\\*|\\*([^*\n]+)\\*|~~([^~\n]+)~~';

/** 行内渲染 → DocumentFragment。全程不产出 HTML 字符串。 */
function renderInline(s) {
  const out = document.createDocumentFragment();
  const text = String(s == null ? '' : s);
  const re = new RegExp(MD_INLINE_SOURCE, 'g');   // 每次调用独立实例：见上方"为什么不能共用"
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.appendChild(document.createTextNode(text.slice(last, m.index)));
    last = m.index + m[0].length;
    if (m[1] !== undefined) {                              // 'code'
      out.appendChild(el('code', null, m[1]));
    } else if (m[2] !== undefined) {                       // ![alt](src)
      out.appendChild(el('img', { alt: m[2], src: m[3].trim() }));
    } else if (m[4] !== undefined) {                       // [text](href)
      const url = m[5].trim();
      if (safeUrl(url, 'link') === null) {
        out.appendChild(el('span', { class: 'blocked-link', title: '链接协议不被允许，已禁用' },
          [renderInline(m[4]), '（链接已禁用：' + url.slice(0, 60) + '）']));
      } else {
        out.appendChild(el('a', { href: url, target: '_blank', rel: 'noopener noreferrer' },
          renderInline(m[4])));
      }
    } else if (m[6] !== undefined) { out.appendChild(el('strong', null, el('em', null, m[6]))); }
    else if (m[7] !== undefined) { out.appendChild(el('strong', null, m[7])); }
    else if (m[8] !== undefined) { out.appendChild(el('em', null, m[8])); }
    else if (m[9] !== undefined) { out.appendChild(el('del', null, m[9])); }
  }
  if (last < text.length) out.appendChild(document.createTextNode(text.slice(last)));
  return out;
}

/** 块级渲染 → DocumentFragment。参数与旧版一致：返回可 'appendChild' 的节点。 */
function renderMarkdown(text) {
  const out = document.createDocumentFragment();
  const source = String(text == null ? '' : text);
  if (!source) return out;
  const lines = source.split('\n');
  let inCode = false, codeLang = '', codeContent = '';
  let listType = '', listNode = null;
  let inTable = false, tableRows = [];
  let inQuote = false, quoteLines = [];

  const flushList = () => { listType = ''; listNode = null; };
  const flushTable = () => {
    if (inTable && tableRows.length > 0) {
      const table = el('table');
      tableRows.forEach((row, i) => {
        if (i === 1 && row.every(c => c.trim().match(/^[-:]+$/))) return;
        const tag = i === 0 ? 'th' : 'td';
        const tr = el('tr');
        for (const cell of row) tr.appendChild(el(tag, null, renderInline(cell.trim())));
        table.appendChild(tr);
      });
      out.appendChild(table);
    }
    inTable = false; tableRows = [];
  };
  const flushQuote = () => {
    if (inQuote) out.appendChild(el('blockquote', null, renderMarkdown(quoteLines.join('\n').trim())));
    inQuote = false; quoteLines = [];
  };

  for (const line of lines) {
    if (inCode) {
      if (line.trim().startsWith('\x60\x60\x60')) {
        out.appendChild(codeBlock(codeContent, codeLang));
        inCode = false; codeContent = ''; codeLang = '';
      } else {
        codeContent += (codeContent ? '\n' : '') + line;
      }
      continue;
    }

    if (line.trim().startsWith('\x60\x60\x60')) {
      flushList(); flushTable(); flushQuote();
      inCode = true;
      codeLang = line.trim().slice(3).trim();
      continue;
    }

    if (inQuote) {
      if (line.trimStart().startsWith('>')) { quoteLines.push(line.trimStart().slice(1).trim()); continue; }
      flushQuote();
    }

    if (line.trimStart().startsWith('>')) {
      flushList(); flushTable(); flushQuote();
      inQuote = true;
      quoteLines.push(line.trimStart().slice(1).trim());
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      flushList(); flushTable(); flushQuote();
      const level = headingMatch[1].length;
      out.appendChild(el('h' + level, null, renderInline(headingMatch[2])));
      continue;
    }

    if (line.trim() === '---' || line.trim() === '***') {
      flushList(); flushTable(); flushQuote();
      out.appendChild(el('hr'));
      continue;
    }

    const tableMatch = line.trim().match(/^\|(.+)\|$/);
    if (tableMatch) {
      flushList(); flushQuote();
      inTable = true;
      tableRows.push(tableMatch[1].split('|'));
      continue;
    } else if (inTable) {
      flushTable();
    }

    const olMatch = line.match(/^(\s*)(\d+)\.\s+(.+)/);
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.+)/);
    if (olMatch || ulMatch) {
      flushTable(); flushQuote();
      const isOl = !!olMatch;
      const match = isOl ? olMatch : ulMatch;
      const want = isOl ? 'ol' : 'ul';
      if (listType !== want) { flushList(); listNode = el(want); out.appendChild(listNode); listType = want; }
      listNode.appendChild(el('li', null, renderInline(isOl ? match[3] : match[2])));
      continue;
    } else {
      flushList();
    }

    if (line.trim() === '') { out.appendChild(el('br')); continue; }

    out.appendChild(el('p', null, renderInline(line)));
  }

  if (inCode) out.appendChild(codeBlock(codeContent, codeLang));
  flushList(); flushTable(); flushQuote();
  return out;
}

/** 代码块（含高亮）→ 元素。高亮也走 DOM，不产出 HTML 字符串。 */
function codeBlock(code, lang) {
  const pre = el('pre');
  if (lang) pre.appendChild(el('span', { class: 'code-lang' }, lang));
  pre.appendChild(el('code', null, highlightCode(code, lang)));
  return pre;
}

// 高亮词法：注释 / 字符串 / 关键字 / 数字 / 函数名，单趟扫描（左优先 ⇒ 注释和字符串里的
// 关键字不会再被当成关键字——旧实现用"连续 replace"，这正是它会把数据当源码的同一毛病）。
const HIGHLIGHT_SOURCE = [
  '(\\/\\/[^\\n]*|#[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/|<!--[\\s\\S]*?-->)',
  '("(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\')',
  '(\\b(?:const|let|var|function|async|await|return|if|else|for|while|do|switch|case|break|'
    + 'continue|new|this|class|extends|import|export|from|def|fn|pub|struct|enum|impl|trait|use|'
    + 'mod|package|func|type|interface|select|insert|update|delete|where|join|on|group|order|having)\\b)',
  '(\\b\\d+\\.?\\d*(?:e[+-]?\\d+)?\\b)',
  '(\\b[a-zA-Z_]\\w*(?=\\s*\\())',
].join('|');
const HIGHLIGHT_CLASSES = ['cmt', 'str', 'kw', 'num', 'fn'];

function highlightCode(code, lang) {
  const out = document.createDocumentFragment();
  const text = String(code == null ? '' : code);
  if (!lang || !MD_LANGS.test(String(lang).toLowerCase())) {
    out.appendChild(document.createTextNode(text));
    return out;
  }
  const re = new RegExp(HIGHLIGHT_SOURCE, 'g');   // 同上：不共用带 g 的实例
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.appendChild(document.createTextNode(text.slice(last, m.index)));
    last = m.index + m[0].length;
    const group = m.slice(1).findIndex(g => g !== undefined);
    out.appendChild(el('span', { class: HIGHLIGHT_CLASSES[group] || '' }, m[0]));
  }
  if (last < text.length) out.appendChild(document.createTextNode(text.slice(last)));
  return out;
}

/**
 * 把"任务清单"载荷（'{"items":[…]}'）解析成元素；不是该形态就返回 'null'。
 *
 * R0-116：旧实现直接把 'JSON.parse' 放在 'appendMsg' 里 —— 模型吐半个 JSON 就抛异常，
 * 整条回复直接不显示。现在解析失败一律退回普通 Markdown 渲染。
 */
function buildTodoList(text) {
  if (typeof text !== 'string' || !text.startsWith('{"items":')) return null;
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  return buildTodoListFromData(data);
}

function buildTodoListFromData(data) {
  if (!data || !Array.isArray(data.items) || !data.items.length) return null;
  const container = el('div', { class: 'todo-list' },
    el('div', { class: 'todo-title' }, '任务清单'));
  data.items.forEach(item => {
    const it = (item && typeof item === 'object') ? item : {};
    const checked = it.status === 'completed' || it.status === 'cancelled';
    const cb = el('input', {
      type: 'checkbox', class: 'todo-cb',
      'data-id': it.id === undefined || it.id === null ? '' : String(it.id),
    });
    if (checked) cb.checked = true;                        // 属性与 property 一起设，语义最明确
    const span = el('span', { class: 'todo-text' + (checked ? ' done' : '') },
      String(it.content === undefined || it.content === null ? '' : it.content));
    cb.addEventListener('change', function () { span.classList.toggle('done', this.checked); });
    container.appendChild(el('div', { class: 'todo-item' }, [cb, span]));
  });
  return container;
}

function appendTodoList(data) {
  const container = buildTodoListFromData(data);
  if (!container) return;
  msgs.appendChild(container);
  msgs.scrollTop = msgs.scrollHeight;
}

function appendMsg(role, text) {
  if (!text) return;
  if (role === 'agent') {
    const todo = buildTodoList(text);
    if (todo) {
      msgs.appendChild(todo);
      scrollToBottom();
      saveMessage(currentSessionId, { role, text, timestamp: Date.now() });
      return;
    }
  }

  const container = el('div', { class: 'msg ' + role });

  if (role === 'agent') {
    appendAll(container, renderMarkdown(text));
  } else {
    container.textContent = text;
  }

  msgs.appendChild(container);
  scrollToBottom();

  saveMessage(currentSessionId, { role, text, timestamp: Date.now() });
}

function appendSetup() {
  const openBtn = el('button', null, '打开配置');
  openBtn.addEventListener('click', openSettings);
  const div = el('div', { class: 'msg setup' }, [
    el('div', { class: 'setup-title' }, 'API Key 未配置'),
    '在下方输入消息前，请先配置模型 API Key。',
    el('br'),
    '支持 OpenAI、DeepSeek 等兼容 API。',
    el('br'),
    openBtn,
  ]);
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

function appendError(text) {
  const div = document.createElement('div');
  div.className = 'msg error';
  div.textContent = text;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

function showLoading() {
  loading = true;
  sendBtn.disabled = true;
  const div = document.createElement('div');
  div.className = 'loading-msg';
  div.id = 'loading';
  div.appendChild(el('span', { class: 'spinner' }));
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

function hideLoading() {
  loading = false;
  sendBtn.disabled = false;
  const bar = document.getElementById('loading');   // 变量名避开全局 el() 助手
  if (bar) bar.remove();
  input.focus();
}

async function doSend() {
  const text = input.value.trim();
  if (!text || loading) return;
  if (!apiConfigured) { openSettings(); return; }
  if (input._sending) return;
  input._sending = true;
  currentReasoningBlock = null;
  currentToolDetail = null;
  toolStats = { count: 0, duration: 0 };
  input.value = '';
  appendMsg('user', text);
  loading = true;
  sendBtn.textContent = '停止';
  sendBtn.style.background = '#b87a7a';

  const thinkingDiv = document.createElement('div');
  thinkingDiv.className = 'msg agent thinking';
  thinkingDiv.id = 'thinking';
  appendAll(thinkingDiv, [el('span', { class: 'spinner' }), ' 正在思考...']);
  msgs.appendChild(thinkingDiv);
  scrollToBottom();
  const thinkingShownAt = Date.now();
  let container = null;
  let fullReply = '';
  try {
    const resp = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ messages: [{ role: 'user', content: text }], model: 'tusunsun', stream: true, session_id: currentSessionId }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      await ensureMinThinkingTime(thinkingShownAt);
      thinkingDiv.remove();
      // R0-113（P0-01）：401 不再是"请求失败: 401"这种无从下手的文案。
      if (resp.status === 401 || resp.status === 403) {
        document.getElementById('authbtn').style.display = '';
        appendError('控制面拒绝（' + resp.status + '）：本实例设置了 gateway.apiKey。'
          + '请点右上角钥匙按钮填入口令（只存 sessionStorage，不进 URL）。');
      } else {
        appendError(err.error?.message || err.error || '请求失败: ' + resp.status);
      }
      resetButtonState();
      return;
    }

    container = await _readSSEStream(resp, thinkingDiv, thinkingShownAt, (reply) => { fullReply = reply; });
    currentReader = null;

    setTimeout(() => _finalizeChatStream(fullReply, container), 2000);

  } catch (e) {
    currentReader = null;
    resetButtonState();
    appendError('网络错误: ' + e.message);
  }
}

async function _readSSEStream(resp, thinkingDiv, thinkingShownAt, onReply) {
  currentReader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let container = null;
  let fullReply = '';

  while (true) {
    const { done, value } = await currentReader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') continue;
      if (!trimmed.startsWith('data: ')) continue;

      try {
        const json = JSON.parse(trimmed.slice(6));
        if (json.type === 'token_usage') { handleTokenUsage(json); continue; }
        const delta = json.choices?.[0]?.delta;
        if (delta?.content) {
          if (toolRoundStarted) {
            toolRoundStarted = false;
            if (container) container.removeAttribute('id');
            container = null;
          }
          if (!container) {
            await ensureMinThinkingTime(thinkingShownAt);
            container = document.createElement('div');
            container.className = 'msg agent';
            container.id = 'stream-output';
            msgs.insertBefore(container, thinkingDiv);
          }
          fullReply += delta.content;
          // R0-116：若这是"任务清单"载荷，流中不按 Markdown 渲染（否则用户先看到一大段
          // 裸 JSON），等收尾时一次性换成清单节点（见 _finalizeChatStream）。
          if (!fullReply.startsWith('{"items":')) {
            clearNode(container);
            appendAll(container, renderMarkdown(fullReply));
          }
          scrollToBottom();
        }
        if (delta?.reasoning_content) {
          handleReasoning({ reasoning: delta.reasoning_content, sessionId: currentSessionId });
        }
      } catch (e) { console.error('[SSE] stream error:', e); }
    }
  }
  onReply(fullReply);
  return container;
}

function _finalizeChatStream(fullReply, container) {
  finishSend();
  const streamContainer = document.getElementById('stream-output');
  const wsReply = streamContainer ? streamContainer.textContent : '';
  const totalReply = fullReply || wsReply;

  // R0-116 修掉的真实缺陷：清单判定此前只在 'appendMsg()' 里，而**流式回复根本不经过
  // 'appendMsg'**（流里直接 'renderMarkdown'）⇒ 真实对话中"任务清单"一次都不会出现，
  // 只有刷新页面走历史恢复时才渲染出来（功能看着存在，实际只在回放时生效）。
  // 现在两条路径共用 'buildTodoList()'，收尾时把流式容器换成清单节点。
  if (totalReply) {
    const todo = buildTodoList(totalReply);
    if (todo) {
      if (container && container.isConnected) container.remove();
      if (streamContainer && streamContainer.isConnected) streamContainer.remove();
      msgs.appendChild(todo);
      msgs.scrollTop = msgs.scrollHeight;
      saveMessage(currentSessionId, { role: 'agent', text: totalReply, timestamp: Date.now() });
      showToolStats();
      return;
    }
  }
  const hasActiveTools = document.querySelector('.tool-group .msg.progress:not(.error)');
  const hasAgentReply = msgs.querySelectorAll('.msg.agent:not(.error):not(.thinking)').length > 0;

  if (!totalReply && !hasActiveTools && !hasAgentReply) {
    resetButtonState();
    if (container) {
      container.textContent = '回复为空，请检查模型端点是否可达';
      container.className = 'msg error';
    } else {
      appendError('回复为空，请检查模型端点是否可达');
    }
  } else if (totalReply) {
    saveMessage(currentSessionId, { role: 'agent', text: totalReply, timestamp: Date.now() });
    showToolStats();
  }

  if (totalReply && (totalReply.startsWith('[Error]') || totalReply.startsWith('[API Error]'))) {
    if (totalReply.includes('No API key')) {
      apiConfigured = false;
      if (container) container.remove();
      if (streamContainer) streamContainer.remove();
      appendSetup();
    } else if (container) {
      container.className = 'msg error';
    } else if (streamContainer) {
      streamContainer.className = 'msg error';
    }
  }
}

// 确保思考动画至少显示 500ms
async function ensureMinThinkingTime(shownAt) {
  const elapsed = Date.now() - shownAt;
  if (elapsed < 500) {
    await new Promise(resolve => setTimeout(resolve, 500 - elapsed));
  }
}
// 立即恢复按钮状态（用于错误情况）
function resetButtonState() {
  loading = false;
  sendBtn.textContent = '发送';
  sendBtn.style.background = '#7a9a8a';
  input.focus();
  input._sending = false;
  
  // 移除思考动画
  const thinking = document.getElementById('thinking');
  if (thinking) thinking.remove();
}

function finishSend() {
  // SSE 流结束，但任务可能还没完成（后端会通过 request.end 通知）
  // 不需要在这里做任何处理，让后端决定何时任务完成
}

function stopSend() {
  if (currentReader) {
    currentReader.cancel();
    currentReader = null;
  }
  resetButtonState();
}

function toggleSend() {
  if (loading) {
    stopSend();
  } else {
    doSend();
  }
}

// R0-114（P2-01）：登录框。凭证只写 sessionStorage（不写 localStorage，也不进 URL），
// 保存后立刻用它重连 WS 并刷新一次当前会话，避免"填了口令还要手动刷新页面"。
function openAuth() {
  const panel = document.getElementById('auth-panel');
  const input = document.getElementById('auth-input');
  if (!panel || !input) return;
  input.value = AUTH_TOKEN || '';
  panel.style.display = 'flex';
  input.focus();
}
function closeAuth() {
  const panel = document.getElementById('auth-panel');
  if (panel) panel.style.display = 'none';
}
function saveAuth() {
  const input = document.getElementById('auth-input');
  const val = (input && input.value || '').trim();
  try {
    if (val) sessionStorage.setItem('tusunsun_auth_token', val);
    else sessionStorage.removeItem('tusunsun_auth_token');
  } catch { /* 隐私模式：本次生效，不持久 */ }
  AUTH_TOKEN = val;
  authHeaders = AUTH_TOKEN ? { Authorization: 'Bearer ' + AUTH_TOKEN } : {};
  closeAuth();
  if (ws) { try { ws.close(); } catch { /* 已断开 */ } }
  connectWS();
  loadConfig();
}

function openSettings() {
  overlay.classList.add('show');
  document.getElementById('saveStatus').textContent = '';
}

function closeSettings() {
  overlay.classList.remove('show');
}

function sanitizeBaseUrl(input) {
  let v = input.trim();
  v = v.replace(/^(baseUrl|base_url|url|endpoint)\s*:\s*/i, '');
  v = v.replace(/\/+$/, '');
  if (v && !/^https?:\/\//i.test(v)) v = 'https://' + v;
  return v;
}

async function saveSettings() {
  const apiKeyInput = document.getElementById('cfgApiKey').value.trim();
  const model = document.getElementById('cfgModel').value.trim();
  const baseUrl = sanitizeBaseUrl(document.getElementById('cfgBaseUrl').value);
  const statusEl = document.getElementById('saveStatus');
  statusEl.className = 'save-status';
  statusEl.textContent = '保存中...';

  try {
    const body = {};
    if (apiKeyInput && !apiKeyInput.startsWith('sk-...')) {
      body.apiKey = apiKeyInput;
    }
    if (model) body.model = model;
    if (baseUrl) body.baseUrl = baseUrl;
    const maxTokens = parseInt(document.getElementById('cfgMaxTokens').value);
    if (maxTokens && maxTokens !== contextMaxTokens) {
      body.maxTokens = maxTokens;
      contextMaxTokens = maxTokens;
    }

    const resp = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify(body),
    });
    const result = await resp.json();
    if (result.ok) {
      statusEl.textContent = '已保存，下次对话即可生效';
      apiConfigured = true;
      if (apiKeyInput && !apiKeyInput.startsWith('sk-...')) {
        document.getElementById('cfgApiKey').value = 'sk-...' + apiKeyInput.slice(-4);
      }
      setTimeout(closeSettings, 1200);
    } else {
      statusEl.textContent = '保存失败: ' + (result.error || '未知错误');
      statusEl.className = 'save-status err';
    }
  } catch (e) {
    statusEl.textContent = '网络错误: ' + e.message;
    statusEl.className = 'save-status err';
  }
}

async function checkHealth() {
  try {
    const resp = await fetch('/health');
    const data = await resp.json();
    statusEl.textContent = data.status === 'ok' ? ' RUNNING ' + data.uptime : ' OFFLINE';
    statusEl.className = data.status === 'ok' ? 'ok' : '';
  } catch {
    statusEl.textContent = ' OFFLINE';
    statusEl.className = '';
  }
}

window.onerror = function(msg, url, line) { console.error('GLOBAL ERROR:', msg, 'at', url, line); };

document.getElementById('send').addEventListener('click', function() {
  if (loading) { stopSend(); } else { doSend(); }
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    doSend();
  }
});

setInterval(checkHealth, 10000);

function scrollToBottom() {
  const isAtBottom = msgs.scrollHeight - msgs.scrollTop <= msgs.clientHeight + 50;
  if (isAtBottom) msgs.scrollTop = msgs.scrollHeight;
}

function showToolStats() {
  if (toolStats.count === 0) return;
  const stats = document.getElementById('tool-stats');   // 同上：不遮蔽全局 el() 助手
  stats.className = '';
  stats.textContent = toolStats.count + ' 个工具 / ' + (toolStats.duration / 1000).toFixed(2) + 's';
  clearTimeout(stats._timer);
  stats._timer = setTimeout(() => stats.className = 'hidden', 3000);
}

function updateStatus() {
  const statusText = modelName + ' ' + (loading ? '生成中...' : 'RUNNING');
  statusEl.textContent = statusText;
}

function loadSessions() {
  try {
    const saved = localStorage.getItem('tusunsun_sessions');
    if (saved) {
      const parsed = JSON.parse(saved);
      Object.assign(sessions, parsed);
      const sessionIds = Object.keys(sessions);
      if (sessionIds.length > 0) currentSessionId = sessionIds[0];
    }
  } catch { /* 会话缓存读取失败忽略 */ }
}

function saveSessions() {
  try {
    localStorage.setItem('tusunsun_sessions', JSON.stringify(sessions));
  } catch { /* 会话持久化尽力而为 */ }
}

function loadHistory(sessionId) {
  clearNode(msgs);
  try {
    const saved = localStorage.getItem('tusunsun_history_' + sessionId);
    if (saved) {
      const history = JSON.parse(saved);
      const recent = history.slice(-50);
      
      let toolGroup = null;
      
      recent.forEach(msg => {
        if (msg.role === 'tool') {
          if (!toolGroup) {
            toolGroup = document.createElement('details');
            toolGroup.className = 'tool-group';
            toolGroup.open = false;
            const summary = document.createElement('summary');
            summary.textContent = ' 工具调用';
            toolGroup.appendChild(summary);
            msgs.appendChild(toolGroup);
          }
          
          const div = document.createElement('div');
          div.className = 'msg progress' + (msg.text.includes('[ERR]') ? ' error' : '');
          div.textContent = msg.text;
          toolGroup.appendChild(div);
        } else {
          toolGroup = null;
          
          const container = el('div', { class: 'msg ' + msg.role });
          if (msg.role === 'agent') {
            appendAll(container, renderMarkdown(msg.text));
          } else {
            container.textContent = msg.text;
          }
          msgs.appendChild(container);
        }
      });
    }
  } catch { /* 历史缓存读取失败忽略 */ }
}
function saveMessage(sessionId, msg) {
  try {
    const key = 'tusunsun_history_' + sessionId;
    let history = [];
    const saved = localStorage.getItem(key);
    if (saved) history = JSON.parse(saved);
    history.push(msg);
    if (history.length > 500) history = history.slice(-500);
    localStorage.setItem(key, JSON.stringify(history));
  } catch { /* 历史持久化尽力而为 */ }
}

function switchSession(sessionId) {
  if (!sessions[sessionId]) return;
  currentSessionId = sessionId;
  loadHistory(sessionId);
  updateSessionSelect();
}

function createSession() {
  sessionCounter++;
  const id = 'session_' + sessionCounter;
  sessions[id] = { name: '会话 ' + sessionCounter, messages: [] };
  currentSessionId = id;
  clearNode(msgs);
  saveSessions();
  updateSessionSelect();
}

function deleteSession(sessionId) {
  if (Object.keys(sessions).length <= 1) return;
  delete sessions[sessionId];
  localStorage.removeItem('tusunsun_history_' + sessionId);
  if (currentSessionId === sessionId) {
    currentSessionId = Object.keys(sessions)[0];
    loadHistory(currentSessionId);
  }
  saveSessions();
  updateSessionSelect();
}

function updateSessionSelect() {
  const select = document.getElementById('sessionSelect');
  clearNode(select);
  Object.entries(sessions).forEach(([id, session]) => {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = session.name;
    if (id === currentSessionId) option.selected = true;
    select.appendChild(option);
  });
  
  const addBtn = document.createElement('option');
  addBtn.value = '__new__';
  addBtn.textContent = '+ 新建会话';
  select.appendChild(addBtn);
  // 变更处理已由文件上方的 on('sessionSelect', 'change', …) 一次性注册，此处不再重挂。
}
</script>
</body>
</html>`);
  }

  async stop() {}
}

export default new ChatUIPlugin();
