// rc.33 —— 专家 rc.32 源码级发布审查（R32-01～05）给出的五条新问题的一次性判据。
//
// 与 rc.32 那一批的共同点：每条都不是“把判据写严一点”，而是**换主语**。
//   R32-01  判据是“owner.lock 里的 pid 是不是我” ⇒ PID 相同只说明同一个进程，不说明同一个
//           属主；同进程两个 Core 双双 create 成功，各自相信自己独占同一批状态文件。
//   R32-02  判据是“模型执行结束了吗” ⇒ 执行结束 ≠ 已结算；结算窗口里下一笔已经开跑，
//           并把自己写成“最后一个任务”。
//   R32-03  判据是“内存里的 state 是不是 stopped” ⇒ 落盘一失败，第二次 close 直接回
//           `already:true`，而锁目录与工作区绑定全留在原地。
//   R32-04  判据是“追加这一行有没有抛错” ⇒ 写成功、确认丢失时，重试再写一行，一次执行变两条。
//   R32-05  判据是“`schema.properties` 第一层有没有非法关键字” ⇒ 根上的 `$ref`、以及深层
//           嵌套的 `properties.x.properties.admin.$ref` 被接收并执行成功。
//
// 边界（诚实）：
//   · 全部进程内直测（真 Core / 真 workspace / 真 cell-runtime / 真 tool-executor / 真写盘）；
//   · 故障注入走**受信任的测试桩**（覆写 `_persist` / `_appendResult`），与专家原件同一手法，
//     **不**声称模型能注入 Node 代码或安排自己的异步回调；
//   · 声明的“读取隔离”（getter/Proxy 不进权威记录）由 rc.32 的 C1 守，这里只守“支持面”。
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assert, assertEquals } from '../harness.mjs';

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

const task = (id, cellId = 'c1', over = {}) => ({
  schema_version: 'tusunsun.task/v0',
  task_id: id,
  attempt: 1,
  target_cell_id: cellId,
  goal: `goal ${id}`,
  inputs: [],
  required_capabilities: ['tool.read'],
  budget: { max_steps: 5, wall_ms: 30000 },
  acceptance: { required_artifacts: [], checks: [] },
  ...over,
});

const tmp = () => mkdtempSync(join(tmpdir(), 'rc33-owner-'));
const cellFile = (base, id = 'c1') => join(base, 'state', 'cells', id, 'cell.json');
const lockDir = (base) => join(base, 'state', 'cells', 'owner.lock');
const resultsFile = (base, id = 'c1') => join(base, 'state', 'cells', id, 'results.jsonl');
const readResults = (base, id = 'c1') => {
  const p = resultsFile(base, id);
  return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

/** 有界等待：旧代码上的“红”是挂住，而不是一条具名断言 —— 有上界才看得出是哪一条。 */
function withTimeout(promise, ms, what) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise).finally(() => { if (timer) clearTimeout(timer); }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`timeout ${ms}ms: ${what}`), { code: 'test_timeout' })), ms);
    }),
  ]);
}

async function waitFor(pred, ms = 3000, what = 'condition') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Object.assign(new Error(`timeout ${ms}ms waiting for ${what}`), { code: 'test_timeout' });
}

/** 真装配：一个 Core + workspace + tool-executor + cell-runtime。 */
async function makeHost(base) {
  const { Core } = await imp('src/core/core.js');
  const wsDir = join(base, 'ws');
  mkdirSync(wsDir, { recursive: true });
  const core = new Core({ stateDir: join(base, 'state') });
  core.log = () => {};
  core.setData('agent.workDir', wsDir);
  await (await imp('plugins/workspace.js')).default.init(core);
  core.registerCapability('tool.read', { owner: 'test', handler: async () => ({ ok: true }) });
  core.registerCapability('tool.write', { owner: 'test', handler: async () => ({ ok: true }) });
  core.registerCapability('chat.handle', { owner: 'test', handler: async () => ({ reply: 'ok' }) });
  const Cls = (await imp('plugins/tool-executor.js')).default.constructor;
  await new Cls().init(core);
  const rt = (await imp('plugins/cell-runtime.js')).default;
  await rt.init(core);
  const svc = core.getService('cell-runtime');
  return {
    core, wsDir, rt, svc,
    create: (over = {}, opts = {}) => svc.create(spec('c1', wsDir, over), { trusted: true, ...opts }),
    run: (taskId) => { svc.accept('c1', task(taskId)); return svc.execute('c1'); },
  };
}

