// AR-C01 / AR-C02（v0.10.3）：两条**已发布的动作反馈真实性错误**的回归锁。
//
// 这两条不是我从计划里读出来的，是专家 v3.0 独立实测指出的，我复现后确认成立：
//
//   AR-C01 并发回执串台 —— `tool-write` 把回执挂在**实例字段** `_lastReceipt` 上，
//     执行器在 `_finishExecuteSuccess` 里再把这个实例的"最近一次回执"取出来。
//     两个会话并发时，A 的返回值里可能装着 B 的回执。**两个会话都可以是真的、各自成功**，
//     但反馈错了对象 —— 模型据此判断"我改对了没"，会得出错误结论。
//
//   AR-C02 缺失可信身份即放行 —— `inspectAction` 的判据是
//     `if (rec.sessionId && sessionId && rec.sessionId !== sessionId) return not_yours`。
//     三个条件用 `&&` 串起来，于是 `sessionId === undefined` 时整条判据**短路为假**，
//     放行。这是 fail-open：判据存在，但它的否定形态（"我不知道你是谁"）没被覆盖。
//
// 本文件先红后绿：下面的用例在修复前**必须**失败，修复后必须通过。
// 我把"修复前长什么样"记在每条用例里，因为这条项目反复印证的教训是——
// 一个从来没红过的判据，等于没被验证过。
//
// 另外顺手覆盖两条同批发现、专家未点名的同形缺陷（AR-C03/C04）：
//   · 模型可以在 args 里自报 `_principal` / `_sessionId` / `_cellId` 等**控制字段**，
//     而执行器把它们当授权输入与归因输入用 —— 自报 `_principal='admin'` 就能调到
//     一个 `require_identity + scope:'admin'` 的能力（实测 succeeded）。
//   · 回执里的 `cell_id` / `task_id` / `incarnation_id` 直接取自 `args`，模型可以随便写，
//     于是回执的**归因字段本身**不可信。
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TestRunner, assert, assertEquals } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(join(ROOT, rel));

/**
 * 造一个真 tool-executor 实例。
 *
 * 走真 `init()` 是刻意的：`action.inspect` 是在 `init` 里注册成能力的
 * （`core.registerCapability('action.inspect', ...)`）。不 init 的话，AR-C02/3 那条
 * "模型伪造 args 调能力"的用例会以 `capability_not_found` 失败 ——
 * 那是**测试脚手架没搭好**，不是被测缺陷。这类"因为前提没满足而红"的红最容易被误读成
 * "缺陷已复现"，所以这里把 executor 完整装起来，并且用完 `stop()` 清掉定时器
 * （否则 TestRunner 会因为活着的 interval 挂住不退出）。
 */
async function makeExec(core) {
  const e = Object.create(globalThis.__T);
  e._preHooks = []; e._postHooks = []; e._dispatchHooks = [];
  e._rateCalls = new Map(); e._cache = new Map(); e._auditLog = new Map();
  e._receipts = new Map(); e._receiptMax = 100;
  e._metrics = new Map(); e._preferences = new Map(); e._debugStream = null;
  // 真 init 会从 core 配置里读这两个；用裸对象时得先给默认值，否则
  // `_timeout` 是 undefined ⇒ `setTimeout(..., undefined)` = 0ms ⇒ 每次调用都超时。
  // 这个坑我先踩了一次（首轮 12 条全红，红的原因是超时，不是缺陷），记在这里。
  e._maxParallel = 5;
  e._timeout = 30000;
  e.core = core;
  await e.init(core);
  return e;
}

