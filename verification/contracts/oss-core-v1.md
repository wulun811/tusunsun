# OSS Core 外部可观察合同 v1（F01–F08）

> **本文件是「什么始终不许发生」的冻结版，不是「已经做到了」的声明。**
> 每一项分两段：**规范**（不变式，与实现无关）与**现状**（实测证据）。
> 只有**现状**一节能写状态词。

**基线**：`2e74bc7` / `0.16.0-rc.14`。双向 SHA、宿主环境与制品指纹见 `verification/baseline.json`。
**规范出处**：F01 的细则在 `contracts/capability-identity-v1.md`；本文件不重复它，只引用。
**制定原则**：先冻结业务不变式，再用适配器观察实现是否满足。
不得以「当前源码会怎么做」作为模型正确性的定义——那会把缺陷写成规范。

---

## 0. 状态词（严禁单词 `VERIFIED`）

| 状态词 | 含义 |
|---|---|
| `MODEL_PASS_BOUNDED` | 在**明确给定的**有限状态、动作与假设下，抽象模型未找到不变式反例。**不意味着**实现正确 |
| `MODEL_COUNTEREXAMPLE` | 抽象模型找到反例轨迹；需归类后才能称为缺陷 |
| `MODEL_INCONCLUSIVE` | 模型未覆盖到该动作，或状态空间未穷尽且无结论 |
| `IMPLEMENTATION_PASS` | 真实 Node 实现上的受控重放通过了该性质 |
| `IMPLEMENTATION_COUNTEREXAMPLE` | 真实 Node 实现上存在可重放反例 |
| `NOT_RUN` | 前置不满足，未执行；**不得**折算为 PASS |
| `NOT_MAPPED` | 模型动作到真实 API 的映射不可达，不得声称「实现已证明」 |

**组合规则**：`MODEL_PASS_BOUNDED` **不蕴含** `IMPLEMENTATION_PASS`，反向亦然。
两者必须分开登记，且并排出现时不得合写为一个「已验证」。

## 1. 可信前提（不满足则合同无效，而不是「实现错了」）

1. 同进程只加载**受信**插件。本契约不承诺抵御同进程任意恶意 JS。
2. 装载器能在装配期间持有**不可自造**的上下文（provider、epoch、登记标识）。
3. Core 能观察到一次调用的 settle，或能明确报告 `UNKNOWN`。
4. 进程内 JS 无隔离：能取得 Core 引用并读到私有字段的代码仍可自证。
   本契约消除的是**静默**绕过，不是构造一个安全沙箱。
5. 环境允许 handler 永不返回；因此只承诺**调用方等待有界**，不承诺外部资源已释放。

---

## F01 Ownership（归属）

- **性质**：安全（Safety）。
- **规范**：任何能力或服务的**覆盖**与**释放**，必须由可信登记持有者或受信宿主操作触发。
  名称相同**不**等于持有同一登记；自报 `owner` 字符串**不**构成授权。
- **禁止状态**：
  - `B` 以公开 `owner` 字符串等于 `A` 而覆写 `A` 的能力；
  - `B` 以同一手段释放 `A` 的能力；
  - 插件名恰为宿主哨兵（`@host`）而被当作宿主登记；
  - 旧世代装配的迟到清理删掉了**同 ID 的新一代**登记。
- **可观察面**：`listCapabilities()`（是否暴露 `owner` 与 `provider` 两个不同字段）、
  `getServiceOwnership(name)`、`core:capability.conflict` / `core:service.conflict` 事件、
  `capability_conflict` / `service_conflict` 错误码。
- **首轮强度**：模型 A（Ownership）+ 真实 Node 探针。**已建**（`model/Ownership.tla`）。
- **现状（rc.16）**：能力侧 `IMPLEMENTATION_PASS` + `MODEL_PASS_BOUNDED`（两个状态词都必须
  单独出现，不得合写成「已验证」）；**服务侧的「同 owner 更新」与「清场签发入口」在 rc.15 是
  `IMPLEMENTATION_COUNTEREXAMPLE`（专家 R15-03 / R15-02），rc.16 修后可以重新计为
  `IMPLEMENTATION_PASS`，但只在「受管 API 入口」这个口径下** —— 不得拿它抵消能力侧以外的东西。
  rc.15 分两步：先把**覆盖判据**从自报 `owner` 改为受信 `provider`；再按专家裁决 A
  把**撤销**从“名字”改为“登记” —— 每次发布铸 `registrationId` 与只存 WeakMap 的
  冻结凭据，撤销是 `compare-and-delete`，覆盖须 `overrideBy`，公开的按名批量入口
  （`releaseCapabilitiesByOwner` / `releaseServicesByOwner`）删除，生命周期按
  **插件实例**清场，装配账记凭据以防 ABA；`capability_conflict` 现在真的带
  `err.code`（此前只有 message 前缀，而 `service_conflict` 是带的）。
  **实现轨证据**：`test/unit/test-r031-registration-lease.test.mjs`（ID-01～ID-16 对
  真实 Core / LifecycleManager / ToolLoader）；`reports/implementation.json` 的
  `F01-REPLAY-01`（字符串不构成授权 / 旧句柄不得删后继 / 覆盖须凭据 / 无按名批量入口）
  与 `F01-REPLAY-02`（插件**不保存**凭据也能被按实例清干净，且不误删同名/无关登记）。
  旧证据 `test-r019` 5–9 仍绿。
  **rc.16/rc.17 补的三条（都是专家独立复审报的，本仓先复现再修）**：
  - **R15-03 自报 owner 当授权**：`runServiceTracking(owner, fn)` 是公开入口且 store 是
    `trusted:false`，而「同 owner 更新」分支只看 `claimant === prevOwner` 字符串相等。
    实测：`runServiceTracking('victim', () => registerService('db', {who:'attacker'}))`
    直接把 victim 的服务换掉，归属记录还写着 victim、登记号 1 → 2。
    修法：同 owner 更新只认两个**对象身份**（本实例宿主控制体，或登记这笔服务时的那个
    装配实例），自报字符串一律不得授权。证据：`verification/counterexamples/
    r15-03-same-owner-forgery.mjs`（3/3 FIXED，含两个合法正控）、`test-r15` /3。
  - **R15-02 公开面签发管理员证件**：`issueLifecycleReaper()` 是公开方法，而 `core.plugins`
    是公开 Map，于是「要求传真实 instance」不是授权条件 —— `core.plugins.get('victim')`
    取到实例后 `reaper('victim', instance)` 一次就把 victim 的能力与服务清空，插件还在表里。
    修法：删公开签发入口，清场闭包改为 Core 的 `#` 私有字段、**构造期一次注入**；
    `#reapRegistrations` / `#releaseServicesByOwner` 同时转 `#`。
    证据：`r15-02-public-reaper.mjs`（2/2 FIXED + **printed RESIDUAL**）。
  - **R16-01 服务侧按名字清理**（rc.17）：`discardAssemblyArtifacts` 的服务段取
    `store.serviceNames`（当时只有名字）直接删表，而提交早已按单次登记（对象 + 归属 +
    登记实例 + 登记 ID + 接管回执）。实测：旧 `init` 发布 `shared-db`（ID 1）→ 宿主接管
    （ID 2、`@host`）→ 旧 `init` 失败 ⇒ **B 被删**，而 `getServiceOwnership` 仍报
    `registrationId: 2`、接管回执仍在；再按 ID 2 释放还报 `ok:true`。修法：装配账改记收据
    `{name, registrationId, instance}`，删除收敛到唯一比较删除点 `_discardServiceReceipt`
    （比中才原子清五账，比不中返 `stale_registration`）。证据：专家原件
    `verification/expert-originals/r16-01`（退 0）、`test-r16-01` 的 a–l 十二条矩阵、
    `test/probes/r16-service-registration.mjs`（4/4）。
    **模型侧**：新增第五份模型 `ServiceRegistration.tla`（见 §4）—— 这是本轮唯一一处
    「原来的两份模型都真的没盖住」的地方，不是一个可以“再扩一扩”的空子。
  **模型轨证据**：`Ownership.tla` 八个不变量 + 六个突变体全部被杀（参考 1138 状态无违例），
  见 §4。
