// v0.10.1：插件模块 ESM 形态诊断（Node 18 真阳性）。
//
// 事实（本轮在 Node 18.20.8 实测，不是推断）：
//   `import('/x/my-plugin.js')` 是否被当作 ESM，取决于**最近的 package.json 有没有
//   `"type":"module"`**。Node 20.19+ / 22 额外做 syntax detection（看到 `export` 就当 ESM），
//   **Node 18 不做**。
//
// 后果（真阳性）：本包根有 `"type":"module"`，所以包内 `plugins/*.js` 在 18 上正常；
// 而用户的插件目录（`--plugin-dir`、`plugin-dirs.json` 的 `extra`）通常**没有** package.json
// —— 于是同一份用户插件在 Node 22 装得上、在 Node 18 报 `Unexpected token 'export'`，
// 而且那句话完全指不出真实原因（用户会以为自己写错了语法）。
//
// 这里只负责**把失败说清楚**。不自动往用户目录写 package.json：
//   · 那会修改用户目录，副作用超出"装载插件"的语义；
//   · 目录里若混有 CommonJS 插件，写 type=module 会把它们全部弄坏。
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * 判断一次导入失败是否属于"这个 .js 在本 Node 版本下不被当作 ESM"。
 * @param {string} fullPath 被导入的绝对路径
 * @param {Error} err 原始错误
 * @returns {string|null} 是则返回可执行的建议文本；否则 null（**不冒充**别的错误）
 */
export function esmShapeHint(fullPath, err) {
  if (!/\.js$/.test(fullPath)) return null;                    // .mjs 天然是 ESM，不适用
  // 只认解析阶段的 export 语法错误。ENOENT、别处语法错、权限错都不冒充成这一条。
  if (!/Unexpected token 'export'|Cannot use import statement outside a module/.test(String(err?.message || ''))) return null;
  for (let dir = dirname(fullPath); ; dir = dirname(dir)) {
    // 有 package.json 却仍失败 ⇒ 原因不是这条（可能是 CommonJS 文件里写了 export）
    if (existsSync(join(dir, 'package.json'))) return null;
    if (dirname(dir) === dir) break;
  }
  return `Plugin "${fullPath}" cannot be loaded as an ES module on ${process.version}: `
    + 'this .js sits in a directory with no package.json declaring `"type":"module"`, '
    + 'and this Node version does not detect ES modules by syntax.\n'
    + 'Fix (either one):\n'
    + '  · rename the file to `.mjs`, or\n'
    + `  · add {"type":"module"} to a package.json in ${dirname(fullPath)}\n`
    + 'Node 20.19+ / 22 do not need this, but relying on that is not portable.';
}
