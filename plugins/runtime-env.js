// Runtime Environment Service（TSS S2）：统一暴露 Linux 环境能力
// 依据：docs/plans/土行孙生产基座治理计划-2026-09.md §7/§11-S2
// 职责：
//   1. data/temp/worktree/socket 目录分类解析，全部派生自 TUSUNSUN_DATA_DIR（production，必填且须在
//      Git 仓库外）或 stateDir（development）；业务插件不再各自拼接仓库内路径
//   2. Linux preflight：bash/git/node/UDS 必检，Docker/磁盘为可选降级项，任务入场前可判断
//   3. snapshot()：不含 secret 的环境快照（进入 assembly lock）
// production 下 Windows 工作树或可变数据目录落入 Git 仓库 → 拒绝启动（fail closed）。

import { readFileSync, statfsSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer as netCreateServer } from 'node:net';
import { readEnv } from '../src/core/env.js';

const PLATFORM_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PLATFORM_VERSION = JSON.parse(readFileSync(join(PLATFORM_ROOT, 'package.json'), 'utf8')).version;
const name = 'runtime-env';
const version = PLATFORM_VERSION;
const manifest = {
  schema_version: 'tusunsun.plugin/v2',
  name,
  version,
  api_version: '1',
  owner: 'platform',
  provides: [{ service: 'runtime-env', api_version: '1.0.0' }],
  requires: [],
  surfaces: ['internal'],
  degraded_policy: 'block_startup', // 环境能力是任务入场判据：production 下缺位即拒绝启动
};

const _state = { profile: 'development', dataRoot: null, preflight: null, _exeCache: new Map() };

function _resolveProfile() {
  return readEnv('PROFILE') || 'development';
}

function _classifyRoot(core, profile) {
  const envDir = readEnv('DATA_DIR');
  const root = profile === 'production' ? resolve(envDir) : (envDir ? resolve(envDir) : resolve(core.stateDir));
  const inRepo = root === PLATFORM_ROOT || root.startsWith(PLATFORM_ROOT + sep);
  return { root, inRepo };
}

function _assertAdmission(core, profile) {
  if (profile !== 'production') return;
  const violations = assertProductionAdmission({
    profile,
    dataDir: readEnv('DATA_DIR'),
    platform: process.platform,
    repoRoot: PLATFORM_ROOT,
  });
  if (violations.length > 0) {
    for (const v of violations) core.log('error', `[runtime-env] production 准入拒绝：${v}`);
    // core._startPlugin 会捕获 init 异常继续启动（fail-open），production 违例必须终止进程
    setImmediate(() => process.exit(1));
    throw new Error(`[runtime-env] production admission failed: ${violations.join('; ')}`);
  }
}

// 纯断言（可单测，无副作用）：返回违例列表，空数组 = 通过
export function assertProductionAdmission({ profile, dataDir, platform, repoRoot }) {
  if (profile !== 'production') return [];
  const violations = [];
  if (!dataDir) violations.push('必须显式设置 TUSUNSUN_DATA_DIR');
  else {
    const root = resolve(dataDir);
    if (root === repoRoot || root.startsWith(repoRoot + sep)) violations.push(`可变运行数据目录位于 Git 仓库内：${root}`);
  }
  if (platform !== 'linux') violations.push(`production 仅支持 Linux，当前 ${platform}`);
  return violations;
}

function _ns(root, kind, namespace) {
  const ns = String(namespace || 'default').replace(/[^a-zA-Z0-9._-]/g, '_');
  return join(root, kind, ns);
}

function _resolveExecutable(name) {
  if (_state._exeCache.has(name)) return _state._exeCache.get(name);
  let found = null;
  if (process.platform === 'linux' || process.platform === 'darwin') {
    const r = spawnSync('which', [name], { encoding: 'utf8', timeout: 5000 });
    if (r.status === 0 && r.stdout.trim()) found = r.stdout.trim();
  } else {
    const r = spawnSync('where', [name], { encoding: 'utf8', timeout: 5000 });
    if (r.status === 0 && r.stdout.trim()) found = r.stdout.trim().split(/\r?\n/)[0];
  }
  _state._exeCache.set(name, found);
  return found;
}

function _probeUds(dir) {
  const sock = join(dir, `uds-probe-${process.pid}.sock`);
  try {
    mkdirSync(dir, { recursive: true });
    return new Promise((resolveProbe) => {
      const srv = netCreateServer(() => {});
      srv.once('error', () => resolveProbe({ ok: false, detail: 'UDS bind 失败' }));
      srv.listen(sock, () => {
        srv.close(() => {
          try { rmSync(sock, { force: true }); } catch { /* 探针残留不致命 */ }
          resolveProbe({ ok: true, detail: sock });
        });
      });
    });
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}

function _diskStatus(path) {
  try {
    const s = statfsSync(path);
    return { path, freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) };
  } catch (e) {
    return { path, error: e.message };
  }
}

function _containerCapability() {
  const exe = _resolveExecutable('docker');
  if (!exe) return { available: false, detail: 'docker 未找到（可选能力，任务按需降级）' };
  const r = spawnSync(exe, ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 8000 });
  return r.status === 0
    ? { available: true, version: r.stdout.trim() }
    : { available: false, detail: `docker daemon 不可达: ${(r.stderr || '').trim().slice(0, 120)}` };
}

