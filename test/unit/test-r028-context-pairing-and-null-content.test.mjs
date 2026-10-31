// R0-028（rc.15）：`content:null` 是常态，裁剪不得拆散 tool 配对（专家 rc.14 复审 S3 / S4）。
//
// 两条都不是"算错了"，而是**一个层回答了不属于它的问题**：
//
//   S3  上游在强制 `tool_choice` 时回 `content:null` + `tool_calls`，这是**正常响应**。
//       `_parseApiResult` 原样透出 null ⇒ `call()` 里的 `result.content.slice(0,100)`（打遥测用）
//       抛 TypeError ⇒ 被自己的 catch 接住，产出 `[API Error] Cannot read properties of null`。
//       于是"打了个遥测"把一次成功改写成失败；`_extractSummary` 再把这句错误串当摘要存下来，
//       之后每一轮都以 `## Conversation Summary` 注入 system prompt —— 模型会认为上下文里
//       真的有一条 `[API Error]`。**正文为空**与**调用失败**是两件事，不能由 `.slice` 来判。
//
//   S4  默认策略就是 `sliding`。`_slidingWindow` / `_splitForTokens` 逐条按 token 收，
//       没有配对概念 ⇒ 切点落在 `assistant(tool_calls)` 与它的 `tool` 结果之间，
//       上游收到一条无主的 tool 消息 ⇒ HTTP 400。`_lib/context-budget.js` 里**已经有**
//       `groupIntoTurns` 并写明理由，但只在"声明了 Cell 预算"的会话上生效 ——
//       同一条规则只守住了一个入口。
//
// 本文件钉住：
//   /1  解析层归一 `content: null → ''`，tool_calls 与 finishReason 原样保留
//   /2  `call()` 不得因为正文为空而把成功改写成 `[API Error]`（真的打一次 `call()`）
//   /3  摘要链路不得把 `error:true` 的错误串当摘要（否则它会被注入 system prompt）
//   /4  反向判据：正常正文 / tool_calls 里的摘要仍然取得到（防"一律返回空串"）
//   /5  `_slidingWindow` 扫预算：不产生孤儿 tool 结果
//   /6  `_splitForTokens` 扫预算：不产生孤儿 tool 结果，且不丢消息
//   /7  反向判据：装得下就原样返回，装不下才裁（防"干脆不裁了"）
import { assert, assertEquals } from '../harness.mjs';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** 孤儿 tool 结果：`role:'tool'` 但前面没有带这个 `tool_call_id` 的 assistant。 */
function orphanToolResults(list) {
  const declared = new Set();
  const bad = [];
  for (const m of list || []) {
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) if (tc?.id) declared.add(tc.id);
    }
    if (m?.role === 'tool' && !declared.has(m.tool_call_id)) bad.push(m.tool_call_id ?? '(missing id)');
  }
  return bad;
}

/** 四轮"用户提问 → 要工具 → 工具结果 → 回答"的历史，system 在最前。 */
function toolHeavyHistory() {
  const h = [{ role: 'system', content: 'SYS '.repeat(20) }];
  for (let r = 0; r < 4; r++) {
    h.push({ role: 'user', content: `U${r} `.repeat(40) });
    h.push({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: `call_${r}`, name: 'tool-read', arguments: `{"path":"f${r}.js"}` }],
    });
    h.push({ role: 'tool', tool_call_id: `call_${r}`, content: `RESULT_${r} `.repeat(30) });
    h.push({ role: 'assistant', content: `A${r} `.repeat(40) });
  }
  return h;
}

/** 上游在强制 tool_choice 时的正常响应：正文为空，工具参数在 tool_calls 里。 */
const NULL_CONTENT_BODY = {
  choices: [{
    finish_reason: 'tool_calls',
    message: {
      content: null,
      tool_calls: [{
        id: 'call_null_1',
        type: 'function',
        function: { name: 'tool-read', arguments: '{"path":"a.js"}' },
      }],
    },
  }],
  usage: { prompt_tokens: 11, completion_tokens: 7 },
};

