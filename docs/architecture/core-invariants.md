# 内核不变式（Core Invariants）

> 这十条是**评审清单**，不是宣传语。每条都可被一条具体的代码判据检验；检验不了的那条，就应该删掉。
>
> 来源：专家《2222 行微内核精修实施计划 v1.0》§2。
> 落地核对：本文每条都标注**当前是否成立**。实测依据两份探针：
> `test/probes/k01-k14-core-semantics.mjs`（K-01～K-14 + N-01～N-03，共 20 条）与
> `test/probes/k15-k17-concurrency-and-identity.mjs`（K-15～K-17，v0.14.0 新增）。
> 状态：`✅ 成立` / `⚠️ 部分成立` / `❌ 违反`（附反例 ID）
>
> **基线说明**：v0.11.0 时本文给出「4 违反 / 4 部分 / 2 成立」。
> v0.12.0 修完 20 条反例后**没有同步本文**，于是退出条件的文档本身仍写着"未通过"——
> 这是 v0.13.0 复核时发现的缺陷。v0.14.0 已按实测逐条重写，现状见文末汇总表。
>
> 一句话用法：**这个 PR 改动了哪个事实的唯一写入者？** 若答案不唯一，停下来。

---

## 0. 六语义 × 十条（速查）

**这一节是给第一次读内核的人看的**：先把六条语义与下面的十条不变式对上，再去读细节。

| 语义 | 一句话 | 落在哪几条 |
|---|---|---|
| **A 权属** | 同一次登记只有一个精确 owner；撤销按**注册身份**，不按名字 | I-01、I-06、I-09 |
| **C 契约** | 授权与运行条件在**准确的入口**生效；派发前的守卫不可跳过，也不是 Hook | I-01、I-02 |
| **I 执行** | 真实 Attempt 与 Waiter 分离；超时只证明调用方不再等，不证明副作用停了 | I-03、I-07 |
| **T 转移** | 状态只有一个写入者，而且它必须拒绝非法边 | I-01、I-04 |
| **E 观测** | 事件呈**已确认的事实**；观察者不能让已提交的事改口，也不能改载荷 | I-04、I-08 |
| **R 收敛** | 未知就是未知：不冒充成功、不冒充已撤销、不由错误类别推断重试安全 | I-05、I-07、I-10 |

**Guard / Hook / Event 的边界（三件不能互换）**

- **Guard 保底**：`assertIdentity` / `_invocationContext` / `_denyCapability` 在派发路径**上**，
  不可选、不可被 Hook 替代；只有它们能给出"确定没执行"的拒绝。
- **Hook 参与**：管线（`use`）与安全钩子在受约束范围内参与；安全派发钩子 fail-closed，普通 `emit` 保持 fail-loud。
- **Event 呈事实**：`emitFact` 只发**已提交**的事实，做深快照与观察者隔离；它不是"请求"，也不是持久证据（I-08）。

改代码前问一句：**这个 PR 改动了哪个事实的唯一写入者？** 答案不唯一，就停下来。边界与搬迁门槛见
`kernel-boundary.md`；每条规则"为什么存在"见 `decisions/core-evolution-history.md`。

---

## I-01｜唯一权威

> 每一种可变运行事实只有一个负责写入的机制；事件、缓存、场景诊断是其投影，不得制造第二份状态。

**检验方式**：对任一变可变事实（`plugin.state`、`_inflight`、`capabilities`、`currentScene`），
全仓 grep 写入点。写入点 > 1 即为违反。

**当前状态：✅ 成立**（v0.14.0 由 ⚠️ 转 ✅）

`plugin.state` 的**跃迁**写入点已收敛到 `LifecycleManager.advance()` 一处：

| 跃迁 | 调用方 | 是否经唯一写入者 |
|---|---|---|
| `started` / `error` / `running` / `unloaded` | `lifecycle-manager.load()` / `unload()` | ✅ 本模块内 |
| `stopped` | `core.stop()` | ✅ 走 `this.lifecycle.advance()` |
| `unavailable` | `pm._reloadPlugin()` 失败分支 | ✅ 走 `this.lc.advance()` |
| `registered` | `core.register()` | ✅ **初始值，不是跃迁**（关闭条件明确允许） |

复核命令（应只剩 1 行，且是 `register` 的初始值）：

```bash
grep -rnE "(plugin|next|tracked)\.state = '" src/core/*.js
# → src/core/core.js:236:    plugin.state = 'registered';
```

