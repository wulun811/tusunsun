// R0-110 随包门禁 —— 两类"失败长得像成功"的缺陷回归锁
//
// 这一轮不是从覆盖率出发，而是从**用户实际撞上的两次失败**出发（都在真实使用里抓到）：
//
//   T2 模型层：`_request` 从不 reject，它把错误 `resolve({content:'[API Error] …'})` 成
//      "有内容的结果"。于是 `callWithConfig` 里那个 `MAX_ATTEMPTS = 3` 的重试循环**一次都不会跑**
//      （`hasOutput` 判真 → 直接 break），非流式请求 20s 一枪就死；错误串还被当 assistant 消息
//      写进会话历史，下一轮作为"上文"喂回模型。
//      实测：6 次非流式请求 2 次在恰好 20.0s 返回 `[API Error] timeout 20s: no response`；
//      同一问题同一 session 换流式 59.4s 拿到正确答案（流式是 60s + 5 次退避）。
//
//   T3 发现层：运行期端口文件 `gateway.runtime.json` 只有 {port,pid}，不带身份 ⇒ 任何实例都能
//      覆盖/删除它；CLI 也没有身份核对 ⇒ 换个 `--state-dir` 查询，会把**另一个 state dir 的实例**
//      报成 `Running: yes`。
//
// 两组的判据都写成"**必须失败**"而不是"文案里有某词"：拒绝要 reject、重试要看次数、
// 身份不符要读不到。

import { assert, assertEquals } from '../harness.mjs';
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..', '..');

// v0.9.25：装配根只有一个 `plugins/`（此前还要在 `plugins/` 与 `src/builtin/` 之间二选一）。
// 第三层是**下游兼容树**的位置（本仓无此目录），下游复制本文件后靠它找到插件。
// 路径分段写成数组、由 spread 展开——构建期的自洽性过滤只认 `join()` 里的字面量链。
async function impPlugin(name) {
  for (const layer of [['plugins'], ['plugins', 'sancai', 'haotian']]) {
    const candidate = join(ROOT, ...layer, name);
    if (existsSync(candidate)) return (await import(pathToFileURL(candidate).href)).default;
  }
  throw new Error(`找不到插件：${name}`);
}

function tmpDir(tag) {
  return mkdtempSync(join(tmpdir(), `r0110-${tag}-`));
}

/** 恢复被测对象的原方法（改动实例方法必须在 finally 里还原，否则污染同一进程里的后续用例）。 */
async function withStub(obj, key, impl, fn) {
  const orig = obj[key];
  obj[key] = impl;
  try { return await fn(); } finally { obj[key] = orig; }
}

