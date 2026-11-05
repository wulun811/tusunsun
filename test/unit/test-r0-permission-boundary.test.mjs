// R0-3 对抗测试：可信调用与授权边界（**正式门禁**）
//
// 对应专家 R0-3 与第五轮 §四/§七：「真正的验收仍要构造非法身份、非法参数、失效授权和
// 绕行调用，确认执行边界实际拒绝」——而不是只做静态审计。
//
// 本文件历史与现状（重要）：
//   本轮之前，本文件的断言是"绕过成功"——如实记录 R0-3 未达成。专家第五轮指出
//   「10/10 通过不是安全测试成功」，要求"保留这些反例作为修复前基线，修复后再改成
//   非法调用必须被拒绝的正式门禁测试"。本轮据此改造：**断言方向已反转**。
//
// 专家第五轮确立的边界（本文件据以实现与断言）：
//   - "身份对象来自可信入口" ≠ "所有进程内代码都不能伪造它"
//   - 不可信 Agent/外部调用者必须经过受控入口；执行不可信代码需独立执行环境
//   - 不能因 callCapability 加了校验就宣布实现了强制安全隔离
//   - **对外 public surface：人工确认调用者可信不能代替服务端强制鉴权**

import { TestRunner, assert, assertEquals } from '../harness.mjs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CORE = join(HERE, '..', '..', 'src', 'core', 'core.js');
const url = (p) => new URL(`file://${p}`).href;

