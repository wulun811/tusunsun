# 内核状态机转移合同（Core Transition Contracts）

> 三台**本地**小状态机，各自持有自己的状态，通过少量原子检查互相约束。
> 不是一台中央状态机管全部子系统，也不是六个 `*Manager`。
>
> 来源：专家《2222 行微内核精修实施计划 v1.0》§5.4、§6。
> 状态标注同 [core-invariants.md](core-invariants.md)：`✅ 符合` / `⚠️ 部分符合` / `❌ 不符合`。

---

## 0. 为什么是三台而不是一台

```
┌─────────────────────┐   ┌─────────────────────┐   ┌─────────────────────┐
│ A. Attempt/Waiter   │   │ B. Plugin Lifecycle │   │ C. Scene Composition│
│  （Invocation 拥有） │   │  （Lifecycle 拥有） │   │  （Scene 拥有）     │
│                     │   │                     │   │                     │
│ 一次真实执行的事实   │   │ 插件运行形态的事实   │   │ 装配结果的事实       │
└──────────┬──────────┘   └──────────┬──────────┘   └──────────┬──────────┘
           │                          │                          │
           │  getInflight(owner)      │  plugin.state            │  currentScene
           │  ◄───────────────────────┤                          │
           │                          │◄─────────────────────────┤
           │                          │   「装载必须经我」        │
           └──────────────────────────┴──────────────────────────┘
                    交叉点只有三个，且都是**只读查询 + 一个 guard**
```

**关键设计约束**：三台机器之间**没有**事件总线式协调，没有中央协调器。
只有三处"读对方状态做一次判断"：

1. `Lifecycle` 读 `Invocation` 的 `getInflight(owner)` → 决定能不能安全卸载；
2. `Scene` 读 `Lifecycle` 的 `plugin.state` → 决定 Commit 还是报 partial；
3. `Invocation` 读 `Lifecycle` 的 `cap._frozen` → 决定拦不拦这次 dispatch。

这三处是**设计上的耦合点**，不是缺陷。写在这里是为了让下一个人知道：**只允许这三处跨机器读**。

---

## 1. 状态机 A：Attempt 与 Waiter

### 1.1 状态集

```
Attempt（一次物理执行）:
  created ──► authorized ──► running ──► settled
     │                                      
     └──► denied          （授权拒绝，从未启动 handler）
     └──► failed_before_start  （内部原因，不新增公开枚举）

Waiter（一个等候方）:
  waiting ──► received      （拿到成功或失败结果）
          └► timed_out      （等候结束，**Attempt 状态不变**）
```

### 1.2 合法转移表

| 从 | 到 | 触发条件 | 允许的触发者 | 副作用 |
|---|---|---|---|---|
| `created` | `authorized` | `_invocationContext` 通过 + 未 frozen | Core | 无（尚未登记 in-flight） |
| `created` | `denied` | 授权/冻结/schema 拒绝 | Core | 发 `core:capability.denied` |
| `authorized` | `running` | 紧邻 handler 调用（**不插 await**） | Core | `_inflight[owner] += 1` |
| `authorized` | `failed_before_start` | handler 不是函数等内部错误 | Core | 无 |
| `running` | `settled` | handler 的 Promise 真的 settle | **只有 handler 自己** | `_inflight[owner] -= 1` |
| `waiting` | `received` | 结果先到 | Waiter | 无 |
| `waiting` | `timed_out` | 定时器先到 | Waiter | **无 —— 关键：不得改 Attempt** |

### 1.3 两条不可变条件

**条件 A-1**：
```
getInflight(owner) === 该 owner 名下「已 authorized 且未 settled」的 Attempt 数
```
注意措辞：**不是**"还有几个调用方在等"。这正是 K-02 的错处。

**条件 A-2**：
```
一个 Waiter timed_out，不得导致任何一个 Attempt 进入 settled
```
换句话说：`timed_out` 是**等待方**的终态，不是**执行方**的终态。

### 1.4 当前实现状态（v0.16.0-rc）：✅ 符合

