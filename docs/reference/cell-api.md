# Cell API 参考（`cell-runtime` 服务）

> 本文件里**每一个返回形状都是从真实调用取下来的**，不是从源码推断的。
> 取形状的脚本见文末 §8。凡标 `Promise` 的必须 `await` —— 忘了 `await` 拿到的是
> 恒真对象（本项目已经在这上面栽过两次：`hasCapability`、`callCapability`）。

## 0. 拿到服务

```js
await cellRuntime.init(core);
const svc = core.getService('cell-runtime');
```

服务面上有 **15 个方法**。下面按用途分组，每个都写清「输入 → 输出 → 失败长什么样」。

## 1. 生命周期

### `create(spec, opts?)` → `Promise<CellStatus>`

```js
await svc.create(spec, { trusted: true });
```

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `spec` | 是 | `CellSpec`，见 §6 |
| `opts.trusted` | 建议 | `true` = 宿主自己调用。**不传会被 `workspace_not_allowed` 拒**（远端来源不要传 `true`） |
| `opts.forceOwner` | 否 | 强占已被别的进程持有的 `stateDir`；双并发强占**未实测**（NOT_RUN） |

真实返回：

```json
{
  "schema_version": "tusunsun.cell-status/v0",
  "cell_id": "c1",
  "incarnation_id": "run-20261030060145-1716342-1",
  "state": "ready",
  "phase": null,
  "workspace_realpath": "/tmp/api-XeYbhm/ws",
  "capabilities_effective": ["tool.read"],
  "capabilities_withheld": [],
  "fence": { "installed": false, "mode": "auto", "scope": "none", "owner": null },
  "capability_gate": {
    "installed": true, "live": true, "owner": "cell:c1", "generation": 1,
    "pre": 1, "dispatch": 1, "post": 0, "executor_present": true,
    "tokens": ["te-d965de42#1", "te-d965de42#2"],
    "lease": { "owner": "cell:c1", "generation": 1, "live": true },
    "lease_live": true, "reinstalls": 0
  },
  "active_task_id": null,
  "unsettled": []
}
```

失败（全部带 `code` 与 `contractError:true`）：

| code | 何时 |
| --- | --- |
| `invalid_cell_spec` | 字段缺失/越界/`workspace` 不是绝对路径/`runtime.extra`/`limits.max_active_tasks≠1` |
| `unsupported_schema_version` | `schema_version` 主版本不认识（当前只收 `tusunsun.cell/v0`） |
| `unsupported_runtime` | `runtime.kind !== 'process'`（`shared_process` / `remote` 是**明确拒绝**，不是没实现） |
| `cell_id_conflict` | **本进程**已存在同 `cell_id` 的登记 |
| `cell_quota_exceeded` | 本 Core 已经有**另一个** Cell（v0 硬约束：1 Cell : 1 Core : 1 进程） |
| `cell_identity_conflict` | 同一个 `stateDir` 上同 `cell_id` 换工作区（身份带着它的目录） |
| `cell_gate_unavailable` | 已注册的执行器无法承载这道能力门 |
| `workspace_binding_unavailable` | `workspace` 存在但不是目录，或绑定失败 |
| `workspace_not_allowed` | 没传 `opts.trusted:true` 且工作区不在宿主的白名单里 |
| `state_dir_owned` | 同一个 `stateDir` 已被另一个活着的进程/实例持有 |

### `describe(cellId)` → `CellStatus`（同步）

返回形状与 `create` 相同。**不存在时抛** `unknown_cell`。

观测面要看的是这三处：
- `capabilities_effective` vs `capabilities_withheld` — 三集合交集之后真正生效的
- `capability_gate.live` / `lease_live` — 门现在是不是真的装着
- `state` + `phase` — `phase` 是内部阶段（`preparing`/`committed`/`settling`/`null`）

### `list()` → `CellStatus[]`（同步，精简）

```json
[{ "cell_id": "c1", "state": "ready", "workspace": "/tmp/api-XeYbhm/ws",
   "incarnation_id": "run-...-1", "active_task": null }]
```

