// R0-116（P0-01）：**真实浏览器**的网页 UI 注入负例回归。
//
// ── 为什么必须是真浏览器 ─────────────────────────────────────────────────
// 第三轮报告的原文是对的："危险 DOM 结构已复现"与"浏览器 JS 实际执行已验证"是两件事。
// 前者用字符串比对就能做（`test-r0-116` 的 U 系列），后者只有在真解析器 + 真 CSP 引擎里
// 才能证明。本文件用 CDP 驱动 headless Chromium：
//   · 走**真实消息流**（页面 → 网关 → 假模型 SSE → 网关 → 页面流式渲染），不是直接调渲染函数；
//   · 载荷是报告里那条原始 Markdown，以及同族的链接/todo/历史恢复三类 sink；
//   · 断言不是"字符串里没有 onerror"，而是 `window.__qa_*` **真的没有被写**、DOM 里
//     **真的没有** `on*` 属性、`href` 里**真的没有** `javascript:`；
//   · 另有一条**正向**用例：正常 Markdown 仍要渲染出标题/粗体/代码高亮，防止"靠删功能来修漏洞"。
//   · 还有一条 CSP 用例：手工 `insertAdjacentHTML` 注入 `onerror=`，断言 CSP 把它拦下来
//     ——这才叫"纵深防御真的生效"，而不是"我们写了这个响应头"。
//
// 依赖：Chromium 可执行文件 + `ws`（运行期唯一依赖）。缺任一项 → `noteSkip` 记为 NOT_RUN，
// **绝不**当作通过（TT_REQUIRE_PRECONDITIONS=1 时跳过会直接失败，供发布档门禁使用）。
import { readFileSync, existsSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assert, assertEquals } from '../harness.mjs';
import { spawnManaged } from '../lib/proc.mjs';
import { findBrowser, launchBrowser, loadWs, isNavigationBlockedByPolicy } from '../lib/cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const ENTRY = join(ROOT, 'tusunsun.mjs');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');

const HERMETIC = {
  TUSUNSUN_STATE_DIR: '', TUSUNSUN_PORT: '',
  TUSUNSUN_API_KEY: '', LLM_API_KEY: '', TUSUNSUN_BASE_URL: '', TUSUNSUN_MODEL: '',
  TUSUNSUN_GATEWAY_KEY: '', TUSUNSUN_ALLOW_REMOTE: '', TUSUNSUN_MODEL_HEADERS: '', TUSUNSUN_PROFILE: '',
};

const GATEWAY_KEY = 'qa-gateway-key-r0116';

// ── 攻击载荷（全部只用本地无害标记，不做任何外传）─────────────────────────
//
// 注意：**触发词与回复内容必须分开**。页面把消息发给网关后，网关会把该会话的**历史**一并
// 上送模型，所以"用 `asked.includes('PAYLOAD_X')` 挑回复"从第二轮起必然选错（历史里还留着
// 上一个载荷）。假模型只认**最后一条 user 消息**，且回复内容是**纯净载荷**——不能加前缀，
// 否则 todo 用例就踩不到 `text.startsWith('{"items":')` 这条真实分支（第一版就是这么假绿的）。
const TRIGGER_IMG = 'QA_TRIGGER_IMG';
const TRIGGER_JS = 'QA_TRIGGER_JS';
const TRIGGER_TODO = 'QA_TRIGGER_TODO';
const TRIGGER_OK = 'QA_TRIGGER_OK';

/** 报告里的原始载荷：`src` 属性的值里带引号与一个事件处理属性。 */
const REPLY_IMG = '![demo](broken" onerror="window.__qa_marker=1)';
/** 链接协议：明文 `javascript:` + 用制表符把 `javascript:` 拆开的绕过写法。 */
const REPLY_JS = '[click](javascript:window.__qa_click=1) [tab](java\u0009script:window.__qa_click=2)';
/** todo JSON：`id` 与 `content` 都试图逃出属性/元素上下文。必须**以 `{"items":` 开头**。 */
const TODO_ID = 'x" onmouseover="window.__qa_marker=2';
const TODO_CONTENT = '<img src=x onerror="window.__qa_marker=3">';
const REPLY_TODO = JSON.stringify({ items: [{ id: TODO_ID, content: TODO_CONTENT, status: 'pending' }] });
/** 正常 Markdown：用来证明渲染功能没有被"删掉"。 */
const REPLY_OK = [
  '# 标题一', '', '**粗体** 与 `行内代码` 与 [正常链接](https://example.com/x)', '',
  '```js', 'const answer = 42;', '```', '',
  '| 列 A | 列 B |', '| --- | --- |', '| 1 | 2 |',
].join('\n');

