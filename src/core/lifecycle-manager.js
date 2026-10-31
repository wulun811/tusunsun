import { AsyncLocalStorage } from 'node:async_hooks';
import { dependentsOf, resolvePendingDependency } from './dependency-resolver.js';

/**
 * 当前异步调用链持有的**活动租约**：`Map<key, { active, manager, key }>`。
 *
 * "同一异步家族"不等于"仍持有活动租约"：锁内安排但未 await 的异步后代同样继承这份上下文，
 * 只记"进过这个 key"就会让它们在外层释放后仍被认作持锁者。故存租约对象 ——
 * `finally` 里置 `active = false` 让过期上下文自然失效，`manager` 保证跨实例不互认。
 */
const _heldKeys = new AsyncLocalStorage();

/**
 * 持有段超时的哨兵。必须是**撞不上的唯一对象**：用 `undefined`/`null` 时「fn 真的返回了
 * null」与「到点了」无法区分，而两者后果完全不同（前者正常结束，后者锁还在别人手里）。
 */
const HOLD_TIMEOUT = Symbol('hold_timeout');

/**
 * 插件实例状态的**合法转移表**。词表先冻结，再谈转移：只有 7 个词属于插件实例
 * （registered | started | running | error | stopped | unloaded | unavailable）；
 * `loading` / `loaded` 写在装载尝试记录与只读视图里，**不属于插件实例** —— 混进来就是
 * "一个事实两个名字"。
 *
 * 每条边都对应一条真实路径：init→started、start→running、装配失败→error、重试→started、
 * core.stop 里 stop() 成功→stopped、Stop 窗口内未完成的装配或 reload 失败→unavailable、
 * 卸载最后一步→unloaded。`unloaded` 是终态（对象已从 `plugins` 移除，再跃迁就是两个真相），
 * 且 `unloaded → started/running` 永远非法 —— `unavailable` 不是"终态可复活"。
 */
const LEGAL_EDGES = Object.freeze({
  registered: Object.freeze(['started', 'error', 'unavailable', 'unloaded']),
  started: Object.freeze(['running', 'error', 'stopped', 'unavailable', 'unloaded']),
  running: Object.freeze(['error', 'stopped', 'unavailable', 'unloaded']),
  error: Object.freeze(['started', 'unavailable', 'unloaded']),
  stopped: Object.freeze(['unavailable', 'unloaded']),
  unavailable: Object.freeze(['started', 'unloaded']),
  unloaded: Object.freeze(['unavailable']),
});

/**
 * 插件生命周期的**唯一**状态跃迁写入者，也是 owner 级独占区的唯一实现。每个 Core 恰好一份
 * —— 再 `new` 一个不是"多一把锁"，而是"同一个 key 两把锁"：两边都串行，合起来不串行。
 */
class LifecycleManager {
  constructor(core, reap) {
    this.core = core;
    this._frozenCapabilities = new Set();
    // **同一 owner 的生命周期操作串行化**，不同 owner 并行（否则一个卡死的插件会拖住启动）。
    // 不能用"有在途就拒绝"代替：业务在途闸门拦不住同毫秒发出的三个 reload（那时 inflight
    // 都是 0），结果是三次都报成功、只有一次真正兑现。实现是每个 owner 一条 Promise 链。
    this._queues = new Map();
    // **已交出释放权**的 key：持有段超时后锁仍在那个没返回的 fn 手里。放行新调用方 =
    // 双持有者；让它排队 = 可能永远等不到。具名快速失败是唯一诚实的答复。
    this._abandoned = new Set();
    // 转移轨迹（有界）+ 非法计数："状态合法"必须可观测，不能只靠"没抛错"。
    this._transitions = [];
    this._illegalTransitions = 0;
    // 私有清场通道：**由 Core 在构造期注入一次**，不再从公开面签发（公开签发等于拿到 Core
    // 引用就能领一张管理员证件）。测试替身不传第二参数 ⇒ 空清场。
    // `new LifecycleManager(core)` 重建/替换时**复用已注入那一份、不新签发**，否则会出现
    // "换了管理器就再也清不掉资产"的隐形成本。
    const reuse = typeof core?.lifecycle?._reap === 'function' ? core.lifecycle._reap : null;
    this._reap = typeof reap === 'function' ? reap : (reuse ?? (() => ({ capabilities: [], services: [] })));
  }

