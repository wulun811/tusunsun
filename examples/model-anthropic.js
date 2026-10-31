import { request as httpsRequest } from 'node:https';

class ModelAnthropic {
  name = 'model-anthropic';
  version = '0.1.0';

  async init(core) {
    this.core = core;
  }

  async call(messages, tools = []) {
    const apiKey = this.core.get('channels.anthropic.apiKey') || process.env.ANTHROPIC_API_KEY;
    const model = this.core.get('model.anthropicModel') || 'claude-sonnet-4-20250514';

    if (!apiKey) {
      return { content: '[Error] No Anthropic API key configured' };
    }

    const systemMsg = messages.find(m => m.role === 'system');
    const apiMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));

    const body = JSON.stringify({
      model,
      messages: apiMessages,
      system: systemMsg?.content,
      max_tokens: 4096,
      tools: tools.length ? tools : undefined,
    });

    return new Promise((resolve) => {
      const req = httpsRequest('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.error) {
              resolve({ content: `[Anthropic Error] ${json.error.message}` });
              return;
            }
            const result = { content: '' };
            for (const block of json.content || []) {
              if (block.type === 'text') result.content += block.text;
              if (block.type === 'tool_use') {
                result.tool_calls = result.tool_calls || [];
                result.tool_calls.push({
                  id: block.id,
                  name: block.name,
                  arguments: JSON.stringify(block.input),
                });
              }
            }
            resolve(result);
          } catch {
            resolve({ content: `[Anthropic Error] Invalid response` });
          }
        });
      });
      req.on('error', (err) => resolve({ content: `[Anthropic Error] ${err.message}` }));
      req.write(body);
      req.end();
    });
  }
}

export default new ModelAnthropic();
