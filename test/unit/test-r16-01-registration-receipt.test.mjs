// R16：专家 rc.16 独立复审的 R16-01 —— 服务侧「按名字清理」与能力侧「按登记句柄清理」
// 是两种不同的现实。旧装配 init 失败时的清理取 `store.serviceNames`（当时只有名字）直接删表，
// 于是后来那笔**合法宿主接管**被一起抹掉，并留下「对象没了、登记 ID 还在」的幽灵账 ——
// 同一份账会让按旧 ID 的释放对一个已经不存在的服务返回成功。
//
// 修法不是加豁免，是把服务侧接回已经建立的登记身份合同：装配账记收据
// `{name, registrationId, instance}`，删除只有一个入口 `_discardServiceReceipt`，
// 它先比登记 ID、再原子清五个账，比不中就是 stale。
//
// 下面 12 条对应专家合同 §4 的验收矩阵，全部走**受管 API**（不改私有表）；
// c/d/h/j 是正控：不许靠「一律不许删」把负例变绿。
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assert, assertEquals } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const { createRuntime } = await import(join(ROOT, 'src/core/core.js'));

/** 五个账本是否都干净：服务本体、归属、登记实例、登记 ID、接管回执。 */
const ledgerClean = (core, name) => ({
  services: core._services.has(name),
  owners: core._serviceOwners.has(name),
  registrar: core._serviceRegistrar.has(name),
  regIds: core._serviceRegIds.has(name),
  takeovers: core._serviceTakeovers.has(name),
});

const allClean = (core, name) => Object.values(ledgerClean(core, name)).every((v) => v === false);

