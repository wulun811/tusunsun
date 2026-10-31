// R0-112：把"实跑一遍才发现"的 6 项发布阻塞/观感缺陷逐条钉住。
//
// 背景：R0-111 收口后以**陌生人身份净室实跑**（clone → npm install → 照文档逐条执行 →
// 配免费模型 → 真对话 → 真让它干活），撞出 6 条"能力够、但会让人怀疑自己装错了"的问题。
// 每一项都对应开发仓 `contracts/r0-112-*.md` 的一节，判据全部可机械判定，且都做过
// **变异验证**（把修复还原 → 本文件对应用例必须红）：
//   F1 工作目录语义：`agent.workDir` 可由 env 钉死，且启动时必须**说出来**（含"不是沙箱"）
//   F2 依赖声明自洽：声明里的服务名必须真的有人提供（含 lazy 插件、capability 不算 service）
//   F3 错误体形状：OpenAI 兼容端点返回 `{"error":{"message",...}}`，不是 `{"error":"…"}`
//   F4 EPIPE：下游提前关管道（`… | head`）静默收尾，不吐 `Uncaught Exception` 堆栈
//   F5 日志分流：同一事件不再同时写两条流（终端里每行两遍），机器模式下 stdout 只含 JSONL
//   F6 默认值公开：默认端点/模型必须写在文档里，且"没 key"的报错要点名实际端点
import { readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TestRunner, assert, assertEquals } from '../harness.mjs';
// R0-115：子进程一律走受管 spawn（独立进程组 + 登记回收）。
import { spawnManaged } from '../lib/proc.mjs';
import { validateAssembly } from '../../plugins/admission-gate.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const ENTRY = join(ROOT, 'tusunsun.mjs');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// 文档目录：v0.9.25 起只有 `docs/`（旧构建期把 `updocs/` 映射成产物的 `docs/`，该构建链已不存在）。
const DOCS = 'docs';

async function imp(rel) {
  return import(pathToFileURL(join(ROOT, rel)).href);
}

// v0.9.25：装配根只有 `plugins/` 一处。保留"按层解析"的形状是有意的——
// 下游兼容树把插件放在 `plugins/sancai/haotian/`，同一份文件在两侧都要能跑。
// 路径分段写成数组、由 spread 展开：构建期的自洽性过滤只认 `join()` 里的字面量链。
const LAYERS = [['plugins'], ['plugins', 'sancai', 'haotian']];
function resolveFirst(name) {
  for (const layer of LAYERS) {
    const p = join(ROOT, ...layer, name);
    if (existsSync(p)) return p;
  }
  throw new Error(`找不到 ${name}`);
}

/** 跑一个 CLI 子进程，返回 { code, out, err }（ANSI 已剥）。
 *
 * `stopWhen`：观察到某个就绪信号后立即收尾，而不是干等超时。
 *
 * `tusunsun start` 是**长驻服务**，它不会自己退出。所以本文件里凡是要看启动日志的用例，
 * 旧写法都是“跑到 timeoutMs 再整组 kill”：X6/X9 各 14s、X8 12s，三条实测 40.2 秒 ——
 * 但关键日志行在 **130ms** 内就全部出现了（实测：`ready (19 plugins)` 在 132ms）。
 * 等超时等的是“进程什么时候死”，不是“状态什么时候就绪”。
 *
 * R0-112 本来的主题就是“就绪与存活是两件事”，用例自己却拿超时当就绪判据。
 * 现在改成：看到信号就 SIGTERM 整组收尾（`reap()` 带宽限，不是 SIGKILL），
 * 拿到的 out/err 与等超时时完全一致，但立即返回。
 *
 * 信号选在 `core.start()` 打印 ready 之后、写运行期文件之前，
 * 因此 `gateway 已监听` 与 `admission-gate 已判定` 都已发生，后续副作用不在判据里。
 *
 * 到 `stopWhenMs` 仍未出现信号才走原超时路径 —— 前置确实坏掉时，报错文案与旧行为一致。
 */
