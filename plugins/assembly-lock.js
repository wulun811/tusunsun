// 装配锁（TSS S0）：生产装配真相源
// 依据：docs/plans/土行孙生产基座治理计划-2026-09.md §4（唯一生产核心 + runtime-assembly/v1）
// 职责：
//   1. production 准入负向检查：禁止缺省/仓库内 TUSUNSUN_DATA_DIR
//      （R0-100：原先还含"禁止从某个下游工作树启动"——那是**下游自己的策略**，已由下游的
//       兼容准入闸门以 `compat_production_forbidden` 失败封闭实现；平台不再内嵌任何下游目录名，
//       故此处移除，旧 build-oss 的 transformAssemblyLock 随之删除。）
//   2. core.ready 后生成 runtime-assembly.lock.json（assembly_id + 组件 canonical path/hash + 冲突报告）
//   3. 暴露 assembly 服务：getId()/getLock()/getProfile()，assembly ID 单行打印，不打印敏感配置
// 锁文件写入 TUSUNSUN_DATA_DIR/assembly（production）或 stateDir/assembly（development），均在 Git 仓库外。

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnv } from '../src/core/env.js';

const PLATFORM_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PLATFORM_VERSION = JSON.parse(readFileSync(join(PLATFORM_ROOT, 'package.json'), 'utf8')).version;
const SCHEMA_VERSION = 'runtime-assembly/v1';
const name = 'assembly-lock';
const version = PLATFORM_VERSION;
const manifest = {
  schema_version: 'tusunsun.plugin/v2',
  name,
  version,
  api_version: '1',
  owner: 'platform',
  provides: [{ service: 'assembly', api_version: '1.0.0' }],
  requires: [{ service: 'runtime-env', range: '>=1.0.0', optional: true }],
  surfaces: ['internal'],
  degraded_policy: 'block_startup',
};

const _state = {
  profile: 'development',
  lock: null,
  conflicts: [],
  lockPath: null,
  _regenTimer: null,
};

function _resolveProfile() {
  return readEnv('PROFILE') || 'development';
}

function _sha256File(p) {
  return 'sha256:' + createHash('sha256').update(readFileSync(p)).digest('hex');
}

function _sha256Text(text) {
  return 'sha256:' + createHash('sha256').update(text).digest('hex');
}

// production 准入：违例直接拒绝启动（fail closed）；development 仅告警
function _assertAdmission(core, profile) {
  if (profile !== 'production') return;
  const violations = [];
  const dataDir = readEnv('DATA_DIR');
  if (!dataDir) {
    violations.push('必须显式设置 TUSUNSUN_DATA_DIR（可变运行数据不得落入 Git 仓库）');
  } else if (resolve(dataDir).startsWith(PLATFORM_ROOT + sep)) {
    violations.push(`TUSUNSUN_DATA_DIR 位于 Git 仓库内：${resolve(dataDir)}`);
  }
  if (violations.length > 0) {
    for (const v of violations) core.log('error', `[assembly-lock] production 准入拒绝：${v}`);
    const err = new Error(`[assembly-lock] production admission failed: ${violations.join('; ')}`);
    // core._startPlugin 会捕获 init 异常继续启动（fail-open），生产违例必须终止进程
    setImmediate(() => process.exit(1));
    throw err;
  }
}

function _resolveLockDir(core, profile) {
  if (profile === 'production') return join(resolve(readEnv('DATA_DIR')), 'assembly');
  return join(core.stateDir, 'assembly');
}

function _buildComponents(core) {
  const pm = core.getService('plugin-manager');
  const components = [];
  for (const [pname, plugin] of core.plugins) {
    const src = plugin.__source || pm?._pluginFilePaths?.get(pname) || null;
    let hash = null;
    if (src) {
      try { hash = _sha256File(src); } catch { hash = null; }
    }
    const manifestHash = plugin.manifest
      ? 'sha256:' + createHash('sha256').update(JSON.stringify(plugin.manifest)).digest('hex')
      : null;
    components.push({
      name: pname,
      version: plugin.version || '0.0.0',
      source_path: src ? src.replace(PLATFORM_ROOT + sep, '') : null,
      entry: src,
      source_hash: hash,
      manifest_hash: manifestHash,
      enabled: plugin.state !== 'error',
    });
  }
  components.sort((a, b) => (a.name < b.name ? -1 : 1));
  return components;
}