/** 假模型：按用户消息挑回复；`stream` 决定回 SSE 还是普通 JSON。 */
function startMockModel() {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c.toString(); });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch { /* 忽略 */ }
      seen.push(parsed);
      // 只看**最后一条 user 消息**：网关会把整个会话历史一并上送，用整串 `JSON.stringify`
      // 匹配会被历史里的旧载荷带偏（实测：第 2 轮起全部回成第 1 轮的载荷）。
      const users = (parsed.messages || []).filter((m) => m.role === 'user');
      const last = String(users.length ? users[users.length - 1].content : '');
      let reply = 'MOCK_DEFAULT';
      if (last.includes(TRIGGER_IMG)) reply = REPLY_IMG;
      else if (last.includes(TRIGGER_JS)) reply = REPLY_JS;
      else if (last.includes(TRIGGER_TODO)) reply = REPLY_TODO;
      else if (last.includes(TRIGGER_OK)) reply = REPLY_OK;

      if (!parsed.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
        }));
        return;
      }
      // 故意**分片**下发：让页面的"增量渲染"路径（每片都重渲染 fullReply）也被覆盖到，
      // 而不是只测"最后一次性渲染完整文本"。
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      for (let i = 0; i < reply.length; i += 7) {
        const piece = reply.slice(i, i + 7);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece }, index: 0 }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return {
    server,
    seen,
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', r)),
    close: () => new Promise((r) => server.close(r)),
    port: () => server.address().port,
  };
}

function spawnGateway(stateDir, mockPort) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
    activeScene: 'gateway',
    gateway: { host: '127.0.0.1', port: 0, apiKey: GATEWAY_KEY },
    model: { model: 'mock', baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: 'mock-key' },
  }, null, 2));
  const runtimePath = join(stateDir, 'gateway.runtime.json');
  const gw = spawnManaged(process.execPath, [ENTRY, 'start', '--port', '0', '--state-dir', stateDir, '--yes'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...HERMETIC },
  });
  let out = '';
  gw.stdout.on('data', (b) => { out += b.toString(); });
  gw.stderr.on('data', (b) => { out += b.toString(); });
  return {
    out: () => stripAnsi(out),
    port: async () => {
      const t0 = Date.now();
      for (;;) {
        if (existsSync(runtimePath)) {
          try {
            const rt = JSON.parse(readFileSync(runtimePath, 'utf8'));
            if (typeof rt.port === 'number' && rt.port > 0) return rt.port;
          } catch { /* 文件正在写 */ }
        }
        if (Date.now() - t0 > 60000) throw new Error(`网关未就绪：\n${stripAnsi(out).slice(-1200)}`);
        await new Promise((r) => setTimeout(r, 150));
      }
    },
    stop: async () => { await gw.reap(); },
  };
}

/**
 * 页面侧探针：一次求值取回全部判据（marker / 属性 / href / 文本）。
 *
 * `offset` = "只看这次新追加的消息节点"。必须能按范围取，原因是：这一套用例刻意**共用同一个
 * 会话**（`session_0`），历史会累积（这正是现实情形，也让"历史恢复"路径自然被覆盖）。
 * 若全量取，`imgCount` 之类的计数会随前面用例变化 —— 断言会变得既脆弱又难解释。
 * 注意：判定仍然扫**整个范围**的每个元素的每个属性，绝不只看 `img` 一个点。
 */
