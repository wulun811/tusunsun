import { readdir } from 'node:fs/promises';
import { declarableSchema } from './lib/schema.mjs';
import { resolveWorkspacePath } from './lib/workspace.mjs';

class ToolList {
  name = 'tool-list';
  version = '0.5.0';
  permissions = ['fs.read'];
  provides = [{ name: 'tool.list', removable: true }];
  cohesion = 'atomic';
  description = 'List directory. Params: path (relative dir)';
  parameters = {
    type: 'object',
    properties: { path: { type: 'string', description: 'Relative dir, e.g. "src" or "."' } },
    required: ['path'],
  };

  async init(core) {
    this.core = core;
    core.registerCapability('tool.list', {
      description: 'List files in a directory',
      handler: (args) => this.execute(args),
      // R0-152：只把内核**真能校验**的部分作为 input_schema（`parameters` 里的 enum/items
      // 等给模型看的约束不进校验层，否则注册会被 core 具名拒绝，工具直接装不上）。
      input_schema: declarableSchema(this.parameters),
      owner: 'tool-list',
    });
  }

  async execute(args) {
    const workDir = this.core.getService?.('workspace')?.root(args?._sessionId) || this.core.getData('agent.workDir') || process.cwd(); // R0-124：会话根目录 > 进程默认
    try {
      const path = args.path;
      if (!path) throw Object.assign(new Error('Error: path is required'), { code: 'invalid_input', contractError: true });
      
      // R0-113（P0-02）：边界判定统一走 resolver
      const fullPath = await resolveWorkspacePath(workDir, path);
      const entries = await readdir(fullPath, { withFileTypes: true });
      const MAX_ENTRIES = 10000;
      const sliced = entries.slice(0, MAX_ENTRIES);
      let result = sliced.map(e => {
        const prefix = e.isDirectory() ? 'DIR ' : 'FILE ';
        return prefix + e.name;
      }).join('\n');
      if (entries.length > MAX_ENTRIES) result += `\n... (${entries.length - MAX_ENTRIES} more entries)`;
      return result;
    } catch (err) {
      if (err?.contractError) throw err;   // 本契约的具名失败原样上抛；系统错误码（ENOENT 等）不在此列
      throw Object.assign(new Error(`Error listing directory: ${err.message}`), { code: 'resource_error', contractError: true });
    }
  }
}

export default new ToolList();
