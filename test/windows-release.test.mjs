// Portable release-entry regression. TUI input is piped, not a ConPTY test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const accept = join(root, 'scripts', 'install-acceptance.mjs');
const nodeDir = dirname(process.execPath);
const npm = [process.env.npm_execpath, join(nodeDir, 'node_modules/npm/bin/npm-cli.js'),
  join(nodeDir, '../lib/node_modules/npm/bin/npm-cli.js')].find((p) => p && existsSync(p));
assert.ok(npm, 'npm JS entry must be available');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function run(argv, options = {}) {
  const r = spawnSync(process.execPath, argv, { cwd: root, encoding: 'utf8', timeout: 120000, ...options });
  assert.equal(r.status, 0, `${r.error || ''}\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}
function launch(argv, options) {
  const c = spawn(process.execPath, argv, { stdio: ['pipe', 'pipe', 'pipe'], ...options });
  c.output = '';
  c.stdout.on('data', (d) => { c.output += d; });
  c.stderr.on('data', (d) => { c.output += d; });
  c.done = new Promise((resolve, reject) => { c.once('error', reject); c.once('close', resolve); });
  return c;
}
async function until(check, detail) {
  for (let i = 0; i < 300; i++) { if (check()) return; await delay(100); }
  throw new Error(`Timed out: ${detail()}`);
}

test('pack without PATH tools computes exact SHA-256; Windows npm.cmd resolves without shell', () => {
  const work = mkdtempSync(join(tmpdir(), 'tss hash space-'));
  try {
    const tgz = join(work, 'fixture with spaces.tgz');
    const bytes = Buffer.from('hash fixture');
    writeFileSync(tgz, bytes);
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
    env.PATH = '';
    const out = run([accept, '--pack-only', '--tgz', tgz], { env });
    assert.ok(out.includes(createHash('sha256').update(bytes).digest('hex')));
    if (process.platform === 'win32') {
      run([accept, '--pack-only', '--npm-cli', join(nodeDir, 'npm.cmd')]);
    }
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('offline installed bin, npm start, authenticated TUI q input, status and stop', { timeout: 120000 }, async () => {
  const work = mkdtempSync(join(tmpdir(), 'tss release space-'));
  let gw, tui, port;
  const state = join(work, 'state');
  const env = { ...process.env, TUSUNSUN_STATE_DIR: state, TUSUNSUN_PROFILE: '',
    TUSUNSUN_GATEWAY_KEY: '', TUSUNSUN_API_KEY: '', LLM_API_KEY: '',
    TUSUNSUN_BASE_URL: '', TUSUNSUN_MODEL: '', TUSUNSUN_ALLOW_REMOTE: '', TUSUNSUN_MODEL_HEADERS: '' };
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  env[pathKey] = `${nodeDir}${delimiter}${env[pathKey] || ''}`;
  const installed = join(work, 'node_modules/tusunsun');
  const entry = join(installed, 'tusunsun.mjs');
  try {
    const packed = run([npm, 'pack', '--pack-destination', work]).trim().split('\n').pop();
    writeFileSync(join(work, 'package.json'), '{"private":true}');
    run([npm, 'install', '--offline', '--no-audit', '--no-fund', join(work, packed)], { cwd: work, env });
    const pkgVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
    assert.ok(run([npm, 'exec', '--offline', '--', 'tusunsun', '--version'], { cwd: work, env }).includes(pkgVersion),
      `--version 必须回显 package.json 的 ${pkgVersion}`);
    mkdirSync(state);
    writeFileSync(join(state, 'config.json'), JSON.stringify({ activeScene: 'gateway', model: {
      model: 'mock', apiKey: 'mock-key', baseUrl: 'http://127.0.0.1:1/v1' }, gateway: {
      host: '127.0.0.1', port: 0, apiKey: 'windows-entry-test' } }));
    gw = launch([npm, 'start', '--', '--port', '0', '--state-dir', state, '--yes'], { cwd: installed, env });
    const runtime = join(state, 'gateway.runtime.json');
    await until(() => {
      try { port = JSON.parse(readFileSync(runtime)).port; return port > 0; } catch { return false; }
    }, () => gw.output);
    assert.match(run([entry, 'status', '--port', String(port)], { cwd: work, env }).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ''), /Running:\s*yes/);
    tui = launch([entry, 'tui', '--port', String(port)], { cwd: work, env });
    await until(() => tui.output.includes('\x1b[?1049h'), () => tui.output);
    // Reaching the alternate screen means authenticated WS + chat.init completed.
    await delay(150);
    tui.stdin.write('q');
    await until(() => tui.exitCode !== null, () => tui.output);
    assert.equal(await tui.done, 0, tui.output);
    assert.doesNotMatch(tui.output, /无法连接 daemon|socket hang up/);
    run([entry, 'stop', '--port', String(port)], { cwd: work, env });
    await until(() => gw.exitCode !== null, () => gw.output);
    assert.equal(await gw.done, 0, gw.output);
    assert.equal(existsSync(runtime), false);
  } finally {
    if (tui && tui.exitCode === null) { tui.kill(); await tui.done; }
    if (port && existsSync(entry)) spawnSync(process.execPath, [entry, 'stop', '--port', String(port)], { cwd: work, env, timeout: 10000 });
    if (gw && gw.exitCode === null) { gw.kill(); await gw.done; }
    rmSync(work, { recursive: true, force: true });
  }
});
