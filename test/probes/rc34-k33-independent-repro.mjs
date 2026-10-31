#!/usr/bin/env node
// rc.34 —— 把专家 rc.33 源码级复审给的**四条独立反例**做成随包可跑的探针。
//
// 与 rc.33 那份的关系：这是**新的一批**（K33-A1 / K33-A2 / K33-B1），问的是另一组问题：
// 「声明了的合同，执行路径真的读它了吗」「事件是不是早于事实」。两批混成一个退出码，
// 会让「上一批还绿着」掩盖「这一批红了」。
//
// 与专家原件的关系：保留他**要证明的那件事**，把环境相关部分换成本包自带的形态
// （路径从 `import.meta.url` 推，不写死任何人的目录），并补上他没测的两项：
//   · 根 `type:'string'` 的正例（证明不是「拒绝一切」冒充修复）；
//   · `cell.closing` 事件（他在报告里只要了 `closed:false` + `cleanup_pending`）。
//
// 退出码：0 = 四条都被正确处理；1 = 有反例仍然成立；3 = 本形态跑不了（缺 core 等）。
// 发布门禁会自动发现它（`scripts/release-gate.mjs` 扫描 `test/probes/*.mjs`）。
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(join(ROOT, rel));

const results = [];
const record = (id, pass, detail) => {
  results.push({ id, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'} ${id}  ${detail}`);
};

const tmp = () => mkdtempSync(join(tmpdir(), 'rc34-probe-'));

const spec = (id, workspace) => ({
  schema_version: 'tusunsun.cell/v0', cell_id: id, workspace,
  capabilities: ['tool.read', 'tool.write'], permission_mode: 'auto',
  runtime: { kind: 'process' }, limits: { max_active_tasks: 1, max_children: 0 },
});
const taskOf = (id) => ({
  schema_version: 'tusunsun.task/v0', task_id: id, attempt: 1, target_cell_id: 'c1',
  goal: `goal ${id}`, inputs: [], required_capabilities: ['tool.read'],
  budget: { max_steps: 5, wall_ms: 10000 }, acceptance: { required_artifacts: [], checks: [] },
});

/** 只靠公开 API（registerCapability + callCapability）就能复现的那两条。 */
async function probeSchema() {
  const base = tmp();
  try {
    const { Core } = await imp('src/core/core.js');
    const core = new Core({ stateDir: join(base, 'state') });
    core.log = () => {};
    let n = 0;
    const call = async (schema, params) => {
      let calls = 0;
      const id = `probe.c${++n}`;
      core.registerCapability(id, { owner: 'probe', handler: async () => { calls++; return 'ran'; }, input_schema: schema });
      const r = await core.callCapability(id, params);
      return { ok: r?.ok === true, code: r?.code ?? null, calls };
    };
    // A1：必填键落在原型链上。
    const inherited = await call(
      JSON.parse('{"type":"object","required":["__proto__"],"properties":{"__proto__":{"type":"object"}}}'),
      {},
    );
    record('K33-A1 必填键落在原型链', inherited.ok === false && inherited.calls === 0,
      `accepted=${inherited.ok} dispatched=${inherited.calls} code=${inherited.code}`);
    // A2：根 type 声明了不执行。两个方向都试，再加一个正例。
    const rootObj = await call({ type: 'object' }, 'str');
    const rootStr = await call({ type: 'string' }, { unexpected: 'object' });
    const rootPositive = await call({ type: 'string' }, 'hello');
    const okA2 = rootObj.ok === false && rootObj.calls === 0
      && rootStr.ok === false && rootStr.calls === 0
      && rootPositive.ok === true && rootPositive.calls === 1;
    record('K33-A2 根 type 声明了不执行', okA2,
      `object<-'str' accepted=${rootObj.ok} / string<-{} accepted=${rootStr.ok} / string<-'hello' accepted=${rootPositive.ok}`);
    return inherited.ok === false && okA2;
  } finally { rmSync(base, { recursive: true, force: true }); }
}

/** 在飞异步链 + 强制关闭：`closed` 必须与 `cleanup_done` 同源，`cell.closed` 不得早发。 */
async function probeCloseFacts() {
  const base = tmp();
  let release = () => {};
  let began = () => {};
  const gate = new Promise((r) => { release = r; });
  const started = new Promise((r) => { began = r; });
  try {
    const { Core } = await imp('src/core/core.js');
    const ws = join(base, 'ws');
    mkdirSync(ws, { recursive: true });
    const core = new Core({ stateDir: join(base, 'state') });
    core.log = () => {};
    core.setData('agent.workDir', ws);
    await (await imp('plugins/workspace.js')).default.init(core);
    core.registerCapability('tool.read', { owner: 'probe', handler: async () => ({ ok: true }) });
    core.registerCapability('tool.write', { owner: 'probe', handler: async () => ({ ok: true }) });
    core.registerCapability('chat.handle', { owner: 'probe', handler: async () => { began(); await gate; return { reply: 'done' }; } });
    const Cls = (await imp('plugins/tool-executor.js')).default.constructor;
    await new Cls().init(core);
    await (await imp('plugins/cell-runtime.js')).default.init(core);
    const svc = core.getService('cell-runtime');
    const counts = { closed: 0, closing: 0 };
    core.on('cell.closed', () => { counts.closed++; });
    core.on('cell.closing', () => { counts.closing++; });
    await svc.create(spec('c1', ws), { trusted: true });
    svc.accept('c1', taskOf('A'));
    const executing = svc.execute('c1');
    await started;
    const inflight = await svc.close('c1', { force: true, quiesceMs: 20 });
    const lockAfter = existsSync(join(base, 'state', 'cells', 'owner.lock'));
    record('K33-B1 在飞强制关闭只报「清理中」',
      inflight.closed === false && inflight.closing === true && inflight.cleanup_done === false
      && (inflight.cleanup_pending || []).length > 0 && counts.closed === 0 && counts.closing === 1 && lockAfter === true,
      `closed=${inflight.closed} closing=${inflight.closing} cleanup_done=${inflight.cleanup_done} `
      + `pending=${(inflight.cleanup_pending || []).join('/')} closedEvents=${counts.closed} closingEvents=${counts.closing} lockLeft=${lockAfter}`);
    release();
    await executing.catch(() => {});
    const retried = await svc.close('c1', { force: true, quiesceMs: 5000 });
    const lockEnd = existsSync(join(base, 'state', 'cells', 'owner.lock'));
    record('K33-B1 重试后真正关完',
      retried.closed === true && retried.cleanup_done === true && (retried.cleanup_pending || []).length === 0
      && counts.closed === 1 && lockEnd === false,
      `closed=${retried.closed} cleanup_done=${retried.cleanup_done} closedEvents=${counts.closed} lockLeft=${lockEnd}`);
    return inflight.closed === false && retried.closed === true && counts.closed === 1 && lockEnd === false;
  } finally {
    release();
    rmSync(base, { recursive: true, force: true });
  }
}

let exitCode = 0;
try {
  await imp('src/core/core.js');
} catch (err) {
  console.log(`[NOT_RUN] 本形态缺 src/core：${err.code || err.message}`);
  process.exit(3);
}
console.log('专家 rc.33 源码级复审的四条独立反例（本包自带形态，路径不写死）：');
const all = [];
for (const fn of [probeSchema, probeCloseFacts]) {
  try { all.push(await fn()); }
  catch (err) {
    record(fn.name, false, `探针自身出错：${err?.code || err?.message}`);
    all.push(false);
  }
}
const passed = all.filter(Boolean).length;
console.log(`\n四条反例：${passed}/${all.length} 组已被正确处理`);
if (passed !== all.length) exitCode = 1;
process.exit(exitCode);
