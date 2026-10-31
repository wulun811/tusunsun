# API 兼容性基线（v0.11.0 → v0.14.0）

> 专家原文 §13 的交付结构里有 `api-compatibility.md`（"与 0.10.4 的调用/事件/结果映射"），
> §12.2 又要求"每个 PR 必须报告：Core 行数变化、公开接口变化、状态写入者变化、是否增加依赖"。
> 这份文档此前**不存在**——v0.13.0 复核时列为缺失项之一。现在补上，基线取 v0.11.0
> （专家方案的起点），覆盖到 v0.14.0。
>
> 判定原则：**加性 = 兼容；改义 = 破坏性，须有 ADR。** 本文件逐条标出哪些是加性、哪些是改义。

## 1. 公开 `Core` 方法（33 个）

全部保留，**没有删除任何一个**。新增 0 个方法。

```
assertIdentity  callCapability  command        confirm        emit
emitFast        endTask         freezeCapability get           getCapabilityOutputSchema
getConfirmMetrics getData       getInflight    getMsgCount    getService
hasCapability   listCapabilities log           logJSON        offByOwner
on              register        registerCapability registerService releaseCapability
runPipeline     runServiceTracking setData      start          startTask
status          stop            use
```

复核方式：

```bash
node -e "const {Core}=await import('./src/core/core.js');
console.log(Object.getOwnPropertyNames(Core.prototype)
  .filter(n=>!n.startsWith('_')&&n!=='constructor').length)"   # → 33
```

**注意 `hasCapability` 与 `callCapability` 都是 `async`。**
写判据时忘 `await` 会拿到 Promise（恒真）——本轮的 E4 测试就踩过一次，
所以在这里点名，避免下一个人重复。

## 2. 结果信封（加性字段）

`callCapability` / `command` 返回的信封。旧三字段语义**未变**：
`ok` / `payload` / `error`。`ok === (state === 'succeeded')` 这条不变式保持。

| 字段 | v0.11.0 | v0.14.0 | 性质 |
|---|---|---|---|
| `ok` / `state` / `code` / `error` / `payload` | 有 | 有，语义不变 | 不变 |
| `call_id` / `attempt` / `attempt_id` | 有 | 有，**算法不变** | 不变 |
| `attempt_token` | — | **新增** | **加性**（v0.14.0，K-17） |
| `execution_outcome` | — | **新增**（超时路径） | **加性**（v0.12.0，K-02） |
| `still_running_at_return` | — | **新增**（超时路径） | **加性**（v0.12.0，K-02） |
| `caller` / `evidence` | 有 | 有 | 不变 |

### 2.1 `attempt_id` 为什么没改算法

专家 §5.3 要求"每个物理 Attempt 使用由 Core 自己产生的内部唯一 token"，
同时明说"**现有 `call_id`/`attempt_id` 可以继续用于关联**"。

v0.11.0 的实现是 `attempt_id = ${call_id}#${attempt}`，同一 `traceId` 调两次会撞号，
而 `core.js` 的注释却写着"标识物理尝试（唯一）"——**注释在说谎**。

两种修法：

- **(a)** 把 `attempt_id` 做成唯一 —— 破坏性：R0-76 等既有消费者按 `call_id#attempt` 解析它；
- **(b)** 保留 `attempt_id` 作关联，**新增** `attempt_token` 作唯一标识 —— 加性。

**选 (b)**，理由是不拿一个既有公开字段的语义去换一处内部便利。代价是信封里多一个字段，
收益是没有任何调用方需要改。同时把那条错误注释改对了。

## 3. 状态枚举（无新增，语义有收紧）

| 枚举 | v0.11.0 | v0.14.0 | 性质 |
|---|---|---|---|
| 结果 `state` | `succeeded` / `denied` / `failed` / `unknown` | 同 | 不变 |
| 插件 `state` | `registered` / `started` / `running` / `error` / `stopped` / `unloaded` / `unavailable` | 同 | **不变**（写入者收归 `advance()`，值集合没动） |
| 懒加载过程态 | `loading` / `in_flight_after_timeout` / `loaded` | 同 | 不变 |

**没有引入专家 §8.2 的七类枚举**（`DENIED` / `INVALID` / `FAILED_KNOWN` / `WAIT_TIMEOUT` /
`PARTIAL` / `INDETERMINATE` / `CLEANUP_FAILED`）。它们以具体 `code` 的形式存在
（`scene_partial`、`drain_timeout`、`execution_outcome:'unknown'`…），未统一成上位枚举。
这是**已知未完成项**，理由见 `core-invariants.md` 的 I-07 节：统一枚举会改所有既有 code。

## 4. 破坏性变更（三处，全部有 ADR）