- **边界**：清场闭包与登记表都不是进程内安全边界；本项消除的是公开面上的
  “猜对名字即放权”。同进程拿到 `Core` 引用的代码仍可直接改私有表 ——
  那是 §4 前提 1 已排除的场景，不是本项遗漏。
  **rc.16 的残余（不掩）**：注入实例上的 `core.lifecycle._reap` 仍可直接调用（单测要拿它
  验「@host 拆不走」），`core._commitService` 等内部方法同理。纯 JS 单进程不保证恶意代码
  改不了私有表；本 RC 只保证**受管 API 入口**的纪律，进程边界不在本版范围。
  这是「半个抽象已经建好、判据没接上它」，不是「缺少一个 Principal 框架」。
  **模型侧的边界（写清楚，免得被当成实现了也安全）**：
  ① 句柄保密性**未入模** —— 模型假设凭据不可枚举，真实实现靠 WeakMap 私有绑定；
  ② 服务侧登记已由 F05 的**独立子模型** `HostControl.tla` 覆盖（见 F05 末段）：
     无世代闸门那条子项在 rc.15 关闭（`r032` 判据），`@host` 掌权路径在裁决 A' 后按
     「只认宿主控制体」建模并已修实现。F01 模型本身**仍不覆盖**服务侧 —— 两份模型各自
     有状态空间，混在一张表里会让两边的反例互相掩盖。
  ③ 「正例不许丢」由**实现轨**证明，不由模型证明 —— 状态不变量只能问「所有轨迹都如何」，
     问不了「存不存在一条能成功的轨迹」。`Invoke`/`LoadPlugin` 等外围动作也不在模型里。

## F02 Contract / Guard（准入）

- **性质**：安全。
- **规范**：没满足当前声明的**强制**准入条件时，受管动作不得派发。
  同一意图经不同入口（工具直连 / capability / sandbox 后端）时，守卫强度不得降低；
  `sandbox` 是**执行后端**，不是准入替代品。
- **禁止状态**：
  - 被 blocklist 阻断的工具在任一官方受管入口仍产生副作用；
  - `sandbox.on` 的准入要求低于 `sandbox.off`；
  - 跨站请求在动作派发**之后**才被校验；
  - 仅供观察的 post hook 被当作执行前准入。
- **可观察面**：`_invocationContext` 的拒绝码（`denied` + `side_effect:'none'`）、
  `core:capability.*` 事件、工具层审计记录。
- **首轮强度（修订）**：~~模型 A（Admission 部分）~~ + 外围路径探针。
  **本轮明确不为 F02 建模**，理由不是「意义不大」，是**建模会给出假保证**：
  F02 要的是「同一意图经不同入口，守卫强度不降」，这是一条**入口清单的完备性**性质，
  不是状态机性质。模型只能把我手写的入口清单喂给 TLC —— **清单漏一个入口，模型照样报
  `MODEL_PASS_BOUNDED`，而真实系统里那个入口就是敞的**。模型在这里证明的是模型自己，
  比不建更坏。模型化得动的只有两条**顺序**判据（跨站校验必须在派发前、post hook 不得当前置准入），
  而这两条是单线程确定性路径，`test-r024` /6 与 `test-r021` /1–/4 已经比模型更贴近实现。
- **替代证据（本轮采用）**：集中化的**入口清单** + 逐入口负例。该清单目前**尚未集中定义**
  （见下），这是 F02 唯一的真实阻塞点；在它存在之前，F02 不可能有合格的模型。
- **代价（必须与状态词一起读）**：F02 因此**到不了** `MODEL_PASS_BOUNDED` —— 不是「还没建」，
  是「建了也不成立」。
- **现状**：`PARTIALLY_MAPPED`。
  Core capability 路径的准入在 handler 之前且拒绝可承诺零副作用；
  **工具层与 sandbox 后端不在 Core 内**，本契约只能承诺「官方受管入口清单完备」这一前提，
  而该清单目前**没有集中定义**。此项目标状态为 `NOT_MAPPED`，不得因为 Core 路径通过就写整体 PASS。

