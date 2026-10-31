import { spawn } from 'node:child_process';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { canonicalizePhysicalSync, isInsideReal } from './_lib/real-path.mjs';

class ToolsPlugin {
  name = 'tools';
  version = '0.3.0';
  // R0-156：这 5 个是**能力**（R0-155 之后由 `_registerBuiltinTools` 真的 registerCapability），
  // 不是服务。此前没标 `type` ⇒ `_providesOf` 把它们当 service，于是有人 require 'bash'
  // 会拿到"闸门说 OK、getService 返回 undefined"的假绿灯。
  provides = [
    { name: 'bash', type: 'capability', removable: true },
    { name: 'read', type: 'capability', removable: true },
    { name: 'write', type: 'capability', removable: true },
    { name: 'list', type: 'capability', removable: true },
    { name: 'stat', type: 'capability', removable: true },
  ];
  cohesion = 'atomic';
  permissions = ['fs.read', 'fs.write', 'net.outbound', 'env.read', 'process.spawn'];

  async init(core) {
    this.core = core;
    this.workDir = core.getData('agent.workDir') || core.get('agent.workDir') || process.cwd();
    this._env = { ...process.env, HOME: process.env.HOME };
    core.registerService('tools', this);
    await this._registerBuiltinTools();
  }

  async _registerBuiltinTools() {
    const tools = [
      { name: 'bash', description: 'Execute a bash command in a sandbox',
        parameters: { type: 'object', properties: { command: { type: 'string', description: 'The bash command to execute' } }, required: ['command'] },
        execute: (args) => this.execBash(args.command) },
      { name: 'read', description: 'Read the contents of a file',
        parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path relative to workspace' } }, required: ['path'] },
        execute: (args) => this.readFile(args.path) },
      { name: 'write', description: 'Write content to a file',
        parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path relative to workspace' }, content: { type: 'string', description: 'File content' } }, required: ['path', 'content'] },
        execute: (args) => this.writeFile(args.path, args.content) },
      { name: 'list', description: 'List files in a directory',
        parameters: { type: 'object', properties: { path: { type: 'string', description: 'Directory path relative to workspace' } }, required: ['path'] },
        execute: (args) => this.listDir(args.path) },
      { name: 'stat', description: 'Get file metadata (size, mtime, permissions)',
        parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path relative to workspace' } }, required: ['path'] },
        execute: (args) => this.statFile(args.path) },
    ];
    this._tools = new Map();
    for (const t of tools) {
      this._tools.set(t.name, t);
      // R0-155（v0.9.32 续）：**事件说"注册了"，能力表里却没有**。
      // 修前这里只 `emit('tool.registered')`，从不 `registerCapability` —— 实测：
      //     callCapability('bash')  → capabability_not_found
      //     实际能力表               → []
      // 而 `tool.registered` 事件照常发出，任何订阅它的界面/审计都会以为工具已就绪。
      // 这正是本项目反复修的"声明与执行分叉"，只是断在事件与注册表之间。
      // 修法：真的注册成能力。legacy 路径的语义是"兜底提供者"，它必须真的能提供。
      this.core.registerCapability(t.name, {
        description: t.description,
        handler: async (args) => t.execute(args),
        owner: 'tools',
        input_schema: { type: 'object', properties: t.parameters.properties, required: t.parameters.required },
      });
      this.core.emit('tool.registered', { ...t, timestamp: new Date().toISOString(), sourcePlugin: 'tools' });
    }
  }

  _logTool(toolName, args, result, duration) {
    this.core.emitFast('db.write', {
      table: 'tool_log',
      operation: 'insert',
      data: { tool: toolName, args: JSON.stringify(args), result: typeof result === 'string' ? result : '', duration: duration || 0 },
      timestamp: Date.now(),
      sourcePlugin: 'tools',
    });
  }

  async execBash(command) {
    const t0 = Date.now();
    return new Promise((resolve) => {
      const proc = spawn('bash', ['-c', command], {
        cwd: this.workDir, timeout: 30000, env: this._env,
      });
      let stdout = ''; let stderr = '';
      proc.stdout.on('data', (d) => stdout += d.toString());
      proc.stderr.on('data', (d) => stderr += d.toString());
      proc.on('error', (err) => { this._logTool('bash', { command }, `Error: ${err.message}`, Date.now() - t0); resolve(`Error: ${err.message}`); });
      proc.on('close', (code) => {
        const output = [stdout, stderr].filter(Boolean).join('\n');
        this._logTool('bash', { command }, output || `(exit ${code})`, Date.now() - t0);
        resolve(output || `(exit ${code})`);
      });
      setTimeout(() => { proc.kill(); this._logTool('bash', { command }, '(timeout: 30s)', 30000); resolve('(timeout: 30s)'); }, 30000);
    });
  }

