// R0-031（rc.15）：撤销权属于「登记」，不属于名字。
//
// 专家裁决（RC14-IDENT/S6 代持语义包 v1.0，A 方案）把话说死：
// **能力名称用于定位，声明 owner 用于署名，可信登记身份用于归责，单次登记凭据用于撤销；
// 任何可列举的字符串都不构成授权。**
//
// 本文件把该包的强制验收矩阵 ID-01～ID-16 落到**真实实现**上（真 Core、真 LifecycleManager、
// 真 ToolLoader），不模拟门面。参考模型（`probes/registration-lease-contract.test.mjs`）
// 只是设计演示，它的绿灯不覆盖这里的任何一条。
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assert, assertEquals } from '../harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (rel) => import(join(ROOT, rel));

export async function setup(runner) {
  const { Core } = await imp('src/core/core.js');
  const { default: toolLoader } = await imp('plugins/tool-loader.js');

  /** 真 Core + 临时 stateDir/pluginsDir（含空 tools/，tool-loader 的 init 要扫它）。 */
  function makeCore() {
    const dir = mkdtempSync(join(tmpdir(), 'r031-'));
    const pluginsDir = join(dir, 'plugins');
    mkdirSync(join(pluginsDir, 'tools'), { recursive: true });
    const core = new Core({ stateDir: join(dir, 'state'), pluginsDir });
    core.log = () => {};
    return {
      core,
      done() {
        try { core.removeAllListeners(); } catch { /* 尽力而为 */ }
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  /** 受信装配上下文（与 lifecycle-manager 走同一条路径：epoch ≠ null ⇒ trusted）。 */
  const asm = (core, owner, fn, instance = null) => core._runAssemblyContext(owner, fn, core.assemblyEpoch, instance);

  /** 最小的合法插件对象：真 LifecycleManager 认它，能走完整 load/unload。 */
  const plugin = (name, init, stop) => ({
    name, version: '1.0.0', state: 'registered',
    async init(core) { await init?.(core); },
    async stop() { await stop?.(); },
  });

  /** 装一个真 tool-registry（真 ToolLoader 单例），并清掉上一个用例的目录残留。 */
  async function withRegistry(core) {
    toolLoader._tools.clear();
    await asm(core, 'tool-loader', () => toolLoader.init(core), toolLoader);
    return core.getService('tool-registry');
  }

  const keys = (o) => Object.keys(o).sort().join(',');

  runner.test('R0-031/ID-01 声明 owner 与登记 provider 分离，凭据不出现在公开面', async () => {
    const { core, done } = makeCore();
    try {
      await asm(core, 'tool-loader', () => {
        core.registerCapability('tool.write', { owner: 'tool-write', handler: () => 1 });
      }, { name: 'tool-loader' });
      const row = core.listCapabilities().find((c) => c.id === 'tool.write');
      assertEquals(row.owner, 'tool-write', 'owner 是署名，可公开');
      assertEquals(row.provider, 'tool-loader', 'provider 是登记方，可公开但同样无权授权');
      // 公开面**只能**有这三项：登记身份与凭据不得被枚举出去。
      assertEquals(keys(row), 'id,owner,provider', 'listCapabilities 不得泄露登记身份/凭据');
      const json = JSON.stringify(core.listCapabilities());
      assert(!/registrationId|handle|__opaque/.test(json), '序列化面也不得出现凭据字段');
    } finally { done(); }
  });

  runner.test('R0-031/ID-02 仅知 owner/provider 字符串不得释放，能力仍可调用', async () => {
    const { core, done } = makeCore();
    try {
      await asm(core, 'tool-loader', () => {
        core.registerCapability('tool.write', { owner: 'tool-write', handler: () => 'ALIVE' });
      }, { name: 'tool-loader' });
      for (const cred of ['tool-write', 'tool-loader', undefined, null]) {
        let code = null;
        try { core.releaseCapability('tool.write', cred); } catch (e) { code = e.code; }
        assertEquals(code, 'capability_release_denied', `凭据 ${String(cred)} 不得撤销`);
      }
      assertEquals((await core.callCapability('tool.write', {})).payload, 'ALIVE', '原能力必须完好');
    } finally { done(); }
  });

  runner.test('R0-031/ID-03 只知道公开 provider 也无法覆盖，批量按名入口已不存在', async () => {
    const { core, done } = makeCore();
    try {
      await asm(core, 'tool-loader', () => {
        core.registerCapability('tool.write', { owner: 'tool-write', handler: () => 'HOST' });
      }, { name: 'tool-loader' });
      let conflict = false;
      try {
        await asm(core, 'tool-loader', () => {
          core.registerCapability('tool.write', { owner: 'tool-write', override: true, handler: () => 'EVIL' });
        }, { name: 'tool-loader' });
      } catch (e) { conflict = /capability_conflict/.test(e.message); }
      assertEquals(conflict, true, '同 provider 的字符串相等也不构成覆盖授权');
      assertEquals(typeof core.releaseCapabilitiesByOwner, 'undefined', 'ID-10：按名的批量能力入口必须消失');
      assertEquals(typeof core.releaseServicesByOwner, 'undefined', 'ID-10：按名的批量服务入口必须消失');
      assertEquals((await core.callCapability('tool.write', {})).payload, 'HOST');
    } finally { done(); }
  });

  runner.test('R0-031/ID-04 持凭据撤销自己的登记：成功且只回收那一条', async () => {
    const { core, done } = makeCore();
    try {
      const h = core.registerCapability('solo.op', { owner: 'A', handler: () => 1 });
      core.registerCapability('other.op', { owner: 'A', handler: () => 2 });
      assertEquals(core.releaseRegistration(h), true);
      assertEquals(await core.hasCapability('solo.op'), false);
      assertEquals(await core.hasCapability('other.op'), true, '不得顺带删掉同 owner 的其它登记');
    } finally { done(); }
  });

  runner.test('R0-031/ID-05 plugin.stop() 未携任何装配上下文，凭凭据仍能释放', async () => {
    const { core, done } = makeCore();
    try {
      let handle = null;
      const p = plugin('holder', (c) => {
        handle = c.registerCapability('holder.op', { owner: 'holder', handler: () => 'V1' });
      }, () => { if (handle) core.releaseRegistration(handle); });
      await core.register(p);
      await core.lifecycle.load(p, core);
      assertEquals(await core.hasCapability('holder.op'), true);
      // 装配上下文之外 —— 这里没有 ALS，凭据是唯一的授权来源。
      assertEquals(core.currentAssembly(), null, 'stop() 期间不应存在装配上下文');
      await p.stop();
      assertEquals(await core.hasCapability('holder.op'), false, '合法释放必须仍然能用');
    } finally { done(); }
  });

  runner.test('R0-031/ID-06 ToolLoader 代持：能力与目录一同正确撤销', async () => {
    const { core, done } = makeCore();
    try {
      const registry = await withRegistry(core);
      let reg = null;
      await asm(core, 'producer-p', () => {
        reg = registry.registerTool({ name: 'tool-demo', owner: 'producer-p', description: 'd', execute: () => 'V' });
      }, { name: 'producer-p' });
      assertEquals(reg.ok, true);
      assertEquals(reg.registered_capability, true, '能力登记成功时目录项必须知道"这是我登记的"');
      assert(core.listCapabilities().some((c) => c.id === 'tool.demo'));
      // 在装配上下文之外、只凭目录句柄注销。
      const u = registry.unregisterTool({ name: 'tool-demo', owner: 'producer-p', handle: reg.handle });
      assertEquals(u.ok, true);
      assertEquals(u.capability_released, true);
      assertEquals(u.directory_removed, true);
      assertEquals(toolLoader._tools.has('tool-demo'), false);
      assertEquals(await core.hasCapability('tool.demo'), false);
    } finally { done(); }
  });

  runner.test('R0-031/ID-07 旧凭据不得撤销同 ID 的新登记（ABA）', async () => {
    const { core, done } = makeCore();
    try {
      const h1 = core.registerCapability('aba.op', { owner: 'A', handler: () => 'R1' });
      assertEquals(core.releaseRegistration(h1), true);
      const h2 = core.registerCapability('aba.op', { owner: 'A', handler: () => 'R2' });
      assertEquals(core.releaseRegistration(h1), false, '旧凭据只能指向旧登记，迟到撤销必须是 stale');
      assertEquals((await core.callCapability('aba.op', {})).payload, 'R2', 'R2 不得受影响');
      assertEquals(core.releaseRegistration(h2), true);
    } finally { done(); }
  });

  runner.test('R0-031/ID-08 同名覆盖换 handler 后，旧凭据只能影响旧登记', async () => {
    const { core, done } = makeCore();
    try {
      const h1 = core.registerCapability('ov.op', { owner: 'A', handler: () => 'V1' });
      const h2 = core.registerCapability('ov.op', { owner: 'A', overrideBy: h1, handler: () => 'V2' });
      assert(h2 && h2 !== h1, '覆盖必须铸一笔新登记（新凭据）');
      assertEquals(core.releaseRegistration(h1), false);
      assertEquals((await core.callCapability('ov.op', {})).payload, 'V2', '新 handler 不得被旧凭据删掉');
      assertEquals(core.releaseRegistration(h2), true);
    } finally { done(); }
  });

  runner.test('R0-031/ID-09 迟到的装配失败清理不得删除新装配的同名能力', async () => {
    const { core, done } = makeCore();
    try {
      const store = await asm(core, 'A', () => {
        core.registerCapability('aba2.op', { owner: 'A', handler: () => 'R1' });
      }, { name: 'A' });
      const [h1] = [...store.capabilities];
      assertEquals(core.releaseRegistration(h1), true);
      // 新装配发布同名能力（R2）
      core.registerCapability('aba2.op', { owner: 'B', handler: () => 'R2' });
      const discarded = core.discardAssemblyArtifacts(store);
      assertEquals(discarded.capabilities.length, 0, '旧装配的账只能判 stale，不得误删 R2');
      assertEquals((await core.callCapability('aba2.op', {})).payload, 'R2');
    } finally { done(); }
  });

  runner.test('R0-031/ID-10 冒用他人名字的批量清场路径不存在，资产不变', async () => {
    const { core, done } = makeCore();
    try {
      await asm(core, 'A', () => {
        core.registerCapability('a.op', { owner: 'A', handler: () => 'A-REAL' });
        core.registerService('svc.a', { by: 'A' });
      }, { name: 'A' });
      // 公开面既没有按名批量入口，单项入口也只认真凭据。
      assertEquals(typeof core.releaseCapabilitiesByOwner, 'undefined');
      let denied = false;
      try { core.releaseCapability('a.op', 'A'); } catch { denied = true; }
      assertEquals(denied, true);
      assertEquals((await core.callCapability('a.op', {})).payload, 'A-REAL');
      assertEquals(core.getServiceOwnership('svc.a').owner, 'A', 'A 的服务归属不得被按名抹掉');
    } finally { done(); }
  });

  runner.test('R0-031/ID-11 工具注册冲突时目录明确降级，注销绝不冒领他人能力', async () => {
    const { core, done } = makeCore();
    try {
      const registry = await withRegistry(core);
      core.registerCapability('tool.ext', { owner: 'host', handler: () => 'HOST-REAL' });
      let reg = null;
      await asm(core, 'producer-q', () => {
        reg = registry.registerTool({ name: 'tool-ext', owner: 'producer-q', execute: () => 'MINE' });
      }, { name: 'producer-q' });
      assertEquals(reg.ok, true, '能力冲突不阻止目录登记（工具仍可见）');
      assertEquals(reg.registered_capability, false, '但必须明确降级：这笔能力不是我登记的');
      const u = registry.unregisterTool({ name: 'tool-ext', owner: 'producer-q', handle: reg.handle });
      assertEquals(u.capability_released, false, '注销不得动宿主的能力');
      assertEquals((await core.callCapability('tool.ext', {})).payload, 'HOST-REAL');
    } finally { done(); }
  });

  runner.test('R0-031/ID-12 unregisterTool 不认 owner 字符串，冒名注销必须拒绝', async () => {
    const { core, done } = makeCore();
    try {
      const registry = await withRegistry(core);
      let reg = null;
      await asm(core, 'producer-p', () => {
        reg = registry.registerTool({ name: 'tool-keep', owner: 'producer-p', execute: () => 'V' });
      }, { name: 'producer-p' });
      // 冒名者知道 owner 字符串（它本来就可列举），但没有句柄、也不在该装配里。
      const denied = registry.unregisterTool({ name: 'tool-keep', owner: 'producer-p' });
      assertEquals(denied.ok, false);
      assertEquals(denied.code, 'not_owner');
      assert(toolLoader._tools.has('tool-keep'), '别人的目录项必须还在');
      assert(core.listCapabilities().some((c) => c.id === 'tool.keep'), '能力也必须还在');
      assertEquals(registry.unregisterTool({ name: 'tool-keep', owner: 'producer-p', handle: reg.handle }).ok, true);
    } finally { done(); }
  });

  runner.test('R0-031/ID-13 插件没保存凭据，生命周期仍按实例账本精确清场', async () => {
    const { core, done } = makeCore();
    try {
      const p = plugin('nohandle', (c) => {
        // 故意把返回值丢掉：多数插件都是这么写的。
        c.registerCapability('nh.op', { owner: 'nohandle', handler: () => 1 });
        c.registerService('nh.svc', { by: 'nohandle' });
      });
      await core.register(p);
      await core.lifecycle.load(p, core);
      assert(core.listCapabilities().some((c) => c.id === 'nh.op'));
      assert(core.getService('nh.svc'));
      const r = await core.lifecycle.unload('nohandle');
      assertEquals(r.ok, true);
      assertEquals(await core.hasCapability('nh.op'), false, '能力必须按实例身份清干净');
      assertEquals(core.getService('nh.svc'), undefined, '服务同样要清干净');
    } finally { done(); }
  });

  runner.test('R0-031/ID-14 handler 期间不获得管理型授权，调用本身照常执行', async () => {
    const { core, done } = makeCore();
    try {
      core.registerCapability('victim.op', { owner: 'A', handler: () => 'VICTIM' });
      core.registerCapability('probe.op', {
        owner: 'B',
        handler: () => {
          // 正在执行 B 的 handler ≠ B 获准做装配期的事。
          const ctx = core.currentAssembly();
          let overwrote = false;
          try { core.registerCapability('victim.op', { owner: 'A', override: true, handler: () => 'EVIL' }); } catch { /* 预期拒绝 */ }
          try { core.registerCapability('victim.op', { owner: 'A', overrideBy: {}, handler: () => 'EVIL' }); overwrote = true; } catch { /* 预期拒绝 */ }
          return { ctx, overwrote };
        },
      });
      const out = (await core.callCapability('probe.op', {})).payload;
      assertEquals(out.ctx, null, 'handler 期间不得存在管理型装配上下文');
      assertEquals(out.overwrote, false, '伪造的凭据对象不得生效');
      assertEquals((await core.callCapability('victim.op', {})).payload, 'VICTIM');
    } finally { done(); }
  });

  runner.test('R0-031/ID-15 双重释放 / 跨 Core 使用凭据都是 stale，不影响他人', async () => {
    const a = makeCore();
    const b = makeCore();
    try {
      const h = a.core.registerCapability('x.op', { owner: 'A', handler: () => 1 });
      assertEquals(a.core.releaseRegistration(h), true);
      assertEquals(a.core.releaseRegistration(h), false, '重复释放必须是 no-op，不是删掉同 ID 的下一条');
      const h2 = a.core.registerCapability('y.op', { owner: 'A', handler: () => 'A' });
      b.core.registerCapability('y.op', { owner: 'B', handler: () => 'B' });
      assertEquals(b.core.releaseRegistration(h2), false, '别的 Core 发的凭据在本 Core 无效');
      assertEquals((await b.core.callCapability('y.op', {})).payload, 'B');
      assertEquals(a.core.releaseRegistration(h2), true);
    } finally { a.done(); b.done(); }
  });

  runner.test('R0-031/ID-16 宿主接管不能由插件名伪装；收尾清场不按名字猜', async () => {
    const { core, done } = makeCore();
    try {
      let code = null;
      try { await core.register({ name: '@host', async init() {} }); } catch (e) { code = e.code; }
      assertEquals(code, 'plugin_name_invalid', 'S7 的判据继续生效：@ 前缀不是插件名');

      const p = plugin('svc-owner', (c) => { c.registerService('svc.p', { by: 'svc-owner' }); });
      await core.register(p);
      await core.lifecycle.load(p, core);
      assertEquals(core.getServiceOwnership('svc.p').owner, 'svc-owner');
      await core.lifecycle.unload('svc-owner');
      assertEquals(core.getService('svc.p'), undefined, '实例级清场仍要真的清干净');
    } finally { done(); }
  });
}