## F03 Invocation（等待者 ≠ 尝试）

- **性质**：安全。
- **规范**：调用方等待超时**不得**使真实的 in-flight attempt 减少或释放资源。
  等候超时只结束「调用方在等」这一事实。
- **禁止状态**：
  - `WaiterTimeout` 被建模/实现为 `HandlerSettle`；
  - 超时后 in-flight 计数下降；
  - 把超时报成 `cancelled`（副作用已发生却自称已取消）。
- **可观察面**：`getInflight(owner)`、结果信封的 `execution_outcome` 与 `still_running_at_return`、
  错误码 `timeout_no_abort`。
- **首轮强度**：模型 B（Attempt 部分）+ 受控 `Promise`/Barrier 真实重放。
- **现状**：`IMPLEMENTATION_PASS` + `MODEL_PASS_BOUNDED`（有界，见 §4）。
  FORMAL-1 已补上独立重放：`verification/reports/implementation.json` 的 F03 记录
  （等锁者超时后，持有者的在途尝试照常返回 `effect-committed`，未被中断或清算）。
  模型侧是 `INV_F03_LEASE`（`attempt = "inflight" ⇒ leased`），偏差变体 `m1` 在
  `Enter → Enqueue → LockWaitTimeout`（深度 4）被杀。
  映射强度 `PARTIALLY_MAPPED`：模型的 `attempt` 是**一个**全局在途尝试，不是尝试集合。
  依据：`_dispatchCapability` 先登记 in-flight 再启动 handler，两者之间无 `await`；
  超时路径**不**递减 in-flight，由 attempt 自己的 `finally` 负责；
  返回 `state:'failed'` + `code:'timeout_no_abort'` + `execution_outcome:'unknown'`。

## F04 Transition（互斥持有）

- **性质**：安全。
- **规范**：同一生命周期 key 同一时刻最多一个**真实锁持有者**；
  已超时的**等待者**只能退出自己的等待资格，不得使后继提前越过仍在运行的持有者。
- **禁止状态**：
  - 同一 key 上活动持有者 ≥ 2；
  - 超时等待者释放了真实持有者的互斥；
  - 状态转移不经 allowlist。
- **可观察面**：`LifecycleManager#runExclusive` 的实际进入次序（受控 Barrier 轨迹）、
  `lock_timeout` 错误码、`getIllegalTransitions()`。
- **首轮强度**：模型 B（Force 部分）+ H7 真实交错重放。
- **现状**：`IMPLEMENTATION_PASS`（bounded：单进程内的 Promise 链）+ `MODEL_PASS_BOUNDED`（FORMAL-1，见 §4）。
  模型把「锁的记账」（`holders`）与「真的谁在跑」（`running`）写成**两个变量**，
  不变量只查后者 —— 记账可以骗人，事实不行。偏差变体 `m3`（等锁超时者释放别人的锁，
  即 H7 的形状）在 `Enter → Enqueue → LockWaitTimeout → Enter`（深度 5）处被杀；
  参考模型在 396 个不同状态（硬环境）与 528 个（正常环境）上无违例。
  修前是 `IMPLEMENTATION_COUNTEREXAMPLE`（H7）：队列是单尾指针，等待超时路径把自己从
  `_queues` 中**删除**；删除后新到调用方拿到已决议的空 `prev`，于是在原持有者仍在执行时
  **直接进入**——同 key 双持有者（实测峰值并发 2）。
  根因不是「少一把锁」，而是「**放弃等待**」与「**释放持有**」两条路径共用了同一段清理代码。
  现在 `abandon(restore)` 把两件事拆开：放弃等待只把队尾**退回 `prev`**，释放持有才删链。
  证据：`test/unit/test-r020-lifecycle-lock-and-stop-bounds.test.mjs` /1（峰值并发恒为 1）、
  /2（顺序 A,C,D，超时不插队）、/3（回收不泄露）、/4（异常透传与重入不受影响）。
  边界：只覆盖**单进程**内的 Promise 链；跨进程 / 多 Cell 同 key 不在本项范围内（`NOT_MAPPED`）。

## F05 Epoch（世代）

- **性质**：安全。
- **规范**：旧世代装配的异步提交**不得**改变新世代的当前登记。
  每次装配开始时取得可信 epoch；提交前复核 epoch。
- **禁止状态**：
  - epoch 已递增后，旧装配仍成功发布能力/服务；
  - `epoch == null` 的上下文被当作「当前世代」放行；
  - 迟到装配的清理删掉新代同 ID 登记。
- **可观察面**：`assemblyEpoch`、`isAssemblyCurrent(epoch)`、
  `assembly_superseded` 错误码、`core.stopped.outstandingAssembly`。
- **首轮强度**：模型 B（Epoch 部分）+ 迟到装配真实重放。
- **现状**：`IMPLEMENTATION_PASS`（能力与服务**两侧**）+ `MODEL_PASS_BOUNDED`
  （「旧代提交被拒」见 §4；**服务侧接管判据**见本节的「`@host` 掌权路径」，
  已由独立子模型 `HostControl.tla` 覆盖，`MODEL_PASS_BOUNDED`）。
  rc.15 关掉了原先那个服务侧反例：世代闸门被 `ctx0?.epoch != null` 短路，而公开 `runServiceTracking`
  传的正是 `epoch:null`。修前实测比合同原来写的更大：旧世代装配在 init 里调一次公开入口，
  **服务与能力双双 ALLOWED**（后者合同当时未记）。根因不是「服务侧少一道闸」，
  而是 `_runAssemblyContext` 把「内层没有传 epoch」当成了「没有世代」——于是公开入口就是个消磁器。
  现改为**来源继承**：`epoch`/`instance` 由外层下传，账也复用外层那两个 `Set`；
  但 `owner`/`trusted` 不继承（署名与受信只属于本层显式声明的世代，否则 S6 裁决作废）。
  顺带关掉一个次生缺陷：内层登记原先只记在内层账上，外层失败清理
  `discardAssemblyArtifacts(outerStore)` 收不回它（实测清理后服务仍在表里）。
  重放 `F05-REPLAY-01` 实测：掉代后的登记在**两道闸门**上同时被拒
  （`LifecycleManager._load` 的复核与 `Core.registerCapability` 的 `isAssemblyCurrent`），
  能力表里没有留下条目。同流程不掉代的正控（`F05-REPLAY-00`）会成功——
  没有这个正控，「被拒」可能只是别的异常。
