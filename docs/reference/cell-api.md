# Cell API 参考（`cell-runtime` 服务）

> 本文件里**每一个返回形状都是从真实调用取下来的**，不是从源码推断的。
> 取形状的脚本见文末 §7。凡标 `Promise` 的必须 `await` —— 忘了 `await` 拿到的是
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

失败：`workspace_not_allowed` / `cell_quota_exceeded`（同 Core 第二个 Cell）/
`cell_identity_conflict`（同一 `cell_id` 换工作区）/ `unsupported_runtime` / `cell_gate_unavailable`。

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

不传 `task` 就用 `accept` 时那个。真实返回：

```json
{
  "schema_version": "tusunsun.result/v0",
  "task_id": "T1", "attempt": 1,
  "cell_id": "c1", "incarnation_id": "run-...-1",
  "execution_state": "succeeded",
  "artifacts": [], "evidence": [],
  "usage": { "steps": 0, "model_calls": null, "wall_ms": 2 },
  "error": null,
  "record_id": "run-...-1:T1#1",
  "durability_outcome": { "state": "persisted", "attempts": 1, "error": null },
  "state_persisted": true
}
```

- `execution_state` ∈ `succeeded | failed | timed_out | unknown`
- **`record_id` 是归并键**：`${incarnation_id}:${task_id}#${attempt}`。落盘行数不等于完成次数。
- `usage.model_calls` 在无模型装配下是 `null`（不是 0）

### `resultRecords(cellId)` → `Promise<{records, raw_lines, duplicate_lines, unreadable_lines}>`

**这个返回 Promise，必须 `await`。** 按 `record_id` 归并：

```json
{ "cell_id": "c1",
  "records": [ /* 每笔一条，同 id 多行只留一条 */ ],
  "raw_lines": 1, "duplicate_lines": 0, "unreadable_lines": 0 }
```

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

## 7. 这份文档怎么保证没写错

取形状的脚本（本机可复跑，只读）：

```bash
node verification/perf/bench.mjs          # 性能部分
node verification/external-consumer/run.sh <tgz>   # 端到端用法
```

每个 `→` 后面的 JSON 都是真实调用打印出来的，不是从源码抄的。
若将来实现变了而本文没变，**以实测为准**，并把本文当成缺陷修掉。
