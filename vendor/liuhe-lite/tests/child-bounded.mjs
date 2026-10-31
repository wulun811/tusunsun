// tests/child-bounded.mjs — 在独立进程里验证「锚点之后文件暴涨」不会整读进内存
//
// 父进程用 VmHWM（峰值 RSS）判据：若 apply 把 300 MiB 全读进来，HWM 会跳 ~300 MiB。
// 刻意用 truncate 造稀疏文件：不占真实磁盘，也不会在造数据时把本进程内存抬高。
import { mkdtempSync, writeFileSync, truncateSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createLiteEditor } from '../lite/index.js'

const base = mkdtempSync(join(tmpdir(), 'lite-bounded-'))
writeFileSync(join(base, 'f.txt'), 'x'.repeat(1024 * 1024))
const ed = createLiteEditor({ workspace: { realPath: base }, cell: {} })
const a = ed.readAnchor({ path: 'f.txt' })
truncateSync(join(base, 'f.txt'), 300 * 1024 * 1024)
const hwm = () => {
  try { return Number(/VmHWM:\s+(\d+) kB/.exec(readFileSync('/proc/self/status', 'utf-8'))[1]) / 1024 } catch { return null }
}
const before = hwm()
const t0 = Date.now()
const r = await ed.apply({ anchor: a.anchor, newContent: 'y', requestId: 'bounded-1' })
const after = hwm()
console.log(JSON.stringify({
  ok: r.ok, code: r.error?.code, ms: Date.now() - t0,
  peak_before_mib: before === null ? null : Math.round(before),
  peak_after_mib: after === null ? null : Math.round(after),
  jump: before === null || after === null ? null : Math.round(after - before),
}))
rmSync(base, { recursive: true, force: true })
