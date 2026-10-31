// R0-020（rc.15）：**锁的两个阶段与停机的两个阶段，各自有界**。
//
// 专家 rc.14 复审的两条 P0-1（本仓 H7 / H8）同源：把"等待"当成了一件事。
//
//   H7  等锁超时的清理与"释放持有"共用了一段代码，于是超时者**把自己从队列 Map 删掉**。
//       删掉之后 Map 里这条 key 看起来"没人持有"，下一个调用方读到空 prev 直接进入——
//       而真正的持有者还在里面跑。**同 key 双持有者**不是理论问题，下面 /1 在修前实测并发 2。
//
//   H8  `_stopOnePlugin` 传的 `timeoutMs` 只约束**等锁**；`runExclusive` 拿到锁之后是裸
//       `await fn()`。一个永不返回的 `plugin.stop()` 会让 `Core.stop()` 永不返回，
//       兜底只剩 SIGKILL——那时一条插件收尾都跑不完。
//
// 修后的判据必须同时成立三件事，缺一条就是"修了但没修对"：
//   ① 该坏的坏了吗？    超时之后**不得**出现同 key 双持有者（/1、/7）；
//   ② 停机有界了吗？    挂起的 stop() 必须让 core.stop() 在有限时间内返回（/5）；
//   ③ 诚实了吗？        有界返回**不等于**停干净：回执要分阶段写 unknown（/6、/10），
//                       且插件状态不得被推成 stopped。
//
// 反向判据（防"一律拒绝"式假修复）：正常结束仍回收队尾（/3）、异常与重入不被误伤（/4）、
// 正常 stop() 的插件仍然零失败且回执里没有 phase 字段（/9）、交出释放权的 key 在持有者
// 结账后必须恢复可用（/8，防"永久中毒"）。
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assert, assertEquals } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(join(ROOT, rel));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function setup(runner) {
  const { Core } = await imp('src/core/core.js');
  const { LifecycleManager } = await imp('src/core/lifecycle-manager.js');
  let tmp;

  runner.beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'r020-')); });
  runner.afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ } });

  const makeCore = (lockMs = 120) => {
    const c = new Core({ stateDir: join(tmp, 'state') });
    c.log = () => {};
    c._stopAssemblyDrainMs = 20;
    c._stopLockMs = lockMs;
    return c;
  };
  const makePlugin = (name, extra = {}) => ({
    name, version: '1.0.0', async init() {}, async start() {}, async stop() {}, ...extra,
  });

  // ══ H7：等锁超时**只**退出自己的等待资格 ══════════════════════════
  runner.test('R0-020/1 等锁超时不得让后来的调用方与持有者重叠（同 key 峰值并发 = 1）', async () => {
    const lc = new LifecycleManager({});
    let concurrent = 0;
    let peak = 0;
    const enter = async (ms) => {
      concurrent += 1; peak = Math.max(peak, concurrent);
      await sleep(ms);
      concurrent -= 1;
    };
    // A 抱住 120ms；B 只肯等 30ms（超时）；C 在 B 超时之后到达。
    const pA = lc.runExclusive('k', () => enter(120));
    await sleep(15);
    let bErr = null;
    try { await lc.runExclusive('k', () => enter(5), { timeoutMs: 30 }); } catch (err) { bErr = err; }
    assertEquals(bErr?.code, 'lock_timeout', 'B 应当以具名 lock_timeout 放弃等待（不得静默进入）');
    const pC = lc.runExclusive('k', () => enter(5));
    await sleep(40);
    // 修前：B 的清理把 Map 里的队尾删了，C 读到空 prev 当场进入 ⇒ 此处为 2。
    assertEquals(concurrent, 1,
      `B 超时后 C 必须仍排在 A 后面，实测此刻并发 ${concurrent} —— >1 就是同 key 双持有者（H7 复发）`);
    await Promise.all([pA, pC]);
    assertEquals(peak, 1, `全程峰值并发必须为 1，实测 ${peak}`);
  });

  runner.test('R0-020/2 超时者离开后，队列仍按到达顺序推进（不得插队、不得丢单）', async () => {
    const lc = new LifecycleManager({});
    const order = [];
    let releaseA;
    const gate = new Promise((r) => { releaseA = r; });
    const pA = lc.runExclusive('k', async () => { order.push('A'); await gate; });
    await sleep(15);
    await lc.runExclusive('k', async () => { order.push('B-不该跑到'); }, { timeoutMs: 25 }).catch(() => { /* 预期超时 */ });
    const pC = lc.runExclusive('k', async () => { order.push('C'); });
    const pD = lc.runExclusive('k', async () => { order.push('D'); });
    await sleep(30);
    releaseA();
    await Promise.all([pA, pC, pD]);
    assertEquals(order.join(','), 'A,C,D',
      `顺序必须为 A,C,D（超时者不留痕迹），实测 ${order.join(',')}`);
  });

  runner.test('R0-020/3 反向判据：正常结束仍要回收队尾（超时修复不得让 Map 泄漏）', async () => {
    const lc = new LifecycleManager({});
    const before = lc._queues.size;
    for (let i = 0; i < 50; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await lc.runExclusive(`k-${i}`, async () => {});
    }
    assertEquals(lc._queues.size, before, `50 个一次性 key 跑完后 Map 仍残留 ${lc._queues.size - before} 条`);
    // 超时路径同样不得留痕：持有者结束、超时者已走，Map 必须回到基线。
    const pA = lc.runExclusive('t', async () => { await sleep(40); });
    await sleep(5);
    await lc.runExclusive('t', async () => { throw new Error('不该进入'); }, { timeoutMs: 15 }).catch(() => {});
    await pA;
    assertEquals(lc._queues.size, before, '超时者离开且持有者结束后，队列必须回到基线');
  });

  runner.test('R0-020/4 反向判据：异常透传与重入不被 H7 修复误伤', async () => {
    const lc = new LifecycleManager({});
    let seen = null;
    try { await lc.runExclusive('k', async () => { throw new Error('boom'); }); } catch (err) { seen = err; }
    assertEquals(seen?.message, 'boom', 'fn 的异常必须原样透传给调用方');
    let ran = false;
    await lc.runExclusive('k', async () => { ran = true; });
    assert(ran, '上一轮的异常不得把这条 key 的队列堵死');
    let depth = 0;
    await lc.runExclusive('k2', async () => {
      depth += 1;
      await lc.runExclusive('k2', async () => { depth += 1; });
    });
    assertEquals(depth, 2, '活跃租约内的重入必须仍然放行（reload→load 不能自锁）');
  });

  // ══ H8：停机有界，但"有界"不等于"已停干净" ═══════════════════════
  runner.test('R0-020/5 永不返回的 stop() 不得让 core.stop() 永不返回', async () => {
    const core = makeCore(120);
    core.register(makePlugin('stuck', { async stop() { await new Promise(() => { /* 永不返回 */ }); } }));
    await core.start();
    const t0 = Date.now();
    await core.stop();
    const elapsed = Date.now() - t0;
    assertEquals(core._stopped, true, 'core.stop() 必须真的走完并置 _stopped');
    assert(elapsed < 1200, `停机必须在有限时间内返回，实测 ${elapsed}ms（>1200ms 视为无界）`);
  });

  runner.test('R0-020/6 回执必须分阶段：stop_return + execution_outcome=unknown，且不得报 stopped', async () => {
    const core = makeCore(100);
    core.register(makePlugin('stuck', { async stop() { await new Promise(() => { /* 永不返回 */ }); } }));
    await core.start();
    let payload = null;
    core.on('core.stopped', (p) => { payload = p; });
    await core.stop();
    const fails = payload?.stopFailures ?? [];
    const rec = fails.find((f) => f.plugin === 'stuck');
    assert(rec, '到点没返回的插件必须出现在 stopFailures 里（不得静默跳过）');
    assertEquals(rec.phase, 'stop_return', `阶段必须是 stop_return（调用已发出但没返回），实测 ${rec.phase}`);
    assertEquals(rec.execution_outcome, 'unknown',
      '调用已发出却没返回：副作用确定不了，只能写 unknown —— 写 "none" 就是把不确定报成确定');
    const state = core.plugins.get('stuck')?.state;
    assert(state !== 'stopped',
      `stop() 没返回的插件状态不得是 stopped（实测 ${state}）—— 那等于替插件宣布它清理完了`);
  });

  runner.test('R0-020/7 交出释放权期间，同 key 再次进入必须具名快速失败（不得静默并行）', async () => {
    const core = makeCore(80);
    core.register(makePlugin('stuck', { async stop() { await new Promise(() => { /* 永不返回 */ }); } }));
    await core.start();
    await core.stop();
    const t0 = Date.now();
    let err = null;
    try { await core.lifecycle.runExclusive('stuck', async () => { /* 不该跑到 */ }); } catch (e) { err = e; }
    const elapsed = Date.now() - t0;
    assertEquals(err?.code, 'lock_abandoned',
      `上一持有者超时未结账时，新调用方必须以 lock_abandoned 快速失败，实测 ${err?.code}`);
    assert(elapsed < 50, `快速失败必须是立刻的（不排队），实测 ${elapsed}ms`);
  });

  runner.test('R0-020/8 反向判据：持有者结账后 key 必须恢复可用（不得永久中毒）', async () => {
    const core = makeCore(80);
    let releaseStop;
    const gate = new Promise((r) => { releaseStop = r; });
    core.register(makePlugin('slowstop', { async stop() { await gate; } }));
    await core.start();
    await core.stop();
    assertEquals(core.lifecycle._abandoned.size, 1, '超时期间该 key 必须处于"已交出释放权"状态');
    releaseStop();
    await sleep(30);
    assertEquals(core.lifecycle._abandoned.size, 0, '持有者结账后必须撤销废弃标记，否则这个 key 永久不可用');
    let ran = false;
    await core.lifecycle.runExclusive('slowstop', async () => { ran = true; });
    assert(ran, '结账之后同名 key 必须能再次进入（否则一次超时就永久废掉一个插件名）');
  });

  runner.test('R0-020/9 反向判据：正常 stop() 的插件零失败，回执里不得有 phase 字段', async () => {
    const core = makeCore(120);
    let stops = 0;
    core.register(makePlugin('clean', { async stop() { stops += 1; } }));
    await core.start();
    let payload = null;
    core.on('core.stopped', (p) => { payload = p; });
    await core.stop();
    assertEquals(stops, 1, 'stop() 必须被调用一次');
    assertEquals((payload?.stopFailures ?? []).length, 0, '干净停止不得产生任何失败记录');
    assertEquals(core.plugins.get('clean')?.state, 'stopped', '干净停止后状态必须是 stopped');
  });

  runner.test('R0-020/10 从未拿到独占区：阶段是 lock_wait，副作用确定未发生', async () => {
    const core = makeCore(100);
    core.register(makePlugin('locked', { async stop() { throw new Error('锁没拿到就不该被调用'); } }));
    await core.start();
    let releaseLock = null;
    const held = core.lifecycle.runExclusive('locked', () => new Promise((r) => { releaseLock = r; }));
    await sleep(10);
    let payload = null;
    core.on('core.stopped', (p) => { payload = p; });
    await core.stop();
    releaseLock();
    await held;
    const rec = (payload?.stopFailures ?? []).find((f) => f.plugin === 'locked');
    assert(rec, '没拿到独占区的插件必须出现在 stopFailures 里（不得静默跳过）');
    assertEquals(rec.phase, 'lock_wait', `阶段必须是 lock_wait，实测 ${rec.phase}`);
    assertEquals(rec.execution_outcome, 'none',
      '一次都没进独占区 ⇒ stop() 没被调用，副作用确定未发生，写 none 才是诚实的');
  });
}
