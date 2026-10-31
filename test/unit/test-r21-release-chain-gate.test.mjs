// P0-1：发布链必须跑门禁。
//
// 这条曾经是真的：`release.yml` 只有 `npm test` → `npm publish`，`npm run check` 与
// `release-gate.mjs` 不在任何自动化路径上。会变成真的原因也很具体 —— 门禁只写在文档里，
// 没有任何一条测试盯着工作流文件。这里盯住三件事：门禁命令在链上、发布有第二条闸、
// CI 不再跑已放弃的 Node 18。
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert } from '../harness.mjs';
import { requireRepoOnly, describeCarrier } from '../lib/carrier.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

export async function setup(runner) {
  runner.test('P0-1/1 release.yml 在 publish 之前跑 npm run check 与 release-gate', async () => {
    // npm 发行包不含 `.github/`（见 test/lib/carrier.mjs）⇒ 发行包里如实记 NOT_RUN；
    // 源码检出里这条照旧是硬门。
    if (!requireRepoOnly(runner, ROOT, 'release.yml 在 publish 之前跑门禁')) return;
    const yml = read('.github/workflows/release.yml');
    // 只看 `run:` 行：文件头注释里也提到这些命令，按 substring 定位会自欺。
    const iCheck = yml.indexOf('run: npm run check');
    const iGate = yml.indexOf('run: node scripts/release-gate.mjs');
    const iPublish = yml.indexOf('run: npm publish');
    assert(iCheck > 0, 'release.yml 必须跑 npm run check');
    assert(iGate > 0, 'release.yml 必须跑 scripts/release-gate.mjs');
    assert(iCheck < iPublish, 'npm run check 必须在 publish 之前');
    assert(iGate < iPublish, 'release-gate 必须在 publish 之前');
  });

  runner.test('P0-1/2 package.json 有 prepublishOnly（绕过 CI 直接 publish 也有闸）', async () => {
    const pkg = JSON.parse(read('package.json'));
    assert(typeof pkg.scripts.prepublishOnly === 'string', '缺少 prepublishOnly');
    assert(/npm run check/.test(pkg.scripts.prepublishOnly), 'prepublishOnly 必须跑门禁');
  });

  runner.test('P0-1/3 CI 不再跑已放弃的 Node 18', async () => {
    // 工作流文件是仓库专属材料：npm 发行包里记 NOT_RUN，源码检出里照旧是硬门。
    if (!requireRepoOnly(runner, ROOT, '工作流矩阵不再含 Node 18')) return;
    for (const rel of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
      const yml = read(rel);
      assert(!/node-version:\s*'18'/.test(yml), `${rel} 仍在跑 Node 18`);
      assert(!/\['18'/.test(yml), `${rel} 矩阵仍含 Node 18`);
    }
    console.log(`       [实测] ${describeCarrier(ROOT)}；两份工作流均无 Node 18`);
  });

  // engines 是**产品事实**（两种载体都在），不能因为原来看它跟工作流写在同一个用例里，
  // 就让 npm 发行包把「Node 22+」这条也一起跳过。拆出来单列。
  runner.test('P0-1/4 package.json engines 声明 Node 22+', async () => {
    const pkg = JSON.parse(read('package.json'));
    assert(pkg.engines.node === '>=22.0.0', 'engines 与工作流矩阵必须一致（Node 18 已放弃）');
    console.log(`       [实测] engines.node=${pkg.engines.node}；${describeCarrier(ROOT)}`);
  });
}
