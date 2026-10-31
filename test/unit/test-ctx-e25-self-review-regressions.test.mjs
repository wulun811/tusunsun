// CTX-E25 ~ E32（v0.9.23 自审回归）：把本轮**自查发现并修掉**的真阳性缺陷钉住。
//
// 这一批用例的形状和别处不同：每一条都先描述"修前会怎么错"，再断言"现在会怎么说"。
// 之所以值得单独一个文件，是因为这八个缺陷全都有同一个特征 ——
// **代码看起来是对的、字段名是对的、日志也正常，功能就是不生效**，
// 而且原有的 30 条 CTX 用例一条都没拦住它们。用例如下：
//
//   E25 服务面缺 loadBinding：网关端点恒回 no_binding、重启后绑定丢失
//   E26 accept 后 unbind：在飞任务的工作身份被悄悄换成宿主默认提示词
//   E27 经验库永久缓存：撤销/过期在进程内永不生效（"状态即权限"只在重启后成立）
//   E28 readReceipts 路径穿越：能读 state 目录之外的任意 receipts.jsonl
//   E29 enforceBudget 跳过装不下的当前任务、继续收更旧的消息并报 ok
//   E30 回执 pulled_refs 恒 0、profile_sha256 填错字段
//   E31 三条互不相同的 token 估算口径（中文提示被低估 2.2 倍、回执低估 26 倍）
//   E32 compaction 零生产调用点：Cell 摘要实际仍走 context-manager 的内存 Map
//
// 诚实边界：E32 用真实的 context-manager + compaction 两个插件跑真实 trimMessages，
// 但 chat.handle 是模拟的（本文件不拉起模型端点）；端到端形态由 examples/cells 覆盖。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { TestRunner, assert, assertEquals } from '../harness.mjs';

// v0.10.1：`import.meta.dirname` 是 Node 20.11+ / 21.2+ 才有的。
// Node 18 上它是 undefined ⇒ `join(undefined, ...)` 抛 "The path argument must be of type string"
// ⇒ 整个测试文件**加载失败**。而测试跑手当时把"加载失败"只打一行日志、不计数 ——
// 于是这 18 条用例在 Node 18 上**静默消失**，退出码仍是 0。见 run-unit.mjs 的修复。
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (rel) => import(join(ROOT, rel));

const PROFILE = (over = {}) => ({
  schema_version: 'tusunsun.context-profile/v0',
  profile_id: 'p',
  system_prompt_ref: 'local:prompts/p.md',
  ...over,
});

/** 造一个最小宿主：真 Core + 真插件，只有 chat.handle / model 是模拟的。 */
async function makeHost({ base, profile = PROFILE(), prompts = { p: '你是实现者。' }, experience = null, model = null, ctxCfg = {} }) {
  const ws = join(base, 'ws');
  const profRoot = join(base, 'profiles');
  const resRoot = join(base, 'resources');
  mkdirSync(ws, { recursive: true });
  mkdirSync(profRoot, { recursive: true });
  mkdirSync(join(resRoot, 'prompts'), { recursive: true });
  for (const [n, body] of Object.entries(prompts)) writeFileSync(join(resRoot, 'prompts', `${n}.md`), body);
  writeFileSync(join(profRoot, `${profile.profile_id}.json`), JSON.stringify(profile, null, 2));

  const cfg = { cells: { context: { enabled: true, profileRoot: profRoot, resourceRoot: resRoot } }, context: ctxCfg };
  if (experience) {
    const expRoot = join(base, 'experience');
    mkdirSync(expRoot, { recursive: true });
    writeFileSync(join(expRoot, 'active.jsonl'), (experience.active || []).map((r) => JSON.stringify(r)).join('\n') + (experience.active?.length ? '\n' : ''));
    writeFileSync(join(expRoot, 'candidates.jsonl'), (experience.candidates || []).map((r) => JSON.stringify(r)).join('\n'));
    cfg.cells.context.experienceRoot = expRoot;
  }
  if (profile.retrieval?.provider === 'local-manifest') {
    // 调用方自己写 manifest 到 resRoot
  }

  const { Core } = await imp('src/core/core.js');
  const core = new Core({ stateDir: join(base, 'state') });
  core.log = () => {};
  core.setData('agent.workDir', ws);
  core.registerService('config', {
    get: (p, f) => {
      let c = cfg;
      for (const k of String(p).split('.')) { if (c == null || typeof c !== 'object') return f; c = c[k]; }
      return c === undefined ? f : c;
    },
    data: cfg,
  });
  if (model) {
    core.registerService('model', { supportsNativeTools: true, call: async () => ({ content: model }), callTier: async () => ({ reply: 'ok' }) });
  }
  await (await imp('plugins/workspace.js')).default.init(core);
  for (const cap of ['tool.read', 'tool.write', 'tool.experience-pull']) {
    core.registerCapability(cap, { owner: 'test', handler: async () => cap });
  }
  core.registerCapability('chat.handle', { owner: 'test', handler: async () => ({ reply: 'ok' }) });
  core.registerService('session', { loadSession: async () => [], saveHistory: () => {} });

  const cc = Object.create((await imp('plugins/cell-context.js')).default);
  await cc.init(core);
  const cp = Object.create((await imp('plugins/context-port.js')).default);
  await cp.init(core);
  const ep = Object.create((await imp('plugins/experience-port.js')).default);
  await ep.init(core);
  const cpd = Object.create((await imp('plugins/compaction.js')).default);
  await cpd.init(core);
  const rt = Object.create((await imp('plugins/cell-runtime.js')).default);
  await rt.init(core);

  return {
    core, ws, profRoot, resRoot,
    svc: core.getService('cell-runtime'),
    ctx: core.getService('cell-context'),
    cp: core.getService('context-port'),
    ep: core.getService('experience-port'),
    compaction: core.getService('compaction'),
  };
}

