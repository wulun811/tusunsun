# Cell RFC —— 土行孙的执行单元抽象（v0）

状态：**已实现（v0.9.19）**，对应计划书 G1。
合同版本：`tusunsun.cell/v0`、`tusunsun.task/v0`、`tusunsun.result/v0`、`tusunsun.cell-status/v0`。
实现：`plugins/cell/contract.js`（纯验证器）+ `plugins/cell-runtime.js`（适配门面）。

---

## 0. 一句话

**Cell 是"能持续拥有身份、状态、工作边界和能力视图，独立接受、执行、交付 Task 的最小自主执行主体"。**

它可以使用 LLM、状态机或确定性工具；**不要求每个 Cell 都运行一个模型** —— 这是它可以被
"确定性验收"而非"感觉良好"的前提。

---

## 1. 五个概念必须分开

| 概念 | 是什么 | 不是什么 |
|---|---|---|
| **Cell** | 执行主体：身份 + 状态 + 工作边界 + 能力视图 + 生命周期 | 不是 Task 的包装；不是 Session 的别名 |
| **Task** | 要完成的工作与验收条件（可失败、可重试、可重派） | 不是一个进程；不是一段提示词 |
| **Session** | Cell **内部**的一段工作记忆通道（一个 Cell 可以有多段） | 多个 Session 不自动构成多个 Cell |
| **Core** | 插件/能力/事件微内核 | 不是 Agent 角色；不是组织调度器 |
| **Process** | 运行时承载（v0 是 1 Cell : 1 Core : 1 OS 进程） | 不是 Cell 的定义（是当下的隔离与兼容策略） |

多共享同一个 Core 的会话**不**自动构成多个 Cell：它们没有独立的能力上限、没有独立的状态目录、
也没有独立的结果归属。把它们说成"多 Agent"是这类系统最常见的夸大。

### 为什么必须有这一层

没有 Cell 这个抽象时，"这个结果是谁产出的"只能靠推断：进程 PID 会变、端口会变、会话 id
是调用方随便给的、模型自称的角色没有任何约束力。于是"旧结果冒充新运行""两个单元写了同一个
文件却说不清是谁写的"这类问题**在结构上无法回答**。

Cell 提供的正是那个可回答的锚点：`cell_id`（跨时间稳定）+ `incarnation_id`（区分同一 Cell 的
不同运行）。

---

## 2. 七条长期不变量

1. **身份不随执行形态改变**。`cell_id` 不等于 PID、端口、会话 ID，也不是模型自报的角色。
   宿主重启产生新的 `incarnation_id`；旧运行的结果不能假冒新运行。
2. **工作与执行者解耦**。Task 可失败、重试、重派；Cell 可依次接多个 Task；结果属于
   `task_id + attempt`，不因 Cell 自称成功就完成验收。
3. **可信权限取交集**。实际可调用的能力 = HostPolicy ∩ CellSpec ∩ Task。模型不能通过修改提示词、
   请求正文或回传结果自授更高权限。
4. **工作区真值唯一且可恢复**。绑定目录一经形成，在显式换单元或经批准迁移前不改变；
   不可恢复即**拒绝任务**，不回退默认根（见 `docs/architecture/cell-rfc.md` §6 与 R0-125）。
5. **边界随执行一起生效**。捆仙索、工作目录、工具权限、预算都必须在**工具执行入口**得到确认，
   不能只写进 CellSpec 或 system prompt。
6. **完成不等于通过验收**。执行结束、结果上报、证据有效、验收通过是四个不同阶段。
   协调器不得把模型口头声称、或进程退出码 0 当作交付成功。
7. **本地协作不依赖天桥**。相同语义以后可以映射到天桥传输，但首版离线、多进程、本机单用户
   场景必须能独立运行（`examples/cells/dual-cell.mjs` 即为此而存在）。

---

## 3. v0 部署约束（是选择，不是定义）

**1 Cell : 1 Core : 1 OS 进程。**

选它的理由是"隔离与兼容"：

