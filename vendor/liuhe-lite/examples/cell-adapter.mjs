// examples/cell-adapter.mjs — 土行孙 Cell 侧接线参考实现（可整段抄进 Cell）
//
// 这层很薄，但它把三件最容易做错的事固定死：
//   1. 工作区真值只来自宿主运行时 host.workspaceRealPath()。模型参数里出现 workspace / workspace_dir /
//      realPath / cwd 一律拒绝——这是授权边界，不是可修参数。
//   2. 六个动作原样透传，只补一层「Cell 该怎么办」的处置建议：能不能重试、要用同一个还是新的
//      request_id、要不要重新取锚点、要不要先 reconcile。
//   3. 取消/超时不折算成「已取消且无副作用」。取消来得比写盘晚，就明说「可能已落地，先去对账」。
//
// 自检：node examples/cell-adapter.mjs

import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createLiteEditor, LITE_VERSION } from '../lite/index.js'
import { RETRY_POLICY, policyOf } from '../lite/errors.js'

// 这几个参数名一旦出现在动作入参里，就说明调用方试图自己指定工作区 → 直接拒
export const FORBIDDEN_PARAMS = ['workspace', 'workspace_dir', 'workspaceDir', 'realPath', 'real_path', 'cwd', 'root']

// 错误码 → Cell 侧处置建议：**单一真值在 lite/errors.js**（原生入口已经返回 handling）。
// 这里重新导出只是给 Cell 侧做静态表用；不要再维护第二份，否则文档/代码会漂。
// retry 取值：never / same_request_id / new_request / after_reanchor / after_reconcile
export const CELL_HANDLING = RETRY_POLICY

function handlingOf(code) {
  return policyOf(code)
}

