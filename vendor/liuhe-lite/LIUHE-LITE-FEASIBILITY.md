# LIUHE Lite — L0 复用性审计（可行性）

> **本文是历史快照（2026-10-22，0.1.0 期）**：文中的体积/耗时等指标是审计当时的实测，不随版本更新；现行数字见 `README.md` 与 `reports/nonfunctional-baseline.json`。引用时请勿把这里的数字当当前口径。

> 任务书同步点 A 的交付物。结论先行：**走 Adapter first，不抽 Lite**；把「写前锚点 → 提交/拒绝 → 写后核查 → 有限 Undo → 事后对账」做成一层薄适配，写路径原语全部复用六合现成实现。
> 审计日期：2026-10-22 · 审计对象：发布仓 master 源码树 `malong/`（v0.5.27 线）· 工具：malong 六合线（code_task / code_read / code_query）

---

## 0. 审计口径（先把话说清楚）

| 项 | 说明 |
|---|---|
| 审计对象 | **当前发布仓源码树**（`liuhe/malong/`），不是任务书引用的 `jieai-dsh-malong-bridge-0.5.18.tgz` |
| 路径差异 ≠ 版本差异 | dsh bundle 的 `server/` 是 `malong/` 的扁平拷贝（`malong/dsh/bundle/reprep.sh:9-17`）→ 任务书里的 `server/write-runtime.js` **就是**当前的 `malong/write-runtime.js` |
| 与 0.5.18 的逐字节对照 | **未做**。本机 npm 登录态失效（401），拿不到 0.5.18 tarball；§1.5 的差异清单只列**当前源码可证**的硬化项，并标注证据位置 |
| 证据形式 | 每条结论给「文件:行号 + 函数名」；无证据的写「未验证」 |
| 不接受 | “设计上可以拆”式结论；本审计每条能力都有真实调用点或真实测试证据 |

---

## 1. 真实模块地图（Q1）

### 1.1 能力 → 模块 → 入口

