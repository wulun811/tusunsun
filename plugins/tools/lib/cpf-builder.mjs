import { readdirSync, readFileSync, statSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, extname, relative } from 'node:path'
import { CpfWriter } from './cpf-format.mjs'
import { tokenize } from './cpf-tokenizer.mjs'

const CODE_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.go', '.rs', '.java', '.rb', '.c', '.h', '.cpp', '.hpp'])
const IGNORE_DIRS = new Set(['node_modules', '.git', '.tusunsun', 'dist', 'build', 'coverage', '__pycache__', '.venv', '.git-local'])
const MAX_FILE_SIZE = 1024 * 1024

export function buildCpfIndex(repoDir, outputPath) {
  const files = collectFiles(repoDir)
  const writer = new CpfWriter(outputPath)
  const mapping = []

  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf-8')
    const tokens = tokenize(content)
    const docId = mapping.length
    writer.addTokens(docId, tokens)
    mapping.push(relative(repoDir, filePath))
  }

  writer.finalize()

  const mapPath = outputPath + '.map.json'
  writeFileSync(mapPath, JSON.stringify(mapping))

  return { numTokens: writer.index.length, numFiles: mapping.length }
}

function collectFiles(dir) {
  const files = []
  function walk(d) {
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!IGNORE_DIRS.has(e.name) && !e.name.startsWith('.')) walk(join(d, e.name))
      } else if (e.isFile() && CODE_EXTS.has(extname(e.name))) {
        const full = join(d, e.name)
        const size = statSync(full).size
        if (size > 0 && size <= MAX_FILE_SIZE) files.push(full)
      }
    }
  }
  walk(dir)
  return files
}
