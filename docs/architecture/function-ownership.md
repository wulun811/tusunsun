# 函数权属表（Function Ownership）

> **这张表比文件列表更重要。** 以后改代码时不该问"哪个文件方便就往哪写"，
> 而该问"这个事实由谁负责"。
>
> 来源：专家《2222 行微内核精修实施计划 v1.0》§9.4。原文只给了目标表，本文补上
> **现状对照**（谁在今天实际写这个事实）与**收敛路径**。
>
> 一句话用法：改一个可变事实之前，先在下表找到它的行；"其他模块只能做什么"那一列
> 就是你被允许的动作边界。

---

## 1. 目标表（原文 §9.4）

| # | 操作 | 唯一权威 | 其他模块只能做什么 |
|---|---|---|---|
| 1 | 能力注册 / 释放 | Core Registry 语义 | 提交注册请求、读取只读视图 |
| 2 | 执行 Attempt 生命周期 | Invocation 统一内部函数 | 发起调用、等待、读取结果 |
| 3 | 插件阶段跃迁 | Lifecycle | 提出 load/reload/unload 意图，查看状态 |
| 4 | 依赖拓扑 | DependencyResolver | 提供声明、执行规划结果 |
| 5 | 场景提交 | SceneController（经 Lifecycle 验证） | 提供场景配方、查询已确认状态 |
| 6 | 运行状态只读视图 | 由以上权威事实即时生成 | 不维护自己的真相 |
| 7 | 领域副作用 / Undo | 实际工具 / 六合 / 其他插件 | Core 只持有引用与有限回执 |

---

## 2. 现状：七个事实，四个有多个写入者

### 2.1 总览

| # | 事实 | 目标写入者数 | **当前写入者数** | 结论 |
|---|---|---|---|---|
| 1 | 能力注册表 `_capabilities` | 1 | **1**（`core.js`） | ✅ 已达成 |
| 2 | 服务注册表 `_services` + `_serviceOwners` | 1 | **1**（`core.js`） | ✅ 已达成 |
| 3 | 执行在途 `_inflight` | 1 | **2**（`callCapability` / `command` 各一套） | ❌ P1-1 |
| 4 | 插件生命周期 `plugin.state` | 1 | **3 模块 8 处** | ❌ P2 |
| 5 | 依赖拓扑 | 1 | **1**（`DependencyResolver`） | ⚠️ 但 SemVer 判据本身错（K-11） |
| 6 | 场景当前态 `currentScene` | 1 | **1**（`SceneController`） | ⚠️ 但未验证就写（K-04） |
| 7 | 内部状态缓存 | 0 | **2**（`_lazyLoaded` + `_pending` 可能矛盾） | ⚠️ P2-4 |

**四个"1"、三个"多"**。也就是说：**已经做对的部分比想象的多**，问题集中在那三处。
这解释了为什么原文说"精修一颗内核"而不是重写——内核的骨架是对的，是三处结算各写了一遍。

### 2.2 事实 #1/#2：能力与服务注册表 ✅

| 动作 | 唯一权威 | 位置 | 其他模块的做法 |
|---|---|---|---|
| 注册能力 | `Core.registerCapability` | `core.js:341` | 提交请求 |
| 释放能力 | `Core.releaseCapability` | `core.js:382` | 提交请求（**含 owner 让渡，K-13b 待修**） |
| 注册服务 | `Core.registerService` | `core.js:702` | 提交请求（**异主覆写当前被接受，K-13a 待修**） |
| 枚举能力 | `Core.listCapabilities` | `core.js:557` | 只读 |

**已完成的部分**：v0.9.24 加的 `listCapabilities()` 消掉了三处直接读 `core._capabilities` 的插件
（`cell-runtime.js:85`、`tool-executor.js:923,942`、`haotian-lite.js:58`）。这是"给接口而不是暴露结构"的
正确做法，**本轮不需要重做**。

**待修**：`registerService` 的异主覆写（P4-3）、`releaseCapability` 的匿名放权（P1-5）。

### 2.3 事实 #3：执行在途 ❌（本轮第一刀）

| 入口 | 谁在写 `_inflight` | 位置 | 结算时机 |
|---|---|---|---|
| `callCapability` | 自己 | `core.js:603`（+1）/ `613-615`（−1） | handler 真 settle ✅ |
| `command()` 能力分支 | 自己 | `core.js:652`（+1）/ `673-675`（−1） | **Promise.race 结束** ❌ |
| `command()` 事件分支 | **不写** | — | 无 Attempt 概念 |

