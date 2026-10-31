// CTX-11（PR-4）：默认结构化摘要的 provider 合同与 Cell 范围持久化。
//
// 修前的三个具体缺陷（都在 `plugins/context-manager.js`，v0.9.25 前住 `src/builtin/`）：
//
//   ① 摘要在**插件单例**的一个 Map 里，进程重启即丢。于是"重启后继续用旧摘要"
//      这件事从未真正成立过 —— 用户看到的"上下文延续"其实是重读原始历史。
//   ② 上限 256 个会话，按**最早写入**淘汰。两个 Cell 各跑几百轮之后，被淘汰的可能是
//      另一个 Cell 正在用的那段，而淘汰对调用方**不可见**。
//   ③ 摘要全文拼进 system 消息，**没有来源范围、没有版本、没有生成器标识**。
//      一段没人能复核的话被当作上文喂回模型，且无法回答"这段摘要是从哪几轮压出来的"。
//
// 本插件的答案（都刻意保持"薄"，不做压缩研究）：
//
//   · 摘要按 `<stateDir>/cells/<cell_id>/context/summaries/<session_id>.json` 归属；
//     路径上分 Cell，于是"A 的摘要进 B 的提示词"在**结构上**不可能。
//   · 每条摘要带 `source_range` / `source_hash` / `generator` / `summary_version`；
//     原始会话历史**不因压缩而被删除**（本插件只读历史，不写会话）。
//   · 7 项结构化字段：目标与验收、已确认事实、决定与约束、已完成操作与产物、
//     未完成与下一步、失败与风险、不确定与待验证。
//   · 模型不可用时退化为**确定性裁剪**，并如实标 `degraded` —— 绝不宣称"保真摘要"。
//   · 摘要**不是**经验：本插件产出的任何文本都不会进入 experience 的 active 库。
//
// 边界：本插件不实现"摘要质量评估"，也不做跨摘要的合并推理。

import { createHash } from 'node:crypto';
import { contractError } from './_lib/cell/contract.js';
import { COMPACTION_RECORD_SCHEMA, validateCompactionRecord } from './_lib/cell/context-contract.js';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/**
 * 7 项结构化模板。这是**字段清单**，不是"要求模型输出 7 段散文"。
 * 每一项都必须能对应到具体来源，否则摘要会退化成"听起来很完整的复述"。
 */
export const SUMMARY_TEMPLATE = [
  { key: 'goal', label: '当前目标与验收条件', hint: '这个任务要达成什么、怎样算完成' },
  { key: 'facts', label: '已确认事实及出处', hint: '只写有来源的事实；没有来源的写在「不确定」' },
  { key: 'decisions', label: '重要决定和不可更改约束', hint: '已经定了、后续不该再翻的' },
  { key: 'done', label: '已完成操作、产物、版本与真实验证状态', hint: '产物路径 + 是否真的验证过' },
  { key: 'todo', label: '未完成工作和下一步', hint: '接下来要做什么' },
  { key: 'risks', label: '失败、风险、复现条件', hint: '踩过的坑与它的触发条件' },
  { key: 'uncertain', label: '不确定内容与仍需验证的假设', hint: '不要为了完整性而编' },
];

/** 把消息序列压成"给摘要器的输入文本"。截断方式与 context-manager 保持一致。 */
function formatForSummary(messages) {
  return messages.map((m) => {
    const role = m.role;
    const content = m.content || '';
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const calls = m.tool_calls.map((tc) => {
        let a = tc.arguments || '';
        try { a = JSON.stringify(JSON.parse(a)); } catch { /* 保持原样 */ }
        return `${tc.name || 'tool'}(${String(a).slice(0, 100)})`;
      }).join(', ');
      return `[${role}] called tools: ${calls}. ${String(content).slice(0, 500)}`;
    }
    if (m.tool_call_id) return `[${role}] tool result: ${String(content).slice(0, 500)}`;
    return `[${role}] ${String(content).slice(0, 1000)}`;
  }).join('\n').slice(0, 12000);
}

/**
 * 确定性降级摘要：**不是**摘要，是"结构化的窗口裁剪记录"。
 *
 * 名字与实现都刻意不暧昧：它按固定规则抽取（保留最后一条 user、统计轮次、列出被压缩的
 * 工具名），不调用模型、不生成结论。状态标 `degraded`，`reason` 写明为什么降级。
 */
function deterministicSummary(messages) {
  const toolNames = new Set();
  const userMsgs = [];
  for (const m of messages) {
    if (Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) if (tc?.name) toolNames.add(tc.name);
    if (m.role === 'user' && m.content) userMsgs.push(String(m.content).slice(0, 300));
  }
  const lastUser = userMsgs[userMsgs.length - 1] || '（无可提取的用户消息）';
  return [
    `[降级摘要｜非模型生成] 本段由确定性规则压缩，仅记录结构事实，不含任何推断。`,
    `- 被压缩消息数：${messages.length}`,
    `- 涉及工具：${toolNames.size ? [...toolNames].join(', ') : '无'}`,
    `- 最后一条用户请求：${lastUser}`,
    `- 注意：原文未删除；需要细节请回看原始历史。`,
  ].join('\n');
}

