// tool-path-args.mjs — 「这次调用动的是哪些路径」的**唯一权威判据**。
//
// 为什么需要这个文件（v0.11.0 / AR-C06）：
// 同一个概念（"这次调用要碰的文件"）在**四个地方**各读一遍，取法互不相同：
//   · `tool-write.execute`    读 `args.path || args.file_path || args.filePath`
//   · 围栏 `checkBoundary`    读 `args.path || args.file`
//   · 围栏 `checkPath`（敏感路径）只对 `write_file` / `read_file` 生效，`tool-write` 根本不查
//   · 围栏「读前必读」        读 `args?.path`
// 于是 `{file_path: '/etc/passwd'}` 在**执行侧**是有效的，在**三层判据**里全都看不见。
// 这与 AR-C05（`command` vs `_raw`）是同一个形状的第二次出现：
// **判据读的名字 ≠ 执行读的名字 ⇒ 判据被绕过，而它自己以为检查过了。**
//
// 实测（v0.10.4，真 FileSystemGuard）：
//     checkBoundary('tool-write', {path:'/etc/passwd'})      → SYMLINK_ESCAPE（拦）
//     checkBoundary('tool-write', {file_path:'/etc/passwd'}) → ok:true        （放）
//     checkBoundary('tool-cp',    {src:'/etc/passwd',…})     → ok:true        （放，从未查过）
//     checkBoundary('tool-mv',    {src:'/etc/passwd',…})     → ok:true        （放，从未查过）
//
// 本模块的立场：**字段清单只有一份**，谁要读路径就问它。新增别名时只改这里，
// 并由 `test/unit/test-ar-c06-path-alias-fence.test.mjs` 的**结构判据**逐工具
// 对照工具自己声明的 `parameters`，漏一个就判红（不是靠人眼记得改）。

/**
 * 每个工具**实际会读**的路径字段（顺序即优先级）。
 *
 * 这份清单必须与各工具 `parameters.properties` 里声明的路径类字段一致；
 * 不一致会被结构判据抓到（见测试 AR-C06/6）。
 */
const PATH_FIELDS = Object.freeze({
  // 写类：`tool-write` 是唯一接受别名的工具（R0-146 之前的历史包袱，保留兼容）
  'tool-write': ['path', 'file_path', 'filePath', 'file'],
  // 读类
  'tool-read': ['path', 'file_path', 'filePath', 'file'],
  'tool-stat': ['path', 'file_path', 'filePath', 'file'],
  'tool-list': ['path', 'file_path', 'filePath', 'file'],
  // 破坏类
  'tool-rm': ['path', 'file_path', 'filePath', 'file'],
  // 双端类：**两端都要查**。此前围栏一个字段都没读，等于 cp/mv 完全不受边界判据管辖。
  'tool-cp': ['src', 'dest'],
  'tool-mv': ['src', 'dest'],
  // 旧下划线兼容名（围栏历史清单里一直在，但只读 `path|file`）
  write_file: ['path', 'file', 'file_path', 'filePath'],
  read_file: ['path', 'file', 'file_path', 'filePath'],
});

/** 只按老办法读 `path | file` 的工具（历史行为，不扩别名，避免误改语义）。 */
const LEGACY_PATH_FIELDS = Object.freeze(['path', 'file']);

/** 围栏覆盖的「文件类」工具（判据只对它们生效）。 */
export const FILE_TOOLS = Object.freeze([
  'write_file', 'read_file',
  'tool-read', 'tool-write', 'tool-list', 'tool-stat',
  'tool-cp', 'tool-mv', 'tool-rm', 'tool-glob', 'tool-grep', 'tool-diff',
]);

/** 某工具会读哪些路径字段（未登记的工具退回 `path | file`）。 */
export function pathFieldsOf(tool) {
  return PATH_FIELDS[tool] ?? LEGACY_PATH_FIELDS;
}

/** 该工具是否是「文件类」（围栏判据的作用域）。 */
export function isFileTool(tool) {
  return FILE_TOOLS.includes(tool);
}

/**
 * 取出本次调用涉及的全部路径：`[{ field, value }]`，只含非空字符串。
 *
 * **刻意返回全部而不是第一个**：`tool-cp` / `tool-mv` 有两端，
 * 只查一端等于给"把文件搬到工作区外"留一半的门。
 */
export function pathsOf(tool, args) {
  const out = [];
  if (!args || typeof args !== 'object') return out;
  for (const field of pathFieldsOf(tool)) {
    const v = args[field];
    if (typeof v === 'string' && v !== '') out.push({ field, value: v });
  }
  return out;
}

/**
 * 单路径工具的**规范路径**（`tool-write` 等）。
 *
 * 顺序与 `tool-write.execute` 完全一致 —— 这一条是刻意的：
 * 只要两边顺序不同，"判据查的路径"与"实际写的路径"就可能不是同一个。
 * 拿不到返回 `null`（不是空串：空串是"没给"，`null` 是"给的不是字符串"）。
 */
export function pickPath(args) {
  if (!args || typeof args !== 'object') return null;
  for (const field of ['path', 'file_path', 'filePath', 'file']) {
    const v = args[field];
    if (typeof v === 'string' && v !== '') return v;
  }
  return null;
}
