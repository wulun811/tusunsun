// liuhe-lite.js — 把六合 Lite（`vendor/liuhe-lite/`）接成土行孙的**可选器官**。
//
// ── 这个插件回答的问题 ────────────────────────────────────────────────
//
// 计划书 Track L 的裁决是 "Adapter first，不抽 Lite"（ADR-04 §8）：
//   共享的是**语义与回执合同**，不是事务引擎。所以本文件**不实现**任何写入/撤销/对账逻辑，
//   只做四件事：把工作区真值给出去、把六个动作映射成能力、把回执归一成我方合同、
//   把"能不能给模型看"这条判据留在宿主手里。
//
// ── 为什么默认不进任何场景 ────────────────────────────────────────────
//
// `vendor/liuhe-lite/` 是 43 个文件 / 474 KB 的第三方快照。把它放进 `eager` 的后果是
// "零第三方代码运行"这条对外承诺变成"零 npm 依赖但带一份第三方代码"——那不是同一句话。
// 接入形态见 ADR-07 §2：**场景里显式列一行才启用**，与 `haotian-lite` / `ying-mini` 同级。
//
// ── 三条硬边界（写在这里，因为它们在代码里是"没有做"而不是"做了"）───
//
//   ① **工作区真值只来自宿主**。`createLiteEditor` 要 `workspace.realPath`，这里只从
//      `core.getService('workspace').root(sessionId)` 取；模型给的 `workspace*` 类入参
//      一律在**进入 Lite 之前**被拒（`WORKSPACE_PARAM_FORBIDDEN`）。放在 Lite 之前而不是
//      之后：授权边界不能依赖第三方实现把它拦对。
//
//   ② **`apply` / `undo` 不注册成模型工具**。它们能改盘。给模型的办法是走能力面
//      （`core.callCapability('liuhe.apply', …)`），由宿主/协调器决定何时调。
//      模型直接可见的只有 `readAnchor`（读）与 `inspect`（读）。
//      这不是"没做"，是"刻意没做"——见 ADR-07 §4 与 `_MODEL_VISIBLE` 那张表。
//
//   ③ **回执不原样丢给模型**。Lite 的回执里有 `effect.target`（它自己的形状）与
//      `extension`（provider 私有键）。这里归一成 `tusunsun.action-receipt/v0`，
//      并对 `target.path` 过一遍我方的脱敏（ACT-07）。两家的脱敏名单不一样，
//      取**并集**：Lite 遮它的、我方遮我方的。
//
// ── 一处刻意的不对称 ─────────────────────────────────────────────────
//
// `persistence`：Lite 发 `memory_only`，我方 v0 用 `volatile`（ADR-06/D-2 已冻结：
// v0 各留各的，v1 归一到 `volatile`，原值留 `extension.provider_persistence`）。
// 所以这里做**单向归一**，且把原值一并留下 —— 不丢信息地换词，而不是把 `memory_only`
// 当成 `unknown` 糊过去。

import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  buildReceipt, redactTargetPath, summarizeReceipt,
} from './_lib/action-receipt.mjs';
import { currentSession } from './_lib/call-context.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));

/** Lite 在本仓的位置（内置副本，不是 npm 依赖）。 */
export const LITE_DIR = join(HERE, '..', 'vendor', 'liuhe-lite');
export const LITE_ENTRY = join(LITE_DIR, 'lite', 'index.js');

/**
 * Lite 的六个动作 → 本仓能力 id。
 *
 * 命名的选择：`liuhe.*` 前缀而不是塞进 `tool.*`。
 *   · `tool.*` 是"模型可见工具能力"的命名空间，而 `apply` / `undo` **不该**被模型直接点名；
 *   · `liuhe.*` 明确表达"这是外部 provider 的能力"，与 `cell.*` / `chat.handle` 同级。
 *
 * 为什么是 `read_anchor` 而不是 `readAnchor`：Cell 的 `CAPABILITY_RE`
 * （`plugins/_lib/cell/contract.js:28`）要求**全小写**分段 —— `liuhe.readAnchor` 会被
 * `validateCellSpec` 直接拒（实测 `capabilities contains an invalid entry`）。
 * 我第一版就是驼峰，被契约当场挡住。**契约是对的，改名的是我**：
 * 让外部动作名去迁就 Provider 的 JS 风格，等于让风格决定一个跨系统的标识符。
 */
