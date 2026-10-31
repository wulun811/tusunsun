# LiuHe Lite 版本日志

独立交付 · 独立版本 · 独立测试。

**不占用主包 `@jieai/dsh-malong-bridge` 的版本号，也不进主包** —— 两条版本线互不影响：主包照常发 `0.5.x`，Lite 走自己的 `0.x` 线。

## 0.1.x

- **[0.1.3]** (2026-10-23): 回应土行孙 v0.11.0 对 0.1.2 的独立核对（A 类 7 条全修，两条 P0 先红后绿）。
  - **A-1（P0）过期自动清扫**：SAFETY 承诺的「保留窗口 24h，过期自动清扫」此前只写在文档里（pruneJournals 只在产品写路径被调，Lite 从不触发）→ `backup/`（敏感文件明文副本）会无限留在盘上。现在 `apply` 的成败路径都会顺带清扫，且与产品版三处刻意不同：**只清能证明是 Lite 自己的**（edit_mode+txn_id+issuer，归属证明不了不删）；外来日记不碰；保护态多一个 `indeterminate`（回读不一致等人工的证据）；目标正被其它进程操作（`.mlock`）时跳过。L27 用真实磁盘验证（含外来日记不删、needs_review 不删）。诚实边界：纯只读会话不触发清扫（已写入 SAFETY）。
  - **A-2（P0）过期仍可撤销**：0.1.2 里 inspect 说「不能撤」，undo 却真撤了（同一事实两处写、只查一处）。现在 undo 在所有权/幂等复读之后、真正执行之前判过期：`NOT_UNDOABLE` + `detail.reason='undo_expired'`（红证据：过期 30h 的事务被真退回旧版）；reconcile 回执的 `recovery.supported` 同源判过期（这层 0.1.2 也漏了）。幂等复读不受影响（已成功的撤销重试仍复读原回执）。L28。
  - **A-3 引用失效**：README/GUIDE 里指向 `dist/jieai-liuhe-lite-0.1.1.tgz`（包内无 dist/、版本还差一位）；FEASIBILITY 快照里的旧版本号；制品 package.json 的 `pack:lite`/`pack:verify` 指向不随包分发的 `scripts/`（制品里 `npm run pack:verify` 直接 MODULE_NOT_FOUND）。修复：文档改为「本包即交付物」+版本统一；打包时逐条校验 scripts 目标存在、不存在则从制品剔除（仓库保留）并打印清单；docs-claims 新增机检（scripts 目标存在 / 文档 tgz 版本与 package.json 一致）。
  - **A-4 指标多口径**：同一个包里出现四个体积/冷启动数（README 235.9/94ms，GUIDE/FEASIBILITY 221.3/84ms，包内 baseline 236.5/20ms，外部实测 51.4ms）——其中 221.3/84 是 0.1.0 旧数。修复：体积统一为实测 **240.9 KiB / 17 文件**（README=GUIDE=报表，容差 0 机检；旧判据容差 0.6+内置 221.3 逃生门已删）；冷启动明确口径（脚本 T0 → 首次 readAnchor，不含 Node 引导，跨机不可比）并把机检改为「文档间一致 + 与报表一致」；FEASIBILITY 加「历史快照」横幅（数字不随版本更新）并机检横幅存在。
  - **A-5 来源不一致**：PROVENANCE 的来源字段与 package.json.repository 不一致，且无顶层快照说明。修复：统一指向公开上游 `https://github.com/wulun811/LiuHe`，新增 `source_repository_public`（= package.json.repository，声明值）+ `source_repository_note`（来源与验证边界）；新增 `snapshot: { commit, commit_date, basis, note }`——锚定「malong/ 子树最后一次改动的提交」（不用当前 HEAD：那会一提交就过期、CI 重打必 diff），并写明 `last_commit` 是「该文件自身最后一次改动」与此锚是两个概念。
  - **A-6 断引用**：vendored `host-config.js` spawn 的 `state-migrate-cli.js` 不在包里（实测 `Cannot find module`，fail-soft 未删数据）。修复：连同其直接依赖 `state-migrate.js` 一起 vendor（保持字节一致，不动源码），打包时校验伴生文件存在。
  - **A-7 inspect 形状差异**：inspect 返回 `{ok, effect}` 无 receipt，接入方拿去喂回执校验器会碰壁。按土行孙提供的选项二处理：指南显式声明「inspect 不返回 receipt（它是只读详情，不是动作回执；要回执用 reconcile）」，并注明其 `undo_supported/undo_expires_at/undo_expired` 与 undo 同源。
  - **B 类冻结记录**：B-1 两枚举语义确认；B-2 v1 persistence 集合；B-3 history 必填含三字段；B-4 披露权归属宿主（补进解释权表）；B-5 三问见 INTEGRATION-GUIDE §11。均写入 `RECEIPT-FIELD-ALIGNMENT.md` 冻结记录段。
  - 矩阵 26 → **28 条**（L27 清扫 / L28 过期一致性），版本 0.1.3。