- 插件是模块级单例（`export default new X()`）；
- `SceneController` 的场景切换作用于整个 Core，不是 Cell 私有；
- 围栏（捆仙索）此前是无 owner 的模块级单值 —— R0-125 已改为带 owner/token 的登记表，
  但**这不等于同进程多 Cell 已安全**：场景、能力视图、事件订阅仍是 Core 级的。

因此 v0 **明确拒绝** `runtime.kind = shared_process | remote`（`unsupported_runtime`），
而不是忽略它们。假装支持会让调用方以为同进程多 Cell 已经隔离好了。

上面这段在 v0.9.20 之前是**文档承诺而非实现**：`CellRuntime.create()` 只判"同 `cell_id` 冲突"，
于是同一个 Core 里可以创建两个都填着 `runtime.kind:'process'` 的 Cell（R0-129 反例实测
`list()` 长度为 2）。v0.9.21 起，同一 Core 已有 Cell 时第二个 `create()` 具名拒绝
`cell_quota_exceeded`，网关的 WS `cell.create` 共用同一实现（配额判定只有一份）。

`N Cell : 1 Host` 将来可以实现而不改 Cell/Task/Result 合同 —— 因为合同里没有一处写着"进程"。

---

## 3.1 执行资格：一个 Cell 的执行身份必须覆盖整个异步生命周期

这是 v0.9.21 补上的最后一条统一。

**问题形状**：执行资格的判据挂在了 `rec.activeTask` 上。`close()` 与超时都会清空它 ——
于是"已经结束的执行"在那之后反而获得最宽松的权限。三处可观测后果（均先复现后修复）：

| 情形 | 修前实测 |
|---|---|
| `close(force)` 后旧对话链发 `tool-write` | 放行；Cell 已 `stopped`、只授予 `tool.read`、`read-only`；且因绑定已释放，文件落到**宿主默认目录** |
| `wall_ms` 超时后旧链发 `tool-write` | 放行，写进 Cell 工作区；任务已报 `timed_out` |
| 超时后立刻 `accept` 第二个任务 | 成功 —— 两段执行并存，`max_active_tasks=1` 名存实亡 |

**修法**（`epoch` / `revokedEpoch` 单调水位，不依赖任何会被清理的可变状态）：

1. 每次 `execute` 取一个递增 `epoch`；`close` / 墙钟超时把 `revokedEpoch` 提到当前值。撤销**单向**。
2. 能力门在 `create` 时装上、常驻，**不再随单次 `execute` 装卸**。判据只有"撤销水位"与
   `gateAllowed`（由 `accept` 写入的 Host ∩ Cell ∩ Task 交集）。修前它在 `finally` 里被
   `removeHooksByOwner` 拆掉 —— 而"拆掉检查器"恰好发生在旧链还活着的时刻，那才是最有特权的瞬间。
3. `inflight` 计数在**真实对话链 settle** 时递减，而不是在 `Promise.race` 结束时。
   （这是最容易写错的一处：race 300ms 返回、底层 `chat.handle` 还要跑 3s。）
4. 未静默 ⇒ Cell 停在 `draining` 并拒接新任务；`close` 在静默前**不释放**工作区绑定。
   静默之后才回 `ready` / 才 `release` —— 安全不以"Cell 永久不可用"或"绑定永久泄漏"为代价。

**诚实边界**：撤销只拦**后续**调用；已发生的写入不回滚。进程内无法证明外部副作用停在哪一步，
所以被撤销的执行即使跑完了也报 `execution_state: unknown`（既非 `succeeded` 也非 `failed`）。
要真正终止，需要独立进程模式下的工作子进程终止 —— 那是部署层的能力，不是本文件的。

---

## 4. 生命周期

```
created ──► ready ──► busy ──► ready
              │        │
              │        └────► draining ──► stopped
              └────► faulted ──► stopped
```

