// CTX-E33 ~ E35（v0.9.28 策略执行期收口）：把**配置声明了、运行时没人读**的一类缺陷钉住。
//
// 这三条来自第七轮独立评审提出的 W1/W2/W3，先在真实 Core 上复现（全部命中），再修，
// 再用"把判据删掉必须变红"的方式证明新用例真的在守它们。
//
// 三条的共同形状值得单独记一笔：**字段被校验、被持久化、被展示，唯独在放行/拦阻的那一行
// 没有人读它**。
//
//   E33 `retrieval.mode='off'` 只关掉了目录 —— `context.pull({已知 ref})` 照样读出正文
//   E34 `experience.active_pull=false` 被校验并保存，但运行时代码零处读取
//   E35 摘要落盘失败仍回报 `status:'ok'` 且给出一个指向**别人**的版本号
//
// E33/E34 是同一个成因的两次发作（声明与执行之间没有共同收口点），所以修复也不是各补一处，
// 而是各收敛成一个**唯一判据方法**，服务层与工具层共用。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
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

const SECRET = 'SENSITIVE-DATA-FROM-DISABLED-RETRIEVAL';
const LESSON = 'EXPERIENCE-BODY-DISABLED-ACTIVE-PULL';

const baseProfile = (over = {}) => ({
  schema_version: 'tusunsun.context-profile/v0',
  profile_id: 'ctx-v1',
  system_prompt_ref: 'local:docs/p.md',
  retrieval: { provider: 'local-manifest', mode: 'on-demand', map_max_tokens: 200, pull_max_tokens: 800 },
  compaction: { provider: 'structured-llm', max_summary_tokens: 400 },
  experience: { provider: 'none', passive: 'relevant-only', max_hints: 2, active_pull: true },
  budget: { input_max_tokens: 4000, response_reserve_tokens: 400 },
  ...over,
});

/**
 * 最小宿主：真 Core + 真 cell-runtime/cell-context/context-port/experience-port/compaction。
 * 只有 model 是模拟的（本组不测模型质量，只测状态真实性）。
 */