export const ACTIONS = Object.freeze({
  readAnchor: 'liuhe.read_anchor',
  preview: 'liuhe.preview',
  apply: 'liuhe.apply',
  inspect: 'liuhe.inspect',
  undo: 'liuhe.undo',
  reconcile: 'liuhe.reconcile',
});

/**
 * 模型可见的**工具**（不是能力）。
 *
 * 只有两个，且都只读。这张表是显式的，不用"名字里带 read 就算只读"那种派生——
 * 派生的判据会被一个命名巧妙的写工具绕过（R0-131/A 的实测形状）。
 * `liuhe.apply` / `liuhe.undo` 在这里**故意缺席**，见文件头边界 ②。
 */
const _MODEL_VISIBLE = Object.freeze([
  {
    action: 'readAnchor',
    tool: 'tool-liuhe-anchor',
    capability: ACTIONS.readAnchor,
    description: 'Read a file\'s pre-write anchor (sha256 / size / mtime / inode) without writing anything. '
      + 'Use it when you are about to modify a file and want the change to be verifiable and, if the host allows it, undoable.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path, e.g. "src/main.py"' },
      },
      required: ['path'],
    },
  },
  {
    action: 'inspect',
    tool: 'tool-liuhe-inspect',
    capability: ACTIONS.inspect,
    description: 'Inspect what a previous LiuHe action actually did: current on-disk hash vs the recorded before/after hashes, '
      + 'whether the file was created, and whether an undo is still possible. Read-only detail, not a receipt.',
    parameters: {
      type: 'object',
      properties: {
        actionId: { type: 'string', description: 'The action_id returned by an earlier LiuHe action, e.g. "act-txn_..._p123"' },
      },
      required: ['actionId'],
    },
  },
]);

/** 模型**不得**自带的工作区类入参（授权真值只能来自宿主）。 */
const WORKSPACE_PARAM_NAMES = [
  'workspace', 'workspace_dir', 'workspaceDir', 'workspace_realpath', 'workspaceRealPath',
  'realPath', 'real_path', 'cwd', 'root', 'base_dir', 'baseDir',
];

const RETRY_POLICY = {
  WORKSPACE_PARAM_FORBIDDEN: 'never',
  PATH_OUT_OF_SCOPE: 'never',
  VERSION_CONFLICT: 'after_reanchor',
  UNDO_CONFLICT: 'never',
  INDETERMINATE: 'after_reconcile',
  PERSISTENCE_FAILED: 'new_request',
  RECOVERY_UNAVAILABLE: 'never',
  FOREIGN_JOURNAL: 'never',
  NOT_UNDOABLE: 'never',
  NEEDS_REVIEW: 'never',
  FILE_LOCKED: 'same_request_id',
  REQUEST_IN_FLIGHT: 'same_request_id',
  REQUEST_CONFLICT: 'new_request',
  FILE_TOO_LARGE: 'never',
  UNSUPPORTED_ENCODING: 'never',
  WRITE_FAILED: 'new_request',
  CANCELLED_BEFORE_START: 'new_request',
  INVALID_INPUT: 'never',
  NOT_FOUND: 'never',
};

/**
 * `persistence` 的 v0 单向归一（ADR-06 / B-2 冻结）。
 *
 * 关键：**不丢原值**。把 `memory_only` 直接改成 `volatile` 而不留痕，
 * 等于"用我方的词汇覆盖 provider 的事实"；留 `extension.provider_persistence` 才是归一。
 */
export function normalizePersistence(v) {
  if (v === 'memory_only') return { value: 'volatile', raw: 'memory_only' };
  return { value: v ?? 'unknown', raw: null };
}

/** 把模型自报的工作区类入参挑出来（**不**看值，只看键是否存在）。 */
export function findWorkspaceParams(args) {
  if (!args || typeof args !== 'object') return [];
  return WORKSPACE_PARAM_NAMES.filter((k) => Object.prototype.hasOwnProperty.call(args, k));
}

/**
 * Lite 回执 → 我方 `tusunsun.action-receipt/v0`。
 *
 * 单向、可核对、不编造：
 *   · `effect.target`（字符串）→ `target.path`，并过我方 ACT-07 脱敏（与 Lite 的名单取并集）；
 *   · `provider / provider_operation_id / request_id` 原样透传（Lite 真有这些事实）；
 *   · `recovery.supported` **只在 Lite 说 true 且给了 ref** 时才是 true —— 与下方
 *     `buildReceipt` 的自洽性检查同源，不是这里额外放宽；
 *   · `verification` 恒为 `not_run`（Lite 不跑代码检查，我方也不代填）。
 *
 * @returns {{ok: boolean, receipt?: object, violations?: string[]}}
 */