v0 下最多一条（1 Cell : 1 Core）。

### `close(cellId, opts?)` → `Promise<CloseReceipt>`

```js
await svc.close('c1');
await svc.close('c1', { force: true, quiesceMs: 5000 });
```

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `force` | `false` | 有任务在跑/正在准备时，非 force 抛 `cell_busy` |
| `quiesceMs` | `5000` | 等旧异步链静默的上界；**不静默就不拆门、不放锁、不发事件** |

真实返回（关完）：

```json
{
  "cell_id": "c1", "from": "ready", "to": "stopped",
  "execution_revoked": true, "quiesced": true,
  "workspace_released": true, "state_dir_released": true, "inflight": 0,
  "cleanup_done": true, "cleanup_pending": [], "already": false,
  "close_id": "run-20261030060145-1716342-1:closed",
  "closed_at": "2026-10-30T06:01:45.452Z",
  "incarnation_id": "run-20261030060145-1716342-1",
  "closed": true, "closing": false
}
```

真实返回（已经关过）：

```json
{ "closed": true, "closing": false, "already": true, "cell_id": "c1", "state": "stopped",
  "execution_revoked": true, "cleanup_done": true, "cleanup_pending": [],
  "close_id": "run-...-1:closed", "closed_at": "...", "incarnation_id": "run-...-1" }
```

**三种答案，`closed` 与 `cleanup_done` 同源：**

| 观察 | 含义 |
| --- | --- |
| `closed:true, already:false` | 你这次关完了 |
| `closed:true, already:true` | 早就关完了（**只有 `already` 路径没有 `from`/`to`/`quiesced`**） |
| `closed:false, closing:true` | 执行资格已撤销，清理没做完；`cleanup_pending` 说要重试哪几项 |

**并发安全**：同一 Cell 的结算单飞，并发调 N 次只发一次 `cell.closed`，其余回 `already:true`。

事件负载（`core.on('cell.closed', ...)`）：

```json
{ "cell_id": "c1", "from": "ready", "timestamp": "...",
  "close_id": "run-...-1:closed", "incarnation_id": "run-...-1", "closed_at": "...",
  "quiesced": true, "workspaceReleased": true, "ownerReleased": true,
  "sourcePlugin": "cell-runtime" }
```

有清理未完成时改发 `cell.closing`，带 `cleanup_pending` 与 `inflight`。

### 复用与进程成本（为什么 `close` 之后同 Core 不能再建）

`close` 完成后登记**仍然保留**：同 Core 再 `create` 会得到 `cell_quota_exceeded`。这不是缺陷，
而是 v0 的隔离不变量 —— 插件状态、场景状态与能力注册表都是**进程级**的，同一个 Core 里换一个
Cell 会继承上一个 Cell 留下的状态，“1 Cell : 1 Core : 1 进程”就从承诺变成了说法。

要省掉“一次任务一个 OS 进程”（实测约 0.8s）的成本，**隔离单元是 Core，不是 Cell**：

| 做法 | 结果 |
| --- | --- |
| 同 Core `close` 后重建 | `cell_quota_exceeded`（设计如此） |
| 同进程新建 Core + 同 stateDir + 同 `cell_id` + **同工作区** | **实测可用**（新插件实例、新会话表、新 `_fenceContext`） |
| 同 stateDir 上同时两个活 Cell | `state_dir_owned`：一个 stateDir 只能有一个活属主 |

另外两个常被当成“缺接口”的点，已有入口：

- **要状态**：`describe(cellId)` 就是状态面（`state` / `phase` / `active_task_id` / `capability_gate`）；
- **要停**：`close(cellId, { force: true })` 先撤销执行资格（正在跑的任务会被具名拒），再结算；
- **`execute` 是阻塞 RPC**：异步化需要 `run_id` + 事件流 + 取消语义，属于下一个接口版本（v0 不提供）；
- **`_reply` 不落盘**：它以 `_` 前缀标识为进程内私有（不进行为结果信封，也不进 `results.jsonl`），
  要回读已落盘的结构化结果用 `resultRecords(cellId)`。


