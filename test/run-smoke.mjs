import { IntegrationTestRunner } from './harness.mjs';
import { globFiles } from './glob-files.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function findSmokeTests() {
  const patterns = ['*_smoke.mjs', 'smoke/**/*.mjs'];
  const files = new Set();
  for (const pattern of patterns) {
    for (const f of await globFiles(join(__dirname, pattern))) {
      if (f.includes('run-')) continue;
      files.add(f);
    }
  }
  return [...files].sort();
}

async function main() {
  const testFiles = await findSmokeTests();
  if (testFiles.length === 0) {
    console.error('[run-smoke][FAIL] 未发现任何冒烟用例 —— 0 用例不等于通过');
    process.exit(1);
  }

  const runner = new IntegrationTestRunner({ name: 'Smoke Tests' });

  for (const file of testFiles) {
    runner.test(file.replace(__dirname + '/', ''), file, { timeout: 30000 });
  }

  await runner.run();
}

main().catch(e => { console.error(e); process.exit(1); });
