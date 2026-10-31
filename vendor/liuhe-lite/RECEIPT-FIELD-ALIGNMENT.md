# 回执逐字段对齐清单（`tusunsun.action-receipt/v0`）

用途：这份表是给土行孙 schema 负责人**逐字段签字确认**的。左边是我方实际产出，右边是需你们确认的口径。

> 原则：**只映射真实存在的字段；拿不到就写「不提供」，不编造。** 你们若改动字段名/枚举/格式，请直接在这份表上批注，我按批注改。

---

## 1. 字段清单

| 字段 | 我方取值 / 来源 | 我方保证 | 请你们确认 |
|---|---|---|---|
| `schema_version` | 恒为 `"tusunsun.action-receipt/v0"` | 不变 | ☐ 版本号字面是否正确 |
| `action_id` | `"act-" + 六合事务号`（如 `act-txn_1792..._p4089310`） | 全局唯一、可用于 `inspect` / `reconcile` | ☐ 这个形态能否当你们的主键 |
| `provider` | 恒为 `"liuhe-lite"` | 不变 | ☐ 是否要用别的标识 |
| `provider_operation_id` | 六合事务号（不带 `act-` 前缀） | 与 `action_id` 同源可反查 | ☐ 是否需要独立 ID |
| `cell_id` | 建适配器时宿主给的值，没给则 `null` | 透传，不改 | ☐ 字段名/语义 |
| `incarnation_id` | 同上 | 透传 | ☐ 同上 |
| `task_id` | 同上 | 透传 | ☐ 同上 |
| `request_id` | Cell 传入的幂等键原值 | 与幂等账本一致 | ☐ 命名（你们叫 `request_id` 还是 `idempotency_key`） |
| `application` | 见 §2 枚举 | 只描述“对外该怎么说” | ☐ 枚举集是否齐全 |
| `effect.kind` | 见 §3 枚举 | 只在确实落地时非 `none` | ☐ 枚举集 / `none` 语义 |
| `effect.target` | **工作区相对路径**（永不绝对） | 不泄露宿主路径 | ☐ 你们能否接受相对路径 |
| `effect.before_sha256` | 写前内容 sha256；新文件为 `null` | 与当时磁盘字节一致 | ☐ 新文件用 `null` 是否正确 |
| `effect.after_sha256` | 写后内容 sha256（**实回读**，不是预期值） | 与磁盘一致；不一致则 `indeterminate` | ☐ — |
| `effect.detail_ref` | 如 `liuhe:txn_...`，供二次查详情 | 可定位到日记 | ☐ 是否要换成你们的 URI 形 |
| `verification` | **恒为 `"not_run"`** | 绝不代填 `verified` | ☐ 你们回填时用哪些取值（`verified`/`failed`/`skipped`？） |
| `recovery.supported` | 成功写入后 `true`（有日记），否则 `false` | 只承诺能佐证的 | ☐ — |
| `recovery.ref` | `liuhe-undo:<txn_id>`（可直接回传 `undo.recoveryRef`；不是授权票据） | 能直接回传 `undo` | ☐ 引用形式是否合适 |
| `persistence` | 见 §4 枚举 | 如实反映证据是否落盘 | ☐ 枚举命名 |
| `extension` | 仅在有额外事实时出现：`journal_state`（内部原值）、`reason`（对账原因） | 不对抗 `application`，是补充 | ☐ 是否允许你们不认识的键；需否白名单 |

---

## 2. `application` 枚举

| 值 | 含义 | 何时出现 |
|---|---|---|
| `prepared` | 已备好但未提交 | 预演路径（当前未对外使用） |
| `applied` | 确实已落地到磁盘 | apply / undo 成功 |
| `rejected` | 前置条件不满足，**未落地** | 锚点冲突、越界、参数非法 |
| `failed` | 尝试了但失败，**未落地** | 原子写失败等 |
| `indeterminate` | **不确定是否落地** | 回读不一致、超时、请求未收口 |
| `not_applied` | 有证据证明**当前效果不存在** | reconcile 后发现已撤销 |
| `needs_review` | 有证据但需人工判定 | 三方 hash 不足以定性 |

> 关键：`rejected`/`failed` 与 `indeterminate` **绝不混用**——前者代表“确定没发生”，后者代表“不知道”。

---

## 3. `effect.kind` 枚举

`file_created` / `file_modified` / `file_restored`（undo 回旧版）/ `file_deleted` / `none`

当前 Lite 只做创建与替换，故实际只会出现 `file_created` / `file_modified` / `file_restored` / `none`；`file_deleted` 保留未用。

---

## 4. `persistence` 枚举

| 值 | 含义 |
|---|---|
| `persisted` | 日记 + 回执已落盘（Undo 可信） |
| `memory_only` | 动作发生了但证据没落盘（**不能承诺 Undo**） |
| `failed` | 证据落盘失败 |
| `unknown` | 读不出证据 |

