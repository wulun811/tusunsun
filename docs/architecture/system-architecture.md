# 土行孙系统架构（0.20.4）

> 这份文档讲**整个随包系统**：内核、**全部随包插件**、场景配方，以及它们之间的接口。
>
> 和另外几份的分工：`microkernel.md` 只拆内核那 4896 行怎么构成；
> `function-ownership.md` 只回答"某个可变事实谁有写入权"；
> `kernel-boundary.md` 回答"什么该进内核、什么不该"。
> **本文回答"谁在哪一层、靠什么连起来、一次调用会经过谁"。**

**每个数字都可以自己复核**，命令写在对应小节里。数字变了而本文没改，说明本文过期了 ——
请以命令输出为准。

---

## 0. 三十秒版本

```
入口            tusunsun.mjs → scripts/cli.mjs ／ gateway（HTTP）
                     │
装配            scenes/*.json5（include + eager + lazy + plugins + optional）
                     │  依赖拓扑、生命周期、世代
内核            src/core/  8 文件 · 4896 行 · 0 个 npm 运行时依赖
                     │  能力派发（Attempt / Waiter）· 事件 · 服务
插件            plugins/  40 个根插件 + 10 个工具插件 + 22 个库文件
                     │
外围            vendor/（ws、liuhe-lite）· examples/（Cell 与自定义插件）
```

一句话分工：**内核只管六个语义（权属 / 契约 / 执行 / 转移 / 观测 / 收敛），
其余一切——模型、工具、记忆、网关、Cell、代码操作——都是可装卸的插件。**

---

## 1. 分层与规模

| 层 | 位置 | 规模 | 变化频率 |
|---|---|---|---|
| 入口 | `tusunsun.mjs`（73 行）、`scripts/cli.mjs`（820 行） | 893 行 | 中 |
| 内核 | `src/core/*.js` | **8 文件 / 4896 行** | **极低**（有行数预算，见 ADR-10） |
| 插件 | `plugins/*.js` | **40 文件 / 20163 行** | 高 |
| 工具插件 | `plugins/tools/*.js` | **10 文件 / 1281 行** | 高 |
| 插件库 | `plugins/_lib/**` | **22 文件 / 4767 行** | 中 |
| 场景配方 | `scenes/*.json5` | 10 个 | 高 |
| 内置第三方 | `vendor/ws`、`vendor/liuhe-lite` | 逐文件 sha256 校验 | 低 |
| 示例 | `examples/` | 10 个文件（含 2 个 Cell 示例） | 低 |

复核（**两个口径分清楚**）：

- 内核行数用**官方口径** `node scripts/core-manifest.js`（`split('\n')` 计数，末尾换行算一行）→ 合计 **4896**。
  用 `wc -l` 会得到 4881（每个文件少 1），两者差 8 = 文件数，**不是谁错了**。
- 插件行数用 `wc -l`。

```bash
node scripts/line-check.js | tail -6            # 内核：src/core 总行 4896/4896
ls plugins/*.js | wc -l; wc -l plugins/*.js | tail -1     # 40 / 19489
ls plugins/tools/*.js | wc -l; wc -l plugins/tools/*.js | tail -1
```

**为什么内核小、插件大不是问题**：内核承载的是"每次执行都必须成立的规则"，
插件承载的是"某种能力怎么做"。前者变了要重审全部语义，后者变了只影响自己 ——
所以两者的预算与评审强度不同（见 `docs/architecture/kernel-boundary.md`）。

---

## 2. 入口与进程形态

| 形态 | 入口 | 用途 | 说明 |
|---|---|---|---|
| CLI | `node tusunsun.mjs …` | 交互、场景管理、启动 | `tusunsun.mjs` 只做转交，实际实现在 `scripts/cli.mjs` |
| HTTP 网关 | `plugins/gateway.js` | OpenAI 兼容端点、健康检查 | 默认只监听本机；`/v1/chat/completions`、`/health`、`/ready`、`/ming/push` |
| 库 | `src/core/core.js` 的 `createRuntime()` | 被示例与下游嵌入 | 不经过 CLI |
| 多进程 | `examples/cells/*.mjs` | 两个**独立进程**的 Cell 协作 | 演示用，不是生产编排 |

