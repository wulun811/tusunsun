// R0-143（v0.9.31 续）：**跨 Core 单例串写** —— 本轮查出的最严重一条。
//
// 这是我修 R0-136（缓存键）时被 R0-76 的全量失败**撞**出来的，不是主动想到的。
// 复现过程值得记下来，因为它说明"某条测试在全量下红、单独跑绿"不一定是测试脏：
//
//   R0-76/①2 在全量里报 ENOENT `/tmp/r136-xxxx/ws/deliveries/out.txt`。
//   注意那个路径：`r136` 是**上一个测试文件**建的临时目录，而 R0-76 用的是 `r076`。
//   顺着查下去，根因不在测试里：
//
//     `import(path)` 走 ESM 模块缓存，**同一路径永远返回同一个实例**。
//     而插件几乎都写成 `async init(core) { this.core = core; ... }`。
//     于是同一进程里两个 Core 装载同一个插件时，拿到的是**同一个对象**，
//     后装载的那个把 `this.core` 覆写成自己。
//
//   实测（两个真 Core、各自装 `tool-write`）：
//     用 **A** 调 `tool.write({path:'a.txt'})`
//       → A 的工作区：没有文件
//       → B 的工作区：**有 a.txt**
//       → 返回 `{ok:true, state:'succeeded'}`
//
//   也就是说：**同一个进程里跑两个 Core，工具会串到别人的目录里干活，还报成功。**
//   这是"成功但写错地方"，最难发现的那一类。
//
// 为什么以前没被发现：
//   · v0 的受支持形态是「1 Cell : 1 Core : 1 进程」，正常启动确实只有一个 Core；
//   · 但**测试、嵌入宿主、以及双 Cell 同进程**都会真实踩到；
//   · 而且症状不是崩溃，是"写对了但写到别处"——不看磁盘根本看不出来。
//
// 修法：给每个 `PluginManager` 一个实例标识，`import` 时带上它做 cache-bust，
// 使每个 Core 拿到**自己那份**插件实例。与 `_reloadCounter`（同一实例内重载的版本号）
// 是两件事：那个区分"版本"，这个区分"实例身份"。
import { mkdtempSync, mkdirSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TestRunner, assert, assertEquals } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(join(ROOT, rel));

/** 一个真 Core + 真 PluginManager + 真 workspace，只装指定的工具插件。 */
async function makeCore(tag, tools) {
  const d = mkdtempSync(join(tmpdir(), `r143-${tag}-`));
  const ws = join(d, 'ws');
  mkdirSync(ws, { recursive: true });
  const { Core } = await imp('src/core/core.js');
  const { PluginManager } = await imp('src/core/plugin-manager.js');
  const core = new Core({ stateDir: join(d, 'state') });
  core.log = () => {};
  core.setData('agent.workDir', ws);
  const pm = new PluginManager(core);
  core.registerService('plugin-manager', pm);
  pm.addDirectory(join(ROOT, 'plugins', 'tools'));
  await pm.loadAll(tools, []);
  await core.start();
  return { d, ws, core, pm };
}

