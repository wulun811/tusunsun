# ADR-10：核心行数预算与"超额必须批准"的程序

- 状态：**已采纳**（v0.14.1），取代此前散落在 `scripts/core-limits.mjs` 注释里的逐次记录
- 影响面：`src/core/`（8 文件，当前 4889 行）、`scripts/core-limits.mjs`、`scripts/line-check.js`、
  `package.json` 的 `description`、`README.md`、`docs/architecture/microkernel.md`
- 决策者：维护者（用户），执行方起草
- 触发：专家 0.14.0 复审 §5 明确要求"行数增加 524 行应有 ADR 明确 2746 的由来、预算上限
  和以后什么样的改动可以获批"

## 1. 要决定的问题

三个问题必须一起回答，只答一个都不构成批准：

1. **2746（现在 3168）这个数是怎么来的**——是设计目标，还是历次修复的累加？
2. **上限本身怎么定**——钉死在某个数字，还是随实测水位棘轮？
3. **什么样的改动可以获批增长**——否则"批准"只是一句事后追认。

专家原话（§5）："不建议为回到 2222 去删除重要检查，但应有 ADR 明确 2746 的由来、预算上限
和以后什么样的改动可以获批。2222 可以作为历史设计目标，不应继续作为当前事实宣传。"

## 2. 事实：数字的由来

**2222 是历史设计目标，不是当前事实。** 它对应 v0.10.1。此后每一次增长都在
`scripts/core-limits.mjs` 里逐条记了来历（含日期、增量构成、为什么不能削）。

