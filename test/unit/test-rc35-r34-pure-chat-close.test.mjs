// rc.35 —— 专家 rc.34 发布裁决（LIMITED NO-GO）唯一新缺陷 R34-A 的判据与整机矩阵。
//
// R34-A：执行器**从未装配**时（不装 ToolExecutor 的纯对话 Cell 是一条公开支持的路径），
// `close()` 的清理责任表里 `gate` 一项永远为假 —— 旧判据是「`dropGate` 是不是函数」，
// 而这条 Cell 从头到尾没有门可拆。于是 `closed` 永远 false、`cell.closed` 永远不发；
// `owner.lock` 明明已经删掉，回执里却还挂着「拆门未完成」。
//
// 判据换成「执行器那边还数不数得到本 Cell 的门/回执/租约」。专家给的最少 6 项验收矩阵
// 在这里逐项固定，每一格都同时钉住**绿**与**不许糊**的那一侧：
//   1 纯对话无执行器  → 必须真关完，且只发一次 cell.closed；
//   2 有执行器正常清理 → 关闭后钩子/租约必须**确证**为空（不是「调过 dropGate 就算」）；
//   3 半装配 / 迟到但装不上门 → 不得留下无主钩子，关闭必须仍可完成；
//   4 门真的存在 → 关闭后旧 Cell 不得再执行；
//   5 在飞强制关闭 → 仍是 closed:false/closing:true，门与锁都留着；
//   6 磁盘 EIO → 不得用伪 closed:true 消解未完成的责任。
//
// 边界（诚实）：全部进程内直测（真 Core / 真 workspace / 真 cell-runtime / 真写盘）。
// 「执行器缺席」是**不装配**模拟的，不是另一个进程；不声称 OS 级隔离，也不声称模型
// 能自己安排关闭时机。
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assert, assertEquals } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(join(ROOT, rel));

const tmp = (tag) => mkdtempSync(join(tmpdir(), `rc35-${tag}-`));
const lockDir = (base) => join(base, 'state', 'cells', 'owner.lock');
const OWNER = 'cell:c1';

const specOf = (workspace, over = {}) => ({
  schema_version: 'tusunsun.cell/v0',
  cell_id: 'c1',
  workspace,
  capabilities: ['tool.read'],
  permission_mode: 'auto',
  runtime: { kind: 'process' },
  limits: { max_active_tasks: 1, max_children: 0 },
  ...over,
});

const taskOf = (id, { required = [] } = {}) => ({
  schema_version: 'tusunsun.task/v0',
  task_id: id,
  attempt: 1,
  target_cell_id: 'c1',
  goal: `goal ${id}`,
  inputs: [],
  required_capabilities: required,
  budget: { max_steps: 3, wall_ms: 10000 },
  acceptance: { required_artifacts: [], checks: [] },
});

/**
 * 真装配：Core + workspace +（可选）tool-executor + cell-runtime。
 *
 * `executor: 'none'` 就是专家那条反例的形态 —— 这条 Core 上没有任何工具派发路径，
 * 因此 Cell 创建时门装不上、也不该去装（`_gateEligibility().absent`）。
 */
async function host(base, { executor = 'ok', chat } = {}) {
  const { Core } = await imp('src/core/core.js');
  const wsDir = join(base, 'ws');
  mkdirSync(wsDir, { recursive: true });
  const core = new Core({ stateDir: join(base, 'state') });
  core.log = () => {};
  core.setData('agent.workDir', wsDir);
  await (await imp('plugins/workspace.js')).default.init(core);
  core.registerCapability('chat.handle', { owner: 'test', handler: chat || (async () => ({ reply: 'ok' })) });
  core.registerCapability('tool.read', { owner: 'test', handler: async () => ({ ok: true }) });
  const Cls = (await imp('plugins/tool-executor.js')).default.constructor;
  /** 半个执行器：pre 钩子能进表，dispatch 钩子一装就抛 —— 用来造「半装配」。 */
  const Broken = class extends Cls {
    registerDispatchHook() { throw Object.assign(new Error('dispatch hook refused'), { code: 'boom' }); }
  };
  const mk = async (kind) => {
    const exec = kind === 'broken' ? new Broken() : new Cls();
    if (kind === 'broken') core.registerService('tool-executor', exec);
    else await exec.init(core);
    return exec;
  };
  let exec = null;
  if (executor === 'ok' || executor === 'broken') exec = await mk(executor);
  const rt = (await imp('plugins/cell-runtime.js')).default;
  await rt.init(core);
  const events = { closed: 0, closing: 0, closingPayloads: [] };
  core.on('cell.closed', () => { events.closed++; });
  core.on('cell.closing', (x) => { events.closing++; events.closingPayloads.push(x); });
  const svc = core.getService('cell-runtime');
  return {
    core, rt, wsDir, events, svc,
    exec,
    create: (over = {}) => svc.create(specOf(wsDir, over), { trusted: true }),
    hooks: (owner = OWNER) => (exec ? exec.hookCountFor(owner) : null),
    /** 迟到的执行器：注册服务 + 投一条已提交事实（cell-runtime 订阅的就是它）。 */
    late: async (kind) => {
      exec = await mk(kind);
      core.emit('core:plugin.loaded', { pluginName: 'tool-executor' });
      return exec;
    },
  };
}

