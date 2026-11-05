// R0-016（v0.15.1）：**证据单源**——同一版的行数不许在两处说两个数。
//
// 专家 0.15.0 复审 §2「行数事实」抓到：`scripts/core-limits.mjs` 与 microkernel.md 写 3009，
// 而 `docs/adr/ADR-10-core-line-budget.md` 写 2991；同一份发行说明里还写着"增量 111 行"
// （实际 2880 → 3009 = 129）。三处各说各话，任何一处被当成"权威"都会误导下一轮。
//
// 光改一次数字没用 —— 下一轮还会漂。所以这里把"谁说了算"变成**可执行的判据**：
//   · 权威 = `scripts/line-check.js` 的实测值（与 `CORE_MAX_LINES` 必须相等）；
//   · ADR-10 版本表的**最后一行**必须等于该实测值；
//   · ADR-10 里所有"当前 N 行"的说法必须等于该实测值；
//   · microkernel.md 的"核心 ≤ N 行"必须等于该实测值。
//
// 附带钉住 ADR-11 的七类归一：`category` 只能取七个值或 null，`result_kind` 只有三种，
// 且 `denied` 与 `side_effect:'none'` 必须同时成立（ERR-015 之后这条才有意义）。
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestRunner, assert, assertEquals } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const SEVEN = new Set(['request', 'assembly', 'environment', 'resource', 'security', 'upstream', 'internal']);

/** 官方口径：`src/core/*.js` 逐个 split('\n').length 求和（与 scripts/line-check.js 一致）。 */
function measuredCoreLines() {
  const dir = join(ROOT, 'src', 'core');
  let total = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.js')) continue;
    total += readFileSync(join(dir, f), 'utf8').split('\n').length;
  }
  return total;
}

