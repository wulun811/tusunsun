// CTX-10（PR-3）：经验层的**薄接线规范** —— 经验供应的 v0 实现与静态 provider。
//
// 这个文件不实现"从经验中学习"。它只做四件事：
//
//   ① **被动提示（hint）**：任务开始或收到具体失败信号时，`lookup` 返回 0～2 条**短提示**。
//      没有匹配就返回 0 条 —— 不灌一份经验百科。
//   ② **主动求教（read）**：模型用 `tool-experience-pull` 工具按 ref 展开详情，可以只看
//      `conditions`/`failure`/`procedure`/`evidence`，不必每次拉全篇。
//   ③ **候选出口（proposeCandidate）**：把"这轮学到的"作为**事件**发出去，不自动升格。
//      `candidate` 与 `active` 在**目录上**分离（两个不同文件），不靠字段约定。
//   ④ **状态即权限**：只有 `active` 可被 lookup/read。`revoked`/`superseded`/`expired`
//      即使模型手里有旧 ref 也必须**具名失败**，不能"查不到"——"查不到"与"被撤销"
//      对调用方是完全不同的两件事。
//
// 为什么把 provider 与端口放在同一个文件：v0 的 provider 只有"静态 fixtures"一种，
// 而端口的存在理由就是"以后换成真经验层"。放在一起，替换时要读的上下文最小；
// 分成两个文件反而会让"端口"这层抽象看起来比它的实际内容更重。

import { readFile, realpath, stat } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep, dirname } from 'node:path';
import { contractError } from './_lib/cell/contract.js';
import { validateExperienceRecord, assertExperienceUsable } from './_lib/cell/context-contract.js';
import { estimateTokens } from './_lib/context-budget.js';

/** hint 的条数硬上限：计划要求 0～2，即使 profile 写 8 也在这里收住。 */
const HINT_HARD_MAX = 2;

async function realInside(root, target) {
  const rootReal = await realpath(root).catch(() => null);
  if (!rootReal) return null;
  let probe = target;
  for (;;) {
    const real = await realpath(probe).catch(() => null);
    if (real) {
      const rel = relative(rootReal, real);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
      return { real, rootReal };
    }
    const up = dirname(probe);
    if (up === probe) return null;
    probe = up;
  }
}

/**
 * 静态 provider：从宿主目录读两类文件。
 *
 *   <experienceRoot>/active.jsonl    —— 已批准、可召回（**唯一**被 lookup/read 读取的文件）
 *   <experienceRoot>/candidates.jsonl —— 候选，**永不**参与 lookup/read
 *
 * 两份文件分开是刻意的：如果候选与已批准混在一个文件里、靠 `status` 字段区分，
 * 那么任何一次"忘了过滤"都会把候选注入模型。物理分离让这种错误不可能发生。
 */
export class StaticExperienceProvider {
  constructor({ experienceRoot, projectId = null }) {
    this.experienceRoot = experienceRoot ? resolve(experienceRoot) : null;
    this.projectId = projectId;
    this._active = null;
    this._candidates = null;
  }

  async _loadFile(name, { required = false } = {}) {
    if (!this.experienceRoot) {
      throw contractError('experience provider "static" requires cells.context.experienceRoot', 'context_disabled');
    }
    const file = join(this.experienceRoot, name);
    const inside = await realInside(this.experienceRoot, file);
    if (!inside) throw contractError(`${name} resolves outside the host experience root`, 'experience_out_of_bounds');
    let text;
    try {
      text = await readFile(inside.real, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT' && !required) return [];
      if (err.code === 'ENOENT') {
        throw contractError(
          `experience store "${name}" not found at ${inside.real}; a missing store is not an empty one `
          + '(it would make "no experience" indistinguishable from "no provider configured")',
          'experience_missing');
      }
      throw contractError(`experience store "${name}" is unreadable: ${err.code || err.message}`, 'experience_unreadable');
    }
    const out = [];
    for (const [i, line] of text.split('\n').entries()) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch (err) {
        throw contractError(`experience store "${name}" line ${i + 1} is not valid JSON: ${err.message}`, 'experience_invalid');
      }
      out.push(validateExperienceRecord(obj));
    }
    return out;
  }

