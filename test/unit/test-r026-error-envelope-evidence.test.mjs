// R0-026（rc.15）：错误信封必须自带「跑过没有」（专家 rc.14 复审 M6）。
//
// M6 的要求是一句话：`handler_threw` 的信封必须有 `dispatched:true` 与
// `side_effect:'unknown_or_possible'`；Core 自己的**预派发**拒绝必须是 `false` / `none`。
//
// 修前只成立一半：证据字段挂在「拒绝码被降级」那个分支上。于是 `out_of_bounds`
// 这类"handler 抛了拒绝码"有证据，而**最常见的 `handler_threw` 一条都没有**。
// 要命的是「没有这个字段」与「字段是 false」在 JSON 里长得一模一样，说的却是相反的事：
// 前者是"我不知道"，后者是"我确定没跑"。下游任何 `if (!env.dispatched) deny()` 都会读错。
//
// 本文件钉住：
//   /1  handler 抛普通错误 ⇒ handler_threw + dispatched:true + unknown_or_possible
//   /2  回归位：handler 抛拒绝码 ⇒ 证据仍在，且 state 仍被降级为 failed（不是 denied）
//   /3  预派发拒绝（能力不存在 / 已冻结）⇒ dispatched:false + side_effect:'none'
//   /4  反向判据：成功信封**不得**声明执行阶段（没发生过的事情不该有结论）
//
// 判据都对着**返回体**判，因为 M6 要的正是"返回体自己说得清"。
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assert, assertEquals } from '../harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (rel) => import(join(ROOT, rel));

export async function setup(runner) {
  const { Core } = await imp('src/core/core.js');

  function makeCore() {
    const d = mkdtempSync(join(tmpdir(), 'r026-'));
    const core = new Core({ stateDir: d });
    core.log = () => {};
    return { core, d, done: () => rmSync(d, { recursive: true, force: true }) };
  }

  // ══ M6 主干：handler 抛错必须自带执行阶段证据 ═══════════════════════
  runner.test('R0-026/1 handler 抛普通错误 ⇒ handler_threw 必须带 dispatched:true 与副作用不确定', async () => {
    const h = makeCore();
    try {
      h.core.registerCapability('x.boom', { owner: 'x', handler: async () => { throw new Error('boom'); } });
      const r = await h.core.callCapability('x.boom', {});
      assertEquals(r.ok, false, '前提：抛错必须是非成功');
      assertEquals(r.code, 'handler_threw', `未带 code 的抛出必须归为 handler_threw，实际 ${r.code}`);
      // 修前这两个字段**都不存在**：`undefined` 与 `false` 在 JSON 里长得一样，语义相反。
      assertEquals(r.dispatched, true, `handler 确实跑过（它抛了），实际 dispatched=${r.dispatched}`);
      assertEquals(r.side_effect, 'unknown_or_possible',
        `handler 抛错时不得宣称零副作用，实际 ${r.side_effect}`);
      assertEquals(r.execution_stage, 'post_dispatch', `必须标明是派发之后，实际 ${r.execution_stage}`);
      console.log(`       [实测] ${r.code} dispatched=${r.dispatched} side_effect=${r.side_effect} stage=${r.execution_stage}`);
    } finally { h.done(); }
  });

  // ══ 回归位：拒绝码从 handler 冒出来，证据与 state 各自说自己的话 ═══
  runner.test('R0-026/2 回归位：handler 抛拒绝码仍带证据，且 state 仍降级为 failed', async () => {
    const h = makeCore();
    try {
      h.core.registerCapability('x.deny', {
        owner: 'x',
        handler: async () => { throw Object.assign(new Error('nope'), { code: 'capability_denied' }); },
      });
      const r = await h.core.callCapability('x.deny', {});
      assertEquals(r.code, 'capability_denied', `码必须原样透传，实际 ${r.code}`);
      assertEquals(r.state, 'failed',
        'handler 抛出的拒绝码不得报 denied —— Core 能证明"跑过并抛了"，不能证明"没碰资源"（ERR-015）');
      assertEquals(r.dispatched, true, '同上：dispatched 必须为 true');
      assertEquals(r.side_effect, 'unknown_or_possible', '不得宣称零副作用');
      console.log(`       [实测] code=${r.code} state=${r.state} dispatched=${r.dispatched}`);
    } finally { h.done(); }
  });

  // ══ 预派发拒绝：Core 亲眼所见，才能承诺 false / none ═══════════════
  runner.test('R0-026/3 预派发拒绝（能力不存在 / 已冻结）⇒ dispatched:false 且 side_effect:none', async () => {
    const h = makeCore();
    try {
      const missing = await h.core.callCapability('x.not.registered', {});
      assertEquals(missing.ok, false, '前提：能力不存在必须是非成功');
      assertEquals(missing.code, 'capability_not_found', `实际 ${missing.code}`);
      assertEquals(missing.dispatched, false,
        `Core 自己拒绝的调用从未派发，实际 ${missing.dispatched}（缺失也算错：缺字段读起来像"不知道"）`);
      assertEquals(missing.side_effect, 'none', `预派发拒绝可以承诺零副作用，实际 ${missing.side_effect}`);

      h.core.registerCapability('x.frozen', { owner: 'x', handler: async () => 'should not run' });
      h.core.freezeCapability('x.frozen');
      const frozen = await h.core.callCapability('x.frozen', {});
      assertEquals(frozen.ok, false, '前提：冻结后必须是非成功');
      assertEquals(frozen.code, 'capability_frozen', `实际 ${frozen.code}`);
      assertEquals(frozen.dispatched, false, '冻结是 Core 在派发前判的');
      assertEquals(frozen.side_effect, 'none', '冻结同样可以承诺零副作用');
      console.log(`       [实测] ${missing.code}/${missing.dispatched}/${missing.side_effect}；${frozen.code}/${frozen.dispatched}/${frozen.side_effect}`);
    } finally { h.done(); }
  });

  // ══ 反向判据：成功不该声称执行阶段证据 ═════════════════════════════
  runner.test('R0-026/4 反向判据：成功信封不得声明执行阶段（没发生的结论不许编）', async () => {
    const h = makeCore();
    try {
      h.core.registerCapability('x.ok', { owner: 'x', handler: async () => 'fine' });
      const r = await h.core.callCapability('x.ok', {});
      assertEquals(r.ok, true, '前提：应成功');
      assertEquals(r.payload, 'fine', '载荷必须原样');
      assertEquals(r.dispatched, undefined,
        `成功信封不得带 dispatched —— 它回答的是"失败时跑没跑"，成功时写任何一个值都是在替另一个问题作答；实际 ${r.dispatched}`);
      assertEquals(r.side_effect, undefined, `成功信封同样不得带 side_effect，实际 ${r.side_effect}`);
      console.log('       [实测] 成功信封无 dispatched / side_effect');
    } finally { h.done(); }
  });
}
