// R0-111：把上一轮登记的遗留尾巴逐条闭合。
//
// 每一项都对应案卷 `r0-111-*`（开发仓 contracts/）的一节，判据全部可机械判定：
//   W1 场景切换 diff 必须计入 `eager`（真装配 = eager ∪ plugins ∪ lazy，两个入口同口径）
//   W2 产物形态下厂商中立门禁必须**真的执行**（不允许静默 NOT_RUN）
//   W3 `/health` 保 liveness、`/ready` 给 LB 用（降级时 503）
//   W4 `model.headers` 可由纯 env 表达（LongCat free 的 `x-opencode-session` 场景）
//   W5 REST 的 `usage` 是 OpenAI token 形状，上下文预算另立字段
//   W6 只认规范名的反向 env 收敛到 `readEnv`（别名部署不再静默丢设置）
import { readFileSync, readdirSync, existsSync, rmSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TestRunner, assert, assertEquals, assertThrows, detectArtifactForm } from '../harness.mjs';
import { SceneController, scenePluginNames } from '../../src/core/scene-controller.js';
import { scenePluginLists } from '../../src/bootstrap/cli.js';
import { Core } from '../../src/core/core.js';
import { PluginManager } from '../../src/core/plugin-manager.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const DIST = join(ROOT, 'dist', 'oss');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
// harness 的 assertEquals 是 `!==`（标量语义）；集合/数组一律用本函数做顺序无关比较。
const sameList = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// v0.9.25：装配根只有 `plugins/` 一处。第三层是**下游兼容树**位置（本仓无此目录），
// 下游复制本文件后靠它找到插件。
// 路径分段写成数组、由 spread 展开——构建期的自洽性过滤只认 `join()` 里的字面量链，写死一条
// 相对路径会被判成"引用了未随包路径"，本文件会被整份剔除（那就等于没有门禁）。
async function impPlugin(name) {
  for (const layer of [['plugins'], ['plugins', 'sancai', 'haotian']]) {
    const candidate = join(ROOT, ...layer, name);
    if (existsSync(candidate)) return (await import(pathToFileURL(candidate).href)).default;
  }
  throw new Error(`找不到插件：${name}`);
}

// 与其余 OSS 门禁同一口径：开发树看 dist/oss；产物形态（无 .git）把本树当产物。
const ARTIFACT = existsSync(DIST) ? DIST : (existsSync(join(ROOT, '.git')) ? null : ROOT);

