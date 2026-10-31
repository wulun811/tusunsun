#!/usr/bin/env node
/**
 * verify-vendor.mjs — 随仓内置第三方依赖（vendor/）的完整性与漂移校验
 *
 * 背景（R0-117）：本仓把唯一的运行时依赖 `ws` 从 npm 依赖改成**随仓内置副本**
 * （vendor/ws/），目的是让发布物真正自包含：`npm install tusunsun` 不拉任何包，
 * 断网、内网、私有 registry 不可达时也能装能跑。
 *
 * 代价必须显式管理，否则内置 = 长期无人升级的隐患：
 *   1. 篡改/漂移：内置副本被人改动却没人发现 → PROVENANCE.json 逐文件 sha256 比对；
 *   2. 静默升级：换了目录内容但清单没跟上 → --write 必须显式声明新版本号；
 *   3. 版本落后：npm 侧已经升级、内置副本还停在旧版 → 与 package-lock.json 比对即红；
 *   4. 回退到 npm 包：代码里又出现裸 `ws` 说明符 → 扫源码即红。
 *
 * 用法：
 *   node scripts/verify-vendor.mjs                 # 校验（CI / npm run check / 单元测试）
 *   node scripts/verify-vendor.mjs --json          # 机器可读结果
 *   node scripts/verify-vendor.mjs --root <dir>    # 换根目录（测试用，便于用临时变异副本证明有牙）
 *   node scripts/verify-vendor.mjs --write         # 重写清单（版本号必须与现清单一致）
 *   node scripts/verify-vendor.mjs --write --accept-version 8.21.0   # 真升级：显式接受新版本
 *
 * 升级流程见 CONTRIBUTING.md「内置第三方依赖（vendor/）的升级」。本脚本随包发布，
 * 用户可自行 `node scripts/verify-vendor.mjs` 复核装到手的副本。
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = join(SELF_DIR, '..');

/**
 * 内置包的登记表：新增 vendored 包时在这里加一行即可。
 *
 * 两个条目的**性质不同**，别当成一回事：
 *   · `ws`         —— 我们**唯一的运行时依赖**，内置的目的就是"装得上、跑得起来"；
 *   · `@jieai/liuhe-lite` —— **可选器官**（第三方维护，独立版本线）。内置它**不是**因为我们
 *     依赖它，而是因为"可选器官也要能被审计"：装得到、哈希核得了、第三方夹带查得出。
 *     它默认**不进任何场景**（见 `plugins/liuhe-lite.js` 的 `eager` 说明），
 *     所以内置不改变"默认零第三方代码运行"这条对外承诺。
 */
export const VENDORED = [
  { name: 'ws', dir: 'vendor/ws', license: 'MIT', upstream: 'https://github.com/websockets/ws' },
  {
    name: '@jieai/liuhe-lite',
    dir: 'vendor/liuhe-lite',
    license: 'MIT',
    upstream: 'https://github.com/wulun811/LiuHe.git',
    // 它不是 npm 依赖：没有 lock 条目是**预期**，不是漂移。
    notAnNpmDependency: true,
    // 它自带一层 vendor（malong 写路径原语），由它自己的 provenance.mjs 双向核对。
    // 外层清单只负责"这 43 个文件一个字节没动"，不越权替它证明内层。
    upstreamProvenance: 'vendor/malong/PROVENANCE.json',
  },
];

const MANIFEST_NAME = 'PROVENANCE.json';
const SCHEMA = 'tusunsun-vendor/v1';

// 裸说明符扫描范围：**发布物里由我们维护的代码**。插件不受此约束（设计原则 5：插件可用任意依赖），
// 故 plugins/ 不在扫描范围。正则只认「模块说明符」位置，不认字符串数据（如 join(dir, 'ws')）。
const SCAN_DIRS = ['src', 'scripts', 'test'];
const BARE_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)(['"])([^'"\n]+)\1/g;

function sha256(buf) {
  return 'sha256:' + createHash('sha256').update(buf).digest('hex');
}

function walkFiles(dir, base = dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, base, acc);
    else if (entry.isFile()) acc.push(relative(base, full).split(sep).join('/'));
  }
  return acc.sort();
}

