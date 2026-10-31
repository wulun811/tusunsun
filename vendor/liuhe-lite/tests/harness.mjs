// tests/harness.mjs — L01–L16 测试脚手架
//
// 铁律：安全与版本冲突用例必须看真实磁盘效果，不许只断言 JSON 里的状态字符串。
// 因此本脚手架提供 snapshot()（递归文件指纹）与 read()/exists()（真实磁盘读），
// 用例的每条断言都落到磁盘事实上。

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, lstatSync, readdirSync, symlinkSync, rmSync } from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { createLiteEditor } from '../lite/index.js'

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

export function makeRoot(tag = 'liuhe-lite-') {
  return mkdtempSync(join(tmpdir(), tag))
}

export function makeWorkspace(root, name) {
  const p = join(root, name)
  mkdirSync(p, { recursive: true })
  return p
}

export function writeFile(base, rel, content) {
  const p = join(base, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, content)
  return p
}

export function readFile(base, rel) {
  return readFileSync(join(base, rel), 'utf-8')
}

export function fileExists(base, rel) {
  return existsSync(join(base, rel))
}

// 递归指纹：路径 → {sha256, size, mtime_ms, type}；用于「预览无副作用」「工作区外无落盘」的硬证据
export function snapshot(base) {
  const out = {}
  const walk = (dir) => {
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name)
      const rel = relative(base, p)
      if (e.isDirectory()) {
        out[rel + '/'] = { type: 'dir' }
        walk(p)
      } else {
        try {
          const st = statSync(p)
          out[rel] = { type: 'file', sha256: sha256(readFileSync(p)), size: st.size, mtime_ms: st.mtimeMs }
        } catch {
          out[rel] = { type: 'unreadable' }
        }
      }
    }
  }
  walk(base)
  return out
}

export function diffSnapshots(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  const changed = []
  for (const k of [...keys].sort()) {
    const x = a[k], y = b[k]
    if (!x || !y) { changed.push(k + ': ' + (x ? 'present' : 'absent')); continue }
    if (x.type !== y.type) { changed.push(k + ': type ' + x.type + ' → ' + y.type); continue }
    if (x.type === 'file' && x.sha256 !== y.sha256) changed.push(k + ': content changed')
    else if (x.type === 'file' && x.mtime_ms !== y.mtime_ms) changed.push(k + ': mtime changed')
  }
  return changed
}

export function makeEditor(base, opts = {}) {
  return createLiteEditor({
    workspace: { realPath: base, id: opts.workspaceId || 'ws-test' },
    cell: { cellId: opts.cellId || 'cell-A', incarnationId: opts.incarnationId || 'run-test', taskId: opts.taskId || 'task-test' },
    limits: opts.limits || {},
  })
}

// 找最近创建的日记事务目录（kill -9 后父进程据此找回 action_id）
export function findLatestTxn(base) {
  const root = join(base, '.malong', 'journal')
  let names = []
  try { names = readdirSync(root) } catch { return null }
  let best = null, bestMtime = -1
  for (const n of names) {
    if (n.startsWith('.')) continue
    try {
      const st = statSync(join(root, n))
      if (st.mtimeMs > bestMtime) { bestMtime = st.mtimeMs; best = n }
    } catch {}
  }
  return best
}

export function countJournals(base) {
  try { return readdirSync(join(base, '.malong', 'journal')).filter((n) => !n.startsWith('.')).length } catch { return 0 }
}

// 子进程是否被杀（Linux/macOS: signal==='SIGKILL'；Windows: Node 用 TerminateProcess 模拟，表现为非零退出码）
export function wasKilled(res) {
  if (!res) return false
  if (res.signal === 'SIGKILL') return true
  return res.status !== null && res.status !== 0 && res.status !== undefined
}

export function symlink(target, linkPath) {
  symlinkSync(target, linkPath)
}

// 该路径本身是否还是符号链接（不跟随链接）——用于「被拒的写入不应把链接替换成普通文件」
export function isSymlink(base, rel) {
  try { return lstatSync(join(base, rel)).isSymbolicLink() } catch { return false }
}

export function rmrf(p) {
  rmSync(p, { recursive: true, force: true })
}
