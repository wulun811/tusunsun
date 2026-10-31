// rc.30 —— rc.29 独立复审给出的 K29-01 的回归判据。
//
// 反例的形状不是"判据算错了"，而是**判据随对象一起消失**：
//   Cell 正常关闭时 `dropGate()` 把钩子和租约一起收走（这是对的 —— 关闭之后没有主体再受它保护），
//   此后租约表里什么都不剩，同一个 sessionId 就被执行器当成了**普通会话**。
//   rc.29 的判据是「有租约就验、没租约不管」；后半个分句就是那条反例。
//
// 三代缺陷的同一个根：**"这个会话本来属于谁"没有被当成判据**。
//   K29-A  关闭之后：租约空了 ⇒ 普通会话 ⇒ 写盘成功。
//   K29-B  延迟回调：`quiesced` 只覆盖受等待的那条执行链，不覆盖脱离它的回调。
//   K29-C  执行器迟到：Cell 先建、门从未装过 ⇒ 零租约 ⇒ 写盘成功。
//
// 边界（诚实）：真 Core / 真 workspace / 真 cell-runtime / 真 tool-executor / 真 haotian-lite，
// 真钩子表、真租约、真写盘。`tool.write` 是测试注册的"真写文件"能力，不是 plugins/tools/tool-write.js
// —— 后者还要装配 registry/guard，与本案判据无关。反例走的是**本进程内有权调用
// ToolExecutor.executeOne 的宿主/插件 API**，不等于证明普通模型能随意调用该方法；
// 模型可达面那一条由 K29-E 的单列（haotian-lite）负责。
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
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
 * 造一套真装配。`executor: 'none'` = 执行器完全缺席（K29-C 的前提）。
 *
 * 执行器一律 `new` 新实例：模块单例跨用例复用会撞上"已绑定另一 Core 不得重入"的合同。
 */
async function makeHost(base, { executor = 'real', sandbox = null, config = null } = {}) {
  const { Core } = await imp('src/core/core.js');
  const wsDir = join(base, 'ws');
  mkdirSync(wsDir, { recursive: true });
  const core = new Core({ stateDir: join(base, 'state') });
  core.log = () => {};
  core.setData('agent.workDir', wsDir);
  if (config) core.registerService('config', { get: (k, fb) => (k in config ? config[k] : fb) });
  await (await imp('plugins/workspace.js')).default.init(core);
  if (sandbox) core.registerService('sandbox', sandbox);

  core.registerCapability('tool.read', {
    owner: 'test',
    handler: async () => ({ ok: true, value: 'CELL-READ-PAYLOAD' }),
  });
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
  return mkdtempSync(join(tmpdir(), 'rc30-identity-'));
}

/** 统一的"这次派发必须被拒"断言：非成功 + 有名有姓 + 零写盘。 */
function assertRefused(host, r, where) {
  assertEquals(r?.ok, false, `${where}：必须被拒，实际 ${JSON.stringify(r).slice(0, 200)}`);
  assert(typeof r?.code === 'string' && r.code.length > 0,
    `${where}：拒绝必须具名（code），实际 ${JSON.stringify(r).slice(0, 200)}`);
  assertEquals(existsSync(join(host.wsDir, 'written.txt')), false,
    `${where}：拒绝必须发生在副作用之前 —— 磁盘不得有写入`);
  return r;
}

/**
 * 让只读能力真的跑过一次 —— 缓存那一条判据的前提。
 *
 * `rec.gateAllowed` 是在 `execute()` 里钉进去的（不是 `accept`）：不跑一次真任务，门对任何
 * 能力都回 `capability_denied`，测到的就不是“缓存命中”而是“根本没授权”。
 */
