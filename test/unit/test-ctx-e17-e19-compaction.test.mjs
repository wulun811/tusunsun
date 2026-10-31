// CTX-E17/E18/E19（PR-4）：结构化摘要的产生、恢复、损坏与双 Cell 隔离。
//
// 这一组针对的是 v0.9.21 之前的三个具体缺陷：
//   ① 摘要只在内存 Map 里（重启即丢）；
//   ② 256 会话上限按"最早写入"淘汰（可能淘汰另一个 Cell 正在用的）；
//   ③ 摘要没有来源范围/版本/生成器，且被直接拼进 system 消息。
// 因此断言不只看"有没有摘要文本"，而是看**来源、版本、生成状态、归属路径**四个维度。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TestRunner, assert, assertEquals } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(join(ROOT, rel));

/** 造宿主；`modelText` 为 null 时表示"没有模型服务"。 */
async function makeHost({ base, modelText = '1. 目标：完成改造\n2. 事实：已确认 A\n3. 决定：不回调\n4. 完成：产物 out.txt\n5. 未完成：复核\n6. 风险：绑定失效\n7. 不确定：性能' }) {
  const ws = join(base, 'ws');
  const profRoot = join(base, 'profiles');
  const resRoot = join(base, 'resources');
  mkdirSync(ws, { recursive: true });
  mkdirSync(join(resRoot, 'docs'), { recursive: true });
  mkdirSync(profRoot, { recursive: true });
  writeFileSync(join(resRoot, 'docs', 'p.md'), '# P\nsystem prompt');
  writeFileSync(join(resRoot, '.context-manifest.json'), JSON.stringify({ schema_version: 'tusunsun.context-manifest/v0', items: [] }));
  writeFileSync(join(profRoot, 'ctx-v1.json'), JSON.stringify({
    schema_version: 'tusunsun.context-profile/v0',
    profile_id: 'ctx-v1',
    system_prompt_ref: 'local:docs/p.md',
    compaction: { provider: 'structured-llm', max_summary_tokens: 500 },
    budget: { input_max_tokens: 8000, response_reserve_tokens: 1000 },
  }, null, 2));

  const { Core } = await imp('src/core/core.js');
  const core = new Core({ stateDir: join(base, 'state') });
  core.log = () => {};
  core.setData('agent.workDir', ws);
  const cfg = { cells: { context: {
    enabled: true, profileRoot: profRoot, resourceRoot: resRoot, allowedProfiles: ['ctx-v1'],
  } } };
  core.registerService('config', {
    get: (p, f) => {
      let c = cfg;
      for (const k of String(p).split('.')) { if (c == null || typeof c !== 'object') return f; c = c[k]; }
      return c === undefined ? f : c;
    },
    data: cfg,
  });
  if (modelText !== null) {
    core.registerService('model', {
      supportsNativeTools: true,
      call: async () => ({ content: modelText }),
      callTier: async () => ({ content: modelText }),
    });
  }
  await (await imp('plugins/workspace.js')).default.init(core);
  core.registerCapability('tool.read', { owner: 'test', handler: async () => 'read' });
  core.registerCapability('tool.write', { owner: 'test', handler: async () => 'write' });
  core.registerCapability('chat.handle', { owner: 'test', handler: async () => ({ reply: 'ok' }) });

  const rt = Object.create((await imp('plugins/cell-runtime.js')).default);
  await rt.init(core);
  const cc = Object.create((await imp('plugins/cell-context.js')).default);
  await cc.init(core);
  const cpd = Object.create((await imp('plugins/compaction.js')).default);
  await cpd.init(core);
  return { core, ws, svc: core.getService('cell-runtime'), ctx: core.getService('cell-context'), compaction: core.getService('compaction') };
}

