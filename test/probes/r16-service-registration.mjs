#!/usr/bin/env node
/**
 * test/probes/r16-service-registration.mjs
 *
 * R16-01 的门禁探针：**服务登记身份**。
 *
 * 一条服务登记被撤销时，判据必须是「凭据里的登记 ID 是否仍指向当前这一笔」，
 * 而不是「这个名字现在有没有人占着」。按名字删会让旧装配的失败清理收走后来的
 * 合法宿主接管，并留下「对象没了、登记 ID 还在」的幽灵账 —— 幽灵账又让按旧 ID
 * 的释放对已经不存在的服务返回成功。
 *
 * 另外两条正控防止「一律不许删」把负例变绿：普通失败装配仍要收回自己那笔，
 * 宿主按精确 ID 撤销仍要成功。
 *
 * 退出码：0 通过；1 违约；2 探针自身出错（门禁把 2 记成 FAIL）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = [];
const fail = (name, detail) => { out.push({ name, ok: false, detail }); };
const ok = (name, detail) => { out.push({ name, ok: true, detail }); };

let dir;
let exit = 2;
try {
  const { createRuntime } = await import(join(ROOT, 'src/core/core.js'));
  dir = mkdtempSync(join(tmpdir(), 'probe-r16-'));
  const { core, host } = createRuntime({ stateDir: dir });
  core.log = () => {};
  const ledgerKeys = ['_services', '_serviceOwners', '_serviceRegistrar', '_serviceRegIds', '_serviceTakeovers'];
  const ledgerClean = (name) => ledgerKeys.every((m) => core[m].has(name) === false);

  // ① 真实生命周期：init 发布 A → 宿主接管 B → init 失败 → B 必须还在。
  let release; const gate = new Promise((r) => { release = r; });
  let ready; const started = new Promise((r) => { ready = r; });
  const running = core.lifecycle.load({
    name: 'probe-slow', version: '1.0.0',
    async init(c) {
      c.registerService('probe-db', { who: 'old' });
      ready();
      await gate;
      throw Object.assign(new Error('injected'), { code: 'test_failure' });
    },
    async start() {}, async stop() {},
  }, core, { epoch: core.assemblyEpoch }).then(() => 'resolved', (e) => e.code);
  await started;
  host.takeoverService('probe-db', { who: 'host' });
  const idHost = core.getServiceOwnership('probe-db').registrationId;
  release();
  const code = await running;
  const after = core.getServiceOwnership('probe-db');
  if (code === 'test_failure' && after.registered && after.owner === '@host'
    && after.registrationId === idHost && core.getService('probe-db')?.who === 'host') {
    ok('failed-assembly-keeps-host-takeover', { idHost, after });
  } else {
    fail('failed-assembly-keeps-host-takeover', { code, after, value: core.getService('probe-db')?.who ?? null });
  }

  // ② 正控：普通失败装配仍要收回自己那笔（不许靠"一律不许删"过）。
  const store = await core._runAssemblyContext('probe-b', () => core.registerService('probe-temp', { v: 1 }), core.assemblyEpoch, { name: 'probe-b' });
  const reclaimed = core.discardAssemblyArtifacts(store).services;
  if (reclaimed.length === 1 && reclaimed[0] === 'probe-temp' && ledgerClean('probe-temp')) {
    ok('positive-cleanup-still-reclaims', reclaimed);
  } else {
    fail('positive-cleanup-still-reclaims', { reclaimed, clean: ledgerClean('probe-temp') });
  }

  // ③ 旧 ID 打回 stale，且不许改动当前那笔。
  const stale = host.releaseService('probe-db', 1);
  if (stale.ok === false && stale.code === 'stale_registration' && core.getServiceOwnership('probe-db').registrationId === idHost) {
    ok('stale-id-refused', stale);
  } else {
    fail('stale-id-refused', { stale, after: core.getServiceOwnership('probe-db') });
  }

  // ④ 正控 + 幽灵回执：精确 ID 撤销成功；同一个 ID 不许再成功一次。
  const first = host.releaseService('probe-db', idHost);
  const again = host.releaseService('probe-db', idHost);
  const gone = core.getServiceOwnership('probe-db');
  if (first.ok === true && again.ok === false && again.code === 'stale_registration'
    && gone.registered === false && gone.registrationId === null && gone.owner === null && ledgerClean('probe-db')) {
    ok('exact-revoke-once', { first, again });
  } else {
    fail('exact-revoke-once', { first, again, gone, clean: ledgerClean('probe-db') });
  }

  exit = out.every((x) => x.ok) ? 0 : 1;
} catch (e) {
  console.error('PROBE_ERROR', e?.stack ?? e);
  exit = 2;
} finally {
  if (dir) rmSync(dir, { recursive: true, force: true });
}

for (const r of out) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name} ${JSON.stringify(r.detail)}`);
if (exit === 0) console.log('PASS r16-service-registration 4/4');
process.exitCode = exit;