| 版本 | 上限 | 增量来源（摘要） |
|---|---|---|
| v0.9.25 前 | 2000 → 2500 | 维护者令："这个 2000 行的限制太难为你了" |
| v0.9.33 | 2150 → 2157 | E1 生命周期三条失败路径；E3 诊断委托 |
| v0.10.0 | 2157 → 2208 | E1-b 在途守护 + ADR-03 拆 `tool_not_registered` |
| v0.10.1 | 2208 → **2222** | **Node 18 真阳性**：用户插件目录缺 package.json 时无法 ESM 装载 |
| v0.12.0 | 2222 → 2610 | P1–P4：执行面合流、生命周期归一、场景五段式、小合同 |
| v0.14.0 | 2610 → 2746 | §6.2 串行化（`runExclusive` + ALS）、§5.3 `attempt_token`、`advance()` |
| v0.14.1 | 2746 → **2880** | 本轮五条复审反例的修复（见 §3）；**原表误记 2865，v0.15.0 更正** |
| v0.15.0 | 2880 → **3009** | INV-01 + SC-01～05 六条复审反例（见 ADR-13） |
| v0.15.1 | 3009 → **3193** | ERR-015 + SC-015 收口、ADR-11 七类接线（见 §5 归因） |
| v0.15.2 | 3193 → **3267** | LAZY-01～04：真实装载 Attempt 与等候方分开记账（见 core-transition-contracts §1.6） |
| v0.15.3 | 3267 → **3531** | X01～X03：装配的**提交时机 / 归属 / 有效范围**（见 core-transition-contracts §1.7） |
| v0.15.4 | 3531 → **3870** | K3 合法转移表 + K4+X04 服务权属原子化 + H-01～H-04 Hook 接点（见 §5.4） |
| v0.15.5 | 3870 → **4059** | R25：已提交事实清单收口（4 处 `emitFact`）+ 异步观察者拒绝隔离 + 事实载荷深快照 + 订阅/中间件按 entry 精确撤销 |
| v0.16.0-rc | 4026 → **4059** | R3-00 装配顺序：`requires` 的键按**服务名**解析到提供者插件（修前 `tool-registry` 被当插件名查，DAG 必失败并回退目录顺序，`liuhe-lite` 因此永远装不上）；+33 行，其中解释约 24 行 |
| v0.16.0-rc.4 | 4059 → **3950** | 发布前注释精炼：8 个文件**只动注释**，可执行 token 与 rc.3 逐文件相同；整行注释 1188 → 1079，历史标记 347 → 1（已批准）；棘轮随实况下调，不留空额 |
| v0.16.0-rc.5 | 3950 → **3968** | R5-01 权威唯一性：生命周期独占区归一到 `core.lifecycle` 单一实例（此前 `PluginManager` 另建一份，同一 key 两把锁）；停机顺序改用 `computeStopOrder`，与启动排序共用同一份依赖边解释。代码 +48 行（`dependency-resolver.js` 249 → 326），同轮注释净 −37 行，合计 +18 |
| v0.16.0-rc.6 | 3968 → **4180** | R19：依赖边的解释推广到**全部消费者**（卸载闸门 `dependentsOf`、懒加载闭包 `resolveLazyChain`、装载前的待装提供者解析）；运行时服务归属优先于 `provides` 声明。代码 +37 行，注释 +26 行，合计 +65 |
| v0.16.0-rc.15 | 4180 → **4194** | S5 的 scope 判定改成 null 原型 + `Object.hasOwn`（4 处调用点，读写两端同一张表）；S6 的覆盖判据改读受信 `provider`（`asm.trusted` + 同源比较，两边无来源时保留原同 owner 判据）。代码与解释注释合计 +14，**无重排**；同轮新增 `CORE_MAX_BYTES` 字节第二道闸 |
| v0.16.0-rc.15 | 4194 → **4273** | 同版第二次上调（RC14-LIFE / H7+H8）：`lifecycle-manager.js` 444 → 508 —— 持有段哨兵 `HOLD_TIMEOUT`、`_abandoned` 集合与 `lock_abandoned` 快速失败、`_holdBounded()`、`abandon(restore)` 把「放弃等待」与「释放持有」拆开，其余为解释注释；`core.js` +15 —— `_stopFailure()` 三阶段回执与 `holdMs` 接线。增量全是行为与不变式，`runExclusive` 内一处重排 |
| v0.16.0-rc.15 | 4273 → **4275** | 同版第三次上调（RC14-LIFE / M6）：`core.js` +2 —— 证据字段从"仅拒绝码被降级时写"放宽到"凡 handler 抛出必写"（`handler_threw` 原先一条执行阶段证据都没有），预派发失败同时补 `dispatched:false` / `side_effect:'none'`。+2 行中含 1 行解释注释，无重排 |
| v0.16.0-rc.15 | 4275 → **4306** | 同版第四次上调（RC14-IDENT / S7）：插件名从"非空即可"改为**格式可判定** —— `plugin-meta.js` 新增 `PLUGIN_NAME_RE` 与 `isValidPluginName()`（`^[a-z0-9][a-z0-9._-]*$`），`core.js` 的 `register()` 与 `plugin-manager.js` 的 `loadOne()` / `indexLazy()` 三处入口共用它，合计 +22 行；另 +9 行为解释注释（`HOST_OWNER` 旁边那句"`@` 开头不是合法插件名"此前只是断言，现在才有代码兑现）。无重排 |
| v0.16.0-rc.15 | 4306 → **4377** | 同版第五次上调（RC14-IDENT / S6 释放半边）：撤销从"按名字"改为"按单次登记" —— `core.js` +58（登记身份 `registrationId` 与 WeakMap 凭据、`releaseRegistration` 的 `compare-and-delete`、生命周期清场闭包、按名批量入口删除、装配账改记凭据以防 ABA），`lifecycle-manager.js` +7（构造期领清场通道、`_unload` 传插件实例、`_runAssemblyContext` 带实例）。增量全是判据与不变式；一处行为变更：旧 `releaseCapability(id, owner)` 只回 `capability_release_denied` |
| v0.16.0-rc.15 | 4377 → **4388** | 同版第六次上调（RC14-FORMAL-1 残项 / F05 服务侧反例）：两件事挤在同一行。① `registerCapability` 的 `capability_conflict` 终于挂上 `err.code`（此前只有 message 前缀，而 `service_conflict` 那条路径是挂的 —— 形式化重放按 `err.code` 分支时才暴露），`core.js` +6。② `_runAssemblyContext` 改为**来源继承**：`epoch`/`instance` 由外层下传、账复用外层 `Set`，于是旧世代装配不再能靠嵌套公开 `runServiceTracking` 取得无世代 store 绕过世代闸门（实测修前服务与能力双双 ALLOWED，内层登记还能逃出外层失败清理），`core.js` +5。增量全是判据与不变式，无重排 |
| v0.16.0-rc.15 | 4388 → **4486** | 同版第七次上调（F05 宿主接管 / 专家裁决 A'）：服务跨 owner 的授权判据换成**对象身份**而不是任一可列举的字符串。`core.js` +98 —— `HOST_CONTROLS`（模块私有 WeakMap，构造期绑定本实例，`core` 公开面**不发证**）、`registerService` 拆为入口 + `_commitService` 单一提交点（`isHost` 由 `HOST_CONTROLS.get(this) === hostCtl` 判定）、`_serviceRegIds`/`_svcSeq` 单次登记身份、`_releaseHostService` 的 `compare-and-delete`、`createRuntime()` 把 `core` 与 `host` 分开交付；其余 7 个文件 0 改动。四条独立后门同时封：`claimant==null ⇒ @host`、`service.allowOverride` 配置（插件注册 `config` 即可自报 true）、`runServiceTracking('@host')` 自封飞地，以及公开的 `issueLifecycleReaper()` 按 owner 名清场（`instance == null` 时身份匹配被整行跳过，实测一句 `reaper('victim', null)` 就删掉别人的服务）。增量全是判据与不变式，无重排 |
| v0.16.0-rc.15 | 4486 → **4490** | 同版第八次上调（同轮补漏）：按裁决 §2.6「逐个列出入口」核出第 4 条独立后门 —— `issueLifecycleReaper()` 是公开方法，而 `_releaseServicesByOwner` 的身份匹配写成 `if (instance && …)`，`instance` 为 null 时整行被跳过，实测 `reaper('victim', null)` 一句就删掉别人的服务。修法把**登记实例**变成必要条件；`_reapRegistrations` 同病同修。`core.js` +4，其余 7 文件 0 改动 |
| v0.16.0-rc.15 | 4490 → **4539** | 同版第九次上调（F06 建模撞出的实现反例）：`_stopLocked` 的停机 for 循环原先**逐条独立**调 `_stopOnePlugin`，而后者在 `hold_timeout` 之后只把这一次调用记成失败（`stop_return` / `unknown`），`plugin.state` 仍是 `running` —— 循环不回头检查依赖方是否**真的**停了，于是继续去停提供方。实测：`dependent` 超时后仍 `running`，`base` 的 `stop()` 照常被调并变 `stopped`，而 `core.stopped` 载荷里 `stopOrder` + `basis:'dependency'` 读起来像「按正确顺序停好了」。修法：每轮重新判一次，新增 `_pendingDependentsOf(name)`（环内边豁免，否则停机永远停不完），仍有未停好的依赖方就跳过并记 `stopSkipped` / `skipped_dependents_pending`；新载荷字段 `stopSkipped` 与 `stopFailures` **分开**（“根本没动” vs “试着停但没停成”）。`core.js` +49（含 import 与 5 处解释注释），其余 7 文件 0 改动 |
| v0.16.0-rc.16 | 4539 → **4597** | 同版第十次上调（专家 rc.15 独立复审 R15-01/02/03）：三条反例都是同一类错误 —— **把一句看起来等价的字符串/集合比较当成了授权或保护判据**。① `dependency-resolver.js` +41：新增 `componentsOf()`（Tarjan 迭代版）算**硬依赖图**的强连通分量，`computeStopOrder` 多返 `components`；`core.js` 的 `_pendingDependentsOf` 把“出现在任意一个环里”换成“同一个 SCC”才豁免。② `core.js` `_commitService`：同 owner 更新的判据从 `claimant === prevOwner`（可自报）换成**登记实例对象身份**（`ctx0.instance === _serviceRegistrar.get(name)`）或本实例宿主控制体。③ `core.js` 删除公开的 `issueLifecycleReaper()`：清场通道改为 `#` 私有字段 + 构造期一次注入（`new LifecycleManager(this, this.#reap)`），`_reapRegistrations` / `_releaseServicesByOwner` 同时转 `#`；`lifecycle-manager.js` +2 接第二参数并兼容重建。其余 4 文件 0 改动 |
| v0.16.0-rc.17 | 4597 → **4624** | 同版第十一次上调（专家 rc.16 独立复审 R16-01）：服务侧清理还在按**服务名**，而提交早已按**单次登记**（对象 + 归属 + 登记实例 + 登记 ID + 接管回执）。后果：旧装配 init 失败时的清理会把后人那笔合法宿主接管一起抹掉，并留下“对象没了、登记 ID 还在”的幽灵账。`core.js` +27：① `_runAssemblyContext` 的 `serviceNames` 由 `Set<name>` 改为 `Map<name, {name, registrationId, instance}>` 收据（+1 行）；② `discardAssemblyArtifacts` 的服务段改成逐张收据调比较删除（+3/-5）；③ 新增 `_discardServiceReceipt()` 作为**唯一**删除点（比 ID + 比登记实例 + 原子清五账，比不中返 `stale_registration`），`_releaseHostService` 与 `#releaseServicesByOwner` 两处手写删除改为调用它（-8/-3）；④ `_commitService` 提交成功后写收据（+5）并把冲突通知改成提交**之后**的 `emitFact`（+8/-3）。其余 7 文件 0 改动；无重排、无新抽象 |
| v0.16.0-rc.18 | 4624 → **4803** | 专家 rc.17 一次性深审的 13 条反例（R17-01/02 + DA-03～13）：**执行路径的授权一致性**。授权判据原本只长在 `callCapability` 里，于是换一条更快的执行路径（sandbox / 结果缓存 / legacy）就等于换一套判据 —— 沙箱直接 succeeded 而不问身份、缓存命中连 Core 都不进。修法是判据只留一份：新增 `admitCapability()` 供各处**问**（不**抄**），沙箱与缓存的判据都排在**最后一个 await 之后**（DA-06），缓存键补真实主体与能力登记号、求不出主体即不缓存（DA-09/13），围栏 token 改 CSPRNG 且按 owner 撤销须持 disposer（DA-04）。记账来源侧：宿主控制面的登记不再写进当前插件装配账（DA-03），嵌套 tracking 只沿用外层归属、不继承受信（DA-11，与 R0-032/5 的边界交界），动态 `unload()` 复用 `Core.stop()` 的有界停止并区分「抛出」与「超时」（DA-10）。证据侧：接管回执随续期同步登记号（R17-01），权属/诊断/指标查询改快照（R17-02/DA-08/DA-12），denial 改走 `emitFact`（DA-07）。`core.js` +108（代码 76 / 注释 32）、`lifecycle-manager.js` +87（代码 52 / 注释 35）、`tool-executor.js` +152（插件，不计入核心预算）；其余 6 个核心文件 0 改动 |
| v0.16.0-rc.19 | 4803 → **4842** | 同版第十三次上调（专家 rc.18 独立复审的四条新反例 R18-A/B/C/D）：主题是**只读视图不得成为第二写入入口**。`core.js` +39：① 新增 `_lockDecl()` 做登记期权威快照（深复制 + 深冻结，不可克隆则退化浅冻结并留日志）与 `_copyDecl()` 做读取期独立副本；② `permissions` 与 `output_schema` 改为经 `_lockDecl` 存储（后者此前只改了读取端，登记方仍持有原对象，等于半修）；③ `capabilityPermissions()` / `getCapabilityOutputSchema()` 改交副本；④ `releaseCapability(id, credential)` 增加目标与凭据同指一笔的校验，不匹配返回 false 且一笔未动。`tool-executor.js` +55（插件，不计核心预算）：围栏同名替换新增 `mayReplaceFence()` 资格判据（持 disposer 或同名受信装配），不合格替换抛 `fence_replace_denied` 且原围栏保持有效；`getAuditLog()` 改交逐条快照。其余 7 个核心文件 0 改动，无重排 |
| v0.16.0-rc.20 | 4842 → **4908** | 同版第十四次上调（专家 rc.19 独立复审的四条工单 R19-A/B/C/D）：主题是**声明快照要在每一个分支上成立，凭据不能由公开解析函数发出，制品基线必须实算实物**。`core.js` +67：① `input_schema` 此前是裸 `inherit()` 原引用（`permissions`/`output_schema` 已锁、唯独真正做准入的那个没锁，半修的形状），现经 `_lockDecl()` 存登记期权威快照 —— 修前同一登记号下改一次登记方的 schema 就能放松准入并让原本合法的入参变非法；② `_lockDecl()` 取消「不可克隆则浅冻结」降级分支，新增 `_declImpurity()` 对函数/环/过深/超量载荷在登记期**具名拒绝**（`declaration_not_pure_data`），`_copyDecl()` 同步去掉浅复制退化 —— 旧降级只换最外层，`properties` 仍共享，公开 getter 因此能改写权威输出声明；③ 三个声明统一传 `which`，错误文本能指名是哪一个。`tool-executor.js`（插件，不计核心预算）：`resolveFence()` 不再交出 token（撤销凭据）也不再交出安装者的活围栏对象，改为只转发 `preCheck`/`postCheck` 的只读视图；内部分配改用不导出的 `_resolveFenceRecord()`；`fenceStatus()` 同步不再依赖 token；`removeFence({token})` 补上 core 归属校验。`verification/baseline-check.mjs`（证据，不计预算）状态词与生成器统一、制品分支改为实算长度/哈希并重做「与源码逐文件一致」。其余 7 个核心文件 0 改动，无重排 |
| v0.16.0-rc.21 | 4908 → **4913** | 同版第十五次上调（rc.21 发布前自查的十个实测缺陷，见 `docs/quality/rc21-expert-r20-response.md`）：主题是**判据覆盖到位、但某些分支上不生效**。`json5-loader.js` +5：转义搬运此前不论引号类型一律原样透传，而 JSON 不认 `\'` ⇒ JSON5 合法写法 `{ a: 'it\'s' }` 报 `Bad escaped character`，场景文件与 `tool-validate` 都受影响。现在只把单引号串里的 `\'` 译成字面 `'`，其余转义仍交给 `JSON.parse` 判（不猜）。其余 7 个核心文件 0 改动、无重排。同轮的非核心修复（`tool-rm` 回收站命名碰撞与上限、`secrets.get` 解密失败不再交出密文、配置路径原型污染、`tool-mv` 静默覆盖、软闸表有界、兜底层补 cwd、预算判据看任务是否留下、verdict 缓存键补 roots）均在 `plugins/`/`scripts/` 下，不计核心预算 |

