// test-0.9.24-structural-and-interface-fixes.test.mjs
//
// v0.9.24 的回归用例：一条用例对一个缺陷，全部**先有探针、后有代码**。
//
// 这一版最值得记住的一点是 **S5 那条**：它发现的缺陷，此前被一个名字叫
// `freezeCapability does not block command (only callCapability)` 的用例
// **当成规格断言住了**。绿灯锁死了缺陷，而且锁了好几轮。
// 所以本文件不只测"修好了"，还测"以后不能再退回去"。
//
// 编号 S1-S7 与 CHANGELOG 的缺陷表一一对应。

import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { rejectNodeTestContext } from '../lib/node-test-guard.mjs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function imp(p) {
  return import(`file://${join(ROOT, p)}?t=${Date.now()}-${Math.random()}`);
}

function mkTmp(tag) {
  return mkdtempSync(join(tmpdir(), `t0924-${tag}-`));
}

rejectNodeTestContext('test/unit/test-0.9.24-structural-and-interface-fixes.test.mjs');

export async function setup(runner) {
  const { Core } = await imp('src/core/core.js');
  const cleanups = [];
  runner.afterAll(() => {
    for (const d of cleanups) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ } }
  });
  const newCore = (tag) => {
    const d = mkTmp(tag);
    cleanups.push(d);
    return new Core({ stateDir: d });
  };

  // ── S1：listCapabilities 是公开枚举面，且是快照 ─────────────────────────────
  runner.test('S1 core.listCapabilities：公开枚举 + prefix 过滤 + 修改快照不影响内核', async () => {
    const core = newCore('s1');
    core.registerCapability('tool.read', { handler: async () => 1, owner: 'tool-read' });
    core.registerCapability('tool.write', { handler: async () => 2, owner: 'tool-write' });
    core.registerCapability('chat.handle', { handler: async () => 3, owner: 'haotian-lite' });

    assertEquals(core.listCapabilities().length, 3, '应枚举出全部 3 个能力');
    assertEquals(
      core.listCapabilities({ prefix: 'tool.' }).map((c) => c.id).sort().join(','),
      'tool.read,tool.write',
      'prefix 必须只返回匹配项',
    );
    assertEquals(core.listCapabilities({ prefix: 'nope' }).length, 0, '不匹配的 prefix 返回空数组');

    const owner = core.listCapabilities().find((c) => c.id === 'chat.handle')?.owner;
    assertEquals(owner, 'haotian-lite', '必须带 owner —— 调用方拿它做让位/旁路判定');

    // 快照语义：调用方改它不能影响内核
    const snap = core.listCapabilities();
    snap[0].id = 'hacked';
    snap.push({ id: 'injected', owner: 'evil' });
    assertEquals(core.listCapabilities().length, 3, '修改快照不得影响内核的能力表');
    assert(!core.listCapabilities().some((c) => c.id === 'injected'), '不得被注入');
  });

  // ── S2：插件层不再读私有 _capabilities ──────────────────────────────────────
  runner.test('S2 插件层零私有字段访问：不再有 core._capabilities', async () => {
    const files = [
      'plugins/cell-runtime.js',
      'plugins/haotian-lite.js',
      'plugins/tool-executor.js',
    ];
    for (const f of files) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      // 只看真正的代码行：注释里会提到这个名字（那是解释"以前怎么做的"）
      const codeLines = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
      const hits = codeLines.filter((l) => /\._capabilities\b/.test(l));
      assertEquals(hits.length, 0, `${f} 仍在读私有字段 _capabilities：${hits[0] ?? ''}`);
    }
  });

  // ── S3：只读工具名单单一来源，且两处判定一致 ────────────────────────────────
  runner.test('S3 只读名单单一真相：清单只在 tool-policy.js 定义一次，两处判定同源', async () => {
    const { isReadonlyTool, listReadonlyTools } = await imp('plugins/_lib/tool-policy.js');
    const list = listReadonlyTools();
    assert(list.length > 0, '名单不得为空');

    // 清单本体只允许出现在 tool-policy.js
    const owner = readFileSync(join(ROOT, 'plugins/_lib/tool-policy.js'), 'utf8');
    assert(owner.includes("'read_file'"), 'tool-policy.js 必须持有清单本体');
    for (const f of ['plugins/cell-runtime.js', 'plugins/tool-executor.js']) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      const codeLines = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
      const hardcoded = codeLines.filter((l) => /'tool-read'\s*,\s*'tool-list'/.test(l));
      assertEquals(hardcoded.length, 0, `${f} 又复制了一份只读清单（应与 tool-policy.js 同源）`);
    }

    // 执行器与 policy 的判定必须逐项一致（含不认识的工具名）
    const { default: exec } = await imp('plugins/tool-executor.js');
    exec.core = { get: () => undefined, getService: () => null, log: () => {}, emitFast: () => {} };
    for (const name of [...list, 'tool-write', 'tool-bash', 'tool-rm', 'not-a-tool']) {
      assertEquals(
        exec._checkModeReadOnly(name).ok, isReadonlyTool(name),
        `"${name}" 的只读判定在两处不一致`,
      );
    }
  });

  // ── S4：check:deps 的零依赖约束是显式名单，覆盖 src/ 全部文件 ────────────────
  runner.test('S4 check:deps 名单制：src/ 每个文件都被显式归类，脚本无未归类残留', async () => {
    const src = readFileSync(join(ROOT, 'scripts/core-dep-check.mjs'), 'utf8');
    assert(/ZERO_DEP_FILES/.test(src), '必须存在显式名单 ZERO_DEP_FILES');
    assert(/unclassified/.test(src), '必须有"未归类文件"检查（否则名单退化成装饰）');
    assert(/missing/.test(src), '必须有"名单过期"检查（否则死登记无人清理）');

    // 真的跑一遍，且必须是 OK
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync(process.execPath, [join(ROOT, 'scripts/core-dep-check.mjs')], {
      cwd: ROOT, encoding: 'utf8',
    });
    assert(/发行物依赖口径 OK/.test(out), `check:deps 必须通过，实际输出尾部：${out.slice(-300)}`);
    assert(/受零依赖约束的文件: (\d+) 个/.test(out), '输出必须报告受约束文件数，便于肉眼核对覆盖');
  });

  // ── S5：freezeCapability 必须在 command() 上同样生效 ────────────────────────
  runner.test('S5 freezeCapability 两条入口一致：command 不再绕过冻结', async () => {
    const core = newCore('s5');
    let hits = 0;
    core.registerCapability('probe.cap', { handler: async () => { hits++; return 'ran'; }, owner: 'p' });

    const ok = await core.command('probe.cap');
    assert(ok.ok, '未冻结时应正常执行');
    assertEquals(hits, 1, '未冻结时 handler 执行 1 次');

    core.freezeCapability('probe.cap');

    const viaCmd = await core.command('probe.cap');
    const viaCap = await core.callCapability('probe.cap');

    assert(!viaCmd.ok, '冻结后 command() 不得执行 handler（这是被旧用例锁死的缺陷）');
    assertEquals(viaCmd.state, 'denied', 'command() 的状态应为 denied');
    assertEquals(viaCmd.code, 'capability_frozen', 'command() 的 code 应与 callCapability 相同');
    assertEquals(viaCmd.code, viaCap.code, '两条入口的拒绝理由必须一致，上层才能统一处置');
    assertEquals(hits, 1, '冻结后 handler 计数必须停在 1 —— 冻结等于"不再执行"');
  });

  // ── S6：core 的 denied 在 Cell 结果里是 rejected，不是 failed ───────────────
  runner.test('S6 denied → rejected：未被执行 ≠ 执行失败', async () => {
    const core = newCore('s6');
    core.registerCapability('chat.handle', { handler: async () => 'reply', owner: 'h' });
    core.freezeCapability('chat.handle');
    const r = await core.command('chat.handle');
    assertEquals(r.state, 'denied', '前提：core 用 denied 表示"拒绝执行"');

    // 复刻 cell-runtime 的映射判据（与产品代码同一套分支）
    const src = readFileSync(join(ROOT, 'plugins/cell-runtime.js'), 'utf8');
    assert(/result\?\.state === 'denied' \? 'rejected'/.test(src),
      'cell-runtime 必须把 core 的 denied 映射成 rejected');

    // rejected 与 failed 在合同里是两个不同的词，不能混
    const { EXECUTION_STATES } = await imp('plugins/_lib/cell/contract.js');
    assert(EXECUTION_STATES.includes('rejected'), 'rejected 必须是合法的执行状态');
    assert(EXECUTION_STATES.includes('failed'), 'failed 也合法 —— 正因如此才不能混用');
  });

  // ── S7：plugins/ 一级条目语义唯一，_lib 不再是"像插件的目录" ────────────────
  runner.test('S7 plugins/ 结构：一级 .js 必须是插件，_lib 里必须不是插件', async () => {
    const { readdirSync } = await import('node:fs');
    const dir = join(ROOT, 'plugins');
    const entries = readdirSync(dir, { withFileTypes: true });

    // 目录项：除了 tools/（真插件家族）与 _lib/（辅助模块容器），不应有别的目录
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    for (const d of dirs) {
      assert(d === '_lib' || d === 'tools',
        `plugins/${d}/ 既不是插件目录也不是 _lib —— 一级条目语义必须唯一`);
    }

    // 判据换成**真实导出**，不再用正则猜形状。
    // v0.9.24 那版用 `/^\s*(async\s+)?init\s*\(core/m` 猜"是不是插件"，它在合并后立刻误杀：
    // 21 个并入的平台插件里有 4 种不同写法（`export {name,...,init}`、`export default {name,init}`、
    // `export default new XPlugin()`、`async init(core)` 方法），正则只认识最后一种。
    // **形状判据必须问装载器问的那个问题**：`m.default ?? m` 上有没有 `name` 字符串 + `init` 函数。
    // 这也正是 `plugin-manager._loadEagerPlugin` 的分支条件，所以它不会与运行时漂移。
    const shapeOf = async (file) => {
      const m = await import(pathToFileURL(file).href);
      const p = m.default ?? m;
      return { isPlugin: typeof p?.name === 'string' && typeof p?.init === 'function', mod: m };
    };

    // `_lib` 里放的是**不受装载器管**的内部模块，其中可能有"import 就产生副作用"的入口
    // （`_lib/sandbox/bootstrap.mjs` 是**子进程入口**：顶层就 `process.on('message')`，
    //  并在 ready 时 `process.send(...)` ⇒ 在单测进程里 import 它直接
    //  `TypeError: process.send is not a function`）。
    // 所以 `_lib` 一侧**不能**用 import 判形状，改用静态读源码判"看起来像不像插件"。
    // 判据比 import 版略宽（正则），但方向是安全的：它只会**更容易**判红，
    // 不会因为漏判而放过一个能被装载的插件。
    const looksLikePluginSource = (src) => {
      // 装载器要的是"导出上同时有 name 字符串 与 init 函数"。静态近似：
      //   ① 有 name 声明（类字段 / 对象字面量 / export const name）
      //   ② 有 init 声明（方法 / 函数 / 对象属性）
      const hasName = /(?:^|[\s,{])(?:export\s+)?(?:const\s+|let\s+|var\s+)?name\s*[=:]\s*['"`]/m.test(src);
      const hasInit = /(?:^|[\s,{])(?:export\s+)?(?:async\s+)?(?:function\s+)?init\s*[=:(\s]/m.test(src);
      return hasName && hasInit;
    };

    // ① 一级 .js 必须是插件。豁免只有 tui.js —— 它是 CLI 命令提供者（导出 cliCommands），
    //    文件里自己写明"不是插件"。豁免要**显式登记**，不能靠"碰巧没被检查"。
    // 一级 .js 必须是插件。**豁免要显式登记，且理由必须可验证**——不能只是"恰好没被检查"。
    // 每个豁免配一个 `holds(mod)` 判据：条件不再成立时本用例立刻变红，
    // 而不是让一个过期豁免永远留在表里（那正是 v0.9.24 那版 S7 的死法）。
    const NON_PLUGIN = new Map([
      ['tui.js', {
        why: 'CLI 命令提供者：导出 cliCommands，没有 name/init，文件里自己写明"不是插件"',
        holds: (m) => Array.isArray(m.cliCommands),
        lost: '没有导出 cliCommands',
      }],
      ['channel-base.js', {
        why: '公开的渠道扩展基类：README 与 3 个 examples 都 `import { ChannelBase }`；'
          + '默认导出是基类本身（init 在原型上），装载器按 `plugin.init` 判定 ⇒ 跳过，符合预期。'
          + 'v0.9.27：原先这里还自带一个 `ChannelREST`（从未被装载、订阅一个全仓没人 emit 的事件），已删除',
        holds: (m) => typeof m.ChannelBase === 'function'
          && typeof m.ChannelBase.prototype.init === 'function',
        lost: '没有导出 ChannelBase，或其原型上没有 init',
      }],
    ]);
    const flat = entries.filter((x) => x.isFile() && x.name.endsWith('.js')).map((x) => x.name).sort();
    for (const f of flat) {
      const { isPlugin, mod } = await shapeOf(join(dir, f));
      const ex = NON_PLUGIN.get(f);
      if (ex) {
        assert(ex.holds(mod), `plugins/${f} 登记为非插件（${ex.why}），但判据已不成立：${ex.lost} —— 豁免失效，请重判`);
        assert(!isPlugin, `plugins/${f} 现在已满足插件形状，就不需要豁免了 —— 请从 NON_PLUGIN 表里删掉`);
        continue;
      }
      assert(isPlugin,
        `plugins/${f} 不是插件（导出上没有 name+init），也不在 NON_PLUGIN 豁免表里 —— 辅助模块应移入 _lib/`);
    }
    // 豁免表反向核对：表里登记的每个文件都还得真的存在，否则是死登记。
    for (const f of NON_PLUGIN.keys()) {
      assert(flat.includes(f), `NON_PLUGIN 表登记了 plugins/${f}，但该文件不存在 —— 死登记须清理`);
    }

    // ② _lib 里不得出现插件：能被装载的东西不该待在"内部模块容器"里。
    //
    // v0.9.26：这里原本只收 `.js`，而 `_lib/sandbox/bootstrap.mjs` **本身就是 `.mjs`** ——
    // 全仓唯一的 `.mjs` 恰好住在这个被扫的目录里，判据却对它完全失明。
    // 变异实测：往 `_lib/` 放 `fake-plugin.mjs`（`export default { name, init }`）S7 仍 PASS，
    // 同一形状的 `.js` 立刻判红。而 `loadFromDir` 的白名单把插件名映射成 `<name>.js`
    // **或** `<name>.mjs`，两者同样"能被装载"——判据必须一起收。
    const walkLib = (p, out = []) => {
      for (const e of readdirSync(p, { withFileTypes: true })) {
        const q = join(p, e.name);
        if (e.isDirectory()) walkLib(q, out);
        else if (/\.(js|mjs)$/.test(e.name)) out.push(q);
      }
      return out;
    };
    if (existsSync(join(dir, '_lib'))) {
      const libFiles = walkLib(join(dir, '_lib'));
      // 反向自检：判据本身不得再次退化成"只扫 .js"。
      // 锚点用**磁盘上真实存在**的 `.mjs`（`_lib/sandbox/bootstrap.mjs`），而不是
      // "扫描结果里有没有 .mjs"——后者是恒真（有才断言有，等于什么都没断言）。
      // 锚文件不在时不判红：那时无从校验的是"覆盖"，不是"结构违规"。
      const mjsOnDisk = [];
      const collectMjs = (p) => {
        for (const e of readdirSync(p, { withFileTypes: true })) {
          const q = join(p, e.name);
          if (e.isDirectory()) collectMjs(q);
          else if (e.name.endsWith('.mjs')) mjsOnDisk.push(q);
        }
      };
      collectMjs(join(dir, '_lib'));
      const mjsFiles = libFiles.filter((f) => f.endsWith('.mjs'));
      assertEquals(mjsFiles.length, mjsOnDisk.length,
        `_lib 下磁盘有 ${mjsOnDisk.length} 个 .mjs、判据只收进 ${mjsFiles.length} 个 —— `
        + `.mjs 同样能被装载（白名单映射 <name>.js 或 <name>.mjs），形状判据不得只扫 .js`);
      for (const f of libFiles) {
        // 静态判形状，**不 import**：见上面 `looksLikePluginSource` 的说明。
        const src = readFileSync(f, 'utf8');
        assert(!looksLikePluginSource(src),
          `plugins/_lib 下的 ${f.replace(ROOT + '/', '')} 看起来满足插件形状（name+init），`
          + `会被当成插件装载 —— 应上移到 plugins/`);
      }
      console.log(`       [实测] _lib 全树扫 ${libFiles.length} 个 js/mjs（其中 .mjs ${mjsFiles.length} 个），无插件形状`);
    }
    console.log(`       [实测] plugins/ 一级 ${flat.length} 个 .js：${flat.length - NON_PLUGIN.size} 个插件 + ${NON_PLUGIN.size} 个已登记非插件（${[...NON_PLUGIN.keys()].join(', ')}）`);
  });

  // ── S8：config 只有一个落点（v0.9.25 重写，原断言已被目录合并反转） ────────────
  runner.test('S8 config 单一落点：全仓只有一个 config 实现，早加载直指它', async () => {
    // 历史：这里原本断言 `!existsSync(src/builtin/config.js)`，因为那是 `plugins/config.js`
    // 的**再导出壳**，同一插件两个文件路径导致去重判据恒为 false。
    // v0.9.25 目录合并时，机械替换把这条断言改成了"plugins/config.js 不得存在"——正好反了，
    // 于是它立刻变红。留在这里作为提醒：**路径替换不能替代语义判断**。
    //
    // 现在要守的是同一件事的现代形态：config 这个插件**在全仓只有一个实现**。
    const real = join(ROOT, 'plugins', 'config.js');
    assert(existsSync(real), 'plugins/config.js 必须存在（它是 config 插件的唯一实现）');

    const boot = readFileSync(join(ROOT, 'src/bootstrap/cli.js'), 'utf8');
    // 判**代码**而不是全文：注释里会提到旧壳路径（那是解释"以前怎么做的"），
    // 用它判红等于禁止记录历史。这里直接核对那行 URL 字面量。
    assert(/new URL\('\.\.\/\.\.\/plugins\/config\.js', import\.meta\.url\)/.test(boot),
      '早加载必须用 `../../plugins/config.js` 解析到唯一实现');
    assert(!/new URL\('[^']*builtin\/config\.js'/.test(boot), '早加载不得再指向已删除的旧壳路径');

    // 全仓扫描：除了 plugins/config.js，不得有第二个文件导出 name='config' 的插件。
    // 只扫不 import（import 会执行插件顶层代码，门禁不该有副作用）。
    const { readdirSync } = await import('node:fs');
    const roots = ['plugins', 'src'];
    const impls = [];
    const walk = (rel) => {
      const abs = join(ROOT, rel);
      if (!existsSync(abs)) return;
      for (const e of readdirSync(abs, { withFileTypes: true })) {
        const r = `${rel}/${e.name}`;
        if (e.isDirectory()) { if (!['node_modules', 'test-results'].includes(e.name)) walk(r); continue; }
        if (!/\.(js|mjs)$/.test(e.name)) continue;
        const src = readFileSync(join(ROOT, r), 'utf8');
        // 认两种写法：类字段 `name = 'config'` 与对象字面量 `name: 'config'`
        if (/(?:\bname\s*[=:]\s*['"])config['"]/.test(src) && /\binit\s*[(:]/.test(src)) impls.push(r);
      }
    };
    for (const r of roots) walk(r);
    assertEquals(impls.length, 1,
      `config 插件在全仓只能有一个实现（>1 就意味着"哪份在跑"取决于扫描顺序）：${impls.join(', ')}`);
    assertEquals(impls[0], 'plugins/config.js', 'config 实现应落在 plugins/config.js');
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function assertEquals(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg ?? 'assertEquals failed'}\n  实际: ${JSON.stringify(actual)}\n  期望: ${JSON.stringify(expected)}`);
  }
}
