# ADR-11：错误原因的加性归一（`category` / `result_kind`），不迁移既有 code

- 状态：**已采纳**（v0.14.1），部分落地（见 §6）
- 影响面：`src/core/core.js`（`CAPABILITY_CODE_STATE`、`_failureResult`）、
  以及所有产出 `code` 的执行面（`plugins/tool-executor.js`、`plugins/cell-runtime.js`、
  `src/core/plugin-manager.js`、`src/core/scene-controller.js`）
- 决策者：维护者（用户），执行方起草
- 触发：专家 0.14.0 复审 §5 与 §5 末段原文：
  "错误枚举：不用破坏既有 code 迁移，优先 加性建立 category / result_kind 归一字段，
  保持 code 为稳定细粒度原因；先 ADR 决策，再实现。"

## 1. 要决定的问题

专家方案 §8.2 要求"把七类错误统一成枚举"。此事在 v0.14.0 被列为冻结三门槛之一，
当时我方以"统一会改所有既有 code、属破坏性变更"为由未做。

专家这轮给出了第三条路：**不改 code，加一列类别**。本 ADR 就是把这个决定写清楚，
并回答三个具体问题：

1. 类别的取值集合是什么（几类、叫什么）？
2. 类别与 `state` 是什么关系（会不会又一次"同一 code 两个 state"）？
3. 既有 69 个 code 怎么归类——是全部人工映射，还是有推导规则？

## 2. 现状（先摆事实）

全仓 `code: '...'` 共 **69 个不同值**，散落在 `src/core/`（11 个）与 `plugins/`（58 个）。
它们分属两种完全不同的形状，此前混在一起：

- **执行面信封**（`callCapability` / `command` 的返回值）：有 `ok/state/code/error/payload` 五字段，
  且 `state ∈ {succeeded, denied, failed}`，`code` 经 `CAPABILITY_CODE_STATE` 映射到 `state`。
- **插件自报码**（如 `receipt_not_yours`、`sandbox_path_denied`、`workspace_unavailable`）：
  只保证是字符串，**没有**任何状态归属表，也没有任何字段能回答"这是谁的错"。

ADR-03 修过一次"同一 code 两个 state"（`capability_not_found` vs `tool_not_registered`），
但那是**个案**。§8.2 要的是**可枚举的分类**，而 69 个码里只有 10 个进了映射表。

## 3. 决定

### 3.1 加两个字段，不动一个旧字段

```
{ ...既有信封,
  category: 'request' | 'assembly' | 'environment' | 'resource' | 'security' | 'upstream' | 'internal',
  result_kind: 'denied' | 'failed' | 'indeterminate' }
```

- `code` **原样保留**，含义不变，仍是细粒度原因。任何既有消费者不受影响。
- `category` 回答"**该去找谁**"（七类，见 §3.2）。
- `result_kind` 回答"**这次到底做成没有**"，与 `state` 的分工见 §3.3。
- 三者都是**加性**字段：旧代码 `if (!r.error)` / `if (r.state === 'denied')` 全部照旧成立。

### 3.2 七类的定义（每一类都对应一个不同的**处置方向**）

| category | 含义 | 该去改什么 | 例子 |
|---|---|---|---|
| `request` | 调用方给的东西不对 | 改调用参数 | `invalid_input`、`tool_not_registered`、`invalid_session_id` |
| `assembly` | 装的这套东西不成立 | 查装配/场景/依赖 | `capability_not_found`、`missing_required_service`、`dependency_cycle`、`plugin_source_not_found` |
| `environment` | 宿主环境不支持或未就绪 | 查平台/版本/配置 | `plugin_module_not_esm`、`workspace_unavailable`、`unsupported_restricted_shell` |
| `resource` | 有配额、被限流、超预算 | 等、扩容、缩请求 | `quota_exceeded`、`rate_limited`、`context_budget_exceeded`、`circuit_open` |
| `security` | 被信任边界拒绝 | **不要重试**，查权限 | `capability_denied`、`capability_frozen`、`sandbox_path_denied`、`receipt_not_yours` |
| `upstream` | 下游/模型/流失败 | 查下游 | `model_error`、`stream_error`、`api_version_conflict` |
| `internal` | 我方代码出错 | 报缺陷 | `handler_threw`、`no_binding`、`declared_but_missing` |

**为什么是这七类而不是别的：** 分类的唯一用途是**决定下一步动作**。两个错误若处置相同，
就不该分成两类（那只是给同义词起两个名字）；若处置不同，就**必须**分开。
按这个判据校验过上表每一行——同类的处置一致，跨类的处置必然不同。

### 3.3 `result_kind` 与 `state` 的分工（这是本 ADR 最容易被做错的一处）

`state` 是**三态合同**（succeeded / denied / failed），已经冻结，不能改。
`result_kind` 在它之上补一个 `state` 表达不了的区分：