**只有一种内核**：无论从哪个入口进来，装配、派发、状态机、事件都是同一份 `src/core/`。

---

## 3. 内核：8 个文件

| 文件 | 行数 | 职责 | 主要语义 |
|---|---:|---|---|
| `core.js` | 2311 | 能力注册/释放、派发、事件、服务表、装配世代 | Authority、Contract、Invocation、Evidence |
| `plugin-manager.js` | 870 | 发现、装载、懒加载、回收、重载 | Transition |
| `lifecycle-manager.js` | 577 | 插件七态状态机，唯一跃迁写入者 | Transition |
| `scene-controller.js` | 460 | 场景切换五段式 | Transition、Reconciliation |
| `dependency-resolver.js` | 417 | DAG 构建、拓扑排序、SemVer 判据 | Contract |
| `plugin-meta.js` | 131 | 插件清单解析、名字与格式校验 | Contract |
| `json5-loader.js` | 88 | 带注释配置解析 | — |
| `env.js` | 35 | `.env` 读取 | — |

### 3.1 一次启动的装配流水线

```
① 发现      扫描装配根 plugins/（含 tools/ 子目录），得到"名字 → 文件"
② 清单      plugin-meta 解析 manifest（v2 清单 或 类字段），校验名字/API 版本
③ 规划      读 scenes/<name>.json5：include 展开 → eager/lazy/plugins/optional 合并
④ 拓扑      dependency-resolver 建 DAG、排序、判环；缺依赖则具名拒绝
⑤ 装载      lifecycle-manager 逐个推进状态（每步校验合法边）
⑥ 就绪      readiness 聚合：ready / degraded / unavailable
```

每一段都有对应的失败出口，而且**失败是具名的**（`cyclic_dependency`、`invalid_state_transition`、
`scene_preflight_failed`…），不是"装失败"三个字。

### 3.2 一次能力调用的路径

```
调用方（插件 / 网关 / Cell）
   └─ core.callCapability(id, params, opts)
        ├─ 解析能力 → 取登记记录（含 provider/owner）
        ├─ 守卫：身份 / 权限 / scope / input_schema   ← 在真实 handler 之前
        ├─ 记账：_dispatchCapability 登记 Attempt（唯一 +1/−1 位置）
        ├─ 执行：handler(params)
        └─ Waiter：等待方可以超时；**超时只结束等待，不撤销执行**
```

关键性质（I-03，可被探针复现）：**「调用方不等了」与「副作用停了」是两件事。**
超时返回的是"未知"，不是"失败"；重试前必须核对，不能把未知当安全。

### 3.3 场景切换五段式

`scene-controller.js` 的 `switchTo` 依次经历：**Plan → Preflight → Apply → Verify → Commit**，
只有全部到齐才提交 `currentScene` 与持久配置；卸载不干净时明确拒绝提交场景身份。
（反例 K-04 就是"缺插件也返回 ok:true"，现已修复并被探针守着。）

---

## 4. 插件体系

### 4.1 两代清单

| 代际 | 写法 | 数量 | 校验 |
|---|---|---|---|
| v2 清单 | `manifest = { schema_version: 'tusunsun.plugin/v2', name, api_version, owner, provides, requires, surfaces, degraded_policy }` | 8 个 | `admission-gate` 在 productionStrict 下强制 |
| 类字段 | 类上直接写 `name` / `provides` / `requires` | 其余 | 装载期宽松校验 |

两代并存是**迁移中的事实**，不是设计目标：新插件请写 v2 清单。

### 4.2 能力（capability）与服务（service）

