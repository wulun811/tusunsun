// E1 回归锁 —— 插件装载/卸载/重载的生命周期事实（v0.9.33）。
//
// 本文件对应送审报告 §1.2 的三条 EV 反例：
//   EV-01 文件监视触发插件重载，却未恢复 init() 与能力注册；
//   EV-02 eager 加载插件的 plugin.reload 没有重载路径；
//   EV-03 懒加载插件手工卸载后，再调用不能重新加载。
//
// 三条在修复前都是**实跑复现**的，不是读源码推断的：
//   EV-02：eager 装 demo → getService(demo.svc)=true 而 _pluginFilePaths.has('demo')=false
//          → plugin.reload 返回 "No file path for: demo"
//   EV-01：改文件触发 watch → 文件已是 V2 而 callCapability 仍返回 V1，
//          插件 state=running 但 plugin.core 为 undefined（init 从未跑）
//   EV-03：pm.unload('lazy1') 后 _lazyLoaded.has=true 而 _pending.has=false
//          → 再调 hasCapability 永久为 false（两套状态互相矛盾且不可恢复）
//
// 关于 fs.watch 的说明（诚实）：本环境的 fs.watch 在测试进程里**不稳定**，
// 直接测"改文件 → 等回调"会得到偶发不触发的假绿/假红。所以这里不去赌 watch 的
// 事件投递，而是**直接调用 watch 分支现在使用的那个函数** `_reloadPlugin`。
// 这不是绕过判据：修复的实质是"watch 与 capability 两个入口合成同一个实现"，
// 而那条实现才是要被钉住的东西；入口本身在 `E1/f` 里用结构判据守住。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { rejectNodeTestContext } from '../lib/node-test-guard.mjs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (rel) => import(join(ROOT, rel));

/** 生成一个自包含的插件源码：provides 一个 service + 一个 capability，handler 返回 label。 */
const pluginSrc = (name, label) => `
class P {
  name = '${name}';
  version = '0.1.0';
  provides = [
    { name: '${name}.svc', type: 'service' },
    { name: '${name}.work', type: 'capability' },
  ];
  async init(core) {
    this.core = core;
    core.registerService('${name}.svc', this);
    core.registerCapability('${name}.work', { owner: '${name}', handler: async () => '${label}' });
  }
  async stop() { this.stopped = true; }
}
export default new P();
`;

rejectNodeTestContext('test/unit/test-e1-plugin-lifecycle.test.mjs');

