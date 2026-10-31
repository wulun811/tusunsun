// R0-128：对 v0.9.19（G0–G3）那一轮做**代码审查**发现的真阳性回归锁。
//
// 为什么单独一个文件：v0.9.19 的用例把"设计意图"验得很细，但审查时发现的这十类问题全都
// 落在"用例覆盖不到的地方"—— 它们不是断言写错了，而是**没有任何一条断言去问那个问题**。
// 每一条都在修前**先实测复现**过（本文件就是那些复现脚本的固化形态）。
//
// 分类（按后果排序）：
//   P0-A 能力交集只在准入处生效，执行期零读者 —— Cell 只声明 tool.read 却能真的写出文件；
//   P0-B `cell.create` 丢掉 `trusted` —— 远端可经 Cell 绕过 workspaces.roots 白名单；
//   P0-C `CellSpec.permission_mode` 是死字段 —— read-only 的 Cell 照样写盘成功；
//   P0-D 并发 execute 覆盖 activeTask；close(force) 被执行流程改回 ready（关闭指令被推翻）；
//   P1-A 合同二次校验非幂等（null 预算被拒），runtime 自产 WorkResult 不合合同；
//   P1-B 步数预算按**进程级** agent.step 计数，串到别的会话并误标 timed_out；
//   P1-C create 在 declare 失败后留下半个 Cell（可 describe/accept）；
//   P1-D verify(id) 不带 task 时把 WorkResult 当 Task 校验，必然抛错；
//   P1-E close 解绑后 describe 报进程默认根（一个从未属于该 Cell 的目录）；
//   P1-F workspace.release 的 workspace_busy 是死代码（唯一 retain 调用点在 cell-runtime）。
//
// 形态：全部进程内直测（真 Core + 真 workspace + 真 tool-executor），不联网、不花 token。
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TestRunner, assert, assertEquals } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(join(ROOT, rel));

const codeOf = async (fn) => {
  try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, code: e.code, message: e.message }; }
};

const specOf = (over = {}) => ({
  schema_version: 'tusunsun.cell/v0',
  cell_id: 'cell-audit',
  workspace: '/abs/projects/repo',
  capabilities: ['tool.read', 'tool.write'],
  permission_mode: 'auto',
  runtime: { kind: 'process' },
  limits: { max_active_tasks: 1, max_children: 0 },
  ...over,
});

const taskOf = (over = {}) => ({
  schema_version: 'tusunsun.task/v0',
  task_id: 'task-audit-1',
  attempt: 1,
  target_cell_id: 'cell-audit',
  goal: 'do the thing',
  inputs: [],
  required_capabilities: ['tool.read'],
  budget: { max_steps: 10, wall_ms: 60000 },
  acceptance: { required_artifacts: [], checks: [] },
  ...over,
});

/**
 * 造一个**真正接上执行链**的宿主：真 Core + workspace + 真 tool-executor。
 * chat.handle 会真的经 executeOne 调用被授予/未授予的工具 —— 这是 P0-A/P0-C 的必要条件，
 * 只注册一个假 handler 是问不出"模型能不能越权"的。
 */
async function makeHost({ base, id = 'A', mode = 'auto', toolCalls = [], onChat = null }) {
  const { Core } = await imp('src/core/core.js');
  const ws = join(base, `ws-${id}`);
  mkdirSync(ws, { recursive: true });
  const core = new Core({ stateDir: join(base, `state-${id}`) });
  core.log = () => {};
  core.setData('agent.workDir', ws);
  await (await imp('plugins/workspace.js')).default.init(core);

  const execMod = await imp('plugins/tool-executor.js');
  const exec = Object.create(execMod.default);
  exec._preHooks = []; exec._postHooks = [];
  exec._rateCalls = new Map(); exec._cache = new Map(); exec._auditLog = new Map();
  await exec.init(core);

  core.registerCapability('tool.read', { owner: 'tool-read', handler: async () => 'read-ok' });
  core.registerCapability('tool.write', {
    owner: 'tool-write',
    handler: async (a) => { writeFileSync(join(ws, a.path), a.content ?? 'x'); return 'WROTE'; },
  });
  core.registerCapability('chat.handle', {
    owner: 'test',
    handler: async ({ sessionId, message }) => {
      const outs = [];
      for (const name of toolCalls) {
        const r = await exec.executeOne(name, { path: 'out.txt', content: 'x', _tcId: `tc-${name}` }, sessionId, 'chain');
        outs.push({ name, status: r.status || r.state || 'ok', error: r.error || null });
      }
      if (onChat) await onChat({ sessionId, message, core });
      return { reply: JSON.stringify(outs) };
    },
  });

  const rtDef = (await imp('plugins/cell-runtime.js')).default;
  const rt = Object.create(rtDef);
  await rt.init(core);
  return { core, ws, exec, svc: core.getService('cell-runtime'), mode };
}