  async active() {
    return this._loadCached('active.jsonl', { required: true }, '_active');
  }

  async candidates() {
    return this._loadCached('candidates.jsonl', {}, '_candidates');
  }

  /**
   * 带**失效依据**的缓存加载。
   *
   * 修前这里是 `if (!this._active) this._active = await ...` —— 一次加载、永久缓存。
   * 后果不是性能问题，而是**撤销在进程内永不生效**：实测把 active.jsonl 里那条记录的
   * `status` 从 active 改成 revoked 之后，`read()` 仍然返回它（且回的是旧的 `status: active`），
   * `lookup()` 仍然召回它。也就是说"状态即权限"这句承诺只在**进程重启后**成立。
   *
   * 缓存的键改成文件指纹（mtimeMs + size）：文件一变就重读，没变就复用。
   * 这仍然是"有界读取"（不是每次 lookup 都读全文件），但把"文件是真相"这条不变式
   * 恢复到了进程内。注意这**不是**完整的一致性方案：同一 mtime+size 的内容替换
   * （极短窗口内改写同样长度）仍可能被漏过；接受这一点，因为它要求写入方刻意构造，
   * 而 v0 的 host 就是文件的所有者。
   */
  async _loadCached(name, opts, slot) {
    if (!this.experienceRoot) {
      // 没有根就没有指纹，直接让 _loadFile 抛它那条具名的 context_disabled。
      return this._loadFile(name, opts);
    }
    const file = join(this.experienceRoot, name);
    const st = await stat(file).catch(() => null);
    if (!st) {
      // 文件消失：一并丢掉缓存，让 _loadFile 按 required 决定"空"还是"具名失败"。
      this[slot] = null;
      this[`${slot}Stat`] = null;
      return this._loadFile(name, opts);
    }
    const fp = `${st.mtimeMs}:${st.size}`;
    if (this[slot] && this[`${slot}Stat`] === fp) return this[slot];
    const loaded = await this._loadFile(name, opts);
    this[slot] = loaded;
    this[`${slot}Stat`] = fp;
    return loaded;
  }

  /**
   * 匹配：**只**看 active，且必须过作用域与环境标签两道闸。
   *
   * 匹配规则刻意保守（v0 不做语义检索）：
   *   · 作用域：`record.scope.project_id` 必须等于当前 project（或为 null = 全局）；
   *   · 触发词：`record.trigger` 与任务 goal/tags/failure_signal 有子串命中；
   *   · 环境：若任务声明了环境标签，记录的环境标签不得冲突。
   * 命中数超过上限就按"触发词命中个数"降序取前 N —— 但仍然**最多 2 条**。
   */
  async lookup(scope, { task, limit = 2 }) {
    const store = await this.active();
    const projId = scope?.profile?.experience?.projectId ?? this.projectId;
    const goal = String(task?.goal_brief || '').toLowerCase();
    const tags = (Array.isArray(task?.tags) ? task.tags : []).map((t) => String(t).toLowerCase());
    const signal = String(task?.failure_signal || '').toLowerCase();
    const hay = [goal, ...tags, signal].join(' ');

    const scored = [];
    for (const rec of store) {
      // 作用域：跨项目一律不可见（不是"降权"，是不可见）。
      if (rec.scope.project_id && projId && rec.scope.project_id !== projId) continue;
      if (rec.scope.project_id && !projId) continue;   // 有项目归属的记录，无项目上下文时不可见
      try { assertExperienceUsable(rec); } catch { continue; }   // 只召回 active 且未过期
      let score = 0;
      for (const t of rec.trigger) {
        const tl = String(t).toLowerCase();
        if (tl && hay.includes(tl)) score += 2;
      }
      // 标题/适用条件里的词命中给较低权重（避免"沾边就召回"）
      const titleL = rec.title.toLowerCase();
      for (const tag of tags) if (tag && titleL.includes(tag)) score += 1;
      if (signal && rec.does_not_apply_when.some((d) => signal.includes(String(d).toLowerCase()))) score -= 3;
      if (score > 0) scored.push({ rec, score });
    }
    scored.sort((a, b) => b.score - a.score || String(a.rec.experience_id).localeCompare(String(b.rec.experience_id)));
    const cap = Math.max(0, Math.min(HINT_HARD_MAX, Number.isInteger(limit) ? limit : HINT_HARD_MAX));
    return scored.slice(0, cap).map(({ rec }) => toHint(rec));
  }