async function makeHost({ base, profileOver = {}, withExp = false, withModel = false }) {
  const ws = join(base, 'ws');
  const profRoot = join(base, 'profiles');
  const resRoot = join(base, 'resources');
  const expRoot = join(base, 'experience');
  mkdirSync(ws, { recursive: true });
  mkdirSync(join(resRoot, 'docs'), { recursive: true });
  mkdirSync(profRoot, { recursive: true });
  mkdirSync(expRoot, { recursive: true });

  writeFileSync(join(resRoot, 'docs', 'only.md'), `# ONLY\n${SECRET}\n`);
  writeFileSync(join(resRoot, 'docs', 'p.md'), '# P\nsystem prompt');
  writeFileSync(join(resRoot, '.context-manifest.json'), JSON.stringify({
    schema_version: 'tusunsun.context-manifest/v0',
    items: [{ ref: 'context:only', title: '唯一', type: 'doc', source: 'docs/only.md', brief: '只有这一条' }],
  }));
  writeFileSync(join(profRoot, 'ctx-v1.json'), JSON.stringify(baseProfile(profileOver), null, 2));

  if (withExp) {
    writeFileSync(join(expRoot, 'active.jsonl'), JSON.stringify({
      schema_version: 'tusunsun.experience/v0',
      experience_id: 'exp-disabled', revision: 1, status: 'active',
      scope: { project_id: 'project-alpha', environment_tags: [], visibility: 'project' },
      kind: 'failure-lesson',
      title: '改造时先确认绑定未失效',
      trigger: ['架构', '改造'],
      lesson: LESSON,
      applies_when: ['重构'], does_not_apply_when: ['绿地'],
      evidence_refs: ['manual:1'],
      created_at: '2024-01-01T00:00:00.000Z', valid_until: null,
      detail: { failure: LESSON, fix: 'FIX-BODY', procedure: ['a', 'b'], evidence: ['e'] },
    }) + '\n');
  }

  const { Core } = await imp('src/core/core.js');
  const core = new Core({ stateDir: join(base, 'state') });
  core.log = () => {};
  core.setData('agent.workDir', ws);
  const cfg = { cells: { context: {
    enabled: true, profileRoot: profRoot, resourceRoot: resRoot,
    experienceRoot: withExp ? expRoot : null, allowedProfiles: ['ctx-v1'],
  } } };
  core.registerService('config', {
    get: (p, f) => {
      let c = cfg;
      for (const k of String(p).split('.')) { if (c == null || typeof c !== 'object') return f; c = c[k]; }
      return c === undefined ? f : c;
    },
    data: cfg,
  });
  if (withModel) {
    const txt = '1. 目标：完成改造\n2. 事实：A\n3. 决定：B\n4. 完成：C\n5. 未完成：D\n6. 风险：E\n7. 不确定：F';
    core.registerService('model', { supportsNativeTools: true, call: async () => ({ content: txt }), callTier: async () => ({ content: txt }) });
  }
  await (await imp('plugins/workspace.js')).default.init(core);
  core.registerCapability('tool.read', { owner: 'test', handler: async () => 'read' });
  core.registerCapability('tool.write', { owner: 'test', handler: async () => 'write' });

  const probes = {};
  core.registerCapability('chat.handle', {
    owner: 'test',
    handler: async (params) => {
      // 探针在**执行作用域内**运行 —— 与模型调用工具的时刻一致。
      for (const [k, fn] of Object.entries(probes)) {
        try { probes[k] = { value: await fn(core, params.sessionId) }; }
        catch (e) { probes[k] = { error: e }; }
      }
      return { reply: 'ok' };
    },
  });

  const rt = Object.create((await imp('plugins/cell-runtime.js')).default); await rt.init(core);
  const cc = Object.create((await imp('plugins/cell-context.js')).default); await cc.init(core);
  // 先装 tool-loader（提供 tool-registry），认知插件才会在 start() 里注册工具 ——
  // 少了它，E33 的"工具路径"就只能跳过，而**跳过不等于验证过**（这一点在评审里被明确点过：
  // 修复合同要求"service/tool 都拒绝"，只测服务层等于只修了一半）。
  const loader = Object.create((await imp('plugins/tool-loader.js')).default);
  await loader.init(core);
  const cp = Object.create((await imp('plugins/context-port.js')).default); await cp.init(core);
  await cp.start();
  const ep = Object.create((await imp('plugins/experience-port.js')).default); await ep.init(core);
  await ep.start();
  const cpd = Object.create((await imp('plugins/compaction.js')).default); await cpd.init(core);

  return {
    core, ws, probes,
    probe: (name, fn) => { probes[name] = fn; },
    svc: core.getService('cell-runtime'), ctx: core.getService('cell-context'),
    cp: core.getService('context-port'), ep: core.getService('experience-port'),
    compaction: core.getService('compaction'),
  };
}

const spec = (id, workspace) => ({
  schema_version: 'tusunsun.cell/v0', cell_id: id, workspace,
  capabilities: ['tool.read', 'tool.write'], permission_mode: 'auto',
  runtime: { kind: 'process' }, limits: { max_active_tasks: 1, max_children: 0 },
});
const task = (id, cellId) => ({
  schema_version: 'tusunsun.task/v0', task_id: id, attempt: 1, target_cell_id: cellId,
  goal: '落实架构改造', inputs: [], required_capabilities: ['tool.read'],
  budget: { max_steps: 10, wall_ms: 30000 },
  acceptance: { required_artifacts: [], checks: [] },
});

/** 跑一次真实 Cell 执行；返回执行结果与探针结果。 */
async function runCell(h) {
  await h.svc.create(spec('cell-A', h.ws), { trusted: true });
  await h.ctx.bind('cell-A', { profileId: 'ctx-v1' });
  await h.svc.accept('cell-A', task('t1', 'cell-A'));
  const res = await h.svc.execute('cell-A');
  return { res, probes: h.probes };
}

const codeOf = async (fn) => {
  try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, code: e.code, message: e.message }; }
};

