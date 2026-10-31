import { TestRunner, assert } from '../harness.mjs';

// S1 验收（治理计划 §11-S1）：缺失 required service、版本不兼容、同名 provider 均在 init 前具名失败。
// validateAssembly 是纯函数，直接对插件快照做校验，不触碰进程退出路径。

function mk(name, fields = {}) {
  return { name, version: '1.0.0', state: 'registered', ...fields };
}

function codes(violations) {
  return violations.map((v) => v.code);
}

export async function setup(runner) {
  runner.test('AdmissionGate: 缺失 required service 具名失败', async () => {
    const { validateAssembly } = await import('../../plugins/admission-gate.js');
    const plugins = new Map([
      ['consumer', mk('consumer', {
        manifest: {
          schema_version: 'tusunsun.plugin/v2', name: 'consumer', version: '1.0.0', api_version: '1',
          owner: 'platform',
          provides: [],
          requires: [{ service: 'no-such-service', range: '>=1.0.0', optional: false }],
          surfaces: ['internal'], degraded_policy: 'continue',
        },
      })],
    ]);
    const { violations } = validateAssembly(plugins);
    assert(codes(violations).includes('missing_required_service'), '应报 missing_required_service');
    const v = violations.find((x) => x.code === 'missing_required_service');
    assert(v.plugin === 'consumer' && v.detail.includes('no-such-service'), `违例须具名: ${v.plugin}/${v.detail}`);
  });

  runner.test('AdmissionGate: API 版本不兼容具名失败', async () => {
    const { validateAssembly } = await import('../../plugins/admission-gate.js');
    const plugins = new Map([
      ['provider', mk('provider', {
        manifest: {
          schema_version: 'tusunsun.plugin/v2', name: 'provider', version: '1.0.0', api_version: '1',
          owner: 'platform',
          provides: [{ service: 'svc.a', api_version: '2.0.0' }],
          requires: [], surfaces: ['internal'], degraded_policy: 'continue',
        },
      })],
      ['consumer', mk('consumer', {
        manifest: {
          schema_version: 'tusunsun.plugin/v2', name: 'consumer', version: '1.0.0', api_version: '1',
          owner: 'platform',
          provides: [],
          requires: [{ service: 'svc.a', range: '>=3.0.0', optional: false }],
          surfaces: ['internal'], degraded_policy: 'continue',
        },
      })],
    ]);
    const { violations } = validateAssembly(plugins);
    assert(codes(violations).includes('api_version_conflict'), '应报 api_version_conflict');
    const v = violations.find((x) => x.code === 'api_version_conflict');
    assert(v.detail.includes('2.0.0') && v.detail.includes('>=3.0.0'), `违例须含两侧版本: ${v.detail}`);
  });

  runner.test('AdmissionGate: 同名 service provider 具名失败', async () => {
    const { validateAssembly } = await import('../../plugins/admission-gate.js');
    const mf = (name) => ({
      schema_version: 'tusunsun.plugin/v2', name, version: '1.0.0', api_version: '1',
      owner: 'platform',
      provides: [{ service: 'svc.dup', api_version: '1.0.0' }],
      requires: [], surfaces: ['internal'], degraded_policy: 'continue',
    });
    const plugins = new Map([['p1', mk('p1', { manifest: mf('p1') })], ['p2', mk('p2', { manifest: mf('p2') })]]);
    const { violations } = validateAssembly(plugins);
    assert(codes(violations).includes('duplicate_provider'), '应报 duplicate_provider');
    const v = violations.find((x) => x.code === 'duplicate_provider');
    assert(v.detail.includes('p1') && v.detail.includes('p2'), `违例须列出全部 provider: ${v.detail}`);
  });

  runner.test('AdmissionGate: 依赖环检测', async () => {
    const { validateAssembly } = await import('../../plugins/admission-gate.js');
    const mf = (name, req) => ({
      schema_version: 'tusunsun.plugin/v2', name, version: '1.0.0', api_version: '1',
      owner: 'platform',
      provides: [{ service: `svc.${name}`, api_version: '1.0.0' }],
      requires: req, surfaces: ['internal'], degraded_policy: 'continue',
    });
    const plugins = new Map([
      ['a', mk('a', { manifest: mf('a', [{ service: 'svc.b', range: '>=1.0.0', optional: false }]) })],
      ['b', mk('b', { manifest: mf('b', [{ service: 'svc.a', range: '>=1.0.0', optional: false }]) })],
    ]);
    const { violations } = validateAssembly(plugins);
    assert(codes(violations).includes('dependency_cycle'), '应报 dependency_cycle');
  });

  runner.test('AdmissionGate: legacy adapter 生成最小 manifest 并标记 legacy', async () => {
    const { validateAssembly } = await import('../../plugins/admission-gate.js');
    const plugins = new Map([
      ['old-style', mk('old-style', {
        version: '0.2.0',
        provides: [{ name: 'svc.old', removable: true }],
        requires: { 'old-style-dep': '>=0.1.0' },
      })],
    ]);
    const { manifests } = validateAssembly(plugins);
    const m = manifests.get('old-style');
    assert(m.legacy === true, '无 v2 声明应标记 legacy=true');
    assert(m.schema_version === 'legacy', 'schema_version 应为 legacy');
    assert(m.provides[0].service === 'svc.old' && m.provides[0].api_version === '1.0.0', 'provides 应规范化且 api_version 默认 1.0.0');
    assert(m.requires[0].service === 'old-style-dep' && m.requires[0].optional === false, 'requires 应从对象映射规范化');
  });

  runner.test('AdmissionGate: optional 缺失进 degraded 不报违例', async () => {
    const { validateAssembly } = await import('../../plugins/admission-gate.js');
    const plugins = new Map([
      ['consumer', mk('consumer', {
        manifest: {
          schema_version: 'tusunsun.plugin/v2', name: 'consumer', version: '1.0.0', api_version: '1',
          owner: 'platform',
          provides: [],
          requires: [{ service: 'nice-to-have', range: '>=1.0.0', optional: true }],
          surfaces: ['internal'], degraded_policy: 'continue',
        },
      })],
    ]);
    const { violations, degraded } = validateAssembly(plugins);
    assert(violations.length === 0, 'optional 缺失不应产生违例');
    assert(degraded.includes('consumer'), '应进入 degraded 名单');
  });

  runner.test('AdmissionGate: 非法 v2 声明按 legacy 处理并记 invalid_manifest', async () => {
    const { validateAssembly } = await import('../../plugins/admission-gate.js');
    const plugins = new Map([
      ['bad', mk('bad', {
        manifest: { schema_version: 'tusunsun.plugin/v2', name: 'mismatch', version: '1.0.0', owner: 'x', provides: [], requires: [] },
      })],
    ]);
    const { violations, manifests } = validateAssembly(plugins);
    assert(codes(violations).includes('invalid_manifest'), '应报 invalid_manifest');
    assert(manifests.get('bad').legacy === true, '非法声明回退 legacy');
  });

  runner.test('EventSink: envelope 校验接受/拒绝并计数', async () => {
    const mod = await import('../../plugins/event-sink.js');
    const registered = {};
    const logs = [];
    const core = {
      log(level, msg) { logs.push(`${level}: ${msg}`); },
      registerService(n, o) { registered[n] = o; },
      emit() {},
    };
    await mod.init(core);
    const sink = registered['event-sink'];
    assert(sink && sink.api_version === '1.0.0', '应注册 api 1.0.0 的 event-sink 服务');
    const good = { schema_version: 'tusunsun.event/v1', event_id: 'e1', event_type: 'test', occurred_at: 'now', producer: { name: 'x' }, assembly_id: 'sha256:ab' };
    assert(sink.emit(good) === true, '完整 envelope 应受理');
    assert(sink.emit({ event_id: 'e2' }) === false, '缺字段 envelope 应拒绝');
    const h = sink.health();
    assert(h.accepted === 1 && h.rejected === 1 && h.mode === 'null', `计数应正确: ${JSON.stringify(h)}`);
    sink.setDegraded('测试降级');
    assert(sink.health().degraded === true, '降级应显式可见');
  });
}
