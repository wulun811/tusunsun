// ACT-06 / ACT-07（v0.11.0）：回执的两个维度补完 —— **谁还能读** 与 **读出来会不会泄露**。
//
// 计划书 A5 的十条里，v0.10.x 只做了会话隔离（`receipt_not_yours`）。剩下两条：
//
//   ACT-06 未授权 / 已关闭 / 超时 Cell 的**执行资格**拒绝
//          修前：会话对上了就放行。Cell 已被 `close()` 收口（或 faulted），
//          同一个 `cell-<id>` 会话仍然能把它生前的动作明细读出来。
//          会话标识是**长期**的，Cell 的执行资格是**阶段性**的 —— 只判前者等于跳过后者。
//
//   ACT-07 高敏文件的**披露**收缩
//          修前：`target.path` 是工作区相对路径，不泄露宿主绝对路径（这条早守住了），
//          但会把**文件名**原样带出去：`id_rsa` / `.env` / `credentials.json` 进回执，
//          回执又进模型上下文与审计日志 —— 等于把"这个工作区有哪些敏感文件"抄一遍。
//
// ACT-07 刻意**不拦写入**：拦不拦是产品决策（用户可能就是要让 Agent 改 .env），
// 归 D-5 单独定；这里只减少披露，并显式标 `redacted`，不静默改写。
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assert, assertEquals } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(join(ROOT, rel));
const src = (rel) => readFileSync(join(ROOT, rel), 'utf-8');

/**
 * 造真执行器 + 真 tool-write。
 * `cellState` 是**可变**的：用例中途改它就能模拟"执行中途 Cell 被收口"。
 */
async function makeHost({ withCellRuntime = true } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'act0607-'));
  const { Core } = await imp('src/core/core.js');
  const core = new Core({ stateDir: join(d, 'state') });
  core.log = () => {};
  core.setData('agent.workDir', d);
  const T = (await imp('plugins/tool-executor.js')).default;
  const ex = Object.create(T);
  ex._preHooks = []; ex._postHooks = []; ex._dispatchHooks = [];
  ex._rateCalls = new Map(); ex._cache = new Map(); ex._auditLog = new Map();
  ex._receipts = new Map(); ex._receiptMax = 100;
  ex._metrics = new Map(); ex._preferences = new Map(); ex._debugStream = null;
  ex._maxParallel = 5; ex._timeout = 30000;
  ex.core = core;
  await ex.init(core);

  const W = (await imp('plugins/tools/tool-write.js')).default;
  const write = Object.create(W);
  write.core = core;
  await write.init(core);
  core.registerService('tool-registry', {
    get: async (n) => (n === 'tool-write' ? write : null),
    has: (n) => n === 'tool-write',
    listTools: () => [],
  });

  const cell = { state: 'ready', fault_reason: null, known: new Set(['C1']) };
  if (withCellRuntime) {
    core.registerService('cell-runtime', {
      describe: (id) => {
        if (!cell.known.has(id)) throw Object.assign(new Error(`unknown cell: ${id}`), { code: 'unknown_cell' });
        return { cell_id: id, state: cell.state, ...(cell.fault_reason ? { fault_reason: cell.fault_reason } : {}) };
      },
      list: () => [],
    });
  }

  const stop = async () => { try { await ex.stop(); } catch { /* 停不掉不影响断言结论 */ } };
  return { d, core, ex, write, cell, stop };
}

/** 写一次文件，返回回执 id。 */
async function writeOnce(h, sessionId = 'sess-A') {
  writeFileSync(join(h.d, 'a.txt'), 'v1\n');
  const res = await h.ex.executeBatch(
    [{ id: 'c1', name: 'tool-write', arguments: JSON.stringify({ path: 'a.txt', content: 'v2\n' }) }],
    { sessionId, chainId: 'c1' },
  );
  const text = String(res[0].result ?? '');
  const m = text.match(/action\.inspect (act-[\w.-]+)/);
  assert(m, `工具输出应带 action.inspect 提示，实际：${text.slice(-160)}`);
  return m[1];
}

async function inspectAs(h, actionId, sessionId) {
  const res = await h.ex.executeBatch(
    [{ id: 'i1', name: 'action.inspect', arguments: JSON.stringify({ action_id: actionId }) }],
    { sessionId, chainId: 'c2' },
  );
  return JSON.parse(String(res[0].result ?? '{}'));
}

