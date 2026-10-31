#!/usr/bin/env node
/**
 * 行数单一来源的**生成器**：同一份当前行数写进 `CORE_MAX_LINES`、ADR-10 的“当前 N 行”
 * 与 README / README.en / positioning / microkernel.md / package.json 的行数说法。
 *
 * **每多一种措辞就要多一条正则**：生成器只改它认得的写法，认不得的就地长成旧数字。
 * rc.10 之前就是如此 —— README 同一页写着 4180 与 2880、设计原则写着「≤ 2080 行」、
 * 英文 README 写着 2610 与 2,527，四处全是旧值，因为只匹配了"微内核 N 行"。
 *
 *   · 当前行数 = `src/core/*.js` 逐个 `split('\n').length` 求和（与 `scripts/line-check.js` 同口径）
 *   · 预算下调（当前行数 < 现行预算）自动落盘；上调是发布承诺，必须先有记录：
 *     ADR-10 §2 记 `旧 → 新`，§5 记新上限与当前行数，CHANGELOG 记这次预算变化。
 *     缺任一项时拒绝写入（退出码 1），不改任何文件。
 *   · ADR-10 的版本表与变更记录**行本身**不自动追加 —— 归因文字只能人写。
 *
 * 用法：
 *   node scripts/sync-line-docs.mjs            # 只报告差异（dry run）
 *   node scripts/sync-line-docs.mjs --write    # 真的写
 *
 * 校验侧由 `test/unit/test-r016-doc-line-consistency.test.mjs` 负责。
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releasedRowConflict, releasedRowMessage } from './lib/line-doc-history.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WRITE = process.argv.includes('--write');
const PKG_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

const BUDGETED = ['dependency-resolver.js', 'lifecycle-manager.js', 'scene-controller.js'];

function measure() {
  const dir = join(ROOT, 'src', 'core');
  const per = {};
  let total = 0;
  let bytes = 0;
  for (const f of readdirSync(dir)) {
    // 与 scripts/line-check.js 同一份扩展名白名单：只认 `.js` 时，`.cjs` 在文档同步里也不存在。
    if (!/\.(?:[cm]?js)$/.test(f)) continue;
    const content = readFileSync(join(dir, f), 'utf8');
    per[f] = content.split('\n').length;
    total += per[f];
    bytes += Buffer.byteLength(content, 'utf8');
  }
  return { per, total, bytes };
}

const { per, total, bytes } = measure();
const limitsSrc = readFileSync(join(ROOT, 'scripts/core-limits.mjs'), 'utf8');
const budgetMatch = limitsSrc.match(/export const CORE_MAX_LINES = (\d+);/);
if (!budgetMatch) throw new Error('找不到 CORE_MAX_LINES');
const currentBudget = Number(budgetMatch[1]);
// 本版本号（去掉 v 前缀），用来认出发行行是哪一条。
const ADR_VER = String(PKG_VERSION).replace(/^v/, '');
// 上一轮预算：用来认出"该同步的是哪一行"（不能无条件改末行，否则历史归因被覆盖）。
const previousMatch = limitsSrc.match(/export const CORE_MAX_LINES_PREVIOUS = (\d+);/);
const previousBudget = previousMatch ? Number(previousMatch[1]) : currentBudget;
const growth = total > currentBudget;

/**
 * 拦"忘了 bump 版本就同步"。生成器只改「当前版本那一行」—— 而"当前版本"来自 `package.json`，
 * 所以版本没 bump 时它会把**上一个已发布版本**的行改成新数字（rc.26 真发生过）。
 * 判据只看 HEAD：已经在 HEAD 里的行不许被改成另一个数；工作树里刚补的行随便改。
 *
 * 必须在**任何写盘之前**调用：否则会先写了 ①（core-limits）才在 ②（ADR-10）报错，
 * 拒绝就变成了半写。
 */
