// R3-06：v0.16.0-rc.2 自审修复的回归用例。
//
// 每个用例对应一处**先复现、后修**的缺陷，而且每条都配一条合法正例：
// 防御性修复最容易出的假象是「一律拒绝/一律降级」也能让用例变绿（AGENTS.md §3），
// 所以「拒绝」必须和「该通过的那条通过了」写在一起。
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assert, assertEquals } from '../harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (rel) => import(join(ROOT, rel));

/** 真装配：workspace + liuhe-lite + 器官（不装 tool-registry，能力面直调即可）。 */
async function boot() {
  const base = mkdtempSync(join(tmpdir(), 'r306-'));
  const ws = join(base, 'ws');
  mkdirSync(join(ws, 'src'), { recursive: true });
  mkdirSync(join(base, 'state'), { recursive: true });
  writeFileSync(join(ws, 'src', 'a.txt'), 'alpha\n');
  writeFileSync(join(ws, 'src', 'b.txt'), 'bravo\n');
  const { Core } = await imp('src/core/core.js');
  const core = new Core({ stateDir: join(base, 'state') });
  core.log = () => {};
  core.setData('agent.workDir', ws);
  for (const rel of ['plugins/workspace.js', 'plugins/liuhe-lite.js', 'plugins/cell-file-txn.js']) {
    await core.register((await imp(rel)).default);
  }
  await core.start();
  const organ = core.plugins.get('cell-file-txn');
  const call = async (cap, args) => {
    const env = await core.callCapability(cap, args);
    return env?.payload ?? env;
  };
  const disk = (rel) => readFileSync(join(ws, rel), 'utf8');
  return { core, organ, call, ws, disk, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

const S = 'sess-r306';
const read = (b, rel) => b.disk(rel);

/** 把 provider 调用改成「第 n 次 action 抛错/返回失败」，用完必须还原。 */
function breakLite(organ, action, nth, mode) {
  const real = organ._lite.bind(organ);
  let n = 0;
  organ._lite = async (a, params) => {
    if (a === action && ++n === nth) {
      if (mode === 'throw') throw new Error('模拟：provider 调用抛出');
      return { ok: false, code: 'RECOVERY_UNAVAILABLE', message: '模拟：日记不可读' };
    }
    return real(a, params);
  };
  return () => { organ._lite = real; };
}

export async function setup(runner) {
  // ══ R3-06/1 零改动提交：成功，而不是一次没有 code 的失败 ══════════════
  runner.test('R3-06/1 所有文件已是目标内容：提交必须成功且标 noop（修前报 rejected 且无 code）', async () => {
    const b = await boot();
    try {
      const plan = await b.call('tool.txn-plan', { files: [{ path: 'src/a.txt', content: 'alpha\n' }], _sessionId: S });
      assertEquals(plan.plan.changed, 0, '内容与磁盘一致时 changed 必须是 0');
      const r = await b.call('tool.txn-commit', { plan_id: plan.plan.plan_id, _sessionId: S });
      assertEquals(r.ok, true, `空提交是成功，不是失败：${JSON.stringify(r)}`);
      assertEquals(r.code, undefined, '成功不得带失败码');
      assertEquals(r.txn.state, 'committed');
      assertEquals(r.txn.noop, true, '「一个字都没写」必须显式标出来，否则会被读成「写了三个文件」');
      assertEquals(r.txn.applied, 0);
      assertEquals(r.txn.files[0].application, 'not_needed');
      assertEquals(read(b, 'src/a.txt'), 'alpha\n', '没变就是没变');
      // 正例：真改了内容时不能被误标成 noop。
      const p2 = await b.call('tool.txn-plan', { files: [{ path: 'src/a.txt', content: 'alpha2\n' }], _sessionId: S });
      const r2 = await b.call('tool.txn-commit', { plan_id: p2.plan.plan_id, _sessionId: S });
      assertEquals(r2.ok, true);
      assertEquals(r2.txn.applied, 1);
      assertEquals(r2.txn.noop, undefined, '有改动就不是 noop');
      assertEquals(read(b, 'src/a.txt'), 'alpha2\n');
    } finally { await b.core.stop(); b.cleanup(); }
  });

  // ══ R3-06/2 读也要判权属 ══════════════════════════════════════════
  runner.test('R3-06/2 跨会话 inspect 必须被拒（修前谁都能按 txn_id 读走别人的事务）', async () => {
    const b = await boot();
    try {
      const plan = await b.call('tool.txn-plan', { files: [{ path: 'src/a.txt', content: 'own\n' }], _sessionId: 'sess-OWNER' });
      const c = await b.call('tool.txn-commit', { plan_id: plan.plan.plan_id, _sessionId: 'sess-OWNER' });
      assertEquals(c.ok, true);
      const peek = await b.call('tool.txn-status', { txn_id: c.txn.txn_id, _sessionId: 'sess-INTRUDER' });
      assertEquals(peek.ok, false, '别的会话不该读到这条事务');
      assertEquals(peek.code, 'TXN_SESSION_MISMATCH');
      assertEquals(peek.txn, undefined, '拒绝时不能把回执一起塞出去');
      // 正例 1：本会话读得到。
      const own = await b.call('tool.txn-status', { txn_id: c.txn.txn_id, _sessionId: 'sess-OWNER' });
      assertEquals(own.ok, true);
      assertEquals(own.txn.session_id, 'sess-OWNER');
      // 正例 2：宿主经服务面读（无会话上下文）仍可用 —— 修复不能把合法路径一起打死。
      const host = await b.core.getService('cell-file-txn').inspect(c.txn.txn_id);
      assertEquals(host.ok, true, '宿主服务面不能因为缺少会话上下文而不可用');
      assertEquals(host.txn.txn_id, c.txn.txn_id);
    } finally { await b.core.stop(); b.cleanup(); }
  });

  // ══ R3-06/3 计划表有上限 ══════════════════════════════════════════
  runner.test('R3-06/3 计划表必须有界：反复 plan 不得线性堆积，丢弃要可观测', async () => {
    const b = await boot();
    try {
      const ids = [];
      for (let i = 0; i < 40; i++) {
        const p = await b.call('tool.txn-plan', { files: [{ path: `src/p${i}.txt`, content: `v${i}\n` }], _sessionId: S });
        assertEquals(p.ok, true);
        ids.push(p.plan.plan_id);
      }
      const d = b.core.getService('cell-file-txn').describe();
      assertEquals(d.plans, d.max_plans, `计划数应停在上限 ${d.max_plans}，实际 ${d.plans}`);
      assert(d.plan_evictions >= 40 - d.max_plans, `丢弃次数要记下，实际 ${d.plan_evictions}`);
      // 最旧的必然被丢 —— 且必须给具名码，不是「找不到」。
      const stale = await b.call('tool.txn-commit', { plan_id: ids[0], _sessionId: S });
      assertEquals(stale.code, 'PLAN_NOT_FOUND');
      // 正例：上限不得误伤还活着的计划。
      const live = await b.call('tool.txn-commit', { plan_id: ids[ids.length - 1], _sessionId: S });
      assertEquals(live.ok, true, `最新的计划必须仍可提交：${JSON.stringify(live.code)}`);
      assertEquals(read(b, 'src/p39.txt'), 'v39\n');
    } finally { await b.core.stop(); b.cleanup(); }
  });

  // ══ R3-06/4 单笔计划内容总量上限 ═════════════════════════════════
  runner.test('R3-06/4 单笔计划内容总量有上限：超限计划期拒，界内照常通过', async () => {
    const b = await boot();
    try {
      const big = 'z'.repeat(900 * 1024);
      const over = await b.call('tool.txn-plan', {
        files: [0, 1, 2, 3, 4].map((i) => ({ path: `src/g${i}.txt`, content: big })), _sessionId: S,
      });
      assertEquals(over.ok, false);
      assertEquals(over.code, 'TOO_MANY_BYTES');
      assertEquals(over.detail.limit, 4 * 1024 * 1024);
      // 正例：4 × 900KB 在界内，必须能计划。
      const within = await b.call('tool.txn-plan', {
        files: [0, 1, 2, 3].map((i) => ({ path: `src/h${i}.txt`, content: big })), _sessionId: S,
      });
      assertEquals(within.ok, true, `界内计划被误拒：${within.code}`);
      assertEquals(within.plan.total, 4);
    } finally { await b.core.stop(); b.cleanup(); }
  });

  // ══ R3-06/5 提交途中异常：不得停在 applying ═══════════════════════
  runner.test('R3-06/5 提交途中抛异常：事务落 indeterminate，请求不得永久 in-flight', async () => {
    const b = await boot();
    try {
      const plan = await b.call('tool.txn-plan', {
        files: [{ path: 'src/a.txt', content: 'A2\n' }, { path: 'src/b.txt', content: 'B2\n' }], _sessionId: S,
      });
      const restore = breakLite(b.organ, 'apply', 2, 'throw');
      const r = await b.call('tool.txn-commit', { plan_id: plan.plan.plan_id, request_id: 'REQ-1', _sessionId: S });
      restore();
      assertEquals(r.ok, false);
      assertEquals(r.code, 'INDETERMINATE', `抛异常要说「不知道写没写」，实际 ${r.code}`);
      assertEquals(r.retry, 'after_reconcile');
      assertEquals(r.txn.state, 'indeterminate');
      // 已落盘的那个文件必须如实标 applied —— 不能因为出了异常就说「什么都没发生」。
      assertEquals(r.txn.files[0].application, 'applied');
      // 第二笔被**尝试过**、结果未知；随后读锚证实它没被写 ⇒ rejected（不是 not_attempted：
      // not_attempted 是“没轮到”，而这里轮到了、只是结果一开始不知道）。
      assertEquals(r.txn.files[1].application, 'rejected');
      assertEquals(r.txn.files[1].reconciled, 'disk_matches_before', '这个结论必须来自读锚，而不是猜');
      assertEquals(r.txn.unknown, 0, '对账后已经没有“未知效果”的文件');
      assertEquals(r.txn.reconciled.checked, 1, '只该重读那一笔未收口的文件');
      assertEquals(read(b, 'src/a.txt'), 'A2\n', '第一个文件确实写了');
      // 同一个 request_id 重放：必须是「已落定」的具名码，不是永久 REQUEST_IN_FLIGHT。
      const replay = await b.call('tool.txn-commit', { plan_id: plan.plan.plan_id, request_id: 'REQ-1', _sessionId: S });
      assertEquals(replay.code, 'TXN_INDETERMINATE', `不得再报 in-flight，实际 ${replay.code}`);
      assertEquals(replay.idempotent_replay, true);
      assertEquals(replay.retry, 'after_reconcile');
      // 正例：器官没有中毒，新计划照常提交。
      const p2 = await b.call('tool.txn-plan', { files: [{ path: 'src/b.txt', content: 'B3\n' }], _sessionId: S });
      const r2 = await b.call('tool.txn-commit', { plan_id: p2.plan.plan_id, _sessionId: S });
      assertEquals(r2.ok, true, `后续事务必须照常可用：${r2.code}`);
    } finally { await b.core.stop(); b.cleanup(); }
  });

  // ══ R3-06/6 撤销中途失败后可重试 ═════════════════════════════════
  runner.test('R3-06/6 撤销到一半失败：undo_partial 必须可重入，重试后工作区完全复原', async () => {
    const b = await boot();
    try {
      const plan = await b.call('tool.txn-plan', {
        files: [{ path: 'src/a.txt', content: 'A3\n' }, { path: 'src/b.txt', content: 'B3\n' }], _sessionId: S,
      });
      const c = await b.call('tool.txn-commit', { plan_id: plan.plan.plan_id, _sessionId: S });
      assertEquals(c.ok, true);
      const restore = breakLite(b.organ, 'undo', 2, 'fail');
      const u1 = await b.call('txn.undo', { txn_id: c.txn.txn_id, _sessionId: S });
      restore();
      assertEquals(u1.ok, false);
      assertEquals(u1.txn.state, 'undo_partial', '撤了一个、卡了一个 —— 这就是 undo_partial');
      assertEquals(u1.txn.undone, 1);
      assertEquals(u1.txn.applied, 1);
      // 修前这里回 NOT_UNDOABLE：一次瞬时故障把工作区永久停在「一半旧、一半新」。
      const u2 = await b.call('txn.undo', { txn_id: c.txn.txn_id, _sessionId: S });
      assertEquals(u2.ok, true, `重试必须能接着撤：${u2.code} ${u2.message || ''}`);
      assertEquals(u2.undone, 1, '只撤剩下的那一个');
      assertEquals(u2.txn.state, 'undone');
      assertEquals(u2.txn.undo_error, undefined, '重试成功后上一次的失败记录不得留在回执里');
      assertEquals(read(b, 'src/a.txt'), 'alpha\n');
      assertEquals(read(b, 'src/b.txt'), 'bravo\n');
    } finally { await b.core.stop(); b.cleanup(); }
  });

  // ══ R3-06/7 一个都没撤回时不得自称 undo_partial ══════════════════
  runner.test('R3-06/7 撤销第一个文件就失败：状态不得报成 undo_partial（磁盘没变）', async () => {
    const b = await boot();
    try {
      const plan = await b.call('tool.txn-plan', {
        files: [{ path: 'src/a.txt', content: 'A4\n' }, { path: 'src/b.txt', content: 'B4\n' }], _sessionId: S,
      });
      const c = await b.call('tool.txn-commit', { plan_id: plan.plan.plan_id, _sessionId: S });
      const restore = breakLite(b.organ, 'undo', 1, 'fail');
      const u1 = await b.call('txn.undo', { txn_id: c.txn.txn_id, _sessionId: S });
      restore();
      assertEquals(u1.ok, false);
      assertEquals(u1.txn.state, 'committed', '一个文件都没撤回来，就不能说“部分已回滚”');
      assertEquals(u1.txn.undone, 0);
      assertEquals(u1.txn.applied, 2);
      assertEquals(read(b, 'src/a.txt'), 'A4\n');
      assertEquals(read(b, 'src/b.txt'), 'B4\n');
      // 正例：恢复后照常撤干净。
      const u2 = await b.call('txn.undo', { txn_id: c.txn.txn_id, _sessionId: S });
      assertEquals(u2.ok, true);
      assertEquals(u2.undone, 2);
      assertEquals(read(b, 'src/a.txt'), 'alpha\n');
      assertEquals(read(b, 'src/b.txt'), 'bravo\n');
    } finally { await b.core.stop(); b.cleanup(); }
  });

  // ══ R3-06/8 同一文件的别名写法 ════════════════════════════════════
  runner.test('R3-06/8 同一文件的两个写法：计划期就拒，不得写完一个再撞锚', async () => {
    const b = await boot();
    try {
      for (const [alias, why] of [['./src/a.txt', '前导 ./'], ['src//a.txt', '重复分隔符'], ['src/./a.txt', '中段 .']]) {
        const p = await b.call('tool.txn-plan', {
          files: [{ path: alias, content: 'X\n' }, { path: 'src/a.txt', content: 'Y\n' }], _sessionId: S,
        });
        assertEquals(p.ok, false, `${why} 与 src/a.txt 是同一个文件，必须拒`);
        assertEquals(p.code, 'DUPLICATE_PATH');
        assertEquals(p.detail.normalized, 'src/a.txt');
      }
      assertEquals(read(b, 'src/a.txt'), 'alpha\n', '计划期拒绝 ⇒ 一个字节都不该写');
      // 正例：两个真不同的路径照常。
      const ok = await b.call('tool.txn-plan', {
        files: [{ path: 'src/a.txt', content: 'A5\n' }, { path: 'src/b.txt', content: 'B5\n' }], _sessionId: S,
      });
      assertEquals(ok.ok, true, `不同路径被误拒：${ok.code}`);
      const c = await b.call('tool.txn-commit', { plan_id: ok.plan.plan_id, _sessionId: S });
      assertEquals(c.ok, true);
      assertEquals(read(b, 'src/a.txt'), 'A5\n');
      assertEquals(read(b, 'src/b.txt'), 'B5\n');
    } finally { await b.core.stop(); b.cleanup(); }
  });

  // ══ R3-06/9 计数只说此刻的事实 ════════════════════════════════════
  runner.test('R3-06/9 撤销之后 applied 必须归零（修前 undone 也算进 applied）', async () => {
    const b = await boot();
    try {
      const plan = await b.call('tool.txn-plan', {
        files: [{ path: 'src/a.txt', content: 'A6\n' }, { path: 'src/b.txt', content: 'B6\n' }], _sessionId: S,
      });
      const c = await b.call('tool.txn-commit', { plan_id: plan.plan.plan_id, _sessionId: S });
      assertEquals(c.txn.applied, 2, '提交后两个都是 applied');
      assertEquals(c.txn.undone, 0);
      const u = await b.call('txn.undo', { txn_id: c.txn.txn_id, _sessionId: S });
      assertEquals(u.ok, true);
      const i = await b.call('tool.txn-status', { txn_id: c.txn.txn_id, _sessionId: S });
      assertEquals(i.txn.state, 'undone');
      assertEquals(i.txn.applied, 0, '已经撤回来的文件不能再算 applied');
      assertEquals(i.txn.undone, 2);
      assertEquals(i.txn.total, 2);
    } finally { await b.core.stop(); b.cleanup(); }
  });

  // ══ R3-06/10 重新装配不继承上一个 Core 的账 ═══════════════════════
  runner.test('R3-06/10 新 Core 装配同一实例：不得继承旧 Core 的事务与计划', async () => {
    const b1 = await boot();
    let b2 = null;
    try {
      const plan = await b1.call('tool.txn-plan', { files: [{ path: 'src/a.txt', content: 'old\n' }], _sessionId: S });
      const c = await b1.call('tool.txn-commit', { plan_id: plan.plan.plan_id, _sessionId: S });
      assertEquals(c.ok, true);
      b2 = await boot();
      const d = b2.core.getService('cell-file-txn').describe();
      assertEquals(d.transactions, 0, '新 Core 不该看到旧 Core 的事务');
      assertEquals(d.plans, 0, '旧 plan_id 不得跨装配存活');
      const ghost = await b2.call('tool.txn-status', { txn_id: c.txn.txn_id, _sessionId: S });
      assertEquals(ghost.code, 'NOT_FOUND');
      const ghostPlan = await b2.call('tool.txn-commit', { plan_id: plan.plan.plan_id, _sessionId: S });
      assertEquals(ghostPlan.code, 'PLAN_NOT_FOUND');
      // 正例：新 Core 自己的账照常可写。
      const p2 = await b2.call('tool.txn-plan', { files: [{ path: 'src/a.txt', content: 'new\n' }], _sessionId: S });
      const r2 = await b2.call('tool.txn-commit', { plan_id: p2.plan.plan_id, _sessionId: S });
      assertEquals(r2.ok, true, `新 Core 必须能自己干活：${r2.code}`);
    } finally {
      if (b2) { await b2.core.stop(); b2.cleanup(); }
      await b1.core.stop(); b1.cleanup();
    }
  });

  // ══ R3-06/11 事件名必须等于事实 ═════════════════════════════════
  runner.test('R3-06/11 事实出口：一次提交只发一个事件，且必须走 emitFact（专家 F-01）', async () => {
    const b = await boot();
    try {
      const seen = [];
      const fast = [];
      const realFact = b.core.emitFact.bind(b.core);
      const realFast = b.core.emitFast.bind(b.core);
      b.core.emitFact = (type, payload) => { seen.push({ type, payload }); return realFact(type, payload); };
      b.core.emitFast = (type, payload) => { fast.push(type); return realFast(type, payload); };
      // 造一次确定性的 rejected：计划读到锚之后，别人把文件改了。
      const plan = await b.call('tool.txn-plan', { files: [{ path: 'src/a.txt', content: 'MINE\n' }], _sessionId: S });
      writeFileSync(join(b.ws, 'src', 'a.txt'), 'SOMEONE-ELSE\n');
      const r = await b.call('tool.txn-commit', { plan_id: plan.plan.plan_id, _sessionId: S });
      assertEquals(r.ok, false);
      assertEquals(r.code, 'VERSION_CONFLICT');
      assertEquals(r.txn.state, 'rejected');
      assertEquals(seen.length, 1, `一次提交只该有一个事件，实际 ${JSON.stringify(seen.map((e) => e.type))}`);
      assertEquals(seen[0].type, 'txn.resolved', '事件名不能把「被拒」说成「已提交」');
      assertEquals(seen[0].payload.state, 'rejected');
      assertEquals(seen[0].type === 'txn.committed', false, '修前的名字是 txn.committed —— 一次 rejected 绝不是 committed');
      // 事实出口：走 emitFact（异常被隔离），不得走 emitFast（异常会冒泡回调用方）。
      assertEquals(fast.filter((t) => String(t).startsWith('txn.')).length, 0,
        `已提交事实必须走 emitFact，实际 emitFast: ${JSON.stringify(fast)}`);
      // 正例：真提交成功时同样发 txn.resolved，state 是 committed。
      seen.length = 0;
      fast.length = 0;
      const p2 = await b.call('tool.txn-plan', { files: [{ path: 'src/b.txt', content: 'B7\n' }], _sessionId: S });
      const r2 = await b.call('tool.txn-commit', { plan_id: p2.plan.plan_id, _sessionId: S });
      assertEquals(r2.ok, true);
      assertEquals(seen[0].type, 'txn.resolved');
      assertEquals(seen[0].payload.state, 'committed');
      assertEquals(seen[0].payload.applied, 1);
      assertEquals(fast.filter((t) => String(t).startsWith('txn.')).length, 0);
    } finally { await b.core.stop(); b.cleanup(); }
  });

  // ══ R3-06/12 只读分类：此前没有任何用例钉住「提交不是只读」 ═════════
  runner.test('R3-06/12 只读分类：计划/状态只读、提交绝对不是', async () => {
    const { isReadonlyTool, isReadonlyCapability } = await imp('plugins/_lib/tool-policy.js');
    assertEquals(isReadonlyTool('tool-txn-plan'), true);
    assertEquals(isReadonlyTool('tool-txn-status'), true);
    assertEquals(isReadonlyTool('tool-txn-commit'), false, '提交会写盘；进只读清单 = 只读 Cell 能写文件');
    assertEquals(isReadonlyCapability('tool.txn-plan'), true);
    assertEquals(isReadonlyCapability('tool.txn-status'), true);
    assertEquals(isReadonlyCapability('tool.txn-commit'), false);
    // 默认拒绝：没登记的能力 id 一律不是只读（含只在能力面暴露的 undo）。
    assertEquals(isReadonlyCapability('txn.undo'), false);
    assertEquals(isReadonlyCapability('tool.txn-undo'), false);
  });

  // ══ R3-06/13 提交途中被卸载：剩下的文件不得再写 ═════════════════════
  runner.test('R3-06/13 提交途中被卸载：剩下文件一个都不许再写', async () => {
    const b = await boot();
    const orig = b.organ._lite;
    try {
      const plan = await b.call('tool.txn-plan', {
        files: [{ path: 'src/a.txt', content: 'U1\n' }, { path: 'src/b.txt', content: 'U2\n' }], _sessionId: S,
      });
      const real = orig.bind(b.organ);
      let n = 0;
      // 第一个文件写成功后立即卸载：模拟 Cell 关闭 / 热卸载与提交并发。
      b.organ._lite = async (a, p) => {
        const r = await real(a, p);
        if (a === 'apply' && ++n === 1) b.organ.stop();
        return r;
      };
      const r = await b.call('tool.txn-commit', { plan_id: plan.plan.plan_id, _sessionId: S });
      assertEquals(r.ok, false);
      assertEquals(r.code, 'PLUGIN_UNLOADED', `卸载后必须停手并说清楚，实际 ${r.code}`);
      assertEquals(r.txn.state, 'partial', '写了一个就不可能是 rejected，也不可能说成 committed');
      assertEquals(r.txn.files[0].application, 'applied');
      assertEquals(r.txn.files[1].application, 'not_attempted');
      assertEquals(read(b, 'src/a.txt'), 'U1\n');
      assertEquals(read(b, 'src/b.txt'), 'bravo\n', '卸载之后第二个文件绝不能写');
    } finally {
      b.organ._lite = orig;
      await b.core.stop();
      b.cleanup();
    }
  });
}
