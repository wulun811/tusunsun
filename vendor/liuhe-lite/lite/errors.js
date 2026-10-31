// lite/errors.js — LiuHe Lite 错误码 + 六合内部码映射
//
// 设计：Lite 对外只暴露本文件定义的稳定错误码；六合内部码（PATH_BLOCKED / VERSION_CONFLICT /
// EXTERNAL_CHANGE …）在边界处一次性映射，Cell 侧不依赖六合内部语义。
//
// 铁律：任何「不确定」状态映射为 INDETERMINATE 或 needs_review，
//       绝不降级成「失败且无副作用」——那会教 Cell 撒谎。

export const LiteErrorCodes = {
  PATH_OUT_OF_SCOPE: 'PATH_OUT_OF_SCOPE',       // 路径越界：绝对路径 / ../ / symlink 逃逸 / 敏感目录
  VERSION_CONFLICT: 'VERSION_CONFLICT',           // 锚点与磁盘现状不一致 → fail-closed，不覆盖
  UNDO_CONFLICT: 'UNDO_CONFLICT',                 // Undo 前文件已被后续修改 → 拒绝覆盖
  INDETERMINATE: 'INDETERMINATE',                 // 结果不确定：回读不一致 / 证据不足 / 请求未收口
  PERSISTENCE_FAILED: 'PERSISTENCE_FAILED',       // 日记落盘失败 → 未写入任何文件
  RECOVERY_UNAVAILABLE: 'RECOVERY_UNAVAILABLE',   // 找不到日记 / 日记不可读 → 无法承诺 Undo
  FOREIGN_JOURNAL: 'FOREIGN_JOURNAL',             // 日记不是 Lite 创建的 / 格式不认识 → 拒绝接管，不碰盘
  NOT_UNDOABLE: 'NOT_UNDOABLE',                   // 该动作不在可撤销状态
  NEEDS_REVIEW: 'NEEDS_REVIEW',                   // 证据有，但磁盘处于第三态（既非旧版也非新版）→ 必须人工
  FILE_LOCKED: 'FILE_LOCKED',                     // 并发写者持锁
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',               // 超出 Lite 的大小上限
  UNSUPPORTED_ENCODING: 'UNSUPPORTED_ENCODING',   // 非 UTF-8 / 二进制
  REQUEST_CONFLICT: 'REQUEST_CONFLICT',           // 同 request_id 异载荷
  REQUEST_IN_FLIGHT: 'REQUEST_IN_FLIGHT',         // 同 request_id 正在执行
  WRITE_FAILED: 'WRITE_FAILED',                   // 原子写失败（目标文件未变）
  INVALID_INPUT: 'INVALID_INPUT',                 // 参数不合法
  NOT_FOUND: 'NOT_FOUND',                         // 动作 / 日记不存在
}

// retry 取值：Cell 拿到错误后该怎么处置（这是公共合同的一部分，不是适配层的装饰）
export const RETRY_VALUES = Object.freeze(['never', 'same_request_id', 'new_request', 'after_reanchor', 'after_reconcile'])

// 错误码 → 处置建议。原生入口与适配层返回**同一份**（tests/docs-claims.mjs 逐项机检
// 接入指南里的表与本表一致），避免「文档说一套、代码返回另一套」。
export const RETRY_POLICY = Object.freeze({
  PATH_OUT_OF_SCOPE: { retry: 'never', note: '绝对路径 / .. / 敏感目录 / 经符号链接；fail-closed，不要换个写法绕过' },
  VERSION_CONFLICT: { retry: 'after_reanchor', note: '磁盘已变；重新 readAnchor 再规划' },
  UNDO_CONFLICT: { retry: 'never', note: '文件已被后续修改；保留现状，交人工决定' },
  INDETERMINATE: { retry: 'after_reconcile', note: '结果不确定：先 reconcile 再决定是否重试' },
  PERSISTENCE_FAILED: { retry: 'new_request', note: '证据未落盘（未写任何文件）；换 request_id 重做' },
  RECOVERY_UNAVAILABLE: { retry: 'never', note: '无日记可依，不能承诺 Undo' },
  FOREIGN_JOURNAL: { retry: 'never', note: '不是 Lite 创建的事务（或格式不认识）；不得接管/撤销，磁盘未被触碰' },
  NOT_UNDOABLE: { retry: 'never', note: '该动作不在可撤销状态' },
  NEEDS_REVIEW: { retry: 'never', note: '文件既不等于动作前版本也不等于动作后版本（外部改动）→ 别重试，人工确认后重新锚点' },
  FILE_LOCKED: { retry: 'same_request_id', note: '并发写者持锁；退避后用同一 request_id 重试' },
  FILE_TOO_LARGE: { retry: 'never', note: '超出 Lite 上限（默认 1 MiB），交给大文件路径' },
  UNSUPPORTED_ENCODING: { retry: 'never', note: '非 UTF-8 / 二进制，Lite 不处理' },
  REQUEST_CONFLICT: { retry: 'new_request', note: '同一 request_id 被用在异载荷上；换新 id' },
  REQUEST_IN_FLIGHT: { retry: 'same_request_id', note: '同 request_id 正在执行；稍后用同一 id 重试' },
  WRITE_FAILED: { retry: 'new_request', note: '原子写失败，目标文件未变' },
  INVALID_INPUT: { retry: 'never', note: '参数问题，先修参数' },
  NOT_FOUND: { retry: 'never', note: '动作 / 日记不存在' },
  // 适配层（Cell 边界）产生的两个码，同属对 Cell 的合同面
  WORKSPACE_PARAM_FORBIDDEN: { retry: 'never', note: '试图用入参指定工作区；授权边界，不是参数错误' },
  CANCELLED_BEFORE_START: { retry: 'new_request', note: '取消发生在执行前，明确未碰盘；可安全重做' },
})

