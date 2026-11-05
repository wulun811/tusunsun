# 微内核架构

> 微内核 4896 行代码提供装配机制；模型、对话与工具由包内其他组件实现
>
> 行数口径：`src/core/` 下每个 `.js` 的 `content.split('\n').length` 求和（即"换行符数 + 文件数"，
> 比 `wc -l` 多算每个文件末尾那一行）。口径与 `test/unit/test-r0-65-*/E4` 的门禁一致——
> 文档数字需随源码更新，并由相关门禁复核。

## 设计哲学

1. **核心越轻越好** — 一个下午能读完
2. **插件负责一切** — 核心只提供机制，不提供策略
3. **场景驱动** — 不同场景加载不同插件组合

## 核心组件

```
src/core/                       （8 个文件，2746 行）
├── core.js                     ← 事件总线 + 命令总线 + 能力注册 + 服务注册表 + 中间件管道（845）
├── plugin-manager.js           ← 插件装配、懒加载索引、热重载、闲置回收（621）
├── dependency-resolver.js      ← 多宝道人 — DAG 依赖解析（192）
├── lifecycle-manager.js        ← 准提道人 — 七步安全卸载（187）
├── scene-controller.js         ← 接引道人 — 场景调度（187）
├── plugin-meta.js              ← 插件元数据提取（118）
├── json5-loader.js             ← 场景配置加载（34）
└── env.js                      ← 环境变量读取（规范名 `TUSUNSUN_*`，兼容历史名）（38）
```

> **本表在 v0.9.24 修正过一次**：此前树里仍列着 `secrets.js` 与 `cli.js`，并标着 `2079` 行。
> 两者在 R0-120 已移出 `src/core/`（分别到 `src/plugins/secrets.js` 与 `src/bootstrap/cli.js`），
> 但这份"架构文档"没跟着改 —— 于是文档描述的是一个**已经不存在的目录结构**。
> 教训与 v0.9.23 那八个缺陷同形：数字对不上会被门禁抓住，**结构对不上没人抓**。
> 现在树与实况一一对应，且 R0-103/T8 逐个文件名核对。

> 每个模块后面括号里的数字是**该文件的行数**（同一口径）。改内核必须同步这张表——
> 门禁会核对总数与逐文件数字（`test/unit/test-r0-103-*` T8）。

## 三道人架构

土行孙的插件生命周期由"三道人"管理：

### 多宝道人（DependencyResolver）

- 职责：依赖解析 + 懒加载
- 算法：DAG 拓扑排序
- 特性：版本匹配、循环检测、可选依赖

### 准提道人（LifecycleManager）

- 职责：七步安全卸载
- 步骤：
  1. 依赖检查 — 有依赖则阻塞
  2. 能力冻结 — 阻止新调用
  3. 请求排空 — 等待进行中的请求
  4. 停止 — 调用 plugin.stop()
  5. 清理 — 移除监听器
  6. 注销 — 移除服务和能力
  7. 状态钩子 — 若插件提供 `persistState()` 则尝试调用，不代表任务自动恢复

### 接引道人（SceneController）

- 职责：场景调度
- 功能：加载场景定义、切换场景、热重载插件

卸载排空有超时，`stop()` / `persistState()` 异常在该路径记录日志后继续清理；“七步”描述顺序，不是事务回滚或零丢失保证。

## 事件总线

```javascript
// 监听
core.on('chat.message', handler);

// 发送
core.emit('chat.message', { text: 'hello' });

// 快速发送（跳过验证）
core.emitFast('chat.message', { text: 'hello' });
```

事件名必须包含 `.`（如 `chat.message`）——`emit()` 会**具名拒绝**不含 `.` 的名字。

两类命名并存，各有归属：

| 类别 | 形态 | 例子 | 说明 |
|---|---|---|---|
| 插件事件 | `source.action` | `chat.message`、`tool.executed`、`session.created` | 插件之间的事实广播 |
| 内核事件 | `core:source.action` | `core:plugin.loaded`、`core:capability.denied`、`core:service.conflict` | **内核自身**发出；`core:` 前缀表示"由微内核产生"，同样含 `.` |

订阅方不要靠"前缀猜来源"：内核事件是稳定契约，插件事件由插件自己定义。