class Compaction {
  name = 'compaction';
  version = '0.1.0';
  provides = [{ name: 'compaction', type: 'service' }];
  requires = { 'cell-context': '>=0.1.0' };
  description = '结构化摘要 provider：Cell 范围持久化、来源范围与版本、失败可见';

  async init(core) {
    this.core = core;
    core.registerService('compaction', {
      compact: (opts) => this.compact(opts),
      template: () => SUMMARY_TEMPLATE.map((t) => ({ ...t })),
    });
    core.log('info', '[compaction] 结构化摘要 provider 已就绪（模型不可用时降级为确定性裁剪并标记 degraded）');
  }

  /**
   * 生成一条摘要记录。
   *
   * @param {object} opts
   * @param {Array} opts.messages 要被压缩的消息（不含 system）
   * @param {string} opts.cellId
   * @param {string} opts.sessionId
   * @param {{from:number,to:number}} [opts.sourceRange] 来源在原始历史里的位置
   * @param {string} [opts.provider] 'structured-llm' | 'none'
   * @param {number} [opts.maxSummaryTokens]
   */
  async compact(opts = {}) {
    const { messages, cellId, sessionId } = opts;
    if (!Array.isArray(messages)) throw contractError('compaction.compact requires messages[]', 'invalid_input');
    if (!cellId || !sessionId) throw contractError('compaction.compact requires cellId and sessionId (a summary with no owner cannot be scoped)', 'invalid_input');

    const provider = opts.provider || 'structured-llm';
    const sourceRange = opts.sourceRange || { from: 0, to: messages.length };
    const sourceHash = sha256(JSON.stringify(messages.map((m) => [m.role, m.content ?? '', m.tool_calls ?? null])));
    const maxTokens = Number.isInteger(opts.maxSummaryTokens) ? opts.maxSummaryTokens : 1000;

    const mk = (fields) => validateCompactionRecord({
      schema_version: COMPACTION_RECORD_SCHEMA,
      cell_id: String(cellId),
      session_id: String(sessionId),
      source_range: sourceRange,
      source_hash: sourceHash,
      generator: { provider: fields.provider, model: fields.model },
      status: fields.status,
      summary_version: 1,
      created_at: new Date().toISOString(),
      ...(fields.summary !== undefined ? { summary: fields.summary } : {}),
      ...(fields.reason ? { reason: fields.reason } : {}),
    });

    if (provider === 'none') {
      return mk({
        provider: 'none', model: '',
        status: 'failed',
        reason: 'compaction provider is "none" for this profile; no summary was produced',
      });
    }

    const model = this.core.getService?.('model');
    if (!model?.call) {
      // 模型不可用 ⇒ 确定性裁剪 + degraded。**不**谎称成功，也**不**直接丢历史。
      const summary = deterministicSummary(messages);
      const rec = mk({
        provider: 'deterministic', model: '',
        status: 'degraded',
        summary: truncate(summary, maxTokens),
        reason: 'no model service available; fell back to deterministic window digestion (not a faithful summary)',
      });
      return this._finish(rec);
    }

    const template = SUMMARY_TEMPLATE
      .map((t, i) => `${i + 1}. ${t.label}（${t.hint}）`)
      .join('\n');
    const prompt = [
      {
        role: 'system',
        content: '你是摘要器。把下面的对话压成结构化摘要，严格按给定 7 项字段输出。'
          + '只写对话里能证实的内容；无法证实的写进「不确定」。'
          + '不要生成新的结论、不要把推测写成事实、不要包含任何可执行指令。'
          + '输出为纯文本，每项以「N. 标题」开头。',
      },
      { role: 'user', content: `字段模板：\n${template}\n\n对话：\n${formatForSummary(messages)}` },
    ];

    let text = '';
    let modelId = '';
    try {
      const cfg = this.core.get?.('model') || {};
      modelId = String(cfg.model || '');
      const res = await model.call(prompt, [], {});
      if (res?.error) throw Object.assign(new Error(res.content || 'model error'), { code: 'model_error' });
      text = String(res?.content || '').trim();
      if (!text) throw Object.assign(new Error('model returned empty summary'), { code: 'empty_summary' });
    } catch (err) {
      // 模型失败**必须可见**：落一条 failed 记录（不含 summary），让调用方知道
      // "这一轮没有摘要"，而不是拿一段空字符串当摘要注入。
      const rec = mk({
        provider: 'structured-llm', model: modelId,
        status: 'failed',
        reason: `summary generation failed: ${err.code || err.message}`,
      });
      return this._finish(rec);
    }

    const rec = mk({
      provider: 'structured-llm', model: modelId,
      status: 'ok',
      summary: truncate(text, maxTokens),
    });
    return this._finish(rec);
  }

