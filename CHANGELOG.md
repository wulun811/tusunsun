# 版本历史

## v0.20.2 (2026-11-01)：Y025 软闸的模型闭环

> 公开轨道当前版。`src/core/` 一行未改（8 文件 / 4889 行 / 260153 B）；
> 只修外围链路：执行器已经算出的影响面，要送到模型能看见、能按合同重试的位置。
>
> **发布裁决：Developer Preview（可信本地）**，本段不声称取得任何外部验收。

### 1. 断点 → 修法

| 断点 | 事实 | 修法 |
|---|---|---|
| 挑战到不了模型 | `haotian-lite._execTools` 只对 `blocked` 走 `toLLMText`；`needs_reasoning` 落进通用分支，只剩 `Error: ${tr.error}` | 新增 `toNeedsReasoningText(tr)`（`plugins/_lib/diagnostic-lite.js`）：只读 `tr.challenge`，渲染实测 files/dirs/scope/truncated/样本/四个问题/重试字段；有界（样本 ≤ 8、单条路径 ≤ 200 字符、整体 ≤ 4000 字符）；载荷损坏时明确报告，不猜数字 |
| 模型发现不了重试合同 | `tool-bash.parameters` 只有 `command` | 增加**可选** `danger_ack: { reason, files, scope }`（模型可见）；`declarableSchema()` 把它剥成属性级 `type` 交给注册层 —— 内核只校验属性类型、不递归子结构，两份声明各自有效 |
| 确认字段可能漏进业务参数 | 只在「确认通过」那一支剥离 | 移到软闸之后、派发之前**无条件**剥离；`full-auto` 或软闸关闭时也不漏 |
| 审计把「模型复述」写成「批准」 | 日志只有 `irreversible op confirmed` | 追记 `ack_by: 'model-restatement'`、`human_approved: false` |
| 懒加载前后 schema 不一致 | `tool-loader` 回收后的存根把 `parameters` 写死成 `{}` | 存根保留声明过的 `parameters`：懒索引 / 加载后 / 回收后对模型是同一份契约 |

### 2. 判据（`test/unit/test-r0-171-y025-model-closure.test.mjs`，4 条）

- **T1** 第一次危险调用 → `needs_reasoning`；下一轮模型输入里可见 `Y025`、`files: 3`、`scope: inside`、四个问题与 `danger_ack` 结构；**文件未动**
- **T2** 模型按上一轮读到的文本填 `danger_ack`（`files`/`scope` 从挑战文本解析，不是测试预置）→ 进入原执行路径，`rm -r d1` 真实删除；handler 收不到 `danger_ack`；审计 `human_approved: false`
- **T3** 相邻反例矩阵：数字错 / `mixed` 报成 `inside` / 理由 < 24 字 / 三次失败封闭 / 10 分钟过期 / `unbounded` 不得伪装 / 载荷损坏 / 输出有界
- **T4** 懒索引 → 加载 → 回收三处 schema 一致；`input_schema` 只保留属性级 `type`

### 3. 实测

| 形态 | 单元测试 | 集成 | 冒烟 |
|---|---|---|---|
| **开发树**（公开树源码检出，Linux x64 / Node 22.22.2） | 1513 总 / 1513 通过 / 0 失败 / 0 跳过 | 63/63 | 2/2 |
| **npm 制品**（解包后） | 1513 总 / 1503 通过 / 0 失败 / 10 跳过 | 63/63 | 2/2 |

- 开发树 27 套探针全部 rc=0；制品 **437 个文件 / 约 1.81 MB**；`src/core/` 8 文件 / 4889 行 / 260153 B 未变。
- 计数口径：单测按 `test/unit/*.test.mjs` 注册的用例数计；集成按 `test/integration/*.test.mjs` 注册的用例数计；冒烟按套件用例计。开发树与制品分开报，不互相顶替。
- 验收脚本退出码三档：`0` = 通过；`1` = 有失败项；`2` = **通过数为 0**（含**找不到 npm** 或没有可跑用例）。跳过一律记 NOT_RUN，**不折算**为通过。

### 4. 边界

- **Y025 是注意力确认**，不是人类批准，不是 OS 级沙箱，也不是可撤销事务；模型复述数字只证明它看到了影响面。
- `full-auto` 只豁免「确认/打断」：围栏判据（敏感路径、路径边界、读前必读、熔断、限流）照常跑，仅不可恢复命令的 `CMD_GUARD` 因等价于已预授权而让路；Y024 硬拦仍先于软闸，且不因确认而放行。
- `unbounded` 不等于安全；`mixed` 不等于授权 —— 文案里都如实说。
- 性能对照仍取自开发线 `0.20.1` 树；`0.20.2` 未按同一口径重跑，新增的工具参数声明与挑战文本可能略微改变回合上下文。

