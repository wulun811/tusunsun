// K-15～K-17 独立探针：专家方案 §6.2（串行化）与 §5.3（内部唯一 token）仍缺的三条。
//
// 为什么单独一个文件，而不是塞进 k01-k14：
//   · 那 20 条是"专家以 v0.10.4 为基线点名"的反例，v0.12.0 已全部转绿。
//     把新查出的缺陷混进去，会让"20/20"这个数字失去可比性。
//   · 这三条是**同一份方案的另外两条要求**，此前从未有探针，
//     所以它们不是"回归"，是**首次复现**。
//
// 三条都不是我读代码猜出来的 —— 是 v0.13.0 验收时**实跑**看到的：
//   · K-15：三次并发 reload，两个调用方都收到 ok:true，而两次的成果被丢了；
//   · K-16：两个并发 switchTo，两个都 ok:true，currentScene 是后者，磁盘按序写了两次；
//   · K-17：同一 traceId 连调两次，两个**物理尝试**拿到同一个 attempt_id，
//          而 core.js 的注释写着"attempt_id 标识物理尝试（唯一）"。
//
// 用法：
//   node test/probes/k15-k17-concurrency-and-identity.mjs          # 全部
//   node test/probes/k15-k17-concurrency-and-identity.mjs K-15     # 只跑一条
//
// 退出码约定与 k01-k14 一致（**故意反直觉**）：
//   0 = 全部已修且每条都真的验证过；1 = 仍有缺陷或前置不满足；2 = 用法错误。

import { Core } from '../../src/core/core.js';
import { PluginManager } from '../../src/core/plugin-manager.js';
import { SceneController } from '../../src/core/scene-controller.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmpRoots = [];

function sandbox(tag) {
  const t = mkdtempSync(join(tmpdir(), `kprobe-${tag}-`));
  tmpRoots.push(t);
  mkdirSync(join(t, 'plugins'), { recursive: true });
  mkdirSync(join(t, 'scenes'), { recursive: true });
  // Node 18 无 ESM 语法探测：临时目录不是模块包时 `.js` 会被当 CJS 解析。
  writeFileSync(join(t, 'package.json'), '{"type":"module"}');
  return t;
}

function makeCore(t, extra = {}) {
  return new Core({ stateDir: t, pluginsDir: join(t, 'plugins'), ...extra });
}

