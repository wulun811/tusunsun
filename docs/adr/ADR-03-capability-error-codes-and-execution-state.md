# ADR-03：能力错误码与执行状态的对应关系

- 状态：**已采纳**（v0.9.33）
- 影响面：`src/core/core.js`（`CAPABILITY_CODE_STATE`）、`plugins/tool-executor.js`（`EXECUTOR_REJECTION_CODES`）
- 关联：R0-76、R0-95、R0-131、R0-135、R0-136、R0-140、S3、A0

## 1. 要决定的问题

同一个 `code` 在两个入口被判成了不同的 `state`。具体：`capability_not_found` 在
core 侧映射为 `failed`，在执行器侧映射为 `rejected`。这会怎样，该以哪边为准？

## 2. 先把语义钉死

三种状态**不是程度差别，是三种不同的事实**：

| state | 事实 | 上层应该做什么 |
|---|---|---|
| `rejected` | **从未执行**。没有任何副作用可能发生 | 修条件（权限/装配/路径），不要重试 |
| `failed` | **执行了，没成功**。副作用可能有，也可能没有 | 看具体 code 再决定；不要无脑重试 |
| `unknown` | **执行到哪不知道**。副作用可能仍在发生 | **不能假设任何事**；先核对再决定 |

把 `rejected` 记成 `failed` 的后果：上层会重试一个必然再被拒的调用（浪费且污染日志）。
把 `failed` 记成 `rejected` 的后果更糟：上层会以为"没发生副作用"，而实际可能已经写了盘。
把 `unknown` 记成 `failed` 后果最糟：会重试一个**可能已经产生副作用**的操作（S3 修的就是这个）。

## 3. 决定

### 3.1 每个 code 的归属

`src/core/core.js` 的 `CAPABILITY_CODE_STATE`：

| code | state | 依据 |
|---|---|---|
| `capability_denied` | denied | 权限/身份判据拒绝，从未执行 |
| `capability_frozen` | denied | 冻结 = 停止服务，从未执行 |
| `out_of_bounds` | denied | 路径越界，从未执行 |
| `invalid_session_id` | denied | 信任边界拒绝（R0-114），从未执行 |
| `capability_not_found` | **failed** | 见 3.2 |
| `invalid_input` | failed | 参数/schema 违规 |
| `resource_error` | failed | 执行中遇到资源故障 |
| `handler_threw` | failed | handler 抛错 |
| `timeout_no_abort` | failed | 超时竞速返回，**副作用未撤销** |

`plugins/tool-executor.js` 的 `EXECUTOR_REJECTION_CODES` 把
`capability_denied / permission_denied / scope_denied / identity_required / blocked /
rate_limited / execution_revoked / HOOK_ERROR / HOOK_BLOCKED / capability_frozen` 归 `rejected`。

### 3.2 `capability_not_found` 的分歧（v0.9.33 登记，v0.10.0 **已消解**）

> **更新（v0.10.0）**：下面这段是 v0.9.33 写的"保留分歧"，已被推翻。
> 推翻它的不是我改变了主意，而是发现**它们本来就是两件事**：
>
> | 情形 | 含义 | 归属 |
> |---|---|---|
> | 该有的能力装配后没有 | 装配缺陷 | `capability_not_found` → `failed` |
> | 这个工具名没有能力承载 | 请求无效 | `tool_not_registered` → `denied` |
>
> 于是不需要"选一边"，也不需要破坏任何公共 API —— 只需**新增**一个 code。
> 同一个 code 两个 state 的分歧从根上消失。
>
> 保留下面的原文，因为它记录了当时的推理，也记录了它的错：我把"分类冲突"
> 当成了"语义冲突"，而实际上是**两个不同的语义被挤进了一个 code**。
> 这个区分值得记住 —— 下次遇到"同一个 code 两个 state"，先问是不是**两件事**。

<details>
<summary>v0.9.33 原文（已被推翻，保留以记录推理过程）</summary>


**这是本 ADR 唯一没有消掉的分歧，必须写清理由。**

- **core 侧**的 `capability_not_found` 来自 `callCapability` 找不到能力 —— 对一个
  已经装配完成的系统，这是**装配缺陷**，属于"该有却没有"，所以归 `failed`。
