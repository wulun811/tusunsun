// examples/capability-plugin.mjs — 带能力的插件示例
// 注册自定义服务 + 能力，供其他插件或 AI 调用

export default {
  name: 'weather',
  version: '1.0.0',

  async init(core) {
    this.core = core;
    this.cache = {}; // 天气数据缓存

    // 注册服务 — 其他插件可以 core.getService('weather') 获取
    core.registerService('weather', this);

    // 注册能力 — 可通过 core.command('weather.query', args) 调用
    core.registerCapability('weather.query', {
      description: '查询指定城市的天气',
      handler: (args) => this.queryWeather(args.city),
      owner: 'weather',
    });

    // 注册工具 — 可供 AI Agent 使用
    core.registerCapability('weather.weather-today', {
      description: `查询今日天气
参数: city (string) — 城市名，如 "Beijing"
返回: 温度、湿度、天气状况`,
      handler: (args) => this.queryWeather(args.city),
      owner: 'weather',
    });

    core.log('info', 'Weather plugin initialized!');
  },

  async queryWeather(city) {
    if (!city) {
      return { error: '请指定城市', city };
    }

    // 缓存检查（5 分钟）
    const cached = this.cache[city];
    if (cached && Date.now() - cached.timestamp < 5 * 60 * 1000) {
      this.core.log('debug', `Returning cached weather for ${city}`);
      return { ...cached.data, cached: true };
    }

    // 模拟天气数据（实际项目中替换为真实 API 调用）
    const weather = {
      city,
      temperature: 22,
      humidity: 65,
      condition: '晴',
      timestamp: Date.now(),
    };

    this.cache[city] = { data: weather, timestamp: Date.now() };
    this.core.emit('weather.updated', weather);

    return weather;
  },

  async start() {
    this.core.log('info', 'Weather plugin started with caching enabled');

    // 定时刷新缓存（可选）
    this.interval = setInterval(() => {
      this.cache = {};
      this.core.log('debug', 'Weather cache cleared');
    }, 30 * 60 * 1000); // 30 分钟清空
  },

  async stop() {
    if (this.interval) clearInterval(this.interval);
    this.cache = {};
    this.core.log('info', 'Weather plugin stopped!');
  }
};
