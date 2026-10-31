/**
 * verification/adapter/replay.mjs —— 真实实现重放适配器（专家合同 §5）
 *
 * 这个文件跑的是 src/ 里的**真代码**（`LifecycleManager` / `Core`），不是模型。
 * 它存在的理由：模型上一个 `holder` 变量一变，现实里是「两个插件同时进了同一个独占区」。
 * 两者之间必须有一条可执行的对应关系，否则「模型 PASS」只是一句好听话。
 *
 * 每条记录按 §5 的字段名输出：contract / model / implementation / baseline / seed /
 * actions / expected / observed / status。status 只有两个值：
 *   IMPLEMENTATION_PASS            观测到的真实轨迹满足 expected
 *   IMPLEMENTATION_COUNTEREXAMPLE  不满足（含超时、抛错、断言失败）
 * 「没跑」不在这里表示 —— 未建立的映射写在 verification/mapping.csv 里，不写 PASS。
 *
 * 只用公开 API 与确定性屏障（Promise + 显式 resolve），不用 sleep 抢时序：
 * 一个靠 sleep 的「重放」在慢机器上会变成另一种东西。
 */
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = join(HERE, '..', '..');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** 基线指纹：本文件记录的任何结论只对这两个文件的这个版本成立。 */
export function baselineFingerprint() {
  const core = sha256(readFileSync(join(REPO, 'src/core/core.js')));
  const lc = sha256(readFileSync(join(REPO, 'src/core/lifecycle-manager.js')));
  return `core.js:${core};lifecycle-manager.js:${lc}`;
}

function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const codeOf = (e) => (e && typeof e === 'object' && 'code' in e ? e.code : null);
const msgOf = (e) => String(e?.message ?? e ?? '').slice(0, 200);

async function record(meta, body) {
  const t0 = Date.now();
  let observed;
  try {
    observed = await body();
  } catch (err) {
    observed = { ok: false, error: msgOf(err), code: codeOf(err) };
  }
  const ok = observed.ok === true;
  return {
    contract: meta.contract,
    model: meta.model,
    implementation: meta.implementation,
    baseline: meta.baseline,
    seed: meta.seed,
    actions: meta.actions,
    expected: meta.expected,
    observed,
    status: ok ? 'IMPLEMENTATION_PASS' : 'IMPLEMENTATION_COUNTEREXAMPLE',
    elapsed_ms: Date.now() - t0,
    notes: meta.notes ?? null,
  };
}

/** F04 / H7：同 key 峰值并发必须 = 1，且后来的调用方必须**具名**失败而不是静默并行。 */
async function replayF04({ baseline, LifecycleManager }) {
  const lc = new LifecycleManager({});
  let inside = 0; let peak = 0;
  const entered = deferred(); const allowExit = deferred();
  const holder = lc.runExclusive('cap', async () => {
    inside += 1; peak = Math.max(peak, inside);
    entered.resolve();
    await allowExit.promise;
    inside -= 1;
    return 'holder-done';
  });
  await entered.promise;
  const bump = async () => { inside += 1; peak = Math.max(peak, inside); inside -= 1; };
  let waiterErr = null;
  try { await lc.runExclusive('cap', bump, { timeoutMs: 30 }); } catch (e) { waiterErr = e; }
  const queuesIntact = lc._queues.has('cap');
  let laterErr = null;
  try { await lc.runExclusive('cap', bump, { timeoutMs: 30 }); } catch (e) { laterErr = e; }
  allowExit.resolve();
  const holderResult = await holder;
  // 持有者结账后，这个 key 必须恢复可用（防「一轮超时永久中毒」）。
  let recovered = null;
  try { recovered = await lc.runExclusive('cap', async () => 'ok', { timeoutMs: 200 }); } catch (e) { recovered = codeOf(e) ?? msgOf(e); }
  return {
    ok: peak === 1 && codeOf(waiterErr) === 'lock_timeout' && codeOf(laterErr) === 'lock_timeout' && holderResult === 'holder-done' && recovered === 'ok',
    peak_concurrent_holders: peak,
    holder_result: holderResult,
    waiter_rejected_with: codeOf(waiterErr),
    later_entrant_rejected_with: codeOf(laterErr),
    queue_entry_survived_waiter_timeout: queuesIntact,
    key_recovered_after_holder_exit: recovered,
  };
}

