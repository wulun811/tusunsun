// 危险工具名单 + 参数模式判据来自**共享模块**（R0-105 缺陷 4）：判据只有一份，
// 否则执行器与护栏各判一套，就是漏判的温床。此处只做 re-export 供旧引用点继续可用。
import { DANGEROUS_TOOL_NAMES as DANGEROUS_TOOLS, matchDangerousCommand } from '../danger-patterns.js';
import { statSync } from 'node:fs';
// AR-C06（v0.11.0）：路径字段清单只有一份（围栏边界 / 写前必读 / 工具执行共用）。
// 修前本文件的写前必读只读 `args?.path`，而 `tool-write` 认 `path|file_path|filePath`。
import { pickPath } from '../tool-path-args.mjs';
import { join } from 'node:path';

class WindowCounter {
  constructor(maxCalls, windowSec) {
    this.max = maxCalls;
    this.window = windowSec * 1000;
    this._ticks = [];
  }
  tryAdd(now = Date.now()) {
    this._ticks = this._ticks.filter(t => now - t < this.window);
    if (this._ticks.length >= this.max) return false;
    this._ticks.push(now);
    return true;
  }
  count() { return this._ticks.length; }
  get lastTick() { return this._ticks.length > 0 ? Math.max(...this._ticks) : 0; }
}

class CircuitBreaker {
  constructor(maxFailRate, failWindow, minCalls, cooldown = 30000) {
    this.threshold = maxFailRate;
    this.window = failWindow;
    this.minCalls = minCalls;
    this.cooldown = cooldown;
    this._calls = [];
    this._state = 'CLOSED';
    this._halfOpenSince = null;
    this._halfOpenSuccesses = 0;
    this._onChange = null;
  }
  record(success) {
    const prev = this._state;
    this._calls.push({ success, ts: Date.now() });
    if (this._state === 'HALF_OPEN' && success) this._halfOpenSuccesses++;
    this._evaluate();
    if (this._state !== prev && this._onChange) {
      this._onChange(prev, this._state);
    }
  }
  _evaluate() {
    this._calls = this._calls.filter(c => Date.now() - c.ts < this.window * 1000);
    if (this._calls.length < this.minCalls) return;
    const failRate = this._calls.filter(c => !c.success).length / this._calls.length;
    if (failRate >= this.threshold) {
      this._state = 'OPEN';
    } else if (this._state === 'OPEN' && failRate < this.threshold / 2) {
      this._state = 'HALF_OPEN';
      this._halfOpenSince = Date.now();
      this._halfOpenSuccesses = 0;
    } else if (this._state === 'HALF_OPEN') {
      const successes = this._calls.filter(c => c.success).length;
      if (successes >= this.minCalls && failRate < this.threshold / 4) {
        this._state = 'CLOSED';
        this._halfOpenSince = null;
        this._halfOpenSuccesses = 0;
      }
      if (this._halfOpenSince && Date.now() - this._halfOpenSince > this.cooldown) {
        this._state = 'CLOSED';
        this._halfOpenSince = null;
        this._halfOpenSuccesses = 0;
      }
    }
  }
  allow() { return this._state !== 'OPEN'; }
  get state() { return this._state; }
}

const GLOBAL_SESSION_KEY = '__global__';

export class LocalFence {
  constructor(core) {
    this.core = core;
    this._customBlocked = new Set(
      core.get('kunxiansuo.bundle.localFence.dangerousTools') || []
    );
    this._rateLimiters = new Map();
    this._circuitBreakers = new Map();
    this._sessionCounters = new Map();
    this._readFiles = new Map();
    this._fsGuard = null;
    this._lastPrune = Date.now();
  }

