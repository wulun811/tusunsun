// 敏感路径判据的**单一真相**：workspace 的工作区校验、bash 命令判据、文件护栏共用。
//
// 为什么必须只有一份：三处各自维护名单时，覆盖范围互不相同 —— 同一份密钥在"声明工作区"
// 处被拦、在"读文件"处放行，等于没有判据；名单越分叉，漏判越取决于调用方。
//
// 判定口径：
//   · 目录规则按**路径段**判断（`/etc` 命中 `/etc/passwd`，不命中 `/etcfoo`）；
//   · 先做物理归一化（realpath + 最近存在的祖先）再比，符号链接指向敏感目录同样命中；
//   · `~`、`$HOME`、`${HOME}` 在这里展开，调用方不必自己拼绝对路径；
//   · 相对路径按调用方给的 `cwd` 解析（默认 `process.cwd()`）。
//
// 边界（诚实）：这是"别把密钥/系统目录当工作区或读出来"的判据，不是 OS 沙箱；
// 同一账户的本地进程仍可绕过（TOCTOU、直接系统调用）。
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** 目录规则：命中该目录及其全部子孙。 */
const DIRECTORY_RULES = Object.freeze([
  // 密钥/凭据目录
  '~/.ssh', '~/.aws', '~/.kube', '~/.gnupg', '~/.tusunsun',
  '~/.config/gcloud', '~/.azure', '~/.docker',
  '~/.local/share/keyrings',
  '~/.config/helm', '~/.terraform.d',
  // 浏览器数据
  '~/.config/google-chrome', '~/.config/chromium', '~/.mozilla',
  // 系统与进程伪文件系统
  '/etc', '/proc', '/sys', '/boot', '/root', '/var/log', '/dev',
]);

/** 单文件规则：只命中文件本身（以及同名路径段下的子路径，若它其实是个目录）。 */
const FILE_RULES = Object.freeze([
  '~/.vault-token', '~/.npmrc', '~/.pypirc', '~/.git-credentials',
  '~/.cargo/credentials', '~/.netrc', '~/.bashrc', '~/.zshrc', '~/.profile',
]);

/** 按文件名命中：项目里的 `.env` 不随工作区改名。 */
const NAME_RULES = Object.freeze(['.env', '.env.local', '.env.production']);

/** 按路径后缀命中：`.git/config` 可以出现在任意工作区。 */
const SUFFIX_RULES = Object.freeze(['.git/config']);

/** 展开 `~` / `$HOME`；相对规则保持原样，由 `sensitivePathOf` 按名字/后缀处理。 */
function expandRule(rule) {
  let p = String(rule).trim();
  if (!p) return '';
  p = p.replace(/\$\{HOME\}/g, homedir()).replace(/\$HOME\b/g, homedir());
  if (p === '~') return homedir();
  if (p.startsWith('~/')) p = join(homedir(), p.slice(2));
  return p;
}

/** 绝对路径规则（默认名单与自定义绝对规则共用）。 */
export const SENSITIVE_PATHS = Object.freeze(
  [...DIRECTORY_RULES, ...FILE_RULES].map(expandRule).filter(Boolean),
);

// 默认 `agent.workDir` 是 `~/.tusunsun/workspace`：它是工作区，不是凭据目录。
// 不豁免它，该目录下的相对路径读取（`cat README.md`）会被祖先规则整体误伤；
// 凭据文件（`~/.tusunsun/config.json`）不在这个子树里，仍按原规则拒绝。
const EXEMPT_SUBTREES = Object.freeze(['~/.tusunsun/workspace'].map(expandRule));

/** 默认名单的物理形态在模块加载时算一次；判据本身仍会实时追真实路径。 */
const SENSITIVE_PHYSICAL = SENSITIVE_PATHS.map((p) => physicalPath(p));
const EXEMPT_PHYSICAL = EXEMPT_SUBTREES.map((p) => physicalPath(p));

/**
 * 一次判定内的路径解析缓存。判据对每个路径参数追一次 `realpath`，而 `find -name x -name x …`
 * 有上万个参数：24k 字符要 343ms，它却跑在**每次工具调用**的热路径上。
 * 作用域压到"一次判定"而非模块级 —— 跨调用缓存会把"后来才建的符号链接"永久判成不存在。
 * `dir` 存真目录的 realpath，`file` 存完整路径（含借祖先拼回的尾段），两者不可混用。
 */
export function pathCache() {
  return { file: new Map(), dir: new Map(), verdict: new Map() };
}

/** `realpath` + 最近存在祖先：路径不存在时也要得到"将来会落在哪里"的真实路径。 */
function physicalPath(lexical, cache) {
  let cur = lexical;
  const tail = [];
  for (;;) {
    if (tail.length === 0 && cache?.file?.has(cur)) return cache.file.get(cur);
    const cachedDir = cache?.dir?.get(cur);
    if (cachedDir !== undefined) {
      const out = tail.length ? join(cachedDir, ...tail) : cachedDir;
      cache?.file?.set(lexical, out);
      return out;
    }
    try {
      const real = realpathSync(cur);
      const out = tail.length ? join(real, ...tail) : real;
      cache?.dir?.set(cur, real);
      cache?.file?.set(lexical, out);
      return out;
    } catch (err) {
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') return lexical;
      const parent = dirname(cur);
      if (parent === cur) return lexical;
      tail.unshift(basename(cur));
      cur = parent;
    }
  }
}

