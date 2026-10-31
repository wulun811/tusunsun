// cell-file-txn — 受控多文件事务器官（Cell × 六合 Lite）。
// 注意：name / version / requires / provides 必须落在文件**前 2048 字节**内 ——
// 懒加载索引（plugin-meta.js 的 readFileHeader）只读这么长，长注释排在字段之后。
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { currentSession } from './_lib/call-context.mjs';

const MAX_FILES = 32;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_PLAN_BYTES = 4 * 1024 * 1024;
const MAX_TXNS = 200;
const MAX_PLANS = 16;
const PLAN_TTL_MS = 10 * 60 * 1000;

class CellFileTxn {
  name = 'cell-file-txn';
  version = '0.1.2';
  requires = { 'liuhe-lite': '>=0.1.3', workspace: '>=0.1.0' };
  provides = [
    { name: 'cell-file-txn', type: 'service' },
    { name: 'tool.txn-plan', type: 'capability', removable: true },
    { name: 'tool.txn-commit', type: 'capability', removable: true },
    { name: 'tool.txn-status', type: 'capability', removable: true },
    { name: 'txn.inspect', type: 'capability', removable: true },
    { name: 'txn.undo', type: 'capability', removable: true },
  ];
  permissions = ['fs.read', 'fs.write'];
  tags = ['filesystem.write', 'transaction', 'recovery'];
  cohesion = 'atomic';
  description = '受控多文件事务：锚 → 计划 → 提交（逐文件如实）→ 回执详情 → 条件撤销';

  // ── 这个器官回答的问题 ───────────────────────────────────────────────
  //
  // 单文件写入已经有可信证据（tool-write 的回执、liuhe.apply 的锚与日记）。真实任务很少
  // 只改一个文件：「按这个意图一起改掉这三个文件」是**一次意图、多次写入**。多文件写入的
  // 难点不是「会不会写失败」，而是**写到一半会不会失败**，而失败之后：
  //   · 已经落盘的那几个文件算不算改了？—— 不能说成「什么都没发生」（那是谎话）；
  //   · 没轮到的文件算不算没改？—— 不能凭「我打算改」推断（那也是谎话）。
  // 所以本器官的产出是**逐文件事实**：每个文件一行 application + 自己的 action_id，
  // 事务级只有一个派生状态（committed / partial / rejected），并且**不存在**「假装原子的多文件提交」。
  //
  // ── 为什么它不是 liuhe-lite 的薄包装 ─────────────────────────────────
  //
  // 六合 Lite 的事务单元是**一个文件一次动作**，它不提供跨文件提交。本器官补的正是那一层，
  // 且这一层的每个判断都有独立证据要求：
  //   ① 计划期读锚：提交前所有文件必须先读到锚（任何一个读不到 ⇒ 整笔拒绝，一个字节都不写）；
  //   ② 提交期逐文件复用同一锚：锚变了 ⇒ 该文件 VERSION_CONFLICT，后续文件**不尝试**（不猜意图）；
  //   ③ 撤销是**条件**的：只有「磁盘现值 == 提交后的记录值」才允许回滚，任何一个文件被人改过
  //      就整笔拒（UNDO_CONFLICT），不做「能撤回几个算几个」—— 那会让工作区进入第三态；
  //   ④ 身份与归因来自宿主：session 来自执行器写入的控制字段，cell_id 来自 cell-runtime 的
  //      权威登记表（cellForSession），**不从**模型入参读，也不从会话名字猜；
  //   ⑤ 计划是**内存**事实：插件卸载/重载后旧 plan_id 一律 PLAN_NOT_FOUND ——
  //      拿着一份再也无法核验的计划去写盘，是「用过期证据执行」（正是本仓反复修的形态）。
  //      同样因为它在内存里，它**必须有界**：计划表最多留 MAX_PLANS 条、单笔内容合计
  //      ≤ MAX_PLAN_BYTES（只靠 10 分钟 TTL 不叫有界 —— 见 _gc 的说明）。
  //   ⑥ 已发生的事实走**事实出口**（`core.emitFact`）：观察者同步抛错、异步拒绝、改载荷，
  //      都不许把一次成功的提交/撤销倒写成失败 —— 那是 H-03 给 core.ready 修过的形状，
  //      本轮换了个事件名又长回来（专家 F-01）。老 Core 没有 emitFact 时至少做到两点：
  //      观察者异常绝不冒泡回调用方、异步拒绝必须被消费（否则是进程级 unhandledRejection）。
  //   ⑦ 入口按**身份资格**分面：模型面 `tool.txn-*` 必须有可归属的会话（没有会话不等于
  //      “超级宿主”，只等于没人认领）；宿主服务面 `txn.inspect` / `txn.undo` 保留无会话通道。
  //
  // ── 明确不做 ────────────────────────────────────────────────────────
  //
  //   · 不做跨文件原子提交（做不到就别说）；回执里 partial 是合法状态，不是异常；
  //   · 不给 undo 承诺「一定能撤」：它是条件撤销，条件不成立就拒绝；
  //   · 不把 txn 索引落盘：persistence 恒为 volatile，回执字段如实标；
  //   · 不让 apply/undo 被模型直接点名：commit 是写工具但**必须**由 Cell 授予 tool.txn-commit；
  //     undo 只走能力面（txn.undo），宿主授权才调得动；读的宿主通道是 txn.inspect。
  //     三个模型面工具（plan/commit/status）**一律要求可归属的会话**（见 ⑦）。
  //
  // 能力 id 为什么取**名字派生**的 `tool.txn-*` 而不是语义化的 `txn.plan`：
  //   · 执行器与 Cell 门都能从工具名 `tool-txn-plan` 派生出同一个 id，不需要额外映射；
  //   · 只读分类（`tool-policy.js`）也是按名字派生的，两边不会分叉；
  //   · R3-03 给执行器补的“未注册则用派生 id 触发一次懒加载”也正是读这个派生值。
  //   语义化 id 更漂亮，但它会让“模型看到的工具名”与“真正被授权的能力”之间多一条映射关系，
  //   而多一条映射就多一处可以写错的地方。

  constructor() {
    this._txns = new Map();
    this._plans = new Map();
    this._byRequest = new Map();
    this._seq = 0;
    this._disposed = false;
    this._registeredTools = [];
  }

