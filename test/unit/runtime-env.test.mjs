import { TestRunner, assert } from '../harness.mjs';
import { readFileSync, existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

function mockCore(stateDir) {
  const listeners = {};
  const services = {};
  const logs = [];
  return {
    stateDir,
    plugins: new Map(),
    log(level, msg) { logs.push({ level, msg }); },
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    registerService(n, o) { services[n] = o; },
    getService(n) { return services[n] || null; },
    emit() {},
    _services: services,
    _logs: logs,
  };
}

export async function setup(runner) {
  const dir = join(tmpdir(), `tss-s2-test-${process.pid}`);
  let savedEnv;

  runner.beforeEach(() => {
    savedEnv = { p: process.env.TUSUNSUN_PROFILE, d: process.env.TUSUNSUN_DATA_DIR };
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  });
  runner.afterEach(() => {
    if (savedEnv.p === undefined) delete process.env.TUSUNSUN_PROFILE; else process.env.TUSUNSUN_PROFILE = savedEnv.p;
    if (savedEnv.d === undefined) delete process.env.TUSUNSUN_DATA_DIR; else process.env.TUSUNSUN_DATA_DIR = savedEnv.d;
    rmSync(dir, { recursive: true, force: true });
  });

  runner.test('RuntimeEnv: 目录分类解析且相互分离', async () => {
    // R0-101：规范名为 TUSUNSUN_*（规范名优先于历史前缀 ⇒ 显式设置即确定 profile）
    process.env.TUSUNSUN_PROFILE = 'development';
    process.env.TUSUNSUN_DATA_DIR = dir;
    const mod = await import('../../plugins/runtime-env.js');
    const core = mockCore(join(dir, 'state'));
    await mod.init(core);
    const env = core._services['runtime-env'];
    const data = env.getDataDir('tasks');
    const temp = env.getTempDir('scratch');
    const wt = env.getWorktreeDir('task-1');
    const sock = env.getSocketAddress('task-1');
    for (const p of [data, temp, wt, sock]) assert(typeof p === 'string' && p.length > 0, `路径应可解析: ${p}`);
    assert(data.includes(join('data', 'tasks')), `data 路径应带分类: ${data}`);
    assert(wt.includes('worktrees'), `worktree 路径应带分类: ${wt}`);
    assert(sock.endsWith('.sock'), `socket 应为 .sock 逻辑地址: ${sock}`);
    assert(new Set([data, temp, wt, sock.split('/task-1.sock')[0]]).size >= 3, 'data/temp/worktree/socket 应分离');
  });

  runner.test('RuntimeEnv: snapshot 无 secret 且 preflight 结构完整', async () => {
    // R0-101：规范名为 TUSUNSUN_*（规范名优先于历史前缀 ⇒ 显式设置即确定 profile）
    process.env.TUSUNSUN_PROFILE = 'development';
    process.env.TUSUNSUN_DATA_DIR = dir;
    const mod = await import('../../plugins/runtime-env.js');
    const core = mockCore(join(dir, 'state'));
    await mod.init(core);
    const env = core._services['runtime-env'];
    const snap = env.snapshot();
    assert(snap.platform.platform === 'linux', '应报告 linux 平台');
    assert(existsSync(snap.dirs.worktrees.split('/default')[0]) || snap.dirs.worktrees, 'worktree 目录应可解析');
    assert(snap.preflight && Array.isArray(snap.preflight.checks), 'preflight 应有 checks');
    const names = snap.preflight.checks.map((c) => c.name);
    for (const need of ['exe:bash', 'exe:git', 'exe:node', 'uds']) {
      assert(names.includes(need), `preflight 应含 ${need}`);
    }
    assert(snap.preflight.ok === true, `本机必检项应全过: ${snap.preflight.failed?.join(',')}`);
    const text = JSON.stringify(snap);
    assert(!/MASTER_KEY|API_?KEY|SECRET/i.test(text) && !text.toLowerCase().includes('apikey='), 'snapshot 不应包含 secret 名或值');
  });

  runner.test('RuntimeEnv: production 准入纯断言（仓库内/缺省/非 Linux 均具名违例）', async () => {
    const { assertProductionAdmission } = await import('../../plugins/runtime-env.js');
    assert(assertProductionAdmission({ profile: 'development', dataDir: null, platform: 'linux', repoRoot }).length === 0, 'development 不做 production 断言');
    const inRepo = assertProductionAdmission({ profile: 'production', dataDir: join(repoRoot, 'data'), platform: 'linux', repoRoot });
    assert(inRepo.length === 1 && inRepo[0].includes('位于 Git 仓库内'), `应具名拒绝仓库内目录: ${inRepo.join(';')}`);
    const missing = assertProductionAdmission({ profile: 'production', dataDir: null, platform: 'linux', repoRoot });
    assert(missing.length === 1 && missing[0].includes('TUSUNSUN_DATA_DIR'), '应具名要求 TUSUNSUN_DATA_DIR');
    const win = assertProductionAdmission({ profile: 'production', dataDir: '/mnt/data/tusunsun-data', platform: 'win32', repoRoot });
    assert(win.length === 1 && win[0].includes('Linux'), '应具名拒绝非 Linux');
    const ok = assertProductionAdmission({ profile: 'production', dataDir: '/mnt/data/tusunsun-data', platform: 'linux', repoRoot });
    assert(ok.length === 0, '仓库外 Linux 数据目录应通过');
  });

  runner.test('Readiness: 聚合 ready/degraded/unavailable', async () => {
    const mod = await import('../../plugins/readiness.js');
    const listeners = {};
    const services = {};
    const core = {
      plugins: new Map(),
      log() {},
      on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
      registerService(n, o) { services[n] = o; },
      getService(n) { return services[n] || null; },
      emit() {},
    };
    await mod.init(core);
    const readiness = services['readiness'];
    core.plugins.set('ok-plugin', { name: 'ok-plugin', state: 'running' });
    assert(readiness.status().status === 'ready', '全 running 应 ready');
    core.plugins.set('bad-plugin', { name: 'bad-plugin', state: 'error' });
    assert(readiness.status().status === 'degraded', '非关键 error 应 degraded');
    core.plugins.set('crit', { name: 'crit', state: 'error', manifest: { degraded_policy: 'block_startup' } });
    const s3 = readiness.status();
    assert(s3.status === 'unavailable' && s3.criticalFailed.includes('crit'), '关键插件 error 应 unavailable');
  });
}
