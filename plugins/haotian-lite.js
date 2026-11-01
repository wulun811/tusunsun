import { toLLMText, toNeedsReasoningText } from './_lib/diagnostic-lite.js';
import { matchDangerousCommand, classifyIrreversible } from './_lib/danger-patterns.js';
import { wsRequest, C, c, CHAT_TIMEOUT_MS } from '../scripts/cli-transport.mjs';
import { randomUUID } from 'node:crypto';
import { createSessionQueue } from './tools/lib/session-queue.mjs';

class ConcurrencyLimiter {
  constructor(max) {
    this._max = max;
    this._active = 0;
    this._queue = [];
  }

  async acquire(timeoutMs) {
    if (this._active < this._max) {
      this._active++;
      return () => this._release();
    }
    return new Promise((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => {
        const i = this._queue.indexOf(resolve);
        if (i >= 0) this._queue.splice(i, 1);
        reject(new Error('queue timeout'));
      }, timeoutMs) : null;
      this._queue.push(() => {
        if (timer) clearTimeout(timer);
        this._active++;
        resolve(() => this._release());
      });
    });
  }

  _release() {
    this._active--;
    const next = this._queue.shift();
    if (next) next();
  }
}

class HaotianLite {
  name = 'haotian-lite';
  version = '0.8.0';
  requires = { 'session': '>=0.3.0' };
  permissions = [];
  provides = [{ name: 'chat.handle', type: 'capability' }];

  constructor() {
    this._rejectNew = false;
    this._rejectReason = '';
    this._singleSessionMode = false;
  }

  async init(core) {
    this.core = core;

    // R0-2：内核已实施能力注册仲裁——重复注册默认具名拒绝，跨所有者夺取须原所有者让渡。
    // 本插件不再依赖"owner === 'haotian'"这一特定判断（遇到 agent 等其他提供者会误判并触发
    // 冲突），改为：遇到任何已有提供者即显式让位。行为不再依赖插件加载顺序。
    // v0.9.24：此前读 `core._capabilities.get('chat.handle')`（私有 Map），是同一个接口缺口的
    // 第三处。改用核心公开枚举面：判定条件从"这个 key 在不在"变成"谁持有它"。
    const existingCap = core.listCapabilities?.({ prefix: 'chat.handle' })
      ?.find((c) => c.id === 'chat.handle');
    if (existingCap) {
      core.log('info', `HaotianLite: chat.handle already owned by ${existingCap.owner ?? 'unknown'}, stepping aside`);
    } else {
      core.registerCapability('chat.handle', {
        description: 'Handle a chat message through the orchestration pipeline',
        handler: (params) => this.handle(params),
        owner: 'haotian-lite',
      });
    }

    const maxConcurrency = core.get('agent.maxConcurrency') || 20;
    this._concurrencyLimiter = new ConcurrencyLimiter(maxConcurrency);
    // R0-123（多会话隔离）：全局并发闸门之上再加一层**按会话的轮次锁**。
    // 闸门管"同时跑几路"，轮次锁管"同一路不许自己踩自己"：同一会话的两个请求各自基于
    // 同一份历史推进，后写的会把先写的整段覆盖（已实测复现）。串行之后第二个请求读到的
    // 是第一个已经落盘的历史，行为等价于用户连问两句。
    this._sessionQueue = createSessionQueue();

    core.on('haotian-lite.reject_new_sessions', (data) => {
      this._rejectNew = true;
      this._rejectReason = data.reason;
      core.log('warn', `HaotianLite: rejecting new sessions (${data.reason})`);
    });

    core.on('haotian-lite.single_session_mode', (data) => {
      this._singleSessionMode = true;
      core.log('warn', `HaotianLite: single session mode (${data.reason})`);
    });
  }

  async handle(params) {
    const sessionId = params?.sessionId || 'default';
    // R0-144（v0.9.31 续）：`_sessionQueue` 在 `init()` 里创建，而 `handle()` 此前假定它一定存在。
    // 任何**未先 init** 的调用方都会在 `this._sessionQueue.run(...)` 上抛裸 TypeError
    // （`Cannot read properties of undefined (reading 'run')`）—— 错误指向内部字段名，
    // 调用方无从判断是自己装错了还是内核坏了。改为具名失败并带 code。
    // 不自动补建队列：那会把"装配没完成"伪装成"一切正常"，而按会话串行是 R0-123 的判据。
    if (!this._sessionQueue || typeof this._sessionQueue.run !== 'function') {
      const err = new Error('haotian-lite: handle() called before init() completed '
        + '(_sessionQueue unavailable). Ensure the host initialised this plugin first.');
      err.code = 'plugin_not_initialised';
      throw err;
    }
    return this._sessionQueue.run(sessionId, () => this._handleTurn(params));
  }

