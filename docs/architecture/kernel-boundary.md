# 内核边界：谁是机制，谁是策略，哪些东西不能搬

> 一页回答三个问题：**`src/core/` 里每个文件现在负责什么**、**每个职责的权威写入点在哪**、
> **哪些代码发布前不许搬走（以及凭什么）**。
>
> 配套：`core-invariants.md`（要背的规则）、`decisions/core-evolution-history.md`（为什么长这样）、
> `function-ownership.md`（事实 #1～#4 的详细判据）。

---

## 1. 依赖方向（一页图）

```
                    tusunsun.mjs / src/bootstrap/cli.js
                                  │  只做装配与转发，不持有内核状态
                                  ▼
   ┌───────────────────────── src/core/ ─────────────────────────┐
   │                                                             │
   │  core.js  ──能力/服务权属、派发与结算、事实与订阅、确认、管道 │
   │    │  ├── lifecycle-manager.js  插件实例状态与独占区          │
   │    │  ├── plugin-manager.js     发现、装载、懒加载、重载、回收 │
   │    │  │     └── dependency-resolver.js   顺序与环              │
   │    │  ├── scene-controller.js   场景五段式（Plan…Commit）      │
   │    │  │     └── json5-loader.js           配方解析            │
   │    │  ├── plugin-meta.js        文件头元数据（不 import 模块） │
   │    │  └── env.js                环境前缀与日志分流             │
   │    └──────────────────────────────────────────────────────┘  │
   └─────────────────────────────────────────────────────────────┘
                                  ▲
                                  │  只能经由公开入口
        plugins/（器官：tool-executor、gateway、txn、cell-runtime…）
```

三条硬方向（违反就是架构回归）：

1. **`src/core/` 不 import `plugins/`**（K-14）。诊断文本、厂商适配、格式化都在外围。
2. **`plugins/` 只经 Core 的公开方法与事件**，不写 Core 的内部 Map（K4 的教训）。
3. **`src/bootstrap/` 不持有内核状态**：它选择场景、拉起 PluginManager，然后退出内核对它的依赖。

---

## 2. 文件级：职责与权威写入点

| 文件 | 现在负责 | **权威写入点**（唯一允许改这些状态的地方） | 行数 |
|---|---|---|---:|
| `core.js` | 能力与服务权属、调用结算、事实通知与订阅账、确认、管道、装配世代 | `_capabilities` / `_services` / `_serviceOwners` / `_subs` / `_pipelines` 只由本文件的方法改 | 1681 |
| `lifecycle-manager.js` | 插件实例状态、per-owner 独占区、卸载七步（带依赖闸门）、装配上下文 | `plugin.state` 只由 `advance()` 改；`_queues`、`_transitions` 只由本文件改 | 418 |
| `plugin-manager.js` | 目录发现、eager 装载、懒加载 Attempt/Waiter、重载、空闲回收 | `_pending` / `_lazyLoaded` / `_loaded` / `_pluginFilePaths` 只由本文件改 | 861 |
| `scene-controller.js` | 场景五段式、lazy 登记对账、持久场景事实 | `_persistedScene` 只由落盘成功的路径改；`currentScene` 只由 `switchTo` 提交 | 453 |
| `dependency-resolver.js` | 依赖边的**唯一**解释、启动拓扑序、停机逆序、卸载闸门查询、懒加载闭包、环诊断 | 纯函数 + 局部图，不持有全局状态 | 384 |
| `plugin-meta.js` | 从文件头读 `provides` / `requires` / `lazy` 等声明 | 只读文件，不 import 模块，不写任何全局 | 118 |
| `json5-loader.js` | 场景配方的 JSON5 子集规范化 | 纯函数 | 83 |
| `env.js` | 环境变量前缀（规范名优先、旧前缀只读）、日志分流 | `process.env` 的写入只经 `writeEnv` | 35 |

**两条“只有一份”**：

- **独占区**：生命周期队列就是 `core.lifecycle`（装配、懒加载、重载、卸载、场景切换共用）。
  `PluginManager` 不再自建实例 —— 再 `new` 一个不是“多一把锁”，而是“同一 key 两把锁”。
- **依赖边**：`dependency-resolver.js` 的 `resolveDependencyTarget()` 是唯一解释位置。
  **四个消费者全部从这里取**：`buildDAG()`（启动）、`computeStopOrder()`（停机）、
  `dependentsOf()`（卸载闸门）、`resolveLazyChain()` / `resolvePendingDependency()`（懒加载闭包）。
  解析顺序：插件名 → 运行时服务归属（`_serviceOwners`，优先于声明）→ `provides` 声明。

---

## 3. 函数级清单（公开入口 → 职责）

### 3.1 `core.js`