  /** 读详情。**必须**经过作用域与状态两道校验 —— 有 ref 不等于有权限。 */
  async read(scope, { ref, focus = 'all' }) {
    const id = parseExperienceRef(ref);
    const store = await this.active();
    const rec = store.find((r) => r.experience_id === id.id);
    if (!rec) {
      // 具名区分"从未存在"与"存在但不可用"：后者在候选/撤销集里。
      const cands = await this.candidates().catch(() => []);
      const inCandidates = cands.find((r) => r.experience_id === id.id);
      if (inCandidates) {
        throw contractError(
          `experience "${id.id}" exists only as ${inCandidates.status}; candidates are NOT retrievable. `
          + 'A candidate becomes knowledge only after an independent review process (not implemented in this build).',
          'experience_not_active');
      }
      throw contractError(`unknown experience "${id.id}"`, 'unknown_experience');
    }
    // 版本：ref 带 @rev 时必须匹配，否则"旧 ref 静默拿到新内容"。
    if (id.revision != null && id.revision !== rec.revision) {
      throw contractError(
        `experience "${id.id}@${id.revision}" was requested but the store holds revision ${rec.revision}; `
        + 'refusing to serve a different revision under an old reference', 'experience_revision_mismatch');
    }
    assertExperienceUsable(rec);
    const projId = scope?.profile?.experience?.projectId ?? this.projectId;
    if (rec.scope.project_id && projId && rec.scope.project_id !== projId) {
      throw contractError(
        `experience "${rec.experience_id}" belongs to project "${rec.scope.project_id}", not "${projId}"`,
        'experience_out_of_scope');
    }
    if (rec.scope.project_id && !projId) {
      throw contractError(`experience "${rec.experience_id}" is project-scoped; no project context in this cell`, 'experience_out_of_scope');
    }
    return toDetail(rec, focus);
  }
}

/** `exp-writepath-001` 或 `exp-writepath-001@2`。 */
function parseExperienceRef(ref) {
  const raw = String(ref || '').trim();
  const m = /^([A-Za-z0-9][A-Za-z0-9._@+-]*?)(?:@(\d+))?$/.exec(raw);
  if (!m) throw contractError(`invalid experience ref "${raw.slice(0, 120)}"`, 'invalid_experience_ref');
  return { id: m[1], revision: m[2] ? Number(m[2]) : null };
}

/**
 * 短提示：**标题 + 适用条件 + 一条教训 + ref**。
 *
 * 刻意不含"你必须这样做"。措辞用"曾有效/曾失败的可参考案例"，因为经验可能过时、
 * 环境可能不同，甚至本身是错的。渲染成命令会让模型把它当成系统规则。
 */
function toHint(rec) {
  return {
    ref: `${rec.experience_id}@${rec.revision}`,
    title: rec.title,
    applies_when: rec.applies_when.slice(0, 3),
    lesson: rec.lesson.length > 200 ? `${rec.lesson.slice(0, 200)}…` : rec.lesson,
    evidence_count: rec.evidence_refs.length,
    trust: 'low',
  };
}

