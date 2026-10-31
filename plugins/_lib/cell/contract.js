// R0-126（G1-1）：Cell 合同的**唯一**解析与验证实现。
//
// 定位（写在这里是因为它最容易被越界解释）：
//   · `Cell` ≠ `Task` ≠ `Session` ≠ `Core` ≠ `Process`。
//       Cell    —— 能持续拥有身份、状态、工作边界和能力视图，独立接受/执行/交付 Task 的**主体**；
//       Task    —— 要完成的工作与验收条件（可失败、可重试、可重派给另一个 Cell）；
//       Session —— Cell 内部的一段工作记忆通道（一个 Cell 可以有多个会话，它们不因此变成多个 Cell）；
//       Core    —— 插件/能力/事件微内核（不是 Agent 角色，也不是调度器）；
//       Process —— 运行时承载（v0 是 1 Cell : 1 Core : 1 OS 进程，这是**部署选择**，不是定义）。
//   · 本文件是**纯验证器**：不启动进程、不碰文件、不 import core。它可以被 CLI、适配器、
//     测试、将来的调度器共用，而不把任何调度策略带进内核。
//   · 合同带 `schema_version`，不认识的 **major** 一律具名拒绝（不猜、不降级解析）：
//     静默接受未来版本比拒绝更危险 —— 调用方会以为新字段已生效。
//
// 为什么验证必须这么严（威胁模型见 docs/architecture/cell-rfc.md）：
//   Task 参数、模型输出、CellSpec 都可能来自**不可信**一侧。凡是能被"写进 JSON 就生效"的东西
//   （工作区、能力、权限模式、路径引用）都必须在这里拒绝，而不是指望下游某处还记得检查。

export const CELL_SCHEMA = 'tusunsun.cell/v0';
export const CELL_STATUS_SCHEMA = 'tusunsun.cell-status/v0';
export const TASK_SCHEMA = 'tusunsun.task/v0';
export const RESULT_SCHEMA = 'tusunsun.result/v0';

/** 支持的 schema（目前只有 v0；major 不同即拒绝，minor 向后兼容地接受）。 */
const SUPPORTED_MAJOR = 0;

/** 能力名：与内核能力 id 同一命名空间（`tool.read` / `tool.write` …），但不等于"已授予"。 */
const CAPABILITY_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

/** Cell / Task 标识：opaque，不具路径语义（与 session_id 同一套判据，见 tools/lib/session-id.mjs）。 */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._@+-]*$/;
const ID_MAX = 128;

/** 首版只支持这些权限模式；`full-auto` 故意不在默认列表里（见 CHANGELOG / SECURITY）。 */
export const PERMISSION_MODES = ['auto', 'ask', 'read-only', 'auto-edit', 'full-auto'];

/** Cell 生命周期状态（单向为主；`faulted` 可从任何非终止态进入）。 */
export const CELL_STATES = ['created', 'ready', 'busy', 'draining', 'stopped', 'faulted'];

/** v0 唯一支持的运行时形态。`shared_process` / `remote` 必须被**明确拒绝**，不是"忽略"。 */
const RUNTIME_KINDS = ['process'];

/** 执行状态。`cancelled` 刻意不存在：杀掉进程不证明外部副作用已撤销（见 cell-rfc.md）。 */
export const EXECUTION_STATES = ['succeeded', 'failed', 'rejected', 'timed_out', 'cancel_requested', 'unknown'];

/** 验收决定由**独立验收器**产生，不是执行者自报。 */
export const ACCEPTANCE_DECISIONS = ['accepted', 'rejected', 'inconclusive'];