export async function setup(runner) {
  runner.test('R0-143/a 两个 Core 各自装载同一工具：调用 A 不得写进 B 的目录', async () => {
    const A = await makeCore('A', ['tool-write']);
    const B = await makeCore('B', ['tool-write']);
    try {
      const r = await A.core.callCapability('tool.write', { path: 'a.txt', content: 'x' });
      assertEquals(r.ok, true, `A 的写入应成功，实际 ${JSON.stringify(r).slice(0, 160)}`);
      assertEquals(existsSync(join(A.ws, 'a.txt')), true,
        'A 的文件必须落在 A 的工作区');
      assertEquals(existsSync(join(B.ws, 'a.txt')), false,
        '修前实测：文件落进了 **B** 的工作区并返回 succeeded（跨 Core 串写）。'
        + '根因是 `import(path)` 的模块缓存让两个 Core 共享同一个插件实例，'
        + '后装载的 `init(core)` 覆写了 `this.core`');
      console.log('       [实测] A 的调用落在 A 的工作区，B 目录无文件');
    } finally {
      rmSync(A.d, { recursive: true, force: true });
      rmSync(B.d, { recursive: true, force: true });
    }
  });

  runner.test('R0-143/b 反例：双 Core 下两个工作区各写各的，互不干扰', async () => {
    const A = await makeCore('A2', ['tool-write']);
    const B = await makeCore('B2', ['tool-write']);
    try {
      await A.core.callCapability('tool.write', { path: 'only-a.txt', content: 'A' });
      await B.core.callCapability('tool.write', { path: 'only-b.txt', content: 'B' });
      assertEquals(existsSync(join(A.ws, 'only-a.txt')), true, 'A 应写自己的文件');
      assertEquals(existsSync(join(A.ws, 'only-b.txt')), false, 'A 的工作区不得出现 B 的文件');
      assertEquals(existsSync(join(B.ws, 'only-b.txt')), true, 'B 应写自己的文件');
      assertEquals(existsSync(join(B.ws, 'only-a.txt')), false, 'B 的工作区不得出现 A 的文件');
      // 内容也要对：只查存在性会漏掉"写了但写的是别人的内容"
      const a = readFileSync(join(A.ws, 'only-a.txt'), 'utf8');
      const b = readFileSync(join(B.ws, 'only-b.txt'), 'utf8');
      assertEquals(a, 'A', 'A 的文件内容必须是 A 写的');
      assertEquals(b, 'B', 'B 的文件内容必须是 B 写的');
      console.log('       [实测] 双 Core 各写各的，文件与内容都不串');
    } finally {
      rmSync(A.d, { recursive: true, force: true });
      rmSync(B.d, { recursive: true, force: true });
    }
  });

  runner.test('R0-143/c 单 Core 正常路径不得被这次修复影响', async () => {
    const C = await makeCore('C', ['tool-write']);
    try {
      const r = await C.core.callCapability('tool.write', { path: 'solo.txt', content: 'hello' });
      assertEquals(r.ok, true, `单 Core 写入应成功，实际 ${JSON.stringify(r).slice(0, 160)}`);
      assertEquals(existsSync(join(C.ws, 'solo.txt')), true, '单 Core 下应正常写盘');
      console.log('       [实测] 单 Core 路径正常');
    } finally { rmSync(C.d, { recursive: true, force: true }); }
  });

  runner.test('R0-143/e 正常装配路径必须完全隔离（A 的写入不得进 B 的目录）', async () => {
    // 这是 R0-143 的**正面判据**：不只看"两个 Core 拿到不同实例"（结构），
    // 而是看"用 A 调用，文件真的落在 A"（行为）。
    // 之所以要单独一条：结构判据（扫描 import 带 _instanceTag）只能证明**我们做了那件事**，
    // 不能证明那件事**有效果**。实测证实：把结构改对之后行为才正确。
    const fs = await import('node:fs');
    const mk = async (tag) => {
      const d = fs.mkdtempSync(join(tmpdir(), tag + '-'));
      const ws = join(d, 'ws');
      fs.mkdirSync(ws);
      const { Core } = await imp('src/core/core.js');
      const { PluginManager } = await imp('src/core/plugin-manager.js');
      const core = new Core({ stateDir: join(d, 'state') });
      core.log = () => {};
      core.setData('agent.workDir', ws);
      const pm = new PluginManager(core);
      core.registerService('plugin-manager', pm);
      pm.addDirectory(join(ROOT, 'plugins', 'tools'));
      await pm.loadAll(['tool-write'], []);
      await core.start();
      return { core, ws, d };
    };
    const A = await mk('isoA');
    const B = await mk('isoB');
    try {
      const r = await A.core.callCapability('tool.write', { path: 'a.txt', content: 'x' });
      assertEquals(r.ok, true, `A 的写入应成功，实际 ${r.code}`);
      assertEquals(fs.existsSync(join(A.ws, 'a.txt')), true,
        'A 的写入必须落在 A 的目录 —— 修前（R0-143）这里为空，文件跑去了 B');
      assertEquals(fs.existsSync(join(B.ws, 'a.txt')), false,
        'A 的写入**不得**出现在 B 的目录 —— 这是 R0-143 的核心症状');
      console.log('       [实测] A 写 A、B 不脏（正常装配路径完全隔离）');
    } finally {
      fs.rmSync(A.d, { recursive: true, force: true });
      fs.rmSync(B.d, { recursive: true, force: true });
    }
  });

  runner.test('R0-144 未 init 就调 handle 必须给具名失败，不得抛裸 TypeError', async () => {
    // 这条是本轮修 R0-76 全量失败时顺带查出的。它原本被记成"测试缺桩"，但桩一补就露出真问题：
    // `handle()` 直接用 `this._sessionQueue.run(...)`，而 `_sessionQueue` 在 `init()` 里才创建。
    // 任何未 init 的调用方（嵌入宿主 / init 抛错被上层吞掉 / 只测单条路径的用例）
    // 拿到的是 `TypeError: Cannot read properties of undefined (reading 'run')` ——
    // 错误指向内部字段名，调用方无从判断"是我装错了还是内核坏了"。
    const H = (await imp('plugins/haotian-lite.js')).default;
    const saved = { q: H._sessionQueue, core: H.core };
    try {
      H._sessionQueue = undefined;
      H.core = { emitFast() {}, emit() {}, log() {} };
      let threw = null;
      try { await H.handle({ message: 'hi', sessionId: 's1' }); } catch (e) { threw = e; }
      assert(threw, '未 init 时必须抛错，不得静默返回');
      assertEquals(threw.code, 'plugin_not_initialised',
        `必须带具名 code（修前是裸 TypeError），实际 ${threw.code}：${threw.message}`);
      assert(/init/i.test(threw.message), `错误信息必须指出"要先 init"，实际：${threw.message}`);
      assert(!/reading 'run'/.test(threw.message), '不得让内部字段名泄漏成对外错误');
      console.log('       [实测] 未 init → plugin_not_initialised（不再抛裸 TypeError）');
    } finally { H._sessionQueue = saved.q; H.core = saved.core; }
  });

  runner.test('R0-143/d 结构判据：所有插件 import 都必须带实例标识（不得留裸 import）', () => {
    const src = readFileSync(join(ROOT, 'src/core/plugin-manager.js'), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    // 找出所有 `import(pathToFileURL(...))` 的调用，逐个看有没有拼上实例标识
    const calls = [...code.matchAll(/await import\(([^)]*(?:\)[^)]*)*?)\);/g)].map((m) => m[1]);
    // 下限从 5 改成 4：v0.9.33 的 E1 把 `plugin.reload` 与 watch 两处内联重载**合并**成
    // 一处 `_reloadPlugin`，导入点因此从 5 处降到 4 处。这个数字的意义只是"没有因为
    // 匹配不到而假绿"，真正的判据是下面那句"**每一处**都必须带 _instanceTag"。
    // v0.10.1：下限 4 → 3。`_importPluginModule` 把 eager 与 lazy 两处导入口收成一个，
    // 导入点因此少了一个。这个数字的意义只是"没有因为匹配不到而假绿"，
    // 真正的判据是下面那句"**每一处**都必须带 _instanceTag"。
    assert(calls.length >= 3, `应至少有 3 处插件 import（实测 ${calls.length} 处）`);
    const bare = calls.filter((c) => !/_instanceTag/.test(c));
    assertEquals(bare.length, 0,
      `这些 import 没有带实例标识，会让两个 Core 共享同一个插件实例：\n  ${bare.join('\n  ')}`);
    console.log(`       [实测] ${calls.length} 处插件 import 全部带实例标识`);
  });
}
