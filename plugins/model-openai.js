import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

// 按 URL 协议选传输模块：`http://`（ollama / vLLM / llama.cpp 的默认形态）走 `http`，
// 其余走 `https`；流式/非流式两条路径共用，避免只改一条。
const requestFor = (href) => (String(href).startsWith('http://') ? httpRequest : httpsRequest);
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEnv } from '../src/core/env.js';
// 免 key 的本地点（ollama/llama.cpp/本地 mock）与网关 readiness 共用同一判据，
// 并在调用时真的不带 Authorization 发出去。
import { isKeylessEndpoint, modelAuthHeaders } from './_lib/model-endpoint.js';

// 产品身份统一：User-Agent 必须是本产品；版本字面量与 package.json 的一致性由随包门禁机械校验。
const USER_AGENT = 'tusunsun/0.20.2';

// 工具定义有**两种**形状，本函数在一条链路上会被调用两次，必须对两种形状都幂等：
//   · 扁平（tool-registry.list() 的产出 / 内部约定）：{ name, description, parameters }
//   · OpenAI 原生（本函数的输出）：{ type:'function', function:{ name, description, parameters } }
// 只读扁平的 `t.name` 会在第二次调用时拿到 undefined，把所有工具名发成空字符串，
// 模型因此认为没有工具可用，转而编造命令输出——比直接报错更危险。
function sanitizeTools(tools) {
  if (!tools || !tools.length) return undefined;
  return tools.map((t) => {
    const fn = t.function && typeof t.function === 'object' ? t.function : t;
    const params = fn.parameters;
    return {
      type: 'function',
      function: {
        name: fn.name || '',
        description: fn.description || '',
        // 无 parameters 字段的工具会被网关上游拒（invalid_request_error）——注入空 schema
        ...(params && Object.keys(params.properties || {}).length ? { parameters: params } : { parameters: { type: 'object', properties: {} } }),
      },
    };
  });
}

function sanitizeMessages(messages) {
  return messages.map(m => {
    const msg = {
      role: m.role,
      content: m.content ?? null,
    };
    if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
    // 部分上游拒绝消息级 name 字段（unsupported_parameter）：关联职责由 tool_call_id 承担，name 不透传。
    // **回传**的 tool_calls 也必须是 OpenAI 原生形状：内部扁平 `{ id, name, arguments }`
    // （`_parseApiResult` 产出、会话历史按此落盘）再发给上游会被判请求体非法（上游常回 500），
    // 所有多步工具任务都会在第二步失败。
    if (m.tool_calls) {
      msg.tool_calls = m.tool_calls.map((tc) => {
        const fn = (tc && tc.function && typeof tc.function === 'object') ? tc.function : null;
        const name = fn ? fn.name : tc?.name;
        const args = fn ? fn.arguments : tc?.arguments;
        return {
          id: tc?.id,
          type: 'function',
          function: {
            name: name || '',
            arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
          },
        };
      });
    }
    if (m.reasoning_content) msg.reasoning_content = m.reasoning_content;
    return msg;
  });
}

/** 调试落盘前遮掉凭证字段：文件名与内容都不应成为密钥的二次泄露源。 */
function redactDebugSecrets(value) {
  if (Array.isArray(value)) return value.map(redactDebugSecrets);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = /^(authorization|api[_-]?key|token|secret)$/i.test(k) ? '[REDACTED]' : redactDebugSecrets(v);
  }
  return out;
}

// 非流式请求超时可由 `TUSUNSUN_MODEL_TIMEOUT_MS` 配置，默认与流式对齐：
// 写死短超时会让默认路径在推理模型上必然截断。
function modelTimeoutMs() {
  const n = Number(readEnv('MODEL_TIMEOUT_MS'));
  return Number.isFinite(n) && n > 0 ? n : 60000;
}

