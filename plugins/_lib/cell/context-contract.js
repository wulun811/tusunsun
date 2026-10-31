// CTX-1（PR-1）：Cell 认知侧合同的**唯一**验证实现 —— ContextProfile / 绑定 / 回执 / 摘要记录 / 经验记录。
//
// 与 cell/contract.js 的关系：那个文件管"执行"（CellSpec/Task/WorkResult），本文件管"认知"
// （这个 Cell 用哪份系统提示词、能看到哪些材料、能读取哪些经验）。两者都是**纯验证器**：
// 不启动进程、不碰文件、不 import core。拆成两个文件不是分类癖——执行合同是安全边界，
// 认知合同是数据边界，混在一起会让"新增一个认知字段"看起来像"修改了安全判据"。
//
// 三条贯穿全文件的判断（也是本轮最容易被做错的地方）：
//
//   ① **Profile 的授权来自宿主，不来自文本**。profile 文件里写什么都不会提升权限；
//      它只是"宿主已经批准的那份配置"的可读形式。所以验证器只校验形状与引用合法性，
//      真正的"这个 Cell 是否被允许用这份 profile"由 cell-context.js 的绑定表回答。
//
//   ② **引用不是路径**。`local:prompts/reviewer.md` 是宿主命名空间里的受限逻辑引用，
//      不是 `file://`、不是 HTTP URL、不提供"顺带读个别的文件"的能力。它必须过
//      `checkRelativeRef`（无绝对路径、无 `..`），再由 provider 在**已授权的根**下解析。
//
//   ③ **未知 major 一律拒绝**，与执行合同同一口径。静默接受未来版本比拒绝更危险：
//      调用方会以为新字段已生效（v0.9.20 的 `permission_mode` 正是这么变成装饰品的）。

import { contractError, checkOpaqueId, checkRelativeRef } from './contract.js';

export const CONTEXT_PROFILE_SCHEMA = 'tusunsun.context-profile/v0';
export const CONTEXT_BINDING_SCHEMA = 'tusunsun.context-binding/v0';
export const CONTEXT_RECEIPT_SCHEMA = 'tusunsun.context-receipt/v0';
export const COMPACTION_RECORD_SCHEMA = 'tusunsun.compaction-record/v0';
export const EXPERIENCE_SCHEMA = 'tusunsun.experience/v0';

/** 只认识 v0。major 不同即拒绝（与 cell/contract.js 的 checkSchema 同语义，此处不重复实现）。 */
const SUPPORTED_MAJOR = 0;

/** 内容提供者。`none` 是**默认值**，表示"这个 Cell 不接外部材料"，不是"出错"。 */
export const CONTEXT_PROVIDERS = ['none', 'local-manifest'];
/** 摘要提供者。`structured-llm` 复用既有 context-manager 的普通模型摘要链路。 */
export const COMPACTION_PROVIDERS = ['none', 'structured-llm'];
/** 经验提供者。`static` = 人工挑选的只读 fixtures（本地文件，不联网）。 */
export const EXPERIENCE_PROVIDERS = ['none', 'static'];

/** 经验生命周期。只有 `active` 可被 lookup/read；其余状态**必须**具名拒绝而不是"查不到"。 */
export const EXPERIENCE_STATES = ['observed', 'candidate', 'reviewed', 'active', 'superseded', 'revoked', 'rejected'];

/** 被动经验注入时机（v0 只支持这三个，不做每轮深检索）。 */
export const EXPERIENCE_TRIGGERS = ['task_start', 'tool_blocked', 'on_demand'];

/** 摘要/装配的诚实状态。`degraded` 与 `failed` 必须能被调用方与"成功"区分开。 */
export const ASSEMBLY_STATUSES = ['assembled', 'degraded', 'failed'];