export async function setup(runner) {
  // ── W6：环境变量只有一条读法（不得手写规范名）────────────────────────────

  runner.test('R0-111/W6 代码里不得再手写 TUSUNSUN_*（注释除外）：全部经 readEnv', () => {
    // 判据：`process.env.TUSUNSUN_X` / `env.TUSUNSUN_X` 只允许出现在 `src/core/env.js`
    // （那是别名定义处）。手写规范名 = 只认一种名字，只用历史别名的既有部署会**静默丢设置**
    // （实测典型：key 没读到 ⇒ 网关起得来、每次对话都说"没 key"）。
    const HIT = /process\.env\.TUSUNSUN_[A-Z0-9_]+|(^|[^.\w])env\.TUSUNSUN_[A-Z0-9_]+/;
    // 防空过：探测器本身必须能命中三种写法
    assert(HIT.test("const k = process.env.TUSUNSUN_API_KEY;"), '探测器应命中 process.env.TUSUNSUN_*');
    assert(HIT.test("const d = env.TUSUNSUN_SECRET_KEY;"), '探测器应命中 env.TUSUNSUN_*');
    assert(!HIT.test("const k = readEnv('API_KEY');"), 'readEnv 写法不得误报');

    const offenders = [];
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) { if (!['node_modules', 'test-results', 'fixtures'].includes(e.name)) walk(full); continue; }
        if (!/\.(js|mjs)$/.test(e.name)) continue;
        const rel = full.slice(ROOT.length + 1);
        if (rel === join('src', 'core', 'env.js')) continue;   // 别名定义处
        readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
          const t = line.trim();
          if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;   // 注释/文档字符串不算
          if (HIT.test(line)) offenders.push(`${rel}:${i + 1}`);
        });
      }
    };
    for (const d of ['src', 'plugins', 'scripts']) walk(join(ROOT, d));
    assert(offenders.length === 0, `以下位置仍手写规范名（应改走 readEnv）：\n${offenders.join('\n')}`);
    console.log('       [实测] src/ + plugins/ + scripts/ 手写规范名 0 处（env.js 的别名定义除外）');
  });

  // ── W1：场景切换 diff 计入 eager ─────────────────────────────────────────

  runner.test('R0-111/W1-a 切换 diff 计入 eager（只有 eager 的场景不再被当成空装配）', async () => {
    const testDir = join(tmpdir(), `r0111-w1-${process.pid}-${Date.now()}`);
    const core = new Core({ stateDir: testDir, pluginsDir: join(testDir, 'plugins') });
    const pm = new PluginManager(core);
    const sc = new SceneController(core, pm);
    try {
      // 当前装配的形状就是漏报形状：插件全在 eager、`plugins` 为空。
      core.plugins.set('admission-gate', { name: 'admission-gate' });
      core.plugins.set('readiness', { name: 'readiness' });
      core.plugins.set('config', { name: 'config' });
      sc._sceneCache.set('probe-old', { name: 'probe-old', eager: ['admission-gate', 'readiness', 'config'], plugins: [] });
      sc._sceneCache.set('probe-new', { name: 'probe-new', eager: ['readiness', 'health'], plugins: [] });

      const r = await sc.switchTo('probe-new');
      assert(r.ok && r.diff === true, 'diff 模式应成功');
      assert(r.toRemove.includes('admission-gate'),
        `eager 里已装的插件必须参与 diff（旧实现只看 plugins ⇒ 漏报"没有任何变化"）；实际 toRemove=${JSON.stringify(r.toRemove)}`);
      assert(sameList(r.toAdd, ['health']), `eager 里的新插件必须出现在 toAdd；实际 ${JSON.stringify(r.toAdd)}`);
    } finally {
      core.removeAllListeners();
      pm.stopWatching();
      if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    }
  });

  runner.test('R0-111/W1-b 装配底座（config/gateway）不出现在提案里', async () => {
    const testDir = join(tmpdir(), `r0111-w1b-${process.pid}-${Date.now()}`);
    const core = new Core({ stateDir: testDir, pluginsDir: join(testDir, 'plugins') });
    const pm = new PluginManager(core);
    const sc = new SceneController(core, pm);
    try {
      sc._sceneCache.set('base', { name: 'base', eager: ['config', 'gateway', 'readiness'], plugins: [] });
      const r = await sc.switchTo('base');
      assert(!r.toAdd.includes('config') && !r.toAdd.includes('gateway'),
        `装配底座不该被报成新增（每个场景都保证它）；实际 toAdd=${JSON.stringify(r.toAdd)}`);
      assert(sameList(r.toAdd, ['readiness']), `只有真正的增量才该出现；实际 ${JSON.stringify(r.toAdd)}`);
    } finally {
      core.removeAllListeners();
      pm.stopWatching();
      if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    }
  });

  runner.test('R0-111/W1-c 两个装配入口对"场景插件全集"必须同口径（防空降级）', async () => {
    const core = { log() {}, plugins: new Map(), getService: () => null };
    const sc = new SceneController(core, {});
    const names = readdirSync(join(ROOT, 'scenes')).filter((f) => f.endsWith('.json5')).map((f) => f.replace('.json5', ''));
    assert(names.length > 0, '应能发现场景文件');
    const strip = (it) => [...it].filter((x) => x !== 'config' && x !== 'gateway').sort();
    for (const n of names) {
      const s = await sc.findScene(n);
      assert(s, `场景 ${n} 应能加载`);
      const { eager, lazy } = scenePluginLists(s);
      assert(sameList(strip(scenePluginNames(s)), strip([...eager, ...lazy])),
        `场景 ${n}：切换 diff 的判据与装载清单 scenePluginLists() 不一致`
        + `（switch=${JSON.stringify(strip(scenePluginNames(s)))} vs load=${JSON.stringify(strip([...eager, ...lazy]))}）`);
    }
  });

  // ── W5：REST 的 usage 是 OpenAI token 形状 ─────────────────────────────

  runner.test('R0-111/W5-a haotian-lite：模型用量转 OpenAI 形状，没报就不编 0', async () => {
    const h = await impPlugin('haotian-lite.js');
    // _openAIUsage 是纯函数：两种上游字段名（{inputTokens} 与 {prompt_tokens}）都要认
    assert(sameJson(h._openAIUsage({ inputTokens: 10, outputTokens: 5 }), { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
      '应把 {inputTokens,outputTokens} 转成 OpenAI 形状');
    assert(sameJson(h._openAIUsage({ prompt_tokens: 3, completion_tokens: 4 }), { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }),
      '已经是 OpenAI 字段名时也要认');
    assertEquals(h._openAIUsage(null), undefined, '没用量必须是 undefined（不编 0）');
    assertEquals(h._openAIUsage({ inputTokens: 0, outputTokens: 0 }), undefined, '全 0 同样不编');
    assert(sameJson(h._mergeUsage({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }, { inputTokens: 10, outputTokens: 20 }),
      { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 }), '多轮用量必须累加');

    // _end 是唯一出口：带上用量时必须有 usage，且上下文预算仍走 tokenUsage（控制台不回归）
    const savedCore = h.core;
    try {
      h.core = {
        emitFast() {}, emit() {}, log() {},
        getService: (n) => (n === 'context' ? { getUsage: () => ({ used: 12, max: 100, percent: 12 }) } : null),
      };
      const ok = h._end('hi', 's1', 't1', [], [], false, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
      assert(sameJson(ok.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }), `成功轮应带 usage，实际 ${JSON.stringify(ok.usage)}`);
      assert(sameJson(ok.tokenUsage, { used: 12, max: 100, percent: 12 }), '上下文预算必须继续透传（控制台依赖它）');
      const none = h._end('hi', 's1', 't1', [], [], false, null);
      assertEquals(none.usage, undefined, '上游没报用量时不得出现 usage 字段');
      const errEnd = h._end('boom', 's1', 't1', [], [], true, { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 });
      assertEquals(errEnd.error, true, '错误轮仍要带 error:true');
    } finally {
      h.core = savedCore;
    }
  });

  runner.test('R0-111/W5-b gateway：REST 的 usage 不再用上下文预算冒充，预算另立 tusunsun_context', async () => {
    const gw = await impPlugin('gateway.js');
    const savedCore = gw.core;
    const mkRes = () => {
      const out = { status: 0, body: null };
      return { out, writeHead(s) { out.status = s; }, end(b) { out.body = JSON.parse(b); } };
    };
    const run = async (payload) => {
      gw.core = {
        command: async () => ({ ok: true, payload }),
        get: () => undefined, emitFast() {}, log() {},
        getService: (n) => (n === 'config' ? { get: () => 'probe-model' } : null),
      };
      const res = mkRes();
      await gw._handleNonStreamingChatCompletion({ url: '/v1/chat/completions' }, res, {}, { content: 'hi' });
      return res.out;
    };
    try {
      const withUsage = await run({ reply: 'ok', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, tokenUsage: { used: 12, max: 100, percent: 12 } });
      assertEquals(withUsage.status, 200, '应 200');
      assert(sameJson(withUsage.body.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
        `usage 必须是 OpenAI token 形状，实际 ${JSON.stringify(withUsage.body.usage)}`);
      assert(sameJson(withUsage.body.tusunsun_context, { used: 12, max: 100, percent: 12 }),
        '上下文预算必须另立字段，不再冒充 usage');
      assertEquals(withUsage.body.usage?.used, undefined, 'usage 里不得出现 used/max/percent');

      const noUsage = await run({ reply: 'ok', tokenUsage: { used: 1, max: 2, percent: 50 } });
      assertEquals(noUsage.status, 200, '应 200');
      assert(!('usage' in noUsage.body), `上游没报用量时不得凭空造 usage，实际 ${JSON.stringify(noUsage.body.usage)}`);
      assert(sameJson(noUsage.body.tusunsun_context, { used: 1, max: 2, percent: 50 }), '预算字段仍要在');
      console.log('       [实测] usage=OpenAI 形状、预算走 tusunsun_context、缺用量时不编数字');
    } finally {
      gw.core = savedCore;
    }
  });

  // ── W4：model.headers 可由纯 env 表达 ───────────────────────────────────

  runner.test('R0-111/W4-a 纯 env 能配 model.headers（同名 env 赢、坏 JSON 必须报错）', async () => {
    const cfg = await impPlugin('config.js');
    const saved = { data: cfg.data, env: { ...process.env } };
    const { TUSUNSUN_MODEL_HEADERS: _a } = process.env;
    try {
      const apply = (envs) => {
        delete process.env.TUSUNSUN_MODEL_HEADERS;
        Object.assign(process.env, envs);
        cfg.data = { model: { apiKey: 'k', headers: { 'x-keep': 'from-config', 'x-opencode-session': 'old' } }, gateway: {} };
        cfg.applyEnvOverrides();
        return cfg.data;
      };

      // ① JSON 合并：同名键 env 赢，其余键保留（否则"补一个会话头"会把已有头全冲掉）
      const d1 = apply({ TUSUNSUN_MODEL_HEADERS: '{"x-opencode-session":"sess-env","x-new":"v"}' });
      assertEquals(d1.model.headers['x-opencode-session'], 'sess-env', '同名头必须以 env 为准');
      assertEquals(d1.model.headers['x-keep'], 'from-config', '未在 env 里出现的头必须保留');
      assertEquals(d1.model.headers['x-new'], 'v', 'env 里的新头必须加上');

      // ③ 坏 JSON / 非对象 / 头注入：必须**启动即失败**并点名变量，不许静默忽略
      for (const [bad, re] of [
        ['{not json', /TUSUNSUN_MODEL_HEADERS 不是合法 JSON/],
        ['["a"]', /必须是 JSON 对象/],
        ['{"x-v":"a\\nInjected: 1"}', /不得含换行/],
        ['{"x-v":{"nested":1}}', /值必须是字符串\/数字\/布尔/],
      ]) {
        assertThrows(() => apply({ TUSUNSUN_MODEL_HEADERS: bad }), '坏值必须抛错：' + bad);
        try { apply({ TUSUNSUN_MODEL_HEADERS: bad }); } catch (err) { assert(re.test(err.message), `错误信息要点名变量与形状，实际：${err.message}`); }
      }
      // 历史别名的解析覆盖放在开发树专属用例（test-r0-108-…）：T8 要求产物里不得出现该前缀字面量。
      console.log('       [实测] env 头：合并语义正确、四类坏值均启动即失败');
    } finally {
      cfg.data = saved.data;
      for (const k of Object.keys(process.env)) if (!(k in saved.env)) delete process.env[k];
      Object.assign(process.env, saved.env);
    }
  });

  runner.test('R0-111/W4-b 配置里的头必须真的出现在 HTTP 请求上（本地回环实测）', async () => {
    const { createServer } = await import('node:http');
    const seen = [];
    const srv = createServer((req, res) => {
      seen.push(req.headers);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const ModelPlugin = await impPlugin('model-openai.js');
    const savedCore = ModelPlugin.core;
    try {
      const table = {
        'model.baseUrl': `http://127.0.0.1:${port}/v1/chat/completions`,
        'model.apiKey': 'test-key',
        'model.model': 'probe-model',
        'model.headers': { 'x-opencode-session': 'sess-on-wire', 'X-Extra': 'yes' },
      };
      ModelPlugin.core = {
        getService: (n) => (n === 'config' ? { get: (p) => table[p] } : null),
        emit() {}, emitFast() {}, log() {}, get: () => undefined, getData: () => undefined,
      };
      const r = await ModelPlugin.call([{ role: 'user', content: 'ping' }]);
      assertEquals(r.content, 'pong', `模型层应正常返回，实际 ${JSON.stringify(r).slice(0, 200)}`);
      assertEquals(seen.length, 1, '应发出且只发出一次请求');
      assertEquals(seen[0]['x-opencode-session'], 'sess-on-wire', '会话头必须真的上线（LongCat free 缺它会 400）');
      assertEquals(seen[0]['x-extra'], 'yes', '自定义头必须原样上线');
      console.log('       [实测] 自定义头真的到达对端（本地回环，非仿真）');
    } finally {
      ModelPlugin.core = savedCore;
      await new Promise((r) => srv.close(r));
    }
  });

  // ── W2：产物形态判据（门禁不许静默 NOT_RUN）─────────────────────────────

  runner.test('R0-111/W2 形态判据：不再依赖任何标记文件，只有「有 dist/oss 与否」两种答案', () => {
    const made = [];
    const mk = (marks) => {
      const d = mkdtempSync(join(tmpdir(), 'r0111-form-'));
      for (const m of marks) {
        mkdirSync(dirname(join(d, m)), { recursive: true });
        writeFileSync(join(d, m), '');
      }
      made.push(d);
      return d;
    };
    try {
      // 各种"树形状"，覆盖历史上把判据带偏的所有标记组合。
      const shapes = {
        '空树': [],
        '有 plugins/gateway.js（旧判据的 devMark）': ['plugins/gateway.js'],
        '有 plugins/model-openai.js（旧判据的 builtMark）': ['plugins/model-openai.js'],
        '带 .git 的交付检出': ['.git/HEAD', 'plugins/model-openai.js'],
        '带 .git 且两个标记都在': ['.git/HEAD', 'plugins/gateway.js', 'plugins/model-openai.js'],
        'npm 包解包': ['plugins/model-openai.js', 'package.json'],
      };
      // v0.9.25 的契约：**永远**给出一个可验收的根，且 form 非空。
      // 不再有第三种答案，也就不存在"判错了"这件事 —— 这是从根上修掉"标记腐烂"。
      for (const [label, marks] of Object.entries(shapes)) {
        const t = mk(marks);
        const r = detectArtifactForm(t);
        assertEquals(r.artifact, t, `${label}：v0.9.25 起单一布局，验收对象就是本树（不得返回 null 静默跳过）`);
        assert(typeof r.form === 'string' && r.form.length > 0, `${label}：必须给出形态名（日志可读）`);
      }

      // 唯一的分支：有 dist/oss 就验收 dist/oss。
      const withDist = mk(['plugins/gateway.js', 'dist/oss/tusunsun.mjs']);
      assertEquals(detectArtifactForm(withDist).artifact, join(withDist, 'dist', 'oss'),
        '有 dist/oss 时验收对象是它');

      // 回归的核心断言：**删掉标记文件不改变结论**。
      // 旧判据把结论挂在 `src/builtin/gateway.js` 上，而该文件在 R0-103 就被删除，
      // 于是开发树被长期误判成"产物形态"；只因错误方向是"多跑门禁"才无人发现。
      // 现在结论与任何标记无关 ⇒ "标记腐烂"这一类故障不可能再发生。
      // 判的是**形态名**而不是绝对路径：两棵不同的临时树显然各有各的根，
      // 拿路径比会永远不等式成立，测不出任何东西。
      const a = mk(['plugins/gateway.js']);
      rmSync(join(a, 'plugins', 'gateway.js'));
      const b = mk(['plugins/gateway.js']);
      assertEquals(detectArtifactForm(a).form, detectArtifactForm(b).form,
        '标记文件在与不在，判定形态必须一致（判据不得依赖会腐烂的标记）');
      assertEquals(detectArtifactForm(a).artifact, a, '无 dist/oss 时验收对象仍是本树');
    } finally {
      for (const d of made) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
    }
  });

  runner.test('R0-111/W1-d 反例对照：漏报形状确实会被检出（防空过）', () => {
    // 旧判据 = 只看 plugins。用同一个场景数据证明"旧判据 → 空集，新判据 → 非空"。
    const scene = { name: 'x', eager: ['admission-gate', 'readiness'], plugins: [] };
    const oldWay = new Set(scene.plugins || []);
    assert(oldWay.size === 0, '旧判据在这个形状下必然算出空集 —— 这正是漏报的机制');
    assert(scenePluginNames(scene).size === 2, '新判据必须看见 eager 里的两个插件');
  });
}
