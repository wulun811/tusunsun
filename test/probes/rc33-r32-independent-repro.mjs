#!/usr/bin/env node
// rc.33 —— 把专家 rc.32 源码级发布审查给的**五份独立反例**做成随包可跑的探针。
//
// 为什么另起一份而不是改 rc.32 那份：这是**新的一批**反例（R32-01～05），它们问的是另一组
// 问题（属主身份 / 结算窗口 / 关闭清理 / 记录逻辑身份 / schema 支持面）。把两批混成一个
// 退出码，会让“上一批还绿着”掩盖“这一批红了”。
//
// 与专家原件的关系：保留他**要证明的那件事**，把环境相关部分换成本包自带的形态：
//   · 路径从 `import.meta.url` 推（不写死任何人的目录）；
//   · 故障注入用覆写 `_persist` / `_appendResult`，与原件同一手法（他用的也是同进程合法接口）；
//   · 判据逐字段核对，不只看“没抛错”。
//
// 退出码：0 = 五条都被正确拒绝；1 = 有反例仍然成立；3 = 本形态跑不了（缺 core 等）。
// 发布门禁会自动发现它（`scripts/release-gate.mjs` 扫描 `test/probes/*.mjs`）。
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
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

const tmp = () => mkdtempSync(join(tmpdir(), 'rc33-probe-'));

async function makeHost(base) {
  const { Core } = await imp('src/core/core.js');
  const ws = join(base, 'ws');
  mkdirSync(ws, { recursive: true });
  const core = new Core({ stateDir: join(base, 'state') });
  core.log = () => {};
  core.setData('agent.workDir', ws);
  await (await imp('plugins/workspace.js')).default.init(core);
  core.registerCapability('tool.read', { owner: 'probe', handler: async () => ({ ok: true }) });
  core.registerCapability('tool.write', { owner: 'probe', handler: async () => ({ ok: true }) });
  core.registerCapability('chat.handle', { owner: 'probe', handler: async () => ({ reply: 'ok' }) });
  const Cls = (await imp('plugins/tool-executor.js')).default.constructor;
  await new Cls().init(core);
  const rt = (await imp('plugins/cell-runtime.js')).default;
  await rt.init(core);
  return { core, ws, rt, svc: core.getService('cell-runtime') };
}

const waitFor = async (pred, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return true; await new Promise((r) => setTimeout(r, 10)); }
  return false;
};

/** R32-01：同 PID 两个 Core 争同一个 stateDir —— 最多一个活属主。 */
async function probeSamePidTwoCores() {
  const base = tmp();
  try {
    const a = await makeHost(base);
    const b = await makeHost(base);
    const tryCreate = async (h) => {
      try { const st = await h.svc.create(spec('c1', h.ws), { trusted: true }); return { ok: true, state: st.state, inc: st.incarnation_id }; }
      catch (e) { return { ok: false, code: e.code }; }
    };
    const ea = await tryCreate(a);
    const eb = await tryCreate(b);
    const ok = [ea, eb].filter((x) => x.ok);
    const bad = [ea, eb].filter((x) => !x.ok);
    const persisted = existsSync(join(base, 'state', 'cells', 'c1', 'cell.json'))
      ? JSON.parse(readFileSync(join(base, 'state', 'cells', 'c1', 'cell.json'), 'utf8')) : null;
    const pass = ok.length === 1 && bad.length === 1 && bad[0].code === 'state_dir_owned'
      && persisted && persisted.incarnation_id === ok[0].inc;
    record('probe_same_pid_two_cores', pass,
      `ok=${ok.length} refused=${bad.length}${bad[0] ? `(${bad[0].code})` : ''} `
      + `persisted=${persisted?.incarnation_id === ok[0]?.inc ? 'winner' : 'MISMATCH'}`);
    return pass;
  } finally { rmSync(base, { recursive: true, force: true }); }
}

/** R32-02：A 还在结算，B 不得接进来；结果行里只有 A，last_result 不得翻回 A。 */
async function probeSettlementWindow() {
  const base = tmp();
  try {
    const h = await makeHost(base);
    await h.svc.create(spec('c1', h.ws), { trusted: true });
    h.svc.accept('c1', taskOf('A'));
    const orig = h.rt._appendResult.bind(h.rt);
    let release = null;
    const gate = new Promise((r) => { release = r; });
    let blocked = false;
    h.rt._appendResult = async (...args) => {
      if (!blocked) { blocked = true; await gate; }
      return orig(...args);
    };
    const pA = h.svc.execute('c1').then((x) => ({ ok: true, state: x.execution_state }), (e) => ({ ok: false, code: e.code }));
    const entered = await waitFor(() => blocked);
    let acceptedB = null;
    try { h.svc.accept('c1', taskOf('B')); acceptedB = 'ACCEPTED'; } catch (e) { acceptedB = e.code; }
    let execB = null;
    try { await h.svc.execute('c1'); execB = 'RAN'; } catch (e) { execB = e.code; }
    const during = h.svc.describe('c1');
    release();
    const outA = await pA;
    const rows = existsSync(join(base, 'state', 'cells', 'c1', 'results.jsonl'))
      ? readFileSync(join(base, 'state', 'cells', 'c1', 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).task_id)
      : [];
    const last = h.svc.report('c1').last_result?.task_id;
    const pass = entered && acceptedB !== 'ACCEPTED' && execB !== 'RAN'
      && during.state === 'busy' && outA.ok && rows.length === 1 && rows[0] === 'A' && last === 'A';
    record('probe_settlement_window', pass,
      `entered=${entered} acceptB=${acceptedB} execB=${execB} during=${during.state}/${during.phase} `
      + `rows=${rows.join(',')} last=${last}`);
    return pass;
  } finally { rmSync(base, { recursive: true, force: true }); }
}

