#!/usr/bin/env node
// **发布门禁跑手**：把该跑的变成一条命令，并输出一份机器可读的签字矩阵。
//
// 规则：
//   · PASS 只来自 rc=0 且没有 SKIP 的项；rc=0 但套件内出现 SKIP 的项记 SKIP。
//   · SKIP 默认阻断发布（退出码 1）。只有显式 `--allow-skip=<id>` 才放行单个项；
//     `--strict` 让白名单失效，并把 TT_REQUIRE_PRECONDITIONS=1 传给每个子套件。
//   · 没跑的项写 NOT_RUN 并写明原因，绝不折算成 PASS。
//   · `--no-install` 记 SKIP（不是 NOT_RUN）：安装验收被跳过是发布判定的折断点。
//
// 用法：
//   node scripts/release-gate.mjs
//   node scripts/release-gate.mjs --no-install
//   node scripts/release-gate.mjs --allow-skip=install-acceptance   # 显式放行该 SKIP
//   node scripts/release-gate.mjs --repeat 3
//   node scripts/release-gate.mjs --json out.json
//   node scripts/release-gate.mjs --strict
//
// 退出码：0 = 无 FAIL 且无阻断 SKIP；1 = 有 FAIL 或阻断 SKIP；2 = 一条都没跑（全 NOT_RUN）。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CORE_MAX_LINES } from './core-limits.mjs';
// 判定规则单一真相：`scripts/gate-verdict.mjs`（可单测、可被门禁自检验证）。
import { countFromOutput, verdictFor } from './gate-verdict.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const REPEAT = Math.max(1, Number(opt('--repeat', '2')) || 2);
const JSON_OUT = resolve(opt('--json', join(ROOT, 'release-gate.json')));
const NO_INSTALL = flag('--no-install');
const STRICT = flag('--strict');

// `--allow-skip=<id>` 可重复；`--strict` 下白名单不生效（SKIP 一律阻断）。
const ALLOW_SKIP = new Set();
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--allow-skip=')) ALLOW_SKIP.add(a.slice('--allow-skip='.length));
  else if (a === '--allow-skip' && argv[i + 1] && !argv[i + 1].startsWith('-')) ALLOW_SKIP.add(argv[++i]);
}
const STRICT_ENV = STRICT ? { TT_REQUIRE_PRECONDITIONS: '1' } : {};

const env = {
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  cores: (await import('node:os')).cpus?.().length ?? null,
  strict: STRICT,
  repeat: REPEAT,
  at: new Date().toISOString(),
};