export async function setup(runner) {
  let tmp;
  runner.beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'r16-receipt-')); });
  runner.afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 不影响结论 */ } });

  let seq = 0;
  const mk = () => {
    const { core, host } = createRuntime({ stateDir: join(tmp, `s${++seq}`) });
    core.log = () => {};
    return { core, host };
  };

  /** 一笔受信装配：`instance` 是登记实例（插件对象身份，不是可枚举的名字）。 */
  const assembly = (core, owner, instance, fn) => core._runAssemblyContext(owner, fn, core.assemblyEpoch, instance);

  // ── R16-01a：真实 _load 里 init 发布 A → host 接管 B → init 失败 ──────────
  runner.test('R16-01a 旧装配失败清理不得删掉合法 host 接管的那笔登记', async () => {
    const { core, host } = mk();
    let release; const gate = new Promise((r) => { release = r; });
    let ready; const started = new Promise((r) => { ready = r; });
    const plugin = {
      name: 'slow-loader', version: '1.0.0',
      async init(c) {
        c.registerService('shared-db', { who: 'old-plugin' });
        ready();
        await gate;
        throw Object.assign(new Error('injected_init_failure'), { code: 'test_failure' });
      },
      async start() {}, async stop() {},
    };
    const running = core.lifecycle.load(plugin, core, { epoch: core.assemblyEpoch })
      .then(() => ({ ok: true }), (e) => ({ ok: false, code: e.code }));
    await started;
    const before = core.getServiceOwnership('shared-db');
    host.takeoverService('shared-db', { who: 'new-host' });
    const newer = core.getServiceOwnership('shared-db');
    release();
    const load = await running;
    const after = core.getServiceOwnership('shared-db');

    assertEquals(load.ok, false, '这次装配必须真的失败（否则本用例不证明清理路径跑过）');
    assertEquals(load.code, 'test_failure');
    assertEquals(before.registrationId, 1);
    assertEquals(after.registered, true, 'B 必须还在');
    assertEquals(after.owner, '@host');
    assertEquals(after.registrationId, newer.registrationId, '登记 ID 不许被旧装配改回去');
    assertEquals(core.getService('shared-db')?.who, 'new-host', '服务对象不许被旧账擦掉');
    assertEquals(after.takeover?.newRegistrationId, newer.registrationId, '接管回执照旧有效');
  });

  // ── R16-01b：拿旧装配的收据手工撤销（服务当前是 B）→ stale，不动 B ───────
  runner.test('R16-01b 旧收据只失效不执行（compare-and-delete）', async () => {
    const { core, host } = mk();
    const instA = { name: 'A' };
    const old = await assembly(core, 'A', instA, () => core.registerService('db', { who: 'A' }));
    host.takeoverService('db', { who: 'HOST' });
    const idHost = core.getServiceOwnership('db').registrationId;
    const out = core.discardAssemblyArtifacts(old);
    assertEquals(out.services.length, 0, '旧账一笔都不许收回');
    assertEquals(core.getServiceOwnership('db').registered, true);
    assertEquals(core.getServiceOwnership('db').owner, '@host');
    assertEquals(core.getServiceOwnership('db').registrationId, idHost);
    assertEquals(core.getService('db')?.who, 'HOST');
  });

  // ── R16-01c：普通装配失败、没有后继登记 → 必须真的收回自己那笔 ───────────
  runner.test('R16-01c 正控：普通失败装配仍要释放自己登记的服务', async () => {
    const { core } = mk();
    const own = await assembly(core, 'B', { name: 'B' }, () => core.registerService('temporary', { who: 'B' }));
    const out = core.discardAssemblyArtifacts(own);
    assertEquals(out.services.join(','), 'temporary', '自己那笔必须被收回');
    assertEquals(core.getServiceOwnership('temporary').registered, false);
    assert(allClean(core, 'temporary'), '五个账必须一起清干净');
  });

  // ── R16-01d：host 按精确 ID 主动释放 → 五类账本同步清除 ──────────────────
  runner.test('R16-01d 正控：宿主按登记 ID 释放后不留任何账', async () => {
    const { core, host } = mk();
    host.registerService('host-only', { who: 'HOST-ONLY' });
    const id = core.getServiceOwnership('host-only').registrationId;
    const r = host.releaseService('host-only', id);
    assertEquals(r.ok, true);
    assertEquals(r.registrationId, id);
    assertEquals(core.getServiceOwnership('host-only').registered, false);
    assertEquals(core.getServiceOwnership('host-only').registrationId, null, '不许留下活的登记 ID');
    assert(allClean(core, 'host-only'), '五个账必须同步清除');
  });

  // ── R16-01e：拿旧 ID 撤销 B → 拒绝，B 不变 ──────────────────────────────
  runner.test('R16-01e 旧登记 ID 不得撤销新登记', async () => {
    const { core, host } = mk();
    const instA = { name: 'A' };
    await assembly(core, 'A', instA, () => core.registerService('db', { who: 'A' }));
    const idA = core.getServiceOwnership('db').registrationId;
    host.takeoverService('db', { who: 'HOST' });
    const idHost = core.getServiceOwnership('db').registrationId;
    const r = host.releaseService('db', idA);
    assertEquals(r.ok, false);
    assertEquals(r.code, 'stale_registration');
    assertEquals(core.getServiceOwnership('db').registrationId, idHost);
    assertEquals(core.getService('db')?.who, 'HOST');
  });

  // ── R16-01f：重复撤销已删除的 B → 不得再次 ok:true（幽灵回执）───────────
  runner.test('R16-01f 同一 ID 重复撤销：第二次必须是 stale，不是成功', async () => {
    const { core, host } = mk();
    host.registerService('db', { who: 'HOST' });
    const id = core.getServiceOwnership('db').registrationId;
    assertEquals(host.releaseService('db', id).ok, true);
    const again = host.releaseService('db', id);
    assertEquals(again.ok, false, '服务已经不存在，不许再报"释放成功"');
    assertEquals(again.code, 'stale_registration');
    assertEquals(core.getServiceOwnership('db').registrationId, null);
  });

  // ── R16-01g：A₁ 失败、A₂ 同名合法登记 → A₁ 不能清理 A₂ ───────────────────
  runner.test('R16-01g 迟到的旧清理不得删掉同名的新登记', async () => {
    const { core } = mk();
    const s1 = await assembly(core, 'p1', { name: 'p1' }, () => core.registerService('x', { v: 1 }));
    assertEquals(core.discardAssemblyArtifacts(s1).services.join(','), 'x', '第一次清理收回自己那笔');
    const s2 = await assembly(core, 'p2', { name: 'p2' }, () => core.registerService('x', { v: 2 }));
    const id2 = core.getServiceOwnership('x').registrationId;
    const late = core.discardAssemblyArtifacts(s1);
    assertEquals(late.services.length, 0, '同一份旧账再执行一次必须是空操作');
    assertEquals(core.getServiceOwnership('x').registered, true);
    assertEquals(core.getServiceOwnership('x').registrationId, id2);
    assertEquals(core.getService('x').v, 2);
    core.discardAssemblyArtifacts(s2);
  });

  // ── R16-01h：同一插件 init/start 两阶段更新服务 → 合法、账本一致 ─────────
  runner.test('R16-01h 正控：init/start 同名更新合法且只留最后一笔', async () => {
    const { core } = mk();
    let c0 = null;
    const plugin = {
      name: 'two-phase', version: '1.0.0',
      async init(c) { c0 = c; c.registerService('svc', { stage: 'init' }); },
      async start() { c0.registerService('svc', { stage: 'start' }); },
      async stop() {},
    };
    await core.lifecycle.load(plugin, core, { epoch: core.assemblyEpoch });
    const own = core.getServiceOwnership('svc');
    assertEquals(own.registered, true);
    assertEquals(own.owner, 'two-phase');
    assertEquals(core.getService('svc').stage, 'start', '后一次提交必须生效');
    assertEquals(typeof own.registrationId, 'number');
    await core.lifecycle.unload('two-phase');
    assertEquals(core.getServiceOwnership('svc').registered, false, '正常卸载仍要清干净');
    assert(allClean(core, 'svc'));
  });

  // ── R16-01i：两笔装配交错复用同名 → 只清自己创建的登记 ───────────────────
  runner.test('R16-01i 交错的第三笔登记不受任何旧账影响', async () => {
    const { core, host } = mk();
    const s1 = await assembly(core, 'p1', { name: 'p1' }, () => core.registerService('k', { v: 1 }));
    host.takeoverService('k', { v: 'H' });
    const idH = core.getServiceOwnership('k').registrationId;
    assertEquals(host.releaseService('k', idH).ok, true, '宿主那笔自己合法释放');
    const s2 = await assembly(core, 'p2', { name: 'p2' }, () => core.registerService('k', { v: 3 }));
    const id3 = core.getServiceOwnership('k').registrationId;
    assertEquals(core.discardAssemblyArtifacts(s1).services.length, 0, '第一笔的旧账已经失效');
    assertEquals(core.getServiceOwnership('k').registrationId, id3);
    assertEquals(core.getService('k').v, 3);
    assertEquals(core.discardAssemblyArtifacts(s2).services.join(','), 'k', '第三笔自己的账仍可收回');
  });

  // ── R16-01j：插件 stop/卸载正常释放自己的服务 → 不留幽灵 ─────────────────
  runner.test('R16-01j 正控：卸载按登记实例清场，不留幽灵服务', async () => {
    const { core } = mk();
    const plugin = {
      name: 'owner-1', version: '1.0.0',
      async init(c) { c.registerService('mine', { who: 'owner-1' }); },
      async start() {}, async stop() {},
    };
    const store = await core.lifecycle.load(plugin, core, { epoch: core.assemblyEpoch });
    assertEquals(core.getServiceOwnership('mine').registered, true);
    await core.lifecycle.unload('owner-1');
    assertEquals(core.getServiceOwnership('mine').registered, false);
    assert(allClean(core, 'mine'), '卸载后五个账都不许留尾巴');
    // 拿到自己那笔已经卸载的账再执行一次，也只能是空操作。
    assertEquals(core.discardAssemblyArtifacts(store).services.length, 0);
  });

  // ── R16-01k：依赖方仍运行 + 宿主接管 provider → 旧清理不破坏依赖方 ───────
  runner.test('R16-01k 宿主接管后，旧装配清理不得破坏正在运行的依赖方', async () => {
    const { core, host } = mk();
    const old = await core.lifecycle.load({
      name: 'prov', version: '1.0.0',
      async init(c) { c.registerService('store', { who: 'prov' }); },
      async start() {}, async stop() {},
    }, core, { epoch: core.assemblyEpoch });
    await core.lifecycle.load({
      name: 'dep', version: '1.0.0', requires: { store: '*' },
      async init() {}, async start() {}, async stop() {},
    }, core, { epoch: core.assemblyEpoch });
    host.takeoverService('store', { who: 'host-store' });
    assertEquals(core.discardAssemblyArtifacts(old).services.length, 0);
    assertEquals(core.getService('store')?.who, 'host-store', '依赖方还在跑的期间，服务对象不许消失');
    assertEquals(core.plugins.get('dep')?.state, 'running');
    assertEquals(core.getServiceOwnership('store').owner, '@host');
    await core.stop();
  });

  // ── R16-01l：观察者抛错（同步/异步）不得把已提交事实倒写成失败 ───────────
  runner.test('R16-01l 观察者的异常不改写已提交的登记事实', async () => {
    const { core, host } = mk();
    host.registerService('db', { who: 'OLD' });
    const sync = []; const asyncs = [];
    core.on('core:service.conflict', () => { sync.push(1); throw new Error('sync-observer-boom'); });
    core.on('core:service.conflict', async () => { asyncs.push(1); throw new Error('async-observer-boom'); });
    const r = host.takeoverService('db', { who: 'NEW' });
    assertEquals(r, undefined, '接管本身不得因为观察者抛错而失败');
    const own = core.getServiceOwnership('db');
    assertEquals(own.owner, '@host');
    assertEquals(core.getService('db')?.who, 'NEW', '已提交的服务对象不许被观察者倒回去');
    assertEquals(sync.length, 1, '同步观察者确实被调用过');
    assertEquals(asyncs.length, 1, '异步观察者确实被调用过');
    await new Promise((r2) => setTimeout(r2, 30));
    const errs = core.getObserverErrors?.() ?? [];
    assert(errs.some((e) => String(e?.message ?? '').includes('sync-observer-boom')), '同步异常必须被记账，不许静默');
    assert(errs.some((e) => String(e?.message ?? '').includes('async-observer-boom')), '异步异常必须被消费并记账，不许变成 unhandledRejection');
  });
}
