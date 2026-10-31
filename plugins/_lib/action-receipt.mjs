// A0（v0.9.33）：Action Receipt v0 —— 动作**实际效果**的结构化回执。
//
// 为什么需要它（计划书 Track A 的核心论点）：
//   只返回 `Written 183 bytes`，模型无从判断"写对了没、改了多少、是不是覆盖掉了别的内容"。
//   "动作有结果"不等于"动作结果符合意图"。六合的版本锚点/预览/journal 提醒我们该看真实差异，
//   但**不是每种动作都可恢复** —— 所以本模块只统一"如何诚实反馈实际效果"，
//   **不**统一"如何撤销所有操作"。
//
// 本模块刻意只做三个判断，别的都不做：
//   ① `effect` 必须来自**文件系统事实**（写后读回并核算 hash），不是用预期内容预先算的值；
//   ② `verification` 与应用状态**分离** —— `applied` 不妨碍 `verification: 'not_run'`；
//   ③ 做不到就填 null / false 并说明，绝不推测。
//
// 明确不做（v0 的边界，写在这里以免被后来的人当成遗漏）：
//   · 不声称任何通用的 undo 能力（`recovery.supported` 只在真有备份且能校验时才可能为 true，
//     本版恒为 false）；
//   · 不声称全工作区事务化 —— 这只覆盖 `tool-write` 这一条受控写入路径；
//     `tool-bash`、任意命令、外部 MCP **都可以绕开**它。做不到就不宣称覆盖。
//   · 不做多版本并发写的合并：并发下若无法确认"这个回执对应哪次写入"，标 indeterminate。

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/** 回执 schema 版本。字段改名必须升版本，不许同名换义。 */
export const RECEIPT_SCHEMA = 'tusunsun.action-receipt/v0';

/**
 * 应用状态。**不含** verified/undoable —— 那是另外两个轴。
 *
 * v0.11.0（L2 字段冻结，与六合 Lite 对齐）：补两个值。
 *   · `not_applied` —— **有证据证明当前效果不存在**（提交过又被撤销、或从未落地）；
 *   · `needs_review` —— 证据不足/磁盘处于第三态，必须人工判。
 *
 * 为什么必须补：`reconcile` 的核心价值就是区分"从未落地"与"落地后被撤销"，
 * 这两个值正是那个区分。六合 Lite 0.1.x 已经在 `tusunsun.action-receipt/v0` 里发这两个值，
 * 而我的校验器此前会**拒收**它们 —— 实测：`application: "not_applied"` 被拒，
 * 违规项 `must be one of prepared|applied|rejected|failed|indeterminate`。
 * 也就是说：跨实现的回执对不上，责任在我这边。
 *
 * 这是**加值**不是改名/换义，v0 仍读得懂旧回执（旧值语义不变）。
 */
export const APPLICATION_STATES = [
  'prepared', 'applied', 'rejected', 'failed', 'indeterminate',
  'not_applied', 'needs_review',
];

/**
 * 归属字段（v0.11.0 新增，**全部可选**）。
 *
 * 计划书 §6 L2 要求两套系统用 `request_id / provider_operation_id` 做关联。
 * 我只在调用方真的给了值时才写进回执 —— 原生写盘没有幂等账本，
 * 填一个"看起来像幂等键"的东西就是编造（见 D-6 的答复）。
 */
export const ATTRIBUTION_FIELDS = ['provider', 'provider_operation_id', 'request_id'];

/** 持久化状态：区分"存住了"与"只在内存里"。 */
export const PERSISTENCE_STATES = ['persisted', 'volatile', 'failed', 'unknown'];

let _seq = 0;

/** 生成一个可关联的 action id（进程内唯一即可；跨进程关联靠 cell/task 字段）。 */
export function nextActionId() {
  _seq += 1;
  return `act-${Date.now().toString(36)}-${_seq.toString(36)}`;
}

