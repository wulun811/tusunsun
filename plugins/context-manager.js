// 裁剪的分组规则只有一份：`groupIntoTurns`（assistant(tool_calls) 与它的 tool 结果同进同出）。
import { groupIntoTurns } from './_lib/context-budget.js';

class ContextManager {
  name = 'context-manager';
  version = '0.5.0';
  requires = { 'session': '>=0.3.0' };
  permissions = [];
  provides = [{ name: 'context', type: 'service' }];

  async init(core) {
    this.core = core;
    this.maxTokens = core.get('context.maxTokens') || 8000;
    this.strategy = core.get('context.strategy') || 'sliding';
    this.reserveTokens = core.get('context.reserveTokens') || 500;
    // R0-123（多会话隔离）：摘要必须**按会话**存在。此前是插件单例上的一个字符串，
    // 实测两个会话并发时会串：A 的摘要会进到 B 的系统提示里（并被发给模型），
    // 且会一直跟到 B 的后续每一轮。上限 256 个会话，超了淘汰最早写入的。
    this._summaries = new Map();
    this._autoCompactThreshold = core.get('context.autoCompactThreshold') || 0.9;
    core.registerService('context', this);
  }

  /**
   * 裁剪历史到预算内。
   *
   * R0-123：第 4 参是**会话维度**，也是本轮唯一的行为变更点。
   * 传入 `{ sessionId, maxTokens, strategy }` 时按调用方的预算/策略执行，**不再需要**
   * 调用方临时改写 `ctx.maxTokens` / `ctx.strategy` —— 那种写法等于在共享对象上开一个
   * 全局开关，另一个会话正好在跑就会用上别人的预算（实测 chat-ui 的压缩接口如此）。
   *
   * @param {object|string} [opts] `{sessionId, maxTokens, strategy}`；传字符串等价于 `{sessionId}`
   */
  async trimMessages(fullHistory, systemPrompt, tools, opts = {}) {
    const o = typeof opts === 'string' ? { sessionId: opts } : (opts || {});
    const key = o.sessionId ? String(o.sessionId) : '__default__';
    const maxTokens = Number.isFinite(o.maxTokens) ? o.maxTokens : this.maxTokens;
    const strategy = o.strategy || this.strategy;

    const basePrompt = this._stripSummary(systemPrompt || '');
    const systemSize = this._estimateTokens(basePrompt);
    const toolsSize = this._estimateToolTokens(tools || []);
    const available = maxTokens - systemSize - toolsSize - this.reserveTokens;

    if (available <= 0) {
      const lastUser = [...fullHistory].reverse().find(m => m.role === 'user');
      const minimal = lastUser ? [fullHistory[0], lastUser] : [fullHistory[0]];
      this.core.emit('context.trimmed', {
        from: fullHistory.length, to: minimal.length, reason: 'no_available_tokens',
        timestamp: new Date().toISOString(), sourcePlugin: 'context-manager',
      });
      return minimal;
    }

    if (strategy === 'summarize') {
      return this._trimWithSummary(fullHistory, systemPrompt, available, key);
    }

    let result;
    if (strategy === 'sliding') {
      result = this._slidingWindow(fullHistory, available);
      const totalUsed = fullHistory.reduce((s, m) => s + this._estimateMessageTokens(m), 0);
      const usagePercent = totalUsed / (maxTokens - this.reserveTokens);
      if (usagePercent >= this._autoCompactThreshold) {
        this.core.log('info', `context-manager: auto-compact triggered at ${Math.round(usagePercent * 100)}% (session=${key})`);
        const summaryResult = await this._trimWithSummary(fullHistory, systemPrompt, available, key).catch(() => null);
        if (summaryResult) result = summaryResult;
      }
    } else {
      result = fullHistory;
    }

    if (result.length < fullHistory.length) {
      this.core.emit('context.trimmed', {
        from: fullHistory.length, to: result.length,
        timestamp: new Date().toISOString(), sourcePlugin: 'context-manager',
      });
    }
    return result;
  }

  /** 取某会话的摘要（没有就是空串）。 */
  _summaryOf(key) { return this._summaries.get(key) || ''; }