export function toTusunsunReceipt(liteReceipt, extra = {}) {
  if (!liteReceipt || typeof liteReceipt !== 'object') {
    return { ok: false, violations: ['lite receipt missing — nothing to normalize (do not invent one)'] };
  }
  const e = liteReceipt.effect || {};
  const persistence = normalizePersistence(liteReceipt.persistence);
  const built = buildReceipt({
    action_id: liteReceipt.action_id,
    // 归因字段：Lite 从宿主传的 cell 块里原样带回，不是模型自报（见 B-5 三问的答复）。
    cell_id: liteReceipt.cell_id ?? null,
    incarnation_id: liteReceipt.incarnation_id ?? null,
    task_id: liteReceipt.task_id ?? null,
    tool_id: extra.tool_id || 'liuhe.lite',
    application: liteReceipt.application,
    target: {
      path: e.target ?? null,
      canonical_scope: e.target == null ? null : 'cell_workspace',
    },
    effect: {
      kind: e.kind ?? null,
      before_sha256: e.before_sha256 ?? null,
      after_sha256: e.after_sha256 ?? null,
      changed_bytes: e.changed_bytes ?? null,
      created: e.kind === 'file_created' ? true : (e.created ?? null),
      detail_ref: e.detail_ref ?? null,
    },
    verification: liteReceipt.verification || 'not_run',
    recovery: {
      supported: liteReceipt.recovery?.supported === true && !!liteReceipt.recovery?.ref,
      ref: liteReceipt.recovery?.ref ?? null,
    },
    persistence: persistence.value,
    provider: liteReceipt.provider ?? 'liuhe-lite',
    provider_operation_id: liteReceipt.provider_operation_id ?? null,
    request_id: liteReceipt.request_id ?? null,
  });
  if (!built.ok) return built;
  // 归一留下的事实：原 persistence 值 + provider 私有扩展。
  // 这两项都**只是数据**，不参与任何授权/判定（ADR-04 §8 的解释权表）。
  const ext = {};
  if (persistence.raw) ext.provider_persistence = persistence.raw;
  if (liteReceipt.extension && typeof liteReceipt.extension === 'object') ext.provider_extension = liteReceipt.extension;
  if (liteReceipt.recovery?.expires_at) built.receipt.recovery.expires_at = liteReceipt.recovery.expires_at;
  if (Object.keys(ext).length) built.receipt.extension = ext;
  return built;
}

/**
 * 把 Lite 的失败对象翻成我方的具名失败。
 *
 * 为什么要翻：Lite 的 `handling.retry` 是它自己的词汇（`after_reanchor` 等），
 * 而我方的执行器/调用方读的是 `code`。两个都保留：`code` 用它的（那是**它**的事实），
 * 只在缺 `handling` 时按本文件的 `RETRY_POLICY` 补一个 —— 补值要能指回来源。
 */
function normalizeLiteError(err, action) {
  const code = err?.error?.code || err?.code || 'UNKNOWN';
  const message = err?.error?.message || err?.message || String(err);
  const handling = err?.error?.handling || {
    retry: RETRY_POLICY[code] || 'never',
    note: 'retry policy filled by the tusunsun adapter from Lite\'s code table (Lite did not send handling)',
  };
  return {
    ok: false,
    code,
    message,
    handling,
    receipt: err?.receipt ?? null,
    detail: err?.detail ?? err?.error?.detail ?? null,
    action,
  };
}

class LiuheLite {
  name = 'liuhe-lite';
  version = '0.1.3';
  // 服务是**可选**的：没有 workspace 服务时本插件 init 就该拒绝（见 init），
  // 而不是偷偷用 `process.cwd()` —— 那会把"宿主没给工作区"变成"用进程当前目录"。
  requires = { workspace: '>=0.1.0' };
  permissions = ['fs.read', 'fs.write'];
  provides = [
    { name: 'liuhe-lite', type: 'service' },
    ...Object.values(ACTIONS).map((name) => ({ name, type: 'capability', removable: true })),
  ];
  tags = ['filesystem.write', 'recovery'];
  cohesion = 'atomic';
  description = 'LiuHe Lite adapter — verifiable file actions (anchor → apply → reconcile → limited undo)';

  constructor() {
    // sessionId → editor。**按会话隔离**：两个会话拿到两个工作区真值时，
    // 不能共用同一个 editor（那会把 A 的工作区写到 B 的路径上）。
    this._editors = new Map();
    this._bySession = new Map();
  }

