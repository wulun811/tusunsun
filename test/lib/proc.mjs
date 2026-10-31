// R0-115：测试子进程**归属**管理 —— 不让测试把孤儿进程留在机器上。
//
// ── 事故 ────────────────────────────────────────────────────────────────
// 一次 `npm test` 之后机器被 OOM：残留 **76 个 dsh-subprocess-*.scope** 与
// **大量外接引擎 Python 进程**（合计数 GB 内存），16G 内存 + 4G swap 全满，
// 最后连本体会话都被内核杀掉。这不是"偶发慢"，是**每次跑测试都在造孤儿**。
//
// ── 根因（两条，缺一都不够）──────────────────────────────────────────────
// ① 测试起网关用的都是 `child.kill('SIGKILL')`：SIGKILL 不可捕获，网关里的
//    `core.stop()` / 插件的 `_reap()` 一行都跑不到，于是网关 spawn 的 python 引擎
//    被 PID 1 收养、永远 `serve_forever()`。每个会起网关的用例都留一个。
// ② 子进程与测试进程**同组**：测试进程自己被杀（OOM kill / 超时 / 整个 scope 被
//    `systemd-run` 收掉）时，没有任何人有机会去杀它们 —— 组里没人负责收尸。
//
// ── 做法 ────────────────────────────────────────────────────────────────
// · **每个子进程独立进程组**（`detached: true` ⇒ setsid）：它不会被误当作"测试进程
//   的一部分"随组信号一起消失，测完还能**整组**回收（含它自己再 spawn 的孙进程）。
// · **统一登记 + 统一回收**：本模块持有全部子进程；`reapAll()` 先 SIGTERM（给插件的
//   `_reap()` 一次正常收尾机会），宽限后对**整个进程组** SIGKILL（`kill(-pgid)`），
//   连孙进程一起带走。同步版 `reapAllSync()` 供 `process.on('exit')` 用。
// · **退出兜底**：`installReapOnExit()` 挂到 `exit` / `SIGTERM` / `SIGINT` / `SIGHUP` /
//   `uncaughtException`，即使用例自己忘了 stop，进程退出时也会收干净。
// · **身份复核**：回收前比对 `/proc/<pid>/stat` 的 starttime，防止 PID 复用误杀
//   （与插件侧 `_reap()` 同一判据）。
//
// ── R0-118：第四轮评审 P1-03 修的就是下面这两条判据 ──────────────────────
// 旧实现只看**组长**（`child.exitCode !== null` 即判"已回收"），于是：
//   ① 组长收到 SIGTERM 先退，孙进程忽略 SIGTERM 继续跑 ⇒ `reap()` 返回"成功"，
//      而机器上真有一个活着的孤儿（评审实测：孙进程 `/proc` 状态仍是 S）；
//   ② 判"是否还活着"用 `process.kill(pid, 0)`，**僵尸（Z）也算活着** ⇒ 明明已经
//      收干净了却报失败（评审实测的 W4 假阴性）。
// 现在：`isProcessRunning()` 明确区分 Z/X 与 S/R/D；回收判据 = 组长没了 **且**
// 该进程组里再没有 S/R/D 的成员；宽限后仍有人就整组补发 SIGKILL；还活着的会
// 被**点名**回报（`survivors`），不再用一句 ok 盖过去。
//
// ── 边界（诚实记录）──────────────────────────────────────────────────────
// 本模块只能管到"还活着的、由本进程 spawn 的"子进程。下列情形它无能为力，必须靠
// 引擎侧的**父进程看门狗**（外接引擎的 `--parent-pid`）：
//   · 测试进程被 SIGKILL / OOM kill（本模块的 exit 钩子同样不会执行）；
//   · `machine` 掉电或整机崩溃。
// 也就是说：单靠"测试记得清理"是不够的，这次必须**两侧都修**才闭环。
//
// 另外三条**明确不做**的事（宁可在文档里写清楚，也不假装能做到）：
//   · **Windows**：没有进程组信号，只能 kill 组长；孙进程交给引擎看门狗。本模块在
//     win32 上 `liveGroupMembers()` 恒返回空 —— 也就是"整组回收"在 Windows 上是**未覆盖**，
//     不能宣称成立。
//   · **macOS**：没有 `/proc`，`isProcessRunning()` 恒为 false，僵尸/整组判活同样**未覆盖**；
//     相关用例在非 Linux 上记 SKIP，不折算为通过。
//   · **`setsid`/`nohup` 脱离进程组的后代**：pgid 变了，本模块按 pgid 找不到它。
//   · **pgid 复用**：整组消失后 pgid 理论上可被新进程组复用。为了把风险压到可忽略，
//     我们**只在组内确实有存活成员时**才发组信号（`liveGroupMembers().length > 0`），
//     且组信号的窗口不超过 grace+1.5s；组已经空了的条目**绝不再按 pgid 发信号**。
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

