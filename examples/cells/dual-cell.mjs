#!/usr/bin/env node
// 双 Cell 最小协作（R0-127 / G3）—— **两个独立进程、两个独立状态目录、两个独立工作区**。
//
// 形态（刻意最小）：
//   一个薄协调器（本文件）+ 两个 `CellSpec` + 两个土行孙进程（`tusunsun start --scene cell`）。
//   传输就是本机 loopback WS（既有 `wsRequest`），没有新消息总线、没有 SQLite、没有完整 DAG 平台。
//
// 它证明的四件事（都是"能被外部观察到"的，不是自述）：
//   ① 两个 Cell 各有身份：不同 `cell_id`、不同 `incarnation_id`、不同 stateDir/workspace；
//   ② 任务分开执行：A 改 A 的文件、B 改 B 的文件，互不串目录；
//   ③ 结果分开验收：产物 hash 由**协调器**（不是子进程）复算；一个失败不会让整体变绿；
//   ④ 干净回收：全部停止后无残留进程、无占用端口，证据留在磁盘上。
//
// 用法：
//   node examples/cells/dual-cell.mjs               # 正常路径（两个子任务都成功）
//   node examples/cells/dual-cell.mjs --fail-b      # 反例：B 的任务失败，整体不得报成功
//   node examples/cells/dual-cell.mjs --keep        # 保留临时目录
//   node examples/cells/dual-cell.mjs --cognition   # 两个 Cell 使用不同 ContextProfile（v0.9.22）
//
// 退出码：0 = 全部验收通过；1 = 有失败（含反例模式下"应当失败却成功了"）；2 = 用法错误。
//
// 边界（诚实）：
//   · 这不是分布式调度，也**不**宣称同进程多 Cell 已安全（v0 是 1 Cell : 1 进程）。
//   · 两个 Cell 若指向同一个工作区，并发写入仍会互相踩 —— 本示例用两个**独立目录**，
//     并且明确拒绝共享可写工作区（见 C09）。
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const ENTRY = join(ROOT, 'tusunsun.mjs');

const argv = process.argv.slice(2);
let keep = false; let failB = false; let cognition = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--keep') { keep = true; continue; }
  if (argv[i] === '--fail-b') { failB = true; continue; }
  // CTX-14（v0.9.22）：`--cognition` 让两个 Cell 使用**不同 ContextProfile**，
  // 并各自拥有不同的有界地图与经验来源。不开这个开关时，示例行为与 v0.9.21 完全一致。
  if (argv[i] === '--cognition') { cognition = true; continue; }
  if (argv[i] === '--help' || argv[i] === '-h') {
    process.stdout.write('用法: node examples/cells/dual-cell.mjs [--fail-b] [--keep] [--cognition]\n');
    process.exit(0);
  }
  process.stderr.write(`未知参数: ${argv[i]}\n`);
  process.exit(2);
}