export function policyOf(code) {
  return RETRY_POLICY[code] || { retry: 'never', note: '未登记的错误码，按 fail-closed 处理（不要自动重试）' }
}

// 六合内部码 → Lite 码（无损映射；内部更细的语义保留在 detail.liuhe_code）
export const LIUHE_TO_LITE = {
  PATH_BLOCKED: LiteErrorCodes.PATH_OUT_OF_SCOPE,
  VERSION_CONFLICT: LiteErrorCodes.VERSION_CONFLICT,
  EXTERNAL_CHANGE: LiteErrorCodes.UNDO_CONFLICT,
  BATCH_BLOCKED: LiteErrorCodes.UNDO_CONFLICT,
  READBACK_MISMATCH: LiteErrorCodes.INDETERMINATE,
  FILE_LOCKED: LiteErrorCodes.FILE_LOCKED,
  JOURNAL_NOT_FOUND: LiteErrorCodes.RECOVERY_UNAVAILABLE,
  JOURNAL_UNREADABLE: LiteErrorCodes.RECOVERY_UNAVAILABLE,
  NOT_COMMITTED: LiteErrorCodes.NOT_UNDOABLE,
  ATOMIC_WRITE_FAILED: LiteErrorCodes.WRITE_FAILED,
  FILE_TOO_LARGE: LiteErrorCodes.FILE_TOO_LARGE,
  TXN_NOT_FOUND: LiteErrorCodes.NOT_FOUND,
  INVALID_INPUT: LiteErrorCodes.INVALID_INPUT,
  missing_parameter: LiteErrorCodes.INVALID_INPUT,
  invalid_input: LiteErrorCodes.INVALID_INPUT,
  BACKUP_FAILED: LiteErrorCodes.PERSISTENCE_FAILED,
  // 下面两码是六合 restoreJournal 真实会返回、此前漏映射的：落到默认分支会报
  // WRITE_FAILED（=「原子写失败，目标未变，可换新 id 重做」）——那是撒谎。
  TARGET_MISSING: LiteErrorCodes.NOT_UNDOABLE,        // 要恢复的文件已不存在 → 撤销无从谈起
  BACKUP_ESCAPE: LiteErrorCodes.RECOVERY_UNAVAILABLE, // 日记备份路径越界 / 是符号链接 → 证据不可信
}

export function mapLiuheCode(code) {
  if (!code) return LiteErrorCodes.INDETERMINATE
  // 兜底必须是 INDETERMINATE，不能是 WRITE_FAILED：不认识的内部码意味着「不知道撤销做到哪一步」，
  // 说成 WRITE_FAILED（目标未变、可重做）会让 Cell 放心重做一次真实发生过的动作。
  return LIUHE_TO_LITE[code] || LiteErrorCodes.INDETERMINATE
}

// 统一失败形状（与接入指南 §5 一致）：
//   { ok:false, error:{ code, message, handling:{retry,note} }, receipt?, detail }
// detail 在顶层，不塞进 error——此前两种形状并存，Cell 必须猜在哪一层。
// receipt 也在顶层：失败但已落盘的动作（例如回读不一致）必须能带走证据，否则 Cell 只能
// 重新猜一次。其余额外字段（只应是诊断用的标量）仍进 error，不往顶层乱扔。
export function liteError(code, message, extra = {}) {
  const { detail = null, receipt, ...rest } = extra
  const out = { ok: false, error: { code, message, handling: policyOf(code), ...rest }, detail }
  if (receipt) out.receipt = receipt
  return out
}