  async init(core) {
    this.core = core;
    this._disposed = false;
    this._registeredTools = [];
    // 一次装配 = 一份账本。修前这里不清 Map：同进程内换一个 Core 再装配，新 Core 会看到
    // 上一个 Core 的事务、计划与幂等键 —— 于是「计划不跨重载存活」这条承诺在
    // “换 Core 而不换实例”的路径上是假的（1 进程 1 Core 时看不出来，测试里一眼就穿）。
    this._txns.clear();
    this._plans.clear();
    this._byRequest.clear();
    this._planEvictions = 0;

    core.registerService('cell-file-txn', {
      describe: () => this.describe(),
      inspect: (txnId) => this.status({ txn_id: txnId }),
    });

    const registry = core.getService?.('tool-registry');
    const handlerFor = (spec) => (args) => this[spec.action](args || {});
    if (registry && typeof registry.registerTool === 'function') {
      for (const spec of MODEL_VISIBLE) {
        const r = registry.registerTool({
          name: spec.tool,
          owner: 'cell-file-txn',
          description: spec.description,
          parameters: spec.parameters,
          capabilityId: spec.capabilityId,
          execute: handlerFor(spec),
        });
        if (r?.ok) {
          this._registeredTools.push(spec.tool);
          (this._toolHandles ??= new Map()).set(spec.tool, r.handle);
        }
        else core.log('warn', `[cell-file-txn] tool ${spec.tool} not registered: ${r?.error || r?.code}`);
      }
    } else {
      // 没有 tool-registry：能力面照旧可用（宿主 callCapability 能调），只是模型看不到工具。
      // 这与 liuhe-lite 的处置一致：能力是合同，工具是可见性。
      for (const spec of MODEL_VISIBLE) {
        core.registerCapability(spec.capabilityId, {
          description: spec.description,
          handler: handlerFor(spec),
          owner: 'cell-file-txn',
        });
      }
      core.log('warn', '[cell-file-txn] tool-registry 不可用：三个工具未公开注册，四个能力仍可经能力面调用');
    }
    core.registerCapability('txn.inspect', {
      description: 'Read a transaction as the trusted host service: no session context is required, '
        + 'but a session that does not own the transaction is still refused',
      handler: (args) => this.status(args || {}),
      owner: 'cell-file-txn',
    });
    core.registerCapability('txn.undo', {
      description: 'Conditional undo of a committed transaction (refuses unless every file still matches the post-commit hash)',
      handler: (args) => this.undo(args || {}),
      owner: 'cell-file-txn',
    });

    core.log('info', `cell-file-txn ${this.version} ready (model-visible: ${this._registeredTools.join(', ') || 'none'}; `
      + 'txn.inspect/txn.undo are capability-only; txn index is volatile)');
  }

  stop() {
    this._disposed = true;
    const registry = this.core?.getService?.('tool-registry');
    for (const name of this._registeredTools) {
      try {
        const r = registry?.unregisterTool?.({ name, owner: 'cell-file-txn', handle: this._toolHandles?.get(name) });
        // `tool_not_found` = 目录项已被托底清场（ID-13）先收走，不是失败，不该告警。
        if (r && r.ok === false && r.code !== 'tool_not_found') {
          this.core.log('warn', `[cell-file-txn] unregisterTool(${name}) failed: ${r.error || r.code}`);
        }
      } catch (err) {
        this.core?.log?.('warn', `[cell-file-txn] unregisterTool(${name}) threw: ${err?.message || 'unknown'}`);
      }
    }
    this._registeredTools = [];
    this._txns.clear();
    this._plans.clear();
    this._byRequest.clear();
  }

  describe() {
    return {
      provider: 'cell-file-txn',
      version: this.version,
      transactions: this._txns.size,
      plans: this._plans.size,
      plan_evictions: this._planEvictions,
      max_transactions: MAX_TXNS,
      max_plans: MAX_PLANS,
      max_plan_bytes: MAX_PLAN_BYTES,
      model_visible_tools: [...this._registeredTools],
      capability_only: ['txn.inspect', 'txn.undo'],
      persistence: 'volatile',
    };
  }

  // ── 入参：只认本层认识的名字，别的当场拒 ────────────────────────────
  //
  // 为什么不是「忽略多余字段」：host 与 model 共用同一份 JSON 命名空间，多出来的
  // workspace/root/cwd 之类字段一旦被静默忽略，下一个读它的地方就会把它们当真（AR-C05 的形状）。
  // 下划线前缀的键属于宿主下行通道（执行器会先剥掉模型自报的同名值），不在此列。
  _rejectUnknown(args, action) {
    const allowed = ALLOWED_PARAMS[action] || new Set();
    const extra = Object.keys(args || {}).filter((k) => !k.startsWith('_') && !allowed.has(k));
    if (!extra.length) return null;
    return fail('INVALID_INPUT',
      `unexpected parameter(s): ${extra.join(', ')} — this layer accepts no workspace/root selector; `
      + 'the trusted scope comes from the host session', { detail: { rejected_params: extra } });
  }

  _sessionOf(args) {
    const s = args?._sessionId ?? currentSession() ?? null;
    return s == null || s === '' ? null : String(s);
  }

  /** Cell 归因：问 cell-runtime 的**权威登记表**，不猜会话名。 */
  _cellOf(sessionId) {
    const rt = this.core?.getService?.('cell-runtime');
    if (!rt || typeof rt.cellForSession !== 'function') {
      return { cell_id: null, attribution: 'cell_runtime_unavailable' };
    }
    try {
      const hit = rt.cellForSession(sessionId);
      return hit
        ? { cell_id: hit.cell_id, attribution: 'registry_session_match' }
        : { cell_id: null, attribution: 'no_cell_for_session' };
    } catch {
      return { cell_id: null, attribution: 'cell_runtime_error' };
    }
  }

  async _lite(action, params) {
    const env = await this.core.callCapability(`liuhe.${action}`, params);
    const out = env?.payload ?? env;
    if (out && typeof out === 'object') return out;
    return fail('PROVIDER_SHAPE', 'liuhe-lite returned a non-object', { detail: { action } });
  }

  _hash(text) {
    return createHash('sha256').update(String(text), 'utf8').digest('hex');
  }

  /**
   * 事实发布：观察者的毛病不得反向改写已经发生的事（专家 F-01）。
   *
   * 走 `core.emitFact`（H-03 为“已提交事实”准备的出口）：同步异常被隔离并记账，
   * 异步拒绝被消费（否则是进程级 unhandledRejection），载荷是深冻结的快照（观察者改不动）。
   * 老 Core 没有这个出口时至少做到：异常不冒泡、rejection 被消费 —— 宁可不报，不能撒谎。
   */
  _publish(event, payload) {
    const body = { ...payload, sourcePlugin: this.name };
    const core = this.core;
    if (!core) return null;
    if (typeof core.emitFact === 'function') {
      try { return core.emitFact(event, body); }
      catch (err) {
        core.log?.('warn', `[cell-file-txn] emitFact("${event}") itself failed: ${err?.message || err}`);
        return null;
      }
    }
    try {
      const ret = core.emitFast?.(event, body);
      if (ret && typeof ret.then === 'function') ret.then(undefined, () => {});
    } catch (err) {
      core.log?.('warn', `[cell-file-txn] observer of "${event}" threw and was isolated: ${err?.message || err}`);
    }
    return null;
  }

