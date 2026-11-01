import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const TOOL_IDLE_TTL = 10 * 60 * 1000;
const TOOL_CHECK_INTERVAL = 60 * 1000;

function extractToolMeta(src) {
  const nameMatch = src.match(/^\s*name\s*=\s*'([^']+)'/m);
  const descMatch = src.match(/^\s*description\s*=\s*'([^']+)'/m);
  const name = nameMatch ? nameMatch[1] : null;
  const description = descMatch ? descMatch[1] : '';
  return { name, description };
}

class ToolLoader {
  name = 'tool-loader';
  version = '0.5.0';
  // R0-156（v0.9.32 续）：`provides` 里的名字必须与 `registerService` 的**实际注册名**一致。
  // 修前这里写 `tool.registry`（点号），而 init 里 `registerService('tool-registry')`（连字符）。
  // 后果是**闸门假绿灯**：`tool-executor` 的 manifest.requires 也写 `tool.registry`，
  // 两边都写点号 ⇒ validateAssembly 认为依赖满足；运行期 `getService('tool.registry')`
  // 却是 undefined（实测）。这是"闸门通过"与"实际取得到"之间的一道裂缝。
  // 以 registerService 的名字为准（那才是 getService 能取到的键）。
  provides = [{ name: 'tool-registry', type: 'service', removable: false }];

  constructor() {
    this._tools = new Map();
    this._fileCache = new Map();
    this._toolAccess = new Map();
    this._stubs = new Map();
    this._recycleTimer = null;
    this._reloadCounter = 0;
  }

  async init(core) {
    this.core = core;
    this._dir = join(core.pluginsDir, 'tools');
    // 目录句柄：注销凭它，不凭 owner 字符串；WeakMap 不可枚举，遍历 `_tools` 也拿不到。
    this._dirHandles = new WeakMap();
    // 托底清场（ID-13）：插件没保存句柄就卸载时，目录项不能留着变成幽灵。
    core.on?.('core:plugin.unloading', ({ pluginName } = {}) => {
      const inst = core.plugins.get(pluginName);
      if (!inst) return;
      for (const [n, e] of [...this._tools]) if (e._registrar === inst) this._tools.delete(n);
    });
    core.registerService('tool-registry', this);

    try {
      const files = await readdir(this._dir);
      for (const f of files) {
        // R0-96（维护者授权）：`.mjs` 与 `.js` 同为 ESM（package.json type=module），plugin-manager/
        // scene-controller 本就接受 `.mjs`；此处只认 `.js` 会让 plugins/tools/*.mjs 被静默丢出索引，
        // 而角色提示词/allowedTools 仍在宣传它（实测 tool-cpf-search：LLM 一调必得"工具不存在"）。
        if (!f.startsWith('tool-') || !/\.m?js$/.test(f)) continue;
        await this._indexToolMeta(f);
      }
    } catch (err) {
      core.log('warn', `ToolLoader: tools dir read error: ${err.message}`);
    }

    this._startRecycleTimer();
    core.log('info', `ToolLoader: ${this._tools.size} tools indexed`);
  }

  start() {
  }

  stop() {
    this._stopRecycleTimer();
    for (const [name, tool] of this._tools) {
      if (!tool._lazy && typeof tool.stop === 'function') {
        try { tool.stop(); } catch (err) { this.core?.log?.('warn', '[ToolLoader] Failed to stop tool: ' + (err?.message || 'unknown')); }
      }
    }
  }

  async _indexToolMeta(filename) {
    const filePath = join(this._dir, filename);
    this._fileCache.set(filename, filePath);

    try {
      const src = await readFile(filePath, 'utf8');
      const meta = extractToolMeta(src);

      try {
      const mod = await import(`${pathToFileURL(filePath).href}?t=${Date.now()}`);
        const tool = mod.default || mod;
        if (!meta.name) meta.name = tool.name;
        if (!meta.description) meta.description = tool.description || '';
        meta.parameters = tool.parameters || { type: 'object', properties: {} };
      } catch (err) { this.core?.log?.('warn', '[ToolLoader] Failed to import tool module: ' + (err?.message || 'unknown')); }

      if (!meta.name) {
        this.core.log('warn', `ToolLoader: ${filename} has no name, skipping`);
        return;
      }

      this._tools.set(meta.name, {
        _lazy: true,
        _filename: filename,
        // E2：索引项也必须有 owner。修前它们是"无主工具"——`listTools` 无法按归属过滤，
        // 注销时也分不清"这是随包内建还是别人塞进来的"。归属取工具自己的名字
        // （`tool-write` → `tool-write`），与 `init(core)` 里 `registerCapability(owner)` 的习惯一致。
        _owner: meta.name,
        name: meta.name,
        description: meta.description || '',
        parameters: meta.parameters || { type: 'object', properties: {} },
      });
    } catch (err) {
      this.core.log('warn', `ToolLoader: failed to index ${filename}: ${err.message}`);
    }
  }