// ── 环境前置自检：把“跑不了”与“跑砸了”分开 ─────────────────────────────────
// 三类环境缺陷都以**红**的形态出现，但它们与产品无关。门禁不因此改判（没有 pty 就是
// 真的没验），但必须先把话说清楚 —— 否则下一个人要么把它当产品缺陷去“修”，
// 要么反过来改断言把它“改绿”。历史上这两个坑都踩过。
const PTY = (() => {
  if (process.platform !== 'linux') return { ok: true, note: '非 Linux，pty 驱动方式不适用' };
  const r = spawnSync('script', ['-qec', ':', '/dev/null'], { encoding: 'utf8' });
  if (r.status === 0) return { ok: true, note: 'script -qec 可用' };
  const tail = String(r.stderr || '').trim().split('\n').filter(Boolean).pop();
  return { ok: false, note: tail || `script exit=${r.status}` };
})();
const BROWSER = await (async () => {
  try {
    const m = await import(pathToFileURL(join(ROOT, 'test', 'lib', 'cdp.mjs')).href);
    const p = m.findBrowser();
    return { ok: !!p, note: p || '未找到 Chromium（可设 TUSUNSUN_CHROME_PATH）' };
  } catch (e) { return { ok: false, note: e.message }; }
})();
env.pty = PTY;
env.browser = BROWSER;
if (!PTY.ok || !BROWSER.ok) {
  console.log('[env] 环境前置不满足 —— 下面的红/跳过先别当产品缺陷看：');
  if (!PTY.ok) {
    console.log(`  · 分配不了 pty（${PTY.note}）⇒ TUI 的 pty 门禁会 FAIL。`);
    console.log('    常见成因：在 agent 文件沙箱里跑（/dev/ptmx 被拒 EACCES）。请在有 /dev/ptmx 的宿主 shell 里跑。');
  }
  if (!BROWSER.ok) {
    console.log(`  · 找不到 Chromium（${BROWSER.note}）⇒ 浏览器 E2E 会 SKIP。`);
    console.log('    常见成因：为了解决 npm 缓存权限而重定向了 HOME —— 那会让 ~/.cache/ms-playwright 找不到。');
    console.log('    正确做法：用 npm_config_cache=<可写目录> 覆盖缓存，不要改 HOME。');
  }
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const items = [];

/** 取输出里最后一条 `Label: N` 的规则已搬到 `scripts/gate-verdict.mjs`（可单测）。 */
/**
 * 跑一项并判定。
 *
 * `evidence` 决定「怎样才算证明自己跑过了」：
 *   · `suite`：必须打印 `Total: N` 且 N > 0——没有计数的 rc=0 不算通过；
 *   · `probe`：以退出码为合同；**退出码 3 = NOT_RUN**（前置缺失，一条都没执行）。
 *   · `tool` ：以退出码为合同（行数/指纹/依赖检查没有用例计数）。
 */
function runOnce({ id, what, cmd, args, env: extraEnv = {}, timeoutMs = 15 * 60 * 1000, evidence = 'tool' }) {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...STRICT_ENV, ...extraEnv },
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  const ms = Date.now() - t0;
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const tail = out.trim().split('\n').slice(-12).join('\n');
  const skipped = countFromOutput(out, 'Skipped');
  const failed = countFromOutput(out, 'Failed');
  const total = countFromOutput(out, 'Total');
  // 判定交给单一真相 `verdictFor`：退出码、`Failed>0`、`Total` 三者一起看。
  // 规则本身在 gate-verdict.mjs，可单测；此处只负责把观测喂进去。
  const { status, reason } = verdictFor({
    exitCode: r.status == null ? `signal:${r.signal}` : r.status,
    failed, skipped, total, evidence,
  });
  const item = {
    id,
    what,
    evidence,
    command: [cmd, ...args].join(' '),
    env: Object.keys(extraEnv).length ? extraEnv : undefined,
    exit_code: r.status == null ? `signal:${r.signal}` : r.status,
    duration_ms: ms,
    status,
    reason: reason || undefined,
    total: total ?? undefined,
    skipped: skipped || undefined,
    failed: failed || undefined,
    tail,
  };
  items.push(item);
  const mark = item.status;
  console.log(`[${mark}] ${id.padEnd(28)} ${(ms / 1000).toFixed(1)}s  rc=${item.exit_code}${skipped ? `  skip=${skipped}` : ''}${reason ? `  ${reason}` : ''}`);
  return item;
}

function notRun(id, what, why) {
  items.push({ id, what, status: 'NOT_RUN', reason: why });
  console.log(`[NOT_RUN] ${id.padEnd(25)} ${why}`);
}

function skip(id, what, why) {
  items.push({ id, what, status: 'SKIP', reason: why });
  console.log(`[SKIP] ${id.padEnd(28)} ${why}`);
}

console.log(`\n═══ 发布门禁（package ${pkg.name}@${pkg.version}）═══════════════════════════`);
console.log(`node ${env.node}  ${env.platform}/${env.arch}  repeat=${REPEAT}\n`);

// ── ① 行数预算 / 核心指纹 / 内置依赖来源 ──────────────────────────────
runOnce({ id: 'line-budget', what: 'src/core 行数与模块预算', cmd: process.execPath, args: ['scripts/line-check.js'] });
runOnce({ id: 'core-manifest', what: '核心 8 文件的逐文件指纹', cmd: process.execPath, args: ['scripts/core-manifest.js'] });
runOnce({ id: 'vendor-provenance', what: '内置第三方代码逐文件哈希', cmd: process.execPath, args: ['scripts/verify-vendor.mjs'] });
runOnce({ id: 'deps-zero-external', what: '核心零外部运行时依赖', cmd: process.execPath, args: ['scripts/core-dep-check.mjs'] });

