// R0-159 独立探针：沙箱路径判据是否可被符号链接绕过。
//
// **状态：v0.9.33 已修复。** 现在跑它是绿的（3/3 FIXED）。
//
// 历史：v0.9.32 送审包里这条是**红的** —— 沙箱只做词法 `resolve()`，工具层追 realpath，
// 于是 `ws/vault -> deny 目录` 时沙箱放行、磁盘内容真被改，而同一路径工具层拒绝。
// 送审报告 §1.1 把它排第一。v0.9.33 的 S1 把物理归一化抽成
// `plugins/_lib/real-path.mjs` 让两侧共用，缺口关闭。
//
// 为什么保留这个文件（而不是删掉）：回归锁
// `test/unit/test-s1-s2-s3-execution-boundary.test.mjs` 守"不许退化"，它需要 runner 与
// 断言风格；这个探针是**可独立运行、不依赖测试框架**的最小复现 —— 拿到包的人
// `node test/probes/r0-159-sandbox-symlink-bypass.mjs` 就能自己核对，不必信我的报告。
//
// 用法：node test/probes/r0-159-sandbox-symlink-bypass.mjs
//
// 退出码：0 = 已修（FIXED）；1 = 缺陷仍在（BUG）。**故意反直觉** —— 见下方说明。

import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (rel) => import(join(ROOT, rel));

const cases = [];
const record = (name, buggy, detail) => {
  cases.push({ name, buggy, detail });
  console.log(`  ${buggy ? 'BUG  ' : 'FIXED'} ${name}`);
  if (detail) console.log(`        ${detail}`);
};

async function main() {
  const { Core } = await imp('src/core/core.js');

  // ── 场景：deny 目录里的文件，被一个工作区内的符号链接指过去 ──────────────
  const d = mkdtempSync(join(tmpdir(), 'r159-'));
  const ws = join(d, 'ws');
  const secretDir = join(d, 'secret');
  mkdirSync(ws);
  mkdirSync(secretDir);
  writeFileSync(join(secretDir, 'k.txt'), 'ORIGINAL');

  try {
    const core = new Core({ stateDir: join(d, 'state') });
    core.log = () => {};
    core.setData('agent.workDir', ws);
    // sandbox 从 `core.get(...)` 读配置；给一个只提供 deny/writeAllow 的最小 config 服务。
    core.registerService('config', {
      get: (k, fb) => (k === 'sandbox.deny' ? [secretDir] : k === 'sandbox.writeAllow' ? [] : fb),
    });

    const S = (await imp('plugins/sandbox.js')).default;
    await S.init(core);

    // ① 基线：直接写 deny 目录内的文件，必须被拒（证明 deny 列表本身是生效的）
    const direct = await S.execute('write', { path: join(secretDir, 'k.txt'), content: 'HACKED-DIRECT' });
    record('直接写 deny 目录内的文件 → 应拒绝', direct.ok === true,
      direct.ok ? '放行了！deny 列表根本没生效（这是更严重的问题）' : '已拒绝（deny 列表本身生效）');

    // ② 关键反例：经工作区内的符号链接写同一目录
    symlinkSync(secretDir, join(ws, 'vault'));
    const viaLink = await S.execute('write', { path: join(ws, 'vault', 'k.txt'), content: 'HACKED-VIA-LINK' });
    const content = readFileSync(join(secretDir, 'k.txt'), 'utf8');
    const actuallyWrote = content === 'HACKED-VIA-LINK';
    record('经符号链接写 deny 目录 → 应拒绝', viaLink.ok === true || actuallyWrote,
      viaLink.ok
        ? `被判据放行；磁盘内容现在 = ${JSON.stringify(content)}（原为 "ORIGINAL"）`
        : '已拒绝');

    // ③ 对照：工具层的同一条路径必须拒绝（证明两层强度不同 —— 这是 §1.1 的核心论据）
    const { resolveWorkspacePath } = await imp('plugins/tools/lib/workspace.mjs');
    let toolLayerRejected = false;
    try { await resolveWorkspacePath(ws, 'vault/k.txt'); } catch { toolLayerRejected = true; }
    record('对照｜工具层 resolveWorkspacePath 对同一路径 → 应拒绝', !toolLayerRejected,
      toolLayerRejected ? '已拒绝（工具层追 realpath）' : '放行了 —— 两层都没拦住，问题更大');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }

  const bugs = cases.filter((c) => c.buggy);
  console.log('');
  console.log(`  合计 ${cases.length} 项，仍存在 ${bugs.length} 项缺陷`);
  if (bugs.length) {
    console.log('');
    console.log('  说明：本探针在有缺陷时以 1 退出。');
    console.log('  若这一行出现，说明 v0.9.33 的 S1 修复**退化**了 —— 请对照');
    console.log('  test/unit/test-s1-s2-s3-execution-boundary.test.mjs 的 S1 系列。');

    return 1;
  }
  console.log('');
  console.log('  §1.1 的缺口已修复（v0.9.33 / S1）。回归锁见 test/unit/test-s1-s2-s3-execution-boundary.test.mjs。');
  return 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error('probe failed to run:', e);
  process.exit(2);
});
