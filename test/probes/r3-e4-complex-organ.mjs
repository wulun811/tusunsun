/**
 * R3 / E4 复杂器官探针（v0.16.0-rc）—— Cell × 六合 Lite 受控多文件事务。
 *
 * 回答一个问题：一个新器官能不能在**不改 `src/core/` 一个字节**的前提下，走完
 * 装配（场景 lazy）→ 授权（Cell 能力门）→ 执行（执行器派发）→ 回执（逐文件事实）
 * → 条件撤销 → 卸载 → 重装 的整条链。用例名对应《v0.15.4 综合独立复审》§5 的 E4 证据条目。
 *
 * 用法：`node test/probes/r3-e4-complex-organ.mjs [package根目录]`
 * 退出码：0 = 全部合同成立；1 = 仍有 BROKEN；2 = 探针自身出错。
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = process.argv[2] ? resolve(process.argv[2]) : resolve(HERE, '../..');
const ROOT = mkdtempSync(join(tmpdir(), 'r3-e4-probe-'));
const imp = (rel) => import(pathToFileURL(join(PKG, rel)).href);

const results = [];
const BOOTED = [];
const probe = async (id, title, fn) => {
  try {
    const r = await fn();
    results.push({ id, title, status: r.ok ? 'FIXED' : 'BROKEN', detail: r.detail });
  } catch (e) {
    results.push({ id, title, status: 'PROBE-ERROR', detail: String(e?.stack || e) });
  }
};

const parseResult = (v) => {
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return v; } }
  return v ?? null;
};
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const hashOf = (p) => (existsSync(p) ? sha(p) : null);

let seq = 0;
/** 按真实场景装配：SceneController 读配方 → PluginManager 按 eager/lazy 装载。 */
async function boot() {
  const base = join(ROOT, `b${++seq}`);
  const stateDir = join(base, 'state');
  const wsA = join(base, 'wsA');
  const wsB = join(base, 'wsB');
  for (const d of [stateDir, join(wsA, 'src'), join(wsB, 'src')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(wsA, 'src', 'a.txt'), 'alpha\n');
  writeFileSync(join(wsA, 'src', 'b.txt'), 'beta\n');
  writeFileSync(join(wsB, 'src', 'secret.txt'), 'SECRET\n');

  const { Core } = await imp('src/core/core.js');
  const { PluginManager } = await imp('src/core/plugin-manager.js');
  const { SceneController } = await imp('src/core/scene-controller.js');
  const { scenePluginLists } = await imp('src/bootstrap/cli.js');

  const core = new Core({ stateDir });
  core.log = () => {};
  core.setData('agent.workDir', wsA);
  const pm = new PluginManager(core);
  core.registerService('plugin-manager', pm);
  pm.addDirectory(join(PKG, 'plugins'));
  const sc = new SceneController(core, pm);
  const scene = await sc.findScene('file-txn');
  if (!scene) throw new Error('scene "file-txn" not found — 器官配方缺失，后续判据没有意义');
  const { eager, lazy } = scenePluginLists(scene);
  await pm.loadAll(eager, lazy);

  let exec = null;
  let steps = [];
  const captured = { steps: null };
  core.registerCapability('chat.handle', {
    owner: 'e4-harness',
    handler: async ({ sessionId }) => {
      const out = [];
      for (const s of steps) {
        const args = typeof s.args === 'function' ? s.args(out) : (s.args || {});
        const r = await exec.executeOne(s.tool, args, sessionId);
        const body = parseResult(r.result);
        out.push({ tool: s.tool, state: r.state, code: r.code || null, ok: r.ok === true, body, sent: args });
        if (s.after) await s.after(body, out);
        if (!r.ok) break;
      }
      captured.steps = out;
      return { reply: `steps=${out.length}` };
    },
  });

  await core.start();
  exec = core.getService('tool-executor');
  const cells = core.getService('cell-runtime');
  const mkCell = (id, ws, caps, mode = 'auto') => cells.create({
    schema_version: 'tusunsun.cell/v0', cell_id: id, workspace: ws, capabilities: caps,
    permission_mode: mode, runtime: { kind: 'process' },
    limits: { max_active_tasks: 1, max_children: 0 }, tags: ['e4'],
  }, { trusted: true });
  const run = async (cellId, taskCaps, list, taskId) => {
    steps = list;
    captured.steps = null;
    const task = {
      schema_version: 'tusunsun.task/v0', task_id: taskId || `t-${++seq}`, attempt: 1,
      target_cell_id: cellId, goal: 'e4 probe', inputs: [], required_capabilities: taskCaps,
      budget: { max_steps: 32, wall_ms: 60000 }, acceptance: { required_artifacts: [], checks: [] },
    };
    cells.accept(cellId, task);
    const result = await cells.execute(cellId, task);
    return { result, steps: captured.steps || [] };
  };
  BOOTED.push(core);
  return {
    core, pm, cells, wsA, wsB, mkCell, run,
    get exec() { return exec; },
    hashA: () => hashOf(join(wsA, 'src', 'a.txt')),
    hashB: () => hashOf(join(wsA, 'src', 'b.txt')),
  };
}

const ALL = ['tool.txn-plan', 'tool.txn-commit', 'tool.txn-status'];
const PLAN2 = { tool: 'tool-txn-plan', args: { files: [
  { path: 'src/a.txt', content: 'alpha2\n' }, { path: 'src/b.txt', content: 'beta2\n' }] } };
const commitOf = (kwargs) => ({ tool: 'tool-txn-commit', args: (prev) => ({ ...kwargs(prev) }) });

// ── E4-L1：懒加载装配 ────────────────────────────────────────────────
await probe('E4-L1', '器官在懒加载池：启动不装载，首次能力调用才导入；回执索引如实标 volatile', async () => {
  const b = await boot();
  const before = b.core.plugins.has('cell-file-txn');
  const r = await b.core.callCapability('tool.txn-status', { txn_id: 'nope', _sessionId: 'probe' });
  const after = b.core.plugins.has('cell-file-txn');
  const payload = r?.payload ?? r;
  const d = b.core.getService('cell-file-txn')?.describe?.();
  await b.core.stop();
  return {
    ok: before === false && after === true && payload?.code === 'NOT_FOUND' && d?.persistence === 'volatile',
    detail: `装载前=${before} 装载后=${after} 未知txn=${payload?.code} persistence=${d?.persistence}`,
  };
});

// ── E4-01：Cell 任务内的多文件提交 ───────────────────────────────────
await probe('E4-01', 'Cell 任务内经执行器提交两文件：逐文件 applied、磁盘真变、归因回 cell_id', async () => {
  const b = await boot();
  await b.mkCell('A', b.wsA, ALL);
  const { steps } = await b.run('A', ALL, [
    PLAN2,
    commitOf((prev) => ({ plan_id: prev[0].body.plan.plan_id })),
  ]);
  const txn = steps[1]?.body?.txn;
  const diskA = readFileSync(join(b.wsA, 'src', 'a.txt'), 'utf8');
  const diskB = readFileSync(join(b.wsA, 'src', 'b.txt'), 'utf8');
  await b.core.stop();
  return {
    ok: txn?.state === 'committed'
      && txn.files.every((f) => f.application === 'applied' && typeof f.action_id === 'string')
      && txn.cell_id === 'A' && txn.cell_attribution === 'registry_session_match'
      && diskA === 'alpha2\n' && diskB === 'beta2\n' && txn.persistence === 'volatile',
    detail: `state=${txn?.state} files=${JSON.stringify(txn?.files?.map((f) => [f.path, f.application, !!f.action_id]))} `
      + `cell=${txn?.cell_id}/${txn?.cell_attribution} disk=${JSON.stringify([diskA, diskB])}`,
  };
});

// ── E4-02：同一 request_id 幂等复播（不重复写盘）────────────────────
await probe('E4-02', '同一 request_id 复播：不再写盘，action_id 与首播完全相同', async () => {
  const b = await boot();
  await b.mkCell('A', b.wsA, ALL);
  const first = await b.run('A', ALL, [PLAN2, commitOf((prev) => ({ plan_id: prev[0].body.plan.plan_id, request_id: 'req-1' }))]);
  const planId = first.steps[0].body.plan.plan_id;
  const txn1 = first.steps[1].body.txn;
  const h1 = b.hashA();
  const second = await b.run('A', ALL, [{ tool: 'tool-txn-commit', args: { plan_id: planId, request_id: 'req-1' } }]);
  const body2 = second.steps[0].body;
  const h2 = b.hashA();
  const sameActions = JSON.stringify(body2?.txn?.files?.map((f) => f.action_id)) === JSON.stringify(txn1.files.map((f) => f.action_id));
  await b.core.stop();
  return {
    ok: body2?.idempotent_replay === true && body2?.txn?.txn_id === txn1.txn_id && sameActions && h1 === h2,
    detail: `replay=${body2?.idempotent_replay} same_txn=${body2?.txn?.txn_id === txn1.txn_id} same_actions=${sameActions} disk_same=${h1 === h2}`,
  };
});

// ── E4-03：计划与提交之间被外部改动 ⇒ 版本锚冲突 ────────────────────
await probe('E4-03', '计划后被外部改动：commit 如实报 partial（首文件已写、次文件 VERSION_CONFLICT、后续不尝试）', async () => {
  const b = await boot();
  await b.mkCell('A', b.wsA, ALL);
  let planId = null;
  await b.run('A', ALL, [{ ...PLAN2, after: (body) => { planId = body.plan.plan_id; } }]);
  writeFileSync(join(b.wsA, 'src', 'b.txt'), 'EXTERNAL\n');
  const r2 = await b.run('A', ALL, [{ tool: 'tool-txn-commit', args: { plan_id: planId } }]);
  const body = r2.steps[0].body;
  const txn = body?.txn;
  const apps = txn?.files?.map((f) => [f.path, f.application, f.error_code]);
  await b.core.stop();
  return {
    ok: txn?.state === 'partial' && apps?.[0]?.[1] === 'applied'
      && apps?.[1]?.[1] === 'rejected' && apps?.[1]?.[2] === 'VERSION_CONFLICT'
      && body?.retry === 'after_reanchor',
    detail: `ok=${body?.ok} state=${txn?.state} code=${body?.code} retry=${body?.retry} files=${JSON.stringify(apps)}`,
  };
});

// ── E4-04：条件撤销拒绝（提交后又被改过）────────────────────────────
await probe('E4-04', '提交后外部改动 ⇒ undo 具名拒绝（UNDO_CONFLICT），且不写盘', async () => {
  const b = await boot();
  await b.mkCell('A', b.wsA, ALL);
  const r1 = await b.run('A', ALL, [PLAN2, commitOf((prev) => ({ plan_id: prev[0].body.plan.plan_id }))]);
  const txn = r1.steps[1].body.txn;
  writeFileSync(join(b.wsA, 'src', 'b.txt'), 'EXTERNAL\n');
  const externalHash = b.hashB();
  // undo 是**能力面**动作（不进模型可见工具表）：主机怎么调，探针就怎么调。
  const env = await b.core.callCapability('txn.undo', { txn_id: txn.txn_id, _sessionId: 'cell-A' });
  const body = env?.payload ?? env;
  const diskA = readFileSync(join(b.wsA, 'src', 'a.txt'), 'utf8');
  const untouched = b.hashB() === externalHash && diskA === 'alpha2\n';
  await b.core.stop();
  return {
    ok: body?.ok === false && body?.code === 'UNDO_CONFLICT' && untouched,
    detail: `code=${body?.code} detail_path=${body?.detail?.path} 未动盘=${untouched}`,
  };
});

// ── E4-05：条件成立时的撤销 ─────────────────────────────────────────
await probe('E4-05', '条件成立 ⇒ undo 把两个文件都还原，状态 undone', async () => {
  const b = await boot();
  await b.mkCell('A', b.wsA, ALL);
  const r1 = await b.run('A', ALL, [PLAN2, commitOf((prev) => ({ plan_id: prev[0].body.plan.plan_id }))]);
  const txn = r1.steps[1].body.txn;
  const env = await b.core.callCapability('txn.undo', { txn_id: txn.txn_id, _sessionId: 'cell-A' });
  const body = env?.payload ?? env;
  const diskA = readFileSync(join(b.wsA, 'src', 'a.txt'), 'utf8');
  const diskB = readFileSync(join(b.wsA, 'src', 'b.txt'), 'utf8');
  await b.core.stop();
  return {
    ok: body?.ok === true && body?.txn?.state === 'undone' && diskA === 'alpha\n' && diskB === 'beta\n',
    detail: `state=${body?.txn?.state} undone=${body?.undone} disk=${JSON.stringify([diskA, diskB])}`,
  };
});

// ── E4-06：未授予能力 ⇒ 派发前拒绝 ──────────────────────────────────
await probe('E4-06', 'Cell 未授予 tool.txn-commit ⇒ 执行器在派发前拒绝，磁盘零改动', async () => {
  const b = await boot();
  const caps = ['tool.txn-plan', 'tool.txn-status'];
  await b.mkCell('A', b.wsA, caps);
  const before = b.hashA();
  const { steps } = await b.run('A', caps, [PLAN2, commitOf((prev) => ({ plan_id: prev[0].body?.plan?.plan_id }))]);
  const commitStep = steps.find((s) => s.tool === 'tool-txn-commit');
  const untouched = b.hashA() === before;
  await b.core.stop();
  return {
    ok: commitStep?.state === 'rejected' && commitStep?.code === 'capability_denied' && untouched,
    detail: `state=${commitStep?.state} code=${commitStep?.code} 盘未变=${untouched} 步数=${steps.length}`,
  };
});

// ── E4-07：只读 Cell ⇒ 计划可读、提交被拒 ───────────────────────────
await probe('E4-07', '只读 Cell：tool-txn-plan 放行、tool-txn-commit 以 permission_denied 拒绝', async () => {
  const b = await boot();
  await b.mkCell('A', b.wsA, ALL, 'read-only');
  const before = b.hashA();
  const { steps } = await b.run('A', ALL, [PLAN2, commitOf((prev) => ({ plan_id: prev[0].body?.plan?.plan_id }))]);
  const planOk = steps[0]?.ok === true;
  const commitStep = steps.find((s) => s.tool === 'tool-txn-commit');
  const untouched = b.hashA() === before;
  await b.core.stop();
  return {
    ok: planOk && commitStep?.code === 'permission_denied' && untouched,
    detail: `plan_ok=${planOk} commit=${commitStep?.state}/${commitStep?.code} 盘未变=${untouched}`,
  };
});

// ── E4-08：越界路径（同进程另一工作区）⇒ 拒绝 ────────────────────────
await probe('E4-08', 'Cell A 指向兄弟工作区（同进程另一 Cell 的目录）⇒ PATH_OUT_OF_SCOPE，对方文件零改动', async () => {
  // 诚实边界：v0 的合同是 1 Cell : 1 Core : 1 进程，同一 Core 里建第二个 Cell 会被
  // `create()` 直接拒（实测）。所以这里用 wsB 这个**兄弟目录**代表“另一个 Cell 的工作区”——
  // 对判据而言重要的是“目标在工作区之外”，而不是那个目录属于谁。
  const b = await boot();
  await b.mkCell('A', b.wsA, ALL);
  const secretBefore = hashOf(join(b.wsB, 'src', 'secret.txt'));
  const { steps } = await b.run('A', ALL, [
    { tool: 'tool-txn-plan', args: { files: [{ path: '../wsB/src/secret.txt', content: 'PWNED\n' }] } },
  ]);
  const body = steps[0]?.body;
  const secretAfter = hashOf(join(b.wsB, 'src', 'secret.txt'));
  await b.core.stop();
  return {
    ok: body?.ok === false && body?.code === 'PATH_OUT_OF_SCOPE' && secretBefore === secretAfter,
    detail: `code=${body?.code} 未越界=${secretBefore === secretAfter}`,
  };
});

// ── E4-09：卸载后旧计划不得被执行 ──────────────────────────────────
await probe('E4-09', '卸载后工具立即摘除、旧 plan_id 一律 PLAN_NOT_FOUND；重装后重新可用', async () => {
  const b = await boot();
  await b.mkCell('A', b.wsA, ALL);
  let planId = null;
  await b.run('A', ALL, [{ ...PLAN2, after: (body) => { planId = body.plan.plan_id; } }]);
  const before = b.hashA();
  const un = await b.pm.unload('cell-file-txn');
  const gone = !b.core.plugins.has('cell-file-txn');
  const reg = b.core.getService('tool-registry');
  const toolEntry = reg?.get ? await reg.get('tool-txn-plan') : null;
  const stale = await b.core.callCapability('tool.txn-commit', { plan_id: planId, _sessionId: 'cell-A' });
  const staleBody = stale?.payload ?? stale;
  const untouched = b.hashA() === before;
  const revived = await b.core.callCapability('tool.txn-status', { txn_id: 'nope', _sessionId: 'cell-A' });
  const revivedBody = revived?.payload ?? revived;
  await b.core.stop();
  return {
    ok: un?.ok === true && gone && toolEntry == null
      && staleBody?.code === 'PLAN_NOT_FOUND' && untouched && revivedBody?.code === 'NOT_FOUND',
    detail: `unload=${un?.ok} 已卸=${gone} 工具已摘=${toolEntry == null} 旧计划=${staleBody?.code} `
      + `盘未变=${untouched} 重装后在线=${revivedBody?.code === 'NOT_FOUND'}`,
  };
});

// ── E4-10：计划不可跨会话转让 ──────────────────────────────────────
await probe('E4-10', 'A 的计划不能由另一个会话提交：PLAN_SESSION_MISMATCH，且不写盘', async () => {
  const b = await boot();
  await b.mkCell('A', b.wsA, ALL);
  let planId = null;
  await b.run('A', ALL, [{ ...PLAN2, after: (body) => { planId = body.plan.plan_id; } }]);
  const before = b.hashA();
  const env = await b.core.callCapability('tool.txn-commit', { plan_id: planId, _sessionId: 'sess-someone-else' });
  const body = env?.payload ?? env;
  const untouched = b.hashA() === before;
  await b.core.stop();
  return {
    ok: body?.ok === false && body?.code === 'PLAN_SESSION_MISMATCH' && untouched,
    detail: `code=${body?.code} 盘未变=${untouched}`,
  };
});

// ── 汇总 + 基线指纹 ────────────────────────────────────────────────
const CORE_FILES = ['core.js', 'plugin-manager.js', 'lifecycle-manager.js', 'scene-controller.js',
  'dependency-resolver.js', 'plugin-meta.js', 'json5-loader.js', 'env.js'];
const fixed = results.filter((r) => r.status === 'FIXED').length;
const broken = results.filter((r) => r.status === 'BROKEN').length;
const errored = results.filter((r) => r.status === 'PROBE-ERROR').length;
console.log('\n══════════ R3 / E4 复杂器官探针（v0.16.0-rc）══════════\n');
for (const r of results) {
  console.log(`${r.status.padEnd(11)} ${r.id.padEnd(8)} ${r.title}`);
  console.log(`            ${r.detail}`);
}
console.log(`\n合计 ${results.length}｜FIXED ${fixed}｜BROKEN ${broken}｜PROBE-ERROR ${errored}\n`);
console.log('═══ 基线指纹（防“同一版本不同字节”）═══');
console.log(`package   ${PKG}`);
console.log(`probe     ${sha(fileURLToPath(import.meta.url))}`);
for (const f of CORE_FILES) console.log(`core/${f.padEnd(22)} ${sha(join(PKG, 'src/core', f))}`);
for (const c of BOOTED) { try { await c.stop(); } catch { /* 已停或停失败都不影响结论 */ } }
rmSync(ROOT, { recursive: true, force: true });
if (errored) process.exitCode = 2;
else if (broken) process.exitCode = 1;
