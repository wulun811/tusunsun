import { TestRunner } from './harness.mjs';
import { globFiles } from './glob-files.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, relative } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function findIntegrationTests() {
  const patterns = ['integration/**/*.mjs', 'integration/**/*.test.mjs'];
  const files = new Set();
  for (const pattern of patterns) {
    for (const f of await globFiles(join(__dirname, pattern))) files.add(f);
  }
  return [...files].sort();
}

async function main() {
  const testFiles = await findIntegrationTests();
  if (testFiles.length === 0) {
    console.error('[run-integration][FAIL] 在 test/integration/ 下未发现任何用例 —— 0 用例不等于通过');
    process.exit(1);
  }

  const runner = new TestRunner({ name: 'Integration Tests' });
  const loadFailures = [];

  for (const file of testFiles) {
    runner.setCurrentFile(file);
    try {
      const mod = await import(pathToFileURL(file).href);
      if (mod.default && typeof mod.default === 'function') {
        await mod.default(runner);
      } else if (mod.setup && typeof mod.setup === 'function') {
        await mod.setup(runner);
      } else {
        loadFailures.push({ file, reason: '无合法入口（缺 default/setup 导出）' });
      }
    } catch (e) {
      loadFailures.push({ file, reason: e?.stack || String(e) });
    }
  }

  // import 失败 / 无合法入口必须变成 failed 用例：只 console.error 不计数时，
  // 文件坏没坏都不影响退出码，整个目录可以消失而套件仍然全绿。
  if (loadFailures.length > 0) {
    runner.setCurrentFile(join(__dirname, '(load-failures)'));
    for (const f of loadFailures) {
      const name = relative(__dirname, f.file);
      console.error(`[run-integration] ${name} 未被实际执行：${f.reason}`);
      runner.test(`load: ${name}`, () => { throw new Error(`${name} 未被实际执行：${f.reason}`); });
    }
  }

  if (runner.tests.length === 0) {
    console.error('[run-integration][FAIL] 没有注册任何用例 —— 0 用例不等于通过');
    process.exit(1);
  }

  await runner.run();
  // 集成夹具常有子进程/定时器，事件环不会自动排空；按用例结果显式退场，
  // 避免上层聚合器把挂住的成功套件按超时误判为 FAIL。
  process.exit(runner.results.failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