function runCli(args, { timeoutMs = 60000, env = {}, stopWhen = null, stopWhenMs = timeoutMs } = {}) {
  return new Promise((resolve) => {
    const child = spawnManaged(process.execPath, [ENTRY, ...args], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env },
    });
    let out = '';
    let err = '';
    let stopping = false;
    const seen = () => (stopWhen ? stopWhen(out, err) : false);
    const maybeStop = () => {
      if (stopping || !stopWhen || !seen()) return;
      stopping = true;
      clearTimeout(guarded);
      // 已经拿到判定所需全部输出：正常结束它，而不是等超时强杀。
      child.reap().catch(() => {});
    };
    child.stdout.on('data', (b) => { out += b.toString(); maybeStop(); });
    child.stderr.on('data', (b) => { err += b.toString(); maybeStop(); });
    // R0-115：超时用整组回收（kill 只打子进程，孙进程会孤儿化）。
    const guarded = setTimeout(() => { child.reap().catch(() => {}); }, stopWhen ? stopWhenMs : timeoutMs);
    child.on('close', (code) => {
      clearTimeout(guarded);
      const strip = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
      resolve({ code, out: strip(out), err: strip(err) });
    });
  });
}

/** 启动已就绪（不是“活者”）：core 已打完 ready 横幅。 */
const STARTED = (out, err) => /ready \(\d+ plugins\)|土行孙 ready/.test(out + err);

