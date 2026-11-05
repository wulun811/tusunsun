import { readdir, stat } from 'node:fs/promises';
import { watch, realpathSync, readFileSync, existsSync } from 'node:fs';
import { join, extname, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractPluginMeta, readFileHeader, isValidPluginName } from './plugin-meta.js';
import { DependencyResolver } from './dependency-resolver.js';


/**
 * 卸载回执里"资源是否真从它脚下撤走"的**唯一**判据（K24-05）。
 *
 * `ok:true` = 干净成功；`ok:false, released:true` = 资源已撤但在途副作用未知（drain_timeout）；
 * `ok:false, released:false` = stop 超时、插件可能还在跑 —— 这一种绝不能被当成已卸载。
 */
const isReleased = (r) => r?.ok === true || r?.released === true;

const IDLE_TTL = 5 * 60 * 1000;
const MIN_LIVED = 1 * 60 * 1000;
const IDLE_CHECK_INTERVAL = 30 * 1000;
const LOAD_TIMEOUT = 30000;

const RECYCLE_POLL_INTERVAL = 30 * 1000;

class PluginManager {
  constructor(core) {
    this.core = core;
    this.dirs = [];
    this.watcher = null;
    this.resolver = new DependencyResolver(core);
    // 生命周期独占区**只有一份**：由 Core 构造时创建。装配（Core.start）、懒加载、
    // 重载、卸载、场景切换都排同一条队列 —— 每个 key 一把锁，全进程一个写者。
    // 自建第二个实例不是"多一把锁"，而是"同一 key 两把锁"：两边各自串行，合起来不串行。
    this.lc = core.lifecycle;
    this._loaded = [];
    this._dedupSkipped = [];   // R0-104：同实现重名被静默跳过的记录（不刷日志，但可查）
    this._pending = new Map();
    this._providesIndex = new Map();
    this._svcIndex = new Map();
    this._wildcardIndex = new Map();
    this._lazyLoaded = new Set();
    this._lastAccess = new Map();
    this._loading = new Map();
    this._idleTimer = null;
    this._idleTTL = core.get('plugin.idleTTL') || IDLE_TTL;
    this._minLived = core.get('plugin.minLived') || MIN_LIVED;
    this._eager = new Set();
    this._pluginFilePaths = new Map();
    this._loadTime = new Map();
    this._lastRecycleTime = new Map();
    // 每次懒加载的去向（含"超时后仍在飞""迟到成功"），供 describeLazyLoad 查询。
    this._loadOutcomes = new Map();
    this._revokeIntent = new Set();   // 场景撤销了索引、但插件此刻仍装载着（见 reconcileLazy/_recycle）
    // 懒加载等候上限：可被 `plugin.loadTimeoutMs` 覆盖。
    // 存在的理由有两个：① 生产环境可按插件体量调大；② 让"超时后迟到成功"这条路径
    // **可被测试驱动**——否则它只能在真实等满 30 秒后才发生，等于永远没有回归锁。
    this._loadTimeoutMs = core.get('plugin.loadTimeoutMs') || LOAD_TIMEOUT;
    this._reloadCounter = 0;
    // `import(path)` 同路径恒返同一实例 ⇒ 两 Core 装同一插件即同一对象，后者覆写 this.core。
    this._instanceTag = `pm${(globalThis.__tusunsunPmSeq = (globalThis.__tusunsunPmSeq || 0) + 1)}`;
  }

  registerCapabilities() {
    this.core.registerCapability('plugin.reload', {
      description: 'Reload a plugin by name',
      handler: async ({ name }) => {
        if (!name) return { ok: false, error: 'Missing plugin name' };
        const existing = this.core.plugins.get(name);
        if (!existing) return { ok: false, error: `Plugin not found: ${name}` };
        const filePath = this._pluginFilePaths.get(name);
        if (!filePath) return { ok: false, code: 'no_source_path', error: `No file path for: ${name}` };
        return this._reloadPlugin(name, filePath, 'capability');
      },
      owner: 'plugin-manager',
    });
  }

  addDirectory(dir) {
    this.dirs.push(dir);
  }

  /**
   * 把拓扑序落到 `_loaded` 与 `core.plugins` 的**顺序**上。两处调用共用这一份：顺序不携带
   * 语义（查找都按名字），但两份实现各写一遍，谁先启动就取决于复制粘贴是否同步。
   * `order` 里可能有已缺席的名字（并发卸载），`filter(Boolean)` 保留这个容忍。
   */
  _applyTopology(order) {
    const sorted = order.map(name => this.core.plugins.get(name)).filter(Boolean);
    this._loaded = sorted;
    const reordered = new Map();
    for (const p of sorted) reordered.set(p.name, p);
    for (const [name, p] of this.core.plugins) if (!reordered.has(name)) reordered.set(name, p);
    this.core.plugins.clear();
    for (const [name, p] of reordered) this.core.plugins.set(name, p);
    return sorted;
  }

  async loadFromDir(dir, whitelist) {
    let files;
    try { files = await readdir(dir); } catch (err) { this.core.log('debug', 'Cannot read dir: ' + err.message); return; }
    const jsFiles = files.filter(f => extname(f) === '.js' || extname(f) === '.mjs');
    const allowed = new Set((whitelist || []).flatMap(n => [`${n}.js`, `${n}.mjs`]));
    for (const file of jsFiles) {
      if (whitelist && whitelist.length && !allowed.has(file)) continue;
      await this._loadEagerPlugin(file, join(dir, file));
    }
  }