export default async function (runner) {
  // ═══════════════════════════════════════════════════════════════════
  // 1. 纯对话 Cell（无执行器）—— 专家主反例，rc.34 上永远关不完
  // ═══════════════════════════════════════════════════════════════════

  runner.test('R34-A/1 无执行器的纯对话 Cell：close 必须真的完成，且只发一次 cell.closed', async () => {
    const base = tmp('a1');
    try {
      const h = await host(base, { executor: 'none' });
      assert(!h.core.getService('tool-executor'), '前提：这条 Core 上没有工具执行器');
      const created = await h.create({ capabilities: [] });
      assertEquals(created.state, 'ready', '纯对话 Cell 不因执行器缺席而创建失败（公开支持的路径）');
      assertEquals(h.svc.describe('c1').capability_gate.executor_present, false, '前提：没有执行器，也就没有门');
      const accepted = h.svc.accept('c1', taskOf('chat-A'));
      assertEquals(accepted.accepted, true, '一条无工具对话任务必须能接受');
      const ran = await h.svc.execute('c1');
      assertEquals(ran.task_id, 'chat-A', '任务必须真的执行完');
      const once = await h.svc.close('c1');
      assertEquals(once.execution_revoked, true, '执行资格必须撤销（这一半 rc.34 已经做对）');
      assertEquals(once.cleanup_done, true,
        `清理必须做完，实际 pending=${JSON.stringify(once.cleanup_pending)}`);
      assertEquals(once.closed, true, 'closed 与 cleanup_done 同源：不许「撤销了就算关了」');
      assert(Array.isArray(once.cleanup_pending) && once.cleanup_pending.length === 0,
        `清理完成时 pending 必须是空数组，实际 ${JSON.stringify(once.cleanup_pending)}`);
      assertEquals(h.events.closed, 1, 'cell.closed 必须发，且只发一次');
      assertEquals(existsSync(lockDir(base)), false, '属主锁必须真的没了（回执与磁盘一致）');
      const twice = await h.svc.close('c1');
      assertEquals(twice.closed, true, '第二次 close 也必须说「已关闭」');
      assertEquals(twice.already, true, '第二次是 already，不是又一次清理');
      assertEquals(h.events.closed, 1, '重复 close 不得重复发 cell.closed');
      assertEquals(existsSync(lockDir(base)), false, '重复 close 之后锁仍不存在');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  // ═══════════════════════════════════════════════════════════════════
  // 2. 有执行器的正常清理 —— 关闭后必须**确证**钩子与租约都为空
  // ═══════════════════════════════════════════════════════════════════

  runner.test('R34-A/2 有执行器：门真的在，关闭后钩子与租约确证为零', async () => {
    const base = tmp('a2');
    try {
      const h = await host(base, { executor: 'ok' });
      await h.create();
      const before = h.svc.describe('c1').capability_gate;
      assertEquals(before.installed, true, '前提：门在创建时装上');
      assertEquals(before.live, true, '前提：回执此刻可核');
      assertEquals(before.pre >= 1 && before.dispatch >= 1, true,
        `前提：pre/dispatch 钩子各至少一条，实际 pre=${before.pre} dispatch=${before.dispatch}`);
      assertEquals(before.lease_live, true, '前提：保护租约就在');
      h.svc.accept('c1', taskOf('A', { required: ['tool.read'] }));
      await h.svc.execute('c1');
      const closed = await h.svc.close('c1');
      assertEquals(closed.closed, true, `必须真的关完，实际 ${JSON.stringify(closed.cleanup_pending)}`);
      assertEquals(closed.cleanup_done, true, 'cleanup_done 必须是 true');
      const after = h.svc.describe('c1').capability_gate;
      assertEquals(after.installed, false, '关闭后 gate 不得仍自称装好');
      assertEquals(after.pre + after.dispatch + after.post, 0,
        `关闭后执行器那边一条钩子都不能剩，实际 pre=${after.pre} dispatch=${after.dispatch}`);
      assertEquals(after.lease_live, false, '关闭后租约必须真的撤销（不是「调过 dropGate 就算」）');
      assertEquals(existsSync(lockDir(base)), false, '属主锁必须释放');
      let denied = null;
      try { await h.svc.execute('c1'); } catch (e) { denied = e; }
      assert(denied, '已关闭的 Cell 不得再执行任务');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  // ═══════════════════════════════════════════════════════════════════
  // 3. 半装配 / 迟到但装不上门 —— 不许留下无主钩子
  // ═══════════════════════════════════════════════════════════════════

  runner.test('R34-A/3 装门失败（dispatch 钩子被拒）：不得留下无主钩子，也不得留下半个 Cell', async () => {
    const base = tmp('a3');
    try {
      const h = await host(base, { executor: 'broken' });
      let err = null;
      try { await h.create(); } catch (e) { err = e; }
      assertEquals(err?.code, 'cell_gate_unavailable',
        `装不上门的 create 必须具名失败，实际 ${err?.code ?? 'NO_THROW'}`);
      const c = h.hooks();
      assertEquals(c.pre + c.dispatch + c.post, 0,
        `半装配必须当场回滚，实际残留 pre=${c.pre} dispatch=${c.dispatch}；`
        + '留下无主钩子会让合法关闭永远数得到残留');
      assertEquals(h.svc.list().length, 0, '失败的 create 不得在登记表里留下 Cell');
      assertEquals(existsSync(lockDir(base)), false, '失败的 create 必须把属主锁还回去');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('R34-A/3b 迟到但装不上门：close 仍必须能完成（空集语义，不是「永远欠着」）', async () => {
    const base = tmp('a3b');
    try {
      const h = await host(base, { executor: 'none' });
      await h.create({ capabilities: [] });
      h.svc.accept('c1', taskOf('chat-A'));
      await h.svc.execute('c1');
      await h.late('broken');                       // 执行器来了，但门装不上（只记日志）
      const g = h.svc.describe('c1').capability_gate;
      assertEquals(g.executor_present, true, '前提：执行器已经在');
      assertEquals(g.installed, false, '前提：门没装上（补门失败）');
      const c = h.hooks();
      assertEquals(c.pre + c.dispatch + c.post, 0, '补门失败也不得留下半条钩子');
      const closed = await h.svc.close('c1');
      assertEquals(closed.closed, true,
        `没有门可拆 ≠ 清理未完成：必须能关完，实际 pending=${JSON.stringify(closed.cleanup_pending)}`);
      assertEquals(h.events.closed, 1, 'cell.closed 必须发一次');
      assertEquals(existsSync(lockDir(base)), false, '属主锁必须释放');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  // ═══════════════════════════════════════════════════════════════════
  // 4. 已关闭的 Cell 不得被「迟到补门」重新挂上门/租约
  // ═══════════════════════════════════════════════════════════════════

  runner.test('R34-A/4 关完之后执行器才来：不得把门/租约装回已关闭的 Cell（否则 already 是假话）', async () => {
    const base = tmp('a4');
    try {
      const h = await host(base, { executor: 'none' });
      await h.create({ capabilities: [] });
      h.svc.accept('c1', taskOf('chat-A'));
      await h.svc.execute('c1');
      const closed = await h.svc.close('c1');
      assertEquals(closed.closed, true, '前提：已经真的关完');
      await h.late('ok');                           // 执行器迟到 → 会给现存 Cell 补门
      const g = h.svc.describe('c1').capability_gate;
      assertEquals(g.installed, false, '已完成的关闭不再要门：不许把门装回去');
      assertEquals(g.pre + g.dispatch, 0, `也不许留下钩子，实际 pre=${g.pre} dispatch=${g.dispatch}`);
      assertEquals(g.lease_live, false, '也不许把保护租约挂回去（那会让 already:true 变成假话）');
      const again = await h.svc.close('c1');
      assertEquals(again.already, true, '已关完仍是 already');
      assertEquals(again.cleanup_done, true, '清理状态不得被迟到装配改坏');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  // ═══════════════════════════════════════════════════════════════════
  // 5. 在飞强制关闭 —— 门与锁都必须留着，重试才允许真闭合
  // ═══════════════════════════════════════════════════════════════════

  runner.test('R34-A/5 在飞强制关闭：门与锁留着且不许发 cell.closed，静默后重试才真闭合', async () => {
    const base = tmp('a5');
    let release = () => {};
    let began = () => {};
    try {
      const gate = new Promise((r) => { release = r; });
      const started = new Promise((r) => { began = r; });
      const h = await host(base, {
        executor: 'ok',
        chat: async () => { began(); await gate; return { reply: 'done' }; },
      });
      await h.create();
      h.svc.accept('c1', taskOf('A', { required: ['tool.read'] }));
      const running = h.svc.execute('c1').catch((e) => ({ code: e?.code }));
      await started;
      const inflight = await h.svc.close('c1', { force: true, quiesceMs: 20 });
      assertEquals(inflight.execution_revoked, true, '执行资格必须立刻撤销');
      assertEquals(inflight.closed, false, '旧链还没静默，不许说已关闭');
      assertEquals(inflight.closing, true, '必须明确说「还在清理」');
      assert(inflight.cleanup_pending.includes('gate'),
        `门这一项必须仍在欠账里，实际 ${JSON.stringify(inflight.cleanup_pending)}`);
      const mid = h.svc.describe('c1').capability_gate;
      assertEquals(mid.pre >= 1 && mid.lease_live === true, true,
        '没静默就拆门 = 迟到的 tool-write 面前一条检查都不剩：门与租约必须留着');
      assertEquals(existsSync(lockDir(base)), true, '没静默就放开属主锁 = 请第二个进程插手');
      assertEquals(h.events.closed, 0, '清理没完成，cell.closed 一次都不能发');
      assert(h.events.closing >= 1, '必须发 cell.closing 说明「还在清理」');
      release();
      await running;
      const retried = await h.svc.close('c1');
      assertEquals(retried.closed, true, `静默后重试必须真闭合，实际 ${JSON.stringify(retried.cleanup_pending)}`);
      const end = h.svc.describe('c1').capability_gate;
      assertEquals(end.pre + end.dispatch, 0, '真闭合之后钩子必须清空');
      assertEquals(end.lease_live, false, '真闭合之后租约必须撤销');
      assertEquals(h.events.closed, 1, 'cell.closed 只在真闭合时发一次');
      assertEquals(existsSync(lockDir(base)), false, '真闭合之后属主锁必须消失');
    } finally { release(); rmSync(base, { recursive: true, force: true }); }
  });

  // ═══════════════════════════════════════════════════════════════════
  // 6. 磁盘 EIO —— 不得用伪 closed:true 消解未完成的责任
  // ═══════════════════════════════════════════════════════════════════

  runner.test('R34-A/6 落盘失败：必须 close_incomplete，门不得先拆，重试才收尾', async () => {
    const base = tmp('a6');
    try {
      const h = await host(base, { executor: 'ok' });
      await h.create();
      const orig = h.rt._persist.bind(h.rt);
      let thrown = false;
      h.rt._persist = async (core, rec) => {
        if (!thrown && rec.state === 'stopped') {
          thrown = true;
          throw Object.assign(new Error('EIO: disk gave up'), { code: 'EIO' });
        }
        return orig(core, rec);
      };
      let err = null;
      try { await h.svc.close('c1'); } catch (e) { err = e; }
      h.rt._persist = orig;
      assertEquals(err?.code, 'close_incomplete', `落盘失败必须报 close_incomplete，实际 ${err?.code ?? 'NO_THROW'}`);
      assertEquals(err.execution_revoked, true, '拒因必须说清「执行资格已撤销」这一半是真的');
      assert(err.cleanup_pending.includes('persist'), '必须报出还欠哪几步');
      const mid = h.svc.describe('c1').capability_gate;
      assertEquals(mid.pre >= 1 && mid.lease_live === true, true,
        '落盘都没成，门不许先拆（拆了就是拿「看起来关了」换安全边界）');
      assertEquals(existsSync(lockDir(base)), true, '清理没做完 ⇒ 锁必须还在');
      assertEquals(h.events.closed, 0, '清理没做完 ⇒ cell.closed 一次都不能发');
      const retried = await h.svc.close('c1');
      assertEquals(retried.closed, true, `重试必须收尾，实际 ${JSON.stringify(retried.cleanup_pending)}`);
      const end = h.svc.describe('c1').capability_gate;
      assertEquals(end.pre + end.dispatch, 0, '收尾之后钩子必须清空');
      assertEquals(existsSync(lockDir(base)), false, '收尾之后属主锁必须消失');
      assertEquals(h.events.closed, 1, '收尾时 cell.closed 发一次');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
}
