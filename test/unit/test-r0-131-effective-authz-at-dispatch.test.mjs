// R0-131：**授权必须以真实解析出的能力为准，且必须在派发那一刻仍然成立**（v0.9.30）。
//
// 由来：第九轮独立复审给出了两个 P0 候选反例，都已在真 Core / CellRuntime / ToolExecutor
// 上复现（不是推演）：
//
//   A. **工具别名越权**。`cell-runtime` 的 `capIdOf` 只认 `tool-` 前缀派生，而执行器的
//      `_capabilityIdsForTool` 认三条来源（命名约定 / 工具自报 `provides[]` / owner 反查）。
//      安全门用窄算法、执行器用宽算法 —— 于是"名字不像写的工具"可以真的写盘。
//      实测：`permission_mode=read-only`、仅授予 `tool.read` 的 Cell，调一个
//      `provides: [{name:'tool.write'}]` 的别名工具 → `state:succeeded`、文件真实存在。
//
//      更难看的一层：只读清单里有个**下划线兼容名** `read_file`。宿主级
//      `tools.permissionMode='read-only'` 时，一个叫 `read_file` 却 `provides: tool.write`
//      的工具**按名字**通过只读检查，按 provides 真写盘。清单没错，错在拿"名字在清单里"
//      当"效果类别是只读"的授权依据。
//
//   B. **检查后撤销、使用前启动**。pre-hook 通过之后还有两次 await（懒加载解析、能力超时
//      竞速）。在那个窗口里 `close(force)` 返回 `stopped`，放行后 handler 照常启动并写盘。
//      实测：`close` 回报 `quiesced:false, inflight:1`，随后 `tool => succeeded 'WRITE_OK'`，
//      Cell 结果诚实标 `unknown` —— **诚实但不能阻止副作用**。
//
// 修法的形状与 R0-128/129/130 是同一个：**判据必须读真正被调用的那个东西**。
//   A → 判断从"工具名"改为"解析出的能力 id"（`_lib/tool-policy.js` 新增
//       `isReadonlyCapability`，语义是"未登记即非只读"）。
//   B → 新增**派发期钩子**（`registerDispatchHook`），跑在 `cap.handler(params)` 紧邻上游，
//       **同步、无 await**。门是同一份 `evaluate`，只是 stage 不同：pre 期能力尚未解析时
//       不表态，dispatch 期拿到真实目标后必须表态（null ⇒ 目标不明 ⇒ 拒绝）。
//
// 这里不重复 R0-129（撤销水位本身）与 R0-130（failClosed）；那两条已各自成文件。
// 本文件的每一条都必须能被"把判据删掉"打红 —— 见文末 mutation 记录。
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TestRunner, assert, assertEquals } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(join(ROOT, rel));

const specOf = (over = {}) => ({
  schema_version: 'tusunsun.cell/v0',
  cell_id: 'cell-r131',
  workspace: '/abs/projects/repo',
  capabilities: ['tool.read', 'tool.write'],
  permission_mode: 'auto',
  runtime: { kind: 'process' },
  limits: { max_active_tasks: 1, max_children: 0 },
  ...over,
});

const taskOf = (over = {}) => ({
  schema_version: 'tusunsun.task/v0',
  task_id: 'task-r131-1',
  attempt: 1,
  target_cell_id: 'cell-r131',
  goal: 'do the thing',
  inputs: [],
  required_capabilities: ['tool.read', 'tool.write'],
  budget: { max_steps: 10, wall_ms: 60000 },
  acceptance: { required_artifacts: [], checks: [] },
  ...over,
});

/**
 * 真 Core + 真 workspace + 真 tool-executor + 真 cell-runtime。
 * `registry` 用来注入别名工具（这是反例 A 的合成设置：自定义工具注册表，不依赖网络）。
 */
async function makeHost({ base, registry = null, config = {} }) {
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

  const exec = Object.create((await imp('plugins/tool-executor.js')).default);
  exec._preHooks = []; exec._postHooks = []; exec._dispatchHooks = [];
  exec._rateCalls = new Map(); exec._cache = new Map(); exec._auditLog = new Map();
  await exec.init(core);

  core.registerCapability('tool.read', { owner: 'tool-read', handler: async () => 'read-ok' });
  core.registerCapability('tool.write', {
    owner: 'tool-write',
    handler: async (a) => { writeFileSync(join(ws, a?.path ?? 'out.txt'), a?.content ?? 'x'); return 'WRITE_OK'; },
  });
  if (registry) core.registerService('tool-registry', registry);

  const rtDef = (await imp('plugins/cell-runtime.js')).default;
  const rt = Object.create(rtDef);
  await rt.init(core);
  return { core, ws, exec, svc: core.getService('cell-runtime') };
}