  async loadAll(eagerList, lazyList) {
    this._loaded = [];
    this._eager = new Set(eagerList || []);

    if (!eagerList && !lazyList) {
      for (const dir of this.dirs) {
        await this._loadFromDirLegacy(dir);
      }
      if (this._loaded.length > 1) {
        const result = this.resolver.topologicalSort(this._loaded);
        if (result.ok) {
          this._applyTopology(result.order);
          this.core.log('info', `Plugins sorted (legacy): ${result.order.join(' → ')}`);
        }
      }
      this._startIdleTimer();
      return;
    }

    for (const dir of this.dirs) {
      await this._loadFromDir(dir, eagerList, lazyList);
    }

    if (this._loaded.length > 1) {
      const result = this.resolver.topologicalSort(this._loaded);
      if (!result.ok) {
        this.core.log('warn', `Dependency issue: ${result.error}, falling back to load order`);
        await this._ensureLazyInfrastructure();
        if (this._pending.size > 0) {
          this.core.log('info', `Lazy loading still available for ${this._pending.size} pending plugins`);
        }
        return;
      }
      this._applyTopology(result.order);
      this.core.log('info', `Plugins sorted: ${result.order.join(' → ')}`);
    }

    this._warnMissingProvides();
    await this._ensureLazyInfrastructure();
  }

  async _ensureLazyInfrastructure() {
    if (!this.core.getData('_lazyHook')) {
      this.core.setData('_lazyHook', (id) => this._resolveLazy(id));
    }
    // lazy 插件的声明已在 `_indexLazyPlugin` 阶段从文件头部提取进 `_pending`
    // （不导入模块）。把它发布给准入闸门：场景声明的全集是 eager ∪ lazy（与启动器同
    // `scenePluginNames` 口径），闸门只按 eager 校验会把「require 一个 lazy 服务」误判为缺失。
    // 放在这里而不是 loadAll 尾部：拓扑排序失败时 loadAll 会提前 return，那条路径也必须发布。
    this.core.setData('_lazyIndex', () => this._pending);
    if (!this._idleTimer) {
      this._startIdleTimer();
    }
  }

  // **同名 ≠ 冲突**：判据是"同一份实现"（realpath 或字节相同）⇒ 静默跳过；实现确实不同
  // 才是真冲突，仍走 `core.register()` 的 warn + `core:plugin.conflict`。
  // 保留理由：懒加载池与多目录装配仍可能出现同一文件被不同路径扫到。
  _isSameImplementation(name, fullPath) {
    const prev = this.core.plugins.get(name)?.__source;
    if (!prev || !fullPath) return false;
    try {
      if (realpathSync(prev) === realpathSync(fullPath)) return true;
      return readFileSync(prev).equals(readFileSync(fullPath));
    } catch {
      return false;   // 读不到就当“不是同一份”：宁可多一条 warn，不可漏报真冲突
    }
  }

  // 插件目录里的 `.js` 在老解释器下不被当作 ESM（报 `Unexpected token 'export'`）：换成具名错误，
  // 建议文本由宿主注入 `esmHint`（内核不得反向 import `plugins/_lib/…`）；宿主不注入时退化为原始错误。
  async _importPluginModule(fullPath) {
    try {
      return await import(pathToFileURL(fullPath).href + '?' + this._instanceTag);
    } catch (err) {
      const hint = typeof this.core?.esmHint === 'function' ? this.core.esmHint(fullPath, err) : null;
      throw hint ? Object.assign(new Error(hint), { code: 'plugin_module_not_esm', cause: err }) : err;
    }
  }

  /**
   * 导入一个插件文件并落到 Core 上：`mod.default` 兜底、来源路径、同实现去重、具名重名跳过、
   * `_loaded` 记账。**eager 与 legacy 两条链共用这一份** —— 链本身各写一遍正是 `__source`、
   * `_pluginFilePaths`、去重这三处先后被漏写的原因（R0-103：无场景启动的插件无法 reload）。
   * 返回 `{ ok, reason }`，`reason` 只供调用方决定日志措辞，不参与任何判定。
   */
  async _importAndRegister(fullPath) {
    const mod = await this._importPluginModule(fullPath);
    const plugin = mod.default || {
      name: mod.name, version: mod.version, manifest: mod.manifest,
      requires: mod.requires, provides: mod.provides, optional: mod.optional,
      init: mod.init, start: mod.start, stop: mod.stop,
    };
    if (!plugin.name || typeof plugin.init !== 'function') return { ok: false, reason: 'not_a_plugin' };
    plugin.__source = fullPath;
    // 来源路径只能在这里写：只写在 `_indexLazyPlugin` 里，eager 装上的插件没有重载来源
    // （`plugin.reload` 返回 "No file path for"）。
    this._pluginFilePaths.set(plugin.name, fullPath);
    if (this._isSameImplementation(plugin.name, fullPath)) {
      this._dedupSkipped.push({ name: plugin.name, path: fullPath, sameAs: this.core.plugins.get(plugin.name).__source });
      return { ok: false, reason: 'duplicate_implementation' };
    }
    // `core.register` 对同名插件是具名跳过（返回 false）：无条件 push 会让 `_loaded` 出现
    // 重名，拓扑排序的输入长度 ≠ 节点数 ⇒ 假警报并静默放弃 DAG 排序。
    if (!(await this.core.register(plugin))) return { ok: false, reason: 'name_taken' };
    this._loaded.push(plugin);
    return { ok: true, plugin };
  }

