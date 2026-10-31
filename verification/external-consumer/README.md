# 外部消费者验收（external consumer）

外部消费者验收要求：**在脱离土行孙源码树的空目录里，用发布 tarball 启动一个 Cell / 工具
任务，验证正常执行、权限拒绝、失败恢复和重启，并保留回执。** 这个目录就是那件事的可复跑形态。

```
bash verification/external-consumer/run.sh <path/to/tusunsun-0.20.0.tgz>
```

## 它到底做了什么

1. `mktemp -d` 造一个空目录，写一个只有 `{name,private,type}` 的 `package.json`；
2. `npm install --offline --ignore-scripts <tgz>` —— 装的是**发布制品本身**，不碰源码树；
3. 把 `consumer.mjs` 复制进去，用**裸包名** `tusunsun/src/core/core.js` 这类路径导入（能这样写，
   正是因为包没有 `exports` 收口，消费者可以按文件用）；
4. 阶段一（进程 A）：`正常执行` → `权限拒绝` → `失败恢复` → `关闭`；
5. 阶段二（**进程 B**，同一个 `stateDir`）：`重启读回`（已关闭的 Cell 仍是 `stopped`）→ `照常执行`。

## 为什么分两个进程

同一个进程里再 `new Core()` 不算重启 —— 那只是又调了一次函数。阶段二是一个新的 Node 进程，
重新打开 `base/state`，读回的是磁盘上的 `cell.json`，不是内存里的对象。

## 六步各自的判据

| 步骤 | 判据 |
| --- | --- |
| 1 正常执行 | `execution_state === 'succeeded'`，工具真的被调用一次，`echo.txt` 真的落盘 |
| 2 权限拒绝 | 未授权任何工具的 Cell 调工具 → `code === 'capability_denied'`，工具调用数**不变**，磁盘无写入 |
| 3 失败恢复 | 注入一次 handler 抛错 → 该任务不是 `succeeded`；同一个 Cell 的下一个任务必须 `succeeded` |
| 4 关闭 | `closed === true` 且 `cleanup_done === true`（`cleanup_pending` 空） |
| 5 重启读回 | 新进程 `describe('c1').state === 'stopped'`，且 `list()` 里仍有它 |
| 6 重启后执行 | 新建 Cell 跑任务 `succeeded`，并能正常 `close()` |

## 边界（不声称）

- 不连模型、不读 `.env`：`chat.handle` 是消费者自己注册的能力。这验的是**安装与执行链**，
  不是模型质量。
- 不是独立第三方验收：脚本与制品同源。它把「装上能用」从声明变成可复跑，**不替代**外部评审。
- `npm install` 用的是本机 npm 与本地 tarball；离线标志保证不访问网络，但不证明 `npm publish`
  之后的 registry 元数据行为。
- 回执里没有任何密钥、路径以外的机器信息。
