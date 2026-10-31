# ADR-07：六合 Lite 以"内置副本 + 适配插件"形态并入，且默认不进任何场景

- 状态：**已采纳**（v0.13.0）
- 影响面：`vendor/liuhe-lite/`（新增内置副本）、`plugins/liuhe-lite.js`（新增适配层）、
  `plugins/tool-loader.js`、`plugins/tool-executor.js`、`plugins/cell-runtime.js`、
  `plugins/_lib/tool-policy.js`、`scripts/verify-vendor.mjs`、`scripts/core-dep-check.mjs`
- 关联：ADR-04 §8、`docs/reference/cell-api.md`（属主与结算的接口边界）。
  > 此前这里引过一份《致六合团队》外部沟通函（v0.11.0 期的独立核对结论）。那份函已于
  > rc.36 文档整理时下线（它是写给上游团队的、不是本仓文档），原文见 git 历史。

## 1. 要决定的问题

`jieai-liuhe-lite-0.1.3.tgz`（43 文件 / 474 KB / 7 201 行，含它自己 vendor 的 16 个
malong 写路径原语）以什么形态进入土行孙？

上一轮（v0.10.2 的决策请求书）我列了三个候选，倾向 A。本轮专家未裁决，
但用户明确要求"一起合并"——所以我按**技术上可辩护的那个**执行，并把代价写清：

| 候选 | 做法 | 代价 | 本 ADR |
|---|---|---|---|
| **A. 可选插件，默认不装** | 适配层落在 `plugins/liuhe-lite.js`，场景里显式列才启用 | 用户要自己加一行场景配置 | ✅ **采纳** |
| B. 可选插件，coding 场景默认装 | 同上，并在 `scenes/coding.json5` 的 `eager` 里加一行 | 主包默认带一份第三方快照 | ❌ 见 §2 |
| C. 暂不接入，只冻字段 | 只做字段对齐，代码一行不写 | `Lite-in-real-Cell` 永远是 NOT_RUN | ❌ 用户已要求真合并 |

## 2. 为什么不用 B（这条是最需要解释的）

本仓对外的核心承诺之一是**零运行时依赖**。`vendor/ws` 是这条承诺的**唯一例外**，
它的辩护理由是"没有它 WebSocket 就跑不起来"——即**功能上不可替代**。

六合 Lite 不是这种依赖：**没有它，土行孙的功能一个都不少**。
所以它可以内置，但**不能默认启用**。一旦进了 `eager`，
"零第三方代码运行"就变成"零 npm 依赖但带一份 7 201 行第三方代码"——
那不是同一句话，而对外文档里写的正是前一句。

因此：**内置（为了可审计、可核哈希）但默认不装配（为了不改变默认行为）。**
这两件事不矛盾，只是常被混成一件。

## 3. 内置不等于信任

`vendor/liuhe-lite/PROVENANCE.json` 记 43 个文件的逐文件 sha256，
并可被 `scripts/verify-vendor.mjs` 双向核对（多一个少一个都算漂移）。
这一层与 `ws` 用的是同一套规则，但有两处**必须**不同的地方：

1. **它不是 npm 依赖**，所以 `package-lock.json` 里没有它是**预期**，不是漂移。
   版本锚改为上游 tarball 的 sha256（`upstream.tarball_sha256`）。
   把这两种"没有 lock 条目"混成同一句 NOT_RUN，就会掩盖真正的漂移风险。
2. **它自带一层 vendor**（`vendor/malong/`，16 文件）。外层清单只负责
   "这 43 个文件一个字节没动"，**不越权替它证明内层**。内层由它自己的
   `tests/provenance.mjs` 双向核对（含夹带检查）。我们只查一件事：
   **内层清单在不在、说的是不是同一个版本**（`verify-vendor` 的检查 ⑤）。

我刻意**没有**把它的 7 201 行吹成"我们审过了"。我们审的是**接缝**：
六个动作的合同、回执字段、错误码、授权边界。它的写入引擎内部正确性
仍然是它的责任范围——这一点写在 §6 的诚实边界里。

## 4. 披露权在宿主：`apply` / `undo` 不给模型

这是本轮唯一一处**刻意少做**的功能，必须明确写下来，否则后来的人会当成遗漏。

