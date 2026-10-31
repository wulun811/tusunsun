// 准入闸门（TSS S1）：Manifest v2 校验与 productionStrict 依赖闸门：tusunsun.plugin/v2 校验 + productionStrict 依赖闸门
// 依据：docs/plans/土行孙生产基座治理计划-2026-09.md §5/§6.1/§11-S1
// 职责：
//   1. 为每个已注册插件生成 manifest：v2 声明（plugin.manifest）优先，否则 legacy adapter 生成最小
//      manifest 并标记 legacy=true（治理债务显性化，不伪装合规）
//   2. 静态校验（全部插件 init 之前）：结构可解析、同名 service provider、required service 缺失、
//      API 版本冲突、依赖环
//   3. productionStrict（TUSUNSUN_PROFILE=production）：具名违例拒绝启动；degraded_policy=
//      block_startup 的插件 init/start 失败 → 整体启动失败（fail closed）
//   4. 暴露 governance 服务：isStrict()/getViolations()/getManifest(name)/isDegraded(name)
// development 只告警不阻断（与 production 的差异在日志中显式标注）。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { semverSatisfies } from '../src/core/dependency-resolver.js';
import { readEnv } from '../src/core/env.js';

const PLATFORM_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLATFORM_VERSION = JSON.parse(readFileSync(join(PLATFORM_ROOT, 'package.json'), 'utf8')).version;
const SCHEMA_VERSION = 'tusunsun.plugin/v2';
const POLICIES = ['continue', 'disable_self', 'block_startup'];
const SURFACES = ['public', 'internal', 'clinic', 'admin'];

const name = 'admission-gate';
const version = PLATFORM_VERSION;
const manifest = {
  schema_version: 'tusunsun.plugin/v2',
  name,
  version,
  api_version: '1',
  owner: 'platform',
  provides: [{ service: 'governance', api_version: '1.0.0' }],
  requires: [],
  surfaces: ['internal'],
  degraded_policy: 'block_startup',
};

const _state = { strict: false, violations: [], degraded: [], manifests: new Map() };

// legacy adapter：无 v2 manifest 的插件生成最小 manifest，api_version 一律默认 1.0.0（不制造假冲突）
function legacyManifest(plugin) {
  return {
    schema_version: 'legacy',
    name: plugin.name,
    version: plugin.version || '0.0.0',
    owner: null,
    provides: (plugin.provides || []).map((p) => ({
      service: typeof p === 'string' ? p : p.name,
      api_version: '1.0.0',
      // R0-112 缺陷 2（连带）：`type` 必须活到 manifest 里，否则 `_providesOf` 无从区分
      // service 与 capability（两者都被当成 provider ⇒ capability 冒充服务会造成假绿灯）。
      ...(typeof p === 'object' && p?.type ? { type: p.type } : {}),
    })),
    requires: Object.entries(plugin.requires || {}).map(([service, range]) => ({
      service, range, optional: false,
    })),
    surfaces: ['internal'],
    degraded_policy: 'continue',
    legacy: true,
  };
}

function _providesOf(m) {
  // R0-112 缺陷 2（连带）：只有 service 类的 provides 才可能被 `getService()` 取到。
  // 把 capability 也算成 provider，会让「require 一个从没注册过的名字」拿到**假绿灯**
  // （实测 tool-normalizer 声明过 3 个从未 registerService 的名字）。未标 type 的按 service 计。
  return (m.provides || [])
    .filter((p) => !p.type || p.type === 'service')
    .map((p) => ({ service: p.service, api_version: p.api_version || '1.0.0' }));
}

function _validateV2(m, pname) {
  const errs = [];
  if (m.schema_version !== SCHEMA_VERSION) errs.push(`schema_version 必须为 ${SCHEMA_VERSION}`);
  if (!m.name || m.name !== pname) errs.push(`manifest.name(${m.name}) 与插件名(${pname})不一致`);
  if (!m.version) errs.push('缺少 version');
  if (!m.owner) errs.push('缺少 owner');
  for (const p of m.provides || []) {
    if (!p.service || !p.api_version) errs.push(`provides 项缺少 service/api_version: ${JSON.stringify(p)}`);
  }
  for (const r of m.requires || []) {
    if (!r.service || !r.range) errs.push(`requires 项缺少 service/range: ${JSON.stringify(r)}`);
  }
  if (m.degraded_policy && !POLICIES.includes(m.degraded_policy)) {
    errs.push(`degraded_policy 非法: ${m.degraded_policy}（允许 ${POLICIES.join('|')}）`);
  }
  for (const s of m.surfaces || []) {
    if (!SURFACES.includes(s)) errs.push(`surface 非法: ${s}`);
  }
  if ((m.surfaces || []).includes('public') && !(m.input_schema && m.output_schema && m.auth)) {
    errs.push('public surface 必须声明 input_schema/output_schema/auth');
  }
  return errs;
}

function _buildManifests(plugins) {
  const manifests = new Map();
  for (const [pname, plugin] of plugins) {
    let m = plugin.manifest || null;
    if (m) {
      m = { ...m };
      const errs = _validateV2(m, pname);
      if (errs.length > 0) {
        // v2 声明非法：按 legacy 处理并把结构问题记为违例，不静默放行
        m = legacyManifest(plugin);
        manifests.set(pname, m);
        for (const e of errs) _state.violations.push({ code: 'invalid_manifest', plugin: pname, detail: e });
        continue;
      }
    } else {
      m = legacyManifest(plugin);
    }
    manifests.set(pname, m);
  }
  return manifests;
}