/** 一个字段都不能少（缺省不等于"用默认"，默认值只在**未出现**时由验证器填）。 */
function schemaOf(spec, expected) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw contractError(`${expected} must be an object`, 'invalid_spec');
  }
  const raw = spec.schema_version;
  if (typeof raw !== 'string' || !raw) {
    throw contractError(`${expected}.schema_version is required (expected "${expected}")`, 'unsupported_schema_version');
  }
  const m = /^tusunsun\.([a-z-]+)\/v(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!m) {
    throw contractError(`schema_version "${raw}" is not of the form tusunsun.<kind>/v<major>[.<minor>]`, 'unsupported_schema_version');
  }
  if (`tusunsun.${m[1]}` !== expected.split('/')[0]) {
    throw contractError(`schema_version "${raw}" is not a ${expected} document`, 'unsupported_schema_version');
  }
  if (Number(m[2]) !== SUPPORTED_MAJOR) {
    throw contractError(
      `schema_version "${raw}" has major ${m[2]}; this build only understands v${SUPPORTED_MAJOR}. `
      + 'Refusing to parse it (a silently-accepted future version makes fields look effective while being ignored).',
      'unsupported_schema_version');
  }
  return { raw, minor: Number(m[3] || 0) };
}

function isPlain(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/** 正整数上限。浮点/字符串/0 一律拒绝 —— 预算写成 `"1000"` 是最常见的"看起来设了"。 */
function intIn(value, what, { min = 1, max = 1e9 } = {}) {
  if (!Number.isInteger(value)) throw contractError(`${what} must be an integer（收到 ${JSON.stringify(value)}）`, 'invalid_spec');
  if (value < min || value > max) throw contractError(`${what} out of range（${value} not in [${min}, ${max}]）`, 'invalid_spec');
  return value;
}

function oneOf(value, allowed, what) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw contractError(`${what} must be one of ${allowed.join('|')}（收到 ${JSON.stringify(value)}）`, 'invalid_spec');
  }
  return value;
}

/**
 * 受限逻辑引用：`<namespace>:<relative/path>`。
 *
 * 只有 `local` 一个命名空间。这不是"以后可以加 http"，而是**刻意只有一个**：
 * 每多一个命名空间，就多一条"谁来保证那个协议不出网"的问题，而 v0 的答案只有"宿主本地文件"。
 * 路径部分一律过 checkRelativeRef（绝对路径 / `..` / 空段 全拒），provider 再在授权根下解析。
 */
export function checkProviderRef(value, what) {
  if (typeof value !== 'string' || !value) throw contractError(`${what} is required`, 'invalid_ref');
  if (value.length > 2048) throw contractError(`${what} too long`, 'invalid_ref');
  const m = /^([a-z][a-z0-9-]*):(.+)$/.exec(value);
  if (!m) throw contractError(`${what} must look like "local:<relative/path>"（收到 "${value.slice(0, 80)}"）`, 'invalid_ref');
  if (m[1] !== 'local') {
    throw contractError(
      `${what} uses namespace "${m[1]}"; this build only resolves "local:" refs. `
      + 'A URL, file:// or absolute path is NOT a resource reference (it would make a config field into an outbound fetch).',
      'invalid_ref');
  }
  // 校验路径部分，但**返回原样的完整引用**。这里曾把 checkRelativeRef 的返回值直接当结果，
  // 于是 `local:prompts/reviewer.md` 归一化成 `prompts/reviewer.md` —— 命名空间被悄悄剥掉，
  // 下游再按"没有命名空间的裸路径"解析。这类"验证器顺手改写了值"的缺陷在断言里很难看出来
  // （形状对、字段在、就是语义变了），所以在此显式钉一句。
  checkRelativeRef(m[2], `${what} path`);
  return value;
}

// ── ContextProfile ──────────────────────────────────────────────────────
/**
 * 校验 ContextProfile，返回**归一化副本**（不改入参）。
 *
 * 数值全部是"初始建议上限"，不是性能研究结论 —— 报告与文档必须保持这个措辞，
 * 否则下一轮会有人把它们当成"已调优的常量"。
 */
