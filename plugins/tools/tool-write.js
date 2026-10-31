import { writeFile } from 'node:fs/promises';
import { declarableSchema } from './lib/schema.mjs';
import { resolveWorkspacePath } from './lib/workspace.mjs';
import { pickPath } from '../_lib/tool-path-args.mjs';
// A0（v0.9.33）：Action Receipt v0 —— 只用它的"读回核算"与"形状校验"，
// 不引入任何撤销能力（本版 recovery.supported 恒为 false）。
import { buildReceipt, readBack, sha256Hex, summarizeReceipt } from '../_lib/action-receipt.mjs';
// AR-C01（v0.10.3）：回执按**调用**交付，不挂在实例字段上（见 publishReceipt 的注释）。
import { publishReceipt, currentSession, currentCall } from '../_lib/call-context.mjs';

class ToolWrite {
  name = 'tool-write';
  version = '0.5.0';
  permissions = ['fs.write'];
  provides = [{ name: 'tool.write', removable: true }];
  tags = ['filesystem.write'];
  output_schema = {
    type: 'string',
    description: 'Written N bytes to path',
  };
  perf = { avg_latency_ms: 30, p99_latency_ms: 200 };
  cohesion = 'atomic';
  description = 'Write file. Params: path (relative path), content (file text)';
  parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path from workspace, e.g. "file.txt"' },
      // R0-149（v0.9.32 续）：**代码接受的别名必须出现在声明里**。
      // 修前 `execute` 认 `path | file_path | filePath` 三种写法，但 `parameters` 只声明了 `path`
      // 且 `required: ['path']` —— R0-145 让声明生效之后，**别名全部变成死代码**：
      // 实测 `{file_path:'a.txt', content:'x'}` → `缺少必填参数 'path'`，文件没写出来。
      // 这类"支持两种写法"的宽松本身就是历史包袱，但既然代码明确接受，声明就不能比它更窄
      // （否则"文档说支持"与"实际支持"再次分叉，正是本项目反复修的形态）。
      // 注：三者**不同时 required** —— 它们互为别名，只要求至少一个。core 的
      // `_schemaViolation` 只支持 required/type，没有 oneOf，故这里靠工具自己兜底
      // （见 `execute` 开头的 `if (!path)`），声明只负责"别把合法的别名挡在门外"。
      file_path: { type: 'string', description: 'Alias of path (legacy)' },
      filePath: { type: 'string', description: 'Alias of path (legacy)' },
      content: { type: 'string', description: 'File content to write' },
      file_content: { type: 'string', description: 'Alias of content (legacy)' },
      contents: { type: 'string', description: 'Alias of content (legacy)' },
    },
    required: [],
  };

  async init(core) {
    this.core = core;
    core.registerCapability('tool.write', {
      description: 'Write content to a file',
      handler: (args) => this.execute(args),
      // R0-152：只把内核**真能校验**的部分作为 input_schema（`parameters` 里的 enum/items
      // 等给模型看的约束不进校验层，否则注册会被 core 具名拒绝，工具直接装不上）。
      input_schema: declarableSchema(this.parameters),
      owner: 'tool-write',
    });
  }

  async execute(args) {
    const workDir = this.core.getService?.('workspace')?.root(args?._sessionId) || this.core.getData('agent.workDir') || process.cwd(); // R0-124：会话根目录 > 进程默认
    try {
      // AR-C06（v0.11.0）：取值顺序搬进 `_lib/tool-path-args.mjs` 的 `pickPath()`，
      // 围栏（边界 / 敏感路径 / 写前必读）与执行侧从此读**同一个函数**。
      // 修前执行侧认 `path|file_path|filePath`，围栏只认 `path|file` ——
      // 判据读的名字 ≠ 执行读的名字（AR-C05 的同一形状，这是第二次）。
      const path = pickPath(args);
      // R0-146：**空字符串是合法的文件内容**。修前这里是 `args.content || args.file_content || …`，
      // `||` 把 `''` 当成假值 ⇒ 落到 `undefined` ⇒ 报 `"content" missing`。
      // 后果：`tool-write` **永远无法写空文件**（`> file` 截断成空、创建占位文件都会失败），
      // 而模型看到的错误是"你忘了传 content"——它确实传了，只是内容是空的。
      // 这不是 schema 的问题（`required` 判的是 `=== undefined`），是取值运算符用错了。
      const pick = (v) => (v === undefined || v === null ? undefined : v);
      const content = pick(args.content) ?? pick(args.file_content) ?? args.contents;
      
      if (!path) {
        throw Object.assign(new Error('Error: "path" missing. Use {"path":"file.txt","content":"..."}'), { code: 'invalid_input', contractError: true });
      }
      if (content === undefined) {
        throw Object.assign(new Error('Error: "content" missing. Use {"path":"file.txt","content":"..."}'), { code: 'invalid_input', contractError: true });
      }
      
      // R0-113（专家评审 P0-02）：工作区判定统一走 `resolveWorkspacePath` —— `relative()`
      // 判真正的目录包含关系，并对符号链接追一次 realpath。旧的 `startsWith(workDir)`
      // 会把同级 `workspace_evil/` 当成工作区内（前缀碰撞）⇒ 真实工具链可越界写入。
      const fullPath = await resolveWorkspacePath(workDir, path);

      // ── A0（v0.9.33）：写前取 before 事实，写后**读回**取 after 事实 ──────────
      // 两者都必须来自文件系统。`before_sha256` 若取不到就填 null 并注明，
      // **不能**用"我打算写的内容"反推 before —— 那是编造。
      const before = await readBack(fullPath);

      await writeFile(fullPath, content, 'utf8');

      // 读回：`after_sha256` 必须是磁盘现状。写成功但读回失败时标 indeterminate，
      // 不拿 `sha256(content)` 冒充 —— 那正是计划书 A2 禁止的"用预期值冒充已应用结果"。
      const after = await readBack(fullPath);
      const intended = sha256Hex(Buffer.from(content, 'utf8'));
      const application = !after.exists ? 'indeterminate' : 'applied';
      const changed = before.exists && after.exists
        ? after.bytes - before.bytes
        : (after.exists ? after.bytes : null);

      const built = buildReceipt({
        tool_id: 'tool.write',
        // AR-C03（v0.10.3）：归因字段**不再从 args 取**。
        //
        // 修前是 `cell_id: args?._cellId ?? null` 等三行，而 args 是模型给的 JSON。
        // 实测模型传 `_cellId:'cell-FORGED'` 后，回执里就写着 `cell_id:'cell-FORGED'` ——
        // 于是回执的**归因部分**由被回执描述的那次动作自己填写。这不是证据，是自述。
        //
        // 现在的口径：执行器在入口剥掉所有模型自报的 `_` 前缀控制字段（见 `_executeOneV2`），
        // 并且**目前没有**任何可信的 Cell 归因通道，所以这里如实填 `null`。
        // 宁可空着，也不填一个来源不明的值 —— 这是计划书 A2「不用预期值冒充已应用结果」
        // 在归因维度上的同一句话。未来接上可信通道（Cell 把 incarnation/task 钉进
        // 调用上下文）后，这三行才该有值。
        cell_id: null,
        incarnation_id: null,
        task_id: null,
        attempt: null,
        application,
        target: { path, canonical_scope: 'cell_workspace' },
        effect: {
          kind: before.exists ? 'file_modified' : 'file_created',
          before_sha256: before.sha256,
          after_sha256: after.sha256,
          changed_bytes: changed,
          created: !before.exists,
          detail_ref: null,
        },
        // 与应用状态**分离**：写完不做独立验证，就如实写 not_run。
        verification: 'not_run',
        // 本版没有备份与条件检查 ⇒ **不得**标 true。原生写盘不可撤销。
        recovery: { supported: false, ref: null },
        // 回执当前只随返回值返回，不落盘 ⇒ 如实标 volatile，不谎称审计永久可靠。
        persistence: 'volatile',
      });

      // 读回的内容与"我要写的"不一致 ⇒ 磁盘上现在不是我以为的东西，这是 indeterminate。
      if (built.ok && intended !== after.sha256 && after.exists) {
        built.receipt.application = 'indeterminate';
        built.receipt.effect.mismatch = 'disk content differs from the bytes this call intended to write '
          + '(concurrent writer, or a filesystem that transformed the payload)';
      }

      // 旧输出**保持不变**（不变量：无回执模式下模型看到的文本字节不变）。
      //
      // AR-C01（v0.10.3）：回执**不再挂在本实例上**。修前这里写 `this._lastReceipt = ...`，
      // 而工具实例是单例（`export default new ToolWrite()`）——两个会话并发时，
      // 执行器读到的"最近一次回执"可能是**另一次调用**的。实测：A 写 a.txt 成功后，
      // 返回的附注是 `act-mvjmp6kx-2 / 新建 b.txt`（B 那次的），两个会话拿到同一个 id。
      // 现在回执投进**本次调用**的上下文（`AsyncLocalStorage`），并发天然隔离；
      // 不在工具链上直接调 `execute()`（单测/脚本）时 publish 返回 false，行为与修前一致。
      const published = publishReceipt(built.ok ? built.receipt : null);
      if (!built.ok) {
        // 回执自洽性没通过：这是**我自己**的 bug（不是用户的），必须可见。
        this.core?.log?.('warn', `[tool-write] receipt rejected: ${built.violations?.join('; ')}`);
      }
      if (!published) {
        // 不在工具执行链上（单测/脚本**直接**调 `execute()`）：没有可信调用上下文，
        // 回执无处可投。此时留一份**仅供这类直调方**读取的副本。
        //
        // 为什么这个副本不会重演 AR-C01：执行器**从不读它**（只读 ALS 里的那份），
        // 所以它只影响"没有执行器参与"的调用。真链路上 `published` 恒为 true，
        // 这个字段就恒为 null —— 它不可能是并发串台的来源。
        // 结构判据见 `test-ar-c01-c02-.../AR-C01/5`：执行器侧不得出现该字段名。
        this._directCallReceipt = built.ok ? built.receipt : null;
      }
      this.core?.emitFast?.('tool.action_receipt', {
        // AR-C01：事件里的标识也取**本次**回执，不再有"实例上那个"这个来源。
        tool: 'tool.write', action_id: built.ok ? built.receipt.action_id : null,
        application: built.ok ? built.receipt.application : null,
        path, timestamp: Date.now(), sourcePlugin: 'tool-write',
      });
      return `Written ${content.length} bytes to ${path}`;
    } catch (err) {
      if (err?.contractError) throw err;   // 本契约的具名失败原样上抛；系统错误码（ENOENT 等）不在此列
      throw Object.assign(new Error(`Error writing file: ${err.message}`), { code: 'resource_error', contractError: true });
    }
  }
}

export default new ToolWrite();