// 证据必须描述**当前这棵树**。baseline.json 与 reports/ 都写了自己的出处，这里重算一遍。
// 这一条是补出来的：此前没有任何门禁跑 baseline-check，于是它悄悄落在源码三脚之后 ——
// 合同写着「四份模型 / 19 个突变体」，仓库里的报告还是「两份模型 / 9 条重放」，
// 而所有门禁全绿。一个没人跑的检查等于没有检查。
//
// 发布物**不含** verification/（证据目录不进 npm 包），所以在包里跑门禁时记 SKIP 而不是
// PASS —— SKIP 与 PASS 不是一回事，这一点本门禁文件头已写明。
if (existsSync(join(ROOT, 'verification', 'baseline-check.mjs'))) {
  runOnce({ id: 'verification-baseline', what: '验证基线与证据出处是否描述当前树', cmd: process.execPath, args: ['verification/baseline-check.mjs'] });
} else {
  skip('verification-baseline', '验证基线与证据出处', '本目录不含 verification/（发布物不含证据目录），只能在源码树里跑');
}

// ── ② 单测：TT_ASSERT_DRAIN=1 ───────────────────────────────────────────
//
// 本段只回答一个问题：**本树在当前 Node 下能不能过**。重复与跨版本是两件事，分开记账：
//   · `unit#1` 是本版本的那一次全量（必跑）；
//   · `unit#2..N` 是**同一份代码**的重复跑（`--repeat`，默认 2）：重复是为了抓不稳定，
//     不是"多跑一次更可信"。**三次全量同一份代码不提供三次独立证据**；
//   · `node-24` 等跨大版本在 ⑥ 里单独成项 —— 那是**另一个解释器**，是独立证据。
//
// 旧版固定 `--repeat 3` 加跨版本，实测一道门禁跑 **4 次全量**（159×3 + 158 = 637s，
// 占整道门禁 706.6s 的 90%），而 CPU 只用了 45% —— 因为每个子进程 81% 的时间在**等定时器**。
// 同一份代码第 2、3 次重复跑，在"每次已经是完整遍历"的前提下，边际价值远低于它的成本。
// 默认降到 2：保留一次重复（仍能抓到"第二次才红"的东西），删掉纯冗余的第三次。
const unitEnv = { TT_ASSERT_DRAIN: '1' };
for (let i = 1; i <= REPEAT; i++) {
  runOnce({
    id: `unit#${i}`,
    what: `单测第 ${i}/${REPEAT} 次（TT_ASSERT_DRAIN=1，必须自然退出）`,
    cmd: process.execPath, args: ['test/run-unit.mjs'], env: unitEnv, evidence: 'suite',
  });
}

// ── ③ 集成 / 冒烟 ───────────────────────────────────────────────────────
runOnce({ id: 'integration', what: '集成套件（真实进程/CLI/网关）', cmd: process.execPath, args: ['test/run-integration.mjs'], evidence: 'suite' });
runOnce({ id: 'smoke', what: '冒烟（生命周期排空 + 路径沙箱）', cmd: process.execPath, args: ['test/run-smoke.mjs'], evidence: 'suite' });

// ── ④ 全部探针（每个都要 rc=0；rc=2 是探针自身坏了，也算失败）────────
// `r0-130` 例外：它以具名项 `multi-cell-same-process` 单跑（见 ⑥），沿用原 NOT_RUN 的
// id 便于逐轮对账"同一项从 NOT_RUN 变成 PASS"。这里排除，否则同一份证据记两笔账 ——
// 一个 PASS 若是从另一个 PASS 反推出来的，那不是验证，是抄写。
const NAMED_PROBES = new Set(['r0-167-single-cell-contract.mjs', 'r0-169-real-model-chain.mjs']);
const probeDir = join(ROOT, 'test/probes');
if (existsSync(probeDir)) {
  const probes = readdirSync(probeDir).filter((f) => f.endsWith('.mjs') && !NAMED_PROBES.has(f)).sort();
  for (const f of probes) {
    const it = runOnce({ id: `probe:${f.replace(/\.mjs$/, '')}`, what: `探针 ${f}`, cmd: process.execPath, args: [join('test/probes', f)], evidence: 'probe' });
    if (it.exit_code === 2) { it.status = 'FAIL'; it.tail += '\n（退出码 2 = 探针自身出错，不是“有待修项”）'; }
  }
}

// ── ⑤ 净室安装验收（最耗时，可 --no-install）──────────────────────────
if (NO_INSTALL) {
  skip('install-acceptance', '干净目录离线安装 + CLI/HTTP/SSE/WS 旅程', '--no-install：本次未执行（SKIP，默认阻断；显式 --allow-skip=install-acceptance 才放行）');
} else {
  const tmpJson = join(ROOT, '.release-install.json');
  runOnce({
    id: 'install-acceptance',
    what: '干净目录离线安装 + CLI/HTTP/SSE/WS 旅程（门禁模式）',
    cmd: process.execPath, args: ['scripts/install-acceptance.mjs', '--gate', '--json', tmpJson],
  });
  if (existsSync(tmpJson)) {
    try { items[items.length - 1].install_summary = JSON.parse(readFileSync(tmpJson, 'utf8')); } catch { /* 保留 tail */ }
  }
}

