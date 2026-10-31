# 接入指南 — 把 LiuHe Lite 接进土行孙 Cell

面向：土行孙执行团队。目标：**一次接线，拿到可核验的文件动作回执 + 有限 Undo**，不需要我们的代码索引、Rust parser 或 SQLite。

---

## 0. 这个包是什么（以及不是什么）

| 是 | 不是 |
|---|---|
| 零运行时依赖的小包：6 个动作 + `tusunsun.action-receipt/v0` 回执 | 不是代码理解工具（不解析符号、不跑测试、不建索引） |
| 写路径复用六合每天在跑的原子写 / 事务日记 / Undo / 路径守卫 | 不是第二套事务引擎（没有另一套状态机） |
| 单文件、单工作区、UTF-8 文本 | 不是跨文件事务（要跨文件请用六合 `edit_transaction`） |

---

## 1. 怎么拿到（不发布 npm，两种取法内容一致）

- **打好的包（直接取这个文件）**：仓库内 `dist/jieai-liuhe-lite-<version>.tgz`（随仓提交；同目录有 `SHA256SUMS`；**`dist/` 只在仓库，不随包分发**）。**拿到手解包后，包本身就是交付物**——不需要再去找 `dist/`。包内已 vendor 全部写路径原语（清单与快照锥见 `vendor/malong/PROVENANCE.json`），**不装 npm 也能直接用**：

  ```bash
  tar xzf jieai-liuhe-lite-<version>.tgz -C vendor/liuhe-lite
  # 供应链自查（vendor 里原语的来源与 hash 逐文件核对，含夹带检查）
  node vendor/liuhe-lite/package/tests/provenance.mjs
  # 然后 import '<...>/vendor/liuhe-lite/package/lite/index.js'
  ```

- **本仓库目录**：`integration/liuhe-lite/`。注意：**裸目录不是自包含的**——它 `import ../../../malong/*.js`（清单见 PROVENANCE），必须配合仓库里的 `malong/` 才能跑。所以要让对方独立使用，请给 tarball，不要只复制这个目录。

自包含验证（我们这边跑过）：解包后**不经 npm**，直接 `import` 就能跑完整闭环（apply → undo → 磁盘核对）；`node scripts/pack-lite.mjs --verify` 可复现（两次跑指纹一致）。

---

## 2. 三步接入

### 第一步：宿主给出工作区真值

```js
// 只在宿主运行时里算，绝不从模型参数取
const workspaceRealPath = cellRuntime.workspace.realPath   // 必须已 realpath 归一
```

### 第二步：建适配器（可整段抄 `examples/cell-adapter.mjs`）

```js
import { createCellAdapter } from './cell-adapter.mjs'

const lite = createCellAdapter({
  host: {
    workspaceRealPath: () => workspaceRealPath,               // 必填
    cell: () => ({ cellId, incarnationId, taskId }),          // 可选：进回执
    onEvent: (e) => audit(e),                                 // 可选：动作事件
  },
})
```

`workspaceRealPath()` 是唯一授权来源。动作入参里出现 `workspace` / `workspace_dir` / `workspaceDir` / `realPath` / `real_path` / `cwd` / `root` 任一个，适配层直接返回 `WORKSPACE_PARAM_FORBIDDEN`（`retry: never`）——这是授权边界，不是可修参数。

### 第三步：把六个动作挂到 Cell 的工具面

```js
lite.readAnchor({ path: 'src/a.py' })               // 写前锚点（只读）
lite.preview({ anchor, newContent })                 // 预计差异，不写盘
await lite.apply({ anchor, newContent, requestId })  // 提交：锚点不符就不覆盖
lite.inspect({ actionId })                           // 动作详情（只读；返回 effect，不产生 receipt）
await lite.undo({ recoveryRef, requestId })          // 有限撤销
lite.reconcile({ actionId })                         // 事后对账（只读）
```

