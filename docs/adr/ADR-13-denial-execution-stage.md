# ADR-13：拒绝码的**执行阶段**分层，而非按 code 字符串推断

- 状态：**已采纳并接线**（v0.15.0）
- 日期：2026-10-23
- 触发：专家 0.14.1-post 复审的反例 **INV-01**（本轮独立复现成立）
- 相关：ADR-11（错误分类加性字段）、ADR-03（code 归属单一化）、`core-transition-contracts.md`

---

## 1 问题：一条返回值把时间线讲反了

反例 INV-01（本轮实测，非推理）：

```
handler 先 writeFile(marker)，再 throw err.code = 'capability_denied'
⇒ 返回值 state = 'denied'
⇒ 而 marker 文件真实存在
```

按 ADR-11 的定义，`denied` 表示「**没执行**，确定没有副作用」。上面这条返回说的是"我从没开始过"，而事实是"我做完了，下游拒绝了"。

根因不在错误处理，在**判据的来源**：

```js
// 修前 core.js
const state = CAPABILITY_CODE_STATE[code] || 'failed';
```

它用**异常里的字符串**推断**执行阶段**。字符串是下游写的，下游没有义务（也没有能力）知道调用方的时间线。

这与 Cell 那边已经修过的 `resolveAfterRestart` 是同一条纪律：
**状态必须由可证明的事实决定，不能由相似性决定。**

---

## 2 裁决：三层优先级，不是一刀切

最容易犯的错是把修复做成"凡是进了 handler 就不许 denied"。我第一版就是这么写的，结果 **R0-76/②1 立刻变红**——那条用例要求 `tool.read` 越界返回 `state:'denied'`。

查了代码才明白为什么它是对的：

```js
// plugins/tools/tool-read.js
const fullPath = await resolveWorkspacePath(workDir, path);   // :48  边界检查
const content = await readFile(fullPath, 'utf8');             // :55  才碰资源
```

越界时**第 55 行从未执行**，副作用确定为零。这里 denied 是准确的事实。

所以判据的落点不是"代码跑没跑到 handler"，而是：

> **这个 code 的合同，是否保证它在副作用发生之前？**

### 三层优先级（专家 §5.1 的 T-02 正是这条）

| 层级 | 判据 | 结果 |
| --- | --- | --- |
| ① 阶段事实 | 调用方明确传 `dispatched === false` | 按 code 归类（此时 code 是唯一线索） |
| ② 该码的合同保证 | code ∈ `PRE_EFFECT_DENIAL_CODES` | 保持 `denied` |
| ③ 其余拒绝型码 + 已进入 handler | — | 降级 `failed` + 加性字段标注 `post_dispatch` |

`PRE_EFFECT_DENIAL_CODES` 目前四项，每一项都附理由：

| code | 为什么保证在副作用之前 |
| --- | --- |
| `out_of_bounds` | 路径/工作区边界，先解析再动资源（tool-read.js:48 < :55） |
| `capability_frozen` | 能力被冻结，检查在 handler 调用之前 |
| `tool_not_registered` | 名字不存在，无从执行 |
| `invalid_session_id` | 会话标识非法，信任边界拒绝 |

**`capability_denied` 刻意不在表里**：它的来源不唯一，最常见的正是"下游服务说我不接这个活"，而那时副作用可能已经发生。INV-01 抓的就是它。

---

## 3 API 影响清单（专家 §P1.2 明确要求）

| 返回字段 | 修前 | 修后 | 影响面 |
| --- | --- | --- | --- |
| `state` | `capability_denied` 在 handler 抛错时 = `denied` | = `failed` | **行为变更**，见下 |
| `code` | `capability_denied` | **不变** | 无 |
| `error` / `payload` / `evidence` | — | **不变** | 无 |
| `dispatched` | 不存在 | 新增，`true`（仅在降级时出现） | 加性 |
| `result_kind` | 不存在 | 新增 `'failed'`（仅在降级时出现） | 加性 |
| `execution_stage` | 不存在 | 新增 `'post_dispatch'`（仅在降级时出现） | 加性 |

### 谁可能受影响

`state === 'denied'` 的**唯一**语义变化范围：**handler 内抛出 `capability_denied` 且副作用可能已发生**这一种情形。

- 框架级鉴权拒绝（`_invocationContext` 返回 not ok）→ 走 `_denyCapability`，**不走这条路径**，仍是 `denied`。已验证：INV-02 与 R0-76/②2 都绿。
- 资源边界拒绝（`out_of_bounds` 等四项）→ 仍在白名单，仍是 `denied`。已验证：INV-02b 与 R0-76/②1 都绿。
- 下游抛 `capability_denied` 且**确实没有副作用**：现在会报 `failed`。这是**有意的保守**——系统无法证明没有副作用，就不该声称"从未执行"。调用方若需要精确判断，读新增的 `code`（原始原因保留）。