| 能力 | 模块（当前树） | 入口 | 关键语义 |
|---|---|---|---|
| **原子写** | `malong/path-guard.js:79` `atomicWrite` | tmp + rename | 继承目标 mode；`opts.fsync` 可选；Windows 走 `replaceFilePreservingMetadataSync`；rename 遇 `EPERM/EBUSY/EACCES` 重试 3 次×150ms；终败清理 tmp |
| 原子写（产品主路径） | `malong/write-runtime.js:138` `_writeTmpPreservingMode` + `:233` `renameRetry` | `writeSymbol` 内部 | 与 `atomicWrite` 同语义，差别是默认用 `replaceFilePreservingMetadataSync`（Windows 保 ACL） |
| **变更日记** | `malong/write-journal.js:21` `createJournal` / `:56` `updateJournalState` / `:64` `auditLog` | `<ws>/.malong/journal/<txn_id>/` | 目录含 `pid`、`backup/<basename>`、`manifest.json`、`state.json`；资产均 `atomicWrite+fsync` |
| **路径校验** | `malong/path-guard.js:11` `guardRealPath`（realpath 前缀）/ `:43` `guardReadPath` | 写前必经 | 逐级向上回溯到最深可解析祖先 → 新建文件/多级新目录不误拒；`real !== realRoot && !real.startsWith(realRoot+sep)` → `symlink_escape` |
| 路径字符串守卫 | `malong/error-codes.js:72` `validateFilePath` | 字符串层 | `..` **段级**判定（不误杀 `foo..bar`）；绝对路径默认拒；敏感名单 `.git/.env/.pem/.key/node_modules/venv/__pycache__/.ai-transactions/.malong`；Windows 保留名与尾点尾空格 |
| **Undo** | `malong/write-journal.js:696` `restoreJournal` | `liuhe-undo:<txn_id>` | 只接受 `committed`/`committed_recovered`；`created:true` → 删文件；否则写回 backup；外部改动 → `EXTERNAL_CHANGE`；批次 → 全量或全无 `BATCH_BLOCKED`；backup 路径 realpath 逃逸 → `BACKUP_ESCAPE` |
| **三方 hash 恢复** | `malong/write-journal.js:184` `recoverJournals` | 启动/写前扫描 | 当前==写前 backup → `abandoned`；当前==写后 `new_hash` → `committed`；两者都不是 → `needs_review`（**永不覆盖**） |
| 事务系恢复（多文件） | `malong/write-journal.js:303` `recoverTransactions` | `.ai-transactions/` | 与上同型的三方判定；仅处理 `staged` |
| **并发锁** | `malong/write-runtime.js:71` `acquireLock` | `<target>.mlock` | `O_EXCL` 创建；**随机 token** 归属（同进程并行 MCP 调用 pid 相同，pid 校验不够用）；15s 心跳续租；30s 陈旧判定；35s 超时 → `FILE_LOCKED` |
| 批次锁 | `write-journal.js:_acquireBatchLock` | `.malong/batches/.batch-lock` | `O_EXCL` + pid 判活；活锁绝不删 |
| **冲突状态机** | `malong/write-runtime.js:149` `classifyConflict` | `writeSymbol` 锁内 | `CLEAN/FILE_CHANGED/SYMBOL_CHANGED/SYMBOL_SIGNATURE_CHANGED/SYMBOL_DELETED/NO_BASE`；`CONFLICT_POLICY` 中除 `CLEAN` 外一律 reject |
| **request_id 幂等** | `malong/tools/outlet-ledger.js` `ledgerClaim/ledgerRecord/ledgerLookup/ledgerRelease` | `$MALONG_STATE_DIR/outlet-requests/<wsHash>/<reqHash>.json` | 执行前 `O_EXCL` 占位（跨进程互斥）+ pid 判活 + 过期接管；同 id 同载荷 → 幂等复读；同 id 异载荷 → conflict；未收口 → unresolved，**证据不删**（压缩为恢复占位） |
| 语法校验 | `malong/write-runtime.js:195` `validateSyntax` | 写前 | **无 parser 时返回 `{status:'skip'}`**；standard profile 只拦 `fail`，不拦 `skip` |
| 产品写入口 | `malong/write-runtime.js:242` `writeSymbol` | 符号/patch 导向 | 锁内 resolve→冲突判定→校验→journal→原子写→**回读实测**→(锁外)重抽 |
| 产品事务入口 | `malong/tools/tool-edit-transaction/handler.js` + `transaction-store.js` | `begin/edit/commit/undo_commit` | `.ai-transactions` 多文件事务系，支持分块写与 undo |

### 1.2 依赖图（Lite 实际用到的部分）

```
土行孙 Cell（宿主运行时提供 TrustedWorkspace.realPath + Cell 身份）
   ▼
integration/liuhe-lite/lite/index.js          ← 本次新增的薄适配层
   ├── malong/path-guard.js        guardRealPath / atomicWrite
   ├── malong/write-journal.js     createJournal / updateJournalState / restoreJournal / auditLog
   ├── malong/write-runtime.js     acquireLock / classifyConflict
   ├── malong/error-codes.js       validateFilePath
   ├── malong/hash-utils.js        sha256
   ├── malong/write-edit.js        makeSimpleDiff
   └── malong/tools/outlet-ledger.js
         └── malong/host-config.js + malong/tools/entry-store.js
```

**实测：该闭包零 `better-sqlite3`、零 `malong-parse`、零 `code-index`。**（grep 全闭包 + `tests/baseline.mjs` 的导入图扫描，两处独立验证）

### 1.3 磁盘状态格式

