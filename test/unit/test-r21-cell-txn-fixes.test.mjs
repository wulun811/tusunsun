// R21 修复的回归锁：cell-file-txn 的三条诚实性缺陷 + cell-runtime 的并发落盘。
//
// 每条缺陷用例都配一条合法正例：一个“一律拒绝”或“一律当未知”的修法同样能让缺陷用例变绿，
// 所以两个方向必须成对出现（AGENTS.md §3）。
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assert, assertEquals } from '../harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (rel) => import(join(ROOT, rel));
const S = 'sess-r21';

/** 真装配：workspace + liuhe-lite + 器官（不装 tool-registry，能力面直调即可）。 */
async function bootOrgan() {
  const base = mkdtempSync(join(tmpdir(), 'r21-txn-'));
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
  // 插件是模块单例：先摘掉上一个用例可能留下的 _lite 桩，避免链式污染。
  delete organ._lite;
  const call = async (cap, args) => {
    const env = await core.callCapability(cap, args);
    return env?.payload ?? env;
  };
  const disk = (rel) => readFileSync(join(ws, rel), 'utf8');
  const cleanup = () => {
    // 模块单例：用例结束就摘掉 _lite 桩，避免影响同进程里其它文件。
    delete organ._lite;
    rmSync(base, { recursive: true, force: true });
  };
  return { core, organ, call, ws, disk, cleanup };
}

