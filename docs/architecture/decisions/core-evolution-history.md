# Core 演化史：从源码里搬出来的那些故事

> **本文件是"为什么代码长成这样"的唯一去处。** 源码注释只描述**今天必须成立的事实**；
> 一旦要写"哪一轮、谁发现、修前是什么样"，写到这里，不要写回 `src/core/*.js`。
>
> **证据没有丢，只是换了位置。** 被搬走的叙述全部还在 git 历史与制品里：
> `git show 65f68a9:src/core/core.js` 就是清理前的原始字节；rc.3 制品
> `tusunsun-0.16.0-rc.3.tgz` 的 SHA-256 = `fb651074ea104e67d42139c79825cf72b302cf16ddcd1651fd3e43c814e6273d`。
> 清理是一次**纯注释**改动：8 个文件的 token 序列 sha256 与 rc.3 完全一致
> （`node scripts/comment-audit.mjs --baseline <解包后的 rc.3>`，8/8 一致）。
>
> 记录格式固定为五列：**身份 / 旧失败机制 / 今日不变式 / 证据位置 / 基线**。
> 基线的含义：最后一次**行为**发生变化的那一版（清理本身不改行为，不算基线）。

---

## 0. 一眼看结论

| | rc.3（清理前） | 本版 |
|---|---:|---:|
| `src/core/` 官方行数 | 4059 | 3950 |
| 整行注释 | 1188 | 1079 |
| 带历史标记的整行注释 | 347 | **1**（已逐条批准，见 §9） |
| 可执行 token | — | **与 rc.3 逐文件相同** |

官方行数口径：每个文件 `content.split('\n').length` 之和（= 换行数 + 文件数）。

---

## 1. 权属：谁注册的、谁才能撤

| 身份 | 旧失败机制 | 今日不变式 | 证据位置 | 基线 |
|---|---|---|---|---|
| H-01 订阅身份 | owner 与事件名写在函数对象上。同一个回调被两个 owner 各订阅一次时没有地方存"两次"，`offByOwner('A')` 只能按函数删，把 B 那条一起删掉 | 订阅 = **一次注册**；注册身份 = **一个 wrapper**。撤销按 entry，不按函数 | `test/unit/test-r2-01-ownership-and-hooks.test.mjs`、`test/probes/r2-hook-ownership.mjs` | v0.15.4 |
| R25-04 entry 寻址 | 账本按函数寻址，撤销时 `super.removeListener(event, fn)` 删的是**最后一条同名函数**，不是账本指的那条 | 每次带 owner 的注册生成唯一 wrapper，账本记住它，撤销按它精确删 | `test/unit/test-r25-01-fact-and-entry-identity.test.mjs` | v0.15.5 |
| R25-05 管道 token | `use(stage, fn)` 只往数组塞裸函数；`unuse` 用 `lastIndexOf(fn)` 删数组里一条、从 owner 账本删另一条，两套结构各自猜"这个函数指哪次注册" | 管道数组与 owner 索引**存同一个 entry**；disposer 按 entry 撤 | 同上 | v0.15.5 |
| X04 / K4 服务权属 | 四种归属情况糊在一条 `prevOwner == null \|\| claimant == null \|\| prevOwner === claimant` 里：匿名覆写被当成合法，于是 `getService(name)` 返回 B 而 `_serviceOwners` 仍记 A | 四种情况分开定义；**要么两个 Map 一起改，要么都不改**；异主覆盖只留宿主显式授权的两条路 | `test/unit/test-r2-01-ownership-and-hooks.test.mjs` | v0.15.4 |
| K4 按 owner 释放 | 生命周期层自己 `_services.delete()`/`_serviceOwners.delete()`，还按 `svc.name === pluginName` 模糊匹配 —— 名字巧合就删掉别人的资源 | 容器只由 Core 的权威方法改；只撤归属确为该 owner 的条目，并回报删了什么 | `test/unit/test-r3-06-organ-selfaudit.test.mjs` | v0.15.4 |
| K-13b 让渡 | 判据三个条件用 `&&` 串起来，`owner===undefined` 时整条短路为假 ⇒ 一个匿名调用删掉了 owner=A 的能力 | 有主的能力**只能由主人自己**（或持 owner 的受信通道）让渡 | `test/unit/test-k01-k13b-execution-surface.test.mjs` | v0.12.0 |

