// R0-166：rc.13 的 reasoning-only 守卫，被它自己写的「限长提示」绕过去了。
//
// 专家独立复审（R23 反例合集）在**原始 SSE** 上复现了两条，我先把它们钉在这里：
//   R23-01 `finish_reason=length` + 只有思考：先走续写分支 —— 5 次请求、5 条空 assistant
//          进历史、一次正文都没有，最后只回一句「[提示：回复已达到最大长度限制]」，
//          `error` 帧 0 条。而 rc.13 的承诺恰恰是「这种形态要显式报错」。
//   R23-02 `content="  "`（纯空白）被 `if (delta?.content)` 当成正文，`sawContent=true`。
//
// 根因是**一个变量替两个事实代签**：`sawContent` 既当「别叠 error 帧」又当「有答案」。
// 现在拆成三个互不代签的事实位：
//   · answerChars    累计正文里的**非空白字符数** —— 只由真实 content 写；提示/诊断/reasoning 都不写
//   · roundAnswer    本轮的非空白字符数 —— 只决定「还要不要续写」
//   · reasoningChars 思考字符数 —— 只决定文案（思考吃预算 / 上游吐空白）
//
// T* 走流式（HTTP/SSE），M* 走非流式（JSON）：两条路径必须同判，否则用户换个配置就换个结论。
import { createServer } from 'node:http';
import { TestRunner, assert, assertEquals } from '../harness.mjs';
import ModelPlugin from '../../plugins/model-openai.js';

// 插件模块默认导出的是**单例**：用原型造干净实例，别让用例之间互相串味。
function bareInstance(singleton) {
  return Object.create(Object.getPrototypeOf(singleton));
}

/** 按脚本应答的假上游：第 N 次请求回 rounds[min(N, 末位)]，顺便记下每次的原始 body。 */
async function scriptedSse(rounds, fn) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const frames = rounds[Math.min(seen.length, rounds.length - 1)];
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

/** 非流式假上游：整包 JSON。同样记请求数，用来验证「不重试」这条。 */
async function scriptedJson(payloads, fn) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const payload = payloads[Math.min(seen.length, payloads.length - 1)];
      seen.push(body);
      const text = JSON.stringify(payload);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
      res.end(text);
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

function freshModel(port, events = []) {
  const model = bareInstance(ModelPlugin);
  model.core = {
    emit: (name, data) => { events.push({ name, data }); },
    emitFast() {},
    log() {},
    get: () => undefined,
    getService: () => null,
  };
  return {
    model,
    events,
    cfg: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'unit-test-key', model: 'stub-model' },
    messages: [{ role: 'user', content: 'ping' }],
  };
}

const textOf = (chunks) => chunks.filter((c) => c.content && !c.error).map((c) => c.content).join('');
const errorsOf = (chunks) => chunks.filter((c) => c.error);

