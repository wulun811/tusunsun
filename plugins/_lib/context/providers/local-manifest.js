// CTX-6（PR-2）：ContextPort v0 —— `map` / `pull` / `assemble` 的薄实现。
//
// 这个文件只做三件事，每件都刻意保持"薄"：
//
//   ① **目录（map）**：从宿主授权的 manifest 里列出**有限的**条目元数据（ref/title/type/
//      source/estimated_tokens/brief），正文一律不进首轮输入。目录本身就是"可发现性"，
//      不是"预加载"。
//   ② **读取（pull）**：只接受**目录里出现过的稳定 ref**，在授权根下解析，返回
//      ref/range/hash/truncated。裸 URL、绝对路径、`..`、符号链接越界全部具名拒绝。
//   ③ **装配（assemble）**：把系统提示词、任务、历史、地图、经验提示、已拉取内容与摘要
//      排成一份模型输入，并**在一次**预算验算里裁掉低优先级材料。这里不实现第二个
//      agent loop，也不做"聪明的检索"。
//
// 关于预算的一个明确设计：本文件的 `assemble` 只负责**排序与裁剪**，它返回的 `receipt`
// 记录估算用量；真正的"最后一次预算校验"发生在 haotian-lite 拼完所有片段之后
// （见 plugins/context-budget.js）。把预算做在两个地方是刻意的：一个地方算不准，
// 而且历史教训（`plugin-context` 后注入未计入）正是"只在早期算一次"造成的。
//
// 诚实边界：
//   · token 估算用现有 context-manager 的字符近似（`_estimateTokens` 口径），不是真实
//     tokenizer。所有对外措辞必须是"估算"，不能写成"精确计数"。
//   · 本文件不做语义检索/向量召回。`map` 的匹配只有标题/标签子串命中与顺序截断。

import { readFile, stat, realpath, readdir } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep, dirname } from 'node:path';
import { contractError } from '../../cell/contract.js';
import { estimateTokens } from '../../context-budget.js';

/** 单个条目正文上限：pull 是"读一段"，不是"下载一个仓库"。 */
const ENTRY_MAX_BYTES = 512 * 1024;
/** 目录条目数上限：目录必须小到能进一次上下文。 */
const MAP_MAX_ITEMS = 200;

/**
 * 与 context-manager 同一口径的粗估（中文按 1.5 字符/token，其余 4 字符/token）。
 *
 * **单一实现**：从 `plugins/context-budget.js` 转出，而不是在这里再写一份。
 * 本轮复核发现仓里同时存在三个"差不多"的估算：context-manager 的 `_estimateTokens`、
 * 本文件的 `estimateTokens`（两者公式一致）、以及 experience-port 里手写的
 * `Math.ceil(line.length / 4)`（**漏了中文 1.5 的口径**）。后果不是"差几个 token"：
 * 一条中文经验提示被估成 101、按统一口径是 225 —— 差了 2.2 倍，于是
 * `experience.hints_max_tokens` 这条上限对中文提示基本失效，而对英文提示很严。
 * 估算口径不一致时，所有"上限"都只是对某一种语言生效的约定。
 */
export { estimateTokens };
// 注意：必须先 import 再 export，不能只写 `export { estimateTokens } from '...'`。
// 后者是**纯转发**，不会在本模块内创建本地绑定 —— 而下面 `pull()` 里要按名字调用它。
// 这个错误在导入阶段完全无感、只有真正执行到 pull 时才抛
// `estimateTokens is not defined`（本轮 CTX-E30 就是被它挡下的）。


/** 目标（或其最近的已存在祖先）真实路径必须仍在 root 真实路径之内。 */
async function realInside(root, target) {
  const rootReal = await realpath(root).catch(() => null);
  if (!rootReal) return null;
  let probe = target;
  for (;;) {
    const real = await realpath(probe).catch(() => null);
    if (real) {
      const rel = relative(rootReal, real);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
      return { real, rootReal };
    }
    const up = dirname(probe);
    if (up === probe) return null;
    probe = up;
  }
}

/**
 * local-manifest provider：一个受限的、只读的、宿主编排的目录。
 *
 * manifest 形状（`<resourceRoot>/.context-manifest.json`）：
 *   { "schema_version": "tusunsun.context-manifest/v0",
 *     "items": [ { "ref": "context:arch-2", "title": "...", "type": "doc",
 *                  "source": "docs/arch.md", "brief": "..." } ] }
 *
 * `source` 是**相对 resourceRoot 的路径**，不是 URL、不是绝对路径。
 * 条目里没有列出的文件**不可 pull** —— 这是"目录是授权清单"而不是"目录是提示"的关键区别。
 */