export async function setup(runner) {
  // ══ R21-B4/1 对账读到的锚不携带事实：按未知处理，不得折算成“提交前” ═══
  runner.test('R21-B4/1 锚不带 sha 时对账必须停在未知：撤销不得报 undone', async () => {
    const b = await bootOrgan();
    try {
      const plan = await b.call('tool.txn-plan', { files: [{ path: 'src/n.txt', content: 'NEW\n' }], _sessionId: S });
      const c = await b.call('tool.txn-commit', { plan_id: plan.plan.plan_id, _sessionId: S });
      assertEquals(c.ok, true, `前置：提交必须成功：${JSON.stringify(c)}`);
      assertEquals(c.txn.files[0].before_sha256, null, '前置：新建文件的 before 就是“不存在”');
      const real = b.organ._lite.bind(b.organ);
      let reads = 0;
      b.organ._lite = async (action, params) => {
        if (action === 'undo') throw new Error('模拟：撤销结果丢失');
        // 第 1 次读锚是条件检查，第 2 次是 undo 的 _reconcile：provider 说 ok，却拿不出任何 hash 事实。
        if (action === 'read_anchor' && ++reads === 2) {
          return { ok: true, anchor: { path: params.path, exists: true, sha256: null } };
        }
        return real(action, params);
      };
      const u = await b.call('txn.undo', { txn_id: c.txn.txn_id, _sessionId: S });
      assertEquals(u.ok, false, '锚没有事实时不得报撤销成功');
      assertEquals(u.code, 'UNDO_INDETERMINATE');
      assertEquals(u.txn.state, 'undo_indeterminate');
      assertEquals(u.txn.undo_unknown, 1);
      assertEquals(b.disk('src/n.txt'), 'NEW\n', '文件仍是提交后的字节');
    } finally { await b.core.stop(); b.cleanup(); }
  });

  // ══ R21-B4/2 计划期的锚同样不许把“不知道”写成 exists_before:false ═══════
  runner.test('R21-B4/2 计划期锚拿不出事实：拒绝计划，不得报成 exists_before:false', async () => {
    const b = await bootOrgan();
    try {
      const real = b.organ._lite.bind(b.organ);
      b.organ._lite = async (action, params) => {
        if (action === 'read_anchor') return { ok: true, anchor: { path: params.path, exists: true } };
        return real(action, params);
      };
      const p = await b.call('tool.txn-plan', { files: [{ path: 'src/a.txt', content: 'A2\n' }], _sessionId: S });
      assertEquals(p.ok, false, '拿不出事实的锚不能用来签计划');
      assertEquals(p.code, 'ANCHOR_FAILED');
      b.organ._lite = real;
      // 合法正例：明确“不存在”的锚仍然是可用的事实（新建文件照常可计划）。
      const ok = await b.call('tool.txn-plan', { files: [{ path: 'src/new.txt', content: 'N\n' }], _sessionId: S });
      assertEquals(ok.ok, true, `明确不存在是事实，不是未知：${JSON.stringify(ok)}`);
      assertEquals(ok.plan.files[0].exists_before, false);
      assertEquals(ok.plan.files[0].before_sha256, null);
    } finally { await b.core.stop(); b.cleanup(); }
  });

  // ══ R21-B4/3 commit 镜像：写入已发生而锚不带事实时，不得按“没写”结案 ═════
  runner.test('R21-B4/3 提交期锚不带事实：已落盘的文件不得被判成 rejected', async () => {
    const b = await bootOrgan();
    try {
      const real = b.organ._lite.bind(b.organ);
      let reads = 0;
      b.organ._lite = async (action, params) => {
        if (action === 'read_anchor' && ++reads === 2) {
          return { ok: true, anchor: { path: params.path, exists: true, sha256: null } };
        }
        if (action === 'apply') {
          writeFileSync(join(b.ws, params.anchor.path), params.newContent);
          throw new Error('模拟：写入完成后响应丢失');
        }
        return real(action, params);
      };
      const p1 = await b.call('tool.txn-plan', { files: [{ path: 'src/n1.txt', content: 'N1\n' }], _sessionId: S });
      const c1 = await b.call('tool.txn-commit', { plan_id: p1.plan.plan_id, _sessionId: S });
      assertEquals(c1.txn.files[0].application, 'unknown', '拿不出事实的锚不能证明“没写”');
      assertEquals(c1.txn.unknown, 1);
      assertEquals(b.disk('src/n1.txt'), 'N1\n', '前置：文件确实已被写盘');
      // 合法正例：锚能给出真实 hash 时，同一形状必须结案为 applied，而不是一律 unknown。
      b.organ._lite = async (action, params) => {
        if (action === 'apply') {
          writeFileSync(join(b.ws, params.anchor.path), params.newContent);
          throw new Error('模拟：写入完成后响应丢失');
        }
        return real(action, params);
      };
      const p2 = await b.call('tool.txn-plan', { files: [{ path: 'src/n2.txt', content: 'N2\n' }], _sessionId: S });
      const c2 = await b.call('tool.txn-commit', { plan_id: p2.plan.plan_id, _sessionId: S });
      assertEquals(c2.txn.files[0].application, 'applied', '磁盘 hash 对得上就必须认账');
      assertEquals(c2.txn.unknown, 0);
    } finally { await b.core.stop(); b.cleanup(); }
  });

  // ══ R21-B5/1 撤销的 provider 幂等键必须接入调用方 request_id ══════════
  runner.test('R21-B5/1 撤销幂等键接入 request_id：换新 id 能重试一次瞬时失败', async () => {
    const b = await bootOrgan();
    try {
      const plan = await b.call('tool.txn-plan', { files: [{ path: 'src/a.txt', content: 'A2\n' }], _sessionId: S });
      const c = await b.call('tool.txn-commit', { plan_id: plan.plan.plan_id, _sessionId: S });
      assertEquals(c.ok, true);
      const real = b.organ._lite.bind(b.organ);
      const keys = [];
      const ledger = new Map();
      b.organ._lite = async (action, params) => {
        if (action !== 'undo') return real(action, params);
        keys.push(params.requestId);
        if (ledger.has(params.requestId)) {
          // provider 账本对已经记过的 id 只回 INDETERMINATE，不再执行。
          return { ok: false, code: 'INDETERMINATE', message: 'request_id already recorded' };
        }
        ledger.set(params.requestId, 'failed');
        if (keys.length === 1) return { ok: false, code: 'WRITE_FAILED', message: '瞬时写失败（执行前拒绝）' };
        writeFileSync(join(b.ws, 'src/a.txt'), 'alpha\n');
        return { ok: true, receipt: { application: 'applied', action_id: 'act-fake', recovery: { ref: 'fake-undo' } } };
      };
      const u1 = await b.call('txn.undo', { txn_id: c.txn.txn_id, request_id: 'retry-1', _sessionId: S });
      assertEquals(u1.ok, false);
      assertEquals(u1.code, 'WRITE_FAILED', `前置：本次撤销是执行前拒绝：${JSON.stringify(u1)}`);
      const u2 = await b.call('txn.undo', { txn_id: c.txn.txn_id, request_id: 'retry-2', _sessionId: S });
      assertEquals(u2.ok, true, `换一个 request_id 必须能真的重试：${JSON.stringify(u2)}`);
      assertEquals(u2.txn.state, 'undone');
      assertEquals(b.disk('src/a.txt'), 'alpha\n');
      assertEquals(keys.length, 2);
      assert(keys[0] !== keys[1], '两个不同的调用方 request_id 不得落到同一个 provider 幂等键上');
      assert(keys[1].includes('retry-2'), `新键必须带调用方 request_id：${keys[1]}`);
    } finally { await b.core.stop(); b.cleanup(); }
  });

  // ══ R21-B5/2 键的兼容语义：同一调用方 id 复用一个键，无 id 时保持历史键 ═══
  runner.test('R21-B5/2 幂等键兼容：同一 request_id 复用一键，不带 id 时保持历史键', async () => {
    const b = await bootOrgan();
    try {
      const plan = await b.call('tool.txn-plan', { files: [{ path: 'src/a.txt', content: 'A3\n' }], _sessionId: S });
      const c = await b.call('tool.txn-commit', { plan_id: plan.plan.plan_id, _sessionId: S });
      assertEquals(c.ok, true);
      const actionId = c.txn.files[0].action_id;
      assert(actionId, '前置：撤销键的历史形态依赖 action_id');
      const real = b.organ._lite.bind(b.organ);
      const keys = [];
      b.organ._lite = async (action, params) => {
        if (action !== 'undo') return real(action, params);
        keys.push(params.requestId);
        return { ok: false, code: 'WRITE_FAILED', message: '瞬时写失败（执行前拒绝）' };
      };
      const id = c.txn.txn_id;
      await b.call('txn.undo', { txn_id: id, request_id: 'req-fixed', _sessionId: S });
      await b.call('txn.undo', { txn_id: id, request_id: 'req-fixed', _sessionId: S });
      await b.call('txn.undo', { txn_id: id, _sessionId: S });
      assertEquals(keys.length, 3);
      assertEquals(keys[0], keys[1], '同一个调用方 request_id 必须映射同一个 provider 动作');
      assertEquals(keys[2], `${id}:undo:${actionId}`, '不带 request_id 时保留历史键，旧账本仍可复播');
    } finally { await b.core.stop(); b.cleanup(); }
  });

  // ══ R21-B6/1 commit 侧的 indeterminate 也必须可撤 ═══════════════════
  runner.test('R21-B6/1 提交结果不确定但已证实写入的文件：撤销必须能撤', async () => {
    const b = await bootOrgan();
    try {
      const plan = await b.call('tool.txn-plan', { files: [
        { path: 'src/a.txt', content: 'A2\n' }, { path: 'src/b.txt', content: 'B2\n' },
      ], _sessionId: S });
      const real = b.organ._lite.bind(b.organ);
      let applies = 0;
      b.organ._lite = async (action, params) => {
        if (action === 'apply' && ++applies === 2) throw new Error('模拟：第二笔结果丢失（未写盘）');
        return real(action, params);
      };
      const c = await b.call('tool.txn-commit', { plan_id: plan.plan.plan_id, _sessionId: S });
      assertEquals(c.txn.state, 'indeterminate');
      assertEquals(c.txn.files[0].application, 'applied');
      assertEquals(c.txn.files[1].application, 'rejected', '读锚证实第二笔没写');
      b.organ._lite = real;
      const u = await b.call('txn.undo', { txn_id: c.txn.txn_id, _sessionId: S });
      assertEquals(u.ok, true, `已证实写入的文件必须撤得回：${JSON.stringify(u)}`);
      assertEquals(u.txn.state, 'undone');
      assertEquals(u.undone, 1);
      assertEquals(b.disk('src/a.txt'), 'alpha\n');
      assertEquals(b.disk('src/b.txt'), 'bravo\n');
    } finally { await b.core.stop(); b.cleanup(); }
  });

  // ══ R21-B6/2 仍未知的文件必须先收口，收不了就不许撤（防“允许 indeterminate 撤”变松）═══
  runner.test('R21-B6/2 提交期仍未知的文件：撤销必须先收口，收不了就拒绝', async () => {
    const b = await bootOrgan();
    try {
      const plan = await b.call('tool.txn-plan', { files: [
        { path: 'src/a.txt', content: 'A2\n' }, { path: 'src/b.txt', content: 'B2\n' },
      ], _sessionId: S });
      const real = b.organ._lite.bind(b.organ);
      let applies = 0;
      b.organ._lite = async (action, params) => {
        if (action === 'apply' && ++applies === 2) {
          writeFileSync(join(b.ws, 'src/b.txt'), 'THIRD\n');
          throw new Error('模拟：第二笔落到第三态');
        }
        return real(action, params);
      };
      const c = await b.call('tool.txn-commit', { plan_id: plan.plan.plan_id, _sessionId: S });
      assertEquals(c.txn.state, 'indeterminate');
      assertEquals(c.txn.files[1].application, 'unknown');
      let undoCalls = 0;
      b.organ._lite = async (action, params) => {
        if (action === 'undo') undoCalls += 1;
        return real(action, params);
      };
      const u = await b.call('txn.undo', { txn_id: c.txn.txn_id, _sessionId: S });
      assertEquals(u.ok, false, '账没清就不得报撤销成功');
      assertEquals(u.code, 'UNDO_INDETERMINATE');
      assertEquals(u.txn.unknown, 1);
      assertEquals(b.disk('src/a.txt'), 'A2\n', '账没清就不得先撤别的文件');
      assertEquals(b.disk('src/b.txt'), 'THIRD\n');
      assertEquals(undoCalls, 0, '账没清就不能发 Undo');
    } finally { await b.core.stop(); b.cleanup(); }
  });

  // ══ R21-D17/1 带 BOM 的文件：锚 = 原始字节 hash，可正常 plan → commit ═══
  runner.test('R21-D17/1 带 BOM 的文件照常提交：锚是原始字节 hash，写盘内容不带 BOM', async () => {
    const b = await bootOrgan();
    try {
      const bomBytes = Buffer.from('\uFEFFalpha\n', 'utf8');
      writeFileSync(join(b.ws, 'src', 'bom.txt'), bomBytes);
      const rawSha = createHash('sha256').update(bomBytes).digest('hex');
      const plan = await b.call('tool.txn-plan', { files: [{ path: 'src/bom.txt', content: 'bravo\n' }], _sessionId: S });
      assertEquals(plan.ok, true, `带 BOM 的文件不得被拒：${JSON.stringify(plan)}`);
      assertEquals(plan.plan.files[0].before_sha256, rawSha,
        '锚必须等于原始字节的 sha256：上游改成保留 BOM 后，解码文本的 hash 就是字节的 hash');
      const c = await b.call('tool.txn-commit', { plan_id: plan.plan.plan_id, _sessionId: S });
      assertEquals(c.ok, true, `提交必须成功：${JSON.stringify(c)}`);
      assertEquals(c.txn.state, 'committed');
      assertEquals(readFileSync(join(b.ws, 'src', 'bom.txt')).equals(Buffer.from('bravo\n', 'utf8')), true,
        '写盘内容就是调用方给的字节：不保留旧 BOM，也不凭空新增');
    } finally { await b.core.stop(); b.cleanup(); }
  });

  // ══ R21-D17/2 合法正例：撤销把原始字节（含 BOM）原样还回来 ═══════════
  runner.test('R21-D17/2 撤销还原带 BOM 的原始字节；无 BOM 的文件照常提交', async () => {
    const b = await bootOrgan();
    try {
      const bomBytes = Buffer.from('\uFEFFalpha\n', 'utf8');
      writeFileSync(join(b.ws, 'src', 'bom.txt'), bomBytes);
      const plan = await b.call('tool.txn-plan', { files: [{ path: 'src/bom.txt', content: 'bravo\n' }], _sessionId: S });
      const c = await b.call('tool.txn-commit', { plan_id: plan.plan.plan_id, _sessionId: S });
      assertEquals(c.ok, true, `前置：提交必须成功：${JSON.stringify(c)}`);
      const u = await b.call('txn.undo', { txn_id: c.txn.txn_id, _sessionId: S });
      assertEquals(u.ok, true, `撤销必须成功：${JSON.stringify(u)}`);
      assertEquals(readFileSync(join(b.ws, 'src', 'bom.txt')).equals(bomBytes), true,
        '撤销必须还原原始字节，含开头 3 字节 BOM（备份按解码文本存就会丢）');

      // 无 BOM 的普通文件照常提交，且不凭空加 BOM（防“一律加/一律去 BOM”式假修复）
      const p2 = await b.call('tool.txn-plan', { files: [{ path: 'src/a.txt', content: 'A2\n' }], _sessionId: S });
      assertEquals(p2.ok, true, `无 BOM 的文件不得被误伤：${JSON.stringify(p2)}`);
      const c2 = await b.call('tool.txn-commit', { plan_id: p2.plan.plan_id, _sessionId: S });
      assertEquals(c2.ok, true, `无 BOM 的正常提交必须成功：${JSON.stringify(c2)}`);
      assertEquals(readFileSync(join(b.ws, 'src', 'a.txt')).equals(Buffer.from('A2\n', 'utf8')), true,
        '写盘字节不得凭空多出 BOM');

      // 零改动仍是 noop：内容与磁盘字节完全一致时不写盘（BOM 不是“无变化”，它本身就是字节差异）
      const noopBytes = Buffer.from('same\n', 'utf8');
      writeFileSync(join(b.ws, 'src', 'noop.txt'), noopBytes);
      const p3 = await b.call('tool.txn-plan', { files: [{ path: 'src/noop.txt', content: 'same\n' }], _sessionId: S });
      assertEquals(p3.ok, true, `零改动的计划不该被拒：${JSON.stringify(p3)}`);
      assertEquals(p3.plan.changed, 0);
      const c3 = await b.call('tool.txn-commit', { plan_id: p3.plan.plan_id, _sessionId: S });
      assertEquals(c3.ok, true);
      assertEquals(c3.txn.noop, true);
      assertEquals(readFileSync(join(b.ws, 'src', 'noop.txt')).equals(noopBytes), true, 'noop 不得改字节');
    } finally { await b.core.stop(); b.cleanup(); }
  });

  // ══ R21-D16 同一 Cell 并发落盘：临时名不能共用，失败路径不留残骸 ══════
  runner.test('R21-D16 同一 Cell 并发落盘：25 次全成功、不留 .tmp，失败路径也清理', async () => {
    const base = mkdtempSync(join(tmpdir(), 'r21-persist-'));
    try {
      const rt = (await imp('plugins/cell-runtime.js')).default;
      const core = { stateDir: base, log: () => {} };
      const rec = {
        spec: { cell_id: 'cell-1', workspace: base }, state: 'running',
        incarnationId: 'inc-1', sessionId: S, workspaceReal: base,
      };
      const results = await Promise.allSettled(Array.from({ length: 25 }, () => rt._persist(core, rec)));
      const failed = results.filter((r) => r.status === 'rejected');
      assertEquals(failed.length, 0,
        `并发落盘不得失败：${failed.map((r) => r.reason?.code || r.reason?.message).join(',')}`);
      const dir = join(base, 'cells', 'cell-1');
      assertEquals(readdirSync(dir).filter((n) => n.includes('.tmp')).length, 0, '成功路径不得留下临时文件');
      assertEquals(JSON.parse(readFileSync(join(dir, 'cell.json'), 'utf8')).spec.cell_id, 'cell-1');
      // 失败路径：rename 的目标是个目录 ⇒ 落盘必须抛出，且临时文件要被清掉。
      const dir2 = join(base, 'cells', 'cell-2');
      mkdirSync(join(dir2, 'cell.json'), { recursive: true });
      let threw = false;
      try {
        await rt._persist(core, { ...rec, spec: { ...rec.spec, cell_id: 'cell-2' } });
      } catch { threw = true; }
      assert(threw, '落盘失败必须抛出，不能吞');
      assertEquals(readdirSync(dir2).filter((n) => n.includes('.tmp')).length, 0, '失败路径必须清掉临时文件');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
}
