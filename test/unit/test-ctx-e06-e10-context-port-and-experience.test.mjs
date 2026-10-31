// CTX-E06~E08（PR-2）+ CTX-E20（统一预算）：ContextPort 的目录、按需读取与越界拒绝。
//
// 判据一律落在"模型/工具**实际**拿到了什么"上，而不是"配置里写了什么"：
//   · E06 断言首轮输入**只有**目录元数据，正文没被预加载；
//   · E07 断言 pull 真的读到了指定 ref 的正文，且带 ref/range/hash；
//   · E08 断言跨 Cell / 未授权 ref 被具名拒绝，且模型侧**没有**看到秘密内容；
//   · E20 断言拼完所有片段后的**最终**请求仍受同一预算约束（后注入不再逃逸）。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TestRunner, assert, assertEquals } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(join(ROOT, rel));

const SECRET = 'TOP-SECRET-DO-NOT-LEAK-9f3a';

/** 最小 Cell 宿主 + profile + manifest + 静态经验。 */
async function makeHost({ base, id = 'A', profileOver = {}, manifestItems = null, activeExp = null, probe = null }) {
  const ws = join(base, `ws-${id}`);
  const profRoot = join(base, 'profiles');
  const resRoot = join(base, 'resources');
  const expRoot = join(base, 'experience');
  mkdirSync(ws, { recursive: true });
  mkdirSync(join(resRoot, 'docs'), { recursive: true });
  mkdirSync(profRoot, { recursive: true });
  mkdirSync(expRoot, { recursive: true });

  writeFileSync(join(resRoot, 'docs', 'arch.md'), `# 架构\n\n这是一份架构文档。\n${'填充内容。'.repeat(400)}\n结尾标记-END-OF-ARCH\n`);
  writeFileSync(join(resRoot, 'docs', 'secret.md'), `# 机密\n${SECRET}\n`);
  writeFileSync(join(resRoot, 'docs', 'notes.md'), '# 笔记\n一些笔记。\n');

  const items = manifestItems ?? [
    { ref: 'context:arch-1', title: '架构说明', type: 'doc', source: 'docs/arch.md', brief: '整体架构与边界' },
    { ref: 'context:notes-1', title: '工作笔记', type: 'note', source: 'docs/notes.md', brief: '随手笔记' },
  ];
  writeFileSync(join(resRoot, '.context-manifest.json'), JSON.stringify({
    schema_version: 'tusunsun.context-manifest/v0', items,
  }, null, 2));

  const profile = {
    schema_version: 'tusunsun.context-profile/v0',
    profile_id: 'ctx-v1',
    system_prompt_ref: 'local:docs/notes.md',
    retrieval: { provider: 'local-manifest', mode: 'on-demand', map_max_tokens: 200, pull_max_tokens: 800 },
    compaction: { provider: 'structured-llm', max_summary_tokens: 300 },
    experience: { provider: activeExp ? 'static' : 'none', passive: 'relevant-only', max_hints: 2, active_pull: true },
    budget: { input_max_tokens: 4000, response_reserve_tokens: 400 },
    ...profileOver,
  };
  writeFileSync(join(profRoot, 'ctx-v1.json'), JSON.stringify(profile, null, 2));

  if (activeExp) {
    writeFileSync(join(expRoot, 'active.jsonl'), activeExp.map((e) => JSON.stringify(e)).join('\n'));
  }
  writeFileSync(join(expRoot, 'active.jsonl'), activeExp ? activeExp.map((e) => JSON.stringify(e)).join('\n') : '');

  const { Core } = await imp('src/core/core.js');
  const core = new Core({ stateDir: join(base, `state-${id}`) });
  core.log = () => {};
  core.setData('agent.workDir', ws);
  const cfg = {
    cells: {
      context: {
        enabled: true, profileRoot: profRoot, resourceRoot: resRoot,
        experienceRoot: expRoot, allowedProfiles: ['ctx-v1'],
      },
    },
    agent: { systemPrompt: null },
  };
  core.registerService('config', {
    get: (p, f) => {
      let c = cfg;
      for (const k of String(p).split('.')) { if (c == null || typeof c !== 'object') return f; c = c[k]; }
      return c === undefined ? f : c;
    },
    data: cfg,
  });
  await (await imp('plugins/workspace.js')).default.init(core);
  core.registerCapability('tool.read', { owner: 'test', handler: async () => 'read' });
  core.registerCapability('tool.write', { owner: 'test', handler: async () => 'write' });

  const captured = [];
  const probeOut = {};
  core.registerCapability('chat.handle', {
    owner: 'test',
    handler: async (params) => {
      const ctx = core.getService('cell-context')?.profileForSession?.(params.sessionId) || null;
      captured.push({ sessionId: params.sessionId, goal: params.message, profile: ctx?.profile ?? null });
      // probe 在**执行作用域内**运行 —— 与模型调用工具的时刻一致。
      // 放到 execute() 之后调是错的：那时作用域已按设计撤销（CTX-E21 正是在验这一点）。
      if (probe) {
        try { probeOut.result = await probe(core, params.sessionId); }
        catch (e) { probeOut.error = e; }
      }
      return { reply: 'ok' };
    },
  });

  const rt = Object.create((await imp('plugins/cell-runtime.js')).default);
  await rt.init(core);
  const cc = Object.create((await imp('plugins/cell-context.js')).default);
  await cc.init(core);
  const cp = Object.create((await imp('plugins/context-port.js')).default);
  await cp.init(core);
  const ep = Object.create((await imp('plugins/experience-port.js')).default);
  await ep.init(core);

  return { core, ws, profRoot, resRoot, expRoot, captured, probeOut, svc: core.getService('cell-runtime'), ctx: core.getService('cell-context'), cp: core.getService('context-port'), ep: core.getService('experience-port') };
}