- **`@host` 掌权路径（`IMPLEMENTATION_PASS`，专家裁决 A' 后已修）**：
  修前的反例是 `const takeover = opts?.takeover === true && claimant == null` ——
  「匿名 ⇒ 算宿主」。送审后专家裁定 **A'**：宿主专有控制能力只由构造期领取，
  并**明确否决** `core.issueHostHandle()`（`init(core)` 把 Core 本体交给插件，
  任何挂在 core 上、可由任意调用者领取的公开方法都不构成授权）。
  按裁决 §2.6「逐个列出入口」核算，同一个洞有**四条互相独立**的入口，全部实测复现过：
  ① 无 claimant 即宿主；② `service.allowOverride` 配置（取值来自 `config` **服务**，
  插件注册 `config` 即可自报 true）；③ `runServiceTracking('@host')` 自封后首次登记，
  造出连清场都拆不掉的飞地；④ 公开的 `issueLifecycleReaper()` 按 owner 名清场
  （`if (instance && …)` 在 `instance == null` 时整行跳过，一句 `reaper('victim', null)`
  就删掉别人的服务）。
  修法是把判据换成**对象身份**而非任一可列举字符串：模块私有 `WeakMap<Core, token>`、
  `_commitService` 单一提交点（`isHost` = `HOST_CONTROLS.get(this) === hostCtl`）、
  单次登记身份 `registrationId` 与 `compare-and-delete` 释放、`createRuntime()` 把
  「插件能看到的 core」与「只交给启动程序的 host」分开交付、清场把登记实例改为必要条件。
  判据 `test/unit/test-f05-host-authority-matrix.test.mjs`（H01–H18 共 20 条，含 4 条正例）。
  **模型侧同时入模**：`verification/model/HostControl.tla`（9 条不变量，独立状态空间）；
  突变 `m12-host-null-claimant` / `m13-host-trusted-is-host` / `m14-host-release-by-name`
  各自撞到对应不变量被杀死 —— 三项都没杀死的模型对这类偏差不敏感。
  **边界（不许读大）**：A' 闭合的是**受管 API 的身份错误与静默越权**，不是进程级隔离；
  同进程恶意 JS 仍可直接改私有 Map、猴子补丁。真正隔离需 R1 的进程/IPC 边界。

## F06 Dependency（依赖与停机次序）

- **性质**：安全。
- **规范**：有依赖 `B → A` 时，不得在 `B` 仍依赖 `A` 的情况下正常释放 `A`；
  合法排空时 `B` 先结束。依赖关系不可解析时（环、缺席提供者）必须**具名报告**，
  不得静默退化成一个看起来有序的序列。
- **禁止状态**：
  - 先释放被依赖方；
  - 依赖信息缺失却声称顺序正确（应用「插入序」冒充拓扑序）；
  - 环或缺席提供者被吞掉。
- **可观察面**：`core.stopped` 载荷的 `stopOrder` / `stopOrderBasis` /
  `stopOrderUnresolved` / `stopOrderCycles`。
- **首轮强度**：模型 B（Dependency 部分）+ 既有 R19 反例。**已建**（`model/Dependency.tla`）。
- **现状（rc.16）**：**rc.15 的 `IMPLEMENTATION_PASS` 不成立** —— 专家 R15-01 给出了合法图上的
  反例（跨 SCC 依赖被环豁免），已修；模型侧已补上缺的那张图（见下）。修复后本项在
  「同一 SCC 内的环边」上仍然是**有损例外**，不得读成「F06 满足」。
  停机次序由 `computeStopOrder` 逆拓扑计算，并**已**把 `basis`、`unresolved`、`cycles`
  写进 `core.stopped`——「凭什么有序」是可观察的。
  rc.15 补上了此前缺的**独立重放**（F06 重放记录，`model` 字段仍为 `null`：
  重放与模型是两件事，不许互相顶替）。五条判据：链式依赖 `top>mid>base` 且
  `basis=dependency`；单插件必须自报 `basis=insertion`；缺席提供者点名 `{plugin,dep}`；
  环交出 `a → b → a` 且停机不挂住；依赖方 running 时卸载提供方被具名拒绝
  （另一个方向：依赖方先走则放行）。**这条重放做过变异验证**：去掉 `order.reverse()`
  或把 `basis` 写死为 `'dependency'`，两条都会使它变成 `IMPLEMENTATION_COUNTEREXAMPLE`。
  **模型轨证据**：`model/Dependency.tla`（6 变量 / 5 动作 / 6 不变量 + 1 条下界性质），
  **三个**参考 shape（`chain` / `no-live` / `two-cycles-linked`）均无违例；
  `m15`–`m19` 与 `m21` 共六个突变体全部被杀死。
  **rc.15 的模型结论为什么没拦住 R15-01（覆盖债务，已补）**：当时的 `Cyclic` 是一个**扁平集合**，
  豁免写成「两个节点各自在某个环里」，而图上只有一个环 —— 两种写法在单环图上给出
  **完全相同**的结果，模型对那个错误不可能敏感。实测：把 `m21`（跨 SCC 错误豁免）放到旧
  `chain` 形状下跑，它**存活**（20 个不同状态、no error）。rc.16 新增
  `Shape=two-cycles-linked`（`a↔b` + `c↔d` + `c→a`）与 `m21`，后者在 5 个不同状态上撞
  `INV_F06_NO_PREMATURE_RELEASE`；同时把「声明过的 shape 必须真跑过」写进
  `scope_coverage`，声明的 shape 没跑时该模型自动降为 `MODEL_INCONCLUSIVE`。
  **R15-01 的实现反例**：`_pendingDependentsOf` 把 `stopOrderCycles` 里出现的所有节点并成
  一个 `cyclic` Set，`if (cyclic.has(name) && cyclic.has(plugin)) continue` 豁免的是
  「各自在某个环里」。实测：`a↔b` + `c↔d` + `c→a`、`c.stop()` 卡住 ⇒ `c` 仍 `running`，
  `a` 照样被停并变 `stopped`，`stopSkipped` 为空。修法：SCC 由 `computeStopOrder` 在
  **同一张解析后的硬依赖图**（只含 `requires`）上用 Tarjan 算并返回 `components`，豁免只认
  同一分量。证据：`test-r15` /1–/2、`verification/counterexamples/r15-01-cross-scc-exemption.mjs`
  （3/3 FIXED，含同图正控）。
  **模型撞出的实现反例（本轮修掉，此前无人报过）**：`顺序 ≠ 停在`。
  `_stopLocked` 的 for 循环逐条独立调 `_stopOnePlugin`，而后者在 `hold_timeout` 之后
  只把这次调用记成失败（`stop_return` / `unknown`），`plugin.state` **仍是 running** ——
  循环不回头检查依赖方是否真的停了，于是继续去停提供方。实测（修前）：
  `dependent` 超时后仍 `running`，`base` 的 `stop()` 照常被调用并变 `stopped`，
  而载荷里 `stopOrder:['dependent','base']` + `basis:'dependency'` 读起来像
  「按正确顺序停好了」。**账面顺序对了，事实错了。**
  修法：每轮重新判一次（`_pendingDependentsOf`，环内边豁免 —— 否则停机永远停不完），
  仍有未停好的依赖方就跳过并记 `stopSkipped` / `skipped_dependents_pending`；
  新载荷字段 `stopSkipped` 与 `stopFailures` **分开**：一个是「根本没动」，
  一个是「试着停但没停成」。证据 `test-r032` /1–/4，且**做过双向变异验证**：
  退回逐条独立停会使 /1、/4 红；把环内豁免写宽成一律豁免同样使 /1、/4 红。
