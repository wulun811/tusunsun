// 敏感值脱敏（R0-105 缺陷 3）
//
// 为什么需要：`tusunsun config show` 会原样 `JSON.stringify` 整份配置，`config get model.apiKey`
// 会原样打印，`config set model.apiKey xxx` 还会把明文回显到终端——截图、录屏、贴 issue
// 时密钥就泄了。内核自己带着 `SecretsManager`（AES-256-GCM + pbkdf2），CLI 这条却完全绕过
// 加密路径：两套机制互相矛盾，"加密存储"的承诺被 CLI 一行打印作废。
//
// 注意边界：本模块只做**展示层脱敏**（防止肩窥/截图/日志泄露），不改变存储格式。
// 是否需要把 `config set` 的敏感项改走加密存储，属独立决策——本模块先堵住泄露面。

/** 键名命中即视为敏感（不区分大小写，按子串匹配） */
const SENSITIVE_KEY_PATTERNS = [
  /key/i, /token/i, /secret/i, /password/i, /passwd/i,
  /credential/i, /^authorization$/i, /cookie/i, /private/i,
];

/**
 * 判断某个配置键是否敏感。
 * @param {string} key 单段键名（不含点）
 * @returns {boolean}
 */
export function isSensitiveKey(key) {
  if (typeof key !== 'string' || !key) return false;
  // 白名单例外：`apiKeys` 这类**列表**仍是敏感；但 `maxTokens`/`tokenUsage` 不是密钥，
  // 属"含 token 字样但非凭据"的常见误伤，显式排除。
  if (/^(?:maxTokens|max_tokens|tokenUsage|tokenCount|tokens)$/i.test(key)) return false;
  if (/token(?:s|Usage|Count)$/i.test(key)) return false;
  return SENSITIVE_KEY_PATTERNS.some((re) => re.test(key));
}

/**
 * 把敏感值替换成可辨识但不泄密的形态：保留前 3 位与长度，便于用户确认"是哪把 key"。
 * @param {unknown} value
 * @returns {string}
 */
export function maskValue(value) {
  const s = typeof value === 'string' ? value : String(value ?? '');
  if (!s) return '';
  if (s.length <= 6) return '*'.repeat(s.length);
  return `${s.slice(0, 3)}${'*'.repeat(Math.min(24, s.length - 3))}（${s.length} 字符）`;
}

/**
 * 深度脱敏一份配置对象（不改原对象）。
 * @param {unknown} value
 * @param {string} [keyPath] 内部递归用
 * @returns {unknown}
 */
export function redactConfig(value, keyPath = '') {
  if (Array.isArray(value)) {
    return value.map((v, i) => redactConfig(v, `${keyPath}[${i}]`));
  }
  if (value && typeof value === 'object') {
    const out = {};
    // R0-111/W4：HTTP **头**一律按凭据展示。头里放的常是 Authorization / Cookie / 会话 id
    // （`TUSUNSUN_MODEL_HEADERS='{"x-opencode-session":"…"}'`），而键名本身不像密钥，
    // 靠 isSensitiveKey 的名字匹配抓不到 ⇒ 会明文出现在 `config show` 里。
    const inHeaders = /(^|\.)headers$/.test(keyPath);
    for (const [k, v] of Object.entries(value)) {
      const path = keyPath ? `${keyPath}.${k}` : k;
      // 敏感**对象**（如 model.headers 里塞的 Authorization）逐项递归；敏感**标量**直接遮盖
      if ((isSensitiveKey(k) || inHeaders) && (v === null || typeof v !== 'object')) {
        out[k] = maskValue(v);
      } else {
        out[k] = redactConfig(v, path);
      }
    }
    return out;
  }
  return value;
}

/**
 * 按键路径取值并脱敏（`config get` 用）。
 * @param {unknown} cfg 整份配置
 * @param {string} keyPath 形如 `model.apiKey`
 * @returns {{found: boolean, value: unknown, sensitive: boolean}}
 */
export function redactGet(cfg, keyPath) {
  const parts = String(keyPath || '').split('.').filter(Boolean);
  let obj = cfg;
  for (const p of parts) {
    if (obj === null || obj === undefined) return { found: false, value: undefined, sensitive: false };
    obj = obj[p];
  }
  const leafKey = parts[parts.length - 1] || '';
  // R0-111/W4：`model.headers` 本身（整取自对象）与其中的每一项都按凭据展示。
  const sensitive = isSensitiveKey(leafKey) || /(^|\.)headers$/.test(parts.join('.'));
  if (obj === undefined) return { found: false, value: undefined, sensitive };
  if (!sensitive) return { found: true, value: obj, sensitive };
  const masked = (obj && typeof obj === 'object') ? redactConfig(obj, parts.join('.')) : maskValue(obj);
  return { found: true, value: masked, sensitive };
}
