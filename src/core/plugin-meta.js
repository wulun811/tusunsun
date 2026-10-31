import { readFile, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * 插件名的格式判据（内核里**唯一**的一份）。名字不只是标签：它是服务归属的来源值、
 * 与宿主标记（`@host`）对照的值，还会被拼进文件路径（`join(dir, name + '.js')`）。
 * 所以它必须格式可判定：`@` 前缀留给宿主，`..`/`/` 拼进路径会跑出插件目录。
 * `Core.register`、`loadOne`、`indexLazy` 共用这一份 —— 各写一条正则等于没有判据。
 */
export const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** 名字是否是合法插件名。非字符串一律不算。 */
export function isValidPluginName(name) {
  return typeof name === 'string' && PLUGIN_NAME_RE.test(name);
}

export async function readFileHeader(filePath, maxBytes = 2048) {
  const buf = Buffer.alloc(maxBytes);
  const fd = await open(filePath, 'r');
  try {
    const { bytesRead } = await fd.read(buf, 0, maxBytes, 0);
    return buf.toString('utf8', 0, bytesRead);
  } finally {
    await fd.close();
  }
}

function resolveReExport(src, filePath) {
  const m = src.match(/export\s*\{\s*default\s*\}\s*from\s*['"]([^'"]+)['"]/);
  if (!m || !filePath) return src;
  return m[1];
}

function extractField(src, name) {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*['"]([^'"]+)['"]`, 'm');
  const m = src.match(re);
  return m ? m[1] : null;
}

function extractBracketLiteral(src, startPos, open, close) {
  if (src[startPos] !== open) return null;
  let depth = 0, i = startPos;
  let inStr = false, strCh = null;
  while (i < src.length) {
    const ch = src[i];
    if (inStr) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === strCh) inStr = false;
    } else {
      if (ch === '"' || ch === "'") { inStr = true; strCh = ch; }
      else if (ch === open) depth++;
      else if (ch === close) { depth--; if (depth === 0) return src.slice(startPos, i + 1); }
    }
    i++;
  }
  return null;
}

function jsToJson(str) {
  let i = 0, result = '';
  while (i < str.length) {
    const ch = str[i];
    if (ch === '"' || ch === "'") {
      const q = ch;
      result += '"';
      i++;
      while (i < str.length) {
        if (str[i] === '\\' && i + 1 < str.length) { result += str[i] + str[i + 1]; i += 2; continue; }
        if (str[i] === q) { result += '"'; i++; break; }
        result += str[i] === '"' ? '\\"' : str[i];
        i++;
      }
      continue;
    }
    result += ch;
    i++;
  }
  return result
    .replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":')
    .replace(/,\s*([}\]])/g, '$1');
}

function parseProvidesArray(src, startPos) {
  const arr = extractBracketLiteral(src, startPos, '[', ']');
  if (!arr) return [];
  try { return JSON.parse(jsToJson(arr)); } catch { return []; }
}

function parseRequiresObject(src, startPos) {
  const obj = extractBracketLiteral(src, startPos, '{', '}');
  if (!obj) return {};
  try { return JSON.parse(jsToJson(obj)); } catch { return {}; }
}

export function extractPluginMeta(src, filePath) {
  const reexportPath = resolveReExport(src, filePath);
  if (reexportPath !== src) {
    return { _reexport: reexportPath, name: null, version: null, provides: [], requires: {} };
  }

  const name = extractField(src, 'name');
  const version = extractField(src, 'version');

  let provides = [];
  let requires = {};

  const providesRe = src.match(/(?:^|\s)provides\s*=\s*/m);
  if (providesRe) provides = parseProvidesArray(src, providesRe.index + providesRe[0].length);

  const requiresRe = src.match(/(?:^|\s)requires\s*=\s*/m);
  if (requiresRe) requires = parseRequiresObject(src, requiresRe.index + requiresRe[0].length);

  return { name, version, provides, requires };
}

export async function extractPluginMetaFromFile(filePath) {
  try {
    const src = await readFile(filePath, 'utf8');
    const meta = extractPluginMeta(src, filePath);
    if (meta._reexport) {
      const targetPath = join(dirname(filePath), meta._reexport);
      const targetSrc = await readFile(targetPath, 'utf8');
      return extractPluginMeta(targetSrc, targetPath);
    }
    return meta;
  } catch (err) {
    console.warn(`[plugin-meta] Failed to extract metadata from ${filePath}: ${err.message}`);
    return { name: null, version: null, provides: [], requires: {} };
  }
}
