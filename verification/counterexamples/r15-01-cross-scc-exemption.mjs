#!/usr/bin/env node
/**
 * verification/counterexamples/r15-01-cross-scc-exemption.mjs
 *
 * 专家 rc.15 独立复审的 R15-01：**环豁免被写成了“出现在任意一个环里”**。
 *
 * 缺陷形状：`_pendingDependentsOf` 把所有 `stopOrderCycles` 里的节点并成一个 `cyclic`
 * Set，再 `if (cyclic.has(name) && cyclic.has(plugin)) continue`。它豁免的是“两个节点
 * 各自在某个环里”，不是“两个节点在同一个强连通分量里”——于是两个互不相干的环之间
 * 那条**真实**依赖边被一起豁免。
 *
 * 图（与专家脚本同一张）：`a↔b`、`c↔d` 两个环，再加 `c → a`（c 硬依赖 a）；`c.stop()` 卡住。
 *
 * 三条判据：
 *   01 跨 SCC 的活依赖：c 卡住 ⇒ a **一次都不许被停**，且仍在 running。
 *   02 诚实：跳过必须以 `skipped_dependents_pending` + `dependents` 具名交出，
 *      且不得混进 `stopFailures`（“根本没动” vs “试着停但没停成”）。
 *   03 正控：同一张图但 c 正常停 ⇒ 四个全停、零跳过 —— 否则“一律不停”也能让 01/02 变绿。
 *
 * 跑：node verification/counterexamples/r15-01-cross-scc-exemption.mjs
 * 退出码 0 = 全 FIXED；1 = 仍有反例；2 = 前置不满足、不能下结论。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const { Core } = await import(join(ROOT, 'src/core/core.js'));

const tmp = mkdtempSync(join(tmpdir(), 'r15-01-'));
const results = [];
const check = (id, title, ok, detail) => results.push({ id, title, status: ok ? 'FIXED' : 'OPEN', detail });

/** 起一台 Core，按图装配，返回真的被调过 stop 的插件名 + 终态 + `core.stopped` 载荷。 */
async function run(specs, tag) {
  const calls = [];
  const core = new Core({ stateDir: join(tmp, `state-${tag}`) });
  core.log = () => {};
  core._stopLockMs = 120;          // 让超时快速发生，不等 30s
  core._stopAssemblyDrainMs = 20;
  for (const p of specs) {
    await core.register({
      name: p.name, version: '1.0.0',
      ...(p.requires ? { requires: p.requires } : {}),
      async init() {}, async start() {},
      async stop() {
        calls.push(p.name);
        if (p.hang) await new Promise(() => {});   // 永不返回：模拟卡死的收尾
      },
    });
  }
  await core.start();
  let payload = null;
  core.on('core.stopped', (e) => { payload = e; });
  await core.stop();
  const states = Object.fromEntries(specs.map((p) => [p.name, core.plugins.get(p.name)?.state]));
  return { core, calls, payload, states };
}

const GRAPH = [
  { name: 'a', requires: { b: '*' } },
  { name: 'b', requires: { a: '*' } },
  { name: 'c', requires: { d: '*', a: '*' }, hang: true },
  { name: 'd', requires: { c: '*' } },
];

try {
  const stuck = await run(GRAPH, 'stuck');
  const cycles = stuck.payload?.stopOrderCycles ?? [];
  if (cycles.length < 2) {
    console.error(`INCONCLUSIVE: 期望两个独立环，实际 ${JSON.stringify(cycles)}`);
    process.exitCode = 2;
  } else if (stuck.states.c !== 'running') {
    console.error(`INCONCLUSIVE: c 在超时后应为 running，实际 ${stuck.states.c}`);
    process.exitCode = 2;
  } else {
    // 01 c 还在 running，跨 SCC 依赖的 a 不受环豁免保护 ⇒ 一次都不许被停。
    check('01', '跨 SCC 活依赖：c 卡住时 a 一次都不被停，且仍 running',
      !stuck.calls.includes('a') && stuck.states.a === 'running',
      `实际调用序列：${JSON.stringify(stuck.calls)}，a=${stuck.states.a}，c=${stuck.states.c}，cycles=${JSON.stringify(cycles)}`);

    // 02 跳过必须具名，且与失败分开。
    const skipped = stuck.payload?.stopSkipped ?? [];
    const named = skipped.find((s) => s.plugin === 'a');
    check('02', '跳过具名交出（skipped_dependents_pending / dependents=[c]）且不混进 stopFailures',
      Boolean(named) && named.code === 'skipped_dependents_pending' && (named.dependents ?? []).includes('c')
        && !(stuck.payload?.stopFailures ?? []).some((f) => f.plugin === 'a'),
      `stopSkipped=${JSON.stringify(skipped)}，stopFailures=${JSON.stringify((stuck.payload?.stopFailures ?? []).map((f) => f.plugin))}`);

    // 03 正控：同一张图、c 不卡 ⇒ 四个全停、零跳过。
    const normal = await run(GRAPH.map((p) => ({ ...p, hang: false })), 'normal');
    check('03', '正控：同一张图但 c 正常停止 ⇒ 四个全停、零跳过',
      JSON.stringify(normal.calls.slice().sort()) === JSON.stringify(['a', 'b', 'c', 'd'])
        && (normal.payload?.stopSkipped ?? []).length === 0,
      `实际调用序列：${JSON.stringify(normal.calls)}，stopSkipped=${JSON.stringify(normal.payload?.stopSkipped ?? [])}`);
  }
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
}

for (const r of results) {
  console.log(`${r.status === 'FIXED' ? 'FIXED' : 'OPEN '}  R15-01/${r.id}  ${r.title}`);
  console.log(`        ${r.detail}`);
}
const open = results.filter((r) => r.status !== 'FIXED').length;
if (results.length) console.log(`\nR15-01 跨 SCC 环豁免：${results.length - open}/${results.length} FIXED`);
if (results.length && open === 0) process.exitCode = 0;
else if (results.length) process.exitCode = 1;
