// tests/child-apply.mjs — kill -9 用例的子进程
//
// 用法：node child-apply.mjs <workspace> <relPath> <newContent> <requestId>
// 环境开关（仅测试）：MALONG_LITE_TEST_KILL_AFTER_JOURNAL / MALONG_LITE_TEST_KILL_AFTER_WRITE
//   → 在对应节点直接 SIGKILL 自己，模拟「写了一半进程就没了」。

const [,, wsPath, relPath, content, requestId] = process.argv
const { createLiteEditor } = await import('../lite/index.js')

const ed = createLiteEditor({ workspace: { realPath: wsPath } })
const a = ed.readAnchor({ path: relPath })
const r = await ed.apply({ anchor: a.anchor, newContent: content, requestId })
console.log(JSON.stringify({ ok: r.ok, action_id: r.receipt?.action_id || null }))