| 路径 | 内容 | 生命周期 |
|---|---|---|
| `<ws>/.malong/journal/<txn_id>/pid` | 写者 pid | 随事务目录 |
| `<ws>/.malong/journal/<txn_id>/backup/<basename>` | 写前原文（原子写+fsync） | 24h（`JOURNAL_RETENTION_HOURS`） |
| `<ws>/.malong/journal/<txn_id>/manifest.json` | `txn_id / file(工作区相对) / edit_mode / created_at` | 同上 |
| `<ws>/.malong/journal/<txn_id>/state.json` | `state / new_hash / created / base_file_hash / batch_id` | 同上 |
| `<ws>/.malong/audit.log` | JSONL 审计（`lite_apply` / `journal_undo` / `force_write` …） | 追加 |
| `<ws>/.malong/batches/*.json` + `.batch-lock` | 批次标记与批次锁 | 批次结束即删 |
| `<target>.mlock` | 文件锁（pid+token+时间戳） | 写完即删；崩溃残留 30s 后判陈旧 |
| `<target>.txn-*` / `<target>.tmp-*` | 原子写临时文件 | rename 即消失；终败清理 |
| `<ws>/.ai-transactions/` | edit_transaction 系事务（Lite 不用） | 7 天扫描 |

### 1.4 平台差异与原子边界（不可越过的实话）

- **rename 只保证同目录原子替换**，不保证掉电持久：`atomicWrite` 的 `fsync` 是**可选**的——日记资产用 fsync（恢复资产不能半截），**用户文件默认不 fsync**（高频写入感知明显）。因此“写了”≠“掉电后还在”，真正能兜底的是日记 + 人工/git。
- **Windows**：Node 的 rename 会把目标 DACL 换成 tmp 的继承 DACL → 仓库里用 PowerShell `File.Replace` 保留目标安全元数据（`malong/windows-file-replace.js`）；杀软/句柄占用会偶发 `EPERM/EBUSY` → 重试 3 次×150ms 后失败（**不是静默成功，是 WRITE_FAILED**）。
- **Windows 保留名/尾点尾空格**（`CON`/`NUL`/`com1`…、段尾 `.`/空格）在字符串层就拒（`validateFilePath`）。
- **symlink**：仓库的 `guardRealPath` 只保证“真目标不出工作区”；**工作区内**的 symlink 仍可写（`tmp+rename` 会把链接本身替换成普通文件，真实目标不变）。Lite 的受限档额外堵了这一点（见 §6.3）。

### 1.5 与 0.5.18 的差异（仅列当前源码可证项）

| 硬化项 | 当前树证据 |
|---|---|
| realpath 越界守卫（symlink 逃逸） | `path-guard.js:11`（注释标 r8(B1)） |
| 锁归属改随机 token（同进程并行不会互删锁） | `write-runtime.js:71`（注释标 r54(P1)） |
| 日记写者存活判定（`kill(pid,0)`，`EPERM` 视为存活） | `write-journal.js:journalWriterAlive` |
| 批次锁不删活锁 | `write-journal.js:_acquireBatchLock`（注释标 R22-⑯） |
| backup 路径 realpath 逃逸防护 | `write-journal.js`（注释标 R22-④） |
| 写后**回读实测**（不一致 → `READBACK_MISMATCH` + journal `indeterminate`） | `write-runtime.js` 第 8 步后段 |
| Windows 保 ACL 替换 | `windows-file-replace.js` |

> 未验证：0.5.18→0.5.27 的**完整**差异集（本机无 0.5.18 包）。

---

## 2. 文件写链能否脱离 Rust malong-parse 与全量索引（Q2）

**能。** 三条独立证据：

