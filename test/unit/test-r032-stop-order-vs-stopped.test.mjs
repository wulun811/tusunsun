// R0-032（rc.15）：**停机顺序 ≠ 停在**。
//
// 这是 F06 建模时撞出来的实现反例，此前没有任何用例守着它（`test-r020` 只管「停机有界」，
// 从没问过「有界返回之后，提供方还该不该继续被停」）。模型见 `verification/model/Dependency.tla`，
// 对应突变体 `m15-release-under-stuck-dependent`。
//
// 缺陷形状：
//   `_stopLocked` 的 for 循环**逐条独立**调 `_stopOnePlugin`。后者在 `hold_timeout` 之后
//   只把这一次调用记成失败（`stop_return` / `unknown`），`plugin.state` 仍是 `running` ——
//   它可能还在用提供方的服务。循环不回头检查依赖方是否**真的**停了，于是继续去停提供方。
//   实测（修前）：`dependent` 超时后仍 running，`base.stop()` 照常被调用并变 stopped，
//   而 `core.stopped` 载荷里 `stopOrder:['dependent','base']` + `basis:'dependency'`
//   读起来像「按正确的顺序停好了」。**顺序对了，事实错了。**
//
// 判据必须同时成立四件事，缺一条就是「修了但没修对」：
//   ① 该拦的拦住了吗？  依赖方卡住 ⇒ 提供方**一次都不许被停**，且留在 running（/1）；
//   ② 诚实了吗？        跳过要能从载荷读出来（`stopSkipped` + `skipped_dependents_pending`），
//                       且不得混进 `stopFailures`（/1、/4 —— 一个是"没动"，一个是"停不动"）；
//   ③ 正例还在吗？      依赖方正常停 ⇒ 提供方照常停，`stopSkipped` 为空（/2）；
//   ④ 没被误伤吗？      环里的插件互等，谁也不停就没完；环必须报出来且不许把停机钉死（/3）。
//
// 反向判据 /3 是特意加的：修法里加了「环内边豁免」，如果豁免写宽了（把所有依赖都当环），
// /1 会绿而真实依赖顺序就失效了。/2 与 /3 一起把那个方向堵住。
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assert, assertEquals } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(join(ROOT, rel));

