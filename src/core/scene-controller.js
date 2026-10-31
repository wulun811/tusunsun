import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, basename, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadJson5 } from './json5-loader.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCENE_SEARCH = [resolve(__dirname, '../../scenes'), `${process.env.HOME}/.tusunsun/scenes`].filter((d, i, a) => existsSync(d) && a.indexOf(d) === i);

// 切换 diff 必须算**场景声明的全集**（eager ∪ plugins ∪ lazy，与装配入口
// `scenePluginLists()` 同口径）；底座 config/gateway 两边都排除。只看 `plugins` 时，"插件全写在
// eager"的场景会被当成空装配（coding 场景里 eager 38、plugins 空）。
const SCENE_ALWAYS_ON = ['config', 'gateway'];
function scenePluginNames(scene) {
  const all = [...(scene?.eager || []), ...(scene?.plugins || []), ...(scene?.lazy || [])];
  return new Set(all.filter((n) => n && !SCENE_ALWAYS_ON.includes(n)));
}

/**
 * 场景**要求必须处于运行态**的插件集合 = **`eager` 一项**（与启动器 `scenePluginLists()`、
 * `docs/guides/scene-system.md` 同一口径）。`plugins` / `lazy` 是"声明可用、按需装载" ——
 * 同一字段不能在启动时按懒、切换时按必需。
 *
 * Verify 既不能用"声明全集"（合法懒加载会被判失败），也不能只看"本轮新装的"（早就在 Map 里
 * 但 `state==='error'` 的必需插件不在 toAdd/toRemove 里，于是 `stillMissing=[]`、`ok:true`）。
 */
function sceneRequiredNames(scene) {
  return new Set((scene?.eager || []).filter((n) => n && !SCENE_ALWAYS_ON.includes(n)));
}

/**
 * 场景声明为"**按需装载**"的插件集合 = `plugins ∪ lazy`（排除同时写在 eager 里的）。
 * 与启动器 `scenePluginLists()` 同一公式：切换时不装载，只登记进 `_pending` 索引，
 * 由 `_lazyResolver()` 在首次能力调用时触发。
 */
function sceneLazyNames(scene) {
  const eager = new Set(scene?.eager || []);
  const all = [...(scene?.plugins || []), ...(scene?.lazy || [])];
  return [...new Set(all)].filter((n) => n && !eager.has(n) && !SCENE_ALWAYS_ON.includes(n));
}

class SceneController {
  constructor(core, pluginManager) {
    this.core = core;
    this.pm = pluginManager;
    this.currentScene = null;
    // 本实例不存"我登记过谁"：归属的权威来源是 `PluginManager._pending[*].source`。
    // 撤销的判据是**目标场景声明的 lazy 全集**，而"谁在这次切换里登记过"既漏掉启动期登记，
    // 又会把多场景共享的来源误删。
    //
    // `_persistedScene` = **已验证落盘成功**的场景名，不是第二套真相：它只回答"同一目标还
    // 需要再写一次盘吗"，从不回答"当前跑哪个场景"（那是 `currentScene` —— 持久化失败时它
    // **仍会**被写，因为运行态确实切了，拿它当"已落盘"的证据必然得出错误结论）。
    this._persistedScene = null;
    this._sceneCache = new Map();
    this._SCENE_CACHE_MAX = 20;
  }

  async findScene(name) {
    if (this._sceneCache.has(name)) return this._sceneCache.get(name);
    if (this._sceneCache.size >= this._SCENE_CACHE_MAX) {
      const firstKey = this._sceneCache.keys().next().value;
      this._sceneCache.delete(firstKey);
    }

    for (const base of SCENE_SEARCH) {
      const sceneDir = isAbsolute(base) ? base : resolve(process.cwd(), base);
      const resolved = resolve(sceneDir, `${basename(name)}.json5`);
      if (!resolved.startsWith(sceneDir + sep)) {
        this.core?.log('warn', `[scene] Path traversal blocked: ${name}`);
        continue;
      }
      if (existsSync(resolved)) {
        const raw = await readFile(resolved, 'utf8');
        const cfg = loadJson5(raw, ` in ${resolved}`);
        let result = { ...cfg, _file: resolved };
        result = await this._expandIncludes(result);
        this._sceneCache.set(name, result);
        return result;
      }
    }
    return null;
  }

