// tests/child-loop.mjs — L16 独立装配证明
//
// 用法：node child-loop.mjs <workspace> <markerDir>
//
// 证明方式（而不是口头声明）：
//   ① 把 MALONG_PARSE_BIN 指向一个「假 parser」——它一旦被调用就写标记文件；
//      标记不存在 = 整条链路没有任何环节去碰 Rust parser。
//   ② MALONG_STATE_DIR 隔离到临时目录 → 不依赖用户级配置。
//   ③ 扫工作区是否出现 *.db/*.sqlite → 没有 = 没有建代码索引（SQLite）。
//   ④ cwd 无关：所有 import 都是相对模块 URL 的静态路径。

import { mkdirSync, existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [,, wsPath, markerDir] = process.argv
mkdirSync(markerDir, { recursive: true })
const marker = join(markerDir, 'parser-was-invoked')
const fakeParser = join(markerDir, 'fake-malong-parse')
writeFileSync(fakeParser, `#!/bin/sh\necho invoked >> ${JSON.stringify(marker)}\n`)
process.env.MALONG_PARSE_BIN = fakeParser
process.env.MALONG_STATE_DIR = join(markerDir, 'state')

const { createLiteEditor } = await import('../lite/index.js')

const steps = []
const ed = createLiteEditor({ workspace: { realPath: wsPath } })

const a = ed.readAnchor({ path: 'a.txt' })
steps.push('readAnchor:' + (a.ok ? 'ok' : 'fail'))

const p = ed.preview({ anchor: a.anchor, newContent: 'v2\n' })
steps.push('preview:' + (p.ok ? 'ok' : 'fail'))

const r = await ed.apply({ anchor: a.anchor, newContent: 'v2\n', requestId: 'req-l16-child' })
steps.push('apply:' + (r.ok ? 'ok' : 'fail'))

const i = ed.inspect({ actionId: r.receipt?.action_id })
steps.push('inspect:' + (i.ok ? 'ok' : 'fail'))

const u = await ed.undo({ recoveryRef: r.receipt?.recovery?.ref, requestId: 'req-l16-child-undo' })
steps.push('undo:' + (u.ok ? 'ok' : 'fail'))

const rec = ed.reconcile({ actionId: r.receipt?.action_id })
steps.push('reconcile:' + (rec.receipt?.application || 'none'))

const dbs = []
const walk = (d) => {
  let entries = []
  try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = join(d, e.name)
    if (e.isDirectory()) { if (e.name === 'node_modules') continue; walk(p) }
    else if (/\.(db|sqlite3?)$/i.test(e.name)) dbs.push(e.name)
  }
}
walk(wsPath)

console.log(JSON.stringify({
  loop_ok: steps.every((s) => !s.endsWith('fail')),
  steps,
  parser_invoked: existsSync(marker),
  index_db_created: dbs.length > 0,
  index_dbs: dbs,
  node_version: process.version,
}))
