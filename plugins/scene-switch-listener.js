class SceneSwitchPlugin {
  name = 'scene-switch-listener';
  version = '0.1.0';
  provides = [
    { name: 'scene.list', type: 'capability' },
    { name: 'scene.current', type: 'capability' },
    { name: 'scene.switch', type: 'capability' },
  ];

  async init(core) {
    this.core = core;
    const pm = core.getService('plugin-manager');
    const { SceneController } = await import('../src/core/scene-controller.js');
    this.sc = new SceneController(core, pm);
    core.registerService('scene-controller', this.sc);
    core.on('scene.switched', (data) => {
      this._activeScene = data.to;
    }, { owner: this.name });
  }

  async start() {
    const s = await this.sc.listScenes();
    const activeCfg = this.core.getService('config')?.get('activeScene');
    this._activeScene = activeCfg || 'gateway';

    this.core.registerCapability('scene.list', {
      description: 'List all available scenes with their schema and use cases',
      handler: async () => this._handleList(),
      owner: this.name,
    });

    this.core.registerCapability('scene.current', {
      description: 'Show current active scene with plugin states',
      handler: async () => this._handleCurrent(),
      owner: this.name,
    });

    this.core.registerCapability('scene.switch', {
      description: 'Preview or execute a scene switch. Without confirm=true, returns plan only.',
      handler: async (params) => this._handleSwitch(params),
      owner: this.name,
    });

    const pc = this.core.getService('plugin-context');
    if (pc) {
      pc.register('scene-switch-listener', {
        label: '场景切换',
        description: '工作模式选择',
        keywords: ['切换场景', 'scenes', '模式', 'gateway', 'chat', 'coding', 'iot'],
        queryTools: [
          {
            name: 'tool-scene-list',
            description: '查看当前工作模式和可用场景列表（返回场景名称和一句话描述，不含详细插件列表）',
            capability: 'scene.list',
          },
          {
            name: 'tool-scene-switch',
            description: '切换到指定场景模式，返回切换计划（哪些插件要卸载/加载），默认不执行，用户确认后再调 confirm=true',
            capability: 'scene.switch',
          },
        ],
        instructions: [
          '用户可能想切换工作模式（AI 网关 / 纯对话 / 代码开发 / IoT控制 等）',
          '先调 tool-scene-list 查看可用场景，再调 tool-scene-switch 提交换场景请求',
          '向用户展示切换计划（卸载哪些插件、加载哪些插件）和影响',
          '用户确认后，再调 tool-scene-switch({ name: "...", confirm: true }) 执行切换',
          '禁止在用户未确认的情况下直接执行切换',
        ],
      });
    }
  }

  async stop() {
    this.core.offByOwner(this.name);
  }

  async _handleList() {
    const entries = await this.sc.listScenes();
    const scenes = [];
    for (const e of entries) {
      const cfg = await this.sc.findScene(e.name);
      if (cfg) {
        scenes.push({
          name: cfg.name,
          description: cfg.description || '',
          schema: cfg.schema || null,
          pluginCount: (cfg.plugins || []).length,
        });
      }
    }
    return scenes;
  }

  async _handleCurrent() {
    const name = this._activeScene || 'gateway';
    return this.sc.show(name);
  }

  async _handleSwitch(params) {
    const { name, confirm } = params || {};
    if (!name) return { error: 'Missing required param: name' };
    const result = await this.sc.switchTo(name, { yes: !!confirm });
    return result;
  }
}

export default new SceneSwitchPlugin();