| v0.16.0-rc.24 | 4913 → **4978** | 同版第十六次上调（专家 rc.23 双审查包的 K24-01～05 语义缺陷）：**这次上调是记账，不是瘦身**。`core.js` +10：`_snapshotFact` 的“纯数据”判据把全局 `seen` 换成**当前祖先路径** `path` + 已认证缓存 `certified` —— 修前 `{a: shared, b: shared}` 被误判为环并退化成浅冻结，实测观察者能改到事实源（K24-03）。`plugin-manager.js` +38：删掉懒加载路径重复发布的 `core:plugin.loaded`（一次装载两条同名且字段不兼容的事实，K24-01）；`_resetLazyState()` 让 `_recycle` 与 `unload` 共用归位逻辑，并把“回收”与“卸载”拆成两个事实 —— 修前普通卸载一条 `unloaded` 都不发（K24-02）、回收又先抹“仍被装载”再判 released（K24-05）；`_provideTargets()`/`_unindexProvides()` 让 provides 反查索引建账与撤账共用同一份规范化（修前拿对象当 key 删字符串索引、且从不删通配符，K24-04）。`lifecycle-manager.js` +17：`core:plugin.unloaded` 移到 `advance(plugin,'unloaded')` + `core.plugins.delete()` 之后的单一发布点（三条终局分支共用；`stop_timeout` 早退因而永不产生已卸载事实），`plugin_not_found` 补 `released:true` 使懒账本可对账。其余 5 个核心文件 0 改动、无重排。**未做**专家 §6-B（纯注释瘦身 345～495 行）与 §6-C（代码去重）：专家要求它们与语义修复分开提交，故本轮以显式上调承认这 65 行，瘦身独立 PR 完成后再下调 |
| v0.16.0-rc.25 | 4978 → **4775** | 专家 K24 §6-B 的执行：**纯注释瘦身，零代码语义改动**。按专家 §3 表逐条压缩事故时间线（错误码/结果分类、`emitFact`、事实快照、停机顺序与 SCC 豁免、服务权属与接管、身份权威、管道所有权、同名判定与 ESM 诊断、懒加载 Attempt 与重载次序、场景三类名字集合与持久化判据、SemVer 与依赖边唯一解释），只保留**不变式 / 反直觉失败边界 / 权属来源**三类。硬判据是 `comment-audit.mjs --baseline` 的**代码投影逐文件一致（8/8）**：语句边界、代码内容与顺序全未变，改的只有注释。核心 -203 行（4978 → 4775）、-14499 字节；整行注释 1472 → 1270。**未达专家建议的 -345～-495**：剩余注释多数是 2～4 行的不变式声明，继续压会开始删反例来源与授权边界，故按实际交付。同轮未做 §6-C（代码去重） |
| v0.16.0-rc.26 | 4775 → **4753** | 专家 K24 §6-C「代码去重」的执行：**只动"同一个决定被写两遍"的三处，不改任何判据**。`plugin-manager.js` -22：`_importAndRegister()` 成为 eager 与 legacy 两条装载链的**唯一**导入/登记实现 —— 修前 legacy 链自己写了一遍，唯独漏了 `_pluginFilePaths.set`，于是 `cli.js:139` 的无场景启动路径上 `plugin.reload` 永远 `no_source_path`；`_applyTopology()` 让两处「排序 → 重排 `core.plugins`」合成一份（顺序不携带语义，两份实现会让"谁先启动"取决于复制粘贴是否同步）；并删掉 rc.24 意外留下的**同文件重复定义** `_resetLazyState`（后者静默覆盖前者，行为无差、但两份必然分叉）。`core.js` -4：接管回执收敛到单一构造点 `takeoverReceipt()`（首次接管与宿主续期原本各写一份 5 行字面量，加字段只会加进其中一支）。**代码净 -22 行不是目标，判据是`test/unit/test-rc26-dedup-equivalence.test.mjs` 的 13 条先红后绿**（重名方法静态守、legacy 来源路径、两链等价、拓扑应用、去重记账、重名跳过、回执单一构造点、advisor 契约）；同时给 `recycle-advisor` 补上**第一条可执行契约**与参考实现 `plugins/recycle-advisor.js`（此前只活在一段注释里）|
| v0.16.0-rc.27 | 4753 → **4753** | 专家 rc.26 独立复审 H26-01/02/03 的执行：**核心一行未动**，改的是两个执行期接点自身的存续保障。`plugins/cell-runtime.js`：`_gateEligibility()` 把"执行器在不在、两个接点是否可调用、装完能否核账"提成一份判据，`create()` 在**副作用之前**判定并在 `set()` 之前装门（失败按 `sessionId` 退掉工作区绑定，不留半个 Cell）；执行器迟到时由 `core:plugin.loaded` 与 `accept/execute` 的 `_ensureGate()` 双保险在**第一次派发之前**补装；`describe().capability_gate` 报 installed/owner/pre/dispatch/generation 的真实值。`plugins/tool-executor.js`：`init()` 不再开头清空 `_dispatchHooks`（同 Core 幂等早退、换 Core 改动前具名拒绝、中途失败按快照回滚），新增 `hookCountFor(owner)` 作核账口，派发期 thenable 判定后接一个**不改变决策**的 rejection 消费分支。判据是 `test/unit/test-rc27-hook-lifetime.test.mjs` 的 10 条**先红后绿**（rc.26 代码上 7 红 + 1 条进程级未处理拒绝） |

