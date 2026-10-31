// rc.26：专家 K24 §6-C「代码去重」——同一个决定被写两遍的三处收口，每条都先红后绿。
//
// 与"删几行"无关：这里守的是**只有一个写者**。抽公共函数时最容易发生的退化是
// "两份实现变成两份调用"，所以每条都配一个等价断言，证明可观察行为没变。
//
//   A  plugin-manager.js 里 `_resetLazyState` 被定义两次（rc.24 引入），后一个静默覆盖前一个
//   B  `loadAll()` 无参（无场景启动，cli.js 的 fallback）走的 legacy 链漏写 `_pluginFilePaths`
//      ⇒ 那条路径上 `plugin.reload` 永远返回 no_source_path
//   C  eager 与 legacy 两条链对同一批文件必须产出同一结果（`__source` / 注册集合 / `_loaded`）
//   D  拓扑应用抽成 `_applyTopology` 之后：依赖在前、未列出者保留、已缺席者被容忍
//   E  同实现去重与重名跳过没有在抽公共函数时丢掉（`_dedupSkipped` 记账、`_loaded` 不重名）
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { TestRunner, assert, assertEquals } from '../harness.mjs';
import { releasedRowConflict, releasedRowMessage } from '../../scripts/lib/line-doc-history.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(join(ROOT, rel));

function tempDir(tag) {
  return mkdtempSync(join(tmpdir(), `rc26-${tag}-`));
}

/** 最小 core 桩：`register` 复刻 Core 的"同名具名跳过"（返回 false，不覆盖）。 */
function stubCore() {
  const plugins = new Map();
  const facts = [];
  return {
    plugins,
    facts,
    lifecycle: { unload: async () => ({ ok: true, released: true }) },
    get: () => undefined,
    log() {},
    emitFact: (type, payload) => facts.push({ type, payload }),
    getService: () => null,
    registerCapability() {},
    async register(plugin) {
      if (plugins.has(plugin.name)) return false;
      plugins.set(plugin.name, plugin);
      return true;
    },
  };
}

/** 写一个**对象字面量风格**插件（eager 链接受这种形态；懒索引才要求类字段风格）。 */
function writePlugin(dir, name, requires = []) {
  const file = join(dir, `${name}.mjs`);
  writeFileSync(file, [
    'export default {',
    `  name: '${name}',`,
    `  requires: ${JSON.stringify(requires.length ? Object.fromEntries(requires.map((r) => [r, '*'])) : {})},`,
    '  provides: [],',
    '  async init() {},',
    '  async stop() {},',
    '};',
    '',
  ].join('\n'));
  return file;
}

const newPm = async (core) => new (await imp('src/core/plugin-manager.js')).PluginManager(core);

// ── 静态检查：类内不得有重名方法 ───────────────────────────────────────
// 可观察行为上"后一个覆盖前一个"与"只有一个"完全一样 —— 所以这条缺陷没有行为反例，
// 只能静态守。这也是它值得一条测试的理由：它永远不会自己暴露。
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'do', 'try', 'with']);

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}

