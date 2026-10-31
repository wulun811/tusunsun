class PromptTemplate {
  name = 'prompt-template';
  version = '0.4.0';
  permissions = [];
  provides = [{ name: 'prompt-template', type: 'service' }];

  constructor() {
    this._vars = new Map();
  }

  async init(core) {
    this.core = core;
    core.registerService('prompt-template', this);
  }

  render(template, variables = {}) {
    // R0-124：`{{workspace}}` 默认取**调用方传入的那个会话**的根；没传会话标识就还是进程默认。
    // 调用方也可以直接传 `workspace` 覆盖（展开顺序里 `variables` 优先级更高）。
    const merged = { ...this._defaults(variables.sessionId), ...Object.fromEntries(this._vars), ...variables };
    return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, key) => {
      return merged[key] !== undefined ? String(merged[key]) : `{{${key}}}`;
    });
  }

  setVar(name, value) {
    this._vars.set(name, value);
  }

  _defaults(sessionId) {
    return {
      time: new Date().toLocaleString(),
      date: new Date().toLocaleDateString(),
      year: String(new Date().getFullYear()),
      user: this.core.get('user.name') || 'user',
      workspace: this.core.getService?.('workspace')?.root?.(sessionId)
        || this.core.getData('agent.workDir') || this.core.get('agent.workDir') || process.cwd(),
      model: this.core.get('model.model') || 'unknown',
    };
  }
}

export default new PromptTemplate();
