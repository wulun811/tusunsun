# 土行孙文档

> **让 Agent 跟着工作变。** 按场景组装，按需加载，随工作调整。

## 先判断是否需要

- [产品定位与 Pi 对照](positioning-and-pi.md) — 使用场景、能力重叠、选型限制与官方依据
- [版本号与发布轨道](guides/versioning-and-release-tracks.md) — `0.20.0` 是首个公开版；内部迭代记录不随公开仓发布
- [README](../README.md) — 产品入口与平台状态
- [安全边界](../SECURITY.md) — 工作区、进程、凭证与浏览器验证范围

## 快速开始

- [快速开始](guides/quick-start.md) — 5 分钟跑起土行孙
- [配置指南](guides/configuration.md) — 详细配置说明
- [多会话：每个会话在自己的目录里干活](guides/quick-start.md#多个项目同时干活会话级目录) — 会话级工作目录、声明方式、持久化与边界
- [Cell：有身份的执行单元](architecture/cell-rfc.md) — 单 Cell / 双 Cell 示例与明确不支持的项
- [**Cell 接入指南**](guides/cell-integration.md) — 外部集成方照着做：五道门的正确写法、`close()` 的三种答案、限流与配置路径、重启语义
- [插件开发](guides/plugin-development.md) — 开发自己的插件
- [场景系统](guides/scene-system.md) — 理解场景机制

## 架构

- [微内核架构](architecture/microkernel.md) — 核心设计
- [系统架构说明（0.20.0）](architecture/system-architecture.md) — 全部 50 个插件、10 个场景配方与三条端到端路径
- [Cell RFC](architecture/cell-rfc.md) — Cell/Task/Session/Core/Process 的边界、合同、状态机与威胁模型

### 内核边界与接点

- [内核边界：谁是机制、谁是策略](architecture/kernel-boundary.md) — `src/core/` 每个文件负责什么、每个职责的权威写入点在哪
- [Guard / Policy Hook / Event](architecture/hook-guard-event.md) — 三类接点的权属与失败合同

### 内核合同

- [内核不变式（10 条）](architecture/core-invariants.md) — 每条都标了当前是否成立与依据
- [状态机转移合同](architecture/core-transition-contracts.md) — 三台本地小状态机与唯一允许的三种跨机器读
- [函数权属表](architecture/function-ownership.md) — 七个可变事实的权威写入点
- [Core 演化史](architecture/decisions/core-evolution-history.md) — 「为什么代码长成这样」的记录
- [反例基线探针](../test/probes/k01-k14-core-semantics.mjs) — `node test/probes/k01-k14-core-semantics.mjs` 一行命令自证

## 架构决策记录（ADR）

- [ADR-01 沙箱威胁模型与软超时语义](adr/ADR-01-sandbox-threat-model.md)
- [ADR-02 插件实例归属与热替换边界](adr/ADR-02-plugin-owner-and-hot-reload.md)
- [ADR-03 能力错误码与执行状态](adr/ADR-03-capability-error-codes-and-execution-state.md)
- [ADR-04 Action Receipt 与验收证据等级](adr/ADR-04-action-receipt-and-evidence-levels.md)
- [ADR-05 `core.ready` 在必需插件失败时的语义](adr/ADR-05-core-ready-semantics.md)
- [ADR-06 依赖版本判据改为严格受支持子集](adr/ADR-06-semver-strict-subset.md)
- [ADR-07 六合 Lite 以「内置副本 + 适配插件」形态并入](adr/ADR-07-liuhe-lite-integration.md)
- [ADR-08 能力与服务的主人（权属合同）](adr/ADR-08-capability-and-service-ownership.md)
- [ADR-09 无人在场时的确认语义](adr/ADR-09-unattended-confirmation.md)
- [ADR-10 核心行数预算与「超额必须批准」的程序](adr/ADR-10-core-line-budget.md)
- [ADR-11 错误原因的加性归一](adr/ADR-11-error-category-additive.md)
- [ADR-12 Node.js 支持矩阵（放弃 18/20）](adr/ADR-12-node-support-matrix.md)
- [ADR-13 拒绝码的执行阶段分层](adr/ADR-13-denial-execution-stage.md)

## 质量与可复现证据

- [**API 兼容性基线（v0.11.0 → v0.14.0）**](quality/api-compatibility.md) — 33 个公开方法无删改、事件无改名；加性字段与破坏性变更逐条列出
- [**性能基线**](../verification/perf/README.md) — 本机实测与量法；该目录不进 npm 制品，需 clone 源码检出查看
- [**系统级基准 2026-10-31**](quality/system-bench-2026-10-31.md) — 启动 / 常驻 / 每回合上下文 / 同机密度的对照实测
- [压力测试方案](quality/stress-test-plan.md) — 分层、指标口径、硬门禁与判据
- [压测基线 2026-10-20](quality/stress-baseline-2026-10-20.md) — 可复现的性能数字
- 历史版本的评审记录、发布判定与内部台账不随公开仓发布；当前状态以 [README](../README.md) 与 [CHANGELOG](../CHANGELOG.md) 为准。

## 参考

- [**Cell API 参考**](reference/cell-api.md) — `cell-runtime` 服务的全部方法、配置键、错误码与形状
- [命名规范](reference/naming.md) — 文件、变量、事件命名
- [工具开发规范](reference/tool-development.md) — 开发 Agent 工具

## 相关链接

- 从已取得的仓库或 tgz 开始，见 [快速开始](guides/quick-start.md)。
- [CONTRIBUTING.md](../CONTRIBUTING.md) — 贡献指南
- [CHANGELOG.md](../CHANGELOG.md) — 版本历史