`requestId` 由 Cell 生成；**同一动作的重试必须沿用同一个 id**（幂等键）。不同载荷复用同一个 id → `REQUEST_CONFLICT`。

---

## 3. 六个动作的契约

| 动作 | 入参 | 成功返回 | 关键保证 |
|---|---|---|---|
| `readAnchor` | `{ path }` | `{ anchor: { path, exists, sha256, size, mtime_ms, inode, encoding, line_count } }` | 只读；文件不存在时返回 `exists:false`，不是错误 |
| `preview` | `{ anchor, newContent }` | `{ preview: { expected_before_sha256, expected_after_sha256, applied:false, diff } }` | **绝不写盘**；`applied` 恒为 `false`；差异过大时给 `truncated:true` + `detail_ref` |
| `apply` | `{ anchor, newContent, requestId }` | `{ receipt, detail }` | 锚点与磁盘不符 → `VERSION_CONFLICT` 且不覆盖；同 `requestId` 重试 → 幂等复读（`detail.idempotent_replay`） |
| `inspect` | `{ actionId }` | `{ ok, effect }`——**没有 `receipt`**（inspect 是只读详情，不是动作回执；要回执请用 `reconcile`） | 只给工作区相对路径与 hash，不给日志正文；含 `undo_supported` / `undo_expires_at` / `undo_expired`（与 undo 的过期判定同源） |
| `undo` | `{ recoveryRef, requestId }` | `{ receipt, detail }` | 撤销前文件已被后续修改 → `UNDO_CONFLICT`，保留后续修改 |
| `reconcile` | `{ actionId }` | `{ receipt, detail }` | 只读重新识别落地状态；证据不足给 `needs_review` / `indeterminate`，不猜 |

失败返回统一为：`{ ok:false, error: { code, message, handling: { retry, note } }, detail }`。

- **`handling` 是 Lite 原生入口自己返回的**（单一真值在 `lite/errors.js` 的 `RETRY_POLICY`），不是示例适配层补的；`detail` 在**顶层**，不要在 `error.detail` 里找。

---

## 4. 回执

- `schema_version: "tusunsun.action-receipt/v0"`，`provider: "liuhe-lite"`
- **`verification` 恒为 `not_run`**：写入成功 ≠ 代码语义正确。这一项由你们跑验收后自己回填，我们绝不代填
- `persistence` 如实反映证据是否落盘：`persisted` / `memory_only` / `failed` / `unknown`
- 逐字段对齐清单（含我方需你们确认的 6 项）：[RECEIPT-FIELD-ALIGNMENT.md](./RECEIPT-FIELD-ALIGNMENT.md)

---

## 5. 错误码 → Cell 该怎么处置

| 错误码 | `retry` | 含义 / 下一步 |
|---|---|---|
| `WORKSPACE_PARAM_FORBIDDEN` | never | 试图用入参指定工作区；授权边界，不要绕 |
| `PATH_OUT_OF_SCOPE` | never | 绝对路径 / `..` / 敏感目录 / 经符号链接；fail-closed |
| `VERSION_CONFLICT` | after_reanchor | 磁盘已变；重新 `readAnchor` 再规划 |
| `UNDO_CONFLICT` | never | 文件已被后续修改；保留现状，交人工 |
| `INDETERMINATE` | after_reconcile | 结果不确定；先 `reconcile` |
| `PERSISTENCE_FAILED` | new_request | 证据未落盘（未写任何文件）；换 id 重做 |
| `RECOVERY_UNAVAILABLE` | never | 无日记可依，不能承诺 Undo |
| `FOREIGN_JOURNAL` | never | 日记不是 Lite 创建的 / 格式不认识（`detail.reason` 说明哪种）；拒绝接管，磁盘未被触碰 |
| `NOT_UNDOABLE` | never | 该动作不在可撤销状态 |
| `NEEDS_REVIEW` | never | 磁盘上是第三态（既非动作前版本也非动作后版本，通常是外部改动）；别重试，人工确认后重新 `readAnchor` 再规划 |
| `FILE_LOCKED` | same_request_id | 并发写者持锁；退避后用同一 id 重试 |
| `REQUEST_IN_FLIGHT` | same_request_id | 同 id 正在执行 |
| `REQUEST_CONFLICT` | new_request | 同 id 异载荷 |
| `FILE_TOO_LARGE` | never | 超 1 MiB 上限 |
| `UNSUPPORTED_ENCODING` | never | 非 UTF-8 / 二进制 |
| `WRITE_FAILED` | new_request | 原子写失败，目标未变 |
| `CANCELLED_BEFORE_START` | new_request | 取消发生在执行前，明确未碰盘；可安全重做 |
| `INVALID_INPUT` | never | 参数不合法 |
| `NOT_FOUND` | never | 动作 / 日记不存在 |