  /**
   * 在 `pluginName` 的独占区里执行 `fn`。同一名字排队、不同名字并行、同一调用链且租约仍
   * 活动时可重入（见 `_heldKeys`）；返回值/异常原样透传 —— 排队只改变次序，不改变结果。
   * @param {{timeoutMs?: number, holdMs?: number}} [opts] 两个**不同阶段**的上界：
   *   `timeoutMs` 只约束**等锁**（到点抛 `lock_timeout`，且只退出自己的等待资格）；
   *   `holdMs` 只约束**持有段**（到点抛 `hold_timeout` 且**不释放锁**，释放权交给仍在跑的
   *   fn）。两者必须分开："没等上锁"的副作用确定未发生，"锁里没跑完"的确定不了。
   */
  async runExclusive(pluginName, fn, opts = {}) {
    const key = String(pluginName ?? '');
    // 可重入：`reload` 持锁期间要调 `load`/`unload`，而那两者本身也是加锁入口 —— 不认出
    // "我已在这条链里"就会自锁。用 ALS 而不是"传一个 bypass 参数"：后者漏传一处就是死锁。
    // 判据三条缺一即排队：① 租约此刻仍 active；② `lease.manager === this`（跨 Core 不互认，
    // 否则 A 的锁会给 B 开后门）；③ 租约属于本 key。
    const held = _heldKeys.getStore();
    const mine = held?.get(key);
    if (mine?.active === true && mine.manager === this) return fn();
    // 上一持有者持有段超时、至今没结账（H8）：本 key 此刻**没有可信的互斥**。
    // 放行会与它重叠，排队可能永远等不到 —— 具名失败比"悄悄并行"和"悄悄挂住"都好。
    if (this._abandoned.has(key)) {
      throw Object.assign(new Error(`lock_abandoned: "${key}" 的上一持有者超时未结账`), { code: 'lock_abandoned', key });
    }
    const nextHeld = new Map(held || []);
    // 租约先建、`active` 等真正取到锁再开：入队期间它还不是持有者。
    const lease = { active: false, manager: this, key };
    nextHeld.set(key, lease);
    return _heldKeys.run(nextHeld, async () => {
      const prev = this._queues.get(key) || Promise.resolve();
      // `next` 是"本轮结束"的信号：catch 吞掉的只是**队列推进**，
      // 调用方自己的 await 仍会收到那个异常。
      let release;
      const next = new Promise((resolve) => { release = resolve; });
      // **存进 Map 的必须是同一个对象**，否则回收判断永不成立：
      // 存包装 Promise、却拿 `next` 比较时身份永远不等，于是已完成条目永久留在 Map。
      const tail = prev.then(() => next, () => next);
      this._queues.set(key, tail);
      // **放弃等待**与**释放持有**是两件事：前者我**从没进去过**，此时删尾等于宣布"这条 key
      // 没人持有"，下一个调用方读到空 prev 就与原持有者重叠；正确动作是把队尾**退回 prev**。
      const abandon = (restore) => {
        release();
        if (this._queues.get(key) !== tail) return;
        if (restore) this._queues.set(key, prev);
        else this._queues.delete(key);
      };
      const waitMs = Number.isFinite(opts?.timeoutMs) ? opts.timeoutMs : 0;
      try {
        // 前一轮的失败不该传染给本轮：这里只等"队列推进"，不等它成功。
        await (waitMs > 0 ? this._waitBounded(prev, waitMs, key) : prev.catch(() => { /* 忽略 */ }));
      } catch (err) {
        // 等锁超时走这条：**只退出自己的等待资格**，不动持有者的链（H7）。
        abandon(true);
        throw err;
      }
      lease.active = true;
      const holdMs = Number.isFinite(opts?.holdMs) ? opts.holdMs : 0;
      // **交出释放权**：持有段到点后锁不能在这里放（放行 = 双持有者），只能等那个还在跑
      // 的 fn 自己结账。`handedOff` 让下面的 finally 闭嘴；`_abandoned` 让新调用方
      // 快速失败，而不是排进一条可能永远不动的队。
      let handedOff = false;
      try {
        if (holdMs <= 0) return await fn();
        return await this._holdBounded(key, fn, holdMs, (run) => {
          handedOff = true;
          this._abandoned.add(key);
          const settle = () => { this._abandoned.delete(key); abandon(false); };
          run.then(settle, settle);
        });
      } finally {
        lease.active = false;
        if (!handedOff) abandon(false);
      }
    });
  }

