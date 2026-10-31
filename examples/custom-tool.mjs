// examples/custom-tool.mjs — 自定义工具示例
// 工具格式：name + version + schema + execute

export default {
  name: 'tool-time',
  version: '1.0.0',

  // AI Agent 可感知的工具描述
  schema: {
    name: 'time.now',
    description: '获取当前时间和日期，支持时区参数',
    parameters: {
      type: 'object',
      properties: {
        timezone: {
          type: 'string',
          description: '时区，如 "Asia/Shanghai"、"UTC-8"（默认本地时区）',
        }
      },
      required: [],
    },
  },

  // 工具执行逻辑
  async execute(args = {}) {
    const { timezone } = args;
    const now = new Date();

    let timeStr;
    if (timezone) {
      try {
        timeStr = now.toLocaleString('en-US', { timeZone: timezone });
      } catch {
        return {
          content: `未知时区: ${timezone}，请提供标准时区名称（如 Asia/Shanghai、UTC-8）`,
        };
      }
    } else {
      timeStr = now.toLocaleString();
    }

    return {
      content: `当前时间: ${timeStr}`,
    };
  },
};
