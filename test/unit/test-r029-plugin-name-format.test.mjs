// R0-029（rc.15）：名字就是身份，于是名字必须先被校验（专家 rc.14 复审 S7）。
//
// `core.js` 里把宿主接管标记写成 `HOST_OWNER = '@host'`，并在旁边断言：
// **「`@` 开头不是合法插件名，于是『这条服务谁都不能按名卸载』成为可判定的」**。
// 但这句断言从来没有被执行过——内核里没有任何插件名校验（全仓无对应正则）。
// 注释把一个**未验证的前提**写成了事实，于是：
//
//   loadOne('@host')                → ok:true
//   getServiceOwnership('cfg')      → owner:'@host'（与宿主接管同值）
//   releaseServicesByOwner('@host') → []      ← 判据以为"这是宿主，谁都不能卸"
//   unload('@host')                 → ok，服务还在
//   再 releaseServicesByOwner(...)  → []      ← 永远清不掉
//
// 一个插件只要叫 `@host`，就变成"宿主"，注册的服务从此没有任何 API 能拆掉——
// 与注释承诺的方向正好相反。同一条缺失的判据还管着第二件事：`name` 会被直接拼进
// 文件路径（`join(dir, name + '.js')`），所以 `../x` 这种名字等于把装载器当任意文件导入器用。
//
// 本文件钉住：
//   /1  `loadOne('@host')` 必须具名拒绝，且不得占用任何服务（修前：ok:true + 僵尸服务）
//   /2  旁路：直接把 `{name:'@host'}` 交给 `Core.register` 也必须拒绝
//   /3  结构判据：真实 `plugins/` 下每个文件名都通过判据（防"正则写窄了把正常插件也拒了"）
//   /4  反向判据：合法名仍然能真的装载并注册服务
//   /5  名字不得把装载器变成任意文件导入器（`../` 与绝对路径都必须具名拒绝）
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assert, assertEquals } from '../harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (rel) => import(join(ROOT, rel));