  /** 把投递统计并进回执：成功的事实不因观察者出错而改口，但“有人没收到”必须可见。 */
  _observers(notice) {
    if (!notice) return {};
    return { observers: { delivered: notice.delivered, errors: Array.isArray(notice.errors) ? notice.errors.length : 0 } };
  }

  /**
   * 用**磁盘事实**给“效果未知”的文件对账。
   *
   * 每个文件在计划期都记了 before_sha256，提交后记了 after_sha256，所以读一次锚就能判：
   *   commit 期：现值 == after ⇒ 确实写成了；== before ⇒ 确实没写；第三个值 ⇒ 仍未知。
   *   undo   期：现值 == before ⇒ 确实撤回了；== after ⇒ 还是提交后的样子；第三个值 ⇒ 仍未知。
   * 只有 anchorShaFact 认可的锚才算事实：拿不到 hash、也没明确说“不存在”，就是未知。
   */
  async _reconcile(txn, sessionId, phase) {
    const target = phase === 'undo' ? 'undo_unknown' : 'unknown';
    const pending = txn.files.filter((f) => f.application === target);
    if (!pending.length) return { checked: 0, resolved: 0, unresolved: 0 };
    const rec = { checked: 0, resolved: 0, unresolved: 0 };
    for (const f of pending) {
      rec.checked++;
      let a = null;
      try { a = await this._lite('read_anchor', { path: f.path, _sessionId: sessionId }); } catch { a = null; }
      const sha = a?.ok ? anchorShaFact(a.anchor) : undefined;
      if (sha === undefined) { f.reconciled = 'anchor_unreadable'; rec.unresolved++; continue; }
      if (phase === 'undo') {
        if (sha === f.before_sha256) { f.application = 'undone'; f.reconciled = 'disk_matches_before'; rec.resolved++; }
        else if (sha === f.after_sha256) { f.application = 'applied'; f.reconciled = 'disk_matches_after'; rec.resolved++; }
        else { f.reconciled = 'third_state'; rec.unresolved++; }
      } else if (sha === f.after_sha256) {
        f.application = 'applied'; f.reconciled = 'disk_matches_after'; rec.resolved++;
      } else if (sha === f.before_sha256) {
        f.application = 'rejected'; f.reconciled = 'disk_matches_before'; rec.resolved++;
      } else {
        f.reconciled = 'third_state'; rec.unresolved++;
      }
    }
    txn.reconciled = rec;
    return rec;
  }

  // ── ① plan：只读锚，不写盘 ──────────────────────────────────────────
  async plan(args = {}) {
    if (this._disposed) return fail('PLUGIN_UNLOADED', 'plugin is unloaded; re-assemble before planning');
    // 无会话签出的 plan_id **永远提交不了**（commit 必 SESSION_REQUIRED / PLAN_SESSION_MISMATCH），
    // 那不是“只读预览”，是“假可用”。模型面一律要求会话。
    const sessionId = this._sessionOf(args);
    if (!sessionId) {
      return fail('SESSION_REQUIRED', 'tool.txn-plan needs an attributable session: a plan signed without one '
        + 'could never be committed, because commit requires the same session');
    }
    const bad = this._rejectUnknown(args, 'plan');
    if (bad) return bad;
    const list = args.files;
    if (!Array.isArray(list) || list.length === 0) {
      return fail('INVALID_INPUT', 'files[] is required: a non-empty array of {path, content}');
    }
    if (list.length > MAX_FILES) {
      return fail('TOO_MANY_FILES', `files[] has ${list.length} entries; the limit is ${MAX_FILES} per transaction`);
    }
    const seen = new Set();
    const planned = [];
    let planBytes = 0;
    for (let i = 0; i < list.length; i++) {
      const f = list[i] || {};
      const path = typeof f.path === 'string' ? f.path : '';
      if (!path) return fail('INVALID_INPUT', `files[${i}].path must be a non-empty string`);
      if (typeof f.content !== 'string') {
        return fail('INVALID_INPUT', `files[${i}].content must be a string (an empty string is a legal file body)`);
      }
      const bytes = Buffer.byteLength(f.content, 'utf8');
      if (bytes > MAX_FILE_BYTES) {
        return fail('FILE_TOO_LARGE', `files[${i}].content exceeds ${MAX_FILE_BYTES} bytes`);
      }
      planBytes += bytes;
      if (planBytes > MAX_PLAN_BYTES) {
        return fail('TOO_MANY_BYTES', `the plan's combined content exceeds ${MAX_PLAN_BYTES} bytes`, {
          detail: { limit: MAX_PLAN_BYTES, attempted: planBytes },
        });
      }
      // 去重按**落到哪个文件**判定，不按字符串：provider 用 join(wsRoot, relPath) 解析，
      // 于是 `./src/a.txt` 与 `src/a.txt` 是同一个目标文件；按原串比较会让两者都进计划，
      // 提交时第二份撞上过期锚 ⇒ 一个计划期就能拒的输入错误变成「已经写掉了一个文件」。
      const key = pathKey(path);
      if (seen.has(key)) {
        return fail('DUPLICATE_PATH', `files[${i}].path resolves to the same file as an earlier entry: ${path}`, {
          detail: { path, normalized: key },
        });
      }
      seen.add(key);

      const a = await this._lite('read_anchor', { path, _sessionId: sessionId });
      if (!a?.ok) {
        // 计划期任何一条读不到锚 ⇒ 整笔拒绝。此时**一个字节都还没写**，可以证明无副作用。
        return fail(a?.code || 'ANCHOR_FAILED', a?.message || 'anchor read failed', {
          detail: { path, provider_detail: a?.detail ?? null },
        });
      }
      if (anchorShaFact(a.anchor) === undefined) {
        // ok 但既没有 sha256、也没明确 exists:false ⇒ 不知道，不能写成 exists_before:false。
        return fail('ANCHOR_FAILED', `read_anchor gave no usable fact for ${path}: `
          + 'neither a sha256 nor an explicit exists:false', { detail: { path } });
      }
      const after = this._hash(f.content);
      const changed = a.anchor?.exists !== true || a.anchor.sha256 !== after;
      planned.push({
        path,
        anchor: a.anchor,
        content: f.content,
        after_sha256: after,
        exists_before: a.anchor?.exists === true,
        before_sha256: a.anchor?.sha256 ?? null,
        changed,
      });
    }

    this._gc();
    const planId = `plan_${Date.now().toString(36)}_${(++this._seq).toString(36)}`;
    this._plans.set(planId, {
      plan_id: planId,
      session_id: sessionId,
      cell: this._cellOf(sessionId),
      files: planned,
      created_at: Date.now(),
    });
    return {
      ok: true,
      plan: {
        plan_id: planId,
        created_at: new Date().toISOString(),
        total: planned.length,
        changed: planned.filter((f) => f.changed).length,
        files: planned.map((f) => ({
          path: f.path, exists_before: f.exists_before,
          before_sha256: f.before_sha256, after_sha256: f.after_sha256, changed: f.changed,
        })),
      },
    };
  }