  /** 写某会话的摘要；超出上限淘汰最早写入的（Map 保持插入序，删后重插即刷新顺序）。 */
  _setSummary(key, text) {
    const MAX_SESSIONS = 256;
    this._summaries.delete(key);
    this._summaries.set(key, text);
    while (this._summaries.size > MAX_SESSIONS) {
      const oldest = this._summaries.keys().next().value;
      this._summaries.delete(oldest);
    }
  }

  async _trimWithSummary(messages, systemPrompt, available, key = '__default__') {
    const basePrompt = this._stripSummary(systemPrompt || '');
    const dataMessages = messages.slice(1);
    const [toKeep, toDrop] = this._splitForTokens(dataMessages, available);

    // v0.9.23：Cell 作用域走 compaction → cell-context 的落盘摘要（见 _cellCompaction 注释）。
    const cell = this._cellCompaction(key);

    if (!toDrop.length) {
      return this._injectSummary(messages, basePrompt, key, await this._summaryTextFor(key, cell));
    }

    if (cell) {
      await this._compactForCell(cell, key, toDrop, dataMessages.length - toKeep.length);
    } else {
      try {
        const newBits = await this._summarizeMessages(toDrop);
        if (newBits) {
          // 摘要生成有 await：**先 await 再读**，否则并发写会把对方刚写的段覆盖掉
          const prev = this._summaryOf(key);
          const merged = prev
            ? `[本轮摘要]\n${newBits}\n\n[历史摘要]\n${prev.slice(0, 1500)}`
            : `[本轮摘要]\n${newBits}`;
          this._setSummary(key, merged.slice(0, 3000));
        }
      } catch {
        this.core.log('warn', 'context-manager: summary generation failed, dropping old messages');
      }
    }

    if (toKeep.length < dataMessages.length) {
      this.core.emit('context.trimmed', {
        from: dataMessages.length, to: toKeep.length,
        summaryLength: (await this._summaryTextFor(key, cell)).length,
        timestamp: new Date().toISOString(), sourcePlugin: 'context-manager',
      });
    }

    return this._injectSummary([messages[0], ...toKeep], basePrompt, key, await this._summaryTextFor(key, cell));
  }

  /**
   * 当前会话是否有**Cell 范围的摘要后端**（v0.9.23）。
   *
   * 修前的事实：`plugins/compaction.js` 整整一个服务没有任何生产调用点 ——
   * 真正跑摘要的仍是这里的内存 Map。于是"摘要按 Cell 落盘、带来源范围/版本/生成器、
   * 重启可回读"这三条只对**直接调用 compaction.compact() 的测试**成立，对 Cell 的真实
   * 运行路径不成立（实测：Cell 配了 `compaction.provider=structured-llm` 跑完任务，
   * `cells/<id>/context/summaries/` 目录根本不存在）。
   *
   * 判据是两件事同时成立：会话确实属于一次 Cell 执行（有冻结 profile），且该 profile
   * 声明了 provider ≠ none。其余情况返回 null，**走原来的内存 Map 路径** ——
   * 非 Cell 部署的行为一个字节不变。
   */
  _cellCompaction(sessionId) {
    const ctx = this.core.getService?.('cell-context');
    const frozen = ctx?.profileForSession?.(sessionId) || null;
    if (!frozen) return null;
    if (frozen.profile?.compaction?.provider === 'none') return null;
    const compaction = this.core.getService?.('compaction');
    if (!compaction?.compact) return null;
    return { ctx, compaction, frozen };
  }

