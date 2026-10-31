# Guard / Policy Hook / Event：三类接点的权属与失败合同

> 依据：专家《土行孙 v0.15.3 内核与 Hook 架构独立审查》§3、§5、§7。
> 本文把那份提案**降级成我们真的执行得了的形状**：它规定"每一类接点谁拥有、能做什么、
> 失败怎么处理、怎样精确清理"，**没有**引入 HookManager、事件溯源中心或
> `registerGuard` 这类可插拔的安全规则注册口。
>
> 状态：v0.15.4 起生效；**v0.15.5 按专家 0.15.4 复审 §3 把事实清单与注册身份收口**。
> 凡是与本文冲突的实现都以本文为准，除非 ADR 显式推翻。

---

## 1. 三类接点 + 一类变换

| 类别 | 谁拥有 | 时序与返回 | 失败策略 | 能否成为内核正确性的唯一保证 |
|---|---|---|---|---|
| **Guard** | Core 自身（不可插拔） | 必须与提交边界**原子邻接**；同步 | **fail-closed** | **能**，但前提是规则写在 Core 里 |
| **Policy Hook** | 宿主显式装配 | 公开时序；同步/异步各自声明 | 由固定类型决定，安全类一律 fail-closed | **不能**；只能**更严** |
| **Observation Event** | 每个订阅有 owner | 单向、不改变已提交结果 | 观察者错误被隔离并记诊断 | **不能**；看不看都不影响事实真假 |
| **Transform Middleware** | 每个中间件有 owner | 可异步、可改数据、可中断 | 由消息层合同决定 | **不能**；不得改内核权属/运行事实 |

一句话：**核心规律不可插拔；外围能力可插拔。Guard 保底，Hook 参与，Event 呈事实。**

### 1.1 为什么 `registerDispatchHook` 不是多余的

工具执行路径上，早期 PreHook 之后还可能经过懒加载与异步步骤。权限在途中被撤销后若直接进
Handler，会产生不可逆副作用。执行器因此在**真正派发前**做一次**同步**、基于解析后真实
capability ID 的终点复核；异步返回与钩子抛错都拒绝。

三条边界（`test/probes/hook-dispatch-guard.mjs` 独立复跑，退出码 0）：

| 情形 | 结果 |
|---|---|
| 策略明确拒绝 | `POLICY_DENIED`、`block:true` |
| 钩子抛异常 | `HOOK_ERROR`、`block:true` |
| 派发钩子返回 Promise | `HOOK_ERROR`、`block:true` |

**不为了"类型统一"把这层同步复核改成可 `await` 的通用事件** —— 那会引入一个真实的时序窗口。

### 1.2 为什么不引入通用 HookManager

钩子越多，状态变化越难证明。除非至少两个真实外围器官用同一种接口表达相同合同、并证明
**净减少代码**，否则不批准：新 Hook 总线、事件溯源中心、通用 before/after 生命周期织入框架。

---

## 2. 现有接点清单（v0.15.5）

| 接点 | 类别 | 归属机制 | 失败策略 | 撤销方式 |
|---|---|---|---|---|
| `Core.registerCapability` 的世代闸门 | Guard | Core 内部（无订阅） | 抛 `assembly_superseded` | 不可撤销（它就是底线） |
| `Core.registerService` 的归属判定 | Guard | Core 内部 | 抛 `service_conflict` | 不可撤销 |
| `LifecycleManager.advance` | Guard | Core 内部 | 抛 `invalid_state_transition` | 不可撤销 |
| `ToolExecutor.registerDispatchHook` | Policy Hook | `removeHooksByOwner(owner)` | `HOOK_ERROR` / `POLICY_DENIED` 一律 block | 按 owner |
| `Core.on / once` | Observation Event | **每次注册一个 entry + 唯一 wrapper**，`offByOwner` 按 entry 删 | 事实类走 `emitFact`（隔离同步抛错与异步拒绝）；普通事件走 `emit`（fail-loud） | 按 entry |
| `Core.use(stage, fn, {owner})` | Transform Middleware | 每次注册一个 `{token, stage, fn, owner}`，管道与 owner 索引**存同一个对象**；缺省取当前装配上下文 | 由消息层决定 | `unuse` / `offPipelineByOwner` / disposer（按 token） |
| 插件 `init/start/stop` | 固定协议阶段 | 装配上下文（ALS） | 阶段失败 ⇒ `error` | 生命周期 |

### 2.1 `emitFact` 与 `emit` 的分工（v0.15.5 起按**清单**执行）

`Core.emitFact(event, payload)` 是**已提交事实**的通知面。四条合同，缺一条就是
“同一个事实有两个答案”：

