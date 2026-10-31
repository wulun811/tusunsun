#!/usr/bin/env node
/**
 * verification/counterexamples/r15-02-public-reaper.mjs
 *
 * 专家 rc.15 独立复审的 R15-02：**公开面在签发“管理员证件”**。
 *
 * 缺陷形状：`issueLifecycleReaper()` 是公开方法，每调一次就返回一个可执行的清场闭包；
 * 而 `core.plugins` 是公开 Map。于是“要传真实 instance”这条要求根本不是授权条件 ——
 * `core.plugins.get('victim')` 取到实例，再 `reaper('victim', instance)`，victim 的能力与
 * 服务一次清空，插件还留在表里。
 *
 * 三条判据：
 *   01 公共签发入口必须消失（`typeof core.issueLifecycleReaper === 'undefined'`）。
 *      若还在，就在这里把专家脚本的攻击原样再跑一遍，让证据自己说话。
 *   02 正控：**合法生命周期收尾**仍能精确回收自己那份，且不误删别人的 ——
 *      否则“清场整个关掉”也能让 01 变绿。
 *   03 残余披露（不记作通过）：`core.lifecycle._reap` 仍然可达。纯 JS 单进程不保证
 *      恶意代码改不了私有表，本 RC 只保证**受管 API 入口**的纪律；要封闭这一类
 *      需进程边界，不在本版范围。这一条必须打印出来，不能靠“探针绿了”把它藏掉。
 *
 * 跑：node verification/counterexamples/r15-02-public-reaper.mjs
 * 退出码 0 = 01/02 FIXED；1 = 仍有反例。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const { Core } = await import(join(ROOT, 'src/core/core.js'));

const tmp = mkdtempSync(join(tmpdir(), 'r15-02-'));
const results = [];
const check = (id, title, ok, detail) => results.push({ id, title, status: ok ? 'FIXED' : 'OPEN', detail });
let residual = null;

try {
  const core = new Core({ stateDir: join(tmp, 'state') });
  core.log = () => {};
  await core.register({
    name: 'victim', version: '1.0.0',
    async init(c) {
      c.registerService('secret-service', { who: 'victim' });
      c.registerCapability('victim.cap', { owner: 'victim', handler: async () => 42 });
    },
    async start() {}, async stop() {},
  });
  await core.register({
    name: 'other', version: '1.0.0',
    async init(c) { c.registerService('other-service', { who: 'other' }); },
    async start() {}, async stop() {},
  });
  await core.start();

  // ── 01 公开签发入口必须消失；若还在，就把专家脚本的攻击原样跑一遍 ──────
  const hasFactory = typeof core.issueLifecycleReaper === 'function';
  let attack = null;
  if (hasFactory) {
    const stolen = core.plugins.get('victim');           // 公开 Map，任何人都拿得到
    const reaped = core.issueLifecycleReaper()('victim', stolen);
    attack = { reaped, serviceGone: !core.getServiceOwnership('secret-service').registered };
  }
  check('01', '公开的清场签发入口必须从受管 API 面消失',
    !hasFactory,
    hasFactory
      ? `仍存在：core.issueLifecycleReaper() 一次调用即返回清场闭包，实测 ${JSON.stringify(attack)}`
      : 'issueLifecycleReaper 已从公开面移除；清场闭包只在 Core 构造期注入给 core.lifecycle 一次');

  // ── 02 正控：合法卸载仍精确回收 ─────────────────────────────────────
  await core.lifecycle.unload('victim');
  const ownGone = !core.getServiceOwnership('secret-service').registered;
  const otherAlive = core.getServiceOwnership('other-service').registered;
  const capGone = !core.listCapabilities().some((x) => x.id === 'victim.cap');
  check('02', '正控：合法卸载精确回收自己的服务/能力，且不误删别人',
    ownGone && otherAlive && capGone,
    `secret-service 已回收=${ownGone}，victim.cap 已回收=${capGone}，other-service 仍在=${otherAlive}`);

  // ── 03 残余披露（不记作通过）────────────────────────────────────────
  const reachable = typeof core.lifecycle?._reap === 'function';
  residual = {
    reachable,
    path: 'core.lifecycle._reap(name, core.plugins.get(name))',
    note: reachable
      ? '注入实例上的 _reap 字段仍可直接调用（单测要拿它验“@host 拆不走”）。'
        + '这是同进程内部方法可达性，不是受管 API 入口；本 RC 不宣称进程隔离。'
      : '不可达',
  };
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
}

for (const r of results) {
  console.log(`${r.status === 'FIXED' ? 'FIXED' : 'OPEN '}  R15-02/${r.id}  ${r.title}`);
  console.log(`        ${r.detail}`);
}
if (residual) {
  console.log(`RESIDUAL（不记作通过）  同进程仍可达：${residual.path} = ${residual.reachable}`);
  console.log(`        ${residual.note}`);
}
const open = results.filter((r) => r.status !== 'FIXED').length;
console.log(`\nR15-02 清场签发入口：${results.length - open}/${results.length} FIXED`);
process.exitCode = open === 0 ? 0 : 1;
