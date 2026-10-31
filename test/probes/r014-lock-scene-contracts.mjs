// R-014-1～R-014-5 独立探针：专家 0.14.0 复审提出的五条可复现反例。
//
// 与 k01-k14 / k15-k17 的关系：
//   · k01-k14 是专家以 v0.10.4 为基线点名的 20 条，v0.12.0 全绿；
//   · k15-k17 是我在 v0.13.0 实跑时自己查出的 3 条，v0.14.0 全绿；
//   · 本文件 5 条是专家在 v0.14.0 **复审**中查出的，全部落在 v0.14.0 **新增**的机制上
//     （ALS 可重入锁、场景提交判据）。它们的共同形状很值得记：
//     **v0.14.0 修好的那些机制，自己又带来了极端条件下的新反例。**
//
// 这 5 条都是我按专家的文字描述**自己写探针**复现的，没有拿专家的脚本对照。
// 如果我复现不出来，那就该说"无法复现"，而不是照抄结论。
//
// 用法：
//   node test/probes/r014-lock-scene-contracts.mjs          # 全部
//   node test/probes/r014-lock-scene-contracts.mjs R-014-1  # 只跑一条
//
// 退出码约定与 k01-k14 / k15-k17 一致（**故意反直觉**）：
//   0 = 全部已修且每条都真的验证过；1 = 仍有缺陷或前置不满足；2 = 用法错误。

import { Core } from '../../src/core/core.js';
import { SceneController } from '../../src/core/scene-controller.js';
import { LifecycleManager } from '../../src/core/lifecycle-manager.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmpRoots = [];

function sandbox(tag) {
  const t = mkdtempSync(join(tmpdir(), `r014-${tag}-`));
  tmpRoots.push(t);
  mkdirSync(join(t, 'plugins'), { recursive: true });
  mkdirSync(join(t, 'scenes'), { recursive: true });
  writeFileSync(join(t, 'package.json'), '{"type":"module"}');
  return t;
}

function makeCore(t, extra = {}) {
  return new Core({ stateDir: t, pluginsDir: join(t, 'plugins'), ...extra });
}

/** 场景桩：声明集合 + 可选 partial/missingIncludes + 可选 defaultConfig。 */
function sceneStub(core, decl, extra = {}) {
  const pm = {
    isResolvable: () => true,
    async unload(n) { core.plugins.delete(n); return { ok: true }; },
    async loadOne(n) {
      const cur = core.plugins.get(n);
      if (cur?.state === 'running') return { ok: true, name: n };
      core.plugins.set(n, { name: n, state: 'running' });
      return { ok: true, name: n };
    },
  };
  const sc = new SceneController(core, pm);
  sc.findScene = async (n) => {
    const d = decl[n];
    if (!d) return null;
    return { name: n, plugins: d.plugins || [], eager: d.eager || [], optional: [], ...(d.extra || {}) };
  };
  return { sc, pm, ...extra };
}