export function validateContextProfile(profile) {
  schemaOf(profile, CONTEXT_PROFILE_SCHEMA);
  const profile_id = checkOpaqueId(profile.profile_id, 'profile_id');
  const system_prompt_ref = checkProviderRef(profile.system_prompt_ref, 'system_prompt_ref');

  const retrievalRaw = profile.retrieval === undefined ? {} : profile.retrieval;
  if (!isPlain(retrievalRaw)) throw contractError('retrieval must be an object', 'invalid_spec');
  const provider = retrievalRaw.provider === undefined ? 'none' : oneOf(retrievalRaw.provider, CONTEXT_PROVIDERS, 'retrieval.provider');
  const mode = retrievalRaw.mode === undefined ? 'on-demand' : oneOf(retrievalRaw.mode, ['on-demand', 'off'], 'retrieval.mode');
  const mapMax = retrievalRaw.map_max_tokens === undefined ? 300 : intIn(retrievalRaw.map_max_tokens, 'retrieval.map_max_tokens', { min: 32, max: 32000 });
  const pullMax = retrievalRaw.pull_max_tokens === undefined ? 1600 : intIn(retrievalRaw.pull_max_tokens, 'retrieval.pull_max_tokens', { min: 64, max: 128000 });
  if (pullMax < mapMax) {
    throw contractError('retrieval.pull_max_tokens must be >= map_max_tokens（否则"按需读取"比目录还小）', 'invalid_spec');
  }

  const compRaw = profile.compaction === undefined ? {} : profile.compaction;
  if (!isPlain(compRaw)) throw contractError('compaction must be an object', 'invalid_spec');
  const compProvider = compRaw.provider === undefined ? 'none' : oneOf(compRaw.provider, COMPACTION_PROVIDERS, 'compaction.provider');
  const maxSummary = compRaw.max_summary_tokens === undefined ? 1000 : intIn(compRaw.max_summary_tokens, 'compaction.max_summary_tokens', { min: 64, max: 64000 });

  const expRaw = profile.experience === undefined ? {} : profile.experience;
  if (!isPlain(expRaw)) throw contractError('experience must be an object', 'invalid_spec');
  const expProvider = expRaw.provider === undefined ? 'none' : oneOf(expRaw.provider, EXPERIENCE_PROVIDERS, 'experience.provider');
  const passive = expRaw.passive === undefined ? 'relevant-only' : oneOf(expRaw.passive, ['off', 'relevant-only'], 'experience.passive');
  const maxHints = expRaw.max_hints === undefined ? 2 : intIn(expRaw.max_hints, 'experience.max_hints', { min: 0, max: 8 });
  const hintsMax = expRaw.hints_max_tokens === undefined ? 180 : intIn(expRaw.hints_max_tokens, 'experience.hints_max_tokens', { min: 32, max: 8000 });
  const activePull = expRaw.active_pull === undefined ? true : expRaw.active_pull;
  if (typeof activePull !== 'boolean') throw contractError('experience.active_pull must be a boolean', 'invalid_spec');

  const budgetRaw = profile.budget === undefined ? {} : profile.budget;
  if (!isPlain(budgetRaw)) throw contractError('budget must be an object', 'invalid_spec');
  const inputMax = budgetRaw.input_max_tokens === undefined ? 8192 : intIn(budgetRaw.input_max_tokens, 'budget.input_max_tokens', { min: 256, max: 2000000 });
  const reserve = budgetRaw.response_reserve_tokens === undefined ? 1200 : intIn(budgetRaw.response_reserve_tokens, 'budget.response_reserve_tokens', { min: 0, max: 1000000 });
  if (reserve >= inputMax) {
    throw contractError('budget.response_reserve_tokens must be < input_max_tokens（否则输入预算为负）', 'invalid_spec');
  }

  // `projectId` 是**作用域声明**，不是装饰：经验的可见性以它为准（跨项目不可见）。
  // 曾经它被写成 profile 里的一个自由字段，而验证器不认识它 ⇒ 被静默丢弃，
  // 于是"这条经验属于 project-alpha"在读取时无从判断（实测跨项目经验照样命中）。
  // 现在纳入合同：非法值具名拒绝，缺省为 null（= 只看全局经验）。
  let projectId = null;
  if (expRaw.projectId !== undefined && expRaw.projectId !== null) {
    if (typeof expRaw.projectId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/.test(expRaw.projectId)) {
      throw contractError('experience.projectId must be an opaque id (letters/digits/._@+-)', 'invalid_spec');
    }
    projectId = expRaw.projectId;
  }
  // `provider: none` 时 passive/active_pull 一律视为未启用。这里**不报错**，
  // 而是把它们归一成 off/false —— 但调用方不得据此显示"经验已启用"（见 context-port 的暴露判据）。
  const expEnabled = expProvider !== 'none';

  return {
    schema_version: CONTEXT_PROFILE_SCHEMA,
    profile_id,
    system_prompt_ref,
    retrieval: { provider, mode, map_max_tokens: mapMax, pull_max_tokens: pullMax },
    compaction: { provider: compProvider, max_summary_tokens: maxSummary },
    experience: {
      provider: expProvider,
      projectId,
      passive: expEnabled ? passive : 'off',
      max_hints: expEnabled ? maxHints : 0,
      hints_max_tokens: hintsMax,
      active_pull: expEnabled ? activePull : false,
    },
    budget: { input_max_tokens: inputMax, response_reserve_tokens: reserve },
  };
}