/** setup 由 test/run-all.mjs 约定；文件名决定在报告里的位置。 */
export async function setup(runner) {
  runner.test('R0-166/T1 只有思考 + finish=length ⇒ 一次请求就具名报错，不许 5 轮空转后交提示', async () => {
    const rounds = [[{ choices: [{ index: 0, delta: { reasoning_content: '想' }, finish_reason: 'length' }] }]];
    const events = [];
    await scriptedSse(rounds, async (port, seen) => {
      const { model, cfg, messages } = freshModel(port, events);
      const chunks = await drain(model.streamChatWithConfig(cfg, messages, [], { maxTokens: 48 }));
      assertEquals(seen.length, 1,
        `只有思考的 length 不是「被截断的答案」，续写只是同一发子弹；实际打了 ${seen.length} 次请求`);
      const errors = errorsOf(chunks);
      assertEquals(errors.length, 1, `必须且只能有一条 error 帧，实际 ${errors.length}：` + JSON.stringify(chunks).slice(0, 240));
      assert(/reasoning-only/.test(errors[0].content || ''), '文案要点名 reasoning-only，用户才知道该抬预算还是关思考');
      assertEquals(chunks.some((c) => !c.error && c.content), false,
        '限长提示是运行时诊断，不能当正文交给调用方 —— 那正是 R23-01 的「假成功」');
      console.log('       [实测] 1 帧思考 + finish=length ⇒ 1 次请求、1 条 error、0 条正文帧');
    });
    const resp = events.filter((e) => e.name === 'llm.response');
    assertEquals(resp.length, 1, '遥测只发一条 llm.response');
    assertEquals(resp[0].data.finishReason, 'length', 'finish_reason 仍要如实上报 length，别为了好看改成 stop');
  });

  runner.test('R0-166/T2 正文被截断 ⇒ 续写仍要能接上（不许把整条能力一起关掉）', async () => {
    const rounds = [
      [{ choices: [{ index: 0, delta: { content: '前半' }, finish_reason: 'length' }] }],
      [{ choices: [{ index: 0, delta: { content: '后半' }, finish_reason: 'stop' }] }],
    ];
    await scriptedSse(rounds, async (port, seen) => {
      const { model, cfg, messages } = freshModel(port);
      const chunks = await drain(model.streamChatWithConfig(cfg, messages, []));
      assertEquals(seen.length, 2, '有正文的截断必须续写一次，否则长回答永远只有前半段');
      assertEquals(errorsOf(chunks).length, 0, '续写成功不该报错');
      assertEquals(textOf(chunks), '前半后半', '两轮正文都要送到调用方');
      assert(JSON.parse(seen[1]).messages.some((m) => m.role === 'assistant' && m.content === '前半'),
        '续写请求要带上一轮已产出的正文（空 assistant 是另一条缺陷）');
      console.log('       [实测] 截断 + 续写成功 ⇒ 2 次请求、0 error、正文接成「前半后半」');
    });
  });

  runner.test('R0-166/T3 已有正文后再只剩思考 ⇒ 保留正文 + 截断说明，0 error 且不空转到第 5 轮', async () => {
    const rounds = [
      [{ choices: [{ index: 0, delta: { content: '部分答案' }, finish_reason: 'length' }] }],
      [{ choices: [{ index: 0, delta: { reasoning_content: '又想了很久' }, finish_reason: 'length' }] }],
    ];
    await scriptedSse(rounds, async (port, seen) => {
      const { model, cfg, messages } = freshModel(port);
      const chunks = await drain(model.streamChatWithConfig(cfg, messages, []));
      assertEquals(seen.length, 2, `本轮没有正文就不该再续写；实际打了 ${seen.length} 次（旧逻辑会空转到 5 次）`);
      assertEquals(errorsOf(chunks).length, 0, '已有正文时截断是「部分答案」，不是失败');
      const text = textOf(chunks);
      assert(/部分答案/.test(text), '已产出的正文必须保留，不许连正文一起丢掉');
      assert(/最大长度限制/.test(text), '截断要说明，否则用户以为这就是全部');
      console.log('       [实测] 正文 + 截断，次轮只剩思考 ⇒ 2 次请求、正文保留 + 提示 1 条、0 error');
    });
  });

  runner.test('R0-166/T4 纯空白正文 + 思考 ⇒ 仍算没回答（空白不是「说了话」）', async () => {
    const rounds = [[{ choices: [{ index: 0, delta: { reasoning_content: '想', content: '  ' }, finish_reason: 'stop' }] }]];
    await scriptedSse(rounds, async (port, seen) => {
      const { model, cfg, messages } = freshModel(port);
      const chunks = await drain(model.streamChatWithConfig(cfg, messages, []));
      assertEquals(seen.length, 1, '纯空白不是流中断，没必要重试');
      const errors = errorsOf(chunks);
      assertEquals(errors.length, 1, `空白正文必须报错，实际 ${errors.length} 条 error；R23-02 就是这里漏的`);
      assert(/reasoning-only/.test(errors[0].content || ''), '有思考、没可读正文 ⇒ 走 reasoning-only 文案');
      assertEquals(chunks.filter((c) => c.content && !c.error).every((c) => !String(c.content).trim()), true,
        '空白 chunk 可以透传（表现策略），但最终判定不得把它算成正文');
      console.log('       [实测] reasoning + content="  " + stop ⇒ 1 条 error，空白不算回答');
    });
  });

  runner.test('R0-166/T5 纯空白正文、没有思考 ⇒ 点名「空白正文」，不要误指成思考吃预算', async () => {
    const rounds = [[{ choices: [{ index: 0, delta: { content: ' \n\t ' }, finish_reason: 'stop' }] }]];
    await scriptedSse(rounds, async (port) => {
      const { model, cfg, messages } = freshModel(port);
      const chunks = await drain(model.streamChatWithConfig(cfg, messages, []));
      const errors = errorsOf(chunks);
      assertEquals(errors.length, 1, '空白正文不是成功');
      assert(/空白正文/.test(errors[0].content || ''), `文案要说清是空白正文，实际：${errors[0].content}`);
      assertEquals(/reasoning-only/.test(errors[0].content || ''), false,
        '这里根本没有思考，指向 reasoning 会把人引到错的旋钮上');
      console.log('       [实测] 纯空白 + stop（无思考）⇒ 1 条 error，文案点名「空白正文」');
    });
  });

  runner.test('R0-166/T6 正常正文 + stop ⇒ 0 error、正文完整、思考帧保留（不许误伤）', async () => {
    const rounds = [[
      { choices: [{ index: 0, delta: { reasoning_content: '先想' } }] },
      { choices: [{ index: 0, delta: { content: '真的答案' }, finish_reason: 'stop' }] },
    ]];
    await scriptedSse(rounds, async (port) => {
      const { model, cfg, messages } = freshModel(port);
      const chunks = await drain(model.streamChatWithConfig(cfg, messages, []));
      assertEquals(errorsOf(chunks).length, 0, '有正文时不得报错（否则把能用的模型判成坏的）');
      assertEquals(textOf(chunks), '真的答案', '正文必须完整');
      assert(chunks.some((c) => c.reasoning), '思考帧仍要透传 —— 错的是「只有思考当成功」，不是思考本身');
      console.log('       [实测] 思考 + 正文 + stop ⇒ 0 error，正文完整，思考帧保留');
    });
  });

  runner.test('R0-166/T7 前置空白 chunk 不许触发报错 —— 判据在轮结束时的累计值', async () => {
    const rounds = [[
      { choices: [{ index: 0, delta: { content: '  ' } }] },
      { choices: [{ index: 0, delta: { content: '\n' } }] },
      { choices: [{ index: 0, delta: { content: 'ab' }, finish_reason: 'stop' }] },
    ]];
    await scriptedSse(rounds, async (port) => {
      const { model, cfg, messages } = freshModel(port);
      const chunks = await drain(model.streamChatWithConfig(cfg, messages, []));
      assertEquals(errorsOf(chunks).length, 0, '缩进/换行是正常输出，不能见空就报错');
      assertEquals(textOf(chunks), '  \nab', '空白帧照旧透传，正文一个字符都不许丢');
      console.log('       [实测] 空白帧在前、正文在后 ⇒ 0 error，正文拼成「  \\nab」');
    });
  });

  runner.test('R0-166/T8 后到的 usage 帧不得把已确认的 length 抹掉', async () => {
    const rounds = [[
      { choices: [{ index: 0, delta: { reasoning_content: '想' }, finish_reason: 'length' }] },
      { choices: [], usage: { prompt_tokens: 9, completion_tokens: 48, total_tokens: 57, completion_tokens_details: { reasoning_tokens: 48 } } },
    ]];
    const events = [];
    await scriptedSse(rounds, async (port) => {
      const { model, cfg, messages } = freshModel(port, events);
      const chunks = await drain(model.streamChatWithConfig(cfg, messages, []));
      const usage = chunks.filter((c) => c.usage);
      assertEquals(usage.length, 1, 'usage 必须透出一次');
      assertEquals(usage[0].usage.reasoningTokens, 48, '思考预算明细不能丢（rc.13 的能力）');
      assertEquals(errorsOf(chunks).length, 1, 'include_usage 的收尾帧不该改变「只有思考」的判定');
      console.log('       [实测] length 帧 + choices:[] 的 usage 帧 ⇒ usage 透出且仍判 length');
    });
    const resp = events.filter((e) => e.name === 'llm.response');
    assertEquals(resp[0].data.finishReason, 'length', '收尾帧 choices:[] 不得把 length 擦成 null —— 事实不能被没有它的回调擦掉');
  });

  runner.test('R0-166/M1 非流式：只有思考 + stop ⇒ 一次就具名报错，不许 3 次重试', async () => {
    const payloads = [{ choices: [{ message: { role: 'assistant', content: '', reasoning_content: '想了' }, finish_reason: 'stop' }] }];
    await scriptedJson(payloads, async (port, seen) => {
      const { model, cfg, messages } = freshModel(port);
      const r = await model.callWithConfig(cfg, messages, []);
      assertEquals(seen.length, 1, `同样的提示词重发不会变出正文；实际打了 ${seen.length} 次`);
      assertEquals(r.error, true, '失败必须自证 error:true，不能伪装成有内容的成功');
      assert(/reasoning-only/.test(r.content || ''), '与流式同一句话：换配置不该换结论');
      console.log('       [实测] 非流式 reasoning-only ⇒ 1 次请求、error:true、文案 reasoning-only');
    });
  });

  runner.test('R0-166/M2 非流式：纯空白正文 ⇒ 点名空白正文（不是空回复重试）', async () => {
    const payloads = [{ choices: [{ message: { role: 'assistant', content: '   ' }, finish_reason: 'stop' }] }];
    await scriptedJson(payloads, async (port, seen) => {
      const { model, cfg, messages } = freshModel(port);
      const r = await model.callWithConfig(cfg, messages, []);
      assertEquals(seen.length, 1, '空白不是网络抖动，重试三次只是把同样的空结果拿三遍');
      assertEquals(r.error, true, '空白正文必须自证失败');
      assert(/空白正文/.test(r.content || ''), `文案要点名空白正文，实际：${r.content}`);
      console.log('       [实测] 非流式 content="   " ⇒ 1 次请求、error:true、文案「空白正文」');
    });
  });

  runner.test('R0-166/M3 非流式：只有思考 + length ⇒ 预算耗尽，且 usage 明细保留（rc.13 回归）', async () => {
    const payloads = [{
      choices: [{ message: { role: 'assistant', content: '', reasoning_content: '想了很久' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 9, completion_tokens: 48, total_tokens: 57, completion_tokens_details: { reasoning_tokens: 48 } },
    }];
    await scriptedJson(payloads, async (port, seen) => {
      const { model, cfg, messages } = freshModel(port);
      const r = await model.callWithConfig(cfg, messages, []);
      assertEquals(seen.length, 1, '预算耗尽重试无益');
      assertEquals(r.error, true, '失败必须自证');
      assertEquals(r.finishReason, 'length', 'finishReason 要如实带出来');
      assertEquals(r.usage?.reasoningTokens, 48, '报错路径也要留下思考预算明细，否则没法解释「为什么没话说」');
      console.log('       [实测] 非流式 reasoning+length ⇒ 1 次请求、error:true、usage.reasoningTokens=48');
    });
  });

  runner.test('R0-166/M4 非流式：有正文 ⇒ 正常返回，不许误报', async () => {
    const payloads = [{ choices: [{ message: { role: 'assistant', content: '真的答案' }, finish_reason: 'stop' }] }];
    await scriptedJson(payloads, async (port, seen) => {
      const { model, cfg, messages } = freshModel(port);
      const r = await model.callWithConfig(cfg, messages, []);
      assertEquals(seen.length, 1, '一次成功不该重试');
      assertEquals(r.error, undefined, '成功不得带 error 标记');
      assertEquals(r.content, '真的答案', '正文原样');
      console.log('       [实测] 非流式正例 ⇒ 0 error、正文原样');
    });
  });
}