| 动作 | 能力面 | 模型可见工具 | 理由 |
|---|---|---|---|
| `readAnchor` | `liuhe.read_anchor` | ✅ `tool-liuhe-anchor` | 只读；提示词鼓励"改文件前先取锚点" |
| `inspect` | `liuhe.inspect` | ✅ `tool-liuhe-inspect` | 只读；回答"上次到底改了什么" |
| `preview` | `liuhe.preview` | ❌ | 不写盘但读全文算 hash，保守按非只读 |
| `apply` | `liuhe.apply` | ❌ | **改盘**。何时调由宿主/协调器决定 |
| `undo` | `liuhe.undo` | ❌ | **改盘**。撤销是恢复动作，不该由模型自发触发 |
| `reconcile` | `liuhe.reconcile` | ❌ | 只读，但它是**冲突后的诊断**，属于协调层 |

依据是 ADR-04 §8 的语义解释权表（B-4 已由六合确认）：

> **「这条回执该不该给模型看」** 属宿主——即使 provider 说回执为真，能否披露由宿主判。

`apply` / `undo` 仍然**完整可用**，只是入口是 `core.callCapability('liuhe.apply', …)`，
不是模型点名。这个区别在 `_MODEL_VISIBLE` 那张表里是显式的，并由回归锁
`R0-163/A3` 钉住（把 `apply` 加进那张表 → 立刻变红）。

## 5. 合并过程中实测出的四个缺陷（三个在我们自己的代码里）

这一节是本 ADR 存在的主要理由。**"加一个插件"实际上暴露了四处零读者的声明。**

### G1 `registerTool({capabilityId})` 的 `capabilityId` 是死参数

`ToolLoader.registerTool` 用 `spec.capabilityId` 注册了能力，但**没有把它记在目录项上**。
`ToolExecutor._capabilityIdsForTool` 认三条来源（名字派生 / `provides[]` / owner 反查），
显式给的 id 一条都不命中 ⇒ `capId = null` ⇒ 掉进 legacy 直连被 R0-81 拒。

实测：注册 `tool-liuhe-anchor` → `liuhe.read_anchor`，模型点它得到
`capability_denied`（100% 复现，不是概率问题）。

修法：目录项记 `_capabilityId`，执行器**最先**读它（`ids[0]` 就是认定的目标能力）。

### G2 `unregisterTool` 释放的是**另一个**能力

同一处死参数的第二个受害者：注册用 `spec.capabilityId`，注销时却**重新派生**了一遍
`tool.<x>`。两者不同时，释放的是别家能力，而真正那个成为**摘不掉的幽灵**——
返回值还照样报 `capability_released: true`。

实测最坏形态（名字派生 id 与显式 id 同时存在且同 owner）：

```
before: sneaky.real, tool.sneaky
unregisterTool → { ok: true, capability_released: true }
after:  sneaky.real          ← 真正的幽灵留下了
        tool.sneaky 被放掉   ← 那不是本工具注册的
```

修法：读 `entry._capabilityId`（注册时钉下的同一个 id）。

### G3 Cell 能力门在 pre 阶段拿**猜出来的** id 拒人

`_installCapabilityGate` 的 pre 钩子用 `capIdOf(toolName)` 派生能力 id。
对显式登记能力的工具，派生结果是 `tool.liuhe-anchor`——**一个不存在的能力 id**。
旧代码拿到这个非 null 的假 id 就直接进 `allowed.has(...)` 判定 ⇒ 必然 false ⇒ 具名拒绝。

实测：Cell 声明 `liuhe.read_anchor`、`capabilities_effective` 里确实有它，
模型点对应工具照样 `capability_denied (effective: (none))`。

**同一个缺陷有两个受害者**，第二处是我加第一条测试时漏掉的：

- `auto` Cell：granted 判定被假 id 否决；
- `read-only` Cell：只读判定 `isReadonlyCapability(假id)` 为 false ⇒ `permission_denied`。
  后果更隐蔽——只读 Cell 拿不到锚点，只能盲写，"可核验的写入"退化成普通写入。

修法（两处同一句）：pre 阶段的 id 一律标 `authoritative: false`，
**不在 granted 里 / 不是只读时都不表态**，交给 dispatch 用真实能力判。

### G4 能力 id 的驼峰形态被 Cell 契约拒

我第一版用 `liuhe.readAnchor`。`plugins/_lib/cell/contract.js:28` 的 `CAPABILITY_RE`
要求全小写分段，`validateCellSpec` 直接拒：`capabilities contains an invalid entry`。

**契约是对的，改名的是我。** 让外部动作名去迁就 provider 的 JS 风格，
等于让风格决定一个跨系统的标识符。

## 6. 我自己在这一轮犯的三个错（单列，因为都是同一形状）

