import { fork } from 'node:child_process';
import { isAbsolute, resolve as joinAbsolute } from 'node:path';
// S1 / R0-159：路径判据**不再自己写一份**，复用 `plugins/_lib/real-path.mjs`。
// 那里同时被工具层用着，于是"沙箱追不追 realpath"不再是可以各自漂移的两个答案。
import { canonicalizePath, isInsideReal } from './_lib/real-path.mjs';
// 敏感路径判据与 workspace / bash / file-guard 共用一份：名单分叉时，
// 同一份密钥会在“声明工作区”处被拦、在“读文件”处放行。
import { isSensitivePath } from './_lib/sensitive-paths.js';

class SandboxPlugin {
  name = 'sandbox';
  version = '0.4.0';
  manifest = {
    schema_version: 'tusunsun.plugin/v2',
    name: 'sandbox',
    version: '0.4.0',
    api_version: '1',
    owner: 'platform',
    provides: [{ service: 'sandbox', api_version: '1.0.0' }],
    requires: [],
    surfaces: ['internal'],
    degraded_policy: 'block_startup', // 安全关键：production 不允许放宽式降级
  };
  permissions = ['process.spawn', 'fs.read', 'fs.write'];
  // R0-156：服务是 `sandbox`（见下文 registerService），这两个是**策略档位**不是 provider。
  // 标成 capability 以免被 `_providesOf` 当成 service（那样 require 'sandbox.yellow' 会假绿灯）。
  provides = [
    { name: 'sandbox', type: 'service', removable: false },
    { name: 'sandbox.yellow', type: 'capability', removable: true },
    { name: 'sandbox.green', type: 'capability', removable: false },
  ];

  constructor() {
    this._children = new Map();
    this._seq = 0;
    this._pending = new Map();
    // S3 / R0-161：两个只增不用的结构，用来**如实留痕**而不是掩盖。
    // `_abandoned` 记"我们不再等的请求"，`_lateResults` 记"在收束之后才回来的回复"。
    // 它们存在的理由：修前超时后监听器不摘，迟到的回复会被广播成 `sandbox.result`，
    // 等于让一个已经超时的请求"稍后自己变成成功"。现在迟到的东西只进这里 + 一条事件。
    this._abandoned = new Map();
    this._lateResults = [];
    // S1：`init` 之前也要有**安全**的默认值 —— `_guard` 现在可能在 init 之前被单测直接调用，
    // 一个 undefined 的 `_deny` 会让 `for...of` 抛错，而抛错比"拒绝"更接近放行。
    // 这里给的是与 `init` 相同的 fail-closed 缺省，而不是空数组。
    this._deny = ['/etc', '/sys', '/proc', `${process.env.HOME}/.ssh`];
    this._readAllow = [];
    this._writeAllow = [];
    this._bashAllowlist = [];
    this._workDir = null;
    this._timeout = 30000;
  }

  async init(core) {
    this.core = core;
    core.registerService('sandbox', this);

    this._readAllow = core.get('sandbox.readAllow') || [];
    this._writeAllow = core.get('sandbox.writeAllow') || [];
    this._deny = core.get('sandbox.deny') || ['/etc', '/sys', '/proc', `${process.env.HOME}/.ssh`];
    this._bashAllowlist = core.get('sandbox.bashAllowlist') || [];
    this._timeout = core.get('sandbox.timeout') || 30000;
    this._memoryLimit = core.get('sandbox.memoryLimit') || 128;
    // S1：相对路径的解析基准。**不**回落到 `process.cwd()` —— 父/子进程 cwd 靠继承"恰好一致"，
    // 而那正是"判据看 A、执行落在 B"的来源。取不到就让相对路径 fail-closed（见 `_canonicalTarget`）。
    this._workDir = core.get('sandbox.workDir') || core.get('agent.workDir') || null;
  }

  /**
   * v0.15.2：沙箱子进程必须有**对称的释放点**。
   *
   * 修前 `_children` 只增不减：fork 出来的 bootstrap 进程一旦建立就缓存在实例上，
   * 唯一会 kill 它的地方是 fork 自己那个 5 秒超时。于是任何用过沙箱的进程在结束时
   * 都会留下一个仍在等 IPC 消息的子进程 —— 实测单测退出时 ProcessWrap + 4×PipeWrap 存活，
   * 事件循环 10 秒排不空（用 async_hooks 定位到本文件的 `fork`）。
   * 子进程在等消息不是“还有活要干”，是“没人告诉它可以走”。
   */
  stop() {
    for (const [id, child] of this._children) {
      try { child.kill(); } catch { /* 已退出 */ }
      this._children.delete(id);
    }
  }