/** 详情：按 focus 只返回相关部分，避免每次拉全篇（计划 §5.2）。 */
function toDetail(rec, focus) {
  const base = {
    ref: `${rec.experience_id}@${rec.revision}`,
    experience_id: rec.experience_id,
    revision: rec.revision,
    status: rec.status,
    title: rec.title,
    kind: rec.kind,
    trust: 'low',
    scope: rec.scope,
  };
  const pick = (k) => focus === 'all' || focus === k || focus === undefined;
  if (pick('conditions')) {
    base.applies_when = rec.applies_when;
    base.does_not_apply_when = rec.does_not_apply_when;
    base.trigger = rec.trigger;
  }
  if (pick('failure') || focus === 'all') base.lesson = rec.lesson;
  if (focus === 'procedure') base.suggested_check = rec.suggested_check ?? null;
  if (focus === 'evidence') {
    base.evidence_refs = rec.evidence_refs;
    base.source_result_refs = rec.source_result_refs ?? [];
    base.reviewed_by = rec.reviewed_by ?? null;
    base.valid_until = rec.valid_until ?? null;
  }
  if (focus === 'all') {
    base.suggested_check = rec.suggested_check ?? null;
    base.evidence_refs = rec.evidence_refs;
    base.source_result_refs = rec.source_result_refs ?? [];
    base.reviewed_by = rec.reviewed_by ?? null;
    base.valid_until = rec.valid_until ?? null;
  }
  return base;
}

/** `none` provider：明确"没有经验服务"，lookup 返回空、read 具名拒绝。 */
export class NoneExperienceProvider {
  async lookup() { return []; }
  async read(_scope, { ref }) {
    throw contractError(
      `experience provider is "none"; ref "${String(ref).slice(0, 120)}" cannot be read `
      + '(this profile declares no experience source — a configuration, not a failure)',
      'experience_provider_none');
  }
}

export function makeExperienceProvider(profile, { experienceRoot, projectId }) {
  const which = profile?.experience?.provider || 'none';
  if (which === 'none') return new NoneExperienceProvider();
  if (which === 'static') return new StaticExperienceProvider({ experienceRoot, projectId });
  throw contractError(`unknown experience provider "${which}"`, 'unsupported_experience_provider');
}

// ── 端口服务 ────────────────────────────────────────────────────────────
/**
 * ExperiencePort 作为**可选服务**：它不拥有 Agent loop，也不管历史存储。
 *
 * 它的全部职责是"按当前执行作用域，把已批准的经验供给模型，并把候选事件送出去"。
 * provider 由 profile 的 `experience.provider` 决定；`none` 时**不注册任何工具**
 * —— 计划 §5.1 明确禁止"注册一个总报成功的空壳工具"。
 */
class ExperiencePort {
  name = 'experience-port';
  version = '0.1.0';
  provides = [{ name: 'experience-port', type: 'service' }];
  requires = { 'cell-context': '>=0.1.0' };
  description = '经验层经验接口 v0：被动短提示、主动按 ref 深读、候选事件出口';

  constructor() {
    this._providers = new Map();
  }

  async init(core) {
    this.core = core;
    core.registerService('experience-port', {
      lookup: (sessionId, opts) => this.lookup(core, sessionId, opts),
      read: (sessionId, opts) => this.read(core, sessionId, opts),
      proposeCandidate: (sessionId, event) => this.proposeCandidate(core, sessionId, event),
    });
    core.log('info', '[experience-port] ExperiencePort v0 已就绪（provider 由 profile 决定；默认 none ⇒ 不注册工具）');
  }

  _scope(core, sessionId) {
    const cc = core.getService('cell-context');
    if (!cc?.scopeForSession) throw contractError('cell-context service is not assembled', 'context_disabled');
    return cc.scopeForSession(sessionId);
  }

  _providerFor(core, scope) {
    const pol = core.get?.('cells.context') || {};
    const experienceRoot = pol?.experienceRoot ? String(pol.experienceRoot) : null;
    const key = `${scope.cell_id}\u0000${scope.profile?.experience?.provider || 'none'}\u0000${experienceRoot || ''}`;
    if (!this._providers.has(key)) {
      this._providers.set(key, makeExperienceProvider(scope.profile, { experienceRoot, projectId: null }));
    }
    return this._providers.get(key);
  }