### 5. 未做

- npm registry 发布：本版未执行 `npm publish`；等渠道配置与显式授权后再发。
- `v0.20.2` git tag：等三平台 CI 绿后按发布清单处理，不在本提交里自行打 tag。

## v0.20.1 (2026-10-30)：文档版 —— README 叙事重写 + 系统架构说明 + 同机对照

> 产品代码一行未动：`src/core/` 仍 8 文件 / 4889 行；插件行为不变。
> 本版改的是“关于代码的主张”与“让主张能被复核”。

- README / README.en 以叙事结构重写，补入 LLM-native 定位与四张只随仓库分发的架构插图。
- 新增 [`docs/architecture/system-architecture.md`](docs/architecture/system-architecture.md)：覆盖全部随包插件、场景装配与端到端调用路径。
- 新增 [`docs/quality/system-bench-2026-10-31.md`](docs/quality/system-bench-2026-10-31.md) 与可复跑的 `verification/perf/system-bench.mjs`：启动、常驻内存、固定上下文与同机密度的测量方法与原始样本。
- 性能对照在开发线 `0.20.1` 树上测得，公开仓未重跑；数字与边界（不是“快 8 倍”、不是“密度 8×”、不是“省 70%”）在 README §07 与报告里写清。

## v0.20.0 (2026-10-30)：首个公开开源版

> 发布状态：**Developer Preview**。公开仓自本版起作为 OSS 版事实源；此前的内部迭代记录不随公开仓发布。
> 版本号从 `0.20.0` 起进入公开轨道，`0.17` / `0.18` / `0.19` 从未存在过。

### 1. 公开轨道的第一版

| 段 | 范围 | 性质 | git tag |
|---|---|---|---|
| 内部迭代轨道 | `0.1.0` → `0.16.0-rc.36` | 开发期逐轮迭代与内部审查快照，不随公开仓发布 | 不公开 |
| 公开轨道 | `0.20.0` 起 | 面向外部使用者，每个公开版必有 tag | `v0.20.0`（待打；三平台绿后） |

不把版本号直接跳到 `1.0.0`：`1.0.0` 承诺公开 API 不再破坏性变更，而当前仍有 macOS / Windows
真实机器、浏览器侧安全 E2E、制品形态真实模型链路等未完成项。继续留在 `0.x` 是如实表述。

包名保持 **`tusunsun`**。开发仓目录名是 `tuxingsun`，公开仓是 `tusunsun`；制品、provenance
回执与 `User-Agent` 全按 `tusunsun` 记账。

### 2. 公开仓交付面

本版 `src/core/` 逻辑未改；产品层只做了公开仓必需的修正与发布前围栏修复（见 §6）：去掉一处内部代号注释；
修复 Windows 上 `scene list` 与场景路径解析（绝对路径判断改用 `node:path` 的 `isAbsolute` / `sep`，
不再假设分隔符是 `/`）。核心 **4889 行 / 260153 B**（预算 260189 B），核心指纹已按
`node scripts/core-manifest.js --write` 更新。公开仓交付面清理：

- 不包含内部评审记录、第三方评审原件、私有引擎、内部发布脚本与生成物。
- 不包含制品哈希清单（本机制品由 CI 重新打包，本地 tarball 哈希不可复现，不入仓）；制品完整性以 npm registry 的 integrity 为准。
- 第三方代码随包：`ws`（MIT）与 `@jieai/liuhe-lite`（MIT，含 `malong` 子树），逐文件 sha256
  见 `vendor/*/PROVENANCE.json`，可用 `node scripts/verify-vendor.mjs` 复核。
- 文档保留当前架构、ADR、指南与质量/压测记录；历史版本评审记录不随公开仓发布。

### 3. 实测数字（开发树与制品分列）