/** 合同错误：带 code + contractError，调用方据此回具名 4xx/失败，而不是"一段错误文案"。 */
export function contractError(message, code) {
  return Object.assign(new Error(message), { code, contractError: true });
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** schema_version 校验：不认识的 major 必须**拒绝**（含"没写"）。 */
function checkSchema(spec, expected) {
  if (!isPlainObject(spec)) throw contractError(`${expected} must be an object`, 'invalid_spec');
  const raw = spec.schema_version;
  if (typeof raw !== 'string' || !raw) {
    throw contractError(`${expected}.schema_version is required (expected "${expected}")`, 'unsupported_schema_version');
  }
  const m = /^tusunsun\.([a-z-]+)\/v(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!m) {
    throw contractError(`schema_version "${raw}" is not of the form tusunsun.<kind>/v<major>[.<minor>]`, 'unsupported_schema_version');
  }
  const kind = `tusunsun.${m[1]}`;
  const major = Number(m[2]);
  if (kind !== expected.split('/')[0]) {
    throw contractError(`schema_version "${raw}" is not a ${expected} document`, 'unsupported_schema_version');
  }
  if (major !== SUPPORTED_MAJOR) {
    throw contractError(
      `schema_version "${raw}" has major ${major}; this build only understands v${SUPPORTED_MAJOR}. `
      + 'Refusing to parse it (silently accepting a future version would let fields appear to work while being ignored).',
      'unsupported_schema_version');
  }
  return { raw, major, minor: Number(m[3] || 0) };
}

/** opaque 标识：不能是路径、不能是 `.`/`..`、不能含分隔符或控制字符。 */
export function checkOpaqueId(value, what) {
  if (typeof value !== 'string' || !value) throw contractError(`${what} is required`, 'invalid_id');
  if (value === '.' || value === '..' || value.includes('/') || value.includes('\\')) {
    throw contractError(`${what} must be an opaque ID, not a path（收到 "${value.slice(0, 64)}"）`, 'invalid_id');
  }
  if (value.length > ID_MAX) throw contractError(`${what} too long（${value.length} > ${ID_MAX}）`, 'invalid_id');
  if (!ID_RE.test(value)) {
    throw contractError(`${what} 只允许 ASCII 字母/数字与 . _ @ + -（首字符为字母或数字）：收到 ${JSON.stringify(value.slice(0, 64))}`, 'invalid_id');
  }
  return value;
}

/**
 * Task/Cell 内的**引用路径**：必须是相对路径、不能逃出 Cell 工作区。
 * 绝对路径 / `..` / 空串一律拒绝 —— 这是"任务不能自己扩大工作区"的第一道判据。
 */
export function checkRelativeRef(value, what) {
  if (typeof value !== 'string' || !value) throw contractError(`${what} must be a non-empty relative path`, 'invalid_path');
  if (value.length > 4096) throw contractError(`${what} too long`, 'invalid_path');
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) {
    throw contractError(`${what} must be RELATIVE to the cell workspace（收到绝对路径 "${value.slice(0, 80)}"）`, 'invalid_path');
  }
  // 反斜杠也按分隔符处理（Windows 形态的 `..\` 同样是逃逸）
  const norm = value.replace(/\\/g, '/');
  const parts = norm.split('/');
  if (parts.some((p) => p === '..')) {
    throw contractError(`${what} must not contain ".."（收到 "${value.slice(0, 80)}"）`, 'invalid_path');
  }
  if (parts.some((p) => p === '' && norm !== '')) {
    throw contractError(`${what} must not contain empty segments（收到 "${value.slice(0, 80)}"）`, 'invalid_path');
  }
  return value;
}

function checkStringArray(value, what, { max = 64, pattern = null } = {}) {
  if (!Array.isArray(value)) throw contractError(`${what} must be an array`, 'invalid_spec');
  if (value.length > max) throw contractError(`${what} has too many entries（${value.length} > ${max}）`, 'invalid_spec');
  for (const item of value) {
    if (typeof item !== 'string' || !item) throw contractError(`${what} must contain non-empty strings`, 'invalid_spec');
    if (pattern && !pattern.test(item)) throw contractError(`${what} contains an invalid entry: ${JSON.stringify(item.slice(0, 64))}`, 'invalid_spec');
  }
  return value;
}

function checkPositiveInt(value, what, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value)) throw contractError(`${what} must be an integer`, 'invalid_spec');
  if (value < min || value > max) throw contractError(`${what} must be in [${min}, ${max}]（收到 ${value}）`, 'invalid_spec');
  return value;
}

/**
 * 可选整数：`undefined` 与 `null` **同义**，都表示"没设上限"，返回 `null`。
 *
 * R0-128（真阳性）：此前"没设"在**归一化输出**里被写成 `null`，而校验器只接受整数 —— 于是
 * 归一化结果无法再次通过校验（`validateTaskEnvelope(validateTaskEnvelope(t))` 抛
 * `budget.max_steps must be an integer`），`validateWorkResult` 也拒绝 runtime 自己刚产出的
 * `usage.model_calls: null`。这不是"多写了一条断言"：合同的核心用途就是让**产出物本身**
 * 可被同一份判据复核（落盘→回读→校验），一旦"我们产的自己都不认"，那条复核链是断的。
 * 现约定：可空字段的 `null` 只在"没设"这一种含义上被接受，其余非法值照旧拒绝。
 */
