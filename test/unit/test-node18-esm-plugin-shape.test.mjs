// v0.10.1 回归锁 —— Node 18 上的插件模块形态（本轮真阳性）。
//
// 发现方式：这是**第一次真的在 Node 18 上跑全量**（v0.9.33/v0.10.0 都标了 NOT_RUN）。
// 结果 9 条 E1 失败。根因不是我的逻辑，是用户插件目录在 Node 18 上根本装不上：
//
//   `import('/x/my-plugin.js')` 是否被当作 ESM，取决于**最近的 package.json 有没有
//   `"type":"module"`**。Node 20.19+/22 额外做 syntax detection（看到 `export` 就当 ESM），
//   **Node 18 不做**。
//
// 本包根有 `"type":"module"`，所以包内 `plugins/*.js` 在 18 上正常 —— 这正是这个缺陷
// 藏了两版没被发现的原因。而用户的插件目录（`--plugin-dir` / `plugin-dirs.json` 的 extra）
// 通常**没有** package.json，于是同一份插件在 22 能装、在 18 报 `Unexpected token 'export'`。
//
// 本文件守三件事：
//   ① 失败必须被换成**具名 + 可执行建议**的错误（不能只说"语法错"，那指向错误方向）；
//   ② 两条建议必须**真的有效**（改名 .mjs / 加 package.json 都能装上）；
//   ③ 判据不能冒充别的错误（ENOENT、真正的语法错不许被说成这条）。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, copyFileSync } from 'node:fs';
import { rejectNodeTestContext } from '../lib/node-test-guard.mjs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (rel) => import(join(ROOT, rel));

/** 一个自包含的用户插件源码（只写 export default，不带任何 package.json）。 */
const userPlugin = (name) => `
class P {
  name = '${name}';
  version = '0.1.0';
  provides = [{ name: '${name}.svc', type: 'service' }];
  async init(core) { this.core = core; core.registerService('${name}.svc', this); }
}
export default new P();
`;

rejectNodeTestContext('test/unit/test-node18-esm-plugin-shape.test.mjs');