export async function setup(runner) {
  const base = () => mkdtempSync(join(tmpdir(), 'ctx-e33-'));

  // ── E33 ───────────────────────────────────────────────────────────────
  runner.test('CTX-E33 retrieval.mode=off 必须同时关掉 pull（已知 ref 不等于有权限）', async () => {
    const d = base();
    try {
      const h = await makeHost({
        base: d,
        profileOver: { retrieval: { provider: 'local-manifest', mode: 'off', map_max_tokens: 200, pull_max_tokens: 800 } },
      });
      h.probe('map', async (core, sid) => core.getService('context-port').map(sid, {}));
      h.probe('pull', async (core, sid) => core.getService('context-port').pull(sid, { ref: 'context:only' }));
      // 模型侧走的那条路径：同一个 pull，经由工具名注册的能力身份。
      h.probe('tool', async (core, sid) => {
        const reg = core.getService('tool-registry');
        const t = reg?._tools?.get('tool-context-pull');
        assert(t, '工具路径必须可测：tool-context-pull 应已注册（跳过不等于验证过）');
        return JSON.parse(await t.execute({ ref: 'context:only', _sessionId: sid }));
      });

      const { res, probes } = await runCell(h);
      assertEquals(res.execution_state, 'succeeded', `关闭检索不应让任务失败，实际 ${res.execution_state}/${res.error}`);

      // 目录：仍然是"空目录 + disabled"，这是原来就对的语义，不能被改动破坏。
      assertEquals(probes.map.value.disabled, true, 'mode=off 时 map 必须标记 disabled');
      assertEquals(probes.map.value.items.length, 0, 'mode=off 时目录必须为空');

      // 正文：**必须**具名拒绝。
      assert(probes.pull.error, 'mode=off 时 pull 必须拒绝，实际成功了');
      assertEquals(probes.pull.error.code, 'retrieval_disabled', `应为 retrieval_disabled，实际 ${probes.pull.error.code}`);
      assert(!String(probes.pull.error.message).includes(SECRET), '拒绝信息不得包含正文');

      // 工具路径**不带条件**地断言：没有"没装就跳过"的余地 —— 那正是上一版漏掉这一半的原因。
      assert(probes.tool.error, 'mode=off 时工具路径也必须拒绝');
      assertEquals(probes.tool.error.code, 'retrieval_disabled', '工具路径应复用同一判据');
      console.log(`       [实测] mode=off → map items=0/disabled；service.pull 与 tool-context-pull 均拒绝 retrieval_disabled；执行仍 succeeded`);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('CTX-E33b 反例：mode=on-demand 时同一 ref 仍可正常 pull（修复不得误伤正路）', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d });
      h.probe('map', async (core, sid) => core.getService('context-port').map(sid, {}));
      h.probe('pull', async (core, sid) => core.getService('context-port').pull(sid, { ref: 'context:only' }));
      const { probes } = await runCell(h);
      assertEquals(probes.map.value.items.length, 1, 'on-demand 下目录应有 1 条');
      assert(!probes.pull.error, `on-demand 下 pull 不应拒绝：${probes.pull.error?.message}`);
      assert(String(probes.pull.value.text).includes(SECRET), 'on-demand 下应真的读到正文');
      console.log('       [实测] on-demand → 目录 1 条、pull 正常返回正文（开关只关自己该关的）');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ── E34 ───────────────────────────────────────────────────────────────
  runner.test('CTX-E34 experience.active_pull=false 必须拦下按 ref 的详情读取', async () => {
    const d = base();
    try {
      const h = await makeHost({
        base: d, withExp: true,
        profileOver: { experience: { provider: 'static', passive: 'off', max_hints: 2, active_pull: false, projectId: 'project-alpha' } },
      });
      h.probe('read', async (core, sid) => core.getService('experience-port').read(sid, { ref: 'exp-disabled@1', focus: 'failure' }));
      // 工具层：`tool-experience-pull` 走的是同一个 self.read，必须一并拒绝 ——
      // 修复合同要求"service/tool 都拒绝"，只测一半等于没测。
      h.probe('tool', async (core, sid) => {
        const reg = core.getService('tool-registry');
        const t = reg?._tools?.get('tool-experience-pull');
        assert(t, 'tool-experience-pull 应已注册');
        return JSON.parse(await t.execute({ ref: 'exp-disabled@1', focus: 'failure', _sessionId: sid }));
      });
      // 被动提示独立于主动开关：本用例把它配成 off，这里顺带验"off 就是 0 条"。
      h.probe('lookup', async (core, sid) => core.getService('experience-port').lookup(sid, { goal_brief: '架构改造' }));

      const { res, probes } = await runCell(h);
      assertEquals(res.execution_state, 'succeeded', `配置不该让任务失败，实际 ${res.execution_state}/${res.error}`);

      assert(probes.read.error, 'active_pull=false 时 read 必须拒绝，实际返回了详情');
      assertEquals(probes.read.error.code, 'experience_pull_disabled', `应为 experience_pull_disabled，实际 ${probes.read.error.code}`);
      assert(!JSON.stringify(probes.read.error.message).includes(LESSON), '拒绝信息不得包含经验正文');
      assert(probes.tool.error, 'active_pull=false 时工具路径也必须拒绝');
      assertEquals(probes.tool.error.code, 'experience_pull_disabled', '工具路径应复用同一判据');
      assertEquals(probes.lookup.value.length, 0, 'passive=off 时 hint 必须为 0 条');
      console.log('       [实测] active_pull=false → service.read 与 tool-experience-pull 均拒绝 experience_pull_disabled；passive=off → 0 条 hint');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('CTX-E34b 被动提示与主动开关彼此独立：active_pull=false + passive 开 ⇒ 有 hint、无详情', async () => {
    const d = base();
    try {
      const h = await makeHost({
        base: d, withExp: true,
        profileOver: { experience: { provider: 'static', passive: 'relevant-only', max_hints: 2, active_pull: false, projectId: 'project-alpha' } },
      });
      h.probe('read', async (core, sid) => core.getService('experience-port').read(sid, { ref: 'exp-disabled@1' }));
      h.probe('lookup', async (core, sid) => core.getService('experience-port').lookup(sid, { goal_brief: '架构改造' }));

      const { probes } = await runCell(h);
      assertEquals(probes.lookup.value.length, 1, `passive 开时应命中 1 条 hint，实际 ${probes.lookup.value.length}`);
      assert(probes.lookup.value[0].lesson.includes(LESSON.slice(0, 12)), 'hint 应带教训摘要');
      assert(probes.read.error, '同一 profile 下 read 仍必须拒绝');
      assertEquals(probes.read.error.code, 'experience_pull_disabled', 'read 应为 experience_pull_disabled');
      console.log('       [实测] passive 开 + active_pull 关 ⇒ hint 1 条、read 仍拒绝（两个开关互不代偿）');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('CTX-E34c 反例：active_pull=true 时同一 ref 仍能读到详情（修复不得误伤正路）', async () => {
    const d = base();
    try {
      const h = await makeHost({
        base: d, withExp: true,
        profileOver: { experience: { provider: 'static', passive: 'relevant-only', max_hints: 2, active_pull: true, projectId: 'project-alpha' } },
      });
      h.probe('read', async (core, sid) => core.getService('experience-port').read(sid, { ref: 'exp-disabled@1', focus: 'failure' }));
      const { probes } = await runCell(h);
      assert(!probes.read.error, `active_pull=true 时不应拒绝：${probes.read.error?.message}`);
      assert(JSON.stringify(probes.read.value).includes(LESSON), '应真的读到经验正文');
      console.log('       [实测] active_pull=true → 详情正常返回（判据只认这个字段的值）');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ── E35 ───────────────────────────────────────────────────────────────
  runner.test('CTX-E35 摘要落盘失败：生成与持久化状态必须分开报，且不得给出指向别人的版本号', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d, withModel: true });
      const dir = join(d, 'state', 'cells', 'cell-A', 'context', 'summaries');

      const r1 = await h.compaction.compact({ messages: [{ role: 'user', content: '第一轮' }], cellId: 'cell-A', sessionId: 'sess-1' });
      assertEquals(r1.generation_status, 'ok', '第一次应生成成功');
      assertEquals(r1.persistence_status, 'persisted', '第一次应落盘成功');
      assertEquals(r1.summary_version, 1, '第一次版本应为 1');
      const disk1 = JSON.parse(readFileSync(join(dir, 'sess-1.json'), 'utf8'));
      assertEquals(disk1.summary_version, 1, '磁盘上应为 v1');

      // 故障注入方式（v0.9.30 改）：**经持久层**制造真实的写入失败，不再靠 chmod 0500。
      //
      // 为什么改：`chmodSync(dir, 0o500)` 只在**非 root** 下才产生 EACCES。root 无视普通
      // 文件模式位，于是同一份测试在 root CI 里写成功、断言"应失败"落空 —— 专家第九轮复审
      // 实测到 577/1/14（CTX-E35 单条红），换个身份重跑又是 10/10 全绿。
      // **一条测试的结论取决于谁在跑它，它就不是回归测试。**
      //
      // 新做法不依赖任何身份：让 `saveSummary` 真的抛一个带 errno 的写入错误。
      // 这不是"注入一个假异常"—— 它走的是 compaction 真实的 catch 分支，与磁盘满、
      // 目录权限、rename 失败落到的是同一段代码。同时也补上专家要的"能稳定复现 rename 错误"。
      const realSave = h.ctx.saveSummary.bind(h.ctx);
      let armed = false;
      h.ctx.saveSummary = async (...a) => {
        if (!armed) return realSave(...a);
        const e = new Error(`EACCES: permission denied, rename '${join(dir, 'x.json.tmp')}' -> '${join(dir, 'x.json')}'`);
        e.code = 'EACCES';
        throw e;
      };
      armed = true;
      let r2;
      try {
        r2 = await h.compaction.compact({ messages: [{ role: 'user', content: '第二轮（更长）' }], cellId: 'cell-A', sessionId: 'sess-1' });
      } finally { armed = false; h.ctx.saveSummary = realSave; }

      // ① 不能再谎报 ok
      assert(r2.generation_status === 'ok', `第二轮摘要本身是生成成功的，实际 ${r2.generation_status}`);
      assertEquals(r2.persistence_status, 'failed', `落盘应报 failed，实际 ${r2.persistence_status}`);
      assertEquals(r2.status, 'degraded', `对外状态应为 degraded，实际 ${r2.status}`);
      // ② 不能给出一个磁盘上并不属于这一轮的版本号
      assertEquals(r2.summary_version, null, `落盘失败时不得报版本号，实际 ${r2.summary_version}`);
      assert(r2.reason && /not persisted/i.test(r2.reason), `reason 应说明未持久化，实际 ${r2.reason}`);
      // ③ 本轮文本仍可用（不是 failed），但不具备恢复保证
      assert(typeof r2.summary === 'string' && r2.summary.length > 0, '生成成功时本轮文本应可用');
      // ④ 磁盘上仍是第一轮那份，没被这次失败污染
      const disk2 = JSON.parse(readFileSync(join(dir, 'sess-1.json'), 'utf8'));
      assertEquals(disk2.summary_version, 1, '失败的那次不得改动磁盘版本');
      assertEquals(disk2.source_hash, disk1.source_hash, '失败的那次不得把别人的 source_hash 说成自己的');
      assert(/EACCES/.test(String(r2.persist_error?.message ?? r2.reason ?? '')),
        '失败原因里应保留真实的 errno（可诊断），而不是被抹成一句"失败"');
      console.log(`       [实测] 持久层 EACCES（不依赖运行身份，uid=${process.getuid?.() ?? 'n/a'}）`
        + ' → status=degraded、summary_version=null、磁盘仍为 v1 且未污染');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('CTX-E35b 正常路径：版本号来自持久层、单调递增、重启可回读', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d, withModel: true });
      const r1 = await h.compaction.compact({ messages: [{ role: 'user', content: 'A' }], cellId: 'cell-A', sessionId: 'sess-2' });
      const r2 = await h.compaction.compact({ messages: [{ role: 'user', content: 'B' }], cellId: 'cell-A', sessionId: 'sess-2' });
      assertEquals(r1.persistence_status, 'persisted', '第一次应持久化');
      assertEquals(r2.persistence_status, 'persisted', '第二次应持久化');
      assertEquals(r2.summary_version, 2, `同会话第二次应为 v2，实际 ${r2.summary_version}`);
      const back = await h.ctx.loadSummary('cell-A', 'sess-2');
      assertEquals(back.summary_version, 2, '重启回读应与落盘版本一致');
      console.log('       [实测] persisted 路径 v1→v2 单调、回读一致（修复只收紧失败态，未改成功态）');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('CTX-E35c 无持久层：报 unsaved 而不是假装保存成功', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d, withModel: true });
      // 摘掉 cell-context 的 saveSummary —— 模拟"没有可落盘的地方"
      const realGet = h.core.getService.bind(h.core);
      const cc = h.core.getService('cell-context');
      const patched = Object.create(cc);
      patched.saveSummary = undefined;
      h.core.getService = (name) => (name === 'cell-context' ? patched : realGet(name));

      const r = await h.compaction.compact({ messages: [{ role: 'user', content: 'X' }], cellId: 'cell-A', sessionId: 'sess-3' });
      assertEquals(r.generation_status, 'ok', '生成仍应成功');
      assertEquals(r.persistence_status, 'unsaved', `应为 unsaved，实际 ${r.persistence_status}`);
      assertEquals(r.summary_version, null, '没有存储就没有版本号');
      assertEquals(r.status, 'degraded', '对外应为 degraded');
      console.log('       [实测] 无 cell-context.saveSummary → generation=ok / persistence=unsaved / version=null');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ── E36：模型看到的工具清单必须与策略一致 ─────────────────────────────
  runner.test('CTX-E36 模型工具清单按冻结 profile 过滤：看不见必然被拒的认知工具，其余不动', async () => {
    const d = base();
    try {
      const h = await makeHost({
        base: d, withExp: true,
        profileOver: {
          retrieval: { provider: 'local-manifest', mode: 'off', map_max_tokens: 200, pull_max_tokens: 800 },
          experience: { provider: 'static', passive: 'relevant-only', max_hints: 2, active_pull: false, projectId: 'project-alpha' },
        },
      });
      const hl = Object.create((await imp('plugins/haotian-lite.js')).default);
      hl.core = h.core;

      const all = [
        { name: 'tool-read' }, { name: 'tool-write' }, { name: 'tool-bash' },
        { name: 'tool-context-map' }, { name: 'tool-context-pull' }, { name: 'tool-experience-pull' },
        { name: 'not-a-tool' },
      ];

      // ① 未绑定 profile 的会话：**原样返回**（旧路径必须逐字节不变）。
      //    这里必须同时断言"没有走 catch 分支"：只看返回值的话，"未绑定就原样返回"与
      //    "过滤时抛错被 fail-open 吞掉"会给出**完全相同**的结果，判据等于恒真
      //    （M8 变异曾经正是靠这一点骗过本用例）。
      hl._cognitionFilterFellBack = 0;
      assertEquals(hl._cognitionVisibleTools(all, 'no-such-session').length, all.length,
        '未绑定 profile 时不得过滤任何工具');
      assertEquals(hl._cognitionFilterFellBack, 0,
        '未绑定路径不得触发 fail-open 兜底（否则"原样返回"可能是异常换来的）');

      // ② 执行作用域内：三个认知工具被隐藏，其余工具一个不少
      await h.svc.create(spec('cell-A', h.ws), { trusted: true });
      await h.ctx.bind('cell-A', { profileId: 'ctx-v1' });
      await h.svc.accept('cell-A', task('t1', 'cell-A'));
      const frozen = await h.ctx.freezeForTask('cell-A', 't1', 'inc-1', null);
      // 走**真实入口** enterExecution 建立作用域，不碰私有字段：
      // 判据必须与生产路径同一条，否则守的是我的假设。
      const sid = 'session-e36';
      h.ctx.enterExecution(sid, frozen);

      const kept = hl._cognitionVisibleTools(all, sid).map((t) => t.name);
      for (const n of ['tool-context-map', 'tool-context-pull', 'tool-experience-pull']) {
        assert(!kept.includes(n), `mode=off / active_pull=false 时不得展示 ${n}`);
      }
      for (const n of ['tool-read', 'tool-write', 'tool-bash', 'not-a-tool']) {
        assert(kept.includes(n), `非认知工具 ${n} 不得被过滤`);
      }
      console.log(`       [实测] 未绑定→原样 ${all.length} 个；绑定后 ${all.length}→${kept.length}（只藏 3 个认知工具）`);

      // ③ fail-open：读 profile 抛错时**不过滤**，绝不能因此让对话失败
      const broken = Object.create(hl);
      broken.core = { getService: () => { throw new Error('boom'); } };
      assertEquals(broken._cognitionVisibleTools(all, sid).length, all.length,
        '读 profile 失败时必须原样返回（展示层问题不得阻断对话）');
      console.log('       [实测] profile 读取抛错 → fail-open 原样返回（真正的门仍在 pull/read）');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('CTX-E36b 反例：策略允许时认知工具照常展示（过滤只针对被禁的那几项）', async () => {
    const d = base();
    try {
      const h = await makeHost({
        base: d, withExp: true,
        profileOver: { experience: { provider: 'static', passive: 'relevant-only', max_hints: 2, active_pull: true, projectId: 'project-alpha' } },
      });
      const hl = Object.create((await imp('plugins/haotian-lite.js')).default);
      hl.core = h.core;
      await h.svc.create(spec('cell-A', h.ws), { trusted: true });
      await h.ctx.bind('cell-A', { profileId: 'ctx-v1' });
      await h.svc.accept('cell-A', task('t1', 'cell-A'));
      const frozen = await h.ctx.freezeForTask('cell-A', 't1', 'inc-1', null);
      const sid = 'session-e36b';
      h.ctx.enterExecution(sid, frozen);

      const all = [{ name: 'tool-context-map' }, { name: 'tool-context-pull' }, { name: 'tool-experience-pull' }];
      const kept = hl._cognitionVisibleTools(all, sid).map((t) => t.name);
      assertEquals(kept.length, all.length, `策略允许时三个工具都应保留，实际只剩 ${kept.join(',')}`);
      console.log('       [实测] on-demand + active_pull=true → 三个认知工具全部保留');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
}
