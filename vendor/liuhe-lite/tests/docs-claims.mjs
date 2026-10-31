// tests/docs-claims.mjs — 文档声明机械核对
//
// 为什么要有这条：文档里的数字、路径、命令、枚举一旦和实物/实测脱节，就会变成
// “看着很确定、实际在骗人”的东西。本脚本把可机检的声明全查一遍，不靠人眼。
//
// 跑法：node tests/docs-claims.mjs      → 退出码 0 = 全部对得上

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CELL_HANDLING } from '../examples/cell-adapter.mjs'
import { LiteErrorCodes, RETRY_POLICY, RETRY_VALUES } from '../lite/errors.js'
import { CASES } from './lite-cases.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')
const read = (f) => readFileSync(join(PKG, f), 'utf-8')
const has = (f) => existsSync(join(PKG, f))
// 上下文判定：仓库内（有 reports/ + scripts/）全查；包内（两者都不随包分发）
// 只查随包走的部分，仓库专有项记 SKIP，不假装验过。
const IN_REPO = has('scripts') && has('reports')

// 包内全部文档（含历史条目）与「当前面向」文档（不含 CHANGELOG / L0 审计快照）
const allDocs = ['README.md', 'CHANGELOG.md', 'INTEGRATION-GUIDE.md', 'RECEIPT-FIELD-ALIGNMENT.md', 'ACTION-RECEIPT-MAPPING.md', 'SAFETY.md', 'LIUHE-LITE-FEASIBILITY.md']
const CURRENT_DOCS = ['README.md', 'SAFETY.md', 'INTEGRATION-GUIDE.md', 'RECEIPT-FIELD-ALIGNMENT.md', 'ACTION-RECEIPT-MAPPING.md']

const rows = []
function claim(name, ok, info) { rows.push({ name, ok: !!ok, info: info === undefined ? '' : String(info) }) }
// SKIP 不是通过：报表不随包分发（为了产物指纹稳定），报表类声明在包里无从核对，
// 就明写 SKIP，不假装已验。
function skip(name, reason) { rows.push({ name, ok: true, skipped: true, info: 'SKIP: ' + reason }) }

// ── 1. 文档树里提到的文件必须真实存在 ──
const expectedAll = [
  'README.md', 'CHANGELOG.md', 'INTEGRATION-GUIDE.md', 'RECEIPT-FIELD-ALIGNMENT.md',
  'ACTION-RECEIPT-MAPPING.md', 'SAFETY.md', 'LIUHE-LITE-FEASIBILITY.md', 'package.json',
  'lite/index.js', 'lite/errors.js', 'lite/receipt.js',
  'examples/cell-adapter.mjs', 'examples/poc.mjs',
  'scripts/pack-lite.mjs',
  'tests/run.mjs', 'tests/parity.mjs', 'tests/cell-acceptance.mjs', 'tests/lite-cases.mjs',
  'tests/docs-claims.mjs', 'tests/provenance.mjs',
]
const EXPECTED = IN_REPO ? expectedAll : expectedAll.filter((f) => !f.startsWith('scripts/'))
const missing = EXPECTED.filter((f) => !has(f))
claim('所有应当存在的文件都在', missing.length === 0,
  (missing.length ? '缺: ' + missing.join(', ') : EXPECTED.length + ' 个') + (IN_REPO ? '' : '（包内上下文，已排除仓库专有的 scripts/）'))

// ── 2. README 目录树里点了名的文件/目录都在树里列了 ──
const readme = read('README.md')
const treeMissing = ['INTEGRATION-GUIDE.md', 'RECEIPT-FIELD-ALIGNMENT.md', 'cell-adapter.mjs', 'cell-acceptance.mjs', 'pack-lite.mjs']
  .filter((n) => !readme.includes(n))
claim('README 目录树覆盖新交付物', treeMissing.length === 0, treeMissing.length ? '未列: ' + treeMissing.join(', ') : 'ok')

// ── 3. 文档里写的命令，脚本必须真存在 ──
const docsText = readme + '\n' + read('INTEGRATION-GUIDE.md') + '\n' + read('SAFETY.md')
const cmds = new Set()
for (const m of docsText.matchAll(/node\s+([\w./-]+\.mjs)/g)) cmds.add(m[1])
const localCmds = [...cmds].filter((c) => c.startsWith('tests/') || c.startsWith('examples/') || c.startsWith('scripts/'))
const checkableCmds = IN_REPO ? localCmds : localCmds.filter((c) => !c.startsWith('scripts/'))
const badCmds = checkableCmds.filter((c) => !has(c))
claim('文档中的 node 命令均指向真实脚本', badCmds.length === 0,
  checkableCmds.join(' / ') + (badCmds.length ? '  ← 不存在: ' + badCmds.join(', ') : '') +
  (IN_REPO ? '' : '（scripts/ 不随包分发，未计入）'))

