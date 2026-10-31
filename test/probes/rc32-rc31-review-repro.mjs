#!/usr/bin/env node
// rc.32 —— 把专家 rc.31 源码级发布审查给的**五份反例**做成随包可跑的探针。
//
// 为什么不直接把他的脚本放进 `test/probes/`：那五份原件带作者侧固定根路径
// （`/mnt/data/rc31_audit/package`），而且其中两份要求"注入一次 EIO"这种**只有测试桩
// 才能提供**的前提。这里保留它们**要证明的那件事**，把环境相关部分换成本包自带的形态：
//   · 路径从 `import.meta.url` 推（不写死任何人的目录）；
//   · 故障注入用覆写 `_persist` / `_appendResult` / `freezeForTask`，与原件同一手法；
//   · 判据不只看退出码，逐字段核对 `ok` / `writes` / 文件是否真的存在。
//
// 退出码：0 = 五条都被正确拒绝（各自的具名 code 与零写盘）；1 = 有反例仍然成立；
//         3 = 本形态跑不了（例如缺 core，属于包被拆坏，不是"通过"）。
//
// 这个文件的价值在于**发布门禁会自动发现它**（`scripts/release-gate.mjs` 扫描
// `test/probes/*.mjs`），于是"专家这五条"不再依赖某个人记得去跑。
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
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

const spec = (id, workspace, over = {}) => ({
  schema_version: 'tusunsun.cell/v0', cell_id: id, workspace,
  capabilities: ['tool.read', 'tool.write'], permission_mode: 'auto',
  runtime: { kind: 'process' }, limits: { max_active_tasks: 1, max_children: 0 }, ...over,
});
const taskOf = (id, cellId, over = {}) => ({
  schema_version: 'tusunsun.task/v0', task_id: id, attempt: 1, target_cell_id: cellId,
  goal: `goal ${id}`, inputs: [], required_capabilities: ['tool.read'],
  budget: { max_steps: 5, wall_ms: 10000 }, acceptance: { required_artifacts: [], checks: [] }, ...over,
});

async function makeHost(base) {
  const { Core } = await imp('src/core/core.js');
  const ws = join(base, 'ws');
  mkdirSync(ws, { recursive: true });
  const core = new Core({ stateDir: join(base, 'state') });
  core.log = () => {};
  core.setData('agent.workDir', ws);
  await (await imp('plugins/workspace.js')).default.init(core);
  core.registerCapability('tool.read', { owner: 'probe', handler: async () => ({ ok: true }) });
  // 真的写盘：这就是"未经授权的 tool-write 会造成的副作用"。
  core.registerCapability('tool.write', {
    owner: 'probe',
    handler: async () => { writeFileSync(join(ws, 'written.txt'), 'x'); return { ok: true }; },
  });
  const ctx = { onChat: null, freeze: null };
  core.registerService('cell-context', {
    freezeForTask: (...a) => (ctx.freeze ? ctx.freeze(...a) : Promise.resolve(null)),
    enterExecution: () => {}, exitExecution: () => {},
  });
  core.registerCapability('chat.handle', {
    owner: 'probe',
    handler: async (p) => (ctx.onChat ? ctx.onChat(p) : { reply: 'ok' }),
  });
  const rt = (await imp('plugins/cell-runtime.js')).default;
  await rt.init(core);
  const Cls = (await imp('plugins/tool-executor.js')).default.constructor;
  const exec = new Cls();
  await exec.init(core);
  return { core, ws, ctx, rt, exec, svc: core.getService('cell-runtime') };
}

const tmp = () => mkdtempSync(join(tmpdir(), 'rc32-probe-'));

