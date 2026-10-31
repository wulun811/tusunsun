#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_MAX_LINES, CORE_MAX_BYTES, MODULE_BUDGET, MODULE_BUDGET_TOTAL } from './core-limits.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const coreDir = join(__dirname, '..', 'src', 'core');

// 上限单一真相：scripts/core-limits.mjs（2026-10-14 由 2000 放宽到 2500）
const MAX_TOTAL = CORE_MAX_LINES;
// R0-108/D5（2026-10-18）：模块预算与合计上限一律从 core-limits.mjs 取。
// 此前这里写死 157/180/185 + 合计 510，而 157+180+185 = 522 > 510 —— 配置自相矛盾。
const MODULES = MODULE_BUDGET;
const MAX_MODULES_TOTAL = MODULE_BUDGET_TOTAL;

let totalLines = 0;
let totalBytes = 0;
let modulesTotal = 0;

// **扩展名白名单**：`src/core/` 只允许这三种源码扩展名。
//
// 旧实现只认 `.js`（`f.endsWith('.js')`）。新增一个 `.cjs` 就同时绕过了三处判据：
// 行数预算、注释棘轮、逐文件指纹——它们都用 `endsWith('.js')` 过滤。
// 于是那个文件在**三处都不存在**，而 Node 照样能 `import` 它并执行。
// 这不是理论问题：一个 2,601 行的 `.cjs` 实测可以带着 `npm run check` 全绿跑起来。
const SOURCE_EXT = /\.(?:[cm]?js)$/;
const allEntries = readdirSync(coreDir);
const files = allEntries.filter(f => SOURCE_EXT.test(f));
const foreign = allEntries.filter(f => !SOURCE_EXT.test(f) && !f.startsWith('.'));

// R0-117：横幅版本号此前写死 0.9.7，连发 3 个版本都没跟 ⇒ 改为读 package.json（单一真相）。
const PKG_VERSION = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version;
console.log(`=== 土行孙 v${PKG_VERSION} Line Budget Check ===\n`);

// v0.9.26：单模块超预算此前只打印 `[WARN]`，**不影响退出码**。
// 实测：给 scene-controller.js 加 3 行（178/175）、同时从 core.js 削掉 3 个空行让
// 总行数仍为 2098 ⇒ 这里输出 `[WARN] scene-controller.js: 178/175 (exceeded)`
// 紧接着 `Line budget OK` 并 `exit 0`。
//
// 这正是本项目反复踩的坑：**棘轮的语义是"超标必须显式改 core-limits.mjs 才能通过"**，
// 而只告警意味着"改不改都能通过"——棘轮退化成注释。单测（R0-108/D5 棘轮用例）确实
// 会判红，但它是另一条执行路径：`npm run check` 是发布前最常被单独调用的那条，
// 在这里放行等于给了一个"看起来通过了"的出口。
//
// 现在：任一模块超预算 ⇒ 与总行超限同等对待，计入失败并 exit 1。
const overBudget = [];

for (const name of files) {
  const content = readFileSync(join(coreDir, name), 'utf8');
  // R0-108/D5：口径统一为 core-limits.mjs 声明的**官方口径** = split('\n').length 之和
  // （= 换行数 + 文件数）。此前这里用 `match(/\n/g).length`（纯换行数），比官方口径少
  // "文件数"行 ⇒ 同一份代码被说成 519 和 522 两个数，两个 metric 在同一仓里混用。
  const lines = content.split('\n').length;
  totalLines += lines;
  totalBytes += Buffer.byteLength(content, 'utf8');
  const limit = MODULES[name];
  if (limit !== undefined) modulesTotal += lines;

  if (limit !== undefined && lines > limit) {
    console.log(`  [FAIL] ${name}: ${lines}/${limit} (exceeded by ${lines - limit})`);
    overBudget.push(`${name} ${lines}/${limit}`);
  } else if (limit !== undefined) {
    console.log(`  [OK]   ${name}: ${lines}/${limit} (${limit - lines} left)`);
  } else {
    console.log(`         ${name}: ${lines} lines`);
  }
}

const modOk = modulesTotal <= MAX_MODULES_TOTAL;
const totalOk = totalLines <= MAX_TOTAL;
const bytesOk = totalBytes <= CORE_MAX_BYTES;

console.log(`\n三模块总计: ${modulesTotal}/${MAX_MODULES_TOTAL} ${modOk ? '[OK]' : '[FAIL]'}`);
// 标签修正（2026-10-14）：此处一直只统计 src/core/（见文件头的 coreDir），却写成 "src/ 总行"，
// 与"约束适用于整个 src/ 树"的说法互相印证成误解——插件从来不占这个预算。
// v0.9.25：`src/builtin/` 已并入 `plugins/`，`src/` 只剩 `core/`（受此预算）与 `bootstrap/`（不受）。
console.log(`src/core 总行: ${totalLines}/${MAX_TOTAL} ${totalOk ? '[OK]' : '[FAIL]'}`);
// 字节是第二道闸：行数对不上体积，就说明“行里塞了东西”而不是“代码变多了”。
console.log(`src/core 字节: ${totalBytes}/${CORE_MAX_BYTES} ${bytesOk ? '[OK]' : '[FAIL]'}`);
if (foreign.length > 0) {
  console.log(`\n[FAIL] src/core 出现未登记扩展名：${foreign.join('、')}`);
  console.log('只有 .js/.cjs/.mjs 参与行数/字节/指纹。其它扩展名要么改名，要么先把它纳入三处判据。');
}

if (!modOk || !totalOk || !bytesOk || foreign.length > 0 || overBudget.length > 0) {
  if (overBudget.length > 0) {
    console.log(`\n单模块超预算（棘轮）：${overBudget.join('、')}`);
    console.log('超了就要么削减，要么显式调高 scripts/core-limits.mjs 的 MODULE_BUDGET 并说明理由——');
    console.log('不允许"悄悄涨上去"，也不允许"仅凭总行未超就放行"。');
  }
  console.log('\nLine budget exceeded — reject PR');
  process.exit(1);
}
console.log('\nLine budget OK');
process.exit(0);
