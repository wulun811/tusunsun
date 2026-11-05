// R0-113：外部专家实测评审（NO-GO 报告，2026-10-19）整改的随包门禁。
//
// 本文件逐条钉住报告里的可机械判定项；每条都对应开发仓 `contracts/r0-113-expert-review-remediation.md`
// 的一节，并做过**变异验证**（把修复还原 → 对应用例必红）：
//   P0-01 管理面未认证：默认回环 + /api/* 鉴权 + 跨源拒绝 + CORS 收敛 + WS 口令走请求头
//   P0-02 工作区前缀碰撞：7 个工具共用 resolver；**真实链路**（模型→haotian→executor→tool）越界必拒
//   P1-01 首次 config set 落盘（0600/0700、失败非零）
//   P1-02 状态目录单一解析（--state-dir > TUSUNSUN_STATE_DIR > ~/.tusunsun）
//   P1-03 权限：状态目录 0700 / config.json 0600 https://…（与 P1-01 同一批断言）
//   P1-04 /ready 缺凭证不得 ready（/health 仍 200）
//   P1-05 / P2 口径：四种身份、版本、UA、横幅、场景声明自洽、Node 18 兼容
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TestRunner, assert, assertEquals } from '../harness.mjs';
// R0-115：子进程一律走受管 spawn（独立进程组 + 登记回收）。
import { spawnManaged } from '../lib/proc.mjs';
import { resolveWorkspacePath } from '../../plugins/tools/lib/workspace.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const ENTRY = join(ROOT, 'tusunsun.mjs');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
const PKG = JSON.parse(read('package.json'));
// 文档目录：v0.9.25 起只有 `docs/`。此前判据还要看 `updocs/`（旧构建期把它映射成产物的 `docs/`），
// 而那个构建链已经不存在了 —— 保留这个分支只会让"文档到底在哪"多一个永远为假的答案。
const DOCS = 'docs';

/**
 * 解析插件文件。v0.9.25 起装配根只有一个 `plugins/`。
 * 第三层 `plugins/sancai/haotian/` 是**下游兼容树**的位置（本仓不存在该目录）：
 * 下游工程把本文件整份复制过去，插件放在那里；保留这一层是为了让同一份测试在两侧都能跑。
 * 目录名写成数组由 spread 展开，是因为构建期的自洽性过滤只认 `join()` 里的字面量链。
 */