| 变更 | 旧行为 | 新行为 | ADR |
|---|---|---|---|
| `confirm()` 非 TTY | 自动 `true` | **拒绝**（除非宿主显式 `trustedAutoApprove`） | ADR-09 |
| `registerService` 异主覆写 | 允许（仅 warn） | 抛 `service_conflict` | ADR-08 |
| `releaseCapability` 省略 owner | 放权 | 抛 `capability_conflict` / 返回 `null` | ADR-08 |

外加一处**收紧但不算破坏**的：`semverSatisfies` 对非法输入从 `true` 改为 `false`（ADR-06）。
说它不算破坏，因为旧行为是"把解析失败当成满足"——那是缺陷，不是契约；
但既有测试确实断言过旧行为，已在 ADR-06 §5 逐条登记改写。

## 5. 核心事件

新增 2 个，**没有删除或改名任何一个**：

| 事件 | 何时 | 性质 |
|---|---|---|
| `core:capability.frozen` | 冻结能力时 | 既有 |
| `core:capability.invoked` | 调用能力时 | 既有 |
| `core:capability.denied` / `.conflict` | 拒绝/冲突 | 既有 |
| `core:plugin.loaded` / `.unloaded` / `.unloading` / `.conflict` | 插件生命周期 | 既有 |
| `core:plugin.drain_timeout` | 排空超时 | 既有（v0.10.0） |
| `scene.switched` / `scene.switch_partial` / `scene.fallback` | 场景 | 既有 |
| `core.confirm` | 确认结果 | 既有，**载荷新增 `reason`**（加性） |
| **`core.service.conflict`** | 异主覆写被拒 | **加性**（ADR-08） |

`core.ready` 的载荷有**语义变化**：新增 `status`（`ready` / `unavailable`）与 `requiredFailed[]`。
**事件仍然照发**（这是 ADR-05 的明确决定，理由是"不发会让挂在 `core.ready` 上做初始化的
插件在失败场景下彻底不执行，反而更难诊断"）。旧订阅方只读 `plugins` 字段的话不受影响。

## 6. 核心行数变化（专家 §12.2 要求的四字段之一）

| 版本 | `src/core/` 行数 | 变化 | 主因 |
|---|---|---|---|
| v0.11.0 | 2222 | — | 专家方案基线 |
| v0.12.0 | 2610 | **+388**（压缩后 −41，净 +347） | P1 执行切面 / P2 生命周期 / P3 场景 / P4 小合同 |
| v0.13.0 | 2610 | **0** | 六合 Lite 并入，全部落在 `plugins/` 与 `vendor/` |
| v0.14.0 | 2746 | **+136** | §6.2 串行化 + §5.3 attempt token + I-01 `advance()` |

**这已经远超专家原文给的 2250 线。** §12.2 的原话是"超额必须经 ADR 和显式批准"。
本轮**没有**单独就"行数超额"作 ADR —— 这是**明确的未完成项**，
历史发布判定不随公开仓发布；这里不因为某个能力在文档里被提到就算已批准。

## 7. 状态写入者变化（专家 §12.2 要求的四字段之二）

| 事实 | v0.11.0 | v0.14.0 |
|---|---|---|
| `plugin.state` 写入点 | 8 处 / 3 模块 | **1 处直接 + 1 个 `advance()` 入口**（跃迁全经 Lifecycle） |
| `_inflight.set` | 4 处 | **2 处**（+1 / −1） |
| 装配入口（直接 init/start） | 4 条 | **1 条**（`lc.load`） |
| 场景提交 | 不验证就写 | 五段式 + `__scene__` 独占区 |

复核：`grep -rnE "(plugin|next|tracked)\.state = '" src/core/*.js` → 应只剩 1 行（`register` 初值）。

## 8. 依赖变化（专家 §12.2 要求的四字段之三）

**运行时依赖仍是 0 个。** 内置副本（vendored）从 1 个增至 2 个：

- `vendor/ws` —— WebSocket 的实现，无它则该功能不存在；
- `vendor/liuhe-lite` —— **可选器官**，未装配时不减少任何功能（ADR-07）。

两者都不是 npm 依赖，走 `scripts/verify-vendor.mjs` 逐文件 sha256 校验。

## 9. 未测试项（专家 §12.2 要求的四字段之四）

历史 NOT_RUN 清单不随公开仓发布。这里只强调三条**与 API 直接相关**的：

1. **Node 18 / 20 全链路未复验**。本轮全部在 Node 22.22.2 跑。`engines.node >= 18` 是声明，
   不是实测。**不得**把 Node 22 的结果算成三个版本全部通过。
2. **`confirm()` 的 TTY 交互分支未进 CI**（需真人按键）。只覆盖了非 TTY 的两个分支。
3. **`attempt_token` 的唯一性只在单进程内保证**。跨进程/重启后序号从 1 重新开始，
   若要全局唯一需加进程标识——本轮没做，也不声称做了。