  /** 生成并落盘一次 Cell 摘要。失败**必须可见**，但不阻断裁剪（摘要是派生物）。 */
  async _compactForCell(cell, key, toDrop, droppedCount) {
    const sessionId = String(key);
    try {
      // **把上一版摘要作为输入带上**（v0.9.23）。
      //
      // 修前这里直接 `compact({messages: toDrop})`，而 `saveSummary` 是**覆盖写**：
      // 于是第二次压缩只反映"最近被裁掉的那几轮"，更早的历史摘要被整段丢掉。
      // 实测：第一次生成 v1 摘要，重启后再次压缩，磁盘上只剩 v2 的内容，
      // 上一轮摘要里的事实再也读不回来。内存版的做法是把旧摘要拼进新摘要
      // （`[本轮摘要] + [历史摘要]`）—— 落盘版必须等价，否则"可回读"是空话。
      const prev = await cell.ctx.loadSummary(cell.frozen.cell_id, sessionId).catch(() => null);
      const prevText = (prev && prev.status !== 'failed' && typeof prev.summary === 'string') ? prev.summary : '';
      const input = prevText
        ? [{ role: 'user', content: `[历史摘要（更早的轮次，必须保留其事实）]\n${prevText}` }, ...toDrop]
        : toDrop;
      const rec = await cell.compaction.compact({
        messages: input,
        cellId: cell.frozen.cell_id,
        sessionId,
        sourceRange: { from: 0, to: droppedCount },
        provider: cell.frozen.profile.compaction.provider,
        maxSummaryTokens: cell.frozen.profile.compaction.max_summary_tokens,
      });
      if (rec?.status === 'failed') {
        // 没有产物就明说：不发一个"摘要已更新"的事件，也不拿空字符串当摘要注入。
        this.core.log('warn', `context-manager: cell compaction failed for ${sessionId}: ${rec.reason || 'no summary'}`);
        this.core.emit('context.compaction_failed', {
          sessionId, cell_id: cell.frozen.cell_id, reason: rec?.reason || 'no summary',
          timestamp: new Date().toISOString(), sourcePlugin: 'context-manager',
        });
      }
    } catch (err) {
      this.core.log('warn', `context-manager: cell compaction threw (${err.code || err.message})`);
      this.core.emit('context.compaction_failed', {
        sessionId, cell_id: cell.frozen.cell_id, reason: err.code || err.message,
        timestamp: new Date().toISOString(), sourcePlugin: 'context-manager',
      });
    }
  }

  /**
   * 注入用的摘要正文。
   *
   * Cell 作用域**从磁盘读**（`cells/<cell_id>/context/summaries/<session_id>.json`），
   * 而不是读内存 Map —— 这正是"重启后摘要还在"与"A 的摘要不会进 B"这两条承诺的落点。
   * `failed` 记录没有正文，返回空串（不拿空串冒充摘要）。
   */
  async _summaryTextFor(key, cell) {
    if (!cell) return this._summaryOf(key);
    try {
      const rec = await cell.ctx.loadSummary(cell.frozen.cell_id, String(key));
      return (rec && rec.status !== 'failed' && typeof rec.summary === 'string') ? rec.summary : '';
    } catch (err) {
      // 摘要损坏时**不静默注入**：记一条具名事件，本轮按"没有摘要"处理。
      this.core.log('warn', `context-manager: cell summary unreadable (${err.code || err.message}); not injecting`);
      this.core.emit('context.summary_corrupt', {
        sessionId: String(key), cell_id: cell.frozen.cell_id, code: err.code || null,
        timestamp: new Date().toISOString(), sourcePlugin: 'context-manager',
      });
      return '';
    }
  }

  _injectSummary(messages, systemPrompt, key = '__default__', summaryText = null) {
    const summary = summaryText === null ? this._summaryOf(key) : summaryText;
    if (!summary) return messages;
    const basePrompt = this._stripSummary(systemPrompt || '');
    const updated = {
      ...messages[0],
      content: `${basePrompt}\n\n## Conversation Summary\n${summary}`,
    };
    return [updated, ...messages.slice(1)];
  }

