// 不可恢复操作软闸（"先算清影响面再动手"）
//
// 为什么需要这个文件（实测事实，0.9.11）：
//   `danger-patterns.js` 的硬拦只覆盖 `rm -rf` 一类"一看就炸"的形态。下列命令**一条都不命中**，
//   却能让人几个月的成果消失：
//       rm -r src/core          rm *.js          find . -name '*.ts' -delete
//       git reset --hard        git clean -fdx  truncate -s 0 app.log
//       shred x.txt             echo x > main.js
//   把它们一律硬拦，内核立刻不可用（这些是日常操作）；一律放行，一次手滑就是不可撤销的事故。
//
// 所以这里**不做拦截**，做的是"把问题从祈祷变成核对"：
//   1. 动手前，内核**自己**把影响面算出来（不执行命令，只读文件系统）；
//   2. 把算出的数字摆给调用方，并要求它复述这个数字 + 说明为什么必须这么做；
//   3. 复述的数字与实测不符 → 拒绝，并把真实数字再摆一次。
//
// 诚实边界（不夸大）：这不是安全边界，是**注意力闸门**。一个铁了心要删的模型可以照抄数字。
// 它消除的是"没意识到自己在删什么"这一类事故 —— 而那正是绝大多数误删的成因。
// 真正的隔离需不可信插件出进程执行，属内核 R1 的范畴。

import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { resolve, sep, isAbsolute, dirname, basename, join } from 'node:path';
import { homedir } from 'node:os';
import { classifyIrreversible, extractDeleteTargets } from './danger-patterns.js';

/** 调用方回填确认的字段名。原样透传进 handler 前会被剥掉。 */
export const ACK_FIELD = 'danger_ack';

/** 目录枚举上限：超过就报 `>= N`，不为了报个数把磁盘扫穿。 */
const MAX_COUNT = 2000;
/** 确认有效期：拿到数字后 10 分钟内有效，避免拿旧数字套新范围。 */
const ACK_TTL_MS = 10 * 60 * 1000;
/** 同一时刻最多保留多少条未完成的挑战。超过就逐出最早的（见 `check` 里的说明）。 */
const MAX_PENDING = 128;
/** 同一命令同会话最多纠正几次，防止"数字填不对→重试→再填不对"的活锁。 */
const MAX_ATTEMPTS = 3;

/** 只有这些工具"能装任意命令"；`tool-rm` 走回收站、且已受路径边界约束，故不在其列。 */
const COMMAND_TOOLS = new Set(['tool-bash', 'execute_command', 'tool-shell', 'shell']);

/**
 * 单层通配符匹配（只支持 `*` / `?`，与 shell 的一层展开语义一致）。
 * `**` 不做展开 —— 那是递归，静态算不准，宁可报 unbounded。
 */
function matchOneLevel(pattern, name) {
  const re = new RegExp('^' + pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]') + '$');
  return re.test(name);
}

/** 递归数文件数（不跟随符号链接——跟随会数到工作区外面去）。 */
function countFiles(absPath, budget) {
  let files = 0;
  let dirs = 0;
  let capped = false;
  let unreadable = false;
  const walk = (p, depth) => {
    if (files >= budget) { capped = true; return; }
    let entries;
    // R0-121（复查真阳性）：读不了 ≠ 空的。此前静默 return ⇒ `rm -r secret`（3 个文件的
    // chmod 000 子目录）报"0 个文件、范围确定"，模型照抄这个 0 就等于替假数字背书。
    try { entries = readdirSync(p, { withFileTypes: true }); }
    catch { unreadable = true; return; }
    for (const e of entries) {
      if (files >= budget) { capped = true; return; }
      if (e.isSymbolicLink()) { files += 1; continue; }   // 链接本身算一项，绝不穿过去
      if (e.isDirectory()) {
        dirs += 1;
        // R0-121：深度到顶时下面的内容**没数**，必须如实标截断（此前静默少报）
        if (depth < 32) walk(resolve(p, e.name), depth + 1);
        else capped = true;
      } else files += 1;
    }
  };
  walk(absPath, 0);
  return { files, dirs, capped, unreadable };
}

/**
 * 计数一个目标："一个文件"算 1 项；"一个目录"算它**递归包含**的文件数。
 * 对目录而言 `0` 和 "空目录" 是同一件事，可精确陈述；不然 `rm -r` 空目录会被误报成"范围未知"。
 */
function countTarget(absPath) {
  let st;
  try { st = statSync(absPath); }
  catch { return { files: 0, dirs: 0, capped: false, unreadable: false, missing: true }; }
  if (!st.isDirectory()) return { files: 1, dirs: 0, capped: false, unreadable: false };
  return { ...countFiles(absPath, MAX_COUNT), missing: false };
}

