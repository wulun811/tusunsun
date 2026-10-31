# 场景系统

> 先看要干什么活，再决定这次带哪些能力。

纯聊天、读写项目文件、接自己的业务工具，需要的组件并不一样。场景把一类工作的搭配写成可重复使用的配置：必需组件先启动，适合按需加载的能力用到再加载，部分懒加载插件闲置后可以回收。

这是“让 Agent 跟着工作变”的具体落点。你来选择或编写场景；内核提供装配、能力调用和生命周期机制。本页说明哪些配置会实际生效，以及它们的限制。

## 什么是场景

场景是一个 JSON5 文件，定义了：
- 加载哪些插件
- 启用哪些能力
- 使用什么配置

## 内置场景

| 场景 | 说明 |
|------|------|
| `base-system` | 所有场景的底座（准入闸门、配置、网关、装配锁、就绪检查…） |
| `gateway-lite` | 轻量网关，纯模型代理（无工具执行） |
| `chat` | 纯对话，无工具 |
| `gateway` | 默认对话网关、文件工具与会话；`ying-mini` 在懒加载清单，不代表已作为 memory 服务启动 |
| `coding` | 编码场景 |
| `cell` | 单 Cell 运行形态：在 `gateway` 之上多一个 `cell-runtime`（1 Cell : 1 Core : 1 进程） |
| `file-txn` | 受控多文件事务：唯一把 `liuhe-lite` 拉成 eager 的场景（六合 Lite 默认不进任何场景） |
| `agent-platform` | Agent 扩展装配配方：模型 + 会话启动即用；`tool-*` 与 `kunxiansuo-local` **仅在 `optional`（惰性、不装配）**。名称不代表开源包提供持久任务编排交付平面 |
| `iot` | IoT 场景 |
| `san-cai` | 三才相关装配配方；以 `scene show san-cai` 与实际可解析组件为准，不承诺包外 full 功能 |

每个场景"启动即加载什么、按需加载什么"由它自己的 `eager` / `plugins` / `lazy` 决定；
**不要在这份文档里抄数字**——用 `tusunsun scene show <名>` 看实况（历史上这里抄过
"插件数 6/16+/10+"，全部与实况脱节，见 R0-103）。

## 各场景声称的能力面（v0.9.33 从 `schema` 键迁到这里）

此前每个场景文件里有一个 `schema` 块，写着 `capabilities` / `useCases` / `features` / `template`。
**装配器从不读它**（`src/` 与 `plugins/` 里零读者，可用 `grep -rn "scene.schema"` 自证）。
零读者的配置比没有更糟：读者会以为"这个场景已经声明能力面"，而真正生效的是
Cell 能力门（`plugins/cell-runtime.js`）与 `plugins/tool-guard.js`。

所以 v0.9.33 把这类**纯元数据**从场景文件移到了这里 —— 它本来就是给人看的选择依据，
不是给装配器读的配置。机器可判读的一致性由 `npm run scene:inspect` 负责（见下）。

| 场景 | 声称的能力 | 说明与已知边界 |
|---|---|---|
| `base-system` | 配置管理、网关服务、场景切换 | 底座，不做业务 |
| `gateway-lite` | 仅模型调用 | **不含工具执行**。本场景 `eager` 只有 4 个插件，`tool-executor` 与 `tools` 都不在，`tool.*` 能力数为 0；任何工具调用会落到 `Tool "x" not found (no tool-executor or legacy tools)` |
| `chat` | 仅模型调用 | 纯对话，无工具 |
| `gateway` | 模型调用、工具执行、会话持久化、场景切换 | 不含"代码编写"专属能力，也不含长期记忆/监控（本包 10 个文件工具） |
| `coding` | 同 `gateway` + 编码工具集 | — |
| `agent-platform` | 模型调用、会话 | 扩展装配**起点**。`tool-*` 与 `kunxiansuo-local` 只在 `optional` 里列出（惰性、不装配）；要工具就自己提到 `eager`。名称不代表开源包提供持久任务编排交付平面 |
| `iot` | 模型调用、设备控制 | 设备控制依赖包外组件；本包内不含 |
| `cell` | 模型调用、工具执行、单 Cell 生命周期、任务准入与验收 | 在 `gateway` 之上增加 `cell-runtime`（1 Cell : 1 Core : 1 进程） |
| `san-cai` | 三才相关装配配方 | 以 `scene show san-cai` 与实际可解析组件为准，不承诺包外 full 功能 |

