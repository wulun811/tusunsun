# 插件开发指南

> 土行孙的核心是微内核 + 插件架构。所有功能都是插件。

## 最简插件

```javascript
// plugins/hello.js
export default {
  name: 'hello',
  version: '1.0.0',

  async init(core) {
    this.core = core;
    core.log('info', 'Hello plugin loaded!');
  },

  async start() {
    this.core.log('info', 'Hello plugin started!');
  },

  async stop() {
    this.core.log('info', 'Hello plugin stopped!');
  }
};
```

放入 `plugins/` 后，还需在所用场景的 `eager` 中声明 `"hello"` 并重启。目录发现不等于默认装配；对象字面量插件也不应依赖静态提取器自动生成懒加载索引。

## 插件生命周期

```
init() → start() → [运行中] → stop()
```

### init(core)

- 初始化阶段，注册服务和能力
- `core` 是微内核实例，提供事件总线、命令总线等

### start()

- 启动阶段，开始工作
- 不要假设所有可选/懒加载插件已初始化；只依赖显式 requires 和所用场景保证的服务

### stop()

- 停止阶段，清理资源
- 必须释放所有定时器、连接等

## Core API

### 日志

```javascript
core.log('info', 'message');
core.log('warn', 'warning');
core.log('error', 'error message');
core.log('debug', 'debug info');
```

### 事件总线

```javascript
// 监听事件
core.on('chat.message', (data) => {
  console.log(data);
});

// 发送事件
core.emit('my-plugin.event', { key: 'value' });

// 快速发送（跳过验证）
core.emitFast('my-plugin.event', { key: 'value' });
```

事件名必须包含 `.`（如 `my-plugin.event`）。

### 服务注册

```javascript
// 注册服务
core.registerService('my-service', this);

// 获取服务
const svc = core.getService('my-service');
```

### 能力注册

```javascript
// 注册能力
core.registerCapability('example.run', {
  description: 'My capability',
  handler: (args) => this.handle(args),
  owner: 'my-plugin',
});

// 调用能力
const result = await core.command('example.run', { key: 'value' });
```

### 命令总线

```javascript
// 调用命令
const result = await core.command('chat.handle', {
  message: 'hello',
  sessionId: 'test',
});
```

## 中间件

```javascript
// 注册中间件
core.use('inbound', (msg) => {
  // 修改消息
  msg.extra = 'data';
  return msg; // 返回修改后的消息
  // 返回 false 阻止消息
});
```

## 监听器所有权

```javascript
core.on('example.changed', handler, { owner: 'my-plugin' });

// 插件卸载时自动清理
core.offByOwner('my-plugin');
```

## 配置读取

```javascript
const config = core.getService('config');
const value = config.get('my-plugin.setting');
```

## 完整示例

```javascript
// plugins/counter.js
export default {
  name: 'counter',
  version: '1.0.0',

  async init(core) {
    this.core = core;
    this.count = 0;

    // 注册能力
    core.registerCapability('counter.increment', {
      description: 'Increment counter',
      handler: () => this.increment(),
      owner: 'counter',
    });

    core.registerCapability('counter.get', {
      description: 'Get counter value',
      handler: () => ({ count: this.count }),
      owner: 'counter',
    });

    // 注册服务
    core.registerService('counter', this);
  },

  increment() {
    this.count++;
    this.core.emit('counter.changed', { count: this.count });
    return { count: this.count };
  },

  async stop() {
    this.count = 0;
  }
};
```

## 开发规范

- 使用 ES Modules（`import`/`export`）
- 使用 `async/await` 处理异步
- 错误处理使用 try-catch，不吞异常
- 命名：camelCase（变量/函数），kebab-case（文件名）
- 文件名即插件名：`my-plugin.js` → `name: 'my-plugin'`


## 模型适配与服务依赖

`getService()` 是同步读取，不能自行触发 lazy 插件加载。必须在消费者初始化前准备好的服务应放在场景 `eager`，并声明相应依赖；只有能力调用命中索引时才会触发能力插件懒加载。

替换默认模型实现时参考 `plugins/model-openai.js` 及 `plugins/haotian-lite.js` 的调用点：除了 `call()`，默认消费者还使用 `getModel()`、`callWithConfig()`、流式调用及工具结果形状。仅注册一个返回固定文本的 `call()` 示例不构成可替换适配器。其他提供方协议需要适配并用 mock 与真实端点分别验证。

运行时插件错误处理与卸载流程不提供 OS 隔离；不要加载不可信插件。状态持久化钩子也不等于任务副作用可恢复。