// ── ⑥ 明确 NOT_RUN 的项（没前置就是没前置）────────────────────────────
const major = Number(process.version.replace(/^v/, '').split('.')[0]);

/**
 * 跨大版本：**能跑就必须跑**。
 *
 * 此前的写法是 `if (major !== 24) notRun('node-24', ...)` —— 只在"跑不了"时记账，
 * 于是本机真有 Node 24 时这一项**从清单里消失**：PASS 不加、总数还变少，等于
 * "跑成了反而不如没跑"。这与"没跑就写 NOT_RUN、绝不折算"是同一个原则的两面：
 * 可执行的验证不该因为环境恰好满足而失去痕迹。
 *
 * 现在：在 PATH 里找同族的其它大版本（`node-vNN...` 目录或 `nodeNN` 可执行），
 * 找到就设 `PATH` 前置再真跑整个单元套件；找不到才记 NOT_RUN 并写明找过哪里。
 */
function findOtherNodeMajor(current) {
  const cands = [];
  const root = '';
  const dirs = [root, '/tmp'].filter(Boolean);
  for (const d of dirs) {
    try {
      for (const e of readdirSync(d)) {
        const m = /^n(?:ode-)?v?(\d+)\./.exec(e) || /^node(\d{2})$/.exec(e);
        if (!m) continue;
        if (Number(m[1]) === current) continue;
        const bin = join(d, e, 'bin', 'node');
        if (existsSync(bin)) cands.push({ major: Number(m[1]), bin });
      }
    } catch { /* 目录不存在就跳过 */ }
  }
  cands.sort((a, b) => a.major - b.major);
  return cands;
}

const otherNodes = findOtherNodeMajor(major);
if (otherNodes.length === 0) {
  notRun('node-24', 'Node 24 全量', `本机未找到其它 Node 大版本（当前 ${process.version}；只看 /tmp 下的 node 安装）`);
} else {
  for (const n of otherNodes) {
    runOnce({
      id: `node-${n.major}`, what: `Node ${n.major} 全量单测（跨大版本）`,
      cmd: n.bin, args: ['test/run-unit.mjs'], evidence: 'suite',
      env: { PATH: `${join(n.bin, '..')}:${process.env.PATH}` },
    });
  }
}
if (process.platform !== 'win32') notRun('windows', 'Windows 本版全量', '当前平台不是 Windows');
if (process.platform !== 'darwin') notRun('macos', 'macOS 本版全量', '当前平台不是 macOS');
/*
 * `real-paid-model` → `real-model-chain`：**改的是理由错的，不是标准降的**。
 *
 * 原理由「本轮只用免费模型，未在付费端点实测」把两件事混成一件：
 *   · 开发代理跑在哪个模型上（受"只用免费模型"约束，是工具链环境）；
 *   · 产品能不能接真实上游（与前者无关，免费模型完全测得了）。
 *
 * 实测：`.env` 配的是免费模型 `deepseek-v4.1-flash` + 真实端点，产品经自己的网关
 * 打真实请求返回 200，上游 `usage.cost: 0`。**付费与否是账号计费方式，不是代码路径。**
 *
 * 记成 NOT_RUN 的真实后果：没有任何门禁项在验证"真实上游接得上"。全用 mock 上游时，
 * "URL 拼错""鉴权头漏了""上游 400 被吞成成功"会一路绿灯到发布。
 * 本项现在真跑，且缺凭据时退出码 3 → 如实 NOT_RUN（不折算通过）。
 */
if (existsSync(join(ROOT, 'test/probes/r0-169-real-model-chain.mjs'))) {
  runOnce({
    id: 'real-model-chain',
    what: '真实模型链路（免费模型 + 真实端点，经产品网关）',
    cmd: process.execPath, args: [join('test/probes', 'r0-169-real-model-chain.mjs')],
    evidence: 'probe',
  });
} else {
  notRun('real-model-chain', '真实模型链路', '探针 test/probes/r0-169-real-model-chain.mjs 缺失');
}

