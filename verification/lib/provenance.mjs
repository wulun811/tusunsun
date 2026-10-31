#!/usr/bin/env node
// 证据出处（provenance）：回答「这份报告描述的是哪一棵树」。
//
// 存在理由（本仓真的踩过）：`verification/reports/*.json` 是**已跟踪**文件，
// 却只在有人手动重跑形式化验证时才更新。于是出现过一次：合同与 CHANGELOG 写
// 「四份模型 / 19 个突变体 / 10 条重放」，仓库里的报告还停在「两份模型 /
// 9 条重放」——两边都自称现状，谁也没撒谎，只是**没有任何东西要求它们对得上**。
// 更糟的是那种不一致不会报错：读报告的人以为看见了证据，其实看见的是一棵
// 已经不存在了的树。
//
// 判据只有一条：报告里写下它测量时那棵树的摘要，检查时重算一遍。
// 摘要刻意**排除** `verification/`（与 baseline.json 同口径），否则「把报告
// 提交进去」这件事本身会改变摘要 —— 形成要么永远脏、要么永远无法提交的自引用。
// 证据目录不是产品，这一点与本文件被放在 verification/ 下不矛盾：它描述产品。
//
// 三处脚本（measure-baseline / baseline-check / run-formal）此前各抄了一份同样的
// 树摘要代码。同一条判据抄三份，迟早有一份先漂，而漂掉的那一份不会自己报错。
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';

/** 证据目录不进树摘要（见文件头）。 */
export const EXCLUDED_PREFIXES = ['verification/'];

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
export const toPosix = (p) => p.split(sep).join('/');

/** git 读命令：失败返回 null（非 git 仓/无 git 时上层记 NOT_RUN，而不是假装一致）。
 *
 * `stdio` 必须显式给：`execFileSync` 即使捕获了 stderr，**仍会把子进程 stderr 漏到
 * 父进程的 stderr**。在非 git 副本里跑过一次就会看到一行 `fatal: 不是 git 仓库`
 * 挂在成功输出前面 —— 结论是对的，但那行字会让人以为哪里坏了。
 */
export function git(root, args) {
  try {
    return execFileSync('git', args, {
      cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** 已跟踪文件清单（相对仓库根，posix 形式，按路径排序）。 */
export function trackedFiles(root) {
  const out = git(root, ['ls-files', '-z']);
  if (!out) return [];
  return out.split('\0').filter(Boolean).map(toPosix).sort();
}

/** 树摘要 = 对「路径\0内容sha\n」按路径排序后的拼接再 sha256。 */
export function treeDigest(root, files = trackedFiles(root)) {
  const entries = [];
  for (const rel of files) {
    if (EXCLUDED_PREFIXES.some((p) => rel.startsWith(p))) continue;
    let content;
    try { content = readFileSync(join(root, rel)); } catch { continue; }
    entries.push(`${rel}\0${sha256(content)}\n`);
  }
  return { digest: sha256(Buffer.from(entries.join(''), 'utf8')), count: entries.length };
}

/**
 * 写进基线/报告的那四个字段。键名与 `baseline.json` 的 `source` 节一致，
 * 这样「基线」与「报告」说的是同一套关于树的话，不需要两套解释。
 *
 * `working_tree_dirty=true` 时 `tree_sha256` 描述的**不是**某个提交：
 * 它可以被拿来比对，但不能当出厂证据。这句话基线里写了，报告里照抄。
 */
/**
 * 树是否「脏」—— **只数产品文件**，不数 `verification/`。
 *
 * 两条必须同口径：`tree_sha256` 不含 `verification/`，那么「脏」也不能含。
 * 否则「生成报告」这个动作本身会让报告写出 `working_tree_dirty: true`，而紧接着
 * 要做的事正是把这份报告提交进去 —— 于是「干净的出处」永远写不出来。
 * 这是与文件头同一个自引用坑换了个字段，所以修在同一处。
 */
export function workingTreeDirty(root) {
  const out = git(root, ['status', '--porcelain', '--', '.', ':(exclude)verification']);
  return out === null ? false : out.length > 0;
}

export function sourceProvenance(root) {
  const tree = treeDigest(root);
  return {
    git_commit: git(root, ['rev-parse', 'HEAD']),
    working_tree_dirty: workingTreeDirty(root),
    tracked_files: tree.count,
    tree_sha256: tree.digest,
  };
}
