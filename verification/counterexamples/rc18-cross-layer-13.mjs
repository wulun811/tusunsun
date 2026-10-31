#!/usr/bin/env node
/**
 * verification/counterexamples/rc18-cross-layer-13.mjs
 *
 * 专家 rc.17 深审的 13 条反例 —— **本仓自己的版本**，逐条把"修好了没有"变成可复跑判据。
 *
 * 与专家原件的关系：判据相同，**探针不共用**。专家原件留在
 * `verification/expert-originals/` 里逐字节不动，用于对上账；这里是因为其中两条在修复后
 * 会以"探针自身出错"结束（R17-02 给冻结对象赋值会抛、DA-06 现在被拒而它期望拿到返回值），
 * 而那是**修好的表现，不是缺陷**。把这两条按新契约重述成可达判据，才能继续当回归锁用。
 *
 * 判据分工（每条都写清"修好之后世界应该是什么样"）：
 *   01 R17-01 宿主续期后接管回执必须指向**当前**登记号
 *   02 R17-02 权属查询是快照，改它不影响下一次查询
 *   03 DA-03  宿主接管不得进插件装配账（旧插件失败不得连坐删掉宿主新登记）
 *   04 DA-04  按 owner 摘围栏必须带权属证明；token 不可推导
 *   05 DA-05  沙箱不是授权主体：无身份的受保护调用不得经沙箱 succeeded
 *   06 DA-06  沙箱派发的判据必须在**所有**异步步骤之后（查询期间改策略不得穿透）
 *   07 DA-07  denial 事件的观察者抛错不得改写拒绝信封
 *   08 DA-08  指标查询不得暴露可写聚合
 *   09 DA-09  缓存不得跨身份交付（同 session 换主体必须拒）
 *   10 DA-10  动态 unload 必须有界，超时不得报 unloaded
 *   11 DA-11  嵌套 tracking 不得留下卸载清不掉的飞地
 *   12 DA-12  诊断查询不得暴露可写内部对象
 *   13 DA-13  同名能力替换后缓存不得复用旧 handler 的结果
 *
 * 跑：node verification/counterexamples/rc18-cross-layer-13.mjs
 * 退出码 0 = 13/13 FIXED；1 = 仍有反例；2 = 探针自身出错（不当作通过）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const { Core, createRuntime } = await import(join(ROOT, 'src/core/core.js'));
const { ToolExecutor, setFence, removeFence, resolveFence } = await import(join(ROOT, 'plugins/tool-executor.js'));

const rows = [];
const quiet = (c) => { c.log = () => {}; return c; };

async function check(id, title, fn) {
  let dir = mkdtempSync(join(tmpdir(), 'rc18-'));
  try {
    const facts = await fn(dir);
    rows.push({ id, title, status: facts.fixed ? 'FIXED' : 'COUNTEREXAMPLE', ...facts });
  } catch (err) {
    rows.push({ id, title, status: 'PROBE_ERROR', error: String(err?.message || err) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 01 R17-01：宿主第二次登记同名服务后，回执的 newRegistrationId 必须等于当前 registrationId
await check('01', 'R17-01 宿主续期后接管回执必须指向当前登记号', async (t) => {
  const { core, host } = createRuntime({ stateDir: t }); quiet(core);
  await core._runAssemblyContext('p', async () => core.registerService('db', { v: 'p' }), core.assemblyEpoch, { name: 'p' });
  host.takeoverService('db', { v: 'h1' });
  host.registerService('db', { v: 'h2' });
  const own = core.getServiceOwnership('db');
  return {
    fixed: own.owner === '@host' && own.takeover?.newRegistrationId === own.registrationId,
    registrationId: own.registrationId,
    receiptNewId: own.takeover?.newRegistrationId ?? null,
  };
});

// 02 R17-02：查询结果不是内部对象 —— 改它不影响下一次查询（冻结则赋值抛，也算修好）
await check('02', 'R17-02 权属查询是快照，外部改写污染不了下一次查询', async (t) => {
  const { core, host } = createRuntime({ stateDir: t }); quiet(core);
  await core._runAssemblyContext('p', async () => core.registerService('db', { v: 1 }), core.assemblyEpoch, { name: 'p' });
  host.takeoverService('db', { v: 2 });
  const before = core.getServiceOwnership('db').takeover.newRegistrationId;
  let mutated = false;
  try { core.getServiceOwnership('db').takeover.newRegistrationId = 987654; mutated = true; } catch { mutated = false; }
  const after = core.getServiceOwnership('db').takeover.newRegistrationId;
  return {
    fixed: after === before,
    assignmentThrew: !mutated,
    before, after,
    note: mutated ? '返回值可写但未污染内部' : '返回值已冻结，赋值直接抛',
  };
});

// 03 DA-03：宿主接管发生在插件装配 ALS 内，旧插件失败清理不得删掉宿主那一笔
await check('03', 'DA-03 宿主接管不得记进插件装配账', async (t) => {
  const { core, host } = createRuntime({ stateDir: t }); quiet(core);
  let store;
  try {
    await core._runAssemblyContext('p', async () => {
      core.registerService('db', { v: 'p' });
      host.takeoverService('db', { v: 'host' });
      throw new Error('init_broke');
    }, core.assemblyEpoch, { name: 'p' });
  } catch (e) { store = e.assemblyStore; }
  const before = core.getServiceOwnership('db');
  const cleared = core.discardAssemblyArtifacts(store);
  const after = core.getServiceOwnership('db');
  return {
    fixed: before.owner === '@host' && after.registered === true && after.owner === '@host' && after.takeover != null,
    clearedServices: cleared.services,
    before: { owner: before.owner, registrationId: before.registrationId },
    after: { owner: after.owner, registrationId: after.registrationId },
  };
});

// 04 DA-04：按 owner 摘别人的围栏必须失败；token 不可由 owner 推导
await check('04', 'DA-04 摘围栏须带权属证明，token 不可猜', async (t) => {
  const core = quiet(new Core({ stateDir: t }));
  const installed = setFence({ preCheck: () => ({ block: true, reason: 'block' }) },
    { owner: 'trusted-security-owner', core });
  const ownerOnly = removeFence({ owner: 'trusted-security-owner' });
  const stillThere = resolveFence(core)?.owner ?? null;
  const derivable = /^trusted-security-owner#\d+$/.test(installed.token);
  const disposerOk = removeFence({ owner: 'trusted-security-owner', disposer: installed.disposer });
  const gone = resolveFence(core) == null;
  return {
    fixed: ownerOnly === false && stillThere === 'trusted-security-owner' && !derivable && disposerOk === true && gone,
    ownerOnlyRemovalReturned: ownerOnly, tokenDerivable: derivable,
    legitDisposerWorks: disposerOk, removedAfterDisposer: gone,
  };
});

// 05 DA-05：受保护能力 + 无身份 ⇒ 沙箱路径也必须拒，且 backend 零执行
await check('05', 'DA-05 沙箱不得绕过 Core 的身份判据', async (t) => {
  const core = quiet(new Core({ stateDir: t }));
  core.registerCapability('tool.write', {
    owner: 'file-tool', handler: async () => 'HANDLER',
    permissions: { require_identity: true, scope: 'admin' },
  });
  let executions = 0;
  core.registerService('sandbox', { execute: async () => { executions++; return { ok: true, data: 'WRITTEN' }; } });
  const direct = await core.callCapability('tool.write', { path: 'x', content: 'y' });
  const exe = new ToolExecutor(); exe.core = core; exe._useSandbox = true; exe._hookErrors = 0;
  const via = await exe._executeViaCapability('tool-write', 'tool.write', { path: 'x', content: 'y' }, 'sess-a');
  return {
    fixed: direct.ok === false && executions === 0 && via?.ok !== true,
    directCode: direct.code, sandboxExecutions: executions, viaCode: via?.code ?? via?.result ?? null,
  };
});

// 06 DA-06：准入判据必须在最后一个 await 之后 —— 查询期间改只读不得穿透
await check('06', 'DA-06 沙箱派发的判据必须在所有异步步骤之后', async (t) => {
  const core = quiet(new Core({ stateDir: t }));
  let mode = 'auto';
  core.get = (k, d) => (k === 'tools.permissionMode' ? mode : d);
  core.registerCapability('tool.write', { owner: 'tool-write', handler: async () => 'HANDLER' });
  let executions = 0;
  core.registerService('sandbox', { execute: async () => { executions++; return { ok: true, data: 'WRITTEN' }; } });
  let unblock; const block = new Promise((r) => { unblock = r; });
  let entered; const enteredP = new Promise((r) => { entered = r; });
  const exe = new ToolExecutor(); exe.core = core; exe._useSandbox = true; exe._hookErrors = 0;
  exe._toolForCapability = async () => { entered(); await block; return { name: 'tool-write', sandboxOp: 'write' }; };
  const p = exe._executeViaCapability('tool-write', 'tool.write', { path: 'x', content: 'y' }, 'sess-a');
  await enteredP; mode = 'read-only'; unblock();
  let via = null; let threw = null;
  try { via = await p; } catch (err) { threw = err?.code ?? String(err?.message || err); }
  return {
    fixed: executions === 0 && (threw === 'permission_denied' || via?.ok !== true),
    sandboxExecutions: executions, refusedWith: threw ?? via?.code ?? null,
  };
});

// 07 DA-07：denial 事件的观察者抛错不得改写拒绝信封
await check('07', 'DA-07 denial 观察者抛错不得改写拒绝结论', async (t) => {
  const core = quiet(new Core({ stateDir: t }));
  core.registerCapability('guarded', { handler: async () => 'SHOULD_NOT_RUN', permissions: { require_identity: true } });
  core.on('core:capability.denied', () => { throw new Error('observer_breaks_denial'); });
  let result = null; let exception = null;
  try { result = await core.callCapability('guarded', {}); } catch (e) { exception = e.message; }
  return {
    fixed: exception == null && result?.ok === false && result?.state === 'denied',
    exception, code: result?.code ?? null, state: result?.state ?? null,
    observerErrors: core.getObserverErrors().length,
  };
});

// 08 DA-08：指标查询不得暴露可写聚合
await check('08', 'DA-08 指标查询不得暴露可写聚合', async (t) => {
  const core = quiet(new Core({ stateDir: t }));
  core.startTask('x'); core.endTask('x');
  const before = core.getConfirmMetrics();
  core.getConfirmMetrics().tasks.push(987654);
  const after = core.getConfirmMetrics();
  return {
    fixed: !after.tasks.includes(987654) && before.averagePerTask === after.averagePerTask,
    beforeAverage: before.averagePerTask, afterAverage: after.averagePerTask, afterTasks: after.tasks,
  };
});

// 09 DA-09：同一 session 内换主体，缓存不得把甲的结果交给乙
await check('09', 'DA-09 缓存不得跨身份交付', async (t) => {
  const token = {};
  const core = quiet(new Core({ stateDir: t, identityAuthority: token }));
  let calls = 0;
  core.registerService('config', { get: (k, d) => (k === 'tools.permissionMode' ? 'full-auto' : d) });
  core.assertIdentity('user-a', { caller: 'legit-client', scope: 'admin', issuer: token });
  core.registerCapability('tool.read', {
    owner: 'tool-read', permissions: { require_identity: true, scope: 'read' },
    handler: async () => { calls++; return { secret: 'PRIVATE_DATA' }; },
  });
  const ex = new ToolExecutor(); ex.core = core; ex._useSandbox = false; ex._hookErrors = 0;
  const good = await ex.executeOne('tool-read', { path: join(t, 'missing') }, 'same-session', 'chain',
    { principal: 'user-a', caller: 'legit-client', scope: 'admin' });
  await new Promise((r) => setTimeout(r, 15));
  const bad = await ex.executeOne('tool-read', { path: join(t, 'missing') }, 'same-session', 'chain');
  const direct = await core.callCapability('tool.read', { path: join(t, 'missing') });
  return {
    fixed: good.ok === true && direct.ok === false && bad.ok !== true && calls === 1,
    goodOk: good.ok, badOk: bad.ok, badCode: bad?.code ?? null,
    directOk: direct.ok, handlerCalls: calls,
  };
});

// 10 DA-10：动态 unload 必须有界；超时不得报 unloaded
await check('10', 'DA-10 动态 unload 必须有界且不报 unloaded', async (t) => {
  const core = quiet(new Core({ stateDir: t }));
  // 把上界调小，让"有界"这件事在用例时间内可观测（默认 2000ms 与 Core.stop 对称）。
  core._stopLockMs = 120;
  let stopEntered = false;
  const plugin = {
    name: 'stuck-plugin', version: '1.0.0', state: 'running',
    init: async () => {}, stop: async () => { stopEntered = true; await new Promise(() => {}); },
  };
  await core.register(plugin);
  const t0 = Date.now();
  const out = await Promise.race([
    core.lifecycle.unload('stuck-plugin', { force: true }).then((v) => ({ settled: true, value: v }), (e) => ({ settled: true, error: String(e) })),
    new Promise((r) => setTimeout(() => r({ settled: false }), 1500)),
  ]);
  const elapsed = Date.now() - t0;
  const v = out.value ?? null;
  return {
    fixed: stopEntered && out.settled === true && v?.ok !== true && v?.execution_outcome === 'unknown',
    stopEntered, settled: out.settled, elapsedMs: elapsed,
    code: v?.code ?? null, ok: v?.ok ?? null, executionOutcome: v?.execution_outcome ?? null,
  };
});

// 11 DA-11：嵌套 tracking 登记的服务，卸载时必须被清掉
await check('11', 'DA-11 嵌套 tracking 不得留下卸载清不掉的飞地', async (t) => {
  const core = quiet(new Core({ stateDir: t }));
  const plugin = {
    name: 'registrar', version: '1.0.0', state: 'registered', requires: {},
    async init(c) { await c.runServiceTracking('subcomponent', async () => c.registerService('nested-svc', { value: 1 })); },
    async stop() {},
  };
  const load = await core.lifecycle.load(plugin, core, { epoch: core.assemblyEpoch });
  const before = core.getServiceOwnership('nested-svc');
  const unload = await core.lifecycle.unload('registrar', { force: true });
  const after = core.getServiceOwnership('nested-svc');
  return {
    fixed: load.ok === true && unload.ok === true && after.registered === false,
    loadOk: load.ok, unloadOk: unload.ok,
    beforeOwner: before.owner, afterRegistered: after.registered,
  };
});

// 12 DA-12：诊断查询不得暴露可写内部对象
await check('12', 'DA-12 诊断查询不得暴露可写内部对象', async (t) => {
  const core = quiet(new Core({ stateDir: t }));
  core.on('core.ready', () => { throw new Error('observer_test'); });
  core.emitFact('core.ready', { sourcePlugin: 'core', data: { v: 1 } });
  const before = core.getObserverErrors();
  const field = before[0] && Object.keys(before[0]).find((k) => typeof before[0][k] === 'string');
  if (field) before[0][field] = 'FORGED_DIAGNOSTIC';
  const after = core.getObserverErrors();
  return {
    fixed: field != null && after[0][field] !== 'FORGED_DIAGNOSTIC',
    field, afterValue: field ? after[0][field] : null,
  };
});

// 13 DA-13：同名能力被替换后，缓存不得复用旧 handler 的结果
await check('13', 'DA-13 同名能力替换后缓存不得复用旧结果', async (t) => {
  const core = quiet(new Core({ stateDir: t }));
  core.registerService('config', { get: (k, d) => (k === 'tools.permissionMode' ? 'full-auto' : d) });
  let invokedA = 0; let invokedB = 0;
  const tokenA = core.registerCapability('tool.read', {
    owner: 'tool-read', handler: async () => { invokedA++; return { version: 'A' }; },
  });
  const ex = new ToolExecutor(); ex.core = core; ex._useSandbox = false; ex._hookErrors = 0;
  const a = await ex.executeOne('tool-read', { path: join(t, 'missing') }, 'same-session', 'chain');
  await new Promise((r) => setTimeout(r, 15));
  core.releaseRegistration(tokenA);
  core.registerCapability('tool.read', {
    owner: 'tool-read', handler: async () => { invokedB++; return { version: 'B' }; },
  });
  const b = await ex.executeOne('tool-read', { path: join(t, 'missing') }, 'same-session', 'chain');
  const parsed = (r) => { try { return JSON.parse(r?.result ?? 'null'); } catch { return null; } };
  return {
    fixed: b?.ok === true && parsed(b)?.version === 'B' && invokedB === 1,
    aVersion: parsed(a)?.version ?? null, bVersion: parsed(b)?.version ?? null,
    invokedA, invokedB,
  };
});

const fixed = rows.filter((r) => r.status === 'FIXED').length;
const bad = rows.filter((r) => r.status === 'COUNTEREXAMPLE').length;
const errs = rows.filter((r) => r.status === 'PROBE_ERROR').length;
console.log(JSON.stringify({
  root: ROOT,
  summary: { cases: rows.length, fixed, counterexamples: bad, probe_errors: errs },
  rows,
}, null, 2));
process.exitCode = errs > 0 ? 2 : bad > 0 ? 1 : 0;
