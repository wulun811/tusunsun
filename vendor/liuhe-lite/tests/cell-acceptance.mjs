// tests/cell-acceptance.mjs — 同步点 C 验收脚本（土行孙侧可自己跑）
//
// 这条脚本不是替代 L01–L16，它验的是另一件事：**按 Cell 的接法**（宿主给工作区、
// 经 examples/cell-adapter.mjs 那层）跑一遍完整闭环，看回执能不能被独立核对。
//
// 用法：
//   node tests/cell-acceptance.mjs
//       → 在临时工作区跑完整闭环（不动你任何文件）
//   LITE_CELL_WORKSPACE=/path/to/workspace node tests/cell-acceptance.mjs
//       → 只读模式：只对该工作区做 readAnchor / 越界 / 授权检查，绝不写入
//
// 退出码：0 = 全部通过；1 = 有失败项（失败项会打印错在哪里）

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { createCellAdapter } from '../examples/cell-adapter.mjs'

const rows = []
function record(id, title, ok, info) {
  rows.push({ id, title, ok, info: info === undefined ? '' : String(info) })
  return ok
}
function sha(text) { return createHash('sha256').update(text, 'utf-8').digest('hex') }

// 只读模式的硬证据：记录 (相对路径, size, mtime) 全量指纹（不读内容，不碰文件）。
// 「只读」是脚本自己对外承诺的，不能只写在注释里——真比对一遍，否则这句承诺就是假话。
function fingerprint(dir, limit = 5000) {
  const rows = []
  const walk = (d, base) => {
    if (rows.length >= limit) return
    let ents = []
    try { ents = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (rows.length >= limit) return
      const p = join(d, e.name)
      const rel = base ? base + '/' + e.name : e.name
      if (e.isDirectory()) {
        rows.push(rel + '/ dir')
        walk(p, rel)
      } else {
        try { const st = statSync(p); rows.push(rel + ' ' + st.size + ' ' + st.mtimeMs) } catch { rows.push(rel + ' unreadable') }
      }
    }
  }
  walk(dir, '')
  return rows
}

async function readonlyMode(ws) {
  const adapter = createCellAdapter({ host: { workspaceRealPath: () => ws } })
  const before = fingerprint(ws)

  const desc = adapter.describe()
  record('C01', '宿主授权：adapter 自述里的工作区 = 宿主给定的路径', desc.workspace.realPath === ws, desc.workspace.realPath)

  // 探针要选一个真实存在的文件；全都不在时只验证「缺失文件」语义（并如实标注）。
  const probe = ['README.md', 'package.json', 'AGENTS.md', 'pyproject.toml', 'Cargo.toml']
    .find((f) => existsSync(join(ws, f)))
  const a = probe ? adapter.readAnchor({ path: probe }) : adapter.readAnchor({ path: '__lite_probe_absent__.md' })
  record('C02', 'readAnchor 在工作区内可读（探针：' + (probe || '缺失文件') + '）',
    a.ok === true, a.ok ? 'exists=' + a.anchor.exists : a.error.code)

  const esc = adapter.readAnchor({ path: probe || 'README.md', workspace_dir: ws })
  record('C03', '模型传 workspace_dir 被拒（授权边界）', esc.ok === false && esc.error.code === 'WORKSPACE_PARAM_FORBIDDEN', esc.ok ? '居然通过了' : esc.error.code)

  const out = adapter.readAnchor({ path: '../outside.txt' })
  record('C04', '越界路径被拒', out.ok === false && out.error.code === 'PATH_OUT_OF_SCOPE', out.ok ? '居然通过了' : out.error.code)

  // C05 前面说的「全程不写」必须自己证明：size/mtime 全量指纹比对
  const changed = []
  const after = fingerprint(ws)
  const max = Math.max(before.length, after.length)
  for (let i = 0; i < max; i++) if (before[i] !== after[i]) changed.push(String(before[i]) + ' → ' + String(after[i]))
  record('C05', '只读模式没写盘（全量 size/mtime 指纹前后一致）', changed.length === 0, changed.slice(0, 3).join('; ') || 'ok')

  console.log('== LiuHe Lite 同步点 C 验收（只读模式）==')
  console.log('  工作区: ' + ws + '（已有内容，全程不写）')
  return finish()
}