function readManifest(root, dir) {
  const file = join(root, dir, MANIFEST_NAME);
  if (!existsSync(file)) return { file, manifest: null };
  try {
    return { file, manifest: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (err) {
    return { file, manifest: null, parseError: err.message };
  }
}

function lockVersion(root, name) {
  const lockFile = join(root, 'package-lock.json');
  if (!existsSync(lockFile)) return { version: null, reason: 'package-lock.json 不在本检出形态（npm 包不带 lock）' };
  let lock;
  try {
    lock = JSON.parse(readFileSync(lockFile, 'utf8'));
  } catch (err) {
    return { version: null, reason: `package-lock.json 解析失败：${err.message}` };
  }
  const entry = lock.packages?.[`node_modules/${name}`];
  if (!entry) return { version: null, reason: `package-lock.json 里没有 npm 侧的 ${name}（发布物已改为内置，属预期）` };
  return { version: entry.version, integrity: entry.integrity, resolved: entry.resolved };
}

/** 扫描裸说明符：返回 [{file, spec}]，只报被内置的那个包名。 */
function scanBareSpecifiers(root, names) {
  const hits = [];
  const wanted = new Set(names);
  const visit = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        visit(full);
      } else if (/\.(mjs|js|cjs)$/.test(entry.name)) {
        const text = readFileSync(full, 'utf8');
        for (const m of text.matchAll(BARE_RE)) {
          const spec = m[2];
          if (!wanted.has(spec)) continue;
          // 行号便于定位
          const line = text.slice(0, m.index).split('\n').length;
          hits.push({ file: relative(root, full).split(sep).join('/'), line, spec });
        }
      }
    }
  };
  for (const d of SCAN_DIRS) visit(join(root, d));
  return hits;
}

/**
 * 校验（或重写）内置依赖清单。
 * @returns {{ok:boolean, problems:string[], skipped:Array<{check:string,reason:string}>, info:object}}
 */