> **更正记录（2026-10-24，R3）**：本表在 v0.10.0 时是“❌ 不符合”。代码后来改好了，表没跟上 ——
> 专家《v0.15.2 深审》§4 点名了这件事：一份自称“合同”的文档自己制造了**第二份过期事实**。
> 现在分成两段：本节是**当前状态**，1.4.1 是**带版本号的历史快照**（只存档，不作为判据）。

| 入口 | 是否符合 | 依据 |
|---|---|---|
| `callCapability` | ✅ | `finally` 里减计数，等 handler 真 settle |
| `command()` 能力分支 | ✅ | 已并入 `_dispatchCapability`（`src/core/core.js` 的 `command()` → “两条入口现在共用”那段），与 `callCapability` 同一条记账链 |
| `command()` 事件分支 | ✅ | 三条结算路径（响应/错误/超时）统一走 `finish()`，`.error` 不再泄漏（I-06） |

**实测**（本轮跑的，不是“应该”）：

```
$ node test/probes/k01-k14-core-semantics.mjs K-02 K-02b
[FIXED] K-02   command 超时后在途归零，但 handler 仍在运行（并击穿重载闸门）
[FIXED] K-02b  K-02 × 重载闸门：超时归零后 reload 在 handler 仍在跑时“安全成功”
--- 2 条：BUG 0 / FIXED 2 / NOT_REPRODUCED 0 ---
```

#### 1.4.1 历史快照（v0.10.0，仅存档）

| 入口 | 当时 | 原因 |
|---|---|---|
| `callCapability` | ✅ | `finally` 里减计数，等 handler 真 settle |
| `command()` 能力分支 | ❌ | `Promise.race` 超时后在 `finally` 减计数 → 违反 A-1 |
| `command()` 事件分支 | ⚠️ | 无 Attempt 概念（靠事件），超时路径漏删 `.error` → 见 I-06 |

当时实测：K-02（15ms/140ms → 返回瞬间 inflight=0，handler 仍在跑）、K-02b（连带击穿重载闸门）。

### 1.5 关闭条件

`_dispatchCapability` 统一两条入口后：
- K-02 断言 `getInflight===1`（返回瞬间）且 `===0`（settle 后）；
- K-02b 断言 reload 返回 `reload_busy`；
- 变异验证：把减计数挪回 `finally` 的等价位置 ⇒ 至少 3 条转红。

### 1.6 同一合同的装配面落地：懒加载 Attempt（v0.15.2，LAZY-01～04）

能力调用把 Attempt 与 Waiter 分开记账之后，**装配路径仍然混着**：`PluginManager._lazyLoadOne`
把"真实装载"和"本次等候"塞进同一个 `Promise.race`。于是同一条错误以三种形状复发
（专家 0.15.1 复审 §3 独立复现，我复核后确认）：

| 反例 | 修前实测 | 违反 |
|---|---|---|
| LAZY-01 | 插件已 `loaded`、`settledAt` 已写，45ms 的旧定时器又把 `state` 改成 `in_flight_after_timeout` | A-2（等待方终态污染执行方） |
| LAZY-02 | 明确的 `failed` 同样被改写成 `in_flight_after_timeout` | A-2 |
| LAZY-03 | 首个等候方超时后 `finally` 删掉 single-flight 句柄，第二个请求**又起一笔 init**（实测计数 2） | A-1 的装配版：句柄数 ≠ 在飞装载数 |
| LAZY-04 | 装载失败直接 reject 到 `callCapability`，漏出异常而不是失败信封 | 出口合同（R0-76） |

修法**不新增状态机**，只是把 §1.1 的两层结构搬到装配面：

```
LoadAttempt（一次真实装载）: loading ──► loaded | failed      （只有 _doLazyLoad 写 state）
Waiter（一个等候方）       : waiting ──► received | timed_out  （只写 waitedOutAt，不改 state）
```

三条不变条件（与 A-1 / A-2 同构）：

- **L-1**：`_loading.get(name)` 非空 ⇔ 该 name 有一笔未 settle 的真实装载。释放点只有一个
  （`_startLazyLoad` 里挂在 attempt 上的 `release`），**不在**等候方的 `finally`。
