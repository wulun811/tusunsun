// rc.36 —— 专家 rc.35 裁决唯一新缺陷 R35-P2-A 的判据与五组对照。
//
// P2-A：同一个 Cell 上两条并发 `close()` 各自越过入口的 `cleanupDone` 检查（其间隔着
// `await _persist()`），随后共用同一张清理责任表，于是**同一次关闭完成**被发表两遍：
// 两条回执都是 `closed:true, already:false`，`cell.closed` 发 2 次。裁决给的分级是 P2
// ——它没有造成越权或锁残留，但「关完了」这个事实从此不唯一。
//
// 修法是把关闭结算做成**单飞**：一条在飞，其余排队；轮到后者时若已关完就走 already。
// 排队而非合并的理由是 force 不能被别人的非 force 结算吞掉（第 4 组钉住这一条）。
// 事件与回执都带 `close_id` / `incarnation_id` / `closed_at`，消费方可按身份去重。
//
// 五组对照（裁决 §4 建议的三组 + 两个边界）：
//   1 无执行器纯对话并发 close → 一次完成 + 一次 already，cell.closed 恰 1 次；
//   2 有执行器并发 close     → 同上，且钩子/租约确证为零；
//   3 三条同时 close         → 仍只有 1 次完成事件，另两条都是 already；
//   4 close 与 force close 交错 → force 不被吞：它拿到的那次结算确实是 force 语义；
//   5 EIO 后并发重试         → 失败那次链不卡死，重试仍能接着做完且只发一次。
//
// 边界（诚实）：全部进程内直测（真 Core / 真 workspace / 真 cell-runtime / 真写盘）。
// 「并发」指同一事件循环内的多条 await 路径，不是多线程抢占；不声称分布式 exactly-once。
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assert, assertEquals } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(join(ROOT, rel));

const tmp = (tag) => mkdtempSync(join(tmpdir(), `rc36-${tag}-`));
const lockDir = (base) => join(base, 'state', 'cells', 'owner.lock');
const OWNER = 'cell:c1';

const specOf = (workspace, over = {}) => ({
  schema_version: 'tusunsun.cell/v0',
  cell_id: 'c1',
  workspace,
  capabilities: ['tool.read'],
  permission_mode: 'auto',
  runtime: { kind: 'process' },
  limits: { max_active_tasks: 1, max_children: 0 },
  ...over,
});

const taskOf = (id) => ({
  schema_version: 'tusunsun.task/v0',
  task_id: id,
  attempt: 1,
  target_cell_id: 'c1',
  goal: `goal ${id}`,
  inputs: [],
  required_capabilities: [],
  budget: { max_steps: 3, wall_ms: 10000 },
  acceptance: { required_artifacts: [], checks: [] },
});

/** 真装配：Core + workspace +（可选）tool-executor + cell-runtime。 */
async function host(base, { executor = 'ok', chat } = {}) {
  const { Core } = await imp('src/core/core.js');
  const wsDir = join(base, 'ws');
  mkdirSync(wsDir, { recursive: true });
  const core = new Core({ stateDir: join(base, 'state') });
  core.log = () => {};
  core.setData('agent.workDir', wsDir);
  await (await imp('plugins/workspace.js')).default.init(core);
  core.registerCapability('chat.handle', { owner: 'test', handler: chat || (async () => ({ reply: 'ok' })) });
  core.registerCapability('tool.read', { owner: 'test', handler: async () => ({ ok: true }) });
  let exec = null;
  if (executor === 'ok') {
    const Cls = (await imp('plugins/tool-executor.js')).default.constructor;
    exec = new Cls();
    await exec.init(core);
  }
  const rt = (await imp('plugins/cell-runtime.js')).default;
  await rt.init(core);
  const events = { closed: 0, closing: 0, payloads: [] };
  core.on('cell.closed', (x) => { events.closed++; events.payloads.push(x); });
  core.on('cell.closing', () => { events.closing++; });
  const svc = core.getService('cell-runtime');
  return {
    core, exec, events, svc, rt,
    create: (over = {}) => svc.create(specOf(wsDir, over), { trusted: true }),
    hooks: () => (exec ? exec.hookCountFor(OWNER) : null),
  };
}

/** 计数：一次完成事件，且每条回执都闭到同一份事实。 */
function assertSingleCompletion(facts, events) {
  assertEquals(events.closed, 1,
    `一次关闭只许发一次 cell.closed，实际 ${events.closed} 次（重复发表 = 完成事实不唯一）`);
  const done = facts.filter((f) => f.closed === true);
  assertEquals(facts.length, done.length, '每条回执都必须是 closed:true（都已关完）');
  const firsts = done.filter((f) => f.already === false);
  assertEquals(firsts.length, 1, `「亲手关完」只许一次，实际 ${firsts.length} 次`);
  const ids = new Set(done.map((f) => f.close_id));
  assertEquals(ids.size, 1, `同一世只有一份关闭身份，实际 ${JSON.stringify([...ids])}`);
  assert(done[0].close_id, 'close_id 必须存在（消费方要靠它去重，而不是靠墙钟）');
  assert(done[0].incarnation_id, 'incarnation_id 必须存在');
}

