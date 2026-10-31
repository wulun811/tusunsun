// R0-023（rc.15）：SSE 解析的五条外围合同（S2 / H1 / H2 / H3 / H4）。
//
// 专家矩阵把它们归成一组不是偶然：五条病都在同一个循环里，而且**同一段帧处理写了两份**——
// 循环里一份、收尾 flush 里手抄一份。两份会漂：收尾那份少了 `tool_calls`，
// 于是"最后一帧没有空行"的上游（实测有）会把工具调用静默吞掉，客户端看到的是"模型没说话"。
//
// 本文件钉住：
//   /1  H1 尾帧（无结尾空行）里的 tool_calls 不得丢
//   /2  H1 尾帧里的 usage 不得丢（回归位：这条本来就对，别在重构里弄坏）
//   /3  H3 `data:{…}` 与 `data: {…}` 行为相同（SSE 规范里空格是可选的）
//   /4  H3 心跳/注释行与空行安全：不产生事件、不报错
//   /5  H4 多字节字符被切在两个 chunk 之间不得变成 U+FFFD
//   /6  H4 JSON 结构本身被切开也要能拼回（切在键名中间）
//   /7  S2 空流（只有 [DONE]）必须具名报错，且不得抛 ReferenceError
//   /8  H2 中途断流：error:true + partial，且**不得**把半截正文报成完成
//   /9  S2 重试次数受控：上限到了就停，不无限重来
//
// 全部用真实 http 假上游 + 真实 socket 分片：不用字符串直接喂解析器。
// 「任意分片等价」只有在真的被分片时才成立，把整包字符串喂进去测不到任何东西。
import { createServer } from 'node:http';
import { TestRunner, assert, assertEquals } from '../harness.mjs';
import ModelPlugin from '../../plugins/model-openai.js';

/** 插件模块默认导出单例；验收用例要反复换 core 桩，所以用原型造干净实例。 */
function bareInstance(singleton) {
  return Object.create(Object.getPrototypeOf(singleton));
}

async function drain(gen) {
  const out = [];
  for await (const c of gen) out.push(c);
  return out;
}

/**
 * 起一个只会吐 SSE 字节的假上游。
 * @param {object} spec
 * @param {Array<string|Buffer>} spec.chunks 按顺序写出的字节块（边界由用例决定）
 * @param {number} spec.status HTTP 状态码（非 200 走错误分支）
 * @param {boolean} spec.truncate 声明比实际更长的 Content-Length，触发"提前结束"
 */
async function withRawSse(spec, fn) {
  const seen = [];
  const { chunks = [], status = 200, truncate = false } = spec;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      seen.push(body);
      if (status !== 200) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'upstream boom' } }));
        return;
      }
      const payload = Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(String(c), 'utf8'))));
      // 头只能写一次：写两次会 ERR_HTTP_HEADERS_SENT，把这个用例进程整个带倒。
      // truncate：把 Content-Length 报大 64 字节再 end —— 客户端拿到已写出的字节后
      // 发现字节数不够。这是**确定性**的"中途断流"，不依赖 socket 是否被 RST。
      res.writeHead(200, truncate
        ? { 'Content-Type': 'text/event-stream', 'Content-Length': payload.length + 64 }
        : { 'Content-Type': 'text/event-stream' });
      res.socket?.setNoDelay?.(true);
      // **逐块写 + 等上一块真的落盘**：chunked 下每个 write 是一个独立 chunk，
      // 但客户端 `for await` 的切分粒度是 TCP 读，不是 chunk 边界 —— 所以还要隔开一点时间。
      // 直接 concat 成一块写出去等于把"任意分片"这条用例测掉了（第一版夹具就是这么假绿的）。
      for (const chunk of chunks) {
        await new Promise((resolve) => { res.write(chunk, resolve); });
        if (chunks.length > 1) await new Promise((r) => setTimeout(r, 10));
      }
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

/** 记下所有遥测事件：'到底报了什么结局'必须以事件为准，不以"调用方觉得"为准。 */
function makeModel(port, events) {
  const model = bareInstance(ModelPlugin);
  model.core = {
    emit(event, payload) { events.push({ event, payload }); },
    emitFast(event, payload) { events.push({ event, payload }); },
    log() {},
  };
  return { model, cfg: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'unit-test-key', model: 'stub-model' } };
}

const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const choicesDelta = (delta, finish) => ({ choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }] });

async function run(port, events) {
  const { model, cfg } = makeModel(port, events);
  return drain(model.streamChatWithConfig(cfg, [{ role: 'user', content: 'ping' }], []));
}