1. **代码层**：`writeSymbol` 的 `codeIndexService` 全程是可选参数（`if (codeIndexService && …)` 三处）；`validateSyntax` 在 `!langParser?.hasErrorsAsync` 时返回 `{status:'skip'}`（`write-runtime.js:196`），而 `shouldBlockValidation` 的 standard profile **只拦 fail、不拦 skip** → 没有 parser 也不会误拒写。
2. **导入闭包层**：`grep` 整个闭包无 `better-sqlite3` / `malong-parse` / `code-index` / `sql.js`；`tests/baseline.mjs` 独立扫描导入图得 `external_count = 0`。
3. **运行层（L16 实证）**：把 `MALONG_PARSE_BIN` 指向一个“假 parser”（一旦被调用就写标记文件），在独立子进程里跑完整闭环 → **标记文件不存在**（整条链路没碰过 Rust parser），且工作区**未出现任何 `*.db/*.sqlite`**（没建代码索引）。见 `reports/l01-l16-report.md` 的 L16 行。

**剥离不掉的部分（诚实说明）**：Lite 复用 `write-journal.js` / `write-runtime.js` / `path-guard.js` 这几个模块时，**必须连同它们的仓库内依赖一起带走**（`symbol-anchors.js`、`staleness.js`、`write-edit.js`、`writer-registry.js`、`windows-file-replace.js`、`host-config.js`、`tools/entry-store.js`）。这是**文件级搬运**，不是复制——模块本身是单一真相源。

---

## 3. 依赖基线（Q3）

| 项 | 结论 | 证据 |
|---|---|---|
| Node 版本 | `>=18`（`malong/package.json` engines）；实测 **v22.22.2** | `tests/baseline.mjs` |
| SQLite / sql.js | **不需要**（那是代码索引的事，Lite 不建索引） | 导入闭包 grep |
| Rust parser | **不需要** | §2 三条证据 |
| 第三方 npm 运行时依赖 | **0 个**（只用 `node:` 内置：fs/path/crypto/os/url） | `reports/nonfunctional-baseline.md` |
| 安装体积（Lite 导入闭包） | **221.3 KiB / 17 个文件** | 同上 |
| 冷启动（进程启动→首次 readAnchor 返回） | **≈84 ms**（本地多次实测在 83–88 ms 间波动） | 同上 |
| RSS（闭环后） | **57.8 MiB** | 同上 |
| 状态目录 | `$MALONG_STATE_DIR`（默认 `~/.config/malong`），Lite 的 request 账本落在这里；**事务日记落在工作区内** `<ws>/.malong/` | `host-config.js:20` |

---

## 4. 并发真实行为（Q4）

| 场景 | 真实行为 | 证据 |
|---|---|---|
| **同文件** | `.mlock` 串行化：第二个写者要么等（≤35s），要么拿不到锁 → `FILE_LOCKED`；拿到锁后再比锚点 → 版本已变 → `VERSION_CONFLICT` | L06 实测：**恰好一个成功、另一个 VERSION_CONFLICT**，落盘内容是任一方的完整内容（无混合/丢失），事务日记恰好 1 份 |
| **不同文件** | 互不影响（各自 `.mlock`），无全局工作区锁 | 代码：锁是按目标路径的文件锁 |
| **跨进程** | 有效（锁是文件）；持锁进程崩溃 → 残留锁 30s 后判陈旧可被接管 | `acquireLock` 的 STALE_LOCK_MS=30000；L13/L14 实测（用产品自带测试旋钮缩短时间尺度，语义不变） |
| **同进程并行调用** | token 归属解决 pid 相同导致的互删锁 | `acquireLock` 注释 r54(P1) |
| **工作区级** | 只有**批次锁**（`.batch-lock`），没有全局工作区锁 → Lite 单文件作用域不需要 | `write-journal.js` |

---

## 5. write-journal 恢复状态的可证明覆盖面（Q5）

