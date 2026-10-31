# 动作回执映射表 — 六合 Lite → 土行孙 Action Receipt v0

> 交付清单第 5 项。规则：**只映射真实存在的字段；无法提供的明说「不提供」，不编造。**
> Lite 不改造六合内部状态机，只在外层附带可关联的公共字段。

## 1. 公共字段映射

| Action Receipt v0 字段 | Lite 实际来源（六合字段 / 来源文件） | 语义 | 可提供 |
|---|---|---|---|
| `schema_version` | 常量 `tusunsun.action-receipt/v0`（`lite/receipt.js`） | 合同版本 | ✅ |
| `action_id` | `act-<txn_id>`（Lite 生成，可直接被 `inspect`/`reconcile` 寻址） | 动作标识 | ✅ |
| `provider` | 常量 `liuhe-lite` | 提供方 | ✅ |
| `provider_operation_id` | 六合事务号 `txn_id`（`write-journal.js::createJournal` 返回） | 六合侧操作标识 | ✅ |
| `cell_id` | 宿主注入 `cell.cellId`（`createLiteEditor({cell})`） | 土行孙 Cell 身份 | ✅（**宿主提供，Lite 不猜**） |
| `incarnation_id` | 宿主注入 `cell.incarnationId` | 运行实例 | ✅（同上） |
| `task_id` | 宿主注入 `cell.taskId` | 任务 | ✅（同上） |
| `request_id` | 调用方传入（`apply`/`undo` 必填） | 幂等键 | ✅ |
| `application` | Lite 状态机映射（见 §2） | 是否**真的**提交 | ✅ |
| `effect.kind` | 锚点存在性 + 操作类型 | `file_created` / `file_modified` / `file_restored` / `file_deleted` / `none` | ✅ |
| `effect.target` | `journal/manifest.json` 的 `file`（**工作区相对路径**） | 目标 | ✅ |
| `effect.before_sha256` | 写前 backup 的**实测** hash（新建为 `null`） | 写前版本 | ✅ |
| `effect.after_sha256` | 写后**回读实测**的 hash（不是拟提交内容的 hash） | 写后版本 | ✅ |
| `effect.detail_ref` | `liuhe:<txn_id>`（不透明引用） | 细节入口 | ✅ |
| `verification` | 恒 `not_run` | 独立验收结论 | ⚠️ **只能给 `not_run`**（见 §3） |
| `recovery.supported` | `journal.state ∈ {committed, committed_recovered}` ∧ 证据完整 | 能否撤销 | ✅ |
| `recovery.ref` | `liuhe-undo:<txn_id>` | 撤销入口 | ✅ |
| `recovery.expires_at` | 24h 保留窗口（`JOURNAL_RETENTION_HOURS`） | 证据过期时间 | ✅（合同外**扩展字段**） |
| `persistence` | `persisted` / `failed` / `unknown` | 证据是否落盘 | ✅ |
| `extension` | `journal_state` / `reason` / `undo_status` / `files` | 诊断信息（**非合同必需**） | ✅（扩展） |

## 2. `application` 状态映射（真实状态 → 公共词汇）

| 场景 | `application` | 附注 |
|---|---|---|
| apply 成功（回读一致） | `applied` | `after_sha256` 为实测值 |
| 锚点过期 / 目标消失 / 目标已存在 | `rejected` | 错误码 `VERSION_CONFLICT` |
| 日记落盘失败（未写盘） | `failed` | 错误码 `PERSISTENCE_FAILED`；`persistence: failed`；**撤销承诺撤销** |
| 原子写失败（目标未变） | `failed` | 错误码 `WRITE_FAILED` |
| 写后回读不一致 | `indeterminate` | 错误码 `INDETERMINATE`；`recovery.supported: false` |
| 同一 `request_id` 未收口的重试（可能已写入） | `indeterminate` | **不得声称「已取消且无副作用」**（L14） |
| reconcile：文件 == 写后 hash | `applied` | 落地了 |
| reconcile：文件 == 写前 backup | `not_applied` | 净效果为零（从未落地，**或落地后被 Undo 撤销**——看 `extension.reason`） |
| reconcile：文件两者都不是 | `needs_review` | 外部改动；**不覆盖、不谎报** |
| reconcile：journal `state=indeterminate` | `indeterminate` | 写时回读就失败了 |
| reconcile：journal `state=undone` / `rolled_back` | `not_applied` | `extension.reason` 写明「提交过又撤销」 |
| reconcile：无 journal 证据 | `indeterminate` | 证据不足，**不猜** |

## 3. 六合内部错误码 → Lite 错误码