function checkOptionalInt(value, what, opts = {}) {
  if (value === undefined || value === null) return null;
  return checkPositiveInt(value, what, opts);
}

// ── CellSpec ────────────────────────────────────────────────────────────
/**
 * 校验 `CellSpec`。返回**归一化后的副本**（不修改入参：调用方的对象不该被悄悄改写）。
 *
 * @param {object} spec
 * @param {{maxChildrenCap?:number, allowFullAuto?:boolean}} [opts]
 *        `maxChildrenCap` 由宿主策略给出（v0 默认 0）：Spec 不能自己申请超出宿主的上限。
 * @returns {object} 归一化 CellSpec
 */
export function validateCellSpec(spec, opts = {}) {
  checkSchema(spec, CELL_SCHEMA);
  const { maxChildrenCap = 0, allowFullAuto = false } = opts;

  const cell_id = checkOpaqueId(spec.cell_id, 'cell_id');

  if (typeof spec.workspace !== 'string' || !spec.workspace) {
    throw contractError('workspace is required (absolute path of the cell\'s working directory)', 'invalid_cell_spec');
  }
  if (!spec.workspace.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(spec.workspace)) {
    throw contractError(`workspace must be an ABSOLUTE path（收到 "${spec.workspace}"）`, 'invalid_cell_spec');
  }
  if (spec.workspace.length > 4096) throw contractError('workspace path too long', 'invalid_cell_spec');

  // state_ref 只允许指向 Cell 自己的状态命名空间（`local:<相对路径>`）。
  // 首版不做"任意 URI"，因为那会立刻引出"谁能读别人的 state"的问题，而 v0 没有跨宿主授权。
  let stateRef = null;
  if (spec.state_ref !== undefined && spec.state_ref !== null) {
    if (typeof spec.state_ref !== 'string' || !/^local:[^\s]+$/.test(spec.state_ref)) {
      throw contractError('state_ref must look like "local:<relative/path>"', 'invalid_cell_spec');
    }
    const rel = spec.state_ref.slice('local:'.length);
    checkRelativeRef(rel, 'state_ref');
    stateRef = spec.state_ref;
  }

  const capabilities = spec.capabilities === undefined ? [] : checkStringArray(spec.capabilities, 'capabilities', { max: 64, pattern: CAPABILITY_RE });

  let permissionMode = 'auto';
  if (spec.permission_mode !== undefined) {
    if (typeof spec.permission_mode !== 'string' || !PERMISSION_MODES.includes(spec.permission_mode)) {
      throw contractError(`permission_mode must be one of ${PERMISSION_MODES.join('|')}`, 'invalid_cell_spec');
    }
    // `full-auto` 不是"高级选项"，是"跳过执行前确认"。允许它存在，但**必须**由宿主显式开启，
    // 且创建时就要被看见 —— 否则 Spec 自己把安全模式提上去了（权限自授）。
    if (spec.permission_mode === 'full-auto' && !allowFullAuto) {
      throw contractError(
        'permission_mode "full-auto" is not allowed for cells unless the host enables it '
        + '(it bypasses pre-execution confirmations). Use "auto".',
        'invalid_cell_spec');
    }
    permissionMode = spec.permission_mode;
  }

  const runtimeRaw = spec.runtime === undefined ? { kind: 'process' } : spec.runtime;
  if (!isPlainObject(runtimeRaw)) throw contractError('runtime must be an object', 'invalid_cell_spec');
  const kind = runtimeRaw.kind === undefined ? 'process' : runtimeRaw.kind;
  if (!RUNTIME_KINDS.includes(kind)) {
    // 明确拒绝而不是忽略：假装支持 `shared_process` 会让调用方以为"同进程多 Cell 已经安全"，
    // 而 v0 的围栏/场景/单例状态都还不满足那个前提。
    throw contractError(
      `runtime.kind "${String(kind).slice(0, 40)}" is not supported in v0 (only ${RUNTIME_KINDS.join('|')}). `
      + 'shared_process and remote are explicitly rejected: this build cannot keep their state, fences and '
      + 'scenes isolated (see docs/architecture/cell-rfc.md §"v0 约束").',
      'unsupported_runtime');
  }
  if (kind !== 'process') throw contractError(`runtime.kind "${kind}" is not supported`, 'unsupported_runtime');
  if (runtimeRaw.extra !== undefined) {
    throw contractError('runtime.extra is not part of the v0 contract; unknown runtime fields are rejected', 'invalid_cell_spec');
  }
  // 首版不允许把 model 配置塞进 Spec：模型凭证属于宿主作用域，Spec 只是"允许上限"
  if (spec.model_ref !== undefined && spec.model_ref !== null) {
    if (typeof spec.model_ref !== 'string' || !spec.model_ref) throw contractError('model_ref must be a non-empty string when present', 'invalid_cell_spec');
  }

  const limitsRaw = spec.limits === undefined ? {} : spec.limits;
  if (!isPlainObject(limitsRaw)) throw contractError('limits must be an object', 'invalid_cell_spec');
  const maxActiveTasks = limitsRaw.max_active_tasks === undefined ? 1 : checkPositiveInt(limitsRaw.max_active_tasks, 'limits.max_active_tasks', { min: 1, max: 8 });
  if (maxActiveTasks !== 1) {
    // 首版只支持一次一个任务：不是能力不足，而是"能被理解和验收"优先（G1 Exit 要求状态可判定）。
    throw contractError(
      `limits.max_active_tasks=${maxActiveTasks} is not supported in v0 (only 1). `
      + 'One task at a time is what makes "which task wrote this file" answerable.',
      'invalid_cell_spec');
  }
  const maxChildren = limitsRaw.max_children === undefined ? 0 : checkPositiveInt(limitsRaw.max_children, 'limits.max_children', { min: 0, max: 64 });
  if (maxChildren > maxChildrenCap) {
    throw contractError(
      `limits.max_children=${maxChildren} exceeds the host cap (${maxChildrenCap}). `
      + 'A spec may lower the cap, never raise it — spawning is a host decision (see cell-rfc.md §"单元不能无限增殖").',
      'capability_denied');
  }
  const maxSteps = checkOptionalInt(limitsRaw.max_steps, 'limits.max_steps', { min: 1, max: 10000 });
  const wallMs = checkOptionalInt(limitsRaw.wall_ms, 'limits.wall_ms', { min: 1, max: 24 * 3600 * 1000 });

  const tags = spec.tags === undefined ? [] : checkStringArray(spec.tags, 'tags', { max: 32 });

  return {
    schema_version: CELL_SCHEMA,
    cell_id,
    workspace: spec.workspace,
    ...(stateRef ? { state_ref: stateRef } : {}),
    capabilities: [...capabilities],
    permission_mode: permissionMode,
    runtime: { kind: 'process' },
    limits: { max_active_tasks: 1, max_children: maxChildren, max_steps: maxSteps, wall_ms: wallMs },
    ...(spec.model_ref ? { model_ref: spec.model_ref } : {}),
    tags: [...tags],
  };
}