`retry` 取值：`never` / `same_request_id` / `new_request` / `after_reanchor` / `after_reconcile`。

---

## 6. 取消与超时（三条铁律）

1. **取消发生在执行前** → `CANCELLED_BEFORE_START`，明确未碰盘，可安全重做。
2. **取消晚于写盘** → 我们**不返回「已取消」**：结果照实（`applied`），另带 `cancel.requested_during = true` 与「可能已落地，先 reconcile」。
3. **超时 / 异常** → `INDETERMINATE`，**不折算成「失败且无副作用」**；先 `reconcile` 再决定。

第 2、3 条是刻意设计：把不确定说成「没发生」会教 Cell 撒谎，后续重试就可能覆盖别人的改动。

---

## 7. 边界与限制

| 项 | 值 |
|---|---|
| 文件类型 | UTF-8 文本；NUL 字节或非法 UTF-8 → `UNSUPPORTED_ENCODING` |
| 单文件上限 | 1 MiB（`limits.maxFileBytes` 可调） |
| 作用域 | 单工作区；绝对路径、`..`、敏感名单、**一切经符号链接的路径**（含工作区内链接）一律拒 |
| 符号链接为何更严 | `tmp+rename` 原子写会把**链接本身**替换成普通文件、真实目标纹丝不动——比越界更隐蔽，故直接拒 |
| 平台 | Linux 已验证；**Windows / macOS：NOT_RUN（未独立复跑，不折算为通过）**——符号链接相关用例在无特权 Windows 上预期 SKIP |
| 依赖 | Rust parser：不需要；SQLite：不需要；第三方 npm 依赖：**0** |
| 非功能基线 | 导入闭包 **240.9 KiB / 17 文件**（与 README、`reports/nonfunctional-baseline.json` 同源，机检容差 0）；冷启动与 RSS 见该报表（口径：脚本 T0 → 首次 readAnchor 返回，不含 Node 引导，跨机不可比） |

---

## 8. 同步点 C 验收（请你们在自己的 Cell 里跑）

```bash
# 全自动闭环：临时工作区，不动你们任何文件
node tests/cell-acceptance.mjs

# 只读模式：指向你们真实工作区，只做授权 / 越界 / 可读检查，绝不写入
LITE_CELL_WORKSPACE=/你们的/工作区 node tests/cell-acceptance.mjs
```

脚本逐条打勾的 12 项：

| 编号 | 验收点 |
|---|---|
| C01 | 工作区真值来自宿主运行时（adapter 自述与宿主一致） |
| C02 | 模型传 `workspace_dir` 被授权边界拒绝 |
| C03 | 越界写入被拒且工作区外无落盘 |
| C04 | `preview` 不写盘（磁盘字节前后一致 + `applied:false`） |
| C05 | `apply` 回执的 `effect` 前后 hash 与真实磁盘独立核对一致 |
| C06 | 回执契约字段（schema / provider / `verification:not_run` / `persistence` / `recovery`） |
| C07 | 旧锚点复写被拒（fail-closed）且磁盘未被覆盖 |
| C08 | 同 `requestId` 重试幂等、不重复写 |
| C09 | 取消早于执行：明确未碰盘 |
| C10 | 取消晚于写盘：如实标注可能已落地，不声称「已取消且无副作用」 |
| C11 | `undo` 把文件退回旧内容且回执可核对 |
| C12 | 撤销后再对账报 `not_applied`，且 `extension` 说明「提交过又撤销」 |