// host 契约（Cell 宿主实现这三个钩子即可）：
//   host.workspaceRealPath() -> string   必填。本次动作被授权的唯一工作区（宿主从自己的授权真值取）
//   host.cell()              -> object   可选。{ cellId, incarnationId, taskId } → 写进回执
//   host.onEvent(event)      -> void     可选。动作事件，供 Cell 记账/审计
//   host.workspaceId()       -> string   可选。工作区标识（写进回执 extension 之外的 workspace 字段）
export function createCellAdapter({ host, limits } = {}) {
  if (!host || typeof host.workspaceRealPath !== 'function') {
    throw new Error('createCellAdapter: host.workspaceRealPath() is required — 工作区真值只能由宿主运行时提供')
  }
  const editor = createLiteEditor({
    workspace: {
      realPath: host.workspaceRealPath(),
      id: typeof host.workspaceId === 'function' ? host.workspaceId() : null,
    },
    cell: typeof host.cell === 'function' ? host.cell() : {},
    limits,
  })

  // 授权边界：动作入参里不许出现工作区类参数
  function guardArgs(action, args) {
    if (args && typeof args === 'object') {
      for (const k of FORBIDDEN_PARAMS) {
        if (Object.prototype.hasOwnProperty.call(args, k)) {
          return {
            ok: false,
            action,
            error: {
              code: 'WORKSPACE_PARAM_FORBIDDEN',
              message: action + ': 入参不允许出现 ' + k + ' —— 工作区由宿主运行时决定，不是模型可选参数',
              handling: { retry: 'never', note: '授权边界，不是参数错误；不要尝试换别的字段名绕过' },
            },
          }
        }
      }
    }
    return null
  }

  function wrap(action, raw) {
    if (raw && raw.ok === false) {
      const code = (raw.error && raw.error.code) || 'WRITE_FAILED'
      const out = {
        ok: false,
        action,
        // 原生已带 handling 就用原生的（同一合同面）；老版本/未登记码才兜底查表。
        error: { ...raw.error, code, handling: raw.error.handling || handlingOf(code) },
        detail: raw.detail === undefined ? null : raw.detail,
      }
      // 失败也要带证据：原生可能已把日记/回执落盘（persistence_failed / 回读不一致 /
      // needs_review）。此前这层把 receipt 吃掉了，Cell 过一层就只剩一句 message。
      if (raw.receipt) out.receipt = raw.receipt
      return out
    }
    return { ok: true, action, ...raw }
  }

  function cancelledBeforeStart(action) {
    return {
      ok: false,
      action,
      error: {
        code: 'CANCELLED_BEFORE_START',
        message: '取消发生在执行前，未触碰磁盘',
        handling: { retry: 'new_request', note: '可安全重做' },
      },
    }
  }

  function emit(evt) {
    if (typeof host.onEvent === 'function') {
      try { host.onEvent(evt) } catch { /* 观测失败不影响动作 */ }
    }
  }

  return {
    version: LITE_VERSION,
    provider: 'liuhe-lite',

    describe() {
      return {
        version: LITE_VERSION,
        provider: 'liuhe-lite',
        actions: ['readAnchor', 'preview', 'apply', 'inspect', 'undo', 'reconcile'],
        workspace: { realPath: host.workspaceRealPath() },
        guarantees: {
          workspace_from_host: true,
          verification_always: 'not_run',
          cancel_semantics: 'abort 不折算成「已取消且无副作用」；晚于写盘就要求 reconcile',
        },
      }
    },

    readAnchor(args) {
      const bad = guardArgs('readAnchor', args)
      if (bad) return bad
      const r = wrap('readAnchor', editor.readAnchor(args))
      emit({ event: 'readAnchor', ok: r.ok, code: r.ok ? null : r.error.code })
      return r
    },

    preview(args) {
      const bad = guardArgs('preview', args)
      if (bad) return bad
      return wrap('preview', editor.preview(args))
    },

    async apply(args, opts) {
      const bad = guardArgs('apply', args)
      if (bad) return bad
      const signal = opts && opts.signal
      if (signal && signal.aborted) return cancelledBeforeStart('apply')
      const r = wrap('apply', await editor.apply(args))
      if (signal && signal.aborted) {
        // 取消来得比写盘晚：可能已落地。绝不替 Cell 声称「已取消且无副作用」。
        r.cancel = {
          requested_during: true,
          honest_result: '动作可能已经落地；不要按「已取消」处理，先 reconcile 再决定',
        }
      }
      emit({ event: 'apply', ok: r.ok, code: r.ok ? null : r.error.code })
      return r
    },

    inspect(args) {
      const bad = guardArgs('inspect', args)
      if (bad) return bad
      return wrap('inspect', editor.inspect(args))
    },

    async undo(args, opts) {
      const bad = guardArgs('undo', args)
      if (bad) return bad
      const signal = opts && opts.signal
      if (signal && signal.aborted) return cancelledBeforeStart('undo')
      const r = wrap('undo', await editor.undo(args))
      if (signal && signal.aborted) {
        r.cancel = {
          requested_during: true,
          honest_result: '撤销可能已经落地；先 reconcile 再决定',
        }
      }
      emit({ event: 'undo', ok: r.ok, code: r.ok ? null : r.error.code })
      return r
    },

    reconcile(args) {
      const bad = guardArgs('reconcile', args)
      if (bad) return bad
      const r = wrap('reconcile', editor.reconcile(args))
      emit({ event: 'reconcile', ok: r.ok, code: r.ok ? null : r.error.code })
      return r
    },
  }
}

