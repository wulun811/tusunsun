// R0-113（专家评审 P0-02）：工作区边界的**唯一**判据 —— 工具层的对外入口。
//
// 事实（修前）：7 个文件工具各自写 `join(workDir, path)` + `fullPath.startsWith(workDir)`。
// 字符串前缀不是目录包含关系 —— 实测同级目录 `workspace/` 与 `workspace_evil/`：
// `../workspace_evil/bypass.txt` 拼出的绝对路径以 `…/workspace` 开头 ⇒ 判据放行，
// 真实 Agent 链路（模型 → 工具执行器 → tool-write）成功越界写入工作区之外。
// 而 `../blocked.txt` 会被拒 ⇒ 既有测试给出的是**不完整的防护信心**。
//
// 现在：`resolve()` 归一化 + `relative()` 判真正的包含关系；再用 `realpath` 追一层符号链接
// （对"目标不存在"的写入取**最近的已存在祖先**求真实路径，覆盖 `ws/link -> /outside/file`）。
//
// S1 / R0-159（v0.9.33）：物理归一化与包含判断**抽到 `plugins/_lib/real-path.mjs`**，
// 与 `plugins/sandbox.js` 共用同一份。修前两边各写一份：工具层追 realpath、沙箱层不追，
// 于是"经符号链接写 deny 目录"在工具层被拒、在沙箱层被放行（送审报告 §1.1 排第一）。
// 两份实现迟早漂移 —— 这不是风格问题，是同一安全属性给出两个答案。现在只剩一份代码，
// 本文件只负责把它接到"必须落在工作区内"这条策略上，并产出既有的具名错误形状。
//
// 边界声明（诚实优先，不做超出能力的承诺）：
//   · 这是**信任边界**，不是沙箱：`tool-bash` 与 `tool-executor` 仍可执行任意命令；
//   · `realpath` 与随后的 `writeFile` 之间存在 TOCTOU 窗口（同一用户下的本地攻击者）；
//   · Windows 的 8.3 短名 / UNC / 大小写不敏感未做专门处理（`relative()` 只保证盘符与分隔符语义）。
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import { canonicalizePhysical, isInsideReal } from '../../_lib/real-path.mjs';

function contractError(message, code) {
  return Object.assign(new Error(message), { code, contractError: true });
}

function outOfBounds(message) {
  return contractError(message, 'out_of_bounds');
}

/**
 * 目标的**物理**路径必须仍在工作区真实路径之内。
 *
 * H5：修前用 `nearestExisting` —— 对悬空链接回落到“最近已存在的祖先”，于是
 * `ws/vault -> /outside/new.txt`（目标不存在）被判“在工作区内”，随后的 `writeFile`
 * 跟随链接写到外面。判据与效果落在两个位置，正是 S1 合同禁止的那件事。
 * 现在用共享的逐段物理归一化：它把悬空链接的目标接回待解析段；判不出来
 *（环 / 不存在的尾段带 `.`/`..`）返回 null ⇒ 拒绝。
 */
async function assertRealInside(root, target, raw) {
  const rootReal = await realpath(root).catch(() => null);
  if (!rootReal) return; // 工作区自身尚不存在：此时不存在可逃逸的实体，写入会以 ENOENT 如实失败
  const real = await canonicalizePhysical(target);
  if (!real) {
    throw outOfBounds(
      `Error: Path traversal not allowed: "${raw}" cannot be physically resolved `
      + '(dangling or looping symlink).\n'
      + `Workspace: ${rootReal}`);
  }
  if (!isInsideReal(rootReal, real)) {
    // `via symlink` 不是修辞：`real !== target` 就说明路径里有一段是链接（或链接的链接），
    // 拒绝文案必须点名这一点，否则排错的人会以为是自己写错了相对路径。
    const via = real === target ? '' : ' via symlink';
    throw outOfBounds(
      `Error: Path traversal not allowed: "${raw}" resolves outside the workspace${via}.\n`
      + `Workspace: ${rootReal}\nResolved: ${real}`);
  }
}

/**
 * 把 `raw` 解析为工作区内的绝对路径；越界（绝对路径 / `..` 逃逸 / 符号链接逃逸）一律具名拒绝。
 * 抛出的错误带 `code:'out_of_bounds' | 'invalid_input'` 与 `contractError:true`，
 * 与既有工具的契约错误约定一致（调用方据此原样上抛）。
 * @param {string} workDir 工作区根（配置 `agent.workDir`）
 * @param {string} raw 工具入参里的相对路径
 * @returns {Promise<string>} 归一化后的绝对路径
 */
export async function resolveWorkspacePath(workDir, raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw contractError('Error: path is required', 'invalid_input');
  }
  const root = resolve(workDir || process.cwd());
  if (isAbsolute(raw)) {
    const rel = relative(root, raw);
    const suggestion = rel && !rel.startsWith('..') ? rel : 'file.txt';
    throw outOfBounds(
      'Error: Absolute path detected. Use RELATIVE path from workspace.\n'
      + `Workspace: ${root}\n`
      + `Instead of: "${raw}"\n`
      + `Use: "${suggestion}"`);
  }
  const target = resolve(root, raw);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw outOfBounds(
      `Error: Path traversal not allowed: "${raw}" escapes the workspace.\n`
      + `Workspace: ${root}\nResolved: ${target}`);
  }
  await assertRealInside(root, target, raw);
  return target;
}

export { outOfBounds as workspaceOutOfBounds };
