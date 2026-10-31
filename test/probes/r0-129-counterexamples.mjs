// R0-129 探针：四项已知反例的最小复现；全部修好后应报 0/N BUG。
//
// 与 `test/unit/test-r0-129-*.test.mjs` 的分工：那里是 harness 回归锁；本文件可单独运行，
// 逐条打印 BUG / FIXED，并按自身断言结果决定退出码 —— 有任何 BUG 即非 0，
// 因此可以直接作为门禁项，而不是只给人看。
//
// 用法：node test/probes/r0-129-counterexamples.mjs
// 退出码：0 = 全部 FIXED；1 = 仍有 BUG；2 = 一条断言都没执行。
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (rel) => import(join(ROOT, rel));
const say = (tag, msg) => console.log(`[${tag}] ${msg}`);

const spec = (over = {}) => ({
  schema_version: 'tusunsun.cell/v0',
  cell_id: 'cell-probe',
  workspace: '/abs/x',
  capabilities: ['tool.read', 'tool.write'],
  permission_mode: 'auto',
  runtime: { kind: 'process' },
  limits: { max_active_tasks: 1, max_children: 0 },
  ...over,
});
const task = (over = {}) => ({
  schema_version: 'tusunsun.task/v0',
  task_id: 't1', attempt: 1, target_cell_id: 'cell-probe',
  goal: 'g', inputs: [], required_capabilities: ['tool.read'],
  budget: { max_steps: 10, wall_ms: 60000 },
  acceptance: { required_artifacts: [], checks: [] },
  ...over,
});

async function makeHost({ base, id = 'A', toolCalls = [], onChat = null }) {
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
    handler: async (a) => { writeFileSync(join(ws, a.path ?? 'x'), a.content ?? 'x'); return 'WROTE'; },
  });
  core.registerCapability('chat.handle', {
    owner: 'test',
    handler: async ({ sessionId }) => {
      const outs = [];
      for (const name of toolCalls) {
        const r = await exec.executeOne(name, { path: 'out.txt', content: 'x' }, sessionId, 'chain');
        outs.push({ name, status: r.status, error: r.error });
      }
      if (onChat) await onChat({ sessionId, core, exec });
      return { reply: JSON.stringify(outs) };
    },
  });
  const rtDef = (await imp('plugins/cell-runtime.js')).default;
  const rt = Object.create(rtDef);
  await rt.init(core);
  return { core, ws, exec, svc: core.getService('cell-runtime') };
}

const codeOf = async (fn) => { try { await fn(); return 'OK'; } catch (e) { return e.code || e.message; } };

const results = [];
const check = (name, bug, detail) => {
  results.push({ name, bug });
  say(bug ? 'BUG' : 'FIXED', `${name} — ${detail}`);
};

// ── P0-01a：close(force) 之后迟到的工具调用 ──────────────────────────
{
  const d = mkdtempSync(join(tmpdir(), 'r129-probe-a-'));
  try {
    let release; let late = null;
    const gate = new Promise((r) => { release = r; });
    const h = await makeHost({
      base: d, id: 'A',
      onChat: async ({ exec, sessionId }) => {
        await gate;
        const r = await exec.executeOne('tool-write', { path: 'late.txt', content: 'x' }, sessionId, 'chain');
        late = { status: r.status, error: r.error };
      },
    });
    await h.svc.create(spec({ workspace: h.ws, capabilities: ['tool.read'], permission_mode: 'read-only' }), { trusted: true });
    const t = task();
    h.svc.accept('cell-probe', t);
    const p = h.svc.execute('cell-probe', t);
    await new Promise((r) => setTimeout(r, 50));
    const cl = await h.svc.close('cell-probe', { force: true });
    release();
    const res = await p;
    const bug = existsSync(join(h.ws, 'late.txt')) || existsSync(join(process.cwd(), 'late.txt'))
      || res.execution_state === 'succeeded';
    check('P0-01a close(force) 后迟到工具', bug,
      `close=${cl.to} 最终=${res.execution_state} late=${late?.status} 写宿主=${existsSync(join(h.ws, 'late.txt'))}`);
  } finally { rmSync(d, { recursive: true, force: true }); }
}

