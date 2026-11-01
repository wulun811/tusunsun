# Cell 接入指南（外部集成方照着做）

> 面向**在自己的项目里用土行孙跑 Cell** 的集成方。这里只写"你会撞到什么、正确写法是什么"，
> 不重复 README 的概念介绍。每条都来自本仓库自己的实测（含一次性能基准里连撞 7 次）。

## 0. 三十秒版

```js
// 1 Cell : 1 Core : 1 进程 —— 这是硬约束，不是建议
const core = new Core({ stateDir });            // 一个进程只建一个
await workspace.init(core);                     // 工具要有工作目录
await toolExecutor.init(core);                  // 要跑工具就必须装（纯对话可不装）
await cellRuntime.init(core);

const svc = core.getService('cell-runtime');
await svc.create(spec, { trusted: true });      // ← 少了 trusted 会被拒
svc.accept('c1', task);                         // ← 任务要自己声明 required_capabilities
await svc.execute('c1');
await svc.close('c1');
```

## 1. 五道门，按顺序拦你

集成时最容易发生的不是"跑出错结果"，而是**被某一道具名拒绝，然后以为产品坏了**。
五道门依次是：

| # | 判据 | 拒绝码 | 什么时候触发 |
| --- | --- | --- | --- |
| 1 | 你受不受信 | `workspace_not_allowed` | `create(spec)` 没传 `{ trusted: true }` |
| 2 | 三集合有没有交集 | `capability_denied` | Task 没声明 `required_capabilities` |
| 3 | 当前有没有任务在跑 | `task_scope_required` / `task_not_active` | 任务外派发工具 |
| 4 | 门的钩子放不放行 | `capability_denied` / `permission_denied` | 能力没授权 / 只读模式调写工具 |
| 5 | 限额 | `status:'blocked'` | 同（会话, 工具）超 30 次/60 秒 |

### 1.1 `create` 必须 `trusted: true`

```js
await svc.create(spec, { trusted: true });     // 宿主自己调用 ⇒ 受信
```

`trusted` 必须**由宿主传入**，不能写死成 `true`——否则 `workspaces.policy` 的目录白名单对
Cell 形同虚设。远端/不可信来源**不要**传 `true`。

### 1.2 能力是 `Task ∩ Host ∩ Cell`，三个都要有

```js
// ✅ 正确：Cell 声明能力，Task 也声明要哪些
const spec = { capabilities: ['tool.read'], ... };
const task = { required_capabilities: ['tool.read'], ... };

// ❌ 常见误写：只写 Cell 一侧
const task = { required_capabilities: [], ... };   // → effective: (none)
```

拒绝理由会写明 `effective: (none)`——**看到这个就是三集合里至少缺了两边**，不是权限系统坏了。

### 1.3 工具必须在**正在执行的任务**里派发

```js
// ✅ 在 chat.handle 里派发：此时任务真在跑，票据在 ALS 上下文里
core.registerCapability('chat.handle', {
  handler: async () => {
    const r = await exec.executeOne('tool-read', { path: 'a.txt' }, 'cell-c1');
    return { reply: 'ok' };
  },
});

// ❌ 任务外直接打
await exec.executeOne('tool-read', { path: 'a.txt' }, 'cell-c1');
// → task_scope_required: Cell 身份不是任务票据
```

**Cell 身份 ≠ 任务票据。** 这是 K30 的修复：没有活跃任务就没有可继承的授权，
拿 `cell_id` 当通行证会被拒。

### 1.4 只读能力有 30 秒结果缓存

同一 `(工具, 参数)` 在 30 秒内重复调用**不会**再次执行 handler，直接返回上次结果。
写/删/改类工具**不缓存**（重复执行才是正确语义）。

如果你的集成拿"handler 跑了几次"做断言，会被这个特性迷惑——先确认是不是缓存命中。

### 1.5 限流是硬默认：30 次 / 60 秒

按**（会话, 工具）**分桶，超出返回：

```js
{ tool: 'tool-read', error: 'Rate limit exceeded for tool-read', status: 'blocked' }
```

调整方式（宿主配置，不是模型可改的）。**写在 `<stateDir>/config.json`，不是工作目录里的文件**
（`Core.configPath` 默认就是 `${stateDir}/config.json`；写错位置会返回 `undefined` 并静默回落到 30）：

