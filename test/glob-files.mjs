// R0-113（专家评审 P2 / §6 第三批）：`node:fs/promises.glob` 在 **Node 22** 才出现，
// 而本包 `engines.node` 声明 `>=18.0.0` —— 实测四个测试跑手全部 import 它，
// Node 18/20 上 `npm test` 直接 `SyntaxError: The requested module 'node:fs/promises' does not
// provide an export named 'glob'`。声明支持的范围必须真的能跑，否则就是虚假承诺。
//
// 这里用 `readdir` 自己走目录（零依赖），支持本仓实际用到的两种模式：
//   `test/unit/**/*.mjs`（递归）与 `test/*.mjs`（单层）。
import { readdir } from 'node:fs/promises';
import { join, sep } from 'node:path';

/**
 * 极简 glob：把 `**` 当作"任意层级目录"、`*` 当作"单层内的任意文件名"。
 * @param {string} pattern 形如 `/abs/test/unit/**\/*.mjs`
 * @returns {Promise<string[]>} 匹配到的**绝对路径**（已排序，保证跑手顺序稳定）
 */
export async function globFiles(pattern) {
  const norm = pattern.split(sep).join('/');
  const magicAt = norm.search(/[*?]/);
  if (magicAt < 0) return [];
  const slash = norm.lastIndexOf('/', magicAt);
  const base = norm.slice(0, slash);
  const rest = norm.slice(slash + 1);
  const out = [];
  await walk(base, rest.split('/'), out);
  return out.sort();
}

async function walk(dir, parts, out) {
  if (!parts.length) { out.push(dir); return; }
  const [head, ...tail] = parts;
  if (head === '**') {
    // `**` 匹配零层或多层：先试"零层"，再逐层下探。
    await walk(dir, tail, out);
    for (const name of await safeReaddir(dir)) {
      if (name.startsWith('.')) continue;
      const child = join(dir, name);
      if (await isDir(child)) await walk(child, parts, out);
    }
    return;
  }
  const re = new RegExp('^' + head.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '.') + '$');
  for (const name of await safeReaddir(dir)) {
    if (name.startsWith('.')) continue;
    if (!re.test(name)) continue;
    const child = join(dir, name);
    if (!tail.length) { if (!(await isDir(child))) out.push(child); continue; }
    if (await isDir(child)) await walk(child, tail, out);
  }
}

async function safeReaddir(dir) {
  try { return await readdir(dir); } catch { return []; }
}

async function isDir(p) {
  try {
    const { stat } = await import('node:fs/promises');
    return (await stat(p)).isDirectory();
  } catch { return false; }
}