  async fork(id = 'default') {
    if (this._children.has(id)) return this._children.get(id);

    // 必须用 fileURLToPath：安装路径含非 ASCII 时 .pathname 保留百分号编码，fork 直接 ENOENT
    const { fileURLToPath } = await import('node:url');
    const bootstrap = fileURLToPath(new URL('./_lib/sandbox/bootstrap.mjs', import.meta.url));

    return new Promise((resolve, reject) => {
      const child = fork(bootstrap, [], {
        execArgv: [`--max-old-space-size=${this._memoryLimit}`],
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      });

      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error('Sandbox fork timeout'));
      }, 5000);

      child.once('message', (msg) => {
        clearTimeout(timeout);
        if (msg.ready) {
          this._children.set(id, child);
          child.on('exit', () => this._children.delete(id));
          resolve(child);
        } else {
          reject(new Error('Sandbox init failed'));
        }
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  async execute(op, args, options = {}) {
    const sandboxId = options.sandboxId || 'default';
    const sessionId = options.sessionId || 'unknown';
    const timeout = options.timeout || this._timeout;

    // 顺序很讲究：**先判、后 fork**。修前先 fork 再判，于是"被拒绝的操作"也拉起了一个子进程
    // —— 拒绝本该没有副作用，却留下了一个进程。判据是纯判定，不需要进程在场。
    const guardResult = await this._guard(op, args, { sessionId });
    if (!guardResult.ok) {
      this.core.emitFast('sandbox.blocked', { op, code: guardResult.code, reason: guardResult.error, sessionId, timestamp: Date.now(), sourcePlugin: 'sandbox' });
      return { ok: false, code: guardResult.code || 'sandbox_denied', error: guardResult.error, blocked: true };
    }

    const child = await this.fork(sandboxId);
    const id = ++this._seq;
    // 判据给出的**物理路径**才是真正要操作的目标（S1 合同：不能先查 A，随后让子进程在 B 写入）。
    const effectiveArgs = guardResult.paths ? { ...args, ...guardResult.paths } : args;

    this.core.emitFast('sandbox.execute', { op, sandboxId, sessionId, timestamp: Date.now(), sourcePlugin: 'sandbox' });
    return this._execWithTimeout(child, op, effectiveArgs, id, sandboxId, sessionId, timeout);
  }

  /**
   * S2 / R0-160：**受限 shell 策略不可实施，因此必须拒绝，而不是假装在过滤。**
   *
   * 修前这里是 `cmd.split(/\s/)[0]` 取首个 token，再用 `binary.startsWith(prefix)` 比白名单。
   * 两个独立的错：
   *   ① `bashAllowlist=['echo']` 时 `echo pwned; touch /tmp/x` 的首 token 是 `echo` ⇒ 放行，
   *      后半段照样执行。管道、重定向、`$(...)`、反引号、换行同形。
   *   ② `startsWith` 让 `echooo`、`echo-hack` 也算命中。
   *
   * 修法有两个方向：把 shell 语法解析对（要写一个 AST 解析器，本计划明确不做），
   * 或者**承认这个策略不可实施**。选后者：白名单一旦被配置，`bash` 在这个档位下
   * 一律具名失败 `unsupported_restricted_shell`。
   *
   * 为什么这是"更安全"而不是"更弱"：修前的放行是**假放行**——调用方以为被白名单保护，
   * 实际第一个 token 之后的一切都不受控。一个稳定失败至少是诚实的，且不会悄悄回退成开放执行。
   * 需要任意 shell 的部署应显式使用可信高权限档（`sandbox.bashAllowlist` 留空），
   * 那条路径继续受 Cell 资格与危险操作检查约束。
   */
  _restrictedShellRefusal(op, args) {
    if (op !== 'bash' || !this._bashAllowlist.length) return null;
    const cmd = String(args?.command ?? '').trim();
    return {
      ok: false,
      code: 'unsupported_restricted_shell',
      error: 'This build cannot enforce a shell allowlist: `sandbox.bashAllowlist` matches only the first '
        + 'token, so `echo ok; rm -rf x`, pipes, redirects and `$(...)` all pass it. '
        + 'Refusing to run any shell while an allowlist is configured, instead of pretending to filter. '
        + 'Remove `sandbox.bashAllowlist` if this deployment trusts shells (it is then governed by Cell '
        + 'eligibility and dangerous-operation checks, not by this list).',
      shell_configured_allowlist: this._bashAllowlist.slice(),
      command_preview: cmd.slice(0, 120),
      blocked: true,
    };
  }

  /**
   * S3 / R0-161：**超时是"请求的截止"，不是"执行已结束"。**
   *
   * 修前超时分支只做两件事：清理 pending、resolve 一个 `{ok:false,error:'Timeout: ...'}`。
   * 实测反例（专家报告）：75ms 超时返回，约 650ms 后文件才被创建 —— 外层 Promise 已 resolve，
   * 子进程里的 `execSync` 还在跑。而 `error` 文案与 `state` 分类都读起来像"这次执行失败了、
   * 没有副作用"，上层会据此重试一个**已经产生副作用**的操作。
   *
   * 现在如实分开两个轴：
   *   · `request_state`：这一次**等待**的结果（`timed_out` = 我们不等了）；
   *   · `execution_state`：那一头**执行**的真实状态（`unknown_or_running` = 我们不知道，
   *     而且它可能还在跑）；
   *   · `terminated_confirmed`：我们**是否确认**它已停止。这里是 `false`，
   *     因为 `child.kill()` 只能杀掉 bootstrap 进程，杀不掉它 `execSync` 出去的 shell；
   *     把"kill 已调用"写成"已终止"正是本合同明令禁止的那种谎报。
   *
   * 同时修掉一个真实的串台路径：修前超时**不移除 message 监听器**，于是迟到的回复仍会
   * 触发 `sandbox.result` 事件（甚至 attempt 一次已经 resolve 的 resolve）。现在超时即摘监听，
   * 迟到回复只记一条 `sandbox.late_result`，绝不覆盖后来的结论。
   */
  _execWithTimeout(child, op, args, id, sandboxId, sessionId, timeout) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      let settled = false;

      const handler = (msg) => {
        if (msg.id !== id) return;
        if (settled) {
          // 迟到的回复：请求早已按超时收束，这条不得改写任何结论，只作为事实留痕。
          this._noteLateResult(op, sandboxId, id, msg, Date.now() - t0);
          return;
        }
        settled = true;
        clearTimeout(timer);
        child.removeListener('message', handler);
        this._pending.get(sandboxId)?.delete(id);
        this.core.emitFast('sandbox.result', { op, sandboxId, ok: msg.ok, duration: Date.now() - t0, sessionId, timestamp: Date.now(), sourcePlugin: 'sandbox' });
        resolve(msg);
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this._cleanupRequest(child, sandboxId, id);
        this._abandoned.set(id, { op, sandboxId, at: Date.now(), timeout });
        // **不摘 `handler`**，而是让它留在"迟到"模式：`settled === true` 之后它只会
        // 走 `_noteLateResult`，绝不会 resolve、也绝不会广播 `sandbox.result`。
        // 这一点我第一版写错了 —— 第一版在这里 `removeListener`，于是"迟到的回复"
        // 反而一条都看不见，`sandbox.late_result` 永远为空。**"看不见"不等于"没发生"**，
        // 正确处理是留痕而不是静音（`S3/b` 当场把它抓成 FAIL）。
        // 监听器有界回收：子进程退出或宽限期到就摘，避免长期驻留的 sandbox 累积监听器。
        const grace = Math.min(Math.max(timeout * 20, 10000), 120000);
        const reap = () => { try { child.removeListener('message', handler); } catch { /* 已死 */ } };
        const reaper = setTimeout(reap, grace);
        if (reaper.unref) reaper.unref();
        child.once?.('exit', () => { clearTimeout(reaper); reap(); });
        this.core.emitFast('sandbox.timeout', {
          op, sandboxId, request_id: id, timeout,
          execution_may_continue: true, terminated_confirmed: false,
          late_result_window_ms: grace,
          timestamp: Date.now(), sourcePlugin: 'sandbox',
        });
        resolve({
          ok: false,
          code: 'sandbox_timeout_indeterminate',
          error: `Timeout: ${op} (${timeout}ms) — this is the deadline for WAITING, not proof the operation stopped. `
            + 'The child process keeps running and its side effects may still appear; termination is NOT confirmed.',
          request_state: 'timed_out',
          execution_state: 'unknown_or_running',
          execution_may_continue: true,
          terminated_confirmed: false,
          request_id: `sbx-${id}`,
          elapsed_ms: Date.now() - t0,
        });
      }, timeout);

      if (!this._pending.has(sandboxId)) this._pending.set(sandboxId, new Set());
      this._pending.get(sandboxId).add(id);
      child.on('message', handler);
      try {
        child.send({ id, op, args });
      } catch (err) {
        // 子进程已死：send 会同步抛。修前这里会把异常抛进 Promise 执行器 → unhandled，调用方永远挂着。
        settled = true;
        clearTimeout(timer);
        child.removeListener('message', handler);
        this._cleanupRequest(child, sandboxId, id);
        resolve({ ok: false, code: 'sandbox_channel_closed', error: `Sandbox channel closed: ${err.message}` });
      }
    });
  }

  /** 迟到回复留痕：既不 resolve、也不广播成 `sandbox.result`。 */
  _noteLateResult(op, sandboxId, id, msg, elapsed) {
    this._lateResults.push({ request_id: id, op, sandboxId, elapsed_ms: elapsed, ok: msg?.ok === true });
    if (this._lateResults.length > 100) this._lateResults.shift();
    this.core.emitFast('sandbox.late_result', {
      op, sandboxId, request_id: id, elapsed_ms: elapsed, ok: msg?.ok === true,
      note: 'arrived after the request was already settled (timeout); it does NOT change that result',
      timestamp: Date.now(), sourcePlugin: 'sandbox',
    });
  }

  /**
   * S1 路径判据。**异步**，因为它要追真实路径（`realpath` 是 I/O）。
   *
   * 修前（R0-134）只做词法 `resolve()` + `relative()`，于是符号链接逃逸直接穿过：
   * `ws/vault -> secret`、`sandbox.deny=[secret]` ⇒ 写 `ws/vault/k.txt` 被判"在工作区内"，
   * 磁盘上 `secret/k.txt` 真的被改写。这与工具层 `workspace.mjs` 的答案相反 ——
   * 同一安全属性、两个入口、两个结论，正是送审报告 §1.1 排第一的缺口。
   *
   * 现在两侧共用 `plugins/_lib/real-path.mjs`：
   *   ① 逐段物理归一化（对已存在的段取 realpath，不吃不存在的 `..`/`.`）；
   *   ② 与 deny/allow 根做 `relative()` 包含判断（不是字符串前缀）；
   *   ③ **fail-closed**：路径形态无法确定时拒绝，而不是"确定不了就放行"。
   *
   * 返回 `path` 时，调用方必须用**它**去执行 —— 判据与效果必须落在同一位置。
   *
   * 边界（诚实）：`realpath` 与随后的写入之间仍有 TOCTOU 窗口（同一账户下的本地进程可以把
   * 目录换成符号链接）。这不使它成为 OS 沙箱；抗恶意本机进程要靠 OS 级隔离，本实现不提供。
   */
  async _guard(op, args, options = {}) {
    const targets = this._pathArgs(op, args);
    if (targets.length) {
      const rootReal = await this._workRoot(options.sessionId);
      const resolved = {};
      for (const [key, raw, side] of targets) {
        // 合同限定的路径形态：非空字符串。相对路径按工作区根解析（见下），解析不出来则拒绝。
        if (typeof raw !== 'string' || raw.length === 0) {
          return { ok: false, code: 'invalid_path', error: `Path must be a non-empty string, got ${JSON.stringify(raw)}` };
        }
        const target = await this._canonicalTarget(raw, rootReal);
        if (!target) {
          return {
            ok: false,
            code: 'indeterminate_path',
            error: `Cannot determine the physical target of "${raw}" (relative path with no resolvable workspace root, `
              + 'or a path whose non-existent tail contains "." / ".." — physical semantics are undefined). Refusing.',
          };
        }
        // deny 优先于 allow：deny 命中即拒，不再看 allow。
        // 先跑共享的敏感路径判据（含 `~/.ssh`、`~/.tusunsun`、`/etc` 等），再看用户追加的 deny 根。
        if (isSensitivePath(target.real)) {
          return { ok: false, code: 'sandbox_path_denied', error: `Path denied: ${raw} (resolves to ${target.real}: sensitive path)` };
        }
        for (const base of this._deny) {
          const baseReal = await canonicalizePath(base);
          if (baseReal && isInsideReal(baseReal, target.real)) {
            return { ok: false, code: 'sandbox_path_denied', error: `Path denied: ${raw} (resolves to ${target.real}, inside deny root ${baseReal})` };
          }
        }
        // S1：**开沙箱不得取消工作区边界**。修前这里只判 deny/allow，于是
        // `sandbox.enabled: true` 时 `tool-write` 自己的 `resolveWorkspacePath` 一次都没跑，
        // 绝对路径与 `../` 都能直接出界（实测：sandbox=false 拒、sandbox=true 成功）。
        // 显式配置的 `readAllow`/`writeAllow` 是用户主动放宽的那一份，仍然生效。
        const allow = side === 'write' ? this._writeAllow : this._readAllow;
        if (rootReal && !isInsideReal(rootReal, target.real) && !(await this._anyInside(allow, target.real))) {
          return { ok: false, code: 'sandbox_outside_workspace', error: `Path denied: ${raw} (resolves to ${target.real}, outside the workspace ${rootReal})` };
        }
        if (allow.length && !(await this._anyInside(allow, target.real))) {
          return side === 'write'
            ? { ok: false, code: 'sandbox_write_not_allowed', error: `Write not allowed: ${raw} (resolves to ${target.real})` }
            : { ok: false, code: 'sandbox_read_not_allowed', error: `Read not allowed: ${raw} (resolves to ${target.real})` };
        }
        resolved[key] = target.real;
      }
      // 兼容形状：`path` 是单路径 op 的物理路径。
      return { ok: true, paths: resolved, path: resolved.path };
    }
    if (op === 'bash') {
      const restricted = this._restrictedShellRefusal(op, args);
      if (restricted) return restricted;
      if (!String(args?.command ?? '').trim()) return { ok: false, code: 'invalid_input', error: 'bash requires a non-empty command' };
    }
    if (op === 'eval' && !args?.code) {
      return { ok: false, code: 'invalid_input', error: 'eval requires code' };
    }
    return { ok: true };
  }

  /**
   * 把入参路径解析成**物理绝对路径**。
   * 相对路径按 `sandbox.workDir`（缺省回落到 `agent.workDir`）解析并 fail-closed ——
   * 绝不按 `process.cwd()` 猜：父进程与子进程的 cwd 是靠继承"恰好一致"，
   * 而那正是"判据看 A、执行落在 B"的来源（S1 合同禁止）。
   */
  async _canonicalTarget(raw, rootReal = null) {
    if (isAbsolute(raw)) {
      const real = await canonicalizePath(raw);
      return real ? { real, requested: raw } : null;
    }
    // 相对路径的基准：本次判据算出的工作区根优先（显式配置 → workspace 服务）
    const base = rootReal || (await this._workRoot(null));
    if (!base) return null;
    const real = await canonicalizePath(joinAbsolute(base, raw));
    return real ? { real, requested: raw } : null;
  }

  /**
   * 路径类操作的入参表：**同一份判据必须覆盖所有会落盘的 op**（S1 / H5）。
   * 修前这里只认 `args.path`，`cp`/`mv`/`rm` 连判据都没有 —— 打开沙箱反而让它们
   * 绕过工具层自己的 `resolveWorkspacePath`。
   * @returns {Array<[string, unknown, 'read'|'write']>}
   */
  _pathArgs(op, args) {
    if (op === 'cp' || op === 'mv') return [['src', args?.src, 'read'], ['dest', args?.dest, 'write']];
    if (op === 'read' || op === 'list' || op === 'stat') return [['path', args?.path, 'read']];
    if (op === 'write' || op === 'rm') return [['path', args?.path, 'write']];
    return [];
  }

  /**
   * 本次判据要守的工作区根：`sandbox.workDir`（缺省回落 `agent.workDir`）优先；
   * 没有配置时按会话向 `workspace` 服务要 —— 那正是**工具层不开口箱时用的同一个根**。
   * 只有 `execute` 会传 `sessionId`；直接调 `_guard` 的单元测试不受影响。
   */
  async _workRoot(sessionId) {
    if (this._workDir) return canonicalizePath(this._workDir);
    if (!sessionId) return null;
    const ws = this.core?.getService?.('workspace');
    const root = typeof ws?.root === 'function' ? ws.root(sessionId) : null;
    return root ? canonicalizePath(root) : null;
  }

  async _anyInside(bases, targetReal) {
    for (const base of bases) {
      const baseReal = await canonicalizePath(base);
      if (baseReal && isInsideReal(baseReal, targetReal)) return true;
    }
    return false;
  }

  _cleanupRequest(child, sandboxId, id) {
    const pending = this._pending.get(sandboxId);
    if (pending) {
      pending.delete(id);
    }
  }

  async kill(id = 'default', sessionId = 'unknown') {
    const child = this._children.get(id);
    if (child) {
      child.kill();
      this._children.delete(id);
      this.core.emitFast('sandbox.killed', {
        sandboxId: id, sessionId,
        timestamp: Date.now(),
        sourcePlugin: 'sandbox',
      });
    }
  }

  async killAll(sessionId = 'unknown') {
    for (const id of this._children.keys()) {
      await this.kill(id, sessionId);
    }
  }

  list() {
    return Array.from(this._children.entries()).map(([id, child]) => ({
      id,
      pid: child.pid,
      connected: child.connected,
    }));
  }
}

export default new SandboxPlugin();
