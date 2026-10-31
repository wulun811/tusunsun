// R0-101：CI 工作流与 package.json 脚本必须对得上（开发仓与开源产物**共用同一判据**）。
//
// 背景（实测缺陷）：开发仓的 `.github/workflows/ci.yml` 被原样复制进开源产物，而它引用了
// `npm run check` / `build:oss` / `preflight:dist` / `check:r06:release` / `test:tt` / `test:tt:parity`
// ——这些脚本**不在开源包里**，开源仓 7 个作业里有 5 个必然 `npm error Missing script`。
// 修法是"开源仓 CI 由专用模板生成"（见 scripts/oss-workflows/），而本用例把
// 「工作流只能调用本树真实存在的脚本」变成**常规门禁**，让这类缺陷在开发树就被拦住：
//   · C1 开发仓：`.github/workflows/*.yml` 引用的脚本都在开发仓 package.json 里；
//   · C2 反例对照：探测器必须能命中未声明脚本（防空过）；
//   · C3 开源产物：同上，且不得再出现开发仓专属脚本名。
//
// 本文件不含任何私有内容，故随开源包发布——它在开源树里同样有效（检查该树自己的工作流）。

import { TestRunner, assert } from '../harness.mjs';
import { requireRepoOnly, describeCarrier } from '../lib/carrier.mjs';
import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

// 剥掉 YAML 注释：注释不是可执行命令（否则"解释性文字里举例的 npm run X"会假红）。
const stripComments = (text) => text.split('\n').map((l) => l.replace(/(^|\s)#.*$/, '')).join('\n');

// 返回 { label, files, wfCount, problems }；缺 package.json 或 workflows 目录返回 null。
function checkTree(label, root) {
  const pkgPath = join(root, 'package.json');
  const wfDir = join(root, '.github', 'workflows');
  if (!existsSync(pkgPath) || !existsSync(wfDir)) return null;
  const declared = new Set(Object.keys(JSON.parse(readFileSync(pkgPath, 'utf8')).scripts || {}));
  const files = readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)).map((f) => join(wfDir, f));
  const problems = [];
  for (const file of files) {
    const wf = file.slice(file.lastIndexOf('/') + 1);
    const text = stripComments(readFileSync(file, 'utf8'));
    for (const m of text.matchAll(/npm run ([\w:.-]+)/g)) {
      if (!declared.has(m[1])) problems.push(`${wf} → npm run ${m[1]}（未声明）`);
    }
    // `npm test` / `npm start` 是内置别名，等价于 run test / run start
    for (const m of text.matchAll(/\bnpm (test|start)\b/g)) {
      if (!declared.has(m[1])) problems.push(`${wf} → npm ${m[1]}（未声明）`);
    }
    for (const m of text.matchAll(/\bnode\s+([\w][\w./-]*\.mjs)\b/g)) {
      if (m[1].startsWith('node_modules/')) continue; // 装完包才存在，不是本树内路径
      if (!existsSync(join(root, m[1]))) problems.push(`${wf} → node ${m[1]}（文件不存在）`);
    }
  }
  return { label, files, wfCount: files.length, problems };
}

export async function setup(runner) {
  runner.test('R0-101/C1 开发仓 CI：工作流引用的脚本都已声明、node 入口都存在', () => {
    // npm 发行包按设计不含 `.github/`（见 test/lib/carrier.mjs）⇒ 发行包里如实记 NOT_RUN。
    // 源码检出里这条**照旧是硬门**：工作流读不到、引用悬空，都算 FAIL。
    if (!requireRepoOnly(runner, ROOT, 'CI 工作流只调用本树真实存在的脚本')) return;
    const r = checkTree('开发仓', ROOT);
    assert(r !== null && r.wfCount > 0, '源码检出应含 package.json 与 .github/workflows/*.yml');
    assert(r.problems.length === 0, `工作流存在悬空引用：\n${r.problems.join('\n')}`);
    console.log(`       [实测] ${describeCarrier(ROOT)}；开发仓 ${r.wfCount} 个工作流，引用全部可解析`);
  });

  runner.test('R0-101/C2 反例对照：探测器必须能命中未声明脚本（防空过）', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'r0-101-'));
    try {
      mkdirSync(join(tmp, '.github', 'workflows'), { recursive: true });
      writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node t.mjs' } }));
      writeFileSync(join(tmp, '.github', 'workflows', 'ci.yml'),
        'jobs:\n  a:\n    steps:\n      - run: npm run build:oss\n      - run: npm test\n');
      const r = checkTree('反例', tmp);
      assert(r.problems.length === 1 && r.problems[0].includes('build:oss'),
        `探测器应恰好命中 1 处未声明脚本，实际：${JSON.stringify(r.problems)}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  runner.test('R0-101/C3 开源仓 CI：只调用本仓真实存在的脚本，且无开发仓专属脚本', () => {
    // 本仓的发布单元就是包根（没有 dist/oss 中转），所以「开源产物」就是这棵树本身。
    // npm 发行包不含 `.github/` ⇒ 记 NOT_RUN；源码检出里照旧是硬门（读不到就是 FAIL）。
    if (!requireRepoOnly(runner, ROOT, '开源仓 CI 只调用本仓真实存在的脚本')) return;
    const r = checkTree('开源仓', ROOT);
    assert(r !== null && r.wfCount > 0, '本仓应含 package.json 与 .github/workflows/*.yml');
    assert(r.problems.length === 0, `本仓工作流存在悬空引用：\n${r.problems.join('\n')}`);
    // 同样只看**可执行行**：注释里说明"开发仓有哪些脚本"不算引用
    const text = r.files.map((f) => stripComments(readFileSync(f, 'utf8'))).join('\n');
    for (const banned of ['test:tt', 'build:oss', 'preflight:dist', 'check:r06', 'sync:meta']) {
      assert(!text.includes(banned), `开源仓 CI 不得引用开发仓专属脚本：${banned}`);
    }
    // 防空过：工作流里至少要真的调用过命令，否则本用例什么都没观测到。
    assert(/npm run |npm (test|start)\b|\bnode\s+[\w./-]+\.mjs/.test(text),
      '工作流里应当有可执行命令（否则本用例没有观测到任何东西）');
    console.log(`       [实测] 本仓 ${r.wfCount} 个工作流，引用全部落在开源脚本集内`);
  });
}