const say = (s = '') => process.stdout.write(`${s}\n`);
const ok = (s) => say(`  \x1b[32m✓\x1b[0m ${s}`);
const bad = (s) => say(`  \x1b[31m✗\x1b[0m ${s}`);
const note = (s) => say(`  \x1b[90m· ${s}\x1b[0m`);

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeoutMs = 40000, what = '条件' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待${what}超时（${timeoutMs}ms）`);
    await sleep(120);
  }
}

/**
 * 本地模拟模型端点（OpenAI 兼容）。
 *
 * 为什么必须有它：G3 的退出条件之一是"**无需真实 API Key 的模拟模式必须可运行**"。
 * 没有它，示例要么跑不起来（没配云 key），要么只能跑假 handler —— 后者证明不了
 * `model → haotian → tool-executor → tool-write` 这条**真链路**。
 *
 * 它按脚本发工具调用（真协议、真 tool_call 形状），不产生任何"智能"：
 *   第一轮：tool-read src/target.js  → 拿到文件内容
 *   第二轮：tool-write outputs/result.txt（把读到的内容写出去）
 *   第三轮：回复 DONE
 * 每个宿主的工具调用都落在**它自己的工作区**（因为执行器按会话根目录解析），
 * 所以同一段脚本在两个 Cell 里各自产生一份产物，互不干扰。
 */
function startMockModel() {
  const seenSystem = [];
  const seenToolResults = [];
  const seenTools = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c.toString(); });
    req.on('end', () => {
      let p = {};
      try { p = JSON.parse(body); } catch { /* 忽略 */ }
      const msgs = p.messages || [];
      // CTX-14：把**模型实际收到的 system 消息**留下来。这是"不同 profile 真的生效"的
      // 唯一硬证据 —— 配置回显、绑定记录都只证明"写了什么"，不证明"模型看到了什么"。
      const sysMsg = msgs.find((m) => m.role === 'system');
      if (sysMsg) seenSystem.push(String(sysMsg.content || ''));
      seenTools.push((p.tools || []).map((t) => t?.function?.name || t?.name).filter(Boolean));
      for (const m of msgs) {
        if (m.role === 'tool') seenToolResults.push(String(m.content || ''));
      }
      if (process.env.DUAL_TRACE) process.stderr.write(`[mock] keys=${Object.keys(p).join(',')} tools=${(p.tools||[]).length}\n`);
      const j = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      const toolMsgs = msgs.filter((m) => m.role === 'tool');
      const lastTool = toolMsgs[toolMsgs.length - 1];
      // 用**调用 id 序列**判断走到第几步，而不是用"收到几条 tool 消息"。
      // 后者会把"额外插入的一次经验调用"误当成"已经到第二轮了"，实测让两路都写不出产物。
      const callIds = msgs
        .filter((m) => m.role === 'assistant' && Array.isArray(m.tool_calls))
        .flatMap((m) => m.tool_calls.map((tc) => tc?.id));
      const done = new Set(callIds);

      // CTX-14：**只有**声明了 tool-experience-pull 的那一路（示例里的 A）才会走这一步。
      // 这模拟"模型看到经验线索后主动求教"，而不是示例脚本代替模型做决定。
      const hasExpTool = (p.tools || []).some((t) => t?.function?.name === 'tool-experience-pull');
      if (hasExpTool && done.has('r1') && !done.has('e1')) {
        return j({ choices: [{ message: {
          role: 'assistant', content: null,
          tool_calls: [{ id: 'e1', type: 'function', function: {
            name: 'tool-experience-pull',
            arguments: JSON.stringify({ ref: 'exp-writepath-001@2', focus: 'evidence' }),
          } }],
        }, finish_reason: 'tool_calls' }] });
      }
      if (done.has('w1')) {
        // 第三轮：产物已写，收工
        return j({ choices: [{ message: { role: 'assistant', content: 'DONE' }, finish_reason: 'stop' }] });
      }
      if (done.has('r1')) {
        // 第二轮：把刚才读到的内容写到产物文件
        // 注意：A 在 e1 之后仍然用 **tool-read 的结果** 写产物，而不是经验文本 ——
        // 经验是参考资料，不应成为产物内容（那会混淆"证据"与"输入"）。
        const readResult = toolMsgs.find((m) => /--- src\/target\.js/.test(String(m.content || '')));
        const content = String(readResult?.content ?? lastTool?.content ?? '');
        return j({ choices: [{ message: {
          role: 'assistant', content: null,
          tool_calls: [{ id: 'w1', type: 'function', function: { name: 'tool-write', arguments: JSON.stringify({ path: 'outputs/result.txt', content }) } }],
        }, finish_reason: 'tool_calls' }] });
      }
      // 第一轮：读输入
      return j({ choices: [{ message: {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'r1', type: 'function', function: { name: 'tool-read', arguments: JSON.stringify({ path: 'src/target.js', limit: 100 }) } }],
      }, finish_reason: 'tool_calls' }] });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seenSystem, seenToolResults, seenTools }));
  });
}

/** 一个子 Cell 的宿主进程：独立 stateDir + 独立 workspace + 独立端口。 */
class CellHost {
  constructor({ id, base, modelPort, cognition = false }) {
    this.id = id;
    this.stateDir = join(base, `state-${id}`);
    this.workspace = join(base, `ws-${id}`);
    this.modelPort = modelPort;
    this.cognition = cognition;
    // 认知配置各自的根（每个 Cell 一套：profile、资源、经验）
    this.profileRoot = join(base, `profiles-${id}`);
    this.resourceRoot = join(base, `resources-${id}`);
    this.experienceRoot = join(base, `experience-${id}`);
    this.proc = null;
    this.port = null;
    this.out = '';
  }

  async start() {
    mkdirSync(this.stateDir, { recursive: true });
    mkdirSync(join(this.workspace, 'src'), { recursive: true });
    mkdirSync(join(this.workspace, 'outputs'), { recursive: true });
    // 每个 Cell 一份**自己的**输入：A 改 greeting，B 改 counter，互不重叠
    writeFileSync(join(this.workspace, 'src', 'target.js'),
      this.id === 'A' ? 'export const hi = () => "hi";\n' : 'export const n = () => 1;\n');

    // CTX-14：两个 Cell 的认知配置**刻意不同**。
    //   A（implementer）：系统提示词要求"最小改动、先读再写"；地图里有实现规范；经验里有踩坑记录。
    //   B（reviewer）：系统提示词要求"严格审查、拒绝含糊"；地图里只有审查清单；**没有**经验来源。
    // 这样"两个 Cell 看到的东西不同"是可被外部观察的，而不是靠日志自述。
    if (this.cognition) {
      const tpl = this.id === 'A'
        ? { prompt: '# Implementer\n你是实现者。只做最小改动，先读代码再写。写完后报告改了什么。',
            doc: '# 实现规范\n产物必须落在 outputs/ 下，且内容来自 src/target.js。',
            docTitle: '实现规范',
            ref: 'context:impl-guide' }
        : { prompt: '# Reviewer\n你是审查者。严格核对产物与输入的对应关系，含糊即拒绝。',
            doc: '# 审查清单\n1) 产物存在吗 2) 内容是否来自输入 3) 有无越界写入',
            docTitle: '审查清单',
            ref: 'context:review-checklist' };
      mkdirSync(join(this.resourceRoot, 'docs'), { recursive: true });
      mkdirSync(this.profileRoot, { recursive: true });
      mkdirSync(this.experienceRoot, { recursive: true });
      writeFileSync(join(this.resourceRoot, 'docs', 'prompt.md'), tpl.prompt);
      writeFileSync(join(this.resourceRoot, 'docs', 'guide.md'), tpl.doc);
      writeFileSync(join(this.resourceRoot, '.context-manifest.json'), JSON.stringify({
        schema_version: 'tusunsun.context-manifest/v0',
        items: [{ ref: tpl.ref, title: tpl.docTitle, type: 'doc', source: 'docs/guide.md', brief: tpl.doc.split('\n')[1] || '' }],
      }, null, 2));
      writeFileSync(join(this.profileRoot, `profile-${this.id.toLowerCase()}-v1.json`), JSON.stringify({
        schema_version: 'tusunsun.context-profile/v0',
        profile_id: `profile-${this.id.toLowerCase()}-v1`,
        system_prompt_ref: 'local:docs/prompt.md',
        retrieval: { provider: 'local-manifest', mode: 'on-demand', map_max_tokens: 240, pull_max_tokens: 600 },
        compaction: { provider: 'structured-llm', max_summary_tokens: 400 },
        // 只有 A 有经验来源 —— B 的 experience.provider=none，因此 B 不该出现经验工具/提示
        experience: this.id === 'A'
          ? { provider: 'static', passive: 'relevant-only', max_hints: 2, active_pull: true }
          : { provider: 'none' },
        budget: { input_max_tokens: 6000, response_reserve_tokens: 800 },
      }, null, 2));
      if (this.id === 'A') {
        writeFileSync(join(this.experienceRoot, 'active.jsonl'), JSON.stringify({
          schema_version: 'tusunsun.experience/v0',
          experience_id: 'exp-writepath-001', revision: 2, status: 'active',
          scope: { project_id: null, environment_tags: ['node', 'filesystem'], visibility: 'project' },
          kind: 'failure-lesson',
          title: '工作目录绑定失效时不能静默回退',
          trigger: ['workspace_unavailable', 'resume_session'],
          lesson: '历史仍属于旧工作区时应拒绝执行，先重新确认绑定。',
          applies_when: ['存在持久会话', '任务涉及工作区文件'],
          does_not_apply_when: ['完全无状态的单次任务'],
          suggested_check: '读取当前绑定真值并验证工作目录。',
          evidence_refs: ['evidence:workspace-regression-01'],
          reviewed_by: 'maintainer', valid_until: null,
        }) + '\n');
      } else {
        writeFileSync(join(this.experienceRoot, 'active.jsonl'), '');
      }
    }

    // 预置配置：指向**本地模拟端点**（不需要任何云 key），并把工作区钉到本 Cell 的目录。
    // 这是"离线可跑"的关键：G3 的验收不依赖任何付费模型。
    writeFileSync(join(this.stateDir, 'config.json'), JSON.stringify({
      activeScene: 'cell',
      gateway: { host: '127.0.0.1', port: 0 },
      model: { provider: 'openai', model: 'mock', baseUrl: `http://127.0.0.1:${this.modelPort}/v1`, apiKey: null },
      agent: { workDir: this.workspace, maxTurns: 6 },
      tools: { permissionMode: 'auto', timeout: 60000 },
      ...(this.cognition ? {
        cells: { context: {
          enabled: true,
          profileRoot: this.profileRoot,
          resourceRoot: this.resourceRoot,
          experienceRoot: this.experienceRoot,
          allowedProfiles: [`profile-${this.id.toLowerCase()}-v1`],
        } },
      } : {}),
    }, null, 2));

    const env = { ...process.env };
    // 干净环境：宿主的 TUSUNSUN_* 不得漏进子进程（否则两个子会读到同一个 stateDir）
    for (const k of ['TUSUNSUN_STATE_DIR', 'TUSUNSUN_PORT', 'TUSUNSUN_API_KEY', 'LLM_API_KEY',
      'TUSUNSUN_BASE_URL', 'TUSUNSUN_MODEL', 'TUSUNSUN_WORK_DIR', 'TUSUNSUN_PROFILE']) delete env[k];

    this.proc = spawn(process.execPath, [ENTRY, 'start', '--scene', 'cell', '--port', '0',
      '--state-dir', this.stateDir, '--yes'],
    // cwd 必须是**本 Cell 自己的工作区**，不能是仓库根：
    //   · `tusunsun.mjs` 会自动加载 cwd 的 `.env`，仓库根那份写着真实云端凭据
    //     ⇒ 子进程会拿它去打真模型（实测：两个子 Cell 都收到 400 路由错误，产物自然没写出来）；
    //   · 这同时也是"Cell 在自己的目录里干活"的最小证据。
    { cwd: this.workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc.stdout.on('data', (b) => { this.out += b.toString(); });
    this.proc.stderr.on('data', (b) => { this.out += b.toString(); });

    const runtimePath = join(this.stateDir, 'gateway.runtime.json');
    this.port = await waitFor(() => {
      if (!existsSync(runtimePath)) return null;
      try {
        const rt = JSON.parse(readFileSync(runtimePath, 'utf8'));
        return typeof rt.port === 'number' && rt.port > 0 ? rt.port : null;
      } catch { return null; }
    }, { what: `${this.id} 的运行期端口` });
    // "进程启动了" ≠ "准备好了"：等真实的 /ready，而不是等 listen 日志
    await waitFor(async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${this.port}/ready`, { signal: AbortSignal.timeout(2000) });
        const body = await r.json().catch(() => null);
        return body?.ready === true;
      } catch { return false; }
    }, { what: `${this.id} readiness` });
    return this;
  }

  async ws(method, params = {}) {
    const { wsRequest } = await import(join(ROOT, 'scripts', 'cli-transport.mjs'));
    return wsRequest(this.port, method, params, { timeoutMs: 120000 });
  }

  async stop() {
    if (!this.proc || this.proc.exitCode !== null) return { already: true };
    this.proc.kill('SIGTERM');
    const exited = await Promise.race([
      new Promise((r) => this.proc.once('exit', () => r(true))),
      sleep(8000).then(() => false),
    ]);
    if (!exited) { this.proc.kill('SIGKILL'); await sleep(300); }
    return { exited: true };
  }
}

/** 薄协调器：唯一职责是**按顺序拿事实、按事实下判断**，不做任何"聪明的重试"。 */
async function coordinate(base) {
  const mock = await startMockModel();
  note(`本地模拟模型端点 127.0.0.1:${mock.port}（不需要真实 API Key）`);
  const cells = [
    new CellHost({ id: 'A', base, modelPort: mock.port, cognition }),
    new CellHost({ id: 'B', base, modelPort: mock.port, cognition }),
  ];
  const evidence = [];
  let overallFailure = null;

  try {
    // ── 1. 两个独立进程各自就绪 ───────────────────────────────────
    say('\x1b[1m① 启动两个独立 Cell 宿主\x1b[0m');
    for (const c of cells) {
      await c.start();
      ok(`${c.id} 就绪：port=${c.port}  state=${c.stateDir}`);
    }
    if (cells[0].port === cells[1].port) throw new Error('两个 Cell 不得共用端口');
    if (cells[0].stateDir === cells[1].stateDir) throw new Error('两个 Cell 不得共用状态目录');

    // ── 2. 各自创建 Cell（身份独立） ──────────────────────────────
    say('\n\x1b[1m② 各自的 Cell 身份\x1b[0m');
    for (const c of cells) {
      const spec = {
        schema_version: 'tusunsun.cell/v0',
        cell_id: `cell-${c.id}`,
        workspace: c.workspace,
        // CTX-14：A 额外声明经验读取能力 —— 认知工具同样服从 Host ∩ Cell ∩ Task 的能力交集，
        // 不声明就会被能力门拦下（实测过：这正是"经验不能提权"的正面证据）。
        capabilities: cognition && c.id === 'A'
          ? ['tool.read', 'tool.write', 'tool.experience-pull']
          : ['tool.read', 'tool.write'],
        permission_mode: 'auto',
        runtime: { kind: 'process' },
        limits: { max_active_tasks: 1, max_children: 0 },
        tags: ['dual-cell-demo'],
      };
      const res = await c.ws('cell.create', { spec });
      if (!res?.ok) throw new Error(`${c.id} create 失败：${res?.error || JSON.stringify(res).slice(0, 200)}`);
      c.status = res.payload;
      ok(`${c.id}: cell_id=${c.status.cell_id}  incarnation=${c.status.incarnation_id}`);
      ok(`${c.id}: workspace_realpath=${c.status.workspace_realpath}`);
    }
    if (cells[0].status.incarnation_id === cells[1].status.incarnation_id) {
      // 两个进程同瞬间启动时时间戳可能相同 —— 用 PID 后缀保证不同；同名就是缺陷
      throw new Error('两个 Cell 的 incarnation_id 不得相同（否则结果无法归属到具体运行）');
    }

    // ── 2.5 认知配置：两个 Cell 使用不同 profile（仅 --cognition）────
    if (cognition) {
      say('\n\x1b[1m②.5 各自的 ContextProfile（不同系统提示词 / 不同地图 / 不同经验来源）\x1b[0m');
      for (const c of cells) {
        const pid = `profile-${c.id.toLowerCase()}-v1`;
        // 绑定是宿主动作：经**本机回环**的 WS 调用，`trusted` 由网关按 peer 判定。
        const r = await c.ws('cell.context.bind', { cellId: `cell-${c.id}`, profileId: pid });
        if (!r?.ok) { bad(`${c.id}: profile 绑定失败 ${r?.code || ''} — ${r?.error || ''}`); overallFailure = overallFailure || `${c.id} 绑定失败`; continue; }
        const b = r.payload;
        ok(`${c.id}: ${b.profile_id}@v${b.version}  prompt_sha256=${b.system_prompt_sha256.slice(0, 12)}…`);
      }
      // 外部的"不同"判据：两份 profile 的 prompt 哈希必须不同
      const [ba, bb] = await Promise.all(cells.map((c) => c.ws('cell.context.binding', { cellId: `cell-${c.id}` })));
      const ha = ba?.payload?.system_prompt_sha256; const hb = bb?.payload?.system_prompt_sha256;
      if (ha && hb && ha === hb) { bad('两个 Cell 的系统提示词哈希相同 —— 认知配置没有真正区分'); overallFailure = overallFailure || 'profile 未区分'; }
      else if (ha && hb) ok(`两份系统提示词哈希不同：A=${ha.slice(0, 8)}… B=${hb.slice(0, 8)}…`);
    }

    // ── 3. 两个任务：互不重叠，各自验收 ──────────────────────────
    say('\n\x1b[1m③ 各执行一个任务（互不重叠）\x1b[0m');
    const tasks = cells.map((c) => ({
      schema_version: 'tusunsun.task/v0',
      task_id: `task-${c.id.toLowerCase()}-001`,
      attempt: 1,
      target_cell_id: `cell-${c.id}`,
      // CTX-14：goal 里带上真实的失败信号词，让 A 的被动经验提示有东西可命中
      // （A 的 profile 配了 experience.provider=static，经验记录的 trigger 含 workspace_unavailable）。
      // 这不是"为了测试而编一个词"：这类信号本来就该出现在任务描述里，经验才有意义。
      goal: `把 src/target.js 复制成 outputs/result.txt`
        + (cognition && c.id === 'A' ? '（上一轮遇到过 workspace_unavailable，本次开始前请留意绑定状态）' : '')
        + `，并在 outputs/note.json 里记录 ${c.id} 的结论`,
      inputs: [{ kind: 'file', ref: 'src/target.js' }],
      required_capabilities: cognition && c.id === 'A'
        ? ['tool.read', 'tool.write', 'tool.experience-pull']
        : ['tool.read', 'tool.write'],
      budget: { max_steps: 10, wall_ms: 60000 },
      acceptance: {
        required_artifacts: failB && c.id === 'B'
          ? ['outputs/never-written.json']      // 反例：B 要求的产物不会被写出来
          : ['outputs/result.txt'],
        checks: [],
      },
    }));

    // 两个任务**并发**提交：不同 Cell 之间本就不该互相等待
    const results = await Promise.all(cells.map(async (c, i) => {
      const acc = await c.ws('cell.accept', { cellId: `cell-${c.id}`, task: tasks[i] });
      if (!acc?.ok) return { cell: c.id, accepted: false, error: acc?.error, code: acc?.code };
      const ex = await c.ws('cell.execute', { cellId: `cell-${c.id}`, task: tasks[i] });
      const ver = await c.ws('cell.verify', { cellId: `cell-${c.id}`, task: tasks[i] });
      return { cell: c.id, accepted: true, result: ex?.payload, verify: ver?.payload, error: ex?.error, wsOk: ex?.ok };
    }));

    for (const r of results) {
      if (!r.accepted) { bad(`${r.cell}: accept 被拒 ${r.code} — ${r.error}`); overallFailure = `${r.cell} accept 失败`; continue; }
      const st = r.result?.execution_state;
      if (st === 'succeeded') ok(`${r.cell}: execution_state=succeeded  steps=${r.result.usage?.steps ?? 0}  ${r.result.usage?.wall_ms ?? 0}ms`);
      else { bad(`${r.cell}: execution_state=${st} — ${r.result?.error || r.error}`); overallFailure = overallFailure || `${r.cell} 执行 ${st}`; }
      for (const a of r.result?.artifacts || []) ok(`${r.cell}: artifact ${a.path} ${a.bytes}B sha256=${a.sha256.slice(0, 16)}…`);
      if (r.result?.error) note(`  ${r.cell} 详情：${String(r.result.error).slice(0, 300)}`);
      if (r.result?._reply) note(`  ${r.cell} 模型回复：${String(r.result._reply).slice(0, 300)}`);
      const dec = r.verify?.decision;
      if (dec === 'accepted') ok(`${r.cell}: 验收 accepted（${r.verify.reason}）`);
      else { bad(`${r.cell}: 验收 ${dec} — ${r.verify?.reason}`); overallFailure = overallFailure || `${r.cell} 验收 ${dec}`; }
    }

    // ── 3.5 认知取证：模型**实际收到**的系统提示词（不看配置，看输入）──
    if (cognition) {
      say('\n\x1b[1m③.5 模型实际收到的系统提示词\x1b[0m');
      // 两个 Cell 各自发出过一次模型请求，顺序不保证 —— 按内容特征归属，而不是按先后。
      const sysList = mock.seenSystem || [];
      const toolSets = mock.seenTools || [];
      const expToolSeen = toolSets.some((names) => names.includes('tool-experience-pull'));
      note(`  模型看到的工具集：${[...new Set(toolSets.flat())].join(', ')}`);
      if (expToolSeen) ok('A 的模型请求里出现了 tool-experience-pull（工具已注册并可被发现）');
      else note('  A 的模型请求里没有 tool-experience-pull（未注册或未暴露）');
      const impl = sysList.filter((t) => t.includes('你是实现者'));
      const rev = sysList.filter((t) => t.includes('你是审查者'));
      if (!impl.length || !rev.length) {
        bad(`系统提示词归属不明：实现者 ${impl.length} 次、审查者 ${rev.length} 次（期望各 ≥1）`);
        overallFailure = overallFailure || '模型未收到预期的 profile 提示词';
      } else {
        ok(`实现者提示词被模型收到 ${impl.length} 次；审查者 ${rev.length} 次`);
      }
      // 地图不同：A 看到"实现规范"，B 看到"审查清单"，且互不可见
      const aOk = impl.some((t) => t.includes('实现规范') && !t.includes('审查清单'));
      const bOk = rev.some((t) => t.includes('审查清单') && !t.includes('实现规范'));
      if (aOk && bOk) ok('有界地图按 Cell 区分：A 只看到实现规范、B 只看到审查清单');
      else { bad(`地图串了或缺失（A 正确=${aOk}，B 正确=${bOk}）`); overallFailure = overallFailure || '地图未按 Cell 区分'; }
      // 经验：只有 A 有经验来源 ⇒ 只有 A 的输入里可能出现经验块；B 必须没有
      const aHasExp = impl.some((t) => t.includes('参考经验') || t.includes('低信任数据'));
      const bHasExp = rev.some((t) => t.includes('参考经验') || t.includes('低信任数据'));
      if (!bHasExp) ok('B（provider=none）的输入里没有任何经验块');
      else { bad('B 没有配经验来源，却收到了经验块'); overallFailure = overallFailure || '经验跨 Cell 泄漏'; }
      // A 配了静态经验、任务里也带了触发词 ⇒ 输入里**必须**出现经验块。
      // 这条从 note 提升为断言，因为"配了却没出现"正是本轮修掉的那个静默失效。
      if (aHasExp) ok('A 的输入含经验提示（低信任、带适用条件）');
      else { bad('A 配了静态经验且任务带触发词，但输入里没有经验块'); overallFailure = overallFailure || '被动经验未生效'; }

      // 主动求教：A 在**执行期间**经 ToolExecutor 拉到了详情（不是示例脚本直接读文件）。
      // 判据看模型侧收到的 tool 结果内容，而不是看有没有发出过请求。
      const pulled = sysList.length ? (mock.seenToolResults || []).filter((t) => t.includes('exp-writepath-001')) : [];
      if (pulled.length) {
        const sample = pulled[pulled.length - 1];
        ok(`A 在执行期间主动拉到经验详情（${sample.length} 字符，含 evidence_refs）`);
        if (!/evidence_refs/.test(sample)) { bad('经验详情里没有 evidence_refs'); overallFailure = overallFailure || '经验详情缺证据'; }
      } else {
        bad('A 声明了 tool-experience-pull 且模型发起了调用，但没有拿到详情');
        overallFailure = overallFailure || '主动经验拉取未生效';
      }
    }

    // ── 4. 协调器**自己**复算 hash 与目录隔离（子进程自报不算证据） ──
    say('\n\x1b[1m④ 外部复核（协调器自己算，不信自报）\x1b[0m');
    for (const r of results) {
      if (!r.result?.artifacts?.length) continue;
      const c = cells.find((x) => x.id === r.cell);
      for (const a of r.result.artifacts) {
        const abs = join(c.workspace, a.path);
        if (!existsSync(abs)) { bad(`${r.cell}: 自报产物不存在于磁盘：${abs}`); overallFailure = overallFailure || '产物缺失'; continue; }
        const real = sha256(readFileSync(abs));
        if (real !== a.sha256) { bad(`${r.cell}: 产物 hash 不符（自报 ${a.sha256.slice(0, 12)}，实测 ${real.slice(0, 12)}）`); overallFailure = overallFailure || 'hash 不符'; }
        else ok(`${r.cell}: hash 复算一致 ${a.path}`);
        // 关键隔离判据：A 的产物不得出现在 B 的工作区
        const other = cells.find((x) => x.id !== r.cell);
        const otherAbs = join(other.workspace, a.path);
        const allowed = existsSync(otherAbs) && sha256(readFileSync(otherAbs)) !== real;
        const leaked = existsSync(otherAbs) && sha256(readFileSync(otherAbs)) === real && r.cell === 'A';
        if (leaked && !allowed) { bad(`目录串了：${r.cell} 的产物一模一样地出现在 ${other.id} 的工作区`); overallFailure = overallFailure || '目录串用'; }
      }
      evidence.push({ cell: r.cell, artifacts: r.result.artifacts.map((a) => ({ path: a.path, sha256: a.sha256 })), decision: r.verify?.decision });
    }
    ok(`目录隔离：A 的产物在 ${cells[0].workspace}、B 的在 ${cells[1].workspace}（无交叉）`);

    // ── 5. 审计记录落盘 ─────────────────────────────────────────
    say('\n\x1b[1m⑤ 各 Cell 的审计记录\x1b[0m');
    for (const c of cells) {
      const dir = join(c.stateDir, 'cells', `cell-${c.id}`);
      if (existsSync(join(dir, 'cell.json'))) ok(`${c.id}: ${join(dir, 'cell.json')}`);
      if (existsSync(join(dir, 'results.jsonl'))) {
        const n = readFileSync(join(dir, 'results.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length;
        ok(`${c.id}: results.jsonl ${n} 条`);
      }
    }
  } catch (err) {
    bad(`协调失败：${err?.message || err}`);
    overallFailure = overallFailure || String(err?.message || err);
  } finally {
    mock.server.close();
    // ── 6. 回收：不留进程、不留端口 ──────────────────────────────
    say('\n\x1b[1m⑥ 回收\x1b[0m');
    for (const c of cells) {
      try { await c.stop(); } catch (err) { bad(`${c.id} 停止失败：${err.message}`); overallFailure = overallFailure || `${c.id} 未回收`; }
      const alive = c.proc && c.proc.exitCode === null;
      if (alive) { bad(`${c.id} 进程仍在（pid ${c.proc?.pid}）`); overallFailure = overallFailure || `${c.id} 残留进程`; }
      else ok(`${c.id} 已退出（pid ${c.proc?.pid}）`);
    }
    // 端口释放复核：用一个新连接确认没人再监听
    for (const c of cells) {
      if (!c.port) continue;
      let stillListening = false;
      try {
        await fetch(`http://127.0.0.1:${c.port}/health`, { signal: AbortSignal.timeout(1200) });
        stillListening = true;
      } catch { stillListening = false; }
      if (stillListening) { bad(`${c.id} 的端口 ${c.port} 仍在监听`); overallFailure = overallFailure || `${c.id} 端口残留`; }
      else ok(`${c.id} 的端口 ${c.port} 已释放`);
    }
  }

  return { overallFailure, evidence, cells };
}

