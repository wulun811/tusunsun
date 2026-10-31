// CTX-8（PR-2）：**最终模型请求**的统一预算校验 —— 关闭"注入后预算失效"的老问题。
//
// 事实（修前，v0.9.21 及以前），`haotian-lite._buildMessagesWith()` 的顺序是：
//
//     messages = [systemMsg, ...history]
//     messages = await contextMgr.trimMessages(messages, ...)   ← 预算在这里算
//     extras   = pc.getContextualMessages(sessionId, messages)  ← 之后才注入
//     messages.splice(1, 0, ...extras)                          ← 注入内容不计入预算
//
// 于是"这一轮到底会不会超窗"没有任何一处说得清：裁剪按 A 算，实际发出去的是 A + B。
// 服务端报 400 时，本地日志显示"在预算内"。计划 §7.1 要求"所有内容进入最终 ModelRequest
// 之前做一次完整预算验算"，本文件就是那一次。
//
// 设计上的三个刻意选择：
//
//   ① **纯函数**。`enforceBudget()` 不读文件、不调模型、不改入参 —— 它只回答
//      "这份 messages 在给定预算下要不要裁、裁哪些、裁完是什么形状"。这样它可以被
//      单测直接喂极端输入（CTX-E20），而不需要拉起整条链路。
//   ② **系统消息永不裁剪**。它是 Host Policy 与 Cell 身份的载体。裁掉它换来的空间
//      是"用资料替换身份"，这正是计划 §7.2 里第 1 条优先级所禁止的。
//      系统消息**单独**就超预算时，唯一的诚实处置是具名失败 `context_budget_exceeded`。
//   ③ **裁剪顺序显式**。从最不重要的往回收：地图/经验提示（role=system 但带 source 标记）
//      → 最旧的 assistant/tool 对 → 最旧的 user。工具调用与它的结果必须**成对**保留或
//      成对丢弃：留下一个孤立的 `tool` 消息会被上游 400（"tool message without
//      preceding tool_calls"），而那是比超窗更难诊断的故障。
//
// 诚实边界：
//   · 用字符近似估算（与 context-manager 同口径），不是真实 tokenizer。差额靠 reserve 吸收。
//   · 本文件不做摘要。摘要由 context-manager / compaction provider 负责；这里只保证
//     "发出去的东西装得下"。

/** 与 context-manager 同一口径（中文 1.5 char/token，其余 4 char/token）。 */
export function estimateTokens(text) {
  if (!text) return 0;
  const s = String(text);
  const chinese = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  return Math.ceil(chinese / 1.5 + (s.length - chinese) / 4);
}

/** 一条消息的估算量：content + tool_calls 的 JSON 体积。 */
export function estimateMessageTokens(m) {
  if (!m) return 0;
  let t = estimateTokens(m.content || '');
  if (m.tool_calls) t += Math.ceil(JSON.stringify(m.tool_calls).length / 4);
  return t;
}

export function estimateMessagesTokens(messages) {
  return (messages || []).reduce((s, m) => s + estimateMessageTokens(m), 0);
}

/**
 * 把"工具调用"与其"工具结果"绑成组，裁剪时以组为单位。
 *
 * 一个 assistant 消息带 `tool_calls` 时，紧随其后的若干 `role:'tool'` 消息是它的结果。
 * 把它们当成独立消息裁，就可能留下孤立的 tool 结果 —— 上游会直接 400。
 * 返回的是**组**数组，每组内部必须同进同出。
 */
export function groupIntoTurns(messages) {
  const groups = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const group = [m];
      let j = i + 1;
      while (j < messages.length && messages[j].role === 'tool') { group.push(messages[j]); j++; }
      groups.push(group);
      i = j;
      continue;
    }
    // 孤立的 tool 消息（历史上已经坏了的数据）：单独成组，仍按"可丢"处理，
    // 但绝不与后面的 user 消息合并。
    groups.push([m]);
    i++;
  }
  return groups;
}

/**
 * 对最终模型请求做预算验算。
 *
 * @param {object} input
 * @param {Array} input.messages 已经拼好的完整 messages（第 0 条应为 system）
 * @param {number} input.limit 输入预算上限
 * @param {number} input.reserve 输出预留（不得被输入占用）
 * @param {string[]} [input.protectedRoles] 默认 `['system']`：这些角色的消息永不裁剪
 * @returns {{ok:boolean, messages:Array, dropped:number, estimate_used:number, limit:number,
 *            reserve:number, code?:string, error?:string, dropped_turns?:number}}
 *          `ok:false` 时 `messages` 是**原样**的输入（调用方不得据此发请求）
 */