---

## 5. 需你们确认的 6 件事（勾完这张表就算对齐）

1. ☐ `schema_version` 字面 `tusunsun.action-receipt/v0` 是否就是你们要的版本串。
2. ☐ `action_id` = `act-<事务号>` 能否直接当你们的主键；若不能，要什么形态。
3. ☐ `request_id` 字段名与你们的幂等键命名是否一致。
4. ☐ `effect.target` **只给工作区相对路径**是否可接受（我们不泄露宿主绝对路径）。
5. ☐ 你们回填 `verification` 时用哪几个取值（我只保证自己永远不填 `verified`）。
6. ☐ `extension` 里允许出现你们未登记的键吗（当前只有 `journal_state` / `reason`）。

---

## 6. 我们明确不提供的字段

（与 [ACTION-RECEIPT-MAPPING.md](./ACTION-RECEIPT-MAPPING.md) 第 4 节一致，此处只列要点）

- `verification: "verified"` —— 我们不跑代码检查/测试，写入成功 ≠ 语义正确
- 绝对路径 —— 回执不泄露宿主私有路径
- 日志正文 / 备份内容 —— 回执不塞上下文；需要时用 `inspect`（也只给 hash 与元数据）
- 时间戳 —— v0 公共字段无此位；内部 `created_at`/`committed_at` 不强行映射
- 跨文件 / 跨工作区影响 —— 单文件、单工作区作用域
- 授权结论（“Cell 有没有权做这件事”）—— 那是你们的授权真值，我们不代判

---

## 7. 一份真实回执（apply 成功，字段已脱敏）

```json
{
  "schema_version": "tusunsun.action-receipt/v0",
  "action_id": "act-txn_1792648625411_350fb5a4_p4089310",
  "provider": "liuhe-lite",
  "provider_operation_id": "txn_1792648625411_350fb5a4_p4089310",
  "cell_id": "accept-cell",
  "incarnation_id": "inc-accept",
  "task_id": "acceptance",
  "request_id": "accept-apply-1792663741691",
  "application": "applied",
  "effect": {
    "kind": "file_modified",
    "target": "target.txt",
    "before_sha256": "<sha256 of v1>",
    "after_sha256": "<sha256 of v2>",
    "detail_ref": "liuhe:txn_1792648625411_350fb5a4_p4089310"
  },
  "verification": "not_run",
  "recovery": { "supported": true, "ref": "liuhe-undo:txn_1792648625411_350fb5a4_p4089310" },
  "persistence": "persisted"
}
```

> 上面这份是 `tests/cell-acceptance.mjs` 的 C05/C06 两条验收项真实核对过的形状（字段齐全 + 与磁盘 hash 一致）。

---

## 附录：跨实现 Action Receipt v1 映射提案（六合侧输入，待土行孙牵头冻结）

依据《土行孙 v0.10.2 独立专家裁决》D-2。**不原地改义 v0**：

- 已发布的 `tusunsun.action-receipt/v0` 继续当真值读；跨 provider 比较/汇总时用 v1。
- v1 字段一旦冻结，两边各自提供「v0 → v1」薄映射器；不在 v0 里新造同名异义字段。

### 语义解释权归属（六合侧声明）

| 语义 | 解释权在谁 | 说明 |
|---|---|---|
| 事务是否提交、是否被撤销、回滚净效果 | **六合（provider）** | 以日记 `state` + 前/后 hash 三方判据为准，宿主不得重算替代 |
| Cell 身份 / 能力授权 / 任务归属 | **土行孙（宿主）** | Lite 只原样携带 `cell_id` / `incarnation_id` / `task_id`，不解释 |
| 归一化后的公共字段形状 | **双方共同冻结** | 本文提议形如：`tusunsun.action-receipt/v1` |

### 建议的 v1 公共形状（六合侧不改义提案）

```jsonc
{
  "schema_version": "tusunsun.action-receipt/v1",
  "action_id": "act-txn_...",            // 宿主动作号；不跨 provider 复用
  "provider": "liuhe-lite",
  "provider_operation_id": "txn_...",   // provider 自己的事务号；≠ action_id
  "cell_id": "...", "incarnation_id": "...", "task_id": "...",
  "request_id": "...",                  // **仅关联/去重提示**；没有账本的一方不得声称幂等
  "idempotency_key": "...",             // 可选：有账本的一方才能填（Lite 填，土行孙未建账本前留空）
  "application": "applied",             // applied | not_applied | needs_review | indeterminate | failed | rejected
  "target": { "scope": "cell_workspace", "path": "src/a.ts" },
  "effect": { "kind": "file_modified", "before_sha256": "...", "after_sha256": "..." },
  "verification": "not_run",             // 独立于“写成功”：跑没跑检查是另一件事
  "persistence": "persisted",            // persisted | volatile | failed | unknown
  "recovery": { "supported": true, "ref": "liuhe-undo:txn_...", "expires_at": "..." },
  "history": { "committed_at": "...", "undone_at": "...", "reconcile_reason": "..." },
  "extension": { "provider_persistence": "memory_only" }   // 有界、不参与授权
}
```