- **L-2**：等候方超时只能写 `waitedOutAt`。`state` 的三个取值只由真实装载写；
  `in_flight_after_timeout` 是 `describeLazyLoad()` 的**派生视图**（`!settledAt && waitedOutAt`），
  不是存储值 —— 存储值会被下一个人当事实读，这正是 LAZY-01 的成因。
- **L-3**：装载失败/超时一律走 `{ok:false, code, category, result_kind, dispatched, side_effect}` 信封。
  其中 `dispatched:false` 与 `side_effect:'unknown_or_possible'` **同时成立**：handler 一次没派发，
  但 `init()` 可能已经跑了一半。这一对组合正是修前那套 `state` 表达不出来的（ERR-015 的延伸）。

**回归**：`test/probes/r017-lazy-attempt-facts.mjs`（11 条）。其中 3 条是**正例**
（超时后迟到成功、并发同入队、已运行插件再读），它们在 v0.15.1 上就是绿的 ——
作用是防止"一律超时/一律拒绝"式的假修复。基线实测：**8 红 3 绿**；修后 **11 绿**。

**变异**：M35（把 `release` 挪回等候方 `finally`）⇒ LAZY-03/a 红；
M36（删掉 `clearTimeout`）⇒ LAZY-01/a、/b 红。

### 1.7 提交权：装配成功之后还得有“允许提交”（v0.15.3，X01～X03）

§1.6 解决了“装载事实不被等候方污染”，但没有回答下一个问题：**这笔装配什么时候才算数。**
专家 0.15.2 深审的三条跨状态机反例都来自这个缺口 —— 动作有生命周期，却没有提交时机、
没有归属、没有有效范围。

| 反例 | 修前实测 | 违反 |
|---|---|---|
| X01 | Core 停止后，迟到的 init 完成：插件变 `running`、注册能力、再调仍 `succeeded`，而 `plugin.stop()` 一次没被调 | 提交时机（A/B 两台机器之间） |
| X02 | 同名注册返回 `false` 被丢弃：B 的 init 照跑、`B.state=running`、返回 `{ok:true}`，而 Map 里仍是 A | 归属（B 机器 + 注册结果） |
| X03 | 启动期 `loadAll` 登记的 lazy，切到不包含它的场景后仍可激活 | 有效范围（C 机器） |

机制只有一个整数 + 一条闸门：

```
Core._epoch        : 每次 start / 进入 stop 各自 +1
assembly.epoch     : 装配开始时绑定（beginAssembly）
isAssemblyCurrent  : epoch 一致 ∧ !_stopping ∧ !_stopped
```

三条不变条件：

- **C-1（提交时机）**：`registerCapability` / `registerService` 在**注册那一行**查世代，
  不是在 `init` 返回之后查。理由：init 可以“先注册、再 await”，停止正好发生在这个 await 里；
  只在尾部检查拦不住它。init/start 返回后再查一次 —— 两次都必要，但作用不同：
  前一次拦住“停止之后新发布”，后一次拦住“停止期间已经发布完、只是还没返回”。
- **C-2（撤销的精确性）**：迟到装配已发布的东西按**装配账**（ALS store 里记下的 capability id /
  service name）收回，不按 owner 名匹配 —— 插件可以自报一个与插件名不同的 owner，
  按名字匹配会漏删。这**不是回滚**：init 对外部世界做过的事不会被撤销。
- **C-3（有效范围）**：场景撤销 lazy 索引的判据是**目标场景声明的全集**，不是“本实例登记过谁”。
  归属记在 `_pending[*].source`（`boot` / `scene:*` / `host` / `repair`），`host` 不随场景撤。

停止的语义随之收紧：**`stop()` 不再等于“资源已完全释放”**。它先递增世代，再给在途装配一个
**有界**窗口（`_stopAssemblyDrainMs`），窗口内没跑完的逐条进 `core.stopped.outstandingAssembly`
并把对应对象标 `unavailable`。停止之后 `callCapability` / `command` 一律 `core_not_running`。

另一条产品裁决：**原地重启不支持**。插件是模块级单例，再次 `init()` 会撞上它自己上次注册的
能力（`capability_conflict`），于是“重启”只会半启动 —— 静默半启动比拒绝更糟，
所以 `start()` 在 `_stopped` 后抛 `core_restart_not_supported`。