> **更正（v0.16.0-rc.4）**：`v0.15.5` 这一行的终点曾被 `sync-line-docs.mjs` 写成 3950 ——
> 原因是它的版本正则不认 `-rc` 后缀，把 `v0.15.5` 误判成"最后一行"并改写了它。数量未变、证据错位，
> 是最难被发现的那种漂移。正则已修，并补上 `v0.16.0-rc.4` 行。
>
> **本表遗留矛盾（不猜、不掩）**：`v0.15.5` 行记终点 4059，而下一行 `v0.16.0-rc` 记起点 4026。
> 两者不可能同时成立。本轮只保证**新行可核对**（4059 → 3950 有 token 证据），
> 没有回去改旧行——改历史比留疑问更糟。
>
> **更正（v0.15.1）**：v0.15.0 这一行本 ADR 原记 **2991**，与 `scripts/core-limits.mjs` 的
> 3009 不一致；`core-limits.mjs` 的同一段又写着"增量 111 行"（2880 → 3009 实为 **129**）。
> 专家 0.15.0 复审 §2「行数事实」两处都点到了。现在三处（本表、core-limits、README）
> 由 `test/unit/test-r016-doc-line-consistency.test.mjs` **机器校验**，不再靠人记得同步。

**关键事实：这 643 行的增长里，没有一行是"新增抽象"。** 逐条看都是同一个形状——
**把一条已经在文档里写下、但在代码里不存在的判据补上**：

- 2222 → 2610：专家点名的 20 条反例，此前 `callCapability` 与 `command` 是两条执行路径
- 2610 → 2746：§6.2 的"必须串行化"在代码里**一行都没有**；§5.3 的"唯一 token"也没有
- 2746 → 2880：v0.14.0 新增的锁与场景提交判据，在极端条件下各有反例

换句话说：**增长对应的是"判据从纸面进入代码"，不是"概念从少变多"。**
这也是为什么专家 §1 说"已从概念抽象进入真实机制"。

## 3. v0.14.1 的 119 行增量构成（可复核）

```
git diff -U0 src/core/ | grep '^+' | grep -v '^+++' | sed 's/^+//' | grep -vE '^\s*(//|\*|/\*|$)'
```
- 非注释、非空行的**真实代码：61 行**
- 注释与空行：58 行（`wc -l` 口径的差额来自文件数等）

61 行代码分五处，每处都对应一条已复现的反例：

| 反例 | 代码行 | 性质 |
|---|---|---|
| R-014-1 过期 ALS 租约 | ~14 | 判据从 `Set.has(key)` 改成 `{active, manager, key}` 三条件 |
| R-014-2 队列 Map 回收 | ~5 | 存 `tail` 比 `tail`（修前存包装 Promise 却比 `next`） |
| R-014-3 场景身份提交 | ~3 | 把"插件集合变了"与"场景名变了"拆成两个事实 |
| R-014-4 必需 include 缺失 | ~9 | Preflight 增加 partial/missingIncludes 分支 |
| R-014-5 Verify 全目标集合 | ~12 | 新增 `sceneRequiredNames()`（排除 lazy）+ 改为核对完整集合 |
| 推迟装配分流 | ~12 | CLI 不启动内核，必须显式声明而非放松判据 |

**没有一处是"新通用框架"**——专家 §6 明令禁止的四类（通用锁框架、统一 ContractManager、
全局 StateMachine DSL、万能 ErrorManager）一个都没做。

## 4. 决定

### 4.1 上限是**棘轮**，不是设计目标

- `CORE_MAX_LINES` 的值**永远等于最近一次实测值**，不留"等着被填满"的余量。
- 增长必须**同时**做三件事才生效：改 `scripts/core-limits.mjs`、写清增量构成、在本 ADR §5
  追加一行。缺任何一件，`npm run check` 与 `test/unit/test-r0-115/W7` 会红。