const HAS_PROC = existsSync('/proc/self/stat');

/** 登记表：pid → { child, pgid, label, startTicks } —— 模块级，跨用例共享。 */
const registry = new Set();
let exitHookInstalled = false;

/**
 * 读 `/proc/<pid>/stat` 的关键字段。返回 null 表示进程不存在（或读不到）。
 * stat 的格式是 `pid (comm) state ppid pgrp ... starttime ...`，comm 里可能有空格和括号，
 * 所以必须从**最后一个** `)` 之后开始切（老实现已经这么做，别改回去）。
 */
function readStat(pid) {
  if (!HAS_PROC || !pid) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    return {
      state: rest[0],
      ppid: Number(rest[1]),
      pgrp: Number(rest[2]),
      startTicks: Number(rest[19]),
    };
  } catch {
    return null;
  }
}

/** 僵尸 / 已死都不算"在运行"。这正是评审 P1-03 的第 1 条：Z 曾被当成活着。 */
const isLive = (st) => !!st && st.state !== 'Z' && st.state !== 'X' && st.state !== 'x';

/**
 * 某个 pid **此刻是否真的在运行**：必须存在、状态不是 Z/X、且（可选）starttime 一致。
 * 门禁与用例都该用这个而不是 `process.kill(pid, 0)` —— 后者对僵尸返回 true。
 */
export function isProcessRunning(pid, expectedStartTicks = null) {
  const st = readStat(pid);
  if (!isLive(st)) return false;
  if (expectedStartTicks !== null && st.startTicks !== expectedStartTicks) return false;
  return true;
}

/** 组长是否还活着（pid + starttime 双判据，防 PID 复用误杀）。 */
function stillOurs(entry) {
  const { child, pid, startTicks } = entry;
  if (!pid) return false;
  if (child.exitCode !== null || child.signalCode !== null) return false;
  if (!HAS_PROC) return true;                       // 无 /proc：只能信 ChildProcess 引用
  const st = readStat(pid);
  if (!isLive(st)) return false;                    // 僵尸不算活
  return startTicks === null || st.startTicks === startTicks;
}

/**
 * 该条目**进程组里还有没有在运行的成员**（含组长自己）。
 *
 * 判据只用 pgid：进程组不会"被加入"，只有 fork 时才继承 ⇒ 组里出现 pid 就是我们的后代。
 * Windows 没有 pgid 概念，恒返回空（整组回收在 Windows 上未覆盖，见文件头边界）。
 */
function liveGroupMembers(entry) {
  if (process.platform === 'win32') return [];
  if (!HAS_PROC || !entry.pgid || entry.pgid <= 1) return [];
  const out = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    const st = readStat(pid);
    if (!st || !isLive(st)) continue;               // 僵尸不算
    if (st.pgrp !== entry.pgid) continue;
    out.push({ pid, state: st.state });
  }
  return out;
}

/** 该条目彻底干净了吗：组长没了 **且** 组里没有存活成员。 */
function isClean(entry) {
  // 组长还活着时不必扫 /proc：一定没干净。省掉宽限期内每 50ms 一次的全表扫描。
  if (stillOurs(entry)) return false;
  return liveGroupMembers(entry).length === 0;
}

/** 给**整个进程组**发信号。pgid 与 pid 相同（detached spawn 的 setsid 语义）。 */
function signalGroup(entry, sig) {
  const { pgid, pid } = entry;
  if (process.platform === 'win32') {
    // Windows 没有进程组信号：退回单进程 kill（引擎看门狗仍是最终兜底）。
    try { return entry.child.kill(sig); } catch { return false; }
  }
  // 组里既有存活成员、又要发组信号时才发 —— 组已空就绝不再碰这个 pgid（复用风险）。
  const members = liveGroupMembers(entry);
  if (!members.length && !stillOurs(entry)) return true;   // 已经干净，无需发信号
  try {
    process.kill(-pgid, sig);
    return true;
  } catch {
    // 组可能已空（ESRCH）；退一步只打组长，避免"组没了就当成功"掩盖真问题。
    try { return entry.child.kill(sig); } catch { return false; }
  }
}

