// R0-170（rc.20）：声明快照、围栏解析、制品基线 —— 三条判据的回退锁。
//
// 本文件存在的理由：这四条工单有一个共同形状 —— **判据看起来存在，但在某个分支上恰好不生效**。
// 那种缺陷不会被“有没有这段代码”的检查抓住，只会在有人真的走那条分支时露出来。
// 所以这里不测“代码里有没有 `_lockDecl`”，而是**走那条分支**看它到底生不生效。
//
// 分两层测：
//   ① **行为层**：真跑一遍反例形状，断言结果；
//   ② **接线层**：反例集必须仍挂在发布门禁上（否则它只是一个没人跑的文件），
//      且门禁用的证据口径必须是 `probe`（退出码 3 = NOT_RUN，不是 FAIL）。
//
// 只测行为会漏掉“文件在但没人跑”；只测接线会漏掉“跑了但判据被改软”。
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { assert, assertEquals } from '../harness.mjs';
import { requireRepoOnly } from '../lib/carrier.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const GATE = readFileSync(join(ROOT, 'scripts', 'release-gate.mjs'), 'utf8');
const CORE_SRC = readFileSync(join(ROOT, 'src', 'core', 'core.js'), 'utf8');
const EXEC_SRC = readFileSync(join(ROOT, 'plugins', 'tool-executor.js'), 'utf8');

const imp = (rel) => import(pathToFileURL(join(ROOT, rel)).href);