function assertNotRewritingHistory() {
  if (!WRITE || growth) return;
  const file = 'docs/adr/ADR-10-core-line-budget.md';
  let headAdr = null;
  try { headAdr = execFileSync('git', ['show', `HEAD:${file}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { headAdr = null; }        // 非 git 环境 / 文件未入库：没有"历史"可篡改，放行
  const conflict = releasedRowConflict(headAdr, ADR_VER, total);
  if (conflict && !process.argv.includes('--allow-rewrite-released-row')) {
    console.error('拒绝写入：\n  ' + releasedRowMessage(ADR_VER, conflict, total));
    process.exit(1);
  }
}
assertNotRewritingHistory();

/** §2 版本表：| vX | 旧 → **新** | 增量说明 | —— 说明列必须真的写了，不能留占位符。 */
function versionRows(md) {
  return [...md.matchAll(/^\|\s*v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*\|\s*(\d+)\s*→\s*\*\*(\d+)\*\*\s*\|\s*([^|]*)\|/gm)]
    .map((m) => ({ from: Number(m[2]), to: Number(m[3]), note: m[4].trim() }));
}

/** §5 变更记录：| 日期 | 版本 | **上限** | 实测 | 增量性质 | */
function budgetRows(md) {
  return [...md.matchAll(/^\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*v([0-9A-Za-z.-]+)\s*\|\s*\*\*(\d+)\*\*\s*\|\s*(\d+)\s*\|/gm)]
    .map((m) => ({ date: m[1], version: m[2], budget: Number(m[3]), measured: Number(m[4]) }));
}

function missingRatchetRecords() {
  const adr = readFileSync(join(ROOT, 'docs/adr/ADR-10-core-line-budget.md'), 'utf8');
  const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
  const missing = [];
  // 记录不能靠“填一个能匹配正则的行”：归因文字必须是人写的。
  // 判据：同一行存在、且增量说明列不是空、不是占位符、不是一句“同步行数”。
  const isRealNote = (s) => typeof s === 'string' && s.length >= 8 && !/^<.*>$/.test(s) && !/^(?:同步|更新|调整|见上方|—+|-+)$/.test(s);
  if (!versionRows(adr).some((r) => r.from === currentBudget && r.to === total && isRealNote(r.note))) {
    missing.push(`ADR-10 §2 版本表：| v<新版本> | ${currentBudget} → **${total}** | <写下增量构成，不能留占位符> |`);
  }
  if (!budgetRows(adr).some((r) => r.budget === total && r.measured === total)) {
    missing.push(`ADR-10 §5 变更记录：| YYYY-MM-DD | v<新版本> | **${total}** | ${total} | <增量性质> |`);
  }
  // CHANGELOG：数字必须出现在**当前版本的那一节**里，不能是全文件任意处命中一个数。
  // 节头允许带后缀（`## vX (日期)：说明`）—— 早期版本只认裸标题，导致明明写了也报缺。
  const esc = PKG_VERSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const head = new RegExp(`^##\\s+v?${esc}(?:\\s|$)`);
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((l) => head.test(l));
  let sec = null;
  if (start >= 0) {
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => /^##\s/.test(l));
    sec = (end < 0 ? rest : rest.slice(0, end)).join('\n');
  }
  const sectionHasNumber = Boolean(sec && new RegExp(`(?:→|≤)\\s*\\*{0,2}${total}\\*{0,2}(?:\\s*行)?`).test(sec));
  if (!sectionHasNumber) {
    missing.push(`CHANGELOG.md 的 \`## v${PKG_VERSION}\` 一节：需出现「→ ${total}」或「核心 ≤ ${total} 行」`);
  }
  return missing;
}

if (growth) {
  const missing = missingRatchetRecords();
  if (missing.length) {
    console.error(`[sync-line-docs][拒绝] 实测 ${total} 行 > 现行预算 ${currentBudget} 行：上调预算必须留下记录。`);
    console.error('缺以下记录（补进 ADR-10 / CHANGELOG 后重跑；本脚本不替你写历史归因）：');
    for (const m of missing) console.error(`  - ${m}`);
    console.error('未写入任何文件。');
    process.exit(1);
  }
}

const edits = [];
const plan = (file, from, to) => edits.push({ file, from, to });

function replaceOnce(file, from, to) {
  const abs = join(ROOT, file);
  const src = readFileSync(abs, 'utf8');
  const n = src.split(from).length - 1;
  if (n !== 1) throw new Error(`${file}: 期望 1 处匹配，实际 ${n} —— 措辞变了，请同步本脚本：${from.slice(0, 60)}`);
  plan(file, from, to);
}

// ① 预算常量
{
  const src = limitsSrc;
  if (currentBudget !== total) {
    replaceOnce('scripts/core-limits.mjs', `export const CORE_MAX_LINES = ${currentBudget};`, `export const CORE_MAX_LINES = ${total};`);
  }
  // 字节预算跟着实测走：它和行数描述的是**同一份内容**，不是第二个对外承诺。
  // 不一起更新的话，任何合法的核心改动都会先被字节闸拦住——而那个红色看起来像“有东西在改内核”。
  const bytesMatch = src.match(/export const CORE_MAX_BYTES = (\d+);/);
  if (!bytesMatch) throw new Error('找不到 CORE_MAX_BYTES');
  if (Number(bytesMatch[1]) !== bytes) {
    replaceOnce('scripts/core-limits.mjs', `export const CORE_MAX_BYTES = ${bytesMatch[1]};`, `export const CORE_MAX_BYTES = ${bytes};`);
  }
  for (const f of BUDGETED) {
    const re = new RegExp(`'${f.replace('.', '\\.')}': (\\d+),`);
    const mm = src.match(re);
    if (!mm) throw new Error(`MODULE_BUDGET 里找不到 ${f}`);
    if (Number(mm[1]) !== per[f]) replaceOnce('scripts/core-limits.mjs', `'${f}': ${mm[1]},`, `'${f}': ${per[f]},`);
  }
}

// ② ADR-10：正文"当前 N 行" + 版本表末行
{
  const file = 'docs/adr/ADR-10-core-line-budget.md';
  const src = readFileSync(join(ROOT, file), 'utf8');
  for (const m of src.matchAll(/当前\s*(\d+)\s*行/g)) {
    if (Number(m[1]) !== total) replaceOnce(file, m[0], `当前 ${total} 行`);
  }
  // 预算上调时，新行只能由人补（要写归因）；这里只动“当前 N 行”这类现状说法。
  if (!growth) {
    const rows = [...src.matchAll(/^\|\s*v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*\|\s*(\d+)\s*→\s*\*\*(\d+)\*\*\s*\|/gm)];
    if (!rows.length) throw new Error('ADR-10 版本表为空');
    // 只动**已经写着上一轮预算**的那一行：新版本行由人补（要写归因），
    // 而"末行"在补了新行之后就不再是要同步的那一行了 —— 无条件改末行会把
    // 刚写好的历史归因行（rc.17 的 4597→4624）覆盖成新数值，历史就消失了。
    const last = rows[rows.length - 1];
    if (Number(last[3]) !== total) {
      // 只认**本版本**那一行：上一轮预算的数值可能同时出现在历史行里（rc.17 的 to 正是 4624），
      // 按数值找会把历史行改成本轮数字，归因就没了。
      const target = rows.find((r) => String(r[1]) === ADR_VER);
      if (target) {
        replaceOnce(file, `| v${target[1]} | ${target[2]} → **${target[3]}** |`, `| v${target[1]} | ${target[2]} → **${total}** |`);
      }
    }
    // 版本表末行之后还有一张"证据表"（日期 | 版本 | 记录值 | 实测值）
    const ev = [...src.matchAll(/^\|\s*\d{4}-\d{2}-\d{2}\s*\|\s*v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*\|\s*\*\*(\d+)\*\*\s*\|\s*(\d+)\s*\|/gm)];
    if (ev.length) {
      const l = ev.find((r) => String(r[1]) === ADR_VER) ?? null;
      if (l && (Number(l[2]) !== total || Number(l[3]) !== total)) {
        replaceOnce(file, `| v${l[1]} | **${l[2]}** | ${l[3]} |`, `| v${l[1]} | **${total}** | ${total} |`);
      }
    }
  }
}

// ③ 文档与包描述
{
  const simple = [
    ['README.md', /微内核\s*(\d+)\s*行/, (m) => m[0].replace(/\d+/, total)],
    // v0.16.0-rc.10：README 的「设计原则」写的是"核心 ≤ N 行"，与上面那句**两个说法**。
    // 生成器以前只认前者，于是这一行一直停在 2080（而预算早已是 4180）。
    ['README.md', /核心\s*≤\s*(\d+)\s*行/, (m) => m[0].replace(/\d+/, total)],
    // 英文 README 同一事实的第三种说法：`≤ N lines`。
    ['README.en.md', /≤\s*(\d+)\s*lines/, (m) => m[0].replace(/\d+/, total)],
    // 定位文档里也有一处（核对日期 2026-10-20 写的 2079）。
    ['docs/positioning-and-pi.md', /微内核\s*(\d+)\s*行/, (m) => m[0].replace(/\d+/, total)],
    ['docs/architecture/microkernel.md', /微内核\s*(\d+)\s*行代码/, (m) => m[0].replace(/\d+/, total)],
    ['docs/architecture/microkernel.md', /\|\s*\*\*合计\*\*\s*\|\s*\*\*(\d+)\*\*/, (m) => m[0].replace(/\d+/, total)],
    ['docs/architecture/microkernel.md', /预算上限\s*\*\*(\d+)\*\*/, (m) => m[0].replace(/\d+/, total)],
    ['package.json', /核心\s*≤\s*(\d+)\s*行/, (m) => m[0].replace(/\d+/, total)],
  ];
  for (const [file, re, build] of simple) {
    const src = readFileSync(join(ROOT, file), 'utf8');
    const m = src.match(re);
    if (!m) throw new Error(`${file}: 找不到 ${re}`);
    if (Number(m[1]) !== total) replaceOnce(file, m[0], build(m));
  }
  // microkernel.md 的逐文件表（T8 会逐行核对，漏一行就红）
  {
    const file = 'docs/architecture/microkernel.md';
    const src = readFileSync(join(ROOT, file), 'utf8');
    for (const [name, n] of Object.entries(per)) {
      const re = new RegExp('^\\| ' + name.replace('.', '\\.') + ' \\| (\\d+) \\|', 'm');
      const m = src.match(re);
      if (!m) throw new Error(file + ': 逐文件表里找不到 ' + name);
      if (Number(m[1]) !== n) replaceOnce(file, m[0], `| ${name} | ${n} |`);
    }
  }
  // microkernel.md 的"（N / N）"与"core N + bootstrap M"
  const mk = readFileSync(join(ROOT, 'docs/architecture/microkernel.md'), 'utf8');
  const pair = mk.match(/（(\d+) \/ \d+）/);
  if (pair && Number(pair[1]) !== total) replaceOnce('docs/architecture/microkernel.md', pair[0], `（${total} / ${total}）`);
  const sum = mk.match(/`src\/` 合计 (\d+) 行（core (\d+) \+ bootstrap (\d+)）/);
  if (sum && Number(sum[2]) !== total) {
    const boot = Number(sum[3]);
    replaceOnce('docs/architecture/microkernel.md', sum[0], `\`src/\` 合计 ${total + boot} 行（core ${total} + bootstrap ${boot}）`);
  }
}

if (!edits.length) {
  console.log(`行数文档已一致（${total} 行）。`);
  process.exit(0);
}
for (const e of edits) {
  console.log(`${WRITE ? '写' : '待写'} ${e.file}: ${e.from.slice(0, 48)} → ${e.to.slice(0, 48)}`);
  if (!WRITE) continue;
  const abs = join(ROOT, e.file);
  const src = readFileSync(abs, 'utf8');
  writeFileSync(abs, src.replace(e.from, e.to));
}
if (!WRITE) {
  console.log(`\n实测 ${total} 行；${edits.length} 处待同步。加 --write 落盘。`);
  process.exit(1);
}
console.log(`\n已同步 ${edits.length} 处到实测 ${total} 行。`);
