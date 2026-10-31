import { readFile, writeFile, appendFile, mkdir, readdir, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveSessionFile, assertSessionId, isValidSessionId } from './tools/lib/session-id.mjs';
import { createSessionQueue } from './tools/lib/session-queue.mjs';

class SessionPlugin {
  name = 'session';
  version = '0.4.0';
  permissions = ['fs.read', 'fs.write'];
  provides = [{ name: 'session', type: 'service' }];

  constructor() {
    this.sessions = new Map();
    this._savedCounts = new Map();
    this.dir = '';
    this.useDb = false;
    this.kongmen = null;
    this._kongmenReady = null;
    // R0-123：同一会话的落盘必须串行。此前两个并发请求都在 `saved === 0` 分支里整段
    // `writeFile`，后写的把先写的覆盖掉（实测：先发的那一轮从历史里整段消失）。
    this._writeQueue = createSessionQueue();
  }

  async init(core) {
    this.core = core;
    this.dir = join(core.stateDir, 'sessions');
    // R0-114（P1-04）：会话原文是**敏感持久文件**（对话全文、可能的密钥粘贴）。目录 0700、
    // 文件 0600；`mkdir` 的 mode 受 umask 影响，故显式 chmod 归一（与 config 插件同一口径）。
    // 既存目录/文件里权限偏宽的，这里**尽力收紧**并记录失败——不静默假装已经安全。
    if (!existsSync(this.dir)) await mkdir(this.dir, { recursive: true, mode: 0o700 });
    try { await chmod(this.dir, 0o700); } catch (err) {
      core.log('warn', `Session: cannot tighten ${this.dir} to 0700 (${err.code || err.message})`);
    }
    const db = core.getService('db');
    this.useDb = db && db.mode === 'sqlite';
    if (this.useDb) core.log('info', `Session: DB mode (SQLite)`);
    else core.log('info', `Session: JSONL fallback mode`);
    // W11 批1：外部会话仓在场时会话原文统一归外部会话仓仓（「会话归外部会话仓」），本插件退化为 sink 适配层；
    // 外部会话仓缺席（纯平台部署）回退 legacy db/JSONL，行为与旧版一致。
    this.kongmen = core.getService('kongmen') || null;
    if (this.kongmen) core.log('info', `Session: kongmen warehouse mode`);
    core.registerService('session', this);
  }

  getHistory(sessionId) {
    const msgs = this.sessions.get(sessionId);
    return msgs ? [...msgs] : [];
  }

  // W11 批1：消息 → 外部会话仓 turn 映射。tool_calls 折叠进 meta（外部会话仓 turn 是 {role, content} 纯文本），
  // content 为空且有 tool_calls 时 stringify 兜底，保证轮次在外部会话仓侧可见。
  _toKongmenTurn(m) {
    const meta = m.tool_calls ? { tool_calls: m.tool_calls } : undefined;
    const content = m.content || (m.tool_calls ? JSON.stringify(m.tool_calls) : '');
    return { role: m.role, content, meta };
  }

  async saveHistory(sessionId, messages) {
    // R0-123：排队而不是并发写。串行化只保证"不交错、不乱序"，不改变"后写覆盖先写"的
    // 语义 —— 真正的语义修复在 `haotian-lite` 的按会话轮次锁（同一会话的整轮串行）。
    return this._writeQueue.run(sessionId, () => this._saveHistory(sessionId, messages));
  }

