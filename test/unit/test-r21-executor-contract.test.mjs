// B-1 / B-2 / D-12：执行器的外层成败判定、超时语义与批处理参数。
//
// 三条缺陷的共同点：**判定与事实分家**。工具说失败、外层说成功；超时说"不知道"、
// 信封却说"失败"；参数解析失败就换成空对象继续跑。这里盯住"外层信封与工具事实一致"。
import { assertEquals } from '../harness.mjs';
import { ToolExecutor } from '../../plugins/tool-executor.js';

/** 最小可用 core：只提供执行器在这几条路径上真正会读的东西。 */
function mk() {
  const events = [];
  const executor = new ToolExecutor();
  executor.core = {
    get: () => undefined,
    getData: () => undefined,
    getService: () => null,
    listCapabilities: () => [{ id: 'tool.late', owner: 'tool-late' }],
    registerCapability: () => {},
    registerService: () => {},
    getCapabilityOutputSchema: () => null,
    log: () => {},
    emitFast: (name, payload) => events.push({ name, payload }),
    on: () => {},
  };
  return { executor, events, args: { _tcId: 'tc-1' } };
}

const finish = (executor, result, meta, name = 'tool-fake') => executor._finishExecuteSuccess(
  name, { _tcId: 'tc-1' }, result, 'sess-1', 'chain-1', 'call-1', Date.now(), meta,
);

export async function setup(runner) {
  runner.test('B-1/1 声明了 execution_result 的工具返回 {ok:false} ⇒ 外层信封也是失败', async () => {
    const { executor, events } = mk();
    const out = await finish(executor, { ok: false, code: 'boom', error: '磁盘满了' }, { contract: 'execution_result' });
    assertEquals(out.ok, false, '外层不能把工具自报的失败记成成功');
    assertEquals(out.state, 'failed');
    assertEquals(out.code, 'boom');
    assertEquals(out.error, '磁盘满了');
    const failed = events.filter((e) => e.name === 'tool.result' && e.payload.ok === false);
    assertCount(failed.length, 1, 'tool.result 必须只发一条 ok:false（失败不能被记成成功）');
  });

  runner.test('B-1/2 合法正例：未声明契约的业务数据含 error 字段仍原样成功', async () => {
    const { executor, events } = mk();
    const payload = { error: 'no match', hits: [] };
    const out = await finish(executor, payload, { contract: null }, 'tool-unknown');
    assertEquals(out.ok, true, '业务数据里的 error 字段不是执行状态');
    assertEquals(events.filter((e) => e.name === 'tool.result_contract_gap').length, 0,
      '未声明却返回 {ok:false} 才告警；这里连 ok:false 都没有，不该告警');
  });

  runner.test('B-1/3 未声明契约却返回 {ok:false}：可见的契约缺口（不是静默成功）', async () => {
    const { executor, events } = mk();
    const out = await finish(executor, { ok: false }, { contract: null }, 'tool-newcomer');
    assertEquals(out.ok, true, '未声明时仍按业务数据处理（不制造新的误杀）');
    assertEquals(events.filter((e) => e.name === 'tool.result_contract_gap').length, 1,
      '必须留下可见的契约缺口事件');
    await finish(executor, { ok: false }, { contract: null }, 'tool-newcomer');
    assertEquals(events.filter((e) => e.name === 'tool.result_contract_gap').length, 1,
      '同一主体只报一次，不刷屏');
  });

  runner.test('B-1/4 契约可以显式声明，且 provides 自报优先', async () => {
    const { executor } = mk();
    assertEquals(executor._contractFor({ name: 'a' }, null), null);
    executor.declareResultContract('tool-declared', 'execution_result');
    assertEquals(executor._contractFor({ name: 'tool-declared' }, 'tool.declared'), 'execution_result');
    assertEquals(executor._contractFor({ name: 'b', provides: [{ name: 'tool.b', resultContract: 'opaque' }] }, 'tool.b'), 'opaque');
    let threw = false;
    try { executor.declareResultContract('x', 'nonsense'); } catch { threw = true; }
    assertEquals(threw, true, '未知契约必须具名拒绝，不能静默存下');
  });

  runner.test('B-2/1 超时是 indeterminate，不是 failed（修前 result_kind 在重建信封时丢失）', async () => {
    const { executor } = mk();
    const failure = executor._failureResult('Tool "x" timed out after 5ms', 'timeout');
    const out = await executor._finishExecuteError('xs', { _tcId: 't' }, executor._toolFailure(failure), 's', 'c', 'call-1', Date.now());
    assertEquals(out.ok, false);
    assertEquals(out.code, 'timeout');
    assertEquals(out.result_kind, 'indeterminate', '"我们不等了"不等于"它没在跑"');
  });

  runner.test('B-2/2 超时后迟到的拒绝不变成 unhandledRejection', async () => {
    const { executor } = mk();
    executor._timeout = 20;
    const unhandled = [];
    const onUnhandled = (e) => unhandled.push(String(e?.message || e));
    process.on('unhandledRejection', onUnhandled);
    try {
      executor.core = Object.assign(executor.core, {
        getService: (name) => (name === 'tool-registry'
          ? { get: async () => ({ name: 'tool-late', provides: [{ name: 'tool.late' }], execute: async () => ({}) }) }
          : null),
        callCapability: () => new Promise((_, reject) => setTimeout(() => reject(new Error('late failure')), 60)),
      });
      const out = await executor.executeOne('tool-late', {}, 'sess-1');
      assertEquals(out.ok, false);
      assertEquals(out.code, 'timeout');
      assertEquals(out.result_kind, 'indeterminate');
      await new Promise((r) => setTimeout(r, 80));   // 让迟到的拒绝真的到达
      assertCount(unhandled.length, 0, '超时后 handler 的迟到拒绝必须有接收方');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  runner.test('D-12 批处理：null / 数字 / 坏 JSON 参数得到具名拒绝而不是空对象执行', async () => {
    const { executor } = mk();
    const out = await executor.executeBatch([
      { id: 'c1', name: 'tool-x', arguments: 'null' },
      { id: 'c2', name: 'tool-y', arguments: '7' },
      { id: 'c3', name: 'tool-z', arguments: '{bad json' },
    ]);
    assertEquals(out.length, 3);
    for (const r of out) {
      assertEquals(r.ok, false, '参数不是 JSON 对象时必须拒绝');
      assertEquals(r.code, 'invalid_arguments');
    }
  });

  runner.test('D-12/正例 批处理：合法对象参数照常进入执行（不被上面的拒绝误伤）', async () => {
    const { executor } = mk();
    const seen = [];
    executor.executeOne = async (name, args) => { seen.push([name, args._tcId]); return { ok: true, tool: name }; };
    const out = await executor.executeBatch([{ id: 'c1', name: 'tool-x', arguments: '{"a":1}' }]);
    assertEquals(seen.length, 1, '合法参数必须真的到执行器');
    assertEquals(out[0].ok, true);
  });
}

function assertCount(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg}：期望 ${expected}，实际 ${actual}`);
}