**遗留的真实问题不在 `plugin.state` 上，而在它的近邻**：
`plugin-manager.js` 的 `_loadOutcomes` 记录里还有 `rec.state = 'in_flight_after_timeout'` /
`rec.state = 'loaded'`。那**不是插件状态**，是懒加载的**过程记录**（K-10 引入，
用来回答"刚才超时那次最后怎样了"）；它与 `plugin.state` 是两个不同的事实，不是同一个事实的两份副本。
把两者合并会让"插件现在是什么状态"和"上一次装载尝试结果如何"互相覆盖 —— 那是退步不是收敛。

**关闭条件已满足**。反例 **K-05**（重载后停在 `registered` 而插件实际可运行）的根因是
`_reloadPlugin` 自己写状态；该路径已改为委托 `lc.load()`，本轮又把剩下两处外部跃迁收回 `advance()`。

---

## I-02｜声明即执行约束

> 权限、输入类型、必需依赖、冻结规则必须在真实副作用入口有效，未支持则明确拒绝。

**当前状态：✅ 成立**（v0.14.0；v0.11.0 时违反，依据 K-06 / K-07 / K-11 / N-02 / N-03）

v0.11.0 时的五处失效，现在逐一有回归锁（全部在变异下会红）：

| 声明了什么 | 修前在哪个真实入口失效 | 反例 | 现在 |
|---|---|---|---|
| `input_schema.required` | `params=null` / `params='str'` 时整个校验被跳过 | **K-07** | ✅ K-07/1,2 |
| `input_schema` | 同 owner `override` 时未声明即丢失（只继承了 `permissions`） | **K-06** | ✅ K-06/1,2 |
| `requires` 版本范围 | 非法范围解析失败被当作"满足" | **K-11** | ✅ K-11/1,2,3 |
| `provides` | 字符串形态直接抛 TypeError | **N-02** | ✅ N-02/1,2 |
| 场景的 `include` | 缺失时只告警，装配继续 | **N-03** | ✅ N-03/1 |

五条里最该记住的是 **K-06**：v0.9.32 专门修过"override 丢 `permissions`"（R0-151），修法是
"未声明字段继承旧值"，但**只对 `permissions` 一列生效**。同一条判据、同一种形状的缺陷，
在 `input_schema` / `output_schema` / `tags` 上又活了两轮。逐字段打补丁会把同形状缺陷留到下一轮 —— 见 ADR-08。

**关闭条件已满足**：上表五行都有回归锁，且每把锁都在变异测试下验证过会红（见 CHANGELOG v0.12.0 的九组变异）。

**仍不成立的部分**：`declarableSchema()` 只把内核**真能校验**的关键字写进 `input_schema`，
模型可见的 `enum` / `items` / `pattern` 等不进校验层。这是**有意为之**而非遗漏 ——
注册那些关键字会被核心具名拒绝（`UNSUPPORTED_SCHEMA_KEYWORDS`），
假装支持比不支持更糟。

---

## I-03｜物理执行与等待独立

> 调用方超时不缩短 handler 的真实生命周期；冻结／排空基于实际在途，而非等候请求数。

**当前状态：✅ 成立**（v0.14.0；v0.11.0 时是 ❌，本项目最贵的一条）

`callCapability` 是对的（`finally` 里减 in-flight，等 handler 真 settle）。
`command()` **不对**：它 `Promise.race` 超时后在同一个 `finally` 里减计数，于是
**"等候结束"被当成了"执行结束"**。

实测（K-02）：15ms 等候 / 140ms handler → 返回瞬间 `getInflight === 0`，而 handler 仍在跑。

**连带击穿的判据**（K-02b）：v0.10.0 给 `_reloadPlugin` 加的在途闸门读的就是这个计数，于是
超时后 reload 返回 `ok:true`，而 handler 仍在运行 —— **那道闸门从上线那天起就是空的**。

这正是原文 §5.1 说的"根因"：两条入口各有一套结算代码。修法见落地计划 P1-1。

**关闭条件**：`_dispatchCapability` 统一两条入口；`getInflight(owner)` 恒等于未 settle 的 handler 数；
K-02 与 K-02b 同时转 FIXED。

---

## I-04｜状态只能根据完成事实提交

> 只有已核验的启动才是 Ready；插件不因"调用过 start"就天然 Running；场景不因"发出 switch"就天然 Committed。

