// R0-032（rc.15）：世代与登记实例**只能由外层下传**，公开入口不得把它们抹掉。
//
// F05 服务侧反例的真实形状（本文件全部落在真 Core 上，不模拟）：
// `runServiceTracking` 是**公开**入口，传给 `_runAssemblyContext` 的 `epoch` 是 null。
// 旧世代装配只要在 init 里调一次它，就能拿到一个「无世代、无实例」的内层 store，
// 于是两道判据同时失效：
//   ① 世代闸门 `asm?.epoch != null` 短路 ⇒ 服务与能力双双漏进新一代（修前实测 ALLOWED）；
//   ② 内层账不回挂外层 ⇒ 外层失败清理 `discardAssemblyArtifacts` 收不回内层登记。
//
// 判据必须同时钉住两个方向：
//   · 负例：旧世代 + 嵌套公开入口 ⇒ 必须 `assembly_superseded`，且表里不留条目；
//   · 正例：**同代**装配里嵌套公开入口 ⇒ 仍必须能用（不许用"一律拒绝"通过负例）；
//   · 边界：内层不得因此获得 `trusted`（否则 provider 可自铸，S6 裁决作废）。
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assert, assertEquals } from '../harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (rel) => import(join(ROOT, rel));

export async function setup(runner) {
  const { Core } = await imp('src/core/core.js');

  function makeCore() {
    const dir = mkdtempSync(join(tmpdir(), 'r032-'));
    const core = new Core({ stateDir: join(dir, 'state') });
    core.log = () => {};
    return {
      core,
      done() {
        try { core.removeAllListeners(); } catch { /* 尽力而为 */ }
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  /** 在受信装配（epoch ≠ null）里跑 fn，并在 fn 内部把世代做旧 —— 模拟「装配期间 Core 换代」。 */
  async function inSupersededAssembly(core, fn) {
    let thrown = null;
    const store = await core._runAssemblyContext('plugin-a', async () => {
      core._epoch += 1; // 旧世代：这笔装配已经没有提交权
      try { await fn(); } catch (e) { thrown = e; }
    }, core.assemblyEpoch);
    return { store, thrown };
  }

  runner.test('R0-032/1 旧世代装配经**嵌套公开入口**注册服务必须被拒（修前 ALLOWED）', async () => {
    const { core, done } = makeCore();
    try {
      const { thrown } = await inSupersededAssembly(core, async () => {
        await core.runServiceTracking('attacker', async () => {
          core.registerService('late-svc', { x: 1 });
        });
      });
      assertEquals(thrown?.code, 'assembly_superseded',
        `嵌套公开入口不得成为绕过世代闸门的跳板，实际：${thrown ? thrown.code ?? thrown.message : 'ALLOWED'}`);
      assertEquals(core._services.has('late-svc'), false, '被拒之后服务不得留在表里');
      assertEquals(core.getServiceOwnership('late-svc').registered, false, 'getServiceOwnership 必须同样报告未登记');
    } finally { done(); }
  });

  runner.test('R0-032/2 同一跳板注册**能力**同样必须被拒（反例不止服务侧）', async () => {
    const { core, done } = makeCore();
    try {
      const { thrown } = await inSupersededAssembly(core, async () => {
        await core.runServiceTracking('attacker', async () => {
          core.registerCapability('late-cap', { handler: async () => 1 });
        });
      });
      assertEquals(thrown?.code, 'assembly_superseded',
        `能力侧与服力侧必须同形，实际：${thrown ? thrown.code ?? thrown.message : 'ALLOWED'}`);
      assertEquals(core._capabilities.has('late-cap'), false, '被拒之后能力不得留在表里');
    } finally { done(); }
  });

  runner.test('R0-032/3 内层登记的账必须回挂外层：外层失败清理要能收干净', async () => {
    const { core, done } = makeCore();
    try {
      let outerStore = null;
      // 外层**不**换代（这个是清理账的问题，不是世代问题），跑完正常抛错。
      await core._runAssemblyContext('plugin-a', async () => {
        await core.runServiceTracking('plugin-a', async () => {
          core.registerService('inner-svc', { x: 1 });
          core.registerCapability('inner-cap', { handler: async () => 1 });
        });
        throw new Error('init 失败，触发外层清理');
      }, core.assemblyEpoch).catch((e) => { outerStore = e.assemblyStore; });

      assert(outerStore, '失败路径必须把本次装配的账交出来');
      assertEquals(core._services.has('inner-svc'), true, '前提：此刻内层服务确实已登记');
      core.discardAssemblyArtifacts(outerStore);
      assertEquals(core._services.has('inner-svc'), false,
        '内层登记若只记在内层账上，外层清理就收不回它（修前实测清理后仍在表里）');
      assertEquals(core._capabilities.has('inner-cap'), false, '能力侧同理');
    } finally { done(); }
  });

  runner.test('R0-032/4 反向判据：**同代**装配里嵌套公开入口仍然可用（不许一律拒绝）', async () => {
    const { core, done } = makeCore();
    try {
      const store = await core._runAssemblyContext('plugin-a', async () => {
        await core.runServiceTracking('plugin-a', async () => {
          core.registerService('ok-svc', { x: 1 });
          core.registerCapability('ok-cap', { handler: async () => 1 });
        });
      }, core.assemblyEpoch);
      assertEquals(core._services.has('ok-svc'), true, '同代嵌套是合法用法，必须真的登记成功');
      assertEquals(core._capabilities.has('ok-cap'), true, '能力侧同代嵌套同理');
      // 同代嵌套登记也必须在**外层**账上，否则正常路径的后续清理会漏。
      assertEquals(store.serviceNames.has('ok-svc'), true, '外层账必须记到内层发布的服务');
      assertEquals(store.capabilities.size >= 1, true, '外层账必须记到内层发布的能力');
    } finally { done(); }
  });

  runner.test('R0-032/5 边界：内层不得因外层受信而自铸 provider（S6 裁决不许被顺手作废）', async () => {
    const { core, done } = makeCore();
    try {
      await core._runAssemblyContext('trusted-plugin', async () => {
        await core.runServiceTracking('attacker', async () => {
          core.registerCapability('inner-trusted', { owner: 'attacker', handler: async () => 1 });
        });
      }, core.assemblyEpoch);
      const rec = core._capabilities.get('inner-trusted');
      assert(rec, '前提：这条能力应当登记成功（同代嵌套是合法用法）');
      assertEquals(rec.provider, null,
        '内层 store 的 trusted 必须只取决于**本层**是否显式给了世代；'
        + `若继承外层受信，任何插件都能用公开入口冒名顶替，实际 provider=${JSON.stringify(rec.provider)}`);
    } finally { done(); }
  });
}
