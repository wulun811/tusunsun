// R0-130：pre-hook 的 fail-closed 语义（v0.9.29）。
//
// 由来：第八轮建议书 §1 提醒「tool-executor 的 pre-hook 捕获异常后记警告并继续，
// 所以 MCP 的授权判据不得只依赖 pre-hook」。我去核实这条时发现它**比建议书说的更严重**：
//
//   `plugins/cell-runtime.js` 的 `_installCapabilityGate` 本身就注册成 pre-hook ——
//   它是**全仓唯一**的 pre-hook 使用者，承载三件安全判据：
//     ① 撤销水位（close/timeout 后迟到调用）
//     ② read-only Cell 的写工具拦截
//     ③ Host ∩ Cell ∩ Task 能力交集
//   而 `tool-executor` 对钩子异常的处理是 `catch { log('warn') }` **然后继续执行**。
//
// 也就是说：这条门里任何一次意外异常（属性访问 NPE、集合未初始化、未来的重构失误）
// 都会让三件安全判据**同时**失效，而调用方看到的是正常成功。
// 「拒绝」与「检查器坏了」在 fail-open 下无法区分，且后者更危险 —— 它静默。
//
// 实测（变异）：给门内注入一次 `TypeError`，R0-129 的 T01/T02/T03 三条
// （close 后迟到写、超时后继续写盘）全部从"拒绝"变成"成功"。
//
// 修法：`registerPreHook(fn, owner, priority, { failClosed })`。
// 默认仍是 false（保持既有行为，不动未知的第三方钩子）；安全钩子显式声明 failClosed。
// 判据：钩子抛错 ⇒ `status:'blocked'` + `HOOK_ERROR`，与策略拒绝（`HOOK_BLOCKED`）区分开。
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TestRunner, assert, assertEquals } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(join(ROOT, rel));

/** 造一个真 tool-executor（含 tool-write 语义），不联网。 */
async function makeExec(base) {
  const ws = join(base, 'ws');
  mkdirSync(ws, { recursive: true });
  const { Core } = await imp('src/core/core.js');
  const core = new Core({ stateDir: join(base, 'state') });
  core.log = () => {};
  core.setData('agent.workDir', ws);
  await (await imp('plugins/workspace.js')).default.init(core);

  let wrote = 0;
  core.registerCapability('tool.write', {
    owner: 'test',
    handler: async (args) => { wrote++; return { ok: true, path: args?.path ?? null }; },
  });
  core.registerCapability('tool.read', { owner: 'test', handler: async () => 'read-ok' });

  const exec = Object.create((await imp('plugins/tool-executor.js')).default);
  exec.core = core;
  exec._preHooks = [];
  exec._postHooks = [];
  return { core, exec, ws, wroteCount: () => wrote };
}

