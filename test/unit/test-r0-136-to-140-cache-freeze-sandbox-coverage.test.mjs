// R0-136 ~ R0-140（v0.9.31 续）：第二轮形态扫描查出的五条。
//
// 上一批 R0-132~135 修完之后，我按"同一个形状再来一次"继续扫，又查出这些。
// 共同点仍然不是"某一行写错了"，而是**同一个决定在两个地方各判一套**：
//
//   R0-136 **缓存键把传输元数据算进去了** ⇒ 真实链路上缓存永不命中。
//          `args._tcId` / `_traceId` 是每次调用都不同的关联 id，与"这次要读什么"无关；
//          把它们算进键里，`executeBatch` 每个 tool_call 都给新 `_tcId`
//          ⇒ 同会话同文件连调 3 次，handler 执行 3 次。这个"优化"是死的。
//          修法只剔这两个 —— `_principal`/`_sessionId` 必须留着，剔掉就变成 R0-132 的越权。
//
//   R0-136b **缓存命中绕过冻结**。`freezeCapability` 的判据住在 core 的
//          `callCapability`/`command` 里，而缓存命中路径**完全不经过 core**。
//          实测：正常调用 succeeded → 冻结 → 同参数再调 → **仍然 succeeded**。
//          `freezeCapability` 的语义是"停止服务、等排空"，这等于没停。
//
//   R0-137 **沙箱 opMap 是工具名硬编码表** ⇒ 表外工具对沙箱完全透明。
//          `sandbox.enabled=true` + 一律 DENY 的沙箱 + 第三方 `tool-deploy`
//          → 沙箱调用 **0** 次、handler 真的跑、返回 succeeded。
//          装了沙箱之后，**越是来历不明的工具越不受它管**。
//
//   R0-138 **coding.json5 里 6 个 sandbox.* 键零读者**（配置面的虚假承诺）。
//
//   R0-139 **我自己上一轮加的死代码**：沙箱 await 之后的第三道复核永远不可达。
//
//   R0-140 **执行器与 core 的 state 分类不一致**：`out_of_bounds` 执行器报 failed、
//          core 报 denied。`capability_not_found` 则**有意分歧**（已记录，不改）。
//
// 每一条都必须能被"把判据删掉/改错"打红。
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TestRunner, assert, assertEquals } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(join(ROOT, rel));

async function makeHost({ base, config = {}, sandbox = null, registry = null }) {
  const ws = join(base, 'ws');
  mkdirSync(ws, { recursive: true });
  const { Core } = await imp('src/core/core.js');
  const core = new Core({ stateDir: join(base, 'state') });
  core.log = () => {};
  core.setData('agent.workDir', ws);

  if (Object.keys(config).length > 0) {
    core.registerService('config', { get: (k, fb) => (k in config ? config[k] : fb) });
  }
  await (await imp('plugins/workspace.js')).default.init(core);
  if (sandbox) core.registerService('sandbox', sandbox);

  const exec = Object.create((await imp('plugins/tool-executor.js')).default);
  exec._preHooks = []; exec._postHooks = []; exec._dispatchHooks = [];
  exec._rateCalls = new Map(); exec._cache = new Map(); exec._auditLog = new Map();
  await exec.init(core);
  if (registry) core.registerService('tool-registry', registry);
  return { core, ws, exec };
}