/** F03：等锁者超时不得「替在途尝试结账」—— 持有者自己的结果必须原样送达。 */
async function replayF03({ baseline, LifecycleManager }) {
  const lc = new LifecycleManager({});
  const entered = deferred(); const allowExit = deferred();
  let holderSawError = null;
  const holder = lc.runExclusive('attempt', async () => {
    entered.resolve();
    await allowExit.promise;
    return 'effect-committed';
  }).catch((e) => { holderSawError = e; return 'threw'; });
  await entered.promise;
  let waiterErr = null;
  try { await lc.runExclusive('attempt', async () => 'never', { timeoutMs: 25 }); } catch (e) { waiterErr = e; }
  allowExit.resolve();
  const holderResult = await holder;
  return {
    ok: codeOf(waiterErr) === 'lock_timeout' && holderResult === 'effect-committed' && holderSawError === null,
    waiter_rejected_with: codeOf(waiterErr),
    holder_completed_with: holderSawError === null ? holderResult : `threw:${msgOf(holderSawError)}`,
    holder_aborted: holderSawError !== null,
  };
}

/** F05 正控：同一流程**不**掉代，登记必须成功 —— 否则「被拒」可能只是因为别的错。 */
async function replayF05Control({ baseline, Core, LifecycleManager }) {
  const result = await runAssemblyCommit(Core, LifecycleManager, { bumpEpoch: false });
  return {
    ok: result.loadErrorCode === null && result.errorCode === null && result.registered === true,
    registered: result.registered,
    load_error: result.loadError,
    register_error: result.error,
  };
}

/** F05：旧代装配的登记必须被拒，且不得留在能力表里。 */
async function replayF05({ baseline, Core, LifecycleManager }) {
  const result = await runAssemblyCommit(Core, LifecycleManager, { bumpEpoch: true });
  const codes = [result.loadErrorCode, result.errorCode].filter(Boolean);
  return {
    ok: codes.includes('assembly_superseded') && result.registered === false,
    rejected_at: result.loadErrorCode ? 'LifecycleManager.load' : (result.errorCode ? 'Core.registerCapability' : null),
    codes,
    load_error: result.loadError,
    register_error: result.error,
    registered_into_new_epoch: result.registered,
  };
}

async function runAssemblyCommit(Core, LifecycleManager, { bumpEpoch }) {
  const tmp = mkdtempSync(join(tmpdir(), 'formal-f05-'));
  try {
    const core = new Core({ stateDir: join(tmp, 'state') });
    core.log = () => {};
    const lc = new LifecycleManager(core);
    const started = deferred(); const go = deferred();
    let error = null;
    // 插件名必须过 `PLUGIN_NAME_RE`（S7 之后 `Core.register` 在 init 之前就拒）：
    // 修前这里写 `'A'`，于是 run-formal 在**第一条重放构造之前**就抛 plugin_name_invalid，
    // 报告文件停在上一轮的 IMPLEMENTATION_PASS 上 —— 一个崩溃被当成绿灯（见本文件头）。
    const plugin = {
      name: 'plugin-a', version: '1.0.0',
      async init() {
        started.resolve();
        await go.promise;
        try {
          core.registerCapability('late-cap', { handler: async () => 1 });
        } catch (e) { error = e; }
      },
      async start() {}, async stop() {},
    };
    const asm = core.beginAssembly('plugin-a');
    // **先接住再等**：`load` 可能在 `started.resolve()` 之前就 reject（例如注册被拒）。
    // 裸 promise 悬在那儿时，Node 把它当 unhandledRejection 直接杀进程 ——
    // 于是整条实现轨没跑，而磁盘上留着上一次的 IMPLEMENTATION_PASS。
    const loading = lc.load(plugin, core, { epoch: asm.epoch }).then(
      (r) => ({ ok: r, err: null }),
      (e) => ({ ok: null, err: e }),
    );
    await started.promise;
    // 与 Core.stop 的原子点同一行（`_epoch += 1` / `_stopping = true`）。
    // 这里只掉代、不置 _stopping，是为了把「世代闸门」与「停机闸门」两个事实分开测。
    if (bumpEpoch) core._epoch += 1;
    go.resolve();
    // 闸门有两道：`LifecycleManager._load` 在 init 返回后复核一次，
    // `Core.registerCapability` 在登记那一行再复核一次。两道都要收，
    // 只测一条会把「另一道漏了」看成通过。
    let loadError = null;
    try { await loading; } catch (e) { loadError = e; }
    core.endAssembly(asm);
    return {
      error: error === null ? null : msgOf(error),
      errorCode: codeOf(error),
      loadError: loadError === null ? null : msgOf(loadError),
      loadErrorCode: codeOf(loadError),
      registered: core._capabilities.has('late-cap'),
    };
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  }
}

