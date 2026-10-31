// tests/parity.mjs — Lite.apply 与六合产品写路径（writeSymbol）的落盘对照
//
// 目的：证明 Lite 不是「另一套事务系统」，而是同一批原语的薄编排。
// 方法：同一输入分别走 writeSymbol（产品入口）与 Lite.apply（Lite 入口），
//   逐项对比：落盘内容、日记终态、冲突拒绝行为、Undo 结果。
//
// 用法：node tests/parity.mjs

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { writeSymbol } from '../vendor/malong/write-runtime.js'
import { restoreJournal } from '../vendor/malong/write-journal.js'
import { createLiteEditor } from '../lite/index.js'

const sha256 = (d) => createHash('sha256').update(d).digest('hex')
const root = mkdtempSync(join(tmpdir(), 'liuhe-lite-parity-'))
process.env.MALONG_STATE_DIR = join(root, 'state')

const checks = []
const check = (cond, msg) => { checks.push({ ok: !!cond, msg }) }

function newWs(name) {
  const p = join(root, name)
  mkdirSync(p, { recursive: true })
  writeFileSync(join(p, 'a.txt'), 'v1\n')
  return p
}

// ① 落盘内容一致
{
  const wsProduct = newWs('product')
  const r = await writeSymbol({
    workspace_dir: wsProduct,
    locator: { file_path: 'a.txt' },
    edit_mode: 'patch',
    patch: { old_string: 'v1\n', new_string: 'v2\n' },
    base_version: { file: { hash: 'sha256:' + sha256('v1\n') } },
    dry_run: false,
  }, { codeIndexService: undefined, getWorkspaceDir: () => wsProduct, langParserService: undefined })

  const wsLite = newWs('lite')
  const ed = createLiteEditor({ workspace: { realPath: wsLite } })
  const a = ed.readAnchor({ path: 'a.txt' })
  const lr = await ed.apply({ anchor: a.anchor, newContent: 'v2\n', requestId: 'parity-1' })

  check(r.success === true, '产品 writeSymbol 应成功')
  check(lr.ok === true, 'Lite.apply 应成功')
  check(readFileSync(join(wsProduct, 'a.txt'), 'utf-8') === readFileSync(join(wsLite, 'a.txt'), 'utf-8'),
    '两条路径的落盘内容应一致')
  check(sha256(readFileSync(join(wsLite, 'a.txt'))) === lr.receipt.effect.after_sha256,
    'Lite 回执 after hash 应等于真实文件 hash')
  check(!!r.txn_id && !!lr.receipt.provider_operation_id, '两条路径都应产出事务标识')
}

// ② 冲突行为一致（锚点过期 → 都拒绝、都不覆盖）
{
  const wsProduct = newWs('conflict-product')
  const wsLite = newWs('conflict-lite')
  // 两条路径的锚点都必须在「外部改写之前」取到，否则测的是另一件事
  const ed = createLiteEditor({ workspace: { realPath: wsLite } })
  const a = ed.readAnchor({ path: 'a.txt' })
  writeFileSync(join(wsProduct, 'a.txt'), 'external\n')
  writeFileSync(join(wsLite, 'a.txt'), 'external\n')
  const r = await writeSymbol({
    workspace_dir: wsProduct,
    locator: { file_path: 'a.txt' },
    edit_mode: 'patch',
    patch: { old_string: 'v1\n', new_string: 'v2\n' },
    base_version: { file: { hash: 'sha256:' + sha256('v1\n') } },
    dry_run: false,
  }, { codeIndexService: undefined, getWorkspaceDir: () => wsProduct, langParserService: undefined })
  const lr = await ed.apply({ anchor: a.anchor, newContent: 'v2\n', requestId: 'parity-2' })
  check(r.success === false && r.error?.code === 'VERSION_CONFLICT', '产品路径应报 VERSION_CONFLICT')
  check(lr.ok === false && lr.error?.code === 'VERSION_CONFLICT', 'Lite 应报 VERSION_CONFLICT')
  check(readFileSync(join(wsProduct, 'a.txt'), 'utf-8') === 'external\n', '产品路径不得覆盖外部改动')
  check(readFileSync(join(wsLite, 'a.txt'), 'utf-8') === 'external\n', 'Lite 不得覆盖外部改动')
}

// ③ Undo 结果一致（都回到旧版本）
{
  const wsProduct = newWs('undo-product')
  const wsLite = newWs('undo-lite')
  const r = await writeSymbol({
    workspace_dir: wsProduct,
    locator: { file_path: 'a.txt' },
    edit_mode: 'patch',
    patch: { old_string: 'v1\n', new_string: 'v2\n' },
    base_version: { file: { hash: 'sha256:' + sha256('v1\n') } },
    dry_run: false,
  }, { codeIndexService: undefined, getWorkspaceDir: () => wsProduct, langParserService: undefined })
  const ed = createLiteEditor({ workspace: { realPath: wsLite } })
  const a = ed.readAnchor({ path: 'a.txt' })
  const lr = await ed.apply({ anchor: a.anchor, newContent: 'v2\n', requestId: 'parity-3' })
  const up = await restoreJournal(wsProduct, r.txn_id)
  const ul = await ed.undo({ recoveryRef: lr.receipt.recovery.ref, requestId: 'parity-3-undo' })
  check(up.ok === true, '产品路径 Undo 应成功')
  check(ul.ok === true, 'Lite Undo 应成功')
  check(readFileSync(join(wsProduct, 'a.txt'), 'utf-8') === 'v1\n', '产品路径 Undo 后应回到旧版本')
  check(readFileSync(join(wsLite, 'a.txt'), 'utf-8') === 'v1\n', 'Lite Undo 后应回到旧版本')
}

// ④ 空文件：产品路径无法表达（patch.old_string 不允许空串），Lite 可处理
{
  const wsLite = join(root, 'empty-lite')
  mkdirSync(wsLite, { recursive: true })
  writeFileSync(join(wsLite, 'e.txt'), '')
  const ed = createLiteEditor({ workspace: { realPath: wsLite } })
  const a = ed.readAnchor({ path: 'e.txt' })
  const lr = await ed.apply({ anchor: a.anchor, newContent: 'filled\n', requestId: 'parity-4' })
  check(lr.ok === true, 'Lite 应能写空文件')
  check(readFileSync(join(wsLite, 'e.txt'), 'utf-8') === 'filled\n', '空文件写入后内容不对（实得 ' + JSON.stringify(readFileSync(join(wsLite, 'e.txt'), 'utf-8')) + '）')
}

const failed = checks.filter((c) => !c.ok)
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.msg}`)
console.log(`\n=== parity: ${checks.length - failed.length}/${checks.length} 通过 ===`)
process.exit(failed.length ? 1 : 0)