## 命令总线

```javascript
// 调用能力
const result = await core.command('chat.handle', {
  message: 'hello',
  sessionId: 'test',
});
```

命令总线支持：
- 同步调用
- 超时控制
- 错误处理
- 事件回退

## 服务注册表

```javascript
// 注册
core.registerService('my-service', myObject);

// 获取
const svc = core.getService('my-service');
```

## 能力注册

```javascript
// 注册
core.registerCapability('example.run', {
  description: 'My capability',
  handler: (args) => result,
  owner: 'my-plugin',
});

// 调用
const result = await core.callCapability('example.run', args);
```

## 中间件管道

```javascript
// 注册中间件
core.use('inbound', (msg) => {
  msg.extra = 'data';
  return msg;
});

// 运行管道
const result = await core.runPipeline('inbound', message);
```

## 插件加载流程

```
1. 扫描 plugins/ 目录
2. 提取元数据（name, version, requires）
3. 构建依赖图
4. DAG 拓扑排序
5. 按序调用 init()
6. 按序调用 start()
```

## 热重载

启动入口调用 `watchForChanges()`，文件 watcher 检测 `.js/.mjs` 的 change 后尝试重载。文件系统事件、插件资源清理与平台限制仍会影响结果；不等于跨进程状态迁移或持久任务恢复：

```
1. 检测文件变化
2. 七步卸载旧插件
3. 加载新插件
4. init() + start()
```

## 代码量统计

