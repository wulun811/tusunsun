class AgentPlugin {
  name = 'agent';
  version = '0.3.0';
  requires = { 'model': '>=0.3.0' };
  permissions = ['fs.read', 'fs.write'];
  _turns = 0;

  constructor() {
    this.tools = new Map();
  }

  async init(core) {
    this.core = core;

    core.registerCapability('chat.handle', {
      description: 'Handle a chat message and return a reply',
      handler: (params) => this.chat(params.message, params.sessionId, params.stream),
      owner: 'agent',
    });

    core.on('tool.registered', (tool) => {
      this.tools.set(tool.name, tool);
    }, { owner: 'agent' });
  }

  async chat(message, sessionId = 'default', stream = false) {
    const model = this.core.getService('model');
    const session = this.core.getService('session');
    if (!model) throw new Error('No model service available');

    const history = await session?.loadSession?.(sessionId) || [];
    history.push({ role: 'user', content: message });
    const maxTurns = this.core.get('agent.maxTurns') || 10;

    const systemPrompt = this.core.get('agent.systemPrompt') ||
      'You are 土行孙, a helpful AI assistant. Be concise and direct.';
    const tools = Array.from(this.tools.values()).map(t => ({
      name: t.name, description: t.description || '',
      parameters: t.parameters || { type: 'object', properties: {} },
    }));

    let messages = [{ role: 'system', content: systemPrompt }, ...history];
    let turn = 0;

    while (turn < maxTurns) {
      turn++;
      const result = stream && model.streamChat
        ? await this._streamLoop(model, messages, tools, sessionId, session, history)
        : await model.call(messages, tools);

      if (result.content && !result.tool_calls?.length) {
        return this._finalizeReply(result.content, sessionId, session, history, stream);
      }

      if (result.tool_calls) {
        messages.push({ role: 'assistant', content: result.content, tool_calls: result.tool_calls });
        await this._handleToolCalls(result.tool_calls, messages);
      } else {
        return this._finalizeReply(result.content || '', sessionId, session, history, stream);
      }
    }

    const fallback = 'Max turns reached.';
    history.push({ role: 'assistant', content: fallback });
    session?.saveHistory?.(sessionId, history);
    return { reply: fallback, sessionId };
  }

  _finalizeReply(content, sessionId, session, history, stream) {
    if (!stream) {
      history.push({ role: 'assistant', content });
      session?.saveHistory?.(sessionId, history);
    }
    this.core.emit('chat.reply', { sessionId, content, timestamp: new Date().toISOString(), sourcePlugin: 'agent' });
    return { reply: content, sessionId };
  }

  async _handleToolCalls(toolCalls, messages) {
    for (const tc of toolCalls) {
      const tool = this.tools.get(tc.name);
      let toolResult;
      if (tool) {
        let args;
        try { args = JSON.parse(tc.arguments || '{}'); } catch { args = {}; }
        toolResult = await tool.execute(args);
      } else {
        toolResult = `Tool "${tc.name}" not found`;
      }
      messages.push({
        role: 'tool', tool_call_id: tc.id,
        content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
      });
    }
  }

  async _streamLoop(model, messages, tools, sessionId, session, history) {
    let fullContent = '';
    for await (const chunk of model.streamChat(messages, tools)) {
      if (chunk.content) {
        fullContent += chunk.content;
        this.core.emit('chat.stream.chunk', { sessionId, content: chunk.content, timestamp: new Date().toISOString(), sourcePlugin: 'agent' });
      }
      if (chunk.tool_calls) {
        return { content: fullContent, tool_calls: chunk.tool_calls };
      }
    }
    history.push({ role: 'assistant', content: fullContent });
    session?.saveHistory?.(sessionId, history);
    return { content: fullContent };
  }
}

export default new AgentPlugin();
