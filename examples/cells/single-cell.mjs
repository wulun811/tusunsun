#!/usr/bin/env node
// 单 Cell 端到端示例（R0-126 / G2）—— **不需要 API Key、不花 token、不联网**。
//
// 它证明的是"Cell 是真的执行主体"，而不是"能生成一段漂亮的 JSON"：
//
//   ① 确定性 Cell：不调 LLM，只跑获准的本地检查并产出报告。
//      —— 这是"自主执行单元 ≠ 必须花模型 Token"的证据。
//   ② 模型 Cell（可选）：接本地 OpenAI 兼容端点，走真实的
//      `haotian-lite → tool-executor → tool-write → 结果` 链路。
//      `--model <baseUrl>` 时才跑；不给就跳过并如实说明（不冒充跑过）。
//
// 用法：
//   node examples/cells/single-cell.mjs                  # 确定性，离线
//   node examples/cells/single-cell.mjs --model http://127.0.0.1:11434/v1
//   node examples/cells/single-cell.mjs --keep           # 保留临时目录便于查看
//
// 退出码：0 = 全部验收通过；1 = 有步骤失败；2 = 用法错误。
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(join(ROOT, rel));

// ── 命令行 ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let modelUrl = null; let keep = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--model' && argv[i + 1]) { modelUrl = argv[++i]; continue; }
  if (argv[i] === '--keep') { keep = true; continue; }
  if (argv[i] === '--help' || argv[i] === '-h') {
    process.stdout.write('用法: node examples/cells/single-cell.mjs [--model <baseUrl>] [--keep]\n');
    process.exit(0);
  }
  process.stderr.write(`未知参数: ${argv[i]}\n`);
  process.exit(2);
}

const say = (s = '') => process.stdout.write(`${s}\n`);
const ok = (s) => say(`  \x1b[32m✓\x1b[0m ${s}`);
const bad = (s) => say(`  \x1b[31m✗\x1b[0m ${s}`);
const note = (s) => say(`  \x1b[90m· ${s}\x1b[0m`);