**这就是 I-03 的违反点，也是本轮唯一一处"两套代码做同一件事"。**

**收敛路径（P1-1）**：

```
                    ┌──────────────────────────────┐
  callCapability ──►│                              │
                    │  _dispatchCapability()       │──► Attempt
  command(能力)  ──►│  （唯一的 +1/−1 位置）        │──► Waiter（可超时）
                    │                              │
  command(事件)  ──►│  （改为走 settleOnce，不再   │
                    │    绕开 Attempt）             │
                    └──────────────────────────────┘
```

**收敛后的判据**（表里要能被验证）：全仓 `_inflight.set` 的出现次数 = **1**。

**当前**：`grep -c "_inflight.set" src/core/core.js` → **4**（两处 +1、两处 −1）。

### 2.4 事实 #4：插件生命周期 ✅（收敛完成）

| 写入点 | 模块 | 何时写 | 是否该由它写 |
|---|---|---|---|
| `core.js` `register()` | Core | 注册（初始态 `registered`，不算跃迁） | ✅ 是 |
| `lifecycle-manager.js` `advance()` | Lifecycle | 其余 7 个跃迁（load/unload/stop/装配失败/迟到撤销） | ✅ 是，唯一 |
| `core.js` `_startPlugin()` | Core | 只调 `lifecycle.load()`，自己不写 `plugin.state` | ✅ 委托 |
| `core.js` `stop()` | Core | 只调 `lifecycle.advance(p,'stopped'/'unavailable')` | ✅ 委托 |
| `plugin-manager.js` `_reloadPluginLocked()` | PluginManager | 走 `lc.unload` + `lc.load`，自己不写状态 | ✅ 委托 |

**唯一实例**：每个 Core 恰好一份 `core.lifecycle`。`PluginManager` 曾经 `new` 第二个
`LifecycleManager`，于是同一插件名落在两把锁上 —— 两边各自“串行”、合起来不串行，
`getTransitions()` 与非法计数还各记一本。R018-01～R018-06 是这条的回归锁。

**为什么它当初最贵**：四个答案里**没有任何一个高于其他**，`readiness` 又读 `plugin.state`
做聚合，于是结论跟着不确定。

**收敛路径（P2，已全部落地）**：

```
P2-1  Core.start / _startPlugin  ──委托──►  Lifecycle.advance()
P2-2  _reloadPlugin              ──委托──►  Lifecycle.load()
P2-3  Core.stop                  ──委托──►  Lifecycle.unload()（逆拓扑序）
剩余  Core.register 写 'registered'（初始值，不算跃迁）
      LifecycleManager 内部写其余 7 个跃迁
```

**收敛后的判据**：`grep -rn "plugin\.state = \|next\.state = " src/core/` 的结果 = **3 处**
（`core.js:231` 初始态 + `lifecycle-manager.js` 两处）。

### 2.5 事实 #5：依赖拓扑 ⚠️

| 动作 | 唯一权威 | 位置 | 状态 |
|---|---|---|---|
| 构建 DAG | `DependencyResolver.buildDAG` | `dependency-resolver.js` | ✅ |
| 拓扑排序 | `DependencyResolver.topologicalSort` | 同上 | ✅ |
| 版本判据 | `DependencyResolver.semverSatisfies` | `dependency-resolver.js:1-26` | ❌ **K-11** |
| 逆拓扑序（停止用） | **不存在** | — | ❌ **K-09** 的成因 |

**写入者唯一，但两个判据缺失**。这是"权威对了、能力不全"的典型：
拓扑排序只被**启动**用（`plugin-manager.js:104`、`123`），**停止**从不用它。

**收敛路径**：P4-1 修 SemVer，P2-3 让 `stop()` 也用同一张图（方向反过来）。

### 2.6 事实 #6：场景当前态 ⚠️

| 动作 | 唯一权威 | 位置 | 状态 |
|---|---|---|---|
| 读场景 | `SceneController.findScene` | `scene-controller.js:28` | ✅ |
| 提交 `currentScene` | `switchTo` | `scene-controller.js:101` | ⚠️ **未验证就提交** |
| 落盘 `activeScene` | `switchTo` | `scene-controller.js:106` | ⚠️ 同上 |
| **装配插件** | `_loadSingle` | `scene-controller.js:123-143` | ❌ **第四条独立路径** |

