// lite/index.js — LiuHe Lite：面向土行孙 Cell 的最小文件动作闭环（Adapter first）
//
// 路线：薄适配层，不复制事务引擎。写路径原语全部直接复用六合已验证实现：
//   ../../../malong/path-guard.js        guardRealPath（realpath 越界 / symlink 逃逸守卫）、atomicWrite（tmp+rename 原子写 + 权限继承 + Windows 重试）
//   ../../../malong/write-journal.js      createJournal / updateJournalState / restoreJournal / auditLog（事务日记 + 用户级 Undo + 24h 保留）
//   ../../../malong/write-runtime.js      acquireLock（.mlock 令牌锁 + 心跳续租）、classifyConflict（冲突状态机）
//   ../../../malong/error-codes.js        validateFilePath（路径字符串守卫 + 敏感名单 + Windows 保留名）
//   ../../../malong/hash-utils.js         sha256
//   ../../../malong/write-edit.js          makeSimpleDiff（预览差异）
//   ../../../malong/tools/outlet-ledger.js ledgerClaim / ledgerRecord / ledgerLookup / ledgerRelease（request_id 幂等账本）
//
// 明确不做（L0 结论）：不启动 Rust malong-parse、不建代码索引、不用 SQLite、不改六合内部状态机、不新造事务引擎。
// 唯一对 writeSymbol 的偏离：writeSymbol 的公开契约是「符号/patch 导向」，无法表达「整文件替换」的空文件场景
//   （patch.old_string 不允许空串），故 Lite.apply 用同一批原语编排整文件替换；tests/parity.mjs 与 writeSymbol 逐项落盘对照。

import { join, dirname, isAbsolute } from 'node:path'
import { readFileSync, existsSync, statSync, realpathSync, mkdirSync, readdirSync, rmSync } from 'node:fs'

import { guardRealPath, atomicWrite } from '../vendor/malong/path-guard.js'
import {
  createJournal, updateJournalState, restoreJournal, auditLog,
  JOURNAL_ROOT, JOURNAL_RETENTION_HOURS,
} from '../vendor/malong/write-journal.js'
import { acquireLock, classifyConflict } from '../vendor/malong/write-runtime.js'
import { validateFilePath } from '../vendor/malong/error-codes.js'
import { sha256 } from '../vendor/malong/hash-utils.js'
import { makeSimpleDiff } from '../vendor/malong/write-edit.js'
import { ledgerClaim, ledgerRecord, ledgerLookup, ledgerRelease } from '../vendor/malong/tools/outlet-ledger.js'
import { ensureGitExclude } from '../vendor/malong/git-exclude.js'
import { LiteErrorCodes, mapLiuheCode, liteError } from './errors.js'
import { buildReceipt, redactPaths, LITE_PROVIDER } from './receipt.js'

export const DEFAULT_LIMITS = {
  maxFileBytes: 1024 * 1024,   // 1 MiB：Lite 只处理「有明确所有权的 UTF-8 文本文件」
  maxDiffBytes: 8 * 1024,       // 预览差异上限；超出返回摘要 + detail_ref
}

// Lite 自己的版本线（独立于主包 @jieai/dsh-malong-bridge 的 0.5.x 线）
export const LITE_VERSION = '0.1.3'

// 事务日记所有权判据（LH-01）：Lite 只接管自己创建的事务。
// 0.1.0 写下的日记没有 issuer / journal_format，但 edit_mode 是 lite_replace →
// 按 legacy_v0 接受并在 detail 里标注；其余一律 FOREIGN_JOURNAL（不碰盘）。
export const JOURNAL_FORMAT = 1
export const JOURNAL_ISSUER = 'liuhe-lite'

// 日记清扫的保护态：在途（created/staged）与证据未收口（needs_review/indeterminate）
// 永不自动删——后者是「回读不一致、等人工」的证据，删了就永远说不清了。
const PRUNE_KEEP_STATES = new Set(['created', 'staged', 'needs_review', 'indeterminate'])

// ignoreBOM（本地补丁，见 PROVENANCE.patches）：上游 readAnchor 用解码文本算 hash、apply 用原始
// 字节比对，BOM 被 TextDecoder 吃掉时两者永远不等 ⇒ 带 BOM 的文件永远 VERSION_CONFLICT，undo 备份也丢 BOM。
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function decodeText(buf) {
  if (buf.includes(0)) return { ok: false, reason: 'binary content (NUL byte)' }
  try { return { ok: true, text: strictUtf8.decode(buf) } } catch { return { ok: false, reason: 'not valid UTF-8' } }
}

function readBytes(absPath) {
  try { return readFileSync(absPath) } catch { return null }
}