async function warmRead(host) {
  host.ctx.onChat = async (params) => {
    host.ctx.toolResult = await host.ctx.exec.executeOne('tool-read', {}, params?.sessionId);
    return { reply: 'read once' };
  };
  const r = await host.run('c1', 't-warm', { required_capabilities: ['tool.read'] });
  host.ctx.onChat = null;
  assertEquals(r.execution_state, 'succeeded', `前置：热身任务必须成功，实际 ${r.execution_state}`);
  assertEquals(host.ctx.toolResult?.ok, true,
    `前置：热身读取必须成功，实际 ${JSON.stringify(host.ctx.toolResult).slice(0, 160)}`);
}

export default async function (runner) {
  // ── K29-A：正常关闭之后，旧会话不得变回普通会话 ──────────────────────
  runner.test('rc.30/K29-A1 只读 Cell 未关闭时写盘被拒；正常 close 之后用旧 session 再写必须仍拒、零副作用', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base);
      await host.create({ capabilities: ['tool.read'], permission_mode: 'read-only' });

      const before = await host.ctx.exec.executeOne('tool-write', {}, 'cell-c1');
      assertRefused(host, before, '关闭前');

      const closed = await host.svc.close('c1', {});
      assertEquals(closed.closed, true, '关闭必须成功');
      assertEquals(closed.quiesced, true, '前提：本次关闭真的静默了（否则测的不是"关闭后"）');
      assertEquals(host.ctx.exec.guardLeasesFor('cell-c1').length, 0, '前提：租约已被撤销（那是对的）');

      // **反例本体**：租约表空了，但"这个会话属于一个已关闭的 Cell"这件事没有消失。
      const after = await host.ctx.exec.executeOne('tool-write', {}, 'cell-c1');
      assertRefused(host, after, '关闭后');
      assertEquals(after.code, 'execution_revoked', `关闭后的拒绝必须点明执行资格已撤，实际 ${after.code}`);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.30/K29-A2 Cell 被 faulted 之后同样不得退化为普通会话', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base);
      await host.create();
      // 直接把登记记录置为 faulted：模拟重启后"执行者已不在"的收敛结果。
      const rec = [...host.svc.list()];
      assertEquals(rec.length, 1, '前提：恰好一个 Cell');
      const internal = host.svc.describe('c1');
      assertEquals(internal.state, 'ready', '前提：创建后是 ready');
      // 没有公开 API 可以伪造 faulted，走公开路径：force close 之后 revoke 水位已抬，等价事实。
      // 这里测的是**另一条腿** —— 状态不是 ready/busy 时，即使执行资格水位未抬也要拒。
      await host.svc.close('c1', { force: true });
      const verdict = host.svc.sessionEligibility('cell-c1');
      assertEquals(verdict?.ok, false, '关闭之后的会话资格判决必须是否定的');
      assert(typeof verdict?.code === 'string', '判决必须带具名代码');
      const plain = host.svc.sessionEligibility('plain-session');
      assertEquals(plain, null, '非 Cell 会话必须返回 null（不推任何结论，不按前缀猜身份）');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  // ── K29-B：延迟回调 ─────────────────────────────────────────────────
  runner.test('rc.30/K29-B1 任务正常完成、Cell 正常关闭之后，宿主安排的延迟回调再派发必须被拒', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base);
      // 专家的原始形状：chat.handle 安排一条 150ms 后调 executeOne 的回调，然后立刻返回。
      // 走宿主已经登记的那个 `chat.handle`（`ctx.onChat` 就是它的钩子）：覆盖登记会触发
      // `capability_conflict` —— 那是保护，不是障碍。
      let resolveLate;
      const late = new Promise((r) => { resolveLate = r; });
      let sid = null;
      host.ctx.onChat = async (params) => {
        sid = params?.sessionId;
        setTimeout(async () => {
          try { resolveLate(await host.ctx.exec.executeOne('tool-write', {}, sid)); }
          catch (e) { resolveLate({ ok: false, code: e.code, error: e.message }); }
        }, 150);
        return { reply: 'task finished; auxiliary callback scheduled' };
      };

      await host.create({ capabilities: ['tool.read'], permission_mode: 'read-only' });
      const r = await host.run('c1', 't1', { required_capabilities: ['tool.read'] });
      assertEquals(r.execution_state, 'succeeded', '前提：任务本身正常完成');
      const closed = await host.svc.close('c1', {});
      assertEquals(closed.quiesced, true, '前提：close 报静默');

      const out = await late;
      assertRefused(host, out, '关闭后的延迟回调');
      // `quiesced` 只覆盖受等待的执行链，**不**等于"没有任何脱离执行 Promise 的回调"。
      assert(['execution_revoked', 'cell_gate_unavailable'].includes(out.code),
        `延迟回调必须按生命周期/门存续拒绝，实际 ${out.code}`);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  // ── K29-C：执行器迟到，门从未装过 ────────────────────────────────────
  runner.test('rc.30/K29-C1 纯对话 Cell 可在无执行器时创建；执行器迟到且未补门时直连必须拒；合法装配后恢复执行', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base, { executor: 'none' });
      // 纯对话 Cell 合法：不碰工具就不需要门（H26-01 已接受的前提，不能因为本条反例被推翻）。
      await host.create({ capabilities: ['tool.read'], permission_mode: 'read-only' });
      assertEquals(host.svc.describe('c1').capability_gate.installed, false, '前提：此刻没有门（也没有执行器）');

      await host.installExecutor();
      const gate = host.svc.describe('c1').capability_gate;
      assertEquals(gate.executor_present, true, '前提：执行器已装配');
      assertEquals(gate.installed, false, '前提：没人补门 —— 这正是反例的起点');
      assertEquals(host.ctx.exec.guardLeasesFor('cell-c1').length, 0, '前提：从未有过租约（不是"被撤了"）');

      // **反例本体**：零租约不等于"这个会话不需要门"。
      const pending = await host.ctx.exec.executeOne('tool-write', {}, 'cell-c1');
      assertRefused(host, pending, '执行器迟到且未补门');
      assertEquals(pending.code, 'cell_gate_unavailable', `必须点明门不可用，实际 ${pending.code}`);

      // 合法装配（真的重新装配一次）之后必须恢复：拒绝不等于把这个 Cell 永久废掉。
      host.core.emit('core:plugin.loaded', { pluginName: 'tool-executor', sourcePlugin: 'test' });
      const after = host.svc.describe('c1').capability_gate;
      assertEquals(after.installed, true, '合法装配之后门必须落地');
      assertEquals(after.lease_live, true, '租约必须跟着新回执重建');

      // 普通会话不受影响（门是给 Cell 会话的，不是给"所有会话"的）。
      const plain = await host.ctx.exec.executeOne('tool-read', {}, 'plain-session');
      assertEquals(plain.ok, true, '普通会话必须照常执行，不得被 Cell 的判据误伤');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  // ── K29-D：不误伤 ───────────────────────────────────────────────────
  runner.test('rc.30/K29-D1 普通会话（从未登记为 Cell）的授权工具照常执行：写盘真的发生', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base);
      await host.create();
      await host.svc.close('c1', {});
      // 与 Cell 无关的会话：既没有归属、也没有租约，必须保持旧行为。
      const plain = await host.ctx.exec.executeOne('tool-write', {}, 'rest_api_session');
      assertEquals(plain.ok, true, `普通会话不得被误伤，实际 ${JSON.stringify(plain).slice(0, 160)}`);
      assertEquals(existsSync(join(host.wsDir, 'written.txt')), true, '普通会话应当真的写盘');
      assertEquals(host.svc.sessionEligibility('rest_api_session'), null,
        '非 Cell 会话的资格判决必须是 null（"不知道"不是"不允许"）');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.30/K29-D2 名字像 Cell（cell-fake）但不是登记会话：不得按前缀误杀', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base);
      await host.create({ cell_id: 'c1' });
      // 前缀 `cell-` 是**猜身份**的入口：登记表里没有 `cell-fake`。
      assertEquals(host.svc.cellForSession('cell-fake'), null, '登记表必须查不到它');
      assertEquals(host.ctx.exec.isProtectedSession('cell-fake'), false, '不得按前缀把它当受保护会话');
      const r = await host.ctx.exec.executeOne('tool-write', {}, 'cell-fake');
      assertEquals(r.ok, true, `不得按名字前缀误杀普通会话，实际 ${JSON.stringify(r).slice(0, 160)}`);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  // ── K29-E：每条派发路径按同一权威拒绝 ────────────────────────────────
  runner.test('rc.30/K29-E1 缓存命中路径：Cell 关闭后同参数只读调用不得从缓存交付结果', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base);
      await host.create();
      // 先让它真的读过一次 ⇒ 只读能力结果进了缓存。
      await warmRead(host);

      await host.svc.close('c1', {});
      // 完全相同的参数：缓存里**有**结果，但"能不能交付"与"算没算过"是两件事。
      const again = await host.ctx.exec.executeOne('tool-read', {}, 'cell-c1');
      assertRefused(host, again, '关闭后的缓存命中');
      // 只读调用不写盘，所以这里单独补一条"没有把缓存交付出去"的判据。
      assertEquals(again?.result, undefined, `不得交付缓存内容，实际 ${JSON.stringify(again).slice(0, 200)}`);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.30/K29-E2 沙箱路径：Cell 关闭后必须拒在沙箱之前（沙箱调用 0 次）', async () => {
    const base = tmp();
    try {
      let sandboxCalls = 0;
      const host = await makeHost(base, {
        config: { 'sandbox.enabled': true },
        sandbox: { execute: async () => { sandboxCalls++; return { ok: true, data: { wrote: true } }; } },
      });
      await host.create();
      assertEquals(host.ctx.exec._useSandbox, true, '前提：sandbox.enabled 已被执行器读到');
      await host.svc.close('c1', {});

      const r = await host.ctx.exec.executeOne('tool-write', {}, 'cell-c1');
      assertRefused(host, r, '关闭后的沙箱路径');
      assertEquals(sandboxCalls, 0, '拒绝必须发生在沙箱之前：不得先把请求下发再拦');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.30/K29-E3 legacy 直连路径：Cell 关闭后即使宿主把回退开关全开也不得执行', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base);
      await host.create();
      // 宿主能开的锁全开：这只能证明"宿主显式选了它"，不能证明"Cell 门同意"。
      host.core.setData('tools.legacyRegistryFallback', true);
      host.core.setData('tools.legacyRegistryFallbackAllowlist', ['legacy-tool']);
      host.core.setData('tools.legacyRegistryFallbackNoAuthorityApproved', true);
      let executed = 0;
      host.core.registerService('tool-registry', {
        get: (n) => (n === 'legacy-tool'
          ? { name: n, execute: async () => { executed++; return { ok: true }; } } : null),
      });

      await host.svc.close('c1', {});
      const r = await host.ctx.exec.executeOne('legacy-tool', {}, 'cell-c1');
      assertEquals(r?.ok, false, `关闭后不得走 legacy 直连，实际 ${JSON.stringify(r).slice(0, 160)}`);
      assertEquals(executed, 0, '拒绝必须发生在执行之前（零副作用）');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.30/K29-E4 haotian-lite 模型工具面：Cell 关闭之后不得再派发（两条子路径都拒）', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base);
      await host.create({ capabilities: [], permission_mode: 'read-only' });
      await host.svc.close('c1', {});

      const haotian = Object.create((await imp('plugins/haotian-lite.js')).default);
      haotian.core = host.core;
      const history = [];
      await haotian._execTools([{ name: 'tool-write', arguments: '{}', id: 'toolcall-1' }], history, 1, 'cell-c1', 'trace');

      const text = history.map((h) => String(h.content)).join('\n');
      assert(/execution_revoked|cell_gate_unavailable/.test(text),
        `模型工具面必须收到具名拒绝，实际 history=${text.slice(0, 300)}`);
      assertEquals(existsSync(join(host.wsDir, 'written.txt')), false, '模型工具调用不得产生写入');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  // ── K29-F：跨入口矩阵，失败/跳过/未运行分开报 ──────────────────────────
  runner.test('rc.30/K29-F1 两条生命周期 × 四条派发入口的矩阵：每一格都必须拒、且零写盘', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base);
      await host.create();
      host.core.setData('tools.legacyRegistryFallback', true);
      host.core.setData('tools.legacyRegistryFallbackAllowlist', ['legacy-tool']);
      host.core.setData('tools.legacyRegistryFallbackNoAuthorityApproved', true);
      let legacyRan = 0;
      host.core.registerService('tool-registry', {
        get: (n) => (n === 'legacy-tool'
          ? { name: n, execute: async () => { legacyRan++; return { ok: true }; } } : null),
      });

      // 先读一次，让缓存里有一条"算过"的只读结果（矩阵里"缓存命中"那一格才有意义）。
      await warmRead(host);

      const closed = await host.svc.close('c1', {});
      assertEquals(closed.quiesced, true, '前置：关闭必须静默');

      const rows = [
        ['能力路径', () => host.ctx.exec.executeOne('tool-write', {}, 'cell-c1')],
        ['缓存命中', () => host.ctx.exec.executeOne('tool-read', {}, 'cell-c1')],
        ['legacy 直连', () => host.ctx.exec.executeOne('legacy-tool', {}, 'cell-c1')],
        ['haotian 模型面', async () => {
          const h = Object.create((await imp('plugins/haotian-lite.js')).default);
          h.core = host.core;
          const hist = [];
          await h._execTools([{ name: 'tool-write', arguments: '{}', id: 'tc' }], hist, 1, 'cell-c1', 'tr');
          const text = hist.map((x) => String(x.content)).join('\n');
          return { ok: !/execution_revoked|cell_gate_unavailable|Error:/.test(text) ? true : false, code: 'model_surface', text };
        }],
      ];
      const outcomes = [];
      for (const [name, fn] of rows) {
        const r = await fn();
        outcomes.push(`${name}:${r?.ok === true ? 'ALLOWED' : (r?.code || 'REFUSED')}`);
        assertEquals(r?.ok, false, `${name} 必须被拒，实际 ${JSON.stringify(r).slice(0, 160)}`);
      }
      assertEquals(legacyRan, 0, 'legacy 直连不得执行');
      assertEquals(existsSync(join(host.wsDir, 'written.txt')), false, '整张矩阵不得产生写入');
      console.log(`       [实测] 关闭后四入口矩阵 ${outcomes.join(' / ')}`);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.30/K29-F2 判决只来自登记表：同一 sessionId 在 Cell 存活时允许、关闭后拒绝', async () => {
    const base = tmp();
    try {
      const host = await makeHost(base);
      await host.create();
      const live = host.svc.sessionEligibility('cell-c1');
      assertEquals(live?.ok, true, '存活时资格必须成立');
      assertEquals(live.cell_id, 'c1', '判决必须带出 cell_id');
      assertEquals(live.state, 'ready', '判决必须带出状态');

      await host.svc.close('c1', {});
      const dead = host.svc.sessionEligibility('cell-c1');
      assertEquals(dead?.ok, false, '关闭之后资格必须不成立');
      assertEquals(dead.code, 'execution_revoked', `判决代码必须是执行资格已撤，实际 ${dead.code}`);

      // 同一个 Core 上不存在的会话：判决是 null，不是 false —— "不知道"不能伪装成"不允许"。
      assertEquals(host.svc.sessionEligibility('someone-else'), null, '未知会话必须返回 null');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
}
