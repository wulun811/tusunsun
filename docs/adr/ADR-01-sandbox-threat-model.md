# ADR-01：`sandbox` 的威胁模型与软超时语义

- 状态：**已采纳**（v0.9.33）
- 影响面：`plugins/sandbox.js`、`plugins/_lib/real-path.mjs`、`plugins/_lib/sandbox/bootstrap.mjs`、`SECURITY.md`
- 关联：R0-159（符号链接逃逸）、R0-160（shell 白名单）、R0-161（超时语义）、S1/S2/S3

## 1. 要决定的问题

`plugins/sandbox.js` 叫 "sandbox"，但它没有创建任何隔离命名空间、没有换 uid、没有装
seccomp（`grep -c 'chroot|unshare|seccomp|setuid|namespace'` = **0**）。于是有两种走法：

- **A**：加真隔离（容器/namespace/独立用户），让它配得上这个名字；
- **B**：承认它是软围栏，把名字的误导性从文档与行为两侧一起拆掉。

## 2. 决定

**选 B，并且把"软"的部分做到诚实。** 理由：

1. **加真隔离是另一个量级的工程**，且会引入对宿主内核/容器运行时的强依赖，与本包
   "零强制外部依赖、可离线跑"的定位冲突。它不是这一版该做的事。
2. **名字的误导比能力缺失更危险。** 修前三处都是"看起来受控、实际不受控"：
   符号链接能穿 deny（R0-159）、白名单只判首 token（R0-160）、超时被读成"无副作用"（R0-161）。
   一个明确自称"软围栏"的实现，比一个自称"沙箱"却能被 `ws/vault -> secret` 穿过的实现安全。
3. 因此本 ADR 的产出不是"更强的隔离"，而是**把三处假承诺变成真行为**（见下）。

## 3. 具体裁决

### 3.1 路径判据必须追真实路径，且与工具层共用同一份代码

**修前**：工具层（`plugins/tools/lib/workspace.mjs`）追 realpath，沙箱层只做词法
`resolve()`。同一安全属性、两个入口、两个答案 —— 送审报告 §1.1 把它排第一。

**决定**：把物理归一化抽到 `plugins/_lib/real-path.mjs`，两侧共用。判据规则：

- 逐段物理归一化：已存在的段取 `realpath`，遇到不存在的段停下；
- 剩余（不存在的）部分里若含 `..` 或 `.` ⇒ **物理语义不可确定** ⇒ 返回 `null` ⇒ 调用方拒绝（fail-closed）；
- `deny` 优先于 `allow`；包含关系用 `relative()` 而非字符串前缀；
- **判据给出的物理路径就是真正被执行的路径** —— 不能"先查 A、再让子进程在 B 写入"。

**为什么不各写一份"看起来一样"的实现**：那正是 R0-113 → R0-134 的成因。当时只在工具层
修了前缀判据，沙箱那份被漏掉，于是同一个 bug 以"沙箱比工具层更松"的形式存活了两轮。

### 3.2 shell 白名单：承认不可实施，而不是写一个 shell 解析器

**修前**：`bashAllowlist=['echo']` 时只取首个 token 比对，`echo ok; touch x` 放行；
`startsWith` 还让 `echooo`、`echo-hack` 算命中。

**决定**：不修正则、不写 AST 解析器（那是一条没有尽头的路，且任何遗漏都是安全洞）。
改为**撤销这个承诺**：

> 一旦配置 `sandbox.bashAllowlist`，受限档下所有 `bash` 一律具名拒绝
> `unsupported_restricted_shell`。留空则该档 shell 可用（继续受 Cell 资格与危险操作检查约束）。

**关键约束**：拒绝必须**稳定**。不能"第一次拒绝、之后放行"—— 那会让调用方学到"重试就好"。
实现里有专门测试（S2/b）连调三次验证同一个具名 code。

**为什么不提供"受限 exec"（固定 executable + argv、shell:false）作为替代**：那是个好方向，
但它是**新增能力**，需要自己的准入策略、参数白名单与反例集。本轮 A 门要的是"拆掉假承诺"，
不是"补一个新能力"。留给后续版本，届时必须是独立 ADR。

### 3.3 超时：请求截止 ≠ 执行结束

**修前**：超时分支只清理 pending 并 resolve 一个 `{ok:false,error:'Timeout: …'}`。
实测 75ms 返回、约 650ms 后文件才出现。回执的 `state` 被归成 `failed`，上层会据此
**重试一个可能已有副作用的操作**。

**决定**：分三个互不替代的轴，全部如实回：

| 字段 | 值 | 含义 |
|---|---|---|
| `request_state` | `timed_out` | 我们**不等了**（这是等待的截止） |
| `execution_state` | `unknown_or_running` | 那一头**执行到哪了我们不知道**，而且它可能还在跑 |
| `terminated_confirmed` | `false` | 我们**没有**确认它已停止 |

**为什么不用 `child.kill()` 之后就写 `terminated_confirmed: true`**：`kill` 只能杀掉
bootstrap 进程，杀不掉它 `execSync` 出去的 shell 及其子进程。把"调用过 kill"写成"已终止"
正是本合同禁止的谎报。

**迟到的回复怎么处理**：修前超时后不摘监听器，迟到的回复会被广播成 `sandbox.result` ——
等于让一个已超时的请求"稍后自己变成成功"。现在的处理是：监听器**留在迟到模式**，
`settled === true` 之后只走 `sandbox.late_result`，绝不 resolve、绝不广播 `result`。

> 这里我第一版写错过：为了"防止迟到回复污染结果"把监听器 `removeListener` 掉了，
> 于是迟到回复**一条都看不见**。`S3/b` 当场把我抓成 FAIL。教训是
> **"看不见"不等于"没发生"**，正确处置是留痕而不是静音。

## 4. 后果

**变好的**：

- 三个已复现的越权/假成功路径关闭；
- 「同一属性两个答案」这个结构性缺口关闭（只剩一份判据代码）；
- 超时之后不会再有"静默变成成功"。

**变差的（必须承认的代价）**：

- 沙箱路径判据现在是**异步**的（要 `realpath`），`_guard` 从同步变异步。这是一次
  内部接口变更，所有调用点已同步；
- 配置了 `sandbox.bashAllowlist` 的部署会**失去 shell 能力**（从"假受控"变成"明确不可用"）。
  这是刻意的：宁可稳定失败，也不要假放行。迁移方式是删掉该配置项。

**仍然没解决的（不在本 ADR 范围）**：

- TOCTOU：判完到写之间仍有窗口；
- 跨进程冻结：`freezeCapability` 只在进程内生效；
- Windows 上的路径语义（8.3 短名/UNC/大小写）未专门处理。

## 5. 如何验证

```bash
node test/run-one.mjs test/unit/test-s1-s2-s3-execution-boundary.test.mjs   # 19 条
node test/probes/r0-159-sandbox-symlink-bypass.mjs                          # 独立探针
```

四条变异（各自只打红对应判据）：

| 变异 | 打红 |
|---|---|
| `canonicalizePhysical` 退回词法恒等 | S1/a、S1/g、X/1 |
| 撤销受限 shell 拒绝 | S2/a、S2/b、X/2 |
| 超时谎报 `execution_state=failed` | S3/a |
| 执行器把超时压回普通 `failed` | S3/d |
