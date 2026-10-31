// 发布门禁的**判定规则**（纯函数）。
//
// 为什么把判定从「怎么跑」里拆出来：G1 的缺陷不是跑错了命令，而是**判定规则**错了 ——
// 退出码被当成了唯一判据，而 `Failed: N` 虽然被解析出来却从不参与判断。
//
// 规则写死在脚本顶层时，唯一能测它的办法是跑完整个门禁（三遗单测 + 18 套探针 + 净室安装，
// 约十几分钟）。于是它没人测 —— 而一条没人测的判据，正是它退化成「看退出码」的原因。
//
// 现在：规则可单测（`test/unit/test-r017-gate-integrity.test.mjs`），
// 而且门禁每次运行都会用一个**真的会伪造失败打印**的夹具当场验证自己。

export const EVIDENCE_KINDS = ['suite', 'tool', 'probe'];

/** 取输出里**最后一条** `Label: N`。不存在返回 null（**不回退成 0**：0 是合法值）。 */
export function countFromOutput(out, label) {
  // 套件自报的口径只在**汇总行**。
  //
  // 这一条是踩出来的：单测里有两类输出会跟判据撞车 ——
  //   ① 用例名/断言消息里在**讨论**这个字符串（`R0-017/1 ... 内部 Failed: 3 必须判 FAIL`）；
  //   ② 探针输出里的表单字段（`requiredFailed:1`、`criticalFailed:1`）。
  // 两者都被 `Failed:\s*(\d+)` 当成“套件自称 N 个失败”，于是全绿的套件被判红。
  // 2026-10-26 的 rc.15 发布门禁就因此报了 6 个假 FAIL（3 个探针 + 3 轮单测）。
  //
  // 假红不是“安全”：它会逼人去改夹具或放宽判据，而那正是判据退化的入口。
  // 正确的规则是：一行里同时有 `Total:` 与 `Failed:` 的才是汇总行，取**最后**一条
  // （进度打印可能多次出现，最终口径在最后）。没有汇总行时退回全文匹配。
  // 先剥 ANSI 颜色码：本仓套件的汇总行带颜色，`\x1b[31mFailed: 0\x1b[0m` 里的
  // `m` 紧贴在 `Failed` 前面，会被下面的“独立标签”负向断言当成标识符字符而错过。
  // （这个坑修一次就够了：剥色比放宽断言安全，放宽会把 `xFailed:` 一起放进来。）
  const text = String(out).replace(/\u001b\[[0-9;]*m/g, '');
  let summary = null;
  for (const line of text.split('\n')) {
    if (/Total:\s*\d+/.test(line) && /Failed:\s*\d+/.test(line)) summary = line;
  }
  const scope = summary ?? text;
  const hits = [...scope.matchAll(new RegExp(`(?<![A-Za-z0-9_])${label}:\\s*(\\d+)`, 'g'))].map((m) => Number(m[1]));
  return hits.length ? hits[hits.length - 1] : null;
}

/**
 * 把一次执行的观测结果判成一个状态词。
 *
 * @param {{exitCode: number|string, failed?: number|null, skipped?: number|null,
 *          total?: number|null, evidence?: 'suite'|'tool'|'probe'}} obs
 * @returns {{status: 'PASS'|'FAIL'|'SKIP'|'NOT_RUN', reason: string|null}}
 */
export function verdictFor({ exitCode, failed = null, skipped = null, total = null, evidence = 'tool' }) {
  // ① 探针专用约定：退出码 3 = NOT_RUN（前置缺失，一条都没执行）。
  //    它不是失败（产品没坏），也**绝不是**通过（没跑就没有证据）。
  if (evidence === 'probe' && exitCode === 3) {
    return { status: 'NOT_RUN', reason: '前置缺失，探针一条都没执行（退出码 3）' };
  }
  // ② 退出码非 0：失败（"signal:*" 也归于此类）。
  if (exitCode !== 0) return { status: 'FAIL', reason: `退出码 ${exitCode}` };
  // ② 内部自称 Failed > 0：无论退出码，一律失败。
  //    这是 G1 的原点：`process.exit(0)` 与「真的没有失败」是两件事。
  if (Number(failed) > 0) return { status: 'FAIL', reason: `退出码 0，但输出自称 Failed: ${failed}` };
  // ③ 声称是套件的项必须自证跑过。没有计数 = 无法区分「跑了 1143 个」与「空壳 exit 0」。
  if (evidence === 'suite') {
    if (total === null || total === undefined) {
      return { status: 'FAIL', reason: '退出码 0，但没有用例计数（Total: N）—— 无法证明它真的跑过' };
    }
    if (Number(total) === 0) return { status: 'FAIL', reason: '退出码 0，但 0 个用例' };
  }
  // ④ 有跳过就是 SKIP，不是 PASS。
  if (Number(skipped) > 0) return { status: 'SKIP', reason: `${skipped} 个用例被跳过` };
  return { status: 'PASS', reason: null };
}
