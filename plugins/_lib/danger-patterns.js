// 危险命令判据（Y024 硬拦）的共享实现。
//
// 为什么独立成模块：
//   1. 判据只有一份 —— 执行器内建兜底与捆仙索护栏都从这里取；任何一处另写一份，
//      下一个读命令的调用点就会漏判。
//   2. 它不能住在生态插件里：没装捆仙索时也必须生效；安全不能取决于场景装配。
//
// 判据形态：按**参数**而不是工具名。`tool-bash` 本身合法，危险的是它收到的命令串。
// 保守原则：只匹配明确的破坏/越界形态，不做「白名单之外一律拒绝」那种会误伤日常使用的强策略。
//
// 边界（诚实）：这是"明确形态"清单，不是安全边界；真正的隔离靠进程级沙箱。
// 敏感路径读取另由 sensitive-paths.js 按路径判断（不是按文件名猜）。
import { basename } from 'node:path';
import { sensitivePathOf, pathCache } from './sensitive-paths.js';

// rm 的选项族：短选项簇（-rf / -r）、长选项（--recursive / --recursive=always）、单独的 `--`。
const RM_FLAGS = String.raw`(?:(?:--|--?[a-zA-Z][a-zA-Z-]*(?:=[^\s|;&]*)?)\s+)*`;
/** 递归选项：`-r`/`-R`/`-rf` 一类簇，或长选项 `--recursive`。 */
const RM_RECURSIVE = String.raw`(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)`;
/** 递归 + 强制：同一个短选项簇，分写的短选项，或长选项成对出现。 */
const RM_FORCE_RECURSIVE = String.raw`(?:-[a-zA-Z]*(?:[rR][a-zA-Z]*f|f[a-zA-Z]*[rR])[a-zA-Z]*|-[a-zA-Z]*[rR][a-zA-Z]*\s+-[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*\s+-[a-zA-Z]*[rR][a-zA-Z]*|--recursive\s+--force|--force\s+--recursive)`;

/**
 * 命令位置上的"外壳前缀"：`sudo` / `timeout 30` / `env -i VAR=x` / `nice -n 5` 一类。
 * 解释器、关机/重启与外联三组判据共用这一段，避免各写半份。
 */
const CMD_PREFIX = String.raw`(?:(?:sudo|doas|nohup|env|command|exec|builtin|timeout|nice|setsid)\s+|[0-9]+(?:\.[0-9]+)?[smhd]?\s+|-[a-zA-Z]+\s+|[A-Za-z_]\w*=\S*\s+)*`;

// 外联判据的公共片段：只认 `http(s)://` 会让无 scheme 的域名、host:port 整条漏过。
const FETCHERS = 'curl|wget|nc|ncat|netcat|socat|telnet|ftp|lftp';
const CMD_START = String.raw`(?:^|[\n\r|;&\x60()"']|\$\()\s*${CMD_PREFIX}`;
const HOST_LIKE = String.raw`(?:[a-z0-9-]+\.)+[a-z]{2,}`;
const IPV4_LIKE = String.raw`(?:\d{1,3}\.){3}\d{1,3}`;
const NET_TARGET = String.raw`(?:[a-z][a-z0-9+.-]*:(?:\/\/)?)?(?:${HOST_LIKE}|${IPV4_LIKE})(?::\d{1,5})?(?:[/?#][^\s|;&]*)?`;