  async _lazyLoadTool(name) {
    const stub = this._tools.get(name);
    if (!stub || !stub._lazy) return stub;

    this._stubs.set(name, {
      _lazy: true,
      _filename: stub._filename,
      _owner: stub._owner,
      name: stub.name,
      description: stub.description || '',
      // 回收后的存根必须保留**声明过的** parameters。写死空 schema 的话，工具闲置
      // 被回收后，模型看到的参数声明从完整版本退化成 `{}`（danger_ack 等字段凭空消失）
      // —— 懒索引前、懒加载后、回收后三处对模型必须是同一份契约。
      parameters: stub.parameters || { type: 'object', properties: {} },
    });

    const filePath = this._fileCache.get(stub._filename);
    if (!filePath) return null;

    try {
      const mod = await import(pathToFileURL(filePath).href);
      const tool = mod.default || mod;

      if (typeof tool.init === 'function') {
        await tool.init(this.core);
      }
      this._applyDeclaredSchema(tool);

      tool._lazy = false;
      // E2：`_owner` 必须跨"懒索引 → 实体"这一步存活，否则 `listTools({owner})`
      // 在懒加载前后给出两套答案（同一个工具，一会儿有主一会儿无主）。
      tool._owner = stub._owner;
      this._tools.set(name, tool);
      this.core.emit('agent.tool.register', {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.parameters || { type: 'object', properties: {} },
        timestamp: new Date().toISOString(),
        sourcePlugin: 'tool-loader',
      });
      return tool;
    } catch (err) {
      this.core.log('error', `ToolLoader: failed to lazy load ${name}: ${err.message}`);
      return null;
    }
  }

  async recycleTool(name) {
    const tool = this._tools.get(name);
    if (!tool || tool._lazy) return;

    if (typeof tool.stop === 'function') {
      try { await tool.stop(); } catch (err) { this.core?.log?.('warn', '[ToolLoader] Failed to recycle tool: ' + (err?.message || 'unknown')); }
    }

    const stub = this._stubs.get(name);
    if (stub) {
      this._tools.set(name, stub);
      this._stubs.delete(name);
    }
  }

  _startRecycleTimer() {
    if (this._recycleTimer) return;
    this._recycleTimer = setInterval(() => this._checkToolIdle(), TOOL_CHECK_INTERVAL);
    // v0.15.2：工具回收扫描是后台维护（真正在跑的工具调用有自己的句柄）。
    this._recycleTimer.unref?.();
  }

  _stopRecycleTimer() {
    if (this._recycleTimer) {
      clearInterval(this._recycleTimer);
      this._recycleTimer = null;
    }
  }

  async _checkToolIdle() {
    const now = Date.now();
    for (const [name, tool] of this._tools) {
      if (tool._lazy) continue;
      const lastAccess = this._toolAccess.get(name) || 0;
      if (now - lastAccess > TOOL_IDLE_TTL) {
        await this.recycleTool(name);
      }
    }
  }

  async reloadTool(filename) {
    const filePath = this._fileCache.get(filename);
    if (!filePath) return false;
    this._reloadCounter++;
    try {
      const mod = await import(`${pathToFileURL(filePath).href}?v=${this._reloadCounter}`);
      const tool = mod.default || mod;
      if (typeof tool.init === 'function') {
        await tool.init(this.core);
      }
      this._applyDeclaredSchema(tool);
      tool._lazy = false;
      tool._owner = this._tools.get(tool.name)?._owner ?? tool.name;
      this._tools.set(tool.name, tool);
      this.core.emit('agent.tool.reloaded', {
        name: tool.name,
        filename,
        timestamp: new Date().toISOString(),
        sourcePlugin: 'tool-loader',
      });
      return true;
    } catch (err) {
      this.core.log('error', `ToolLoader: failed to reload ${filename}: ${err.message}`);
      return false;
    }
  }

