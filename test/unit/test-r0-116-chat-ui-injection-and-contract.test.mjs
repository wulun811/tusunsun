// R0-116：第三轮独立实测与发布验收报告（2026-10-19，对象 = 原始制品 tusunsun-0.9.7.tgz）整改的
// **随包门禁**。逐条钉住报告里的可机械判定项，每个判据都做过**变异验证**（把修复还原 → 必红）：
//
//   P0  UI HTML 注入（发布阻断）
//     U1 结构不变量：chat-ui 里 `.innerHTML =` / `outerHTML` / `insertAdjacentHTML` / `document.write`
//        出现次数必须为 0；`escapeHtml` 这种"转义后照拼"的拐杖不得回归
//     U2 `safeUrl()` 行为：真函数、真入参（含 `java\tscript:` 这类控制字符绕过）
//     U3 CSP：真调用 `_serveChat()`，检查响应头与产出的 HTML（含"零内联事件属性"）
//     U4 `appendTodoList` 不得再把 `item.id` 拼进 HTML 字符串
//     U5 渲染器必须经 `createTextNode`/`setAttribute` 进 DOM，且源码里不得再有 `<img src="`
//     U6 同类 sink 台账：全仓 `.innerHTML =` 的文件集合必须恰好等于已知（且**不在发布物内**）的两处
//   P2  协议与文档收口
//     U7 `session_id: ""` 的语义在 代码 / 文档 / 真实 HTTP 三处一致
//     U8 README 主流程不再推荐 `?token=` 形式
//
// 真实浏览器的负例回归在 `test/integration/chat-ui-browser-security.test.mjs`（CDP + headless
// Chromium，零新增依赖）——本文件负责"结构 + 契约 + 真 HTTP"，浏览器文件负责"真的不执行"。
import { readFileSync, existsSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TestRunner, assert, assertEquals } from '../harness.mjs';
import { spawnManaged } from '../lib/proc.mjs';
import { assertSessionId } from '../../plugins/tools/lib/session-id.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const ENTRY = join(ROOT, 'tusunsun.mjs');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
const DOCS = existsSync(join(ROOT, 'updocs')) ? 'updocs' : 'docs';

/** v0.9.25：装配根只有 `plugins/` 一处（此前要在 `src/builtin/` 与 `plugins/` 之间二选一）。 */
function resolveFile(name) {
  const rel = `plugins/${name}`;
  return existsSync(join(ROOT, rel)) ? rel : null;
}

const CHAT_UI_REL = resolveFile('chat-ui.js');

const HERMETIC = {
  TUSUNSUN_STATE_DIR: '', TUSUNSUN_PORT: '',
  TUSUNSUN_API_KEY: '', LLM_API_KEY: '', TUSUNSUN_BASE_URL: '', TUSUNSUN_MODEL: '',
  TUSUNSUN_GATEWAY_KEY: '', TUSUNSUN_ALLOW_REMOTE: '', TUSUNSUN_MODEL_HEADERS: '', TUSUNSUN_PROFILE: '',
};

/** 剥掉 JS 注释后的源码：结构判据必须看**代码**，不能被注释里的示例字样误伤。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * 从源码里按名字取出一个函数的源码文本（用于在 Node 里跑**真函数**而不是复述实现）。
 * 用花括号配对，不依赖缩进。
 */
function extractFunction(src, name) {
  const head = src.indexOf(`function ${name}(`);
  assert(head >= 0, `源码里找不到 function ${name}()`);
  const open = src.indexOf('{', head);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(head, i + 1);
    }
  }
  throw new Error(`function ${name}() 花括号不配对`);
}