- **边界**：`core.stop()` 有界返回**不等于**提供方已被释放（那是 F08 管的事），
  反过来 F08 的「有界」也不构成「为了有界只好牺牲顺序」的理由 —— 两件事各自成立。
  模型不覆盖环检测算法本身（`Cyclic` 由 shape 给出，只问「有没有报出来」），
  也不覆盖停机失败后的**外部**效果与进程隔离。

## F07 Evidence（事实不得被代签）

- **性质**：安全。
- **规范**：后置事件/观察者异常**不得**把已经成功的动作改写为失败；
  `UNKNOWN` 不得变成「确定未执行」。已写入磁盘的动作，即使后置审核失败，
  也不能报成「从未执行」。
- **禁止状态**：
  - `dispatched:true` 的动作被报成 `side_effect:'none'`；
  - handler 抛错时信封缺 `dispatched`；
  - 观察者异常冒泡回主路径并改变结果。
- **可观察面**：结果信封的 `execution_state` / `dispatched` / `side_effect` / `handler_threw`、
  `getObserverErrors()`、`getFactDegraded()`。
- **首轮强度**：精确合同 + 实现测试。~~第二轮入模~~ —— **本轮明确不为 F07 建模**。
  理由同样是**工具选错**而不是「意义不大」：F07 管的是「观察不得改写事实」，
  而 `postCheck` 是在工具已经 resolve **之后**才被调用、观察者错误就地 catch 的一条直线
  （`plugins/tool-executor.js` 的 `_runPostFence`），不存在第二个可能的下一个状态 ——
  没有交错，就没有模型的事。它真正有内容的那一格是一个**纯函数**：
  `f(路径, code, dispatched) → {dispatched, side_effect}`，禁止 `dispatched:true` +
  `side_effect:'none'` 这种自相矛盾对。搬进 TLA+ 的代价是 `_failureFromThrown` 那张判断表
  要在 TLA+ 里再抄一遍 —— 抄完两份各自漂移，**模型此后证明的是它自己那张表**。
  决策表穷举 + 变异验证（下文 /1–/6 的形态）比它更紧。
- **替代证据（本轮采用）**：决策表穷举（code × 路径 × dispatched）+ 变异验证。
  判据是**双向**的：`test-r024` /1–/3 与 `test-r026` /1–/4 要求「故障不得改写事实」，
  /4–/6 反向要求「正常观察仍必须改写」「`preCheck` 故障仍必须拒绝」—— 少了反向那半，
  把观察器整个关掉就能让整条变绿。
- **代价（必须与状态词一起读）**：F07 也**到不了** `MODEL_PASS_BOUNDED`，理由同 F02。
- **现状**：`IMPLEMENTATION_PASS`。Core 的错误信封已经有 `dispatched` / `side_effect` 三态，
  且观察者错误单独记账。工具执行器的 `postCheck` 曾经是这条性质在**外围**的反例（M2）：
  围栏一抛错，异常就穿进 `_executeOneInner` 的 catch，磁盘上已经写完的写被回报成 failed，
  且 `tool.result` 与审计一条都不写（实测：文件存在、`executeOne` 抛 `fence down`、审计 0 条）。
  现在两处调用点都经 `_runPostFence` —— 观察不是事实源：`ok` / `state` / `code` / `result_kind`
  一律不因围栏故障变，故障本身写进 `fence_error`（结果信封 / 审计条目 / `tool.fence_error`
  事件三处同形）。证据 `test-r024` /1–/3；反向判据 /4–/6（正常围栏仍改写、返回非字符串不改写、
  `preCheck` 抛错仍拒绝执行）。
  仍留一格（已在本轮关闭，见下）：Core 信封原先只在“拒绝码被降级”时才写执行阶段证据，
  `handler_threw` 反而 `dispatched` / `side_effect` 两个字段都没有（M6）。
  —— M6 落地：`_failureFromThrown` 改成“凡 `dispatched === true` 必写 `post_dispatch` +
  `unknown_or_possible`，`false` 写 `side_effect:'none'`”。“缺字段”与 `false` 在 JSON 里
  不可区分而语义相反（不知道 vs 确定没跑），这一格不能留。证据 `test-r026` /1–/4。

## F08 Reconcile（有界收口）