// ── 4. 错误码表必须覆盖全部对外错误码，且与原生策略逐项一致（双向）──
const guide = read('INTEGRATION-GUIDE.md')
const tableRows = new Map()
for (const line of guide.split('\n')) {
  const m = line.match(/^\|\s*`([A-Z_]+)`\s*\|\s*`?([a-z_]+)`?\s*\|/)
  if (m) tableRows.set(m[1], m[2])
}
const need = new Set([...Object.keys(CELL_HANDLING), 'WORKSPACE_PARAM_FORBIDDEN', 'CANCELLED_BEFORE_START'])
const notCovered = [...need].filter((c) => !tableRows.has(c))
claim('接入指南错误码表覆盖全部对外错误码', notCovered.length === 0,
  notCovered.length ? '漏: ' + notCovered.join(', ') : need.size + ' 个全在表里')

const retryMismatch = []
for (const [code, retry] of tableRows) {
  const native = RETRY_POLICY[code]
  if (!native) { retryMismatch.push(code + ' 表里有、策略里没有'); continue }
  if (native.retry !== retry) retryMismatch.push(code + ' 表=' + retry + ' 代码=' + native.retry)
}
for (const code of Object.keys(RETRY_POLICY)) {
  if (!tableRows.has(code)) retryMismatch.push(code + ' 策略里有、表里没有')
}
for (const [code, p] of Object.entries(RETRY_POLICY)) {
  if (!RETRY_VALUES.includes(p.retry)) retryMismatch.push(code + ' retry 非法: ' + p.retry)
}
claim('错误码表与原生 RETRY_POLICY 逐项一致（双向）', retryMismatch.length === 0,
  retryMismatch.length ? retryMismatch.join('; ') : tableRows.size + ' 项一致')

const missingPolicy = Object.values(LiteErrorCodes).filter((c) => !RETRY_POLICY[c])
claim('每个 LiteErrorCodes 都有 retry 策略', missingPolicy.length === 0, missingPolicy.join(', ') || 'ok')

// ── 5. 同步点 C：文档声称 12 项，脚本必须真是 12 项 ──
const accSrc = read('tests/cell-acceptance.mjs')
const fullBody = accSrc.slice(accSrc.indexOf('async function fullMode'), accSrc.indexOf('function finish'))
const fullCount = [...fullBody.matchAll(/record\('C\d\d'/g)].length
const docRows = (guide.match(/^\| C\d\d \|/gm) || []).length
claim('验收项数一致（脚本 12 项 / 文档 12 行）', fullCount === 12 && docRows === 12, '脚本=' + fullCount + ' 文档=' + docRows)

// ── 6. 报表里的数字与文档声称的一致（报表不随包分发 → 包里记 SKIP）──
// 条数不写死：直接取 CASES.length，以后增删用例只需改测试，不许文档自己漂。
const N = CASES.length
const label = 'L01–L' + String(N).padStart(2, '0')
if (!has('reports/matrix-report.json') || !has('reports/nonfunctional-baseline.json')) {
  skip('矩阵条数与文档一致（' + N + '）', '本包不分发 reports/，需在仓库内跑')
  skip('基线：闭包文件数=17 / 外部依赖=0 与文档一致', '本包不分发 reports/，需在仓库内跑')
  // 包内没有报表，但 README 与 GUIDE 之间的数字仍可互查（土行孙 A-4：同一个包里不许出现两个体积数）
  const tp = /([\d.]+) KiB \/ 17 文件/.exec(read('README.md'))
  const gp = /([\d.]+) KiB \/ 17 文件/.exec(read('INTEGRATION-GUIDE.md'))
  claim('基线：README 与 GUIDE 体积数字一致（包内无报表，只互查）', !!tp && !!gp && tp[1] === gp[1],
    'README=' + (tp && tp[1]) + ' GUIDE=' + (gp && gp[1]))
} else {
  const matrix = JSON.parse(read('reports/matrix-report.json'))
  const passCount = matrix.counts && (matrix.counts.PASS ?? matrix.counts.pass)
  claim('矩阵条数与报表一致（' + N + '）', passCount === N && matrix.total_cases === N, 'PASS=' + passCount + ' total=' + matrix.total_cases)

  const labelMiss = CURRENT_DOCS.filter((f) => read(f).includes('反例矩阵') && !read(f).includes(label))
  claim('文档里的矩阵编号与真实条数一致（' + label + '）', labelMiss.length === 0, labelMiss.join(', ') || 'ok')

  const m = /\*\*(\d+) \/ \1 PASS\*\*/.exec(read('README.md'))
  claim('README 的 PASS 计数与真实条数一致（' + N + '）', !!m && Number(m[1]) === N, m ? m[1] + ' / ' + m[1] : '未找到')

  const base = JSON.parse(read('reports/nonfunctional-baseline.json'))
  const fp = base.install_footprint
  const deps = base.dependencies || {}
  // 土行孙 A-4：旧判据只读 README 第一个 KiB、容差 0.6、还内置 221.3 逃生门——下一个版本必红。
  // 现在：README 与 GUIDE 的「N KiB / 17 文件」必须逐字一致，且等于报表实测值（容差 0）。
  const token = fp.kib + ' KiB / ' + fp.files + ' 文件'
  const readmeHas = read('README.md').includes(token)
  const guideHas = read('INTEGRATION-GUIDE.md').includes(token)
  claim('基线：体积数字 README=GUIDE=报表（' + token + '）', readmeHas && guideHas,
    'README=' + readmeHas + ' GUIDE=' + guideHas + '（容差 0，改代码后必须重测重写）')
  claim('基线：闭包文件数/外部依赖与文档一致',
    fp.files === 17 && (base.external_deps === 0 || deps.external === 0 || Object.keys(deps).length === 0),
    'files=' + fp.files + ' kib=' + fp.kib)
  const staleKib = CURRENT_DOCS.filter((f) => read(f).includes('221.3'))
  claim('当前文档无 0.1.0 期旧基线数字（221.3）', staleKib.length === 0, staleKib.join(', ') || 'ok')
}

// ── 7. 禁用措辞 / 陈旧引用 ──
const staleDir = allDocs.filter((f) => read(f).includes('tusunsun-lite'))
claim('无陈旧目录名（tusunsun-lite）', staleDir.length === 0, staleDir.join(', ') || 'ok')

const staleSha = allDocs.filter((f) => /(5b8d26c7|4b0e13bd|102,098|108,230)/.test(read(f)))
claim('包内文档无写死的产物指纹（避免改文档→改指纹自指）', staleSha.length === 0, staleSha.join(', ') || 'ok')

const npmClaim = allDocs.filter((f) => /npm install @jieai\/liuhe-lite/.test(read(f)))
claim('未暗示已发布 npm 包', npmClaim.length === 0, npmClaim.join(', ') || 'ok')

// ── 8. 文档间相对链接可解析 ──
const linkProblems = []
for (const f of allDocs) {
  for (const m of read(f).matchAll(/\]\((\.\/[^)\s]+\.md)\)/g)) {
    const target = join(PKG, dirname(f), m[1])
    if (!existsSync(target)) linkProblems.push(f + ' → ' + m[1])
  }
}
claim('文档间相对 .md 链接均可解析', linkProblems.length === 0, linkProblems.join('; ') || 'ok')

