// tests/provenance.mjs — vendor 来源证明校验（LH-02）
//
// 为什么要有这条：独立包 vendor 了 14 个 malong 写路径原语。
// 「零 npm 依赖」不等于「没有外来代码供应链」——vendor 本身就是外来代码，
// 必须能回答：它来自哪个仓库、哪个 commit、哪个文件、内容 hash 是多少。
//
// 本脚本逐文件核对 vendor/malong/PROVENANCE.json 与实际文件：
//   · 清单里有的 → 文件必须在、字节数一致、sha256 一致
//   · vendor 下有的 → 必须在清单里（不允许偷偷多放一个原语）
// 任何一个不符即失败。
//
// 仓库内（没有 vendor/）或旧包（没有清单）→ 明写 SKIP，不假装验过。
//
// 跑法：node tests/provenance.mjs

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')
const VENDOR = join(PKG, 'vendor', 'malong')
const MANIFEST = join(VENDOR, 'PROVENANCE.json')

function skip(reason) {
  console.log('⊘ SKIP: ' + reason)
  process.exit(0)
}

if (!existsSync(VENDOR)) skip('仓库内没有 vendor/（来源清单只在打包产物里生成）')
if (!existsSync(MANIFEST)) skip('该包没有 vendor/malong/PROVENANCE.json（0.1.0 及更早的包）')

const problems = []
let prov
try {
  prov = JSON.parse(readFileSync(MANIFEST, 'utf-8'))
} catch (e) {
  console.error('✗ PROVENANCE.json 不可解析: ' + e.message)
  process.exit(1)
}

if (prov.schema !== 'liuhe-lite/vendor-provenance/v1') problems.push('schema 不符: ' + prov.schema)
if (!prov.source_repository) problems.push('缺 source_repository（来源仓库）')
if (!prov.source_scope) problems.push('缺 source_scope（本清单覆盖范围）')
if (typeof prov.source_dirty !== 'boolean' && prov.source_dirty !== null) problems.push('source_dirty 取值不合法')
if (!prov.license) problems.push('缺 license（vendor 代码的许可证）')

// 产物会随包外发：来源仓库字段不得带账号密码，也不得把内网地址原文打出去。
// 私有地址必须是脱敏形态（private-remote:<owner/repo>），公开地址原样保留。
const repoRaw = String(prov.source_repository || '')
if (/\/\/[^@/]*@/.test(repoRaw)) problems.push('source_repository 含账号信息（不该随包外发）: ' + repoRaw)
if (/\d{1,3}(\.\d{1,3}){3}/.test(repoRaw)) problems.push('source_repository 暴露 IP 地址（应脱敏为 private-remote:…）: ' + repoRaw)
if (/:\d{2,5}\//.test(repoRaw)) problems.push('source_repository 暴露非标准端口（内网服务特征）: ' + repoRaw)
if (!Array.isArray(prov.files) || prov.files.length === 0) problems.push('files 为空')

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const listed = new Map()
for (const f of prov.files || []) {
  if (!f || typeof f.path !== 'string' || !/^[0-9a-f]{64}$/.test(String(f.sha256 || ''))) {
    problems.push('清单条目格式不合法: ' + JSON.stringify(f))
    continue
  }
  listed.set(f.path, f)
  if (!(f.last_commit === null || /^[0-9a-f]{7,64}$/.test(String(f.last_commit)))) {
    problems.push('last_commit 不是合法 git 对象名: ' + f.path + ' → ' + f.last_commit)
  }
  const abs = join(VENDOR, f.path)
  if (!existsSync(abs)) { problems.push('清单里有、包里没有: ' + f.path); continue }
  const bytes = readFileSync(abs).length
  if (f.bytes !== bytes) problems.push('字节数不符: ' + f.path + ' 清单=' + f.bytes + ' 实际=' + bytes)
  if (sha(abs) !== f.sha256) problems.push('sha256 不符（内容被改过）: ' + f.path)
}

function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) { walk(p); continue }
    if (e.name === 'PROVENANCE.json') continue
    const rel = p.slice(VENDOR.length + 1).split(sep).join('/')
    if (!listed.has(rel)) problems.push('vendor 里有、清单里没有: ' + rel)
  }
}
walk(VENDOR)

if (problems.length) {
  console.error('✗ vendor 来源证明核对失败（' + problems.length + ' 项）：')
  for (const p of problems) console.error('  - ' + p)
  process.exit(1)
}

console.log('✓ vendor 来源证明核对通过：' + listed.size + ' 个文件 / 源仓库 ' + (prov.source_repository || '?') +
  ' / 范围 ' + (prov.source_scope || '?').slice(0, 24) + (prov.source_dirty ? '（源树有未提交改动）' : ''))
