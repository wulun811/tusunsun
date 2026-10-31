// rc.29 —— 独立复审（rc.28 交付包）给出的三个新反例的回归判据。
//
// 三份反例都不是"判据说错了"，而是"判据不在它该在的地方"：
//   R28-A 任务启动后撤钩 ⇒ 派发期遍历到零条钩子，零条就放行 —— 判据**消失了却没人记得它该在**；
//   R28-B 无执行器时 haotian-lite 的 legacy 直连 ⇒ 模型工具调用从不经过 Cell 门（判据**根本不存在**）；
//   R28-C create() 后半段抛错 ⇒ 注册表里留下一个 ready、能执行、门还装着的 Cell（判据在，Cell 不该在）。
//
// 边界（诚实）：真实 Core / workspace / cell-runtime / tool-executor / haotian-lite，真钩子表、
// 真租约、真写盘。`tool.write` 是测试注册的"真写文件"能力（不是 plugins/tools/tool-write.js：
// 那份还要装配 registry/guard，与本案判据无关）。模型工具调用用 `_execTools` 直接模拟 ——
// 专家反例就是这么写的，不需要联网模型。
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TestRunner, assert, assertEquals } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(join(ROOT, rel));

const spec = (id, workspace, over = {}) => ({
  schema_version: 'tusunsun.cell/v0',
  cell_id: id,
  workspace,
  capabilities: ['tool.read', 'tool.write'],
  permission_mode: 'auto',
  runtime: { kind: 'process' },
  limits: { max_active_tasks: 1, max_children: 0 },
  ...over,
});

const task = (id, cellId, over = {}) => ({
  schema_version: 'tusunsun.task/v0',
  task_id: id,
  attempt: 1,
  target_cell_id: cellId,
  goal: 'write one file',
  inputs: [],
  required_capabilities: ['tool.write'],
  budget: { max_steps: 5, wall_ms: 30000 },
  acceptance: { required_artifacts: [], checks: [] },
  ...over,
});

/**
 * 造一套真装配。`executor: 'none'` 是"执行器完全缺席"（R28-B 的前提）。
 *
 * 执行器一律 `new` 新实例：模块单例跨用例复用会撞上"已绑定另一 Core 不得重入"的合同，
 * 那是保护，不是被测对象。
 */
async function makeHost(base, { executor = 'real' } = {}) {
  const { Core } = await imp('src/core/core.js');
  const wsDir = join(base, 'ws');
  mkdirSync(wsDir, { recursive: true });
  const core = new Core({ stateDir: join(base, 'state') });
  core.log = () => {};
  core.setData('agent.workDir', wsDir);
  await (await imp('plugins/workspace.js')).default.init(core);
  core.registerCapability('tool.read', { owner: 'test', handler: async () => ({ ok: true }) });
  // **真的写盘**：这就是"未经授权的 tool-write 会造成的副作用"。
  core.registerCapability('tool.write', {
    owner: 'test',
    handler: async () => { writeFileSync(join(wsDir, 'written.txt'), 'x'); return { ok: true }; },
  });
  const rt = (await imp('plugins/cell-runtime.js')).default;
  await rt.init(core);

  const ctx = { exec: null, toolResult: null, chatSession: null, onChat: null, rt };
  core.registerCapability('chat.handle', {
    owner: 'test',
    handler: async (params) => {
      ctx.chatSession = params?.sessionId ?? null;
      if (ctx.onChat) return ctx.onChat(params);
      ctx.toolResult = await ctx.exec.executeOne('tool-write', {}, params?.sessionId);
      return { reply: 'attempted tool-write' };
    },
  });

  const Cls = (await imp('plugins/tool-executor.js')).default.constructor;
  if (executor === 'real') {
    ctx.exec = new Cls();
    await ctx.exec.init(core);
  }

  return {
    core, wsDir, ctx,
    svc: core.getService('cell-runtime'),
    wsSvc: core.getService('workspace'),
    async installExecutor() {
      ctx.exec = new Cls();
      await ctx.exec.init(core);
      return ctx.exec;
    },
    create(over = {}) { return this.svc.create(spec('c1', wsDir, over), { trusted: true }); },
    run(cellId, taskId, over = {}) {
      this.svc.accept(cellId, task(taskId, cellId, over));
      return this.svc.execute(cellId, null, {});
    },
  };
}

function tmp() {
  return mkdtempSync(join(tmpdir(), 'rc29-gate-'));
}