const results = [];
async function probe(id, title, fn) {
  try {
    const r = await fn();
    if (r && r.blocked) {
      results.push({ id, title, verdict: 'NOT_REPRODUCED', detail: `前置条件不满足：${r.blocked}` });
      return;
    }
    results.push({ id, title, verdict: r.bug ? 'BUG' : 'FIXED', detail: r.detail });
  } catch (err) {
    results.push({ id, title, verdict: 'NOT_REPRODUCED', detail: `探针本身失败：${err?.message || err}` });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// R-014-1 可重入锁的**过期 ALS 上下文**绕过独占
//
// 专家原文：在锁内安排但**未等待**的定时器/异步后代，会继承 `_heldKeys` 的 Set；
// 外层锁早已释放，它仍保有"我持锁"的标记，于是 `held.has(key)` 直接放行 —— 与
// **后来的、真正持锁者**并行进入同一独占区。
//
// 判据（两点同时成立才算已修）：
//   ① 后代在原锁释放后、他人持锁期间不得进入独占区（峰值并发必须为 1）；
//   ② 但**同一活跃租约内**的重入仍必须成立（否则 reload → load/unload 会自锁，
//      这是 v0.14.0 加 ALS 的**目的**，修 R-014-1 不能把 K-15 的主修法拆掉）。
// 只要求 ① 的实现（例如把重入整个删掉）会让 M14 那条变异重新变红 —— 所以两条一起判。
// ───────────────────────────────────────────────────────────────────────────
await probe('R-014-1', '过期 ALS 上下文绕过独占：后代在他人持锁期间进入同一区', async () => {
  const t = sandbox('r1');
  const core = makeCore(t);
  const lc = new LifecycleManager(core);
  const KEY = 'shared-fact';

  let concurrent = 0;
  let maxConcurrent = 0;
  const order = [];
  const inRegion = async (tag, ms) => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    order.push(`${tag}_enter`);
    await new Promise((r) => setTimeout(r, ms));
    order.push(`${tag}_exit`);
    concurrent -= 1;
  };

  // ① 第一把锁里派生一个**不等待**的后代（25ms 后才动手），锁本体很快结束。
  await lc.runExclusive(KEY, async () => {
    setTimeout(() => {
      // 该后代继承父链的 Set；父锁早已释放。它此时不应被认作持锁者。
      lc.runExclusive(KEY, () => inRegion('detached', 40)).catch(() => {});
    }, 25);
    await inRegion('first', 10);
  });

  // ② 25ms 后后代醒来之前，第二个真正的请求先拿到锁并持有一段时间。
  await new Promise((r) => setTimeout(r, 20));
  await lc.runExclusive(KEY, () => inRegion('later', 75));

  const overlapped = maxConcurrent > 1;

  // ③ 活性校验：同一活跃租约内的重入必须仍然成立（否则 reload→load 自锁）。
  let reentered = false;
  await lc.runExclusive(KEY, async () => {
    await lc.runExclusive(KEY, async () => { reentered = true; });
  });

  if (!reentered) {
    return { bug: true, detail: `外层锁内重入被阻塞 —— 修 R-014-1 时把可重入整个拆掉了（K-15 的主修法失效）。顺序=${order.join('→')}` };
  }
  return {
    bug: overlapped,
    detail: `峰值并发=${maxConcurrent}（期望 1）；事件顺序=${order.join('→')}`
      + (overlapped
        ? '（**过期 ALS 上下文被认作持锁者：后代的"我在链里"被当成"我仍持有活动租约"**）'
        : '（过期上下文不再放行；同一活跃租约内重入仍成立）'),
  };
});

// ───────────────────────────────────────────────────────────────────────────
// R-014-2 队列 Map 保留已完成 key，与注释声称的内存回收相矛盾
//
// 原实现：`this._queues.set(key, prev.then(...))` 存的是**包装 Promise**，
// 而 finally 里比较的却是 `next`（另一个对象）—— 身份永远不相等，删除永不发生。
//
// 判据：N 个不同 key 全部执行完毕后，Map 规模必须回到基线（允许 0）。
// 这不是"内存泄漏有多严重"的问题，而是**注释在说谎**（与 K-17 同族）。
// ───────────────────────────────────────────────────────────────────────────
await probe('R-014-2', '队列 Map 不回收已完成 key（注释声称会回收）', async () => {
  const t = sandbox('r2');
  const core = makeCore(t);
  const lc = new LifecycleManager(core);
  const before = lc._queues.size;
  const N = 200;
  for (let i = 0; i < N; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await lc.runExclusive(`k-${i}`, async () => {});
  }
  const after = lc._queues.size;
  const leaked = after > before;
  return {
    bug: leaked,
    detail: `${N} 个一次性 key 全部执行完毕后 Map 规模 ${before} → ${after}`
      + (leaked ? '（**已完成条目未回收，注释声称"排空就删除"与实现不符**）' : '（已回到基线）'),
  };
});

// ───────────────────────────────────────────────────────────────────────────
// R-014-3 两个场景**插件集合相同**，却留下"运行态与持久配置不一致"
//
// 判据：场景名从 A 变成 B（配方相同）时，
//   ① 若声明了持久化合同，磁盘上记的 activeScene 必须变成 B；
//   ② 只有"场景名与配方都等价"才算 unchanged、才允许不写盘。
// 修前：只按"插件集合有没有变"判断，于是 A→B 返回 persisted:false / unchanged:true，
// 内存里 currentScene='B'、磁盘仍是 'A' —— 重启后恢复成哪个是分叉的。
// ───────────────────────────────────────────────────────────────────────────
await probe('R-014-3', '场景 A→B 插件集合相同：内存已切、磁盘未提交（unchanged 判据过宽）', async () => {
  const t = sandbox('r3');
  const core = makeCore(t);
  let saves = 0;
  let disk = null;
  core._services.set('config', {
    get: () => disk,
    set: () => {},
    setAndSave: async (k, v) => { saves += 1; if (k === 'activeScene') disk = v; },
  });
  const { sc } = sceneStub(core, { 'scene-A': { eager: ['p'] }, 'scene-B': { eager: ['p'] } });

  await sc.switchTo('scene-A', { yes: true });
  const savesAfterA = saves;
  const d1 = await sc.switchTo('scene-B', { yes: true });

  const memScene = sc.currentScene;
  const diskScene = disk;
  const diverged = memScene !== diskScene;
  return {
    bug: diverged,
    detail: `切 A 后 saves=${savesAfterA}、disk=${JSON.stringify(disk)}`
      + `；切 B：ok=${d1?.ok} persisted=${d1?.persisted} unchanged=${d1?.unchanged}`
      + `；最终 内存=${JSON.stringify(memScene)} / 磁盘=${JSON.stringify(diskScene)}`
      + (diverged
        ? '（**场景名变了但磁盘没提交：重启后的恢复语义与内存分叉**）'
        : '（场景名变化已按持久化合同提交；同配方不再被判为"没发生切换"）'),
  };
});

// ───────────────────────────────────────────────────────────────────────────
// R-014-4 场景已标记 missingIncludes/partial，切换仍可 ok:true
//
// `_expandIncludes` 已经诚实地产出了 `partial:true` + `missingIncludes`，
// 但 `switchTo` 的 Preflight 只看"toAdd 里那几条能不能解析"，不看**场景自己已经声明我不完整**。
// 于是"少装了一整个底座"仍然提交成 ok。
//
// 判据：partial 场景（必需 include 缺失）不得返回 ok:true，必须具名失败并带上缺失项。
// ───────────────────────────────────────────────────────────────────────────
await probe('R-014-4', '必需 include 缺失（场景已标 partial）：切换仍提交 ok:true', async () => {
  const t = sandbox('r4');
  const core = makeCore(t);
  core._services.set('config', { get: () => null, set: () => {}, setAndSave: async () => {} });
  const { sc } = sceneStub(core, {
    incomplete: {
      plugins: ['p'],
      extra: { partial: true, missingIncludes: ['required-parent'] },
    },
  });

  const r = await sc.switchTo('incomplete', { yes: true });
  const committed = r?.ok === true && sc.currentScene === 'incomplete';
  const named = r?.code === 'scene_preflight_failed'
    && Array.isArray(r?.missingIncludes) && r.missingIncludes.includes('required-parent');
  // 已修的条件：不提交，且能说清缺了谁。
  const fixed = !committed && named;
  return {
    bug: !fixed,
    detail: `ok=${r?.ok} code=${JSON.stringify(r?.code)} currentScene=${JSON.stringify(sc.currentScene)}`
      + `；缺失项是否回传=${JSON.stringify(r?.missingIncludes ?? null)}`
      + (fixed
        ? '（partial 场景被阻断，并具名说出缺哪个 include）'
        : `（**场景自己已经声明 partial，切换仍${committed ? '提交了 ok' : '未给出具名失败'}**）`),
  };
});

// ───────────────────────────────────────────────────────────────────────────
// R-014-5 Verify 只检查 toAdd，忽略"已在 Map 里但不在 Running"的必需插件
//
// 修前：`verified = toAdd.filter(state === 'running')`。若目标插件 p 早就在 Map 里、
// 状态是 error，则 toAdd=[]、stillMissing=[] ⇒ ok:true + verified:true，
// 而 p 实际上仍然坏着。**"没有要新装的"不等于"该在跑的都在跑"。**
//
// 判据：Verify 覆盖**场景声明的完整必需集合**；任一必需插件不处于 running ⇒ 不得 verified:true。
// 同时要求：修法不能把 lazy/optional 也一律要求 running（那会把合法懒加载判成失败）。
// ───────────────────────────────────────────────────────────────────────────
await probe('R-014-5', 'Verify 只看 toAdd：已存在但 error 的必需插件被漏过', async () => {
  const t = sandbox('r5');
  const core = makeCore(t);
  core._services.set('config', { get: () => null, set: () => {}, setAndSave: async () => {} });
  // 预先登记一个"已在 Map 里但坏了"的插件 —— 它既不在 toAdd 也不在 toRemove 里。
  core.plugins.set('p', { name: 'p', state: 'error' });
  const { sc } = sceneStub(core, {
    needp: { eager: ['p'] },
    // 交叉验证用：一个 lazy 场景，懒加载插件不该被判成"必须 running"。
    lazyone: { plugins: [], lazy: ['lz'] },
  });

  const r = await sc.switchTo('needp', { yes: true });
  const litGreen = r?.ok === true && r?.verified === true;
  const actualState = core.plugins.get('p')?.state;

  // 交叉验证：合法懒加载不得被误判为失败（防止修过头，把 lazy 也一律要求 running）。
  const rl = await sc.switchTo('lazyone', { yes: true });
  const lazyOk = rl?.ok === true;

  if (!lazyOk) return { blocked: '懒加载场景被判失败，说明修法把 lazy 也一律要求 running，本判据的前提被破坏' };

  return {
    bug: litGreen,
    detail: `场景声明必需插件 [p]（实为 ${JSON.stringify(actualState)}）：ok=${r?.ok} verified=${r?.verified}`
      + `；lazy 场景交叉验证 ok=${rl?.ok}`
      + (litGreen
        ? '（**必需插件仍是 error，切换却报 verified:true —— Verify 只看了"我这轮新装了谁"**）'
        : '（Verify 覆盖完整必需集合；lazy 未被误伤）'),
  };
});

// ───────────────────────────────────────────────────────────────────────────
// 输出
// ───────────────────────────────────────────────────────────────────────────
const only = process.argv.slice(2).filter((a) => /^R-014-[1-5]$/.test(a));
const rows = only.length ? results.filter((r) => only.includes(r.id)) : results;
if (only.length && rows.length === 0) {
  console.error(`没有匹配的探针：${only.join(', ')}；可用：${results.map((r) => r.id).join(', ')}`);
  process.exit(2);
}

const W = (s, n) => String(s).padEnd(n);
console.log('\n=== 土行孙：R-014-1～5 复审反例探针（0.14.0 新增机制上的极端条件）===\n');
for (const r of rows) {
  const tag = r.verdict === 'BUG' ? 'BUG ' : r.verdict === 'FIXED' ? 'FIXED' : 'N/REP';
  console.log(`[${tag}] ${W(r.id, 8)} ${r.title}`);
  console.log(`         ${r.detail}`);
}
const bugCount = rows.filter((r) => r.verdict === 'BUG').length;
const fixedCount = rows.filter((r) => r.verdict === 'FIXED').length;
const otherCount = rows.filter((r) => !['BUG', 'FIXED'].includes(r.verdict)).length;
console.log(`\n--- ${rows.length} 条：BUG ${bugCount} / FIXED ${fixedCount} / NOT_REPRODUCED ${otherCount} ---`);
const allClear = bugCount === 0 && otherCount === 0;
if (bugCount > 0) console.log('结论：仍有缺陷。退出码 1（故意与直觉相反，见文件头）。\n');
else if (otherCount > 0) console.log(`结论：有 ${otherCount} 条前置条件不满足 —— 不足以判定"已修复"。退出码 1。\n`);
else console.log('结论：本批反例全部已修复。\n');

for (const t of tmpRoots) { try { rmSync(t, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ } }
process.exit(allClear ? 0 : 1);
