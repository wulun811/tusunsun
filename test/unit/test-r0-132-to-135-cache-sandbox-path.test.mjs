// R0-132 ~ R0-135（v0.9.31）：一轮**全面**排查查出的四条缺陷。
//
// 与 R0-128~131 的关系：那四轮是"专家点名一条、我修一条"。这一轮反过来 ——
// 用户要求"全面排查"，所以我按**形态**扫，而不是按报告扫。扫的形态是本项目反复踩的三种：
//   ① 判据用在了错的层级（名字 vs 能力、前缀 vs 包含）；
//   ② 声明了但执行期零读者（"装饰品开关"）；
//   ③ 授权与优化混在一处，于是优化短路了授权。
//
// 查出的四条（全部实测真阳性，不是推演）：
//
//   R0-132 **结果缓存是授权旁路**。`_doToolExecute` 第一行就是 `_getFromCache`，
//          在能力解析与 `_dispatchGuard` **之前**。两个后果：
//            · 撤销之后同参数再调 → `ok:true / succeeded`，撤销门一次都没跑；
//            · **写类工具也被缓存** → `tool-write` 第二次返回 `succeeded`，handler 只跑 1 次。
//   R0-133 **`sandbox.enabled` 在默认路径上是装饰品**。`_maybeSandbox` 只在默认关闭的
//          legacy 路径调用一次；真正走的能力路径从不调用。实测 enabled=true、装一个
//          一律 DENY 的 sandbox：调用次数 0、文件真实写盘、`succeeded`。
//   R0-134 **沙箱的路径判据仍是字符串前缀**。R0-113 在文件工具里修过
//          （`workspace/` vs `workspace_evil/`），沙箱这份被漏掉：
//          `/home/user/project_evil/x` 与 `/home/user/project/../../etc/passwd` 都放行。
//          沙箱本该比文件工具更硬，结果更松。
//   R0-135 **`hook_errors` 没有生产读者**。v0.9.30 加了计数器与 `getSecurityStats()`，
//          但全仓只有测试读它 —— 又一个"字段被写入、执行期零读者"。
//
// 每条都必须能被"把判据删掉"打红。
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve as resolvePath, relative, isAbsolute, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TestRunner, assert, assertEquals } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(join(ROOT, rel));

/**
 * 真 Core + 真 tool-executor。`config` 用来控制 permissionMode / sandbox.enabled。
 * `sandbox` 传一个对象就注册成 `sandbox` 服务（用于观测它到底被调用了几次）。
 */
async function makeHost({ base, config = {}, sandbox = null }) {
  const ws = join(base, 'ws');
  mkdirSync(ws, { recursive: true });
  const { Core } = await imp('src/core/core.js');
  const core = new Core({ stateDir: join(base, 'state') });
  core.log = () => {};
  core.setData('agent.workDir', ws);

  if (Object.keys(config).length > 0) {
    core.registerService('config', { get: (k, fb) => (k in config ? config[k] : fb) });
  }
  await (await imp('plugins/workspace.js')).default.init(core);

  if (sandbox) core.registerService('sandbox', sandbox);

  const exec = Object.create((await imp('plugins/tool-executor.js')).default);
  exec._preHooks = []; exec._postHooks = []; exec._dispatchHooks = [];
  exec._rateCalls = new Map(); exec._cache = new Map(); exec._auditLog = new Map();
  await exec.init(core);
  return { core, ws, exec };
}