## 2. 任务

### `accept(cellId, task)` → `Promise<AcceptReceipt>`（同步实现，调用方不必 await）

```json
{ "accepted": true, "task_id": "T1", "attempt": 1,
  "effective_capabilities": ["tool.read"],
  "budget": { "max_steps": 3, "wall_ms": 10000 } }
```

失败（抛，带 `code`）：`capability_denied`（三集合交集为空）/ `cell_not_ready` /
`task_rejected`（信封不合法）/ `cell_busy`（已有任务）。

> **准入即拒**：能力不足在 `accept` 就被拒，根本到不了派发。集成时若想测"派发期被拒"，
> 必须让能力**已授权**，再在别的维度触发拒绝。

### `execute(cellId, task?, opts?)` → `Promise<WorkResult>`

不传 `task` 就用 `accept` 时那个。

**阻塞语义**：返回的 Promise 在任务结束（或预算判死）时兑现。没有 `run_id`、没有进度流、
没有 `cancel`；等待方在兑现前只能靠 `describe(cellId)` 看 `state`/`active_task_id`。
0.20.2 的真实返回：

```json
{
  "schema_version": "tusunsun.result/v0",
  "task_id": "T1", "attempt": 1,
  "cell_id": "c1", "incarnation_id": "run-...-1",
  "execution_state": "succeeded",
  "artifacts": [{ "path": "outputs/report.json", "sha256": "f31d4c43...", "bytes": 34 }],
  "evidence": [],
  "usage": { "steps": 0, "model_calls": null, "wall_ms": 3 },
  "error": null,
  "_reply": "DONE",
  "record_id": "run-...-1:T1#1",
  "durability_outcome": { "state": "persisted", "attempts": 1, "error": null },
  "state_persisted": true
}
```

| 字段 | 含义 |
| --- | --- |
| `execution_state` | `succeeded` / `failed` / `rejected` / `timed_out` / `cancel_requested` / `unknown`（全集 6 个） |
| `artifacts[]` | `{path, sha256, bytes}`；`path` 相对工作区，`sha256` 是写入后**重算**的 |
| `evidence[]` | 结构化证据，v0 允许为空 |
| `usage` | `{steps, model_calls, wall_ms}`；`model_calls:null` = **没测**（不是 0）；无 agent 循环时 `steps` 为 0 |
| `error` | `null` 或字符串/对象；失败原因的**唯一权威位置** |
| `record_id` | 归并键 `${incarnation_id}:${task_id}#${attempt}` |
| `durability_outcome` | `{state, attempts, error}`；只有 `state:'persisted'` 代表这一笔已在 `results.jsonl` 里 |
| `state_persisted` | 上一条的便捷读数 |
| `_reply` | **只在返回值里**：`chat.handle` 的原文回复。不落盘、`resultRecords` 里也没有；下划线前缀不属于稳定合同 |

**同一 `task_id` 重跑 = 真的再跑一次**（0.20.2 实测：`chat.handle` 被调 2 次、产物被覆盖）。
`record_id` 不变，于是 `resultRecords` 的 `raw_lines` 变 2、`duplicate_lines` 变 1、`records` 只留
**最后一条**。—— `task_id` **不是幂等键**。防重跑只有两条路：递增 `attempt`，或宿主在派遣前
先查 `resultRecords`。（`record_id` 里带 `attempt` 就是为了这条路。）

失败/超时/未知的区分：`failed` 伴随 `error`（执行真的出错）；`timed_out` 表示预算到期且
**在飞的那次调用没被中断**（`error` 里会写明副作用未撤销）；`unknown` 只在“上一世运行在任务
在飞时结束（崩溃/重启）”后出现 —— 那是 `resolveAfterRestart` 的结果，不是本进程给的。