export default async function (runner) {
  // ═══════════════════════════════════════════════════════════════════
  // 1 无执行器纯对话：并发 close
  // ═══════════════════════════════════════════════════════════════════
  runner.test('P2-A/1 无执行器：两条并发 close 只产生一次关闭完成，第二条是 already', async () => {
    const base = tmp('a1');
    try {
      const h = await host(base, { executor: 'none' });
      await h.create({ capabilities: [] });
      const facts = await Promise.all([h.svc.close('c1'), h.svc.close('c1')]);
      assertSingleCompletion(facts, h.events);
      assertEquals(facts.filter((f) => f.already === true).length, 1, '恰好一条走 already');
      assertEquals(h.events.payloads[0].close_id, facts[0].close_id, '事件与回执必须指同一份关闭身份');
      assertEquals(existsSync(lockDir(base)), false, '属主锁必须真的没了');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  // ═══════════════════════════════════════════════════════════════════
  // 2 有执行器：并发 close，且清理必须真到位
  // ═══════════════════════════════════════════════════════════════════
  runner.test('P2-A/2 有执行器：并发 close 仍只完成一次，且钩子/租约确证为零', async () => {
    const base = tmp('a2');
    try {
      const h = await host(base, { executor: 'ok' });
      await h.create();
      assertEquals(h.hooks().pre > 0, true, '前提：门真的装上了');
      const facts = await Promise.all([h.svc.close('c1'), h.svc.close('c1')]);
      assertSingleCompletion(facts, h.events);
      const after = h.hooks();
      assertEquals(after.pre, 0, '门必须真的拆掉');
      assertEquals(after.dispatch, 0, '派发钩子必须真的拆掉');
      assertEquals(h.exec.guardLeasesFor('cell-c1').filter((l) => l.live).length, 0, '租约不许残留');
      assertEquals(existsSync(lockDir(base)), false, '属主锁必须真的没了');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  // ═══════════════════════════════════════════════════════════════════
  // 3 三条同时：队列不是「只挡两条」
  // ═══════════════════════════════════════════════════════════════════
  runner.test('P2-A/3 三条并发 close：仍只有一次完成事件，另两条都是 already', async () => {
    const base = tmp('a3');
    try {
      const h = await host(base, { executor: 'none' });
      await h.create({ capabilities: [] });
      const facts = await Promise.all([h.svc.close('c1'), h.svc.close('c1'), h.svc.close('c1')]);
      assertSingleCompletion(facts, h.events);
      assertEquals(facts.filter((f) => f.already === true).length, 2, '后两条都是 already');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  // ═══════════════════════════════════════════════════════════════════
  // 4 close 与 force close 交错：force 不许被吞
  // ═══════════════════════════════════════════════════════════════════
  runner.test('P2-A/4 close 与 force close 交错：在飞时 force 不得被前一条结算吞掉', async () => {
    const base = tmp('a4');
    try {
      // 用一条被闩住的 handler 造「真在飞」：`execute()` 不会自己结束。
      let release = null;
      const latched = new Promise((r) => { release = r; });
      const h = await host(base, { executor: 'none', chat: async () => { await latched; return { reply: 'ok' }; } });
      await h.create({ capabilities: [] });
      h.svc.accept('c1', taskOf('T-busy'));
      const inflight = h.svc.execute('c1').catch(() => {});
      await new Promise((r) => setTimeout(r, 60));
      // ① 非 force 在飞必须被**拒**（cell_busy），而不是排进队列假装还会关。
      let plain = null;
      try { plain = await h.svc.close('c1'); } catch (err) { plain = { error: err.code }; }
      assertEquals(plain?.error, 'cell_busy', '在飞时非 force 必须被拒（不是被排队吞掉）');
      // ② force 穿过：撤销立刻生效，但清理还没完成 —— 不许发 cell.closed。
      const forced = await h.svc.close('c1', { force: true, quiesceMs: 150 });
      assertEquals(forced.execution_revoked, true, 'force 必须真的撤销执行资格');
      assertEquals(forced.closed, false, '在飞链没静默 ⇒ 不许 closed:true');
      assertEquals(forced.closing, true, '在飞 ⇒ closing:true');
      assertEquals(h.events.closed, 0, '清理没完成，cell.closed 一次都不能发');
      // ③ 静默之后重试才真闭合，且整轮仍只有一次完成事件。
      release();
      await inflight;
      const after = await h.svc.close('c1', { force: true, quiesceMs: 2000 });
      assertEquals(after.closed, true, '静默后重试必须关完');
      assertEquals(h.events.closed, 1, `整轮只许一次完成事件，实际 ${h.events.closed} 次`);
      const again = await h.svc.close('c1');
      assertEquals(again.already, true, '再关是 already');
      assertEquals(h.events.closed, 1, 'already 不得再发事件');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  // ═══════════════════════════════════════════════════════════════════
  // 5 EIO 后并发重试：失败的链不许把后续调用卡死
  // ═══════════════════════════════════════════════════════════════════
  runner.test('P2-A/5 落盘 EIO 后并发重试：失败链不卡死，重试接着做完且只发一次', async () => {
    const base = tmp('a5');
    try {
      const h = await host(base, { executor: 'none' });
      await h.create({ capabilities: [] });
      const orig = h.rt._persist.bind(h.rt);
      let failNext = true;
      // 只劫持一次 cell.json 的落盘：让第一次结算以 close_incomplete 结束。
      h.rt._persist = async (core, rec) => {
        if (failNext) { failNext = false; throw Object.assign(new Error('EIO: injected'), { code: 'EIO' }); }
        return orig(core, rec);
      };
      let failed = null;
      try { await h.svc.close('c1'); } catch (err) { failed = err; }
      h.rt._persist = orig;
      assertEquals(failed?.code, 'close_incomplete', '第一次必须具名失败，不许伪 closed:true');
      // 失败之后**并发**重试两条：链不能因为上一轮抛错而永久卡住。
      const facts = await Promise.all([h.svc.close('c1'), h.svc.close('c1')]);
      assertSingleCompletion(facts, h.events);
      assertEquals(existsSync(lockDir(base)), false, '锁最终必须放掉');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
}