// ── ① probe_race：给 freezeForTask 配可控延迟，两条 execute 同时进来 ──────────
async function probeRace() {
  const base = tmp();
  try {
    const host = await makeHost(base);
    let maxChats = 0; let current = 0; const reports = [];
    host.ctx.onChat = async (p) => {
      current++; maxChats = Math.max(maxChats, current);
      const out = await host.exec.executeOne('tool-write', {}, p.sessionId);
      reports.push({ message: p.message, ok: out.ok, code: out.code });
      await new Promise((r) => setTimeout(r, 60));
      current--;
      return { reply: 'ok' };
    };
    let releaseFreeze; const frozen = new Promise((r) => { releaseFreeze = r; });
    let freezeCalls = 0;
    host.ctx.freeze = async () => { freezeCalls++; await frozen; return null; };

    await host.svc.create(spec('c1', host.ws), { trusted: true });
    host.svc.accept('c1', taskOf('A', 'c1', { required_capabilities: ['tool.read'] }));
    const pA = host.svc.execute('c1', null, {}).then((v) => ({ v }), (e) => ({ e: e.code }));
    await new Promise((r) => setTimeout(r, 20));

    let acceptB = null;
    try { host.svc.accept('c1', taskOf('B', 'c1', { required_capabilities: ['tool.write'] })); acceptB = 'ACCEPTED'; }
    catch (e) { acceptB = e.code; }
    const pB = host.svc.execute('c1', null, {}).then((v) => ({ v }), (e) => ({ e: e.code }));
    await new Promise((r) => setTimeout(r, 20));

    releaseFreeze();
    const [a, b] = await Promise.all([pA, pB]);

    const okPass = maxChats <= 1 && freezeCalls === 1
      && a.v?.execution_state === 'succeeded' && acceptB !== 'ACCEPTED';
    record('probe_race', okPass,
      `maxConcurrentChats=${maxChats} freezeCalls=${freezeCalls} acceptB=${acceptB} `
      + `A=${a.v?.execution_state ?? a.e} B=${b.v?.execution_state ?? b.e} writes=${reports.filter((r) => r.ok).length}`);
    return okPass;
  } finally { rmSync(base, { recursive: true, force: true }); }
}

// ── ② probe_persist_fail：首次执行状态持久化注入 EIO ───────────────────────────
async function probePersistFail() {
  const base = tmp();
  try {
    const host = await makeHost(base);
    host.ctx.onChat = async () => ({ reply: 'ok' });
    await host.svc.create(spec('c1', host.ws), { trusted: true });
    host.svc.accept('c1', taskOf('A', 'c1'));

    const real = host.rt._persist.bind(host.rt);
    let faults = 0;
    host.rt._persist = async (...a) => {
      faults++;
      if (faults === 1) throw Object.assign(new Error('simulated EIO at pre-dispatch persist'), { code: 'EIO' });
      return real(...a);
    };
    let err = null;
    try { await host.svc.execute('c1', null, {}); } catch (e) { err = e; }
    host.rt._persist = real;

    const st = host.svc.describe('c1');
    let acceptAgain = null;
    try { host.svc.accept('c1', taskOf('B', 'c1')); acceptAgain = 'ACCEPTED'; } catch (e) { acceptAgain = e.code; }
    const pass = err?.code === 'EIO' && st.state !== 'busy' && st.active_task_id == null && acceptAgain === 'ACCEPTED';
    record('probe_persist_fail', pass,
      `error=${err?.code} state=${st.state} active=${st.active_task_id} acceptAgain=${acceptAgain} faults=${faults}`);
    return pass;
  } finally { rmSync(base, { recursive: true, force: true }); }
}

// ── ③ probe_result_commit_fail：执行成功后结果追加注入 EIO ─────────────────────
async function probeResultCommit() {
  const base = tmp();
  try {
    const host = await makeHost(base);
    let chats = 0;
    host.ctx.onChat = async () => { chats++; return { reply: 'ok' }; };
    const fin = []; const unsettled = [];
    host.core.on('cell.task.finished', (e) => fin.push(e));
    host.core.on('cell.task.unsettled', (e) => unsettled.push(e));
    await host.svc.create(spec('c1', host.ws), { trusted: true });
    host.svc.accept('c1', taskOf('A', 'c1'));

    const real = host.rt._appendResult.bind(host.rt);
    host.rt._appendResult = async () => { throw Object.assign(new Error('simulated EIO at result append'), { code: 'EIO' }); };
    let err = null;
    try { await host.svc.execute('c1', null, {}); } catch (e) { err = e; }
    host.rt._appendResult = real;

    const pass = chats === 1 && err?.code === 'evidence_unavailable'
      && err?.execution_outcome?.state === 'succeeded'
      && err?.durability_outcome?.state === 'evidence_unavailable'
      && fin.length === 0 && unsettled.length === 1;
    record('probe_result_commit_fail', pass,
      `chats=${chats} error=${err?.code} exec_outcome=${err?.execution_outcome?.state} `
      + `durability=${err?.durability_outcome?.state} finished=${fin.length} unsettled=${unsettled.length}`);
    return pass;
  } finally { rmSync(base, { recursive: true, force: true }); }
}