| 情况 | 判定 | 动作 | 能否 Undo |
|---|---|---|---|
| 当前 == 写前 backup | `abandoned` | 事务从未落地，不动文件 | ❌ |
| 当前 == 写后 `new_hash` | `committed` | rename 已落地，补标终态 | ✅（当前仍 == new_hash 时） |
| 两者都不是 | `needs_review` | **永不覆盖**，保留待人工核对 | ❌ |
| backup / 目标缺失 | `needs_review` | 证据不足，不删不覆盖 | ❌ |
| `state.json` 不可解析 | `unparseable_state_kept` | 保留待审 | ❌ |
| 写者进程存活 | `in_flight_kept` | 在途，不动 | ❌ |
| 写时回读不一致 | `indeterminate` | 落 `indeterminate`（恢复时归 `needs_review`） | ❌（需人工） |
| Undo 时文件 ≠ `new_hash` | `EXTERNAL_CHANGE` | **拒绝覆盖**，后续改动保留 | ❌（`UNDO_CONFLICT`） |
| 日记目录不存在 / 24h 过期 | `JOURNAL_NOT_FOUND` | 无证据 → `RECOVERY_UNAVAILABLE` | ❌ |

**Undo 可用的充要条件（六条全满足才行）**：journal 存在 ∧ `state ∈ {committed, committed_recovered}` ∧ 目标当前仍 == `new_hash` ∧ backup 存在且 realpath 不逃逸 backup 目录 ∧ 路径守卫通过 ∧ 能拿到文件锁。

**不可撤销的（写进安全声明）**：shell 命令、网络请求、远程 API、外部进程、不经 Lite 管理的文件动作。

---

## 6. 路线结论（Q6）：**Adapter first，不抽 Lite**

### 6.1 为什么不是 Extract Lite

1. 任务书要求的五项能力（锚点 / 事务 / 文件效果 / 日志 / 恢复 / Undo）在当前树里**已经全部存在，并且产品自己每天在用**（`writeSymbol` 是六合同步点的主写路径）。
2. 抽 Lite = 复刻 `writeSymbol` 的编排（锁内 resolve → 冲突判定 → 校验 → journal → 原子写 → 回读 → 重抽）。**任何一处分叉就是第二套事务系统**——正是任务书第 0 节禁止的“把 44 工具压成另一套复制品”。
3. 抽 Lite 的收益（体积）在这个场景下不是瓶颈：Lite 的真实导入闭包只有 **221 KiB / 零外部依赖**——**不带 Rust parser、不带 SQLite**，连 malong 的 MCP 服务器都不需要。抽出来的收益 ≈ 0，风险却最高。

> **独立包**：Lite 另打成独立包 `@jieai/liuhe-lite`（自己的版本线，不占主包版本号、不进主包），把用到的 malong 写路径原语 vendor 进包 → 自包含：**0 外部依赖**（vendor 清单见包内 PROVENANCE）；产物指纹见仓库根 CHANGELOG；`node scripts/pack-lite.mjs --verify` 会把 tarball 装进临时目录跑一遍完整闭环作为证据（该脚本只在仓库内，制品的 npm scripts 已剔除指向包外目标的条目）。

### 6.2 Lite 实际做了什么（薄适配，不是新引擎）

| Lite 动作 | 复用的六合实现 | 新增的只有 |
|---|---|---|
| `readAnchor` | `guardRealPath` + `validateFilePath` + `sha256` | 读回 + 元数据组装 |
| `preview` | `makeSimpleDiff` | 差异裁剪 + `applied=false` 声明 + 不写盘 |
| `apply` | `acquireLock` + `classifyConflict` + `createJournal`/`updateJournalState` + `atomicWrite` + `auditLog` + `outlet-ledger` | 整文件替换的编排（见 6.3） |
| `inspect` | journal `state.json`/`manifest.json` + backup | 效果视图组装 |
| `undo` | `restoreJournal` | 错误码映射 + 回执 |
| `reconcile` | journal 三方 hash 规则 | 只读判定 + 回执 |

**事务语义仍是单一真相源**：原子性、日记、锁、冲突判定、Undo 条件全部来自 `malong/` 的既有模块，Lite 没有第二份实现。

### 6.3 唯一一处偏离（必须写明）