  /**
   * R0-145（v0.9.31 续）：把工具**已经声明**的 `parameters` 接到能力的 `input_schema` 上。
   *
   * 事实：10 个内建工具全都写了 `parameters = { type:'object', properties:{…}, required:[…] }`，
   * 但 `tool.init(core)` 里 `core.registerCapability('tool.write', { handler, owner })` ——
   * **一个都没传 `input_schema`**。于是这份声明只有两个读者：提示词（给模型看）
   * 和 `agent.tool.register` 事件（给控制台看）。**执行期零校验。**
   *
   * 实测（真 tool-write、`core.callCapability('tool.write', {path:12345, content:null})`）：
   * 能力登记里 `input_schema` 为 `undefined`，core 的 schema 门直接跳过；
   * 最终报错来自工具**手写**的 `if (!path) throw ...`，而不是声明出来的形状。
   *
   * 为什么这算缺陷而不是风格：本项目反复修的就是"声明了但执行期零读者"
   * （`permission_mode`、`retrieval.mode`、`sandbox.strategy` 都是同一形状）。
   * `parameters` 是**给模型看的**接口契约；模型据此构造入参，而真正的门却不用它 ——
   * 于是"声明"与"执行"可以无声地分叉：改了 `parameters` 而忘了改手写校验，没人会发现。
   *
   * 为什么在这里补而不是改 10 个工具：
   *   ① `init` 是每个工具自己的事，改 10 处就有 10 处再忘的机会；
   *   ② 这里覆盖**所有**工具，包括用户插件 —— 它们同样声明了 `parameters`；
   *   ③ 只在能力**确实没有** `input_schema` 时补，不覆盖任何人显式声明的 schema。
   *
   * 边界（诚实）：它校验的是 `type` / `required` / `properties.*.type`（core 的
   * `_schemaViolation` 支持面），不是完整 JSON Schema。工具里手写的语义校验（例如
   * "content 不能是 undefined 但可以是空串"）仍然保留 —— 这层只是让**声明**也生效。
   */
  _applyDeclaredSchema(tool) {
    const params = tool?.parameters;
    if (!params || typeof params !== 'object' || params.type !== 'object') return;
    if (typeof this.core?.attachInputSchema !== 'function') return;   // 旧 core：不做（也不假装做了）
    for (const { id, owner } of (this.core.listCapabilities() ?? [])) {
      if (owner !== tool.name) continue;
      // 只在能力**确实没有** schema 时补；已有显式声明的一律不动（见方法注释 ③）
      this.core.attachInputSchema(id, params);
    }
  }

  // ══ E2（v0.9.33）：模型工具的**公开**注册/注销门面 ═══════════════════════
  //
  // 事实（v0.9.32 送审报告 EV-04）：`context-port.js`、`experience-port.js`、
  // `plugin-context.js` 三处都直接写 `registry._tools.set(...)` / `.delete(...)`。
  // 那是私有 Map —— 它不是接口，是一次"当前实现恰好长得像 API"的巧合。
  //
  // 为什么这算缺陷而不是风格：私有字段一旦改名或换结构，三处**同时静默失效**，
  // 失效方式是"工具看不见了"或"幽灵工具还在"——看起来像配置问题，不像代码坏了。
  // 本轮把这些路径迁到门面上，`_tools` 从此只由本文件写。
  //
  // 合同（与计划书 E2 对齐）：
  //   · `owner` 必填：无主插入一律拒绝（否则没人能说清这个工具是谁的、该由谁注销）；
  //   · 同名冲突**拒绝**而不是覆盖：覆盖会让后来的插件悄悄顶掉别人已发布的工具；
  //   · 注销只能删**自己 owner 的**工具，不得擅自取消别家能力；
  //   · 模型可见 ≠ 有权执行：真正执行仍必须走 ToolExecutor 的能力解析/资格/捆仙索/入参校验。
  //     门面只管"模型看得到什么"，它不是授权真值。

