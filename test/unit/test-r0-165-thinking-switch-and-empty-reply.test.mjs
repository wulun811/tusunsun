// R0-165：思考（reasoning）是**要花钱的输出**，不是"没说话也算成功"。
//
// 背景（真 key 实测，rc.12）：接一颗默认开思考的模型（LongCat 2.0 / DeepSeek V4.1 Flash）时，
// 把预算压到 48 token 会得到上游 `finish_reason=length`、正文 0 字、思考 48 token。
// 土行孙把这一发**当成功**返回：HTTP 200、正文为空、没有 error 帧、没有 finish_reason。
// 用户看到"正在思考…"转完之后什么都没有，而日志里一点线索都没有。
//
// 本文件钉住四件事，每一条都对应一个能复现的失败形态：
//   A1 `_parseApiResult` 不再丢 `reasoning_content` / `reasoning_tokens`
//   A2 usage 明细：`completion_tokens_details.reasoning_tokens` 一路透到 OpenAI 兼容面，
//      且 total **不重复计入**（reasoning 是 completion 的子集，不是额外开销）
//   A3 流里只有思考、没有正文 ⇒ 必须 `error:true`，不许静默返回空串
//   A4 `model.thinking` / `TUSUNSUN_MODEL_THINKING` 真的生效（写坏即报错；缺省时请求体里
//      **不得**多出 thinking 字段 —— 未配置的部署逐字节不变）
import { createServer } from 'node:http';
import { TestRunner, assert, assertEquals } from '../harness.mjs';
import ModelPlugin from '../../plugins/model-openai.js';
import Haotian from '../../plugins/haotian-lite.js';
import ConfigPlugin, { DEFAULT_CONFIG } from '../../plugins/config.js';

// 插件模块默认导出的是**单例**。验收用例要反复换 core 桩，所以用原型造一个干净的实例，
// 不碰单例上的运行期状态（否则用例之间会互相串味）。
function bareInstance(singleton) {
  return Object.create(Object.getPrototypeOf(singleton));
}

/** 起一个只会吐 SSE 的假上游；回调拿到端口和每次请求的原始 body。 */
async function withSse(frames, fn) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push(body);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(port, seen);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function drain(gen) {
  const out = [];
  for await (const c of gen) out.push(c);
  return out;
}

function freshModel(port) {
  const model = bareInstance(ModelPlugin);
  model.core = { emit() {}, emitFast() {}, log() {} };
  return {
    model,
    cfg: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'unit-test-key', model: 'stub-model' },
    messages: [{ role: 'user', content: 'ping' }],
  };
}

const contentFrame = { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] };

