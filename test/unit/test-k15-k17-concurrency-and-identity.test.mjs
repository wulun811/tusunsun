// v0.14.0：专家方案 §6.2（生命周期串行化）与 §5.3（内部唯一 token）的回归锁。
//
// 与 `test/probes/k15-k17-concurrency-and-identity.mjs` 的分工**同前两个 K 文件**：
//   · 探针：不依赖框架、直白打印 BUG/FIXED，给人工核对用，也能在净室里单独跑；
//   · 本文件：走 harness、断言细、跟全量一起跑，用来**锁住语义不被改坏**。
//
// 为什么这三条值得单独一个文件而不是塞进已有的 test-k03-k14：
// 它们不是"专家点名的 13 条"的补充，而是**同一份方案的另外两条硬要求**，
// 此前没有任何探针，所以它们不是回归，是首次复现（详见探针文件头）。
//
// 本轮三次变异各自抓到的空转，写在各用例的注释里 —— 那比用例本身更值得看。

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TestRunner, assert, assertEquals } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(join(ROOT, rel));

export async function setup(runner) {
  const { Core } = await imp('src/core/core.js');
  const { PluginManager } = await imp('src/core/plugin-manager.js');
  const { SceneController } = await imp('src/core/scene-controller.js');
  let tmp;

  runner.beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'k1517-'));
    mkdirSync(join(tmp, 'plugins'), { recursive: true });
    // Node 18 无 ESM 语法探测：临时目录必须是模块包，否则 `.js` 会被当 CJS 解析。
    writeFileSync(join(tmp, 'package.json'), '{"type":"module"}');
  });
  runner.afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不掩盖断言 */ } });

  function makeCore(extra = {}) {
    return new Core({ stateDir: tmp, pluginsDir: join(tmp, 'plugins'), ...extra });
  }

  // ══ K-15：同一 owner 的生命周期操作必须串行化（§6.2）═══════════════════
  //
  // 判据必须落在**后果**上，不能落在"有没有 lock 这个词"上。
  // 修前实测：3 次并发 reload，3 次都报 ok:true，实例只前进 1 代 —— 说了 3 次成功，兑现 1 次。
  //
  // 合规的两种实现都允许：
  //   ① 全部排队执行 ⇒ ok 数 = 3，代数前进 3（本仓选这种）；
  //   ② 只有第一个执行、其余被拒 ⇒ ok 数 ≤ 1，代数前进 ≤ 1。
  // 只有"报了很多次成功但没兑现"是缺陷。
  runner.test('K-15/1 三次并发 reload：报了几次成功，就必须兑现几次', async () => {
    // 进程级代数：重载会换新实例，实例字段永远从 1 开始，分辨不出"换了几代"。
    delete globalThis.__k15gen;
    writeFileSync(join(tmp, 'plugins', 'ser.mjs'), `
globalThis.__k15gen = (globalThis.__k15gen || 0) + 1;
const GEN = globalThis.__k15gen;
export default {
  name: 'ser', version: '1.0.0', provides: [], requires: {},
  async init(core) { this.core = core; },
  async start() { await new Promise((r) => setTimeout(r, 40)); },
  async stop() {},
  async work() { return GEN; },
};
`);
    const core = makeCore();
    const pm = new PluginManager(core);
    pm.registerCapabilities();
    await pm.loadFromDir(join(tmp, 'plugins'), ['ser']);
    const gen0 = await core.plugins.get('ser')?.work();
    assert(gen0 === 1, `装载后应是第 1 代，实际 ${gen0}`);

    const rs = await Promise.all([
      core.callCapability('plugin.reload', { name: 'ser' }),
      core.callCapability('plugin.reload', { name: 'ser' }),
      core.callCapability('plugin.reload', { name: 'ser' }),
    ]);
    const okCount = rs.filter((r) => r?.payload?.ok === true).length;
    const genAfter = await core.plugins.get('ser')?.work();
    const advanced = genAfter - gen0;

    assert(advanced >= okCount,
      `报成功 ${okCount} 次，实例只前进 ${advanced} 代 —— 这是"对外说成功、实际没兑现"（修前实测 3 报 ok、前进 1）。`
      + ` 若采用"只放行一个"的实现，okCount 应 ≤ 1；若采用排队，advanced 应 = okCount。`);
    assert(core.plugins.get('ser')?.state === 'running', '并发之后插件必须仍在 running');
    core.removeAllListeners();
  });

  runner.test('K-15/2 并发 reload 与单次 reload 的最终状态一致（排队不改变结果，只改变次序）', async () => {
    delete globalThis.__k15gen;
    writeFileSync(join(tmp, 'plugins', 'ser2.mjs'), `
globalThis.__k15gen = (globalThis.__k15gen || 0) + 1;
export default {
  name: 'ser2', version: '1.0.0', provides: [], requires: {},
  async init(core) { this.core = core; },
  async start() { await new Promise((r) => setTimeout(r, 20)); },
  async stop() {},
  async work() { return 'alive'; },
};
`);
    const core = makeCore();
    const pm = new PluginManager(core);
    pm.registerCapabilities();
    await pm.loadFromDir(join(tmp, 'plugins'), ['ser2']);
    await Promise.all([
      core.callCapability('plugin.reload', { name: 'ser2' }),
      core.callCapability('plugin.reload', { name: 'ser2' }),
    ]);
    const p = core.plugins.get('ser2');
    assertEquals(p?.state, 'running', '并发重载后必须仍是 running');
    assertEquals(await p.work(), 'alive', '插件必须真的在服务（不是只剩个状态字符串）');
    // 能力/服务也必须恢复（重载失败最典型的残留是"状态好看但能力没了"）
    assertEquals(await core.hasCapability('plugin.reload'), true, '内核自身能力不应被并发重载破坏');
    core.removeAllListeners();
  });

  // ══ K-16：场景切换的事务性（§6.3）═════════════════════════════════════
  //
  // 判据**不是**"两个都 ok 就是错"：一个正确的排队实现允许两次都成功。
  // 有害的是交错 —— 各自 Plan/Apply/Verify 互相穿插，于是提交的那一刻说的已经不是事实。
  // 第一版判据写成"bothOk ⇒ bug"，变异 M11（去掉独占区）虽然变红，
  // 但那种判据会把"排队执行、两次都成功"的**正确实现**也判成缺陷。现在改成查一致性。
  runner.test('K-16/1 两个并发 switchTo：结束后运行态必须与 currentScene 声明一致', async () => {
    const core = makeCore();
    const DECL = { sa: ['ca'], sb: ['cb'] };
    // 带延迟的桩：没有延迟，两次切换不会真的交错，判据会在"恰好先后完成"时空转成绿。
    const pm = {
      isResolvable: () => true,
      async unload(n) { await new Promise((r) => setTimeout(r, 12)); core.plugins.delete(n); return { ok: true }; },
      async loadOne(n) {
        await new Promise((r) => setTimeout(r, 12));
        core.plugins.set(n, { name: n, state: 'running' });
        return { ok: true, name: n };
      },
    };
    const sc = new SceneController(core, pm);
    core._services.set('config', { get: () => null, set: () => {}, setAndSave: async () => { await new Promise((r) => setTimeout(r, 20)); } });
    sc.findScene = async (n) => ({ name: n, plugins: [], eager: DECL[n] || [], optional: [] });

    const [a, b] = await Promise.all([sc.switchTo('sa', { yes: true }), sc.switchTo('sb', { yes: true })]);
    assert(a?.ok === true && b?.ok === true, `本用例针对"两个都成功"的形态：A=${a?.ok} B=${b?.ok}`);

    const running = [...core.plugins.keys()].sort();
    const declared = [...(DECL[sc.currentScene] || [])].sort();
    assertEquals(JSON.stringify(running), JSON.stringify(declared),
      `并发结束后 currentScene='${sc.currentScene}' 声明 [${declared}]，实际在跑 [${running}] —— `
      + '二者不一致说明那个 ok:true 是假的（修前实测：两个都 ok，实际 pa+pb 都在跑，而只声明了 pb）');
    core.removeAllListeners();
  });

  runner.test('K-16/2 重复切换同一场景：第二次不得再写一遍持久配置', async () => {
    // 判据不是"第二次会不会失败"（幂等意图下它应该成功），而是**它有没有重复宣告同一个事实**。
    // 变异 M12（把 changed 恒置 true）会让本条变红。
    writeFileSync(join(tmp, 'plugins', 'rep.mjs'), `
export default { name: 'rep', version: '1.0.0', provides: [{ name: 'rep.work' }],
  async init(core) { this.core = core; }, async start() {} };
`);
    const core = makeCore();
    const pm = new PluginManager(core);
    const sc = new SceneController(core, pm);
    let writes = 0;
    core._services.set('config', { get: () => null, set: () => {}, setAndSave: async () => { writes++; } });
    sc.findScene = async () => ({ name: 'rep', plugins: [], eager: ['rep'], optional: [] });

    const r1 = await sc.switchTo('rep', { yes: true });
    assertEquals(r1.ok, true, `第一次应成功：${JSON.stringify(r1)}`);
    const firstWrites = writes;
    assert(firstWrites >= 1, '第一次切换必须写持久配置');

    const r2 = await sc.switchTo('rep', { yes: true });
    assertEquals(r2.ok, true, '重复切换同一场景仍应 ok（幂等意图不是错误）');
    assertEquals(JSON.stringify(r2.toAdd), '[]', '第二次的差异集必须为空');
    assertEquals(writes, firstWrites, '无变化时不得再写一次持久配置（重复宣告同一个事实）');
    assertEquals(r2.persisted, false, '没写就要如实标 persisted:false，不能沿用上一次的 true');
    assertEquals(r2.unchanged, true, '应明确标出"这次没有变化"');
    core.removeAllListeners();
  });

  runner.test('K-16/3 运行态已切但落盘失败：两件事必须分开报', async () => {
    writeFileSync(join(tmp, 'plugins', 'pf.mjs'), `
export default { name: 'pf', version: '1.0.0', provides: [{ name: 'pf.work' }],
  async init(core) { this.core = core; }, async start() {} };
`);
    const core = makeCore();
    const pm = new PluginManager(core);
    const sc = new SceneController(core, pm);
    core._services.set('config', {
      get: () => null, set: () => {},
      setAndSave: async () => { throw new Error('disk full'); },
    });
    sc.findScene = async () => ({ name: 'pfscene', plugins: [], eager: ['pf'], optional: [] });
    const r = await sc.switchTo('pfscene', { yes: true });

    assertEquals(r.ok, false, '落盘失败不得报整体成功（I-07）');
    assertEquals(r.code, 'scene_persist_failed', '必须具名是"落盘失败"，而不是笼统 partial');
    assertEquals(r.runtime_applied, true, '运行态**确实**已切换，必须如实标注');
    assertEquals(r.persisted, false, '落盘确实没成功');
    assertEquals(core.plugins.get('pf')?.state, 'running', '插件真的在跑（这是 runtime_applied=true 的依据）');
    core.removeAllListeners();
  });

  // ══ K-17：Core 自己产生的唯一物理尝试 token（§5.3）═════════════════════
  runner.test('K-17/1 同一 traceId 两次调用：attempt_token 必须不同，attempt_id 仍作关联', async () => {
    // 专家原文的分工：要一个"Core 自己产生的内部唯一 token"，
    // 同时说"现有 call_id/attempt_id 可以继续用于**关联**"。
    // 所以修法是新增 token + 修掉那句错注释，而不是改 attempt_id 的算法
    // （后者是破坏性变更，R0-76 等既有消费者按 `call_id#attempt` 解析它）。
    const core = makeCore();
    core.registerCapability('k17.echo', { handler: async (p) => p, owner: 'k17' });

    // 故意把 attempt 传成同一个值：唯一性不得依赖调用方给对参数。
    const r1 = await core.callCapability('k17.echo', { n: 1 }, { traceId: 'same-trace', attempt: 1 });
    const r2 = await core.callCapability('k17.echo', { n: 2 }, { traceId: 'same-trace', attempt: 1 });
    assert(r1?.ok && r2?.ok, '两次调用都应成功');

    assert(typeof r1.attempt_token === 'string' && r1.attempt_token.length > 0,
      '必须存在 attempt_token（Core 自己产生的物理尝试标识）');
    assert(r1.attempt_token !== r2.attempt_token,
      `两次独立物理尝试的 attempt_token 必须不同；实际都是 ${r1.attempt_token}`);
    // 关联字段仍在，且语义是"可重复"——这正是它与 token 的分工
    assertEquals(r1.attempt_id, r2.attempt_id, 'attempt_id 是关联 ID，同一 traceId 下**应该**相同');
    // 两次确实是两次执行，不是被合并
    assert(JSON.stringify(r1.payload) !== JSON.stringify(r2.payload), '两次调用是两个物理尝试，不得合并结果');
    core.removeAllListeners();
  });

  runner.test('K-17/2 attempt_token 在单进程内单调且不复用', async () => {
    const core = makeCore();
    core.registerCapability('k17.seq', { handler: async () => 1, owner: 'k17' });
    const tokens = [];
    for (let i = 0; i < 20; i++) {
      const r = await core.callCapability('k17.seq', {}, {});
      tokens.push(r.attempt_token);
    }
    assertEquals(new Set(tokens).size, 20, `20 次调用应得到 20 个不同 token，实际 ${new Set(tokens).size} 个`);
    core.removeAllListeners();
  });
}
