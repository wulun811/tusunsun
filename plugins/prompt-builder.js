class PromptBuilder {
  name = 'prompt-builder';
  version = '0.6.0';
  requires = { 'prompt-template': '>=0.4.0', 'tool-normalizer': '>=0.4.0' };
  permissions = [];
  provides = [{ name: 'prompt', type: 'service' }];

  // TusunZip prompt 压缩字典（固定，不可变）
  static COMPRESS_MAP = Object.entries({
    '"id":':'@', '"timestamp":':'#', '"ts":':'#', '"type":':'$',
    '"source":':'%', '"src":':'%', '"content":':'&', '"hash":':'*', '"prev_hash":':'!',
    '"tool_call"':'A', '"event"':'B', '"state"':'C',
    '"user_input"':'D', '"agent_output"':'E',
    '"agent"':'a', '"user"':'u', '"device"':'d', '"system"':'s',
    '"success"':'+', '"error"':'-', '"running"':'>', '"normal"':'=',
  }).sort((a, b) => b[0].length - a[0].length);

  static COMPRESS_DICT =
    '@="id": #="ts": $="type": %="src": &=content: *=hash: !=prev_hash:\n' +
    'A=tool_call B=event C=state D=user_input E=agent_output\n' +
    'a=agent u=user d=device s=system +=success -=error >=running';

  constructor() {
    this._hooks = [];
  }

  async init(core) {
    this.core = core;
    core.registerService('prompt', this);

    this._builtInStages = ['base', 'template', 'memory', 'project_context', 'kongmen', 'tools', 'workspace', 'safety_reflection', 'plugins', 'format'];
    this._hooks = [
      { stage: 'base', fn: (ctx) => { ctx.prompt = ctx.systemPrompt || ''; }, priority: 0 },
      { stage: 'template', fn: (ctx) => this._applyTemplates(ctx), priority: 10 },
      { stage: 'memory', fn: (ctx) => this._injectMemory(ctx), priority: 20 },
      { stage: 'project_context', fn: (ctx) => this._injectProjectContext(ctx), priority: 22 },
      { stage: 'kongmen', fn: (ctx) => this._injectKongmen(ctx), priority: 25 },
      { stage: 'tools', fn: (ctx) => this._injectTools(ctx), priority: 30 },
      { stage: 'workspace', fn: (ctx) => this._injectWorkspace(ctx), priority: 32 },
      { stage: 'safety_reflection', fn: (ctx) => this._injectSafetyReflection(ctx), priority: 35 },
      { stage: 'format', fn: (ctx) => this._formatMessages(ctx), priority: 50 },
    ];

    // Phase 4: 检查是否有万词王服务，如果有，调用它获取内容块
    this._wanciwang = core.getService('wanciwang');
    if (this._wanciwang && core.get('wanciwang.enabled') !== false) {
      core.log('info', '[prompt-builder] wanciwang service detected, using unified prompt assembly');
    }
  }

  addHook(stage, fn, priority = 25) {
    this._hooks.push({ stage, fn, priority });
  }

  async build(options) {
    const ctx = {
      systemPrompt: options.systemPrompt || '',
      history: options.history || [],
      tools: options.tools || [],
      sessionId: options.sessionId,
      variables: options.variables || {},
      prompt: '',
      messages: [],
    };

    // Phase 4: 如果万词王可用，使用统一装配
    if (this._wanciwang && this.core.get('wanciwang.enabled') !== false) {
      try {
        const result = await this._wanciwang.assemble({
          role: options.role || 'general',
          scenario: options.scenario || 'general',
          model: options.model || 'any',
          context: {
            // R0-124：提示词里的"当前目录"必须与工具实际落盘的根一致，否则模型会按
            // 一个目录的路径规划、工具按另一个目录执行（这正是修前两会话串目录的表现）
            workDir: this._workspaceRoot(ctx.sessionId),
            tools: ctx.tools,
            strategyConfig: options.strategy,
            strategyState: options.strategyCtx,
            pullContext: options.pullContext,
            yipanAdvisory: options.yipanAdvisory,
            guiyuanInjection: options.guiyuanInjection,
            yuxiMemorial: options.yuxiMemorial,
            failureHistory: options.failureHistory,
          },
        });
        ctx.prompt = result.prompt;
        ctx.wanciwangResult = result;
      } catch (e) {
        this.core.log('warn', `[prompt-builder] wanciwang assemble failed: ${e.message}, falling back to legacy`);
      }
    }

    // 如果万词王没有提供 prompt，走老逻辑
    if (!ctx.prompt) {
      const sorted = [...this._hooks].sort((a, b) => a.priority - b.priority);
      for (const hook of sorted) {
        await hook.fn(ctx);
      }
    } else {
      // 万词王已提供 prompt，只执行 template 和 format 阶段
      const templateHook = this._hooks.find(h => h.stage === 'template');
      const formatHook = this._hooks.find(h => h.stage === 'format');
      if (templateHook) await templateHook.fn(ctx);
      if (formatHook) await formatHook.fn(ctx);
    }

    this.core.emit('prompt.built', {
      sessionId: ctx.sessionId,
      stages: this._hooks.map(h => h.stage),
      messageCount: ctx.messages.length,
      timestamp: new Date().toISOString(),
      sourcePlugin: 'prompt-builder',
      wanciwangUsed: !!ctx.wanciwangResult,
    });

    return ctx.messages;
  }

  _applyTemplates(ctx) {
    const tpl = this.core.getService('prompt-template');
    if (tpl) {
      ctx.prompt = tpl.render(ctx.systemPrompt, ctx.variables);
    } else {
      ctx.prompt = ctx.systemPrompt;
    }
  }

  async _injectMemory(ctx) {
    const memory = this.core.getService('memory');
    if (!memory || !ctx.sessionId) return;

    const lastUserMsg = [...ctx.history].reverse().find(m => m.role === 'user');
    if (!lastUserMsg) return;

    const facts = await memory.recall(lastUserMsg.content);
    if (facts.length) {
      const block = '## Relevant Memory\n' +
        facts.map(f => `- ${f.fact}`).join('\n');

      if (this._shouldCompress(facts.length)) {
        const compressed = this._tusunCompress(block);
        ctx.prompt += `\n\n${PromptBuilder.COMPRESS_DICT}\n\n${compressed}`;
      } else {
        ctx.prompt += `\n\n${block}`;
      }
    }

    const yingMini = this.core.getService('ying-mini');
    if (yingMini) {
      const recentOps = await yingMini.getRecent(8);
      if (recentOps.length) {
        ctx.prompt += '\n\n## Recent Operations\n' +
          recentOps.map(e => `- [${e.type}] ${this._formatEntry(e)}`).join('\n');
      }
    }
  }

  // --- 2.10 新增 project_context 阶段 ---
  _injectProjectContext(ctx) {
    const yingMini = this.core.getService('ying-mini');
    if (!yingMini) return;
    const rules = yingMini.getProjectRules?.();
    const repoMap = yingMini.getRepoMap?.();
    const parts = [];
    if (rules) parts.push(`## Project Rules\n${rules}`);
    if (repoMap) parts.push(`## Project Structure\n${repoMap}`);
    if (parts.length > 0) ctx.prompt += '\n\n' + parts.join('\n\n');
  }

  // --- 2.10 新增 kongmen 阶段 ---
  _injectKongmen(ctx) {
    const kongmen = this.core.getService('kongmen');
    if (!kongmen || !ctx.sessionId) return;
    const sessions = kongmen.getSessions?.() || [];
    if (sessions.length > 0) {
      ctx.prompt += `\n\n## Active Sessions\n${sessions.map(s => `- ${s}`).join('\n')}`;
    }
  }

  _formatEntry(entry) {
    if (entry.type === 'tool_call') {
      const tool = entry.content?.tool || 'unknown';
      const args = entry.content?.args ? JSON.stringify(entry.content.args) : '';
      const result = entry.content?.result ? String(entry.content.result).slice(0, 100) : '';
      let line = `Used ${tool}(${args})`;
      if (result) line += ` → ${result}`;
      return line;
    }
    if (entry.type === 'user_input') return `User: ${entry.content?.message || ''}`;
    if (entry.type === 'agent_output') return `Agent: ${entry.content?.reply || ''}`;
    return `${entry.type}: ${JSON.stringify(entry.content)}`;
  }

  _shouldCompress(entryCount) {
    if (!this.core) return false;
    const enabled = this.core.get('memory.enablePromptCompression');
    if (!enabled) return false;
    const threshold = this.core.get('memory.compressionThreshold') ?? 5;
    return entryCount >= threshold;
  }

  _tusunCompress(text) {
    let result = text;
    for (const [from, to] of PromptBuilder.COMPRESS_MAP) {
      result = result.split(from).join(to);
    }
    return result;
  }

  /**
   * 该会话的相对路径基准（R0-124）：会话声明过就按会话，否则进程默认根。
   * 单一实现，提示词的两条装配路径（万词王 / 内建）共用，避免"一个说 A 一个说 B"。
   */
  _workspaceRoot(sessionId) {
    const scoped = this.core.getService?.('workspace')?.root?.(sessionId);
    if (scoped) return scoped;
    return this.core.getData('agent.workDir') || this.core.get('agent.workDir') || process.cwd();
  }

  _injectWorkspace(ctx) {
    const workDir = this._workspaceRoot(ctx.sessionId);
    const hasPathSensitiveTool = (ctx.tools || []).some(t =>
      /^(tool-write|tool-read|tool-list|tool-glob|tool-grep|tool-mv|tool-cp|tool-rm|tool-stat)$/.test(t.name || t)
    );
    if (!hasPathSensitiveTool) return;

    ctx.prompt += `\n\n## Workspace\nCurrent directory: ${workDir}\nAll file paths MUST be RELATIVE to this directory (e.g., use "file.txt" not "${workDir}/file.txt").`;
  }

  _injectSafetyReflection(ctx) {
    const enabled = this.core.get('tools.safetyReflection');
    if (enabled === false) return;

    // 工具在真实调用面上是**对象**（`{name, ...}`）；直接 `test(t)` 会把它 ToString 成
    // `"[object Object]"`，于是这段提示永不注入。与 `_injectWorkspace` 同一写法：先取名字。
    const toolName = (t) => String(t?.name ?? t);
    const hasDangerousTool = (ctx.tools || []).some(t =>
      /(?<![a-zA-Z0-9])(write|execute|delete|bash|rm|mv|dd)(?![a-zA-Z0-9])/i.test(toolName(t))
    );
    if (!hasDangerousTool) return;

    const reflection = [
      '## Safety Reflection (Internal Check Before Acting)',
      'Before using any file-writing or command-execution tool, pause and consider:',
      '1. IS the target path within the project workspace?',
      '2. COULD this action cause data loss or system damage?',
      '3. IS there a safer alternative (read-first, backup-first, dry-run)?',
      '4. WOULD this action modify files outside the current project?',
      'If uncertain about safety, prefer the safer option and explain why.',
    ].join('\n');
    ctx.prompt += `\n\n${reflection}`;
  }

  _injectTools(ctx) {
    if (!ctx.tools.length) return;
    const model = this.core.getService('model');
    if (model?.supportsNativeTools) return;
    const normalizer = this.core.getService('tool-normalizer');
    const toolDesc = normalizer
      ? normalizer.compact(ctx.tools)
      : ctx.tools.map(t => `- ${t.name}: ${t.description}`).join('\n');
    ctx.prompt += `\n\n## Available Tools\n${toolDesc}`;
  }

  _applyPluginHooks(ctx) {
    for (const hook of this._hooks.filter(h => h.stage === 'plugins')) {
      const result = hook.fn(ctx);
      if (result instanceof Promise) result.catch(err => { this.core?.log?.('warn', '[PromptBuilder] Plugin hook error: ' + (err?.message || 'unknown')); });
    }
  }

  _formatMessages(ctx) {
    ctx.messages = [
      { role: 'system', content: ctx.prompt },
      ...ctx.history,
    ];
  }
}

export default new PromptBuilder();