async function fullMode(root) {
  const ws = join(root, 'ws')
  mkdirSync(ws, { recursive: true })
  writeFileSync(join(ws, 'target.txt'), 'v1\n')

  const adapter = createCellAdapter({
    host: {
      workspaceRealPath: () => ws,
      cell: () => ({ cellId: 'accept-cell', incarnationId: 'inc-accept', taskId: 'acceptance' }),
    },
  })
  const nonce = String(Date.now())
  const req = (tag) => 'accept-' + tag + '-' + nonce

  // ── C01 宿主授权 ──
  const desc = adapter.describe()
  record('C01', '工作区真值来自宿主运行时（describe 与宿主一致）', desc.workspace.realPath === ws, desc.workspace.realPath)

  const esc = adapter.readAnchor({ path: 'target.txt', workspace_dir: ws })
  record('C02', '模型传 workspace_dir 被拒（授权边界）', esc.ok === false && esc.error.code === 'WORKSPACE_PARAM_FORBIDDEN', esc.ok ? '居然通过了' : esc.error.code)

  // ── C03 越界：拒绝且工作区外无落盘 ──
  const outside = join(root, 'outside.txt')
  const outWrite = await adapter.apply({ anchor: { path: '../outside.txt', exists: false, sha256: null }, newContent: 'pwn\n', requestId: req('escape') })
  record('C03', '越界写入被拒且工作区外无文件', outWrite.ok === false && outWrite.error.code === 'PATH_OUT_OF_SCOPE' && !existsSync(outside), outWrite.ok ? '居然通过了' : outWrite.error.code)

  // ── C04 预览无副作用 ──
  const a0 = adapter.readAnchor({ path: 'target.txt' })
  const before = readFileSync(join(ws, 'target.txt'), 'utf-8')
  const pv = adapter.preview({ anchor: a0.anchor, newContent: 'v2\n' })
  const afterPreview = readFileSync(join(ws, 'target.txt'), 'utf-8')
  record('C04', 'preview 不写盘（磁盘字节前后一致 + applied=false）', pv.ok === true && pv.preview.applied === false && before === afterPreview, pv.ok ? 'lines_changed=' + pv.preview.diff.lines_changed : pv.error.code)

  // ── C05 提交：回执与磁盘独立核对 ──
  const ap = await adapter.apply({ anchor: a0.anchor, newContent: 'v2\n', requestId: req('apply') })
  const diskAfter = readFileSync(join(ws, 'target.txt'), 'utf-8')
  const r = ap.ok ? ap.receipt : null
  const c05ok = ap.ok === true
    && r.application === 'applied'
    && r.effect.kind === 'file_modified'
    && r.effect.before_sha256 === sha('v1\n')
    && r.effect.after_sha256 === sha(diskAfter)
    && diskAfter === 'v2\n'
  record('C05', 'apply 成功：effect 前后 hash 与真实磁盘独立核对一致', c05ok, ap.ok ? r.effect.kind + ' / ' + r.application : ap.error.code)

  // ── C06 回执契约字段 ──
  const c06ok = ap.ok === true
    && r.schema_version === 'tusunsun.action-receipt/v0'
    && r.provider === 'liuhe-lite'
    && r.verification === 'not_run'
    && r.persistence === 'persisted'
    && r.recovery && r.recovery.supported === true && typeof r.recovery.ref === 'string'
  record('C06', '回执契约：schema/provider/verification=not_run/persistence/recovery', c06ok, ap.ok ? 'ok' : ap.error.code)

  // ── C07 旧锚点冲突 fail-closed ──
  const stale = await adapter.apply({ anchor: a0.anchor, newContent: 'v3\n', requestId: req('stale') })
  const afterStale = readFileSync(join(ws, 'target.txt'), 'utf-8')
  record('C07', '旧锚点复写被拒（fail-closed）且磁盘未被覆盖', stale.ok === false && stale.error.code === 'VERSION_CONFLICT' && afterStale === 'v2\n', stale.ok ? '居然通过了' : stale.error.code + ' / retry=' + stale.error.handling.retry)

  // ── C08 幂等重试：同 request_id 不重复写 ──
  const replay = await adapter.apply({ anchor: a0.anchor, newContent: 'v2\n', requestId: r.request_id })
  const afterReplay = readFileSync(join(ws, 'target.txt'), 'utf-8')
  record('C08', '同 request_id 重试幂等（不重复写，且磁盘不变）', replay.ok === true && replay.detail && replay.detail.idempotent_replay === true && afterReplay === 'v2\n', replay.ok ? 'idempotent_replay=' + replay.detail.idempotent_replay : replay.error.code)

  // ── C09 取消早于执行：不碰盘 ──
  const ac1 = new AbortController()
  ac1.abort()
  const cancelled = await adapter.apply({ anchor: { path: 'target.txt', exists: true, sha256: sha('v2\n') }, newContent: 'v9\n', requestId: req('cancel-early') }, { signal: ac1.signal })
  record('C09', '取消早于执行：明确未碰盘（CANCELLED_BEFORE_START）', cancelled.ok === false && cancelled.error.code === 'CANCELLED_BEFORE_START' && readFileSync(join(ws, 'target.txt'), 'utf-8') === 'v2\n', cancelled.ok ? '居然通过了' : cancelled.error.code)

  // ── C10 取消晚于写盘：不谎报「无副作用」 ──
  const ac2 = new AbortController()
  const pending = adapter.apply({ anchor: { path: 'target.txt', exists: true, sha256: sha('v2\n') }, newContent: 'v3\n', requestId: req('cancel-late') }, { signal: ac2.signal })
  ac2.abort()
  const late = await pending
  const diskLate = readFileSync(join(ws, 'target.txt'), 'utf-8')
  const c10ok = late.ok === true
    && late.cancel && late.cancel.requested_during === true
    && diskLate === 'v3\n'
    && late.receipt.application === 'applied'
  record('C10', '取消晚于写盘：如实标注可能已落地，不声称「已取消且无副作用」', c10ok, late.ok ? 'cancel=' + JSON.stringify(late.cancel && late.cancel.requested_during) + ' / disk=' + JSON.stringify(diskLate) : late.error.code)

  // ── C11 撤销：磁盘回旧版 + 回执可核对 ──
  const a2 = adapter.readAnchor({ path: 'target.txt' })   // 现在应是 v3
  const ap2 = await adapter.apply({ anchor: a2.anchor, newContent: 'v4\n', requestId: req('apply2') })
  const un = ap2.ok ? await adapter.undo({ recoveryRef: ap2.receipt.recovery.ref, requestId: req('undo') }) : { ok: false, error: { code: 'SKIPPED' } }
  const diskUndone = readFileSync(join(ws, 'target.txt'), 'utf-8')
  record('C11', 'undo 把文件退回旧内容（v3）且返回可核对回执', un.ok === true && diskUndone === 'v3\n', un.ok ? un.receipt.application + ' / disk=' + JSON.stringify(diskUndone) : un.error.code)

  // ── C12 撤销后再对账：not_applied 但要说清来龙去脉 ──
  const rcv = ap2.ok ? adapter.reconcile({ actionId: ap2.receipt.action_id }) : { ok: false, error: { code: 'SKIPPED' } }
  const hasReason = rcv.ok && rcv.receipt.extension && Object.keys(rcv.receipt.extension).length > 0
  record('C12', '撤销后再对账：报 not_applied，且 extension 说明「提交过又撤销」（不谎报从未落地）', rcv.ok === true && rcv.receipt.application === 'not_applied' && hasReason, rcv.ok ? rcv.receipt.application + ' / extension=' + JSON.stringify(rcv.receipt.extension).slice(0, 60) : rcv.error.code)

  console.log('== LiuHe Lite 同步点 C 验收（完整闭环）==')
  console.log('  工作区: ' + ws + '（临时目录，跑完即删）')
  return finish()
}

function finish() {
  const w1 = Math.max(...rows.map((x) => x.id.length))
  const w2 = Math.max(...rows.map((x) => x.title.length))
  for (const x of rows) {
    console.log('  ' + (x.ok ? '✓' : '✗') + ' ' + x.id.padEnd(w1) + '  ' + x.title.padEnd(w2) + '  ' + x.info)
  }
  const failed = rows.filter((x) => !x.ok)
  console.log('  ' + '-'.repeat(60))
  console.log('  通过 ' + (rows.length - failed.length) + ' / ' + rows.length + (failed.length ? '  ← 有失败项' : '  ← 全部通过'))
  return failed.length === 0
}

async function main() {
  const external = process.env.LITE_CELL_WORKSPACE
  if (external) {
    if (!existsSync(external)) {
      console.error('LITE_CELL_WORKSPACE 不存在: ' + external)
      return false
    }
    return readonlyMode(external)
  }
  const root = mkdtempSync(join(tmpdir(), 'lite-cell-accept-'))
  process.env.MALONG_STATE_DIR = join(root, 'state')
  try {
    return await fullMode(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

main().then((ok) => process.exit(ok ? 0 : 1)).catch((e) => { console.error(e); process.exit(1) })