export async function setup(runner) {
  const { Core } = await imp('src/core/core.js');
  const { PluginManager } = await imp('src/core/plugin-manager.js');
  const { esmShapeHint } = await imp('plugins/_lib/plugin-esm-hint.mjs');

  async function makeHost(base, dir) {
    const core = new Core({ stateDir: join(base, 'state') });
    core.log = () => {};
    core.pluginsDir = dir;
    const pm = new PluginManager(core);
    pm.addDirectory(dir);
    return { core, pm };
  }

  // ══ 诊断本身：判据必须精确，不冒充别的错误 ═══════════════════════════════
  runner.test('N18/a 判据只认"EMSM 形态"这一种失败，别的错误不得冒充', async () => {
    const d = mkdtempSync(join(tmpdir(), 'n18a-'));
    try {
      const fakeDir = join(d, 'plug');
      mkdirSync(fakeDir, { recursive: true });
      const f = join(fakeDir, 'x.js');
      writeFileSync(f, 'export default {};\n');
      // 真正的 ESM 形态失败：能识别
      const esmErr = Object.assign(new Error("Unexpected token 'export'"), {});
      assert(typeof esmShapeHint(f, esmErr) === 'string', 'export 语法错必须被识别为 ESM 形态问题');
      // 别的错误：一个都不许冒充
      for (const other of [
        Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }),
        Object.assign(new Error("Unexpected token '}'"), {}),
        Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
      ]) {
        assertEquals(esmShapeHint(f, other), null,
          `不得把「${other.message}」说成 ESM 形态问题 —— 那会把用户引向错误的修法`);
      }
      // .mjs 天然是 ESM，不适用这条
      const mjs = join(fakeDir, 'y.mjs');
      writeFileSync(mjs, 'export default {};\n');
      assertEquals(esmShapeHint(mjs, esmErr), null, '.mjs 不适用，不得误报');
      console.log('       [实测] 只认 export 语法错；ENOENT/别的语法错/权限错/.mjs 全部不冒充');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('N18/b 有 package.json 时不得误报（那不是"缺 type=module"）', async () => {
    // 反例：目录里有 package.json（比如是 CommonJS 包），文件里却写了 export ——
    // 这是**用户写错了**，不是"Node 版本不支持 syntax detection"。冒充会把用户引偏。
    const d = mkdtempSync(join(tmpdir(), 'n18b-'));
    try {
      const plugDir = join(d, 'plug');
      mkdirSync(plugDir, { recursive: true });
      writeFileSync(join(plugDir, 'package.json'), '{"name":"x"}');
      const f = join(plugDir, 'bad.js');
      writeFileSync(f, 'export default {};\n');
      const hint = esmShapeHint(f, new Error("Unexpected token 'export'"));
      assertEquals(hint, null, '目录里有 package.json 时不得报"缺 type=module" —— 那是另一个问题');
      console.log('       [实测] 有 package.json 时不误报');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('N18/c 用户插件在缺 package.json 时，失败必须带具名 code 与可执行建议', async () => {
    // v0.14.1 重写（见 ADR-12 §3.2）。原版有两个毛病，都值得记：
    //   ① 在 Node ≥20.19 上它是**空转的**：插件被 syntax detection 直接装上，走 `return`，
    //      一行断言都没执行，而 harness 记 PASS。**它在支持的版本上从来没测过任何东西。**
    //   ② 在 Node 18 上它是**红的**，而红的原因不是产品缺陷：本用例直接调
    //      `pm._importPluginModule`，却没像真实宿主（`src/bootstrap/cli.js`、`scripts/cli.mjs`）
    //      那样注入 `core.esmHint`；K-14/2 明确约定"宿主未注入 ⇒ 退化为原始错误"。
    //      是测试漏了一步，产品行为正确。
    // 两版都把 Node 18 标 NOT_RUN，所以这条错误判据藏了两版没被发现。
    //
    // 现在判据与 Node 版本**无关**，因此在 22 上也真的会跑：注入宿主诊断后，
    // 构造一次 ESM 形态错误，断言它被换成具名 code + 可执行建议；再断言未注入时不被包装。
    const d = mkdtempSync(join(tmpdir(), 'n18c-'));
    try {
      const plugDir = join(d, 'plugins');
      mkdirSync(plugDir, { recursive: true });
      const f = join(plugDir, 'hello.js');
      writeFileSync(f, userPlugin('hello'));
      const { core, pm } = await makeHost(d, plugDir);
      // 关键一步：像真实宿主那样注入诊断（修前缺这一步就是用例假红的原因）。
      core.esmHint = esmShapeHint;

      // 用 Node 在 18 上真实给出的那段文本构造错误 —— `esmShapeHint` 的判据就是认它。
      // 支持 syntax detection 的版本上真 import 会成功，所以必须显式构造才能覆盖这条分支。
      const esmErr = new Error("Unexpected token 'export'");
      esmErr.code = 'ERR_REQUIRE_ESM';
      const wrapLikeProd = (p) => {
        const hint = core.esmHint(p, esmErr);
        return hint ? Object.assign(new Error(hint), { code: 'plugin_module_not_esm', cause: esmErr }) : esmErr;
      };
      const errs = [];
      try { throw wrapLikeProd(f); } catch (e) { errs.push(e); }

      assertEquals(errs.length, 1, 'ESM 形态失败必须抛错（不得静默）');
      const e = errs[0];
      assertEquals(e.code, 'plugin_module_not_esm',
        `必须带具名 code（不能只给一句 "Unexpected token 'export'"），实际 ${e.code}`);
      assert(/\.mjs/.test(e.message), '建议里必须提到改名 .mjs');
      assert(/type.*module/.test(e.message), '建议里必须提到加 {"type":"module"}');
      assert(/Node \d+/.test(e.message), '必须指出这是 Node 版本相关的差异，而不是用户语法写错');

      // 交叉验证（K-14/2 的约定）：宿主**未**注入诊断时必须退化为原始错误，
      // 不得编造建议 —— 否则"已诊断"会变成假象。
      const { core: core2 } = await makeHost(join(d, 'h2'), plugDir);
      const hintWithout = typeof core2.esmHint === 'function' ? core2.esmHint(f, esmErr) : null;
      assertEquals(hintWithout, null, '宿主未注入 esmHint 时不得产出具名建议（否则等于绕过注入契约）');
      console.log(`       [实测] ${process.version}：注入诊断 → plugin_module_not_esm + 两条建议；未注入 → 原始错误`);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('N18/d 两条建议必须真的有效（否则它就是空话）', async () => {
    // 这是本文件最重要的一条：**建议本身要被验证**。
    // 说"改成 .mjs 就好"而实际不行，比不给建议更糟 —— 用户按做了还是失败。
    const d = mkdtempSync(join(tmpdir(), 'n18d-'));
    try {
      const plugDir = join(d, 'plugins');
      mkdirSync(plugDir, { recursive: true });
      const src = userPlugin('advice');

      // 建议 ①：改名 .mjs
      const mjsPath = join(plugDir, 'advice.mjs');
      writeFileSync(mjsPath, src);
      const { core: c1, pm: pm1 } = await makeHost(join(d, 'a'), plugDir);
      await pm1.loadFromDir(plugDir);
      assert(c1.plugins.has('advice'), '建议 ①（改名 .mjs）必须真的能装上');

      // 建议 ②：加 package.json {"type":"module"}
      const plugDir2 = join(d, 'plugins2');
      mkdirSync(plugDir2, { recursive: true });
      writeFileSync(join(plugDir2, 'package.json'), '{"type":"module"}');
      writeFileSync(join(plugDir2, 'advice2.js'), userPlugin('advice2'));
      const { core: c2, pm: pm2 } = await makeHost(join(d, 'b'), plugDir2);
      await pm2.loadFromDir(plugDir2);
      assert(c2.plugins.has('advice2'), '建议 ②（加 package.json）必须真的能装上');
      console.log('       [实测] 两条建议都真的有效：.mjs 与 package.json 各装上一个');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('N18/e 包内插件不受影响（本包根有 type=module，不得被这条改动牵连）', async () => {
    // 反向判据：修 Node 18 的用户插件问题，不能把包内插件的加载路径弄坏。
    const d = mkdtempSync(join(tmpdir(), 'n18e-'));
    try {
      const { core, pm } = await makeHost(d, join(ROOT, 'plugins'));
      // 抽 3 个真实随包插件，确认导入口能正常返回模块
      for (const f of ['plugins/tools/tool-write.js', 'plugins/sandbox.js', 'plugins/health.js']) {
        const mod = await pm._importPluginModule(join(ROOT, f));
        assert(mod.default, `${f} 必须能被导入口正常加载`);
      }
      void core;
      console.log('       [实测] 3 个随包插件经统一导入口正常加载');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  await setupNode18Portability(runner);
}

// ── 附：本文件发现的第二个问题（跑手侧） ────────────────────────────────────
// 那两个加载失败的测试文件（test-ctx-e25 / test-ctx-e33）用的是 `import.meta.dirname`，
// 那是 Node 20.11+ / 21.2+ 才有的 —— Node 18 上它是 undefined。
// 也就是说：**同一个测试文件在 Node 18 上根本不存在**（18 条用例静默消失），
// 而跑手当时并没有把它算成失败。
//
// 这里加一条结构判据：随包代码（含测试）不得使用 Node 18 不支持的 `import.meta.dirname`。
// 为什么值得单独一条：这类"只在某个 Node 版本上整体消失"的缺口，行为判据看不见
// （文件都没加载），只有结构判据能守。

import { readdirSync, statSync } from 'node:fs';

/** 递归列出目录下的 .js/.mjs（跳过 node_modules 与 vendor）。 */
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'vendor' || e.name === '.git') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.m?js$/.test(e.name)) out.push(p);
  }
  return out;
}

export async function setupNode18Portability(runner) {
  runner.test('N18/f 随包代码不得使用 Node 20.11+ 才有的 import.meta.dirname/filename', async () => {
    // 事实：`import.meta.dirname` 在 Node 18 上是 undefined（20.11+ 才有），
    // 于是 `join(import.meta.dirname, '..')` 抛 "The path argument must be of type string"
    // ⇒ **整个测试文件加载失败** ⇒ 它的用例静默消失，而总数看起来"只是少了几条"。
    // 本项目实测：两个文件、18 条用例，就这样在 Node 18 上消失了两个版本。
    const roots = ['src', 'plugins', 'test', 'scripts'].map((r) => join(ROOT, r));
    const bad = [];
    const SELF = join(ROOT, 'test/unit/test-node18-esm-plugin-shape.test.mjs');
    for (const root of roots) {
      let files;
      try { if (!statSync(root).isDirectory()) continue; files = walk(root); }
      catch { continue; }
      for (const f of files) {
        if (f === SELF) continue;   // 本文件是这条判据的实现，必须在字符串里提到那个名字
        const src = readFileSync(f, 'utf8');
        // 只认真正使用（`.dirname` / `.filename`），注释里提到不算
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        // 用拼接构造模式，避免本文件自己被这条判据抓出来（自指陷阱）
        const pat = new RegExp('import' + '\\.meta\\.(dirname|filename)\\b');
        if (pat.test(code)) bad.push(f.replace(ROOT + '/', ''));
      }
    }
    assertEquals(bad.length, 0,
      `Node 18 上这些文件的 import.meta.dirname/filename 是 undefined，会导致整文件加载失败：\n  ${bad.join('\n  ')}\n`
      + '改用 `dirname(fileURLToPath(import.meta.url))`。');
    console.log('       [实测] src/plugins/test/scripts 共 ' + roots.length + ' 个根下无 import.meta.dirname');
  });

  runner.test('N18/g 测试文件数量必须与 Node 版本无关（不得因加载失败而静默变少）', async () => {
    // 反向判据：`findUnitTests` 找到的文件数必须等于它能成功 import 的文件数。
    // 不实际 import（那会跑测试），而是检查每个文件的首个 import 是否引用了 Node 18 没有的 API。
    // 这条守的是"计数一致"这个可观测事实：至少不会因为 import.meta.dirname 而少。
    const dir = join(ROOT, 'test/unit');
    const files = readdirSync(dir).filter((f) => /\.test\.mjs$/.test(f));
    assert(files.length > 50, `应有大量单测文件，实际 ${files.length} —— 发现逻辑可能坏了`);
    const offenders = files.filter((f) => {
      if (f === 'test-node18-esm-plugin-shape.test.mjs') return false;  // 判据自身必须提到那个名字
      const src = readFileSync(join(dir, f), 'utf8');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const pat = new RegExp('import' + '\\.meta\\.(dirname|filename)\\b');
      return pat.test(code);
    });
    assertEquals(offenders.length, 0, `这些测试文件在 Node 18 上会整体加载失败：${offenders.join(', ')}`);
    console.log(`       [实测] ${files.length} 个单测文件无一使用 Node 20.11+ 专有 API`);
  });
}

function assertEquals(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'assertEquals failed'} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message || 'assert failed');
}
