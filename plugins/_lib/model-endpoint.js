// R0-114（二次评审 P1-01）：**模型端点是否免 key** 的唯一判据。
//
// 事实（修前 0.9.6，实测）：`model.baseUrl=http://127.0.0.1:<port>/v1`、`model.apiKey=null`
// 时 ——
//   · 网关 `GET /ready` → `200 {"ready":true,"status":"ok"}`（`_modelReady()` 给回环端点开了免 key 豁免）；
//   · 同一个进程 `POST /v1/chat/completions` → `502 model_error` "未配置模型 Key"
//     （`model-openai.js` 的 `call()` / `callWithConfig()` / `streamChatWithConfig()`
//     三处都先 `if (!apiKey) return 错误`）。
// 两条路径对"什么算可用模型"的判断不一致 ⇒ **假绿比红灯更贵**：接负载均衡的部署不会摘流量，
// 用户看到"就绪"却每次对话都失败。
//
// 现在两边共用本文件的判据，且**真的**支持免 key 的本地点：
//   · 端点落在回环（`127.*` / `::1` / `localhost`）且没有配置 key ⇒ 调用时代码不附
//     `Authorization` 头（ollama / llama.cpp / vLLM 的默认形态）；
//   · 非回环端点没有 key ⇒ ready=false（503）+ 对话如实失败，不含糊。
// 判据放在本文件是刻意的：同一份语义只允许有一个实现，否则"半改"会再次发生。
//
// 边界：`localhost` 交给系统解析（不出网卡）；这不是"信任任意局域网端点"——
// 非回环端点永远要求 key，豁免范围就是回环。

/** 回环地址判据（`host` 可以是 hostname 或裸地址）。 */
export function isLoopbackHost(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1' || h.startsWith('127.');
}

/**
 * 该端点是否允许**不带 key** 调用。
 * @param {unknown} baseUrl `model.baseUrl`（可含路径）；非法 URL 一律 false（按"不可用"处理）
 * @param {unknown} apiKey 已配置的 key（有 key 时无所谓）
 */
export function isKeylessEndpoint(baseUrl, apiKey) {
  if (apiKey) return false;
  try {
    return isLoopbackHost(new URL(String(baseUrl)).hostname);
  } catch {
    return false;
  }
}

/**
 * 构造发往模型端点的鉴权头。免 key 的本地点**不附**无意义的 `Authorization: Bearer undefined`
 * （部分本地服务见到无效头反而 401，把"没 key 也能用"变成"怎么配都不对"）。
 * @returns {Record<string,string>}
 */
export function modelAuthHeaders(apiKey, baseUrl) {
  if (apiKey) return { Authorization: `Bearer ${apiKey}` };
  if (isKeylessEndpoint(baseUrl, apiKey)) return {};
  return { Authorization: `Bearer ${apiKey}` };
}