**这张表也不是契约**——它是给人看的。想知道某个场景**此刻真的**装了什么、缺什么、
哪些键没人读，跑：

```bash
npm run scene:inspect -- coding        # 人读
npm run scene:inspect -- --all --json  # CI 判读（不一致时退出码 1）
```

## 字段语义（装配器实际读什么）

**这张表就是契约**——装配器（`src/bootstrap/cli.js` + `src/core/plugin-manager.js`）只读这些键：

| 字段 | 装配行为 | 说明 |
|---|---|---|
| `include` | 合并父场景的 `eager` / `plugins` / `optional` | 子场景的列表追加在父场景之上；`lazy` **不随 include 继承** |
| `eager` | 启动与**切场景**都立即 import + init | 必需件放这里。**切场景要求 running 的只有这一项**（Verify 判据）。**服务型插件必须在 eager**（见下） |
| `plugins` | 声明可用，**首次能力调用时才装载** | 与 `lazy` 同一个懒加载池（`scenePluginLists()` 的懒清单）。切场景**不装载**、也不要求 running |
| `lazy` | 同 `plugins`，语义显式 | 与 `plugins` 合并后一起去重 |
| `defaultConfig` | 切场景时写入配置 | 键是配置路径（如 `gateway.port`） |
| `optional` | **当前不参与装配**（已登记缺口 R0-103-D1） | `scene show` 会显示它 |
| `fallback` | **当前不参与装配**（已登记缺口 R0-103-D2） | 降级解析器存在（`resolveWithFallback`）但装载路径没调用 |
| `sceneContext` | **无任何消费者**（已登记缺口 R0-103-D3） | 历史字段 |
| `schema.*` | **不参与装配，也没有读者** | v0.9.33 起本仓 10 个场景已全部移除；只有 `scene-switch-listener` 把它原样转发（恒 `null`）。“AI 推荐切换”**没有实现**——`scene suggest` 是按插件名的本地匹配 |
| `name` / `description` / `version` | 元信息 | `name` 必须与文件名一致 |

> **v0.15.1 更正**：上表 `plugins` 一行此前在**启动器**与**场景切换**里是两种解释——
> 启动时它进懒池，切换时却被当成"必须运行"（`toAdd`/Verify 都用 `eager ∪ plugins`）。
> 专家 0.15.0 复审（SC-015）指出这条接缝后，切换侧已对齐到启动器与本表：
> **只有 `eager` 是"切场景需要立即运行"，`plugins` 与 `lazy` 都是"声明可用、按需装载"。**
> **v0.16.0-rc.10 更正**：这句话原来写"本仓 9 个场景没有一个写 `plugins` 键"，**是错的**——
> 本仓有 10 个场景，且默认场景 `gateway` 的 27 项工具/处理器**全部**写在 `plugins` 里。
> 错因很具体：当时用 `grep '"plugins"'`（带引号）核对，而这批场景用的是 JSON5 无引号键
> （`plugins: [...]`），一个都搜不到。正确核法不带引号：`grep -n '^ *plugins:' scenes/*.json5`
> （当前只命中 `gateway`）。所以这次对齐对 `gateway` **是行为变化**：27 项从"切换时必须运行"
> 改成"声明可用、按需装载"——方向是对的，但不该写成"零行为变化"。
>
> 配套两条：① 切换时按需清单会登记进 `PluginManager` 的懒加载索引（只读文件头、不 import），
> 切出时撤销纯索引项 —— 否则"从 `toAdd` 删掉 lazy"会让它**永久不可调用**；
> ② 按需清单里的插件如果**解析不到来源**，切换**仍然成功**（它此刻不需要运行），
> 但返回值会带 `lazyUnresolved: [{name, error}]` 并在日志里 warn —— 首次能力调用会失败，
> 这件事必须让调用方看得见，不能等它变成一次莫名其妙的 `capability_not_found`。

> **`verified: true` 的作用域只有 `eager`**（v0.15.2，专家 M-02）。
> 场景切换的 Verify 段只验证“场景要求**立即运行**的插件是否真的在跑”——`plugins` / `lazy`
> 此刻本来就不该跑，所以它们既不在必验集合里，也不应该被 UI / Cell 解释成“全部声明能力已就绪”。
> 要看“声明的能力到底齐不齐”，读 `scenePluginLists()` 的全集（eager ∪ plugins ∪ lazy）
> 再比对 `pm._pending`；`verified` 不回答那个问题。
> 不把可选 lazy 缺失升级成“场景切换失败”：一个按需插件此刻不需要运行，用失败阻断
> 整场装配是拿“现在不需要的东西”去卡“现在就需要的东西”。