`writeSymbol` 的公开契约是**符号/patch 导向**：`edit_mode=patch` 要求 `patch.old_string` 非空串 → **无法表达「把整个文件替换为新内容」的空文件场景**。若硬套，会退化成“把整个旧文件当 old_string 传进去”（大文件放大 + 语义怪）。

因此 Lite.apply 用**同一批原语**编排整文件替换，并配 `tests/parity.mjs` 做逐项对照：

| 对照项 | 结果 |
|---|---|
| 落盘内容一致 | ✅ |
| 锚点过期 → 双方都 `VERSION_CONFLICT`、都不覆盖 | ✅ |
| Undo → 双方都回到旧版本 | ✅ |
| 空文件 | 产品路径**无法表达**；Lite 可处理（这是 Lite 多出来的一个能力，不是绕过） |

**parity 实跑：15/15 通过。**

### 6.4 受限档的额外边界（Lite 比产品更严的一处）

产品允许写「工作区内的 symlink」，但 `tmp+rename` 会**把链接本身替换成普通文件**（真实目标纹丝不动）——“以为改了 a.txt，其实把那个链接换掉了”是比越界更隐蔽的意外。Lite 受限档**拒绝一切经由 symlink 的路径**（含区内），错误码 `PATH_OUT_OF_SCOPE` / 原因 `symlink_path`。L10 实测：外链拒绝、区内链接也拒绝、真实目标未被改动、链接本身未被替换。

---

## 7. L0 完成条件自检

| 任务书要求 | 本审计的交付 | 状态 |
|---|---|---|
| 真实模块/入口/依赖图 | §1（含文件:行号） | ✅ |
| 区分 0.5.18 已知实现与最新版本差异 | §1.5（只列当前树可证项；**未做** 0.5.18 逐字节对照，已注明） | ⚠️ 部分 |
| 写链能否脱离 Rust parse / 全量索引 | §2（三条独立证据，含 L16 实证） | ✅ |
| 依赖：Node / SQLite / 磁盘格式 / 平台差异 / rename 边界 | §3 + §1.4 | ✅ |
| 并发：同文件 / 不同文件 / 跨进程 / 工作区锁 | §4 | ✅ |
| 恢复状态可证明覆盖面 | §5（九种情况 + Undo 充要条件） | ✅ |
| 两条路线择一 + 理由 | §6：**Adapter first**，理由含「抽出来的收益≈0」 | ✅ |
| 最小运行示例 | `examples/poc.mjs`（无需任何 LLM Key） | ✅ |
| 粗略依赖图 | §1.2 | ✅ |

---

## 8. 明确不在本次范围内（避免被误读成“已支持”）

- 多文件原子事务、跨工作区事务 → 不支持（Lite 单文件、单工作区）
- 二进制 / 非 UTF-8 / 超限文件 → 具名拒绝，不截断、不部分覆盖（L11）
- 符号链接路径 → 受限档拒绝（§6.4）
- 代码语义校验、符号级编辑、跨语言引用 → 不支持（Lite 不跑测试/不建索引，`verification` 恒为 `not_run`）
- 撤销 shell / 网络 / 远程 API / 外部进程 → 不支持且**永不声称支持**
- 作为 OS 沙箱 → **不是**；Lite 不继承 Cell 授权，不越过受权工作区，但也不提供隔离

---

## 9. 附：证据索引

| 证据 | 位置 |
|---|---|
| L01–L23 反例矩阵报表 | `reports/matrix-report.md` / `.json` |
| 非功能基线（体积/冷启动/RSS/依赖） | `reports/nonfunctional-baseline.md` / `.json` |
| 落盘对照（Lite vs 产品 writeSymbol） | `tests/parity.mjs`（15/15） |
| 可运行 PoC | `examples/poc.mjs` |
| 动作回执映射表 | `ACTION-RECEIPT-MAPPING.md` |
| 安全声明 | `SAFETY.md` |