// ── P0-01b：墙钟超时之后迟到的工具调用 + 第二个任务 ──────────────────
{
  const d = mkdtempSync(join(tmpdir(), 'r129-probe-b-'));
  try {
    let release; let late = null;
    const gate = new Promise((r) => { release = r; });
    const h = await makeHost({
      base: d, id: 'B',
      onChat: async ({ exec, sessionId }) => {
        await gate;
        const r = await exec.executeOne('tool-write', { path: 'late.txt', content: 'x' }, sessionId, 'chain');
        late = { status: r.status, error: r.error };
      },
    });
    await h.svc.create(spec({ workspace: h.ws, capabilities: ['tool.read'], permission_mode: 'read-only' }), { trusted: true });
    const t = task({ budget: { max_steps: 10, wall_ms: 120 } });
    h.svc.accept('cell-probe', t);
    const res = await h.svc.execute('cell-probe', t);
    const second = await codeOf(async () => h.svc.accept('cell-probe', task({ task_id: 't2' })));
    release();
    await new Promise((r) => setTimeout(r, 200));
    const wrote = existsSync(join(h.ws, 'late.txt'));
    check('P0-01b 超时后迟到工具/新任务', wrote || res.execution_state === 'succeeded' || second === 'OK',
      `超时=${res.execution_state} 迟到写入=${wrote} late=${late?.status} 第二任务=${second}`);
  } finally { rmSync(d, { recursive: true, force: true }); }
}

// ── P0-02：同一 Cell ID 重启后静默改绑工作区 ─────────────────────────
{
  const d = mkdtempSync(join(tmpdir(), 'r129-probe-c-'));
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
      return core.getService('cell-runtime');
    };
    const s1 = await mk();
    await s1.create(spec({ cell_id: 'same-identity', workspace: A }), { trusted: true });
    const s2 = await mk();
    const r = await codeOf(() => s2.create(spec({ cell_id: 'same-identity', workspace: B }), { trusted: true }));
    const reported = r === 'OK' ? s2.describe('same-identity').workspace_realpath : r;
    check('P0-02 同 Cell ID 静默改绑工作区', r === 'OK' && reported === B,
      `create=${r} 回报=${reported}（期望 cell_identity_conflict）`);
  } finally { rmSync(d, { recursive: true, force: true }); }
}

// ── P1-01：一个 Core 内两个 Cell ──────────────────────────────────────
{
  const d = mkdtempSync(join(tmpdir(), 'r129-probe-d-'));
  try {
    const h = await makeHost({ base: d, id: 'C' });
    await h.svc.create(spec({ cell_id: 'cell-1', workspace: h.ws }), { trusted: true });
    const r = await codeOf(async () => h.svc.create(spec({ cell_id: 'cell-2', workspace: h.ws }), { trusted: true }));
    const n = h.svc.list().length;
    check('P1-01 一个 Core 两个 Cell', r === 'OK' && n === 2, `第二个 create=${r} list=${n}（期望 cell_quota_exceeded，list=1）`);
  } finally { rmSync(d, { recursive: true, force: true }); }
}

// ── P1-02：工作区外符号链接被当成产物 ───────────────────────────────
{
  const d = mkdtempSync(join(tmpdir(), 'r129-probe-e-'));
  try {
    const outside = join(d, 'external-secret.txt');
    writeFileSync(outside, 'SECRET');
    const h = await makeHost({ base: d, id: 'D' });
    symlinkSync(outside, join(h.ws, 'report.txt'));
    await h.svc.create(spec({ workspace: h.ws }), { trusted: true });
    const t = task({ acceptance: { required_artifacts: ['report.txt'], checks: [] } });
    h.svc.accept('cell-probe', t);
    const res = await h.svc.execute('cell-probe', t);
    const dec = await h.svc.verify('cell-probe', t);
    check('P1-02 末尾符号链接指向工作区外', dec.decision === 'accepted',
      `execution=${res.execution_state} 产物=${res.artifacts.length} decision=${dec.decision}`);

    const d2 = mkdtempSync(join(tmpdir(), 'r129-probe-f-'));
    try {
      const outDir = join(d2, 'outside-dir'); mkdirSync(outDir);
      writeFileSync(join(outDir, 'f.txt'), 'SECRET2');
      const h2 = await makeHost({ base: d2, id: 'E' });
      symlinkSync(outDir, join(h2.ws, 'sub'));
      await h2.svc.create(spec({ workspace: h2.ws }), { trusted: true });
      const t2 = task({ acceptance: { required_artifacts: ['sub/f.txt'], checks: [] } });
      h2.svc.accept('cell-probe', t2);
      const r2 = await h2.svc.execute('cell-probe', t2);
      const dec2 = await h2.svc.verify('cell-probe', t2);
      check('P1-02b 中间目录符号链接', dec2.decision === 'accepted',
        `execution=${r2.execution_state} 产物=${r2.artifacts.length} decision=${dec2.decision}`);
    } finally { rmSync(d2, { recursive: true, force: true }); }
  } finally { rmSync(d, { recursive: true, force: true }); }
}

const bugs = results.filter((r) => r.bug).length;
console.log(`\n=== 跑过 ${results.length} 条；${bugs} 条仍为 BUG ===`);
if (results.length === 0) {
  console.error('[probe][FAIL] 一条断言都没执行 —— 0 条不等于通过');
  process.exit(2);
}
process.exit(bugs > 0 ? 1 : 0);
