# verification/model/ —— 有界模型与突变体

这个目录里是**模型**，不是产品代码，也不进发行包。

## 一句话结论

| 项 | 值 |
|---|---|
| 模型 | `Lifecycle.tla`（生命周期 / 在途尝试 / 纪元 / 停机）、`Ownership.tla`（F01：登记身份 / 定向撤销 / 实例清场）、`HostControl.tla`（F05 服务侧：谁能换掉已归属的服务）、`Dependency.tla`（F06：依赖图 / 停机次序 / 凭什么有序）、`ServiceRegistration.tla`（服务登记身份：一次登记被撤销时凭据是否仍指向当前这一笔） |
| 工具 | TLC，`tla2tools.jar` 按 `tla2tools.jar.sha256` 钉住 |
| 覆盖 | F01 / F03 / F04 / F05（能力侧 + 服务侧接管 + 服务登记身份）/ F06 / F08 |
| 不覆盖 | F02 / F07（**明确不建**：F02 的入口清单完备性不是状态机性质，建模只会把漏掉的入口一起"证明"掉；F07 无交错可穷举，有内容的是纯函数决策表）；F01 的句柄保密性 |
| 强度 | `MODEL_PASS_BOUNDED` —— **有界**，只对各 `.cfg` 里那几个维度成立；**逐模型**判定，不合并总分 |

**不得**把这里的存在读成「已被形式化验证」。状态词见 `verification/contracts/oss-core-v1.md`。

## 跑一次（离线 / 联网两条路）

```bash
# 联网：下载 + 校验 sha256，不符就拒绝落盘
node verification/model/fetch-tlc.mjs

# 离线：用一份已人工校验过的副本
TLA2TOOLS_JAR=/opt/tla2tools.jar node verification/run-formal.mjs

# 只要模型轨
node verification/run-formal.mjs --strict
```

没有 JDK 或没有 jar 时，`run-formal.mjs` 写 `NOT_RUN` 并以 0 退出（advisory，合同 §7）；
加 `--strict` 则以 2 退出，给 nightly 用。**不会**在缺工具时写 PASS。

## 范围（合同 §3）

两插件、两个 waiter、一个锁 key、一个在途尝试、两代 epoch、一次锁等待超时、一次停机期限；
`StopFault = TRUE` 让「handler 永不返回」成为合法环境。
两个参考 cfg：`Lifecycle.cfg`（硬环境）与 `Lifecycle.nofault.cfg`（正常环境）。

## 突变体：模型的自证

| 文件 | 改坏了一处 | 应撞 |
|---|---|---|
| `mutants/m1-timeout-releases-lease.cfg` | 等锁超时顺手清掉真实 attemptLease | `INV_F03_LEASE` |
| `mutants/m2-late-commit-without-epoch.cfg` | 旧代提交不看 epoch guard | `INV_F05_NO_STALE_WRITE` |
| `mutants/m3-waiter-timeout-releases-lock.cfg` | 等锁超时者释放了别人的锁（H7） | `INV_F04_MUTEX` |
| `mutants/m4-stop-deadline-claims-stopped.cfg` | 期限到了就宣称「已停」（H8） | `INV_F08_NO_FAKE_STOPPED` |
| `mutants/m5-no-stop-deadline.cfg` | 停机没有期限，只有无限等 | `Deadlock reached` |
| `mutants/m6-release-by-id.cfg` | 释放只判「是个真句柄」，不判它是否仍指向当前那笔 | `INV_F01_NO_ABA` |
| `mutants/m7-release-by-string.cfg` | 释放凭公开字符串（provider / 声明 owner）过关 | `INV_F01_NO_STRING_AUTH` |
| `mutants/m8-late-reap-by-name.cfg` | 旧实例的迟到清场按**插件名**删（重载后同名） | `INV_F01_REAP_SCOPED` |
| `mutants/m9-owner-string-override.cfg` | 覆盖凭「声明 owner 字符串相等」过关 | `INV_F01_NO_STRING_AUTH` |
| `mutants/m10-deny-all-release.cfg` | 释放一律拒绝 —— 「不许卸载」也能让安全项全绿 | `INV_F01_RELEASE_ENABLED` |
| `mutants/m11-deny-all-reap.cfg` | 清场一律空转 | `INV_F01_REAP_ENABLED` |
| `mutants/m12-host-null-claimant.cfg` | 恢复 `claimant == null` 即视作宿主 | `INV_F05_HOST_ONLY_BY_CONTROL` |
| `mutants/m12-host-trusted-is-host.cfg` | 受信装配上下文即视作宿主 | `INV_F05_HOST_ONLY_BY_CONTROL` |
| `mutants/m12-host-release-by-name.cfg` | 按服务名释放而不是按登记身份 | `INV_F05_OLD_UNLOAD_KEEPS_R2` |
| `mutants/m15-release-under-stuck-dependent.cfg` | 依赖方 stop 超时（仍 running）后，提供方照停 —— **本轮实测的实现反例** | `INV_F06_NO_PREMATURE_RELEASE` |
| `mutants/m16-insertion-as-topology.cfg` | 没有活的依赖边却自报 `basis=dependency` | `INV_F06_BASIS_FAITHFUL` |
| `mutants/m17-swallow-unresolved.cfg` | 缺席的提供者被静默吞掉 | `INV_F06_NO_SILENT_UNRESOLVED` |
| `mutants/m18-swallow-cycle.cfg` | 环不报，直接跳过出顺序 | `INV_F06_NO_SILENT_CYCLE` |
| `mutants/m19-deny-all-stop.cfg` | 停机一律发不出去 —— 「永远别停」也能让安全项全绿 | `INV_F06_STOP_ENABLED` |