  async init(core) {
    this.core = core;
    this._workspace = core.getService?.('workspace') || null;
    if (!this._workspace || typeof this._workspace.root !== 'function') {
      // 没有工作区服务 ⇒ 没有可信的工作区真值 ⇒ 不能建 editor。
      // 这里**抛**而不是降级到 `process.cwd()`：一个把"宿主没给"读成"就用当前目录"的
      // 适配层，会让所有越界判定失效（因为它把任意目录都当成合法工作区）。
      throw Object.assign(
        new Error('liuhe-lite requires the "workspace" service: the trusted workspace root must come from the host runtime'),
        { code: 'service_not_found', contractError: true },
      );
    }

    const mod = await import(pathToFileURL(LITE_ENTRY).href);
    this._lite = mod;
    this._createEditor = mod.createLiteEditor;

    core.registerService('liuhe-lite', this);

    for (const [action, capId] of Object.entries(ACTIONS)) {
      core.registerCapability(capId, {
        description: `LiuHe Lite: ${action}`,
        handler: (params) => this.invoke(action, params),
        owner: 'liuhe-lite',
      });
    }

    // 模型可见的两个只读工具。经 tool-registry 门面登记（E2），不直接改私有 Map。
    this._registeredTools = [];
    const registry = core.getService?.('tool-registry');
    if (registry && typeof registry.registerTool === 'function') {
      for (const spec of _MODEL_VISIBLE) {
        const r = registry.registerTool({
          name: spec.tool,
          owner: 'liuhe-lite',
          description: spec.description,
          parameters: spec.parameters,
          execute: (args) => this.invoke(spec.action, args),
          // 工具名 `tool-liuhe-anchor` 按约定会派生成 `tool.liuhe-anchor`，那**不是**我们要的能力 id。
          // 显式给 `liuhe.readAnchor`：让"模型看到的工具"与"真正执行的能力"是同一个 id，
          // 而不是一个派生出来的、指向不存在的名字。
          capabilityId: spec.capability,
        });
        if (r?.ok) {
          this._registeredTools.push(spec.tool);
          // 目录句柄：stop() 里凭它注销（owner 字符串不构成授权，ID-12）。
          (this._toolHandles ??= new Map()).set(spec.tool, r.handle);
        }
        else core.log('warn', `[liuhe-lite] tool ${spec.tool} not registered: ${r?.error || r?.code}`);
      }
    } else {
      core.log('warn', '[liuhe-lite] tool-registry 不可用：六个动作仍可经能力面调用，但模型看不到只读工具');
    }

    core.log('info', `liuhe-lite ${mod.LITE_VERSION || this.version} ready (provider=${mod.LITE_PROVIDER || 'liuhe-lite'}); `
      + `model-visible: ${this._registeredTools.join(', ') || 'none'}; apply/undo are capability-only`);
  }

  /** 可用动作清单（诊断用；不含任何秘密）。 */
  describe() {
    return {
      provider: this._lite?.LITE_PROVIDER ?? 'liuhe-lite',
      version: this._lite?.LITE_VERSION ?? this.version,
      vendored_at: LITE_DIR,
      actions: Object.keys(ACTIONS),
      model_visible_tools: [...(this._registeredTools || [])],
      capability_only: ['apply', 'undo'],
      editors: this._editors.size,
    };
  }

  /**
   * 取（或建）某会话的 editor。
   *
   * 工作区真值：`workspace.root(sessionId)` —— 这是**宿主**给的，不是模型给的。
   * 建 editor 之前 realpath 归一：Lite 内部还会再归一次（它自己的守卫），
   * 这里归一次是为了让"两个会话指向同一真实目录"命中同一份缓存，
   * 而不是各建一个 editor 抢同一份 `.malong/`。
   */
  _editorFor(sessionId) {
    const wsRootRaw = this._workspace.root(sessionId);
    if (!wsRootRaw) {
      throw Object.assign(
        new Error('liuhe-lite: the host workspace service returned no root for this session'),
        { code: 'workspace_unavailable', contractError: true },
      );
    }
    let real;
    try { real = realpathSync(wsRootRaw); }
    catch (err) {
      throw Object.assign(
        new Error(`liuhe-lite: workspace root is unresolvable: ${err.message}`),
        { code: 'workspace_unavailable', contractError: true },
      );
    }
    const key = `${sessionId ?? ''}::${real}`;
    const hit = this._bySession.get(key);
    if (hit) return hit;

    // Cell 归因：有 cell-runtime 时取**运行事实**，没有就是 null（不编造）。
    // `describe()` 是它对外唯一的状态面，这里只读、不改。
    const cell = this._cellContext(sessionId);
    const editor = this._createEditor({
      workspace: { realPath: real, id: sessionId ?? null },
      cell,
      // 与 Lite 的默认值保持一致（1 MiB / 8 KiB）：**不改**第三方默认，
      // 需要不同上限时由宿主显式配，避免"适配层悄悄放宽了别人的安全边界"。
      limits: this.core.get?.('liuhe.limits') || {},
    });
    this._bySession.set(key, editor);
    this._editors.set(key, editor);
    return editor;
  }

