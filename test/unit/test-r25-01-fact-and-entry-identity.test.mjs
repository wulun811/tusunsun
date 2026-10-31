/**
 * R2.5-01（v0.15.5）：**事实通知、注册身份与错误出口**的回归锁。
 *
 * 对应专家《v0.15.4 综合独立复审》§3 的六条新反例与 §6 的 R2.5 工单：
 *   R25-01 `core:plugin.loaded` 等已提交事实仍走 `emit`（H154-06）
 *   R25-02 异步观察者的拒绝逸出成 unhandledRejection，诊断数为 0（H154-04）
 *   R25-03 浅冻结让第一个观察者改写事实，后续观察者与事实源都看见（H154-05）
 *   R25-04 订阅按函数名撤销，删掉的是**另一条**同函数注册（H154-01）
 *   R25-05 `unuse`/disposer 用 lastIndexOf，与 owner 账本各删各的（H154-02/03）
 *   R25-06 执行器拒绝信封没有 `category` / `result_kind`，且“未执行”曾由错误码决定
 * 外加 §5 EE-01：派生索引（`_subsByOwner` / `_pipelineOwners`）可重建，语义不变。
 *
 * 纪律（延续 R1-01 / R2-01）：
 *   ① 每条缺陷配**合法正例**，防“一律吞错 / 一律禁止匿名注册”式假修复；
 *   ② 判据必须能看见它的目标：能数出“哪一条注册被删”就不数函数调用次数；
 *   ③ 断言失败必须说清“哪一件事被谁看见了”；
 *   ④ 只断言**合同**；读私有结构的地方都紧挨着一条行为断言（结构只是佐证）。
 */
import { TestRunner, assert, assertEquals } from '../harness.mjs';
// harness 的 assertEquals 是严格 `!==`（数组永远不等）—— 比数组必须用 deepEqual。
import strict from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { Core } from '../../src/core/core.js';
import { ToolExecutor } from '../../plugins/tool-executor.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const src = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/** 已提交事实的**明确清单**（专家 §3.1 要求：清单化，逐个检查出口）。 */
const FACT_EVENTS = [
  'core.ready', 'core.stopped',
  'core:plugin.loaded', 'core:plugin.unloaded', 'core:plugin.drain_timeout',
  // K24-02：回收（索引已重建、可再次懒加载）与卸载（已从 Core 注册表移出）是**两个**事实，
  // 各有一个发布点；回收事实同样发生在提交之后。
  'core:plugin.recycled',
  // 冲突通知**两个分支都走隔离面**：允许分支发生在提交之后（已提交事实）；拒绝分支的
  // 结论由随后的 throw 给出，观察者的异常不该把 `host_authority_required` 换成别的错。
  'core:service.conflict',
  // 拒绝事实也走隔离面：记录方不得被观察者的异常改写结论（无 handler 派发，零副作用）。
  'core:capability.denied',
  'scene.switched', 'scene.switch_partial',
];
/** 提交**之前**的协调通知：允许 fail-loud 中止（不在隔离面内）。 */
const PRE_COMMIT_EVENTS = ['core:plugin.unloading'];

