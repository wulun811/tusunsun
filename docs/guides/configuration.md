# 配置指南

> JSON 配置、环境变量与启动时装配

## 配置文件位置

默认路径：`<stateDir>/config.json`，其中 stateDir 的优先级是 `--state-dir > TUSUNSUN_STATE_DIR > ~/.tusunsun`（所有命令同源解析）。

首次运行自动创建；`tusunsun config set` 在**空目录**下也能首次创建（POSIX 模式 0600、目录 0700、原子写；Windows ACL 未作同等保证）。
配置插件监听文件 change 事件，但原子替换、编辑器保存方式及平台会影响监听；消费者也可能缓存启动值。
修改端口、监听地址、工作区或场景后应重启网关确认，不承诺所有配置即时热生效。

## 常用配置示例（非全部默认值）

```json
{
  "activeScene": "gateway",
  "gateway": {
    "host": "127.0.0.1",
    "port": 9002,
    "token": null,
    "apiKey": null,
    "allowRemote": false,
    "corsOrigins": null
  },
  "model": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": null
  },
  "agent": {
    "systemPrompt": null,
    "maxTurns": 10
  },
  "tools": {
    "permissionMode": "auto",
    "safetyReflection": true
  }
}
```

## 配置项说明

### gateway

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `host` | string | `"127.0.0.1"` | 监听地址（R0-113 起默认**只监听回环**） |
| `port` | number | `9002` | 监听端口 |
| `token` | string | `null` | 预留字段（当前未使用） |
| `apiKey` | string | `null` | 网关 key：既是 `/v1/chat/completions` 的 Bearer token，也是**控制面**（`/api/*`）的鉴权凭证；为空时控制面仅限回环 + 同源 |
| `allowRemote` | boolean | `false` | 对外监听的显式 opt-in。非回环地址必须 `true` **且** `apiKey` 非空，否则拒绝启动（退出码 1）；也可用 `TUSUNSUN_ALLOW_REMOTE=1` |
| `corsOrigins` | array | `null` | CORS 白名单；控制面仍执行同源校验，不能将其理解成控制面跨源授权 |
| `trustedHosts` | array | `null` | 显式可信外部 Host；用于反向代理/自定义域名，与 CORS/网关凭证分别配置 |

### model

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `provider` | string | `openai` | 模型提供商 |
| `model` | string | `kimi-k2.5` | 模型名称（**代码里的真值**，不是推荐值） |
| `baseUrl` | string | `https://coding.dashscope.aliyuncs.com/v1` | API 基础地址（同上：真值，用别家请显式改） |
| `apiKey` | string | `null` | API 密钥 |
| `headers` | object | `null` | 附加请求头（`TUSUNSUN_MODEL_HEADERS` 可表达） |
| `thinking` | object | `null` | 思考开关，**原样进请求体**（`{"type":"disabled"}`；各家形状不同，内核只做形状校验）。`TUSUNSUN_MODEL_THINKING` 可表达；它**不是**思考深度旋钮——本机在开源网关的免费额度上实测 `reasoning_effort` / `budget_tokens` 六档区间完全重叠，但这只是那家网关的实测结果，不代表别家不认 |

### agent

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `systemPrompt` | string | `null` | 自定义系统提示词 |
| `maxTurns` | number | `10` | 最大对话轮数 |
| `workDir` | string | `~/.tusunsun/workspace` | **相对路径的默认基准**（相对路径从这儿算起）。会话可以声明自己的目录来覆盖它（见下节 `workspaces` 与 README「让每个会话在自己的目录里干活」），没声明就一直是它；要求文件工具参数为工作区相对路径，绝对路径与越界会拒绝；**不是 OS 沙箱**，`tool-bash` 不受此边界约束。可用 `TUSUNSUN_WORK_DIR` 覆盖 |

### workspaces

会话级工作目录的策略（R0-124）。不配置这两项时一切照旧：所有会话共用 `agent.workDir`。

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `policy` | string | `"local"` | `local`：本机（回环）调用方可声明任意已存在目录，远端调用方必须落在 `roots` 内；`rooted`：所有人（含本机）都只能落在 `roots` 内；`off`：关闭会话级目录，一律用 `agent.workDir` |
| `roots` | array | `null` | 允许被声明的工作目录白名单（绝对路径）。远端调用方在 `local` 策略下必须有它；配错的条目会在启动日志里报错并**忽略**（白名单宁可少不会多） |

声明方式（三选一）：请求体 `workspace` 字段 / 请求头 `X-Tusunsun-Workspace` / `tusunsun chat --dir <绝对路径>`。
声明失败一律具名拒绝：`workspace_not_found`、`invalid_workspace`、`workspace_not_dir`、`workspace_denied`、`workspace_not_allowed`、`workspace_conflict`（换目录要换 `session_id`）。
已声明的绑定可查：`GET /api/sessions`。