**当前状态：✅ 成立**（v0.14.0；v0.11.0 时是 ❌，三个子系统各违一次）

| 子系统 | 违反方式 | 反例 |
|---|---|---|
| 启动 | `_startPlugin` 捕获 init 异常后**继续**，`start()` 末尾无条件 `emitFast('core.ready')` | **K-03** |
| 插件 | `_reloadPlugin` 手动 `init/start` 后不改状态 | **K-05** |
| 场景 | `switchTo` 在 `_loadSingle` 失败（只 log）后无条件 `currentScene = name` | **K-04** |

**K-03b 让这条最难看**：同一进程里，`core.ready` 已宣告就绪，而 `readiness.status()` 同时返回
`unavailable`、`criticalFailed:['crit']`。**对同一个事实，系统内部有两句互相矛盾的话。**

**关闭条件**：K-03/K-03b/K-04/K-05 四条全转 FIXED，且 `core.ready` 载荷里的 `status` 与
`readiness` 的结论不再可能矛盾（同源于 `plugin.state`）。

**单一写入者**：`LifecycleManager` 每个 Core 恰好一份（`core.lifecycle`），装配、懒加载、
重载、卸载、场景切换全排同一条 owner 队列。另建一个实例不是“多一把锁”，而是“同一 key
两把锁”：两边各自串行、合起来不串行，轨迹与非法计数还会各记一本（R018-01～R018-06）。

---

## I-05｜关系决定释放顺序

> 先让依赖方退出，再释放提供方；生命周期变化不得无视依赖图和真实使用中的资源。

**当前状态：✅ 成立**（v0.16.0-rc.5 起两条路径共用同一份依赖解释）

| 路径 | 判据 | 实测 |
|---|---|---|
| **关机**（`Core.stop`） | 按逆拓扑序停：dependent 先、provider 后 | K-09/1 `dependentD → providerP`；R018-07 服务名依赖 `dependent → provider`（`requires: { 'db-service': … }` 曾因只认插件名而退回插入序，顺序相反） |
| **运行期卸载**（`lc.unload`） | provider 在跑时，dependent 必须拦住卸载 | `Cannot unload "prov": "dep" requires it`，且 prov 仍在、dep 仍 running |

**依赖边只有一个解释位置**：`dependency-resolver.js` 的 `resolveDependencyTarget()`。
**四个消费者都必须从这里取**：启动排序（`buildDAG`）、停机排序（`computeStopOrder`）、
卸载闸门（`dependentsOf`）、懒加载闭包（`resolveLazyChain` / `resolvePendingDependency`）。
rc.5 只统一了前两个；后两个各写一套，于是服务名依赖可以穿透卸载拦截、也进不了懒加载闭包
（R019-01 / R019-02 是这两条的回归锁）。解析顺序：插件名 → 运行时服务归属 → `provides` 声明。

**停机不能直接反转启动顺序**：它只面对已装载的插件，提供者缺席与版本不满足都不是障碍，
只是少一条边；环必须仍给出顺序（否则关机挂住），但 `stopOrderUnresolved` 与
`stopOrderCycles` 要随 `core.stopped` 一起交出来。

**边界**：运行期卸载的拦截是**抛错**而不是排队等待。也就是说"想卸 provider 又不想停 dependent"
这件事本身没有解 —— 那是依赖图的语义（要么先停依赖方，要么接受拆坏）。这条不是缺陷。

---

## I-06｜资源获取／释放对称

> 监听器、计时器、能力／服务注册、冻结和解除冻结的成功／失败路径都有明确清理所有者。

**当前状态：✅ 成立**（v0.14.0；v0.11.0 时违反，依据 K-08 监听器泄漏与 N-01 伪耗时指标）

`command()` 的事件式分支（`core.js:677-700`）三处结算只清了一部分：

| 路径 | 清了什么 | 漏了什么 |
|---|---|---|
| 收到响应 | `timer` + `.error` | — |
| 收到错误 | `timer` + `.response` | — |
| **超时** | `timer` + `.response` | **`.error`** ← 反例 K-08 |

实测：5 次超时后 `.response` 增 0、`.error` 增 **5**。长驻进程里这是无界增长。

另外 **N-01**：`plugin.init_failed` 载荷里的 `initTimeMs` 实测为 `1792721113673` —— 那是 epoch
时间戳，不是耗时。一个"指标"给出了一个不是它声称的东西的值，比不给更糟。