  _stripSummary(text) {
    return (text || '').replace(/\n+## Conversation Summary\n[\s\S]*$/, '');
  }

  _splitForTokens(messages, maxTokens) {
    // 与 `_slidingWindow` 同一判据：**成组收放**。保留段要发给上游，开头若是一条无主的
    // tool 结果，整次请求会被上游判非法。
    const groups = groupIntoTurns(messages);
    let firstKept = groups.length;
    let used = 0;

    for (let i = groups.length - 1; i >= 0; i--) {
      const size = groups[i].reduce((s, m) => s + this._estimateMessageTokens(m), 0);
      if (used + size > maxTokens && i < groups.length - 1) break;
      used += size;
      firstKept = i;
    }
    return [groups.slice(firstKept).flat(), groups.slice(0, firstKept).flat()];
  }

  async _summarizeMessages(messages) {
    const model = this.core.getService('model');
    if (!model) return '';

    const conversation = this._formatMessagesForSummary(messages);
    const compressTool = this._buildCompressTool();
    const prompt = [
      { role: 'system', content: '你是摘要专家。将下面对话压缩为结构化摘要，保留讨论的主题与结论、创建或修改的文件及路径、关键决策、用户重要偏好。输出 3-6 段，保留事实细节。未完成任务必须突出标注。' },
      { role: 'user', content: conversation },
    ];

    const result = await model.call(prompt, [compressTool], { tool_choice: { type: 'function', function: { name: 'tool-compress-memory' } } });
    return this._extractSummary(result);
  }

  _formatMessagesForSummary(messages) {
    return messages.map(m => {
      const role = m.role;
      const content = m.content || '';
      if (m.tool_calls) {
        const tools = m.tool_calls.map(tc => {
          let args = tc.arguments || '';
          try { args = JSON.stringify(JSON.parse(args)); } catch (err) { this.core?.log?.('warn', '[ContextManager] Failed to format tool args: ' + (err?.message || 'unknown')); }
          return `${tc.name}(${args.slice(0, 100)})`;
        }).join(', ');
        return `[${role}] called tools: ${tools}. ${content}`;
      }
      if (m.tool_call_id) return `[${role}] tool result: ${content.slice(0, 500)}`;
      return `[${role}] ${content}`;
    }).join('\n').slice(0, 8000);
  }

  _buildCompressTool() {
    return {
      name: 'tool-compress-memory',
      description: 'Compress conversation into a detailed retention-oriented summary',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Structured summary covering: discussed topics & conclusions, files created or modified with paths, key decisions made, user preferences or requirements. 3-6 paragraphs, preserve factual details.' },
        },
        required: ['summary'],
      },
    };
  }

  _extractSummary(result) {
    // 失败结果不得被当成摘要：`[API Error] …` 一旦存下，之后每轮都会以 `## Conversation Summary`
    // 注入 system prompt；"本轮没摘到"要返回空串走失败分支。
    if (result?.error) return '';
    const tc = result?.tool_calls?.[0];
    if (!tc) {
      return (result?.content || '').trim();
    }
    try {
      const args = JSON.parse(tc.arguments || '{}');
      return (args.summary || '').trim();
    } catch {
      return '';
    }
  }

  _estimateMessageTokens(msg) {
    let total = this._estimateTokens(msg.content || '');
    if (msg.tool_calls) {
      total += JSON.stringify(msg.tool_calls).length / 4;
    }
    return total;
  }

  _slidingWindow(messages, available) {
    // **按轮收放，不按条收**：逐条收会把切点落在 `assistant(tool_calls)` 与它的 `tool` 结果之间，
    // 上游立刻判请求体非法。分组规则只有一份（`_lib/context-budget.js` 的 `groupIntoTurns`）——
    // 那里只为声明了 Cell 预算的会话服务，同一条判据不能有两个入口。
    const groups = groupIntoTurns(messages);
    const result = [];
    let used = 0;
    let firstKept = groups.length;

    for (let i = groups.length - 1; i >= 0; i--) {
      const size = groups[i].reduce((s, m) => s + this._estimateMessageTokens(m), 0);
      // 最近一轮无论多大都留下：裁剪的目的是保住任务，不是保住空白。
      if (used + size > available && i < groups.length - 1) break;
      result.unshift(...groups[i]);
      used += size;
      firstKept = i;
    }

    if (!result.some((m) => m.role === 'user')) {
      for (let i = firstKept - 1; i >= 0; i--) {
        const m = groups[i].find((x) => x.role === 'user');
        if (m) {
          result.unshift(m);
          break;
        }
      }
    }

    return result;
  }

  getUsage(history, tools) {
    const total = history.reduce((s, m) => s + this._estimateMessageTokens(m), 0);
    const toolsTokens = tools?.length ? tools.length * 15 : 0;
    const used = total + toolsTokens + this.reserveTokens;
    return { used, max: this.maxTokens, percent: Math.min(100, Math.round(used / this.maxTokens * 100)) };
  }

  _estimateTokens(text) {
    if (!text) return 0;
    const chinese = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const other = text.length - chinese;
    return Math.ceil(chinese / 1.5 + other / 4);
  }

  _estimateToolTokens(tools) {
    if (!tools.length) return 0;
    const model = this.core?.getService('model');
    if (model?.supportsNativeTools) return 0;
    return tools.length * 15;
  }
}

export default new ContextManager();