  async _expandIncludes(cfg) {
    if (!cfg.include?.length) return cfg;
    const plugins = new Set(cfg.plugins || []);
    const optional = new Set(cfg.optional || []);
    const eager = new Set(cfg.eager || []);
    const missingIncludes = [];
    for (const inc of cfg.include) {
      const parent = await this.findScene(inc);
      if (parent) {
        for (const p of (parent.plugins || [])) plugins.add(p);
        for (const p of (parent.optional || [])) optional.add(p);
        for (const p of (parent.eager || [])) eager.add(p);
      } else {
        // N-03：缺失的 include 不能只是日志里一句话 —— 调用方（Preflight/诊断）要能看见。
        // 装配照常继续、返回值里没有痕迹时，"少装了一整个底座"看起来像"场景就这么大"。
        missingIncludes.push(inc);
        this.core.log('warn', `Include "${inc}" not found in scene "${cfg.name}"`);
      }
    }
    const out = { ...cfg, plugins: [...plugins], optional: [...optional], eager: [...eager] };
    if (missingIncludes.length) { out.missingIncludes = missingIncludes; out.partial = true; }
    return out;
  }

  /**
   * 切换走 Plan → Preflight → Apply → Verify → Commit 五段，且**整段在同一个独占区里执行**：
   * 五段式本身解决不了并发 —— 两个 switchTo 的段互相穿插、都返回 `ok:true`。key 用固定常量
   * 而不是场景名：`currentScene` 是全局单值，按场景名加锁会让两次切换各持一把。
   */
  async switchTo(name, opts = {}) {
    // 独占区由 LifecycleManager 提供（它已经是 owner 级串行的唯一实现，
    // 场景只是借用同一把锁的语义：一个 key = 一个"可变事实"）。
    // 不引入第二套锁实现：两套锁各自维护必然出现"一个排了、一个没排"。
    const lc = this.core?.lifecycle;
    if (lc?.runExclusive) return lc.runExclusive('__scene__', () => this._switchToLocked(name, opts));
    return this._switchToLocked(name, opts);
  }