/** R32-04：追加成功但确认丢失 —— 重试不得再写一行。 */
async function probeAppendAckLost() {
  const base = tmp();
  try {
    const h = await makeHost(base);
    await h.svc.create(spec('c1', h.ws), { trusted: true });
    const orig = h.rt._appendResult.bind(h.rt);
    let fired = false;
    h.rt._appendResult = async (...args) => {
      const out = await orig(...args);
      if (!fired) { fired = true; throw Object.assign(new Error('ack lost after append'), { code: 'EIO' }); }
      return out;
    };
    h.svc.accept('c1', taskOf('C'));
    const out = await h.svc.execute('c1');
    h.rt._appendResult = orig;
    const rows = readFileSync(join(base, 'state', 'cells', 'c1', 'results.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.task_id === 'C');
    const ids = new Set(rows.map((r) => r.record_id));
    const pass = out.durability_outcome?.state === 'persisted' && rows.length === 1 && ids.size === 1;
    record('probe_append_ack_lost', pass,
      `durability=${out.durability_outcome?.state}/${out.durability_outcome?.recovered ?? '-'} `
      + `rows=${rows.length} distinct_ids=${ids.size}`);
    return pass;
  } finally { rmSync(base, { recursive: true, force: true }); }
}

/** R32-03：关闭落盘失败 —— 必须报 close_incomplete 且可重试，不得回“已关闭”。 */
async function probeClosePersistFail() {
  const base = tmp();
  try {
    const h = await makeHost(base);
    await h.svc.create(spec('c1', h.ws), { trusted: true });
    const lockDir = join(base, 'state', 'cells', 'owner.lock');
    const orig = h.rt._persist.bind(h.rt);
    let fired = false;
    h.rt._persist = async (core, rec) => {
      if (!fired && rec.state === 'stopped') { fired = true; throw Object.assign(new Error('close EIO'), { code: 'EIO' }); }
      return orig(core, rec);
    };
    let firstClose = null;
    try { await h.svc.close('c1', {}); firstClose = 'NO_THROW'; } catch (e) { firstClose = e.code; }
    const lockAfterFirst = existsSync(lockDir);
    h.rt._persist = orig;
    let second = null;
    try { second = await h.svc.close('c1', {}); } catch (e) { second = { error: e.code }; }
    const pass = firstClose === 'close_incomplete' && lockAfterFirst === true
      && second?.cleanup_done === true && existsSync(lockDir) === false;
    record('probe_close_persist_fail', pass,
      `firstClose=${firstClose} lockLeft=${lockAfterFirst} second=${second?.cleanup_done ? 'cleanup_done' : JSON.stringify(second)} `
      + `lockGone=${!existsSync(lockDir)}`);
    return pass;
  } finally { rmSync(base, { recursive: true, force: true }); }
}

/** R32-05：schema 支持面是整棵树的白名单。 */
async function probeSchemaWhitelist() {
  const base = tmp();
  try {
    const { Core } = await imp('src/core/core.js');
    const core = new Core({ stateDir: join(base, 'state-schema') });
    core.log = () => {};
    const cases = {
      root_ref: { required: ['x'], properties: { x: { type: 'string' } }, $ref: '#/unsupported' },
      nested_ref: { required: ['x'], properties: { x: { type: 'object', properties: { admin: { $ref: '#/unsupported' } } } } },
      sub_pattern: { properties: { s: { type: 'string', pattern: '^a+$' } } },
    };
    const out = {};
    for (const [label, schema] of Object.entries(cases)) {
      try {
        core.registerCapability(`probe.${label}`, { owner: 'probe', handler: async (x) => x, input_schema: schema });
        out[label] = 'ACCEPTED';
      } catch (e) { out[label] = e.code || String(e.message).slice(0, 40); }
    }
    const pass = Object.values(out).every((v) => v !== 'ACCEPTED');
    record('probe_schema_whitelist', pass,
      Object.entries(out).map(([k, v]) => `${k}=${v}`).join(' '));
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
console.log('专家 rc.32 源码级审查的五条独立反例（本包自带形态，路径不写死）：');
const all = [];
for (const fn of [probeSamePidTwoCores, probeSettlementWindow, probeAppendAckLost, probeClosePersistFail, probeSchemaWhitelist]) {
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