export async function setup(runner) {
  const base = () => mkdtempSync(join(tmpdir(), 'r13x-'));

  // ══ R0-132：缓存不得短路授权，也不得覆盖写类工具 ══════════════════════════
  runner.test('R0-132/a 撤销后命中缓存：不得返回成功（缓存不能绕过派发期复核）', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d });
      let calls = 0;
      h.core.registerCapability('tool.read', {
        owner: 'tool-read',
        handler: async () => { calls++; return 'read-ok'; },
      });

      // 第一次：正常调用，结果进缓存
      const a = await h.exec.executeOne('tool-read', { path: 'a.txt' }, 's1', 'c1');
      assertEquals(a.state, 'succeeded', '第一次应成功');
      assertEquals(calls, 1, '第一次应真的执行 handler');

      // 撤销：装一条一律拒绝的派发钩子
      h.exec.registerDispatchHook(() => (
        { block: true, reason: 'execution_revoked: test', code: 'execution_revoked' }), 'test-gate');

      const b = await h.exec.executeOne('tool-read', { path: 'a.txt' }, 's1', 'c1');
      assertEquals(b.state, 'rejected',
        `撤销后不得返回成功 —— 修前实测 ok:true/succeeded（缓存命中，撤销门一次都没跑），实际 ${b.state}`);
      assertEquals(b.code, 'execution_revoked', `拒绝码应为 execution_revoked，实际 ${b.code}`);
      assertEquals(calls, 1, '被拒的调用不得执行 handler');
      console.log('       [实测] 撤销后同参数调用 → rejected/execution_revoked，缓存不再短路授权');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-132/b 写类工具不得缓存：同参数第二次必须真的再执行一次', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d });
      let calls = 0;
      h.core.registerCapability('tool.write', {
        owner: 'tool-write',
        handler: async (a) => {
          calls++;
          writeFileSync(join(h.ws, a.path), a.content);
          return 'WROTE';
        },
      });

      const a = await h.exec.executeOne('tool-write', { path: 'x.txt', content: 'v1' }, 's1', 'c1');
      const b = await h.exec.executeOne('tool-write', { path: 'x.txt', content: 'v1' }, 's1', 'c1');
      assertEquals(a.state, 'succeeded', '第一次应成功');
      assertEquals(b.state, 'succeeded', '第二次也应成功');
      assertEquals(calls, 2,
        `写类工具每次调用都必须真的执行 —— 修前实测 handler 只跑 1 次而第二次仍报 succeeded，实际 ${calls}`);
      console.log('       [实测] tool-write 连调两次 → handler 执行 2 次（写类不缓存）');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-132/c 反例：只读工具仍应命中缓存（不得为修授权而废掉缓存）', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d });
      let calls = 0;
      h.core.registerCapability('tool.read', {
        owner: 'tool-read',
        handler: async () => { calls++; return 'read-ok'; },
      });
      await h.exec.executeOne('tool-read', { path: 'a.txt' }, 's1', 'c1');
      await h.exec.executeOne('tool-read', { path: 'a.txt' }, 's1', 'c1');
      assertEquals(calls, 1,
        `只读工具第二次应命中缓存（修法针对写类，不是一刀切关掉缓存），实际执行 ${calls} 次`);
      console.log('       [实测] 只读工具连调两次 → handler 仅执行 1 次（缓存保留）');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-132/d 缓存键里的 per-call 控制字段不得让写入被误判为"没变"', async () => {
    // 缓存键含 `_tcId` 等每次调用都不同的字段时，真实链路几乎不可能命中；
    // 本测试钉住的是**语义**：content 变了、path 没变，绝不返回旧结果。
    const d = base();
    try {
      const h = await makeHost({ base: d });
      h.core.registerCapability('tool.write', {
        owner: 'tool-write',
        handler: async (a) => { writeFileSync(join(h.ws, a.path), a.content); return 'WROTE'; },
      });
      await h.exec.executeOne('tool-write', { path: 'y.txt', content: 'v1' }, 's1', 'c1');
      await h.exec.executeOne('tool-write', { path: 'y.txt', content: 'v2' }, 's1', 'c1');
      const onDisk = (await import('node:fs')).readFileSync(join(h.ws, 'y.txt'), 'utf8');
      assertEquals(onDisk, 'v2', `第二次写入必须真的落盘（内容 v2），实际 "${onDisk}"`);
      console.log('       [实测] 同路径不同内容 → 磁盘内容为 v2（写类调用未被旧结果顶替）');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ══ R0-133：sandbox.enabled 必须在默认（能力）路径上真的生效 ═══════════════
  runner.test('R0-133/a 能力路径必须过沙箱：enabled=true 时沙箱的拒绝必须真的拦住执行', async () => {
    const d = base();
    try {
      let sandboxCalls = 0;
      const h = await makeHost({
        base: d,
        config: { 'sandbox.enabled': true },
        sandbox: {
          execute: async () => { sandboxCalls++; return { ok: false, error: 'SANDBOX_DENIED' }; },
        },
      });
      let handlerRan = false;
      h.core.registerCapability('tool.write', {
        owner: 'tool-write',
        handler: async (a) => { handlerRan = true; writeFileSync(join(h.ws, a.path), a.content); return 'WROTE'; },
      });

      const r = await h.exec.executeOne('tool-write', { path: 'o.txt', content: 'x' }, 's1', 'c1');
      assertEquals(h.exec._useSandbox, true, '前提：sandbox.enabled 已被执行器读到');
      assertEquals(sandboxCalls, 1,
        `沙箱必须被调用 —— 修前实测 0 次（能力路径从不调 _maybeSandbox），实际 ${sandboxCalls}`);
      assertEquals(r.ok, false, `沙箱拒绝时不得返回成功，实际 ok=${r.ok}/state=${r.state}`);
      assertEquals(handlerRan, false, '沙箱拒绝时 handler 不得执行');
      assertEquals(existsSync(join(h.ws, 'o.txt')), false, '沙箱拒绝时不得写盘');
      console.log('       [实测] enabled=true → 沙箱被调用 1 次、拒绝生效、无落盘');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-133/b 反例：sandbox.enabled=false 时不得调用沙箱（不得凭空加一层）', async () => {
    const d = base();
    try {
      let sandboxCalls = 0;
      const h = await makeHost({
        base: d,
        sandbox: { execute: async () => { sandboxCalls++; return { ok: false, error: 'NOPE' }; } },
      });
      h.core.registerCapability('tool.write', {
        owner: 'tool-write',
        handler: async (a) => { writeFileSync(join(h.ws, a.path), a.content); return 'WROTE'; },
      });
      const r = await h.exec.executeOne('tool-write', { path: 'ok.txt', content: 'x' }, 's1', 'c1');
      assertEquals(sandboxCalls, 0, `未启用沙箱时不得调用它，实际 ${sandboxCalls} 次`);
      assertEquals(r.state, 'succeeded', `未启用沙箱时应正常执行，实际 ${r.state}`);
      console.log('       [实测] enabled=false → 沙箱 0 次调用，正常执行');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-133/c 撤销与沙箱的次序：撤销后连沙箱都不得被调用', async () => {
    // 沙箱自己也是**有副作用的执行器**（它真的去 bash/写盘），所以撤销后不能"先沙箱再看"。
    const d = base();
    try {
      let sandboxCalls = 0;
      const h = await makeHost({
        base: d,
        config: { 'sandbox.enabled': true },
        sandbox: { execute: async () => { sandboxCalls++; return { ok: true, data: 'x' }; } },
      });
      h.core.registerCapability('tool.write', { owner: 'tool-write', handler: async () => 'WROTE' });
      h.exec.registerDispatchHook(() => (
        { block: true, reason: 'execution_revoked: test', code: 'execution_revoked' }), 'test-gate');

      const r = await h.exec.executeOne('tool-write', { path: 'z.txt', content: 'x' }, 's1', 'c1');
      assertEquals(r.state, 'rejected', `撤销后必须拒绝，实际 ${r.state}`);
      assertEquals(sandboxCalls, 0,
        `撤销后连沙箱都不得被调用（沙箱也是有副作用的执行器），实际 ${sandboxCalls} 次`);
      console.log('       [实测] 撤销后 → 直接拒绝，沙箱 0 次调用');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-133/d 沙箱在场时要么接管要么拒绝，**没有"放行后落到 handler"这条路**', async () => {
    // 这一条替换掉 v0.9.31 的写法。原来那条断言"沙箱 await 之后还要再复核一次"，
    // 而本轮自查发现：`_maybeSandbox` 的返回只有 null / 沙箱结果 / "未声明"拒绝 三种，
    // **不存在"沙箱放行后继续落到真 handler"**。所以那道"第三道复核"是死代码，
    // 原测试之所以能过，是因为它用了一个沙箱映射外的 op 让它以为走到了那条路。
    //
    // 现在钉住真正的不变式：只要沙箱在场且工具声明了 op，**handler 一次都不能跑**，
    // 结果必须来自沙箱（而不是"沙箱看过了，然后自己又跑了一遍"）。
    const d = base();
    try {
      let sandboxCalls = 0, handlerRan = false;
      const h = await makeHost({
        base: d,
        config: { 'sandbox.enabled': true },
        sandbox: { execute: async () => { sandboxCalls++; return { ok: true, data: 'FROM_SANDBOX' }; } },
      });
      h.core.registerCapability('tool.customwrite', {
        owner: 'tool-customwrite',
        handler: async (a) => { handlerRan = true; writeFileSync(join(h.ws, a.path), a.content); return 'REAL_HANDLER'; },
      });
      h.core.registerService('tool-registry', {
        get: async (n) => (n === 'tool-customwrite'
          ? { name: 'tool-customwrite', sandboxOp: 'custom-exec', provides: [{ name: 'tool.customwrite' }] }
          : null),
        has: (n) => n === 'tool-customwrite', list: () => [],
      });

      const r = await h.exec.executeOne('tool-customwrite', { path: 'x.txt', content: 'y' }, 's1', 'c1');
      assertEquals(sandboxCalls, 1, `沙箱应被调用 1 次，实际 ${sandboxCalls}`);
      assertEquals(handlerRan, false,
        '沙箱在场时 handler 不得执行 —— 否则等于"沙箱看过了，然后又自己跑了一遍"，沙箱形同虚设');
      assertEquals(r.result, 'FROM_SANDBOX', `结果必须来自沙箱，实际 ${JSON.stringify(r.result)}`);
      assertEquals(existsSync(join(h.ws, 'x.txt')), false, 'handler 没跑，就不该有文件落盘');
      console.log('       [实测] sandbox 接管（1 次调用），handler 未执行，结果来自沙箱');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-139 沙箱分支里不得保留不可达的复核（死代码会让后人以为还有保护）', async () => {
    const src = (await import('node:fs')).readFileSync(join(ROOT, 'plugins/tool-executor.js'), 'utf8');
    // `_maybeSandbox` 之后紧跟的那一段里，不应该再出现一次 `_dispatchGuard`：
    // 只有当"沙箱放行后仍落到 handler"这条路存在时它才有意义，而那条路不存在。
    // ⚠ 判据必须**只认真正的调用**，不能数注释里的字样 —— 那正是本项目反复踩的
    // "守排版不守接线"。第一版就是因为注释里写了 `_dispatchGuard` 而误红。
    const i = src.indexOf('const sandboxResult = await this._maybeSandbox');
    assert(i > 0, '应能找到沙箱调用点');
    // 剥掉行注释与块注释后再找调用
    const tail = src.slice(i, i + 1500)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert(!/this\._dispatchGuard\s*\(/.test(tail),
      '沙箱调用之后仍有 `this._dispatchGuard(...)` 真调用 —— 那是不可达代码（R0-139），请删除或说明它为何可达');
    console.log('       [实测] 沙箱之后无不可达复核');
  });

  // ══ R0-134：沙箱路径判据必须是目录包含，不是字符串前缀 ═══════════════════
  runner.test('R0-134/a 同级前缀目录必须被拒（R0-113 同类缺陷，沙箱这一份此前被漏掉）', async () => {
    const sb = (await imp('plugins/sandbox.js')).default;
    const saved = { deny: sb._deny, writeAllow: sb._writeAllow, readAllow: sb._readAllow };
    try {
      // 用真实临时目录构造"同级前缀"，避免写死 /home/xxx
      const base = mkdtempSync(join(tmpdir(), 'sbx-'));
      const okDir = join(base, 'project');
      const evilDir = join(base, 'project_evil');
      mkdirSync(okDir, { recursive: true }); mkdirSync(evilDir, { recursive: true });
      sb._deny = []; sb._writeAllow = [okDir]; sb._readAllow = [okDir];

      // S1 / R0-159：`_guard` 现在是**异步**的（它要 realpath）。这一条同时钉住
      // "判据异步化之后，原有的三条结论一条都没变" —— 否则修符号链接会把旧保护弄丢。
      const inside = await sb._guard('write', { path: join(okDir, 'a.txt') });
      assertEquals(inside.ok, true, '工作区内的写入必须放行（不得误伤）');

      const sibling = await sb._guard('write', { path: join(evilDir, 'x.txt') });
      assertEquals(sibling.ok, false,
        `同级前缀目录必须被拒 —— startsWith 判据下这里是放行的，实际 ok=${sibling.ok}`);

      const traversal = await sb._guard('write', { path: join(okDir, '..', '..', 'etc', 'passwd') });
      assertEquals(traversal.ok, false,
        `路径穿越必须被拒 —— startsWith 判据下 '..' 未归一化，实际 ok=${traversal.ok}`);
      console.log('       [实测] 同级前缀目录与 ../ 穿越均被拒，工作区内写入仍放行');
      rmSync(base, { recursive: true, force: true });
    } finally {
      sb._deny = saved.deny; sb._writeAllow = saved.writeAllow; sb._readAllow = saved.readAllow;
    }
  });

  runner.test('R0-134/b deny 前缀不得误伤：/etcx 不是 /etc', async () => {
    const sb = (await imp('plugins/sandbox.js')).default;
    const saved = { deny: sb._deny, writeAllow: sb._writeAllow, readAllow: sb._readAllow };
    try {
      sb._deny = ['/etc']; sb._writeAllow = []; sb._readAllow = [];
      assertEquals((await sb._guard('read', { path: '/etc/passwd' })).ok, false, '/etc/passwd 必须被拒');
      // /etcx 是 denied 项的同级目录，不是它内部
      assertEquals((await sb._guard('read', { path: '/etcx/passwd' })).ok, true,
        'deny 判据必须是包含关系：/etcx 不在 /etc 之下，不得被前缀误伤');
      console.log('       [实测] /etc/passwd 拒、/etcx/passwd 放（包含关系而非前缀）');
    } finally {
      sb._deny = saved.deny; sb._writeAllow = saved.writeAllow; sb._readAllow = saved.readAllow;
    }
  });

  // ══ R0-135：安全判据读数必须有生产读者 ═══════════════════════════════════
  runner.test('R0-135/a 健康面必须真的把 hook_errors 读出来（运行时判据，不数源码里的字符串）', async () => {
    // ⚠ 这一条第一版是**假绿**：它只断言 gateway.js 源码里出现 `getSecurityStats` 这个词。
    // 变异实验证实了后果 —— 把健康面改成 `return null`（读者没了），测试照样绿，
    // 因为注释里还留着那个词。这正是我在 R0-130/E 上刚批评过的
    // **"守的是排版，不是接线"**。改成：把 gateway 的健康面**真跑一遍**，看响应体里有没有数。
    //
    // 做法：用真 Core + 真 gateway，直接调它的健康分支。gateway 的 init 会 listen，
    // 所以这里只取它的原型方法，配一个最小 core，抓 _sendJson 的入参。
    const { Core } = await imp('src/core/core.js');
    const d = base();
    try {
      const core = new Core({ stateDir: join(d, 'state') });
      core.log = () => {};

      // 装一个假执行器：hook_errors=7，用来证明健康面读到的是**执行器的实时读数**
      // 而不是某个常量（否则 `security:{hook_errors:0}` 这样的硬编码也能过）。
      core.registerService('tool-executor', {
        getSecurityStats: () => ({
          hook_errors: 7, dispatch_hooks: 2, pre_hooks: 3, fail_closed_hooks: 1,
        }),
      });

      const gw = Object.create((await imp('plugins/gateway.js')).default);
      gw.core = core;
      gw._readinessMissing = async () => [];        // 前提：就绪，走 200 分支
      let sent = null;
      gw._sendJson = (res, code, body) => { sent = { code, body }; };

      // 直接驱动**真正的**健康分支（`/health` 与 `/ready` 都经过它）。
      const req = { method: 'GET', url: '/health', headers: { host: '127.0.0.1:9002' } };
      const res = { setHeader() {}, end() {}, writeHead() {} };
      await gw._handleHttpRequest(req, res);

      assert(sent, '健康分支没有通过 _sendJson 出响应，本测试无法判定（拒绝假绿）');
      assert(sent.body.security, '健康面响应体里没有 security 读数 —— 执行器的计数器没有生产读者');
      assertEquals(sent.body.security.hook_errors, 7,
        `健康面必须读执行器的**实时**读数（期望 7），实际 ${JSON.stringify(sent.body.security)}`);
      console.log(`       [实测] /health 响应体 security = ${JSON.stringify(sent.body.security)}`);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-135/b 判据故障必须 fail-closed 且有读数递增（"保护失效"与"策略拒绝"可区分）', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d });
      h.core.registerCapability('tool.read', { owner: 'tool-read', handler: async () => 'ok' });
      assertEquals(h.exec.getSecurityStats().hook_errors, 0, '初始应为 0');

      // ① 策略拒绝：不计入 hook_errors
      h.exec.registerDispatchHook(() => (
        { block: true, reason: 'policy says no', code: 'capability_denied' }), 'policy-gate');
      const p1 = await h.exec.executeOne('tool-read', { path: 'a.txt' }, 's1', 'c1');
      assertEquals(p1.state, 'rejected', '策略拒绝必须是 rejected');
      assertEquals(h.exec.getSecurityStats().hook_errors, 0,
        '策略拒绝**不得**计入 hook_errors —— 它不是"判据坏了"');

      // ② 判据故障：计数 +1，且 fail-closed
      h.exec.removeHooksByOwner('policy-gate');
      h.exec.registerDispatchHook(() => { throw new Error('judge broke'); }, 'broken-gate');
      const p2 = await h.exec.executeOne('tool-read', { path: 'a.txt' }, 's1', 'c1');
      assertEquals(p2.state, 'rejected', `判据故障必须 fail-closed，实际 ${p2.state}`);
      assertEquals(p2.code, 'HOOK_ERROR', `应为 HOOK_ERROR，实际 ${p2.code}`);
      assertEquals(h.exec.getSecurityStats().hook_errors, 1,
        '判据故障必须被计数（这是"保护失效"与"策略拒绝"的唯一区分手段）');
      console.log('       [实测] 策略拒绝不计数；判据故障计 1 次且 rejected/HOOK_ERROR');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ══ 顺手：_checkPreFlight 的 opts 形参零读者（声明了但没人用） ═════════════
  runner.test('R0-135/c _checkPreFlight 不得保留零读者的形参（声明了但没人读）', async () => {
    const src = (await import('node:fs')).readFileSync(join(ROOT, 'plugins/tool-executor.js'), 'utf8');
    assert(!/_checkPreFlight\s*\([^)]*\bopts\s*=/.test(src),
      '_checkPreFlight 的 opts 形参在整个函数体里零读者 —— 留着它会让调用方以为存在一个并不存在的接线口');
    console.log('       [实测] _checkPreFlight 已无零读者形参');
  });
}
