# 示例代码

土行孙插件示例。

## 文件说明

| 文件 | 说明 | 难度 |
|------|------|------|
| `minimal-plugin.mjs` | 最简插件 — `init/start/stop` 生命周期 + 事件监听 | 入门 |
| `capability-plugin.mjs` | 注册能力 — 服务 + 能力注册表 + 缓存示例 | 进阶 |
| `custom-channel.mjs` | 自定义渠道 — 接入第三方 IM/聊天平台 | 中级 |
| `custom-tool.mjs` | 自定义工具 — Agent 可用的 CLI/工具 | 入门 |
| `model-anthropic.js` | 替换模型适配器 — Anthropic 协议 | 中级 |
| `channel-telegram.js` | Telegram 渠道适配 | 中级 |
| `channel-feishu.js` | 飞书渠道适配 | 中级 |
| `channel-feishu-adapter.js` | 飞书适配层（上面两个的拆分版） | 中级 |
| `cells/single-cell.mjs` | 单 Cell — `create → accept → execute → close` 全流程 | 进阶 |
| `cells/dual-cell.mjs` | 双 Cell — 两个独立内核进程各跑一个 Cell | 进阶 |

> **模型适配器不是“复制就能用”的**：只注册一个 `call()` 不够，必须完整实现对话插件消费的
> `model` 服务契约（含配置解析、普通与流式方法）。详见
> [插件指南](../docs/guides/plugin-development.md) 与 [Cell API 参考](../docs/reference/cell-api.md)。

## 如何使用

### 方法 1：直接复制

```bash
cp examples/minimal-plugin.mjs plugins/my-plugin.js
node tusunsun.mjs start
```

### 方法 2：修改后复制

1. 复制示例到 `plugins/` 目录
2. 修改 `name` 和实现逻辑
3. 重新启动土行孙

### 配置

工具示例无需配置。渠道示例需要在 `config.json` 中设置 token：

```json
{
  "channels": {
    "example": {
      "token": "your-api-token-here"
    }
  }
}
```

## 插件契约

所有插件必须遵循 `name` + `init(core)` + `start()` + `stop()` 契约：

```javascript
export default {
  name: 'my-plugin',
  version: '1.0.0',
  async init(core) { /* 注册服务/能力/监听器 */ },
  async start() { /* 开始工作 */ },
  async stop() { /* 清理资源 */ },
};
```

## 更多文档

- [插件开发指南](../docs/guides/plugin-development.md)
- [微内核架构](../docs/architecture/microkernel.md)
