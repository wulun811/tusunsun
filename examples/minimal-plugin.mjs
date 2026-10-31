// examples/minimal-plugin.mjs — 最简插件示例
// 复制此文件到 plugins/my-plugin.js 即生效

export default {
  name: 'my-plugin',
  version: '1.0.0',

  async init(core) {
    this.core = core;
    core.log('info', 'My plugin initialized!');

    // 获取配置
    const config = core.getService('config');
    const mySetting = config?.get('my-plugin.enabled');

    // 监听事件
    core.on('app.started', () => {
      this.core.log('info', 'App started, my plugin is ready!');
    });
  },

  async start() {
    this.core.log('info', 'My plugin started!');
    // 注册服务（供其他插件调用）
    this.core.registerService('my-service', {
      greet: (name) => `Hello, ${name}!`,
    });
  },

  async stop() {
    this.core.log('info', 'My plugin stopped!');
    // 清理资源：清除定时器、关闭连接等
  }
};
