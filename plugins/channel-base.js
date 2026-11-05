// 渠道扩展基类 —— 公开 API。
//
// v0.9.27：本文件此前还定义了一个 `ChannelREST`（`name='channel-rest'`），它**从未被装载过**：
//   · 默认导出是基类 `ChannelBase`，`init` 在原型上，装载器按 `plugin.init` 判定（取不到）⇒ 整文件跳过；
//   · 即便被装载，它订阅的是 `channel.rest.message` —— 全仓**没有任何地方 emit 这个事件**；
//     它发出的 `channel.reply` 也**没有任何监听者**。
//   · 全仓与下游接入方均零引用，无任何 import 依赖它。
// 于是它是"订阅一个永不发生的事件、发出一个无人监听的事件"的死代码。已删除。
// 若将来要提供 REST 渠道，正确的做法是**单独一个** `plugins/channel-rest.js`、默认导出实例
// （`export default new ChannelXXX()`），并在网关侧真的 emit `channel.rest.message` ——
// 仅仅把类搬到独立文件并不够：装载器要的是导出对象上就有 `name` 与 `init`。
//
// 本文件现在只做一件事：给第三方 IM/聊天平台接入提供可继承的基类（见 examples/custom-channel.mjs）。

class ChannelBase {
  constructor(options = {}) {
    this.name = options.name || 'unnamed';
    this.core = null;
    this.onMessage = null;
  }

  async init(core) {
    this.core = core;
  }

  makeSessionId(sender) {
    return `ch_${this.name}_${sender}`;
  }

  async onInbound(raw) {
    const msg = this.parseMessage(raw);
    if (!msg) return;

    const sessionId = msg.sessionId || this.makeSessionId(msg.sender);
    const result = await this.core.command('chat.handle', {
      message: msg.content,
      sessionId,
    });

    if (result.ok && result.payload?.reply) {
      await this.sendReply(msg.sender, result.payload.reply, msg.raw);
    }
  }

  parseMessage(raw) {
    return { content: String(raw), sender: 'unknown', sessionId: null, raw };
  }

  async sendReply(sender, text, context) {
    this.core.log('warn', `Channel "${this.name}" sendReply not implemented`);
  }

  async start() {}
  async stop() {}
}

export { ChannelBase };
export default ChannelBase;
