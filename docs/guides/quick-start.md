# 快速开始

> 从本地对话服务开始，再决定是否定制插件

本页面向本仓当前版本（以 `tusunsun --version` 为准）的仓库/发行包。Linux 历史验收与 Windows Node 22 本轮验收的范围不同，见 [README 平台表](../../README.md)；不声称本页每个示例都在所有平台执行过。

## 安装

先取得完整仓库或 tgz。2026-10-20 查询 npm 官方 registry 的 `tusunsun` 返回 404，不能仅凭包名认定已有公开发行版。

```text
# 已在仓库目录时直接运行：
node tusunsun.mjs --version

# 若要安装命令：npm pack 后使用其输出的确切文件名，勿用通配符混装旧包。
npm pack
npm install -g --offline ./tusunsun-<版本>.tgz
tusunsun --version
```

需要 **Node.js ≥ 22**（`package.json` 的 `engines` 是 `>=22`；`tusunsun.mjs` 启动时会自检，版本不够会直接给出明确报错）。Node 18/20 已放弃支持（ADR-12）。

下面示例统一写 `tusunsun <命令>`；若没装全局，用 `node tusunsun.mjs <命令>` 代替。

## 先跑四条不花钱的（无需网络、无需 key）

```bash
tusunsun --version
tusunsun --help
tusunsun plugins
tusunsun scene list
```

四条都 `exit 0`。装完先跑它们，能分清"装坏了"和"没配 key"。

### 退出码合同（脚本可判）

| 码 | 含义 |
|----|------|
| 0 | 成功 |
| 1 | 操作失败（写盘失败 / 停止被拒 / 启动期安全策略拒绝） |
| 2 | 用法错误（未知命令、缺参数） |
| 3 | 网关不在（`status` / `stop` / 需要网关的插件命令） |

R0-113 之前这些命令**报告失败也退出 0**（`Unknown command`、`status` 未运行、`stop` 连不上），
脚本据此判断必然误判；现在一律如实返回上表的值。

## 配置模型

三条来源，**优先级从高到低：环境变量 / `.env` > `config.json`**。任选一条即可。

> **不配会怎样？** 默认会打 `https://coding.dashscope.aliyuncs.com/v1`、模型名 `kimi-k2.5`
> （见 `plugins/model-openai.js`）。这两个默认值是**代码里的真值**，不是推荐值——用别家模型
> 请显式设 `TUSUNSUN_BASE_URL` 与 `TUSUNSUN_MODEL`。启动横幅会打印本次**实际生效**的
> `Model: <模型名> @ <端点>`，配完可以照着核对。

**① 环境变量或 `.env`（推荐容器/CI）** —— 在运行 `tusunsun` 的目录放一个 `.env`：

```bash
TUSUNSUN_BASE_URL=https://api.openai.com/v1
TUSUNSUN_API_KEY=sk-your-api-key
TUSUNSUN_MODEL=gpt-4o-mini
```

`.env` 由启动命令自动读取（单行 `KEY=VALUE`，`#` 注释，两侧成对引号会被剥掉）；
**已存在的环境变量优先、绝不覆盖**；没有这个文件也不报错。

**② 命令行写入** `<stateDir>/config.json`（默认 `~/.tusunsun`）：

```bash
tusunsun config set model.baseUrl https://api.openai.com/v1
tusunsun config set model.apiKey  sk-your-api-key
tusunsun config set model.model   gpt-4o-mini
```

空目录下也能直接跑：`config set` 会自动创建 `<stateDir>`（0700）与 `config.json`（0600，基于
默认配置），写失败一律**非零退出**并把错误写到 stderr（R0-113 之前是"打印 ENOENT、退出 0、
文件没生成"）。状态目录的优先级是 `--state-dir > TUSUNSUN_STATE_DIR > ~/.tusunsun`，
`config` / `scene` / `start` / `status` / `stop` 全部同源——不会出现"配置改在 A、服务起在 B"。

**③ 直接编辑** `~/.tusunsun/config.json`（首次运行后自动创建）：

```json
{
  "model": {
    "model": "gpt-4o-mini",
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "sk-your-api-key"
  }
}
```

随包提供 OpenAI 兼容适配器；其他厂商的工具/流式格式仍需逐端点验证。本地模型可将
`baseUrl` 写成 `http://127.0.0.1:11434/v1`（`http://` 与 `https://` 都可用）。

