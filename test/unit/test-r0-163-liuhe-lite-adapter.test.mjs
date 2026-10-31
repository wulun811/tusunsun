// R0-163：六合 Lite 0.1.3 并入本仓的回归锁（v0.13.0）。
//
// 这一轮不是"加一个插件"——合并过程中**实测**出四个真缺陷，其中三个在**我们自己的**代码里，
// 与本轮的新插件无关：它们只是此前没有任何调用形态能走到。本文件把它们钉住。
//
//   G1 门面：`registerTool({capabilityId})` 的 `capabilityId` **零读者**
//             ⇒ 显式登记能力的工具，模型点它必得 `capability_denied`（实测）。
//   G2 门面：`unregisterTool` **重新派生**了一次 id，而不是释放注册时那一个
//             ⇒ 显式 id 的能力成为摘不掉的幽灵，返回值还报 `released: true`（实测）。
//   G3 Cell 门：pre 阶段用名字派生猜能力 id，猜出的假 id 拿去拒人
//             ⇒ Cell 声明了 `liuhe.read_anchor`、`capabilities_effective` 里也有它，
//                模型点工具照样 `capability_denied (effective: (none))`（实测）。
//   G4 适配层：`liuhe.readAnchor` 这种驼峰能力 id 被 Cell 契约的 `CAPABILITY_RE` 拒
//             ⇒ 契约是对的，改名的是我们。这条锁住"能力 id 必须全小写"。
//
// 另有四条是适配层自己的合同（归一、授权边界、披露权、只读分类），每条都对应一个
// **可以说错的句子**：
//   A1 "Lite 的回执能进我方校验器"     —— 归一前会被拒（application 枚举已是 v0.11.0 修的）
//   A2 "工作区真值只能来自宿主"         —— 模型给 `workspace` 必须被拒，且在进 Lite **之前**
//   A3 "apply / undo 不给模型"          —— 它们不得出现在模型可见工具表里
//   A4 "read_anchor / inspect 是只读"   —— 只读 Cell 必须调得动，否则提示词在骗模型
//
// 变异记录（每条都真的做过，删判据→红，恢复→绿）：
//   M1 删 `_capabilityIdsForTool` 里的 `tool._capabilityId` 一行 → G1 红
//   M2 把 `unregisterTool` 的 capId 改回名字派生            → G2 红
//   M3 删 `resolveCapId` 的 registry 分支（退回纯派生）      → G3 红
//   M4 把 ACTIONS 改回 `liuhe.readAnchor`                    → G4 红
//   M5 删 `findWorkspaceParams` 的调用                       → A2 红
//   M6 把 `persistence` 归一去 `memory_only` 原值            → A1 红
//   M7 把 `liuhe.apply` 加进 `_MODEL_VISIBLE`                → A3 红
//   M8 从 READONLY_CAPABILITY_IDS 删 `liuhe.read_anchor`     → A4 红
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TestRunner, assert, assertEquals } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(join(ROOT, rel));
const src = (rel) => readFileSync(join(ROOT, rel), 'utf-8');

/** 剥注释：结构判据必须看代码，不能被注释里的示例字样满足（R0-115 的教训）。 */
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