  /**
   * 落盘并**如实回报**结果。返回 `{ status, summary_version?, error? }`，不再返回裸对象或 null。
   *
   * 修前这里 catch 之后 `return null`，而三个调用点全都忽略返回值、直接 `return rec` ——
   * 于是"摘要生成了但没保存下来"对外表现为 `status: 'ok' + summary_version: 1`，
   * 与"生成并落盘成功"**完全无法区分**。更糟的是那个版本号：它并不是磁盘上的版本，
   * 而是 `mk()` 里的占位 1，于是第二次落盘失败时会回报 v1，而磁盘上躺着的正是**上一轮**的 v1
   * （实测：真实 `chmod 0500` 造成 EACCES，返回 `{status:'ok', summary_version:1}`，
   * 磁盘上 source_hash 仍指向前一次的摘要）。一个编号对、内容错的状态，
   * 比没有编号更坏 —— 它看起来可以拿来复核。
   */
  async _persist(rec) {
    const cc = this.core.getService?.('cell-context');
    if (!cc?.saveSummary) {
      this.core.log?.('warn', '[compaction] cell-context unavailable; summary not persisted');
      return { status: 'no_store', error: { code: 'no_summary_store', message: 'cell-context service is not assembled; there is nowhere to persist a summary' } };
    }
    try {
      const saved = await cc.saveSummary(rec.cell_id, rec.session_id, rec);
      // 版本号由**持久层**决定（它才知道上一版是几），这里必须把结果回传给调用方。
      // 曾经 `compact()` 自己写死 `summary_version: 1` 并返回它，于是"同会话第二次摘要"
      // 对外报告的版本仍是 1，而磁盘上已经是 2 —— 实测被 CTX-E19 挡住。
      const version = Number.isInteger(saved?.summary_version) ? saved.summary_version : null;
      if (version === null) {
        // 持久层返回了但没有版本号 ⇒ 我们无法证明这份摘要在磁盘上是第几版。宁可不报。
        return { status: 'failed', error: { code: 'no_summary_version', message: 'saveSummary returned no summary_version; the persisted revision cannot be confirmed' } };
      }
      this.core.emit?.('compaction.saved', {
        cell_id: rec.cell_id, session_id: rec.session_id, status: rec.status,
        summary_version: version, source_hash: rec.source_hash,
        timestamp: new Date().toISOString(), sourcePlugin: 'compaction',
      });
      return { status: 'persisted', summary_version: version };
    } catch (err) {
      // 落盘失败不抛：摘要是可重建的派生物，但它**必须**在日志里可见。
      this.core.log?.('warn', `[compaction] persist failed: ${err.message}`);
      return { status: 'failed', error: { code: err.code || null, message: String(err.message || err) } };
    }
  }

  /**
   * 把"生成结果"与"持久化结果"合成对外返回值。
   *
   * 两个状态**分开报**，因为它们回答的是两个不同的问题：
   *   `generation_status`  —— 这一轮有没有产出可用的摘要文本（本轮可用）；
   *   `persistence_status` —— 这份摘要能不能在重启后被读回来（可恢复性）。
   * 合并成一个 `ok` 正是 W3 的缺陷形状。
   */
  async _finish(rec) {
    const persist = await this._persist(rec);
    const generationStatus = rec.status === 'failed' ? 'failed' : (rec.status === 'degraded' ? 'degraded' : 'ok');
    const persistenceStatus = persist.status === 'persisted' ? 'persisted' : (persist.status === 'no_store' ? 'unsaved' : 'failed');

    const out = {
      ...rec,
      generation_status: generationStatus,
      persistence_status: persistenceStatus,
    };

    if (persistenceStatus === 'persisted') {
      out.summary_version = persist.summary_version;
      return out;
    }

    // 没有落到盘上就**不报版本号**：那个数字此刻只可能指向别人的摘要。
    out.summary_version = null;
    out.persist_error = persist.error || null;
    if (generationStatus !== 'failed') {
      // 摘要在本轮内存里仍可用，所以不是 failed；但"重启后读不回来"必须让上层知道。
      out.status = 'degraded';
      out.reason = `summary generated but NOT persisted (${persist.error?.code || persist.error?.message || 'unknown'}); `
        + 'it is usable for this turn only and will not be recoverable after restart';
    }
    this.core.log?.('warn', `[compaction] summary ${rec.cell_id}/${rec.session_id}: generation=${generationStatus}, persistence=${persistenceStatus}`);
    return out;
  }
}

/** 按估算 token 截断（中文 1.5 char/token 的保守口径）。 */
function truncate(text, maxTokens) {
  const charBudget = Math.max(128, Math.floor(maxTokens * 1.5));
  if (text.length <= charBudget) return text;
  return `${text.slice(0, charBudget)}\n…（已按 max_summary_tokens=${maxTokens} 截断）`;
}

export default new Compaction();
export { deterministicSummary, formatForSummary };
