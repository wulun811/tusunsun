#!/usr/bin/env node
/**
 * test/probes/r0-167-single-cell-contract.mjs
 *
 * 「同进程多 Cell」的**合同探针**。
 *
 * 为什么要有这一条：发布门禁里曾把它写成 `NOT_RUN`，理由是"没验"。这是错的 ——
 * 它不是"没验"，而是**产品明文拒绝**（v0 合同：1 Cell : 1 Core : 1 OS process）。
 * 把一条已被单测断言、且产品主动拒绝的边界记成"未执行"，等于把**设计决定**说成
 * **证据缺口**，下一轮复审会据此索要一个本不该存在的功能。
 *
 * 但反过来也不能只删掉那行 NOT_RUN 就算了：那样"1 Cell"就退回成一句没人跑的声明。
 * 正确的做法是把它变成**每次门禁都跑一遍**的合同探针 —— 既证明拒绝仍然生效，
 * 也证明拒绝得**恰到好处**（不能靠"一律不许建第二个"把正控一起弄红）。
 *
 * ── 关于"close 之后还能不能再建"（这一条最容易被写成我自己想要的样子）──
 * 第一版探针把"close 之后必须能再建"当成正控，结果实测失败。查过实现后确认：
 * **拒绝是对的，我的断言是错的**。理由不是"忘了删记录"，而是 `create()` 里写明的
 * 依据 —— 场景状态、插件状态、能力注册表都还不是 Cell 私有的；close 只结束这个 Cell
 * 的执行身份，**没有**把那些全局状态复原。此时在同一进程里再建一个 Cell，
 * `runtime.kind:'process'` 依然是谎话。所以"一个 Core 一生承载一个 Cell"是**刻意的**
 * 生命周期约束，不是并发约束。
 *
 * 因此本探针断言的是：**同进程** close 之后仍拒绝（保持 v0 语义），而**同 stateDir 的
 * 新进程**必须能建（证明 close 没有把这个部署永久报废）。这两条一起，才既锁住合同、
 * 又不把"必须重启换 Cell"这个已知代价藏起来。
 *
 * 退出码：0 通过；1 违约；2 探针自身出错（门禁把 2 记成 FAIL）。
 */
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (rel) => import(join(ROOT, rel));
const out = [];
const ok = (name, detail) => out.push({ name, ok: true, detail });
const fail = (name, detail) => out.push({ name, ok: false, detail });

/** 把"抛错"与"返回失败信封"统一成 `{ok, code}`，两种拒绝形态都要认。 */
const codeOf = async (fn) => {
  try {
    await fn();
    return { ok: true, code: null };
  } catch (e) {
    return { ok: false, code: e?.code ?? null, message: e?.message ?? String(e) };
  }
};

const specOf = (over = {}) => ({
  schema_version: 'tusunsun.cell/v0',
  cell_id: 'cell-single-1',
  workspace: '/abs/projects/repo',
  capabilities: ['tool.read'],
  permission_mode: 'auto',
  runtime: { kind: 'process' },
  limits: { max_active_tasks: 1, max_children: 0 },
  ...over,
});

const taskOf = (over = {}) => ({
  schema_version: 'tusunsun.task/v0',
  task_id: 'task-after-close',
  attempt: 1,
  target_cell_id: 'cell-single-1',
  goal: 'do the thing',
  inputs: [],
  required_capabilities: ['tool.read'],
  budget: { max_steps: 1, wall_ms: 1000 },
  acceptance: { required_artifacts: [], checks: [] },
  ...over,
});

