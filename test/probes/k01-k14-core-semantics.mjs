// K-01～K-14 独立探针：2222 行微内核六语义反例的**可独立运行复现**。
//
// 为什么要有这个文件（而不是只写在报告里）：
//   专家计划 v1.0 的 P0 退出门槛是"旧实现至少在目标反例上复现红色；无法复现应如实
//   NOT_REPRODUCED"。一份"我读过代码所以它有问题"的结论，与一份"你敲一行命令就能自己
//   看到它红"的证据，强度完全不同。前者不可复核，后者可以。
//
// 与回归锁的分工：
//   · 本文件：不依赖测试框架、不 import harness，**直白打印 BUG / FIXED / NOT_REPRODUCED**，
//     给人工核对用。修好之后同一条仍然会被执行到，并显示 FIXED。
//   · 将来的 `test/unit/test-k-*.test.mjs`：走 harness、断言细、跟 CI 跑（P0/P1 阶段落地）。
//
// 用法：
//   node test/probes/k01-k14-core-semantics.mjs          # 全部跑
//   node test/probes/k01-k14-core-semantics.mjs K-02     # 只跑一条（可多次传）
//
// 前置条件（缺了会显示 NOT_REPRODUCED，**不会**显示 FIXED）：
//   · 本文件必须在含 `src/core/` 的树里跑（它 import 相对路径的 Core）。
//   · K-03b 额外需要 `plugins/readiness.js` —— 它构造的是"Core 宣告 ready 而 readiness
//     同时说 unavailable"这一对矛盾；缺该插件时该条会显式阻断（实测净室里正是这一条）。
//   · K-14 是纯源码判据，`src/core/plugin-manager.js` 在场即可。
//   · 另注：`src/core/` **无法脱离 `plugins/` 单独加载**（K-14 的直接后果）。把 `src/core/`
//     单独拷走会 ERR_MODULE_NOT_FOUND —— 那是被测缺陷本身，不是探针搭错了。
//
// 退出码（**故意与直觉相反**，与既有 r0-159 探针保持同一约定）：
//   0 = 全部 FIXED 且无 NOT_REPRODUCED（缺陷已关闭，且每条都真的被验证过）
//   1 = 至少一条仍是 BUG，**或**至少一条前置条件不满足（不足以判定已修）
//   2 = 用法错误
//
// 诚实边界：
//   · 本文件只探"内核自身能观测到的行为"，不探外部副作用是否真的落盘（每条的副作用断言
//     都写在注释里，指向将来的回归锁）。
//   · 全部在临时目录里跑，不碰真实工作区；每条自带超时；结尾 process.exit 防止
//     LifecycleManager/idle timer 之类的句柄把进程挂住。
//   · 基线：v0.11.0。`src/core/` 与 v0.10.4 发行包**逐字节相同**（可用 `diff -r` 复核），
//     所以专家以 0.10.4 为基线写下的 13 条，在 0.11.0 上一条都没有被顺带修掉。

import { Core } from '../../src/core/core.js';
import { LifecycleManager } from '../../src/core/lifecycle-manager.js';
import { SceneController } from '../../src/core/scene-controller.js';
import { PluginManager } from '../../src/core/plugin-manager.js';
import { semverSatisfies } from '../../src/core/dependency-resolver.js';
import { loadJson5 } from '../../src/core/json5-loader.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
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
  return t;
}

function makeCore(t, extra = {}) {
  return new Core({ stateDir: t, pluginsDir: join(t, 'plugins'), ...extra });
}

/** 写一个"类字段风格 + 实例导出"的插件（懒加载索引只认这种形态，见 plugin-meta.js）。 */
function writePlugin(t, file, { name, version = '1.0.0', provides = [], requires = null, body, manifest = null }) {
  const p = join(t, 'plugins', file);
  const man = manifest ? `\n  manifest = ${JSON.stringify(manifest)};` : '';
  const req = requires ? `\n  requires = ${JSON.stringify(requires)};` : '';
  writeFileSync(p, `class P {
  name = '${name}';
  version = '${version}';
  provides = ${JSON.stringify(provides.map((n) => ({ name: n })))};${req}${man}
${body}
}
export default new P();
`);
  return p;
}

// 结果收集：每条 = { id, title, verdict, detail }
const results = [];

function record(id, title, isBug, detail) {
  results.push({ id, title, verdict: isBug ? 'BUG' : 'FIXED', detail });
}