| 六合内部码 | Lite 码 | 触发场景 |
|---|---|---|
| `PATH_BLOCKED` | `PATH_OUT_OF_SCOPE` | `../`、绝对路径、敏感目录、symlink 逃逸、Lite 受限档的 symlink 路径 |
| `VERSION_CONFLICT` | `VERSION_CONFLICT` | 锚点与磁盘现状不一致 |
| `EXTERNAL_CHANGE` / `BATCH_BLOCKED` | `UNDO_CONFLICT` | Undo 前文件已被后续修改 |
| `READBACK_MISMATCH` | `INDETERMINATE` | 写后回读不一致 |
| `JOURNAL_NOT_FOUND` / `JOURNAL_UNREADABLE` | `RECOVERY_UNAVAILABLE` | 无可撤销证据 |
| `NOT_COMMITTED` | `NOT_UNDOABLE` | 该动作不在可撤销状态 |
| `FILE_LOCKED` | `FILE_LOCKED` | 并发写者持锁 |
| `ATOMIC_WRITE_FAILED` | `WRITE_FAILED` | 原子写失败（目标未变） |
| `BACKUP_FAILED` | `PERSISTENCE_FAILED` | 证据落盘失败 |
| `TXN_NOT_FOUND` | `NOT_FOUND` | 动作/日记不存在 |
| `INVALID_INPUT` / `missing_parameter` | `INVALID_INPUT` | 参数不合法 |
| （Lite 自有） | `FILE_TOO_LARGE` / `UNSUPPORTED_ENCODING` | 超限 / 非 UTF-8 / 二进制 |
| （Lite 自有） | `REQUEST_CONFLICT` / `REQUEST_IN_FLIGHT` | 同 `request_id` 异载荷 / 正在执行 |

## 4. **无法提供**的字段（明确不编造）

| 想要的东西 | 为什么不给 | 谁能给 |
|---|---|---|
| `verification: "verified"` | Lite **不跑任何代码检查/测试/构建** —— 写入成功 ≠ 代码语义正确 | 土行孙自己跑验收后回填 |
| “这次修改对不对”的语义结论 | 需要符号级语义与跨语言引用，Lite 不建索引、不解析 | 六合完整 MCP（`code_check` / `code_read`）或土行孙自己的验收 |
| 绝对路径 | 公共回执不泄露宿主私有路径 | 需要时用 `inspect`（仍只给工作区相对路径） |
| 日志正文 / 备份文件内容 | 回执不塞日志内容（会撑爆每轮上下文）；`inspect` 也只给 hash 与元数据 | 需要时由土行孙自己读工作区 |
| 时间戳 | v0 公共字段里没有；六合内部 `created_at`/`committed_at` 属于内部证据，**不强行映射**进公共合同 | 若需要，在同步点 B 冻结字段时加 |
| 跨文件 / 跨工作区影响 | Lite 是单文件、单工作区作用域 | 六合 `edit_transaction`（多文件事务系） |
| shell / 网络 / 远程 API 动作的回执 | Lite **不做**这类动作 | 不存在此能力 |
| “Cell 是否有权做这件事”的结论 | Lite 不评估 Cell 授权真值 | 土行孙 Cell 运行时（`TrustedWorkspace` 与执行资格） |

## 5. 无损映射原则

六合内部的 `journal.state`（`created/staged/committed/rolled_back/abandoned/needs_review/failed/undone/indeterminate`）**未被替换或裁剪**：

- 公共字段用 `application` 表达“对外该怎么说”；
- 内部原值保留在 `extension.journal_state`（供 inspect / 对账使用）；
- 两者是**映射关系，不是替换关系**——土行孙要细节时看 `extension`，要判断时看 `application`。

## 6. 一份真实回执（apply 成功）

```json
{
  "schema_version": "tusunsun.action-receipt/v0",
  "action_id": "act-txn_1792648625411_350fb5a4_p4089310",
  "provider": "liuhe-lite",
  "provider_operation_id": "txn_1792648625411_350fb5a4_p4089310",
  "cell_id": "cell-A",
  "incarnation_id": "run-poc",
  "task_id": "task-poc",
  "request_id": "poc-req-1",
  "application": "applied",
  "effect": {
    "kind": "file_modified",
    "target": "notes.txt",
    "before_sha256": "3b1e0d1c…（写前实测）",
    "after_sha256": "586622c2…（写后回读实测）",
    "detail_ref": "liuhe:txn_1792648625411_350fb5a4_p4089310"
  },
  "verification": "not_run",
  "recovery": {
    "supported": true,
    "ref": "liuhe-undo:txn_1792648625411_350fb5a4_p4089310",
    "expires_at": "2026-10-23T…（24h 内）"
  },
  "persistence": "persisted"
}
```