export async function setup(runner) {
  const measured = measuredCoreLines();

  runner.test('R0-016/1 行数权威单源：CORE_MAX_LINES 必须等于实测值', async () => {
    const src = read('scripts/core-limits.mjs');
    const m = src.match(/export const CORE_MAX_LINES = (\d+);/);
    assert(m, 'scripts/core-limits.mjs 里找不到 CORE_MAX_LINES');
    assertEquals(Number(m[1]), measured, `上限 ${m[1]} 与实测 ${measured} 不一致（改预算须同改实测）`);
    console.log(`       [实测] CORE_MAX_LINES = 实测 = ${measured}`);
  });

  runner.test('R0-016/2 ADR-10 版本表最后一行必须等于实测值（专家 §2 的那处漂移）', async () => {
    const md = read('docs/adr/ADR-10-core-line-budget.md');
    // 版本表行形如：| v0.15.1 | 3009 → **3107** | 说明 |
    const rows = [...md.matchAll(/^\|\s*v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*\|\s*(\d+)\s*→\s*\*\*(\d+)\*\*\s*\|/gm)];
    assert(rows.length > 0, 'ADR-10 里没有找到任何版本表行');
    const last = rows[rows.length - 1];
    assertEquals(Number(last[3]), measured,
      `ADR-10 最后一行记 v${last[1]} = ${last[3]}，实测 ${measured} —— 同一版两个数，正是专家点的那处`);
    console.log(`       [实测] ADR-10 末行 v${last[1]} = ${last[3]} = 实测 ${measured}（共 ${rows.length} 行）`);
  });

  runner.test('R0-016/3 ADR-10 全文的"当前 N 行"必须等于实测值（不许只在表格里对）', async () => {
    const md = read('docs/adr/ADR-10-core-line-budget.md');
    const hits = [...md.matchAll(/当前\s*(\d+)\s*行/g)].map((m) => Number(m[1]));
    assert(hits.length > 0, 'ADR-10 里没有"当前 N 行"的说法（若删掉了这句，请同步删本条判据）');
    for (const n of hits) {
      assertEquals(n, measured, `ADR-10 正文写"当前 ${n} 行"，实测 ${measured}`);
    }
    console.log(`       [实测] ADR-10 正文 ${hits.length} 处"当前 N 行"全部 = ${measured}`);
  });

  runner.test('R0-016/4 每一处行数说法都必须等于实测值（不是“第一处”）', async () => {
    // 修前只 `match()` 第一处：README 里“微内核 4180 行”是对的，而同一份 README 的
    // “这个包给你什么”一节还写着 2880、设计原则写着“≤ 2080 行”，英文版还写着 2610 与 2,527。
    // 四处全是旧值，全在“页面首屏”，却一条判据也看不见它们 —— 因为只查了一个位置。
    // 现在逐处核对：凡是提行数的地方，一个都不许错。
    const claims = [
      ['docs/positioning-and-pi.md', /微内核\s*(\d+)\s*行/g, '微内核 N 行'],
      ['docs/architecture/microkernel.md', /微内核\s*(\d+)\s*行代码/g, '微内核 N 行代码'],
      ['docs/architecture/microkernel.md', /\|\s*\*\*合计\*\*\s*\|\s*\*\*(\d+)\*\*/g, '合计表格'],
      ['docs/architecture/microkernel.md', /预算上限\s*\*\*(\d+)\*\*/g, '预算上限'],
      ['package.json', /核心\s*≤\s*(\d+)\s*行/g, '核心 ≤ N 行'],
    ];
    let checked = 0;
    for (const [file, re, label] of claims) {
      const hits = [...read(file).matchAll(re)];
      assert(hits.length > 0, `${file} 里找不到「${label}」（改了措辞请同步本条判据）`);
      for (const h of hits) {
        assertEquals(Number(h[1]), measured, `${file} 的「${label}」写 ${h[1]}，实测 ${measured}：${h[0].slice(0, 60)}`);
        checked += 1;
      }
    }
    // microkernel.md 的“（N / N）”两个数都得对
    const pairs = [...read('docs/architecture/microkernel.md').matchAll(/（(\d+) \/ (\d+)）/g)];
    assert(pairs.length > 0, 'microkernel.md 里找不到「（N / N）」');
    for (const p of pairs) {
      assertEquals(Number(p[1]), measured, `microkernel.md 的「（N / N）」左值 ${p[1]}，实测 ${measured}`);
      assertEquals(Number(p[2]), measured, `microkernel.md 的「（N / N）」右值 ${p[2]}，实测 ${measured}`);
      checked += 2;
    }
    console.log(`       [实测] ${checked} 处行数说法全部 = ${measured}`);
  });

  runner.test('R0-016/5 ADR-11 七类归一：category 只能取七类或 null，result_kind 只有三种', async () => {
    const { categorizeCode, Core } = await import(join(ROOT, 'src/core/core.js'));
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'r016-doc-'));
    const core = new Core({ stateDir: dir });
    core.log = () => {};
    try {
      // ① 已登记码必须落在七类内；② 未登记码必须返回 null（不许猜成 internal）
      for (const code of ['invalid_input', 'capability_not_found', 'capability_denied', 'handler_threw', 'model_error']) {
        const c = categorizeCode(code);
        assert(SEVEN.has(c), `${code} 必须落在七类内，实际 ${c}`);
      }
      assertEquals(categorizeCode('PROBE-ERROR-NOT-REGISTERED'), null,
        '未登记码必须返回 null —— 猜成 internal 会把"我不知道"说成"我方有缺陷"');

      // ③ 真实信封：失败必须同时带 category 与 result_kind，且 denied 必须 side_effect:none
      core.registerCapability('r016.fail', { owner: 'r016', handler: () => { throw Object.assign(new Error('x'), { code: 'handler_threw' }); } });
      const f = await core.callCapability('r016.fail', {});
      assertEquals(f.category, 'internal', `handler_threw 应归 internal，实际 ${f.category}`);
      assertEquals(f.result_kind, 'failed', `handler 抛错是"知道失败"，实际 ${f.result_kind}`);

      core.registerCapability('r016.deny', { owner: 'r016', permissions: { require_identity: true }, handler: () => 'x' });
      const d = await core.callCapability('r016.deny', {}, { caller: 'self' });
      assertEquals(d.state, 'denied', '未受信身份必须 denied');
      assertEquals(d.result_kind, 'denied', 'denied ⇒ result_kind 必须是 denied');
      assertEquals(d.side_effect, 'none', 'ERR-015 之后：只有 Core 亲眼所见的前置拒绝才能承诺零副作用');
      assertEquals(d.category, 'security', `capability_denied 应归 security，实际 ${d.category}`);

      // ④ 等候超时是"不知道"，不是"知道失败"
      const slow = new Promise((r) => setTimeout(r, 30));
      core.registerCapability('r016.slow', { owner: 'r016', handler: () => slow.then(() => 'late') });
      const t = await core.command('r016.slow', {}, 5);
      assertEquals(t.code, 'timeout_no_abort', '软超时必须具名 timeout_no_abort');
      assertEquals(t.result_kind, 'indeterminate',
        `超时是"不知道执行到哪"，不是"知道失败"（实际 ${t.result_kind}）`);
      await slow;
    } finally { rmSync(dir, { recursive: true, force: true }); }
    console.log('       [实测] 七类归一已接线；未登记码返回 null；denied ⇒ side_effect:none；超时 ⇒ indeterminate');
  });

  // 场景指南的“内置场景”表必须每个场景都有一行（新增场景却忘了写文档时，这条会红）。
  runner.test('R0-016/6 场景指南的内置场景表必须覆盖 scenes/ 全部场景', async () => {
    const scenes = readdirSync(join(ROOT, 'scenes')).filter((f) => f.endsWith('.json5'));
    const guide = read('docs/guides/scene-system.md');
    const missing = scenes
      .map((f) => f.replace(/\.json5$/, ''))
      .filter((n) => !new RegExp('\\|\\s*`' + n + '`').test(guide));
    assertEquals(missing.length, 0, `docs/guides/scene-system.md 的“内置场景”表缺：${missing.join(', ')}`);
    console.log(`       [实测] 场景指南覆盖 ${scenes.length} 个场景`);
  });
}
