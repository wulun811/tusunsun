// AR-C04（v0.11.0）：`action.inspect` 是一个**已注册、已声明、却永远调不动**的能力。
//
// 这一条的性质与 AR-C01/C02/C03/C05 不同：它**不是越权**，是**承诺兑不了**。
// 每个工具输出末尾都带一句 `（明细：action.inspect act-xxx）`（见 `_receiptNote`），
// 模型照着调，拿到的永远是 `capability_denied`。
//
// 成因（一句话）：执行器把"请求名 → 能力 id"写成三条来源，**三条都要求先有一个工具对象**：
//   ① 命名约定 `tool-<x>` → `tool.<x>`
//   ② 工具自报的 `provides[]`
//   ③ 按 `owner` 反查
// 而 `action.inspect` 是执行器**自己**注册的：没有工具对象、名字不以 `tool-` 开头、
// owner 是 `tool-executor` 而不是 `action.inspect`。于是三条全落空 ⇒ `capId = null`
// ⇒ 掉进 legacy 直连 ⇒ 被 R0-81（"能力存在时拒绝 legacy 直连"）拒绝。
//
// 修前的实测（真 Core + 真 tool-executor，走 `executeOne`）：
//     executeOne('action.inspect', {action_id}) → capability_denied
//       "Tool "action.inspect" 走 legacy 直连需经受信 principal（未提供或未登记）"
//     core.callCapability('action.inspect', …)  → 能到 handler，但 currentSession() 为 null
//       ⇒ receipt_scope_missing
// 也就是说：唯一能到 handler 的入口拿不到会话，能拿到会话的入口到不了 handler。
//
// 修法两处（都在 plugins/，核心 0 行）：
//   · `_lib/tool-policy.js` 新增 `MODEL_INVOCABLE_CAPABILITIES` 白名单 + `isCacheableCapability`；
//     并把 `action.inspect` 登记进只读能力集合（它读的是内存留档 + 一次 stat，不写盘）。
//   · `tool-executor.js` 的 `_resolveCapability` 认白名单里的能力名；
//     `_checkModeReadOnly` 认只读能力 id；结果缓存的判据从"只读"收窄为"只读且可缓存"。
//
// 为什么必须**白名单**而不是"任何已注册能力都可点名"：
// 后者会把执行器的能力表整体变成模型可调面（`cell.spawn`、`tool.compose` …）。
// 与只读清单同一个原则：不认识的，就不给。AR-C04/7 就是这条的反例断言。
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assert, assertEquals } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(join(ROOT, rel));

/**
 * 造一个真 Core + 真 tool-executor + 真 tool-write。
 *
 * 必须走真 `init()`：`action.inspect` 的能力注册、`_maxParallel`/`_timeout` 的默认值
 * 都在里面（`setTimeout(..., undefined)` = 0ms ⇒ 每次调用都超时的坑，AR-C05 文件里记过）。
 */
async function makeHost({ readOnly = false, extraCapabilities = [] } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'arc04-'));
  const { Core } = await imp('src/core/core.js');
  const core = new Core({ stateDir: join(d, 'state') });
  core.log = () => {};
  core.setData('agent.workDir', d);
  if (readOnly) {
    // 只用公开读取面替换，避免造一个假 core 把别的判据也一起改掉
    const orig = core.get.bind(core);
    core.get = (k) => (k === 'tools.permissionMode' ? 'read-only' : orig(k));
  }
  const T = (await imp('plugins/tool-executor.js')).default;
  const e = Object.create(T);
  e._preHooks = []; e._postHooks = []; e._dispatchHooks = [];
  e._rateCalls = new Map(); e._cache = new Map(); e._auditLog = new Map();
  e._receipts = new Map(); e._receiptMax = 100;
  e._metrics = new Map(); e._preferences = new Map(); e._debugStream = null;
  e._maxParallel = 5; e._timeout = 30000;
  e.core = core;
  await e.init(core);

  const W = (await imp('plugins/tools/tool-write.js')).default;
  const write = Object.create(W);
  write.core = core;
  await write.init(core);
  core.registerService('tool-registry', {
    get: async (n) => (n === 'tool-write' ? write : null),
    has: (n) => n === 'tool-write',
    listTools: () => [],
  });
  // 造几个"已注册但不在白名单"的能力，用于反例
  for (const id of extraCapabilities) {
    core.registerCapability(id, { owner: 'some-other-plugin', handler: () => ({ ok: true, leaked: 'SHOULD-NOT-REACH' }) });
  }

  const stop = async () => { try { await e.stop(); } catch { /* 停不掉不影响断言结论 */ } };
  return { d, core, exec: e, write, stop };
}

