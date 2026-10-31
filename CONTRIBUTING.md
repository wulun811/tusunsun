# 贡献指南

本仓采用 [Apache License 2.0](LICENSE)。当前是可独立运行的开源交付仓，不能假设另有开发仓的构建脚本或商业组件。

## 本仓即事实源

土行孙的源码就在本仓，**不要**再从另一棵树用 `build-oss` 之类的生成物覆盖它。此前的做法是"在开发仓改 → 生成 `dist/oss` → rsync 到本仓"，代价是两条常驻代码路径：生成侧改了文档或入口脚本，下次生成会静默盖掉；本仓手改了内核，下次生成又会把它删掉。现在方向反过来：**本仓改，下游按需吸收**。

由此两条硬规矩：

- 本仓文件全部手写维护，包括 `README`、`docs/`、`.github/`、`package.json` 的脚本段。没有任何步骤会重新生成它们。
- 下游（含商业产品线）要跟进内核改动时，由下游自行按本仓当前状态同步，并在自己的树上跑自己的门禁。不要把本仓当生成物的镜像。

`vendor/` 是唯一例外：它由 `npm run check:vendor` 逐文件哈希钉住，升级走[内置第三方依赖升级](#内置第三方依赖升级)。

## 修改前先确认范围

- 微内核为 `src/core/`（八文件），当前 **4889 行、预算上限 4889、260153 字节**；其余全部在 `plugins/`，**不属于**这份行数预算。
- **`src/builtin/` 在 v0.9.25 已并入 `plugins/`**，树里不再有这个目录。因此"加功能"通常不该动 `src/core/`：安全判据（`plugins/_lib/danger-patterns.js`）、执行器（`plugins/tool-executor.js`）、软闸（`plugins/_lib/destructive-gate.js`）都是插件。先把东西放进插件层，确实需要改内核语义时再抬预算——抬之前先看 `scripts/core-limits.mjs` 的记录格式，每次抬升都要写明增量来源，并在 `docs/adr/ADR-10-core-line-budget.md` 留一行。
- 运行时 npm 依赖为 0，第三方 `ws` 以内置副本随包。插件可以有依赖，但新增依赖会改变分发与离线安装边界，需明确记录并验证。
- 当前定位与未承诺能力见 [README](README.md) 和 [选型说明](docs/positioning-and-pi.md)。不能把会话保存写成任务恢复，把工作目录边界写成 OS 沙箱。

## 本仓可用的检查

以 `package.json` 为命令真相。本仓**不需要**另一棵树的构建步骤（`build:oss`、`sync:meta`），自己就能验收：

```text
npm run check          # 内核行预算 + vendor/ws 逐文件哈希
npm run check:deps     # src/ 平台层不得引 npm 包
node scripts/verify-vendor.mjs
npm run test:smoke
npm run test:unit
npm run test:integration
```

Windows 发行入口的针对性回归：

```text
node --test test/windows-release.test.mjs
node scripts/install-acceptance.mjs --gate --nodes 22 --json test-results/windows-install-acceptance.json
```

`--nodes` 必须写本次要求验证的大版本；发布门禁遇到版本缺失、FAIL 或 SKIP 都不能当通过。诊断模式通过数为 0 退出 2，门禁模式指定版本缺失退出 1。完整套件入口是 `npm test`；按变更选相关检查，并保留失败、跳过及环境信息。测试前置：Node ≥ 22；`test-r0-115/W10` 另需 `python3`（用它 fork 出僵尸进程；缺了这条会红，不会静默跳过）。浏览器测试需要实际可导航的 Chromium，SKIP 不等于安全验收通过。

行数预算由 `test/unit/test-r0-108-line-budget-gate.test.mjs` 检查。修改内核后同时更新中英文 README 和架构文档中的统计；使用文件内容 `split('\n').length` 的同一口径，不拿全仓体积与别人的内核行数交叉比较。

## 插件开发

1. 在 `plugins/` 放入可信插件，使用 ESM、`async/await`，以 `core.log()` 输出日志。
2. 在选定场景的 `eager` 中声明需要启动的插件；仅复制文件不等于默认加载。服务型插件需在消费者取服务前初始化，能力型插件还可声明 `provides` 并按需加载。
3. `stop()` 释放自己的连接、定时器、watcher 与子进程；事件监听使用 `{ owner: 插件名 }`。同进程插件不具备安全隔离。
4. 修改后确认启动日志、实际能力调用和停止清理，不以模块能 import 代替全链路验证。

详见 [插件指南](docs/guides/plugin-development.md)、[场景指南](docs/guides/scene-system.md) 和 [工具指南](docs/reference/tool-development.md)。可参考 `examples/`，但示例须按实际场景装配，不是复制后自动启用。

启动时日志走 stderr；机器 JSONL 在适用模式下走 stdout。需要文件日志可显式重定向：

```text
node tusunsun.mjs start 2> run.log
```

默认不保证存在 `~/.tusunsun/logs.txt`。

## 内置第三方依赖升级

`vendor/ws/PROVENANCE.json` 记录现有文件哈希，校验不代表自动检查了上游漏洞。当前交付仓没有 npm 侧的 ws 版本，lock 漂移比较会明确记 NOT_RUN；`npm update` 不会更新内置代码。

1. 查阅上游发行说明与安全公告，明确接受的新版本并取得上游包。不要直接对本仓 `npm install ws` 把运行依赖重新引入。
2. 用新包的运行文件、LICENSE、package.json 整体替换 `vendor/ws/`；保留原样内容，并保持 `.gitattributes` 规定的 LF 字节。确认上游 wrapper 与当前导出兼容。
3. 执行 `node scripts/verify-vendor.mjs --write --accept-version <版本>`，复核清单、来源与 NOTICE；这是显式信任决策，不能只重写清单掩盖未知漂移。
4. 执行 `node scripts/verify-vendor.mjs`、相关与完整回归，重跑原始 tgz 的离线安装门禁。
5. 在 CHANGELOG 记录版本、来源、验证环境及未覆盖项。上游漏洞跟踪仍需维护者主动进行。

## 提交和文档

提交信息使用 `fix:`、`feat:`、`docs:`、`test:`、`chore:` 等前缀，描述实际变更和验证。
仅提交源码、测试、CI 和必要文档，不提交 tgz、安装目录、缓存或生成的测试产物；`.gitignore` 已排除它们。

文档入口为 [docs/index.md](docs/index.md)。对外叙事应区分默认装配、可选实现和包外能力；平台结论必须指明 Node 版本与测试范围；外部比较注明日期、来源和是否亲自实测。

## 发布

发布前确认版本、CHANGELOG、同一原始 tgz 的目标平台安装门禁和安全回归。包文件留作发布制品，不进 Git。只有维护者完成渠道配置并显式授权发布后，才创建发布 tag 或执行 npm publish；已有 workflow 不代表渠道已上线。

最后核对：2026-10-30，v0.20.0 工作树。

## 两种载体，不要互相顶替

本仓同时产生两种形态，判据不同，不能拿一个的绿灯去签另一个：

| 形态 | 怎么得到 | 含什么 | 不含什么 |
|---|---|---|---|
| **源码检出** | `git clone` | 全部，含 `verification/`、`test/stress/`、`.github/`、`package-lock.json` | — |
| **npm 制品** | `npm pack` 出的 `.tgz` | `package.json#files` 白名单内的文件 | `verification/`、`test/stress/`、`.github/`、`package-lock.json`、`engines/`、`.env` |

因此制品里有些检查只能记 **NOT_RUN / SKIP**，那不是通过。`test/lib/carrier.mjs` 负责判定当前是
哪一种载体，并把相关断言分派到正确的结论里——它有三条反滥用闸（删文件不能把测试变绿），
改测试时不要绕过它。制品形态下发布门禁**故意**不签「全绿」，那是设计而非缺陷。
