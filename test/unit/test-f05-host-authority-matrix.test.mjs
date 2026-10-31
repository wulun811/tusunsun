// F05 宿主接管权限（专家裁决 A'）：H01–H18 的**实现侧**验收矩阵。
//
// 为什么单独成文件而不并进 X04-d：矩阵是专家给的执行基线，逐条可对照；
// 混进既有用例会让"哪一条过了、哪一条没过"重新变成人工推断。
//
// 三条互相独立的后门，都必须在这里有**各自的**负例（修前各自 ALLOWED）：
//   [1] `claimant == null` 即视作宿主；
//   [2] `service.allowOverride` 配置当作授权（取值来自 `config` **服务**，插件可自造）；
//   [3] `runServiceTracking('@host')` 自封登主，造出清场拆不掉的飞地。
//
// 每个 P0 负例都必须配一个**能成功的正例**，否则"把所有接管一律禁掉"也能全绿 ——
// 那是伪修复。H08/H13/H17 就是为此存在的。
//
// 边界（写清，避免被读成更强的承诺）：本套件证明的是**受管 API** 的身份错误与静默越权已被封；
// 同进程恶意 JS 仍可直接改私有 Map、猴子补丁、持有内部引用。真正的隔离需要进程/IPC 边界。
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assert, assertEquals } from '../harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (rel) => import(join(ROOT, rel));