> 我们这边最后一次结果：**12/12 通过**（Linux x64 / Node v22.22.2）。你们的环境结论以你们跑的为准——我们不代填。

---

## 9. 我们明确不提供

| 想要的东西 | 为什么没有 | 谁能给 |
|---|---|---|
| `verification: "verified"` | Lite 不跑代码检查/测试/构建 | 你们跑验收后回填 |
| 「这次修改对不对」的语义结论 | 不建索引、不解析符号 | 六合完整 MCP（`code_check` / `code_read`）或你们自己的验收 |
| 绝对路径 / 日志正文 | 回执不泄露宿主私有路径，也不塞上下文 | 需要时你们自己读工作区 |
| 时间戳字段 | v0 公共字段里没有；内部时间戳不强行映射进公共合同 | 若需要，同步点 B 冻结字段时加 |
| 跨文件 / 跨工作区影响 | Lite 是单文件、单工作区 | 六合 `edit_transaction` |
| shell / 网络 / 远程 API 动作 | Lite 不做这类动作 | 不存在此能力 |
| 「Cell 是否有权做这件事」的结论 | 我们不评估你们的授权真值 | 土行孙 Cell 运行时 |

---

## 10. 出问题时先看哪里

1. `error.code` + `error.handling.retry` —— 能不能重试、用哪个 `requestId`，表里都写了。
2. `reconcile({ actionId })` —— 只有它能回答「到底落地没有」，不要去猜存储状态。
3. `SAFETY.md` —— 撤销边界、数据留存（`.malong/` 备份是**写前原文明文副本**）、受限档说明。
4. `LIUHE-LITE-FEASIBILITY.md` —— 为什么是这 6 个动作、为什么不抽独立引擎（历史快照，指标不复用）。

---

## 11. 嵌入形态与并发契约（回答土行孙 B-5 三问）

**（1）可嵌入形态**：`import` 包内 `lite/index.js`，**在 Cell 进程内直接跑**是支持形态——不起子进程、不走 MCP。Lite 全部状态都是「每工作区」的：日记在 `<ws>/.malong/`，文件锁在目标文件旁（`<file>.mlock`，随机 token 归属，同进程并发世安全），request 账本在 `$MALONG_STATE_DIR/outlet-requests/<wsHash>/<reqHash>.json`。进程级共享的可变状态只有两处，均无害：`git-exclude` 的模块级去重 Set（按工作区路径作键，只避免重复写 exclude）与 `MALONG_STATE_DIR` 本身。

**（2）共用 `MALONG_STATE_DIR` 会不会串**：不会。账本键 = `wsHash(workspaceDir) + requestHash(requestId)`——不同工作区的同名 request_id 是两条独立记录。但要记住反面：**同一工作区里，同一个 request_id 跨 Cell 是同一条幂等身份**（这是设计不是串号）；两个 editor 对同一目标文件并发写，靠 `.mlock` 串行化，后到者拿到 `FILE_LOCKED`。你们的 `1 Cell : 1 Core : 1 进程` 形态没有额外假设。

**（3）`cell_id / incarnation_id / task_id`**：原样写进回执的 `cell` 块（缺省为 `null`），**不参与 Lite 任何内部判定**（不做授权、不做去重、不影响错误码）——授权真值在你们宿主手里。同步点 C 的只读模式现在也会自证「全程未写盘」（全量 size/mtime 指纹比对）。
