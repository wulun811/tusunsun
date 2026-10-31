#!/usr/bin/env node
// R21 证据探针：本轮修复里"同一份判据在修前树必须红"的几条。
//
// 用法（两棵树各跑一次，对比退出码与输出）：
//   node test/probes/r21-fix-evidence.mjs
// 退出码：0 = 全部成立；1 = 有断言不成立；2 = 环境/装载失败；3 = NOT_RUN（前置缺失，一条都没执行）。
//
// 这里不 import 单测 harness：探针要能在**修前树**（没有新单测）里独立跑。
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// 载体：`.github/` 与 `package-lock.json` 是**源码检出专有**的（npm 打包硬排除，判据见
// test/lib/carrier.mjs）。探针刻意不 import 那个模块 —— 它要能在修前树里独立跑。
const REPO_ONLY = ['.github', 'package-lock.json'];
const repoOnlyPresent = () => REPO_ONLY.filter((p) => existsSync(join(ROOT, p)));
function distCarrier() {
  const forced = String(process.env.TT_CARRIER || '').trim();
  if (forced === 'source') return false;
  if (forced === 'dist') return true;
  if (existsSync(join(ROOT, '.git'))) return false;
  return repoOnlyPresent().length === 0;
}

const results = [];
// 返回值以 `[NOT_RUN]` 开头：本载体里读不到前置文件 ⇒ 记 NOT_RUN，不算通过也不算失败。
async function check(id, fn) {
  try {
    const detail = await fn();
    const notRun = typeof detail === 'string' && detail.startsWith('[NOT_RUN]');
    results.push({ id, ok: true, notRun, detail });
  } catch (err) { results.push({ id, ok: false, detail: err.message }); }
}

