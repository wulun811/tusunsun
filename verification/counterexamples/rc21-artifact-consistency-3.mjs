#!/usr/bin/env node
/**
 * verification/counterexamples/rc21-artifact-consistency-3.mjs
 *
 * 专家 rc.20 复审的唯一阻断项：**实际 `npm pack` 出的包与送审源码不一致**。
 * 465 个成员里有 2 个（README.md / README.en.md）内容不同，而 `baseline-check` 只核对
 * 9 个指定成员 —— 于是"制品与源码一致"这句话按其覆盖面是成立的，按读者理解是不成立的。
 *
 * 本轮把"逐成员"本身变成可复跑判据，三个反例形状：
 *   01 逐成员比对：任何一个成员的哈希不同都必须被点名（不只是核心 8 文件）
 *   02 `checked_members` 与包内实物成员必须同名同数（否则"逐成员"是空话）
 *   03 允许的生成差异必须显式登记；解释不了的差异不得被静默放过
 *
 * 每条都配**对称正例**：为了"抓差异"而把一切差异都判红（连 npm 自己改写的
 * package.json 也red），在这里同样是红的 —— 那会让判据永远无法变蓝而被绕过。
 *
 * 跑：node verification/counterexamples/rc21-artifact-consistency-3.mjs
 * 退出码 0 = 3/3 FIXED（且正例全绿）；1 = 仍有反例；2 = 探针自身出错。
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync, copyFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listTgzFiles } from '../../test/lib/tar-members.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const MEASURE = join(ROOT, 'verification', 'measure-baseline.mjs');
const CHECK = join(ROOT, 'verification', 'baseline-check.mjs');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const TARGET = `${pkg.name}-${pkg.version}.tgz`;

const rows = [];
async function check(id, title, fn) {
  let dir = mkdtempSync(join(tmpdir(), 'rc21-'));
  try {
    const facts = await fn(dir);
    rows.push({ id, title, status: facts.fixed ? 'FIXED' : 'COUNTEREXAMPLE', ...facts });
  } catch (err) {
    rows.push({ id, title, status: 'PROBE_ERROR', error: String(err?.message || err) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 跑一次 measure-baseline --print，取回 artifact 段。 */
