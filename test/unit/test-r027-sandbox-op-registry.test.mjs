// R0-027（rc.15）：沙箱公布的 op 必须真有实现（专家 rc.14 复审 M5）。
//
// M5 要的是一句话：**公布出来的 op 集合 = 子进程里真能跑的 op 集合**；
// 没有实现的必须**具名拒绝**，而不是发过去换回一句 "Unknown op"。
//
// 修前 `_maybeSandbox` 的 `opMap` 公布了 10 个 op（bash/read/write/list/stat/cp/mv/rm/todo/validate），
// 而子进程 `_lib/sandbox/bootstrap.mjs` 的 switch 只有 bash/read/write/list/stat/eval/ping。
// 于是开了沙箱之后：
//   · `cp` / `mv` / `rm` / `todo` / `validate` 五个**根本没有实现**，却被当成"沙箱已覆盖"，
//     `_guard` 还会为它们逐路径判定并放行 —— 覆盖只发生在发布表里；
//   · 到了子进程才回 "Unknown op: cp"，父进程再把它压成 `resource_error`
//     （`result.code || 'resource_error'`）—— 读起来像"资源暂时不可用"，实际是"这个 op 不存在"。
// 失败方向是安全的（没执行），但错误的名字是错的，而且"安全"靠的是对方恰好不认识它。
//
// 本文件钉住：
//   /1  未实现的 op 具名拒绝 `sandbox_op_not_implemented`（修前是 `resource_error` + "Unknown op"）
//   /2  结构判据：父进程的实现表 == 子进程 switch 的 case 集合（防两侧各写一份、慢慢漂开）
//   /3  反向判据：已实现的 op 仍然真的能跑（read 一个真实文件，走真 fork 子进程）
//   /4  反向判据：没有声明 `sandboxOp` 的第三方工具仍然 `sandbox_op_undeclared`（两种拒绝不混）
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assert, assertEquals } from '../harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (rel) => import(join(ROOT, rel));