export async function setup(runner) {
  const base = () => mkdtempSync(join(tmpdir(), 'r128-audit-'));

  // ══ P0-A：能力交集必须在执行期生效 ══════════════════════════════════
  runner.test('R0-128/P0-A 生效能力在执行期生效：Cell 没声明的工具，模型调用必须被拒（且授权的不受影响）', async () => {
    const d = base();
    try {
      // 反例：Cell 只授予 tool.read，模型却去调 tool.write
      const h1 = await makeHost({ base: d, id: 'A', toolCalls: ['tool-write'] });
      await h1.svc.create(specOf({ workspace: h1.ws, capabilities: ['tool.read'] }), { trusted: true });
      const t1 = taskOf({ required_capabilities: ['tool.read'] });
      h1.svc.accept('cell-audit', t1);
      const r1 = await h1.svc.execute('cell-audit', t1);
      assertEquals(existsSync(join(h1.ws, 'out.txt')), false,
        '未授予的 tool.write 必须真的没能写盘 —— 修前它写出了文件且 execution_state=succeeded');
      assert(/capability_denied/.test(r1._reply || ''), `模型必须收到具名拒绝，实际回复 ${r1._reply}`);

      // 正例：授予了就必须能用（否则只是"一律拒绝"）
      const h2 = await makeHost({ base: d, id: 'B', toolCalls: ['tool-write'] });
      await h2.svc.create(specOf({ cell_id: 'cell-audit', workspace: h2.ws, capabilities: ['tool.read', 'tool.write'] }), { trusted: true });
      const t2 = taskOf({ required_capabilities: ['tool.write'], acceptance: { required_artifacts: ['out.txt'], checks: [] } });
      h2.svc.accept('cell-audit', t2);
      const r2 = await h2.svc.execute('cell-audit', t2);
      assertEquals(r2.execution_state, 'succeeded', `已授予的工具必须能正常执行，实际 ${r2.execution_state}`);
      assertEquals(existsSync(join(h2.ws, 'out.txt')), true, '已授予的写入必须真的落盘');
      console.log('       [实测] 未授予 → capability_denied 且无产物；已授予 → 正常写盘（没有过度拒绝）');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ══ P0-B：cell.create 必须把 trusted 传下去 ══════════════════════════
  runner.test('R0-128/P0-B cell.create 不得绕过 workspaces.roots：远端调用方与直接 declare 同样被拒', async () => {
    const d = base();
    try {
      const allowed = join(d, 'allowed'); const secret = join(d, 'secret');
      mkdirSync(allowed); mkdirSync(secret);
      const { Core } = await imp('src/core/core.js');
      const core = new Core({ stateDir: join(d, 'state') });
      core.log = () => {};
      core.setData('agent.workDir', allowed);
      // 默认策略 local + 白名单：**远端**调用方只能落在 roots 里
      core.get = (k, dflt) => (k === 'workspaces' ? { policy: 'local', roots: [allowed] } : dflt);
      await (await imp('plugins/workspace.js')).default.init(core);
      const rt = Object.create((await imp('plugins/cell-runtime.js')).default);
      await rt.init(core);
      const svc = core.getService('cell-runtime');

      // 基线：远端直接 declare 会被拒（这是既有且正确的行为）
      const direct = await codeOf(() => core.getService('workspace').declare('remote-1', secret, { trusted: false, via: 'http' }));
      assertEquals(direct.ok, false, '远端直接声明白名单外目录必须被拒');
      assertEquals(direct.code, 'workspace_not_allowed');

      // 反例：远端经 cell.create 指同一目录 —— 修前这里**成功**（trusted 被硬编码为 true）
      const viaCell = await codeOf(() => svc.create(specOf({ cell_id: 'cell-remote', workspace: secret }), { trusted: false }));
      assertEquals(viaCell.ok, false,
        '远端经 cell.create 也必须被拒 —— 修前它把 trusted 硬编码成 true，白名单对整个 Cell 面形同虚设');
      assertEquals(viaCell.code, 'workspace_not_allowed');
      assertEquals(svc.list().length, 0, '被拒的 create 不得留下任何 Cell 记录');

      // 正例：本机（trusted:true）落在白名单内必须能建
      const okCell = await codeOf(() => svc.create(specOf({ cell_id: 'cell-local', workspace: allowed }), { trusted: true }));
      assertEquals(okCell.ok, true, `本机在白名单内必须能创建，实际 ${okCell.code || ''}`);
      console.log('       [实测] 远端 declare/cell.create 均 workspace_not_allowed；本机白名单内正常创建');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ══ P0-C：permission_mode 必须被真正执行 ════════════════════════════
  runner.test('R0-128/P0-C permission_mode 不是装饰：read-only 的 Cell 即使被授予写工具也不许写', async () => {
    const d = base();
    try {
      // read-only 且**授予了** tool.write：能力交集允许，但权限模式必须先挡住
      const h = await makeHost({ base: d, id: 'A', toolCalls: ['tool-write'] });
      const st = await h.svc.create(specOf({
        workspace: h.ws, capabilities: ['tool.read', 'tool.write'], permission_mode: 'read-only',
      }), { trusted: true });
      assertEquals(st.fence.mode, 'read-only', '状态里要如实报出模式');
      const t = taskOf({ required_capabilities: ['tool.write'], acceptance: { required_artifacts: [], checks: [] } });
      h.svc.accept('cell-audit', t);
      const r = await h.svc.execute('cell-audit', t);
      assertEquals(existsSync(join(h.ws, 'out.txt')), false,
        'read-only 的 Cell 不得写盘 —— 修前 permission_mode 零读者，写成功且 execution_state=succeeded');
      assert(/permission_denied/.test(r._reply || ''), `必须是具名 permission_denied，实际 ${r._reply}`);

      // 正例：auto 模式下同一个 Cell 规格可以写（证明拦的是模式，不是工具）
      const h2 = await makeHost({ base: d, id: 'B', toolCalls: ['tool-write'] });
      await h2.svc.create(specOf({ workspace: h2.ws, capabilities: ['tool.read', 'tool.write'], permission_mode: 'auto' }), { trusted: true });
      const t2 = taskOf({ required_capabilities: ['tool.write'], acceptance: { required_artifacts: ['out.txt'], checks: [] } });
      h2.svc.accept('cell-audit', t2);
      await h2.svc.execute('cell-audit', t2);
      assertEquals(existsSync(join(h2.ws, 'out.txt')), true, 'auto 模式必须能写（否则变成一律禁止）');
      console.log('       [实测] read-only → permission_denied 且无产物；auto → 正常写入');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ══ P0-D-a：并发 execute 不得覆盖 activeTask ═════════════════════════
  runner.test('R0-128/P0-D 并发 execute 必须拒绝第二个（max_active_tasks=1 不是文档措辞）', async () => {
    const d = base();
    try {
      let concurrent = 0; let peak = 0;
      const h = await makeHost({
        base: d, id: 'A', toolCalls: [],
        onChat: async () => {
          concurrent++; peak = Math.max(peak, concurrent);
          await new Promise((r) => setTimeout(r, 250));
          concurrent--;
        },
      });
      await h.svc.create(specOf({ workspace: h.ws }), { trusted: true });
      const t1 = taskOf({ task_id: 'task-one' });
      h.svc.accept('cell-audit', t1);
      const first = h.svc.execute('cell-audit', t1);
      // 让第一个真的进入 busy（占位发生在第一个 await 之前，这里给一个 tick 更贴近真实竞态）
      await new Promise((r) => setTimeout(r, 60));
      const second = await codeOf(() => h.svc.execute('cell-audit', taskOf({ task_id: 'task-two' })));
      assertEquals(second.ok, false, '第二个并发 execute 必须被拒 —— 修前它会让同一个 Cell 真的并发跑两个任务');
      assertEquals(second.code, 'cell_not_ready');
      const r1 = await first;
      assertEquals(r1.execution_state, 'succeeded');
      assertEquals(peak, 1, `峰值并发必须是 1，实际 ${peak}`);
      console.log(`       [实测] 第二个 execute → cell_not_ready；峰值并发 ${peak}`);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ══ P0-D-b：close 不得被正在执行的流程推翻 ═══════════════════════════
  runner.test('R0-128/P0-D close(force) 之后执行结束不得把 Cell 改回 ready（关闭指令不能被推翻）', async () => {
    const d = base();
    try {
      const h = await makeHost({
        base: d, id: 'A', toolCalls: [],
        onChat: async () => { await new Promise((r) => setTimeout(r, 300)); },
      });
      await h.svc.create(specOf({ workspace: h.ws }), { trusted: true });
      const t = taskOf();
      h.svc.accept('cell-audit', t);
      const running = h.svc.execute('cell-audit', t);
      await new Promise((r) => setTimeout(r, 80));
      const closed = await h.svc.close('cell-audit', { force: true });
      assertEquals(closed.to, 'stopped');
      assertEquals(h.svc.describe('cell-audit').state, 'stopped');
      await running;
      assertEquals(h.svc.describe('cell-audit').state, 'stopped',
        '执行结束后必须仍是 stopped —— 修前这里被无条件写回 ready，已关闭的 Cell 又能接活');

      let accepted = null;
      try { h.svc.accept('cell-audit', taskOf({ task_id: 'task-after-close' })); } catch (e) { accepted = e; }
      assertEquals(accepted?.code, 'cell_not_ready', '关闭后必须拒绝新任务');
      console.log('       [实测] close(force) → stopped 保持到执行结束；后续 accept → cell_not_ready');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ══ P1-A：合同必须能校验自己产出的东西 ══════════════════════════════
  runner.test('R0-128/P1-A 合同二次校验幂等：归一化结果再次通过，runtime 自产 WorkResult 合合同', async () => {
    const C = await imp('plugins/_lib/cell/contract.js');
    const rawTask = taskOf({ budget: {} });
    const once = C.validateTaskEnvelope(rawTask);
    assertEquals(once.budget.max_steps, null, '没设上限归一化为 null');
    const twice = C.validateTaskEnvelope(once);   // 修前：budget.max_steps must be an integer
    assertEquals(twice.budget.max_steps, null, '归一化结果必须能再次通过校验（落盘→回读→校验是合同的基本用途）');

    // CellSpec 同理（limits.max_steps=null）
    const spec = specOf({ workspace: '/tmp' });
    const s1 = C.validateCellSpec(spec, { maxChildrenCap: 0 });
    const s2 = C.validateCellSpec(s1, { maxChildrenCap: 0 });
    assertEquals(s2.limits.max_steps, null);

    // runtime 自己产出的 result 必须合自己的合同（model_calls:null = "没测"）
    const d = base();
    try {
      const h = await makeHost({ base: d, id: 'A', toolCalls: [] });
      await h.svc.create(specOf({ workspace: h.ws }), { trusted: true });
      const t = taskOf();
      h.svc.accept('cell-audit', t);
      const r = await h.svc.execute('cell-audit', t);
      assertEquals(r.usage.model_calls, null, '数不出来的项必须写 null，不写假 0');
      const v = await codeOf(() => C.validateWorkResult({ ...r, _reply: undefined }));
      assertEquals(v.ok, true, `runtime 自产 WorkResult 必须通过合同校验，实际 ${v.code}：${v.message || ''}`);
      console.log('       [实测] Task/CellSpec 二次校验通过；usage.model_calls=null 的 WorkResult 通过校验');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ══ P1-B：预算必须按会话计，且步数用尽不等于超时 ═════════════════════
  runner.test('R0-128/P1-B 步数预算只数本 Cell 的步、且步数用尽标 failed 而不是 timed_out', async () => {
    const d = base();
    try {
      // 本 Cell 走 1 步，同时别的会话走 5 步（网关上的普通对话就在做这件事）
      const h = await makeHost({
        base: d, id: 'A', toolCalls: [],
        onChat: async ({ core, sessionId }) => {
          core.emitFast('agent.step', { sessionId, turn: 1 });
          for (let i = 0; i < 5; i++) core.emitFast('agent.step', { sessionId: 'other-session', turn: i });
        },
      });
      await h.svc.create(specOf({ workspace: h.ws }), { trusted: true });
      // 预算 3 步：别的会话的 5 步若被算进来就会失败
      const t = taskOf({ budget: { max_steps: 3, wall_ms: 600000 } });
      h.svc.accept('cell-audit', t);
      const r = await h.svc.execute('cell-audit', t);
      assertEquals(r.execution_state, 'succeeded',
        `别的会话的步数不得吃掉本 Cell 的预算（实际 ${r.execution_state}：${r.error || ''}）`);
      assertEquals(r.usage.steps, 1, `只应记本 Cell 的 1 步，实际 ${r.usage.steps}`);

      // 反例：本 Cell 真的超步数 ⇒ failed（不是 timed_out，墙钟一分钟都没到）
      const h2 = await makeHost({
        base: d, id: 'B', toolCalls: [],
        onChat: async ({ core, sessionId }) => {
          for (let i = 0; i < 5; i++) core.emitFast('agent.step', { sessionId, turn: i });
        },
      });
      await h2.svc.create(specOf({ workspace: h2.ws }), { trusted: true });
      const t2 = taskOf({ budget: { max_steps: 2, wall_ms: 600000 } });
      h2.svc.accept('cell-audit', t2);
      const r2 = await h2.svc.execute('cell-audit', t2);
      assertEquals(r2.execution_state, 'failed',
        `步数用尽必须标 failed（修前标成 timed_out，实测墙钟只用了 3ms 而预算是 600000ms），实际 ${r2.execution_state}`);
      assert(/budget_exhausted/.test(r2.error || ''), `必须点名预算用尽，实际 ${r2.error}`);
      console.log('       [实测] 跨会话步数不再串（steps=1/succeeded）；本 Cell 超步数 → failed + budget_exhausted');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ══ P1-C：失败的 create 不留半个 Cell ═══════════════════════════════
  runner.test('R0-128/P1-C create 被策略拒绝时不留残骸：不可 describe / accept / list', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d, id: 'A' });
      // 必须是这个宿主自己的状态目录：`_assertAllowed` 拒的就是"工作区落在 stateDir 里"
      // （那里有会话、绑定表与凭据）。用一个随便建的目录是问不出这件事的。
      const state = h.core.stateDir; mkdirSync(state, { recursive: true });
      const r = await codeOf(() => h.svc.create(specOf({ cell_id: 'cell-evil', workspace: state }), { trusted: true }));
      assertEquals(r.ok, false);
      assertEquals(r.code, 'workspace_denied');
      assertEquals(h.svc.list().length, 0,
        '被拒的 create 不得留下记录 —— 修前 list() 里有一个 state:"ready" 的 Cell，还能 describe/accept');
      const desc = await codeOf(() => h.svc.describe('cell-evil'));
      assertEquals(desc.code, 'unknown_cell');
      const acc = await codeOf(() => h.svc.accept('cell-evil', taskOf({ target_cell_id: 'cell-evil' })));
      assertEquals(acc.code, 'unknown_cell');
      console.log('       [实测] declare 被拒 → 无残留记录，describe/accept 均 unknown_cell');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ══ P1-D：verify 的默认参数必须可用 ═════════════════════════════════
  runner.test('R0-128/P1-D verify(id) 不带 task 时用上一次接下的任务，不再把 WorkResult 当 Task 校验', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d, id: 'A', toolCalls: ['tool-write'] });
      await h.svc.create(specOf({ workspace: h.ws }), { trusted: true });
      // 需要产物就必须要求写能力：否则被能力门拦下、没有产物 —— 那是**正确**的拒绝，
      // 用它来测 verify 的默认参数只会测到"拒绝"这一半。
      const t = taskOf({ required_capabilities: ['tool.write'], acceptance: { required_artifacts: ['out.txt'], checks: [] } });
      h.svc.accept('cell-audit', t);
      await h.svc.execute('cell-audit', t);
      const dec = await codeOf(() => h.svc.verify('cell-audit'));
      assertEquals(dec.ok, true,
        `verify(id) 必须可用（修前把 lastResult 当成 Task 校验，必然抛 unsupported_schema_version），实际 ${dec.code}`);
      assertEquals(dec.value.decision, 'accepted');
      assertEquals(dec.value.task_id, 'task-audit-1', '必须知道验的是哪个任务');
      console.log('       [实测] verify(id) 无参可调用，decision=accepted，task_id 正确');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ══ P1-E：close 之后状态不得报默认根 ═════════════════════════════════
  runner.test('R0-128/P1-E close 解绑后 describe 仍报该 Cell 自己的工作区，不回落到进程默认根', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d, id: 'A', toolCalls: [] });
      const defaultRoot = join(d, 'default-root'); mkdirSync(defaultRoot);
      h.core.setData('agent.workDir', defaultRoot);   // 换一个与 Cell 无关的默认根
      const st = await h.svc.create(specOf({ workspace: h.ws }), { trusted: true });
      assertEquals(st.workspace_realpath, h.ws);
      await h.svc.close('cell-audit');
      const after = h.svc.describe('cell-audit');
      assertEquals(after.workspace_realpath, h.ws,
        `关闭后仍要报这个 Cell 当初的工作区，修前报了进程默认根 ${defaultRoot}`);
      // 重启后同样要报真值，而不是默认根
      const rt2 = Object.create((await imp('plugins/cell-runtime.js')).default);
      await rt2.init(h.core);
      const st2 = await h.core.getService('cell-runtime').create(specOf({ workspace: h.ws }), { trusted: true });
      assertEquals(st2.workspace_realpath, h.ws, '重启（重新 create）后同样不得报默认根');
      console.log('       [实测] close 后 workspace_realpath 仍是 Cell 自己的目录；重启后同样');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ══ P1-F：release 的在跑保护必须真的被普通对话用上 ═══════════════════
  runner.test('R0-128/P1-F 普通对话进行中 release 必须 workspace_busy（网关已接 retain）', async () => {
    const d = base();
    try {
      const A = join(d, 'A'); const B = join(d, 'B'); mkdirSync(A); mkdirSync(B);
      const { Core } = await imp('src/core/core.js');
      const core = new Core({ stateDir: join(d, 'state') });
      core.log = () => {};
      core.setData('agent.workDir', A);
      await (await imp('plugins/workspace.js')).default.init(core);
      const ws = core.getService('workspace');
      await ws.declare('s1', B, { trusted: true });

      const gw = Object.create((await imp('plugins/gateway.js')).default);
      gw.core = core;
      // 这是网关每次处理对话时做的事（/v1/chat/completions 与 WS agent.chat 都接了）
      const done = gw._retainWorkspace('s1');
      const busy = await codeOf(() => ws.release('s1'));
      assertEquals(busy.ok, false,
        '对话进行中 release 必须被拒 —— 修前 retain 的唯一调用点在 cell-runtime，普通对话完全没保护');
      assertEquals(busy.code, 'workspace_busy');
      assertEquals(ws.root('s1'), B, '被拒后绑定必须原样还在');
      done(); done();
      const ok = await codeOf(() => ws.release('s1'));
      assertEquals(ok.ok, true, '对话结束后必须能正常 release');
      assertEquals(ok.value.released, true);
      console.log('       [实测] 对话中 → workspace_busy 且绑定未动；结束后 → released');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
}