| | 能力 | 服务 |
|---|---|---|
| 声明 | `provides: [{ name: 'tool.read', type: 'capability' }]` | `provides: [{ name: 'model', type: 'service' }]` |
| 取用 | `core.callCapability(id, params)` | `core.getService(name)` |
| 守卫 | 身份 / 权限 / schema 逐次校验 | 同步返回对象，**不逐次校验** |
| 超时语义 | Attempt 可超时，副作用未知 | 不适用 |

**这是个必须先讲清的边界**：`getService` 返回的是对象引用，拿到就能用，绕过能力层校验。
所以"受保护能力"必须注册成**能力**而不是服务（详见 `kernel-boundary.md` 与
`contracts/capability-identity-v1.md`）。

### 4.3 生命周期

七态：`registered → started → running → stopped → unloaded`，另有 `error`、`unavailable`。
**唯一跃迁写入者是 `lifecycle-manager.js` 的 `advance()`**，`register()` 只写初始值。
每次跃迁校验合法边，非法边抛 `invalid_state_transition`（带 from/to）。

### 4.4 懒加载与回收

懒加载插件只在被能力解析命中时装载；`_lazyLoaded` / `_pending` 两张表表达
"曾懒装"与"可懒装"。回收策略**不在内核里** —— 内核只读
`getService('recycle-advisor').pollRecycleDecisions()`，策略由 `recycle-advisor` 插件提供。

> 诚实边界：这两张缓存当前有 **7 个机制**在写（`P2-4` 未收敛），
> 登记见 `docs/architecture/function-ownership.md` §2.1 的 `lazyCache` 行。

### 4.5 安全护栏的分层

| 层 | 谁 | 拦什么 |
|---|---|---|
| 执行资格 | 内核守卫（`callCapability` 内） | 身份、权限、scope、schema |
| 危险操作闸门 | `kunxiansuo-local`（`tool.fence`） | 黑名单硬拒绝、路径边界、熔断、速率 |
| 破坏性确认 | `plugins/_lib/destructive-gate.js` | 不可恢复操作要求说明必要性/范围/可恢复性；Y025 是**注意力确认**，不是人工批准，也不是沙箱 |
| 进程隔离 | `sandbox`（`fork` 子进程） | 命令执行的进程边界 |
| 配置/环境 | `admission-gate`、`productionStrict` | 清单合规与依赖闸门 |

**必须说清的边界**：这些都是**逻辑控制**，不是 OS 级沙箱。同进程受信插件、
不受限 `tool-bash` 不能当作不可信代码隔离。适用范围是可信本地环境。

---

## 5. 随包插件全表

> 40 个根插件 + 10 个工具插件，逐个列出。"提供"一列取自插件自身声明。
> 复核：插件表以各文件清单为准；内核事实的权属登记见 `docs/architecture/function-ownership.md`。

### 基座与治理（`base-system` 场景的核心）

| 插件 | 行数 | 提供 | 清单 |
|---|---:|---|---|
| `admission-gate` | 253 | governance | v2 清单 |
| `config` | 410 | config | v2 清单 |
| `runtime-env` | 231 | runtime-env | v2 清单 |
| `assembly-lock` | 201 | assembly | v2 清单 |
| `event-sink` | 61 | event-sink | v2 清单 |
| `readiness` | 101 | readiness | v2 清单 |
| `health` | 132 | health.monitor（服务） | 类字段 |
| `heartbeat` | 153 | —（定时任务） | 类字段 |
| `privacy` | 52 | privacy（服务） | 类字段 |

### 装配与工具执行

| 插件 | 行数 | 提供 | 清单 |
|---|---:|---|---|
| `tool-loader` | 477 | tool-registry（服务） | 类字段 |
| `tool-executor` | 2690 | tool-executor、tool.compose、action.inspect | v2 清单 |
| `tool-guard` | 126 | tool-guard（服务） | 类字段 |
| `tool-normalizer` | 57 | tool-normalizer（服务）、tool.toOpenAI、tool.toAnthropic、tool.describe | 类字段 |
| `sandbox` | 446 | sandbox | v2 清单 |
| `kunxiansuo-local` | 120 | kunxiansuo.local（服务）、tool.fence | 类字段 |
| `scene-inspect` | 170 | scene.inspect | 类字段 |
| `scene-switch-listener` | 108 | scene.list、scene.current、scene.switch | 类字段 |
| `recycle-advisor` | 91 | recycle-advisor（服务） | 类字段 |

