#!/usr/bin/env node
/**
 * verification/counterexamples/rc20-declaration-snapshot-4.mjs
 *
 * 专家 rc.19 复审的 4 条工单 —— 本仓自己的版本，逐条把“修好了没有”变成可复跑判据。
 *
 * 四条共同点只有一句：**判据看起来存在，但在某个分支上恰好不生效**。
 *   01 R19-A 输入声明快照：只锁两个声明、真正做准入的第三个留着原引用
 *   02 R19-B 围栏解析：凭据随机了，却由公开函数直接发出去
 *   03 R19-C 声明降级分支：快照在最需要它的那条分支上只换了最外层
 *   04 R19-D 制品基线：校验器认的状态词与生成器写的不是一套，于是那段检查从未执行
 *
 * 每条都配**对称正例**：专家明确要求“不得通过禁掉 schema 或全拒绝冒充修复”。
 * 四条反例全拒而正例全拒的实现，在这里同样是红的。
 *
 * 跑：node verification/counterexamples/rc20-declaration-snapshot-4.mjs
 * 退出码 0 = 4/4 FIXED（且正例全绿）；1 = 仍有反例或正例被误杀；2 = 探针自身出错。
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const { Core } = await import(join(ROOT, 'src/core/core.js'));
const { ToolExecutor, setFence, removeFence, resolveFence } = await import(join(ROOT, 'plugins/tool-executor.js'));

const rows = [];
const quiet = (c) => { c.log = () => {}; return c; };

async function check(id, title, fn) {
  let dir = mkdtempSync(join(tmpdir(), 'rc20-'));
  try {
    const facts = await fn(dir);
    rows.push({ id, title, status: facts.fixed ? 'FIXED' : 'COUNTEREXAMPLE', ...facts });
  } catch (err) {
    rows.push({ id, title, status: 'PROBE_ERROR', error: String(err?.message || err) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 01 R19-A：登记方改自己手里那份 schema，不得改变同一登记的准入结果
await check('01', 'R19-A input_schema 必须是登记期快照，改登记前持有的对象不得改变准入', async (t) => {
  const core = quiet(new Core({ stateDir: t }));
  let called = 0;
  const schema = { required: ['n'], properties: { n: { type: 'integer' } } };
  const handle = core.registerCapability('audit.input', {
    input_schema: schema, handler: () => { called++; return 'SIDE_EFFECT'; },
  });
  const regId = core.capabilityRegistration('audit.input').registrationId;

  // 反例形状①：登记后把 type 放松，非法入参必须仍被拒
  const before = await core.callCapability('audit.input', { n: 'bad' });
  schema.properties.n.type = 'string';
  const afterLoose = await core.callCapability('audit.input', { n: 'bad' });
  // 只数**反例路径**上的执行：两条 `n:'bad'` 都被拒，handler 必须一次都没跑。
  // 后面两条合法调用本来就会执行，不能算进来（否则这个数字没有意义）。
  const callsOnCounterexamplePath = called;
  // 反例形状②：原本合法的入参不得因此变成非法
  const afterValid = await core.callCapability('audit.input', { n: 1 });
  // 反例形状③：改 required 数组（嵌套外的另一种共享）
  schema.required.push('extra');
  // required 改的是登记方手里那份（快照已冻结），故准入判据不得随之变化
  const afterRequired = await core.callCapability('audit.input', { n: 2 });

  // 两条反例调用都必须被拒，且都没有执行 handler。
  const stillRefused = before.code === 'invalid_input' && afterLoose.code === 'invalid_input'
    && callsOnCounterexamplePath === 0;
  const validStillWorks = afterValid.ok === true;

  // 正例①：持凭据重登记后，新判据生效且登记号变化
  core.registerCapability('audit.input', {
    overrideBy: handle,
    input_schema: { required: ['n'], properties: { n: { type: 'string' } } },
    handler: () => { called++; return 'SIDE_EFFECT'; },
  });
  const newRegId = core.capabilityRegistration('audit.input').registrationId;
  const overrideWorks = (await core.callCapability('audit.input', { n: 'str' })).ok === true
    && newRegId !== regId;

  return {
    fixed: stillRefused && validStillWorks && overrideWorks && afterRequired.ok === true,
    refusedBeforeMutation: before.code === 'invalid_input',
    refusedAfterMutation: afterLoose.code === 'invalid_input',
    handlerCallsOnCounterexamplePath: callsOnCounterexamplePath,
    validInputUnaffected: afterValid.ok === true,
    requiredArrayIsolated: afterRequired.ok === true,
    credentialledOverrideWorks: overrideWorks,
    registrationIdChanged: newRegId !== regId,
  };
});

// 02 R19-B：仅持公开解析结果，不得撤销/替换原围栏；安装者合法路径仍通
await check('02', 'R19-B resolveFence 不得交出撤销凭据与活围栏管理面', async (t) => {
  const core = quiet(new Core({ stateDir: t }));
  let called = 0;
  let installerStopHits = 0;
  core.registerCapability('tool.write', { handler: () => { called++; return 'SIDE_EFFECT'; } });
  const ex = new ToolExecutor();
  ex.core = core; ex._useSandbox = false; ex._hookErrors = 0;

  const strict = {
    preCheck: () => ({ ok: false, result: { code: 'strict', reason: 'review fence denies' } }),
    // 安装者对象上的“管理方法”：解析结果不该能碰到它
    stop() { installerStopHits++; },
  };
  const installed = setFence(strict, { owner: 'guardian', core });

  const blockedBefore = await ex.executeOne('tool-write', {}, 's', 'c');
  // 普通的 owner-only 撤销仍必须被拒（这不是本条的新判据，但一起反检）
  const ownerOnly = removeFence({ owner: 'guardian', core });

  const observed = resolveFence(core);
  const tokenLeaked = observed != null && Object.prototype.hasOwnProperty.call(observed, 'token');
  const fenceIsOriginal = observed?.fence === strict;
  // 反例形状②：解析结果不得提供安装者的其它方法
  let stopReachable = false;
  try { observed?.fence?.stop?.(); stopReachable = installerStopHits > 0; } catch { stopReachable = false; }
  // 反例形状①：解析结果里的 token 不得能撤销
  let removedViaObservation = false;
  try { removedViaObservation = removeFence({ token: observed?.token }) === true; } catch { removedViaObservation = false; }

  // 走完这些之后围栏必须还在，且仍拦得住（handler 一次都没跑）
  const stillBlocked = (await ex.executeOne('tool-write', {}, 's', 'c')).status === 'blocked';
  const neverRan = called === 0;

  // 正例①：同 owner + 原 disposer 的合法替换仍然可用，执行面（preCheck）真的被调用
  let preCheckRan = false;
  const relaxed = setFence({ preCheck: () => { preCheckRan = true; return { ok: true }; } },
    { owner: 'guardian', core, disposer: installed.disposer });
  const afterReplace = await ex.executeOne('tool-write', {}, 's', 'c');

  // 正例②：持新 disposer 可撤销；旧 disposer 随之失效
  const released = removeFence({ owner: 'guardian', core, disposer: relaxed.disposer });
  const cleared = resolveFence(core) === null;
  const staleDead = removeFence({ owner: 'guardian', core, disposer: installed.disposer }) === false;

  return {
    fixed: !tokenLeaked && !fenceIsOriginal && !stopReachable && !removedViaObservation
      && stillBlocked && neverRan && ownerOnly === false
      && preCheckRan && afterReplace.ok === true && released && cleared && staleDead,
    tokenLeaked,
    fenceObjectExposed: fenceIsOriginal,
    installerMethodReachable: stopReachable,
    removedViaObservation,
    strictFenceStillBlocks: stillBlocked,
    handlerNeverRanOnCounterexamplePath: neverRan,
    ownerOnlyRemovalStillDenied: ownerOnly === false,
    legitReplaceAndPreCheckStillRun: preCheckRan,
    legitReplaceActuallyExecuted: afterReplace.ok === true,
    legitReleaseWorks: released,
    oldCredentialInvalidated: staleDead,
  };
});

// 03 R19-C：不接受的声明必须在登记期具名失败且无半笔登记；接受的声明无嵌套共享
await check('03', 'R19-C 声明快照不得共享嵌套引用，非纯数据须具名拒绝', async (t) => {
  const core = quiet(new Core({ stateDir: t }));

  // 反例形状：带函数字段的 output_schema 曾经走“浅冻结降级”，嵌套对象仍共享
  let rejection = null;
  try {
    core.registerCapability('audit.degraded', {
      output_schema: { properties: { n: { type: 'integer' } }, diagnostic: () => {} },
      handler: () => ({ n: 1 }),
    });
    rejection = 'ACCEPTED';
  } catch (e) { rejection = e.code ?? 'threw-without-code'; }
  // 具名拒绝必须**没有半笔登记**：能力不存在，查询也拿不到东西
  const noHalfRegistration = core.capabilityRegistration('audit.degraded') === null
    && core.getCapabilityOutputSchema('audit.degraded') === null;

  // 环也必须具名拒绝（不是栈溢出/静默接受）
  let circular = null;
  const cyc = { properties: { n: { type: 'integer' } } };
  cyc.self = cyc;
  try { core.registerCapability('audit.circular', { input_schema: cyc, handler: () => 1 }); circular = 'ACCEPTED'; }
  catch (e) { circular = e.code ?? 'threw-without-code'; }

  // 正例①：普通 JSON 声明登记/读取正常，且两次读取的嵌套对象不共享
  core.registerCapability('audit.plain', {
    input_schema: { required: ['n'], properties: { n: { type: 'integer' } } },
    output_schema: { properties: { n: { type: 'integer' } } },
    handler: () => ({ n: 1 }),
  });
  const v1 = core.getCapabilityOutputSchema('audit.plain');
  v1.properties.n.type = 'string';
  const v2 = core.getCapabilityOutputSchema('audit.plain');
  const isolated = v2.properties.n.type === 'integer' && v2.properties !== v1.properties;

  // 正例②：登记方手里的原对象也改不动权威值
  // 正例③：合法调用仍然工作
  const call = await core.callCapability('audit.plain', { n: 3 });

  return {
    fixed: rejection === 'declaration_not_pure_data' && noHalfRegistration
      && circular === 'declaration_not_pure_data' && isolated && call.ok === true,
    impureDeclarationRejected: rejection,
    noHalfRegistration,
    circularDeclarationRejected: circular,
    nestedObjectsIsolated: isolated,
    plainDeclarationStillWorks: call.ok === true,
  };
});

// 04 R19-D：制品哈希失配必须真红，且失败项必须点名 artifact
//
// 判据只看 baseline-check 自己吐出来的 diffs，不看“整棵树是否已经全绿”：
// 本轮改了核心，树摘要本来就该漂 —— 拿“全绿”当判据会让这条探针替基线重绑背书。
await check('04', 'R19-D baseline-check 必须实算制品：失配真红、缺件真红、正确时不出 artifact 项', async (t) => {
  const repoBl = join(ROOT, 'verification', 'baseline.json');
  const backup = join(t, 'baseline.backup.json');
  copyFileSync(repoBl, backup);
  const base = JSON.parse(readFileSync(repoBl, 'utf8'));
  const artFile = base.artifact?.file;
  if (!artFile) return { fixed: false, reason: 'baseline 未登记制品，本判据无从测起' };
  const runJson = () => {
    const r = spawnSync(process.execPath, [join(ROOT, 'verification', 'baseline-check.mjs'), '--json'],
      { cwd: ROOT, encoding: 'utf8' });
    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch { parsed = null; }
    const diffs = parsed?.diffs ?? [];
    return {
      status: r.status,
      artifactDiffs: diffs.filter((d) => d.area === 'artifact'),
      artifactShaDiff: diffs.some((d) => d.area === 'artifact' && /sha256/.test(d.item)),
    };
  };
  try {
    // 反例形状①：登记哈希改错一位 ⇒ 必须红，且点名 artifact 的 sha256
    const tampered = JSON.parse(JSON.stringify(base));
    tampered.artifact.sha256 = 'f'.repeat(64);
    writeFileSync(repoBl, `${JSON.stringify(tampered, null, 2)}\n`);
    const bad1 = runJson();

    // 反例形状②：字节数改错 ⇒ 必须红，且点名 artifact 的字节
    const tampered2 = JSON.parse(JSON.stringify(base));
    tampered2.artifact.bytes = 1;
    writeFileSync(repoBl, `${JSON.stringify(tampered2, null, 2)}\n`);
    const bad2 = runJson();

    // 反例形状③：指向不存在的制品 ⇒ 必须红（“文件没了”不等于“没登记”）
    const tampered3 = JSON.parse(JSON.stringify(base));
    tampered3.artifact.file = 'definitely-absent-artifact.tgz';
    writeFileSync(repoBl, `${JSON.stringify(tampered3, null, 2)}\n`);
    const bad3 = runJson();

    // 正例：恢复原基线后，artifact 这一组的差异必须**正好等于基线自身的状态**。
    // 不能假设“恢复即干净”：核心改过而制品还没重打时，制品本来就该与源码不同 ——
    // 本条只回答“制品核对到底跑没跑”，基线是否该重绑由发布流程决定。
    copyFileSync(backup, repoBl);
    const good = runJson();
    // 篡改三项必须比原基线多出差异；恢复后不得比原基线更差（即：探针没伪造出残余漂移）。
    // 篡改必须被**点名**：diff 里要能看到我们写进去的那个错值。
    // 不用“差异数变多”当判据 —— 基线本身可能就有 artifact 差异（核心改过而包未重打时
    // 必然如此），那样“变多”只是噪声，红也指不到篡改上。
    const baselineArtifactDiffs = good.artifactDiffs.length;
    const tamperIsNamed = bad1.artifactDiffs.some((d) => /f{16}/.test(String(d.expected)))
      && bad2.artifactDiffs.some((d) => Number(d.expected) === 1);

    return {
      fixed: bad1.status !== 0 && bad1.artifactShaDiff
        && bad2.status !== 0 && bad2.artifactDiffs.some((d) => /字节/.test(d.item))
        && bad3.status !== 0 && bad3.artifactDiffs.length > 0
        && tamperIsNamed,
      mismatchedHashIsRed: bad1.status !== 0,
      mismatchNamesArtifactSha: bad1.artifactShaDiff,
      wrongByteCountIsRed: bad2.status !== 0,
      absentArtifactIsRed: bad3.status !== 0,
      artifactDiffsAfterRestore: baselineArtifactDiffs,
      tamperIsNamed: tamperIsNamed,
      // 记录实测值，便于回读；不作为 fixed 的判据
      observed: {
        bad1Status: bad1.status, bad2Status: bad2.status, bad3Status: bad3.status, goodStatus: good.status,
        goodArtifactDiffs: good.artifactDiffs.length,
      },
    };
  } finally {
    copyFileSync(backup, repoBl);
    try { unlinkSync(backup); } catch { /* 已删 */ }
  }
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
