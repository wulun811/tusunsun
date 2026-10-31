#!/usr/bin/env node
/**
 * Core 注释预算与「纯注释改动」等价校验（只读，不写源码）。
 *
 * 两个判据都必须是机器可判的，否则"清理注释"与"改逻辑"无法区分：
 *   ① 注释预算：`src/core/*.js` 的整行注释数、以及其中带历史标记的行数。
 *      历史标记的**正则与统计口径**与独立审计脚本逐字一致，双方用同一把尺子复跑。
 *   ② 代码投影：剥掉注释、**保留行结构**后的 sha256。它比 token 序列更强 ——
 *      token 序列相同只证明"词法相同"：扫描器跳过注释，也跳过换行，所以它
 *      证明不了 ASI（自动分号插入）没变 ——「return」后紧跟换行会在 ASI 处插入
 *      分号（返回 undefined），而同样两个 token 之间只夹一条不换行的注释时，
 *      返回的是那个对象。代码投影相同则说明语句边界没被动过。
 *      token 序列仍然一并记录：它回答"词法单元有没有增减"。
 *
 * 用法：
 *   node scripts/comment-audit.mjs                   # 只报告
 *   node scripts/comment-audit.mjs --gate            # 预算门禁（超限 exit 1）
 *   node scripts/comment-audit.mjs --baseline <dir>  # 与另一份包比 token 与代码投影
 *   node scripts/comment-audit.mjs --json <file>     # 机器可读输出
 *
 * 退出码：0 通过；1 不通过；2 用法或 IO 错误。
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 注释预算。**历史标记行是硬门**（≤ 15，且每条残余都要在报告里登记）。
 * 整行注释总数是**建议目标**（≤ 750）：计划原文写明这一项"不是机械发布硬门"，
 * 而把它压到 750 只能删现行不变式。默认只告警；要强制时加 `--strict-comments`。
 */
export const COMMENT_BUDGET = { whole_comment_lines: 750, historical_comment_lines: 15 };

/** 权威行数预算脚本本身也必须只留"现行事实"，不留每轮预算调整的流水账。 */
export const LIMITS_FILE_BUDGET = { max_lines: 120, forbidden: /(?:2026-|\bv0\.\d|\brc\.\d|专家|复审)/ };

/**
 * 历史标记正则：与独立审计脚本完全一致（含大小写不敏感）。
 * 命中只说明"这行值得人工看一眼"，不等于必须删除。
 */
const HISTORY = /(?:\b(?:R0|R25|R-014|R-0|K-|X0\d|H-0|SC-|LAZY-|ERR-|EV-|ADR-|K3|K4|K6|v0\.|rc\.|2026-)\S*|专家|复审|反例|修前|修后|旧版|旧实现|历史|上轮|曾在这里|这次修复)/i;

const ID_START = /[A-Za-z_$\u00a0-\uffff]/;
const ID_PART = /[\w$\u00a0-\uffff]/;
const DIGIT = /[0-9]/;

/** 出现在这些词之后，`/` 是正则字面量的开始而不是除号。 */
const REGEX_AFTER_WORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case',
  'do', 'else', 'yield', 'await', 'throw',
]);

/** 多字符标点，长的在前。 */
const PUNCT = [
  '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '&&=', '||=', '??=', '>>>',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=',
  '/=', '%=', '&=', '|=', '^=', '<<', '>>', '**',
];

function regexAllowedAfter(prev) {
  if (!prev) return true;
  if (prev === ')' || prev === ']' || prev === '}' || prev === '++' || prev === '--') return false;
  if (ID_START.test(prev[0])) return REGEX_AFTER_WORD.has(prev);
  return true;
}

/**
 * 一次扫描产出 token 序列：注释直接跳过，字符串/模板/正则各自成一个 token。
 * 注释被删掉不会改变序列；任何代码改动都会。
 */
