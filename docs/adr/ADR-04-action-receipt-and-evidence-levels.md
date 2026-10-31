# ADR-04：Action Receipt 与验收证据等级

- 状态：**已采纳（v0 为实验性能力）**（v0.9.33）
- 影响面：`plugins/_lib/action-receipt.mjs`、`plugins/tools/tool-write.js`
- 关联：A0、ACT-01～ACT-10、六合 Lite 协作（Track L）

## 1. 要决定的问题

工具返回 `Written 183 bytes to src/main.js` 之后，模型知道"写成功了"，但不知道：

- 改对了位置吗？改了 **多少**？（是不是把 3000 行的文件覆盖成了 30 行）
- 现在磁盘上真的是我写的内容吗？
- 出错了能撤销吗？

六合的版本锚点/预览/journal 提醒我们该看真实差异。但**不是每种动作都可恢复**
（shell、网络、外部数据库、Git 远端都不能通用撤销）。所以要决定的是：
**土行孙该统一到什么程度？**

## 2. 决定

**只统一"如何诚实反馈实际效果"，不统一"如何撤销所有操作"。**

v0 的形态刻意做得极小：

- **只覆盖 `tool-write` 一条受控写入路径**。不声称全工具、不声称全工作区事务化；
- **回执是附加信息，不替换旧输出**。`Written N bytes to path` 的字节保持不变
  （ACT-10 逐个比对三种写入）；
- **不引入任何撤销能力**。`recovery.supported` 恒为 `false`。

## 3. 三个必须分开的轴

这是本 ADR 的核心。三者混在一起是绝大多数"假成功"的来源：

| 轴 | 取值 | 混同的后果 |
|---|---|---|
| `application` | `prepared` / `applied` / `rejected` / `failed` / `indeterminate` | 把"没写"当"写了"，或把"可能写了"当"确定写了" |
| `verification` | `not_run` / 其它（须带 `verification_ref`） | 把"我以为对"当成"验过了" |
| `recovery` | `supported` / `ref` | 承诺一个不存在的撤销能力 |

**关键约束：`application=applied` 不妨碍 `verification=not_run`。** 这是两件事：
"写进去了"是事实，"写得对不对"是另一个判断，需要独立步骤（ACT-09b 专测两轴并存）。

## 4. 事实性约束（本 ADR 的硬要求）

### 4.1 `after_sha256` 只能来自**写后读回**

用 `sha256(content)` 是**意图**的哈希，不是磁盘的哈希。磁盘可能因权限/配额/并发被改写，
也可能根本没写成功。

这条有一个必须承认的判据局限，我把它写在这里而不是藏起来：

> MUT-A0a（把 `after_sha256` 换成 `intended`）在最初 16 条行为用例下**全绿**。
> 因为所有用例都是"写→立刻读回"，两种 hash 在数值上必然相等，**根本不可区分**。
> 要区分只能在 `writeFile` 与 `readBack` 之间插入外部改写（竞态，进程内无法稳定复现），
> 或需要一个会转换内容的挂载点。两条都不该为了凑一个"行为判据"而伪造。
>
> 所以最终用两条判据合起来覆盖：
> - `ACT-01e`（**行为**）：`readBack` 在外部改写后返回当前磁盘 hash ——
>   证明这一层真的读盘，而不是回显写入内容；
> - `ACT-01f`（**结构**）：`after_sha256` 的右值必须是 `after.sha256`，
>   且 `readBack` 位于 `writeFile` 之后。
>
> 单独拿哪一条都不够。这是本项目"结构判据不能证明效果"原则的一次**有意例外**，
> 理由是上面那段：行为判据在这里需要竞态或特殊挂载才能成立。

### 4.2 `before_sha256` 取不到就填 `null`

文件此前不存在 ⇒ `before_sha256: null` + `created: true`。
**不得**用空串的 hash 或"我要写的内容"反推 —— 那是伪造（ACT-01c 专测）。

### 4.3 `changed_bytes` 拿不到就不写

`summarizeReceipt` 只在有具体数字时才报字节数。**不生成推测值**（ACT-09 / A0/R4）。

### 4.4 持久化状态必须如实

| 值 | 含义 |
|---|---|
| `persisted` | 真的落盘了 |
| `volatile` | 只在内存/返回值里，进程结束即消失 |
| `failed` | 尝试持久化但失败 |
| `unknown` | 不知道 |

v0 **恒为 `volatile`** —— 回执只随返回值返回，不落盘。标 `persisted` 会让调用方
以为审计永久可靠（ACT-05 专测）。