// ── 自检：跑一遍完整闭环，并把「Cell 会看到的形状」打出来 ──
async function selfCheck() {
  const root = mkdtempSync(join(tmpdir(), 'lite-cell-adapter-'))
  // 隔离账本与日记，不污染用户级 ~/.config/malong
  process.env.MALONG_STATE_DIR = join(root, 'state')
  const ws = join(root, 'workspace')
  mkdirSync(ws, { recursive: true })
  writeFileSync(join(ws, 'a.txt'), 'v1\n')

  const events = []
  const adapter = createCellAdapter({
    host: {
      workspaceRealPath: () => ws,
      cell: () => ({ cellId: 'demo-cell', incarnationId: 'inc-1', taskId: 'demo-task' }),
      onEvent: (e) => events.push(e.event),
    },
  })

  const rows = []
  const a = adapter.readAnchor({ path: 'a.txt' })
  rows.push(['readAnchor', a.ok, a.ok ? 'sha256=' + a.anchor.sha256.slice(0, 12) : a.error.code])

  const p = adapter.preview({ anchor: a.anchor, newContent: 'v2\n' })
  rows.push(['preview', p.ok, p.ok ? p.preview.diff.lines_changed + ' 行变更 / applied=' + p.preview.applied : p.error.code])

  const ap = await adapter.apply({ anchor: a.anchor, newContent: 'v2\n', requestId: 'demo-1' })
  rows.push(['apply', ap.ok, ap.ok ? 'application=' + ap.receipt.application + ' / persistence=' + ap.receipt.persistence : ap.error.code])

  const ins = adapter.inspect({ actionId: ap.receipt.action_id })
  rows.push(['inspect', ins.ok, ins.ok ? 'ok' : ins.error.code])

  // 冲突：此刻磁盘已是 v2，拿 v1 的旧锚点再写 → 必须 fail-closed。
  // 顺序很关键：必须放在 undo 之前。undo 会把文件退回 v1，那时同一个旧锚点又变成有效锚点了。
  const stale = await adapter.apply({ anchor: a.anchor, newContent: 'v3\n', requestId: 'demo-3' })
  rows.push(['旧锚点重写', stale.ok === false, stale.ok === false ? stale.error.code + ' / retry=' + stale.error.handling.retry : '居然通过了（bug）'])
  const afterConflict = readFileSync(join(ws, 'a.txt'), 'utf-8')
  rows.push(['冲突后磁盘未变', afterConflict === 'v2\n', JSON.stringify(afterConflict)])

  const rc = adapter.reconcile({ actionId: ap.receipt.action_id })
  rows.push(['reconcile', rc.ok, rc.ok ? 'application=' + rc.receipt.application : rc.error.code])

  const un = await adapter.undo({ recoveryRef: ap.receipt.recovery.ref, requestId: 'demo-2' })
  rows.push(['undo', un.ok, un.ok ? 'application=' + un.receipt.application : un.error.code])

  const rc2 = adapter.reconcile({ actionId: ap.receipt.action_id })
  rows.push(['撤销后再对账', rc2.ok, rc2.ok ? 'application=' + rc2.receipt.application : rc2.error.code])

  const disk = readFileSync(join(ws, 'a.txt'), 'utf-8')
  rows.push(['磁盘回读', disk === 'v1\n', JSON.stringify(disk)])

  // 授权边界：传 workspace_dir 试图换工作区
  const esc = adapter.readAnchor({ path: 'a.txt', workspace_dir: ws })
  rows.push(['传 workspace_dir', esc.ok === false, esc.ok === false ? esc.error.code : '居然通过了（bug）'])

  // 越界路径
  const out = adapter.readAnchor({ path: '../outside.txt' })
  rows.push(['越界路径', out.ok === false, out.ok === false ? out.error.code : '居然通过了（bug）'])

  const w = Math.max(...rows.map((r) => r[0].length))
  console.log('== LiuHe Lite 自检（' + LITE_VERSION + '）==')
  console.log('  工作区: ' + ws)
  for (const r of rows) {
    const mark = r[1] ? '✓' : '✗'
    console.log('  ' + mark + ' ' + r[0].padEnd(w) + '  ' + r[2])
  }
  console.log('  事件流: ' + events.join(' → '))
  const ok = rows.every((r) => r[1])
  rmSync(root, { recursive: true, force: true })
  console.log(ok ? '  结果: 全部符合预期' : '  结果: 有不符合预期的项')
  return ok
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  selfCheck().then((ok) => process.exit(ok ? 0 : 1)).catch((e) => { console.error(e); process.exit(1) })
}
