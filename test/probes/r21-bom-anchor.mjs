#!/usr/bin/env node
/**
 * R21 D-17 探针：带 BOM 的 UTF-8 文件为什么永远写不进去。
 *
 * 判据 ①（缺陷方向）：对 `\uFEFFalpha\n` 走 plan → commit，期望能改成 `bravo\n`。
 * 判据 ②（合法正例）：同一工作区里不带 BOM 的 `alpha\n` 必须能改成 `bravo\n`；
 *   两条并排，防“探针把普通文件也写成失败”式误判。
 *
 * 缺陷：`Lite.readAnchor` 的 anchor.sha256 是 `sha256(decoded text)`（:279，TextDecoder 吃掉了 BOM），
 * 而 `apply` 的现场比对用 `observedOf` 的 `sha256(raw bytes)`（:247，BOM 保留）。同一个文件在
 * 两处得到两个 hash，锚永远对不上；undo 备份用解码文本，还原时也丢 BOM。
 *
 * 修法（rc.9）：vendor 的 TextDecoder 加 `ignoreBOM:true`（`PROVENANCE.patches` 有 hash 记录）。
 * UTF-8 里 `\uFEFF` 重新编码就是原来的 EF BB BF，于是“解码文本 hash”与“原始字节 hash”是同一个值；
 * 备份/还原也保留了 BOM 字节。本探针断言的就是这两点真的成立。
 *
 * 退出码：0 = 两条判据都通过（缺陷已消失），1 = 有判据失败（缺陷仍在），2 = 探针自身异常。
 * 用法：node test/probes/r21-bom-anchor.mjs [--json]
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { Core } from '../../src/core/core.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (rel) => import(join(ROOT, rel));
const SESSION = 'probe-r21-bom';
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const results = [];
function record(id, title, ok, detail) {
  results.push({ id, title, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} ${title}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const base = mkdtempSync(join(tmpdir(), 'r21-bom-'));
  const ws = join(base, 'ws');
  mkdirSync(join(ws, 'src'), { recursive: true });
  mkdirSync(join(base, 'state'), { recursive: true });
  writeFileSync(join(ws, 'src', 'bom.txt'), '\uFEFFalpha\n');
  writeFileSync(join(ws, 'src', 'plain.txt'), 'alpha\n');
  const core = new Core({ stateDir: join(base, 'state') });
  core.log = () => {};
  core._stopAssemblyDrainMs = 20;
  core.setData('agent.workDir', ws);
  try {
    for (const rel of ['plugins/workspace.js', 'plugins/liuhe-lite.js', 'plugins/cell-file-txn.js']) {
      await core.register((await imp(rel)).default);
    }
    await core.start();
    const call = async (cap, args) => {
      const env = await core.callCapability(cap, args);
      return env?.payload ?? env;
    };
    const attempt = async (rel, content) => {
      const plan = await call('tool.txn-plan', { files: [{ path: rel, content }], _sessionId: SESSION });
      if (!plan.ok) return { plan, commit: null };
      const commit = await call('tool.txn-commit', { plan_id: plan.plan.plan_id, _sessionId: SESSION });
      return { plan, commit };
    };

    const bom = await attempt('src/bom.txt', 'bravo\n');
    const bomDisk = readFileSync(join(ws, 'src', 'bom.txt'));
    const anchorHash = bom.plan?.plan?.files?.[0]?.before_sha256;
    record('D17-1', 'BOM 文件可以被 plan → commit 改写',
      bom.commit?.ok === true && bomDisk.toString('utf8') === 'bravo\n',
      `plan=${bom.plan?.code || 'ok'} anchor_sha=${anchorHash} raw_sha=${sha256(bomDisk)} `
      + `commit=${bom.commit?.code || bom.commit?.txn?.state || 'not_reached'} disk=${JSON.stringify(bomDisk.toString('utf8'))}`);

    const plain = await attempt('src/plain.txt', 'bravo\n');
    record('D17-2', '同目录无 BOM 文件可以被改写（探针自身的合法正例）',
      plain.commit?.ok === true && readFileSync(join(ws, 'src', 'plain.txt'), 'utf8') === 'bravo\n',
      `plan=${plain.plan?.code || 'ok'} commit=${plain.commit?.code || plain.commit?.txn?.state || 'not_reached'}`);
  } finally {
    await core.stop().catch(() => {});
    rmSync(base, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (err) {
  console.error(`[probe-error] ${err?.stack || err}`);
  process.exitCode = 2;
}

if (process.exitCode !== 2) {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (process.argv.includes('--json')) console.log(JSON.stringify({ results }, null, 2));
  process.exitCode = failed.length ? 1 : 0;
}
