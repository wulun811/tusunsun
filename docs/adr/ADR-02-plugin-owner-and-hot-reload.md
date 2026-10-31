# ADR-02：插件实例归属与热替换边界

- 状态：**已采纳**（v0.9.33）
- 影响面：`src/core/plugin-manager.js`、`src/core/core.js`、`plugins/tool-loader.js`
- 关联：R0-143（跨 Core 单例）、EV-01/02/03（生命周期）、E1/E2

## 1. 要决定的问题

三件事纠缠在一起：

1. **一个插件实例能不能被两个 Core 用？**（R0-143：实测能，且跨 Core 串写并返回成功）
2. **重载的语义是什么？**（EV-01：三个入口三套行为，其中两套是错的）
3. **卸载之后还能不能再起来？**（EV-03：实测不能，且两套状态互相矛盾）

## 2. 决定

### 2.1 一个可变插件实例**只能属于一个 Core**

Node 的 `import(path)` 走 ESM 缓存，**同一路径恒返回同一实例**。而插件普遍写
`init(core) { this.core = core }`。于是两个 Core 装同一插件时，后者覆写前者。

**决定**：插件 import 一律带实例标识（`?pm<N>&v=M`），且**手工复用同一实例不受支持**。

- 已实现：`plugin-manager` 的 `_instanceTag` 打在全部 import 点；
- 事实依据：实测 A、B 两个 Core 各装 `tool-write`，用 **A** 调用，文件落进了 **B** 的工作区
  并返回 `succeeded`（跨 Core 串写且报成功）；
- 判据：`test/unit/test-r0-143-cross-core-singleton.test.mjs` 6 条，含
  `R0-143/e` 行为隔离（A 写 A、B 保持干净）；
- 变异：移除 `_instanceTag` ⇒ 4 条变红。

**没有做的**：在 `core.register()` 里检测"这个实例已被别的 Core 绑定过"并拒绝。
我试了三处挂载点，都不成立（`register` 不是绑定发生的地方；`plugin.init` 是薄包装且
每次装载重建；在 init 之后检查已经太晚 —— 服务已注册）。**最后故意放弃**，理由是：

> 把不确定的守卫加进内核，比不修更危险。它会给出"已保护"的错觉，而实际拦不住
> `.bind()` 这类绕过。文档警告 + 判据测试是这一版能诚实交付的形态。

### 2.2 重载只有一条实现，次序是判据不是风格

**修前**：`plugin.reload` 与文件 watcher 各写一份，**都错**：

- `plugin.reload`：`existing.stop()` 之后 `lc.unload()` —— 停了两次；
- watcher 分支：**完全不 `init`**。实测改文件后 `callCapability('hot.work')` 仍返回旧值 V1，
  而插件 `state=running`、`plugin.core` 为 `undefined`。

第二类是最坏的失败模式：**重载之后仍在服务旧实现，且状态显示一切正常**。

**决定**：合成 `_reloadPlugin(name, filePath, via)` 唯一实现，次序固定为：

```
① import 新模块        ← 失败则直接返回，旧插件毫发无损
② lc.unload            ← 完整 stop / 监听器 / 服务与能力清理
③ core.register        ← 重发 manifest 与 provides
④ init → start         ← 与首次装载同一条链
```

**为什么 ① 必须在 ② 之前**：这是"重载失败优先保留旧版本"的唯一实现方式。
先卸载再导入，一旦导入失败就两头空。变异 `MUT-ORDER`（把卸载提到导入之前）
精确打红 `E1/d`，证明这个次序真的在守东西 —— 不是我事后编的理由。

**④ 之后失败**：旧版本已经回不来了（已 unload）。此时标 `state: 'unavailable'` +
具名 `reload_failed_unavailable`，**不静默回落**到未知实现。

**为什么 `plugin.reload` 对 eager 插件此前恒失败**（EV-02）：`_pluginFilePaths` 只在
`_indexLazyPlugin` 里写 —— 只有懒加载池记得来源路径。eager 插件（场景里的常态）
一律返回 `No file path for: <name>`。补一行登记解决。

### 2.3 卸载 = 回到"可被懒加载"的初始态