### tools

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `permissionMode` | string | `"auto"` | 工具权限模式（`auto` / `manual`） |
| `safetyReflection` | boolean | `true` | 是否启用安全反思 |

### model.headers

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `headers` | object | `null` | 每次模型请求附带的额外 HTTP 头。给强制会话头的网关用（例：`{"x-opencode-session":"…"}`） |

### 流式失败怎么判：看事件，不看 HTTP 状态码

SSE 一旦开始传输，HTTP 状态码在第一个字节就发出去了。此后模型层再发现「只有思考、没有正文」，
网关只能用一条事件报错：

```
data: {"error":{"message":"[Error] 模型只输出了思考、没有正文（reasoning-only）…","type":"api_error","param":null,"code":"model_error"}}
```

这时**HTTP 状态仍是 200**，而且诊断文本还会作为普通内容片段流过。所以判据只有两条：

1. 流里出现过 `error` 事件 ⇒ 这次调用失败，不能用「收到了文字」当成功；
2. 正文累计起来有非空白字符，才算真的回答了（纯空白不算）。

只看 HTTP 状态码、或只看「有没有输出」，都会把「预算被思考吃光」读成成功。

## 环境变量

规范名统一为 `TUSUNSUN_` 前缀。历史前缀仍被接受、但只作**兼容别名**（两者同时存在时规范名赢）；按 R0-101 的纪律，文档一律只写规范名，旧前缀不在本页列出（唯一定义处是源码 `src/core/env.js`）。
优先级：**环境变量 > 当前目录的 `.env` > `config.json`**。`.env` 由启动命令自动读取
（单行 `KEY=VALUE`、`#` 注释、两侧成对引号会被剥掉），**已存在的环境变量优先、绝不覆盖**。

| 变量 | 说明 |
|------|------|
| `TUSUNSUN_STATE_DIR` | 状态目录（默认 `~/.tusunsun`） |
| `TUSUNSUN_PORT` | 网关端口（`--port` 优先于它） |
| `TUSUNSUN_PROFILE` | `development`（默认）/ `production`；production 下场景锁 `base-system`，需显式 `--scene` |
| `TUSUNSUN_API_KEY` | 模型 API key（另可用 `LLM_API_KEY` 兜底） |
| `TUSUNSUN_MODEL` | 模型名 |
| `TUSUNSUN_BASE_URL` | OpenAI 兼容端点（`http://` 与 `https://` 均可） |
| `TUSUNSUN_MODEL_HEADERS` | 额外请求头，**JSON 对象**：`'{"x-opencode-session":"…"}'`（非法 JSON 会在启动时报错点名） |
| `TUSUNSUN_MODEL_THINKING` | 思考开关，**JSON 对象**：`'{"type":"disabled"}'`（非法 JSON 启动即报错；不配则请求体不多出字段） |
| `TUSUNSUN_WORK_DIR` | **文件工具的路径基准**（默认 `~/.tusunsun/workspace`）。文件工具仅接受工作区相对路径；**不是 OS 沙箱**，`tool-bash` 仍可执行任意命令 |
| `TUSUNSUN_LOG_FORMAT` | `auto`（默认）/ `json` / `human`。`auto`＝stdout 非终端时输出 JSONL；`human` 表示只要人读日志（见快速开始的"两条流"） |
| `TUSUNSUN_GATEWAY_HOST` / `TUSUNSUN_GATEWAY_KEY` / `TUSUNSUN_TOKEN` | 网关监听地址 / 网关鉴权 key / 网关 token |
| `TUSUNSUN_DATA_DIR` | 可变运行数据目录（production 档**必填**且不得在 Git 仓库内） |
| `TUSUNSUN_CHAT_TIMEOUT_MS` | 单次对话命令超时（默认 600000ms） |
| `TUSUNSUN_MODEL_TIMEOUT_MS` | 单次模型请求超时（默认 60000ms） |

## 模型配置示例

以下展示配置形状，不是对各厂商当前模型可用性或工具兼容性的实测承诺。
非回环端点必须配置模型 key；回环本地模型允许免 key。具体端点和模型名请以服务商当前文档与实际响应为准。

### OpenAI

```json
{
  "model": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "sk-..."
  }
}
```

### DeepSeek

```json
{
  "model": {
    "provider": "openai",
    "model": "deepseek-chat",
    "baseUrl": "https://api.deepseek.com/v1",
    "apiKey": "sk-..."
  }
}
```

### 通义千问

```json
{
  "model": {
    "provider": "openai",
    "model": "qwen-turbo",
    "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "apiKey": "sk-..."
  }
}
```

### Moonshot

```json
{
  "model": {
    "provider": "openai",
    "model": "moonshot-v1-8k",
    "baseUrl": "https://api.moonshot.cn/v1",
    "apiKey": "sk-..."
  }
}
```
