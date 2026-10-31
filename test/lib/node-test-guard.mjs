// 自研 harness 用例（export setup / export default）与 node:test 是两套驱动。
//
// node --test 只按文件退出码计结果：文件 import 成功、setup() 从未被调用，
// 就会被报成「1 test / 0 assertions / pass」—— 一条断言都没跑，结论却是绿的。
// 这里把「被 node --test 驱动」变成 import 期的硬错误，而不是靠人记得别这么跑。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const HARNESS_DIRS = ['test/unit', 'test/integration'];

/** import 期调用：node --test 会为每个测试文件设置 NODE_TEST_CONTEXT。 */
export function rejectNodeTestContext(origin) {
  if (!process.env.NODE_TEST_CONTEXT) return;
  throw new Error(
    `[runner-guard] ${origin} 必须由自研 harness 驱动（node test/run-unit.mjs / run-integration.mjs / run-one.mjs），`
    + '不能用 node --test：后者不会调用 setup()，会把 0 个断言报成通过。',
  );
}

function walk(dir, out) {
  let names;
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const abs = join(dir, name);
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) walk(abs, out);
    else if (name.endsWith('.test.mjs')) out.push(abs);
  }
}

/**
 * 扫描 harness 驱动目录，回答两个问题：
 *   · 有没有用例（0 个 = 护栏没看见目标，调用方必须报错）；
 *   · 有没有用例导入 node:test（在 node --test 下会绕过 harness 而被记为通过）。
 * `test/windows-release.test.mjs` 是独立的 node:test 套件、不在这些目录内，故不在判据范围。
 */
export function scanHarnessTests(root) {
  const files = [];
  for (const rel of HARNESS_DIRS) walk(join(root, rel), files);
  const violations = [];
  // 只认**静态 import/export 声明**（行首）：本模块自身与测试 fixture 的字符串里
  // 会出现 `node:test` 字样，按子串匹配会把 "教护栏识别误用" 的用例本身判成误用。
  const NODE_TEST_IMPORT = /^\s*(?:import\s[^\n]*?from\s*['"]node:test['"]|import\s*['"]node:test['"]|export\s[^\n]*?from\s*['"]node:test['"])/m;
  const HARNESS_IMPORT = /from\s+['"][^'"]*harness\.mjs['"]/;
  const GUARD_CALL = /rejectNodeTestContext\s*\(/;
  for (const abs of files) {
    const src = readFileSync(abs, 'utf8');
    if (NODE_TEST_IMPORT.test(src)) {
      violations.push({ file: relative(root, abs), reason: '导入了 node:test —— 该目录由自研 harness 驱动' });
      continue;
    }
    if (!HARNESS_IMPORT.test(src) && !GUARD_CALL.test(src)) {
      violations.push({ file: relative(root, abs), reason: '既未 import harness，也未在 import 期调用 rejectNodeTestContext —— node --test 会把 0 断言记成通过' });
    }
  }
  return { files: files.map((abs) => relative(root, abs)), violations };
}