- **性质**：安全 + **有条件**活性。
- **规范**：停机时，若某个 `stop()` 永不返回，Core 必须在给定 deadline 之后
  向**调用方**返回一个**有界且诚实**的结果（`stuck` / `partial`），
  且不得声称「已 stopped、资源已清理」。
  有界的是**调用方等待**，不是底层 handler 被强行终止。
- **禁止状态**：
  - `stop()` 因单个挂起插件而永不返回；
  - 未完成清理却发出 `core.stopped` 且载荷无 `stopFailures` / `outstanding`；
  - 用「stop 函数已返回」推导「插件已真实终止」。
- **可观察面**：`core.stopped` 载荷（`stopFailures`、`outstandingAssembly`、
  `stopOrderUnresolved`）、`stop()` 的返回时刻。
- **首轮强度**：精确合同 + H8；FORMAL-1 已入模（第二轮提前完成）。
- **现状**：`IMPLEMENTATION_PASS`（bounded）+ `MODEL_PASS_BOUNDED`（见 §4）。
  模型里 `handlerDone`（环境事实）与 `stopClaim`（Core 对调用方的答复）是**两个变量**，
  且只有环境动作能写前者 —— 这直接把「stop 调用已返回 = 插件真的停了」写成不可表达。
  偏差变体 `m4`（期限到了就宣称已停）撞 `INV_F08_NO_FAKE_STOPPED`（深度 3）；
  `m5`（停机没有期限）被 TLC 报 `Deadlock reached` —— 那正是 H8 修前的形状。
  修前是 `IMPLEMENTATION_COUNTEREXAMPLE`（H8）：`timeoutMs` **只约束等锁**，`runExclusive`
  在 `lease.active = true` 之后是裸 `await fn()`。一个永不返回的 `plugin.stop()` 让
  `Core.stop()` 永不返回 —— 实测连测试进程本身都以 `exit 13` 收场
  （`Detected unsettled top-level await`），`core.stopped` 永远不会被发出。
  现在 `holdMs` + `_holdBounded()` 只保证**调用方等待**有界：到点抛 `hold_timeout`，
  **不释放锁**，把释放权交给仍在跑的 `fn`；期间该 key 的再次进入以 `lock_abandoned`
  具名快速失败，`fn` 结账后标记自动撤销（不永久中毒）。
  回执按三阶段分开写：`lock_wait`（`stop()` 一次都没被调，`execution_outcome: none`）、
  `stop_call`（调了但抛错，`unknown`）、`stop_return`（到点没返回，`unknown`，
  插件状态**不得**推成 `stopped`）。
  证据：/5（有界返回）、/6（分阶段 + 不报 stopped）、/7（快速失败）、/10（`lock_wait`）、
  /8（结账后恢复）。
  边界：底层 handler **没有被强行终止** —— 这正是本合同允许的（只要求 caller 有界）。

---

## P01–P17 外围协议性质（不进 F01–F08 状态机）

这四条用属性测试与协议状态机更合适；写在这里是为了不丢。

| 编号 | 性质 | 现状 |
|---|---|---|
| **P01** | Stream parser 不丢合法 SSE 帧（尾部无空行、`data:` 可选空格、心跳） | `IMPLEMENTATION_PASS`（H1/H3；证据 `test-r023` /1–/4） |
| **P02** | UTF-8 任意分片解码等价，不产生 U+FFFD | `IMPLEMENTATION_PASS`（H4；证据 `test-r023` /5–/6） |
| **P03** | workspace sandbox 开关不放宽准入 | `IMPLEMENTATION_PASS`（S1；证据 `test-r022` /6–/8） |
| **P04** | gateway 跨站请求在动作派发前被拒绝 | `IMPLEMENTATION_PASS`（S9；证据 `test-r021` /1–/4） |
| **P05** | 畸形 WS 帧不得杀死网关进程，且之后的连接仍可建立 | `IMPLEMENTATION_PASS`（S8；证据 `test-r021` /5–/6） |
| **P06** | 路径判据必须按**链接目标**判，悬空链接不得逃逸 | `IMPLEMENTATION_PASS`（H5；证据 `test-r022` /1–/5；边界：TOCTOU 不在本项） |
| **P07** | auto-edit 档位下，命令分隔符不得被当成“白名单命令的后缀”放行 | `IMPLEMENTATION_PASS`（H6；证据 `test-r022` /9） |
| **P08** | `tools.blocklist` 必须在**能力**侧生效 | `IMPLEMENTATION_PASS`（M1；证据 `test-r022` /10） |
| **P09** | 空流必须具名结算（error + 遥测），不得把异常抛给调用方 | `IMPLEMENTATION_PASS`（S2；证据 `test-r023` /7、/9） |
| **P10** | 中途断流必须报 error 并带 partial，不得把半截正文称完成 | `IMPLEMENTATION_PASS`（H2；证据 `test-r023` /8） |
| **P11** | 后置观察（围栏 `postCheck`）故障不得改写执行事实，且必须留下异常证据 | `IMPLEMENTATION_PASS`（M2；证据 `test-r024` /1–/6） |
| **P12** | 沙箱公布的 op 必须真有实现；未实现的具名拒绝，不得把它当通用资源错误 | `IMPLEMENTATION_PASS`（M5；证据 `test-r027` /1–/4） |
| **P13** | 「正文为空」是正常响应，不得被任何观察者改写成失败；失败结果不得冒充摘要 | `IMPLEMENTATION_PASS`（S3；证据 `test-r028` /1–/4） |
| **P14** | 历史裁剪必须按轮成组收放，不得拆散 `assistant(tool_calls)` 与其 `tool` 结果 | `IMPLEMENTATION_PASS`（S4；证据 `test-r028` /5–/7） |
| **P15** | 插件名必须格式可判定（`^[a-z0-9][a-z0-9._-]*$`，不得 `@` 前缀），三个入口共用同一份判据 | `IMPLEMENTATION_PASS`（S7；证据 `test-r029` /1–/5） |
| **P16** | 「看工具名」的判据必须对对象与字符串**同形**，不得对对象直接做 `RegExp.test` | `IMPLEMENTATION_PASS`（M3；证据 `test-r030` /1–/2） |
| **P17** | 字节切片不得切断 UTF-8 字符；`byte_range` 与 `next_offset_bytes` 必须落在字符边界 | `IMPLEMENTATION_PASS`（M4；证据 `test-r030` /3–/5） |
| **P18** | 撤销权必须属于**单次登记**：凭据不可枚举、撤销是 `compare-and-delete`；名字与 `owner`/`provider` 字符串一律不作授权，按名的批量入口不得存在 | `IMPLEMENTATION_PASS`（S6/E-3；证据 `test-r031` ID-01～ID-16；边界：进程内引用泄漏不在本项） |