  async _handleTurn({ message, sessionId = 'default', stream = false, onChunk }) {
    const traceId = this._genTraceId();
    const chainId = sessionId || 'default';
    this.core.emitFast('request.start', {
      traceId, sessionId,
      timestamp: Date.now(),
      sourcePlugin: 'haotian-lite',
    });

    if (this._rejectNew) {
      return { reply: `Service degraded: ${this._rejectReason}`, sessionId, traceId };
    }

    const release = await this._concurrencyLimiter.acquire(30000).catch(() => null);
    if (!release) {
      return { reply: 'System busy, please retry', sessionId, traceId };
    }

    try {
      const inbound = await this.core.runPipeline('inbound', { message, sessionId }, { traceId });
      if (!inbound) return this._end('Request blocked', sessionId, traceId, []);

      const session = this.core.getService('session');
      // R0-114（P0-01）：契约拒绝必须**原样上抛**（code/contractError），不能被下面的
      // `catch (err)` 收成 `{reply:'Error: …'}` 的 200 —— 那会把 400 变成"模型答了句错话"。
      let history = await session?.loadSession?.(sessionId) || [];
      if (history.length > 200) history = history.slice(-200);
      history.push({ role: 'user', content: inbound.message || message });

      const yingMini = this.core.getService('ying-mini');
      if (yingMini) {
        yingMini.recordEvent(sessionId, 'user_input', 'user', { message: (inbound.message || message).slice(0, 1000) }).catch(err => { this.core?.log?.('warn', `[haotian-lite] yingMini recordEvent(user_input) failed: ${err.message}`) });
      }

      const tools = this._cognitionVisibleTools(this.core.getService('tool-registry')?.list() || [], sessionId);
      const maxTurns = this.core.get('agent.maxTurns') || 10;

      const systemMsg = await this._buildSystemMsg(tools, sessionId, traceId, inbound.message || message);

      let turn = 0;
      let usageAccum = null;   // R0-111/W5：本轮累计的真实 token 用量（上游没报就保持 null）
      while (turn < maxTurns) {
        turn++;
        this.core.emitFast('agent.step', {
          sessionId, turn, maxTurns, traceId,
          timestamp: Date.now(),
          sourcePlugin: 'haotian-lite',
        });

        const messages = await this._buildMessagesWith(systemMsg, history, tools, sessionId);
        const config = this.core.getService('config');
        const modelCfg = config?.data?.model || {};
        this.core.log('debug', `chat.messages_built: sessionId=${sessionId}, turn=${turn}, msgCount=${messages.length}, toolCount=${tools.length}`);
        this.core.emitFast('chat.messages_built', {
          sessionId,
          messages: messages.map(m => ({ role: m.role, content: m.content, tool_calls: m.tool_calls })),
          tools: tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })),
          model: modelCfg.model || 'kimi-k2.5',
          baseUrl: modelCfg.baseUrl || '',
          stream: true,
          tool_choice: 'auto',
          timestamp: Date.now(),
          sourcePlugin: 'haotian-lite',
        });

        if (stream) {
          const result = await this._streamLoop(messages, tools, sessionId, session, history, traceId, onChunk);
          usageAccum = this._mergeUsage(usageAccum, result.usage);
          if (result.error) return this._end(result.content || '[API Error] unknown', sessionId, traceId, history, tools, true);
          if (result.content && !result.tool_calls?.length) {
            history.push({ role: 'assistant', content: result.content || '' });
            await this.core.runPipeline('outbound', { reply: result.content, sessionId }, { traceId });
            return this._end(result.content, sessionId, traceId, history, tools, false, usageAccum);
          }
      if (result.tool_calls) {
          for (const tc of result.tool_calls) {
            history.push({ role: 'assistant', content: result.content || '', tool_calls: [tc] });
          }
          await this._execTools(result.tool_calls, history, turn, chainId, traceId);
          continue;
        }
          return this._end(result.content || '', sessionId, traceId, history, tools, false, usageAccum);
        }

        const model = this.core.getService('model');
        if (!model) {
          history.push({ role: 'assistant', content: 'No model service configured' });
          session?.saveHistory?.(sessionId, history);
          return this._end('No model service configured', sessionId, traceId, history, tools);
        }

        const result = await model.callTier('worker', messages, tools);
        usageAccum = this._mergeUsage(usageAccum, result.usage);

        // R0-110/T2：模型层失败（超时/网络/上游 4xx-5xx）**不是"模型说的话"**，不得写进会话历史。
        // 此前 `[API Error] timeout 20s: no response` 被当 assistant 轮落盘（实测会话文件 live-2/live-3
        // 各躺着一条），下一轮它就成了"上文"被喂回模型——错误一旦入历史，后续每轮都在读它。
        // 现在：错误如实返回给调用方并带 `error:true`，但不进 history、不触发 outbound 管线。
        if (result.error) {
          return this._end(result.content || '[API Error] unknown', sessionId, traceId, history, tools, true);
        }

        if (result.content && !result.tool_calls?.length) {
          history.push({ role: 'assistant', content: result.content || '' });
          session?.saveHistory?.(sessionId, history);
          await this.core.runPipeline('outbound', { reply: result.content, sessionId }, { traceId });
          return this._end(result.content, sessionId, traceId, history, tools, false, usageAccum);
        }

          if (result.tool_calls) {
          history.push({ role: 'assistant', content: result.content || '', tool_calls: result.tool_calls });
          await this._execTools(result.tool_calls, history, turn, chainId, traceId);
          continue;
          }

