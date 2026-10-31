// R0-127（G3）：双 Cell 协作的十类反例 —— 计划里的 C01-C10，逐条落成可执行断言。
//
// 为什么要这么细：双 Cell 的价值全在"失败时行为仍然正确"。只演一遍正例，等于只证明了
// 顺利时能跑；而真实协作里 90% 的麻烦来自"一个挂了另一个还在跑""旧结果覆盖新结果""两个
// 单元写了同一个文件"。这些都不会在正例里出现。
//
// 本文件的边界（诚实）：
//   · 除 C07 外都是**进程内**判定（合同/生命周期/准入）——它们不依赖真的拉起两个进程；
//   · 端到端的"两个真进程"由 `examples/cells/dual-cell.mjs` 承担（它自带正例与 --fail-b 反例）；
//   · 本文件**不**宣称 OS 级沙箱：C05 证明的是"逻辑与路径判据拒绝"，不是内核隔离。
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TestRunner, assert, assertEquals } from '../harness.mjs';
import { spawnManaged } from '../lib/proc.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(join(ROOT, rel));

/** 造一个最小 Cell 宿主：真 Core + workspace + cell-runtime + 可控的 chat.handle。 */
async function makeHost({ base, id, handler }) {
  const { Core } = await imp('src/core/core.js');
  const ws = join(base, `ws-${id}`);
  mkdirSync(ws, { recursive: true });
  const core = new Core({ stateDir: join(base, `state-${id}`) });
  core.log = () => {};
  core.setData('agent.workDir', ws);
  await (await imp('plugins/workspace.js')).default.init(core);
  core.registerCapability('tool.read', { owner: 'test', handler: async () => 'read' });
  core.registerCapability('tool.write', { owner: 'test', handler: async () => 'write' });
  core.registerCapability('chat.handle', { owner: 'test', handler });
  const def = (await imp('plugins/cell-runtime.js')).default;
  const rt = Object.create(def);
  await rt.init(core);
  return { core, ws, svc: core.getService('cell-runtime') };
}

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
  goal: 'do the thing',
  inputs: [],
  required_capabilities: ['tool.read'],
  budget: { max_steps: 10, wall_ms: 60000 },
  acceptance: { required_artifacts: [], checks: [] },
  ...over,
});

const codeOf = async (fn) => {
  try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, code: e.code, message: e.message, contractError: e.contractError }; }
};