  /**
   * 场景切换的五段：**Plan → Preflight → Apply → Verify → Commit**。
   *
   * 分层是为让**事务边界**看得见：前四段可失败并保持原状，只有 Commit 改 `currentScene` 并
   * 写盘。所以 Plan 与 Commit 各自成方法，Apply/Verify 留在这里（它们共享同一批可变计数，
   * 抽出去只能靠一个到处传的 ctx，反而让"哪一段在改什么"更难读）。
   */
  async _switchToLocked(name, opts = {}) {
    const plan = await this._planSceneSwitch(name, opts);
    if (plan.halt) return plan.halt;              // 提案模式 / 场景不存在：到此为止
    const { newScene, toRemove, toAdd } = plan;

    // ② Preflight：只读校验，**不改运行系统**。判据只用 `pm.isResolvable`（单一真相）：
    //    自己再拼 dirs+existsSync 会与 PluginManager 分叉，出现"Preflight 说缺、Apply 却装上"。
    //    **场景自己说我不完整，就不许提交成成功**：`_expandIncludes` 的 partial/missingIncludes
    //    若不看，"少装了一整个底座"仍然 ok:true。两者处置相同（都不提交），原因不同所以分开报：
    //    include 缺失错在场景定义，插件不可解析错在插件目录。
    const missingIncludes = Array.isArray(newScene.missingIncludes) ? newScene.missingIncludes : [];
    if (newScene.partial === true || missingIncludes.length) {
      this.core.log('error', `[scene] preflight failed, keeping "${this.currentScene || 'default'}": `
        + `scene "${name}" is incomplete, missing include(s): ${missingIncludes.join(', ') || '(unnamed)'}`);
      return this._sceneFail('scene_preflight_failed', name, {
        missing: [], missingIncludes, partial: true, applied: [],
        error: `Scene "${name}" is declared incomplete: missing include(s) ${missingIncludes.join(', ') || '(unnamed)'}. `
          + 'Refusing to commit a partial assembly as a successful switch.',
      });
    }
    const missing = this.pm?.isResolvable ? toAdd.filter((p) => !this.pm.isResolvable(p)) : [];
    if (missing.length) {
      this.core.log('error', `[scene] preflight failed, keeping "${this.currentScene || 'default'}": missing ${missing.join(', ')}`);
      return this._sceneFail('scene_preflight_failed', name, {
        missing, applied: [], error: `Scene "${name}" requires unavailable plugin(s): ${missing.join(', ')}`,
      });
    }

    // ③ Apply：卸载与装载全部经 PluginManager（`unload` 与 `loadOne` 都走 Lifecycle）。
    // 推迟装配：CLI 的 `scene switch --yes` **不启动内核**（装起来会为算 diff 留下 fs.watch /
    // listen 等活句柄），它只提交"下次启动用哪个场景"⇒ 不能走 Apply/Verify：走一遍什么都没装，
    // 再按 Verify 判成 partial，是把"我本来就没打算装"报成"装失败"。放松 Verify 又会让真缺陷复发，
    // 所以显式分流：`deferAssembly` 跳过装配与核对，返回值如实标 `assembled:false/verification:'deferred'`。
    const t0 = Date.now();
    const deferred = opts.deferAssembly === true;
    if (deferred) {
      this.core.log('info', `[scene] assembly deferred to next start ("${name}"); committing declaration only`);
    }
    const failed = [];
    const unloadIncomplete = [];
    const declared = scenePluginNames(newScene);
    // 卸载判据是**目标场景声明的全集**，不是 Plan 时刻的快照：懒加载不持 `__scene__` 锁，
    // 快照之后（含 Apply 内部）插进来的也必须清掉，否则它留在运行态而 Verify 看不见。
    const unloadTracked = async (p) => {
      const u = await this.pm.unload(p);
      if (u?.ok !== false) return;
      unloadIncomplete.push({ name: p, code: u.code || null, inflight: u.inflight ?? 0, error: u.error });
    };
    if (!deferred) {
      for (const p of toRemove) await unloadTracked(p);
      for (const p of toAdd) {
        const r = await this._loadSingle(p);
        if (!r.ok) failed.push({ name: p, error: r.error });
      }
      for (const pn of [...this.core.plugins.keys()]) {
        if (SCENE_ALWAYS_ON.includes(pn) || declared.has(pn) || toRemove.includes(pn)) continue;
        toRemove.push(pn);
        await unloadTracked(pn);
      }
    }
    if (unloadIncomplete.length) {
      this.core.log('error', `[scene] unload incomplete: ${unloadIncomplete.map((u) => u.name).join(', ')}`);
      // 在途被打断、副作用未知 ⇒ 不得提交场景身份（applied 如实列出本轮已装的）。
      return this._sceneFail('scene_unload_incomplete', name, {
        partial: true, applied: toAdd.filter((p) => this.core.plugins.get(p)?.state === 'running'), removed: toRemove,
        unload_incomplete: unloadIncomplete, missing: [], failed,
        error: `Scene "${name}": ${unloadIncomplete.length} plugin(s) not cleanly unloaded`,
      });
    }

    // ③b lazy 登记：把本场景声明为按需装载的插件**登记进懒加载索引**（只读文件头，不 import）。
    // 这是"从 toAdd 排除 lazy"的配套：`_lazyResolver()` 只从 `_pending` 取来源，没登记就等于
    // 永久不可调用 —— 比"装得太早"更糟。
    // 运行中切换这一段由这里补；撤销按目标场景的有效声明全集对账，不看"这次谁被我登记过"。
    const lazyNames = sceneLazyNames(newScene);
    const lazyIndexed = [];
    const lazyUnresolved = [];
    let lazyDropped = [];
    if (!deferred) {
      if (typeof this.pm?.indexLazy === 'function') {
        for (const p of lazyNames) {
          const r = await this.pm.indexLazy(p, `scene:${name}`);
          if (r.ok) lazyIndexed.push(p); else lazyUnresolved.push({ name: p, error: r.error });
        }
        // `_sceneLazy` 初值为 null 时，启动期由 `loadAll` 登记的索引从来没人撤，
        // 切到完全不包含它的场景后仍能激活（legacy 照常装载成功）。
        if (typeof this.pm?.reconcileLazy === 'function') {
          const rec = this.pm.reconcileLazy(lazyNames, name);
          lazyDropped = rec.dropped;
          if (lazyDropped.length) {
            this.core.log('info', `[scene] lazy index revoked (not declared by "${name}"): ${lazyDropped.join(', ')}`);
          }
        }
      }
      if (lazyUnresolved.length) {
        this.core.log('warn', `[scene] ${lazyUnresolved.length} lazy plugin(s) declared by "${name}" `
          + `could not be indexed (${lazyUnresolved.map((x) => x.name).join(', ')}) — 首次能力调用会失败`);
      }
    }

    // ④ Verify：读**真实**运行态，而不是读"我刚发过的意图"。判据是"场景要求的谁在跑"：
    // 目标插件早就在 Map 里但 `state==='error'` 时 toAdd=[] ⇒ stillMissing=[] ⇒ ok:true，
    // 而它仍然坏着。必需集合 = **eager**（`plugins`/`lazy` 要求 running 会把懒加载判成失败）。
    const required = sceneRequiredNames(newScene);
    const runningNow = (p) => this.core.plugins.get(p)?.state === 'running';
    // 两个**不同**的事实不能互相顶替：`addedNow` = 本轮新装进去的（重复切换必须为 []），
    // `stillMissing` = 全部必需插件里没在跑的（空数组才算通过）。把 `toAdd` 直接换成
    // "全部必需集合"，重复切同一场景时 `toAdd` 就会变成 ['rep'] —— "又装了一次"。
    const addedNow = deferred ? [] : toAdd.filter(runningNow);
    const stillMissing = deferred ? [] : [...required].filter((p) => !runningNow(p));

    return await this._commitSceneSwitch({
      name, newScene, deferred, toAdd, addedNow, toRemove, stillMissing, required, t0,
      failed, lazyIndexed, lazyUnresolved, lazyDropped, runningNow,
    });
  }

