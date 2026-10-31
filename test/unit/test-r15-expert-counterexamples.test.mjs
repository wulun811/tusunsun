// R15（rc.16）：专家独立复审提出的三条实现层反例，逐条落成回归。
//
// 三条的共同点：**授权/保护判据被写成了一句看起来等价的字符串或集合比较**。
//   ① R15-01 `_pendingDependentsOf` 的环豁免用“出现在任意一个环里”代替“同一个 SCC”，
//      于是两个不相干的环之间那条真实依赖边被一起豁免 —— 账面有序，事实拆了；
//   ② R15-02 `issueLifecycleReaper()` 是公开方法，而 `core.plugins` 是公开 Map，
//      “要求真实 instance”于是不是授权条件；
//   ③ R15-03 `runServiceTracking(owner, fn)` 的自报 owner 直接进了 `_commitService` 的
//      “同 owner 更新”分支，等于“自报一个名字即成为管理者”。
//
// 每条都必须带**合法正控**：不能靠“一律禁止停机/更新/释放”把负例变绿。
// 边界（不夸大口径）：这仍是同进程受管 API 的纪律，不是 OS 级不可信 JS 隔离。
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assert, assertEquals } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(join(ROOT, rel));

/** 具名错误码；没有 code 时把 message 原样交出来，避免断言“抛了就算过”。 */
const codeOf = (fn) => {
  try { fn(); return null; } catch (e) { return e?.code ?? `(no code) ${e?.message}`; }
};