  // ── ② commit：逐文件应用，如实报告 partial ─────────────────────────
  async commit(args = {}) {
    if (this._disposed) return fail('PLUGIN_UNLOADED', 'plugin is unloaded; a stale plan must not be executed');
    const bad = this._rejectUnknown(args, 'commit');
    if (bad) return bad;
    const sessionId = this._sessionOf(args);
    if (!sessionId) {
      return fail('SESSION_REQUIRED', 'commit needs an attributable session: the host session is null '
        + '(a write with no identity cannot be reported to anyone)');
    }
    const planId = typeof args.plan_id === 'string' ? args.plan_id : '';
    if (!planId) return fail('INVALID_INPUT', 'plan_id is required (returned by txn.plan)');
    const plan = this._plans.get(planId);
    if (!plan) {
      return fail('PLAN_NOT_FOUND', `unknown plan_id: ${planId} — plans live in memory and do not survive `
        + 'plugin unload/reload or process restart; re-plan before writing', { retry: 'new_request' });
    }
    if (plan.session_id !== sessionId) {
      return fail('PLAN_SESSION_MISMATCH', `plan ${planId} belongs to another session; a plan is not transferable`);
    }
    const requestId = typeof args.request_id === 'string' && args.request_id ? args.request_id : `${planId}:commit`;
    const prevId = this._byRequest.get(requestId);
    if (prevId) {
      const prev = this._txns.get(prevId);
      if (prev && prev.plan_id === planId && prev.state !== 'applying') {
        // 幂等复播：同一请求不再写盘。“已提交”“提交后又撤销”“提交被拒”是三件事，
        // 各自带具名码 —— 没有 code 的失败会让调用方只能猜。
        if (prev.state === 'committed') return { ok: true, idempotent_replay: true, txn: this._publicTxn(prev) };
        // 状态 → 具名码的映射必须是**表**，不是三元链：三元链的默认分支会把没列出的状态
        // 一律说成 TXN_REJECTED，于是 'undo_partial' / 'indeterminate' 这两种真实状态
        // 被报成一件没发生过的事（“被拒”）。表里没列出的状态另有具名码，不猜。
        const replay = REPLAY_OF[prev.state] || UNKNOWN_REPLAY;
        return {
          ok: false,
          idempotent_replay: true,
          txn: this._publicTxn(prev),
          code: replay.code,
          message: `request_id ${requestId} already resolved as "${prev.state}"; nothing was written again`,
          retry: replay.retry,
        };
      }
      if (prev && prev.state === 'applying') {
        return fail('REQUEST_IN_FLIGHT', `request_id ${requestId} is already in flight`);
      }
      return fail('REQUEST_CONFLICT', `request_id ${requestId} was already used for another plan`);
    }

    this._gc();
    const txn = {
      txn_id: `txn_${Date.now().toString(36)}_${(++this._seq).toString(36)}`,
      plan_id: planId,
      request_id: requestId,
      state: 'applying',
      session_id: sessionId,
      cell: plan.cell,
      created_at: Date.now(),
      files: plan.files.map((f) => ({
        path: f.path, before_sha256: f.before_sha256, after_sha256: f.after_sha256,
        changed: f.changed, application: f.changed ? 'not_attempted' : 'not_needed',
        action_id: null, undo_ref: null, error_code: null,
      })),
    };
    this._txns.set(txn.txn_id, txn);
    this._byRequest.set(requestId, txn.txn_id);

    let failure = null;      // 第一处未收口：{path, code, message, index, effect}
    let threw = null;        // provider 抛出：连结果都没拿到
    let applied = 0;
    let attempted = 0;
    let inflight = null;     // 正在等的那个文件槽 —— 抛出时它是唯一效果未知的一个
    let inflightIndex = -1;
    try {
      for (let i = 0; i < plan.files.length; i++) {
        const src = plan.files[i];
        if (!src.changed) continue;
        // 卸载可以发生在两次 provider 调用**之间**：插件已经被宣布 unloaded 之后，
        // 剩下的文件一个都不许再写（R0-131/B 的同一条道理：放行挂起之后又落盘）。
        // 已写掉的如实留着，并用具名码说清楚 —— 这不能报成「什么都没发生」。
        if (this._disposed) {
          failure = {
            path: src.path, code: 'PLUGIN_UNLOADED', index: i, effect: 'none',
            message: 'plugin was unloaded mid-commit; the remaining files were not attempted',
          };
          break;
        }
        attempted++;
        const slot = txn.files[i];
        inflight = slot;
        inflightIndex = i;
        const r = await this._lite('apply', {
          anchor: src.anchor,
          newContent: src.content,
          requestId: `${txn.txn_id}:${i}`,
          _sessionId: sessionId,
        });
        inflight = null;
        if (r?.ok) {
          applied++;
          slot.application = r.receipt?.application || 'applied';
          slot.action_id = r.receipt?.action_id ?? null;
          slot.undo_ref = r.receipt?.recovery?.ref ?? null;
          continue;
        }
        slot.error_code = r?.code || 'APPLY_FAILED';
        // 「非 ok」≠「没写」。只有 provider 用**约定为『执行前拒绝』的码**回答时，
        // 才能断言这个文件没被碰过；其余（含 INDETERMINATE / NEEDS_REVIEW / 没见过的码）
        // 一律按效果未知处理，并停下不再写后续文件。
        if (effectOf(r) === 'no_effect') {
          slot.application = 'rejected';
          failure = { path: src.path, code: slot.error_code, message: r?.message || 'apply failed', index: i, effect: 'none' };
        } else {
          slot.application = 'unknown';
          failure = { path: src.path, code: slot.error_code, message: r?.message || 'apply failed', index: i, effect: 'unknown' };
        }
        break;
      }
    } catch (err) {
      // 抛出 = 连结果都没拿到。**不能**假定这一笔没写：它可能已经落盘后才断的线。
      threw = { code: err?.code || 'APPLY_THREW', message: String(err?.message || err) };
      if (inflight) {
        inflight.application = 'unknown';
        inflight.error_code = threw.code;
        failure = { path: inflight.path, code: threw.code, message: threw.message, index: inflightIndex, effect: 'unknown' };
      }
      inflight = null;
    }
    // 未收口的那些文件先用**磁盘对账**：读到的锚比 provider 的自述更硬。
    // 这一步也解释了为什么回执里可能同时出现 state=indeterminate 而 applied=N：
    // state 说的是「证据有没有收口」，applied 说的是「此刻磁盘上确实有哪几个」。
    const rec = await this._reconcile(txn, sessionId, 'commit');
    txn.finished_at = Date.now();
    const written = txn.files.filter((f) => f.application === 'applied').length;
    const unresolved = txn.files.filter((f) => f.application === 'unknown').length;
    // 「证据没收口」与「磁盘还是未知」是两个问题：
    //   · 前者：provider 抛了、或它自己说不知道 —— 即使磁盘已经读懂，这笔交易的账也没平；
    //   · 后者：读锚也说不清 —— 连磁盘事实都没有。
    // 收口叫 indeterminate 的是前者；后者只是它的一种特例。分开说，不在一个布尔上拧两件事。
    const inconclusive = Boolean(threw) || failure?.effect === 'unknown';
    if (inconclusive) {
      // 码统一用 INDETERMINATE（与 provider 同一套词汇，不另造），
      // 具体是哪一种“不知道为什么”—— 抛出 / provider 自己说不知道 / 什么码都没给 —— 写进 cause。
      const cause = threw ? 'apply_threw' : 'provider_result_unknown';
      const providerCode = failure?.code ?? null;
      txn.state = 'indeterminate';
      txn.commit_state = txn.state;
      txn.error = {
        code: 'INDETERMINATE', cause, provider_code: providerCode,
        message: threw?.message || failure?.message || 'the provider result was not conclusive',
      };
      const notice = this._publish('txn.resolved', {
        txn_id: txn.txn_id, state: txn.state, applied: written, attempted, unknown: unresolved,
        cell_id: txn.cell?.cell_id ?? null, timestamp: Date.now(),
      });
      return {
        ok: false,
        code: 'INDETERMINATE',
        message: `the apply result is not conclusive (${cause}${providerCode ? `: ${providerCode}` : ''}); `
          + `${written}/${attempted} file(s) confirmed written`
          + (rec.checked ? `; anchors re-read: ${rec.resolved} resolved, ${rec.unresolved} still unknown` : '')
          + ' — reconcile before retrying, do not assume nothing was written',
        retry: 'after_reconcile',
        txn: this._publicTxn(txn),
        detail: { path: failure?.path ?? null, cause, provider_code: providerCode },
        ...this._observers(notice),
      };
    }
    // 收束只有三类，且不许把「无事可做」算成失败：
    //   · 有 failure ⇒ 一个都没写成是 rejected，写成了几个是 partial；
    //   · 没有 failure 且 attempted === 0 ⇒ 每个文件的现值已经等于计划值 ⇒ committed（标 noop）。
    if (failure) txn.state = written === 0 ? 'rejected' : 'partial';
    else txn.state = attempted === 0 || written === attempted ? 'committed' : 'partial';
    if (!failure && attempted === 0) txn.noop = true;
    txn.commit_state = txn.state;
    const retry = failure ? (RETRY_POLICY[failure.code] || 'new_request') : null;
    // 事实出口：观察者抛错不得把已经落盘的提交倒写成 handler_threw（专家 F-01）。
    const notice = this._publish('txn.resolved', {
      txn_id: txn.txn_id, state: txn.state, applied: written, attempted, noop: !!txn.noop,
      cell_id: txn.cell?.cell_id ?? null, timestamp: Date.now(),
    });
    return {
      ok: txn.state === 'committed',
      txn: this._publicTxn(txn),
      ...(failure ? { code: failure.code, message: failure.message, retry, detail: { path: failure.path } } : {}),
      ...this._observers(notice),
    };
  }