### `resultRecords(cellId)` → `Promise<{records, raw_lines, duplicate_lines, unreadable_lines}>`

**这个返回 Promise，必须 `await`。** 按 `record_id` 归并：

```json
{ "cell_id": "c1",
  "records": [ /* 每笔一条，同 id 多行只留最后一条 */ ],
  "raw_lines": 1, "duplicate_lines": 0, "unreadable_lines": 0 }
```

| 事实 | 值 |
| --- | --- |
| 物理位置 | `<stateDir>/cells/<cell_id>/results.jsonl`（只追加，不重写） |
| 保留期 | **无 TTL、无上限、不自动清理**；`close` 不删它 |
| 跨重启 | 能读（文件在 `stateDir` 里）；读到的是**上一世运行**写下的行 |
| 含 `_reply` 吗 | **不含**。`_reply` 只在 `execute` 的返回值上 |
| 不含 `durability_outcome` / `state_persisted` | 这两个字段也只存在于返回值 |
| `_` 前缀字段 | 不属于稳定合同；本文只承诺非下划线字段 |
| 坏行 | 计入 `unreadable_lines`，不静默丢弃 |

`unreadable_lines > 0` 表示有坏行/半行——**不静默丢弃**。

### `verify(cellId, task?, opts?)` → `Promise<AcceptanceDecision>`

```json
{ "decision": "accepted", "task_id": "T1", "attempt": 1,
  "reason": "execution succeeded；0 artifact(s) hash-verified", "by": "local-acceptor", "checked": [] }
```

`decision` ∈ `accepted | rejected | inconclusive`。**执行 ≠ 验收**：
`execution_state:succeeded` 只是跑完了；`inconclusive` 表示产物被换掉或读不出。

### `report(cellId)` → `{ cell, last_result }`（同步）

`cell` 是 `describe` 的形状，`last_result` 没有则为 `null`。

## 3. 派发期判决（给执行器/宿主用）

这四个方法回答的是**不同层**的问题，混用就会出 K30 那类缺陷。

### `cellForSession(sessionId)` → `CellRef | null`

```json
{ "cell_id": "c1", "incarnation_id": "run-...-1", "state": "ready",
  "task_id": null, "execution_revoked": false }
```

不是 Cell 会话返回 `null`（**不要编一个 id**）。按登记表全等比较，不按 `cell-<id>` 命名切字符串。

### `sessionEligibility(sessionId)` → `null | {ok:true,...} | {ok:false,code,...}`

**身份层**：这个会话还是不是那个 Cell。

```json
{ "ok": true, "cell_id": "c1", "state": "ready" }
```

| `code` | 何时 |
| --- | --- |
| `execution_revoked` | 已关闭/超时，资格单向撤销（`state` 可能回到 `ready`，但票不再有效） |
| `cell_gate_unavailable` | 状态不是 `ready`/`busy`（如 `stopped`/`faulted`） |

### `dispatchEligibility(sessionId, taskCtx)` → `null | ok | deny`

**身份 + 任务两层**。`taskCtx` 是 `runInTaskContext` 签发的那张票。

```json
{ "ok": true, "cell_id": "c1", "state": "busy", "epoch": 3, "task_id": "T1" }
```

| `code` | 含义 |
| --- | --- |
| `task_scope_required` | **没有票**：Cell 活着但这次调用不来自任何执行 |
| `task_scope_mismatch` | 票属于别的 Cell / 别的 `incarnation_id` |
| `task_not_active` | 此刻没有任务在跑（上一任务已收尾，迟到回调落在这一格） |
| `stale_task_epoch` | 票的 epoch ≠ 当前任务 epoch（旧任务迟到链） |

**`task_scope_required` ≠ `task_not_active`**：前者是"从来就没有票"，后者是"有过票但任务结束了"。
处置动作不同，所以 code 必须不同。

### `gateIdentity(sessionId)` → `null | GateIdentity`

**门的身份**，不是"有没有活租约"。执行器拿回执回自己表里核：同实例、同代、同 token、同 owner。