const spec = (id, workspace) => ({
  schema_version: 'tusunsun.cell/v0', cell_id: id, workspace,
  capabilities: ['tool.read', 'tool.write'], permission_mode: 'auto',
  runtime: { kind: 'process' }, limits: { max_active_tasks: 1, max_children: 0 },
});

const codeOf = async (fn) => {
  try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, code: e.code, message: e.message }; }
};

const expRecord = (over = {}) => ({
  schema_version: 'tusunsun.experience/v0',
  experience_id: 'exp-x-001', revision: 1, status: 'active',
  scope: { project_id: null, environment_tags: [], visibility: 'host' },
  kind: 'failure-lesson',
  title: '写文件前先确认目录存在',
  trigger: ['workspace_unavailable'],
  lesson: '先确认目录存在再写。',
  applies_when: ['本地'], does_not_apply_when: [],
  evidence_refs: ['ev-1'],
  ...over,
});

/** 进入一次执行作用域（任务的全部认知操作都在这个窗口内）。 */
async function enter(h, cellId = 'cell-A', taskId = 't1') {
  const frozen = await h.ctx.freezeForTask(cellId, taskId, 'inc-1', null);
  h.ctx.enterExecution(cellId, frozen);
  return frozen;
}

export async function setup(runner) {
  const base = () => mkdtempSync(join(tmpdir(), 'ctx-e25-'));

  runner.test('CTX-E25 服务面必须暴露 loadBinding：网关端点可读、重启后绑定恢复', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d });
      await h.svc.create(spec('cell-A', h.ws), { trusted: true });
      await h.ctx.bind('cell-A', { profileId: 'p' });

      // ① 服务对象上必须有这个成员。修前没有 ⇒ 网关 `cc.loadBinding(...)` 抛 TypeError，
      //    被 catch 成 `cell_error`；而 create() 里的 `if (ctxSvc?.loadBinding)` 恒假，
      //    于是**不报错、也不恢复** —— 这正是最难发现的那种失败。
      assertEquals(typeof h.ctx.loadBinding, 'function',
        'cell-context 服务必须暴露 loadBinding（网关 cell.context.binding 与 create 的恢复路径都靠它）');

      const viaService = await h.ctx.loadBinding('cell-A');
      assertEquals(viaService.profile_id, 'p', '经服务面应能读到绑定');

      // ② 重启：同一 stateDir 上重建 Core 与插件实例，create() 应把绑定载回内存。
      const { Core } = await imp('src/core/core.js');
      const core2 = new Core({ stateDir: join(d, 'state') });
      core2.log = () => {};
      core2.setData('agent.workDir', h.ws);
      core2.registerService('config', { get: (p, f) => h.core.getService('config').get(p, f), data: h.core.getService('config').data });
      await (await imp('plugins/workspace.js')).default.init(core2);
      for (const cap of ['tool.read', 'tool.write']) core2.registerCapability(cap, { owner: 'test', handler: async () => cap });
      core2.registerCapability('chat.handle', { owner: 'test', handler: async () => ({ reply: 'ok' }) });
      const cc2 = Object.create((await imp('plugins/cell-context.js')).default);
      await cc2.init(core2);
      const rt2 = Object.create((await imp('plugins/cell-runtime.js')).default);
      await rt2.init(core2);
      // **进程内模拟重启**必须显式 `forceOwner`（rc.33 / R32-01）：同一 stateDir 只允许一个活属主，
      // 真实重启由进程退出完成；进程内只能用这个显式动作表达"旧属主不再使用"。
      await core2.getService('cell-runtime').create(spec('cell-A', h.ws), { trusted: true, forceOwner: true });

      const restored = core2.getService('cell-context').bindingSnapshot('cell-A');
      assert(restored, '重启后 create() 必须把磁盘绑定载入内存（否则 accept 钉不住任何版本）');
      assertEquals(restored.profile_id, 'p', '恢复的 profile 应一致');
      console.log('       [实测] 服务面暴露 loadBinding；重启后 bindingSnapshot 可取到（修前恒 null）');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('CTX-E26 accept 之后解绑：在飞任务仍按钉住的快照执行，不退回宿主默认提示词', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d });
      await h.svc.create(spec('cell-A', h.ws), { trusted: true });
      await h.ctx.bind('cell-A', { profileId: 'p' });

      // 模拟 accept 的动作：同步钉住版本
      const pinned = h.ctx.bindingSnapshot('cell-A');
      assertEquals(pinned?.profile_id, 'p', 'accept 时应钉住 p');

      // accept 之后宿主解绑（这是合法操作：撤掉该 Cell 的认知配置）
      await h.ctx.unbind('cell-A');

      // 修前：freezeForTask 以"当前还有没有绑定"为前提 ⇒ 返回 null ⇒ 任务改用宿主默认提示词。
      // 也就是说解绑改变了**已经接下**的任务身份，而报告里一个字都不会显示。
      const frozen = await h.ctx.freezeForTask('cell-A', 't1', 'inc-1', pinned);
      assert(frozen, '已接下任务必须能按钉住的快照冻结（解绑只影响此后 accept 的任务）');
      assertEquals(frozen.profile.profile_id, 'p', '冻结的必须是 accept 时钉住的那一版');
      assert(frozen.system_prompt.includes('你是实现者'), '必须拿到钉住版本的系统提示词');

      // 但**新任务**（没有钉住快照）应当如实走旧路径
      const next = await h.ctx.freezeForTask('cell-A', 't2', 'inc-1', null);
      assertEquals(next, null, '解绑之后的新任务应回到"没有绑定"的旧路径（null）');
      console.log('       [实测] 在飞任务用钉住快照；解绑只影响后续任务（修前在飞任务会静默换身份）');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('CTX-E27 经验撤销在进程内必须立即生效：read 具名拒绝、lookup 不再召回', async () => {
    const d = base();
    try {
      const h = await makeHost({
        base: d,
        profile: PROFILE({ experience: { provider: 'static' } }),
        experience: { active: [expRecord()] },
      });
      await h.svc.create(spec('cell-A', h.ws), { trusted: true });
      await h.ctx.bind('cell-A', { profileId: 'p' });
      await enter(h);

      // ① 撤销前可读、可召回
      const before = await h.ep.read('cell-A', { ref: 'exp-x-001' });
      assertEquals(before.title, '写文件前先确认目录存在', '撤销前应可读');
      assertEquals((await h.ep.lookup('cell-A', { goal_brief: 'workspace_unavailable' })).length, 1, '撤销前应召回 1 条');

      // ② 宿主撤销：改写 active.jsonl（文件的 mtime/size 随之变化）
      const expRoot = h.core.getService('config').data.cells.context.experienceRoot;
      writeFileSync(join(expRoot, 'active.jsonl'), `${JSON.stringify(expRecord({ status: 'revoked' }))}\n`);

      // 修前：provider 在第一次加载后**永久缓存**，于是这里仍然返回 active 的旧内容 ——
      // "状态即权限"这句话只在进程重启之后成立。
      const after = await codeOf(() => h.ep.read('cell-A', { ref: 'exp-x-001' }));
      assertEquals(after.ok, false, '撤销后 read 必须拒绝');
      assertEquals(after.code, 'experience_unavailable', `应为 experience_unavailable，实际 ${after.code}`);

      const hints = await h.ep.lookup('cell-A', { goal_brief: 'workspace_unavailable' });
      assertEquals(hints.length, 0, '撤销后 lookup 不得再召回');
      console.log('       [实测] 撤销在进程内立即生效（修前需重启进程才生效）');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('CTX-E28 cell_id 必须是 opaque id：readReceipts/listSummaries 不得越出 state 目录', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d });
      await h.svc.create(spec('cell-A', h.ws), { trusted: true });

      // 在 state 目录**之外**放一份 receipts.jsonl，里面有可识别的哨兵
      const SENTINEL = 'OUTSIDE-STATE-DIR-SECRET';
      const outside = join(d, 'outside', 'context');
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, 'receipts.jsonl'), `${JSON.stringify({ secret: SENTINEL })}\n`);

      // 修前：`_cellDir` 直接 `join(stateDir, 'cells', String(cellId))`，于是
      // `../../outside` 会被解析成 state 之外的真实路径，readReceipts 原样返回其内容。
      for (const evil of ['../../outside', '..', 'a/b', '.']) {
        const r = await codeOf(() => h.ctx.readReceipts(evil, 10));
        assertEquals(r.ok, false, `readReceipts(${JSON.stringify(evil)}) 必须拒绝`);
        assert(!String(r.message).includes(SENTINEL), '拒绝信息不得回显被读到的内容');
        const l = await codeOf(() => h.ctx.listSummaries(evil));
        assertEquals(l.ok, false, `listSummaries(${JSON.stringify(evil)}) 必须拒绝`);
      }
      console.log('       [实测] 路径穿越/相对路径/斜杠 id 全拒，外部哨兵未泄露');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('CTX-E29 预算裁剪只能是"连续的最近窗口"：绝不跳过装不下的当前任务去收更旧的消息', async () => {
    const { enforceBudget, estimateMessagesTokens } = await imp('plugins/_lib/context-budget.js');

    const sys = { role: 'system', content: '你是实现者。'.repeat(10) };
    const old1 = { role: 'user', content: '很早的一条问题' };
    const old2 = { role: 'assistant', content: '很早的一条回答' };
    const bigTask = { role: 'user', content: 'A'.repeat(4000) };   // 当前任务
    const messages = [sys, old1, old2, bigTask];
    const total = estimateMessagesTokens(messages);

    // 预算刚好装不下当前任务、却装得下那两条早期短消息 —— 修前正是"跳过它、收更旧的"，
    // 然后返回 ok:true 和一段"没有当前任务的历史"。
    const v = enforceBudget({ messages, limit: total - 500, reserve: 0 });
    assertEquals(v.ok, false, '装不下当前任务时必须失败，不得返回一段没有任务的"成功"');
    assertEquals(v.code, 'context_budget_exceeded', `应为 context_budget_exceeded，实际 ${v.code}`);
    // 失败时调用方拿到的是**原样**输入（不得据此发请求）
    assertEquals(v.messages.length, messages.length, 'ok:false 时 messages 必须是原样输入');

    // 反向确认：放宽预算后必须**保住最新的那条**，且丢的只能是从头开始的连续前缀
    const ok = enforceBudget({ messages, limit: estimateMessagesTokens(messages) - 100, reserve: 0 });
    if (ok.ok) {
      assertEquals(ok.messages.at(-1).content.length, 4000, '最新消息（当前任务）必须保留');
      const sysIdx = ok.messages.findIndex((m) => m.role === 'user');
      assert(sysIdx <= 1, '保留部分必须是"system + 连续尾部"，中间不得有空洞');
    } else {
      assertEquals(ok.code, 'context_budget_exceeded', '要么成功且保住当前任务，要么具名失败');
    }
    console.log('       [实测] 跳过式裁剪已消除：当前任务装不下 ⇒ 具名失败（修前报 ok 并把任务丢了）');
  });

  runner.test('CTX-E30 回执两个字段必须名副其实：pulled_refs 反映真实展开、profile_sha256 是 profile 哈希', async () => {
    const d = base();
    try {
      mkdirSync(join(d, 'resources', 'docs'), { recursive: true });
      const h = await makeHost({
        base: d,
        profile: PROFILE({ retrieval: { provider: 'local-manifest' } }),
      });
      // manifest 与正文
      writeFileSync(join(h.resRoot, 'docs', 'a.md'), 'A 文档正文'.repeat(50));
      writeFileSync(join(h.resRoot, '.context-manifest.json'), JSON.stringify({
        schema_version: 'tusunsun.context-manifest/v0',
        items: [{ ref: 'context:a', title: 'A', type: 'doc', source: 'docs/a.md', brief: 'A 简介' }],
      }));

      await h.svc.create(spec('cell-A', h.ws), { trusted: true });
      const bound = await h.ctx.bind('cell-A', { profileId: 'p' });
      const frozen = await enter(h);

      // ① 先展开一次正文，再进行装配：回执必须记到这次展开
      await h.cp.pull('cell-A', { ref: 'context:a', max_tokens: 100 });
      const a = await h.cp.assemble('cell-A', { goal: '看文档' });

      // 修前：assemble 只读调用方传入的 opts.pulledRefs，而**没有任何调用方会传** ⇒ 恒 0
      assertEquals(a.receipt.injection.pulled_refs, 1,
        `pulled_refs 应反映真实展开次数，实际 ${a.receipt.injection.pulled_refs}`);

      // ② profile_sha256 是 **profile 定义文件**的哈希，与绑定的 profile_sha256 相等；
      //    修前它被填成 system_prompt_sha256（两者按定义不等），一个名字对、值不对的审计字段。
      assertEquals(a.receipt.profile_sha256, bound.profile_sha256,
        'profile_sha256 必须是 profile 定义文件的哈希');
      assert(a.receipt.profile_sha256 !== frozen.system_prompt_sha256,
        'profile_sha256 不得等于提示词内容哈希（那是另一个字段回答的事）');
      // ③ 回执的估算用量量级必须正确（用统一口径对**真实渲染结果**复算）
      const { estimateTokens } = await imp('plugins/_lib/context-budget.js');
      const realSystem = estimateTokens(a.messages[0].content);
      assert(a.receipt.budget.estimate_used >= realSystem * 0.5,
        `回执估算(${a.receipt.budget.estimate_used}) 不得远低于实际 system(${realSystem})`);
      console.log('       [实测] pulled_refs=1、profile_sha256 对齐绑定表（修前恒 0 / 填错字段）');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('CTX-E31 token 估算全仓同一口径：中文提示不被低估，回执不按 [object Object] 计数', async () => {
    const d = base();
    try {
      const h = await makeHost({
        base: d,
        profile: PROFILE({ experience: { provider: 'static', hints_max_tokens: 400 } }),
        experience: { active: [expRecord({ title: '中文标题'.repeat(10), lesson: '这是很长的中文教训，'.repeat(40) })] },
      });
      await h.svc.create(spec('cell-A', h.ws), { trusted: true });
      await h.ctx.bind('cell-A', { profileId: 'p' });
      await enter(h);

      const { estimateTokens } = await imp('plugins/_lib/context-budget.js');
      const hints = await h.ep.lookup('cell-A', { goal_brief: 'workspace_unavailable' });
      assert(hints.length >= 1, '应至少召回一条');

      // ① 每条提示自报的用量必须等于统一口径对**渲染文本**的估算。
      //    修前这里用的是手写 `Math.ceil(line.length / 4)`，中文被低估约 2.2 倍。
      for (const hint of hints) {
        assertEquals(hint.estimated_tokens, estimateTokens(hint.rendered),
          'experience-port 的逐条估算必须与统一口径一致');
        assert(hint.estimated_tokens > Math.ceil(hint.rendered.length / 4),
          '中文提示的估算必须高于 length/4（那正是修前低估的来源）');
      }

      // ② 回执的预算数字必须与"实际渲染进 system 的内容"同量级。
      //    修前它算的是 `hints.join('\n')`，对象被转成 `[object Object]`（15 字符）：
      //    一条 225 token 的提示，回执记 9。
      const a = await h.cp.assemble('cell-A', { goal: 'workspace_unavailable' });
      const realSystem = estimateTokens(a.messages[0].content);
      assert(a.receipt.budget.estimate_used > realSystem * 0.5,
        `回执估算(${a.receipt.budget.estimate_used}) 不得远低于实际 system(${realSystem})`);
      console.log(`       [实测] 逐条估算=${hints[0].estimated_tokens}（不再是 length/4 的低估）；回执=${a.receipt.budget.estimate_used} vs 实际=${realSystem}`);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('CTX-E32 Cell 摘要必须走 compaction 落盘（不再只落内存 Map），且历史摘要不因覆盖而丢失', async () => {
    const d = base();
    try {
      const h = await makeHost({
        base: d,
        profile: PROFILE({ compaction: { provider: 'structured-llm', max_summary_tokens: 400 } }),
        model: '结构化摘要正文',
        ctxCfg: { maxTokens: 900, reserveTokens: 100, strategy: 'summarize' },
      });
      const cm = Object.create((await imp('plugins/context-manager.js')).default);
      await cm.init(h.core);

      await h.svc.create(spec('cell-A', h.ws), { trusted: true });
      await h.ctx.bind('cell-A', { profileId: 'p' });
      const frozen = await enter(h);

      // 造一段超预算历史（走真实 trimMessages，不是直接调 compaction）
      const mkHist = (tag) => {
        const hist = [{ role: 'system', content: frozen.system_prompt }];
        for (let i = 0; i < 12; i++) {
          hist.push({ role: 'user', content: `${tag}问题${i}` + '内容'.repeat(40) });
          hist.push({ role: 'assistant', content: `${tag}回答${i}` + '内容'.repeat(40) });
        }
        hist.push({ role: 'user', content: '当前任务' });
        return hist;
      };

      const out = await cm.trimMessages(mkHist('一'), frozen.system_prompt, [], 'cell-A');
      assert(String(out[0].content).includes('## Conversation Summary'), '摘要应被注入系统消息');

      // ① 摘要必须**落盘到 Cell 范围**。
      //    修前 compaction 服务零生产调用点：Cell 配了 provider 跑完任务，
      //    `cells/<id>/context/summaries/` 目录根本不存在。
      const dir = join(d, 'state', 'cells', 'cell-A', 'context', 'summaries');
      assert(existsSync(dir), 'Cell 摘要目录必须存在（修前不存在：实际走的是内存 Map）');
      const files = readdirSync(dir);
      assertEquals(files.length, 1, `应产生一份摘要，实际 ${files.length}`);
      const rec = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
      assertEquals(rec.status, 'ok', `摘要状态应为 ok，实际 ${rec.status}`);
      assertEquals(rec.generator.provider, 'structured-llm', '必须记录生成器');
      assert(rec.source_range && typeof rec.source_range.to === 'number', '必须带来源范围');

      // ② 第二次压缩必须把**上一版摘要**作为输入带上。
      //    修前 saveSummary 是覆盖写、且 compact 只喂新裁掉的那几轮 ⇒
      //    上一版摘要里的事实被整段丢掉（实测：v1 内容在 v2 之后再也读不回来）。
      const inputs = [];
      h.core.getService('compaction').compact = async (opts) => {
        inputs.push(opts.messages.map((m) => String(m.content).slice(0, 60)));
        return { status: 'ok', summary: '第二版摘要', summary_version: 2 };
      };
      await cm.trimMessages(mkHist('二'), frozen.system_prompt, [], 'cell-A');
      assert(inputs.length === 1, '第二次压缩应发生一次');
      assert(String(inputs[0][0]).includes('历史摘要'), '压缩输入必须携带上一版摘要（否则早期事实永久丢失）');
      console.log('       [实测] 摘要落盘到 cells/<id>/context/summaries/；历史摘要被带入下一轮（修前两者都不成立）');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
}