  async _saveHistory(sessionId, messages) {
    // R0-114（P0-01）：**任何后端**都先过标识契约。SQLite 模式下 id 是绑定参数（无路径语义），
    // 但"不同后端的安全语义不同"本身就是缺陷：换后端不该改变什么算合法会话。
    assertSessionId(sessionId);
    const trimmed = messages.length > 200 ? messages.slice(-200) : messages;
    this.sessions.set(sessionId, trimmed);
    let saved = this._savedCounts.get(sessionId) || 0;
    if (saved > messages.length) saved = 0;

    // W11 批1：外部会话仓仓模式——只把增量消息转发给外部会话仓，不写 legacy 存储（避免双真相）
    if (this.kongmen?.addTurn) {
      // 外部会话仓 add_turn 要求 session 已 init；对已存在的 sid 禁止重复 init（事件流中途
      // 追加 init 会让重放丢弃此前轮次），先查 registry 再懒初始化。
      if (!this._kongmenReady) this._kongmenReady = new Set();
      if (!this._kongmenReady.has(sessionId)) {
        try {
          const known = (await this.kongmen.listSessions?.()) || [];
          const existing = known.find(s => s.sid === sessionId);
          if (existing) {
            // 重启恢复：以外部会话仓 registry 的轮次数校准增量游标，防止整段重发（重演 W10 批2 病）
            if (!this._savedCounts.has(sessionId)) {
              this._savedCounts.set(sessionId, existing.turns || 0);
              saved = existing.turns || 0;
            }
          } else {
            await this.kongmen.init(sessionId);
          }
          this._kongmenReady.add(sessionId);
        } catch (err) {
          this.core.log('warn', `Session sink kongmen init failed for ${sessionId}: ${err.message}`);
          this._savedCounts.set(sessionId, messages.length);
          return;
        }
      }
      if (saved > messages.length) saved = 0;
      const fresh = messages.slice(saved);
      for (const m of fresh) {
        try {
          const t = this._toKongmenTurn(m);
          await this.kongmen.addTurn(sessionId, t.role, t.content, t.meta);
        } catch (err) {
          this.core.log('warn', `Session sink kongmen failed for ${sessionId}: ${err.message}`);
        }
      }
      this._savedCounts.set(sessionId, messages.length);
      return;
    }

    if (this.useDb) {
      // W10 批2：DB 用输入计数增量追加——旧码在窗口滑动（messages>200）时 saved>trimmed.length
      // 归零，导致每轮整段重插（tusunsun.db messages 表实测 3.26x 膨胀，90% 行属重复组）
      const fresh = messages.slice(saved);
      if (!fresh.length) return;
      const db = this.core.getService('db');
      if (saved === 0) {
        db.insert('sessions', { id: sessionId, updated_at: Math.floor(Date.now() / 1000) });
      }
      for (const m of fresh) {
        db.insert('messages', { session_id: sessionId, role: m.role, content: m.content, tool_calls: m.tool_calls ? JSON.stringify(m.tool_calls) : null });
      }
    } else {
      const newMessages = saved <= trimmed.length ? trimmed.slice(saved) : trimmed;
      if (!newMessages.length) return;
      // R0-114（P0-01）：**先解析、再落盘**。路径由契约给出；非法 id 抛具名错误，
      // 此时既不建目录也不写文件（修前：`../../workspace/escaped_session` 直接写到界外）。
      let file;
      try {
        ({ file } = await resolveSessionFile(this.dir, sessionId));
      } catch (err) {
        this.core.log('warn', `Session: refused to persist "${String(sessionId).slice(0, 64)}": ${err.message}`);
        throw err;
      }
      const body = newMessages.map(m => JSON.stringify(m)).join('\n') + '\n';
      try {
        if (saved === 0 || saved > trimmed.length) {
          // P1-04：会话原文 0600（授权用户之外的账号读不到；导出/移动后也不外泄）。
          await writeFile(file, body, { mode: 0o600 });
          try { await chmod(file, 0o600); } catch { /* 非 POSIX：尽力而为 */ }
        } else {
          await appendFile(file, body);
        }
      } catch (err) {
        this.core.log('warn', `Failed to save session ${sessionId}: ${err.message}`);
        throw err;
      }
    }

    this._savedCounts.set(sessionId, messages.length);
  }