**修前**：`unload` 只转调 `lc.unload`，不改本管理器的 `_lazyLoaded` / `_pending`。实测：

```
hasCapability('lazy1.work') → true      （装上了，_lazyLoaded 含 lazy1）
await pm.unload('lazy1')
_lazyLoaded.has('lazy1')    → true      ← 说"装着"
_pending.has('lazy1')       → false     ← 说"没有来源"
再调 hasCapability          → false     （永久不可再激活）
```

两套状态互相矛盾，且**不可恢复**（懒加载只从 `_pending` 取来源路径）。

**决定**：卸载时两套状态一起归位。声明不是 eager 且不再装着 ⇒ 清 `_lazyLoaded`、
保留/重建 `_pending` 条目 ⇒ 可被再次解析。判据 `E1/f` 走完整链路（卸载 → 再激活 → 调通）。

## 3. 工具注册的公开门面（E2 的配套裁决）

**修前**：`context-port.js`、`experience-port.js`、`plugin-context.js`、`haotian-lite.js`
四处直接读写 `tool-registry` 的私有 `_tools` Map。

**决定**：`registerTool` / `unregisterTool` / `listTools` 成为唯一入口，`_tools` 只由
`tool-loader.js` 写。合同：

| 规则 | 理由 |
|---|---|
| `owner` 必填 | 无主插入无法归属、也无法注销 |
| 同名冲突**拒绝**不夺权 | 覆盖会让"谁发布了这个工具"变成不可回答 |
| 注销只删自己 owner 的 | 否则会动到别人的授权面 |
| 注销必须同时放掉自己建的能力 | 否则留下 handler 指向已删工具的幽灵能力 |
| **目录 ≠ 授权** | 模型看得见不等于执行器会放行；执行仍走能力解析/资格/捆仙索/入参校验 |

放能力用 `core.releaseCapability(id, owner)`（会校验 owner）而不是直接删私有 Map ——
于是"宿主接管过的同名能力"不会被误摘（`E2/f` 专测这一条）。

**迁移时发现的额外缺陷**：`experience-port` 的能力 handler 是
`(args) => registry._tools.get(...).execute(args)` —— **调用时**才去私有 Map 查一次。
于是工具注销后能力还活着，一调就是 `Cannot read properties of undefined`。
现在 handler 闭包住 `execute`，能力与工具同生共死。

## 4. 后果

**变好的**：

- 三条已复现的生命周期失败路径关闭；
- 重载失败不再破坏正在服务的插件；
- 插件能不能重载不再取决于它是 eager 还是 lazy。

**变差的**：

- 核心行数 2112 → 2157（增量全部是这三条修复，归因在 `scripts/core-limits.mjs`）；
- `unload` 现在会重建 `_pending` 条目，语义比"只是调 lc.unload"重一些 ——
  但这是让"卸载"真的等于"可再起来"的必要代价。

**仍然没做的（明确不支持的部分）**：

- **任意插件热迁移**：`_reloadPlugin` 重跑 init/start，但**不迁移在途状态**。
  有在途调用时不拒绝替换、也不等排空 —— 这是本轮**没有**实现的语义，不要假设有。
  文档里应标"在线热重载：实验性"。
- **第三方手工复用同一实例跨 Core**：不支持，只在文档警告，不做运行时拦截（见 2.1）。

## 5. 如何验证

```bash
node test/run-one.mjs test/unit/test-e1-plugin-lifecycle.test.mjs     # 9 条
node test/run-one.mjs test/unit/test-e2-tool-registry-facade.test.mjs # 12 条
node test/run-one.mjs test/unit/test-r0-143-cross-core-singleton.test.mjs # 6 条
```

变异：

| 变异 | 打红 |
|---|---|
| eager 不登记来源路径 | E1/a |
| 重载不跑 init | E1/b、E1/c、E1/e |
| 卸载不清 `_lazyLoaded` | E1/f |
| **把卸载提到导入之前** | **E1/d** |
| 允许无主注册 | E2/a |
| 允许同名夺权 | E2/b |
| 允许注销别人的工具 | E2/e |
| 注销不释放能力 | E2/g |