| 文件 | 行数 | 职责 |
|------|------|------|
| core.js | 2311 | 事件总线、命令总线、能力注册、服务注册表、中间件管道、日志分流（stderr 人读 / stdout JSONL） |
| plugin-manager.js | 877 | 插件装配、懒加载索引（含把 lazy 声明发布给准入闸门）、热重载（唯一实现 `_reloadPlugin`）、闲置回收 |
| dependency-resolver.js | 417 | 多宝道人 — DAG 依赖解析 |
| lifecycle-manager.js | 577 | 准提道人 — 七步安全卸载 + **per-owner 独占区**（`runExclusive`，ALS 可重入）：同一 owner 的 load/unload/reload 串行化 |
| scene-controller.js | 460 | 接引道人 — 场景调度（五段式；整段进 `__scene__` 独占区；无变化不重写盘；`show()` 委托 `plugins/scene-inspect.js`） |
| plugin-meta.js | 131 | 插件元数据提取 |
| json5-loader.js | 88 | 场景配置加载 |
| env.js | 35 | 环境变量读取/写入（规范名 `TUSUNSUN_*`）+ 日志分流判据 |
| **合计** | **4896** | 预算上限 **4896**（v0.20.2：4889 → 4896 —— schema 登记与 `type` 并集判据，净增 +7；R0-175～R0-178 的注释压缩抵扣了其余增量。v0.15.0：+129 行 —— 专家 0.14.1-post 复审的 INV-01 与 SC-01～05：拒绝码按执行阶段分层（ADR-13，含 API 影响清单）、场景持久事实 `_persistedScene`、默认配置与 activeScene 一次落盘、deferred 早返回不再报 verified。v0.14.1：+134 行 —— 专家 0.14.0 复审的五条可复现反例 R-014-1～5：ALS 过期租约（判据从 `Set.has(key)` 改为 `{active, manager, key}`）、队列 Map 回收（存 `tail` 比 `tail`）、场景身份与插件集合分开算、必需 include 缺失阻断、Verify 改为核对完整必需集合（排除 lazy）；另加 CLI 推迟装配的显式分流（`deferAssembly`），因为 CLI 不启动内核，放松 Verify 只会让 R-014-5 复发。**本轮同时更正了两处预算同步错误**：v0.14.0 曾把 lifecycle-manager 写成 289、scene-controller 写成 256，而当时实测就是 318/341 ⇒ v0.14.0 的 `npm run check` 当时即为红，只是没被发布流程拦住。行数预算的**唯一权威说明**见 `docs/adr/ADR-10-core-line-budget.md`。v0.14.0：+136 行，其中非注释代码约 55 行，用于 §6.2 串行化、§5.3 attempt token 与 I-01 唯一跃迁写入者；v0.12.0 内核精修 P4 后累计 +425 行：P1 +55（执行切面）、P2 +118（生命周期归一）、P3 +94（场景五段式）、P4 +158（SemVer/JSON5 真解析器 + 权属 + 依赖方向）。P2 的核心是 `Core.start` 整条委托给 `lc.load` —— 装配入口 4→3、`plugin.state` 写入点 8→5、状态跃迁只剩 Lifecycle 一个写入者；代价是 `load()` 从 26 行涨到 47 行并新增 `_stopOrder()`/`describeLazyLoad()`。落地计划原估 P2 为 +27，实际 +118，差额与原因写在 `scripts/core-limits.mjs`。P1 部分：全部来自 K-01/K-02/K-06/K-07/K-13b 五条反例的修复：`callCapability`/`command` 合流为唯一 `_dispatchCapability`（超时不再把 in-flight 归零，信封加 `execution_outcome`/`still_running_at_return`）、schema 根类型判据、override 全字段继承、`releaseCapability` 拒绝匿名让渡、`confirm` 无 TTY 时不再自动同意。**落地计划原估这一批净减 10 行，实际净增 55**——预估漏算了加性字段与三分支证据的开销，已按既定口径抬限额并写明原因，明细见 `scripts/core-limits.mjs`。原文：v0.9.33 的 E1 共 +35 行：eager 插件登记来源路径（EV-02）、`plugin.reload` 与 watch 两处内联重载合成唯一实现 `_reloadPlugin`（EV-01，两处原本各自出错：一份停两次、一份完全不 init）、`unload` 归位 `_lazyLoaded`/`_pending`（EV-03，修前两套状态互相矛盾且不可恢复）。v0.9.31 共 +4 行，全部是 P0 修复、无一行重构：① `freezeCapability` 广播 `core:capability.frozen`（执行器缓存命中路径不经过 core，看不见冻结，实测冻结后仍返回 succeeded）；② `plugin-manager` 模块实例标识（`import(path)` 同路径恒返同一实例 ⇒ 双 Core 共享插件对象，实测 A 的调用写进 B 的目录并返回 succeeded）。另有 R0-150 的 `getCapabilityOutputSchema`（+4 行，让 `output_schema` 偏差可观测）与 R0-151 的 `override` 继承规则（+4 行，防安全声明静默丢失）。上限按 `scripts/core-limits.mjs` 的既有口径抬到 2150，**现余量 5 行**。v0.9.25 曾 +1 行：`plugin-manager` 里记下"合并后去重逻辑为何仍保留"。v0.9.24 曾从 2080 抬到 2100，增量是公开枚举接口 `listCapabilities`；R0-120 曾首次**下调** 2556 → 2080，原因见下方「构成」一节） |

> 这张表由门禁核对（`test/unit/test-r0-103-*` T8：逐文件数字 + 合计都必须等于实况），
> 历史上它曾停在 1695 行/7 个模块而与实况脱节——修改源码时仍须同步文档，并以检查结果确认一致。

### 2145 行的构成：哪些是内核，哪些不是

常被问"为什么核心这么大、是不是什么都往核心里塞"。R0-120 按职责把不属于内核的两块移了出去，
现在剩下的每一行都在回答"缺了它内核就跑不起来"：

| 档位 | 文件 | 行数 | 判断依据 |
|------|------|------|----------|
| **内核本体** | `core.js`（828）+ `plugin-manager.js`（550） | 1378（66%） | 事件/命令/能力/服务四条总线、装配与懒加载索引、热重载与闲置回收。插件加载器自己不能是插件。 |
| **装配语义** | `scene-controller`（175）/ `dependency-resolver`（192）/ `lifecycle-manager`（163）/ `plugin-meta`（118）/ `env`（38）/ `json5-loader`（34） | 720（34%） | 场景选择、依赖 DAG、卸载顺序、插件元数据、环境变量前缀、配置解析——都是"把插件装起来"这件事的组成部分，移出去会变成循环依赖。 |

**已移出**（R0-120，逻辑一个字节没动，只改相对导入）：

