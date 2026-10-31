#!/usr/bin/env node
// R23 反例探针：只有思考 / 纯空白，到底算不算「答完了」？
//
// 来源：专家独立复审（土行孙 rc.13 独立发版复审与 R23 反例合集）。他在**原始 SSE** 上复现了两条，
// 本探针把这两条连同它们的正例一起钉住 —— 拿到发行包的人可以离线复跑，不必信报告：
//   R23-01 `finish_reason=length` + 只有思考 ⇒ 旧版续写 5 轮、只回一句限长提示、`error` 0 条
//   R23-02 `content="  "` ⇒ 旧版把纯空白当成正文，`error` 0 条
//
// 用法：node test/probes/r23-reasoning-boundary.mjs [package根目录]
//   （不传则用 TT_PKG_ROOT，再不传则按本文件位置推包根）
// 退出码：0 = 符合合同；1 = 有违反（逐条打印 VIOLATION 与实测值）。
//
// 只依赖 Node 标准库与发行包的 `plugins/model-openai.js`，不联网、不需要 API key、不改任何源码。
import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = process.env.TT_PKG_ROOT || process.argv[2] || resolve(here, '../..');
const { default: modelSingleton } = await import(pathToFileURL(resolve(pkgRoot, 'plugins/model-openai.js')).href);

function modelInstance(events) {
  const m = Object.create(Object.getPrototypeOf(modelSingleton));
  m.core = {
    emit: (name, data) => events.push({ name, data }),
    emitFast() {}, log() {}, get: () => undefined, getService: () => null,
  };
  return m;
}

async function withServer(respond, fn) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { seen.push(body); respond(seen.length - 1, res); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { return await fn(server.address().port, seen); } finally { await new Promise((r) => server.close(r)); }
}

