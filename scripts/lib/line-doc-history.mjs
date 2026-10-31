/**
 * ADR-10 版本表「不许改历史」的判据（纯函数，无副作用，供 `sync-line-docs.mjs` 与测试共用）。
 *
 * 为什么需要它：生成器只改「当前版本那一行」，这个设计是对的 —— 但它认的"当前版本"来自
 * `package.json`。于是**忘了先 bump 版本**就会把上一个已发布版本的行改成新数字。
 * rc.26 真的发生过：在 rc.25 的版本号下跑了 `--write`，ADR-10 里 `rc.25 | 4978 → **4775**`
 * 被改成 `4753`，仓库里多了一条假历史（人工发现后才改回来）。
 *
 * 判据只用一件事：**`HEAD` 里已经存在的行，不许被改成另一个数**。工作树里刚加的行
 * （HEAD 里还没有）当然可以随时改 —— 那正是"先补行、再同步"的正常流程。
 */

/** `| v0.16.0-rc.25 | 4978 → **4775** |` —— 只认版本列精确相等的那一行。 */
function rowPattern(version) {
  const esc = String(version).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\|\\s*v${esc}\\s*\\|\\s*(\\d+)\\s*→\\s*\\*\\*(\\d+)\\*\\*`, 'm');
}

/**
 * 返回 `{ from, to }` 表示"这一行已经在 HEAD 里，且记的不是实测值"；`null` 表示可以写。
 *
 * @param {string|null} headAdr  `git show HEAD:docs/adr/ADR-10-core-line-budget.md` 的内容
 * @param {string} version      当前版本号（不带 `v`）
 * @param {number} total        实测核心行数
 */
export function releasedRowConflict(headAdr, version, total) {
  if (!headAdr) return null;
  const m = String(headAdr).match(rowPattern(version));
  if (!m) return null;
  const to = Number(m[2]);
  if (to === Number(total)) return null;
  return { from: Number(m[1]), to };
}

/** 给人看的拒绝理由（与抛错处共用，避免两处措辞分叉）。 */
export function releasedRowMessage(version, conflict, total) {
  return [
    `ADR-10 里 v${version} 那一行已经写在 HEAD 里（${conflict.from} → **${conflict.to}**），`,
    `而实测是 ${total} 行 —— 直接改就是**篡改已发布版本的历史数字**。`,
    '先 bump `package.json` 版本号，再补一行新的 `| v<新版本> | 旧 → **新** | 归因 |`，然后重跑。',
    '（确认要改历史时加 `--allow-rewrite-released-row`，并在 CHANGELOG 里写明为什么。）',
  ].join('\n  ');
}