**关闭条件**：`settleOnce()` 统一三条路径；K-08 转 FIXED；N-01 的字段要么给出真实耗时，要么删掉。

---

## I-07｜失败与未知不得冒充成功或已撤销

> 拒绝、执行异常、等待超时、部分应用、结果未明、清理失败必须机器可分辨。

**当前状态：✅ 成立**（v0.14.0；v0.11.0 时是 ⚠️）

三类事实现在都机器可分辨：

| 事实 | 怎么表达 | 判据 |
|---|---|---|
| 拒绝 vs 执行失败 | `CAPABILITY_CODE_STATE` 分为 `denied` / `failed` / `unknown`（ADR-03） | — |
| 超时后 handler 可能仍在跑 | 信封带 `execution_outcome:'unknown'` + `still_running_at_return:true` | K-02/2 |
| 超时**不缩短** handler 生命周期 | in-flight 只在真 settle 时释放 | K-02/1 |
| 卸载打断在途 | `ok:false, code:'drain_timeout', forced_partial:true, execution_outcome:'unknown'` | I-10 |
| 场景部分应用 | `code:'scene_partial'` + `applied[]` / `missing[]` | K-04/1b |
| 运行态已切但落盘失败 | `code:'scene_persist_failed'` + `runtime_applied:true` + `persisted:false` | K-16/3 |
| **并发声明成功但未兑现** | 修前：三次并发 reload 都报 `ok:true`，只兑现 1 次 | **K-15（v0.14.0 修）** |

最后一行是 v0.13.0 复核时新查出的 —— 它说明 I-07 的违反不只在"错误码设计"上，
还会以**并发下重复宣称成功**的形态出现。修法是串行化（§6.2），不是改错误码。

**仍不成立的部分（如实登记）**：`PARTIAL` / `INDETERMINATE` / `CLEANUP_FAILED` 三类
在专家 §8.2 里是**命名类别**，本仓只把它们表达成具体的 `code`（`scene_partial`、
`execution_outcome:'unknown'`、`drain_timeout`），**没有**落成一个统一的枚举。
这是**判断**：引入统一枚举会改所有既有 code，属破坏性变更，须另开 ADR。
不影响"机器可分辨"这条要求本身 —— 每个事实都有唯一 code，只是没有共同的上位名。

---

## I-08｜事件是通知，不是证据持久化

> `emit` 只证明发出通知；没有 durable sink 不得声称审计已经保存。

**当前状态：✅ 成立**

`event-sink` 存在时会降级标记（`readiness.js` 读 `sink.health()`）；`SECURITY.md` 与 ADR-04 都写明
"未接可靠 Sink 时标 `unknown/none`"。这条没有反例。

**但要记住它是有条件的成立**：成立的依据是"文档没说谎"，不是"代码强制"。如果哪天有人写了
"审计已保存"而没有 sink，这条立刻变成违反。

---

## I-09｜核心不知道器官

> PULL、经验层、六合 Lite、MCP、LLM 供应商、机器人动作语义不得写入 Core 特殊分支。

**当前状态：✅ 成立（含一条历史修复）**

v0.9.33 的 R0-97 把 `core.js` 里对一个**厂商专用记忆插件**的两个调用
（`reportAccess` / `reportCapabilityHeat`）换成了通用观测事件 `core:capability.invoked`。
现在 `src/core/` 里没有厂商名。

**唯一的结构性违反是 K-14**：`plugin-manager.js:5` 静态导入 `../../plugins/_lib/plugin-esm-hint.mjs`。
注意这**不是** I-09（那是"点名器官"），而是依赖方向反向 —— 更接近原文 §9.3 的
"Core -X-> 具体外围插件"。**K-14 不得写成运行漏洞**，专家原文明令。

**但它有一个可复现的结构后果**（净室实测，非推断）：把 `src/core/` 八文件原样复制到另一目录后
`import` 它，直接 `ERR_MODULE_NOT_FOUND`（缺 `<dir>/plugins/_lib/plugin-esm-hint.mjs`）。
即**内核无法作为独立单元被加载**。这不是"漏洞"，是"微内核"这个说法在物理上还不成立。

**关闭条件**：P4-4 之后 `src/core/` 不再有指向 `plugins/` 的 import，
且"单独拷走 `src/core/` 仍能 import"可作为一条结构判据。

---

## I-10｜失效收敛有权属边界

> Core 只回收自己的内存／注册／调用状态；外部动作的 Undo／补偿由插件或宿主承担，无证据时保留未知。

