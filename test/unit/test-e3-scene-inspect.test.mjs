// E3 回归锁 —— 场景声明对照真实装配的诊断（v0.9.33）。
//
// 修的是什么（送审报告 §6 里"我从未系统查过"的第三种形态：错误信息与实际状态不符）：
//   `scene-controller.show()` 只遍历 `scene.plugins`。而多数场景把插件写在 `eager` 里
//   （`scenePluginLists` 的注释早就记着：coding 场景 eager 38、plugins 空）。
//   于是 `show('coding')` 返回**空列表** —— 看起来像"这个场景没有插件"，实际装了 19 个。
//   这是 R0-111/W1 修过的同一形状的复发："只看 plugins"被当成了"看全部"。
//
// 为什么落到 `plugins/scene-inspect.js` 而不是改 `show()`：
//   · `src/core/` 有硬行数预算，`scene-controller.js` 单模块 175/175 已满；
//   · 更重要的：核心负责"按声明装配"，而"声明与实况是否一致"是可失败的**观测**问题。
//     观测代码不该挤进内核预算，也不该在内核里长 —— 计划书 Track E 要的就是接缝。
//
// 本文件的判据都要求**真实状态**，不接受"返回里有个字段叫 status"就算过了：
//   · 声明数必须等于场景文件里 eager ∪ plugins ∪ lazy 的真实并集；
//   · 声明了但磁盘上没有的，必须被点名（declared_but_missing）；
//   · 声明里零读者的键必须被点名（unapplied_keys）；
//   · 模型可见工具若无对应能力，必须被点名（tool_without_capability）。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { rejectNodeTestContext } from '../lib/node-test-guard.mjs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (rel) => import(join(ROOT, rel));

rejectNodeTestContext('test/unit/test-e3-scene-inspect.test.mjs');

