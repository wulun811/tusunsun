// 配置点路径的**唯一**写入判据（`tusunsun config set` 与内核 config 插件共用）。
//
// 为什么必须是一份：两个入口各写一次 `parts.reduce((o,p)=>o[p], …)`，就会各错一次。
// 修前它们都直接 `obj[part] = …` 逐段赋值，于是：
//
//     tusunsun config set __proto__.polluted YES
//     → exit 0、"Set __proto__.polluted = YES"、配置里什么都没有
//
// 三件事同时发生：① `Object.prototype` 被写；② `JSON.stringify` 不序列化原型，所以
// 文件里看不到；③ 读回校验走的是同一条原型链，读得到值 ⇒ 校验通过。三者合起来
// 让"写成功了"与"写进去了"彻底脱钩。
//
// 判据取**白名单字符 + 保留段拒绝**，而不是黑名单 `__proto__`：`constructor.prototype`
// 这类变体、以及 `%5F` 之类的编码变体，黑名单永远列不全。
//
// 诚实边界：这只防"经配置写入污染原型"，不是通用的对象合并加固。别处若另有
// 按用户输入做深合并的代码，需要各自把自己那一处管住。

/** 合法段：字母数字下划线连字符，且不能以数字开头（否则无法与数组下标区分）。 */
const SEGMENT_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * 这些段即使形态合法也不能作为**写入**目标：它们是原型链上的入口，
 * 写它们改的不是配置，是进程里所有对象。
 */
const RESERVED_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * 校验一条点路径是否可作为配置写入目标。
 * @param {unknown} path 例如 `model.apiKey`
 * @returns {{ok:true, parts:string[]} | {ok:false, reason:string}}
 */
export function checkConfigPath(path) {
  if (typeof path !== 'string' || path.trim() === '') {
    return { ok: false, reason: 'path 必须是非空字符串' };
  }
  const parts = path.split('.');
  for (const part of parts) {
    if (part === '') {
      return { ok: false, reason: `path "${path}" 里有空段（连续的 "." 或多出的 "."）` };
    }
    if (!SEGMENT_RE.test(part)) {
      return { ok: false, reason: `path "${path}" 的段 "${part}" 含非法字符（只允许字母、数字、_ 与 -，且不能以数字开头）` };
    }
    if (RESERVED_SEGMENTS.has(part)) {
      return {
        ok: false,
        reason: `path "${path}" 里的 "${part}" 是原型链保留段：写它会改到进程里所有对象，而不是配置项`,
      };
    }
  }
  return { ok: true, parts };
}

/**
 * 按已验证的段写入 `obj`。**只接受 `checkConfigPath` 的返回值**，不复做校验 ——
 * 两处各校验一次就会出现"调用方用了没校验的那一条"这种半修。
 *
 * 中间段只认**自有属性**（`Object.hasOwn`），不认原型链：即使某个原型上恰好有同名
 * 属性，也新建一个自有对象覆盖它，而不是顺着原型写进去。
 */
export function assignConfigPath(obj, parts, value) {
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (!Object.hasOwn(cur, key) || cur[key] === null || typeof cur[key] !== 'object') {
      cur[key] = {};
    }
    cur = cur[key];
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
}

/** 按已验证的段取值（同样只认自有属性；缺失返回 `undefined`）。 */
export function readConfigPath(obj, parts) {
  let cur = obj;
  for (const key of parts) {
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, key)) return undefined;
    cur = cur[key];
  }
  return cur;
}
