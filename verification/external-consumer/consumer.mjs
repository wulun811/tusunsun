#!/usr/bin/env node
// 外部消费者验收（专家 rc.34 裁决 §5.4）——在**脱离源码树**的目录里、用**发布 tarball 装出来的**
// 包跑 Cell / 工具任务，验证四件事：正常执行、权限拒绝、失败恢复、重启。
//
// 这个脚本被 run.sh 复制进一个空的消费者目录，用裸包名 `tusunsun/...` 导入 —— 它拿不到
// 本仓的 test/lib 帮手，也不读 `.env`、不连模型：只证明「装上之后能按公开 API 用起来」。
//
// **一个阶段一个进程。** v0 的部署约束是 1 Cell : 1 Core : 1 OS process（同进程建第二个 Cell 会
// 被 `cell_quota_exceeded` 拒），所以「权限拒绝」不能靠给同一个 Cell 换能力，只能另起一个进程；
// 而「重启」必须是新进程重新打开同一个 stateDir，否则只是又调了一次函数。
//
//   node consumer.mjs run     <base>        正常执行 → 失败恢复 → 关闭
//   node consumer.mjs deny    <base>        未授权工具的 Cell 调用被拒，且零副作用
//   node consumer.mjs restart <base>        同 stateDir 的**新进程**：上一世 stopped 必须被读回
//   node consumer.mjs after   <base>        另一份 stateDir：新身份照常跑任务并关闭
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const { Core } = await import('tusunsun/src/core/core.js');
const workspacePlugin = (await import('tusunsun/plugins/workspace.js')).default;
const ExecutorCls = (await import('tusunsun/plugins/tool-executor.js')).default.constructor;
const cellRuntime = (await import('tusunsun/plugins/cell-runtime.js')).default;

const phase = process.argv[2];
const base = process.argv[3];
if (!phase || !base) {
  console.error('usage: node consumer.mjs <run|deny|restart|after> <baseDir>');
  process.exit(2);
}
const wsDir = join(base, 'ws');
const stateDir = join(base, 'state');
mkdirSync(wsDir, { recursive: true });
mkdirSync(stateDir, { recursive: true });