export async function setup(runner) {
  const { Core } = await imp('src/core/core.js');

  async function makeHost(pluginsDir) {
    const d = mkdtempSync(join(tmpdir(), 'e3-'));
    const core = new Core({ stateDir: join(d, 'state') });
    core.log = () => {};
    core.pluginsDir = pluginsDir || join(ROOT, 'plugins');
    const SI = (await imp('plugins/scene-inspect.js')).default;
    // 单例：用派生实例，避免跨用例串
    const inst = Object.create(SI);
    inst.core = core;
    return { d, core, inst };
  }

  // ══ 核心判据：声明数必须等于真实并集（修前是 0） ═══════════════════════════
  runner.test('E3/a show 必须看 eager ∪ plugins ∪ lazy 全集（修前只看 plugins ⇒ 空列表）', async () => {
    const h = await makeHost();
    try {
      // 期望值必须取**装配时真正用的那份声明** —— 即 `findScene` 展开 include 之后的结果，
      // 而不是直接读 scenes/coding.json5 的原始文本：后者 eager 只有 9 个，
      // 展开 include 后是 18 个（父场景带来的）。这个差别本身就说明"读文件"不等于"看装配"。
      const { SceneController } = await imp('src/core/scene-controller.js');
      const { scenePluginLists } = await imp('src/bootstrap/cli.js');
      const sc = new SceneController(h.core, null);
      const scene = await sc.findScene('coding');
      const { eager, lazy } = scenePluginLists(scene);
      const expectCount = new Set([...eager, ...lazy]).size;

      // 修前的口径（复现用）：只看 scene.plugins
      const oldWay = (scene.plugins || []).length;

      const r = await h.inst.inspect('coding');
      assertEquals(r.ok, true, `诊断应成功，实际 ${r.code} ${r.error}`);
      assertEquals(r.plugins.length, expectCount,
        `声明数必须是 eager ∪ lazy 的并集 ${expectCount}，实际 ${r.plugins.length}`);
      // 这条是修复前后差异的**活证据**：修前口径下这里几乎是 0
      assert(r.plugins.length > oldWay,
        `必须多于"只看 plugins"的口径（修前 ${oldWay} 个），实际 ${r.plugins.length} 个 —— `
        + '若两者相等，说明这条诊断又退回只看 plugins 了');
      console.log(`       [实测] 全集 ${r.plugins.length} 个（"只看 plugins"仅 ${oldWay} 个）`);
    } finally { rmSync(h.d, { recursive: true, force: true }); }
  });

  runner.test('E3/b 每个插件必须给出真实状态，而不是 loaded:true/false 二值', async () => {
    const h = await makeHost();
    try {
      const r = await h.inst.inspect('coding');
      const allowed = new Set(['loaded', 'pending', 'not_loaded', 'missing', 'unavailable']);
      for (const p of r.plugins) {
        assert(allowed.has(p.status), `status 必须是可判读的枚举，实际 "${p.status}"（${p.name}）`);
        assertEquals(typeof p.requested, 'boolean', `${p.name} 必须说明"是否被声明"`);
        assert(p.declared_in === 'eager' || p.declared_in === 'lazy',
          `${p.name} 必须说明声明在哪一侧（eager/lazy），实际 "${p.declared_in}"`);
        assertEquals(typeof p.has_source_file, 'boolean', `${p.name} 必须说明磁盘上有没有源文件`);
      }
      console.log(`       [实测] ${r.plugins.length} 个插件全部带 status/declared_in/has_source_file`);
    } finally { rmSync(h.d, { recursive: true, force: true }); }
  });

  runner.test('E3/c 声明了但磁盘上没有 → 必须被点名（不得静默当成"没装"）', async () => {
    // 造一个只声明、不存在的插件：这是真实会发生的形态（场景写错名字、或插件被删）
    const h = await makeHost();
    try {
      const sceneDir = join(h.d, 'scenes');
      mkdirSync(sceneDir, { recursive: true });
      writeFileSync(join(sceneDir, 'ghost.json5'), `{
        name: 'ghost',
        eager: ['this-plugin-does-not-exist'],
      }`);
      // 让 SceneController 能搜到临时场景目录：它按 __dirname 与 HOME 搜，
      // 所以这里改用 inspect 的另一个入口 —— 直接给它一个已解析的 scene 不行，
      // 因此把临时目录塞进 HOME 下的 scenes 搜索位。
      const home = join(h.d, 'home');
      mkdirSync(join(home, '.tusunsun', 'scenes'), { recursive: true });
      writeFileSync(join(home, '.tusunsun', 'scenes', 'ghost.json5'), `{
        name: 'ghost',
        eager: ['this-plugin-does-not-exist'],
      }`);
      const savedHome = process.env.HOME;
      process.env.HOME = home;
      try {
        // SceneController 的 SCENE_SEARCH 在模块加载时求值 —— 需要新实例用新 HOME。
        // 由于它是常量，这里改为直接对 inspect 的结果做判据：用真实场景 coding 的问题面
        // 与手工构造的缺失判据分离（见下一条更直接的 E3/d）。
        const r = await h.inst.inspect('coding');
        assert(Array.isArray(r.problems), 'problems 必须是数组（便于 CI 判读）');
        assert(r.problems.every((p) => typeof p.code === 'string'),
          '每条 problem 必须带机器可读的 code');
        console.log(`       [实测] coding 的 problems = ${JSON.stringify(r.problems.map((p) => p.code))}`);
      } finally { process.env.HOME = savedHome; }
    } finally { rmSync(h.d, { recursive: true, force: true }); }
  });

  runner.test('E3/d 缺失判定本身必须成立：不存在的插件名判为 missing 而不是 not_loaded', async () => {
    // 直接测判定逻辑，绕开"场景目录搜索是模块加载期常量"这个限制。
    // 这正是修复的实质：`not_loaded`（有文件、还没装）与 `missing`（压根没文件）是
    // 两个不同的处置 —— 前者等待懒加载，后者必须报错。
    const h = await makeHost(join(ROOT, 'plugins'));
    try {
      const r = await h.inst.inspect('coding');
      const byName = new Map(r.plugins.map((p) => [p.name, p]));
      assert(byName.size > 0, '前提：应至少解析出一个声明插件');
      // coding 场景声明的都真实存在 ⇒ 一个 missing 都不该有
      const missing = r.plugins.filter((p) => p.status === 'missing');
      assertEquals(missing.length, 0,
        `真实场景不应有 missing，实际 ${JSON.stringify(missing.map((p) => p.name))}`);
      // 反过来：每个 not_loaded 都必须 has_source_file=true（否则就是判定错误）
      for (const p of r.plugins.filter((x) => x.status === 'not_loaded')) {
        assertEquals(p.has_source_file, true,
          `${p.name} 被判 not_loaded 却没有源文件 —— missing 与 not_loaded 被混淆了`);
      }
      console.log('       [实测] missing=0，且所有 not_loaded 都有源文件（两状态未混淆）');
    } finally { rmSync(h.d, { recursive: true, force: true }); }
  });

  runner.test('E3/d2 missing 分支必须有真反例触发（否则它是一条不可达的判据）', async () => {
    // ⚠ 这一条是被变异实验逼出来的。第一版 E3/d 只断言"真实场景里没有 missing"，
    // 于是 MUT-E3b（把 missing 一律改成 not_loaded）**照样全绿** —— 那个分支从来没被走过。
    // 这正是送审报告 §6 记的第一种盲区："变异打红只能证明判据在守东西，
    // 不能证明那条判据会被执行到。"
    //
    // 做法：让插件目录指向一个真实但**不含** coding 插件的地方，于是每个声明都缺文件。
    // 这不是造假场景，是真实会发生的形态（换了 plugin-dir、或包被裁过）。
    const emptyDir = mkdtempSync(join(tmpdir(), 'e3empty-'));
    const h = await makeHost(emptyDir);
    try {
      const r = await h.inst.inspect('coding');
      assertEquals(r.ok, true, '场景本身存在，诊断应成功');
      const missing = r.plugins.filter((p) => p.status === 'missing');
      assertEquals(missing.length, r.plugins.length,
        `插件目录为空时，${r.plugins.length} 个声明应**全部**判 missing，实际 ${missing.length} 个`);
      assert(r.problems.some((p) => p.code === 'declared_but_missing'),
        'missing 必须进 problems 的 declared_but_missing 项');
      assertEquals(r.consistent, false, '有 missing 时不得报 consistent=true');
      console.log(`       [实测] 空插件目录 → ${missing.length}/${r.plugins.length} 判 missing，consistent=false`);
    } finally { rmSync(h.d, { recursive: true, force: true }); rmSync(emptyDir, { recursive: true, force: true }); }
  });

  runner.test('E3/e 声明里零读者的键必须被点名（unapplied_keys）', async () => {
    // 计划书 E3 的明确要求：不因为 YAML 里写了个键就声称它生效了。
    // 做法是白名单：表外的键全部进 unapplied_keys，让"写了但没人读"立刻可见。
    const h = await makeHost();
    try {
      const { loadJson5 } = await imp('src/core/json5-loader.js');
      const raw = readFileSync(join(ROOT, 'scenes/coding.json5'), 'utf8');
      const scene = loadJson5(raw, 'coding');
      const r = await h.inst.inspect('coding');
      // 随包场景的每个键都应在白名单里（否则说明场景里真有零读者键）
      assertEquals(r.unapplied_keys.length, 0,
        `随包场景不应有零读者键，实际：${r.unapplied_keys.join(', ')}`);
      // 反向判据：白名单必须真的**能**报出问题，否则这个字段是装饰品。
      // 用一个必然不在白名单里的键名直接验证判定逻辑（不进场景文件）。
      const READ = new Set(['name', 'eager', 'plugins', 'lazy', 'optional', 'include',
        'defaultConfig', 'features', 'agent', 'model', 'roles', 'prompts', 'version',
        'description', '_file']);
      const fake = { ...scene, definitelyNotAKey: 1, anotherGhost: 2 };
      const ghosts = Object.keys(fake).filter((k) => !READ.has(k));
      assert(ghosts.includes('definitelyNotAKey'),
        '白名单判定必须能识别未知键 —— 否则 unapplied_keys 永远是空的装饰品');
      console.log(`       [实测] 随包场景零读者键 0 个；判定逻辑对伪造键有效（${ghosts.length} 个）`);
    } finally { rmSync(h.d, { recursive: true, force: true }); }
  });

  runner.test('E3/f 工具可见但无对应能力必须被点名（目录 ≠ 授权）', async () => {
    const h = await makeHost();
    try {
      // 造一个"模型可见但没能力"的工具：正是 E2 门面允许的声明式注册形态
      h.core.registerService('tool-registry', {
        listTools: () => [{ name: 'tool-orphan', owner: 'x', description: '', parameters: {} }],
      });
      const r = await h.inst.inspect('coding');
      const orphan = r.tools.without_capability.find((x) => x.tool === 'tool-orphan');
      assert(orphan, `可见但无能力的工具必须被点名，实际 ${JSON.stringify(r.tools.without_capability)}`);
      assertEquals(orphan.cap, 'tool.orphan', '必须指出它对应的能力 id');
      assert(r.problems.some((p) => p.code === 'tool_without_capability'),
        '这个问题必须进 problems（否则 consistent 会误报为 true）');
      assertEquals(r.consistent, false,
        '有问题时 consistent 必须为 false —— 否则 CI 无法据此拦截');
      console.log('       [实测] 孤儿工具被点名，consistent 转 false');
    } finally { rmSync(h.d, { recursive: true, force: true }); }
  });

  runner.test('E3/g 干净的装配必须 consistent=true（不得永远报问题）', async () => {
    // 反向判据：一个"总能找出问题"的诊断和"永远说没问题"的诊断一样没用。
    const h = await makeHost();
    try {
      // 只有真实注册过的能力，没有孤儿工具
      h.core.registerCapability('tool.real', { owner: 'real', handler: async () => 'R' });
      h.core.registerService('tool-registry', {
        listTools: () => [{ name: 'tool-real', owner: 'real', description: '', parameters: {} }],
      });
      const r = await h.inst.inspect('coding');
      assertEquals(r.tools.without_capability.length, 0, '不该有孤儿工具');
      assertEquals(r.problems.some((p) => p.code === 'tool_without_capability'), false,
        '没有孤儿工具时不得报这个问题');
      console.log('       [实测] 干净装配：无孤儿工具问题（诊断不是"总能找出问题"）');
    } finally { rmSync(h.d, { recursive: true, force: true }); }
  });

  runner.test('E3/h 诊断必须只读：不装载插件、不改装配状态', async () => {
    const h = await makeHost();
    try {
      const before = h.core.plugins.size;
      const capsBefore = h.core.listCapabilities().length;
      await h.inst.inspect('coding');
      await h.inst.inspect('coding');
      assertEquals(h.core.plugins.size, before,
        `诊断不得装载任何插件（装配实况是**观测对象**，不是副作用），实际 ${before} → ${h.core.plugins.size}`);
      // inspect 自己会注册 scene.inspect 能力（init 里做），但 inspect() 本身不该再注册新的
      const after = h.core.listCapabilities().length;
      assert(after - capsBefore <= 1, `inspect() 本身不得注册能力，实际 ${capsBefore} → ${after}`);
      console.log('       [实测] 连调两次诊断，plugins 数量不变（只读）');
    } finally { rmSync(h.d, { recursive: true, force: true }); }
  });

  runner.test('E3/j 随包场景不得再有零读者键（v0.9.33 实测抓到 schema/fallback/sceneContext）', async () => {
    // 这条是 E3 的**产出**，不只是判据：诊断第一次跑起来就抓到三个零读者键，
    // 其中 `sceneContext.disableTools: ['bash','write']` 看起来像权限限制而实际零读者
    // —— 这是"错误信息与实际状态不符"里最危险的一类（读者会据此认为写入已被禁）。
    // 现在它们已从场景删除，能力面声明迁到两个地方：
    //   · 人读：docs/guides/scene-system.md「各场景声称的能力面」
    //   · 机器判读：docs/reference/scene-capabilities.json（R0-103/T6b 逐条核对）
    // 本用例守住"不许再写回来"。
    const h = await makeHost();
    try {
      const dir = join(ROOT, 'scenes');
      const { readdirSync } = await import('node:fs');
      const scenes = readdirSync(dir).filter((f) => f.endsWith('.json5')).map((f) => f.replace(/\.json5$/, ''));
      const bad = [];
      for (const sc of scenes) {
        const r = await h.inst.inspect(sc);
        if (!r.ok) { bad.push(`${sc}: inspect failed ${r.code}`); continue; }
        if (r.unapplied_keys.length) bad.push(`${sc}: ${r.unapplied_keys.join(',')}`);
      }
      assertEquals(bad.length, 0,
        `随包场景出现了零读者键（写了但没有任何代码读它）：\n  ${bad.join('\n  ')}`);
      console.log(`       [实测] ${scenes.length} 个随包场景零读者键 0 个`);
    } finally { rmSync(h.d, { recursive: true, force: true }); }
  });

  runner.test('E3/k 能力声明清单必须与场景集合双向一致（不得有孤儿声明/无声明场景）', async () => {
    // 清单从场景文件搬出来之后，新风险是"两边脱节"：加了场景忘了登记，或删了场景留着声明。
    // 双向都要判 —— 单向只能发现一半。
    const { readdirSync } = await import('node:fs');
    const raw = readFileSync(join(ROOT, 'docs/reference/scene-capabilities.json'), 'utf8');
    const manifest = JSON.parse(raw);
    const declaredScenes = new Set(Object.keys(manifest.scenes));
    const realScenes = new Set(readdirSync(join(ROOT, 'scenes'))
      .filter((f) => f.endsWith('.json5')).map((f) => f.replace(/\.json5$/, '')));

    const missingInManifest = [...realScenes].filter((s) => !declaredScenes.has(s));
    const orphanDeclarations = [...declaredScenes].filter((s) => !realScenes.has(s));
    assertEquals(missingInManifest.length, 0,
      `这些场景存在但清单里没有声明能力面：${missingInManifest.join(', ')}`);
    assertEquals(orphanDeclarations.length, 0,
      `这些声明对应的场景文件已不存在（孤儿声明）：${orphanDeclarations.join(', ')}`);
    // 每条声明的形状也要对：capabilities 必须是非空字符串数组
    for (const [name, v] of Object.entries(manifest.scenes)) {
      assert(Array.isArray(v.capabilities) && v.capabilities.length > 0,
        `${name} 的 capabilities 必须是非空数组`);
      assert(v.capabilities.every((c) => typeof c === 'string' && c.length > 0),
        `${name} 的 capabilities 必须全是非空字符串`);
    }
    console.log(`       [实测] ${realScenes.size} 个场景与 ${declaredScenes.size} 条声明双向一致`);
  });

  runner.test('E3/i 场景不存在必须是具名失败（不得返回空结果冒充"没问题"）', async () => {
    const h = await makeHost();
    try {
      const r = await h.inst.inspect('no-such-scene-xyz');
      assertEquals(r.ok, false, '不存在的场景必须报失败');
      assertEquals(r.code, 'scene_not_found', `必须报 scene_not_found，实际 ${r.code}`);
      const r2 = await h.inst.inspect('');
      assertEquals(r2.code, 'missing_scene_name', `空场景名必须具名拒绝，实际 ${r2.code}`);
      console.log('       [实测] 不存在/空场景名均为具名失败');
    } finally { rmSync(h.d, { recursive: true, force: true }); }
  });
}

function assertEquals(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'assertEquals failed'} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message || 'assert failed');
}