| 形态 | 单测 | 集成 | 冒烟 | 说明 |
|---|---|---|---|---|
| **开发树**（快照前） | 1509 总 / 1509 通过 / 0 失败 / 0 跳过 | 63/63 | 2/2 | 公开树取自该树快照；两边清理不同，数字不互相顶替 |
| **公开树** ubuntu-latest / Node 22 | 1509 总 / 1509 通过 / 0 失败 / 0 跳过 | 63/63 | 2/2 | 2026-11-01 Actions 实测（围栏修复后） |
| **公开树** macos-latest / Node 22 | 1509 总 / 1504 通过 / 0 失败 / 5 跳过 | 63/63 | 2/2 | 5 条 SKIP 为 `/proc` 依赖（进程组回收、僵尸判活），不折算通过 |
| **公开树** windows-latest / Node 22 | 不跑全量（含 POSIX-only 用例） | — | 2/2 | gates + windows-release 2/2 + install-acceptance 12/12 |
| **npm 制品**（净室） | 1509 总 / 1499 通过 / 0 失败 / 10 跳过 | 63/63 | 2/2 | Ubuntu CI `package` 作业在制品目录内实测；10 条 SKIP 为仅源码检出可判的仓级门禁与不随包的压测，不折算通过 |

**计数口径**：单测按 `test/unit/*.test.mjs` 注册的用例数计；集成按 `test/integration/*.test.mjs`
注册的用例数计；冒烟按套件用例计。公开树清理了内部套件（移除 1 条私有引擎测试与 3 条私有发布脚本测试），单测基线从 1509 下调到 1505；
发布前围栏回归 +4 条后为 1509（与开发树 1535 仍不同源）。数字与开发树不同，**不互相顶替**。
退出码三档：`0` = 真通过；`1` = 真失败；`2`/`3` = NOT_RUN（缺前提），不得回写成绿色。
安装验收（`install-acceptance --gate`）另有自己的三档：`0` = 通过；`1` = 有失败；
`2` = 通过数为 0 或找不到 npm，即一条有效验收都没跑成，不得记成通过。

### 4. 判据

- `npm run check`：核心行预算 4889/4889、字节 260153/260189、核心指纹、注释门禁与 vendor 逐文件哈希。
- `npm test`：smoke + unit + integration；三平台 CI 结果分别记录。
- `npm pack`：净室安装后 `node tusunsun.mjs --version` 可运行；同一作业再在制品目录内跑一次 `npm test`，作为制品形态的独立证据；包内不含 `dist/`、`test-results/`、`*.tgz`。
- 零运行时 npm 依赖：`ws` 内置在 `vendor/ws/`，`@jieai/liuhe-lite` 是可选器官，默认不装配。

### 5. 未做 / NOT_RUN

- npm registry 发布：本版未执行 `npm publish`；等渠道配置与显式授权后再发。
- macOS / Windows 真实机器：由三平台 CI 覆盖，结果以对应 Actions 运行为准。
- macOS 的进程组整组回收依赖 `/proc` 判活，当前与 Windows 一样未覆盖；相关用例在非 Linux 上记 SKIP，不计入通过。
- 浏览器侧安全 E2E、制品形态的真实付费模型链路：仍为 NOT_RUN。
- 独立第三方验收：本版不声称已完成。

### 6. 发布前安全修复（2026-11-01）：围栏四缺陷

> 发生在首个公开 tag 之前；`0.20.0` 尚未打 tag 或发布到 npm。
> `src/core/` 未改（8 文件 / 4889 行 / 260153 B）；只改 `plugins/tool-executor.js` 与回归测试。

发布前回归在公开树复现了四条围栏缺陷，均已修复：

| # | 事实 | 修法 |
|---|---|---|
| 1 | 装载器给插件 import 加 `?pmN` 标签，围栏表按模块实例分裂；`fenceStatus()` 报 `installed: true`，执行器却读不到围栏 | 注册表挂 `Symbol.for(...)`，进程内共享；记录带 `core`，多内核仍各解各的 |
| 2 | `full-auto` 跳过整块围栏，不只跳过确认；工作区内 `.env` / `.git/config` 无人拦 | 去掉整块豁免：full-auto 只豁免确认，敏感路径/越界/读前必读/熔断/限流照跑 |
| 3 | manifest 写 `tool.executor`，实际注册名 `tool-executor`；真名依赖被误报缺失，点号名假绿灯 | manifest 改用注册名；`tool.compose` / `action.inspect` 标为 capability |
| 4 | `fenceStatus(core)` 的 `count` / `all` 是进程级 | 按 core 过滤；`count` 与 `all` 同源 |

- 回归锁：`R0-119/T9–T12`（4 条，走真实装配路径，不用 `new` 出来的执行器）。
- 公开树单测 **1505 → 1509**；npm 制品 **1509 总 / 1499 通过 / 10 跳过**。
- 修复前的行为不是“拒绝得太严”，而是**观测面在撒谎**：状态说装了，判据一次没跑。

**本版只声明“这是一个公开的 Developer Preview”，不声明 API 已稳定。**