const spec = (id, workspace) => ({
  schema_version: 'tusunsun.cell/v0', cell_id: id, workspace,
  capabilities: ['tool.read', 'tool.write'], permission_mode: 'auto',
  runtime: { kind: 'process' }, limits: { max_active_tasks: 1, max_children: 0 },
});
const task = (id, cellId) => ({
  schema_version: 'tusunsun.task/v0', task_id: id, attempt: 1, target_cell_id: cellId,
  goal: 'g', inputs: [], required_capabilities: ['tool.read'],
  budget: { max_steps: 5, wall_ms: 30000 }, acceptance: { required_artifacts: [], checks: [] },
});

const msgs = [
  { role: 'user', content: '请改造架构' },
  { role: 'assistant', content: '好的，我先看代码' },
  { role: 'user', content: '顺便补测试' },
  { role: 'assistant', content: '已完成 A 部分' },
];

const codeOf = async (fn) => {
  try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, code: e.code, message: e.message }; }
};

export async function setup(runner) {
  const base = () => mkdtempSync(join(tmpdir(), 'ctx-e17-'));

  runner.test('CTX-E17 摘要产生与恢复：原文不删、重启恢复、携带来源范围与版本', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d });
      await h.svc.create(spec('cell-A', h.ws), { trusted: true });
      await h.ctx.bind('cell-A', { profileId: 'ctx-v1' });
      await h.svc.accept('cell-A', task('t1', 'cell-A'));
      await h.svc.execute('cell-A');

      const rec = await h.compaction.compact({
        messages: msgs, cellId: 'cell-A', sessionId: 's-1',
        sourceRange: { from: 0, to: msgs.length },
      });
      assertEquals(rec.status, 'ok', `模型可用时应 ok，实际 ${rec.status}/${rec.reason || ''}`);
      assert(rec.summary.includes('目标'), '摘要应含 7 项结构中的目标');
      assert(/^[0-9a-f]{64}$/.test(rec.source_hash), 'source_hash 必须是 64 位 hex');
      assertEquals(rec.source_range.from, 0, '来源范围 from 应记录');
      assertEquals(rec.source_range.to, msgs.length, '来源范围 to 应记录');
      assertEquals(rec.generator.provider, 'structured-llm', 'generator.provider 应记录');
      assert(typeof rec.generator.model === 'string', 'generator.model 应记录（可为空串）');

      // 落盘路径按 Cell + Session 归属
      const file = join(d, 'state', 'cells', 'cell-A', 'context', 'summaries', 's-1.json');
      assert(existsSync(file), `摘要应落在 ${file}`);
      const onDisk = JSON.parse(readFileSync(file, 'utf8'));
      assertEquals(onDisk.cell_id, 'cell-A', '落盘的 cell_id 应正确');
      assertEquals(onDisk.session_id, 's-1', '落盘的 session_id 应正确');

      // **原文没有被删**：本插件从不写会话；这里断言 session 存储未被创建/改写
      assert(!existsSync(join(d, 'state', 'sessions', 's-1.jsonl')), '压缩操作不得凭自身创建/覆盖会话原文');

      // 重启（新 Core，同 stateDir）后能读回
      const { Core } = await imp('src/core/core.js');
      const core2 = new Core({ stateDir: join(d, 'state') });
      core2.log = () => {};
      core2.setData('agent.workDir', h.ws);
      core2.registerService('config', { get: h.core.getService('config').get, data: h.core.getService('config').data });
      await (await imp('plugins/workspace.js')).default.init(core2);
      const cc2 = Object.create((await imp('plugins/cell-context.js')).default);
      await cc2.init(core2);
      const got = await core2.getService('cell-context').loadSummary('cell-A', 's-1');
      assert(got, '重启后应能读回摘要');
      assertEquals(got.source_hash, rec.source_hash, '重启后 source_hash 应一致');
      assertEquals(got.summary, rec.summary, '重启后摘要文本应一致');
      console.log(`       [实测] 摘要 ok、来源范围 [0,${msgs.length})、可重启恢复、原文未被删`);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('CTX-E18 摘要错写/损坏/模型故障：不静默当成功，不把摘要当批准经验', async () => {
    const d = base();
    try {
      // ① 没有模型 ⇒ degraded（确定性裁剪），绝不标 ok
      const h1 = await makeHost({ base: join(d, 'a') || d, modelText: null });
      mkdirSync(join(d, 'a'), { recursive: true });
      const hA = await makeHost({ base: join(d, 'a'), modelText: null });
      await hA.svc.create(spec('cell-A', hA.ws), { trusted: true });
      await hA.ctx.bind('cell-A', { profileId: 'ctx-v1' });
      await hA.svc.accept('cell-A', task('t1', 'cell-A'));
      await hA.svc.execute('cell-A');
      const degraded = await hA.compaction.compact({ messages: msgs, cellId: 'cell-A', sessionId: 's-d' });
      assertEquals(degraded.status, 'degraded', `无模型时应 degraded，实际 ${degraded.status}`);
      assert(String(degraded.reason).includes('deterministic'), '降级理由应说明用的是确定性裁剪');
      assert(degraded.summary.includes('降级摘要'), '降级产物必须自标"降级"');
      assert(degraded.summary.includes('非模型生成'), '降级产物必须自标非模型生成');

      // ② 模型抛错 ⇒ failed，且**不带** summary（没有内容就不装作有）
      const base2 = join(d, 'b'); mkdirSync(base2, { recursive: true });
      const hB = await makeHost({ base: base2 });
      hB.core.getService('model').call = async () => { throw new Error('upstream 500'); };
      await hB.svc.create(spec('cell-B', hB.ws), { trusted: true });
      await hB.ctx.bind('cell-B', { profileId: 'ctx-v1' });
      await hB.svc.accept('cell-B', task('t1', 'cell-B'));
      await hB.svc.execute('cell-B');
      const failed = await hB.compaction.compact({ messages: msgs, cellId: 'cell-B', sessionId: 's-f' });
      assertEquals(failed.status, 'failed', `模型故障时应 failed，实际 ${failed.status}`);
      assertEquals(failed.summary, undefined, 'failed 记录不得携带 summary');
      assert(String(failed.reason).includes('500') || String(failed.reason).includes('failed'), '失败原因应可见');

      // ③ 磁盘上的摘要被写坏 ⇒ loadSummary 具名报错（不得静默注入半截）
      const f = join(base2, 'state', 'cells', 'cell-B', 'context', 'summaries', 's-f.json');
      assert(existsSync(f), '应有 failed 记录落盘');
      writeFileSync(f, '{ this is not json');
      const corrupt = await codeOf(() => hB.ctx.loadSummary('cell-B', 's-f'));
      assertEquals(corrupt.ok, false, '损坏的摘要必须具名失败');
      assertEquals(corrupt.code, 'summary_corrupt', `应为 summary_corrupt，实际 ${corrupt.code}`);

      // ④ 摘要不得进入经验 active 库（两者路径与语义都不同）
      const expFile = join(base2, 'experience', 'active.jsonl');
      assert(!existsSync(expFile), '压缩不得凭空产生经验 store（摘要 ≠ 经验）');
      console.log('       [实测] 无模型→degraded；模型故障→failed 无 summary；损坏→summary_corrupt；摘要不进经验库');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('CTX-E19 双 Cell 摘要并发：A/B 历史互不污染，状态不交叉', async () => {
    const d = base();
    try {
      // 两个 Cell = 两个独立 stateDir + 独立 workspace（v0 的 1 Cell : 1 Core）
      const baseA = join(d, 'A'); mkdirSync(baseA, { recursive: true });
      const baseB = join(d, 'B'); mkdirSync(baseB, { recursive: true });
      const hA = await makeHost({ base: baseA, modelText: '1. 目标：A 的目标\n2. 事实：A 的事实' });
      const hB = await makeHost({ base: baseB, modelText: '1. 目标：B 的目标\n2. 事实：B 的事实' });
      for (const [h, id] of [[hA, 'cell-A'], [hB, 'cell-B']]) {
        await h.svc.create(spec(id, h.ws), { trusted: true });
        await h.ctx.bind(id, { profileId: 'ctx-v1' });
        await h.svc.accept(id, task('t1', id));
        await h.svc.execute(id);
      }

      // 并发压缩各自的历史
      const [ra, rb] = await Promise.all([
        hA.compaction.compact({ messages: [{ role: 'user', content: 'A 的历史' }], cellId: 'cell-A', sessionId: 's-shared' }),
        hB.compaction.compact({ messages: [{ role: 'user', content: 'B 的历史' }], cellId: 'cell-B', sessionId: 's-shared' }),
      ]);
      assertEquals(ra.cell_id, 'cell-A', 'A 的记录归属 cell-A');
      assertEquals(rb.cell_id, 'cell-B', 'B 的记录归属 cell-B');
      assert(ra.summary.includes('A 的目标'), 'A 的摘要应来自 A 的模型输出');
      assert(rb.summary.includes('B 的目标'), 'B 的摘要应来自 B 的模型输出');
      assert(!ra.summary.includes('B 的目标'), 'A 的摘要不得含 B 的内容');
      assert(!rb.summary.includes('A 的目标'), 'B 的摘要不得含 A 的内容');

      // 同名 sessionId（`s-shared`）在磁盘上是两个不同文件 —— 路径上不可能串
      const fa = join(baseA, 'state', 'cells', 'cell-A', 'context', 'summaries', 's-shared.json');
      const fb = join(baseB, 'state', 'cells', 'cell-B', 'context', 'summaries', 's-shared.json');
      assert(existsSync(fa) && existsSync(fb), '两边的摘要文件都应存在（同名 session 不冲突）');
      assertEquals(JSON.parse(readFileSync(fa, 'utf8')).cell_id, 'cell-A', 'A 文件里的 cell_id 应为 cell-A');
      assertEquals(JSON.parse(readFileSync(fb, 'utf8')).cell_id, 'cell-B', 'B 文件里的 cell_id 应为 cell-B');

      // 版本单调：再写一次 A ⇒ 版本 2，且 B 不受影响
      const ra2 = await hA.compaction.compact({ messages: [{ role: 'user', content: 'A 的第二次历史' }], cellId: 'cell-A', sessionId: 's-shared' });
      assertEquals(ra2.summary_version, 2, `同会话第二次摘要版本应为 2，实际 ${ra2.summary_version}`);
      const bStill = JSON.parse(readFileSync(fb, 'utf8'));
      assertEquals(bStill.cell_id, 'cell-B', 'A 的二次写入不得影响 B 的文件');
      console.log('       [实测] A/B 同名 session 摘要分属两个文件、内容不串、版本各自单调');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('CTX-E19b 256+ 会话：不因容量淘汰把另一 Cell 的摘要变成别人的历史', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d });
      await h.svc.create(spec('cell-A', h.ws), { trusted: true });
      await h.ctx.bind('cell-A', { profileId: 'ctx-v1' });
      await h.svc.accept('cell-A', task('t1', 'cell-A'));
      await h.svc.execute('cell-A');

      // 写 300 个会话摘要，其中第一个是"要保住"的那条
      const first = await h.compaction.compact({ messages: msgs, cellId: 'cell-A', sessionId: 's-keep' });
      for (let i = 0; i < 300; i++) {
        await h.compaction.compact({ messages: msgs, cellId: 'cell-A', sessionId: `s-${i}` });
      }
      // 落盘方案没有 256 上限 —— 关键那条仍然按原样读得到
      const kept = await h.ctx.loadSummary('cell-A', 's-keep');
      assert(kept, '最早写入的摘要不因容量被人为淘汰');
      assertEquals(kept.summary, first.summary, '被保住的那条摘要内容不得改变');
      assertEquals(kept.cell_id, 'cell-A', '归属不得变');
      const listed = await h.ctx.listSummaries('cell-A');
      assert(listed.length > 256, `磁盘上应保留全部 ${listed.length} 条（旧实现上限 256）`);
      console.log(`       [实测] 写入 301 条摘要，最早的仍原样可读；磁盘保留 ${listed.length} 条（无 256 淘汰）`);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
}