export function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * 读回文件并核算 hash，用作"真的落盘了什么"的证据。
 *
 * 为什么必须读回：用"我要写的内容"算 hash 是在描述**意图**，不是事实。
 * 磁盘可能因权限/配额/并发被改写，也可能根本没写成功。`after_sha256` 只能是读回来的值。
 *
 * @returns {Promise<{exists: boolean, sha256: string|null, bytes: number|null, error?: string}>}
 */
export async function readBack(absPath) {
  try {
    const buf = await readFile(absPath);
    return { exists: true, sha256: sha256Hex(buf), bytes: buf.length };
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false, sha256: null, bytes: null };
    return { exists: false, sha256: null, bytes: null, error: err.code || err.message };
  }
}

/**
 * 构造一份回执。**所有字段都必须由调用方以事实填**；本函数只做形状与自洽性校验，
 * 不替调用方补默认值（补默认值就是编造）。
 *
 * 自洽性检查（不通过就返回 `ok:false`，让调用方知道自己的回执不诚实）：
 *   · `application === 'applied'` 时必须有 `effect.after_sha256`（没有就不是"已应用"的证据）；
 *   · `application === 'rejected'` 时 `effect` 必须是空的（拒绝 = 没有效果）；
 *   · `recovery.supported === true` 时必须有 `recovery.ref`（说能恢复却不给引用 = 空承诺）；
 *   · `verification !== 'not_run'` 时必须有 `verification_ref`（说验过就要能复核）。
 *
 * @param {object} f 字段（见下方 shape）
 * @returns {{ok: boolean, receipt?: object, violations?: string[]}}
 */