**回归**：`test/probes/x01-x04-cross-state-machine.mjs`（15 条；基线 6 绿 9 红 → 14 绿 1 红，
剩下的 X04 属 R2）+ `test/unit/test-r1-01-cross-lifecycle-commit.test.mjs`（19 条）。

**变异**（每条都真跑过，不是设想）：

| 变异 | 变红的用例 |
|---|---|
| M37 删掉 `registerCapability` 的世代闸门 | R1-05/6 |
| M38 删掉 `_load` 的世代复查 | R1-05/2、R1-05/3 |
| M39 `reconcileLazy` 不撤销任何东西 | X03/1、X03/3 |
| M37+M38 同时删 | X01/1、R1-05/1、/2、/3、/5、/6（共 6 条） |

M37 与 M38 各自单独删时 X01/1 仍是绿的（两道防线互相兼顾）—— 所以上表最后一行才是
“这两道防线合起来是必要的”的真正证据，不能只拿单删结果当结论。

### 1.8 所有权、转移与通知：v0.15.4 的三个新合同（R2）

专家 0.15.3 深审 §6 把剩余工作归成四块（K3/K4/H-01/H-03）加两个小接缝（H-02/H-04）。
它们看似分属“状态机”“服务注册”“事件”三处，但**同一条判据**：
**一次操作要么带身份地整体提交，要么整体不生效。**

#### C-4（K3）转移必须可执行，不是一句约定

`advance(plugin, to)` 从“一个赋值”变成“查表 + 拒绝”：

```js
const LEGAL_EDGES = { registered:[…], started:[…], running:[…],
                      error:[…], stopped:[…], unavailable:[…], unloaded:['unavailable'] };
advance(plugin, to, {bestEffort})   // 非法 ⇒ invalid_state_transition（带 from/to/合法出口）
```

三条配套判据：

| 判据 | 为什么它必须存在 |
|---|---|
| `_transitions` 轨迹 | “状态合法”不能只证明“没抛错”；要能读出 `registered→started→running` |
| `_illegalTransitions` 计数 | 正常流程必须恒为 0；失败路径的 `bestEffort` 非法转移仍要记账 |
| 结构扫描（R2-01/K3-6） | 全仓只剩 `core.register` 的**初始值**可以直写 `plugin.state` |

**失败路径为什么允许 `bestEffort`**：那里已经有一个待抛的错误或一个正在关机的 Core，
再让“给状态做个标注”抛第二个异常，就会把真正的原因盖掉 —— 那是“错误出口不唯一”的又一例。

#### C-5（K4/X04）服务：对象与归属同一次提交

修前四种情况糊在一条 `prevOwner == null || claimant == null || prevOwner === claimant` 里，
于是**匿名覆写被当成合法**：`getService(name)` 返回 B，`_serviceOwners` 仍记 A（X04/a）。

| 情形 | 结果 | 归属怎么变 |
|---|---|---|
| 原本无主 | 允许（收编） | 记本次调用方 |
| 同一 owner 更新 | 允许 | 不变 |
| **匿名覆写已归属** | **拒绝** `service_conflict` | 不变 |
| 异主覆写 | 拒绝（除非宿主授权） | 不变 |
| 宿主接管（`{takeover:true}` 或 `service.allowOverride`） | 允许 | 改为 `@host`（或新主），留覆盖记录 |

“原子”在代码里就是一句话：**两个 Map 的写入之间不得有 `await` / `throw`**。
卸载侧的对应合同是 `releaseServicesByOwner` / `releaseCapabilitiesByOwner`：
只能撤销归属确为该 owner 的条目 —— 删 `svc.name === 插件名` 是 §5.4 明令禁止的粗放清场。

#### C-6（H-01/H-03）通知：订阅有身份，事实不被观察者改写

