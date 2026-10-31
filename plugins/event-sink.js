// 事件证据边界（TSS S1）：版本化 event-sink 服务接口 + 可显式降级的空实现
// 依据：docs/plans/土行孙生产基座治理计划-2026-09.md §8/§11-S1
// S1 只冻结接口（api_version 1.0.0）与空 sink；正式 task-trace sink 由 S3/W2 建设。
// envelope 最小字段遵循 §8.2：schema_version/event_id/event_type/occurred_at/producer/assembly_id。
// 空 sink 不落盘：emit 仅做 envelope 结构校验并计数，降级状态显式可见（health()）。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLATFORM_VERSION = JSON.parse(readFileSync(join(fileURLToPath(new URL('..', import.meta.url)), 'package.json'), 'utf8')).version;
const name = 'event-sink';
const version = PLATFORM_VERSION;

const manifest = {
  schema_version: 'tusunsun.plugin/v2',
  name,
  version,
  api_version: '1',
  owner: 'platform',
  provides: [{ service: 'event-sink', api_version: '1.0.0' }],
  requires: [],
  surfaces: ['internal'],
  degraded_policy: 'continue',
  data: { paths: [], retention: 'external' },
};

const stats = { accepted: 0, rejected: 0, degraded: false, reason: null, lastReject: null };
const REQUIRED = ['schema_version', 'event_id', 'event_type', 'occurred_at', 'producer', 'assembly_id'];

async function init(core) {
  core.registerService('event-sink', {
    api_version: '1.0.0',
    mode: 'null',
    // 返回 true=已受理。空 sink 不持久化，仅校验并计数；真实 sink 在 S3/W2 注册替换。
    emit(envelope) {
      const missing = REQUIRED.filter((k) => envelope == null || envelope[k] == null);
      if (missing.length > 0) {
        stats.rejected++;
        stats.lastReject = { missing, at: new Date().toISOString() };
        if (stats.rejected === 1) core.log('warn', `[event-sink] envelope 缺字段被拒: ${missing.join(',')}（后续同类不再逐条告警）`);
        return false;
      }
      stats.accepted++;
      return true;
    },
    setDegraded(reason) {
      stats.degraded = true;
      stats.reason = reason || null;
      core.emit('component.degraded', { component: name, reason, timestamp: new Date().toISOString(), sourcePlugin: name });
    },
    health() {
      return { ok: true, mode: 'null', api_version: '1.0.0', degraded: stats.degraded, reason: stats.reason, ...stats };
    },
  });
  core.log('info', `[event-sink] 空 sink 就绪（api 1.0.0，mode=null，不落盘；正式 task-trace 由 S3/W2 提供）`);
}

export { name, version, manifest, init };
export default { name, version, manifest, init };