如你的模型网关要求额外会话头，可用下列配置形状（具体头名由网关约定）：

```dotenv
TUSUNSUN_MODEL_HEADERS='{"x-opencode-session":"<你的会话 id>"}'
```

这个变量**必须是合法 JSON**：写坏会在启动时报错点名，不会静默忽略。

> **没有 key 会怎样？** 离线查询命令可运行；非回环模型端点缺 key 时 `/ready` 返回 503，对话失败。
> 回环本地端点（如 `127.0.0.1` / `localhost`）允许免 key，调用时不附带空 Authorization 头。模型 key 与网关 key 是两回事。

## 工作目录（文件工具在哪干活）

**这是最容易踩的一条**：文件工具的默认基准**不是**你执行 `tusunsun start` 的目录，而是

```
~/.tusunsun/workspace          # 默认值，全局共享、跨项目持久
```

后果很具体：你在自己的项目目录里启动、问它"读一下 `package.json`"，它会答
*"当前目录下不存在该文件"* —— 因为它找的是上面那个目录，而横幅此前从不提这件事。

改法（三选一，优先级同模型配置）：

```bash
TUSUNSUN_WORK_DIR=/path/to/your/project    # ① 环境变量 / .env（推荐容器/CI）
tusunsun config set agent.workDir /path/to/your/project   # ② 写入 config.json
# ③ 直接编辑 config.json 的 agent.workDir
```

启动横幅会打印本次**实际生效**的目录：

```
Work dir: /home/you/.tusunsun/workspace
```

> 随包文件工具要求**工作区相对路径**：绝对路径、`..` 越界及已覆盖的符号链接逃逸会拒绝。
> 它仍**不是 OS 沙箱**：`tool-bash` 能执行任意命令，插件和进程继承用户权限，TOCTOU 与 Windows 路径特殊边界未完整覆盖。
> 在 Windows 上请将 `agent.workDir` 设置为自己的绝对 Windows 目录；工具参数仍传相对路径。

### 多个项目同时干活（会话级目录）

上面三条改的是**进程默认**根目录。如果你要的是「会话 A 在 repo-a、会话 B 在 repo-b 同时干活」，
不要去改 `agent.workDir`（那是全局的），而是**给会话声明它自己的目录**：

```bash
tusunsun chat --dir /path/to/repo-a        # 终端
```

```bash
# HTTP：请求头（各家 OpenAI SDK 都有 extra_headers）
curl -s http://127.0.0.1:9002/v1/chat/completions \
  -H 'X-Tusunsun-Workspace: /path/to/repo-a' -H 'Content-Type: application/json' \
  -d '{"session_id":"repo-a","messages":[{"role":"user","content":"读一下 package.json"}]}'
```

声明后，该会话的写入、读取、提示词里的 `Current directory`、破坏面测量、写前必读记录都按它算。
不声明就还是上面的默认根（升级不会改变既有落点）。一个会话只绑一个目录，换目录请换 `session_id`；
`GET /api/sessions` 可以查「谁在哪个目录」。默认只信本机：远端调用方必须落在 `workspaces.roots` 里。

上下文用了多少、摘要是什么、能不能现在就压缩（控制面，与其余 `/api/*` 同门）：

```bash
curl -s 'http://127.0.0.1:9002/api/context?session_id=repo-a'
# → {"session_id":"repo-a","used":4507,"max":8000,"percent":56,"messages":13,
#    "summary":{"text":"","source_range":null,"generator":null,"degraded":true,"reason":"no_summary"}}

curl -s -X POST http://127.0.0.1:9002/api/context/compact \
  -H 'Content-Type: application/json' -d '{"session_id":"repo-a"}'
# → {"session_id":"repo-a","compacted":true,"messages":{"before":13,"after":8},
#    "used":{"before":12515,"after":7510},"percent":{"before":100,"after":93}, "summary":{...}}
```

摘要只在内存里的部署标 `degraded:true`（重启后不能回读，不假装 durability）；摘不到摘要时
`POST /api/context/compact` 返回 `409 summary_unavailable`，会话**一字不动** —— 不拿“删了但没摘要”冒充压缩。

## 启动