```json
{ "cell_id": "c1", "installed": true, "owner": "cell:c1", "generation": 1,
  "instance": "te-d965de42", "executor": "[object]",
  "receipts": { "pre": {...}, "dispatch": {...} },
  "tokens": ["te-d965de42#1", "te-d965de42#2"],
  "lease_key": "cell-c1\u0000cell:c1" }
```

`installed:false` = Cell 存在但从未装上门（纯对话 Cell 的正常形态）。

### `runInActiveTask(sessionId, fn)` → `{ok:true,value} | {ok:false,code}`

给**宿主**发起的认知调用用。票据由本方法从登记记录构造——网关只能选"用当前任务"，**不能选哪个任务**。

```json
{ "ok": false, "code": "task_not_active", "reason": "..." }
```

无活跃任务时如实拒绝，**调用方不得降级**成无票调用。

## 4. 配置项

| 键（`<stateDir>/config.json`） | 默认 | 说明 |
| --- | --- | --- |
| `cells.hostCapabilities` | 未设 → 取已注册 + 懒加载声明的 `tool.*` 并集 | Cell 能力上限；Spec 不能抬高它 |
| `tools.rateLimit.maxCalls` | `30` | 同（会话, 工具）窗口内上限 |
| `tools.rateLimit.windowMs` | `60000` | 窗口长度 |

**配置路径是 `<stateDir>/config.json`**（`Core.configPath` 默认值）。写到工作目录里不会生效：
`core.get` 返回 `undefined`，静默回落到 30——实测写错位置 50 次调用被拦 20 次。

## 5. 错误码总表

| code | 层 | 出处 |
| --- | --- | --- |
| `workspace_not_allowed` | 准入 | `create` 未传 `trusted` |
| `cell_quota_exceeded` | 准入 | 同 Core 建第二个 Cell |
| `cell_identity_conflict` | 准入 | 同 `cell_id` 换工作区 |
| `unsupported_runtime` | 准入 | `runtime.kind !== 'process'` |
| `cell_gate_unavailable` | 准入/派发 | 门装不上，或状态不允许派发 |
| `capability_denied` | 准入/派发 | 三集合交集为空 / 能力未授权 |
| `permission_denied` | 派发 | `read-only` 模式调非只读能力 |
| `task_scope_required` | 派发 | 没有任务票据 |
| `task_not_active` | 派发 | 有 Cell 但此刻无任务 |
| `stale_task_epoch` | 派发 | 旧任务的票 |
| `task_scope_mismatch` | 派发 | 票属于别的 Cell/世代 |
| `execution_revoked` | 派发 | 资格已撤销 |
| `cell_busy` | 任务 | 有任务在跑/准备中 |
| `cell_not_ready` | 任务 | 状态不是 `ready` |
| `close_incomplete` | 关闭 | 落盘失败，清理未完成（**不是**已关闭） |
| `unknown_cell` | 通用 | `cell_id` 不存在 |
| `invalid_cell_spec` | 准入 | Spec 字段缺失/越界/相对路径/`runtime.extra` |
| `cell_id_conflict` | 准入 | 本进程已存在同 `cell_id` |
| `invalid_task` | 任务 | Task 字段缺失/越界/`goal` 空 |
| `workspace_conflict` | 任务 | Task 自带 `workspace`/`workDir`/`work_dir`/`cwd` |
| `invalid_state_transition` | 生命周期 | 非法状态迁移（如 `busy → stopped`） |
| `invalid_result` | 任务 | WorkResult 不合法（自报 success 但没带 sha256 等） |
| `unsupported_schema_version` | 准入 | `schema_version` 主版本不认识 |

容量限额（`status:'blocked'`）**不是错误码**，是执行器在派发前返回的拒绝结果。

## 6. 两个信封的形状

