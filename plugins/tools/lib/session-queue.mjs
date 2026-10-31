// 按会话串行化的执行队列（R0-123）。
//
// 为什么需要：JS 是单线程，但**一个会话的轮次**里有大量 await（读历史 → 调模型 → 执行工具 →
// 写历史）。两个请求落在同一会话上时，它们会各自读到同一份历史、各自推进，后写的把先写的
// 覆盖掉 —— 实测：先发的那一轮从历史里整段消失。
//
// 语义约定：
//   · 同一个 key 上的任务**严格串行**，且按提交顺序执行；
//   · 不同 key 之间互不阻塞（不是一个全局锁）；
//   · 前一个任务抛错**不会**卡死队列（错误原样抛给它的调用方，下一个照常跑）。
//
// 它不负责限流/超时：那属于上层（`haotian-lite` 有全局并发闸门，网关有令牌桶）。
// 这里只解决"同一会话的两件事不许交错"这一个问题。
export function createSessionQueue() {
  /** key → 队尾 Promise（该 key 上最后一个任务结束后 resolve） */
  const tails = new Map();

  const norm = (key) => String(key ?? '__default__');

  return {
    /**
     * 在 key 的队列里执行 fn。返回 fn 的结果（异常原样抛出）。
     * @template T
     * @param {string} key 会话标识
     * @param {() => Promise<T>} fn
     * @returns {Promise<T>}
     */
    async run(key, fn) {
      const k = norm(key);
      const prev = tails.get(k) || Promise.resolve();

      let release;
      const gate = new Promise((r) => { release = r; });
      const tail = prev.then(() => gate);
      tails.set(k, tail);

      // 前一个任务失败不该阻塞后一个：等它"结束"，不等它"成功"
      try { await prev; } catch { /* 上一个失败，与本次无关 */ }

      try {
        return await fn();
      } finally {
        release();
        if (tails.get(k) === tail) tails.delete(k);   // 队列空了就出表，别让 Map 长住
      }
    },

    /** 等该 key 上已排队的任务全部结束（用于"读之前先等写落盘"）。 */
    pending(key) {
      const t = tails.get(norm(key));
      return t ? t.catch(() => {}) : Promise.resolve();
    },

    /** 当前有排队/在跑的会话数（观测用）。 */
    size() { return tails.size; },
  };
}

export default createSessionQueue;
