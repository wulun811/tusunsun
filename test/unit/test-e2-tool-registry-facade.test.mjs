// E2 回归锁 —— 模型工具的**公开**注册/注销门面（v0.9.33）。
//
// 事实（v0.9.32 送审报告 EV-04）：`context-port.js`、`experience-port.js`、
// `plugin-context.js`、`haotian-lite.js` 四处直接读写 `registry._tools` 私有 Map。
// 私有字段改名时它们会**同时静默失效**，失效方式是"工具看不见了"或"幽灵工具还在"。
//
// 本文件钉住的不只是"门面存在"，而是计划书 E2 合同里每一条反例：
//   · 无主插入 → 拒绝（owner_required）
//   · 同名不同 owner → 拒绝（tool_name_conflict），不夺权
//   · 无权 unregister → 拒绝（not_owner），不删别家的
//   · 反复注册（同 owner 同名）→ 不产生两份
//   · 注销后模型不可见，但**别的 owner 的能力不受影响**
//   · 模型目录 ≠ 授权真值：看得见不等于执行器会放行
//
// 另有一条**结构判据**：随包插件不得再出现 `._tools` 私有访问。它是本文件里唯一
// 数源码的一条，但这里的"数源码"是有意义的：它守的是"迁移没有回退"，
// 而不是"某个词还在不在"。为了不被注释误伤，判据先剥注释再找。
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { rejectNodeTestContext } from '../lib/node-test-guard.mjs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (rel) => import(join(ROOT, rel));

rejectNodeTestContext('test/unit/test-e2-tool-registry-facade.test.mjs');

