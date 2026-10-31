#!/usr/bin/env node
// 发行物依赖口径检查（TSS S2 / Base Gate 第 9 条）
// 依据：docs/plans/土行孙生产基座治理计划-2026-09.md §4.4（核心约束必须机器可检查）
//
// === 这份门禁在 v0.9.25 前后的语义变化（必读，否则会误读它的"覆盖范围"）===
//
// v0.9.24 及以前：它扫的是 `src/`（`core/` + `builtin/`），因为当时"要不要零外部依赖"
//   是靠**文件在哪个目录**隐式承载的——`src/` 里零依赖，`plugins/` 里随便用。
//   那是一个看不见的约定：把文件挪个目录，约束就悄悄变了。
//
// v0.9.25：`plugins/` 已合并进 `plugins/`，`src/` 只剩 `core/` + `bootstrap/`。
//   于是约束被拆成**两条互相独立**、各自有明确语义的口径：
//
//   ① `src/` 名单制 —— 这里的每一个 js/mjs 都必须显式登记在 `ZERO_DEP_FILES` 里。
//      没登记的**直接 FAIL**（哪怕它今天恰好零依赖），因为"这个文件算不算核心"
//      必须是一个被回答过的问题，而不是随目录继承的默认值。
//   ② `plugins/` 全量制 —— 随包发布的插件面（含 `tools/` 与 `_lib/`）必须**整体**零外部依赖。
//      这是对用户的承诺：`npm install` 之后没有依赖树，离线可跑，供应链面为 0。
//      第三方**自己**加的插件目录（`data/plugin-dirs.json` 的 `extra`）不受此约束——
//      它们不是我们发的东西，无从约束也不该约束。
//
//   两条之外还有一条兜底：`package.json` 的 `dependencies` 必须为空。
//   ①②都过、但 `dependencies` 非空是可能的（依赖只在 test/ 用），那同样违背"零依赖可跑"的
//   对外说明，所以单独判一次。
//
// 为什么不能只留①：`plugins/` 有 ~40 个文件、还会长，逐个登记成 40 行名单只是把
//   `PUBLISHED_PLUGINS`（R0-65/E5 已有）抄第二遍，两份同义名单必然漂移。
//   ① 的名单规模（9 个）小到可以人肉维护，② 的口径（"整棵树零外部依赖"）不需要名单。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_MAX_LINES } from './core-limits.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const srcDir = join(root, '..', 'src');
const pluginsDir = join(root, '..', 'plugins');
const pkgPath = join(root, '..', 'package.json');
const IMPORT_RE = /from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * 判定捕获到的字符串**是不是模块说明符**。
 *
 * 为什么需要这一层：`IMPORT_RE` 里的 `from\s+['"]...['"]` 是**宽匹配**，散文里的
 * `from` 也会命中。v0.9.25 把扫描面从 `src/` 扩到 `plugins/` 后立刻踩到两处：
 *   · `plugins/_lib/context/providers/local-manifest.js`
 *     `distinguishable from "nothing allowed")`
 *   · `plugins/experience-port.js`
 *     `distinguishable from "no provider configured")`
 * 两处都被报成"引入了叫 `nothing allowed` 的外部包"。
 *
 * 这不是新 bug，是**一直存在、只是没被触发**的
 * ——旧扫描面 `src/` 恰好没有这种散文。门禁误报比漏报更危险：它教人绕过门禁。
 *
 * 判据取"模块说明符**不含空白**"：`import x from './a.js'`/`from '@s/p'` 都成立，
 * 而上面两句散文都含空格。这条规则简单、稳定，且不依赖 `from` 前面长什么样
 * （多行 `import {\n a,\n} from './x.js'` 的前缀各不相同，没法用前缀判）。
 */
function isModuleSpecifier(spec) {
  return typeof spec === 'string' && spec.length > 0 && !/\s/.test(spec);
}

// 核心运行时允许的外部依赖白名单（上限 3 见治理计划 §4.4）。
// R0-117：ws 改为**随仓内置**（vendor/ws），`src/` 里对它的引用变成相对路径
// （不是外部包说明符），因此白名单清空 —— 现在这一条的含义升级为
// "一个 npm 包都不引，全部只用 node: 内置"。
// 内置副本本身仍是第三方代码，其体积/许可/完整性由 scripts/verify-vendor.mjs 单独管。
const ALLOWED = new Set();
const MAX_CORE_DEPS = 3;

/**
 * 受"零外部依赖"约束的**显式文件清单**（相对 `src/`）。
 *
 * 名单是快照，不是愿望——它记录的是"截至目前确实零外部依赖的内核文件"。
 * 新增文件不进名单 = 本脚本 FAIL，于是"要不要给它零依赖待遇"变成一个必须被回答的问题。
 *
 * 维护方式：新增 `src/` 下文件时把它加进来（若它确实只用 node: 内置）；
 * 若它需要第三方包，则**不要**加进来，并在此处说明为什么它不受该约束
 * （目前 `src/` 里没有这样的文件，9/9 全在名单内）。
 */
const ZERO_DEP_FILES = new Set([
  'core/core.js', 'core/dependency-resolver.js', 'core/env.js', 'core/json5-loader.js',
  'core/lifecycle-manager.js', 'core/plugin-manager.js', 'core/plugin-meta.js',
  'core/scene-controller.js',
  'bootstrap/cli.js',
]);

function* walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    const s = statSync(p);
    if (s.isDirectory()) yield* walk(p);
    else if (/\.(js|mjs)$/.test(f)) yield p;
  }
}