export function tokenize(src) {
  const toks = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) { i += 1; continue; }

    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? n : nl;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }

    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) { j += 1; break; }
        j += 1;
      }
      toks.push(src.slice(i, j));
      i = j;
      continue;
    }

    if (c === '`') {
      let j = i + 1;
      let depth = 0;
      while (j < n) {
        const ch = src[j];
        if (ch === '\\') { j += 2; continue; }
        if (depth === 0 && ch === '`') { j += 1; break; }
        if (ch === '$' && src[j + 1] === '{') { depth += 1; j += 2; continue; }
        if (depth > 0 && ch === '{') { depth += 1; j += 1; continue; }
        if (depth > 0 && ch === '}') { depth -= 1; j += 1; continue; }
        j += 1;
      }
      toks.push(src.slice(i, j));
      i = j;
      continue;
    }

    if (c === '/' && regexAllowedAfter(toks[toks.length - 1])) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const ch = src[j];
        if (ch === '\\') { j += 2; continue; }
        if (ch === '\n') break;
        if (inClass) { if (ch === ']') inClass = false; j += 1; continue; }
        if (ch === '[') { inClass = true; j += 1; continue; }
        if (ch === '/') { j += 1; closed = true; break; }
        j += 1;
      }
      if (closed) {
        while (j < n && ID_PART.test(src[j])) j += 1;
        toks.push(src.slice(i, j));
        i = j;
        continue;
      }
      toks.push('/');
      i += 1;
      continue;
    }

    if (ID_START.test(c)) {
      let j = i + 1;
      while (j < n && ID_PART.test(src[j])) j += 1;
      toks.push(src.slice(i, j));
      i = j;
      continue;
    }

    if (DIGIT.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$.]/.test(src[j])) j += 1;
      toks.push(src.slice(i, j));
      i = j;
      continue;
    }

    const p = PUNCT.find((x) => src.startsWith(x, i));
    if (p) { toks.push(p); i += p.length; continue; }
    toks.push(c);
    i += 1;
  }
  return toks;
}

/** 与独立审计脚本同一口径：整行注释（含块注释内部）、空行、其余为代码行。 */
function countLines(src) {
  let comment = 0;
  let blank = 0;
  let code = 0;
  let history = 0;
  let inBlock = false;
  const lines = src.split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t) { blank += 1; continue; }
    const isComment = t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || inBlock;
    if (isComment) {
      comment += 1;
      if (HISTORY.test(t)) history += 1;
    } else {
      code += 1;
    }
    if (t.startsWith('/*') && !t.includes('*/')) inBlock = true;
    else if (inBlock && t.includes('*/')) inBlock = false;
  }
  return { code_or_mixed_lines: code, whole_comment_lines: comment, blank_lines: blank, historical_comment_lines: history };
}

/**
 * 去注释、**保留行结构**的代码投影。
 *
 * 为什么需要它：token 序列相同不等于行为相同。扫描器会跳过注释，也会跳过换行：
 * 「return」后面紧跟换行时，ASI 在此插入分号，函数返回 undefined；同样两个 token
 * 之间只夹一条不换行的注释时，返回的是那个对象。注释是空白，但**换行不是**。
 *
 * 投影规则：整行注释 → 空行；行尾注释 → 尾随空白；字符串与模板里的斜杠不算注释。
 * 最后折叠连续空行 —— 删空行永远不会把两行代码并成一行，而"两行代码之间隔着换行"
 * 正是 ASI 关心的全部。所以投影相同 = 每条代码语句仍然独立成行、边界未被改动。
 */
function projectCode(src) {
  const out = [];
  let inBlock = false;
  let inTemplate = false;
  for (const raw of src.split(/\r?\n/)) {
    let line = '';
    let i = 0;
    while (i < raw.length) {
      const ch = raw[i];
      if (inBlock) {
        const end = raw.indexOf('*/', i);
        if (end === -1) { i = raw.length; break; }
        inBlock = false;
        i = end + 2;
        line += ' ';
        continue;
      }
      if (inTemplate) {
        line += ch;
        if (ch === '\\' && i + 1 < raw.length) { line += raw[i + 1]; i += 2; continue; }
        if (ch === '`') inTemplate = false;
        i += 1;
        continue;
      }
      if (ch === '/' && raw[i + 1] === '/') break;
      if (ch === '/' && raw[i + 1] === '*') { inBlock = true; i += 2; line += ' '; continue; }
      if (ch === '`') { inTemplate = true; line += ch; i += 1; continue; }
      if (ch === '"' || ch === "'") {
        const quote = ch;
        let j = i + 1;
        while (j < raw.length) {
          if (raw[j] === '\\') { j += 2; continue; }
          if (raw[j] === quote) { j += 1; break; }
          j += 1;
        }
        line += raw.slice(i, j);
        i = j;
        continue;
      }
      line += ch;
      i += 1;
    }
    out.push(line.replace(/\s+$/, ''));
  }
  const collapsed = [];
  for (const l of out) if (l !== '' || collapsed[collapsed.length - 1] !== '') collapsed.push(l);
  while (collapsed.length && collapsed[0] === '') collapsed.shift();
  return collapsed.join('\n');
}

