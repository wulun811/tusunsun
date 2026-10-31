import { ChannelBase } from '../plugins/channel-base.js';
import { request as httpsRequest } from 'node:https';

class ChannelTelegram extends ChannelBase {
  name = 'channel-telegram';
  version = '0.2.0';

  constructor() {
    super({ name: 'telegram' });
    this.botToken = '';
    this.offset = 0;
    this.polling = false;
  }

  async init(core) {
    await super.init(core);
    const config = core.getService('config');
    this.botToken = config?.get('channels.telegram.botToken') || process.env.TELEGRAM_BOT_TOKEN;
    if (!this.botToken) {
      core.log('warn', 'Telegram bot token not set, channel disabled');
      return;
    }
    core.log('info', 'Telegram channel configured');
  }

  async start() {
    if (!this.botToken) return;
    this.polling = true;
    this.core.log('info', 'Telegram polling started');
    this._poll();
  }

  async stop() {
    this.polling = false;
  }

  async _poll() {
    while (this.polling) {
      try {
        const updates = await this._getUpdates();
        for (const update of updates) {
          this.offset = update.update_id + 1;
          const msg = update.message;
          if (msg?.text) {
            await this.onInbound({
              content: msg.text,
              sender: String(msg.from.id),
              chatId: msg.chat.id,
            });
          }
        }
      } catch (err) {
        this.core.log('warn', `Telegram poll error: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  _getUpdates() {
    return new Promise((resolve, reject) => {
      const url = `https://api.telegram.org/bot${this.botToken}/getUpdates?offset=${this.offset}&timeout=5`;
      const req = httpsRequest(url, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json.ok ? json.result : []);
          } catch { resolve([]); }
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  async sendReply(sender, text, context) {
    if (!this.botToken || !context?.chatId) return;
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const body = JSON.stringify({ chat_id: context.chatId, text });

    return new Promise((resolve) => {
      const req = httpsRequest(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => resolve(data));
      });
      req.on('error', () => resolve(null));
      req.write(body);
      req.end();
    });
  }
}

export default new ChannelTelegram();
