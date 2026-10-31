class HeartbeatTask {
  constructor(id, config, core) {
    this.id = id;
    this.interval = config.interval || 300000;
    this.prompt = config.prompt || HeartbeatPlugin.DEFAULT_PROMPT;
    this.notifyOn = config.notifyOn || 'important';
    this.core = core;
    this._timer = null;
    this._running = false;
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick(), this.interval);
    this._timer.unref();
    this.core.log('info', `Heartbeat task "${this.id}" started (interval: ${this.interval}ms, notify: ${this.notifyOn})`);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  async _tick() {
    if (this._running) return;
    this._running = true;
    try {
      const result = await this.core.command('chat.handle', {
        sessionId: 'heartbeat:' + this.id,
        message: this.prompt,
        internal: true,
      }, 60000);
      const reply = result?.ok ? (result.payload?.reply || '(no reply)') : '(error)';
      if (reply !== 'OK') {
        this.core.log('info', `[Heartbeat:${this.id}] ${reply}`);
        this._notify(reply);
      }
    } catch (err) {
      this.core.log('error', `Heartbeat task "${this.id}" error: ${err.message}`);
      this._notify('[error] ' + err.message);
    } finally {
      this._running = false;
    }
  }

  _notify(reply) {
    const payload = { taskId: this.id, reply, timestamp: new Date().toISOString(), level: reply.startsWith('[error]') ? 'error' : 'info' };
    this.core.emit('heartbeat.notification', payload);
  }
}

class HeartbeatPlugin {
  static DEFAULT_PROMPT = [
    '你是土行孙的后台巡检线程。',
    '',
    '请快速检查以下事项：',
    '1. 系统健康状态是否有异常',
    '2. 是否有需要用户关注的通知或事件',
    '3. 是否有到期应执行的定时任务',
    '',
    '规则：',
    '- 一切正常时，仅回复一个单词 "OK"',
    '- 有发现时，用2-3句话简明描述，不要展开',
    '- 不要调用高消耗工具（如读写大文件、执行长时间 bash 任务）',
  ].join('\n');

  name = 'heartbeat';
  version = '0.2.0';

  constructor() {
    this._tasks = new Map();
  }

  async init(core) {
    this.core = core;
    const config = core.getService('config');
    if (!config) return;

    if (config.get('heartbeat.enabled') === undefined) config.set('heartbeat.enabled', false);
    if (config.get('heartbeat.interval') === undefined) config.set('heartbeat.interval', 300000);
    if (config.get('heartbeat.prompt') === undefined) config.set('heartbeat.prompt', HeartbeatPlugin.DEFAULT_PROMPT);
    if (config.get('heartbeat.tasks') === undefined) config.set('heartbeat.tasks', []);
    if (config.get('heartbeat.notifyOn') === undefined) config.set('heartbeat.notifyOn', 'important');

    if (config.get('heartbeat.enabled')) this._start();
  }

  async start() {
    const config = this.core.getService('config');
    if (config?.get('heartbeat.enabled')) this._start();
  }

  _start() {
    const config = this.core.getService('config');
    const tasks = config?.get('heartbeat.tasks') || [];

    if (tasks.length === 0) {
      this._addDefaultTask(config);
    } else {
      for (const t of tasks) {
        this.addTask(t.id || 'task-' + this._tasks.size, t);
      }
    }
  }

  _addDefaultTask(config) {
    const task = new HeartbeatTask('default', {
      interval: config?.get('heartbeat.interval') || 300000,
      prompt: config?.get('heartbeat.prompt') || HeartbeatPlugin.DEFAULT_PROMPT,
      notifyOn: config?.get('heartbeat.notifyOn') || 'important',
    }, this.core);
    task.start();
    this._tasks.set('default', task);
  }

  addTask(id, config) {
    if (this._tasks.has(id)) {
      this.core.log('warn', `Heartbeat task "${id}" already exists, skipping`);
      return;
    }
    const task = new HeartbeatTask(id, config, this.core);
    task.start();
    this._tasks.set(id, task);
  }

  removeTask(id) {
    const task = this._tasks.get(id);
    if (!task) return;
    task.stop();
    this._tasks.delete(id);
    this.core.log('info', `Heartbeat task "${id}" removed`);
  }

  getTasks() {
    const result = {};
    for (const [id, task] of this._tasks) {
      result[id] = { interval: task.interval, notifyOn: task.notifyOn };
    }
    return result;
  }

  stop() {
    for (const [, task] of this._tasks) {
      task.stop();
    }
    this._tasks.clear();
  }
}

export default new HeartbeatPlugin();
