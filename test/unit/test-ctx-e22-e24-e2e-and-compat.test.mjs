// CTX-E22 / CTX-E24（PR-5/PR-6）：端到端双 Cell 与旧场景兼容。
//
// E22 跑的是**两个真进程 + 真 haotian-lite + 真 ToolExecutor + 模拟模型端点**：
// 它不验证"配置写对了"，而验证"两个 Cell 的模型输入互不相同、失败不变绿、进程与端口全部回收"。
// 这部分与 `examples/cells/dual-cell.mjs --cognition` 是同一件事的两个入口：
// 示例给人看，本用例给门禁跑。
//
// E24 验证**旧场景不回归**：gateway / coding / chat 三条老场景不因为新增认知插件而改变行为。
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { TestRunner, assert, assertEquals } from '../harness.mjs';


const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(join(ROOT, rel));

export async function setup(runner) {
  runner.test('CTX-E22 双 Cell 端到端（真进程）：输入隔离、失败不绿、结果独立验收、全部回收', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ctx-e22-'));
    try {
      // 直接复用示例的 --cognition 模式：它就是"两个真进程 + 不同 profile"的最小完整形态。
      const r = spawnSync(process.execPath, [join(ROOT, 'examples', 'cells', 'dual-cell.mjs'), '--cognition'], {
        cwd: ROOT, encoding: 'utf8', timeout: 180000,
        env: { ...process.env, TUSUNSUN_STATE_DIR: '', TUSUNSUN_PORT: '', TUSUNSUN_API_KEY: '' },
      });
      const out = `${r.stdout || ''}${r.stderr || ''}`;
      assertEquals(r.status, 0, `--cognition 应以 0 退出，实际 ${r.status}\n${out.slice(-2500)}`);
      // 四条必须能在输出里查到的硬事实
      assert(/提示词被模型收到 \d+ 次/.test(out), '应报告模型实际收到提示词的次数');
      assert(/有界地图按 Cell 区分/.test(out), '应报告两张地图按 Cell 区分');
      assert(/主动拉到经验详情/.test(out), 'A 应在执行期间主动拉到经验详情');
      assert(/B（provider=none）的输入里没有任何经验块/.test(out), 'B 不应收到任何经验块');
      assert(/进程与端口全部回收/.test(out), '必须回收全部进程与端口');
      console.log('       [实测] 两个真进程：提示词/地图按 Cell 区分、A 主动取经验、B 无经验、全部回收');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('CTX-E22b 双 Cell 失败反例：B 失败不得让整体变绿（认知配置不得掩盖失败）', async () => {
    const r = spawnSync(process.execPath, [join(ROOT, 'examples', 'cells', 'dual-cell.mjs'), '--fail-b', '--cognition'], {
      cwd: ROOT, encoding: 'utf8', timeout: 180000,
      env: { ...process.env, TUSUNSUN_STATE_DIR: '', TUSUNSUN_PORT: '', TUSUNSUN_API_KEY: '' },
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    assertEquals(r.status, 0, `反例模式应以 0 退出（它自己判断"如预期失败"），实际 ${r.status}\n${out.slice(-2000)}`);
    assert(/如预期失败/.test(out), '必须明确报告"如预期失败"，而不是静默通过');
    assert(/B 执行 failed/.test(out), 'B 的失败必须被如实报出');
    console.log('       [实测] --fail-b --cognition：B failed 被如实报出，整体不绿');
  });

  runner.test('CTX-E24 旧场景兼容：gateway/coding/chat 的装配清单不因认知插件而改变', async () => {
    const { loadJson5 } = await imp('src/core/json5-loader.js');
    const { scenePluginLists } = await imp('src/bootstrap/cli.js');
    const COGNITIVE = ['cell-context', 'context-port', 'experience-port', 'compaction', 'context-budget'];
    for (const name of ['gateway', 'coding', 'chat', 'gateway-lite', 'base-system', 'iot']) {
      const file = join(ROOT, 'scenes', `${name}.json5`);
      assert(existsSync(file), `${name}.json5 应存在`);
      const scene = loadJson5(readFileSync(file, 'utf8'));
      const { eager, lazy } = scenePluginLists(scene);
      const all = [...eager, ...lazy];
      for (const c of COGNITIVE) {
        assert(!all.includes(c), `${name} 不得装配认知插件 ${c}（认知配置属于有身份的主体，普通对话不该多装永不生效的服务）`);
      }
    }
    // cell 场景必须显式装配它们
    const cellScene = loadJson5(readFileSync(join(ROOT, 'scenes', 'cell.json5'), 'utf8'));
    const cp = scenePluginLists(cellScene);
    for (const c of ['cell-context', 'context-port', 'experience-port', 'compaction']) {
      assert(cp.eager.includes(c), `cell 场景应在 eager 里包含 ${c}`);
    }
    console.log('       [实测] 6 条旧场景零认知插件；cell 场景显式装配 4 个');
  });

  runner.test('CTX-E24b 零新增强制外部依赖：认知插件只用 Node 内置模块', async () => {
    const { readFileSync: rf } = await import('node:fs');
    const files = [
      'plugins/_lib/cell/context-contract.js', 'plugins/cell-context.js', 'plugins/context-port.js',
      'plugins/experience-port.js', 'plugins/compaction.js', 'plugins/_lib/context-budget.js',
      'plugins/_lib/context/providers/local-manifest.js',
    ];
    const builtinOnly = /^(node:|\.{1,2}\/)/;
    for (const f of files) {
      const src = rf(join(ROOT, f), 'utf8');
      const imports = [...src.matchAll(/^\s*import\s[^\n]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
      const external = imports.filter((s) => !builtinOnly.test(s));
      assertEquals(external.length, 0, `${f} 引入了外部依赖：${external.join(', ')}`);
    }
    // package.json 的 dependencies 必须仍然不存在（零强制外部依赖）
    const pkg = JSON.parse(rf(join(ROOT, 'package.json'), 'utf8'));
    const deps = Object.keys(pkg.dependencies || {});
    assertEquals(deps.length, 0, `package.json 不应有 dependencies，实际：${deps.join(', ')}`);
    console.log('       [实测] 7 个新文件全部只用 node:/相对导入；dependencies 为空');
  });

  runner.test('CTX-E24c 场景可启动：cell 场景在缺 profile 配置时仍能起来（不因新插件启动失败）', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ctx-e24c-'));
    try {
      const ws = join(d, 'ws');
      mkdirSync(ws, { recursive: true });
      const stateDir = join(d, 'state');
      mkdirSync(stateDir, { recursive: true });
      // 故意**不**配 cells.context：新插件必须以"未启用"的形态存在，而不是启动失败。
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
        activeScene: 'cell',
        gateway: { host: '127.0.0.1', port: 0 },
        model: { provider: 'openai', model: 'mock', baseUrl: 'http://127.0.0.1:1/v1', apiKey: null },
        agent: { workDir: ws, maxTurns: 2 },
      }, null, 2));

      const { Core } = await imp('src/core/core.js');
      const core = new Core({ stateDir, configPath: join(stateDir, 'config.json') });
      const logs = [];
      core.log = (lvl, msg) => logs.push(`${lvl}:${msg}`);
      core.setData('agent.workDir', ws);
      const { PluginManager } = await imp('src/core/plugin-manager.js');
      const pm = new PluginManager(core);
      // v0.9.25：装配点只有一个。这里此前还有一行 `pm.addDirectory(join(ROOT,'src/builtin'))`，
      // 它复刻的是 cli.js 的**第二处** addDirectory —— 那处已随目录合并删除，
      // 测试若保留就会测一个启动路径上不存在的行为。
      pm.addDirectory(join(ROOT, 'plugins'));
      core.pluginsDir = join(ROOT, 'plugins');
      const { SceneController } = await imp('src/core/scene-controller.js');
      const sc = new SceneController(core, pm);
      const scene = await sc.findScene('cell');
      const { scenePluginLists } = await imp('src/bootstrap/cli.js');
      const { eager, lazy } = scenePluginLists(scene);
      // 用不到总线上：这里只验证装载与 init 不抛
      await pm.loadAll(eager, [
        ...lazy.slice(0, 3),
      ]);
      for (const [name, plugin] of core.plugins) {
        if (plugin.state !== 'registered') continue;
        core._initOwner = name;
        await plugin.init(core);
        plugin.state = 'started';
        if (plugin.start) await plugin.start();
        plugin.state = 'running';
        core._initOwner = null;
      }
      // 五个认知服务都应在位（即使没有配置）
      for (const s of ['cell-runtime', 'cell-context', 'context-port', 'experience-port', 'compaction']) {
        assert(core.getService(s), `服务 ${s} 应已注册（即使未配置）`);
      }
      // 未配置时必须能具名拒绝，而不是抛一堆无头错误
      const cc = core.getService('cell-context');
      const err = await cc.bind('nope', { profileId: 'x' }).then(() => null, (e) => e);
      assert(err, '未配置时应拒绝绑定');
      assertEquals(err.code, 'context_disabled', `应为 context_disabled，实际 ${err.code}`);
      // v0.15.2：这里原本是 `await core.stop().catch(() => {})` —— 一个**空转**的清理。
      // `Core.stop()` 第一行是 `if (!this.running) return`，而本用例从未 `core.start()`
      // （它手工逐个 init/start 插件来模拟 CLI 的装配）⇒ stop 立即返回，gateway 的
      // HTTP server 一直 listen 着，单测结束后事件循环排不空。
      // 定位方式：包 `net.Server.prototype.listen` 记创建栈，退出时仍 listening=1，
      // 栈顶就是本文件第 140 行。产品侧行为是对的（跑着的网关就该钉住进程），
      // 错的是清理：停的是**插件**，不是“一个从未 start 过的 Core”。
      for (const [, plugin] of core.plugins) {
        if (!plugin?.stop) continue;
        try { await plugin.stop(); } catch { /* 清理尽力而为，不影响本用例判据 */ }
      }
      console.log('       [实测] 无 cells.context 配置时 5 个服务全在；bind 报 context_disabled；启动无失败');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
}
