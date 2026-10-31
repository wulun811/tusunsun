// 载体判定：同一份断言要同时服务**两种载体** —— 源码检出（git 工作树）与 npm 发行包
// （`npm pack` 出的 tgz 解包后）。
//
// 为什么需要它（rc.12 专家独立审查实测）：发行包按 package.json 的 `files` 白名单打包，
// npm 另有硬排除，`.github/` 与 `package-lock.json` **按设计不进 tgz**。可随包交付的测试里
// 有几条要读它们，于是在真实制品里直接 ENOENT：
//   R0-101/C3、R0-117/V5、R0-117/V7、P0-1/1、P0-1/3、test/probes/r21-fix-evidence.mjs 的 P0-1
// 读者看到「5 FAIL + 探针 rc=1」无法区分「Core 坏了」和「这个载体里本来就没有这个文件」。
// 这是**测试交付合同**的缺陷（不是运行时缺陷），必须把两种载体分开说清楚。
//
// 判据（不猜、不吞异常、不把读不到折成通过）：
//   · 源码检出：含 `.git/`（npm 永不打包 .git），或含 `.github/`、`package-lock.json`。
//     此时这些断言**照旧是硬门**：读不到就是 FAIL，不降级、不 try/catch。
//   · npm 发行包：三者都不存在。此时先**正向验证**仓库专属文件确实不在本树（缺失=预期），
//     再把依赖它们的断言记 NOT_RUN（harness 记 SKIP，绝不折算成通过）。
//
// 反滥用闸（缺一条这条路就会变成「删文件让测试变绿」）：
//   1. `.git/` 还在就是源码载体 —— 删掉 `.github/` 不会变成发行包（R0-164 钉住）。
//   2. 发行包形态却带着仓库专属文件 ⇒ 直接抛错（打包白名单漏了排除，或本树其实不是发行包）。
//   3. 必验收模式 `TT_REQUIRE_PRECONDITIONS=1` 下 noteSkip 直接抛错 ⇒ 发行包里的 NOT_RUN 也阻断。
//   4. `TT_CARRIER=source|dist` 可显式覆盖，供 `git archive` / 源码压缩包这类没有 `.git` 的检出。
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** npm 包**按设计不带**的仓库专属文件（判据与 `package.json#files` 白名单一致）。 */
export const REPO_ONLY = Object.freeze(['.github', 'package-lock.json']);

/** 本树实际出现了哪些仓库专属文件。 */
export function repoOnlyPresent(root) {
  return REPO_ONLY.filter((p) => existsSync(join(root, p)));
}

/**
 * 判定载体。纯函数（除读目录外无副作用），可对任意目录调用 —— R0-164 用它做正反例。
 * @returns {{carrier: 'source'|'dist', why: string, present: string[], forced: boolean}}
 */
export function detectCarrier(root) {
  const present = repoOnlyPresent(root);
  const forced = String(process.env.TT_CARRIER || '').trim();
  if (forced === 'source' || forced === 'dist') {
    return { carrier: forced, why: `TT_CARRIER=${forced} 显式指定`, present, forced: true };
  }
  if (existsSync(join(root, '.git'))) {
    return { carrier: 'source', why: '检出含 .git/（npm 永不打包 .git）', present, forced: false };
  }
  if (present.length) {
    return { carrier: 'source', why: `检出含 ${present.join(' / ')}`, present, forced: false };
  }
  return {
    carrier: 'dist',
    why: '无 .git/、无 .github/、无 package-lock.json ⇒ npm 发行包形态',
    present,
    forced: false,
  };
}

/** 发行包形态的正向验证：仓库专属文件**必须确实缺失**。缺了才算真发行包，不是碰巧读不到。 */
export function assertDistShape(root) {
  const present = repoOnlyPresent(root);
  if (present.length) {
    throw new Error(
      `发行包形态却含仓库专属文件：${present.join(' / ')}`
      + '（package.json#files 白名单漏了排除，或者这棵树其实还不是发行包）',
    );
  }
}

/**
 * 用例体内的载体闸。
 * 源码检出 → 返回判定结果，调用方继续做**硬断言**；
 * 发行包   → 正向验证缺失后记 NOT_RUN（记 SKIP，不折算成通过）并返回 null，调用方 `if (!gate) return;`。
 *
 * @param {{noteSkip: (reason: string) => void}} runner 测试 harness
 * @param {string} root 包根
 * @param {string} what 被跳过的是哪条判据（写进 NOT_RUN 原因里，读者要知道少了什么）
 */
export function requireRepoOnly(runner, root, what) {
  const c = detectCarrier(root);
  if (c.carrier === 'source') {
    if (c.forced && !c.present.length) {
      throw new Error(`TT_CARRIER=source 但本树没有 ${REPO_ONLY.join(' / ')} 中的任何一个 —— 声明与事实不符`);
    }
    return c;
  }
  assertDistShape(root);
  runner.noteSkip(`[NOT_RUN] 本检出是 npm 发行包（${c.why}）⇒ 「${what}」只在源码检出里执行`);
  return null;
}

/** 给 `[实测]` 行用的一句话描述。 */
export function describeCarrier(root) {
  const c = detectCarrier(root);
  return `载体=${c.carrier}：${c.why}`;
}