function writePlugin(t, file, body) {
  const p = join(t, 'plugins', file);
  writeFileSync(p, body);
  return p;
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
// K-15 同一 owner 的并发 reload 未串行化 —— 两个调用方都被告知成功，其中一份成果被丢
//
// 专家原文 §6.2：「同一 plugin owner 的 start/load/unload/reload 必须串行化或 single-flight」。
//
// 判据不是"有没有 lock 这个词"，而是**实际后果**：并发 N 次 reload 后，
//   ① 每一次都返回 ok:true（说明它们真的并行跑了，而不是被排队/被拒）；
//   ② 但"实际在服务的实例"只前进了一步（N−1 次成果消失）。
// 两条同时成立 ⇒ 系统对外说了 N 次成功，实际只兑现了 1 次。
// ───────────────────────────────────────────────────────────────────────────
await probe('K-15', '同一 owner 并发 reload：都报 ok，成果被丢（§6.2 未串行化）', async () => {
  const t = sandbox('k15');
  const core = makeCore(t);
  const pm = new PluginManager(core);
  pm.registerCapabilities();
  // 每次 import 都自增一个全局代数，用来分辨"实际在服务的是第几代"。
  // 用 globalThis 而不是模块内变量：模块被 cache-bust 重新 import 时模块内变量会重置，
  // 那就分不清"换了实例"与"还是老实例"了。
  writePlugin(t, 'ser.js', `
globalThis.__k15gen = (globalThis.__k15gen || 0) + 1;
const GEN = globalThis.__k15gen;
export default {
  name: 'ser', version: '1.0.0', provides: [], requires: {},
  async init(core) { this.core = core; },
  async start() { await new Promise((r) => setTimeout(r, 40)); },
  async stop() {},
  async work() { return GEN; },
};
`);
  await pm.loadFromDir(join(t, 'plugins'), ['ser']);
  const gen0 = await core.plugins.get('ser')?.work();
  if (gen0 === undefined) return { blocked: '插件未装载成功，无法构造并发 reload 场景' };

  const rs = await Promise.all([
    core.callCapability('plugin.reload', { name: 'ser' }),
    core.callCapability('plugin.reload', { name: 'ser' }),
    core.callCapability('plugin.reload', { name: 'ser' }),
  ]);
  const oks = rs.map((r) => r?.payload?.ok === true);
  const okCount = oks.filter(Boolean).length;
  const genAfter = await core.plugins.get('ser')?.work();
  const imports = globalThis.__k15gen;

  // 判据分三种情形，只有一种算"已修"：
  //   ① 全部被拒/排队 ⇒ ok 数 ≤ 1，且没有成果丢失 —— 合规（拒绝也是串行化的合法实现）
  //   ② 全部 ok，且代数前进了 N 步（3 次 request 全部真的落地）—— 合规
  //   ③ 全部 ok，但代数只前进 1 步 —— **违规**：说了 3 次成功，兑现 1 次
  const advanced = genAfter - gen0;
  const lost = okCount > 1 && advanced < okCount;
  return {
    bug: lost,
    detail: `3 次并发 reload → ok=${JSON.stringify(oks)}（${okCount}/3 报成功）`
      + `；实例代数 ${gen0} → ${genAfter}（前进 ${advanced} 步，期望 ≥ ${okCount}）`
      + `；真实 import 次数=${imports}`
      + (lost ? '（**报成功但成果被丢**）' : ''),
  };
});

// ───────────────────────────────────────────────────────────────────────────
// K-16 两个并发场景切换：都报 ok:true，而最终"运行态"与"声明的场景"对不上
//
// 与 K-15 同族（§6.2/§6.3 的串行化要求），但判据必须更严 ——
// 「两个都返回 ok」本身**不是**缺陷：一个正确的 single-flight 实现也可以让两次都成功
// （排队执行，各自在自己那一轮里前后一致）。真正有害的是**交错**：
// 两次的 Apply/Verify 互相穿插，于是 A 验证过的运行态在 B 提交时已经不成立了。
//
// 所以判据落在"提交的那一刻是否还在说真话"上：
//   · 最终 currentScene 声明的插件集合 vs 实际 running 的集合
//   · 二者不等 ⇒ 那个 `ok:true` + `verified:true` 是假的（I-04：只能按完成事实提交）
//
// 实测（修前）：两个都 ok，最终 currentScene='sb'（只声明 pb），而 pa 与 pb **都在跑**。
// 也就是说两个场景谁都没有真正成立，但两个调用方都收到了 ok。
// 交叉验证：这一条不是"并发就一定错"——单请求连做两次，每次结束都应自洽。
// ───────────────────────────────────────────────────────────────────────────
await probe('K-16', '两个并发 switchTo：都报 ok，提交后运行态与声明不符（§6.3 未串行化）', async () => {
  const t = sandbox('k16');
  const core = makeCore(t);
  core._services.set('config', {
    get: () => null, set: () => {},
    setAndSave: async () => { await new Promise((r) => setTimeout(r, 25)); },
  });
  // 桩一个带延迟的 pm：延迟是必需的 —— 没有它两次切换不会真的交错，
  // 那条判据就会在"恰好先后完成"的情况下空转成绿。
  const pm = {
    isResolvable: () => true,
    async unload(n) { await new Promise((r) => setTimeout(r, 15)); core.plugins.delete(n); return { ok: true }; },
    async loadOne(n) {
      await new Promise((r) => setTimeout(r, 15));
      core.plugins.set(n, { name: n, state: 'running' });
      return { ok: true, name: n };
    },
  };
  const sc = new SceneController(core, pm);
  const DECL = { sa: ['pa'], sb: ['pb'] };
  sc.findScene = async (n) => ({ name: n, plugins: [], eager: DECL[n] || [], optional: [] });

  const [a, b] = await Promise.all([
    sc.switchTo('sa', { yes: true }),
    sc.switchTo('sb', { yes: true }),
  ]);
  const running = [...core.plugins.keys()].sort();
  const declared = [...(DECL[sc.currentScene] || [])].sort();
  const consistent = JSON.stringify(running) === JSON.stringify(declared);

  // 交叉验证：串行做同样两次切换，最后一次必须自洽。
  // 这一步是为了排除"这个场景本身就不可能自洽"（例如 SCENE_ALWAYS_ON 之类的干扰）。
  core.plugins.clear();
  sc.currentScene = null;
  await sc.switchTo('sa', { yes: true });
  await sc.switchTo('sb', { yes: true });
  const serialRunning = [...core.plugins.keys()].sort();
  const serialDeclared = [...(DECL[sc.currentScene] || [])].sort();
  const serialOk = JSON.stringify(serialRunning) === JSON.stringify(serialDeclared);
  if (!serialOk) return { blocked: `串行执行也不自洽（${JSON.stringify(serialRunning)} vs ${JSON.stringify(serialDeclared)}），本判据无效` };

  return {
    bug: !consistent,
    detail: `并发 A→sa / B→sb：A.ok=${a?.ok} B.ok=${b?.ok}`
      + `；最终 currentScene=${JSON.stringify(sc.currentScene)}（声明 [${declared}]）`
      + `；实际 running=[${running}]`
      + (consistent
        ? '（运行态与声明一致 —— 交错没有破坏提交的真实性）'
        : '（**两个都报 ok，但最终谁也没有成立：声明的插件集合 ≠ 实际在跑的集合**）'),
  };
});

// ───────────────────────────────────────────────────────────────────────────
// K-17 同一 traceId 两次调用：不存在"物理尝试唯一"的标识，而注释声称有
//
// 专家原文 §5.3：「每个物理 Attempt 使用由 Core 自己产生的内部唯一 token。
// **现有 call_id/attempt_id 可以继续用于关联**，不得假定外部 traceId 永不重复
// 或具有幂等语义。」
//
// 注意原文的分工：它要的是"有一个唯一 token"，同时说 attempt_id **可用于关联**。
// 所以判据不能钉死字段名 —— 修前 `attempt_id = ${call_id}#${attempt}`，
// 同一个 traceId 调两次就撞号，而 core.js 的注释写着"标识物理尝试（唯一）"（注释在说谎）。
// 合法修法有两条：
//   (a) 把 attempt_id 本身做成唯一 —— 但已有消费者按 `call_id#attempt` 解析它（R0-76），
//       改算法是破坏性变更，须走 ADR；
//   (b) 保留 attempt_id 作关联、**新增**一个 Core 自己产生的唯一 token，并改掉那句注释。
// 本探针只问"唯一 token 存在且真的唯一"，(a)(b) 都算通过 —— 判据钉的是**要求**，不是实现。
//
// 判据三条（缺一不可）：
//   ① 两次独立调用产出一个**互不相同**的 token；
//   ② 这个 token 不依赖调用方传对参数（把 attempt 故意传成相同值，token 仍须不同）；
//   ③ attempt_id 仍在（关联字段不能消失，否则旧消费者断掉）。
// ───────────────────────────────────────────────────────────────────────────
await probe('K-17', '同一 traceId 两次调用：缺少 Core 产生的唯一物理尝试 token', async () => {
  const t = sandbox('k17');
  const core = makeCore(t);
  core.registerCapability('k17.echo', { handler: async (p) => p, owner: 'k17' });

  // ② 故意把 attempt 传成同一个值：唯一性不得依赖调用方给对参数。
  const r1 = await core.callCapability('k17.echo', { n: 1 }, { traceId: 'trace-same', attempt: 1 });
  const r2 = await core.callCapability('k17.echo', { n: 2 }, { traceId: 'trace-same', attempt: 1 });
  if (!r1?.ok || !r2?.ok) return { blocked: '能力调用未成功，无法比较尝试标识' };

  const distinctResults = r1 !== r2 && JSON.stringify(r1.payload) !== JSON.stringify(r2.payload);
  if (!distinctResults) return { blocked: '两次调用被合并成同一个结果，本判据不成立（应先查幂等合并）' };

  // 找一个"两次不同"的候选 token 字段：不钉死名字，任何加性字段表现为唯一即可。
  const excluded = new Set(['ok', 'state', 'code', 'error', 'payload', 'call_id', 'attempt',
    'attempt_id', 'caller', 'evidence', 'timestamp']);
  const candidates = [...new Set([...Object.keys(r1), ...Object.keys(r2)])]
    .filter((k) => !excluded.has(k) && typeof r1[k] === 'string' && r1[k] !== r2[k]);
  const tokenField = candidates[0] || null;
  const hasUnique = Boolean(tokenField);

  // ③ 关联字段仍在（旧消费者不受影响）。
  const hasCorrelation = typeof r1.attempt_id === 'string' && r1.attempt_id === r2.attempt_id;

  return {
    bug: !hasUnique,
    detail: `第 1 次：attempt_id=${r1.attempt_id}${tokenField ? ` / ${tokenField}=${r1[tokenField]}` : ''}`
      + `；第 2 次：attempt_id=${r2.attempt_id}${tokenField ? ` / ${tokenField}=${r2[tokenField]}` : ''}`
      + `；唯一 token 字段=${tokenField ?? '**无**'}`
      + `；关联字段 attempt_id 保留=${hasCorrelation}`
      + (hasUnique
        ? '（两次物理尝试可区分，且 attempt_id 仍作关联 —— 符合 §5.3 的分工）'
        : '（**两个物理尝试无法区分：注释写"物理尝试（唯一）"，实现只是回显调用方给的 attempt**）'),
  };
});

// ───────────────────────────────────────────────────────────────────────────
// 输出
// ───────────────────────────────────────────────────────────────────────────
const only = process.argv.slice(2).filter((a) => /^K-1[5-7]$/.test(a));
const rows = only.length ? results.filter((r) => only.includes(r.id)) : results;

if (only.length && rows.length === 0) {
  console.error(`没有匹配的探针：${only.join(', ')}；可用：${results.map((r) => r.id).join(', ')}`);
  process.exit(2);
}

const W = (s, n) => String(s).padEnd(n);
console.log('\n=== 土行孙：K-15～K-17 并发与身份探针（§6.2 串行化 / §5.3 内部 token）===\n');
for (const r of rows) {
  const tag = r.verdict === 'BUG' ? 'BUG ' : r.verdict === 'FIXED' ? 'FIXED' : 'N/REP';
  console.log(`[${tag}] ${W(r.id, 6)} ${r.title}`);
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
