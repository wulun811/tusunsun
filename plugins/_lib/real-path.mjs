// 真实路径判据的**唯一**实现（S1 / R0-159）。
//
// 为什么要有这个文件：v0.9.32 送审报告 §1.1 记录的核心缺口是"同一个安全属性、两个入口
// 两个答案"——工具层（plugins/tools/lib/workspace.mjs）会追 realpath 并拒绝符号链接逃逸，
// 沙箱层（plugins/sandbox.js）只做词法 `resolve()`，于是：
//     sandbox.deny = [secret 目录]，工作区里有 `vault -> secret`
//     ① 直接写 secret/k.txt          → 拒绝
//     ② 写 ws/vault/k.txt            → 放行，磁盘内容真的被改
//
// 本轮（S1）要修掉它。但修法**不能**是在 sandbox 里再写一份简化版判据 —— 那就等于
// 制造第三份会漂移的实现，正是这轮要消灭的形状。所以把"物理归一化 + 包含关系"
// 抽到这里，工具层与沙箱层**共用同一份代码**，两边只是把结果接到各自的策略上
// （工具层是"必须落在工作区内"，沙箱层是"deny 优先、再看 allow"）。
//
// 边界（诚实，不夸大）：
//   · 这里给出的是**判据**，不是原子性。判完到真正 write 之间仍有 TOCTOU 窗口
//     （同一账户下的本地进程可以把目录换成符号链接）。本库不声称消除它。
//   · 因此 `plugins/sandbox.js` 仍**不是** OS 沙箱，只是 trusted-local 软围栏；
//     真正抗恶意本机进程要靠 OS 级隔离（chroot/namespace/seccomp），本库不提供。
import { parse, join, sep, dirname, relative, isAbsolute, resolve } from 'node:path';
import { realpath, lstat, readlink } from 'node:fs/promises';
import { realpathSync, lstatSync, readlinkSync } from 'node:fs';

/** 符号链接跟随的跳数上限：成环或链太深时判不出来，于是否决（fail-closed）。 */
const MAX_LINK_HOPS = 32;

/**
 * `realpath` 的这三种失败都意味着“这一段不能直接解析”，应交给 lstat/readlink 继续追：
 *   ENOENT —— 目标不存在（悬空链接的目标也是它）；
 *   ENOTDIR —— 中间某段不是目录；
 *   ELOOP  —— 链接成环（内核自己也会报这个，不能当成“异常”抛给调用方：
 *            那会使判据从“拒绝”变成“抛错”，而两者在上层的处置不一定相同）。
 */
const UNRESOLVABLE = new Set(['ENOENT', 'ENOTDIR', 'ELOOP']);

/**
 * 沿父目录上溯，返回最近的**已存在**路径及其真实路径；走到根仍不存在则返回 null。
 * 用于"要写的文件还不存在"的常见情形：只能对已存在的祖先求真实路径。
 * @param {string} target 绝对路径
 * @returns {Promise<{path: string, real: string}|null>}
 */
export async function nearestExisting(target) {
  let cur = target;
  for (;;) {
    try {
      return { path: cur, real: await realpath(cur) };
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
      const parent = dirname(cur);
      if (parent === cur) return null;
      cur = parent;
    }
  }
}

/**
 * 把绝对路径**逐段物理归一化**：每个存在的路径段都取 realpath，遇到不存在的段就停下，
 * 剩余部分原样接上。
 *
 * 为什么不直接用 `resolve()`：`resolve()` 是**词法**归一化，它把 `/ws/link/../x` 折成 `/ws/x`，
 * 而操作系统的实际解析是**物理**的（`link -> /etc` 时 `/ws/link/..` 是 `/`，不是 `/ws`）。
 * 两者不一致，就意味着"判据看到的路径"和"子进程真正写入的路径"可以不是同一个 ——
 * 这正是 S1 合同里"不能先查 A、随后让子进程在 B 写入"要防的事。
 * 逐段 realpath 之后，返回的路径里已不存在需要穿透的符号链接（对已存在的部分），
 * 于是判据与效果落在同一个位置。
 *
 * **fail-closed**：若剩余（不存在的）部分里还含 `..` 或 `.`，物理语义无法确定 ⇒ 返回 null，
 * 调用方必须拒绝。Supported path forms（合同口径）：绝对路径、非空字符串、可存在的父目录。
 *
 * @param {string} target 绝对路径（相对路径请先 resolve）
 * @returns {Promise<string|null>} 物理归一化后的绝对路径；无法确定时为 null
 */
