// R20：rc.6 遗留延期技术债的回归锁。
//
// 每条用例对应一处**先复现、后修**的缺陷，并配一条合法正例 ——
// 「一律当成功」与「一律当失败」都能让某类用例变绿，所以两个方向都要写在一个用例里
// （AGENTS.md §3）。
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assert, assertEquals } from '../harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (rel) => import(join(ROOT, rel));
const S = 'sess-r20';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 真装配：workspace + liuhe-lite + 器官（不装 tool-registry，能力面直调即可）。 */
async function bootOrgan() {
  const base = mkdtempSync(join(tmpdir(), 'r20-'));
  const ws = join(base, 'ws');
  mkdirSync(join(ws, 'src'), { recursive: true });
  mkdirSync(join(base, 'state'), { recursive: true });
  writeFileSync(join(ws, 'src', 'a.txt'), 'alpha\n');
  writeFileSync(join(ws, 'src', 'b.txt'), 'bravo\n');
  const { Core } = await imp('src/core/core.js');
  const core = new Core({ stateDir: join(base, 'state') });
  core.log = () => {};
  core._stopAssemblyDrainMs = 20;
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

export async function setup(runner) {
  // ══ R20-01 重入撤销：对账已证明「全撤干净」⇒ 结算为 undone ═══════════
  // 修前：磁盘早已回到提交前，代码却因为「没有 application==='applied' 的文件」
  // 一律回 NOT_UNDOABLE，`txn.state` 永远停在 undo_indeterminate。
  runner.test('R20-01 重入撤销时对账已证明全撤：结算为 undone（修前报 NOT_UNDOABLE）', async () => {
    const b = await bootOrgan();
    try {
      const plan = await b.call('tool.txn-plan', {
        files: [{ path: 'src/a.txt', content: 'A2\n' }, { path: 'src/b.txt', content: 'B2\n' }],
        _sessionId: S,
      });
      const c = await b.call('tool.txn-commit', { plan_id: plan.plan.plan_id, _sessionId: S });
      assertEquals(c.ok, true, `提交必须成立：${JSON.stringify(c)}`);
      const real = b.organ._lite.bind(b.organ);
      let undoCalls = 0;
      // 第二轮 provider undo（逆序里是 a.txt）**写完之后**才抛，并把 a 改成第三态：
      // 于是第一个文件已被证实撤回、a 的读锚定不了案 —— 正好停在 undo_indeterminate。
      b.organ._lite = async (action, params) => {
        const r = await real(action, params);
        if (action === 'undo' && ++undoCalls === 2) {
          writeFileSync(join(b.ws, 'src', 'a.txt'), 'THIRD-STATE\n');
          throw new Error('模拟：provider 在写完以后才抛');
        }
        return r;
      };
      const u1 = await b.call('txn.undo', { txn_id: c.txn.txn_id, _sessionId: S });
      assertEquals(u1.ok, false, '结果说不清时不得报成功');
      const st1 = await b.call('txn.inspect', { txn_id: c.txn.txn_id, _sessionId: S });
      assertEquals(st1.txn.state, 'undo_indeterminate');
      assertEquals(st1.txn.undo_unknown, 1);
      assertEquals(st1.txn.applied, 0, '判据前提：此刻没有任何文件仍被证实是 applied');

      // 外部把 a 恢复成提交前的字节 ⇒ 读锚这次能定案：这笔其实已经撤销了。
      writeFileSync(join(b.ws, 'src', 'a.txt'), 'alpha\n');
      const u2 = await b.call('txn.undo', { txn_id: c.txn.txn_id, _sessionId: S });
      assertEquals(u2.ok, true, `对账已证明全撤，必须结算为成功：${JSON.stringify(u2)}`);
      assertEquals(u2.settled_by, 'reconcile', '必须说清结论来自磁盘事实而不是 provider 自述');
      assertEquals(u2.txn.state, 'undone');
      assertEquals(u2.undone, 2);
      assertEquals(b.disk('src/a.txt'), 'alpha\n');
      assertEquals(b.disk('src/b.txt'), 'bravo\n');

      // 合法正例：结算之后再来一次必须幂等，且不得重新调用 provider。
      const before = undoCalls;
      const u3 = await b.call('txn.undo', { txn_id: c.txn.txn_id, _sessionId: S });
      assertEquals(u3.ok, true);
      assertEquals(u3.idempotent_replay, true);
      assertEquals(undoCalls, before, '已撤销的事务不得再发 Undo');
    } finally { await b.core.stop(); b.cleanup(); }
  });

  // ══ R20-02 正例：对账**仍说不清**时依然拒绝（防一律当成功）═══════════
  runner.test('R20-02 重入撤销但对账仍说不清：继续拒绝，不盲发 Undo', async () => {
    const b = await bootOrgan();
    try {
      const plan = await b.call('tool.txn-plan', {
        files: [{ path: 'src/a.txt', content: 'A2\n' }], _sessionId: S,
      });
      const c = await b.call('tool.txn-commit', { plan_id: plan.plan.plan_id, _sessionId: S });
      const real = b.organ._lite.bind(b.organ);
      let undoCalls = 0;
      b.organ._lite = async (action, params) => {
        if (action === 'undo' && ++undoCalls === 1) {
          writeFileSync(join(b.ws, 'src', 'a.txt'), 'THIRD-STATE\n');
          throw new Error('模拟：写完才抛且落到第三态');
        }
        return real(action, params);
      };
      const u1 = await b.call('txn.undo', { txn_id: c.txn.txn_id, _sessionId: S });
      assertEquals(u1.ok, false);
      const u2 = await b.call('txn.undo', { txn_id: c.txn.txn_id, _sessionId: S });
      assertEquals(u2.ok, false, '账没清就不许报成功');
      assertEquals(u2.code, 'UNDO_INDETERMINATE');
      assertEquals(u2.retry, 'after_reconcile');
      assertEquals(undoCalls, 1, '账没清就不能再发 Undo');
    } finally { await b.core.stop(); b.cleanup(); }
  });

  // ══ R20-03 并发 stop() 必须共享同一笔停机 ══════════════════════════
  runner.test('R20-03 并发 stop()：第二个调用方不得在插件停完前就 resolve', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'r20s-'));
    const { Core } = await imp('src/core/core.js');
    const core = new Core({ stateDir: dir });
    core.log = () => {};
    core._stopAssemblyDrainMs = 20;
    let finished = 0;
    core.register({
      name: 'slow', version: '1.0.0',
      async init() {}, async start() {},
      async stop() { await sleep(120); finished += 1; },
    });
    try {
      await core.start();
      const first = core.stop();
      await sleep(10);
      const second = core.stop();
      const settled = await Promise.race([
        second.then(() => 'settled'), sleep(60).then(() => 'pending'),
      ]);
      const atVerdict = finished;
      await Promise.all([first, second]);
      assert(!(settled === 'settled' && atVerdict === 0),
        `第二个 stop() 在插件停完之前就 resolve 了（finished=${atVerdict}）`);
      assertEquals(finished, 1, '插件只应被 stop 一次');
    } finally { await core.stop(); rmSync(dir, { recursive: true, force: true }); }
  });

  // ══ R20-04 停机之后卸载同一插件：不得第二次调用 stop() ═════════════
  runner.test('R20-04 停机后卸载同一插件：stop() 只被调用一次', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'r20u-'));
    const { Core } = await imp('src/core/core.js');
    const core = new Core({ stateDir: dir });
    core.log = () => {};
    core._stopAssemblyDrainMs = 20;
    let stops = 0;
    core.register({
      name: 'settled', version: '1.0.0',
      async init() {}, async start() {}, async stop() { stops += 1; },
    });
    try {
      await core.start();
      await core.stop();
      assertEquals(core.plugins.get('settled')?.state, 'stopped');
      const un = await core.lifecycle.unload('settled');
      assertEquals(un?.ok, true, '已停止的插件仍必须能被卸载');
      assertEquals(stops, 1, '同一个对象只应对被 stop 一次');
    } finally { await core.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
}
