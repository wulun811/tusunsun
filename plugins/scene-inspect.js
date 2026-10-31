// E3（v0.9.33）：场景声明 **对照** 真实装配的诊断。以插件形式提供，**不进核心**。
//
// 为什么不是改 `scene-controller.show()`：
//   · `src/core/` 有硬行数预算（2145/2150，单模块 scene-controller 175/175 已满），
//     而这块诊断要 80+ 行；
//   · 更重要的是**它不该是核心语义**：核心负责"按声明装配"，而"声明与实况是否一致"
//     是一个可以失败的观测问题，观测代码不该和内核对预算、也不该在内核里长。
//   计划书 Track E 的写法就是"小而值的接缝，不建平台"——这正是接缝。
//
// 修的是什么（送审报告 §6"方法论盲区"里的第三种形态：错误信息与实际状态不符）：
//   `scene-controller.show()` 只遍历 `scene.plugins`。而多数场景把插件写在 `eager` 里
//   （`scenePluginLists` 的注释早有记录：coding 场景 eager 38、plugins 空）。
//   于是 `show('coding')` 返回**空列表** —— 看起来像"这个场景没有插件"，实际装了 38 个。
//   这正是 R0-111/W1 修过的同一个形状的复发："只看 plugins"被当成了"看全部"。
//
// 本插件不改装配行为，只回答"声明了什么、真的装了什么、差在哪"。
import { existsSync } from 'node:fs';

/** 场景声明里本内核**真的读**的键。表外的键 = 写了但零读者。 */
const READ_KEYS = new Set([
  'name', 'description', 'version', 'eager', 'plugins', 'lazy', 'optional',
  'include', 'defaultConfig', 'features', 'agent', 'model', 'roles', 'prompts', '_file',
]);

class SceneInspect {
  name = 'scene-inspect';
  version = '0.1.0';
  provides = [{ name: 'scene.inspect', type: 'capability', removable: true }];
  requires = {};
  // 只读观测：不写盘、不起进程。
  permissions = ['fs.read'];

  async init(core) {
    this.core = core;
    this._capHandle = core.registerCapability('scene.inspect', {
      description: 'Report what a scene DECLARES versus what is ACTUALLY assembled '
        + '(declared/eager/lazy/pending/loaded/missing/unavailable/unapplied_key).',
      owner: 'scene-inspect',
      handler: async (args) => this.inspect(args?.scene, args?.opts),
    });
    core.registerService('scene-inspect', this);
  }

  async stop() {
    // 凭据是 init 里那一笔登记交回的句柄（ID-05）：stop() 跑在装配上下文之外，
    // 拿名字去撤销不再是授权形式 —— 名字可列举，等于没有口令。
    try { if (this._capHandle) this.core?.releaseRegistration?.(this._capHandle); } catch { /* 尽力而为 */ }
    this._capHandle = null;
  }