| 入口 | 职责 | 备注 |
|---|---|---|
| `start()` / `stop()` | 装配与关停；`stop` 递增世代、有界收尾、逆拓扑停插件 | 不可用于"重启"，重启 = 新建 Core |
| `register(plugin)` | 登记插件对象；同名不同实例返回 `false` | `false` 必须被调用方当成中止信号 |
| `registerCapability()` / `releaseCapability()` | 能力登记/让渡；注册即查 schema 支持面与装配世代 | 唯一允许改 `_capabilities` 的地方 |
| `registerService()` / `getService()` / `releaseServicesByOwner()` | 服务登记与按 owner 释放 | 对象与归属同一次同步提交 |
| `getServiceOwnership()` | "对象与归属能不能对上"的可核对面 | 供只读视图，不暴露内部 Map |
| `callCapability()` / `command()` | 两条调用入口，共用 `_dispatchCapability` 结算 | 超时只结束等候，不改在途事实 |
| `beginAssembly()` / `endAssembly()` / `isAssemblyCurrent()` / `discardAssemblyArtifacts()` | 装配世代与迟到撤销 | 装配入口只报到，判据收在 Core |
| `on/once/off/removeListener/removeAllListeners/offByOwner` | 订阅账（按 entry） | `emit` 保持 fail-loud |
| `emitFact()` / `getObserverErrors()` / `getFactDegraded()` | 已提交事实的隔离通知面 | 只有登记在案的事实走这条路 |
| `use()` / `unuse()` / `offPipelineByOwner()` | 中间件账（按 entry，返回 disposer） | 管道不是状态守卫 |
| `confirm()` | 授权结论（三分支） | 终端交互属宿主适配，结论属 Core |
| `assertIdentity()` / `listCapabilities()` / `hasCapability()` | 身份与枚举面 | 枚举接口的存在是为了不让人读私有 Map |

### 3.2 `lifecycle-manager.js`

| 入口 | 职责 |
|---|---|
| `load(plugin, core, opts)` | 装配的唯一入口（Core.start / pm.loadOne / pm._reloadPlugin 都走它） |
| `unload(pluginName)` | 七步卸载；排空超时时如实回报 `forced_partial` |
| `runExclusive(pluginName, fn)` | per-owner 独占区（可重入租约） |
| `advance(plugin, to, opts)` | **状态唯一跃迁写入者**（合法边见 `LEGAL_EDGES`） |
| `getTransitions()` / `getIllegalTransitionCount()` | 状态合法性可观测 |

### 3.3 `plugin-manager.js`

| 入口 | 职责 |
|---|---|
| `loadAll()` / `loadFromDir()` / `addDirectory()` | 目录发现与 eager 装载 |
| `loadOne(name)` | 按名字装载单个插件的唯一公开入口（名字必须三处对得上） |
| `reload(name)` | 唯一重载实现（先 import，成功再 unload） |
| `unload(name)` | 卸载并归位本管理器的两套状态 |
| `_lazyLoadOne` / `_startLazyLoad` / `_awaitLazyLoad` / `describeLazyLoad` | 懒加载：真实 Attempt 与等候方分开记账 |
| `indexLazy()` / `dropLazy()` / `reconcileLazy()` | 懒索引登记、撤销、按目标场景全集对账 |
| `isResolvable()` / `watchForChanges()` / `_startIdleTimer()` | 文件监视与空闲回收；策略可停，不持有装载事实 |

### 3.4 `scene-controller.js`

| 入口 | 职责 |
|---|---|
| `switchTo(name, opts)` | 五段式切换（Plan → Preflight → Apply → Verify → Commit），整段在 `__scene__` 独占区 |
| `show(name)` / `listScenes()` | 只读视图（诊断插件缺席时退回旧口径并**标注**） |
| `findScene()` / `_expandIncludes()` | 配方发现与 include 展开（配置加载策略，不写 Core 状态） |

### 3.5 其余

`dependency-resolver.js`：`buildDAG` / `topologicalSort` / `resolveWithFallback` / `resolveLazyChain` / `_findCycle`。
`plugin-meta.js`：文件头元数据提取（只读）。`json5-loader.js`：`loadJson5`。`env.js`：`readEnv` / `writeEnv` / `jsonLogEnabled`。

---

## 4. 不可外移清单（搬走就等于拆掉安全保障）