`tool-executor` 是插件层最大的一块：它把"工具调用的准备、护栏、结算、回执"
收在一处，避免每个工具各写一遍。**注意它仍是插件** —— 内核不知道"工具"这个概念。

### 模型 / 会话 / 上下文

| 插件 | 行数 | 提供 | 清单 |
|---|---:|---|---|
| `model-openai` | 692 | model（服务） | 类字段 |
| `session` | 253 | session（服务） | 类字段 |
| `haotian-lite` | 831 | chat.handle | 类字段 |
| `context-manager` | 454 | context（服务） | 类字段 |
| `context-port` | 485 | context-port（服务） | 类字段 |
| `experience-port` | 574 | experience-port（服务） | 类字段 |
| `compaction` | 287 | compaction（服务） | 类字段 |
| `prompt-builder` | 282 | prompt（服务） | 类字段 |
| `prompt-template` | 43 | prompt-template（服务） | 类字段 |
| `ying-mini` | 778 | ying-mini、memory（服务） | 类字段 |

### 接口面

| 插件 | 行数 | 提供 | 清单 |
|---|---:|---|---|
| `gateway` | 1208 | gateway | 类字段 |
| `chat-ui` | 1613 | route./、route./chat、route./api/config | 类字段 |
| `tui` | 758 | —（CLI 命令提供者，不是插件） | 类字段 |
| `channel-base` | 59 | —（渠道扩展基类，供 `examples/channel-*.js` 继承） | 类字段 |

### Cell

| 插件 | 行数 | 提供 | 清单 |
|---|---:|---|---|
| `cell-runtime` | 2188 | cell-runtime（服务） | 类字段 |
| `cell-context` | 552 | cell-context（服务） | 类字段 |
| `cell-file-txn` | 1031 | cell-file-txn（服务）、tool.txn-plan、tool.txn-commit、tool.txn-status、txn.inspect、txn.undo | 类字段 |

### 代码操作

| 插件 | 行数 | 提供 | 清单 |
|---|---:|---|---|
| `liuhe-lite` | 551 | liuhe-lite（服务）、liuhe.read_anchor / preview / apply / inspect / undo / reconcile | 类字段 |

六合 Lite 是**可选器官**：真正的实现在 `vendor/liuhe-lite/`（逐文件 sha256 校验），
插件只负责把它接上土行孙的能力边界。内核完全不知道"代码编辑"这回事。

### 插件上下文 / 工作区

| 插件 | 行数 | 提供 | 清单 |
|---|---:|---|---|
| `plugin-context` | 175 | plugin-context（服务） | 类字段 |
| `workspace` | 503 | workspace（服务） | 类字段 |

### 未由任何随包场景装配（如实登记）

| 插件 | 行数 | 说明 |
|---|---:|---|
| `agent` | 114 | `AgentPlugin` 基类形态，没有场景引用它 |
| `tools` | 197 | 早期聚合式工具插件（bash/read/write/list/stat），已被 `plugins/tools/*` 逐个取代 |

这两份**随包但不装配**：它们不是"坏文件"，但读架构时不该以为它们在生产路径上。
`scene-inspect` 由 `npm run scene:inspect` 按需装载，`recycle-advisor` 由场景 `optional` 引入，
`tui` / `channel-base` 是库与命令提供者 —— 都不属于"场景插件"。

### 工具插件（`plugins/tools/`，懒加载池）

| 插件 | 行数 | 能力 |
|---|---:|---|
| `tool-bash.js` | 132 | tool.bash |
| `tool-cp.js` | 187 | tool.cp |
| `tool-list.js` | 55 | tool.list |
| `tool-mv.js` | 120 | tool.mv |
| `tool-read.js` | 101 | tool.read |
| `tool-rm.js` | 319 | tool.rm |
| `tool-stat.js` | 48 | tool.stat |
| `tool-todo.js` | 79 | tool.todo |
| `tool-validate.js` | 67 | tool.validate |
| `tool-write.js` | 182 | tool.write |