let dir;
let exit = 2;
try {
  const { Core } = await imp('src/core/core.js');
  dir = mkdtempSync(join(tmpdir(), 'probe-r0-167-'));
  const ws = join(dir, 'ws');
  mkdirSync(ws, { recursive: true });
  const stateDir = join(dir, 'state');

  /** 一台最小宿主：真 Core + 真 workspace 绑定 + 真 cell-runtime。 */
  const makeHost = async () => {
    const core = new Core({ stateDir });
    core.log = () => {};
    core.setData('agent.workDir', ws);
    await (await imp('plugins/workspace.js')).default.init(core);
    await (await imp('plugins/cell-runtime.js')).default.init(core);
    return { core, svc: core.getService('cell-runtime') };
  };

  // ① 首个 Cell 能建 —— 拒绝不是常态，否则后面所有"被拒"都不足为证。
  const h = await makeHost();
  const first = await codeOf(() => h.svc.create(specOf({ cell_id: 'cell-1', workspace: ws }), { trusted: true }));
  if (first.ok) ok('first-cell-allowed', { cell_id: 'cell-1' });
  else fail('first-cell-allowed', first);

  // ② 第二个（不同 id）必须具名拒绝，且 list() 不得多出一条。
  const second = await codeOf(() => h.svc.create(specOf({ cell_id: 'cell-2', workspace: ws }), { trusted: true }));
  const listed = h.svc.list().length;
  if (!second.ok && second.code === 'cell_quota_exceeded' && listed === 1) {
    ok('second-cell-refused', { code: second.code, listed });
  } else {
    fail('second-cell-refused', { code: second.code, ok: second.ok, listed });
  }

  // ③ 同 id 重复必须是**另一条**理由：两个拒绝不得合并成一个。
  const same = await codeOf(() => h.svc.create(specOf({ cell_id: 'cell-1', workspace: ws }), { trusted: true }));
  if (!same.ok && same.code === 'cell_id_conflict') ok('same-id-distinct-code', { code: same.code });
  else fail('same-id-distinct-code', { code: same.code, ok: same.ok });

  // ④ close 必须真的关掉：状态 stopped，且此后拒接新任务（终态不得复活）。
  let closeRes = null;
  try { closeRes = await h.svc.close('cell-1', { force: true }); } catch (e) { closeRes = { ok: false, code: e?.code ?? null }; }
  const stateAfter = h.svc.describe('cell-1').state;
  const acceptAfter = await codeOf(() => h.svc.accept('cell-1', taskOf({ target_cell_id: 'cell-1' })));
  if (stateAfter === 'stopped' && !acceptAfter.ok && acceptAfter.code === 'cell_not_ready') {
    ok('close-is-terminal', { stateAfter, acceptCode: acceptAfter.code, from: closeRes?.from });
  } else {
    fail('close-is-terminal', { stateAfter, acceptCode: acceptAfter.code, closeRes });
  }

  // ⑤ 同进程再建仍拒绝：v0 是**生命周期**约束（全局状态未 Cell 私有化），不是并发约束。
  const afterClose = await codeOf(() => h.svc.create(specOf({ cell_id: 'cell-3', workspace: ws }), { trusted: true }));
  if (!afterClose.ok && afterClose.code === 'cell_quota_exceeded') {
    ok('same-process-recreate-still-refused', { code: afterClose.code, why: 'v0 全局场景/插件状态未按 Cell 隔离，close 不复原它们' });
  } else {
    fail('same-process-recreate-still-refused', { code: afterClose.code, ok: afterClose.ok });
  }

  // ⑥ 但**新进程**（同 stateDir）必须能建：close 不得把这个部署永久报废。
  const h2 = await makeHost();
  const bootList = h2.svc.list().length;
  const rebooted = await codeOf(() => h2.svc.create(specOf({ cell_id: 'cell-4', workspace: ws }), { trusted: true }));
  if (rebooted.ok) ok('fresh-process-can-create', { cell_id: 'cell-4', bootList });
  else fail('fresh-process-can-create', { ...rebooted, bootList });

  // ⑦ 网关 WS 路径必须共用同一份配额实现，不得在网关里复制一条判定。
  const gwSrc = readFileSync(join(ROOT, 'plugins/gateway.js'), 'utf8');
  const forwards = /cell\.create[\s\S]{0,200}cr\.create/.test(gwSrc);
  const ownGuard = /cell_quota_exceeded/.test(gwSrc);
  if (forwards && !ownGuard) ok('gateway-shares-one-implementation', { forwards, ownGuard });
  else fail('gateway-shares-one-implementation', { forwards, ownGuard });

  exit = out.every((c) => c.ok) ? 0 : 1;
} catch (e) {
  exit = 2;
  console.error('PROBE_ERROR', e?.stack || e);
} finally {
  for (const c of out) console.log(JSON.stringify(c));
  if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 尽力而为 */ } }
}
process.exitCode = exit;