  /**
   * ① Plan：只读。算"从当前运行集合到目标场景"的增删，不碰运行系统。
   * 返回 `{ halt }` 表示到此为止（场景不存在 / 只是提案），否则返回差异本身。
   */
  async _planSceneSwitch(name, opts) {
    const newScene = await this.findScene(name);
    if (!newScene) return { halt: { ok: false, error: `Scene "${name}" not found` } };
    const oldPlugins = new Set();
    // `baselinePlugins`：由调用方给出"当前场景声明的插件名"，只用于**提案**的差异计算。
    // 需要这个口子：CLI 的 `scene switch` 是**只读提案**、不装载任何插件（为算 diff 把内核
    // 装起来会让命令永不退出），所以差异计算与运行态分开 —— 提案用**声明**算，Apply 用
    // **实况**算。此前它把插件"假装登记"进 `core.plugins`，于是运行态出现"在册但没跑"的
    // 幽灵，而 `pm.loadOne` 见到名字在册就短路成 `alreadyLoaded`。
    if (Array.isArray(opts.baselinePlugins)) {
      for (const pn of opts.baselinePlugins) if (!SCENE_ALWAYS_ON.includes(pn)) oldPlugins.add(pn);
    } else {
      for (const [pn] of this.core.plugins) if (!SCENE_ALWAYS_ON.includes(pn)) oldPlugins.add(pn);
    }
    const newPlugins = scenePluginNames(newScene);
    const toRemove = [...oldPlugins].filter(p => !newPlugins.has(p));
    // `toAdd` 只用 `sceneRequiredNames`（就是 eager）：用声明全集会把 lazy 当场装成 running
    // —— Apply 装它、Verify 又说不必装。按需的那批仍要进 `_pending` 索引，否则
    // `_lazyResolver()` 找不到它。
    const toAdd = [...sceneRequiredNames(newScene)].filter(p => !oldPlugins.has(p));

    if (!opts.yes) {
      this.core.log('info', `Scene switch "${this.currentScene || 'default'}" → "${name}"`);
      if (toRemove.length) this.core.log('info', `  Remove: ${toRemove.join(', ')}`);
      if (toAdd.length) this.core.log('info', `  Add: ${toAdd.join(', ')}`);
      if (!toRemove.length && !toAdd.length) this.core.log('info', '  No changes');
      // 提案里 `toAdd` 只是"这次会装的"，按需清单单独列 —— 两件事不能合并汇报，
      // 否则 CLI 会把"声明可用"说成"马上要装"。
      return { halt: { ok: true, toRemove, toAdd, lazy: sceneLazyNames(newScene), diff: true, scene: newScene } };
    }

    return { newScene, toRemove, toAdd };
  }