export async function setup(runner) {
  const mod = await import(url(CORE));
  const Core = mod.default ?? mod.Core ?? Object.values(mod).find((v) => typeof v === 'function');

  // R0-28：身份授权令牌由宿主在构造时注入。测试即扮演宿主引导通道，故持有一个令牌。
  const HOST_AUTHORITY = Symbol('test-host-identity-authority');

  function newCore() {
    const c = new Core({ identityAuthority: HOST_AUTHORITY });
    c.log = () => {};
    return c;
  }

  /** R0-28：以持令牌的宿主身份登记受信主体（调用点显式带 issuer，模拟可信入口）。 */
  const assertAsHost = (core, principal, grant) =>
    core.assertIdentity(principal, { ...grant, issuer: HOST_AUTHORITY });

  // ===== 一、声明了 permissions 的能力：非法调用必须被真实拒绝 =====

  runner.test('R0-3/A【门禁】要求身份的受保护能力：无身份调用被拒绝且 handler 不执行', async () => {
    const core = newCore();
    let called = 0;
    core.registerCapability('privileged.danger', {
      handler: () => { called += 1; return 'executed'; },
      owner: 'trusted-plugin',
      permissions: { require_identity: true, scope: 'write' },
    });
    // 攻击面：调用方不提供任何身份
    const r = await core.callCapability('privileged.danger', { evil: true });
    assertEquals(r.ok, false, '无身份调用必须被拒绝');
    assert(/capability_denied/.test(String(r.error)), `拒绝原因应具名 capability_denied，实际：${r.error}`);
    assertEquals(called, 0, '**handler 不得被执行**（副作用不落地）——这是与"记录了拒绝但仍执行"的关键区别');
  });

  runner.test('R0-3/B【门禁】权限不足（scope 不够）的调用被拒绝', async () => {
    const core = newCore();
    let called = 0;
    core.registerCapability('admin.only', {
      handler: () => { called += 1; return 'ok'; },
      owner: 'trusted',
      permissions: { require_identity: true, scope: 'admin' },
    });
    // 有身份但权限不足：read < admin
    const r = await core.callCapability('admin.only', {}, { caller: 'low-priv-agent', scope: 'read' });
    assertEquals(r.ok, false, '权限不足应被拒绝');
    assert(/capability_denied/.test(String(r.error)), `应具名 capability_denied，实际：${r.error}`);
    assertEquals(called, 0, 'handler 不得执行');
  });

  runner.test('R0-3/C【门禁】权限充足时正常放行（避免"一律拒绝"的假安全）', async () => {
    const core = newCore();
    core.registerCapability('admin.op', {
      handler: () => 'ok', owner: 'trusted',
      permissions: { require_identity: true, scope: 'write' },
    });
    // R0-23（专家复审 P0-D）：身份必须来自受信通道——先登记 principal，再断言 caller/scope。
    assertAsHost(core, 'host-principal', { caller: 'host', scope: 'admin' });
    // admin 蕴含 write：应放行
    const r = await core.callCapability('admin.op', {}, { caller: 'host', scope: 'admin', principal: 'host-principal' });
    assertEquals(r.ok, true, `权限充足应放行，实际：${r.error ?? ''}`);
    assertEquals(r.payload, 'ok');
  });

  // R0-23（专家复审 P0-D）：专家点名"伪造 principal + 自报足额 scope 也会被拒吗"——
  // 修复前会放行（scope 完全由调用方自报）。现要求身份经 assertIdentity 登记，未登记即 fail closed。
  runner.test('R0-23/P【门禁】伪造 principal + **自报足额 scope** 必须被拒（专家点名）', async () => {
    const core = newCore();
    let called = 0;
    core.registerCapability('admin.forge', {
      handler: () => { called += 1; return 'ok'; },
      owner: 'trusted',
      permissions: { require_identity: true, scope: 'admin' },
    });
    // 攻击面：自报 caller 与足额 scope，但 principal 未经登记
    const r = await core.callCapability('admin.forge', {}, { caller: 'attacker', scope: 'admin', principal: 'never-registered' });
    assertEquals(r.ok, false, '自报足额 scope 也必须被拒（不能以自报字段作为授权依据）');
    assert(/身份未经证实/.test(String(r.error)), `应具名"身份未经证实"，实际：${r.error}`);
    assertEquals(called, 0, 'handler 不得执行');
  });

  runner.test('R0-23/Q【门禁】自报 opts._trusted 不得绕过门禁（本轮新发现）', async () => {
    const core = newCore();
    let called = 0;
    core.registerCapability('admin.trusted', {
      handler: () => { called += 1; return 'ok'; },
      owner: 'trusted',
      permissions: { require_identity: true, scope: 'admin' },
    });
    // 修复前：opts._trusted === true 是调用方自报旁路，可跳过 require_identity 与参数校验
    const r = await core.callCapability('admin.trusted', {}, { _trusted: true });
    assertEquals(r.ok, false, '自报 _trusted 旁路必须已移除（核心不再读该字段）');
    assertEquals(called, 0, 'handler 不得执行');
  });

  runner.test('R0-23/R【门禁】受信 principal 登记后正常放行（避免"一律拒绝"的假安全）', async () => {
    const core = newCore();
    core.registerCapability('admin.ok', {
      handler: () => 'ok', owner: 'trusted',
      permissions: { require_identity: true, scope: 'write' },
    });
    assertAsHost(core, 'p-ok', { caller: 'host', scope: 'admin' });
    const r = await core.callCapability('admin.ok', {}, { caller: 'host', scope: 'admin', principal: 'p-ok' });
    assertEquals(r.ok, true, `受信通道应放行，实际：${r.error ?? ''}`);
    assertEquals(r.payload, 'ok');
  });

  runner.test('R0-3/D【门禁】permissions 已被真实存储（不再是静默丢弃）', () => {
    const core = newCore();
    core.registerCapability('p.high', {
      handler: () => 'x', owner: 'a',
      permissions: { require_identity: true, scope: 'admin' },
    });
    const cap = core._capabilities.get('p.high');
    // 修复前：registerCapability 用固定字段解构，permissions 被**静默丢弃**，
    // 能力表里根本没这个键——"声明了不执行"其实是"从未被保存"。
    assert(cap.permissions != null, 'permissions 必须进入能力表（不得静默丢弃）');
    assertEquals(cap.permissions.require_identity, true);
    assertEquals(cap.permissions.scope, 'admin');
  });

  runner.test('R0-3/E【门禁】未声明 permissions 的能力保持既有行为（不误伤存量插件）', async () => {
    const core = newCore();
    core.registerCapability('legacy.cap', { handler: () => 'legacy-ok', owner: 'old-plugin' });
    // 存量能力没有 permissions → 不应因引入 Gate 而全部失效
    const r = await core.callCapability('legacy.cap', {});
    assertEquals(r.ok, true, '未声明 permissions 的能力应照常可调用');
    assertEquals(r.payload, 'legacy-ok');
  });

  runner.test('R0-3/F【门禁】拒绝事件可观测（宿主能发现越权尝试）', async () => {
    const core = newCore();
    const seen = [];
    core.on('core:capability.denied', (e) => seen.push(e));
    core.registerCapability('guarded', {
      handler: () => 'no', owner: 'a',
      permissions: { require_identity: true },
    });
    await core.callCapability('guarded', {}, {});
    assertEquals(seen.length, 1, '越权尝试必须发出可观测事件');
    assertEquals(seen[0].capability, 'guarded');
  });

  runner.test('R0-3/G【已生效】能力冻结（_frozen）确实拦截调用', async () => {
    const core = newCore();
    core.registerCapability('frozen.cap', { handler: () => 'should-not-run', owner: 'a' });
    core.freezeCapability('frozen.cap');
    const r = await core.callCapability('frozen.cap', {});
    assertEquals(r.ok, false, '冻结的能力应被拒绝');
    assert(/frozen/.test(String(r.error)), `拒绝原因应具名 frozen，实际：${r.error}`);
    // 注意：这是**生命周期**防护，不是权限防护——两者不可混淆
  });

  runner.test('R0-3/H【已生效】能力注册仲裁拒绝跨所有者夺取（R0-2 产物）', () => {
    const core = newCore();
    core.registerCapability('owned.cap', { handler: () => 'a', owner: 'plugin-a' });
    let msg = '';
    try { core.registerCapability('owned.cap', { handler: () => 'b', owner: 'plugin-b' }); } catch (e) { msg = e.message; }
    assert(/capability_conflict/.test(msg), '跨所有者夺取应被拒绝');
  });

  // ===== 二、非法参数（专家 §七「非法参数」——本轮已闭合）=====

  runner.test('R0-3/J【门禁】非法参数被拒绝且 handler 不执行（input_schema 必填/类型）', async () => {
    const core = newCore();
    let ran = 0;
    core.registerCapability('typed.guarded', {
      handler: () => { ran += 1; return 'ok'; },
      owner: 'p',
      permissions: { require_identity: true, scope: 'write' },
      input_schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, n: { type: 'integer' } } },
    });
    const OK = { caller: 'host', scope: 'write', principal: 'j-principal' };
    assertAsHost(core, 'j-principal', { caller: 'host', scope: 'write' });
    let r = await core.callCapability('typed.guarded', { n: 1 }, OK);
    assertEquals(r.ok, false, '缺必填参数应被拒绝');
    assert(/缺少必填参数/.test(String(r.error)), `应具名缺参，实际：${r.error}`);
    r = await core.callCapability('typed.guarded', { name: 42 }, OK);
    assertEquals(r.ok, false, '类型错应被拒绝');
    r = await core.callCapability('typed.guarded', { name: 'a', n: 'x' }, OK);
    assertEquals(r.ok, false, 'integer 字段传字符串应被拒绝');
    assertEquals(ran, 0, '**非法参数不得触达 handler**');
    // 合法参数放行（避免"一律拒绝"的假安全）
    r = await core.callCapability('typed.guarded', { name: 'a', n: 3 }, OK);
    assertEquals(r.ok, true, `合法参数应放行，实际：${r.error ?? ''}`);
    r = await core.callCapability('typed.guarded', { name: 'a' }, OK);
    assertEquals(r.ok, true, '非必填字段缺省应放行');
    assertEquals(ran, 2, '仅两个合法调用应触达 handler');
  });

  runner.test('R0-3/K【门禁】未声明 input_schema 的能力不受参数校验影响', async () => {
    const core = newCore();
    core.registerCapability('loose.cap', { handler: () => 'ok', owner: 'a' });
    const r = await core.callCapability('loose.cap', { anything: 1, nested: { x: 2 } });
    assertEquals(r.ok, true, '未声明 schema 的能力不应被参数校验拦住（不误伤存量插件）');
  });

  runner.test('R0-3/L【缺口】getService 直取内部对象——绕过能力层，本轮未闭合', async () => {
    const core = newCore();
    const secretStore = { read: () => 'sensitive-data' };
    core.registerService('internal-secret-store', secretStore);
    const got = core.getService('internal-secret-store');
    assertEquals(got.read(), 'sensitive-data', '当前实现：Service 无信任域边界（R0-3 剩余缺口）');
    // 专家 §四：Service 只能在可信执行域内使用；跨信任边界必须经受控 Capability。
    // 但如专家所述，在无进程隔离时"规定不允许"不构成强制边界——故这是**已知缺口**而非可断言拒绝的行为。
  });

  runner.test('R0-3/M【缺口】core.command 回退路径——已接入同一 Gate', async () => {
    const core = newCore();
    let called = 0;
    core.registerCapability('cmd.target', {
      handler: () => { called += 1; return 'cmd-ok'; }, owner: 'trusted',
      permissions: { require_identity: true },
    });
    // 专家 §四明确要求审查 command 是否形成绕行入口。
    // 现状：core.command 经能力表执行，故与 callCapability 同样受 Gate 约束（已闭合）。
    const r = await core.command('cmd.target', {}, 1000);
    assertEquals(r.ok, false, 'command 回退路径不得绕过能力 Gate');
    assertEquals(called, 0, 'handler 不得执行');
  });

  // ===== 三、结构性事实（静态证据）=====

  runner.test('R0-3/N【静态证据】内核源码确实读取 .permissions（防护已接线）', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const coreDir = join(HERE, '..', '..', 'src', 'core');
    let hits = 0;
    for (const f of readdirSync(coreDir)) {
      if (!f.endsWith('.js')) continue;
      const m = readFileSync(join(coreDir, f), 'utf8').match(/\.permissions\b/g);
      if (m) hits += m.length;
    }
    assert(hits > 0, `内核 src/core/ 中 .permissions 读取数应 > 0（防护已接线），实际 ${hits}`);
  });

  runner.test('R0-3/O【静态证据】callCapability 接受调用者身份上下文', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(join(HERE, '..', '..', 'src', 'core', 'core.js'), 'utf8');
    // 签名仍是 (id, params, opts)——身份经 opts 传入（caller/scope/source），
    // 不再新增位置参数以保持对既有 15 处调用的兼容。
    const m = src.match(/async callCapability\(([^)]*)\)/);
    assert(m, '应能定位 callCapability 签名');
    assert(/opts/.test(m[1]), `callCapability 应保留 opts（身份经其中传入），实际签名：${m[1]}`);
    assert(/_invocationContext/.test(src), 'callCapability 必须调用 InvocationContext 校验');
  });

  // ===== 四、R0-28（专家第六轮 §3）：身份认证入口与登记值判据 =====

  runner.test('R0-28/A【门禁】未注入授权令牌的实例：assertIdentity 一律拒绝（无静默自证）', () => {
    const bare = new Core({}); // 宿主未注入令牌
    bare.log = () => {};
    let threw = null;
    try { bare.assertIdentity('evil', { caller: 'attacker', scope: 'admin' }); } catch (e) { threw = e; }
    assert(threw != null, '未注入令牌时 assertIdentity 必须抛错，不得静默登记任意 principal');
    assert(/identity_authority_unavailable/.test(String(threw?.message)), `应具名拒绝，实际：${threw?.message}`);
  });

  runner.test('R0-28/B【门禁】无令牌调用者不得颁发身份（专家点名的 assertIdentity 风险点）', () => {
    const core = newCore(); // 宿主已注入令牌
    let threw = null;
    try { core.assertIdentity('evil', { caller: 'attacker', scope: 'admin' }); } catch (e) { threw = e; }
    assert(threw != null, '不持令牌的调用者必须被拒（否则任何持 core 引用的插件都能自证身份）');
    assert(/identity_authority_denied/.test(String(threw?.message)), `应具名拒绝，实际：${threw?.message}`);
    // 且确实没有登记进去
    assertEquals(core._trustedCallers.has('evil'), false, '被拒的 principal 不得进入受信登记表');
  });

  runner.test('R0-28/C【门禁】伪造 issuer 对象不得通过（令牌按身份比较，不按形状）', () => {
    const core = newCore();
    let threw = null;
    // 攻击面：传一个"看起来像令牌"的对象
    try { core.assertIdentity('evil', { caller: 'x', scope: 'admin', issuer: { role: 'identity-authority' } }); } catch (e) { threw = e; }
    assert(threw != null, '伪造 issuer 必须被拒');
    assertEquals(core._trustedCallers.has('evil'), false, '伪造 issuer 不得登记成功');
  });

  runner.test('R0-28/D【门禁·决定性】登记 scope=read 的受信主体自报 scope=admin 必须被拒（第六轮追问的绑定一致性）', async () => {
    const core = newCore();
    let called = 0;
    core.registerCapability('admin.bound', {
      handler: () => { called += 1; return 'ok'; },
      owner: 'trusted',
      permissions: { require_identity: true, scope: 'admin' },
    });
    assertAsHost(core, 'p-low', { caller: 'host', scope: 'read' });
    // 修复前：登记表只被当作"是否存在"的开关，授权等级仍取调用方自报的 scope → 放行并执行 handler
    const r = await core.callCapability('admin.bound', {}, { principal: 'p-low', caller: 'x', scope: 'admin' });
    assertEquals(r.ok, false, '登记授权是唯一判据：自报不得超出登记');
    assert(/超出受信主体/.test(String(r.error)), `应具名说明越权自报，实际：${r.error}`);
    assertEquals(called, 0, 'handler 不得执行');
  });

  runner.test('R0-28/E【门禁】登记 scope=admin 的受信主体正常放行（避免"一律拒绝"的假安全）', async () => {
    const core = newCore();
    core.registerCapability('admin.granted', {
      handler: () => 'ok', owner: 'trusted',
      permissions: { require_identity: true, scope: 'admin' },
    });
    assertAsHost(core, 'p-admin', { caller: 'host', scope: 'admin' });
    const r = await core.callCapability('admin.granted', {}, { principal: 'p-admin', caller: 'host', scope: 'admin' });
    assertEquals(r.ok, true, `足额登记应放行，实际：${r.error ?? ''}`);
  });

  runner.test('R0-28/F【门禁】assertIdentity 拒绝非法入参（空 principal / 未知 scope）', () => {
    const core = newCore();
    for (const [p, g] of [['', { caller: 'h', scope: 'read' }], [null, { caller: 'h', scope: 'read' }], [42, { caller: 'h', scope: 'read' }]]) {
      let threw = null;
      try { assertAsHost(core, p, g); } catch (e) { threw = e; }
      assert(threw != null, `principal=${JSON.stringify(p)} 应被拒绝`);
    }
    let threw = null;
    try { assertAsHost(core, 'p', { caller: 'h', scope: 'root' }); } catch (e) { threw = e; }
    assert(threw != null, '未知 scope 应被拒绝（防止自造更高等级）');
  });

  // ===== 五、R0-28：input_schema 必须与 permissions 无关地生效 =====

  runner.test('R0-28/G【门禁·决定性】未声明 permissions 的能力，input_schema 仍必须生效', async () => {
    const core = newCore();
    let ran = 0;
    // 关键：**不声明 permissions**。修复前 _invocationContext 在此处提前 return，schema 被整体跳过。
    core.registerCapability('schema.only', {
      handler: () => { ran += 1; return 'ok'; },
      owner: 'p',
      input_schema: { type: 'object', required: ['n'], properties: { n: { type: 'integer' } } },
    });
    let r = await core.callCapability('schema.only', { n: 1.5 });
    assertEquals(r.ok, false, 'integer 字段传 1.5 必须被拒（修复前放行）');
    r = await core.callCapability('schema.only', { n: '1' });
    assertEquals(r.ok, false, 'integer 字段传字符串必须被拒');
    r = await core.callCapability('schema.only', {});
    assertEquals(r.ok, false, '缺必填参数必须被拒');
    assertEquals(ran, 0, '非法参数不得触达 handler');
    r = await core.callCapability('schema.only', { n: 2 });
    assertEquals(r.ok, true, `合法整数应放行，实际：${r.error ?? ''}`);
    assertEquals(ran, 1, '仅合法调用触达 handler');
  });

  runner.test('R0-28/H【门禁】integer 严格判定：1.5 / "1" / null 全拒，1 与 -3 放行', async () => {
    const core = newCore();
    core.registerCapability('int.strict', {
      handler: () => 'ok', owner: 'p',
      input_schema: { type: 'object', properties: { n: { type: 'integer' } } },
    });
    for (const [v, expect] of [[1, true], [1.5, false], ['1', false], [null, false], [-3, true], [0, true]]) {
      const r = await core.callCapability('int.strict', { n: v });
      assertEquals(r.ok, expect, `n=${JSON.stringify(v)} 期望 ok=${expect}，实际 ok=${r.ok}（${r.error ?? ''}）`);
    }
  });

  runner.test('R0-28/I【门禁】不支持的（尤其安全关键）schema 关键字：登记成功但逐条记成未生效约束', () => {
    const core = newCore();
    const warns = [];
    core.log = (level, msg) => { if (level === 'warn') warns.push(String(msg)); };
    for (const kw of ['pattern', 'enum', 'const', 'minimum', 'maximum', 'format', 'items', '$ref', 'oneOf']) {
      const spec = { type: 'string' };
      spec[kw] = kw === 'items' ? [] : kw === 'enum' ? ['a'] : kw === 'oneOf' ? [] : kw === 'minimum' || kw === 'maximum' ? 1 : kw === '$ref' ? '#/x' : 'v';
      const id = `cap.${kw}`;
      core.registerCapability(id, { handler: () => 'x', owner: 'p', input_schema: { type: 'object', properties: { s: spec } } });
      const seen = (core._capabilities.get(id)?.schema_unvalidated || []).map((i) => i.keyword);
      assert(seen.includes(kw), `关键字 '${kw}' 必须被记成未生效约束（不得静默忽略），实际 ${JSON.stringify(seen)}`);
      const row = core.listCapabilities().find((c) => c.id === id);
      assert(row?.schema_unvalidated?.includes(kw), `listCapabilities 必须能枚举出 '${kw}' 未生效`);
    }
    assert(warns.some((w) => /\[schema\]/.test(w) && /未生效/.test(w)), `必须留下具名告警，实际 ${JSON.stringify(warns)}`);
  });
}