- **2222 从"当前事实"降级为"历史设计目标"**：任何文档不得再把它当现状引用。
  `package.json` 的 `description`、`README` 行数表、`docs/architecture/microkernel.md`
  一律以 `CORE_MAX_LINES` 为准。

### 4.2 什么改动**可以**获批增长（准入条件，四条全中）

1. **对应一条已复现的缺陷**——探针或单测能红着复现，不接受"这样更优雅"。
2. **不是新增抽象层**——属于专家 §6 禁止清单的一律否决，无论多少行。
3. **注释占比可解释**——本 ADR 采用的口径是"不削注释凑数"（2026-10-14 维护者令），
   但注释必须解释**判据与理由**，不是复述代码。判断标准：删掉它，下一个人会不会改错？
4. **写明增量构成**——代码行数 vs 注释行数分开报，可复核的命令一起给出。

### 4.3 什么改动**不予**批准

- 为回到 2222（或任何历史数）而删除仍生效的检查。
- "顺手"重构、注释美化、目录整理——这类工作应该在功能全绿后**单独一轮**做，
  不与语义修复混在一起（这也是维护者的既有指示："先达到目标，最后再想压缩"）。
- 预估行数本身就不可信：本项目的实际偏差记录是 **+55 对 −10（v0.12.0 P1）、
  +118 对 +27（P2）**。系统性偏低约 2–4 倍，因为预估只算"新增代码"，
  漏算"新增的可观测面与证据保留"。**后续预估一律按 3 倍另作保守估计**。

## 5. 上限变更记录（本 ADR 是唯一权威表）

| 日期 | 版本 | 上限 | 实测 | 增量性质 |
|---|---|---|---|---|
| 2026-10-22 | v0.10.1 | 2222 | 2222 | Node 18 ESM 真阳性（历史设计目标止于此） |
| 2026-10-23 | v0.12.0 | 2610 | 2610 | P1–P4：执行面/生命周期/场景/小合同 |
| 2026-10-23 | v0.14.0 | 2746 | 2746 | §6.2 串行化、§5.3 token、`advance()` |
| 2026-10-23 | v0.14.1 | **2880** | 2880 | R-014-1..5 五条复审反例 + 推迟装配分流（原记 2865，本轮更正） |
| 2026-10-23 | v0.15.0 | **3009** | 3009 | INV-01 + SC-01～05 六条复审反例（见 ADR-13） |
| 2026-10-23 | v0.15.1 | **3193** | 3193 | ERR-015（撤销拒绝码白名单）+ SC-015（lazy 按需）+ ADR-11 接线 |
| 2026-10-23 | v0.15.2 | **3267** | 3267 | LAZY-01～04（真实装载 Attempt 与等候方分离）+ 后台定时器 unref |
| 2026-10-23 | v0.15.3 | **3531** | 3531 | X01～X03（世代闸门 / 注册被拒即中止 / 场景 lazy 有效集合）+ 原地重启具名拒绝 |
| 2026-10-23 | v0.15.4 | **3870** | 3870 | K3 合法转移表与 `invalid_state_transition` + K4/X04 服务权属原子化与权威 release + H-01 订阅账 / H-03 `emitFact` / H-02 管道遣散 |
| 2026-10-24 | v0.15.5 | **4059** | 4059 | R25-01 已提交事实清单（`core:plugin.loaded` 等 4 处）+ R25-02 异步观察者隔离 + R25-03 事实深快照 + R25-04/05 注册 entry 与注册 token |
| 2026-10-24 | v0.16.0-rc | **4059** | 4059 | R3-00 `requires` 按服务名解析到提供者插件（仅 `dependency-resolver.js` 234 → 267；其余 7 个文件 0 改动） |
| 2026-10-24 | v0.16.0-rc.4 | **3950** | 3950 | 发布前注释精炼（纯注释）：token 与 rc.3 逐文件相同，整行注释 1188 → 1079 |
| 2026-10-24 | v0.16.0-rc.5 | **3968** | 3968 | R5-01 单一权威实例 + 依赖边单一解释（`dependency-resolver.js` 249 → 326，`core.js` 1686 → 1680）；同轮注释净 −37 |
| 2026-10-24 | v0.16.0-rc.6 | **4143** | 4143 | R19 依赖消费者全部统一（`dependency-resolver.js` 326 → 384，`lifecycle-manager.js` 412 → 418）；卸载闸门与懒加载闭包不再各写一套 |