export function verifyVendor({ root = DEFAULT_ROOT, write = false, acceptVersion = null } = {}) {
  const problems = [];
  const skipped = [];
  const info = { root, packages: [] };

  for (const pkg of VENDORED) {
    const dirAbs = join(root, pkg.dir);
    const entry = { name: pkg.name, dir: pkg.dir, version: null, files: 0, bytes: 0, gaps: [] };
    info.packages.push(entry);

    if (!existsSync(dirAbs)) {
      problems.push(`内置依赖目录不存在：${pkg.dir}`);
      continue;
    }
    const pkgJsonPath = join(dirAbs, 'package.json');
    if (!existsSync(pkgJsonPath)) {
      problems.push(`${pkg.dir}/package.json 不存在（内置副本必须保留上游 package.json，版本号以它为准）`);
      continue;
    }
    let upstreamPkg = null;
    try {
      upstreamPkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    } catch (err) {
      problems.push(`${pkg.dir}/package.json 解析失败：${err.message}`);
      continue;
    }
    entry.version = upstreamPkg.version;

    // 清单自身不算上游内容（它是我们写的元数据，不是 ws 的文件）
    const files = walkFiles(dirAbs).filter((f) => f !== MANIFEST_NAME);
    entry.files = files.length;
    entry.bytes = files.reduce((n, f) => n + statSync(join(dirAbs, f)).size, 0);

    // 许可证文件是 MIT/Apache 分发的硬性要求，不能只靠清单
    if (!existsSync(join(dirAbs, 'LICENSE'))) {
      problems.push(`${pkg.dir}/LICENSE 缺失：内置第三方代码必须随附其许可证原文`);
    }

    const { file: manifestFile, manifest, parseError } = readManifest(root, pkg.dir);

    if (write) {
      // R0-163：`--accept-version` 此前是**全局**的，会一次性"批准"登记表里**所有**条目。
      //
      // 实测（V4 在加入第二个内置包之后立刻红）：为升级 `ws@8.20.1` 传
      // `--accept-version 8.20.1`，于是连 `@jieai/liuhe-lite@0.1.3` 的清单也被重写成
      // `version: 8.20.1` 并当场报"已写入成功"。下一次 `verify-vendor` 立刻红
      // （清单版本 ≠ 副本 package.json 版本）—— 一个"没动过的包被别人的版本号改写"。
      //
      // 判据改为**按条目匹配**：只有显式接受的那个版本号命中本条目的实际版本时才放行。
      // 这样"批准 ws 升到 8.20.1"不会顺带批准别的包；要升级另一个包就再写一次它自己的版本号。
      const acceptedForThis = acceptVersion !== null && String(acceptVersion) === String(entry.version);
      if (manifest && !acceptedForThis && manifest.version !== entry.version) {
        problems.push(
          `拒绝写入：现清单版本 ${manifest.version}，而 ${pkg.dir}/package.json 是 ${entry.version}。`
          + ` 升级请显式加 --accept-version ${entry.version}（避免"换了目录、清单悄悄跟走"）`,
        );
        continue;
      }
      // 本地补丁记录必须原样保留：一次 `--write` 不能把"改过上游"这个事实抹回"未改动"。
      // 补丁文件的字节又变了（补丁本身被改）时拒绝写入 —— 静默吞掉旧记录等于篡改证据。
      const nextFiles = Object.fromEntries(files.map((f) => [f, sha256(readFileSync(join(dirAbs, f)))]));
      const patches = Array.isArray(manifest?.patches) ? manifest.patches : [];
      const stale = patches.filter((p) => !p || typeof p.file !== 'string' || nextFiles[p.file] !== p.local_sha256);
      if (stale.length) {
        problems.push(`拒绝写入：${stale.map((p) => p?.file || '(未命名)').join(', ')} 的补丁记录与实际字节不符。`
          + ' 补丁内容真的改了，就先人工更新 patches（upstream/local 两个 hash），再重跑 --write');
        continue;
      }
      const defaultNote = pkg.notAnNpmDependency
        ? '逐文件 sha256 来自上游发布 tarball 原样解包（未改动）。校验：node scripts/verify-vendor.mjs'
        : '逐文件 sha256 来自 npm 发布物原样复制（未改动）。校验：node scripts/verify-vendor.mjs';
      const next = {
        schema_version: SCHEMA,
        package: pkg.name,
        version: entry.version,
        license: upstreamPkg.license || pkg.license,
        upstream: {
          repository: pkg.upstream,
          tarball: lockVersion(root, pkg.name).resolved || null,
          integrity: lockVersion(root, pkg.name).integrity || null,
          // 非 npm 依赖没有 lock 条目可填，版本锚在上游 tarball 的 sha256 上。
          // `--write` 必须**保留**手写的那几个字段，否则一次重写就把唯一的版本锚抹掉了
          // （"重写清单"变成"丢掉证据"是最容易发生、也最难察觉的一类退化）。
          ...(pkg.notAnNpmDependency ? {
            tarball: manifest?.upstream?.tarball ?? null,
            tarball_sha256: manifest?.upstream?.tarball_sha256 ?? null,
            source_repository: manifest?.upstream?.source_repository ?? null,
            source_repository_public: manifest?.upstream?.source_repository_public ?? null,
            snapshot_commit: manifest?.upstream?.snapshot_commit ?? null,
            snapshot_commit_date: manifest?.upstream?.snapshot_commit_date ?? null,
          } : {}),
        },
        vendored_at: pkg.dir,
        modified: patches.length > 0,
        note: patches.length > 0 ? (manifest?.note ?? defaultNote) : defaultNote,
        patches,
        omitted: manifest?.omitted || [],
        files: nextFiles,
      };
      if (pkg.notAnNpmDependency) {
        next.distribution_scope = manifest?.distribution_scope ?? null;
        next.integrity = manifest?.integrity ?? null;
      }
      writeFileSync(manifestFile, JSON.stringify(next, null, 2) + '\n');
      entry.written = true;
      continue;
    }

    if (parseError) {
      problems.push(`${pkg.dir}/${MANIFEST_NAME} 解析失败：${parseError}`);
      continue;
    }
    if (!manifest) {
      problems.push(`${pkg.dir}/${MANIFEST_NAME} 缺失：内置副本没有清单就无法证明"装到手里的和审过的是同一份"`);
      continue;
    }
    if (manifest.schema_version !== SCHEMA) {
      problems.push(`${MANIFEST_NAME} schema 版本不符：${manifest.schema_version}（期望 ${SCHEMA}）`);
    }
    if (manifest.package !== pkg.name) {
      problems.push(`${MANIFEST_NAME} 记录的包名 ${manifest.package} ≠ 目录约定 ${pkg.name}`);
    }
    if (manifest.version !== entry.version) {
      problems.push(
        `${MANIFEST_NAME} 版本 ${manifest.version} ≠ ${pkg.dir}/package.json 版本 ${entry.version}`
        + '（换过目录内容却没重写清单；或清单被手改）',
      );
    }

    // ① 文件集完全一致（多一个少一个都算漂移）
    const want = Object.keys(manifest.files || {}).sort();
    for (const f of files) if (!want.includes(f)) problems.push(`${pkg.dir}/${f} 不在清单里（新增了未登记的文件）`);
    for (const f of want) if (!files.includes(f)) problems.push(`${pkg.dir}/${f} 清单有、磁盘无（内置副本被删改）`);

    // ② 逐文件内容哈希
    for (const f of files.filter((x) => want.includes(x))) {
      const live = sha256(readFileSync(join(dirAbs, f)));
      const pinned = manifest.files[f];
      if (live !== pinned) problems.push(`${pkg.dir}/${f} 内容与清单不符：清单 ${pinned} 实况 ${live}`);
    }

    // ③ 本地补丁记录：`modified` 与 `patches` 必须互相对得上，且补丁文件要对得上账。
    //    只记录"改过"而不把改动钉在 hash 上，等于给了个可以随手重写 manifest 的后门。
    const patches = Array.isArray(manifest.patches) ? manifest.patches : [];
    if (manifest.modified === true && patches.length === 0) {
      problems.push(`${pkg.dir}/${MANIFEST_NAME} 声称 modified:true 却没有 patches 记录`);
    }
    if (manifest.modified !== true && patches.length > 0) {
      problems.push(`${pkg.dir}/${MANIFEST_NAME} 有 patches 却记 modified:${manifest.modified}（两者必须一致）`);
    }
    for (const p of patches) {
      const name = p && typeof p.file === 'string' ? p.file : null;
      if (!name || !files.includes(name)) { problems.push(`${pkg.dir}/${MANIFEST_NAME} 的补丁记录指向不存在的文件：${name ?? '(未命名)'}`); continue; }
      if (manifest.files?.[name] !== p.local_sha256) {
        problems.push(`${pkg.dir}/${name} 的补丁记录与实际字节不符：记录 ${p.local_sha256} 实况 ${manifest.files?.[name]}`);
      }
      if (!/^sha256:[0-9a-f]{64}$/.test(String(p.upstream_sha256)) || p.upstream_sha256 === p.local_sha256) {
        problems.push(`${pkg.dir}/${name} 的补丁记录没有区分 upstream/local（两个 hash 必须不同且都是 sha256）`);
      }
    }
    entry.patches = patches.length;

    // ④ 与 npm 侧版本比对：落后/超前都要人看一眼
    if (pkg.notAnNpmDependency) {
      // 它不是 npm 依赖：没有 lock 条目是**预期**，理由是"我们不从 npm 装它"，
      // 不是"lock 恰好没写"。两者混成同一句 NOT_RUN 就掩盖了真正的漂移风险，
      // 所以版本锚在别处 —— 清单里记 tarball 的 sha256（见 upstream.tarball_sha256）。
      skipped.push({
        check: `vendor/${pkg.name} 版本漂移比对`,
        reason: `不是 npm 依赖（不走 registry）：版本锚是 tarball sha256，见 ${pkg.dir}/${MANIFEST_NAME} 的 upstream.tarball_sha256`,
      });
    } else {
      const lv = lockVersion(root, pkg.name);
      if (lv.version === null) {
        skipped.push({ check: `vendor/${pkg.name} 版本漂移比对`, reason: lv.reason });
      } else if (lv.version !== entry.version) {
        problems.push(
          `内置副本落后/不一致：npm 侧 ${pkg.name}@${lv.version}，内置 ${entry.version}`
          + `（升级：见 CONTRIBUTING.md「内置第三方依赖的升级」）`,
        );
      }
      entry.npmSide = lv.version;
    }

    // ⑤ 自带内层清单的包：内层清单必须能读出、且它记的版本与外层一致。
    //    这里**不**替它核对内层 hash（那是它自己的 provenance.mjs 的事，双向查夹带）。
    //    我们只回答一个问题：**这份内层证据在不在这、说的是不是同一个版本**。
    //    不查内层会让"清单里记了一个上游，实际内层清单指向别的版本"蒙混过关。
    if (pkg.upstreamProvenance) {
      const inner = join(dirAbs, pkg.upstreamProvenance);
      if (!existsSync(inner)) {
        problems.push(`${pkg.dir}/${pkg.upstreamProvenance} 缺失：登记表声明它自带内层来源清单`);
      } else {
        let parsed = null;
        try { parsed = JSON.parse(readFileSync(inner, 'utf8')); }
        catch (err) { problems.push(`${pkg.dir}/${pkg.upstreamProvenance} 解析失败：${err.message}`); }
        if (parsed) {
          const innerVer = /(\d+\.\d+\.\d+)/.exec(String(parsed.package || ''))?.[1];
          if (innerVer && innerVer !== entry.version) {
            problems.push(
              `${pkg.dir}/${pkg.upstreamProvenance} 的内层版本 ${innerVer} ≠ 外层 ${entry.version}`
              + '（内外两层清单指向不同版本 = 至少有一层在说别的版本）',
            );
          }
          entry.innerProvenance = { file: pkg.upstreamProvenance, package: parsed.package ?? null, files: (parsed.files || []).length };
        }
      }
    }
  }

  // ④ 不得有代码回退到裸说明符：内置之后还用裸包名 import 一次，就等于同时依赖两套实现。
  //    （本行注释刻意不写出那个说明符的字面形式——否则校验器会命中自己，见 R0-116 的教训）
  const hits = write ? [] : scanBareSpecifiers(root, VENDORED.map((p) => p.name));
  for (const h of hits) {
    problems.push(`${h.file}:${h.line} 仍然裸引用 '${h.spec}'：内置之后必须走 ${VENDORED.find((p) => p.name === h.spec).dir}/`);
  }
  info.bareSpecifiers = hits;

  return { ok: problems.length === 0, problems, skipped, info };
}