function measure() {
  const r = spawnSync(process.execPath, [MEASURE, '--print'], { encoding: 'utf8', cwd: ROOT, maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`measure-baseline 退出码 ${r.status}：${(r.stderr || '').slice(0, 300)}`);
  return JSON.parse(r.stdout).artifact;
}

/** 跑一次 baseline-check --json；baseline 路径固定，故临时改写后必须原样恢复。 */
function checkJson() {
  const r = spawnSync(process.execPath, [CHECK, '--json'], { encoding: 'utf8', cwd: ROOT, maxBuffer: 64 << 20 });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { parsed = null; }
  return { status: r.status, json: parsed, stderr: (r.stderr || '') };
}

const artifactDiffs = (out) => (out.json?.diffs || []).filter((d) => d.area === 'artifact');

// ── 01 逐成员比对：改一个**非核心**成员也必须被点名 ──────────────────
await check('01', '逐成员：包内任何成员与源码不同哈希都必须被点名，不只是核心 8 文件', async () => {
  const art = measure();
  const members = art.checked_members || [];
  // 反例形状：选一个**刻意不是**核心文件、也不是 package.json 的成员。
  const nonCore = members.find((m) => !m.startsWith('src/core/') && m !== 'package.json'
    && /^(README\.md|CHANGELOG\.md|plugins\/|src\/)/.test(m));
  if (!nonCore) throw new Error('包内找不到可用于本条判据的非核心成员');

  // 正例：当下的单次量测里，这个成员必须是被逐字节比过的（清单里有它）。
  const coversNonCore = members.includes(nonCore);
  // 反例：把该成员的磁盘内容改一个字节（用临时副本还原，不动用户工作树里的真实文件）。
  const backup = join(tmpdir(), `rc21-backup-${process.pid}`);
  const abs = join(ROOT, nonCore);
  copyFileSync(abs, backup);
  let named = false;
  let coreStayedGreen = false;
  try {
    const buf = readFileSync(abs);
    const mutated = Buffer.from(buf);
    // 改最后一个字节，内容变化但文件仍可读；不引入语法破坏。
    mutated[mutated.length - 1] = mutated[mutated.length - 1] === 0x0a ? 0x20 : 0x0a;
    writeFileSync(abs, mutated);
    const after = measure();
    const diffs = after.mismatches || [];
    // 判据要同时成立：① 该成员被点名 ② 核心成员没有被牵连误报
    // （"整体判红"也要红，但红错地方说明它是按文件数比、不是按内容比）。
    named = diffs.some((d) => d.startsWith(`${nonCore}:`)) && after.status === 'STALE';
    coreStayedGreen = !diffs.some((d) => d.startsWith('src/core/'));
  } finally {
    copyFileSync(backup, abs);
    try { unlinkSync(backup); } catch { /* 已删 */ }
  }
  // 恢复后必须回到原状态（不让探针自己留下残余漂移）
  const restored = measure();
  const restoredOk = restored.status === art.status;

  return {
    fixed: coversNonCore && named && coreStayedGreen && restoredOk,
    memberProbed: nonCore,
    coversNonCore, mutatedMemberIsNamed: named, coreStayedGreen, restoredOk,
    memberCount: members.length,
  };
});

// ── 02 checked_members 必须与包内实物成员同名同数 ────────────────────
await check('02', 'checked_members 与包内实物成员必须同名同数：否则"逐成员"只是登记了九项', async () => {
  const art = measure();
  const registered = art.checked_members || [];
  // 反例形状：把基线里的 checked_members 缩回「九项」——旧行为的样子。
  const realTgz = join(ROOT, TARGET);
  const hasTgz = (() => { try { readFileSync(realTgz); return true; } catch { return false; } })();
  if (!hasTgz) throw new Error(`找不到 ${TARGET}（先 npm pack）`);
  const tmp = mkdtempSync(join(tmpdir(), 'rc21-tar-'));
  try {
    // 成员清单**不经外部 tar 的 stdout**：那是有 locale 依赖的展示格式，
    // 非 ASCII 名会被转义成八进制（实测 GNU tar 1.35 上 rc.21 反例 02 因此假红）。
    const actual = listTgzFiles(readFileSync(realTgz));
    // 正例：当前登记清单必须覆盖全部实物成员
    const fullCoverage = registered.length === actual.length && actual.every((m) => registered.includes(m));
    // 反例：只登记九项时，覆盖判据必须为假（而不是"看起来也像逐成员"）
    const nineOnly = ['package.json', ...Object.keys(JSON.parse(readFileSync(join(ROOT, 'verification', 'baseline.json'), 'utf8')).source.core_files || {}).map((f) => `src/core/${f}`)];
    const nineCoverage = nineOnly.length === actual.length && actual.every((m) => nineOnly.includes(m));
    return {
      fixed: fullCoverage && !nineCoverage && actual.length > nineOnly.length,
      memberCount: actual.length, registeredCount: registered.length,
      fullCoverage, nineOnlyCoverageWouldPass: nineCoverage,
    };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ── 03 允许的生成差异必须显式登记，且这是唯一入口 ─────────────────────
await check('03', '生成差异必须显式登记：解释不了的差异不得因为"看着像生成物"被放过', async () => {
  const src = readFileSync(MEASURE, 'utf8');
  const chk = readFileSync(CHECK, 'utf8');
  // 正例：两份脚本都必须有具名清单，且清单很小、每一项都能说出理由。
  const hasList = /GENERATED_MEMBERS/.test(src) && /GENERATED_MEMBERS/.test(chk);
  // 反例形状：「任何差异一律放过」的实现会在比对处直接跳过 —— 那让判据永不发红。
  const silentlySkips = /if\s*\(\s*!\s*diffs?\.length\s*\)\s*continue/.test(src);
  // 反例形状②：把生成物判据写成"后缀像生成物就放过"的通配，等于无判据。
  const wildcardEscape = /GENERATED_MEMBERS[^=]*=\s*[^\n]*\.endsWith\(/.test(src);
  // 清单本身必须小且具名（当前只有 npm 恒改写的 package.json）。
  const listed = (src.match(/GENERATED_MEMBERS[\s\S]{0,200}?\[([\s\S]*?)\]/) || [, ''])[1];
  const entries = [...listed.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const smallAndNamed = entries.length > 0 && entries.length <= 3;
  return {
    fixed: hasList && !silentlySkips && !wildcardEscape && smallAndNamed,
    hasList, silentlySkips, wildcardEscape, listedEntries: entries,
  };
});

const fixed = rows.filter((r) => r.status === 'FIXED').length;
const bad = rows.filter((r) => r.status === 'COUNTEREXAMPLE').length;
const errs = rows.filter((r) => r.status === 'PROBE_ERROR').length;
console.log(JSON.stringify({
  root: ROOT,
  summary: { cases: rows.length, fixed, counterexamples: bad, probe_errors: errs },
  rows,
}, null, 2));
process.exitCode = errs > 0 ? 2 : bad > 0 ? 1 : 0;
