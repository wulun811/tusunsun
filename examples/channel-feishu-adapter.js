/**
 * feishu-adapter.js — 飞书 WS 长连接适配器 (POC 验证版本)
 *
 * 职责: WS 连接管理、消息事件分发、发送文本/卡片/编辑卡片、令牌桶限流
 * POC 验证日期: 2026-05-03
 * 零新依赖: 仅使用 @larksuiteoapi/node-sdk (用户需 npm install)
 */

import EventEmitter from 'node:events';

class FeishuAdapter {
  name = 'feishu-adapter';
  version = '0.8.2';
  provides = [{ name: 'feishu.adapter', type: 'service' }];

  constructor() {
    this.core = null;
    this.lark = null;
    this.wsClient = null;
    this.eventDispatcher = null;
    this.ready = false;
    this.events = new EventEmitter();
    this.patchQueue = [];
    this.patchTimer = null;
    this.patchRunning = false;
    this.cardkitDisabled = false;
  }

  async init(core) {
    this.core = core;
    core.registerService('feishu-adapter', this);

    try {
      this.lark = await import('@larksuiteoapi/node-sdk');
    } catch {
      core.log('warn', '[feishu] @larksuiteoapi/node-sdk 未安装，飞书渠道不可用');
      return;
    }

    core.log('info', '[feishu] SDK loaded, initializing adapter');
  }

  async start() {
    if (!this.lark) return;

    const config = this.core.getService('config');
    const appId = config?.get('feishu.appId');
    const appSecret = config?.get('feishu.appSecret');

    if (!appId || !appSecret) {
      this.core.log('warn', '[feishu] 缺少 feishu.appId/feishu.appSecret 配置');
      return;
    }

    this.cardkitDisabled = config?.get('feishu.DISABLE_FEISHU_CARDKIT') || false;

    this.core.log('info', `[feishu] 启动 WS 长连接 (app=${appId.slice(0, 8)}...)`);

    this.eventDispatcher = new this.lark.EventDispatcher({}).register({
      'im.message.receive_v1': (data) => this._onMessage(data),
      'card.action.trigger': (data) => this._onCardAction(data),
    });

    this.wsClient = new this.lark.WSClient({ appId, appSecret });
    this.wsClient.start({ eventDispatcher: this.eventDispatcher });

    this.ready = true;
    this.core.log('info', '[feishu] WS 长连接已启动');
  }

  async stop() {
    this.ready = false;
    if (this.wsClient) {
      try { this.wsClient.stop(); } catch (e) { this.core?.log('warn', `[feishu] stop error: ${e.message}`) }
    }
    if (this.patchTimer) {
      clearTimeout(this.patchTimer);
      this.patchTimer = null;
    }
    this.core.log('info', '[feishu] 飞书适配器已停止');
  }

  _parseContent(contentStr) {
    try {
      const parsed = JSON.parse(contentStr);
      return { text: parsed.text || '', type: parsed.text ? 'text' : 'unknown', raw: parsed };
    } catch {
      return { text: String(contentStr), type: 'unknown', raw: contentStr };
    }
  }

  _onMessage(data) {
    if (!this.ready) return;

    this.core.log('debug',
      `[feishu] msg from=${data.sender?.sender_id?.open_id?.slice(0, 10)} type=${data.message?.chat_type}`);

    if (data.sender?.sender_type === 'app') return;

    const content = this._parseContent(data.message?.content || '{}');

    this.events.emit('message', {
      sender: data.sender?.sender_id?.open_id,
      chatId: data.message?.chat_id,
      chatType: data.message?.chat_type,
      messageId: data.message?.message_id,
      content: content.text,
      contentType: content.type,
      timestamp: data.create_time,
      raw: data,
    });
  }

  _onCardAction(data) {
    if (!this.ready) return;

    const action = data.action || {};
    this.core.log('info', `[feishu] card action: ${JSON.stringify(action.value)}`);

    this.events.emit('card_action', {
      actionId: action.value?.action || action.value,
      actionValue: action.value,
      chatId: data.open_chat_id || data.chat_id,
      userId: data.open_id || data.user_id,
      raw: data,
    });
  }

  on(event, handler) {
    this.events.on(event, handler);
  }

