// R0-114（二次评审 P0-01）：会话标识的**唯一**契约。
//
// 事实（修前 0.9.6，二层评审实测复现）：`src/builtin/session.js` 把请求里的 `session_id`
// 直接拼进 `join(this.dir, `${sessionId}.jsonl`)`：
//   ① 写：`{"session_id":"../../workspace/escaped_session"}` → HTTP 200，并在
//      `<stateDir>/sessions` **之外**真的创建了 `escaped_session.jsonl`；
//   ② 读：预先放一个 `<workspace>/secret_info.jsonl`，`session_id:"../../workspace/secret_info"`
//      → 该文件内容被读成"历史"，随本次用户消息一起**上送所配置的模型端点**。
// 根因不是"少了一句校验"，而是**把外部输入当成了路径片段**。`plugins/tools/lib/workspace.mjs`
// 只保护模型文件工具，与持久化层无关。
//
// 现在的判据（单一实现，所有入口共用）：
//   · `sessionId` 是 **opaque 标识符**，不具路径语义：只允许 ASCII 字母/数字/`. _ @ + -`，
//     首字符必须是字母或数字，长度 ≤ 128；非字符串/含 `/` `\` 控制字符一律拒绝；
//   · **空串的语义（R0-116/P2 明确化）**：`''` 与 `undefined`/`null` **同义**，都表示
//     "调用方没给 session_id"。给了 `opts.fallback` 就落到 fallback（这是 OpenAI SDK 的
//     常态：不传该字段），**没有** fallback 才具名拒绝。
//     为什么不让 `''` 单独报错：① 对外兼容 —— 多数 SDK/网关把"空"与"缺省"混同，
//     单独拒绝会让"没传字段"的客户端偶发 400；② 安全上等价 —— `''` 不是路径片段，
//     既不能穿越也不能读界外文件，落成 `rest_api` 与"没传"完全一致。
//     与"**显式给了但不合法**"必须区分：后者即使有 fallback 也一律拒绝（见下方 CASES）。
//   · 落盘路径 = `resolve(sessionsRoot, id + '.jsonl')`，再用 `relative()` 判**真包含**
//     （字符串前缀不是包含关系：`sessions_evil/` 以 `sessions` 开头）；
//   · 再对已存在文件取 `realpath`，拒绝"文件名合法但被符号链接指到外面"的旧遗留；
//   · 拒绝时抛 `code:'invalid_session_id' | 'out_of_bounds'` + `contractError:true`，
//     调用方据此回**具名 400**，且**不产生任何副作用**（不建目录、不写文件、不发模型请求）。
//
// 兼容性：既有的合法 id（`s1`、`default`、`rest_api`、`ch_<channel>_<sender>`、`tui_xxxxxxxx`、
// `session_0`…）全部通过；含 `:`（`sid:resume:1`，仅用于内存态子代理会话）与含 `/` 的旧值
// 不再被接受——它们本来就不该落成文件名。`listSessions()` 只列出合规 id，并在日志里报出
// 被跳过的历史文件名数量（不静默、也不删除）。
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { realpath } from 'node:fs/promises';

const MAX_LEN = 128;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._@+-]*$/;

function contractError(message, code) {
  return Object.assign(new Error(message), { code, contractError: true });
}

/**
 * 校验并返回**规范化**的会话 id。
 * @param {unknown} raw 来自 HTTP / WS / 插件调用的会话标识
 * @param {{fallback?: string}} [opts] `fallback` 仅在**未提供**（`undefined` / `null` / `''`）时使用
 * @returns {string}
 */
export function assertSessionId(raw, opts = {}) {
  let id = raw;
  // R0-116/P2：`''` 与 `undefined`/`null` 同义 = "没给"（判定见文件头"空串的语义"）。
  if (id === undefined || id === null || id === '') {
    if (opts.fallback) {
      id = opts.fallback;
    } else {
      throw contractError('session_id is required（会话标识为必填的 opaque ID）', 'invalid_session_id');
    }
  }
  if (typeof id !== 'string') {
    throw contractError(`session_id must be a string（收到 ${typeof id}）`, 'invalid_session_id');
  }
  if (id.length > MAX_LEN) {
    throw contractError(`session_id too long（${id.length} > ${MAX_LEN}）`, 'invalid_session_id');
  }
  // 单列出来只为把拒绝理由说清：`.`/`..` 与分隔符是**唯一**有路径语义的"标识符"形态。
  // 其余包含关系不靠这里判——`resolve()+relative()` 才是判据（见 resolveSessionFile）。
  if (id === '.' || id === '..' || id.includes('/') || id.includes('\\')) {
    throw contractError(
      `session_id must be an opaque ID, not a path（"${id.slice(0, 64)}" 含路径分隔符或 ..）`,
      'invalid_session_id');
  }
  if (!SAFE_ID.test(id)) {
    throw contractError(
      `session_id 只允许 ASCII 字母/数字与 . _ @ + -（首字符为字母或数字，≤${MAX_LEN}）：`
      + `收到 ${JSON.stringify(id.slice(0, 64))}`,
      'invalid_session_id');
  }
  return id;
}

/** 仅判定（不抛）：供 `listSessions()` 过滤磁盘上的历史文件。 */
export function isValidSessionId(raw) {
  try { assertSessionId(raw); return true; } catch { return false; }
}

/** 目标（或其最近的已存在祖先）的真实路径仍必须在 sessionsRoot 内。 */
async function assertRealInside(root, target, id) {
  const rootReal = await realpath(root).catch(() => null);
  if (!rootReal) return;
  let probe = target;
  let real = await realpath(target).catch(() => null);
  if (!real) {
    // 目标不存在（常规的"新建会话"）：退到最近的已存在祖先，覆盖
    // `sessions/<合法名>.jsonl` 被事先换成一个指向外部的符号链接的情形。
    const { dirname } = await import('node:path');
    probe = dirname(target);
    for (;;) {
      real = await realpath(probe).catch(() => null);
      if (real) break;
      const up = dirname(probe);
      if (up === probe) return;
      probe = up;
    }
  }
  const rel = relative(rootReal, real);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw contractError(
      `session_id "${id}" resolves outside the sessions store via symlink.\n`
      + `Sessions: ${rootReal}\nResolved: ${real}`,
      'out_of_bounds');
  }
}

/**
 * 把会话 id 解析为 sessions 目录内的绝对文件路径（`<id>.jsonl`）。
 * 越界/非法一律具名拒绝，绝不"悄悄换个名字继续"。
 * @param {string} sessionsRoot 会话存储目录
 * @param {unknown} raw 外部输入
 * @returns {Promise<{ id: string, file: string }>}
 */
export async function resolveSessionFile(sessionsRoot, raw) {
  const id = assertSessionId(raw);
  const root = resolve(sessionsRoot);
  const file = resolve(root, `${id}.jsonl`);
  const rel = relative(root, file);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel) || /[\\/]/.test(rel)) {
    throw contractError(
      `session_id "${id}" escapes the sessions store.\nSessions: ${root}\nResolved: ${file}`,
      'out_of_bounds');
  }
  await assertRealInside(root, file, id);
  return { id, file };
}

export const SESSION_ID_MAX_LEN = MAX_LEN;