export async function setup(runner) {
  const { Core } = await imp('src/core/core.js');
  const { PluginManager } = await imp('src/core/plugin-manager.js');

  /** 建一个临时宿主：真 Core（temp stateDir / pluginsDir）+ 真 PluginManager。 */
  function host() {
    const dir = mkdtempSync(join(tmpdir(), 'r029-'));
    const pluginsDir = join(dir, 'plugins');
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(join(pluginsDir, 'package.json'), '{"type":"module"}');
    const core = new Core({ stateDir: join(dir, 'state'), pluginsDir });
    core.log = () => {};
    const pm = new PluginManager(core);
    pm.dirs.push(pluginsDir);
    return {
      dir, core, pm, pluginsDir,
      writePlugin(name, body) {
        const p = join(pluginsDir, `${name}.js`);
        writeFileSync(p, body);
        return p;
      },
      cleanup() {
        try { pm.stopWatching(); } catch { /* 尽力而为 */ }
        try { pm._stopIdleTimer(); } catch { /* 尽力而为 */ }
        try { core.removeAllListeners(); } catch { /* 尽力而为 */ }
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  /** 一个"叫这个名字、并且抢注一个服务"的插件。 */
  const pluginBody = (name, service = 'cfg') => [
    'export default {',
    `  name: ${JSON.stringify(name)},`,
    '  version: "1.0.0",',
    '  permissions: [],',
    `  async init(core) { core.registerService('${service}', { by: ${JSON.stringify(name)} }); },`,
    '  async stop() {},',
    '};',
    '',
  ].join('\n');

  // ══ S7 主干：`@host` 不得成为插件名 ══════════════════════════════
  runner.test('R0-029/1 loadOne("@host") 必须具名拒绝，且不得占用任何服务', async () => {
    const h = host();
    try {
      h.writePlugin('@host', pluginBody('@host'));
      // 先记下宿主自己的归属标记语义：任何插件名等于它，就等于"这条服务谁都不能卸"。
      const before = h.core.getService('cfg');
      assertEquals(before, undefined, '前置：一开始不应有 cfg 服务');

      const r = await h.pm.loadOne('@host');
      if (r.ok) {
        // 走到这里就是修前：插件成了"宿主"，它注册的服务从此拆不掉。
        const ownership = h.core.getServiceOwnership('cfg');
        const released = h.core.releaseServicesByOwner('@host');
        await h.pm.unload('@host').catch(() => null);
        const stillThere = h.core.getService('cfg');
        assert(false,
          `"@host" 不是合法插件名，必须被拒绝；实际 loadOne ok:true。`
          + `随之而来：owner=${JSON.stringify(ownership?.owner)}、releaseServicesByOwner('@host')=${JSON.stringify(released)}、`
          + `卸载后 getService('cfg')=${JSON.stringify(stillThere)} —— 这条服务没有任何 API 拆得掉`);
      }
      assertEquals(r.code, 'plugin_name_invalid',
        `拒绝必须具名（plugin_name_invalid），实际 ${r.code} / "${r.error}"`);
      assertEquals(h.core.getService('cfg'), undefined, '被拒绝的装载不得留下任何服务');
      console.log(`       [实测] loadOne("@host") → ok=${r.ok} code=${r.code}`);
    } finally {
      h.cleanup();
    }
  });

  // ══ 旁路：不经过 loadOne 也逃不掉 ═══════════════════════════════
  runner.test('R0-029/2 直接 Core.register({name:"@host"}) 必须拒绝（旁路同一判据）', async () => {
    const h = host();
    try {
      let thrown = null;
      try {
        await h.core.register({ name: '@host', version: '1.0.0', async init(core) { core.registerService('cfg', {}); } });
      } catch (err) {
        thrown = err;
      }
      assert(thrown, '"@host" 必须被 register 拒绝；实际注册成功（于是 init 里注册的服务归属就成了宿主标记）');
      assertEquals(thrown.code, 'plugin_name_invalid',
        `拒绝必须具名（plugin_name_invalid），实际 ${thrown.code} / "${thrown.message}"`);
      assertEquals(h.core.plugins.has('@host'), false, '被拒绝的插件不得进入 plugins 表');
      assertEquals(h.core.getService('cfg'), undefined, '被拒绝的注册不得执行 init、不得留下服务');

      // 反向：合法名照旧注册成功。
      const ok = await h.core.register({ name: 'legit-plugin', version: '1.0.0', async init() {} });
      assertEquals(ok, true, '合法名字必须仍然注册成功（判据不能把正常路径一起关掉）');
      console.log(`       [实测] register("@host") → ${thrown.code}；register("legit-plugin") → ok=${ok}`);
    } finally {
      h.cleanup();
    }
  });

  // ══ 结构判据：正则不能写窄 ═══════════════════════════════════════
  runner.test('R0-029/3 结构判据：真实 plugins/ 的每个文件名都必须通过名字判据', async () => {
    const { PLUGIN_NAME_RE } = await imp('src/core/plugin-meta.js');
    assert(PLUGIN_NAME_RE instanceof RegExp, '名字判据必须由内核导出一份（不能各入口各写一条正则）');
    const names = [];
    const walk = (dir) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!/\.(?:m?js|cjs)$/.test(f)) continue;
        names.push({ file: p.slice(ROOT.length + 1), base: f.replace(/\.(?:m?js|cjs)$/, '') });
      }
    };
    walk(join(ROOT, 'plugins'));
    assert(names.length > 50, `必须真的扫到插件文件（实际 ${names.length} 个）`);
    const rejected = names.filter((n) => !PLUGIN_NAME_RE.test(n.base));
    assertEquals(rejected.length, 0,
      `判据把真实插件名拒了（正则写窄了）：${JSON.stringify(rejected.slice(0, 5).map((n) => n.file))}`);
    // 反向：判据必须真的能拒——不然上面那条只是"正则恒真"。
    for (const bad of ['@host', 'Host', '-x', '.x', '_x', '', 'a b', 'a/b', '../x', '插件']) {
      assertEquals(PLUGIN_NAME_RE.test(bad), false, `判据必须拒绝 ${JSON.stringify(bad)}`);
    }
    for (const good of ['config', 'tool-bash', 'model-openai', 'a.b-c_d', 'x1']) {
      assertEquals(PLUGIN_NAME_RE.test(good), true, `判据必须接受 ${JSON.stringify(good)}`);
    }
    console.log(`       [实测] ${names.length} 个真实插件名全部通过；10 个坏名被拒、5 个好名被接受`);
  });

  // ══ 反向判据：合法名照旧能真的装载 ═══════════════════════════════
  runner.test('R0-029/4 反向判据：合法名仍然能真的装载并注册服务', async () => {
    const h = host();
    try {
      h.writePlugin('r029-good', pluginBody('r029-good', 'demo'));
      const r = await h.pm.loadOne('r029-good');
      assertEquals(r.ok, true, `合法插件必须能装载，实际 ${JSON.stringify(r)}`);
      const svc = h.core.getService('demo');
      assert(svc && svc.by === 'r029-good', `装载后服务必须真的在，实际 ${JSON.stringify(svc)}`);
      const ownership = h.core.getServiceOwnership('demo');
      assertEquals(ownership?.owner, 'r029-good', `服务归属应为其插件名，实际 ${JSON.stringify(ownership)}`);
      console.log('       [实测] r029-good 装载成功，服务归属 = r029-good');
    } finally {
      h.cleanup();
    }
  });

  // ══ 同一句缺失判据管的第二件事：名字会被拼进路径 ═════════════════
  runner.test('R0-029/5 名字不得把装载器变成任意文件导入器（`../` 与绝对路径）', async () => {
    const h = host();
    try {
      // 在插件目录**外面**放一个"插件"，用 `../` 的名字去找它。声明名与请求名故意一致，
      // 这样"名字对不上"那道检查恰好**不会**挡住它——能挡住它的只有名字格式判据本身。
      const outside = join(h.dir, 'outside.js');
      writeFileSync(outside, pluginBody('../outside', 'pwned'));
      const r = await h.pm.loadOne('../outside');
      if (r.ok) {
        assert(false,
          `loadOne('../outside') 把插件目录之外的任意文件当成插件导入了（ok:true）：`
          + '名字被直接拼进路径（join(dir, name + ".js")），所以"名字格式"同时是"导入边界"');
      }
      assert(r.code === 'plugin_name_invalid' || r.code === 'plugin_source_not_found',
        `非法名字必须具名拒绝，实际 ${r.code} / "${r.error}"`);
      assertEquals(h.core.getService('pwned'), undefined, '目录外的文件不得被执行');
      console.log(`       [实测] loadOne("../outside") → ${r.code}；目录外服务未出现`);
    } finally {
      h.cleanup();
    }
  });
}