  async _loadEagerPlugin(file, fullPath) {
    try {
      if ((await this._importAndRegister(fullPath)).ok) this.core.log('info', `Loaded plugin (eager): ${file}`);
    } catch (err) {
      this.core.log('error', `Failed to load ${file}: ${err.message}`);
      this._recordLoadFailure(file, err);
    }
  }

  // 装载/索引失败必须落成**只读事实**：插件没进 `plugins` 表时，扫表得出的健康结论只会说一切正常。
  // 写进 `core._startFailures`（与 init 失败同一本账），readiness 已经在读它。
  _recordLoadFailure(file, err) {
    this.core._startFailures.set(file, { error: err.message, requiredFailed: false, phase: 'load', at: Date.now() });
  }

  async _indexLazyPlugin(file, fullPath, source = 'boot') {
    try {
      const src = await readFileHeader(fullPath);
      let meta = extractPluginMeta(src, fullPath);
      while (meta._reexport) {
        const targetPath = join(dirname(fullPath), meta._reexport);
        const targetSrc = await readFileHeader(targetPath);
        meta = extractPluginMeta(targetSrc, targetPath);
      }
      if (!meta.name) {
        // 说清**为什么**提取不到，而不是让人去猜 2048 字节上限。
        // 元数据提取是正则匹配「类字段风格」声明（`name = '...'` / `provides = [...]`）——
        // 对象字面量风格（`export default { name: 'x' }`）提取不到 name，只能进场景的 eager 列表。
        this.core.log('warn', `Could not extract metadata from ${file}, skipping（懒加载索引要求类字段风格 name = '...'；对象字面量风格请放进场景 eager）`);
        return;
      }
      this._indexProvides({ name: meta.name, provides: meta.provides });
      this._pluginFilePaths.set(meta.name, fullPath);
      // 登记**来源归属**。没有它，"该不该撤销"只能靠"这次切换里谁被我登记过"回答，
      // 于是启动期（loadAll）登记的索引永远没人撤：切到完全不包含 legacy 的场景后仍能激活）。
      this._pending.set(meta.name, { provides: meta.provides, requires: meta.requires, version: meta.version, filePath: fullPath, plugin: null, source });
      this.core.log('info', `Registered lazy plugin: ${file}`);
    } catch (err) {
      this.core.log('error', `Failed to index ${file}: ${err.message}`);
      this._recordLoadFailure(file, err);
    }
  }

  async _loadFromDir(dir, eagerList, lazyList) {
    let files;
    try {
      files = await readdir(dir);
    } catch (err) {
      this.core?.log?.('warn', `[plugin-manager] Failed to read directory ${dir}: ${err.message}`);
      return;
    }

    let jsFiles = files.filter(f => extname(f) === '.js' || extname(f) === '.mjs');

    const allNames = [...(eagerList || []), ...(lazyList || [])];
    if (allNames.length) {
      const allowed = new Set(allNames.flatMap(n => [`${n}.js`, `${n}.mjs`]));
      jsFiles = jsFiles.filter(f => allowed.has(f));
    }

    for (const file of jsFiles) {
      const fullPath = join(dir, file);
      const s = await stat(fullPath);
      if (!s.isFile()) continue;

      const pluginName = file.replace(/\.(js|mjs)$/, '');
      const isEager = this._eager.has(pluginName);

      if (isEager) {
        await this._loadEagerPlugin(file, fullPath);
      } else {
        await this._indexLazyPlugin(file, fullPath);
      }
    }
  }

  async _loadFromDirLegacy(dir) {
    let files;
    try {
      files = await readdir(dir);
    } catch (err) {
      this.core?.log?.('warn', `[plugin-manager] Failed to read directory ${dir}: ${err.message}`);
      return;
    }
    const jsFiles = files.filter(f => extname(f) === '.js' || extname(f) === '.mjs');
    for (const file of jsFiles) {
      const fullPath = join(dir, file);
      const s = await stat(fullPath);
      if (!s.isFile()) continue;
      try {
        if ((await this._importAndRegister(fullPath)).ok) this.core.log('info', `Loaded plugin from: ${file}`);
      } catch (err) {
        this.core.log('error', `Failed to load ${file}: ${err.message}`);
        this._recordLoadFailure(file, err);
      }
    }
  }

  /** `provides` 项 → 它要落到哪几张反查索引。**建账与撤账共用这一份**（见 `_unindexProvides`）。 */
  _provideTargets(item) {
    // `provides` 允许两种形态：`{ name, type }` 对象（仓内既有写法）与裸字符串。
    // 建账读 `item.name`、撤账却拿整个对象当 key —— K24-04 就是这么坏掉的。
    const obj = typeof item === 'string' ? { name: item } : item;
    const name = typeof obj?.name === 'string' ? obj.name : null;
    if (!name) return null;
    if (name.endsWith('.*')) return { name, targets: [['_wildcardIndex', name.slice(0, -2)]] };
    if (obj.type === 'service') return { name, targets: [['_svcIndex', name]] };
    // 非 service 的键**两张都写**：能力反查与服务反查的查找规则不同，合成一张会改语义。
    return { name, targets: [['_providesIndex', name], ['_svcIndex', name]] };
  }

  _indexProvides(plugin) {
    for (const item of plugin.provides || []) {
      const t = this._provideTargets(item);
      if (!t) {
        this.core.log('warn', `Plugin "${plugin.name}": provides 项缺少 name（${JSON.stringify(item)}），已跳过`);
        continue;
      }
      for (const [map, key] of t.targets) this[map].set(key, plugin.name);
    }
  }