1. **逐订阅隔离**：观察者的同步异常被捕获，进有界诊断（`getObserverErrors()`，上限 200 条）；
2. **异步拒绝也必须被消费**：观察者返回 thenable 时**不等待**（非关键遥测不得拖住已提交的操作），
   但一定挂上 rejection 处理器 —— 否则拒绝会逸出成进程级 `unhandledRejection`
   （专家 H154-04 实测 `delivered=1 / errors=[] / unhandled=1`）。诊断里用 `phase:'sync'|'async'` 区分来源；
3. **载荷是观察者改不动的快照**：纯数据（null / 字符串 / 有限数字 / 布尔 / 普通对象 / 数组）
   做深拷贝 + 深冻结，嵌套数组与对象不再与事实源共享引用（H154-05 的根因）。
   含服务对象/句柄/环图的载荷**不深拷**（那会改变语义），退回浅冻结并记进 `getFactDegraded()` ——
   “这次没保护住”本身要被看见；
4. **结论先于通知**：`emitFact` 只在**状态/资源/提交已经完成后**才调用；它返回
   `{delivered, errors, asyncPending}`，**不抛**，也**不改写**调用方要返回的结果。

#### 已提交事实清单（唯一权威）

新增事实事件**必须先登记这张表**，并由 `test/unit/test-r25-01-*.test.mjs` 双向校验
（清单内的不许走 `emit`；`emitFact` 的调用点不许是清单外的名字）。

| 事件 | 出口 | 提交点（什么时候已经不可撤销） |
|---|---|---|
| `core.ready` | `Core.start` 末尾 | 全部 eager 装配结束、`running` 已置 |
| `core.stopped` | `Core.stop` 末尾 | 插件已停、在途装配已收尾并记账 |
| `core:plugin.loaded` | `LifecycleManager._load`（**唯一**） | `advance(plugin,'running')` 之后 |
| `core:plugin.unloaded` | `LifecycleManager._unload`（**唯一**） | `advance(plugin,'unloaded')` + `core.plugins.delete()` 之后 |
| `core:plugin.recycled` | `PluginManager._recycle` | 懒索引已重建（或已决定不重建）之后 |
| `core:plugin.drain_timeout` | `LifecycleManager._unload` | 排空已超时，卸载**继续** |
| `scene.switched` | `SceneController.switchTo` | 运行态已切换、`currentScene` 已提交 |
| `scene.switch_partial` | `SceneController.switchTo` 的部分应用分支 | 部分插件已启动/停止（结果不会再变） |

装载与卸载各自**只有一个**发布点（K24-01/02）：一次真实 `running` 转移只发一条 `loaded`，
`PluginManager._doLazyLoad` 不再重复发；普通 `unload` 也发 `unloaded`（修前只有 `_recycle` 发）。
`stop_timeout`（`released:false`）在提交点之前就早退，因此**永远不会**产生已卸载事实；
`drain_timeout`（`released:true`、在途未知）会发，但载荷带 `execution_outcome:'unknown'`。
「回收」是另一个事实（`core:plugin.recycled`，带 `reindexed` / `uncertain`），
不再借 `unloaded` 宣告。

**唯一留在 `emit` 的是 `core:plugin.unloading`** —— 它发在**任何拆卸动作之前**，是“提交前”的协调通知：
观察者抛错会中止卸载，且中止时插件仍完整在册（`R25-01/4` 用 `stop()` 调用次数为 0 锁死了这一点）。
把提交前通知塞进隔离面，等于让“中止”悄悄变成“继续”。

**`emit()` 原样未改，仍然 fail-loud。** 专家 §5.2 明令禁止“把所有 Hook 异常统一吞掉”：
安全类必须 fail-closed，观察类可以诊断后隔离，Transform 类由显式合同决定是否中断消息。
`R25-01/4` 与 `H154-G1` 是这条的反例对照（普通事件仍抛）。

### 2.2 注册记录的形状：一次注册 = 一个 entry（v0.15.5）

```js
Core._subs         // Set<entry>：{ id, event, fn, owner, wrapper, once }
Core._subsByOwner  // Map<ownerKey, Set<entry>>   ← 派生索引，可由 _subs 重建

Core._pipelines[stage]   // [entry]：{ token, stage, fn, owner }
Core._pipelineOwners     // Map<ownerKey, [entry]>  ← 派生索引，可由 _pipelines 重建
```

关键不是“多了一个字段”，而是**撤销的寻址方式变了**：