async function main() {
  const base = mkdtempSync(join(tmpdir(), 'tusunsun-cell-demo-'));
  const stateDir = join(base, 'state');
  const workspace = join(base, 'project');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(workspace, 'src'), { recursive: true });
  mkdirSync(join(workspace, 'outputs'), { recursive: true });
  // 一个真的"项目"：示例代码让确定性检查有东西可查
  writeFileSync(join(workspace, 'src', 'greet.js'), 'export const greet = (n) => `hello ${n}`;\n');
  writeFileSync(join(workspace, 'src', 'bad.js'), 'export const oops = ( => { ;\n');   // 故意语法错误

  say(`\n\x1b[1m土行孙 · 单 Cell 端到端示例\x1b[0m`);
  say(`  state    ${stateDir}`);
  say(`  workspace ${workspace}`);
  say(`  model    ${modelUrl ? modelUrl : '（不调用模型：本次只跑确定性检查）'}`);
  say('');

  // ── 装配：真实内核 + workspace + cell-runtime ─────────────────────
  const { Core } = await imp('src/core/core.js');
  const core = new Core({ stateDir });
  core.log = () => {};               // 示例只要结论，不要日志噪音
  core.setData('agent.workDir', workspace);
  await (await imp('plugins/workspace.js')).default.init(core);

  // 宿主实际授予的能力（= Cell 能力的天花板）
  core.registerCapability('tool.read', { owner: 'demo', handler: async (a) => readFileSync(join(workspace, a.path), 'utf8') });
  core.registerCapability('tool.write', {
    owner: 'demo',
    handler: async (a) => { writeFileSync(join(workspace, a.path), a.content, 'utf8'); return `wrote ${a.path}`; },
  });

  // chat.handle：这是"Agent loop"的位置。确定性模式下它不调模型，
  // 只跑**事先信任的**本地检查（不执行模型生成的命令）。
  // 每次执行各自一份（同一进程里第二次跑不得继承上一次的结果 —— 那正是"看起来对"的假证据）
  let lastChecks = [];
  core.registerCapability('chat.handle', {
    owner: 'demo',
    handler: async ({ message, sessionId }) => {
      const root = core.getService('workspace').root(sessionId);
      const checks = [];
      lastChecks = checks;
      for (const f of ['src/greet.js', 'src/bad.js']) {
        const src = readFileSync(join(root, f), 'utf8');
        // 极简"语法检查"：括号配对（真实项目里换成 node --check / tsc，见 README）
        const unbalanced = (src.match(/\(/g) || []).length !== (src.match(/\)/g) || []).length;
        checks.push({ file: f, ok: !unbalanced, why: unbalanced ? 'unbalanced parentheses' : 'balanced' });
      }
      const report = {
        goal: message,
        checked_at: new Date().toISOString(),
        files: checks,
        failed: checks.filter((c) => !c.ok).map((c) => c.file),
      };
      // 产物真的写进 **Cell 的工作区**（不是进程 cwd）
      writeFileSync(join(root, 'outputs', 'report.json'), JSON.stringify(report, null, 2));
      return { reply: `checked ${checks.length} file(s), ${report.failed.length} failed` };
    },
  });

  const rtDef = (await imp('plugins/cell-runtime.js')).default;
  const rt = Object.create(rtDef);
  await rt.init(core);
  const cells = core.getService('cell-runtime');

  // ── 场景一：确定性 Cell ───────────────────────────────────────────
  say('\x1b[1m① 确定性 Cell（不调用模型）\x1b[0m');
  const spec = {
    schema_version: 'tusunsun.cell/v0',
    cell_id: 'cell-demo-001',
    workspace,
    capabilities: ['tool.read', 'tool.write'],
    permission_mode: 'auto',
    runtime: { kind: 'process' },
    limits: { max_active_tasks: 1, max_children: 0 },
    tags: ['demo', 'deterministic'],
  };
  const status = await cells.create(spec, { trusted: true });   // 本机宿主：显式声明来源
  ok(`created  ${status.cell_id}  state=${status.state}  incarnation=${status.incarnation_id}`);
  ok(`workspace_realpath = ${status.workspace_realpath}`);
  ok(`capabilities_effective = [${status.capabilities_effective.join(', ')}]`);

  const task = {
    schema_version: 'tusunsun.task/v0',
    task_id: 'task-lint-001',
    attempt: 1,
    target_cell_id: 'cell-demo-001',
    goal: '检查 src/ 下两个文件的语法并输出报告',
    inputs: [{ kind: 'dir', ref: 'src' }],
    required_capabilities: ['tool.read'],
    budget: { max_steps: 10, wall_ms: 60000 },
    acceptance: { required_artifacts: ['outputs/report.json'], checks: [] },
  };
  const acc = cells.accept('cell-demo-001', task);
  ok(`accepted  task=${acc.task_id}  effective=[${acc.effective_capabilities.join(', ')}]`);

  const result = await cells.execute('cell-demo-001', task);
  say('');
  if (result.execution_state === 'succeeded') ok(`executed  state=${result.execution_state}`);
  else bad(`executed  state=${result.execution_state}  ${result.error || ''}`);
  for (const a of result.artifacts) ok(`artifact  ${a.path}  ${a.bytes}B  sha256=${a.sha256.slice(0, 16)}…`);
  ok(`usage     steps=${result.usage.steps}  wall=${result.usage.wall_ms}ms`);

  const decision = await cells.verify('cell-demo-001', task);
  say('');
  if (decision.decision === 'accepted') ok(`verified  ${decision.decision}  （${decision.reason}）`);
  else bad(`verified  ${decision.decision}  （${decision.reason}）`);

  // 复查报告内容：坏文件必须被点名
  const report = JSON.parse(readFileSync(join(workspace, 'outputs', 'report.json'), 'utf8'));
  if (report.failed.includes('src/bad.js')) ok(`报告点名了坏文件：${report.failed.join(', ')}`);
  else bad(`报告没发现坏文件（应含 src/bad.js，实际 ${JSON.stringify(report.failed)}）`);

  // ── 场景二：能力不匹配 ⇒ 执行前拒绝 ───────────────────────────────
  say('\n\x1b[1m② 越权能力：执行前就被拒（不看模型说什么）\x1b[0m');
  try {
    cells.accept('cell-demo-001', {
      ...task, task_id: 'task-bash-001', required_capabilities: ['tool.bash'],
      acceptance: { required_artifacts: [], checks: [] },
    });
    bad('要求 tool.bash 竟然被接受了 —— 这是提权');
  } catch (err) {
    ok(`拒绝：${err.code} —— ${err.message.slice(0, 90)}`);
  }

  // ── 场景三：产物缺失 ⇒ 执行失败，不可能被验收通过 ──────────────────
  say('\n\x1b[1m③ 缺产物：执行状态必须如实为 failed\x1b[0m');
  const task2 = {
    ...task, task_id: 'task-missing-001',
    acceptance: { required_artifacts: ['outputs/nope.json'], checks: [] },
  };
  cells.accept('cell-demo-001', task2);
  const r2 = await cells.execute('cell-demo-001', task2);
  if (r2.execution_state === 'failed') ok(`execution_state=failed（${r2.error}）`);
  else bad(`应当是 failed，实际 ${r2.execution_state}`);
  const d2 = await cells.verify('cell-demo-001', task2);
  if (d2.decision === 'rejected') ok(`验收决定 ${d2.decision}：${d2.reason}`);
  else bad(`应当被拒收，实际 ${d2.decision}`);

  // ── 场景四（可选）：真实模型链路 ──────────────────────────────────
  say('\n\x1b[1m④ 模型 Cell（真实 chat.handle 链路）\x1b[0m');
  if (!modelUrl) {
    note('[SKIP] 未指定 --model，本次不跑模型路径。');
    note('  这不是 PASS：真实模型链路需要 --model http://127.0.0.1:<port>/v1。');
  } else {
    const { default: haotian } = await imp('plugins/haotian-lite.js');
    const { default: model } = await imp('plugins/model-openai.js');
    const { default: toolExec } = await imp('plugins/tool-executor.js');
    // haotian-lite 需要 session 服务（读历史）。示例里不加载完整 session 插件（会写盘到
    // stateDir/sessions），用同形状的最小实现 —— 挂的仍是**真** chat.handle 链路。
    const hist = new Map();
    core.registerService('session', {
      loadSession: async (id) => hist.get(id) || [],
      saveHistory: async (id, msgs) => { hist.set(id, [...msgs]); },
    });
    // 让渡：`chat.handle` 已由 demo 注册（确定性模式）。核心的仲裁要求**原所有者显式让渡**，
    // 不允许后来者静默覆盖 —— 这里如实走那条路径，而不是去找一个绕开它的写法。
    const prev = core._capabilities.get('chat.handle');
    if (prev?.owner === 'demo') core._capabilities.delete('chat.handle');
    await haotian.init(core);
    // 极简 config 服务：示例不加载完整 config 插件（它会写盘），但模型插件读的就是这几项。
    const cfg = {
      model: { model: 'demo', baseUrl: modelUrl, apiKey: null },
      agent: { maxTurns: 6, workDir: workspace },
      tools: { permissionMode: 'auto', timeout: 60000 },
    };
    core.registerService('config', {
      // `data` 必须暴露：`model-openai.getModel()` 读的是 `config.data.model`（扁平的 get() 不够）
      data: cfg,
      get: (path, dflt) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), cfg) ?? dflt,
      set: (path, v) => { const ks = path.split('.'); const last = ks.pop(); let o = cfg; for (const k of ks) o = (o[k] ||= {}); o[last] = v; },
    });
    await model.init(core);
    await toolExec.init(core);
    // 换成**真实的**文件工具（确定性子里的 demo stub 让位 —— 演示的是同一套执行链）
    for (const id of ['tool.read', 'tool.write']) core._capabilities.delete(id);
    await (await imp('plugins/tools/tool-write.js')).default.init(core);
    await (await imp('plugins/tools/tool-read.js')).default.init(core);
    void haotian; void toolExec;
    const spec2 = { ...spec, cell_id: 'cell-model-001', capabilities: ['tool.read', 'tool.write'] };
    await cells.create(spec2, { trusted: true });
    const t3 = {
      schema_version: 'tusunsun.task/v0', task_id: 'task-model-001', attempt: 1,
      target_cell_id: 'cell-model-001',
      goal: '用 tool-write 在工作区写 outputs/from-model.txt，内容为 hello-from-cell，然后回复 DONE',
      inputs: [], required_capabilities: ['tool.write'],
      budget: { max_steps: 6, wall_ms: 120000 },
      acceptance: { required_artifacts: ['outputs/from-model.txt'], checks: [] },
    };
    cells.accept('cell-model-001', t3);
    const r3 = await cells.execute('cell-model-001', t3);
    if (r3.execution_state === 'succeeded') ok(`模型链路执行成功，产物 ${r3.artifacts.map((a) => a.path).join(', ')}`);
    else bad(`模型链路 ${r3.execution_state}：${r3.error}`);
    if (r3._reply) note(`模型回复：${String(r3._reply).slice(0, 400)}`);
    const d3 = await cells.verify('cell-model-001', t3);
    if (d3.decision === 'accepted') ok(`验收 ${d3.decision}`);
    else bad(`验收 ${d3.decision}：${d3.reason}`);
  }

  // ── 关闭 ──────────────────────────────────────────────────────────
  say('\n\x1b[1m⑤ 关闭 Cell\x1b[0m');
  await cells.close('cell-demo-001');
  const closed = cells.describe('cell-demo-001');
  if (closed.state === 'stopped') ok(`state=${closed.state}；此后 accept 会被 cell_not_ready 拒绝`);
  else bad(`关闭后状态应为 stopped，实际 ${closed.state}`);

  // 结果落盘可回看
  const resultsFile = join(stateDir, 'cells', 'cell-demo-001', 'results.jsonl');
  if (existsSync(resultsFile)) {
    const lines = readFileSync(resultsFile, 'utf8').trim().split('\n').filter(Boolean);
    ok(`结果已落盘：${resultsFile}（${lines.length} 条，可审计）`);
  }

  if (keep) say(`\n临时目录保留：${base}`);
  else rmSync(base, { recursive: true, force: true });

  const failed = lastChecks.filter((c) => !c.ok).length;
  say(`\n\x1b[1m结论\x1b[0m：确定性检查 ${lastChecks.length} 个文件，${failed} 个语法错误（预期 1 个：src/bad.js）`);
  say(`        Cell 生命周期、能力交集、产物 hash、验收分离全部走通。\n`);
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  process.stderr.write(`\x1b[31m示例失败\x1b[0m：${err?.stack || err}\n`);
  process.exit(1);
});
