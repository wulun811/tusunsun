// examples/custom-channel.mjs — 自定义渠道插件
// 基于 ChannelBase 实现第三方 IM/聊天平台接入（如 Telegram、Discord、自定义 WebSocket 等）

import { ChannelBase } from '../plugins/channel-base.js';

class ChannelExample extends ChannelBase {
  name = 'channel-example';

  // 从配置中读取 token/API Key
  async init(core) {
    await super.init(core);
    const config = core.getService('config');
    this.apiToken = config?.get('channels.example.token') || process.env.EXAMPLE_TOKEN;

    if (!this.apiToken) {
      core.log('warn', 'channel-example: no token configured, skipping');
      this.skip = true;
      return;
    }

    core.log('info', `channel-example: initialized with API token`);
  }

  // 接收消息 → 转发到土行孙内部消息总线
  async handleMessage(raw) {
    const { sender, text, chatType } = raw;
    // 构造内部消息格式
    const msg = {
      channel: 'example',
      sender: String(sender),
      text: String(text),
      chatType: chatType || 'direct',
      timestamp: Date.now(),
      raw,
    };
    // 发送到事件总线
    this.core.emit('chat.message.inbound', msg);
  }

  // 发送回复 → 调用第三方 API
  async sendReply(sender, text, context = {}) {
    if (this.skip) return;
    try {
      // 示例：调用第三方 API 发送消息
      // const response = await fetch(`https://api.example.com/send`, {
      //   method: 'POST',
      //   headers: { Authorization: `Bearer ${this.apiToken}` },
      //   body: JSON.stringify({ to: sender, text }),
      // });
      // return await response.json();

      this.core.log('debug', `[${this.name} → ${sender}]: ${text.slice(0, 50)}...`);
      return { success: true };
    } catch (err) {
      this.core.log('error', `${this.name} send failed: ${err.message}`);
      throw err;
    }
  }

  // 可选：支持流式输出
  async *sendStreamReply(sender, text, context = {}) {
    const words = text.split(' ');
    for (const word of words) {
      yield word + ' ';
      await new Promise(r => setTimeout(r, 100));
    }
  }

  async stop() {
    this.core.log('info', 'channel-example stopped!');
  }
}

export default new ChannelExample();