// R0-112 缺陷 2：lazy 插件的声明由 PluginManager 在 `_indexLazyPlugin` 阶段从文件头部提取
// （与 legacy 同样的类字段风格），字段形状一致 ⇒ 复用同一套映射，只多一个 `lazy` 标记。
function lazyManifest(pname, meta) {
  const m = legacyManifest({
    name: pname,
    version: meta?.version,
    provides: meta?.provides,
    requires: meta?.requires,
  });
  m.lazy = true;
  return m;
}

// 检查 provider 表、required service、API 版本、依赖环（纯函数，可单测）
export function validateAssembly(plugins, lazyIndex = null) {
  _state.violations = [];
  _state.degraded = [];
  const manifests = _buildManifests(plugins);

  // R0-112 缺陷 2：场景声明的全集是 **eager ∪ lazy**（同 R0-111 `scenePluginNames` 口径）。
  // lazy 插件按需装载、其服务经 `_lazyHook` 可取，因此它们提供的服务**是可用 provider**；
  // 只按 eager 校验会把「require 一个 lazy 服务」误判为缺失（实测默认场景 2 条假违例，
  // 且 production 档据此拒绝启动）。同名时以已装载的 eager 声明为准。
  for (const [pname, meta] of lazyIndex || []) {
    if (!manifests.has(pname)) manifests.set(pname, lazyManifest(pname, meta));
  }

  // 1. 同名 service provider
  const providers = new Map();
  for (const [pname, m] of manifests) {
    for (const p of _providesOf(m)) {
      if (!providers.has(p.service)) providers.set(p.service, []);
      providers.get(p.service).push(pname);
    }
  }
  for (const [svc, owners] of providers) {
    if (owners.length > 1) {
      _state.violations.push({ code: 'duplicate_provider', plugin: owners.join(','), detail: `service "${svc}" 有 ${owners.length} 个 provider: ${owners.join(' / ')}` });
    }
  }

  // 2. required service 缺失 + API 版本冲突；optional 缺失 → degraded
  for (const [pname, m] of manifests) {
    for (const r of m.requires || []) {
      const owners = providers.get(r.service);
      if (!owners || owners.length === 0) {
        if (r.optional) {
          _state.degraded.push(pname);
          continue;
        }
        _state.violations.push({ code: 'missing_required_service', plugin: pname, detail: `required service "${r.service}"（range ${r.range}）无 provider` });
        continue;
      }
      const provider = owners.find((o) => o !== pname) || owners[0];
      const pv = (manifests.get(provider).provides || []).find((p) => p.service === r.service);
      if (pv && !semverSatisfies(pv.api_version, r.range)) {
        _state.violations.push({ code: 'api_version_conflict', plugin: pname, detail: `service "${r.service}" 需要 ${r.range}，provider ${provider} 提供 ${pv.api_version}` });
      }
    }
  }

  // 3. 依赖环（沿 required requires → provider 插件边）
  const edges = new Map();
  for (const [pname, m] of manifests) {
    for (const r of m.requires || []) {
      if (r.optional) continue;
      for (const o of providers.get(r.service) || []) {
        if (o !== pname) {
          if (!edges.has(pname)) edges.set(pname, new Set());
          edges.get(pname).add(o);
        }
      }
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const walk = (node, path) => {
    if (visited.has(node)) return;
    if (visiting.has(node)) {
      _state.violations.push({ code: 'dependency_cycle', plugin: node, detail: `依赖环: ${[...path, node].join(' → ')}` });
      return;
    }
    visiting.add(node);
    for (const next of edges.get(node) || []) walk(next, [...path, node]);
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of edges.keys()) walk(node, []);

  return { violations: _state.violations, degraded: _state.degraded, manifests };
}

async function init(core) {
  const profile = readEnv('PROFILE') || 'development';
  _state.strict = profile === 'production';

  // R0-112 缺陷 2：校验对象是场景声明的全集（eager ∪ lazy），不是只有已装载的 eager。
  const lazyIndex = core.getData('_lazyIndex');
  const lazyMeta = typeof lazyIndex === 'function' ? lazyIndex() : lazyIndex;
  const { violations, degraded, manifests } = validateAssembly(core.plugins, lazyMeta);
  _state.manifests = manifests;

  const legacyCount = [...manifests.values()].filter((m) => m.legacy).length;
  const lazyCount = [...manifests.values()].filter((m) => m.lazy).length;
  for (const v of violations) {
    core.log(_state.strict ? 'error' : 'warn', `[admission-gate] ${v.code} @ ${v.plugin}: ${v.detail}`);
  }

  core.on('plugin.init_failed', (e) => {
    const m = _state.manifests.get(e?.pluginName);
    if (_state.strict && m && m.degraded_policy === 'block_startup') {
      core.log('error', `[admission-gate] 关键插件 "${e.pluginName}" 启动失败（degraded_policy=block_startup），production 拒绝继续`);
      setImmediate(() => process.exit(1));
    }
  });

  if (_state.strict && violations.length > 0) {
    // core._startPlugin 会捕获 init 异常继续启动（fail-open），production 违例必须终止进程
    setImmediate(() => process.exit(1));
    throw new Error(`[admission-gate] productionStrict: ${violations.length} 项装配违例，拒绝启动`);
  }

  core.log('info', `[admission-gate] profile=${profile} strict=${_state.strict} manifests=${manifests.size}（legacy=${legacyCount} lazy=${lazyCount}）violations=${violations.length} degraded=${degraded.length}${_state.strict ? '' : '（development 宽松模式：仅告警不阻断）'}`);

  core.registerService('governance', {
    isStrict: () => _state.strict,
    getViolations: () => _state.violations,
    getManifest: (n) => _state.manifests.get(n) || null,
    isDegraded: (n) => _state.degraded.includes(n),
  });
}

export { name, version, manifest, init };
export default { name, version, manifest, init };