/** 顶格 2 空格的方法头（形参可跨行，函数体可单行 —— 单行体正是最容易漏掉的那种重复）。 */
function methodNames(src) {
  const names = [];
  const re = /^ {2}(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm;
  for (const m of stripComments(src).matchAll(re)) {
    if (!KEYWORDS.has(m[1])) names.push(m[1]);
  }
  return names;
}

export async function setup(runner) {
  // ── A：核心类内重名方法 ────────────────────────────────────────────
  runner.test('rc.26/A src/core 的每个类都不许有重名方法（rc.24 的 _resetLazyState 定义过两次）', () => {
    const dir = join(ROOT, 'src/core');
    const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
    const offenders = [];
    for (const f of files) {
      const seen = new Map();
      for (const name of methodNames(readFileSync(join(dir, f), 'utf8'))) {
        seen.set(name, (seen.get(name) || 0) + 1);
      }
      for (const [name, count] of seen) {
        if (count > 1) offenders.push(`${f}: ${name} ×${count}`);
      }
    }
    assertEquals(offenders.join(','), '', `核心类内出现重名方法（后者静默覆盖前者）：${offenders.join(' | ')}`);
  });

  // ── B：无场景启动也要登记来源路径 ──────────────────────────────────
  runner.test('rc.26/B loadAll() 无参（legacy 链）必须登记 _pluginFilePaths，否则 plugin.reload 永久不可用', async () => {
    const base = tempDir('b');
    const dir = join(base, 'plugins');
    mkdirSync(dir, { recursive: true });
    const file = writePlugin(dir, 'legacyonly');

    const core = stubCore();
    const pm = await newPm(core);
    pm.dirs.push(dir);
    // 修前：`_loadFromDirLegacy` 自己写了一遍导入/登记链，唯独漏了 `_pluginFilePaths.set`
    // ⇒ 这里 undefined，`plugin.reload` 报 no_source_path（cli.js:139 就是这条路径）。
    await pm.loadAll();
    try {
      assertEquals(pm._pluginFilePaths.get('legacyonly'), file, 'legacy 链必须登记来源路径');
      assert(core.plugins.has('legacyonly'), 'legacy 链必须完成注册');
      assertEquals(pm._loaded.length, 1, '_loaded 必须只记一条');
      assertEquals(pm._loaded[0].__source, file, '__source 必须指向真实文件');

      // 反控：这条 map 不能是"查谁都返回真"——没装过的名字必须查不到。
      assertEquals(pm._pluginFilePaths.get('never-loaded'), undefined, '未装载的名字不得有来源路径');
    } finally {
      pm._stopIdleTimer();
      rmSync(base, { recursive: true, force: true });
    }
  });

  // ── C：两条链对同一批文件等价 ──────────────────────────────────────
  runner.test('rc.26/C eager 链与 legacy 链对同一批文件必须产出同一注册集合与同一 __source', async () => {
    const base = tempDir('c');
    const dir = join(base, 'plugins');
    mkdirSync(dir, { recursive: true });
    const names = ['alpha', 'beta'];
    const files = names.map((n) => writePlugin(dir, n));

    const coreA = stubCore();
    const pmA = await newPm(coreA);
    await pmA.loadFromDir(dir);                       // → _loadEagerPlugin

    const coreB = stubCore();
    const pmB = await newPm(coreB);
    pmB.dirs.push(dir);
    await pmB.loadAll();                              // → _loadFromDirLegacy

    try {
      // eager 链按 readdir 顺序装；legacy 链同序。集合与来源必须逐项一致。
      assertEquals([...coreA.plugins.keys()].sort().join(','), [...coreB.plugins.keys()].sort().join(','),
        '两条链的注册集合必须相同');
      for (const n of names) {
        const file = files[names.indexOf(n)];
        assertEquals(coreA.plugins.get(n).__source, coreB.plugins.get(n).__source, `${n}: __source 必须一致`);
        assertEquals(coreA.plugins.get(n).__source, file, `${n}: __source 必须指向真实文件`);
        assertEquals(pmA._pluginFilePaths.get(n), pmB._pluginFilePaths.get(n), `${n}: 来源路径登记必须一致`);
      }
      assertEquals(pmA._loaded.length, pmB._loaded.length, '两条链的 _loaded 长度必须相同');
    } finally {
      pmA._stopIdleTimer(); pmB._stopIdleTimer();
      rmSync(base, { recursive: true, force: true });
    }
  });

  // ── D：拓扑应用（抽出来的那一份）────────────────────────────────────
  runner.test('rc.26/D _applyTopology：依赖在前、未列出者保留、已缺席者被容忍', async () => {
    const core = stubCore();
    const pm = await newPm(core);
    const mk = (name) => ({ name });
    for (const n of ['base', 'dep', 'other']) core.plugins.set(n, mk(n));

    // `ghost` 代表"排完序之后被并发卸载"的名字：必须被 filter 掉，而不是塞进 _loaded。
    const sorted = pm._applyTopology(['dep', 'base', 'ghost']);

    assertEquals(sorted.map((p) => p.name).join(','), 'dep,base', '返回值只含真实存在的节点，且保持拓扑序');
    assertEquals([...core.plugins.keys()].join(','), 'dep,base,other', '排序后的节点在前，未列出的必须原样保留在后');
    assertEquals(pm._loaded.map((p) => p.name).join(','), 'dep,base', '_loaded 必须等于排序结果');
    pm._stopIdleTimer();
  });

  // ── E：去重与重名跳过不能丢 ────────────────────────────────────────
  runner.test('rc.26/E 同一文件二次装载必须被去重记账、不得重复进 _loaded', async () => {
    const base = tempDir('e');
    const dir = join(base, 'plugins');
    mkdirSync(dir, { recursive: true });
    const file = writePlugin(dir, 'twice');

    const core = stubCore();
    const pm = await newPm(core);
    try {
      await pm.loadFromDir(dir);
      await pm.loadFromDir(dir);   // 第二次：同实现
      assertEquals(pm._loaded.length, 1, '同实现不得重复记账（否则拓扑排序输入含重名，被误报成环）');
      assertEquals(core.plugins.size, 1, '不得注册第二个实例');
      assert(pm._dedupSkipped.some((d) => d.name === 'twice' && d.path === file), '去重必须留下可查的记录');
    } finally {
      pm._stopIdleTimer();
      rmSync(base, { recursive: true, force: true });
    }
  });

  // ── H：回收策略已经是**外部可注入**的（这是 §6-D 不必搬代码的根据）────────
  // 这两个用例给 `recycle-advisor` 补上第一条可执行契约：在此之前这个角色名只活在
  // plugin-manager 的一段注释里 —— 没有实现、没有测试、没有文档，等于宣布了却不存在。
  runner.test('rc.26/H recycle-advisor 的建议必须被真正执行；未装配时退回本地 TTL（行为不变）', async () => {
    const core = stubCore();
    const pm = await newPm(core);
    pm._lazyLoaded = new Set(['sat', 'kept']);
    pm._eager = new Set();
    pm._lastAccess = new Map([['sat', Date.now()]]);   // 刚访问过 ⇒ TTL 不该动它

    const seen = [];
    core.getService = (n) => (n === 'recycle-advisor'
      ? { pollRecycleDecisions: async () => [{ name: 'sat', reason: 'unit-test', idle_ms: 5 }] }
      : null);

    try {
      await pm._checkIdle();
      // 建议被采纳：即使它刚被访问过（TTL 判据不成立），advisor 说回收就必须回收。
      assert(!pm._lazyLoaded.has('sat'), 'advisor 点名的插件必须被回收（否则扩展点是假的）');
      assert(pm._lazyLoaded.has('kept'), '没被点名的不得被顺手回收');
      seen.push(...core.facts.filter((f) => f.type === 'core:plugin.recycled').map((f) => f.payload.pluginName));
      assertEquals(seen.join(','), 'sat', '回收事实必须点名回收了谁');

      // 未装配该角色：同一状态必须**保持不变**（缺省不是"一律回收"，也不是"一律不回收"）。
      const core2 = stubCore();
      const pm2 = await newPm(core2);
      pm2._lazyLoaded = new Set(['sat']);
      pm2._eager = new Set();
      pm2._lastAccess = new Map([['sat', Date.now()]]);
      await pm2._checkIdle();
      assert(pm2._lazyLoaded.has('sat'), '没有 advisor 且刚访问过时，TTL 回落也不得回收');
    } finally {
      pm._stopIdleTimer(); 
    }
  });

  runner.test('rc.26/I recycle-advisor 抛错不得中断巡检：降级到本地 TTL，且不产生未处理拒绝', async () => {
    const core = stubCore();
    const pm = await newPm(core);
    pm._lazyLoaded = new Set(['stale']);
    pm._eager = new Set();
    pm._lastAccess = new Map([['stale', 0]]);          // epoch ⇒ 必然超过 TTL
    core.getService = (n) => (n === 'recycle-advisor'
      ? { pollRecycleDecisions: async () => { throw new Error('advisor_down'); } }
      : null);
    try {
      await pm._checkIdle();
      // 角色是可选插件：它坏了不能让回收停摆（停摆 = 内存只增不减），也不能让巡检抛出去。
      assert(!pm._lazyLoaded.has('stale'), 'advisor 失联时必须由本地 TTL 兜底回收');
    } finally {
      pm._stopIdleTimer();
    }
  });

  // ── G：接管回执只有一个构造点 ──────────────────────────────────────
  runner.test('rc.26/G 服务接管回执只许有一个字面量构造点（两处各写一份 ⇒ 加字段只会加进一支）', () => {
    const src = readFileSync(join(ROOT, 'src/core/core.js'), 'utf8');
    const hits = src.split('newRegistrationId: registrationId').length - 1;
    assertEquals(hits, 1, `接管回执的字面量出现 ${hits} 次，必须只有 1 次（统一走 takeoverReceipt）`);
  });

  // ── F：重名（不同文件同名）也必须跳过，不是覆盖 ────────────────────
  runner.test('rc.26/F 不同文件同名插件：后到者被具名跳过，先到者不得被覆盖', async () => {
    const base = tempDir('f');
    const d1 = join(base, 'd1');
    const d2 = join(base, 'd2');
    mkdirSync(d1, { recursive: true });
    mkdirSync(d2, { recursive: true });
    writePlugin(d1, 'same');
    // 同名、不同实现（多一个字段 ⇒ 不是同一实现的文件，但名字已占）
    writeFileSync(join(d2, 'same.mjs'), readFileSync(join(d1, 'same.mjs'), 'utf8') + '\n// different file\n');

    const core = stubCore();
    const pm = await newPm(core);
    try {
      await pm.loadFromDir(d1);
      const first = core.plugins.get('same');
      await pm.loadFromDir(d2);
      assertEquals(core.plugins.size, 1, '同名不得注册两个');
      assert(core.plugins.get('same') === first, '先到者不得被后到者覆盖');
      assertEquals(pm._loaded.length, 1, '_loaded 只有一个同名条目');
    } finally {
      pm._stopIdleTimer();
      rmSync(base, { recursive: true, force: true });
    }
  });
  // ── J：ADR-10 历史行不许被改写 ─────────────────────────────────────
  runner.test('rc.26/J 已在 HEAD 里的版本行不得被改成另一个数（rc.26 真的踩过：先在 rc.25 下同步）', () => {
    const head = '| v0.16.0-rc.25 | 4978 → **4775** | 说明 |\n| v0.16.0-rc.26 | 4775 → **4753** | 说明 |';

    // 反例：HEAD 里 rc.25 记 4775，实测 4753 ⇒ 冲突（改它就是篡改已发布版本）
    const bad = releasedRowConflict(head, '0.16.0-rc.25', 4753);
    assert(bad, '已发布版本的行被改成新数字时必须报冲突');
    assertEquals(`${bad.from}->${bad.to}`, '4978->4775', '冲突要能说出这一行原记的是什么');
    assert(/篡改已发布版本/.test(releasedRowMessage('0.16.0-rc.25', bad, 4753)), '拒绝理由必须点名这是在改历史');

    // 正控①：数字本来就对 ⇒ 不冲突
    assertEquals(releasedRowConflict(head, '0.16.0-rc.25', 4775), null, '数字一致时不得误报');
    // 正控②：工作树里刚补的新版本行（HEAD 里没有）⇒ 随便改
    assertEquals(releasedRowConflict(head, '0.16.0-rc.27', 4700), null, 'HEAD 里没有该版本时必须放行（先补行、再同步的正常流程）');
    // 正控③：非 git 环境拿不到 HEAD ⇒ 放行（没有历史可篡改）
    assertEquals(releasedRowConflict(null, '0.16.0-rc.25', 1), null, '没有 HEAD 内容时不得卡住');
  });

  runner.test('rc.26/K 同步脚本必须在**任何写盘之前**做那道历史检查（否则拒绝会变成半写）', () => {
    const src = readFileSync(join(ROOT, 'scripts/sync-line-docs.mjs'), 'utf8');
    const guard = src.indexOf('assertNotRewritingHistory();');
    const firstWrite = src.indexOf('replaceOnce(');
    assert(guard > 0, '同步脚本必须调用历史检查');
    assert(firstWrite > 0, '同步脚本里应存在 replaceOnce（写法变了就更新这条用例）');
    assert(guard < firstWrite, '历史检查必须排在第一次 replaceOnce 之前：先写 core-limits 再在 ADR-10 拒绝，等于半写');
  });

  // ── L/M：recycle-advisor 参考实现 ─────────────────────────────────
  runner.test('rc.26/L 参考实现接上内核：装着超龄的懒插件经 advisor 路径被回收（不是 TTL 路径）', async () => {
    // 模块导出的**是实例**（装载器的判据要 name+init 在对象上）；用例里用它的构造器新建一份，
    // 免得两个用例共享同一本账（ESM 缓存只加载一次）。
    const mod = await imp('plugins/recycle-advisor.js');
    const bus = new EventEmitter();
    const services = new Map();
    const facts = [];
    const core = {
      bus, services, facts, plugins: new Map(),
      lifecycle: { unload: async () => ({ ok: true, released: true }) },
      on: (event, fn) => { bus.on(event, fn); return core; },
      emitFact: (type, payload) => { facts.push({ type, payload }); bus.emit(type, payload); },
      registerService: (n, o) => { services.set(n, o); },
      getService: (n) => services.get(n) ?? null,
      get: () => ({ maxAgeMs: 60_000 }),
      log: () => {},
      async register() { return true; },
    };

    const advisor = new (mod.default.constructor)();
    await advisor.init(core);
    assert(services.has('recycle-advisor'), '参考实现必须把 ./pollRecycleDecisions() 注册成服务角色');

    const pm = await newPm(core);
    pm._lazyLoaded = new Set(['old', 'fresh']);
    pm._eager = new Set();
    pm._lastAccess = new Map([['old', Date.now()], ['fresh', Date.now()]]);  // 都"刚访问过"⇒ TTL 不会动

    const t0 = Date.now();
    advisor._now = () => t0;
    bus.emit('core:plugin.loaded', { name: 'old' });
    bus.emit('core:plugin.loaded', { name: 'fresh' });
    // fresh 被重新装过 ⇒ 年龄归零；old 停在 t0
    advisor._loadedAt.set('fresh', t0 + 120_000);

    advisor._now = () => t0 + 90_000;   // old 90s（> 60s 上限），fresh 30s
    try {
      await pm._checkIdle();
      assert(!pm._lazyLoaded.has('old'), '超龄的必须被回收');
      assert(pm._lazyLoaded.has('fresh'), '没超龄的不得被顺手回收（判据不能是"一律回收"）');
      assertEquals(facts.filter((f) => f.type === 'core:plugin.recycled').map((f) => f.payload.pluginName).join(','), 'old',
        '回收事实必须点名 old');
    } finally {
      pm._stopIdleTimer();
    }
  });

  runner.test('rc.26/M 参考实现的三条自负边界：没见过的不下单、冷却期内不重复、一次不超过 maxPerPoll', async () => {
    // 模块导出的**是实例**（装载器的判据要 name+init 在对象上）；用例里用它的构造器新建一份，
    // 免得两个用例共享同一本账（ESM 缓存只加载一次）。
    const mod = await imp('plugins/recycle-advisor.js');
    const services = new Map();
    const core = {
      on: () => core, emitFact: () => {}, log: () => {},
      registerService: (n, o) => services.set(n, o),
      getService: (n) => services.get(n) ?? null,
      get: () => ({ maxAgeMs: 1000, cooldownMs: 10_000, maxPerPoll: 2 }),
    };
    const adv = new (mod.default.constructor)();
    await adv.init(core);
    const t = 1_000_000;
    adv._now = () => t;

    // 边界①：没见过 loaded 的名字永远不下单（不知年龄就该闭嘴）
    adv._loadedAt.set('a', t - 5000);
    assertEquals(adv.pollRecycleDecisions().map((d) => d.name).join(','), 'a', '超龄的必须下单');

    // 边界②：冷却期内不重复下单
    assertEquals(adv.pollRecycleDecisions().length, 0, '同一名字在冷却期内不得重复下单');

    // 边界③：一次最多 maxPerPoll 个
    for (const n of ['b', 'c', 'd']) adv._loadedAt.set(n, t - 5000);
    adv._advisedAt.clear();
    const batch = adv.pollRecycleDecisions();
    assertEquals(batch.length, 2, '一次巡检最多 maxPerPoll 个（一顿全回收会变成雪崩）');

    // 反控：配置读不到 / get 抛错时必须返回 []，不得把异常甩给内核
    core.get = () => { throw new Error('config down'); };
    assertEquals(adv.pollRecycleDecisions().length, 0, '配置读崩时必须安静返回空，由内核 TTL 兜底');
  });

}