export function measureCore(dir) {
  const coreDir = dir;
  const files = {};
  const totals = {
    official_lines: 0, physical_lines: 0, code_or_mixed_lines: 0,
    whole_comment_lines: 0, blank_lines: 0, historical_comment_lines: 0, tokens: 0,
  };
  for (const name of readdirSync(coreDir).filter((f) => /\.(?:[cm]?js)$/.test(f)).sort()) {
    const src = readFileSync(join(coreDir, name), 'utf8');
    const lines = countLines(src);
    const toks = tokenize(src);
    const entry = {
      // 官方口径：`split('\n').length`，含每个文件末尾换行多切出的那个空元素。
      official_lines: src.split('\n').length,
      // 物理口径：与 `wc -l` 相同 —— **数换行符**，文件末尾换行算一行、不多切空元素。
      physical_lines: (src.match(/\n/g) || []).length,
      ...lines,
      tokens: toks.length,
      token_sha256: createHash('sha256').update(JSON.stringify(toks)).digest('hex'),
      code_projection_sha256: createHash('sha256').update(projectCode(src)).digest('hex'),
    };
    files[name] = entry;
    for (const k of Object.keys(totals)) totals[k] += entry[k];
  }
  return { dir: coreDir, totals, files };
}

function resolveCoreDir(arg) {
  if (arg.endsWith('.js')) return dirname(arg);
  const nested = join(arg, 'src', 'core');
  try {
    readdirSync(nested);
    return nested;
  } catch {
    return arg;
  }
}

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  process.stdout.write('用法: node scripts/comment-audit.mjs [--gate] [--baseline <dir>] [--json <file>] [--strict-comments] [--write-baseline]\n');
  process.exit(0);
}
const known = new Set(['--gate', '--baseline', '--json', '--strict-comments', '--write-baseline', '--allow-raise']);
for (let i = 0; i < args.length; i += 1) {
  if (!known.has(args[i]) && !known.has(args[i - 1])) {
    process.stderr.write(`未知参数：${args[i]}\n`);
    process.exit(2);
  }
}

const coreDir = join(ROOT, 'src', 'core');
const current = measureCore(coreDir);
const t = current.totals;

/**
 * 插件层的历史注释棘轮。
 *
 * 核心早就有预算，插件层一直没有：结果是 `tool-executor.js` 一个文件 816 行注释、
 * 175 行历史标记。这里不改“必须删到多少”——只保证**不再增长**：每文件不许高于
 * 基线，新文件默认 0。降低随时可以（`--write-baseline`），升高要显式 `--allow-raise`。
 *
 * 覆盖面是 `.js/.cjs/.mjs`：只认 `.js` 会留一个后门（改个扩展名就不再受棘轮管）。
 */
const PLUGIN_BASELINE = join(ROOT, 'docs', 'quality', 'comment-history-baseline.json');

function measurePlugins() {
  const out = {};
  for (const rel of readdirSync(join(ROOT, 'plugins'), { recursive: true }).sort()) {
    // 只覆盖 .js 会留一个后门：把文件改成 .mjs 就不再受禁轮管（本仓已有十几个 .mjs 器官模块）。
    if (!/\.(?:[cm]?js)$/.test(rel)) continue;
    const p = join(ROOT, 'plugins', rel);
    if (!statSync(p).isFile()) continue;
    const c = countLines(readFileSync(p, 'utf8'));
    out[`plugins/${rel.split(sep).join('/')}`] = {
      comments: c.whole_comment_lines, history: c.historical_comment_lines,
    };
  }
  return out;
}