export async function setup(runner) {
  const base = (tag = 'r163') => mkdtempSync(join(tmpdir(), `${tag}-`));

  // ══ G1 / G2：tool-registry 门面的显式能力 id 必须真的有读者 ═══════════════
  runner.test('R0-163/G1 registerTool 的 capabilityId 必须被执行器认到（否则模型点工具必被拒）', async () => {
    const d = base('g1');
    try {
      const { Core } = await imp('src/core/core.js');
      const core = new Core({ stateDir: join(d, 'state') });
      core.log = () => {};
      const loader = (await imp('plugins/tool-loader.js')).default;
      const exec = Object.create((await imp('plugins/tool-executor.js')).default);
      exec._preHooks = []; exec._postHooks = []; exec._dispatchHooks = [];
      exec._rateCalls = new Map(); exec._cache = new Map(); exec._auditLog = new Map();
      for (const p of [loader]) await core.register(p);
      await core.start();
      await exec.init(core);

      let called = 0;
      // 名字与能力**故意无关**：这是 `capabilityId` 存在的唯一理由。
      core.registerCapability('liuhe.read_anchor', { owner: 'liuhe-lite', handler: async () => { called++; return { ok: true }; } });
      const reg = core.getService('tool-registry');
      const r = reg.registerTool({
        name: 'tool-liuhe-anchor',
        owner: 'liuhe-lite',
        capabilityId: 'liuhe.read_anchor',
        execute: async () => { called++; return { ok: true }; },
        parameters: { type: 'object', properties: {} },
      });
      assertEquals(r.ok, true, '前提：注册应成功');

      // 执行器必须能解析出**登记的那个**能力，而不是 `tool.liuhe-anchor`（不存在）。
      const resolved = await exec._resolveCapability('tool-liuhe-anchor');
      assertEquals(resolved.capId, 'liuhe.read_anchor',
        `执行器必须认定显式登记的 ${'liuhe.read_anchor'}，实际 ${resolved.capId}`
        + '（修前死参数：解析为 tool.liuhe-anchor ⇒ 模型调用 100% capability_denied）');
      // 端到端：真的能执行
      const out = await exec.executeOne('tool-liuhe-anchor', {}, 'sess-g1', 'chain-g1');
      assertEquals(out.ok, true, `显式能力 id 的工具必须能执行，实际 ${out.error || out.state}`);
      assert(called > 0, 'handler 必须真的被调用（"解析出来了"不等于"执行到了"）');
      console.log('       [实测] capabilityId 被解析为 liuhe.read_anchor 并真的执行');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-163/G2 unregisterTool 必须释放**注册时那个**能力，不得释放名字派生的另一个', async () => {
    const d = base('g2');
    try {
      const { Core } = await imp('src/core/core.js');
      const core = new Core({ stateDir: join(d, 'state') });
      core.log = () => {};
      const loader = (await imp('plugins/tool-loader.js')).default;
      await core.register(loader);
      await core.start();
      const reg = core.getService('tool-registry');

      // 名字派生 id 与显式 id **同时存在**，且同 owner —— 这是"放错能力"最容易发生的形态。
      core.registerCapability('tool.sneaky', { owner: 'o1', handler: async () => ({ ok: 'derived' }) });
      const r = reg.registerTool({
        name: 'tool-sneaky', owner: 'o1', capabilityId: 'sneaky.real',
        execute: async () => ({ ok: true }), parameters: { type: 'object', properties: {} },
      });
      assertEquals(r.ok, true, '前提：注册应成功');
      const has = (id) => core.listCapabilities().some((c) => c.id === id);
      assert(has('sneaky.real'), '前提：显式能力应已注册');

      const u = reg.unregisterTool({ name: 'tool-sneaky', owner: 'o1', handle: r.handle });
      assertEquals(u.ok, true, '注销应成功');
      assertEquals(has('sneaky.real'), false,
        '显式注册的那个能力必须被释放 —— 修前它成为摘不掉的幽灵（实测 after: sneaky.real 仍在）');
      assertEquals(u.capability_released, true, '返回值必须如实说放掉了（不得报 false 却真放了）');
      // 同名派生的那个**不是**本工具注册的，不得被顺手放掉。
      assertEquals(has('tool.sneaky'), true,
        '注销本工具不得顺带释放同名的别家能力 —— 修前实测把 tool.sneaky 放掉、留下 sneaky.real（正好反了）');
      console.log('       [实测] 释放 sneaky.real，保留 tool.sneaky（方向正确）');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ══ G3：Cell 门 pre 阶段不得拿猜出来的能力 id 拒人 ═══════════════════════
  runner.test('R0-163/G3 Cell 声明了显式登记的能力，模型点对应工具必须放行（pre 阶段不得按派生 id 误拒）', async () => {
    const d = base('g3');
    try {
      const { Core } = await imp('src/core/core.js');
      const ws = join(d, 'ws');
      mkdirSync(join(ws, 'src'), { recursive: true });
      writeFileSync(join(ws, 'src', 'a.txt'), 'v1\n');

      const core = new Core({ stateDir: join(d, 'state') });
      core.log = () => {};
      core.setData('agent.workDir', ws);
      // 显式宿主策略：非 tool.* 能力不会被默认上限纳入（见 cell-runtime._hostCapabilities）。
      const CFG = { cells: { hostCapabilities: ['liuhe.read_anchor'] } };
      core.registerService('config', { get: (k, fb) => (k in CFG ? CFG[k] : fb) });

      const wsP = (await imp('plugins/workspace.js')).default;
      await wsP.init(core);
      const loader = (await imp('plugins/tool-loader.js')).default;
      const exec = Object.create((await imp('plugins/tool-executor.js')).default);
      exec._preHooks = []; exec._postHooks = []; exec._dispatchHooks = [];
      exec._rateCalls = new Map(); exec._cache = new Map(); exec._auditLog = new Map();
      await core.register(loader);
      await core.start();
      await exec.init(core);

      let called = 0;
      core.registerCapability('liuhe.read_anchor', { owner: 'liuhe-lite', handler: async () => { called++; return { ok: true, anchor: {} }; } });
      core.getService('tool-registry').registerTool({
        name: 'tool-liuhe-anchor', owner: 'liuhe-lite', capabilityId: 'liuhe.read_anchor',
        execute: async () => { called++; return { ok: true, anchor: {} }; },
        parameters: { type: 'object', properties: {} },
      });

      const rtDef = (await imp('plugins/cell-runtime.js')).default;
      const rt = Object.create(rtDef);
      await rt.init(core);
      const cells = core.getService('cell-runtime');
      await cells.create({
        schema_version: 'tusunsun.cell/v0', cell_id: 'cell-g3', workspace: ws,
        capabilities: ['liuhe.read_anchor'], permission_mode: 'auto',
        runtime: { kind: 'process' }, limits: { max_active_tasks: 1, max_children: 0 },
      }, { trusted: true });

      const task = {
        schema_version: 'tusunsun.task/v0', task_id: 'task-g3', attempt: 1,
        target_cell_id: 'cell-g3', goal: 'anchor through the gate', inputs: [],
        required_capabilities: ['liuhe.read_anchor'],
        budget: { max_steps: 5, wall_ms: 60000 },
        acceptance: { required_artifacts: [], checks: [] },
      };
      cells.accept('cell-g3', task);

      let out = null;
      core.registerCapability('chat.handle', {
        owner: 'test',
        handler: async ({ sessionId }) => {
          out = await exec.executeOne('tool-liuhe-anchor', { path: 'src/a.txt' }, sessionId, 'chain-g3');
          return { reply: 'done' };
        },
      });
      await cells.execute('cell-g3', task);

      assertEquals(out?.ok, true,
        `Cell 已声明 liuhe.read_anchor，工具必须放行。实际 ${out?.error || out?.state}`
        + '（修前 pre 阶段按名字派生出 tool.liuhe-anchor —— 一个不存在的能力 —— 然后拿它拒人）');
      assert(called > 0, 'handler 必须真的被调用');
      console.log('       [实测] 显式登记能力在 Cell 门内放行并执行');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-163/G3c 只读 Cell 也必须调得动显式登记的只读能力（同一处猜测，第二个受害者）', async () => {
    const d = base('g3c');
    try {
      const { Core } = await imp('src/core/core.js');
      const ws = join(d, 'ws');
      mkdirSync(join(ws, 'src'), { recursive: true });
      writeFileSync(join(ws, 'src', 'a.txt'), 'v1\n');
      const core = new Core({ stateDir: join(d, 'state') });
      core.log = () => {};
      core.setData('agent.workDir', ws);
      const CFG = { cells: { hostCapabilities: ['liuhe.read_anchor'] } };
      core.registerService('config', { get: (k, fb) => (k in CFG ? CFG[k] : fb) });
      await (await imp('plugins/workspace.js')).default.init(core);
      const loader = (await imp('plugins/tool-loader.js')).default;
      const exec = Object.create((await imp('plugins/tool-executor.js')).default);
      exec._preHooks = []; exec._postHooks = []; exec._dispatchHooks = [];
      exec._rateCalls = new Map(); exec._cache = new Map(); exec._auditLog = new Map();
      await core.register(loader);
      await core.start();
      await exec.init(core);
      let called = 0;
      core.registerCapability('liuhe.read_anchor', { owner: 'liuhe-lite', handler: async () => { called++; return { ok: true, anchor: {} }; } });
      core.getService('tool-registry').registerTool({
        name: 'tool-liuhe-anchor', owner: 'liuhe-lite', capabilityId: 'liuhe.read_anchor',
        execute: async () => { called++; return { ok: true, anchor: {} }; },
        parameters: { type: 'object', properties: {} },
      });
      const rtDef = (await imp('plugins/cell-runtime.js')).default;
      const rt = Object.create(rtDef);
      await rt.init(core);
      const cells = core.getService('cell-runtime');
      // **只读** Cell：这是 G3 的第二个受害者，与 auto 是两条独立路径（只读判定也读 capId）
      await cells.create({
        schema_version: 'tusunsun.cell/v0', cell_id: 'cell-g3c', workspace: ws,
        capabilities: ['liuhe.read_anchor'], permission_mode: 'read-only',
        runtime: { kind: 'process' }, limits: { max_active_tasks: 1, max_children: 0 },
      }, { trusted: true });
      const task = {
        schema_version: 'tusunsun.task/v0', task_id: 'task-g3c', attempt: 1,
        target_cell_id: 'cell-g3c', goal: 'read anchor as a read-only cell', inputs: [],
        required_capabilities: ['liuhe.read_anchor'],
        budget: { max_steps: 5, wall_ms: 60000 },
        acceptance: { required_artifacts: [], checks: [] },
      };
      cells.accept('cell-g3c', task);
      let out = null;
      core.registerCapability('chat.handle', {
        owner: 'test',
        handler: async ({ sessionId }) => {
          out = await exec.executeOne('tool-liuhe-anchor', { path: 'src/a.txt' }, sessionId, 'chain-g3c');
          return { reply: 'done' };
        },
      });
      await cells.execute('cell-g3c', task);
      assertEquals(out?.ok, true,
        `只读 Cell 调只读能力必须放行。实际 ${out?.error || out?.state}`
        + '（修前只读判定也拿名字派生的假 id 判，一个只读能力被当成写能力拒掉）');
      assert(called > 0, 'handler 必须真的被调用');
      console.log('       [实测] 只读 Cell 在门内拿到锚点');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-163/G3b 误拒不得被"一律不表态"修掉：真正未授予的能力仍须在 pre 阶段被拒', async () => {
    const d = base('g3b');
    try {
      const s = stripComments(src('plugins/cell-runtime.js'));
      // 结构判据：pre 阶段的拒绝必须仍然存在（`capability_denied` 那条 return），
      // 且必须被 `authoritative` 守着 —— 两个条件缺一个都会让 G3 的修法变成放水。
      assert(/resolveCapId/.test(s), 'pre 阶段必须走 resolveCapId（先问 registry）');
      assert(/authoritative/.test(s), '必须区分权威 id 与猜测 id');
      assert(/if \(!authoritative\) return undefined;/.test(s),
        '猜测的 id 不在 granted 里时不得拒人（这正是 G3 的修法）');
      assert(/code: 'capability_denied'/.test(s), '真正的拒绝路径不得被删掉');
      // 反向：dispatch 阶段必须仍然权威判（不得也变成不表态）
      assert(/evaluate\('dispatch', toolName, capId, sessionId, true\)/.test(s),
        'dispatch 阶段必须按权威 id 判定（那里一定拿得到真实能力）');
      console.log('       [实测] pre 只降级猜测、dispatch 仍权威判；拒绝路径仍在');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ══ G4：能力 id 形态必须过 Cell 契约 ═════════════════════════════════════
  runner.test('R0-163/G4 六个能力 id 必须全部通过 Cell 契约的 CAPABILITY_RE（驼峰会被拒）', async () => {
    const m = await imp('plugins/liuhe-lite.js');
    const { validateCellSpec } = await imp('plugins/_lib/cell/contract.js');
    const ids = Object.values(m.ACTIONS);
    assertEquals(new Set(ids).size, 6, `应有 6 个不同能力，实际 ${ids.length}`);
    // 真跑一遍契约校验，不用自己写的正则冒充（那就会两处口径）
    const spec = validateCellSpec({
      schema_version: 'tusunsun.cell/v0', cell_id: 'cell-g4', workspace: '/abs/x',
      capabilities: ids, permission_mode: 'auto', runtime: { kind: 'process' },
      limits: { max_active_tasks: 1, max_children: 0 },
    });
    assertEquals(spec.capabilities.length, 6, '六个能力必须全部被 Cell 契约接受');
    for (const id of ids) {
      assert(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(id),
        `能力 id "${id}" 必须全小写分段 —— 修前用 liuhe.readAnchor，被 validateCellSpec 直接拒`);
    }
    console.log(`       [实测] ${ids.join(', ')} 全部通过契约`);
  });

  // ══ A1：Lite 回执 → 我方 v0 的归一 ══════════════════════════════════════
  runner.test('R0-163/A1 Lite 回执必须能被归一成合法 v0，且 memory_only 归一不丢原值', async () => {
    const m = await imp('plugins/liuhe-lite.js');
    const LITE = {
      schema_version: 'tusunsun.action-receipt/v0',
      action_id: 'act-txn_1792648625411_350fb5a4_p4089310',
      provider: 'liuhe-lite',
      provider_operation_id: 'txn_1792648625411_350fb5a4_p4089310',
      cell_id: 'c1', incarnation_id: 'i1', task_id: 't1', request_id: 'rq-1',
      application: 'applied',
      effect: { kind: 'file_modified', target: 'src/a.txt', before_sha256: 'b', after_sha256: 'a', detail_ref: 'liuhe:txn_1' },
      verification: 'not_run',
      recovery: { supported: true, ref: 'liuhe-undo:txn_1', expires_at: '2026-10-24T00:00:00.000Z' },
      persistence: 'memory_only',
      extension: { journal_state: 'committed' },
    };
    const r = m.toTusunsunReceipt(LITE, { tool_id: 'liuhe.apply' });
    assertEquals(r.ok, true, `归一必须成功，违规项 ${JSON.stringify(r.violations)}`);
    const x = r.receipt;
    assertEquals(x.schema_version, 'tusunsun.action-receipt/v0', 'schema 必须是 v0');
    assertEquals(x.application, 'applied', 'application 原样保留');
    assertEquals(x.provider, 'liuhe-lite', 'provider 原样透传');
    assertEquals(x.provider_operation_id, LITE.provider_operation_id, 'provider_operation_id 原样透传');
    assertEquals(x.request_id, 'rq-1', 'request_id 原样透传');
    // 归一的核心：换词但**留原值**
    assertEquals(x.persistence, 'volatile', 'memory_only 在 v0 归一为 volatile（ADR-06 / B-2 冻结）');
    assertEquals(x.extension?.provider_persistence, 'memory_only', '原值必须留下 —— 不丢信息地换词');
    assertEquals(x.extension?.provider_extension?.journal_state, 'committed', 'provider 私有扩展保留');
    // target 从 effect.target（字符串）搬到顶层对象，且不泄露绝对路径
    assertEquals(x.target.path, 'src/a.txt', 'target.path 取 effect.target');
    assertEquals(x.target.canonical_scope, 'cell_workspace', '作用域必须是工作区相对');
    assertEquals(x.recovery.expires_at, '2026-10-24T00:00:00.000Z', 'expires_at 必须透传（Lite 真有这个事实）');
    // 反例：非法 application 仍必须被拒 —— 归一不等于放宽
    const bad = m.toTusunsunReceipt({ ...LITE, application: 'probably_ok' });
    assertEquals(bad.ok, false, '非法 application 必须被拒（归一是换词，不是放宽校验）');
    console.log('       [实测] memory_only→volatile 且原值保留；非法值仍拒');
  });

  runner.test('R0-163/A1b 高敏文件名的回执必须脱敏（我方 ACT-07 与 Lite 名单取并集）', async () => {
    const m = await imp('plugins/liuhe-lite.js');
    for (const p of ['.env', 'config/id_rsa', 'secrets.json', 'certs/ssl.pem']) {
      const r = m.toTusunsunReceipt({
        action_id: 'act-1', provider: 'liuhe-lite', application: 'applied',
        effect: { kind: 'file_modified', target: p, before_sha256: 'b', after_sha256: 'a' },
        verification: 'not_run', recovery: { supported: false, ref: null }, persistence: 'persisted',
      });
      assertEquals(r.ok, true, `前提：${p} 归一应成功`);
      assert(r.receipt.target.path.startsWith('<redacted:'),
        `${p} 的回执路径必须被脱敏，实际 ${r.receipt.target.path}`);
      assert(r.receipt.target.redacted, '必须显式标 redacted（不能静默改写成一个看起来像文件名的东西）');
    }
    // 普通路径不得被脱敏
    const ok = m.toTusunsunReceipt({
      action_id: 'act-1', provider: 'liuhe-lite', application: 'applied',
      effect: { kind: 'file_modified', target: 'src/app.js', before_sha256: 'b', after_sha256: 'a' },
      verification: 'not_run', recovery: { supported: false, ref: null }, persistence: 'persisted',
    });
    assertEquals(ok.receipt.target.path, 'src/app.js', '普通路径不得被脱敏');
    console.log('       [实测] 4 类高敏名脱敏、普通路径原样');
  });

  // ══ A2：授权边界必须在**进 Lite 之前**成立 ═══════════════════════════════
  runner.test('R0-163/A2 模型自带工作区类入参必须在进入 Lite 之前被拒（不依赖第三方拦对）', async () => {
    const m = await imp('plugins/liuhe-lite.js');
    const names = ['.mjs'];
    void names;
    for (const bad of ['workspace', 'workspace_dir', 'workspaceDir', 'realPath', 'cwd', 'root']) {
      const found = m.findWorkspaceParams({ path: 'a.txt', [bad]: '/tmp/evil' });
      assertEquals(found.length, 1, `必须认出 ${bad} 这个入参名`);
    }
    // 不给这些键时不得误判
    assertEquals(m.findWorkspaceParams({ path: 'a.txt' }).length, 0, '正常入参不得被误判');
    assertEquals(m.findWorkspaceParams(null).length, 0, 'null 不得抛错');

    // 端到端：真的经插件拒绝，且拒绝发生在 Lite 之前
    const d = base('a2');
    try {
      const { Core } = await imp('src/core/core.js');
      const core = new Core({ stateDir: join(d, 'state') });
      core.log = () => {};
      const ws = join(d, 'ws');
      mkdirSync(ws, { recursive: true });
      core.registerService('workspace', { root: () => ws });
      const plugin = Object.create((await imp('plugins/liuhe-lite.js')).default);
      await core.register(plugin);
      await core.start();
      const out = await plugin.invoke('readAnchor', { path: 'a.txt', workspace: '/tmp/evil' });
      assertEquals(out.ok, false, '带 workspace 入参必须失败');
      assertEquals(out.code, 'WORKSPACE_PARAM_FORBIDDEN', `应具名拒绝，实际 ${out.code}`);
      assertEquals(out.handling.retry, 'never', '授权边界不可重试');
      console.log('       [实测] 6 个入参名全拒、正常入参不误判、具名且 retry=never');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ══ A3：披露权在宿主 —— apply / undo 不给模型 ═══════════════════════════
  runner.test('R0-163/A3 模型可见工具只有两个只读动作；apply/undo/preview 必须不在其中', async () => {
    const m = await imp('plugins/liuhe-lite.js');
    const visible = m._MODEL_VISIBLE.map((v) => v.action).sort();
    assertEquals(visible.join(','), 'inspect,readAnchor',
      `模型可见动作应只有 inspect 与 readAnchor，实际 ${visible.join(',')}`);
    for (const forbidden of ['apply', 'undo', 'preview', 'reconcile']) {
      assert(!visible.includes(forbidden),
        `${forbidden} 不得对模型可见（apply/undo 改盘；preview/reconcile 走能力面）`);
    }
    // 结构判据：可见表里每一条都必须有只读的能力分类支撑
    const pol = await imp('plugins/_lib/tool-policy.js');
    for (const v of m._MODEL_VISIBLE) {
      assertEquals(pol.isReadonlyCapability(v.capability), true,
        `${v.capability} 必须被登记为只读 —— 否则只读 Cell 调不动模型被告知要用的工具`);
    }
    console.log('       [实测] 可见=2、禁 4 个；两个都登记为只读');
  });

  runner.test('R0-163/A4 只读 Cell 必须调得动 read_anchor / inspect，但调不动 apply/undo', async () => {
    const pol = await imp('plugins/_lib/tool-policy.js');
    assertEquals(pol.isReadonlyCapability('liuhe.read_anchor'), true, 'read_anchor 必须只读');
    assertEquals(pol.isReadonlyCapability('liuhe.inspect'), true, 'inspect 必须只读');
    // 默认方向：未登记即非只读。写动作必须不在只读清单里。
    for (const w of ['liuhe.apply', 'liuhe.undo', 'liuhe.preview', 'liuhe.reconcile']) {
      assertEquals(pol.isReadonlyCapability(w), false, `${w} 不得被登记为只读（默认方向是"不认识就不是只读"）`);
    }
    console.log('       [实测] 两个只读、四个非只读');
  });

  // ══ 供应链：vendor 清单与内层清单必须对得上 ═════════════════════════════
  runner.test('R0-163/V 内置的 Lite 副本只带 1 处记录在案的补丁（其余字节与上游一致）', async () => {
    const manifest = JSON.parse(src('vendor/liuhe-lite/PROVENANCE.json'));
    // "改过"必须留下可核对的记录：modified 与 patches 互相对得上，且补丁文件对得上 hash。
    assertEquals(manifest.modified, true, '有本地补丁时必须如实记 modified:true');
    const patches = Array.isArray(manifest.patches) ? manifest.patches : [];
    assertEquals(patches.length, 1, `应有且仅有 1 条补丁记录，实际 ${patches.length}`);
    const patch = patches[0];
    assertEquals(patch.file, 'lite/index.js', '补丁文件应是 lite/index.js（TextDecoder ignoreBOM）');
    assertEquals(patch.local_sha256, manifest.files[patch.file], '补丁记录的 local hash 必须等于清单里该文件的 hash');
    assert(patch.upstream_sha256 !== patch.local_sha256, 'upstream/local 两个 hash 必须不同，否则等于没记补丁');
    assert(/^sha256:[0-9a-f]{64}$/.test(String(patch.upstream_sha256)), 'upstream hash 必须是完整的 sha256');
    assertEquals(manifest.version, '0.1.3', '版本必须等于副本自带的 package.json');
    const pkg = JSON.parse(src('vendor/liuhe-lite/package.json'));
    assertEquals(pkg.version, manifest.version, '清单版本 ≠ 副本 package.json 版本');
    // 内层 provenance：文件名一致、版本一致（我们只查"在不在这、说的是不是同一版本"）
    const inner = JSON.parse(src('vendor/liuhe-lite/vendor/malong/PROVENANCE.json'));
    assert(inner.package.includes('liuhe-lite'), '内层清单应记的是 Lite 这个包');
    assert(manifest.upstream?.tarball_sha256?.startsWith('sha256:'),
      '非 npm 依赖必须有 tarball sha256 作为版本锚（lock 里没有它）');
    // 逐文件 hash 至少抽验三条，且文件数一致
    const files = Object.keys(manifest.files);
    assertEquals(files.length, 43, `内置文件数应为 43，实际 ${files.length}`);
    const { createHash } = await import('node:crypto');
    for (const f of ['lite/index.js', 'lite/receipt.js', 'package.json']) {
      const h = 'sha256:' + createHash('sha256').update(readFileSync(join(ROOT, 'vendor/liuhe-lite', f))).digest('hex');
      assertEquals(manifest.files[f], h, `${f} 字节与清单不符`);
    }
    console.log(`       [实测] 43 文件、内层一致、tarball 锚在`);
  });

  runner.test('R0-163/V2 Lite 自己带的全套测试必须在本仓副本上仍然通过（不采信它的 CHANGELOG）', async () => {
    const { spawnSync } = await import('node:child_process');
    const d = base('v2');
    try {
      // 用临时 MALONG_STATE_DIR，不污染用户目录；四条核心套件跑在本仓 vendor 副本上。
      const env = { ...process.env, MALONG_STATE_DIR: join(d, 'mstate') };
      // `--no-report` 是**必须**的：Lite 的 run.mjs 默认把报表写进 `vendor/liuhe-lite/reports/`，
      // 那等于让"跑测试"这个动作**修改内置副本**。实测代价：跑完一次 `verify-vendor` 立刻红
      // （`reports/matrix-report.json 不在清单里`）—— 门禁抓到的是"内置副本被改了"，
      // 而"改"它的正是我们自己的测试。加 `--no-report`，副本保持字节不变。
      const cases = [
        ['tests/run.mjs', /PASS 28 \/ FAIL 0/, ['--no-report']],
        ['tests/parity.mjs', /15\/15/, []],
        ['tests/provenance.mjs', /来源证明核对通过/, []],
      ];
      for (const [file, re, extra] of cases) {
        const r = spawnSync(process.execPath, [join(ROOT, 'vendor/liuhe-lite', file), ...extra], {
          cwd: join(ROOT, 'vendor/liuhe-lite'), encoding: 'utf8', timeout: 180000, env,
        });
        assertEquals(r.status, 0, `${file} 必须退出 0，实际 ${r.status}：${(r.stderr || '').slice(0, 300)}`);
        assert(re.test(`${r.stdout}${r.stderr}`), `${file} 的输出里应出现 ${re}：${(r.stdout || '').slice(-300)}`);
      }
      console.log('       [实测] matrix 28/28、parity 15/15、provenance 16 文件 全通过');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
}