- `busy` 时 `accept` 被拒（`cell_not_ready`）：**一次一个任务**是让"哪个任务写了这个文件"可回答的前提。
- `stopped` 是终态，不能复活（`invalid_state_transition`）。
- **重启收敛**：旧的 `busy` / `draining` 一律收敛为 `faulted`，在飞任务标 `unknown`。
  - 不标 `succeeded`：没有人看过结果；
  - 不标 `failed`：可能已经做完了；
  - 正确反应是"报告不确定，并要求显式确认后再决定是否重试"。

---

## 5. 合同要点（哪些字段为什么必须严）

### CellSpec

| 字段 | 判据 | 拒绝的形态 |
|---|---|---|
| `cell_id` | opaque ID（无路径语义） | `../x`、`a/b`、超长 |
| `workspace` | **绝对**路径，且创建时必须已存在 | 相对路径、不存在、不是目录、状态目录内 |
| `capabilities` | 能力名（`tool.read` 形态）；**执行期在工具入口生效**（见下） | 非法字符、超量 |
| `permission_mode` | 枚举；`full-auto` 需宿主显式开启；`read-only` **执行期生效** | 未知值、未经宿主允许的 `full-auto` |
| `runtime.kind` | v0 只接受 `process` | `shared_process`、`remote`（**明确拒绝**） |
| `limits.max_active_tasks` | v0 只接受 1 | >1 |
| `limits.max_children` | 只能**降**不能升（宿主 cap 默认 0） | 超过宿主上限 |

`state_ref` 只允许 `local:<相对路径>`：首版不做"任意 URI"，因为那会立刻引出
"谁能读别人的 state"，而 v0 没有跨宿主授权模型。

**能力与权限必须是执行期的判据，不能只是准入期的记录**（v0.9.20 修正）。

v0.9.19 里 `accept()` 算出了 `Host ∩ CellSpec ∩ Task`，存进 `pending.effective`，然后没有任何
执行期读者 —— 于是"只授予 `tool.read` 的 Cell"里，模型调 `tool-write` 会**真的写盘成功**；
`permission_mode: read-only` 也只被回显在状态里，写盘照常。同理 `create()` 的 `opts.trusted`
被丢弃、`declare` 硬编码 `trusted: true`，使 `workspaces.roots` 白名单对 Cell 面失效。

现在这三条都落在**工具执行入口**（`registerPreHook`，按 `sessionId` 只作用于本 Cell 的内部会话，
退出时按 owner 卸载），并各自有"该拒的拒、该放的放"两向用例。判据一句话：

> 任何"声明了某权限"的字段，都要能回答**执行路径上谁读它**。答不出来，它就不是判据，只是注释。

### TaskEnvelope

- **Task 不得自带工作区**（`workspace` / `cwd` / `workDir` 一律 `workspace_conflict`）：
  否则任务可以先声明到 `/etc` 再干活，Cell 的固定边界就形同虚设。