export async function setup(runner) {
  const { Core } = await imp('src/core/core.js');

  /** 造一个装了 tool-loader 的真宿主。每个用例一个独立实例（门面有状态）。 */
  async function makeHost(base) {
    const core = new Core({ stateDir: join(base, 'state') });
    core.log = () => {};
    core.emit = core.emit.bind(core);
    core.setData('agent.workDir', join(base, 'ws'));
    // tool-loader 的 init 会 readdir `core.pluginsDir/tools`；给一个真目录，空着即可。
    mkdirSync(join(base, 'plugins', 'tools'), { recursive: true });
    core.pluginsDir = join(base, 'plugins');
    const L = (await imp('plugins/tool-loader.js')).default;
    // 单例：每次用干净的原型派生实例，避免跨用例串状态
    const loader = Object.create(L);
    loader._tools = new Map();
    loader._fileCache = new Map();
    loader._toolAccess = new Map();
    loader._stubs = new Map();
    loader._recycleTimer = null;
    loader._reloadCounter = 0;
    await loader.init(core);
    loader._stopRecycleTimer();
    return { core, loader };
  }

  // ══ 注册合同 ══════════════════════════════════════════════════════════════
  runner.test('E2/a 无 owner 的注册必须被拒（无主插入无法注销、也无法归属）', async () => {
    const d = mkdtempSync(join(tmpdir(), 'e2a-'));
    try {
      const { loader } = await makeHost(d);
      for (const owner of [undefined, null, '', '   ']) {
        const r = loader.registerTool({ name: 'tool-x', owner, execute: async () => 'X' });
        assertEquals(r.ok, false, `owner=${JSON.stringify(owner)} 必须被拒`);
        assertEquals(r.code, 'owner_required', `必须报 owner_required，实际 ${r.code}`);
      }
      assertEquals(loader.listTools().length, 0, '被拒的注册不得留下条目');
      console.log('       [实测] 4 种无主注册全部 owner_required，目录为空');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('E2/b 同名工具不得被后来的 owner 夺走（冲突必须拒绝而不是覆盖）', async () => {
    const d = mkdtempSync(join(tmpdir(), 'e2b-'));
    try {
      const { loader } = await makeHost(d);
      const a = loader.registerTool({ name: 'tool-shared', owner: 'plug-A', description: 'A 的', execute: async () => 'A' });
      assertEquals(a.ok, true, 'plug-A 首次注册应成功');

      const b = loader.registerTool({ name: 'tool-shared', owner: 'plug-B', description: 'B 的', execute: async () => 'B' });
      assertEquals(b.ok, false, 'plug-B 不得顶掉 plug-A 的工具');
      assertEquals(b.code, 'tool_name_conflict', `必须报 tool_name_conflict，实际 ${b.code}`);

      const listed = loader.listTools({ owner: 'plug-A' });
      assertEquals(listed.length, 1, 'plug-A 的工具必须仍在');
      assertEquals(listed[0].description, 'A 的',
        `目录里必须仍是 A 的那一份（覆盖会让"谁发布了这个工具"变成不可回答）`);
      const got = await loader.get('tool-shared');
      assertEquals(await got.execute({}), 'A', '被拿到的实现必须是 A 的，不是 B 的');
      console.log('       [实测] 同名冲突被拒，plug-A 的实现与说明原样保留');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('E2/c 同 owner 重复注册是幂等的（不产生两份、不报错）', async () => {
    const d = mkdtempSync(join(tmpdir(), 'e2c-'));
    try {
      const { loader } = await makeHost(d);
      for (let i = 0; i < 3; i++) {
        const r = loader.registerTool({ name: 'tool-dup', owner: 'plug-A', description: `v${i}`, execute: async () => `v${i}` });
        assertEquals(r.ok, true, `同 owner 第 ${i + 1} 次注册应成功（幂等）`);
      }
      assertEquals(loader.listTools().length, 1, `目录里只能有一份，实际 ${loader.listTools().length} 份`);
      const got = await loader.get('tool-dup');
      assertEquals(await got.execute({}), 'v2', '最后一次注册的实现应生效（同 owner 允许自我更新）');
      console.log('       [实测] 3 次同 owner 注册 → 目录 1 份、实现为最新');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('E2/d 无 execute 的声明式注册：模型可见但 ready=false', async () => {
    const d = mkdtempSync(join(tmpdir(), 'e2d-'));
    try {
      const { loader } = await makeHost(d);
      const r = loader.registerTool({ name: 'tool-declared', owner: 'plug-A', description: '还没就绪' });
      assertEquals(r.ok, true, '声明式注册应成功');
      const listed = loader.listTools();
      assertEquals(listed.length, 1, '声明式工具应出现在目录里');
      assertEquals(listed[0].ready, false,
        '没有 execute 的工具 ready 必须是 false —— 否则模型会去调一个注定失败的工具');
      console.log('       [实测] 声明式注册可见但 ready=false');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ══ 注销合同 ══════════════════════════════════════════════════════════════
  runner.test('E2/e 非 owner 不得注销别人的工具（这正是私有 Map 时代做不到的判据）', async () => {
    const d = mkdtempSync(join(tmpdir(), 'e2e-'));
    try {
      const { loader } = await makeHost(d);
      const reg = loader.registerTool({ name: 'tool-owned', owner: 'plug-A', execute: async () => 'A' });

      const bad = loader.unregisterTool({ name: 'tool-owned', owner: 'plug-B' });
      assertEquals(bad.ok, false, 'plug-B 注销 plug-A 的工具必须失败');
      assertEquals(bad.code, 'not_owner', `必须报 not_owner，实际 ${bad.code}`);
      assertEquals(loader.listTools().length, 1, '失败的注销不得真的删掉');

      // 冒用同一个 owner 字符串也不行：名字不构成授权（专家 ID-12）。
      const spoof = loader.unregisterTool({ name: 'tool-owned', owner: 'plug-A' });
      assertEquals(spoof.ok, false, 'owner 字符串本身不得作为撤销依据');
      assertEquals(loader.listTools().length, 1);

      const good = loader.unregisterTool({ name: 'tool-owned', owner: 'plug-A', handle: reg.handle });
      assertEquals(good.ok, true, '持凭据的注销必须成功');
      assertEquals(loader.listTools().length, 0, '成功注销后目录里不应再有它');
      console.log('       [实测] not_owner 拒绝；owner 自注销成功');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('E2/f 注销必须移除模型可见性，但不得动别家能力', async () => {
    // 这是合同里最容易写错的一条：为了"让工具消失"去 `core.unregisterCapability`，
    // 会连带把别人（或宿主加固过的）同名能力干掉。
    const d = mkdtempSync(join(tmpdir(), 'e2f-'));
    try {
      const { core, loader } = await makeHost(d);
      // 宿主先自己注册一个同名能力（模拟"宿主加固过"）
      core.registerCapability('tool.keepme', { owner: 'host', handler: async () => 'HOST' });
      const reg = loader.registerTool({ name: 'tool-keepme', owner: 'plug-A', execute: async () => 'A' });

      const before = core.listCapabilities().find((c) => c.id === 'tool.keepme');
      assert(before, '前提：宿主能力应存在');

      loader.unregisterTool({ name: 'tool-keepme', owner: 'plug-A', handle: reg.handle });

      assertEquals(loader.listTools().length, 0, '注销后模型不应再看见它');
      const after = core.listCapabilities().find((c) => c.id === 'tool.keepme');
      assert(after, '注销工具目录**不得**顺手注销能力 —— 那会动到别人的授权面');
      assertEquals(after.owner, 'host', '能力仍应属于宿主');
      assertEquals(await core.callCapability('tool.keepme', {}).then((r) => r.payload), 'HOST',
        '宿主的能力必须仍然可调用');
      console.log('       [实测] 工具目录已移除，宿主能力仍在且可调用');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('E2/g 注销后不得留下幽灵工具（目录、get、能力三者一致）', async () => {
    const d = mkdtempSync(join(tmpdir(), 'e2g-'));
    try {
      const { core, loader } = await makeHost(d);
      const reg = loader.registerTool({ name: 'tool-ghost', owner: 'plug-A', execute: async () => 'A' });
      assertEquals(typeof (await loader.get('tool-ghost'))?.execute, 'function', '前提：注册后可取到');

      loader.unregisterTool({ name: 'tool-ghost', owner: 'plug-A', handle: reg.handle });

      assertEquals(loader.has('tool-ghost'), false, 'has() 必须为 false');
      assertEquals(await loader.get('tool-ghost'), null, 'get() 必须为 null（修前这里会去懒加载，报错）');
      assertEquals(loader.listTools().filter((t) => t.name === 'tool-ghost').length, 0, '目录里必须没有');
      const cap = core.listCapabilities().find((c) => c.id === 'tool.ghost');
      assert(!cap, '门面注册时建的能力必须一起走，不能留一个指向已删工具的 handler');
      console.log('       [实测] 注销后 has/get/list/能力 四处一致为空');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('E2/h 注销一个不存在的工具必须是具名失败（不能静默当作成功）', async () => {
    const d = mkdtempSync(join(tmpdir(), 'e2h-'));
    try {
      const { loader } = await makeHost(d);
      const r = loader.unregisterTool({ name: 'tool-nope', owner: 'plug-A' });
      assertEquals(r.ok, false, '不存在的工具不应报成功');
      assertEquals(r.code, 'tool_not_found', `必须报 tool_not_found，实际 ${r.code}`);
      console.log('       [实测] 注销不存在工具 → tool_not_found');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ══ 目录 ≠ 授权（这是 E2 最容易被误解的一条） ════════════════════════════
  runner.test('E2/i 工具可见不等于有权执行：门面不得绕过执行器的能力判定', async () => {
    const d = mkdtempSync(join(tmpdir(), 'e2i-'));
    try {
      const { core, loader } = await makeHost(d);
      // 注册一个**不建能力**的工具（owner 明确、模型可见），执行器调用它时必须找不到能力
      const r = loader.registerTool({
        name: 'plain-tool', owner: 'plug-A', execute: async () => 'NEVER',
        capabilityId: null,
      });
      assertEquals(r.ok, true, '前提：注册应成功');
      assert(loader.listTools().some((t) => t.name === 'plain-tool'), '前提：模型看得见它');

      const capIds = core.listCapabilities().map((c) => c.id);
      assertEquals(capIds.includes('tool.plain-tool'), false,
        '没有 capabilityId 的工具不得凭空得到能力 —— 否则门面就等于授权器');
      console.log('       [实测] 模型可见但无能力：目录 ≠ 授权');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('E2/j 认知端口的工具必须带能力 id（否则绕过 Cell 能力门）', async () => {
    // 计划书 E2 的隐含前提：认知工具（context/experience pull）也必须服从执行资格。
    // Cell 的能力门只对 `tool-` 前缀生效，所以名字与能力 id 的对应关系是安全判据、不是命名风格。
    const d = mkdtempSync(join(tmpdir(), 'e2j-'));
    try {
      const { core, loader } = await makeHost(d);
      const r = loader.registerTool({
        name: 'tool-context-pull', owner: 'context-port', execute: async () => 'PULL',
      });
      assertEquals(r.ok, true, '注册应成功');
      assertEquals(r.capability_id, 'tool.context-pull',
        `能力 id 必须按 tool-<x> → tool.<x> 派生（Cell 能力门依赖它），实际 ${r.capability_id}`);
      const cap = core.listCapabilities().find((c) => c.id === 'tool.context-pull');
      assert(cap, '能力必须真的被注册');
      assertEquals(cap.owner, 'context-port', '能力归属必须是注册方');
      console.log('       [实测] tool-context-pull → tool.context-pull 能力，owner=context-port');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ══ 结构判据：私有访问不得回退 ════════════════════════════════════════════
  runner.test('E2/k 随包插件不得再出现 `._tools` 私有访问（迁移不许回退）', async () => {
    // 这是本文件唯一数源码的判据。它守的不是"某个词还在不在"，而是"迁移是否回退"。
    // 必须**先剥注释**再找 —— 本项目反复踩过"数注释里的字样"的假绿（R0-130/E）。
    const dir = join(ROOT, 'plugins');
    const strip = (src) => src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const offenders = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.js')) continue;
      if (f === 'tool-loader.js' || f === 'tools.js') continue;  // 这两个是 **owner**，允许自己持有
      const src = strip(readFileSync(join(dir, f), 'utf8'));
      if (/\._tools\b/.test(src)) offenders.push(f);
    }
    assertEquals(offenders.length, 0,
      `这些插件仍在直接访问 tool-registry 的私有 Map，应改走 registerTool/unregisterTool/listTools：\n  ${offenders.join('\n  ')}`);
    console.log('       [实测] 剥注释后 plugins/*.js 无 `._tools` 私有访问');
  });

  runner.test('E2/l 门面必须真的被三个消费者用上（不是只提供一个没人用的 API）', async () => {
    // 反向判据：只加 API 不迁移 = "声明了但零读者"，正是本项目反复修的那个形状。
    const files = ['context-port.js', 'experience-port.js', 'plugin-context.js'];
    for (const f of files) {
      const src = readFileSync(join(ROOT, 'plugins', f), 'utf8');
      assert(/\.registerTool\s*\(/.test(src), `${f} 必须调用 registerTool 门面`);
      assert(/\.unregisterTool\??\.?\s*\(/.test(src), `${f} 的 stop() 必须调用 unregisterTool 门面`);
    }
    console.log(`       [实测] ${files.length} 个消费者均已迁移到门面（注册+注销两侧）`);
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
