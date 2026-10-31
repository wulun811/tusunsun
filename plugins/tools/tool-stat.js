import { stat } from 'node:fs/promises';
import { declarableSchema } from './lib/schema.mjs';
import { resolveWorkspacePath } from './lib/workspace.mjs';

class ToolStat {
  name = 'tool-stat';
  version = '0.5.0';
  permissions = ['fs.read'];
  provides = [{ name: 'tool.stat', removable: true }];
  cohesion = 'atomic';
  description = 'Get file metadata (size, mtime, permissions). IMPORTANT: path must be RELATIVE to workspace.';
  parameters = {
    type: 'object',
    properties: { path: { type: 'string', description: 'RELATIVE file path from workspace' } },
    required: ['path'],
  };

  async init(core) {
    this.core = core;
    core.registerCapability('tool.stat', {
      description: 'Get file metadata (size, mtime, permissions)',
      handler: (args) => this.execute(args),
      // R0-152：只把内核**真能校验**的部分作为 input_schema（`parameters` 里的 enum/items
      // 等给模型看的约束不进校验层，否则注册会被 core 具名拒绝，工具直接装不上）。
      input_schema: declarableSchema(this.parameters),
      owner: 'tool-stat',
    });
  }

  async execute(args) {
    const workDir = this.core.getService?.('workspace')?.root(args?._sessionId) || this.core.getData('agent.workDir') || process.cwd(); // R0-124：会话根目录 > 进程默认
    try {
      const path = args.path;
      if (!path) throw Object.assign(new Error('Error: path is required'), { code: 'invalid_input', contractError: true });
      
      // R0-113（P0-02）：边界判定统一走 resolver
      const fullPath = await resolveWorkspacePath(workDir, path);
      const s = await stat(fullPath);
      return `size=${s.size} mode=${s.mode.toString(8)} mtime=${s.mtime.toISOString()}`;
    } catch (err) {
      if (err?.contractError) throw err;   // 本契约的具名失败原样上抛；系统错误码（ENOENT 等）不在此列
      throw Object.assign(new Error(`Error: ${err.message}`), { code: 'resource_error', contractError: true });
    }
  }
}

export default new ToolStat();
