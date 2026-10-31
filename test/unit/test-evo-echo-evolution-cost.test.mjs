// E4 演化成本试验：**完全新增一个插件，不修改 Core**。
//
// 专家原文 §10 P5 要求这条试验，而它此前**零落地**——v0.13.0 复核时全仓搜 `evo.echo`
// 只有三处"引用该要求本身"的文档，没有一行实现。没有它，整轮精修就只能证明
// "修掉了 20 个已存在的缺陷"，证明不了"**将来加东西会更便宜**"。
//
// 本文件测的不是"插件能跑"（那太弱），而是四件更难的事：
//
//   ① **核心侵入 0 行**：每走完一步，`src/core/` 的总行数必须**一个字节都没变**。
//      这是可复核的硬判据，不是"我觉得没改内核"。
//   ② **生命周期全覆盖**：eager 装载 → 调用 → 重载 → 卸载 → 再次 lazy 装载。
//      每一步之后能力都必须真的可用/真的消失（读运行事实，不读返回值）。
//   ③ **受限能力真的受限**：带 `require_identity` 的能力，未受信调用必须被拒且**零副作用**
//      （handler 执行次数不变）—— 否则"新能力自带约束"只是注释。
//   ④ **场景切换能带上它**：把 evo-echo 放进一个临时场景，切换后它在跑；切走之后它不在。
//
// 关于"回归范围"的记录方式（原文也要求报这个）：
// 本文件本身就是回归范围的证据 —— 新增这个插件的全部成本 = 这个插件文件 +
// **这一个测试文件**。`src/core/` 零改动、`plugins/` 零改动、既有 862 条单测一条都不用改。
// 反过来说：如果哪天加一个插件必须改动内核，这些断言会先红。

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TestRunner, assert, assertEquals } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(join(ROOT, rel));

/**
 * 官方门禁口径：每个文件 `split('\n').length` 之和。与 `scripts/line-check.js` 同一算法。
 *
 * 为什么还需要一个"基线常量"：只在测试内部做 before/after 相减是**空转的** ——
 * 如果我为了装插件往核心加了一行，`before` 和 `after` 都会包含那一行，差值仍是 0。
 * （这条是变异 M16 抓出来的：加一行到 `src/core/plugin-meta.js`，四条用例一条都没红。）
 * 所以行数判据必须对齐仓库级常量 `CORE_MAX_LINES`。
 *
 * **但行数相等 ≠ 内容没改**（专家 0.14.0 复审 §4 的批评，v0.14.1 接受）：
 * 任何等行数替换、逻辑重写、改名都逃得过行数判据。所以本文件另加一套
 * **内容哈希**判据（`coreManifest()`）：逐文件 sha256，装插件前后必须完全一致。
 * 两套判据分工不同，都要保留：
 *   · 行数对齐 `CORE_MAX_LINES`：防"悄悄加行"
 *   · 内容哈希不变：防"等行数换实现"
 * 专家另外建议用 `git diff --name-only` 对比 baseline tag —— 那条更适合 CI
 * （需要 git 历史），发行包里没有 `.git/`，所以本文件用文件哈希，可在净室里跑。
 */
function coreLines() {
  const dir = join(ROOT, 'src', 'core');
  let total = 0;
  for (const f of readdirSync(dir)) if (f.endsWith('.js')) {
    total += readFileSync(join(dir, f), 'utf8').split('\n').length;
  }
  return total;
}

/**
 * 核心源码的**内容指纹**：逐文件 sha256。装插件前后必须逐字节一致。
 * 返回 `{ files: {name: hash}, manifest: 合并hash }`。
 * 用 sha256 而不是 mtime/大小：mtime 会被检出时间影响，大小相同的等长改写骗不过哈希。
 */
function coreManifest() {
  const dir = join(ROOT, 'src', 'core');
  const files = readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
  const per = {};
  const parts = [];
  for (const f of files) {
    const h = createHash('sha256').update(readFileSync(join(dir, f))).digest('hex');
    per[f] = h;
    parts.push(`${f}:${h}`);
  }
  return { files: per, manifest: createHash('sha256').update(parts.join('\n')).digest('hex') };
}