async function makeHost({ registryDelayMs = 0, workspaceRoot = null } = {}) {
  globalThis.__T = (await imp('plugins/tool-executor.js')).default;
  const d = mkdtempSync(join(tmpdir(), 'arc-'));
  const { Core } = await imp('src/core/core.js');
  const core = new Core({ stateDir: join(d, 'state') });
  core.log = () => {};
  core.setData('agent.workDir', d);
  const exec = await makeExec(core);
  const W = (await imp('plugins/tools/tool-write.js')).default;
  const tool = Object.create(W);
  tool.core = core;
  core.registerCapability('tool.write', { owner: 'tool-write', handler: (a) => tool.execute(a) });
  // registry.get 在这里被放慢，是为了**真实地**暴露并发窗口。
  // 真 plugin-manager 的 get 也是 async 的（懒加载时还会 await import），
  // 所以这不是"为了造 bug 而造的延迟"，而是把本来就存在的那段异步搬到了台面上。
  core.registerService('tool-registry', {
    get: async (n) => {
      if (registryDelayMs) await new Promise((r) => setTimeout(r, registryDelayMs));
      return n === 'tool-write' ? tool : null;
    },
    has: (n) => n === 'tool-write',
    listTools: () => [],
  });
  if (workspaceRoot) core.registerService('workspace', { root: workspaceRoot });
  // 每个用例结束时必须停掉 executor 的定时器，否则进程不会自然退出。
  // 包成 stop() 由 finally 调，而不是依赖 GC —— 活着的 interval 不会被 GC 收走。
  const stop = async () => { try { await exec.stop(); } catch { /* 停不掉不影响断言结论 */ } };
  return { d, core, exec, tool, stop };
}

function idsOf(result) {
  // 回执附注里出现的 action id（可能 0 或 1 个）
  return [...String(result ?? '').matchAll(/act-[A-Za-z0-9-]+/g)].map((m) => m[0]);
}