export default async function (runner) {
  // ── R28-A：任务中撤钩之后，下一次派发必须被拒 ──────────────────────
  runner.test('rc.29/R28-A1 任务执行中撤钩：同一次任务里的下一次 tool.write 必须被拒，磁盘零写入', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base);
      await host.create({ capabilities: ['tool.read'], permission_mode: 'read-only' });
      assertEquals(host.svc.describe('c1').capability_gate.live, true, '前置：门此刻必须是活的');

      // 反例的真实形状：任务已经进来（execute 入口核过账），在 chat.handle 里把门摘掉，
      // 再让模型发起工具调用。entry 只核过一次，这一次派发必须自己拒绝。
      host.ctx.onChat = async (params) => {
        host.ctx.exec.removeHooksByOwner('cell:c1');
        try { host.ctx.toolResult = await host.ctx.exec.executeOne('tool-write', {}, params?.sessionId); }
        catch (e) { host.ctx.toolResult = { ok: false, code: e.code, error: e.message }; }
        return { reply: 'tried after unhook' };
      };
      const r = await host.run('c1', 't1', { required_capabilities: ['tool.read'] });

      assertEquals(host.ctx.toolResult?.ok, false, '撤钩之后的派发必须失败，不能"零条钩子=放行"');
      assertEquals(host.ctx.toolResult?.code, 'cell_gate_unavailable', `拒绝理由必须是门不可用，实际 ${host.ctx.toolResult?.code}`);
      assertEquals(existsSync(join(host.wsDir, 'written.txt')), false, '拒绝必须发生在副作用之前：磁盘不得有写入');
      // 任务本身可以收尾（工具被拒 ≠ 任务失败），但观测面必须把"门没了"说出来。
      assertEquals(host.svc.describe('c1').capability_gate.live, false, 'describe 必须报门已不在');
      assertEquals(host.svc.describe('c1').capability_gate.lease_live, false, '租约必须报不成立');
      assert(r.execution_state, '任务仍要有明确终态');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.29/R28-A2 撤钩只影响被保护的那个会话：普通会话照常执行（不误伤）', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base);
      await host.create();
      host.ctx.exec.removeHooksByOwner('cell:c1');
      // 非 Cell 会话：没有租约，也没有 Cell 门 —— 它本来就该走自己的判据。
      const out = await host.ctx.exec.executeOne('tool-read', {}, 'plain-session');
      assertEquals(out.ok, true, `普通会话不得被无关停机，实际 ${JSON.stringify(out).slice(0, 160)}`);
      assert(existsSync(join(host.wsDir)) || true, '工作区仍可用');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.29/R28-A3 合法恢复：热装配回来（core:plugin.loaded）重装门后，同一会话恢复执行', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base);
      await host.create();
      // 第一趟走完整任务：execute 把生效能力钉进 `rec.gateAllowed`，chat.handle 里撤钩。
      host.ctx.onChat = async (params) => {
        host.ctx.exec.removeHooksByOwner('cell:c1');
        host.ctx.toolResult = await host.ctx.exec.executeOne('tool-write', {}, params?.sessionId);
        return { reply: 'tried after unhook' };
      };
      await host.run('c1', 't1');
      assertEquals(host.ctx.toolResult?.ok, false, '前置：撤钩后被拒');
      assertEquals(existsSync(join(host.wsDir, 'written.txt')), false, '前置：零写入');

      // 唯一合法的重装入口：一次真的重新装配（`_installGatesForExisting` 的落点）。
      host.core.emit('core:plugin.loaded', { pluginName: 'tool-executor', sourcePlugin: 'test' });
      const gate = host.svc.describe('c1').capability_gate;
      assertEquals(gate.live, true, '重新装配之后门必须重新落地');
      assertEquals(gate.lease_live, true, '租约必须跟着新回执重建');
      assert(gate.reinstalls >= 1, `describe 必须报出重装次数，实际 ${gate.reinstalls}`);
      assertEquals(gate.pre, 1, '重装必须先把失效的那套摘掉：不得在表里留下死记录（否则“装了几条”开说假话）');
      assertEquals(gate.dispatch, 1, '重装之后派发期钩子必须恰好一条');

      // 恢复后跑第二个任务：这一次正常派发，必须真的写盘 —— “恢复”不是只能观测到 live:true。
      host.ctx.onChat = null;
      const r2 = await host.run('c1', 't2');
      assertEquals(r2.execution_state, 'succeeded', '恢复之后的任务必须能正常完成');
      assertEquals(host.ctx.toolResult?.ok, true, `恢复之后同一会话必须恢复执行，实际 ${JSON.stringify(host.ctx.toolResult).slice(0, 160)}`);
      assertEquals(existsSync(join(host.wsDir, 'written.txt')), true, '恢复之后应当真的写盘');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.29/R28-A4 legacy 直连也不得成为受保护会话的退路（/ 缓存 / 沙箱 / legacy 三条路径的第三条）', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base);
      await host.create();
      // 把宿主能开的门全开到最宽：legacy 回退 + 白名单 + “无身份权威也放行”。
      // 这条路径的其余 4 道锁都只证明“宿主显式选了它”，不能证明“Cell 门也同意”。
      host.core.setData('tools.legacyRegistryFallback', true);
      host.core.setData('tools.legacyRegistryFallbackAllowlist', ['legacy-tool']);
      host.core.setData('tools.legacyRegistryFallbackNoAuthorityApproved', true);
      let executed = 0;
      host.core.registerService('tool-registry', {
        get: (n) => (n === 'legacy-tool'
          ? { name: n, execute: async () => { executed++; return { ok: true }; } } : null),
      });

      assertEquals(host.ctx.exec.isProtectedSession('cell-c1'), true, '受保护会话必须被认出来');
      assertEquals(host.ctx.exec.isProtectedSession('plain-session'), false, '普通会话不得被误判为受保护');

      // **在真任务里调**（rc.31 起是必要条件）：任务之外调用会先被任务维度拒（`task_scope_required`），
      // 那样断言到的就不是本条要证的「legacy 不是退路」了 —— 一条判据被另一条盖住时的绿，
      // 只说明“有人拒了”。所以把主语放进它该在的位置，让这条判据自己表态。
      host.ctx.onChat = async (params) => {
        const out = await host.ctx.exec.executeOne('legacy-tool', {}, params?.sessionId);
        host.ctx.toolResult = out;
        return { reply: 'attempted legacy-tool' };
      };
      await host.run('c1', 't-legacy');
      const r = host.ctx.toolResult;
      assertEquals(r?.ok, false, `受保护会话不得走 legacy 直连，实际 ${JSON.stringify(r).slice(0, 160)}`);
      assertEquals(r?.code, 'capability_denied', `拒绝必须具名 capability_denied，实际 ${r?.code}`);
      assertEquals(executed, 0, '拒绝必须发生在执行之前（零副作用）');

      // 另一条腿：**任务之外**调用同样不得走到 legacy（只是理由换了层次）。
      // 两条都要有 —— 否则“任务外也被拒”会被误读成本条判据仍然生效。
      const outside = await host.ctx.exec.executeOne('legacy-tool', {}, 'cell-c1');
      assertEquals(outside?.ok, false, `任务之外同样不得走 legacy 直连，实际 ${JSON.stringify(outside).slice(0, 160)}`);
      assertEquals(outside?.code, 'task_scope_required', `任务外必须按任务维度拒绝，实际 ${outside?.code}`);
      assertEquals(executed, 0, '两条路径都不得执行');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  // ── R28-B：Cell 会话不得回落到 legacy 直连 ─────────────────────────
  const legacyCore = async (base) => {
    const host = await makeHost(base, { executor: 'none' });
    // legacy `tools` 服务：模型可见的工具名 → 能力 id（`_legacyTarget` 的全部输入）。
    host.core.registerService('tools', {
      get(name) {
        if (name === 'write_file') return { name, _capabilityId: 'tool.write', provides: [{ name: 'tool.write' }] };
        return null;
      },
    });
    return host;
  };

  runner.test('rc.29/R28-B1 Cell 会话 + 无执行器：haotian-legacy 的模型工具调用必须拒，零写盘', async () => {
    const base = tmp();
    try {
      const host = await legacyCore(base);
      await host.create({ capabilities: [], permission_mode: 'read-only' });
      const haotian = Object.create((await imp('plugins/haotian-lite.js')).default);
      haotian.core = host.core;
      const history = [];
      await haotian._execTools([{ name: 'write_file', arguments: '{}', id: 'toolcall-1' }], history, 1, 'cell-c1', 'trace');

      assertEquals(existsSync(join(host.wsDir, 'written.txt')), false,
        'Cell 会话的 legacy 工具调用必须零副作用（修前这里真的写盘）');
      assertEquals(history.length, 1, '模型必须收到一条工具结果（不能静默吞掉）');
      assert(/cell_gate_unavailable/.test(String(history[0].content)),
        `拒绝必须具名，实际 ${String(history[0].content).slice(0, 200)}`);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.29/R28-B2 普通会话的 legacy 路径不回归：非 Cell 会话照旧执行', async () => {
    const base = tmp();
    try {
      const host = await legacyCore(base);
      await host.create();
      const haotian = Object.create((await imp('plugins/haotian-lite.js')).default);
      haotian.core = host.core;
      const history = [];
      await haotian._execTools([{ name: 'write_file', arguments: '{}', id: 'toolcall-1' }], history, 1, 'plain-session', 'trace');
      assertEquals(existsSync(join(host.wsDir, 'written.txt')), true,
        '非 Cell 会话没有 Cell 门可绕，legacy 兼容路径必须保持原样');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  // ── R28-C：create 的整体提交边界 ───────────────────────────────────
  runner.test('rc.29/R28-C1 loadBinding 抛错：create 必须整体失败，不留 Cell / 工作区绑定 / 钩子', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base);
      host.core.registerService('cell-context', {
        loadBinding: async () => { throw Object.assign(new Error('invalid stored profile'), { code: 'CORRUPT_CONTEXT' }); },
      });
      let err = null;
      try { await host.create(); } catch (e) { err = e; }
      assertEquals(err?.code, 'CORRUPT_CONTEXT', '错误必须原样上抛（不吞、不改码）');
      assertEquals(host.svc.list().length, 0, '失败的 create 不得在 list() 里留下 ready 的 Cell');
      assertEquals(host.wsSvc.has('cell-c1'), false, '失败的 create 不得留下工作区绑定');
      assertEquals(host.ctx.exec.hookCountFor('cell:c1').pre, 0, '失败的 create 不得留下 pre 钩子');
      assertEquals(host.ctx.exec.hookCountFor('cell:c1').dispatch, 0, '失败的 create 不得留下派发期钩子');
      assertEquals(host.ctx.exec.guardLeasesFor('cell-c1').length, 0, '失败的 create 不得留下租约');
      let de = null;
      try { host.svc.describe('c1'); } catch (e) { de = e; }
      assertEquals(de?.code, 'unknown_cell', 'describe 必须报 unknown_cell');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.29/R28-C2 落盘抛错：同样整体回退，且 stateDir 里与本次创建无关的文件不被删', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base);
      // 与本 Cell 无关、但同在 stateDir 下的状态：回退不得碰它（「保留此前已经存在的」）。
      const sentinel = join(base, 'state', 'other-plugin-state.json');
      mkdirSync(dirname(sentinel), { recursive: true });
      writeFileSync(sentinel, '{"keep":true}');

      const rt = host.ctx.rt;
      const realPersist = rt._persist;
      // 故障注入点选在 `_persist`：它才是「登记之后还会抛」的那一步（R28-C 的原形）。
      rt._persist = async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
      let err = null;
      try { await host.create(); } catch (e) { err = e; }
      finally { rt._persist = realPersist; }

      assertEquals(err?.code, 'ENOSPC', `错误必须原样上抛，实际 ${err?.code}`);
      assertEquals(host.svc.list().length, 0, '落盘失败的 create 不得在 list() 里留下 ready 的 Cell');
      assertEquals(host.wsSvc.has('cell-c1'), false, '落盘失败的 create 不得留下工作区绑定');
      assertEquals(host.ctx.exec.hookCountFor('cell:c1').pre, 0, '落盘失败的 create 不得留下 pre 钩子');
      assertEquals(host.ctx.exec.hookCountFor('cell:c1').dispatch, 0, '落盘失败的 create 不得留下派发期钩子');
      assertEquals(host.ctx.exec.guardLeasesFor('cell-c1').length, 0, '落盘失败的 create 不得留下租约');
      assertEquals(existsSync(sentinel), true, '与本次创建无关的状态不得被删');
      assertEquals(readFileSync(sentinel, 'utf8'), '{"keep":true}', '与本次创建无关的状态内容不得被改');

      // 回退之后必须能重新来一次：不留「半开」的中间态（否则重试会撞上自己的残骸）。
      const again = await host.create();
      assertEquals(again.state, 'ready', '回退之后必须能重新创建');
      assertEquals(again.capability_gate.live, true, '重新创建的门必须是活的');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.29/R28-C3 同进程重复创建：必须具名拒绝（cell_id_conflict），原记录不被顶掉', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base);
      await host.create();
      const before = host.svc.describe('c1');
      let err = null;
      try { await host.create(); } catch (e) { err = e; }
      assertEquals(err?.code, 'cell_id_conflict', `重复创建必须具名拒绝，实际 ${err?.code}`);
      const after = host.svc.describe('c1');
      assertEquals(after.incarnation_id, before.incarnation_id, '原记录的 incarnation 不得被顶掉');
      assertEquals(after.state, 'ready', '原状态不得被覆盖');
      assertEquals(host.svc.list().length, 1, '登记表里只能有一条');
      assertEquals(host.ctx.exec.hookCountFor('cell:c1').pre, 1, '不得因第二次创建多装一套钩子');
      assertEquals(host.ctx.exec.hookCountFor('cell:c1').dispatch, 1, '不得因第二次创建多装一套钩子');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
}