- **执行器侧**的 `capability_not_found` 来自"这个工具名没注册成能力" —— 对调用方，
  这是"你调错了名字/该工具没启用"，属于**请求无效**，所以归 `rejected`。

两种解读各自在自己的入口上是对的，而它们对**同一个 code** 给出不同 state，
确实违反了"同一 code 必须映射到同一 state"这条原则（R0-136 已用这条原则修过
`capability_frozen` 的分歧）。

**决定**：本轮**不统一**，理由是 —— 统一必须选一边，而两边都有各自的正确性；
选错会把一类真实情形归错。这需要一次独立的设计决定（可能要引入两个 code：
`capability_not_found` 与 `tool_not_registered`），不是顺手能改的。

**约束**：两侧都已有锁定测试，且都写了注释说明为什么这样分类。也就是说当前状态是
**"有分歧、有注释、无决策记录"** —— 本 ADR 就是那份决策记录，结论是
**"承认分歧，登记为待决"**，而不是假装它不存在。

> 送审报告 §1.4 已经点出这一条。如果评审意见认为应当立刻拆成两个 code，那是
> 一次公共 API 变更，需要单独的兼容性评估。

</details>

**v0.10.0 的实际处置**：确实拆成了两个 code（`capability_not_found` +
`tool_not_registered`）。兼容性影响评估：

- `capability_not_found` **没有消失**，只是不再由执行器的"工具未注册"分支产生。
  任何按 `capability_not_found` 做处理的调用方，对"装配缺陷"场景行为不变；
- 新增的 `tool_not_registered` 归 `denied`。原先该分支报 `capability_not_found`
  且被 `EXECUTOR_REJECTION_CODES` 归为 `rejected` —— **state 没变**，
  只有 code 变了。所以按 `state` 决策的上层**零影响**，按 `code` 决策的需要加一条。
- 判据：`A0` 测试文件的 `ADR03/a`～`ADR03/c` 三条。

### 3.3 `unknown` 是一个正式的第三态

v0.9.33 之前 `unknown` 只在 Cell 的 `execution_state` 里出现过（撤销/超时时用）。
现在它也是**工具执行结果**的 state：

```js
{ ok: false, code: 'sandbox_timeout_indeterminate', state: 'unknown',
  request_state: 'timed_out', execution_state: 'unknown_or_running',
  execution_may_continue: true, terminated_confirmed: false }
```

**约束**：`state: 'unknown'` 不允许被上层当成 `failed` 处理。判据 `S3/d` 专测这一条：
把 `state` 改成 `failed` 就打红。

## 4. 相关的另一条：`ok === (state === 'succeeded')`

执行器有明确合同：成功回载荷，失败/拒绝**必须**带码上抛。`ok` 不得与 `state` 自相矛盾。
这条合同在 R0-95 建立，本轮所有新分支都遵守（`_maybeSandbox` 的失败返回也带 `state`）。

## 5. 后果

**变好的**：

- `unknown` 成为正式第三态，超时不再被误当"失败且无副作用"；
- 每个 code 的归属都有依据表格，不再靠读代码猜；
- `capability_not_found` 的分歧从"没人知道"变成"登记在案"。

**仍然没解决的**：

- `capability_not_found` 的双侧分歧（见 3.2）；
- 跨进程的冻结：`freezeCapability` 只在进程内生效，跨进程仍是 `unknown`。

## 6. 如何验证

```bash
node test/run-one.mjs test/unit/test-r0-76-thin-task-result-contract.test.mjs    # 9 条
node test/run-one.mjs test/unit/test-r0-136-to-140-cache-freeze-sandbox-coverage.test.mjs
node test/run-one.mjs test/unit/test-s1-s2-s3-execution-boundary.test.mjs
```

关键判据：

- `R0-140/a`：路径越界，执行器与 core 必须给同一个 state；
- `R0-76/④1`：`cancelled` 是保留类型，超时必须归 `failed/timeout_no_abort`，不得冒充 cancelled；
- `S3/d`：超时必须透传 `state: 'unknown'` 与两个轴，不得压成 `failed`。