  /**
   * @param {string} name 场景名
   * @returns {Promise<object>} 诊断结果（永不抛：失败也是 `{ok:false,code}`）
   */
  async inspect(name, opts = {}) {
    const core = this.core;
    if (!name) return { ok: false, code: 'missing_scene_name', error: 'scene is required' };
    // SceneController 在 CLI 启动路径里是**临时对象**（`new SceneController(core, pm)` 用完即弃），
    // 既没注册成服务也没挂到数据面。所以这里拿不到就自己建一个：`findScene` 是**只读解析**
    //（读 scenes/*.json5 + 展开 include），不碰装配状态，重建一次与启动时读到的是同一份声明。
    // 这也不是绕过判据 —— 装配实况全部从 `core.plugins` / `core.listCapabilities()` 读，
    // 那才是"真的装了什么"的唯一来源。
    let sc = core.getService?.('scene-controller') || core.getData?.('_sceneController');
    if (!sc || typeof sc.findScene !== 'function') {
      const { SceneController } = await import('../src/core/scene-controller.js');
      sc = new SceneController(core, null);
    }
    const scene = await sc.findScene(name);
    if (!scene) return { ok: false, code: 'scene_not_found', error: `Scene "${name}" not found` };

    const { scenePluginLists } = await import('../src/bootstrap/cli.js');
    const { eager, lazy } = scenePluginLists(scene);
    const eagerSet = new Set(eager);
    const declared = new Set([...eager, ...lazy]);

    // PluginManager 本身既不是服务也没挂数据面 —— 但它**已经把懒加载索引发布到数据面**了
    // （`setData('_lazyIndex', () => this._pending)`，那是给准入闸门用的公开口径）。
    // 用它，而不是去猜 PM 的实例位置：能拿到 `_pending` 就足以判 `pending` 状态，
    // 拿不到就退化为"按磁盘文件判断"，两种情形都如实标注，不假装知道。
    const lazyIndexFn = core.getData?.('_lazyIndex');
    let pendingMap = null;
    try { pendingMap = typeof lazyIndexFn === 'function' ? lazyIndexFn() : null; } catch { pendingMap = null; }
    const pending = new Set(pendingMap?.keys?.() ?? []);
    const pluginsDir = core.pluginsDir || null;

    const plugins = [];
    for (const n of declared) {
      const live = core.plugins.get(n);
      const inPending = pending.has(n);
      const hasFile = pluginsDir ? this._fileExists(pluginsDir, n) : false;
      let status;
      if (live) {
        status = ['unavailable', 'error', 'faulted'].includes(live.state) ? 'unavailable' : 'loaded';
      } else if (inPending) status = 'pending';
      else status = hasFile ? 'not_loaded' : 'missing';
      plugins.push({
        name: n, requested: true,
        declared_in: eagerSet.has(n) ? 'eager' : 'lazy',
        status, loaded: !!live, state: live?.state ?? null,
        in_pending: inPending, has_source_file: hasFile,
      });
    }

    // 声明里没有、但**实际装着**的：不列出来会让"声明"与"实况"看起来一致，而实际多了东西。
    const extra = [...core.plugins.keys()].filter((n) => !declared.has(n));
    // 声明里有、磁盘上没有 —— 最该被看见的一种，单独再摘一遍便于 CI 判读。
    const missing = plugins.filter((p) => p.status === 'missing').map((p) => p.name);
    // 声明里出现但内核零读者的键。判据口径：**白名单外 = 可疑**，不做语义猜测。
    //
    // 这一项在 v0.9.33 **真的抓到了东西**，抓到的是随包场景里的三个键：
    //   · `schema`       —— 描述性元数据块（capabilities/useCases/template），零读者。
    //   · `fallback`     —— 形如 `{ session: 'agent' }`"降级为无记忆模式"。零读者：
    //                       没有任何代码在 session 缺失时改装配。写成 JSON 让人以为降级已配好。
    //   · `sceneContext` —— 形如 `{ disableTools: ['bash','write'], allowedTools: [...] }`。
    //                       **最危险的一个**：看起来像权限限制，实际零读者 ——
    //                       真正生效的是 Cell 能力门与 tool-guard，不是这个键。
    // 三者已从随包场景删除（见各场景注释）。保留这条判据是为了**下次**：
    // 任何人新写一个零读者键，`npm run scene:inspect` 会立刻报出来。
    const unapplied = Object.keys(scene).filter((k) => !READ_KEYS.has(k));

    // 模型可见工具 vs 实际能力：两者不自洽是一条真实的裂缝（工具挂在 legacy 直连路径上）。
    const registry = core.getService?.('tool-registry');
    const tools = typeof registry?.listTools === 'function' ? registry.listTools() : [];
    const capIds = new Set((core.listCapabilities?.() ?? []).map((c) => c.id));
    const toolsWithoutCapability = tools
      .filter((t) => typeof t.name === 'string' && t.name.startsWith('tool-'))
      .map((t) => ({ tool: t.name, cap: `tool.${t.name.slice('tool-'.length)}` }))
      .filter((x) => !capIds.has(x.cap));

    // 全局一致性：任何不一致都要能被机器判读，而不是靠人肉读一大段 JSON。
    const problems = [];
    if (missing.length) problems.push({ code: 'declared_but_missing', detail: missing });
    if (unapplied.length) problems.push({ code: 'unapplied_keys', detail: unapplied });
    if (toolsWithoutCapability.length) problems.push({ code: 'tool_without_capability', detail: toolsWithoutCapability });
    const badState = plugins.filter((p) => p.status === 'unavailable').map((p) => p.name);
    if (badState.length) problems.push({ code: 'unavailable_plugins', detail: badState });

    return {
      ok: true,
      scene: name,
      scene_file: scene._file || null,
      consistent: problems.length === 0,
      problems,
      plugins,
      extra_loaded: extra,
      unapplied_keys: unapplied,
      tools: {
        count: tools.length,
        visible: !opts?.verbose ? tools.map((t) => t.name) : tools,
        without_capability: toolsWithoutCapability,
      },
      capabilities: { count: capIds.size, ids: [...capIds].sort() },
    };
  }

  /** 文件存在性：支持 `tool-x.js` / `x.js` 两种命名（内建工具在 plugins/tools/ 下）。 */
  _fileExists(dir, name) {
    for (const f of [`${name}.js`, `${name}.mjs`]) {
      if (existsSync(`${dir}/${f}`)) return true;
    }
    for (const f of [`${name}.js`, `${name}.mjs`]) {
      if (existsSync(`${dir}/tools/${f}`)) return true;
    }
    return false;
  }

}

export default new SceneInspect();