/** 一个 profile 的**内容指纹**。绑定表与回执都用它，不是用"版本号"来假装可复核。 */
export function profileFingerprint(normalized) {
  const stable = JSON.stringify([
    normalized.profile_id,
    normalized.system_prompt_ref,
    normalized.retrieval, normalized.compaction, normalized.experience, normalized.budget,
  ]);
  // 这里刻意用同步的 sha256 之外的最简实现：调用方（cell-context）在 Node 侧用 createHash 覆盖。
  // 保留纯函数签名是为了让验证器本身零 IO、可被任何宿主复用。
  return stable;
}

// ── 绑定 ────────────────────────────────────────────────────────────────
/** 绑定记录：`cell_id → profile_id + version + sha256`。这是"宿主授权"的**可复核形式**。 */
export function validateContextBinding(binding) {
  schemaOf(binding, CONTEXT_BINDING_SCHEMA);
  const cell_id = checkOpaqueId(binding.cell_id, 'cell_id');
  const profile_id = checkOpaqueId(binding.profile_id, 'profile_id');
  const version = intIn(binding.version, 'version', { min: 1, max: 1e9 });
  const sha = binding.system_prompt_sha256;
  if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/.test(sha)) {
    throw contractError('system_prompt_sha256 must be 64 lowercase hex chars（回执要能复核内容，不是只记文件名）', 'invalid_spec');
  }
  if (typeof binding.bound_at !== 'string' || !binding.bound_at) throw contractError('bound_at is required', 'invalid_spec');
  // `profile_sha256` 是 profile **定义文件**的哈希，与 `system_prompt_sha256`（注入内容）
  // 是两件事：前者答"配置有没有被改"，后者答"模型读到的是哪一版文字"。
  // 曾经这里只有一个字段并被填成前者，于是"内容漂移"检查恒为假阳性 —— 两个哈希按定义不等。
  const pHash = binding.profile_sha256;
  if (pHash !== undefined && pHash !== null && (typeof pHash !== 'string' || !/^[0-9a-f]{64}$/.test(pHash))) {
    throw contractError('profile_sha256 must be 64 lowercase hex chars when present', 'invalid_spec');
  }
  return {
    schema_version: CONTEXT_BINDING_SCHEMA,
    cell_id, profile_id, version,
    system_prompt_sha256: sha,
    ...(pHash ? { profile_sha256: pHash } : {}),
    bound_at: binding.bound_at,
    ...(binding.previous ? { previous: binding.previous } : {}),
  };
}

// ── 回执 ────────────────────────────────────────────────────────────────
/**
 * ContextReceipt：装配**元数据**，不是装配内容。
 *
 * 刻意不记录系统提示词正文或检索正文：回执会落盘（`receipts.jsonl`），
 * 把正文写进去等于把敏感材料复制到第二个地方。要复核内容请用 ref + hash。
 */