export async function setup(runner) {
  const base = () => mkdtempSync(join(tmpdir(), 'r0-130-'));

  runner.test('R0-130/A failClosed 钩子抛错 ⇒ 调用被拒（不得降级为放行）', async () => {
    const d = base();
    try {
      const h = await makeExec(d);
      h.exec.registerPreHook(() => { throw new TypeError('gate exploded'); }, 'cell:test', 10, { failClosed: true });
      const r = await h.exec.executeOne('tool-write', { path: 'x.txt' }, 'sess-1', 'sess-1');
      assertEquals(h.wroteCount(), 0, '钩子出错时**不得**真的执行写工具');
      assert(r?.error, `应返回错误，实际 ${JSON.stringify(r)}`);
      assertEquals(r.status, 'blocked', `应为 blocked，实际 ${r.status}`);
      assert(/hook_error/i.test(String(r.error)), `错误应标明 hook_error，实际 ${r.error}`);
      assertEquals(r.diagnostic?.code, 'HOOK_ERROR', `诊断码应为 HOOK_ERROR，实际 ${r.diagnostic?.code}`);
      console.log('       [实测] failClosed 钩子抛错 → status=blocked、HOOK_ERROR、写工具未执行');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-130/B 默认钩子（未声明 failClosed）保持既有行为：抛错只告警，不阻断', async () => {
    const d = base();
    try {
      const h = await makeExec(d);
      h.exec.registerPreHook(() => { throw new TypeError('noisy plugin'); }, 'noisy-plugin', 10);
      const r = await h.exec.executeOne('tool-write', { path: 'y.txt' }, 'sess-2', 'sess-2');
      assertEquals(h.wroteCount(), 1, '默认钩子抛错不应阻断（这是既有语义，不能悄悄改）');
      assert(!r?.error, `不应报错，实际 ${JSON.stringify(r?.error)}`);
      console.log('       [实测] 默认钩子抛错 → 仅告警、工具照常执行（兼容性保持不变）');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-130/C 反例：failClosed 钩子正常返回时不得误伤（不阻断合法调用）', async () => {
    const d = base();
    try {
      const h = await makeExec(d);
      h.exec.registerPreHook(() => undefined, 'cell:ok', 10, { failClosed: true });
      const r = await h.exec.executeOne('tool-write', { path: 'z.txt' }, 'sess-3', 'sess-3');
      assertEquals(h.wroteCount(), 1, '正常返回的 failClosed 钩子不应阻断');
      assert(!r?.error, `不应报错：${r?.error}`);
      console.log('       [实测] failClosed 钩子正常放行 → 调用成功（判据只在出错时收紧）');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-130/D 策略拒绝与判据故障可区分：HOOK_BLOCKED ≠ HOOK_ERROR', async () => {
    const d = base();
    try {
      const h = await makeExec(d);
      h.exec.registerPreHook(() => ({ block: true, reason: 'policy says no' }), 'pol', 10, { failClosed: true });
      const blocked = await h.exec.executeOne('tool-write', { path: 'a.txt' }, 'sess-4', 'sess-4');
      assertEquals(blocked.diagnostic?.code, 'HOOK_BLOCKED', `策略拒绝应为 HOOK_BLOCKED，实际 ${blocked.diagnostic?.code}`);

      const h2 = await makeExec(join(d, 'second'));
      h2.exec.registerPreHook(() => { throw new Error('checker down'); }, 'pol', 10, { failClosed: true });
      const broken = await h2.exec.executeOne('tool-write', { path: 'b.txt' }, 'sess-5', 'sess-5');
      assertEquals(broken.diagnostic?.code, 'HOOK_ERROR', `判据故障应为 HOOK_ERROR，实际 ${broken.diagnostic?.code}`);

      assert(blocked.diagnostic.code !== broken.diagnostic.code,
        '策略拒绝与判据故障必须是两个可区分的码（否则运维无法判断是不是安全门坏了）');
      console.log('       [实测] 策略拒绝=HOOK_BLOCKED，判据故障=HOOK_ERROR，两者可区分');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-130/E 运行时证据：Cell 的能力门必须以 failClosed 注册', async () => {
    const d = base();
    try {
      // v0.9.30：**不再用正则扫源码**。原实现匹配 `}, owner, <n>, {...});` 这一种写法，
      // 于是把回调从多行箭头改成单行表达式（R0-131 的改动）时它误红了 —— 一个"接线检查"
      // 如果只认某一种排版，它守的是排版，不是接线。现在直接看运行时真正注册进执行器的对象。
      const { Core } = await imp('src/core/core.js');
      const ws = join(d, 'ws');
      mkdirSync(ws, { recursive: true });
      const core = new Core({ stateDir: join(d, 'state-gate') });
      core.log = () => {};
      core.setData('agent.workDir', ws);
      await (await imp('plugins/workspace.js')).default.init(core);

      const exec = Object.create((await imp('plugins/tool-executor.js')).default);
      exec._preHooks = []; exec._postHooks = []; exec._dispatchHooks = [];
      exec._rateCalls = new Map(); exec._cache = new Map(); exec._auditLog = new Map();
      await exec.init(core);

      const rtDef = (await imp('plugins/cell-runtime.js')).default;
      const rt = Object.create(rtDef);
      await rt.init(core);
      const svc = core.getService('cell-runtime');
      await svc.create({
        schema_version: 'tusunsun.cell/v0', cell_id: 'cell-gate', workspace: ws,
        capabilities: ['tool.read'], permission_mode: 'read-only',
        runtime: { kind: 'process' }, limits: { max_active_tasks: 1, max_children: 0 },
      }, { trusted: true });

      const gate = exec._preHooks.find((h) => h.owner === 'cell:cell-gate');
      assert(gate, `Cell 必须在创建时装上常驻能力门，实际 pre-hooks=${JSON.stringify(exec._preHooks.map((h) => h.owner))}`);
      assertEquals(gate.failClosed, true,
        'Cell 的能力门（撤销/只读/能力交集）必须 fail-closed 注册，否则门内一次异常会让三项判据同时静默失效');

      // v0.9.30：派发期复核也必须是常驻的，否则 R0-131/B 的窗口重新打开。
      const dh = exec._dispatchHooks.find((h) => h.owner === 'cell:cell-gate');
      assert(dh, 'Cell 必须同时注册派发期复核（handler 紧邻上游、同步执行）');
      console.log('       [实测] Cell 的能力门与派发期复核均已注册，且门为 fail-closed');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
}