  async loadSession(sessionId) {
    // R0-123：读之前先等这一轮写落盘（读己所写）。否则"刚存完立刻读"在并发下会读到旧内容。
    await this._writeQueue.pending(sessionId);
    // R0-114（P0-01）：同上，入口统一。非法 id 抛具名错误 —— **不得**悄悄按"新会话"继续
    // （那会让攻击请求拿到 200，只是历史为空）。
    assertSessionId(sessionId);
    if (this.sessions.has(sessionId)) return this.sessions.get(sessionId);
    // W11 批2：外部会话仓仓模式优先读穿（meta.tool_calls 还原为消息形态）
    if (this.kongmen?.getTurns) {
      try {
        const turns = await this.kongmen.getTurns(sessionId);
        if (turns.length) {
          const messages = turns.map(t => {
            const meta = t?._kongmen?.meta || {};
            return { role: t.role, content: t.content, tool_calls: meta.tool_calls || null };
          });
          this.sessions.set(sessionId, messages);
          return messages;
        }
      } catch (err) {
        this.core.log('warn', `Session read-through kongmen failed for ${sessionId}: ${err.message}`);
      }
      return [];
    }
    if (this.useDb) {
      const db = this.core.getService('db');
      const rows = db.query('SELECT role, content, tool_calls FROM messages WHERE session_id = ? ORDER BY id', [sessionId]);
      const messages = rows.map(r => ({ ...r, tool_calls: r.tool_calls ? JSON.parse(r.tool_calls) : null }));
      this.sessions.set(sessionId, messages);
      return messages;
    }
    // R0-114（P0-01）：读取同样先过契约。修前 `join(this.dir, `${sessionId}.jsonl`)` 会把
    // `../../workspace/secret_info` 读成"历史"，随后随本次用户消息**上送模型端点**。
    // 现在：非法 id 直接抛 `invalid_session_id`（网关回 400），既读不到界外文件，也不发模型请求。
    const { file } = await resolveSessionFile(this.dir, sessionId);
    try {
      if (!existsSync(file)) return [];
      const raw = await readFile(file, 'utf8');
      const messages = raw.trim().split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
      this.sessions.set(sessionId, messages);
      return messages;
    } catch (err) {
      if (err.contractError) throw err;
      this.core.log('warn', `Session read failed for ${sessionId}: ${err.message}`);
      return [];
    }
  }

  async listSessions() {
    // W11 批2：外部会话仓 registry 全量优先，legacy 来源合并去重
    if (this.kongmen?.listSessions) {
      try {
        const kongmenIds = (await this.kongmen.listSessions()).map(s => s.sid);
        const legacy = this.useDb
          ? this.core.getService('db').query('SELECT id FROM sessions ORDER BY updated_at DESC').map(r => r.id)
          : (await readdir(this.dir).catch(() => [])).filter(f => f.endsWith('.jsonl')).map(f => f.slice(0, -6));
        return [...new Set([...kongmenIds, ...legacy])];
      } catch (err) {
        this.core.log('warn', `Session list read-through kongmen failed: ${err.message}`);
      }
    }
    if (this.useDb) {
      const db = this.core.getService('db');
      return db.query('SELECT id FROM sessions ORDER BY updated_at DESC').map(r => r.id);
    }
    try {
      const files = await readdir(this.dir);
      const names = files.filter(f => f.endsWith('.jsonl')).map(f => f.slice(0, -6));
      const valid = names.filter(isValidSessionId);
      // R0-114：不合规的历史文件名**不静默丢弃**——报出数量，让运维能判断"是不是被攻击过"。
      // 也不删除：那是用户数据，清理由人来决定。
      if (valid.length !== names.length) {
        this.core.log('warn', `Session: ${names.length - valid.length} 个历史文件名不符合会话标识契约（已从列表中排除，未删除）`);
      }
      return valid;
    } catch {
      return [];
    }
  }

  // 进程退出时把内存中的会话逐个归档广播（外部引擎桥等监听方据此摄入记忆库）。
  // 本插件注册早于目录插件，core.stop 按注册顺序停插件，emit 时监听方必然在位；
  // 监听方自行负责异步落库的完成等待。
  async stop() {
    for (const [sessionId, messages] of this.sessions) {
      if (!messages?.length) continue;
      try {
        this.core.emit('session.archived', { sessionId, messages, sourcePlugin: 'session' });
      } catch (err) {
        this.core.log('warn', `Failed to archive session ${sessionId}: ${err.message}`);
      }
    }
  }
}

export default new SessionPlugin();
