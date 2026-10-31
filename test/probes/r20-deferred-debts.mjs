#!/usr/bin/env node
/**
 * R20 探针：rc.6 遗留三项延期技术债的**可失败**判据。
 *
 * 纪律（延续 R19）：
 *   ① 每条判据配一条**合法正例**，防"一律拒绝/一律阻塞"式假修复；
 *   ② 判据必须能看见它的目标：断言点放在被测路径**上**，不是放在"看起来对的状态名"上；
 *   ③ 退出码三态：0 = 全部通过，1 = 有判据失败，2 = 探针自身异常。
 *
 * 用法：node test/probes/r20-deferred-debts.mjs [--json]
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Core } from '../../src/core/core.js';

const results = [];

function record(id, title, ok, detail) {
  results.push({ id, title, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} ${title}${detail ? ` — ${detail}` : ''}`);
}

async function check(id, title, fn) {
  try {
    const r = await fn();
    record(id, title, r.ok, r.detail);
  } catch (err) {
    // 探针自身异常不能被算成"被测代码失败"，否则退出码语义就混了。
    record(id, title, false, `probe_error: ${err?.message || err}`);
    throw err;
  }
}

const tmpDirs = [];
function makeCore() {
  const dir = mkdtempSync(join(tmpdir(), 'tuxingsun-r20-'));
  tmpDirs.push(dir);
  const core = new Core({ stateDir: dir });
  core.log = () => {};
  core._stopAssemblyDrainMs = 20;
  return core;
}

function makePlugin(name, extra = {}) {
  return { name, version: '1.0.0', async init() {}, async start() {}, async stop() {}, ...extra };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ── D20-01：并发 stop() 的"谁算停下来" ────────────────────────────────
  // 第一个 stop() 在等 _drainAssemblies 时，第二个 stop() 必须**共享**同一笔停机，
  // 而不是看见 running===false 就当场 resolve —— 那会让调用方在插件还在跑时
  // 就宣布"已停止"，于是紧接着 process.exit() 会截断插件自己的收尾。
  await check('D20-01', '并发 stop() 不得在插件停完之前返回', async () => {
    const core = makeCore();
    let stopFinished = 0;
    core.register(makePlugin('slow', {
      async stop() { await sleep(120); stopFinished += 1; },
    }));
    await core.start();
    const first = core.stop();
    await sleep(10);                                  // 让第二个落在第一个的 await 里
    const second = core.stop();
    const secondSettled = await Promise.race([
      second.then(() => 'settled'),
      sleep(60).then(() => 'still-pending'),
    ]);
    const snapshot = { secondSettled, stopFinishedAtVerdict: stopFinished };
    await Promise.all([first, second]);
    // 判据只有一句：第二个 stop() 不得在插件的 stop() 完成之前就 resolve。
    const earlyReturn = secondSettled === 'settled' && snapshot.stopFinishedAtVerdict === 0;
    return {
      ok: !earlyReturn,
      detail: JSON.stringify({ ...snapshot, stopFinishedAfter: stopFinished, earlyReturn }),
    };
  });

  // ── D20-02：合法正例 —— 单次 stop() 仍然干净收尾 ──────────────────────
  await check('D20-02', '正例：单次 stop() 正常停止插件', async () => {
    const core = makeCore();
    let stopped = 0;
    core.register(makePlugin('solo', { async stop() { stopped += 1; } }));
    await core.start();
    const returned = await core.stop();
    return {
      ok: stopped === 1 && core.running === false && core._stopped === true,
      detail: JSON.stringify({ stopped, running: core.running, stoppedFlag: core._stopped, returns: returned === undefined ? 'undefined' : typeof returned }),
    };
  });

  // ── D20-03：停机取锁必须**有界** ─────────────────────────────────────
  // 一条永不结束的链持有该插件的独占区（模拟"插件在自己的 stop() 里去卸别的插件"
  // 那类跨 key 等待）。stop() 必须有界地放弃这一条并**如实记一笔**：
  // 既不能无限等锁（关机挂住），也不能静默跳过（少停一个不说）。
  await check('D20-03', '停机取锁有界：等待超时降级为具名失败，不挂住关机', async () => {
    const core = makeCore();
    core._stopLockMs = 150;
    core.register(makePlugin('locked'));
    await core.start();
    let releaseLock = null;
    const held = core.lifecycle.runExclusive('locked', () => new Promise((r) => { releaseLock = r; }));
    await sleep(10);                                   // 让持锁链先拿到手
    let payload = null;
    core.on('core.stopped', (p) => { payload = p; });
    const t0 = Date.now();
    await core.stop();
    const elapsed = Date.now() - t0;
    releaseLock();
    await held;
    const fails = payload?.stopFailures ?? [];
    const reported = fails.some((f) => f.plugin === 'locked');
    return {
      ok: elapsed < 1500 && reported,
      detail: JSON.stringify({ elapsedMs: elapsed, bounded: elapsed < 1500, reported, fails: fails.map((f) => f.plugin) }),
    };
  });

  // ── D20-04：停机之后卸载同一个插件 ⇒ stop() 只跑一次 ────────────────
  // 时序就是现场会发生的那个：先 `core.stop()`（插件被推成 stopped），
  // 再由清理路径 `unload` 它。`stopped → unloaded` 是合法转移，所以卸载会真的走到
  // `_step4StopPlugin`。修前那里只判 `plugin.stop` 存不存在，于是同一个对象被 stop 第二遍
  //（实测：守卫去掉后 stopsFinal=2）。
  await check('D20-04', '停机后卸载同一插件：stop() 只被调用一次', async () => {
    const core = makeCore();
    let stops = 0;
    core.register(makePlugin('settled', { async stop() { stops += 1; } }));
    await core.start();
    await core.stop();
    const afterStop = { stops, state: core.plugins.get('settled')?.state };
    const unload = await core.lifecycle.unload('settled');
    return {
      ok: afterStop.state === 'stopped' && afterStop.stops === 1 && stops === 1 && unload?.ok === true,
      detail: JSON.stringify({ afterStop, unloadOk: unload?.ok, stopsFinal: stops }),
    };
  });

  // ── D20-05：停机先拿到锁、卸载排队 ⇒ 依然只 stop 一次 ────────────────
  // 这条同时测两件事：① 逐插件取 key 让两条入口串行（不串行时两边各自 stop）；
  // ② 串行之后卸载看到的是 stopped，必须跳过一次 stop。
  await check('D20-05', '停机先持锁、卸载排队：stop() 只被调用一次', async () => {
    const core = makeCore();
    let stops = 0;
    core.register(makePlugin('contended', { async stop() { stops += 1; await sleep(40); } }));
    await core.start();
    const stopping = core.stop();
    await sleep(5);                                    // 让停机段先拿到该插件的独占区
    const unloading = core.lifecycle.unload('contended').catch((e) => ({ ok: false, error: e.message }));
    await Promise.all([stopping, unloading]);
    await sleep(50);                                   // 留出迟到第二次调用的窗口
    return { ok: stops === 1, detail: JSON.stringify({ stops }) };
  });
}

try {
  await main();
} catch (err) {
  console.error(`[probe-error] ${err?.stack || err}`);
  process.exitCode = 2;
} finally {
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
}

if (process.exitCode !== 2) {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (process.argv.includes('--json')) console.log(JSON.stringify({ results }, null, 2));
  process.exitCode = failed.length ? 1 : 0;
}