```js
// CellSpec
{
  schema_version: 'tusunsun.cell/v0',
  cell_id: 'c1',
  workspace: '/abs/path',            // 必须已存在
  capabilities: ['tool.read'],       // 只能是 hostCapabilities 的子集
  permission_mode: 'auto',           // auto | read-only
  runtime: { kind: 'process' },      // v0 只支持 process
  limits: { max_active_tasks: 1, max_children: 0 },
}

// TaskEnvelope
{
  schema_version: 'tusunsun.task/v0',
  task_id: 'T1', attempt: 1,
  target_cell_id: 'c1',
  goal: '...',
  inputs: [],
  required_capabilities: ['tool.read'],   // ← 少写这个 ⇒ effective 为空
  budget: { max_steps: 3, wall_ms: 10000 },
  acceptance: { required_artifacts: [], checks: [] },
}
```

`CellSpec` 逐字段（`required` 列只写“必填/可选/默认”）：

| 字段 | 必填 | 取值 | 越界时 |
| --- | --- | --- | --- |
| `schema_version` | 必填 | `tusunsun.cell/v0` | `unsupported_schema_version` |
| `cell_id` | 必填 | `[A-Za-z0-9][A-Za-z0-9._@+-]*`，≤128 | `invalid_cell_spec` |
| `workspace` | 必填 | **绝对路径**，且必须已存在的目录 | `invalid_cell_spec` / `workspace_binding_unavailable` |
| `capabilities` | 可选（[]） | 能力 id 数组，≤64 条 | 形状错：`invalid_cell_spec` |
| `permission_mode` | 可选（`auto`） | `auto\|ask\|read-only\|auto-edit\|full-auto` | `invalid_cell_spec`；`full-auto` 另外需要宿主 `cells.allowFullAuto` |
| `runtime` | 可选（`{kind:'process'}`） | 只收 `process` | `unsupported_runtime` |
| `limits.max_active_tasks` | 可选（1） | **只能 1** | 其他值 `invalid_cell_spec` |
| `limits.max_children` | 可选（0） | 0..宿主上限 | 超过上限 `capability_denied` |
| `limits.max_steps` | 可选 | 1..10000 | `invalid_cell_spec` |
| `limits.wall_ms` | 可选 | 1..86400000 | `invalid_cell_spec` |
| `state_ref` | 可选 | `local:<相对路径>` | `invalid_cell_spec` |
| `model_ref` | 可选 | 非空字符串 | 仅校验与记录：**v0 没有任何读者**，不据此选模型 |
| `tags` | 可选（[]） | 字符串数组，≤32 | `invalid_cell_spec` |

`TaskEnvelope` 逐字段：

| 字段 | 必填 | 取值 | 越界时 |
| --- | --- | --- | --- |
| `schema_version` | 必填 | `tusunsun.task/v0` | `unsupported_schema_version` |
| `task_id` | 必填 | 不透明 id，≤128 | `invalid_task` |
| `attempt` | 可选（1） | 1..1e6 | `invalid_task` |
| `target_cell_id` | 必填 | 必须等于目标 Cell | `invalid_task` / `unknown_cell` |
| `goal` | 必填 | 非空，≤20000 字 | `invalid_task` |
| `inputs` | 可选（[]） | `[{kind, ref}]`，`ref` 为工作区内相对路径 | `invalid_task` |
| `required_capabilities` | 可选（[]） | 能力 id 数组，≤64 | 形状错：`invalid_task`；不在交集：`capability_denied` |
| `budget.max_steps` / `budget.wall_ms` | 可选 | 1..10000 / 1..86400000 | `invalid_task` |
| `acceptance` | **必填** | `{required_artifacts:[], checks:[]}` | `invalid_task` |
| `workspace`/`workDir`/`work_dir`/`cwd` | **禁止** | —— | `workspace_conflict` |

两只信封里**没有任何字段能让调用方改工作区或提高能力**：工作区由 Spec 且仅由 Spec 定，
能力取三集合交集（宿主上限 ∩ Spec ∩ Task），`permission_mode` 只做**收窄**（`read-only` 时
派发期直接 `permission_denied`），与 `capabilities` 是两层、互不推导。