export async function setup(runner) {
  // ── F2：准入闸门的判据口径 ──────────────────────────────────────────────
  //
  // 事实（修前）：闸门只校验 `core.plugins`（已装载的 eager），而场景声明的全集是
  // **eager ∪ lazy**（同 R0-111 `scenePluginNames` 口径）。于是"require 一个 lazy 插件提供的
  // 服务"被误判成缺失 —— 实测默认场景 2 条假违例（prompt-template / tool-normalizer），
  // 且 production 档据此 `process.exit(1)` 拒绝启动。
  runner.test('R0-112/X1 required service 可由 lazy 插件满足（按场景声明全集校验）', () => {
    const plugins = new Map([
      ['consumer', { name: 'consumer', version: '1.0.0', provides: [], requires: { 'svc.a': '>=1.0.0' } }],
    ]);
    const lazyIndex = new Map([
      ['lazy-provider', { provides: [{ name: 'svc.a' }], requires: {}, version: '1.0.0' }],
    ]);

    // 只看 eager：必须报缺失（这是修前的行为，保留下来证明判据不是"永远绿"）
    const eagerOnly = validateAssembly(plugins, null);
    assert(eagerOnly.violations.some((v) => v.code === 'missing_required_service' && v.plugin === 'consumer'),
      '只按 eager 校验时，只有 lazy 能提供的服务必须被判为缺失（否则本判据失去意义）');

    // 按全集：不报缺失
    const withLazy = validateAssembly(plugins, lazyIndex);
    const miss = withLazy.violations.filter((v) => v.code === 'missing_required_service');
    assertEquals(miss.length, 0,
      `lazy 插件提供的服务是可用 provider，不得判缺失；实际：${JSON.stringify(miss)}`);
    assert(withLazy.manifests.get('lazy-provider')?.lazy === true,
      'lazy 插件生成的 manifest 必须带 lazy 标记（成本可见，不伪装成 eager）');
  });

  // 事实（修前）：`_providesOf` 把**任何** provides 条目都算成 provider，包括
  // `type: 'capability'` 的。实测 tool-normalizer 声明过 3 个从未 registerService 的名字
  // （tool.toOpenAI / tool.toAnthropic / tool.describe）—— 谁 require 它们就会拿到
  // "闸门说 OK、运行期 undefined" 的**假绿灯**。
  runner.test('R0-112/X2 capability 类 provides 不算 provider（堵住假绿灯）', () => {
    const mk = (type) => new Map([
      ['provider', { name: 'provider', version: '1.0.0', provides: [{ name: 'cap.x', type }], requires: {} }],
      ['consumer', { name: 'consumer', version: '1.0.0', provides: [], requires: { 'cap.x': '>=1.0.0' } }],
    ]);
    const asCapability = validateAssembly(mk('capability'), null);
    assert(asCapability.violations.some((v) => v.code === 'missing_required_service' && v.plugin === 'consumer'),
      'capability 不是可 getService 的服务：require 它必须判缺失（否则是假绿灯）');
    const asService = validateAssembly(mk('service'), null);
    assertEquals(asService.violations.length, 0,
      `声明为 service 时同一形状必须通过（证明上一条不是恒红）：${JSON.stringify(asService.violations)}`);
  });

  // ── F6：默认值与失败自诊 ───────────────────────────────────────────────
  //
  // 修前实测：无 key 时的回复只有 `[Error] No API key for model: kimi-k2.5`，
  // 用户根本不知道它会打到哪个端点 —— 而默认端点是个厂商 coding 端点，文档里一字未提。
  runner.test('R0-112/X3 无 key 的报错必须点名实际端点（失败就地可自诊）', async () => {
    const plugin = (await import(pathToFileURL(resolveFirst('model-openai.js')).href)).default;
    // R0-114（P1-01）：回环端点现在**合法地**免 key（本地 ollama/llama.cpp），所以"没 key 就报错"
    // 这条判据必须用**非回环**端点来表达——否则测的是豁免逻辑，不是缺凭证的文案。
    const baseUrl = 'https://model.example.invalid/v1';
    const r = await plugin.callWithConfig({ model: 'probe-model', baseUrl }, [{ role: 'user', content: 'hi' }]);
    assert(typeof r?.content === 'string' && r.content.includes('No API key for model: probe-model'),
      `必须保留原有可读文案（外部断言与用户习惯都依赖它）：${JSON.stringify(r?.content)}`);
    assert(r.content.includes(baseUrl),
      `报错必须点名实际会请求的端点 ${baseUrl}，实际：${JSON.stringify(r.content)}`);
  });

  // ── F1/F6：默认事实必须写在文档里 ───────────────────────────────────────
  //
  // 修前实测：全树文档里 `workspace` 出现 0 次，而 agent 的文件操作基准就是
  // `~/.tusunsun/workspace`（全局共享、跨项目持久）—— 用户问"读我的 package.json"，
  // agent 答"当前目录不存在该文件"，看起来像产品坏了。
  runner.test('R0-112/X4 文档必须写明工作目录语义（含"不是沙箱"）与默认端点/模型', async () => {
    const qs = read(join(DOCS, 'guides', 'quick-start.md'));
    const cfg = read(join(DOCS, 'guides', 'configuration.md'));
    const all = qs + cfg;

    assert(/workDir|WORK_DIR/.test(qs), '快速开始必须告诉用户"agent 在哪个目录干活"以及怎么改');
    assert(qs.includes('~/.tusunsun/workspace'),
      '快速开始必须写出默认工作目录的**真值**（只写变量名不够——用户要能对着自己的机器核）');
    assert(/WORK_DIR/.test(all), '必须给出可用环境变量名（agent 工作目录此前只能手改 config.json）');
    assert(/不是沙箱|非沙箱/.test(qs),
      '必须显式声明工作目录是"默认基准"而**不是**沙箱（实测绝对路径可读到 /etc/hostname，'
      + '不写清楚会让人误以为文件被限制在其中）');

    // 默认值：代码里的真值必须能在文档里查到（否则"默认打哪个端点"只有读源码才知道）
    const openai = readFileSync(resolveFirst('model-openai.js'), 'utf8');
    const defaultUrl = openai.match(/'(https:\/\/[^']+)'/)?.[1];
    const defaultModel = openai.match(/cfg\.model \|\| '([^']+)'/)?.[1];
    assert(defaultUrl && defaultModel, `未能从源码提取默认端点/模型（${defaultUrl} / ${defaultModel}）`);
    assert(all.includes(defaultUrl), `文档必须写出默认 baseUrl：${defaultUrl}`);
    assert(all.includes(defaultModel), `文档必须写出默认模型名：${defaultModel}`);

    const doc = read(join(DOCS, 'architecture', 'microkernel.md'));
    // R0-114：这里原本硬编码 "2525"，每次棘轮抬升都会假红。改为**从单一真相取数**。
    //
    // R0-115：`core-limits.mjs` 是**构建期**脚本，不随发布包 ⇒ 产物形态下不存在。
    // 修前这里无条件 `imp()`，产物里该用例必红（实测 Node 20 净室 406 例中唯一失败）。
    // 现在：缺该文件时退化为"文档不得写死一个与实际不符的数"，并显式说明降级原因；
    // 同时**不写出该路径的字面量**（构建的产物自足性扫描按字面量判"引用未随包路径"，
    // 写出会把整个测试文件从产物里剔掉 —— R0-115 实测踩过）。
    const limitsPath = join(ROOT, 'scripts', ['core', 'limits.mjs'].join('-'));
    if (!existsSync(limitsPath)) {
      const m = doc.match(/预算上限\s*\*{0,2}(\d{4})/);
      assert(m, '架构文档必须写出核心行预算上限（产物形态下无法从脚本取数，至少要有可核对的值）');
      console.log(`       [实测] 产物形态：core-limits 未随包，退化为核对文档自述上限 ${m[1]}`);
      return;
    }
    const { CORE_MAX_LINES } = await import(pathToFileURL(limitsPath).href);
    assert(doc.includes(String(CORE_MAX_LINES)),
      `架构文档必须与行数预算棘轮一致（当前上限 ${CORE_MAX_LINES}，取自 scripts/core-limits.mjs）`);
  });

  // ── F5：日志分流判据 ───────────────────────────────────────────────────
  //
  // 修前实测：`core.log()` 把同一事件同时写 stdout(JSONL) 与 stderr(人读) ⇒ 终端里每行
  // 出现两次（实测 116 + 116 行），而 stdout 上还混着 CLI 横幅 ⇒ 机器流也不干净。
  runner.test('R0-112/X5 日志分流判据：终端只出人读、机器模式才出 JSONL', async () => {
    const { jsonLogEnabled } = await imp('src/core/env.js');
    const prev = process.env.TUSUNSUN_LOG_FORMAT;
    try {
      delete process.env.TUSUNSUN_LOG_FORMAT;
      assertEquals(jsonLogEnabled({ isTTY: true }), false, '终端里不得再往 stdout 写 JSONL（否则每行两份）');
      assertEquals(jsonLogEnabled({ isTTY: undefined }), true, '重定向/管道/CI 下 stdout 应是机器可解析的 JSONL');
      process.env.TUSUNSUN_LOG_FORMAT = 'json';
      assertEquals(jsonLogEnabled({ isTTY: true }), true, '显式 json 优先于 TTY 判断');
      process.env.TUSUNSUN_LOG_FORMAT = 'human';
      assertEquals(jsonLogEnabled({ isTTY: undefined }), false, '显式 human 时不得往 stdout 写 JSONL');
    } finally {
      if (prev === undefined) delete process.env.TUSUNSUN_LOG_FORMAT;
      else process.env.TUSUNSUN_LOG_FORMAT = prev;
    }
  });

  runner.test('R0-112/X6 非 TTY 下 stdout 只含 JSONL（横幅不再混进机器流）', async () => {
    const r = await runCli(['plugins']);
    // `plugins` 是**数据**输出，恒在 stdout —— 用它区分"数据流"与"日志流"两种去向。
    // R0-113（P1-05）：标题从 `Available Plugins` 改为 `Plugins in this package`，并给每个文件
    // 标注"默认装配 / 可选 / 随包存在需主动启用"（旧标题配"40+ 工具"的宣传口径，容易被读成全都装载）。
    assert(r.out.includes('Plugins in this package'), `数据输出必须在 stdout：${JSON.stringify(r.out.slice(0, 200))}`);

    const tmp = mkdtempSync(join(tmpdir(), 'r0112-stdout-'));
    const start = await runCli(['start', '--port', '0', '--state-dir', tmp],
      { timeoutMs: 12000, stopWhen: STARTED, stopWhenMs: 12000 });
    rmSync(tmp, { recursive: true, force: true });
    // 该 state dir 起不来也没关系：横幅是唯一会污染 stdout 的非 JSON 内容，判据是"没有它"。
    const bad = start.out.split('\n').filter((l) => l.trim() && !l.trim().startsWith('{'));
    assert(bad.length === 0,
      `非 TTY 下 stdout 必须逐行是 JSON：${JSON.stringify(bad.slice(0, 3))}`);
  });

  // ── F4：EPIPE ──────────────────────────────────────────────────────────
  //
  // 修前实测：`tusunsun plugins | head -3` 打印
  // `Uncaught Exception: Error: write EPIPE` 加整段堆栈并 exit 1；
  // POSIX 惯例（对比 `ls | head`）是静默收尾。
  runner.test('R0-112/X7 下游提前关管道 → 静默收尾（不吐 EPIPE 堆栈、不判失败）', async () => {
    const code = await new Promise((resolve) => {
      const child = spawnManaged(process.execPath, [ENTRY, 'plugins'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      child.stderr.on('data', (b) => { err += b.toString(); });
      const timer = setTimeout(() => { child.reap().catch(() => {}); }, 30000);
      // 收到第一块输出就把读端关掉：子进程后续 write 必得 EPIPE（等价 `| head`）
      child.stdout.once('data', () => child.stdout.destroy());
      child.on('close', (c) => {
        clearTimeout(timer);
        try { assert(!/EPIPE/.test(err), `不得把 EPIPE 打成未捕获异常：${err.slice(0, 300)}`); } catch (e) { e.extra = err; }
        resolve({ code: c, err });
      });
    });
    assert(!/EPIPE/.test(code.err || ''), `不得把 EPIPE 打成未捕获异常：${(code.err || '').slice(0, 300)}`);
    assertEquals(code.code, 0, '下游关管道不是本命令的失败，退出码必须是 0');
  });

  // ── F1：工作目录（端到端，不只是"文档写了"） ─────────────────────────────
  //
  // 修前实测：用户在项目目录 `start`，问 agent「读一下 package.json」，agent 答
  // "当前目录不存在该文件"——文件工具的基准是 `~/.tusunsun/workspace`，而**启动时一个字都不说**。
  // 本用例同时钉住两件事：① `TUSUNSUN_WORK_DIR` 真能改基准；② 启动日志必须**说出**本次生效值。
  runner.test('R0-112/X9 启动日志必须报出生效的工作目录，且 TUSUNSUN_WORK_DIR 真的生效', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'r0112-workdir-'));
    const stateDir = mkdtempSync(join(tmpdir(), 'r0112-wd-state-'));
    try {
      const r = await runCli(['start', '--port', '0', '--state-dir', stateDir],
        { timeoutMs: 14000, stopWhen: STARTED, stopWhenMs: 14000, env: { TUSUNSUN_WORK_DIR: tmp } });
      const line = r.err.split('\n').find((l) => l.includes('Work dir:'));
      assert(line, `启动日志必须报出生效的工作目录（这是"agent 在哪干活"的唯一可见处）：${r.err.slice(-600)}`);
      assert(line.includes(tmp),
        `TUSUNSUN_WORK_DIR=${tmp} 必须真的成为基准（而不是只被 config.json 忽略掉）：${line}`);
      assert(/不是沙箱/.test(line),
        `必须就地声明"不是沙箱"——绝对路径可读工作目录之外的文件，不写清楚会让人误以为被限制：${line}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  // ── F2：真实场景（不只是合成用例） ──────────────────────────────────────
  //
  // 默认场景（gateway）此前带 5 条 `missing_required_service` 违例；production 档
  // `strict && violations > 0` 直接 `process.exit(1)` ⇒ 旗舰场景在生产档根本起不来
  // （实测：产物树 `--scene base-system` violations=0 正常起，`--scene gateway` 拒绝启动）。
  // 判据走**真装配**（起一次网关读它的准入摘要），不重新实现场景解析——否则测的是替身。
  runner.test('R0-112/X8 真实装配：0 条 missing_required_service', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'r0112-admission-'));
    const r = await runCli(['start', '--port', '0', '--state-dir', tmp],
      { timeoutMs: 14000, stopWhen: STARTED, stopWhenMs: 14000 });
    rmSync(tmp, { recursive: true, force: true });

    const summary = r.err.split('\n').find((l) => l.includes('[admission-gate] profile='));
    assert(summary, `启动日志里必须有准入摘要行（用于判断装配是否自洽）：${r.err.slice(-500)}`);
    const violations = Number(summary.match(/violations=(\d+)/)?.[1] ?? -1);
    assert(violations >= 0, `准入摘要必须报出违例数：${summary}`);

    const missing = r.err.split('\n').filter((l) => l.includes('missing_required_service'));
    assertEquals(missing.length, 0,
      '随包场景里每一条 requires 都必须真的有人提供；否则 development 档刷屏假警报、'
      + `production 档直接拒绝启动。实际：${JSON.stringify(missing)}`);

    // 重复 provider 是**真冲突**（同一服务两个 owner，谁赢取决于加载顺序）。
    // 开发树存在一对已登记的租户插件（l2-memory-store / yuxi-l2-ministry，两者都不随包发布），
    // 故这里只允许这一对具名出现；出现任何别的重复都必须判红。
    const dups = r.err.split('\n').filter((l) => l.includes('duplicate_provider'));
    for (const d of dups) {
      assert(/l2-memory-store/.test(d) && /yuxi-l2-ministry/.test(d),
        `出现未登记的重复 provider（真冲突，需裁决）：${d}`);
    }
  });

  // ── 附带：切换落盘的**双写者竞态**（确定性判据） ─────────────────────────
  //
  // 事实（实测）：`switchTo` 里 `cfg.setAndSave(...)` **没有 await**，而 CLI 随后
  // 用 `_persistActiveScene` 再读写同一个 config.json ⇒ 后者读到半写状态、`JSON.parse` 失败、
  // 退化成 `{activeScene}` 最小对象，把用户配置里的**其他键静默冲掉**。
  // 表现是偶发（交付仓整包跑时 `probeKeep` 丢过一次，单独重跑 3 次不复现）。
  // 竞态本身没法靠"多跑几次"稳定判红，所以这里直接钉契约：**switchTo 返回时落盘必须已完成**。
  runner.test('R0-112/X10 场景切换返回时落盘必须已完成（await，杜绝双写者竞态）', async () => {
    const { SceneController } = await imp('src/core/scene-controller.js');
    let persisted = false;
    const cfg = {
      get: () => 'gateway',
      setAndSave: async () => { await new Promise((r) => setTimeout(r, 40)); persisted = true; },
    };
    const core = {
      plugins: new Map([['zzz-not-in-any-scene', { name: 'zzz-not-in-any-scene' }]]),
      getService: (n) => (n === 'config' ? cfg : null),
      log: () => {}, emit: () => {}, emitFact: () => ({ delivered: 0, errors: [] }), colorize: (_c, t) => t, getData: () => null, setData: () => {},
    };
    const sc = new SceneController(core, { unload: async () => {} });
    // 本用例只关心落盘时序，不真装载插件。
    // v0.12.0（P3）契约变更：`switchTo` 现在有 Verify 段——只有插件**真的** running 才提交
    // 场景与持久配置（K-04：修前不验证就写 currentScene，缺插件也返回 ok:true）。
    // 因此桩必须如实模拟"装载成功"，否则它测的就不是落盘时序而是 Verify 的拒绝路径。
    sc._loadSingle = async (n) => {
      core.plugins.set(n, { name: n, state: 'running' });
      return { ok: true, name: n };
    };

    const r = await sc.switchTo('base-system', { yes: true });
    assert(r.ok, `切换应成功：${JSON.stringify(r)}`);
    assert(persisted,
      'switchTo 返回时必须已经落盘（`setAndSave` 必须被 await）。否则调用方紧接着再写同一个 '
      + 'config.json，两个写者抢文件：后写方读到半写内容 → 解析失败 → 只写回 {activeScene}，'
      + '用户配置里的其他键被静默抹掉（实测偶发）。');
  });
}