const spec = (id, workspace) => ({
  schema_version: 'tusunsun.cell/v0', cell_id: id, workspace,
  capabilities: ['tool.read', 'tool.write'], permission_mode: 'auto',
  runtime: { kind: 'process' }, limits: { max_active_tasks: 1, max_children: 0 },
});

const task = (id, cellId, over = {}) => ({
  schema_version: 'tusunsun.task/v0', task_id: id, attempt: 1, target_cell_id: cellId,
  goal: '落实架构改造', inputs: [], required_capabilities: ['tool.read'],
  budget: { max_steps: 10, wall_ms: 30000 },
  acceptance: { required_artifacts: [], checks: [] }, ...over,
});

const codeOf = async (fn) => {
  try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, code: e.code, message: e.message }; }
};

export async function setup(runner) {
  const base = () => mkdtempSync(join(tmpdir(), 'ctx-e06-'));

  runner.test('CTX-E06 目录很大时：只发有限元数据，正文不进首轮输入，截断有记录', async () => {
    const d = base();
    try {
      // 40 条条目 —— 目录本身必须被截断
      const items = Array.from({ length: 40 }, (_, i) => ({
        ref: `context:item-${i}`, title: `文档 ${i}`, type: 'doc',
        source: 'docs/notes.md', brief: `第 ${i} 条说明`.repeat(3),
      }));
      const h = await makeHost({
        base: d, manifestItems: items,
        probe: async (core, sid) => {
          const cp = core.getService('context-port');
          const a = await cp.assemble(sid, { history: [{ role: 'user', content: '当前任务' }] });
          return { map: a.map, receipt: a.receipt, system: a.messages[0].content };
        },
      });
      await h.svc.create(spec('cell-A', h.ws), { trusted: true });
      await h.ctx.bind('cell-A', { profileId: 'ctx-v1' });
      await h.svc.accept('cell-A', task('t1', 'cell-A'));
      const res = await h.svc.execute('cell-A');
      assertEquals(res.execution_state, 'succeeded', `应成功，实际 ${res.execution_state}/${res.error}`);
      assert(!h.probeOut.error, `装配不应抛错：${h.probeOut.error?.message}`);

      const { map, receipt, system } = h.probeOut.result;
      assert(map.truncated === true, '40 条超过上限时 map.truncated 必须为 true');
      assert(map.items.length < 40, `目录必须被截断，实际 ${map.items.length} 条`);
      assertEquals(map.total, 40, `total 应报告真实总数 40，实际 ${map.total}`);
      for (const it of map.items) {
        assert(!('text' in it), `目录条目 ${it.ref} 不得携带正文`);
      }
      // 渲染进系统消息的是"目录清单"，不是文档正文
      assert(system.includes('可用上下文目录'), '系统消息里应有目录块');
      assert(system.includes('context:item-0'), '目录块应含 ref');
      assert(!system.includes('结尾标记-END-OF-ARCH'), '系统消息不得包含文档正文（正文只能经 pull 取）');
      assertEquals(receipt.injection.map_items, map.items.length, '回执应记录实际目录条数');

      // 回执真的落盘了
      const receipts = await h.ctx.readReceipts('cell-A', 5);
      assert(receipts.length >= 1, '应有装配回执落盘');
      assertEquals(receipts[receipts.length - 1].injection.map_items, map.items.length, '落盘回执的目录条数应一致');
      console.log(`       [实测] 40 条 → 发出 ${map.items.length} 条元数据、truncated=true、系统消息无正文、回执已落盘`);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('CTX-E07 按需 pull 正例：确实读到指定 ref 的真实片段，返回来源/范围/hash', async () => {
    const d = base();
    try {
      const h = await makeHost({
        base: d,
        probe: async (core, sid) => {
          const cp = core.getService('context-port');
          const first = await cp.pull(sid, { ref: 'context:arch-1' });
          const more = await cp.pull(sid, { ref: 'context:arch-1', offset_bytes: first.next_offset_bytes });
          return { first, more };
        },
      });
      await h.svc.create(spec('cell-A', h.ws), { trusted: true });
      await h.ctx.bind('cell-A', { profileId: 'ctx-v1' });
      await h.svc.accept('cell-A', task('t1', 'cell-A'));
      await h.svc.execute('cell-A');
      assert(!h.probeOut.error, `pull 不应抛错：${h.probeOut.error?.message}`);

      const { first: slice, more } = h.probeOut.result;
      assert(slice.text.includes('这是一份架构文档'), `应读到真实正文，实际：${slice.text.slice(0, 80)}`);
      assertEquals(slice.ref, 'context:arch-1', 'ref 应回显');
      assertEquals(slice.source, 'docs/arch.md', 'source 应回显相对路径');
      assert(slice.byte_range.total > slice.byte_range.to - slice.byte_range.from, '长文档应被截断（range.total 大于本次长度）');
      assertEquals(slice.truncated, true, '长文档 slice.truncated 应为 true');
      assert(/^[0-9a-f]{64}$/.test(slice.sha256), 'sha256 必须是 64 位小写 hex');
      assert(slice.estimated_tokens > 0, '应给出估算 token');
      assert(slice.next_offset_bytes > 0, '截断时应给出续读偏移');
      assert(more.byte_range.from > 0, '续读的起始偏移应大于 0');
      assert(more.text !== slice.text, '续读内容应不同于首段');
      console.log(`       [实测] pull 读到 ${slice.text.length} 字符、range=${JSON.stringify(slice.byte_range)}、可续读`);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('CTX-E08 未授权 ref / 裸路径 / 跨 Cell：具名拒绝，模型看不到秘密', async () => {
    const d = base();
    try {
      // manifest 里**没有** secret.md —— 它存在于资源根，但不在授权清单里
      const h = await makeHost({
        base: d,
        probe: async (core, sid) => {
          const cp = core.getService('context-port');
          const out = {};
          out.unlisted = await codeOf(() => cp.pull(sid, { ref: 'context:secret-1' }));
          out.bare = [];
          for (const bad of ['docs/secret.md', '/etc/passwd', 'http://evil/x', '../outside.md']) {
            out.bare.push({ ref: bad, ...(await codeOf(() => cp.pull(sid, { ref: bad }))) });
          }
          out.impostor = await codeOf(() => cp.pull('cell-IMPOSTOR', { ref: 'context:arch-1' }));
          out.map = await cp.map(sid, {});
          return out;
        },
      });
      await h.svc.create(spec('cell-A', h.ws), { trusted: true });
      await h.ctx.bind('cell-A', { profileId: 'ctx-v1' });
      await h.svc.accept('cell-A', task('t1', 'cell-A'));
      await h.svc.execute('cell-A');
      assert(!h.probeOut.error, `探针不应抛错：${h.probeOut.error?.message}`);
      const o = h.probeOut.result;

      assertEquals(o.unlisted.ok, false, '未列出的 ref 必须拒绝');
      assertEquals(o.unlisted.code, 'unknown_context_ref', `应为 unknown_context_ref，实际 ${o.unlisted.code}`);
      assert(!String(o.unlisted.message).includes(SECRET), '拒绝信息里不得包含秘密内容');

      for (const r of o.bare) {
        assertEquals(r.ok, false, `${r.ref} 必须被拒绝`);
        assert(!String(r.message).includes(SECRET), `${r.ref} 的拒绝信息不得含秘密`);
      }

      assertEquals(o.impostor.ok, false, '伪造 cell_id 必须失败');
      assertEquals(o.impostor.code, 'no_execution_scope', `应为 no_execution_scope，实际 ${o.impostor.code}`);

      assert(!JSON.stringify(o.map).includes(SECRET), '目录里绝不出现秘密内容');
      console.log('       [实测] 未授权 ref/裸路径/伪造 cell 全拒；秘密未出现在任何返回值中');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('CTX-E20 后注入片段与整体预算：最终请求超额时裁低优先级材料，system 不裁', async () => {
    const d = base();
    try {
      const { enforceBudget, estimateMessagesTokens } = await imp('plugins/_lib/context-budget.js');
      const msgs = [
        { role: 'system', content: 'SYS-IDENTITY ' + 'x'.repeat(400) },
        { role: 'user', content: 'old question ' + 'y'.repeat(2000) },
        { role: 'assistant', content: 'old answer ' + 'z'.repeat(2000) },
        { role: 'user', content: 'current question' },
      ];
      const tight = enforceBudget({ messages: msgs, limit: 1200, reserve: 200 });
      assertEquals(tight.ok, true, '应能在裁剪后装下');
      assert(tight.trimmed === true, '必须标记为已裁剪');
      assertEquals(tight.messages[0].role, 'system', 'system 必须仍在第一位');
      assert(tight.messages[0].content.startsWith('SYS-IDENTITY'), 'system 内容必须原样保留（不得裁身份）');
      assertEquals(tight.messages[tight.messages.length - 1].content, 'current question', '最新 user 消息必须保留');
      assert(estimateMessagesTokens(tight.messages) <= 1000, '裁剪后必须真的落在可用预算内');

      const impossible = enforceBudget({
        messages: [{ role: 'system', content: 'y'.repeat(40000) }, { role: 'user', content: 'q' }],
        limit: 200, reserve: 20,
      });
      assertEquals(impossible.ok, false, 'system 超预算时必须失败');
      assertEquals(impossible.code, 'context_budget_exceeded', `应为 context_budget_exceeded，实际 ${impossible.code}`);

      // 只剩 system = 任务没被表达出来 ⇒ 必须失败（不是"装下了"）
      const noTask = enforceBudget({
        messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'z'.repeat(8000) }],
        limit: 400, reserve: 20,
      });
      assertEquals(noTask.ok, false, '丢弃全部任务内容后不得报成功（那会发出一个只有身份、没有任务的请求）');
      assertEquals(noTask.code, 'context_budget_exceeded', '应为 context_budget_exceeded');

      const paired = [
        { role: 'system', content: 'S' },
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'tool-read', arguments: '{}' }] },
        { role: 'tool', tool_call_id: 'c1', content: 'r'.repeat(3000) },
        { role: 'user', content: 'u2' },
      ];
      const cut = enforceBudget({ messages: paired, limit: 600, reserve: 0 });
      const hasTool = cut.messages.some((m) => m.role === 'tool');
      const hasCall = cut.messages.some((m) => Array.isArray(m.tool_calls) && m.tool_calls.length);
      assertEquals(hasTool, hasCall, `tool_calls 与 tool 结果必须同进同出（tool=${hasTool}, call=${hasCall}）`);

      // 真实 Cell 路径：目标本身超出输入预算。
      // 注意：本用例的 chat.handle 是**模拟的**，haotian-lite 不在链上，因此这里验证的是
      // "装配层把这份 messages 交给预算门时会失败"，而不是"整条模型请求被拒"。
      // 后者的端到端验证在 CTX-E22 / integration（真 haotian-lite + 模拟模型端点）。
      const h = await makeHost({
        base: d,
        profileOver: { budget: { input_max_tokens: 900, response_reserve_tokens: 200 } },
        probe: async (core, sid) => {
          const bigGoal = '任务目标：' + '这段是冗长任务描述。'.repeat(400);
          const a = await core.getService('context-port').assemble(sid, {
            history: [{ role: 'user', content: bigGoal }],
          });
          const { enforceBudget } = await import(join(ROOT, 'plugins/_lib/context-budget.js'));
          return enforceBudget({
            messages: a.messages, limit: 900, reserve: 200,
          });
        },
      });
      await h.svc.create(spec('cell-A', h.ws), { trusted: true });
      await h.ctx.bind('cell-A', { profileId: 'ctx-v1' });
      await h.svc.accept('cell-A', task('t1', 'cell-A'));
      await h.svc.execute('cell-A');
      assert(!h.probeOut.error, `探针不应抛错：${h.probeOut.error?.message}`);
      const verdict = h.probeOut.result;
      assertEquals(verdict.ok, false, '超预算的装配结果必须被预算门拒绝');
      assertEquals(verdict.code, 'context_budget_exceeded', `应为 context_budget_exceeded，实际 ${verdict.code}`);
      console.log(`       [实测] 纯函数裁剪正确；system 超预算/只剩身份 均具名失败；装配层超预算被拒 (${verdict.code})`);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('CTX-E12 provider 不存在：不注入凭空的 hint、read 具名拒绝、普通任务仍成功', async () => {
    const d = base();
    try {
      const h = await makeHost({
        base: d, profileOver: { experience: { provider: 'none' } },
        probe: async (core, sid) => {
          const ep = core.getService('experience-port');
          return {
            hints: await ep.lookup(sid, { goal_brief: '落实架构改造' }),
            read: await codeOf(() => ep.read(sid, { ref: 'exp-anything@1' })),
          };
        },
      });
      await h.svc.create(spec('cell-A', h.ws), { trusted: true });
      await h.ctx.bind('cell-A', { profileId: 'ctx-v1' });
      await h.svc.accept('cell-A', task('t1', 'cell-A'));
      const res = await h.svc.execute('cell-A');
      assertEquals(res.execution_state, 'succeeded', `无经验服务时任务仍须成功，实际 ${res.execution_state}/${res.error}`);
      assert(!h.probeOut.error, `探针不应抛错：${h.probeOut.error?.message}`);

      const o = h.probeOut.result;
      assertEquals(o.hints.length, 0, 'provider=none 时 hint 必须为 0 条');
      assertEquals(o.read.ok, false, 'provider=none 时 read 必须拒绝');
      assertEquals(o.read.code, 'experience_provider_none', `应为 experience_provider_none，实际 ${o.read.code}`);
      console.log('       [实测] provider=none → 0 条 hint、read 具名拒绝、任务成功');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('CTX-E09 经验被动命中：精准任务获少量 hint，来源与适用条件齐全', async () => {
    const d = base();
    try {
      const exp = {
        schema_version: 'tusunsun.experience/v0',
        experience_id: 'exp-writepath-001', revision: 2, status: 'active',
        scope: { project_id: null, environment_tags: ['node'], visibility: 'project' },
        kind: 'failure-lesson',
        title: '工作目录绑定失效时不能静默回退',
        trigger: ['workspace_unavailable', 'resume_session'],
        lesson: '历史仍属于旧工作区时应拒绝执行，先重新确认绑定。',
        applies_when: ['存在持久会话', '任务涉及工作区文件'],
        does_not_apply_when: ['完全无状态的单次任务'],
        suggested_check: '读取当前绑定真值并验证工作目录。',
        evidence_refs: ['evidence:workspace-regression-01'],
        reviewed_by: 'maintainer',
        valid_until: null,
      };
      const h = await makeHost({
        base: d, activeExp: [exp],
        probe: async (core, sid) => core.getService('experience-port').lookup(sid, { goal_brief: '遇到 workspace_unavailable 怎么处理' }),
      });
      await h.svc.create(spec('cell-A', h.ws), { trusted: true });
      await h.ctx.bind('cell-A', { profileId: 'ctx-v1' });
      await h.svc.accept('cell-A', task('t1', 'cell-A'));
      await h.svc.execute('cell-A');
      assert(!h.probeOut.error, `探针不应抛错：${h.probeOut.error?.message}`);

      const hints = h.probeOut.result;
      assertEquals(hints.length, 1, `应命中 1 条，实际 ${hints.length}`);
      const h0 = hints[0];
      assertEquals(h0.ref, 'exp-writepath-001@2', 'ref 应带版本');
      assert(h0.title.includes('工作目录绑定'), 'hint 应含标题');
      assert(Array.isArray(h0.applies_when) && h0.applies_when.length, 'hint 必须带适用条件');
      assertEquals(h0.trust, 'low', 'hint 必须标为低信任');
      assert(h0.rendered.includes('低信任数据'), '渲染文本必须显式标注低信任');
      assert(h0.rendered.includes('不是指令'), '渲染文本必须说明它不是指令');
      assert(h0.rendered.includes('experience-pull'), '渲染文本应给出主动深读方式');
      console.log(`       [实测] 命中 1 条（${h0.ref}），带适用条件与低信任标注`);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('CTX-E10 经验不相关：模型输入里 0 条，不"塞一堆备选"', async () => {
    const d = base();
    try {
      const exp = {
        schema_version: 'tusunsun.experience/v0',
        experience_id: 'exp-other-001', revision: 1, status: 'active',
        scope: { project_id: null, environment_tags: [], visibility: 'project' },
        kind: 'failure-lesson', title: '完全无关的经验',
        trigger: ['kubernetes_quota_exceeded'],
        lesson: '这是一条与当前任务无关的经验。',
        applies_when: ['k8s 集群配额'], does_not_apply_when: [],
        evidence_refs: ['evidence:x'],
      };
      const h = await makeHost({
        base: d, activeExp: [exp],
        probe: async (core, sid) => core.getService('experience-port').lookup(sid, { goal_brief: '写一个 README 文件' }),
      });
      await h.svc.create(spec('cell-A', h.ws), { trusted: true });
      await h.ctx.bind('cell-A', { profileId: 'ctx-v1' });
      await h.svc.accept('cell-A', task('t1', 'cell-A'));
      await h.svc.execute('cell-A');
      assert(!h.probeOut.error, `探针不应抛错：${h.probeOut.error?.message}`);
      assertEquals(h.probeOut.result.length, 0, `不相关任务必须 0 条，实际 ${h.probeOut.result.length}`);
      console.log('       [实测] 不相关任务 → 0 条 hint（不是"塞一堆备选"）');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
}
