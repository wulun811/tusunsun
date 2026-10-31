// R0-019（rc.15）：**scope 是值类型，归属看受信 provider**。
//
// 两条同源的缺陷（专家 rc.14 复审 S5 / S6，本仓 E-1–E-4）：
//
//   S5  `SCOPE_RANK` 是普通对象，`in` 与裸下标会沿原型链找到 `toString`/`constructor`。
//       于是 `assertIdentity(p, { scope: 'toString' })` 被接受；而 `(函数 ?? 0)` 不是数字，
//       任何“等级不足”的大小比较都返回 `false` —— 判据对非法值**恒假**，就是 fail-open。
//
//   S6  覆盖判据读**自报的 owner 字符串**。B 声明 `owner: 'A'` + `override: true`
//       就能顶掉 A 的能力；公开的 `runServiceTracking('A', fn)` 更进一步，
//       能让调用方铸造一个“来自 A”的装配上下文。
//       随后专家裁决（RC14-IDENT/S6 代持语义包，A 方案）把覆盖判据再收紧一格：
//       **连「同一 owner」也不够** —— 覆盖须持原登记交回的凭据（`overrideBy`）。
//       本文件 /7、/9 随之从“同 owner 字符串可覆盖”改为“持凭据可覆盖”。
//
// 修后必须同时成立两件事：**攻击形状全部变红**，而**合法路径一点没变**。
import { TestRunner, assert, assertEquals } from '../harness.mjs';
import { Core } from '../../src/core/core.js';

const TOKEN = Symbol('authority');

function makeCore() {
  return new Core({ identityAuthority: TOKEN });
}

/** 在受信装配上下文里登记（与 lifecycle-manager 走同一条路径）。 */
function inAssembly(core, owner, fn) {
  return core._runAssemblyContext(owner, fn, core.assemblyEpoch);
}

