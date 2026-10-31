// R3（v0.16.0-rc）：装配链、懒加载桥、与 E4 器官的合同锁。
//
// 这一轮只做三件事，测试也按这个顺序分三段：
//   R3-00 依赖解析：`requires` 的键是**服务名**，不是插件名；
//   R3-03 懒加载桥：模型可见工具在懒加载插件里时，能用**工具名**触发装载；
//   R3-01 器官合同：受控多文件事务的信封、边界与如实回报。
//
// 每条判据都配一条**合法正例**（AGENTS.md §3）：修法不能变成“一律拒绝”。
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import strict from 'node:assert/strict';
import { assert, assertEquals } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(join(ROOT, rel));
const srcOf = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** 剥注释：结构判据必须看代码，不能被注释里的示例字样满足。 */
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const fakeCore = () => ({ log() {}, emit() {}, get: () => undefined, getService: () => null, getData: () => undefined });

/** 建一个“真装配”的 Core：workspace + liuhe-lite + 器官。 */
async function bootCore({ withTools = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'r3u-'));
  const ws = join(base, 'ws');
  mkdirSync(join(ws, 'src'), { recursive: true });
  mkdirSync(join(base, 'state'), { recursive: true });
  writeFileSync(join(ws, 'src', 'a.txt'), 'alpha\n');
  const { Core } = await imp('src/core/core.js');
  const core = new Core({ stateDir: join(base, 'state') });
  core.log = () => {};
  core.setData('agent.workDir', ws);
  const order = ['plugins/workspace.js'];
  if (withTools) order.push('plugins/tool-loader.js', 'plugins/tool-guard.js', 'plugins/tool-executor.js');
  order.push('plugins/liuhe-lite.js', 'plugins/cell-file-txn.js');
  for (const rel of order) await core.register((await imp(rel)).default);
  await core.start();
  return { core, ws, base, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

export async function setup(runner) {
  // ══ R3-00：`requires` 按服务名解析 ═══════════════════════════════════════
  runner.test('R3-00/1 正例：requires 写服务名时，按提供者插件建边（B 先于 A）', async () => {
    const { DependencyResolver } = await imp('src/core/dependency-resolver.js');
    const r = new DependencyResolver(fakeCore());
    const plugins = [
      { name: 'consumer', version: '1.0.0', requires: { 'the-service': '>=0.4.0' } },
      { name: 'provider', version: '0.5.0', provides: [{ name: 'the-service', type: 'service' }] },
    ];
    const out = r.topologicalSort(plugins);
    assert(out.ok, `应当能排序：${out.error || ''}`);
    assertEquals(out.order.indexOf('provider') < out.order.indexOf('consumer'), true,
      `provider 必须排在 consumer 前，实际 ${out.order.join(' → ')}`);
  });

  runner.test('R3-00/2 反例：服务没人提供时仍然硬失败（不得静默放行）', async () => {
    const { DependencyResolver } = await imp('src/core/dependency-resolver.js');
    const r = new DependencyResolver(fakeCore());
    const out = r.topologicalSort([{ name: 'a', version: '1.0.0', requires: { 'nobody-has-this': '>=1.0.0' } }]);
    assertEquals(out.ok, false, '缺依赖必须失败');
    assert(String(out.error).includes('nobody-has-this'), `错误串要点名缺的那个：${out.error}`);
  });

  runner.test('R3-00/3 反例：服务提供者版本不满足时仍然报版本不符', async () => {
    const { DependencyResolver } = await imp('src/core/dependency-resolver.js');
    const r = new DependencyResolver(fakeCore());
    const out = r.topologicalSort([
      { name: 'consumer', version: '1.0.0', requires: { 'the-service': '>=9.0.0' } },
      { name: 'provider', version: '0.5.0', provides: [{ name: 'the-service', type: 'service' }] },
    ]);
    assertEquals(out.ok, false, '版本不满足必须失败');
    assert(String(out.error).includes('Version mismatch'), `错误串要说明是版本不符：${out.error}`);
  });

  runner.test('R3-00/4 自依赖（require 自己提供的服务）不得被误判成环', async () => {
    const { DependencyResolver } = await imp('src/core/dependency-resolver.js');
    const r = new DependencyResolver(fakeCore());
    const out = r.topologicalSort([
      { name: 'solo', version: '1.2.3', requires: { 'own-svc': '>=1.0.0' }, provides: [{ name: 'own-svc' }] },
    ]);
    assertEquals(out.ok, true, `自依赖应被忽略，实际：${out.error}`);
  });

  runner.test('R3-00/5 缺陷锁：tool-executor 与 liuhe-lite 同场景 eager 时，DAG 不得回退目录顺序', async () => {
    const { Core } = await imp('src/core/core.js');
    const { PluginManager } = await imp('src/core/plugin-manager.js');
    const base = mkdtempSync(join(tmpdir(), 'r3u-order-'));
    mkdirSync(join(base, 'ws'), { recursive: true });
    mkdirSync(join(base, 'state'), { recursive: true });
    const core = new Core({ stateDir: join(base, 'state') });
    core.log = () => {};
    core.setData('agent.workDir', join(base, 'ws'));
    const pm = new PluginManager(core);
    core.registerService('plugin-manager', pm);
    pm.addDirectory(join(ROOT, 'plugins'));
    // 故意用“会触发旧缺陷”的配比：tool-executor 的 requires 写的是服务名 tool-registry。
    await pm.loadAll(['workspace', 'liuhe-lite', 'tool-loader', 'tool-guard', 'tool-executor'], []);
    await core.start();
    const order = [...core.plugins.keys()];
    const liuheOk = Boolean(core.getService('liuhe-lite'));
    const wsBeforeLiuhe = order.indexOf('workspace') < order.indexOf('liuhe-lite');
    await core.stop();
    rmSync(base, { recursive: true, force: true });
    assert(wsBeforeLiuhe, `workspace 必须在 liuhe-lite 前，实际 ${order.join(' → ')}`);
    assert(liuheOk, 'liuhe-lite 必须装得上（修前它因“workspace service required”直接失败）');
  });

  // ══ R3-03：懒加载桥（用工具名触发装载）══════════════════════════════════
  runner.test('R3-03/1 正例：懒加载插件里的模型工具，能用工具名触发装载并执行', async () => {
    const { Core } = await imp('src/core/core.js');
    const { PluginManager } = await imp('src/core/plugin-manager.js');
    const base = mkdtempSync(join(tmpdir(), 'r3u-lazy-'));
    mkdirSync(join(base, 'ws'), { recursive: true });
    mkdirSync(join(base, 'state'), { recursive: true });
    writeFileSync(join(base, 'ws', 'x.txt'), 'x\n');
    const core = new Core({ stateDir: join(base, 'state') });
    core.log = () => {};
    core.setData('agent.workDir', join(base, 'ws'));
    const pm = new PluginManager(core);
    core.registerService('plugin-manager', pm);
    pm.addDirectory(join(ROOT, 'plugins'));
    await pm.loadAll(['workspace', 'tool-loader', 'tool-guard', 'tool-executor', 'liuhe-lite'], ['cell-file-txn']);
    await core.start();
    const before = core.plugins.has('cell-file-txn');
    const exec = core.getService('tool-executor');
    const r = await exec.executeOne('tool-txn-plan', { files: [{ path: 'x.txt', content: 'y\n' }] }, 'sess-lazy');
    const after = core.plugins.has('cell-file-txn');
    await core.stop();
    rmSync(base, { recursive: true, force: true });
    assertEquals(before, false, '判据前提：触发前必须还没装（否则测的不是懒加载）');
    assert(after, '执行器应当用派生能力 id 触发一次懒加载');
    assertEquals(r.state, 'succeeded', `应当执行成功，实际 ${r.state} ${r.code || ''} ${r.error || ''}`);
  });

  runner.test('R3-03/2 反例：没人提供的工具名不得因为“有懒加载钩子”而放行', async () => {
    const { Core } = await imp('src/core/core.js');
    const { PluginManager } = await imp('src/core/plugin-manager.js');
    const base = mkdtempSync(join(tmpdir(), 'r3u-lazy2-'));
    mkdirSync(join(base, 'ws'), { recursive: true });
    mkdirSync(join(base, 'state'), { recursive: true });
    const core = new Core({ stateDir: join(base, 'state') });
    core.log = () => {};
    core.setData('agent.workDir', join(base, 'ws'));
    const pm = new PluginManager(core);
    core.registerService('plugin-manager', pm);
    pm.addDirectory(join(ROOT, 'plugins'));
    await pm.loadAll(['workspace', 'tool-loader', 'tool-guard', 'tool-executor'], ['cell-file-txn']);
    await core.start();
    const exec = core.getService('tool-executor');
    const r = await exec.executeOne('tool-nobody-provides-this', {}, 'sess-x');
    const loaded = core.plugins.has('cell-file-txn');
    await core.stop();
    rmSync(base, { recursive: true, force: true });
    assertEquals(r.ok, false, '未知工具必须失败');
    assertEquals(loaded, false, '不能因为“钩子存在”就把不相关的插件也拉起来');
  });

  // ══ R3-01：器官合同（信封 / 边界 / 如实回报）═══════════════════════════
  runner.test('R3-01/1 入参白名单：不能带 workspace/root 之类的作用域选择器', async () => {
    const b = await bootCore();
    try {
      const env = await b.core.callCapability('tool.txn-plan', {
        files: [{ path: 'src/a.txt', content: 'x\n' }], workspace: '/etc', _sessionId: 'sess-param',
      });
      const p = env?.payload ?? env;
      assertEquals(p?.ok, false, '带 workspace 入参必须被拒');
      assertEquals(p?.code, 'INVALID_INPUT', `实际 code=${p?.code}`);
      strict.deepEqual(p?.detail?.rejected_params, ['workspace'], '必须点名被拒的字段');
    } finally { await b.core.stop(); b.cleanup(); }
  });

  runner.test('R3-01/2 计划期参数校验：重复路径 / 非字符串内容 / 超量文件', async () => {
    const b = await bootCore();
    try {
      const dup = await b.core.callCapability('tool.txn-plan', { files: [
        { path: 'src/a.txt', content: '1' }, { path: 'src/a.txt', content: '2' }], _sessionId: 's' });
      assertEquals((dup?.payload ?? dup)?.code, 'DUPLICATE_PATH', '重复路径必须在计划期拒绝');
      const bad = await b.core.callCapability('tool.txn-plan', { files: [{ path: 'src/a.txt', content: 42 }], _sessionId: 's' });
      assertEquals((bad?.payload ?? bad)?.code, 'INVALID_INPUT', '非字符串内容必须拒绝');
      const many = await b.core.callCapability('tool.txn-plan', {
        files: Array.from({ length: 33 }, (_, i) => ({ path: `f${i}.txt`, content: 'x' })), _sessionId: 's',
      });
      assertEquals((many?.payload ?? many)?.code, 'TOO_MANY_FILES', '超量文件必须拒绝');
    } finally { await b.core.stop(); b.cleanup(); }
  });

  runner.test('R3-01/3 空字符串是合法文件内容（不得用 || 当“没传”）', async () => {
    const b = await bootCore();
    try {
      const env = await b.core.callCapability('tool.txn-plan', { files: [{ path: 'src/empty.txt', content: '' }], _sessionId: 's' });
      const p = env?.payload ?? env;
      assertEquals(p?.ok, true, `空内容应当被接受：${JSON.stringify(p).slice(0, 160)}`);
      assertEquals(p.plan.files[0].changed, true, '从不存在到存在，算一次变更');
    } finally { await b.core.stop(); b.cleanup(); }
  });

  runner.test('R3-01/4 写动作必须有可信会话：没有 session 时 commit/undo 具名拒绝', async () => {
    const b = await bootCore();
    try {
      const c = await b.core.callCapability('tool.txn-commit', { plan_id: 'plan_x' });
      assertEquals((c?.payload ?? c)?.code, 'SESSION_REQUIRED', 'commit 无会话必须拒绝');
      const u = await b.core.callCapability('txn.undo', { txn_id: 'txn_x' });
      assertEquals((u?.payload ?? u)?.code, 'SESSION_REQUIRED', 'undo 无会话必须拒绝');
    } finally { await b.core.stop(); b.cleanup(); }
  });

  runner.test('R3-01/5 未知 plan/txn 的回执：具名、带 retry、不编造状态', async () => {
    const b = await bootCore();
    try {
      const p = (await b.core.callCapability('tool.txn-commit', { plan_id: 'plan_ghost', _sessionId: 's' }))?.payload;
      assertEquals(p?.code, 'PLAN_NOT_FOUND');
      assertEquals(p?.retry, 'new_request');
      const i = (await b.core.callCapability('tool.txn-status', { txn_id: 'txn_ghost', _sessionId: 's' }))?.payload;
      assertEquals(i?.code, 'NOT_FOUND');
      assertEquals(i?.retry, 'never');
      assert(String(i?.message).includes('memory'), '必须说明索引是易失的（不能让调用方以为可以当审计）');
    } finally { await b.core.stop(); b.cleanup(); }
  });

  runner.test('R3-01/6 只读动作不写盘：plan 之后磁盘哈希不变', async () => {
    const b = await bootCore();
    try {
      const before = readFileSync(join(b.ws, 'src', 'a.txt'), 'utf8');
      const env = await b.core.callCapability('tool.txn-plan', { files: [{ path: 'src/a.txt', content: 'CHANGED\n' }], _sessionId: 's' });
      assertEquals(env?.payload?.ok, true);
      assertEquals(readFileSync(join(b.ws, 'src', 'a.txt'), 'utf8'), before, 'plan 绝不能改盘');
    } finally { await b.core.stop(); b.cleanup(); }
  });

  runner.test('R3-01/7 describe 如实：undo 只在能力面、索引 volatile、工具三个', async () => {
    // 用**带 tool-registry** 的装配：工具是经门面公开注册的，这才有“三个工具”可谈。
    // 没有 registry 时 describe().model_visible_tools 必须是空数组（见下一条断言）。
    const b = await bootCore({ withTools: true });
    try {
      const d = b.core.getService('cell-file-txn').describe();
      assertEquals(d.persistence, 'volatile');
      strict.deepEqual(d.capability_only, ['txn.inspect', 'txn.undo']);
      strict.deepEqual(d.model_visible_tools, ['tool-txn-plan', 'tool-txn-commit', 'tool-txn-status']);
    } finally { await b.core.stop(); b.cleanup(); }
  });

  runner.test('R3-01/7b 没有 tool-registry 时不得自称“工具已公开注册”', async () => {
    const b = await bootCore();
    try {
      const d = b.core.getService('cell-file-txn').describe();
      strict.deepEqual(d.model_visible_tools, [], '没注册就是没注册，不能虚空声明');
      // 但能力面必须还在：宿主走服务面（txn.inspect）无会话也能查（F-04 的分面契约）。
      const env = await b.core.callCapability('txn.inspect', { txn_id: 'nope' });
      assertEquals((env?.payload ?? env)?.code, 'NOT_FOUND');
      // 模型面（tool.txn-status）没有会话就不给读 —— 两个入口两把尺子。
      const model = await b.core.callCapability('tool.txn-status', { txn_id: 'nope' });
      assertEquals((model?.payload ?? model)?.code, 'SESSION_REQUIRED');
    } finally { await b.core.stop(); b.cleanup(); }
  });

  runner.test('R3-01/8 静态：provides 声明的能力与模型可见工具必须一致（不得声明不存在的）', async () => {
    const src = srcOf('plugins/cell-file-txn.js');
    const declared = [...stripComments(src).matchAll(/name:\s*'([^']+)',\s*type:\s*'capability'/g)].map((m) => m[1]);
    strict.deepEqual([...new Set(declared)].sort(),
      ['tool.txn-commit', 'tool.txn-plan', 'tool.txn-status', 'txn.inspect', 'txn.undo'],
      `provides 里的能力清单与工具表不符：${JSON.stringify(declared)}`);
    // undo 不得出现在模型可见工具表（它是能力面动作）。
    const tool = [...stripComments(src).matchAll(/tool:\s*'([^']+)'/g)].map((m) => m[1]);
    assertEquals(tool.includes('tool-txn-undo'), false, 'undo 不得被模型直接点名');
  });

  runner.test('R3-01/9 懒加载索引能吃下这个文件：类字段必须落在前 2048 字节', async () => {
    const { extractPluginMeta } = await imp('src/core/plugin-meta.js');
    const head = readFileSync(join(ROOT, 'plugins/cell-file-txn.js')).slice(0, 2048).toString('utf8');
    const meta = extractPluginMeta(head, 'plugins/cell-file-txn.js');
    assertEquals(meta.name, 'cell-file-txn', '懒加载索引必须能从文件头提取 name');
    assertEquals(meta.provides.length, 6, `provides 应提取到 6 项，实际 ${meta.provides.length}`);
    assertEquals(meta.requires['liuhe-lite'] != null, true, 'requires 必须可提取（否则懒加载链算不出依赖）');
  });

  runner.test('R3-01/10 Cell 归因来自登记表：无 cell-runtime 时如实写 null + 原因', async () => {
    const b = await bootCore();
    try {
      const env = await b.core.callCapability('tool.txn-plan', { files: [{ path: 'src/a.txt', content: 'z\n' }], _sessionId: 'sess-plain' });
      const plan = env?.payload?.plan;
      assert(plan?.plan_id, '计划应当建立');
      const commit = await b.core.callCapability('tool.txn-commit', { plan_id: plan.plan_id, _sessionId: 'sess-plain' });
      const txn = commit?.payload?.txn;
      assertEquals(txn.cell_id, null, '没有 cell-runtime 时不能编一个 cell_id');
      assertEquals(txn.cell_attribution, 'cell_runtime_unavailable', `实际 ${txn.cell_attribution}`);
      assertEquals(commit?.payload?.ok, true, '归因缺失不得阻断执行（归因是增量证据）');
    } finally { await b.core.stop(); b.cleanup(); }
  });

  runner.test('R3-01/11 场景配方存在且只声明已注册的键（file-txn）', async () => {
    const p = join(ROOT, 'scenes/file-txn.json5');
    assert(existsSync(p), 'E4 的装配配方必须随包');
    const text = readFileSync(p, 'utf8');
    const { loadJson5 } = await imp('src/core/json5-loader.js');
    const cfg = loadJson5(text, ' in file-txn.json5');
    assertEquals(cfg.name, 'file-txn');
    assert(cfg.eager.includes('liuhe-lite'), '配方必须把 liuhe-lite 真装成 eager');
    strict.deepEqual(cfg.lazy, ['cell-file-txn'], '器官本体必须在懒加载池');
  });
}