  preCheck(tool, args, sessionId, chainId, expertId, fenceCtx = null) {
    tool = tool?.trim() || '';

    if (expertId) {
      const expertCfg = this.core.get('experts.' + expertId);
      const allowlist = expertCfg?.toolsAllow;
      if (allowlist && Array.isArray(allowlist) && !allowlist.includes(tool)) {
        return {
          ok: false,
          code: 'EXPERT_TOOL_DENIED',
          reason: 'Tool "' + tool + '" not in expert "' + expertId + '" allowlist',
          hint: 'Expert "' + expertId + '" is restricted to: ' + allowlist.join(', '),
          alternatives: allowlist,
          retryable: false,
          result: null,
        };
      }
    }

    if (DANGEROUS_TOOLS.has(tool) || this._customBlocked.has(tool)) {
      return {
        ok: false,
        code: 'Y024',
        reason: `Dangerous tool '${tool}' violates safety policy`,
        hint: this._hintFor(tool),
        alternatives: this._alternativesFor(tool),
        retryable: false,
        result: null,
      };
    }

    // R0-105 缺陷 4（参数层）：危险的不是工具名，而是它收到的参数。
    // `tool-bash` 能读系统凭据、能 curl 外网——这些只能从 command 串判出来。
    {
      const cmd = args && (args.command ?? args.cmd ?? args.script);
      const hit = matchDangerousCommand(cmd);
      if (hit) {
        return {
          ok: false,
          code: 'Y024',
          reason: `Command violates safety policy: ${hit.why}`,
          hint: '本内核定位 trusted-local-only：越界读取系统文件、外联、递归强删等一律拒绝',
          alternatives: [],
          retryable: false,
          result: null,
          matched: hit.pattern,
        };
      }
    }

    if (this._quarantinedSessions?.has(sessionId)) {
      return {
        ok: false,
        code: 'P0_QUARANTINE',
        reason: `Session ${sessionId} quarantined by 外部诊断服务 P0 push`,
        hint: 'All tools blocked for this session',
        alternatives: [],
        retryable: false,
        result: null,
      };
    }

    if (sessionId) {
      const breaker = this._getBreaker(tool, sessionId, chainId);
      if (breaker && !breaker.allow()) {
        const recentCalls = breaker._calls.filter(c => Date.now() - c.ts < (breaker.window || 30000) * 1000);
        const fails = recentCalls.filter(c => !c.success).length;
        const total = recentCalls.length;
        return {
          ok: false,
          code: 'circuit_open',
          reason: `Circuit breaker open for tool '${tool}'`,
          hint: `Recent ${fails}/${total} calls failed. Wait for cooldown and retry.`,
          alternatives: [],
          retryable: true,
          result: null,
          _count: fails,
          _maxPerWindow: total,
        };
      }

      const limiter = this._getLimiter(tool, sessionId, chainId);
      if (limiter && !limiter.tryAdd()) {
        return {
          ok: false,
          code: 'rate_limited',
          reason: `Rate limit exceeded for tool '${tool}'`,
          hint: 'Please wait and retry later',
          alternatives: [],
          retryable: true,
          result: null,
          _count: limiter.count(),
          _maxPerWindow: limiter.max,
        };
      }

      const quotaR = this._checkQuota(sessionId, chainId);
      if (quotaR) return quotaR;
    }

    if (this._fsGuard) {
      const pathR = this._fsGuard.checkPath(tool, args);
      if (!pathR.ok) { pathR._matchedRule = 'sensitive_path'; return pathR; }
      const cmdR = this._fsGuard.checkCommand(tool, args, fenceCtx);
      if (!cmdR.ok) { cmdR._dangerPattern = 'irreversible_op'; return cmdR; }
      const boundaryR = this._fsGuard.checkBoundary(tool, args);
      if (!boundaryR.ok) return boundaryR;
    }

    // --- 2.5 读前必读：写文件前必须已读 ---
    // R0-119 缺陷 2（实测）：此判据**必须只对"已存在的文件"生效**。
    // 原实现拿 `args.path` 原样去比对读记录，而 `markRead()` 记的是**绝对路径** ⇒ 两个必然后果：
    //   ① 相对路径永远比不上（护栏一接线，所有写入全被拦，连改写刚读过的文件也拦）；
    //   ② 新建文件永远"没读过"（物理上不可能先读一个不存在的文件）⇒ 创建文件被永久禁止。
    // 设计意图是"改已有内容前先看清楚"，不是"禁止新建"。现在：先 stat，文件不存在即放行。
    if (tool === 'tool-write') {
      // AR-C06（v0.11.0）：路径取值走单一真相模块。
      // 修前这里只读 `args?.path`，于是 `{file_path:'x'}` 既逃过围栏的边界判据、
      // 也逃过这条写前必读 —— 而 `tool-write.execute` 认这个别名，真的会写。
      const filePath = pickPath(args);
      if (filePath) {
        // R0-124：按**本会话**的根展开，否则同一相对路径在两个会话里指向两个真实文件，
        // 而读记录与写入目标按同一个根算 ⇒ 要么误拦（别人的文件没读过），要么漏拦
        const workDir = this.core?.getService?.('workspace')?.root?.(sessionId)
          || this.core?.getData?.('agent.workDir')
          || this.core?.get?.('agent.workDir')
          || process.cwd();
        const abs = filePath.startsWith('/') ? filePath : join(workDir, filePath);
        // 只在"文件已存在"时要求先读——新文件无内容可读，要求它只会把正常创建挡死
        let exists = true;
        try { statSync(abs); } catch { exists = false; }
        if (exists) {
          // R0-121：读记录改为 `{ files, at }`（带时间戳，按年龄清理）
          const entry = this._readFiles.get(sessionId || '__default__');
          const read = entry?.files?.has(abs) || entry?.files?.has(filePath);
          if (!read) {
            return {
              ok: false,
              code: 'WRITE_BEFORE_READ',
              reason: `Writing to existing file "${filePath}" which has not been read. Use tool-read first.`,
              hint: `Run tool-read with path="${filePath}" to read it, then apply your changes with tool-write.`,
              alternatives: [],
              retryable: true,
              result: null,
            };
          }
        }
      }
    }

    // --- 2.6 auto-fix 防作弊 ---
    const cheatR = this._checkAutoFixCheat(tool, args);
    if (cheatR) return cheatR;

    const ctx = { sessionId, toolName: tool, chainId };

    const schema = this.core.get(`tools.schemas.${tool}`);
    if (schema) {
      const errs = this.validateSchema(args, schema);
      if (errs) {
        const first = errs[0];
        try {
          this.core.emit('kunxiansuo.schema_error', {
            sessionId: ctx.sessionId, tool: ctx.toolName,
            errorCount: errs.length, errors: errs,
            timestamp: new Date().toISOString(), sourcePlugin: 'kunxiansuo',
          });
        } catch { /* 事件上报尽力而为 */ }

        return {
          ok: false,
          code: 'SCHEMA_ERROR',
          reason: errs.map(e => `${e.field}: ${e.suggestion}`).join('; '),
          hint: first.suggestion,
          alternatives: [],
          retryable: true,
          result: null,
          errors: errs,
        };
      }
    }

    this._pruneIfNeeded();

    return { ok: true };
  }

