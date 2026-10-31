#!/usr/bin/env node
// 验证基线生成器（RC14-FORMAL-0）。
//
// 为什么需要它：专家裁决要求 `verification/baseline.json` 同时绑定
// **源码树** 与 **发行制品** 两个 SHA，并要求它是**可重算** 的，
// 而不是一次手写就再也不会对上的常量。手写 SHA 的结局是：抄错一位就「永远对不上」，
// 而那种红色看起来像代码坏了。
//
// 刻意**排除** `verification/` 本身：否则写入 baseline.json 会改变树摘要，
// 形成「要么永远脏、要么永远无法提交」的自引用。证据目录不是产品。
//
// 用法：
//   node verification/measure-baseline.mjs           # 生成 verification/baseline.json
//   node verification/measure-baseline.mjs --print   # 只打印到 stdout
//
// 退出码：0 = 已写/已打印；1 = 仓库不可读。
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  EXCLUDED_PREFIXES, sha256, toPosix, treeDigest as measureTreeDigest, trackedFiles as listTracked,
  git as gitAt, workingTreeDirty,
} from './lib/provenance.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(HERE, 'baseline.json');
const PRINT_ONLY = process.argv.includes('--print');

// 树摘要 / 已跟踪清单 / git 读取统一在 ./lib/provenance.mjs。本文件此前自带一份实现，
// 与 baseline-check.mjs 那份并存 —— 同一条判据抄两处，改一处忘一处就得到
// 「生成的基线与检查的基线口径不同」的错位，而那种错位只会表现为一堆假红。

function coreFiles() {
  const dir = join(ROOT, 'src', 'core');
  const out = {};
  let lines = 0;
  let bytes = 0;
  for (const f of readdirSync(dir).sort()) {
    if (!/\.(?:[cm]?js)$/.test(f)) continue;
    const buf = readFileSync(join(dir, f));
    // 官方口径：split('\n').length（= 换行数 + 1）。全仓行数门禁都用这个口径。
    const official = buf.toString('utf8').split('\n').length;
    out[f] = { sha256: sha256(buf), bytes: buf.length, official_lines: official };
    lines += official;
    bytes += buf.length;
  }
  return { files: out, official_lines: lines, bytes };
}

function artifacts() {
  const list = [];
  for (const f of readdirSync(ROOT).sort()) {
    if (!f.endsWith('.tgz')) continue;
    const p = join(ROOT, f);
    const st = statSync(p);
    list.push({ file: f, bytes: st.size, sha256: sha256(readFileSync(p)) });
  }
  return list;
}

/**
 * npm 会**按设计**注入或改写的包内成员。清单必须显式，且每一行都要有理由 ——
 * 这是"允许的生成差异"唯一的登记处；解释不了的差异一律记 mismatch。
 */