export async function setup(runner) {
  const { Core } = await imp('src/core/core.js');
  let tmp;

  runner.beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'r15-')); });
  runner.afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ } });

  const newCore = () => {
    const core = new Core({ stateDir: join(tmp, `state-${Math.random().toString(16).slice(2)}`) });
    core.log = () => {};
    core._stopAssemblyDrainMs = 20;
    core._stopLockMs = 120;
    return core;
  };

  /** 建一台 Core 并按定义装配；`calls` 记真的被调用过 stop() 的插件名。 */
  const boot = async (specs) => {
    const calls = [];
    const core = newCore();
    for (const p of specs) {
      await core.register({
        name: p.name, version: '1.0.0',
        ...(p.requires ? { requires: p.requires } : {}),
        ...(p.provides ? { provides: p.provides } : {}),
        ...(p.init ? { init: p.init } : { init: async () => {} }),
        async start() {},
        async stop() {
          calls.push(p.name);
          if (p.hang) await new Promise(() => {});   // 永不返回：模拟卡死的收尾
        },
      });
    }
    await core.start();
    let payload = null;
    core.on('core.stopped', (e) => { payload = e; });
    return { core, calls, stop: async () => { await core.stop(); return payload; } };
  };

  // ── R15-01：跨 SCC 的活依赖不得被环豁免 ────────────────────────────────
  runner.test('R15-01 两个独立环 + 跨环活依赖：提供方一次都不许被停', async () => {
    // a↔b 与 c↔d 两个环，再加一条 c → a（c 硬依赖 a）。c.stop() 卡住。
    const { core, calls, stop } = await boot([
      { name: 'a', requires: { b: '*' } },
      { name: 'b', requires: { a: '*' } },
      { name: 'c', requires: { d: '*', a: '*' }, hang: true },
      { name: 'd', requires: { c: '*' } },
    ]);
    const payload = await stop();

    assertEquals(JSON.stringify(core.plugins.get('c')?.state), '"running"', '卡住的依赖方不得被标成已停');
    assertEquals(JSON.stringify(payload.stopOrderCycles.length), '2', '两个环都必须被具名报出');
    // 事实：c 还在 running，跨 SCC 依赖的 a 一次都不许被停。
    assert(!calls.includes('a'), `a 仍被 c 依赖，不得被停；实际调用序列：${JSON.stringify(calls)}`);
    assertEquals(core.plugins.get('a')?.state, 'running', 'a 必须原样留在 running');
    // 跳过必须具名可读，且与失败分开。
    const skipped = payload.stopSkipped ?? [];
    assert(skipped.length === 1 && skipped[0].plugin === 'a'
      && skipped[0].code === 'skipped_dependents_pending'
      && skipped[0].dependents.includes('c'),
    `跨 SCC 的跳过必须具名交出，实际：${JSON.stringify(skipped)}`);
    assert(!(payload.stopFailures ?? []).some((f) => f.plugin === 'a'), 'a 是“根本没动”，不得混进 stopFailures');
  });

  runner.test('R15-01 正控：同一张图但 c 正常停止 ⇒ 四个全停，没有跳过', async () => {
    const { core, calls, stop } = await boot([
      { name: 'a', requires: { b: '*' } },
      { name: 'b', requires: { a: '*' } },
      { name: 'c', requires: { d: '*', a: '*' } },
      { name: 'd', requires: { c: '*' } },
    ]);
    const payload = await stop();
    assertEquals(JSON.stringify(calls.slice().sort()), JSON.stringify(['a', 'b', 'c', 'd']), '跨 SCC 依赖边本身不阻止停机');
    assertEquals(JSON.stringify(payload.stopSkipped ?? []), '[]', '没有卡住时不该有任何跳过');
    assertEquals(JSON.stringify(core.plugins.get('a')?.state), '"stopped"');
  });

  // ── R15-02：公开面不得签发“管理员证件” ────────────────────────────────
  runner.test('R15-02 公开清场签发入口必须消失，且合法卸载仍精确回收', async () => {
    const core = newCore();
    assertEquals(core.issueLifecycleReaper, undefined, '公开签发清场闭包的入口必须从公开面消失');
    let victimInst = null;
    await core.register({
      name: 'victim', version: '1.0.0',
      async init(c) {
        victimInst = this;
        c.registerService('secret-service', { who: 'victim' });
        c.registerCapability('victim.cap', { owner: 'victim', handler: async () => 42 });
      },
      async start() {}, async stop() {},
    });
    await core.register({ name: 'other', version: '1.0.0', async init(c) { c.registerService('other-service', { who: 'other' }); }, async start() {}, async stop() {} });
    await core.start();
    assert(core.getServiceOwnership('secret-service').registered && core.getServiceOwnership('other-service').registered);

    // 正控：**合法生命周期收尾**照样能精确回收自己那份，且不误删别人。
    await core.lifecycle.unload('victim');
    assertEquals(core.getServiceOwnership('secret-service').registered, false, '自己的服务必须被回收');
    assertEquals(core.getServiceOwnership('other-service').registered, true, '别人的服务不得被连带删除');
    assertEquals(core.listCapabilities().some((x) => x.id === 'victim.cap'), false, '自己的能力必须被回收');
    assert(victimInst !== null, '正控必须走真实插件实例');
  });

  // ── R15-03：自报 owner 不得授权同 owner 覆盖 ──────────────────────────
  runner.test('R15-03 自报 owner 的同名更新必须被拒，合法正控仍在', async () => {
    const core = newCore();
    // 正控 1：同一插件在自己的受信装配里（init 登记、start 更新）更新同一笔服务 ⇒ 允许。
    // 注意 `start()` 拿不到 core（装载器的契约就是 `plugin.start()`），故用 init 里的句柄。
    let victimCore = null;
    const victim = {
      name: 'victim', version: '1.0.0',
      async init(c) { victimCore = c; c.registerService('db', { who: 'victim-v1' }); },
      async start() { victimCore.registerService('db', { who: 'victim-v2' }); },
      async stop() {},
    };
    await core.register(victim);
    await core.start();
    assertEquals(core.getService('db').who, 'victim-v2', '同一装配实例更新自己的登记必须仍然允许');

    const before = core.getServiceOwnership('db');
    // 反例：公开的 runServiceTracking 让调用方自报 owner；它只能用于观测，不是授权。
    let code = null;
    await core.runServiceTracking('victim', async () => {
      code = codeOf(() => core.registerService('db', { who: 'attacker' }));
    });
    assertEquals(code, 'service_conflict', '自报 owner 的覆盖必须被具名拒绝');
    assertEquals(core.getService('db').who, 'victim-v2', '服务对象不得被换掉');
    assertEquals(core.getServiceOwnership('db').owner, 'victim', '归属记录不得变');
    assertEquals(core.getServiceOwnership('db').registrationId, before.registrationId, '被拒的覆盖不得产生新登记身份');
    // 宿主控制面接管是**另一条**授权通道，已有专测（F05-H13/H17），此处不重复。
  });
}
