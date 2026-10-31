class ToolNormalizer {
  name = 'tool-normalizer';
  version = '0.4.0';
  permissions = [];
  // R0-112 缺陷 2：`init()` 注册的服务名是 `tool-normalizer`，但这里此前**没有声明它**，
  // 反而声明了三个从未 registerService 过的名字（它们是本插件的方法，不是可 getService 的服务）。
  // 后果：prompt-builder 的 `requires = { 'tool-normalizer' }` 查不到 provider（假违例）；
  // 而任何人 require 那三个名字都会拿到「闸门说 OK、运行期 undefined」的假绿灯。
  provides = [
    { name: 'tool-normalizer', type: 'service', removable: false },
    { name: 'tool.toOpenAI', type: 'capability', removable: false },
    { name: 'tool.toAnthropic', type: 'capability', removable: false },
    { name: 'tool.describe', type: 'capability', removable: false },
  ];

  async init(core) {
    this.core = core;
    core.registerService('tool-normalizer', this);
  }

  toOpenAI(tools) {
    return tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.parameters || { type: 'object', properties: {} },
      },
    }));
  }

  toAnthropic(tools) {
    return tools.map(t => ({
      name: t.name,
      description: t.description || '',
      input_schema: t.parameters || { type: 'object', properties: {} },
    }));
  }

  describe(tools) {
    return tools.map(t => {
      const params = Object.entries(t.parameters?.properties || {})
        .map(([k, v]) => `  - ${k}: ${v.description || v.type || 'any'}`)
        .join('\n');
      return params
        ? `${t.name}: ${t.description}\n${params}`
        : `${t.name}: ${t.description}`;
    }).join('\n\n');
  }

  compact(tools) {
    return tools.map(t => `- ${t.name}: ${t.description || ''}`).join('\n');
  }
}

export default new ToolNormalizer();