  /** Cell 归因三字段：只从 `cell-runtime.describe()` 取，取不到就 null。 */
  _cellContext(sessionId) {
    const rt = this.core.getService?.('cell-runtime');
    if (!rt || typeof rt.describe !== 'function' || !sessionId) return {};
    // 会话 id 形如 `cell-<cellId>`（cell-runtime 的会话命名约定）；不匹配就不猜。
    const m = /^cell-(.+)$/.exec(String(sessionId));
    if (!m) return {};
    try {
      const d = rt.describe(m[1]);
      return {
        cellId: d?.cell_id ?? null,
        incarnationId: d?.incarnation_id ?? null,
        taskId: d?.active_task_id ?? null,
      };
    } catch {
      // describe 抛错（cell 已关闭/未知）⇒ 不给归因，也不让动作失败：
      // 归因是**增量证据**，不是执行的先决条件（与 A0 的立场一致）。
      return {};
    }
  }

  /**
   * 动作入口。**所有**六个动作都从这里进，这样三条边界只需在**一处**成立：
   *   ① 工作区类入参拒绝 → ② 取宿主工作区 → ③ 调 Lite → ④ 归一。
   *
   * @returns {Promise<object>} 成功 `{ok:true, ...}`；失败 `{ok:false, code, message, handling}`
   */
  async invoke(action, params = {}) {
    const fn = ACTIONS[action];
    if (!fn) {
      return { ok: false, code: 'INVALID_INPUT', message: `unknown liuhe action: ${action}`, handling: { retry: 'never', note: 'not a LiuHe Lite action' } };
    }
    // ① 授权边界在 Lite 之前（不依赖第三方把它拦对）。
    const bad = findWorkspaceParams(params);
    if (bad.length) {
      return {
        ok: false,
        code: 'WORKSPACE_PARAM_FORBIDDEN',
        message: `workspace-scoping parameters are not accepted from this layer (${bad.join(', ')}); `
          + 'the trusted workspace comes from the host runtime only',
        handling: { retry: 'never', note: 'authorization boundary, not a fixable parameter' },
        detail: { rejected_params: bad },
      };
    }

    const sessionId = params?._sessionId ?? currentSession() ?? null;
    let editor;
    try { editor = this._editorFor(sessionId); }
    catch (err) { return normalizeLiteError(err, action); }

    // ② 入参收窄：只把 Lite 认识的那个字段交过去。
    //    多传的字段会让 Lite 的行为依赖"它恰好忽略了什么"，那不是我方能保证的合同。
    const arg = pickArgs(action, params);

    try {
      const raw = await editor[action](arg);
      return this._shapeResult(action, raw, params);
    } catch (err) {
      // Lite 的失败是**返回值**不是异常（它自己的合同）；走到这里说明是适配层/环境错误。
      // 不把它翻成 Lite 的码——那会伪造来源。如实标 `adapter_error`。
      return {
        ok: false,
        code: err?.code || 'ADAPTER_ERROR',
        message: err?.message || String(err),
        handling: { retry: 'never', note: 'adapter/environment error, not a LiuHe Lite outcome' },
        action,
      };
    }
  }

