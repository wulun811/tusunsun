// R0-124：会话级工作目录 —— 先复现、再修、再锁死
//
//   背景：`agent.workDir` 是**进程级单值**，34 处读者都直接读它。实测（真网关 + 真工具）：
//   把两个会话分别指向 projA / projB，两个会话的写入**都落在 projA**；模型在两边拿到的
//   system prompt 都是 `Current directory: …/projA`；`X-Workspace` 请求头与 `workspace`
//   请求体被**静默忽略**并回 200 —— 用户以为自己在一个目录里干活，文件落到了另一个目录。
//
//   现在：会话可以声明自己的根目录，之后该会话的**工具落盘、读取、提示词、破坏面测量、
//   读前必读记录**全部按它算；没声明一律沿用进程默认（既有部署行为不变）。
//
// 每条都写**正反两例**：只测"隔离住了"会奖励过度隔离（把该共享的也拆了）。
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TestRunner, assert, assertEquals } from '../harness.mjs';
import { spawnManaged } from '../lib/proc.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const ENTRY = join(ROOT, 'tusunsun.mjs');
const imp = (rel) => import(join(ROOT, rel));

/**
 * 每个 core 一份状态：插件 init 只是给**这个 core** 注册一层门面（见 plugins/workspace.js 文件头），
 * 所以这里拿到的就是生产里工具/网关用的同一个对象，不做任何 Object.create 影子实例。
 */
async function freshWorkspace(core) {
  const def = (await imp('plugins/workspace.js')).default;
  await def.init(core);
  return core.getService('workspace');
}