// ── CellStatus ──────────────────────────────────────────────────────────
/**
 * 校验 `CellStatus`。**不**允许只用 Spec 拼出来 —— 调用方必须提供运行事实
 * （`workspace_realpath` / `capabilities_effective` / `fence`），缺一个就拒绝：
 * "声明装配了护栏，实际服务缺失"必须体现为不可执行，而不是一条漂亮的状态行。
 */
export function validateCellStatus(status) {
  checkSchema(status, CELL_STATUS_SCHEMA);
  const cell_id = checkOpaqueId(status.cell_id, 'cell_id');
  const incarnation_id = checkOpaqueId(status.incarnation_id, 'incarnation_id');
  if (typeof status.state !== 'string' || !CELL_STATES.includes(status.state)) {
    throw contractError(`state must be one of ${CELL_STATES.join('|')}`, 'invalid_cell_status');
  }
  if (typeof status.workspace_realpath !== 'string' || !status.workspace_realpath) {
    throw contractError('workspace_realpath is required (the effective, canonicalised workspace)', 'invalid_cell_status');
  }
  checkStringArray(status.capabilities_effective ?? [], 'capabilities_effective', { max: 64, pattern: CAPABILITY_RE });
  const fence = status.fence;
  if (!isPlainObject(fence) || typeof fence.installed !== 'boolean') {
    throw contractError('fence.installed is required (report what is actually registered, not what was configured)', 'invalid_cell_status');
  }
  if (status.active_task_id != null) checkOpaqueId(status.active_task_id, 'active_task_id');
  return status;
}