/** 临时改环境变量并还原：`STREAM_ATTEMPTS` 决定重试上限，用例里要按需压到 1 才跑得快。 */
async function withEnv(kv, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(kv)) { saved[k] = process.env[k]; process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

const TOOL_FRAME = {
  choices: [{
    index: 0,
    delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }] },
    finish_reason: 'tool_calls',
  }],
};

export async function setup(runner) {
  runner.test('R0-023/1 尾帧没有结尾空行时，tool_calls 不得丢（H1）', async () => {
    const events = [];
    // 关键：**不写**结尾的 \n\n。上游把最后一帧写满就关连接，尾帧落在 buffer 里。
    const tail = `data: ${JSON.stringify(TOOL_FRAME)}`;
    await withEnv({ TUSUNSUN_STREAM_ATTEMPTS: '1' }, () => withRawSse({ chunks: [tail] }, async (port) => {
      const out = await run(port, events);
      const calls = out.flatMap((c) => (c.tool_calls ? [c.tool_calls] : []));
      assert(calls.length > 0,
        `尾帧里的 tool_calls 被丢了（收到的事件：${JSON.stringify(out)}）—— 客户端会看到"模型什么都没说"`);
      const tc = calls[0][0];
      // 流式路径交给上层的是 OpenAI 原生形状（`{ id, function: { name, arguments } }`），
      // 与 `_parseApiResult` 的扁平 `{ id, name, arguments }` 不同 —— 本用例只钉"没丢"，
      // 不顺手改形状（改形状是另一条契约，得先看 agent 下游怎么用）。
      const fn = tc.function ?? tc;
      assertEquals(fn.name, 'get_weather', '工具名必须完整');
      assertEquals(fn.arguments, '{"city":"北京"}', '参数必须完整（不能被截断成半截 JSON）');
      console.log('       [实测] 尾帧无空行 ⇒ tool_calls 完整送达');
    }));
  });

  runner.test('R0-023/2 尾帧里的 usage 不得丢（H1 回归位）', async () => {
    const events = [];
    const body = frame(choicesDelta({ content: 'ok' }))
      + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } })}`;
    await withRawSse({ chunks: [body] }, async (port) => {
      const out = await run(port, events);
      const usage = out.find((c) => c.usage);
      assert(usage, `尾帧 usage 丢了（收到：${JSON.stringify(out)}）`);
      assertEquals(usage.usage.inputTokens, 7, 'inputTokens 原样透出');
      assertEquals(usage.usage.outputTokens, 3, 'outputTokens 原样透出');
    });
  });

  runner.test('R0-023/3 `data:` 后面没有空格必须照样接纳（H3）', async () => {
    const events = [];
    const noSpace = `data:${JSON.stringify(choicesDelta({ content: '紧凑写法' }))}\n\n`;
    const withSpace = frame(choicesDelta({ content: '标准写法' }));
    await withRawSse({ chunks: [noSpace, withSpace] }, async (port) => {
      const out = await run(port, events);
      const text = out.map((c) => c.content || '').join('');
      assert(text.includes('紧凑写法'),
        `SSE 规范里空格是可选的；丢掉 data:{…} 等于丢掉整帧（收到：${JSON.stringify(text)}）`);
      assert(text.includes('标准写法'), '标准写法当然也要收');
    });
  });

  runner.test('R0-023/4 心跳与注释行安全：不产生事件、不报错（H3）', async () => {
    const events = [];
    const body = ':\n\n' + ': keepalive\n\n' + '\n\n' + frame(choicesDelta({ content: '正文' }, 'stop'));
    await withRawSse({ chunks: [body] }, async (port) => {
      const out = await run(port, events);
      const text = out.map((c) => c.content || '').join('');
      assertEquals(text, '正文', '注释行不得变成正文，也不得把后面的帧吃掉');
      assertEquals(out.filter((c) => c.error).length, 0, '心跳不是错误');
    });
  });

  runner.test('R0-023/5 多字节字符被切在 chunk 中间不得变成 U+FFFD（H4）', async () => {
    const events = [];
    const text = `data: ${JSON.stringify(choicesDelta({ content: '中文🙂结尾' }))}\n\n`;
    const buf = Buffer.from(text, 'utf8');
    const emojiAt = buf.indexOf(Buffer.from('🙂', 'utf8'));
    assert(emojiAt > 0, '夹具自检：得先找到表情的字节位置');
    // 切在 4 字节表情的第 1 字节之后：两半边都不是合法 UTF-8 序列。
    const chunks = [buf.subarray(0, emojiAt + 1), buf.subarray(emojiAt + 1)];
    await withRawSse({ chunks }, async (port) => {
      const out = await run(port, events);
      const got = out.map((c) => c.content || '').join('');
      assert(!got.includes('\uFFFD'), `出现替换字符：${JSON.stringify(got)} —— 逐 chunk 调 toString('utf8') 就会这样`);
      assertEquals(got, '中文🙂结尾', '整包等价的唯一判据是字节级还原，不是"看起来差不多"');
    });
  });

  runner.test('R0-023/6 JSON 结构本身被切开也要拼回（H4）', async () => {
    const events = [];
    const text = `data: ${JSON.stringify(choicesDelta({ content: '拼接成功' }))}\n\n`;
    const buf = Buffer.from(text, 'utf8');
    const at = buf.indexOf(Buffer.from('content')) + 3;   // 切在键名 "content" 中间
    assert(at > 3, '夹具自检：得先找到键名位置');
    await withRawSse({ chunks: [buf.subarray(0, at), buf.subarray(at)] }, async (port) => {
      const out = await run(port, events);
      assertEquals(out.map((c) => c.content || '').join(''), '拼接成功', '跨 chunk 的 JSON 必须能拼回');
    });
  });

  runner.test('R0-023/7 空流必须具名报错，且不得抛 ReferenceError（S2）', async () => {
    const events = [];
    await withEnv({ TUSUNSUN_STREAM_ATTEMPTS: '1' }, () => withRawSse({ chunks: ['data: [DONE]\n\n'] }, async (port) => {
      let out; let thrown = null;
      try { out = await run(port, events); } catch (err) { thrown = err; }
      assertEquals(thrown, null, `空流不得把异常抛给调用方（实测 ${thrown && thrown.name}: ${thrown && thrown.message}）`);
      const errFrames = out.filter((c) => c.error);
      assertEquals(errFrames.length, 1, `空流必须有一帧 error:true（收到：${JSON.stringify(out)}）`);
      assert(/empty stream/i.test(errFrames[0].content), `错误文案要具名到"空流"，实测：${errFrames[0].content}`);
      const resp = events.find((e) => e.event === 'llm.response');
      assert(resp, '空流也要发 llm.response 遥测，否则"什么都没发生"不可归因');
      assertEquals(resp.payload.finishReason, 'error', `遥测结局必须是 error，实测 ${resp.payload.finishReason}`);
    }));
  });

  runner.test('R0-023/8 中途断流：error:true + partial，不得把半截正文报成完成（H2）', async () => {
    const events = [];
    const body = frame(choicesDelta({ content: '说到一半' }));
    await withEnv({ TUSUNSUN_STREAM_ATTEMPTS: '1' }, () => withRawSse({ chunks: [body], truncate: true }, async (port) => {
      let out; let thrown = null;
      try { out = await run(port, events); } catch (err) { thrown = err; }
      assertEquals(thrown, null, `断流不得把异常抛给调用方（实测 ${thrown && thrown.name}: ${thrown && thrown.message}）`);
      const errFrame = out.find((c) => c.error);
      assert(errFrame, `断流必须有一帧 error:true（收到：${JSON.stringify(out)}）`);
      assert(/interrupted|断流|aborted|abort/i.test(errFrame.content),
        `错误文案要具名到"断流"，实测：${errFrame.content}`);
      const resp = events.find((e) => e.event === 'llm.response');
      assertEquals(resp.payload.finishReason, 'error',
        `断流的结局必须是 error；写 stop 等于把半截正文说成写完了（实测 ${resp.payload.finishReason}）`);
    }));
  });

  runner.test('R0-023/9 重试次数受控：上限到了就停（S2）', async () => {
    const events = [];
    await withEnv({ TUSUNSUN_STREAM_ATTEMPTS: '2' }, () => withRawSse({ chunks: [], status: 500 }, async (port, seen) => {
      const out = await run(port, events);
      assertEquals(seen.length, 2, `STREAM_ATTEMPTS=2 时应当请求恰好 2 次，实测 ${seen.length} 次`);
      const errFrames = out.filter((c) => c.error);
      assertEquals(errFrames.length, 1, '重试用尽后只报一次错，不得每一轮都吐一帧');
      assert(/500/.test(errFrames[0].content), `错误文案要带上状态码，实测：${errFrames[0].content}`);
    }));
  });
}
