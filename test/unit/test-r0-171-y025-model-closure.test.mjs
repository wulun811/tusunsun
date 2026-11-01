// R0-171：Y025 软闸的**模型闭环**
//
// 断点：
//   · haotian-lite 只对 `blocked` 走 toLLMText，`needs_reasoning` 落进 `Error: ${tr.error}`
//     ⇒ 模型看不到实测文件数、范围、四个问题与重试字段；
//   · tool-bash 的模型可见 `parameters` 只有 `command` ⇒ 模型无从发现 `danger_ack`；
//   · tool-loader 回收后的存根把 `parameters` 写死成空 schema ⇒ 同一工具三处三份契约。
//
// 验收矩阵：
//   T1 第一次危险调用 → needs_reasoning；下一轮模型真的看得见；零副作用
//   T2 按**可见信息**重试 → 进入原执行路径；结果取真实执行事实；handler 看不到 danger_ack
//   T3 相邻反例：数字/范围/理由/次数/TTL/unbounded/mixed/损坏载荷/有界输出
//   T4 懒索引 → 加载 → 回收，三处对模型是同一份 schema
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assert, assertEquals } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(pathToFileURL(join(ROOT, rel)).href);

const LONG_REASON = '这些文件已经全部迁到 src/kernel，并在 CI 的三个 Node 版本上验证通过，旧目录只剩过时副本';

/** 最小执行器（与 R0-119 同款）＋真实 tool-bash ＋可编排的假模型。 */
async function makeAgent({ workDir, steps }) {
  const { Core } = await imp('src/core/core.js');
  const ToolExecutor = (await imp('plugins/tool-executor.js')).default;
  const toolBash = (await imp('plugins/tools/tool-bash.js')).default;
  const haotian = (await imp('plugins/haotian-lite.js')).default;

  const core = new Core();
  const logs = [];
  core.log = (level, msg, meta) => { logs.push({ level, msg, meta }); };
  core.setData('agent.workDir', workDir);
  const cfg = new Map();
  core.registerService('config', {
    get: (k, fb) => (cfg.has(k) ? cfg.get(k) : fb),
    set: (k, v) => { cfg.set(k, v); return true; },
  });

  const ex = Object.create(ToolExecutor);
  Object.assign(ex, {
    core, _tools: new Map(), _aliases: new Map(), _preHooks: [], _postHooks: [],
    _metrics: new Map(), _auditLog: new Map(), _cache: new Map(), _cacheOrder: [],
    _preferences: new Map(), _rateCalls: new Map(), _maxParallel: 2, _useSandbox: false,
  });
  core.registerService('tool-executor', ex);

  // 真实工具：init 会把 `declarableSchema(parameters)` 注册成 input_schema —— 嵌套的
  // `danger_ack` 声明若没被剥成属性级 `type`，这里会直接 schema_unsupported 装不上。
  await toolBash.init(core);
  const captured = [];
  const origExecute = toolBash.execute;
  toolBash.execute = async function (args) { captured.push({ ...args }); return origExecute.call(this, args); };
  const restore = () => { toolBash.execute = origExecute; };

  const seen = [];
  let i = 0;
  core.registerService('model', {
    callTier: async (_tier, messages) => {
      seen.push(JSON.parse(JSON.stringify(messages)));
      const step = steps[Math.min(i, steps.length - 1)];
      i += 1;
      return typeof step === 'function' ? step(messages, seen.length) : step;
    },
  });

  await haotian.init(core);
  return { core, ex, captured, logs, seen, haotian, restore };
}

const toolCall = (id, args) => ({ tool_calls: [{ id, name: 'tool-bash', arguments: JSON.stringify(args) }] });
const toolTextOf = (messages) => messages.filter((m) => m.role === 'tool').map((m) => String(m.content)).join('\n');

