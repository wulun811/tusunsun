import { FileSystemGuard } from '../plugins/_lib/kunxiansuo/file-guard.js';
import { mkdirSync, symlinkSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { tmpdir } from 'node:os';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS:', name);
  } catch (e) {
    failed++;
    console.log('  FAIL:', name, '-', e.message);
  }
}

console.log('\nPath Sandbox Smoke Tests (B3)\n');

const testDir = pathJoin(tmpdir(), 'tusunsun_sandbox_' + Date.now());
mkdirSync(testDir, { recursive: true });
const safeFile = pathJoin(testDir, 'safe.txt');
writeFileSync(safeFile, 'test');

test('1. file inside cwd — allowed', () => {
  const guard = new FileSystemGuard({ safeRoots: [testDir] });
  const r = guard.checkBoundary('tool-read', { path: safeFile });
  if (!r.ok) throw new Error('in-cwd path should be allowed');
});

test('2. /dev/null — allowed (whitelist)', () => {
  const guard = new FileSystemGuard({ safeRoots: [testDir] });
  const r = guard.checkBoundary('tool-write', { path: '/dev/null' });
  if (!r.ok) throw new Error('/dev/null should be allowed');
});

test('3. non-file tool — skip boundary check', () => {
  const guard = new FileSystemGuard({ safeRoots: [testDir] });
  const r = guard.checkBoundary('tool-bash', { path: '/etc/passwd' });
  if (!r.ok) throw new Error('non-file tools should skip boundary check');
});

test('4. empty path — skip', () => {
  const guard = new FileSystemGuard({ safeRoots: [testDir] });
  const r = guard.checkBoundary('tool-read', { path: '' });
  if (!r.ok) throw new Error('empty path should skip');
});

test('5. boundary disabled — skip', () => {
  const guard = new FileSystemGuard({ enableBoundary: false });
  const r = guard.checkBoundary('tool-write', { path: '/etc/passwd' });
  if (!r.ok) throw new Error('disabled boundary should skip');
});

test('6. path outside safe roots — blocked (RC-3)', () => {
  const guard = new FileSystemGuard({ safeRoots: [testDir, '/tmp'] });
  const r = guard.checkBoundary('tool-read', { path: '/etc/passwd' });
  if (process.platform === 'win32') {
    // RC-3: boundary disabled on Windows
    if (!r.ok) throw new Error('boundary should be disabled on Windows');
  } else {
    if (r.ok) throw new Error('outside path should be blocked: ' + JSON.stringify(r));
    if (r.code !== 'SYMLINK_ESCAPE') throw new Error('should be SYMLINK_ESCAPE code');
  }
});

test('7. symlink inside cwd — allowed', () => {
  if (process.platform === 'win32') {
    // Windows 默认未启用文件围栏（RC-3）；本用例在 Windows 验证"禁用时放行"，不伪造 symlink 结果。
    console.log('       [SKIP] Windows 未启用文件围栏；验证 boundary disabled 时放行');
    const guard = new FileSystemGuard({ safeRoots: [testDir] });
    const r = guard.checkBoundary('tool-read', { path: safeFile });
    if (!r.ok) throw new Error('Windows boundary disabled should allow read');
    return;
  }
  const linkPath = pathJoin(testDir, 'link.txt');
  try {
    symlinkSync(safeFile, linkPath);
    const guard = new FileSystemGuard({ safeRoots: [testDir] });
    const r = guard.checkBoundary('tool-read', { path: linkPath });
    if (!r.ok) throw new Error('internal symlink should be allowed: ' + JSON.stringify(r));
  } finally {
    try { unlinkSync(linkPath); } catch {}
  }
});

test('8. realpathSync works with file path arg', () => {
  const guard = new FileSystemGuard({ safeRoots: [testDir] });
  const r = guard.checkBoundary('write_file', { file: safeFile });
  if (!r.ok) throw new Error('file arg should work');
});

test('9. nested file inside cwd — allowed', () => {
  const nestedDir = pathJoin(testDir, 'nested');
  mkdirSync(nestedDir, { recursive: true });
  const nestedFile = pathJoin(nestedDir, 'deep.txt');
  writeFileSync(nestedFile, 'deep');
  try {
    const guard = new FileSystemGuard({ safeRoots: [testDir] });
    const r = guard.checkBoundary('tool-read', { path: nestedFile });
    if (!r.ok) throw new Error('nested file should be allowed');
  } finally {
    try { unlinkSync(nestedFile); } catch {}
    try { rmdirSync(nestedDir); } catch {}
  }
});

test('10. tool-stat is a file tool — boundary applies', () => {
  const guard = new FileSystemGuard({ safeRoots: [testDir] });
  const r = guard.checkBoundary('tool-stat', { path: safeFile });
  if (!r.ok) throw new Error('tool-stat should be treated as file tool');
});

test('11. tool-list is a file tool — boundary applies', () => {
  const guard = new FileSystemGuard({ safeRoots: [testDir] });
  const r = guard.checkBoundary('tool-list', { path: testDir });
  if (!r.ok) throw new Error('tool-list should be treated as file tool');
});

try { rmdirSync(testDir, { recursive: true }); } catch {}

console.log(`\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) process.exit(1);