// ── ④ probe_schema_getter：Schema getter 前两次合规、第三次给出 pattern ────────
async function probeSchemaGetter() {
  const { Core } = await imp('src/core/core.js');
  const core = new Core({ stateDir: join(tmp(), 'state') });
  core.log = () => {};
  let reads = 0;
  const schema = { required: ['x'] };
  Object.defineProperty(schema, 'properties', {
    enumerable: true,
    get() { reads++; return reads <= 2 ? { x: { type: 'string' } } : { x: { type: 'string', pattern: '^a+$' } }; },
  });
  let reg; let code = null;
  try { core.registerCapability('probe.getter', { owner: 'probe', handler: async (x) => x, input_schema: schema }); reg = 'ACCEPTED'; }
  catch (e) { reg = 'REJECTED'; code = e.code; }
  let call = null;
  try { call = await core.callCapability('probe.getter', { x: 'bbb' }); } catch (e) { call = { state: 'threw', code: e.code }; }
  const pass = reg === 'REJECTED' && code === 'declaration_not_pure_data'
    && reads === 0 && call?.state !== 'succeeded';
  record('probe_schema_getter', pass,
    `getterReads=${reads} registration=${reg}${code ? `(${code})` : ''} callState=${call?.state}`);
  return pass;
}

// ── ⑤ probe_multi_process：两进程共享 stateDir 同 ID ──────────────────────────
function childCreate(base, tag) {
  return new Promise((resolve) => {
    const code = `
      const base = ${JSON.stringify(base)}, tag = ${JSON.stringify(tag)};
      const { join } = await import('node:path');
      const { Core } = await import(${JSON.stringify(join(ROOT, 'src/core/core.js'))});
      const core = new Core({ stateDir: join(base, 'state') });
      core.log = () => {};
      core.setData('agent.workDir', join(base, 'ws'));
      await (await import(${JSON.stringify(join(ROOT, 'plugins/workspace.js'))})).default.init(core);
      await (await import(${JSON.stringify(join(ROOT, 'plugins/cell-runtime.js'))})).default.init(core);
      const Cls = (await import(${JSON.stringify(join(ROOT, 'plugins/tool-executor.js'))})).default.constructor;
      await new Cls().init(core);
      let out;
      try {
        const st = await core.getService('cell-runtime').create({ schema_version: 'tusunsun.cell/v0',
          cell_id: 'shared', workspace: join(base, 'ws'), capabilities: ['tool.read'], permission_mode: 'auto',
          runtime: { kind: 'process' }, limits: { max_active_tasks: 1, max_children: 0 } }, { trusted: true });
        out = { tag, ok: true, incarnation: st.incarnation_id };
      } catch (e) { out = { tag, ok: false, code: e.code }; }
      console.log(JSON.stringify(out));
      await new Promise((r) => setTimeout(r, 300));
    `;
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, encoding: 'utf8' });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', () => {
      const line = out.split('\n').find((l) => l.trim().startsWith('{'));
      try { resolve(JSON.parse(line)); } catch { resolve({ tag, ok: false, code: 'probe_error' }); }
    });
  });
}

async function probeMultiProcess() {
  const base = tmp();
  try {
    mkdirSync(join(base, 'ws'), { recursive: true });
    const [a, b] = await Promise.all([childCreate(base, 'A'), childCreate(base, 'B')]);
    const ok = [a, b].filter((x) => x.ok);
    const bad = [a, b].filter((x) => !x.ok);
    const pass = ok.length === 1 && bad.length === 1 && bad[0].code === 'state_dir_owned';
    record('probe_multi_process', pass,
      `ok=${ok.length} refused=${bad.length}${bad[0] ? `(${bad[0].code})` : ''} `
      + `incarnations=${[a, b].map((x) => x.incarnation || '-').join(',')}`);
    return pass;
  } finally { rmSync(base, { recursive: true, force: true }); }
}

let exitCode = 0;
try {
  await imp('src/core/core.js');
} catch (err) {
  console.log(`[NOT_RUN] 本形态缺 src/core：${err.code || err.message}`);
  process.exit(3);
}
console.log('专家 rc.31 源码级审查的五条反例（本包自带形态，路径不写死）：');
const all = [];
for (const fn of [probeRace, probePersistFail, probeResultCommit, probeSchemaGetter, probeMultiProcess]) {
  try { all.push(await fn()); }
  catch (err) {
    record(fn.name, false, `探针自身出错：${err?.code || err?.message}`);
    all.push(false);
  }
}
const passed = all.filter(Boolean).length;
console.log(`\n五条反例：${passed}/${all.length} 已被正确拒绝`);
if (passed !== all.length) exitCode = 1;
process.exit(exitCode);
