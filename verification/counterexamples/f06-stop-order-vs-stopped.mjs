#!/usr/bin/env node
/**
 * verification/counterexamples/f06-stop-order-vs-stopped.mjs
 *
 * F06 的实现反例：**顺序 ≠ 停在**。这不是专家矩阵里的条目，是 rc.15 建
 * `model/Dependency.tla` 时撞出来的（突变体 `m15-release-under-stuck-dependent`）。
 *
 * 为什么放在 `counterexamples/` 而不在 `test/probes/`：
 * `test/probes/` 是发布门禁跑的目录，跑的是「当前必须绿」的探针；
 * 本文件是「曾经坏过、现在已修」的证据链，两种东西不该混在一个目录里
 * （F05 的 `f05-host-takeover.mjs` 同理）。
 *
 * 三条判据（判据固定，换的是被测行为）：
 *   01 修前形状必须能被复现：依赖方 stop() 卡住 ⇒ 若不查依赖方，提供方会被停掉。
 *      这里不真去改源码，而是用**同一个 Core** 跑两种情况，把"该拦住的拦住了"证出来。
 *   02 攻击面：依赖方卡住时，提供方**一次都不许被停**，且必须仍在 running。
 *   03 正控：依赖方正常停时，提供方**必须照常停** —— 否则 02 可能只是"什么都不停"。
 *      没有 03，把停机整体关掉也能让 02 变绿。
 *
 * 跑：node verification/counterexamples/f06-stop-order-vs-stopped.mjs
 * 退出码 0 = 三条都 FIXED；非 0 = 仍有反例或证据不足。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const { Core } = await import(join(ROOT, 'src/core/core.js'));

let tmp = mkdtempSync(join(tmpdir(), 'f06-ce-'));
const mk = (name, extra = {}) => ({
  name, version: '1.0.0',
  async init() {}, async start() {},
  async stop() {
    if (extra.hang) await new Promise(() => {});   // 永不返回：模拟卡死的收尾
  },
  ...(extra.provides ? { provides: extra.provides } : {}),
  ...(extra.requires ? { requires: extra.requires } : {}),
});

/** 跑一台 Core 直到停机完成，返回载荷 + 真实被调用过 stop 的插件名 + 终态。 */
async function run(plugins, tag) {
  const calls = [];
  const wrapped = plugins.map((p) => {
    const base = mk(p.name, p);
    return {
      ...base,
      async stop() {
        calls.push(p.name);
        if (p.hang) await new Promise(() => {});
      },
    };
  });
  const core = new Core({ stateDir: join(tmp, `state-${tag}`) });
  core.log = () => {};
  core._stopAssemblyDrainMs = 20;
  core._stopLockMs = 120;              // 让超时快速发生，不为一条证据等 30 秒
  for (const p of wrapped) await core.register(p);
  await core.start();
  let payload = null;
  core.on('core.stopped', (p) => { payload = p; });
  await core.stop();
  const states = {};
  for (const p of plugins) states[p.name] = core.plugins.get(p.name)?.state ?? null;
  return { payload, calls, states };
}

const results = [];
const check = (id, title, ok, detail) => {
  results.push({ id, title, status: ok ? 'FIXED' : 'COUNTEREXAMPLE', detail });
};

try {
  // ── 01/02 依赖方卡住：提供方不得被停 ────────────────────────────────
  const stuck = await run([
    { name: 'base', provides: ['base-svc'] },
    { name: 'dependent', requires: { 'base-svc': '*' }, hang: true },
  ], 'stuck');
  const stopCalls = JSON.stringify(stuck.calls);
  check('01', '依赖方卡住时，提供方的 stop() 一次都不许被调用',
    stopCalls === JSON.stringify(['dependent']), `实际调用序列：${stopCalls}`);
  check('02', '卡住的依赖方与它的提供方都必须仍在 running（没被拆）',
    stuck.states.dependent === 'running' && stuck.states.base === 'running',
    `dependent=${stuck.states.dependent} base=${stuck.states.base}`);

  // ── 03 正控：依赖方正常停 ⇒ 提供方照常停（没有这条，02 可能只是"什么都不停"）
  const normal = await run([
    { name: 'base', provides: ['base-svc'] },
    { name: 'dependent', requires: { 'base-svc': '*' } },
  ], 'normal');
  const normalCalls = JSON.stringify(normal.calls);
  check('03', '正控：依赖方正常停止时，提供方照常停（顺序 dependent → base）',
    normalCalls === JSON.stringify(['dependent', 'base'])
      && normal.states.base === 'stopped'
      && (normal.payload?.stopSkipped ?? []).length === 0,
    `实际调用序列：${normalCalls}，base=${normal.states.base}，stopSkipped=${JSON.stringify(normal.payload?.stopSkipped ?? [])}`);
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
}

for (const r of results) {
  console.log(`${r.status === 'FIXED' ? 'FIXED' : 'OPEN '}  F06-${r.id}  ${r.title}`);
  console.log(`        ${r.detail}`);
}
const open = results.filter((r) => r.status !== 'FIXED').length;
console.log(`\nF06 停机次序 vs 停在：${results.length - open}/${results.length} FIXED`);
process.exitCode = open === 0 ? 0 : 1;