工具插件**默认不装载**：`tool-loader` 扫描并按需加载，场景通过 `plugins` 列表声明可用集合。
所以"纯对话"场景真的没有 bash 能力，不是因为开关关了，而是因为那个文件没进来。

---

## 6. 场景配方矩阵

场景 = `include` + `eager` + `lazy` + `plugins` + `optional`。`base-system` 是所有场景的基底。

| 场景 | 定位 | eager | lazy | 额外声明 |
|---|---|---:|---:|---|
| `base-system` | 所有场景的基底 | 9 | 0 | — |
| `chat` | 纯对话，无工具 | 3 | 0 | — |
| `coding` | 编程助手（含工具执行 + 护栏） | 9 | 1 | — |
| `gateway` | 网关：模型代理 + 工具 + 安全底座 | 12 | 0 | 27 个 `plugins`、1 个 `optional` |
| `gateway-lite` | 轻网关，纯模型代理 | 4 | 0 | — |
| `cell` | 单 Cell 运行形态 | 5 | 0 | — |
| `file-txn` | 受控多文件事务（Cell × 六合） | 6 | 1 | — |
| `agent-platform` | Agent 扩展装配起点 | 2 | 0 | 13 个 `optional` |
| `san-cai` | 三才联调 | 5 | 0 | 不 include `base-system` |
| `iot` | IoT 设备控制骨架 | 2 | 0 | — |

复核：

```bash
node scripts/scene-inspect.mjs --all
```

**`gateway` 与 `coding` 的区别值得单独说**：两者都装 `tool-executor`，
但 `coding` 还装 `sandbox` 与 `kunxiansuo-local`（护栏默认在场），
而 `gateway` 通过 `plugins` 列表显式声明可用工具集。**能力面由场景决定，不由内核开关决定。**

---

## 7. 三条端到端路径

### 7.1 纯对话（`chat`）

```
CLI/网关 → haotian-lite 的 chat.handle → prompt-builder 组装上下文
        → model-openai 调 OpenAI 兼容端点 → session 落盘 → 回执
```

这条路径**不需要任何工具能力**，也不需要 API Key 就能跑场景枚举与离线检查。

### 7.2 编程（`coding`）

```
模型返回 tool_call
  → tool-normalizer 统一工具描述格式
  → tool-executor 准备（护栏 → 沙箱 → 结算）
      ├─ kunxiansuo-local：黑名单 / 路径边界 / 熔断
      ├─ tool-guard：按请求名与 provides 判定放行
      └─ sandbox：fork 子进程执行
  → 能力结算：succeeded / failed / 超时未知
  → 回执（区分"意图"与"事实"）
```

### 7.3 Cell（`cell` / `file-txn`）

```
Cell 身份 + CellSpec（能力交集） + Task
  → cell-context 绑定可信配置
  → cell-runtime 把 Cell 接到既有执行链（它自己不实现执行）
  → cell-file-txn：多文件事务（锚 / 预演 / 提交 / 撤销）
```

`cell-runtime` 是**门面**而不是第二套执行器 —— 这条边界很关键，
否则会出现"两个地方各自解释一次执行"的老问题（R018 那类）。

---

## 8. 扩展点

### 8.1 加一个工具（最常见）

1. 在 `plugins/tools/` 建文件，`provides: [{ name: 'tool.xxx', type: 'capability' }]`
2. 写 `init(core)` 并 `registerCapability`，参数用受限 JSON-Schema 子集声明
3. 在场景的 `plugins` 列表里加名字
4. 若涉及破坏性操作，走 `_lib/destructive-gate.js`，不要自己发明确认流程

**不需要改内核。** 如果你觉得需要，先读 `docs/architecture/kernel-boundary.md`
与 `docs/architecture/core-invariants.md` —— 多半说明"状态机缺一个转移"或"边界该登记"，而不是"内核该认识这个工具"。

