# 命名规范

> 保持一致性，降低认知负担

## 文件命名

| 类型 | 规范 | 示例 |
|------|------|------|
| 插件 | kebab-case | `my-plugin.js` |
| 核心模块 | kebab-case | `plugin-manager.js` |
| 测试文件 | kebab-case + 后缀 | `my-plugin.test.mjs` / `my-plugin_smoke.mjs` |
| 场景文件 | kebab-case | `my-scene.json5` |
| 文档 | kebab-case | `my-guide.md` |

## 变量命名

| 类型 | 规范 | 示例 |
|------|------|------|
| 变量 | camelCase | `myVariable` |
| 函数 | camelCase | `myFunction()` |
| 类 | PascalCase | `MyClass` |
| 常量 | UPPER_SNAKE_CASE | `MY_CONSTANT` |
| 私有属性 | 下划线前缀 | `_privateVar` |

## 事件命名

格式：`source.action`（**必须含 `.`**，否则 `emit()` 具名拒绝）

```javascript
core.emit('chat.message', data);
core.emit('tool.executed', data);
core.emit('session.created', data);
```

内核自身发出的事件统一加 `core:` 前缀（同样含 `.`）：`core:plugin.loaded`、
`core:plugin.conflict`、`core:capability.denied`、`core:service.conflict`、
`core:plugin.unloaded` / `core:plugin.unloading`、`core:capability.invoked`、
`core:capability.conflict`。插件**不要**用 `core:` 前缀发自己的事件——那是内核事实的保留命名空间。

## 服务命名

格式：`kebab-case`，需要分组时用 `命名空间.名`（如 `kunxiansuo.local`、`llm.router`）。

```javascript
core.registerService('my-service', obj);
core.registerService('my-ns.local', obj);   // 分组形态
core.getService('my-service');
```

> 存量例外（历史原因，**不要**照抄，也不要依赖大小写转换去猜）：`archHealth`、`codeIndex`、
> `gitRepo`、`langParser`、`haotianPlanner` 等 camelCase 服务名。新代码一律用 kebab-case。

## 能力命名

格式：`命名空间.动作`（**不是** kebab-case 单词）——能力名是 `callCapability()` / `command()`
的路由键，点号即命名空间边界，懒加载也按它做前缀/精确匹配。

```javascript
core.registerCapability('chat.handle', { ... });     // 会话/对话
core.registerCapability('config.get', { ... });      // 配置
core.registerCapability('tool.bash', { ... });       // 工具（tool.<工具名>）
core.registerCapability('scene.switch', { ... });    // 场景
core.command('tool.bash', args);
```

动作部分用 camelCase 还是 kebab-case 由命名空间所有者决定（`tool.ast-parse` 与
`agent.submitTask` 并存），但**命名空间 + 点号**这一层是强制的。