// ── TaskEnvelope ────────────────────────────────────────────────────────
/** 校验 `TaskEnvelope`。`acceptance` 必须由**提交方**给出，不能由执行者回填。 */
export function validateTaskEnvelope(task) {
  checkSchema(task, TASK_SCHEMA);
  const task_id = checkOpaqueId(task.task_id, 'task_id');
  const attempt = task.attempt === undefined ? 1 : checkPositiveInt(task.attempt, 'attempt', { min: 1, max: 1e6 });
  const target_cell_id = checkOpaqueId(task.target_cell_id, 'target_cell_id');
  if (typeof task.goal !== 'string' || !task.goal.trim()) throw contractError('goal is required', 'invalid_task');
  if (task.goal.length > 20000) throw contractError('goal too long（> 20000 chars）', 'invalid_task');

  const inputs = task.inputs === undefined ? [] : task.inputs;
  if (!Array.isArray(inputs)) throw contractError('inputs must be an array', 'invalid_task');
  const normInputs = inputs.map((item, i) => {
    if (!isPlainObject(item)) throw contractError(`inputs[${i}] must be an object`, 'invalid_task');
    if (typeof item.kind !== 'string' || !item.kind) throw contractError(`inputs[${i}].kind is required`, 'invalid_task');
    checkRelativeRef(item.ref, `inputs[${i}].ref`);
    return { kind: item.kind, ref: item.ref };
  });

  const required_capabilities = task.required_capabilities === undefined
    ? [] : checkStringArray(task.required_capabilities, 'required_capabilities', { max: 64, pattern: CAPABILITY_RE });

  // Task **不允许**自带工作区：那等于让任务自己扩边界（"我先声明到 /etc 再干活"）。
  for (const forbidden of ['workspace', 'workDir', 'work_dir', 'cwd']) {
    if (task[forbidden] !== undefined) {
      throw contractError(
        `Task must not carry its own ${forbidden}（收到 ${JSON.stringify(String(task[forbidden]).slice(0, 80))}）: `
        + 'a cell\'s workspace is fixed by its CellSpec; use another cell for another directory.',
        'workspace_conflict');
    }
  }

  const budgetRaw = task.budget === undefined ? {} : task.budget;
  if (!isPlainObject(budgetRaw)) throw contractError('budget must be an object', 'invalid_task');
  const budget = {
    max_steps: checkOptionalInt(budgetRaw.max_steps, 'budget.max_steps', { min: 1, max: 10000 }),
    wall_ms: checkOptionalInt(budgetRaw.wall_ms, 'budget.wall_ms', { min: 1, max: 24 * 3600 * 1000 }),
  };

  const acc = task.acceptance;
  if (!isPlainObject(acc)) throw contractError('acceptance is required (an execution report with no acceptance criteria cannot be accepted or rejected)', 'invalid_task');
  const required_artifacts = acc.required_artifacts === undefined ? [] : acc.required_artifacts;
  if (!Array.isArray(required_artifacts)) throw contractError('acceptance.required_artifacts must be an array', 'invalid_task');
  required_artifacts.forEach((p, i) => checkRelativeRef(p, `acceptance.required_artifacts[${i}]`));
  const checks = acc.checks === undefined ? [] : acc.checks;
  if (!Array.isArray(checks)) throw contractError('acceptance.checks must be an array', 'invalid_task');
  checks.forEach((c, i) => {
    if (typeof c !== 'string' || !c.trim()) throw contractError(`acceptance.checks[${i}] must be a non-empty string`, 'invalid_task');
  });
  // 首版**不执行** Task 里带来的任意 shell 作为验收器：验收命令必须来自宿主信任的白名单。
  // 这里只做结构校验，真正的白名单在适配器里（`acceptance.checks` 作为"要求"记录，执行前另判）。
  if (checks.length > 32) throw contractError('acceptance.checks has too many entries', 'invalid_task');

  return {
    schema_version: TASK_SCHEMA,
    task_id,
    attempt,
    target_cell_id,
    goal: task.goal,
    inputs: normInputs,
    required_capabilities: [...required_capabilities],
    budget,
    acceptance: { required_artifacts: [...required_artifacts], checks: [...checks] },
  };
}