### 8.2 加一个服务

同上，但提供 `type: 'service'`。**先想清楚它是不是该做成能力**：
服务拿到即用、不逐次校验，适合"基础设施"（配置、事件、沙箱），
不适合"权限敏感操作"。

### 8.3 加一个场景

复制 `scenes/chat.json5` 改 `eager` / `plugins`，然后 `node tusunsun.mjs scene show <name>` 看装配了什么。

---

## 9. 证据与约束（这套架构靠什么守住）

| 资产 | 位置 | 作用 |
|---|---|---|
| 六语义 × 10 条不变式 | `docs/architecture/core-invariants.md` | 评审清单，每条有判据或反例 |
| 事实权属表 | `docs/architecture/function-ownership.md` | 谁有权写哪个可变事实；逐项登记与判据见该文档 §2 |
| 内核边界 | `docs/architecture/kernel-boundary.md` | 什么该进内核、每个职责的权威写入点 |
| 合同 | `verification/contracts/`、`contracts/` | 版本化承诺与覆盖判据 |
| 27 套探针 | `test/probes/` | 每条断言的退出码可直接判读 |
| 发布门禁 | `scripts/release-gate.mjs` | 汇总矩阵，逐项给理由 |
| 模型检查 | `verification/run-formal.mjs` | 形式化场景与突变体（源码树才有） |

状态词只有七个：`MODEL_PASS_BOUNDED`、`MODEL_COUNTEREXAMPLE`、`MODEL_INCONCLUSIVE`、
`IMPLEMENTATION_PASS`、`IMPLEMENTATION_COUNTEREXAMPLE`、`NOT_RUN`、`NOT_MAPPED`。
**裸 `VERIFIED` 是禁用的** —— 它说不清"验到什么程度"。

---

## 10. 两种载体

同一份代码有**两种形态**，结论不能互相顶替：

| | 源码检出 | npm 制品 |
|---|---|---|
| 有 `verification/`（形式化、合同、证据） | ✅ | ❌ |
| 有 `.github/`、`package-lock.json` | ✅ | ❌ |
| 有 `docs/`、`test/probes/`、`scenes/`、`plugins/` | ✅ | ✅ |
| 发布门禁能否签"全绿" | 能 | **不能**（缺前置，如实记 SKIP/NOT_RUN） |

所以"我在本地跑过了"与"制品在别人机器上能跑"是两个结论。
`test/lib/carrier.mjs` 负责判断当前是哪种形态，并让只属于源码树的判据如实记 `NOT_RUN`。

---

## 11. 当前不交付 / 已知边界

写在这里是为了让"没做"和"做了但不够"区分开：

- **不是 OS 级沙箱**：权限门是逻辑控制，同进程不可信插件挡不住。
- **同进程多 Cell 不支持**；多 Cell 只以两个独立进程演示。
- **分布式 exactly-once 未交付**。
- **懒加载缓存未收敛**（7 个机制写两份表）。
- **合同 `capability-identity-v1` §5 有一行与代码不符**（代码已改凭据制，合同仍记旧结论），
  待随下一版升版修正 —— 见 `docs/architecture/function-ownership.md` §4 的同名说明。
- **机器人 / 跨设备 Cell** 是方向，不是现状。

---

## 12. 想继续往下读

| 你想知道 | 读哪份 |
|---|---|
| 内核那 4896 行怎么分 | `docs/architecture/microkernel.md` |
| 什么该进内核 | `docs/architecture/kernel-boundary.md` |
| 某个事实谁写 | `docs/architecture/function-ownership.md` |
| 三台状态机与跨机器读 | `docs/architecture/core-transition-contracts.md` |
| 怎么改内核 | `docs/architecture/kernel-boundary.md` |
| 怎么加插件 | `docs/guides/plugin-development.md` |
| 场景怎么配 | `docs/guides/scene-system.md` |
| 为什么这么决策 | `docs/adr/` |
