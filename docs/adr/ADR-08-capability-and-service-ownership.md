# ADR-08：能力与服务的主人（权属合同）

- 状态：**已采纳**（v0.14.0；补记 v0.12.0 的 K-13a/K-13b 落地）
- 影响面：`src/core/core.js`（`registerCapability` / `releaseCapability` / `registerService`）、
  `src/core/lifecycle-manager.js`（清理边界）、`plugins/tool-loader.js`（工具→能力的归属）

## 1. 要决定的问题

专家方案 §3.2 要求冻结三条合同，而我方在 v0.12.0 修掉了缺陷却**没有留下决策文件**——
只有验收报告里的一行表格。验收报告回答"改成了什么"，ADR 回答"为什么是这个、还能不能是别的"。
两者不能互相替代，因此本 ADR 是**补记**，不是新决定。

三个问题：

1. 同一 owner 重复注册（`override`）时，**省略某字段**是继承还是清空？
2. 别人的服务/能力能否被静默覆写？
3. `releaseCapability` 省略 owner 时，是无主让渡还是拒绝？

## 2. 决定

### 2.1 省略 = 继承；显式声明（含 `null`）= 覆盖

`override` 时逐字段比对：**没写的字段继承旧值**，写了就按新值（`null` 也是新值，表示清空）。

覆盖字段**一次性列清**：`permissions`、`input_schema`、`output_schema`、`tags`、
`description`、`requires`、`removable`。不再"发现一个补一个"。

修前的形状是：v0.9.32 专门修过"override 时丢 `permissions`"，但修法**只对 `permissions` 一列生效**。
同一条判据、同一种形状，在 `input_schema`/`output_schema`/`tags` 上原封不动活到了 v0.12.0
（实测 override 后 `input_schema === undefined`）。

**这是本 ADR 最想留下的教训**：逐字段打补丁会把同形状缺陷留到下一轮。
所以判据不是"这个字段补了吗"，而是**"字段清单在哪、谁维护"**。

### 2.2 异主覆写默认拒绝，具名报 `service_conflict`

- 默认：`service` 已由 A 注册，B 再注册 ⇒ 抛 `service_conflict`，A 的实现**保持不变**。
- 逃生门：宿主显式设 `service.allowOverride = true`。这是**宿主**的权力，不是插件的。
- 同 owner 重注册：允许（那是同一个主人在更新自己的东西）。

为什么是拒绝而不是告警：覆写之后，所有已经 `getService()` 拿到 A 对象的插件
**手里还是旧对象**，而新调用者拿到 B —— 同一个服务名在进程内有两个不同实现同时活着。
这不是"配置冲突"，是**同一次运行里存在两个真相**。

### 2.3 有主能力只能由主人让渡

`releaseCapability(id)` 不带 owner（或 owner 不匹配）⇒ 抛 `capability_conflict` 或返回 `null`。

修前：匿名调用能删掉 A 的能力，返回成功。实测 `releaseCapability('z.cap')` 后
`hasCapability === false`，而 `z.cap` 属于 A。

保留两条不制造新限制的路径：
- **主人自己**仍可让渡（不能把路堵死）；
- **无主能力**（注册时就没有 owner）任何人仍可释放 —— 否则这类能力将无人能清理。

## 3. 被否决的候选

| 候选 | 否决理由 |
|---|---|
| 覆写一律允许 + 强告警 | 告警在守护进程里没人看；且"两个真相同时活着"不是告警能解决的问题 |
| 覆写一律拒绝（无逃生门） | 会让既有装配无法迁移；宿主必须有权在自己进程里做主 |
| `override` 一律整条替换 | 这正是 v0.9.32 之前的形状，安全声明静默丢失 |
| `override` 一律要求写全字段 | 每加一个合同字段就破坏所有既有调用方，演化成本过高 |
| 引入统一 Registry 抽象 | 专家 §3.1 明确反对（"不做大一统注册表"）；三类对象协议不同，不该合并 |

## 4. 判据（不是"看起来对"）

```
K-06/1  同 owner override 省略 input_schema ⇒ 必须继承旧约束
K-06/2  显式声明（含 null）才是覆盖，省略是继承
K-13a/1 异主覆写 ⇒ service_conflict，且**原实现完好**
K-13a/2 同 owner 重注册与显式逃生门都允许
K-13b/1 匿名 releaseCapability 不得释放他人能力
K-13b/2 主人自己仍可让渡
K-13b/3 无主能力仍可被任何人释放
```

**变异验证**：把 `service` 改成允许异主覆写 ⇒ K-13a/1 变红；把字段继承改回整条替换 ⇒ K-06/1 变红。

## 5. 诚实边界