## 5. 与"动作回执不替代判断"的关系

计划书 §2 的分工必须守住：

```
事前：Cell 资格 / 能力门 / 捆仙索 / 沙箱 ──► 决定"能不能执行"
事后：Action Receipt ──────────────────► 说明"实际发生了什么"
验收：独立验收器（Cell 的 verify）────────► 判断"是否符合意图"
```

**三者不可互相替代**：

- 回执不能代替事前阻止。`recovery.supported: true` 也不能替代 S1/S2 的执行前拦阻
  ——"LLM 可以通过回执发现并撤销"不是安全机制，是事后补救；
- 回执不能代替验收。`application=applied` 只说明写入发生了，不说明业务目标达成
  （`execution_state=succeeded` 也不等于验收通过）。

## 6. 保护模式是未来的约束，不是 v0 的隐性承诺

如果将来明确开启"protected edit mode"，必须确保该 Cell 的同类文件写入不会从
`tool-write`、`tool-bash`、任意命令、别名、外部 MCP 等旁路绕开受控事务。

**做不到时不得宣称该模式覆盖所有写入。** v0 只称"带动作回执的文件写入"，
**不**称"全工作区事务化保护"。

## 7. 后果

**变好的**：

- 写操作第一次有了"可核对的磁盘事实"（hash 来自读回）；
- "写对了没"与"写成功了"在类型上分开了，模型不会被 `Written N bytes` 误导；
- 不可撤销被明说，而不是让读者默认可以撤销。

**变差的**：

- `tool-write` 每次多做两次磁盘读（before/after 各一次）。这是可知的固定开销，
  对文件工具可接受；
- ~~回执目前只挂在实例的 `_lastReceipt` 上，**没有**经执行器透出给模型。~~
  **已在 v0.10.0 改为经执行器透出**（一句话摘要附在工具输出之后）。
  但注意：v0.10.0～v0.10.2 的那条通道**读的是工具实例的"最近一次回执"**，
  单例 + 并发 ⇒ 两个会话可能拿到同一份回执（AR-C01）。
  **v0.10.3 起改为按调用绑定**（`plugins/_lib/call-context.mjs` 的 `AsyncLocalStorage`），
  实例字段只剩 `_directCallReceipt`，仅服务"绕过执行器直调 `execute()`"的测试/脚本，
  执行器从不读它。见 §9。

**仍然没做的（明确实验性）**：

- 并发写的 `stale/conflict` 判定（ACT-04 未实现：当前只在"读回内容与意图不符"时标
  `indeterminate`，没有版本锚点，做不到真正的冲突检测）；
- 详情按需展开：`action.inspect` 能力**已存在且已按调用作用域收口**（v0.10.3），
  但**模型够不着** —— 它不在模型可见工具表里，且 `action.inspect` 这个名字不满足
  `tool-<x> → tool.<x>` 的派生约定，执行器解析不出对应能力，会落到 legacy 直连被拒。
  净效果：回执附注里那句"（明细：action.inspect act-xxx）"**当前兑现不了**
  （AR-C04，锁在 `test-ar-c01-c02-...` 里，计划 v0.11.0 修）。`detail_ref` 仍恒为 `null`；
- 授权 Cell / 任务权限与回执的关联：`cell_id` / `task_id` / `incarnation_id` 字段已留，
  但 v0.10.3 起**不再从 `args._cellId` 取**（那是模型能填的字段，AR-C03），
  当前如实填 `null`；要填真值得先把 Cell 的 incarnation/task 钉进可信调用上下文。

## 8. 与六合 Lite 的边界（Track L）

| 归属 | 内容 |
|---|---|
| 六合 | 版本锚点、预览、精确提交、冲突拒绝、条件 Undo、journal |
| 土行孙 | Cell 工作区/权限/生命周期、Action Receipt 映射、`request_id` 关联 |
| 双方 | 冻结最小回执字段、路径与身份引用、版本与恢复状态映射 |

**不复制六合的事务引擎**。土行孙不做"自己写一套 write-journal"——那正是要避免的重复。

## 9. 如何验证

```bash
node test/run-one.mjs test/unit/test-a0-action-receipt.test.mjs   # 18 条
```

| 变异 | 打红 |
|---|---|
| `after_sha256` ← `intended`（意图冒充事实） | ACT-01f |
| `applied` 不校验缺 `after_sha256` | A0/R1 |
| `recovery.supported` 谎称 true | ACT-01 系列 + ACT-08 |
| 伪造 `before_sha256` | ACT-01c |