  /**
   * 注册一个模型可见工具。
   * @param {{name: string, owner: string, description?: string, parameters?: object, capabilityId?: string, execute?: Function}} spec
   * @returns {{ok: boolean, code?: string, error?: string, name?: string}}
   */
  registerTool(spec) {
    const name = typeof spec?.name === 'string' ? spec.name.trim() : '';
    const owner = typeof spec?.owner === 'string' ? spec.owner.trim() : '';
    if (!name) return { ok: false, code: 'invalid_tool_name', error: 'registerTool requires a non-empty name' };
    if (!owner) {
      // 无主插入是**必须**拒的：注销时无法判断"这是不是你的"，于是要么删错别人的，
      // 要么永远删不掉。两个后果都比"注册失败"糟。
      return { ok: false, code: 'owner_required', error: `registerTool("${name}") requires an owner` };
    }
    const existing = this._tools.get(name);
    if (existing && existing._owner !== owner) {
      return {
        ok: false, code: 'tool_name_conflict',
        error: `tool "${name}" is already registered by owner "${existing._owner}"; `
          + `"${owner}" cannot take it over (unregister it first, or pick another name)`,
      };
    }
    // 这一笔目录项的登记实例（对象引用）：注销授权与托底清场都按它判，不按 owner 字符串。
    const registrar = this.core?.currentAssembly?.()?.instance ?? null;
    // 注册为能力：能力 id 可以在 spec 里显式给，否则按内核约定从 tool-<x> 派生。
    // 派生规则与 context-port 原逻辑一致（Cell 能力门的 capIdOf 只认 tool- 前缀）。
    const capId = spec.capabilityId
      || (name.startsWith('tool-') ? `tool.${name.slice('tool-'.length)}` : null);
    if (typeof spec?.execute === 'function') {
      const entry = {
        name,
        description: spec.description || '',
        parameters: spec.parameters || { type: 'object', properties: {} },
        execute: spec.execute,
        _owner: owner,
        _lazy: false,
        _managed: true,
        _registrar: registrar,
        // 这一笔能力登记的管理凭据；注册失败/未注册时为 null ⇒ 注销时绝不碰别人的能力（ID-11）。
        _registration: null,
        // R0-163（六合 Lite 接线时实测）：`capabilityId` 此前是**死参数** ——
        // `registerTool` 用它注册了能力，却没有把它记在目录项上，于是
        //   · `ToolExecutor._capabilityIdsForTool` 只认「名字派生 / provides / owner 反查」三条，
        //     显式给的 id 一条都不命中 ⇒ `capId=null` ⇒ 模型点这个工具名永远 capability_denied；
        //   · `unregisterTool` 释放的是**名字派生**的那个 id，而不是真正注册的那个
        //     ⇒ 显式 id 的能力变成永远摘不掉的幽灵（实测 `after: sneaky.real` 仍在）。
        // 修法：把"这个工具真正注册成哪个能力"钉在目录项上，读它的地方只有两处（解析、注销）。
        // 这不新增语义 —— 它让一个已经写在签名里的参数第一次真的有读者。
        _capabilityId: capId,
        // `provides` 是执行器认的第二条来源。把显式 id 一并写进去，
        // 让"模型看到的工具"与"真正执行的能力"在三条来源上都能对上。
        ...(capId && capId !== (name.startsWith('tool-') ? `tool.${name.slice('tool-'.length)}` : null)
          ? { provides: [{ name: capId, type: 'capability', removable: true }] }
          : {}),
      };
      this._tools.set(name, entry);
      if (capId && typeof this.core?.registerCapability === 'function') {
        try {
          entry._registration = this.core.registerCapability(capId, {
            description: entry.description,
            handler: (args) => entry.execute(args),
            owner,
          });
        } catch (err) {
          // 能力已存在（宿主加固过 / 别家先注册）：保留那一份，目录项明确**降级**为
          // "有工具、无本目录登记"。`_registration` 留空，注销时绝不碰别人的能力。
          //
          // 不要用 `listCapabilities().owner === owner` 反推"这能力是不是我的"：
          // owner 是公开可列举的字符串，冒名者只要声明同一个 owner 就会被认领。
          entry._registration = null;
          entry._capability_external = true;
          this.core?.log?.('warn', `[tool-registry] capability ${capId} not registered: ${err.message}`);
        }
      }
    } else {
      // 只登记元数据（无 execute）：用于"已声明但尚未就绪"，模型能看到但调用会由执行器拒绝。
      this._tools.set(name, {
        name, description: spec.description || '',
        parameters: spec.parameters || { type: 'object', properties: {} },
        _owner: owner, _lazy: false, _managed: true, _declaredOnly: true, _registrar: registrar, _registration: null,
      });
    }
    this.core?.emit?.('agent.tool.register', {
      name, description: spec.description || '', parameters: spec.parameters,
      owner, timestamp: new Date().toISOString(), sourcePlugin: 'tool-registry',
    });
    // 目录句柄：注销时凭它，不凭 owner 字符串。存 WeakMap —— 任何人遍历 `_tools` 也拿不到。
    const handle = Object.freeze(Object.create(null));
    const stored = this._tools.get(name);
    if (stored) (this._dirHandles ??= new WeakMap()).set(handle, stored);
    return { ok: true, name, capability_id: capId, registered_capability: Boolean(stored?._registration), handle };
  }