  /**
   * ⑤ Commit：把"已经成立"的切换落成场景身份与持久配置。单独成方法的理由不是行数，
   * 而是"提交点在哪必须能从方法名看出来"。
   */
  async _commitSceneSwitch({
    name, newScene, deferred, toAdd, addedNow, toRemove, stillMissing, required, t0,
    failed, lazyIndexed, lazyUnresolved, lazyDropped, runningNow,
  }) {
    // ⑤ Commit：只有全部到齐才提交场景与持久配置。
    if (stillMissing.length) {
      this.core.log('error', `[scene] partial: ${required.size - stillMissing.length}/${required.size} required plugin(s) running, not running: ${stillMissing.join(', ') || '无'}`);
      // 部分应用**已经发生**（部分插件已启动/停止），这条是事实而不是请求，
      // 观察者抛错不得把 scene_partial 的返回值换成另一个异常。
      this.core.emitFact('scene.switch_partial', {
        to: name, applied: addedNow, missing: stillMissing, removed: toRemove,
        timestamp: new Date().toISOString(), sourcePlugin: 'scene-controller',
      });
      return this._sceneFail('scene_partial', name, {
        partial: true, applied: addedNow, missing: stillMissing, removed: toRemove, failed,
        error: `Scene "${name}" applied partially: ${stillMissing.length} required plugin(s) not running`,
      });
    }

    const oldScene = this.currentScene;
    this.currentScene = name;
    const switchTime = Date.now() - t0;
    const cfg = this.core.getService('config');
    let persisted = false;
    // **无变化时不得再写一次持久配置**：多一次 IO 不是问题，问题是留下一条"我提交过"的写记录
    // —— 事后分不清"用户切了两次"与"系统自己又写了一次"。
    //
    // "没有变化"要把两个事实分开算：**场景身份**（A→B 不同名同配方仍是切换，必须提交名称，
    // 否则返回 `persisted:false` 而磁盘仍是 A，重启后分叉）与**运行集合**（推迟装配时 `toAdd`
    // 只是"待装清单"，拿它当"变了"的证据会让同场景第二次切换永远重写一次盘）。
    const pluginSetChanged = deferred
      ? false                                     // 没装配 ⇒ 运行集合不变
      : (toRemove.length > 0 || [...toAdd].some((p) => runningNow(p)));
    const sceneIdentityChanged = oldScene !== name;
    // 无变化早返回**只能在"持久状态确实已一致"时**：`setAndSave` 抛错后 `currentScene` 已被
    // 写成 A，第二次同名切换会 `oldScene===name` 且无增删 —— 直接早返回，那次失败的提交就
    // 永远等不到重试。判据因此不看"这次要做什么"，只看**持久状态是否已等于目标**，且不能拿
    // `currentScene` 判断（它恰恰是失败时也会被写的那个值）。
    const targetAlreadyPersisted = this._persistedScene === name;
    if (!pluginSetChanged && !sceneIdentityChanged && targetAlreadyPersisted) {
      this.core.log('info', `[scene] "${name}" already active and persisted; not re-persisting`);
      return {
        ok: true, toRemove, toAdd: addedNow, scene: newScene, switchTime, lazyDropped,
        verified: !deferred, persisted: false, unchanged: true,
        ...(deferred ? { assembled: false, verification: 'deferred' } : {}),
      };
    }
    // 必须 await：不 await 就是"没落盘就返回"，而 CLI 紧接着读写同一个 config.json ⇒ 两个
    // 写者抢文件，后者读到半写状态、解析失败后退化成 `{activeScene}`，把用户其他键静默冲掉。
    // **默认配置必须与 activeScene 在同一次落盘里提交**：先把本次要写的全部键写进内存、
    // 再**一次** save（只靠 `setAndSave` 逐键写时，`set` 只改内存，返回值会报 `persisted:true`
    // 而磁盘上没有 defaultConfig —— 重启后默认配置消失，系统却已经宣告过"持久化成功"）。
    // `persisted:true` 因此只在一个含义上使用 —— "本次声明的全部内容都已落盘"。
    try {
      if (cfg) {
        // 能力探测而非假定：① set+save（真实形态，全部键一次落盘）；② 只有 setAndSave
        // （逐键写，键仍完整，只是多几次 IO）；③ 只有 setAndSave 没有 set（旧测试桩形态）。
        // ③ 仍必须接受，否则就是把"修好一个缺陷"变成"弄坏一个合法实现"。
        const canSet = typeof cfg.set === 'function';
        const canSave = typeof cfg.save === 'function';
        if (canSet && canSave) {
          cfg.set('activeScene', name);
          if (newScene.defaultConfig) {
            for (const [k, v] of Object.entries(newScene.defaultConfig)) cfg.set(k, v);
          }
          await cfg.save();                      // 全部键已在内存，一次落盘
        } else if (canSet) {
          cfg.set('activeScene', name);
          if (newScene.defaultConfig) {
            for (const [k, v] of Object.entries(newScene.defaultConfig)) cfg.set(k, v);
          }
          await cfg.setAndSave('activeScene', name);
        } else {
          // 没有 set：只能逐键 setAndSave。默认配置也要落，否则默认值会丢。
          await cfg.setAndSave('activeScene', name);
          if (newScene.defaultConfig) {
            for (const [k, v] of Object.entries(newScene.defaultConfig)) await cfg.setAndSave(k, v);
          }
        }
        persisted = true;
        this._persistedScene = name;
      }
    } catch (err) {
      // 运行态已切换成功、落盘失败 —— 两件不同的事，分开报（I-07）。
      // 推迟装配时运行态**没**切换（本来就没装配），故 runtime_applied 如实取反。
      // 关键：**不写 `_persistedScene`** —— 它代表"已核实的持久事实"，失败时不存在这条事实。
      // 下一次同名切换因此不会命中早返回，会真的重试。
      this.core.log('error', `[scene] runtime switched but persist failed: ${err.message}`);
      return { ...this._sceneFail('scene_persist_failed', name, {
        runtime_applied: !deferred, persisted: false, toRemove,
        toAdd: deferred ? toAdd : addedNow, error: err.message,
      }), currentScene: name };   // 运行态确实已切换，与"未提交"的失败区分开
    }
    this.core.log('info', `Scene switched to: ${this.core.colorize('cyan', name)} (${switchTime}ms)`);
    this.core.emitFact('scene.switched', {
      from: oldScene, to: name, removed: toRemove, added: addedNow, switchTime,
      timestamp: new Date().toISOString(), sourcePlugin: 'scene-controller',
    });
    // 推迟装配时**不得**说 verified:true —— 本轮根本没核对过运行态（I-07）。
    // 两个字段分开表达："是否核对过"与"核对结果如何"。`toAdd` 在推迟时就是"待装清单"。
    //
    // `lazy` 单独回报，不混进 `toAdd` —— "声明可用"和"这次装了"是两件事。
    // `lazyUnresolved` 非空意味着场景声明了索引不到的 lazy 插件：切换本身仍然成功
    // （它现在不需要运行），但首次能力调用会失败，必须让调用方看得见。
    return {
      ok: true, toRemove, toAdd: deferred ? toAdd : addedNow,
      scene: newScene, switchTime, persisted,
      verified: !deferred, ...(deferred ? { assembled: false, verification: 'deferred' } : {}),
      ...(deferred ? {} : { lazy: lazyIndexed, lazyUnresolved }),
    };
  }