  postCheck(tool, result, duration, ok, sessionId, chainId) {
    if (tool) {
      const breaker = this._getBreaker(tool, sessionId || GLOBAL_SESSION_KEY, chainId);
      if (breaker) breaker.record(ok);
    }
    return this.sanitize(tool, result);
  }

  sanitize(tool, result) {
    if (typeof result !== 'string') return result;
    const timeout = this.core.get('kunxiansuo.bundle.localFence.sanitize.timeoutMs') || 50;
    let s = result;
    const t0 = Date.now();
    for (const [pattern, replacement] of BUILTIN_SANITIZERS) {
      if (Date.now() - t0 > timeout) break;
      s = s.replace(pattern, replacement);
    }
    return s;
  }

  validateSchema(value, schema, fieldPath = 'args', errors = []) {
    if (!schema || Object.keys(schema).length === 0) return null;
    if (value === null) {
      if (schema.required) {
        errors.push({
          field: fieldPath,
          expected: schema.type || 'object',
          received: 'null',
          suggestion: `Field "${fieldPath}" is null but required`,
        });
      }
      return errors.length > 0 ? errors : null;
    }
    if (schema.required) {
      for (const key of schema.required) {
        if (value === undefined || value[key] === undefined || value[key] === null) {
          errors.push({
            field: `${fieldPath}.${key}`,
            expected: 'required',
            received: value === undefined ? 'undefined' : (value[key] === null ? 'null' : typeof value[key]),
            suggestion: `Field "${fieldPath}.${key}" is required`,
          });
        }
      }
    }
    if (schema.type && value !== undefined) {
      if (schema.type === 'array' && !Array.isArray(value)) {
        errors.push({
          field: fieldPath,
          expected: 'array',
          received: typeof value,
          suggestion: `"${fieldPath}" expects an array`,
        });
      } else if (schema.type !== 'array' && typeof value !== schema.type) {
        errors.push({
          field: fieldPath,
          expected: schema.type,
          received: typeof value,
          suggestion: `"${fieldPath}" must be of type "${schema.type}"`,
        });
      }
    }
    if (schema.enum && !schema.enum.includes(value)) {
      errors.push({
        field: fieldPath,
        expected: `one of [${schema.enum.join(', ')}]`,
        received: typeof value,
        suggestion: `Valid options: ${schema.enum.join(', ')}`,
      });
    }
    if (schema.min !== undefined && value < schema.min) {
      errors.push({
        field: fieldPath,
        expected: `>= ${schema.min}`,
        received: typeof value,
        suggestion: `Value must be >= ${schema.min}`,
      });
    }
    if (schema.max !== undefined && value > schema.max) {
      errors.push({
        field: fieldPath,
        expected: `<= ${schema.max}`,
        received: typeof value,
        suggestion: `Value must be <= ${schema.max}`,
      });
    }
    if (schema.properties && typeof value === 'object') {
      for (const [key, prop] of Object.entries(schema.properties)) {
        if (value[key] !== undefined) {
          this.validateSchema(value[key], prop, `${fieldPath}.${key}`, errors);
        }
      }
    }
    return errors.length > 0 ? errors : null;
  }