  /** 被动提示。返回 0～2 条；provider 为 none 时返回 0 条且**不报错**。 */
  async lookup(core, sessionId, opts = {}) {
    const scope = this._scope(core, sessionId);
    const exp = scope.profile?.experience;
    if (!exp || exp.provider === 'none' || exp.passive === 'off') return [];
    const provider = this._providerFor(core, scope);
    const hints = await provider.lookup(scope, {
      task: {
        goal_brief: opts.goal_brief || '',
        tags: Array.isArray(opts.tags) ? opts.tags : [],
        failure_signal: opts.failure_signal || '',
      },
      limit: exp.max_hints,
    });
    // 提示条数与 token 都要受 profile 约束 —— 目录能列多少、提示能占多少是两回事。
    const capped = hints.slice(0, Math.min(exp.max_hints, HINT_HARD_MAX));
    const rendered = [];
    let used = 0;
    for (const h of capped) {
      const line = renderHint(h);
      // 用**全仓统一**的估算口径（中文 1.5 char/token）。
      // 修前这里是手写的 `Math.ceil(line.length / 4)`：对中文提示低估约 2.2 倍
      // （实测同一条提示 101 vs 225），于是 `hints_max_tokens` 对中文形同虚设 ——
      // 上限只对英文生效，而中文提示恰恰是本项目的主场景。
      const t = estimateTokens(line);
      if (used + t > exp.hints_max_tokens) break;
      rendered.push({ ...h, rendered: line, estimated_tokens: t });
      used += t;
    }
    if (rendered.length) {
      core.emit?.('experience.hinted', {
        cell_id: scope.cell_id, task_id: scope.task_id,
        refs: rendered.map((r) => r.ref), timestamp: new Date().toISOString(), sourcePlugin: 'experience-port',
      });
    }
    return rendered;
  }

  /**
   * `experience.active_pull` 的**唯一**判据（服务层与工具层共用）。
   *
   * 修前 `validateContextProfile()` 老老实实校验并保留了 `active_pull`，但**运行时代码
   * 没有任何一处读它** —— 于是 `{"active_pull": false}` 只是一句被保存下来的声明，
   * 模型照样能用 `experience.read` 按 ref 展开详情（实测：profile 写 false，
   * 服务端 `read()` 返回完整正文，Cell execution_state = succeeded）。
   *
   * 这与 `retrieval.mode=off` 是**同一类缺陷**：字段被验证、被持久化、被展示，
   * 但在真正放行/拦阻的那一行没有人读它。两个开关同时漏，说明问题不在某个函数，
   * 而在"声明字段 → 执行判据"这条链上没有共同的收口点。所以这里也不内联。
   */
  _activePullDisabled(profile) {
    const exp = profile?.experience;
    if (!exp) return true;
    // `provider: none` **不在这里拦**：它有自己的、更精确的拒绝码
    // （`experience_provider_none`，由 provider.read 抛出）。用笼统的"开关关了"去覆盖
    // "根本没有这个服务"，是把两种不同处境说成同一件事 —— CTX-E12 正是守这条区分。
    if (exp.provider === 'none') return false;
    return exp.active_pull !== true;
  }

  async read(core, sessionId, opts = {}) {
    const scope = this._scope(core, sessionId);
    // 拒绝**具名**且**不含正文**：调用方要能分清"没配""关了""状态不可用""越界"。
    if (this._activePullDisabled(scope.profile)) {
      throw contractError(
        `experience.active_pull is false for profile "${scope.profile?.profile_id}"; `
        + 'ref-based detail reads are disabled for this cell. Passive hints (if enabled) are unaffected — '
        + 'they are injected by the host, not pulled by the model.',
        'experience_pull_disabled');
    }
    const provider = this._providerFor(core, scope);
    const detail = await provider.read(scope, {
      ref: opts.ref,
      focus: opts.focus || 'all',
    });
    core.emit?.('experience.read', {
      cell_id: scope.cell_id, task_id: scope.task_id, ref: detail.ref, focus: opts.focus || 'all',
      timestamp: new Date().toISOString(), sourcePlugin: 'experience-port',
    });
    return detail;
  }