---

## 2. 装配：成功装配 ≠ 有权提交

| 身份 | 旧失败机制 | 今日不变式 | 证据位置 | 基线 |
|---|---|---|---|---|
| X01 世代闸门 | 停止时只把 `running` 置 false。已经起跑的装配在 init 返回后照样 `advance('running')` 并注册能力 ⇒ stop 返回后再调该能力仍 succeeded，而 `plugin.stop` 一次都没被调 | 停止**当场**递增世代；注册、服务登记、派发三条入口都查世代；init/start 返回后**再查一次** | `test/probes/x01-x04-cross-state-machine.mjs`、`test/unit/test-r3-assembly-lazy-and-organ.test.mjs` | v0.15.3 |
| X02/d 名字核对 | `loadOne('dup')` 打开 `dup.js`，装进去的却是自报 `name='other'` 的对象 | 请求名 / 实际对象名 / manifest 名必须对得上，否则具名拒绝 | 同上 | v0.15.3 |
| X02 注册被拒即中止 | `await core.register(plugin)` 丢弃返回值：同名实例已存在时 B 的 init 照样跑、state 写成 running、本函数返回 `ok:true`，而 Map 里仍是 A | 注册被拒**必须在任何 init/start/服务注册之前中止**；同一实例的重复 load 幂等 | `test/unit/test-lifecycle-manager.test.mjs` | v0.15.3 |
| X03 lazy 来源归属 | 撤销判据是"本 SceneController 实例这次登记过谁"（`_sceneLazy` 初值 null）⇒ 启动期 `loadAll` 登记的索引永远没人撤，切到不含 legacy 的场景后它仍能被激活 | 归属下沉到 `_pending[*].source`；按**目标场景的有效声明全集**对账 | `test/probes/x01-x04-cross-state-machine.mjs` | v0.15.3 |
| LAZY-01～04 Attempt/Waiter | 真实装载与等候方塞进同一个 `Promise.race`：定时器从不清除，`rec.state` 被旧定时器改写，`_loading` 在真实装载还在跑时就被删（init 计数 2） | **真实 Attempt** 与**本次等候方**分开记账；句柄只在真实装载 settle 时释放；迟到成功要留痕 | `test/probes/r017-lazy-attempt-facts.mjs`、`test/unit/test-r3-assembly-lazy-and-organ.test.mjs` | v0.15.2 |
| EV-01/02 重载 | `plugin.reload` 与文件 watcher 各写一份重载逻辑，且都错：前者停两次、后者完全不 init。实测改文件后 `callCapability` 仍返回旧实现，而 `state=running`、`plugin.core` 为 undefined | 只有一个 `_reloadPlugin`；次序是判据：**先 import，成功再 unload** | `test/unit/test-e1-plugin-lifecycle.test.mjs` | v0.9.33 |
| EV-03 卸载归位 | `unload` 只转调 `lc.unload`，不改本管理器的 `_lazyLoaded`/`_pending` ⇒ `has=true` 而 `pending=false`，再调 `hasCapability` 永久 false | 卸载必须同时归位两套状态 | 同上 | v0.9.33 |
| EV-02 来源路径 | eager 装载从不登记 `_pluginFilePaths` ⇒ `plugin.reload` 对多数场景插件恒返回 `No file path for: <name>` | eager 装配必须登记来源路径 | 同上 | v0.9.33 |
| R0-143 跨 Core 单例 | `import(path)` 同路径恒返同一实例 ⇒ 两个 Core 装同一插件是同一个对象，后者覆写 `this.core`。实测 A 的调用写进了 B 的目录并返回 succeeded | 装载入口识别"对象已被别的 Core 持有"；`incarnationId` 给跨进程标识 | `test/unit/test-r0-143-cross-core-singleton.test.mjs` | v0.9.31 |

