// R0-76（专家 C 节四项更正的**合同验收**）：薄 Task 结果信封 —— 状态/具名码/关联 ID/证据边界。
//
// 验收口径（专家原话：一页 schema + 四种语义的真实可触发性矩阵 + 旧消费者兼容测试）：
//   ① succeeded：ok:true ∧ state:'succeeded'，payload 可复核
//   ② denied   ：越界/绝对路径/权限不足 → ok:false ∧ state:'denied' + 具名码，**且副作用未落地**
//   ③ failed   ：能力不存在/冻结/输入非法/资源故障/handler 抛错 → ok:false ∧ state:'failed' + 具名码
//   ④ cancelled：**保留类型，当前 NOT_IMPLEMENTED**——实现不得产生；唯一近似路径
//                （command 超时竞速）必须归 failed/timeout_no_abort，且**副作用未被撤销**
// 不变式：ok === (state === 'succeeded')；失败/拒绝时 payload === null；call_id/attempt/attempt_id 回显；
//         caller 仅审计；evidence.persisted 只能 'unknown'（发行包 event-sink 是 null sink）。
// 兼容：旧消费者的 `payload` / `error` 语义不变（成功 error===null，失败 error 为人类可读文本）。

import { TestRunner, assert, assertEquals } from '../harness.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..', '..');

async function boot() {
  const { Core } = await import(pathToFileURL(join(ROOT, 'src', 'core', 'core.js')).href);
  const { PluginManager } = await import(pathToFileURL(join(ROOT, 'src', 'core', 'plugin-manager.js')).href);
  const d = mkdtempSync(join(tmpdir(), 'r076-'));
  const work = join(d, 'work');
  mkdirSync(join(work, 'input'), { recursive: true });
  writeFileSync(join(work, 'input', 'a.txt'), 'hello r0-76\n', 'utf8');
  // R0-103（开源盘点 #5）：必须给**隔离的 stateDir**。此前不传 ⇒ 落到默认 `~/.tusunsun`，
  // 单测会读写开发者的真实用户态目录（跨运行污染面比端口更大，run-unit-parallel 里
  // `.tusunsun/` 也被列为"必须串行的共享资源"）。`port: 0` 现在也真的生效了
  // （Core 登记会话级覆盖 → config 插件把它写进 gateway.port ⇒ 网关绑内核分配的临时端口）。
  const core = new Core({ pluginsDir: join(ROOT, 'plugins'), stateDir: join(d, 'state'), port: 0 });
  const pm = new PluginManager(core);
  pm.addDirectory(join(ROOT, 'plugins'));
  pm.addDirectory(join(ROOT, 'plugins', 'tools'));
  const denied = [];
  core.on('core:capability.denied', (e) => denied.push(e));
  await pm.loadAll();
  await core.start();
  core.setData('agent.workDir', work);
  return { core, d, work, denied };
}

const SHAPE = (r) => ({
  ok: r?.ok, state: r?.state, code: r?.code,
  payloadNull: r?.payload === null,
  hasCallId: typeof r?.call_id === 'string' && r.call_id.length > 0,
  attempt: r?.attempt,
  attemptIdOk: r?.attempt_id === `${r?.call_id}#${r?.attempt}`,
  persisted: r?.evidence?.persisted,
  traceIdMatches: r?.evidence?.trace_id === r?.call_id,
});