| 概念 | 合同 | 代码位置 |
|---|---|---|
| 订阅 | 每次注册一条 `{event, listener, owner}` 记录；`offByOwner` 只删本 owner 的记录 | `Core._subs` / `_recordSub` / `_dropSub` |
| 已提交事实 | 观察者抛错被隔离并记入 `getObserverErrors()`，**不改写**已提交结论 | `Core.emitFact` |
| 未提交/内部事件 | `emit()` 保持 fail-loud（§5.2：不得把所有异常统一吞掉） | `Core.emit` |
| 中间件 | `use(stage, fn, {owner})` 记归属并返回 disposer；owner 缺省取当前装配上下文 | `Core.use` / `unuse` / `offPipelineByOwner` |

细节与“哪些接点属于哪一类”见 [hook-guard-event.md](hook-guard-event.md)。

---

## 2. 状态机 B：Plugin Lifecycle

### 2.1 状态集（v0.15.4 实测词表）

```
registered ──► started ──► running
    │             │           │
    │             ├──► stopped ──► unloaded（终态，唯一出口是 unavailable）
    │             │           │
    └─────────────┴──► error ─┘
                          │
                          └──► unavailable（重载失败 / 停止时未完成的装配）
```

**只有七个词**：`registered | started | running | error | stopped | unloaded | unavailable`。

⚠ 本文早期版本写的是十个词（含 `initializing` / `freezing` / `draining` / `stopping`）。
那四个是**设计时的名字**，从未被实现：冻结与排空在代码里是 `LifecycleManager` 的
步骤（`_step2FreezeCapabilities` / `_step3DrainRequests`），不是插件实例的状态。
留着它们就是“合同文档自己制造第二份过期事实”—— 与 README 旧行数同一类问题。

同样不属于插件实例的还有 `loading` / `loaded` / `failed`：它们写在**装载尝试记录**
（`_loadOutcomes` / `_pending`）与只读视图里。一个事实两个名字，判据就会两个都信。

### 2.2 合法转移表（与 `lifecycle-manager.js` 的 `LEGAL_EDGES` 逐行一致）

| 从 | 到 | 触发 | 唯一写入者 | 前置条件 |
|---|---|---|---|---|
| （无） | `registered` | `core.register()` | Core | 有 `name` + `init`；**这是初始值，不是跃迁** |
| `registered` | `started` | `init()` 返回 | Lifecycle | 同一装配世代仍有提交权 |
| `started` | `running` | `start()` 返回 | Lifecycle | 同上 |
| `registered` / `started` | `error` | init/start 抛错 | Lifecycle | 必须先收回本次已发布的登记 |
| `error` / `unavailable` | `started` | 同一对象重试装配 | Lifecycle | — |
| `running` / `started` | `stopped` | `core.stop()` 里 `stop()` 成功 | Lifecycle | 失败则**保持原状态**并记 `stopFailures` |
| 任意非终态 | `unavailable` | 停止窗口内未完成的装配；reload 失败 | Lifecycle | — |
| `unloaded` | `unavailable` | **仅** reload 失败路径 | Lifecycle | 返回值与对象状态必须是同一个结论 |
| 任意 | `unloaded` | `lc.unload()` 完成清理 | Lifecycle | 注册/监听器已释放 |

表外一律 `invalid_state_transition`。`unloaded → started/running` 仍是非法。
**机械校验**：`test/unit/test-r2-01-ownership-and-hooks.test.mjs` 的 R2-01/K3-1～K3-8。

### 2.3 状态唯一写入者（v0.15.4：已关闭）

**当前：✅ 写入点 2 处，且其中一处是初始值。**

| 位置 | 写什么 | 为什么它合法 |
|---|---|---|
| `core.register()` | `'registered'` | **初始值**，不是跃迁（I-01 的关闭条件明确允许） |
| `LifecycleManager.advance()` | 其余一切 | 唯一跃迁写入者，受 `LEGAL_EDGES` 约束 |

本节早期版本记录的两条当时确实是缺陷，现已全部收回：

- `_reloadPlugin` 的三步手动序列（`register → init → start`，全程不写 `running`）→ 已委托 `lc.load()`；
- `core.stop()` 的 `'stopped'` 与 `_reloadPlugin` 的 `'unavailable'` → 已改调 `advance()`；
- `src/bootstrap/cli.js` 早加载的 `plugin.state = 'running'`（跳过 `started`）→ 已改走两条合法边。