  /**
   * 有界持有。到点**不释放锁**，只"交账"：抛 `hold_timeout`，把释放权交给仍在跑的 `fn`。
   * 放行等于让新调用方与还没返回的 `stop()` 同时进入 —— 只保证**调用方的等待**有界，
   * 从不保证底层操作已经停下。
   */
  _holdBounded(key, fn, holdMs, handOff) {
    let run;
    // fn 可能**同步**抛出：`Promise.resolve(fn())` 会把异常变成 rejection，但求值时就已
    // 冒出来了，必须 try 住 —— 否则 `run` 根本没建起来，后面 `handOff(run)` 拿到 undefined。
    try { run = Promise.resolve(fn()); } catch (err) { return Promise.reject(err); }
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(HOLD_TIMEOUT), holdMs);
      // 不 unref：这个定时器就是"持有有上界"本身（同 `_waitBounded` 的实测理由）。
    });
    return Promise.race([run, timeout])
      .finally(() => { if (timer) clearTimeout(timer); })
      .then((v) => {
        if (v !== HOLD_TIMEOUT) return v;
        handOff(run);
        throw Object.assign(
          new Error(`hold_timeout: "${key}" 的独占区在 ${holdMs}ms 内没有返回`),
          { code: 'hold_timeout', key, phase: 'hold' },
        );
      });
  }

  /** 等 `prev`，最多 `waitMs`；超时抛具名 `lock_timeout`（上层据此区分"没停成"与"停下不动"）。 */
  _waitBounded(prev, waitMs, key) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(
        new Error(`lock_timeout: 等待 "${key}" 的独占区超过 ${waitMs}ms`), { code: 'lock_timeout', key },
      )), waitMs);
      // **不 unref**：这个定时器就是"等锁有上界"本身；unref 后若没有其他活句柄，
      // 进程会在它触发前退出（实测 exit 13），"有界等待"在无声处退化成"没有等待"。
    });
    return Promise.race([prev.catch(() => { /* 忽略 */ }), timeout])
      .finally(() => { if (timer) clearTimeout(timer); });
  }

  /** `force` 只给**装配失败清理**：那里要收的是一具从未 running 过的对象。 */
  async unload(pluginName, opts = {}) {
    return this.runExclusive(pluginName, () => this._unload(pluginName, opts));
  }

  async _unload(pluginName, { force = false } = {}) {
    const plugin = this.core.plugins.get(pluginName);
    // 不在核心注册表里 = 它就不在运行：对 PM 的懒账本而言这是“已释放”的可对账状态
    // （`_lazyLoaded` 里存着一个不在 `core.plugins` 的名字，本就是一本陈旧账）。
    // 注意这与 `stop_timeout` 截然相反：那一种是“还在跑，但我们不知道它停没停”。
    if (!plugin) {
      return { ok: false, pluginName, code: 'plugin_not_found', released: true, error: `Plugin not found: ${pluginName}` };
    }
    // `stop()` 抛出但卸载继续时，失败事实要能出现在回执里（`ok:true` ≠ 清理干净）。
    let lastStopFailure = null;

    this.core.emit('core:plugin.unloading', {
      pluginName,
      version: plugin.version || '0.0.0',
      state: plugin.state,
      timestamp: new Date().toISOString(),
      sourcePlugin: 'core',
    });

    // 失败清理不受依赖闸门约束：init 就抛了的插件不可能正被依赖方使用着。
    if (!force) this._step1CheckDependents(pluginName);
    this._step2FreezeCapabilities(pluginName);
    const drain = await this._step3DrainRequests(pluginName);
    if (!drain.drained) {
      // 仍会继续（卸载/关停不能因为一条卡死的链永久挂住），但调用方必须**能看见**在途被打断：
      // 这些调用的副作用是未知的。
      this.core.log('warn', `[lifecycle] unload "${pluginName}" while ${drain.inflight} call(s) still in flight — `
        + 'they will be interrupted; their side effects are indeterminate');
      // 排空超时**已经发生**，后面的 stop/cleanup 还要继续：
      // 观察者抛错不得把卸载停在"已超时但没卸"的半截状态。
      this.core.emitFact?.('core:plugin.drain_timeout', {
        pluginName, inflight: drain.inflight, timestamp: new Date().toISOString(), sourcePlugin: 'core',
      });
    }
    const stopFailure = await this._step4StopPlugin(pluginName, plugin);
    // **只有"超时"才中止清理**，`stop()` 抛异常仍然继续。
    //
    // 两者的区别是"知不知道"：
    //   · `stop()` 抛出 ⇒ 它**结束**了（虽然没清理干净），我们知道控制流已经离开它，
    //     资源归谁、还剩什么是可枚举的 —— 继续清场是对的，否则一次失败会让插件永久留在表里；
    //   · `stop()` 超时 ⇒ 它**还在跑**，此时清监听/撤登记/删状态就是从它脚下抽走对象，
    //     把"不知道"改写成"已经拆干净了"。这种才必须停手。
    if (stopFailure && stopFailure.code === 'stop_timeout') {
      this.core.log('error', `[lifecycle] unload "${pluginName}" 中止：stop() 结果未知，`
        + '不得记为已卸载，也不释放它可能仍在使用的资源');
      return {
        ok: false, pluginName, code: stopFailure.code, forced_partial: false,
        released: false, execution_outcome: 'unknown', phase: stopFailure.phase,
        error: `Plugin "${pluginName}" stop_timeout: stop() 未在限时内返回（${stopFailure.timeoutMs}ms），`
          + '它可能仍在运行；本次不释放其资源，也不记为已卸载',
      };
    }
    if (stopFailure) {
      // 抛出型失败：可观测、可继续。不改变 `ok:true`（旧语义：一次 stop 抛出不该让卸载失败），
      // 但把失败事实挂进回执，避免"卸载成功"被读成"清理干净"。
      this.core.log('error', `Plugin "${pluginName}" stop error: ${stopFailure.message}`);
      lastStopFailure = stopFailure;
    }
    this._step5CleanListeners(pluginName);
    this._step6RemoveRegistrations(pluginName, plugin);
    await this._step7CleanState(pluginName, plugin);

    this.advance(plugin, 'unloaded');
    this.core.plugins.delete(pluginName);
    this.core.log('info', `Plugin unloaded: ${this.core.colorize('cyan', pluginName)}`);
    // **`unloaded` 事实的唯一发布点**（K24-02）：三条终局分支（干净 / stop 抛过 / drain 超时）
    // 都经过这里，差别进载荷，不再各自 emit 一份。`stop_timeout` 在那之前就早退了 ——
    // `released:false` 的插件**不得**产生一条已卸载事实。
    this.core.emitFact('core:plugin.unloaded', {
      pluginName,
      name: pluginName,                  // 兼容别名
      released: true,                    // 资源已从它脚下撤走（stop_timeout 走不到这里）
      execution_outcome: drain.drained ? 'known' : 'unknown',
      ...(drain.drained ? {} : { code: 'drain_timeout', inflight: drain.inflight }),
      ...(lastStopFailure ? { stop_failed: true } : {}),
      timestamp: new Date().toISOString(),
      sourcePlugin: 'lifecycle-manager',
    });
    if (!drain.drained) {
      // 继续卸载是**判断**（否则一条卡死的链能永久挂住关机），
      // 但"我继续了"不能报成"安全卸载完成"。
      // 三件不同的事分开说：资源已释放（released）、在途被打断（inflight）、副作用未知。
      return {
        ok: false, pluginName, code: 'drain_timeout', forced_partial: true,
        inflight: drain.inflight, released: true, execution_outcome: 'unknown',
        error: `Plugin "${pluginName}" unloaded while ${drain.inflight} call(s) were in flight; `
          + 'their side effects are indeterminate',
      };
    }
    if (lastStopFailure) {
      // 卸载成功，但 stop 抛过：两件事分开报，别让 `ok:true` 把失败抹平。
      return { ok: true, pluginName, stop_failure: lastStopFailure };
    }
    return { ok: true, pluginName };
  }

  _step1CheckDependents(pluginName) {
    // 依赖边只能有一种解释：`requires` 的键可能是插件名，也可能是**服务名**。
    // 只比 `deps[pluginName]` 时，`requires:{'db-service':…}` 根本拦不住 —— 服务提供者
    // 被卸掉、服务对象消失，而依赖方仍然是 running（它以为自己还在用）。
    // 归属优先用运行时事实（`_serviceOwners`），没登记的才回退到 `provides` 声明。
    const loaded = [...this.core.plugins.values()];
    const blocker = dependentsOf(pluginName, loaded, this.core._serviceOwners)
      .find(({ plugin }) => this.core.plugins.get(plugin)?.state === 'running');
    if (blocker) {
      throw new Error(`Cannot unload "${pluginName}": "${blocker.plugin}" requires "${blocker.dep}"`);
    }
  }

  _step2FreezeCapabilities(pluginName) {
    // 走公开枚举面，不碰内部 Map。
    for (const { id, owner, provider } of this.core.listCapabilities()) if ((provider ?? owner) === pluginName) {
      this.core.freezeCapability(id);
      this.core.log('info', `Capability frozen: ${this.core.colorize('magenta', id)}`);
    }
  }

  /**
   * 等在途调用排空，并**如实返回** `{drained, inflight}`：超时之后照样 stop + 替换时，
   * 正在飞的调用被自己的插件打断、留下半截副作用，而调用方必须被告知这件事。
   */
  async _step3DrainRequests(pluginName, timeout = 5000) {
    const startTime = Date.now();
    while (this.core.getInflight(pluginName) > 0 && Date.now() - startTime < timeout) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const inflight = this.core.getInflight(pluginName);
    return { drained: inflight === 0, inflight };
  }

  /**
   * 停一个插件，**有界**。
   *
   * 判据与 `Core.stop()` 的 `_stopOnePlugin` 必须一致：那条路径早就用
   * `holdMs` 给 `stop()` 封顶：无界 `await` 会让一个永不结算的 `stop()` 把动态
   * `unload()` 永久挂住，还占着这个插件的独占区（后续同 key 操作全排队）。
   *
   * 超时**不等于停下来了**，所以：不报 `unloaded`（给 `stop_timeout` +
   * `execution_outcome:'unknown'`）；不强行释放它仍在用的资源（那会把"不知道"变成
   * "已经拆了"）；释放独占区（否则 reload 永久被拒）但记进 `_abandoned`，让下一次同 key
   * 操作具名失败，而不是悄悄与仍在跑的 `stop()` 重叠。
   *
   * 返回 `null` = 已停（或无需停）；返回记录 = 没停成，由调用方决定怎么报。
   */
  async _step4StopPlugin(pluginName, plugin) {
    // **一个对象只 stop 一次**，由状态证明：`core.stop()` 已把它推成 stopped，
    // 而 `stopped → unloaded` 是合法转移，unload 仍会走到这里（不跳过就是两次 stop）。
    if (!plugin.stop || plugin.state === 'stopped') return null;
    const holdMs = this.core._stopLockMs ?? 5000;
    let timer = null;
    // 竞速的两条都必须被消费：超时那条 reject 之后若没人接，会变成进程级 unhandledRejection。
    let stopPromise;
    try { stopPromise = Promise.resolve(plugin.stop()); }
    catch (err) {
      // 同步抛出与异步拒绝是同一件事：`stop_call` 阶段失败，清理到哪一步未知。
      this.core.log('error', `Plugin "${pluginName}" stop error: ${err?.message || err}`);
      return { plugin: pluginName, code: 'stop_error', phase: 'stop_call', execution_outcome: 'unknown', message: String(err?.message || err) };
    }
    stopPromise.catch(() => {});
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), holdMs);
    });
    let out;
    try {
      out = await Promise.race([stopPromise.then(() => ({ ok: true })), timeout]);
    } catch (err) {
      this.core.log('error', `Plugin "${pluginName}" stop error: ${err?.message || err}`);
      return { plugin: pluginName, code: 'stop_error', phase: 'stop_call', execution_outcome: 'unknown', message: String(err?.message || err) };
    } finally {
      if (timer) { clearTimeout(timer); timer = null; }
    }
    if (out?.timedOut) {
      // 到点仍在跑：**不**宣称已停，记成"上一持有者超时未结账"，后续同 key 操作拿到具名
      // `lock_abandoned` 而不是悄悄并行。标记必须**跟着那条 stop() 走**（它真返回了就撤销），
      // 否则一个迟到的返回会把这个插件永久钉在"不可再卸载"上 —— 把泄漏换成了墓碑。
      const key = String(pluginName);
      this._abandoned?.add(key);
      stopPromise.then(
        () => this._abandoned?.delete(key),
        () => this._abandoned?.delete(key),
      );
      this.core.log('error', `Plugin "${pluginName}" stop() 超过 ${holdMs}ms 未返回 —— 卸载结果未知，`
        + '不得计为已卸载；后续同件操作将具名失败而不是与它重叠');
      return { plugin: pluginName, code: 'stop_timeout', phase: 'stop_return', execution_outcome: 'unknown', timeoutMs: holdMs };
    }
    this.core.log('info', `Plugin "${pluginName}" stopped`);
    return null;
  }

  _step5CleanListeners(pluginName) {
    // 按**单次订阅记录**撤销，不能按函数对象删（那会删错别人的注册）。
    const count = this.core.offByOwner(pluginName);
    // 中间件同样按 owner 对称撤销；没有 owner 的注册保持原样。
    const pipelines = this.core.offPipelineByOwner?.(pluginName) || 0;
    if (count > 0 || pipelines > 0) {
      this.core.log('info', `Cleaned ${count} listeners + ${pipelines} middleware for "${pluginName}"`);
    }
  }

  /**
   * 交给 Core 的权威方法撤销登记，**不直接改内部 Map**。
   * 必须按 owner 精确撤销：不能因为 `svc.name === pluginName` 这类名字巧合把别人的资源删掉。
   * 真的删掉了什么，要报给调用方。
   */
  _step6RemoveRegistrations(pluginName, plugin) {
    // 按**登记实例身份**清场：公开的按名批量入口已从 Core 删除，这里用的是构造期
    // 领到的私有清场通道（专家 ID-10 / ID-13）。不持凭据的插件照样能被清干净。
    const { services, capabilities } = this._reap(pluginName, plugin ?? this.core.plugins.get(pluginName));
    if (services.length) this.core.log('info', `Released services for "${pluginName}": ${services.join(', ')}`);
    if (capabilities.length) this.core.log('info', `Released capabilities for "${pluginName}": ${capabilities.join(', ')}`);
    return { services, capabilities };
  }

  async _step7CleanState(pluginName, plugin) {
    if (plugin.persistState) {
      try {
        await plugin.persistState();
        this.core.log('info', `State persisted for "${pluginName}"`);
      } catch (err) {
        this.core.log('error', `Persist error for "${pluginName}": ${err.message}`);
      }
    }
  }

  async _loadDependencies(plugin, core, { svcIndex, pending, lazyLoadOne, epoch = null }) {
    const requires = plugin.requires || {};
    for (const depName of Object.keys(requires)) {
      // 与启动/停机/卸载同一份解释：键可能是插件名，也可能是服务名。
      // 只查 `pending.has(depName)` 时，服务名依赖的提供者永远不会被提前拉起来。
      if (!pending || typeof lazyLoadOne !== 'function') continue;
      const target = resolvePendingDependency(depName, pending);
      if (target && target !== plugin.name) await lazyLoadOne(target);
    }

    // init/start 都放进同一个 ALS 上下文：并发懒加载交错时单例字段必互相覆盖，而
    // "这次装配发布了哪些能力/服务"必须由同一本账记 —— 迟到撤销与停机闸门都靠它。
    // 失败清理只由 `load()` 的 catch 负责：两条清理路径并存会各自卸一半。
    const store = await core._runAssemblyContext(plugin.name, async () => {
      await plugin.init(core);
      this.advance(plugin, 'started');
      if (plugin.start) await plugin.start();
    }, epoch, plugin);

    for (const svcName of store.services) {
      if (!core._services.has(svcName)) {
        const provider = svcIndex?.get(svcName);
        if (provider && pending?.has(provider) && typeof lazyLoadOne === 'function') {
          await lazyLoadOne(provider);
        }
      }
    }
    return store;
  }

  async load(plugin, core, opts = {}) {
    if (!plugin?.name) throw new Error('Cannot load plugin without name');
    // 串行化（§6.2）：load 与同名 unload/reload 排队。包在这里而非调用方 ——
    // `Core.start`、`pm.loadOne`、`pm._reloadPlugin` 三条路径都直接调它，漏一条就等于没做。
    return this.runExclusive(plugin.name, () => this._load(plugin, core, opts));
  }

  async _load(plugin, core, { svcIndex, pending, lazyLoadOne, epoch = null } = {}) {
    const t0 = Date.now();
    const memBefore = process.memoryUsage().heapUsed;

    // 同一对象已注册则不必再登记：eager 路径先 `core.register`、再由 `Core.start`
    // 委托到这里启动，是正常顺序。无条件 register 会让每个 eager 插件都刷一条
    // "already registered, skipping"。重名但**不是同一对象**仍是冲突，交给 `core.register`。
    if (core.plugins.get(plugin.name) !== plugin) {
      // **注册被拒必须在任何 init/start/服务注册之前中止**：丢弃 register 的返回值时，
      // B 的 init 照样跑、state 照样写成 running、本函数照样 ok:true，而 Map 里仍是 A。
      const registered = await core.register(plugin);
      if (!registered) {
        const err = new Error(`plugin_name_conflict: 插件名 "${plugin.name}" 已被另一个实例注册；`
          + '本次装配在 init 之前中止（不得以 running 报告一个 Core 不承认的对象）');
        err.code = 'plugin_name_conflict';
        throw err;
      }
    } else if (plugin.state === 'running' || plugin.state === 'started') {
      // **同一个实例**的合法重复 load 必须幂等，不得再 init 一次。
      return { ok: true, name: plugin.name, alreadyLoaded: true };
    }

    let tracked = null;
    try {
      tracked = await this._loadDependencies(plugin, core, { svcIndex, pending, lazyLoadOne, epoch });
      // init/start 返回之后**再查一次世代**：注册那一行已经拦住了"init 内部新注册"，
      // 这里拦住的是"init 期间 Core 停了"—— 两者都是提交权问题，缺一条都留着洞。
      if (!core.isAssemblyCurrent(epoch)) {
        const err = new Error(`assembly_superseded: 插件 "${plugin.name}" 的装配在 Core 停止/换代之后才完成`);
        err.code = 'assembly_superseded';
        throw err;
      }
    } catch (err) {
      // 失败必须落到明确状态，且**不得**停在 'registered' 冒充可用。
      // 这里的标注是**尽力而为**：它不能把自己的 illegal 变成第二个异常，把真正的失败原因盖掉。
      this.advance(plugin, 'error', { bestEffort: true });
      // 按装配账精确收回本次已发布的登记：`tracked` 为空说明抛出发生在返回之前，
      // 账挂在 `err.assemblyStore` 上 —— 拿不到账时能力会一个不收回地留在表里。
      core.discardAssemblyArtifacts(tracked ?? err?.assemblyStore);
      // 清理必须指向**本 attempt 的对象**，且必须走 `force`：走依赖闸门会把失败对象留在表里，
      // 它的监听器与中间件会活过 `stop()`（`core.stop()` 只停 running/started）。
      if (core.plugins.get(plugin.name) === plugin) {
        await this.unload(plugin.name, { force: true }).catch((err2) => {
          this.core?.log?.('warn', `[lifecycle-manager] unload "${plugin.name}" after assembly failure did not finish: ${err2.message}`);
        });
      }
      throw err;
    }

    this.advance(plugin, 'running');
    // `_metrics` 是生命周期事实（init 耗时 / 内存增量 / 监听器数），
    // 由唯一的状态写入者一并产出，见 function-ownership.md 事实 #4。
    plugin._metrics = {
      initTime: Date.now() - t0,
      memoryDelta: Math.round((process.memoryUsage().heapUsed - memBefore) / 1024 / 1024 * 100) / 100,
      listeners: core.listenerCount(plugin.name),
    };
    // **已提交事实**：`advance(plugin,'running')` 已发生、`_metrics` 已写好。
    // 观察者同步抛错不得让 `_load()` reject —— 否则插件 running 却报装配失败，两个真相。
    // 装载结论由 Core 判定，旁观者看得好不好不改变它。
    // `core:plugin.unloading` 仍走 `emit`：那是提交**之前**的协调通知，允许 fail-loud 中止。
    core.emitFact('core:plugin.loaded', {
      pluginName: plugin.name,
      name: plugin.name,                 // 兼容别名：历史/外部消费者读 `name`（与 `unloaded` 同形状）
      version: plugin.version || '0.0.0',
      metrics: plugin._metrics,
      timestamp: new Date().toISOString(),
      sourcePlugin: 'lifecycle-manager',
    });
    return { ok: true };
  }

  freezeCapability(id) {
    this.core.freezeCapability(id);
    this._frozenCapabilities.add(id);
  }

  /**
   * **插件状态的唯一跃迁写入者**。
   *
   * `core.register` 写 'registered' 是初始值、不是跃迁；除此之外 `stopped` / `unavailable` /
   * `running` 都必须经这里 —— 任何旁路写 `plugin.state` 都会让同一个对象有两个真相。
   *
   * 只有唯一写入者不够：单纯赋值接受任何目标状态，"合法转移"就只是一句人工约定。
   * 所以按 `LEGAL_EDGES` 执行：非法转移抛 `invalid_state_transition`（带 from/to），
   * 并计入 `_illegalTransitions`。
   *
   * `bestEffort`：只给**失败/停止路径**用 —— 那里已经有一个待抛的错误或一个正在关机的 Core，
   * 不能再让"给状态做个标注"把局面变成另一个异常。非法转移仍然被记录（可断言），只是不抛。
   */
  advance(plugin, to, opts = {}) {
    if (!plugin || typeof plugin !== 'object') return plugin;
    const from = plugin.state;
    if (from === to) return plugin;              // 幂等重标记不是跃迁
    // 未初始化的对象等价于 `registered` 的初态：`lc._loadDependencies` 是可达的，
    // 有的调用方直接拿对象调它、不先走 `core.register`。这不放宽 registered → running，
    // 只是不把"还没入册"当成第八种状态。
    const legal = LEGAL_EDGES[from ?? 'registered'];
    if (!legal || !legal.includes(to)) {
      this._illegalTransitions++;
      const err = new Error(`invalid_state_transition: 插件 "${plugin.name}" 不允许 `
        + `${from === undefined ? '(未初始化)' : from} → ${to}`
        + `（合法出口：${legal && legal.length ? legal.join('/') : '无（终态）'}）`);
      err.code = 'invalid_state_transition';
      err.from = from; err.to = to;
      if (opts.bestEffort) {
        this.core?.log?.('warn', `[lifecycle] ${err.message}（bestEffort：按原状态保留，不覆盖失败原因）`);
        return plugin;
      }
      throw err;
    }
    plugin.state = to;
    this._transitions.push({ name: plugin.name, from, to, at: Date.now() });
    if (this._transitions.length > 200) this._transitions.shift();
    return plugin;
  }

  /** 转移轨迹（测试与取证用）。 */
  getTransitions() {
    return this._transitions.slice();
  }

  /** 非法转移次数。正常流程必须恒为 0。 */
  getIllegalTransitionCount() {
    return this._illegalTransitions;
  }
}

export { LifecycleManager };
export default LifecycleManager;