const pluginsNow = measurePlugins();
let pluginBaseline = {};
try { pluginBaseline = JSON.parse(readFileSync(PLUGIN_BASELINE, 'utf8')).files || {}; } catch { pluginBaseline = {}; }
const pluginHistory = Object.values(pluginsNow).reduce((a, v) => a + v.history, 0);
/** `--write-baseline` 被拒时的理由；非空即整体失败（不能“拒了但还是 0”）。 */
let writeRefused = null;

console.log('=== Core 注释与代码投影审计（official 含末尾空元素；physical = wc -l）===\n');
console.log('file                        official physical  code  comments  history   tokens');
for (const [name, v] of Object.entries(current.files)) {
  console.log(`${name.padEnd(26)} ${String(v.official_lines).padStart(8)} ${String(v.physical_lines).padStart(8)} ${String(v.code_or_mixed_lines).padStart(5)} ${String(v.whole_comment_lines).padStart(9)} ${String(v.historical_comment_lines).padStart(8)} ${String(v.tokens).padStart(8)}`);
}
console.log(`${'合计'.padEnd(24)} ${String(t.official_lines).padStart(8)} ${String(t.physical_lines).padStart(8)} ${String(t.code_or_mixed_lines).padStart(5)} ${String(t.whole_comment_lines).padStart(9)} ${String(t.historical_comment_lines).padStart(8)} ${String(t.tokens).padStart(8)}`);
console.log(`\nplugins/：${Object.keys(pluginsNow).length} 个文件，历史标记 ${pluginHistory} 行，注释 ${Object.values(pluginsNow).reduce((a, v) => a + v.comments, 0)} 行（棘轮：每文件不得高于基线）`);

if (args.includes('--write-baseline')) {
  // **棘轮的自指陷阱**：原来这里写完就 `exit 0`，于是
  //   `--gate` 红 → `--gate --write-baseline` 蓝 → `--gate` 蓝。
  // 一次调用就把红变绿，而且没有任何一处留下「是谁把上限抬上去的」。
  // 这是棘轮退化成注释的**第二种**形状（第一种是「只警告不阻断」）。
  //
  // 现在：写盘前先算「这次写会不会抬高任何一项」——包括**新文件登记**（从零起算也是抬高）。
  // 有抬高时必须显式 `--allow-raise`；且抬高记入基线文件的 `raises` 历史，供 review 看见。
  // 写完**不提前退出**，继续走门禁判定：仅仅是「写过基线」不得成为跳过检查的理由。
  const raises = [];
  for (const [f, v] of Object.entries(pluginsNow)) {
    const b = pluginBaseline[f];
    if (!b) { raises.push(`${f} 新文件登记 → history ${v.history} / comments ${v.comments}`); continue; }
    if (v.history > b.history) raises.push(`${f} history ${b.history} → ${v.history}`);
    if (v.comments > b.comments) raises.push(`${f} comments ${b.comments} → ${v.comments}`);
  }
  if (raises.length > 0 && !args.includes('--allow-raise')) {
    writeRefused = raises;
    console.log(`\n[拒绝写入基线] 本次写盘会抬高 ${raises.length} 项（棘轮语义是只降不升）：`);
    for (const r of raises.slice(0, 10)) console.log(`  · ${r}`);
    if (raises.length > 10) console.log(`  …其余 ${raises.length - 10} 项`);
    console.log('未写入任何文件。确认要抬高时显式加 --allow-raise（会记入基线 raises 历史）。');
  } else {
    const prevRaises = (() => {
      try { return JSON.parse(readFileSync(PLUGIN_BASELINE, 'utf8')).raises || []; } catch { return []; }
    })();
    const raisesLog = raises.length
      ? [...prevRaises, { at: new Date().toISOString(), entries: raises }]
      : prevRaises;
    writeFileSync(PLUGIN_BASELINE, `${JSON.stringify({
      note: 'plugins/ 的注释棘轮基线（js/cjs/mjs）：历史标记与整行注释每文件只降不升；文件集合必须与磁盘完全一致（新文件需显式 --allow-raise 登记，删文件后必须重写基线）。降低用 --write-baseline；升高必须在 raises 里留下记录并被 review 看见。',
      files: pluginsNow,
      raises: raisesLog,
    }, null, 2)}\n`);
    console.log(`\n已写入基线：${relative(ROOT, PLUGIN_BASELINE)}（${Object.keys(pluginsNow).length} 个文件，历史标记 ${pluginHistory} 行${raises.length ? `，**抬高 ${raises.length} 项已记账**` : '，无抬高'}）`);
    // 让后续门禁判定看到写盘后的状态，而不是拿旧基线把刚写的文件再判红一次。
    pluginBaseline = pluginsNow;
  }
}