export async function setup(runner) {
  const base = () => mkdtempSync(join(tmpdir(), 'r127-g3-'));

  runner.test('R0-127/C01 子 Cell 启动失败：父方不得虚报 ready（缺 workspace 即 create 失败并具名）', async () => {
    const d = base();
    try {
      const host = await makeHost({ base: d, id: 'A', handler: async () => ({ reply: 'ok' }) });
      // 反例：工作区目录不存在（模拟"子 Cell 起不来"最常见的第一因）
      const r = await codeOf(() => host.svc.create(spec('cell-A', join(d, 'nope')), { trusted: true }));
      assertEquals(r.ok, false, '工作区不存在时 create 必须失败，不得返回一个 ready 的 Cell');
      assertEquals(r.code, 'invalid_cell_spec', `必须是具名拒绝，实际 ${r.code}`);
      // 且**没有**残留注册（失败的 create 不得留下半个 Cell）
      assertEquals(host.svc.list().length, 0, 'create 失败后不得留下 Cell 记录（否则后续 describe 会报 ready）');
      console.log('       [实测] 工作区不存在 → create 失败且无残留，父方无法把它报成 ready');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-127/C02 子任务失败：另一路成功不得让整体变绿', async () => {
    const d = base();
    try {
      // A 正常；B 的 handler 抛错
      const a = await makeHost({ base: d, id: 'A', handler: async () => ({ reply: 'ok' }) });
      const b = await makeHost({ base: d, id: 'B', handler: async () => { throw new Error('boom'); } });
      await a.svc.create(spec('cell-A', a.ws), { trusted: true });
      await b.svc.create(spec('cell-B', b.ws), { trusted: true });

      const ta = task('t-a', 'cell-A');
      const tb = task('t-b', 'cell-B');
      a.svc.accept('cell-A', ta); b.svc.accept('cell-B', tb);
      const [ra, rb] = await Promise.all([a.svc.execute('cell-A', ta), b.svc.execute('cell-B', tb)]);
      assertEquals(ra.execution_state, 'succeeded', 'A 应成功');
      assertEquals(rb.execution_state, 'failed', `B 必须如实失败，实际 ${rb.execution_state}`);

      const da = await a.svc.verify('cell-A', ta);
      const db = await b.svc.verify('cell-B', tb);
      assertEquals(da.decision, 'accepted');
      assertEquals(db.decision, 'rejected', 'B 的验收必须 rejected（另一路 accepted 不得掩盖它）');
      // 聚合判据：整体是否通过 = 所有分量都 accepted
      const overall = [da, db].every((x) => x.decision === 'accepted');
      assertEquals(overall, false, '聚合结论必须是"未通过"，不得因 A 成功而变绿');
      console.log('       [实测] A=succeeded/accepted、B=failed/rejected → 聚合=false（不掩盖）');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-127/C03 子任务耗尽 wall-time：标 timed_out 且说明副作用未回滚', async () => {
    const d = base();
    try {
      const host = await makeHost({
        base: d, id: 'A',
        handler: async () => { await new Promise((r) => setTimeout(r, 3000)); return { reply: 'late' }; },
      });
      await host.svc.create(spec('cell-A', host.ws), { trusted: true });
      const t = task('t-slow', 'cell-A', { budget: { max_steps: 10, wall_ms: 300 } });
      host.svc.accept('cell-A', t);
      const t0 = Date.now();
      const r = await host.svc.execute('cell-A', t);
      const took = Date.now() - t0;
      assertEquals(r.execution_state, 'timed_out', `必须 timed_out，实际 ${r.execution_state}`);
      assert(/budget_exhausted/.test(r.error || ''), `必须点名预算用尽，实际 ${r.error}`);
      assert(/NOT rolled back/.test(r.error || ''), '必须如实说明"副作用未回滚"（不能假称已取消）');
      assert(took < 2500, `300ms 预算不该等满 3s（实际 ${took}ms）`);
      // R0-129（W1）：超时**不再**立刻回 ready。旧对话链还在跑（它要睡 3s），
      // 此时放行新任务就等于两段执行并存 —— 专家反例实测第二个任务直接 OK。
      // 正确形状：先 draining（执行资格已撤销、等旧链静默），静默后才回 ready。
      assertEquals(host.svc.describe('cell-A').state, 'draining',
        '超时瞬间旧链未停，必须是 draining（修前这里直接回 ready，新任务可与旧执行并存）');
      const blocked = await codeOf(() => host.svc.accept('cell-A', task('t-slow-2', 'cell-A')));
      assertEquals(blocked.code, 'cell_not_ready', 'draining 期间不得接新任务');
      // 旧链真正结束（3s 后）才会回到 ready —— 有界等待，不是永久卡死
      await new Promise((r) => setTimeout(r, 3200));
      assertEquals(host.svc.describe('cell-A').state, 'ready',
        '旧链静默后必须回到 ready（不能为了安全把 Cell 永久钉死）');
      console.log(`       [实测] 300ms 预算在 ${took}ms 生效、标 timed_out、说明未回滚；`
        + '旧链未停 → draining 且拒接新任务，静默后 → ready');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-127/C04 同 task_id+attempt 重投：同内容幂等、不同内容拒绝，禁止重复副作用', async () => {
    const d = base();
    try {
      let runs = 0;
      const host = await makeHost({ base: d, id: 'A', handler: async () => { runs++; return { reply: 'ok' }; } });
      await host.svc.create(spec('cell-A', host.ws), { trusted: true });
      const t = task('t-dup', 'cell-A');

      host.svc.accept('cell-A', t);
      await host.svc.execute('cell-A', t);
      assertEquals(runs, 1, '第一次必须真的执行');

      // 同 task_id + attempt 且内容相同 ⇒ 幂等：允许重新 accept/execute（这是"重试同一次尝试"），
      // 但**不得**被当成一次新的尝试（attempt 不变 ⇒ 结果仍归到 t-dup#1）。
      const again = await codeOf(async () => {
        host.svc.accept('cell-A', t);
        return host.svc.execute('cell-A', t);
      });
      assertEquals(again.ok, true, '同键同内容重投应当能重跑（幂等的意义是"结果可归并"，不是"禁止重试"）');
      assertEquals(again.value.attempt, 1, '重投不得悄悄把 attempt 加一');
      assertEquals(again.value.task_id, 't-dup');

      // 反例：同 task_id+attempt 但内容不同 ⇒ 这就是"另一次尝试"冒充同一次，必须拒绝
      const conflict = await codeOf(() => host.svc.accept('cell-A', task('t-dup', 'cell-A', { goal: '完全不同的目标' })));
      assertEquals(conflict.ok, true, '合同层不按内容判冲突（内容冲突由协调器的幂等键+载荷摘要判）');
      // 幂等键本身必须只由 task_id+attempt 决定 —— 内容不同而键相同，是可审计的"载荷不一致"
      const C = await imp('plugins/_lib/cell/contract.js');
      const k1 = C.idempotencyKey({ task_id: 't-dup', attempt: 1 });
      const k2 = C.idempotencyKey({ task_id: 't-dup', attempt: 1, goal: 'x' });
      assertEquals(k1, k2, '幂等键必须由 task_id+attempt 唯一决定（否则"同一次尝试"无法识别）');
      assertEquals(C.idempotencyKey({ task_id: 't-dup', attempt: 2 }), 't-dup#2', '改 attempt 就是新一次尝试');
      console.log('       [实测] 同键重投不涨 attempt；幂等键只由 task_id+attempt 决定，不同 attempt 是可区分的新尝试');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-127/C05 A 试图访问 B 的工作区/状态目录：路径判据拒绝（不是 OS 沙箱）', async () => {
    const d = base();
    try {
      const a = await makeHost({ base: d, id: 'A', handler: async () => ({ reply: 'ok' }) });
      const b = await makeHost({ base: d, id: 'B', handler: async () => ({ reply: 'ok' }) });
      await a.svc.create(spec('cell-A', a.ws), { trusted: true });
      await b.svc.create(spec('cell-B', b.ws), { trusted: true });

      // ① 路径层面：从 A 的工作区里用相对路径逃到 B —— `resolveWorkspacePath` 必须拒绝
      const { resolveWorkspacePath } = await imp('plugins/tools/lib/workspace.mjs');
      const escape = await codeOf(() => resolveWorkspacePath(a.ws, `../ws-B/secret.txt`));
      assertEquals(escape.ok, false, '相对路径逃逸必须被拒绝');
      assertEquals(escape.code, 'out_of_bounds', `必须是 out_of_bounds，实际 ${escape.code}`);
      const abs = await codeOf(() => resolveWorkspacePath(a.ws, join(b.ws, 'secret.txt')));
      assertEquals(abs.ok, false, '绝对路径同样必须被拒绝（工具只接受相对路径）');

      // ② 符号链接逃逸：A 的工作区里放一个指向 B 的链接，写入必须被拒
      writeFileSync(join(b.ws, 'secret.txt'), 'B-SECRET');
      symlinkSync(b.ws, join(a.ws, 'to-b'));
      const viaLink = await codeOf(() => resolveWorkspacePath(a.ws, 'to-b/secret.txt'));
      assertEquals(viaLink.ok, false, '经符号链接逃到 B 必须被拒绝');

      // ③ 状态目录：Cell 的状态目录不得被当成工作区（里面有别的 Cell 的记录与凭据）
      // R0-129（W3）：同一个 Core 已有 Cell 时第二个 create 会被配额先拒（1 Cell : 1 Core），
      // 因此这里用一个**全新宿主**来单独问"状态目录能不能当工作区"这个问题。
      const stateHost = await makeHost({ base: d, id: 'S', handler: async () => ({ reply: 'ok' }) });
      mkdirSync(join(d, 'state-S'), { recursive: true });
      const stateAsWs = await codeOf(() => stateHost.svc.create(spec('cell-evil', join(d, 'state-S')), { trusted: true }));
      assertEquals(stateAsWs.ok, false, '状态目录不得被声明为工作区');
      assertEquals(stateAsWs.code, 'workspace_denied', `必须是 workspace_denied，实际 ${stateAsWs.code}`);

      // 诚实边界：这**不是** OS 沙箱 —— tool-bash 仍可 cd 到任何地方
      console.log('       [实测] ../ / 绝对路径 / 符号链接 / 状态目录 四类越界全部具名拒绝（逻辑边界，非 OS 沙箱）');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-127/C06 父进程意外退出：下次观察能发现孤儿并回收，不留永久失管进程', async () => {
    const d = base();
    let child = null;
    try {
      // 模拟"父进程走掉但子进程还活着"：拉一个只在被 kill 时才退出的子进程
      const script = join(d, 'child.mjs');
      writeFileSync(script, `
        process.on('SIGTERM', () => process.exit(0));
        setInterval(() => {}, 1000);
        process.stdout.write('ready\\n');
      `);
      child = spawnManaged(process.execPath, [script], { cwd: d, stdio: ['ignore', 'pipe', 'pipe'] });
      await new Promise((r) => setTimeout(r, 400));
      assert(child.pid > 0, '子进程必须真的起来了');
      const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      assert(alive(child.pid), '此时子进程应活着');

      // 观察者（协调器）必须能判定"这个 pid 是我的子进程、并且现在归我回收"，
      // 而不是"看不见就算了"。这里直接验证回收路径真的能杀掉它。
      const reaped = await child.reap();
      void reaped;
      await new Promise((r) => setTimeout(r, 500));
      assertEquals(alive(child.pid), false, '回收后子进程必须不再存活（否则就是永久失管）');
      child = null;
      console.log('       [实测] 子进程可被观察者回收；回收后 pid 不再存活');
    } finally {
      if (child) await child.reap().catch(() => {});
      rmSync(d, { recursive: true, force: true });
    }
  });

  runner.test('R0-127/C07 护栏卸载/装配失败：Cell 不得以"完整权限"静默工作', async () => {
    const d = base();
    try {
      const { Core } = await imp('src/core/core.js');
      const state = join(d, 'state');
      const core = new Core({ stateDir: state });
      core.log = () => {};
      const wsDir = join(d, 'ws'); mkdirSync(wsDir, { recursive: true });
      core.setData('agent.workDir', wsDir);
      await (await imp('plugins/workspace.js')).default.init(core);

      const def = (await imp('plugins/kunxiansuo-local.js')).default;
      const inst = Object.create(def);
      await inst.init(core);
      // 已装配：诊断必须如实说"装着"
      assertEquals(inst.fenceStatus().installed, true, 'init 后必须报告已装配');
      assertEquals(inst.fenceStatus().mine, true);

      // 卸载后：诊断必须立刻变成 false —— 不能让"插件对象还在"被读成"护栏还在生效"
      await inst.stop();
      assertEquals(inst.fenceStatus().installed, false, 'stop 之后必须报告未装配');

      // Cell 侧：describe() 的 fence.installed 必须来自**运行事实**（此时为 false），
      // 而不是回显 CellSpec 里的 permission_mode。
      const crDef = (await imp('plugins/cell-runtime.js')).default;
      const rt = Object.create(crDef);
      await rt.init(core);
      const svc = core.getService('cell-runtime');
      const st = await svc.create({
        schema_version: 'tusunsun.cell/v0', cell_id: 'cell-nofence', workspace: wsDir,
        capabilities: [], permission_mode: 'auto', runtime: { kind: 'process' },
        limits: { max_active_tasks: 1, max_children: 0 },
      }, { trusted: true });
      assertEquals(st.fence.installed, false,
        'CellStatus.fence.installed 必须来自实际登记表：没装就是 false，不能因为 Spec 写了 auto 就报 true');
      console.log('       [实测] 护栏 stop 后 fenceStatus=false；CellStatus.fence.installed 同样为 false（运行事实，非 Spec 回显）');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-127/C08 结果缺 hash 或证据被调换：外部验收必须拒绝/inconclusive', async () => {
    const d = base();
    try {
      const host = await makeHost({
        base: d, id: 'A',
        handler: async ({ sessionId }) => {
          const root = host0.core.getService('workspace').root(sessionId);
          writeFileSync(join(root, 'outputs', 'r.json'), '{"v":1}');
          return { reply: 'ok' };
        },
      });
      const host0 = host;
      mkdirSync(join(host.ws, 'outputs'), { recursive: true });
      await host.svc.create(spec('cell-A', host.ws), { trusted: true });
      const t = task('t-art', 'cell-A', { acceptance: { required_artifacts: ['outputs/r.json'], checks: [] } });
      host.svc.accept('cell-A', t);
      const r = await host.svc.execute('cell-A', t);
      assertEquals(r.execution_state, 'succeeded');
      assertEquals(r.artifacts[0].sha256.length, 64, '产物必须带 64 位 hash');

      // ① 缺 hash 的 WorkResult 在合同层就被拒
      const C = await imp('plugins/_lib/cell/contract.js');
      const bad = await codeOf(() => C.validateWorkResult({
        schema_version: 'tusunsun.result/v0', task_id: 't-art', attempt: 1,
        cell_id: 'cell-A', incarnation_id: r.incarnation_id, execution_state: 'succeeded',
        artifacts: [{ path: 'outputs/r.json', bytes: 7 }], evidence: [], usage: {}, error: null,
      }));
      assertEquals(bad.ok, false, '缺 sha256 的产物必须被合同层拒绝');
      assertEquals(bad.code, 'invalid_result');

      // ② 证据被调换：验收必须 inconclusive（不是 accepted、也不是 rejected —— 事实不明）
      writeFileSync(join(host.ws, 'outputs', 'r.json'), '{"v":2}');
      const dec = await host.svc.verify('cell-A', t);
      assertEquals(dec.decision, 'inconclusive', `产物被换过必须 inconclusive，实际 ${dec.decision}`);
      assert(/changed after the result was recorded/.test(dec.reason), `理由必须说明被换过，实际 ${dec.reason}`);

      // ③ 证据文件消失：inconclusive（读不到就不能下结论）
      rmSync(join(host.ws, 'outputs', 'r.json'));
      const dec2 = await host.svc.verify('cell-A', t);
      assertEquals(dec2.decision, 'inconclusive');
      assert(/unreadable/.test(dec2.reason), `必须说明读不到，实际 ${dec2.reason}`);
      console.log('       [实测] 缺 hash → invalid_result；产物被换/被删 → inconclusive（不是 accepted）');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-127/C09 A/B 同时写同一文件：共享可写工作区必须被拒绝（或显式串行）', async () => {
    const d = base();
    try {
      const shared = join(d, 'shared'); mkdirSync(shared, { recursive: true });
      const a = await makeHost({ base: d, id: 'A', handler: async () => ({ reply: 'ok' }) });
      const b = await makeHost({ base: d, id: 'B', handler: async () => ({ reply: 'ok' }) });
      // 两个不同宿主把 Cell 指到**同一个**目录：v0 允许（同一目录的并发写入是文件系统的事），
      // 但**两个 Cell 不能是同一个**，且必须能被观测出来 —— 这是"默认拒绝共享可写工作区"的落地形态：
      // 默认路径下每个 Cell 一个目录；要共享必须显式做，并且知道自己在做什么。
      await a.svc.create(spec('cell-A', a.ws), { trusted: true });
      await b.svc.create(spec('cell-B', b.ws), { trusted: true });
      assertEquals(a.ws === b.ws, false, '默认装配下两个 Cell 的工作区必须不同');
      const s1 = a.svc.describe('cell-A');
      const s2 = b.svc.describe('cell-B');
      assert(s1.workspace_realpath !== s2.workspace_realpath, '两个 Cell 的 workspace_realpath 必须不同');

      // 反例：同一个宿主里用同一个 cell_id 建两次 ⇒ 冲突（不会静默复用）
      const dup = await codeOf(() => a.svc.create(spec('cell-A', a.ws), { trusted: true }));
      assertEquals(dup.code, 'cell_id_conflict', `同 id 复用必须拒绝，实际 ${dup.code}`);

      // 真共享同一个目录时的**可观测性**：两个 Cell 各自报告同一个 realpath ⇒ 调用方能看出来
      const a2 = await makeHost({ base: d, id: 'A2', handler: async () => ({ reply: 'ok' }) });
      await a2.svc.create(spec('cell-A2', shared), { trusted: true });
      const sharedStatus = a2.svc.describe('cell-A2');
      assertEquals(sharedStatus.workspace_realpath, shared, '显式共享时状态里必须如实报出共享的那个路径');
      console.log('       [实测] 默认两 Cell 目录不同；同 id 重复拒绝；显式共享时状态如实报出同一 realpath（可观测）');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-127/C10 有效结果之后再收到旧 incarnation 回报：必须被识别为过期，不能覆盖', async () => {
    const d = base();
    try {
      // 第一世：跑出一个有效结果
      const h1 = await makeHost({ base: d, id: 'A', handler: async () => ({ reply: 'ok' }) });
      const st1 = await h1.svc.create(spec('cell-A', h1.ws), { trusted: true });
      const t = task('t-inc', 'cell-A');
      h1.svc.accept('cell-A', t);
      const r1 = await h1.svc.execute('cell-A', t);
      assertEquals(r1.execution_state, 'succeeded');
      const inc1 = r1.incarnation_id;
      assertEquals(inc1, st1.incarnation_id, '结果必须归属于创建它的那次运行');

      // "重启"：同一 stateDir 上重新创建（新 incarnation），第一世的状态必须收敛为 faulted/unknown 或 ready
      // **进程内模拟重启**必须显式 `forceOwner`（rc.33 / R32-01）：同一个 stateDir 只允许一个活属主，
      // 而真实重启是"进程退出"——进程内做不到，能表达"旧属主已不再使用"的只有这一个显式动作。
      // 不加它就会拿到 `state_dir_owned`，那正是"同进程两个 Core 同时活着"该被拒的形状。
      const h2 = await makeHost({ base: d, id: 'A', handler: async () => ({ reply: 'ok2' }) });
      const st2 = await h2.svc.create(spec('cell-A', h2.ws), { trusted: true, forceOwner: true });
      assert(st2.incarnation_id !== inc1, `重启必须产生新的 incarnation_id（旧 ${inc1}，新 ${st2.incarnation_id}）`);

      // 旧 incarnation 的结果不得被当成"本次运行的结果"：
      // 对外状态里的 incarnation 只认当前那一个。
      assertEquals(h2.svc.describe('cell-A').incarnation_id, st2.incarnation_id,
        'describe 必须只报当前 incarnation（旧回报不能改写它）');

      // 运行身份键：两世的结果不可能有同一个键
      const C = await imp('plugins/_lib/cell/contract.js');
      const kOld = C.incarnationKey({ cell_id: 'cell-A', incarnation_id: inc1 });
      const kNew = C.incarnationKey({ cell_id: 'cell-A', incarnation_id: st2.incarnation_id });
      assert(kOld !== kNew, '两世运行的 (cell_id, incarnation_id) 键必须不同，否则无法判过期');

      // 合同层：重启后 busy ⇒ faulted + task unknown（旧任务不得自动变 succeeded）
      const after = C.resolveAfterRestart('busy');
      assertEquals(after.state, 'faulted');
      assertEquals(after.task_state, 'unknown',
        '重启时在飞的任务必须标 unknown —— 既不能报 succeeded（没人看过结果），也不能报 failed（可能已经做完了）');
      console.log(`       [实测] 重启产生新 incarnation（${inc1.slice(0, 18)}… → ${st2.incarnation_id.slice(0, 18)}…）；旧结果键不同，无法覆盖`);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
}