/** 每个用例一个独立 stateDir，且吞掉日志噪声。 */
async function freshCore(tag) {
  const dir = mkdtempSync(join(tmpdir(), `r0170-${tag}-`));
  const { Core } = await imp('src/core/core.js');
  const core = new Core({ stateDir: dir });
  core.log = () => {};
  return { core, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ── ① R19-A 行为层 ────────────────────────────────────────────
// 入口约定：`export async function setup(runner)`（见 test/run-unit.mjs）。
// 写成自跑脚本会**不被套件执行** —— 那样 1308 这个数里根本不含本文件，
// 红绿都与它无关，却看起来“加了一条防线”。
export async function setup(runner) {
  runner.test('R0-170/1 input_schema 是登记期快照：改登记方手里的对象不改变准入', async () => {
  const { core, cleanup } = await freshCore('schema');
  try {
    let called = 0;
    const schema = { required: ['n'], properties: { n: { type: 'integer' } } };
    core.registerCapability('audit.input', { input_schema: schema, handler: () => { called++; return 'X'; } });

    const first = await core.callCapability('audit.input', { n: 'bad' });
    assertEquals(first.code, 'invalid_input', '修复前这里的定位：非法入参必须被拒');

    // 反例形状：登记完成后改**登记方仍持有**的那个对象
    schema.properties.n.type = 'string';
    schema.required.push('extra');

    const afterLoose = await core.callCapability('audit.input', { n: 'bad' });
    assertEquals(afterLoose.code, 'invalid_input',
      '改了登记方手里的 schema 之后，非法入参必须仍被拒（否则登记号没变而准入被改）');
    const afterValid = await core.callCapability('audit.input', { n: 1 });
    assertEquals(afterValid.ok, true, '原本合法的入参不得因为外部改 schema 而变成非法');
    assertEquals(called, 1, '前两次必须零执行，只有最后那次合法调用执行 handler');
  } finally { cleanup(); }
});

  runner.test('R0-170/2 三个声明各锁一次、且在**校验之前**就锁，登记处不再各自加锁', () => {
  // 结构性判据（rc.32 收紧）：旧版只要求“登记那一行里有 _lockDecl()”，于是三次加锁
  // 散在 record 字面量里，外加 `_assertSchemaSupported` 读的是**未锁的原对象** ——
  // 那正是 RC31-C1 的形状（审 A、存 B）。现在要求三件事同时成立：
  //   ① 三个声明各有一个 `const lockedX = this._lockDecl(...)`（不是裸引用）；
  //   ② `_assertSchemaSupported` 读的是 locked 变量（判据与提交同一对象）；
  //   ③ record 里不再出现 `_lockDecl(`（派生属性不得成为第二个冻结口）。
  const pre = CORE_SRC.match(/const lockedInput = this\._lockDecl\(input_schema[\s\S]{0,400}?const lockedPerms = this\._lockDecl\(permissions/);
  assert(pre, '三个声明必须在登记早期各取一次权威快照（lockedInput / lockedOutput / lockedPerms）');

  const chk = CORE_SRC.match(/_assertSchemaSupported\(id,\s*([A-Za-z_$][\w$]*),\s*'input_schema'\)/);
  assert(chk, '找不到 input_schema 的支持面校验');
  assertEquals(chk[1], 'lockedInput',
    `支持面校验必须读**已冻结的那份副本**，实际读 ${chk[1]}（读原对象 = 审一个、存另一个）`);
  const chkOut = CORE_SRC.match(/_assertSchemaSupported\(id,\s*([A-Za-z_$][\w$]*),\s*'output_schema'\)/);
  assert(chkOut && chkOut[1] === 'lockedOutput', 'output_schema 支持面校验同样必须读已冻结副本');

  const record = CORE_SRC.slice(CORE_SRC.indexOf('const record = {'), CORE_SRC.indexOf('this._capabilities.set(id, record)'));
  assert(record.length > 0, '找不到 record 字面量');
  assert(!/_lockDecl\s*\(/.test(record),
    'record 字面量里不得再调 _lockDecl()：三个声明已在上面锁好，派生属性再锁一次就是第二个冻结口');
  for (const [field, locked] of [['input_schema', 'lockedInput'], ['output_schema', 'lockedOutput'], ['permissions', 'lockedPerms']]) {
    const m = record.match(new RegExp(`${field}:\\s*([^\\n]+),\\n`));
    assert(m, `record 里找不到 ${field}`);
    assert(new RegExp(`_lockDecl|${locked}`).test(m[1]), `${field} 必须来自登记期权威快照，实际 ${m[1].trim()}`);
  }
});

// ── ② R19-C 行为层 ────────────────────────────────────────────
  runner.test('R0-170/3 非纯数据声明在登记期具名拒绝，且不留半笔登记', async () => {
  const { core, cleanup } = await freshCore('decl');
  try {
    let code = null;
    try {
      core.registerCapability('audit.degraded', {
        output_schema: { properties: { n: { type: 'integer' } }, diagnostic: () => {} },
        handler: () => ({ n: 1 }),
      });
      code = 'ACCEPTED';
    } catch (e) { code = e.code; }
    assertEquals(code, 'declaration_not_pure_data',
      '含函数的声明必须具名拒绝：浅冻结后嵌套对象仍共享，等于交出可写的权威值');
    assertEquals(core.capabilityRegistration('audit.degraded'), null, '被拒的登记不得留下半笔');
    assertEquals(core.getCapabilityOutputSchema('audit.degraded'), null, '被拒的登记不得能查询到声明');

    // 环也必须具名拒绝（不是栈溢出）
    let cyc = null;
    const c = { properties: {} };
    c.self = c;
    try { core.registerCapability('audit.circular', { input_schema: c, handler: () => 1 }); cyc = 'ACCEPTED'; }
    catch (e) { cyc = e.code; }
    assertEquals(cyc, 'declaration_not_pure_data', '环必须具名拒绝');
  } finally { cleanup(); }
});

  runner.test('R0-170/4 普通 JSON 声明：两次读取的嵌套对象不共享引用', async () => {
  const { core, cleanup } = await freshCore('plain');
  try {
    core.registerCapability('audit.plain', {
      output_schema: { properties: { n: { type: 'integer' } } }, handler: () => ({ n: 1 }),
    });
    const v1 = core.getCapabilityOutputSchema('audit.plain');
    v1.properties.n.type = 'string';
    const v2 = core.getCapabilityOutputSchema('audit.plain');
    assertEquals(v2.properties.n.type, 'integer', '公开 getter 不得改写权威输出声明');
    assert(v2.properties !== v1.properties, '两次读取必须是不同对象（否则仍是共享引用）');
  } finally { cleanup(); }
});

  runner.test('R0-170/5 _copyDecl 不得保留「失败就浅复制」的回退', () => {
  // 这一条正是 R19-C 的反例现场：回退分支让“独立副本”在最需要它的地方不成立。
  const m = CORE_SRC.match(/_copyDecl\(v\)\s*\{([\s\S]*?)\n  \}/);
  assert(m, '找不到 _copyDecl 的实现');
  assert(!/\{\s*\.\.\.v\s*\}/.test(m[1]),
    '_copyDecl 不得退化为 `{ ...v }`：浅复制与权威值共享嵌套对象，视图会变成第二个写入面');
  assert(/structuredClone/.test(m[1]), '_copyDecl 必须用 structuredClone 取独立副本');
});

// ── ③ R19-B 行为层 ────────────────────────────────────────────
  runner.test('R0-170/6 resolveFence 不交 token，也不交安装者的活对象', async () => {
  const { core, cleanup } = await freshCore('fence');
  try {
    const mod = await imp('plugins/tool-executor.js');
    let installerStopHits = 0;
    const fence = {
      preCheck: () => ({ ok: false, result: { code: 'strict' } }),
      stop() { installerStopHits++; },
    };
    mod.setFence(fence, { owner: 'guardian', core });
    try {
      const seen = mod.resolveFence(core);
      assert(seen, '解析结果不应为空');
      assertEquals(Object.prototype.hasOwnProperty.call(seen, 'token'), false,
        '解析结果不得含 token：那是撤销凭据，公接口发出去等于没有凭据');
      assert(seen.fence !== fence, '解析结果不得是安装者的原对象（它上面还有别的方法）');
      assertEquals(typeof seen.fence.stop, 'undefined', '安装者的其它方法不得经解析结果可达');
      try { seen.fence.stop?.(); } catch { /* 不可达即预期 */ }
      assertEquals(installerStopHits, 0, '外部不得能调到安装者的方法');
      // 只拿解析结果撤不掉
      assertEquals(mod.removeFence({ token: seen.token }), false, '仅凭解析结果不得撤销围栏');
      assert(mod.resolveFence(core) !== null, '围栏必须仍在');
    } finally {
      // 清场走合法路径（owner-only 不带 disposer 本来就会被拒，这里用无参兜底形态）
      mod.removeFence();
    }
  } finally { cleanup(); }
});

  runner.test('R0-170/7 合法路径未受影响：持 disposer 撤销、执行面仍走 preCheck', async () => {
  const { core, cleanup } = await freshCore('fence2');
  try {
    const mod = await imp('plugins/tool-executor.js');
    let ran = 0;
    const inst = mod.setFence({ preCheck: () => { ran++; return { ok: true }; } }, { owner: 'g2', core });
    assert(mod.resolveFence(core), '安装后必须解析得到');
    const seen = mod.resolveFence(core);
    await seen.fence.preCheck('t', {}, 's', null, null);
    assertEquals(ran, 1, '执行面必须仍能调用 preCheck（只读视图必须真的可用）');
    assertEquals(mod.removeFence({ owner: 'g2', core, disposer: inst.disposer }), true,
      '安装者持 disposer 必须能撤销');
    assertEquals(mod.resolveFence(core), null, '撤销后必须解析为空');
  } finally { cleanup(); }
});

  runner.test('R0-170/8 fenceStatus 不依赖 token 也能答对 scope', async () => {
  const { core, cleanup } = await freshCore('status');
  try {
    const mod = await imp('plugins/tool-executor.js');
    const inst = mod.setFence({ preCheck: () => ({ ok: true }) }, { owner: 'g3', core });
    const st = mod.fenceStatus(core);
    assertEquals(st.installed, true);
    assertEquals(st.owner, 'g3');
    assertEquals(st.scope, 'core', 'core 专属围栏必须报 core（此前靠 token 反查，token 不发后就没了依据）');
    assertEquals(Object.prototype.hasOwnProperty.call(st, 'token'), false, 'fenceStatus 不得回吐 token');
    mod.removeFence({ owner: 'g3', core, disposer: inst.disposer });
  } finally { cleanup(); }
});

// ── ④ R19-D 结构层 ────────────────────────────────────────────
// 这三条读 `verification/`，而 **npm 包不含该目录**（package.json#files 里没有它）。
// 于是发行包形态下它们是 ENOENT 而非判据不成立 —— 那是载体问题，不是缺陷。
// 统一走 carrier 闸：源码检出仍是硬门（读不到就 FAIL），发行包记 NOT_RUN（绝不折算成通过）。
  runner.test('R0-170/10 反例集必须挂在门禁上，且用 probe 证据口径', () => {
  if (!requireRepoOnly(runner, ROOT, '反例集挂载与证据口径')) return;
  const CE = join(ROOT, 'verification', 'counterexamples', 'rc20-declaration-snapshot-4.mjs');
  assert(existsSync(CE), '反例集文件必须存在（不存在时门禁应记 NOT_RUN，不是静默跳过）');
  assert(/rc20-declaration-snapshot-4\.mjs/.test(GATE), '反例集必须出现在发布门禁源码里');
  assert(/rc20-counterexamples/.test(GATE), '门禁里必须有一个具名项，便于逐轮对账');
  // 证据口径：verification/ 不进 npm 包，所以该文件缺失时必须是 NOT_RUN 分支。
  assert(/notRun\('rc20-counterexamples'/.test(GATE),
    '反例集缺失时必须记 NOT_RUN 并写明缺什么，不得无声跳过，也不得记 PASS');
});

  runner.test('R0-170/11 反例集自身仍要求「反例与正例都成立」才算 FIXED', () => {
  if (!requireRepoOnly(runner, ROOT, '反例集自身的正例断言')) return;
  const src = readFileSync(join(ROOT, 'verification', 'counterexamples', 'rc20-declaration-snapshot-4.mjs'), 'utf8');
  // 专家明确要求不得用“禁掉 schema / 全拒绝”冒充修复：每条都必须带正例断言。
  // 取每个 `fixed:` 到该行表达式结束（可能跨行，以 `&&`/`||` 续行）。
  const fixedLines = [...src.matchAll(/^\s*fixed:\s*([\s\S]*?)(?=,\n|\n\s{4}\w+:)/gm)]
    .map((m) => m[1].trim())
    .filter((e) => e !== 'false');   // 早退分支的 `fixed: false` 不是判据
  assert(fixedLines.length >= 4, `应当有 4 条 fixed 判据，实际 ${fixedLines.length}：${JSON.stringify(fixedLines)}`);
  for (const [i, expr] of fixedLines.entries()) {
    assert(expr.includes('&&'),
      `第 ${i + 1} 条 fixed 只有一个条件（${expr.slice(0, 60)}）—— 反例与正例必须同时成立，`
      + '单条件会退化成“不报错就算好”');
  }
});

  runner.test('R0-170/12 历史文档不把本轮判据写成“已验收”', () => {
  const CLA = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
  const pkgVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const head = CLA.split('\n## ')[1] || '';
  // 版本号从 package.json 取，而不是写死：写死的那个每到发版就得改，忘了就是假红。
  assert(head.includes(`v${pkgVersion}`), `CHANGELOG 第一节必须是本版（v${pkgVersion}），实际：${head.slice(0, 60)}`);
  // 本轮只做了工单，没有拿到外部验收 —— 文档不得自我宣称"已通过验收"。
  assert(!/已通过验收|验收通过/.test(head), 'CHANGELOG 不得把“本轮修完”写成“已通过验收”');
  assert(/NO-GO|Developer Preview/.test(head), '必须写明当前发布裁决状态（rc.19 的 NO-GO 是既有事实）');
});



}