/** 只思考、不说话的流：reasoning 帧 + stop，正文一个字都没有。 */
const reasoningOnlyFrames = [
  { choices: [{ index: 0, delta: { reasoning_content: '先想一下' } }] },
  { choices: [{ index: 0, delta: { reasoning_content: '再想一下' } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
];

/** setup/exports 由 test/run-all.mjs 约定；文件名决定在报告里的位置。 */
export async function setup(runner) {
  runner.test('R0-165/A1 非流式解析不再丢 reasoning_content 与 reasoning_tokens', () => {
    const parsed = ModelPlugin._parseApiResult(200, JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '', reasoning_content: '想了很久' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 10, completion_tokens: 30, total_tokens: 40, completion_tokens_details: { reasoning_tokens: 28 } },
    }));
    assertEquals(parsed.reasoning_content, '想了很久',
      'reasoning_content 必须留在结果里：否则"只有思考"与"内容为空"在返回值上无法区分');
    assertEquals(parsed.usage.reasoningTokens, 28, 'reasoning_tokens 必须透出，否则思考花了多少预算不可观测');
    assertEquals(parsed.usage.outputTokens, 30, 'outputTokens 保持上游口径（reasoning 已含在其中）');
    console.log('       [实测] content="" + reasoning_content="想了很久" ⇒ 两项都在，usage.reasoningTokens=28');
  });

  runner.test('R0-165/A2 usage 明细不透不造：没报 reasoning 就不编字段，报了也不重复计入 total', () => {
    const plain = ModelPlugin._parseApiResult(200, JSON.stringify({
      choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }));
    assertEquals('reasoningTokens' in plain.usage, false, '上游没报 reasoning 时不得凭空造字段（N 与 0 是两回事）');

    const h = bareInstance(Haotian);
    const one = h._openAIUsage({ inputTokens: 10, outputTokens: 100, reasoningTokens: 95 });
    assertEquals(one.prompt_tokens, 10, 'prompt_tokens 原样');
    assertEquals(one.completion_tokens, 100, 'completion_tokens 原样（含思考）');
    assertEquals(one.total_tokens, 110, 'total 不得把 reasoning 再加一遍：它是 completion 的子集');
    assertEquals(one.completion_tokens_details.reasoning_tokens, 95, '明细必须透到 OpenAI 兼容面');

    const merged = h._mergeUsage(one, { inputTokens: 1, outputTokens: 5, reasoningTokens: 3 });
    assertEquals(merged.completion_tokens_details.reasoning_tokens, 98, '多轮/多工具必须累加，否则长任务只看到最后一轮');
    assertEquals(merged.total_tokens, 116, '累加口径与单项一致');
    console.log('       [实测] reasoning=95/100 透出且 total 不重复；合并后 98/116');
  });

  runner.test('R0-165/A3 流里只有思考、正文为空 ⇒ 必须报错，不许静默返回空串', async () => {
    await withSse(reasoningOnlyFrames, async (port, seen) => {
      const { model, cfg, messages } = freshModel(port);
      const chunks = await drain(model.streamChatWithConfig(cfg, messages, []));
      assertEquals(seen.length, 1, '只思考的流不该被当成"空流"重试：上游确实吐了东西，重试只是再烧一遍');
      const errors = chunks.filter((c) => c.error);
      assertEquals(errors.length, 1, `只有思考的流必须产出一条 error 帧，实际 ${errors.length} 条：` + JSON.stringify(chunks).slice(0, 240));
      assert(/reasoning-only/.test(errors[0].content || ''), '错误文案要点名 reasoning-only，用户才知道该抬预算还是关思考');
      assertEquals(chunks.some((c) => !c.error && c.content), false,
        '不得把空正文当正常内容发给调用方 —— 那正是"HTTP 200 + 什么都没发生"的来源');
      console.log('       [实测] 2 帧思考 + finish=stop，正文 0 字 ⇒ 1 条 error 帧（reasoning-only），0 条正文帧');
    });
  });

  runner.test('R0-165/A4 思考之后说了话 ⇒ 照常放行，不许误报', async () => {
    const frames = [
      { choices: [{ index: 0, delta: { reasoning_content: '想一下' } }] },
      contentFrame,
    ];
    await withSse(frames, async (port) => {
      const { model, cfg, messages } = freshModel(port);
      const chunks = await drain(model.streamChatWithConfig(cfg, messages, []));
      assertEquals(chunks.filter((c) => c.error).length, 0, '有正文时不得报错（否则把能用的模型判成坏的）');
      assertEquals(chunks.filter((c) => c.content).map((c) => c.content).join(''), 'ok', '正文必须完整送到调用方');
      assert(chunks.some((c) => c.reasoning), '思考帧仍要透传 —— 错的是"只有思考当成功"，不是思考本身');
      console.log('       [实测] 1 帧思考 + 正文 ok ⇒ 0 条 error，正文完整，思考帧保留');
    });
  });

  runner.test('R0-165/A5 model.thinking 真的上线；不配时请求体不得多出字段', async () => {
    await withSse([contentFrame], async (port, seen) => {
      const { model, cfg, messages } = freshModel(port);
      await drain(model.streamChatWithConfig(cfg, messages, [], { thinking: { type: 'disabled' } }));
      await drain(model.streamChatWithConfig(cfg, messages, []));
      assertEquals(seen.length, 2, '两次调用各发一次请求');
      const withThinking = JSON.parse(seen[0]);
      const without = JSON.parse(seen[1]);
      assertEquals(withThinking.thinking?.type, 'disabled', '配了就必须真的到线上（否则又是"接口存在但不生效"）');
      assertEquals('thinking' in without, false, '未配置时请求体里不得多出 thinking 字段：旧部署逐字节不变');
      console.log('       [实测] 传 opts.thinking ⇒ body.thinking={"type":"disabled"}；不传 ⇒ body 无 thinking 键');
    });
  });

  runner.test('R0-165/A6 TUSUNSUN_MODEL_THINKING 写对了生效、写坏了启动即报错', () => {
    const savedData = ConfigPlugin.data;
    const savedEnv = process.env.TUSUNSUN_MODEL_THINKING;
    try {
      ConfigPlugin.data = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      process.env.TUSUNSUN_MODEL_THINKING = '{"type":"disabled"}';
      ConfigPlugin.applyEnvOverrides();
      assertEquals(ConfigPlugin.data.model.thinking?.type, 'disabled',
        '纯 env 部署必须能表达思考开关（容器/CI 不该被迫改 config.json）');

      process.env.TUSUNSUN_MODEL_THINKING = '{not json';
      let msg = '(没有抛错)';
      try { ConfigPlugin.applyEnvOverrides(); } catch (err) { msg = err.message; }
      assert(/TUSUNSUN_MODEL_THINKING 不是合法 JSON/.test(msg),
        `写坏必须启动即失败并点名变量，实际：${msg}`);
      console.log('       [实测] 合法 JSON 生效；非法 JSON ⇒ 抛错点名 TUSUNSUN_MODEL_THINKING');
    } finally {
      ConfigPlugin.data = savedData;
      if (savedEnv === undefined) delete process.env.TUSUNSUN_MODEL_THINKING;
      else process.env.TUSUNSUN_MODEL_THINKING = savedEnv;
    }
  });

  runner.test('R0-165/A7 haotian-lite 把 model.thinking 传进模型层（否则那层透传是死代码）', async () => {
    const h = bareInstance(Haotian);
    let captured = 'NOT_CALLED';
    h.core = {
      get: (k) => (k === 'model.thinking' ? { type: 'disabled' } : undefined),
      getService: (name) => (name === 'model' ? {
        async *streamChatTier(tier, messages, tools, opts) { captured = opts; yield { content: 'hi' }; },
      } : null),
      emitFast() {},
    };

    const first = await h._streamLoop([], [], 'sess-1', null, [], 'trace-1', null);
    assertEquals(captured?.thinking?.type, 'disabled', '配了 model.thinking 却没传给 streamChatTier ⇒ 开关永远是摆设');
    assertEquals(first.content, 'hi', '正文照旧');

    h.core.get = () => undefined;
    await h._streamLoop([], [], 'sess-2', null, [], 'trace-2', null);
    assertEquals(captured, undefined, '没配时连 opts 都不该给：模型层收到 undefined 才走默认分支');
    console.log('       [实测] model.thinking 已进 streamChatTier 的 opts；未配置时 opts=undefined');
  });
}
