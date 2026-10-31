import { TestRunner, assert, assertEquals } from '../harness.mjs';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgVersion = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8')).version;

export async function setup(runner) {
  let originalArgv;
  let originalStdoutWrite;
  let stdoutOutput;

  runner.beforeEach(() => {
    originalArgv = process.argv;
    originalStdoutWrite = process.stdout.write.bind(process.stdout);
    stdoutOutput = '';
    process.stdout.write = (chunk) => { stdoutOutput += chunk; return true; };
  });

  runner.afterEach(() => {
    process.argv = originalArgv;
    process.stdout.write = originalStdoutWrite;
  });

  runner.test('CLI: --version flag outputs version', async () => {
    const { main } = await import('../../src/bootstrap/cli.js');
    process.argv = ['node', 'cli.js', '--version'];
    await main();
    assert(stdoutOutput.includes(pkgVersion), `Should output package version ${pkgVersion}`);
  });

  runner.test('CLI: -v flag outputs version', async () => {
    const { main } = await import('../../src/bootstrap/cli.js');
    process.argv = ['node', 'cli.js', '-v'];
    await main();
    assert(stdoutOutput.includes(pkgVersion), `Should output package version ${pkgVersion}`);
  });
}