/** F05 服务侧：旧世代装配经**嵌套公开入口**注册服务必须被拒。
 *
 * 为什么单独一条：`F05-REPLAY-01` 只走了 `registerCapability` 那一道闸门。
 * 服务侧曾把 `ctx0?.epoch != null` 当闸门，而公开 `runServiceTracking` 传的正是 `epoch:null`，
 * 于是内层 store 就是个「消磁器」——修前实测服务与**能力**双双 ALLOWED。
 * 这条记录同时包含正控（同代嵌套仍成功），否则「被拒」可能只是别的异常。
 */
async function replayF05Service({ baseline, Core }) {
  const tmp = mkdtempSync(join(tmpdir(), 'formal-f05-svc-'));
  try {
    const core = new Core({ stateDir: join(tmp, 'state') });
    core.log = () => {};
    const attempt = async (supersede) => {
      const out = { thrown: null, control: null };
      await core._runAssemblyContext('plugin-a', async () => {
        if (supersede) core._epoch += 1;
        try {
          await core.runServiceTracking('attacker', async () => {
            core.registerService('late-svc', { x: 1 });
            core.registerCapability('late-cap', { handler: async () => 1 });
          });
          out.control = true;
        } catch (e) { out.thrown = e; }
      }, core.assemblyEpoch);
      return out;
    };
    // 先跑正控（同代）：嵌套公开入口必须仍可用，否则下面的「被拒」证明不了任何事。
    const ctl = await attempt(false);
    const controlOk = ctl.thrown === null && ctl.control === true
      && core._services.has('late-svc') && core._capabilities.has('late-cap');
    // 清干净再跑反例，避免正控的登记把「未登记」判据弄成假绿。
    core._services.clear(); core._serviceOwners.clear(); core._serviceRegistrar.clear();
    core._capabilities.clear(); core._capHandles = new WeakMap();
    const bad = await attempt(true);
    return {
      ok: controlOk && codeOf(bad.thrown) === 'assembly_superseded'
        && !core._services.has('late-svc') && !core._capabilities.has('late-cap'),
      control_same_epoch_nested_allowed: controlOk,
      superseded_nested_rejected_with: codeOf(bad.thrown),
      service_leaked: core._services.has('late-svc'),
      capability_leaked: core._capabilities.has('late-cap'),
    };
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  }
}