最后这一处是 R2 才被找出来的：它不在 `LifecycleManager` 里，所以此前“唯一写入者”的
结构扫描没看见它 —— 又一次“判据看不见它的目标”。现在 R2-01/K3-6 扫的是 `src/` 全量。

### 2.4 并发锁要求

同一 plugin owner 的 `start` / `load` / `unload` / `reload` 必须串行化或 single-flight。

**当前部分满足**：`_lazyLoadOne` **有** single-flight（`_loading` Map，实测并发两次 `init` 只跑 1 次 —— 见落地探针）。
但 `_reloadPlugin` 与 `unload` 之间**没有**互斥：探针 K-02b 显示 reload 可以在 handler 在途时执行。

### 2.5 排空（drain）合同

| 情形 | 允许的返回 | 禁止 |
|---|---|---|
| 等在途归零 | `{ok:true}` | — |
| 超时但仍在途 | `{ok:false, code:'drain_timeout', inflight:n}` 或 `forced_partial:true` | ❌ 继续卸载后返回 `ok:true` |

**当前（v0.15.4）：✅** drain 超时后 `_unload` 返回
`{ok:false, code:'drain_timeout', forced_partial:true, inflight, released:true, execution_outcome:'unknown'}`，
并发出 `core:plugin.drain_timeout` —— “我继续了”不再被报成“安全卸载完成”。

### 2.6 关闭条件（v0.15.4：全部达成）

| 关闭条件 | 状态 | 判据 |
|---|---|---|
| `plugin.state` 写入点收敛到 Lifecycle 一处 | ✅ | R2-01/K3-6 结构扫描（只允许 `core.register` 的初始值） |
| `_reloadPlugin` 委托 `lc.load()` | ✅ | K-05/2 / E1/b |
| K-05 与 drain 断言同时转 FIXED | ✅ | E1/l（drain_timeout 载荷）与 K-05 系列 |
| **合法转移可执行** | ✅ | R2-01/K3-1～K3-8 + `_illegalTransitions === 0` |

---

## 3. 状态机 C：Scene Composition

### 3.1 状态集（五段）

```
        ┌──────────────────────────────────────────────────────┐
        │                                                      │
  Plan ──► Preflight ──► Apply ──► Verify ──► Commit          │
    │          │            │          │          │            │
    │          │            │          │          └► committed │
    │          │            │          └► partial / missing     │
    │          │            └► rollback_attempted               │
    │          └► rejected（运行系统**未被触碰**）              │
    └──► scene_not_found ─────────────────────────────────────┘
```

### 3.2 每段的合同

| 段 | 允许做 | 禁止做 | 失败时 |
|---|---|---|---|
| **Plan** | 读场景文件、展开 include、算 required/optional/toAdd/toRemove | 改运行系统 | 返回 `scene_not_found` |
| **Preflight** | 校验每个 required 文件可解析、依赖范围可满足 | 卸载任何插件 | 返回 `rejected` + `missing[]`，**运行系统零改动** |
| **Apply** | 经 `pm` + `lc` 卸载/加载 | 直接 `import` + `init` + `start` | 记录已发生的变化 |
| **Verify** | 查 `core.plugins` 与 `_capabilities` 实际状态 | 修改任何东西 | 形成 `applied/missing/unexpected` |
| **Commit** | 仅 Verify 通过后写 `currentScene` + 持久配置 | 未验证就写 | 返回 `partial:true` |

### 3.3 当前的违反

**❌ `switchTo`（`scene-controller.js:71-121`）没有 Preflight，也没有 Verify。**

致命的是第 95-97 行：
```js
for (const p of toAdd) {
  if (!this.core.plugins.has(p)) await this._loadSingle(p);   // 失败只 log，继续
}
```
`_loadSingle`（123-143）找不到文件时 `log('error')` 然后 `return` —— 调用方无法区分成败。
随后第 100-101 行无条件：
```js
const oldScene = this.currentScene;
this.currentScene = name;      // 插件没装上，场景已"切换成功"
```
第 106 行再把 `activeScene` 落盘。