1. **派发前授权与守卫**（`assertIdentity` / `_invocationContext` / `_denyCapability`）——它必须是不可选的路径，不是 Hook。
2. **真实 Attempt 与 Waiter 的分离**（`_dispatchCapability` 的 in-flight + `waiterMs`）——超时只证明调用方不再等。
3. **装配世代与提交权**（`_epoch` / `isAssemblyCurrent` / `_assemblies`）——停止之后完成的装配不得发布任何东西。
4. **状态合法转移表**（`LEGAL_EDGES` + `advance`）——状态只有一个写入者，而且它必须拒绝非法边。
5. **已提交事实的隔离面**（`emitFact` + 观察者错误账 + 深快照）——看得见的人不能改写已经发生的事。
6. **订阅/中间件的精确撤销**（entry + wrapper + owner 索引）——按名字清场会删掉别人的注册。
7. **服务与能力的权属**（四种归属分支 + `release*ByOwner`）——对象与归属不许分叉。

以上七项都在 `src/core/` 内、都由 Core 判定、都不接受外围插件"自证"。**把它们搬进可卸载插件，就是"空心小核"。**

---

## 5. 可外移但**本轮不动**的清单（连同理由）

| 具体实现 | 位置 | 本轮裁决 | 理由（对照计划 §2.3 的五条门槛） |
|---|---|---|---|
| JSON5 配方解析 | `json5-loader.js`（83 行） | **不动** | 物理上可搬，但它是纯函数、零状态、单向依赖，搬走对耦合没有任何改善；反而要处理导入路径兼容与打包清单。门槛③（兼容清楚）成本 > 收益 |
| 插件文件头元数据 | `plugin-meta.js`（118 行） | **不动** | 同上；且它已经"不 import 模块"，已经是正确形状 |
| 场景配方发现/缓存/include 展开 | `scene-controller.js` 的 `findScene`/`_expandIncludes` | **只文档分区，不搬** | 与 Core 的交点在 `switchTo` 的五段事实；把加载器搬出去会让"谁决定这一步"变成跨文件问题。门槛②（单向依赖）不满足 |
| 文件监视 / TTL / 空闲回收 | `plugin-manager.js` | **不动**（rc.26 已量：172 行 / 3.6%，五门槛过一条半） | 策略**已经**可经 `recycle-advisor` 角色外移，无需搬代码；硬上限与 TTL 兜底是「advisor 缺席/崩溃仍收敛」的闸，搬走即停摆。详见 ADR-10 的 rc.26 条目（该轮评估原文已随旧轮文档下线） |
| `confirm()` 的终端交互与日志着色 | `core.js` | **不动，只写边界** | 授权**结论**属 Core；readline 与 ANSI 才属宿主适配。本轮只把"结论 vs 交互"写清，不做抽离 |
| `env.js` / `dependency-resolver.js` 的公开路径 | 被外围直接 import | **不动** | 门槛③：不提供兼容 shim 就搬走 = 破坏用户插件 |

**结论：RC-CLEAN-2 的落地方式是"职责冻结 + 只读接口清单 + 不动实现位置"，符合计划 §2.3 末段的许可。**

后续若要搬：按 §2.3 五条门槛逐条给出回归证据（导入方、`files` 清单、ESM 缓存、同字节行为），
并用 ADR 记录"为什么现在才搬"。**不允许为了目录好看而搬。**

---

## 6. 结构化分段（本轮做的低风险收口）

三个大文件内部已经按职责分段，段的边界与本文 §3 的函数清单一一对应：

- `core.js`：① 常量与合同表 ② 日志与脱敏 ③ 订阅账 ④ 事实通知 ⑤ 启动/停止与世代 ⑥ 权属登记 ⑦ 授权与 schema ⑧ 派发与结算 ⑨ 服务 ⑩ 管道 ⑪ 确认
- `plugin-manager.js`：① 发现 ② eager 装载 ③ 懒索引 ④ 懒加载 Attempt/Waiter ⑤ 重载 ⑥ 回收 ⑦ 场景对账
- `scene-controller.js`：① 声明与全集公式 ② 五段式 ③ 持久场景 ④ lazy 登记 ⑤ 只读视图

分段用**文档 + 顺序**表达，不额外插横幅注释：计划的 §3.1 要求注释只描述"今天必须成立的事实"，
而"这里属于第几段"是导航信息，放在本文比放进源码更合适（也让注释预算不反弹）。

---

## 7. 下一轮若要动边界，先过这张表

| 问题 | 不合格的回答 |
|---|---|
| 抽出的代码是否**只做策略/格式**、不写可信事实？ | "它顺便也能记一下状态" |
| 是否**单向依赖**（少数输入/返回值）？ | "它要读 Core 的 3 个私有 Map" |
| 所有导入方、`files` 清单、ESM 缓存都有回归证据？ | "搜了一下没人用" |
| 配置/懒加载/场景/权限/停止反例的**输入输出等价**？ | "应该一样" |
| 零新依赖、无常驻定时器、初始化不显著变慢？ | "只多一点点" |

五条全过才搬；否则按本文 §5 的裁决冻结，并把理由写进 ADR。