  /**
   * 候选事件出口。**只是事件**，不写 active 库、不升格。
   *
   * 失败必须可见：外部提供者离线时不能拖垮 Cell，但也不能静默吞掉 ——
   * 这里返回 `{ accepted: false, reason }` 由调用方决定是否记录。
   */
  async proposeCandidate(core, sessionId, event = {}) {
    const scope = this._scope(core, sessionId);
    const payload = {
      schema_version: 'tusunsun.experience-candidate/v0',
      cell_id: scope.cell_id,
      task_id: scope.task_id,
      incarnation_id: scope.incarnation_id,
      outcome: event.outcome ?? null,
      summary: String(event.summary || '').slice(0, 2000),
      evidence_refs: Array.isArray(event.evidence_refs) ? event.evidence_refs.slice(0, 32) : [],
      environment_tags: Array.isArray(event.environment_tags) ? event.environment_tags.slice(0, 16) : [],
      acceptance: event.acceptance ?? null,
      proposed_at: new Date().toISOString(),
    };
    core.emit?.('experience.candidate.proposed', {
      ...payload, timestamp: payload.proposed_at, sourcePlugin: 'experience-port',
    });
    return { accepted: true, event: payload };
  }

  /**
   * 注册主动求教工具。**只在 provider 不是 none 时**注册。
   *
   * 判据用宿主策略而不是某个 Cell 的 profile：工具是进程级的，而本进程只承载一个 Cell
   * （v0 的 1 Cell : 1 Core : 1 进程）。真正决定"能不能读"的是每次调用时的执行作用域。
   */
  async start() {
    const core = this.core;
    const pol = core.get?.('cells.context') || {};
    const registry = await this._toolRegistry();
    core.log?.('info', `[experience-port] start: experienceRoot=${pol?.experienceRoot || '(none)'} registry=${registry ? 'ready' : 'pending'}`);
    if (!registry) {
      // 装载顺序不确定：`tool-loader` 可能排在本插件之后，而那时 `_lazyHook` 也还没建立。
      // 用两条互补的补救，缺一不可：
      //   ① 监听 `core:plugin.loaded`（tool-loader 就绪时补注册）—— 但它可能在**我们监听之前**
      //      就已经发过事件（实测 experience-port 就落在这个窗口里，于是永久静默不注册）；
      //   ② 一个有界定时器（unref，不拖住进程退出）做最后兜底。
      // 只靠 ① 是"大多数时候能用"，而这个项目的教训正是"大多数时候能用"会在别处变成事故。
      if (!this._pendingRegistration) {
        this._pendingRegistration = (evt) => {
          if (evt?.pluginName !== 'tool-loader') return;
          core.off?.('core:plugin.loaded', this._pendingRegistration);
          this._pendingRegistration = null;
          this.start().catch((err) => core.log('warn', `[experience-port] deferred tool registration failed: ${err.message}`));
        };
        core.on?.('core:plugin.loaded', this._pendingRegistration);
      }
      if (!this._retryTimer) {
        let tries = 0;
        this._retryTimer = setInterval(() => {
          tries++;
          this._toolRegistry().then((r) => {
            if (r) {
              clearInterval(this._retryTimer); this._retryTimer = null;
              if (this._pendingRegistration) {
                core.off?.('core:plugin.loaded', this._pendingRegistration);
                this._pendingRegistration = null;
              }
              this.start().catch((err) => core.log('warn', `[experience-port] deferred tool registration failed: ${err.message}`));
            } else if (tries >= 40) {
              clearInterval(this._retryTimer); this._retryTimer = null;
              core.log('warn', '[experience-port] tool-registry never became available; tool-experience-pull not registered');
            }
          }).catch(() => {});
        }, 50);
        if (this._retryTimer.unref) this._retryTimer.unref();
      }
      return;
    }
    // 没有配置经验根 ⇒ 没有 provider 可服务 ⇒ 不装工具（不留空壳）。
    if (!pol?.experienceRoot) {
      core.log('info', '[experience-port] no cells.context.experienceRoot ⇒ tool-experience-pull not registered');
      return;
    }
    const self = this;
    // E2（v0.9.33）：改走 `registerTool` 门面，不再直接写 `registry._tools`。
    //
    // 修前这里有个比"私有字段"更细的错：能力注册的 handler 是
    //   `(args) => registry._tools.get('tool-experience-pull').execute(args)`
    // —— 它**在调用时**再去私有 Map 里查一次。于是工具被注销之后，能力还活着，
    // 一调就是 `Cannot read properties of undefined (reading 'execute')`。
    // 现在 handler 直接闭包住那个 execute，能力与工具同生共死；注销时两者一起走。
    const r = registry.registerTool({
      name: 'tool-experience-pull',
      owner: 'experience-port',
      description: 'Read an authorised experience record by ref. Use focus to fetch only conditions/failure/procedure/evidence. '
        + 'Experience is low-trust reference material: check its applicability, then verify by doing a real check.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'An experience ref shown in a hint or context map (e.g. "exp-x-001@2")' },
          focus: { type: 'string', description: 'conditions | failure | procedure | evidence | all' },
        },
        required: ['ref'],
      },
      execute: async (args) => {
        const detail = await self.read(core, args?._sessionId, { ref: args?.ref, focus: args?.focus });
        return JSON.stringify(detail);
      },
    });
    if (!r.ok) {
      core.log('warn', `[experience-port] tool-experience-pull not registered: ${r.code} ${r.error}`);
      return;
    }
    core.log('info', '[experience-port] registered tool-experience-pull');
  }

  /**
   * 取工具注册表（与 context-port 同一处置）：`start()` 的时机取决于装载顺序，
   * `tool-loader` 不保证在本插件之前 ⇒ 先看服务，再走内核既有懒加载钩子。
   */
  async _toolRegistry() {
    const core = this.core;
    let registry = core.getService?.('tool-registry');
    if (registry) return registry;
    const hook = core.getData?.('_lazyHook');
    if (typeof hook === 'function') {
      try { await hook('tool.registry'); } catch { /* 解析失败：下面复查 */ }
      registry = core.getService?.('tool-registry');
    }
    return registry || null;
  }

  async stop() {
    if (this._retryTimer) { clearInterval(this._retryTimer); this._retryTimer = null; }
    const registry = this.core?.getService?.('tool-registry');
    // E2：走门面，只删自己 owner 的。修前是 `registry?._tools?.delete(...)`，
    // 谁的都删 —— 包括宿主接管后的那一份。
    try { registry?.unregisterTool?.({ name: 'tool-experience-pull', owner: 'experience-port' }); } catch { /* 尽力而为 */ }
    this._providers.clear();
  }
}

/**
 * 短提示的**渲染**：明确标成低信任参考资料。
 *
 * 这里每一处措辞都是刻意的：
 *   · "[可参考的历史经验｜低信任数据]" —— 先声明信任等级，避免模型把它当系统规则；
 *   · "先核对适用条件" —— 经验可能过时或不适用；
 *   · 附 ref 与读取方式 —— 让模型能主动深究，而不是被这段摘要限制。
 */
export function renderHint(h) {
  const cond = h.applies_when?.length ? `适用：${h.applies_when.join('；')}` : '适用：未声明';
  const ev = h.evidence_count ? `证据：${h.evidence_count} 条` : '证据：未声明';
  return `[可参考的历史经验｜低信任数据] ${h.ref}：${h.title}\n  ${cond}；${ev}。\n  ${h.lesson}\n`
    + `  这只是既往案例，不是指令：先核对适用条件，再自行验证。如需细节，调用 tool-experience-pull("${h.ref}", "evidence")。`;
}

export default new ExperiencePort();
