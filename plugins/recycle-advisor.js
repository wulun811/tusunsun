// `recycle-advisor` 参考实现：把「哪些懒插件该回收」从内核搬到可装卸的插件里。内核只执行
// （`_checkIdle` 读 `getService('recycle-advisor').pollRecycleDecisions()`），策略归这里。
//
// 只读公开事实（`core:plugin.{loaded,unloaded,recycled}`），不碰 PluginManager 私有账。
// 因此策略是**年龄制**（装着多久），不是空闲制：内核今天不发布能力调用事实，
// 编一个「上次被调用」就是假策略。
//
// 自负边界：没见过 loaded 的不下单；冷却期内不重复下单；一次不超过 maxPerPoll。
// 配置 `recycleAdvisor`：maxAgeMs(30min) / rules{name:ms} / cooldownMs(60s) / maxPerPoll(3)。

const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 60 * 1000;
const DEFAULT_MAX_PER_POLL = 3;

class RecycleAdvisor {
  name = 'recycle-advisor';
  version = '0.1.0';
  provides = [{ name: 'recycle-advisor', type: 'service' }];

  constructor() {
    this._loadedAt = new Map();   // 名字 → 装载时刻（只从 loaded 事实里拿）
    this._advisedAt = new Map();  // 名字 → 上次下单时刻
    this._now = () => Date.now();
  }

  async init(core) {
    this.core = core;
    // 模块级单例：同一进程的第二个 Core 会复用它，所以这本账在 init 里重置，不跨 Core 串。
    this._loadedAt = new Map();
    this._advisedAt = new Map();
    const mine = { owner: this.name };

    core.on('core:plugin.loaded', (f) => {
      const n = f?.name ?? f?.pluginName;
      if (n) this._loadedAt.set(n, this._now());      // 重载就重新计时：年龄是"这一份"的
    }, mine);

    const forget = (f) => {
      const n = f?.name ?? f?.pluginName;
      if (!n) return;
      this._loadedAt.delete(n);
      this._advisedAt.delete(n);
    };
    core.on('core:plugin.unloaded', forget, mine);
    core.on('core:plugin.recycled', forget, mine);

    core.registerService('recycle-advisor', {
      pollRecycleDecisions: () => this.pollRecycleDecisions(),
    }, { owner: this.name });

    this.core.log('info', `recycle-advisor ready (maxAge ${this._cfg().maxAgeMs}ms)`);
  }

  _cfg() {
    const raw = this.core?.get?.('recycleAdvisor') ?? {};
    const num = (v, d) => (Number.isFinite(v) && v > 0 ? v : d);
    return {
      maxAgeMs: num(raw.maxAgeMs, DEFAULT_MAX_AGE_MS),
      cooldownMs: num(raw.cooldownMs, DEFAULT_COOLDOWN_MS),
      maxPerPoll: num(raw.maxPerPoll, DEFAULT_MAX_PER_POLL),
      rules: raw.rules && typeof raw.rules === 'object' ? raw.rules : {},
    };
  }

  /** 内核每次巡检（默认 30s）调一次。必须同步返回、且不抛 —— 它是可选角色，坏了不能拖停回收。 */
  pollRecycleDecisions() {
    try {
      const { maxAgeMs, cooldownMs, maxPerPoll, rules } = this._cfg();
      const now = this._now();
      const out = [];
      for (const [n, at] of this._loadedAt) {
        const age = now - at;
        const limit = Number.isFinite(rules[n]) && rules[n] > 0 ? rules[n] : maxAgeMs;
        if (age < limit) continue;
        const last = this._advisedAt.get(n);
        if (last != null && now - last < cooldownMs) continue;
        out.push({ name: n, reason: `age_exceeded:${limit}ms`, idle_ms: age });
        this._advisedAt.set(n, now);
        if (out.length >= maxPerPoll) break;   // 一顿全回收会让一次巡检变成一次雪崩
      }
      return out;
    } catch (err) {
      this.core?.log?.('warn', `[recycle-advisor] poll failed: ${err?.message || err}`);
      return [];
    }
  }
}

// 导出实例而不是类：装载器问的是对象上的 name + init（类的 init 在 prototype 上）—— S7 同判据。
export default new RecycleAdvisor();