---

## 3. 生命周期：状态只有一个写入者，但"唯一"还不够

| 身份 | 旧失败机制 | 今日不变式 | 证据位置 | 基线 |
|---|---|---|---|---|
| I-01 唯一跃迁写入者 | `plugin.state` 有 7 处写入、分布在 3 个模块（`core.stop` 写 `stopped`、`_reloadPlugin` 写 `unavailable`、`cli` 写 `running`） | 除 `register` 的初始值外，所有跃迁只经 `LifecycleManager.advance` | `test/unit/test-r0-115-subprocess-leak-and-reaping.test.mjs`（结构判据）、`test/unit/test-k03-k14-lifecycle-scene-contracts.test.mjs` | v0.12.0 |
| K3 合法转移表 | 有了唯一写入者，但它只是一个赋值 —— `advance(plugin,'running')` 可以从任何状态跳过来，"合法转移"是无人执行的约定 | 七态转移表 + `invalid_state_transition`（带 from/to）+ 有界轨迹与非法计数 | `test/probes/k01-k14-core-semantics.mjs`、`test-k03-k14-lifecycle-scene-contracts.mjs` | v0.15.4 |
| K-15 / R-014-1 独占区 | 同一 owner 的 start/load/unload/reload 没有互斥。三次并发 `plugin.reload`：三次都返回 `ok:true`、只前进 1 代、真实 import 4 次 | 同一 owner 串行；不同 owner 并行；可重入判据 = 租约仍活动 + 同一 manager + 同一 key | `test/probes/r014-lock-scene-contracts.mjs`、`test/unit/test-k15-k17-concurrency-and-identity.test.mjs` | v0.14.1 |
| R-014-1 租约过期 | 判据是 `Set.has(key)`（"这条链进过这个 key"）。锁内派生、未 await 的异步后代继承了整个 Set，外层锁释放后仍被认作持锁者，与真正持有者并行进入（峰值并发 2） | 存租约对象，`finally` 置 `active=false`；过期上下文自然失效 | 同上 | v0.14.1 |
| R-014-2 队列回收 | `set(key, prev.then(...))` 存包装 Promise，`finally` 里却拿 `next` 比较 ⇒ 身份永不相等，已完成条目永久留在 Map（实测 200 条） | 先算 `tail`、存 `tail`、再用 `tail` 比较 | 同上 | v0.14.1 |
| I-10 / E1-b 排空 | drain 不返回值，超时之后照样 stop + 替换：在飞调用 `handler_threw`、磁盘残留半截，而调用方被告知 `ok:true` | drain 必须返回 `{drained, inflight}`；排空超时时卸载回报 `forced_partial` + `execution_outcome:'unknown'` | `test/unit/test-lifecycle-manager.test.mjs` | v0.10.0 |
| R25-01 loaded 事实 | `core:plugin.loaded` 是已提交事实却走 `emit`：旁观者抛错让 `_load()` reject，而插件仍 running 且在 Core 里 | 已提交事实走隔离面；失败只能来自真实装配失败 | `test/unit/test-r25-01-fact-and-entry-identity.test.mjs` | v0.15.5 |
| K-09 停止顺序 | 按 Map 插入序停，dependent 的 stop() 看到一个已经死掉的 provider | 逆拓扑序停止；没有依赖信息时退回插入序并**标注** `stopOrderBasis:'insertion'` | `test/unit/test-lifecycle-advanced.test.mjs` | v0.14.0 |

---

## 4. 场景：五段式与"插件集合变了 ≠ 场景变了"