## 7. 消费者十问（逐条回答）

> 以下每条都在 0.20.2 上跑过一次 `create → describe → accept → execute → resultRecords →
> verify → 同任务重跑 → close → 重关`，返回原样打印；形状与本文 §1–§6 一致。

1. **`cell_id` 冲突回什么？** 同进程重复建 → `cell_id_conflict`；已经有一个**别的** Cell →
   `cell_quota_exceeded`（即使那个 Cell 已 `close`，登记仍在）。
2. **`workspace` 必须绝对路径吗？** 是，且必须已存在。相对路径 → `invalid_cell_spec`；
   不存在 → `invalid_cell_spec`；存在但不是目录 → `workspace_binding_unavailable`。
   对外回报的是 `realpath` 之后的值（`workspace_realpath`）。
3. **`capabilities` 与 `permission_mode` 怎么交集？** 不交集，是两层：前者选**哪些能力 id**
   可用（宿主∩Spec∩Task，在 `accept` 定型），后者是**执行期模式**（`read-only` 会让非只读能力
   在派发期 `permission_denied`）。写 `capabilities:['tool.write'] + permission_mode:'read-only'`
   不会因为声明了写就变得可写。
4. **`execute` 是阻塞的吗？** 是。返回即终态，没有 `run_id`、没有事件流、没有 `cancel`。
5. **`WorkResult` 到底有哪些字段？** 见 §2 的表。注意 `_reply` 只在返回值里、不落盘；
   `durability_outcome.state:'persisted'` 才是“已入账”。
6. **同一 `task_id` 重跑会二次执行吗？** **会**。`chat.handle` 会再被调用一次，产物被重写；
   `record_id` 相同，`resultRecords` 里 `raw_lines` +1、`duplicate_lines` +1，`records` 只留最后一条。
   `task_id` 不是幂等键。
7. **`describe` 的字段取值？** `state ∈ created|ready|busy|draining|stopped|faulted`；
   `phase` 平时是 `null`，只在准备/结算阶段取 `prepared`/`committed`/`settling`（异常时是内部阶段名，
   如 `prestart_persist_failed`，不要对它做枚举匹配）；
   `active_task_id` 空闲时为 `null`；`workspace_realpath` 是创建时的真实路径快照，
   `close` 之后仍然可读（不会变回进程默认根）。
8. **`close({force:true})` 的“请求停止”与“已停止”？** `close` 返回里 `closed:true` 是**已停止**；
   `closed:false, closing:true` 是**已撤销资格、清理未完成**（`cleanup_pending` 说要重试哪几项）。
   已撤销之后迟到的工具调用一律 `execution_revoked`，零副作用；已经发生的副作用不回滚。
   关闭后的 `accept` → `cell_not_ready`，`execute` → `cell_not_ready`（不是 `unknown`）。
9. **`resultRecords` 的形状/保留期/跨重启/`_reply`？** 见 §2 的表：追加文件、无 TTL、跨重启可读、
   不含 `_reply`。
10. **`verify` 的判据？** 没有该任务的记录 → `rejected`；`execution_state≠succeeded` → `rejected`；
    产物路径越界/读不出/hash 与记录不符 → `inconclusive`；缺 `required_artifacts` → `rejected`；
    全部核过 → `accepted`（`checked` 列出核过的路径）。

**没做的三件事**（P2，尚未做）：异步 `run_id`、生命周期事件流、`cell.cancel`/`cell.reclaim`/
`cell.result(id)`。当前消费方式是“独立进程 + 轮询 `describe`”，那条路不依赖上面任何一项。

## 8. 这份文档怎么保证没写错

取形状的脚本（本机可复跑，只读）：

```bash
node verification/perf/bench.mjs          # 性能部分
node verification/external-consumer/run.sh <tgz>   # 端到端用法
```

每个 `→` 后面的 JSON 都是真实调用打印出来的，不是从源码抄的。
若将来实现变了而本文没变，**以实测为准**，并把本文当成缺陷修掉。