export function enforceBudget({ messages, limit, reserve = 0, protectedRoles = ['system'] } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  if (!Number.isFinite(limit) || limit <= 0) {
    return {
      ok: false, messages: list, dropped: 0, estimate_used: estimateMessagesTokens(list),
      limit: limit ?? null, reserve, code: 'context_budget_invalid',
      error: `input token limit is not a positive number (${JSON.stringify(limit)})`,
    };
  }
  const available = limit - Math.max(0, reserve);
  const total = estimateMessagesTokens(list);
  if (total <= available) {
    return {
      ok: true, messages: list, dropped: 0, dropped_turns: 0,
      estimate_used: total, limit, reserve,
    };
  }

  // 系统消息是 Host Policy / Cell 身份的载体，先把它单独摘出来核算。
  const prot = new Set(protectedRoles);
  const head = [];
  const rest = [];
  for (const m of list) {
    if (prot.has(m.role) && head.length === 0) head.push(m);
    else rest.push(m);
  }
  const headTokens = estimateMessagesTokens(head);
  if (headTokens > available) {
    // 连"身份"都装不下：不裁、不猜，如实报错。悄悄裁 system 会让模型在没有任何
    // 工作身份的情况下回答，而调用方看到的是一次"正常"的成功。
    return {
      ok: false, messages: list, dropped: 0, estimate_used: total, limit, reserve,
      code: 'context_budget_exceeded',
      error: `system prompt alone needs ~${headTokens} tokens but only ${available} are available `
        + `(limit ${limit} − reserve ${reserve}). Refusing to trim the system prompt: `
        + 'it carries the host policy and the cell identity.',
    };
  }

  // 从最新往回保留，直到装不下；成组丢弃以保住 tool_calls/tool 配对。
  //
  // **一旦装不下就停**（break），不是跳过它继续收更旧的。
  // 修前这里是 `continue`：一个装不下的**当前任务**会被跳过，而更早的短消息继续被收进来，
  // 于是返回 `ok:true` + 一段"没有当前任务、只有陈年对话"的历史。实测（v0.9.22 复核）：
  // system 60 + 两条早期短消息 + 4000 字当前任务、预算总缺口 500 token 时，判成功、
  // 丢的是当前任务。跳过单个元素还会在历史中间留一个**空洞**（前后不自洽）。
  // 现在的语义只有两个：连续的最近窗口，或者明确失败。
  const groups = groupIntoTurns(rest);
  const kept = [];
  let used = headTokens;
  let firstDropped = groups.length;
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    const t = estimateMessagesTokens(g);
    if (used + t > available) { firstDropped = i + 1; break; }
    kept.unshift(...g);
    used += t;
  }
  const droppedTurns = firstDropped;

  // **只省下 system 消息 = 任务无法完成**，不是"装下了"。
  //
  // 这是本轮最容易被漏掉的一条：裁剪逻辑一路能"成功"地丢掉全部历史与当前任务，
  // 最后返回 `{ok:true, messages:[system]}`。模型于是收到一个只有身份的请求、
  // 没有任何任务目标，然后**正常回一段话**——上层看到的是 succeeded，而任务根本没被表达出来。
  // 实测（CTX-E20 第一版）：4000 字任务目标 + 900 token 预算被判 succeeded。
  //
  // 判据：承载任务的 user 消息一条都没留下 ⇒ 具名失败。
  //
  // 修前的判据是 `kept.length === 0`，它只能拦住“只留 system”那一支。实测找到两支绕过：
  //   ① 末尾是一对 assistant+tool（工具刚执行完、下一次模型调用前）⇒ kept 非空，
  //      任务被丢，报 ok:true，保留的是一条孤立的 tool 结果；
  //   ② 中间/末尾插了 system（`plugin-context` 的 extras 正是被 splice(1,0,…) 插进来的）
  //      ⇒ 同上。
  // 两者都是“身份/回溯有了、任务没了”，而调用方看到的是 succeeded。
  // 所以判据必须落在**承载任务的那一类消息**上，而不是“数组非空”。
  const carriedTask = rest.some((m) => m.role === 'user');
  const keptTask = kept.some((m) => m.role === 'user');
  if (kept.length === 0 || (carriedTask && !keptTask)) {
    return {
      ok: false, messages: list, dropped: rest.length, estimate_used: total, limit, reserve,
      code: 'context_budget_exceeded',
      error: `no room for the task itself: ~${headTokens} tokens of system prompt out of ${available} available `
        + `(limit ${limit} − reserve ${reserve}), and every non-system message had to be dropped. `
        + 'Refusing to send a request that carries an identity but no task.',
    };
  }

  return {
    ok: true, messages: [...head, ...kept], dropped: rest.length - kept.length, dropped_turns: droppedTurns,
    estimate_used: used, limit, reserve,
    // 裁过就说裁过：调用方据此可以在回执里写 `compacted/degraded`，而不是假装完整。
    ...(droppedTurns > 0 ? { trimmed: true } : {}),
  };
}