function _generate(core) {
  const components = _buildComponents(core);
  const executors = [{
    name: 'native-tusunsun-worker',
    adapter_version: 'execution-port/v0',
    provider: 'native',
    provider_version: PLATFORM_VERSION,
    required: true,
    config_hash: _sha256Text(JSON.stringify({
      profile: _state.profile,
      dataDir: _state.profile === 'production' ? resolve(readEnv('DATA_DIR')) : null,
    })),
  }];
  // runtime_env 快照仅随锁落盘（取证用），不参与 assembly_id 哈希（snapshot 含时间戳，进哈希会破坏 id 稳定性）
  let runtimeEnv = null;
  try {
    const env = core.getService('runtime-env');
    if (env) runtimeEnv = env.snapshot();
  } catch { /* runtime-env 未装载（旧装配） */ }
  const assemblyId = _sha256Text(JSON.stringify({
    platform_version: PLATFORM_VERSION,
    run_profile: _state.profile,
    components,
    executors,
  }));
  const lock = {
    schema_version: SCHEMA_VERSION,
    assembly_id: assemblyId,
    generated_at: new Date().toISOString(),
    platform_version: PLATFORM_VERSION,
    run_profile: _state.profile,
    conflicts: _state.conflicts,
    components,
    executors,
    ...(runtimeEnv ? { runtime_env: runtimeEnv } : {}),
  };
  try {
    mkdirSync(_state.lockDir, { recursive: true });
    writeFileSync(_state.lockPath, JSON.stringify(lock, null, 2) + '\n');
  } catch (e) {
    core.log('error', `[assembly-lock] lock 写入失败: ${e.message}`);
    return;
  }
  _state.lock = lock;
  core.log('info', `[assembly-lock] assembly_id=${assemblyId.slice(0, 26)}… profile=${_state.profile} plugins=${components.length} conflicts=${_state.conflicts.length} → ${_state.lockPath}`);
}

async function init(core) {
  const profile = _resolveProfile();
  _state.profile = profile;

  _assertAdmission(core, profile);
  _state.lockDir = _resolveLockDir(core, profile);
  _state.lockPath = join(_state.lockDir, 'runtime-assembly.lock.json');

  if (profile !== 'production') {
    core.log('info', `[assembly-lock] profile=development（assembly 锁写入 ${_state.lockPath}；生产运行请设置 TUSUNSUN_PROFILE=production 与 TUSUNSUN_DATA_DIR）`);
  }

  // H-04（v0.15.4）：四条监听原先**无主**，也没有 stop —— 卸载后仍在响应新 Core 的世界事件，
  // 成为“过期感知器官”（专家探针 HOOK-R04 实测 `offByOwner('assembly-lock')` 删除数为 0）。
  // 两条路只能选一条：声明不可卸载并在 Core 里硬拒绝，或真正可卸载。这里选后者：
  // 监听带 owner（卸载时由 `_step5CleanListeners` 按记录撤销），去抖定时器在 stop 里清掉。
  // 遗留边界：`_state` 仍是模块级单例（锁/冲突快照），重装后 conflicts 会累积 —— 它是
  // 进程级取证数据，不是实例态，本轮不搬；已记入交付包的“已知限制”。
  core.on('core:service.conflict', (e) => {
    _state.conflicts.push({ kind: 'service', service: e?.service, owner: e?.owner, at: new Date().toISOString() });
  }, { owner: name });
  core.on('core:plugin.conflict', (e) => {
    _state.conflicts.push({ kind: 'plugin', name: e?.pluginName, at: new Date().toISOString() });
  }, { owner: name });
  core.on('core.ready', () => _generate(core), { owner: name });
  // 懒加载改变装配组合：就绪后每次插件加载重算锁（防抖合并突发加载）
  core.on('core:plugin.loaded', () => {
    if (!_state.lock) return;
    clearTimeout(_state._regenTimer);
    _state._regenTimer = setTimeout(() => _generate(core), 50);
  }, { owner: name });

  core.registerService('assembly', {
    getId: () => _state.lock?.assembly_id || null,
    getLock: () => _state.lock,
    getProfile: () => _state.profile,
    getLockPath: () => _state.lockPath,
  });
}

// H-04：卸载时必须把**本插件持有的资源**收尾 —— 尤其是那条去抖定时器，
// 否则卸载后它还会触一次 `_generate(core)`（对旧的 core 引用继续写锁文件）。
async function stop() {
  clearTimeout(_state._regenTimer);
  _state._regenTimer = null;
}

export { name, version, manifest, init, stop };
export default { name, version, manifest, init, stop };
