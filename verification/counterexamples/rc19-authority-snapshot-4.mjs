#!/usr/bin/env node
/**
 * verification/counterexamples/rc19-authority-snapshot-4.mjs
 *
 * 专家 rc.18 复审的 4 条新反例 —— 本仓自己的版本，逐条把"修好了没有"变成可复跑判据。
 *
 * 这四条共同点只有一句：**同一份只读视图不得变成另一种写入入口**。
 *   01 R18-A 围栏同名替换：替换权与撤销权必须同源（不再是"知道 owner 就顶掉"）
 *   02 R18-B 权限权威快照：公开 getter 不得成为改写派发判据的第二授权面
 *   03 R18-C 撤销目标匹配：撤销只能作用于调用方指定的那笔登记
 *   04 R18-D 审计快照：查询不得改写已存在的证据
 *
 * 每条都配**对称正例**：专家明确要求"不得通过全拒绝冒充修复"。四条反例全拒而
 * 正例全拒的实现，在这里同样是红的。
 *
 * 跑：node verification/counterexamples/rc19-authority-snapshot-4.mjs
 * 退出码 0 = 4/4 FIXED（且正例全绿）；1 = 仍有反例或正例被误杀；2 = 探针自身出错。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const { Core } = await import(join(ROOT, 'src/core/core.js'));
const { ToolExecutor, setFence, removeFence, resolveFence } = await import(join(ROOT, 'plugins/tool-executor.js'));

const rows = [];
const quiet = (c) => { c.log = () => {}; return c; };

async function check(id, title, fn) {
  let dir = mkdtempSync(join(tmpdir(), 'rc19-'));
  try {
    const facts = await fn(dir);
    // 反例性质不再可达 **且** 合法正例仍然可用，才算 FIXED。
    rows.push({ id, title, status: facts.fixed ? 'FIXED' : 'COUNTEREXAMPLE', ...facts });
  } catch (err) {
    rows.push({ id, title, status: 'PROBE_ERROR', error: String(err?.message || err) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 01 R18-A：无凭据的同名 setFence 必须被拒，且原围栏保持有效；持凭据替换/撤销必须仍可用
await check('01', 'R18-A 围栏同名替换须持凭据或受信 reload，原围栏不得被裸 owner 顶掉', async (t) => {
  const core = quiet(new Core({ stateDir: t }));
  const strict = { preCheck: () => ({ block: true, reason: 'strict' }) };
  const lax = { preCheck: () => ({ block: false }) };

  const first = setFence(strict, { owner: 'guardian', core });
  // 反例形状：只凭公开 owner 字符串就重装，把严格围栏换成宽松围栏
  let hijackCode = null;
  try { setFence(lax, { owner: 'guardian', core }); hijackCode = 'ALLOWED'; }
  catch (e) { hijackCode = e.code ?? 'threw'; }
  // 判据必须是**行为**而不是对象同一性：公开解析按合同不再交回安装者的原对象
  // （那对象上还挂着它自己的其它方法，等于一个等价的管理入口）。这里问的是
  // “现在生效的究竟是不是严格那份”，用 preCheck 的真实结论回答。
  const stillStrict = resolveFence(core)?.fence?.preCheck?.('t', {}, 's', null, null)?.block === true;

  // 正例①：持 disposer 可合法替换（reload 之外的正常更新路径）
  const second = setFence(lax, { owner: 'guardian', core, disposer: first.disposer });
  // 收紧：不能只判“不是严格那份”——随便一个坏围栏也能满足。要比对**lax 自己的行为**。
  const laxVerdict = resolveFence(core)?.fence?.preCheck?.('t', {}, 's', null, null);
  const replaced = laxVerdict?.block === false;
  // 正例②：旧 disposer 在替换后失效（不能当万能钥匙一直用）
  const oldDisposerDead = removeFence({ owner: 'guardian', core, disposer: first.disposer }) === false;
  // 正例③：持新凭据可撤销
  const removed = removeFence({ owner: 'guardian', core, disposer: second.disposer }) === true;
  const cleared = resolveFence(core) == null;

  // 正例④：首次安装（无同名围栏）不需要任何凭据
  const fresh = setFence(strict, { owner: 'fresh-owner', core });
  const firstInstallOk = resolveFence(core)?.fence?.preCheck?.('t', {}, 's', null, null)?.block === true;
  removeFence({ owner: 'fresh-owner', core, disposer: fresh.disposer });

  return {
    fixed: hijackCode === 'fence_replace_denied' && stillStrict === true
      && replaced && oldDisposerDead && removed && cleared && firstInstallOk,
    hijackResult: hijackCode, fenceKeptStrict: stillStrict,
    legitReplace: replaced, oldDisposerInvalidated: oldDisposerDead,
    legitRelease: removed, afterReleaseCleared: cleared, firstInstallNoCredential: firstInstallOk,
  };
});

// 02 R18-B：公开 getter 返回的权限对象不得能改写派发判据；受保护调用必须持续被拒
await check('02', 'R18-B 权限只读视图不得改写权威配置，受保护能力不得因改 getter 而放行', async (t) => {
  const core = quiet(new Core({ stateDir: t }));
  let called = 0;
  core.registerCapability('audit.B', {
    description: 'x', handler: async () => { called++; return 'SECRET'; },
    permissions: { require_identity: true, scope: 'admin' },
  });

  // 反例形状：改公开 getter 返回的对象，期望下一次派发放行
  const view = core.capabilityPermissions('audit.B');
  let mutated = false;
  try { view.require_identity = false; view.scope = null; mutated = view.require_identity === false; }
  catch { mutated = false; }
  const after = await core.callCapability('audit.B', {});
  const stillDenied = after?.ok === false && after?.code === 'capability_denied';
  const handlerNotRun = called === 0;

  // 正例①：合法受信主体仍可调用（证明拒绝不是因为把路堵死）。
  // 身份只能由**构造期注入的令牌**颁发（assertIdentity），不能自报 —— 见 ADR/identity 合同。
  const authority = Object.freeze({});
  core._identityAuthority = authority;
  core.assertIdentity('admin-1', { caller: 'admin-1', scope: 'admin', issuer: authority });
  const legit = await core.callCapability('audit.B', {}, { principal: 'admin-1' });
  const legitOk = legit?.ok === true && legit?.payload === 'SECRET';

  // 正例②：登记后改**自己那份** config 原对象也不得影响权威判据
  const cfg = { require_identity: true, scope: 'admin' };
  core.registerCapability('audit.C', { description: 'c', handler: async () => 'C', permissions: cfg });
  cfg.require_identity = false; cfg.scope = null;
  const afterCfgMutate = await core.callCapability('audit.C', {});
  const cfgStillProtected = afterCfgMutate?.ok === false && afterCfgMutate?.code === 'capability_denied';

  return {
    fixed: stillDenied && handlerNotRun && legitOk && cfgStillProtected,
    getterViewMutable: mutated, deniedAfterGetterMutate: stillDenied,
    handlerRan: called > 0, legitTrustedCallStillWorks: legitOk,
    registrationObjectMutationIgnored: cfgStillProtected,
  };
});

// 03 R18-C：releaseCapability(id, credential) 的 id 与凭据必须同指一笔
await check('03', 'R18-C 撤销目标与凭据不匹配时一笔未动；直接持凭据释放仍然合法', async (t) => {
  const core = quiet(new Core({ stateDir: t }));
  const hA = core.registerCapability('audit.A', { description: 'a', handler: async () => 'a' });
  const hB = core.registerCapability('audit.B', { description: 'b', handler: async () => 'b' });

  // 反例形状：点 A 的名字，交 B 的凭据
  const ret = core.releaseCapability('audit.A', hB);
  const aAlive = Boolean(core.capabilityRegistration('audit.A'));
  const bAlive = Boolean(core.capabilityRegistration('audit.B'));

  // 正例①：目标与凭据一致时确实删除
  const okDirect = core.releaseCapability('audit.B', hB);
  const bGone = !core.capabilityRegistration('audit.B');
  // 正例②：直接 releaseRegistration 仍合法
  const okHandle = core.releaseRegistration(hA);
  const aGone = !core.capabilityRegistration('audit.A');
  // 正例③：错 token（字符串）必须具名拒绝，不能误删
  const h2 = core.registerCapability('audit.D', { description: 'd', handler: async () => 'd' });
  let denyCode = null;
  try { core.releaseCapability('audit.D', 'audit.D'); } catch (e) { denyCode = e.code; }
  const dAlive = Boolean(core.capabilityRegistration('audit.D'));
  // 正例④：旧登记不得误伤重注册后的同名新登记（ABA）
  const stale = core.releaseRegistration(h2);
  core.registerCapability('audit.D', { description: 'd2', handler: async () => 'd2' });
  const staleNoop = core.releaseRegistration(h2) === false;
  const newDAlive = Boolean(core.capabilityRegistration('audit.D'));

  return {
    fixed: ret === false && aAlive && bAlive
      && okDirect && bGone && okHandle && aGone
      && denyCode === 'capability_release_denied' && dAlive
      && stale === true && staleNoop && newDAlive,
    mismatchReturned: ret, targetKept: aAlive, credentialTargetKept: bAlive,
    legitReleaseById: okDirect, legitReleaseByHandle: okHandle,
    stringCredentialDenied: denyCode, staleHandleIgnored: staleNoop,
  };
});

// 04 R18-D：审计查询必须交快照；合法查询/会话过滤/limit 仍要工作
await check('04', 'R18-D 审计查询不得改写已存在的证据，且合法查询面不受影响', async (t) => {
  const core = quiet(new Core({ stateDir: t }));
  const ex = new ToolExecutor(); ex.core = core; ex._auditLog = new Map();

  ex._addAudit({ tool: 't', sessionId: 's', args: { a: 1 }, result: { ok: true }, duration: 1, status: 'success' });
  ex._addAudit({ tool: 't', sessionId: 's', args: { a: 2 }, result: { ok: true }, duration: 2, status: 'success' });
  ex._addAudit({ tool: 't', sessionId: 'other', args: {}, result: {}, duration: 3, status: 'error' });

  // 反例形状：改查询结果里的条目
  const firstRead = ex.getAuditLog('s');
  try { firstRead[0].status = 'forged-success'; firstRead[0].duration = 999999; } catch { /* 冻结即已合格 */ }
  const secondRead = ex.getAuditLog('s');
  const forged = secondRead.some((e) => e.status === 'forged-success' || e.duration === 999999);

  // 正例①：条目内容与写入时一致
  const shapeOk = secondRead.length === 2 && secondRead[0].tool === 't' && secondRead[0].status === 'success';
  // 正例②：会话过滤仍生效
  const sessionIsolated = secondRead.every((e) => e.sessionId === 's');
  // 正例③：limit 仍生效（取最近的 N 条）
  const limited = ex.getAuditLog('s', 1);
  const limitOk = limited.length === 1 && limited[0].args != null;
  // 正例④：被拒调用仍然留痕（不能为了快照把记录面关掉）
  ex._addAudit({ tool: 't', sessionId: 's', args: {}, result: null, duration: 1, status: 'blocked', code: 'PERMISSION_DENIED', reason: 'Read-only mode' });
  const blockedLogged = ex.getAuditLog('s').some((e) => e.status === 'blocked' && e.code === 'PERMISSION_DENIED');

  // 正例⑤：调用方改自己那份副本不影响第二次查询
  const copy = ex.getAuditLog('s');
  try { copy[0].tool = 'tampered'; } catch { /* 冻结也合格 */ }
  const toolIntact = ex.getAuditLog('s')[0].tool === 't';

  return {
    fixed: !forged && shapeOk && sessionIsolated && limitOk && blockedLogged && toolIntact,
    forgedSurvived: forged, entryShapeIntact: shapeOk,
    sessionFilterWorks: sessionIsolated, limitWorks: limitOk,
    deniedCallsStillAudited: blockedLogged, returnedCopyIsolation: toolIntact,
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