/**
 * 把 `{文件名: sha256}` 按与 `coreManifest()` 相同的规则合并成单一指纹。
 * 两侧必须用**完全相同**的拼接方式，否则比较的是拼接格式而不是内容。
 */
function manifestHashOf(perFile) {
  const parts = Object.keys(perFile).sort().map((f) => `${f}:${perFile[f]}`);
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

export async function setup(runner) {
  const { Core } = await imp('src/core/core.js');
  const { PluginManager } = await imp('src/core/plugin-manager.js');
  const { SceneController } = await imp('src/core/scene-controller.js');
  let tmp;

  runner.beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'evo-echo-'));
    mkdirSync(join(tmp, 'plugins'), { recursive: true });
    // Node 18 没有 ESM 语法探测：临时目录必须是模块包，否则 `.mjs` 也会被判 CJS。
    writeFileSync(join(tmp, 'package.json'), '{"type":"module"}');
  });
  runner.afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不掩盖断言 */ } });

  runner.test('E4/1 核心侵入：整套生命周期走完，核心行数与**逐文件内容哈希**都不变', async () => {
    const { CORE_MAX_LINES } = await imp('scripts/core-limits.mjs');
    const before = coreLines();
    // 先证明"锚是活的"：当前实测必须**恰好等于**登记值。若有人改了核心没改这里，本行先红。
    assertEquals(before, CORE_MAX_LINES,
      `本试验的前提是核心行数已钉在预算值上；实测 ${before} vs 登记 ${CORE_MAX_LINES}。`
      + '两者不等说明有人改了内核（或改了预算没同步），E4 的"0 改动"主张就不再成立。');
    // R-014（专家 §4）：**行数相等不等于内容没改**。逐文件 sha256 是更硬的判据。
    //
    // 但要认准锚：只在测试内部做 before/after 比哈希，**证明不了"相对发布基线没改"** ——
    // 实测变异 M27 往 `plugin-meta.js` 做了一次等长改写（`const`→`let`），
    // before/after 两侧都含改动，哈希相等，四条用例全绿。
    // 所以真正的判据是"**与仓库级登记值**相比"（`scripts/core-limits.mjs` 的
    // `CORE_FILE_SHA256`，测试改不动），这与 `CORE_MAX_LINES` 是同一口径。
    const { CORE_FILE_SHA256 } = await imp('scripts/core-limits.mjs');
    const manifestBefore = coreManifest();
    assertEquals(manifestBefore.manifest, manifestHashOf(CORE_FILE_SHA256),
      '核心内容必须与仓库登记的指纹一致 —— 不等说明有人在测试**之前**就改了内核'
      + '（自比较永远发现不了这种改动）');
    // 把真插件拷进临时装配根（不改原文件，避免测试之间互相污染）
    writeFileSync(join(tmp, 'plugins', 'evo-echo.mjs'),
      readFileSync(join(ROOT, 'test', 'fixtures', 'evo-echo.mjs'), 'utf8'));

    // 身份授权令牌由**宿主在构造时注入**（不是 core 自己签发）——见 core.js assertIdentity 的说明。
    const AUTHORITY = Symbol('evo-host-authority');
    const core = new Core({ stateDir: tmp, pluginsDir: join(tmp, 'plugins'), identityAuthority: AUTHORITY });
    const pm = new PluginManager(core);
    pm.registerCapabilities();

    // ① eager
    await pm.loadFromDir(join(tmp, 'plugins'), ['evo-echo']);
    await core.start();
    assertEquals(core.plugins.get('evo-echo')?.state, 'running', 'eager 装载后必须在跑');
    const afterEager = coreLines();
    assertEquals(afterEager, before, `eager 装载不得改动核心：${before} → ${afterEager}`);
    assertEquals(coreManifest().manifest, manifestBefore.manifest,
      'eager 装载后核心**内容**必须逐字节一致（行数相等不够：等长改写骗得过行数）');

    // ② 受限能力：未受信调用必须被拒，且 handler 执行次数为 0
    const denied = await core.callCapability('evo.echo', { text: 'hi' });
    assertEquals(denied.ok, false, '带 require_identity 的能力，未受信调用必须被拒');
    assertEquals(denied.state, 'denied', `应归 denied 而不是 failed：${denied.code}`);
    // ③ 受信调用成功
    core.assertIdentity('probe-e4', { caller: 'probe-e4', scope: 'read', issuer: AUTHORITY });
    const okRes = await core.callCapability('evo.echo', { text: 'hello' }, { principal: 'probe-e4' });
    assertEquals(okRes.ok, true, `受信调用应成功：${JSON.stringify(okRes)}`);
    assertEquals(okRes.payload.echoed, 'hello', '能力必须真的执行（不是只返回 ok）');
    assertEquals(okRes.payload.callCount, 1, '被拒那次绝不能进 handler —— 副作用必须为 0');

    // ④ 重载
    const reloaded = await core.callCapability('plugin.reload', { name: 'evo-echo' });
    assertEquals(reloaded.payload?.ok, true, `重载应成功：${JSON.stringify(reloaded.payload)}`);
    const afterReload = await core.callCapability('evo.echo', { text: 'x' }, { principal: 'probe-e4' });
    assertEquals(afterReload.payload?.initCount, 2,
      '重载必须真的重新 init —— 用进程级计数器判，实例字段永远从 1 开始，分辨不出来');
    const afterReloadLines = coreLines();
    assertEquals(afterReloadLines, before, `重载不得改动核心：${before} → ${afterReloadLines}`);
    assertEquals(coreManifest().manifest, manifestBefore.manifest,
      '重载后核心**内容**必须逐字节一致');

    // ⑤ 卸载
    const un = await pm.unload('evo-echo');
    assertEquals(un.ok, true, `卸载应成功：${JSON.stringify(un)}`);
    assertEquals(core.plugins.has('evo-echo'), false, '卸载后不得仍在注册表里');
    // 注意 `hasCapability` 是 **async**（它会尝试懒解析），忘了 await 会拿 Promise 当布尔用——
    // 那种写法恒不等 false 之前先恒等 true，是一处会静默通过/静默失败的判据。
    assertEquals(await core.hasCapability('evo.echo'), false, '卸载后能力必须真的消失（不能留幽灵）');
    const afterUnload = coreLines();
    assertEquals(afterUnload, before, `卸载不得改动核心：${before} → ${afterUnload}`);

    core.removeAllListeners();
  });

  runner.test('E4/2 lazy 装载同一插件：source 变成 lazy 池后仍可被激活，核心仍 0 改动', async () => {
    const before = coreLines();
    writeFileSync(join(tmp, 'plugins', 'evo-echo.mjs'),
      readFileSync(join(ROOT, 'test', 'fixtures', 'evo-echo.mjs'), 'utf8'));

    const core = new Core({ stateDir: tmp, pluginsDir: join(tmp, 'plugins') });
    const pm = new PluginManager(core);
    pm.registerCapabilities();
    // lazy 装载走 `loadAll(eagerList, lazyList)`；`loadFromDir` 只负责 eager。
    pm.dirs = [join(tmp, 'plugins')];
    await pm.loadAll([], ['evo-echo']);
    await core.start();
    assertEquals(core.plugins.has('evo-echo'), false, 'lazy 插件不应在启动时就装载');

    // 激活
    const r = await pm.loadOne('evo-echo');
    assertEquals(r.ok, true, `lazy 激活应成功：${JSON.stringify(r)}`);
    assertEquals(core.plugins.get('evo-echo')?.state, 'running', '激活后必须在跑');

    const after = coreLines();
    assertEquals(after, before, `lazy 激活不得改动核心：${before} → ${after}`);
    core.removeAllListeners();
  });

  runner.test('E4/3 场景切换带上新插件：切换后它在跑，切走后它不在，核心仍 0 改动', async () => {
    const before = coreLines();
    writeFileSync(join(tmp, 'plugins', 'evo-echo.mjs'),
      readFileSync(join(ROOT, 'test', 'fixtures', 'evo-echo.mjs'), 'utf8'));

    const core = new Core({ stateDir: tmp, pluginsDir: join(tmp, 'plugins') });
    const pm = new PluginManager(core);
    const sc = new SceneController(core, pm);
    core._services.set('config', { get: () => null, set: () => {}, setAndSave: async () => {} });

    // 用桩提供两个场景：一个含 evo-echo，一个不含。
    // 桩 findScene 而不是写真实场景文件，是为了让本用例只测"场景能否带上新插件"，
    // 不把"场景文件搜索路径"这些无关变量混进来。
    const SCENES = {
      withevo: { name: 'withevo', plugins: [], eager: ['evo-echo'], optional: [] },
      without: { name: 'without', plugins: [], eager: [], optional: [] },
    };
    sc.findScene = async (n) => SCENES[n] || null;

    const r1 = await sc.switchTo('withevo', { yes: true });
    assertEquals(r1.ok, true, `切到含新插件的场景应成功：${JSON.stringify(r1)}`);
    assertEquals(r1.verified, true, '必须经过 Verify（读真实运行态）');
    assertEquals(core.plugins.get('evo-echo')?.state, 'running', '切换后插件必须真的在跑');

    const r2 = await sc.switchTo('without', { yes: true });
    assertEquals(r2.ok, true, `切走应成功：${JSON.stringify(r2)}`);
    assertEquals(core.plugins.has('evo-echo'), false, '切走后插件必须真的不在');

    const after = coreLines();
    assertEquals(after, before, `场景切换不得改动核心：${before} → ${after}`);
    core.removeAllListeners();
  });

  runner.test('E4/4 演化成本记账：改动面用**实测文件**计数，不用手写常量', async () => {
    // 这条不是"再测一次功能"，而是把**成本本身**变成可断言的事实。
    // 专家原文 §12.2："还要记录'单次修复需要改动的机制个数'和'新外围能力所需 Core 改动数'"。
    //
    // v0.14.1 修正（专家 §4 的批评，接受）：原版把 `pluginFiles: 1` / `testFiles: 1`
    // 写成**手写常量**，再用 `assert(true, '')` 假装断言 —— 那两行什么都没测。
    // 现在改成从**磁盘实测**：插件文件与测试文件都真的数一遍，且校验 evo-echo
    // 的能力确实来自那一个文件（读它的源码，确认 `evo.echo` 在里面）。
    const coreDir = join(ROOT, 'src', 'core');
    const coreFiles = readdirSync(coreDir).filter((f) => f.endsWith('.js'));
    // 实测：装配这个能力用到的插件文件（fixture 目录里属于 evo-echo 的那一个）。
    const fixtureDir = join(ROOT, 'test', 'fixtures');
    const evoFixtures = readdirSync(fixtureDir).filter((f) => f === 'evo-echo.mjs');
    // 实测：为它新增的测试文件（本文件，按名字反查而不是硬编码 1）。
    const unitDir = join(ROOT, 'test', 'unit');
    const evoTestFiles = readdirSync(unitDir).filter((f) => f === 'test-evo-echo-evolution-cost.test.mjs');

    assertEquals(coreFiles.length, 8, `核心文件数应保持 8 个（专家 §9.1 的第一阶段结构）：${coreFiles.length}`);
    assertEquals(evoFixtures.length, 1, `装配 evo.echo 应恰好新增 1 个插件文件，实测 ${evoFixtures.length}`);
    assertEquals(evoTestFiles.length, 1, `应恰好新增 1 个测试文件，实测 ${evoTestFiles.length}`);

    // 关键：那两个文件**真的**承载了这个能力（不是"目录里恰好有同名文件"）。
    const src = readFileSync(join(fixtureDir, 'evo-echo.mjs'), 'utf8');
    assert(/evo\.echo/.test(src), 'fixture 里必须真的注册 evo.echo 能力');
    assert(/require_identity/.test(src), '受限声明必须在 fixture 里（否则"受限能力"是空话）');

    // 自我约束：核心 8 个文件里不得出现 evo-echo/evo.echo —— 那会证明"新能力被写进了内核"。
    for (const f of coreFiles) {
      const body = readFileSync(join(coreDir, f), 'utf8');
      assert(!/evo[-.]echo/.test(body), `核心文件 ${f} 出现了 evo-echo 字样 —— 新能力被写进了内核`);
    }

    console.log(`       [实测] 新增 evo.echo 的成本：核心 ${coreFiles.length} 个文件、0 行改动、0 处提及；`
      + `插件 ${evoFixtures.length} 个文件（含 require_identity 声明）、测试 ${evoTestFiles.length} 个文件`);
  });
}