        history.push({ role: 'assistant', content: result.content || '' });
        session?.saveHistory?.(sessionId, history);
        return this._end(result.content || '', sessionId, traceId, history, tools, false, usageAccum);
      }

      const fallback = 'Max turns reached.';
      history.push({ role: 'assistant', content: fallback });
      session?.saveHistory?.(sessionId, history);
      return this._end(fallback, sessionId, traceId, history, tools, false, usageAccum);

    } catch (err) {
      this.core.emit('error', {
        sessionId, traceId,
        component: 'haotian-lite',
        stepId: (typeof turn !== 'undefined' && turn > 0) ? `${traceId}_turn${turn}` : traceId,
        errorMessage: err.message,
        timestamp: new Date().toISOString(),
        sourcePlugin: 'haotian-lite',
      });
      // R0-114（P0-01）：契约错误（会话标识非法 / 路径越界）**再抛**——上层据 code 回 400。
      // 修前这里一律折成 `{reply:'Error: …'}`，网关拿到的是一条"正常运行"的结果，
      // 于是攻击请求得到 HTTP 200 + 一段错误文案，拒绝在监控上完全不可见。
      if (err.contractError) throw err;
      return { reply: `Error: ${err.message}`, sessionId, traceId };
    } finally {
      try { if (typeof release === 'function') release(); } catch (e) { this.core?.log('warn', `[haotian-lite] release failed: ${e.message}`) }
    }
  }

  async _buildSystemMsg(tools, sessionId, traceId, message = '') {
    // CTX-5（PR-1）：**Cell 认知配置优先于宿主默认提示词**，但只在当前会话确实属于
    // 一次运行中的 Cell 执行时成立。判据是 `cell-context` 的执行作用域（按 sessionId 挂），
    // 不是调用方传进来的任何字段 —— 否则"我在请求里写个 cell_id"就成了换身份的路径。
    //
    // 优先级（与 RFC §3.1 一致）：Host Policy > Cell Profile > Task 内容 > 拉取资料/经验。
    // 这里替换的是"宿主默认 agent.systemPrompt"这一项，Host Policy 的其余部分（能力、
    // 权限模式、工作区）不经过提示词，因此不可能被 profile 提权。
    const ctxSvc = this.core.getService('cell-context');
    const frozen = ctxSvc?.profileForSession?.(sessionId) || null;
    const basePrompt = frozen?.system_prompt
      || this.core.get('agent.systemPrompt')
      || null;

    // CTX-13（PR-2）：**真正调用 ContextPort.assemble**，而不是只把 profile 透传下去。
    //
    // 上一版这里只把 `cellProfile` 作为普通 option 交给 prompt-builder，而 prompt-builder
    // 不认识它 —— 于是 `context-port.assemble()` 在整个仓里**零调用点**：目录列不出来、
    // 经验提示不会出现、回执一行也不写。这正是本项目反复出问题的那种"接口存在但不生效"。
    // 现在在这里显式调用：装配失败不得拖垮任务（回落宿主默认 + 记 degraded），
    // 但**必须**在回执/日志里可见。
    let assembled = null;
    if (frozen) {
      const cp = this.core.getService('context-port');
      if (cp?.assemble) {
        try {
          // 把**本轮的模型输入目标**交给装配器：经验的被动命中以任务文本为信号，
          // 不给它就等于让 lookup 永远看不见"这一轮在做什么"。
          assembled = await cp.assemble(sessionId, { history: [], goal: String(message ?? '') });
        } catch (err) {
          // 装配失败 ⇒ 退化，但要说出来。任务继续（认知层故障不等于执行层故障），
          // 而 `context.assembly_failed` 让这个退化在观测面上可查。
          this.core.emit?.('context.assembly_failed', {
            sessionId, cellId: frozen.cell_id, taskId: frozen.task_id,
            code: err.code || null, error: err.message,
            timestamp: new Date().toISOString(), sourcePlugin: 'haotian-lite',
          });
          this.core.log?.('warn', `[haotian-lite] context assembly failed (${err.code || 'error'}): ${err.message}`);
        }
      }
    }
    // 装配产出的系统消息优先：它已包含 profile 的系统提示词 + 有界地图 + 经验提示。
    const effectivePrompt = assembled?.messages?.[0]?.content || basePrompt;

    const promptBuilder = this.core.getService('prompt');
    if (!promptBuilder) {
      const sp = effectivePrompt || 'You are 土行孙.';
      return { role: 'system', content: sp };
    }
    // Bug 3 修复: 传递 model 参数
    const model = this.core.get('model.model') || 'any';
    const messages = await promptBuilder.build({
      history: [],
      tools, sessionId,
      variables: { traceId },
      systemPrompt: effectivePrompt ||
        'You are 土行孙, a helpful AI assistant. Be concise and direct.',
      model,
      // PR-1：把冻结的 profile 交给装配器，让它能按 Cell 声明的预算/地图/经验策略装配。
      // 装配器不认识这个字段时（未升级的 prompt-builder）它就是被忽略的普通选项，
      // 不会改变旧行为 —— 这是刻意的加性接线。
      ...(frozen ? { cellProfile: frozen.profile, cellId: frozen.cell_id, cellTaskId: frozen.task_id } : {}),
      ...(assembled ? { cellContextMap: assembled.map, cellContextReceipt: assembled.receipt } : {}),
    });
    return messages[0];
  }

  async _buildMessagesWith(systemMsg, history, tools, sessionId) {
    let messages = [systemMsg, ...history];
    let contextMgr = this.core.getService('context');
    if (!contextMgr) {
      const hook = this.core.getData('_lazyHook');
      if (typeof hook === 'function') await hook('context');
      contextMgr = this.core.getService('context');
    }
    if (contextMgr) {
      // R0-123：带上会话维度，摘要/预算不再跨会话串
      messages = await contextMgr.trimMessages(messages, systemMsg.content, tools, sessionId);
    }
    let pc = this.core.getService('plugin-context');
    if (!pc) {
      const hook = this.core.getData('_lazyHook');
      if (typeof hook === 'function') await hook('plugin-context');
      pc = this.core.getService('plugin-context');
    }
    if (pc) {
      const extras = pc.getContextualMessages(sessionId, messages);
      if (extras.length) {
        messages.splice(1, 0, ...extras);
      }
    }
    // CTX-9（PR-2）：**最后一次**预算验算，位置在所有片段都拼完之后。
    //
    // 修前这里就是函数的出口：`trimMessages` 先按 A 算了一遍预算，随后
    // `plugin-context` 的 extras 才被 splice 进来，**完全不计入**那一轮核算。
    // 于是"本地看预算内、服务端 400"变成一个说不清的现象。
    //
    // 现在：所有片段就位后统一验算一次。只有声明了 Cell 预算的会话（即
    // `cell-context` 里有执行作用域）才用**它的** limit/reserve；普通会话沿用
    // context-manager 已算过的结果，不重复裁剪 —— 否则就是在改老路径的行为。
    const ctxSvc = this.core.getService('cell-context');
    const frozen = ctxSvc?.profileForSession?.(sessionId) || null;
    if (frozen?.profile?.budget) {
      const { enforceBudget } = await import('./_lib/context-budget.js');
      const verdict = enforceBudget({
        messages,
        limit: frozen.profile.budget.input_max_tokens,
        reserve: frozen.profile.budget.response_reserve_tokens,
      });
      if (!verdict.ok) {
        // 装不下就具名失败，不发一个"看起来正常"的超窗请求。
        // 走 contractError 是为了让上层（gateway）能回具名 4xx，而不是 200 + 一段错误文案。
        const e = new Error(verdict.error || 'context_budget_exceeded');
        e.code = verdict.code || 'context_budget_exceeded';
        e.contractError = true;
        e.budget = { estimate_used: verdict.estimate_used, limit: verdict.limit, reserve: verdict.reserve };
        throw e;
      }
      messages = verdict.messages;
      if (verdict.trimmed) {
        this.core.emit?.('context.trimmed', {
          sessionId, reason: 'final_budget_enforcement', dropped: verdict.dropped,
          dropped_turns: verdict.dropped_turns, estimate_used: verdict.estimate_used,
          limit: verdict.limit, timestamp: new Date().toISOString(), sourcePlugin: 'haotian-lite',
        });
      }
    }
    return messages;
  }

  async _execTools(toolCalls, history, turn, chainId, traceId) {
    const executor = this.core.getService('tool-executor');
    // Cell 归属只看**会话**（rc.29 / R28-B）：一条模型工具调用是不是来自 Cell，与"这台 core
    // 有没有执行器"是两件事。旧版把两者绑在一起 —— 没有执行器就直接走 legacy 直连，于是
    // "Cell 只授权了 tool.read"与"模型调 write_file 真的写盘"可以同时成立。
    //
    // 为什么不能只靠执行器那一层拦：Cell 的授权判据**装在执行器的钩子上**。没有执行器就没有
    // 钩子，没有钩子就不是"门没装上"，而是**根本没有门这个东西**。纯对话 Cell 仍然合法
    // （不碰工具就不需要门），所以拒绝的判据是"Cell 会话 + 模型要派发工具"，不是"创建 Cell"。
    const cellRuntime = this.core.getService('cell-runtime');
    const cell = typeof cellRuntime?.cellForSession === 'function' ? cellRuntime.cellForSession(chainId) : null;
    // 生命周期判决与执行器**同源**（rc.30 / K29-01）：问 `cell-runtime`，不自己再写一份状态机。
    // 三份判据（haotian / 执行器 / cell-runtime）必然漂移，而漂移的那份就是旁路。
    // `null` = 非 Cell 会话，保持原本行为；`ok:false` = 已关闭/已撤销/没有门，一律拒。
    const eligibility = cell && typeof cellRuntime?.sessionEligibility === 'function'
      ? cellRuntime.sessionEligibility(chainId) : null;
    const denyCellTools = (why) => {
      for (const tc of toolCalls) {
        history.push({ role: 'tool', tool_call_id: tc.id, content: `Error: ${why}` });
      }
      this.core?.emit?.('tool.blocked', {
        tool: toolCalls.map((tc) => tc.name).join(','), capability: null,
        sessionId: chainId, code: 'cell_gate_unavailable', reason: why,
        timestamp: Date.now(), sourcePlugin: 'haotian-lite',
      });
      this.core?.log?.('warn', `[haotian-lite] refused ${toolCalls.length} model tool call(s) from ${chainId}: ${why}`);
    };
    if (executor) {
      // 生命周期先表态：关闭/撤销之后的会话，不管门还在不在，都不再派发工具。
      if (eligibility && eligibility.ok === false) { denyCellTools(eligibility.reason); return; }
      // 有执行器也不等于**这个 Cell 的门**在那儿，更不等于**这一次调用**属于当前任务。
      // rc.31：这里改问执行器的**同一条**判决（`cellDispatchVerdict`）—— 它内部先问生命周期、
      // 再问任务票据、最后核门身份。此前这里自己写了一份租约存在性检查，于是“存在性”与
      // “身份”在两条链上分别漂移（K30-02 就是从执行器那半边漏过去的）。一份判据之外不再有第二份。
      if (cell && typeof executor.cellDispatchVerdict === 'function') {
        const refusal = executor.cellDispatchVerdict(chainId);
        if (refusal) { denyCellTools(refusal.reason); return; }
      } else if (cell && !executor.guardLeasesFor(chainId).some((l) => l.live)) {
        denyCellTools(`cell_gate_unavailable: session "${chainId}" belongs to cell "${cell.cell_id}", but its `
          + 'capability gate has no live lease on this executor (the gate was never installed, or it was removed). '
          + 'A model-issued tool call from a Cell must pass a gate that is verifiably in place.');
        return;
      }
      const results = await executor.executeBatch(toolCalls, { chainId, sessionId: chainId, traceId });
      const yingMini = this.core.getService('ying-mini');
      const fence = this.core.getService('kunxiansuo.bundle');
      for (const tr of results) {
        if (yingMini) {
          yingMini.recordEvent(chainId, 'tool_call', 'agent', {
            tool: tr.tool,
            args: tr.args || {},
            status: tr.status,
            result: tr.result ? String(tr.result).slice(0, 500) : '',
          }).catch(err => { this.core?.log?.('warn', `[haotian-lite] yingMini recordEvent(tool_call) failed: ${err.message}`) });
        }
        // Y025（软闸）的 `needs_reasoning` 是**待回答的挑战**，不是错误：执行器已经把实测
        // 影响面、四个问题与重试字段放进 `tr.challenge`，这里必须原样呈现给模型。
        // 落进下面的通用分支就只剩 `Error: ${tr.error}` —— 模型看不到数字，只能猜。
        // 状态区别要保留：既不当成 success，也不并进 blocked（后者是不可重试的拒绝）。
        if (tr.status === 'needs_reasoning') {
          history.push({
            role: 'tool',
            tool_call_id: tr.tool_call_id,
            content: toNeedsReasoningText(tr),
          });
          continue;
        }
        if (tr.status === 'blocked') {
          let toolName = tr.tool || 'unknown';
          if (fence?.chainTracker) {
            const chain = fence.chainTracker.saw(toolName, chainId);
            if (chain?.escalated) {
              this.core.emit('bundle.chain.escalated', {
                chainId, toolName, count: chain.count,
                timestamp: Date.now(),
                sourcePlugin: 'haotian-lite',
              });
            }
            const alts = tr.diagnostic?.alternatives;
            if (alts?.length) fence.chainTracker.recordAlternatives(toolName, chainId, alts);
          }
          const card = tr.diagnostic || { code: 'UNKNOWN', reason: 'Tool blocked' };
          const llmText = toLLMText({ ...card, tool: toolName });
          history.push({
            role: 'tool',
            tool_call_id: tr.tool_call_id,
            content: llmText,
          });
          continue;
        }
        if (tr.status === 'success' && fence?.chainTracker) {
          const recoveryTool = fence.chainTracker.checkRecovery(tr.tool, chainId);
          if (recoveryTool) {
            try {
              this.core.emit('kunxiansuo.tool_recovery', {
                originalTool: recoveryTool, alternativeTool: tr.tool,
                sessionId: chainId, chainId, success: true, duration: tr.duration || 0,
                timestamp: new Date().toISOString(), sourcePlugin: 'haotian-lite',
              });
            } catch (e) { this.core?.log('warn', `kunxiansuo recovery emit: ${e.message}`) }
          }
        }
        history.push({
          role: 'tool',
          tool_call_id: tr.tool_call_id,
          content: tr.error ? `Error: ${tr.error}` : String(tr.result),
        });
      }
      return;
    }

    // **legacy 直连不得成为 Cell 的退路**（R28-B 的正面判据）：走到这里意味着这台 core 上没有
    // 执行器；Cell 会话的模型工具调用在这里一律拒绝，且零副作用。
    // 普通（非 Cell）会话的 legacy 路径保持原样 —— 它本来就没有 Cell 门可绕。
    if (cell) {
      denyCellTools(`cell_gate_unavailable: session "${chainId}" belongs to cell "${cell.cell_id}", and this core `
        + 'has no tool-executor to host its capability gate. Refusing to fall back to the ungated legacy path: '
        + 'a Cell model tool call that cannot pass its authorisation gate must be refused, not executed.');
      return;
    }

    const legacyTools = this.core.getService('tools');
    for (const tc of toolCalls) {
      let toolResult;
      // 公开 `get(name)`：不摸服务的私有 Map；取不到就是"这个工具不存在"。
      if (typeof legacyTools?.get === 'function') {
        const t = legacyTools.get(tc.name);
        let args = {};
        try { args = JSON.parse(tc.arguments || '{}'); } catch (err) { this.core?.log?.('warn', `[haotian-lite] parse tool args failed: ${err.message}`) }
        if (!t) {
          toolResult = `Tool "${tc.name}" not found`;
        } else {
          const target = this._legacyTarget(tc.name, t, args);
          if (!target.ok) {
            toolResult = `Error: ${target.error}`;
          } else {
            try {
              // 走能力面而不是 t.execute(args)：能力门、身份与派发复核都在 core 里，
              // 直接调 handler 会把它们整段绕开。
              const env = await this.core.callCapability(target.capId, args, { traceId });
              toolResult = env?.state === 'succeeded'
                ? env.payload
                : `Error: ${env?.error || env?.code || 'capability_denied'}`;
            } catch (err) {
              this.core?.log?.('warn', `[haotian-lite] ${tc.name} failed: ${err.message}`);
              toolResult = `Error: ${err.message}`;
            }
          }
        }
      } else {
        toolResult = `Tool "${tc.name}" not found (no tool-executor or legacy tools)`;
      }
      history.push({ role: 'tool', tool_call_id: tc.id, content: String(toolResult) });
    }
  }

  /**
   * legacy 直连的执行前置：这条路径没有执行器的 Y024/Y025、沙箱与能力解析。
   * 能补齐的补齐，补不齐的就拒绝 —— 宁可不执行，也不静默绕过。
   *
   * 允许条件（全部满足）：
   *   ① 工具能对应到一个**已注册能力**（按名字 / provides / _capabilityId）；
   *   ② 命令串不命中 Y024 硬拦（含敏感路径读取与外联）；
   *   ③ 不是不可恢复操作 —— 这条路径没有确认回填通道；
   *   ④ 没有开启沙箱 —— tools 服务的 handler 自己 spawn，legacy 路径无法保证经过沙箱。
   *
   * @returns {{ok: true, capId: string} | {ok: false, error: string}}
   */
  _legacyTarget(toolName, tool, args) {
    const caps = this.core?.listCapabilities?.() ?? [];
    const ids = new Set([toolName, `tool.${toolName}`]);
    if (tool?._capabilityId) ids.add(tool._capabilityId);
    for (const p of (Array.isArray(tool?.provides) ? tool.provides : [])) if (p?.name) ids.add(p.name);
    const capId = [...ids].find((id) => caps.some((c) => c.id === id));
    if (!capId) {
      return { ok: false, error: `capability_denied: tool "${toolName}" has no registered capability; refusing legacy direct execution` };
    }
    if (typeof this.core.callCapability !== 'function') {
      return { ok: false, error: 'capability_denied: core exposes no callCapability(); refusing legacy direct execution' };
    }
    const cmd = args?.command ?? args?.cmd ?? args?.script;
    const hit = matchDangerousCommand(cmd);
    if (hit) {
      return { ok: false, error: `capability_denied: command blocked by safety policy (${hit.why}); use tool-executor for the full Y024/Y025 path` };
    }
    const irreversible = classifyIrreversible(cmd);
    if (irreversible) {
      return { ok: false, error: `capability_denied: irreversible command (${irreversible.why}) has no confirmation channel on the legacy path; use tool-executor` };
    }
    if (this.core.get?.('sandbox.enabled') === true && this.core.getService?.('sandbox')) {
      return { ok: false, error: 'capability_denied: sandbox.enabled requires tool-executor; legacy direct execution cannot enforce the sandbox' };
    }
    return { ok: true, capId };
  }

  async _streamLoop(messages, tools, sessionId, session, history, traceId, onChunk) {
    const model = this.core.getService('model');
    if (!model?.streamChatTier) return { content: '' };

    // 思考开关是**配置事实**（`model.thinking`，例如 {"type":"disabled"}），不是每次调用的临时参数。
    // 缺省时**什么都不传**：请求体里不会多出 `thinking` 字段，未配置的部署逐字节不变。
    // 不接这一层，模型层那条 `opts.thinking` 透传就是死代码 —— 配了也不生效。
    const thinking = this.core.get?.('model.thinking');
    const modelOpts = (thinking === undefined || thinking === null) ? undefined : { thinking };

    let fullContent = '';
    let fullReasoning = '';
    let streamError = false;   // R0-110/T2：流里的错误块必须与正常内容区分，否则同样会入史
    let streamUsage = null;    // R0-111/W5：上游末块带的 usage（OpenAI 需 stream_options.include_usage）
    for await (const chunk of model.streamChatTier('worker', messages, tools, modelOpts)) {
      if (chunk.error) streamError = true;
      if (chunk.usage) streamUsage = chunk.usage;
      if (chunk.reasoning) {
        fullReasoning += chunk.reasoning;
        if (onChunk) onChunk({ reasoning: chunk.reasoning });
        this.core.emitFast('chat.stream.reasoning', {
          sessionId, reasoning: chunk.reasoning, traceId,
          timestamp: Date.now(),
          sourcePlugin: 'haotian-lite',
        });
      }
      if (chunk.content) {
        fullContent += chunk.content;
        if (onChunk) onChunk(chunk.content);
        this.core.emitFast('chat.stream.chunk', {
          sessionId, content: chunk.content, traceId,
          timestamp: Date.now(),
          sourcePlugin: 'haotian-lite',
        });
      }
      if (chunk.tool_calls) {
        if (fullReasoning) {
          this.core.emitFast('chat.stream.reasoning_end', {
            sessionId, traceId,
            timestamp: Date.now(),
            sourcePlugin: 'haotian-lite',
          });
        }
        return { content: fullContent, tool_calls: chunk.tool_calls, ...(streamUsage ? { usage: streamUsage } : {}) };
      }
    }
    if (fullReasoning) {
      this.core.emitFast('chat.stream.reasoning_end', {
        sessionId, traceId,
        timestamp: Date.now(),
        sourcePlugin: 'haotian-lite',
      });
    }
    return { content: fullContent || '', ...(streamError ? { error: true } : {}), ...(streamUsage ? { usage: streamUsage } : {}) };
  }

  /**
   * 按**当前冻结的 ContextProfile**过滤认知工具，使"模型看得见"与"调用会成功"一致。
   *
   * 修前这里直接用进程级的 `tool-registry.list()`：`tool-context-pull` /
   * `tool-experience-pull` 是**按整个进程**注册的（取决于宿主有没有配 resourceRoot /
   * experienceRoot），而"这个 Cell 到底能不能读"取决于它的 profile。于是当 profile 写着
   * `retrieval.mode="off"` 或 `experience.active_pull=false` 时，模型仍会在 tools 列表里
   * 看到这两个工具，调用后才被拒。
   *
   * 拒绝本身是对的（权限不靠"没暴露"来保证），但**看得见却一定失败**是另一种谎：
   * 模型会反复尝试、把"策略禁止"误判成"工具坏了"，而且白烧 token。
   * 所以这里做的是"别展示一个必然被拒的入口"，不是"用它当权限门"。
   *
   * 三个必须保持的不变式：
   *   ① 未绑定 profile 的会话 —— **原样返回**，旧路径逐字节不变；
   *   ② 只过滤这两个认知工具，其余工具一律不动（它们是进程级能力，与本 profile 无关）；
   *   ③ 读 profile 失败时**不过滤**（fail-open）。理由：这是展示层，真正的门在
   *      `pull()` / `read()`；为了"少显示一个工具"而让整轮对话失败是本末倒置。
   */
  _cognitionVisibleTools(all, sessionId) {
    try {
      const cc = this.core.getService('cell-context');
      const frozen = cc?.profileForSession?.(sessionId) || null;
      const profile = frozen?.profile;
      if (!profile) return all;   // 未绑定：原样返回

      const hidden = new Set();
      if (profile.retrieval?.mode === 'off') {
        hidden.add('tool-context-pull');
        hidden.add('tool-context-map');
      }
      if (profile.experience?.provider === 'none' || profile.experience?.active_pull !== true) {
        hidden.add('tool-experience-pull');
      }
      if (hidden.size === 0) return all;
      const kept = all.filter((t) => !hidden.has(t?.name ?? t?.function?.name));
      if (kept.length !== all.length) {
        this.core.log?.('debug', `[haotian-lite] cognition tools hidden by frozen profile: ${[...hidden].join(',')}`);
      }
      return kept;
    } catch (err) {
      // ③ fail-open：展示层的问题不得让对话失败。真正的权限仍在 pull()/read() 里。
      // 但**必须留痕**：静默的 fail-open 会让"未绑定却走了过滤"这种错误永久隐身
      // （本轮的 M8 变异正是这样骗过了测试 —— 一个 ReferenceError 被这里吞掉，
      //  返回值恰好也是"全部工具"，于是"没绑定"和"出错"看起来一样）。
      this.core.log?.('debug', `[haotian-lite] cognition tool filter fell back to unfiltered: ${err?.message || err}`);
      this._cognitionFilterFellBack = (this._cognitionFilterFellBack || 0) + 1;
      return all;
    }
  }

  _getTokenUsage(history, tools) {
    const ctx = this.core.getService('context');
    if (!ctx?.getUsage) return null;
    const toolList = this.core.getService('tool-registry')?.list() || tools || [];
    return ctx.getUsage(history, toolList);
  }

  // R0-111/W5：模型层报的是 `{inputTokens, outputTokens}`，OpenAI 兼容面要的是
  // `{prompt_tokens, completion_tokens, total_tokens}`。上游没报 usage 时返回 undefined 而**不编 0**：
  // 0 会让客户端以为"这轮没花钱"，比缺字段更误导。
  _openAIUsage(u) {
    if (!u) return undefined;
    const prompt = Number(u.inputTokens ?? u.prompt_tokens ?? 0) || 0;
    const completion = Number(u.outputTokens ?? u.completion_tokens ?? 0) || 0;
    if (!prompt && !completion) return undefined;
    // `reasoning` 是 completion 的**子集**（OpenAI 语义）：只作明细透出，不重复加进 total。
    // 不透它，客户端看到的永远是"输入 N 输出 M"，看不出 M 里 95% 是在思考。
    const reasoning = Number(u.reasoningTokens ?? u.completion_tokens_details?.reasoning_tokens ?? 0) || 0;
    return {
      prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion,
      ...(reasoning > 0 ? { completion_tokens_details: { reasoning_tokens: reasoning } } : {}),
    };
  }

  // 多轮/多工具调用要把各次的用量累加（只加"上游真报了的"那几次）
  _mergeUsage(acc, u) {
    const one = this._openAIUsage(u);
    if (!one) return acc;
    const reasoning = (acc?.completion_tokens_details?.reasoning_tokens || 0)
      + (one.completion_tokens_details?.reasoning_tokens || 0);
    return {
      prompt_tokens: (acc?.prompt_tokens || 0) + one.prompt_tokens,
      completion_tokens: (acc?.completion_tokens || 0) + one.completion_tokens,
      total_tokens: (acc?.total_tokens || 0) + one.total_tokens,
      ...(reasoning > 0 ? { completion_tokens_details: { reasoning_tokens: reasoning } } : {}),
    };
  }

  _end(reply, sessionId, traceId, history, tools, isError = false, modelUsage = null) {
    this.core.emitFast('request.end', {
      traceId, sessionId,
      timestamp: Date.now(),
      sourcePlugin: 'haotian-lite',
    });
    const session = this.core.getService('session');
    if (session && history.length) {
      session.saveHistory(sessionId, history).catch(err => { this.core?.log?.('warn', `[haotian-lite] saveHistory failed: ${err.message}`) });
    }
    const yingMini = this.core.getService('ying-mini');
    if (yingMini && reply) {
      yingMini.recordEvent(sessionId, 'agent_output', 'agent', { reply: String(reply).slice(0, 1000) }).catch(err => { this.core?.log?.('warn', `[haotian-lite] yingMini recordEvent(agent_output) failed: ${err.message}`) });
    }
    const tokenUsage = this._getTokenUsage(history, tools);   // 上下文预算（{used,max,percent}），控制台用
    // R0-111/W5：`usage` 必须是 OpenAI 的 token 形状。此前 REST 把上下文预算直接塞进 `usage`，
    // 兼容客户端会把 `used`（字符数预算）当 prompt_tokens 显示 —— 计量彻底错位。
    const usage = modelUsage && (modelUsage.prompt_tokens || modelUsage.completion_tokens) ? modelUsage : undefined;
    // R0-110/T2：`error:true` 是给上层（网关 REST/WS）的**机器可判**信号——它据此返回 502
    // 而不是"HTTP 200 + 一段其实是错误文案的正文"。此前调用方只能靠字符串前缀猜。
    return { reply, sessionId, traceId, tokenUsage, ...(usage ? { usage } : {}), ...(isError ? { error: true } : {}) };
  }

  _genTraceId() {
    return `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
}

export default new HaotianLite();

export const cliCommands = [
  {
    name: 'chat',
    description: 'Open interactive chat with the agent（--dir <绝对路径> 让这次对话在该目录里干活）',
    needsCore: true,
    handler: async ({ port, _rest }) => {
      // R0-124：`--dir <路径>` 让这次对话在自己的项目目录里干活（不传 = 网关默认基准）。
      // 只认 `--dir X` 与 `--dir=X`；值缺失当场报用法错误，不静默当成"没给"。
      let dir = null;
      const rest = Array.isArray(_rest) ? _rest : [];
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === '--dir') {
          dir = rest[++i];
          if (!dir) { console.error('用法：tusunsun chat --dir <绝对路径>'); return 2; }
        } else if (typeof a === 'string' && a.startsWith('--dir=')) {
          dir = a.slice('--dir='.length);
          if (!dir) { console.error('用法：tusunsun chat --dir <绝对路径>'); return 2; }
        }
      }
      console.log(`${c('bold', '土行孙 Chat')} (port ${port})`);
      const sessionId = randomUUID().slice(0, 8);

      // R0-124：先声明、再对话。这样"目录不存在/越界/被策略拒绝"在**进入对话之前**就报出来，
      // 而不是先打印一个未经校验的路径、再在每一轮里失败。声明的取值由网关回传（实际生效值）。
      if (dir) {
        let declared;
        try {
          declared = await wsRequest(port, 'workspace.declare', { workspace: dir, sessionId }, { timeoutMs: 15000 });
        } catch (err) {
          console.error(c('red', `无法连接网关（${port}）：${err.message}`));
          return 1;
        }
        if (!declared?.ok) {
          console.error(c('red', `工作目录无效：${declared?.error || '未知原因'}`));
          return 1;
        }
        console.log(c('gray', `工作目录：${declared.payload?.workspace || dir}`));
      }
      console.log(c('gray', 'Type your message, Ctrl+C to exit\n'));

      const { stdin, stdout } = process;
      stdin.setEncoding('utf8');
      const readline = await import('node:readline');
      const rl = readline.createInterface({ input: stdin, output: stdout });

      // R0-109/T1：stdin 结束（管道、`< /dev/null`、终端断开）之后再 `rl.question()` 会抛
      // `ERR_USE_AFTER_CLOSE`，此前以未捕获拒绝的形式砸出一段栈（实测：管道喂一条消息即可复现）。
      // "输入源已结束"是正常退出路径，不是异常。
      let inputClosed = false;
      rl.on('close', () => { inputClosed = true; });

      function prompt() {
        if (inputClosed) { process.stdout.write('\n'); return; }
        rl.question(`${c('green', 'You: ')}`, async (msg) => {
          if (!msg.trim()) return prompt();
          if (['exit', 'quit'].includes(msg.trim().toLowerCase())) { rl.close(); return; }
          process.stdout.write(`${c('blue', 'Agent:')} `);
          try {
            // R0-109/T1：对话必须给足预算。传输层的默认 30s 只是一问一答的兜底，而网关侧
            // `gateway.chatTimeoutMs` 默认 600000（多步工具循环要这么久）；客户端比它略长，
            // 好让**网关自己**的超时先到、拿到可读错误，而不是客户端提前跑掉留半截状态。
            const res = await wsRequest(port, 'agent.chat', {
              message: msg.trim(), sessionId,
              // R0-124：每轮都带上（声明是幂等的：同会话同目录重复声明不报错）。
              // 网关在**执行命令之前**校验，非法会回 ok:false + 具名 code，而不是静默换目录。
              ...(dir ? { workspace: dir } : {}),
            }, { timeoutMs: CHAT_TIMEOUT_MS });
            if (res.ok && res.payload?.reply) process.stdout.write(res.payload.reply);
            else if (res.error) process.stdout.write(c('red', `Error: ${res.error}`));
          } catch (err) { process.stdout.write(c('red', `Connection error: ${err.message}`)); }
          process.stdout.write('\n\n');
          prompt();
        });
      }
      prompt();
    },
  },
];