/** 轮询等到"彻底干净"，超时返回 false。 */
async function waitClean(entry, budgetMs, intervalMs = 50) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (isClean(entry)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * 受管 spawn：与 `child_process.spawn` 同签名，但
 *   · 默认 `detached: true`（独立进程组）+ `stdio` 保留调用方设置；
 *   · 自动登记进本模块的回收表；
 *   · 返回的 child 上多一个 `reap()`（只回收这一棵）。
 * @returns {import('node:child_process').ChildProcess}
 */
export function spawnManaged(cmd, args = [], options = {}) {
  installReapOnExit();
  const detached = options.detached !== false;      // 默认独立组
  const child = spawn(cmd, args, { ...options, detached });
  const entry = {
    child,
    pid: child.pid ?? null,
    pgid: child.pid ?? null,
    label: options.label || [cmd, ...args].join(' ').slice(0, 120),
    startTicks: readStat(child.pid)?.startTicks ?? null,
  };
  if (entry.pid) registry.add(entry);
  // R0-118：**不要**在组长 exit 时立刻出表 —— 孙进程可能还活着，出表就等于放弃回收。
  // 这里只在"整组都干净"时被动出表；否则留给 reapAll()/reap() 处理。
  child.once('exit', () => { if (isClean(entry)) registry.delete(entry); });
  // 约定与 reapAll() 一致：返回**未回收清单**（空数组 = 已干净），调用方读法统一。
  child.reap = async (opts) => {
    const r = await reapEntry(entry, opts);
    return r.ok ? [] : [r];
  };
  // 便于上游用例区分"真的收干净"与"组长没了但孙进程还活着"。
  child.reapDetail = async (opts) => reapEntry(entry, opts);
  return child;
}

/**
 * 回收一个已登记条目：SIGTERM → 宽限 → 整组 SIGKILL → 再核对。
 * 判据是**整组**干净，不只是组长退出（R0-118 / 评审 P1-03）。
 */
async function reapEntry(entry, { graceMs = 1500, killWaitMs = 1500 } = {}) {
  if (isClean(entry)) { registry.delete(entry); return { ok: true, how: 'gone' }; }
  signalGroup(entry, 'SIGTERM');
  if (await waitClean(entry, graceMs)) { registry.delete(entry); return { ok: true, how: 'SIGTERM' }; }
  // 宽限到了还有活人（典型：孙进程忽略 SIGTERM）⇒ 整组补 SIGKILL，别再只看组长。
  signalGroup(entry, 'SIGKILL');
  if (await waitClean(entry, killWaitMs)) { registry.delete(entry); return { ok: true, how: 'SIGKILL' }; }
  const survivors = liveGroupMembers(entry).map((m) => m.pid);
  registry.delete(entry);
  return {
    ok: false,
    how: 'unreaped',
    pid: entry.pid,
    pgid: entry.pgid,
    label: entry.label,
    survivors,                                      // 点名：谁还活着，别用一句 ok 盖过去
    leaderAlive: stillOurs(entry),
  };
}

/** 回收**全部**已登记子进程（异步；给插件收尾机会）。返回未回收清单（空=全清）。 */
export async function reapAll(options = {}) {
  const entries = [...registry];
  const results = await Promise.all(entries.map((e) => reapEntry(e, options)));
  return results.filter((r) => !r.ok);
}

/**
 * 回收全部（**同步**版）：给 `process.on('exit')` 用 —— 那里不能 await。
 * 不等待、只发信号：先 SIGTERM 整组，短暂忙等落盘后 SIGKILL 整组。
 * R0-118：判据同样升级为"整组干净"，并且**组不为空就补 SIGKILL**。
 */
export function reapAllSync() {
  for (const entry of [...registry]) {
    if (isClean(entry)) { registry.delete(entry); continue; }
    signalGroup(entry, 'SIGTERM');
  }
  if (registry.size === 0) return;
  const until = Date.now() + 400;
  while (Date.now() < until) {
    for (const entry of [...registry]) if (isClean(entry)) registry.delete(entry);
    if (registry.size === 0) return;
  }
  for (const entry of [...registry]) {
    signalGroup(entry, 'SIGKILL');
    registry.delete(entry);
  }
}

/**
 * 装退出兜底（幂等）。`exit` 用同步回收；信号先回收再按原信号自杀，
 * 保证"测试跑手被杀"时也不会把子进程留成孤儿。
 */
export function installReapOnExit() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => { try { reapAllSync(); } catch { /* 退出路径不再抛 */ } });
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.once(sig, () => {
      try { reapAllSync(); } catch { /* 尽力而为 */ }
      process.exit(128 + (sig === 'SIGINT' ? 2 : sig === 'SIGTERM' ? 15 : 1));
    });
  }
  // R0-116（自查发现，R0-115 引入的真缺陷）：**装了 `uncaughtException` 监听器就等于接管了
  // Node 的默认行为** —— 默认"打印堆栈并非零退出"被替换成"我的回调"，而回调里只回收子进程、
  // 既不打印也不退出。于是"用例文件 `setup()` 抛错"被静默吞掉：进程因事件环排空而以 **exit 0**
  // 结束，报告里一个用例都没有，CI 却是绿的。这正是本项目反复被点名的"门禁存在但从不执行"。
  // 现在：仍然先回收（防止留孤儿），然后**必须自己把失败吼出来并非零退出**。
  process.once('uncaughtException', (err) => {
    try { reapAllSync(); } catch { /* 退出路径不再抛 */ }
    console.error('[proc] 未捕获异常（已回收子进程，按失败退出）：'
      + ((err && err.stack) || String(err)));
    process.exit(1);
  });
  // 未处理的 Promise 拒绝同理：Node 默认会升级成 uncaughtException，而上面那个监听器会接管它。
  process.on('unhandledRejection', (reason) => {
    try { reapAllSync(); } catch { /* 退出路径不再抛 */ }
    console.error('[proc] 未处理的 Promise 拒绝（已回收子进程，按失败退出）：'
      + ((reason && reason.stack) || String(reason)));
    process.exit(1);
  });
}