export async function setup(runner) {
  // ══ ACT-06/1：Cell 已收口 → 拒绝（且与"不是你的"可区分）════════════════════════
  runner.test('ACT-06/1 Cell 已关闭时不得再读它的回执（receipt_cell_closed）', async () => {
    const h = await makeHost();
    try {
      const id = await writeOnce(h, 'cell-C1');
      // 前提：Cell 还在册时读得到
      assertEquals((await inspectAs(h, id, 'cell-C1')).ok, true, '前提：Cell 在册时必须读得到');

      h.cell.state = 'stopped';   // 模拟 close()
      const r = await inspectAs(h, id, 'cell-C1');
      assertEquals(r.ok, false,
        'Cell 已收口后仍能读回执 —— 修前只判会话，而会话标识是长期的、Cell 资格是阶段性的');
      assertEquals(r.code, 'receipt_cell_closed', `应 receipt_cell_closed，实际 ${r.code}`);
      assert(String(r.error).includes('closed'), '拒绝理由应说明已收口');
      console.log(`       [实测] 收口后 code=${r.code}`);
    } finally { await h.stop(); rmSync(h.d, { recursive: true, force: true }); }
  });

  // ══ ACT-06/2：Cell 故障 → 拒绝，且理由里带故障原因 ═════════════════════════════
  runner.test('ACT-06/2 Cell faulted 时拒绝，并给出故障原因（receipt_cell_faulted）', async () => {
    const h = await makeHost();
    try {
      const id = await writeOnce(h, 'cell-C1');
      h.cell.state = 'faulted';
      h.cell.fault_reason = 'workspace binding lost';
      const r = await inspectAs(h, id, 'cell-C1');
      assertEquals(r.ok, false, 'faulted 的 Cell 状态不可信，回执也不该再披露');
      assertEquals(r.code, 'receipt_cell_faulted', `应 receipt_cell_faulted，实际 ${r.code}`);
      assert(String(r.error).includes('workspace binding lost'),
        '拒绝理由应带上 Cell 的故障原因（否则调用方不知道该修什么）');
      console.log(`       [实测] faulted 后 code=${r.code}，理由含故障原因`);
    } finally { await h.stop(); rmSync(h.d, { recursive: true, force: true }); }
  });

  // ══ ACT-06/3：Cell 仍可用时不得误伤（ready / busy 都要放行）════════════════════
  runner.test('ACT-06/3 反例：Cell ready / busy 时仍须放行（判据不得一刀切）', async () => {
    const h = await makeHost();
    try {
      const id = await writeOnce(h, 'cell-C1');
      for (const st of ['ready', 'busy', 'draining']) {
        h.cell.state = st;
        const r = await inspectAs(h, id, 'cell-C1');
        assertEquals(r.ok, true, `Cell state=${st} 时应放行 —— 拒绝只针对已收口/故障，实际 code=${r.code}`);
      }
      console.log('       [实测] ready / busy / draining 均放行');
    } finally { await h.stop(); rmSync(h.d, { recursive: true, force: true }); }
  });

  // ══ ACT-06/4：普通对话会话不受 Cell 判据影响 ═══════════════════════════════════
  //
  // 没有这一条，把"查不到 Cell 就拒绝"写进去也能让上面三条全绿 ——
  // 而那会把所有非 Cell 用法一起打死。
  runner.test('ACT-06/4 反例：普通会话走会话隔离，不得被判成 cell_*', async () => {
    const h = await makeHost();
    try {
      const id = await writeOnce(h, 'sess-A');
      const own = await inspectAs(h, id, 'sess-A');
      assertEquals(own.ok, true, '普通会话读自己的回执必须成功');
      const other = await inspectAs(h, id, 'sess-B');
      assertEquals(other.code, 'receipt_not_yours',
        `跨普通会话应是 receipt_not_yours，实际 ${other.code} —— 不得被 Cell 判据接管`);
      console.log('       [实测] 普通会话：本人放行、跨会话 receipt_not_yours');
    } finally { await h.stop(); rmSync(h.d, { recursive: true, force: true }); }
  });

  // ══ ACT-06/5：Cell 运行时未装配时不得误伤 ══════════════════════════════════════
  runner.test('ACT-06/5 未装配 cell-runtime 时，Cell 会话仍按会话隔离工作（不误伤）', async () => {
    const h = await makeHost({ withCellRuntime: false });
    try {
      const id = await writeOnce(h, 'cell-C1');
      const r = await inspectAs(h, id, 'cell-C1');
      assertEquals(r.ok, true,
        '未装配 Cell 运行时就没有"执行资格"这个事实源，此时不能凭空拒绝 —— 那等于把可选组件变成硬依赖');
      console.log('       [实测] 无 cell-runtime 时放行（判据只在该服务在场时生效）');
    } finally { await h.stop(); rmSync(h.d, { recursive: true, force: true }); }
  });

  // ══ ACT-06/6：**结构性**判据 —— 判据必须取运行事实，不得取回执自述 ═════════════
  runner.test('ACT-06/6 结构判据：资格判据取 cell-runtime 运行事实，且判据在会话判定之后', async () => {
    const exec = src('plugins/tool-executor.js');
    assert(exec.includes("getService?.('cell-runtime')"),
      '资格判据必须向 cell-runtime 取运行事实（不能读回执里的自述字段）');
    assert(/_cellEligibilityFor\(sessionId\)/.test(exec),
      'inspectAction 必须调用 _cellEligibilityFor');
    // 顺序：会话归属判定必须在资格判定之前 —— 否则"别人的回执"会被报成"Cell 已关闭"，语义错位
    const iSession = exec.indexOf("belongs to another session; refusing to disclose it");
    const iGate = exec.indexOf('const cellGate = this._cellEligibilityFor(sessionId);');
    assert(iSession > 0 && iGate > 0 && iGate > iSession,
      '资格判据必须排在会话归属判定之后（先证明"是你的"，再问"你现在还有没有资格"）');
    console.log('       [实测] 取运行事实、调用点存在、顺序正确');
  });

  // ══ ACT-07/1：敏感文件名必须被脱敏，且显式标注 ═════════════════════════════════
  runner.test('ACT-07/1 高敏文件名在回执里必须换成占位符并标 redacted', async () => {
    const { redactTargetPath } = await imp('plugins/_lib/action-receipt.mjs');
    const cases = [
      ['id_rsa', 'private_key'],
      ['.env', 'env_file'],
      ['.env.production', 'env_file'],
      ['credentials.json', 'credential_file'],
      ['secrets.yaml', 'secret_file'],
      ['config/key.pem', 'key_material'],
      ['.ssh/config', 'ssh_path'],
    ];
    for (const [p, kind] of cases) {
      const r = redactTargetPath(p);
      assertEquals(r.redacted, kind, `${p} 应被判为 ${kind}`);
      assert(r.path.startsWith('<redacted:'), `${p} 的路径必须换成占位符，实际 ${r.path}`);
      assert(!r.path.includes('id_rsa') && !r.path.includes('.env'),
        '占位符里不得残留原文件名');
    }
    // 真回执里也要生效（不是只有函数对）
    const built = (await imp('plugins/_lib/action-receipt.mjs')).buildReceipt({
      application: 'applied', target: { path: 'id_rsa', canonical_scope: 'cell_workspace' },
      effect: { kind: 'file_modified', after_sha256: 'x' }, persistence: 'volatile',
      recovery: { supported: false, ref: null }, verification: 'not_run',
    });
    assertEquals(built.ok, true, '前提：这份回执应通过形状校验');
    assertEquals(built.receipt.target.path, '<redacted:private_key>', 'buildReceipt 必须真的脱敏');
    assertEquals(built.receipt.target.redacted, 'private_key', '必须显式标 redacted（不静默改写）');
    console.log('       [实测] 7 类高敏名全部脱敏并标注');
  });

  // ══ ACT-07/2：反例 —— 普通文件名必须原样保留 ═══════════════════════════════════
  //
  // 没有这一条，"把所有路径都换成占位符"也能让 ACT-07/1 全绿 ——
  // 而那会让回执失去它唯一的价值：说明到底改了哪个文件。
  runner.test('ACT-07/2 反例：普通路径必须原样保留（脱敏不得过度）', async () => {
    const { redactTargetPath } = await imp('plugins/_lib/action-receipt.mjs');
    for (const p of ['src/app.js', 'README.md', 'docs/index.md', 'lib/env.js', 'a/b/c.ts']) {
      const r = redactTargetPath(p);
      assertEquals(r.redacted, null, `${p} 不该被判为敏感`);
      assertEquals(r.path, p, `${p} 必须原样返回`);
    }
    console.log('       [实测] 5 个普通路径原样保留');
  });

  // ══ ACT-07/3：真执行器跑一遍，回执里不得出现宿主绝对路径 ═══════════════════════
  runner.test('ACT-07/3 真实回执里不得出现工作区绝对路径', async () => {
    const h = await makeHost();
    try {
      const id = await writeOnce(h, 'sess-A');
      const r = await inspectAs(h, id, 'sess-A');
      const json = JSON.stringify(r);
      assertEquals(json.includes(h.d), false,
        `回执里出现了宿主绝对路径 ${h.d} —— 那是泄露宿主目录结构`);
      assertEquals(json.includes(tmpdir()), false, '回执里不得出现临时目录绝对路径');
      assertEquals(r.receipt.target.path, 'a.txt', '目标路径应是工作区相对路径');
      console.log('       [实测] 回执无绝对路径，target.path 为相对路径');
    } finally { await h.stop(); rmSync(h.d, { recursive: true, force: true }); }
  });

  // ══ ACT-07/4：结构判据 —— buildReceipt 必须走脱敏函数 ═════════════════════════
  runner.test('ACT-07/4 结构判据：buildReceipt 的 target.path 必须经 redactTargetPath', async () => {
    const receiptSrc = src('plugins/_lib/action-receipt.mjs');
    assert(/export function redactTargetPath/.test(receiptSrc), '必须导出 redactTargetPath');
    assert(/path: redactTargetPath\(f\.target\?\.path \?\? null\)\.path/.test(receiptSrc),
      'buildReceipt 的 target.path 必须经 redactTargetPath —— 否则脱敏只在测试里成立，真实回执照样泄露');
    assert(/redacted: redactTargetPath/.test(receiptSrc),
      '必须把 redacted 种类写进回执（显式标注，不静默改写）');
    console.log('       [实测] 结构接线正确');
  });
}
