// tests/child-undo.mjs — 子进程：执行一次 undo（L23 多进程竞争用）
//
// 用法：node tests/child-undo.mjs <workspace> <recoveryRef> <requestId>
// 输出最后一行 JSON：{ ok, code, status }
// 账本隔离由父进程通过 MALONG_STATE_DIR 传下来。

import { createLiteEditor } from '../lite/index.js'

const [ws, ref, reqId] = process.argv.slice(2)
const ed = createLiteEditor({ workspace: { realPath: ws } })
const r = await ed.undo({ recoveryRef: ref, requestId: reqId })
console.log(JSON.stringify({ ok: r.ok, code: r.ok ? null : r.error?.code ?? null, status: r.detail?.liuhe_code ?? null }))
