// R0-018（rc.15）：**证据链的其余四个口子** —— G2 / B1 / B2 / B3。
//
// R0-017 只盖了 G1（rc=0 但内部 Failed>0）。同类形状还有四个，它们单独看都不显眼，
// 但同时成立时「测试全绿」这句话就没有证据力：
//
//   · G2 注释棘轮：新文件不在基线里 ⇔ 写多少注释都不受管；删文件后基线残留 ⇔ 删掉再恢复就清零。
//   · B1 行数只数换行符：删空行 + 塞超长行 ⇒ 行数不变、体积翻倍。
//   · B2 扩展名白名单：新增一个 .cjs 就同时绕过行数预算、注释棘轮、逐文件指纹。
//   · B3 用例数没有下限：删掉 105 个单测文件里的 102 个，剩下的 15 个照样「全绿」。
//
// 本用例把两类东西分开测：
//   ① **单一真相**：预算常量必须等于实测值（漂了就要显式改，不能悄悄偏离）；
//   ② **端到端**：真起子进程跑脚本，用临时文件把「该红的形状」造出来。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestRunner, assert, assertEquals } from '../harness.mjs';
import { CORE_MAX_LINES, CORE_MAX_BYTES } from '../../scripts/core-limits.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const CORE_DIR = join(ROOT, 'src', 'core');
const SOURCE_EXT = /\.(?:[cm]?js)$/;
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** 独立重算核心的行数/字节（与 scripts/line-check.js 同口径，但**不复用**它的代码）。 */
function measuredCore() {
  let lines = 0;
  let bytes = 0;
  const files = [];
  for (const f of readdirSync(CORE_DIR).sort()) {
    if (!SOURCE_EXT.test(f)) continue;
    const buf = readFileSync(join(CORE_DIR, f));
    lines += buf.toString('utf8').split('\n').length;
    bytes += buf.length;
    files.push(f);
  }
  return { lines, bytes, files };
}

function run(script, args = []) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

const PROBE_PLUGIN = join(ROOT, 'plugins', 'zz-r018-ratchet-probe.js');
const BASELINE_FILE = join(ROOT, 'docs', 'quality', 'comment-history-baseline.json');