// ── ACT-07（v0.11.0）：回执不得把**高敏文件名**带进上下文 ──────────────────
//
// 回执的 `target.path` 是工作区相对路径，本身不泄露宿主绝对路径（那一条早就守住了）。
// 但它会把**文件名**原样带出去：`id_rsa`、`.env`、`credentials.json` 写进回执，
// 回执又进模型上下文与审计日志 —— 等于把"这个工作区里有哪些敏感文件"抄了一遍。
//
// 修法刻意**不拦写入**：拦不拦是产品决策（用户可能就是要让 Agent 改 .env），
// 归 D-5 单独定。这里只做**减少披露**：路径换成占位符，并显式标 `redacted`，
// 让读者知道"这里有个名字被遮了"，而不是以为文件就叫 `<redacted>`。
const SENSITIVE_TARGET_PATTERNS = [
  [/(^|\/)\.env(\.[\w.-]+)?$/, 'env_file'],
  [/(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/, 'private_key'],
  [/\.(pem|key|p12|pfx|jks)$/, 'key_material'],
  [/(^|\/)\.(npmrc|pypirc|netrc|git-credentials|vault-token)$/, 'credential_file'],
  [/(^|\/)credentials?(\.(json|ya?ml|toml))?$/i, 'credential_file'],
  [/(^|\/)secrets?(\.(json|ya?ml|toml))?$/i, 'secret_file'],
  [/(^|\/)\.ssh(\/|$)/, 'ssh_path'],
];

/**
 * 高敏文件名 → 占位符。
 *
 * @returns {{ path: string, redacted: string|null }} `redacted` 为 null 表示原样返回。
 */
export function redactTargetPath(p) {
  if (typeof p !== 'string' || p === '') return { path: p, redacted: null };
  const norm = p.replace(/\\/g, '/');
  for (const [re, kind] of SENSITIVE_TARGET_PATTERNS) {
    if (re.test(norm)) return { path: `<redacted:${kind}>`, redacted: kind };
  }
  return { path: p, redacted: null };
}

export function buildReceipt(f = {}) {
  const application = f.application;
  const violations = [];
  if (!APPLICATION_STATES.includes(application)) {
    violations.push(`application must be one of ${APPLICATION_STATES.join('|')}, got ${JSON.stringify(application)}`);
  }
  const effect = f.effect && typeof f.effect === 'object' ? f.effect : {};
  const recovery = f.recovery && typeof f.recovery === 'object' ? f.recovery : { supported: false, ref: null };
  const persistence = f.persistence || 'unknown';
  if (!PERSISTENCE_STATES.includes(persistence)) {
    violations.push(`persistence must be one of ${PERSISTENCE_STATES.join('|')}, got ${JSON.stringify(persistence)}`);
  }
  if (application === 'applied' && !effect.after_sha256) {
    violations.push('application=applied requires effect.after_sha256 (read back from disk, not computed from intent)');
  }
  if (application === 'rejected' && Object.keys(effect).length > 0) {
    violations.push('application=rejected must not carry effect (a refused action has no effect)');
  }
  if (recovery.supported === true && !recovery.ref) {
    violations.push('recovery.supported=true requires recovery.ref');
  }
  const verification = f.verification || 'not_run';
  if (verification !== 'not_run' && !f.verification_ref) {
    violations.push(`verification=${verification} requires verification_ref`);
  }
  if (violations.length) return { ok: false, violations };

  return {
    ok: true,
    receipt: {
      schema_version: RECEIPT_SCHEMA,
      action_id: f.action_id || nextActionId(),
      cell_id: f.cell_id ?? null,
      incarnation_id: f.incarnation_id ?? null,
      task_id: f.task_id ?? null,
      attempt: f.attempt ?? null,
      tool_id: f.tool_id || 'tool.write',
      application,
      target: {
        // ACT-07：高敏文件名换成占位符，并显式标 redacted（不静默改写）
        path: redactTargetPath(f.target?.path ?? null).path,
        canonical_scope: f.target?.canonical_scope ?? null,
        ...(redactTargetPath(f.target?.path ?? null).redacted
          ? { redacted: redactTargetPath(f.target?.path ?? null).redacted }
          : {}),
      },
      effect: {
        kind: effect.kind || null,
        before_sha256: effect.before_sha256 ?? null,
        after_sha256: effect.after_sha256 ?? null,
        changed_bytes: effect.changed_bytes ?? null,
        created: effect.created ?? null,
        detail_ref: effect.detail_ref ?? null,
      },
      verification,
      recovery: { supported: recovery.supported === true, ref: recovery.ref ?? null },
      persistence,
      // 只在调用方真的给了才写：原生工具没有这些事实，空着比编造好。
      ...Object.fromEntries(
        ATTRIBUTION_FIELDS
          .filter((k) => f[k] != null && f[k] !== '')
          .map((k) => [k, f[k]]),
      ),
    },
  };
}

/**
 * 人类可读的一行摘要。**只写有证据的**：
 *   · 有 before/after hash 才说"修改/新建"；否则只说"写入"；
 *   · 有 changed_bytes 才报字节数差异；
 *   · `verification: not_run` 必须在摘要里说出来，否则读者会以为验过了。
 * 拿不到的数字直接不写 —— 不生成推测值（计划书 A3 的明确要求）。
 */
export function summarizeReceipt(r) {
  const parts = [];
  const path = r?.target?.path ?? '(unknown)';
  const e = r?.effect || {};
  if (r?.application === 'applied') {
    if (e.kind === 'file_created' || e.created === true) parts.push(`新建 ${path}`);
    else if (e.before_sha256 && e.before_sha256 !== e.after_sha256) parts.push(`修改 ${path}`);
    else if (e.before_sha256 && e.before_sha256 === e.after_sha256) parts.push(`写入 ${path}（内容未变）`);
    else parts.push(`写入 ${path}`);
    if (typeof e.changed_bytes === 'number') parts.push(`差异 ${e.changed_bytes} 字节`);
  } else {
    parts.push(`${r?.application || 'unknown'} ${path}`);
  }
  if (r?.verification === 'not_run') parts.push('验证未执行');
  else if (r?.verification) parts.push(`验证=${r.verification}`);
  if (r?.recovery?.supported !== true) parts.push('不可撤销');
  if (r?.persistence === 'volatile') parts.push('回执未持久化');
  if (e.detail_ref) parts.push(`详见 ${e.detail_ref}`);
  return parts.join('；');
}