| 身份 | 旧失败机制 | 今日不变式 | 证据位置 | 基线 |
|---|---|---|---|---|
| K-04 / P3 五段式 | 卸载旧场景 → `_loadSingle` 逐条装载（失败只 log）→ 不验证就写 `currentScene` | Plan → Preflight → Apply → Verify → Commit；Verify 读真实 running 态 | `test/unit/test-scene-controller-full.test.mjs` | v0.12.0 |
| K-16 独占 + 无变化 | 五段式不解决并发；且无变化时还重写一次持久配置 | 整段五段在同一个 `__scene__` 独占区；无变化**且持久状态已一致**才早返回 | `test/probes/r014-lock-scene-contracts.mjs` | v0.14.0 |
| R-014-3 身份 | 早返回判据只有 `toRemove.length \|\| toAdd.length` ⇒ A→B 两个不同名但同配方的场景被判 `unchanged:true`，内存与磁盘分叉 | 场景名与插件集合是**两个**事实 | 同上 | v0.14.1 |
| R-014-4 不完整 | Preflight 没有 partial/missingIncludes 分支，缺失的 include 被当成"场景就这么大" | 场景自己说了不完整就不许提交成成功 | 同上 | v0.14.1 |
| R-014-5 Verify 口径 | `verified = toAdd.filter(...)`：目标插件早就在 Map 里且 `state==='error'` 时不算失败 | Verify 判据是"**场景要求的谁在跑**"，不是"我这轮新装了谁" | 同上 | v0.14.1 |
| SC-01 落盘失败 | 第一次 `setAndSave` 抛错，但 `currentScene` 已写成 A ⇒ 下一次同名切换命中早返回，永不重试 | 持久事实 `_persistedScene` 只在**落盘成功后**更新；失败后下次必须真的重试 | `test/probes/r016-err015-sc015.mjs` | v0.15 |
| SC-04 默认配置 | 先 `setAndSave('activeScene')` 再逐个 `cfg.set(defaultConfig)`：第一笔成功、后面的默认配置从未落盘 | 默认配置与 activeScene **同一次落盘**提交 | 同上 | v0.15 |
| SC-05 反复写盘 | "有新东西待装"被当成"插件集合变了" ⇒ 推迟装配路径上反复写盘 | 两个判据分开 | 同上 | v0.15 |
| SC-015 按需清单 | `toAdd` 用声明全集（含 lazy），切场景时 lazy 被当场装载 | lazy 不参与切换装载；但**必须登记进懒加载索引**，否则永久不可调用 | `test/unit/test-k03-k14-lifecycle-scene-contracts.test.mjs` | v0.15.1 |
| R0-111/W1 diff 全集 | 只看 `scene.plugins`，而多数场景把插件写在 `eager` 里 ⇒ 被当成空装配 | diff 算场景声明全集（eager ∪ plugins ∪ lazy） | `test/unit/test-r0-111-leftovers.test.mjs` | v0.9.24 |
| R0-112 落盘 await | `setAndSave` 没 await ⇒ "没落盘就返回"，与 CLI 抢同一 config.json，静默冲掉用户其他键 | 写盘必须 await | `test/unit/test-r0-112-release-readiness.test.mjs` | v0.9.24 |

---

## 5. 执行与错误：一个码不能同时是两种事实