export async function setup(runner) {
  // ══ AR-C01：每一次执行必须有**只属于本次调用**的回执 ═══════════════════════
  //
  // 判据不写成"两个 id 必须不同"——那样在同一毫秒内生成也可能偶然……不，id 带自增序号，
  // 一定不同。所以判据是更本质的那句：**A 拿到的回执必须描述 A 写的那件事**。
  // 修复前的实测输出（我亲手跑到的）：
  //   A result: [回执 act-mvjmp6kx-2] 新建 b.txt；差异 3 字节…
  //   B result: [回执 act-mvjmp6kx-2] 新建 b.txt；差异 3 字节…
  //   串台? true
  runner.test('AR-C01/1 并发两会话：A 的回执必须指向 a.txt，B 的必须指向 b.txt', async () => {
    const h = await makeHost({ registryDelayMs: 40 });
    try {
      const pA = h.exec.executeOne('tool-write', { path: 'a.txt', content: 'AAA' }, 'sess-A', 'c1');
      await new Promise((r) => setTimeout(r, 5));
      const pB = h.exec.executeOne('tool-write', { path: 'b.txt', content: 'BBB' }, 'sess-B', 'c1');
      const [rA, rB] = await Promise.all([pA, pB]);

      assertEquals(rA.state, 'succeeded', `前提：A 写入应成功，实际 ${rA.state} ${rA.error}`);
      assertEquals(rB.state, 'succeeded', `前提：B 写入应成功，实际 ${rB.state} ${rB.error}`);

      const textA = String(rA.result);
      const textB = String(rB.result);
      assert(/a\.txt/.test(textA.split('\n')[1] || ''),
        `A 的回执附注必须描述 a.txt —— 修复前这里是 "新建 b.txt"，实际附注 "${textA.split('\n')[1] || ''}"`);
      assert(/b\.txt/.test(textB.split('\n')[1] || ''),
        `B 的回执附注必须描述 b.txt，实际附注 "${textB.split('\n')[1] || ''}"`);

      const [idA] = idsOf(textA);
      const [idB] = idsOf(textB);
      assert(idA && idB, `两次调用都必须产出 action id，实际 A=${idA} B=${idB}`);
      assert(idA !== idB, `两个并发调用的回执 id 必须不同 —— 相同时两处反馈指向同一件事，实际都是 ${idA}`);
      console.log(`       [实测] A→${idA}(a.txt) / B→${idB}(b.txt)，无串台`);
    } finally { await h.stop(); rmSync(h.d, { recursive: true, force: true }); }
  });

  runner.test('AR-C01/2 回执留档的归属必须与产生它的会话一致（不能是"最后完成的那个"）', async () => {
    const h = await makeHost({ registryDelayMs: 40 });
    try {
      const pA = h.exec.executeOne('tool-write', { path: 'a.txt', content: 'AAA' }, 'sess-A', 'c1');
      await new Promise((r) => setTimeout(r, 5));
      const pB = h.exec.executeOne('tool-write', { path: 'b.txt', content: 'BBB' }, 'sess-B', 'c1');
      const [rA] = await Promise.all([pA, pB]);
      const [idA] = idsOf(String(rA.result));

      const recA = h.exec._receipts.get(idA);
      assert(recA, `A 的回执 ${idA} 必须被留档，否则 action.inspect 拿不到它`);
      assertEquals(recA.sessionId, 'sess-A',
        `A 的回执必须记在 sess-A 名下 —— 修复前它被记到了最后完成的那次（sess-B），实际 ${recA.sessionId}`);
      assertEquals(recA.receipt.target.path, 'a.txt',
        `留档的回执内容必须是 a.txt 那次，实际 ${recA.receipt.target.path}`);
      console.log(`       [实测] ${idA} 归属 sess-A、target=a.txt`);
    } finally { await h.stop(); rmSync(h.d, { recursive: true, force: true }); }
  });

  runner.test('AR-C01/3 不同 Cell 并发写同一插件：回执的 cell 归因不得互换', async () => {
    const h = await makeHost({ registryDelayMs: 30 });
    try {
      const pA = h.exec.executeOne('tool-write',
        { path: 'x.txt', content: 'X', _cellId: 'cell-A' }, 'cell-A', 'c1');
      await new Promise((r) => setTimeout(r, 5));
      const pB = h.exec.executeOne('tool-write',
        { path: 'y.txt', content: 'Y', _cellId: 'cell-B' }, 'cell-B', 'c1');
      const [rA, rB] = await Promise.all([pA, pB]);
      const [idA] = idsOf(String(rA.result));
      const [idB] = idsOf(String(rB.result));
      // 回执内容必须与"谁产生的"一致：cell-A 的回执不能说自己是 cell-B
      const recA = h.exec._receipts.get(idA);
      const recB = h.exec._receipts.get(idB);
      assertEquals(recA.sessionId, 'cell-A', 'A 的留档必须归 cell-A');
      assertEquals(recB.sessionId, 'cell-B', 'B 的留档必须归 cell-B');
      assert(recA.receipt.target.path !== recB.receipt.target.path,
        `两个不同 Cell 的回执必须描述不同的目标，实际都是 ${recA.receipt.target.path}`);
      console.log(`       [实测] cell-A→x.txt(${idA}) / cell-B→y.txt(${idB})`);
    } finally { await h.stop(); rmSync(h.d, { recursive: true, force: true }); }
  });

  runner.test('AR-C01/4 失败的调用不得留下可被下一次调用误取的回执', async () => {
    const h = await makeHost();
    try {
      // 先成功一次，让"最近一次回执"槽里有东西
      const ok = await h.exec.executeOne('tool-write', { path: 'ok.txt', content: 'K' }, 's1', 'c1');
      assertEquals(ok.state, 'succeeded', '前提：第一次应成功');
      // 再失败一次（越界）
      const bad = await h.exec.executeOne('tool-write', { path: '../escape.txt', content: 'X' }, 's2', 'c1');
      assert(bad.state !== 'succeeded', '前提：越界写必须失败');
      // 失败的那次不得产出回执附注；否则模型会看到"某个成功的回执"，而它这次什么都没写成
      const badIds = idsOf(String(bad.result ?? bad.error ?? ''));
      assertEquals(badIds.length, 0,
        `失败调用不得带回执附注 —— 否则模型会把它当成"这次写成功了"，实际带回了 ${badIds.join(',')}`);
      console.log('       [实测] 失败调用无回执附注，未复用上一次的成功回执');
    } finally { await h.stop(); rmSync(h.d, { recursive: true, force: true }); }
  });

  runner.test('AR-C01/5 回执必须按调用绑定，而不是"读工具实例的最近一次"', async () => {
    // 结构判据，理由写清：行为判据（上面 1～3）在"两次调用恰好不重叠"时会全绿，
    // 而"共享字段"这个成因依然在。这一条直接盯成因。
    const src = readFileSync(join(ROOT, 'plugins/tool-executor.js'), 'utf8');
    const strip = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert(!/_receiptNote\s*\(/.test(strip) || !/_lastReceipt/.test(strip),
      '执行器不得再读工具实例上的 `_lastReceipt`（共享槽=并发下必然串台）');
    const wsrc = readFileSync(join(ROOT, 'plugins/tools/tool-write.js'), 'utf8');
    const wstrip = wsrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert(!/this\._lastReceipt\s*=/.test(wstrip),
      '工具不得把回执写进实例字段（`this._lastReceipt =`）——那是"最近一次"的语义，不是"本次"');
    assert(/receipt/.test(wstrip), '工具仍必须产出回执（删掉能力不是修法）');
    console.log('       [实测] 执行器与工具两侧都不再有 _lastReceipt 共享槽');
  });

  // ══ AR-C02：缺失可信作用域一律拒绝 ═════════════════════════════════════
  //
  // 修复前实测：
  //   undefined sessionId -> {"ok":true, ...}                    ← fail-open
  //   wrong sessionId     -> {"ok":false,"code":"receipt_not_yours"}  ← 只有这一种被挡住
  runner.test('AR-C02/1 无调用方作用域时必须拒绝（receipt_scope_missing），不得放行', async () => {
    const h = await makeHost();
    try {
      const r = await h.exec.executeOne('tool-write', { path: 'a.txt', content: 'A' }, 'sess-A', 'c1');
      const [id] = idsOf(String(r.result));
      assert(id, '前提：需要一条真回执');

      for (const [label, sid] of [
        ['undefined', undefined],
        ['null', null],
        ['空串', ''],
      ]) {
        const got = await h.exec.inspectAction(id, sid, 5000);
        assertEquals(got.ok, false,
          `调用方作用域为 ${label} 时必须拒绝 —— 修复前这里 ok:true 并返回了完整回执（fail-open）`);
        assertEquals(got.code, 'receipt_scope_missing',
          `必须具名 receipt_scope_missing（区别于"不是你的"），实际 ${got.code}`);
        assert(!got.receipt, '拒绝时不得返回回执内容');
      }
      console.log('       [实测] undefined / null / 空串三种缺失作用域全部 receipt_scope_missing');
    } finally { await h.stop(); rmSync(h.d, { recursive: true, force: true }); }
  });

  runner.test('AR-C02/2 跨会话仍必须拒绝（receipt_not_yours），且与缺失作用域可区分', async () => {
    const h = await makeHost();
    try {
      const r = await h.exec.executeOne('tool-write', { path: 's.txt', content: 'S' }, 'session-A', 'c1');
      const [id] = idsOf(String(r.result));

      const own = await h.exec.inspectAction(id, 'session-A', 5000);
      assertEquals(own.ok, true, '自己的会话必须能读');

      const other = await h.exec.inspectAction(id, 'session-B', 5000);
      assertEquals(other.ok, false, '别的会话不得读');
      assertEquals(other.code, 'receipt_not_yours', `必须区别于缺失作用域，实际 ${other.code}`);
      console.log('       [实测] 本会话可读；跨会话 receipt_not_yours；两者与 receipt_scope_missing 三分');
    } finally { await h.stop(); rmSync(h.d, { recursive: true, force: true }); }
  });

  runner.test('AR-C02/3 模型不得通过 args 伪造 `_sessionId` 绕过作用域判定', async () => {
    // 这是 AR-C02 的真实攻击面：`inspectAction` 的 sessionId 来自
    // `handler: (args) => this.inspectAction(args?.action_id, args?._sessionId, ...)`，
    // 而 `_sessionId` 是**模型可控的入参**。修复前，模型只要把别人的 sessionId 抄进 args
    // 就能读到别人的回执。执行器注入的会话身份必须优先于、并覆盖模型自报值。
    const h = await makeHost();
    try {
      const r = await h.exec.executeOne('tool-write', { path: 'p.txt', content: 'P' }, 'session-A', 'c1');
      const [id] = idsOf(String(r.result));

      // 直接调能力（模拟模型构造的参数），不带宿主会话上下文
      const forged = await h.core.callCapability('action.inspect', { action_id: id, _sessionId: 'session-A' }, {});
      // 无宿主身份时，无论模型抄了什么 sessionId，都必须被拒
      const payload = forged.payload ?? forged;
      assertEquals(payload?.ok, false,
        `模型自报 _sessionId 不得成为作用域凭据 —— 实测它能读到别人的回执（fail-open）`);
      assert(payload?.code === 'receipt_scope_missing' || /scope/i.test(String(payload?.code)),
        `应为作用域缺失类拒绝，实际 ${payload?.code}`);
      console.log(`       [实测] 模型自报 _sessionId='session-A' 仍被拒（${payload.code}）`);
    } finally { await h.stop(); rmSync(h.d, { recursive: true, force: true }); }
  });

  runner.test('AR-C02/4 作用域判定不得写成三个条件的 && 短路', async () => {
    // 结构判据盯成因：`rec.sessionId && sessionId && 不等` 这个形状，
    // 在 sessionId 为假值时整条短路为假 → 放行。这是"判据存在但否定形态未覆盖"。
    const src = readFileSync(join(ROOT, 'plugins/tool-executor.js'), 'utf8');
    const strip = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert(!/rec\.sessionId\s*&&\s*sessionId\s*&&/.test(strip),
      '不得再用 `rec.sessionId && sessionId &&` 的 && 短路形式做作用域判据');
    assert(/receipt_scope_missing/.test(strip),
      '必须存在 receipt_scope_missing 这个具名拒绝码（缺失作用域不能复用 receipt_not_yours）');
    console.log('       [实测] 无边短路判据；receipt_scope_missing 已具名');
  });

  // ══ AR-C03：模型自报的控制字段不得成为授权输入 ═══════════════════════════
  //
  // 修复前实测（真 Core + 真 executor + identityAuthority 已登记 admin）：
  //   无自报字段                       -> rejected  capability_denied（身份未经证实）
  //   自报 _principal=admin            -> **succeeded** VAULT-SECRET
  // 也就是说 `require_identity + scope:'admin'` 的能力，被一个连会话都没有的调用拿到了。
  runner.test('AR-C03/1 模型自报 `_principal` 不得提升身份（能力路径）', async () => {
    const { Core } = await imp('src/core/core.js');
    const d = mkdtempSync(join(tmpdir(), 'arc3-'));
    try {
      const core = new Core({ stateDir: join(d, 'state'), identityAuthority: 'tok' });
      core.log = () => {};
      core.setData('agent.workDir', d);
      core.assertIdentity('admin', { caller: 'admin', scope: 'admin', issuer: 'tok' });
      core.registerCapability('tool.secret', {
        owner: 'tool-secret',
        permissions: { require_identity: true, scope: 'admin' },
        handler: async () => 'VAULT-SECRET',
      });
      const exec = await makeExec(core);
      for (const args of [{}, { _principal: 'admin' }, { _principal: 'admin', _scope: 'admin' }, { _principal: 'admin', _caller: 'admin' }]) {
        const r = await exec.executeOne('tool-secret', { ...args }, 'sess-A', 'c1');
        assertEquals(r.state, 'rejected',
          `模型自报 ${JSON.stringify(args)} 必须被拒（身份只能由受信宿主断言），实际 ${r.state} ${String(r.result).slice(0, 40)}`);
      }
      console.log('       [实测] 四种自报组合全部 rejected，无法自证 admin');
      await exec.stop();
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('AR-C03/2 模型自报 `_sessionId` 不得改写到别的工作区', async () => {
    const d = mkdtempSync(join(tmpdir(), 'arc3b-'));
    const wsA = join(d, 'wsA'); const wsB = join(d, 'wsB');
    mkdirSync(wsA, { recursive: true }); mkdirSync(wsB, { recursive: true });
    try {
      const h = await makeHost({
        workspaceRoot: (sid) => (sid === 'sess-B' ? wsB : wsA),
      });
      // 覆盖 stateDir/临时目录，改用本用例的目录
      h.core.setData('agent.workDir', wsA);

      await h.exec.executeOne('tool-write',
        { path: 'esc.txt', content: 'X', _sessionId: 'sess-B' }, 'sess-A', 'c1');
      assertEquals(existsSync(join(wsB, 'esc.txt')), false,
        '模型自报 _sessionId=sess-B 不得让写入落到会话 B 的工作区');
      assertEquals(existsSync(join(wsA, 'esc.txt')), true,
        '写入必须落在**真实**会话（sess-A）的工作区');

      // 反向：完全没有宿主会话时，模型自报的会话也不能生效
      await h.exec.executeOne('tool-write',
        { path: 'esc2.txt', content: 'Y', _sessionId: 'sess-B' }, null, 'c1');
      assertEquals(existsSync(join(wsB, 'esc2.txt')), false,
        '无宿主会话时，模型自报的 _sessionId 同样不得生效');
      console.log('       [实测] 自报 _sessionId 被宿主值覆盖/剥离，写入只落真实会话根');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('AR-C03/3 回执的 cell/task/incarnation 归因不得由模型自报', async () => {
    const h = await makeHost();
    try {
      const r = await h.exec.executeOne('tool-write',
        { path: 'q.txt', content: 'Q', _cellId: 'cell-FORGED', _taskId: 'task-FORGED', _incarnationId: 'inc-FORGED' },
        'sess-A', 'c1');
      const [id] = idsOf(String(r.result));
      const got = await h.exec.inspectAction(id, 'sess-A', 5000);
      assertEquals(got.ok, true, '前提：应能展开');
      const rc = got.receipt;
      assert(rc.cell_id !== 'cell-FORGED',
        `回执的 cell_id 不得等于模型自报值 —— 归因字段若可由被测对象填写，它就不是证据（实际 ${rc.cell_id}）`);
      assert(rc.task_id !== 'task-FORGED',
        `回执的 task_id 不得等于模型自报值（实际 ${rc.task_id}）`);
      assert(rc.incarnation_id !== 'inc-FORGED',
        `回执的 incarnation_id 不得等于模型自报值（实际 ${rc.incarnation_id}）`);
      // 但不许为了拒绝伪造而编造：没有可信来源时必须如实为 null
      assertEquals(rc.cell_id, null, '无可信 Cell 上下文时必须如实填 null，不得编造');
      console.log(`       [实测] 伪造归因被剥离：cell=${rc.cell_id} task=${rc.task_id} inc=${rc.incarnation_id}`);
    } finally { await h.stop(); rmSync(h.d, { recursive: true, force: true }); }
  });

  runner.test('AR-C03/4 剥离控制字段后，工具的业务参数必须完好（不得误删普通参数）', async () => {
    // 反向保护：如果修法是把所有下划线开头的字段一律删掉，会顺手废掉
    // `_tcId` / `_traceId` 之外的合法传输字段，也会误伤用户业务数据。
    // 这里验的是"该留的留下"。
    const h = await makeHost();
    try {
      const seen = [];
      h.core.registerCapability('tool.echo', {
        owner: 'tool-echo',
        handler: async (a) => { seen.push(a); return 'OK'; },
      });
      await h.exec.executeOne('tool-echo',
        { keep_me: 1, _normal: 'underscore-but-harmless', note: 'x' }, 'sess-A', 'c1');
      const got = seen[0] || {};
      assertEquals(got.keep_me, 1, '普通业务参数必须保留');
      assertEquals(got.note, 'x', '普通业务参数必须保留');
      assertEquals(got._sessionId, 'sess-A', '宿主注入的会话标识必须存在（由宿主写，不是模型写）');
      console.log('       [实测] 业务参数完好，宿主会话标识存在');
    } finally { await h.stop(); rmSync(h.d, { recursive: true, force: true }); }
  });

  // ══ AR-C04：工具输出承诺的那个入口，模型**够不着** ══════════════════════════
  //
  // 这条是我在做完 AR-C01/C02 之后，想把"模型真的能读回回执"验一遍时撞出来的。
  // 不是专家点名的，也不在 v3.0 计划里，但它让 AR-C02 的修复**没有实际意义**：
  // 作用域判据再正确，只要模型根本调不到这个能力，那三条拒绝路径就永远不会被走到。
  //
  // 实测（真 Core + 真 PluginManager + 真 tool-write）：
  //   · `action.inspect` **是**已注册能力（`core.listCapabilities()` 里有）；
  //   · 但它**不在**模型可见工具表里（`registry.list()` 只有 10 个 `tool-*`），
  //     模型根本不知道该调它 —— 除非它从回执附注里猜；
  //   · 就算猜了，`executeOne('action.inspect', ...)` 也走不通：
  //     `_capabilityIdFor('action.inspect')` 返回 null（只认 `tool-` 前缀），
  //     `_capabilityIdsForTool` 也返回 []（能力 owner 是 `tool-executor`，
  //     而请求名是 `action.inspect`，反查不到），于是判成"无能力"→ 走 legacy 直连
  //     → 被 R0-81 的"需受信 principal"拒绝。
  //   净效果：回执附注写着"（明细：action.inspect act-xxx）"，而这句话**兑现不了**。
  //
  // v0.10.3 时这一条是"断言当前确实够不着"的落锁记录，并写明"等 v0.11.0 修好时它会红"。
  // **v0.11.0 它确实红了**（AR-C04 修好）—— 现在按当时的约定改成正向断言：
  // 回执附注承诺的那个入口必须真的能用，而宿主无身份直调仍然必须被作用域门拒绝。
  // 这两件事互不替代：可达性修好了，不等于作用域门可以松。
  runner.test('AR-C04 回执附注承诺的 action.inspect 已可达（v0.11.0 收口）', async () => {
    const h = await makeHost();
    try {
      const r = await h.exec.executeOne('tool-write', { path: 'z.txt', content: 'Z' }, 'sess-A', 'c1');
      const text = String(r.result);
      assert(/action\.inspect/.test(text),
        '前提：回执附注里必须给出 action.inspect 提示（这是被承诺的入口）');
      const [id] = idsOf(text);
      assert(id, '前提：附注里必须有 action id');

      // ① 能力确实注册了
      const isCap = h.core.listCapabilities().some((c) => c.id === 'action.inspect');
      assertEquals(isCap, true, 'action.inspect 必须仍是已注册能力（否则这条记录的是另一个问题）');

      // ② 模型按提示去调，必须够得着（v0.11.0 修好；v0.10.x 这里是 rejected）
      const viaTool = await h.exec.executeOne('action.inspect', { action_id: id }, 'sess-A', 'c1');
      assertEquals(viaTool.state, 'succeeded',
        `回执附注承诺的入口必须真的能用 —— v0.10.x 这里是 capability_denied（能力已注册但解析不出 capId，`
        + `掉进 legacy 直连被 R0-81 拒），实际 state=${viaTool.state} code=${viaTool.code}`);
      assertEquals(JSON.parse(String(viaTool.result)).ok, true, '按提示取回执必须成功');

      // ③ 而宿主/测试直接走能力入口是**能**取到的（证明回执本身没问题，缺的只是可达性）
      const direct = await h.core.callCapability('action.inspect', { action_id: id }, { source: 'host' });
      const payload = direct.payload ?? direct;
      // 这里没有可信调用上下文 ⇒ 按 AR-C02 的新判据必须是 scope_missing。
      // 也就是说：即使把可达性接好，宿主也必须是"有身份地"读 —— 两道门互不替代。
      assertEquals(payload?.ok, false,
        '无可信调用上下文的宿主直调也必须被拒（AR-C02 的作用域门不因入口变化而放宽）');
      assertEquals(payload?.code, 'receipt_scope_missing',
        `应为 receipt_scope_missing，实际 ${payload?.code}`);
      console.log('       [实测] 回执承诺的入口已可达；宿主无身份直调仍被 receipt_scope_missing 拒绝');
    } finally { await h.stop(); rmSync(h.d, { recursive: true, force: true }); }
  });
}

// 允许直接 `node test/unit/test-ar-c01-c02-receipt-binding-and-scope.test.mjs`
if (import.meta.url === `file://${process.argv[1]}`) {
  const runner = new TestRunner({ name: 'AR-C01/C02/C03' });
  await setup(runner);
  const ok = await runner.run();
  process.exit(ok ? 0 : 1);
}