export async function setup(runner) {
  // ── ① 单一真相 ────────────────────────────────────────────────────
  runner.test('R0-018/1 字节预算必须等于实测值（行数之外的第二道闸）', async () => {
    const m = measuredCore();
    assertEquals(CORE_MAX_LINES, m.lines, `行数预算 ${CORE_MAX_LINES} 与实测 ${m.lines} 不一致`);
    assertEquals(CORE_MAX_BYTES, m.bytes, `字节预算 ${CORE_MAX_BYTES} 与实测 ${m.bytes} 不一致`);
    console.log(`       [实测] ${m.files.length} 文件 / ${m.lines} 行 / ${m.bytes} B`);
  });

  runner.test('R0-018/2 line-check 真的在报字节，且当前通过', async () => {
    const r = run('scripts/line-check.js');
    assertEquals(r.code, 0, `line-check 应通过，实际 rc=${r.code}\n${r.out}`);
    assert(/src\/core 字节: \d+\/\d+ \[OK\]/.test(r.out), `输出里没有字节行：\n${r.out}`);
  });

  runner.test('R0-018/3 三处扩展名白名单一致（行数/指纹/文档同步都含 cjs）', async () => {
    for (const f of ['scripts/line-check.js', 'scripts/core-manifest.js', 'scripts/sync-line-docs.mjs']) {
      const src = read(f);
      assert(src.includes('[cm]?js'), `${f} 没有 [cm]?js 白名单——只认 .js 时 .cjs 在该处隐形`);
    }
  });

  runner.test('R0-018/4 core-manifest 只登记白名单扩展名，且会报“扩展名未纳入指纹”', async () => {
    const r = run('scripts/core-manifest.js');
    assertEquals(r.code, 0, `core-manifest 应通过，实际 rc=${r.code}: ${r.out}`);
    assert(read('scripts/core-manifest.js').includes('扩展名未纳入指纹'),
      'core-manifest 必须对白名单外扩展名具名报错，否则那个文件永远不会被说“新增未登记”');
    const foreign = readdirSync(CORE_DIR).filter((f) => !SOURCE_EXT.test(f) && !f.startsWith('.'));
    assertEquals(foreign.length, 0, `src/core 出现未登记扩展名：${foreign.join(', ')}`);
  });

  runner.test('R0-018/5 注释基线的文件集合与 plugins/ 磁盘集合完全一致', async () => {
    const base = JSON.parse(read('docs/quality/comment-history-baseline.json')).files || {};
    const onDisk = [];
    const walk = (rel) => {
      for (const e of readdirSync(join(ROOT, 'plugins', rel), { withFileTypes: true })) {
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(p);
        else if (SOURCE_EXT.test(e.name)) onDisk.push(`plugins/${p}`);
      }
    };
    walk('');
    const a = Object.keys(base).sort();
    const b = onDisk.sort();
    const missing = b.filter((f) => !a.includes(f));
    const stale = a.filter((f) => !b.includes(f));
    assertEquals(missing.length, 0, `未登记注释基线：${missing.slice(0, 5).join(', ')}`);
    assertEquals(stale.length, 0, `基线里已不存在的文件：${stale.slice(0, 5).join(', ')}`);
    console.log(`       [实测] 基线 ${a.length} 个文件 = 磁盘 ${b.length} 个`);
  });

  // ── ② 端到端：注释棘轮全生命周期 ─────────────────────────────────────
  runner.test('R0-018/6 新文件必须显式登记；拒写不得先落盘；删文件后残留必须红', async () => {
    // 被测脚本会**改写 tracked 的基线文件**。用例必须把它原样恢复：
    // 否则跑一次单测就在仓库里留下一条真实变更，谁都说不清那条 raises 是谁加的。
    const snapshot = read('docs/quality/comment-history-baseline.json');
    try {
      // a) 新文件落盘但未登记 ⇒ gate 必须红。
      writeFileSync(PROBE_PLUGIN, '// history R9-999 legacy\n// extra comment\nmodule.exports = {};\n');
      const a = run('scripts/comment-audit.mjs', ['--gate']);
      assertEquals(a.code, 1, '未登记的新文件必须让注释门禁判红');
      assert(/未登记注释基线/.test(a.out), `应点名“未登记注释基线”：\n${a.out}`);

      // b) 直接写基线必须被拒（棘轮只降不升），且**不得**先落盘再报错。
      const before = read('docs/quality/comment-history-baseline.json');
      const b = run('scripts/comment-audit.mjs', ['--gate', '--write-baseline']);
      assertEquals(b.code, 1, '--write-baseline 抬高时必须非零退出');
      assert(/拒绝写入基线/.test(b.out), `应明确“拒绝写入基线”：\n${b.out}`);
      assertEquals(read('docs/quality/comment-history-baseline.json'), before,
        '被拒绝时不得改动基线文件（拒绝之后还是写进去，等于没拒）');

      // c) 显式 --allow-raise 才登记，并记进 raises 审计史。
      const c = run('scripts/comment-audit.mjs', ['--gate', '--write-baseline', '--allow-raise']);
      assertEquals(c.code, 0, `显式放行后应写入成功：\n${c.out}`);
      const raised = JSON.parse(read('docs/quality/comment-history-baseline.json')).raises || [];
      assert(raised.length > 0, '抬高必须留下 raises 记录，否则没人能在 review 里看到它');

      // d) 删掉文件但基线残留 ⇒ gate 必须红（“删掉再恢复”不再能清零）。
      rmSync(PROBE_PLUGIN);
      const d = run('scripts/comment-audit.mjs', ['--gate']);
      assertEquals(d.code, 1, '基线残留必须让门禁判红');
      assert(/已不存在/.test(d.out), `应点名“已不存在”：\n${d.out}`);
    } finally {
      try { if (existsSync(PROBE_PLUGIN)) rmSync(PROBE_PLUGIN); } catch { /* 尽力 */ }
      writeFileSync(BASELINE_FILE, snapshot);
    }
    // e) 清理后必须回到绿，且临时文件确实不在了。
    assertEquals(existsSync(PROBE_PLUGIN), false, '临时探针文件必须被删掉');
    const e = run('scripts/comment-audit.mjs', ['--gate']);
    assertEquals(e.code, 0, `清理后门禁应恢复通过：\n${e.out}`);
  });

  // ── ③ 用例数棘轮 ──────────────────────────────────────────────────
  runner.test('R0-018/7 每个套件都必须在用例数基线里登记', async () => {
    const base = JSON.parse(read('test/baseline-counts.json')).suites || {};
    const runAll = read('test/run-all.mjs');
    const names = [...runAll.matchAll(/\{ name: '([^']+)', script: '([^']+)' \}/g)].map((m) => m[1]);
    assert(names.length >= 4, `run-all 的套件清单解析失败（拿到 ${names.length} 个）`);
    for (const n of names) {
      assert(n in base, `套件「${n}」没有用例数基线：新套件必须先登记，否则它少跑也没人知道`);
    }
  });

  runner.test('R0-018/8 run-all 真的把用例数缺失/不足计入失败', async () => {
    const src = read('test/run-all.mjs');
    assert(/countDiffs/.test(src), 'run-all 必须有 countDiffs 收集器');
    assert(/countDiffs\.length === 0/.test(src), 'countDiffs 必须参与 allPassed 判定（收集了不用＝没收集）');
    assert(/min_cases/.test(src) && /min_files/.test(src), '用例数与测试文件数两个下限都要查');
  });

  runner.test('R0-018/9 用例数基线对 Unit 给出了真实下限（不是 0 也不是占位符）', async () => {
    const base = JSON.parse(read('test/baseline-counts.json')).suites || {};
    assert(base.Unit, '基线里必须有 Unit');
    assert(base.Unit.min_cases > 1000, `Unit 的下限 ${base.Unit.min_cases} 看起来不是真实值`);
    assert(base.Unit.min_files > 100, `Unit 的测试文件下限 ${base.Unit.min_files} 看起来不是真实值`);
    console.log(`       [实测] Unit ≥ ${base.Unit.min_cases} 用例 / ≥ ${base.Unit.min_files} 文件`);
  });
}