/*
 * ── 以下三项原本也记 NOT_RUN，但那是**错的**，本轮改成真跑 ─────────────────
 *
 * 三者错得还不一样，正好像是"NOT_RUN 会被滥用的三种方式"：
 *
 *  ① `browser-e2e`：**根本没缺前置**。R0-116 的真实 Chromium 回归（B1–B7）
 *     一直就在 `test/integration/` 里，门禁却另写一条"无浏览器驱动前置（本仓只有
 *     CDP 脚本，未纳入门禁）"—— 同一份事实，两处结论相反。
 *     现在让它**独立成项、独立执行**（不复用 integration 的结果：从别人的 PASS
 *     反推出来的 PASS 是记账，不是验证）。
 *     若机器上真没有 Chromium，用例会自己 `noteSkip`，`verdictFor` 见 `Skipped > 0`
 *     判 SKIP（SKIP 默认阻断发布），**不会**漏成 PASS；`--strict` 下
 *     `TT_REQUIRE_PRECONDITIONS=1` 会让它直接抛错，判 FAIL。
 *
 *  ② `multi-cell-same-process`：**不是缺口，是产品明文拒绝**。
 *     把设计决定记成"未验证"，下一轮复审会据此索要一个不该存在的功能。
 *     改成实跑合同探针（含 4 条正控），证明"拒绝仍生效，且拒绝得恰到好处"。
 *
 *  ③ `expert-original-probes`：**能跑，却被"不好看"挡在门外**。
 *     原件里确实有 1 条 COUNTEREXAMPLE、2 条 PROBE_ERROR，但那是**修好的表现**，
 *     不能折算成 PASS —— 而"不能折算成 PASS"不等于"不能跑"。
 *     改成对账：把"应当产出什么形状"冻结成期望表，每次实跑核漂移。
 *
 * 共同点：**没跑就没有证据**；但反过来说，**能跑就不能只写在 NOT_RUN 里**。
 */
const browserTest = join(ROOT, 'test/integration/chat-ui-browser-security.test.mjs');
if (existsSync(browserTest)) {
  runOnce({
    id: 'browser-e2e',
    what: '浏览器 E2E：真实 Chromium + CDP，R0-116 网页注入负例',
    cmd: process.execPath, args: ['test/run-one.mjs', 'test/integration/chat-ui-browser-security.test.mjs'],
    evidence: 'suite',
  });
} else {
  notRun('browser-e2e', '浏览器 E2E', 'test/integration/chat-ui-browser-security.test.mjs 缺失');
}

if (existsSync(join(ROOT, 'test/probes/r0-167-single-cell-contract.mjs'))) {
  runOnce({
    id: 'multi-cell-same-process',
    what: '同进程多 Cell：v0 合同拒绝 + 4 条正控',
    cmd: process.execPath, args: [join('test/probes', 'r0-167-single-cell-contract.mjs')], evidence: 'probe',
  });
} else {
  notRun('multi-cell-same-process', '同进程多 Cell', '合同探针 test/probes/r0-167-single-cell-contract.mjs 缺失');
}

// 本批四条工单的反例集：每一条都要拿出"修好了"，不是"没再看见"。
// 退出码 0 = 4/4 FIXED（且对称正例全绿）；1 = 仍有反例或正例被误杀；2 = 探针自身出错。
// 用 `probe` 证据口径：发布物不含 verification/，那个形态下它自己的判定与退出码一致。
if (existsSync(join(ROOT, 'verification/counterexamples/rc20-declaration-snapshot-4.mjs'))) {
  runOnce({
    id: 'rc20-counterexamples',
    what: '四条工单的反例集（声明快照 / 围栏解析 / 降级分支 / 制品基线）',
    cmd: process.execPath, args: [join('verification/counterexamples', 'rc20-declaration-snapshot-4.mjs')], evidence: 'probe',
  });
} else {
  notRun('rc20-counterexamples', '四条工单的反例集', '当前形态未找到 verification/counterexamples/rc20-declaration-snapshot-4.mjs：发布物不含证据目录，需在源码树里跑');
}

if (existsSync(join(ROOT, 'verification/counterexamples/rc21-artifact-consistency-3.mjs'))) {
  runOnce({
    id: 'rc21-counterexamples',
    what: '制品逐成员一致性的反例集（改非核心成员必须被点名 / 登记清单须与实物同名同数 / 生成差异须显式登记）',
    cmd: process.execPath, args: [join('verification/counterexamples', 'rc21-artifact-consistency-3.mjs')], evidence: 'probe',
  });
} else {
  notRun('rc21-counterexamples', '制品逐成员一致性的反例集', '当前形态未找到 verification/counterexamples/rc21-artifact-consistency-3.mjs：发布物不含证据目录，需在源码树里跑');
}

