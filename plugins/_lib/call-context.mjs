// AR-C01 / AR-C02 / AR-C03（v0.10.3）：**每次工具执行的可信调用上下文**。
//
// 这个模块只回答一个问题：**这次执行是哪一次、属于谁**。
// 它存在的原因是 v0.10.2 及以前把两件事寄托在了错误的地方：
//
//   ① 回执的**交付**靠 `tool._lastReceipt` —— 一个挂在工具实例上的共享槽。
//      工具实例是**单例**（`export default new ToolWrite()`），两个会话并发时
//      A 的返回值里可能装着 B 的回执。实测：两个会话各自写成功、各自返回
//      `act-mvjmp6kx-2 / 新建 b.txt` —— 同一个 id、同一个文件，其中一个是谎话。
//      "最近一次"这个语义对**单次调用**是没有意义的。
//
//   ② 回执的**归因**靠 `args._cellId` / `args._taskId` / `args._incarnationId` ——
//      而 `args` 是模型给的 JSON。实测模型自报 `_cellId:'cell-FORGED'` 后，
//      回执里就写着 `cell_id: 'cell-FORGED'`。一个由被测对象自己填写的归因字段，
//      不是证据，是自述。
//
// 为什么用 `AsyncLocalStorage` 而不是对象字段 / 参数传递：
//   · 对象字段：就是现在这个 bug（单例 + 共享槽）。
//   · 参数传递（把 ctx 塞进 args）：args 会被工具透传、被缓存键哈希、被 JSON 序列化；
//     而且模型给的 args 与宿主给的 args 混在同一个命名空间里，正是 ② 的成因。
//   · ALS：跟随**异步调用链**天然隔离，嵌套/并发各自一份；模型给的是 JSON，
//     永远进不了这个通道（JSON 里没有"作用域"这种东西）。
//   本仓 `src/core/core.js:18` 已用同一机制做插件 init 的服务追踪，属于既有做法。
//
// 边界（诚实）：ALS 是**进程内**隔离。它挡的是"并发调用之间串台"，
// 挡不住"同进程内的恶意代码直接读 `als.getStore()`"——进程内 JS 没有安全边界，
// 这一点与 `core.assertIdentity` 的诚实边界同源，不夸大。

import { AsyncLocalStorage } from 'node:async_hooks';

const _als = new AsyncLocalStorage();

/**
 * **任务执行上下文**（rc.31 / K30-01）：独立的一条 ALS，不与上面那条混用。
 *
 * 为什么不塞进 `_als` 同一个 store：`executeOne` 会在工具执行链上再 `run()` 一次，
 * 那个 store 是**一次工具调用**的；把任务票据塞进它，等于每次派发都就地作废一次任务身份。
 * 两条 ALS 各自成栈，内层嵌套不会把外层挤掉 —— 这正是「任务代际」与「调用代际」
 * 需要同时存在的原因：它们回答的不是同一个问题。
 */
const _taskAls = new AsyncLocalStorage();

/**
 * 在**本次调用**的上下文里执行 `fn`。
 *
 * 每次 `executeOne` 建一个新的 ctx 对象：这就是"按调用绑定"的全部实现。
 * 不共享、不复用、不缓存 —— 一旦复用，就又回到 `_lastReceipt` 那个语义。
 *
 * @param {{callId?: string|null, sessionId?: string|null, tool?: string|null}} ctx
 * @param {Function} fn
 */
export function runInCallContext(ctx, fn) {
  return _als.run({
    callId: ctx?.callId ?? null,
    sessionId: ctx?.sessionId ?? null,
    tool: ctx?.tool ?? null,
    // 本次调用的回执槽。**唯一**的写者是被调用的工具，**唯一**的读者是执行器，
    // 而且只在这一次 `run()` 的生命周期内存在。
    receipt: null,
  }, fn);
}

/**
 * 在**某一次任务执行**的上下文里执行 `fn`（rc.31 / K30-01）。
 *
 * 票据由 `cell-runtime.execute()` 在**自己**分配 epoch 之后签发，内容只有它知道：
 * cell / 会话 / incarnation / epoch / task_id / attempt。调用方（执行器）只能读、不能改，
 * 更不能从 `args` 或 `sessionId` 字符串里自报 —— 这是「模型可达参数不得当凭据」那条
 * 既有立场在任务维度上的同一条写法。
 *
 * 为什么必须是 ALS 而不是参数：`sessionId` 在 Cell 生命周期内**不变**，它是身份不是票据。
 * 一个身份无法区分「A 的迟到回调」与「B 正在执行」——同一个字符串、同一个对象。
 * ALS 跟着异步调用链走：在 `chat.handle` 里注册、之后才触发的 `setTimeout` 回调，
 * 拿到的仍是**它被创建时那一次任务**的票据，于是旧任务的迟到调用在派发期能被认出来。
 *
 * @param {{cellId?: string|null, sessionId?: string|null, incarnationId?: string|null,
 *          epoch?: number|null, taskId?: string|null, attempt?: number|null}} ctx
 * @param {Function} fn
 */
export function runInTaskContext(ctx, fn) {
  return _taskAls.run(Object.freeze({
    cellId: ctx?.cellId ?? null,
    sessionId: ctx?.sessionId ?? null,
    incarnationId: ctx?.incarnationId ?? null,
    epoch: Number.isInteger(ctx?.epoch) ? ctx.epoch : null,
    taskId: ctx?.taskId ?? null,
    attempt: Number.isInteger(ctx?.attempt) ? ctx.attempt : null,
  }), fn);
}

/**
 * 当前所在的**任务执行**上下文；不在任何任务链上时返回 `null`。
 *
 * `null` 是一个**结论**（「这次调用不来自任何任务执行」），不是「不知道」：
 * 宿主直接调执行器（没有 `execute()` 包着）就落在这里。派发期必须据此拒绝 ——
 * 「没有任务」不等于「任务随便」，更不等于「沿用上一个任务的授权」。
 */
export function currentTask() {
  return _taskAls.getStore() ?? null;
}

/** 当前调用上下文（不在工具执行链上时返回 null —— 调用方必须自己决定怎么办，不许假设）。 */
export function currentCall() {
  return _als.getStore() ?? null;
}

/**
 * 当前调用的**可信**会话标识。
 *
 * "可信"指它由宿主经 `executeOne(tool, args, sessionId)` 传入，
 * 不是模型在 args 里写的东西。函数显式返回 null 而不是 `undefined`：
 * 调用方拿到的永远是"字符串或 null"两种形态，判据不用再考虑第三种。
 */
export function currentSession() {
  const s = _als.getStore()?.sessionId;
  return s == null || s === '' ? null : String(s);
}

/** 当前调用 id（关联用，不参与任何授权判断）。 */
export function currentCallId() {
  return _als.getStore()?.callId ?? null;
}

/**
 * 工具发布本次调用的回执。
 *
 * 返回 `false` 表示**不在**工具执行链上（例如工具的单元测试直接调 `execute()`）：
 * 此时回执无处可投，工具应当照常返回业务结果，不要把"投不出去"变成执行失败。
 * 这与 v0.9.33 的立场一致——回执是增量证据，不是执行的先决条件。
 */
export function publishReceipt(receipt) {
  const c = _als.getStore();
  if (!c) return false;
  // 同一次调用里后写的覆盖先写的：这是**同一次调用**内部的覆盖，
  // 与"跨调用串台"是两件事，不引入新的错配面。
  c.receipt = receipt ?? null;
  return true;
}

/** 取走本次调用的回执（执行器用；工具不调）。 */
export function takeReceipt() {
  return _als.getStore()?.receipt ?? null;
}