export async function setup(runner) {
  const tmp = mkdtempSync(join(tmpdir(), 'tt-r0171-'));
  runner.afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  let wsSeq = 0;
  /** 每次重建工作区：d1 里 3 个文件（数字要小到一眼能核）。 */
  const freshWs = () => {
    const ws = join(tmp, `ws${++wsSeq}`);
    mkdirSync(join(ws, 'd1'), { recursive: true });
    for (const f of ['a', 'b', 'c']) writeFileSync(join(ws, 'd1', `${f}.js`), 'x\n');
    writeFileSync(join(ws, 'main.js'), 'old\n');
    return ws;
  };

  // ── T1 挑战必须到达模型，且第一次零副作用 ─────────────────────────
  runner.test('R0-171/T1 第一次危险调用：needs_reasoning 带着实测影响面进入下一轮模型输入，文件未动', async () => {
    const ws = freshWs();
    const { captured, seen, haotian, restore } = await makeAgent({
      workDir: ws,
      steps: [toolCall('c1', { command: 'rm -r d1' }), { content: '先不动，我看到了影响面。' }],
    });
    try {
      const res = await haotian.handle({ message: '清理 d1', sessionId: 's-y025-t1' });
      assertEquals(res.error, undefined, `这一轮不该报错：${res.reply}`);
      assertEquals(seen.length, 2, `模型应被调用两次（挑战前后），实际 ${seen.length}`);
      const text = toolTextOf(seen[1]);
      for (const must of ['Y025', 'files: 3', 'scope: inside', 'danger_ack', '请先回答', '不是人工批准']) {
        assert(text.includes(must), `模型在下一轮看不到「${must}」，实际：\n${text}`);
      }
      assert(/这一步是否必要/.test(text), '四个问题之一缺失');
      assert(/原样重发/.test(text), '重试方式必须写清楚');
      assertEquals(captured.length, 0, '挑战阶段不得执行任何命令');
      assertEquals(readdirSync(join(ws, 'd1')).length, 3, '第一次调用后文件必须原样还在');
      console.log('       [实测] 第二轮模型输入可见：' + text.split('\n').slice(0, 6).join(' | '));
    } finally { restore(); }
  });

  // ── T2 按可见信息重试 → 真实执行；确认不是人类批准 ──────────────────
  runner.test('R0-171/T2 模型按可见 schema 重试：数字来自挑战文本，执行结果取真实事实，handler 看不到 danger_ack', async () => {
    const ws = freshWs();
    const { captured, logs, haotian, restore } = await makeAgent({
      workDir: ws,
      steps: [
        toolCall('c1', { command: 'rm -r d1' }),
        // 第二步**只从上一轮读到的文本**里取 files/scope —— 证明重试信息来自可见输出，
        // 不是测试自己早就知道答案。
        (messages) => {
          const text = toolTextOf(messages);
          const files = Number(/files: (\d+)/.exec(text)?.[1] ?? NaN);
          const scope = /scope: (inside|mixed)/.exec(text)?.[1];
          return toolCall('c2', { command: 'rm -r d1', danger_ack: { reason: LONG_REASON, files, scope } });
        },
        { content: '已删除。' },
      ],
    });
    try {
      const res = await haotian.handle({ message: '清理 d1', sessionId: 's-y025-t2' });
      assertEquals(res.error, undefined, `这一轮不该报错：${res.reply}`);
      assertEquals(existsSync(join(ws, 'd1')), false, '确认通过后必须真的执行（d1 应被删掉）');
      assertEquals(captured.length, 1, `工具只应执行一次，实际 ${captured.length}`);
      assertEquals(captured[0].danger_ack, undefined, `danger_ack 泄漏进工具入参：${JSON.stringify(captured[0])}`);
      assertEquals(captured[0].command, 'rm -r d1', 'command 必须原样保留');
      const audit = logs.find((l) => /irreversible op confirmed/.test(String(l.msg)));
      assert(audit, '确认必须进审计日志');
      assertEquals(audit.meta?.human_approved, false, 'Y025 不是人类批准，审计不得这样记');
      assertEquals(audit.meta?.ack_by, 'model-restatement', '审计必须记「模型复述影响面」这个来源');
      console.log('       [实测] 审计：human_approved=false / ack_by=model-restatement；d1 已真实删除');
    } finally { restore(); }
  });

  // ── T3 相邻反例（一张表跑完）────────────────────────────────────────
  runner.test('R0-171/T3 相邻反例矩阵：数字/范围/理由/次数/TTL/unbounded/mixed/损坏载荷/有界输出', async () => {
    const { DestructiveGate } = await imp('plugins/_lib/destructive-gate.js');
    const { toNeedsReasoningText, toLLMText } = await imp('plugins/_lib/diagnostic-lite.js');
    const ws = freshWs();
    const outside = join(tmp, `outside-${Date.now()}`);
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'o.txt'), 'x\n');

    const rows = [];
    const check = (name, pass, detail = '') => { rows.push([name, pass ? 'PASS' : 'FAIL', detail]); assert(pass, `${name} FAIL ${detail}`); };

    // ① 数字填错 → 仍是挑战，并回显实测值
    {
      const g = new DestructiveGate();
      const first = g.check('tool-bash', { command: 'rm -r d1' }, ws, { sessionId: 'a' });
      const wrong = g.check('tool-bash', { command: 'rm -r d1', danger_ack: { reason: LONG_REASON, files: 99, scope: 'inside' } }, ws, { sessionId: 'a' });
      const text = toNeedsReasoningText(wrong);
      check('数字填错必须被拒并回显实测 3', wrong.status === 'needs_reasoning' && text.includes('实测 3 个文件'),
        `status=${wrong.status}`);
      assertEquals(readdirSync(join(ws, 'd1')).length, 3, '填错数字不得产生副作用');
      void first;
    }

    // ② 范围填错（mixed 报成 inside）→ 具名纠错
    {
      const g = new DestructiveGate();
      const cmd = `rm -r d1 ${outside}`;
      const first = g.check('tool-bash', { command: cmd }, ws, { sessionId: 'b' });
      assertEquals(first.challenge.measured.scope, 'mixed', '工作区外目标必须让 scope=mixed');
      assertEquals(first.challenge.measured.files, 4, '应为 3+1 个文件');
      const wrong = g.check('tool-bash', { command: cmd, danger_ack: { reason: LONG_REASON, files: 4, scope: 'inside' } }, ws, { sessionId: 'b' });
      const text = toNeedsReasoningText(wrong);
      check('mixed 报成 inside 必须被拒', wrong.status === 'needs_reasoning' && /scope 应为 "mixed"/.test(text), text.split('\n')[0]);
      const ok = g.check('tool-bash', { command: cmd, danger_ack: { reason: LONG_REASON, files: 4, scope: 'mixed' } }, ws, { sessionId: 'b' });
      check('mixed 如实填写可通过（但仍受围栏约束）', ok?.__ack === true, JSON.stringify(ok && ok.record?.measured?.scope));
    }

    // ③ 理由太短 → 具名纠错，且不执行
    {
      const g = new DestructiveGate();
      g.check('tool-bash', { command: 'rm -r d1' }, ws, { sessionId: 'c' });
      const wrong = g.check('tool-bash', { command: 'rm -r d1', danger_ack: { reason: '要删', files: 3, scope: 'inside' } }, ws, { sessionId: 'c' });
      check('reason < 24 字必须被拒', wrong.status === 'needs_reasoning' && /至少 24 个字符/.test(toNeedsReasoningText(wrong)));
    }

    // ④ 三次失败后封闭（复用 R0-121/T5 的活锁防线，这里只核矩阵这一格）
    {
      const g = new DestructiveGate();
      const bad = () => g.check('tool-bash', { command: 'rm -r d1', danger_ack: { reason: LONG_REASON, files: 99, scope: 'inside' } }, ws, { sessionId: 'd' });
      g.check('tool-bash', { command: 'rm -r d1' }, ws, { sessionId: 'd' });
      bad(); bad();
      const third = bad();
      const again = g.check('tool-bash', { command: 'rm -r d1' }, ws, { sessionId: 'd' });
      check('三次失败后封闭且粘住', third.status === 'blocked' && again.status === 'blocked', `${third.status}/${again.status}`);
    }

    // ⑤ 过期（10 分钟）：把记录时间前移等价于等待，避免测试真挂 10 分钟
    {
      const g = new DestructiveGate();
      g.check('tool-bash', { command: 'rm -r d1' }, ws, { sessionId: 'e' });
      for (const v of g._pending.values()) v.at = Date.now() - 11 * 60 * 1000;
      const res = g.check('tool-bash', { command: 'rm -r d1', danger_ack: { reason: LONG_REASON, files: 3, scope: 'inside' } }, ws, { sessionId: 'e' });
      check('过期确认不得复用', res.status === 'needs_reasoning' && res.challenge.measured.files === 3, `status=${res.status}`);
    }

    // ⑥ unbounded：数字必须写成字符串 "unbounded"，且文案不把它伪装成"安全"
    {
      const g = new DestructiveGate();
      const first = g.check('tool-bash', { command: 'find . -name "*.log" -delete' }, ws, { sessionId: 'f' });
      assertEquals(first.challenge.measured.files, 'unbounded', 'find 的范围必须如实报 unbounded');
      const text = toNeedsReasoningText(first);
      check('unbounded 不得伪装成已知数量', /unbounded ≠ 安全/.test(text));
      const wrong = g.check('tool-bash', { command: 'find . -name "*.log" -delete', danger_ack: { reason: LONG_REASON, files: 0, scope: 'inside' } }, ws, { sessionId: 'f' });
      check('unbounded 回填数字必须被拒', wrong.status === 'needs_reasoning' && /"unbounded"/.test(toNeedsReasoningText(wrong)));
    }

    // ⑦ 损坏载荷：明确报告，不猜数字、不编造重试合同
    {
      const broken = toNeedsReasoningText({ tool: 'tool-bash', diagnostic: { code: 'Y025', reason: 'x' }, challenge: { measured: { files: 'many', scope: 'inside' } } });
      check('measured.files 非法 → 明确报告', /挑战载荷不完整/.test(broken) && !/files: \d/.test(broken), broken.split('\n')[2]);
      const noRequired = toNeedsReasoningText({ tool: 'tool-bash', diagnostic: { code: 'Y025' }, challenge: { measured: { files: 3, scope: 'inside' }, why: 'w' } });
      check('缺少 required → 不猜参数名', /重试字段结构缺失/.test(noRequired));
      const blockedText = toLLMText({ code: 'Y025', reason: 'r', tool: 'tool-bash' });
      check('blocked 与 needs_reasoning 文本必须不同', blockedText.startsWith('[Blocked]') && !blockedText.includes('[Needs reasoning]'));
    }

    // ⑧ 有界输出：50 个超长样本 → 最多 8 条、整体不超过上限
    {
      const samples = Array.from({ length: 50 }, (_, i) => ({ path: '/x/'.padEnd(400, 'p') + i, kind: 'inside', files: 1 }));
      const text = toNeedsReasoningText({
        tool: 'tool-bash', diagnostic: { code: 'Y025' },
        challenge: { why: 'w', measured: { files: 50, dirs: 0, scope: 'inside', samples }, questions: ['q'], required: { danger_ack: { reason: 'r' } } },
      });
      const sampleLines = text.split('\n').filter((l) => l.startsWith('  - inside')).length;
      check('样本最多 8 条、总长受控', sampleLines <= 8 && text.length <= 4100, `samples=${sampleLines} len=${text.length}`);
    }

    console.log('\n       [矩阵] 相邻反例');
    for (const [name, verdict, detail] of rows) console.log(`         ${verdict}  ${name}${detail ? ` — ${detail}` : ''}`);
  });

  // ── T4 懒索引 / 加载 / 回收：模型看到同一份 schema ───────────────────
  runner.test('R0-171/T4 工具 schema 在懒索引→加载→回收三处一致（回收不得退化成空 schema）', async () => {
    const { Core } = await imp('src/core/core.js');
    const { default: ToolLoader } = await imp('plugins/tool-loader.js');
    const { declarableSchema } = await imp('plugins/tools/lib/schema.mjs');

    const root = join(tmp, 'loader');
    const toolsDir = join(root, 'tools');
    mkdirSync(toolsDir, { recursive: true });
    const declared = {
      type: 'object',
      properties: {
        command: { type: 'string' },
        danger_ack: {
          type: 'object',
          description: 'nested',
          properties: { reason: { type: 'string' }, files: { anyOf: [{ type: 'integer' }, { type: 'string' }] } },
          required: ['reason', 'files'],
        },
      },
      required: ['command'],
    };
    writeFileSync(join(toolsDir, 'tool-demo.js'), [
      'export default {',
      "  name: 'tool-demo',",
      "  description: 'demo tool',",
      `  parameters: ${JSON.stringify(declared)},`,
      '  init(core) { core.registerCapability("tool.demo", { description: "x", input_schema: declarableSchema(this.parameters), handler: () => ({ ok: true }), owner: "tool-demo" }); },',
      '};',
      '',
    ].join('\n'));

    const core = new Core();
    core.log = () => {};
    // loader.init 里用 `join(core.pluginsDir, 'tools')` 定位工具目录
    core.pluginsDir = root;
    const loader = new (ToolLoader.constructor)();
    await loader.init(core);
    const dump = () => JSON.stringify(loader.list().find((t) => t.name === 'tool-demo')?.parameters);
    const indexed = dump();
    await loader._lazyLoadTool('tool-demo');
    const loaded = dump();
    await loader.recycleTool('tool-demo');
    const recycled = dump();
    loader.stop();

    assertEquals(indexed, JSON.stringify(declared), '懒索引时的 schema 必须是完整声明');
    assertEquals(loaded, JSON.stringify(declared), '懒加载后必须还是同一份');
    assertEquals(recycled, JSON.stringify(declared), '回收后不得退化成空 schema');
    // 注册层只拿属性级 type：嵌套 properties/required 必须被剥掉，否则工具装不上。
    const decl = declarableSchema(declared);
    assertEquals(JSON.stringify(decl.properties.danger_ack), JSON.stringify({ type: 'object', description: 'nested' }),
      `input_schema 必须剥掉嵌套子结构：${JSON.stringify(decl.properties.danger_ack)}`);
    console.log('       [实测] indexed == loaded == recycled；input_schema 只保留属性级 type');
  });
}
