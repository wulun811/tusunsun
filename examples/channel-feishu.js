/**
 * feishu-channel.js — 飞书渠道插件
 *
 * 职责: 继承 ChannelBase、open_id → sessionId 映射、消息路由
 * POC 验证日期: 2026-05-03
 *
 * 事件数据结构 (POC 验证):
 *   data.message.content = '{"text":"..."}' (JSON 字符串)
 *   data.message.chat_id = "oc_xxx"
 *   data.message.message_id = "om_xxx"
 *   data.sender.sender_id.open_id = "ou_xxx"
 */

import { ChannelBase } from '../plugins/channel-base.js';

class FeishuChannel extends ChannelBase {
  name = 'feishu-channel';
  version = '0.8.2';
  provides = [{ name: 'feishu.channel', type: 'service' }];
  requires = { 'feishu-adapter': '>=0.8.0' };

  constructor() {
    super({ name: 'feishu' });
    this.adapter = null;
  }

  async init(core) {
    await super.init(core);

    this.adapter = core.getService('feishu-adapter');
    if (!this.adapter || !this.adapter.ready) {
      core.log('warn', '[feishu-channel] 飞书适配器不可用，跳过');
      return;
    }

    this.adapter?.on('message', (msg) => this._onFeishuMessage(msg));
    this.adapter?.on('card_action', (data) => this._onCardAction(data));

    core.log('info', '[feishu-channel] 已注册');
  }

  _onFeishuMessage(msg) {
    const parsed = this.parseMessage({
      content: msg.content,
      sender: msg.sender,
      chatId: msg.chatId,
      chatType: msg.chatType,
      messageId: msg.messageId,
      raw: msg.raw,
      timestamp: msg.timestamp,
    });

    if (parsed) this.onInbound(parsed);
  }

  _onCardAction(data) {
    this.core.log('info', `[feishu] card action: ${data.actionId} from ${data.userId?.slice(0, 10)}...`);

    this.core.emit('feishu.card_action', {
      ...data,
      timestamp: new Date().toISOString(),
      sourcePlugin: 'feishu-channel',
    });
  }

  parseMessage(raw) {
    if (!raw?.content && !raw.raw?.message?.content) return null;

    const sender = raw.sender || 'unknown';
    const chatId = raw.chatId || '';
    const chatType = raw.chatType || 'unknown';

    return {
      content: raw.content || '',
      sender,
      sessionId: this.makeSessionId(sender),
      chatId,
      chatType,
      messageId: raw.messageId,
      timestamp: raw.timestamp || Date.now(),
      raw,
    };
  }

  makeSessionId(sender) {
    return `feishu_${sender}`;
  }

  async sendReply(sender, text, context) {
    if (!this.adapter || !this.adapter.ready) {
      this.core.log('warn', `Channel "feishu-channel" sendReply skipped (adapter not ready)`);
      return;
    }

    const chatId = context?.chatId;
    if (!chatId) {
      this.core.log('warn', `[feishu] sendReply: no chatId, cannot reply to ${sender.slice(0, 10)}...`);
      return;
    }

    await this.adapter.sendMessage(chatId, text);
  }

  async sendCard(chatId, title, content, buttons) {
    return this.adapter?.sendCard(chatId, title, content, buttons);
  }

  async sendApprovalCard(chatId, title, content, buttons) {
    return this.adapter?.sendApprovalCard(chatId, title, content, buttons);
  }

  async patchCard(messageId, title, content) {
    return this.adapter?.patchCard(messageId, title, content);
  }

  async stop() {
    this.core.log('info', '[feishu-channel] 已停止');
  }
}

export default new FeishuChannel();