  /**
   * 注销一个模型可见工具。**只删自己 owner 的**。
   * @param {{name: string, owner: string}} spec
   */
  unregisterTool(spec) {
    const name = typeof spec?.name === 'string' ? spec.name.trim() : '';
    const owner = typeof spec?.owner === 'string' ? spec.owner.trim() : '';
    if (!name) return { ok: false, code: 'invalid_tool_name', error: 'unregisterTool requires a non-empty name' };
    if (!owner) return { ok: false, code: 'owner_required', error: `unregisterTool("${name}") requires an owner` };
    const entry = this._tools.get(name);
    if (!entry) return { ok: false, code: 'tool_not_found', error: `tool "${name}" is not registered` };
    // 授权看**登记身份**，不看 owner 字符串（ID-12）：owner 由调用方自填、且可列举。
    // 两条合法通道：①注册时交回的目录句柄；②在该登记实例的装配上下文内调用。
    const byHandle = spec?.handle != null && this._dirHandles.get(spec.handle) === entry;
    const asm = this.core?.currentAssembly?.() ?? null;
    const byInstance = asm?.instance != null && entry._registrar === asm.instance;
    if (!byHandle && !byInstance) {
      const why = entry._owner !== owner
        ? `tool "${name}" belongs to owner "${entry._owner}", not "${owner}"`
        : `owner "${owner}" 只是声明，不构成撤销授权`;
      return {
        ok: false, code: 'not_owner',
        error: `${why} — 需持注册返回的目录句柄（handle），或在该登记实例的装配上下文内调用；`
          + 'owner 字符串不再是授权依据',
      };
    }
    this._tools.delete(name);
    // **能力也要一起放掉**，但要放对：用 `releaseCapability(id, owner)` 而不是直接删。
    //
    // 这是我第一版漏掉的一条：门面在 `registerTool` 里建了 `tool.<x>` 能力，
    // 注销时只删目录 ⇒ 留下一个 handler 指向已删工具的能力（幽灵能力）。
    // 为什么不能直接 `core._capabilities.delete(...)`：那是私有 Map（本文件刚把它赶出去）；
    // 而 `releaseCapability` 会校验 owner —— 宿主接管过、或别家注册的同名能力不会被误删，
    // 正好对上 E2/f 那条"注销工具不得动别家能力"。
    //
    // R0-163：这里此前**重新派生**了一遍 `tool.<x>`，而注册时用的是 `spec.capabilityId`。
    // 两者不同时（显式给了 id），释放的是另一个能力 —— 实测最坏形态：
    //   · 名字派生的 `tool.sneaky` 被放掉（它不是本工具注册的），
    //   · 真正的 `sneaky.real` 留下，成为摘不掉的幽灵，
    //   · 而返回值照样说 `capability_released: true`。
    // 现在读 `entry._capabilityId`（注册时钉下的**同一个** id），单一真相。
    const capId = entry._managed ? (entry._capabilityId ?? null) : null;
    let capabilityReleased = false;
    let capabilityReason = capId ? 'not_registered_by_directory' : 'no_capability';
    if (entry._registration) {
      // 凭据是**这一笔登记**的：目录项注册成功时留下的那个句柄（ID-06）。
      // 不能再用 `releaseCapability(id, owner)`：那是可列举字符串，不是授权（ID-02/03）。
      capabilityReleased = this.core?.releaseRegistration?.(entry._registration) === true;
      capabilityReason = capabilityReleased ? 'released' : 'stale_registration';
    }
    entry._registration = null;
    this.core?.emit?.('agent.tool.unregister', {
      name, owner, capability_id: capId, capability_released: capabilityReleased,
      timestamp: new Date().toISOString(), sourcePlugin: 'tool-registry',
    });
    return { ok: true, name, directory_removed: true, capability_id: capId, capability_released: capabilityReleased, reason: capabilityReason };
  }

  /**
   * 列出模型可见工具；`owner` 可按归属过滤。
   * 注意：这是**目录**，不是授权清单。有没有权执行由能力层判。
   */
  listTools(opts = {}) {
    const limit = Number.isInteger(opts?.limit) && opts.limit > 0 ? opts.limit : Infinity;
    const owner = typeof opts?.owner === 'string' && opts.owner ? opts.owner : null;
    const out = [];
    for (const t of this._tools.values()) {
      if (owner && t._owner !== owner) continue;
      out.push({
        name: t.name,
        owner: t._owner ?? null,
        description: t.description || '',
        parameters: t.parameters || { type: 'object', properties: {} },
        ready: t._lazy !== true && t._declaredOnly !== true,
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  list() {
    return Array.from(this._tools.values()).map(t => ({
      name: t.name,
      description: t.description || '',
      parameters: t.parameters || { type: 'object', properties: {} },
    }));
  }

  async get(name) {
    this._toolAccess.set(name, Date.now());
    const entry = this._tools.get(name);
    if (!entry) return null;
    if (!entry._lazy) return entry;
    return this._lazyLoadTool(name);
  }

  has(name) {
    return this._tools.has(name);
  }
}

export default new ToolLoader();