export function validateContextReceipt(receipt) {
  schemaOf(receipt, CONTEXT_RECEIPT_SCHEMA);
  const status = oneOf(receipt.status, ASSEMBLY_STATUSES, 'status');
  const refs = Array.isArray(receipt.source_refs) ? receipt.source_refs : [];
  if (refs.length > 256) throw contractError('source_refs too many（>256）', 'invalid_spec');
  for (const [i, r] of refs.entries()) {
    if (typeof r !== 'string' || !r) throw contractError(`source_refs[${i}] must be a non-empty string`, 'invalid_spec');
  }
  const inj = receipt.injection || {};
  const budget = receipt.budget || {};
  return {
    schema_version: CONTEXT_RECEIPT_SCHEMA,
    cell_id: checkOpaqueId(receipt.cell_id, 'cell_id'),
    incarnation_id: checkOpaqueId(receipt.incarnation_id, 'incarnation_id'),
    task_id: checkOpaqueId(receipt.task_id, 'task_id'),
    profile_id: checkOpaqueId(receipt.profile_id, 'profile_id'),
    profile_sha256: (() => {
      const v = receipt.profile_sha256;
      if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v)) throw contractError('profile_sha256 must be 64 lowercase hex chars', 'invalid_spec');
      return v;
    })(),
    source_refs: refs,
    injection: {
      map_items: intIn(inj.map_items ?? 0, 'injection.map_items', { min: 0, max: 1000 }),
      experience_hints: intIn(inj.experience_hints ?? 0, 'injection.experience_hints', { min: 0, max: 100 }),
      pulled_refs: intIn(inj.pulled_refs ?? 0, 'injection.pulled_refs', { min: 0, max: 1000 }),
      compacted: inj.compacted === true,
    },
    budget: {
      estimate_used: intIn(budget.estimate_used ?? 0, 'budget.estimate_used', { min: 0, max: 100000000 }),
      limit: intIn(budget.limit ?? 1, 'budget.limit', { min: 1, max: 100000000 }),
      reserve: intIn(budget.reserve ?? 0, 'budget.reserve', { min: 0, max: 100000000 }),
    },
    status,
    ...(receipt.reason ? { reason: String(receipt.reason).slice(0, 2000) } : {}),
  };
}

// ── 摘要记录 ────────────────────────────────────────────────────────────
/**
 * CompactionRecord：摘要的**来源与生成事实**。
 *
 * 关键字段是 `source_message_ids`（或 `source_hash`）与 `generator`：
 * 没有来源范围的摘要是"一段没人能复核的话"，而它会被当作上文喂回模型。
 * `status` 必须区分 `ok` / `degraded` / `failed` —— 模型不可用时退化成窗口裁剪
 * 是允许的，把裁剪说成"保真摘要"不允许。
 */
export function validateCompactionRecord(record) {
  schemaOf(record, COMPACTION_RECORD_SCHEMA);
  const status = oneOf(record.status, ['ok', 'degraded', 'failed'], 'status');
  const sourceRange = record.source_range || {};
  const from = intIn(sourceRange.from ?? 0, 'source_range.from', { min: 0, max: 1e9 });
  const to = intIn(sourceRange.to ?? 0, 'source_range.to', { min: 0, max: 1e9 });
  const out = {
    schema_version: COMPACTION_RECORD_SCHEMA,
    cell_id: checkOpaqueId(record.cell_id, 'cell_id'),
    session_id: checkOpaqueId(record.session_id, 'session_id'),
    source_range: { from, to },
    source_hash: (() => {
      const v = record.source_hash;
      if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v)) throw contractError('source_hash must be 64 lowercase hex chars', 'invalid_spec');
      return v;
    })(),
    generator: (() => {
      const g = record.generator;
      if (!isPlain(g)) throw contractError('generator is required（{provider, model}）', 'invalid_spec');
      return { provider: String(g.provider || ''), model: String(g.model || '') };
    })(),
    status,
    summary_version: intIn(record.summary_version ?? 1, 'summary_version', { min: 1, max: 1e6 }),
    created_at: (() => {
      if (typeof record.created_at !== 'string' || !record.created_at) throw contractError('created_at is required', 'invalid_spec');
      return record.created_at;
    })(),
    ...(typeof record.summary === 'string' ? { summary: record.summary } : {}),
    ...(record.reason ? { reason: String(record.reason).slice(0, 2000) } : {}),
  };
  if (status !== 'failed' && typeof out.summary !== 'string') {
    throw contractError('a non-failed compaction record must carry the summary text（否则"成功"没有产物）', 'invalid_spec');
  }
  return out;
}

// ── 经验 ────────────────────────────────────────────────────────────────
/**
 * ExperienceRecord：一条**已批准可用**的经验（或其候选/撤销版本）。
 *
 * 这里只校验"形状 + 必填证据"。质量判断（是否值得保留、是否可迁移）**不在土行孙内**：
 * 那是经验层的职责，本文件只保证"土行孙不会消费一条没有证据、没有适用条件的经验"。
 */
