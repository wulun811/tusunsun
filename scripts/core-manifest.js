#!/usr/bin/env node
// 核心源码内容指纹的**唯一维护脚本**（v0.14.1，配合 ADR-10 与 scripts/core-limits.mjs）。
//
// 为什么需要这个脚本：`CORE_FILE_SHA256` 是仓库级锚（E4 试验与 R0-113 都核对它），
// 手工改哈希极易出错 —— 抄错一位就变成"永远对不上"，而那种红色看起来像代码坏了。
//
// 用法：
//   node scripts/core-manifest.js            # 只校验，不一致则 exit 1（CI / npm run check 用）
//   node scripts/core-manifest.js --write    # 按实测重写常量（改了核心时必须显式执行）
//   node scripts/core-manifest.js --json     # 机器可读输出
//
// 退出码：0 = 一致（或已写入）；1 = 不一致；2 = 用法错误。

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORE_DIR = join(ROOT, 'src', 'core');
const LIMITS = join(ROOT, 'scripts', 'core-limits.mjs');

/** 与 scripts/line-check.js 同一份白名单：只认 `.js/.cjs/.mjs`。 */
const SOURCE_EXT = /\.(?:[cm]?js)$/;

/** 实测当前核心目录的逐文件 sha256。 */
export function measureManifest() {
  // 只认 `.js` 时，一个 `.cjs` 既不在指纹表里、也不会被报「新增文件未登记」：它隐形。
  const files = readdirSync(CORE_DIR).filter((f) => SOURCE_EXT.test(f)).sort();
  const out = {};
  for (const f of files) {
    out[f] = createHash('sha256').update(readFileSync(join(CORE_DIR, f))).digest('hex');
  }
  return out;
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write('用法: node scripts/core-manifest.js [--write|--json]\n');
  process.exit(0);
}
if (args.some((a) => !['--write', '--json'].includes(a))) {
  process.stderr.write(`未知参数：${args.filter((a) => !['--write', '--json'].includes(a)).join(' ')}\n`);
  process.exit(2);
}

const measured = measureManifest();
const { CORE_FILE_SHA256 } = await import(pathToFileURL(LIMITS).href);

if (args.includes('--json')) {
  process.stdout.write(`${JSON.stringify({ measured, registered: CORE_FILE_SHA256 }, null, 2)}\n`);
  process.exit(0);
}

const diffs = [];
for (const [f, h] of Object.entries(measured)) {
  if (!(f in CORE_FILE_SHA256)) diffs.push({ file: f, kind: '新增文件未登记', actual: h });
  else if (CORE_FILE_SHA256[f] !== h) diffs.push({ file: f, kind: '内容变化', registered: CORE_FILE_SHA256[f], actual: h });
}
for (const f of Object.keys(CORE_FILE_SHA256)) {
  if (!(f in measured)) diffs.push({ file: f, kind: '文件已删除但仍登记', registered: CORE_FILE_SHA256[f] });
}
// 扩展名不在白名单里的文件不会进 `measured`，也就永远不会被报「新增文件未登记」——
// 它只是安静地待在目录里，被 Node 当成模块加载。这里把它显式报出来。
for (const f of readdirSync(CORE_DIR).filter((f) => !SOURCE_EXT.test(f) && !f.startsWith('.'))) {
  diffs.push({ file: f, kind: '扩展名未纳入指纹（不会参与任何校验）' });
}

if (args.includes('--write')) {
  const lines = Object.entries(measured)
    .map(([f, h]) => `  '${f}': '${h}',`)
    .join('\n');
  const src = readFileSync(LIMITS, 'utf8');
  const replaced = src.replace(
    /export const CORE_FILE_SHA256 = \{[\s\S]*?\n\};/,
    `export const CORE_FILE_SHA256 = {\n${lines}\n};`,
  );
  // 两种"没变"必须分开：① 块定位到了、但指纹本来就是实测值（正常，不是错）；
  // ② 块没定位到（常量名被改过 / 被挪走）。合成一句「未能定位…」会把①报成②，
  // 于是照着提示去查一个根本不存在的问题。
  if (replaced === src) {
    if (diffs.length === 0) {
      process.stdout.write(`核心内容指纹已是实测值（${Object.keys(measured).length} 个文件，无需重写）\n`);
      process.exit(0);
    }
    process.stderr.write('未能定位 CORE_FILE_SHA256 块 —— 常量名被改过？\n');
    process.exit(1);
  }
  writeFileSync(LIMITS, replaced);
  process.stdout.write(`已按实测重写 ${Object.keys(measured).length} 个文件的指纹（${diffs.length} 处变化）\n`);
  for (const d of diffs) process.stdout.write(`  · ${d.file}：${d.kind}\n`);
  process.stdout.write('提醒：这是被 review 看见的动作，请在 CHANGELOG 或 ADR 里说明为什么改核心。\n');
  process.exit(0);
}

if (diffs.length === 0) {
  process.stdout.write(`核心内容指纹一致（${Object.keys(measured).length} 个文件）\n`);
  process.exit(0);
}
process.stderr.write(`核心内容指纹**不一致**（${diffs.length} 处）：\n`);
for (const d of diffs) {
  process.stderr.write(`  · ${d.file}：${d.kind}\n`);
  if (d.registered) process.stderr.write(`      登记 ${d.registered.slice(0, 16)}… / 实测 ${d.actual.slice(0, 16)}…\n`);
}
process.stderr.write('\n若核心**确实应该**改过，执行 `node scripts/core-manifest.js --write` 并说明原因；\n'
  + '若不是有意的，说明有东西在悄悄改内核。\n');
process.exit(1);