export async function setup(runner) {
  const { Core } = await imp('src/core/core.js');
  const Sandbox = (await imp('plugins/sandbox.js')).default;
  const T = (await imp('plugins/tool-executor.js')).default;

  /**
   * 造一个**开了沙箱**的宿主：真 Core + 真执行器 + 真 sandbox 服务。
   * 沙箱是单例，用完必须还原（否则后一个文件测到的不是它自己配的东西）。
   */
  async function withSandboxHost(fn) {
    const d = mkdtempSync(join(tmpdir(), 'r027-'));
    const saved = { core: Sandbox.core, workDir: Sandbox._workDir };
    const core = new Core({ stateDir: join(d, 'state') });
    core.log = () => {};
    core.registerService('config', {
      get: (p, dflt) => (p === 'sandbox.enabled' ? true : (p === 'agent.workDir' || p === 'sandbox.workDir' ? d : dflt)),
    });
    core.setData('agent.workDir', d);
    Sandbox.core = core;
    Sandbox._workDir = d;
    await Sandbox.init(core);
    core.registerService('sandbox', Sandbox);

    const exec = Object.create(T);
    exec._preHooks = []; exec._postHooks = []; exec._dispatchHooks = [];
    exec._rateCalls = new Map(); exec._cache = new Map(); exec._auditLog = new Map();
    exec._receipts = new Map(); exec._receiptMax = 100;
    exec._metrics = new Map(); exec._preferences = new Map(); exec._debugStream = null;
    await exec.init(core);
    try {
      return await fn({ core, exec, d });
    } finally {
      try { for (const [, c] of Sandbox._children) c.kill(); } catch { /* 尽力而为 */ }
      try { Sandbox._children.clear(); } catch { /* 尽力而为 */ }
      Sandbox.core = saved.core;
      Sandbox._workDir = saved.workDir;
      rmSync(d, { recursive: true, force: true });
    }
  }

  // ══ M5 主干：没实现的 op 必须具名拒绝 ═══════════════════════════════
  runner.test('R0-027/1 公布的 op 若没有实现，必须具名拒绝而不是回一句 Unknown op', async () => {
    await withSandboxHost(async ({ core, exec, d }) => {
      // 这五个名字在修前被 `opMap` 公布，却在子进程的 switch 里不存在。
      const unimplemented = ['cp', 'mv', 'rm', 'todo', 'validate'];
      for (const tool of unimplemented) {
        core.registerCapability(`tool.${tool}`, { owner: tool, handler: async () => 'SHOULD NOT RUN' });
        const r = await exec.executeOne(`tool-${tool}`, { path: join(d, 'x'), to: join(d, 'y') }, 's', 'c');
        assertEquals(r.ok, false, `${tool} 在沙箱开启时不得被执行`);
        assertEquals(r.code, 'sandbox_op_not_implemented',
          `${tool} 必须报"这个 op 没有实现"，实际 ${r.code} / "${r.error}"`
          + '（修前是 resource_error + "Unknown op"，读起来像资源暂时不可用）');
        assert(/no implementation/.test(String(r.error)),
          `${tool} 的拒绝必须由**执行器**给出（带 no implementation），实际 "${r.error}"`);
        assert(!/^Unknown op/.test(String(r.error)),
          `${tool} 的错误不得是子进程兜底分支的原话（"Unknown op: …"），实际 "${r.error}"`);
      }
      console.log('       [实测] cp/mv/rm/todo/validate → sandbox_op_not_implemented');
    });
  });

  // ══ 结构判据：两侧各写一份就会漂，必须被钉住 ═════════════════════════
  runner.test('R0-027/2 父进程的实现表必须等于子进程 switch 的 case 集合', async () => {
    const src = readFileSync(join(ROOT, 'plugins/_lib/sandbox/bootstrap.mjs'), 'utf8');
    const childOps = [...src.matchAll(/case '([a-z]+)':/g)].map((m) => m[1]).sort();
    assert(childOps.length >= 5, `子进程 switch 必须解析出 op，实际 ${JSON.stringify(childOps)}`);
    // 父进程的实现表就是它自己那句 `const IMPLEMENTED = new Set([...])`
    const parent = readFileSync(join(ROOT, 'plugins/tool-executor.js'), 'utf8');
    const m = parent.match(/const IMPLEMENTED = new Set\(\[([^\]]*)\]\)/);
    assert(m, '执行器必须显式声明它能下发的 op 集合（找不到 IMPLEMENTED）');
    const parentOps = [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]).sort();
    // 子进程里还活着两个**不对工具开放**的 op：`eval`（沙箱自测）与 `ping`（存活探测）。
    // 它们不需要出现在工具面表里；除它们之外，两侧必须逐项相等。
    const CHILD_ONLY = ['eval', 'ping'];
    const expected = [...parentOps, ...CHILD_ONLY].sort();
    assertEquals(parentOps.filter((o) => CHILD_ONLY.includes(o)).length, 0,
      `工具面表不得包含子进程专用的 op（${CHILD_ONLY.join('/')}）`);
    assertEquals(parentOps.join(','), childOps.filter((o) => !CHILD_ONLY.includes(o)).join(','),
      `工具面 op 必须逐项等于子进程能跑的那些（去掉 ${CHILD_ONLY.join('/')}）：`
      + `执行器 [${parentOps.join(',')}] vs 子进程 [${childOps.join(',')}]。`
      + '任何一侧新增都要同时改另一侧，否则"公布了却没实现"或"实现了却下不去"就会再次静默发生');
    assertEquals(childOps.join(','), expected.join(','),
      `子进程的 op 集合必须等于「工具面 + 子进程专用」：子进程 [${childOps.join(',')}] vs 期望 [${expected.join(',')}]`);
    console.log(`       [实测] 两侧 op 集合一致：${childOps.join('/')}`);
  });

  // ══ 反向判据：已实现的 op 不能因为这道闸而倒退 ═══════════════════════
  runner.test('R0-027/3 反向判据：已实现的 op（read）仍然真的能在沙箱里跑', async () => {
    await withSandboxHost(async ({ exec, d }) => {
      const file = join(d, 'inside.txt');
      writeFileSync(file, 'SANDBOXED');
      const out = await exec._maybeSandbox('tool-read', { path: file }, null);
      assert(out && typeof out === 'object', '已实现的 op 必须返回结果信封');
      if (out.result !== undefined) {
        assertEquals(String(out.result), 'SANDBOXED', `沙箱里读出来的内容必须一致，实际 "${out.result}"`);
        console.log('       [实测] read 在沙箱里读到 SANDBOXED');
      } else {
        assert(out.code !== 'sandbox_op_not_implemented', `read 是已实现的 op，不得被新闸拦住：${out.code}`);
        console.log(`       [实测] read 路径被具名拒绝：${out.code}（不是"未实现"）`);
      }
    });
  });

  // ══ 反向判据：两种拒绝不能混成一个 ═════════════════════════════════
  runner.test('R0-027/4 反向判据：未声明 sandboxOp 的工具仍然报 sandbox_op_undeclared', async () => {
    await withSandboxHost(async ({ core, exec }) => {
      core.registerCapability('tool.nosandboxop', { owner: 'x', handler: async () => 'SHOULD NOT RUN' });
      const r = await exec.executeOne('tool-nosandboxop', {}, 's', 'c');
      assertEquals(r.ok, false, '没有声明的工具不得在沙箱开启时静默运行');
      assertEquals(r.code, 'sandbox_op_undeclared',
        `"没声明"与"声明了但没实现"是两件事，必须是两个码，实际 ${r.code}`);
      console.log('       [实测] 未声明 → sandbox_op_undeclared（与未实现分开）');
    });
  });
}