  async sendMessage(chatId, text) {
    if (!this.lark || !this.ready) {
      this.core.log('warn', '[feishu] SDK not ready, cannot send message');
      return null;
    }

    try {
      const client = new this.lark.Client({
        appId: this.core.getService('config')?.get('feishu.appId'),
        appSecret: this.core.getService('config')?.get('feishu.appSecret'),
      });

      const res = await client.im.v1.message.create({
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
        params: { receive_id_type: 'chat_id' },
      });

      this.core.log('debug', `[feishu] sent msg: ${res.data?.message_id || 'ok'}`);
      return res.data?.message_id;
    } catch (err) {
      this.core.log('error', `[feishu] send msg failed: ${err.message}`);
      try {
        this.core.emitFast('http.error', {
          method: 'POST', url: '/im/v1/messages', statusCode: err.status || 0,
          error: err.message,
          timestamp: Date.now(),
          sourcePlugin: 'feishu-adapter',
        });
      } catch {}
      return null;
    }
  }

  async sendCard(chatId, title, content, buttons) {
    if (this.cardkitDisabled) {
      return this.sendMessage(chatId, content);
    }

    if (!this.lark || !this.ready) return null;

    try {
      const client = new this.lark.Client({
        appId: this.core.getService('config')?.get('feishu.appId'),
        appSecret: this.core.getService('config')?.get('feishu.appSecret'),
      });

      const card = {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: title }, template: 'blue' },
        elements: [
          { tag: 'div', text: { tag: 'plain_text', content } },
          ...(buttons && buttons.length > 0
            ? [{
                tag: 'action',
                actions: buttons.map((b, i) => ({
                  tag: 'button',
                  text: { tag: 'plain_text', content: b.label },
                  type: i === 0 ? 'primary' : 'default',
                  value: { action: b.value, index: i },
                })),
              }]
            : []),
        ],
      };

      const res = await client.im.v1.message.create({
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
        params: { receive_id_type: 'chat_id' },
      });

      return res.data?.message_id;
    } catch (err) {
      this.core.log('error', `[feishu] send card failed: ${err.message}`);
      try {
        this.core.emitFast('http.error', {
          method: 'POST', url: '/im/v1/messages', statusCode: err.status || 0,
          error: err.message,
          timestamp: Date.now(),
          sourcePlugin: 'feishu-adapter',
        });
      } catch {}
      return null;
    }
  }

  async patchCard(messageId, title, content) {
    if (this.cardkitDisabled) return;
    if (!messageId) return;

    this.core.log('debug', `[feishu] patch card: ${messageId.slice(0, 10)}...`);

    this.patchQueue.push({ messageId, title, content });
    this._flushPatch();
  }

  _flushPatch() {
    if (this.patchRunning || this.patchQueue.length === 0 || this.patchTimer) return;

    this.patchTimer = setTimeout(async () => {
      this.patchTimer = null;
      this.patchRunning = true;

      const batch = [...this.patchQueue];
      this.patchQueue.length = 0;

      const last = batch[batch.length - 1];
      if (last) {
        try {
          const client = new this.lark.Client({
            appId: this.core.getService('config')?.get('feishu.appId'),
            appSecret: this.core.getService('config')?.get('feishu.appSecret'),
          });

          const card = {
            config: { wide_screen_mode: true },
            header: { title: { tag: 'plain_text', content: last.title }, template: 'blue' },
            elements: [{ tag: 'div', text: { tag: 'plain_text', content: last.content } }],
          };

          await client.im.v1.message.patch({
            params: { message_id: last.messageId },
            data: { msg_type: 'interactive', content: JSON.stringify(card) },
          });
        } catch (err) {
          this.core.log('error', `[feishu] patch failed: ${err.message}`);
          try {
            this.core.emitFast('http.error', {
              method: 'PATCH', url: '/im/v1/messages/' + last.messageId.slice(0, 10),
              statusCode: err.status || 0,
              error: err.message,
              timestamp: Date.now(),
              sourcePlugin: 'feishu-adapter',
            });
          } catch {}
        }
      }

      this.patchRunning = false;
      this._flushPatch();
    }, 200);
  }

  async sendApprovalCard(chatId, title, content, buttons) {
    if (this.cardkitDisabled) {
      return this.sendMessage(chatId, content);
    }

    const approvalButtons = buttons || [
      { label: '✅ 通过', value: 'approve' },
      { label: '❌ 拒绝', value: 'reject' },
    ];

    return this.sendCard(chatId, title, content, approvalButtons);
  }
}

export default new FeishuAdapter();