  // ── ③ 读：同一个事实，两个入口，两种身份资格 ───────────────────────────
  //
  // 修前只有一个入口，且无会话时**放行**（注释写着“宿主经服务面调用时没有会话上下文，保持可用”）。
  // 那等于把「没有身份」默认成「超级宿主」：专家 F-04 用 core.callCapability 直调复现 ——
  // 带 intruder 会话被拒（对），不带会话却读到原会话 ID 与文件路径。
  // 现在按入口分面：模型面必须有会话，宿主面（txn.inspect）才保留无会话通道；
  // 两边共用同一个 _status()，不把“读事务”写两遍（写两遍就一定会漏一遍）。

  /** 模型面（tool.txn-status）：没有可归属的会话，就不读私有事务。 */
  async inspect(args = {}) {
    const sessionId = this._sessionOf(args);
    if (!sessionId) {
      return fail('SESSION_REQUIRED', 'tool.txn-status is a model-facing entry and needs an attributable session; '
        + 'trusted host code should call the capability txn.inspect instead');
    }
    const bad = this._rejectUnknown(args, 'inspect');
    if (bad) return bad;
    return this._status(args, 'model-tool', sessionId);
  }

  /** 宿主服务面（txn.inspect）：会话可选；给了会话就必须是这笔事务的主人。 */
  async status(args = {}) {
    const bad = this._rejectUnknown(args, 'status');
    if (bad) return bad;
    return this._status(args, 'host-service', this._sessionOf(args));
  }

  _status(args, entry, sessionId) {
    const id = typeof args.txn_id === 'string' ? args.txn_id : '';
    if (!id) return fail('INVALID_INPUT', 'txn_id is required');
    const t = this._txns.get(id);
    if (!t) {
      return fail('NOT_FOUND', `unknown txn_id: ${id} — this index is in memory only and is dropped when the `
        + 'plugin is unloaded; use liuhe.inspect with an action_id to read the provider journal', { retry: 'never' });
    }
    // 读也要判权属（专家 F-04）：给了会话就必须对得上。
    if (sessionId && t.session_id && t.session_id !== sessionId) {
      return fail('TXN_SESSION_MISMATCH', `transaction ${id} belongs to another session`, { retry: 'never' });
    }
    return {
      ok: true,
      entry,
      txn: this._publicTxn(t),
      // “无会话可读”只在宿主服务面成立；回执里写出来，别让调用方以为是同一把尺子。
      ...(sessionId ? {} : { unscoped: true }),
    };
  }