| 身份 | 旧失败机制 | 今日不变式 | 证据位置 | 基线 |
|---|---|---|---|---|
| ADR-03 双码 | "能力名不存在"与"工具名没注册"共用一个 code：core 判 failed、执行器判 rejected —— 同一个 code 两个 state | 两个 code 各有归属：装配缺陷 = failed，请求无效 = denied | `test/unit/test-k01-k13b-execution-surface.test.mjs` | v0.10.0 |
| ERR-015 拒绝码 | 白名单认为某些码"一定在副作用之前"，于是 handler 先写文件再抛 `out_of_bounds` 仍报 `state:'denied'` | 只有 Core 在 dispatch **之前**产出的拒绝才是 denied；handler 冒出来的码一律 failed + `side_effect:'unknown_or_possible'` | `test/probes/r016-err015-sc015.mjs` | v0.15.1 |
| K-02 结算点 | 两条入口各写一套，`command` 在超时 finally 里就把 in-flight 减掉 ⇒ 返回瞬间 handler 仍在跑而 `getInflight()===0`，重载闸门被击穿 | 唯一结算点；in-flight 只在真正 settle 时释放，`waiterMs` 只结束等候 | `test/unit/test-r0-113-expert-review-remediation.test.mjs` | v0.12.0 |
| ADR-11 七类 | ADR 声称"已做"，仓库里没有那个函数；两条本仓真的会产出的码返回 null | `categorizeCode` 未登记返回 `null`（不猜）；`result_kind` 与 `state` 不互相推导 | `test/unit/test-r016-doc-line-consistency.test.mjs` | v0.15.1 |
| K-07 schema 前置 | schema 校验排在 `if (!perms) return` 之后 ⇒ 未声明 permissions 的能力，其 `input_schema` 被整体忽略（1.5 / '1' / null 全部放行） | schema 校验先于权限分支；声明了结构化契约时非对象参数必须拒绝 | `test/unit/test-k01-k13b-execution-surface.test.mjs` | v0.12.0 |
| R0-151 override | 只为 `permissions` 做了继承，`input_schema`/`output_schema`/`tags` 原封不动地丢 | 未声明 ⇒ 继承；显式声明（含 null）⇒ 覆盖 | 同上 | v0.12.0 |
| K-01 confirm | `!isTTY ⇒ return true`：CI/守护进程里系统替人批了高风险动作 | 无人在场不得替人点头；逃生门只能来自配置，默认关 | `test/unit/test-r0-110-error-path-and-identity.test.mjs` | v0.12.0 |
| LAZY-04 装载失败 | loader 的 rejection 一路抛到调用方：只有"懒加载失败"是 Promise reject，其余都是信封 | 装载失败/超时用具名信封回答；`dispatched:false` 与 `side_effect:'unknown_or_possible'` **分开写** | `test/probes/r017-lazy-attempt-facts.mjs` | v0.15.2 |

---

## 6. 事实与观察：看得见的人不能改写已经发生的事

| 身份 | 旧失败机制 | 今日不变式 | 证据位置 | 基线 |
|---|---|---|---|---|
| H-03 emitFact | `core.ready` 的观察者抛错让 `await core.start()` reject，而 `core.running === true` | 已提交事实走隔离面；异常进 `_observerErrors`，不静默也不改口 | `test/unit/test-r2-01-ownership-and-hooks.test.mjs` | v0.15.4 |
| R25-02 异步拒绝 | 同步 try/catch 捕不到 Promise 拒绝 ⇒ 进程级 unhandledRejection | 消费 rejection，不等待；安全/策略钩子仍按同步合同 fail-closed | `test/unit/test-r25-01-fact-and-entry-identity.test.mjs` | v0.15.5 |
| R25-03 事实快照 | 只有浅冻结：`requiredFailed` 数组与嵌套对象仍与事实源共享引用，第一个观察者能改掉它 | 纯数据深拷 + 深冻结；非纯数据退回浅冻结并**记账** `_factDegraded` | 同上 | v0.15.5 |
| R25-06 resultKindOf 导出 | 执行器要在外围再抄一份七类表 | 同一张真相只实现一次并导出 | `test/unit/test-k01-k13b-execution-surface.test.mjs` | v0.15.5 |

---

## 7. 预算与证据纪律

| 身份 | 旧失败机制 | 今日不变式 | 证据位置 | 基线 |
|---|---|---|---|---|
| 行数单源 | 同一个数字在三处各说各的（3009 / 2991 / "增量 111"） | `scripts/core-limits.mjs` 是唯一预算来源；`sync-line-docs.mjs` 生成文档里的数字；`test-r016` 机器校验 | `test/unit/test-r016-doc-line-consistency.test.mjs` | v0.15.1 |
| 单模块棘轮 | 单模块超预算只打印 `[WARN]`，不影响退出码 ⇒ 棘轮退化成注释 | 任一模块超预算即 exit 1；合计由表推导，不写字面量 | `test/unit/test-r0-108-line-budget-gate.test.mjs` | v0.9.26 |
| 内容指纹 | E4 用"走完生命周期前后各算一次行数"证明核心零改动 —— 等长改写测不出 | `CORE_FILE_SHA256` 是仓库级锚，逐文件 sha256 | `test/unit/test-evo-echo-evolution-cost.test.mjs` | v0.14.1 |
| 预算沿革 | 每一轮的行数增减原因都写在 `core-limits.mjs` 里（630 行，其中 582 行是流水账） | 本文件承接沿革；`core-limits.mjs` 只留现行数字与推导 | 本文件 §1～§8 | v0.16.0-rc.4 |