**写入者唯一（只有 `switchTo`），但它的写入没有前置条件。** 这不是"多个写入者"问题，
是"唯一写入者不验证"问题——所以 K-04 的症状是 `ok:true` 而不是"状态被覆盖"。

**收敛路径**：P3-1 五段式；`_loadSingle` 删除（它省下的 21 行正好抵消 `switchTo` 新增的 21 行）。

### 2.7 事实 #7：内部状态缓存 ⚠️

`PluginManager` 有一套关于"这个插件装着没装着"的**三份记录**：

| 记录 | 含义 | 可能矛盾 |
|---|---|---|
| `core.plugins`（Map） | 已注册的插件对象 | 权威 |
| `_lazyLoaded`（Set） | 懒加载过的 | 与 `core.plugins` 可不同步 |
| `_pending`（Map） | 可懒加载但未装的 | 与上一行可同时为真/同假 |

**历史证据**：v0.9.33 的 EV-03 就是这三份打架（卸载后 `_lazyLoaded.has=true` 而
`_pending.has=false`，于是 `hasCapability` 永久为 false 且不可恢复）。

**收敛路径**：这三份**可以都保留**（它们语义不同：已装 / 曾懒装 / 可懒装），
但必须有**一个函数**生成它们的联合视图，且 `hasCapability` 只能读那个视图。
P2-4 的 `describeLazyLoad` 就是它的雏形。

---

## 3. 三条评审规则

由这张表直接派生的规则。每条都对应一个真实踩过的坑：

### 规则 1｜新增写入点前，先找现成的权威

> 想写 `plugin.state`？去找 Lifecycle。它没有对应跃迁，说明**状态机缺一个转移**，
> 而不是"这里顺手写一下".

依据：8 处写入点里，有 5 处是"顺手写一下"长出来的。

### 规则 2｜只读视图不得自带缓存

> 任何"运行状态只读视图"（`status()`、`show()`、`readiness.status()`）必须每次从权威事实现算。
> 一旦它缓存，就变成了第二份真相（违反 I-01）。

依据：v0.10.0 的 `_reloadPlugin` 读 `getInflight` 就是"只读视图"，但它读的那个数被写坏了——
**只读视图的正确性完全依赖被读者**。

### 规则 3｜跨机器读必须登记

> 三台状态机之间只允许三种跨机器读（见 [core-transition-contracts.md](core-transition-contracts.md) §4.2）。
> 第四种需要在本表登记，否则视为架构越界。

依据：原文 §6.4 明确否定中央协调器。不登记的话，"读一下"会慢慢长成"协调"。

---

## 4. 收敛后这张表长什么样（P5 验收时的目标）

| # | 事实 | 唯一写入者 | 全仓写入点（**当前 v0.11.0** → 目标） | 验证命令 |
|---|---|---|---|---|
| 1 | `_capabilities` | `Core` | **1 → 1** ✅ | `grep -c "_capabilities.set" src/core/core.js` → 1 |
| 2 | `_services` | `Core` | **1 → 1** ✅ | `grep -c "_services.set" src/core/core.js` → 1 |
| 3 | `_inflight` | `_dispatchCapability` | **4 → 2**（1 处 +1 / 1 处 −1） | `grep -c "_inflight.set" src/core/core.js` |
| 4 | `plugin.state` | `LifecycleManager`（含 `register` 初始态） | **8 → 3** | `grep -rn "\.state = '" src/core/ \| wc -l` |
| 5 | 依赖拓扑 | `DependencyResolver` | **1 → 1**（但 `stop` 需复用） | 无重复排序实现 |
| 6 | `currentScene` | `SceneController.switchTo`（Verify 之后） | **1 → 1**（但需加前置验证） | 只在 Commit 段写 |
| 7 | 装配入口 | `Lifecycle.load` | **4 → 1** | `_loadSingle` 已删 |

**上表的"当前"一列全部是 v0.11.0 上实测的 grep 结果**，不是估计。复核方式就是最后一列的命令。

**第 3 行与第 7 行是本轮的核心产出**：一个执行结算点、一个装配入口。
其余五行要么已经达成，要么只是判据修正。