export async function setup(runner) {
  let tmpDirs = [];
  const tmp = () => {
    const dir = mkdtempSync(join(tmpdir(), 'tusunsun-r25-'));
    tmpDirs.push(dir);
    return dir;
  };
  const makeCore = () => {
    const core = new Core({ stateDir: tmp() });
    core.log = () => {};
    core._stopAssemblyDrainMs = 20;
    return core;
  };
  const plainPlugin = (name, extra = {}) => ({
    name, version: '1.0.0',
    async init() {}, async start() {}, async stop() {},
    ...extra,
  });
  const withUnhandledGuard = async (fn) => {
    const seen = [];
    const onUnhandled = (e) => seen.push(e?.message || String(e));
    process.on('unhandledRejection', onUnhandled);
    try { return { result: await fn(), unhandled: seen }; }
    finally { process.off('unhandledRejection', onUnhandled); }
  };

  // ═══════════════════════════════════════════════════════════════
  // R25-01 —— 已提交事实：旁观者不得倒写结果
  // ═══════════════════════════════════════════════════════════════
  runner.test('R25-01/1 core:plugin.loaded 观察者抛错：装载仍成功且错误进诊断（H154-06）', async () => {
    const core = makeCore();
    const p = plainPlugin('obs-load');
    core.on('core:plugin.loaded', () => { throw new Error('observer-boom'); });
    const r = await core.lifecycle.load(p, core);
    const errors = core.getObserverErrors();
    assertEquals(r.ok, true, '已提交的装载不得因旁观者抛错而变成失败');
    assertEquals(p.state, 'running', '插件真实状态是 running（修前实例也是 running，但调用方收到 reject）');
    assertEquals(core.plugins.get('obs-load'), p, '插件仍在 Core 里');
    assertEquals(errors.length, 1, '观察者异常必须进有界诊断，而不是消失');
    assertEquals(errors[0].message, 'observer-boom');
    assertEquals(errors[0].phase, 'sync', '同步异常要标 sync，与异步拒绝区分');
  });

  runner.test('R25-01/2 【反例锁】真实装配失败仍必须报失败（隔离不得吃掉失败）', async () => {
    const core = makeCore();
    const bad = plainPlugin('bad-init', { async init() { throw new Error('init-boom'); } });
    await strict.rejects(() => core.lifecycle.load(bad, core),
      (err) => err.message === 'init-boom', 'init 抛错必须原样 reject，不得被通知隔离吞掉');
    assert(bad.state !== 'running', '未被 Core 承认的对象不得报告 running');
    assertEquals(core.plugins.has('bad-init'), false, '失败后不得留在 Core 里');
  });

  runner.test('R25-01/3 异步观察者拒绝：装载仍成功，不产生 unhandledRejection（H154-04）', async () => {
    const core = makeCore();
    const p = plainPlugin('async-obs');
    core.on('core:plugin.loaded', async () => { throw new Error('async-boom'); });
    const { result, unhandled } = await withUnhandledGuard(async () => {
      const r = await core.lifecycle.load(p, core);
      await settle(50);
      return r;
    });
    const errors = core.getObserverErrors();
    assertEquals(unhandled.length, 0, `不得逸出为进程级 unhandledRejection：${unhandled.join(',')}`);
    assertEquals(result.ok, true, '异步旁观者不得拖住也不能改写已提交的装载');
    assertEquals(errors.length, 1, '异步拒绝必须记进同一诊断面');
    assertEquals(errors[0].phase, 'async');
  });

  runner.test('R25-01/4 【反例锁】core:plugin.unloading 仍是提交前通知：允许 fail-loud 中止', async () => {
    const core = makeCore();
    const p = plainPlugin('pre-commit');
    await core.lifecycle.load(p, core);
    let stopCalls = 0;
    p.stop = async () => { stopCalls += 1; };
    core.on('core:plugin.unloading', () => { throw new Error('veto'); });
    await strict.rejects(() => core.lifecycle.unload('pre-commit'),
      (err) => err.message === 'veto', '提交前的协调通知必须仍然抛回调用方（不是所有 emit 都吞错）');
    assertEquals(stopCalls, 0, '中止发生在任何拆卸动作之前 —— 这就是“提交前”的可判定含义');
    assertEquals(core.plugins.get('pre-commit'), p, '中止后插件仍完整在册');
  });

  runner.test('R25-01/5 scene.switch_partial 观察者抛错不得改变 scene_partial 结论', async () => {
    const core = makeCore();
    core.on('scene.switch_partial', () => { throw new Error('scene-obs-boom'); });
    const r = core.emitFact('scene.switch_partial', { to: 'x', applied: [], missing: ['rep'], sourcePlugin: 'test' });
    assertEquals(r.delivered, 0, '同步抛错的那个不算 delivered（它没跑完），但不得截断派发');
    assertEquals(r.errors.length, 1, '异常要落在返回值与诊断面上');
    assertEquals(core.getObserverErrors().length, 1);
  });

  runner.test('R25-01/6 事实事件清单：已提交事实不得再走 emit（清单化检查）', async () => {
    const files = readdirSync(join(ROOT, 'src/core')).filter((f) => f.endsWith('.js'));
    const offenders = [];
    for (const f of files) {
      const text = src(`src/core/${f}`);
      for (const ev of FACT_EVENTS) {
        // 只看真的发射点：`emit('<ev>'` 而不是 `emitFact('<ev>'`
        const re = new RegExp(`(^|[^A-Za-z])\\.?emit\\(\\s*'${ev.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`);
        if (re.test(text)) offenders.push(`${f}: emit('${ev}')`);
      }
    }
    strict.deepEqual(offenders, [], `这些已提交事实仍在用会倒写结果的出口：${offenders.join(' / ')}`);
  });

  runner.test('R25-01/7 清单反向锁：emitFact 的每个调用点都必须是登记在案的事实事件', async () => {
    const files = readdirSync(join(ROOT, 'src/core')).filter((f) => f.endsWith('.js'));
    const unknown = [];
    for (const f of files) {
      for (const m of src(`src/core/${f}`).matchAll(/emitFact\(\s*'([^']+)'/g)) {
        if (!FACT_EVENTS.includes(m[1])) unknown.push(`${f}: ${m[1]}`);
      }
    }
    strict.deepEqual(unknown, [],
      `emitFact 只能给“已提交事实”用；新增事件名必须先登记进清单：${unknown.join(' / ')}`);
    const preCommit = readdirSync(join(ROOT, 'src/core')).filter((f) => f.endsWith('.js'))
      .filter((f) => PRE_COMMIT_EVENTS.some((ev) => src(`src/core/${f}`).includes(`emitFact('${ev}'`)));
    strict.deepEqual(preCommit, [], '提交前通知不得被塞进隔离面（那会让“中止”变成“悄悄继续”）');
  });

  // ═══════════════════════════════════════════════════════════════
  // R25-02 —— 异步观察者：不阻塞、不逸出、可诊断
  // ═══════════════════════════════════════════════════════════════
  runner.test('R25-02/1 异步观察者 resolve：不得记错误，delivered 照数', async () => {
    const core = makeCore();
    let ran = 0;
    core.on('fact.ok', async () => { ran += 1; });
    const r = core.emitFact('fact.ok', { sourcePlugin: 'test' });
    await settle(20);
    assertEquals(ran, 1, '异步观察者必须被真的调用');
    assertEquals(r.delivered, 1);
    assertEquals(core.getObserverErrors().length, 0, '正常 resolve 不得进诊断面');
    assertEquals(core._observerPendingAsync, 0, '结算之后待决计数必须归零');
  });

  runner.test('R25-02/2 永久悬挂的观察者不得阻塞已提交操作', async () => {
    const core = makeCore();
    core.on('fact.hang', () => new Promise(() => {}));
    const t0 = Date.now();
    const r = core.emitFact('fact.hang', { sourcePlugin: 'test' });
    const took = Date.now() - t0;
    assert(took < 100, `emitFact 不得 await 观察者（实测 ${took}ms）`);
    assertEquals(r.delivered, 1);
    assertEquals(r.asyncPending, 1, '悬挂的观察者要能被看见，而不是静默消失');
  });

  runner.test('R25-02/3 同步抛错与异步拒绝同时存在：两条都记，其他观察者照常收到', async () => {
    const core = makeCore();
    const order = [];
    core.on('fact.mixed', () => { order.push('sync-throw'); throw new Error('sync-boom'); });
    core.on('fact.mixed', async () => { order.push('async-reject'); throw new Error('async-boom'); });
    core.on('fact.mixed', () => { order.push('voter'); });
    const r = core.emitFact('fact.mixed', { sourcePlugin: 'test' });
    await settle(30);
    const errors = core.getObserverErrors();
    assertEquals(order.join(','), 'sync-throw,async-reject,voter', '一个观察者抛错不得截断派发');
    assertEquals(r.delivered, 2, '同步抛的那个不算 delivered，另两个算');
    assertEquals(errors.map((e) => e.phase).sort().join(','), 'async,sync');
  });

  runner.test('R25-02/4 诊断面必须有界：持续抛错不得变成内存增长', async () => {
    const core = makeCore();
    core.on('fact.noisy', () => { throw new Error('noise'); });
    for (let i = 0; i < 260; i++) core.emitFact('fact.noisy', { sourcePlugin: 'test' });
    assertEquals(core.getObserverErrors().length, 200, '上限 200，超出丢最旧的');
  });

  // ═══════════════════════════════════════════════════════════════
  // R25-03 —— 事实载荷：观察者改不动
  // ═══════════════════════════════════════════════════════════════
  runner.test('R25-03/1 嵌套对象与数组：观察者 A 改不动 B 看到的、也改不动事实源（H154-05）', async () => {
    const core = makeCore();
    const source = { requiredFailed: ['a'], nested: { deep: 1 }, sourcePlugin: 'test' };
    const seen = [];
    core.on('fact.snap', (p) => {
      try { p.nested.deep = 999; } catch { /* frozen */ }
      try { p.requiredFailed.push('b'); } catch { /* frozen */ }
    }, { owner: 'A' });
    core.on('fact.snap', (p) => seen.push({ deep: p.nested.deep, len: p.requiredFailed.length }), { owner: 'B' });
    core.emitFact('fact.snap', source);
    strict.deepEqual(seen, [{ deep: 1, len: 1 }], 'B 必须看到未被改写的原件');
    assertEquals(source.nested.deep, 1, '事实源不得被观察者反向修改');
    assertEquals(source.requiredFailed.length, 1, '事实源的数组长度不得被改');
  });

  runner.test('R25-03/2 快照是深冻结的，但语义与原件一致（不能改值 ≠ 改内容）', async () => {
    const core = makeCore();
    const source = { a: 1, list: [1, { b: 2 }], flag: false, s: 'x', nul: null, sourcePlugin: 'test' };
    let got;
    core.on('fact.deep', (p) => { got = p; });
    core.emitFact('fact.deep', source);
    assertEquals(got.a, 1);
    assertEquals(got.s, 'x');
    assertEquals(got.flag, false);
    assertEquals(got.nul, null);
    assertEquals(got.list.length, 2);
    assertEquals(got.list[1].b, 2);
    assert(Object.isFrozen(got), '顶层必须冻结');
    assert(Object.isFrozen(got.list), '数组必须冻结（浅冻结只保护顶层，正是 H154-05 的根因）');
    assert(Object.isFrozen(got.list[1]), '嵌套对象必须冻结');
    assertEquals(got.sourcePlugin, 'test', 'sourcePlugin 等原有字段必须原样保留');
  });

  runner.test('R25-03/3 【边界】非纯数据载荷退回浅冻结，并且**记账**而不是假装已保护', async () => {
    const core = makeCore();
    class Handle { constructor() { this.v = 1; } }
    const handle = new Handle();
    let got;
    core.on('fact.impure', (p) => { got = p; });
    core.emitFact('fact.impure', { handle, sourcePlugin: 'test' });
    assertEquals(got.handle, handle, '服务对象/句柄不得被深拷（那会改变语义）');
    assert(Object.isFrozen(got), '顶层仍然浅冻结');
    const degraded = core.getFactDegraded();
    assertEquals(degraded.length, 1, '降级必须被记账');
    assertEquals(degraded[0].event, 'fact.impure');
    assertEquals(degraded[0].count, 1);
  });

  runner.test('R25-03/4 环图不得让 emitFact 卡死或崩：降级 + 记账', async () => {
    const core = makeCore();
    const cyclic = { sourcePlugin: 'test' };
    cyclic.self = cyclic;
    const r = core.emitFact('fact.cyclic', cyclic);
    assertEquals(r.delivered, 0, '没有观察者时 delivered 为 0');
    assertEquals(core.getFactDegraded()[0]?.event, 'fact.cyclic');
  });

  // ═══════════════════════════════════════════════════════════════
  // R25-04 —— 订阅：按不要按函数名
  // ═══════════════════════════════════════════════════════════════
  runner.test('R25-04/1 同回调双 owner + 中间插一条：释放 A 后次序必须是 [C, fn]（H154-01）', async () => {
    const core = makeCore();
    const order = [];
    const fn = () => order.push('fn');
    const mid = () => order.push('mid');
    core.on('evt.order', fn, { owner: 'A' });
    core.on('evt.order', mid, { owner: 'C' });
    core.on('evt.order', fn, { owner: 'B' });
    const removed = core.offByOwner('A');
    core.emitFast('evt.order', {});
    assertEquals(order.join(','), 'mid,fn', '被删掉的必须是 A 那一次注册，不是最后一条同名函数');
    assertEquals(removed, 1);
    assertEquals(core.listenerCount('evt.order'), 2);
  });

  runner.test('R25-04/2 【兼容】off(event, fn) 仍按 Node 语义删最后一条，且账本同删', async () => {
    const core = makeCore();
    const order = [];
    const fn = () => order.push('fn');
    const mid = () => order.push('mid');
    core.on('evt.compat', fn, { owner: 'A' });
    core.on('evt.compat', mid, { owner: 'C' });
    core.on('evt.compat', fn, { owner: 'B' });
    const before = core._subs.size;
    core.off('evt.compat', fn);
    assertEquals(core._subs.size, before - 1, '账本必须跟着少一条（不能只删监听不删账）');
    core.emitFast('evt.compat', {});
    assertEquals(order.join(','), 'fn,mid', 'Node 语义：删的是最后一条同名注册');
  });

  runner.test('R25-04/3 offByOwner 的返回数必须与 listenerCount 的减少量一致', async () => {
    const core = makeCore();
    const f1 = () => {};
    const f2 = () => {};
    core.on('a.1', f1, { owner: 'G' });
    core.on('a.2', f1, { owner: 'G' });
    core.on('a.3', f2, { owner: 'G' });
    core.on('a.4', f2, { owner: 'H' });
    const before = ['a.1', 'a.2', 'a.3', 'a.4'].reduce((n, e) => n + core.listenerCount(e), 0);
    const removed = core.offByOwner('G');
    const after = ['a.1', 'a.2', 'a.3', 'a.4'].reduce((n, e) => n + core.listenerCount(e), 0);
    assertEquals(removed, 3);
    assertEquals(before - after, removed, '返回的清理数必须能被 listenerCount 核对上');
    assertEquals(core.listenerCount('a.4'), 1, '别的 owner 一条都不能动');
  });

  runner.test('R25-04/4 带 owner 的 once：只触发一次，触发后账本与监听同时清空', async () => {
    const core = makeCore();
    let calls = 0;
    core.once('evt.once', () => { calls += 1; }, { owner: 'O' });
    assertEquals(core.listenerCount('evt.once'), 1);
    core.emitFast('evt.once', {});
    core.emitFast('evt.once', {});
    assertEquals(calls, 1, 'once 只能触发一次');
    assertEquals(core.listenerCount('evt.once'), 0, '触发后监听必须真的摘掉（只删账不删监听会更糟）');
    assertEquals(core.offByOwner('O'), 0, '已自行摘除的记录不得再被计一次');
  });

  runner.test('R25-04/5 listeners() 仍返回原函数（EventEmitter 兼容面）', async () => {
    const core = makeCore();
    const fn = () => {};
    core.on('evt.ls', fn, { owner: 'A' });
    assertEquals(core.listeners('evt.ls')[0], fn, 'listeners() 必须还原原函数（wrapper 只能出现在 rawListeners）');
    assertEquals(core.rawListeners('evt.ls').length, 1);
  });

  runner.test('R25-04/6 removeAllListeners(event) 只清该事件，别的与账本都不许串', async () => {
    const core = makeCore();
    const fn = () => {};
    core.on('evt.x', fn, { owner: 'A' });
    core.on('evt.y', fn, { owner: 'B' });
    core.removeAllListeners('evt.x');
    assertEquals(core.listenerCount('evt.x'), 0);
    assertEquals(core.listenerCount('evt.y'), 1);
    assertEquals(core._subs.size, 1, '账本里应只剩 evt.y 那条');
    assertEquals(core.offByOwner('B'), 1);
  });

  // ═══════════════════════════════════════════════════════════════
  // R25-05 —— 中间件：按注册 token 撤销
  // ═══════════════════════════════════════════════════════════════
  runner.test('R25-05/1 管道同回调双 owner + 中间插一条：按 A 删除后次序是 [C, fn]（H154-02）', async () => {
    const core = makeCore();
    const order = [];
    const fn = (m) => { order.push('fn'); return m; };
    const mid = (m) => { order.push('mid'); return m; };
    core.use('inbound', fn, { owner: 'A' });
    core.use('inbound', mid, { owner: 'C' });
    core.use('inbound', fn, { owner: 'B' });
    const n = core.offPipelineByOwner('A');
    await core.runPipeline('inbound', { v: 1 });
    assertEquals(order.join(','), 'mid,fn');
    assertEquals(n, 1);
    assertEquals(core._pipelines.inbound.length, 2, '管道里也必须真的少一条');
  });

  runner.test('R25-05/2 disposer 只撤销它那一次注册（H154-03）', async () => {
    const core = makeCore();
    const order = [];
    const fn = (m) => { order.push('fn'); return m; };
    const mid = (m) => { order.push('mid'); return m; };
    const disposeA = core.use('inbound', fn, { owner: 'A' });
    core.use('inbound', mid, { owner: 'C' });
    core.use('inbound', fn, { owner: 'B' });
    disposeA();
    await core.runPipeline('inbound', { v: 1 });
    assertEquals(order.join(','), 'mid,fn', '被撤的必须是 A 那次，不是最后一条同名函数');
    assertEquals(core._pipelineOwners.get('A'), undefined, 'A 的账必须清空');
    assertEquals(core._pipelineOwners.get('B').length, 1, 'B 的账必须还在');
  });

  runner.test('R25-05/3 disposer 幂等：重复调用不得删掉别人的同名注册', async () => {
    const core = makeCore();
    const fn = (m) => m;
    const d1 = core.use('inbound', fn, { owner: 'A' });
    core.use('inbound', fn, { owner: 'B' });
    d1();
    d1();
    assertEquals(core._pipelines.inbound.length, 1, '第二次调用必须无事发生');
    assertEquals(core._pipelineOwners.get('B').length, 1);
  });

  runner.test('R25-05/4 【兼容】匿名中间件仍执行，且不被任何 offByOwner 误删', async () => {
    const core = makeCore();
    let calls = 0;
    core.use('inbound', (m) => { calls += 1; return m; });
    core.offByOwner('someone-else');
    await core.runPipeline('inbound', { v: 1 });
    assertEquals(calls, 1, '旧式 use(stage, fn) 的语义不变');
  });

  runner.test('R25-05/5 unuse 删最后一条同名注册，且管道与账本同删', async () => {
    const core = makeCore();
    const fn = (m) => m;
    core.use('inbound', fn, { owner: 'A' });
    core.use('inbound', fn, { owner: 'B' });
    assertEquals(core.unuse('inbound', fn), true);
    assertEquals(core._pipelines.inbound.length, 1);
    assertEquals(core._pipelineOwners.get('B'), undefined, '删掉的是最后一次注册（B），账本必须一致');
    assertEquals(core._pipelineOwners.get('A').length, 1);
  });

  // ═══════════════════════════════════════════════════════════════
  // ER-01 / EE-01 —— 派生索引可重建
  // ═══════════════════════════════════════════════════════════════
  runner.test('R25-07/1 丢掉 owner 索引再重建：语义一模一样', async () => {
    const core = makeCore();
    const fn = () => {};
    let ran = 0;
    const mid = (m) => { ran += 1; return m; };
    core.on('r.e1', fn, { owner: 'A' });
    core.on('r.e1', fn, { owner: 'B' });
    core.on('r.e2', fn, { owner: 'A' });
    core.once('r.e3', fn, { owner: 'C' });
    core.use('inbound', mid, { owner: 'A' });
    core.use('inbound', mid, { owner: 'D' });
    core.use('inbound', mid);                       // 匿名：不属于任何 owner
    const before = core._rebuildOwnerIndex();
    assertEquals(before.subs, 4);
    assertEquals(before.middleware, 2);
    assertEquals(core.offByOwner('A'), 2, '重建后的索引必须仍能精确释放 A 的两条');
    assertEquals(core.offPipelineByOwner('D'), 1);
    assertEquals(core._pipelines.inbound.length, 2, '匿名那条与 A 那条都不受 D 的释放影响');
    await core.runPipeline('inbound', { v: 1 });
    assertEquals(ran, 2, '重建后管道仍按原样执行（A 一条 + 匿名一条）');
  });

  runner.test('R25-07/2 重建不得把已触发过的 once 记录复活', async () => {
    const core = makeCore();
    const fn = () => {};
    core.once('r.once', fn, { owner: 'O' });
    core.emitFast('r.once', {});
    assertEquals(core._subs.size, 0);
    const r = core._rebuildOwnerIndex();
    assertEquals(r.subs, 0, '重建只能从权威 entry 集合来，已消失的不得被索引“记得”');
    assertEquals(core.offByOwner('O'), 0);
  });

  // ═══════════════════════════════════════════════════════════════
  // R25-06 —— 执行器对外信封：category / result_kind 三臂可区分
  // ═══════════════════════════════════════════════════════════════
  const makeExec = () => {
    const ex = new ToolExecutor();
    ex.core = { emitFast() {}, emit() {}, log() {}, colorize: (c, t) => t };
    return ex;
  };

  runner.test('R25-06/1 _blockedResponse：dispatched:false 是证据，result_kind 才是 denied', async () => {
    const ex = makeExec();
    const r = ex._blockedResponse('tc-1', 'tool-write', 'PERMISSION_DENIED', 'no', 'hint', 'sess');
    assertEquals(r.status, 'blocked', '旧字段原样保留');
    assertEquals(r.dispatched, false, '执行器亲眼所见：还没派发');
    assertEquals(r.side_effect, 'none');
    assertEquals(r.result_kind, 'denied');
    assertEquals(r.category, null, 'PERMISSION_DENIED 未登记在七类表 ⇒ null，不猜');
  });

  runner.test('R25-06/2 「未执行」不得由错误码决定：自产失败一律不是 denied', async () => {
    const ex = makeExec();
    // EXECUTOR_REJECTION_CODES 里的码会让 state 变成 rejected —— 但这不构成“没执行”的证据
    const r = ex._failureResult('blocked by hook', 'HOOK_BLOCKED');
    assertEquals(r.state, 'rejected', '旧语义不变（ERR-015 的既有分层）');
    assertEquals(r.result_kind, 'failed', '没有派发证明 ⇒ 不得报 denied');
    assertEquals(r.code, 'HOOK_BLOCKED', 'code 一个字节都没改');
    assertEquals(r.ok, false);
  });

  runner.test('R25-06/3 _failureResult：category 来自唯一七类表，timeout 是 indeterminate', async () => {
    const ex = makeExec();
    assertEquals(ex._failureResult('x', 'rate_limited').category, 'resource');
    assertEquals(ex._failureResult('x', 'sandbox_path_denied').category, 'security');
    assertEquals(ex._failureResult('x', 'not_registered_anywhere').category, null, '未登记 ⇒ null，不猜成 internal');
    const t = ex._failureResult('timed out', 'timeout');
    assertEquals(t.result_kind, 'indeterminate', '“不等了”不等于“已经停了”');
    assertEquals(t.state, 'failed', 'state 语义不动');
  });

  runner.test('R25-06/4 _finishExecuteError：三臂由证据分开，旧消费者字段不变', async () => {
    const ex = makeExec();
    const args = { _tcId: 'tc-9' };
    const denied = await ex._finishExecuteError('tool-x', args, Object.assign(new Error('no'), { code: 'PERMISSION_DENIED', dispatched: false, side_effect: 'none' }), 's', 'c', 'call', Date.now());
    assertEquals(denied.result_kind, 'denied');
    assertEquals(denied.dispatched, false);
    assertEquals(denied.state, 'rejected');
    assertEquals(denied.ok, false);
    assertEquals(denied.error, 'no');

    const ind = await ex._finishExecuteError('tool-x', args, Object.assign(new Error('t'), { code: 'timeout' }), 's', 'c', 'call', Date.now());
    assertEquals(ind.result_kind, 'indeterminate');

    const fail = await ex._finishExecuteError('tool-x', args, Object.assign(new Error('boom'), { code: 'handler_threw', dispatched: true }), 's', 'c', 'call', Date.now());
    assertEquals(fail.result_kind, 'failed');
    assertEquals(fail.dispatched, true);
    assertEquals(fail.category, 'internal');
    assertEquals(fail.state, 'failed');
  });

  runner.test('R25-06/5 执行器与内核共用同一张七类表（不得有第二份）', async () => {
    const text = src('plugins/tool-executor.js');
    assert(text.includes("from '../src/core/core.js'"), '必须从内核引用唯一真相');
    assert(!/_category\s*=\s*\{|CODE_CATEGORY\s*=/.test(text), '执行器里不得再抄一份 code→category 表');
  });

  // ── 收尾 ────────────────────────────────────────────────────────
  await runner.test('R25-teardown 临时目录清空（不留垃圾）', async () => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    assertEquals(tmpDirs.length > 0, true);
    tmpDirs = [];
  });
}