// ── 9. 宿主授权声明与代码一致 ──
const idx = read('lite/index.js')
claim('源码中不出现 workspace_dir（工作区只能来自宿主）', !idx.includes('workspace_dir'), 'ok')
const adapter = read('examples/cell-adapter.mjs')
claim('适配层拒绝工作区类入参', /FORBIDDEN_PARAMS/.test(adapter) && /WORKSPACE_PARAM_FORBIDDEN/.test(adapter), 'ok')

// ── 10. 交付物指向（土行孙 A-3/A-4）──
const pkgManifest = JSON.parse(read('package.json'))
// a) npm scripts 的 node 目标必须真实存在（曾出现 pack:verify 在制品里 MODULE_NOT_FOUND）
const brokenScripts = []
for (const [k, cmd] of Object.entries(pkgManifest.scripts || {})) {
  const m = /(?:^|\s)node\s+(?:--[\w-]+\s+)*(\S+)/.exec(cmd)
  if (m && !has(m[1])) brokenScripts.push(k + ' → ' + m[1])
}
claim('npm scripts 的 node 目标都真实存在', brokenScripts.length === 0, brokenScripts.join('; ') || 'ok')
// b) 当前文档提到的 tgz 版本号必须与 package.json 一致（不得指一个不存在的包）
const staleTgz = CURRENT_DOCS.flatMap((f) => {
  const names = [...read(f).matchAll(/jieai-liuhe-lite-(\d+\.\d+\.\d+)\.tgz/g)].map((m) => m[1])
  return names.filter((v) => v !== pkgManifest.version).map((v) => f + ':' + v)
})
claim('文档提到的 tgz 版本与 package.json 一致（' + pkgManifest.version + '）', staleTgz.length === 0, staleTgz.join(', ') || 'ok')
// c) L0 审计快照必须自带「历史快照」标记：里面的数字是 0.1.0 期的，不随版本更新，不许被当成当前口径引用
claim('FEASIBILITY 标注为历史快照（数字不随版本更新）', read('LIUHE-LITE-FEASIBILITY.md').includes('历史快照'), '')

// ── 输出 ──
const w = Math.max(...rows.map((r) => r.name.length))
console.log('== 文档声明机械核对 ==')
for (const r of rows) {
  const mark = r.skipped ? '⊘' : (r.ok ? '✓' : '✗')
  console.log('  ' + mark + ' ' + r.name.padEnd(w) + '  ' + r.info)
}
const failed = rows.filter((r) => !r.ok)
const skipped = rows.filter((r) => r.skipped)
console.log('  ' + '-'.repeat(60))
console.log('  通过 ' + (rows.length - failed.length - skipped.length) + ' / ' + rows.length +
  (skipped.length ? '（SKIP ' + skipped.length + '）' : '') +
  (failed.length ? '  ← 有对不上的声明' : '  ← 无对不上的声明'))
process.exit(failed.length === 0 ? 0 : 1)