### 为什么服务型插件必须写进 `eager`

懒加载的触发点是**能力调用**（`callCapability` / `command`）。而 `core.getService(name)`
是**同步 API**，不可能在查不到服务时去 await 一个懒加载——所以 `provides` 为
`type: 'service'` 的插件（`session`、`model`、`health.monitor`…）如果只写在 `plugins` 里，
**不会仅因 getService() 而加载**；其他能力调用可能触发加载，但不能依赖这种副作用满足服务启动顺序。

判断方法：看插件的 `provides` —— `{ type: 'service' }` ⇒ 放 `eager`；
纯能力（`chat.handle`、`tool.*`、`route.*`）⇒ 可以放 `plugins` 走懒加载。

## 场景文件格式

```json5
{
  // 场景名称
  name: "my-scene",
  
  // 场景描述
  description: "自定义场景",
  
  // 启动即加载（必需件：配置、网关、以及所有服务型插件）
  include: ["base-system"],
  eager: ["session", "model-openai", "ying-mini"],
  
  // 按需加载（能力型插件：工具、对话处理器等）
  plugins: [
    "my-custom-plugin",
  ],
  
  // 默认配置（键为配置路径；字段名是 defaultConfig）
  defaultConfig: {
    "gateway.port": 9002,
    "model.model": "gpt-4o-mini",
  },
  
  // 元信息（展示用，装配不读）
  schema: {
    capabilities: ["chat.handle", "scene.list", "scene.current", "scene.switch"],
  },
}
```

## 切换场景

```bash
# 查看可用场景
node tusunsun.mjs scene list

# 查看当前场景
node tusunsun.mjs scene current

# 先看变更提案（不修改）
node tusunsun.mjs scene switch gateway-lite
# 保存下次启动场景
node tusunsun.mjs scene switch gateway-lite --yes
```

CLI 操作的是本地场景探针和配置，不是向已运行网关发送热切换请求。用 stop → start 确认新装配生效。
运行时 `SceneController.switchTo(..., {yes:true})` 是另一条生命周期路径，不要把两者混为一谈。

## 创建自定义场景

1. 在 `scenes/` 目录创建 JSON5 文件：

```json5
// scenes/my-scene.json5
{
  name: "my-scene",
  description: "我的自定义场景",
  include: ["base-system"],
  eager: ["session", "model-openai", "ying-mini", "chat-ui", "haotian-lite"],
  plugins: [], // 路由注册与对话入口在本例主动初始化
}
```

2. 切换到新场景：

```bash
node tusunsun.mjs scene switch my-scene --yes
# 重启网关后使用新装配
```

## 场景与插件的关系

```
场景 A: [config, gateway, session, model-openai]
场景 B: [config, gateway, session, model-openai, ying-mini, kunxiansuo-local]
场景 C: [config, gateway, session, model-openai, haotian-lite]
```

同一个插件可以在多个场景中使用。场景只是决定了加载哪些插件。

## 最小场景

仅演示基础装配（不提供对话能力，`/ready` 可能为 503）。最小场景应保留公共底座：

```json5
{
  name: "minimal",
  include: ["base-system"],
  eager: ["model-openai"],
}
```

## 完整场景

以下仅演示组合，不是“所有功能”或已验收配置。服务型插件在 `eager`；Chat UI 注册路由、场景监听器订阅事件，都需要主动初始化，不能仅放 lazy 池等待未必存在的能力调用：

```json5
{
  name: "full",
  include: ["base-system"],
  // 服务型：必须 eager（同步 getService 无法按需触发懒加载）
  eager: [
    "config",
    "gateway",
    "session",
    "model-openai",
    "health",
    "heartbeat",
    "plugin-context",
    "ying-mini",
    "chat-ui",
    "scene-switch-listener",
  ],
  // 能力型：按需加载
  plugins: [
    "kunxiansuo-local",
    "haotian-lite",
  ],
}
```


## 运行保证的边界

场景是组件清单，不是任务调度器或安全权限清单。尤其 `ying-mini` 只列在 `plugins` 时，单独 `getService('memory')` 不会让它自动加载；需要该服务的自定义场景应把它加入 `eager`。工具加载器还可能单独索引工具目录，不能只靠删减场景名字把它当作权限系统。
