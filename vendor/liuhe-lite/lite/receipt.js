// lite/receipt.js — 土行孙 Action Receipt v0 构造 + 路径脱敏
//
// 回执是 Cell 与六合之间的公共合同面：
//   · 只说「文件实际发生了什么」，不替 Cell 判断「代码语义是否正确」（那是 verification 的事，Lite 一律 not_run）
//   · 不泄露绝对路径 / 密钥 / 日志正文；细节按需 inspect
//   · 不改变 Cell 的授权真值：回执只是低信任数据，Cell 自己决定是否采信

export const RECEIPT_SCHEMA_VERSION = 'tusunsun.action-receipt/v0'
export const LITE_PROVIDER = 'liuhe-lite'

// application 取值：apply/undo 路径用 prepared|applied|rejected|failed|indeterminate；
// reconcile 路径额外允许 not_applied（证据证明没落地）与 needs_review（有证据但需人工）。
export const APPLICATION_STATES = Object.freeze([
  'prepared', 'applied', 'rejected', 'failed', 'indeterminate', 'not_applied', 'needs_review',
])

// effect.kind 取值
export const EFFECT_KINDS = Object.freeze([
  'file_created', 'file_modified', 'file_restored', 'file_deleted', 'none',
])

// persistence 取值：证据真的落盘了没有
export const PERSISTENCE_STATES = Object.freeze([
  'persisted',      // 日记 + 回执已落盘
  'memory_only',    // 动作发生了但证据没落盘（Undo 不再可信）
  'failed',         // 证据落盘失败
  'unknown',        // 未知（读不出证据）
])

export function buildReceipt({
  actionId,
  providerOperationId = null,
  cell = {},
  requestId = null,
  application,
  effect = null,
  verification = 'not_run',
  recovery = null,
  persistence = 'persisted',
  extension = null,
} = {}) {
  const receipt = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    action_id: actionId,
    provider: LITE_PROVIDER,
    provider_operation_id: providerOperationId,
    cell_id: cell.cell_id ?? null,
    incarnation_id: cell.incarnation_id ?? null,
    task_id: cell.task_id ?? null,
    request_id: requestId ?? null,
    application,
    effect: effect || { kind: 'none', target: null, before_sha256: null, after_sha256: null, detail_ref: null },
    verification,
    recovery: recovery || { supported: false, ref: null },
    persistence,
  }
  if (extension && typeof extension === 'object') receipt.extension = extension
  return receipt
}

// 脱敏（LH-04）：错误消息 / 日志片段里可能带绝对路径或 URL。
// 顺序很重要：先保护 URL，再降级路径，最后还原——否则 `https://example.com/a/b` 会被当成
// 绝对路径 `/a/b` 删掉，变成 `https:<path>`（0.1.0 的真实缺陷）。
// 覆盖：POSIX 绝对路径、Windows 盘符路径、UNC、带引号且含空格的路径、工作区根。
// 不覆盖：无引号且含空格的非工作区路径（无法可靠切词），以及任意密钥/正文——见 SAFETY.md 的能力边界。
export function redactPaths(text, realPath) {
  if (text === null || text === undefined) return ''
  let out = String(text)

  // 1) URL 先占位：URL 里的 //a/b 不是绝对路径。
  //    用「通用 scheme」而不是只列 http/https/file——否则 ssh:// git:// postgres:// 会被
  //    第 6 步当成路径截成 `ssh:<path>`（与 0.1.0 的 https 误伤同一类错）。
  const urls = []
  out = out.replace(/\b[a-z][a-z0-9+.\-]*:\/\/[^\s'"`<>]+/gi, (m) => {
    const tailMatch = /[.,;:)\]!?]+$/.exec(m)
    const tail = tailMatch ? tailMatch[0] : ''
    urls.push(m.slice(0, m.length - tail.length))
    return '\u0000URL' + (urls.length - 1) + '\u0000' + tail
  })

  // 2) 工作区根 → <workspace>（精确串替换：路径里带空格 / Unicode 也吃得下）
  if (realPath) out = out.split(realPath).join('\u0000WS\u0000')

  // 3) 引号内的 Windows / UNC 路径（允许空格："C:\\Program Files\\a b.txt"）
  out = out.replace(/(["'`])(?:[A-Za-z]:\\|\\\\|\/)[^"'`\n]*\1/g, (m) => m[0] + '<path>' + m[0])

  // 4) 裸 Windows 盘符路径（无空格）
  out = out.replace(/(^|[\s'"`(=[])([A-Za-z]:\\[^\s'"`,;)\]]*)/g, (m, pre) => pre + '<path>')

  // 5) 裸 UNC 路径（无空格）
  out = out.replace(/(^|[\s'"`(=[])(\\\\[^\s'"`,;)\]]*)/g, (m, pre) => pre + '<path>')

  // 6) POSIX 绝对路径（URL 已占位，这里可以把 ':' 也当前缀，兼容 "path:/tmp/x"）
  out = out.replace(/(^|[\s'"`(=:[])(\/[^\s'"`,;)\]]*)/g, (m, pre) => pre + '<path>')

  // 7) 还原
  out = out.split('\u0000WS\u0000').join('<workspace>')
  out = out.replace(/\u0000URL(\d+)\u0000/g, (m, i) => urls[Number(i)])
  return out
}