- 带 owner 的 `on/once` 每次注册生成一个**唯一 wrapper**（`wrapper.listener = fn`，Node 约定），
  它才是 EventEmitter 上的那条监听；`offByOwner` 按 entry 调 `removeListener(event, wrapper)`；
- 公开的 `off(event, fn)` 保持 Node 语义（删**最后一条**同名），并同步删掉账本里对应的那条；
- `use()` 返回的 disposer 关的是**它自己那个 token**；`unuse` 删最后一条同名并**同时**改账本。

为什么必须这样 —— 同一句判词的两次实测：

| 版本 | 记录了什么 | 仍然错在哪 |
|---|---|---|
| ≤ v0.15.3 | `listener._owner`（写在**函数**上） | 同一回调双 owner 时只有一个身份：`offByOwner('A')` 删掉 B 那条 |
| v0.15.4 | 每次注册一条 `{event, listener, owner}` | 账本对了，但**撤销仍按函数**：Node 删最后一条同名 ⇒ 删错那一条 |

v0.15.4 的专家反例 H154-01：A、C、fn、B 交错注册，释放 A 之后次序变成 `[fn, mid]` ——
应当删掉的 A 还在，B 被删了。**“有账本”不等于“注册身份唯一”。**

**派生索引可重建**（专家 §5 EE-01）：`_rebuildOwnerIndex()` 丢掉两张 owner 索引、
从权威 entry 重建；`R25-07/1-2` 断言重建后语义与计数一模一样，且已触发的 `once` 不会被“复活”。
两套手写可变真相迟早漂移 —— 所以只允许一套。

---

## 3. 最小元数据（不强制，只在需要时加）

`owner`（归属）、`phase`（阶段）、`kind`（guard/policy/transform/observation）、
`failure_policy`（由固定类型决定，**不允许**安全策略自己选 fail-open）、`dispose`（撤销句柄）。

除非真实消费者需要，不增加 `priority`、`retry`、`parallelism`、`filter expression`。

`kind=guard` **只是架构上的分类**，不意味着存在一个可以动态覆盖核心安全规则的
`registerGuard` 注册口。

---

## 4. 本轮明确**没有**做的事（诚实边界）

| 项 | 状态 | 说明 |
|---|---|---|
| 通用 HookManager / 事件总线 | NOT_RUN（**不做**） | 专家 §3.4 明确不批准；我们也没有需求证明它净减少代码 |
| `registerGuard` 动态安全规则 | NOT_RUN（**不做**） | 会让"内核正确性"变成可配置项 |
| Event 当事务日志 | NOT_RUN（**不做**） | `emit` 成功 ≠ 已持久化 ≠ Undo 成功；动作证据以事务/工具回执为准 |
| Pipeline 的热卸载消费者 | 部分 | 没有已知消费者靠"中途卸载管道"工作；`unuse` 已具备，等真实需求 |
| 跨进程/多 Cell 的订阅隔离 | NOT_RUN | 当前支持边界仍是"可信插件、同一 Cell / 进程" |
| 异步观察者的**超时**判定 | 部分 | 只保证“不阻塞、不逸出、可诊断”；没有新的监控平台（专家 §3.2 明确可选） |
| 非纯数据事实载荷的不可变 | 部分 | 深快照只对纯数据生效；其余退回浅冻结并记 `getFactDegraded()`，不假装已保护 |
| 执行器与内核的失败词汇统一 | OPEN（ADR-13） | 执行器仍有 `rejected/failed`，内核是 `denied/failed`；`result_kind` 只是加性共存，不是统一 |

---

## 5. 机械校验

| 判据 | 位置 |
|---|---|
| 订阅按注册记归属、跨 owner 不互删 | `test/unit/test-r2-01-ownership-and-hooks.test.mjs` R2-03/H-01-1～5 |
| 已提交事实不被观察者改写（含反例对照） | 同上 R2-04/H-03-1～4 |
| 中间件对称注销与兼容边界 | 同上 R2-05/H-02-1～4 |
| assembly-lock 的归属与 stop | 同上 R2-06/H-04-1～2 |
| 专家四条 Hook 反例的逐条回应 | `test/probes/r2-hook-ownership.mjs`（退出码 0 = 全部成立） |
| 专家 0.15.4 复审 §3 的**六条新反例**逐条复现 | `test/probes/r25-fact-and-entry-identity.mjs`（修前 3/9，修后 9/9） |
| 事实清单双向校验（清单内不许 `emit`、`emitFact` 不许越清单） | `test/unit/test-r25-01-fact-and-entry-identity.test.mjs` R25-01/6-7 |
| 同步派发守卫仍 fail-closed | 专家随包 `probes/hook-dispatch-guard.mjs`（退出码 0） |
