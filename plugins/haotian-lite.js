import { toLLMText, toNeedsReasoningText } from './_lib/diagnostic-lite.js';
import { matchDangerousCommand, classifyIrreversible } from './_lib/danger-patterns.js';
import { wsRequest, C, c, CHAT_TIMEOUT_MS } from '../scripts/cli-transport.mjs';
import { randomUUID } from 'node:crypto';
import { createSessionQueue } from './tools/lib/session-queue.mjs';
import { assertSessionId } from './tools/lib/session-id.mjs';

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
  // 0.9.1（R0-182）：预算终态补 `tools_dispatched` —— 流式终态事件要用它区分
  // "没派发过工具"与"派发过、但预算先到"，这两个事实不能靠 0 默认值猜。
  // 0.9.0（R0-180）：新增按会话的取消/预算/能力策略/无历史/观测面（`chat-control`
  // 服务 + `agent.cancel` / `agent.sessions` 能力）。`chat.handle` 的入参与返回**向后兼容**：
  // 不传新字段时行为与 0.8.x 逐字段一致。
  version = '0.9.1';
  requires = { 'session': '>=0.3.0' };
  permissions = [];
  provides = [{ name: 'chat.handle', type: 'capability' }];

  constructor() {
    this._rejectNew = false;
    this._rejectReason = '';
    this._singleSessionMode = false;
    // 会话控制面（R0-180）：
    //   `_live`      正在跑的那一轮（sessionId → 控制记录，cancel/预算/观测都读它）
    //   `_recent`    最近结束的若干轮（有界；观测面要能回答"上一次为什么失败"）
    //   `_queued`    已提交、还没开始跑的轮数（同一会话按队列串行）
    //   `_preCancel` 对"还没开始"的那一轮下的停止请求（开始时要先看它）
    this._live = new Map();
    this._recent = new Map();
    this._queued = new Map();
    this._preCancel = new Map();
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
      // 会话控制面**与 chat.handle 同生共死**：chat.handle 被别人持有时，本插件不跑任何
      // 执行循环，此时注册 `agent.cancel` 只会对着别人的轮次回 not_running —— 那是一条
      // 读起来像"没有任务"的谎。缺这个服务时网关回 501，而不是回一个空的 accepted。
      core.registerService('chat-control', {
        cancel: (sessionId, opts) => this.cancel(sessionId, opts),
        snapshot: () => this.snapshot(),
        stat: (sessionId) => this.stat(sessionId),
      });
      core.registerCapability('agent.cancel', {
        description: 'Request cancellation of one in-flight chat turn (per session). '
          + 'accepted:true means the request was recorded, NOT that the turn has stopped.',
        owner: 'haotian-lite',
        handler: (params) => this.cancel(params?.sessionId ?? params?.session_id, { reason: params?.reason }),
      });
      core.registerCapability('agent.sessions', {
        description: 'Read-only per-session execution stats: queue depth, in-flight, turns, tokens, last error. '
          + 'Never includes prompt or reply text.',
        owner: 'haotian-lite',
        handler: () => this.snapshot(),
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
    // 排队深度只数"已提交、还没开始"这一段：`_handleTurn` 进来时不再减计数，
    // 读数时用 `queued - (在跑?1:0)` 算净排队，取消/完成都由 finally 归还。
    this._noteQueued(sessionId, +1);
    try {
      return await this._sessionQueue.run(sessionId, () => this._handleTurn(params));
    } finally {
      this._noteQueued(sessionId, -1);
    }
  }

  async _handleTurn(params) {
    const { message, sessionId = 'default', stream = false, onChunk } = params || {};
    const stateless = params?.stateless === true;
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

    // **预算先判**：跑到一半再报"预算字段写错了"，调用方拿到的是一段真实回答加一个错误码，
    // 它没法判断这轮到底算不算数。契约错误带 code + contractError 原样上抛（网关据 code 回 400）。
    const budget = this._normalizeBudget(params?.budget);

    // 标识契约：就算 `stateless`（不读不写历史）也照判 —— 它是 cancel / stats 的键，不是自由文本。
    // 判在模型请求之前：非法 id 不会产生任何模型调用，也不会落盘。
    assertSessionId(chainId);

    const release = await this._concurrencyLimiter.acquire(30000).catch(() => null);
    if (!release) {
      return { reply: 'System busy, please retry', sessionId, traceId };
    }

    const ctl = this._beginTurn(chainId, { budget, stateless, traceId });
    let history = [];
    let tools = [];
    let histBase = 0;
    let usageAccum = null;
    let policyBound = false;
    try {
      const inbound = await this.core.runPipeline('inbound', { message, sessionId }, { traceId });
      if (!inbound) return this._end('Request blocked', sessionId, traceId, [], [], false, null, { stateless });

      const session = this.core.getService('session');
      // `stateless`：**不读**历史。判据是"这次没有历史"，不是"历史里恰好没内容"——
      // 同一个 id 之前跑过普通对话时，后者会把旧内容悄悄带回来（"一次性"就不成立了）。
      history = (stateless || typeof session?.loadSession !== 'function')
        ? [] : (await session.loadSession(chainId)) || [];
      if (history.length > 200) history = history.slice(-200);
      histBase = history.length;
      history.push({ role: 'user', content: inbound.message || message });

      // `stateless` 的判据是"不写"：落过盘就已经"保留历史"了，再删是另一回事。
      if (!stateless) {
        const yingMini = this.core.getService('ying-mini');
        if (yingMini) {
          yingMini.recordEvent(chainId, 'user_input', 'user', { message: (inbound.message || message).slice(0, 1000) }).catch(err => { this.core?.log?.('warn', `[haotian-lite] yingMini recordEvent(user_input) failed: ${err.message}`) });
        }
      }

      // 会话策略（R0-180 / P1）：只能**收窄**。判据在执行器的派发期，不是提示词里的可见性。
      policyBound = await this._bindSessionPolicy(chainId, params, traceId);

      let visibleTools = this._cognitionVisibleTools(this.core.getService('tool-registry')?.list() || [], chainId);
      if (policyBound) visibleTools = await this._policyVisibleTools(chainId, visibleTools);
      tools = visibleTools;

      // 预算的**生效值**：进程级上限仍是上限，预算只能比它更小（与能力交集同一方向）。
      const procMax = this.core.get('agent.maxTurns') || 10;
      const maxTurns = budget.max_turns == null ? procMax : Math.min(procMax, budget.max_turns);
      const turnsBoundByBudget = budget.max_turns != null && maxTurns === budget.max_turns;
      const deadline = budget.wall_ms == null ? null : ctl.startedAt + budget.wall_ms;

      const systemMsg = await this._buildSystemMsg(tools, sessionId, traceId, inbound.message || message);

      let turn = 0;
      for (;;) {
        // 终止判据一律排在**下一步开始之前**：排在后面就是"先干了活，再宣布不该干"。
        if (turn >= maxTurns) {
          if (turnsBoundByBudget) {
            return this._finishBudget('max_turns', ctl, {
              sessionId, traceId, history, tools,
              limit: budget.max_turns, used: turn,
            });
          }
          // 进程级上限命中：保持旧行为与旧文案（不把它伪装成"预算耗尽"）。
          const fallback = 'Max turns reached.';
          history.push({ role: 'assistant', content: fallback });
          return this._end(fallback, sessionId, traceId, history, tools, false, usageAccum, { stateless });
        }
        const stopBefore = this._stopReason(ctl, budget, deadline);
        if (stopBefore) return this._terminate(stopBefore, ctl, { sessionId, traceId, history, tools, histBase });

        turn++;
        ctl.turn = turn;
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
          const result = await this._streamLoop(messages, tools, sessionId, session, history, traceId, onChunk, ctl);
          if (result.canceled) {
            return this._terminate({ kind: 'cancel', reason: 'canceled while streaming' }, ctl,
              { sessionId, traceId, history, tools, histBase });
          }
          usageAccum = this._mergeUsage(usageAccum, result.usage);
          ctl.tokens = usageAccum?.total_tokens || 0;
          // 模型调用**返回之后**再判一次：cancel 与 wall_ms 都可能在这段时间里到达。
          const stopAfter = this._stopReason(ctl, budget, deadline);
          if (stopAfter) return this._terminate(stopAfter, ctl, { sessionId, traceId, history, tools, histBase });
          if (result.error) return this._end(result.content || '[API Error] unknown', sessionId, traceId, history, tools, true, null, { stateless });
          if (result.content && !result.tool_calls?.length) {
            history.push({ role: 'assistant', content: result.content || '' });
            await this.core.runPipeline('outbound', { reply: result.content, sessionId }, { traceId });
            return this._end(result.content, sessionId, traceId, history, tools, false, usageAccum, { stateless });
          }
          if (result.tool_calls) {
            for (const tc of result.tool_calls) {
              history.push({ role: 'assistant', content: result.content || '', tool_calls: [tc] });
            }
            const aborted = await this._execTools(result.tool_calls, history, turn, chainId, traceId, ctl);
            if (aborted) return this._terminate(aborted, ctl, { sessionId, traceId, history, tools, histBase });
            continue;
          }
          return this._end(result.content || '', sessionId, traceId, history, tools, false, usageAccum, { stateless });
        }

        const model = this.core.getService('model');
        if (!model) {
          history.push({ role: 'assistant', content: 'No model service configured' });
          // 落盘统一由 `_end` 做（它同时尊重 stateless）：这里再存一次是同一段消息进两次队列，
          // 而这一路没有 `.catch`，目录不可写时就是一个未处理的 Promise 拒绝。
          return this._end('No model service configured', sessionId, traceId, history, tools, false, null, { stateless });
        }

        const result = await model.callTier('worker', messages, tools);
        usageAccum = this._mergeUsage(usageAccum, result.usage);
        ctl.tokens = usageAccum?.total_tokens || 0;
        const stopAfter = this._stopReason(ctl, budget, deadline);
        if (stopAfter) return this._terminate(stopAfter, ctl, { sessionId, traceId, history, tools, histBase });

        // R0-110/T2：模型层失败（超时/网络/上游 4xx-5xx）**不是"模型说的话"**，不得写进会话历史。
        // 此前 `[API Error] timeout 20s: no response` 被当 assistant 轮落盘（实测会话文件 live-2/live-3
        // 各躺着一条），下一轮它就成了"上文"被喂回模型——错误一旦入历史，后续每轮都在读它。
        // 现在：错误如实返回给调用方并带 `error:true`，但不进 history、不触发 outbound 管线。
        if (result.error) {
          ctl.lastError = String(result.content || 'model error').slice(0, 300);
          return this._end(result.content || '[API Error] unknown', sessionId, traceId, history, tools, true, null, { stateless });
        }

        if (result.content && !result.tool_calls?.length) {
          history.push({ role: 'assistant', content: result.content || '' });
          await this.core.runPipeline('outbound', { reply: result.content, sessionId }, { traceId });
          return this._end(result.content, sessionId, traceId, history, tools, false, usageAccum, { stateless });
        }

        if (result.tool_calls) {
          history.push({ role: 'assistant', content: result.content || '', tool_calls: result.tool_calls });
          const aborted = await this._execTools(result.tool_calls, history, turn, chainId, traceId, ctl);
          if (aborted) return this._terminate(aborted, ctl, { sessionId, traceId, history, tools, histBase });
          continue;
        }

        history.push({ role: 'assistant', content: result.content || '' });
        return this._end(result.content || '', sessionId, traceId, history, tools, false, usageAccum, { stateless });
      }
    } catch (err) {
      ctl.lastError = String(err?.message || err).slice(0, 300);
      ctl.finalState = 'failed';
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
      if (policyBound) this._unbindSessionPolicy(chainId);
      this._finishTurn(ctl);
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

  async _execTools(toolCalls, history, turn, chainId, traceId, ctl = null) {
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
      // **撤销先于派发**：cancel 到达之后就不再开始新的执行。已经在跑的那一次不在这里 ——
      // 它要么在 `executeBatch` 的 await 里，要么已经被计进 `toolsDispatched`（见下）。
      // 不写 "cancelled" 工具结果：这一整轮会被回滚，写进去只会污染历史。
      if (ctl?.canceled) {
        return { kind: 'cancel', reason: 'canceled before tool dispatch', why: ctl.canceled.reason };
      }
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
      // 计数在**派发之前**：这一批只要进了执行器就可能产生副作用，之后无论成败都只能算"不知道"。
      if (ctl) ctl.toolsDispatched += toolCalls.length;
      const results = await executor.executeBatch(toolCalls, { chainId, sessionId: chainId, traceId });
      const yingMini = this.core.getService('ying-mini');
      const fence = this.core.getService('kunxiansuo.bundle');
      for (const tr of results) {
        if (yingMini && !ctl?.stateless) {
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
    if (ctl) ctl.toolsDispatched += toolCalls.length;   // 同上：派发即可能副作用
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

  async _streamLoop(messages, tools, sessionId, session, history, traceId, onChunk, ctl = null) {
    const model = this.core.getService('model');
    if (!model?.streamChatTier) return { content: '' };
    // 已经收到停止请求就不要再发一次模型请求：那一段 token 花得没有任何意义。
    if (ctl?.canceled) return { content: '', canceled: true };

    // 思考开关是**配置事实**（`model.thinking`，例如 {"type":"disabled"}），不是每次调用的临时参数。
    // 缺省时**什么都不传**：请求体里不会多出 `thinking` 字段，未配置的部署逐字节不变。
    const thinking = this.core.get?.('model.thinking');
    const modelOpts = (thinking === undefined || thinking === null) ? undefined : { thinking };

    let fullContent = '';
    let fullReasoning = '';
    let streamError = false;   // R0-110/T2：流里的错误块必须与正常内容区分，否则同样会入史
    let streamUsage = null;    // R0-111/W5：上游末块带的 usage（OpenAI 需 stream_options.include_usage）
    let canceled = false;
    for await (const chunk of model.streamChatTier('worker', messages, tools, modelOpts)) {
      // 流式路径的取消**不必等一次完整模型调用**：每个分块都是一个边界。`break` 会触发
      // 异步迭代器的 return()，模型层的响应流随之关闭 —— 这也是本进程里唯一能做到
      // "立即可见地停下"的位置（非流式调用没有 AbortSignal，只能等它返回）。
      if (ctl?.canceled) { canceled = true; break; }
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
    return {
      content: fullContent || '',
      ...(streamError ? { error: true } : {}),
      ...(canceled ? { canceled: true } : {}),
      ...(streamUsage ? { usage: streamUsage } : {}),
    };
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

  _end(reply, sessionId, traceId, history, tools, isError = false, modelUsage = null, extra = {}) {
    const { stateless = false, record = true, ...fields } = extra || {};
    this.core.emitFast('request.end', {
      traceId, sessionId,
      timestamp: Date.now(),
      sourcePlugin: 'haotian-lite',
    });
    const session = this.core.getService('session');
    // `stateless` 的判据是"不写"，不是"写了再删"：一旦落盘，"不保留历史"就已经不成立。
    if (!stateless && session && history.length) {
      session.saveHistory(sessionId, history).catch(err => { this.core?.log?.('warn', `[haotian-lite] saveHistory failed: ${err.message}`) });
    }
    const yingMini = this.core.getService('ying-mini');
    // `record:false`：被取消 / 预算耗尽的那一轮不往记忆库里写一条"agent 说过话"——
    // 那条文本是内核的状态播报，不是模型的输出。
    if (!stateless && record && yingMini && reply) {
      yingMini.recordEvent(sessionId, 'agent_output', 'agent', { reply: String(reply).slice(0, 1000) }).catch(err => { this.core?.log?.('warn', `[haotian-lite] yingMini recordEvent(agent_output) failed: ${err.message}`) });
    }
    const tokenUsage = this._getTokenUsage(history, tools);   // 上下文预算（{used,max,percent}），控制台用
    // R0-111/W5：`usage` 必须是 OpenAI 的 token 形状。此前 REST 把上下文预算直接塞进 `usage`，
    // 兼容客户端会把 `used`（字符数预算）当 prompt_tokens 显示 —— 计量彻底错位。
    const usage = modelUsage && (modelUsage.prompt_tokens || modelUsage.completion_tokens) ? modelUsage : undefined;
    // R0-110/T2：`error:true` 是给上层（网关 REST/WS）的**机器可判**信号——它据此返回 502
    // 而不是"HTTP 200 + 一段其实是错误文案的正文"。此前调用方只能靠字符串前缀猜。
    // 终态字段（state/code/reason/budget/…）只出现在取消与预算耗尽这两种结果里：
    // 正常返回的形状与 0.20.2 逐字段一致，旧客户端不需要改。
    return { reply, sessionId, traceId, tokenUsage, ...(usage ? { usage } : {}), ...(isError ? { error: true } : {}), ...fields };
  }

  // ── 会话控制面（R0-180）────────────────────────────────────
  /**
   * 预算的**契约校验与归一化**。
   *
   * 三条要求：
   *   ① 未知字段**具名拒绝**：静默忽略会让调用方以为"限上了"，实际没限（最坏的假安全感）；
   *   ② `max_cost_units` **明说不支持**：本内核不随包发布价格表，"算不出来"的预算不可能被执行，
   *      接受它等于把"没限"写成"限了"；
   *   ③ 数值一律整数且落在有界区间：`0` / 负数 / 小数 / `Infinity` 都是"看起来限了但永远不触发"。
   */
  _normalizeBudget(raw) {
    const bad = (message, code = 'invalid_budget') => Object.assign(new Error(message), { code, contractError: true });
    if (raw === undefined || raw === null) return { max_turns: null, wall_ms: null, max_tokens: null };
    if (typeof raw !== 'object' || Array.isArray(raw)) throw bad('budget must be an object');
    const known = ['max_turns', 'wall_ms', 'max_tokens', 'max_cost_units'];
    const unknown = Object.keys(raw).filter((k) => !known.includes(k));
    if (unknown.length) throw bad(`budget.${unknown[0]} is not part of this contract (accepts ${known.join('|')})`);
    if (raw.max_cost_units !== undefined && raw.max_cost_units !== null) {
      throw bad('budget.max_cost_units is not supported: this kernel ships no price table, so a cost budget '
        + 'could not be enforced. Use budget.max_tokens — the model client reports real token usage.',
      'budget_unsupported');
    }
    const int = (v, name, max) => {
      if (v === undefined || v === null) return null;
      if (!Number.isInteger(v) || v < 1 || v > max) throw bad(`budget.${name} must be an integer in [1, ${max}]`);
      return v;
    };
    return {
      max_turns: int(raw.max_turns, 'max_turns', 10000),
      wall_ms: int(raw.wall_ms, 'wall_ms', 24 * 3600 * 1000),
      max_tokens: int(raw.max_tokens, 'max_tokens', 1e9),
    };
  }

  /** 登记一轮的开始。已排队的停止请求在这里生效（开始之前就停，不可能有副作用）。 */
  _beginTurn(sessionId, { budget, stateless, traceId }) {
    const pre = this._preCancel.get(sessionId) || null;
    if (pre) this._preCancel.delete(sessionId);
    const ctl = {
      sessionId, traceId, budget, stateless,
      startedAt: Date.now(), turn: 0, tokens: 0, toolsDispatched: 0,
      canceled: pre, lastError: null, finalState: null,
    };
    this._live.set(sessionId, ctl);
    return ctl;
  }

  /** 结束一轮：从"在飞"表里摘下，保留一条有界的观测记录。 */
  _finishTurn(ctl) {
    if (!ctl) return;
    if (this._live.get(ctl.sessionId) === ctl) this._live.delete(ctl.sessionId);
    try { this._remember(ctl); } catch (err) { this.core?.log?.('debug', `[haotian-lite] session stats bookkeeping failed: ${err?.message || err}`); }
  }

  _remember(ctl) {
    const row = this._row(ctl.sessionId, ctl);
    row.state = ctl.finalState || 'completed';
    // 已经结束的一轮既不在跑也不在排队。不写死这两个值，就会把“收尾那一瞬”的读数
    // （`handle` 的 finally 还没归还排队计数）当成终态保存下来，观测面会永远显示 queue_depth:1。
    row.in_flight = 0;
    row.queue_depth = 0;
    this._recent.set(ctl.sessionId, row);
    // 有界：观测面不是日志。持续跑长任务时无界增长等于把"记状态"变成内存泄漏。
    while (this._recent.size > 256) this._recent.delete(this._recent.keys().next().value);
  }

  /**
   * 一行观测记录。**不含** prompt / 回复正文 / 工具入参 —— 这些字段在 `/api/audit`、
   * `/api/context` 和自己的会话历史里，不该从"健康面"泄漏出去。
   */
  _row(sessionId, ctl) {
    const live = this._live.get(sessionId) === ctl;
    const queued = Math.max(0, (this._queued.get(sessionId) || 0) - (this._live.has(sessionId) ? 1 : 0));
    return {
      session_id: sessionId,
      state: ctl.finalState || (ctl.canceled ? 'cancelling' : 'running'),
      in_flight: live ? 1 : 0,
      queue_depth: queued,
      turns: ctl.turn || 0,
      tokens: ctl.tokens || 0,
      tools_dispatched: ctl.toolsDispatched || 0,
      last_error: ctl.lastError || null,
      started_at: ctl.startedAt,
      stateless: ctl.stateless === true,
      budget: ctl.budget ? { ...ctl.budget } : null,
      cancel_requested_at: ctl.canceled?.at ?? null,
    };
  }

  _noteQueued(sessionId, delta) {
    const sid = String(sessionId ?? '');
    const n = (this._queued.get(sid) || 0) + delta;
    if (n <= 0) this._queued.delete(sid); else this._queued.set(sid, n);
  }

  /**
   * 停止判据的**唯一**实现（cancel / wall_ms / max_tokens）。
   * 返回 `null` = 继续。调用方在每一步开始之前、以及模型调用返回之后各问一次。
   */
  _stopReason(ctl, budget, deadline) {
    if (ctl.canceled) return { kind: 'cancel', reason: ctl.canceled.reason || 'host_requested' };
    if (deadline != null) {
      const now = Date.now();
      if (now > deadline) {
        return { kind: 'wall_ms', limit: budget.wall_ms, used: now - ctl.startedAt, overrun_ms: now - deadline };
      }
    }
    if (budget.max_tokens != null && ctl.tokens > budget.max_tokens) {
      return { kind: 'max_tokens', limit: budget.max_tokens, used: ctl.tokens };
    }
    return null;
  }

  _terminate(stop, ctl, ctx) {
    if (!stop) return null;
    if (stop.kind === 'cancel') return this._finishCanceled(stop, ctl, ctx);
    return this._finishBudget(stop.kind, ctl, { ...ctx, limit: stop.limit, used: stop.used, overrun_ms: stop.overrun_ms });
  }

  /**
   * 取消的终态。**只有"没有派发过任何工具"才敢说 cancelled** —— 派发过就只剩 unknown：
   * 副作用不可撤销（与 `core.confirm` / Cell 的 `execution_revoked` 同一口径）。
   *
   * 历史**整轮回滚**：取消的语义是"这一轮没发生"，不是"发生了但没记账"。工具层的副作用
   * 不因回滚而消失，但它们是审计面的事实（执行器 audit log / tool.execute 事件），不是会话历史。
   */
  _finishCanceled(stop, ctl, ctx) {
    const { sessionId, traceId, history, tools, histBase } = ctx;
    const dispatched = ctl?.toolsDispatched || 0;
    const state = dispatched > 0 ? 'unknown' : 'cancelled';
    const code = dispatched > 0 ? 'cancel_unknown' : 'cancelled';
    const reason = dispatched > 0
      ? `stop requested after ${dispatched} tool call(s) were dispatched; those side effects are not rolled back`
      : 'stop requested before any tool call was dispatched';
    if (Array.isArray(history) && typeof histBase === 'number') history.length = histBase;
    if (ctl) ctl.finalState = state;
    return this._end(`[${code}] ${reason}`, sessionId, traceId, history, tools, false, null, {
      stateless: ctl?.stateless === true, record: false,
      state, code, reason,
      turns: ctl?.turn ?? 0,
      tools_dispatched: dispatched,
      tokens: ctl?.tokens ?? 0,
      cancel_requested_at: ctl?.canceled?.at ?? Date.now(),
      ...(stop?.why ? { request_reason: stop.why } : {}),
    });
  }

  /**
   * 预算耗尽的终态。与取消不同，这里**不回滚历史**：预算是一种正常结束（"干到这里为止"），
   * 已经跑出的工具结果是真的，下一轮应该接着它们继续，而不是假装什么都没发生。
   * 代价是：如果宿主永远不续跑，会话会停在一串 tool 消息上 —— 这是可读的，不是损坏的。
   */
  _finishBudget(kind, ctl, ctx) {
    const { sessionId, traceId, history, tools, limit, used, overrun_ms } = ctx;
    const budget = { kind, limit, used };
    if (overrun_ms != null) budget.overrun_ms = overrun_ms;
    const reason = kind === 'max_turns'
      ? `budget.max_turns=${limit} reached (${used} turns used)`
      : kind === 'wall_ms'
        ? `budget.wall_ms=${limit}ms exceeded by ${overrun_ms}ms (${used}ms elapsed); the model call already in flight was not aborted`
        : `budget.max_tokens=${limit} exceeded (${used} tokens reported by the model)`;
    if (ctl) ctl.finalState = 'budget_exhausted';
    return this._end(`[BUDGET_EXHAUSTED] ${reason}`, sessionId, traceId, history, tools, false, null, {
      stateless: ctl?.stateless === true, record: false,
      state: 'budget_exhausted', code: 'budget_exhausted', reason,
      budget, turns: ctl?.turn ?? 0, tokens: ctl?.tokens ?? 0,
      // 预算可能在派发过工具之后才到（max_turns / max_tokens），这个计数是消费端判断
      // "副作用是否可能已发生"的唯一依据，不能缺省。
      tools_dispatched: ctl?.toolsDispatched ?? 0,
    });
  }

  /**
   * 按会话请求停止（`agent.cancel` / `POST /api/session/cancel` 的同一个实现）。
   *
   * **`accepted:true` 只表示请求已登记**，不表示已经停下：非流式调用没有 AbortSignal，
   * 所以最坏要等一次模型往返；流式调用在每个分块处检查，通常几十毫秒内停。
   * 终态（`cancelled` / `unknown`）只出现在 `chat.handle` 的返回值里。
   */
  cancel(sessionId, { reason = 'host_requested' } = {}) {
    const sid = String(sessionId ?? '');
    const at = Date.now();
    if (!sid) return { accepted: false, session_id: null, state: 'invalid_session_id', requested_at: at };
    const live = this._live.get(sid);
    if (live) {
      if (!live.canceled) live.canceled = { at, reason: String(reason).slice(0, 200) };
      return {
        accepted: true, session_id: sid, state: 'cancelling', requested_at: at,
        turn: live.turn, tools_dispatched: live.toolsDispatched,
        note: 'stop requested; the turn stops at its next boundary (at worst one model round-trip, '
          + 'since the model client exposes no abort signal)',
      };
    }
    if ((this._queued.get(sid) || 0) > 0) {
      this._preCancel.set(sid, { at, reason: String(reason).slice(0, 200) });
      return {
        accepted: true, session_id: sid, state: 'queued', requested_at: at,
        note: 'the turn has not started yet; it will stop before its first model call',
      };
    }
    return {
      accepted: false, session_id: sid, state: 'not_running', requested_at: at,
      note: 'no turn of this session is running in this process; nothing was cancelled',
    };
  }

  /** 进程内观测面（只读）。`stats_scope` 明说它不跳进程：别的网关上的轮次它看不到。 */
  snapshot() {
    const sessions = [];
    for (const [sid, ctl] of this._live) sessions.push(this._row(sid, ctl));
    const liveIds = new Set(this._live.keys());
    for (const [sid, row] of this._recent) if (!liveIds.has(sid)) sessions.push(row);
    return {
      sessions,
      in_flight: this._live.size,
      queue_depth: sessions.reduce((n, r) => n + (r.queue_depth || 0), 0),
      stats_scope: 'process-local',
    };
  }

  stat(sessionId) {
    const sid = String(sessionId ?? '');
    const live = this._live.get(sid);
    if (live) return this._row(sid, live);
    return this._recent.get(sid) || null;
  }

  /**
   * 把本次调用的 `capabilities` / `permission_mode` 绑到会话上（只能收窄）。
   * 没有执行器时**拒绝执行**，不是静默忽略 —— 忽略了就等于这一轮在"声称更窄"的同时没有门。
   */
  async _bindSessionPolicy(sessionId, params, traceId) {
    const caps = params?.capabilities;
    const mode = params?.permission_mode;
    if (caps === undefined && mode === undefined) return false;
    const ex = this.core.getService('tool-executor');
    if (typeof ex?.setSessionPolicy !== 'function') {
      throw Object.assign(new Error(
        'session_policy_unavailable: this assembly has no tool-executor that can enforce a per-session '
        + 'capability policy. Refusing to run a turn that claims a narrower surface than it can enforce.'),
      { code: 'session_policy_unavailable', contractError: true });
    }
    try {
      await ex.setSessionPolicy(sessionId, { capabilities: caps, permission_mode: mode, source: 'chat.handle' });
    } catch (err) {
      err.contractError = true;   // 名单里写了不存在的能力 ⇒ 400，而不是跑一轮再报错
      throw err;
    }
    this.core.log?.('debug', `[haotian-lite] session policy bound for ${sessionId} (trace ${traceId})`);
    return true;
  }

  _unbindSessionPolicy(sessionId) {
    // 解绑失败不该把已经完成的一轮变成失败：它影响的是下一轮的默认面，不是这一次的结果。
    try { this.core.getService('tool-executor')?.clearSessionPolicy?.(sessionId, { source: 'chat.handle' }); }
    catch (err) { this.core.log?.('debug', `[haotian-lite] session policy unbind failed: ${err?.message || err}`); }
  }

  /** 展示层过滤：让"看得见"与"调得动"一致；真正的门仍在执行器的派发期。 */
  async _policyVisibleTools(sessionId, tools) {
    const ex = this.core.getService('tool-executor');
    if (typeof ex?.visibleToolsForSession !== 'function') return tools;
    try { return await ex.visibleToolsForSession(sessionId, tools); }
    catch (err) {
      this.core.log?.('debug', `[haotian-lite] session-policy visibility filter fell back to unfiltered: ${err?.message || err}`);
      return tools;
    }
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