async function freshTool(core, name) {
  const def = (await imp(`plugins/tools/tool-${name}.js`)).default;
  const inst = Object.create(def);
  await inst.init(core);
  return inst;
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');

/** 进程内直调 = 本机调用方；`trusted` 显式给，不靠默认值（默认 fail-closed）。 */
const bind = (ws, sid, dir, opts = {}) => ws.declare(sid, dir, { trusted: true, ...opts });

/** 测试必须自证环境干净：工作目录 `.env` 会被 CLI 自动加载，显式置空以隔离。 */
const HERMETIC = {
  TUSUNSUN_STATE_DIR: '', TUSUNSUN_PORT: '', TUSUNSUN_API_KEY: '', LLM_API_KEY: '',
  TUSUNSUN_BASE_URL: '', TUSUNSUN_MODEL: '', TUSUNSUN_GATEWAY_KEY: '', TUSUNSUN_ALLOW_REMOTE: '',
  TUSUNSUN_WORK_DIR: '', TUSUNSUN_PROFILE: '',
};

async function waitFor(fn, { timeoutMs = 40000, what = '条件' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待${what}超时（${timeoutMs}ms）`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

export async function setup(runner) {
  const base = () => mkdtempSync(join(tmpdir(), 'r124-ws-'));

  // ── T1 服务层：各绑各的，未声明回落默认 ──────────────────────
  runner.test('R0-124/T1 会话根目录：各绑各的；未声明回落进程默认（不误伤老部署）', async () => {
    const { Core } = await imp('src/core/core.js');
    const d = base();
    try {
      const projA = join(d, 'A'); const projB = join(d, 'B');
      mkdirSync(projA); mkdirSync(projB);
      const core = new Core({ stateDir: join(d, 'state') });
      core.log = () => {};
      core.setData('agent.workDir', projA);
      const ws = await freshWorkspace(core);

      assertEquals(ws.root('s1'), projA, '未声明时必须回落进程默认根');
      await bind(ws, 's1', projB);
      assertEquals(ws.root('s1'), projB, 's1 必须按自己声明的目录');
      assertEquals(ws.root('s2'), projA, 's2 未声明，不得跟着 s1 走');
      assertEquals(ws.root(undefined), projA, '没有会话标识时用默认根');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ── T2 工具层：真 tool-write / tool-read 按会话落盘 ──────────
  runner.test('R0-124/T2 文件工具跟着会话走：同名相对路径在两个目录里是两个文件', async () => {
    const { Core } = await imp('src/core/core.js');
    const d = base();
    try {
      const projA = join(d, 'A'); const projB = join(d, 'B');
      mkdirSync(projA); mkdirSync(projB);
      writeFileSync(join(projA, 'who.txt'), 'I-AM-A');
      writeFileSync(join(projB, 'who.txt'), 'I-AM-B');
      const core = new Core({ stateDir: join(d, 'state') });
      core.log = () => {};
      core.setData('agent.workDir', projA);
      const ws = await freshWorkspace(core);
      const write = await freshTool(core, 'write');
      const read = await freshTool(core, 'read');

      await bind(ws, 'sA', projA);
      await bind(ws, 'sB', projB);

      const wA = await write.execute({ path: 'out.txt', content: 'by-A', _sessionId: 'sA' });
      const wB = await write.execute({ path: 'out.txt', content: 'by-B', _sessionId: 'sB' });
      assert(String(wA).includes('out.txt') && String(wB).includes('out.txt'), `写入必须成功：${wA} / ${wB}`);
      assertEquals(readFileSync(join(projA, 'out.txt'), 'utf8'), 'by-A', 'sA 的写入必须落在 A');
      assertEquals(readFileSync(join(projB, 'out.txt'), 'utf8'), 'by-B', 'sB 的写入必须落在 B（修前这里落在 A）');

      // 反向：同名文件在两个会话里读到的是各自目录的内容
      const rA = String(await read.execute({ path: 'who.txt', limit: 20, _sessionId: 'sA' }));
      const rB = String(await read.execute({ path: 'who.txt', limit: 20, _sessionId: 'sB' }));
      assert(rA.includes('I-AM-A') && !rA.includes('I-AM-B'), `sA 只能读到 A 的内容：${rA.slice(0, 120)}`);
      assert(rB.includes('I-AM-B') && !rB.includes('I-AM-A'), `sB 只能读到 B 的内容：${rB.slice(0, 120)}`);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ── T3 提示词 / 执行器：说哪儿就在哪儿 ──────────────────────
  runner.test('R0-124/T3 提示词与执行器同口径：模型被告知的目录 == 工具实际落盘的根', async () => {
    const { Core } = await imp('src/core/core.js');
    const PromptBuilder = (await imp('plugins/prompt-builder.js')).default;
    const ToolExecutor = (await imp('plugins/tool-executor.js')).default;
    const d = base();
    try {
      const projA = join(d, 'A'); const projB = join(d, 'B');
      mkdirSync(projA); mkdirSync(projB);
      const core = new Core({ stateDir: join(d, 'state') });
      core.log = () => {};
      core.setData('agent.workDir', projA);
      const ws = await freshWorkspace(core);
      await bind(ws, 'sB', projB);

      const pb = Object.create(PromptBuilder);
      pb.core = core;
      const mk = (sessionId) => {
        const ctx = { sessionId, prompt: '', tools: [{ name: 'tool-write' }] };
        pb._injectWorkspace(ctx);
        return ctx.prompt;
      };
      const pA = mk('sA'); const pB = mk('sB');
      assert(pA.includes(`Current directory: ${projA}`), `sA 的提示词必须说 A：${pA.slice(0, 160)}`);
      assert(pB.includes(`Current directory: ${projB}`), `sB 的提示词必须说 B：${pB.slice(0, 160)}`);
      assert(!pB.includes(projA), 'sB 的提示词里不得出现 A 的目录');

      // 执行器（破坏面测量 / 缓存键 / 捆仙索展开）认同一个根
      const ex = Object.create(ToolExecutor);
      ex.core = core;
      assertEquals(ex._effectiveWorkDir('sA'), projA, '执行器对 sA 必须用 A');
      assertEquals(ex._effectiveWorkDir('sB'), projB, '执行器对 sB 必须用 B（修前这里也是 A）');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ── T4 校验：全部具名拒绝，且失败不改动既有绑定 ──────────────
  runner.test('R0-124/T4 非法目录具名拒绝（不存在/相对/非目录/根/状态目录/家目录），失败不改变已绑定的', async () => {
    const { Core } = await imp('src/core/core.js');
    const d = base();
    try {
      const projA = join(d, 'A'); const projB = join(d, 'B');
      mkdirSync(projA); mkdirSync(projB);
      const state = join(d, 'state'); mkdirSync(state);
      writeFileSync(join(projA, 'f.txt'), 'x');
      const core = new Core({ stateDir: state });
      core.log = () => {};
      core.setData('agent.workDir', projA);
      const ws = await freshWorkspace(core);
      await bind(ws, 's1', projB);

      const cases = [
        ['不存在', join(d, 'nope'), 'workspace_not_found'],
        ['相对路径', 'A', 'invalid_workspace'],
        ['不是目录', join(projA, 'f.txt'), 'workspace_not_dir'],
        ['根目录', '/', 'workspace_denied'],
        ['状态目录', state, 'workspace_denied'],
        ['家目录', homedir(), 'workspace_denied'],
      ];
      for (const [name, target, code] of cases) {
        let got = null;
        try { await bind(ws, 's1', target); } catch (err) { got = err; }
        assert(got, `${name}（${target}）必须被拒绝，实际放行了`);
        assertEquals(got.code, code, `${name} 必须是 ${code}，实际 ${got.code}：${got.message}`);
        assertEquals(got.contractError, true, `${name} 的拒绝必须是契约错误（网关据此回 4xx）`);
        // 关键：拒绝之后**不许**有任何静默改动
        assertEquals(ws.root('s1'), projB, `${name} 被拒后 s1 的绑定不得变化`);
      }
      // 目录不存在时不得替调用方创建（打错一个字符就静默造空树更糟）
      assert(!existsSync(join(d, 'nope')), '拒绝"不存在"时不得顺手 mkdir');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ── T5 一个会话一个目录 ────────────────────────────────────
  runner.test('R0-124/T5 一个会话只绑一个目录：同目录重复声明幂等、换目录 409（force 才改）', async () => {
    const { Core } = await imp('src/core/core.js');
    const d = base();
    try {
      const projA = join(d, 'A'); const projB = join(d, 'B');
      mkdirSync(projA); mkdirSync(projB);
      const core = new Core({ stateDir: join(d, 'state') });
      core.log = () => {};
      core.setData('agent.workDir', projA);
      const ws = await freshWorkspace(core);

      await bind(ws, 's1', projA);
      await bind(ws, 's1', projA);   // 每轮都带同一个值（CLI/HTTP 常态）必须无害
      assertEquals(ws.root('s1'), projA, '重复声明同一目录必须幂等');

      let err = null;
      try { await bind(ws, 's1', projB); } catch (e) { err = e; }
      assert(err, '同一会话换目录必须被拒绝（历史属于它产生的那个目录）');
      assertEquals(err.code, 'workspace_conflict', `必须是 workspace_conflict，实际 ${err.code}`);
      assertEquals(ws.root('s1'), projA, '拒绝之后绑定不得被改掉');

      await bind(ws, 's1', projB, { force: true });
      assertEquals(ws.root('s1'), projB, 'force 是为了"真的知道自己在做什么"的调用方保留的出口');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ── T6 来源策略 ────────────────────────────────────────────
  runner.test('R0-124/T6 白名单：远端调用方必须落在 workspaces.roots，本机默认不受限', async () => {
    const { Core } = await imp('src/core/core.js');
    const d = base();
    try {
      const root = join(d, 'projects'); const inside = join(root, 'p1'); const outside = join(d, 'other');
      mkdirSync(inside, { recursive: true }); mkdirSync(outside);

      // ① local 策略 + 无白名单：本机放行，远端拒绝
      const mkCore = (cfg) => {
        const c = new Core({ stateDir: join(d, 'state-' + Math.random().toString(36).slice(2)) });
        c.log = () => {};
        c.setData('agent.workDir', outside);
        c.registerService('config', { get: (k, fb) => (k === 'workspaces' ? cfg : fb), set: () => true });
        return c;
      };
      const c1 = mkCore({ policy: 'local', roots: null });
      const ws1 = await freshWorkspace(c1);
      await ws1.declare('local-1', inside, { trusted: true });
      assertEquals(ws1.root('local-1'), inside, 'local 策略下本机必须能声明任意现有目录');
      let e1 = null;
      try { await ws1.declare('remote-1', inside, { trusted: false }); } catch (e) { e1 = e; }
      assert(e1, 'local 策略 + 无白名单时远端必须被拒绝');
      assertEquals(e1.code, 'workspace_not_allowed', `必须是 workspace_not_allowed，实际 ${e1.code}`);

      // ② 配了白名单：远端在白名单内放行，白名单外仍拒绝
      const c2 = mkCore({ policy: 'local', roots: [root] });
      const ws2 = await freshWorkspace(c2);
      await ws2.declare('remote-2', inside, { trusted: false });
      assertEquals(ws2.root('remote-2'), inside, '白名单内的目录必须放行');
      let e2 = null;
      try { await ws2.declare('remote-3', outside, { trusted: false }); } catch (e) { e2 = e; }
      assert(e2, '白名单外必须拒绝');
      assertEquals(e2.code, 'workspace_not_allowed', `必须是 workspace_not_allowed，实际 ${e2.code}`);

      // ③ rooted 策略：连本机也受限（"所有人都只能在这棵树下"）
      const c3 = mkCore({ policy: 'rooted', roots: [root] });
      const ws3 = await freshWorkspace(c3);
      let e3 = null;
      try { await ws3.declare('local-3', outside, { trusted: true }); } catch (e) { e3 = e; }
      assert(e3, 'rooted 策略下本机也不得越出白名单');
      assertEquals(e3.code, 'workspace_not_allowed', `必须是 workspace_not_allowed，实际 ${e3.code}`);
      await ws3.declare('local-4', inside, { trusted: true });
      assertEquals(ws3.root('local-4'), inside, 'rooted 策略下白名单内必须放行');

      // ④ off：整条能力关闭，任何声明都拒绝（而不是静默忽略）
      const c4 = mkCore({ policy: 'off', roots: [root] });
      const ws4 = await freshWorkspace(c4);
      let e4 = null;
      try { await ws4.declare('s', inside, { trusted: true }); } catch (e) { e4 = e; }
      assertEquals(e4?.code, 'workspace_disabled', `off 策略必须具名拒绝，实际 ${e4?.code}`);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ── T7 端到端：真网关 + 假模型 ──────────────────────────────
  runner.test('R0-124/T7 端到端：两个会话在各自目录里干活；非法声明 400、换目录 409、回显实际目录', async () => {
    const d = base();
    const projA = join(d, 'A'); const projB = join(d, 'B');
    const state = join(d, 'state');
    mkdirSync(projA, { recursive: true }); mkdirSync(projB, { recursive: true }); mkdirSync(state);

    // 假模型：工具结果已回灌 → 收尾；WRITE:x → tool-write；READ:x → tool-read
    const seen = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c.toString(); });
      req.on('end', () => {
        let p = {};
        try { p = JSON.parse(body); } catch { /* 忽略 */ }
        const msgs = p.messages || [];
        seen.push({ system: msgs.find((m) => m.role === 'system')?.content || '' });
        const j = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
        if (msgs[msgs.length - 1]?.role === 'tool') return j({ choices: [{ message: { role: 'assistant', content: 'DONE' }, finish_reason: 'stop' }] });
        const user = [...msgs].reverse().find((m) => m.role === 'user')?.content || '';
        const w = /WRITE:(\S+)/.exec(user);
        if (w) {
          return j({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'tool-write', arguments: JSON.stringify({ path: `${w[1]}.txt`, content: `by-${w[1]}` }) } }] }, finish_reason: 'tool_calls' }] });
        }
        j({ choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] });
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const modelPort = server.address().port;
    writeFileSync(join(state, 'config.json'), JSON.stringify({
      activeScene: 'gateway',
      gateway: { host: '127.0.0.1', port: 0 },
      model: { model: 'mock', baseUrl: `http://127.0.0.1:${modelPort}/v1`, apiKey: 'mock-key' },
      agent: { workDir: projA },
    }, null, 2));

    const runtimePath = join(state, 'gateway.runtime.json');
    const gw = spawnManaged(process.execPath, [ENTRY, 'start', '--port', '0', '--state-dir', state, '--yes'], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...HERMETIC },
    });
    let out = '';
    gw.stdout.on('data', (b) => { out += b.toString(); });
    gw.stderr.on('data', (b) => { out += b.toString(); });
    try {
      const port = await waitFor(() => {
        if (!existsSync(runtimePath)) return null;
        try {
          const rt = JSON.parse(readFileSync(runtimePath, 'utf8'));
          return typeof rt.port === 'number' && rt.port > 0 ? rt.port : null;
        } catch { return null; }
      }, { what: '运行期端口文件' });

      const post = async (body, headers = {}) => {
        const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({ model: 'tusunsun', stream: false, ...body }), signal: AbortSignal.timeout(60000),
        });
        return { status: r.status, body: await r.json().catch(() => null) };
      };

      assert(/listening on/.test(out), '网关必须真的起来了：' + out.slice(-300));
      // ① s1 用默认（A）；s2 用请求头声明 B
      const r1 = await post({ session_id: 's1', messages: [{ role: 'user', content: 'WRITE:one' }] });
      const r2 = await post({ session_id: 's2', messages: [{ role: 'user', content: 'WRITE:two' }] }, { 'X-Tusunsun-Workspace': projB });
      assertEquals(r1.status, 200, `s1 应 200：${JSON.stringify(r1.body).slice(0, 200)}`);
      assertEquals(r2.status, 200, `s2 应 200：${JSON.stringify(r2.body).slice(0, 200)}`);
      assert(existsSync(join(projA, 'one.txt')), 's1 的文件必须落在 A');
      assert(existsSync(join(projB, 'two.txt')), 's2 的文件必须落在 B（修前落在 A）');
      assert(!existsSync(join(projA, 'two.txt')), 'B 的文件不得漏到 A 里');
      assertEquals(r2.body?.tusunsun_workspace, projB, `响应必须回显**实际生效**的目录，实际 ${r2.body?.tusunsun_workspace}`);

      // ② 提示词里说的目录必须与会话一致
      const sysTexts = seen.map((s) => s.system);
      assert(sysTexts.some((s) => s.includes(`Current directory: ${projB}`)), 's2 的提示词必须说 B');

      // ③ 请求体也能声明（OpenAI SDK 的 extra_body 形态）；非法值必须 400 且具名
      const r3 = await post({ session_id: 's3', workspace: join(d, 'nope'), messages: [{ role: 'user', content: 'hi' }] });
      assertEquals(r3.status, 400, `不存在的目录必须 400，实际 ${r3.status}`);
      assert(/workspace_not_found/.test(JSON.stringify(r3.body)), `必须带具名 code，实际 ${JSON.stringify(r3.body).slice(0, 200)}`);

      // ④ 同一会话换目录必须 409（不静默搬走历史所属的目录）
      const r4 = await post({ session_id: 's2', workspace: projA, messages: [{ role: 'user', content: 'hi' }] });
      assertEquals(r4.status, 409, `换目录必须 409，实际 ${r4.status}`);
      assert(/workspace_conflict/.test(JSON.stringify(r4.body)), `必须带 workspace_conflict，实际 ${JSON.stringify(r4.body).slice(0, 200)}`);

      // ⑤ 观测面：能问出"谁在哪个目录里"
      const api = await fetch(`http://127.0.0.1:${port}/api/sessions`);
      assertEquals(api.status, 200, '/api/sessions 应 200');
      const list = await api.json();
      assertEquals(list.default, projA, `默认根应为 A，实际 ${list.default}`);
      assert(list.sessions.some((s) => s.sessionId === 's2' && s.workspace === projB),
        `s2 应出现在绑定表里：${JSON.stringify(list.sessions)}`);
      assert(list.sessions.every((s) => s.sessionId !== 's1'), 's1 没声明，不该出现在绑定表里');
    } finally {
      await gw.reap().catch(() => {});
      server.close();
      rmSync(d, { recursive: true, force: true });
    }
  });
}
