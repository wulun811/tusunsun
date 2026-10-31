// tests/run.mjs — LIUHE-L01～L23 跑测与报表生成
//
// 用法：
//   node tests/run.mjs                # 全跑
//   node tests/run.mjs --filter L04   # 只跑某条
//   node tests/run.mjs --no-report    # 不落报表文件
//
// 报表：reports/matrix-report.md + .json（路径已脱敏，不含临时目录绝对路径）

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { CASES } from './lite-cases.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_DIR = join(HERE, '..')
const args = process.argv.slice(2)
const filter = args.includes('--filter') ? args[args.indexOf('--filter') + 1] : null
const wantReport = !args.includes('--no-report')

const root = mkdtempSync(join(tmpdir(), 'liuhe-lite-run-'))
// 账本隔离：request_id 账本落在临时目录，不污染 ~/.config/malong
process.env.MALONG_STATE_DIR = join(root, 'state')
// 陈旧锁判定窗口：生产默认 30s（崩溃者的锁要等 30s 才判陈旧）。
// 用例里干等 30s 没有额外信息量——用产品自带的测试旋钮缩短（心跳也一并缩短，
// 保持「活着就续租、死了就判陈旧」的语义不变），只影响时间尺度不影响语义。
process.env.MALONG_TEST_HEARTBEAT_MS = process.env.MALONG_TEST_HEARTBEAT_MS || '200'
process.env.MALONG_TEST_STALE_LOCK_MS = process.env.MALONG_TEST_STALE_LOCK_MS || '1500'

const results = []
const started = Date.now()

for (const c of CASES) {
  if (filter && c.id !== filter) continue
  const skipReason = c.skipIf ? c.skipIf(process.platform) : null
  if (skipReason) {
    results.push({ id: c.id, title: c.title, criterion: c.criterion, status: 'SKIP', failures: [], error: null, skip_reason: skipReason, duration_ms: 0 })
    console.log(`[SKIP] ${c.id} ${c.title}  — ${skipReason}`)
    continue
  }
  const failures = []
  const t = {
    root,
    check(cond, msg) { if (!cond) failures.push(msg) },
    note() {},
  }
  let status = 'PASS'
  let error = null
  const t0 = Date.now()
  try {
    await c.run(t)
  } catch (e) {
    status = 'ERROR'
    error = String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)
  }
  if (status === 'PASS' && failures.length) status = 'FAIL'
  results.push({
    id: c.id, title: c.title, criterion: c.criterion, status, failures, error,
    duration_ms: Date.now() - t0,
  })
  const mark = status === 'PASS' ? 'PASS' : status === 'FAIL' ? 'FAIL' : 'ERROR'
  console.log(`[${mark}] ${c.id} ${c.title}  (${Date.now() - t0}ms)`)
  for (const f of failures) console.log(`       ✗ ${f}`)
  if (error) console.log(`       ! ${error}`)
}

const counts = { PASS: 0, FAIL: 0, ERROR: 0, SKIP: 0, NOT_RUN: 0 }
for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1
const total = CASES.length
const notRun = filter ? 0 : total - results.length

console.log('\n=== LIUHE-L01–L' + String(CASES.length).padStart(2, '0') + ' 汇总 ===')
console.log(`PASS ${counts.PASS} / FAIL ${counts.FAIL} / ERROR ${counts.ERROR} / NOT_RUN ${notRun}（共 ${total} 条，用时 ${Date.now() - started}ms）`)

if (wantReport) {
  const reportDir = join(PKG_DIR, 'reports')
  mkdirSync(reportDir, { recursive: true })
  const stamp = new Date().toISOString()
  const json = {
    schema: 'liuhe-lite/matrix-report/v0',
    generated_at: stamp,
    node_version: process.version,
    platform: `${process.platform}-${process.arch}`,
    total_cases: total,
    executed: results.length,
    counts: { ...counts, NOT_RUN: notRun },
    cases: results.map((r) => ({
      id: r.id, title: r.title, criterion: r.criterion, status: r.status,
      failures: r.failures, error: r.error, skip_reason: r.skip_reason || null, duration_ms: r.duration_ms,
    })),
  }
  writeFileSync(join(reportDir, 'matrix-report.json'), JSON.stringify(json, null, 2) + '\n')

  const lines = []
  lines.push('# LIUHE-L01～L23 反例矩阵报表')
  lines.push('')
  lines.push(`- 生成时间：${stamp}`)
  lines.push(`- 运行环境：Node ${process.version} / ${process.platform}-${process.arch}`)
  lines.push(`- 结论：**PASS ${counts.PASS} / FAIL ${counts.FAIL} / ERROR ${counts.ERROR} / NOT_RUN ${notRun}**（共 ${total} 条）`)
  lines.push('')
  lines.push('> 所有安全与版本冲突用例都以真实磁盘效果判定（写后读文件、快照前后对比、冲突后核对旧内容未被覆盖），不是只断言 JSON 状态字符串。')
  lines.push('')
  lines.push('| 编号 | 测试 | 完成判据 | 结果 | 证据/失败点 |')
  lines.push('|---|---|---|---|---|')
  for (const r of results) {
    const ev = r.status === 'PASS' ? '全部断言通过（已核对真实磁盘）'
      : r.status === 'SKIP' ? ('SKIP：' + (r.skip_reason || ''))
      : (r.failures.join('；') || r.error || '')
    lines.push(`| ${r.id} | ${r.title} | ${r.criterion} | ${r.status} | ${ev.replace(/\|/g, '\\|')} |`)
  }
  lines.push('')
  writeFileSync(join(reportDir, 'matrix-report.md'), lines.join('\n'))
  console.log(`报表已写入：${join(reportDir, 'matrix-report.md')}`)
}

process.exit(counts.FAIL + counts.ERROR > 0 ? 1 : 0)