// ── WorkResult ──────────────────────────────────────────────────────────
/** 校验 `WorkResult`。执行状态与验收决定**分开**：这里只认执行事实。 */
export function validateWorkResult(result) {
  checkSchema(result, RESULT_SCHEMA);
  const task_id = checkOpaqueId(result.task_id, 'task_id');
  const attempt = checkPositiveInt(result.attempt ?? 1, 'attempt', { min: 1, max: 1e6 });
  const cell_id = checkOpaqueId(result.cell_id, 'cell_id');
  const incarnation_id = checkOpaqueId(result.incarnation_id, 'incarnation_id');
  if (typeof result.execution_state !== 'string' || !EXECUTION_STATES.includes(result.execution_state)) {
    throw contractError(`execution_state must be one of ${EXECUTION_STATES.join('|')}`, 'invalid_result');
  }
  // 自报 "success" 但没有产物，是最常见的伪证据形态：结构上就拒绝，不留给验收器兜底
  const artifacts = result.artifacts === undefined ? [] : result.artifacts;
  if (!Array.isArray(artifacts)) throw contractError('artifacts must be an array', 'invalid_result');
  artifacts.forEach((a, i) => {
    if (!isPlainObject(a)) throw contractError(`artifacts[${i}] must be an object`, 'invalid_result');
    checkRelativeRef(a.path, `artifacts[${i}].path`);
    if (typeof a.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(a.sha256)) {
      throw contractError(`artifacts[${i}].sha256 must be a 64-hex digest (unhashed artifacts cannot be verified)`, 'invalid_result');
    }
    checkPositiveInt(a.bytes, `artifacts[${i}].bytes`, { min: 0 });
  });
  const evidence = result.evidence === undefined ? [] : result.evidence;
  if (!Array.isArray(evidence)) throw contractError('evidence must be an array', 'invalid_result');
  evidence.forEach((e, i) => {
    if (!isPlainObject(e)) throw contractError(`evidence[${i}] must be an object`, 'invalid_result');
    if (typeof e.kind !== 'string' || !e.kind) throw contractError(`evidence[${i}].kind is required`, 'invalid_result');
    if (e.path !== undefined) checkRelativeRef(e.path, `evidence[${i}].path`);
  });
  const usage = result.usage === undefined ? {} : result.usage;
  if (!isPlainObject(usage)) throw contractError('usage must be an object', 'invalid_result');
  for (const k of ['steps', 'model_calls', 'wall_ms']) {
    // R0-128：`model_calls: null` 是"这一项没测"的**唯一诚实写法**（runtime 无法数出上游调用次数），
    // 必须被接受；写成 0 才是假数据。判据见 checkOptionalInt 的注释。
    if (usage[k] !== undefined) checkOptionalInt(usage[k], `usage.${k}`, { min: 0 });
  }
  if (result.error !== undefined && result.error !== null) {
    if (typeof result.error !== 'string' && !isPlainObject(result.error)) {
      throw contractError('error must be a string or an object', 'invalid_result');
    }
  }
  return {
    schema_version: RESULT_SCHEMA,
    task_id, attempt, cell_id, incarnation_id,
    execution_state: result.execution_state,
    artifacts: artifacts.map((a) => ({ path: a.path, sha256: a.sha256.toLowerCase(), bytes: a.bytes })),
    evidence: [...evidence],
    usage: { ...usage },
    error: result.error ?? null,
  };
}

// ── AcceptanceDecision ──────────────────────────────────────────────────
/**
 * 验收决定。**独立于执行**：执行器说 succeeded 不等于验收通过。
 * `reason` 必填（"为什么拒"必须可审计），`by` 记录是谁判的（v0 是本机受信验收器）。
 */
export function makeAcceptanceDecision({ decision, task_id, attempt = 1, reason, by = 'local-acceptor', checked = [] } = {}) {
  if (!ACCEPTANCE_DECISIONS.includes(decision)) {
    throw contractError(`decision must be one of ${ACCEPTANCE_DECISIONS.join('|')}`, 'invalid_decision');
  }
  const id = checkOpaqueId(task_id, 'task_id');
  if (decision !== 'accepted' && (typeof reason !== 'string' || !reason.trim())) {
    throw contractError('a rejected/inconclusive decision must carry a reason', 'invalid_decision');
  }
  return {
    schema_version: 'tusunsun.acceptance/v0',
    decision,
    task_id: id,
    attempt: checkPositiveInt(attempt, 'attempt', { min: 1, max: 1e6 }),
    reason: typeof reason === 'string' ? reason : '',
    by,
    checked: Array.isArray(checked) ? [...checked] : [],
  };
}