**当前状态：✅ 成立**（v0.14.0；v0.11.0 时是 ⚠️）

边界是清楚的（ADR-04 §5 与 ADR-07 §3 都写明没有 Undo / 幂等键）。
v0.11.0 时越界的只有一处：`drain_timeout` 之后仍继续卸载、然后返回 `{ok:true}`。
现在返回值三件事分开说（原文 §6.2 的原话是"达到期限后只能返回 `drain_timeout`／
`forced_partial` 一类清楚结果，不能继续卸载并无条件 `ok:true`"）：

```js
{ ok: false, code: 'drain_timeout', forced_partial: true,
  inflight: 3, released: true, execution_outcome: 'unknown' }
```

**为什么仍然继续卸载**：这是**判断**，写在代码注释里 —— 关机不能因为一条卡死的链永久挂住。
但"我继续了"必须与"安全卸载完成"分开报告，两者不是一回事。

**边界重申**：Core 只回收自己的内存/注册/调用状态。文件事务的 Undo 在六合、
网络与硬件动作的对账由拥有领域知识的插件决定。Core 无权自动重试（原文 §8.4：
`attempt_id` 不是幂等键；本轮的 `attempt_token` 也**不是**幂等键，它只保证可区分）。

---

## 汇总表

> 对照两列：**v0.11.0**（专家方案的基线）与 **v0.14.0**（本轮实测）。
> 专家 P5 的退出门槛是"全部核心不变式绿"，所以这张表的右列就是那条门槛的判据。

| 不变式 | v0.11.0 | **v0.14.0** | 反例 | 关闭批次 |
|---|---|---|---|---|
| I-01 唯一权威 | ⚠️ | **✅** | K-05 | P2-2 + v0.14.0 `advance()` |
| I-02 声明即约束 | ❌ | **✅** | K-06, K-07, K-11, N-02, N-03 | P1-2, P1-3, P4-1, P4-2, P3-2 |
| I-03 执行与等待独立 | ❌ | **✅** | K-02, K-02b | **P1-1** |
| I-04 按完成事实提交 | ❌ | **✅** | K-03, K-03b, K-04, K-05 | P2-1, P2-2, P3-1 |
| I-05 关系决定释放顺序 | ⚠️ | **✅** | K-09 | P2-3 |
| I-06 获取释放对称 | ❌ | **✅** | K-08, N-01 | P1-1（settleOnce）, P2-1 |
| I-07 未知不冒充成功 | ⚠️ | **✅**（含 1 处残留，见下） | K-02, **K-15** | P1-1 + v0.14.0 串行化 |
| I-08 事件非持久证据 | ✅ | **✅** | — | — |
| I-09 核心不知道器官 | ✅（K-14 属依赖方向） | **✅** | K-14 | P4-4 |
| I-10 收敛有权属边界 | ⚠️ | **✅** | drain_timeout | P2-1 |

**v0.11.0：0 成立以外 —— 4 违反 / 4 部分 / 2 成立。
v0.14.0：10 条全部成立。**

这个分布的原始结论仍然有效：内核的问题不是"某处写错了"，而是"同一条纪律在
三个子系统里各破了一次"，所以修复必须按语义批，不能按文件批。

### I-07 的那处残留（不折算成通过）

`PARTIAL` / `INDETERMINATE` / `CLEANUP_FAILED` 三类在专家 §8.2 里是**命名类别**；
本仓把它们表达成具体 `code`（`scene_partial` / `execution_outcome:'unknown'` / `drain_timeout`），
**没有**统一枚举。每个事实都有唯一 code、机器可分辨，但没有共同上位名。
判为**判断而非缺陷**：引入统一枚举会改所有既有 code，属破坏性变更，须另开 ADR。
若将来有人要求"六语义各有一个公开枚举"，那是一件新工作，本表不代它背书。

### 这份文档此前失准过（必须记）

v0.12.0 修完全部 20 条反例后，本文**一次都没更新**，汇总表仍写着"4 违反 / 4 部分 / 2 成立"。
后果不是"文档落后"这么轻 —— 专家 P5 的退出门槛读的就是这份清单，
**于是退出条件的文档本身写着"未通过"**，而代码其实已经全绿。
v0.13.0 复核时发现，v0.14.0 按实测逐条重写。

教训与本仓反复记录的那条同源：**一个从不同步的判据，等于没有判据。**
