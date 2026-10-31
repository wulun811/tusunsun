// R0-129：v0.9.21「执行真值收口」—— 专家独立复审四项反例的固化回归。
//
// 为什么单独成文件：v0.9.20 修的是"字段存在但执行期零读者"，这一轮修的是**同一形状的第二层**：
// 执行资格的判据挂在了 `rec.activeTask` 上，而 close/超时正好会清空它 ——
// 于是"已经结束的执行"反而在那之后获得最宽松的权限。四条反例互相独立，但共用一个根因：
// **一个 Cell 的执行身份没有覆盖整个异步工作生命周期**。
//
// 编号沿用专家建议的 R0-129/T01–T10。
// 形态：进程内直测（真 Core + 真 workspace + 真 tool-executor + 真 tool-write 语义），不联网。
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync, renameSync } from 'node:fs';
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
  cell_id: 'cell-r129',
  workspace: '/abs/projects/repo',
  capabilities: ['tool.read', 'tool.write'],
  permission_mode: 'auto',
  runtime: { kind: 'process' },
  limits: { max_active_tasks: 1, max_children: 0 },
  ...over,
});

const taskOf = (over = {}) => ({
  schema_version: 'tusunsun.task/v0',
  task_id: 'task-r129-1',
  attempt: 1,
  target_cell_id: 'cell-r129',
  goal: 'do the thing',
  inputs: [],
  required_capabilities: ['tool.read'],
  budget: { max_steps: 10, wall_ms: 60000 },
  acceptance: { required_artifacts: [], checks: [] },
  ...over,
});