// ── 能力交集 ────────────────────────────────────────────────────────────
/**
 * 执行前授权：**HostPolicy ∩ CellCapabilities ∩ TaskRequiredCapabilities**。
 *
 * 三个集合的交集才是"这次真正可以调用什么"。任何一方没有的能力都不能执行 ——
 * 模型不能通过提示词、请求正文或回传结果把能力加上去（那是最容易实现、也最容易漏的提权）。
 *
 * @param {{host?:string[], cell?:string[], task?:string[]}} sets
 * @returns {{ok:boolean, effective:string[], denied:string[], code?:string, message?:string}}
 */
export function intersectCapabilities({ host = [], cell = [], task = [] } = {}) {
  const H = new Set(host); const C = new Set(cell); const T = new Set(task);
  const effective = [...T].filter((c) => H.has(c) && C.has(c)).sort();
  const denied = [...T].filter((c) => !H.has(c) || !C.has(c)).sort();
  if (denied.length) {
    return {
      ok: false, effective, denied,
      code: 'capability_denied',
      message: `task requires ${denied.join(', ')}, which is not granted by host policy ∩ cell capabilities`,
    };
  }
  return { ok: true, effective, denied: [] };
}

/** Cell 状态机：允许的迁移（拒绝"busy 直接跳 stopped 然后又说自己 ready"这类自相矛盾）。 */
const TRANSITIONS = {
  created: ['ready', 'faulted', 'stopped'],
  ready: ['busy', 'draining', 'faulted', 'stopped'],
  busy: ['ready', 'draining', 'faulted'],
  // R0-129（W1）：`draining → ready` 是本轮新增的**唯一**一条回边。
  // 语义：执行被判定为超时/关闭之后，Cell 进入 draining（"执行资格已撤销，等旧异步链真正停下"）。
  // 只有旧链确认静默（quiesced）才允许回到 ready。修前超时立刻回 ready，于是"旧执行还在跑"
  // 与"下一个任务已开始"并存 —— `max_active_tasks=1` 名存实亡（实测第二个任务直接 OK）。
  // 反过来若不允许这条边，唯一出路是把 Cell 永久钉死在 draining，那是用"不可用"换"安全"。
  draining: ['ready', 'stopped', 'faulted'],
  stopped: [],
  faulted: ['stopped'],
};

export function canTransition(from, to) {
  if (!CELL_STATES.includes(from) || !CELL_STATES.includes(to)) return false;
  return (TRANSITIONS[from] || []).includes(to);
}

/** 迁移校验（抛具名错误）。重启后旧 `busy` **不能**自动变 `succeeded` —— 见 `resolveAfterRestart`。 */
export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw contractError(`illegal cell state transition: ${from} → ${to}`, 'invalid_state_transition');
  }
  return to;
}

/**
 * 重启后的状态收敛：`busy` 的执行者已经不在了，副作用可能已经发生也可能没有。
 * 正确结果是 `faulted` + 该任务标 `unknown`，**不是** `ready`（那会让调度器重派一个
 * 可能已经做过一半的任务）也**不是** `succeeded`（没人看过结果）。
 */
export function resolveAfterRestart(state) {
  if (state === 'busy' || state === 'draining') {
    return { state: 'faulted', task_state: 'unknown', reason: 'previous incarnation ended while a task was in flight; side effects cannot be determined' };
  }
  if (state === 'stopped') return { state: 'stopped', task_state: null };
  if (state === 'faulted') return { state: 'faulted', task_state: 'unknown' };
  // created / ready 没有在飞任务，可以直接干净地重新 ready
  return { state: 'ready', task_state: null };
}

/** 幂等键：`task_id + attempt` 是执行唯一键；`cell_id + incarnation_id` 是执行者运行身份。 */
export function idempotencyKey(task) {
  if (!isPlainObject(task)) throw contractError('task must be an object', 'invalid_task');
  return `${checkOpaqueId(task.task_id, 'task_id')}#${checkPositiveInt(task.attempt ?? 1, 'attempt', { min: 1, max: 1e6 })}`;
}

export function incarnationKey(result) {
  if (!isPlainObject(result)) throw contractError('result must be an object', 'invalid_result');
  return `${checkOpaqueId(result.cell_id, 'cell_id')}@${checkOpaqueId(result.incarnation_id, 'incarnation_id')}`;
}