async function main() {
  const base = mkdtempSync(join(tmpdir(), 'tusunsun-dual-cell-'));
  say(`\n\x1b[1m土行孙 · 双 Cell 最小协作\x1b[0m`);
  say(`  临时根  ${base}`);
  say(`  模式    ${failB ? '反例（B 的验收产物缺失，整体不得报成功）' : '正例（两个子任务都成功）'}`);
  say('');

  const { overallFailure, evidence } = await coordinate(base);

  say('\n\x1b[1m结论\x1b[0m');
  if (failB) {
    // 反例模式：**必须**有失败。没有失败才是不合格（"另一路成功就整体变绿"是最危险的假绿）。
    if (overallFailure) ok(`如预期失败：${overallFailure}（另一路成功没有让整体变绿）`);
    else { bad('反例模式下整体竟然全绿 —— 这是"一个成功掩盖另一个失败"的缺陷'); if (!keep) rmSync(base, { recursive: true, force: true }); return 1; }
  } else if (overallFailure) {
    bad(`存在失败：${overallFailure}`);
    if (!keep) rmSync(base, { recursive: true, force: true });
    return 1;
  } else {
    ok('两个 Cell 各自执行、各自验收、外部复核一致、进程与端口全部回收');
  }

  const evFile = join(base, 'evidence.json');
  writeFileSync(evFile, JSON.stringify({ failB, evidence, overallFailure }, null, 2));
  ok(`证据：${evFile}`);

  if (keep) say(`\n临时目录保留：${base}`);
  else rmSync(base, { recursive: true, force: true });
  return 0;
}

main().then((c) => process.exit(c)).catch((err) => {
  process.stderr.write(`\x1b[31m失败\x1b[0m：${err?.stack || err}\n`);
  process.exit(1);
});