function _distro() {
  try {
    const lines = readFileSync('/etc/os-release', 'utf8');
    const pick = (k) => (lines.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1]?.replace(/^"|"$/g, '');
    return `${pick('NAME') || ''} ${pick('VERSION_ID') || ''}`.trim();
  } catch {
    return null;
  }
}

async function _preflight(core) {
  const checks = [];
  for (const exe of ['bash', 'git', 'node']) {
    const p = _resolveExecutable(exe);
    checks.push({ name: `exe:${exe}`, ok: !!p, detail: p || '未找到（必检项）', required: true });
  }
  const uds = await _probeUds(_ns(_state.dataRoot, 'sockets', 'preflight'));
  checks.push({ name: 'uds', ok: uds.ok, detail: uds.detail, required: true });
  const disk = _diskStatus(_state.dataRoot);
  const freeGb = disk.freeBytes ? Math.round(disk.freeBytes / 1e9 * 10) / 10 : null;
  checks.push({ name: 'disk', ok: !!disk.freeBytes && disk.freeBytes > 1e9, detail: disk.freeBytes ? `空闲 ${freeGb}GB` : (disk.error || '无法探测'), required: false });
  const docker = _containerCapability();
  checks.push({ name: 'docker', ok: docker.available, detail: docker.available ? `server ${docker.version}` : docker.detail, required: false });

  const requiredFail = checks.filter((c) => c.required && !c.ok);
  const result = {
    ok: requiredFail.length === 0,
    checkedAt: new Date().toISOString(),
    degraded: checks.filter((c) => !c.required && !c.ok).map((c) => c.name),
    failed: requiredFail.map((c) => c.name),
    checks,
  };
  if (!result.ok) core.log('error', `[runtime-env] preflight 必检项失败: ${result.failed.join(', ')}`);
  else if (result.degraded.length) core.log('warn', `[runtime-env] preflight 通过（可选能力降级: ${result.degraded.join(', ')}）`);
  else core.log('info', '[runtime-env] preflight 全部通过');
  return result;
}

function _snapshot() {
  return {
    profile: _state.profile,
    platform: { platform: process.platform, arch: process.arch, distro: _distro(), kernel: process.platform === 'linux' ? readFileSync('/proc/sys/kernel/osrelease', 'utf8').trim() : null, node: process.versions.node },
    dataRoot: _state.dataRoot,
    dirs: {
      data: _state.dataRoot,
      temp: _state.tempRoot,
      worktrees: _ns(_state.dataRoot, 'worktrees', 'default'),
      sockets: _ns(_state.dataRoot, 'sockets', 'default'),
    },
    executables: Object.fromEntries(['bash', 'git', 'node', 'python3', 'docker'].map((e) => [e, _resolveExecutable(e)])),
    container: _containerCapability(),
    disk: _diskStatus(_state.dataRoot),
    preflight: _state.preflight,
    generatedAt: new Date().toISOString(),
  };
}

async function init(core) {
  const profile = _resolveProfile();
  _state.profile = profile;

  _assertAdmission(core, profile);
  const { root } = _classifyRoot(core, profile);
  _state.dataRoot = root;
  _state.tempRoot = profile === 'production' ? join(tmpdir(), 'tusunsun-prod-temp') : join(tmpdir(), 'tusunsun-temp');
  for (const d of [root, _ns(root, 'worktrees', 'default'), _ns(root, 'sockets', 'default'), _state.tempRoot]) {
    try { mkdirSync(d, { recursive: true }); } catch (e) {
      core.log('error', `[runtime-env] 目录创建失败 ${d}: ${e.message}`);
    }
  }

  _state.preflight = await _preflight(core);
  if (profile === 'production' && !_state.preflight.ok) {
    const why = `preflight 必检项失败: ${_state.preflight.failed.join(', ')}`;
    core.log('error', `[runtime-env] production 准入拒绝：${why}`);
    setImmediate(() => process.exit(1));
    throw new Error(`[runtime-env] production admission failed: ${why}`);
  }

  core.registerService('runtime-env', {
    api_version: '1.0.0',
    getPlatform: () => _snapshot().platform,
    getDataDir: (ns) => _ns(_state.dataRoot, 'data', ns),
    getTempDir: (ns) => _ns(_state.tempRoot, '', ns),
    getWorktreeDir: (ns) => _ns(_state.dataRoot, 'worktrees', ns),
    getSocketAddress: (n) => _ns(_state.dataRoot, 'sockets', n === 'default' ? 'default' : n) + `/${String(n).replace(/[^a-zA-Z0-9._-]/g, '_')}.sock`,
    resolveExecutable: _resolveExecutable,
    getContainerCapability: _containerCapability,
    getDiskStatus: _diskStatus,
    getProcessCapability: () => ({ pid: process.pid, node: process.versions.node, platform: process.platform, arch: process.arch }),
    preflight: () => _state.preflight,
    snapshot: _snapshot,
  });

  core.log('info', `[runtime-env] profile=${profile} dataRoot=${root}（仓库外=${!_classifyRoot(core, profile).inRepo}）temp=${_state.tempRoot}`);
}

export { name, version, manifest, init };
export default { name, version, manifest, init };
