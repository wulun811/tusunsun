// R0-114（二次评审 P1-03）：`tusunsun config set` 的**类型保真**。
//
// 事实（修前 0.9.6，实测）：`config set gateway.allowRemote true` 报"设置成功"，
// 落盘却是 `"allowRemote": "true"`（字符串）。网关判对外 opt-in 用的是严格 `=== true`，
// 于是「配了 allowRemote、配了 Key、host=0.0.0.0」依然拒绝启动、exit 1 ——
// CLI 显示成功，功能却没生效。同类：`tools.safetyReflection false`、
// `gateway.port 9002`（字符串端口，`httpServer.listen('9002')` 行为依赖实现）。
//
// 现在：以**既有配置值/默认配置的类型**为准做条件转换；
//   · 已有值是 boolean / number（或键在 DEFAULT_CONFIG 里是 boolean/number）⇒ 必须能被解析成同类型，
//     否则具名报错、**不写盘**（"设了但没生效"比"报错"更贵）；
//   · 已有值是 string ⇒ 保持 string（`model.model` 取 `"true"` 这种名字不许被转成布尔）；
//   · 键不存在（自定义配置）⇒ 维持字符串，或由 `--json` 显式声明类型。
// 转换规则只在这里实现一份，`config get` / 网关读取侧不需要改（它们读到的就是正确类型）。

// 刻意**只认** true/false/1/0：`allowRemote` 这类安全开关多认一种拼写，就多一条
// "以为是 false、其实是 true"的路。想在自定义键上传别的形状请用 `--json`。
const BOOL_TRUE = new Set(['true', '1']);
const BOOL_FALSE = new Set(['false', '0']);

/**
 * 依既有值的类型把命令行字符串转成目标类型。
 * @param {unknown} raw 命令行给的字符串
 * @param {unknown} existing 既有值（`undefined` 表示该键尚不存在）
 * @param {boolean} jsonMode `--json`：显式按 JSON 解析
 * @returns {{ ok: true, value: unknown } | { ok: false, error: string }}
 */
export function coerceConfigValue(raw, existing, jsonMode = false) {
  const text = String(raw);
  if (jsonMode) {
    try { return { ok: true, value: JSON.parse(text) }; }
    catch (err) { return { ok: false, error: `--json 值不是合法 JSON：${err.message}` }; }
  }
  if (typeof existing === 'boolean') {
    const v = text.trim().toLowerCase();
    if (BOOL_TRUE.has(v)) return { ok: true, value: true };
    if (BOOL_FALSE.has(v)) return { ok: true, value: false };
    return { ok: false, error: `期望布尔值（true/false），收到 ${JSON.stringify(text)}` };
  }
  if (typeof existing === 'number') {
    const v = text.trim();
    // 只认十进制整/浮点；空串、`0x10`、`1_000`、`Infinity` 一律不接受（NaN 进了配置就是灾难）。
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v)) {
      return { ok: false, error: `期望数字，收到 ${JSON.stringify(text)}` };
    }
    const n = Number(v);
    if (!Number.isFinite(n)) return { ok: false, error: `期望有限数字，收到 ${JSON.stringify(text)}` };
    return { ok: true, value: n };
  }
  if (existing === null || existing === undefined) {
    // 未有先例的自定义键：**不猜**。用户想给类型就用 --json，
    // 否则串 "true" 会被下游当成真值——那正是本轮要消灭的那类缺陷。
    return { ok: true, value: text };
  }
  return { ok: true, value: text };   // 既有值是字符串（含 `"true"` 这种模型名）⇒ 原样保留
}

/** 取 `obj` 上以 `parts` 为路径的既有值（不存在返回 undefined）。 */
export function existingValueAt(obj, parts) {
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    if (!(p in cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}