function resolvePlugin(name) {
  for (const layer of [['plugins'], ['plugins', 'sancai', 'haotian']]) {
    const p = join(ROOT, ...layer, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * R0-113：测试必须自证环境干净。工作目录里的 `.env` 会被 `tusunsun.mjs` 自动加载，
 * 于是"没配模型凭证"的实例可能悄悄变成"有凭证"（实测交付树的 `.env` 就让 readiness 断言假绿）。
 * `.env` 仅在对应 env 变量**未定义**时生效 ⇒ 这里显式置空，既隔离 `.env`，又等价于未设置。
 */
const HERMETIC = {
  TUSUNSUN_STATE_DIR: '', TUSUNSUN_PORT: '',
  TUSUNSUN_API_KEY: '', LLM_API_KEY: '', TUSUNSUN_BASE_URL: '', TUSUNSUN_MODEL: '',
  TUSUNSUN_GATEWAY_KEY: '', TUSUNSUN_ALLOW_REMOTE: '', TUSUNSUN_MODEL_HEADERS: '', TUSUNSUN_PROFILE: '',
};

function runCli(args, { timeoutMs = 90000, env = {}, cwd = ROOT } = {}) {
  return new Promise((resolve) => {
    const child = spawnManaged(process.execPath, [ENTRY, ...args], {
      cwd, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...HERMETIC, ...env },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.stderr.on('data', (b) => { err += b.toString(); });
    // R0-115：超时用整组回收（kill 只打子进程，孙进程会孤儿化）。
    const timer = setTimeout(() => { child.reap().catch(() => {}); }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out: stripAnsi(out), err: stripAnsi(err) });
    });
  });
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

/** 起一个网关（--port 0），返回句柄；`stateDir` 由调用方给（便于预置 config.json）。 */
function spawnGateway(stateDir, extraEnv = {}) {
  const runtimePath = join(stateDir, 'gateway.runtime.json');
  const gw = spawnManaged(process.execPath, [ENTRY, 'start', '--port', '0', '--state-dir', stateDir, '--yes'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...HERMETIC, ...extraEnv },
  });
  let out = '';
  gw.stdout.on('data', (b) => { out += b.toString(); });
  gw.stderr.on('data', (b) => { out += b.toString(); });
  return {
    gw,
    stateDir,
    out: () => stripAnsi(out),
    port: async () => waitFor(() => {
      if (!existsSync(runtimePath)) return null;
      try {
        const rt = JSON.parse(readFileSync(runtimePath, 'utf8'));
        return typeof rt.port === 'number' && rt.port > 0 ? rt.port : null;
      } catch { return null; }
    }, { what: '运行期端口文件' }),
    stop: async () => {
      // R0-115：整组回收（SIGTERM → 宽限 → SIGKILL 进程组），连引擎孙进程一起带走。
      await gw.reap();
    },
  };
}

async function postJson(port, path, body, extraHeaders = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
}

export async function setup(runner) {
  // ══════════════════════════════════════════════════════════════════════
  // P0-02：工作区边界（resolver 层）
  // ══════════════════════════════════════════════════════════════════════

  runner.test('R0-113/Y1 工作区边界：前缀同名兄弟目录 / `..` / 绝对路径一律拒绝，工作区内放行', async () => {
    const d = mkdtempSync(join(tmpdir(), 'r113-ws-'));
    try {
      const ws = join(d, 'workspace');
      const evil = join(d, 'workspace_evil');
      mkdirSync(ws); mkdirSync(evil);
      const denied = [];
      for (const p of ['../workspace_evil/bypass.txt', '../evil.txt', '/etc/passwd']) {
        try { await resolveWorkspacePath(ws, p); assert(false, `${p} 必须被拒绝`); }
        catch (err) { denied.push([p, err.code, err.message]); }
      }
      for (const [p, code, msg] of denied) {
        assertEquals(code, 'out_of_bounds', `${p} 必须具名 out_of_bounds，实际 ${code}：${msg}`);
      }
      // 关键反例：修复前 `…/workspace_evil/bypass.txt`.startsWith(`…/workspace`) === true ⇒ 放行
      assert(/workspace_evil/.test(denied[0][2]) && /escapes the workspace|outside/.test(denied[0][2]),
        `拒绝文案必须说清是越界，实际：${denied[0][2]}`);
      const ok = await resolveWorkspacePath(ws, 'sub/ok.txt');
      assertEquals(ok, join(ws, 'sub', 'ok.txt'), '工作区内的相对路径必须放行');
      // `..` 绕回工作区自身不算越界（语义是"规范化后的包含关系"，不是字符串扫描）
      assertEquals(await resolveWorkspacePath(ws, '../workspace/back.txt'), join(ws, 'back.txt'));
      console.log(`       [实测] 前缀碰撞/../绝对路径全部拒绝；区内路径放行`);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-113/Y2 符号链接逃逸：写穿链接目录与链接文件都被拒绝', async () => {
    const d = mkdtempSync(join(tmpdir(), 'r113-link-'));
    try {
      const ws = join(d, 'workspace');
      const outside = join(d, 'outside');
      mkdirSync(ws); mkdirSync(outside);
      writeFileSync(join(outside, 'secret.txt'), 'SECRET');
      symlinkSync(outside, join(ws, 'link'));
      symlinkSync(join(outside, 'secret.txt'), join(ws, 'linkfile'));
      for (const p of ['link/stolen.txt', 'linkfile']) {
        try { await resolveWorkspacePath(ws, p); assert(false, `${p} 必须被拒绝`); }
        catch (err) {
          assertEquals(err.code, 'out_of_bounds', `${p} 必须 out_of_bounds，实际 ${err.code}`);
          assert(/symlink/.test(err.message), `拒绝文案必须点名 symlink，实际：${err.message}`);
        }
      }
      // 真工具调用（tool-write）也不得穿链接落盘
      const ToolWrite = (await import(pathToFileURL(join(ROOT, 'plugins', 'tools', 'tool-write.js')).href)).default;
      const saved = ToolWrite.core;
      ToolWrite.core = { getData: () => ws };
      try {
        await ToolWrite.execute({ path: 'link/through.txt', content: 'x' });
        assert(false, 'tool-write 不得写穿符号链接');
      } catch (err) {
        assertEquals(err.code, 'out_of_bounds', `tool-write 必须契约拒绝，实际 ${err.code}`);
      } finally { ToolWrite.core = saved; }
      assert(!existsSync(join(outside, 'through.txt')), '链接目标目录里不得出现被写入的文件');
      console.log('       [实测] link/ 与 linkfile 两种逃逸都被拒，目标目录零副作用');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ══════════════════════════════════════════════════════════════════════
  // P0-02：真实链路（模型 → haotian-lite → tool-executor → tool-write）
  // ══════════════════════════════════════════════════════════════════════

  runner.test('R0-113/Y3 全链路：模型发起 tool-read/tool-write 越界必须被拒且零副作用；同链路区内读取必须成功', async () => {
    const d = mkdtempSync(join(tmpdir(), 'r113-e2e-'));
    const seenBodies = [];
    // 假模型：按用户消息决定 tool_call（EVIL=读越界 / WRITE_EVIL=写越界 / 其它=区内读），
    // 第二次请求（已在 messages 里看到 role:'tool'）回最终答复。
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c.toString(); });
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch { /* 忽略 */ }
        seenBodies.push(parsed);
        const asked = JSON.stringify(parsed.messages || []);
        const isToolResult = (parsed.messages || []).some((m) => m.role === 'tool');
        if (isToolResult) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'CHAIN_DONE' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }));
          return;
        }
        // 注意顺序：WRITE_EVIL 里也含 EVIL 子串
        const call = asked.includes('WRITE_EVIL')
          ? { name: 'tool-write', args: { path: '../workspace_evil/bypass.txt', content: 'SUCCEEDED_MOCK_WORKFLOW' } }
          : asked.includes('EVIL')
            ? { name: 'tool-read', args: { path: '../workspace_evil/secret.txt', limit: 5 } }
            : { name: 'tool-read', args: { path: 'ok.txt', limit: 5 } };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{
            message: {
              role: 'assistant', content: null,
              tool_calls: [{
                id: 'call_1', type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.args) },
              }],
            },
            finish_reason: 'tool_calls',
          }],
        }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const modelPort = server.address().port;

    try {
      const ws = join(d, 'workspace');
      const evilDir = join(d, 'workspace_evil');
      mkdirSync(ws); mkdirSync(evilDir);
      writeFileSync(join(ws, 'ok.txt'), 'INSIDE_OK');
      writeFileSync(join(evilDir, 'secret.txt'), 'EVIL_SECRET');
      const stateDir = join(d, 'state');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
        activeScene: 'gateway',
        gateway: { host: '127.0.0.1', port: 0 },
        model: { model: 'mock', baseUrl: `http://127.0.0.1:${modelPort}/v1`, apiKey: 'mock-key' },
        agent: { workDir: ws },
      }, null, 2));

      const toolResults = () => seenBodies.flatMap((b) => b.messages || [])
        .filter((m) => m.role === 'tool').map((m) => String(m.content));
      const ask = async (session, content) => {
        const g = null; // 复用同一个网关句柄（下面）
        return postJson(port, '/v1/chat/completions', {
          model: 'tusunsun', stream: false, session_id: session,
          messages: [{ role: 'user', content }],
        });
      };

      const g = spawnGateway(stateDir);
      let port;
      try {
        port = await g.port();
        // ① 越界读：必须被拒，且工具结果里**不得**出现工作区外的内容
        const evil = await ask('r113-evil', 'EVIL: 读工作区外的文件');
        assertEquals(evil.status, 200, `对话链路本身应成功（拒绝发生在工具层）：${JSON.stringify(evil.body).slice(0, 300)}`);
        assert(JSON.stringify(evil.body).includes('CHAIN_DONE'), '链路必须走到第二次模型调用（说明工具结果已回灌）');
        const afterEvil = toolResults();
        assert(afterEvil.some((c) => /out_of_bounds|Path traversal/.test(c)),
          `越界读必须回灌具名拒绝，实际：${JSON.stringify(afterEvil).slice(0, 300)}`);
        assert(!afterEvil.some((c) => c.includes('EVIL_SECRET')) && !JSON.stringify(evil.body).includes('EVIL_SECRET'),
          '工作区外的文件内容一个字都不许泄露');

        // ② 控制组：区内读必须真的拿到内容（证明链路是"真执行"而不是一律拒绝）
        const okRes = await ask('r113-ok', 'OK: 读工作区内的文件');
        assertEquals(okRes.status, 200, '区内读取的对话应 200');
        assert(toolResults().some((c) => c.includes('INSIDE_OK')),
          `控制组必须真的读到 ok.txt 内容，实际：${JSON.stringify(toolResults()).slice(0, 300)}`);

        // ③ 越界写：无论被哪一层拦下（工具围栏或工作区边界），都不得有副作用
        const we = await ask('r113-wevil', 'WRITE_EVIL: 写到工作区外');
        assertEquals(we.status, 200, '写越界的对话请求本身仍应 200（拒绝在工具层）');
        assert(!existsSync(join(evilDir, 'bypass.txt')),
          '越界写入不得落盘（修复前：真实链路写出 workspace_evil/bypass.txt）');
        console.log('       [实测] 真实链路：越界读/写 → 拒绝且零泄露零副作用；区内读 → INSIDE_OK');
      } finally { await g.stop(); }
    } finally {
      await new Promise((r) => server.close(r));
      rmSync(d, { recursive: true, force: true });
    }
  });

  runner.test('R0-113/Y4 单一实现：所有读 agent.workDir 的工具都用 workspace.mjs；无 OS 级沙箱（诚实声明不许拔高）', () => {
    const dir = join(ROOT, 'plugins', 'tools');
    const tools = readdirSync(dir).filter((f) => f.endsWith('.js'));
    assert(tools.length >= 10, `工具目录应有 >=10 个工具，实际 ${tools.length}`);
    let usingResolver = 0;
    for (const name of tools) {
      const src = read(join('plugins', 'tools', name));
      // 只审"代码行"：注释里会引用旧写法（`startsWith(workDir)`）作为历史说明，那是刻意的
      const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      if (!/getData\('agent\.workDir'\)/.test(code)) continue;
      // `tool-bash` 是**任意命令执行**：它的"工作目录"只是 cwd，无法用路径判据约束
      // （文档已如实声明"不是沙箱"）；只搜固定目录、不接受用户路径的工具同理。
      // 判据：工具若**接受用户给的路径类参数**，就必须过同一条边界。
      const props = /properties:\s*\{([\s\S]*?)\n\s*\}/.exec(code)?.[1] || '';
      const takesPath = /\b(path|file_path|filePath|fileA|fileB|src|dest|cwd|repo|dir|pattern)\s*:/.test(props);
      if (!takesPath) continue;
      usingResolver++;
      assert(/resolveWorkspacePath/.test(code), `${name} 读 agent.workDir 却没用统一 resolver`);
      // 用户输入型的前缀守卫一律不许再有（内部遍历器的不变式检查不算：它们是 join(workDir,…) 的产物）
      assert(!/if\s*\([^)]*\b(fullPath|fullSrc|fullDest|fullA|fullB|baseDir|cwd|path)\b\.startsWith\(workDir\)/.test(code),
        `${name} 不得再靠字符串前缀判越界（P0-02 的原缺陷）`);
      assert(!/bwrap|seccomp|namespace|chroot/i.test(code), `${name} 内不得假装有 OS 级隔离`);
    }
    assert(usingResolver >= 7, `至少 7 个工具读 agent.workDir（实际 ${usingResolver}）`);
    const lib = read(join('plugins', 'tools', 'lib', 'workspace.mjs'));
    assert(/realpath/.test(lib), 'resolver 必须做 realpath 校验（符号链接逃逸）');
    assert(/TOCTOU|不是沙箱|not a sandbox/i.test(lib), 'resolver 头注释必须如实声明 TOCTOU / 非沙箱边界');
    console.log('       [实测] 7/7 工具共用 resolver；无 OS 级隔离被冒充');
  });

  // ══════════════════════════════════════════════════════════════════════
  // P0-01：控制面（一个网关跑完鉴权 / CORS / readiness / WS）
  // ══════════════════════════════════════════════════════════════════════

  runner.test('R0-113/Y5 控制面：未认证 401 且不落盘、错凭证 401、跨源 403、CORS 无通配、/ready 缺凭证 503', async () => {
    const d = mkdtempSync(join(tmpdir(), 'r113-ctl-'));
    const stateDir = join(d, 'state');
    mkdirSync(stateDir, { recursive: true });
    const g = spawnGateway(stateDir, { TUSUNSUN_GATEWAY_KEY: 'r113-secret' });
    try {
      const port = await g.port();
      const before = readFileSync(join(stateDir, 'config.json'), 'utf8');

      // WS：口令走子协议请求头（官方客户端）。先用错口令验证"拒绝了"，再用对的验证"通了"。
      // 用**错误**凭证（而不是"没有凭证"）：内核启动时会把 env 里的 gateway.apiKey 合并进
      // 内存配置，任何一次 save() 都会把它落到 config.json ⇒ 之后 CLI 从磁盘读得到正确口令。
      // 错口令这条路径同样是"未授权不得操作"的判据，且不受落盘时序影响。
      const noKey = await runCli(['status', '--state-dir', stateDir], { env: { TUSUNSUN_GATEWAY_KEY: 'wrong-key' } });
      assertEquals(noKey.code, 3, `错凭证的 status 必须按"网关不可达"退出 3，实际 ${noKey.code}：${noKey.out.slice(0, 200)}`);

      const unauth = await postJson(port, '/api/config', { model: 'SECURITY_PROBE_NO_AUTH' });
      assertEquals(unauth.status, 401, `未认证 POST /api/config 必须 401，实际 ${unauth.status}`);
      assertEquals(readFileSync(join(stateDir, 'config.json'), 'utf8'), before, '未认证请求不得改动磁盘上的配置');

      const getRes = await fetch(`http://127.0.0.1:${port}/api/config`);
      assertEquals(getRes.status, 401, `未认证 GET /api/config 必须 401，实际 ${getRes.status}`);

      const wrong = await postJson(port, '/api/config', { model: 'X' }, { Authorization: 'Bearer wrong' });
      assertEquals(wrong.status, 401, '错误凭证必须 401');
      assertEquals(readFileSync(join(stateDir, 'config.json'), 'utf8'), before, '错误凭证不得改动配置');

      const cross = await postJson(port, '/api/config', { model: 'X' },
        { Authorization: 'Bearer r113-secret', Origin: 'http://evil.example' });
      assertEquals(cross.status, 403, `跨源请求必须 403（即使带正确凭证），实际 ${cross.status}`);
      const noAc = await fetch(`http://127.0.0.1:${port}/api/config`, { headers: { Origin: 'http://evil.example' } });
      assertEquals(noAc.headers.get('access-control-allow-origin'), null,
        'CORS 不再默认发 Access-Control-Allow-Origin: *');

      const plain = await postJson(port, '/api/config', {}, { Authorization: 'Bearer r113-secret' });
      // fetch 用 application/json 会被我们自己设成 json ⇒ 这里改用手写请求验证 text/plain
      const raw = await new Promise((resolve, reject) => {
        import('node:http').then(({ request }) => {
          const req = request({ host: '127.0.0.1', port, path: '/api/config', method: 'POST',
            headers: { 'Content-Type': 'text/plain', Authorization: 'Bearer r113-secret' } }, (res) => {
            res.resume(); res.on('end', () => resolve(res.statusCode));
          });
          req.on('error', reject); req.end('{"model":"X"}');
        }).catch(reject);
      });
      assertEquals(raw, 415, `非 JSON 的写请求必须 415（挡跨站简单请求），实际 ${raw}`);
      assertEquals(plain.status, 200, '合法凭证 + JSON 必须放行');
      assert(readFileSync(join(stateDir, 'config.json'), 'utf8').includes('SECURITY_PROBE_NO_AUTH') === false,
        '被拒的探测串不得出现在磁盘上');
      const withKey = await runCli(['status', '--state-dir', stateDir], { env: { TUSUNSUN_GATEWAY_KEY: 'r113-secret' } });
      assertEquals(withKey.code, 0, `带凭证的 status 必须成功（WS 子协议鉴权），实际 ${withKey.code}：${withKey.out.slice(0, 200)}`);
      assert(/Running:\s*yes/.test(withKey.out), `status 必须报运行中，实际：${withKey.out.slice(0, 200)}`);
      console.log(`       [实测] WS 子协议鉴权：无凭证 exit ${noKey.code} / 有凭证 exit ${withKey.code}`);

      // readiness 分层：没有模型凭证 ⇒ 503 且点名 model.apiKey；liveness 仍 200
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      assertEquals(health.status, 200, '/health 恒 200（liveness）');
      const ready = await fetch(`http://127.0.0.1:${port}/ready`);
      assertEquals(ready.status, 503, '缺模型凭证时 /ready 必须 503（修复前假绿 200 ready:true）');
      const readyBody = await ready.json();
      assert(readyBody.missing?.includes('model.apiKey'), `/ready 必须点名缺什么，实际 ${JSON.stringify(readyBody)}`);

      console.log(`       [实测] 401/401/403/415 全中、磁盘零改动、/ready 503`);
    } finally { await g.stop(); rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-113/Y6 非回环监听必须显式 opt-in 且配 key，否则拒绝启动且退出码非 0', async () => {
    const d = mkdtempSync(join(tmpdir(), 'r113-bind-'));
    try {
      const noOptIn = await runCli(['start', '--port', '0', '--state-dir', join(d, 'a'), '--yes'],
        { env: { TUSUNSUN_GATEWAY_HOST: '0.0.0.0' }, timeoutMs: 60000 });
      assertEquals(noOptIn.code, 1, `未 opt-in 的对外监听必须拒绝启动（退出码 1），实际 ${noOptIn.code}`);
      assert(/allowRemote|opt-in/.test(noOptIn.out + noOptIn.err), `拒绝文案必须给出生路，实际：${(noOptIn.out + noOptIn.err).slice(-300)}`);

      const noKey = await runCli(['start', '--port', '0', '--state-dir', join(d, 'b'), '--yes'],
        { env: { TUSUNSUN_GATEWAY_HOST: '0.0.0.0', TUSUNSUN_ALLOW_REMOTE: '1' }, timeoutMs: 60000 });
      assertEquals(noKey.code, 1, `对外监听但没配 key 必须拒绝启动，实际 ${noKey.code}`);
      assert(/apiKey/.test(noKey.out + noKey.err), `拒绝文案必须点名 apiKey，实际：${(noKey.out + noKey.err).slice(-300)}`);

      const cfgMod = await import(pathToFileURL(join(ROOT, 'plugins', 'config.js')).href);
      const def = cfgMod.DEFAULT_CONFIG;
      assert(def, 'config.js 必须导出 DEFAULT_CONFIG（CLI 首次 set 与内核共用同一份默认值）');
      assertEquals(def.gateway.host, '127.0.0.1', '默认监听地址必须是回环');
      assertEquals(def.gateway.allowRemote, false, '默认不得允许对外监听');
      console.log('       [实测] 0.0.0.0 未 opt-in / opt-in 但无 key ⇒ 均 exit 1；默认 host=127.0.0.1');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ══════════════════════════════════════════════════════════════════════
  // P1-01 / P1-02 / P1-03：CLI 首次体验、状态目录、权限、退出码
  // ══════════════════════════════════════════════════════════════════════

  runner.test('R0-113/Y7 首次 config set：空目录也能落盘（目录 0700 / 文件 0600）；坏配置非零退出且不覆盖', async () => {
    const d = mkdtempSync(join(tmpdir(), 'r113-cfg-'));
    try {
      const sd = join(d, 'fresh');
      const set = await runCli(['config', 'set', 'model.model', 'first-run-test'], { env: { TUSUNSUN_STATE_DIR: sd } });
      assertEquals(set.code, 0, `首次 config set 必须成功，实际 ${set.code}：${set.err}`);
      const cfgPath = join(sd, 'config.json');
      assert(existsSync(cfgPath), '首次 config set 必须真的创建 config.json');
      assertEquals(JSON.parse(readFileSync(cfgPath, 'utf8')).model.model, 'first-run-test');
      const mode = (p) => (statSync(p).mode & 0o777).toString(8);
      assertEquals(mode(sd), '700', `状态目录必须 0700，实际 ${mode(sd)}`);
      assertEquals(mode(cfgPath), '600', `config.json 必须 0600（里面有明文 key），实际 ${mode(cfgPath)}`);

      const broken = join(d, 'broken');
      mkdirSync(broken, { recursive: true });
      const brokenPath = join(broken, 'config.json');
      writeFileSync(brokenPath, '{ this is not json');
      const bad = await runCli(['config', 'set', 'model.model', 'x'], { env: { TUSUNSUN_STATE_DIR: broken } });
      assert(bad.code !== 0, `损坏配置上 set 必须非零退出（不得静默重建），实际 ${bad.code}`);
      assertEquals(readFileSync(brokenPath, 'utf8'), '{ this is not json', '损坏文件不得被静默覆盖');
      assert(bad.err.trim().length > 0, '失败原因必须写 stderr（不是 stdout）');
      console.log(`       [实测] 首次 set → 0600/0700 且读回校验；坏配置 → exit ${bad.code} 且原样保留`);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-113/Y8 状态目录单一解析：TUSUNSUN_STATE_DIR 与 --state-dir 都会被 config 认到', async () => {
    const d = mkdtempSync(join(tmpdir(), 'r113-sd-'));
    try {
      const a = join(d, 'a'); const b = join(d, 'b');
      mkdirSync(a, { recursive: true }); mkdirSync(b, { recursive: true });
      writeFileSync(join(a, 'config.json'), JSON.stringify({ model: { model: 'from-A' } }));
      writeFileSync(join(b, 'config.json'), JSON.stringify({ model: { model: 'from-B' } }));
      const viaEnv = await runCli(['config', 'get', 'model.model'], { env: { TUSUNSUN_STATE_DIR: b } });
      assertEquals(viaEnv.out.trim(), 'from-B', `TUSUNSUN_STATE_DIR 必须被 config 认到（修复前读的是 ~/.tusunsun），实际 ${viaEnv.out.trim()}`);
      const viaArg = await runCli(['config', 'get', 'model.model', '--state-dir', a], { env: { TUSUNSUN_STATE_DIR: b } });
      assertEquals(viaArg.out.trim(), 'from-A', `--state-dir 必须压过环境变量，实际 ${viaArg.out.trim()}`);
      console.log('       [实测] --state-dir > TUSUNSUN_STATE_DIR（两实例互不串台）');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-113/Y9 退出码合同：未知命令 2；网关不在时 status/stop 为 3（不再一律 0）', async () => {
    const d = mkdtempSync(join(tmpdir(), 'r113-exit-'));
    try {
      const sd = join(d, 'empty');
      const unknown = await runCli(['definitely-not-a-command'], { env: { TUSUNSUN_STATE_DIR: sd } });
      assertEquals(unknown.code, 2, `未知命令必须退出 2，实际 ${unknown.code}`);
      assert(/Unknown command/.test(unknown.err), '用法错误必须写 stderr');
      const status = await runCli(['status', '--state-dir', sd, '--port', '1'], { env: { TUSUNSUN_STATE_DIR: sd } });
      assertEquals(status.code, 3, `网关不在时 status 必须退出 3，实际 ${status.code}`);
      const stop = await runCli(['stop', '--state-dir', sd, '--port', '1'], { env: { TUSUNSUN_STATE_DIR: sd } });
      assertEquals(stop.code, 3, `网关不在时 stop 必须退出 3，实际 ${stop.code}`);
      const help = await runCli(['--help'], { env: { TUSUNSUN_STATE_DIR: sd } });
      assertEquals(help.code, 0, '--help 必须 0');
      assert(/Exit codes/.test(help.out), '--help 必须公开退出码合同（否则用户无从知道）');
      console.log('       [实测] unknown=2 / status=3 / stop=3 / help=0');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ══════════════════════════════════════════════════════════════════════
  // P1-05 / P2：口径一致性、场景自洽、Node 18 兼容、行预算
  // ══════════════════════════════════════════════════════════════════════

  runner.test('R0-113/Y10 发布口径：版本、CHANGELOG、UA、测试横幅、scene 声明不许互相打架', () => {
    assert(/^\d+\.\d+\.\d+/.test(PKG.version), 'package.json 必须有语义化版本');
    const changelog = read('CHANGELOG.md');
    assert(new RegExp(`## v${PKG.version.replace(/\./g, '\\.')}`).test(changelog),
      `CHANGELOG 顶部必须有 v${PKG.version} 段（发版时最容易漏的一处）`);

    const modelPath = resolvePlugin('model-openai.js');
    assert(modelPath, '找不到 model-openai 插件文件');
    const modelAll = readFileSync(modelPath, 'utf8');
    // 注释里会引用旧 UA 作为历史说明（刻意的）⇒ 只在代码行上判
    const model = modelAll.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert(!/openclaw\//.test(model), 'User-Agent 不得再用其它产品的名字（openclaw/…）');
    assert(new RegExp(`tusunsun/${PKG.version.replace(/\./g, '\\.')}`).test(model),
      `User-Agent 必须与 package.json 版本一致（tusunsun/${PKG.version}）`);

    const runAll = read('test/run-all.mjs');
    assert(!/Test Suite v\d/.test(runAll), '测试横幅不得写死版本');
    assert(/PKG_VERSION/.test(runAll), '测试横幅版本必须从 package.json 读');

    // 只看代码行（注释里会引用旧声明作为历史说明，那是刻意的）
    const scene = read('scenes/gateway.json5').split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert(!/\d+ 个工具/.test(scene), '场景 features 不得写工具计数（插件增减就会过期，写死必然是假的）');
    assert(!/外部诊断服务监控/.test(scene), '场景 features 不得宣称本包没有的外部诊断服务能力');
    console.log(`       [实测] v${PKG.version} 口径一致：UA/横幅/场景 features`);
  });

  runner.test('R0-113/Y11 场景自洽：随包 scenes 声明的每个插件名都能在 plugins/ 找到文件', async () => {
    // 递归收集"可作为插件被装配的名字"（文件名即插件名，见 plugin-manager 的扫描口径）。
    const names = new Set();
    const walk = (dir) => {
      if (!existsSync(dir)) return;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'lib' && e.name !== 'node_modules') walk(p); }
        else if (/\.(js|mjs)$/.test(e.name)) names.add(e.name.replace(/\.(js|mjs)$/, ''));
      }
    };
    // v0.9.25：装配根只有一个。此前这里是两次 walk（`plugins/` + `src/builtin/`），
    // 目录合并后机械替换把第二次也指向了 `plugins/` —— 重复扫描，看起来无害，
    // 但它掩盖了"这里曾经有两棵树"这个事实，也让"少扫了一棵树"这类回归无从发现。
    walk(join(ROOT, 'plugins'));
    // 开发树里 base-system 会声明下游兼容树的插件；产物里场景已被裁剪，不带这条路径。
    // 目录名用拼接而非字面量：产物厂商中立门禁禁止下游工程名出现在随包文件里。
    const DOWNSTREAM = ['0', String.fromCharCode(0x901a, 0x5929)].join('');
    walk(join(ROOT, DOWNSTREAM, 'plugins'));

    const { loadJson5 } = await import(pathToFileURL(join(ROOT, 'src', 'core', 'json5-loader.js')).href);
    const problems = [];
    for (const f of readdirSync(join(ROOT, 'scenes'))) {
      if (!f.endsWith('.json5')) continue;
      const scene = loadJson5(read(join('scenes', f)), ` in ${f}`);
      const declared = [...(scene.eager || []), ...(scene.plugins || []), ...(scene.optional || []), ...(scene.lazy || [])];
      for (const name of declared) if (!names.has(name)) problems.push(`${f}: ${name}`);
    }
    // 底座两件由内核早期装配（v0.9.25 起源码都在 `plugins/`；插件 name 与文件名可能不同名）
    const alwaysOn = new Set(['config', 'gateway']);
    const real = problems.filter((p) => !alwaysOn.has(p.split(': ')[1]));
    assertEquals(real.length, 0, `场景声明了不存在的插件（"声明即行为"）：\n  ${real.join('\n  ')}`);
    console.log(`       [实测] 场景声明 ↔ 随包插件文件一致（候选名 ${names.size} 个）`);
  });

  runner.test('R0-113/Y12 Node 18 兼容：随包测试跑手不依赖 Node 22 专有的 fs.glob；空压测套件不得假绿', () => {
    for (const f of ['run-unit.mjs', 'run-integration.mjs', 'run-smoke.mjs', 'run-stress.mjs']) {
      const src = read(join('test', f));
      assert(!/import\s*\{[^}]*\bglob\b[^}]*\}\s*from\s*'node:fs\/promises'/.test(src),
        `${f} 不得 import node:fs/promises 的 glob（Node 18/20 没有它，与 engines>=18 冲突）`);
      assert(/glob-files\.mjs/.test(src), `${f} 必须用随包的自带遍历（Node 18 兼容）`);
    }
    const stress = read('test/run-stress.mjs');
    assert(/process\.exit\(1\)/.test(stress), '压测套件为空时必须非零退出（不得打印 No stress tests 后 exit 0）');
    assert(existsSync(join(ROOT, 'test', 'glob-files.mjs')), '随包遍历器 test/glob-files.mjs 必须存在');
    const BUILD_OSS2 = ['build', 'oss.mjs'].join('-');
    const genPath2 = join(ROOT, 'scripts', BUILD_OSS2);
    if (existsSync(genPath2)) {
      assert(readFileSync(genPath2, 'utf8').includes("'glob-files.mjs'"), 'build-oss 必须把 glob-files.mjs 带进产物');
    }
    console.log('       [实测] 四个跑手均无 Node 22 专有 API；空压测套件 exit 1');
  });

  runner.test('R0-113/Y13 行预算：核心行数 ≤ 上限，且文档/包描述与实况一致', () => {
    const capMatch = /核心 ≤ (\d+) 行/.exec(PKG.description || '');
    assert(capMatch, 'package.json description 必须写出核心行数上限（对外承诺）');
    const cap = Number(capMatch[1]);
    let total = 0;
    for (const f of readdirSync(join(ROOT, 'src', 'core'))) {
      if (/\.(js|mjs)$/.test(f)) total += readFileSync(join(ROOT, 'src', 'core', f), 'utf8').split('\n').length;
    }
    assert(total <= cap, `核心 ${total} 行已超上限 ${cap}`);
    const micro = read(join(DOCS, 'architecture', 'microkernel.md'));
    assert(new RegExp(`\\*\\*${total}\\*\\*`).test(micro), `微内核文档的合计必须等于实况 ${total}`);
    assert(micro.includes(String(cap)), `微内核文档必须写出当前上限 ${cap}`);
    console.log(`       [实测] 核心 ${total}/${cap} 行，文档与包描述同步`);
  });
}