export class LocalManifestProvider {
  constructor({ resourceRoot }) {
    this.resourceRoot = resourceRoot ? resolve(resourceRoot) : null;
    this._manifest = null;
    this._byRef = new Map();
  }

  async _load() {
    if (this._manifest) return this._manifest;
    if (!this.resourceRoot) {
      throw contractError('context provider "local-manifest" requires cells.context.resourceRoot', 'context_disabled');
    }
    const file = join(this.resourceRoot, '.context-manifest.json');
    let raw;
    try {
      raw = JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw contractError(
          `context manifest not found at ${file}; the local-manifest provider needs an explicit item list `
          + '(a missing manifest is not an empty directory — it would make "nothing found" indistinguishable from "nothing allowed")',
          'manifest_missing');
      }
      throw contractError(`context manifest is unreadable: ${err.code || err.message}`, 'manifest_invalid');
    }
    if (raw?.schema_version !== 'tusunsun.context-manifest/v0') {
      throw contractError(`context manifest schema_version must be "tusunsun.context-manifest/v0"（收到 ${JSON.stringify(raw?.schema_version)}）`, 'manifest_invalid');
    }
    const items = Array.isArray(raw.items) ? raw.items : [];
    if (items.length > MAP_MAX_ITEMS) {
      throw contractError(`context manifest has ${items.length} items (> ${MAP_MAX_ITEMS}); a map must stay small`, 'manifest_invalid');
    }
    const byRef = new Map();
    for (const [i, it] of items.entries()) {
      if (!it || typeof it !== 'object') throw contractError(`manifest items[${i}] must be an object`, 'manifest_invalid');
      if (typeof it.ref !== 'string' || !it.ref) throw contractError(`manifest items[${i}].ref is required`, 'manifest_invalid');
      if (byRef.has(it.ref)) throw contractError(`duplicate manifest ref "${it.ref}"`, 'manifest_invalid');
      if (typeof it.source !== 'string' || !it.source) throw contractError(`manifest items[${i}].source is required`, 'manifest_invalid');
      // source 必须是相对路径：manifest 也不能变成"读任意文件"的清单。
      if (isAbsolute(it.source) || /^[A-Za-z]:[\\/]/.test(it.source) || it.source.split(/[\\/]/).includes('..')) {
        throw contractError(`manifest items[${i}].source must be a relative path inside resourceRoot（收到 "${String(it.source).slice(0, 80)}"）`, 'manifest_invalid');
      }
      byRef.set(it.ref, {
        ref: it.ref,
        title: typeof it.title === 'string' ? it.title.slice(0, 200) : it.ref,
        type: typeof it.type === 'string' ? it.type.slice(0, 32) : 'doc',
        source: it.source,
        brief: typeof it.brief === 'string' ? it.brief.slice(0, 400) : '',
      });
    }
    this._manifest = raw;
    this._byRef = byRef;
    return raw;
  }

  /**
   * 列目录。`limit` 与 `query` 共同决定"看得见多少"：
   *   · 没有 query ⇒ 按 manifest 顺序取前 limit 条；
   *   · 有 query ⇒ 标题/brief 子串匹配优先，其余按顺序补齐。
   * 返回的每一条都带 `estimated_tokens`，但**不含正文**。
   */
  async map(scope, { limit = 20, query = null } = {}) {
    await this._load();
    const entries = [...this._byRef.values()];
    let picked;
    if (query) {
      const q = String(query).toLowerCase();
      const hit = entries.filter((e) => e.title.toLowerCase().includes(q) || e.brief.toLowerCase().includes(q) || e.ref.toLowerCase().includes(q));
      const rest = entries.filter((e) => !hit.includes(e));
      picked = [...hit, ...rest];
    } else {
      picked = entries;
    }
    const cap = Math.max(1, Math.min(MAP_MAX_ITEMS, limit));
    const sliced = picked.slice(0, cap);
    const out = [];
    for (const e of sliced) {
      let tokens = null;
      try {
        const inside = await realInside(this.resourceRoot, join(this.resourceRoot, e.source));
        if (inside) {
          const s = await stat(inside.real).catch(() => null);
          if (s?.isFile()) tokens = Math.ceil(s.size / 4);
        }
      } catch { /* 大小算不出来就不给估算，不阻断目录 */ }
      out.push({
        ref: e.ref, title: e.title, type: e.type, source: e.source,
        estimated_tokens: tokens, brief: e.brief,
      });
    }
    return {
      schema_version: 'tusunsun.context-map/v0',
      items: out,
      total: entries.length,
      truncated: picked.length > cap,
      // 目录被截断时必须显式可查：调用方要能区分"只有这么多"与"这里只显示了这么多"。
      ...(picked.length > cap ? { cursor: `offset:${cap}` } : {}),
    };
  }

  /**
   * 按 ref 读一段正文。
   *
   * 三个必须：
   *   · ref **必须**在 manifest 里（否则 `unknown_context_ref`）—— 这是授权清单，不是提示；
   *   · 真实路径必须在 resourceRoot 内（符号链接不因为 ref 合法就放行）；
   *   · 返回 `truncated` 与 `byte_range`，让调用方知道"这是节选"而不是"这是全文"。
   */
  async pull(scope, { ref, maxTokens = 1600, offsetBytes = 0 }) {
    await this._load();
    const e = this._byRef.get(String(ref));
    if (!e) {
      throw contractError(
        `unknown context ref "${String(ref).slice(0, 120)}": only refs listed by context.map may be pulled. `
        + 'A bare path or URL is not a context reference.', 'unknown_context_ref');
    }
    if (!this.resourceRoot) throw contractError('context provider has no resource root', 'context_disabled');
    const target = join(this.resourceRoot, e.source);
    const inside = await realInside(this.resourceRoot, target);
    if (!inside) {
      throw contractError(`context ref "${ref}" resolves outside the host resource root via a symlink`, 'context_out_of_bounds');
    }
    const s = await stat(inside.real).catch(() => null);
    if (!s?.isFile()) throw contractError(`context ref "${ref}" is not a regular file`, 'context_unreadable');
    if (s.size > ENTRY_MAX_BYTES) {
      throw contractError(`context ref "${ref}" is too large to pull in one piece（${s.size} > ${ENTRY_MAX_BYTES} bytes）`, 'context_too_large');
    }
    const buf = await readFile(inside.real);
    let start = Math.max(0, Math.min(buf.length, Number.isInteger(offsetBytes) ? offsetBytes : 0));
    // 按估算 token 反推字符预算：中文 ~1.5 char/token 是最坏情况，用 1.5 保守取值。
    const charBudget = Math.max(64, Math.floor(maxTokens * 1.5));
    // **切点必须落在字符边界上**（续字节形如 10xxxxxx）。切在字符中间会让 toString('utf8')
    // 产出 U+FFFD，而 byte_range.to / next_offset_bytes 会把损坏位置固化成续读起点 ——
    // 每段开头带一个替换符，拼起来永远不是原文。
    while (start < buf.length && (buf[start] & 0xC0) === 0x80) start++;
    let end = Math.min(buf.length, start + charBudget);
    if (end < buf.length) while (end > start && (buf[end] & 0xC0) === 0x80) end--;
    const slice = buf.subarray(start, end);
    const text = slice.toString('utf8');
    const truncated = end < buf.length;
    const { createHash } = await import('node:crypto');
    return {
      schema_version: 'tusunsun.context-slice/v0',
      ref: e.ref,
      title: e.title,
      source: e.source,
      text,
      byte_range: { from: start, to: start + slice.length, total: buf.length },
      sha256: createHash('sha256').update(slice).digest('hex'),
      estimated_tokens: estimateTokens(text),
      truncated,
      ...(truncated ? { next_offset_bytes: start + slice.length } : {}),
    };
  }
}

/** `none` provider：一个明确"什么都没有"的提供者，不是"出错了"。 */
export class NoneContextProvider {
  async map() {
    return { schema_version: 'tusunsun.context-map/v0', items: [], total: 0, truncated: false };
  }
  async pull(_scope, { ref }) {
    throw contractError(
      `context provider is "none"; ref "${String(ref).slice(0, 120)}" cannot be pulled `
      + '(this profile declares no external material — that is a configuration, not a failure)',
      'context_provider_none');
  }
}

/** 按 provider 名构造实现。未知 provider 具名拒绝（不静默降级成 none）。 */
export function makeProvider(profile, { resourceRoot }) {
  const which = profile?.retrieval?.provider || 'none';
  if (which === 'none') return new NoneContextProvider();
  if (which === 'local-manifest') return new LocalManifestProvider({ resourceRoot });
  throw contractError(`unknown context provider "${which}"`, 'unsupported_context_provider');
}