**实测（K-04）**：`ok:true`、`currentScene='needit'`、`toAdd=['does-not-exist']`、插件未注册。
**这是把"我尝试过"写成了"我做到了"。**

### 3.4 第四条装配路径

`_loadSingle` 是一条**独立的**插件装载路径：自己 `import`、自己 `register`、自己 `init`、自己 `start`，
**不经过** `LifecycleManager`，也不登记 `_pluginFilePaths`。

全仓共 **4 条**装配入口：

| # | 入口 | 是否经 Lifecycle | 是否写 state |
|---|---|---|---|
| 1 | `Core._startPlugin` | ❌ 自己 init/start | ✅ 写 `started`/`running`/`error` |
| 2 | `PluginManager._loadEagerPlugin` → `Core.register`（由 `Core.start` 统一启动） | ❌ | — |
| 3 | `PluginManager._doLazyLoad` → `lc.load` | ✅ | ✅（经 lc 写 `running`） |
| 4 | `SceneController._loadSingle` | ❌ | ❌（状态都不写） |

**P3 的目标是把 4 收敛为 3，把 1 也委托给 Lifecycle，最终只剩一条。**

### 3.5 关闭条件

- 缺必需插件 ⇒ `ok:false`，`currentScene` 与配置**都不变**；
- 部分失败 ⇒ `partial:true` + `applied`/`missing`；
- 并发两次切换 ⇒ 第二次排队或具名拒绝；
- `_loadSingle` 删除，全仓装配入口 ≤ 3。

---

## 4. 三台机器的协调（唯一允许的三种跨机器读）

### 4.1 「请求重载一个仍有在途调用的插件」

```
[Scene/外部] reload 请求
      │
      ▼
[Lifecycle] 检查依赖（_step1CheckDependents）
      │
      ▼
[Invocation] getInflight(owner) ──► >0 ──► [Lifecycle] 拒绝 reload_busy
      │                                        （旧版本继续服务）
      └── 0 ──► [Lifecycle] freeze 能力 ──► stop ──► unload
                        │
                        ▼
                 [Lifecycle] load 新版本 ──► verify running
                        │
                        ▼
                 [Evidence] 对外发布实际结果
```

**当前状态：❌** 中间那个 `getInflight` 读的是被 K-02 弄坏的计数，所以整条链在"超时过的插件"上失效。
这就是为什么 **P1 必须先于 P2**。

### 4.2 允许的三种跨机器读（且仅此三种）

| # | 谁读谁 | 读什么 | 用途 | 是否可改对方状态 |
|---|---|---|---|---|
| 1 | Lifecycle → Invocation | `getInflight(owner)` | 判断能否安全卸载 | ❌ 只读 |
| 2 | Scene → Lifecycle | `plugin.state` | Verify 段的判据 | ❌ 只读 |
| 3 | Invocation → Lifecycle | `cap._frozen` | 拦不拦这次 dispatch | ❌ 只读 |

**任何第四条跨机器读都需要在本文档里登记，否则视为架构越界。**

### 4.3 明确禁止的协调方式

- ❌ 中央状态机协调器（原文 §6.4 明确否定）
- ❌ 跨机器事件驱动状态机（会成为隐式的第二写入者）
- ❌ 共享可变状态对象（本项目已在 `_initOwner` 上踩过一次，改用 `AsyncLocalStorage`）

---

## 5. 迁移顺序（原文 §6.5 的落地版）

```
① 提炼唯一的 load/start/stop/unload 内部操作 + 状态表     ← 本文件 §2.2 就是那张表
② 现有启动路径委托它（Core.start 不再吞必需插件失败）      ← P2-1
③ 接入 lazy / eager / reload，证明状态一致                ← P2-2（reload 走 lc.load）
④ 最后改造 SceneController，让它成为「配方 + 事务意图」     ← P3-1
⑤ 删除旧分支与冗余缓存，禁止新旧并行                       ← P4-5
```

**每一步的退出判据都是"旧路径被删"，不是"新路径能跑"。** 原文 §12.3 把"新旧生命周期并存"
列为停止条件，这条比任何测试都重要——两套状态机并行时，所有测试仍可能全绿。
