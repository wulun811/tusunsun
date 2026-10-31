#!/usr/bin/env node
/**
 * verification/counterexamples/r15-03-same-owner-forgery.mjs
 *
 * 专家 rc.15 独立复审的 R15-03：**自报 owner 参与了授权**。
 *
 * 缺陷形状：`runServiceTracking(owner, fn)` 是公开入口且 store 是 `trusted:false`，
 * 而 `_commitService` 的“同 owner 更新”分支只看 `claimant === prevOwner` 字符串相等。
 * 于是 `runServiceTracking('victim', () => registerService('db', …))` 就能把 victim 的
 * 服务换掉，而归属记录还写着 victim。
 *
 * 三条判据：
 *   01 冒名必须被具名拒（`service_conflict`），对象、归属、登记号三样都不许变。
 *   02 正控 1：同一插件在自己的受信装配里（init 登记、start 更新）**仍可**更新 ——
 *      否则“一律禁止更新”也能让 01 变绿。
 *   03 正控 2：宿主控制面接管**仍可**（另一条授权通道，不是同 owner 更新）。
 *
 * 口径：这是受管 API 的权属纪律，不是“同进程恶意 JS 已被隔离”。
 * 跑：node verification/counterexamples/r15-03-same-owner-forgery.mjs
 * 退出码 0 = 全 FIXED；1 = 仍有反例。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const mod = await import(join(ROOT, 'src/core/core.js'));
const { Core } = mod;

const tmp = mkdtempSync(join(tmpdir(), 'r15-03-'));
const results = [];
const check = (id, title, ok, detail) => results.push({ id, title, status: ok ? 'FIXED' : 'OPEN', detail });
const codeOf = (fn) => { try { fn(); return null; } catch (e) { return e?.code ?? `(no code) ${e?.message}`; } };

const newCore = (tag) => {
  const core = new Core({ stateDir: join(tmp, `state-${tag}`) });
  core.log = () => {};
  return core;
};

try {
  // ── 01 冒名：公开 tracking owner 不得成为授权 ─────────────────────────
  {
    const core = newCore('forge');
    await core.register({
      name: 'victim', version: '1.0.0',
      async init(c) { c.registerService('db', { who: 'victim' }); },
      async start() {}, async stop() {},
    });
    await core.start();
    const before = core.getServiceOwnership('db');
    let code = null;
    await core.runServiceTracking('victim', async () => {
      code = codeOf(() => core.registerService('db', { who: 'attacker' }));
    });
    const after = core.getServiceOwnership('db');
    check('01', '自报 tracking owner 的同名覆盖必须被具名拒绝，且三样都不变',
      code === 'service_conflict'
        && core.getService('db')?.who === 'victim'
        && after.owner === 'victim'
        && after.registrationId === before.registrationId,
      `code=${code}，who=${core.getService('db')?.who}，owner=${after.owner}，registrationId ${before.registrationId}→${after.registrationId}`);
  }

  // ── 02 正控 1：同一插件在自己的受信装配里更新自己那笔 ────────────────
  {
    const core = newCore('legit');
    let handle = null;
    await core.register({
      name: 'victim', version: '1.0.0',
      async init(c) { handle = c; c.registerService('db', { who: 'v1' }); },
      async start() { handle.registerService('db', { who: 'v2' }); },
      async stop() {},
    });
    await core.start();
    check('02', '正控：同一装配实例更新自己那笔服务仍然允许',
      core.getService('db')?.who === 'v2',
      `who=${core.getService('db')?.who}（期望 v2）`);
  }

  // ── 03 正控 2：宿主控制面接管仍可 ─────────────────────────────────
  {
    const runtime = mod.createRuntime ? mod.createRuntime({ stateDir: join(tmp, 'state-host') }) : null;
    if (!runtime) {
      check('03', '正控：宿主控制面仍可跨 owner 接管', false, 'createRuntime 未导出，无法验证 —— 不记作通过');
    } else {
      const { core, host } = runtime;
      core.log = () => {};
      await core.register({
        name: 'victim', version: '1.0.0',
        async init(c) { c.registerService('db', { who: 'victim' }); },
        async start() {}, async stop() {},
      });
      await core.start();
      await host.takeoverService('db', { who: 'host' });
      check('03', '正控：宿主控制面仍可跨 owner 接管',
        core.getService('db')?.who === 'host' && core.getServiceOwnership('db').owner === '@host',
        `who=${core.getService('db')?.who}，owner=${core.getServiceOwnership('db').owner}`);
    }
  }
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
}

for (const r of results) {
  console.log(`${r.status === 'FIXED' ? 'FIXED' : 'OPEN '}  R15-03/${r.id}  ${r.title}`);
  console.log(`        ${r.detail}`);
}
const open = results.filter((r) => r.status !== 'FIXED').length;
console.log(`\nR15-03 同 owner 冒名覆盖：${results.length - open}/${results.length} FIXED`);
process.exitCode = open === 0 ? 0 : 1;