function main() {
  const argv = process.argv.slice(2);
  const write = argv.includes('--write');
  const json = argv.includes('--json');
  const rootIdx = argv.indexOf('--root');
  const root = rootIdx >= 0 ? argv[rootIdx + 1] : DEFAULT_ROOT;
  const avIdx = argv.indexOf('--accept-version');
  const acceptVersion = avIdx >= 0 ? argv[avIdx + 1] : null;

  if (rootIdx >= 0 && !root) {
    console.error('--root 需要一个目录参数');
    process.exit(2);
  }

  const result = verifyVendor({ root, write, acceptVersion });
  if (json) {
    console.log(JSON.stringify({ ok: result.ok, problems: result.problems, skipped: result.skipped, info: result.info }, null, 2));
  } else if (write && result.ok) {
    for (const p of result.info.packages) {
      console.log(`  ✓ 已写入 ${p.dir}/${MANIFEST_NAME}：${p.name}@${p.version}，${p.files} 文件 / ${p.bytes} B`);
    }
  } else if (result.ok) {
    for (const p of result.info.packages) {
      const npmSide = p.npmSide ? `（npm 侧 ${p.npmSide}）` : '';
      console.log(`  ✓ ${p.dir}：${p.name}@${p.version}${npmSide}，${p.files} 文件 / ${p.bytes} B，逐文件 sha256 一致`);
    }
    for (const s of result.skipped) console.log(`  · [NOT_RUN] ${s.check}：${s.reason}`);
    console.log('内置依赖完整性校验通过');
  } else {
    console.error(`内置依赖完整性校验 FAIL（${result.problems.length} 项）：`);
    for (const p of result.problems) console.error(`   · ${p}`);
    console.error('\n内置副本是发布物的一部分：要么恢复原样，要么按 CONTRIBUTING.md 的升级流程显式重写清单。');
  }
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) main();