const GENERATED_MEMBERS = Object.freeze([
  // npm 恒写入，含打包时的提交/时间戳，无法与磁盘同哈希。
  'package/package.json',
].map((p) => p.replace(/^package\//, '')));

/** 递归列出目录下所有普通文件（绝对路径）。 */
function walk(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, ent.name);
    if (ent.isDirectory()) walk(abs, out);
    else if (ent.isFile()) out.push(abs);
  }
  return out;
}

/**
 * 源码侧"应当出现在包里"的成员。
 *
 * 反向检查只能问「白名单声称要带的，真的带了吗」——不能问「所有已跟踪文件都在包里吗」：
 * `.gitignore` / `package-lock.json` / `engines/` 等本来就不是发行物。
 * 也不能让 npm 再算一遍：白名单写错时，用错的白名单去验它会自我一致。
 * 折中：**照 `package.json#files` 精确展开**到候选路径，再要求这些路径必须在包内。
 * 这样"白名单漏了某类文件"仍会被 README 那类正向成员比对抓到（包里有、源码不同哈希）。
 */
function expectedMembers() {
  const files = Array.isArray(pkg.files) ? pkg.files : [];
  const out = [];
  const tracked = new Set(listTracked(ROOT).map((p) => p.replace(/^\.\//, '')));
  for (const entry of files) {
    const bare = entry.replace(/^\.\//, '').replace(/\/$/, '');
    if (entry.endsWith('/')) {
      for (const rel of tracked) if (rel === bare || rel.startsWith(`${bare}/`)) out.push(rel);
      continue;
    }
    if (bare.includes('*')) {
      const re = new RegExp(`^${bare.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
      for (const rel of tracked) if (re.test(rel)) out.push(rel);
      continue;
    }
    if (tracked.has(bare)) out.push(bare);
  }
  // npm 恒写入 package.json；不在 files 里也必然在包内。
  out.push('package.json');
  return [...new Set(out)].sort();
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const files = listTracked(ROOT);
const tree = measureTreeDigest(ROOT, files);
const core = coreFiles();
const dirty = workingTreeDirty(ROOT);
const head = gitAt(ROOT, ['rev-parse', 'HEAD']);

const baseline = {
  schema: 'tusunsun.verification.baseline/v1',
  package: { name: pkg.name, version: pkg.version },
  source: {
    git_commit: head,
    working_tree_dirty: dirty,
    tracked_files: tree.count,
    tree_sha256: tree.digest,
    excludes: EXCLUDED_PREFIXES,
    core_manifest_files: Object.keys(core.files).length,
    core_official_lines: core.official_lines,
    core_bytes: core.bytes,
    core_files: core.files,
  },
  artifact: (() => {
    // 制品绑定：**不能**“有 .tgz 就算已建”。要答的问题是「这个制品是不是从
    // **当前这棵源码树**打出来的」——不是就必须写 STALE。
    //
    // 只写 NOT_BUILT：RELEASE 工单硬要求「SHA 绑定」，一个永远 NOT_BUILT 的字段什么也没绑。
    // 只看“文件在不在”：源码改了却忘了重打包时，“文件在”与“它代表当前代码”是两件事
    // —— 混起来就是拿旧证据签新版本。
    const want = `${pkg.name}-${pkg.version}.tgz`;
    const list = artifacts();
    const hit = list.find((a) => a.file === want) || null;
    if (!hit) return { file: null, sha256: null, status: 'NOT_BUILT', expected_file: want, known_artifacts: list };
    // 逐文件比对：包内每个成员都必须与磁盘**同哈希**。
    //
    // 此前只比 `package.json` + 受管核心 8 文件。代价可控，但回答的是一个更窄的问题：
    // 「核心没变」不等于「这份包就是这棵树打的」。实测就漏过：README 在打包之后才更新，
    // 包里的 1,308 用例 / 35 门禁与源码里的 1,320 / 36 不一致，而九项全绿。
    //
    // 现在解包一次、逐成员实算。允许的生成差异只有 npm 自己会改写的那些，且必须显式列出 ——
    // 「解释不了的差异」一律记 mismatch，绝不因为"看起来像生成物"就放过。
    const extracted = mkdtempSync(join(tmpdir(), 'tusunsun-artifact-'));
    let members = [];
    try {
      const ex = spawnSync('tar', ['-xzf', join(ROOT, want), '-C', extracted], { encoding: 'utf8', maxBuffer: 64 << 20 });
      if (ex.status !== 0) return { file: hit.file, bytes: hit.bytes, sha256: hit.sha256, status: 'STALE', source_consistent: false, mismatches: [`tar 解包失败：${(ex.stderr || '').slice(0, 200)}`], checked_members: [], known_artifacts: list };
      const pkgRoot = join(extracted, 'package');
      members = walk(pkgRoot).map((abs) => toPosix(relative(pkgRoot, abs))).sort();
      let mismatch = [];
      for (const relPath of members) {
        let disk = null;
        try { disk = readFileSync(join(ROOT, relPath)); } catch {
          // 包里有、源码没有：只允许 npm 按设计注入/生成的成员（见 GENERATED_MEMBERS）。
          if (!GENERATED_MEMBERS.includes(relPath)) mismatch.push(`${relPath}:not-in-source`);
          continue;
        }
        if (sha256(readFileSync(join(pkgRoot, relPath))) !== sha256(disk)) mismatch.push(`${relPath}:sha-mismatch`);
      }
      // 反向：源码里该进包却没有的成员。用 npm 自己的清单口径（package.json#files）
      // 回答不了“该不该”，所以这里只查"磁盘上存在且不在排除集里"的已跟踪文件。
      for (const relPath of expectedMembers()) {
        if (!members.includes(relPath)) mismatch.push(`${relPath}:missing-from-artifact`);
      }
      const stale = mismatch.length > 0;
      return {
        file: hit.file,
        bytes: hit.bytes,
        sha256: hit.sha256,
        // BUILT 的意思是“这个包与当前源码逐成员一致”，不是“文件存在”。
        status: stale ? 'STALE' : 'BUILT',
        source_consistent: !stale,
        mismatches: mismatch,
        checked_members: members,
        known_artifacts: list,
      };
    } finally {
      rmSync(extracted, { recursive: true, force: true });
    }
  })(),
  host: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpus: (await import('node:os')).cpus?.().length ?? null,
  },
  generated_at: new Date().toISOString(),
  status_vocabulary: [
    'MODEL_PASS_BOUNDED', 'MODEL_COUNTEREXAMPLE', 'MODEL_INCONCLUSIVE',
    'IMPLEMENTATION_PASS', 'IMPLEMENTATION_COUNTEREXAMPLE', 'NOT_RUN', 'NOT_MAPPED',
  ],
  limitations: [
    '本文件是**基线指纹**，不是修复声明：任一 F01–F08 项请查 verification/contracts/oss-core-v1.md 的现状节。',
    'artifact.status=NOT_BUILT 时，不得引用本文件声称任何制品已验证。',
    'working_tree_dirty=true 时，tree_sha256 描述的**不是**某个提交，不能当作出厂证据。',
  ],
};

const json = `${JSON.stringify(baseline, null, 2)}\n`;
if (PRINT_ONLY) {
  process.stdout.write(json);
  process.exit(0);
}
writeFileSync(OUT, json);
process.stdout.write(`已写入 ${relative(ROOT, OUT)}\n`);
process.stdout.write(`  提交 ${head ?? '(未知)'}${dirty ? '（产品树有未提交改动）' : ''}\n`);
process.stdout.write(`  树摘要 ${tree.digest.slice(0, 16)}…（${tree.count} 个跟踪文件，不含 verification/）\n`);
process.stdout.write(`  core ${Object.keys(core.files).length} 文件 / ${core.official_lines} 行 / ${core.bytes} B\n`);
process.stdout.write(`  制品：${baseline.artifact.status}${baseline.artifact.file ? `（${baseline.artifact.file}）` : '（重建发行包后重跑本脚本）'}\n`);