export async function setup(runner) {
  const { default: modelSingleton } = await import('../../plugins/model-openai.js');
  const ModelProto = Object.getPrototypeOf(modelSingleton);
  const { default: cmSingleton } = await import('../../plugins/context-manager.js');
  const CmProto = Object.getPrototypeOf(cmSingleton);

  /** 一个只够 `call()` 跑起来的宿主：配置面 + 遥测面，请求本身换成解析好的结果。 */
  function bareModel(body) {
    const plugin = Object.create(ModelProto);
    plugin.core = {
      getService: (name) => {
        if (name === 'config') {
          const data = { model: { model: 'fake-model', apiKey: 'k', baseUrl: 'https://example.invalid/v1' } };
          return { data, get: (p, dflt) => (p === 'model.baseUrl' ? data.model.baseUrl : p === 'model.apiKey' ? 'k' : p === 'model.model' ? 'fake-model' : dflt) };
        }
        if (name === 'secrets') return { get: () => 'k' };
        return null;
      },
      get: () => undefined,
      emit: () => {},
      log: () => {},
    };
    // `_request` 正常返回的**已经是解析后的对象**（`_handleResponse` → `_parseApiResult`），
    // 所以这里让桩走真的解析层 —— 否则测到的不是修复点。
    plugin._request = async () => plugin._parseApiResult(200, JSON.stringify(body));
    return plugin;
  }

  function bareContext(modelStub) {
    const cm = Object.create(CmProto);
    cm.core = {
      getService: (name) => (name === 'model' ? modelStub : null),
      get: () => undefined,
      emit: () => {},
      log: () => {},
      registerService: () => {},
    };
    cm._summaries = new Map();
    cm.reserveTokens = 500;
    cm.maxTokens = 8000;
    cm._autoCompactThreshold = 0.9;
    return cm;
  }

  // ══ S3 主干：解析层必须把"正文为空"归一成空串 ═════════════════════
  runner.test('R0-028/1 content:null + tool_calls 是正常响应，正文归一为空串且工具原样保留', async () => {
    const r = bareModel(NULL_CONTENT_BODY)._parseApiResult(200, JSON.stringify(NULL_CONTENT_BODY));
    assertEquals(typeof r.content, 'string',
      `正文必须是字符串（空串），实际 ${r.content === null ? 'null' : typeof r.content} —— 上层会直接 .slice/.trim`);
    assertEquals(r.content, '', `正文应为空串，实际 ${JSON.stringify(r.content)}`);
    assert(!r.error, '这是**正常**响应（强制 tool_choice 时上游常态如此），不得被标成失败');
    assertEquals(r.finishReason, 'tool_calls', `finishReason 必须保留，实际 ${r.finishReason}`);
    assertEquals(r.tool_calls?.[0]?.name, 'tool-read', `工具名必须保留，实际 ${JSON.stringify(r.tool_calls)}`);
    assertEquals(r.tool_calls?.[0]?.arguments, '{"path":"a.js"}', '工具参数必须原样保留（丢了就等于丢任务）');
    // 反向：正常正文不得被这道归一清空；错误体仍走失败分支。
    const ok = bareModel(NULL_CONTENT_BODY)._parseApiResult(200, JSON.stringify({ choices: [{ message: { content: '你好' }, finish_reason: 'stop' }] }));
    assertEquals(ok.content, '你好', `正常正文不得被归一清空，实际 ${JSON.stringify(ok.content)}`);
    const bad = bareModel(NULL_CONTENT_BODY)._parseApiResult(400, JSON.stringify({ error: { message: 'boom' } }));
    assert(bad.apiError && /boom/.test(bad.apiError), `错误体仍须带 apiError，实际 ${JSON.stringify(bad.apiError)}`);
    console.log(`       [实测] content:null → ${JSON.stringify(r.content)}，tool_calls=${r.tool_calls.length}，finishReason=${r.finishReason}`);
  });

  // ══ S3 后果：打遥测不能把成功改写成失败 ═════════════════════════════
  runner.test('R0-028/2 call() 不得因为正文为空而把一次成功改写为 [API Error]', async () => {
    const res = await bareModel(NULL_CONTENT_BODY).call([{ role: 'user', content: '读一下 a.js' }], [], {});
    assert(!res.error,
      `上游正常回了 tool_calls，这是成功；实际 res.error=${res.error} / content="${String(res.content).slice(0, 120)}"`
      + '（修前此处是 TypeError 被 catch 成 [API Error] Cannot read properties of null）');
    assertEquals(res.content, '', `正文为空就是空串，实际 ${JSON.stringify(res.content)}`);
    assertEquals(res.tool_calls?.[0]?.id, 'call_null_1', `call() 必须把 tool_calls 交给上层，实际 ${JSON.stringify(res.tool_calls)}`);
    assertEquals(res.finishReason, 'tool_calls', 'finishReason 必须透出（上层据此判断"要调工具"而不是"没说话"）');
    console.log(`       [实测] call() → content=${JSON.stringify(res.content)} error=${res.error} tool_calls=${res.tool_calls.length}`);
  });

  // ══ S3 后果之二：错误串不得冒充摘要 ═══════════════════════════════
  runner.test('R0-028/3 摘要链路遇到 error:true 必须返回空串（否则 [API Error] 会被注入 system prompt）', async () => {
    const errText = "[API Error] Cannot read properties of null (reading 'slice')";
    const cm = bareContext({ call: async () => ({ content: errText, error: true }) });
    const out = await cm._summarizeMessages([{ role: 'user', content: '把前面的对话压缩一下' }]);
    assertEquals(out, '',
      `失败结果不得被当成摘要（拿到 ${JSON.stringify(out)}）：它会被 _setSummary 存下、`
      + '之后每轮以 ## Conversation Summary 注入 system prompt，模型会以为上下文里真有一条 [API Error]');
    // 反向：真实摘要仍要取到，不得因为这道闸把正常摘要也关掉。
    const viaTool = bareContext({ call: async () => ({ tool_calls: [{ id: 't1', name: 'tool-compress-memory', arguments: '{"summary":"真实的摘要"}' }] }) });
    assertEquals(await viaTool._summarizeMessages([{ role: 'user', content: '压缩' }]), '真实的摘要',
      'tool_calls 里的摘要必须仍然取得到');
    const viaText = bareContext({ call: async () => ({ content: '  普通文本摘要  ' }) });
    assertEquals(await viaText._summarizeMessages([{ role: 'user', content: '压缩' }]), '普通文本摘要',
      'content 里的摘要必须仍然取得到（且两端空白去掉）');
    console.log('       [实测] error:true → ""；tool_calls / content 两条正常路径不变');
  });

  // ══ S3 反向：正文为空不等于"摘要不存在" ═══════════════════════════
  runner.test('R0-028/4 反向判据：正文为空的工具调用仍能从 tool_calls 取到摘要', async () => {
    const cm = bareContext(null);
    const got = cm._extractSummary({
      content: '',
      finishReason: 'tool_calls',
      tool_calls: [{ id: 't9', name: 'tool-compress-memory', arguments: '{"summary":"从工具里来的摘要"}' }],
    });
    assertEquals(got, '从工具里来的摘要', `正文为空但工具里有摘要时必须取到，实际 ${JSON.stringify(got)}`);
    assertEquals(cm._extractSummary({ content: '', tool_calls: [{ arguments: 'not-json' }] }), '',
      '工具参数坏掉时必须是空串（走"本轮没摘到"分支），不能抛错也不能返回垃圾');
    console.log('       [实测] 空正文 + 工具摘要 → 取到；坏参数 → ""');
  });

  // ══ S4 主干：滑动窗口不得拆散配对 ═════════════════════════════════
  runner.test('R0-028/5 sliding 窗口扫预算：任何一个切点都不得留下孤儿 tool 结果', async () => {
    const cm = bareContext(null);
    const history = toolHeavyHistory();
    const total = history.reduce((s, m) => s + cm._estimateMessageTokens(m), 0);
    let cuts = 0;
    let firstBad = null;
    for (let avail = 1; avail <= Math.ceil(total * 1.15); avail += 3) {
      const kept = cm._slidingWindow(history, avail);
      const bad = orphanToolResults(kept);
      if (bad.length) {
        cuts++;
        if (!firstBad) firstBad = { avail, bad, head: kept.slice(0, 2).map((m) => m.role) };
      }
    }
    assertEquals(cuts, 0,
      `sliding 裁剪在 ${cuts} 个预算值上切断了 tool_calls/tool 配对（首个 avail=${firstBad?.avail}，`
      + `孤儿=${JSON.stringify(firstBad?.bad)}，窗口开头 role=${JSON.stringify(firstBad?.head)}）：`
      + '上游会直接 400 "messages with role tool must be a response to a preceding message with tool_calls"。'
      + '裁剪必须成组收放 —— _lib/context-budget.js 里已经有 groupIntoTurns，不能只在 Cell 预算那条路上用');
    // 反向：窗口里只要有消息，就必须是**最近**的那批，不能退化成空数组。
    const kept = cm._slidingWindow(history, total);
    assertEquals(kept.length, history.length, `预算充足时必须原样返回，实际保留 ${kept.length}/${history.length}`);
    console.log(`       [实测] 扫 ${Math.ceil(total * 1.15 / 3)} 个预算值，0 个孤儿切点；充足预算下原样 ${kept.length} 条`);
  });

  // ══ S4 主干之二：token 切分同样成组 ═══════════════════════════════
  runner.test('R0-028/6 token 切分扫预算：不产生孤儿 tool 结果，且不丢消息', async () => {
    const cm = bareContext(null);
    const data = toolHeavyHistory().slice(1); // 摘要路径把 system 单独摘出去
    const total = data.reduce((s, m) => s + cm._estimateMessageTokens(m), 0);
    let cuts = 0;
    let firstBad = null;
    for (let avail = 1; avail <= Math.ceil(total * 1.15); avail += 3) {
      const [toKeep, toDrop] = cm._splitForTokens(data, avail);
      assertEquals(toKeep.length + toDrop.length, data.length,
        `切分不得丢消息或重复：avail=${avail} 保留 ${toKeep.length} + 丢弃 ${toDrop.length} ≠ ${data.length}`);
      const bad = orphanToolResults(toKeep);
      if (bad.length) {
        cuts++;
        if (!firstBad) firstBad = { avail, bad, head: toKeep.slice(0, 2).map((m) => m.role) };
      }
    }
    assertEquals(cuts, 0,
      `token 切分在 ${cuts} 个预算值上留下孤儿 tool 结果（首个 avail=${firstBad?.avail}，`
      + `孤儿=${JSON.stringify(firstBad?.bad)}，保留段开头 role=${JSON.stringify(firstBad?.head)}）`);
    const [keepAll, dropAll] = cm._splitForTokens(data, total);
    assertEquals(dropAll.length, 0, `预算充足时不得丢任何消息，实际丢弃 ${dropAll.length} 条`);
    assertEquals(keepAll.length, data.length, `预算充足时必须原样保留，实际 ${keepAll.length}/${data.length}`);
    console.log(`       [实测] 扫 ${Math.ceil(total * 1.15 / 3)} 个预算值，0 个孤儿切点；总计 ${data.length} 条守恒`);
  });

  // ══ S4 反向：分组不等于"干脆不裁" ═════════════════════════════════
  runner.test('R0-028/7 反向判据：装得下才全留，装不下仍然真的裁', async () => {
    const cm = bareContext(null);
    const history = toolHeavyHistory();
    const data = history.slice(1);
    const total = data.reduce((s, m) => s + cm._estimateMessageTokens(m), 0);

    const [keepBig] = cm._splitForTokens(data, total * 4);
    assert(same(keepBig.map((m) => m.role), data.map((m) => m.role)),
      `预算给到 4 倍时必须一条不裁，实际 role 序列 ${JSON.stringify(keepBig.map((m) => m.role))}`);

    // 预算只够最近一轮时，必须真的丢掉更早的轮次（否则等于把裁剪关掉）。
    const [, dropSmall] = cm._splitForTokens(data, Math.ceil(total / 2));
    assert(dropSmall.length > 0, '预算只有一半时必须真的裁掉更早的消息，实际一条都没丢');
    const keptSmall = cm._slidingWindow(history, Math.ceil(total / 2));
    assert(keptSmall.length > 0, '裁剪后不得为空');
    assert(keptSmall.length < history.length, `预算只有一半时不得原样返回 ${history.length} 条`);
    assertEquals(orphanToolResults(keptSmall).length, 0, '裁到一半时也不得留孤儿 tool 结果');
    console.log(`       [实测] 4 倍预算 → 全留 ${keepBig.length} 条；一半预算 → 丢 ${dropSmall.length} 条、留 ${keptSmall.length} 条`);
  });
}