if (existsSync(join(ROOT, 'scripts/expert-originals-check.mjs'))) {
  runOnce({
    id: 'expert-original-probes',
    what: '专家原件对账（冻结期望表，核漂移）',
    // `probe` 证据口径：退出码 3 = 本形态没有这份证据（发布物不含 verification/）→ NOT_RUN。
    // 用默认的 `tool` 会把 3 当成 FAIL —— 源码树里永远绿，只在制品里红，正好在发布判定时翻车。
    cmd: process.execPath, args: ['scripts/expert-originals-check.mjs'], evidence: 'probe',
  });
} else {
  notRun('expert-original-probes', '专家原件探针', 'scripts/expert-originals-check.mjs 缺失（发布物不含 verification/）');
}

// ── ⑥ 门禁自检：证明**这一次**运行能识别假绿 ──────────────────────
// 一个只写 `process.exit(0)` 的空壳文件，或一个内部打印 `Failed: 3` 却退出 0 的套件，
// 必须让门禁判红。这句话不能只写在文档里 —— 要在每次跑门禁时当场验一次。
// 代价约 0.1 秒；收益是「门禁是否还有识别假绿的能力」不再依赖一条没人跑的元测试。
// 夹具故意是假绿（见 test/fixtures/gate-canary/false-green.mjs），不得把它“修好”。
const CANARY = join(ROOT, 'test/fixtures/gate-canary/false-green.mjs');
let canaryReport = { ran: false, learned: 'NOT_RUN', ok: false };
if (existsSync(CANARY)) {
  const r = spawnSync(process.execPath, [CANARY], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const learned = verdictFor({
    exitCode: r.status == null ? `signal:${r.signal}` : r.status,
    failed: countFromOutput(out, 'Failed'),
    skipped: countFromOutput(out, 'Skipped'),
    total: countFromOutput(out, 'Total'),
    evidence: 'suite',
  });
  canaryReport = { ran: true, learned: learned.status, ok: learned.status === 'FAIL' };
  console.log(`[${canaryReport.ok ? 'OK' : 'FAIL'}] ${'gate-canary-selfcheck'.padEnd(28)} 0.0s  rc=${r.status}  自检：伪造 Failed:3 ⇒ ${learned.status}`);
}
if (!canaryReport.ok) {
  // 不把它计入 counts.FAIL（否则真绿时也会多一个 FAIL），而是推入一个**总在红**的项：
  // “门禁失去了识别假绿的能力”本身就足以阻断发布。
  items.push({
    id: 'gate-canary-selfcheck',
    what: '门禁自检：伪造失败打印必须被判 FAIL',
    evidence: 'self',
    status: 'FAIL',
    reason: canaryReport.ran
      ? `门禁失去了识别假绿的能力：伪造的 Failed:3 被判成 ${canaryReport.learned}`
      : '门禁自检夹具缺失（test/fixtures/gate-canary/false-green.mjs）—— 无法证明门禁还能识别假绿',
  });
  console.log('[FAIL] gate-canary-selfcheck         门禁无法识别伪造的失败打印 —— 这个门禁当前不可被信任');
}

// ── 汇总 ───────────────────────────────────────────────────────────────
const rank = { FAIL: 0, SKIP: 1, PASS: 2, NOT_RUN: 3 };
const counts = { PASS: 0, FAIL: 0, SKIP: 0, NOT_RUN: 0 };
for (const it of items) counts[it.status]++;
// **本目录是哪种形态**：门禁统计必须说清自己在给谁签字。这不是展示细节 ——
// 发布物不含 verification/、不含 .git、也不含工作流，于是同一份代码在两种形态下
// 会有**不同数量**的 PASS/SKIP/NOT_RUN。把它们混成一个总数，就等于让"制品里跑出来的
// 26/0/5/8"和"开发树里跑出来的 37/0/0/2"互相顶替（专家 rc.31 §1 点名的正是这件事）。
const CHECKOUT = existsSync(join(ROOT, 'verification', 'baseline-check.mjs')) && existsSync(join(ROOT, '.git'))
  ? 'dev-tree' : 'npm-artifact';
const blockedSkips = items.filter((it) => it.status === 'SKIP' && (STRICT || !ALLOW_SKIP.has(it.id)));
const allowedSkips = items.filter((it) => it.status === 'SKIP' && !STRICT && ALLOW_SKIP.has(it.id));
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const coreLines = (() => {
  let n = 0;
  for (const f of readdirSync(join(ROOT, 'src/core'))) {
    if (!/\.(?:[cm]?js)$/.test(f)) continue;
    n += readFileSync(join(ROOT, 'src/core', f), 'utf8').split('\n').length;
  }
  return n;
})();
const matrix = {
  schema_version: 'tusunsun.release-gate/v1',
  package: { name: pkg.name, version: pkg.version },
  env,
  gate: {
    strict: STRICT,
    allow_skip: [...ALLOW_SKIP].sort(),
    blocked_skips: blockedSkips.map((it) => it.id).sort(),
    allowed_skips: allowedSkips.map((it) => it.id).sort(),
  },
  // 门禁自检结果：证明**这一次**运行具备识别假绿的能力，而不是「文档说它能」。
  canary: canaryReport,
  core: { measured_lines: coreLines, budget: CORE_MAX_LINES, within_budget: coreLines <= CORE_MAX_LINES },
  checkout: CHECKOUT,
  counts,
  items: items.sort((a, b) => rank[a.status] - rank[b.status] || a.id.localeCompare(b.id)),
  // 逐项明细（含理由）：跳过/未跑不是"没有信息"，它们的理由就是要被看见的那部分。
  detail: items.slice().sort((a, b) => a.id.localeCompare(b.id)).map((it) => ({
    id: it.id, status: it.status, reason: it.reason ?? null,
    exit_code: it.exit_code ?? null, skipped: it.skipped ?? null,
  })),
  probes: existsSync(join(ROOT, 'test/probes')) ? readdirSync(join(ROOT, 'test/probes')).filter((f) => f.endsWith('.mjs')).sort() : [],
  git: existsSync(join(ROOT, '.git')) ? spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim() : null,
  artifacts: readdirSync(ROOT).filter((f) => f.endsWith('.tgz')).map((f) => ({ file: f, bytes: statSync(join(ROOT, f)).size, sha256: sha256(join(ROOT, f)) })),
};
writeFileSync(JSON_OUT, JSON.stringify(matrix, null, 2) + '\n');

console.log(`\n═══ 签字矩阵 ═══════════════════════════════════════════════════════`);
const pad = (s, n) => String(s).padEnd(n);
console.log(`| ${pad('项', 30)} | ${pad('结果', 8)} | ${pad('退出码', 6)} | 耗时 |`);
console.log(`|${'-'.repeat(32)}|${'-'.repeat(10)}|${'-'.repeat(8)}|${'-'.repeat(7)}|`);
for (const it of matrix.items) {
  const ms = it.duration_ms ? `${(it.duration_ms / 1000).toFixed(1)}s` : '-';
  console.log(`| ${pad(it.id, 30)} | ${pad(it.status, 8)} | ${pad(it.exit_code ?? '-', 6)} | ${ms} |`);
}
console.log(`\n形态：${CHECKOUT}${CHECKOUT === 'npm-artifact' ? '（发布物：不含 verification/ 与 .git，故部分项必然 SKIP/NOT_RUN）' : '（开发树：含证据目录与 .git，全部项都应能跑）'}`);
console.log(`PASS ${counts.PASS}｜FAIL ${counts.FAIL}｜SKIP ${counts.SKIP}｜NOT_RUN ${counts.NOT_RUN}`);
console.log(`核心 ${coreLines}/${CORE_MAX_LINES} 行（${coreLines <= CORE_MAX_LINES ? '在预算内' : '**超预算**'}）`);
console.log(`矩阵已写入 ${JSON_OUT}`);
if (allowedSkips.length > 0) console.log(`白名单放行：${allowedSkips.map((it) => it.id).join(', ')}`);
if (blockedSkips.length > 0) {
  console.log(`\n[阻断] ${blockedSkips.length} 个 SKIP 未获放行：`);
  for (const it of blockedSkips) console.log(`  · ${it.id}：${it.reason || '未执行'}`);
  console.log('  放行需要显式 --allow-skip=<id>；--strict 下白名单不生效。');
}

if (counts.FAIL > 0 || blockedSkips.length > 0) process.exitCode = 1;
else if (counts.PASS === 0) process.exitCode = 2;