async function waitFor(fn, { timeoutMs = 40000, what = '条件' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待${what}超时（${timeoutMs}ms）`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

function spawnGateway(stateDir) {
  const runtimePath = join(stateDir, 'gateway.runtime.json');
  const gw = spawnManaged(process.execPath, [ENTRY, 'start', '--port', '0', '--state-dir', stateDir, '--yes'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...HERMETIC },
  });
  let out = '';
  gw.stdout.on('data', (b) => { out += b.toString(); });
  gw.stderr.on('data', (b) => { out += b.toString(); });
  return {
    out: () => stripAnsi(out),
    port: async () => waitFor(() => {
      if (!existsSync(runtimePath)) return null;
      try {
        const rt = JSON.parse(readFileSync(runtimePath, 'utf8'));
        return typeof rt.port === 'number' && rt.port > 0 ? rt.port : null;
      } catch { return null; }
    }, { what: '运行期端口文件' }),
    stop: async () => { await gw.reap(); },
  };
}

/** 真调用插件的 `_serveChat()`，拿回真实响应头与真实 HTML（不是 grep 源码）。 */
async function serveChatPage(plugin) {
  const captured = { headers: null, body: null };
  const res = {
    writeHead(code, headers) { captured.code = code; captured.headers = headers; return this; },
    end(body) { captured.body = body; },
  };
  await plugin._serveChat({ method: 'GET', url: '/', headers: {} }, res);
  return captured;
}

function cspDirective(csp, name) {
  const m = String(csp).split(';').map((s) => s.trim()).find((s) => s.toLowerCase().startsWith(name.toLowerCase() + ' '));
  return m || '';
}

export async function setup(runner) {
  if (!CHAT_UI_REL) {
    runner.test('R0-116 前置：chat-ui 插件文件存在', () => {
      runner.noteSkip('本检出形态不含 chat-ui.js（plugins/ 顶层与一级子目录下都没有）');
    });
    return;
  }

  const chatUiSrc = read(CHAT_UI_REL);
  const chatUiCode = stripComments(chatUiSrc);

  // ── U1 结构不变量 ────────────────────────────────────────────────────────
  runner.test('R0-116/U1 chat-ui 里不存在任何字符串拼 HTML 的 sink（innerHTML/outerHTML/insertAdjacentHTML/document.write）', () => {
    const sinks = [
      [/\.innerHTML\s*=/, '.innerHTML ='],
      [/\.outerHTML\s*=/, '.outerHTML ='],
      [/insertAdjacentHTML\s*\(/, 'insertAdjacentHTML('],
      [/document\.write\s*\(/, 'document.write('],
    ];
    for (const [re, label] of sinks) {
      const hit = chatUiCode.match(re);
      assert(!hit, `chat-ui 代码里仍有 ${label}（本轮 P0 的根因就是这个形态）：${hit && hit[0]}`);
    }
    // `escapeHtml` 是"转义后照拼字符串"的拐杖；留着它等于给回归留门。
    assert(!/function escapeHtml\s*\(/.test(chatUiCode), '不允许回归 `escapeHtml` 这种"转义后照样拼 HTML"的写法');
    assert(!/\bescapeHtml\s*\(/.test(chatUiCode), '仍有 escapeHtml() 调用点');
    // 必须有 DOM 构造路径（否则上一条可能因为"功能被删光"而假绿）。
    assert(/createTextNode\s*\(/.test(chatUiCode), 'chat-ui 必须用 createTextNode 承载不可信文本');
    assert(/setAttribute\s*\(/.test(chatUiCode), 'chat-ui 必须用 setAttribute 承载属性');
  });

  runner.test('R0-116/U1b 属性白名单里没有 on*/style/srcdoc，协议白名单里没有 javascript:/data:', () => {
    const safeAttrs = extractFunction(chatUiSrc, 'el');           // el() 是唯一写属性的地方
    assert(/SAFE_ATTRS\.has\(name\)/.test(safeAttrs), 'el() 必须对属性名做白名单判定');
    const listMatch = chatUiSrc.match(/const SAFE_ATTRS = new Set\(\[([\s\S]*?)\]\)/);
    assert(listMatch, '未找到 SAFE_ATTRS 白名单定义');
    const attrs = listMatch[1].match(/'[^']+'/g).map((s) => s.slice(1, -1));
    for (const bad of ['style', 'srcdoc', 'formaction', 'action']) {
      assert(!attrs.includes(bad), `SAFE_ATTRS 不该包含 ${bad}`);
    }
    assert(!attrs.some((a) => /^on/i.test(a)), `SAFE_ATTRS 不该包含任何 on* 事件属性：${attrs.filter((a) => /^on/i.test(a))}`);
    for (const [name, banned] of [['LINK_PROTOCOLS', 'javascript:'], ['LINK_PROTOCOLS', 'data:'], ['IMG_PROTOCOLS', 'javascript:'], ['IMG_PROTOCOLS', 'data:']]) {
      const m = chatUiSrc.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`));
      assert(m, `未找到 ${name}`);
      assert(!m[1].includes(`'${banned}'`), `${name} 不该放行 ${banned}`);
    }
  });

  // ── U2 safeUrl 真行为 ───────────────────────────────────────────────────
  runner.test('R0-116/U2 safeUrl()：真函数真跑（javascript:/data:/控制字符绕过一律 null，相对路径与 http(s) 放行）', () => {
    const fnSrc = extractFunction(chatUiSrc, 'safeUrl');
    const protocolsSrc = ['LINK_PROTOCOLS', 'IMG_PROTOCOLS']
      .map((n) => chatUiSrc.match(new RegExp(`const ${n} = new Set\\(\\[[\\s\\S]*?\\]\\);`))[0]).join('\n');
    // safeUrl 只用 String/URL，无 DOM 依赖 ⇒ 可以在 Node 里直接跑**源码本体**。
    const factory = new Function(`${protocolsSrc}\n${fnSrc}\nreturn safeUrl;`);
    const safeUrl = factory();

    // 拒绝面（报告里的原始载荷与常见绕过）
    assertEquals(safeUrl('javascript:alert(1)', 'link'), null, 'javascript: 链接必须拒绝');
    assertEquals(safeUrl('JaVaScRiPt:alert(1)', 'link'), null, '协议判定必须大小写不敏感');
    assertEquals(safeUrl('java\u0009script:alert(1)', 'link'), null, '制表符拆分的 javascript: 必须拒绝');
    assertEquals(safeUrl('java\nscript:alert(1)', 'link'), null, '换行拆分的 javascript: 必须拒绝');
    assertEquals(safeUrl(' javascript:alert(1)', 'link'), null, '前导空白不能绕过');
    assertEquals(safeUrl('\u200bjavascript:alert(1)', 'link'), null, '零宽字符不能绕过');
    assertEquals(safeUrl('vbscript:msgbox(1)', 'link'), null, 'vbscript: 必须拒绝');
    assertEquals(safeUrl('data:text/html,<script>alert(1)</script>', 'link'), null, 'data: 必须拒绝');
    assertEquals(safeUrl('data:image/svg+xml,<svg onload=alert(1)>', 'img'), null, 'data: 图片必须拒绝（SVG 可带脚本）');
    assertEquals(safeUrl('blob:http://x/1', 'img'), null, 'blob: 必须拒绝');
    assertEquals(safeUrl('file:///etc/passwd', 'link'), null, 'file: 必须拒绝');
    // 放行面（正常功能不能被"一刀切"误伤）
    assertEquals(safeUrl('https://example.com/a?b=1#c', 'link'), 'https://example.com/a?b=1#c', 'https 必须放行');
    assertEquals(safeUrl('http://example.com/x.png', 'img'), 'http://example.com/x.png', 'http 图片必须放行');
    assertEquals(safeUrl('mailto:a@b.c', 'link'), 'mailto:a@b.c', 'mailto 必须放行');
    assertEquals(safeUrl('/relative/path.png', 'img'), '/relative/path.png', '相对路径必须放行');
    assertEquals(safeUrl('#anchor', 'link'), '#anchor', '锚点必须放行');
    assertEquals(safeUrl('', 'link'), null, '空串必须拒绝');
    // 报告里的原始载荷：**不是**"转义后照写"，而是作为**数据**原样交给 setAttribute；
    // 引号在属性值里无法"逃出"属性 —— 由浏览器用例（integration）实测确认。
    assertEquals(safeUrl('broken" onerror="window.__qa_marker=1', 'img'),
      'broken" onerror="window.__qa_marker=1', '无协议前缀的载荷按相对路径原样返回（由 setAttribute 保证不成为新属性）');
  });

  // ── U3 CSP 与产出 HTML ─────────────────────────────────────────────────
  runner.test('R0-116/U3 _serveChat() 真调用：script-src 走 nonce 且不含 unsafe-inline；产出 HTML 里零内联事件属性', async () => {
    const plugin = (await import(pathToFileURL(join(ROOT, CHAT_UI_REL)).href)).default;
    const first = await serveChatPage(plugin);
    const second = await serveChatPage(plugin);

    const csp = first.headers['Content-Security-Policy'];
    assert(csp, '页面必须带 Content-Security-Policy 头');
    const scriptSrc = cspDirective(csp, 'script-src');
    assert(/script-src 'nonce-/.test(scriptSrc), `script-src 必须基于 nonce，实得：${scriptSrc}`);
    assert(!/unsafe-inline/.test(scriptSrc), `script-src 不得含 'unsafe-inline'（含了就等于没防内联事件）：${scriptSrc}`);
    assert(/default-src 'none'/.test(csp), "CSP 必须以 default-src 'none' 收口");
    assert(/object-src 'none'/.test(csp), 'CSP 必须关掉 object-src');
    assert(/frame-ancestors 'none'/.test(csp), 'CSP 必须关掉 frame-ancestors（点击劫持）');
    assertEquals(first.headers['X-Content-Type-Options'], 'nosniff', '必须带 nosniff');

    // nonce 必须**每请求不同**且与 HTML 里的 script 标签一致（否则可预测 = 可绕过）。
    const nonceOf = (c) => (String(c).match(/'nonce-([^']+)'/) || [])[1];
    const nonce1 = nonceOf(csp);
    const nonce2 = nonceOf(second.headers['Content-Security-Policy']);
    assert(nonce1 && nonce2 && nonce1 !== nonce2, `nonce 必须每请求重新生成：${nonce1} / ${nonce2}`);
    assert(first.body.includes(`<script nonce="${nonce1}">`), 'HTML 里的 <script> 必须带上同一个 nonce');

    // 产出 HTML 的**静态标记**里不得有任何内联事件处理属性（CSP 会拒绝它们 ⇒ 点了没反应）。
    const markup = first.body.replace(/<script[\s\S]*?<\/script>/g, '');
    const inline = markup.match(/\son[a-z]+\s*=/gi);
    assert(!inline, `静态标记里仍有内联事件属性（CSP 下会静默失效）：${inline}`);

    // 本文件整体位于 `String.raw` 模板里：模板里出现字面反引号或 `${` 会直接截断模板。
    // 这是本轮真踩过的坑（加注释时写了一个反引号 ⇒ 页面 500），所以钉成判据。
    assert(!first.body.includes('\x60'), '产出 HTML 不得含字面反引号（会截断 String.raw 模板）');
    assert(!/\$\{/.test(first.body), '产出 HTML 不得残留未插值的 ${（同上）');
  });

  // ── U4/U5 具体 sink 的形态 ───────────────────────────────────────────────
  runner.test('R0-116/U4 任务清单不再把 item.id/item.content 拼进 HTML 字符串，且流式路径真的会渲染它', () => {
    const build = extractFunction(chatUiSrc, 'buildTodoListFromData');
    assert(!/data-id="/.test(build), '清单构造里仍有 data-id=" 这种拼接（报告点名的 sink）');
    assert(!/\+\s*escapeHtml/.test(build), '清单构造里仍在拼 escapeHtml 结果');
    assert(/\bel\(/.test(build), '清单必须走 DOM 构造');
    assert(/data-id/.test(build), 'data-id 属性仍应存在（功能不能靠删功能来"修"）');
    // R0-116 实测发现的真缺陷：清单判定只在 appendMsg() 里，而流式回复不经过 appendMsg，
    // 于是"任务清单"在真实对话里一次都不出现（只有刷新页面走历史恢复才渲染）。
    // 判据：唯一的判定函数必须同时被 insert（历史恢复）与流式收尾两条路径引用。
    assert(/function buildTodoList\s*\(/.test(chatUiCode), '缺少唯一的清单判定函数 buildTodoList()');
    const callers = (chatUiCode.match(/buildTodoList\(/g) || []).length;
    assert(callers >= 3, `buildTodoList() 的引用点太少（${callers}）：必须覆盖 appendMsg 与 _finalizeChatStream 两条路径`);
    const finalize = extractFunction(chatUiCode, '_finalizeChatStream');
    // 只断言"函数名出现过"是**假判据**：把 `if (totalReply)` 改成 `if (false && …)` 也能过。
    // 因此这里钉住"确实拿 totalReply 去判清单并据此分支"的语义骨架（空白归一化后再匹配）。
    const flat = finalize.replace(/\s+/g, ' ');
    assert(/if \(totalReply\) \{ const todo = buildTodoList\(totalReply\); if \(todo\) \{/.test(flat),
      '流式收尾必须以 totalReply 判定清单并据此分支 —— 否则真实对话里清单仍然不出现');
  });

  runner.test('R0-116/U5 渲染器不再产出 HTML 字符串（源码里没有 <img src=" / <a href=" 这类模板）', () => {
    for (const bad of ['<img src="', '<a href="', "'<img", "'<a ", '<div style="margin:4px 0 8px']) {
      assert(!chatUiCode.includes(bad), `渲染器源码里仍有 HTML 模板片段 ${JSON.stringify(bad)}`);
    }
    assert(/renderInline\s*\(/.test(chatUiCode), 'renderInline 必须还在（不能靠删功能修漏洞）');
    assert(/document\.createDocumentFragment\s*\(/.test(chatUiCode), '块级/行内渲染必须走 DocumentFragment');

    // R0-116 自查（真机踩到过）：行内扫描的正则**不能**是模块级共享的 `/g` 实例。
    // renderInline 对链接文字**递归**调用自己，而 `/g` 正则的 `lastIndex` 挂在对象上 ⇒
    // 内层递归把它复位成 0，外层下一轮又从字符串开头匹配、`last` 再也追不上尾部 ⇒
    // **死循环**：渲染线程被占满、整页卡死。任何含链接的回复都会命中（浏览器用例 B2/B6 会以
    // "CDP 求值超时"的面貌暴露，这里再加一道不依赖浏览器的静态判据）。
    assert(/MD_INLINE_SOURCE/.test(chatUiCode), '行内正则必须走独立的"模式源"常量');
    assert(!/MD_INLINE_RE\s*\.lastIndex/.test(chatUiCode), '不得对模块级 /g 正则手动复位 lastIndex（递归会互相踩踏）');
    assert(/new RegExp\(MD_INLINE_SOURCE, 'g'\)/.test(chatUiCode), '每次调用必须新建独立的正则实例');
  });

  runner.test('R0-116/U6 同类 sink 台账：全仓 `.innerHTML =` 只允许出现在已知且**不随包发布**的两处', async () => {
    // 报告要求"统一检查其他 innerHTML 的所有变量插入点"。全仓扫了一遍，除 chat-ui 外只有两处：
    //   · plugins/sancai/guiyuan/observability-server.mjs（三才/归元看板，开发态场景）
    //   · plugins/swebench/tusun-status.mjs（SWE-bench 看板，开发态场景）
    // 二者都**不在** OSS 发布物里（`dist/oss/plugins/` 无 sancai/swebench 目录）。
    // 判据取"台账必须恰好等于已知集合"：新增一处立刻红，避免"修了 chat-ui 又长出第三个 sink"。
    const { readdirSync, statSync } = await import('node:fs');
    const KNOWN_NOT_SHIPPED = new Set([
      'plugins/sancai/guiyuan/observability-server.mjs',
      'plugins/swebench/tusun-status.mjs',
    ]);
    const found = new Set();
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) { walk(p); continue; }
        if (!/\.(mjs|js)$/.test(name)) continue;
        const rel = p.slice(ROOT.length + 1);
        if (/(^|\/)tests?\//.test(rel)) continue;   // 只排除测试夹具；下面只走 src/ 与 plugins/ 两棵树
        // 只看**代码**：注释里出现 innerHTML 是说明文字，不是 sink。
        if (/\.innerHTML\s*=/.test(stripComments(readFileSync(p, 'utf8')))) found.add(rel);
      }
    };
    for (const d of ['src', 'plugins']) {
      if (existsSync(join(ROOT, d))) walk(join(ROOT, d));
    }
    const unexpected = [...found].filter((f) => !KNOWN_NOT_SHIPPED.has(f));
    assert(unexpected.length === 0, `出现新的 innerHTML sink（必须一并治理或显式登记理由）：${unexpected.join(', ')}`);
    assert(!found.has(CHAT_UI_REL), `chat-ui 不得再出现在 sink 台账里：${CHAT_UI_REL}`);
  });

  // ── U7 session_id: "" 的三处一致 ────────────────────────────────────────
  runner.test('R0-116/U7 `session_id: ""` 语义：契约层 = "视为未提供"（有 fallback 走 fallback，无 fallback 才拒绝）', () => {
    assertEquals(assertSessionId('', { fallback: 'rest_api' }), 'rest_api', '空串 + fallback 必须落到 fallback（OpenAI SDK 兼容）');
    assertEquals(assertSessionId(undefined, { fallback: 'rest_api' }), 'rest_api', 'undefined + fallback 同义');
    assertEquals(assertSessionId(null, { fallback: 'rest_api' }), 'rest_api', 'null + fallback 同义');
    let threw = null;
    try { assertSessionId(''); } catch (e) { threw = e; }
    assert(threw && threw.code === 'invalid_session_id', '无 fallback 时空串必须具名拒绝');
    // 与"显式给了但不合法"必须区分开：后者即使有 fallback 也拒绝。
    for (const bad of ['../../x', 'a/b', '..', '.', 'a\\b', '中文', 'a'.repeat(129), 123, {}]) {
      let err = null;
      try { assertSessionId(bad, { fallback: 'rest_api' }); } catch (e) { err = e; }
      assert(err, `非法 session_id ${JSON.stringify(bad)} 必须拒绝（不能因为给了 fallback 就被放过）`);
    }
  });

  runner.test('R0-116/U7b `session_id:""` 在**真实 HTTP** 上不是 400；越界串仍是 400', async () => {
    const d = mkdtempSync(join(tmpdir(), 'r116-http-'));
    const stateDir = join(d, 'state');
    mkdirSync(stateDir, { recursive: true });
    // 故意**不配模型**：本轮只判定"契约是否放行"，不判定模型能否回答。
    writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
      activeScene: 'gateway',
      gateway: { host: '127.0.0.1', port: 0 },
    }, null, 2));
    const gw = spawnGateway(stateDir);
    try {
      const port = await gw.port();
      const post = (sid) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'tusunsun', messages: [{ role: 'user', content: 'ping' }], session_id: sid }),
      });
      const empty = await post('');
      assert(empty.status !== 400, `空串 session_id 不得被判 400（要与文档口径一致），实得 ${empty.status}`);
      const missing = await post(undefined);
      assert(missing.status !== 400, `缺省 session_id 不得被判 400，实得 ${missing.status}`);
      const evil = await post('../../e2e_workspace/escaped_session');
      assertEquals(evil.status, 400, '越界 session_id 必须 400');
      const evilBody = await evil.json();
      assertEquals(evilBody.error?.code, 'invalid_session_id', '越界拒绝必须带具名 code');

      // R0-116/P2：同一实例顺带钉住"路由只看路径、不看查询串"。
      // 修前：`req.url` 原文查表 ⇒ 任何带 `?` 的请求全部 404，README 承诺的
      // `/?token=<key>` 兼容入口与 `GET /health?cache=1` 这类监控探针**从来没通过**。
      for (const [path, want] of [['/', 200], ['/?token=x', 200], ['/chat', 200], ['/chat?x=1', 200], ['/health?cache=1', 200]]) {
        const rr = await fetch(`http://127.0.0.1:${port}${path}`);
        assertEquals(rr.status, want, `GET ${path} 应为 ${want}（查询串不得影响路由），实得 ${rr.status}`);
      }
      // 数据面同理：带查询串不能被当成"路径不存在"。这里没配模型 ⇒ 应当走到模型环节再失败，
      // 但**不能**是 404。
      const chatWithQuery = await fetch(`http://127.0.0.1:${port}/v1/chat/completions?trace=1`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'tusunsun', messages: [{ role: 'user', content: 'ping' }] }),
      });
      assert(chatWithQuery.status !== 404, `POST /v1/chat/completions?trace=1 不得 404，实得 ${chatWithQuery.status}`);
    } finally {
      await gw.stop();
    }
  });

  // ── U8 README 不再推荐 ?token= ──────────────────────────────────────────
  runner.test('R0-116/U8 README 主流程不再推荐 `?token=` 形式（旧形式须明确标注为兼容/不推荐）', () => {
    const files = ['README.md', 'README.en.md'].filter((f) => existsSync(join(ROOT, f)));
    assert(files.length > 0, '找不到 README');
    let tokenMentions = 0;
    for (const f of files) {
      const txt = read(f);
      for (const line of txt.split('\n')) {
        if (!line.includes('?token=')) continue;
        tokenMentions++;
        // 附近必须出现"不推荐/兼容/deprecated/not recommended/compatibility"之类字样
        assert(/(不推荐|兼容|弃用|不建议|deprecated|compatibility|not recommended)/i.test(line),
          `${f} 里的 ?token= 用法必须显式标注为不推荐/兼容：${line.trim().slice(0, 120)}`);
      }
    }
    // 登录框（sessionStorage）必须出现在主文档里，替代曾经的带 token URL。
    const zh = files.includes('README.md') ? read('README.md') : '';
    if (zh) assert(/sessionStorage|登录框|口令/.test(zh), '中文 README 必须说明用登录框/口令（sessionStorage）方式进入带鉴权的页面');
    return tokenMentions;
  });

  runner.test('R0-116/U10 README 里承诺的每个 CLI 命令都必须真的存在（`tusunsun chat` 就是这么被抓到的）', async () => {
    // 第三轮 P2 要求"对齐 README/CHANGELOG、CLI 帮助"。实测：README 的 CLI 表里写着
    // `tusunsun chat`，而 CLI 根本没有这个命令 —— 它属于插件命令 `tui`。
    // 判据取**行为**判据：跑一次 `--help`，把 README 表里的命令名逐个对回帮助输出。
    const help = await new Promise((resolve) => {
      const child = spawnManaged(process.execPath, [ENTRY, '--help'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (b) => { out += b.toString(); });
      child.stderr.on('data', (b) => { out += b.toString(); });
      child.on('close', () => resolve(stripAnsi(out)));
    });
    assert(/Core Commands:/.test(help), `--help 没有输出命令表：${help.slice(0, 120)}`);
    const claimed = new Set();
    for (const f of ['README.md', 'README.en.md']) {
      if (!existsSync(join(ROOT, f))) continue;
      for (const line of read(f).split('\n')) {
        const m = line.match(/\|\s*`tusunsun ([a-z][a-z0-9-]*)`/);
        if (m) claimed.add(m[1]);
      }
    }
    assert(claimed.size >= 5, `没有从 README 解析出 CLI 命令（判据失效）：${[...claimed]}`);
    // 例外只有一条，且必须**被验证**而不是被断言：`chat` 由 `haotian-lite` 插件提供，
    // 发布包里它是 `plugins/haotian-lite.js`（顶层，会被 scanPluginCommands 发现）；
    // 而源码树里它在 `plugins/sancai/haotian/` 子目录，顶层扫描看不到 —— 这是**两树布局差异**，
    // 不是文档谎话。所以：开发树里给它一次豁免，但**同时**要求 `dist/oss` 的 help 里真的有它；
    // 制品形态（无 dist/oss）没有豁免，必须真的出现在 help 里。
    const DEV_TREE_PLUGIN_LAYOUT = { chat: 'haotian-lite（源码树在 plugins/sancai/haotian/ 子目录，产物里在顶层）' };
    const hasDist = existsSync(join(ROOT, 'dist', 'oss'));
    let artifactHelp = null;
    if (hasDist) {
      artifactHelp = await new Promise((resolve) => {
        const child = spawnManaged(process.execPath, [join(ROOT, 'dist', 'oss', 'tusunsun.mjs'), '--help'], {
          cwd: join(ROOT, 'dist', 'oss'), stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        child.stdout.on('data', (b) => { out += b.toString(); });
        child.stderr.on('data', (b) => { out += b.toString(); });
        child.on('close', () => resolve(stripAnsi(out)));
      });
    }
    const inHelp = (text, cmd) => new RegExp(`(^|\\s)${cmd}\\s`, 'm').test(text);
    const missing = [];
    for (const cmd of claimed) {
      if (inHelp(help, cmd)) continue;
      if (hasDist && DEV_TREE_PLUGIN_LAYOUT[cmd] && inHelp(artifactHelp || '', cmd)) {
        console.log(`       [实测] ${cmd} 在源码树 help 里缺席（${DEV_TREE_PLUGIN_LAYOUT[cmd]}），已用 dist/oss 的 help 反证其存在`);
        continue;
      }
      missing.push(cmd);
    }
    assert(missing.length === 0, `README 承诺但 CLI 帮助里没有的命令：${missing.join(', ')}`);
    console.log(`       [实测] README 承诺 ${claimed.size} 个命令，CLI 帮助全部覆盖：${[...claimed].join(', ')}`);
  });

  runner.test('R0-116/U9 CHANGELOG 明确区分「开发树单测数」与「制品注册用例数」', () => {
    const cl = read('CHANGELOG.md');
    assert(/开发树/.test(cl) && /(制品|发布包|npm 包)/.test(cl),
      'CHANGELOG 必须同时点明"开发树"与"制品"两种检出形态的用例数，避免把两者混为一谈');
    assert(/(注册用例|注册的用例|用例数|口径)/.test(cl), 'CHANGELOG 必须写明计数口径');
  });

}

export default setup;