export async function setup(runner) {
  // ── S5 / E-4 ──────────────────────────────────────────────────────
  runner.test('R0-019/1 assertIdentity 拒绝原型链上的“scope”', async () => {
    const core = makeCore();
    for (const bad of ['toString', 'constructor', '__proto__', 'valueOf', 'hasOwnProperty']) {
      let threw = false;
      try { core.assertIdentity(`p-${bad}`, { scope: bad, issuer: TOKEN }); } catch { threw = true; }
      assert(threw, `assertIdentity 必须拒绝 scope='${bad}'（它只是原型链上的属性名）`);
    }
  });

  runner.test('R0-019/2 合法 scope 三个取值不受影响', async () => {
    const core = makeCore();
    for (const ok of ['read', 'write', 'admin']) {
      assertEquals(core.assertIdentity(`p-${ok}`, { scope: ok, issuer: TOKEN }), true);
    }
  });

  runner.test('R0-019/3 非法 scope 永远满足不了受保护能力', async () => {
    const core = makeCore();
    core.registerCapability('admin.op', { handler: () => 'ADMIN-PAYLOAD', permissions: { scope: 'admin' } });
    // 先设法把 mallory 登记成一个“scope=toString”的受信主体 —— 现在应在登记处就被拒。
    let registered = false;
    try { core.assertIdentity('mallory', { scope: 'toString', issuer: TOKEN }); registered = true; } catch { /* 预期 */ }
    assertEquals(registered, false, 'toString 不得成为合法 scope');
    // 即便将来自报同样非法值，也不得放行。
    const r = await core.callCapability('admin.op', {}, { principal: 'mallory', scope: 'toString' });
    assertEquals(r.state, 'denied', `受保护能力必须拒绝，实际 ${JSON.stringify(r).slice(0, 160)}`);
    assertEquals(r.dispatched, false, '拒绝必须发生在派发前');
    assertEquals(r.side_effect, 'none', '零副作用');
    assertEquals(r.payload, null, '不得执行 handler');
  });

  runner.test('R0-019/4 合法 admin 主体仍能调受保护能力（不得过度收紧）', async () => {
    const core = makeCore();
    core.assertIdentity('alice', { scope: 'admin', issuer: TOKEN });
    core.registerCapability('admin2.op', { handler: () => 'ALICE-OK', permissions: { scope: 'admin' } });
    const r = await core.callCapability('admin2.op', {}, { principal: 'alice', scope: 'admin' });
    assertEquals(r.payload, 'ALICE-OK');
  });

  // ── S6 / E-1–E-2 ─────────────────────────────────────────────────
  runner.test('R0-019/5 B 不能用自报 owner + override 顶掉 A 的能力', async () => {
    const core = makeCore();
    await inAssembly(core, 'A', () => {
      core.registerCapability('vault.op', { owner: 'A', handler: () => 'A-REAL' });
    });
    assertEquals((await core.callCapability('vault.op', {})).payload, 'A-REAL');

    let overwritten = false;
    try {
      core.registerCapability('vault.op', { owner: 'A', override: true, handler: () => 'HACKED-BY-B' });
      overwritten = true;
    } catch (e) {
      assert(/capability_conflict/.test(e.message), `应报 capability_conflict，实际：${e.message}`);
    }
    assertEquals(overwritten, false, '自报 owner 不得成为覆盖他人的依据');
    assertEquals((await core.callCapability('vault.op', {})).payload, 'A-REAL', '原能力必须完好');
  });

  runner.test('R0-019/6 公开 runServiceTracking 铸造不出“来自 A”的受信上下文', async () => {
    const core = makeCore();
    await inAssembly(core, 'A', () => {
      core.registerCapability('vault2.op', { owner: 'A', handler: () => 'A-REAL' });
    });
    let overwritten = false;
    try {
      await core.runServiceTracking('A', async () => {
        core.registerCapability('vault2.op', { owner: 'A', override: true, handler: () => 'HACKED' });
      });
      overwritten = true;
    } catch (e) {
      assert(/capability_conflict/.test(e.message), `应报 capability_conflict，实际：${e.message}`);
    }
    assertEquals(overwritten, false, 'runServiceTracking 不是受信入口（epoch:null ⇒ trusted=false）');
  });

  runner.test('R0-019/7 同一个 A 持原登记凭据仍可覆盖自己的同名能力（字符串不行）', async () => {
    const core = makeCore();
    let h1;
    await inAssembly(core, 'A', () => {
      h1 = core.registerCapability('self.op', { owner: 'A', handler: () => 'V1' });
    });
    // 先钉住“同 owner 字符串”不再够：否则这条用例会掩盖 /5 的判据。
    let byString = false;
    await inAssembly(core, 'A', () => {
      try { core.registerCapability('self.op', { owner: 'A', override: true, handler: () => 'HACK' }); } catch { byString = true; }
    });
    assertEquals(byString, true, '覆盖不得由 owner 字符串授权（专家 S6 裁决 §2.2.1）');
    await inAssembly(core, 'A', () => {
      core.registerCapability('self.op', { owner: 'A', overrideBy: h1, handler: () => 'V2' });
    });
    assertEquals((await core.callCapability('self.op', {})).payload, 'V2', '持凭据的覆盖必须继续可用');
  });

  runner.test('R0-019/8 provider 只来自受信上下文；owner 仍是展示字段', async () => {
    const core = makeCore();
    await inAssembly(core, 'A', () => {
      core.registerCapability('p.op', { owner: 'NOT-A', handler: () => 1 });
    });
    core.registerCapability('host.op', { owner: 'HOSTISH', handler: () => 2 });
    const byId = (id) => core.listCapabilities().find((c) => c.id === id);
    assertEquals(byId('p.op').provider, 'A', '受信上下文决定 provider，自报 owner 不能改写它');
    assertEquals(byId('p.op').owner, 'NOT-A', 'owner 原样保留，仅作为展示/审计信息');
    assertEquals(byId('host.op').provider, null, '无受信上下文时 provider 必须为 null，不得回退成自报 owner');
  });

  runner.test('R0-019/9 宿主直接注册的能力同样按凭据覆盖（不再有“同 owner 字符串”兼容分支）', async () => {
    const core = makeCore();
    const h1 = core.registerCapability('legacy.op', { owner: 'host', handler: () => 'H1' });
    let byString = false;
    try { core.registerCapability('legacy.op', { owner: 'host', override: true, handler: () => 'HACK' }); } catch { byString = true; }
    assertEquals(byString, true, '宿主路径也不接受同 owner 字符串覆盖（ID-16：宿主接管须显式授权）');
    core.registerCapability('legacy.op', { owner: 'host', overrideBy: h1, handler: () => 'H2' });
    assertEquals((await core.callCapability('legacy.op', {})).payload, 'H2', '合法覆盖（持凭据）必须可用');
  });
}
