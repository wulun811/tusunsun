// R0-126（G1）：Cell 正式抽象 —— 合同必须先能被拒绝，才值得被信任。
//
// 本文件锁的是三件事：
//   T1 合同验证：未知版本/非法 id/绝对路径/`..`/越权能力/自提权/不支持的运行时，全部**具名拒绝**；
//   T2 能力交集：HostPolicy ∩ Cell ∩ Task，任何一方没有都不执行（不是"执行到一半再说"）；
//   T3 生命周期与执行事实：状态机合法迁移、重启后 busy→faulted+unknown、关闭后不能再接活、
//      WorkResult 必须带真实 hash、缺产物即执行失败、验收与执行分离。
//
// 每条都写**正反两例**：只测"拒绝了"会奖励过度拒绝（把该接受的也拒了）。
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TestRunner, assert, assertEquals } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(join(ROOT, rel));

let C = null;   // 合同模块（一次加载，各用例共用）

function specOf(over = {}) {
  return {
    schema_version: 'tusunsun.cell/v0',
    cell_id: 'cell-build-001',
    workspace: '/abs/projects/repo-build',
    capabilities: ['tool.read', 'tool.write'],
    permission_mode: 'auto',
    runtime: { kind: 'process' },
    limits: { max_active_tasks: 1, max_children: 0 },
    tags: ['coding'],
    ...over,
  };
}

function taskOf(over = {}) {
  return {
    schema_version: 'tusunsun.task/v0',
    task_id: 'task-check-1',
    attempt: 1,
    target_cell_id: 'cell-build-001',
    goal: '检查模块 A 并输出报告',
    inputs: [],
    required_capabilities: ['tool.read'],
    budget: { max_steps: 12, wall_ms: 120000 },
    acceptance: { required_artifacts: ['outputs/report.json'], checks: [] },
    ...over,
  };
}

/** 断言某个调用以某个具名 code 被拒。 */
function expectCode(fn, code, what) {
  try {
    fn();
  } catch (e) {
    assertEquals(e.code, code, `${what}：期望 code=${code}，实际 ${e.code}（${e.message}）`);
    assert(e.contractError === true, `${what}：契约错误必须带 contractError`);
    return e;
  }
  throw new Error(`${what}：应当被拒绝，却成功了`);
}