  /**
   * 撤销 `provides` 装出来的反查索引（**唯一实现**，`dropLazy` / `reconcileLazy` 都走这里）。
   * 两条判据：① 与建账同一份规范化（否则对象/通配符形态删不掉）；② 只删"此刻仍指向本
   * owner"的条目 —— 键被后继提供者接管时，撤旧账不得顺手删掉后继者的索引（ABA）。
   */
  _unindexProvides(name, provides) {
    for (const item of provides || []) {
      const t = this._provideTargets(item);
      if (!t) continue;
      for (const [map, key] of t.targets) if (this[map].get(key) === name) this[map].delete(key);
    }
  }

  _warnMissingProvides() {
    for (const [name, entry] of this._pending) {
      if (!entry.provides || entry.provides.length === 0) {
        this.core.log('warn', `Plugin "${name}" has empty provides — lazy loading will not work`);
      }
    }
  }

  async _resolveLazy(id) {
    let pluginName = this._providesIndex.get(id);
    if (!pluginName) pluginName = this._svcIndex.get(id);
    if (!pluginName) {
      for (const [prefix, name] of this._wildcardIndex) {
        if (id.startsWith(prefix)) { pluginName = name; break; }
      }
    }
    if (!pluginName) return;
    if (!this._pending.has(pluginName)) return;

    const result = this.resolver.resolveLazyChain(pluginName, this._pending);
    if (!result.ok) {
      this.core.log('error', `Cannot resolve lazy chain for "${pluginName}": ${result.error}`);
      return;
    }
    for (const name of result.order) {
      if (!this._eager.has(name) && !this._lazyLoaded.has(name)) {
        await this._lazyLoadOne(name);
      }
    }
  }

  /**
   * 取一次懒加载。**真实装载 Attempt** 与**本次等候方**必须分开记账 —— 塞进同一个 Promise
   * 时，旧定时器会把已 loaded 的记录改回 `in_flight_after_timeout`，而 `finally` 在等候方
   * 结束时删掉 `_loading`，真实装载还在跑时第二个请求就查不到它 ⇒ **第二次 init**。
   *
   * 不变式：① 同一来源只允许一笔真实装载，句柄只在它 settle 时释放；② 等候方只登记
   * "我放弃等了"，绝不改写装载事实；③ 定时器随等候方结束即清。
   */
  async _lazyLoadOne(name) {
    if (this._eager.has(name)) return;
    if (this._lazyLoaded.has(name)) return;
    // 已有真实装载在跑 ⇒ 加入它，绝不另起一笔。
    const attempt = this._loading.get(name) || this._startLazyLoad(name);
    return this._awaitLazyLoad(name, attempt);
  }

  /** 启动一笔**真实**装载，并登记为 single-flight 句柄（释放点是它自己的 settle）。 */
  _startLazyLoad(name) {
    const entry = this._pending.get(name);
    if (!entry) throw new Error(`Cannot lazy load "${name}": not in pending`);
    const filePath = entry.filePath;
    if (!filePath) throw new Error(`Cannot lazy load "${name}": file path not found`);

    // 每次加载都留一条**可查询**的去向记录。这些字段只由真实装载写。
    const rec = {
      name, state: 'loading', startedAt: Date.now(), settledAt: null, error: null,
      waitedOutAt: null,   // 有等候方放弃过的时间点 —— 是"等待"的事实，不是"加载"的状态
    };
    this._loadOutcomes.set(name, rec);

    const asm = this.core.beginAssembly(name);
    const attempt = this._doLazyLoad(name, filePath, rec, asm.epoch);
    this._loading.set(name, attempt);
    const release = () => {
      this.core.endAssembly(asm);
      if (this._loading.get(name) === attempt) this._loading.delete(name);
    };
    attempt.then(release, release);
    return attempt;
  }

