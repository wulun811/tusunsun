# Security Policy

> 土行孙是**面向可信本地部署**的 Developer Preview。下面写的是当前实际边界，不是安全认证。
> 完整的威胁模型与设计取舍见 [ADR-01](docs/adr/ADR-01-sandbox-threat-model.md)、
> [ADR-09](docs/adr/ADR-09-unattended-confirmation.md) 与 [ADR-13](docs/adr/ADR-13-denial-execution-stage.md)。

## 报告漏洞

- 首选 **GitHub Private Vulnerability Reporting**（仓库 Security 页面）。在正式启用前，请通过取得本版本的渠道联系维护者确认私密报告方式。
- **不要**在公开 Issue、日志或聊天中发布利用细节、凭证或未修复漏洞的可执行代码。
- 报告请包含：漏洞类型、影响版本/配置、复现步骤、潜在影响；修复思路可选。
- 当前是 Developer Preview，不承诺固定的响应 SLA；严重问题优先评估与修复。

## 支持范围

| 项 | 当前状态 |
|---|---|
| 支持版本 | `0.20.x` 公开轨道 |
| Node.js | `>=22`（Node 24 声明支持但未在全部环境实测） |
| 平台 | Linux 实跑；Windows / macOS 由三平台 CI 覆盖 |
| 部署前提 | 可信本地用户、可信工作目录、可信模型端点 |

## 安全边界（必须知道的限制）

- **不是 OS 沙箱**：`sandbox` 插件是软围栏（路径判据 + 子进程），不提供 chroot / namespace / seccomp / 降权。它挡不住一个执意越界的本地进程。
- **shell 工具不受工作区路径限制**：文件工具会做工作区与敏感路径判据；`bash` 类工具执行的是用户授权的命令，能力边界由宿主策略与操作系统负责。
- **工作区是逻辑边界**：多会话/多 Cell 的工作目录、能力交集与拒绝审计由内核执行；不要把“逻辑隔离”读成“多租户安全隔离”。
- **`full-auto` 不是“人已同意”**：它表示宿主允许在无人复核下放行动作；不代表有人看过这次具体调用。非 TTY 的 `confirm()` 默认拒绝（ADR-09）。即使 `full-auto`，围栏的敏感路径、路径边界、读前必读、熔断与限流判据仍执行；只有不可恢复命令的确认闸门让路。
- **模型端点由使用者提供**：API key 存在本地配置；本包不上传遥测。模型服务方的数据处理不在本包控制范围内。
- **能力以解析后的授权为准**：不以模型请求的工具名为准；检查与调用之间没有异步窗口；拒绝与判据故障必须可区分（ADR-13）。
- **Cell**：一个 Cell : 一个 Core : 一个进程；能力取 HostPolicy ∩ Cell ∩ Task；不支持同一进程内创建第二个 Cell。见 [Cell 接入指南](docs/guides/cell-integration.md)。

## 内置第三方依赖（`vendor/`）

本包运行时 npm 依赖为 0；第三方代码以内置副本随包：

| 包 | 许可 | 校验 |
|---|---|---|
| `ws` | MIT | `vendor/ws/PROVENANCE.json` 逐文件 sha256；`node scripts/verify-vendor.mjs` |
| `@jieai/liuhe-lite`（含 `malong` 子树） | MIT（Copyright (c) 2026 Malong contributors） | `vendor/liuhe-lite/PROVENANCE.json` 逐文件 sha256；含 1 个已记录的本地补丁 |

第三方代码不通过 `npm audit` 跟踪；升级必须显式更新 PROVENANCE 并重跑
`node scripts/verify-vendor.mjs`。内置副本被修改而清单未更新时，校验会失败。

## 披露与修复

- 修复优先进入下一个公开版本；严重问题可单独发补丁版本。
- 修复发布后，可在 CHANGELOG 或 ADR 中说明影响面与边界；不发布未修复漏洞的利用细节。
- 安全相关的设计变更必须留 ADR；不要把“计划中的机制”写成“已经生效的保证”。