/** 干净的 Core（只要 registerCapability，不需要任何插件）。 */
async function bareCore(base) {
  const { Core } = await imp('src/core/core.js');
  const core = new Core({ stateDir: join(base, 'state-schema') });
  core.log = () => {};
  return core;
}

const oncePersistThrow = (rt, when) => {
  const orig = rt._persist.bind(rt);
  let fired = false;
  rt._persist = async (core, rec) => {
    if (!fired && when(rec)) {
      fired = true;
      throw Object.assign(new Error('simulated EIO'), { code: 'EIO' });
    }
    return orig(core, rec);
  };
  return () => { rt._persist = orig; };
};

export default async function (runner) {
  // ══ E. R32-01：属主身份是 **Core 实例**，不是 pid ═══════════════════════════

  runner.test('rc.33/R32-01 同进程第二个 Core 争同一 stateDir：具名拒绝，落盘仍是第一个属主', async () => {
    const base = tmp();
    try {
      const h1 = await makeHost(base);
      const st1 = await h1.create();
      const h2 = await makeHost(base);          // 新 Core、同 stateDir、同 cell_id、同 workspace
      let err = null;
      try { await h2.create(); } catch (e) { err = e; }
      assertEquals(err?.code, 'state_dir_owned',
        `同进程两个 Core 争同一 stateDir 必须具名拒绝（专家 R32-01），实际 ${err?.code}`);
      assert(/another Core instance/.test(String(err.message)),
        `拒因必须说清“pid 相同不是属主相同”，实际：${err.message}`);
      const persisted = JSON.parse(readFileSync(cellFile(base), 'utf8'));
      assertEquals(persisted.incarnation_id, st1.incarnation_id,
        '落盘必须仍是被允许的那个属主（不得“最后写者赢”）');
      // 被拒的那一次不得在**自己的**登记表里留半成品
      assertEquals(h2.svc.list().length, 0, '被拒的 create 不得在第二个 Core 里留下半个 Cell');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.33/R32-01 1 Cell : 1 Core 不变式不被属主登记削弱：第二个 Cell 仍被拒，锁仍归第一个', async () => {
    const base = tmp();
    try {
      const h = await makeHost(base);
      await h.create();
      // rc.32 就有的 `cell_quota_exceeded` 不得因为新增属主登记而退步（属主登记管的是
      // “同一个 stateDir 有没有第二个 Core”，管不住这条；两条各管各的）。
      let err = null;
      try { await h.svc.create(spec('c2', h.wsDir), { trusted: true }); } catch (e) { err = e; }
      assertEquals(err?.code, 'cell_quota_exceeded',
        `v0 只允许 1 Cell : 1 Core，实际 ${err?.code ?? 'ACCEPTED'}`);
      assertEquals(existsSync(lockDir(base)), true, '被拒的第二个 Cell 不得动到第一个的锁');
      const closed = await h.svc.close('c1', {});
      assertEquals(closed.state_dir_released, true,
        `唯一的 Cell 退出必须真的把锁还回去，实际 ${JSON.stringify(closed)}`);
      assertEquals(existsSync(lockDir(base)), false, '释放之后锁目录必须消失（同 PID 重启才能拿到）');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.33/R32-01 被拒的第二个 Core 不留残留：第一个属主照样能正常收尾', async () => {
    const base = tmp();
    try {
      const h1 = await makeHost(base);
      await h1.create();
      const h2 = await makeHost(base);
      let err = null;
      try { await h2.create(); } catch (e) { err = e; }
      assert(err, '第二个 Core 必须被拒');
      // 拒绝不是“抢走”：第一个属主仍然占着锁，并且能正常 close 收尾
      assertEquals(existsSync(lockDir(base)), true, '被拒的一次不得改动第一个属主的锁');
      const closed = await h1.svc.close('c1', {});
      assertEquals(closed.cleanup_done, true, `第一个属主的 close 必须干净完成，实际 ${JSON.stringify(closed)}`);
      assertEquals(existsSync(lockDir(base)), false, '拒绝之后合法属主仍必须能释放锁');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  // ══ F. R32-02：结算窗口内仍然独占 ══════════════════════════════════════

  runner.test('rc.33/R32-02 A 还在结算时：accept 与 execute 都必须被拒，结果里只有 A（专家主反例）', async () => {
    const base = tmp();
    try {
      const h = await makeHost(base);
      await h.create();
      h.svc.accept('c1', task('A'));
      const origAppend = h.rt._appendResult.bind(h.rt);
      let release = null;
      const gate = new Promise((res) => { release = res; });
      let blocked = false;
      h.rt._appendResult = async (...args) => {
        if (!blocked) { blocked = true; await gate; }
        return origAppend(...args);
      };
      const pA = withTimeout(h.svc.execute('c1'), 8000, 'A 的结算')
        .then((x) => ({ ok: true, state: x.execution_state }), (e) => ({ ok: false, code: e.code }));
      await waitFor(() => blocked, 3000, 'A 进入结算窗口');
      const during = h.svc.describe('c1');
      assertEquals(during.state, 'busy',
        `结算期间 state 不得先回 ready（否则“可以接活”与“还在写结果”同时为真），实际 ${during.state}`);
      assertEquals(during.phase, 'settling', `结算阶段必须可观测，实际 ${during.phase}`);
      let accErr = null;
      try { h.svc.accept('c1', task('B')); } catch (e) { accErr = e; }
      assert(accErr && ['cell_busy', 'cell_not_ready'].includes(accErr.code),
        `结算期间 accept(B) 必须被具名拒绝（专家主反例），实际 ${accErr?.code ?? 'ACCEPTED'}`);
      let exErr = null;
      try { await h.svc.execute('c1'); } catch (e) { exErr = e; }
      assertEquals(exErr?.code, 'cell_busy', `结算期间 execute 必须被拒，实际 ${exErr?.code ?? 'RAN'}`);
      release();
      const outA = await pA;
      assertEquals(outA.ok, true, `A 自己必须正常结算，实际 ${JSON.stringify(outA)}`);
      assertEquals(readResults(base).map((r) => r.task_id).join(','), 'A',
        '结算窗口被独占 ⇒ results.jsonl 里不得出现插队的 B');
      assertEquals(h.svc.report('c1').last_result.task_id, 'A', 'last_result 不得被插队者覆盖');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.33/R32-02 结算完成之后下一个任务才能进：结果序与 last_result 一致', async () => {
    const base = tmp();
    try {
      const h = await makeHost(base);
      await h.create();
      const a = await withTimeout(h.run('A'), 8000, 'A');
      assertEquals(a.execution_state, 'succeeded');
      assertEquals(h.svc.describe('c1').phase, null, '结算完成后不得留着阶段标记（否则下一个任务永远进不来）');
      const b = await withTimeout(h.run('B'), 8000, 'B');
      assertEquals(b.execution_state, 'succeeded');
      assertEquals(readResults(base).map((r) => r.task_id).join(','), 'A,B',
        '结果行必须按**结算顺序**排列（A 先结算，所以 A 在前）');
      assertEquals(h.svc.report('c1').last_result.task_id, 'B', 'last_result 必须是最后一个结算完成的任务');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.33/R32-02 结算失败也必须交还占位：不得让 Cell 永久 busy', async () => {
    const base = tmp();
    try {
      const h = await makeHost(base);
      await h.create();
      const orig = h.rt._appendResult.bind(h.rt);
      h.rt._appendResult = async () => { throw Object.assign(new Error('disk full'), { code: 'EIO' }); };
      h.svc.accept('c1', task('A'));
      let err = null;
      try { await withTimeout(h.svc.execute('c1'), 8000, 'A'); } catch (e) { err = e; }
      assertEquals(err?.code, 'evidence_unavailable', `写证据失败必须具名（不是普通失败），实际 ${err?.code}`);
      h.rt._appendResult = orig;
      const d = h.svc.describe('c1');
      assertEquals(d.state, 'ready', `结算失败之后 Cell 必须能再被接活，实际 ${d.state}`);
      assertEquals(d.phase, null, `结算失败也必须交还占位，实际 phase=${d.phase}`);
      const b = await withTimeout(h.run('B'), 8000, 'B');
      assertEquals(b.execution_state, 'succeeded', '下一个任务必须真的能跑');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.33/R32-02 force close 打断结算：不得把 stopped 改回 ready', async () => {
    const base = tmp();
    try {
      const h = await makeHost(base);
      await h.create();
      h.svc.accept('c1', task('A'));
      const origAppend = h.rt._appendResult.bind(h.rt);
      let release = null;
      const gate = new Promise((res) => { release = res; });
      let blocked = false;
      h.rt._appendResult = async (...args) => {
        if (!blocked) { blocked = true; await gate; }
        return origAppend(...args);
      };
      const pA = withTimeout(h.svc.execute('c1'), 8000, 'A')
        .then((x) => ({ ok: true, state: x.execution_state }), (e) => ({ ok: false, code: e.code }));
      await waitFor(() => blocked, 3000, 'A 进入结算窗口');
      const closed = await h.svc.close('c1', { force: true });
      assertEquals(closed.closed, true, 'force close 必须能关掉一个正在结算的 Cell');
      release();
      await pA;
      assertEquals(h.svc.describe('c1').state, 'stopped',
        '结算收尾不得把 close 写下的 stopped 推翻成 ready（否则已关闭的 Cell 还能接任务）');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  // ══ G. R32-03：close 的“已关闭”= 清理完成 ══════════════════════════════

  runner.test('rc.33/R32-03 close 落盘失败：必须报 close_incomplete，不得回“已关闭”（专家主反例）', async () => {
    const base = tmp();
    try {
      const h = await makeHost(base);
      await h.create();
      const restore = oncePersistThrow(h.rt, (rec) => rec.state === 'stopped');
      let err = null;
      try { await h.svc.close('c1', {}); } catch (e) { err = e; }
      restore();
      assertEquals(err?.code, 'close_incomplete',
        `落盘失败时第二次 close 不得早退成 already:true；本次必须抛 close_incomplete，实际 ${err?.code ?? 'NO_THROW'}`);
      assertEquals(err.execution_revoked, true, '拒因必须说清“执行资格已撤销”（这一半是真的）');
      assert(Array.isArray(err.cleanup_pending) && err.cleanup_pending.includes('persist'),
        `必须报出还欠哪几步清理，实际 ${JSON.stringify(err.cleanup_pending)}`);
      assertEquals(h.svc.describe('c1').state, 'stopped', '执行资格确实撤销了：state 必须是 stopped');
      assertEquals(existsSync(lockDir(base)), true, '清理没做完 ⇒ 锁必须还在（否则第二个进程能插手）');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.33/R32-03 重试 close 会接着做完：锁真的被释放，之后才 already:true', async () => {
    const base = tmp();
    try {
      const h = await makeHost(base);
      await h.create();
      const restore = oncePersistThrow(h.rt, (rec) => rec.state === 'stopped');
      try { await h.svc.close('c1', {}); } catch { /* 第一次失败是前提 */ }
      restore();
      const second = await h.svc.close('c1', {});
      assertEquals(second.already, false, '上一次没做完清理 ⇒ 这一次不得声称“早就关了”');
      assertEquals(second.cleanup_done, true, `重试必须把清理做完，实际 ${JSON.stringify(second)}`);
      assertEquals(second.state_dir_released, true, '重试必须真的释放属主锁');
      assertEquals(existsSync(lockDir(base)), false, '重试之后锁目录必须消失');
      const third = await h.svc.close('c1', {});
      assertEquals(third.already, true, '清理真的做完之后才允许 already:true');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.33/R32-03 rename 已生效但确认丢了：读回 closed_at 判定，一次 close 就收尾', async () => {
    const base = tmp();
    try {
      const h = await makeHost(base);
      await h.create();
      const orig = h.rt._persist.bind(h.rt);
      let fired = false;
      h.rt._persist = async (core, rec) => {
        const out = await orig(core, rec);
        if (!fired && rec.state === 'stopped') { fired = true; throw Object.assign(new Error('ack lost after rename'), { code: 'EIO' }); }
        return out;
      };
      const closed = await h.svc.close('c1', {});
      h.rt._persist = orig;
      assertEquals(closed.cleanup_done, true,
        `写成功、确认丢失时不得把“已落盘”判成“没落盘”（读回 closed_at 回答这件事），实际 ${JSON.stringify(closed)}`);
      assertEquals(closed.state_dir_released, true, '既然已落盘，清理就必须走完并释放锁');
      assertEquals(existsSync(lockDir(base)), false, '锁必须被释放');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  // ══ H. R32-04：结果记录的**逻辑身份** ═══════════════════════════════════

  runner.test('rc.33/R32-04 追加成功但确认丢失：只留一条记录，并标 recovered=readback（专家主反例）', async () => {
    const base = tmp();
    try {
      const h = await makeHost(base);
      await h.create();
      const orig = h.rt._appendResult.bind(h.rt);
      let fired = false;
      h.rt._appendResult = async (...args) => {
        const out = await orig(...args);
        if (!fired) { fired = true; throw Object.assign(new Error('ack lost after append'), { code: 'EIO' }); }
        return out;
      };
      const out = await withTimeout(h.run('C'), 8000, 'C');
      h.rt._appendResult = orig;
      assertEquals(out.durability_outcome.state, 'persisted', '确认丢失不等于没写进去');
      assertEquals(out.durability_outcome.recovered, 'readback',
        `必须说清“是读回发现的”（否则读的人不知道重试有没有再写一行），实际 ${JSON.stringify(out.durability_outcome)}`);
      const rows = readResults(base).filter((r) => r.task_id === 'C');
      assertEquals(rows.length, 1, `一次执行不得出现两条完成记录（专家主反例：实测曾为 2 条），实际 ${rows.length}`);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.33/R32-04 resultRecords 按 record_id 归并：坏行单独计数，不静默丢', async () => {
    const base = tmp();
    try {
      const h = await makeHost(base);
      await h.create();
      mkdirSync(join(base, 'state', 'cells', 'c1'), { recursive: true });
      writeFileSync(resultsFile(base), [
        JSON.stringify({ record_id: 'x:1#1', task_id: 'X' }),
        JSON.stringify({ record_id: 'x:1#1', task_id: 'X' }),   // 同一笔写了两次
        '{"record_id":"broken"',                                 // 半行：坏行
        JSON.stringify({ task_id: 'legacy' }),                  // 旧行：没有 record_id
      ].join('\n') + '\n');
      const r = await h.svc.resultRecords('c1');
      assertEquals(r.raw_lines, 4, `原始行数必须如实报（行数不是完成次数），实际 ${r.raw_lines}`);
      assertEquals(r.duplicate_lines, 1, `必须报出被归并掉的重复行数，实际 ${r.duplicate_lines}`);
      assertEquals(r.unreadable_lines, 1, `坏行必须单独计数（“写坏了”与“没写过”不是一回事），实际 ${r.unreadable_lines}`);
      assertEquals(r.records.length, 2, '归并后 = 1 笔去重结果 + 1 条旧行（不得给旧行补一个假 id）');
      assertEquals(r.records.filter((x) => x.record_id === 'x:1#1').length, 1, '同一 record_id 只能出现一次');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.33/R32-04 半行文件不会把下一行粘坏', async () => {
    const base = tmp();
    try {
      const h = await makeHost(base);
      await h.create();
      mkdirSync(join(base, 'state', 'cells', 'c1'), { recursive: true });
      writeFileSync(resultsFile(base), '{"record_id":"x:1#1"');   // 崩在半行，且没有换行
      await h.rt._appendResult(h.core, { spec: { cell_id: 'c1' } }, { record_id: 'y:2#1' });
      const lines = readFileSync(resultsFile(base), 'utf8').split('\n').filter(Boolean);
      assertEquals(lines.length, 2, '半行 + 新行必须是两行（直接 append 会粘成一行都读不出来）');
      // 半行本身仍然坏着 —— 那正是“崩在半行”的事实，补一个假尾巴才是造假；
      // 这里要证明的是**它没有把下一行吞掉**。
      assertEquals(lines[0], '{"record_id":"x:1#1"', '半行不得被改写（坏就如实坏着）');
      assertEquals(JSON.parse(lines[1]).record_id, 'y:2#1', '新行必须独立成行、可解析');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  // ══ I. R32-05：schema 支持面是**整棵树的白名单** ═══════════════════════

  runner.test('rc.33/R32-05 根级 $ref：登记成功，但必须记成未生效约束（专家主反例之一）', async () => {
    const base = tmp();
    try {
      const core = await bareCore(base);
      const warns = [];
      core.log = (level, msg) => { if (level === 'warn') warns.push(String(msg)); };
      core.registerCapability('probe.root_ref', {
        owner: 'test', handler: async (x) => x,
        input_schema: { required: ['x'], properties: { x: { type: 'string' } }, $ref: '#/unsupported' },
      });
      const rec = core._capabilities.get('probe.root_ref');
      const kw = (rec?.schema_unvalidated || []).map((i) => i.keyword);
      assert(kw.includes('$ref'), `未生效约束必须点名 $ref（专家实测：rc.32 接收了但没任何标记），实际 ${JSON.stringify(kw)}`);
      assert(warns.some((w) => /\$ref/.test(w)), `必须留下具名告警，实际 ${JSON.stringify(warns)}`);
      const row = core.listCapabilities().find((c) => c.id === 'probe.root_ref');
      assert(row?.schema_unvalidated?.includes('$ref'), 'listCapabilities 必须能枚举出 $ref 未生效');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.33/R32-05 深层嵌套的 $ref：登记成功但指出在哪一层未生效（专家主反例之二）', async () => {
    const base = tmp();
    try {
      const core = await bareCore(base);
      core.registerCapability('probe.nested_ref', {
        owner: 'test', handler: async (x) => x,
        input_schema: { required: ['x'], properties: { x: { type: 'object', properties: { admin: { $ref: '#/unsupported' } } } } },
      });
      const issues = core._capabilities.get('probe.nested_ref')?.schema_unvalidated || [];
      assert(issues.some((i) => i.path === '$.properties.x'),
        `未生效位置必须是 $.properties.x（指出在哪一层），实际 ${JSON.stringify(issues.map((i) => i.path))}`);
      assert(issues.some((i) => i.keyword === 'properties'), '必须点名 properties（本内核不递归校验子结构）');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.33/R32-05 属性子表的 pattern / enum / items / 嵌套 properties：登记成功并逐条点名', async () => {
    const base = tmp();
    try {
      const core = await bareCore(base);
      const bad = {
        pattern: { type: 'string', pattern: '^a+$' },
        enum: { type: 'string', enum: ['a', 'b'] },
        items: { type: 'array', items: [] },
        nested: { type: 'object', properties: { inner: { type: 'string' } } },
      };
      for (const [label, sub] of Object.entries(bad)) {
        const id = `probe.sub.${label}`;
        core.registerCapability(id, {
          owner: 'test', handler: async (x) => x,
          input_schema: { type: 'object', properties: { s: sub } },
        });
        const issues = core._capabilities.get(id)?.schema_unvalidated || [];
        assert(issues.length > 0, `属性子表里的 '${label}' 必须被记成未生效约束，实际没有任何记录`);
        assert(issues.every((i) => i.path === '$.properties.s'),
          `'${label}' 未生效位置必须是 $.properties.s，实际 ${JSON.stringify(issues.map((i) => i.path))}`);
        // 能判的部分必须仍在判：type 声明照常生效（否则“登记成功”就变成了“什么都不管”）。
        const r = await core.callCapability(id, { s: 123 });
        assert(r.ok === false, `'${label}' 的 type 约束必须仍然生效（123 不是 ${sub.type}），实际 ${r.code || r.state || 'ok'}`);
      }
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.33/R32-05 合法旧 schema 照常生效：接受 + 真的执行校验', async () => {
    const base = tmp();
    try {
      const core = await bareCore(base);
      let called = 0;
      core.registerCapability('probe.good', {
        owner: 'test',
        input_schema: { type: 'object', required: ['n'], properties: { n: { type: 'integer' }, s: { type: 'string' } } },
        handler: async (x) => { called++; return x; },
      });
      const ok = await core.callCapability('probe.good', { n: 1, s: 'a' });
      assertEquals(ok.ok, true, `合法参数必须放行，实际 ${JSON.stringify(ok)}`);
      const bad = await core.callCapability('probe.good', { n: 1.5 });
      assertEquals(bad.ok, false, 'integer 必须严格：1.5 不得放行');
      assertEquals(bad.code, 'invalid_input', `拒因必须是 invalid_input，实际 ${bad.code}`);
      assertEquals(called, 1, '被拒的调用不得执行 handler');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.33/R32-05 additionalProperties 允许出现但不执行约束（合同写明的 no-op）', async () => {
    const base = tmp();
    try {
      const core = await bareCore(base);
      core.registerCapability('probe.ap', {
        owner: 'test',
        input_schema: { type: 'object', properties: { n: { type: 'number' } }, additionalProperties: false },
        handler: async (x) => x,
      });
      const r = await core.callCapability('probe.ap', { n: 1, extra: 'still allowed' });
      assertEquals(r.ok, true,
        '合同明写“只允许出现、不参与校验”：不得把它当已支持的约束（也不得因为出现它就拒绝声明）');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.33/R32-05 形状错误：登记成功但逐条记成 schema 问题（含具名 code）', async () => {
    const base = tmp();
    try {
      const core = await bareCore(base);
      const cases = {
        required_is_string: { required: 'n', properties: { n: { type: 'number' } } },
        required_duplicated: { required: ['n', 'n'], properties: { n: { type: 'number' } } },
        required_has_empty: { required: [''], properties: { n: { type: 'number' } } },
        type_conflict: { type: 'string', properties: { n: { type: 'number' } } },
        bad_property_type: { properties: { n: { type: 'not-a-type' } } },
        bad_additional: { properties: {}, additionalProperties: 'no' },
      };
      for (const [label, schema] of Object.entries(cases)) {
        const id = `probe.bad.${label}`;
        core.registerCapability(id, { owner: 'test', handler: async () => 1, input_schema: schema });
        const issues = core._capabilities.get(id)?.schema_unvalidated || [];
        assert(issues.length > 0, `'${label}' 必须被记成未生效约束（不得静默接受），实际无记录`);
        assert(issues.every((i) => /^schema_(invalid|unsupported)$/.test(i.code)),
          `'${label}' 的 code 必须具名，实际 ${JSON.stringify(issues.map((i) => i.code))}`);
      }
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('rc.33/R32-05 读取隔离不退化：getter / Proxy 仍在进入 schema 校验之前被拒', async () => {
    const base = tmp();
    try {
      const core = await bareCore(base);
      let reads = 0;
      const withGetter = { type: 'object', properties: {} };
      Object.defineProperty(withGetter.properties, 'x', {
        enumerable: true,
        get() { reads++; return { type: 'string' }; },
      });
      let err = null;
      try { core.registerCapability('probe.getter', { owner: 'test', handler: async () => 1, input_schema: withGetter }); } catch (e) { err = e; }
      assert(err != null, 'getter 声明必须被拒');
      assertEquals(err.code, 'declaration_not_pure_data',
        `拒因必须是“声明不是纯数据”（这一条由 rc.32 C1 的冻结快照回答），实际 ${err.code}`);
      assertEquals(reads, 0, `一次性冻结快照不得把 getter **读进去**，实际读了 ${reads} 次`);
      const proxy = new Proxy({ type: 'object', properties: { s: { type: 'string' } } }, {});
      let perr = null;
      try { core.registerCapability('probe.proxy', { owner: 'test', handler: async () => 1, input_schema: proxy }); } catch (e) { perr = e; }
      assert(perr != null, 'Proxy 声明必须被拒');
      assertEquals(perr.code, 'declaration_not_pure_data', `Proxy 的拒因同类，实际 ${perr.code}`);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
}