  async readFile(path) {
    const t0 = Date.now();
    try {
      const fullPath = this._safePath(path);
      const result = await readFile(fullPath, 'utf8');
      this._logTool('read', { path }, `OK (${result.length} bytes)`, Date.now() - t0);
      return result;
    } catch (err) {
      this._logTool('read', { path }, `Error: ${err.message}`, Date.now() - t0);
      return `Error reading file: ${err.message}`;
    }
  }

  async writeFile(path, content) {
    const t0 = Date.now();
    try {
      const fullPath = this._safePath(path);
      await writeFile(fullPath, content, 'utf8');
      const result = `Written ${content.length} bytes to ${path}`;
      this._logTool('write', { path, bytes: content.length }, result, Date.now() - t0);
      return result;
    } catch (err) {
      this._logTool('write', { path }, `Error: ${err.message}`, Date.now() - t0);
      return `Error writing file: ${err.message}`;
    }
  }

  async listDir(path) {
    const t0 = Date.now();
    try {
      const fullPath = this._safePath(path);
      const entries = await readdir(fullPath, { withFileTypes: true });
      const result = entries.map(e => { const prefix = e.isDirectory() ? 'DIR ' : 'FILE '; return prefix + e.name; }).join('\n');
      this._logTool('list', { path }, `OK (${entries.length} entries)`, Date.now() - t0);
      return result;
    } catch (err) {
      this._logTool('list', { path }, `Error: ${err.message}`, Date.now() - t0);
      return `Error listing directory: ${err.message}`;
    }
  }

  async statFile(path) {
    const t0 = Date.now();
    try {
      const fullPath = this._safePath(path);
      const s = await stat(fullPath);
      const result = `size=${s.size} mode=${s.mode.toString(8)} mtime=${s.mtime.toISOString()}`;
      this._logTool('stat', { path }, result, Date.now() - t0);
      return result;
    } catch (err) {
      this._logTool('stat', { path }, `Error: ${err.message}`, Date.now() - t0);
      return `Error: ${err.message}`;
    }
  }

  // S1（v0.9.33）：这曾经是仓库里**第三份**路径判据。
  //
  // 事实：`plugins/tools/lib/workspace.mjs`（7 个文件工具 + Cell 产物复核）追 realpath；
  // `plugins/sandbox.js` 只做词法归一化；这里是第三条路 —— 用 `realpathSync` + **字符串前缀**
  // `real.startsWith(this.workDir + '/')`，而且"文件不存在"分支只检查父目录的**直接**父级，
  // `a/b/c` 里 `a` 是符号链接时它检查的是 `a/b`，逃逸点被跳过；父目录不存在时
  // `substring` 还会在 Windows 的 `\` 路径上切错。
  //
  // 三份实现 = 三个答案。现在统一走 `_lib/real-path.mjs` 那一份物理归一化，
  // 本方法只保留"必须落在 workDir 内"这一条策略与原来的同步签名
  //（这 5 个内建 handler 是同步调用点，改成异步会波及 tools.js 的整条接口）。
  //
  // 为什么用 `realpathSync` 而不是共享库的异步版：这五个工具的 handler 本来就在返回
  // Promise 之前同步取路径；改成异步要改 5 个 handler 的签名。库里的 `isInsideReal` 与
  // `nearestExisting` 是纯函数/纯 I/O，两边共用同一份**判断逻辑**，异步/同步只是取数方式。
  _safePath(path) {
    if (typeof path !== 'string' || path.length === 0) throw new Error('path is required');
    const root = resolve(this.workDir);
    const target = resolve(root, path);
    const rootReal = realpathSync(root);
    // H5：**悬空链接必须按链接目标判**。修前这里上溯到“最近已存在的祖先”就停下，
    // 而 `ws/vault -> /outside/new.txt`（目标不存在）会被判成“在工作区内”，
    // 随后的写入由内核跟随链接落到外面。改用共享库的**同步**版物理归一化：
    // 判断逻辑与异步版同一份，同步/异步只是取数方式（两者有逐例对照的判据）。
    const real = canonicalizePhysicalSync(target);
    if (!real) throw new Error('Path traversal not allowed');
    if (!isInsideReal(rootReal, real)) throw new Error('Path traversal not allowed');
    return target;
  }

  // ── E2 配套：公开访问器（`haotian-lite` 的 legacy 直连路径需要它） ──────────
  // 修前 `plugins/tools.js` 只有私有方法，外部只能读 `_tools` 私有 Map。
  // 这三个是那一层的最小公开面：**读**，不改变注册关系。
  get(name) { return this._tools.get(name) || null; }
  has(name) { return this._tools.has(name); }
  list() {
    return Array.from(this._tools.values()).map((t) => ({
      name: t.name, description: t.description || '',
      parameters: t.parameters || { type: 'object', properties: {} },
    }));
  }
}

export default new ToolsPlugin();