  // ── ④ undo：条件撤销（不满足条件就整笔拒） ─────────────────────────
  async undo(args = {}) {
    if (this._disposed) return fail('PLUGIN_UNLOADED', 'plugin is unloaded');
    const bad = this._rejectUnknown(args, 'undo');
    if (bad) return bad;
    const sessionId = this._sessionOf(args);
    if (!sessionId) return fail('SESSION_REQUIRED', 'undo needs an attributable session');
    const id = typeof args.txn_id === 'string' ? args.txn_id : '';
    if (!id) return fail('INVALID_INPUT', 'txn_id is required');
    const txn = this._txns.get(id);
    if (!txn) return fail('NOT_FOUND', `unknown txn_id: ${id}`);
    if (txn.session_id !== sessionId) return fail('TXN_SESSION_MISMATCH', 'transaction belongs to another session');
    if (txn.state === 'undone') return { ok: true, idempotent_replay: true, txn: this._publicTxn(txn) };
    // 'undo_partial' 必须可重入：已回滚的文件是 'undone'、剩下的还是 'applied'，
    // 重试正好只处理剩下那几个；挡住它会让工作区永久停在「一半旧、一半新」。
    if (!UNDOABLE_STATES.has(txn.state)) {
      return fail('NOT_UNDOABLE',
        `transaction state is "${txn.state}"; only ${[...UNDOABLE_STATES].join('/')} can be undone`);
    }
    // provider 的幂等账按 request_id 记账：同一 id 一次失败后永远只回 INDETERMINATE。
    // 调用方给了 request_id 就接进键里（换 id 才重试得动）；不给时保留历史键。
    const callerRequestId = typeof args.request_id === 'string' && args.request_id ? args.request_id : null;
    // commit 期“效果未知”的文件同样要先收口：undo 只撤已证实写入的文件，
    // 跳过一笔可能已写的文件却报 undone，等于拿状态名冒充磁盘事实。
    if (txn.state === 'indeterminate' || txn.files.some((f) => f.application === 'unknown')) {
      await this._reconcile(txn, sessionId, 'commit');
      const blocked = txn.files.filter((f) => f.application === 'unknown');
      if (blocked.length) {
        txn.undo_error = {
          path: blocked[0].path, code: 'UNDO_INDETERMINATE',
          message: `still unknown after re-reading its anchor: ${blocked[0].path}`,
        };
        return fail('UNDO_INDETERMINATE',
          `cannot undo: ${blocked.length} file(s) still have an unknown commit outcome after re-reading `
          + `their anchors (e.g. ${blocked[0].path}); inspect the workspace before retrying`,
          { txn: this._publicTxn(txn), retry: 'after_reconcile', detail: { unresolved: blocked.length } });
      }
    }
    // 从上一轮“结果未收口”里重试时：先读锚把未知的收敛掉，**再**决定撤谁。
    // 否则即使剩下那几个未知文件后来能证明“已经撤了”，也要再多跑一轮才能收口。
    let reconciledEarly = null;
    if (txn.state === 'undo_indeterminate' || txn.files.some((f) => f.application === 'undo_unknown')) {
      reconciledEarly = await this._reconcile(txn, sessionId, 'undo');
      const blocked = txn.files.filter((f) => f.application === 'undo_unknown');
      if (blocked.length) {
        // 账还没清就先别动 provider：一笔结果未知的 Undo 重发出去，只会让第二笔也无从考证。
        txn.undo_error = {
          path: blocked[0].path, code: 'UNDO_INDETERMINATE',
          message: `still unknown after re-reading its anchor: ${blocked[0].path}`,
        };
        return fail('UNDO_INDETERMINATE',
          `cannot continue: ${blocked.length} file(s) are still unknown after re-reading their anchors `
          + `(e.g. ${blocked[0].path}); inspect the workspace before retrying`, {
            txn: this._publicTxn(txn), retry: 'after_reconcile', detail: { unresolved: blocked.length },
          });
      }
    }
    const undoable = txn.files.filter((f) => f.application === 'applied' && f.undo_ref);
    if (!undoable.length) {
      // "没有可撤的"有两种**相反**含义，必须分开说：
      //   · 从来就没有可撤的文件              ⇒ 真的不可撤，NOT_UNDOABLE；
      //   · 上一轮未知、这一轮对账已证明撤干净  ⇒ 这笔**已经撤销**，只是终态没落地。
      const dirty = txn.files.filter((f) => f.application === 'applied' || f.application === 'undo_unknown');
      const done = txn.files.filter((f) => f.application === 'undone');
      if (!dirty.length && done.length) {
        txn.state = 'undone';
        txn.undone_at = Date.now();
        delete txn.undo_error;
        const notice = this._publish('txn.undone', {
          txn_id: txn.txn_id, undone: done.length, settled_by: 'reconcile', timestamp: Date.now(),
        });
        // 结论来自**磁盘事实**而不是 provider 自述：说清是谁收的口，调用方不必再猜。
        return {
          ok: true, undone: done.length, txn: this._publicTxn(txn), settled_by: 'reconcile',
          reconciled: reconciledEarly || { checked: 0, resolved: 0, unresolved: 0 },
          ...this._observers(notice),
        };
      }
      return fail('NOT_UNDOABLE', 'no applied file carries a recovery reference');
    }

    // 条件检查：提交后有人改过任何一个文件 ⇒ 整笔拒绝。
    // 「能撤几个算几个」会把工作区推进第三态，而回执只能描述其中一半。
    for (const f of undoable) {
      const a = await this._lite('read_anchor', { path: f.path, _sessionId: sessionId });
      if (!a?.ok) {
        return fail(a?.code || 'ANCHOR_FAILED', a?.message || 'cannot read current state', { detail: { path: f.path } });
      }
      if ((a.anchor?.sha256 ?? null) !== f.after_sha256) {
        return fail('UNDO_CONFLICT', `"${f.path}" changed after commit (now ${a.anchor?.sha256 ?? 'absent'}, `
          + `recorded ${f.after_sha256}); refusing a conditional undo`, { retry: 'never', detail: { path: f.path } });
      }
    }

    let undone = 0;
    let failure = null;
    let threw = null;
    let inflight = null;
    for (const f of [...undoable].reverse()) {
      inflight = f;
      try {
        const r = await this._lite('undo', {
          recoveryRef: f.undo_ref,
          requestId: undoProviderKey(txn.txn_id, f, callerRequestId),
          _sessionId: sessionId,
        });
        inflight = null;
        if (!r?.ok) {
          f.error_code = r?.code || 'UNDO_FAILED';
          // 与 commit 同一条道理：非 ok 不等于没撤。只有「执行前拒绝」类码才能断言文件没动。
          failure = { path: f.path, code: f.error_code, message: r?.message || 'undo failed', effect: effectOf(r) };
          if (failure.effect === 'unknown') f.application = 'undo_unknown';
          break;
        }
        f.application = 'undone';
        undone++;
      } catch (err) {
        // 抛出 = 不知道那笔 Undo 到底有没有生效。不能假定它没写，也不能假定它写了。
        threw = { code: err?.code || 'UNDO_THREW', message: String(err?.message || err) };
        if (inflight) {
          inflight.application = 'undo_unknown';
          inflight.error_code = threw.code;
          failure = { path: inflight.path, code: threw.code, message: threw.message, effect: 'unknown' };
        }
        inflight = null;
        break;
      }
    }
    // 结果未收口的先用磁盘对账：撤销前每个文件都还是 after_sha256，所以
    // 「现在是 before」= 撤成功了，「还是 after」= 没撤 —— 不必相信 provider 的自述。
    const rec = await this._reconcile(txn, sessionId, 'undo');
    const unresolved = txn.files.filter((f) => f.application === 'undo_unknown').length;
    if (unresolved) {
      txn.state = 'undo_indeterminate';
      txn.undo_error = {
        path: failure?.path ?? null,
        code: failure?.code || 'UNDO_INDETERMINATE',
        message: failure?.message || 'the undo result was not conclusive',
      };
      return fail('UNDO_INDETERMINATE',
        `the undo result is not conclusive (${txn.undo_error.code}); ${undone} file(s) confirmed restored, `
        + `${unresolved} still unknown — reconcile before retrying: the next txn.undo re-reads the anchors first`, {
          txn: this._publicTxn(txn), retry: 'after_reconcile', detail: { unresolved },
        });
    }
    const stillApplied = txn.files.filter((f) => f.application === 'applied').length;
    // commit 期仍未知的文件不能被“跳过”当成没写：还有一个说不清，就不能报全部撤销。
    const stillUnknown = txn.files.filter((f) => f.application === 'unknown').length;
    if (!stillApplied && !stillUnknown) {
      // 每一个改过的文件都被证实回到了提交前的字节：这是“已撤销”，不是“大概撤了”。
      txn.state = 'undone';
      txn.undone_at = Date.now();
      delete txn.undo_error;   // 重试成功后，上一次的失败记录不能留在回执里冒充当前状态
      const notice = this._publish('txn.undone', { txn_id: txn.txn_id, undone, timestamp: Date.now() });
      return {
        ok: true, undone, txn: this._publicTxn(txn),
        ...(rec.checked ? { reconciled: rec } : {}),
        ...this._observers(notice),
      };
    }
    // 还有文件保持已提交：撤成几个就是几个，但状态不能冒充“已撤完”。
    // 一个都没撤回来时不能报 undo_partial —— 那是「部分已回滚」的断言，而磁盘没变（R3-06/7）。
    if (undone > 0) txn.state = 'undo_partial';
    else txn.state = txn.commit_state || 'committed';
    txn.undo_error = stillUnknown
      ? { path: null, code: 'UNDO_INDETERMINATE', message: `${stillUnknown} file(s) still have an unknown commit outcome` }
      : {
        path: failure?.path ?? null,
        code: failure?.code || 'UNDO_FAILED',
        message: failure?.message || 'undo failed',
      };
    return fail(txn.undo_error.code, txn.undo_error.message, {
      txn: this._publicTxn(txn),
      detail: { path: txn.undo_error.path },
      // undo 期的未知已用读锚收口（undo_unknown === 0）：重试要换请求；
      // commit 期还有未知时则必须先对账，重发同一笔只会再撞一次。
      retry: stillUnknown ? 'after_reconcile' : 'new_request',
    });
  }

