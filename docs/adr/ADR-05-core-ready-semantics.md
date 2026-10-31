# ADR-05：`core.ready` 在必需插件失败时的语义

- 状态：**已采纳**（v0.12.0，K-03 / K-03b）
- 影响面：`src/core/core.js`（`start` / `_startPlugin` / `_startFailures`）、`plugins/readiness.js`
- 关联：K-03、K-03b、I-04

## 1. 要决定的问题

必需插件（`manifest.degraded_policy === 'block_startup'`）的 `init`/`start` 抛错之后，
`core.ready` 这件事该怎么办？

修前的行为是：`_startPlugin` 捕获异常、置 `state='error'`、**继续**；
`start()` 末尾**无条件** `emitFast('core.ready', { plugins: N })`。

后果不只是"一个布尔值不对"。实测（K-03b）同一进程里：

```
core.ready        已发出，载荷只有 { plugins: 3 }
readiness.status  'unavailable'，criticalFailed: ['crit']
```

**对同一个事实，系统内部有两句互相矛盾的话。**

## 2. 三个候选

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| A | 不发 `core.ready` | 语义最严格（"没就绪就不要说就绪"） | 所有挂在 `core.ready` 上做初始化的插件（`assembly-lock.js:170`、`readiness.js:79`）在失败场景**彻底不执行**，反而更难诊断 |
| B | 照发，但载荷具名 `status` / `requiredFailed` | 保留可观测性；读 `plugins` 的旧消费者不受影响 | `status` 是新增字段，消费者要主动读才拿得到 |
| C | 抛异常/退出进程 | 决断明确 | 把"库"变成"进程"，破坏了 Core 作为可嵌入组件的定位（`admission-gate` 在 production 下才这样做） |

## 3. 决定

**选 B。** `core.ready` 照发，载荷新增两个**加性**字段：

```js
{ plugins: N, status: 'ready' | 'unavailable', requiredFailed: [...], ... }
```

`plugins` 字段语义不变（仍是插件总数），旧消费者零影响。

## 4. 为什么这是"判断"而不是"事实"

必须写下来：原文 §6.2 的措辞是"只有已核验的启动才是 Ready"。**严格读可以解释成方案 A。**
我选 B 的理由是**可诊断性**：

- 失败发生时，人最需要的是"到底哪个插件失败了"的信息；
- 方案 A 会让诊断工具本身也停止工作（它挂在 `core.ready` 上）；
- 而"宣告 ready"这件事本身并没有被含糊掉 —— `status: 'unavailable'` 是明确的。

**这条要请专家裁决。** 如果裁决是 A，改动很小（`start()` 里加一个 `if`），
但 `readiness` / `assembly-lock` 的挂载点要一并改成别的信号。

## 5. 判据（不是"看起来对"）

| 断言 | 位置 |
|---|---|
| 必需插件失败 ⇒ `status==='unavailable'` 且 `requiredFailed` 含其名 | `K-03/1` |
| optional 插件失败 ⇒ `status==='ready'`（不能把可选失败说成不可用） | `K-03/2` |
| `core.ready.status` 与 `readiness.status()` **必须相等** | `K-03b/1` |

变异验证：让 `start()` 不设置 `status` ⇒ `K-03/1` 变红。

## 6. 连带发现：清理不能把证据删掉

`K-03b` 追下去暴露了第二层问题：装配失败的插件会被 `lc.load` 的 catch 调 `unload` 移出
`core.plugins`，于是 `readiness` 扫不到它，只能得出 `ready` —— **清理把证据一起删了**。

第一版我让 `unload` 保留记录，立刻撞坏既有契约（`lifecycle-advanced` 明确断言"失败插件应被卸载"）。
最终方案：`unload` 行为不变，Core 另存只读的 `_startFailures`，`readiness` 并入聚合。

这条的教训与 ADR-04 同源：**只读视图必须能从权威事实现算出来，而权威事实不能因为清理而消失。**