  /**
   * 结果整形：成功 → 归一后的回执；失败 → 保留 Lite 的码与处置建议。
   */
  _shapeResult(action, raw, params) {
    if (!raw || typeof raw !== 'object') {
      return { ok: false, code: 'ADAPTER_ERROR', message: `Lite returned a non-object for ${action}`, handling: { retry: 'never', note: 'unexpected provider shape' }, action };
    }
    if (raw.ok === false || (raw.error && !raw.receipt)) {
      const e = normalizeLiteError(raw, action);
      // 失败也带**归一后的回执**（Lite 在失败路径上会给 receipt；不给就是 null）。
      const normalized = e.receipt ? toTusunsunReceipt(e.receipt, { tool_id: `liuhe.${action}` }) : null;
      return {
        ...e,
        receipt: normalized?.ok ? normalized.receipt : null,
        raw_receipt: e.receipt ?? null,
        summary: normalized?.ok ? summarizeReceipt(normalized.receipt) : null,
      };
    }

    // 成功路径：Lite 的成功形状有三种，逐个说清（不猜、不统一成假形状）。
    if (action === 'readAnchor') {
      // `{ anchor: {...} }`：只读事实，**没有回执**（没发生动作，硬造一份就是编造）。
      return { ok: true, action, anchor: raw.anchor, receipt: null };
    }
    if (action === 'preview') {
      // `{ preview: {...} }`：`applied` 恒 false，同样没有回执。
      return { ok: true, action, preview: raw.preview, receipt: null };
    }
    if (action === 'inspect') {
      // `{ ok, effect }`：**没有 receipt**（他们 0.1.3 已在指南里声明，
      // 我方 A-7 的建议就是"显式声明"这条路）。这里不硬造回执，
      // 但把 effect 里对模型有用的三件事提出来，避免模型去解析 provider 私有形状。
      const eff = raw.effect || {};
      return {
        ok: true, action, effect: eff, receipt: null,
        summary: `${eff.target ?? '(unknown)'}：当前 ${eff.current_exists ? '存在' : '不存在'}`
          + (eff.undo_supported ? '，可撤销' : (eff.undo_expired ? '，已过期不可撤销' : '，不可撤销')),
      };
    }
    // apply / undo / reconcile：有回执
    const normalized = toTusunsunReceipt(raw.receipt, { tool_id: `liuhe.${action}` });
    if (!normalized.ok) {
      // 我方校验器拒收**自己的**归一结果 ⇒ 这是适配层的 bug，必须可见。
      this.core?.log?.('warn', `[liuhe-lite] normalized receipt rejected for ${action}: ${normalized.violations?.join('; ')}`);
      return {
        ok: false,
        code: 'RECEIPT_CONTRACT_VIOLATION',
        message: `LiuHe returned a receipt that does not satisfy tusunsun.action-receipt/v0 after normalization: ${normalized.violations?.join('; ')}`,
        handling: { retry: 'never', note: 'cross-implementation contract gap — report it, do not retry blindly' },
        action,
        raw_receipt: raw.receipt ?? null,
      };
    }
    return {
      ok: true,
      action,
      receipt: normalized.receipt,
      raw_receipt: raw.receipt ?? null,
      detail: raw.detail ?? null,
      summary: summarizeReceipt(normalized.receipt),
    };
  }

  async stop() {
    // 注销模型可见工具：只摘自己的（unregisterTool 会校验 owner）。
    const registry = this.core?.getService?.('tool-registry');
    if (registry && typeof registry.unregisterTool === 'function') {
      for (const name of this._registeredTools || []) {
        try { registry.unregisterTool({ name, owner: 'liuhe-lite', handle: this._toolHandles?.get(name) }); }
        catch { /* 已被别处摘掉：不是失败 */ }
      }
    }
    this._registeredTools = [];
    // editor 没有 stop 契约（Lite 是纯函数集合 + 每工作区状态，没有后台任务）。
    // 清掉引用即可 —— 不假装"关闭"了一个不存在的东西。
    this._editors.clear();
    this._bySession.clear();
  }
}

/**
 * 每个动作只把 Lite **认识**的字段传过去。
 *
 * 为什么不在 `invoke` 里统一 `{...params}`：`_sessionId` 是宿主注入的控制字段，
 * 传进 Lite 会让它变成"一个它不认识但收下了的参数"。收窄是**我方**的责任。
 */
function pickArgs(action, params) {
  const p = params || {};
  switch (action) {
    case 'readAnchor': return { path: p.path };
    case 'preview': return { anchor: p.anchor, newContent: p.newContent };
    case 'apply': return { anchor: p.anchor, newContent: p.newContent, requestId: p.requestId ?? p.request_id };
    case 'inspect': return { actionId: p.actionId ?? p.action_id };
    case 'undo': return { recoveryRef: p.recoveryRef ?? p.recovery_ref, requestId: p.requestId ?? p.request_id };
    case 'reconcile': return { actionId: p.actionId ?? p.action_id };
    default: return {};
  }
}

export default new LiuheLite();
export { LiuheLite, _MODEL_VISIBLE, RETRY_POLICY };