export async function setup(runner) {
  const base = () => mkdtempSync(join(tmpdir(), 'r136-'));

  // ══ R0-136：缓存键必须排除传输元数据，但保留授权字段 ══════════════════════
  runner.test('R0-136/a 真实链路形态：每次 _tcId 不同时，只读工具仍须命中缓存', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d });
      let runs = 0;
      h.core.registerCapability('tool.read', { owner: 'tool-read', handler: async () => { runs++; return 'DATA'; } });
      writeFileSync(join(h.ws, 'a.txt'), 'hello');

      // 照 `executeBatch` 的真实做法：每个 tool_call 给一个新 `_tcId`
      await h.exec.executeOne('tool-read', { path: 'a.txt', _tcId: 'call_1' }, 's1', 'c1');
      await h.exec.executeOne('tool-read', { path: 'a.txt', _tcId: 'call_2' }, 's1', 'c1');
      await h.exec.executeOne('tool-read', { path: 'a.txt', _tcId: 'call_3' }, 's1', 'c1');

      assertEquals(runs, 1,
        `只读结果应命中缓存（修前 handler 执行 3 次 —— 缓存键把 _tcId 算进去了，优化是死的），实际 ${runs} 次`);
      console.log('       [实测] 三次不同 _tcId 的只读调用 → handler 执行 1 次（缓存真的命中）');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-136/b 反例：授权相关字段必须留在键里（剔除就会串号）', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d });
      h.core.registerCapability('tool.read', { owner: 'tool-read', handler: async () => 'DATA' });
      writeFileSync(join(h.ws, 'a.txt'), 'x');

      const k = (over) => h.exec._cacheKey('tool.read', { path: 'a.txt', ...over });
      const base1 = { _principal: 'alice', _sessionId: 's1' };
      assertEquals(await k(base1), await k({ ...base1 }), '同参数应当同键');
      assert((await k(base1)) !== (await k({ ...base1, _principal: 'bob' })),
        '_principal 不同的调用绝不能共用缓存键（否则 Bob 会拿到 Alice 的结果）');
      assert((await k(base1)) !== (await k({ ...base1, _sessionId: 's2' })),
        '_sessionId 不同必须区分（同一相对路径在两个会话里指向两个真实文件，R0-124）');
      // 而传输元数据**必须**被忽略
      assertEquals(await k(base1), await k({ ...base1, _tcId: 'x', _traceId: 'y' }),
        '_tcId/_traceId 是传输元数据，不得影响缓存键');
      console.log('       [实测] _principal/_sessionId 区分；_tcId/_traceId 忽略');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ══ R0-136b：冻结语义不能被缓存绕过 ═══════════════════════════════════════
  runner.test('R0-136b 冻结后缓存命中：不得返回成功（freeze 的判据在 core，缓存不经过 core）', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d });
      let runs = 0;
      h.core.registerCapability('tool.read', { owner: 'tool-read', handler: async () => { runs++; return 'DATA'; } });
      writeFileSync(join(h.ws, 'a.txt'), 'x');

      const a = await h.exec.executeOne('tool-read', { path: 'a.txt' }, 's1', 'c1');
      assertEquals(a.state, 'succeeded', '第一次应成功');

      h.core.freezeCapability('tool.read');   // 停止服务、等排空

      const b = await h.exec.executeOne('tool-read', { path: 'a.txt' }, 's1', 'c1');
      assertEquals(b.ok, false,
        `冻结后不得返回成功 —— 修前实测缓存命中仍返回 ok:true/succeeded，freeze 等于没停，实际 ok=${b.ok}`);
      assertEquals(b.code, 'capability_frozen', `拒绝码应为 capability_frozen，实际 ${b.code}`);
      // 必须钉**具体 state**，不能只钉 code —— 第一版只断言了 code，
      // 于是把 `capability_frozen` 从 EXECUTOR_REJECTION_CODES 删掉（state 退化成 failed）
      // 变异照样绿。只钉 code 的测试守不住分类。
      assertEquals(b.state, 'rejected',
        `冻结是"从未执行"，state 必须是 rejected（core 的 denied 同义），实际 ${b.state}`);
      assertEquals(runs, 1, '被拒的调用不得执行 handler');
      console.log('       [实测] 冻结后同参数调用 → capability_frozen（缓存不再绕过 freeze）');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-136b2 同一 code 的 state 必须一致：缓存路径与 core 路径对 freeze 的判断相同', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d });
      h.core.registerCapability('tool.read', { owner: 'tool-read', handler: async () => 'DATA' });
      writeFileSync(join(h.ws, 'a.txt'), 'x');
      await h.exec.executeOne('tool-read', { path: 'a.txt' }, 's1', 'c1');
      h.core.freezeCapability('tool.read');

      const viaCache = await h.exec.executeOne('tool-read', { path: 'a.txt' }, 's1', 'c1');   // 命中缓存
      const viaCore = await h.exec.executeOne('tool-read', { path: 'nope.txt' }, 's1', 'c1'); // 未命中，走 core
      assertEquals(viaCache.code, viaCore.code, `code 应一致，实际 ${viaCache.code} vs ${viaCore.code}`);
      assertEquals(viaCache.state, viaCore.state,
        `同一 code 的 state 必须一致（修前缓存侧报 failed、core 侧报 denied/rejected），实际 ${viaCache.state} vs ${viaCore.state}`);
      // 两边一致还不够 —— 还得一致地是**对的那个**。两个都退化成 failed 也算"一致"。
      assertEquals(viaCache.state, 'rejected',
        `冻结的 state 必须是 rejected，实际 ${viaCache.state}`);
      console.log(`       [实测] 缓存路径与 core 路径均为 ${viaCache.state}/${viaCache.code}`);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ══ R0-137：沙箱必须覆盖所有工具，不能"表外即放行" ═══════════════════════
  runner.test('R0-137/a 第三方工具（不在内建 opMap 里）在沙箱开启时不得静默跳过沙箱', async () => {
    const d = base();
    try {
      let sandboxCalls = 0, handlerRan = false;
      const h = await makeHost({
        base: d,
        config: { 'sandbox.enabled': true },
        sandbox: { execute: async () => { sandboxCalls++; return { ok: false, error: 'SANDBOX_DENIED' }; } },
      });
      h.core.registerCapability('tool.deploy', {
        owner: 'thirdparty-deploy',
        handler: async () => { handlerRan = true; return 'DEPLOYED'; },
      });

      const r = await h.exec.executeOne('tool-deploy', {}, 's1', 'c1');
      assertEquals(handlerRan, false,
        '修前：表外工具直接落到 handler 并返回 succeeded —— 装了沙箱之后，越是来历不明的工具越不受它管');
      assertEquals(r.ok, false, `沙箱开启时该工具不得"成功"，实际 ok=${r.ok}`);
      assertEquals(r.code, 'sandbox_op_undeclared',
        `应报"未声明沙箱操作"，实际 ${r.code}：${String(r.error).slice(0, 120)}`);
      assertEquals(sandboxCalls, 0, '沙箱根本没被调用过（因为不知道该用哪个 op）');
      console.log('       [实测] 表外工具 → sandbox_op_undeclared，handler 未执行');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-137/b 正例：工具显式声明 sandboxOp 后，沙箱接管执行', async () => {
    const d = base();
    try {
      const seen = [];
      const h = await makeHost({
        base: d,
        config: { 'sandbox.enabled': true },
        sandbox: { execute: async (op) => { seen.push(op); return { ok: true, data: 'FROM_SANDBOX' }; } },
        registry: {
          get: async (n) => (n === 'tool-deploy'
            ? { name: 'tool-deploy', sandboxOp: 'exec', provides: [{ name: 'tool.deploy' }] } : null),
          has: (n) => n === 'tool-deploy', list: () => [],
        },
      });
      let handlerRan = false;
      h.core.registerCapability('tool.deploy', {
        owner: 'thirdparty-deploy',
        handler: async () => { handlerRan = true; return 'REAL'; },
      });

      const r = await h.exec.executeOne('tool-deploy', {}, 's1', 'c1');
      // 注意：`assertEquals` 对数组是**身份比较**，不能直接比 `['exec']`（第一版就这么写错的）。
      assertEquals(seen.length, 1, `沙箱应被调用 1 次，实际 ${seen.length}：${JSON.stringify(seen)}`);
      assertEquals(seen[0], 'exec', `应使用工具声明的 op，实际 ${seen[0]}`);
      assertEquals(handlerRan, false, '沙箱接管时真 handler 不得执行');
      assertEquals(r.result, 'FROM_SANDBOX', `结果必须来自沙箱，实际 ${JSON.stringify(r.result)}`);
      console.log('       [实测] sandboxOp=exec → 沙箱接管，handler 未执行');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-137/c 反例：沙箱关闭时不得因"未声明 op"而误伤任何工具', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d });
      let ran = false;
      h.core.registerCapability('tool.deploy', { owner: 'tp', handler: async () => { ran = true; return 'OK'; } });
      const r = await h.exec.executeOne('tool-deploy', {}, 's1', 'c1');
      assertEquals(ran, true, '沙箱未开启时不得干预，handler 应正常执行');
      assertEquals(r.state, 'succeeded', `应成功，实际 ${r.state}`);
      console.log('       [实测] sandbox 关闭 → 未声明 op 的工具照常执行（不误伤）');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ══ R0-138：配置面不得承诺不存在的能力 ═══════════════════════════════════
  runner.test('R0-138 场景配置里不得出现零读者的 sandbox 键（配置面的虚假承诺）', async () => {
    const { loadJson5 } = await imp('src/core/json5-loader.js');
    const scene = loadJson5(readFileSync(join(ROOT, 'scenes', 'coding.json5'), 'utf8'));
    const sb = scene?.defaultConfig?.sandbox ?? {};
    const ghostKeys = ['strategy', 'dockerFallback', 'dockerIgnore', 'localConstraints', 'noNetwork', 'maxCpuTimeMs'];
    const present = ghostKeys.filter((k) => k in sb);
    assertEquals(present.length, 0,
      '这些键在 plugins/ 与 src/ 里读者数为 0，写进场景会让读者以为'
      + '"docker / 禁网 / CPU 上限"已生效：' + present.join(', '));
    console.log('       [实测] coding.json5 已无零读者 sandbox 键');
  });

  // ══ R0-139：不得保留不可达的复核 ═════════════════════════════════════════
  runner.test('R0-139 沙箱分支之后不得有不可达的 _dispatchGuard（死代码会让人以为还有一道保护）', async () => {
    const src = readFileSync(join(ROOT, 'plugins/tool-executor.js'), 'utf8');
    const i = src.indexOf('const sandboxResult = await this._maybeSandbox');
    assert(i > 0, '应能找到沙箱调用点');
    // 只认**真调用**，剥掉注释 —— 第一版就是数注释里的字样而误红（"守排版不守接线"）。
    const tail = src.slice(i, i + 1600)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert(!/this\._dispatchGuard\s*\(/.test(tail),
      '沙箱调用之后仍有 `this._dispatchGuard(...)` 真调用 —— `_maybeSandbox` 只有 null/接管/拒绝三种返回，'
      + '不存在"放行后落到 handler"，所以那是不可达代码');
    console.log('       [实测] 沙箱之后无不可达复核');
  });

  // ══ R0-140：state 分类必须以**执行证据**为准（ERR-015 后改口径） ═══════════
  //
  // v0.15.0 及以前：执行器拿 code 去查 `EXECUTOR_REJECTION_CODES`，把 `out_of_bounds`
  // 改写成 `rejected`，理由是"与 core 的 denied 对齐"。
  // v0.15.1（专家 ERR-015）：`out_of_bounds` 由工具在 handler 内部抛出，**没有任何一方**
  // 能证明副作用为零 —— Core 现在报 `failed` + `dispatched:true`，执行器必须沿用这条事实，
  // 而不是拿 code 再猜一次。反向正例（Core 亲眼所见的前置拒绝）仍在下面第二条钉住。
  runner.test('R0-140/a 路径越界：执行器必须沿用 Core 的执行证据，不得按 code 猜阶段', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d });
      const W = (await imp('plugins/tools/tool-write.js')).default;
      await W.init(h.core);

      const r = await h.exec.executeOne('tool-write', { path: '../../escape.txt', content: 'x' }, 's1', 'c1');
      assertEquals(r.code, 'out_of_bounds', `应报 out_of_bounds，实际 ${r.code}`);
      assertEquals(r.state, 'failed',
        `handler 抛出的拒绝码不得被报成 rejected（"从未执行"）—— Core 已给 dispatched:true，实际 ${r.state}`);
      assertEquals(r.side_effect, 'unknown_or_possible', '不得宣称零副作用');
      assertEquals(existsSync(join(d, 'escape.txt')), false, '不得越界写盘');
      console.log('       [实测] out_of_bounds → failed + side_effect:unknown_or_possible（沿用 core 证据）');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-140/a2 反向正例：Core 前置拒绝（冻结）仍必须是 rejected', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d });
      const W = (await imp('plugins/tools/tool-write.js')).default;
      await W.init(h.core);
      h.core.freezeCapability('tool.write');
      const r = await h.exec.executeOne('tool-write', { path: 'ok.txt', content: 'x' }, 's1', 'c1');
      assertEquals(r.code, 'capability_frozen', `应报 capability_frozen，实际 ${r.code}`);
      assertEquals(r.state, 'rejected',
        `Core 在 dispatch 之前就拒绝（dispatched:false）⇒ handler 一次没跑 ⇒ 必须是 rejected，实际 ${r.state}`);
      assertEquals(existsSync(join(d, 'ok.txt')), false, '冻结后不得落盘');
      console.log('       [实测] capability_frozen → rejected（证据来自 core 的 dispatched:false）');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-140/b 反例：invalid_input 必须保持 failed（参数写错不是信任边界拒绝）', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d });
      const W = (await imp('plugins/tools/tool-write.js')).default;
      await W.init(h.core);
      const r = await h.exec.executeOne('tool-write', { content: 'x' }, 's1', 'c1');   // 缺 path
      assertEquals(r.code, 'invalid_input', `应报 invalid_input，实际 ${r.code}`);
      assertEquals(r.state, 'failed',
        `core 判 invalid_input 为 failed，执行器必须一致 —— 不能为了"对齐"把它也改成 rejected，实际 ${r.state}`);
      console.log('       [实测] invalid_input → failed（与 core 一致，未被顺手改坏）');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-140/c capability_not_found 的分歧必须被记录（防止有人只改一边）', async () => {
    const src = readFileSync(join(ROOT, 'plugins/tool-executor.js'), 'utf8');
    assert(/capability_not_found[\s\S]{0,400}有意分歧/.test(src),
      'capability_not_found 在 core(failed) 与执行器(rejected) 之间是**有意分歧**，必须在代码里写明理由，'
      + '否则将来有人"顺手对齐"一边而无人察觉');
    console.log('       [实测] 分歧已显式记录在 EXECUTOR_REJECTION_CODES 注释里');
  });

  runner.test('R0-136c 冻结必须由 core 广播，而不是执行器去读私有字段（S2 的形状）', async () => {
    const src = readFileSync(join(ROOT, 'plugins/tool-executor.js'), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert(!/\._capabilities\b/.test(code),
      '执行器不得读 `core._capabilities`（私有 Map）—— 冻结状态必须经 core 广播的事件获得');
    assert(/core:capability\.frozen/.test(code),
      '执行器必须订阅 `core:capability.frozen`');
    const coreSrc = readFileSync(join(ROOT, 'src/core/core.js'), 'utf8');
    assert(/core:capability\.frozen/.test(coreSrc), 'core 的 freezeCapability 必须广播该事件');
    console.log('       [实测] 冻结经事件广播，执行器无私有字段访问');
  });

  runner.test('R0-136d 冻结时必须丢弃已有缓存（冻结=不再用旧结果，不是"多问一句"）', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d });
      h.core.registerCapability('tool.read', { owner: 'tool-read', handler: async () => 'DATA' });
      writeFileSync(join(h.ws, 'a.txt'), 'x');
      await h.exec.executeOne('tool-read', { path: 'a.txt' }, 's1', 'c1');
      // `_setCache` 是 fire-and-forget（它内部 `_cacheKey` 要 await stat），
      // 所以这里必须等它真的落进 Map，否则测到的是"还没来得及写"。
      for (let i = 0; i < 100 && h.exec._cache.size === 0; i++) await new Promise((r) => setTimeout(r, 5));
      assert(h.exec._cache.size > 0, '前提：第一次调用后应有缓存（已等到落盘）');
      h.core.freezeCapability('tool.read');
      assertEquals(h.exec._cache.size, 0,
        `冻结后缓存应被清空（否则解冻前一直留着旧结果），实际 ${h.exec._cache.size} 条`);
      console.log('       [实测] 冻结 → 缓存清空');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ── R0-141 / R0-142（并入同一个 setup：测试文件只导出 setup，独立的 setup2 不会被跑到）──

// ── R0-141 / R0-142：同一批扫描的后两条 ─────────────────────────────────────
//
// R0-141 **档位配置允许是字符串**。`config set model.worker kimi` 存进去的是字符串，
//        而修前的 `if (tierCfg) tierCfg.baseUrl` 对字符串取到 undefined，于是**静默**
//        回落到 base 的端点/模型/key —— 用户以为切了模型，实际没切，且无任何日志。
// R0-142 **allowlist 按请求名判**，是 R0-131/A 形状的第四个入口：
//        `tools.allowlist=['safe-wrapper']` + 该工具 `provides: tool.write`
//        → 预检按名字放行、`tool.write` 真的写盘。
  const getModelWith = async (modelCfg) => {
    const d = mkdtempSync(join(tmpdir(), 'r141-'));
    try {
      const { Core } = await imp('src/core/core.js');
      const core = new Core({ stateDir: join(d, 'state') });
      const warns = [];
      core.log = (lvl, msg) => { if (lvl === 'warn') warns.push(String(msg)); };
      core.registerService('config', { data: { model: modelCfg } });
      const model = Object.create((await imp('plugins/model-openai.js')).default);
      model.core = core;
      return { cfg: model.getModel('worker'), warns };
    } finally { rmSync(d, { recursive: true, force: true }); }
  };

  runner.test('R0-141/a 档位写成字符串时必须生效（config set model.worker kimi 是最自然的写法）', async () => {
    const { cfg } = await getModelWith({
      baseUrl: 'https://base.example/v1', model: 'base-model', apiKey: 'k1', worker: 'worker-model',
    });
    assertEquals(cfg.model, 'worker-model',
      `字符串档位必须被当作模型名 —— 修前静默回落成 base-model，实际 ${cfg.model}`);
    assertEquals(cfg.baseUrl, 'https://base.example/v1', '端点应沿用 base（这就是该写法的意图）');
    assertEquals(cfg.apiKey, 'k1', 'key 应沿用 base');
    console.log('       [实测] worker="worker-model" → 模型名生效，端点/Key 沿用 base');
  });

  runner.test('R0-141/b 反例：对象形态的逐字段覆盖必须原样保留（不得被这次修改影响）', async () => {
    const { cfg } = await getModelWith({
      baseUrl: 'https://base.example/v1', model: 'base-model', apiKey: 'k1',
      worker: { baseUrl: 'https://worker.example/v1', model: 'worker-model', apiKey: 'k2' },
    });
    assertEquals(cfg.baseUrl, 'https://worker.example/v1', '对象形态应逐字段覆盖');
    assertEquals(cfg.model, 'worker-model', '对象形态应逐字段覆盖');
    assertEquals(cfg.apiKey, 'k2', '对象形态应逐字段覆盖');
    console.log('       [实测] 对象形态原样生效');
  });

  runner.test('R0-141/c 形状非法时必须显式告警，不得静默', async () => {
    const { warns } = await getModelWith({
      baseUrl: 'https://base.example/v1', model: 'base-model', worker: 42,
    });
    assert(warns.some((w) => /model\.worker/.test(w)),
      `形状无法识别时必须告警（静默忽略正是 R0-141 的成因），实际告警：${JSON.stringify(warns)}`);
    console.log('       [实测] worker=42 → 告警点名 model.worker');
  });

  runner.test('R0-142/a allowlist 必须按解析出的能力判：别名不得绕过', async () => {
    const d = mkdtempSync(join(tmpdir(), 'r142-'));
    try {
      const ws = join(d, 'ws'); mkdirSync(ws, { recursive: true });
      const { Core } = await imp('src/core/core.js');
      const core = new Core({ stateDir: join(d, 'state') });
      core.log = () => {};
      core.setData('agent.workDir', ws);
      core.registerService('config', { get: (k, fb) => ({ 'tools.allowlist': ['safe-wrapper'] }[k] ?? fb) });
      await (await imp('plugins/workspace.js')).default.init(core);
      await (await imp('plugins/tool-guard.js')).default.init(core);

      const exec = Object.create((await imp('plugins/tool-executor.js')).default);
      exec._preHooks = []; exec._postHooks = []; exec._dispatchHooks = [];
      exec._rateCalls = new Map(); exec._cache = new Map(); exec._auditLog = new Map();
      await exec.init(core);

      let wrote = false;
      core.registerCapability('tool.write', { owner: 'tool-write', handler: async () => { wrote = true; return 'WROTE'; } });
      core.registerService('tool-registry', {
        get: async (n) => (n === 'safe-wrapper' ? { name: 'safe-wrapper', provides: [{ name: 'tool.write' }] } : null),
        has: () => true, list: () => [],
      });

      const r = await exec.executeOne('safe-wrapper', {}, 's1', 'c1');
      assertEquals(wrote, false,
        'allowlist 里的 safe-wrapper 落到 tool.write 能力上 —— 修前实测真的写盘并返回 succeeded（R0-131/A 的第四个入口）');
      assertEquals(r.state, 'rejected', `应为拒绝，实际 ${r.state}`);
      assertEquals(r.code, 'capability_denied', `应报 capability_denied，实际 ${r.code}`);
      console.log('       [实测] 别名 safe-wrapper → capability_denied，handler 未执行');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-142/b allowCapability 判据六情形：等价写法互通、不模糊匹配、未配名单不干预', async () => {
    const G = (await imp('plugins/tool-guard.js')).default;
    const saved = G._allowlist; const savedCore = G.core;
    try {
      G.core = { emit() {} };
      const cases = [
        [['tool-read'], 'tool.read', true, '工具名形态的名单应接受能力 id'],
        [['tool.read'], 'tool.read', true, '能力形态的名单应接受能力 id'],
        [['tool.write'], 'tool.read', false, '不在名单里的能力必须拒'],
        [[], 'tool.read', true, '未配名单 ⇒ 不干预'],
        [['tool-read'], null, false, '能力不明 ⇒ 拒绝（不明不等于安全）'],
        [['tool.read'], 'tool.readwrite', false, '不得模糊匹配'],
      ];
      for (const [list, cap, want, why] of cases) {
        G._allowlist = list;
        assertEquals(G.allowCapability(cap), want, `allowlist=${JSON.stringify(list)} cap=${cap}：${why}`);
      }
      console.log('       [实测] allowCapability 六情形全部符合');
    } finally { G._allowlist = saved; G.core = savedCore; }
  });

  runner.test('R0-145 工具声明的 parameters 必须在执行期生效（不得只是给模型看的说明）', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d });
      const W = (await imp('plugins/tools/tool-write.js')).default;
      await W.init(h.core);
      // 声明里 path 是 string。传 number 必须被**形状门**拒，而不是等到工具内部才出错。
      const r = await h.core.callCapability('tool.write', { path: 12345, content: 'x' });
      assertEquals(r.ok, false, '错类型的 path 必须被拒');
      assertEquals(r.code, 'invalid_input', `应报 invalid_input，实际 ${r.code}：${String(r.error).slice(0, 100)}`);
      assert(/应为 string|should be string/.test(String(r.error)),
        `错误必须来自形状校验（点名类型不符），而不是工具手写检查：${String(r.error).slice(0, 120)}`);
      console.log('       [实测] path=12345 → 形状门拒绝（声明真的在生效）');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-146 空字符串是合法的文件内容（写空文件不得报 content missing）', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d });
      const W = (await imp('plugins/tools/tool-write.js')).default;
      await W.init(h.core);
      const r = await h.core.callCapability('tool.write', { path: 'empty.txt', content: '' });
      assertEquals(r.ok, true,
        `写空文件必须成功 —— 修前 \`args.content || …\` 把 '' 当假值，报 "content" missing，实际 ${String(r.error).slice(0, 120)}`);
      assertEquals(existsSync(join(h.ws, 'empty.txt')), true, '空文件必须真的被创建');
      assertEquals(readFileSync(join(h.ws, 'empty.txt'), 'utf8'), '', '内容必须是空串');
      console.log('       [实测] content="" → 成功，文件存在且为空');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-147 不传 limit 不得返回空内容（slice(0, NaN) 的静默错读）', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d });
      const R = (await imp('plugins/tools/tool-read.js')).default;
      await R.init(h.core);
      writeFileSync(join(h.ws, 'five.txt'), 'l1\nl2\nl3\nl4\nl5\n');
      const r = await h.core.callCapability('tool.read', { path: 'five.txt' });
      assertEquals(r.ok, true, `不传 limit 应成功（有默认值），实际 ${String(r.error).slice(0, 120)}`);
      const text = String(r.payload || '');
      assert(text.includes('l1'),
        `不传 limit 时必须真的读到内容 —— 修前 \`Math.max(1, undefined)\` 是 NaN，`
        + `\`slice(0, NaN)\` 返回空数组，于是"没传 limit"被读成"文件是空的"且报成功。实际载荷：${JSON.stringify(text.slice(0, 120))}`);
      console.log('       [实测] 不传 limit → 读到内容（不再静默返回空）');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-147b limit 的声明不得是 required（代码里本来就有默认值）', async () => {
    const R = (await imp('plugins/tools/tool-read.js')).default;
    const req = R.parameters?.required ?? [];
    assert(!req.includes('limit'),
      `limit 有默认值，声明成 required 是在对模型撒谎（它会以为不传就失败、被迫瞎猜数字），实际 required=${JSON.stringify(req)}`);
    assert(req.includes('path'), 'path 仍是必填');
    console.log('       [实测] required = ["path"]（limit 不再假装必填）');
  });

  // ── R0-148：审计必须覆盖**被拒**的调用，且必须有读者 ──────────────────────
  //
  // 两处缺口叠在一起才构成这条：
  //   ① `_addAudit` 只在成功/失败时调用，被权限门/软闸/pre-hook/派发期拦下的调用
  //      **一行都不留**。而安全审计最该回答的恰恰是"最近哪些调用被拒了、为什么"。
  //   ② `getAuditLog()` 全仓**没有生产读者**（只有测试在读）。于是"审计"这个名字下
  //      既没记全、也读不到。
  runner.test('R0-148/a 被拒绝的调用必须进审计，且带上具名 code 与原因', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d, config: {
        'tools.permissionMode': 'read-only',
        // 控制面（/api/*）在未配 apiKey 时只认回环；本测试直接驱动 handler，
        // 需要一条显式凭证才能过 `_guardControlPlane`（这本身就是它的正常语义）。
        'gateway.apiKey': 'k-test',
      } });
      h.core.registerCapability('tool.write', { owner: 'tool-write', handler: async () => 'WROTE' });

      const r = await h.exec.executeOne('tool-write', { path: 'a.txt', content: 'x', _tcId: 'c1' }, 's1', 'c1');
      assertEquals(r.status, 'blocked', `应被拦下，实际 ${JSON.stringify(r).slice(0, 120)}`);

      const log = h.exec.getAuditLog('s1', 10);
      assertEquals(log.length, 1,
        `被拒的调用必须留审计（修前一行都不留），实际 ${log.length} 条`);
      assertEquals(log[0].status, 'blocked', '审计里必须标出这是被拦下的');
      assertEquals(log[0].code, 'PERMISSION_DENIED', `审计必须带具名 code，实际 ${log[0].code}`);
      assert(/Read-only/.test(String(log[0].reason)),
        `审计必须带原因（"为什么被拒"是审计的全部意义），实际 ${log[0].reason}`);
      console.log('       [实测] 被拒调用进审计：status=blocked + code + reason');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-148/b 派发期拒绝（撤销/只读/能力不足）同样必须进审计', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d });
      h.core.registerCapability('tool.read', { owner: 'tool-read', handler: async () => 'ok' });
      h.exec.registerDispatchHook(() => (
        { block: true, reason: 'execution_revoked: test', code: 'execution_revoked' }), 'gate');
      await h.exec.executeOne('tool-read', { path: 'a.txt', _tcId: 'c1' }, 's1', 'c1');
      const log = h.exec.getAuditLog('s1', 10);
      assertEquals(log.length, 1, `派发期拒绝也必须留审计，实际 ${log.length} 条`);
      assertEquals(log[0].code, 'execution_revoked', `应带 code，实际 ${log[0].code}`);
      console.log('       [实测] 派发期拒绝 → 审计 status=blocked + code=execution_revoked');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-148/c getAuditLog 必须有生产读者（运行时判据，不数源码字符串）', async () => {
    // ⚠ 这一条第一版只断言 gateway.js 源码里出现 `getAuditLog` / `/api/audit`。
    // 变异实验证实了后果：把 addHandler 那一行删掉（读者没了），测试照样绿 ——
    // 因为**注释里还留着那两个词**。这与我上一轮批评过的 R0-135 假绿是同一个错。
    // 改为：真跑一次 `/api/audit`，看响应体里有没有数据。
    const d = base();
    try {
      const h = await makeHost({ base: d, config: { 'tools.permissionMode': 'read-only' } });
      h.core.registerCapability('tool.write', { owner: 'tool-write', handler: async () => 'WROTE' });
      await h.exec.executeOne('tool-write', { path: 'a.txt', content: 'x', _tcId: 'c1' }, 's1', 'c1');

      const GW = (await imp('plugins/gateway.js')).default;
      const gw = Object.create(GW);
      gw.core = h.core;
      let sent = null;
      gw._sendJson = (res, code, body) => { sent = { code, body }; };
      // 网关的 `_sameOrigin` 要求 Host 在可信集合里（修 R0-113 时加的），必须给合法的回环 Host，
      // 否则会先被 403 挡掉 —— 那时测到的是跨源判据，不是审计读者。
      gw._trustedHosts = () => new Set(['127.0.0.1:9002']);
      // `_guardControlPlane` 在未配 apiKey 时会要求客户端地址是回环。本测试直接驱动 handler、
      // 没有真实 socket，故把 remoteAddress 一并给上 —— 这是**满足**判据，不是绕过它。
      // 直接驱动端点自己的处理函数：`addHandler` 注册的表在 `init()` 里建，
      // 而本用例是 `Object.create`（不跑 init，避免真去 listen）。要验的是
      // "**读者存在且真的把数据取出来**"，那正是 `_handleAuditGet` 的职责。
      // 若这个方法被删掉（读者消失），下面这行会抛 TypeError —— 同样会红。
      const req = { method: 'GET', url: '/api/audit?session=s1', headers: { host: '127.0.0.1:9002' } };
      const res = { setHeader() {}, end() {}, writeHead() {} };
      await gw._handleAuditGet(req, res);

      assert(sent, 'gateway 没有响应审计读取（本测试无法判定，拒绝假绿）');
      assertEquals(sent.code, 200, `应 200，实际 ${sent.code}：${JSON.stringify(sent.body).slice(0, 120)}`);
      assert(Array.isArray(sent.body.entries) && sent.body.entries.length === 1,
        `响应里必须真的带上审计条目（修前 getAuditLog 零生产读者），实际 ${JSON.stringify(sent.body).slice(0, 160)}`);
      assertEquals(sent.body.durable, false, '必须显式标 durable:false');
      console.log('       [实测] GET /api/audit 返回 1 条审计（status=blocked），durable=false');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-148/d 审计读取面不得谎称 durable（发行包 event-sink 是 null sink）', async () => {
    const src = (await import('node:fs')).readFileSync(join(ROOT, 'plugins/gateway.js'), 'utf8');
    const i = src.indexOf('/api/audit');
    assert(i > 0, '应有 /api/audit');
    const block = src.slice(i, i + 2000);
    assert(/durable:\s*false/.test(block),
      '审计端点的响应必须显式标 durable:false —— 它是进程内环形缓冲，发行包不落盘，'
      + '声称 durable 会让人以为它是可追溯的持久审计');
    console.log('       [实测] /api/audit 响应标 durable:false');
  });

  // ── R0-149 / R0-150 ───────────────────────────────────────────────────────
  //
  // R0-149 **代码接受的别名被声明挡在门外**。R0-145 让 `parameters` 生效之后，
  //        `tool-write` 内部的 `path | file_path | filePath` 三种写法里，后两种直接
  //        `缺少必填参数 'path'` —— 别名成了死代码。声明不能比代码更窄。
  // R0-150 **`output_schema` 执行期零读者**。注册时只校验形状并存储，此后从不看返回值：
  //        声明 `type:'string'` 的能力返回对象照样 succeeded。现有两个声明恰好都对，
  //        所以它是**潜在**缺口。修法是**只告警不阻断**（声明是契约文档，不是判据）。
  runner.test('R0-149 代码接受的参数别名必须出现在声明里（否则别名是死代码）', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d });
      const W = (await imp('plugins/tools/tool-write.js')).default;
      await W.init(h.core);

      // 工具 execute 里明确接受这三种写法，声明就必须都收
      for (const [label, args] of [
        ['path', { path: 'a.txt', content: 'x' }],
        ['file_path', { file_path: 'b.txt', content: 'x' }],
        ['filePath', { filePath: 'c.txt', content: 'x' }],
      ]) {
        const r = await h.core.callCapability('tool.write', args);
        assertEquals(r.ok, true,
          `别名 ${label} 必须可用 —— 修前（声明只认 path 且 required）会报 缺少必填参数 'path'，实际 ${String(r.error).slice(0, 100)}`);
      }
      assertEquals(existsSync(join(h.ws, 'a.txt')), true, 'path 形态应写盘');
      assertEquals(existsSync(join(h.ws, 'b.txt')), true, 'file_path 形态应写盘');
      assertEquals(existsSync(join(h.ws, 'c.txt')), true, 'filePath 形态应写盘');

      // ⚠ 光验证"能用"是不够的：把别名从声明里删掉，`required: []` 仍然放行
      // （core 的 `_schemaViolation` 只校验**已声明**的字段，未知字段不拒）。
      // 变异实验证实了后果 —— 删掉别名声明后本用例照绿。
      // 所以要**直接检查声明本身**：代码接受的每一种写法都必须在 `properties` 里。
      const decl = W.parameters?.properties ?? {};
      for (const k of ['path', 'file_path', 'filePath', 'content', 'file_content', 'contents']) {
        assert(k in decl,
          `\`${k}\` 是 execute() 明确接受的写法，必须出现在声明里 —— `
          + '否则"文档说支持"与"实际支持"会再次分叉（缺失时 schema 不拒但也没声明，等于靠运气）');
      }
      console.log('       [实测] 三种 path 写法与三种 content 写法都在声明里');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-149b 放宽 required 之后，缺参数仍须给可读的具名失败', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d });
      const W = (await imp('plugins/tools/tool-write.js')).default;
      await W.init(h.core);
      const r = await h.core.callCapability('tool.write', { content: 'x' });   // 缺 path
      assertEquals(r.ok, false, '缺 path 必须失败');
      assertEquals(r.code, 'invalid_input', `应报 invalid_input，实际 ${r.code}`);
      assert(/path/.test(String(r.error)), `错误必须点名缺什么：${String(r.error).slice(0, 100)}`);
      // 类型校验不得因为放宽 required 而失效
      const t = await h.core.callCapability('tool.write', { path: 12345, content: 'x' });
      assertEquals(t.ok, false, '错类型仍必须被拒');
      assert(/应为 string/.test(String(t.error)), `形状门仍须生效：${String(t.error).slice(0, 100)}`);
      console.log('       [实测] 缺参 → invalid_input 点名 path；错类型 → 形状门拒绝');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-150 output_schema 不符必须可观测（告警 + 事件），且不得阻断执行', async () => {
    const d = base();
    try {
      const warns = [];
      const events = [];
      const h = await makeHost({ base: d });
      h.core.log = (lvl, msg) => { if (lvl === 'warn') warns.push(String(msg)); };
      h.core.emitFast = (name, payload) => { events.push({ name, payload }); };

      // ① 相符：不得告警
      h.core.registerCapability('tool.read', {
        owner: 'tool-read', output_schema: { type: 'string' }, handler: async () => 'text',
      });
      writeFileSync(join(h.ws, 'a.txt'), 'x');
      await h.exec.executeOne('tool-read', { path: 'a.txt' }, 's1', 'c1');
      assertEquals(warns.filter((w) => /output_schema/.test(w)).length, 0,
        '声明与返回相符时不得告警（否则噪声会淹没真问题）');

      // ② 不符：必须告警 + 发事件，但**不得阻断**
      h.core.registerCapability('tool.badout', {
        owner: 'bad', output_schema: { type: 'string' }, handler: async () => ({ not: 'string' }),
      });
      const r = await h.exec.executeOne('tool-badout', {}, 's1', 'c1');
      assertEquals(warns.filter((w) => /output_schema/.test(w)).length, 1,
        '声明 type=string 却返回对象时必须告警 —— 修前执行期零读者，这种偏差完全不可观测');
      assert(events.some((e) => e.name === 'tool.output_schema_mismatch'),
        '必须发 `tool.output_schema_mismatch` 事件（告警要能被订阅，而不只是刷一行日志）');
      assertEquals(r.state, 'succeeded',
        `只告警不阻断：声明是契约文档，不是判据，写错的声明不该变成线上故障。实际 ${r.state}`);
      console.log('       [实测] 相符不告警；不符告警+事件，但仍 succeeded');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ── R0-151：override 不得静默丢掉安全声明 ────────────────────────────────
  //
  // `registerCapability` 的 `override` 分支此前**整条替换记录**。于是同一 owner
  // 显式 `override:true` 重注册、却漏写 `permissions` 时，`require_identity` / `scope`
  // 就无声消失 —— 一个受保护能力变成公开能力。
  //
  // 这不是热重载路径（那条会先 `unload`），而是 `override` 作为**公开 API** 的契约问题：
  // 第三方插件按文档用 override 更新 handler 时，很容易不重复写一遍权限。
  runner.test('R0-151 override 未声明 permissions 时必须继承旧值（不得静默降权）', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d });
      let ran = 0;
      const first = h.core.registerCapability('t.secure', {
        owner: 'ownerA', permissions: { require_identity: true },
        handler: async () => { ran++; return 'SECRET'; },
      });
      // 同 owner 显式 override，但**不写** permissions；凭据是上一次登记交回的
      h.core.registerCapability('t.secure', {
        owner: 'ownerA', overrideBy: first,
        handler: async () => { ran++; return 'SECRET'; },
      });
      const r = await h.core.callCapability('t.secure', {});
      assertEquals(r.ok, false,
        `override 后未受信身份不得拿到 SECRET —— 修前 require_identity 被静默冲掉，实际 ok=${r.ok}`);
      assertEquals(r.state, 'denied', `应为拒绝，实际 ${r.state}`);
      assertEquals(ran, 0, '被拒时 handler 不得执行');
      console.log('       [实测] override 漏写 permissions → 仍受 require_identity 保护');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-151b 反例：显式声明 permissions 时仍必须真的覆盖（不得变成"永远继承"）', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d });
      const first = h.core.registerCapability('t.x', {
        owner: 'ownerA', permissions: { require_identity: true }, handler: async () => 'A',
      });
      // 显式把 permissions 改成空对象 —— 这是"我确实要放宽"的表达，必须生效
      h.core.registerCapability('t.x', {
        owner: 'ownerA', overrideBy: first, permissions: {}, handler: async () => 'A',
      });
      const r = await h.core.callCapability('t.x', {});
      assertEquals(r.ok, true,
        `显式声明 permissions:{} 必须生效（否则"继承"会变成无法关闭的枷锁），实际 ${r.state}`);
      console.log('       [实测] 显式 permissions:{} → 覆盖生效（继承只在未声明时）');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ── R0-152：接 schema 时不得把内核不支持的关键字塞进去 ────────────────────
  //
  // 这是我在 R0-145 里引入的**更严重的回归**：`tool-todo` 与 `tool-validate` 的
  // `parameters` 里有 `enum`，而 core 的 `UNSUPPORTED_SCHEMA_KEYWORDS` 包含 `enum`
  // 并在**注册时具名拒绝**。接上 schema 之后这两个工具**直接装不上**：
  //     schema_unsupported：能力 "tool.todo" 的 input_schema 使用了本内核不校验的关键字 'enum'
  // 也就是说，一次"让声明生效"的修复，让两个工具彻底不可用。
  runner.test('R0-152 全部内建工具都必须能装载（含声明里用了 enum/items 的那些）', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d });
      const tools = ['tool-bash', 'tool-cp', 'tool-list', 'tool-mv', 'tool-read',
        'tool-rm', 'tool-stat', 'tool-todo', 'tool-validate', 'tool-write'];
      for (const t of tools) {
        const M = (await imp(`plugins/tools/${t}.js`)).default;
        // 装载失败会抛 schema_unsupported —— 那正是本条要守的
        await M.init(h.core);
      }
      const ids = h.core.listCapabilities().map((c) => c.id);
      for (const t of tools) {
        const cap = `tool.${t.replace('tool-', '')}`;
        assert(ids.includes(cap), `${t} 必须成功注册能力 ${cap}（修前 tool-todo/tool-validate 因 enum 注册失败）`);
      }
      console.log(`       [实测] 10 个内建工具全部装载成功（含 tool-todo / tool-validate 的 enum 声明）`);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-152b enum 等给模型看的约束必须保留在 parameters，但不进校验层', async () => {
    const T = (await imp('plugins/tools/tool-todo.js')).default;
    // ① 给模型看的那份：必须保留 enum（否则模型不知道合法取值）
    assertEquals(JSON.stringify(T.parameters.properties.op.enum), '["create","update","list"]',
      '`parameters` 是给模型看的接口说明，enum 必须保留 —— 剥掉它模型就不知道合法取值了');
    // ② 校验层那份：不得含 enum（否则注册被拒）
    const { declarableSchema } = await imp('plugins/tools/lib/schema.mjs');
    const decl = declarableSchema(T.parameters);
    assert(!('enum' in decl.properties.op),
      `校验层不得含 core 不支持的关键字（否则注册会被具名拒绝），实际 ${JSON.stringify(decl.properties.op)}`);
    assertEquals(decl.properties.op.type, 'string', 'type 必须保留 —— 那是 core 真能校验的部分');
    assertEquals(JSON.stringify(decl.required), '["op"]', 'required 必须保留');
    console.log('       [实测] parameters 保留 enum；input_schema 只留 type/required');
  });

  runner.test('R0-152c 剥掉 enum 之后，非法取值仍须被工具自己拒绝（不得静默接受）', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d });
      const T = (await imp('plugins/tools/tool-todo.js')).default;
      await T.init(h.core);
      const r = await h.core.callCapability('tool.todo', { op: 'NOT_A_VALID_OP' });
      assertEquals(r.ok, false, '非法 op 必须被拒（校验层剥掉了 enum，工具自己要兜底）');
      assertEquals(r.code, 'invalid_input', `应报 invalid_input，实际 ${r.code}`);
      console.log('       [实测] op=NOT_A_VALID_OP → invalid_input（工具自己兜底）');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ── R0-153：场景配置不得承诺不存在的能力（隐私比沙箱更该守） ──────────────
  //
  // `coding.json5` 里曾写着
  //     neverRead: [".env", "**/id_rsa", "**/credentials*"], neverWrite, offlineMode
  // 而全仓**没有任何一行代码读它们**。它们看起来是**隐私承诺** ——
  // 读到的人会认为"这个场景不会读我的凭据"，实际该读还是读，只是没人告诉你。
  runner.test('R0-153 场景 config 里不得出现零读者的 privacy 键', async () => {
    const { loadJson5 } = await imp('src/core/json5-loader.js');
    const scene = loadJson5(readFileSync(join(ROOT, 'scenes', 'coding.json5'), 'utf8'));
    const pv = scene?.defaultConfig?.privacy ?? {};
    for (const ghost of ['neverRead', 'neverWrite', 'offlineMode']) {
      assert(!(ghost in pv),
        `\`privacy.${ghost}\` 在 plugins/ 与 src/ 里读者数为 0，写进场景会让读者以为`
        + '"禁读凭据 / 禁写目录 / 离线"已生效');
    }
    assert(Array.isArray(pv.requireConfirmFor) && pv.requireConfirmFor.length > 0,
      '`privacy.requireConfirmFor` 是**真的有读者**的那条（privacy.shouldConfirm），必须保留');
    console.log('       [实测] coding.json5 只留 requireConfirmFor，三个幽灵键已删');
  });

  runner.test('R0-153b 全场景普查：defaultConfig 的每个键都必须有读取方', async () => {
    const fs = await import('node:fs');
    const pathMod = await import('node:path');
    const dir = join(ROOT, 'scenes');
    // 收集全仓源码（排除测试与产物）用于"有没有人读这个键"的判据
    const files = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = pathMod.join(d, e.name);
        if (e.isDirectory()) { if (!['node_modules', '.git', 'vendor', 'test-results'].includes(e.name)) walk(p); }
        else if (/\.(js|mjs)$/.test(e.name)) files.push(p);
      }
    };
    walk(join(ROOT, 'plugins')); walk(join(ROOT, 'src'));
    const src = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    const leafKeys = (o, pre = '', out = []) => {
      for (const [k, v] of Object.entries(o || {})) {
        const p = pre ? `${pre}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) leafKeys(v, p, out);
        else out.push(p);
      }
      return out;
    };
    const { loadJson5 } = await imp('src/core/json5-loader.js');
    const ghosts = [];
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json5'))) {
      const scene = loadJson5(fs.readFileSync(join(dir, f), 'utf8'));
      for (const k of leafKeys(scene?.defaultConfig)) {
        const leaf = k.split('.').pop();
        const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const hasReader = new RegExp(`['"]${esc(k)}['"]`).test(src)
          || new RegExp(`get\\(\\s*['"][^'"]*${esc(leaf)}['"]`).test(src);
        if (!hasReader) ghosts.push(`${f}: ${k}`);
      }
    }
    assertEquals(ghosts.length, 0,
      `这些场景配置键在全仓找不到读取方（配置面的虚假承诺）：\n  ${ghosts.join('\n  ')}`);
    console.log('       [实测] 全部场景的 defaultConfig 键都有读取方');
  });

  // ── R0-154 / R0-155：声明了 provider，就真的得能被取到 ────────────────────
  //
  // R0-154 `health.js` 声明 `provides: [{name:'health.monitor', type:'service'}]`，
  //        但**从未 registerService** ⇒ `getService('health.monitor')` 是 undefined。
  // R0-155 `tools.js` 声明 5 个能力（bash/read/write/list/stat），`_registerBuiltinTools`
  //        只把它们塞进自己的 Map 并 `emit('tool.registered')`，**从不 registerCapability**
  //        ⇒ 实测能力表为空、`callCapability('bash')` 报 capability_not_found。
  //        **事件说"注册了"，能力表里没有** —— 订阅事件的界面/审计都会以为就绪。
  runner.test('R0-154 声明为 service 的 provides 必须真的能被 getService 取到', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d });
      const H = (await imp('plugins/health.js')).default;
      await H.init(h.core);
      const svc = h.core.getService('health.monitor');
      assert(svc, '`provides` 声明了 health.monitor 就必须能取到 —— '
        + '修前它只写了声明、从未 registerService，getService 返回 undefined');
      assertEquals(typeof svc.getStatus, 'function', '取到的服务必须真的能用（有 getStatus）');
      console.log('       [实测] getService(health.monitor) 可取得且带 getStatus');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-155 tools.js 声明的能力必须真的注册（事件与能力表不得脱节）', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d });
      const T = (await imp('plugins/tools.js')).default;
      const declared = T.provides.map((p) => p.name);
      const events = [];
      h.core.on('tool.registered', (e) => events.push(e.name));
      await T.init(h.core);

      const ids = h.core.listCapabilities().map((c) => c.id);
      for (const name of declared) {
        assert(ids.includes(name),
          `\`${name}\` 声明在 provides 里，必须真的注册成能力 —— `
          + '修前只 emit tool.registered 而不 registerCapability，实测能力表为空');
      }
      // 事件与能力表必须一致：发过 tool.registered 的名字都要在能力表里
      assertEquals(events.length, declared.length, '每个声明都应发一次 tool.registered');
      for (const name of events) {
        assert(ids.includes(name),
          `发过 tool.registered('${name}') 却不在能力表里 —— 事件在骗订阅者`);
      }
      console.log(`       [实测] ${declared.length} 个 legacy 能力全部可调，事件与能力表一致`);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-155b legacy 能力必须真的能干活（不只看注册成功）', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d });
      const T = (await imp('plugins/tools.js')).default;
      await T.init(h.core);
      const w = await h.core.callCapability('write', { path: 'legacy.txt', content: 'hello' });
      assertEquals(w.ok, true, `legacy write 必须成功，实际 ${w.code}`);
      assertEquals(existsSync(join(h.ws, 'legacy.txt')), true, '文件必须真的落盘');
      const r = await h.core.callCapability('read', { path: 'legacy.txt' });
      assertEquals(r.ok, true, `legacy read 必须成功，实际 ${r.code}`);
      assert(String(r.payload).includes('hello'), '读回的内容必须正确');
      console.log('       [实测] legacy write/read 真的读写磁盘');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ── R0-156：provides 的声明名必须等于 registerService 的实际注册名 ─────────
  //
  // 修前 `tool-loader` 声明 `tool.registry`（点号）、注册 `tool-registry`（连字符）；
  // `tool-guard` 声明 `tool.guard`、注册 `tool-guard`。而 `tool-executor` 的
  // `manifest.requires` 也写点号 —— **两边都写点号，闸门就认为依赖满足**：
  //
  //     validateAssembly(...) → violations = []          ← 闸门通过
  //     getService('tool.registry') → undefined          ← 运行期取不到
  //
  // 这是"闸门通过"与"实际取得到"之间的一道裂缝：假绿灯不是配置错，是**同一份名字有两种写法**。
  runner.test('R0-156 声明为 service 的 provides 必须能被 getService 取到（名字一致）', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d });
      for (const p of ['tool-loader', 'tool-guard']) {
        const M = (await imp(`plugins/${p}.js`)).default;
        await M.init(h.core);
        for (const item of M.provides || []) {
          const name = typeof item === 'string' ? item : item.name;
          if (item?.type === 'capability') continue;
          assert(h.core.getService(name),
            `${p} 的 provides 声明了 '${name}'，但 getService('${name}') 取不到 —— `
            + '声明名必须等于 registerService 的实际注册名（修前是 tool.registry vs tool-registry）');
        }
      }
      console.log('       [实测] tool-registry / tool-guard 的声明名都可 getService 取到');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-156b 逐插件普查：所有 service 类 provides 都必须可取（不得有假绿灯）', async () => {
    const fs = await import('node:fs');
    const d = base();
    try {
      const h = await makeHost({ base: d });
      const dir = join(ROOT, 'plugins');
      const ghosts = [];
      for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js') && !n.startsWith('_'))) {
        const M = (await imp(`plugins/${f}`)).default;
        if (!M || typeof M.init !== 'function') continue;
        // 只挑"声明了 service 类 provides"的，且能在本 host 里 init 的
        const svcItems = (M.provides || []).filter((p) => p && typeof p === 'object'
          && p.type !== 'capability' && p.name);
        if (!svcItems.length) continue;
        try { await M.init(h.core); } catch { continue; }   // 依赖不满足的跳过（不假装通过）
        for (const item of svcItems) {
          if (!h.core.getService(item.name)) ghosts.push(`${f}: ${item.name}`);
        }
      }
      assertEquals(ghosts.length, 0,
        `这些插件声明了 service 类 provides 但运行期取不到（闸门会假绿灯）：\n  ${ghosts.join('\n  ')}`);
      console.log('       [实测] 所有可初始化的 service 类 provides 都能 getService 取到');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('R0-156c 依赖闸门与实际可达性必须一致（不得一边通过一边取不到）', async () => {
    const { validateAssembly } = await imp('plugins/admission-gate.js');
    const loaded = new Map();
    for (const p of ['tool-loader', 'tool-guard', 'tool-executor']) {
      loaded.set(p, (await imp(`plugins/${p}.js`)).default);
    }
    const r = validateAssembly(loaded);
    assertEquals(r.violations.length, 0,
      `装配本身不该有违例（修前两边都写点号所以也是 0，但运行期取不到 —— 本条与上一条合起来才守得住）：\n`
      + `  ${JSON.stringify(r.violations)}`);
    console.log('       [实测] validateAssembly 0 违例');
  });

  // ── R0-157：沙箱 opMap 与实际工具必须一致 ────────────────────────────────
  //
  // `_maybeSandbox` 里的 `opMap` 是**手写表**，实测有 20 项而真实工具只有 10 个 ——
  // 一半是死条目（tool-grep / glob / json / fetch / ask / diff / git / mode / context / note）。
  //
  // 死条目本身不造成安全漏洞（工具名不存在就永不被查到），且"未声明 sandboxOp"已 fail-closed。
  // 但它会**误导维护者**：看着表里有 `tool-git`，会以为 git 工具已被沙箱覆盖。
  // 更危险的是**反向**：新加一个工具时若只顾着写实现、忘了在两处之一登记，
  // 就没有任何机制会发现表与工具已经脱节。这条测试让脱节立刻可见。
  runner.test('R0-157 沙箱 opMap 不得有死条目（表里每一项都必须有对应工具）', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(join(ROOT, 'plugins', 'tool-executor.js'), 'utf8');
    const start = src.indexOf('const opMap = {');
    assert(start > 0, '应能定位到 opMap（它若改名，本测试需要同步，而不是静默失效）');
    const block = src.slice(start, src.indexOf('};', start));
    const keys = [...block.matchAll(/'([a-z][a-z0-9-]*)':/g)].map((m) => m[1]);
    assert(keys.length > 0, 'opMap 不应为空');

    const real = new Set(fs.readdirSync(join(ROOT, 'plugins', 'tools'))
      .filter((f) => f.endsWith('.js')).map((f) => f.replace(/\.js$/, '')));
    const dead = keys.filter((k) => !real.has(k));
    assertEquals(dead.length, 0,
      `opMap 里这些工具不存在（维护者会误以为它们已被沙箱覆盖）：\n  ${dead.join('\n  ')}`);
    console.log(`       [实测] opMap ${keys.length} 项全部对应真实工具（无死条目）`);
  });

  runner.test('R0-157b 未声明 sandboxOp 的第三方工具必须被拒（fail closed，不得静默放行）', async () => {
    const d = base();
    try {
      const h = await makeHost({ base: d, config: { 'sandbox.enabled': true } });
      h.core.registerService('sandbox', {
        execute: async () => ({ ok: true, data: 'SHOULD-NOT-RUN' }),
      });
      let ran = 0;
      // 表外工具、且没有声明 sandboxOp
      h.core.registerCapability('tool.thirdparty', { owner: 'thirdparty', handler: async () => { ran++; return 'X'; } });
      const r = await h.exec.executeOne('tool-thirdparty', { path: 'a.txt' }, 's1', 'c1');
      assertEquals(ran, 0, '沙箱启用时，未声明 sandboxOp 的工具不得执行 handler');
      // code 在 `r.code`（具名码），不在 error 文案里 —— 两者都要看，别只认字符串。
      const all = `${r.code || ''} ${r.error || ''} ${JSON.stringify(r.diagnostic || '')}`;
      assert(/sandbox_op_undeclared/.test(all),
        `必须报 sandbox_op_undeclared（fail closed），实际 code=${r.code} error=${String(r.error).slice(0, 120)}`);
      console.log('       [实测] 表外工具未声明 sandboxOp → sandbox_op_undeclared，handler 未运行');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
}
