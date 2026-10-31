// L2 回执字段对齐（v0.11.0）—— 与六合 Lite 的跨实现合同。
//
// 计划书 §6 L2：两套系统用 `request_id / provider_operation_id` 做关联，
// 且"两套任务 ID、状态和验收不可互相替代"。
//
// v0.10.x 的实测缺口（我把六合 Lite 0.1.x 的四种真实回执喂进本仓 `buildReceipt`）：
//
//     apply 成功（applied）           → 通过
//     undo 成功（applied）            → 通过
//     reconcile 判第三态（needs_review）→ **拒收**：application must be one of
//                                        prepared|applied|rejected|failed|indeterminate
//     reconcile 判撤销后（not_applied） → **拒收**：同上
//
// 也就是说：跨实现的回执对不上，**责任在我这边**。而 `reconcile` 的核心价值
// 恰恰就是区分"从未落地"与"落地后被撤销" —— 这两个值就是那个区分。
//
// 本文件锁三件事：
//   ① 枚举补齐（加值，不改名不换义，v0 旧回执照读）；
//   ② 归属字段 `provider / provider_operation_id / request_id` **只在调用方真的给了**才写
//      —— 原生写盘没有幂等账本，填一个"看起来像幂等键"的东西就是编造（D-6 的答复）；
//   ③ 六合那四种回执形状必须能通过我方校验器（这是 L2 可联调的最低条件）。
import { readFileSync } from 'node:fs';
import { assert, assertEquals } from '../harness.mjs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(join(ROOT, rel));
const src = (rel) => readFileSync(join(ROOT, rel), 'utf-8');

/** 一份合法的原生回执底稿（与 tool-write 实际传的字段同形）。 */
const BASE = {
  application: 'applied',
  target: { path: 'a.txt', canonical_scope: 'cell_workspace' },
  effect: { kind: 'file_modified', before_sha256: 'b', after_sha256: 'a' },
  verification: 'not_run',
  recovery: { supported: false, ref: null },
  persistence: 'volatile',
};