await check('S1 · 源码里没有 new Function / eval', () => {
  const hits = [];
  for (const rel of ['plugins/tools/tool-validate.js', 'plugins/tool-executor.js']) {
    const src = read(rel);
    if (/new\s+Function\s*\(/.test(src) || /[^.\w]eval\s*\(/.test(src)) hits.push(rel);
  }
  if (hits.length) throw new Error(`仍有动态执行：${hits.join(', ')}`);
  return 'clean';
});

await check('S1 · json5 输入不再执行', async () => {
  const { default: tool } = await import(join(ROOT, 'plugins/tools/tool-validate.js'));
  delete globalThis.__r21_pwned;
  const out = tool.execute({ format: 'json5', content: '(() => { globalThis.__r21_pwned = 1; return 1; })()' });
  if (out.ok !== false) throw new Error(`表达式被判通过：${JSON.stringify(out)}`);
  if (globalThis.__r21_pwned !== undefined) throw new Error('模型输入在内核进程里生效了');
  const good = tool.execute({ format: 'json5', content: "{ a: 'x // y', b: 1, }" });
  if (good.ok !== true) throw new Error(`合法 JSON5 被误杀：${JSON.stringify(good)}`);
  return 'attack rejected, valid JSON5 accepted';
});

await check('B-1a · 结构化失败信封带 result_kind（修前该列在成功出口被丢掉）', async () => {
  const { ToolExecutor } = await import(join(ROOT, 'plugins/tool-executor.js'));
  const e = new ToolExecutor();
  e.core = { get: () => undefined, log: () => {}, emitFast: () => {}, getService: () => null, listCapabilities: () => [] };
  const out = await e._finishExecuteSuccess('tool-bash', { _tcId: 't' }, { ok: false, code: 'nonzero_exit', error: 'exit 3' }, 's', 'c', 'call', Date.now());
  if (out.ok !== false) throw new Error(`外层仍报成功：${JSON.stringify(out)}`);
  if (out.code !== 'nonzero_exit') throw new Error(`错误码丢失：${JSON.stringify(out)}`);
  if (out.result_kind !== 'failed') throw new Error(`result_kind 丢失：${JSON.stringify(out)}`);
  return `${out.state}/${out.result_kind}`;
});

await check('B-1b · 未声明契约的 {ok:false} 不再静默成功（留可见缺口）', async () => {
  const { ToolExecutor } = await import(join(ROOT, 'plugins/tool-executor.js'));
  const events = [];
  const e = new ToolExecutor();
  e.core = { get: () => undefined, log: () => {}, emitFast: (n) => events.push(n), getService: () => null, listCapabilities: () => [] };
  await e._finishExecuteSuccess('tool-newcomer', { _tcId: 't' }, { ok: false }, 's', 'c', 'call', Date.now());
  if (!events.includes('tool.result_contract_gap')) throw new Error('没留下契约缺口事件：未声明的失败仍然是静默成功');
  return 'gap reported';
});

await check('D-12 · 批处理非法参数得到具名拒绝而不是空对象执行', async () => {
  const { ToolExecutor } = await import(join(ROOT, 'plugins/tool-executor.js'));
  const e = new ToolExecutor();
  e.core = { get: () => undefined, log: () => {}, emitFast: () => {}, getService: () => null, listCapabilities: () => [] };
  const out = await e.executeBatch([{ id: 'c1', name: 'tool-x', arguments: 'null' }]);
  const r = out[0] || {};
  if (r.code !== 'invalid_arguments') throw new Error(`未拒绝：${JSON.stringify(r)}`);
  return r.code;
});

await check('P0-1 · 发布链在 publish 之前跑门禁', () => {
  // prepublishOnly 在任何载体都验得到 —— 它本身就是第二条闸。
  const pkg = JSON.parse(read('package.json'));
  if (!pkg.scripts.prepublishOnly) throw new Error('没有 prepublishOnly');
  if (distCarrier()) {
    // 发行包按设计不含 .github/：先把「确实不含」验出来，再记 NOT_RUN（不折算成成立）。
    if (repoOnlyPresent().length) {
      throw new Error(`发行包形态却含仓库专属文件：${repoOnlyPresent().join(' / ')}`);
    }
    return '[NOT_RUN] 本检出是 npm 发行包（不含 .github/ 与 package-lock.json）⇒ 发布链判据只在源码检出里执行；prepublishOnly 已验';
  }
  const yml = read('.github/workflows/release.yml');
  const iCheck = yml.indexOf('run: npm run check');
  const iGate = yml.indexOf('run: node scripts/release-gate.mjs');
  const iPublish = yml.indexOf('run: npm publish');
  if (iCheck < 0) throw new Error('release.yml 没跑 npm run check');
  if (iGate < 0) throw new Error('release.yml 没跑 release-gate');
  if (!(iCheck < iPublish && iGate < iPublish)) throw new Error('门禁在 publish 之后');
  return 'check → gate → publish';
});

let failed = 0;
let notRun = 0;
for (const r of results) {
  console.log(`${r.ok ? (r.notRun ? 'NOT_RUN' : 'PASS') : 'FAIL'} ${r.id} :: ${r.detail}`);
  if (!r.ok) failed += 1;
  if (r.notRun) notRun += 1;
}
const ran = results.length - notRun;
console.log(`\n${ran - failed}/${ran} 成立${notRun ? `；${notRun} 条 NOT_RUN（本载体不含前置文件）` : ''}`);
// **NOT_RUN 不许 exit 0。** 旧写法是 `process.exit(failed ? 1 : 0)`：在产物形态里
// `.github/` 与 `package-lock.json` 都不存在，那几条检查全记 NOT_RUN，探针照样 rc=0，
// 发布门禁于是把它记成 PASS。结果是「18 套探针全部 rc=0」这句话，
// 在产物形态里可以完全不包含证据。
//
// 现在：NOT_RUN 走退出码 3（区分于 0 通过 / 1 失败 / 2 探针自身出错）。
// 确实要放行时显式 `TT_ALLOW_NOT_RUN=1`，并在输出里留下痕迹。
if (failed > 0) process.exit(1);
if (notRun > 0) {
  if (process.env.TT_ALLOW_NOT_RUN === '1') {
    console.log('TT_ALLOW_NOT_RUN=1：NOT_RUN 被显式放行（这是一项决定，不是通过）');
    process.exit(0);
  }
  console.log('NOT_RUN 不是通过：补前置后重跑，或显式 TT_ALLOW_NOT_RUN=1');
  process.exit(3);
}
process.exit(0);