```json
{
  "tools": { "rateLimit": { "maxCalls": 1000, "windowMs": 60000 } }
}
```

实测核对：写对位置后 200 次调用零拦截；写错位置 `core.get` 返回 `undefined`、50 次就被拦 20 次。
单 Cell 大量调用同一工具时这是**第一个会撞的墙**，建议在应用层分批或直接调高。

## 2. `close()` 的三种答案（rc.36 起唯一）

`close()` 回执里 `closed` 与 `cleanup_done` **同源**——只有一个为真时才为真：

| 观察 | 含义 | 你要做什么 |
| --- | --- | --- |
| `closed:true, cleanup_done:true, already:false` | 你这次关完了 | 可以释放你的资源 |
| `closed:true, cleanup_done:true, already:true` | 别人（或上一次）已经关完 | 同样可以释放，别重复做事 |
| `closed:false, closing:true, cleanup_pending:[...]` | 执行资格已撤销，但清理没做完 | **不要**当成已关闭；稍后重试 `close()` |

**并发 `close()` 是安全的**：同一个 Cell 的结算单飞，无论你并发调几次，
`cell.closed` 事件只发一次，其余回执是 `already:true`。

事件与回执都带 `close_id` / `incarnation_id` / `closed_at`，可用作幂等键：

```js
core.on('cell.closed', (e) => {
  if (seen.has(e.close_id)) return;      // 跨进程重放也安全
  seen.add(e.close_id);
  // ...
});
```

### 什么时候必须 `force`

| 情况 | 行为 |
| --- | --- |
| Cell 有任务在跑 | 非 force 抛 `cell_busy`（**不会**排队等你） |
| 任务正在准备（冻结/派遣中） | 同上，`cell_busy` |
| `close(force: true)` | 立刻撤销执行资格；但旧链没静默前仍回 `closing:true` |

`force` **不会**让清理变成"瞬间完成"：它会等你设置的 `quiesceMs`（默认 5000）。
不静默就不拆门、不放锁、不发 `cell.closed`——这是安全边界，不是慢。

## 3. 进程与重启

- **1 Cell : 1 Core : 1 进程**：同一 Core 里建第二个 Cell 直接 `cell_quota_exceeded`。
  要两个 Cell 就起两个进程（见 `examples/cells/dual-cell.mjs`）。
- **重启是读盘收敛，不是内存残留**：同一 `stateDir` 上重建同一 `cell_id`，
  会读回上一世状态（`stopped` 仍是 `stopped`；`busy`/`draining` 收敛为 `faulted` + `unknown`）。
  新建 `stateDir` 只会是 `ready`——两者可区分，可用来验证"我真的在读盘"。
- **一个 `cell_id` 绑定一个工作目录**：换目录会被 `cell_identity_conflict` 拒绝，
  本版没有迁移 API。要换目录就换 `cell_id`。
- **`owner.lock` 是进程级独占**：进程被强杀时锁会留下（原因写在锁文件里）。
  重启时按主机+pid 活性判断能否接管；同主机上 pid 复用需要人工确认。

## 4. 一条能跑通的验收脚本

`verification/external-consumer/` 是这个指南的可执行版本：空目录离线装 tarball、
裸包名装配、四个独立进程覆盖正常执行 / 权限拒绝 / 失败恢复 / 重启 / 关闭。
想知道"正确用法长什么样"时，直接读它，比读本文件快。

```bash
bash verification/external-consumer/run.sh tusunsun-0.20.2.tgz
```

## 5. 性能参考（本机同机对比，不是 SLA）

| 路径 | p50 |
| --- | --- |
| Core 能力直调（无 Cell 门） | 0.002 ms |
| 受门保护的派发（handler 近空） | 0.245 ms |
| 同上 + 真读 4KB + sha256 | 0.354 ms |
| `close()` | 0.68 ms |
| Cell 全生命周期 | 3.5 ms |

门的开销约 0.25 ms，是能力直调的 100 倍以上——**这是 250 微秒，不是"几乎免费"**。
完整数据与量法见 `verification/perf/`。

## 6. 本指南不覆盖

- 真实模型的长期运行、多 Agent 协作、跨主机分布式
- OS 级隔离（这是**信任边界**不是沙箱，同用户下的本地攻击者不在防护范围内）
- Windows / macOS 实测（Linux 是唯一实测平台）