```bash
tusunsun start                 # 默认场景（config.activeScene，默认 gateway）
tusunsun start --scene chat    # 指定场景
tusunsun start --port 0        # 随机端口：横幅里会打印内核实际分配到的端口
```

启动后（默认端口 9002）：

- **Web UI**：http://localhost:9002/
- **WebSocket**：ws://localhost:9002/ws
- **Health**（liveness）：http://localhost:9002/health —— 恒 200，正文 `status` 才是实情
- **Ready**（readiness）：http://localhost:9002/ready —— 缺**对话能力**或**模型凭证**时 **503**
  （`missing` 列出缺什么），给负载均衡摘流量用；`/health` 仍恒 200（进程活着）——
  R0-113 之前没配 key 也报 `ready:true`，而真实对话必然 502：假绿比红灯更贵
- **OpenAI API**：http://localhost:9002/v1/chat/completions

### 控制面与监听地址（R0-113 起）

| 项 | 默认 | 说明 |
|----|------|------|
| 监听地址 | `127.0.0.1` | 只服务本机。对外需**显式** `gateway.allowRemote: true`（或 `TUSUNSUN_ALLOW_REMOTE=1`）**且**配 `gateway.apiKey`，否则**拒绝启动**（退出码 1） |
| `/api/*`（控制面：读写配置、压缩上下文） | 无凭证时仅回环 + 同源 | 配了 `gateway.apiKey` ⇒ 一律要 `Authorization: Bearer <key>`（401）；跨源一律 403（**即使带了正确凭证**）；POST 必须 `Content-Type: application/json` |
| CORS | 不发 CORS 头 | 只有显式配置 `gateway.corsOrigins` 白名单才回显被允许的 Origin；不再默认 `*` |
| WebSocket | 子协议 `tusunsun.token.<base64url>` | 口令走请求头，不拼 URL；`?token=` 仅兼容保留 |
| 文件工具边界 | 工作区内 | `../`、前缀同名兄弟目录（`workspace_evil/`）、符号链接逃逸一律具名拒绝（`out_of_bounds`）。**不是沙箱**：`tool-bash` 不受限 |

配了网关 key 的实例，打开 `http://127.0.0.1:9002/`，点页面钥匙按钮并在登录框输入口令。
凭证保存在该标签页的 `sessionStorage`，请求时进入请求头/WS 子协议。
不要把长期口令拼在 URL 中；旧 `?token=` 只作兼容，可能泄漏到历史或日志。

命令行访问控制面：

```bash
curl -H "Authorization: Bearer $TUSUNSUN_GATEWAY_KEY" http://127.0.0.1:9002/api/config
```

**两条流各司其职**：人读日志恒在 **stderr**；**stdout** 在非终端（重定向/管道/CI）下是逐行
JSON（JSONL），终端里则不输出日志。所以：

```bash
tusunsun start > run.jsonl          # 机器可逐行 JSON.parse
tusunsun start 2> run.log           # 人读日志
TUSUNSUN_LOG_FORMAT=human tusunsun start   # 强制只要人读（stdout 保持干净）
```

`tusunsun plugins | head` 这类"下游提前关管道"**静默收尾、退出码 0**（与 `ls | head` 同惯例）。

## 聊天

```bash
tusunsun chat     # 交互式对话；必须先 start（它经 WebSocket 连网关）
tusunsun tui      # 终端 TUI 面板（监控 + 管理 + 聊天）；数据面同上
```

也可以直接打开 http://localhost:9002/ 用 Web UI。

## 场景切换

```bash
tusunsun scene list                        # 列出可用场景
tusunsun scene switch gateway-lite         # 只**提案**：打印将增删哪些插件，不改动
tusunsun scene switch gateway-lite --yes   # 写入 config.activeScene，供下次启动使用
```

CLI 命令在本地探针里计算和应用变化，不等于通过 WS 热切正在运行的网关。要确保新装配生效，请先 stop 再 start；运行时场景 API 是另一条路径。

提案里的增删算的是**场景声明的全集**（`eager ∪ plugins ∪ lazy`），与启动时的装配同口径。

## 下一步

- [配置指南](./configuration.md) — 详细配置说明
- [插件开发](./plugin-development.md) — 开发自己的插件
- [场景系统](./scene-system.md) — 理解场景机制