### 为什么不加一个"我相信下游"的开关

那会让每个调用点自己决定说不说实话，违反"一个事实一个权威来源"。原始 `code` 已经保留了全部下游信息，`state` 只负责表达**执行阶段**这一个事实。

---

## 4 反向判据（防止过度修复）

修复本身的风险是"矫枉过正"：把所有 denied 打成一类，于是真正零副作用的拒绝被误报成失败。

因此 v0.15.0 **成对**落了两条判据：

| 判据 | 断言 | 防的是什么 |
| --- | --- | --- |
| INV-01 | 已产生副作用 + 抛 `capability_denied` ⇒ **不得** `denied` | 把执行后说成执行前 |
| INV-02b | 抛出 `out_of_bounds`（合同保证副作用前）⇒ **必须** `denied` | 把零副作用拒绝误降为 failed |
| INV-02 | 真正 pre-dispatch 无权调用 ⇒ `denied` 且 handler 运行 0 次 | 把鉴权拒绝也降级 |

**变异验证**：M28（令 `downgraded = false`）→ INV-01 变红、INV-02b 仍绿；反向变异（令白名单为空集）→ INV-02b 变红、INV-01 仍绿。两个方向都能被抓到，说明判据没有退化成"永远返回同一个值"。

### 4.1 更正：INV-02b 这条反向判据本身是错的（v0.15.1，ERR-015）

专家 0.15.0 复审 §3 P1 用一条更狠的反例推翻了三层里的第二层：

> 自定义 handler 先在临时目录写标记文件，再 `throw Object.assign(new Error('x'),
> { code: 'out_of_bounds' })` —— 四个白名单码**全部**得到 `state:'denied'`，而文件真的存在。

**我的错在哪**：我把"这个 code 的合同保证它在副作用之前"当成了 Core 可以使用的证据。
可 `err.code` 是任意插件都能赋的值，Core 手上没有任何机制能证明"这个字符串来自那条前置检查"。
INV-02b 那条判据等于要求 Core **相信插件自报的执行阶段** —— 而它恰恰是我在同一份 ADR 里
写"状态由可证明的事实决定，不由字符串相似性决定"时要反对的东西。

**撤销**：`PRE_EFFECT_DENIAL_CODES` 白名单整个删除。现在的判据只剩"**谁能证明**"：

| 情形 | `dispatched` | `state` | `side_effect` |
| --- | --- | --- | --- |
| Core 在 dispatch 之前拒绝（`_denyCapability` / `_frozen` 早退） | `false` | `denied` | `none` |
| handler 跑过并抛出任何拒绝型 code | `true` | `failed`（原 code 保留） | `unknown_or_possible` |

**代价（如实）**：内置工具 `tool.read` 越界从 `denied` 变成 `failed`，尽管它确实没碰资源。
"工具层零副作用"这个事实**没有丢**，只是改由工具自己的测试断言（R0-76/②1 仍断言越界写不落盘、
越界读不回内容），不再由 Core 的 `state` 背书。这是专家 §3 的"保守方案"，也是唯一诚实的方案：
Core 只能承诺它亲眼见过的事。

**执行器同步**（同一类接缝的下游）：`plugins/tool-executor.js` 此前把 Core 的 `code` 搬走、
丢掉 `dispatched`/`side_effect`，再拿 code 查自己的 `EXECUTOR_REJECTION_CODES` 重新猜阶段。
现在证据随错误一起传递，`state` 判据是 `dispatched === false ? 'rejected' : 'failed'`，
只有**执行器自己产生**的错误（它亲眼所见发生在派发之前）才回落到 code 表。
`out_of_bounds` / `invalid_session_id` 因此从那张表里删除 —— 它们没有可信的证明者。

---

## 5 未做的事（如实记录）

- `plugins/tool-executor.js` 的失败**词表**仍是 `rejected` / `failed`，与 Core 的 `denied` / `failed`
  不是同一枚举（**有意**：`rejected` 是给 LLM 看的"别重试"）。v0.15.1 只统一了**证据传递**，
  没有统一词表；专家 §P1.5 要求的"在明确的适配边界完成映射"仍是一个待办。
- `category` 七类映射已在 v0.15.1 接进 `_failureResult`（见 ADR-11 §5），
  但 `plugins/tool-executor.js` 的拒绝信封**仍未带 `category`**。
- `result_kind: 'indeterminate'` 的判据是 `timeout_no_abort` / `drain_timeout` /
  `execution_outcome:'unknown'` 三处，均由 `resultKindOf()` 统一给出。