  _publicTxn(t) {
    return {
      txn_id: t.txn_id,
      plan_id: t.plan_id,
      request_id: t.request_id,
      state: t.state,
      cell_id: t.cell?.cell_id ?? null,
      cell_attribution: t.cell?.attribution ?? 'unknown',
      session_id: t.session_id,
      created_at: new Date(t.created_at).toISOString(),
      ...(t.finished_at ? { finished_at: new Date(t.finished_at).toISOString() } : {}),
      files: t.files.map((f) => ({
        path: f.path,
        before_sha256: f.before_sha256,
        after_sha256: f.after_sha256,
        application: f.application,
        action_id: f.action_id,
        error_code: f.error_code,
        undo_available: f.application === 'applied' && !!f.undo_ref,
        ...(f.reconciled ? { reconciled: f.reconciled } : {}),
      })),
      // 计数只说**此刻**的事实：撤销完的文件不能再算进 applied。
      // 修前 'undone' 与 'applied' 一起计，于是 state:"undone" 的回执同时写着 applied: 2 ——
      // 一行之内自相矛盾，而模型读的就是这一行。
      applied: t.files.filter((f) => f.application === 'applied').length,
      undone: t.files.filter((f) => f.application === 'undone').length,
      // 效果未证实的两个桶：commit 期叫 unknown，undo 期叫 undo_unknown。
      // 它们**不能**被折进 rejected —— rejected 是“可以断言没写”的那一类。
      unknown: t.files.filter((f) => f.application === 'unknown').length,
      undo_unknown: t.files.filter((f) => f.application === 'undo_unknown').length,
      not_attempted: t.files.filter((f) => f.application === 'not_attempted').length,
      not_needed: t.files.filter((f) => f.application === 'not_needed').length,
      total: t.files.length,
      persistence: 'volatile',
      ...(t.reconciled ? { reconciled: t.reconciled } : {}),
      ...(t.noop ? { noop: true } : {}),
      ...(t.error ? { error: t.error } : {}),
      ...(t.undo_error ? { undo_error: t.undo_error } : {}),
    };
  }

  /** 有界内存：计划过期即丢、条数有上限；事务只留最近 MAX_TXNS 笔。 */
  _gc() {
    const now = Date.now();
    for (const [id, p] of this._plans) if (now - p.created_at > PLAN_TTL_MS) this._plans.delete(id);
    // 只靠 TTL 不叫有界：一条计划最多持有 MAX_PLANS 条 × MAX_FILE_BYTES 的**新内容**，
    // 十分钟内循环调 plan 就能把进程堆到 GB 级（TTL 到期前没有任何回收）。
    // 超限丢最旧的：plan_id 随后得到 PLAN_NOT_FOUND，与“计划不保证存活”的公开口径一致；
    // 丢弃次数记在 describe().plan_evictions，不静默。
    while (this._plans.size >= MAX_PLANS) {
      const oldestPlan = this._plans.keys().next().value;
      this._plans.delete(oldestPlan);
      this._planEvictions += 1;
    }
    while (this._txns.size > MAX_TXNS) {
      const oldest = this._txns.keys().next().value;
      const t = this._txns.get(oldest);
      this._txns.delete(oldest);
      if (t && this._byRequest.get(t.request_id) === oldest) this._byRequest.delete(t.request_id);
    }
  }
}

