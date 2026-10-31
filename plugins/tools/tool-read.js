import { readFile, stat } from 'node:fs/promises';
import { declarableSchema } from './lib/schema.mjs';
import { resolveWorkspacePath } from './lib/workspace.mjs';
import { detectLanguage } from './lib/detect-language.mjs';

class ToolRead {
  name = 'tool-read';
  version = '0.6.0';
  permissions = ['fs.read'];
  provides = [{ name: 'tool.read', removable: true }];
  tags = ['filesystem.read'];
  output_schema = { type: 'string', description: 'File contents (paginated by lines)' };
  perf = { avg_latency_ms: 50, p99_latency_ms: 500 };
  cohesion = 'atomic';
  description = 'Read file (paginated). First call without offset returns first N lines. Use offset to continue.';
  parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path, e.g. "src/main.py"' },
      offset: { type: 'number', description: 'Line number to start from (0-indexed, default: 0)', default: 0 },
      limit: { type: 'number', description: 'Lines to return (max: 1500, default: 200) — 按需取，别一次拉全文' },
    },
    // R0-147：`limit` **不该是必填**。代码里已经有默认值，把它声明成 required 是在对模型
    // 撒谎（模型会以为不传就失败，于是被迫瞎猜一个数字）。真正的问题是修前它缺省时
    // 走成 `NaN` → 返回空内容且不报错 —— 那是取值 bug，不是"必须传"的证据。
    required: ['path'],
  };

  async init(core) {
    this.core = core;
    core.registerCapability('tool.read', {
      description: 'Read the contents of a file (paginated by lines)',
      handler: (args) => this.execute(args),
      // R0-152：只把内核**真能校验**的部分作为 input_schema（`parameters` 里的 enum/items
      // 等给模型看的约束不进校验层，否则注册会被 core 具名拒绝，工具直接装不上）。
      input_schema: declarableSchema(this.parameters),
      owner: 'tool-read',
    });
  }

  async execute(args) {
    const workDir = this.core.getService?.('workspace')?.root(args?._sessionId) || this.core.getData('agent.workDir') || process.cwd(); // R0-124：会话根目录 > 进程默认
    try {
      const path = args.path;
      if (!path) throw Object.assign(new Error('Error: path is required'), { code: 'invalid_input', contractError: true });

      // R0-113（P0-02）：边界判定统一走 resolver（前缀碰撞 / 符号链接 / `..` 逃逸一律拒绝）
      const fullPath = await resolveWorkspacePath(workDir, path);

      const s = await stat(fullPath);
      if (s.size > 5 * 1024 * 1024) {
        throw Object.assign(new Error(`Error: file too large (${(s.size / 1024 / 1024).toFixed(1)}MB > 5MB limit)`), { code: 'resource_error', contractError: true });
      }

      const content = await readFile(fullPath, 'utf8');
      const lines = content.split('\n');
      const totalLines = lines.length;

      // R0-147：`args.limit` 缺失时 `Math.max(1, undefined)` 是 **NaN**，而 `slice(0, NaN)`
      // 返回**空数组** —— 于是"没传 limit"会被读成"这个文件是空的"，而且**不报错**。
      // 实测：不传 limit 读一个 5 行文件 → 返回 0 行内容、`ok:true`。模型据此认为文件为空，
      // 接着基于这个错误认知继续干活（改错文件、重写已有内容）。这比报错糟得多。
      // 现在给它一个显式默认值；`required: ['path','limit']` 仍然生效，
      // 所以经 capacity 门进来时缺 limit 会被 schema 直接拒（信息更清楚），
      // 而这条默认值保证**绕过 schema 的直连调用**（工具自测、嵌入宿主）也不会静默出错。
      const DEFAULT_LIMIT_LINES = 200;   // 与提示词里"主动思考需要多少行"并存：这是兜底，不是鼓励省略
      const offsetRaw = Number(args.offset);
      const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;
      const limitRaw = Number(args.limit);
      const limit = Number.isFinite(limitRaw) && limitRaw >= 1 ? Math.min(Math.floor(limitRaw), 1500) : DEFAULT_LIMIT_LINES;

      if (offset >= totalLines) {
        return `--- ${path} (end, ${totalLines} lines total) ---\n\nFile has ${totalLines} lines. offset=${offset} is past end. Use offset=0 to start over.`;
      }

      const selected = lines.slice(offset, offset + limit);
      const endLine = Math.min(offset + limit, totalLines);
      const shown = endLine - offset;

      const langTag = detectLanguage(path)
      const langPart = langTag ? ` [${langTag}]` : ''
      const header = `--- ${path}${langPart} (${totalLines} lines) lines ${offset + 1}-${endLine} ---`;
      const body = selected.join('\n');
      let footer = '';

      if (endLine < totalLines) {
        footer = `\n--- ${path}: ${shown}/${totalLines} lines shown. Use tool-read with offset=${endLine} to continue ---`;
      } else {
        footer = `\n--- ${path}: all ${totalLines} lines shown ---`;
      }

      return header + '\n' + body + footer;
    } catch (err) {
      if (err?.contractError) throw err;   // 本契约的具名失败原样上抛；系统错误码（ENOENT 等）不在此列
      throw Object.assign(new Error(`Error reading file: ${err.message}`), { code: 'resource_error', contractError: true });
    }
  }
}

export default new ToolRead();