- `denied` —— 没执行（**确定**没有副作用）
- `failed` —— **调用失败了**；到底执行过没有，看 `dispatched`（副作用**可能已发生**）
- `indeterminate` —— 不知道执行到哪（副作用**未知**）

关键：`result_kind` **不是** `state` 的别名。`drain_timeout` 与 `handler_threw` 都是
`state: 'failed'`，但前者 `result_kind: 'indeterminate'`（在途被打断，副作用不知道），
后者 `result_kind: 'failed'`（handler 抛错，调用链是清楚的）。
v0.10.0 已经开始用 `execution_outcome` 表达同一件事——**本 ADR 要把这种临时字段
收敛成合同**，而不是再加一个新名字。

> **更正（v0.15.2，专家 M-01）**：本节原写 `failed —— 执行了、失败了`。这条文字定义
> 与实现自相矛盾：`capability_not_found`（一次 handler 都没派发）实测返回的也是
> `state:'failed' / result_kind:'failed'`。根因是把**调用结论**和**执行事实**塞进了同一个词。
> 现在分开：
>
> | 字段 | 回答的问题 | 取值 |
> |---|---|---|
> | `result_kind` | 这次**调用**怎么了（调用方该做什么） | `denied` / `failed` / `indeterminate` |
> | `dispatched` | handler **派发过**没有 | `true` / `false` |
> | `side_effect` | 副作用能不能**排除** | `none` / `unknown_or_possible` |
>
> 于是"没派发、但可能有副作用"（懒加载 `init()` 跑到一半抛错）第一次可以被如实表达：
> `dispatched:false` + `side_effect:'unknown_or_possible'`。
> **不为了这个个案扩大 `state` 的公开枚举** —— 三态合同一个字没改。

### 3.4 归类规则：先查表，再按前缀/所有者推断

不给 69 个码逐个手写映射（会漏、会过时）。规则是：

1. **显式表优先**：`CAPABILITY_CODE_CATEGORY` 里写了的，用表。
2. **有前缀的按前缀**：`receipt_*` → `security`（回执越权）/ `resource`（回执不存在另判）、
   `sandbox_*` → `security`、`workspace_*` → `environment`、`reload_*` → `assembly`、
   `cell_*` → `resource`。
3. **都没有 ⇒ `internal`**，并且**这就是一个信号**：一个说不出类别的码，说明它的
   创建者没想清楚该谁处置。`internal` 是兜底，也是待办清单。

规则 2 与 3 让新 code **不必先改核心**就能有合理类别；同时保留随时覆盖的能力。

> **更正（v0.15.2）**：本节描述的"按前缀推断 + `internal` 兜底"**从未实现**，而且被
> v0.15.1 明确否决（见 §6）：实际实现只有显式表，未登记一律返回 `null`。
> 前缀推断的错处是它按**字符串形状**猜语义 —— `receipt_not_yours` 确实是安全拒绝，
> 但一个叫 `receipt_*` 的新码未必是；猜错的类别比"未归类"更误导。
> 本节保留原文，作为"当时为什么想这么做"的记录。

### 3.5 七类的补全只按**产出点**，不按字符串（v0.15.2）

v0.15.1 接线的七类表漏了三条**本仓真的会产出**的码，实测 `categorizeCode()` 返回 `null`
（专家 0.15.1 复审 §5 P2 指出的正是这个）。v0.15.2 按产出点补齐：

| code | 产出点 | 归类 | 依据 |
|---|---|---|---|
| `lazy_load_failed` | `_lazyFailureFacts()` 的默认码 | `assembly` | 插件 `init()` 失败 = 这套装配不成立 |
| `lazy_load_timeout` | `_awaitLazyLoad()` 等候超时 | `assembly` | 仍在装配；同时进 `INDETERMINATE_CODES` |
| `timeout_no_abort` | `_dispatchCapability()` 等候超时 | `internal` | 码名就是 `no_abort`：没有可证明的 Abort 合同，要改的是我方实现（与 §6 原有判断一致） |

判据：**一条码只在一个地方产生，归类跟着那个地方走**。这样"改了产出点却没改归类"
能被 review 看见；而按前缀猜，永远看不出漏了谁。


## 4. 为什么不做（以及为什么这不算欠账）

### 4.1 不把 69 个 code 合并成 7 个

专家 §8.2 的字面要求可以读成"七类取代细码"。**不采纳这个读法**，理由是本 ADR 的
触发原文本身就否掉了它："保持 code 为稳定细粒度原因"。

更实质的理由：`code` 已经被外部消费——CLI 退出码语义、网关 HTTP 状态映射、
`test/unit` 里 300+ 处 `assertEquals(r.code, ...)`。合并 = 一次性破坏所有断言，
且换来的信息量是**净减少**（"沙箱路径被拒"退化成"安全类错误"）。