const probeExpr = (offset) => `(() => {
  const box = document.getElementById('messages');
  const scope = [...box.children].slice(${Number(offset) || 0});
  const attrNames = [];
  const nodes = [];
  for (const root of scope) {
    nodes.push(root);
    for (const n of root.querySelectorAll('*')) nodes.push(n);
  }
  for (const n of nodes) for (const a of n.attributes) attrNames.push(n.tagName.toLowerCase() + '@' + a.name);
  const q = (sel) => { for (const r of scope) { const hit = r.matches && r.matches(sel) ? r : r.querySelector(sel); if (hit) return hit; } return null; };
  const qa = (sel) => { const out = []; for (const r of scope) { if (r.matches && r.matches(sel)) out.push(r); for (const n of r.querySelectorAll(sel)) out.push(n); } return out; };
  const img = q('img');
  const cb = q('.todo-cb');
  const textEl = q('.todo-text');
  return {
    scopeSize: scope.length,
    marker: window.__qa_marker === undefined ? null : window.__qa_marker,
    click: window.__qa_click === undefined ? null : window.__qa_click,
    cspProbe: window.__qa_csp === undefined ? null : window.__qa_csp,
    onAttrs: attrNames.filter((s) => /@on/i.test(s)),
    imgCount: qa('img').length,
    img: img ? {
      src: img.getAttribute('src'), alt: img.getAttribute('alt'),
      attrCount: img.attributes.length, hasOnerror: img.hasAttribute('onerror'),
    } : null,
    jsHrefs: qa('a[href]').map((a) => a.getAttribute('href')).filter((h) => /^\\s*javascript:/i.test(h)).length,
    okHref: qa('a[href]').some((a) => String(a.getAttribute('href')).startsWith('https://example.com')),
    blockedLinks: qa('.blocked-link').length,
    todo: cb ? { id: cb.getAttribute('data-id'), attrs: [...cb.attributes].map((a) => a.name) } : null,
    todoText: textEl ? textEl.textContent : null,
    todoImg: qa('.todo-text img').length,
    h1: qa('h1').length,
    strong: qa('strong').length,
    codeKw: qa('pre code .kw').length,
    table: qa('table td').length,
  };
})()`;

/** 发一条消息（走真实 UI：填 textarea + 点发送按钮）。 */
function sendExpr(text) {
  return `(() => {
    const i = document.getElementById('input');
    i.value = ${JSON.stringify(text)};
    document.getElementById('send').click();
    return true;
  })()`;
}