const failures = [];
const warnings = [];
if (args.includes('--gate')) {
  if (t.whole_comment_lines > COMMENT_BUDGET.whole_comment_lines) {
    const msg = `整行注释 ${t.whole_comment_lines} > 建议目标 ${COMMENT_BUDGET.whole_comment_lines}（不是硬门）`;
    if (args.includes('--strict-comments')) failures.push(msg);
    else warnings.push(msg);
  }
  if (t.historical_comment_lines > COMMENT_BUDGET.historical_comment_lines) {
    failures.push(`历史标记整行注释 ${t.historical_comment_lines} > 预算 ${COMMENT_BUDGET.historical_comment_lines}`);
  }
  // 历史标记：**所有**文件（新文件默认 0）—— 历史流水账才是最该只降不升的东西。
  const grownHistory = Object.entries(pluginsNow)
    .filter(([f, v]) => v.history > (pluginBaseline[f]?.history ?? 0))
    .map(([f, v]) => `${f} ${pluginBaseline[f]?.history ?? 0} → ${v.history}`);
  if (grownHistory.length) {
    failures.push(`plugins 历史注释增长 ${grownHistory.length} 个文件：${grownHistory.slice(0, 8).join('；')}`
      + `${grownHistory.length > 8 ? ` …（其余 ${grownHistory.length - 8} 个）` : ''}`);
  }
  // 注释总量：只对**已在基线里**的文件比（新文件允许先从零写起，入基线后才锁住）。
  const grownComments = Object.entries(pluginsNow)
    .filter(([f, v]) => pluginBaseline[f] && v.comments > pluginBaseline[f].comments)
    .map(([f, v]) => `${f} ${pluginBaseline[f].comments} → ${v.comments}`);
  if (grownComments.length) {
    failures.push(`plugins 整行注释增长 ${grownComments.length} 个文件：${grownComments.slice(0, 8).join('；')}`
      + `${grownComments.length > 8 ? ` …（其余 ${grownComments.length - 8} 个）` : ''}`);
  }
  // **基线必须与目录双向一致。**
  //
  // 只查「已入基线的文件不许涨」会留下两个口子：
  //   · 新文件不在基线里 ⇒ 它写多少注释都不受管（旧注释说“新文件先从零写起”）；
  //   · 文件被删/改名后基线残留 ⇒ 删掉再恢复等于一次免费的棘轮重置。
  // 两个口子都不需要任何恶意：一次重构改名就能把 800 行注释“洗”成白纸。
  const onDisk = new Set(Object.keys(pluginsNow));
  const inBaseline = new Set(Object.keys(pluginBaseline));
  const unregistered = [...onDisk].filter((f) => !inBaseline.has(f));
  const stale = [...inBaseline].filter((f) => !onDisk.has(f));
  if (unregistered.length) {
    failures.push(`plugins 有 ${unregistered.length} 个文件未登记注释基线（新文件也必须先入基线才受管）：`
      + unregistered.slice(0, 8).join('；') + (unregistered.length > 8 ? ` …（其余 ${unregistered.length - 8} 个）` : ''));
  }
  if (stale.length) {
    failures.push(`注释基线有 ${stale.length} 个文件已不存在（删文件不得顺手降低棘轮）：`
      + stale.slice(0, 8).join('；') + (stale.length > 8 ? ` …（其余 ${stale.length - 8} 个）` : ''));
  }
  const limitsPath = join(ROOT, 'scripts', 'core-limits.mjs');
  const limitsSrc = readFileSync(limitsPath, 'utf8');
  const limitsLines = limitsSrc.split('\n').length;
  if (limitsLines > LIMITS_FILE_BUDGET.max_lines) {
    failures.push(`scripts/core-limits.mjs ${limitsLines} 行 > 预算 ${LIMITS_FILE_BUDGET.max_lines}`);
  }
  const m = limitsSrc.match(LIMITS_FILE_BUDGET.forbidden);
  if (m) failures.push(`scripts/core-limits.mjs 仍含编号/版本叙述：「${m[0]}」`);
  console.log(`\n预算：整行注释 ≤ ${COMMENT_BUDGET.whole_comment_lines}（实测 ${t.whole_comment_lines}），`
    + `历史标记 ≤ ${COMMENT_BUDGET.historical_comment_lines}（实测 ${t.historical_comment_lines}）`);
  console.log(`scripts/core-limits.mjs：${limitsLines} 行（≤ ${LIMITS_FILE_BUDGET.max_lines}）`);
}