/**
 * 真实执行链宿主：真 Core + workspace + 真 tool-executor。
 * `toolCalls` 里的工具会真的经 executeOne 走完整 pre-hook 链（这是反例可观测的必要条件）。
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
    handler: async ({ sessionId }) => {
      const outs = [];
      for (const name of toolCalls) {
        const r = await exec.executeOne(name, { path: 'out.txt', content: 'x' }, sessionId, 'chain');
        outs.push({ name, status: r.status || 'ok', error: r.error || null });
      }
      if (onChat) await onChat({ sessionId, core, exec, ws });
      return { reply: JSON.stringify(outs) };
    },
  });

  const rtDef = (await imp('plugins/cell-runtime.js')).default;
  const rt = Object.create(rtDef);
  await rt.init(core);
  return { core, ws, exec, svc: core.getService('cell-runtime'), mode };
}

export async function setup(runner) {
  const base = () => mkdtempSync(join(tmpdir(), 'r129-'));

  // ══ T01/T02：close(force) 之后迟到的工具调用必须被拒，且不得落到宿主默认根 ══
  runner.test('R0-129/T01 close(force) 之后迟到的工具调用必须 fail-closed（执行日志不得宣称成功）', async () => {
    const d = base();
    try {
      let release; let late = null;
      const gate = new Promise((r) => { release = r; });
      const h = await makeHost({
        base: d, id: 'A',
        onChat: async ({ exec, sessionId }) => {
          await gate;   // 模拟"对话还挂着"，外部放行后才发迟到调用
          const r = await exec.executeOne('tool-write', { path: 'late.txt', content: 'x' }, sessionId, 'chain');
          late = { status: r.status, error: r.error || '' };
          return { reply: 'late' };
        },
      });
      // 只授予 tool.read + read-only：迟到写入无论按哪条判据都该被拒
      await h.svc.create(specOf({ workspace: h.ws, capabilities: ['tool.read'], permission_mode: 'read-only' }), { trusted: true });
      const t = taskOf();
      h.svc.accept('cell-r129', t);
      const running = h.svc.execute('cell-r129', t);
      await new Promise((r) => setTimeout(r, 60));
      const closed = await h.svc.close('cell-r129', { force: true });
      assertEquals(closed.to, 'stopped');
      release();
      const res = await running;

      assertEquals(late?.status, 'blocked', `迟到的工具调用必须被拒，实际 status=${late?.status}`);
      assert(/execution_revoked/.test(late?.error || ''), `必须给出具名理由 execution_revoked，实际 ${late?.error}`);
      assertEquals(existsSync(join(h.ws, 'late.txt')), false,
        '被拒的写入不得落盘 —— 修前它写出了文件且 execution_state=succeeded');
      // T01 约束②：执行日志不得宣称这段迟到运行已成功提交
      assert(res.execution_state !== 'succeeded',
        `被撤销的执行不得报 succeeded，实际 ${res.execution_state}`);
      assertEquals(res.execution_state, 'unknown', '副作用无法划界 ⇒ 如实报 unknown（合同里为此保留的状态）');
      console.log(`       [实测] close(force) 后迟到调用 → blocked/execution_revoked；无落盘；结果标 ${res.execution_state}`);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-129/T02 close(force) 后迟到工具不得被解析到宿主默认根（工作区绑定不提前释放）', async () => {
    const d = base();
    try {
      let release; let late = null;
      const gate = new Promise((r) => { release = r; });
      const h = await makeHost({
        base: d, id: 'A',
        onChat: async ({ exec, sessionId }) => { await gate; late = await exec.executeOne('tool-write', { path: 'late.txt', content: 'x' }, sessionId, 'chain'); },
      });
      await h.svc.create(specOf({ workspace: h.ws }), { trusted: true });
      const t = taskOf();
      h.svc.accept('cell-r129', t);
      const running = h.svc.execute('cell-r129', t);
      await new Promise((r) => setTimeout(r, 60));
      const closed = await h.svc.close('cell-r129', { force: true });
      // 旧链没停 ⇒ 不能声称已释放绑定（否则迟到调用会回落到进程默认根）
      assertEquals(closed.quiesced, false, '旧链未停时必须如实回报 quiesced=false');
      assertEquals(closed.workspace_released, false, '未静默前不得释放工作区绑定');
      assertEquals(h.core.getService('workspace').status(`cell-cell-r129`), 'bound',
        '仍有在飞链时绑定必须保持 bound');
      release();
      await running;
      assertEquals(late?.status, 'blocked');
      // 绑定最终仍会被释放（不是永久泄漏），但要等到静默之后
      await new Promise((r) => setTimeout(r, 80));
      assertEquals(existsSync(join(process.cwd(), 'late.txt')), false, '任何情况下都不得写到进程默认目录');
      console.log('       [实测] 未静默 → quiesced=false / 绑定保持 bound；迟到调用被拒，无默认根回落');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ══ T03/T04：墙钟超时后旧链不得继续产生副作用；未停下不得开新任务 ══
  runner.test('R0-129/T03 墙钟超时后旧异步链的工具调用必须被具名拒绝（不得继续写盘）', async () => {
    const d = base();
    try {
      let release; let late = null;
      const gate = new Promise((r) => { release = r; });
      const h = await makeHost({
        base: d, id: 'A',
        onChat: async ({ exec, sessionId }) => {
          await gate;
          const r = await exec.executeOne('tool-write', { path: 'late.txt', content: 'x' }, sessionId, 'chain');
          late = { status: r.status, error: r.error || '' };
        },
      });
      // 只读 + 只授予 read：即便撤销判据失效，permission_mode 也不该放行写
      await h.svc.create(specOf({ workspace: h.ws, capabilities: ['tool.read'], permission_mode: 'read-only' }), { trusted: true });
      const t = taskOf({ budget: { max_steps: 10, wall_ms: 120 } });
      h.svc.accept('cell-r129', t);
      const res = await h.svc.execute('cell-r129', t);
      assertEquals(res.execution_state, 'timed_out');
      assert(/NOT rolled back/.test(res.error || ''), '必须如实说明副作用未回滚');
      release();
      await new Promise((r) => setTimeout(r, 150));
      assertEquals(late?.status, 'blocked', `超时后迟到的工具调用必须被拒，实际 ${late?.status}`);
      assert(/execution_revoked/.test(late?.error || ''), `必须是 execution_revoked，实际 ${late?.error}`);
      assertEquals(existsSync(join(h.ws, 'late.txt')), false, '超时后不得再有新副作用落盘');
      console.log('       [实测] 超时 → 撤销执行资格；迟到 tool-write → blocked/execution_revoked，无落盘');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-129/T03b 超时后旧链未停时不得开新任务；静默后必须回到 ready（不能永久钉死）', async () => {
    const d = base();
    try {
      let release;
      const gate = new Promise((r) => { release = r; });
      const h = await makeHost({
        base: d, id: 'A',
        onChat: async () => { await gate; return { reply: 'late' }; },
      });
      await h.svc.create(specOf({ workspace: h.ws }), { trusted: true });
      const t = taskOf({ budget: { max_steps: 10, wall_ms: 100 } });
      h.svc.accept('cell-r129', t);
      const res = await h.svc.execute('cell-r129', t);
      assertEquals(res.execution_state, 'timed_out');
      assertEquals(h.svc.describe('cell-r129').state, 'draining',
        '旧链未停 → 必须是 draining（修前直接回 ready，两个任务可并存）');
      const second = await codeOf(() => {
        h.svc.accept('cell-r129', taskOf({ task_id: 'task-second' }));
        return true;
      });
      assertEquals(second.ok, false, 'draining 期间 accept 必须被拒');
      assertEquals(second.code, 'cell_not_ready');
      release();
      // 等旧链 settle → 自动回 ready
      await new Promise((r) => setTimeout(r, 200));
      assertEquals(h.svc.describe('cell-r129').state, 'ready',
        '旧链静默后必须回到 ready —— 安全不能以"Cell 永久不可用"为代价');
      console.log('       [实测] 超时 → draining 且拒接新任务；旧链 settle → 自动回 ready');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ══ T04：撤销不得误伤其它会话 / 正常 Cell ════════════════════════════
  runner.test('R0-129/T04 撤销保护不得误拦普通会话与正常 Cell 的合法工具调用', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d, id: 'A', toolCalls: ['tool-write'] });
      await h.svc.create(specOf({ workspace: h.ws, capabilities: ['tool.read', 'tool.write'] }), { trusted: true });
      const t = taskOf({ required_capabilities: ['tool.write'], acceptance: { required_artifacts: ['out.txt'], checks: [] } });
      h.svc.accept('cell-r129', t);
      const r = await h.svc.execute('cell-r129', t);
      assertEquals(r.execution_state, 'succeeded', `正常 Cell 必须照常执行，实际 ${r.execution_state}`);
      assertEquals(existsSync(join(h.ws, 'out.txt')), true, '已授予的写入必须真的落盘');

      // 另一个"普通会话"（不属于任何 Cell）在同一执行器上不得受影响
      const other = await h.exec.executeOne('tool-write', { path: 'plain.txt', content: 'y' }, 'rest_api', 'chain');
      assertEquals(other.status || 'ok', 'ok', '普通会话的工具调用不得被 Cell 的撤销判据拦下');
      assertEquals(existsSync(join(h.ws, 'plain.txt')), true, '普通会话的写入必须真的落盘');
      console.log('       [实测] 正常 Cell 仍 succeeded 并落盘；无关会话（rest_api）不受影响');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ══ T05：同一 Cell ID 跨进程重启不得静默换工作区 ══════════════════════
  runner.test('R0-129/T05 同一 Cell ID 在同一 stateDir 上换工作区必须具名拒绝，且旧状态不改', async () => {
    const d = base();
    try {
      const A = join(d, 'wsA'); const B = join(d, 'wsB');
      mkdirSync(A); mkdirSync(B);
      const stateDir = join(d, 'state-shared');
      const mk = async () => {
        const { Core } = await imp('src/core/core.js');
        const core = new Core({ stateDir });
        core.log = () => {};
        core.setData('agent.workDir', A);
        await (await imp('plugins/workspace.js')).default.init(core);
        const rtDef = (await imp('plugins/cell-runtime.js')).default;
        const rt = Object.create(rtDef);
        await rt.init(core);
        return { core, svc: core.getService('cell-runtime') };
      };
      // 第一"进程"
      const p1 = await mk();
      const st1 = await p1.svc.create(specOf({ cell_id: 'same-identity', workspace: A }), { trusted: true });
      assertEquals(st1.workspace_realpath, A);
      // 第一"进程"退出：属主锁随之释放。**这一步是重启语义的一部分**（rc.33 / R32-01）：
      // 同进程换一个 Core 就是换一个属主，旧 Core 还活着时新 Core 会得到 `state_dir_owned`
      // —— 那是另一条不变式（同一 stateDir 只能有一个活属主），不是本条的判据。
      await p1.svc.close('same-identity', {});
      // 第二"进程"：同 stateDir、同 cell ID、**不同**工作区
      const p2 = await mk();
      const conflict = await codeOf(() => p2.svc.create(specOf({ cell_id: 'same-identity', workspace: B }), { trusted: true }));
      assertEquals(conflict.ok, false, '同 ID 换目录必须拒绝（修前它直接成功并把工作区报成 B）');
      assertEquals(conflict.code, 'cell_identity_conflict', `必须是 cell_identity_conflict，实际 ${conflict.code}`);
      // 旧状态未被改写：磁盘上记录的仍是 A
      const persisted = JSON.parse(await (await import('node:fs/promises')).readFile(
        join(stateDir, 'cells', 'same-identity', 'cell.json'), 'utf8'));
      assertEquals(persisted.workspace_realpath, A, '被拒绝的创建不得覆盖已落盘的工作区真值');
      // 同目录重建必须仍然允许（重启是常态，不是错误）
      const p3 = await mk();
      const again = await p3.svc.create(specOf({ cell_id: 'same-identity', workspace: A }), { trusted: true });
      assertEquals(again.workspace_realpath, A, '同目录重启必须继续可用');
      console.log('       [实测] 换目录 → cell_identity_conflict 且旧状态未改；同目录重启 → 正常');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ══ T06：一个 Core 只承载一个 Cell（service 与 WS 两条路径） ═══════════
  runner.test('R0-129/T06 同一 Core 的第二个 Cell 必须拒绝（service 与网关 WS 两条路径）', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d, id: 'A' });
      await h.svc.create(specOf({ cell_id: 'cell-1', workspace: h.ws }), { trusted: true });
      const dup = await codeOf(() => h.svc.create(specOf({ cell_id: 'cell-2', workspace: h.ws }), { trusted: true }));
      assertEquals(dup.ok, false, '第二个 Cell 必须被拒（v0 约束是 1 Cell : 1 Core : 1 OS process）');
      assertEquals(dup.code, 'cell_quota_exceeded', `必须是 cell_quota_exceeded，实际 ${dup.code}`);
      assertEquals(h.svc.list().length, 1, 'list() 必须仍然只有一个 Cell');

      // 同 id 重复仍是 cell_id_conflict（两条拒绝理由不能混成一个）
      const same = await codeOf(() => h.svc.create(specOf({ cell_id: 'cell-1', workspace: h.ws }), { trusted: true }));
      assertEquals(same.code, 'cell_id_conflict');

      // 网关 WS 路径：`cell.create` 走的是同一个 service 方法，因此行为必须一致
      const gwSrc = await (await import('node:fs/promises')).readFile(join(ROOT, 'plugins/gateway.js'), 'utf8');
      assert(/cell\.create[\s\S]{0,200}cr\.create/.test(gwSrc),
        '网关必须把 cell.create 转给 cell-runtime（配额判定只有一份实现，不在网关复制）');
      console.log('       [实测] service 第二条 create → cell_quota_exceeded；同 id → cell_id_conflict；网关共用同一实现');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ══ T07/T08：产物真实路径（末级 + 中间符号链接） ══════════════════════
  runner.test('R0-129/T07 产物是指向工作区外的符号链接时必须拒绝（不得被 hash 进 WorkResult）', async () => {
    const d = base();
    try {
      const outside = join(d, 'external-secret.txt');
      writeFileSync(outside, 'SECRET');
      const h = await makeHost({ base: d, id: 'A' });   // chat.handle 不产生任何产物
      symlinkSync(outside, join(h.ws, 'report.txt'));
      await h.svc.create(specOf({ workspace: h.ws }), { trusted: true });
      const t = taskOf({ acceptance: { required_artifacts: ['report.txt'], checks: [] } });
      h.svc.accept('cell-r129', t);
      const res = await h.svc.execute('cell-r129', t);
      assertEquals(res.artifacts.length, 0, '工作区外文件不得被收录为产物（修前 hash 与外部文件完全一致）');
      assert(res.execution_state !== 'succeeded', `必须如实失败，实际 ${res.execution_state}`);
      const dec = await h.svc.verify('cell-r129', t);
      assert(dec.decision !== 'accepted', `验收不得 accepted，实际 ${dec.decision}`);
      console.log(`       [实测] 末级符号链接 → 产物 0 个、execution=${res.execution_state}、decision=${dec.decision}`);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-129/T08 中间目录是指向工作区外的符号链接同样拒绝；工作区内真实文件必须 accepted', async () => {
    const d = base();
    try {
      const outDir = join(d, 'outside-dir'); mkdirSync(outDir);
      writeFileSync(join(outDir, 'f.txt'), 'SECRET2');
      const h = await makeHost({ base: d, id: 'A' });
      symlinkSync(outDir, join(h.ws, 'sub'));
      await h.svc.create(specOf({ workspace: h.ws }), { trusted: true });
      const t = taskOf({ acceptance: { required_artifacts: ['sub/f.txt'], checks: [] } });
      h.svc.accept('cell-r129', t);
      const res = await h.svc.execute('cell-r129', t);
      assertEquals(res.artifacts.length, 0, '中间目录符号链接逃逸不得被收录');
      const dec = await h.svc.verify('cell-r129', t);
      assert(dec.decision !== 'accepted', `不得 accepted，实际 ${dec.decision}`);

      // 正例：工作区内**真实**文件必须继续通过（否则只是"一律拒绝"）
      const h2 = await makeHost({ base: d, id: 'B' });
      writeFileSync(join(h2.ws, 'real.txt'), 'REAL');
      await h2.svc.create(specOf({ cell_id: 'cell-real', workspace: h2.ws }), { trusted: true });
      const t2 = { ...t, target_cell_id: 'cell-real', acceptance: { required_artifacts: ['real.txt'], checks: [] } };
      h2.svc.accept('cell-real', t2);
      const r2 = await h2.svc.execute('cell-real', t2);
      assertEquals(r2.execution_state, 'succeeded', `工作区内真实文件必须通过，实际 ${r2.execution_state}`);
      assertEquals(r2.artifacts.length, 1);
      const dec2 = await h2.svc.verify('cell-real', t2);
      assertEquals(dec2.decision, 'accepted', `工作区内真实文件必须 accepted，实际 ${dec2.decision}`);
      console.log('       [实测] 中间目录链接 → 拒；工作区内真实文件 → accepted（没有过度拒绝）');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ══ T09：不得留下无记录的半状态 ══════════════════════════════════════
  runner.test('R0-129/T09 早期拒绝与超时都不得把 Cell 留在无记录的半状态', async () => {
    const d = base();
    try {
      // ① 早期拒绝：第二个 Cell 被拒之后，第一个必须完全不受影响
      const h = await makeHost({ base: d, id: 'A' });
      await h.svc.create(specOf({ cell_id: 'cell-1', workspace: h.ws }), { trusted: true });
      await codeOf(() => h.svc.create(specOf({ cell_id: 'cell-2', workspace: h.ws }), { trusted: true }));
      const st = h.svc.describe('cell-1');
      assertEquals(st.state, 'ready', '被拒的第二次 create 不得影响已有 Cell 的状态');
      assertEquals(st.workspace_realpath, h.ws, '已有 Cell 的工作区不得被改动');

      // ② 超时：状态与结果都必须有记录，且能解释自己
      const h2 = await makeHost({ base: d, id: 'B', onChat: async () => { await new Promise((r) => setTimeout(r, 1000)); } });
      await h2.svc.create(specOf({ cell_id: 'cell-slow', workspace: h2.ws }), { trusted: true });
      const t = { ...taskOf(), target_cell_id: 'cell-slow', budget: { max_steps: 10, wall_ms: 80 } };
      h2.svc.accept('cell-slow', t);
      const res = await h2.svc.execute('cell-slow', t);
      assertEquals(res.execution_state, 'timed_out');
      const d2 = h2.svc.describe('cell-slow');
      assert(['draining', 'ready'].includes(d2.state), `超时后状态必须可解释，实际 ${d2.state}`);
      // 落盘里也必须能查到这次执行（可审计，不是只在内存里）
      const fs = await import('node:fs/promises');
      const raw = await fs.readFile(join(d, 'state-B', 'cells', 'cell-slow', 'results.jsonl'), 'utf8');
      assert(/timed_out/.test(raw), '超时结果必须落盘（可审计），不能只存在于内存');
      console.log(`       [实测] 早期拒绝不影响已有 Cell；超时结果已落盘、状态=${d2.state}`);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ══ T10：正常能力未被安全修复破坏 ════════════════════════════════════
  runner.test('R0-129/T10 收口之后 create→accept→execute→verify→close 全链路仍然可用', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d, id: 'A', toolCalls: ['tool-write'] });
      const st = await h.svc.create(specOf({ workspace: h.ws, capabilities: ['tool.read', 'tool.write'] }), { trusted: true });
      assertEquals(st.state, 'ready');
      const t = taskOf({ required_capabilities: ['tool.write'], acceptance: { required_artifacts: ['out.txt'], checks: [] } });
      h.svc.accept('cell-r129', t);
      const res = await h.svc.execute('cell-r129', t);
      assertEquals(res.execution_state, 'succeeded');
      assertEquals(res.artifacts.length, 1);
      const dec = await h.svc.verify('cell-r129', t);
      assertEquals(dec.decision, 'accepted');
      const closed = await h.svc.close('cell-r129');
      assertEquals(closed.to, 'stopped');
      assertEquals(closed.quiesced, true, '没有在飞执行时必须立刻静默，不该白等');
      assertEquals(closed.workspace_released, true);
      const after = await codeOf(() => h.svc.accept('cell-r129', t));
      assertEquals(after.code, 'cell_not_ready', '关闭后必须拒接新任务');
      console.log('       [实测] 全链路 succeeded → accepted → stopped（quiesced 立即为真，无额外延迟）');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
}