export async function setup(runner) {
  const browserPath = findBrowser();
  const WebSocket = await loadWs();
  const chatUi = ['plugins/chat-ui.js', 'plugins/chat-ui.js'].find((p) => existsSync(join(ROOT, p)));
  const reason = !chatUi ? '本检出形态不含 chat-ui.js'
    : !browserPath ? '未找到 Chromium 系可执行文件（可设 TUSUNSUN_CHROME_PATH）'
      : !WebSocket ? '未安装 `ws`，无法连接 DevTools 协议'
        : null;

  if (reason) {
    // 前置缺失 → NOT_RUN，绝不记 PASS。TT_REQUIRE_PRECONDITIONS=1 时 noteSkip 会直接抛错。
    runner.test('R0-116/B* 真实浏览器负例回归（需要 Chromium + ws）', () => {
      runner.noteSkip(`真实浏览器回归未运行：${reason}`);
    });
    return;
  }

  // ── 环境在 beforeAll 里搭一次，各用例共用同一会话；teardown 落在 afterAll ──
  // 必须用钩子：`setup()` 只负责**注册**用例，真正执行发生在它返回之后。
  const ctx = { mock: null, gw: null, browser: null, session: null, port: null, headers: null, initial: null };

  const idle = () => ctx.browser.waitFor(ctx.session, 'loading === false', { what: '界面空闲', timeoutMs: 40000 });

  /**
   * R0-118（第四轮 P1-04）：导航被**环境策略**拒绝时，整组用例必须记 NOT_RUN，而不是
   * 以"等待超时"的面貌砸成失败 —— 更不能用"header 存在"冒充"浏览器强制执行过"。
   * 只有明确属于策略阻断（net::ERR_BLOCKED_BY_ADMINISTRATOR 等）才走这条路；
   * 连不上 / DNS / 证书照常失败，不给"环境"当万能免检借口。
   */
  const test = (name, fn) => runner.test(name, async (...a) => {
    if (ctx.blocked) return runner.noteSkip(`浏览器导航被环境策略拒绝（${ctx.blocked}）⇒ 本条 NOT_RUN，不计通过`);
    return fn(...a);
  });

  /**
   * 走真实 UI 发一条消息，返回**只针对本次新增消息节点**的探针结果。
   *
   * 刻意**不刷新页面**：`Page.reload` 会销毁 CDP 的执行上下文，在途的 `Runtime.evaluate`
   * 响应可能永远不来（实测把整个用例挂死）。历史恢复路径由 B4 单独用一次 reload 覆盖。
   */
  const send = async (text, readyExpr, what) => {
    await idle();
    const offset = await ctx.browser.evaluate(ctx.session, "document.getElementById('messages').children.length");
    await ctx.browser.evaluate(ctx.session, sendExpr(text));
    // 关键：先确认"发送被受理"。少了这一步，失败会以"等待渲染超时"的面貌出现，
    // 让人误以为是渲染问题（实测踩过）。
    await ctx.browser.waitFor(ctx.session, 'loading === true', { what: '发送被受理', timeoutMs: 15000 });
    await ctx.browser.waitFor(ctx.session, readyExpr, { what, timeoutMs: 40000 });
    await idle();
    // 给"假如有脚本要执行"留出执行窗口 —— "没执行"必须在**等待之后**仍然成立。
    await new Promise((r) => setTimeout(r, 800));
    return ctx.browser.evaluate(ctx.session, probeExpr(offset));
  };

  runner.beforeAll(async () => {
    ctx.mock = startMockModel();
    await ctx.mock.listen();
    const stateDir = mkdtempSync(join(tmpdir(), 'r116-browser-'));
    ctx.gw = spawnGateway(join(stateDir, 'state'), ctx.mock.port());
    ctx.port = await ctx.gw.port();
    ctx.browser = await launchBrowser();
    ctx.session = (await ctx.browser.newPage()).sessionId;
    // 首次用**兼容路径**（?token=）进来：既验证"读到就搬进 sessionStorage 并从地址栏抹掉"，
    // 也让后续所有请求都带上凭证（控制面鉴权是打开的）。
    // 注：这条兼容路径在修 `pathnameOf()` 之前是 **404**（网关拿 query 串当路径查表）。
    try {
      await ctx.browser.goto(ctx.session, `http://127.0.0.1:${ctx.port}/?token=${GATEWAY_KEY}`);
    } catch (err) {
      if (!isNavigationBlockedByPolicy(err)) throw err;   // 其它错误照常失败
      ctx.blocked = err.errorText;
      // 页面级用例整组转 NOT_RUN；但服务端侧的事实（CSP 头）仍由下面的 Node fetch 采集。
      console.log(`       [NOT_RUN] 导航被环境策略拒绝：${err.errorText}（页面对本环境不可达，非产品缺陷）`);
      return;
    }
    await ctx.browser.waitFor(ctx.session, "!!document.getElementById('input') && !!document.getElementById('send')", { what: '聊天页就绪' });
    // `/api/config` 走通（⇒ 口令有效、`apiConfigured === true`）才算就绪：否则 `doSend` 会
    // 转去弹设置面板，用例会以"消息没渲染"的面貌失败（实测踩过）。
    await ctx.browser.waitFor(ctx.session,
      "apiConfigured === true && document.getElementById('status').textContent.includes('RUNNING')",
      { what: '控制面就绪（口令有效 / 模型已配置）', timeoutMs: 30000 });
    ctx.initial = await ctx.browser.evaluate(ctx.session, `({
      search: location.search,
      stored: sessionStorage.getItem('tusunsun_auth_token'),
    })`);
    const r = await fetch(`http://127.0.0.1:${ctx.port}/`);
    ctx.headers = { csp: r.headers.get('content-security-policy'), nosniff: r.headers.get('x-content-type-options') };
  });

  runner.afterAll(async () => {
    try { if (ctx.browser) await ctx.browser.close(); } catch { /* 已关闭 */ }
    try { if (ctx.gw) await ctx.gw.stop(); } catch { /* 已回收 */ }
    try { if (ctx.mock) await ctx.mock.close(); } catch { /* 已关闭 */ }
  });

  // ── B1 真实消息流：图片属性注入 ───────────────────────────────────────
  test('R0-116/B1 报告原始载荷经真实消息流后**不产生** onerror 属性、脚本不执行（流式增量渲染路径）', async () => {
    const r = await send(TRIGGER_IMG, "document.querySelectorAll('#messages img').length > 0", '图片渲染');
    assertEquals(r.marker, null, '注入的事件处理脚本被浏览器执行了（window.__qa_marker 被写）');
    assertEquals(r.onAttrs.length, 0, `本次消息里出现了 on* 属性：${r.onAttrs.join(', ')}`);
    assert(r.img, '图片没有渲染出来（不能靠"渲染失败"来躲过攻击）');
    assertEquals(r.img.hasOnerror, false, 'img 上真的存在独立的 onerror 属性');
    // 载荷里的引号必须**留在 src 的值里**，而不是分裂成第二个属性。
    assertEquals(r.img.src, 'broken" onerror="window.__qa_marker=1', 'src 的值必须原样保留（证明引号没有逃出属性）');
    assertEquals(r.img.attrCount, 2, `img 只应有 src/alt 两个属性，实得 ${r.img.attrCount}`);
  });

  // ── B2 链接协议 ──────────────────────────────────────────────────────
  test('R0-116/B2 `javascript:` 链接（含制表符拆分绕过）不得落成可点 href，也不得执行', async () => {
    const r = await send(TRIGGER_JS, "document.querySelectorAll('#messages .blocked-link').length > 0", '危险链接被判为禁用');
    assertEquals(r.marker, null, '脚本被执行');
    assertEquals(r.click, null, 'javascript: 链接被点击执行了（window.__qa_click 被写）');
    assertEquals(r.jsHrefs, 0, '本次消息里存在 javascript: 的 href');
    assertEquals(r.blockedLinks, 2, `两条危险链接都应降级为不可点文本，实得 ${r.blockedLinks}`);
    assertEquals(r.onAttrs.length, 0, `出现 on* 属性：${r.onAttrs.join(', ')}`);
  });

  // ── B3 todo JSON ────────────────────────────────────────────────────
  test('R0-116/B3 `{"items":…}` todo 载荷：data-id 原样成值，不新增属性、不渲染内部 HTML', async () => {
    const r = await send(TRIGGER_TODO, "!!document.querySelector('#messages .todo-cb')", '任务清单渲染');
    assertEquals(r.marker, null, 'todo 载荷里的脚本被执行');
    assert(r.todo, '任务清单没有渲染出来');
    assertEquals(r.todo.id, TODO_ID, 'data-id 的值必须是原样字符串（引号不能逃出属性）');
    assert(!r.todo.attrs.includes('onmouseover'), `checkbox 上出现了 onmouseover：${r.todo.attrs.join(', ')}`);
    assertEquals(r.onAttrs.length, 0, `出现 on* 属性：${r.onAttrs.join(', ')}`);
    assertEquals(r.todoImg, 0, 'todo 文本里的 <img> 被当成 HTML 渲染了');
    assertEquals(r.todoText, TODO_CONTENT, 'todo 文本必须以字面量形式呈现');
  });

  // ── B4 历史恢复路径（唯一需要 reload 的用例）─────────────────────────
  test('R0-116/B4 刷新页面走 localStorage 历史恢复路径，仍然不执行、不产生 on* 属性', async () => {
    await send(TRIGGER_IMG, "document.querySelectorAll('#messages img').length > 0", '图片渲染');
    const sid = await ctx.browser.evaluate(ctx.session, 'currentSessionId');
    await ctx.browser.reload(ctx.session);
    await ctx.browser.waitFor(ctx.session, "!!document.getElementById('sessionSelect')", { what: '页面复位' });
    // 显式切回刚才那个会话，确保走的就是 `loadHistory()` 渲染路径。
    await ctx.browser.evaluate(ctx.session, `switchSession(${JSON.stringify(sid)}); true`);
    await ctx.browser.waitFor(ctx.session, "document.querySelectorAll('#messages img').length > 0", { what: '历史恢复渲染' });
    await new Promise((r) => setTimeout(r, 800));
    const r = await ctx.browser.evaluate(ctx.session, probeExpr(0));   // 恢复后全量扫（历史里全是本轮的载荷）
    assertEquals(r.marker, null, '历史恢复路径上脚本被执行');
    assertEquals(r.onAttrs.length, 0, `历史恢复后出现 on* 属性：${r.onAttrs.join(', ')}`);
    assertEquals(r.img.hasOnerror, false, '历史恢复后 img 上有独立的 onerror 属性');
    assert(r.imgCount >= 1, '历史没有恢复出图片（说明这条路径根本没被走到）');
  });

  // ── B5 CSP 真的拦住内联事件处理属性 ─────────────────────────────────
  test('R0-116/B5 CSP 生效：响应头带 nonce 且无 unsafe-inline；手工注入的 onerror 不执行', async () => {
    assert(ctx.headers.csp, '页面响应缺少 Content-Security-Policy 头');
    assert(/script-src 'nonce-/.test(ctx.headers.csp), `script-src 未基于 nonce：${ctx.headers.csp}`);
    assert(!/script-src[^;]*unsafe-inline/.test(ctx.headers.csp), `script-src 含 unsafe-inline，等于没防内联事件：${ctx.headers.csp}`);
    assertEquals(ctx.headers.nosniff, 'nosniff', '缺少 X-Content-Type-Options: nosniff');
    assertEquals(ctx.initial.search, '', '兼容路径读到的 token 必须从地址栏抹掉（history.replaceState）');
    assertEquals(ctx.initial.stored, GATEWAY_KEY, '兼容路径的 token 必须搬进 sessionStorage（后续请求靠它）');

    // 绕过应用层净化，直接把内联事件处理属性塞进 DOM —— 这一层只有 CSP 能拦。
    await ctx.browser.evaluate(ctx.session, "document.getElementById('csp-probe')?.remove(); document.body.insertAdjacentHTML('beforeend', '<img id=\"csp-probe\" src=\"/definitely-missing.png\" onerror=\"window.__qa_csp=1\">'); true");
    await new Promise((r) => setTimeout(r, 1500));       // 等 onerror 有机会触发
    const got = await ctx.browser.evaluate(ctx.session, 'window.__qa_csp === undefined ? null : window.__qa_csp');
    assertEquals(got, null, 'CSP 没有拦住内联 onerror —— 纵深防御实际失效');
    const probeAttrs = await ctx.browser.evaluate(ctx.session, "[...document.getElementById('csp-probe').attributes].map((a) => a.name)");
    assert(probeAttrs.includes('onerror'), '（前提校验）探针元素本身应当仍带 onerror 属性，说明它确实是被 CSP 而非解析器拦下的');

    // ② 内联 <script> 也必须被拦住（script-src 只给 nonce，没有 unsafe-inline）。
    //    这是第四轮评审要求补的那条："在真实浏览器里、施加服务器 CSP 头之后"的脚本执行反例。
    await ctx.browser.evaluate(ctx.session, `(() => {
      const s = document.createElement('script');
      s.textContent = 'window.__qa_inline_script = 1;';
      document.body.appendChild(s);
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 800));
    const inlineRan = await ctx.browser.evaluate(ctx.session, 'window.__qa_inline_script === undefined ? null : window.__qa_inline_script');
    assertEquals(inlineRan, null, 'CSP 没有拦住插入 DOM 的内联 <script>（script-src 的 nonce 形同虚设）');

    // ③ eval **不做断言**，原因必须写下来：CDP 的 `Runtime.evaluate` 是调试器级别的求值，
    //    Chrome 对它**按设计绕过页面 CSP**，所以在里面调 eval 测到的是"调试器没被拦"，
    //    不是"页面没被拦"。实测（R0-118）：`(0, eval)(…)` 在注入的求值里照样执行。
    //    与其写一条自我安慰的断言，不如如实标注这一层**未覆盖**。
    const evalOutcome = await ctx.browser.evaluate(ctx.session,
      "(() => { try { (0, eval)('window.__qa_eval = 1'); return 'ran'; } catch (e) { return 'blocked'; } })()");
    console.log(`       [NOT_RUN] unsafe-eval 未被本门禁覆盖（CDP 求值按设计绕过页面 CSP，实测 outcome=${evalOutcome}）`);
    console.log(`       [实测] CSP 强制执行：内联 onerror ✗、内联 <script> ✗（两者都是页面级，受服务器 CSP 管辖）`);
  });

  // ── B6 正常功能不能回归 ─────────────────────────────────────────────
  test('R0-116/B6 正常 Markdown 仍然渲染（标题/粗体/代码高亮/表格/合法链接）—— 不是靠删功能换安全', async () => {
    const r = await send(TRIGGER_OK, "!!document.querySelector('#messages h1')", '正常 Markdown 渲染');
    assertEquals(r.h1, 1, '标题没有渲染');
    assert(r.strong >= 1, '粗体没有渲染');
    assert(r.codeKw >= 1, '代码块语法高亮（.kw）没有渲染');
    assert(r.table >= 2, '表格没有渲染');
    assert(r.okHref, '合法 https 链接没有渲染成 <a href>');
    assertEquals(r.jsHrefs, 0, '合法链接之外混进了 javascript: href');
    assertEquals(r.marker, null, '正常用例里出现了注入执行（说明判定被污染）');
  });

  // 收尾断言：这一轮跑完，假模型确实被调用过（防止"页面根本没发请求"导致全绿假象）。
  test('R0-116/B7 前提校验：上述用例确实经过了"页面 → 网关 → 模型"的真实链路', () => {
    assert(ctx.mock.seen.length >= 5, `假模型只收到 ${ctx.mock.seen.length} 次请求，用例链路不成立`);
    assert(ctx.mock.seen.some((b) => b.stream === true), '没有任何一条是流式请求，说明流式渲染路径没被覆盖');
    console.log(`       [实测] 假模型收到 ${ctx.mock.seen.length} 次请求；网关输出尾部：${ctx.gw.out().slice(-160).replace(/\n/g, ' | ')}`);
  });
}

export default setup;
