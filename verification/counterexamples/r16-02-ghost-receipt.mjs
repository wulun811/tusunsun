#!/usr/bin/env node
/**
 * verification/counterexamples/r16-02-ghost-receipt.mjs
 *
 * 专家 R16-02 的**第四条**在修复之后无法再被满足，本文件是它的可达版本。
 *
 * 原始第四条是：`host.releaseService('db', idHost)` 对一个「已因错误清理而消失」的服务
 * 必须报 ok!==true。rc.16 里它确实报 ok:true —— 因为 `discardAssemblyArtifacts` 只删了
 * 对象与归属，`_serviceRegIds` 还留着那条 ID，"服务没了、账号还在"。
 *
 * 修好之后那个前提**不存在**了：B 还在、且 ID 就是 idHost，于是按 idHost 释放是一次
 * 合法撤销，返回 ok:true 是正确行为。原文的断言于是变成"释放成功即失败"，与其用例名
 * （"absent service"）自相矛盾 —— 它编码的是修复前那个世界。
 *
 * 它想守的性质仍然可测，而且更直接：**同一个 ID 不会被成功撤销两次**，且撤销之后五个账
 * 一起清干净（不存在"registered=false 但 registrationId 还在"的公开矛盾）。
 * 前三条按专家原件的形状保留（含两条正控）。
 *
 * 退出码：0 无违约；1 复现违约；2 探针/环境错误。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(process.env.TUSUNSUN_ROOT || process.cwd());
let dir; let rc = 2; const results = [];
try {
  const { createRuntime } = await import(pathToFileURL(join(root, 'src/core/core.js')).href);
  dir = mkdtempSync(join(tmpdir(), 'tss-r16-ghost-'));
  const { core, host } = createRuntime({ stateDir: dir });
  core.log = () => {};
  const instA = { name: 'A' }; const instB = { name: 'B' };

  // ① 旧装配的清理不得删掉后来的合法宿主登记。
  const old = await core._runAssemblyContext('A', () => core.registerService('db', { who: 'A' }), core.assemblyEpoch, instA);
  const idA = core.getServiceOwnership('db').registrationId;
  host.takeoverService('db', { who: 'HOST' });
  const idHost = core.getServiceOwnership('db').registrationId;
  core.discardAssemblyArtifacts(old);
  const curr = core.getServiceOwnership('db');
  results.push({
    case: 'stale assembly vs host takeover',
    pass: curr.registered && curr.owner === '@host' && curr.registrationId === idHost && core.getService('db')?.who === 'HOST',
    idA, idHost, curr, value: core.getService('db')?.who ?? null,
  });

  // ② 正控：没有后继登记的普通失败装配仍要收回自己那笔。
  const own = await core._runAssemblyContext('B', () => core.registerService('temporary', { who: 'B' }), core.assemblyEpoch, instB);
  core.discardAssemblyArtifacts(own);
  results.push({ case: 'positive: cleanup still reclaims own registration', pass: !core.getServiceOwnership('temporary').registered });

  // ③ 正控：宿主按精确 ID 撤销必须成功，且五个账一起清。
  host.registerService('host-only', { who: 'HOST-ONLY' });
  const id = core.getServiceOwnership('host-only').registrationId;
  const release = host.releaseService('host-only', id);
  const clean = ['_services', '_serviceOwners', '_serviceRegistrar', '_serviceRegIds', '_serviceTakeovers']
    .every((m) => core[m].has('host-only') === false);
  results.push({ case: 'positive: exact host revoke', pass: release.ok === true && clean, release });

  // ④ 重述版：同一个 ID 不许被成功撤销两次；撤销后不许留活 ID。
  const first = host.releaseService('db', idHost);
  const again = host.releaseService('db', idHost);
  const after = core.getServiceOwnership('db');
  results.push({
    case: 'same id cannot be released twice; no live id without a record',
    pass: first.ok === true && again.ok !== true && again.code === 'stale_registration'
      && after.registered === false && after.registrationId === null && after.owner === null,
    first, again, after,
  });

  results.forEach((x) => console.log(JSON.stringify(x)));
  rc = results.every((x) => x.pass) ? 0 : 1;
} catch (e) { console.error('PROBE_ERROR', e?.stack || e); } finally {
  if (dir) rmSync(dir, { recursive: true, force: true });
}
process.exitCode = rc;