### 4.2 不新增 `ErrorManager`

专家 §6 明令禁止"万能 ErrorManager"。本 ADR 只加一个**映射表 + 一个纯函数**
（`categorizeCode(code, owner)`），不引入注册中心、不接管错误构造、不改变任何调用点。

### 4.3 这不是"§8.2 已完成"的另一种说法

§8.2 的意图是"让错误可被程序枚举分类"，本 ADR 满足它。
但**如果 §8.2 的字面要求是"七类取代细码"，那它仍未完成**——本 ADR 明确不改读它的原意。
发布判定文档必须按"意图满足、字面选择另一条路且给出理由"来记，不得写成"已全部完成"。

## 5. 落地方式（分两步）

- **第一步（v0.14.1）**：本 ADR + `categorizeCode()` 纯函数 + 单测。
  **不改任何调用点的返回值**——所有既有信封形状不变。
- **第二步（v0.15.1，已接线一半）**：把 `category` / `result_kind` 接进
  `_failureResult`；`plugins/tool-executor.js` 的拒绝信封**仍未接**。

**更正（v0.15.1）**：上面第一步当时写的是"已做"，但**仓库里从来没有 `categorizeCode()`**。
专家 0.15.0 复审 §4.1 写"category/result_kind 的七类映射仍是部分落地"，比本 ADR 自己诚实。
实际情况是：**决策已定、代码未写**。v0.15.1 补上实现，并在此更正记录。

v0.15.1 的实际改动：
- `src/core/core.js` 新增 `CODE_CATEGORY` 表 + `categorizeCode()` + `resultKindOf()`；
- `_failureResult` 输出两个**加性**字段 `category` / `result_kind`，`code`/`state` 一字不改；
- 未登记的 code 返回 `null`，**不猜**（见 §6 的更正）。

**为什么分两步：** v0.14.1 已经在改锁与场景的判据，专家 §6 的要求是"只做小而关键的修复"。
把 69 个码的归类与那一轮混在一起，会让"五条反例是否修好"这个判断变得难以隔离。

## 6. 诚实的边界

- 到 v0.15.1 为止：**Core 侧已接线，执行器侧未接线**。发布判定里"七类错误未统一枚举"
  这一条从"决策已定、函数未写"变为"**Core 已归一、执行器自产拒绝仍只有 code**"——
  仍然不是完成。**v0.15.2 不变**：本轮只补齐了 Core 侧漏登记的码与 `result_kind` 的边界
  （§3.3 / §3.5），执行器侧一个字没动。
- **v0.15.5（R25-06）已接线，并且改了一条判断口径**：
  `category` / `result_kind` 现在出现在执行器对外信封（`_blockedResponse` / `_failureResult` /
  `_finishExecuteError`）与沙箱超时信封上，**全部加性**（`ok/state/code/error` 一个字节没改）。
  改的口径是：`result_kind: 'denied'` **只给有派发证据的调用**（`dispatched === false`，
  由 Core 或执行器亲眼所见）。修前 `state: 'rejected'` 可以由 `EXECUTOR_REJECTION_CODES`
  查表得出，于是错误码能间接决定"未执行"——这正是专家 0.15.4 复审 §6 R25-06 明令禁止的。
  现在两轴分开：`state` 仍是调用结论（含旧有的 code 表分层），`result_kind` 只回答
  "有没有证据能排除副作用"。两者暂时不统一，**ADR-13（词汇统一）仍未关闭**。
- 七类表的唯一实现在 `src/core/core.js`（`CODE_CATEGORY` + `categorizeCode`），
  v0.15.5 起 `resultKindOf` 也导出给执行器用。**外围不得再抄一份表**
  （`test/unit/test-r25-01-*.test.mjs` R25-06/5 用静态扫描钉住）。
- 类别归属是**判断**，不是事实。任何一个具体码的归类都可以被合理质疑
  （例如 `timeout_no_abort` 归 `internal` 还是 `resource`）。本 ADR 给出的判据是
  "处置方向是否相同"，而非"语义是否贴近"——按这个判据，它归 `internal`
  （超时是因为我们没有可证明的 Abort 合同，要改的是我方实现）。
- **兜底策略在 v0.15.1 反转了**：v0.14.1 写的是"`internal` 兜底，宁可变成垃圾堆"。
  实际接线时发现这个兜底会**撒谎**：插件自定义码（`EXEC_RESULT_NOT_OK`、`HOOK_ERROR`、
  `PROBE-ERROR`…）会被归成"我方代码出错"，把调用方引向错误的方向。
  现在未登记 code 返回 `null`（"未归类"），比一个猜错的类别更可用——
  消费方必须显式处理 `null`，而不能顺手把它当成 `internal`。