const steps = [];
const step = (id, pass, detail) => {
  steps.push({ id, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'} ${id}  ${detail}`);
};

/** 消费者自己的工具：真写盘 —— 「被拒」与「写盘了」是两件不能混的事。 */
const tool = { calls: 0 };

const core = new Core({ stateDir });
core.log = () => {};
core.setData('agent.workDir', wsDir);
await workspacePlugin.init(core);
core.registerCapability('tool.echo', {
  owner: 'consumer',
  handler: async (params) => {
    tool.calls += 1;
    writeFileSync(join(wsDir, 'echo.txt'), String(params?.msg ?? 'echo'));
    return { ok: true, echoed: params?.msg ?? null };
  },
});
const exec = new ExecutorCls();
await exec.init(core);
await cellRuntime.init(core);
const svc = core.getService('cell-runtime');

const ctx = { denied: null, failNext: false };
core.registerCapability('chat.handle', {
  owner: 'consumer',
  handler: async (params) => {
    if (ctx.failNext) { ctx.failNext = false; throw new Error('consumer-injected failure'); }
    // 被门拒时 `executeOne` **不抛**，而是回一份结构化拒绝（`dispatched:false`、`side_effect:none`）
    // —— 那正是「拒了，而且没派发」的证据。抛错的是门本身不可用，两种都要记下来。
    try {
      const r = await exec.executeOne('tool-echo', { msg: `msg-${tool.calls + 1}` }, params?.sessionId);
      if (r && r.ok === false) ctx.denied = r;
    } catch (e) {
      ctx.denied = { ok: false, code: e?.code ?? null, error: e?.message ?? String(e) };
    }
    return { reply: 'handled' };
  },
});

const spec = (id, capabilities) => ({
  schema_version: 'tusunsun.cell/v0', cell_id: id, workspace: wsDir,
  capabilities, permission_mode: 'auto', runtime: { kind: 'process' },
  limits: { max_active_tasks: 1, max_children: 0 },
});
const taskOf = (id, cell, required = []) => ({
  schema_version: 'tusunsun.task/v0', task_id: id, attempt: 1, target_cell_id: cell,
  goal: `consumer ${id}`, inputs: [], required_capabilities: required,
  budget: { max_steps: 3, wall_ms: 15000 },
  acceptance: { required_artifacts: [], checks: [] },
});
const runTask = async (cell, id, required = []) => {
  svc.accept(cell, taskOf(id, cell, required));
  return svc.execute(cell);
};

if (phase === 'run') {
  // ① 正常执行：授权过的 Cell 调自己的工具，工具真的跑、文件真的写。
  await svc.create(spec('c1', ['tool.echo']), { trusted: true });
  const r1 = await runTask('c1', 't-ok', ['tool.echo']);
  step('1 正常执行', r1.execution_state === 'succeeded' && tool.calls === 1 && existsSync(join(wsDir, 'echo.txt')),
    `execution_state=${r1.execution_state} tool_calls=${tool.calls} echo.txt=${existsSync(join(wsDir, 'echo.txt'))}`);

  // ② 失败恢复：一次任务失败之后，同一个 Cell 的下一段任务必须还能跑。
  ctx.failNext = true;
  let failed = null;
  try { failed = await runTask('c1', 't-fail', ['tool.echo']); }
  catch (e) { failed = { execution_state: 'thrown', code: e?.code ?? null }; }
  const r2 = await runTask('c1', 't-recover', ['tool.echo']);
  step('2 失败恢复', failed.execution_state !== 'succeeded' && r2.execution_state === 'succeeded',
    `first=${failed.execution_state}/${failed.code ?? '-'} after=${r2.execution_state}`);

  // ③ 关闭：清理真的完成（rc.35 的判据），锁真的没了。
  const closed = await svc.close('c1');
  step('3 关闭', closed.closed === true && closed.cleanup_done === true
    && Array.isArray(closed.cleanup_pending) && closed.cleanup_pending.length === 0,
    `closed=${closed.closed} cleanup_done=${closed.cleanup_done} pending=${JSON.stringify(closed.cleanup_pending)}`);
} else if (phase === 'deny') {
  // ④ 权限拒绝：没授权任何工具的 Cell，调用必须被门拒，且**副作用为零**。
  await svc.create(spec('c1', []), { trusted: true });
  await runTask('c1', 't-deny');
  step('4 权限拒绝', ctx.denied?.code === 'capability_denied' && ctx.denied?.dispatched === false
    && ctx.denied?.side_effect === 'none' && tool.calls === 0
    && existsSync(join(wsDir, 'echo.txt')) === false,
    `code=${ctx.denied?.code ?? ctx.denied?.error} dispatched=${ctx.denied?.dispatched} `
    + `side_effect=${ctx.denied?.side_effect} tool_calls=${tool.calls} 写盘=${existsSync(join(wsDir, 'echo.txt'))}`);
  const closed = await svc.close('c1');
  step('4b 拒绝之后仍能关闭', closed.closed === true, `closed=${closed.closed}`);
} else if (phase === 'restart') {
  // ⑤ 重启读回：**新进程**在同一 stateDir 上重建同一个 cell_id，上一世 stopped 必须收敛回来。
  //    新建的 stateDir 只会得到 `ready` —— 所以这一条能区分「读回了」与「刚好没状态」。
  const created = await svc.create(spec('c1', ['tool.echo']), { trusted: true });
  step('5 重启读回', created.state === 'stopped', `state=${created.state}（新建 stateDir 本应是 ready）`);
  const closed = await svc.close('c1');
  step('5b 读回之后仍能关闭', closed.closed === true,
    `closed=${closed.closed} pending=${JSON.stringify(closed.cleanup_pending)}`);
} else if (phase === 'after') {
  // ⑥ 另一份 stateDir 上的新身份：装上之后照常建 Cell、跑任务、关掉。
  await svc.create(spec('c1', ['tool.echo']), { trusted: true });
  const r = await runTask('c1', 't-after', ['tool.echo']);
  const closed = await svc.close('c1');
  step('6 重启后照常执行', r.execution_state === 'succeeded' && tool.calls >= 1 && closed.closed === true,
    `execution_state=${r.execution_state} tool_calls=${tool.calls} closed=${closed.closed}`);
} else {
  console.error(`unknown phase: ${phase}`);
  process.exit(2);
}

const passed = steps.filter((s) => s.pass).length;
console.log(`\n[${phase}] ${passed}/${steps.length} 步成立`);
const pkg = (await import('tusunsun/package.json', { with: { type: 'json' } })).default;
console.log(JSON.stringify({ phase, pkg: pkg.version, steps }, null, 2));
process.exit(passed === steps.length ? 0 : 1);