- 所有路径引用必须**相对**、不含 `..`（含 Windows 形态的 `..\`）。
- `acceptance` 必填：没有验收条件的任务无法被"接受"或"拒绝"。
- `acceptance.checks` **不**在 v0 被执行：不把模型生成的命令当验收器。它们只作为"要求"记录在案。
- 预算 `max_steps` / `wall_ms` **真执行**：前者按 `agent.step` 事件计数，后者按墙钟竞速。
  超时**如实**标 `timed_out` 并说明"外部副作用未回滚"，不谎称已取消。

### WorkResult

- 产物必须带 64 位 `sha256`：自报"我写了文件"不构成证据。
- 执行状态里**没有** `cancelled`：杀掉进程不证明外部副作用已撤销。
- 验收决定由独立验收器产生（`accepted | rejected | inconclusive`），与执行状态分离。

### 错误语义（全部具名）

`invalid_cell_spec`、`cell_id_conflict`、`cell_not_ready`、`capability_denied`、
`workspace_binding_unavailable`、`workspace_conflict`、`task_conflict`、`task_rejected`、
`budget_exhausted`、`task_timed_out`、`result_unverifiable`、`child_cleanup_failed`、
`execution_unknown`、`unsupported_schema_version`、`unsupported_runtime`、`invalid_state_transition`。

**不得**用 HTTP 200 加一段"对不起失败了"的模型文本代替失败状态。

---

## 6. 威胁模型

| 不可信来源 | 可能的攻击 | 由谁挡 |
|---|---|---|
| 请求方（远端） | 用 `workspace` 字段把模型指向任意目录 | 网关判定回环 + `workspaces.policy`/`roots`（R0-124/R0-125） |
| Task 提交方 | Task 自带 `workspace`/`cwd` 扩边界 | `validateTaskEnvelope` → `workspace_conflict` |
| Task 提交方 | 要求 Cell 没有的能力（提权） | `intersectCapabilities` → `capability_denied`，**执行前** |
| CellSpec 作者 | 写 `permission_mode: full-auto`、`max_children: 3` | 宿主 cap 判据（`invalid_cell_spec` / `capability_denied`） |
| 模型 | 用工具别名/绝对路径绕过 | 工具层 `resolveWorkspacePath`（`out_of_bounds`）+ 能力门 |
| 模型 | 自报"测试已通过" | 验收只看产物 hash 与执行状态 |
| 结果回报方 | 用旧 `incarnation_id` 覆盖新结果 | `incarnation_id` 唯一性 + 键不同即过期 |
| 本机同用户攻击者 | 直接读写文件 | **不在威胁模型内**（同用户，能读的本来就能读） |

### 明确不声称的

- **不是 OS 沙箱**。`tool-bash` 仍可 `cd` 到任何位置、绝对路径不受限；
- **不做不可信多租户**。本内核定位 `trusted-local-only`；
- **不做分布式 exactly-once**。只承诺"可识别重复 + 可审计重试"，副作用不自动回滚；
- **不做同进程多 Cell**（见 §3）。

---

## 7. 与既有实现的关系

Cell 运行时**不实现** Agent loop。它驱动的是已经存在的执行链：

```
Cell.execute
  → core.command('chat.handle')      ← 既有的 haotian-lite
      → model-openai（可选：确定性 Cell 不调模型）
      → tool-executor → tools/*      ← 工作区来自 workspace 服务（会话级）
      → 捆仙索 preCheck/postCheck    ← R0-125 起按 core 归属解析
  → 产物 stat + sha256（只认磁盘上的真实文件）
  → WorkResult（执行事实）
  → verify()：独立验收 → AcceptanceDecision
```

因此"Cell 里跑的就是原来那套执行链"是可检验的，而不是一句类比。

### 与旧用户的关系

- **不启用 Cell 的用户行为完全不变**：`cell-runtime` 只在 `--scene cell` 里装配；
  `gateway` / `coding` / `chat` 等场景一个字节没改。
- 旧系统可以被描述为一个"**隐式单 Cell 宿主**"，但它的多会话**不是**多 Cell 权限隔离。
- 未提供 `tusunsun cell ...` 子命令：API 与示例先稳定，再谈 CLI 表面。

---

## 7.5 认知边界：Cell 的"看什么、听谁的、事后怎么核"（v0.9.22）

这一节回答评审里最少被写清楚的问题：**Cell 的系统提示词、资料与经验，权限从哪来。**

### 三个 Port，一条优先级

```
Host Policy（宿主策略，不可由 Task / 模型改写）
    │
    ├── CellSpec / CellStatus ── ContextProfileRef（宿主授权绑定）
    │                                    │
    │                        ┌───────────▼────────────┐
    │                        │ Cell Context Assembly  │
    │                        │ 来源 → 权限 → 预算 → 组装 │
    │                        └──────┬──────────┬──────┘
    │                     ContextPort      ExperiencePort
    │                  map/pull/assemble    lookup/read
    │                        │                 │
    │               本地有界目录 / none    静态 fixtures / none
    │                        └────────┬────────┘
    │                                 ▼
    └── 执行资格 / 能力 / 数据范围 ──→ haotian-lite → Model
```

**优先级（不可倒置）**：Host Policy > Cell Profile > Task 内容 > 拉取资料 / 经验。

这条顺序不是措辞问题：`ContextProfile` 只替换"宿主默认 `agent.systemPrompt`"这一项，
Host Policy 的能力、权限模式、工作区**不经过提示词**，因此 profile 不可能提权。

### 引用不是路径

`system_prompt_ref` 形如 `local:prompts/reviewer.md`，它是宿主命名空间下的**受限逻辑引用**：

- 只解析 `local:`（没有 `http:`/`file:` 命名空间，因为每多一个就多一条"谁来保证不出网"）；
- 路径部分过 `checkRelativeRef`（绝对路径 / `..` / 空段全拒），再由 provider 在**声明过的根**下解析；
- 读之前 `realpath` 追符号链接，越界即 `profile_out_of_bounds` / `prompt_out_of_bounds`；
- 有大小上限（profile 256KB、提示词 64KB）与类型要求（普通文件）；
- **不回落 cwd**：根没声明就 `context_disabled`，而不是"读到了某个恰好存在的文件"。

### 冻结在 accept，内容在 execute

`accept()` 是同步 API（调用方依赖它同步抛错），读 profile 需要读盘。因此：

- **accept** 同步钉住绑定版本（纯内存快照）；
- **execute** 按钉住版本读内容并校验 hash。

若把两件事都放到 execute（取"当前绑定"），则 accept 之后的一次换绑会改变**已经接下**的
任务的身份 —— 这与"在飞 Task 的 prompt profile 必须冻结"直接冲突。

### 认知调用同样服从执行资格

三个认知工具（`tool-context-map` / `tool-context-pull` / `tool-experience-pull`）：

- 名字以 `tool-` 开头，因此落在 Cell 能力门的 `capIdOf` 判据里 —— **不是**法外之地；
- 走 `ToolExecutor` 同一条链路，因此 R0-129 的撤销（`execution_revoked`）对它们同样生效；
- 执行作用域按 `sessionId` 从 `cell-context` **反查**，模型传 `cell_id` 参数一律忽略；
- 任务结束后 `no_execution_scope`：手里有 ref 也读不到。

### 三种内容不可混淆

| 内容 | 本质 | 默认可信度 | 用途 |
|---|---|---|---|
| 上下文 | 当前任务可能需要的原始信息 | 来源依赖，通常为数据 | 经地图发现、按需 pull；**不能**赋予指令权 |
| 摘要 | 为有限窗口保留的压缩表示（派生） | 派生数据，可能失真 | 带来源范围与版本；需要时能回看原文 |
| 经验 | 从成功/失败/复盘中提炼的、有适用条件的教训 | 依等级与证据，**不能绝对化** | 被动提示或主动拉取；须核对适用条件 |

原则：一段聊天总结"下次应当做 X"**仍然只是摘要**，不构成经验；经验也**不是最高优先级命令**，
而是"在这些条件下曾有效/曾失败的可检查建议"。

### 诚实边界

- 撤销只拦**后续**认知调用，不回滚已发生的写入。
- `retrieved ≠ read_by_model ≠ applied ≠ outcome_improved`：回执只记前两项与"主动展开"。
- 没有真实经验层服务接入；`static` provider 是只读 fixtures，端口是薄接口。
- 不做语义/向量检索；`map` 只有子串命中与顺序截断。

---

## 8. 未来演化（不计入 v0 验收）

| 阶段 | 内容 | 前置条件 |
|---|---|---|
| E2 | 受控 `propose_split`：LLM 提议、确定性准入检查、控制层批准 | 单 Cell 稳定 + 预算/权限隔离已验证 |
| E3 | 同进程多 Cell runtime | 单机负载证明进程开销真的限制收益；场景/能力视图/事件/围栏全部实例化 |
| E4 | 天桥适配：把传输从本地 WS 换成天桥 | Cell/Task/Result 语义不变 |
| E5 | 组织规律 → 调度策略 | 有等预算对照实验与可解释回退 |

**分裂在 v0 不是 Cell 自己做的系统调用**，而是上层提出新 Task / 新 CellSpec、薄协调器审查后创建。
默认为 `max_children = 0`。
