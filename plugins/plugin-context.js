class PluginContext {
  name = 'plugin-context';
  version = '0.1.0';
  // R0-112 缺陷 2：prompt-builder 声明并注册的服务名是 `prompt`（provides = [{name:'prompt'}]），
  // 不是它的插件名。写成插件名 ⇒ 闸门查不到 provider。
  requires = { 'prompt': '>=0.5.0' };
  provides = [{ name: 'plugin-context', type: 'service' }];

  constructor() {
    this._manifests = new Map();
    this._injectedSessions = new Map();
  }

  async init(core) {
    this.core = core;
    core.registerService('plugin-context', this);
  }

  async start() {
    const pb = this.core.getService('prompt');
    if (pb) {
      pb.addHook('plugins', (ctx) => {
        const idx = this.getIndex();
        if (idx) ctx.prompt += `\n\n${idx}`;
      }, 24);
    }

    // Phase 4: 如果万词王可用，注册插件索引为万词王片段
    const wanciwang = this.core.getService('wanciwang');
    if (wanciwang && this.core.get('wanciwang.enabled') !== false) {
      wanciwang.registerFragment({
        id: 'plugin-index',
        role: 'general',
        scenario: 'any',
        model: 'any',
        priority: 40,
        estimatedTokens: 50,
        stable: false,
        condition: () => this._manifests.size > 0,
        content: () => this.getIndex(),
      });
      this.core.log('info', '[plugin-context] registered plugin-index fragment to wanciwang');
    }
  }

  register(pluginName, manifest) {
    if (this._manifests.has(pluginName)) {
      this.core.log('warn', `PCP: ${pluginName} already registered, overwriting`);
    }
    this._manifests.set(pluginName, manifest);

    if (!manifest.queryTools?.length) return;
    const registry = this.core.getService('tool-registry');
    if (!registry) return;

    for (const qt of manifest.queryTools) {
      // E2（v0.9.33）：改走 `registerTool` 门面，不再直接写 `registry._tools`。
      // 修前这里先 `has()` 再 `set()` —— 看起来像"幂等"，实际是"别人的同名工具我就不注册了"，
      // 而**静默跳过**不留下任何可诊断的痕迹。门面会回一个具名 code，至少能看见。
      const r = registry.registerTool({
        name: qt.name,
        // 归属是**插件名**而不是 'plugin-context'：这批 queryTool 是插件的代理，
        // 插件被卸载时应当能按 owner 精确摘掉，而不是把所有代理一起摘。
        owner: `plugin-context:${pluginName}`,
        description: qt.description || '',
        parameters: qt.parameters || { type: 'object', properties: {} },
        execute: async (args) => {
          const result = await this.core.command(qt.capability, args);
          return result.payload !== undefined ? result.payload : result;
        },
      });
      if (r.ok) {
        // 目录句柄按「归属插件 + 工具名」记：这批代理的 owner 是插件名，不是本插件名。
        (this._toolHandles ??= new Map()).set(`${pluginName}::${qt.name}`, r.handle);
        this.core.log('info', 'PCP: registered queryTool ' + qt.name + ' for ' + pluginName);
      } else {
        this.core.log('warn', `PCP: queryTool ${qt.name} not registered: ${r.code} ${r.error}`);
      }
    }
  }

  getIndex() {
    if (!this._manifests.size) return '';
    const lines = ['## 插件'];
    for (const [, m] of this._manifests) {
      lines.push(`- ${m.label}：${m.description}`);
    }
    return lines.join('\n');
  }

  getContextualMessages(sessionId, messages) {
    if (!sessionId || !this._manifests.size || !messages?.length) return [];

    const injected = this._injectedSessions.get(sessionId) || new Set();
    const userText = messages.filter(m => m.role === 'user')
      .map(m => typeof m.content === 'string' ? m.content : '').join('\n');
    const toolResults = messages.filter(m => m.role === 'tool')
      .map(m => typeof m.content === 'string' ? m.content : '').join('\n');
    const assistantText = messages.filter(m => m.role === 'assistant')
      .map(m => typeof m.content === 'string' ? m.content : '').join('\n');

    const extras = [];
    for (const [pluginName, m] of this._manifests) {
      if (injected.has(pluginName)) continue;

      let triggered = false;
      if (userText && m.keywords?.some(kw => userText.toLowerCase().includes(kw))) triggered = true;
      if (!triggered && m.constraints?.length && /\[BLOCKED/i.test(toolResults)) triggered = true;
      if (!triggered && m.queryTools?.some(qt => assistantText.includes(qt.name))) triggered = true;

      if (triggered) {
        extras.push({ role: 'system', content: this._buildFullContext(m) });
        injected.add(pluginName);
      }
    }

    if (extras.length) this._injectedSessions.set(sessionId, injected);
    return extras;
  }

  _buildFullContext(m) {
    const parts = ['## 插件：' + m.label + ' 使用说明\n'];
    if (m.constraints?.length) {
      parts.push('约束：');
      for (const c of m.constraints) {
        if (c.type === 'tool_blacklist') {
          parts.push('- 禁用工具：' + c.tools.join(', ') + '（' + c.reason + '）');
          if (c.hint) parts.push('  ' + c.hint);
        } else if (c.type === 'path_guard') {
          parts.push('- 禁止路径：' + c.paths.join(', ') + '（' + c.reason + '）');
        } else if (c.type === 'command_guard') {
          parts.push('- 禁止命令：' + c.commands.join(', ') + '（' + c.reason + '）');
        }
      }
      parts.push('');
    }
    if (m.instructions?.length) {
      parts.push('指令：');
      for (const i of m.instructions) parts.push('- ' + i);
      parts.push('');
    }
    if (m.queryTools?.length) {
      parts.push('可用工具：');
      for (const qt of m.queryTools) parts.push('- ' + qt.name + '：' + qt.description);
    }
    if (m.docs?.length) {
      parts.push('');
      for (const d of m.docs) parts.push(d);
    }
    return parts.join('\n');
  }

  async stop() {
    const registry = this.core.getService('tool-registry');
    if (registry) {
      for (const [pluginName, m] of this._manifests) {
        if (!m.queryTools) continue;
        for (const qt of m.queryTools) {
          // E2：按**归属插件名**注销。别家的同名工具会得到 not_owner，不会被误删。
          try {
            registry.unregisterTool({
              name: qt.name, owner: `plugin-context:${pluginName}`,
              handle: this._toolHandles?.get(`${pluginName}::${qt.name}`),
            });
          } catch { /* 尽力而为 */ }
        }
      }
    }
    this._manifests.clear();
    this._injectedSessions.clear();
  }
}

export default new PluginContext();