### Lite 现有 v0 → v1 逐字段映射

| v0（Lite 现在发的） | v1 | 说明 |
|---|---|---|
| `effect.target: "src/a.ts"` | `target: { scope: "cell_workspace", path: "src/a.ts" }` | 绝对路径不进模型默认回执；范围只能是宿主授权的工作区 |
| `persistence: "memory_only"` | `persistence: "volatile"`（原值留 `extension.provider_persistence`） | 不在 v0 里改名，只在 v1 归一 |
| `application: "not_applied"` + `extension.journal_state` | `application: "not_applied"` + `history.reconcile_reason` / `history.undone_at` | **“从未提交”与“提交后撤销”必须可区分**：只写 `not_applied` 不算说清 |
| `request_id`（Lite 同时当幂等键用） | `request_id` + `idempotency_key` | Lite 的账本真在强制去重（`REQUEST_CONFLICT` / 幂等复读），所以两边同值；无账本方留空 |
| `recovery.ref: "liuhe-undo:txn_..."` | 同左 | **是后续操作引用，不是“持有即可撤销”的票据**：撤销仍验所有权（`FOREIGN_JOURNAL`）+ 文件未被后续修改 |
| `verification: "not_run"` | 同左 | 事务成功 ≠ 独立验收成功 |
| `extension.*` | 同名字段保留 | 会进回执，但**不进系统提示词、不改 Cell 权限、不当作独立验收证据** |

### 六合侧待确认（留给土行孙勾选）

1. `target.scope` 取值是否只允许 `cell_workspace`（建议只允许这一个）。
2. `history` 是否作为 v1 必填（六合倾向必填：否则无法区分未提交 vs 已撤销）。**→ 土行孙已答：必填（2026-10-23，B-3）。六合确认，且 history 至少含 `committed_at` / `undone_at` / `reconcile_reason` 三项。**
3. `idempotency_key` 是否入 v1（六合有账本，建议有；不要求土行孙现在就有）。
4. `persistence` 归一值是否就用 `volatile`（而非 `memory_only`）。**→ 土行孙已接受归一方案（B-2）：v1 取值集合 `persisted | volatile | failed | unknown`，`memory_only` 只作为 `extension.provider_persistence` 原值出现；v0 各留各的，不改义。**
5. `extension` 的字段白名单（六合当前会放：`journal_state` / `reason` / `undo_status` / `files` / `provider_persistence`）。
6. `action_id` 与 `provider_operation_id` 是否允许出现在同一个回执里（六合认为必须允许，但不得互相冒充）。

---

## 冻结记录（2026-10-23，对土行孙 v0.11.0 核对结论的答复）

**B-1 两个枚举语义（六合确认，与土行孙理解一致）**：
- `not_applied` = 有证据证明当前净效果不存在——含「从未落地」与「落地后被撤销」两种，靠 `history`（见 B-3）区分，不靠猜。
- `needs_review` = 证据不足以定性（磁盘处于第三态，既非动作前也非动作后版本），必须人工判。
- 两值在六合侧语义固定；土行孙 v0.11.0 已补枚举，双方口径一致，v1 冻结前无分歧。

**B-2 persistence（已冻结）**：v1 归一 `persisted | volatile | failed | unknown`；`memory_only` 只在 `extension.provider_persistence` 保留原值。v0 不改义。

**B-3 history（已冻结）**：v1 必填，至少含 `committed_at` / `undone_at` / `reconcile_reason`。

**B-4 语义解释权（补齐土行孙要的那一行）**：

| 语义 | 解释权 |
|---|---|
| 事务是否提交/被撤销、回滚净效果 | 六合（provider） |
| Cell 身份 / 能力授权 / 任务归属 | 土行孙（宿主） |
| **「这条回执该不该给模型看」（披露权）** | **土行孙（宿主）**——即使 provider 说回执为真，能否披露由宿主判；土行孙 v0.11.0 的会话隔离（receipt_not_yours）与执行资格（receipt_cell_closed/faulted/unknown）就是这层的实现 |
| 归一化后的公共字段形状 | 双方共同冻结 |

**B-5 嵌入形态三问**：见 `INTEGRATION-GUIDE.md` §11（进程内 import 是支持形态；账本按 `wsHash+requestHash` 隔离，共用 `MALONG_STATE_DIR` 不串；`cell_id/incarnation_id/task_id` 原样透传进回执，不参与任何判定）。