export async function setup(runner) {
  const { Core } = await imp('src/core/core.js');
  const { PluginManager } = await imp('src/core/plugin-manager.js');

  async function makeHost(prefix) {
    const d = mkdtempSync(join(tmpdir(), prefix));
    const dir = join(d, 'plugins');
    mkdirSync(dir, { recursive: true });
    // v0.10.1：夹具必须自带 `{"type":"module"}`。否则在 Node 18 上这些临时目录里的
    // `.js` 不被当作 ESM（18 不做 syntax detection），整个文件会以
    // `Unexpected token 'export'` 失败 —— 而那**不是产品缺陷**，是夹具不可移植。
    // 这条夹具缺陷掩盖了一个真问题：它也让我在 v0.9.33/v0.10.0 两版都没发现
    // "用户插件目录在 Node 18 装不上"（见 test-node18-esm-plugin-shape.test.mjs）。
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    const core = new Core({ stateDir: join(d, 'state') });
    core.log = () => {};
    core.pluginsDir = dir;
    const pm = new PluginManager(core);
    pm.addDirectory(dir);
    pm.registerCapabilities();
    return { d, dir, core, pm };
  }

  // ══ EV-02：eager 插件必须可重载 ══════════════════════════════════════════
  runner.test('E1/a eager 装载的插件必须登记来源路径，否则 plugin.reload 恒失败', async () => {
    const h = await makeHost('e1a-');
    try {
      const file = join(h.dir, 'demo.js');
      writeFileSync(file, pluginSrc('demo', 'V1'));
      await h.pm.loadFromDir(h.dir);
      await h.core.start();

      assertEquals(!!h.core.getService('demo.svc'), true, '前提：eager 插件应已装载');
      assertEquals(h.pm._pluginFilePaths.get('demo'), file,
        'eager 装载必须登记来源路径 —— 修前这条 map 只由 _indexLazyPlugin 写，eager 永远没有');

      const r = await h.core.callCapability('plugin.reload', { name: 'demo' });
      assertEquals(r.state, 'succeeded',
        `plugin.reload 必须可用 —— 修前恒返回 "No file path for: demo"，实际 ${r.error}`);
      assertEquals(r.payload?.ok, true, `reload 应成功，实际 ${JSON.stringify(r.payload)}`);
      console.log('       [实测] eager 插件登记了来源路径，plugin.reload 返回 ok');
    } finally { rmSync(h.d, { recursive: true, force: true }); }
  });

  // ══ EV-01：重载必须真的换成新实现（不是"看起来 reload 了"） ══════════════
  runner.test('E1/b 重载后必须服务**新**实现（修前仍返回旧值 V1 而状态显示 running）', async () => {
    const h = await makeHost('e1b-');
    try {
      const file = join(h.dir, 'hot.js');
      writeFileSync(file, pluginSrc('hot', 'V1'));
      await h.pm.loadFromDir(h.dir);
      await h.core.start();
      const before = await h.core.callCapability('hot.work', {});
      assertEquals(before.payload, 'V1', '前提：基线是 V1');

      writeFileSync(file, pluginSrc('hot', 'V2'));
      const r = await h.pm._reloadPlugin('hot', file, 'watch');
      assertEquals(r.ok, true, `重载应成功，实际 ${JSON.stringify(r)}`);

      const after = await h.core.callCapability('hot.work', {});
      assertEquals(after.payload, 'V2',
        `重载后必须服务新实现 —— 修前 watch 分支完全不 init，实测仍返回 V1，实际 "${after.payload}"`);
      console.log('       [实测] 重载后 callCapability 返回 V2（修前是 V1）');
    } finally { rmSync(h.d, { recursive: true, force: true }); }
  });

  runner.test('E1/c 重载必须重新跑 init（服务与能力都要恢复，不能只留下 start 的壳）', async () => {
    const h = await makeHost('e1c-');
    try {
      const file = join(h.dir, 'hot2.js');
      writeFileSync(file, pluginSrc('hot2', 'V1'));
      await h.pm.loadFromDir(h.dir);
      await h.core.start();

      writeFileSync(file, pluginSrc('hot2', 'V2'));
      await h.pm._reloadPlugin('hot2', file, 'watch');

      const p = h.core.plugins.get('hot2');
      assert(p, '重载后插件必须仍在 plugins 表里');
      assertEquals(!!p.core, true,
        'init 必须被调用过（plugin.core 被绑定）—— 修前这里为 undefined，而 state 却显示 running');
      assertEquals(!!h.core.getService('hot2.svc'), true, '服务必须在重载后重新注册（unload 会清掉它）');
      const cap = h.core.listCapabilities().find((c) => c.id === 'hot2.work');
      assert(cap, '能力必须在重载后重新注册');
      console.log('       [实测] core 绑定、服务、能力三者都恢复了');
    } finally { rmSync(h.d, { recursive: true, force: true }); }
  });

  runner.test('E1/d 重载失败必须保留旧版本（不能把还在正常服务的插件弄坏）', async () => {
    // 这是合同里"重载失败优先保留旧版本"的判据。修法靠"先导入、后卸载"这个次序：
    // 导入失败时旧插件还没被碰过，所以它继续正常服务。
    const h = await makeHost('e1d-');
    try {
      const file = join(h.dir, 'keep.js');
      writeFileSync(file, pluginSrc('keep', 'GOOD'));
      await h.pm.loadFromDir(h.dir);
      await h.core.start();

      // 写一份**语法坏掉**的源码：import 会抛，此时绝不能先 unload
      writeFileSync(file, 'export default { this is not valid js }}}');
      const r = await h.pm._reloadPlugin('keep', file, 'watch');
      assertEquals(r.ok, false, '导入失败时重载必须报失败');
      assertEquals(r.code, 'reload_import_failed', `必须报具名 code，实际 ${r.code}`);
      assertEquals(r.kept_previous, true, '必须显式说明旧版本被保留');

      const still = await h.core.callCapability('keep.work', {});
      assertEquals(still.payload, 'GOOD',
        `导入失败后旧插件必须仍在服务 —— 实际 payload=${JSON.stringify(still.payload)}，`
        + '修前若先 unload 再 import，这里会变成 capability_not_found');
      console.log('       [实测] 导入失败 → kept_previous=true，旧版本仍返回 GOOD');
    } finally { rmSync(h.d, { recursive: true, force: true }); }
  });

  runner.test('E1/e 卸载后失败必须标 unavailable，不得静默回落成"可用"', async () => {
    const h = await makeHost('e1e-');
    try {
      const file = join(h.dir, 'boom.js');
      // 能 import，但 init 抛错 —— 这条路走过了 unload，旧版本回不来
      writeFileSync(file, `
class B {
  name = 'boom';
  provides = [{ name: 'boom.work', type: 'capability' }];
  version = '0.1.0';
  async init(core) { this.core = core; core.registerCapability('boom.work', { owner: 'boom', handler: async () => 'B' }); }
  async stop() {}
}
export default new B();
`);
      await h.pm.loadFromDir(h.dir);
      await h.core.start();

      writeFileSync(file, `
class B {
  name = 'boom';
  provides = [{ name: 'boom.work', type: 'capability' }];
  version = '0.1.0';
  async init() { throw new Error('init exploded'); }
  async stop() {}
}
export default new B();
`);
      const r = await h.pm._reloadPlugin('boom', file, 'watch');
      assertEquals(r.ok, false, 'init 抛错时重载必须失败');
      assertEquals(r.code, 'reload_failed_unavailable', `必须报具名 code，实际 ${r.code}`);
      assertEquals(r.state, 'unavailable', '必须标 unavailable，不得留在"看起来可用"的状态');
      console.log('       [实测] init 抛错 → reload_failed_unavailable + state=unavailable');
    } finally { rmSync(h.d, { recursive: true, force: true }); }
  });

  // ══ EV-03：卸载后必须可再激活 ════════════════════════════════════════════
  runner.test('E1/f 懒插件卸载后必须可重新懒加载（修前 _lazyLoaded 与 _pending 互相矛盾）', async () => {
    const h = await makeHost('e1f-');
    try {
      const file = join(h.dir, 'lazy1.js');
      writeFileSync(file, pluginSrc('lazy1', 'LAZY'));
      await h.pm.loadAll([], ['lazy1']);
      await h.core.start();

      assertEquals(await h.core.hasCapability('lazy1.work'), true, '前提：懒加载应成功');
      assertEquals(h.pm._lazyLoaded.has('lazy1'), true, '前提：装载后应记为 lazyLoaded');

      const u = await h.pm.unload('lazy1');
      assertEquals(u.ok, true, `卸载应成功，实际 ${JSON.stringify(u)}`);

      // 修前的矛盾就在这里：说"装着"（_lazyLoaded 为 true）却说"没有来源"（_pending 为 false）
      assertEquals(h.pm._lazyLoaded.has('lazy1'), false,
        '_lazyLoaded 必须被清掉 —— 修前卸载后仍为 true，与 _pending=false 互相矛盾');
      assertEquals(h.pm._pending.has('lazy1'), true,
        '_pending 必须保留/重建来源 —— 修前这里是 false，于是永久不可再激活');

      const again = await h.core.hasCapability('lazy1.work');
      assertEquals(again, true, '卸载后必须能重新懒加载 —— 修前这里是 false（不可恢复）');
      const call = await h.core.callCapability('lazy1.work', {});
      assertEquals(call.payload, 'LAZY', '重新激活后必须真的可用');
      console.log('       [实测] 卸载 → lazyLoaded=false / pending=true → 可再激活并返回 LAZY');
    } finally { rmSync(h.d, { recursive: true, force: true }); }
  });

  runner.test('E1/g 重复卸载必须是具名失败而不是抛错（状态机要能重复调用）', async () => {
    const h = await makeHost('e1g-');
    try {
      const file = join(h.dir, 'twice.js');
      writeFileSync(file, pluginSrc('twice', 'T'));
      await h.pm.loadAll([], ['twice']);
      await h.core.start();
      await h.core.hasCapability('twice.work');
      const first = await h.pm.unload('twice');
      assertEquals(first.ok, true, '第一次卸载应成功');
      const second = await h.pm.unload('twice');
      assertEquals(second.ok, false, '第二次卸载应报"不存在"，不应抛异常或报成功');
      console.log('       [实测] 二次卸载 → ok:false（具名失败，不抛）');
    } finally { rmSync(h.d, { recursive: true, force: true }); }
  });

  // ══ E1-b（v0.10.0）：有在途调用时不得替换 ══════════════════════════════════
  //
  // 这是计划书 §4 E1 的一条硬要求，v0.9.33 时我标了 NOT_RUN。
  // 修前实测（handler 6s、drain 上限 5s）：重载报 `{ok:true}`，在飞调用
  // `failed/handler_threw/"resource closed mid-flight"`，磁盘残留 `"step1;step2;"`。
  // 也就是**卸载悄悄打断了在途工作、留下半截副作用，还报告成功**。
  runner.test('E1/j 有在途调用时必须拒绝替换（reload_busy），且保留旧版本', async () => {
    const h = await makeHost('e1j-');
    try {
      // handler 故意慢：让重载发生在它跑到一半时
      writeFileSync(join(h.dir, 'slowp.js'), `
class S {
  name = 'slowp';
  provides = [{ name: 'slowp.work', type: 'capability' }];
  version = '0.1.0';
  async init(core) {
    this.core = core;
    core.registerCapability('slowp.work', { owner: 'slowp', handler: async () => {
      await new Promise((r) => setTimeout(r, 400));
      return 'OLD-IMPL';
    }});
  }
  async stop() { this.stopped = true; }
}
export default new S();
`);
      await h.pm.loadAll(['slowp'], []);
      await h.core.start();

      const inflight = h.core.callCapability('slowp.work', {});
      await new Promise((r) => setTimeout(r, 80));   // 让它真的开始跑
      assertEquals(h.core.getInflight('slowp') > 0, true, '前提：应有一条在飞调用');

      const r = await h.pm._reloadPlugin('slowp', join(h.dir, 'slowp.js'), 'test');
      assertEquals(r.ok, false, '有在途调用时重载必须失败');
      assertEquals(r.code, 'reload_busy', `必须报具名 reload_busy，实际 ${r.code}`);
      assertEquals(r.kept_previous, true, '必须显式说明旧版本被保留');
      assertEquals(r.inflight > 0, true, '必须报出在途数量');

      // 关键判据：那条在飞调用必须**完整跑完并成功**（不被自己的 stop 打断）
      const out = await inflight;
      assertEquals(out.state, 'succeeded',
        `在飞调用必须成功完成 —— 修前这里是 failed/handler_threw（被 stop 打断），实际 ${out.state}`);
      assertEquals(out.payload, 'OLD-IMPL', '拿到的应该是旧版本的结果（旧版本仍在服务）');
      console.log(`       [实测] 在途反射拒绝（reload_busy, inflight=${r.inflight}），在飞调用完整成功`);
    } finally { rmSync(h.d, { recursive: true, force: true }); }
  });

  runner.test('E1/k 在飞调用结束后重载必须成功（拒绝不是永久锁死）', async () => {
    // 反向判据：如果拒绝之后永远拒绝，那就是把"安全"做成了"不可用"。
    const h = await makeHost('e1k-');
    try {
      writeFileSync(join(h.dir, 'p2.js'), pluginSrc('p2', 'V1'));
      await h.pm.loadAll(['p2'], []);
      await h.core.start();
      // 无在途 ⇒ 正常重载
      writeFileSync(join(h.dir, 'p2.js'), pluginSrc('p2', 'V2'));
      const r = await h.pm._reloadPlugin('p2', join(h.dir, 'p2.js'), 'test');
      assertEquals(r.ok, true, '没有在途调用时必须能重载（不得永久锁死）');
      const out = await h.core.callCapability('p2.work', {});
      assertEquals(out.payload, 'V2', '重载后必须服务新实现');
      console.log('       [实测] 无在途时重载成功，返回新实现 V2');
    } finally { rmSync(h.d, { recursive: true, force: true }); }
  });

  runner.test('E1/l drain 超时不得静默：必须发 drain_timeout 事件并 warn', async () => {
    // 即使选择"继续卸载"（关停不能因一条卡死的链永久挂住），也必须让这件事**可见**。
    // 修前 `_step3DrainRequests` 什么都不返回，调用方无从判断。
    const h = await makeHost('e1l-');
    try {
      const events = [];
      h.core.on('core:plugin.drain_timeout', (e) => events.push(e));

      // 直接测 lifecycle 的 drain 契约（不需要真等 5s：给它一条永远不归零的 inflight）
      const fakeName = 'fake-busy';
      h.core._inflight.set(fakeName, 3);
      const res = await h.pm.lc._step3DrainRequests(fakeName, 100);
      assertEquals(res.drained, false, '有在途时 drained 必须是 false');
      assertEquals(res.inflight, 3, `必须报出真实在途数，实际 ${res.inflight}`);

      // unload 收到超时信号后必须发事件
      h.core.plugins.set(fakeName, { name: fakeName, state: 'running' });
      await h.pm.lc.unload(fakeName);
      assertEquals(events.length >= 1, true,
        `drain 超时必须发 core:plugin.drain_timeout（否则静默打断在途工作），实际 ${events.length} 条`);
      console.log(`       [实测] drain 返回 drained=false/inflight=3，unload 发了 ${events.length} 条 drain_timeout`);
    } finally {
      h.core._inflight.delete('fake-busy');
      rmSync(h.d, { recursive: true, force: true });
    }
  });

  // ══ 结构判据：两个重载入口必须共用一份实现 ═══════════════════════════════
  runner.test('E1/h 不得存在第二份重载实现（修前的根因就是各写一份且都错）', async () => {
    // 修前：`plugin.reload` 内联一份、watch 回调内联一份。两份都会漂移，
    // 而且事实上已经漂移了 —— 一份停两次，另一份完全不 init。
    // 判据：源码里 `import(...&v=...)` 这种"带版本号重新导入"的写法只允许出现在 `_reloadPlugin` 里。
    const src = readFileSync(join(ROOT, 'src/core/plugin-manager.js'), 'utf8');
    const strip = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const hits = [...strip.matchAll(/import\(pathToFileURL\([^)]*\)\.href\s*\+\s*'\?'/g)];
    // 允许的：eager 装载（无版本号，不入此判据）、lazy 装载（&t=）、_reloadPlugin（&v=）
    const withVersion = (strip.match(/&v=/g) || []).length;
    assertEquals(withVersion, 1,
      `带 &v= 的重新导入只允许一处（_reloadPlugin），实际 ${withVersion} 处 —— `
      + '多出来的那一份就是会漂移的第二份重载实现。命中：'
      + hits.map((m) => m[0]).join(' | '));
    console.log(`       [实测] 带版本号的重导入仅 1 处（&v= 出现 ${withVersion} 次）`);
  });

  runner.test('E1/i watch 分支必须调用共享实现，不得内联重载逻辑', async () => {
    const src = readFileSync(join(ROOT, 'src/core/plugin-manager.js'), 'utf8');
    const strip = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const i = strip.indexOf('watch(dir,');
    assert(i > 0, '应能找到 watchForChanges 里的 watch 回调');
    const tail = strip.slice(i, i + 900);
    assert(/_reloadPlugin\s*\(/.test(tail),
      'watch 回调必须调用 _reloadPlugin（与 plugin.reload 同一实现）');
    assert(!/\.init\s*\(/.test(tail) && !/\.register\s*\(/.test(tail),
      'watch 回调不得自己 init/register —— 那正是修前"完全不 init"那条错路的形状');
    console.log('       [实测] watch 回调只调 _reloadPlugin，无内联 init/register');
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