| 2026-10-24 | v0.16.0-rc.7 | **4180** | 4180 | 停机并发与锁序（`core.js` +14、`lifecycle-manager.js` +26）、场景 Apply/reload 绑世代（`plugin-manager.js` +19）、`computeStopOrder` 补归属参数（`dependency-resolver.js` +4）、**`_switchToLocked` 五段分层**（`scene-controller.js` 453 → 486，Plan/Commit 独立成方法）；增量为行为、不变式与事务边界，非重排 |
| 2026-10-25 | v0.16.0-rc.15 | **4194** | 4194 | 安全修复的最小集：`SCOPE_RANK` 换 null 原型 + `Object.hasOwn`（仅 `core.js`，4 处同义替换）、覆盖判据改读受信 `provider` 并引入 `store.trusted`（仅 `core.js`）；其余 7 个文件 0 改动。增量全是行为与不变式，无格式重排 |
| 2026-10-25 | v0.16.0-rc.15 | **4273** | 4273 | H7：等锁超时只退出自己的等待资格（`abandon(restore)` 把队尾退回 `prev`，不再删链）；H8：持有段独立有界（`holdMs` / `_holdBounded()` / `lock_abandoned`）并给停机失败加三阶段回执（`lock_wait` / `stop_call` / `stop_return`）。`lifecycle-manager.js` +64、`core.js` +15 |
| 2026-10-25 | v0.16.0-rc.15 | **4275** | 4275 | M6：`_failureFromThrown` 的证据字段从“仅降级时”放宽到“凡 handler 抛出必写”—— `handler_threw`（最常见的形状）原先 `dispatched` / `side_effect` 两个字段都缺，而“缺字段”与 `false` 在 JSON 里不可区分，说的是相反的事。预派发失败同时补 `dispatched:false` / `side_effect:'none'`。`core.js` +2 |
| 2026-10-25 | v0.16.0-rc.15 | **4306** | 4306 | S7：`HOST_OWNER` 的可判定性此前只是注释里的**未验证前提**（全仓无插件名正则）。`plugin-meta.js` +13（`PLUGIN_NAME_RE` + `isValidPluginName` 与非字符串保护）、`core.js` +7（`register()` 具名拒绝 + import）、`plugin-manager.js` +11（`loadOne` 先判名字再碰磁盘、`indexLazy` 同一判据、import）。副作用：名字格式同时成为**导入边界**（`../x` 不再能把插件目录外的文件装进来），且大写插件名自此被拒（仓内 78 个插件全为小写，两处测试夹具随之改名） |
| 2026-10-25 | v0.16.0-rc.15 | **4371** | 4371 | S6 释放半边（专家矩阵 ID-01～ID-16）：`registrationId` + WeakMap 凭据、`compare-and-delete` 撤销、覆盖须 `overrideBy`、按名批量入口删除、装配账按凭据防 ABA；`core.js` +58、`lifecycle-manager.js` +7。行为变更：字符串凭据一律拒绝，且多个公开方法从 Core 删除 |
| 2026-10-26 | v0.16.0-rc.15 | **4486** | 4486 | F05 宿主接管（专家裁决 A'）：跨 owner 接管的授权判据从「`claimant == null` 或可自造的配置」改为「持有本实例的宿主控制体」。`core.js` +98：`HOST_CONTROLS` 模块私有 WeakMap 与构造期绑定、`_commitService` 单一提交点、`_serviceRegIds`/`_svcSeq` 单次登记身份与 `compare-and-delete` 释放、`createRuntime()` 分开交付 `core`/`host`、接管回执记 `actorClass` 与前后登记 ID。四条实测后门同时封：无 claimant 即宿主、`service.allowOverride`（插件注册 `config` 即可自报）、`runServiceTracking('@host')` 自封、以及 `issueLifecycleReaper()` 在 `instance == null` 时按 owner 名清场（登记实例改为必要条件）。其余 7 个文件 0 改动 |
| 2026-10-26 | v0.16.0-rc.15 | **4490** | 4490 | 同轮补漏（第 4 条独立后门）：`issueLifecycleReaper()` 公开可调 + `_releaseServicesByOwner` 的 `if (instance && …)` 在 `instance == null` 时跳过身份匹配 ⇒ 按 owner 名即可删别人的服务。登记实例改为必要条件，能力侧同修。`core.js` +4 |
| 2026-10-26 | v0.16.0-rc.15 | **4539** | 4539 | F06 停机次序（建模撞出的实现反例，m15 形状）：顺序 ≠ 停在。`_stopLocked` 逐条独立停，`hold_timeout` 之后 `plugin.state` 仍是 `running`，循环却继续去停提供方 —— 依赖方脚下的地被拆了，而载荷读起来像有序。新增 `_pendingDependentsOf()` 每轮重判（环内边豁免），未停好就跳过并记 `stopSkipped`。`core.js` +49 |
| 2026-10-26 | v0.16.0-rc.16 | **4597** | 4597 | R15-01/02/03（专家 rc.15 独立复审的三条实现层反例）：① 环豁免从“出现在任意环里”改为“同一个 SCC”（`dependency-resolver.js` +41 算 SCC，`core.js` 改判据）—— 实测 `c→a` 跨两个环时 `a` 照样被停；② 同 owner 更新不再认自报字符串，只认登记实例对象身份或宿主控制体（`runServiceTracking` 只能是观测）；③ 删公开 `issueLifecycleReaper()`，清场闭包改为 `#` 私有 + 构造期注入。`core.js` +15、`dependency-resolver.js` +41、`lifecycle-manager.js` +2 |
| 2026-10-26 | v0.16.0-rc.17 | **4624** | 4624 |
| 2026-10-27 | v0.16.0-rc.18 | **4803** | 4803 | 专家 rc.17 一次性深审的 13 条反例（R17-01/02 + DA-03～13），按**四个横切面**归并修复而不是逐版本挤牙膏：**B 执行后端共享同一授权判据**——新增 `admitCapability()` 作为唯一准入入口（Core 内 1 处，沙箱与缓存都问它，不再各自手抄判据），沙箱派发的判据挪到**最后一个 await 之后**（DA-06 的 TOCTOU），缓存键补真实主体与能力登记号、求不出主体即不缓存（DA-09/13），围栏 token 改 CSPRNG 且按 owner 撤销须持 disposer 对象（DA-04）；**C 记账来源与生命周期有界性**——宿主控制面的登记不再写进当前插件装配账（DA-03），嵌套 tracking 只沿用外层归属、不继承受信（DA-11 + R0-032/5 的交界），动态 `unload()` 复用 `Core.stop()` 的有界停止并区分「抛出」与「超时」（DA-10）；**D 证据当代性与只读快照**——接管回执随宿主续期同步登记号（R17-01），权属/诊断/指标查询改返回快照（R17-02/DA-08/DA-12），denial 走 `emitFact`（DA-07）。`core.js` +108（代码 76 / 注释 32）、`lifecycle-manager.js` +87（代码 52 / 注释 35），其余 6 文件 0 改动 | R16-01（专家 rc.16 独立复审的新 P1）：装配失败清理按服务名删，误删后继的合法宿主登记，并留下“对象没了、登记 ID 还在”的幽灵账（按旧 ID 释放还报成功）。修法把服务侧接回登记身份合同：装配账改记收据（名字 + 登记 ID + 登记实例），删除收敛到**唯一**比较删除点 `_discardServiceReceipt()`（比中才原子清五账，比不中返 `stale_registration`），冲突通知改走提交后的 `emitFact`。`core.js` +27，其余 7 文件 0 改动 |
| 2026-10-27 | v0.16.0-rc.19 | **4842** | 4842 | 专家 rc.18 复审的四条新反例（R18-A/B/C/D），一个批次、四张工单：**同一条准入规则只能有一个权威来源，同一份只读视图不应变成另一种写入入口**。AUTH-01 围栏同名替换须持原 disposer 或发生在同名受信装配中，裸 owner 字符串不再构成替换资格，且非法替换后原围栏保持有效（`mayReplaceFence()`，`tool-executor.js`）；AUTH-02 权限与 output_schema 在**登记期**做深复制 + 深冻结的权威快照，**读取期**再交独立副本，公开 getter 不再能改写派发判据（`_lockDecl()` / `_copyDecl()`，`core.js`）；REG-03 `releaseCapability(id, credential)` 的 id 必须与凭据指向同一笔登记，错配返回 false 且不删任何对象（`core.js`）；EVID-04 `getAuditLog()` 改交逐条快照，查询不再能改写已存在的证据（`tool-executor.js`）。`core.js` +39、`tool-executor.js` +55（插件，不计预算），其余 7 个核心文件 0 改动 |
| 2026-10-28 | v0.16.0-rc.20 | **4908** | 4908 | 专家 rc.19 独立复审的 R19-A/B/C/D，仍然一个批次：**同一条准入判据只能有同一个快照口径，撤销凭据不能从公开解析函数发出，基线必须实算实物**。R19-A `input_schema` 由裸引用改为登记期深冻结快照（`_lockDecl()`）——此前 `permissions`/`output_schema` 已锁而真正做准入的 `input_schema` 没锁，登记后改一句 schema 即可放松准入、并让原本合法的入参变成 invalid_input；R19-B `resolveFence()` 停止交出 token 与活围栏对象，改交只含 `preCheck`/`postCheck` 的只读视图（只删 token 不够：实测 `resolveFence(c).fence.stop()` 会跑到安装者的 `stop()` 上），`removeFence({token})` 补 core 归属校验；R19-C 取消声明快照的浅冻结降级分支，非纯数据在登记期具名拒绝（`declaration_not_pure_data`），`_copyDecl()` 去掉浅复制退化 —— 旧降级只换最外层，`properties` 仍共享同一引用；R19-D `baseline-check` 制品分支原先只认 `MEASURED` 而生成器写 `BUILT`，整段核对从未执行（旧基线 2,282,936/ab00143c… 与实物 2,289,589/e979bff3… 不符仍打印「一致」并退出 0），现改为实算长度与哈希、重做成员绑定，状态词只用于拒绝不用于放行。`core.js` +67、`tool-executor.js` 与 `baseline-check.mjs` 不计核心预算，其余 7 个核心文件 0 改动 |
| 2026-10-28 | v0.16.0-rc.24 | **4978** | 4978 | 专家 rc.23 双审查包：K24-01～05 五项语义缺陷（同一装载事实两个发布者且字段不兼容、普通卸载漏发 `unloaded`、共享引用被误判为环导致观察者污染事实源、provides 索引建撤口径分裂、回收费失败时先抹“仍被装载”）+ R23-A/B/C 三项数据安全（`setAndSave` 跨层事务、prune 先记账后删、跨设备复制改私有暂存名）。核心净 +65 行（`core.js` +10、`plugin-manager.js` +38、`lifecycle-manager.js` +17），其余 5 个核心文件 0 改动；纯注释瘦身另案 |
| 2026-10-28 | v0.16.0-rc.25 | **4775** | 4775 | 专家 K24 §6-B 纯注释瘦身：只删事故时间线，保留不变式/失败边界/权属来源；代码投影 8/8 与瘦身前一致（未改一行代码语义），核心 -203 行 / -14499 B |
| 2026-10-28 | v0.16.0-rc.26 | **4753** | 4753 | 专家 K24 §6-C 代码去重：两条装载链合成 `_importAndRegister`（顺带修好 legacy 路径缺失的 `_pluginFilePaths` 登记）、拓扑应用合成 `_applyTopology`、接管回执合成 `takeoverReceipt`、删掉 rc.24 的同文件重复定义 `_resetLazyState`；核心 -22 行，9 条等价测试 |
| v0.16.0-rc.31 | 4785 → **4785** | 专家 rc.30 复审 K30-01 / K30-02 的收口：**核心一行未动**。改 `plugins/_lib/call-context.mjs`（新增**第二条** ALS `_taskAls` + `runInTaskContext`/`currentTask` —— 不与已有那条混用，那条是**一次工具调用**的 store）、`plugins/cell-runtime.js`（`execute()` 在 epoch 分配后签发任务票据；新增 `dispatchEligibility` 五道任务维度判据、`gateIdentity` 只读门身份摘要、`runInActiveTask` 供宿主发起的认知调用）、`plugins/tool-executor.js`（`_cellSessionRefusal` 改为 生命周期 → **门身份** → 任务维度；新增 `_gateIdentityFailure` 四层核验（实例对象身份 / 回执 / 租约 key 与 token 集合 / 租约存活）、`cellDispatchVerdict` 公开入口；任务维度四个 code 登记进 `EXECUTOR_REJECTION_CODES`）、`plugins/haotian-lite.js`（不再自查租约）与 `plugins/gateway.js`（主动求教走 `runInActiveTask`）。判据是 `test/unit/test-rc31-task-epoch-and-gate-identity.test.mjs` 的 15 条**先红后绿**（rc.30 代码上 10 红 5 绿，绿的 5 条是非回归基线） |
| v0.16.0-rc.30 | 4753 → **4753** | 专家 rc.29 复审 K29-01（Cell 会话身份）的收口：**核心一行未动**，改 `plugins/cell-runtime.js`（新增 `sessionEligibility(sessionId)` —— 只读登记表、不按前缀猜；`cellForSession` 增报 `execution_revoked`）、`plugins/tool-executor.js`（新增 `_cellSessionRefusal(sessionId)` 合成判决：先问生命周期、再问门存续；插在 `_dispatchGuard` 第④步与 legacy 直连入口，四条派发路径共用；`isProtectedSession` 改认登记表）与 `plugins/haotian-lite.js`（不再自写状态机，问同一权威）。判据是 `test/unit/test-rc30-cell-session-identity.test.mjs` 的 12 条**先红后绿**（rc.29 代码上 9 红 3 绿，绿的 3 条是非回归基线） |
| v0.16.0-rc.29 | 4753 → **4753** | 专家 rc.28 复审三条反例的执行：**核心一行未动**，改 `plugins/tool-executor.js`（保护性注册租约 `leaseGuard(owner, sessionId, receipts)`：与钩子表分离、`removeHooksByOwner` 故意不清；派发期第三步同步验回执，失效即 `cell_gate_unavailable`；新增 `removeHook(receipt)` 按回执精确撤销与 `guardLeasesFor(sessionId)` 观测口）、`plugins/cell-runtime.js`（装门同时登记租约、`dropGate` 释放；`_staleGateReceipts()` 收拢核账；`_installGatesForExisting` 成为唯一合法重装入口并按回执清掉失效记录；`create()` 把 `loadBinding`+`_persist` 收进同一提交边界，失败走 `_rollbackCreate`；`describe().capability_gate` 增报 lease/lease_live/reinstalls）与 `plugins/haotian-lite.js`（`_execTools` 按 `cellForSession` 判 Cell 归属：无执行器的 legacy 分支与“有执行器但门无存续租约”一律拒，零副作用）。判据是 `test/unit/test-rc29-gate-continuity.test.mjs` 的 9 条**先红后绿**（rc.28 制品上 6 红 3 绿，绿的 3 条是非回归基线） |
| v0.16.0-rc.28 | 4753 → **4753** | 专家 rc.26 复审的后置项（Hook 资格 token 化）：**核心一行未动**，只改 `plugins/tool-executor.js` 与 `plugins/cell-runtime.js`。每次 `registerPreHook/registerPostHook/registerDispatchHook` 现在返回一张冻结回执 `{token, kind, owner, generation, instance}`，新增 `verifyHook(receipt)` 逐条核对 同实例 / 同代 / 记录在表 / 归属没变；代际在每次**真正**的 `init()` 时 +1（幂等早退不换代、失败回滚）。Cell 门把回执存进 `rec.gate.receipts`，`_ensureGate` 每次执行前拿回执核账，`describe().capability_gate` 同时报 `installed`（当初）与 `live`（此刻）。判据是 `test/unit/test-rc28-hook-receipts.test.mjs` 的 9 条**先红后绿**（rc.27 代码上 9 条全红），其中“计数撒谎的执行器”一条正好落在旧判据的盲区上 |
| v0.16.0-rc.32 | 4753 → **4785** | 专家 rc.31 源码级全面发布审查 H1-H6 的一次性收口（不再逐条补丁）。**这一轮确实动了核心**，只有一处理由：声明快照必须「审的和存的是同一个对象」。`core.js` +32：`_lockDecl()` 拆成一次遍历的 `_declSnapshot()` —— 用 `Object.getOwnPropertyDescriptor` 读**一次** `value`，同时完成「判纯度 + 复制 + 冻结」，具名拒绝访问器 / Proxy / symbol 键 / 稀疏数组 / 非有限数字；`_declImpurity()` 删除（两趟遍历正是 RC31-C1 的形状：实测 getter 前两次返回合规 schema、第三次返回带 `pattern` 的 schema，于是支持面校验看到纯数据、权威快照存下 `pattern` —— 一个没被校验的约束进了权威记录）；`registerCapability()` 改为先 `_lockDecl` 再 `_assertSchemaSupported`，三个声明各锁一次，`record` 字面量不再各自加锁（派生属性不许成为第二个冻结口）。其余 7 个核心文件 0 改动。插件侧（不计核心预算）：`plugins/cell-runtime.js` 的任务执行事务 （`rec.prepare` 占位令牌 + `pendingRev` + `_prepareStillValid` compare-and-commit，提交点前后两条**相反**的补偿分支，`execution_outcome` / `durability_outcome` 分离 + `record_id`，`stateDir` 属主锁）。判据是 `test/unit/test-rc32-task-transaction-and-decl-snapshot.test.mjs` 的 22 条先红后绿 |
| v0.16.0-rc.33 | 4785 → **4857** | 专家 rc.32 源码级发布审查 R32-01～05 的一次性收口。**核心 +72**，只为一件事：schema 支持面必须是「整棵树的白名单」。`_assertSchemaSupported` 从"只枚举 `schema.properties` 的第一层"改成逐层判：根只允许 `type`/`required`/`properties`/`additionalProperties` + 注释 `title`/`description`，属性子表只允许 `type` + 注释；`$ref`/`pattern`/`enum`/嵌套 `properties`/`items` 一律**注册期具名拒绝**（修前根上的 `$ref` 与 `properties.x.properties.admin.$ref` 都被接受并执行成功）。`additionalProperties` 仍按合同保持"允许出现但不参与校验"，并在注释与合同里写明这是 no-op 而不是已支持的约束；注释关键字单独校验必须是字符串（能当断言用的东西一律不收）。校验对象仍是登记期冻结快照，不回到"双遍历用户对象"。插件侧（不计核心预算）：属主身份改为**Core 实例**（进程内 `realpath(stateDir)` → Core 登记表 —— 同 PID 不再是放行理由；`owner.lock` 只管跨进程；同 Core 不同 cell 也拒）、结算窗口持有占位（`preparing → committed → settling` 内部阶段，`state` 在结算期保持 busy，`last_result` 与结果行同序）、`close()` 的"已关闭"改为**清理责任表**（persist/quiesce/workspace/gate/owner 逐项可重试；`closed_at` 读回判 `rename` 前后模糊失败；`already:true` 只在整张表满足时返回）、结果追加按 `record_id` 读回校核 + `resultRecords()` 归并（物理仍是 at-least-once，逻辑上不再把一次执行算成两次）。判据是 `test/unit/test-rc33-owner-settle-close-schema.test.mjs` 的 20 条先红后绿，另有随包探针 `test/probes/rc33-r32-independent-repro.mjs` 由发布门禁自动发现 |
| 2026-10-29 | v0.16.0-rc.31 | **4753** | 4753 | 专家 rc.30 复审 K30-01 / K30-02：把「身份」与「票据」分开（任务 epoch 由 cell-runtime 经 ALS 签发，调用方只能读）、把「存在」与「身份」分开（门身份 = 实例对象身份 + 回执 token 集合 + 租约 key，不是 `some(l=>l.live)`）；判据顺序 生命周期 → 门身份 → 任务维度；核心零改动，15 条回归先红后绿 |
| 2026-10-29 | v0.16.0-rc.30 | **4753** | 4753 | 专家 rc.29 复审 K29-01：Cell 会话身份不可遗忘（登记表为唯一权威；关闭/撤销/从未装门一律拒）；判决收敛为单一同步入口，四条派发路径共用；核心零改动，12 条回归先红后绿 |
| 2026-10-28 | v0.16.0-rc.29 | **4753** | 4753 | 专家 rc.28 复审：R28-A 派发期存续（存续租约 + 回执核账，不靠入口那一次）、R28-B legacy 退路（按会话判 Cell 归属，无门即拒）、R28-C create 提交边界（整体回退，磁盘不盲删）；并收回 rc.27 那条无作用域断言；核心零改动，8 条回归先红后绿 |
| 2026-10-28 | v0.16.0-rc.28 | **4753** | 4753 | 专家 rc.26 后置项：钩子注册改签回执（token/实例/代际/归属）+ `verifyHook` 核账；Cell 门不再数 owner，`describe` 分报 installed 与 live；核心零改动，9 条先红后绿回归 |