export async function setup(runner) {
  const { createRuntime, Core } = await imp('src/core/core.js');

  /** 一次构造，把插件可见的 core 与只给启动程序的 host 分开交付。 */
  function makeRuntime() {
    const dir = mkdtempSync(join(tmpdir(), 'f05-'));
    const { core, host } = createRuntime({ stateDir: join(dir, 'state') });
    core.log = () => {};
    return {
      core,
      host,
      done() {
        try { core.removeAllListeners(); } catch { /* 尽力而为 */ }
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  /** 不经 createRuntime 的裸 Core：有控制体（构造期就绑），但拿不到 `host` 句柄。 */
  function makeBareCore() {
    const dir = mkdtempSync(join(tmpdir(), 'f05b-'));
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

  /** 以某个 owner 登记一条服务（走公开装配上下文，与插件 init 同一条路）。 */
  // 正例的**合法姿势**（专家 R15-03）：向受信装配上下文要登记，而不是公开的 `runServiceTracking`
  // 自报一个 owner 字符串。传 `instance` 时走装配上下文，不传时保留“只观测”的旧用法。
  const owned = (core, owner, fn, instance = null) => (instance
    ? core._runAssemblyContext(owner, fn, core.assemblyEpoch, instance)
    : core.runServiceTracking(owner, fn));

  /** 断言一段调用被具名拒绝，并返回那个错误码。 */
  const codeOf = (fn) => {
    try { fn(); return null; } catch (e) { return e?.code ?? `(no code) ${e?.message}`; }
  };

  // ══ H01：插件存下 Core，起先无 ALS 再 takeover:true ══════════════════
  runner.test('F05-H01 插件持 Core + 无 ALS + takeover:true ⇒ host_authority_required，服务不变', async () => {
    const { core, done } = makeRuntime();
    try {
      const victim = { name: 'victim', version: '1.0.0', async init(c) { c.registerService('db', { q: () => 'victim' }); } };
      let stored = null;   // 插件把 Core 存下来（这就是攻击面）
      const attacker = { name: 'attacker', version: '1.0.0', async init(c) { stored = c; } };
      core.register(victim); core.register(attacker);
      await core.start();
      assert(stored === core, '前提：插件确实拿到了 Core 引用');

      const code = codeOf(() => stored.registerService('db', { q: () => 'ATTACKER' }, { takeover: true }));
      assertEquals(code, 'host_authority_required', '没有宿主控制体就不许接管');
      assertEquals(core.getService('db').q(), 'victim', '对象不得被换掉');
      assertEquals(core.getServiceOwnership('db').owner, 'victim', '归属不得改变');
    } finally { await core.stop(); done(); }
  });

  // ══ H02：runServiceTracking(null) 不等于 Host ═════════════════════════
  runner.test('F05-H02 runServiceTracking(null) 内 takeover:true ⇒ 拒绝，且不提升为 Host', async () => {
    const { core, done } = makeRuntime();
    try {
      await owned(core, 'owner-A', async () => core.registerService('svc', { v: 'A' }));
      let code = null;
      await owned(core, null, async () => {
        code = codeOf(() => core.registerService('svc', { v: 'HOST' }, { takeover: true }));
      });
      assertEquals(code, 'host_authority_required', 'null claimant 是信息缺失，不是宿主认证');
      assertEquals(core.getService('svc').v, 'A');
      assertEquals(core.getServiceOwnership('svc').owner, 'owner-A');
    } finally { done(); }
  });

  // ══ H03：受信装配 ALS 不等于 Host ════════════════════════════════════
  runner.test('F05-H03 受信装配上下文（trusted）内 takeover:true ⇒ 仍是跨主拒绝', async () => {
    const { core, done } = makeRuntime();
    try {
      const A = { v: 'A' };
      const aInst = { name: 'owner-A' };
      await core._runAssemblyContext('owner-A', async () => core.registerService('svc', A), core.assemblyEpoch, aInst);
      // 同一受信装配里再来一次跨主接管：`trusted` 只影响署名来源，不授予管理别人服务的资格。
      let code = null;
      await core._runAssemblyContext('owner-B', async () => {
        code = codeOf(() => core.registerService('svc', { v: 'B' }, { takeover: true }));
      }, core.assemblyEpoch, { name: 'owner-B' });
      assertEquals(code, 'host_authority_required', 'asm.trusted 不是宿主');
      assertEquals(core.getService('svc').v, 'A');
      assertEquals(core.getServiceOwnership('svc').owner, 'owner-A');
    } finally { done(); }
  });

  // ══ H04：自报 @host 不等于 Host ═══════════════════════════════════════
  runner.test('F05-H04 owner=\'@host\' 自封接管 ⇒ 拒绝，且不生成宿主权能', async () => {
    const { core, done } = makeRuntime();
    try {
      await owned(core, 'victim', async () => core.registerService('db', { q: () => 'victim' }));
      let code = null;
      await owned(core, '@host', async () => {
        code = codeOf(() => core.registerService('db', { q: () => 'HOST' }));
      });
      assertEquals(code, 'host_authority_required', '@host 是结果标签，不可申请');
      assertEquals(core.getService('db').q(), 'victim');
      assertEquals(core.getServiceOwnership('db').owner, 'victim');
    } finally { done(); }
  });

  // ══ H05：不存在可发证的公共入口 ═══════════════════════════════════════
  runner.test('F05-H05 Core 公开面不存在 issueHostHandle / 任何发证方法', async () => {
    const { core, host, done } = makeRuntime();
    try {
      for (const name of ['issueHostHandle', 'createHostHandle', 'getHostControl', 'hostControl', 'issueHostControl']) {
        assertEquals(core[name], undefined, `不得存在发证入口 ${name}`);
      }
      // host 句柄里也不得藏"复制一份控制体给自己"的方法。
      for (const name of ['issueHostHandle', 'issue', 'getControl', 'control']) {
        assertEquals(host[name], undefined, `host 不得暴露 ${name}`);
      }
      assertEquals(Object.isFrozen(host), true, 'host 面必须冻结：不许被挂上新方法');
    } finally { done(); }
  });

  // ══ H06：无 ALS 首次登记不得造成 @host 飞地 ═══════════════════════════
  runner.test('F05-H06 无 ALS/无控制体的首次登记 ⇒ 归属为 null，不是 @host 飞地', async () => {
    const { core, done } = makeRuntime();
    try {
      core.registerService('raw-first', { v: 1 });
      const own = core.getServiceOwnership('raw-first');
      assertEquals(own.owner, null, '没有身份就是没有身份，不能默认记成宿主');
      assertEquals(own.takeover, null, '也不得留一条伪造的接管回执');
      // 飞地的判据是"谁都拆不掉"：归属 null 的条目仍可被正常的宿主释放路径处理。
      assert(own.registered);
    } finally { done(); }
  });

  runner.test('F05-H06b runServiceTracking(\'@host\') 首次登记 ⇒ 具名拒绝（修前造出清场拆不掉的飞地）', async () => {
    const { core, done } = makeRuntime();
    try {
      let code = null;
      await owned(core, '@host', async () => {
        code = codeOf(() => core.registerService('enclave', { v: 'ENCLAVE' }));
      });
      assertEquals(code, 'host_authority_required');
      assertEquals(core.getService('enclave'), undefined, '不得留任何资产');
      assertEquals(core.getServiceOwnership('enclave').registered, false);
    } finally { done(); }
  });

  // ══ H07：Bootstrap 用控制体首次注册（正例） ═══════════════════════════
  runner.test('F05-H07 【正例】宿主控制面首次注册成功，归属 @host 且绑定当前 Core', async () => {
    const { core, host, done } = makeRuntime();
    try {
      await host.registerService('db', { q: () => 'HOST' });
      const own = core.getServiceOwnership('db');
      assertEquals(own.owner, '@host');
      assertEquals(own.registered, true);
      assert(typeof own.registrationId === 'number', '每次登记必须有可撤销的登记身份');
      assertEquals(core.getService('db').q(), 'HOST');
    } finally { done(); }
  });

  // ══ H08：宿主接管 victim 服务，旧插件卸载后仍存活（正例，X04-d 迁移） ══
  runner.test('F05-H08 【正例】宿主接管后旧插件卸载不得拆走新服务（X04-d 迁移）', async () => {
    const { core, host, done } = makeRuntime();
    try {
      const A = { q: () => 'victim' };
      const aInst = { name: 'victim' };
      await core._runAssemblyContext('victim', async () => core.registerService('db', A), core.assemblyEpoch, aInst);
      await host.takeoverService('db', { q: () => 'HOST' }, { reason: 'bootstrap-recovery' });
      assertEquals(core.getService('db').q(), 'HOST');

      const reaped = core.lifecycle._reap('victim', aInst);
      assertEquals(reaped.services.length, 0, '旧主的清场不得删掉已被宿主接管的登记');
      assertEquals(core.getService('db').q(), 'HOST', '接管后归属稳定');
      assertEquals(core.getServiceOwnership('db').owner, '@host');
    } finally { done(); }
  });

  // ══ H09：控制体跨 Core 无效 ═══════════════════════════════════════════
  runner.test('F05-H09 宿主控制能力用于其他 Core 实例 ⇒ 拒绝，原服务不变', async () => {
    const a = makeRuntime();
    const b = makeRuntime();
    try {
      await owned(b.core, 'victim', async () => b.core.registerService('db', { q: () => 'B-victim' }));
      // 形态①：a 的 host 拿去改 b 的 Core —— 控制体按实例绑定，跨实例无效。
      let code = null;
      try { await a.host.takeoverService.call(null, 'db', { q: () => 'A-HOST' }); } catch { /* a 上没有 b 的服务，见下一条 */ }
      // b 自己没有任何宿主控制面（makeRuntime 的 host 属于 b，但这里模拟"攻击者只有一个 host 对象"）。
      code = codeOf(() => b.core._commitService('db', { q: () => 'A-HOST' }, { takeover: true }, undefined));
      assertEquals(code, 'host_authority_required', '没有本实例控制体就一律拒绝');
      assertEquals(b.core.getService('db').q(), 'B-victim');
      // 形态②：a 的 host 去接管 b 的同名服务 —— 它提交到的是 a 的 Core，碰不到 b。
      await a.host.registerService('db', { q: () => 'A-OWN' });
      assertEquals(b.core.getService('db').q(), 'B-victim', '跨实例互不牵连');
      // 形态③：Core 的公开面不得存在任何"把控制体取出来"的测试后门。
      assertEquals(a.core._hostControlForTest, undefined, '不许有测试后门');
    } finally { a.done(); b.done(); }
  });

  // ══ H10：stop 之后迟到接管 ════════════════════════════════════════════
  runner.test('F05-H10 宿主 handle 在 stop 之后迟到执行 takeover ⇒ 拒绝，服务不变', async () => {
    const { core, host, done } = makeRuntime();
    try {
      await owned(core, 'victim', async () => core.registerService('db', { q: () => 'victim' }));
      await core.start();
      await core.stop();
      let code = null;
      try { await host.takeoverService('db', { q: () => 'LATE' }); } catch (e) { code = e.code; }
      assertEquals(code, 'host_authority_required', '停止后的实例不再接受宿主提交');
      assertEquals(core.getService('db').q(), 'victim', '迟到的接管不得生效');
    } finally { done(); }
  });

  // ══ H11：旧实例卸载不得删新宿主登记（ABA） ════════════════════════════
  runner.test('F05-H11 旧 victim 实例卸载时释放服务 ⇒ 不得删除已接管的 R2（ABA）', async () => {
    const { core, host, done } = makeRuntime();
    try {
      const aInst = { name: 'victim' };
      await core._runAssemblyContext('victim', async () => core.registerService('db', { q: () => 'R1' }), core.assemblyEpoch, aInst);
      const r1Id = core.getServiceOwnership('db').registrationId;
      await host.takeoverService('db', { q: () => 'R2' });
      const r2Id = core.getServiceOwnership('db').registrationId;
      assert(r1Id !== r2Id, '接管必须产生新的登记身份');

      // 旧实例的迟到清理：既按 owner 也不该动 @host。
      assertEquals(core.lifecycle._reap('victim', aInst).services.length, 0);
      assertEquals(core.getServiceOwnership('db').registrationId, r2Id, 'R2 必须还在');
      assertEquals(core.getService('db').q(), 'R2');
    } finally { done(); }
  });

  // ══ H12：旧登记凭据重放（stale） ══════════════════════════════════════
  runner.test('F05-H12 旧登记 ID 重放于同名新登记 ⇒ stale_registration，不得删 R2', async () => {
    const { core, host, done } = makeRuntime();
    try {
      await host.registerService('db', { q: () => 'R1' });
      const r1Id = core.getServiceOwnership('db').registrationId;
      await host.takeoverService('db', { q: () => 'R2' });
      const r2Id = core.getServiceOwnership('db').registrationId;

      const stale = await host.releaseService('db', r1Id);
      assertEquals(stale.ok, false);
      assertEquals(stale.code, 'stale_registration', 'compare-and-delete 按登记 ID，不按名字');
      assertEquals(core.getServiceOwnership('db').registrationId, r2Id, 'R2 必须还在');

      const ok = await host.releaseService('db', r2Id);
      assertEquals(ok.ok, true, '正例：当前登记 ID 可以撤销');
      assertEquals(core.getService('db'), undefined);
    } finally { done(); }
  });

  // ══ H13：只拿到普通 Core 的插件只能做普通受管操作 ═════════════════════
  runner.test('F05-H13 【正例+负例】普通插件：自己的服务能登记，别人的不能接管', async () => {
    const { core, done } = makeRuntime();
    try {
      // 正例：自己的命名空间内正常登记/覆盖 —— 同一个登记实例，不是同名自报。
      const aInst = { name: 'plugin-a' };
      await owned(core, 'plugin-a', async () => core.registerService('a.svc', { v: 1 }), aInst);
      await owned(core, 'plugin-a', async () => core.registerService('a.svc', { v: 2 }), aInst);
      assertEquals(core.getService('a.svc').v, 2, '同一实例更新自己的登记是合法行为');

      // 反例（R15-03）：自报同一个 owner 字符串**不再**能改它。
      let forged = null;
      await owned(core, 'plugin-a', async () => {
        forged = codeOf(() => core.registerService('a.svc', { v: 3 }));
      });
      assertEquals(forged, 'service_conflict', '自报 owner 不构成授权');
      assertEquals(core.getService('a.svc').v, 2, '服务对象不得被覆盖');

      // 负例：接管别人的。
      await owned(core, 'plugin-b', async () => core.registerService('b.svc', { v: 1 }));
      let code = null;
      await owned(core, 'plugin-b', async () => {
        code = codeOf(() => core.registerService('a.svc', { v: 99 }, { takeover: true }));
      });
      assertEquals(code, 'host_authority_required');
      assertEquals(core.getService('a.svc').v, 2);
      assertEquals(core.getServiceOwnership('a.svc').owner, 'plugin-a');
    } finally { done(); }
  });

  // ══ H14：归责来自授权通道，不来自调用方标签 ═══════════════════════════
  runner.test('F05-H14 接管回执的 actorClass 由控制面确定，不是传入标签', async () => {
    const { core, host, done } = makeRuntime();
    try {
      await owned(core, 'victim', async () => core.registerService('db', { q: () => 'victim' }));
      const before = core.getServiceOwnership('db').registrationId;
      // 故意传一个自称宿主的标签：回执不得采信它。
      await host.takeoverService('db', { q: () => 'HOST' }, { reason: 'recovery', actorClass: 'plugin', claimedBy: '@host' });
      const rec = core.getServiceOwnership('db').takeover;
      assertEquals(rec.actorClass, 'host', '归责只认授权通道');
      assertEquals(rec.previousRegistrationId, before);
      assert(rec.newRegistrationId !== before, '新登记身份必须与旧的不同');
      assertEquals(rec.previousOwner, 'victim');
      assertEquals(rec.newOwner, '@host');
      assertEquals(rec.outcome, 'committed');
      assertEquals(rec.reason, 'recovery', 'reason 是描述，原样保留但不作鉴权依据');
    } finally { done(); }
  });

  // ══ H15：非法接管不得写入伪宿主事实 ═══════════════════════════════════
  runner.test('F05-H15 被拒的接管不得写入任何"已由宿主接管"的事实', async () => {
    const { core, done } = makeRuntime();
    try {
      await owned(core, 'victim', async () => core.registerService('db', { q: () => 'victim' }));
      const seen = [];
      core.on('core:service.conflict', (e) => seen.push(e));

      codeOf(() => core.registerService('db', { q: () => 'X' }, { takeover: true }));
      assertEquals(core.getServiceOwnership('db').takeover, null, '拒绝之后不得留接管回执');
      assertEquals(core.getServiceOwnership('db').owner, 'victim');
      assertEquals(seen.length, 1, '拒绝必须可观测');
      assertEquals(seen[0].allowed, false);
      assertEquals(seen[0].reason, 'host_authority_required');
    } finally { done(); }
  });

  // ══ H16：在途/被依赖的服务被接管时的合同 ══════════════════════════════
  runner.test('F05-H16 接管时如实区分"注册表已替换"与"外部效果未知"', async () => {
    const { core, host, done } = makeRuntime();
    try {
      const old = { q: () => 'OLD' };
      await owned(core, 'victim', async () => core.registerService('db', old));
      const rec = await (async () => {
        await host.takeoverService('db', { q: () => 'NEW' }, { reason: 'force' });
        return core.getServiceOwnership('db').takeover;
      })();
      // 合同：不声称"历史工作已自动迁移"。注册表已替换是已提交事实；
      // 旧对象仍被谁持有属于**未知**，不得由一次 Map 更新推断。
      assertEquals(rec.outcome, 'committed', '注册表替换是已提交事实');
      assertEquals(Object.hasOwn(rec, 'dependentsMigrated'), false, '不得伪造"依赖已迁移"');
      assertEquals(old.q(), 'OLD', '旧对象本身没有被改写');
      assertEquals(core.getService('db').q(), 'NEW');
    } finally { done(); }
  });

  // ══ H17：X04-d 原需求经新接口仍通过（必须正例） ═══════════════════════
  runner.test('F05-H17 【必须正例】原 X04-d 的合法宿主接管需求，经 host 接口仍成立', async () => {
    const { core, host, done } = makeRuntime();
    try {
      const aInst = { name: 'owner-A' };
      await core._runAssemblyContext('owner-A', async () => core.registerService('svc', { v: 'A' }), core.assemblyEpoch, aInst);
      await host.takeoverService('svc', { v: 'H' });
      assertEquals(core.getService('svc').v, 'H');
      assertEquals(core.getServiceOwnership('svc').owner, '@host');
      // 需求的核心：插件侧再也拿不到这条服务。
      assertEquals(core.lifecycle._reap('owner-A', aInst).services.length, 0);
      assertEquals(core.getService('svc').v, 'H');
    } finally { done(); }
  });

  // ══ H18：替代路径不得绕过授权判据 ═════════════════════════════════════
  runner.test('F05-H18 逐条枚举公开入口：没有一个能绕过宿主判据', async () => {
    const { core, done } = makeRuntime();
    try {
      await owned(core, 'victim', async () => core.registerService('db', { q: () => 'victim' }));

      // ① 按名的批量入口必须不存在（猜对名字即放权）。
      assertEquals(core.releaseServicesByOwner, undefined);
      assertEquals(core.releaseCapabilitiesByOwner, undefined);

      // ② 清场通道：**公开签发入口已删除**（专家 R15-02：`core.plugins` 是公开 Map，
      // 于是“要传真实 instance”根本不是授权条件）。注入的那一份也拆不掉别人的条目。
      assertEquals(core.issueLifecycleReaper, undefined, '公开签发管理员证件的入口必须消失');
      assertEquals(core.lifecycle._reap('victim', null).services.length, 0, '按名字清不动（需要登记实例身份）');

      // ③ 配置型后门已从授权链路上去掉：把 allowOverride 报成 true 也不再放行。
      core._services.set('config', { get: (k, d) => (k === 'service.allowOverride' ? true : d), set() {} });
      let code = null;
      await owned(core, 'attacker', async () => {
        code = codeOf(() => core.registerService('db', { q: () => 'VIA-CONFIG' }));
      });
      assertEquals(code, 'service_conflict', '插件可自造的配置不构成授权');
      assertEquals(core.getService('db').q(), 'victim');

      // ④ 自封 @host 后想"新建别名服务"留下宿主资产：同样被拒。
      let aliasCode = null;
      await owned(core, '@host', async () => {
        aliasCode = codeOf(() => core.registerService('db.alias', { q: () => 'ALIAS' }));
      });
      assertEquals(aliasCode, 'host_authority_required');

      // ⑤ 正常插件仍能登记自己的服务（不许"一律禁掉"混过）。
      await owned(core, 'legit', async () => core.registerService('legit.svc', { v: 1 }));
      assertEquals(core.getServiceOwnership('legit.svc').owner, 'legit');
    } finally { done(); }
  });

  // ══ 补充：裸 Core 不交出 host（默认拒绝，不是缺陷） ═══════════════════
  runner.test('F05-H00 裸 new Core() 合法但不交出 host；其服务面不受影响', async () => {
    const { core, done } = makeBareCore();
    try {
      await owned(core, 'owner-A', async () => core.registerService('svc', { v: 'A' }));
      assertEquals(core.getService('svc').v, 'A', '裸 Core 的服务登记照旧可用');
      // 它没有任何"发证"入口可调。
      assertEquals(core.issueHostHandle, undefined);
      // 卸载/停止也不受影响。
      await core.start(); await core.stop();
    } finally { done(); }
  });
}