P01/P02/P09/P10 是同一次重构的四个面：帧处理原先在「循环里」与「收尾 flush 里」各写了一份，
两份漂了 —— 收尾那份没有 `tool_calls`（H1）。现在只有一份 `handleLine`，循环与收尾都调它；
解码改成 `TextDecoder(..., { stream: true })`（H4）；`data:` 后的空格用 `/^data: ?(.*)$/` 接纳（H3）；
空流/断流的收尾报错读的 `roundContent` 从 `while` 作用域提到尝试作用域（S2 的 ReferenceError）。
H2 另加一层：`for await` 外包 `try/catch`，断流不再以异常形式抛给调用方，而是
`{ error: true, partial, uncertain: true }`，遥测 `finishReason` 写 `error`。

P11（M2）是同一个错误方向在外围的另一个落点：**一层替另一层签字**。
围栏的 `postCheck` 在工具跑完之后才被调用，它只能回答“输出要不要脱敏”“熔断要不要计数”，
不能回答“这次执行成没成”。两处调用点原先都是裸 `await`：成功路径上围栏异常被
`_executeOneInner` 的 catch 当成了执行失败（磁盘上已写完），错误路径上原始 `code`
与“效果未知”被整个顶掉。现在两个方向分开写 —— `preCheck` 故障 = 拒绝（fail-closed），
`postCheck` 故障 = 记账（不改写事实）。故障证据同形落三处：结果 `fence_error`、
审计条目、`tool.fence_error` 事件。反向判据 /4–/6 用来证明修的不是“把围栏关掉”。

P13（S3）与 P11 同形，只是这次的“代签者”是一句**遥测代码**：
`call()` 里 `content.slice(0, 100)` 只为打日志取前 100 字，但强制 `tool_choice` 时上游回
`content: null` —— 这是正常响应，证据在 `tool_calls` 上。抛错被同一个 `try/catch` 接住，
于是一次成功被改写成 `[API Error] Cannot read properties of null`；更糟的是
`_extractSummary` 会把这句错误串当摘要存下，之后每轮以 `## Conversation Summary` 注入
system prompt。现在解析层把 `content` 归一成空串（`choice.content ?? ''`），遥测取值自带
兜底，摘要链路遇 `error:true` 返回空串走失败分支。反向判据 /4 证明“空正文 ≠ 摘不到”。

P14（S4）是“同一条规则只守住一个入口”的又一例：`_lib/context-budget.js` 里**已经有**
`groupIntoTurns` 并写明理由，但它只为声明了 Cell 预算的会话服务；默认策略 `sliding` 与
摘要路径的两条裁剪函数仍逐条按 token 收，切点落在 `assistant(tool_calls)` 与它的 `tool`
结果之间，上游直接 400。现在两条裁剪都按组收放、整组装不下就整组停，保留段开头不再是
无主的 tool 结果。判据是**扫预算**（/5、/6 各扫 200 余个预算值，孤儿切点必须为 0），
反向判据 /7 证明分组不等于“干脆不裁”。

P15（S7）是**注释把未验证的前提写成了事实**：`HOST_OWNER = '@host'` 旁边断言
“‘`@` 开头不是合法插件名’，于是‘这条服务谁都不能按名卸载’成为可判定的”，而内核里
从来没有校验过插件名。于是一个叫 `@host` 的插件就成了宿主：它注册的服务归属与宿主标记同值，
`releaseServicesByOwner('@host')` 按设计拒绝释放，卸载之后服务还在，任何 API 都拆不掉。
同一条缺失的判据还管着第二件事：`name` 会被直接拼进路径（`join(dir, name + '.js')`），
所以 `../x` 能把插件目录之外的任意文件装进来（本轮实测：修前 `loadOne('../outside')` 为 `ok:true`）。

现在判据只有一份（`plugin-meta.js` 的 `PLUGIN_NAME_RE` / `isValidPluginName`），
在 `Core.register`、`PluginManager.loadOne`、`PluginManager.indexLazy` 三处入口共用；
越界一律具名 `plugin_name_invalid`，且 `loadOne` 是**先判名字再碰磁盘**。
结构判据 /3 把仓内 78 个真实插件名逐一过判据（防正则写窄），另附 10 个坏名与 5 个好名的
正反例；反向判据 /4 证明合法名照旧能真的装载。
边界：本条只管**名字的形状**，不回答“谁有权用这个名字”——那是 S6 释放半边（送审中）的事。

P16（M3）是同一个“同形”问题的另一面：`prompt-builder` 里两条看工具名的判据写法不一致——
`_injectWorkspace` 用 `t.name || t`，`_injectSafetyReflection` 直接 `RegExp.test(t)`。
后者对**对象**做 `test` 会先 ToString 成 `"[object Object]"`，永不匹配；而真实调用面上
`ctx.tools` 几乎总是对象。于是 `tools.safetyReflection` 承诺的“写文件/执行命令前先自检”
在部署里恒等于关闭，开关看起来却是开着的。现在两条判据共用同一写法（`String(t?.name ?? t)`），
结构判据 /2 拿 8 个真实工具名 × 两种形态逐项比对，任何一边漂了都会红。