## 6. 诚实的边界

- **本 ADR 是补记，不是"当时就批准过"。** 2610 与 2746 两次增长发生在没有 ADR 的情况下，
  这是**程序性缺失**，本 ADR 承认它，而不是把追认写成"一直在掌控中"。
- **3168 仍然偏多。** 专家 §7 的评价是准确的："不是 2746 太大，而是新增机制的极端条件
  仍有反例"。本轮把反例修掉了，于是又长了 119 行。**这个方向会自我强化**：
  每修一条极端条件就长一点。真正的收敛不在行数，而在"边界正确的机制"——
  一旦机制不再有反例，就不再需要为每条反例加判据。
- **压缩仍是欠账。** `scripts/core-limits.mjs` 里积累了 10 条压缩候选
  （json5 三扫描合并、`cmpVersion` 内联、`_preflight` 与 `isResolvable` 去重、
  三处 return 抽公共字段、`_loadSingle` 转发可删）。**没有一条执行**，因为它们
  都要求"功能全绿后单独一轮做重构"。本 ADR 不为它们背书，只登记它们仍然欠着。
| v0.16.0-rc.34 | 4857 → **4889** | 专家 rc.33 源码级复审 K33-A/K33-B 的收口。**核心 +35**，只为一件事：「声明了的合同，每条执行路径都必须真的读」。`_schemaViolation` 从 `params[k]` 改成 `Object.getOwnPropertyDescriptor` 读**一次** own 属性 —— 修正前 `required:['__proto__']` 在 `params={}` 上被原型链读成「给了、而且正好是 object」，handler 照跑，`constructor`/`toString` 同理；访问器参数在这一步具名拒绝（准入结论不能由输入自己决定）。根 `type` 真的执行：修前只在 required/properties 存在时才要求 object，`{type:'object'}` 传 'str'、`{type:'string'}` 传对象都放行并执行。参数根加纯数据边界：类实例/Proxy 拒，`Object.create(null)` 放行。插件侧（不计核心预算）：`close()` 把「执行资格已撤销 / 正在清理 / 清理已完成」拆成三个事实 —— `closed` 与 `cleanup_done` 同源，未做完只发 `cell.closing`（带 `cleanup_pending`），`cell.closed` 只在 清理真完成时发一次。判据是 `test/unit/test-rc34-k33-schema-own-root-and-close-facts.test.mjs` 的 17 条先红后绿。 |