### 6.1 我给同一件事写了两个机制（变异 M1 抓到）

修 G1 时我**同时**写了 `_capabilityId` 和一个 `provides: [{name: capId}]`，
理由是"执行器认 provides"。变异 M1（删掉 `_capabilityId` 那行）结果 **0 条变红**——
两个机制互相顶替。

这正是本项目反复修的"同一事实写两处"形态，我在修它的同一轮里又犯了一次。
现在只留 `_capabilityId` 一处真值。

### 6.2 我写了一段不承重的代码（变异 M3 抓到）

我最初让 pre 阶段去问 `tool-registry` 要权威 id，想"能确定就早点拒"。
变异 M3（删掉那段 registry 查询）结果 **0 条变红**——因为 dispatch 阶段本来就能拿到
真实能力，pre 拿不拿得到对**结论**没有影响。

它只是一个 fail-fast 优化，代价是耦合另一个插件的**私有 Map**（`_tools`）——
而这个仓在 v0.9.24 已经为同一个形态改过三处（读 `core._capabilities`）。
**删掉。** 宁可晚一点拒，也不要为了早拒重新长出一个私有字段依赖。

### 6.3 我的第一条测试漏了第二个受害者（变异 M3c 抓到）

G3 的第一条测试只覆盖 `permission_mode: 'auto'`。补 M3c 变异时才发现
`read-only` 路径读的也是同一个 `capId`，缺陷一模一样。
补了 `R0-163/G3c` 之后，同一个变异让 **3 条**变红（G3 / G3c / G3b）。

**"一条测试通过"从来不等于"这个判据在两个方向上都成立"**——与 v0.12.0
M4（Verify 段第一轮 0 红）是同一个教训，这次它发生在我的新锁上。

## 7. 诚实边界（不得读成"已经做了"）

- **写入引擎内部正确性不由本 ADR 担保**：原子写 / 事务日记 / Undo / 三方 hash
  是六合的实现，我们审的是**接缝**（六动作合同、回执字段、错误码、授权边界）。
  我们的回归锁里跑它自己的 28 条矩阵与 15 条 parity，那是"它仍然自洽"，
  不是"我们验证了它正确"。
- **`verification` 恒为 `not_run`**：Lite 不跑代码检查，我方也不代填。
  写入成功 ≠ 代码语义正确。
- **`recovery.supported` 不是"一定能撤销"**：它只说"有日记、且未过期"。
  撤销仍要过所有权（`FOREIGN_JOURNAL`）与"文件未被后续修改"（`UNDO_CONFLICT`）。
- **Lite 不是事务引擎的全集**：单文件、单工作区、UTF-8 文本、≤ 1 MiB。
  跨文件请用六合 `edit_transaction`。
- **Node 18 / 20 未复验**：本轮所有联调都在 Node 22.22.2 上跑的。
  Lite 自己的 `engines.node` 是 `>=18`，我们未在该版本上跑过。
- **Windows / macOS 未复验**：与上一轮相同，NOT_RUN，不折算通过。

## 8. 连带发现：跑它的测试会修改内置副本

`vendor/liuhe-lite/tests/run.mjs` 默认把报表写进 `vendor/liuhe-lite/reports/`。
也就是说**"跑测试"这个动作会修改内置副本**——实测跑完一次 `verify-vendor` 立刻红：

```
· vendor/liuhe-lite/reports/matrix-report.json 不在清单里（新增了未登记的文件）
```

门禁抓到的是"内置副本被改了"，而改它的正是我们自己的测试。
这是"内置副本"这个形态下一次很常见的自伤，记在这里以免复现：
我们的回归锁用 `--no-report` 跑，副本保持字节不变。

## 9. 未采纳的替代方案

| 方案 | 为什么不 |
|---|---|
| 装 npm 包而不是内置 | 它不发布 npm（`README` 明说），且内置才能让"装得到 + 哈希核得了"同时成立 |
| 抽一个独立事务引擎 | 计划书 §6 L3 已裁决"Adapter first，不抽 Lite"；我们没有维护那套引擎的能力 |
| 在适配层复刻它的判据 | 那会把别人的实现变成我的第二份真相，两份必然漂 |
| 把 `apply`/`undo` 也给模型 | 违反披露权归属（§4），且模型自发撤销不是需求 |
| 改它的 `persistence` 口径 | v0 各留各的、v1 归一（ADR-06 / B-2 已冻结）；在 v0 改名就是换义 |