  /**
   * 场景失败信封。三处失败返回的公共字段抽在这里：各写一遍时加一个字段要改三处，
   * 漏一处就会出现"同一个 code 不同形状"。
   */
  _sceneFail(code, name, extra) {
    return { ok: false, code, scene: name, currentScene: this.currentScene, ...extra };
  }

  /**
   * 装载单个插件。保留这个名字是因为它是既有测试与外部调用方的桩点，内部已转发
   * `pm.loadOne` → Lifecycle：自己 import/register/init/start 会绕开它（第 4 条装配路径）。
   */
  async _loadSingle(name) {
    return this.pm.loadOne
      ? this.pm.loadOne(name)
      : { ok: false, name, error: 'plugin-manager has no loadOne()' };
  }

  async listScenes() {
    const scenes = [];
    for (const base of SCENE_SEARCH) {
      const dir = isAbsolute(base) ? base : resolve(process.cwd(), base);
      if (!existsSync(dir)) continue;
      try {
        const files = await readdir(dir);
        for (const f of files.filter(f => f.endsWith('.json5'))) {
          scenes.push({ name: f.slice(0, -6), dir: base });
        }
      } catch {
        this.core?.log('warn', `[scene] Failed to read directory: ${base}`);
      }
    }
    return scenes;
  }