export async function setup(runner) {
  C = await imp('plugins/_lib/cell/contract.js');

  // ── T1 CellSpec 验证 ─────────────────────────────────────────────
  runner.test('R0-126/T1 CellSpec：合法 Spec 归一化通过；未知版本/非法 id/相对路径/自提权全部具名拒绝', () => {
    // 正例：合法 Spec 通过并**归一化**（不修改入参）
    const raw = specOf({ state_ref: 'local:cells/cell-build-001' });
    const norm = C.validateCellSpec(raw);
    assertEquals(norm.cell_id, 'cell-build-001');
    assertEquals(norm.runtime.kind, 'process', 'v0 运行时必须是 process');
    assertEquals(norm.limits.max_active_tasks, 1, '首版强制一次一个任务');
    assertEquals(raw.capabilities.join(','), 'tool.read,tool.write', '验证器不得改写调用方的对象');
    assertEquals(norm.state_ref, 'local:cells/cell-build-001');

    // 反例①：未知 major 必须拒绝（静默接受未来版本 = 让字段"看起来生效"）
    expectCode(() => C.validateCellSpec(specOf({ schema_version: 'tusunsun.cell/v9' })),
      'unsupported_schema_version', '未知 major');
    expectCode(() => C.validateCellSpec(specOf({ schema_version: 'tusunsun.cell/v0' })).valueOf && ((s) => { delete s.schema_version; C.validateCellSpec(s); })(specOf()),
      'unsupported_schema_version', '缺 schema_version');
    expectCode(() => C.validateCellSpec(specOf({ schema_version: 'tusunsun.task/v0' })),
      'unsupported_schema_version', '拿 Task 文档冒充 CellSpec');

    // 反例②：id 不能有路径语义
    expectCode(() => C.validateCellSpec(specOf({ cell_id: '../evil' })), 'invalid_id', 'cell_id 含 ..');
    expectCode(() => C.validateCellSpec(specOf({ cell_id: 'a/b' })), 'invalid_id', 'cell_id 含分隔符');

    // 反例③：workspace 必须是绝对路径（相对路径会相对"服务器进程"，不是调用方的 shell）
    expectCode(() => C.validateCellSpec(specOf({ workspace: 'projects/repo' })), 'invalid_cell_spec', '相对 workspace');

    // 反例④：state_ref 不能指到别处
    expectCode(() => C.validateCellSpec(specOf({ state_ref: 'file:///etc/passwd' })), 'invalid_cell_spec', '任意 URI');
    expectCode(() => C.validateCellSpec(specOf({ state_ref: 'local:../../etc' })), 'invalid_path', 'state_ref 逃逸');

    // 反例⑤：不支持的运行时**明确拒绝**（假装支持 shared_process = 宣称同进程多 Cell 已安全）
    expectCode(() => C.validateCellSpec(specOf({ runtime: { kind: 'shared_process' } })), 'unsupported_runtime', 'shared_process');
    expectCode(() => C.validateCellSpec(specOf({ runtime: { kind: 'remote' } })), 'unsupported_runtime', 'remote');

    // 反例⑥：full-auto 必须由宿主开启（否则 Spec 自己把安全模式提上去了）
    expectCode(() => C.validateCellSpec(specOf({ permission_mode: 'full-auto' })), 'invalid_cell_spec', '未经宿主允许的 full-auto');
    const allowed = C.validateCellSpec(specOf({ permission_mode: 'full-auto' }), { allowFullAuto: true });
    assertEquals(allowed.permission_mode, 'full-auto', '宿主显式允许时必须能通过（不是一律禁死）');

    // 反例⑦：分裂上限只能降不能升
    expectCode(() => C.validateCellSpec(specOf({ limits: { max_children: 3 } })), 'capability_denied', '申请超出宿主上限的分裂');
    const lowered = C.validateCellSpec(specOf({ limits: { max_children: 0 } }), { maxChildrenCap: 4 });
    assertEquals(lowered.limits.max_children, 0, '在宿主上限内应当通过');

    // 反例⑧：一次多个任务在 v0 不支持
    expectCode(() => C.validateCellSpec(specOf({ limits: { max_active_tasks: 4 } })), 'invalid_cell_spec', 'max_active_tasks>1');
    console.log('       [实测] 8 类非法 Spec 全部具名拒绝；合法 Spec 归一化且不改写入参');
  });

  // ── T2 TaskEnvelope 与能力交集 ───────────────────────────────────
  runner.test('R0-126/T2 Task/能力：Task 不得自带工作区；绝对路径与 .. 拒绝；能力交集三方缺一不可', () => {
    // 正例
    const t = C.validateTaskEnvelope(taskOf());
    assertEquals(t.task_id, 'task-check-1');
    assertEquals(t.attempt, 1);

    // 反例①：Task 不能自己扩大工作区（"我先声明到 /etc 再干活"）
    expectCode(() => C.validateTaskEnvelope(taskOf({ workspace: '/etc' })), 'workspace_conflict', 'Task 自带 workspace');
    expectCode(() => C.validateTaskEnvelope(taskOf({ cwd: '/tmp' })), 'workspace_conflict', 'Task 自带 cwd');

    // 反例②：路径引用必须相对且不能逃逸
    expectCode(() => C.validateTaskEnvelope(taskOf({ acceptance: { required_artifacts: ['/etc/passwd'], checks: [] } })),
      'invalid_path', '绝对产物路径');
    expectCode(() => C.validateTaskEnvelope(taskOf({ acceptance: { required_artifacts: ['../outside.json'], checks: [] } })),
      'invalid_path', '产物路径 .. 逃逸');
    expectCode(() => C.validateTaskEnvelope(taskOf({ inputs: [{ kind: 'file', ref: '..\\..\\win.ini' }] })),
      'invalid_path', 'Windows 形态的 .. 逃逸');

    // 反例③：没有验收条件的任务无法被"接受"或"拒绝" —— 结构上就拒
    expectCode(() => C.validateTaskEnvelope(taskOf({ acceptance: undefined })), 'invalid_task', '缺 acceptance');

    // 能力交集：三方都有的才算数
    const ok = C.intersectCapabilities({
      host: ['tool.read', 'tool.write', 'tool.bash'],
      cell: ['tool.read', 'tool.write'],
      task: ['tool.read'],
    });
    assertEquals(ok.ok, true);
    assertEquals(ok.effective.join(','), 'tool.read', '生效能力必须是交集');
    assert(!ok.effective.includes('tool.bash'), 'host 有、cell 没有的能力不得生效');
    assert(!ok.effective.includes('tool.write'), 'cell 有、task 没要的能力不得生效（最小授权）');

    const deniedHost = C.intersectCapabilities({ host: ['tool.read'], cell: ['tool.read', 'tool.write'], task: ['tool.write'] });
    assertEquals(deniedHost.ok, false, 'host 没授予写权限时，cell+task 都要求也不行');
    assertEquals(deniedHost.code, 'capability_denied');
    assertEquals(deniedHost.denied.join(','), 'tool.write');
    assert(/tool\.write/.test(deniedHost.message), '拒绝必须点名缺的是哪个能力');

    const deniedCell = C.intersectCapabilities({ host: ['tool.read', 'tool.bash'], cell: ['tool.read'], task: ['tool.bash'] });
    assertEquals(deniedCell.ok, false, 'cell 没声明 bash 时，host 授予了也不得执行（纵向收窄）');
    console.log('       [实测] Task 自带 workspace/绝对路径/.. → 拒绝；能力交集三方缺一即 capability_denied');
  });

  // ── T3 状态机与重启收敛 ──────────────────────────────────────────
  runner.test('R0-126/T3 状态机与重启收敛：非法迁移拒绝；busy 重启后必须 faulted+unknown（不许自动 succeeded）', () => {
    // 合法路径
    for (const [from, to] of [['created', 'ready'], ['ready', 'busy'], ['busy', 'ready'], ['ready', 'draining'], ['draining', 'stopped']]) {
      assertEquals(C.canTransition(from, to), true, `${from} → ${to} 应当合法`);
    }
    // 非法：stopped 是终态；busy 不能直接 stopped（跳过 draining）
    assertEquals(C.canTransition('stopped', 'ready'), false, 'stopped 是终态，不得复活');
    assertEquals(C.canTransition('busy', 'stopped'), false, 'busy 不能跳过 draining 直接 stopped');
    expectCode(() => C.assertTransition('stopped', 'ready'), 'invalid_state_transition', '终态复活');

    // 重启收敛：这是"旧结果不能冒充新运行"的核心判据
    const busy = C.resolveAfterRestart('busy');
    assertEquals(busy.state, 'faulted', 'busy 的执行者已经不在了 ⇒ 必须 faulted');
    assertEquals(busy.task_state, 'unknown', '无法判断副作用 ⇒ 任务必须标 unknown（不是 succeeded、不是 failed）');
    assert(/side effects cannot be determined/.test(busy.reason), '必须说明为什么是 unknown');

    assertEquals(C.resolveAfterRestart('ready').state, 'ready', '没有在飞任务时可以干净地重新 ready');
    assertEquals(C.resolveAfterRestart('created').state, 'ready');
    assertEquals(C.resolveAfterRestart('draining').task_state, 'unknown', 'draining 同理（可能正在收尾）');

    // 幂等键与运行身份是两把不同的钥匙
    assertEquals(C.idempotencyKey({ task_id: 't1', attempt: 2 }), 't1#2', 'task_id+attempt 是执行唯一键');
    assertEquals(C.incarnationKey({ cell_id: 'c1', incarnation_id: 'run-1' }), 'c1@run-1', 'cell_id+incarnation 是执行者运行身份');
    console.log('       [实测] 5 条合法迁移通过、终态复活被拒、busy 重启 → faulted/unknown');
  });

  // ── T4 WorkResult 与验收分离 ─────────────────────────────────────
  runner.test('R0-126/T4 WorkResult：无 hash 的产物不被接受；执行成功≠验收通过；拒收必须带理由', () => {
    const good = {
      schema_version: 'tusunsun.result/v0',
      task_id: 'task-check-1', attempt: 1,
      cell_id: 'cell-build-001', incarnation_id: 'run-1',
      execution_state: 'succeeded',
      artifacts: [{ path: 'outputs/report.json', sha256: 'a'.repeat(64), bytes: 1234 }],
      evidence: [{ kind: 'test-log', path: 'outputs/log.txt' }],
      usage: { steps: 5, wall_ms: 11700 },
      error: null,
    };
    const r = C.validateWorkResult(good);
    assertEquals(r.artifacts[0].sha256, 'a'.repeat(64));

    // 反例①：产物必须带真 hash（"自报成功"最常见的伪证据形态）
    expectCode(() => C.validateWorkResult({ ...good, artifacts: [{ path: 'outputs/report.json', bytes: 10 }] }),
      'invalid_result', '产物缺 sha256');
    expectCode(() => C.validateWorkResult({ ...good, artifacts: [{ path: 'outputs/report.json', sha256: 'not-a-hash', bytes: 1 }] }),
      'invalid_result', 'sha256 形状不对');
    // 反例②：产物路径同样不能逃逸
    expectCode(() => C.validateWorkResult({ ...good, artifacts: [{ path: '/etc/passwd', sha256: 'a'.repeat(64), bytes: 1 }] }),
      'invalid_path', '产物绝对路径');
    // 反例③：`cancelled` 不是合法执行状态（杀进程不证明副作用已撤销）
    expectCode(() => C.validateWorkResult({ ...good, execution_state: 'cancelled' }),
      'invalid_result', 'cancelled 不在执行状态里');

    // 验收决定：accepted 可以不带理由，拒收必须带
    const acc = C.makeAcceptanceDecision({ decision: 'accepted', task_id: 'task-check-1', attempt: 1 });
    assertEquals(acc.decision, 'accepted');
    assertEquals(acc.by, 'local-acceptor', '验收者身份必须记录（谁判的）');
    const rej = C.makeAcceptanceDecision({ decision: 'rejected', task_id: 'task-check-1', attempt: 1, reason: '测试进程失败' });
    assertEquals(rej.reason, '测试进程失败');
    expectCode(() => C.makeAcceptanceDecision({ decision: 'rejected', task_id: 'task-check-1', attempt: 1 }),
      'invalid_decision', '拒收不带理由');
    expectCode(() => C.makeAcceptanceDecision({ decision: 'maybe', task_id: 't1' }), 'invalid_decision', '未知决定');
    console.log('       [实测] 缺 hash/绝对路径/cancelled → 拒绝；拒收必须有理由，验收者身份留痕');
  });

  // ── T5 真运行：create → accept → execute → verify → close ───────
  runner.test('R0-126/T5 单 Cell 真运行：状态来自运行事实、缺产物即执行失败、验收独立、关闭后拒接活', async () => {
    const { Core } = await imp('src/core/core.js');
    const d = mkdtempSync(join(tmpdir(), 'r126-cell-'));
    const ws = join(d, 'proj'); mkdirSync(ws); mkdirSync(join(ws, 'outputs'));
    const core = new Core({ stateDir: join(d, 'state') });
    core.log = () => {};
    core.setData('agent.workDir', ws);
    // 最小装配：workspace 服务 + 一个假 chat.handle（不调模型，证明"Cell ≠ 必须花 token"）
    await (await imp('plugins/workspace.js')).default.init(core);
    // 宿主实际注册了一个工具能力：能力交集不是"一律空集"，而是"注册了才生效"
    core.registerCapability('tool.read', { owner: 'test', handler: async () => 'read-ok' });
    core.registerCapability('tool.write', { owner: 'test', handler: async () => 'write-ok' });
    core._chatHandle = core.registerCapability('chat.handle', {
      owner: 'test',
      handler: async ({ message, sessionId }) => {
        // 真实地**按会话工作区**写一个产物：证明 Cell 的工作区真的被执行链用上了
        const root = core.getService('workspace').root(sessionId);
        writeFileSync(join(root, 'outputs', 'report.json'), JSON.stringify({ goal: message, ok: true }));
        return { reply: 'DONE' };
      },
    });
    const def = (await imp('plugins/cell-runtime.js')).default;
    const rt = Object.create(def);
    await rt.init(core);
    const svc = core.getService('cell-runtime');

    try {
      // ① create：工作区真实存在、能力来自宿主实际注册
      const st = await svc.create(specOf({ cell_id: 'cell-build-001', workspace: ws, capabilities: ['tool.read', 'tool.write'] }), { trusted: true });
      assertEquals(st.cell_id, 'cell-build-001');
      assertEquals(st.state, 'ready', '创建后应当 ready');
      assertEquals(st.workspace_realpath, ws, '对外状态必须来自真实路径');
      assert(/^run-/.test(st.incarnation_id), '必须有本次运行的 incarnation_id（与 PID/端口不是一回事）');
      assert(existsSync(join(d, 'state', 'cells', 'cell-build-001', 'cell.json')), 'Cell 状态必须落盘（重启要能收敛）');

      // ② accept：能力被交集收窄（宿主此时没有任何 tool.* 能力注册）
      const task = taskOf({ required_capabilities: ['tool.read'] });
      const acc = svc.accept('cell-build-001', task);
      assertEquals(acc.accepted, true);
      assertEquals(acc.effective_capabilities.join(','), 'tool.read',
        '生效能力 = 宿主已注册 ∩ Cell 声明 ∩ Task 要求；tool.write 没被任务要求，不得自动生效');

      // ③ execute：真的跑，产物真的落到 Cell 的工作区
      const res = await svc.execute('cell-build-001', task);
      assertEquals(res.execution_state, 'succeeded', `执行应成功，实际 ${res.execution_state}（${res.error}）`);
      assertEquals(res.artifacts.length, 1, '必须收集到一个产物');
      assertEquals(res.artifacts[0].path, 'outputs/report.json');
      assertEquals(res.artifacts[0].sha256.length, 64, '产物必须带真实 sha256');
      assertEquals(res.cell_id, 'cell-build-001');
      assertEquals(res.incarnation_id, st.incarnation_id, '结果必须归属于产生它的那次运行');
      assert(existsSync(join(ws, 'outputs', 'report.json')), '产物必须落在 Cell 的工作区里');
      assertEquals(svc.describe('cell-build-001').active_task_id, null, '执行结束后不得再有在飞任务');
      assertEquals(svc.describe('cell-build-001').state, 'ready', '任务成功不改变 Cell 身份状态');

      // ④ verify：独立验收通过，且记录核过的产物
      const decision = await svc.verify('cell-build-001', task);
      assertEquals(decision.decision, 'accepted', `应验收通过，实际 ${decision.decision}（${decision.reason}）`);
      assertEquals(decision.checked.join(','), 'outputs/report.json');
      assert(/hash-verified/.test(decision.reason), '通过理由要说明是核过 hash 的');

      // ⑤ 反例：产物被事后替换 ⇒ 验收必须 inconclusive（不是 accepted）
      writeFileSync(join(ws, 'outputs', 'report.json'), '{"tampered":true}');
      const tampered = await svc.verify('cell-build-001', task);
      assertEquals(tampered.decision, 'inconclusive', `证据被换掉时必须 inconclusive，实际 ${tampered.decision}`);
      assert(/changed after the result was recorded/.test(tampered.reason));

      // ⑥ 反例：缺产物 ⇒ 执行必须成功不了（不能"模型说完成了"就算完成）
      const task2 = taskOf({ task_id: 'task-missing', acceptance: { required_artifacts: ['outputs/nope.json'], checks: [] } });
      await svc.accept('cell-build-001', task2);
      const res2 = await svc.execute('cell-build-001', task2);
      assertEquals(res2.execution_state, 'failed', '缺必需产物时执行状态必须是 failed');
      assert(/missing required artifact/.test(res2.error), `错误必须点名缺的是哪个产物，实际 ${res2.error}`);
      const dec2 = await svc.verify('cell-build-001', task2);
      assertEquals(dec2.decision, 'rejected', '执行失败的任务不可能被验收通过');

      // ⑦ close 之后不得再接活
      await svc.close('cell-build-001');
      assertEquals(svc.describe('cell-build-001').state, 'stopped');
      let closedReject = null;
      try { svc.accept('cell-build-001', taskOf({ task_id: 'task-after-close' })); } catch (e) { closedReject = e; }
      assert(closedReject !== null, 'Cell 关闭后必须拒绝新任务');
      assertEquals(closedReject.code, 'cell_not_ready', `必须是 cell_not_ready，实际 ${closedReject.code}`);
      console.log('       [实测] create→ready→accept→execute(succeeded,真 hash)→verify(accepted)→篡改→inconclusive→close→拒接活');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  // ── T6 能力与预算的执行前拒绝 ───────────────────────────────────
  runner.test('R0-126/T6 执行前拒绝：越权能力/重复 Cell/未知目标/预算超限都在产生副作用之前停下', async () => {
    const { Core } = await imp('src/core/core.js');
    const d = mkdtempSync(join(tmpdir(), 'r126-deny-'));
    const ws = join(d, 'proj'); mkdirSync(ws);
    const core = new Core({ stateDir: join(d, 'state') });
    core.log = () => {};
    core.setData('agent.workDir', ws);
    await (await imp('plugins/workspace.js')).default.init(core);
    let executed = 0;
    core._chatHandle = core.registerCapability('chat.handle', { owner: 'test', handler: async () => { executed++; return { reply: 'ok' }; } });
    const def = (await imp('plugins/cell-runtime.js')).default;
    const rt = Object.create(def);
    await rt.init(core);
    const svc = core.getService('cell-runtime');

    try {
      await svc.create(specOf({ cell_id: 'cA', workspace: ws, capabilities: ['tool.read'] }), { trusted: true });

      // 反例①：重复 Cell id
      let e1 = null;
      try { await svc.create(specOf({ cell_id: 'cA', workspace: ws }), { trusted: true }); } catch (e) { e1 = e; }
      assertEquals(e1?.code, 'cell_id_conflict', `重复 id 必须具名拒绝，实际 ${e1?.code}`);

      // 反例②：任务要求 Cell 没声明、宿主也没授予的能力 ⇒ 执行前拒绝，且**一次都没执行**
      let e2 = null;
      try { svc.accept('cA', taskOf({ target_cell_id: 'cA', required_capabilities: ['tool.write'] })); } catch (e) { e2 = e; }
      assertEquals(e2?.code, 'capability_denied', `越权能力必须 capability_denied，实际 ${e2?.code}`);
      assertEquals(executed, 0, '能力判定必须发生在执行之前（副作用不得发生）');

      // 反例③：任务投错 Cell
      let e3 = null;
      try { svc.accept('cA', taskOf({ target_cell_id: 'cB', required_capabilities: [] })); } catch (e) { e3 = e; }
      assertEquals(e3?.code, 'task_rejected', `投错 cell 必须 task_rejected，实际 ${e3?.code}`);

      // 反例④：未知 Cell
      let e4 = null;
      try { svc.accept('nope', taskOf({ target_cell_id: 'nope' })); } catch (e) { e4 = e; }
      assertEquals(e4?.code, 'unknown_cell');

      // 正例：声明过的能力确实能执行（不是一律拒死）
      const okTask = taskOf({ task_id: 'task-ok', target_cell_id: 'cA', required_capabilities: [], acceptance: { required_artifacts: [], checks: [] } });
      svc.accept('cA', okTask);
      const r = await svc.execute('cA', okTask);
      assertEquals(r.execution_state, 'succeeded', `合法任务必须能跑，实际 ${r.execution_state}：${r.error}`);
      assertEquals(executed, 1, '合法任务必须真的执行了一次');

      // 反例⑤：wall_ms 预算真执行 —— 慢 handler 必须标 timed_out（而不是等到天荒地老）
      core.registerCapability('chat.handle', {
        owner: 'test', overrideBy: core._chatHandle,
        handler: async () => { await new Promise((res) => setTimeout(res, 3000)); return { reply: 'slow' }; },
      });
      const slow = taskOf({ task_id: 'task-slow', target_cell_id: 'cA', required_capabilities: [], acceptance: { required_artifacts: [], checks: [] }, budget: { max_steps: 10, wall_ms: 400 } });
      svc.accept('cA', slow);
      const t0 = Date.now();
      const r2 = await svc.execute('cA', slow);
      const took = Date.now() - t0;
      assertEquals(r2.execution_state, 'timed_out', `预算到期必须 timed_out，实际 ${r2.execution_state}`);
      assert(/budget_exhausted/.test(r2.error || ''), `必须如实说是预算用尽，实际 ${r2.error}`);
      assert(/NOT rolled back/.test(r2.error || ''), '必须诚实说明副作用未回滚（不能假称已取消）');
      assert(took < 2500, `预算 400ms 时不该等满 3s（实际 ${took}ms）`);
      console.log('       [实测] 重复 id/越权能力/投错 cell/未知 cell 全部执行前拒绝；400ms 预算 400ms 生效并标 timed_out');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
}