export function validateExperienceRecord(rec) {
  schemaOf(rec, EXPERIENCE_SCHEMA);
  const status = oneOf(rec.status, EXPERIENCE_STATES, 'status');
  const scope = rec.scope;
  if (!isPlain(scope)) throw contractError('scope is required（经验不跨项目）', 'invalid_spec');
  const envTags = Array.isArray(scope.environment_tags) ? scope.environment_tags : [];
  if (envTags.length > 32) throw contractError('scope.environment_tags too many', 'invalid_spec');
  for (const t of envTags) if (typeof t !== 'string' || !t) throw contractError('scope.environment_tags must be non-empty strings', 'invalid_spec');
  const evidence = Array.isArray(rec.evidence_refs) ? rec.evidence_refs : [];
  if (evidence.length === 0) {
    throw contractError('evidence_refs is required and must be non-empty（没有证据的"经验"只是意见）', 'invalid_spec');
  }
  if (evidence.length > 64) throw contractError('evidence_refs too many', 'invalid_spec');
  for (const [i, e] of evidence.entries()) {
    if (typeof e !== 'string' || !e) throw contractError(`evidence_refs[${i}] must be a non-empty string`, 'invalid_spec');
  }
  const strArr = (v, what, max = 32) => {
    const a = Array.isArray(v) ? v : [];
    if (a.length > max) throw contractError(`${what} too many`, 'invalid_spec');
    for (const s of a) if (typeof s !== 'string' || !s) throw contractError(`${what} must be non-empty strings`, 'invalid_spec');
    return [...a];
  };
  return {
    schema_version: EXPERIENCE_SCHEMA,
    experience_id: checkOpaqueId(rec.experience_id, 'experience_id'),
    revision: intIn(rec.revision === undefined ? 1 : rec.revision, 'revision', { min: 1, max: 1e6 }),
    status,
    scope: {
      project_id: typeof scope.project_id === 'string' && scope.project_id ? scope.project_id : null,
      environment_tags: [...envTags],
      visibility: oneOf(scope.visibility === undefined ? 'project' : scope.visibility, ['project', 'host'], 'scope.visibility'),
    },
    kind: typeof rec.kind === 'string' && rec.kind ? rec.kind : 'failure-lesson',
    title: (() => {
      if (typeof rec.title !== 'string' || !rec.title.trim()) throw contractError('title is required', 'invalid_spec');
      if (rec.title.length > 512) throw contractError('title too long（>512）', 'invalid_spec');
      return rec.title;
    })(),
    trigger: strArr(rec.trigger, 'trigger'),
    lesson: (() => {
      if (typeof rec.lesson !== 'string' || !rec.lesson.trim()) throw contractError('lesson is required', 'invalid_spec');
      if (rec.lesson.length > 4000) throw contractError('lesson too long（>4000）', 'invalid_spec');
      return rec.lesson;
    })(),
    applies_when: strArr(rec.applies_when, 'applies_when'),
    does_not_apply_when: strArr(rec.does_not_apply_when, 'does_not_apply_when'),
    ...(typeof rec.suggested_check === 'string' && rec.suggested_check ? { suggested_check: rec.suggested_check.slice(0, 2000) } : {}),
    evidence_refs: [...evidence],
    ...(Array.isArray(rec.source_result_refs) && rec.source_result_refs.length
      ? { source_result_refs: strArr(rec.source_result_refs, 'source_result_refs') } : {}),
    ...(typeof rec.reviewed_by === 'string' && rec.reviewed_by ? { reviewed_by: rec.reviewed_by } : {}),
    valid_until: rec.valid_until === undefined ? null : rec.valid_until,
  };
}

/** 只有 `active` 且未过期才可被召回。其余状态**具名拒绝**（不是"没找到"）。 */
export function assertExperienceUsable(rec, { now = Date.now() } = {}) {
  if (rec.status !== 'active') {
    throw contractError(
      `experience "${rec.experience_id}" is ${rec.status}; only "active" records may be injected or read. `
      + 'A candidate is not knowledge yet, and a revoked record must fail by name (not silently disappear).',
      'experience_unavailable');
  }
  if (rec.valid_until) {
    const until = Date.parse(rec.valid_until);
    if (Number.isFinite(until) && until <= now) {
      throw contractError(`experience "${rec.experience_id}" expired at ${rec.valid_until}`, 'experience_expired');
    }
  }
  return rec;
}