  // show 只看 scene.plugins 时，多数场景把插件写在 eager 里（coding: eager 18、
  // plugins 0）⇒ show('coding') 返回空列表看着像"无插件"。真诊断在 plugins/scene-inspect.js
  // （80+ 行、本模块预算已满；且"声明与实况是否一致"是可失败观测，不该进内核）。此处只委托，
  // 诊断缺席时退回旧口径并标 diagnostic:'unavailable' —— 不让退路看起来像全貌。
  async show(name) {
    const scene = await this.findScene(name);
    if (!scene) return { ok: false, error: `Scene "${name}" not found` };
    const svc = this.core.getService?.('scene-inspect');
    const full = svc?.inspect ? await svc.inspect(name) : null;
    if (full?.ok) {
      return { ok: true, scene, diagnostic: 'full', consistent: full.consistent, problems: full.problems,
        plugins: full.plugins.map((p) => ({ name: p.name, loaded: p.loaded, state: p.state, status: p.status, declared_in: p.declared_in })) };
    }
    if (svc?.inspect) return { ok: false, code: full?.code || 'inspect_failed', error: full?.error || 'inspect failed', scene };
    const plugins = (scene.plugins || []).map((p) => {
      const loaded = this.core.plugins.get(p);
      return { name: p, loaded: !!loaded, state: loaded?.state, metrics: loaded?._metrics };
    });
    return { ok: true, scene, diagnostic: 'unavailable', plugins,
      note: 'scene-inspect plugin is not assembled; this covers scene.plugins only (eager entries are NOT included)' };
  }
}

export { SceneController, scenePluginNames, sceneRequiredNames };
export default SceneController;
