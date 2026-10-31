// examples/poc.mjs — LiuHe Lite 最小可运行 PoC（无需任何 LLM Key）
//
// 用法：
//   node examples/poc.mjs                  # 在临时目录里跑完整闭环
//   node examples/poc.mjs <workspace>      # 在指定目录里跑（会写 notes.txt）
//
// 闭环：readAnchor → preview → apply → inspect → undo → reconcile
// 每一步都打印真实回执；最后打印磁盘真实内容与 hash，便于人工核对。

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { createLiteEditor } from '../lite/index.js'

const sha256 = (d) => createHash('sha256').update(d).digest('hex')
const show = (label, obj) => console.log(`\n── ${label} ──\n` + JSON.stringify(obj, null, 2))

// 工作区可信源：由宿主运行时提供（真实路径），不是模型参数
const wsArg = process.argv[2]
const ws = wsArg ? (mkdirSync(wsArg, { recursive: true }), wsArg) : mkdtempSync(join(tmpdir(), 'liuhe-lite-poc-'))
process.env.MALONG_STATE_DIR = join(ws, '.lite-state')

const rel = 'notes.txt'
if (!existsSync(join(ws, rel))) writeFileSync(join(ws, rel), 'hello v1\n')

const editor = createLiteEditor({
  workspace: { realPath: ws, id: 'poc-ws' },
  cell: { cellId: 'cell-A', incarnationId: 'run-poc', taskId: 'task-poc' },
})

console.log('LiuHe Lite PoC — 工作区：' + ws)

// ① 写前锚点
const anchorRes = editor.readAnchor({ path: rel })
show('① readAnchor', anchorRes.anchor)

// ② 写前预览（不写盘）
const previewRes = editor.preview({ anchor: anchorRes.anchor, newContent: 'hello v2\n' })
show('② preview（applied=false 即未写盘）', previewRes.preview)

// ③ 提交
const applied = await editor.apply({ anchor: anchorRes.anchor, newContent: 'hello v2\n', requestId: 'poc-req-1' })
show('③ apply 回执（Action Receipt v0）', applied.receipt)
console.log('   磁盘真实内容：' + JSON.stringify(readFileSync(join(ws, rel), 'utf-8')))
console.log('   磁盘真实 hash：' + sha256(readFileSync(join(ws, rel))))
console.log('   回执 after  ：' + applied.receipt.effect.after_sha256)

// ④ 动作效果详情（按需查，不塞进每轮上下文）
const inspected = editor.inspect({ actionId: applied.receipt.action_id })
show('④ inspect', inspected.effect)

// ⑤ Undo
const undone = await editor.undo({ recoveryRef: applied.receipt.recovery.ref, requestId: 'poc-req-1-undo' })
show('⑤ undo 回执', undone.receipt)
console.log('   磁盘真实内容：' + JSON.stringify(readFileSync(join(ws, rel), 'utf-8')))

// ⑥ 事后对账（只读）
const reconciled = editor.reconcile({ actionId: applied.receipt.action_id })
show('⑥ reconcile（journal + 前/后版本三方判定）', {
  application: reconciled.receipt.application,
  journal_state: reconciled.receipt.extension?.journal_state,
  reason: reconciled.receipt.extension?.reason,
})

console.log('\nPoC 闭环结束。')
