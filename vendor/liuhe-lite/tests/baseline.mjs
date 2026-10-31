// tests/baseline.mjs — 非功能基线实测（不设想象 KPI，只给真实环境数字）
//
// 测什么：
//   · 安装体积：Lite 运行路径的导入闭包实际字节数（不是整个 malong 包）
//   · Node 版本 / 平台
//   · 冷启动耗时：进程启动 → 首次 readAnchor 返回（含模块加载）
//   · 静态依赖：node: 内置模块清单 + 外部依赖数（应为 0）
//   · RSS：完整闭环后的常驻内存
//
// 用法：node tests/baseline.mjs
// 输出：reports/nonfunctional-baseline.md + .json

import { readFileSync, statSync, writeFileSync, mkdirSync, existsSync, mkdtempSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const T0 = performance.now()
const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_DIR = join(HERE, '..')
const ENTRY = join(PKG_DIR, 'lite', 'index.js')

// ── 导入闭包（静态扫描 import 语句；本仓全部为静态 import）──
const IMPORT_RE = /^\s*import\s[^'"]*['"]([^'"]+)['"]/gm
const seen = new Set()
const nodeBuiltins = new Set()
const externals = new Set()
let closureBytes = 0
const closureFiles = []

function walk(file) {
  const abs = resolve(file)
  if (seen.has(abs)) return
  seen.add(abs)
  let src = ''
  try { src = readFileSync(abs, 'utf-8') } catch { return }
  closureBytes += statSync(abs).size
  closureFiles.push({ file: relative(PKG_DIR, abs), bytes: statSync(abs).size })
  IMPORT_RE.lastIndex = 0
  let m
  while ((m = IMPORT_RE.exec(src))) {
    const spec = m[1]
    if (spec.startsWith('node:')) { nodeBuiltins.add(spec); continue }
    if (spec.startsWith('.')) { walk(resolve(dirname(abs), spec)); continue }
    externals.add(spec)
  }
}
walk(ENTRY)

process.env.MALONG_STATE_DIR = mkdtempSync(join(tmpdir(), 'liuhe-lite-baseline-'))
const { createLiteEditor } = await import('../lite/index.js')
const importMs = performance.now() - T0

// ── 冷启动：模块加载 + 首次 readAnchor（LH-05：口径必须真的包含 readAnchor）──
// 0.1.0 的错误：在 readAnchor 之前就把时间差当成「到 readAnchor 返回」，数字偏小且名不对实。
// 这里拆成三个可分辨的数字：模块导入 / 编辑器就绪 / 首次读锚点返回。
const ws = mkdtempSync(join(tmpdir(), 'liuhe-lite-baseline-ws-'))
writeFileSync(join(ws, 'a.txt'), 'v1\n')
const editor = createLiteEditor({ workspace: { realPath: ws } })
const editorReadyMs = performance.now() - T0
const a = editor.readAnchor({ path: 'a.txt' })
const firstReadAnchorMs = performance.now() - T0
if (!a || a.ok !== true) throw new Error('baseline: readAnchor 失败')

// ── 完整闭环后的 RSS ──
const t1 = performance.now()
await editor.apply({ anchor: a.anchor, newContent: 'v2\n', requestId: 'baseline-1' })
editor.inspect({ actionId: editor.reconcile({ actionId: 'act-none' }) ? 'act-none' : 'act-none' })
const loopMs = performance.now() - t1
const mem = process.memoryUsage()

const r2 = (v) => Math.round(v * 100) / 100

const metrics = {
  schema: 'liuhe-lite/nonfunctional-baseline/v0',
  generated_at: new Date().toISOString(),
  node_version: process.version,
  platform: `${process.platform}-${process.arch}`,
  install_footprint: {
    note: 'Lite 运行路径的静态导入闭包（不含 malong 的代码索引/解析器部分）',
    files: closureFiles.length,
    bytes: closureBytes,
    kib: Math.round(closureBytes / 1024 * 10) / 10,
    breakdown: closureFiles.sort((x, y) => y.bytes - x.bytes),
  },
  static_deps: {
    node_builtins: [...nodeBuiltins].sort(),
    external_packages: [...externals].sort(),
    external_count: externals.size,
  },
  // 口径（LH-05）：三个数字分开报；cold_start_ms 保留旧名但含义已纠正为「真包含 readAnchor」
  first_read_anchor_ms: r2(firstReadAnchorMs),
  editor_ready_ms: r2(editorReadyMs),
  module_import_ms: r2(importMs),
  cold_start_ms: r2(firstReadAnchorMs),
  loop_ms: Math.round(loopMs * 100) / 100,
  rss_bytes: mem.rss,
  rss_mib: Math.round(mem.rss / 1024 / 1024 * 10) / 10,
  heap_used_mib: Math.round(mem.heapUsed / 1024 / 1024 * 10) / 10,
}

const reportDir = join(PKG_DIR, 'reports')
mkdirSync(reportDir, { recursive: true })
writeFileSync(join(reportDir, 'nonfunctional-baseline.json'), JSON.stringify(metrics, null, 2) + '\n')

const lines = []
lines.push('# LiuHe Lite 非功能基线（实测）')
lines.push('')
lines.push(`- 生成时间：${metrics.generated_at}`)
lines.push(`- 运行环境：Node ${metrics.node_version} / ${metrics.platform}`)
lines.push('')
lines.push('| 指标 | 实测值 |')
lines.push('|---|---|')
lines.push(`| 安装体积（Lite 导入闭包 ${metrics.install_footprint.files} 个文件） | **${metrics.install_footprint.kib} KiB**（${metrics.install_footprint.bytes} B） |`)
lines.push(`| 外部依赖数（npm 包） | **${metrics.static_deps.external_count}**${metrics.static_deps.external_count ? '：' + metrics.static_deps.external_packages.join(', ') : '（零第三方运行时依赖）'} |`)
lines.push(`| node: 内置模块 | ${metrics.static_deps.node_builtins.length} 个：${metrics.static_deps.node_builtins.map((x) => '`' + x + '`').join(' ')} |`)
lines.push(`| 冷启动（进程启动 → 首次 readAnchor 返回，含模块加载） | **${metrics.first_read_anchor_ms} ms** |`)
lines.push(`| └ 其中模块导入完成 | ${metrics.module_import_ms} ms |`)
lines.push(`| └ 其中编辑器构造完成 | ${metrics.editor_ready_ms} ms |`)
lines.push(`| 首次 apply 耗时 | ${metrics.loop_ms} ms |`)
lines.push(`| RSS（闭环后） | **${metrics.rss_mib} MiB**（heapUsed ${metrics.heap_used_mib} MiB） |`)
lines.push('')
lines.push('> 口径说明（LH-05）：冷启动 = 本测脚本第一行执行 → 首次 `readAnchor` **返回**（真包含那次读锚点），不包含 Node 进程自身引导（进程内无法自测）。')
lines.push('> 安装体积只算 Lite 运行路径的静态导入闭包——即「把 Lite 搬进一个独立装配」真正需要带走的字节数；')
lines.push('> 不含 malong 的代码索引（SQLite）、Rust 解析器与 MCP 服务器（Lite 用不到）。')
lines.push('')
lines.push('### 导入闭包明细')
lines.push('')
lines.push('| 文件 | 字节 |')
lines.push('|---|---|')
for (const f of metrics.install_footprint.breakdown) lines.push(`| ${f.file} | ${f.bytes} |`)
lines.push('')
writeFileSync(join(reportDir, 'nonfunctional-baseline.md'), lines.join('\n'))

console.log(JSON.stringify({
  footprint_kib: metrics.install_footprint.kib,
  files: metrics.install_footprint.files,
  external_deps: metrics.static_deps.external_count,
  cold_start_ms: metrics.cold_start_ms,
  rss_mib: metrics.rss_mib,
}, null, 2))
console.log('报表已写入：' + join(reportDir, 'nonfunctional-baseline.md'))