export async function setup(runner) {
  const ctx = await boot();
  const { core } = ctx;
  runner.afterAll(async () => { try { await core.stop?.(); } catch { /* 关停尽力而为 */ } rmSync(ctx.d, { recursive: true, force: true }); });

  // ── ① succeeded ────────────────────────────────────────────────────────
  runner.test('R0-76/①1 succeeded：ok:true ∧ state:succeeded ∧ payload 可复核 ∧ 关联 ID 回显', async () => {
    core.registerCapability('t.echo', { owner: 'r076', handler: (p) => ({ echoed: p.v }) });
    const r = await core.callCapability('t.echo', { v: 42 }, { traceId: 'trace-echo-1' });
    assertEquals(r.ok, true, `成功必须 ok:true：${JSON.stringify(r)}`);
    assertEquals(r.state, 'succeeded', '成功必须 state:succeeded');
    assertEquals(r.code, null, '成功 code 必须为 null');
    assertEquals(r.error, null, '成功 error 必须为 null（兼容：旧消费者 !error 判成功）');
    assertEquals(r.payload.echoed, 42, 'payload 必须可复核');
    assertEquals(r.call_id, 'trace-echo-1', 'call_id 必须回显 opts.traceId');
    assertEquals(r.attempt, 1, 'attempt 必须从 1 起');
    assertEquals(r.attempt_id, 'trace-echo-1#1', 'attempt_id = call_id#attempt');
    assertEquals(r.evidence.persisted, 'unknown', 'null sink 下 persisted 只能 unknown（不得宣称 durable）');
    console.log(`       [实测] succeeded 信封：${JSON.stringify(SHAPE(r))}`);
  });

  runner.test('R0-76/①2 succeeded：真实工具 tool.write/tool.read 写入并读回（无 LLM）', async () => {
    const w = await core.callCapability('tool.write', { path: 'deliveries/out.txt', content: 'r0-76\n' }, { traceId: 'trace-w1' });
    if (w.ok !== true && /ENOENT/.test(String(w.error))) {
      // 目录不存在属资源故障（见 ③4），这里先建目录再写，保证断言的是成功路径
      mkdirSync(join(ctx.work, 'deliveries'), { recursive: true });
    }
    const w2 = await core.callCapability('tool.write', { path: 'deliveries/out.txt', content: 'r0-76\n' }, { traceId: 'trace-w2' });
    assertEquals(w2.ok, true, `写出必须成功：${JSON.stringify(w2).slice(0, 200)}`);
    assertEquals(w2.state, 'succeeded', 'state 必须 succeeded');
    assertEquals(readFileSync(join(ctx.work, 'deliveries', 'out.txt'), 'utf8'), 'r0-76\n', '落盘内容必须可复核');
    const r = await core.callCapability('tool.read', { path: 'deliveries/out.txt', limit: 10 }, { traceId: 'trace-r1' });
    assertEquals(r.ok, true, `读回必须成功：${JSON.stringify(r).slice(0, 200)}`);
    assert(String(r.payload).includes('r0-76'), `payload 必须含读回内容：${String(r.payload).slice(0, 120)}`);
    console.log('       [实测] 真实工具成功路径：write→落盘可复核，read→payload 含内容');
  });

  // ── ② denied ───────────────────────────────────────────────────────────
  //
  // ERR-015（v0.15.1，专家 0.15.0 复审 P1）：本用例的 `state` 断言从 `denied` 改为 `failed`。
  //
  // 修前（v0.15.0）这些码在白名单里，handler 抛出来仍报 `denied` —— 依据是"这个码的合同
  // 保证它在副作用之前"。专家反例证明这条依据**只对内置实现成立，对 Core 的通用语义不成立**：
  // 任何插件都能 `throw Object.assign(new Error('x'), { code: 'out_of_bounds' })`，
  // 而它可能已经写过文件。于是"denied ⇒ 零副作用"这个承诺被 Core 单方面许下、却无法兑现。
  //
  // 现在 Core 只承诺它**亲眼所见**的：handler 没被调用（`dispatched:false`）才算 denied。
  // 内置工具"越界时确实没碰资源"这个事实**没有丢**，只是不再由 Core 的 state 背书 ——
  // 它仍由本用例最后两行（越界写不落盘 / 越界读不回内容）直接验证。
  runner.test('R0-76/②1 越界与绝对路径 → ok:false ∧ code:out_of_bounds ∧ payload:null ∧ 越界写不落盘', async () => {
    const cases = [
      ['读 ../', 'tool.read', { path: '../../etc/passwd', limit: 5 }],
      ['读 /etc', 'tool.read', { path: '/etc/passwd', limit: 5 }],
      ['写 ../', 'tool.write', { path: '../escaped-r076.txt', content: 'x' }],
      ['删 越界', 'tool.rm', { path: '../escaped-r076.txt' }],
      ['列 越界', 'tool.list', { path: '../' }],
    ];
    for (const [name, cap, params] of cases) {
      const r = await core.callCapability(cap, params, { traceId: `trace-denied-${name}` });
      assertEquals(r.ok, false, `${name} 必须 ok:false（R0-76 前此处是 ok:true 的假成功）：${JSON.stringify(r).slice(0, 200)}`);
      // ERR-015：拒绝码来自 handler 内部 ⇒ Core 只能证明"跑过并抛了"，不能证明"没碰资源"
      assertEquals(r.state, 'failed', `${name} handler 抛出的拒绝码不得再报 denied（ADR-13 §ERR-015）`);
      assertEquals(r.code, 'out_of_bounds', `${name} 必须具名码 out_of_bounds，实际 ${r.code}`);
      assertEquals(r.dispatched, true, `${name} 必须如实标注 handler 已跑过`);
      assertEquals(r.side_effect, 'unknown_or_possible', `${name} 不得宣称零副作用`);
      assertEquals(r.payload, null, `${name} 拒绝时 payload 必须为 null`);
      assert(String(r.error).length > 0, `${name} 必须保留人类可读原因`);
      assertEquals(r.evidence.persisted, 'unknown', '证据持久化状态不得虚报');
    }
    assert(!existsSync(join(ctx.d, 'escaped-r076.txt')), '越界写不得真的落盘');
    // 工具层的"零副作用"由这两条独立事实钉住，而不是靠 Core 的 state 自称：
    const rr = await core.callCapability('tool.read', { path: '../../etc/passwd', limit: 5 });
    assertEquals(rr.payload, null, '越界读不得回任何文件内容');
    console.log('       [实测] 5 类越界/绝对路径全部 failed + out_of_bounds，越界读写均未落地');
  });

  runner.test('R0-76/②2 denied：权限不足（未受信身份）→ code:capability_denied 且发出拒绝事件', async () => {
    core.registerCapability('t.guarded', {
      owner: 'r076', permissions: { require_identity: true }, handler: () => 'secret',
    });
    const before = ctx.denied.length;
    const r = await core.callCapability('t.guarded', {}, { traceId: 'trace-guarded', caller: 'self-reported-anyone' });
    assertEquals(r.ok, false, '未受信身份必须被拒');
    assertEquals(r.state, 'denied', 'state 必须 denied');
    assertEquals(r.code, 'capability_denied', 'code 必须 capability_denied');
    assertEquals(r.caller, null, 'caller 只作审计：自报 caller 不得变成受信 caller');
    assert(ctx.denied.length > before, '拒绝必须发出 core:capability.denied 事件（证据可追溯）');
    console.log('       [实测] 权限拒绝：denied/capability_denied，事件已发，自报 caller 未提权');
  });

  // ── ③ failed ───────────────────────────────────────────────────────────
  runner.test('R0-76/③1 failed：能力不存在 / 冻结 / 输入非法 / handler 抛错', async () => {
    const nf = await core.callCapability('t.nope', {});
    assertEquals(nf.ok, false, '不存在的能力必须失败');
    assertEquals(nf.state, 'failed', 'state 必须 failed');
    assertEquals(nf.code, 'capability_not_found', 'code 必须 capability_not_found');

    core.registerCapability('t.frozen', { owner: 'r076', handler: () => 'x' });
    core.freezeCapability('t.frozen');
    const fz = await core.callCapability('t.frozen', {});
    assertEquals(fz.state, 'denied', '冻结属拒绝（denied）');
    assertEquals(fz.code, 'capability_frozen', 'code 必须 capability_frozen');

    core.registerCapability('t.schema', {
      owner: 'r076', input_schema: { required: ['n'], properties: { n: { type: 'integer' } } },
      handler: () => 'ok',
    });
    const bad = await core.callCapability('t.schema', { n: 'not-int' });
    assertEquals(bad.ok, false, 'schema 违规必须失败');
    assertEquals(bad.state, 'failed', '输入非法归 failed（R0-76 分型：不再混同权限拒绝）');
    assertEquals(bad.code, 'invalid_input', 'code 必须 invalid_input');

    core.registerCapability('t.throw', { owner: 'r076', handler: () => { throw new Error('boom'); } });
    const th = await core.callCapability('t.throw', {});
    assertEquals(th.state, 'failed', 'handler 抛错归 failed');
    assertEquals(th.code, 'handler_threw', 'code 必须 handler_threw');
    assertEquals(th.error, 'boom', 'error 必须保留原消息（兼容）');

    core.registerCapability('t.coded', {
      owner: 'r076',
      handler: () => { throw Object.assign(new Error('数据库只读'), { code: 'resource_error' }); },
    });
    const cd = await core.callCapability('t.coded', {});
    assertEquals(cd.code, 'resource_error', '工具/插件自报的具名码必须被框架采纳');
    assertEquals(cd.state, 'failed', 'resource_error 归 failed');
    console.log('       [实测] failed 四型：not_found / frozen(denied) / invalid_input / handler_threw / 自报 code');
  });

  runner.test('R0-76/③2 failed：真实资源故障（父目录不存在）不再假成功', async () => {
    const r = await core.callCapability('tool.write', { path: 'no-such-dir/x.txt', content: 'x' }, { traceId: 'trace-res' });
    assertEquals(r.ok, false, `真实写入失败必须 ok:false（R0-76 前是 ok:true + 字符串 payload）：${JSON.stringify(r).slice(0, 200)}`);
    assertEquals(r.state, 'failed', 'state 必须 failed');
    assertEquals(r.code, 'resource_error', 'code 必须 resource_error');
    assert(/ENOENT/.test(String(r.error)), `error 必须保留底层原因：${r.error}`);
    assert(!existsSync(join(ctx.work, 'no-such-dir', 'x.txt')), '失败必须无副作用落地');
    console.log(`       [实测] 资源故障：ok=${r.ok} state=${r.state} code=${r.code}`);
  });

  // ── ④ cancelled（保留类型 / NOT_IMPLEMENTED）────────────────────────────
  runner.test('R0-76/④1 cancelled 是保留类型：当前实现不得产生，超时必须归 failed/timeout_no_abort', async () => {
    let handlerFinished = false;
    core.registerCapability('t.slow', {
      owner: 'r076',
      handler: async () => { await new Promise((r) => setTimeout(r, 150)); handlerFinished = true; return 'late'; },
    });
    const r = await core.command('t.slow', {}, 30);
    assertEquals(r.ok, false, '超时必须失败');
    assertEquals(r.state, 'failed', '超时归 failed（取消请求 ≠ 副作用已撤销）');
    assertEquals(r.code, 'timeout_no_abort', 'code 必须 timeout_no_abort（不得冒充 cancelled）');
    assert(r.state !== 'cancelled', 'cancelled 是保留类型，当前不得产生');
    await new Promise((rr) => setTimeout(rr, 220));
    assertEquals(handlerFinished, true, '超时返回后 handler 仍会跑完 —— 证明"取消"未撤销执行');
    console.log('       [实测] command 超时：failed/timeout_no_abort；handler 仍在 220ms 内跑完（无 Abort 合同）');
  });

  // ── 不变式与兼容 ───────────────────────────────────────────────────────
  runner.test('R0-76/⑤ 不变式：ok ⇔ succeeded、失败 payload 为 null、关联 ID 分层唯一', async () => {
    const ok = await core.callCapability('t.echo', { v: 1 });
    const ng = await core.callCapability('t.nope', {});
    const bad = await core.callCapability('tool.read', { path: '../x' });
    for (const [name, r] of [['succeeded', ok], ['not_found', ng], ['denied', bad]]) {
      assertEquals(r.ok === (r.state === 'succeeded'), true, `${name}：不变式 ok ⇔ succeeded 必须成立`);
      if (r.state !== 'succeeded') assertEquals(r.payload, null, `${name}：失败/拒绝 payload 必须为 null`);
      assert(typeof r.call_id === 'string' && r.attempt >= 1, `${name}：必须回显 call_id 与 attempt`);
    }
    // call_id 相同**不代表**幂等：同一 traceId 两次调用是两个物理尝试（同一 attempt=1 的两次逻辑调用）
    const a1 = await core.callCapability('t.echo', { v: 1 }, { traceId: 'same-id' });
    const a2 = await core.callCapability('t.echo', { v: 1 }, { traceId: 'same-id' });
    assertEquals(a1.attempt_id, a2.attempt_id, '同一 traceId 默认 attempt=1 → 关联 ID 相同');
    assert(a1 !== a2, '两次调用是两个独立结果对象（call_id 不是幂等键）');
    assertEquals(a1.evidence.persisted, 'unknown', 'persisted 恒为 unknown（无持久 sink）');
    console.log('       [实测] 不变式三条成立；同一 traceId 两次调用 = 两次执行（非幂等）');
  });

  runner.test('R0-76/⑥ 旧消费者兼容：payload/error 语义不变，ok:false 时 error 仍可读', async () => {
    // 旧判据（tool-executor 与多个 builtin 仍在用）：`!result.error` 判成功
    const ok = await core.callCapability('t.echo', { v: 7 });
    assert(!ok.error && ok.payload && ok.payload.echoed === 7, '旧判据 !error 仍判成功，payload 仍可用');
    const bad = await core.callCapability('tool.read', { path: '../x' });
    assert(typeof bad.error === 'string' && bad.error.length > 0, '失败时 error 仍是可读字符串');
    assert(bad.ok === false && bad.payload === null, '失败时 ok/payload 语义明确');
    console.log('       [实测] 兼容：成功 error=null + payload 可用；失败 error 可读');
  });
}