function fail(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

/** 每个动作认识的入参名（下划线前缀属于宿主通道，不在此列）。 */
const ALLOWED_PARAMS = {
  plan: new Set(['files']),
  commit: new Set(['plan_id', 'request_id']),
  inspect: new Set(['txn_id']),
  status: new Set(['txn_id']),
  undo: new Set(['txn_id', 'request_id']),
};

/** 去重键：只折叠 `./` 与重复分隔符，不解析 `..`（越界判定是 provider 的职责，本层不重复做）。 */
function pathKey(p) {
  return posix.normalize(String(p).replace(/\\/g, '/'));
}

/**
 * 可被撤销的状态。commit 侧的 indeterminate 也在内：已证实写入的文件不会因为同一笔里
 * 还有别的文件说不清就永远撤不回（撤销前先用读锚把 commit 期的未知收口）。
 * undo_partial / undo_indeterminate 可重入；后者先重新读锚核对「撤销到底有没有生效」，
 * 不对一笔结果未知的 Undo 直接重发（见 undo()）。
 */
const UNDOABLE_STATES = new Set(['committed', 'partial', 'indeterminate', 'undo_partial', 'undo_indeterminate']);

/** 事务已收束后的幂等复播口径：状态 → 具名码 + 重试建议。 */
const REPLAY_OF = {
  undone: { code: 'TXN_UNDONE', retry: 'new_request' },
  partial: { code: 'TXN_PARTIAL', retry: 'new_request' },
  undo_partial: { code: 'TXN_UNDO_PARTIAL', retry: 'new_request' },
  undo_indeterminate: { code: 'TXN_UNDO_INDETERMINATE', retry: 'after_reconcile' },
  indeterminate: { code: 'TXN_INDETERMINATE', retry: 'after_reconcile' },
  rejected: { code: 'TXN_REJECTED', retry: 'new_request' },
};
const UNKNOWN_REPLAY = { code: 'TXN_STATE_UNKNOWN', retry: 'after_reconcile' };

/** 失败码 → 重试口径（与 liuhe-lite 的 RETRY_POLICY 同义，不另造词汇）。 */
const RETRY_POLICY = {
  VERSION_CONFLICT: 'after_reanchor',
  PATH_OUT_OF_SCOPE: 'never',
  INDETERMINATE: 'after_reconcile',
  NEEDS_REVIEW: 'never',
  FILE_TOO_LARGE: 'never',
  UNSUPPORTED_ENCODING: 'never',
  FILE_LOCKED: 'same_request_id',
  REQUEST_IN_FLIGHT: 'same_request_id',
  REQUEST_CONFLICT: 'new_request',
  WRITE_FAILED: 'new_request',
  INVALID_INPUT: 'never',
};

/**
 * provider 用这些码表示「还没动手就拒绝了」 ⇒ 可以断言这个文件没被碰过。
 *
 * 这份表不是猜的，是六合 Lite 自己错误码表的语义（vendor/liuhe-lite/lite/errors.js）：
 * 每个码的注释都含「不覆盖 / 未写入 / 未碰盘 / 拒绝接管」这类断言。
 *
 * 表外的码一律按**效果未知**处理，包括：
 *   · INDETERMINATE / NEEDS_REVIEW —— 底层**明示**不知道；
 *   · ADAPTER_ERROR / RECEIPT_CONTRACT_VIOLATION / PROVIDER_SHAPE / handler_threw —— 可能写在半路；
 *   · REQUEST_IN_FLIGHT / REQUEST_CONFLICT —— 同 id 的另一笔可能已经写了；
 *   · 没见过的码、空码 —— 不认识的码不能拿来做“没写”的担保。
 */
const NO_EFFECT_CODES = new Set([
  'PATH_OUT_OF_SCOPE', 'VERSION_CONFLICT', 'UNDO_CONFLICT', 'PERSISTENCE_FAILED',
  'RECOVERY_UNAVAILABLE', 'FOREIGN_JOURNAL', 'NOT_UNDOABLE', 'FILE_LOCKED',
  'FILE_TOO_LARGE', 'UNSUPPORTED_ENCODING', 'WRITE_FAILED', 'INVALID_INPUT',
  'NOT_FOUND', 'WORKSPACE_PARAM_FORBIDDEN', 'CANCELLED_BEFORE_START',
]);

/** provider 的失败回执能不能支撑「这个文件没被改过」这个断言。 */
function effectOf(result) {
  const code = typeof result?.code === 'string' ? result.code.trim() : '';
  if (!code) return 'unknown';
  return NO_EFFECT_CODES.has(code) ? 'no_effect' : 'unknown';
}

/**
 * 从 read_anchor 的回执里取可用事实：非空 sha256 ⇒ 字节指纹；明确 exists:false 且无 hash
 * ⇒ “不存在”（null）；其余（ok:true 却给不出任何事实）⇒ undefined，即“不知道”。
 * 下游用 null 表示“提交前不存在”，所以“不知道”不能折成 null。
 */
function anchorShaFact(anchor) {
  if (!anchor || typeof anchor !== 'object') return undefined;
  const sha = anchor.sha256;
  if (typeof sha === 'string' && sha.length > 0) return sha;
  if (anchor.exists === false && (sha === null || sha === undefined)) return null;
  return undefined;
}

/** provider 侧的撤销幂等键：调用方给了 request_id 就按「事务 + 请求 + 文件」区分。 */
function undoProviderKey(txnId, file, callerRequestId) {
  const target = file.action_id || file.path;
  return callerRequestId ? `${txnId}:undo:${callerRequestId}:${target}` : `${txnId}:undo:${target}`;
}

/** 模型可见工具（有 tool-registry 时公开注册）。 */
const MODEL_VISIBLE = [
  {
    action: 'plan',
    tool: 'tool-txn-plan',
    capabilityId: 'tool.txn-plan',
    description: 'Plan a multi-file change before writing: reads each file\u0027s pre-write anchor and returns a plan_id. '
      + 'Nothing is written. Commit the plan_id with tool-txn-commit. Read-only. Requires an attributable session: '
      + 'a plan signed without one could never be committed.',
    parameters: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          description: 'Files to change: [{path, content}]',
          items: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
            required: ['path', 'content'],
          },
        },
      },
      required: ['files'],
    },
  },
  {
    action: 'commit',
    tool: 'tool-txn-commit',
    capabilityId: 'tool.txn-commit',
    description: 'Apply a plan created by tool-txn-plan, one file at a time. Returns per-file application states; '
      + 'a transaction may end as partial (some files written, the rest not attempted) and never fakes atomicity.',
    parameters: {
      type: 'object',
      properties: {
        plan_id: { type: 'string', description: 'plan_id returned by tool-txn-plan' },
        request_id: { type: 'string', description: 'Optional idempotency key; the same key replays instead of re-writing' },
      },
      required: ['plan_id'],
    },
  },
  {
    action: 'inspect',
    tool: 'tool-txn-status',
    capabilityId: 'tool.txn-status',
    description: 'Read what a transaction actually did: per-file application state, action ids and whether an undo is '
      + 'still available. Read-only. The index is in memory only (dropped on plugin unload). Requires an attributable '
      + 'session; trusted host code uses the txn.inspect capability instead.',
    parameters: {
      type: 'object',
      properties: { txn_id: { type: 'string', description: 'txn_id returned by tool-txn-commit' } },
      required: ['txn_id'],
    },
  },
];

export default new CellFileTxn();