- **这不是进程隔离**。同进程插件仍能拿到真实的 JS 服务对象，能直接改它。
  本 ADR 管的是**注册边界**上的权属，不是"恶意插件无法越权"。见 ADR-01 的威胁模型。
- 覆写拒绝只对**走了 `registerService` 的**服务生效。绕过它直接改 `core._services` 的代码
  不受约束（实测 `LifecycleManager._step6RemoveRegistrations` 就在直接操作那个 Map，
  已在本轮登记为残留而非悄悄忽略）。
- `allowOverride` 是**全局开关**，不是按服务名。若将来需要按名授权，属新决定，需改本 ADR。

## 修订：覆盖判据从「自报 owner」改为「受信 provider」

**触发**：专家 rc.14 复审的 S6 / 本仓 E-1–E-3 探针。原判据
`existing.owner === owner` 读的是**调用方自报**的字符串，于是
`registerCapability(id, { owner: 'A', override: true })` 就能顶掉 A 的能力；
公开的 `runServiceTracking('A', fn)` 更进一步，能让调用方铸造一个“来自 A”的装配上下文。

**新判据**：

1. `provider` **只**来自受信装配上下文（`store.trusted === true`，即有真实 epoch 的那条路径）。
   公开 `runServiceTracking` 传的是 `epoch:null` ⇒ `trusted=false` ⇒ `provider=null`。
2. 覆盖需同时成立：已有条目带受信 `provider`、本次注册受信、且两者相等。
3. 两边都没有受信来源时（宿主直接注册、历史兼容）**保留**原同 `owner` 判据——
   那时没有更强的身份可依据，静默收紧会打断既有宿主代码，属于另一个决定。
4. `owner` 降为**展示字段**：仍可读、仍写进日志与 `listCapabilities`，但不再参与授权。

**当时未覆盖（已由下一节闭合）**：`releaseCapability(id, owner)` 曾仍按可读字符串判定；
把它改为需要受信上下文会打断插件在自己 `stop()` 里释放能力的既有写法 ——
所以当时登记为“属单独一轮”，而不是默认已完成。

## 修订二：撤销权属于「登记」，不属于名字（专家裁决 A 落地）

**触发**：专家《RC14-IDENT｜S6 代持语义、专家裁决与反例执行包 v1.0》裁定
**A 方案**（单次登记身份 + 定向释放凭据 + 生命周期代际清场），并明确否掉两个替代：
仅凭可公开字符串 `owner`/`provider` 认证；给 handler 期间派发“管理型 ALS”。

**裁决结论（逐字）**：能力名称用于定位，声明 owner 用于署名，可信登记身份用于归责，
单次登记凭据用于撤销；任何可列举的字符串都不构成授权。

**落地**：

1. `registerCapability` 每次成功发布铸 `registrationId`（Core 内单调）与**冻结空对象凭据**；
   凭据只入 `WeakMap`，`listCapabilities()` / JSON / 日志 / 事件都不含它。
2. 撤销判据是 **`compare-and-delete(registrationId)`**：凭据反查到的记录必须仍是该 id
   当前那条；被覆盖 / 已释放 / 跨 Core ⇒ `false`（stale）。ABA 的全部防线就在这里。
3. 覆盖必须持原登记凭据（`overrideBy`）；`owner`/`provider` 字符串相等**不再**构成依据。
   原先“两边都无来源时按同 owner”的兼容分支**删除** —— 它与裁决直接冲突。
4. `releaseCapability(id, ownerString)` 保留签名，只回 `capability_release_denied`。
5. `releaseCapabilitiesByOwner` / `releaseServicesByOwner` **从公开面删除**；
   生命周期改领构造期获得的清场闭包，按**插件实例**（登记时记下的对象引用）回收。
6. 装配账（`discardAssemblyArtifacts`）改记**凭据**而非 `capId`：旧装配的迟到清理
   只能判 stale，删不到同 ID 的新登记。
7. `tool-loader` 的目录项持有该能力登记的凭据与一个不可枚举的目录句柄；
   `unregisterTool` 要么持句柄，要么站在该登记实例的装配上下文里；注册失败明确降级
   （`registered_capability:false`），注销绝不冒领他人能力。

**边界（不得读成“进程内已隔离”）**：清场闭包与 `_reapRegistrations` 都不是安全边界 ——
同进程拿到 Core 引用的代码本来就能直接改私有表。契约的可信前提仍是“只加载受信插件”
（`verification/contracts/oss-core-v1.md` §4 前提 1）。本修订消除的是**公开面**上的
“猜对名字即放权”，不是构造一个安全沙箱。

**验收**：专家矩阵 ID-01～ID-16 落在真实 Core / LifecycleManager / ToolLoader 上，
`test/unit/test-r031-registration-lease.test.mjs` 16/16 通过。