/**
 * 包一层：任何异常都记成 NOT_REPRODUCED（既不是 BUG 也不是 FIXED），避免探针自身崩掉整轮。
 *
 * v0.11.0 修正（自查发现的一处**假绿**）：探针函数可以返回 `{ blocked: '原因' }`，
 * 表示**前置条件不满足**，此时不得算 FIXED。
 *
 * 为什么必须区分：这个探针可以被复制到任何目录单独跑。K-03b 依赖 `plugins/readiness.js`，
 * 若那个文件不在，`core.getService('readiness')` 返回 undefined，
 * 原来的判据 `ready !== null && status?.status === 'unavailable'` 退化成 false ⇒ 打印 **FIXED**。
 * 于是"没装前置条件"被读成了"缺陷已修复"—— 这正是本项目反复记录的**判据空转**，
 * 而这次空转出现在我自己的探针里，且是在净室里才暴露的（在仓库里跑永远看不到）。
 */
async function probe(id, title, fn) {
  try {
    const r = await fn();
    if (r && r.blocked) {
      results.push({ id, title, verdict: 'NOT_REPRODUCED', detail: `前置条件不满足：${r.blocked}` });
      return;
    }
    record(id, title, r.bug, r.detail);
  } catch (err) {
    results.push({ id, title, verdict: 'NOT_REPRODUCED', detail: `探针本身失败：${err?.message || err}` });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// K-01 非 TTY 下需人工确认却自动同意
//
// 语义位置：A 权属 + C 合同 + R 失效收敛 —— 这既不是"配置读错了"，也不是"策略没生效"，
// 而是**危险默认**：无人在场时，系统替人做了"同意"的决定。
// ───────────────────────────────────────────────────────────────────────────
await probe('K-01', '非 TTY 下需人工确认却自动同意', async () => {
  const t = sandbox('k01');
  const core = makeCore(t);
  // **前置条件**：必须真的要求人工确认，否则走的是"无需确认"分支（那条自动同意是对的）。
  // 修前的探针没设这一项，于是它测的是 `actionTypes.length === 0` 的合法路径 ——
  // 也就是说旧探针对 K-01 的判据本身不成立。这类"判据没测到目标分支"的错，
  // 和我文档里反复记的判据空转是同一族。
  core._services.set('config', {
    get: (k, d) => (k === 'privacy.requireConfirmFor' ? ['delete'] : d),
    set() {},
  });
  // 模拟最典型的无头环境：stdin 不是 TTY（CI / 守护进程 / 管道）
  const saved = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  let approved;
  try {
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    approved = await core.confirm('即将删除 /tmp/x（不可撤销）', 40);
  } finally {
    if (saved) Object.defineProperty(process.stdin, 'isTTY', saved);
    else delete process.stdin.isTTY;
  }
  return {
    bug: approved === true,
    detail: `已要求人工确认（requireConfirmFor=['delete']）+ 无 TTY + 无可信批准来源，`
      + `confirm() 返回 ${approved}（期望：拒绝或明确请求授权，不得默认 true）`,
  };
});

// ───────────────────────────────────────────────────────────────────────────
// K-02 command 超时返回后物理 handler 仍在跑，而在途计数已归零
//
// 这是六语义里 I（调用）的核心错误：**等待事实**被当成了**执行事实**。
// 连带后果（本探针同时验证）：v0.10.0 给 _reloadPlugin 加的在途闸门形同不存在 ——
// 因为闸门读的就是那个被提前归零的计数。
// ───────────────────────────────────────────────────────────────────────────
await probe('K-02', 'command 超时后在途归零，但 handler 仍在运行（并击穿重载闸门）', async () => {
  const t = sandbox('k02');
  const core = makeCore(t);
  let handlerFinished = false;
  core.registerCapability('slow.cap', {
    handler: async () => {
      await new Promise((r) => setTimeout(r, 140));
      handlerFinished = true;
      return 'done';
    },
  });
  const res = await core.command('slow.cap', {}, 15);       // 15ms 等候，140ms 真实执行
  const inflightAtReturn = core.getInflight('unknown');      // 此刻 handler 确定仍在跑
  const stillRunningAtReturn = !handlerFinished;
  await new Promise((r) => setTimeout(r, 200));
  const inflightAfterSettle = core.getInflight('unknown');

  const bug = stillRunningAtReturn && inflightAtReturn === 0;
  return {
    bug,
    detail: `返回 ${res.state}/${res.code}；返回瞬间 handler 仍在跑=${stillRunningAtReturn}，`
      + `getInflight=${inflightAtReturn}（期望 ≥1，因为它确实在跑）；结算后=${inflightAfterSettle}`,
  };
});

await probe('K-02b', 'K-02 × 重载闸门：超时归零后 reload 在 handler 仍在跑时"安全成功"', async () => {
  const t = sandbox('k02b');
  const f = writePlugin(t, 'slowp.mjs', {
    name: 'slowp',
    provides: ['slowp.work'],
    body: `  async init(core) { this.core = core; }
  start() {}
  async work() { await new Promise(r=>setTimeout(r,200)); return 'DONE'; }`,
  });
  const core = makeCore(t);
  const pm = new PluginManager(core);
  pm.dirs = [join(t, 'plugins')];
  await pm.loadAll(['slowp'], []);
  await core.start();
  core.registerCapability('slowp.work', {
    owner: 'slowp',
    handler: async () => { await new Promise((r) => setTimeout(r, 200)); return 'DONE'; },
  });
  const cmd = await core.command('slowp.work', {}, 20);
  const inflightAtReturn = core.getInflight('slowp');
  const rr = await pm._reloadPlugin('slowp', f, 'probe');
  await new Promise((r) => setTimeout(r, 300));
  const bug = inflightAtReturn === 0 && rr.ok === true;
  return {
    bug,
    detail: `超时返回 inflight=${inflightAtReturn}，随后 reload ok=${rr.ok} code=${rr.code ?? '(none)'}`
      + `（期望：inflight>0 ⇒ 拒绝替换，返回 reload_busy）`,
  };
});

// ───────────────────────────────────────────────────────────────────────────
// K-03 必需初始化失败仍发 core.ready
//
// 补强：本探针同时证明"同一进程内对同一事实存在两句互相矛盾的话"——
// Core 宣布 ready，而 readiness 服务同时宣布 UNAVAILABLE。
// ───────────────────────────────────────────────────────────────────────────
await probe('K-03', '必需插件 init 失败后仍宣告 core.ready', async () => {
  const t = sandbox('k03');
  const core = makeCore(t);
  let ready = null;
  core.on('core.ready', (p) => { ready = p; });
  // **前置条件**：插件必须声明自己是必需的（degraded_policy='block_startup'）。
  // 修前的探针没声明，于是它测的是"optional 插件失败"——那种情况宣告 ready 是**对的**，
  // 判据本身不成立（和 K-01 第一版是同一类错）。
  await core.register({
    name: 'crit', version: '1.0.0',
    manifest: { degraded_policy: 'block_startup' },
    init: async () => { throw new Error('critical init exploded'); },
  });
  await core.start();
  const state = core.plugins.get('crit')?.state;
  // 判据（v0.12.0 定）：**不是**"不发 ready"，而是"ready 的载荷必须具名 unavailable"。
  // 为什么不干脆不发：不发会让所有挂在 core.ready 上初始化的插件在失败场景彻底不执行，
  // 反而更难诊断。这是判断，已登记 ADR-05。
  const namedUnavailable = ready?.status === 'unavailable'
    && Array.isArray(ready?.requiredFailed) && ready.requiredFailed.includes('crit');
  return {
    bug: !namedUnavailable,
    detail: `插件 state=${state}；core.ready status=${JSON.stringify(ready?.status)}`
      + ` requiredFailed=${JSON.stringify(ready?.requiredFailed ?? null)}`
      + '（期望：status=unavailable 且 requiredFailed 含 crit）',
  };
});

await probe('K-03b', 'core.ready 与 readiness 服务对同一事实给出两种矛盾结论', async () => {
  const t = sandbox('k03b');
  const core = makeCore(t);
  const pm = new PluginManager(core);
  pm.dirs = [join(ROOT, 'plugins'), join(t, 'plugins')];
  writePlugin(t, 'crit.mjs', {
    name: 'crit',
    provides: ['crit'],
    manifest: {
      schema_version: 'tusunsun.plugin/v2', name: 'crit', version: '1.0.0', api_version: '1',
      owner: 'probe', provides: [{ service: 'crit', api_version: '1.0.0' }], requires: [],
      surfaces: ['internal'], degraded_policy: 'block_startup',
    },
    body: `  async init() { throw new Error('critical init exploded'); }`,
  });
  await pm.loadAll(['readiness', 'runtime-env', 'crit'], []);
  let ready = null;
  core.on('core.ready', (p) => { ready = p; });
  await core.start();
  const rd = core.getService('readiness');
  // 前置条件：readiness 插件必须在场。它缺席时 `status` 为 null，旧判据会退化成
  // "没有矛盾" ⇒ 误报 FIXED。这里显式阻断，让"缺前置"显示为 NOT_REPRODUCED。
  if (!rd) return { blocked: 'plugins/readiness.js 不在搜索路径（本探针需在含 plugins/ 的树里跑）' };
  const status = rd.status();
  // 单看 ready 还不够：必须同时看到 readiness 说 unavailable，才构成"两句矛盾的话"
  if (status.status !== 'unavailable') {
    return { blocked: `readiness 未判 unavailable（实为 ${status.status}），无法构造矛盾场景` };
  }
  // 判据（v0.12.0 定）：不是"不发 ready"，而是"**两者对同一事实必须说同一句话**"。
  // 修前 core.ready 只说 `plugins: N`（读起来像一切正常），而 readiness 说 unavailable。
  // 修后 core.ready 带 status，两者应当一致。
  const coreSaid = ready?.status ?? null;
  const bug = coreSaid !== status.status;
  return {
    bug,
    detail: `core.ready status=${JSON.stringify(coreSaid)}`
      + ` vs readiness.status()=${status.status}`
      + ` criticalFailed=${JSON.stringify(status.criticalFailed ?? null)}`
      + '（期望：两者一致；一致才叫"同一个事实只有一个说法"）',
  };
});

// ───────────────────────────────────────────────────────────────────────────
// K-04 场景插件不存在仍 ok:true 并提交场景
// ───────────────────────────────────────────────────────────────────────────
await probe('K-04', '场景声明的插件不存在，switchTo 仍返回 ok:true 并提交 currentScene', async () => {
  const t = sandbox('k04');
  const core = makeCore(t);
  const pm = new PluginManager(core);
  pm.dirs = [join(t, 'plugins')];
  const sc = new SceneController(core, pm);
  // 直接给一个"声明了不存在的插件"的场景：绕开 findScene 的文件发现，只验装配与提交判据
  sc.findScene = async () => ({ name: 'needit', plugins: [], eager: ['does-not-exist'], optional: [] });
  const r = await sc.switchTo('needit', { yes: true });
  const registered = core.plugins.has('does-not-exist');
  const bug = r.ok === true && !registered && sc.currentScene === 'needit';
  return {
    bug,
    detail: `ok=${r.ok} currentScene=${sc.currentScene} 插件已注册=${registered}`
      + '（期望：缺必需插件 ⇒ ok:false 且不提交场景）',
  };
});

// ───────────────────────────────────────────────────────────────────────────
// K-05 重载后实际可运行，状态却是 registered（而不是 running）
// ───────────────────────────────────────────────────────────────────────────
await probe('K-05', '重载后插件实际可用，但 state 停在 registered', async () => {
  const t = sandbox('k05');
  const f = writePlugin(t, 'hot.mjs', {
    name: 'hot',
    provides: ['hot.work'],
    body: `  async init(core) { this.core = core; }
  start() {}
  work() { return 'V1'; }`,
  });
  const core = makeCore(t);
  const pm = new PluginManager(core);
  pm.dirs = [join(t, 'plugins')];
  await pm.loadAll(['hot'], []);
  await core.start();
  const before = core.plugins.get('hot')?.state;
  const rr = await pm._reloadPlugin('hot', f, 'probe');
  const plugin = core.plugins.get('hot');
  const after = plugin?.state;
  const usable = typeof plugin?.work === 'function';
  const bug = rr.ok === true && usable && after === 'registered';
  return {
    bug,
    detail: `before=${before} reloadOk=${rr.ok} after=${after} 可调用 work()=${usable}`
      + '（期望：重载成功后 state=running；生命周期冻结依赖该状态）',
  };
});

// ───────────────────────────────────────────────────────────────────────────
// K-06 同 owner override 时省略 schema 会静默失去旧约束
//
// 注意：`permissions` 这一列在 v0.9.32 已修（R0-151，未声明字段继承）。本探针显示
// **同一类缺陷在 input_schema / output_schema / tags 上仍然存在** —— 修了一列，漏了其余。
// ───────────────────────────────────────────────────────────────────────────
await probe('K-06', '同 owner override 省略 input_schema 时静默丢失旧约束', async () => {
  const t = sandbox('k06');
  const core = makeCore(t);
  const h1 = core.registerCapability('x.cap', {
    owner: 'o', handler: () => 1,
    input_schema: { required: ['a'], properties: { a: { type: 'string' } } },
    permissions: { require_identity: true },
  });
  // S6 裁决 A 之后，“同 owner 字符串”不再构成覆盖授权（ID-07）：覆盖必须持那笔登记的
  // 凭据 `overrideBy`。本探针要证的性质没变 —— “override 时省略 schema 不得静默丢掉
  // 旧约束” —— 只是入口从 owner 字符串换成登记句柄。
  core.registerCapability('x.cap', { owner: 'o', handler: () => 2, override: true, overrideBy: h1 });
  const rec = core._capabilities.get('x.cap');
  const schemaLost = rec.input_schema === undefined;
  const permsKept = rec.permissions?.require_identity === true;
  return {
    bug: schemaLost,
    detail: `override 后 input_schema=${JSON.stringify(rec.input_schema)}（丢失=${schemaLost}）`
      + `，permissions 保留=${permsKept}（v0.9.32 只修了 permissions 这一列）`,
  };
});

// ───────────────────────────────────────────────────────────────────────────
// K-07 结构化 schema 面对 null / 字符串漏校验
// ───────────────────────────────────────────────────────────────────────────
await probe('K-07', '声明了 required+type 的能力，params=null 或 string 直接放行', async () => {
  const t = sandbox('k07');
  const core = makeCore(t);
  let ran = 0;
  core.registerCapability('y.cap', {
    handler: () => { ran++; return 'ran'; },
    input_schema: { required: ['a'], properties: { a: { type: 'string' } } },
  });
  const rNull = await core.callCapability('y.cap', null);
  const rStr = await core.callCapability('y.cap', 'not-an-object');
  const bug = ran > 0;
  return {
    bug,
    detail: `params=null → ${rNull.ok ? 'RAN（副作用已发生）' : rNull.code}；`
      + `params='not-an-object' → ${rStr.ok ? 'RAN（副作用已发生）' : rStr.code}；`
      + `handler 实际执行 ${ran} 次（期望 0）`,
  };
});

// ───────────────────────────────────────────────────────────────────────────
// K-08 事件式 command 超时残留 .error 监听器
// ───────────────────────────────────────────────────────────────────────────
await probe('K-08', '事件式 command 每次超时都遗留一个 .error 监听器', async () => {
  const t = sandbox('k08');
  const core = makeCore(t);
  // 事件名必须含 "."（core.emit 有格式校验），否则连 emit 都被拒绝，探针会误判为"无泄漏"
  const before = { response: core.listenerCount('ghost.work.response'), error: core.listenerCount('ghost.work.error') };
  for (let i = 0; i < 5; i++) await core.command('ghost.work', {}, 5);
  const after = { response: core.listenerCount('ghost.work.response'), error: core.listenerCount('ghost.work.error') };
  const leak = after.error - before.error;
  return {
    bug: leak > 0,
    detail: `5 次超时后 .response=${after.response}（增 ${after.response - before.response}）、`
      + `.error=${after.error}（增 ${leak}）（期望两者都增 0）`,
  };
});

// ───────────────────────────────────────────────────────────────────────────
// K-09 停止时先停 provider，再停 dependent
// ───────────────────────────────────────────────────────────────────────────
await probe('K-09', 'Core.stop() 按注册顺序停止，先停 provider 再停 dependent', async () => {
  const t = sandbox('k09');
  const core = makeCore(t);
  const order = [];
  await core.register({
    name: 'provider-p', version: '1.0.0', init: async () => {}, start: async () => {},
    stop: async () => { order.push('provider-p'); },
  });
  await core.register({
    name: 'dependent-d', version: '1.0.0', requires: { 'provider-p': '^1.0.0' },
    init: async () => {}, start: async () => {}, stop: async () => { order.push('dependent-d'); },
  });
  await core.start();
  await core.stop();
  // 期望：dependent-d 先退出，provider-p 后退出
  const bug = order[0] === 'provider-p';
  return {
    bug,
    detail: `实际顺序 ${order.join(' → ')}（期望 dependent-d → provider-p）`,
  };
});

// ───────────────────────────────────────────────────────────────────────────
// K-10 懒加载请求超时，实际加载迟到成功且状态不可解释
// ───────────────────────────────────────────────────────────────────────────
await probe('K-10', '懒加载等候超时后迟到成功：无人能查询它的真实结果', async () => {
  const t = sandbox('k10');
  writePlugin(t, 'slowly.mjs', {
    name: 'slowly',
    provides: ['slowly.work'],
    body: `  async init(core) { this.core = core; await new Promise(r=>setTimeout(r,90)); }
  start() {}
  work() { return 'LATE-OK'; }`,
  });
  const core = makeCore(t);
  const pm = new PluginManager(core);
  pm.dirs = [join(t, 'plugins')];
  await pm.loadAll([], ['slowly']);
  const indexed = pm._pending.has('slowly');

  let waiterErr = null;
  const real = pm._lazyLoadOne('slowly');
  try {
    await Promise.race([real, new Promise((_, rj) => setTimeout(() => rj(new Error('waiter-timeout 20ms')), 20))]);
  } catch (e) { waiterErr = e.message; }
  await new Promise((r) => setTimeout(r, 300));      // 等迟到的那次真正完成

  const plugin = core.plugins.get('slowly');
  const loaded = plugin?.state;                       // running = 迟到成功发生了
  // 是否存在**任何**可查询的句柄，能回答"刚才那次超时的加载最后怎样了"
  const queryable = typeof pm.describeLazyLoad === 'function' || typeof pm.lastLoadOutcome === 'function';
  return {
    bug: indexed && waiterErr !== null && loaded === 'running' && !queryable,
    detail: `已索引=${indexed} 等候方收到=${waiterErr}；迟到完成后 state=${loaded}`
      + `（迟到成功真实发生了）；可查询该结果的接口=${queryable}（期望：有）`,
  };
});

// ───────────────────────────────────────────────────────────────────────────
// K-11 非法 SemVer / ^0.x 被误判满足
// ───────────────────────────────────────────────────────────────────────────
await probe('K-11', 'SemVer 把 ^0.x 与非法输入都判为满足', async () => {
  const cases = [
    ['0.3.0', '^0.2.0', false, '^0.x 必须锁 minor（0.x 语义）'],
    ['1.0.0', 'abc', false, '无法解析的范围不得视为满足'],
    ['1.0.0', '>=garbage', false, '无法解析的范围不得视为满足'],
    ['nonsense', '^1.0.0', false, '无法解析的版本不得视为满足'],
  ];
  const bad = cases.filter(([v, r, want]) => semverSatisfies(v, r) !== want);
  return {
    bug: bad.length > 0,
    detail: bad.length
      ? bad.map(([v, r, , why]) => `${v} vs "${r}" → ${semverSatisfies(v, r)}（期望 false：${why}）`).join('；')
      : '全部符合',
  };
});

// ───────────────────────────────────────────────────────────────────────────
// K-12 JSON5 字符串内部的注释形状被删改
// ───────────────────────────────────────────────────────────────────────────
await probe('K-12', 'JSON5 解析删改了字符串字面量内部的 // 与 /* */ 内容', async () => {
  const src = '{"a": "http://example.com/x", "b": "keep /* this */ text", "c": 1,}';
  let got;
  try { got = loadJson5(src); } catch (e) { return { bug: true, detail: `解析抛错：${e.message}` }; }
  const urlIntact = got.a === 'http://example.com/x';
  const blockIntact = got.b === 'keep /* this */ text';
  return {
    bug: !urlIntact || !blockIntact,
    detail: `a=${JSON.stringify(got.a)}（完整=${urlIntact}），b=${JSON.stringify(got.b)}（完整=${blockIntact}）`,
  };
});

// ───────────────────────────────────────────────────────────────────────────
// K-13 服务被异主覆写；releaseCapability 省略 owner 可放权
// ───────────────────────────────────────────────────────────────────────────
await probe('K-13a', '服务可被异主静默覆写（仅告警，不拒绝）', async () => {
  const t = sandbox('k13a');
  const core = makeCore(t);
  core._initOwner = 'A'; core.registerService('svc', { from: 'A' });
  // 异主覆写：修后应**抛具名错误**并保留 A 的实现。修前是静默覆盖（两者都"成功"）。
  let threw = null;
  try { core._initOwner = 'B'; core.registerService('svc', { from: 'B' }); }
  catch (e) { threw = e.message; }
  finally { core._initOwner = null; }
  const winner = core.getService('svc')?.from;
  const owner = core._serviceOwners.get('svc');
  // 判据：A 的实现仍在（不是 B），且拒绝有具名理由。
  return {
    bug: !(winner === 'A' && threw !== null),
    detail: `胜出实现=${winner}，归属记录=${owner}，拒绝理由=${threw ?? '（未拒绝）'}`
      + '（期望：保留 A 的实现，并以 service_conflict 具名拒绝覆写）',
  };
});

await probe('K-13b', 'releaseCapability 省略 owner 即可释放他人能力', async () => {
  const t = sandbox('k13b');
  const core = makeCore(t);
  core.registerCapability('z.cap', { owner: 'A', handler: () => 1 });
  // 匿名调用方（owner 省略）释放属于 A 的能力。
  // 修后行为有两种可接受形态：**抛具名错误**，或返回 false —— 两者都算修好，
  // 因为判据是"能力还在"，不是"用什么方式拒绝的"。所以这里必须捕获抛出，
  // 否则探针会把"正确地拒绝"记成 NOT_REPRODUCED（第一版就踩了这个坑）。
  let released = null; let threw = null;
  try { released = core.releaseCapability('z.cap'); } catch (e) { threw = e.message; }
  const gone = !core._capabilities.has('z.cap');
  return {
    bug: gone === true,
    detail: `匿名让渡结果：抛错=${threw ?? '否'} / 返回=${released}；能力已消失=${gone}`
      + '（期望：能力仍在 —— 抛具名错误或返回 false 都算拒绝）',
  };
});

// ───────────────────────────────────────────────────────────────────────────
// K-14 Core → plugins/_lib 的反向静态导入（源码观察，非运行漏洞）
//
// 专家明确要求：**不得**把 K-14 写成已实证的运行漏洞。这里只做源码判据。
//
// 但本轮净室复核发现了它的**一个真实后果**（比"依赖方向不好看"具体得多）：
// 把 `src/core/` 单独复制到别的目录后，`import` 直接失败 ——
//   Error [ERR_MODULE_NOT_FOUND]: Cannot find module '<dir>/plugins/_lib/plugin-esm-hint.mjs'
//   imported from '<dir>/src/core/plugin-manager.js'
// 也就是说：**内核无法脱离外围插件被加载**。这不是安全漏洞，是可移植性与层次问题，
// 但它把 K-14 从"编码风格"升级成了"结构性耦合有可复现的后果"。
// 依然是源码判据，依然不写成运行漏洞。
// ───────────────────────────────────────────────────────────────────────────
await probe('K-14', 'Core 静态导入 plugins/_lib（依赖方向反向，内核无法独立加载）', async () => {
  const src = readFileSync(join(ROOT, 'src', 'core', 'plugin-manager.js'), 'utf8');
  const hit = /from\s+'\.\.\/\.\.\/plugins\//.test(src);
  return {
    bug: hit,
    detail: hit
      ? "plugin-manager.js 存在 from '../../plugins/_lib/...' 的静态导入"
        + '（期望：Core 不依赖外围插件；实测把 src/core 单独拷走会 ERR_MODULE_NOT_FOUND）'
      : '无反向静态导入',
  };
});

// ───────────────────────────────────────────────────────────────────────────
// N-01 / N-02 / N-03：专家清单之外、本轮探针顺带发现的缺陷
//
// 记在这里的理由：它们和 K 项是**同一种形状**（一个判据读错了事实、或一个数字不是它声称的
// 那个东西），如果只修 K 而不管，下一轮还得再发现一次。
// ───────────────────────────────────────────────────────────────────────────
await probe('N-01', 'plugin.init_failed 的 initTimeMs 是时间戳而不是耗时', async () => {
  const t = sandbox('n01');
  const core = makeCore(t);
  let failed = null;
  core.on('plugin.init_failed', (e) => { failed = e; });
  await core.register({ name: 'boom', version: '1.0.0', init: async () => { throw new Error('x'); } });
  await core.start();
  // 一个"耗时"不可能大于 10^10 毫秒（约 115 天）
  const bug = typeof failed?.initTimeMs === 'number' && failed.initTimeMs > 1e10;
  return {
    bug: Boolean(bug),
    detail: `initTimeMs=${failed?.initTimeMs}（期望是毫秒耗时；现值量级是 epoch 时间戳）`,
  };
});

await probe('N-02', 'provides 写成字符串数组时在索引阶段抛 TypeError', async () => {
  const t = sandbox('n02');
  const core = makeCore(t);
  const pm = new PluginManager(core);
  // 字符串形态 provides：插件作者很容易这么写，且 plugin-meta 的解析器接受它
  let threw = null;
  try { pm._indexProvides({ name: 'strprov', provides: ['strprov.work'] }); }
  catch (e) { threw = e.message; }
  const bug = threw !== null;
  return {
    bug,
    detail: bug
      ? `_indexProvides 抛错：${threw}（期望：接受字符串形态，或给出具名的格式错误）`
      : '正常接受',
  };
});

await probe('N-03', '场景 include 指向不存在的场景时仅告警（不阻断）', async () => {
  const t = sandbox('n03');
  const core = makeCore(t);
  const pm = new PluginManager(core);
  pm.dirs = [join(t, 'plugins')];
  const sc = new SceneController(core, pm);
  const expanded = await sc._expandIncludes({ name: 'child', include: ['no-such-parent'], plugins: ['a'], eager: [] });
  // 判据：缺失的 include 必须在返回值里**留下痕迹**（partial + missingIncludes）。
  // 修前只 log 一句，返回值与"场景本来就这么大"完全一样。
  const marked = expanded.partial === true
    && Array.isArray(expanded.missingIncludes)
    && expanded.missingIncludes.includes('no-such-parent');
  return {
    bug: !marked,
    detail: `partial=${JSON.stringify(expanded.partial)} `
      + `missingIncludes=${JSON.stringify(expanded.missingIncludes ?? null)}`
      + ` plugins=${JSON.stringify(expanded.plugins)}`
      + '（期望：partial=true 且 missingIncludes 含 no-such-parent）',
  };
});

// ───────────────────────────────────────────────────────────────────────────
// 输出
// ───────────────────────────────────────────────────────────────────────────
const only = process.argv.slice(2).filter((a) => /^[KN]-\d+[a-z]?$/.test(a));
const rows = only.length ? results.filter((r) => only.includes(r.id)) : results;

if (only.length && rows.length === 0) {
  console.error(`没有匹配的探针：${only.join(', ')}；可用：${results.map((r) => r.id).join(', ')}`);
  process.exit(2);
}

const W = (s, n) => String(s).padEnd(n);
console.log('\n=== 土行孙 2222 行微内核：K/N 反例基线（v0.11.0）===\n');
for (const r of rows) {
  const tag = r.verdict === 'BUG' ? 'BUG ' : r.verdict === 'FIXED' ? 'FIXED' : 'N/REP';
  console.log(`[${tag}] ${W(r.id, 6)} ${r.title}`);
  console.log(`         ${r.detail}`);
}
const bugCount = rows.filter((r) => r.verdict === 'BUG').length;
const fixedCount = rows.filter((r) => r.verdict === 'FIXED').length;
const otherCount = rows.filter((r) => !['BUG', 'FIXED'].includes(r.verdict)).length;
console.log(`\n--- ${rows.length} 条：BUG ${bugCount} / FIXED ${fixedCount} / NOT_REPRODUCED ${otherCount} ---`);
// 只有在"没有 BUG 且没有 NOT_REPRODUCED"时才敢说全部已修。
// 单独一个 bugCount===0 会把"前置条件不满足"读成"已修"——这正是本文件 K-03b 修过的那个假绿。
const allClear = bugCount === 0 && otherCount === 0;
if (bugCount > 0) {
  console.log('结论：仍有缺陷。退出码 1（故意与直觉相反，见文件头）。\n');
} else if (otherCount > 0) {
  console.log(`结论：没有缺陷复现，但有 ${otherCount} 条前置条件不满足 —— 不足以判定"已修复"。退出码 1。\n`);
} else {
  console.log('结论：本批反例全部已修复。\n');
}

for (const t of tmpRoots) { try { rmSync(t, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响结论 */ } }
process.exit(allClear ? 0 : 1);