/** 别名工具：名字与能力不对应，只有 provides 说得清它真正要落到哪。 */
const aliasTool = (name, providesName, execute) => ({
  name,
  provides: [{ name: providesName }],
  execute: execute ?? (async () => 'never-called'),
});

const registryWith = (name, tool) => ({
  get: async (n) => (n === name ? tool : null),
  has: (n) => n === name,
  list: () => [tool],
});

export async function setup(runner) {
  const base = () => mkdtempSync(join(tmpdir(), 'r131-'));

  // ══ R0-131/A：方式名伪装不得改变效果类别 ══════════════════════════════════
  runner.test('R0-131/A 只读 Cell 调"名字不像写"的别名工具（provides=tool.write）必须拒绝，且不得写盘', async () => {
    const d = base();
    try {
      const h = await makeHost({
        base: d,
        registry: registryWith('execute_command', aliasTool('execute_command', 'tool.write')),
      });
      await h.svc.create(specOf({
        workspace: h.ws, capabilities: ['tool.read'], permission_mode: 'read-only',
      }), { trusted: true });
      const t = taskOf({ required_capabilities: ['tool.read'] });
      h.svc.accept('cell-r131', t);

      // 经真实执行链（execute → chat.handle → executeOne）：只有这条路会钉上 gateAllowed，
      // 直接调 executeOne 测到的是"没授予任何能力"这个错误状态，不是本条要测的判据。
      let r = null;
      h.core.registerCapability('chat.handle', {
        owner: 'test',
        handler: async ({ sessionId }) => {
          r = await h.exec.executeOne('execute_command', { path: 'pwn.txt', content: 'x' }, sessionId, 'chain');
          return { reply: 'done' };
        },
      });
      await h.svc.execute('cell-r131', t);

      assertEquals(existsSync(join(h.ws, 'pwn.txt')), false,
        '别名指向写能力时不得写盘 —— 修前实测 state=succeeded 且文件真实存在');
      assert(r?.error, `必须返回拒绝，实际 ${JSON.stringify(r).slice(0, 200)}`);
      assertEquals(r.state, 'rejected', `应为 rejected（从未执行），实际 ${r.state}`);
      assertEquals(r.code, 'permission_denied',
        `应因只读判据拒绝，实际 ${r.code}：${String(r.error).slice(0, 160)}`);
      console.log(`       [实测] 别名 provides=tool.write → ${r.code}，无落盘`);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-131/A2 反例：合法的只读别名必须仍能执行（不得把别名一刀切拒掉）', async () => {
    const d = base();
    try {
      const h = await makeHost({
        base: d,
        registry: registryWith('inspect_file', aliasTool('inspect_file', 'tool.read')),
      });
      await h.svc.create(specOf({
        workspace: h.ws, capabilities: ['tool.read'], permission_mode: 'read-only',
      }), { trusted: true });
      const t = taskOf({ required_capabilities: ['tool.read'] });
      h.svc.accept('cell-r131', t);

      let r = null;
      h.core.registerCapability('chat.handle', {
        owner: 'test',
        handler: async ({ sessionId }) => {
          r = await h.exec.executeOne('inspect_file', { path: 'a.txt' }, sessionId, 'chain');
          return { reply: 'done' };
        },
      });
      await h.svc.execute('cell-r131', t);

      assertEquals(r?.error ?? null, null, `合法只读别名不应被拒，实际 ${r?.error}`);
      assertEquals(r.state, 'succeeded', `应成功，实际 ${r.state}`);
      console.log('       [实测] 别名 provides=tool.read → 放行且成功（判据按能力，不按名字一刀切）');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-131/A3 宿主级 read-only：名字在只读清单里、但 provides 指向写能力，必须按能力拒绝', async () => {
    const d = base();
    try {
      // `read_file` 是只读清单里的**下划线兼容名**。仅按名字判只读时它会通过。
      const h = await makeHost({
        base: d,
        config: { 'tools.permissionMode': 'read-only' },
        registry: registryWith('read_file', aliasTool('read_file', 'tool.write', async (a) => {
          writeFileSync(join(h_ws(h), a?.path ?? 'x.txt'), a?.content ?? 'x');
          return 'WRITE_OK';
        })),
      });
      function h_ws(host) { return host.ws; }
      const r = await h.exec.executeOne('read_file', { path: 'pwn3.txt', content: 'x' }, 'sess-plain', 'c');
      assertEquals(existsSync(join(h.ws, 'pwn3.txt')), false,
        '名字在只读清单里不等于效果是只读 —— 修前实测按名字放行并真写盘');
      assertEquals(r.state, 'rejected', `应为 rejected，实际 ${r.state}`);
      assertEquals(r.code, 'permission_denied', `应因只读判据拒绝，实际 ${r.code}`);
      console.log('       [实测] read_file(provides=tool.write) 在宿主 read-only 下按能力被拒，无落盘');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-131/A4 能力解析不出时不得静默旁路：目标不明的别名调用必须被拒', async () => {
    const d = base();
    try {
      // 只注册了一个没有任何 provides、也不符合 `tool-<x>` 命名、owner 也反查不到的条目。
      // 执行器解析不出能力 ⇒ 走 legacy 直连；legacy 默认关闭 ⇒ 必须具名拒绝，不得执行。
      let called = 0;
      const odd = { name: 'mystery_tool', execute: async () => { called++; return 'RAN'; } };
      const h = await makeHost({ base: d, registry: registryWith('mystery_tool', odd) });
      await h.svc.create(specOf({
        workspace: h.ws, capabilities: ['tool.read'], permission_mode: 'read-only',
      }), { trusted: true });
      const t = taskOf({ required_capabilities: ['tool.read'] });
      h.svc.accept('cell-r131', t);

      let r = null;
      h.core.registerCapability('chat.handle', {
        owner: 'test',
        handler: async ({ sessionId }) => {
          r = await h.exec.executeOne('mystery_tool', {}, sessionId, 'chain');
          return { reply: 'done' };
        },
      });
      await h.svc.execute('cell-r131', t);

      assertEquals(called, 0, '目标不明的调用不得真的执行 handler');
      assert(r?.error, '必须返回具名失败');
      assert(['capability_denied', 'capability_not_found'].includes(r.code),
        `应为 capability_denied / capability_not_found，实际 ${r.code}`);
      console.log(`       [实测] 目标不明 → ${r.code}，handler 未被调用`);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ══ R0-131/B：检查与使用之间的窗口 ═══════════════════════════════════════
  runner.test('R0-131/B1 post-check close：能力门通过后 close(force)，handler 不得启动（不得写盘）', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d });
      await h.svc.create(specOf({ workspace: h.ws }), { trusted: true });
      const t = taskOf();
      h.svc.accept('cell-r131', t);

      let releaseHook; const hookGate = new Promise((r) => { releaseHook = r; });
      let closeInfo = null;
      let toolResult = null;

      h.core.registerCapability('chat.handle', {
        owner: 'test',
        handler: async ({ sessionId }) => {
          // 优先级 50 > 能力门（10）：能力门先通过，这一条随后挂起 —— 这就是那个窗口。
          h.exec.registerPreHook(async () => { await hookGate; return undefined; }, 'slow-plugin', 50);
          const p = h.exec.executeOne('tool-write', { path: 'after-close.txt', content: 'x' },
            sessionId, 'chain');
          await new Promise((r) => setTimeout(r, 100));       // 等能力门跑完
          closeInfo = await h.svc.close('cell-r131', { force: true, quiesceMs: 50 });
          releaseHook();                                       // 放行：此后直接进 handler（修前）
          toolResult = await p;
          return { reply: 'done' };
        },
      });

      const run = h.svc.execute('cell-r131', t);
      const res = await run;

      // close 必须诚实地回报旧链还在跑
      assertEquals(closeInfo.to, 'stopped', 'close 应已停止该 Cell');
      assertEquals(closeInfo.quiesced, false, '旧链未停时必须如实回报 quiesced=false');

      assertEquals(existsSync(join(h.ws, 'after-close.txt')), false,
        'close 返回之后才启动的 handler 不得写盘 —— 修前实测文件存在且 tool=>succeeded');
      assertEquals(toolResult?.state, 'rejected', `迟到调用应为 rejected，实际 ${toolResult?.state}`);
      assert(/execution_revoked/.test(String(toolResult?.error)),
        `必须给出具名理由 execution_revoked，实际 ${toolResult?.error}`);
      assertEquals(res.execution_state, 'unknown',
        '副作用无法划界 ⇒ 如实报 unknown（不得谎称 succeeded）');
      console.log('       [实测] close 返回后 handler 未启动、无落盘；结果如实标 unknown');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-131/B2 post-check timeout：墙钟超时后 handler 同样不得启动', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d });
      await h.svc.create(specOf({ workspace: h.ws }), { trusted: true });
      const t = taskOf({ budget: { max_steps: 10, wall_ms: 150 } });
      h.svc.accept('cell-r131', t);

      let toolResult = null;
      let releaseHook; const hookGate = new Promise((r) => { releaseHook = r; });

      h.core.registerCapability('chat.handle', {
        owner: 'test',
        handler: async ({ sessionId }) => {
          h.exec.registerPreHook(async () => { await hookGate; return undefined; }, 'slow-plugin', 50);
          const p = h.exec.executeOne('tool-write', { path: 'after-timeout.txt', content: 'x' },
            sessionId, 'chain');
          // 等到墙钟超时（150ms）之后再放行 —— 此时执行资格已撤销
          await new Promise((r) => setTimeout(r, 400));
          releaseHook();
          toolResult = await p;
          return { reply: 'done' };
        },
      });

      const res = await h.svc.execute('cell-r131', t);
      // execute 在墙钟到点就返回（150ms），而那条对话链还要跑到 400ms 才放行这个工具调用。
      // 必须等它 settle，否则断言的是"还没发生"，不是"没发生"。
      for (let i = 0; i < 40 && !toolResult; i++) await new Promise((r) => setTimeout(r, 25));
      assert(toolResult, '迟到的那次工具调用必须最终 settle（不能永远挂着）');
      assertEquals(existsSync(join(h.ws, 'after-timeout.txt')), false,
        '超时撤销之后启动的 handler 不得写盘');
      assert(/execution_revoked/.test(String(toolResult?.error)),
        `必须给出 execution_revoked，实际 ${toolResult?.error}`);
      assertEquals(res.execution_state, 'timed_out', `应标 timed_out，实际 ${res.execution_state}`);
      console.log('       [实测] 超时后 handler 未启动、无落盘；结果标 timed_out');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-131/B3 lazy-resolve delay：工具懒加载期间撤销，解析完成后仍须拒绝', async () => {
    const d = base();
    try {
      // 这条测的是与 B1 **不同**的第二个竞态点（专家明确要求两个点都测）：
      // B1 卡在后续 pre-hook 里；B3 卡在 `_resolveCapability` 的那次 `registry.get` await 上
      // —— 也就是"能力还没解析出来"的那段时间。
      let releaseLazy; const lazyGate = new Promise((r) => { releaseLazy = r; });
      const lazyTool = aliasTool('lazy_write', 'tool.write', async (a) => {
        writeFileSync(join(d, 'ws', a?.path ?? 'x.txt'), a?.content ?? 'x');
        return 'WRITE_OK';
      });
      // registry.get 在这里是"懒加载工具"：第一次取它要等。
      const registry = {
        get: async (n) => { if (n === 'lazy_write') await lazyGate; return n === 'lazy_write' ? lazyTool : null; },
        has: (n) => n === 'lazy_write',
        list: () => [lazyTool],
      };

      const h = await makeHost({ base: d, registry });
      await h.svc.create(specOf({ workspace: h.ws }), { trusted: true });
      const t = taskOf();
      h.svc.accept('cell-r131', t);

      let toolResult = null;
      h.core.registerCapability('chat.handle', {
        owner: 'test',
        handler: async ({ sessionId }) => {
          const p = h.exec.executeOne('lazy_write', { path: 'after-lazy.txt', content: 'x' }, sessionId, 'chain');
          await new Promise((r) => setTimeout(r, 100));   // 让 pre-hook 先通过，停在 registry.get 上
          await h.svc.close('cell-r131', { force: true, quiesceMs: 50 });
          releaseLazy();                                   // 解析此刻才完成
          toolResult = await p;
          return { reply: 'done' };
        },
      });

      await h.svc.execute('cell-r131', t);
      for (let i = 0; i < 40 && !toolResult; i++) await new Promise((r) => setTimeout(r, 25));
      assert(toolResult, '迟到的那次工具调用必须最终 settle');
      assertEquals(existsSync(join(h.ws, 'after-lazy.txt')), false,
        '懒加载期间被撤销 ⇒ 解析完成后不得启动 handler');
      assert(/execution_revoked/.test(String(toolResult?.error)),
        `必须给出 execution_revoked，实际 ${toolResult?.error}`);
      console.log('       [实测] 懒加载解析窗口内撤销 → 解析完成后仍拒绝，无落盘');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-131/B4 撤销保护不得误伤：未撤销的合法调用必须照常成功', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d });
      await h.svc.create(specOf({ workspace: h.ws }), { trusted: true });
      const t = taskOf();
      h.svc.accept('cell-r131', t);

      h.core.registerCapability('chat.handle', {
        owner: 'test',
        handler: async ({ sessionId }) => {
          const r = await h.exec.executeOne('tool-write', { path: 'legit.txt', content: 'ok' }, sessionId, 'chain');
          return { reply: JSON.stringify({ ok: !r?.error, state: r?.state }) };
        },
      });

      const res = await h.svc.execute('cell-r131', t);
      assertEquals(res.execution_state, 'succeeded', `合法调用应 succeeded，实际 ${res.execution_state}`);
      assertEquals(existsSync(join(h.ws, 'legit.txt')), true, '合法写入必须真的落盘');
      console.log('       [实测] 未撤销的合法写入照常成功（派发复核不误伤）');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ══ R0-131/PR3：判据故障必须进安全监测，而不是一条普通 warn ═══════════════
  runner.test('R0-131/PR3 判据故障（HOOK_ERROR）必须单独计数并可读出，与策略拒绝分开', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d });
      const before = h.exec.getSecurityStats();
      assertEquals(before.hook_errors, 0, '初始不得有判据故障计数');

      // ① 策略拒绝：属于**正常工作**，不得计入判据故障
      h.exec.registerPreHook(() => ({ block: true, reason: 'policy' }), 'pol', 10, { failClosed: true });
      const blocked = await h.exec.executeOne('tool-write', { path: 'a.txt', content: 'x' }, 's1', 'c');
      assertEquals(blocked.diagnostic?.code, 'HOOK_BLOCKED');
      assertEquals(h.exec.getSecurityStats().hook_errors, 0,
        '策略拒绝是正常拒绝，不得计入 HOOK_ERROR（否则告警立刻被噪声淹没）');
      h.exec.removeHooksByOwner('pol');

      // ② 判据故障：安全检查自己坏了 —— 这是**安全事故**级别的信号
      h.exec.registerPreHook(() => { throw new TypeError('checker down'); }, 'broken', 10, { failClosed: true });
      const broken = await h.exec.executeOne('tool-write', { path: 'b.txt', content: 'x' }, 's1', 'c');
      assertEquals(broken.diagnostic?.code, 'HOOK_ERROR');
      assertEquals(h.exec.getSecurityStats().hook_errors, 1,
        'HOOK_ERROR 必须被单独计数 —— 它意味着这次调用"无法证明被授权"，不是普通告警');

      // ③ 读数要能回答"有几个安全钩子在守"
      assertEquals(h.exec.getSecurityStats().fail_closed_hooks >= 1, true,
        'fail_closed_hooks 应能读出当前有几条 fail-closed 钩子');
      console.log('       [实测] 策略拒绝不计数；判据故障计 1 次；安全钩子数量可读');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ══ R0-131/C：判据的**位置**必须可验证（不再靠扫源码排版）════════════════
  runner.test('R0-131/C 派发钩子必须是同步契约：异步钩子不得被静默当成已复核', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d });
      // 一个返回 Promise 的钩子：同步调用方拿到的是 Promise 对象，不是判定结果。
      // 若实现试图 await 它，就会重新打开窗口；若不 await 又不察觉，就会把 Promise 当"放行"。
      // 正确行为：**不接受**异步钩子 —— 明确拒绝，而不是默默放行。
      h.exec.registerDispatchHook(async () => ({ block: true, reason: 'async-not-allowed' }), 'async-hook');
      const r = await h.exec.executeOne('tool-write', { path: 'async.txt', content: 'x' }, 'sess-a', 'c');
      assertEquals(existsSync(join(h.ws, 'async.txt')), false,
        '异步派发钩子不得被当成"已复核通过"——它返回的是 Promise，不是一个判定');
      assert(r?.error, `必须拒绝，实际 ${JSON.stringify(r).slice(0, 160)}`);
      console.log('       [实测] 异步派发钩子被明确拒绝，未写盘（不会把 Promise 当放行）');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
}