/** 路径段包含判断（不是字符串前缀：`/etcfoo` 不在 `/etc` 里）。 */
function isInside(root, target) {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function normalizePath(raw, cwd) {
  let p = String(raw).trim();
  if (!p) return null;
  p = p.replace(/\$\{HOME\}/g, homedir()).replace(/\$HOME\b/g, homedir());
  if (p === '~') p = homedir();
  else if (p.startsWith('~/')) p = join(homedir(), p.slice(2));
  return resolve(cwd, p);
}

function matchAbsolute(rule, lexical, real, cwd, cache) {
  const expanded = expandRule(rule);
  if (!expanded || !isAbsolute(expanded)) return null;
  const ruleLex = normalizePath(expanded, cwd);
  if (!ruleLex) return null;
  const ruleReal = physicalPath(ruleLex, cache);
  return (isInside(ruleLex, lexical) || isInside(ruleReal, real)) ? rule : null;
}

function matchRelative(rule, lexical, real) {
  if (rule.includes('/')) {
    const suffix = rule.replace(/^\/+|\/+$/g, '');
    if (!suffix) return null;
    return (lexical === suffix || lexical.endsWith(sep + suffix)
      || real === suffix || real.endsWith(sep + suffix)) ? rule : null;
  }
  return (lexical.split(sep).includes(rule) || real.split(sep).includes(rule)) ? rule : null;
}

/**
 * 路径是否命中敏感名单；命中时返回**命中的规则**（用于拒绝文案），否则 null。
 *
 * @param {unknown} raw 用户给的路径（可带 `~` / `$HOME`，可相对）
 * @param {{cwd?:string, roots?:string[], realpath?:boolean}} [opts]
 *        `roots` 覆盖默认名单（供可配置的护栏使用；相对规则按名字/后缀处理）。
 * @returns {string|null}
 */
export function sensitivePathOf(raw, opts = {}) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const cwd = typeof opts.cwd === 'string' && opts.cwd ? opts.cwd : process.cwd();
  // 同一条命令里会出现大量**完全重复**的路径参数（`find -name x -name x …`）。
  // 判定是纯函数（同一 raw + 同一 cwd + 同一名单 ⇒ 同一结论），所以一次判定内可安全复用。
  // 键必须含**所有影响结论的因子**。修前注释写着“键带上 cwd 与 roots 身份”，实际只有
  // cwd + realpath + raw —— `roots` 不在键里。实测：同一 cache 下先以 roots=['/tmp'] 判一次，
  // 再以 roots=['/var'] 判同一个 raw，第二次直接命中第一次的结论（串味）。
  // 当时唯一传 roots 的调用方每次新建 opts、不复用 cache，所以不可达；但那是调用方的巧合，
  // 不是判据的保证。
  const memo = opts.cache?.verdict;
  const rootsKey = Array.isArray(opts.roots) ? opts.roots.join('\u0001') : '';
  const key = memo
    ? `${cwd}\u0000${opts.realpath === false ? 'l' : 'p'}\u0000${rootsKey}\u0000${raw}`
    : null;
  if (memo && memo.has(key)) return memo.get(key);
  const answer = sensitivePathOfUncached(raw, opts, cwd);
  if (memo) memo.set(key, answer);
  return answer;
}

function sensitivePathOfUncached(raw, opts, cwd) {
  const lexical = normalizePath(raw, cwd);
  if (!lexical) return null;
  const real = opts.realpath === false ? lexical : physicalPath(lexical, opts.cache);

  if (Array.isArray(opts.roots)) {
    for (const rule of opts.roots) {
      if (typeof rule !== 'string' || !rule.trim()) continue;
      const expanded = expandRule(rule);
      const hit = isAbsolute(expanded)
        ? matchAbsolute(rule, lexical, real, cwd, opts.cache)
        : matchRelative(expanded, lexical, real);
      if (hit) return rule;
    }
    return null;
  }

  // 豁免判断同时看词法路径与真实路径：symlink 从工作区指到 config.json 时不豁免。
  const exempted = EXEMPT_SUBTREES.some((root, i) => isInside(root, lexical) && isInside(EXEMPT_PHYSICAL[i], real));
  if (!exempted) {
    for (let i = 0; i < SENSITIVE_PATHS.length; i++) {
      const rule = SENSITIVE_PATHS[i];
      if (isInside(rule, lexical) || isInside(SENSITIVE_PHYSICAL[i], real)) return rule;
    }
  }
  const name = basename(lexical);
  if (NAME_RULES.includes(name) || NAME_RULES.includes(basename(real))) return name;
  for (const suffix of SUFFIX_RULES) {
    if (lexical === suffix || lexical.endsWith(sep + suffix)
      || real === suffix || real.endsWith(sep + suffix)) return suffix;
  }
  return null;
}

/** 布尔便捷入口；拒绝文案需要命中规则时用 `sensitivePathOf`。 */
export function isSensitivePath(raw, opts = {}) {
  return sensitivePathOf(raw, opts) !== null;
}
