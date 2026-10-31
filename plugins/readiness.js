// Readiness 聚合（TSS S2）：ready / degraded / unavailable 统一判定与查询
// 依据：docs/plans/土行孙生产基座治理计划-2026-09.md §6.2/§11-S2
// 判定：
//   unavailable = 任一关键插件（degraded_policy=block_startup）error，或 preflight 失败
//   degraded    = 存在非关键插件 error，或 governance 标记 degraded，或 event-sink 降级
//   ready       = 其余情况
// 查询：core.getService('readiness').status()；core.ready 时打印一行汇总。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnv } from '../src/core/env.js';

const PLATFORM_VERSION = JSON.parse(readFileSync(join(fileURLToPath(new URL('..', import.meta.url)), 'package.json'), 'utf8')).version;
const name = 'readiness';
const version = PLATFORM_VERSION;

const manifest = {
  schema_version: 'tusunsun.plugin/v2',
  name,
  version,
  api_version: '1',
  owner: 'platform',
  provides: [{ service: 'readiness', api_version: '1.0.0' }],
  requires: [{ service: 'runtime-env', range: '>=1.0.0', optional: true }],
  surfaces: ['internal'],
  degraded_policy: 'continue',
};

function _aggregate(core) {
  const components = [];
  for (const [pname, plugin] of core.plugins) {
    const m = plugin.manifest || {};
    components.push({
      name: pname,
      state: plugin.state || 'unknown',
      critical: m.degraded_policy === 'block_startup',
      legacy: !plugin.manifest,
    });
  }
  // v0.12.0（K-03b）：装配失败的插件已被 Lifecycle 的清理流程移出 `core.plugins`，
  // 于是只扫 `core.plugins` 会得出 "ready" —— 清理把证据一起删了。
  // 内核现在保留 `_startFailures`（只读事实，不参与任何状态写入），这里并入聚合，
  // 让本服务与 `core.ready.status` 对同一件事说同一句话。
  const startFailures = core._startFailures;
  if (startFailures instanceof Map) {
    for (const [fname, rec] of startFailures) {
      if (core.plugins.has(fname)) continue;   // 仍活着的不重复计
      components.push({
        name: fname, state: 'error', critical: rec?.requiredFailed === true,
        legacy: false, unloadedAfterFailure: true,
      });
    }
  }
  // 静态装配违例由 admission-gate 在启动闸处置；这里聚合运行期信号：
  // 插件 error 状态 + event-sink 降级 + runtime-env preflight。
  const degradedNames = new Set();
  for (const c of components) {
    if (c.state === 'error') degradedNames.add(c.name);
  }
  let sink = null;
  try { sink = core.getService('event-sink'); } catch { /* 未装载 */ }
  const sinkHealth = sink ? sink.health() : null;
  let env = null;
  try { env = core.getService('runtime-env'); } catch { /* 未装载 */ }
  const preflight = env ? env.preflight() : null;

  const criticalFailed = components.filter((c) => c.critical && c.state === 'error');
  const nonCriticalFailed = components.filter((c) => !c.critical && c.state === 'error');
  const preflightFailed = preflight && !preflight.ok;

  let status = 'ready';
  if (criticalFailed.length > 0 || preflightFailed) status = 'unavailable';
  else if (nonCriticalFailed.length > 0 || (sinkHealth && sinkHealth.degraded) || degradedNames.size > 0) status = 'degraded';

  return {
    status,
    at: new Date().toISOString(),
    profile: readEnv('PROFILE') || 'development',
    components,
    criticalFailed: criticalFailed.map((c) => c.name),
    failed: nonCriticalFailed.map((c) => c.name),
    sink: sinkHealth ? { degraded: sinkHealth.degraded, mode: sinkHealth.mode } : null,
    preflight: preflight ? { ok: preflight.ok, degraded: preflight.degraded, failed: preflight.failed } : null,
  };
}

async function init(core) {
  core.registerService('readiness', {
    api_version: '1.0.0',
    status: () => _aggregate(core),
  });
  core.on('core.ready', () => {
    const s = _aggregate(core);
    core.log(s.status === 'ready' ? 'info' : 'warn', `[readiness] ${s.status.toUpperCase()}（plugins=${s.components.length} failed=${s.failed.length} criticalFailed=${s.criticalFailed.length}）`);
  });
}

export { name, version, manifest, init };
export default { name, version, manifest, init };
