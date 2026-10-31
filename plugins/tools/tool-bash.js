import { spawn } from 'node:child_process';
import { declarableSchema } from './lib/schema.mjs';
import { matchDangerousCommand } from '../_lib/danger-patterns.js';

// 执行结果信封：权威状态 = **真实进程退出事实**（exitCode / signal / spawn 错误 / 自家超时），
// stdout/stderr 只作数据，不用来推断退出结果；`result` 是 LLM 可见的合并文本。
// 超时与 shell 目标是受信宿主配置 / 测试 seam，不是调用方可传参。
const DEFAULT_TIMEOUT_MS = 30000;
const HARD_MAX_TIMEOUT_MS = 300000;   // 宿主配置上限：任何配置都不得绕过资源限制
const MAX_OUT = 256 * 1024;

class ToolBash {
  name = 'tool-bash';
  version = '0.5.0';
  permissions = ['process.spawn', 'env.read'];
  provides = [{ name: 'tool.bash', removable: true }];
  tags = ['system.execute', 'shell'];
  output_schema = {
    type: 'object',
    description: '执行结果信封：{ result(合并文本，供 LLM，与旧字符串输出逐字节一致), ok, state, code, exitCode, stdout, stderr }',
  };
  perf = { avg_latency_ms: 200, p99_latency_ms: 5000 };
  cohesion = 'atomic';
  description = 'Run bash command. Params: command (shell command text)';
  parameters = {
    type: 'object',
    properties: { command: { type: 'string', description: 'The shell command to execute' } },
    required: ['command'],
  };

  async init(core) {
    this.core = core;
    this._env = { ...process.env, HOME: process.env.HOME };
    core.registerCapability('tool.bash', {
      description: 'Execute a bash command',
      handler: (args) => this.execute(args),
      // R0-152：只把内核**真能校验**的部分作为 input_schema（`parameters` 里的 enum/items
      // 等给模型看的约束不进校验层，否则注册会被 core 具名拒绝，工具直接装不上）。
      input_schema: declarableSchema(this.parameters),
      owner: 'tool-bash',
    });
  }

  async execute(args) {
    // 会话根目录 > 进程默认：同一进程里的多个会话各有自己的相对路径基准。
    const workDir = this.core.getService?.('workspace')?.root(args?._sessionId) || this.core.getData('agent.workDir') || process.cwd();
    // **只认 `command`**：这是唯一的命令入口。别名会让判据与执行读到不同的值，
    // 即便有人绕过执行器直调 `execute()`，口径也不能分叉。
    const command = args?.command;
    // 空/非字符串命令给**具名拒绝**，不能落成 `bash -c undefined`（那会得到 127 的假执行结果）。
    if (typeof command !== 'string' || command.trim() === '') {
      return {
        result: 'Error: tool-bash requires a non-empty "command" string.',
        ok: false, state: 'failed', code: 'invalid_input',
        exitCode: null, stdout: '', stderr: '',
      };
    }
    // 读围栏 + 外联判据：执行器/护栏缺席时这里是最后一道。
    // 判据看**路径目标**（展开 ~/$HOME、追 realpath），不是只看文件名；cwd 用本会话根。
    const policyHit = matchDangerousCommand(command, { cwd: workDir });
    if (policyHit) {
      return {
        result: `Error: command blocked by safety policy: ${policyHit.why}`,
        ok: false, state: 'failed', code: 'Y024',
        exitCode: null, stdout: '', stderr: '',
      };
    }
    // 受信宿主配置（非调用方参数）：超时受 HARD_MAX 夹取；shell 目标缺省 bash。
    const cfgTimeout = Number(this.core.get?.('tools.bashTimeoutMs'));
    const timeoutMs = Math.min(Number.isFinite(cfgTimeout) && cfgTimeout > 0 ? cfgTimeout : DEFAULT_TIMEOUT_MS, HARD_MAX_TIMEOUT_MS);
    const shell = this.core.get?.('tools.bashShell') || 'bash';

    return new Promise((resolve) => {
      let stdout = '', stderr = '';
      let done = false;
      let timer = null;   // 先声明再注册监听：finish 引用 timer，避免 TDZ。
      const finish = (env) => {
        if (done) return;                    // 至多完成一次：迟到的 close 不得覆盖超时/spawn 错误
        done = true;
        if (timer) clearTimeout(timer);
        resolve(env);
      };
      const okEnv = (text, exitCode) => ({ result: text, ok: true, state: 'succeeded', code: null, exitCode, stdout, stderr });
      const failEnv = (text, code, exitCode = null) => ({ result: text, ok: false, state: 'failed', code, exitCode, stdout, stderr });

      let proc;
      try {
        proc = spawn(shell, ['-c', command], { cwd: workDir, env: this._env });
      } catch (err) {
        return finish(failEnv(`Error: ${err.message}`, 'spawn_error'));
      }
      proc.stdout.on('data', (d) => { if (stdout.length < MAX_OUT) stdout += d.toString(); });
      proc.stderr.on('data', (d) => { if (stderr.length < MAX_OUT) stderr += d.toString(); });
      proc.on('error', (err) => finish(failEnv(`Error: ${err.message}`, 'spawn_error')));
      proc.on('close', (code, signal) => {
        // LLM 可见文本：stdout/stderr 合并；没有输出时给退出码占位。
        const text = [stdout, stderr].filter(Boolean).join('\n') || `(exit ${code})`;
        if (signal || code === null) return finish(failEnv(text, 'terminated_by_signal', code));
        if (code === 0) return finish(okEnv(text, 0));
        return finish(failEnv(text, 'nonzero_exit', code));
      });
      timer = setTimeout(() => {
        try { proc.kill(); } catch { /* 已退出 */ }
        // 默认 30s 时文案逐字为 "(timeout: 30s)"；短超时仅用于受控测试 seam。
        finish(failEnv(`(timeout: ${Math.round(timeoutMs / 1000)}s)`, 'timeout'));
      }, timeoutMs);
    });
  }
}

export default new ToolBash();
