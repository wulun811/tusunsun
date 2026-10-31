// R3-07：v0.16.0-rc.3 修专家 F-01～F-05 的回归用例。
//
// 每一条都来自《土行孙 0.16.0-rc.2 独立专家审查》里一个可复跑的独立反例：
//   F-01 已提交事实走了 emitFast —— 观察者抛错就把成功报成 handler_threw；
//   F-02 provider 说“不知道”被折成 rejected —— 磁盘改了、回执却说零副作用；
//   F-03 Undo 抛出没有结算路径 —— 主状态仍说 committed，文件列表却已有一半 undone；
//   F-04 模型面无会话可读别人事务 —— “没有身份”被默认成“超级宿主”；
//   F-05 无会话也能签计划 —— 签出来的 plan_id 永远提交不了。
//
// 仍然按 AGENTS.md §3：每条拒绝/未知都配一条该通过的合法正例，
// 免得“一律拒绝/一律降级”也能让用例变绿。
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assert, assertEquals } from '../harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (rel) => import(join(ROOT, rel));

/** 真装配：workspace + liuhe-lite + 器官（可加装 tool-executor，模拟模型入口）。 */
async function boot({ withExecutor = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'r307-'));
  const ws = join(base, 'ws');
  mkdirSync(join(ws, 'src'), { recursive: true });
  mkdirSync(join(base, 'state'), { recursive: true });
  writeFileSync(join(ws, 'src', 'a.txt'), 'alpha\n');
  writeFileSync(join(ws, 'src', 'b.txt'), 'bravo\n');
  const { Core } = await imp('src/core/core.js');
  const core = new Core({ stateDir: join(base, 'state') });
  core.log = () => {};
  core.setData('agent.workDir', ws);
  const order = ['plugins/workspace.js'];
  if (withExecutor) order.push('plugins/tool-loader.js', 'plugins/tool-guard.js', 'plugins/tool-executor.js');
  order.push('plugins/liuhe-lite.js', 'plugins/cell-file-txn.js');
  for (const rel of order) await core.register((await imp(rel)).default);
  await core.start();
  const organ = core.plugins.get('cell-file-txn');
  // 器官是**单例导出**：上一个用例把 _lite 换成桩没恢复的话，这一条会测到别人的桩。
  // 每次装配先拆掉自有属性，让原型上的真方法重新露出来（拆除比“复原成某个值”更可靠）。
  delete organ._lite;
  const call = async (cap, args) => {
    const env = await core.callCapability(cap, args);
    return env?.payload ?? env;
  };
  const disk = (rel) => readFileSync(join(ws, rel), 'utf8');
  return { core, organ, call, ws, disk, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

const S = 'sess-r307';

/** 把 provider 的某一动作改成“第 n 次抛错 / 返回指定失败码”，用完必须还原。 */
function breakLite(organ, action, nth, behaviour) {
  const real = organ._lite.bind(organ);
  let n = 0;
  organ._lite = async (a, params) => {
    if (a === action && ++n === nth) {
      if (behaviour === 'throw') throw new Error('模拟：provider 调用抛出');
      return { ok: false, code: behaviour, message: `模拟：provider 返回 ${behaviour}` };
    }
    return real(a, params);
  };
  return () => { organ._lite = real; };
}

export async function setup(runner) {
  // ══ R3-07/1 F-01：提交成功 + 观察者抛错 ⇒ 仍是成功 ═══════════════════
  runner.test('R3-07/1 提交已落盘后观察者抛错：调用方必须仍拿到成功，错误进诊断面（F-01）', async () => {
    const b = await boot();
    try {
      const plan = await b.call('tool.txn-plan', { files: [{ path: 'src/a.txt', content: 'A!\n' }], _sessionId: S });
      const fast = [];
      const realFast = b.core.emitFast.bind(b.core);
      b.core.emitFast = (type, payload) => { fast.push(type); return realFast(type, payload); };
      b.core.on('txn.resolved', () => { throw new Error('observer boom'); });
      const r = await b.call('tool.txn-commit', { plan_id: plan.plan.plan_id, _sessionId: S });
      assertEquals(r.ok, true, `磁盘已经写了，回执就不能说失败：${JSON.stringify({ code: r.code, state: r.state })}`);
      assertEquals(r.txn.state, 'committed');
      assertEquals(b.disk('src/a.txt'), 'A!\n', '事实：文件真的写了');
      // 观察者的毛病不能消失：既要进 core 的诊断面，也要在回执里数得出来。
      assert(b.core.getObserverErrors().length >= 1, '观察者异常必须可诊断（getObserverErrors）');
      assertEquals(r.observers.errors, 1, '回执里要写清投递失败数');
      assertEquals(r.observers.delivered, 0);
      assertEquals(fast.filter((t) => String(t).startsWith('txn.')).length, 0,
        '已提交事实不得走 emitFast：那条路会把观察者异常冒泡回调用方');
    } finally { await b.core.stop(); b.cleanup(); }
  });

  // ══ R3-07/2 F-01：撤销成功 + 观察者抛错 ⇒ 仍是成功 ══════════════════
  runner.test('R3-07/2 撤销已完成后观察者抛错：调用方必须仍拿到成功（F-01）', async () => {
    const b = await boot();
    try {
      const plan = await b.call('tool.txn-plan', { files: [{ path: 'src/a.txt', content: 'A!\n' }], _sessionId: S });
      const c = await b.call('tool.txn-commit', { plan_id: plan.plan.plan_id, _sessionId: S });
      b.core.on('txn.undone', () => { throw new Error('observer boom'); });
      const u = await b.call('txn.undo', { txn_id: c.txn.txn_id, _sessionId: S });
      assertEquals(u.ok, true, `磁盘已经还原，回执就不能说失败：${JSON.stringify({ code: u.code, state: u.state })}`);
      assertEquals(u.txn.state, 'undone');
      assertEquals(b.disk('src/a.txt'), 'alpha\n');
      assert(b.core.getObserverErrors().length >= 1);
    } finally { await b.core.stop(); b.cleanup(); }
  });

  // ══ R3-07/3 F-01 正例：正常观察者仍在，且拿不到可改的事实源 ═════════
  runner.test('R3-07/3 正例：事实照常投递，载荷是观察者改不动的快照（F-01）', async () => {
    const b = await boot();
    try {
      const plan = await b.call('tool.txn-plan', { files: [{ path: 'src/a.txt', content: 'A!\n' }], _sessionId: S });
      const seen = [];
      b.core.on('txn.resolved', (ev) => {
        seen.push(ev);
        try { ev.state = 'HACKED'; } catch { /* 冻结对象赋值会抛，正是要的 */ }
      });
      const r = await b.call('tool.txn-commit', { plan_id: plan.plan.plan_id, _sessionId: S });
      assertEquals(r.ok, true);
      assertEquals(seen.length, 1, '订阅者必须真收到一次');
      assertEquals(seen[0].state, 'committed');
      assertEquals(Object.isFrozen(seen[0]), true, '事实载荷必须是冻结快照（否则第一个观察者能改掉后面所有人看到的）');
      assertEquals(r.observers.errors, 0);
      assertEquals(r.txn.state, 'committed', '观察者改不动事实本身');
    } finally { await b.core.stop(); b.cleanup(); }
  });

  // ══ R3-07/4 F-01：异步观察者拒绝不得升级成进程级未处理拒绝 ═════════
  runner.test('R3-07/4 异步观察者拒绝：必须被消费，不得变成 unhandledRejection（F-01）', async () => {
    const b = await boot();
    try {
      let unhandled = 0;
      const onUnhandled = () => { unhandled++; };
      process.on('unhandledRejection', onUnhandled);
      const plan = await b.call('tool.txn-plan', { files: [{ path: 'src/a.txt', content: 'A!\n' }], _sessionId: S });
      b.core.on('txn.resolved', async () => { throw new Error('async boom'); });
      const r = await b.call('tool.txn-commit', { plan_id: plan.plan.plan_id, _sessionId: S });
      await new Promise((res) => setTimeout(res, 30));
      process.off('unhandledRejection', onUnhandled);
      assertEquals(r.ok, true);
      assertEquals(unhandled, 0, '异步观察者的拒绝必须被吃掉（修前是进程级 unhandledRejection）');
      assert(b.core.getObserverErrors().length >= 1, '异步异常同样要可诊断');
    } finally { await b.core.stop(); b.cleanup(); }
  });

  // ══ R3-07/5 F-02：provider 明示未知，但磁盘已被改 ═════════════════
  runner.test('R3-07/5 provider 改了盘却返回 INDETERMINATE：不得说成 rejected（F-02）', async () => {
    const b = await boot();
    try {
      const plan = await b.call('tool.txn-plan', { files: [{ path: 'src/a.txt', content: 'A!\n' }], _sessionId: S });
      const real = b.organ._lite.bind(b.organ);
      let applyCalls = 0;
      b.organ._lite = async (action, params) => {
        if (action === 'apply') {
          applyCalls++;
          writeFileSync(join(b.ws, 'src', 'a.txt'), 'A!\n');   // 真实副作用
          return { ok: false, code: 'INDETERMINATE', message: 'provider lost the response after writing' };
        }
        return real(action, params);
      };
      const r = await b.call('tool.txn-commit', { plan_id: plan.plan.plan_id, _sessionId: S });
      assertEquals(r.ok, false);
      assertEquals(r.code, 'INDETERMINATE');
      assertEquals(r.txn.state, 'indeterminate', `修前这里说 rejected —— 与磁盘事实相反；实际 ${r.txn.state}`);
      assertEquals(r.retry, 'after_reconcile');
      // 磁盘对账：读锚证实这个文件确实被写了，回执必须照实说。
      assertEquals(r.txn.files[0].application, 'applied');
      assertEquals(r.txn.files[0].reconciled, 'disk_matches_after');
      assertEquals(r.txn.applied, 1);
      assertEquals(r.txn.unknown, 0);
      assertEquals(b.disk('src/a.txt'), 'A!\n');
      // 幂等：同一个 request_id 重放不得再触发一次副作用。
      const replay = await b.call('tool.txn-commit', { plan_id: plan.plan.plan_id, _sessionId: S });
      assertEquals(replay.idempotent_replay, true);
      assertEquals(replay.code, 'TXN_INDETERMINATE');
      assertEquals(applyCalls, 1, '重放不能再写一次');
    } finally { await b.core.stop(); b.cleanup(); }
  });

  // ══ R3-07/6 F-02：provider 说不知道，但确实没写 ═══════════════════
  runner.test('R3-07/6 provider 没写却报 ADAPTER_ERROR：未知就是未知，不得替它断言（F-02）', async () => {
    const b = await boot();
    try {
      const plan = await b.call('tool.txn-plan', { files: [{ path: 'src/a.txt', content: 'A!\n' }], _sessionId: S });
      const restore = breakLite(b.organ, 'apply', 1, 'ADAPTER_ERROR');
      const r = await b.call('tool.txn-commit', { plan_id: plan.plan.plan_id, _sessionId: S });
      restore();
      assertEquals(r.ok, false);
      assertEquals(r.txn.state, 'indeterminate', 'ADAPTER_ERROR 的语义不含“没写”，不能折成 rejected');
      assertEquals(r.txn.unknown, 0, '读锚后磁盘已能定论');
      assertEquals(r.txn.applied, 0);
      assertEquals(r.txn.files[0].reconciled, 'disk_matches_before', '结论必须来自读锚');
      assertEquals(b.disk('src/a.txt'), 'alpha\n');
      assertEquals(r.detail.provider_code, 'ADAPTER_ERROR', 'provider 的码不能被吞掉');
      assertEquals(r.detail.cause, 'provider_result_unknown');
    } finally { await b.core.stop(); b.cleanup(); }
  });

  // ══ R3-07/7 F-02 正例：明确的执行前拒绝仍然零覆盖 ═════════════════
  runner.test('R3-07/7 正例：真实版本冲突仍然 rejected 且一个字节都不覆盖（F-02）', async () => {
    const b = await boot();
    try {
      const plan = await b.call('tool.txn-plan', { files: [{ path: 'src/a.txt', content: 'MINE\n' }], _sessionId: S });
      writeFileSync(join(b.ws, 'src', 'a.txt'), 'SOMEONE-ELSE\n');
      const r = await b.call('tool.txn-commit', { plan_id: plan.plan.plan_id, _sessionId: S });
      assertEquals(r.ok, false);
      assertEquals(r.code, 'VERSION_CONFLICT');
      assertEquals(r.txn.state, 'rejected', '明确的执行前拒绝就是 rejected，这条不能被“一律 indeterminate”误伤');
      assertEquals(r.txn.files[0].application, 'rejected');
      assertEquals(r.retry, 'after_reanchor');
      assertEquals(b.disk('src/a.txt'), 'SOMEONE-ELSE\n', '零覆盖');
    } finally { await b.core.stop(); b.cleanup(); }
  });

  // ══ R3-07/8 F-03：撤销到一半抛出 ═════════════════════════════════
  runner.test('R3-07/8 第二笔撤销抛异常：主状态不得仍说 committed（F-03）', async () => {
    const b = await boot();
    try {
      const plan = await b.call('tool.txn-plan', {
        files: [{ path: 'src/a.txt', content: 'A!\n' }, { path: 'src/b.txt', content: 'B!\n' }], _sessionId: S,
      });
      const c = await b.call('tool.txn-commit', { plan_id: plan.plan.plan_id, _sessionId: S });
      const restore = breakLite(b.organ, 'undo', 2, 'throw');
      const u = await b.call('txn.undo', { txn_id: c.txn.txn_id, _sessionId: S });
      restore();
      assertEquals(u.ok, false);
      const st = await b.call('txn.inspect', { txn_id: c.txn.txn_id, _sessionId: S });
      // 修前：state=committed + files=['applied','undone'] —— 一行之内自相矛盾。
      assertEquals(st.txn.state, 'undo_partial', `撤了一个、卡了一个，就是 undo_partial；实际 ${st.txn.state}`);
      assertEquals(st.txn.undone, 1);
      assertEquals(st.txn.applied, 1);
      assertEquals(st.txn.undo_unknown, 0, '抛出的那一笔已被读锚定论（还是提交后的样子）');
      // 撤销是倒序的：b（files[1]）先被撤回来，a（files[0]）那笔抛出、读锚证实它还是提交后的样子。
      assertEquals(st.txn.files[1].application, 'undone');
      assertEquals(st.txn.files[0].application, 'applied');
      assertEquals(st.txn.files[0].reconciled, 'disk_matches_after');
      // 正例：重试只撤剩下的那一个，工作区完全复原。
      const u2 = await b.call('txn.undo', { txn_id: c.txn.txn_id, _sessionId: S });
      assertEquals(u2.ok, true, `重试必须能接着撤：${u2.code}`);
      assertEquals(u2.undone, 1);
      assertEquals(u2.txn.state, 'undone');
      assertEquals(b.disk('src/a.txt'), 'alpha\n');
      assertEquals(b.disk('src/b.txt'), 'bravo\n');
    } finally { await b.core.stop(); b.cleanup(); }
  });

  // ══ R3-07/9 F-03：第一笔撤销就抛出 ═══════════════════════════════
  runner.test('R3-07/9 第一笔撤销就抛异常：状态不得冒充“部分已回滚”（F-03）', async () => {
    const b = await boot();
    try {
      const plan = await b.call('tool.txn-plan', {
        files: [{ path: 'src/a.txt', content: 'A!\n' }, { path: 'src/b.txt', content: 'B!\n' }], _sessionId: S,
      });
      const c = await b.call('tool.txn-commit', { plan_id: plan.plan.plan_id, _sessionId: S });
      const restore = breakLite(b.organ, 'undo', 1, 'throw');
      const u = await b.call('txn.undo', { txn_id: c.txn.txn_id, _sessionId: S });
      restore();
      assertEquals(u.ok, false);
      assertEquals(u.txn.state, 'committed', '一个都没撤回来，就不能说“部分已回滚”');
      assertEquals(u.txn.undone, 0);
      assertEquals(u.txn.applied, 2);
      assertEquals(b.disk('src/a.txt'), 'A!\n');
      assertEquals(b.disk('src/b.txt'), 'B!\n');
    } finally { await b.core.stop(); b.cleanup(); }
  });

  // ══ R3-07/10 F-03 正例：撤销后再次撤销是幂等复播 ═════════════════
  runner.test('R3-07/10 正例：撤销完成后再次撤销只复播结果，不重复回滚（F-03）', async () => {
    const b = await boot();
    try {
      const plan = await b.call('tool.txn-plan', { files: [{ path: 'src/a.txt', content: 'A!\n' }], _sessionId: S });
      const c = await b.call('tool.txn-commit', { plan_id: plan.plan.plan_id, _sessionId: S });
      const u1 = await b.call('txn.undo', { txn_id: c.txn.txn_id, _sessionId: S });
      assertEquals(u1.ok, true);
      assertEquals(u1.undone, 1);
      const u2 = await b.call('txn.undo', { txn_id: c.txn.txn_id, _sessionId: S });
      assertEquals(u2.ok, true);
      assertEquals(u2.idempotent_replay, true);
      assertEquals(b.disk('src/a.txt'), 'alpha\n');
    } finally { await b.core.stop(); b.cleanup(); }
  });

  // ══ R3-07/11 F-04：模型面 / 宿主面两把尺子 ══════════════════════
  runner.test('R3-07/11 模型面无会话读事务必须被拒；宿主服务面仍可用（F-04）', async () => {
    const b = await boot();
    try {
      const p = await b.call('tool.txn-plan', { files: [{ path: 'src/a.txt', content: 'OWN\n' }], _sessionId: 'sess-OWNER' });
      const c = await b.call('tool.txn-commit', { plan_id: p.plan.plan_id, _sessionId: 'sess-OWNER' });
      // 模型面：没有可归属的会话 = 没有调用者，不是“超级宿主”。
      const model = await b.call('tool.txn-status', { txn_id: c.txn.txn_id });
      assertEquals(model.ok, false, '模型面不得把“身份缺失”当成“超级宿主”');
      assertEquals(model.code, 'SESSION_REQUIRED');
      assertEquals(model.txn, undefined, '拒绝时不能把别人的回执一起塞出去');
      // 宿主服务面：会话可选（宿主自己就是身份来源），但回执里说清是哪个入口。
      const host = await b.call('txn.inspect', { txn_id: c.txn.txn_id });
      assertEquals(host.ok, true, '宿主服务面不能因为缺少会话上下文而不可用');
      assertEquals(host.entry, 'host-service');
      assertEquals(host.unscoped, true);
      assertEquals(host.txn.session_id, 'sess-OWNER');
      // 给了会话就必须对得上 —— 两把尺子都不是“一律放行”。
      const intruder = await b.call('txn.inspect', { txn_id: c.txn.txn_id, _sessionId: 'sess-INTRUDER' });
      assertEquals(intruder.ok, false);
      assertEquals(intruder.code, 'TXN_SESSION_MISMATCH');
    } finally { await b.core.stop(); b.cleanup(); }
  });

  // ══ R3-07/12 F-04：真实 ToolExecutor 的无会话/有会话对照 ══════════
  runner.test('R3-07/12 真实 ToolExecutor：无会话拿不到别人的事务，带本会话拿得到（F-04）', async () => {
    const b = await boot({ withExecutor: true });
    try {
      const exec = b.core.getService('tool-executor');
      assert(exec && typeof exec.executeOne === 'function', '判据前提：执行器必须装得上');
      const p = await b.call('tool.txn-plan', { files: [{ path: 'src/a.txt', content: 'OWN\n' }], _sessionId: 'sess-OWNER' });
      const c = await b.call('tool.txn-commit', { plan_id: p.plan.plan_id, _sessionId: 'sess-OWNER' });
      // 无会话：模型入口（这里的 sessionId=null 模拟宿主未注入会话）。
      const noSess = await exec.executeOne('tool-txn-status', { txn_id: c.txn.txn_id }, null);
      const noSessBody = JSON.parse(noSess.result);
      assertEquals(noSessBody.ok, false);
      assertEquals(noSessBody.code, 'SESSION_REQUIRED');
      assertEquals(noSessBody.txn, undefined, '无会话时不得漏出事务内容');
      // 有会话：同一条链路照常可用。
      const withSess = await exec.executeOne('tool-txn-status', { txn_id: c.txn.txn_id }, 'sess-OWNER');
      const withSessBody = JSON.parse(withSess.result);
      assertEquals(withSessBody.ok, true, `本会话必须读得到：${withSessBody.code}`);
      assertEquals(withSessBody.entry, 'model-tool');
      assertEquals(withSessBody.txn.txn_id, c.txn.txn_id);
    } finally { await b.core.stop(); b.cleanup(); }
  });

  // ══ R3-07/14 F-03：重试前必须先把未知收敛，不能盲发第二笔 ══════════
  runner.test('R3-07/14 撤销结果未收口且读锚也说不清：拒绝继续，不盲发第二笔 Undo（F-03）', async () => {
    const b = await boot();
    try {
      const plan = await b.call('tool.txn-plan', {
        files: [{ path: 'src/a.txt', content: 'A!\n' }, { path: 'src/b.txt', content: 'B!\n' }], _sessionId: S,
      });
      const c = await b.call('tool.txn-commit', { plan_id: plan.plan.plan_id, _sessionId: S });
      const real = b.organ._lite.bind(b.organ);
      let undoCalls = 0;
      // 抛出的同时把文件改成**第三个状态**（既不等于 before 也不等于 after）：
      // 这样读锚也定不了案，正好是“账没清”的那种。
      b.organ._lite = async (action, params) => {
        if (action === 'undo' && ++undoCalls === 1) {
          writeFileSync(join(b.ws, 'src', 'b.txt'), 'THIRD-STATE\n');
          throw new Error('transport boom after a partial write');
        }
        return real(action, params);
      };
      const u1 = await b.call('txn.undo', { txn_id: c.txn.txn_id, _sessionId: S });
      assertEquals(u1.ok, false);
      const st = await b.call('txn.inspect', { txn_id: c.txn.txn_id, _sessionId: S });
      assertEquals(st.txn.state, 'undo_indeterminate');
      assertEquals(st.txn.undo_unknown, 1, '读锚定不了案就必须如实标未知');
      assertEquals(st.txn.files[1].reconciled, 'third_state');
      // 重试：先重读锚（仍说不清）⇒ 拒绝继续，provider 不该再收到第二笔 Undo。
      const u2 = await b.call('txn.undo', { txn_id: c.txn.txn_id, _sessionId: S });
      assertEquals(u2.ok, false);
      assertEquals(u2.code, 'UNDO_INDETERMINATE');
      assertEquals(u2.retry, 'after_reconcile');
      assertEquals(u2.detail.unresolved, 1);
      assertEquals(undoCalls, 1, '账没清就不能再发 Undo');
    } finally { await b.core.stop(); b.cleanup(); }
  });

  // ══ R3-07/13 F-05：无会话不得签发不可提交的计划 ══════════════════
  runner.test('R3-07/13 无会话的 plan 不得签发 plan_id（签了也永远提交不了）（F-05）', async () => {
    const b = await boot();
    try {
      const noSess = await b.call('tool.txn-plan', { files: [{ path: 'src/a.txt', content: 'A!\n' }] });
      assertEquals(noSess.ok, false);
      assertEquals(noSess.code, 'SESSION_REQUIRED');
      assertEquals(noSess.plan, undefined, '不得签发一个注定提交不了的 plan_id');
      assertEquals(b.disk('src/a.txt'), 'alpha\n');
      // 正例：带会话时计划照签、照提交。
      const withSess = await b.call('tool.txn-plan', { files: [{ path: 'src/a.txt', content: 'A!\n' }], _sessionId: S });
      assertEquals(withSess.ok, true, `带会话的计划不能被打死：${withSess.code}`);
      assert(withSess.plan?.plan_id, '必须给出 plan_id');
      const commit = await b.call('tool.txn-commit', { plan_id: withSess.plan.plan_id, _sessionId: S });
      assertEquals(commit.ok, true);
      assertEquals(b.disk('src/a.txt'), 'A!\n');
    } finally { await b.core.stop(); b.cleanup(); }
  });
}
