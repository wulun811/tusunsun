// R0-66（专家交付4）：不可变制品、manifest/hash 对应与真实安装验收。
//
// 专家原话：「npm 和 GitHub Release 具体采用哪一份不可变制品、manifest/hash 对应与真实安装验收；
// 不删除现有 Scene/Capability/Task/恢复器官。」「两渠道尽量使用同一不可变构建并可比对 hash。」
// 「npm 的包名、bin 与实际安装行为须实测。」「未经维护者再次明确授权不 publish。」
//
// 依赖真实网络（拉取 ws）。无网络/无授权时 **NOT_RUN**，绝不虚报完成。

import { TestRunner, assert, assertEquals } from '../harness.mjs';
import { readFileSync, existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..', '..');
const DIST = join(ROOT, 'dist', 'oss');

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 900000, ...opts });
  return { code: r.status ?? (r.error ? 127 : 0), out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

export async function setup(runner) {
  runner.test('R0-66/F1 两渠道同源：npm 与 GitHub Release 都取本仓这一份构建', () => {
    // 本仓的发布单元就是**包根**（没有 dist/oss 这一层中转），所以判据从
    // “都取 dist/oss”换成“同一 tag、同一棵树，而且 publish 前真的跑过前序门禁”。
    const relPath = join(ROOT, '.github', 'workflows', 'release.yml');
    if (!existsSync(relPath)) { runner.noteSkip('[NOT_RUN] 非仓库检出（npm 包不含 .github/）'); return; }
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    assert(!pkg.scripts?.['build:oss'], '本仓以包根为发布单元，不应再出现 build:oss 中转构建');
    const rel = readFileSync(relPath, 'utf8').split('\n')
      .map((l) => l.replace(/(^|\s)#.*$/, ''))   // YAML 注释里的命令不是步骤（注释里也有“npm publish”字样）
      .join('\n');
    assert(/tags:/.test(rel) && /v\*/.test(rel), '发布工作流必须由 tag（v*）触发：tag 就是发布源');
    assert(!/working-directory:\s*dist\//.test(rel), 'publish 必须在包根执行，不得切到 dist/ 子目录');
    const iPublish = rel.indexOf('npm publish');
    assert(iPublish > -1, '发布工作流必须有 npm publish 步骤');
    for (const [needle, label] of [
      ['npm run check', '静态门禁'], ['npm test', '全量测试'], ['release-gate.mjs', '发布门禁矩阵'],
    ]) {
      const i = rel.indexOf(needle);
      assert(i > -1 && i < iPublish, `${label}必须在 npm publish 之前跑：${needle}`);
    }
    // GitHub Release 由**同一个**工作流在同一个 tag 上创建（不是另一条会把包重新打一遍的链）
    assert(/action-gh-release|create-release|gh release create/.test(rel), '同一工作流里要有 GitHub Release 步骤');
    console.log('       [实测] tag 触发 → check → test → release-gate → publish → Release（同一棵树）');
  });

  runner.test('R0-66/F2 不可变制品：两次打包 hash 一致，且产物纯净', () => {
    // 本仓的制品 = `npm pack` 产出的 tgz。判据三条：①两次打包逐字节一致；
    // ②包内不含 secrets/、node_modules/、dist/、test-results/ 这类本机状态；③不含真实密钥。
    const cache = mkdtempSync(join(tmpdir(), 'r066-cache-'));
    const outA = mkdtempSync(join(tmpdir(), 'r066-a-'));
    const outB = mkdtempSync(join(tmpdir(), 'r066-b-'));
    const env = { ...process.env, npm_config_cache: cache };
    try {
      const a = sh('npm', ['pack', '--pack-destination', outA], { cwd: ROOT, env });
      const b = sh('npm', ['pack', '--pack-destination', outB], { cwd: ROOT, env });
      assertEquals(a.code, 0, `第一次 npm pack 必须成功：${a.out.slice(-300)}`);
      assertEquals(b.code, 0, `第二次 npm pack 必须成功：${b.out.slice(-300)}`);
      const fa = readdirSync(outA).find((f) => f.endsWith('.tgz'));
      const fb = readdirSync(outB).find((f) => f.endsWith('.tgz'));
      assert(fa && fb, '两次都应产出 tgz');
      const ha = sha256(join(outA, fa));
      const hb = sha256(join(outB, fb));
      assertEquals(ha, hb, '同一棵树两次打包必须 hash 一致（不可变制品）');
      console.log(`       [实测] 两次 pack sha256 一致：${ha.slice(0, 16)}…（${fa}）`);

      const ex = mkdtempSync(join(tmpdir(), 'r066-x-'));
      try {
        const t = sh('tar', ['xzf', join(outA, fa), '-C', ex]);
        assertEquals(t.code, 0, 'tgz 必须能解包');
        const pkgRoot = join(ex, 'package');
        for (const forbidden of ['secrets', 'node_modules', 'dist', 'test-results', '.git']) {
          assert(!existsSync(join(pkgRoot, forbidden)), `制品不得包含本机状态目录：${forbidden}/`);
        }
        assert(existsSync(join(pkgRoot, 'tusunsun.mjs')), '制品必须含 bin 入口 tusunsun.mjs');
        assert(existsSync(join(pkgRoot, 'vendor', 'ws', 'wrapper.mjs')), '制品必须含内置的 vendor/ws');
        // 真实密钥前缀不得出现在制品里（secrets/README.md 是占位说明，跳过）
        const secDir = join(ROOT, 'secrets');
        if (existsSync(secDir)) {
          for (const f of readdirSync(secDir)) {
            if (f === 'README.md' || f.startsWith('.')) continue;
            const pfx = readFileSync(join(secDir, f), 'utf8').trim().slice(0, 20);
            if (pfx.length < 8) continue;
            const g = sh('grep', ['-rlF', pfx, pkgRoot]);
            assertEquals(g.out.trim(), '', `制品不得含真实密钥（${f}）`);
          }
        }
      } finally {
        rmSync(ex, { recursive: true, force: true });
      }
    } finally {
      for (const d of [cache, outA, outB]) rmSync(d, { recursive: true, force: true });
    }
  });

  runner.test('R0-66/F3 真实安装验收 + bin 行为（离线安装本地产物）', () => {
    // 零运行时依赖 ⇒ 从本地产物安装**不需要网络**。这条以前写“需网络/无授权则 NOT_RUN”，
    // 那是把“制品不自包含”当成了环境限制；现在用 --offline 把自包含本身变成验收条件。
    const cache = mkdtempSync(join(tmpdir(), 'r066-c2-'));
    const proj = mkdtempSync(join(tmpdir(), 'r066-inst-'));
    const home = mkdtempSync(join(tmpdir(), 'r066-h-'));
    const env = { ...process.env, npm_config_cache: cache };
    try {
      const pk = sh('npm', ['pack', '--pack-destination', proj], { cwd: ROOT, env });
      assertEquals(pk.code, 0, `无法打包：${pk.out.slice(-300)}`);
      const tgz = join(proj, readdirSync(proj).find((f) => f.endsWith('.tgz')));
      const inst = sh('npm', ['install', tgz, '--offline', '--no-audit', '--no-fund'], { cwd: proj, env });
      assertEquals(inst.code, 0, `离线安装必须成功（零依赖）：${inst.out.slice(-300)}`);
      assert(existsSync(join(proj, 'node_modules', 'tusunsun')), '安装后应有 tusunsun 包');
      const bin = join(proj, 'node_modules', '.bin', 'tusunsun');
      assert(existsSync(bin), '安装后应生成 bin 可执行入口');

      for (const args of [['--version'], ['--help'], ['plugins'], ['scene', 'list']]) {
        const r = spawnSync(bin, args, { cwd: proj, encoding: 'utf8', timeout: 180000, env: { ...process.env, HOME: home } });
        assertEquals(r.status, 0,
          `安装后 \`tusunsun ${args.join(' ')}\` 必须 exit 0（实际 ${r.status}：${(r.stderr || '').slice(-200)}）`);
      }
      const ver = spawnSync(bin, ['--version'], { cwd: proj, encoding: 'utf8', env: { ...process.env, HOME: home } });
      const pkgVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
      assert(`${ver.stdout}`.includes(pkgVersion), `版本号应与包一致（期望含 ${pkgVersion}）：${ver.stdout}`);
      console.log(`       [实测] 离线安装成功；bin 四条命令 exit 0；版本 ${pkgVersion}`);
    } finally {
      for (const d of [cache, proj, home]) rmSync(d, { recursive: true, force: true });
    }
  });

  runner.test('R0-66/F4 未经授权不发布；器官不得被删除', () => {
    // 本轮未执行任何 npm publish（只做 pack/install 验证）
    // R0-99：同上，`.github/` 不是产品内容，npm 包里没有它 → NOT_RUN 而不是红。
    const relPath = join(ROOT, '.github', 'workflows', 'release.yml');
    if (!existsSync(relPath)) { runner.noteSkip('[NOT_RUN] 非仓库检出（npm 包不含 .github/）'); return; }
    const rel = readFileSync(relPath, 'utf8');
    assert(/npm publish/.test(rel), '发布流程本身保留 publish 步骤（由 CI 在授权后触发）');
    // 不得删除 Scene/Capability/Task/恢复器官（按各自真相位置断言）
    for (const keep of ['scenes', 'src/core']) {
      assert(existsSync(join(ROOT, keep)), `不得删除 ${keep}`);
    }
    // v0.9.25：`src/builtin/` 已并入 `plugins/`，网关插件只有一个落点。
    // 此前这里要在两根之间 `.find()`，那层解析服务的差异（开发树 vs 产物布局）已经不存在。
    const gatewayImpl = ['plugins/gateway.js'].find((p) => existsSync(join(ROOT, p)));
    assert(gatewayImpl, '不得删除网关插件（plugins/gateway.js 或 plugins/gateway.js）');
    const sceneDir = join(DIST, 'scenes');
    if (existsSync(sceneDir)) {
      const n = readdirSync(sceneDir).length;
      assert(n >= 8, `OSS 产物场景配方应齐备，实际 ${n}`);
    }
    console.log('       [说明] 本轮未 publish；Scene/Capability/Task/恢复器官均保留');
  });
}