/** 当前登记在册的子进程数（门禁用：证明"跑完没有遗留"）。 */
export function managedCount() {
  return registry.size;
}

/** 某个条目的诊断快照（门禁用：把"还活着谁"打印出来，而不是只给个布尔）。 */
export function describeEntry(pid) {
  for (const entry of registry) {
    if (entry.pid !== pid) continue;
    return {
      pid: entry.pid,
      pgid: entry.pgid,
      label: entry.label,
      leaderAlive: stillOurs(entry),
      groupMembers: liveGroupMembers(entry),
      clean: isClean(entry),
    };
  }
  return null;
}

/**
 * 清点**全机**上属于本仓的外接引擎进程（门禁用，跨文件/跨进程都看得见）。
 *
 * 判据是 cmdline 里出现外接引擎脚本且带 `--socket`：这正是适配层的 spawn 形态。
 * 不用 `ps` 文本匹配之外的花招——门禁要能被人工复核。
 * @param {{socketPrefix?: string}} [opts] 限定某个 socket 路径前缀（用例私有租约）
 * @returns {number[]} pid 列表
 */
export function findStrayExternalEngines(opts = {}) {
  if (process.platform === 'win32') return [];       // wmic/tasklist 解析差异大，Windows 不做断言
  const out = [];
  let raw = '';
  try {
    const r = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 10000 });
    raw = r.stdout || '';
  } catch { return []; }
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const argv = m[2];
    if (pid === process.pid) continue;
    if (!/python3?\s+\S*(?:external[-_]?engine)\S*/i.test(argv)) continue;
    if (!/--socket\s+\S+/.test(argv)) continue;       // 排除测试自身的 `-c import` 探测
    if (opts.socketPrefix && !argv.includes(`--socket ${opts.socketPrefix}`)) continue;
    out.push(pid);
  }
  return out;
}

/** 轮询等待某条件成立（门禁/清理共用，避免各处重复写 sleep 循环）。 */
export async function waitUntil(fn, { timeoutMs = 15000, intervalMs = 100, what = '条件' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待${what}超时（${timeoutMs}ms）`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** 轮询等待某条件**消失**（= 等到空），用于"N 秒内必须清零"。 */
export async function waitGone(fn, { timeoutMs = 15000, intervalMs = 100, what = '进程' } = {}) {
  try {
    await waitUntil(async () => (await fn()) === 0, { timeoutMs, intervalMs, what: `${what}清零` });
    return true;
  } catch {
    return false;
  }
}
