import { declarableSchema } from './lib/schema.mjs';

class ToolTodo {
  name = 'tool-todo';
  version = '0.1.0';
  permissions = ['state'];
  provides = [{ name: 'tool.todo', removable: true }];
  cohesion = 'atomic';
  description = 'Session-level task list (create/update/list)';
  parameters = {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['create', 'update', 'list'], description: 'Operation' },
      tasks: { type: 'array', items: { type: 'string' }, description: 'Task descriptions (for create)' },
      id: { type: 'number', description: 'Task ID (for update)' },
      status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'], description: 'New status (for update)' },
    },
    required: ['op'],
  };

  async init(core) {
    this.core = core;
    // R0-123（多会话隔离）：任务清单**按会话分桶**。此前是一个进程级数组，而工具描述里
    // 写着 "Session-level task list" —— 实测两个会话看到的是同一份清单：A 建的待办
    // 会出现在 B 的上下文里，B 还能改掉 A 的状态。描述与实现必须一致。
    this._bySession = new Map();
    this._nextId = 1;
    core.registerCapability('tool.todo', {
      description: 'Session-level task list',
      handler: (args) => this.execute(args),
      // R0-152：只把内核**真能校验**的部分作为 input_schema（`parameters` 里的 enum/items
      // 等给模型看的约束不进校验层，否则注册会被 core 具名拒绝，工具直接装不上）。
      input_schema: declarableSchema(this.parameters),
      owner: 'tool-todo',
    });
  }

  execute(args) {
    try {
      const { op } = args;
      if (!op) throw Object.assign(new Error('Error: op is required'), { code: 'invalid_input', contractError: true });
      // 会话标识由执行器注入（`args._sessionId`）；直接调用（单测/脚本）时落到 default。
      const sid = String(args?._sessionId || 'default');
      let items = this._bySession.get(sid);
      if (!items) { items = []; this._bySession.set(sid, items); }

      if (op === 'create') {
        const { tasks = [] } = args;
        if (!tasks.length) throw Object.assign(new Error('Error: tasks array is required for create'), { code: 'invalid_input', contractError: true });
        const created = tasks.map(content => ({
          id: this._nextId++, status: 'pending', content,
        }));
        items.push(...created);
        return { items: [...items] };
      }

      if (op === 'update') {
        const { id, status } = args;
        if (!id || !status) throw Object.assign(new Error('Error: id and status are required for update'), { code: 'invalid_input', contractError: true });
        const item = items.find(i => i.id === id);
        if (!item) throw Object.assign(new Error(`Error: task ${id} not found`), { code: 'invalid_input', contractError: true });
        item.status = status;
        return { items: [...items] };
      }

      if (op === 'list') {
        return { items: [...items] };
      }

      throw Object.assign(new Error(`Error: unknown op "${op}"`), { code: 'invalid_input', contractError: true });
    } catch (err) {
      if (err?.contractError) throw err;   // 本契约的具名失败原样上抛；系统错误码（ENOENT 等）不在此列
      throw Object.assign(new Error(`Error: ${err.message}`), { code: 'resource_error', contractError: true });
    }
  }
}

export default new ToolTodo();