`m10`/`m11` 的方向与其它九个**相反**：它们要证的是「正例还在」，所以撞的是两条
**下界**不变量（任一时刻必须仍发得出释放/清场动作），而不是上界。
专家回函原话：「正例不许丢……即使所有冒名不能释放都绿，也应判 NO-GO：
那只是把可演化运行时变成『不许卸载』的系统。」

**突变体没被杀死 = 模型对该偏差不敏感 = 这个模型是空的**，`run-formal.mjs` 会因此退出 1。
这不是理论，本仓踩过三次（全在 `reports/model-check.json` 的 `sensitivity_audit` 里）：

1. 第一版 Lifecycle 没杀死 `m3` —— `Enter` 前置条件多写了 `attempt = "idle"`，把并发进入
   人为串行化了；
2. 第一版 Ownership 把「存在一条能成功的轨迹」写成时态性质 `<>released`，TLC 在
   **参考模型自己身上**就报反例（Init 上 `Quiesce` 自环即可永不到达释放）；
3. 下界性质里写了 `IsM10 \/ …`，等于让「一律拒绝」这个突变体给自己开后门，`m10` 直接存活。
   改用「存在指向当前登记的句柄」仍不够 —— 一律拒绝时句柄照样在，只是没人能用。
   最终只有 `ENABLED <动作>` 同时挡住了这三种错法。

另有一条工程性经验：TLA+ 里 `=` 比 `\/` 优先，`x' = x \/ y` 会被解析成 `(x' = x) \/ y`，
**根本不是赋值**。TLC 在 `-nowarning` 下静默接受（实测表现为 `released = null` 状态）。
现在 `runTlc` 不再加 `-nowarning`，并用 `INV_F01_GHOSTS_BOOLEAN` 把「幽灵变量只能是布尔」
变成可判定。

## 增加一个突变体

1. 在 `Lifecycle.tla` 的突变体块里加一个 `IsM6` 谓词，并在**一处**动作里用 `IF IsM6 THEN … ELSE …` 改语义；
2. 在 `mutants/` 下加一个 cfg，只改 `Mutant` 值；
3. 在 `verification/run-formal.mjs` 的 `SCENARIOS` 里登一行，写清 `expect`（应撞的不变量名）；
4. 重跑 `node verification/run-formal.mjs`；存活就是失败。

## 禁止的模型写法（专家合同 §2）

- 把 `WaiterTimeout` 定义为 `HandlerSettle`；
- 把「stop 调用已返回」直接等同「插件真实终止」——所以 `handlerDone` **只由环境动作写**，`stopClaim` 才是 Core 的答复；
- 把 `owner` 自报字符串定义为天然可信注册身份 —— 这条现在由 `Ownership.tla` 的
  `ReleaseByString` / `IsM7` / `IsM9` **显式建模为对手动作**，并在参考模型里什么也改不动。

## 文件

| 路径 | 内容 |
|---|---|
| `Lifecycle.tla` | 模型正文；不变量以 `INV_` 开头 |
| `Ownership.tla` | F01 模型正文（登记身份 / 定向凭据 / 实例清场） |
| `Lifecycle.cfg` / `Lifecycle.nofault.cfg` | 两个参考环境 |
| `Ownership.cfg` | F01 参考环境（两实例 / 两笔登记 / 两枚句柄） |
| `mutants/*.cfg` | 只改 `Mutant` 一个常量 |
| `tla2tools.jar.sha256` | 工具链 pin（URL / 版本 / hash / 校验时间） |
| `fetch-tlc.mjs` | 下载器；hash 不符拒不落盘 |
| `.tools/` | 下载后的 jar（**不入库**） |