/** 写一次文件并从工具输出里抠出回执 id（模型看到的就是这个字符串）。 */
async function writeOnce(h, sessionId = 'sess-A') {
  writeFileSync(join(h.d, 'a.txt'), 'v1\n');
  const res = await h.exec.executeBatch(
    [{ id: 'call_w', name: 'tool-write', arguments: JSON.stringify({ path: 'a.txt', content: 'v2\n' }) }],
    { sessionId, chainId: 'c1' },
  );
  const text = String(res[0].result ?? '');
  const m = text.match(/action\.inspect (act-[\w.-]+)/);
  return { res: res[0], text, actionId: m ? m[1] : null };
}

export async function setup(runner) {
  // ══ AR-C04/1：模型经**真实入口**（executeBatch）能调到它 ══════════════════════
  //
  // 用 `executeBatch` 而不是 `executeOne`：v0.10.3 里我因为"探针没走真实入口"
  // 得出过一个假结论（`_traceId` 伪造），此后每条可达性判据都钉在真实链路上。
  runner.test('AR-C04/1 模型经 executeBatch 调 action.inspect 能拿到回执', async () => {
    const h = await makeHost();
    try {
      const { text, actionId } = await writeOnce(h);
      assert(actionId != null, `工具输出里应带 action.inspect 提示，实际输出尾部：${text.slice(-160)}`);

      const res = await h.exec.executeBatch(
        [{ id: 'call_i', name: 'action.inspect', arguments: JSON.stringify({ action_id: actionId }) }],
        { sessionId: 'sess-A', chainId: 'c2' },
      );
      const r = res[0];
      assertEquals(r.state, 'succeeded',
        '模型点名 action.inspect 必须成功 —— 修前这里是 capability_denied'
        + '（能力存在但解析不出 capId，掉进 legacy 直连被 R0-81 拒）'
        + `，实际 state=${r.state} code=${r.code}`);
      const payload = JSON.parse(String(r.result));
      assertEquals(payload.ok, true, `回执应可读，实际 ${JSON.stringify(payload).slice(0, 200)}`);
      assertEquals(payload.receipt?.action_id, actionId, '拿到的必须是这次写入的回执');
      assert(payload.receipt?.effect != null, '回执必须带 effect（before/after hash）');
      console.log(`       [实测] action.inspect 返回 action_id=${payload.receipt.action_id}，truncated=${payload.truncated}`);
    } finally { await h.stop(); rmSync(h.d, { recursive: true, force: true }); }
  });

  // ══ AR-C04/2：作用域判据不得因为"变得可达"而松动（AR-C02 不退化）════════════
  runner.test('AR-C04/2 别人的会话读不到这条回执（AR-C02 不退化）', async () => {
    const h = await makeHost();
    try {
      const { actionId } = await writeOnce(h, 'sess-A');
      const res = await h.exec.executeBatch(
        [{ id: 'call_x', name: 'action.inspect', arguments: JSON.stringify({ action_id: actionId }) }],
        { sessionId: 'sess-B', chainId: 'c2' },
      );
      const payload = JSON.parse(String(res[0].result));
      assertEquals(payload.ok, false, '跨会话必须拒绝');
      assertEquals(payload.code, 'receipt_not_yours', `应 receipt_not_yours，实际 ${payload.code}`);
      assert(String(payload.error).includes('another session'), '拒绝理由应说明归属，而不是笼统失败');
      console.log(`       [实测] 跨会话 code=${payload.code}`);
    } finally { await h.stop(); rmSync(h.d, { recursive: true, force: true }); }
  });

  // ══ AR-C04/3：不存在 / 已淘汰的回执要给具名码，不能笼统失败 ═══════════════════
  runner.test('AR-C04/3 不存在的回执给 receipt_not_found', async () => {
    const h = await makeHost();
    try {
      const res = await h.exec.executeBatch(
        [{ id: 'call_n', name: 'action.inspect', arguments: JSON.stringify({ action_id: 'act-does-not-exist' }) }],
        { sessionId: 'sess-A', chainId: 'c1' },
      );
      const payload = JSON.parse(String(res[0].result));
      assertEquals(payload.ok, false, '不存在的回执不得报 ok');
      assertEquals(payload.code, 'receipt_not_found', `应 receipt_not_found，实际 ${payload.code}`);
      assert(String(payload.error).includes('volatile'), '应说明回执是易失的（ADR-04），别让调用方以为是自己写错了');
    } finally { await h.stop(); rmSync(h.d, { recursive: true, force: true }); }
  });

  // ══ AR-C04/4：只读模式的 Cell 必须调得动它 ════════════════════════════════════
  //
  // 修前 `_checkModeReadOnly` 只判工具名，`action.inspect` 不在只读清单里 ⇒ 只读 Cell
  // 连"看自己刚做了什么"都做不到。而它读的是内存 + 一次 stat，本来就没有副作用。
  runner.test('AR-C04/4 只读模式：action.inspect 放行、tool-write 仍被拒', async () => {
    const h = await makeHost({ readOnly: true });
    try {
      // 只读模式下先别写盘，直接调 inspect（回执不存在也应走到 receipt_not_found，而不是被权限门拦）
      const ins = await h.exec.executeBatch(
        [{ id: 'call_i', name: 'action.inspect', arguments: JSON.stringify({ action_id: 'act-x' }) }],
        { sessionId: 'sess-A', chainId: 'c1' },
      );
      const payload = JSON.parse(String(ins[0].result ?? '{}'));
      assertEquals(payload.code, 'receipt_not_found',
        '只读模式必须放行 action.inspect —— 修前是 permission_denied'
        + '（只读清单只判工具名，而 action.inspect 不是工具名）'
        + `，实际 code=${payload.code} state=${ins[0].state}`);

      const w = await h.exec.executeBatch(
        [{ id: 'call_w', name: 'tool-write', arguments: JSON.stringify({ path: 'b.txt', content: 'x' }) }],
        { sessionId: 'sess-A', chainId: 'c2' },
      );
      assertEquals(w[0].status, 'blocked', '只读模式必须拦住 tool-write');
      assertEquals(w[0].diagnostic?.code, 'PERMISSION_DENIED', `应 PERMISSION_DENIED，实际 ${w[0].diagnostic?.code}`);
      console.log('       [实测] 只读模式：inspect 放行（receipt_not_found），write 被拦（PERMISSION_DENIED）');
    } finally { await h.stop(); rmSync(h.d, { recursive: true, force: true }); }
  });

  // ══ AR-C04/5：结果**不得进缓存** ═══════════════════════════════════════════════
  //
  // 执行器对"只读能力"的结果做了 30s 缓存（R0-132）。`action.inspect` 是只读的，
  // 但它的答案建立在"留档还在不在"这个易变前提上：缓存命中会让一条**已被淘汰**的回执
  // 继续"存在"最多 30 秒。所以"只读"与"可缓存"必须拆成两个判据。
  runner.test('AR-C04/5 清空留档后同参数再查必须立刻说找不到（未走缓存）', async () => {
    const h = await makeHost();
    try {
      const { actionId } = await writeOnce(h);
      const first = JSON.parse(String((await h.exec.executeBatch(
        [{ id: 'call_1', name: 'action.inspect', arguments: JSON.stringify({ action_id: actionId }) }],
        { sessionId: 'sess-A', chainId: 'c2' },
      ))[0].result));
      assertEquals(first.ok, true, '前提：第一次查询应成功（顺带把结果写进缓存）');

      // 模拟留档被淘汰（`_receiptMax` 溢出时的真实行为）
      h.exec._receipts.clear();

      const second = JSON.parse(String((await h.exec.executeBatch(
        [{ id: 'call_2', name: 'action.inspect', arguments: JSON.stringify({ action_id: actionId }) }],
        { sessionId: 'sess-A', chainId: 'c3' },
      ))[0].result));
      assertEquals(second.ok, false,
        '留档已清空，第二次必须说找不到 —— 若仍报 ok:true，说明命中了缓存，'
        + '即"已淘汰的回执"在缓存有效期内继续存在');
      assertEquals(second.code, 'receipt_not_found', `应 receipt_not_found，实际 ${second.code}`);
      console.log('       [实测] 清档前 ok=true → 清档后 ok=false（未走缓存）');
    } finally { await h.stop(); rmSync(h.d, { recursive: true, force: true }); }
  });

  // ══ AR-C04/6：**结构性**判据 —— 钉住"是哪一层在放行" ═════════════════════════
  //
  // 这一条是 v0.10.4 的教训：行为判据证明不了"两层里是哪一层在拦/在放"。
  // AR-C05/5 当时就是行为断言冒充结构断言，回退入口剥离后它照样绿。
  // 所以这里直接读源码，钉死三件事：白名单存在、只读集合含它、缓存判据不是"只读"。
  runner.test('AR-C04/6 结构判据：白名单 / 只读集合 / 缓存判据三处都在源码里', async () => {
    const fs = await import('node:fs');
    const policy = fs.readFileSync(join(ROOT, 'plugins/_lib/tool-policy.js'), 'utf-8');
    const exec = fs.readFileSync(join(ROOT, 'plugins/tool-executor.js'), 'utf-8');

    assert(/MODEL_INVOCABLE_CAPABILITIES\s*=\s*new Set\(\[[^\]]*'action\.inspect'/.test(policy),
      'tool-policy.js 必须把 action.inspect 登记进模型可点名白名单');
    assert(/NON_CACHEABLE_CAPABILITIES\s*=\s*new Set\(\[[^\]]*'action\.inspect'/.test(policy),
      'tool-policy.js 必须把 action.inspect 登记进不可缓存集合（否则查当前真相会回报旧真相）');
    assert(/export function isCacheableCapability/.test(policy),
      'tool-policy.js 必须导出 isCacheableCapability —— "只读"与"可缓存"是两个判据');
    assert(/export function isModelInvocableCapability/.test(policy),
      'tool-policy.js 必须导出 isModelInvocableCapability');

    // 只读集合里必须真的含它（用运行期判据，而不是再抄一遍字符串）
    const pol = await imp('plugins/_lib/tool-policy.js');
    assertEquals(pol.isReadonlyCapability('action.inspect'), true,
      'action.inspect 必须被判为只读能力 —— 否则只读 Cell 永远调不动它');
    assertEquals(pol.isCacheableCapability('action.inspect'), false,
      'action.inspect 不得可缓存');
    assertEquals(pol.isModelInvocableCapability('action.inspect'), true,
      'action.inspect 必须在模型可点名白名单里');

    // 执行器必须**用**这两个判据，而不是自己另写一份
    assert(/isModelInvocableCapability\(toolName\)/.test(exec),
      'tool-executor 的 _resolveCapability 必须调用 isModelInvocableCapability');
    assert(/isCacheableCapability\(resolved\.capId\)/.test(exec),
      'tool-executor 的结果缓存门必须用 isCacheableCapability，不能再用"只读"当"可缓存"');
    assert(!/resolved\.capId\s*&&\s*this\._capabilityIsReadOnly\(resolved\.capId\)\)\s*\{\s*$/.test(exec),
      '结果缓存门不得再以"只读"为唯一判据（那正是 AR-C04/5 的成因）');
    console.log('       [实测] 白名单 / 只读集合 / 缓存判据三处结构断言全绿');
  });

  // ══ AR-C04/7：**反例** —— 白名单外的已注册能力仍然点不动 ═════════════════════
  //
  // 没有这一条，前面六条都能被"把所有能力都放开"这种改法满足。
  runner.test('AR-C04/7 白名单外的已注册能力仍不可点名（修法不是"全放开"）', async () => {
    const h = await makeHost({ extraCapabilities: ['cell.spawn', 'tool.compose'] });
    try {
      for (const name of ['cell.spawn', 'tool.compose']) {
        const res = await h.exec.executeBatch(
          [{ id: 'call_' + name, name, arguments: JSON.stringify({}) }],
          { sessionId: 'sess-A', chainId: 'c1' },
        );
        const r = res[0];
        assert(r.state !== 'succeeded',
          `白名单外的能力 ${name} 不得被模型点名调到 —— 若成功，说明修法是"任何已注册能力都可点名"，`
          + `那会把能力表整体变成模型可调面。实际 state=${r.state}`);
        assert(!String(r.result ?? '').includes('SHOULD-NOT-REACH'),
          `${name} 的 handler 不得被执行`);
      }
      console.log('       [实测] cell.spawn / tool.compose 均被拒（白名单确实在限制）');
    } finally { await h.stop(); rmSync(h.d, { recursive: true, force: true }); }
  });
}
