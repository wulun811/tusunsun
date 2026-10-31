# 工具开发规范

工具是模型可调用的执行代码。当前工具加载器读取插件顶层的 `name`、`description`、`parameters`；不读取一个嵌套 `schema` 字段作为模型工具定义。

## 最小工具形状

```javascript
// plugins/tools/tool-my-tool.js
class MyTool {
  name = 'tool-my-tool';
  version = '1.0.0';
  description = 'Process a short text input';
  parameters = {
    type: 'object',
    properties: { input: { type: 'string', description: 'Text to process' } },
    required: ['input'],
  };
  provides = [{ name: 'tool.my-tool', removable: true }];

  async init(core) {
    this.core = core;
    core.registerCapability('tool.my-tool', {
      description: this.description,
      handler: (args) => this.execute(args),
      owner: this.name,
    });
  }

  async execute({ input }) {
    if (typeof input !== 'string') throw new Error('input must be a string');
    return `Processed: ${input}`;
  }
}
export default new MyTool();
```

工具文件以 `tool-` 开头，支持 `.js` / `.mjs`。`tool-loader` 从 `plugins/tools/` 建索引；正常插件能力装配则依赖场景清单与 `provides`，两条加载路径要分别理解。参考现有 `tool-read.js` 和 `tool-write.js` 的真实参数、初始化与边界处理。

## 参数、权限与结果

- `parameters` 是 JSON Schema，必须同时做执行期输入检查；不能只相信模型符合 schema。
- 自定义文件操作复用 `plugins/tools/lib/workspace.mjs` 的解析器（在工具目录内可 `import { resolveWorkspacePath } from './lib/workspace.mjs'`）。它要求工作区相对路径，拒绝绝对路径、目录越界和已覆盖的符号链接逃逸。
- 参数读取用 `this.core.getService?.('workspace')?.root?.(args?._sessionId) || this.core.getData('agent.workDir') || process.cwd()`；不要另造一个默认目录。第一项是**本会话声明的根目录**（R0-124），漏掉它会让工具无视会话级工作目录、把文件写到别的项目里去；执行器会把会话标识放在 `args._sessionId` 里下发（与 `args._tcId` 同一套下划线前缀的控制字段）。带副作用操作须检查实际落盘/外部结果。
- 工具权限声明与风险元数据取决于消费者，不能仅加一个 `risk: 'read'` 就当已获得沙箱或强制只读；进程继承宿主用户权限。
- 保持成功/失败形状与所用执行器一致。契约错误可抛带 `contractError`、`code` 的错误，避免把错误字符串当成功；现有执行器和工具同时存在兼容形状，接入前应验证。
- 定时器、连接和子进程必须在 `stop()` 清理；不要在 import 顶层执行危险操作，索引阶段可能导入模块读取元数据。

## 最小单测

```javascript
// test/tool-my-tool.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import tool from '../plugins/tools/tool-my-tool.js';

test('tool-my-tool processes input and rejects wrong types', async () => {
  assert.equal(await tool.execute({ input: 'test' }), 'Processed: test');
  await assert.rejects(() => tool.execute({ input: null }));
});
```

运行 `node --test test/tool-my-tool.test.mjs`。本仓聚合 unit runner 使用 `setup(runner)` / default 注册约定，不能把这种 node:test 文件直接放进 `test/unit/` 就认定已纳入聚合。

完整接入还应验证：模型看到的工具 schema、真实工具调用、返回模型的结果、失败路径和停止清理。单测一个 `execute()` 不代表已完成模型→工具端到端验收。