P17（M4）是**把一个字节预算当成了字符预算**：`context.pull` 的 `charBudget` 直接加在字节偏移上，
`subarray` 切在多字节字符中间，`toString('utf8')` 产出 U+FFFD；更糟的是 `byte_range.to` 与
`next_offset_bytes` 把损坏位置**固化成续读起点**，于是每段开头带一个替换符、拼起来永远不是原文，
而 `sha256` 覆盖的是损坏后的字节（逐段校验会把正确文件判成不一致）。现在切片两端
都退到字符边界上（起点落在续字节则前进，终点切断多字节则后退），`to` / `next_offset_bytes` /
`sha256` 随之自动一致。判据是**扫预算**（/3 扫 140 个预算值：0 个替换符、0 个越界切点、
哈希自洽），/4 要求逐段拼接**等于原文**，/5 反向要求 ASCII 仍按预算取满（边界回退不得变成缩水）。

---

## 2. 不覆盖范围（写清楚比写满更重要）

- 同进程任意恶意 JS 的隔离；
- 外部 API 幂等性；
- 文件系统竞态（符号链接目标替换、TOCTOU）在无真实操作层保障时的对抗能力；
- 第三方网络请求的全量拦截（JS Core 无法拦截进程内任意副作用）；
- TLC 未运行时的任何「已形式化验证」说法。

## 3. 证据规则

1. 每一项从 `COUNTEREXAMPLE` 变成 `PASS`，同日附「**修前复现** + **修后拒绝** + **原合法正例**」三类证据。
2. 反例必须来自真实制品（源码树或 `.tgz`），不得用抽象模型反例直接标为产品缺陷。
   出现模型反例时先归类：`MODEL_BUG` / `MODEL_DESIGN_COUNTEREXAMPLE` / `IMPLEMENTATION_COUNTEREXAMPLE`。
3. 模型动作到真实 API 的映射逐条登在 `verification/adapter/mapping.csv`，
   不可达写 `UNMAPPED`，**不得**自动变绿。
4. 平台/环境缺失时写 `NOT_RUN` 并说明前置；不得用「没看到失败」代替「跑过了」。

---

## 4. 模型轨（FORMAL-1）现状

模型、突变体、重放三条线都已经有**可重跑的产物**，但强度仍然是「有界」。

| 项 | 值 |
|---|---|
| 模型 | `model/Lifecycle.tla`（13 变量 / 11 动作 / 4 不变量 + 1 限时性质）、`model/Ownership.tla`（11 变量 / 7 动作 / 8 不变量）、`model/HostControl.tla`（5 变量 / 5 动作 / 9 不变量）、`model/Dependency.tla`（6 变量 / 5 动作 / 6 不变量 + 1 下界性质）、`model/ServiceRegistration.tla`（8 变量 / 6 动作 / 5 不变量） |
| 覆盖 | F01（Ownership + ServiceRegistration）/ F03 / F04 / F05（能力侧 + 服务侧接管 + 服务登记身份）/ **F06** / F08 |
| 不覆盖 | F02 / F07（**明确不建**，理由见各自小节：建模会给出假保证 / 无交错可穷举）；F01 的**句柄保密性** |
| 工具链 | TLC `2026.10.24.013619`，`tla2tools.jar` 按 `model/tla2tools.jar.sha256` 钉住；Java 21 |
| 参考运行 | Lifecycle 396 个不同状态（`StopFault=TRUE`）/ 528 个（`FALSE`），深度 12；Ownership 217 个，深度 5；HostControl 深度 5；Dependency 20 个（`chain`）/ 28 个（`no-live`），深度 6；ServiceRegistration 84 个，深度 8。五份都无违例 |
| 突变体 | **22 个，全部杀死**：`m1`–`m5`（Lifecycle）、`m6`–`m11`（F01）、`m12`–`m14`（F05 服务侧接管）、`m15`–`m19` + `m21`（F06）、`m22`–`m23`（服务登记身份） |
| 真实重放 | **10 条记录全 `IMPLEMENTATION_PASS`**（`reports/implementation.json`） |

**逐模型判定，不合并总分**（`per_model`）：Lifecycle / Ownership / HostControl / Dependency /
ServiceRegistration 五份各自 `MODEL_PASS_BOUNDED`，各自 `killed == mutants` 且 `survived == 0`。
一份全绿不代表另一份有模型 —— 合起来算一个绿灯，就是把五份覆盖混成一句空话。

**这五句话必须一起读：**

1. `MODEL_PASS_BOUNDED` 说的是「在这份 `.cfg` 的那几个维度上穷举完了、没找到反例」。
   它不是「实现安全」，也不是「已被形式化验证」。`run-formal.mjs` 现在**逐模型**判定
   （`per_model`），不合并成一个总分 —— 合并就是把两份模型的覆盖混成一句空话。
2. 突变体活下来就**不算通过**。这条不是口号，本仓踩过三次：
   ① 第一版 Lifecycle 没杀死 `m3`（`Enter` 前置条件多写了 `attempt = "idle"`，把并发进入
   人为串行化）；② Ownership 第一版把「存在一条能成功的轨迹」写成时态性质 `<>released`，
   TLC 在**参考模型自己身上**就报反例；③ 下界性质里写了 `IsM10 \/ …`，等于让突变体
   给自己开后门，`m10` 直接存活。三次都记在 `reports/model-check.json` 的
   `sensitivity_audit` 里 —— 模型自己也要被杀死一次。
3. 缺 JDK / 缺 jar / jar 的 sha256 与 pin 不符时，`node verification/run-formal.mjs`
   写 `NOT_RUN`，**不会**写 PASS（合同 §7）。
4. 重放只证明**那八条轨迹**。它是「模型 ↔ 实现」关系存在的证据，不是全空间遍历。
5. **崩溃不得留下绿灯**：`run-formal.mjs` 在开跑前先作废旧报告并落 `NOT_RUN` 哨兵。
   这一条是补出来的 —— S7 收紧插件名之后，实现轨夹具还在用 `'A'`，脚本在第一条重放
   之前就崩了，而磁盘上留着上一轮的 `IMPLEMENTATION_PASS`。一个崩溃被当成了证据。

复跑：

```bash
node verification/model/fetch-tlc.mjs   # 下载并校验 jar（离线用 TLA2TOOLS_JAR）
node verification/run-formal.mjs        # 模型轨 + 实现轨 → reports/ 与 counterexamples/
```