export function createLiteEditor({ workspace, cell = {}, limits = {} } = {}) {
  if (!workspace || typeof workspace.realPath !== 'string' || !workspace.realPath) {
    throw new Error('createLiteEditor: workspace.realPath is required — the trusted workspace must come from the host runtime, never from model parameters')
  }
  let wsRoot
  try { wsRoot = realpathSync(workspace.realPath) }
  catch (e) { throw new Error('createLiteEditor: workspace realpath is unresolvable: ' + e.message) }

  const lim = { ...DEFAULT_LIMITS, ...limits }
  const cellCtx = {
    cell_id: cell.cellId ?? null,
    incarnation_id: cell.incarnationId ?? null,
    task_id: cell.taskId ?? null,
  }
  const redact = (t) => redactPaths(t, wsRoot)

  // ── 受权作用域检查：字符串守卫 + realpath 前缀守卫（symlink 逃逸）──
  function scopeCheck(relPath) {
    if (typeof relPath !== 'string' || !relPath.trim()) {
      return liteError(LiteErrorCodes.INVALID_INPUT, 'path is required (workspace-relative)')
    }
    if (isAbsolute(relPath)) {
      return liteError(LiteErrorCodes.PATH_OUT_OF_SCOPE, 'absolute path is not allowed (workspace-relative only)')
    }
    const chk = validateFilePath(relPath)
    if (chk.blocked) {
      return liteError(LiteErrorCodes.PATH_OUT_OF_SCOPE, redact(chk.detail), { detail: { liuhe_reason: chk.reason } })
    }
    const guard = guardRealPath(wsRoot, relPath)
    if (guard.blocked) {
      return liteError(LiteErrorCodes.PATH_OUT_OF_SCOPE, redact(guard.detail), { detail: { liuhe_reason: guard.reason } })
    }
    // 受限档：不经符号链接写。
    // 理由：tmp+rename 的原子写会把符号链接本身替换成普通文件（真实目标不变）——
    // 「以为改了 a.txt，其实把那个链接换掉了」是比越界更隐蔽的意外，故直接拒绝。
    const link = symlinkGuard(relPath)
    if (link.blocked) {
      return liteError(LiteErrorCodes.PATH_OUT_OF_SCOPE, link.detail, { detail: { liuhe_reason: link.reason } })
    }
    return null
  }

  // 路径任一段经由 symlink → 阻断（取最深存在祖先的 realpath 与字面路径比对）
  function symlinkGuard(relPath) {
    const abs = join(wsRoot, relPath)
    let probe = abs
    for (;;) {
      try {
        const real = realpathSync(probe)
        if (real !== probe) {
          return {
            blocked: true,
            reason: 'symlink_path',
            detail: `path traverses a symlink and is refused by the Lite restricted profile: ${relPath}`,
          }
        }
        return { blocked: false }
      } catch {
        const parent = dirname(probe)
        if (parent === probe) return { blocked: false }
        probe = parent
      }
    }
  }

  function journalDirOf(txnId) {
    return join(wsRoot, JOURNAL_ROOT, 'journal', txnId)
  }

  function readJournal(txnId) {
    const dir = journalDirOf(txnId)
    let state = null, manifest = null
    try { state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf-8')) } catch {}
    try { manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8')) } catch {}
    return { dir, state, manifest }
  }

  // 所有权判据（在任何磁盘操作之前）。reason 取值：
  //   missing            日记不存在（交给各自的「找不到」路径，不冒充 foreign）
  //   identity_mismatch  txn_id 与目录名/两份记录不一致（跨目录拷来的日记）
  //   edit_mode_mismatch 不是 Lite 的写入模式（write_symbol / edit_batch / transaction …）
  //   issuer_mismatch    发行者标记不是 liuhe-lite
  //   format_unsupported 日记格式版本不认识（未来版本 / 伪造）
  function claimJournal(txnId) {
    const journal = readJournal(txnId)
    const { state, manifest } = journal
    // 目录存在但两份记录读不出来 ≠ 日记不存在：无法证明归属。单独标成 unreadable，
    // 交给调用方 fail-closed（此前归入 missing，等于把不可读日记交给下游去猜）。
    if (!state || !manifest) {
      return { ok: false, reason: existsSync(journal.dir) ? 'unreadable' : 'missing', journal }
    }
    // 严格相等（而不是 `if (x && x !== txnId)`）：缺字段同样是身份不明，不能因为
    // 「没写 txn_id」就跳过校验——那正好是伪造最容易走的路。
    if (manifest.txn_id !== txnId || state.txn_id !== txnId) return { ok: false, reason: 'identity_mismatch', journal }
    if (manifest.edit_mode !== 'lite_replace') return { ok: false, reason: 'edit_mode_mismatch', journal }
    if (state.issuer !== undefined && state.issuer !== JOURNAL_ISSUER) return { ok: false, reason: 'issuer_mismatch', journal }
    if (state.journal_format !== undefined && state.journal_format !== JOURNAL_FORMAT) return { ok: false, reason: 'format_unsupported', journal }
    // manifest.file 本身也要过作用域：否则 inspect/reconcile 会拿它去 observedOf() 读工作区外的
    // 文件（元数据泄露），而 undo 只能指望下游 restoreJournal 自己拦。日记里的字段同样是
    // 不可信输入，不能因为「是 Lite 写的」就免检。
    if (scopeCheck(manifest.file)) return { ok: false, reason: 'path_out_of_scope', journal }
    return { ok: true, journal, ownership: state.issuer === JOURNAL_ISSUER ? 'verified' : 'legacy_v0' }
  }

  // 日记保留期到期时间：从「真实发生时刻」算，而不是「现在 + 24h」。
  // 此前 inspect 一律返回 now+24h —— 对一个 30 小时前的动作也说「还能撤销 24 小时」，
  // 是发给 Cell 的假承诺。拿不到时间戳时返回 null（unknown），不编一个。
  function journalExpiryOf(state, manifest) {
    const base = state?.committed_at || state?.undone_at || manifest?.created_at || null
    if (!base) return null
    const t = Date.parse(base)
    if (!Number.isFinite(t)) return null
    return new Date(t + JOURNAL_RETENTION_HOURS * 3600 * 1000)
  }

  // ── 日记清扫（土行孙 A-1）：SAFETY §6 承诺的「保留窗口 24h，过期自动清扫」
  // 0.1.2 及以前只写在文档里——pruneJournals 只在产品写路径入口被调，Lite 从不触发，
  // 结果 backup/（敏感文件明文副本）会无限留在盘上。这里在 apply 的成败路径上补上，
  // 但与产品版有三处刻意的不同：
  //   1) 只清「能证明是 Lite 自己的」日记（edit_mode=lite_replace + txn_id 一致 + issuer 相符）；
  //      归属证明不了的一律不碰（外来日记由产品自己的写路径清扫，Lite 无跨界删除授权）。
  //   2) 保护态多一个 indeterminate：那是回读不一致、等人工的证据。
  //   3) 目标文件正被别的进程/编辑器操作（存在 .mlock）时跳过，不抢在人家手里删证据。
  function pruneLiteJournals() {
    const root = join(wsRoot, JOURNAL_ROOT, 'journal')
    if (!existsSync(root)) return { pruned: 0, kept: 0 }
    const cutoff = Date.now() - JOURNAL_RETENTION_HOURS * 3600 * 1000
    let pruned = 0, kept = 0
    let entries = []
    try { entries = readdirSync(root, { withFileTypes: true }) } catch { return { pruned: 0, kept: 0 } }
    for (const e of entries) {
      if (!e.isDirectory()) continue                                    // .last_prune 等标记不是事务
      const dir = join(root, e.name)
      let state = null, manifest = null
      try { state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf-8')) } catch { continue }
      try { manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8')) } catch { continue }
      if (!state || !manifest) continue                                 // 读不出来 = 证明不了归属，不删
      if (manifest.edit_mode !== 'lite_replace') continue                // 外来日记：不碰
      if (manifest.txn_id !== e.name || state.txn_id !== e.name) continue
      if (state.issuer !== undefined && state.issuer !== JOURNAL_ISSUER) continue
      if (PRUNE_KEEP_STATES.has(state.state)) { kept++; continue }
      if (typeof manifest.file === 'string' && existsSync(join(wsRoot, manifest.file) + '.mlock')) { kept++; continue }
      const ts = state.committed_at || state.undone_at || state.rolled_back_at || state.failed_at || null
      let tsMs = ts ? Date.parse(ts) : NaN
      if (!Number.isFinite(tsMs)) { try { tsMs = statSync(dir).mtimeMs } catch { continue } }
      if (tsMs > cutoff) { kept++; continue }                            // 未到龄
      try { rmSync(dir, { recursive: true, force: true }); pruned++ } catch { continue }
    }
    if (pruned > 0) { try { auditLog(wsRoot, { event: 'lite_journal_prune', pruned }) } catch {} }
    return { pruned, kept }
  }

  function foreignJournalError(action, txnId, claim) {
    return liteError(LiteErrorCodes.FOREIGN_JOURNAL,
      action + ': journal ' + txnId + ' is not owned by liuhe-lite (' + claim.reason + ') — refusing to touch it',
      {
        detail: {
          txn_id: txnId,
          reason: claim.reason,
          edit_mode: claim.journal?.manifest?.edit_mode ?? null,
          issuer: claim.journal?.state?.issuer ?? null,
          journal_format: claim.journal?.state?.journal_format ?? null,
        },
      })
  }

  function backupHashOf(dir, manifest) {
    if (!manifest || typeof manifest.file !== 'string') return null
    try {
      const buf = readBytes(join(dir, 'backup', manifest.file.split(/[\\/]/).pop()))
      if (!buf) return null
      return sha256(buf)
    } catch { return null }
  }

  function observedOf(relPath) {
    const abs = join(wsRoot, relPath)
    let st = null
    try { st = statSync(abs) } catch {}
    if (!st || !st.isFile()) return { exists: false, sha256: null, size: null, mtime_ms: null }
    // 有界读取：锚点之后文件暴涨（或宿主换成大文件）时，不允许把整文件读进内存再算 hash。
    // 超出 Lite 上限时给 sha256=null（永远不可能等于锚点 hash）→ 调用方 fail-closed。
    if (st.size > lim.maxFileBytes) return { exists: true, sha256: null, size: st.size, mtime_ms: st.mtimeMs, too_large: true }
    const buf = readBytes(abs)
    if (!buf) return { exists: false, sha256: null, size: null, mtime_ms: null }
    return { exists: true, sha256: sha256(buf), size: st.size, mtime_ms: st.mtimeMs }
  }

  // ── ① readAnchor：读回真实目标 + 内容 hash + 存在性 + 辅助元数据 ──
  function readAnchor({ path: relPath } = {}) {
    const bad = scopeCheck(relPath)
    if (bad) return bad
    const abs = join(wsRoot, relPath)
    let st = null
    try { st = statSync(abs) } catch {}
    if (!st) {
      return {
        ok: true,
        anchor: {
          path: relPath, exists: false, sha256: null, size: 0,
          mtime_ms: null, inode: null, encoding: 'utf-8', line_count: 0,
        },
      }
    }
    if (!st.isFile()) return liteError(LiteErrorCodes.INVALID_INPUT, 'not a regular file: ' + relPath)
    if (st.size > lim.maxFileBytes) {
      return liteError(LiteErrorCodes.FILE_TOO_LARGE, `file exceeds Lite size limit (${st.size} > ${lim.maxFileBytes} bytes)`)
    }
    const buf = readBytes(abs)
    if (!buf) return liteError(LiteErrorCodes.INVALID_INPUT, 'cannot read file: ' + relPath)
    const dec = decodeText(buf)
    if (!dec.ok) return liteError(LiteErrorCodes.UNSUPPORTED_ENCODING, `unsupported content: ${dec.reason}`)
    return {
      ok: true,
      anchor: {
        path: relPath,
        exists: true,
        sha256: sha256(dec.text),
        size: st.size,
        mtime_ms: st.mtimeMs,
        inode: st.ino ?? null,
        encoding: 'utf-8',
        line_count: dec.text.split('\n').length,
      },
    }
  }

  // ── ② preview：基于锚点算差异与预计 hash；明确不写盘 ──
  function preview({ anchor, newContent } = {}) {
    if (!anchor || typeof anchor.path !== 'string') {
      return liteError(LiteErrorCodes.INVALID_INPUT, 'anchor is required')
    }
    if (typeof newContent !== 'string') {
      return liteError(LiteErrorCodes.INVALID_INPUT, 'newContent is required')
    }
    // 与 apply 同一口径：预览一个将来会被拒的内容没有意义，只会让 Cell 以为可写。
    if (newContent.includes('\u0000')) {
      return liteError(LiteErrorCodes.INVALID_INPUT, 'newContent contains a NUL byte — Lite only writes UTF-8 text')
    }
    const bad = scopeCheck(anchor.path)
    if (bad) return bad
    if (Buffer.byteLength(newContent, 'utf-8') > lim.maxFileBytes) {
      return liteError(LiteErrorCodes.FILE_TOO_LARGE, 'newContent exceeds Lite size limit')
    }
    let currentText = ''
    if (anchor.exists) {
      const obs = observedOf(anchor.path)
      if (!obs.exists) {
        return liteError(LiteErrorCodes.VERSION_CONFLICT, 'target disappeared since anchor was read')
      }
      if (obs.sha256 !== anchor.sha256) {
        return liteError(LiteErrorCodes.VERSION_CONFLICT, 'target changed since anchor was read; re-read before previewing')
      }
      const buf = readBytes(join(wsRoot, anchor.path))
      const dec = decodeText(buf || Buffer.alloc(0))
      currentText = dec.ok ? dec.text : ''
    } else if (observedOf(anchor.path).exists) {
      return liteError(LiteErrorCodes.VERSION_CONFLICT, 'target now exists; anchor expected it absent')
    }
    const diff = makeSimpleDiff(currentText.split('\n'), newContent.split('\n'))
    const patchBytes = Buffer.byteLength(diff.patch, 'utf-8')
    const bounded = patchBytes <= lim.maxDiffBytes
    return {
      ok: true,
      preview: {
        path: anchor.path,
        expected_before_sha256: anchor.exists ? anchor.sha256 : null,
        expected_after_sha256: sha256(newContent),
        applied: false,               // 明确：预览不写盘
        diff: bounded
          ? { patch: diff.patch, lines_changed: diff.lines_changed, truncated: false }
          : {
            patch: null,
            lines_changed: diff.lines_changed,
            truncated: true,
            bytes: patchBytes,
            summary: `diff too large for inline preview (${patchBytes} bytes) — re-request preview with a larger maxDiffBytes, or inspect the file directly`,
          },
        detail_ref: bounded ? null : `liuhe-preview:${anchor.path}@${sha256(newContent)}`,
      },
    }
  }

  // ── ③ apply：锚点校验（fail-closed）→ 日记 → 原子写 → 回读实测 ──
  async function apply({ anchor, newContent, requestId } = {}) {
    if (typeof requestId !== 'string' || !requestId.trim()) {
      return liteError(LiteErrorCodes.INVALID_INPUT, 'request_id is required (idempotency key)')
    }
    if (!anchor || typeof anchor.path !== 'string') {
      return liteError(LiteErrorCodes.INVALID_INPUT, 'anchor is required')
    }
    if (typeof newContent !== 'string') {
      return liteError(LiteErrorCodes.INVALID_INPUT, 'newContent is required')
    }
    // Lite 的契约是「有明确所有权的 UTF-8 文本文件」。含 NUL 的内容必然是二进制：
    // 写进去能成功，但之后 readAnchor 会拒读——等于自己造一个 Lite 再也管不了的文件。
    if (newContent.includes('\u0000')) {
      return liteError(LiteErrorCodes.INVALID_INPUT, 'newContent contains a NUL byte — Lite only writes UTF-8 text')
    }
    const relPath = anchor.path
    const bad = scopeCheck(relPath)
    if (bad) return bad
    if (Buffer.byteLength(newContent, 'utf-8') > lim.maxFileBytes) {
      return liteError(LiteErrorCodes.FILE_TOO_LARGE, 'newContent exceeds Lite size limit')
    }

    // 幂等身份 = 「打算做什么」（目标路径 + 新内容），不含锚点：
    // 写完后锚点必然变化，把锚点算进身份会把同一次动作的重试误判成异载荷。
    const payloadHash = sha256(JSON.stringify({ path: relPath, after: sha256(newContent) }))

    // request_id 幂等：先查账本（成功 → 幂等复读，绝不重复写）
    const prev = ledgerLookup(wsRoot, requestId)
    if (prev) {
      if (prev.payload_hash && prev.payload_hash !== payloadHash) {
        return liteError(LiteErrorCodes.REQUEST_CONFLICT, 'request_id already used with a different payload')
      }
      if (prev.state === 'succeeded' && prev.receipt) {
        return { ok: true, receipt: prev.receipt, detail: { idempotent_replay: true } }
      }
      return liteError(LiteErrorCodes.INDETERMINATE,
        `request_id already recorded in state "${prev.state}" — refusing to re-execute blindly (it may already have written)`,
        { detail: { ledger_state: prev.state } })
    }
    const claim = ledgerClaim(wsRoot, requestId)
    if (!claim.ok) {
      return liteError(LiteErrorCodes.REQUEST_IN_FLIGHT, 'request_id is already in flight: ' + claim.reason)
    }
    ledgerRecord(wsRoot, {
      request_id: requestId, payload_hash: payloadHash, state: 'prepared',
      tool: 'lite.apply', created: new Date().toISOString(),
    })
    // 终态记账：任何提前返回都要把账本收口——否则同 request_id 的重试会拿到 'prepared'
    // 而误判成「可能已写入」，白白浪费一次幂等机会。
    const fail = (code, message, extra = {}) => {
      ledgerRecord(wsRoot, {
        request_id: requestId,
        state: code === LiteErrorCodes.INDETERMINATE ? 'indeterminate' : 'failed',
        error_code: code,
      })
      return liteError(code, message, extra)
    }

    const absPath = join(wsRoot, relPath)
    // 新建文件：目标目录可能尚不存在 → 先建目录再取锁（锁文件与目标同目录，否则 open('wx') ENOENT）
    if (anchor.exists === false) {
      try { mkdirSync(dirname(absPath), { recursive: true }) }
      catch (e) {
        const r = fail(LiteErrorCodes.WRITE_FAILED, 'cannot create target directory: ' + redact(e.message))
        // 明确没碰盘 → 放掉占位，同一个 request_id 可立即重试（否则重试会收到
        // REQUEST_IN_FLIGHT 这个假话：「正在执行」的东西其实早失败了）
        ledgerRelease(wsRoot, requestId)
        return r
      }
    }
    let lock
    try {
      lock = await acquireLock(absPath)
    } catch (e) {
      const r = fail(LiteErrorCodes.WRITE_FAILED, 'cannot acquire file lock: ' + redact(e.message))
      ledgerRelease(wsRoot, requestId)
      return r
    }
    if (lock.locked) {
      ledgerRecord(wsRoot, { request_id: requestId, state: 'failed', error_code: LiteErrorCodes.FILE_LOCKED })
      ledgerRelease(wsRoot, requestId)
      return liteError(LiteErrorCodes.FILE_LOCKED, 'file is locked by another writer: ' + relPath)
    }

    let journal = null
    let actionId = null
    try {
      // 现场读回 + 锚点比对（fail-closed：任何不一致都拒绝，绝不覆盖）
      const obs = observedOf(relPath)
      if (anchor.exists === false) {
        if (obs.exists) {
          return fail(LiteErrorCodes.VERSION_CONFLICT, 'target already exists (anchor expected absent): ' + relPath)
        }
      } else {
        if (!obs.exists) {
          return fail(LiteErrorCodes.VERSION_CONFLICT, 'target disappeared since anchor was read: ' + relPath)
        }
        if (obs.sha256 !== anchor.sha256) {
          const conflict = classifyConflict({ file: { hash: anchor.sha256 } }, { file: { hash: obs.sha256 } }, false)
          return fail(LiteErrorCodes.VERSION_CONFLICT, obs.too_large
            ? `target grew beyond the Lite size limit (${obs.size} > ${lim.maxFileBytes} bytes) — re-read before planning: ` + relPath
            : 'target changed since anchor was read: ' + relPath, {
            detail: { liuhe_conflict_type: conflict.type, observed_bytes: obs.size },
          })
        }
      }

      let currentContent = ''
      if (obs.exists) {
        const buf = readBytes(absPath)
        const dec = decodeText(buf || Buffer.alloc(0))
        if (!dec.ok) return fail(LiteErrorCodes.UNSUPPORTED_ENCODING, `unsupported content: ${dec.reason}`)
        currentContent = dec.text
      }

      // 日记先行：落盘失败 → fail-closed，一个字节都不写
      try {
        // 把 .malong/ 写进 .git/info/exclude（best-effort，幂等；不动被跟踪的 .gitignore）——
        // 否则事务日记会以未跟踪文件的形式出现在用户的 git status 里。
        // 注：产品的 write-journal 路径本身没做这件事（只有事务系路径做了），Lite 主动补上。
        try { ensureGitExclude(wsRoot) } catch {}
        journal = createJournal(wsRoot, relPath, absPath, currentContent, {
          editMode: 'lite_replace',
          issuer: JOURNAL_ISSUER,
          journal_format: JOURNAL_FORMAT,
          lite_version: LITE_VERSION,
          state: 'staged',
          base_file_hash: anchor.exists ? anchor.sha256 : null,
          ...(anchor.exists === false ? { created: true } : {}),
        })
      } catch (e) {
        // 证据没落盘 → persistence 真实反映为 failed，Undo 承诺必须撤销（不许虚报「可撤销」）
        ledgerRecord(wsRoot, { request_id: requestId, state: 'failed', error_code: LiteErrorCodes.PERSISTENCE_FAILED })
        const receipt = buildReceipt({
          actionId: 'act-pending-' + requestId, providerOperationId: null, cell: cellCtx, requestId,
          application: 'failed',
          effect: {
            kind: anchor.exists === false ? 'file_created' : 'file_modified',
            target: relPath,
            before_sha256: anchor.exists ? anchor.sha256 : null,
            after_sha256: null,
            detail_ref: null,
          },
          verification: 'not_run',
          recovery: { supported: false, ref: null },
          persistence: 'failed',
        })
        return liteError(LiteErrorCodes.PERSISTENCE_FAILED, 'journal could not be persisted — nothing was written', {
          receipt,
          detail: { reason: redact(e.message) },
        })
      }
      actionId = 'act-' + journal.txnId
      const newHash = sha256(newContent)
      updateJournalState(journal.dir, { state: 'staged', new_hash: newHash })

      // 测试钩子（仅测试环境注入；生产不设置 → 行为不变）
      if (process.env.MALONG_LITE_TEST_KILL_AFTER_JOURNAL === '1') process.kill(process.pid, 'SIGKILL')

      // 原子写：tmp + rename（权限继承；Windows 走 ReplaceFile 保留 ACL）
      try {
        atomicWrite(absPath, newContent, { preservePermissions: true })
      } catch (e) {
        try { updateJournalState(journal.dir, { state: 'failed', reason: e.message }) } catch {}
        ledgerRecord(wsRoot, { request_id: requestId, state: 'failed', error_code: LiteErrorCodes.WRITE_FAILED })
        return liteError(LiteErrorCodes.WRITE_FAILED, 'atomic write failed; target left unchanged', {
          detail: { reason: redact(e.message) },
        })
      }

      if (process.env.MALONG_LITE_TEST_KILL_AFTER_WRITE === '1') process.kill(process.pid, 'SIGKILL')

      // 回读实测：不拿「拟提交内容 hash」冒充「已生效证据」
      const after = observedOf(relPath)
      if (!after.exists || after.sha256 !== newHash) {
        try { updateJournalState(journal.dir, { state: 'indeterminate', reason: 'readback_mismatch' }) } catch {}
        const receipt = buildReceipt({
          actionId, providerOperationId: journal.txnId, cell: cellCtx, requestId,
          application: 'indeterminate',
          effect: {
            kind: anchor.exists === false ? 'file_created' : 'file_modified',
            target: relPath,
            before_sha256: anchor.exists ? anchor.sha256 : null,
            after_sha256: after.exists ? after.sha256 : null,
            detail_ref: 'liuhe:' + journal.txnId,
          },
          recovery: { supported: false, ref: 'liuhe-undo:' + journal.txnId },
          persistence: 'persisted',
        })
        ledgerRecord(wsRoot, { request_id: requestId, state: 'indeterminate', receipt, error_code: LiteErrorCodes.INDETERMINATE })
        return liteError(LiteErrorCodes.INDETERMINATE, 'post-write read-back mismatch — state indeterminate', {
          receipt,
          detail: { liuhe_code: 'READBACK_MISMATCH', txn_id: journal.txnId },
        })
      }

      updateJournalState(journal.dir, { state: 'committed', committed_at: new Date().toISOString() })
      try { auditLog(wsRoot, { event: 'lite_apply', file: relPath, txn_id: journal.txnId, action_id: actionId }) } catch {}

      const receipt = buildReceipt({
        actionId, providerOperationId: journal.txnId, cell: cellCtx, requestId,
        application: 'applied',
        effect: {
          kind: anchor.exists === false ? 'file_created' : 'file_modified',
          target: relPath,
          before_sha256: anchor.exists ? anchor.sha256 : null,
          after_sha256: after.sha256,       // 实测值，非拟提交值
          detail_ref: 'liuhe:' + journal.txnId,
        },
        verification: 'not_run',            // Lite 不跑代码检查：写入成功 ≠ 代码语义正确
        recovery: {
          supported: true,
          ref: 'liuhe-undo:' + journal.txnId,
          expires_at: new Date(Date.now() + JOURNAL_RETENTION_HOURS * 3600 * 1000).toISOString(),
        },
        persistence: 'persisted',
      })
      ledgerRecord(wsRoot, { request_id: requestId, state: 'succeeded', receipt })
      return { ok: true, receipt, detail: { txn_id: journal.txnId, liuhe_code: 'OK' } }
    } finally {
      lock.release()
      ledgerRelease(wsRoot, requestId)
      // 清扫放在 finally：成功、原子写失败、回读不一致三条路径都过这里（土行孙 A-1）。
      // 只碰自己的过期日记，best-effort，绝不让清扫异常影响动作结果。
      try { pruneLiteJournals() } catch {}
    }
  }

  // ── ④ inspect：动作效果详情（按需查，不塞进每轮上下文）──
  function inspect({ actionId } = {}) {
    const txnId = String(actionId || '').replace(/^act-/, '')
    if (!txnId) return liteError(LiteErrorCodes.INVALID_INPUT, 'action_id is required')
    const claim = claimJournal(txnId)
    if (!claim.ok && claim.reason === 'unreadable') {
      return liteError(LiteErrorCodes.RECOVERY_UNAVAILABLE, 'journal exists but is unreadable — cannot describe the effect: ' + txnId, {
        detail: { txn_id: txnId, reason: 'unreadable' },
      })
    }
    if (!claim.ok && claim.reason === 'missing') {
      return liteError(LiteErrorCodes.RECOVERY_UNAVAILABLE, 'journal not found for action: ' + txnId)
    }
    if (!claim.ok) return foreignJournalError('inspect', txnId, claim)
    const { dir, state, manifest } = claim.journal
    const relPath = manifest.file
    const obs = observedOf(relPath)
    const before = backupHashOf(dir, manifest)
    const patchPath = join(dir, 'backup', String(relPath).split(/[\\/]/).pop())
    let backupBytes = null
    try { backupBytes = statSync(patchPath).size } catch {}
    const expiry = journalExpiryOf(state, manifest)
    const expired = expiry ? expiry.getTime() < Date.now() : null
    return {
      ok: true,
      effect: {
        action_id: 'act-' + txnId,
        journal_owner: claim.ownership,
        target: relPath,
        before_sha256: before,
        after_sha256: state.new_hash ?? null,
        current_sha256: obs.sha256,
        current_exists: obs.exists,
        current_size: obs.size,
        current_mtime_ms: obs.mtime_ms,
        journal_state: state.state,
        created: state.created === true,
        base_file_hash: state.base_file_hash ?? null,
        undo_supported: (state.state === 'committed' || state.state === 'committed_recovered') && expired !== true,
        undo_ref: 'liuhe-undo:' + txnId,
        undo_expires_at: expiry ? expiry.toISOString() : null,
        undo_expired: expired,
        backup_bytes: backupBytes,
      },
    }
  }

  // ── ⑤ undo：只对本适配器确有恢复证据的动作，且要求文件仍是「那次动作完成后的版本」──
  async function undo({ recoveryRef, requestId } = {}) {
    if (typeof requestId !== 'string' || !requestId.trim()) {
      return liteError(LiteErrorCodes.INVALID_INPUT, 'request_id is required (idempotency key)')
    }
    const txnId = String(recoveryRef || '').replace(/^liuhe-undo:/, '').replace(/^act-/, '')
    if (!txnId) return liteError(LiteErrorCodes.INVALID_INPUT, 'recovery_ref is required')
    // 所有权先于一切磁盘动作：不属于 Lite 的日记连 state.json 都不碰。
    const owned = claimJournal(txnId)
    if (!owned.ok && owned.reason === 'unreadable') {
      return liteError(LiteErrorCodes.RECOVERY_UNAVAILABLE, 'journal exists but is unreadable — refusing to undo blindly', {
        detail: { txn_id: txnId, reason: 'unreadable' },
      })
    }
    if (!owned.ok && owned.reason !== 'missing') return foreignJournalError('undo', txnId, owned)
    const { state, manifest } = owned.journal
    const relPath = manifest && typeof manifest.file === 'string' ? manifest.file : null
    const beforeUndo = relPath ? observedOf(relPath) : { exists: false, sha256: null }

    // request_id 幂等身份 = 「撤销哪个事务」。此前 undo 完全不看账本：同 id 重试会再跑一次
    // restoreJournal（得到 already_undone，却把回执写成 file_restored），换个 recoveryRef
    // 复用同 id 更会静默撤销另一个事务。
    const undoPayload = sha256('undo:' + txnId)
    const prev = ledgerLookup(wsRoot, requestId)
    if (prev) {
      if ((prev.payload_hash && prev.payload_hash !== undoPayload) || (prev.txn_id && prev.txn_id !== txnId)) {
        return liteError(LiteErrorCodes.REQUEST_CONFLICT, 'request_id already used to undo a different transaction', {
          detail: { requested_txn_id: txnId, recorded_txn_id: prev.txn_id ?? null },
        })
      }
      if (prev.state === 'succeeded' && prev.receipt) {
        return { ok: true, receipt: prev.receipt, detail: { idempotent_replay: true } }
      }
      return liteError(LiteErrorCodes.INDETERMINATE,
        `request_id already recorded in state "${prev.state}" — refusing to re-execute blindly (the undo may already have run)`,
        { detail: { ledger_state: prev.state } })
    }

    // 过期即拒（土行孙 A-2）：0.1.2 里 inspect 说不能撤、undo 却真撤了——同一事实两处写、只查了一处。
    // 幂等复读不受影响（上面的 replay 分支已提前返回），这里只挡「新执行」。
    const undoExpiry = journalExpiryOf(state, manifest)
    if (undoExpiry && undoExpiry.getTime() < Date.now()) {
      return liteError(LiteErrorCodes.NOT_UNDOABLE,
        'undo window has expired (journal older than ' + JOURNAL_RETENTION_HOURS + 'h) — refusing to undo', {
          detail: {
            txn_id: txnId, reason: 'undo_expired',
            journal_state: state?.state ?? null,
            undo_expires_at: undoExpiry.toISOString(),
            committed_at: state?.committed_at ?? null,
          },
        })
    }

    const claim = ledgerClaim(wsRoot, requestId)
    if (!claim.ok) return liteError(LiteErrorCodes.REQUEST_IN_FLIGHT, 'request_id is already in flight: ' + claim.reason)
    ledgerRecord(wsRoot, {
      request_id: requestId, payload_hash: undoPayload, txn_id: txnId,
      state: 'prepared', tool: 'lite.undo', created: new Date().toISOString(),
    })
    try {
      const res = await restoreJournal(wsRoot, txnId)
      if (!res.ok) {
        const code = mapLiuheCode(res.code)
        ledgerRecord(wsRoot, { request_id: requestId, state: 'failed', error_code: code })
        return liteError(code, redact(res.message || res.code), {
          detail: {
            liuhe_code: res.code,
            suggestion: res.suggestion ? redact(res.suggestion) : null,
          },
        })
      }
      const after = relPath ? observedOf(relPath) : { exists: false, sha256: null }
      // 只有真写了盘才算「恢复了文件」：already_undone / already_restored 时本次调用没改任何字节，
      // 回执还报 file_restored 就是在谎称又撤销了一次（L20 场景）。
      const wroteNow = res.status === 'undone'
      const backupHash = relPath && manifest ? backupHashOf(owned.journal.dir, manifest) : null
      // 回读实测（与 apply 同一标准）：声称撤成功，磁盘就必须真的回到备份版本。
      let inconsistent = null
      if (wroteNow) {
        if (res.deleted) {
          if (after.exists) inconsistent = 'undo_readback_mismatch: created file still exists'
        } else if (backupHash && after.sha256 !== backupHash) {
          inconsistent = 'undo_readback_mismatch: file does not match the journal backup'
        }
      }
      const kind = res.deleted ? 'file_deleted' : (wroteNow ? 'file_restored' : 'none')
      const receipt = buildReceipt({
        actionId: 'act-' + txnId, providerOperationId: txnId, cell: cellCtx, requestId,
        application: inconsistent ? 'indeterminate' : (wroteNow ? 'applied' : 'not_applied'),
        effect: {
          kind,
          target: relPath,
          before_sha256: beforeUndo.sha256,
          after_sha256: after.sha256,
          detail_ref: 'liuhe:' + txnId,
        },
        verification: 'not_run',
        recovery: { supported: false, ref: null },
        persistence: 'persisted',
        extension: {
          undo_status: res.status,
          files: res.files || [],
          wrote_now: wroteNow,
          ...(inconsistent ? { reason: inconsistent } : {}),
        },
      })
      if (inconsistent) {
        ledgerRecord(wsRoot, { request_id: requestId, state: 'indeterminate', receipt, error_code: LiteErrorCodes.INDETERMINATE })
        return liteError(LiteErrorCodes.INDETERMINATE, inconsistent + ' — undo outcome is indeterminate', {
          receipt, detail: { liuhe_code: res.code || 'READBACK_MISMATCH', txn_id: txnId },
        })
      }
      ledgerRecord(wsRoot, { request_id: requestId, state: 'succeeded', receipt })
      return { ok: true, receipt, detail: { liuhe_code: res.status, files: res.files || [], wrote_now: wroteNow } }
    } finally {
      ledgerRelease(wsRoot, requestId)
    }
  }

  // ── ⑥ reconcile：按 journal + 前/后版本重新识别落地状态（只读，不改盘）──
  function reconcile({ actionId } = {}) {
    const txnId = String(actionId || '').replace(/^act-/, '')
    if (!txnId) return liteError(LiteErrorCodes.INVALID_INPUT, 'action_id is required')
    const owned = claimJournal(txnId)
    if (!owned.ok && owned.reason !== 'missing' && owned.reason !== 'unreadable') return foreignJournalError('reconcile', txnId, owned)
    const { state, manifest } = owned.journal
    if (!state || !manifest) {
      const receipt = buildReceipt({
        actionId: 'act-' + txnId, providerOperationId: txnId, cell: cellCtx, requestId: null,
        application: 'indeterminate',
        effect: { kind: 'none', target: null, before_sha256: null, after_sha256: null, detail_ref: 'liuhe:' + txnId },
        recovery: { supported: false, ref: null },
        persistence: 'unknown',
      })
      return liteError(LiteErrorCodes.INDETERMINATE,
        owned.reason === 'unreadable'
          ? 'journal exists but is unreadable — cannot determine outcome'
          : 'no journal evidence for this action — cannot determine outcome', {
          receipt,
          detail: { journal_state: null, reason: owned.reason },
        })
    }
    const relPath = manifest.file
    const obs = observedOf(relPath)
    const before = backupHashOf(owned.journal.dir, manifest)
    const after = state.new_hash ?? null
    let application
    let reason
    if (state.state === 'undone' || state.state === 'rolled_back') {
      // 落地后又被撤销：净效果为「无」——但必须说清它是「提交过又撤销」，
      // 不能让 Cell 误以为「从没发生过」（那会让人以为动作没跑、白白重试）。
      application = 'not_applied'
      reason = state.state === 'undone'
        ? 'action was committed and later undone — the file is back at the pre-write version (net effect: none)'
        : 'action was rolled back — the file is back at the pre-write version (net effect: none)'
    } else if (state.state === 'indeterminate') {
      application = 'indeterminate'; reason = 'journal marked indeterminate (readback mismatch at write time)'
    } else if (before && obs.exists && obs.sha256 === before) {
      application = 'not_applied'; reason = 'file still equals the pre-write backup — the write never landed'
    } else if (after && obs.exists && obs.sha256 === after) {
      application = 'applied'; reason = 'file equals the post-write hash'
    } else if (!obs.exists && state.created === true) {
      application = 'not_applied'; reason = 'created file is absent — the write never landed'
    } else {
      application = 'needs_review'; reason = 'file differs from both the pre-write backup and the post-write hash — external change'
    }
    // 过期口径与 inspect/undo 同源（土行孙 A-2）：reconcile 的回执也不得对过期事务承诺可撤销。
    const recExpiry = journalExpiryOf(state, manifest)
    const recExpired = recExpiry ? recExpiry.getTime() < Date.now() : false
    const receipt = buildReceipt({
      actionId: 'act-' + txnId, providerOperationId: txnId, cell: cellCtx, requestId: null,
      application,
      effect: {
        kind: state.created === true ? 'file_created' : 'file_modified',
        target: relPath,
        before_sha256: before,
        after_sha256: after,
        detail_ref: 'liuhe:' + txnId,
      },
      verification: 'not_run',
      recovery: {
        supported: (state.state === 'committed' || state.state === 'committed_recovered') && !recExpired,
        ref: 'liuhe-undo:' + txnId,
        expires_at: recExpiry ? recExpiry.toISOString() : null,
      },
      persistence: 'persisted',
      extension: { journal_state: state.state, journal_owner: owned.ownership, reason },
    })
    if (application === 'applied' || application === 'not_applied') {
      return { ok: true, receipt, detail: { journal_state: state.state, reason } }
    }
    // ok:false 必须带 error——此前 needs_review/indeterminate 返回 ok:false 却不带 error，
    // Cell 只能猜「发生了什么」。needs_review 用独立码（retry=never）：再 reconcile 也不会自愈，
    // 归到 INDETERMINATE（after_reconcile）会把 Cell 送进死循环。
    const code = application === 'needs_review' ? LiteErrorCodes.NEEDS_REVIEW : LiteErrorCodes.INDETERMINATE
    return liteError(code, reason, { receipt, detail: { journal_state: state.state, application, reason } })
  }

  return {
    provider: LITE_PROVIDER,
    version: LITE_VERSION,
    workspace: { realPath: wsRoot, id: workspace.id ?? null },
    cell: cellCtx,
    limits: lim,
    readAnchor, preview, apply, inspect, undo, reconcile,
  }
}