let baselineReport = null;
const bi = args.indexOf('--baseline');
if (bi !== -1) {
  const target = args[bi + 1];
  if (!target) { process.stderr.write('--baseline 需要一个目录\n'); process.exit(2); }
  const baseDir = resolveCoreDir(target);
  let base;
  try {
    base = measureCore(baseDir);
  } catch (e) {
    process.stderr.write(`读不到基线 ${baseDir}：${e.message}\n`);
    process.exit(2);
  }
  const rows = [];
  let same = 0;
  let diff = 0;
  for (const [name, v] of Object.entries(current.files)) {
    const b = base.files[name];
    if (!b) { rows.push({ file: name, status: '新增文件（基线里没有）' }); diff += 1; continue; }
    // 两个判据分开报：结构一致才是硬门；只 token 一致说明行结构被改过，要人工看。
    const structEqual = b.code_projection_sha256 === v.code_projection_sha256;
    const tokenEqual = b.token_sha256 === v.token_sha256;
    if (structEqual) same += 1; else diff += 1;
    rows.push({
      file: name,
      status: structEqual ? '结构一致' : (tokenEqual ? '仅 token 一致（行结构变了）' : 'token 与结构都不同'),
      struct_equal: structEqual, token_equal: tokenEqual,
      before_tokens: b.tokens, after_tokens: v.tokens,
      before: { official_lines: b.official_lines, code_or_mixed_lines: b.code_or_mixed_lines, whole_comment_lines: b.whole_comment_lines, historical_comment_lines: b.historical_comment_lines },
      after: { official_lines: v.official_lines, code_or_mixed_lines: v.code_or_mixed_lines, whole_comment_lines: v.whole_comment_lines, historical_comment_lines: v.historical_comment_lines },
    });
  }
  for (const name of Object.keys(base.files)) {
    if (!(name in current.files)) { rows.push({ file: name, status: '文件已删除' }); diff += 1; }
  }
  baselineReport = { dir: baseDir, same, diff, rows, baseline_totals: base.totals };
  console.log(`\n与基线对照（${baseDir}）：${same} 个文件代码投影一致，${diff} 个不同`);
  for (const r of rows) {
    console.log(`  [${r.status === '结构一致' ? 'OK' : 'DIFF'}] ${r.file} — ${r.status}`
      + (r.before_tokens == null ? '' : `（token ${r.before_tokens} → ${r.after_tokens}）`));
  }
  if (diff > 0) failures.push(`代码投影与基线不同（${diff} 个文件）：注释清理不允许改动语句边界`);
}

const ji = args.indexOf('--json');
if (ji !== -1) {
  const out = args[ji + 1];
  if (!out) { process.stderr.write('--json 需要一个输出路径\n'); process.exit(2); }
  writeFileSync(out, `${JSON.stringify({
    measured_at: new Date().toISOString(),
    root: ROOT,
    budget: COMMENT_BUDGET,
    limits_file_budget: LIMITS_FILE_BUDGET,
    totals: t,
    files: current.files,
    baseline: baselineReport,
    failures,
  }, null, 2)}\n`);
  console.log(`\nJSON 已写入 ${out}`);
}

if (warnings.length > 0) {
  console.log('\n[WARN]');
  for (const w of warnings) console.log(`  · ${w}`);
}

if (writeRefused) {
  console.log('\n[FAIL]');
  console.log(`  · --write-baseline 被拒绝：${writeRefused.length} 项抬高需要显式 --allow-raise`);
}
if (failures.length > 0) {
  console.log('\n[FAIL]');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
if (writeRefused) process.exit(1);
console.log(args.includes('--gate') || baselineReport ? '\n[OK]' : '');
process.exit(0);