/** F08：永不返回的 stop() 不得让 core.stop() 永不返回；且回执必须分阶段。 */
async function replayF08({ baseline, Core }) {
  const tmp = mkdtempSync(join(tmpdir(), 'formal-f08-'));
  try {
    const core = new Core({ stateDir: join(tmp, 'state') });
    core.log = () => {};
    core._stopAssemblyDrainMs = 20;
    core._stopLockMs = 100;
    core.register({
      name: 'stuck', version: '1.0.0',
      async init() {}, async start() {},
      async stop() { await new Promise(() => { /* 永不返回 */ }); },
    });
    await core.start();
    let payload = null;
    core.on('core.stopped', (p) => { payload = p; });
    const t0 = Date.now();
    const settled = await Promise.race([core.stop().then(() => 'returned'), sleep(5000).then(() => 'timeout')]);
    const elapsed = Date.now() - t0;
    const fail = (payload?.stopFailures ?? []).find((f) => f.plugin === 'stuck') ?? null;
    const state = core.plugins.get('stuck')?.state ?? null;
    return { settled, elapsed, fail, state, _stopped: core._stopped };
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

/** F01：登记身份与撤销权。四条记录，分别对应模型里四条安全性质。 */
async function replayF01({ baseline, Core }) {
  const tmp = mkdtempSync(join(tmpdir(), 'formal-f01-'));
  try {
    const core = new Core({ stateDir: join(tmp, 'state') });
    core.log = () => {};
    const results = {};

    // ① 字符串不构成授权：拿公开的 owner 名去释放
    const h1 = core.registerCapability('own.op', { owner: 'declared-x', handler: () => 'V1' });
    const listed = core.listCapabilities().find((c) => c.id === 'own.op');
    let byString = null;
    try { core.releaseCapability('own.op', 'declared-x'); } catch (e) { byString = codeOf(e); }
    results.string_release = { rejected_with: byString, still_callable: core._capabilities.has('own.op') };

    // ② 凭句柄当登记身份：旧句柄不得删掉后继登记（ABA）
    core.releaseRegistration(h1);
    const h2 = core.registerCapability('own.op', { owner: 'declared-x', handler: () => 'V2' });
    const staleDelete = core.releaseRegistration(h1);
    results.aba = { stale_handle_deleted: staleDelete, successor_intact: core._capabilities.has('own.op') };

    // ③ 覆盖只认凭据，不认 owner 字符串
    let overflow = null;
    try { core.registerCapability('own.op', { owner: 'declared-x', handler: () => 'V3' }); } catch (e) { overflow = codeOf(e); }
    const h3 = core.registerCapability('own.op', { overrideBy: h2, handler: () => 'V3' });
    results.override = { rejected_without_credential: overflow, replaced_with_credential: Boolean(h3) };

    // ④ 按名批量清场入口不得存在（旧句柄无权，只能持凭据）
    results.bulk = {
      release_capabilities_by_owner: typeof core.releaseCapabilitiesByOwner,
      release_services_by_owner: typeof core.releaseServicesByOwner,
    };

    const ok = results.string_release.rejected_with === 'capability_release_denied'
      && results.string_release.still_callable === true
      && results.aba.stale_handle_deleted === false
      && results.aba.successor_intact === true
      && results.override.rejected_without_credential === 'capability_conflict'
      && results.override.replaced_with_credential === true
      && results.bulk.release_capabilities_by_owner === 'undefined'
      && results.bulk.release_services_by_owner === 'undefined';
    return { ok, declared_owner: listed?.owner ?? null, provider_on_public_list: listed?.provider ?? null, ...results };
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

/** F01 正例：生命周期清场不需要插件保存任何句柄。 */
async function replayF01Reap({ baseline, Core, LifecycleManager }) {
  const tmp = mkdtempSync(join(tmpdir(), 'formal-f01-reap-'));
  try {
    const core = new Core({ stateDir: join(tmp, 'state') });
    core.log = () => {};
    const lc = new LifecycleManager(core);
    // 插件故意**不**保存 registerCapability 的返回值：专家 ID-13 要求这样也得能清干净。
    const plugin = {
      name: 'reap-me', version: '1.0.0',
      async init(c) { c.registerCapability('reap.op', { handler: () => 'X' }); },
      async start() {}, async stop() {},
    };
    await lc.load(plugin, core, {});
    const before = core._capabilities.has('reap.op');
    // 下一代同名插件先接一笔同名登记（重载后同名），旧实例的迟到清场不得删到它。
    const late = core.registerCapability('late.op', { owner: 'reap-me', handler: () => 'Y' });
    await lc.unload('reap-me');
    const afterOwn = core._capabilities.has('reap.op');
    const survivor = core._capabilities.has('late.op');
    core.releaseRegistration(late);
    return { ok: before === true && afterOwn === false && survivor === true, registered_before: before, own_cleared: !afterOwn, unrelated_survived: survivor };
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

/** F06：依赖与停机次序。四条判据，全部读 `core.stopped` 载荷与真实卸载拒绝。
 *
 * F06 现在**有模型**了：`verification/model/Dependency.tla`（五不变量 + 一条下界性质，
 * 五个突变体全杀）。但这条记录的 `model` 字段仍然填 null —— 重放与模型是两件事，
 * 不许互相顶替：重放证的是「这几条真实轨迹满足合同」，模型证的是「那份状态机上
 * 所有交错都没反例」。填上模型名会让人以为这条轨迹被模型排过了。
 *
 * 四条分别钉住合同里四个禁止状态：
 *   ① 先释放被依赖方  ⇒ 链式依赖必须是逆拓扑序且 basis=dependency；
 *   ② 用插入序冒充拓扑序 ⇒ 无依赖时必须自报 basis=insertion；
 *   ③ 缺席提供者被吞掉 ⇒ unresolved 里必须点名；
 *   ④ 环被吞掉 ⇒ cycles 里必须有点名的路径。
 * 再加一条运行时闸门：依赖方还 running 时卸载提供方必须被拒。
 */
/** F06：依赖与停机次序。四条判据读 `core.stopped` 载荷，第五条读真实卸载拒绝。
 *
 * F06 **没有模型**（`verification/model/` 里不存在 Dependency.tla），所以调用方给这条
 * 记录的 `model` 填 null —— 不是漏填，是不许借 Lifecycle 的名字冒充一个模型。
 * 独立重放本来就不需要模型：它证的是「实现上的真实轨迹满足合同」。
 *
 * 五条分别钉住合同里的四个禁止状态 + 一条运行时闸门：
 *   ① 先释放被依赖方   ⇒ 链式依赖必须是逆拓扑序，且 basis=dependency；
 *   ② 用插入序冒充拓扑序 ⇒ 无依赖时**必须自报** basis=insertion；
 *   ③ 缺席提供者被吞掉  ⇒ unresolved 里必须点名到 dep；
 *   ④ 环被吞掉          ⇒ cycles 里必须点名路径，且停机不得挂住；
 *   ⑤ 依赖方仍 running 时卸载提供方，必须具名被拒（拒绝理由要点名是谁在依赖）。
 */
async function replayF06({ Core, LifecycleManager }) {
  const tmp = mkdtempSync(join(tmpdir(), 'formal-f06-'));
  const mk = (name, extra = {}) => ({
    name, version: '1.0.0', async init() {}, async start() {}, async stop() {}, ...extra,
  });
  let seq = 0;
  // 每个场景一台干净 Core：依赖图是逐台的，复用会把上一场的边带进来。
  const boot = async (plugins) => {
    seq += 1;
    const core = new Core({ stateDir: join(tmp, `state-${seq}`) });
    core.log = () => {};
    core._stopAssemblyDrainMs = 20;
    for (const p of plugins) await core.register(p);
    await core.start();
    return core;
  };
  // 停机一次并取载荷。监听必须先于 stop()：core.stopped 是停机过程里发布的。
  const stopPayload = async (plugins) => {
    const core = await boot(plugins);
    let payload = null;
    core.on('core.stopped', (p) => { payload = p; });
    await core.stop();
    return payload;
  };
  try {
    // ① top 依赖 mid 依赖 base（都用服务名声明，顺带覆盖「requires 的键是服务名」这条解释）。
    const chain = await stopPayload([
      mk('base', { provides: ['base-svc'] }),
      mk('mid', { requires: { 'base-svc': '*' }, provides: ['mid-svc'] }),
      mk('top', { requires: { 'mid-svc': '*' } }),
    ]);
    // ② 单插件：没有任何依赖边，此时「有序」只能是插入序，必须自报。
    const solo = await stopPayload([mk('solo')]);
    // ③ 缺席的提供者：不建边（停机不能挂），但必须交出去。
    const missing = await stopPayload([mk('lonely', { requires: { 'no-such-svc': '*' } })]);
    // ④ 环：必须交路径，且停机仍要出顺序。
    const cycle = await stopPayload([
      mk('a', { requires: { 'b-svc': '*' }, provides: ['a-svc'] }),
      mk('b', { requires: { 'a-svc': '*' }, provides: ['b-svc'] }),
    ]);
    // ⑤ 运行时闸门（卸载路径，不是停机路径）。
    const guardCore = await boot([
      mk('base', { provides: ['base-svc'] }),
      mk('dependent', { requires: { 'base-svc': '*' } }),
    ]);
    const lc = new LifecycleManager(guardCore);
    let blocked = null;
    try { await lc.unload('base'); } catch (e) { blocked = msgOf(e); }
    let dependentGone = null;
    try { await lc.unload('dependent'); dependentGone = 'allowed'; } catch (e) { dependentGone = `rejected:${msgOf(e)}`; }
    let providerAfter = null;
    try { await lc.unload('base'); providerAfter = 'allowed'; } catch (e) { providerAfter = `rejected:${msgOf(e)}`; }
    await guardCore.stop();

    const chainOrder = (chain?.stopOrder ?? []).join('>');
    const cyclePaths = cycle?.stopOrderCycles ?? [];
    const unresolved = missing?.stopOrderUnresolved ?? [];
    return {
      ok: chainOrder === 'top>mid>base'
        && chain?.stopOrderBasis === 'dependency'
        && (chain?.stopOrderUnresolved ?? []).length === 0
        && (chain?.stopOrderCycles ?? []).length === 0
        && solo?.stopOrderBasis === 'insertion'
        && unresolved.length === 1 && unresolved[0]?.dep === 'no-such-svc'
        && missing?.stopOrderBasis === 'insertion'
        && cyclePaths.length === 1 && /a/.test(cyclePaths[0]) && /b/.test(cyclePaths[0])
        && blocked !== null && blocked.includes('dependent')
        && dependentGone === 'allowed'
        && providerAfter === 'allowed',
      chain_order: chainOrder,
      chain_basis: chain?.stopOrderBasis ?? null,
      solo_basis: solo?.stopOrderBasis ?? null,
      unresolved,
      cycle_paths: cyclePaths,
      unload_provider_blocked: blocked,
      unload_dependent: dependentGone,
      unload_provider_after_dependent_gone: providerAfter,
    };
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  }
}


export async function runReplay({ Core, LifecycleManager } = {}) {
  if (!Core || !LifecycleManager) throw new Error('runReplay: 需要传入真实的 Core 与 LifecycleManager');
  const baseline = baselineFingerprint();
  const ctx = { baseline, Core, LifecycleManager };
  const out = [];

  out.push(await record({
    contract: 'F04', model: 'Lifecycle', implementation: 'LifecycleManager.runExclusive', baseline,
    seed: 'holder-enter > waiter-enqueue > waiter-timeout > later-enqueue > holder-exit',
    actions: ['holder-enter', 'waiter-enqueue', 'waiter-timeout', 'later-enqueue', 'holder-exit', 'fresh-enter'],
    expected: 'max-active-holders-per-key<=1 且等锁者具名失败 lock_timeout',
    notes: 'H7 的真实交错；peak_concurrent_holders 来自真实计数器，不是模型变量',
  }, () => replayF04(ctx)));

  out.push(await record({
    contract: 'F03', model: 'Lifecycle', implementation: 'LifecycleManager.runExclusive (lease)', baseline,
    seed: 'holder-enter > waiter-timeout > holder-exit',
    actions: ['holder-enter', 'waiter-timeout', 'holder-exit'],
    expected: '等锁超时不得中断或清算持有者的在途尝试',
    notes: '部分映射：实现里没有一个与模型 attemptLease 同名的对象，证据是「持有者结果未被污染」',
  }, () => replayF03(ctx)));

  out.push(await record({
    contract: 'F05', model: 'Lifecycle', implementation: 'Core.registerCapability (isAssemblyCurrent)', baseline,
    seed: 'control: begin-assembly > commit-in-same-epoch',
    actions: ['begin-assembly', 'commit-in-same-epoch'],
    expected: '同代登记成功（正控：证明「被拒」不是因为别的错）',
    notes: '正控记录。没有它，F05-REPLAY-01 的「被拒」可能只是别的异常',
  }, () => replayF05Control(ctx)));

  out.push(await record({
    contract: 'F05', model: 'Lifecycle', implementation: 'Core.registerCapability (isAssemblyCurrent)', baseline,
    seed: 'begin-assembly > epoch-bump > late-commit',
    actions: ['begin-assembly', 'epoch-bump(与 Core.stop 同一原子写)', 'late-commit'],
    expected: '旧代提交被拒（assembly_superseded）且不进入能力表',
    notes: '只掉代、不置 _stopping：把「世代闸门」与「停机闸门」分开测',
  }, () => replayF05(ctx)));

  const f05svc = await replayF05Service(ctx);
  out.push(await record({
    contract: 'F05', model: 'Lifecycle', implementation: 'Core._runAssemblyContext (来源继承)', baseline,
    seed: 'control: same-epoch nested > then: epoch-bump > nested-commit',
    actions: ['begin-assembly', 'runServiceTracking(内层 epoch:null)', 'epoch-bump', 'late-commit'],
    expected: '旧代经内层公开入口登记服务/能力必须 assembly_superseded，且不留在表里；同代嵌套仍成功',
    notes: '修前实测两侧均 ALLOWED。内层 store 不得把外层的 epoch/instance 抹成 null；账必须回挂外层',
  }, async () => f05svc));

  const f08 = await replayF08(ctx);
  out.push(await record({
    contract: 'F08', model: 'Lifecycle', implementation: 'Core._stopOnePlugin', baseline,
    seed: 'begin-stop > stop-call-hangs > stop-deadline',
    actions: ['begin-stop', 'stop-call-hangs', 'stop-deadline'],
    expected: 'core.stop() 在有限时间内返回，且走完（_stopped=true）',
    notes: 'H8 的真实交错；elapsed 是真实墙钟',
  }, async () => ({
    ok: f08.settled === 'returned' && f08.elapsed < 2000 && f08._stopped === true,
    settled: f08.settled,
    elapsed_ms: f08.elapsed,
    core_stopped: f08._stopped,
  })));

  out.push(await record({
    contract: 'F08', model: 'Lifecycle', implementation: 'Core._stopFailure', baseline,
    seed: 'begin-stop > stop-call-hangs > stop-deadline',
    actions: ['begin-stop', 'stop-call-hangs', 'stop-deadline', 'read-plugin-state'],
    expected: '回执 phase=stop_return、execution_outcome=unknown，且插件状态不得是 stopped',
    notes: '「有界返回」与「真的停了」是两件事：这条只验前者不被冒充成后者',
  }, async () => ({
    ok: f08.fail?.phase === 'stop_return' && f08.fail?.execution_outcome === 'unknown' && f08.state !== 'stopped',
    receipt_phase: f08.fail?.phase ?? null,
    execution_outcome: f08.fail?.execution_outcome ?? null,
    plugin_state: f08.state,
  })));

  out.push(await record({
    contract: 'F01', model: 'Ownership', implementation: 'Core.registerCapability / releaseRegistration / releaseCapability', baseline,
    seed: 'mint(R1) > release-by-string > release(H1) > mint(R2) > late-release(H1) > override-without/with-credential',
    actions: ['MintRegister', 'ReleaseByString', 'ReleaseByHandle', 'OverrideWithHandle'],
    expected: '公开字符串不构成授权；旧句柄只能指向旧登记（compare-and-delete）；覆盖须持凭据；无按名批量入口',
    notes: '证据 ID-02/ID-03/ID-07/ID-08/ID-10。反例与否均由真实 Core 返回的错误码决定',
  }, () => replayF01(ctx)));

  out.push(await record({
    contract: 'F01', model: 'Ownership', implementation: 'Core.issueLifecycleReaper → LifecycleManager._step6RemoveRegistrations', baseline,
    seed: 'load(plugin) > mint(unrelated) > unload(plugin)',
    actions: ['MintRegister', 'ReapInstance', 'LateStopOfOldInstance'],
    expected: '插件未保存凭据也能被按实例清干净；同名/无关的登记不得被误删',
    notes: '证据 ID-13（正例：不许把系统做成不许卸载段）',
  }, () => replayF01Reap(ctx)));

  out.push(await record({
    contract: 'F06', model: null,
    implementation: 'Core._stopOrder (computeStopOrder) / LifecycleManager._step1CheckDependents', baseline,
    seed: 'chain(base<-mid<-top) > solo > unresolved-provider > cycle(a<->b) > unload-provider-while-dependent-running',
    actions: ['stop:chain', 'stop:solo', 'stop:unresolved', 'stop:cycle', 'unload:provider-blocked'],
    expected: '链式依赖逆拓扑序且 basis=dependency；无依赖自报 insertion；缺席提供者与环都点名列进 core.stopped；依赖方 running 时卸载提供方被具名拒绝',
    notes: 'F06 没有模型，model 字段为 null —— 不借 Lifecycle 的名字冒充。'
      + '合同此前记 NOT_RUN（独立重放），这条就是那个缺的独立重放；结构侧见 test-r018 /14 /15',
  }, () => replayF06(ctx)));

  return out;
}