export async function setup(runner) {
  const ModelPlugin = await impPlugin('model-openai.js');
  const { Core } = await import(pathToFileURL(join(ROOT, 'src', 'core', 'core.js')).href);
  const { readGatewayRuntime, resolveGatewayPort } = await import(pathToFileURL(join(ROOT, 'src', 'bootstrap', 'cli.js')).href);

  const quietCore = {
    emit() {}, emitFast() {}, log() {},
    getService: () => null,
    get: () => undefined,
    getData: () => undefined,
  };

  // ── T2：错误路径必须 reject ────────────────────────────────────────────
  runner.test('R0-110/T2-a `_request` 网络错误必须 reject，不得 resolve 成"有内容的结果"', async () => {
    // 指向一个确定没人监听的端口：连接被拒 → 必须 reject（旧的实现会 resolve 一段错误文案）。
    let rejected = null;
    try {
      await ModelPlugin._request('https://127.0.0.1:1/v1', { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, 'k', 3000);
    } catch (err) { rejected = err; }
    assert(rejected, '_request 在连接失败时必须 reject（旧实现 resolve 成 {content:"[API Error] …"}）');
    console.log(`       [实测] 连接失败 → reject: ${rejected.code || rejected.message}`);
  });

  runner.test('R0-110/T2-b 重试循环必须真的跑满 3 次，且最终结果自证失败（error:true）', async () => {
    ModelPlugin.core = quietCore;
    try {
      // ① 前两次失败、第三次成功 ⇒ 必须调用 3 次并返回成功结果（证明重试真的生效）。
      let calls = 0;
      const ok = await withStub(ModelPlugin, '_request', async () => {
        calls++;
        if (calls < 3) throw new Error('boom');
        return { content: 'ok', tool_calls: [] };
      }, () => ModelPlugin.callWithConfig({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm' }, [{ role: 'user', content: 'hi' }], []));
      assertEquals(calls, 3, '前两次失败后必须重试到第三次成功（旧实现第一次就 break）');
      assertEquals(ok.content, 'ok', '第三次成功的结果必须原样返回');

      // ② 三次全失败 ⇒ 必须返回带 `error:true` 的失败结果（而不是一段看着像回答的正文）。
      let fails = 0;
      const bad = await withStub(ModelPlugin, '_request', async () => { fails++; throw new Error('timeout 20s: no response'); },
        () => ModelPlugin.callWithConfig({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm' }, [{ role: 'user', content: 'hi' }], []));
      assertEquals(fails, 3, '连续失败必须用满 3 次尝试');
      assert(bad.error === true, `失败结果必须带 error:true（实际：${JSON.stringify(bad)}）`);
      assert(bad.content.includes('timeout 20s'), '错误文案必须保留，便于取证');
      console.log(`       [实测] 重试 ${calls} 次后成功；连续失败 ${fails} 次后 error=true`);
    } finally { ModelPlugin.core = undefined; }
  });

  runner.test('R0-110/T2-c 非流式超时必须可配置，默认不再写死 20s（与流式 60s 对齐）', async () => {
    ModelPlugin.core = quietCore;
    const seen = [];
    const saved = process.env.TUSUNSUN_MODEL_TIMEOUT_MS;
    try {
      const run = () => withStub(ModelPlugin, '_request', async (_u, _b, _k, timeoutMs) => {
        seen.push(timeoutMs);
        return { content: 'ok', tool_calls: [] };
      }, () => ModelPlugin.callWithConfig({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm' }, [{ role: 'user', content: 'hi' }], []));

      await run();
      assertEquals(seen[0], 60000, '默认超时必须与流式对齐到 60s（旧值 20000 对长尾模型必然撞死）');

      process.env.TUSUNSUN_MODEL_TIMEOUT_MS = '12345';
      await run();
      assertEquals(seen[1], 12345, 'TUSUNSUN_MODEL_TIMEOUT_MS 必须生效');
      console.log(`       [实测] 默认 ${seen[0]}ms；env 覆盖后 ${seen[1]}ms`);
    } finally {
      if (saved === undefined) delete process.env.TUSUNSUN_MODEL_TIMEOUT_MS;
      else process.env.TUSUNSUN_MODEL_TIMEOUT_MS = saved;
      ModelPlugin.core = undefined;
    }
  });

  runner.test('R0-110/T2-d 上游 HTTP 错误体必须判为失败（apiError），正常体不得误判', async () => {
    const errBody = ModelPlugin._parseApiResult(401, JSON.stringify({ error: { message: 'bad key' } }));
    assert(errBody.apiError, '4xx 错误体必须带 apiError 标记（否则会被当成回答返回）');
    assert(errBody.content.includes('bad key'), '错误文案必须保留');

    const noChoice = ModelPlugin._parseApiResult(200, JSON.stringify({ id: 'x', choices: [] }));
    assert(noChoice.apiError, '无 choices 也必须判为失败');

    const garbage = ModelPlugin._parseApiResult(200, 'not json at all');
    assert(garbage.apiError, '非 JSON 响应也必须判为失败');

    const good = ModelPlugin._parseApiResult(200, JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }] }));
    assert(!good.apiError, '正常响应不得被误判为失败');
    assertEquals(good.content, 'hi', '正常响应的正文必须原样保留');
  });

  runner.test('R0-110/T2-e 模型失败不得落进会话历史（错误不是"模型说的话"）', async () => {
    // 实测缺陷：`[API Error] timeout 20s: no response` 被当成 assistant 轮写进 sessions/*.jsonl，
    // 下一轮它就成了"上文"被喂回模型。这里用假 core 走**两条真实入口**（非流式 callTier / 流式 streamChatTier）。
    const Haotian = await impPlugin('haotian-lite.js');
    const savedCore = Haotian.core;
    const savedReject = Haotian._rejectNew;
    // 并发闸门在 `init()` 里创建，本用例不跑 init（会注册能力）⇒ 用同形状的桩：acquire 返回 release。
    const savedLimiter = Haotian._concurrencyLimiter;
    const savedHistory = [];
    const session = {
      loadSession: async () => [...savedHistory],
      saveHistory: async (_sid, h) => { savedHistory.length = 0; savedHistory.push(...h); },
    };
    const makeCore = (model) => ({
      emitFast() {}, emit() {}, log() {}, getData: () => undefined,
      get: (p) => (p === 'agent.systemPrompt' ? 'sys' : undefined),
      runPipeline: async (_stage, msg) => msg,
      getService: (n) => (n === 'session' ? session : n === 'model' ? model : null),
    });
    const check = async (core, opts, label) => {
      savedHistory.length = 0;
      Haotian.core = core;
      Haotian._rejectNew = false;
      const r = await Haotian.handle({ message: 'hi', sessionId: 's1', ...opts });
      assert(String(r.reply).includes('API Error'), `${label}：错误必须如实返回给调用方，实际 ${JSON.stringify(r.reply)}`);
      assert(r.error === true, `${label}：返回必须带 error:true 供上层判定（HTTP 502 / 非 0 退出），实际 ${JSON.stringify(r)}`);
      const polluted = savedHistory.filter((m) => m.role === 'assistant' && String(m.content).includes('API Error'));
      assert(polluted.length === 0, `${label}：错误不得作为 assistant 轮写入历史，实际 ${JSON.stringify(polluted)}`);
    };
    try {
      Haotian._concurrencyLimiter = { acquire: async () => () => {} };
      // R0-144：`handle()` 现在会先检查 `_sessionQueue`（未 init 时给具名失败而不是裸 TypeError）。
      // 本用例本就不跑 init（会注册能力），故这里补一个同形状的桩，让它测到真正要测的路径。
      // 这原本是"测试缺桩"，但它同时暴露了一个真缺陷：未 init 时抛的是
      // `Cannot read properties of undefined (reading 'run')`，调用方无从判断是谁的问题。
      Haotian._sessionQueue = { run: async (_sid, fn) => fn() };
      await check(makeCore({ callTier: async () => ({ content: '[API Error] timeout 20s: no response', error: true }) }), {}, '非流式');
      await check(makeCore({
        streamChatTier: async function* () { yield { content: '[API Error] timeout 60s: no response', error: true }; },
      }), { stream: true }, '流式');
      console.log('       [实测] 非流式/流式两条路径：错误返回给调用方且 error=true，历史里 0 条 assistant 错误轮');
    } finally {
      Haotian.core = savedCore;
      Haotian._rejectNew = savedReject;
      Haotian._concurrencyLimiter = savedLimiter;
    }
  });

  // ── T1：能力可得性（"整个仪表盘都说健康，但根本不能对话"）────────────────
  runner.test('R0-110/T1-a `hasCapability` 必须走与 command 相同的懒加载解析路径', async () => {
    const core = new Core({ stateDir: tmpDir('cap') });
    let resolved = 0;
    // 懒加载挂钩：被调用一次后把能力注册上（模拟"按需装载的 provider"）。
    core.setData('_lazyHook', async (id) => {
      resolved++;
      if (id === 'chat.handle') core.registerCapability('chat.handle', { handler: async () => ({ reply: 'hi' }) });
    });
    assertEquals(await core.hasCapability('chat.handle'), true, '懒加载能补上的能力必须判为可得（否则会误拒真实可用的装配）');
    assertEquals(resolved, 1, '必须真的尝试过一次懒加载解析');
    assertEquals(await core.hasCapability('nope.missing'), false, '确实不存在的能力必须判为不可得');
  });

  runner.test('R0-110/T1-b 无对话能力时，网关文案必须说清"缺什么 + 怎么补"', async () => {
    const Gateway = await impPlugin('gateway.js');
    const saved = Gateway.core;
    try {
      Gateway.core = {
        ...quietCore,
        stateDir: '/tmp/x',
        plugins: new Map([['gateway', {}], ['config', {}]]),
        getService: (n) => (n === 'config' ? { get: () => 'base-system' } : null),
      };
      const msg = Gateway._missingChatMessage();
      assert(msg.includes('chat.handle'), `文案必须点名缺失的能力（实际：${msg}）`);
      assert(msg.includes('--scene'), `文案必须给出可执行下一步（实际：${msg}）`);
      assert(msg.includes('base-system'), `文案必须报出当前装配（实际：${msg}）`);
      console.log(`       [实测] ${msg.slice(0, 120)}…`);
    } finally { Gateway.core = saved; }
  });

  // ── T3：运行期记录必须自证身份 ────────────────────────────────────────
  runner.test('R0-110/T3-a 运行期记录必须自证 state dir 与存活 pid', async () => {
    const dir = tmpDir('rt');
    const rtPath = join(dir, 'gateway.runtime.json');
    const write = (obj) => writeFileSync(rtPath, JSON.stringify(obj));

    write({ port: 5555, pid: process.pid, stateDir: '/somewhere/else' });
    assertEquals(readGatewayRuntime(dir), null, '属于别的 state dir 的记录必须读不到（否则会认别人的网关）');

    write({ port: 5555, pid: 999999, stateDir: dir });
    assertEquals(readGatewayRuntime(dir), null, 'pid 已消失的记录必须读不到（陈旧记录不得当成真相）');

    write({ port: 5555, pid: process.pid, stateDir: dir });
    const ok = readGatewayRuntime(dir);
    assert(ok && ok.port === 5555, '身份相符且 pid 存活的记录必须可读');

    // 老记录（无 stateDir 字段）必须仍然可读：向后兼容，不能让升级后的 CLI 读不到旧实例。
    write({ port: 5556, pid: process.pid });
    const legacy = readGatewayRuntime(dir);
    assert(legacy && legacy.port === 5556, '无 stateDir 的历史记录必须兼容读取');
    rmSync(dir, { recursive: true, force: true });
  });

  runner.test('R0-110/T3-b `resolveGatewayPort` 不得采用别人的运行期记录', async () => {
    const dir = tmpDir('port');
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ gateway: { port: 7777 } }));
    writeFileSync(join(dir, 'gateway.runtime.json'), JSON.stringify({ port: 5555, pid: process.pid, stateDir: '/elsewhere' }));
    assertEquals(resolveGatewayPort({ stateDir: dir }), 7777, '别人的记录不得盖过本 state dir 的配置端口');
    rmSync(dir, { recursive: true, force: true });
  });
}