/** 命令串中出现这些形态即视为破坏性/越界 */
export const DANGEROUS_COMMAND_PATTERNS = [
  // 读取系统账号/凭据文件
  { re: /\bcat\s+[^|;&]*\/etc\/(?:passwd|shadow|sudoers)\b/, why: '读取系统账号/凭据文件' },
  { re: /\/etc\/(?:passwd|shadow|sudoers)\b/, why: '访问系统账号/凭据文件' },
  { re: /\b(?:id_rsa|id_ed25519|\.ssh\/[a-z_]+|\.aws\/credentials|\.netrc)\b/, why: '读取私钥/凭据文件' },
  // 工具层外联（trusted-local-only 定位不允许）
  { re: /\b(?:curl|wget|nc|ncat|telnet)\s+[^|;&]*\b(?:https?:\/\/|ftp:\/\/)/, why: '工具层外联（trusted-local-only 不允许）' },
  // 远程内容直接执行
  { re: /\b(?:curl|wget)\b[^|;&]*\|\s*(?:ba)?sh\b/, why: '远程内容直接执行' },
  // 递归强删 / 块设备 / 提权 / fork 炸弹 / 格式化
  { re: new RegExp(String.raw`\brm\s+${RM_FLAGS}${RM_FORCE_RECURSIVE}\s+\/(?:\s|$)`), why: '递归强删根目录' },
  { re: new RegExp(String.raw`\brm\s+${RM_FLAGS}${RM_FORCE_RECURSIVE}\b`), why: '递归强删' },
  { re: /\bdd\s+[^|;&]*of=\/dev\//, why: '直接写块设备' },
  { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:/, why: 'fork 炸弹' },
  { re: /\bchmod\s+(?:-R\s+)?0?777\s+\//, why: '对根目录放宽权限' },
  { re: /\bmkfs(?:\.[a-z0-9]+)?\b/, why: '格式化文件系统' },
  // 关机/重启：只认**命令位置**（行首/分隔符后，可带 sudo 一类前缀），
  // 或 `-c`/`-e` 包装的命令串（`bash -c "reboot"`）。
  // R0-121（复查真阳性）：原判据是全文子串匹配 ⇒ `grep -n reboot CHANGELOG.md`、`man shutdown`
  // 这类"把动词当数据"的日常命令被硬拦（retryable:false、无覆盖），代价高于收益。
  // 诚实边界：Y024 从来不是安全边界，是"明确形态"清单；`ssh host reboot` 一类间接执行不在此列。
  { re: new RegExp(String.raw`(?:^|[\n\r|;&\x60]|\$\()\s*${CMD_PREFIX}(?:shutdown|reboot|halt|poweroff)\b`), why: '关机/重启' },
  { re: /-(?:c|e)\s+["'][^"']*\b(?:shutdown|reboot|halt|poweroff)\b/, why: '关机/重启（经 -c/-e 包装）' },
  // 外联的其余写法：裸域名/IP、host:port、netcat/socat、/dev/tcp 都是同一个动作。
  { re: new RegExp(String.raw`${CMD_START}(?:${FETCHERS})\b[^|;&]*\s${NET_TARGET}`, 'i'), why: '工具层外联（无 scheme 的域名/IP）' },
  { re: new RegExp(String.raw`${CMD_START}(?:${FETCHERS})\b[^|;&]*\s[a-z0-9][a-z0-9.:-]*:\d{1,5}(?:[/?#][^\s|;&]*)?`, 'i'), why: '工具层外联（host:port）' },
  { re: new RegExp(String.raw`${CMD_START}(?:nc|ncat|netcat|socat)\b(?:\s+-{1,2}[^\s|;&]+)*\s+[^\s|;&-][^\s|;&]*`, 'i'), why: 'netcat/socat 外联或监听' },
  { re: /\/dev\/(?:tcp|udp)\//, why: '经 /dev/tcp 或 /dev/udp 直连网络' },
];

/** 整体禁用的能力名（本仓当前没有整类禁用的工具，保留旧名以防有插件注册同名能力） */
export const DANGEROUS_TOOL_NAMES = new Set([
  'rm_rf', 'git_force_push', 'db_drop', 'os_system', 'popen', 'fork_exec',
]);

// ── 数据 vs 代码 ──────────────────────────────────────────────────────
//
// R0-121（复查真阳性）：判据此前对**整条命令串做子串匹配**，于是"把危险串当文本"的日常命令
// 被硬拦且无法覆盖：
//     git commit -m "fix rm -rf handling"      grep -n "rm -rf" CHANGELOG.md
//     echo "never run rm -rf /"                cat > notes.md <<'EOF' … rm -rf … EOF
// 但简单"剥掉引号"会开更坏的口子：`echo "rm -rf /" | bash`、`bash -c "rm -rf /"`、`eval`、
// `xargs`、`find -exec`、`$(...)` 里都是**会被执行**的代码。
//
// 所以按"内容去向"分类，而不是按有无引号：
//   · 含执行包装器（bash -c / | sh / eval / xargs / find -exec / ssh …）⇒ 引号里也是代码，
//     按**原文**匹配（保守，宁可多拦）；
//   · 否则引号内文本与 heredoc 体是**数据**，在"代码视图"里替换成占位符再匹配；
//   · 命令替换 `$(...)` 与反引号的内容一定会执行 —— 单独抽出、保留在视图里。
//
// 诚实边界：写进文件的文本若在**另一次调用**里被执行（两步走），文本判据看不到。这一类不在
// Y024 的射程内 —— 它从来不是安全边界，真正的隔离要靠进程级沙箱（R1）。

/** 数据占位符。用私用区字符，避免被控制字符归一化吃掉，也不会与正常命令文本碰撞。 */
const DATA_TOKEN = '\uE000';

/** 这些程序会把参数/标准输入当**代码**执行（含 awk 的 system()）。 */
const EXEC_WORDS = 'bash|sh|zsh|dash|ksh|fish|ash|csh|tcsh|python[\\d.]*|node|nodejs|deno|bun'
  + '|perl|ruby|php|lua|awk|gawk|mawk|nawk|eval|source|xargs|watch|ssh';
const EXEC_CONTEXT_RE = new RegExp(
  // ① 命令位置上的解释器（可带 sudo/timeout 30/env -i VAR=x 这类前缀）
  '(?:^|[\\n\\r|;&`(]|\\$\\()\\s*'
  + CMD_PREFIX
  + '(?:' + EXEC_WORDS + ')\\b'
  // ② 解释器 + `-c`/`-e` + 引号：选项写在前面也不放过（`sudo -u root bash -c "…"`）
  + '|\\b(?:bash|sh|zsh|dash|ksh|fish|python[\\d.]*|node|nodejs|deno|bun|perl|ruby|php|lua)'
  + '\\s+(?:-\\S+\\s+)*-[a-zA-Z]*[ce]\\s*[\'"]'
  // ③ find -exec：把参数当命令执行
  + '|\\bfind\\b[^|;&]*-exec(?:dir)?\\b',
);

/** 命令里是否含"把内容喂给解释器"的包装。 */
function hasExecContext(normalized) {
  return EXEC_CONTEXT_RE.test(normalized);
}

/**
 * 代码视图：把数据（引号内文本、heredoc 体）替换成占位符；命令替换的内容会被执行，保留。
 * @param {string} raw 原始命令串（保留换行，heredoc 识别依赖行结构）
 */
function codeView(raw) {
  const subs = [];
  let s = raw.replace(/`([^`]*)`/g, (_, inner) => { subs.push(inner); return DATA_TOKEN; });
  s = s.replace(/\$\(([^()]*)\)/g, (_, inner) => { subs.push(inner); return DATA_TOKEN; });
  // heredoc 体：写进文件/喂给命令的内容。喂给解释器的情况已由 hasExecContext 走原文匹配。
  s = s.replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1(?=\s|$)/g, ` ${DATA_TOKEN} `);
  // 引号内是数据（双引号允许反斜杠转义）
  s = s.replace(/"(?:[^"\\]|\\.)*"/g, DATA_TOKEN);
  s = s.replace(/'[^']*'/g, DATA_TOKEN);
  return subs.length ? `${s}\n${subs.join('\n')}` : s;
}

/**
 * 去掉 shell 注释（`#` 出现在**词首**即注释，到行尾为止）。
 *
 * R0-122（压测语料暴露的真阳性）：`# TODO: 校验 rm -rf / 已被拦下` 此前被硬拦且无法覆盖 ——
 * 一个注释行把"写注释"变成了高危操作。
 *
 * 判定规则与 POSIX sh 一致：`#` 在行首、或在空白 / `;|&(` 之后，才是注释起点；
 * `echo a#b` 这种词中间的 `#` 不是。引号内的 `#` 也不是 —— 先用**等长填充**遮住引号内容
 * （等长是为了偏移量能对回原串；保留换行是为了行号能对上），再在遮罩上找注释起点。
 */
function stripCommentLines(raw) {
  if (!raw.includes('#')) return raw;
  const filler = (m) => m.replace(/[^\n]/g, 'x');
  const masked = raw
    .replace(/"(?:[^"\\]|\\.)*"/g, filler)
    .replace(/'[^']*'/g, filler);

  const srcLines = raw.split('\n');
  const maskLines = masked.split('\n');
  for (let i = 0; i < maskLines.length; i++) {
    const line = maskLines[i];
    for (let j = 0; j < line.length; j++) {
      if (line[j] !== '#') continue;
      const prev = j === 0 ? '\n' : line[j - 1];
      if (prev === '\n' || /[\s;&|(]/.test(prev)) {
        srcLines[i] = srcLines[i].slice(0, j);
        break;
      }
    }
  }
  return srcLines.join('\n');
}

/** 取匹配用的两个视图：喂解释器时按原文；否则按代码视图（引号里是数据）。 */
function views(rawSrc) {
  const raw = stripCommentLines(rawSrc);
  const normalized = raw.replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (hasExecContext(normalized)) return [raw, normalized];
  const code = codeView(raw);
  return [code, code.replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim()];
}

// ── 敏感路径读取 ──────────────────────────────────────────────────────
//
// 不能只列文件名：`cat ~/.tusunsun/config.json` 的文件名不敏感，敏感的是它落在哪个目录。
// 这里按命令的**路径参数**判断：展开 ~/$HOME，交给 sensitive-paths.js 追 realpath 后比对。
// 引号里的路径是参数而不是"数据"，所以按去引号后的 token 判；命令替换与 -c 包装递归判。

const READ_COMMANDS = new Set([
  'cat', 'tac', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'ag',
  'cp', 'mv', 'tar', 'zip', 'unzip', 'gzip', 'gunzip', 'zstd', 'base64', 'xxd', 'od',
  'strings', 'sed', 'awk', 'sort', 'uniq', 'diff', 'file', 'stat', 'ls', 'find', 'du',
  'wc', 'scp', 'rsync', 'install', 'ln',
]);
const EXEC_WRAPPERS = new Set([
  'bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'ash', 'csh', 'tcsh',
  'python', 'python3', 'node', 'nodejs', 'deno', 'bun', 'perl', 'ruby', 'php', 'lua',
  'awk', 'gawk', 'mawk', 'nawk',
]);
/** 第一个非选项参数是 pattern/script 而不是文件目标：`grep '~/.ssh' docs` 不该被当成读密钥。 */
const PATTERN_FIRST_COMMANDS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'sed', 'awk', 'gawk', 'mawk', 'nawk']);
const WRAPPER_WORDS = new Set(['sudo', 'doas', 'nohup', 'env', 'command', 'exec', 'builtin', 'timeout', 'nice', 'setsid']);
const WRAPPER_OPTS_WITH_VALUE = new Set([
  '-u', '-g', '-n', '-C', '-h', '-p', '-r', '-t', '--user', '--group', '--chdir', '--host', '--port', '--prompt',
]);
const SHELL_SEPARATORS = '|;&()';
const PATH_LITERAL_RE = /(?:~\/|\$\{HOME\}\/|\$HOME\/|\/)[^\s"'`;|&()<>]+/g;

/** 取命令名：`/bin/cat` 与 `\cat` 都归到 `cat`。 */
function commandName(token) {
  if (typeof token !== 'string' || !token) return '';
  return basename(token).replace(/^\\/, '');
}

/** 把一段 shell 文本切成"以分隔符为界"的 token 组；引号内的内容保持为一个 token。 */
function shellSegments(text) {
  const segments = [];
  let tokens = [];
  let cur = '';
  let inToken = false;
  let quote = null;
  const flushToken = () => { if (inToken) { tokens.push(cur); cur = ''; inToken = false; } };
  const flushSegment = () => { flushToken(); if (tokens.length) { segments.push(tokens); tokens = []; } };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      if (quote === '"' && ch === '\\' && i + 1 < text.length) { cur += text[++i]; inToken = true; continue; }
      cur += ch; inToken = true; continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; inToken = true; continue; }
    if (ch === '\\' && i + 1 < text.length) { cur += text[++i]; inToken = true; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { flushToken(); if (ch === '\n') flushSegment(); continue; }
    if (SHELL_SEPARATORS.includes(ch)) { flushSegment(); continue; }
    if (ch === '>' || ch === '<') { flushToken(); continue; }
    cur += ch; inToken = true;
  }
  flushSegment();
  return segments;
}

/** 跳过 sudo/timeout/env 一类前缀，返回命令 token 的下标。 */
function commandIndex(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (WRAPPER_WORDS.has(commandName(t))) { i++; continue; }
    if (t.startsWith('-')) { i += WRAPPER_OPTS_WITH_VALUE.has(t) ? 2 : 1; continue; }
    if (/^[A-Za-z_]\w*=/.test(t)) { i++; continue; }                 // env 的赋值
    if (/^\d+(?:\.\d+)?[smhd]?$/.test(t)) { i++; continue; }        // timeout 30
    break;
  }
  return i < tokens.length ? i : -1;
}

/** 读命令的**文件参数**从哪个 token 开始（跳过 grep/sed/awk 的 pattern/script）。 */
function pathScanStart(tokens, idx, cmd) {
  if (!PATTERN_FIRST_COMMANDS.has(cmd)) return idx + 1;
  let j = idx + 1;
  let hasPatternOpt = false;
  for (; j < tokens.length; j++) {
    const t = tokens[j];
    if (t === '--') { j++; break; }
    if (!t.startsWith('-')) break;
    if (/^--?(?:[a-zA-Z]*[ef]|[ef])$/.test(t)) hasPatternOpt = true;
  }
  if (hasPatternOpt) return j;
  return j < tokens.length ? j + 1 : j;
}

/** 检查某个命令位置上的读类命令，看它后面的路径参数是否命中。 */
function scanCommandAt(tokens, idx, opts, depth) {
  const cmd = commandName(tokens[idx]);
  if (!cmd) return null;
  if (cmd === 'eval') return scanSensitiveText(tokens.slice(idx + 1).join(' '), opts, depth + 1);
  if (EXEC_WRAPPERS.has(cmd)) {
    for (let j = idx + 1; j < tokens.length - 1; j++) {
      if (/^-[a-zA-Z]*[ce]$/.test(tokens[j])) return scanSensitiveText(tokens[j + 1], opts, depth + 1);
    }
    // awk 同时是解释器与读文件命令：没有 -c/-e 时仍要检查它后面的文件参数。
    if (!READ_COMMANDS.has(cmd)) return null;
  }
  if (!READ_COMMANDS.has(cmd)) return null;
  for (let j = pathScanStart(tokens, idx, cmd); j < tokens.length; j++) {
    const token = tokens[j];
    if (!token || token.startsWith('-')) continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) continue;
    const rule = sensitivePathOf(token, opts);
    if (rule) return { path: token, rule };
  }
  return null;
}

function scanSegment(tokens, opts, depth) {
  const idx = commandIndex(tokens);
  if (idx < 0) return null;
  const cmd = commandName(tokens[idx]);
  if (cmd === 'xargs') {
    let j = idx + 1;
    while (j < tokens.length && tokens[j].startsWith('-')) j++;
    return j < tokens.length ? scanCommandAt(tokens, j, opts, depth) : null;
  }
  if (cmd === 'find') {
    const rootHit = scanCommandAt(tokens, idx, opts, depth);
    if (rootHit) return rootHit;
    const exec = tokens.findIndex((t) => t === '-exec' || t === '-execdir');
    return (exec >= 0 && exec + 1 < tokens.length) ? scanCommandAt(tokens, exec + 1, opts, depth) : null;
  }
  return scanCommandAt(tokens, idx, opts, depth);
}

/** 代码包装里的绝对路径字面量：`python -c 'open("/etc/passwd")'` 按参数判不出来。 */
function scanPathLiterals(text, opts) {
  for (const m of text.matchAll(PATH_LITERAL_RE)) {
    const candidate = m[0];
    if (candidate.length < 2) continue;
    const rule = sensitivePathOf(candidate, opts);
    if (rule) return { path: candidate, rule };
  }
  return null;
}

function scanSensitiveText(text, opts, depth) {
  if (depth > 4) return null;   // 递归上限：防止病态命令把判据变成 CPU 热点
  const nested = [];
  const flat = text
    .replace(/`([^`]*)`/g, (_, inner) => { nested.push(inner); return ' '; })
    .replace(/\$\(([^()]*)\)/g, (_, inner) => { nested.push(inner); return ' '; });
  for (const inner of nested) {
    const hit = scanSensitiveText(inner, opts, depth + 1);
    if (hit) return hit;
  }
  for (const tokens of shellSegments(flat)) {
    const hit = scanSegment(tokens, opts, depth);
    if (hit) return hit;
  }
  const normalized = flat.replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (depth > 0 || hasExecContext(normalized)) {
    const hit = scanPathLiterals(flat, opts);
    if (hit) return hit;
  }
  return null;
}

/**
 * 读类命令是否触碰敏感路径。
 * @param {unknown} cmd
 * @param {{cwd?: string}} [opts]
 * @returns {{why: string, pattern: string} | null}
 */
export function matchSensitiveRead(cmd, opts = {}) {
  if (typeof cmd !== 'string' || !cmd) return null;
  // 同一条命令里上万个参数共用一份解析结果（缓存语义见 sensitive-paths 的 pathCache）。
  const cache = opts.cache || pathCache();
  try {
    const hit = scanSensitiveText(stripCommentLines(cmd), { ...opts, cache }, 0);
    return hit ? { why: `读取敏感路径（${hit.rule}）`, pattern: `sensitive-path:${hit.rule}` } : null;
  } catch (err) {
    // 判据自己坏了也必须拒绝（fail-closed）：放行一条无法判定的读取，比误拦更糟。
    return { why: `无法判定命令的路径目标（${err?.message || err}），拒绝`, pattern: 'sensitive-path:indeterminate' };
  }
}

/**
 * 检查命令串是否命中破坏性模式。
 * @param {unknown} cmd
 * @param {{cwd?: string}} [opts]
 * @returns {{why: string, pattern: string} | null}
 */
export function matchDangerousCommand(cmd, opts = {}) {
  if (typeof cmd !== 'string' || !cmd) return null;
  // 归一化：折叠空白与控制字符，避免 `cat  /etc/passwd`（多空格）或换行绕过
  const [a, b] = views(cmd);
  for (const { re, why } of DANGEROUS_COMMAND_PATTERNS) {
    if (re.test(a) || re.test(b)) return { why, pattern: String(re) };
  }
  const sensitive = matchSensitiveRead(cmd, opts);
  if (sensitive) return sensitive;
  return null;
}

// ── 不可恢复操作（软闸判据）────────────────────────────────────────────
//
// 与上面 `DANGEROUS_COMMAND_PATTERNS` 的分工，务必分清：
//   · 上面那一组是**硬拦**：命中即拒绝，没有商量余地（读系统凭据、外联、写块设备……）。
//   · 这一组是**软闸**：命中不拒绝，只要求调用方**先陈述影响面、再复述实测值**。
//
// 为什么需要软闸：硬拦只覆盖 `rm -rf` 这类"一看就炸"的形态。实测（0.9.11）下列命令
// **一条都不命中**，却都能让重要内容消失：
//   `rm -r src/核心模块` / `rm *.js` / `find . -name '*.ts' -delete` / `git reset --hard`
//    `git clean -fdx` / `truncate -s 0 app.log` / `shred secrets.txt` / `: > main.js`
// 这些是"日常操作"，把它们一律硬拦会让内核不可用；但它们同样不可撤销。
// 所以判据不是"拦不拦"，而是"动手前有没有把范围算清楚"。

/** 删除/覆盖类不可恢复操作。`measure` 决定能否静态估算影响面。 */
export const IRREVERSIBLE_PATTERNS = [
  // 递归删除（不含 -rf/--force --recursive：那是硬拦，到不了这里）
  { id: 'rm-recursive', re: new RegExp(String.raw`\brm\s+${RM_FLAGS}${RM_RECURSIVE}\b`), why: '递归删除目录' },
  // 删除 + 通配符：范围在命令里看不出来，必须展开才知道
  { id: 'rm-wildcard', re: new RegExp(String.raw`\brm\s+${RM_FLAGS}[^\s|;&]*(?:\*|\?|\[)[^\s|;&]*`), why: '通配符删除（范围须展开才知道）' },
  // 直接删文件（非递归）——只删一个文件，但仍不可恢复（tool-rm 进回收站，bash 不进）
  { id: 'rm-file', re: new RegExp(String.raw`\brm\s+${RM_FLAGS}[^\s|;&-][^\s|;&]*`), why: '删除文件（不经回收站）' },
  // 直接删单个文件（unlink）：与 `rm <file>` 语义相同，都不经回收站。
  // R0-122（压测语料暴露的真阳性）：extractDeleteTargets 早就把 unlink 算进目标抽取，
  // 判据本身却漏了它 —— `rm -f a.js` 要确认、`unlink a.js` 直接放行，同一个动作两种待遇。
  { id: 'unlink', re: /\bunlink\s+[^\s|;&-][^\s|;&]*/, why: '删除文件（unlink，不经回收站）' },
  // find -delete / -exec rm
  { id: 'find-delete', re: /\bfind\b[^|;&]*\s-delete\b/, why: 'find -delete 批量删除' },
  { id: 'find-exec-rm', re: /\bfind\b[^|;&]*-exec(?:dir)?\s+(?:rm|shred)\b/, why: 'find -exec rm 批量删除' },
  // xargs rm
  { id: 'xargs-rm', re: /\bxargs\b[^|;&]*\b(?:rm|shred)\b/, why: 'xargs 批量删除' },
  // shred（连恢复都不可能）
  { id: 'shred', re: /\bshred\b/, why: '粉碎文件（不可恢复）' },
  // 截断。R0-121：不只 `-s 0` —— `truncate -s 100 app.log` 把 1KB 文件砍到 100 字节，
  // 砍掉的部分同样不可恢复；`-s +N` 是追加（只增不减），不在此列。
  { id: 'truncate', re: /\btruncate\s+[^|;&]*-s\s*\d/, why: '截断/收缩文件（被砍掉的内容不可恢复）' },
  // 覆盖重定向：一个 `>`（含 `2>` 数字前缀、`>|` 强制覆盖）不是 `>>`、`>&`，且确实带目标
  // ⇒ 目标文件原内容被清空。R0-121：此前不认 `2>`/`>|`，`echo x 2> main.js` 这类覆盖静默漏网。
  // 注：`if [ $x > 5 ]` 这类写法在 POSIX sh 里**就是**重定向，故误报可接受（软闸只多一轮确认）。
  { id: 'clobber', re: /(?:^|[\s\d])>(?!>)\s*\|?\s*[^\s|;&]/, why: '重定向覆盖文件（原内容清空）' },
  // git 破坏性操作
  { id: 'git-reset-hard', re: /\bgit\s+reset\s[^|;&]*--hard\b/, why: 'git reset --hard（丢弃未提交改动）' },
  { id: 'git-clean', re: /\bgit\s+clean\s[^|;&]*-[a-zA-Z]*[fdx]/, why: 'git clean（删除未跟踪文件）' },
  // R0-121：`git checkout -- <路径>` / `git checkout <ref> -- <路径>` 同样丢弃工作区改动，
  // 此前只有 `git checkout .` 一个形态被认出，单文件丢弃完全漏网。
  { id: 'git-checkout-path', re: /\bgit\s+checkout\s[^|;&]*--\s+[^\s|;&]+/, why: 'git checkout -- <路径>（丢弃该路径的工作区改动）' },
  { id: 'git-checkout-dot', re: /\bgit\s+checkout\s(?:--\s+)?\.\s*(?:$|[|;&])/, why: 'git checkout . （丢弃工作区改动）' },
  { id: 'git-restore', re: /\bgit\s+restore\s(?!.*--staged)[^|;&]*/, why: 'git restore（丢弃改动）' },
];

/**
 * 归类一条命令的不可恢复操作（软闸）。
 * 与 `matchDangerousCommand` 互斥使用：硬拦先跑，命中就不必问软问题。
 *
 * @param {unknown} cmd
 * @returns {{id: string, why: string, pattern: string} | null}
 */
export function classifyIrreversible(cmd) {
  if (typeof cmd !== 'string' || !cmd) return null;
  // 与硬拦同一套"数据 vs 代码"口径：`git commit -m "rm -r src"` 是文本，不该触发影响面确认；
  // 目标抽取（extractDeleteTargets）仍读原文 —— 分类看是不是破坏性动作，测量看真实目标。
  const [a, b] = views(cmd);
  for (const { id, re, why } of IRREVERSIBLE_PATTERNS) {
    if (re.test(a) || re.test(b)) return { id, why, pattern: String(re) };
  }
  return null;
}

/**
 * 从命令串里**静态**抽出可能的删除/覆盖目标（不执行、不展开通配符）。
 * 返回 `{ targets, wildcard }`：`wildcard` 为真表示范围在命令文本里看不全。
 *
 * 保守：解析不出来就返回空 targets + wildcard=true —— 让软闸退化成"你自己说范围"，
 * 而不是假装算过。
 *
 * R0-121（复查发现的真阳性）：原实现各命令族**互相覆盖** `rest`，只留最后一个匹配：
 *   `rm -r d1 && truncate -s 0 a.js` 只测到 a.js（实测 d1 里 16 个文件全部漏报）；
 *   `rm a.js && rm b.js` 只测到 a.js；`echo x > main.js` 的重定向目标**从不提取**，
 *   实测报"0 个文件"，挑战却要求模型复述 0 —— 闸门在给假数字背书。
 * 现在逐段收集所有匹配再合并去重，并补上重定向目标。
 *
 * @param {unknown} cmd
 * @returns {{targets: string[], wildcard: boolean}}
 */
export function extractDeleteTargets(cmd) {
  const empty = { targets: [], wildcard: true };
  if (typeof cmd !== 'string' || !cmd) return empty;
  const normalized = cmd.replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();

  const pieces = [];
  // rm / shred / unlink：所有出现处（不只第一处）
  for (const m of normalized.matchAll(/\b(?:rm|shred|unlink)\s+((?:[^\s|;&]+\s*)+)/g)) pieces.push(m[1]);
  // truncate：所有出现处
  for (const m of normalized.matchAll(/\btruncate\s+((?:[^\s|;&]+\s*)+)/g)) pieces.push(m[1]);
  // find：取起始路径（第一个非选项词），find 的范围由 -path/-name 决定，靠 wildcard 标记
  const find = normalized.match(/\bfind\s+([^\s|;&]+)/);
  if (find && find[1] && !find[1].startsWith('-')) pieces.push(find[1]);
  // 覆盖重定向目标：`> f` / `2> f` / `>| f`（`>>`/`>&` 不清空，见 classify 的 clobber 判据）
  for (const m of normalized.matchAll(/(?:^|[\s\d])>(?!>)\s*\|?\s*([^\s|;&]+)/g)) pieces.push(m[1]);

  if (pieces.length === 0) return empty;
  const tokens = [];
  const seen = new Set();
  for (const piece of pieces) {
    for (let t of piece.split(/\s+/)) {
      if (!t || t.startsWith('-')) continue;      // 选项不是路径
      if (/^\d+$/.test(t)) continue;              // `rm -f x` 里的数字是选项值，不是路径
      // R0-121（复查真阳性）：配对的引号必须剥掉 —— 否则 `rm -r "src/core"` 会去 stat
      // `<ws>/"src/core"` 得到 0 个文件，闸门给模型一个假数字背书。
      const q = t[0];
      if (t.length >= 2 && (q === '"' || q === "'") && t.endsWith(q)) t = t.slice(1, -1);
      if (!t) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      tokens.push(t);
    }
  }
  if (tokens.length === 0) return empty;

  const wildcard = tokens.some((t) => /[*?[]/.test(t)) || /\bfind\b/.test(normalized);
  return { targets: tokens, wildcard };
}