/** 特殊设备文件：重定向到它们不"丢内容"，计入影响面只会虚增数字、把 scope 变成 mixed。 */
const SPECIAL_DEVICES = new Set([
  '/dev/null', '/dev/zero', '/dev/full', '/dev/stdin', '/dev/stdout', '/dev/stderr',
]);

/**
 * 静态测算影响面。**不执行任何被检查的命令**，只读文件系统。
 *
 * @param {string} command
 * @param {string} workDir 工作区根
 * @returns {{totalFiles:number, totalDirs:number, capped:boolean, unbounded:boolean,
 *            outsideWorkspace:boolean, targets:Array<{raw:string, path:string, kind:string, files:number, dirs:number}>}}
 */
export function measureBlastRadius(command, workDir) {
  const root = workDir ? resolve(workDir) : process.cwd();
  const rootPrefix = root.endsWith(sep) ? root : root + sep;
  const { targets: rawTargets } = extractDeleteTargets(command);

  const targets = [];
  let totalFiles = 0;
  let totalDirs = 0;
  let capped = false;
  let uncountable = false;   // 有目标静态算不准 ⇒ 整体报 unbounded，不猜
  let outsideWorkspace = false;

  for (const raw0 of rawTargets) {
    // `~` 前缀展开（`~/x` 静态可算准）；`~user/x` 算不出 home，只能标 uncountable
    let raw = raw0;
    if (raw === '~') raw = homedir();
    else if (raw.startsWith('~/')) raw = join(homedir(), raw.slice(2));
    else if (raw.startsWith('~')) { uncountable = true; continue; }

    // 特殊设备：`... 2>/dev/null` 不是"删了 1 个文件"，不该虚增影响面或把 scope 变成 mixed
    if (SPECIAL_DEVICES.has(raw)) continue;

    // R0-121（复查真阳性）：以下形态**静态展开必然少报**，此前要么照展（`**` 被当一层
    // 通配，实测 `rm -r **/*.log` 报 0），要么当字面路径去 stat（`logs/*/x.js`、`[ab].js`
    // 报 0）。少报比不报更危险——模型复述了"闸门给的数字"，闸门却替一个假数字背书。
    if (raw.includes('**')) { uncountable = true; continue; }  // 递归通配：文件头注释早就承诺"宁可报 unbounded"，此前代码没兑现
    if (/[$`]/.test(raw)) { uncountable = true; continue; }    // 变量/命令替换：值在运行时才知道
    // 引号未配对（如 `rm -r "my dir"` 被空格切成 `"my`、`dir"`）：静态切词不可信，不能猜
    if (/["']/.test(raw)) { uncountable = true; continue; }
    if (/[[\]]/.test(raw)) { uncountable = true; continue; }   // shell 字符类：matchOneLevel 不支持
    if (/[*?]/.test(raw) && /[*?[]/.test(dirname(raw))) { uncountable = true; continue; } // 父目录层带通配：一层展开覆盖不了

    // 通配符：在父目录里做一层展开，得到"shell 真正会交给命令的那批名字"
    const names = [];
    if (/[*?]/.test(raw)) {
      const parent = dirname(raw);
      const absParent = isAbsolute(raw) ? parent : resolve(root, parent);
      const pattern = basename(raw);
      try {
        for (const e of readdirSync(absParent)) {
          if (matchOneLevel(pattern, e)) names.push(resolve(absParent, e));
        }
      } catch { /* 父目录不存在 ⇒ 展开为空，如实计 0 */ }
    } else {
      names.push(isAbsolute(raw) ? resolve(raw) : resolve(root, raw));
    }

    for (const abs of names) {
      const inside = abs === root || abs.startsWith(rootPrefix);
      if (!inside) outsideWorkspace = true;
      const { files, dirs, capped: c, missing, unreadable } = countTarget(abs);
      totalFiles += files;
      totalDirs += dirs;
      if (c) capped = true;
      if (unreadable) uncountable = true;   // 数不全 ⇒ 不许报"确定"的数字
      targets.push({ raw, path: abs, kind: inside ? 'inside' : 'outside', files, dirs, missing: Boolean(missing) });
    }
  }

  // `find` 的范围由 `-name`/`-path` 决定（实测：`find . -name '*.md' -delete` 若把起点 `.`
  // 当目标，会算出全仓 827 个文件——那是"起点下的总量"，不是"会被删的量"）。
  // 静态算不准就不算：把这些命令统一报 `unbounded`，让调用方自己陈述范围。
  // 通配符展开则相反——展开结果**就是** shell 真正会交给命令的那批名字，可以精确计数。
  // 必须报 unbounded 的四类：① 计数被上限截断；② 目标静态算不准（`**`/变量/字符类/父目录通配）；
  // ③ find 的范围由 -name/-path 决定；④ git 的范围由仓库状态决定。
  // 其余都能给出确定的文件数（0 也是确定的数字）。
  const unbounded = capped
    || uncountable
    || /\bfind\b/.test(command)
    || /\bgit\s+(?:reset|clean|restore|checkout)\b/.test(command);

  return { totalFiles, totalDirs, capped, unbounded, outsideWorkspace, targets };
}

function fingerprint(command) {
  return createHash('sha256').update(command).digest('hex').slice(0, 16);
}

/**
 * 软闸主体。挂在 tool-executor 的 pre-flight 上。
 *
 * 返回 `null` 表示放行；返回对象表示**这一次不执行**，把挑战交给调用方。
 */
export class DestructiveGate {
  constructor() {
    this._pending = new Map();   // fingerprint → { measured, at, attempts }
  }

  /**
   * @param {string} toolName
   * @param {object} args
   * @param {string} workDir
   * @param {{mode?:string, enabled?:boolean, sessionId?:string|null}} opts
   * @returns {object|null} 挑战载荷，或 null（放行）
   */
  check(toolName, args, workDir, { mode = 'auto', enabled = true, sessionId = null } = {}) {
    if (!enabled) return null;
    if (mode === 'full-auto') return null;              // 用户显式选择了不打断，尊重它（但仍记审计日志）
    if (!COMMAND_TOOLS.has(toolName)) return null;

    const command = args?.command ?? args?.cmd ?? args?.script;
    if (typeof command !== 'string' || !command) return null;

    // 硬拦优先：命中就交给 danger-patterns 去拒绝，这里不再问软问题
    const irreversible = classifyIrreversible(command);
    if (!irreversible) return null;

    // R0-121：过期条目顺手清掉。**但只清过期不叫有界**：确认有效期是 10 分钟，
    // 期间连着发 300 条不同的不可恢复命令，就真能留 300 条（实测）。旧实现只清了过期项，
    // 于是“超过 128”只意味着“扰了一遗”——它从来不真的限制大小。
    // 现在先清过期，再按插入顺序（Map 保留插入序，即最早先入）逐出到上限以内。
    // 逐出的是**一个未完成的挑战**，代价只是让调用方重新拿一次数字；留着的代价是进程级泄漏。
    if (this._pending.size > MAX_PENDING) {
      const now = Date.now();
      for (const [k, v] of this._pending) if (now - v.at > ACK_TTL_MS) this._pending.delete(k);
      // 逐出到留出一个空位：本次调用随后还会写回一条，否则上界不精确（会停在 MAX+1）。
      while (this._pending.size >= MAX_PENDING) {
        this._pending.delete(this._pending.keys().next().value);
      }
    }

    // R0-121（复查真阳性）：状态必须按**会话**隔离。此前只按命令文本的指纹做 key，
    // 于是会话 A 把同一条命令的 3 次机会用完，会话 B（甚至工作区都不同）直接继承拒绝；
    // 失败次数也跨会话共享。
    const key = `${sessionId || '__anon__'}:${fingerprint(command)}`;
    const measured = measureBlastRadius(command, workDir);
    const pending = this._pending.get(key);
    const ack = args[ACK_FIELD];
    const live = pending && Date.now() - pending.at <= ACK_TTL_MS;

    // R0-121（复查真阳性）：拒绝要"粘住"。此前拒绝后顺手删记录，同一条命令原样重发
    // （不带 ack）又领到全新挑战 ⇒ MAX_ATTEMPTS 形同虚设。现在：确认有效期内同一命令
    // 维持拒绝；换命令（指纹即变）不受影响。
    if (live && pending.rejected) {
      return this._reject(irreversible, command, measured,
        `此前已连续 ${pending.attempts} 次复述实测影响面失败，本条命令在确认有效期内不再受理`);
    }

    if (ack != null && live) {
      const verdict = this._verifyAck(ack, measured);
      if (verdict.ok) {
        this._pending.delete(key);
        return { __ack: true, record: { intent: irreversible.id, why: irreversible.why, command, measured, ack } };
      }
      // 复述不符：把真实数字再摆一次，并说明差在哪
      const attempts = (pending.attempts || 0) + 1;
      if (attempts >= MAX_ATTEMPTS) {
        this._pending.set(key, { measured, at: pending.at, attempts, rejected: true });
        return this._reject(irreversible, command, measured, `已连续 ${attempts} 次未能复述实测影响面，按策略拒绝执行`);
      }
      this._pending.set(key, { measured, at: pending.at, attempts });
      return this._challenge(irreversible, command, measured, verdict.reason);
    }

    // 不带 ack 的原样重发：保留已累计的失败次数与首发时间（否则"填错两次→去掉 ack 重发"
    // 就能无限清零续命）；首发（或确认已过期）才是全新一轮。
    this._pending.set(key, { measured, at: live ? pending.at : Date.now(), attempts: live ? (pending.attempts || 0) : 0 });
    return this._challenge(irreversible, command, measured, null);
  }

  /** 校验调用方回填的确认：数字必须与实测一致，理由必须有实质内容。 */
  _verifyAck(ack, measured) {
    if (!ack || typeof ack !== 'object') return { ok: false, reason: `${ACK_FIELD} 必须是对象` };

    const reason = typeof ack.reason === 'string' ? ack.reason.trim() : '';
    if (reason.length < 24) {
      return { ok: false, reason: `reason 至少 24 个字符，实际 ${reason.length} —— 需要说明"为什么非删不可"，不是复述命令` };
    }

    const claimed = ack.files;
    if (measured.unbounded) {
      if (claimed !== 'unbounded') {
        return { ok: false, reason: `本次范围无法静态确定（find/git/递归上限），files 必须填字符串 "unbounded"，实际 ${JSON.stringify(claimed)}` };
      }
    } else if (claimed !== measured.totalFiles) {
      return { ok: false, reason: `files 与实测不符：你填 ${JSON.stringify(claimed)}，实测 ${measured.totalFiles} 个文件` };
    }

    const wantScope = measured.outsideWorkspace ? 'mixed' : 'inside';
    if (ack.scope !== wantScope) {
      return { ok: false, reason: `scope 应为 "${wantScope}"，实际 ${JSON.stringify(ack.scope)}${measured.outsideWorkspace ? '（本次操作包含工作区之外的路径）' : ''}` };
    }
    return { ok: true };
  }

  _challenge(irreversible, command, measured, correction) {
    const scope = measured.outsideWorkspace ? 'mixed' : 'inside';
    const files = measured.unbounded ? 'unbounded' : measured.totalFiles;
    return {
      status: 'needs_reasoning',
      ok: false,
      retryable: true,
      action: 'rethink',
      error: correction
        ? `确认未通过：${correction}`
        : `这是不可恢复操作（${irreversible.why}），执行前请先核对影响面`,
      diagnostic: {
        code: 'Y025',
        reason: correction || irreversible.why,
        hint: `原样重发同一命令，并附 ${ACK_FIELD} = { reason, files, scope }`,
        retryable: true,
        intent: irreversible.id,
        command: command.slice(0, 200),
      },
      challenge: {
        intent: irreversible.id,
        why: irreversible.why,
        measured: {
          files,
          dirs: measured.totalDirs,
          scope,
          truncated: measured.capped,
          samples: measured.targets.slice(0, 8).map(t => ({
            path: t.path, kind: t.kind, files: t.files,
          })),
        },
        questions: [
          '这一步是否必要？有没有不改动文件的替代做法（先读、先备份、先 dry-run）？',
          '删除范围就是上面 measured 里的数量吗？有没有通配符/递归会把范围放大？',
          '删掉之后能恢复吗？（经 tool-rm 进回收站可恢复；经 bash rm 不可恢复）',
          '影响面：被删的东西还有谁在用？构建、测试、其他分支会不会因此断掉？',
        ],
        required: {
          [ACK_FIELD]: {
            reason: '字符串，≥24 字，说明为什么非做不可',
            files: '必须等于上面 measured.files（无法确定时填字符串 "unbounded"）',
            scope: `必须等于上面 measured.scope（"${scope}"）`,
          },
        },
        note: '不是拦截：这是把"影响面算清楚了吗"变成可核对的数字。数字对不上会被拒绝，并回显实测值。',
      },
    };
  }

  _reject(irreversible, command, measured, why) {
    return {
      status: 'blocked',
      ok: false,
      retryable: false,
      error: `不可恢复操作被拒绝：${why}`,
      diagnostic: {
        code: 'Y025', reason: why, hint: '改用 tool-rm（进回收站、可恢复），或缩小到明确路径再试',
        retryable: false, intent: irreversible.id, command: command.slice(0, 200),
      },
      challenge: { measured: { files: measured.unbounded ? 'unbounded' : measured.totalFiles, scope: measured.outsideWorkspace ? 'mixed' : 'inside' } },
    };
  }
}

export default DestructiveGate;