// 上游 usage → 内部形状。`reasoning_tokens` 是**思考吃掉的输出预算**，在 OpenAI 语义里
// 属于 `completion_tokens` 的子集（所以不重复加进 total，只作明细透出）。
// 丢掉它 = 「这次为什么没话说 / 为什么花了这么多」不可观测：只思考的响应与正常响应
// 在 usage 上看不出差别，差一个数量级的成本也没人看得见。
function toUsage(u) {
  if (!u) return null;
  const reasoning = Number(u.completion_tokens_details?.reasoning_tokens);
  return {
    inputTokens: u.prompt_tokens,
    outputTokens: u.completion_tokens,
    ...(Number.isFinite(reasoning) && reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  };
}

// 只思考、没正文的响应不是「空回复」，是**预算被思考吃光**。文案必须自证原因与出路，
// 否则用户看到的只是「模型不说话」，而真正的旋钮在另一个变量里。
const REASONING_EXHAUSTED = '[Error] 模型只输出了思考、没有正文（reasoning-only）。'
  + '常见原因是 max_tokens / TUSUNSUN_STREAM_MAX_TOKENS 被思考耗尽（finish_reason=length）；'
  + '抬高预算，或关闭思考：model.thinking={"type":"disabled"}';

// 空白正文是另一类失败：长度不为零、用户一个字也看不见。与 reasoning-only 分开命名，
// 自诊方向不同（思考吃预算 vs 上游回落空），混成一句会把人引到错的旋钮上。
const BLANK_CONTENT = '[Error] 模型返回了空白正文（只有空白字符、没有可读内容）。'
  + '这不算回答：检查上游是否被安全策略截断，或把提示词写得更具体后重试';

// 「有正文」的唯一判据：累计文本里存在非空白字符（`\s` 含全角空格 U+3000）。
// 单个空白 chunk 是正常的（缩进、分隔），所以只能用**轮结束时的累计值**判，不能见空就报错。
const visibleChars = (s) => String(s ?? '').replace(/\s/g, '').length;

class ModelPlugin {
  name = 'model';
  version = '0.3.1';
  provides = [{ name: 'model', type: 'service' }];
  _lastLatency = 0;
  _debugBodyDir = null;
  _debugBodySeq = 0;

  getLastLatency() { return this._lastLatency; }

  async init(core) {
    this.core = core;
    this.supportsNativeTools = true;
    core.registerService('model', this);
  }

  getModel(tier) {
    const config = this.core.getService('config');
    const secrets = this.core.getService('secrets');
    const base = config?.data?.model || {};
    // **档位配置允许是字符串**（`config set` 只做点路径赋值，存进去的就是字符串 `"kimi"`），也允许是对象。
    // 语义：
    //   · 字符串 ⇒ 只覆盖**模型名**，端点与 key 沿用 base（这就是 `set model.worker kimi` 的意图）；
    //   · 对象   ⇒ 逐字段覆盖；
    //   · 其它真值（数字/布尔/数组）⇒ 显式告警并按未配置该档处理，**不静默**。
    const tierCfg = tier && base[tier];
    const asName = typeof tierCfg === 'string' && tierCfg.trim() ? tierCfg.trim() : null;
    if (tierCfg != null && !asName && typeof tierCfg !== 'object') {
      this.core?.log?.('warn',
        `[model] model.${tier} 的形状无法识别（${Array.isArray(tierCfg) ? 'array' : typeof tierCfg}）：`
        + `应写成模型名字符串或 { baseUrl, model, apiKey } 对象；本次按"未配置该档"处理`);
    }
    if (asName) {
      return {
        baseUrl: base.baseUrl || 'https://coding.dashscope.aliyuncs.com/v1',
        apiKey: (secrets?.get('model.apiKey') ?? base.apiKey),
        model: asName,
        headers: base.headers,
      };
    }
    if (tierCfg && typeof tierCfg === 'object' && !Array.isArray(tierCfg)) {
      return {
        baseUrl: tierCfg.baseUrl || base.baseUrl || 'https://coding.dashscope.aliyuncs.com/v1',
        apiKey: tierCfg.apiKey || (secrets?.get('model.apiKey') ?? base.apiKey),
        model: tierCfg.model || base.model || 'kimi-k2.5',
        headers: tierCfg.headers ?? base.headers, // 网关会话头随配置透传（director-port 桥注入）
      };
    }
    return {
      baseUrl: base.baseUrl || 'https://coding.dashscope.aliyuncs.com/v1',
      apiKey: (secrets?.get('model.apiKey') ?? base.apiKey),
      model: base.model || 'kimi-k2.5',
      headers: base.headers, // 同上（网关会话头随配置透传）
    };
  }

  callTier(tier, messages, tools, opts) {
    return this.callWithConfig(this.getModel(tier), messages, tools, opts);
  }

  streamChatTier(tier, messages, tools, opts) {
    return this.streamChatWithConfig(this.getModel(tier), messages, tools, opts);
  }

  async call(messages, tools = [], opts = {}) {
    const config = this.core.getService('config');
    const secrets = this.core.getService('secrets');
    const baseUrl = config?.get('model.baseUrl') || 'https://coding.dashscope.aliyuncs.com/v1';
    const apiKey = secrets?.get('model.apiKey') ?? config?.get('model.apiKey');
    const model = config?.get('model.model') || 'kimi-k2.5';
    // `call()` 直接读配置面（不像 callWithConfig 拿到已解析的 cfg）⇒ headers 也要自己取。
    const headers = config?.get('model.headers') || null;

    if (!apiKey && !isKeylessEndpoint(baseUrl, apiKey)) {
      return { content: '[Error] No API key configured. Set model.apiKey in config or TUSUNSUN_API_KEY env.', error: true };
    }

    try { new URL(baseUrl); } catch {
      return { content: `[Error] Invalid base URL: ${baseUrl}. Please check model config.`, error: true };
    }

    this.core.emit('llm.call', { model, toolCount: tools.length, timestamp: new Date().toISOString(), sourcePlugin: 'model' });
    const t0 = Date.now();
    try {
      const result = await this._request(baseUrl, { model, messages, tools, tool_choice: opts.tool_choice, max_tokens: opts.max_tokens, thinking: opts.thinking }, apiKey, modelTimeoutMs(), headers);
      this._lastLatency = Date.now() - t0;
      this.core.emit('llm.response', {
        model,
        // 遥测只取前 100 字；正文为空（强制 tool_choice 时的上游常态）不得在这里抛错 ——
        // 抛了会被下面的 catch 接住，把一次成功改写成 `[API Error] TypeError`。
        content: String(result.content ?? '').slice(0, 100),
        latencyMs: this._lastLatency,
        inputTokens: result.usage?.inputTokens || 0,
        outputTokens: result.usage?.outputTokens || 0,
        finishReason: result.finishReason || null,
        statusCode: result.statusCode || 0,
        cacheHit: false,
        timestamp: new Date().toISOString(),
        sourcePlugin: 'model',
      });
      return result;
    } catch (err) {
      // 失败结果必须**自证是失败**（`error: true`）：上层据此把错误与模型回答分开，
      // 不能把错误串当 assistant 消息写进会话历史。
      return { content: `[API Error] ${err.message}`, error: true };
    }
  }

  async callWithConfig(cfg, messages, tools = [], opts = {}) {
    const baseUrl = cfg.baseUrl || 'https://coding.dashscope.aliyuncs.com/v1';
    const apiKey = cfg.apiKey;
    // 非流式路径的模型名。本方法多处引用 `model`（早退文案 / llm.call / _request / 重试日志 /
    // llm.response），声明缺失会以 ReferenceError 形态被 `call()` 吞成"模型回复"。
    const model = cfg.model || 'kimi-k2.5';
    // 没 key 时要说清端点：只说"没 key"用户无法自诊会打到哪。
    if (!apiKey && !isKeylessEndpoint(baseUrl, apiKey)) return { content: '[Error] No API key for model: ' + model + '（endpoint: ' + baseUrl + '；设置 TUSUNSUN_API_KEY 或 `tusunsun config set model.apiKey`）', error: true };
    try { new URL(baseUrl); } catch { return { content: '[Error] Invalid base URL: ' + baseUrl, error: true }; }
    this.core.emit('llm.call', { model, toolCount: tools.length, timestamp: new Date().toISOString(), sourcePlugin: 'model' });
    const t0 = Date.now();
    let result = null;
    let lastErr = null;
    const MAX_ATTEMPTS = 3;
    // `_request` 对错误 reject（不 resolve 成内容），下面的重试才真正生效。
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        result = await this._request(baseUrl, { model, messages, tools, tool_choice: opts.tool_choice, max_tokens: opts.max_tokens, thinking: opts.thinking }, apiKey, modelTimeoutMs(), cfg.headers);
        // 「有输出」必须是**用户看得见的东西**（正文或工具调用）。把 reasoning 也算进来，
        // 等于承认"想完了但一个字没说"是成功 —— 上层据此把空串当回复返回。
        // 判据与流式路径共用 `visibleChars`：纯空白同样算没正文（曾只在非流式这边判对）。
        const rawContent = result.content ?? '';
        const hasContent = visibleChars(rawContent) > 0 || (Array.isArray(result.tool_calls) && result.tool_calls.length > 0);
        if (!hasContent) {
          const reasoningOnly = visibleChars(result.reasoning_content) > 0;
          // 只有思考 ⇒ 预算被思考吃光；纯空白 ⇒ 上游回了长度但没有内容。两者都不是"空回复"：
          // 重试是同一发子弹（同样的 max_tokens、同样的提示词），直接具名报错。
          if (reasoningOnly || rawContent.length > 0) {
            result = {
              content: reasoningOnly ? REASONING_EXHAUSTED : BLANK_CONTENT,
              error: true, finishReason: result.finishReason || null, usage: result.usage,
            };
            break;
          }
          result = null;
          throw new Error('empty response (no content/reasoning/tool_calls)');
        }
        break;
      } catch (err) {
        lastErr = err;
        this.core?.log?.('warn', `[model] ${model} call failed (attempt ${attempt + 1}/${MAX_ATTEMPTS}): ${err.message}`);
        if (attempt < MAX_ATTEMPTS - 1) await new Promise(r => setTimeout(r, 1000));
      }
    }
    if (!result) result = { content: `[API Error] ${lastErr?.message || 'unknown'}`, error: true };
    this.core.emit('llm.response', {
      model, content: (result.content || '').slice(0, 100),
      latencyMs: Date.now() - t0,
      inputTokens: result.usage?.inputTokens || 0,
      outputTokens: result.usage?.outputTokens || 0,
      finishReason: result.finishReason || null,
      statusCode: result.statusCode || 0,
      cacheHit: false,
      timestamp: new Date().toISOString(),
      sourcePlugin: 'model',
    });
    return result;
  }

  async *streamChatWithConfig(cfg, messages, tools = [], opts = {}) {
    const model = cfg.model || 'kimi-k2.5';   // 遥测需要它，提前定义（下面不再重复声明）
    // 流式方法体内也要发 `llm.call` / `llm.response`：网关默认走流式，这里不 emit 等于最常用路径零遥测。
    const _t0 = Date.now();
    this.core?.emit?.('llm.call', {
      model, toolCount: Array.isArray(tools) ? tools.length : 0, stream: true,
      timestamp: new Date().toISOString(), sourcePlugin: 'model',
    });
    let _emittedResponse = false;
    const _emitResponse = (finishReason, extra = {}) => {
      if (_emittedResponse) return;
      _emittedResponse = true;
      this.core?.emit?.('llm.response', {
        model,
        content: String(extra.content || '').slice(0, 100),
        latencyMs: Date.now() - _t0,
        inputTokens: extra.inputTokens || 0,
        outputTokens: extra.outputTokens || 0,
        finishReason: finishReason || null,
        statusCode: extra.statusCode || 0,
        stream: true,
        cacheHit: false,
        timestamp: new Date().toISOString(),
        sourcePlugin: 'model',
      });
    };

    const baseUrl = cfg.baseUrl || 'https://coding.dashscope.aliyuncs.com/v1';
    const apiKey = cfg.apiKey;
    // 4096 硬兜底对 reasoning 模型是截断炸弹，`TUSUNSUN_STREAM_MAX_TOKENS` 可抬；agent 循环已显式传 opts.maxTokens
    const maxTokens = opts.maxTokens || cfg.maxTokens || Number(readEnv('STREAM_MAX_TOKENS')) || 4096;
    if (!apiKey && !isKeylessEndpoint(baseUrl, apiKey)) { _emitResponse('error', { statusCode: 0 }); yield { content: '[Error] No API key for model: ' + model + '（endpoint: ' + baseUrl + '；设置 TUSUNSUN_API_KEY 或 `tusunsun config set model.apiKey`）', error: true }; return; }
    try { new URL(baseUrl); } catch { _emitResponse('error', { statusCode: 0 }); yield { content: '[Error] Invalid Base URL: ' + baseUrl, error: true }; return; }
    
    const cleanTools = sanitizeTools(tools);
    if (cleanTools && this.core?.log) {
      this.core.log('debug', `API tools count: ${cleanTools.length}, first tool params keys: ${Object.keys(cleanTools[0]?.function?.parameters?.properties || {}).join(',')}`);
    }
    
    let lastFinishReason = null;   // finishReason 在循环内声明，循环外遥测需要它
    let currentMessages = [...messages];
    const maxContinues = 5;
    // 60s×5 + 指数退避：20s×3 扛不住网关抖动（连续超时会杀死导演循环）。
    const MAX_ATTEMPTS = Number(readEnv('STREAM_ATTEMPTS') || 5);
    const STREAM_TIMEOUT_MS = Number(readEnv('STREAM_TIMEOUT_MS') || 60000);
    const backoffMs = (attempt) => Math.min(8000, 1000 * 2 ** attempt);
    
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      let continueCount = 0;
      // receivedOutput：**上游确实吐过东西**（含思考）—— 它只决定要不要重试，不决定成不成功。
      let receivedOutput = false;
      // answerChars：**真实正文**里的非空白字符数，累计整个回答（含自动续写轮）。这是"有答案"的
      // 唯一事实位 —— 限长提示、诊断、reasoning 都不许写它：让提示占这位，
      // 就等于承认"想完了但一个字没说"是成功。
      let answerChars = 0;
      // reasoningChars：只用于选诊断文案、决定要不要续写，不参与成败判定。
      let reasoningChars = 0;
      // roundContent 归**尝试作用域**：空流/断流的收尾报错在 while 之外，也得能说出
      // “这一轮到底吐了多少正文”。它原先声明在 while 里面，外面那句
      // `_emitResponse('error', { content: roundContent })` 于是成了 ReferenceError（S2）。
      let roundContent = '';
      
      while (continueCount < maxContinues) {
        const cleanMessages = sanitizeMessages(currentMessages);
        const bodyObj = { model, messages: cleanMessages, stream: true, max_tokens: maxTokens };
        if (cleanTools) bodyObj.tools = cleanTools;
        if (opts.tool_choice) bodyObj.tool_choice = opts.tool_choice;
        if (opts.thinking !== undefined) bodyObj.thinking = opts.thinking;
        const body = JSON.stringify(bodyObj);
        if (readEnv('DEBUG_STREAM_BODY')) this._dumpDebugBody(bodyObj);
        const url = new URL(baseUrl);
        if (!url.pathname.endsWith('/chat/completions')) url.pathname = url.pathname.replace(/\/+$/, '') + '/chat/completions';
        
        let res;
        try {
          res = await new Promise((resolve, reject) => {
            const req = requestFor(url.href)(url.href, {
              method: 'POST',
              headers: { ...modelAuthHeaders(apiKey, baseUrl), 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'User-Agent': USER_AGENT,
              // 网关会话头可由模型配置自带（director-port 桥注入 x-opencode-session；其它网关不受影响）
              ...(cfg.headers ?? {}) },
            }, resolve);
            const timeoutId = setTimeout(() => req.destroy(new Error(`timeout ${STREAM_TIMEOUT_MS / 1000}s: no response`)), STREAM_TIMEOUT_MS);
            req.on('response', () => clearTimeout(timeoutId));
            req.write(body); req.end();
            req.on('error', reject);
          });
        } catch (err) {
          if (attempt < MAX_ATTEMPTS - 1) {
            this.core?.log?.('warn', `[model] ${model} stream request failed (attempt ${attempt + 1}/${MAX_ATTEMPTS}): ${err.message}, retrying in ${backoffMs(attempt)}ms`);
            await new Promise(r => setTimeout(r, backoffMs(attempt)));
            break;
          }
          _emitResponse('error', {});
          yield { content: `[API Error] ${err.message}`, error: true };
          return;
        }
        
        if (res.statusCode !== 200) {
          let errBody = '';
          let bodyReadError = null;
          try {
            errBody = await this._readBody(res, STREAM_TIMEOUT_MS, 'stream error body');
          } catch (err) { bodyReadError = err; }
          let errMsg = errBody || (bodyReadError ? `[unreadable error body: ${bodyReadError.message}]` : '');
          try { const p = JSON.parse(errBody); errMsg = p.error?.message || p.error || errBody; } catch (err) { this.core?.log?.('debug', '[ModelOpenAI] Failed to parse error response body: ' + (err?.message || 'unknown')); }
          if (attempt < MAX_ATTEMPTS - 1) {
            this.core?.log?.('warn', `[model] ${model} stream HTTP ${res.statusCode} (attempt ${attempt + 1}/${MAX_ATTEMPTS}), retrying in ${backoffMs(attempt)}ms; body: ${String(errMsg).slice(0, 180)}`);
            await new Promise(r => setTimeout(r, backoffMs(attempt)));
            break;
          }
          _emitResponse('error', { statusCode: res.statusCode });
          yield { content: `[API Error] ${res.statusCode}: ${errMsg}`, error: true };
          return;
        }

        // 流级空闲守卫：响应头超时只管首字节，静默挂死的 socket 无人销毁会占住连接。
        // 活动重置计时、空闲才杀，不违反「工作中不限时」契约。
        res.setTimeout(STREAM_TIMEOUT_MS, () => res.destroy(new Error(`stream idle ${STREAM_TIMEOUT_MS / 1000}s`)));

        let buffer = '';
        const toolAcc = {};
        let finishReason = null;
        roundContent = '';   // 每轮重开：续写判定只看本轮正文
        let roundAnswer = 0;   // 本轮正文里的非空白字符数：续写只看本轮，成败看累计
        let usageYielded = false;
        
        // ── 帧处理器：**只有这一份** ──────────────────────────────────────
        // H1 的根因不是“少写了一个字段”，而是收尾又手抄了一份帧处理（H1 的尾帧就是
        // 少在那份里），两份一定会漂。现在循环里与收尾 flush 都调 `handleLine`：
        // 一处改，两处同变。
        const dbg = (msg) => this.core?.log?.('debug', `[ModelOpenAI] ${msg}`);
        // **增量 UTF-8 解码**（H4）：`buffer += chunk` 会对每个 chunk 单独 toString('utf8')，
        // 一个多字节字符被切开就是两个 U+FFFD。stream 模式把半个字符留到下一块。
        const decoder = new TextDecoder('utf-8');
        const handleLine = function* (line) {
          const trimmed = line.trim();
          // 空行是分隔符；以 ':' 开头是注释/心跳（SSE 规范允许），两者都不产生事件。
          if (!trimmed || trimmed.startsWith(':')) return;
          // **`data:` 后的空格可选**（H3）：只认 'data: ' 会把 `data:{}` 整帧静默丢掉。
          const m = /^data: ?(.*)$/.exec(trimmed);
          if (m === null) return;
          if (m[1] === '' || m[1] === '[DONE]') return;
          let json;
          try { json = JSON.parse(m[1]); }
          catch (err) { dbg(`Failed to parse SSE JSON chunk: ${err?.message || 'unknown'}`); return; }
          const delta = json.choices?.[0]?.delta;
          if (delta?.content) {
            roundContent += delta.content;
            const visible = visibleChars(delta.content);   // 累计判成败、本轮判续写，两个口径都要写
            answerChars += visible;
            roundAnswer += visible;
            receivedOutput = true;
            yield { content: delta.content };   // 原始空白照旧透传：表现策略不参与成败判定
          }
          if (delta?.reasoning_content) { receivedOutput = true; reasoningChars += delta.reasoning_content.length; yield { reasoning: delta.reasoning_content }; }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (tc.id) {
                toolAcc[idx] = { id: tc.id, function: { name: tc.function?.name, arguments: tc.function?.arguments || '' } };
              } else if (toolAcc[idx]) {
                toolAcc[idx].function.arguments += tc.function?.arguments || '';
              }
            }
          }
          // 只认**真的带了** finish_reason 的帧：include_usage 的收尾帧是 `choices: []`，
          // 直接赋值会把已确认的 length 抹成 undefined —— 事实不能被没有它的回调擦掉。
          const frameFinish = json.choices?.[0]?.finish_reason;
          if (frameFinish) { finishReason = frameFinish; lastFinishReason = frameFinish; }
          if (json.usage && !usageYielded) {
            usageYielded = true
            receivedOutput = true;
            yield { usage: toUsage(json.usage) }
          }
        };

        try {
          for await (const chunk of res) {
            buffer += decoder.decode(chunk, { stream: true });
            const lines = buffer.split('\n'); buffer = lines.pop() || '';
            for (const line of lines) yield* handleLine(line);
            if (finishReason === 'tool_calls' && Object.keys(toolAcc).length > 0) {
              receivedOutput = true;
              _emitResponse('tool_calls', { content: roundContent });
              yield { tool_calls: Object.values(toolAcc) };
              return;
            }
          }
          // 正常结束：先冲出解码器里残留的半个字符，再处理最后一行不一定带换行的帧（H1）。
          buffer += decoder.decode();
          for (const line of buffer.split('\n')) yield* handleLine(line);
          buffer = '';
        } catch (err) {
          // **中途断流**（H2）：已经吐出去的正文只是部分事实，不能当“写完了”。
          // 报 error 并带上 partial，让上层知道确定性在哪里断的 —— 抛异常出去则等于
          // 把“断流”与“上游报错”混成一件事，调用方连部分正文都拿不到。
          _emitResponse('error', { content: roundContent });
          const partialNote = answerChars > 0 ? `（已收到 ${answerChars} 字正文）` : '';
          yield {
            content: `[API Error] stream interrupted: ${err?.message || 'unknown'}${partialNote}`,
            error: true, partial: roundContent, uncertain: true,
          };
          return;
        }
        
        if (Object.keys(toolAcc).length > 0) {
          receivedOutput = true;
          _emitResponse('tool_calls', { content: roundContent });
          yield { tool_calls: Object.values(toolAcc) };
          return;
        }
        
        if (finishReason !== 'length') break;

        // 本轮只有思考、正文零字符 ⇒ 预算被思考吃光。**不许续写**：实测 5 轮 = 5 次请求、
        // 5 条空 assistant 塞进上下文、一次正文都没有，最后还用限长提示冒充"答完了"。
        // 续写只在"这轮真的产出了正文、被截断"时才有意义。
        if (roundAnswer === 0 && reasoningChars > 0 && answerChars === 0) {
          _emitResponse('length', { content: roundContent });
          yield { content: REASONING_EXHAUSTED, error: true };
          return;
        }

        const isLastRound = continueCount === maxContinues - 1;
        // 续写的两个前提：本轮有真实正文（否则空转烧预算）、且还有轮次。
        if (!isLastRound && roundAnswer > 0) {
          currentMessages.push({ role: 'assistant', content: roundContent });
          currentMessages.push({ role: 'user', content: '请继续完成上述内容，不要重复已输出的部分。' });
          continueCount++;
          if (this.core?.log) {
            this.core.log('info', `[model] Auto-continue #${continueCount} due to length limit`);
          }
        } else {
          // 已有真实正文 ⇒ 保留正文并补一句截断说明（不误伤既有能力）；
          // 一个字都没有 ⇒ 什么都不说，交给下面的失败判定，绝不用提示冒充回答。
          if (answerChars === 0) break;
          yield { content: '\n\n[提示：回复已达到最大长度限制]' };
          break;
        }
      }
      
      if (receivedOutput) {
        // 上游吐过东西，但正文里没有一个非空白字符 ⇒ 不是成功：要么思考吃光了预算，
        // 要么上游只回了空白。静默返回会让客户端看到 HTTP 200 + 什么都没发生（实测复现），
        // 比报错难查得多；两种文案分开，免得把人引到错的旋钮上。
        if (answerChars === 0) {
          _emitResponse(lastFinishReason || 'length', { content: '' });
          yield { content: reasoningChars > 0 ? REASONING_EXHAUSTED : BLANK_CONTENT, error: true };
          return;
        }
        _emitResponse(lastFinishReason || 'stop'); return;
      }
      if (attempt < MAX_ATTEMPTS - 1) {
        this.core?.log?.('warn', `[model] ${model} empty stream (attempt ${attempt + 1}/${MAX_ATTEMPTS}), retrying in ${backoffMs(attempt)}ms`);
        await new Promise(r => setTimeout(r, backoffMs(attempt)));
      } else {
        _emitResponse('error', { content: roundContent });
        yield { content: `[API Error] empty stream after ${MAX_ATTEMPTS} attempts`, error: true };
        return;
      }
    }
  }

  async *streamChat(messages, tools = [], opts = {}) {
    const config = this.core.getService('config');
    const secrets = this.core.getService('secrets');
    const cfg = {
      baseUrl: config?.get('model.baseUrl') || 'https://coding.dashscope.aliyuncs.com/v1',
      apiKey: secrets?.get('model.apiKey') ?? config?.get('model.apiKey'),
      model: config?.get('model.model') || 'kimi-k2.5',
      maxTokens: config?.get('model.maxTokens') || opts.maxTokens || 4096,
    };
    yield* this.streamChatWithConfig(cfg, messages, tools, opts);
  }

  _request(baseUrl, { model, messages, tools, tool_choice, max_tokens, thinking }, apiKey, timeoutMs = 20000, extraHeaders = null) {
    const cleanMessages = sanitizeMessages(messages);
    const cleanTools = sanitizeTools(tools);
    const bodyObj = { model, messages: cleanMessages };
    if (cleanTools) bodyObj.tools = cleanTools;
    if (tool_choice) bodyObj.tool_choice = tool_choice;
    if (max_tokens) bodyObj.max_tokens = max_tokens;
    // 与流式路径同一个开关：只接流式的话，用户改完 `model.thinking` 会发现"有时生效"。
    if (thinking !== undefined) bodyObj.thinking = thinking;
    const body = JSON.stringify(bodyObj);

    return new Promise((resolve, reject) => {
      const url = new URL(baseUrl);
      if (!url.pathname.endsWith('/chat/completions')) {
        url.pathname = url.pathname.replace(/\/+$/, '') + '/chat/completions';
      }
      const req = requestFor(url.href)(url.href, {
        method: 'POST',
        headers: {
          ...modelAuthHeaders(apiKey, baseUrl),
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': USER_AGENT,
          // 非流式路径同样要透传配置里的 headers：需要网关会话头（x-opencode-session 之类）
          // 的路由在非流式下一律 400。放在最后以便配置覆盖默认值。
          ...(extraHeaders ?? {}),
        },
      }, (res) => this._handleResponse(res, resolve, reject, timeoutMs));
      const timeoutId = setTimeout(() => req.destroy(new Error(`timeout ${timeoutMs / 1000}s: no response`)), timeoutMs);
      req.on('response', () => clearTimeout(timeoutId));

      // **必须 reject，不能 resolve 成内容**：把失败伪装成"有内容的成功"会废掉调用方的重试与错误处理。
      req.on('error', (err) => reject(err));
      req.write(body);
      req.end();
    });
  }

  _handleResponse(res, resolve, reject, timeoutMs) {
    const statusCode = res.statusCode;
    this._readBody(res, timeoutMs)
      .then((data) => {
        const parsed = this._parseApiResult(statusCode, data);
        // HTTP 层错误（4xx/5xx、上游 error 字段、无 choices）同样走 reject：错误不是答案，
        // 不能被当成 content 交给调用方。
        if (parsed.apiError) {
          const err = new Error(parsed.apiError);
          err.statusCode = statusCode;
          reject(err);
          return;
        }
        resolve(parsed);
      })
      .catch(reject);
  }

  /**
   * 读响应体，带**总时长**上限；超时销毁底层连接。
   * 请求超时在收到响应头时就被清除，上游若发完头不再发完 body，没有这一层就会永久占住调用方。
   */
  _readBody(res, timeoutMs, label = 'response body') {
    const limit = Number(timeoutMs) > 0 ? timeoutMs : modelTimeoutMs();
    return new Promise((resolve, reject) => {
      let data = '';
      let settled = false;
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(arg);
      };
      const timer = setTimeout(() => {
        const err = new Error(`timeout ${limit / 1000}s: ${label} not completed`);
        err.code = 'model_body_timeout';
        finish(reject, err);
        res.destroy(err);   // 真的中断连接，而不只是结束等待
      }, limit);
      timer.unref?.();
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => finish(resolve, data));
      res.on('error', (err) => finish(reject, err));
      res.on('aborted', () => finish(reject, new Error(`${label} aborted before completion`)));
    });
  }

  /**
   * `DEBUG_STREAM_BODY` 的调试落盘：默认不写；写时用 mkdtemp 目录 + 0600 文件，
   * 路径打进日志，并遮掉 authorization / api_key 一类字段的值。
   */
  _dumpDebugBody(bodyObj) {
    try {
      if (!this._debugBodyDir) this._debugBodyDir = mkdtempSync(join(tmpdir(), 'tusunsun-stream-body-'));
      const file = join(this._debugBodyDir, `body-${Date.now()}-${++this._debugBodySeq}.json`);
      writeFileSync(file, JSON.stringify(redactDebugSecrets(bodyObj), null, 2), { mode: 0o600 });
      this.core?.log?.('warn', `[model] DEBUG_STREAM_BODY 已写入 ${file}（权限 0600，仅本机调试用）`);
    } catch (err) {
      this.core?.log?.('warn', `[model] DEBUG_STREAM_BODY 写入失败：${err?.message || err}`);
    }
  }

  _parseApiResult(statusCode, data) {
    try {
      const json = JSON.parse(data);
      // 三种失败都带 `apiError` 标记；`_handleResponse` 依据它走 reject，重试与错误处理才有作用对象。
      if (json.error) return { content: `[API Error] ${json.error.message || JSON.stringify(json.error)}`, apiError: `HTTP ${statusCode}: ${json.error.message || JSON.stringify(json.error)}`, statusCode };
      const choice = json.choices?.[0]?.message;
      if (!choice) return { content: `[API Error] No choices in response`, apiError: `HTTP ${statusCode}: no choices in response`, statusCode };
      const result = {
        // **正文为空是正常响应**：强制 `tool_choice` 时上游回 `content:null` + `tool_calls`，
        // 证据在工具调用上；原样透出 null 会让每个 `.slice`/`.trim` 的调用方各抛一次错。
        content: choice.content ?? '',
        finishReason: json.choices[0].finish_reason || 'stop',
        usage: json.usage ? toUsage(json.usage) : null,
        statusCode,
      };
      // 思考正文要与回答分开留住：上层要能判断"这次到底说没说话"，也要能回传给接受
      // `reasoning_content` 的上游。丢了它，`finish_reason=length` 的 reasoning-only
      // 响应就与"正常但内容为空"无法区分。
      if (choice.reasoning_content) result.reasoning_content = choice.reasoning_content;
      if (choice.tool_calls) {
        result.tool_calls = choice.tool_calls.map(tc => ({
          id: tc.id, name: tc.function.name, arguments: tc.function.arguments,
        }));
      }
      return result;
    } catch {
      return { content: `[API Error] Invalid response: ${data.slice(0, 200)}`, apiError: `HTTP ${statusCode}: invalid JSON response`, statusCode };
    }
  }
}

export default new ModelPlugin();
