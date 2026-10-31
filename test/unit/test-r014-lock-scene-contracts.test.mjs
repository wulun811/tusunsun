// R-014-1～5 回归锁（v0.14.1）：专家 0.14.0 复审五条反例的单元级判据。
//
// 与 `test/probes/r014-lock-scene-contracts.mjs` 的分工：
//   · **探针**回答"这条缺陷还在不在"（跑一次，输出 BUG/FIXED）；
//   · **本文件**回答"以后会不会又回来"（进全量套件，每次回归都跑）。
// 两者不能互相替代：探针不在 `run-all` 里，靠人记得跑；单测不产出
// "当初长什么样"的叙述，靠探针留证。
//
// 每条都刻意保留**反向判据**（交叉验证），因为上一轮我在这上面错过两次：
//   · K-16 第一版判据会把正确实现判成缺陷；
//   · E4/1 第一版判据是空转的（before/after 都含被加的那一行）。
// 所以本文件每条都问两个问题：**该坏的坏了吗？不该坏的被误伤了吗？**
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assert, assertEquals } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(join(ROOT, rel));

export async function setup(runner) {
  const { Core } = await imp('src/core/core.js');
  const { LifecycleManager } = await imp('src/core/lifecycle-manager.js');
  const { SceneController } = await imp('src/core/scene-controller.js');
  let tmp;

  runner.beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'r014-'));
    mkdirSync(join(tmp, 'plugins'), { recursive: true });
    writeFileSync(join(tmp, 'package.json'), '{"type":"module"}');
  });
  runner.afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ } });

  const makeCore = () => {
    const c = new Core({ stateDir: join(tmp, 'state'), pluginsDir: join(tmp, 'plugins') });
    c.log = () => {};
    return c;
  };

  /** 场景桩：声明集合 + 可选 partial/missingIncludes。 */
  function sceneStub(core, decl) {
    const pm = {
      isResolvable: () => true,
      async unload(n) { core.plugins.delete(n); return { ok: true }; },
      async loadOne(n) {
        const cur = core.plugins.get(n);
        if (cur?.state === 'running') return { ok: true, name: n };
        core.plugins.set(n, { name: n, state: 'running' });
        return { ok: true, name: n };
      },
    };
    const sc = new SceneController(core, pm);
    sc.findScene = async (n) => {
      const d = decl[n];
      if (!d) return null;
      // **必须回传 lazy**：漏了它，场景三处函数就看不到懒加载声明，
      // R-014-5/2（lazy 不得被要求 running）会变成一条空转判据 ——
      // 实测：把 lazy 也纳入必需集合（变异 M26），该用例**照样全绿**。
      // 这是本文件第三例"判据测不到被修对象"，与 v0.14.0 的 E4/1、K-16 同族。
      return {
        name: n, plugins: d.plugins || [], eager: d.eager || [], lazy: d.lazy || [],
        optional: [], ...(d.extra || {}),
      };
    };
    return { sc, pm };
  }

  // ══ R-014-1：过期 ALS 上下文不得被认作仍持有租约 ═══════════════════════
  runner.test('R-014-1/1 锁内派生的异步后代，在原锁释放后必须排队（峰值并发恒为 1）', async () => {
    const core = makeCore();
    const lc = new LifecycleManager(core);
    const KEY = 'shared';
    let concurrent = 0;
    let peak = 0;
    const inside = async (ms) => {
      concurrent += 1; peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, ms));
      concurrent -= 1;
    };

    await lc.runExclusive(KEY, async () => {
      // 关键：**不 await** 这个后代。它继承父链的 ALS 上下文。
      setTimeout(() => { lc.runExclusive(KEY, () => inside(40)).catch(() => {}); }, 25);
      await inside(10);
    });
    await new Promise((r) => setTimeout(r, 20));
    await lc.runExclusive(KEY, () => inside(75));

    assertEquals(peak, 1,
      `峰值并发必须为 1，实测 ${peak} —— >1 说明过期上下文被当成"仍持锁"（R-014-1 复发）`);
  });

  runner.test('R-014-1/2 同一活跃租约内的重入必须仍然成立（否则 reload→load 会自锁）', async () => {
    // 这条是 R-014-1 的**反向判据**：如果为了修 R-014-1 把可重入整个删掉，
    // 上面那条会绿，而这条会红 —— 且真实后果是 K-15 的死锁（实测 rc=124）。
    const core = makeCore();
    const lc = new LifecycleManager(core);
    let depth = 0;
    await lc.runExclusive('k', async () => {
      depth += 1;
      await lc.runExclusive('k', async () => { depth += 1; });
    });
    assertEquals(depth, 2, '外层锁内同类重入必须放行（本判据防"修 R-014-1 把可重入拆掉"）');
  });

  runner.test('R-014-1/3 不同 LifecycleManager 的同名 key 不得互认', async () => {
    // 两个 Core 各有自己的 owner 命名空间：A 持锁不该给 B 开后门。
    const a = new LifecycleManager(makeCore());
    const b = new LifecycleManager(makeCore());
    let overlap = 0;
    let peak = 0;
    let releaseA;
    const gate = new Promise((r) => { releaseA = r; });
    const pa = a.runExclusive('same', async () => { peak = Math.max(peak, ++overlap); await gate; overlap -= 1; });
    await new Promise((r) => setTimeout(r, 10));
    const pb = b.runExclusive('same', async () => { peak = Math.max(peak, ++overlap); overlap -= 1; });
    await new Promise((r) => setTimeout(r, 30));
    releaseA();
    await Promise.all([pa, pb]);
    assertEquals(peak, 2, '两个不同 manager 的同名 key 是两件独立的事，应当可以并行（不得跨实例互认）');
  });

  // ══ R-014-2：队列 Map 必须回收已完成 key ═══════════════════════════════
  runner.test('R-014-2/1 一次性 key 全部执行完后，队列必须回到基线', async () => {
    const core = makeCore();
    const lc = new LifecycleManager(core);
    const before = lc._queues.size;
    const N = 300;
    for (let i = 0; i < N; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await lc.runExclusive(`k-${i}`, async () => {});
    }
    assertEquals(lc._queues.size, before,
      `${N} 个一次性 key 跑完后 Map 仍残留 ${lc._queues.size - before} 条 —— 身份比较又拿错了对象（R-014-2 复发）`);
  });

  runner.test('R-014-2/2 仍有后继排队时不得提前删链（回收不能破坏互斥）', async () => {
    // 反向判据：把删除条件写成"永远删"，上面那条会绿，而这里会失去互斥。
    const core = makeCore();
    const lc = new LifecycleManager(core);
    let concurrent = 0;
    let peak = 0;
    const job = async () => {
      concurrent += 1; peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, 15));
      concurrent -= 1;
    };
    await Promise.all([
      lc.runExclusive('same', job),
      lc.runExclusive('same', job),
      lc.runExclusive('same', job),
    ]);
    assertEquals(peak, 1, `同名三请求必须串行（峰值并发=${peak}）；回收逻辑不得把仍在排队的链删掉`);
    assertEquals(lc._queues.size, 0, '全部结束后仍应回收干净');
  });

  // ══ R-014-3：场景名变化必须提交，即使用户插件集合不变 ═════════════════
  runner.test('R-014-3/1 A→B 同配方：场景名必须落盘（内存与磁盘不得分叉）', async () => {
    const core = makeCore();
    let disk = null;
    let saves = 0;
    core._services.set('config', { get: () => disk, set: () => {}, setAndSave: async (k, v) => { if (k === 'activeScene') { saves += 1; disk = v; } } });
    const { sc } = sceneStub(core, { 'scene-A': { eager: ['p'] }, 'scene-B': { eager: ['p'] } });

    await sc.switchTo('scene-A', { yes: true });
    const r = await sc.switchTo('scene-B', { yes: true });
    assertEquals(r.ok, true, '同配方切换仍应成功');
    assertEquals(sc.currentScene, 'scene-B', '内存里的场景名已切');
    assertEquals(disk, 'scene-B', '磁盘也必须提交 —— 否则重启后恢复哪个是分叉的（R-014-3）');
    assertEquals(r.persisted, true, '确实写了，就要如实标 persisted:true');
    assertEquals(saves >= 2, true, 'A→B 这次必须发生一次写盘');
  });

  runner.test('R-014-3/2 同名同配方才是真正的 unchanged（不得为"总是写"而复发 K-16/1）', async () => {
    // 反向判据：如果把 changed 恒置 true，上面那条绿、这条红。
    const core = makeCore();
    let writes = 0;
    core._services.set('config', { get: () => null, set: () => {}, setAndSave: async () => { writes += 1; } });
    const { sc } = sceneStub(core, { rep: { eager: ['p'] } });
    await sc.switchTo('rep', { yes: true });
    const afterFirst = writes;
    const r = await sc.switchTo('rep', { yes: true });
    assertEquals(r.unchanged, true, '同名同配方第二次必须标 unchanged');
    assertEquals(r.persisted, false, '没写就必须标 persisted:false');
    assertEquals(writes, afterFirst, '同名同配方不得再写一次（重复宣告同一事实）');
    assertEquals(JSON.stringify(r.toAdd), '[]', 'toAdd 的老语义是"本轮新装的"，重复切换必须为空');
  });

  // ══ R-014-4：场景自己声明 partial 时不得提交成功 ═══════════════════════
  runner.test('R-014-4/1 必需 include 缺失 → 具名 preflight 失败且不提交', async () => {
    const core = makeCore();
    let disk = null;
    core._services.set('config', { get: () => null, set: () => {}, setAndSave: async (k, v) => { disk = v; } });
    const { sc } = sceneStub(core, {
      incomplete: { eager: ['p'], extra: { partial: true, missingIncludes: ['required-parent'] } },
    });
    const r = await sc.switchTo('incomplete', { yes: true });
    assertEquals(r.ok, false, 'partial 场景不得提交成功（R-014-4）');
    assertEquals(r.code, 'scene_preflight_failed', '应具名 preflight 失败，而不是笼统的 partial/unknown');
    assert(Array.isArray(r.missingIncludes) && r.missingIncludes.includes('required-parent'),
      '必须点名缺了哪个 include —— 否则排障方向错');
    assertEquals(sc.currentScene, null, 'currentScene 不得提交');
    assertEquals(disk, null, '持久配置一个字节都不能写');
  });

  runner.test('R-014-4/2 完整场景不得被 partial 判据误伤', async () => {
    // 反向判据：如果判据写成"有 include 就拒绝"，正常场景全挂。
    const core = makeCore();
    core._services.set('config', { get: () => null, set: () => {}, setAndSave: async () => {} });
    const { sc } = sceneStub(core, { good: { eager: ['p'] } });
    const r = await sc.switchTo('good', { yes: true });
    assertEquals(r.ok, true, '没有 partial 标记的场景必须正常切换');
  });

  // ══ R-014-5：Verify 必须覆盖完整必需集合 ═══════════════════════════════
  runner.test('R-014-5/1 必需插件已在 Map 里但 state=error → 不得 verified:true', async () => {
    const core = makeCore();
    core._services.set('config', { get: () => null, set: () => {}, setAndSave: async () => {} });
    core.plugins.set('p', { name: 'p', state: 'error' });
    const { sc } = sceneStub(core, { needp: { eager: ['p'] } });
    const r = await sc.switchTo('needp', { yes: true });
    assertEquals(r.ok, false, '必需插件仍是 error 却报成功 —— R-014-5 复发');
    assert(Array.isArray(r.missing) && r.missing.includes('p'), '必须点名 p 没在跑');
  });

  runner.test('R-014-5/2 laz 不得进入"必须 running"集合（防止 Verify 修过头）', async () => {
    // 这是 R-014-5 最容易修过头的方向：把 lazy 一并纳入必需集合。
    //
    // **端到端测不出来**——这是本轮实测发现的事实，不是推测：
    // 场景切换的 `toAdd` 用的是声明全集（含 lazy），Apply 会真的去装载 lazy 插件；
    // Preflight 也要求 lazy 可解析。所以"lazy 没在跑"在 Apply 之后**不可能出现**，
    // 端到端用例无法区分两种实现（变异 M26 把 lazy 加进必需集合，端到端用例照样全绿）。
    // 因此这条判据必须直接钉**函数契约**：必需集合里不许有 lazy。
    // 同时保留一条端到端断言，确认"lazy 场景整体仍能切换成功"这一前提成立。
    const { sceneRequiredNames } = await imp('src/core/scene-controller.js');
    const req = sceneRequiredNames({ eager: ['e1'], plugins: ['p1'], lazy: ['l1', 'l2'] });
    // v0.15.1（SC-015）：必需集合 = **只有 eager**。`plugins` 与 `lazy` 都是"声明可用、
    // 首次能力调用才装载"——依据是启动器 `scenePluginLists()` 与 docs/guides/scene-system.md，
    // 此前只有场景切换这一条路径把 `plugins` 当成"必须运行"（同一个字段两种解释）。
    assertEquals(JSON.stringify([...req].sort()), JSON.stringify(['e1']),
      '必需集合 = eager（不含 plugins / lazy）；含了就会把合法懒加载判成失败');
    assert(!req.has('p1'), 'plugins 属按需清单，不得进入必需集合');
    assert(!req.has('l1') && !req.has('l2'), 'lazy 必须被排除');

    // 端到端前提：lazy 场景整体仍能切换成功（若这条红了，上面的契约断言就失去意义）。
    const core = makeCore();
    core._services.set('config', { get: () => null, set: () => {}, setAndSave: async () => {} });
    const { sc } = sceneStub(core, { lazyscene: { plugins: [], lazy: ['never-loaded'] } });
    const r = await sc.switchTo('lazyscene', { yes: true });
    assertEquals(r.ok, true, 'lazy 场景应能整体切换成功');
  });

  runner.test('R-014-5/3 推迟装配时不得冒充"已验证"', async () => {
    // CLI 不启动内核（R0-110/T4），它必须显式声明 deferAssembly；
    // 而声明之后**不得**说 verified:true —— 本轮根本没核对过运行态（I-07）。
    const core = makeCore();
    let disk = null;
    core._services.set('config', { get: () => null, set: () => {}, setAndSave: async (k, v) => { disk = v; } });
    const { sc } = sceneStub(core, { s: { eager: ['p'] } });
    const r = await sc.switchTo('s', { yes: true, deferAssembly: true });
    assertEquals(r.ok, true, '推迟装配仍应提交声明（下次启动用它）');
    assertEquals(r.verified, false, '没核对过就不得说 verified:true');
    assertEquals(r.verification, 'deferred', '必须具名说明这是推迟，不是验证通过');
    assertEquals(r.assembled, false, '必须如实标注没有装配');
    assertEquals(disk, 's', '推迟装配仍要落盘（这正是它的目的）');
    assertEquals(core.plugins.get('p')?.state, undefined, '推迟装配不得凭空造出运行中的插件');
  });
}