export async function canonicalizePhysical(target) {
  if (typeof target !== 'string' || target.length === 0) return null;
  if (!isAbsolute(target)) return null;

  const { root } = parse(target);
  let segs = target.slice(root.length).split(sep).filter((s) => s.length > 0);
  let cur = root;
  let i = 0;
  let hops = 0;
  let missing = false;

  while (i < segs.length) {
    const seg = segs[i];
    // 一旦进入"不存在的尾段"，`.`/`..` 的物理语义就无法确定（`..` 依赖一个不存在的目录）
    if (missing && (seg === '.' || seg === '..')) return null;
    if (seg === '.') { i += 1; continue; }
    if (seg === '..') { cur = dirname(cur); i += 1; continue; }
    const next = join(cur, seg);
    if (!missing) {
      try {
        cur = await realpath(next);
        i += 1;
        continue;
      } catch (err) {
        if (!UNRESOLVABLE.has(err.code)) throw err;
      }
      // H5：**悬空的符号链接**在 `realpath` 眼里只是 ENOENT。修前这里直接把它当"普通不存在的
      // 路径段"原样接上 —— 而随后的 `writeFile` 会**跟随链接**写到目标去，于是判据停在
      // "工作区内的那个链接"、效果落在"链接指向的外面"。必须用 `lstat` 把它认出来，
      // 并把链接目标接回待解析的段列表（即使目标也不存在）。
      const st = await lstat(next).catch(() => null);
      if (st && st.isSymbolicLink()) {
        if (hops >= MAX_LINK_HOPS) return null;          // 环 / 过深：判不出来就拒，不挂死
        hops += 1;
        const link = await readlink(next).catch(() => null);
        if (link == null) return null;
        const abs = isAbsolute(link) ? link : resolve(cur, link);
        const r = parse(abs).root;
        segs = [...abs.slice(r.length).split(sep).filter((s) => s.length > 0), ...segs.slice(i + 1)];
        cur = r;
        i = 0;
        continue;
      }
      missing = true;
    }
    cur = join(cur, seg);
    i += 1;
  }
  return cur;
}

/**
 * `target` 是否在 `base` 之内（含 base 本身）。两者都必须是**已经物理归一化**的绝对路径。
 * 用 `relative()` 判目录包含，而不是字符串前缀 —— 前缀判据会把 `/a/project` 与
 * `/a/project_evil` 当成同一个目录（R0-113/R0-134 两次踩过的同一个形状）。
 * @param {string} baseReal
 * @param {string} targetReal
 * @returns {boolean}
 */
/**
 * `canonicalizePhysical` 的**同步孪生**。
 *
 * 为什么允许“两份”：`plugins/tools.js` 的 5 个内建 handler 是同步调用点，改成异步会波及
 * 整条接口；而异步/同步只是**取数方式**，不是两条判据。判断逻辑必须逐行一致 —— 靠
 * `test/unit/test-r022-exec-boundary.test.mjs` 的逐例对照（悬空链接、链接环、不存在的
 * 尾段带 `..`、普通不存在的文件）钉住：两份一旦分叉，那条对照立刻变红。
 * 此前 tools.js 就自己手写了第三份（上溯到最近已存在祖先），于是同一个悬空链接
 * 在工具层放行、在沙箱层也放行，而实体写入落在工作区之外。
 */
export function canonicalizePhysicalSync(target) {
  if (typeof target !== 'string' || target.length === 0) return null;
  if (!isAbsolute(target)) return null;

  const { root } = parse(target);
  let segs = target.slice(root.length).split(sep).filter((s) => s.length > 0);
  let cur = root;
  let i = 0;
  let hops = 0;
  let missing = false;

  while (i < segs.length) {
    const seg = segs[i];
    if (missing && (seg === '.' || seg === '..')) return null;
    if (seg === '.') { i += 1; continue; }
    if (seg === '..') { cur = dirname(cur); i += 1; continue; }
    const next = join(cur, seg);
    if (!missing) {
      try {
        cur = realpathSync(next);
        i += 1;
        continue;
      } catch (err) {
        if (!UNRESOLVABLE.has(err.code)) throw err;
      }
      let st = null;
      try { st = lstatSync(next); } catch { st = null; }
      if (st && st.isSymbolicLink()) {
        if (hops >= MAX_LINK_HOPS) return null;
        hops += 1;
        let link = null;
        try { link = readlinkSync(next); } catch { link = null; }
        if (link == null) return null;
        const abs = isAbsolute(link) ? link : resolve(cur, link);
        const r = parse(abs).root;
        segs = [...abs.slice(r.length).split(sep).filter((s) => s.length > 0), ...segs.slice(i + 1)];
        cur = r;
        i = 0;
        continue;
      }
      missing = true;
    }
    cur = join(cur, seg);
    i += 1;
  }
  return cur;
}

export function isInsideReal(baseReal, targetReal) {
  if (!isAbsolute(baseReal) || !isAbsolute(targetReal)) return false;
  // win32 大小写不敏感：先折成小写再比，避免 `C:\WS` 与 `c:\ws` 判成两个目录
  const fold = sep === '\\' ? (s) => s.toLowerCase() : (s) => s;
  const rel = relative(fold(baseReal), fold(targetReal));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}

/** `resolve()` + 物理归一化的便捷组合；输入非法或不绝对时返回 null。 */
export async function canonicalizePath(p) {
  if (typeof p !== 'string' || p.length === 0) return null;
  return canonicalizePhysical(resolve(p));
}
