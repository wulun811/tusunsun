# ADR-09：无人在场时的确认语义（`confirm()` 的危险默认）

- 状态：**已采纳**（v0.14.0；补记 v0.12.0 的 K-01 落地）
- 影响面：`src/core/core.js`（`confirm`）、`plugins/privacy.js`、`plugins/admission-gate.js`

## 1. 要决定的问题

修前 `confirm()` 在非 TTY 环境下**直接返回 `true`**：

```js
if (!process.stdin.isTTY) return true;   // "Non-TTY mode, auto-approved"
```

专家原文 §10 P1 第 5 条要求明确策略：
「若'必须人工确认'但无可信批准来源，默认拒绝／请求授权；
兼容可信宿主的显式自动批准模式必须独立声明并留证据。」

要害不是"配置读错了"，而是**危险默认**：CI、守护进程、管道里根本没有人在场，
系统却替人做了"同意"的决定，而调用方据此真的落地了危险动作。

## 2. 决定：三分支，默认拒绝

```
① 显式可信自动批准（privacy.trustedAutoApprove === true）  → 放行，事件带 reason: trusted_auto_approved
② 非 TTY 且无可信批准来源                                    → **拒绝**，reason: no_tty_refused
③ 有 TTY                                                    → 交互询问（含超时），reason: user_approved / user_rejected / timeout
```

外加一条前置：`requireConfirmFor` 未配置任何动作类型时，直接放行
（`reason: no_require_confirm_for`）——那不是"确认"，是"本来就不需要确认"，
把它算作"系统同意了"会让统计失真。

### 2.1 为什么逃生门只能来自配置

`trustedAutoApprove` 读的是 `core.get('privacy.trustedAutoApprove')`，即**宿主配置文件**。
它**不能**由调用能力的那次请求自带（`params.autoApprove` 之类）——
否则模型或插件可以自己给自己授权，"确认"就退化成自己签字的仪式。

这条与 ADR-08 的 `service.allowOverride` 是同一原则：**逃生门属于宿主，不属于被监管方**。

### 2.2 为什么拒绝而不是"等一个超时后拒绝"

修前交互分支有 `timeoutMs`，超时返回 `''` ⇒ 判 `false`。这条保留。
但非 TTY 分支**不能**用"等超时"：管道后面可能永远没有输入，等待只是把
"明确拒绝"换成"卡住"。拒绝必须是立刻可见的。

## 3. 被否决的候选

| 候选 | 否决理由 |
|---|---|
| 保留自动同意，仅加日志 | 日志在守护进程里没人看；且动作已经落地，事后记录救不了 |
| 非 TTY 一律拒绝（不给逃生门） | CI 里确实存在"宿主已声明可信"的合法场景；一律拒绝会逼使用者去改代码绕过 |
| 环境变量 `TUSUNSUN_AUTO_APPROVE=1` | 环境变量比配置文件更容易被上游进程注入，且不受本仓配置校验；信任级别应更低 |
| 由请求自带 `autoApprove: true` | 让被监管方给自己签字，等于没有确认 |
| 等待 stdin 直到超时再拒 | 管道无输入时是永久卡住，不是拒绝 |

## 4. 判据

```
K-01/1 无 TTY + 要求确认 + 无可信授权 ⇒ 必须拒绝（approved === false）
K-01/2 宿主显式 trustedAutoApprove 时可放行，且事件带 reason: trusted_auto_approved
```

变异验证：把非 TTY 分支改回 `return true` ⇒ K-01/1 变红。

## 5. 诚实边界

- **这不构成"人一定同意过"的证据**。`trustedAutoApprove` 一旦为真，系统就是在
  无人复核的前提下放行动作；本 ADR 只保证**这件事是被显式声明过的、且事后可查**，
  不保证它是对的。发行说明里不得把它写成"可靠确认"（专家 §12.1 明确禁止）。
- **TTY 交互分支未在真实终端里被自动化测试覆盖**（需要人按键）。现有用例覆盖
  非 TTY 的两个分支与"无 requireConfirmFor"分支；交互分支的 `readline` 路径
  只在手动验证中跑过，未进 CI。这一条记 **NOT_RUN**，不折算为通过。
- 与 `admission-gate.js` 的 `profile=production` 强制 `process.exit(1)` 是**两件事**：
  那个管"必需插件初始化失败要不要退出进程"，本 ADR 管"某次危险动作要不要人点头"。
  两者都可能表现为"进程拒绝继续"，但原因不同，排障时不要混。