export async function setup(runner) {
  // ══ L2/1：枚举补齐 —— 加值不改义，旧五值照读 ═════════════════════════════════
  runner.test('L2/1 application 枚举补齐 not_applied / needs_review，且旧五值不受影响', async () => {
    const m = await imp('plugins/_lib/action-receipt.mjs');
    const STATES = m.APPLICATION_STATES;
    for (const v of ['prepared', 'applied', 'rejected', 'failed', 'indeterminate']) {
      assert(STATES.includes(v), `旧值 ${v} 不得被删（删了就是换义，必须升版本）`);
    }
    for (const v of ['not_applied', 'needs_review']) {
      assert(STATES.includes(v), `必须补 ${v} —— 否则六合的 reconcile 回执会被我方拒收`);
    }
    // 真跑一遍校验器，不只是看数组
    for (const v of ['not_applied', 'needs_review']) {
      const r = m.buildReceipt({ ...BASE, application: v });
      assertEquals(r.ok, true, `${v} 必须通过形状校验，实际违规项 ${JSON.stringify(r.violations)}`);
      assertEquals(r.receipt.application, v, '回执必须原样保留该值（不得悄悄归一成 indeterminate）');
    }
    // 反例：真正非法的值仍必须被拒（补齐枚举不等于放宽校验）
    const bad = m.buildReceipt({ ...BASE, application: 'probably_ok' });
    assertEquals(bad.ok, false, '非法 application 仍必须被拒 —— 补齐枚举不得变成"什么都收"');
    console.log(`       [实测] 枚举 ${STATES.length} 项；两个新值通过，非法值仍拒`);
  });

  // ══ L2/2：六合四种真实回执形状必须能过我方校验器 ═════════════════════════════
  //
  // 形状取自六合 Lite 0.1.2 的实测输出（`RECEIPT-FIELD-ALIGNMENT.md` §7 与
  // `tests/cell-acceptance.mjs` C05/C06 核对过的那份），不是编的。
  runner.test('L2/2 六合 Lite 的四种回执形状必须全部通过我方校验器', async () => {
    const m = await imp('plugins/_lib/action-receipt.mjs');
    const LIUHE = [
      { name: 'apply 成功', application: 'applied', persistence: 'persisted' },
      { name: 'undo 成功', application: 'applied', persistence: 'persisted' },
      { name: 'reconcile 第三态', application: 'needs_review', persistence: 'persisted' },
      { name: 'reconcile 撤销后', application: 'not_applied', persistence: 'persisted' },
    ];
    for (const c of LIUHE) {
      // 按六合的真实形状投喂：它有 provider/operation_id/request_id，target 是**字符串**
      const r = m.buildReceipt({
        action_id: 'act-txn_1792648625411_350fb5a4_p4089310',
        cell_id: 'accept-cell', incarnation_id: 'inc-accept', task_id: 'acceptance',
        application: c.application,
        persistence: c.persistence,
        target: { path: 'target.txt', canonical_scope: 'cell_workspace' },
        effect: { kind: 'file_modified', before_sha256: 'b', after_sha256: 'a' },
        verification: 'not_run',
        recovery: { supported: true, ref: 'liuhe-undo:txn_1792648625411_350fb5a4_p4089310' },
        provider: 'liuhe-lite',
        provider_operation_id: 'txn_1792648625411_350fb5a4_p4089310',
        request_id: 'accept-apply-1792663741691',
      });
      assertEquals(r.ok, true,
        `六合的「${c.name}」回执必须能被我方校验器接受 —— 否则 L2 联调无从谈起。`
        + `违规项：${JSON.stringify(r.violations)}`);
    }
    console.log('       [实测] 六合四种形状 4/4 通过');
  });

  // ══ L2/3：归属字段只在给了才写 —— 原生回执必须字节不变 ═══════════════════════
  //
  // 这条是"旧输出不得退化"的同一原则：加字段不能改变已有回执的形状，
  // 否则审计侧的历史比对会整体失效。
  runner.test('L2/3 原生回执不得凭空多出归属字段（只在调用方给了才写）', async () => {
    const m = await imp('plugins/_lib/action-receipt.mjs');
    const native = m.buildReceipt({ ...BASE });
    assertEquals(native.ok, true, '前提：原生回执应通过校验');
    for (const k of ['provider', 'provider_operation_id', 'request_id']) {
      assert(!(k in native.receipt),
        `原生回执不该有 ${k} —— 原生写盘没有这个事实，凭空填就是编造（D-6 的答复）`);
    }
    // 给了就必须写进去，且原样保留
    const withAttr = m.buildReceipt({
      ...BASE, provider: 'liuhe-lite', provider_operation_id: 'txn_1', request_id: 'r-1',
    });
    assertEquals(withAttr.receipt.provider, 'liuhe-lite', '给了 provider 必须写进回执');
    assertEquals(withAttr.receipt.provider_operation_id, 'txn_1', 'provider_operation_id 必须原样保留');
    assertEquals(withAttr.receipt.request_id, 'r-1', 'request_id 必须原样保留');
    console.log('       [实测] 原生回执零新增字段；带归属时三个字段都在');
  });

  // ══ L2/4：空值不得被写成字段（空串 ≠ 一个值）══════════════════════════════════
  runner.test('L2/4 归属字段给空串/null 时不得写成字段', async () => {
    const m = await imp('plugins/_lib/action-receipt.mjs');
    for (const v of [null, undefined, '']) {
      const r = m.buildReceipt({ ...BASE, provider: v, request_id: v });
      assert(!('provider' in r.receipt), `provider=${JSON.stringify(v)} 不该产生字段`);
      assert(!('request_id' in r.receipt), `request_id=${JSON.stringify(v)} 不该产生字段`);
    }
    console.log('       [实测] null/undefined/空串都不产生字段');
  });

  // ══ L2/5：**结构性**判据 —— 钉住"值是从哪来的" ═══════════════════════════════
  runner.test('L2/5 结构判据：枚举与归属字段必须由单一常量驱动', async () => {
    const s = src('plugins/_lib/action-receipt.mjs');
    assert(/export const APPLICATION_STATES = \[[\s\S]*?'not_applied'[\s\S]*?'needs_review'[\s\S]*?\]/.test(s),
      'APPLICATION_STATES 必须显式含两个新值（不得靠别处拼接）');
    assert(/export const ATTRIBUTION_FIELDS = \[[^\]]*'provider'[^\]]*'provider_operation_id'[^\]]*'request_id'/.test(s),
      '归属字段必须由 ATTRIBUTION_FIELDS 单一常量驱动（否则加一个字段要改两处）');
    assert(/ATTRIBUTION_FIELDS[\s\S]{0,200}?filter\(/.test(s),
      'buildReceipt 必须真的用 ATTRIBUTION_FIELDS 过滤，而不是手写三行 if');
    // 旧值语义不得被改动：persistence 仍以 volatile 为原生真值（六合的 memory_only 属 v1 归一）
    const m = await imp('plugins/_lib/action-receipt.mjs');
    assert(m.PERSISTENCE_STATES.includes('volatile'),
      'persistence 仍必须有 volatile —— 与六合的口径分歧走 v1 归一，不在 v0 里改名');
    console.log('       [实测] 两个常量驱动、旧口径未动');
  });
}