  _hintFor(tool) {
    const hints = {
      rm_rf: 'Use safe_rm or trash_file for safe removal',
      eval: 'Use a safe evaluator or JSON.parse instead',
      exec: 'Use subprocess.run() with explicit command list',
      os_system: 'Use subprocess.run() instead',
      git_force_push: 'Use git push or git push --set-upstream instead',
    };
    return hints[tool] || 'This tool is blocked by safety policy';
  }

  _alternativesFor(tool) {
    const alts = {
      rm_rf: ['safe_rm', 'trash_file'],
      eval: ['safe_eval', 'json_parse'],
      exec: ['subprocess_run', 'compile_safe'],
      os_system: ['subprocess_run'],
      git_force_push: ['git_push', 'git_push_set_upstream'],
    };
    return alts[tool] || [];
  }

  _getLimiter(tool, sessionId, chainId) {
    if (!sessionId) return null;
    const rateCfg = this.core.get('kunxiansuo.bundle.localFence.rateLimit') || {};
    const sessionCfg = rateCfg.session_tool || {};
    const cfg = sessionCfg[tool] || sessionCfg.default;
    if (!cfg) return null;

    const key = `rate:${tool}:${chainId || sessionId}`;
    if (!this._rateLimiters.has(key)) {
      this._rateLimiters.set(key, new WindowCounter(cfg.max, cfg.windowSec));
    }
    return this._rateLimiters.get(key);
  }

  _checkQuota(sessionId, chainId) {
    const quotaCfg = this.core.get('kunxiansuo.bundle.localFence.quota');
    if (!quotaCfg || !sessionId) return null;
    const key = `quota:${chainId || sessionId}`;
    if (!this._sessionCounters.has(key)) {
      this._sessionCounters.set(key, new WindowCounter(
        quotaCfg.maxCalls || 100, quotaCfg.windowSec || 3600));
    }
    const counter = this._sessionCounters.get(key);
    if (!counter.tryAdd()) {
        return {
          ok: false,
          code: 'quota_exceeded',
          reason: 'Session quota reached',
          hint: 'Wait for the next window',
          alternatives: [],
          retryable: true,
          result: null,
          _count: counter.count(),
          _maxPerWindow: quotaCfg.maxCalls || 100,
        };
    }
    return null;
  }

  _getBreaker(tool, sessionId, chainId) {
    if (!sessionId) return null;
    const cfg = this.core.get('kunxiansuo.bundle.localFence.circuitBreak') || {};
    const sessionCfg = cfg.session_tool || {};
    const toolCfg = sessionCfg[tool];
    if (!toolCfg) return null;

    const key = `cb:${tool}:${chainId || sessionId}`;
    if (!this._circuitBreakers.has(key)) {
      const breaker = new CircuitBreaker(toolCfg.maxFailRate || 0.8, toolCfg.failWindow || 5, toolCfg.minCalls || 5);
      breaker._onChange = (from, to) => {
        try {
          this.core.emitFast('circuit.state_change', {
            tool, sessionId, chainId,
            from, to,
            timestamp: Date.now(),
            sourcePlugin: 'local_fence',
          });
        } catch { /* 事件上报尽力而为 */ }
      };
      this._circuitBreakers.set(key, breaker);
    }
    return this._circuitBreakers.get(key);
  }

  _pruneIfNeeded() {
    const now = Date.now();
    if (now - this._lastPrune < 60000) return;
    this._lastPrune = now;

    const expiry = now - 300000;
    for (const [key, counter] of this._rateLimiters) {
      if (counter.lastTick < expiry) this._rateLimiters.delete(key);
    }
    for (const [key, cb] of this._circuitBreakers) {
      if (cb._calls.every(c => now - c.ts > cb.window * 1000)) {
        this._circuitBreakers.delete(key);
      }
    }
    for (const [key, counter] of this._sessionCounters) {
      if (counter.lastTick < expiry) this._sessionCounters.delete(key);
    }
    // R0-121（复查真阳性）：读记录按**年龄**清理，不再按"限流器是否存在"。
    // 旧判据在默认配置（不限流）下每次都成立 ⇒ 读过不到一分钟的文件又被要求"先读"；
    // 用了 chainId 时同样成立（限流 key 走的是 chainId）。30 分钟内的读记录保持有效。
    const READ_MARK_TTL = 30 * 60 * 1000;
    for (const [key, entry] of this._readFiles) {
      const at = typeof entry?.at === 'number' ? entry.at : 0;   // 旧形态（裸 Set）按已过期处理
      if (now - at > READ_MARK_TTL) this._readFiles.delete(key);
    }
  }