- **[0.1.2]** (2026-10-23): 自查（自己审自己的代码，含未覆盖路径）。先取证再修，每项带失败路径断言。
  - **错误合同有洞（P1）**：`apply`/`undo`/`reconcile` 里有 **5 处手写失败对象**绕过了 `liteError` —— `error` 里只有 `code`/`message`，**没有 `handling`**；`reconcile` 判 `needs_review` 时甚至 `ok:false` 却不带 `error`。L22 当时全绿，因为它只走了 `liteError` 的路径。现全部收敛到 `liteError`（失败也带 `receipt`），并新增**结构守卫**：`lite/*.js` 里出现手写 `error: {` 直接判红（L22）。
  - **新增 `NEEDS_REVIEW` 错误码**（`retry: never`）：第三态机器（既非动作前也非动作后版本）归入 `INDETERMINATE`（`after_reconcile`）会把 Cell 送进死循环。
  - **undo 的 `request_id` 不幂等（P1）**：同 id 重试会再跑一次 `restoreJournal`（拿到 `already_undone`，却把回执写成 `file_restored`），换一个 `recoveryRef` 复用同 id 更会**静默撤销另一个事务**。现与 `apply` 对齐：先查账本 → 复读原回执（`idempotent_replay`）/ 异事务 `REQUEST_CONFLICT`（L24）。
  - **undo 回执会报「撤销了」但实际没动盘**：`already_undone` / `already_restored` 时回执仍报 `file_restored`。现区分 `wrote_now`（真写了盘才是 `applied`/`file_restored`），并做**撤销回读实测**（磁盘必须回到备份 hash，否则 `INDETERMINATE`）。
  - **过期时间口径撒谎**：`inspect.undo_expires_at` 一律返回「现在 + 24h」，对一个 30 小时前的动作仍声称可撤销 24 小时。现从日记 `committed_at` 算，并给出 `undo_expired`；过期动作 `undo_supported=false`（L26）。
  - **撤销失败会撒谎**：`TARGET_MISSING` / `BACKUP_ESCAPE` 未映射，落到默认 `WRITE_FAILED`（=「目标未变，可换新 id 重做」）。现分别映射 `NOT_UNDOABLE` / `RECOVERY_UNAVAILABLE`，未知内部码兜底改为 `INDETERMINATE`。
  - **日记里的路径字段未过作用域**：伪造日记把 `manifest.file` 写成 `../../` 时，`inspect`/`reconcile` 会去读工作区外文件的 hash/size（元数据泄露；写入侧有产品守卫拦着）。现所有权判据里一并校验，越界→`FOREIGN_JOURNAL`（`detail.reason=path_out_of_scope`，L26）。
  - **读取无界**：锚点之后文件暴涨时，`observedOf` 会把整个文件读进内存算 hash（实测 600 MiB 文件 → 峰值 +601 MiB）。现超过 `maxFileBytes` 直接给 `sha256:null`（必然冲突、fail-closed），实测 300 MiB 暴涨峰值 +0 MiB（L26 子进程测 VmHWM）。
  - **日记不可读时的归属**：目录存在但 `state.json`/`manifest.json` 读不出来时曾被当成 `missing`（等于交给下游去猜）。现单列 `unreadable`：`undo` 拒绝（`RECOVERY_UNAVAILABLE`）、`reconcile` 报 `INDETERMINATE`（`persistence: unknown`）。
  - **失败路径的占位未释放**：`mkdir` / 取锁异常时同一个 `request_id` 重试会收到「正在执行」（假话）。现明确释放占位。
  - **适配层吃掉证据**：`examples/cell-adapter.mjs` 的 `wrap()` 把原生失败的 `receipt` 丢了（原生此时已经落盘了日记/回执）。现透传，L22 断言适配层也能拿到证据。
  - **二进制内容能写进去**：`apply` 接受含 NUL 的 `newContent` → 写成功，但之后 `readAnchor` 永远拒读（自己造一个 Lite 管不了的文件）。现 `apply`/`preview` 一律 `INVALID_INPUT`（L22）。
  - **`inspect` 的 `maxBytes` 是死参数**：接受但完全无效（只回显成一个字段）。现连同 `detail_bytes_cap` 一起删掉，接入指南同步。
  - **同步点 C 的「只读模式」不证明自己只读**：`tests/cell-acceptance.mjs` 只写了句「全程不写」的注释，且探针固定读 `README.md`（不存在时这条等于没测）。现新增 C05：全量 size/mtime 指纹前后比对；探针改为选择真实存在的文件并如实标注。
  - 矩阵 23 → **26 条**（L24–L26），新增 `tests/child-bounded.mjs`（独立进程测 VmHWM）。

