import { TestRunner, assert } from '../harness.mjs';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const SELF_PATH = join(here, '..', 'unit', 'assembly-lock.test.mjs');

function mockCore(stateDir) {
  const listeners = {};
  const services = {};
  return {
    stateDir,
    plugins: new Map([
      ['alpha', { name: 'alpha', version: '1.0.0', state: 'running', __source: SELF_PATH }],
      ['beta', { name: 'beta', version: '0.2.0', state: 'running', __source: SELF_PATH }],
    ]),
    log() {},
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    registerService(name, obj) { services[name] = obj; },
    getService(name) { return services[name] || null; },
    _emit(ev, payload) { for (const fn of listeners[ev] || []) fn(payload); },
    _listeners: listeners,
    _services: services,
  };
}

export async function setup(runner) {
  const dir = join(tmpdir(), `tss-assembly-lock-test-${process.pid}`);

  runner.beforeEach(() => {
    // R0-101：规范名为 TUSUNSUN_*（规范名优先 ⇒ 显式设置即确定 profile）
    process.env.TUSUNSUN_PROFILE = 'development';
    rmSync(dir, { recursive: true, force: true });
  });

  runner.afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  runner.test('AssemblyLock: development 下生成 runtime-assembly/v1 锁', async () => {
    const mod = await import('../../plugins/assembly-lock.js');
    const core = mockCore(dir);
    await mod.init(core);
    core._emit('core.ready', {});
    const lockPath = join(dir, 'assembly', 'runtime-assembly.lock.json');
    assert(existsSync(lockPath), '锁文件应写入 stateDir/assembly');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert(lock.schema_version === 'runtime-assembly/v1', 'schema_version 应为 runtime-assembly/v1');
    assert(/^sha256:[a-f0-9]{64}$/.test(lock.assembly_id), 'assembly_id 应为 sha256 格式');
    assert(lock.run_profile === 'development', 'profile 应为 development');
    assert(Array.isArray(lock.components) && lock.components.length === 2, '应包含 2 个组件');
    assert(lock.components[0].name === 'alpha', '组件应按名称排序');
    assert(/^sha256:[a-f0-9]{64}$/.test(lock.components[0].source_hash), '组件应有 source_hash');
    assert(typeof core._services.assembly?.getId() === 'string', 'assembly 服务应可查询 ID');
  });

  runner.test('AssemblyLock: 同输入 assembly_id 稳定，版本变化则 id 变化', async () => {
    const mod = await import('../../plugins/assembly-lock.js');
    const core = mockCore(dir);
    await mod.init(core);
    core._emit('core.ready', {});
    const id1 = core._services.assembly.getId();
    // 注意事件名为 core:plugin.loaded（平台核心用冒号风格；历史兼容副本用点号风格，S0 已裁决以平台为准）
    core._emit('core:plugin.loaded', {});
    await new Promise((r) => setTimeout(r, 80));
    const id2 = core._services.assembly.getId();
    assert(id1 === id2, '相同组件下懒加载重算后 id 应不变');
    core.plugins.get('alpha').version = '1.0.1';
    core._emit('core:plugin.loaded', {});
    await new Promise((r) => setTimeout(r, 80));
    const id3 = core._services.assembly.getId();
    assert(id3 !== id1, '组件版本变化后 id 应变化');
  });

  runner.test('AssemblyLock: 冲突事件进入锁报告', async () => {
    const mod = await import('../../plugins/assembly-lock.js');
    const core = mockCore(dir);
    await mod.init(core);
    core._emit('core:service.conflict', { service: 'config', owner: 'config' });
    core._emit('core.ready', {});
    const lock = JSON.parse(readFileSync(join(dir, 'assembly', 'runtime-assembly.lock.json'), 'utf8'));
    assert(lock.conflicts.length === 1 && lock.conflicts[0].service === 'config', 'service 冲突应记录在锁中');
  });
}