- `core/cli.js`（324）→ `src/bootstrap/cli.js`。它是**启动引导**：解析 argv、选场景、拉起
  PluginManager。内核本体不依赖它——换个宿主（TUI、GUI、测试）可以完全绕开它驱动内核。
- `core/secrets.js`（129）→ 现 `plugins/_lib/secrets.js`（v0.9.24 先移到 `src/plugins/`，
  v0.9.25 目录合并后落到 `_lib/`）。**零生产调用点**，只有单测在测；
  它是可拆卸的能力（AES-256-GCM 封装），不是内核语义。

**v0.9.25：`src/builtin/` 已并入 `plugins/`。** 这是本仓最重要的一次结构简化，
它删掉的不是一个目录，而是一个**从没被论证过、却在四处漏出影响**的区分：

- **运行时没有区别。** 两边都是普通插件（都有 `name` + `init`），都由同一个 `PluginManager` 装载，
  都按场景的 `eager` 过滤，都进发布包。区别只有一处：`cli.js` 里多一行
  `pm.addDirectory(dir('../builtin'))` —— 也就是**装配点多了一个**。
- **唯一的真区别是隐式的。** `check:deps` 只扫 `src/`，于是"要不要零外部依赖"
  由**文件放在哪个目录**决定。挪个文件，约束就悄悄变了，没有任何门禁看得见。
  v0.9.24 先把这条改成显式名单（`ZERO_DEP_FILES`），v0.9.25 才敢合并 —— 顺序不能反。
- **它还外溢成了测试里的"两棵树"。** 历史上开发树与产物布局不同（构建期把
  `src/builtin/x.js` 映射成 `plugins/x.js`），于是二十来个测试各自维护一份双路径解析。
  这些代码服务的差异**只存在于构建脚本里**，而构建脚本后来被删了，
  判据却留着 —— `test/harness.mjs` 的"开发树"标记文件 `src/builtin/gateway.js`
  早在 R0-103 就被删除，导致**开发树一直被误判为"产物形态"**，
  只因错误方向是"多跑门禁"，所以一直没人发现。

合并后的布局：

```text
src/core/          ← 唯一受行数预算约束的内核（4896 / 4896）
src/bootstrap/     ← 启动引导：解析 argv、选场景、拉起 PluginManager（不受行数预算）
plugins/           ← 唯一的插件面（80 个 js/mjs，26 849 行；2026-11-05 实测）
  *.js             ← 40 个顶层文件（含 recycle-advisor 参考实现）
  tools/           ← 工具插件家族（10 个）
  _lib/            ← 内部模块容器（不是插件目录；`_` 前缀由 resolvePluginDirs 真的跳过）
```

两个常被误解的点：

1. **行数门禁只覆盖 `src/core/` 这一层。** 门禁只统计 `src/core/*.js`。
   `src/` 合计 5236 行（core 4896 + bootstrap 340），`plugins/` **26 849 行 / 80 文件**
   （2026-11-05 实测，口径：`find plugins \( -name '*.js' -o -name '*.mjs' \) | xargs wc -l`）——
   单是插件面就是内核的 5 倍，
   另有 `vendor/liuhe-lite/` 7 201 行第三方代码（**可选器官，默认不装配**）——
   所以"核心行数纹丝不动"只在 `src/core/` 范围内成立，
   不能读成"这几轮没怎么动代码"。想往外放的东西，本来就有远大于核心的空间。
2. **上限是"天花板"，不是"目标"。** 2026-10-14 从 2000 放宽到 2500 是维护者本人的意见
   （2000 太紧，逼得为凑数压缩注释）；此后三次抬到 2525 → 2540 → 2556。R0-120 首次**下调**
   到 2080：移出 453 行后，上限跟着实况一起降，否则"移出"只是账面好看，下一轮又会有人
   把那 453 行的空档填满。v0.9.24 抬到 2100（枚举接口，见 `scripts/core-limits.mjs` 的完整理由）。
   核心现在是 3168/3168，**余量为 0**——任何增长都必须
   显式改 `scripts/core-limits.mjs` 并被 review 看见。
   v0.12.0 的 P1 精修把这一条**又走了一遍**：落地计划预估净减 10 行，实际净增 55 行，
   差额写在 `scripts/core-limits.mjs` 里，没有回头削注释凑数。