  /** 等候方：只回答"我等到没等到"，装载事实一律不碰。 */
  async _awaitLazyLoad(name, attempt) {
    const rec = this._loadOutcomes.get(name);
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        // 已结算的记录一律不动 —— 迟到的定时器不得改写它。
        if (rec && !rec.settledAt && rec.waitedOutAt == null) rec.waitedOutAt = Date.now();
        const err = new Error(`Lazy load timeout for "${name}" after ${this._loadTimeoutMs}ms`);
        err.code = 'lazy_load_timeout';
        reject(err);
      }, this._loadTimeoutMs);
    });
    try {
      return await Promise.race([attempt, timeout]);
    } finally {
      // 等候方一结束就清：定时器不得活过它所属的那次等待。
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 查询一次懒加载的去向（未加载过 ⇒ `null`）。
   *
   * `state` **只由真实装载写**，只有 `loading` / `loaded` / `failed`；`in_flight_after_timeout`
   * 是**视图**不是状态（由 `state==='loading'` 且 `waitedOutAt!=null` 派生）—— 它若被定时器
   * 写进记录，就会覆盖已结算的 loaded/failed。
   */
  describeLazyLoad(name) {
    const rec = this._loadOutcomes.get(name);
    if (!rec) return null;
    const out = { ...rec, registered: this.core.plugins.has(name), lazyLoaded: this._lazyLoaded.has(name) };
    out.waitedOut = rec.waitedOutAt != null;
    if (!rec.settledAt && out.waitedOut) out.state = 'in_flight_after_timeout';
    return out;
  }

  async _doLazyLoad(name, filePath, rec, epoch = null) {
    try {
      const mod = await import(pathToFileURL(filePath).href + '?' + this._instanceTag + '&t=' + Date.now());
      const plugin = mod.default || mod;
      plugin.__source = filePath;
      await this._loadViaLifecycle(plugin, epoch);
      this._lazyLoaded.add(name);
      this._pending.delete(name);
      this._loadTime.set(name, Date.now());
      this._touchAccess(name);
      // 迟到成功要留下痕迹 —— 这正是完全不可见的那条路径。
      if (rec) { rec.settledAt = Date.now(); rec.state = 'loaded'; }
      // **不在这里发 `core:plugin.loaded`**："一次真实 running 转移"是**一个**已提交事实，
      // 发布点是 `LifecycleManager` 的 `advance(plugin,'running')`。这里再发一遍会让
      // 一次装载出现两条同名事实，且字段还不兼容（`pluginName` vs `name`）—— K24-01。
      this.core.log('info', `Lazy loaded plugin: ${this.core.colorize('cyan', name)}`);
    } catch (err) {
      this.core.log('error', `Failed to lazy load "${name}": ${err.message}`);
      // 失败就是失败：不看"等候方是否超时过"来决定记成什么（timeout_then_failed
      // 把两种事实混成一个词）。等待方的超时另记在 `waitedOutAt`。
      if (rec) { rec.settledAt = Date.now(); rec.error = err?.message || String(err); rec.state = 'failed'; }
      throw err;   // 真实失败必须让 Attempt reject：等候方与迟到对账都靠它
    }
  }

  /**
   * 重载的**唯一**实现。次序是判据不是风格：先 import（失败则原插件毫发无损）→ unload 走
   * 完整清理 → register 重发 manifest 与 provides → init/start，与首次装载同一条链；
   * 之后失败标 unavailable + 具名 code，不回落。
   *
   * 整段在**同一个 owner 独占区**里执行：只把 unload/load 各自包起来不够 —— A 的 import 与
   * B 的 unload 仍会交错，三次并发 reload 会各报 ok 而只兑现一次。
   */
  async _reloadPlugin(name, filePath, via) {
    return this.lc.runExclusive(name, () => this._reloadPluginLocked(name, filePath, via));
  }

  async _reloadPluginLocked(name, filePath, via) {
    let next;
    try {
      this._reloadCounter++;
      const mod = await import(pathToFileURL(filePath).href + '?' + this._instanceTag + '&v=' + this._reloadCounter);
      next = mod.default || mod;
    } catch (err) {
      this.core.log('error', `[reload:${via}] "${name}" import failed, keeping the running version: ${err.message}`);
      return { ok: false, code: 'reload_import_failed', error: err.message, kept_previous: true };
    }
    // **有在途调用时拒绝替换**：先看 inflight，非 0 就返回 `reload_busy` 并保留原版本。
    // 不这么做的后果是实测过的：unload 的 drain 等不到也照样 stop，重载返回 `ok:true`，
    // 而在飞调用 `failed/handler_threw`、磁盘留下半截副作用 —— 打断在途工作却报一切正常。
    // 为什么拒绝而不是"等到底"：一条卡死的链会让重载永久挂住，调用方拿不到任何答复；
    // 拒绝是**立刻可见**的失败，原版本仍在正常服务，调用方可以稍后重试。
    const inflight = this.core.getInflight?.(name) ?? 0;
    if (inflight > 0) {
      this.core.log('warn', `[reload:${via}] "${name}" refused: ${inflight} call(s) in flight`);
      return {
        ok: false, code: 'reload_busy', inflight, kept_previous: true,
        error: `Plugin "${name}" has ${inflight} call(s) in flight; refusing to replace it. `
          + 'Replacing now would interrupt them and leave partial side effects. '
          + 'Retry after they settle, or cancel them first.',
      };
    }
    let unloaded;
    try { unloaded = await this.lc.unload(name); }
    catch (err) { return { ok: false, code: 'reload_unload_failed', error: err.message }; }
    // 卸载被迫部分完成 ⇒ 在途调用已被打断、副作用未知：不得再装一个新版本（那会让"旧实例
    // 还在跑"与"新实例已服务"同时为真）。如实报部分完成并停下。
    if (unloaded?.ok === false) {
      return { ok: false, code: 'reload_unload_partial', forced_partial: true, inflight: unloaded.inflight ?? 0, kept_previous: false, error: unloaded.error || `Plugin "${name}" unloaded with calls in flight` };
    }
    try {
      // 走**公开** `lc.load` 而不是三步手动序列：后者从不把 state 改回 running（重载后插件
      // 在服务而 state 停在 'registered'），且让装配入口由 3 条变回 4 条。
      // `runExclusive` 在同一异步调用链内可重入（ALS 判据），现金已持有该 name 的独占区，
      // 不会自锁；换成 `_load` 等于开后门，锁的语义会退化成"谁记得传"。
      // **必须自己绑世代并登记装配**：`epoch` 为 null 时 `isAssemblyCurrent(null)` 恒 true，
      // 这条路在 `core.stop()` 之后仍能把新版本推到 running。
      const asm = this.core.beginAssembly(next?.name);
      await this.lc.load(next, this.core, {
        svcIndex: this._svcIndex, pending: this._pending, lazyLoadOne: (n) => this._lazyLoadOne(n),
        epoch: asm.epoch,
      }).finally(() => this.core.endAssembly(asm));
      this._pluginFilePaths.set(next.name || name, filePath);
      this.core.log('info', `Plugin reloaded (${via}): ${next.name || name}`);
      return { ok: true, name: next.name || name, via };
    } catch (err) {
      // 原版本已被 unload、回不去了：如实标 unavailable，不假装还能用。
      // I-01：状态跃迁统一走 Lifecycle，不在这里自己写字符串。
      this.lc.advance(next, 'unavailable');
      this.core.log('error', `[reload:${via}] "${name}" failed after unload ⇒ unavailable: ${err.message}`);
      return { ok: false, code: 'reload_failed_unavailable', error: err.message, state: 'unavailable' };
    }
  }

  _touchAccess(name) {
    this._lastAccess.set(name, Date.now());
  }

  /** 懒索引状态归位：`_recycle` 与 `unload` **共用这一处**（两处各写一遍必然分叉）。 */
  _resetLazyState(name) {
    this._lazyLoaded.delete(name);
    this._lastAccess.delete(name);
    this._loadTime.delete(name);
  }

  async _recycle(name) {
    try {
      const entry = this._pending.get(name);
      const unloaded = await this.lc.unload(name);
      // K24-05：**只有已证明释放的回收才允许删"仍被装载"的记录**。
      // `released:false`（stop_timeout：它可能还在跑）时删记录 = 账本说没装、实际还在服务，
      // 下一次懒加载就会起第二个实例。已释放/已释放但在途未知/未释放是三类事实。
      if (!isReleased(unloaded)) {
        this.core.log('warn', `Recycle of "${name}" did not release (${unloaded?.code || 'unload_failed'}); `
          + 'keeping the loaded record so that a second instance is never started');
        return;
      }
      this._resetLazyState(name);
      // 已释放 ≠ 回收干净：在途被打断（drain_timeout）时不得当场把它登记成"可再装"，
      // 也不得推进回收时间戳（那等于假装回收完成）。R21/D-4/3 定的就是这条。
      if (unloaded.ok === false) {
        this.core.emitFact('core:plugin.recycled', {
          pluginName: name, name, reindexed: false, uncertain: unloaded.code || 'unload_partial',
          sourcePlugin: 'plugin-manager',
        });
        return;
      }
      // 目标场景已撤销这条索引（`reconcileLazy` 记下的意图）⇒ 回收不得把它写回来。
      if (!this._revokeIntent.has(name)) this._pending.set(name, { provides: entry?.provides || [], requires: entry?.requires || {}, version: entry?.version, filePath: this._pluginFilePaths.get(name) || '', plugin: null, source: entry?.source || 'repair' });
      this._lastRecycleTime.set(name, Date.now());
      // **回收**和**卸载**是两个事实：卸载结论（released / code / inflight）已由 Lifecycle 的
      // `core:plugin.unloaded` 发布；这里只宣告"索引已重建，可以再次懒加载"（K24-02）。
      this.core.emitFact('core:plugin.recycled', {
        pluginName: name, name, reindexed: this._pending.has(name), sourcePlugin: 'plugin-manager',
      });
    } catch (err) {
      this.core.log('error', `Recycle failed for "${name}": ${err.message}`);
    }
  }

  _startIdleTimer() {
    if (this._idleTimer) return;
    this._idleTimer = setInterval(() => this._checkIdle(), IDLE_CHECK_INTERVAL);
    // 空闲回收是**后台清理**，不是"还有活要干"——不让它把进程钉住。
    // 36 个 PluginManager 各带一个 interval，而单测里大多数实例从未走到
    // `Core.stop()`（它们是直接 new 出来的），于是这些 interval 全部活到进程结束。
    // 停表本身已有主路径（`core.js` 的 `Core.stop()` 会调 `_stopIdleTimer()`），
    // 这里只补 unref；不再另挂一个 `core.stopped` 监听——同一个事实只需要一个写入者。
    this._idleTimer.unref?.();
  }

  _stopIdleTimer() {
    if (this._idleTimer) {
      clearInterval(this._idleTimer);
      this._idleTimer = null;
    }
  }

  async _checkIdle() {
    const now = Date.now();
    const MAX_LIFETIME = this.core?.get?.('plugin.maxLifetime') ?? 86400_000;
    const RECYCLE_COOLDOWN = this.core?.get?.('plugin.recycleCooldown') ?? 60_000;

    // Hard limit: always enforce 24h lifetime, regardless of daemon decisions
    for (const name of this._lazyLoaded) {
      if (this._eager.has(name)) continue;
      const loadTime = this._loadTime.get(name);
      if (loadTime && now - loadTime >= MAX_LIFETIME) {
        this.core.log('info', `Hard limit recycle: ${name} (alive ${((now - loadTime) / 3600_000).toFixed(1)}h)`);
        await this._recycle(name);
      }
    }

    // 智能回收改为向**厂商无关的角色服务** `recycle-advisor` 征询（谁需要谁接）。
    // 未装配该角色时 decisions 为空 → 与今天「外部引擎缺席」的行为**完全一致**（仍走上面的硬上限回收）。
    // 注意：本角色名是"插件可提供的可选角色"，不是新增微内核 API；内核只读、缺省即无建议。
    let decisions = [];
    try {
      decisions = await this.core.getService('recycle-advisor')?.pollRecycleDecisions() || [];
    } catch (err) {
      this.core?.log?.('warn', `[plugin-manager] pollRecycleDecisions failed: ${err.message}`);
    }
    if (decisions.length > 0) {
      for (const d of decisions) {
        if (this._lazyLoaded.has(d.name) && !this._eager.has(d.name)) {
          const lastRecycle = this._lastRecycleTime.get(d.name);
          if (lastRecycle && now - lastRecycle < RECYCLE_COOLDOWN) continue;
          this.core.log('info', `Smart recycle: ${d.name} (reason: ${d.reason}, idle: ${Math.round((d.idle_ms || 0) / 1000)}s)`);
          await this._recycle(d.name);
        }
      }
      return;
    }

    // Fallback: local TTL recycling (external engine offline)
    for (const name of this._lazyLoaded) {
      if (this._eager.has(name)) continue;

      const lastRecycle = this._lastRecycleTime.get(name);
      if (lastRecycle && now - lastRecycle < RECYCLE_COOLDOWN) continue;

      const lastAccess = this._lastAccess.get(name) || 0;
      if (now - lastAccess > this._idleTTL && now - lastAccess > this._minLived) {
        this.core.log('info', `Idle recycle: ${name} (idle ${Math.round((now - lastAccess) / 1000)}s)`);
        await this._recycle(name);
      }
    }
  }

  async recycleAll() {
    const toRecycle = [...this._lazyLoaded].filter(n => !this._eager.has(n));
    for (const name of toRecycle) {
      await this._recycle(name);
    }
    this.core.log('info', `Recycled ${toRecycle.length} lazy plugins`);
  }

  async unload(pluginName) {
    // 只转调 lc.unload 而不改本管理器的两套状态时，两套状态会互相矛盾且不可恢复：
    // `_lazyLoaded` 仍说"装着"，`_pending` 已说"没有来源"，再调 hasCapability 永假。
    // 现在一起归位：卸载 = 回到"可被懒加载"的初始态 —— 但**只在证明已释放之后**。
    const entry = this._pending.get(pluginName);
    const result = await this.lc.unload(pluginName);
    if (!isReleased(result)) return result;
    this._resetLazyState(pluginName);
    if (!entry && !this._revokeIntent.has(pluginName)) {
      const filePath = this._pluginFilePaths.get(pluginName);
      if (filePath) this._pending.set(pluginName, { provides: [], requires: {}, filePath, plugin: null, source: 'repair' });
    }
    this.core.log('info', `Plugin "${pluginName}" unloaded; lazy state reset (re-activatable)`);
    return result;
  }

  /**
   * 把一个**场景声明的 lazy 插件**登记进懒加载索引（只读文件头，不 import）：`_resolveLazy()`
   * 只从 `_pending` 取来源，不登记就等于永久不可调用。索引失败不抛，由调用方如实上报
   * （这个插件此刻本来就不需要运行）。
   */
  async indexLazy(name, source = 'scene') {
    if (!name) return { ok: false, name, error: 'empty plugin name' };
    // 与 `loadOne` 同一条判据：场景是外部输入，跳过这里 `@host` 仍能借 lazy 索引变成宿主。
    if (!isValidPluginName(name)) {
      return { ok: false, name, code: 'plugin_name_invalid', error: `Invalid plugin name: ${JSON.stringify(name)}` };
    }
    if (this._pending.has(name)) {
      // 已经在索引里也要**改归属** —— 新场景同样声明了它，撤销判据必须看到这一点，
      // 否则切回旧场景时这条会被当成"上一场景的私有 lazy"删掉（误删共享来源）。
      const e = this._pending.get(name);
      if (e && e.source !== 'host') e.source = source;
      return { ok: true, name, alreadyIndexed: true };
    }
    this._revokeIntent.delete(name);          // 场景重新声明 ⇒ 撤销意图作废
    const src = this._findSource(name);
    if (!src) return { ok: false, name, error: `source not found in plugin dirs (${name}.js/.mjs)` };
    await this._indexLazyPlugin(basename(src), src, source);
    // `_indexLazyPlugin` 内部吞错并只打日志，所以**以 `_pending` 的实际内容为准**，不信它的返回。
    return this._pending.has(name)
      ? { ok: true, name, alreadyIndexed: false }
      : { ok: false, name, error: 'metadata not extractable (requires class-field style `name = ...`)' };
  }

  /**
   * 撤销一个 lazy 索引（切出场景时用）。**正在运行**或**已懒加载过**的一律不动：索引已被
   * 装载消费，删掉会让 `unload` 之后再也装不回来。只有"登记了但从未装载"的才算纯索引。
   */
  dropLazy(name) {
    const entry = this._pending.get(name);
    if (!entry) return false;
    if (this.core.plugins.has(name) || this._lazyLoaded.has(name)) return false;
    this._pending.delete(name);
    // 反查索引不清会让 `_resolveLazy` 找到名字、却取不到来源（静默无操作）。
    this._unindexProvides(name, entry.provides);
    return true;
  }

  /**
   * 按**目标场景的有效声明全集**对账懒加载索引。归属只回答"能不能被场景撤"：`host` 是宿主
   * 显式登记、不随场景撤销；其余（`boot` / `scene:*` / `repair`）目标场景不声明就撤。
   *
   * 不用"本次切换里登记过谁"当判据：启动期 `loadAll` 登记的永远不会在那个集合里 ⇒ 切到
   * 不含它的场景后仍能被激活。已装载的不在 `_pending`，撤销意图另记（见下）。
   */
  reconcileLazy(keepNames, sceneName = null) {
    const keep = new Set(keepNames || []);
    const dropped = [];
    // 已装载的懒插件不在 `_pending` 里：撤销只能记下意图，否则回收会把索引写回来。
    for (const name of [...this._lazyLoaded]) {
      if (keep.has(name) || this._eager.has(name)) this._revokeIntent.delete(name);
      else this._revokeIntent.add(name);
    }
    for (const [name, entry] of [...this._pending]) {
      if (keep.has(name)) continue;
      if (entry?.source === 'host') continue;
      if (this.core.plugins.has(name) || this._lazyLoaded.has(name)) continue;
      this._pending.delete(name);
      this._unindexProvides(name, entry?.provides);
      dropped.push(name);
    }
    if (sceneName) {
      for (const name of keep) {
        const e = this._pending.get(name);
        if (e && e.source !== 'host') e.source = `scene:${sceneName}`;
      }
    }
    return { dropped, kept: [...keep].filter((n) => this._pending.has(n)) };
  }

  /**
   * 按名字装载单个插件的**唯一**公开入口：找到来源 → `lc.load()`。场景只表达意图，
   * 自己 import / init / start 会成第 4 条装配路径（不经 Lifecycle、也不写 state）。
   *
   * 返回 `{ ok, name, error? }`：场景五段式需要区分成败，只 `log` 一句时调用方无从判断。
   */
  async loadOne(name) {
    if (this.core.plugins.has(name)) return { ok: true, name, alreadyLoaded: true };
    // **先判名字，再碰磁盘**：`_findSource` 把 `name` 拼成路径，因此"名字格式"就是"导入边界"。
    if (!isValidPluginName(name)) {
      return { ok: false, name, code: 'plugin_name_invalid', error: `Invalid plugin name: ${JSON.stringify(name)}` };
    }
    const file = this._findSource(name);
    if (!file) return { ok: false, name, code: 'plugin_source_not_found', error: `Plugin file not found: ${name}` };
    try {
      const mod = await this._importPluginModule(file);
      const plugin = mod.default || mod;
      if (!plugin?.name || typeof plugin.init !== 'function') {
        return { ok: false, name, error: `Plugin "${name}" 缺少 { name, init(core) }` };
      }
      // **请求名 / 实际对象名 / manifest 名**必须对得上。
      // 不核对时：`loadOne('dup')` 打开 dup.js、装进去的却是自报 name='other' 的对象，
      // 于是"按名字装载"这个判据可以被一个文件名绕过。
      const declared = plugin.manifest?.name;
      if (plugin.name !== name || (declared != null && declared !== name)) {
        return {
          ok: false, name, code: 'plugin_name_mismatch',
          error: `Plugin file "${basename(file)}" declares name "${plugin.name}"`
            + `${declared != null && declared !== plugin.name ? ` (manifest: "${declared}")` : ''}, requested "${name}"`,
        };
      }
      plugin.__source = file;
      this._pluginFilePaths.set(plugin.name, file);
      await this._loadViaLifecycle(plugin);
      return { ok: true, name: plugin.name };
    } catch (err) { return { ok: false, name, code: err.code || null, error: err.message }; }
  }

  /** 按名字在装配根里找来源文件；找不到返回 null。loadOne 与 isResolvable 共用一份判据。 */
  _findSource(name) {
    const dirs = this.dirs.length ? this.dirs : [this.core.pluginsDir].filter(Boolean);
    for (const dir of dirs) {
      for (const ext of ['.js', '.mjs']) {
        const p = join(dir, `${name}${ext}`);
        if (existsSync(p)) return p;
      }
    }
    return null;
  }

  /**
   * 装载统一走 Lifecycle —— 全仓唯一的装配入口。
   *
   * **必须绑定世代并登记装配**：`epoch` 为 null 时 `isAssemblyCurrent(null)` 恒 true，
   * `registerCapability` 的闸门整条跳过 —— 等于 `loadOne` / `reload` 没有停机闸门，
   * `core.stop()` 之后仍能把插件推到 running。用 `beginAssembly` 而不是让调用方各自记得传：
   * `_drainAssemblies` 只采样登记过的装配，漏登记 = 停机时报"没有在途装配"而实际有插件在 init。
   */
  _loadViaLifecycle(plugin, epoch = null) {
    if (epoch != null) {
      return this.lc.load(plugin, this.core, {
        svcIndex: this._svcIndex, pending: this._pending, lazyLoadOne: (n) => this._lazyLoadOne(n), epoch,
      });
    }
    const asm = this.core.beginAssembly(plugin?.name);
    return this.lc.load(plugin, this.core, {
      svcIndex: this._svcIndex, pending: this._pending, lazyLoadOne: (n) => this._lazyLoadOne(n),
      epoch: asm.epoch,
    }).finally(() => this.core.endAssembly(asm));
  }

  /** ② Preflight 用的只读判据：这个名字有没有可装载的来源（已注册、在懒加载池、或文件在场）。 */
  isResolvable(name) {
    return this.core.plugins.has(name) || this._pending.has(name)
      || this._pluginFilePaths.has(name) || this._findSource(name) !== null;
  }

  watchForChanges() {
    this.watchers = [];
    for (const dir of this.dirs) {
      try {
        const w = watch(dir, async (eventType, filename) => {
          if (eventType === 'change' && filename && /\.(js|mjs)$/.test(filename)) {
            this.core.log('info', `Plugin file changed: ${filename}, reloading...`);
            const fullPath = join(dir, filename);
            // 按**文件**反查插件名：文件名不一定等于插件名（plugins/foo.js 可以声明 name='bar'）。
            const name = [...this._pluginFilePaths].find(([, p]) => p === fullPath)?.[0];
            if (!name) this.core.log('warn', `File changed but no loaded plugin owns it: ${filename}`);
            else await this._reloadPlugin(name, fullPath, 'watch');
          }
        });
        this.watchers.push(w);
      } catch (err) { this.core.log('debug', 'Operation failed: ' + err.message); }
    }
  }

  stopWatching() {
    for (const w of (this.watchers || [])) {
      try { w.close(); } catch (err) { this.core?.log?.('warn', `[plugin-manager] Failed to close watcher: ${err.message}`); }
    }
    this.watchers = [];
  }

  getLastAccess(name) {
    return this._lastAccess.get(name);
  }
}

export { PluginManager };