/** 收集一个目录树里的外部包引用与体积统计。`base` 用于把绝对路径转成相对展示名。 */
function scan(dir, base) {
  const externals = new Map();
  const seenFiles = new Set();
  let fileCount = 0;
  let lineCount = 0;
  for (const file of walk(dir)) {
    fileCount++;
    const rel = file.replace(dir + '/', '').replace(/\\/g, '/');
    seenFiles.add(rel);
    const src = readFileSync(file, 'utf8');
    // 口径：`split('\n').length`（= 换行数 + 1），与 `scripts/core-limits.mjs` 钉死的
    // **官方门禁口径**一致（`scripts/line-check.js` 用的就是它）。
    // 此处此前用 `match(/\n/g).length`（纯换行数），于是同一个 `src/` 在本脚本里报 2426、
    // 官方口径下是 2435，文档里又写成 2428 —— 三个数并存。
    // 本行数字只是"体积参考，非门禁"，但**同一棵树在同一仓里有两个行数**本身就会误导：
    // 拿它去核对文档，只会得到"文档错了"或"门禁错了"，而真正错的是口径。
    lineCount += src.split('\n').length;
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1] || m[2] || m[3];
      if (!spec || !isModuleSpecifier(spec)) continue;
      if (spec.startsWith('node:') || spec.startsWith('.') || spec.startsWith('/')) continue;
      const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (!externals.has(pkg)) externals.set(pkg, new Set());
      externals.get(pkg).add(`${base}${rel}`);
    }
  }
  return { externals, seenFiles, fileCount, lineCount };
}

const srcScan = scan(srcDir, '');
const pluginScan = scan(pluginsDir, 'plugins/');

// 名单制：src/ 下的每个 js/mjs 都必须被显式归类，否则名单制退化成装饰。
const unclassified = [...srcScan.seenFiles].filter((f) => !ZERO_DEP_FILES.has(f)).sort();
const missing = [...ZERO_DEP_FILES].filter((f) => !srcScan.seenFiles.has(f)).sort();

// 两条口径的外部依赖合并判：src/ 与 plugins/ 任一出现外部包都 FAIL。
const externals = new Map([...srcScan.externals, ...pluginScan.externals]);
const unexpected = [...externals.keys()].filter((p) => !ALLOWED.has(p));

// package.json 兜底：对外说的是"零依赖可跑"，依赖树不在 tgz 里也不能在 manifest 里。
let declaredDeps = null;
try {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  declaredDeps = Object.keys(pkg.dependencies || {});
} catch (err) {
  console.log(`  package.json 不可读：${err.message}`);
}

console.log('=== 发行物依赖口径检查 ===');
console.log('  口径①：src/ 名单制（内核 + 装配层，每个文件须显式登记）');
console.log('  口径②：plugins/ 全量制（随包发布的插件面，整体零外部依赖）');
// 名单漂移先报出来：这两类问题与"有没有外部包"无关，但同样必须 FAIL。
if (unclassified.length) {
  console.log(`  未归类文件 ${unclassified.length} 个（须显式加入 ZERO_DEP_FILES 或说明为何不受约束）：`);
  for (const f of unclassified) console.log(`    ${f}`);
}
if (missing.length) {
  console.log(`  名单中已不存在的文件 ${missing.length} 个（名单过期，须清理）：`);
  for (const f of missing) console.log(`    ${f}`);
}
console.log('');
console.log(`  src/      : ${srcScan.fileCount} 个文件，${srcScan.lineCount} 行`
  + `（体积参考，非门禁；src/core 行数门禁 ${CORE_MAX_LINES} 见 npm run check）`);
console.log(`  plugins/  : ${pluginScan.fileCount} 个文件，${pluginScan.lineCount} 行（体积参考，非门禁）`);
console.log(`  受零依赖约束的文件: ${ZERO_DEP_FILES.size} 个（显式名单，覆盖 src/ 全部 ${srcScan.seenFiles.size} 个 js/mjs）`);

const ok = unexpected.length === 0 && externals.size <= MAX_CORE_DEPS
  && unclassified.length === 0 && missing.length === 0
  && declaredDeps !== null && declaredDeps.length === 0;

if (ok) {
  console.log(`外部依赖: ${externals.size}/${MAX_CORE_DEPS} 个${externals.size ? `（${[...externals.keys()].join(', ')}，均在白名单）` : '（src/ 与 plugins/ 合计）'}`);
  console.log(`package.json dependencies: 0 个${declaredDeps.length === 0 ? '（与零依赖承诺一致）' : ''}`);
  try {
    const pin = JSON.parse(readFileSync(join(root, '..', 'vendor', 'ws', 'package.json'), 'utf8'));
    console.log(`内置第三方: 1 个（ws@${pin.version}，vendor/ws，完整性见 npm run check:vendor）`);
  } catch {
    console.log('内置第三方: vendor/ws 缺失或不可读');
  }
  console.log('发行物依赖口径 OK');
  process.exit(0);
}
console.log('发行物依赖口径 FAIL：');
for (const pkg of unexpected) {
  console.log(`  非白名单依赖 ${pkg} <- ${[...externals.get(pkg)].join(', ')}`);
}
if (externals.size > MAX_CORE_DEPS) {
  console.log(`  外部依赖总数 ${externals.size} 超过上限 ${MAX_CORE_DEPS}`);
}
if (declaredDeps && declaredDeps.length) {
  console.log(`  package.json 声明了 ${declaredDeps.length} 个依赖：${declaredDeps.join(', ')}`);
  console.log('  对外说明是"零依赖、离线可跑"，声明的依赖会改变 npm install 的实际行为。');
}
console.log('\n如确需引入外部包，须先修订口径文档（治理计划 §4.4）并评审。');
process.exit(1);