export async function setup(runner) {
  const { Core } = await imp('src/core/core.js');
  let tmp;

  runner.beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'r032-')); });
  runner.afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ } });

  // 一台干净 Core + 一批插件定义。`calls` 记真实被调用过 stop() 的插件名 ——
  // 判据要落在**真的有没有被调**上，不能只看状态字段（状态可能被别处改）。
  const boot = async (plugins, opts = {}) => {
    const calls = [];
    const mk = (p) => ({
      name: p.name, version: '1.0.0',
      async init() {}, async start() {},
      async stop() {
        calls.push(p.name);
        if (p.hang) await new Promise(() => {});   // 永不返回：模拟卡死的收尾
      },
      ...(p.provides ? { provides: p.provides } : {}),
      ...(p.requires ? { requires: p.requires } : {}),
    });
    const core = new Core({ stateDir: join(tmp, `state-${Math.random().toString(16).slice(2)}`) });
    core.log = () => {};
    core._stopAssemblyDrainMs = 20;
    core._stopLockMs = opts.stopLockMs ?? 120;   // 让超时快速发生，测试不等 30s
    for (const p of plugins) await core.register(mk(p));
    await core.start();
    let payload = null;
    core.on('core.stopped', (p) => { payload = p; });
    return { core, calls, stop: async () => { await core.stop(); return payload; } };
  };

  // ── /1 依赖方卡住 ⇒ 提供方一次都不许被停，且留在 running ──────────────────
  runner.test('R0-032/1 依赖方 stop() 超时仍 running 时，提供方不得被停（F06 模型 m15）', async () => {
    const { core, calls, stop } = await boot([
      { name: 'base', provides: ['base-svc'] },
      { name: 'dependent', requires: { 'base-svc': '*' }, hang: true },
    ]);
    const payload = await stop();

    // ① 依赖方的 stop 被调了（并且卡住），提供方的 stop **一次都没被调**。
    assertEquals(JSON.stringify(calls), JSON.stringify(['dependent']), `只有 dependent 的 stop 应被调用，实际：${JSON.stringify(calls)}`);
    // ② 状态是真的事实源：卡住的仍是 running，提供方也仍是 running（没被拆）。
    assertEquals(core.plugins.get('dependent')?.state, 'running', '卡住的依赖方不得被标成已停');
    assertEquals(core.plugins.get('base')?.state, 'running', '提供方不得在依赖方卡住时被停掉');
    // ③ 跳过要能被看见，且不能混进 stopFailures。
    assertEquals(JSON.stringify(payload?.stopOrder), JSON.stringify(['dependent', 'base']), '账面顺序仍是逆拓扑序');
    assert((payload?.stopFailures ?? []).length === 1
      && payload.stopFailures[0].plugin === 'dependent'
      && payload.stopFailures[0].phase === 'stop_return', '该失败的仍应如实失败');
    const skipped = payload?.stopSkipped ?? [];
    assert(skipped.length === 1
      && skipped[0].plugin === 'base'
      && skipped[0].code === 'skipped_dependents_pending'
      && skipped[0].dependents.includes('dependent'),
    `跳过必须具名交出去，实际：${JSON.stringify(skipped)}`);
    assert(!(payload.stopFailures ?? []).some((f) => f.plugin === 'base'),
      'base 是「根本没动」，不得混进「试着停但没停成」');
  });

  // ── /2 正例：依赖方正常停 ⇒ 提供方照常停，没有跳过 ────────────────────────
  runner.test('R0-032/2 依赖方正常停止时，提供方照常停，stopSkipped 为空', async () => {
    const { core, calls, stop } = await boot([
      { name: 'base', provides: ['base-svc'] },
      { name: 'dependent', requires: { 'base-svc': '*' } },
    ]);
    const payload = await stop();
    assertEquals(JSON.stringify(calls), JSON.stringify(['dependent', 'base']), '正常情况必须两个都停，且依赖方在前');
    assertEquals(core.plugins.get('base')?.state, 'stopped');
    assertEquals(JSON.stringify(payload?.stopSkipped ?? []), '[]', '没有跳过时该字段必须为空');
    assertEquals((payload?.stopFailures ?? []).length, 0);
  });

  // ── /3 环：必须报出来，且不许把停机钉死（防「豁免写宽」与「豁免没写」）──────
  runner.test('R0-032/3 环内互等不得让停机挂住，且环必须被具名报出', async () => {
    const { core, calls, stop } = await boot([
      { name: 'a', provides: ['a-svc'], requires: { 'b-svc': '*' } },
      { name: 'b', provides: ['b-svc'], requires: { 'a-svc': '*' } },
    ]);
    const payload = await stop();
    const cycles = payload?.stopOrderCycles ?? [];
    assert(cycles.length > 0, `环必须被具名报出，实际：${JSON.stringify(cycles)}`);
    // 环内谁也没挡住谁：两个都得停（否则就是「永远停不完」）。
    assertEquals(JSON.stringify(calls.slice().sort()), JSON.stringify(['a', 'b']), '环内两个插件都必须被停下来');
    assertEquals(JSON.stringify(payload?.stopSkipped ?? []), '[]', '环内边被豁免，不得被记成跳过');
  });

  // ── /4 跳过不是失败：stopSkipped 与 stopFailures 是两件事 ──────────────────
  runner.test('R0-032/4 stopSkipped 与 stopFailures 分属两个字段，语义不同', async () => {
    const { stop } = await boot([
      { name: 'base', provides: ['base-svc'] },
      { name: 'dependent', requires: { 'base-svc': '*' }, hang: true },
    ]);
    const payload = await stop();
    // 失败的是 dependent（试过、没停成）；跳过的是 base（根本没动）。
    assertEquals(JSON.stringify((payload.stopFailures ?? []).map((f) => f.plugin)), JSON.stringify(['dependent']), '失败的只有 dependent');
    assertEquals(JSON.stringify((payload.stopSkipped ?? []).map((s) => s.plugin)), JSON.stringify(['base']), '跳过的只有 base');
    // 两个字段的成员不得重叠：同一插件不可能既"没动"又"试过没停成"。
    const f = new Set((payload.stopFailures ?? []).map((x) => x.plugin));
    for (const s of payload.stopSkipped ?? []) assert(!f.has(s.plugin), `${s.plugin} 同时出现在两个字段里`);
  });
}