  sessionQuarantine(sessionId) {
    this._quarantinedSessions ??= new Set();
    this._quarantinedSessions.add(sessionId);
    this.core.log('warn', `LocalFence: session quarantined by 外部诊断服务 P0 push: ${sessionId}`);
  }

  markRead(sessionId, filePath) {
    const key = sessionId || '__default__'
    let entry = this._readFiles.get(key)
    if (!(entry && entry.files instanceof Set)) {
      // 迁移旧形态（裸 Set）——同进程热更新时不让历史状态把写入挡死
      entry = { files: entry instanceof Set ? entry : new Set(), at: Date.now() }
      this._readFiles.set(key, entry)
    }
    entry.files.add(filePath)
    entry.at = Date.now()
  }

  _checkAutoFixCheat(tool, args) {
    // AR-C05（v0.10.3）：与 file-guard / 执行器同口径，不再接受 `_raw` 别名。
    const cmd = args?.command ?? args?.cmd ?? args?.script ?? '';
    const filePath = args?.file_path || args?.filePath || '';

    // Skipping tests
    if (/npm test.*--(skip|grep|ignore|exclude)|jest.*--(skip|ignore)|it\.skip|describe\.skip|test\.skip/.test(cmd)) {
      return { ok: false, code: 'CHEAT_SKIP_TEST', reason: 'auto-fix cheated: skipping tests', retryable: false, result: null };
    }
    // eslint-disable / tslint:disable / type ignore
    if (/\/\/\s*eslint-disable|\/\/\s*ts-ignore|\/\/\s*@ts-expect-error/.test(cmd) ||
        (filePath && /\/\*\s*eslint-disable/.test(cmd))) {
      return { ok: false, code: 'CHEAT_SUPPRESS', reason: 'auto-fix cheated: suppressed lint/type errors', retryable: false, result: null };
    }
    // Modifying test files to pass tests (test/ dir, *.test.js, *.spec.js) 
    if (filePath && /(\btest\/|__tests__\/|\.test\.(js|mjs|ts)|\.spec\.(js|mjs|ts))/.test(filePath)) {
      if (cmd.includes('pass') || cmd.includes('fix') || cmd.includes('update')) {
        return { ok: false, code: 'CHEAT_MODIFY_TEST', reason: `auto-fix cheated: modifying test file ${filePath}`, retryable: false, result: null };
      }
    }
    // Adding empty catch blocks
    if (/catch\s*\{[\s]*\}/.test(cmd) || /catch\s*\(.*?\)\s*\{[\s]*\}/.test(cmd)) {
      return { ok: false, code: 'CHEAT_EMPTY_CATCH', reason: 'auto-fix cheated: empty catch block swallows errors', retryable: false, result: null };
    }

    return null;
  }
}

const BUILTIN_SANITIZERS = [
  [/api_key=[^\s&]+/gi, 'api_key=***'],
  [/token[:=]\s*[^\s,}]+/gi, 'token=***'],
  [/Bearer\s+[^\s]+/gi, 'Bearer ***'],
  // --- 2.5 增强 Secrets 检测 ---
  [/sk-[a-zA-Z0-9]{20,}/g, 'sk-***'],                          // OpenAI / Anthropic keys
  [/ghp_[a-zA-Z0-9]{36}/g, 'ghp_***'],                          // GitHub PAT
  [/gho_[a-zA-Z0-9]{36}/g, 'gho_***'],                          // GitHub OAuth
  [/ghu_[a-zA-Z0-9]{36}/g, 'ghu_***'],                          // GitHub user token
  [/ghr_[a-zA-Z0-9]{36}/g, 'ghr_***'],                          // GitHub refresh token
  [/AKIA[0-9A-Z]{16}/g, 'AKIA***'],                             // AWS access key
  [/eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, 'jwt.***'], // JWT
  [/-----BEGIN (RSA |EC )?PRIVATE KEY-----[\s\S]*?-----END (RSA |EC )?PRIVATE KEY-----/g, '***PRIVATE KEY***'],
  [/-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]*?-----END OPENSSH PRIVATE KEY-----/g, '***OPENSSH KEY***'],
  [/password[:=]\s*[^\s,}'"]+/gi, 'password=***'],
  [/secret[:=]\s*[^\s,}'"]+/gi, 'secret=***'],
];