const sse = (res, frames) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`);
  res.end();
};
const jsonBody = (res, payload) => {
  const text = JSON.stringify(payload);
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
};

/** 一帧 SSE：delta + finish_reason（不传 finish_reason 就只给 delta）。 */
const f = (delta, finish) => ({ choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }] });
const text = (chunks) => chunks.filter((c) => c.content && !c.error).map((c) => c.content).join('');
const errs = (chunks) => chunks.filter((c) => c.error);

const cases = [
  {
    name: 'R23-01 reasoning-only + finish=length',
    rounds: [[f({ reasoning_content: 'thinking' }, 'length')]],
    check: ({ seen, chunks }) => {
      if (seen.length !== 1) return `打了 ${seen.length} 次请求；只有思考的 length 不是被截断的答案，续写只是同一发子弹`;
      if (errs(chunks).length !== 1) return `error 帧 ${errs(chunks).length} 条，应 1 条`;
      if (!/reasoning-only/.test(errs(chunks)[0].content || '')) return `文案没点名 reasoning-only：${errs(chunks)[0].content}`;
      if (text(chunks)) return `把提示/空白当正文交了：${JSON.stringify(text(chunks))}`;
      return null;
    },
  },
  {
    name: 'R23-02 content="  " + reasoning + stop',
    rounds: [[f({ reasoning_content: 'thinking', content: '  ' }, 'stop')]],
    check: ({ seen, chunks }) => {
      if (seen.length !== 1) return `打了 ${seen.length} 次请求，应 1 次`;
      if (errs(chunks).length !== 1) return `纯空白被当成正文（error 帧 ${errs(chunks).length} 条，应 1 条）`;
      if (text(chunks).trim()) return `非空白的正文帧不该存在：${JSON.stringify(text(chunks))}`;
      return null;
    },
  },
  {
    name: 'regression reasoning-only + stop',
    rounds: [[f({ reasoning_content: 'thinking' }, 'stop')]],
    check: ({ seen, chunks }) => (errs(chunks).length === 1 && seen.length === 1 ? null : 'reasoning-only + stop 应 1 次请求、1 条 error'),
  },
  {
    name: 'blank-only + stop（无思考）',
    rounds: [[f({ content: ' \n\t ' }, 'stop')]],
    check: ({ seen, chunks }) => {
      if (seen.length !== 1) return `打了 ${seen.length} 次请求，应 1 次`;
      if (errs(chunks).length !== 1) return `空白正文不是成功（error ${errs(chunks).length} 条）`;
      const c = errs(chunks)[0].content || '';
      if (!/空白正文/.test(c)) return `文案要说清是空白正文：${c}`;
      if (/reasoning-only/.test(c)) return '这里没有思考，指向 reasoning 会把人引到错的旋钮';
      return null;
    },
  },
  {
    name: 'positive content + stop',
    rounds: [[f({ reasoning_content: 'think' }), f({ content: 'real answer' }, 'stop')]],
    check: ({ chunks }) => {
      if (errs(chunks).length !== 0) return `有正文却报错：${errs(chunks)[0]?.content}`;
      if (text(chunks) !== 'real answer') return `正文丢了：${JSON.stringify(text(chunks))}`;
      return null;
    },
  },
  {
    name: 'positive content + length ⇒ 续写接上',
    rounds: [[f({ content: 'part one ' }, 'length')], [f({ content: 'part two' }, 'stop')]],
    check: ({ seen, chunks }) => {
      if (seen.length !== 2) return `续写次数 ${seen.length}，应 2`;
      if (errs(chunks).length !== 0) return `续写成功却报错：${errs(chunks)[0]?.content}`;
      if (text(chunks) !== 'part one part two') return `两轮正文没拼全：${JSON.stringify(text(chunks))}`;
      return null;
    },
  },
  {
    name: 'positive 已有正文后被截断 ⇒ 保留正文 + 说明、不报错',
    rounds: [[f({ content: 'partial' }, 'length')], [f({ reasoning_content: 'thinking again' }, 'length')]],
    check: ({ seen, chunks }) => {
      if (seen.length !== 2) return `第二轮没正文却继续续写（${seen.length} 次请求）`;
      if (errs(chunks).length !== 0) return `已有正文时截断是部分答案，不该报错：${errs(chunks)[0]?.content}`;
      if (!/partial/.test(text(chunks))) return '已产出的正文被丢掉了';
      if (!/最大长度限制/.test(text(chunks))) return '截断没有任何说明';
      return null;
    },
  },
  {
    name: 'finish_reason 不被后到的 usage 帧抹掉',
    rounds: [[f({ reasoning_content: 'thinking' }, 'length'), { choices: [], usage: { prompt_tokens: 9, completion_tokens: 48, total_tokens: 57, completion_tokens_details: { reasoning_tokens: 48 } } }]],
    check: ({ chunks, events }) => {
      if (!chunks.some((c) => c.usage?.reasoningTokens === 48)) return 'usage 的 reasoning_tokens 没透出';
      if (errs(chunks).length !== 1) return 'include_usage 的收尾帧改变了「只有思考」的判定';
      const resp = events.filter((e) => e.name === 'llm.response');
      if (resp[0]?.data?.finishReason !== 'length') return `遥测的 finishReason 被抹成 ${JSON.stringify(resp[0]?.data?.finishReason)}`;
      return null;
    },
  },
  {
    name: 'non-stream reasoning-only + stop',
    protocol: 'json',
    rounds: [{ choices: [{ message: { role: 'assistant', content: '', reasoning_content: 'thinking' }, finish_reason: 'stop' }] }],
    check: ({ seen, chunks }) => {
      if (seen.length !== 1) return `重试了 ${seen.length} 次；同样的提示词不会变出正文`;
      const r = chunks[0] || {};
      if (r.error !== true) return '失败没有自证 error:true';
      if (!/reasoning-only/.test(r.content || '')) return `文案与流式不一致：${r.content}`;
      return null;
    },
  },
  {
    name: 'non-stream blank content',
    protocol: 'json',
    rounds: [{ choices: [{ message: { role: 'assistant', content: '   ' }, finish_reason: 'stop' }] }],
    check: ({ seen, chunks }) => {
      if (seen.length !== 1) return `重试了 ${seen.length} 次`;
      const r = chunks[0] || {};
      if (r.error !== true) return '空白正文没有自证 error:true';
      if (!/空白正文/.test(r.content || '')) return `文案没点名空白正文：${r.content}`;
      return null;
    },
  },
];

let violations = 0;
for (const c of cases) {
  const events = [];
  const chunks = [];
  const protocol = c.protocol || 'sse';
  let seen = [];
  await withServer((i, res) => {
    const payload = c.rounds[Math.min(i, c.rounds.length - 1)];
    if (protocol === 'json') jsonBody(res, payload); else sse(res, payload);
  }, async (port, seenBodies) => {
    seen = seenBodies;
    const model = modelInstance(events);
    const cfg = { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'probe-key', model: 'probe-model' };
    const messages = [{ role: 'user', content: 'prompt' }];
    if (protocol === 'json') {
      chunks.push(await model.callWithConfig(cfg, messages, []));
    } else {
      for await (const ch of model.streamChatWithConfig(cfg, messages, [], { maxTokens: 48 })) chunks.push(ch);
    }
  });
  const bad = c.check({ seen, chunks, events });
  if (bad) violations++;
  console.log(JSON.stringify({ case: c.name, result: bad ? 'VIOLATION' : 'PASS', requests: seen.length, ...(bad ? { why: bad } : {}) }));
  if (bad) console.log(`   实测：${JSON.stringify(chunks).slice(0, 320)}`);
}
console.log(JSON.stringify({ total: cases.length, violations }));
process.exitCode = violations ? 1 : 0;
