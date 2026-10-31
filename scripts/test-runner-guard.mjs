#!/usr/bin/env node
// 静态护栏：test/unit 与 test/integration 由自研 harness 驱动，不得导入 node:test。
// node --test 不会调用 setup()，会把 0 个断言报成通过；这个脚本让误用在校验阶段就可见。
//
// 用法：node scripts/test-runner-guard.mjs [--root <dir>]
// 退出码：0 = 无违规；1 = 有违规或找不到扫描目标；2 = 用法错误。
// 接线：已接在 `npm run check` 的链里（与行预算/核心指纹/注释/内置依赖同一道门）。
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scanHarnessTests } from '../test/lib/node-test-guard.mjs';

export function main(argv = process.argv.slice(2)) {
  const i = argv.indexOf('--root');
  if (i >= 0 && !argv[i + 1]) {
    console.error('[test-runner-guard] --root 需要一个目录');
    return 2;
  }
  const root = i >= 0 ? argv[i + 1] : join(dirname(fileURLToPath(import.meta.url)), '..');
  const { files, violations } = scanHarnessTests(root);
  console.log(`[test-runner-guard] 扫描 ${files.length} 个 harness 用例（test/unit + test/integration）`);
  if (files.length === 0) {
    console.error('[test-runner-guard][FAIL] 一个用例都没找到 —— 护栏没有目标，不能算通过');
    return 1;
  }
  if (violations.length === 0) {
    console.log('[test-runner-guard][OK] 无 node:test 误用');
    return 0;
  }
  for (const v of violations) console.error(`[test-runner-guard][FAIL] ${v.file}: ${v.reason}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