---

## 8. 兼容与平台

| 身份 | 旧失败机制 | 今日不变式 | 证据位置 | 基线 |
|---|---|---|---|---|
| R0-101 环境前缀 | 前缀改名会让 `..._PROFILE=production` 静默失效，准入闸门被悄悄关掉 | 规范名 `TUSUNSUN_` 优先；旧前缀只读、只作兼容别名；写入只写规范名 | `test/unit/test-runtime-env.test.mjs` | v0.9.24 |
| R0-112 日志分流 | `core.log()` 同时写 stdout(JSONL) 与 stderr ⇒ 终端每行出现两次，机器流混着横幅 | 人读恒走 stderr；JSONL 只在机器模式；TTY 下只有一份 | `test/unit/test-r0-112-release-readiness.test.mjs` | v0.9.24 |
| K-12 JSON5 | 两次正则处理注释：块注释先于字符串判断 ⇒ `"a /* b */ c"` 被吞；URL 靠扫描顺序侥幸幸存 | 一次状态机扫描；字符串内字节逐字保留；超出子集报错带位置 | `test/unit/edge-cases.test.mjs` | v0.12.0 |
| K-11 SemVer | 解析失败视为满足；`^0.2.0` 接受 `0.3.0`；无预发布处理 | 解析失败一律 false；`^` 对 `0.x` 锁 minor；预发布只在范围也写 pre 时参与 | `test/unit/dependency-resolver-advanced.test.mjs` | v0.12.0 |
| R3-00 requires 解析 | `requires` 的键是服务名，但 DAG 只按插件名查 ⇒ `tool-registry` 找不到，DAG 必定回退目录顺序 | 服务名解析到提供者插件（插件名优先）；认不出的名字仍硬失败 | `test/unit/dependency-resolver.test.mjs` | v0.16.0-rc |
| K-14 反向依赖 | Core 反向 `import` 了 `plugins/_lib/plugin-esm-hint.mjs` | 内核不 import 外围；诊断文本留在外围 | `test/unit/test-r0-104-round-closeout.test.mjs` | v0.12.0 |
| R0-103 无环但排不出序 | 找不到环时返回 `['unknown']`，渲染成 `Circular dependency detected: unknown` | 如实报告"排不出序但不是环"，并带重名/卡住节点 | `test/unit/dependency-resolver-edge.test.mjs` | v0.12.0 |

---

## 9. 残余的历史标记（全部经批准）

清理后仍命中历史标记正则的整行注释只有 **1 条**，不是叙述，而是**版本字面量本身是语义的一部分**：

| 位置 | 内容 | 为什么保留 |
|---|---|---|
| `src/core/dependency-resolver.js:48` | 预发布匹配例子 `2.0.0-rc.1` | `rc.1` 是 SemVer 的被测输入，删掉例子就看不懂"只在范围也写了 pre 时才参与匹配" |

批准口径：**注释里出现版本号 = 违规**，除非那个版本号是被举证的输入/输出字面量。这一条属于后者。

---

## 10. 下一步往哪写

- 现行不变式（要背下来的那 10 条）：`docs/architecture/core-invariants.md`
- 职责与边界（能不能把某个模块搬走）：`docs/architecture/kernel-boundary.md`
- 行数预算的规则：`docs/adr/ADR-10-core-line-budget.md`
- 本次清理的可复跑证据：`reports/core-cleanup-before-after.json`、
  `node scripts/comment-audit.mjs --gate --baseline <rc.3>`