- **[0.1.1]** (2026-10-22): 回应《土行孙 v0.10.2 独立专家裁决》LH-01…LH-06。先复现红证据，再修，再补反例。
  - **LH-01 事务所有权（P1，安全）**：`undo` / `inspect` / `reconcile` 在**任何磁盘动作之前**先验日记归属——`manifest.edit_mode` 必须是 `lite_replace`；带 `issuer` 必须是 `liuhe-lite`；带 `journal_format` 必须是已知版本；`txn_id` 必须与目录一致。不属于自己的日记一律 `FOREIGN_JOURNAL`（`detail.reason` 说明哪种），**磁盘与日记字节级不变**。0.1.0 旧日记按 `legacy_v0` 接受（`edit_mode` 已足以区分）。
  - **LH-06 新反例**：L17 外来事务拒绝撤销（真实磁盘 + 日记快照核对）、L18 格式/发行者/身份三种伪造、L19 inspect/reconcile 拒绝、L20 撤销后再改文件再撤销不覆盖、L21 脱敏、L22 错误合同完整性、L23 多进程同时 undo（只回滚一次、拒绝理由具名）。矩阵从 16 条增至 **23 条，23/23 PASS**，报表改名 `reports/matrix-report.*`（旧名会撒谎）。
  - **LH-02 供应链来源证明**：包内 `vendor/malong/PROVENANCE.json` 记录源仓库、commit、许可证、逐文件 sha256；`node tests/provenance.mjs` 双向核对（清单↔实际文件），打包时也自检。**不以“零 npm 依赖”代替“无外来代码供应链”**。
  - **LH-03 错误合同**：`handling` 改由**原生入口**返回（`lite/errors.js` 的 `RETRY_POLICY` 单一真值），`detail` 移到顶层；接入指南的码表与代码**双向机检**，不再靠人眼对齐。
  - **LH-04 脱敏**：修掉 URL 被截断（`https://example.com/a/b` 曾变成 `https:<path>`）；补 Windows 盘符 / UNC / 引号含空格路径；明确能力边界（不做密钥与正文的语义级脱敏）。
  - **LH-05 指标口径**：冷启动改为真的包含首次 `readAnchor` 返回，并拆出「模块导入」「编辑器就绪」两个中间量；旧口径在 `readAnchor` 之前取时间，名不副实。

- **[0.1.0]** (2026-10-22): 首个版本。给没有代码图谱、没有 Agent 框架的最小 Cell，提供高风险文件操作上的「感知 → 核验 → 有限恢复」。
  - **6 个动作**：`readAnchor`（写前实测锚点）/ `preview`（预计差异，不写盘）/ `apply`（锚点校验 → 日记 → 原子写 → 回读实测）/ `inspect`（动作效果详情）/ `undo`（有限撤销）/ `reconcile`（事后三方对账）。回执按 `tusunsun.action-receipt/v0` 输出。
  - **路线：Adapter first**（L0 审计见 `LIUHE-LITE-FEASIBILITY.md`）——原子写 / 事务日记 / 路径守卫 / Undo / 三方 hash 恢复全部复用六合现成实现，Lite **不新造事务引擎**。
  - **自包含**：把 Lite 真正用到的 malong 写路径原语 vendor 进本包（`vendor/malong/`），因此本包**零第三方运行时依赖、不需要 Rust malong-parse、不需要 SQLite**（L16 用「假 parser 标记文件」实证）。
  - **失败语义**：超时/异常不折算成「失败且无副作用」→ `indeterminate`；同 `request_id` 未收口的重试不盲目再执行；版本冲突一律 fail-closed 绝不覆盖；证据不足就 `needs_review` / `indeterminate`；`verification` 恒为 `not_run`（写入成功 ≠ 代码语义正确）。
  - **测试**：`npm test` = L01–L16 反例矩阵（每条核对真实磁盘效果）+ 与产品 `writeSymbol` 的落盘对照（parity）。CI 已挂（3 平台；Windows 上 L10/L15 因符号链接需特权记 SKIP）。
  - **给 Cell 侧的四件东西**：`examples/cell-adapter.mjs`（接线参考实现：宿主给工作区、工作区类入参一律拒、错误处置建议）、`INTEGRATION-GUIDE.md`（接入指南）、`RECEIPT-FIELD-ALIGNMENT.md`（回执逐字段 + 需土行孙确认的 6 项）、`tests/cell-acceptance.mjs`（同步点 C 验收 12 项，可指向真实工作区做只读检查）。
  - **L15 改为经适配层联调**（不再是裸 editor）：工作区类入参被授权边界拒 + 跨工作区/绝对路径/符号链一律 `PATH_OUT_OF_SCOPE` + B 工作区真实磁盘未被触动。但仍是进程内验证；和土行孙 Cell 的真接线是同步点 C，需他们接。
  - 交付包由 `node scripts/pack-lite.mjs` 生成到 `dist/`（含 `SHA256SUMS`）；**产物指纹不写在本文件**——本文件会在包里，写死指纹就变成“改文档→改指纹”的自指。指纹记录在仓库根 `CHANGELOG.md` 的 LiuHe Lite 条目。
