# LiuHe Lite — 面向土行孙 Cell 的可选器官

给**没有代码图谱、没有复杂 Agent 框架**的最小 Cell，提供高风险文件操作时的「感知 → 核验 → 有限恢复」能力。

- **不改土行孙授权真值**：工作区可信源由宿主运行时给出，Lite 只做作用域内的文件动作。
- **不重写编辑引擎**：原子写、事务日记、路径守卫、Undo、三方 hash 恢复全部复用六合现成实现（`malong/write-runtime.js` / `write-journal.js` / `path-guard.js`）。
- **不假装更懂代码**：不跑测试、不建索引、不解析符号 → `verification` 恒为 `not_run`。

## 这是一个独立的包（独立版本线）

| 项 | 值 |
|---|---|
| 包名 / 版本 | **`@jieai/liuhe-lite` 0.1.3** |
| 版本线 | **自己的 `0.x` 线**——不占主包 `@jieai/dsh-malong-bridge` 的 `0.5.x`，也不进主包 |
| 运行时依赖 | **0 个**（只用 `node:` 内置；自带 `vendor/malong/` 写路径原语 → 自包含） |
| 需要 Rust / SQLite？ | **都不需要** |
| 交付包 | **本包即交付物（解包即用，无需另取 `dist/`）**。仓库内另有 `dist/`（tgz + `SHA256SUMS`，不随包分发）；不发布 npm。指纹权威记录：仓库根 `CHANGELOG.md`（避免「文档进包」自指） |
| 供应链可追 | `vendor/malong/PROVENANCE.json`（源仓库 / 许可证 / 逐文件 sha256 + 最后改动 commit）；`node tests/provenance.mjs` 双向核对 |

```bash
# 本地打包（自包含：把用到的 malong 原语 vendor 进包）
node scripts/pack-lite.mjs            # 打包 + 打印指纹
node scripts/pack-lite.mjs --verify   # 再把 tarball 装进临时目录跑一遍闭环
```

安装方**不依赖 npm 发布**：用 tarball 解包，或直接引用仓库目录。

## 交给土行孙的东西（一页清单）

| 交什么 | 在哪 | 作用 |
|---|---|---|
| 包 | **`integration/liuhe-lite/` 目录；或仓库内 `dist/jieai-liuhe-lite-0.1.3.tgz`（`dist/` 只在仓库，不随包分发）** | 解包即用，不装 npm、零第三方依赖 |
| 接入指南 | `INTEGRATION-GUIDE.md` | 三步接入 / 六动作契约 / 错误处置 / 取消语义 / 边界 |
| 接线样例 | `examples/cell-adapter.mjs` | 可整段抄：宿主给工作区 + 工作区类入参拒绝 + 错误处置建议 |
| 字段对齐表 | `RECEIPT-FIELD-ALIGNMENT.md` | 回执逐字段 + **需他们确认的 6 项** |
| 验收脚本 | `tests/cell-acceptance.mjs` | 同步点 C：12 项，可指向他们真实工作区做只读检查 |

**定位说清楚**：L15 我们已经改成「经适配层联调」，但它仍是**进程内**的；真正的“和土行孙 Cell 跑一次完整闭环”是同步点 C，**必须他们接**——我们不假装已经做完了。

**交付单位是 tarball，不是这个目录**：裸目录 `import ../../../malong/*.js`，单独拷出去会 `ERR_MODULE_NOT_FOUND`（已实测对比：裸目录报错 / tarball 解包后 12/12 通过）。

## 快速开始

```bash
cd integration/liuhe-lite

# ① 最小可运行 PoC（无需任何 LLM Key）
node examples/poc.mjs

# ② 反例矩阵 L01–L28（真实磁盘判定）
node tests/run.mjs                    # 报表写到 reports/matrix-report.md

# ③ 与产品写路径的落盘对照
node tests/parity.mjs                 # 15/15

# ④ 非功能基线（体积 / 冷启动 / RSS / 依赖）
node tests/baseline.mjs

# ⑤ 独立包（自包含）
node scripts/pack-lite.mjs --verify

# ⑥ 同步点 C 验收（12 项；可加 LITE_CELL_WORKSPACE=... 做只读检查）
node tests/cell-acceptance.mjs

# ⑦ 文档声明机械核对（路径/命令/错误码表/项数/报表数字/禁用措辞/链接）
node tests/docs-claims.mjs
```

## 最小 API

```js
import { createLiteEditor } from './lite/index.js'

// 工作区可信源来自宿主运行时，不是模型参数
const editor = createLiteEditor({
  workspace: { realPath: '/abs/cell/workspace' },
  cell: { cellId: 'cell-A', incarnationId: 'run-1', taskId: 'task-1' },
})

const anchor = editor.readAnchor({ path: 'src/main.js' })          // 写前锚点（实测 hash）
const pv = editor.preview({ anchor: anchor.anchor, newContent })    // 预览（不写盘）
const r = await editor.apply({ anchor: anchor.anchor, newContent, requestId: 'req-1' })
r.receipt.effect.after_sha256                                      // 写后回读实测的 hash
editor.inspect({ actionId: r.receipt.action_id })                   // 动作效果详情
await editor.undo({ recoveryRef: r.receipt.recovery.ref, requestId: 'req-2' })
editor.reconcile({ actionId: r.receipt.action_id })                 // 事后对账（只读）
```

| 动作 | 作用 | 失败时 |
|---|---|---|
| `readAnchor` | 读回真实目标 + 内容 hash + 存在性 | `PATH_OUT_OF_SCOPE` / `FILE_TOO_LARGE` / `UNSUPPORTED_ENCODING` |
| `preview` | 算差异与预计 hash，**不写盘** | `VERSION_CONFLICT`（锚点已过期） |
| `apply` | 锚点校验 → 日记 → 原子写 → 回读实测 | `VERSION_CONFLICT` / `PERSISTENCE_FAILED` / `WRITE_FAILED` / `INDETERMINATE` / `REQUEST_CONFLICT` |
| `inspect` | 动作效果详情（按需查，不塞每轮上下文） | `RECOVERY_UNAVAILABLE` |
| `undo` | 撤销（要求文件仍是那次动作的版本） | `UNDO_CONFLICT` / `RECOVERY_UNAVAILABLE` / `NOT_UNDOABLE` |
| `reconcile` | 事后对账（journal + 前/后版本三方判定） | `INDETERMINATE`（无证据） |

## 目录

```
integration/liuhe-lite/
├── README.md                      本文件
├── CHANGELOG.md                   Lite 自己的版本日志（独立版本线）
├── package.json                   @jieai/liuhe-lite 的独立包清单
├── LIUHE-LITE-FEASIBILITY.md      L0 复用性审计（同步点 A 的交付物）
├── ACTION-RECEIPT-MAPPING.md     动作回执映射表（交付清单第 5 项）
├── SAFETY.md                      安全声明（交付清单第 7 项）
├── INTEGRATION-GUIDE.md           给土行孙的接入指南（怎么接、错误怎么处置、验收怎么跑）
├── RECEIPT-FIELD-ALIGNMENT.md     回执逐字段对齐清单（含需他们确认的 6 项）
├── lite/
│   ├── index.js                   薄适配层（6 个动作）
│   ├── errors.js                  Lite 错误码 + 六合内部码映射
│   └── receipt.js                 Action Receipt v0 构造 + 路径脱敏
├── examples/
│   ├── poc.mjs                    最小闭环示例
│   └── cell-adapter.mjs           **Cell 侧接线参考实现**（宿主给工作区 + 错误处置 + 取消语义）
├── scripts/
│   └── pack-lite.mjs              独立包打包（vendor 化写路径原语）+ --verify 自包含验证
├── tests/
│   ├── cell-acceptance.mjs        **同步点 C 验收脚本**（12 项，可指向你们真实工作区做只读检查）
│   ├── run.mjs                    L01–L28 跑测 + 报表
│   ├── lite-cases.mjs             28 条反例用例
│   ├── harness.mjs                脚手架（真实磁盘快照 / 断言收集）
│   ├── child-apply.mjs            kill -9 用例的子进程
│   ├── child-loop.mjs             独立装配实证（假 parser 标记）
│   ├── parity.mjs                 Lite vs 产品 writeSymbol 落盘对照
│   └── baseline.mjs               非功能基线实测
├── examples/poc.mjs               最小可运行示例
└── reports/                       跑测报表与基线（实测生成）
```

## 现状（实测）

| 项 | 结果 |
|---|---|
| L01–L28 反例矩阵 | **28 / 28 PASS**（仅 Linux 实测；Windows/macOS **NOT_RUN**，未独立复跑，不折算为通过） |
| 其中过期与清扫（L26–L28） | **过期按日记时刻算且三处一致；过期 undo 具名拒绝；apply 后自动清扫自己的过期日记（外来日记不碰）** |
| 其中多进程竞争（L23） | **两个进程同时 undo：磁盘只回滚一次，拒绝理由具名** |
| 其中事务所有权（L17–L19） | **外来事务一律 `FOREIGN_JOURNAL`，磁盘/日记字节级不变** |
| 其中错误合同与幂等（L22/L24–L26） | **所有失败都带 `handling`；同 id 重试复读原回执；过期按日记时刻算；锚点后暴涨的文件不整读** |
| 供应链来源证明 | **`vendor/malong/PROVENANCE.json`：逐文件 sha256 双向核对（含清单外夹带检查）+ 顶层快照锥 `snapshot.commit`（malong/ 子树最后改动提交）** |
| parity（Lite vs 产品写路径） | **15 / 15 PASS** |
| 安装体积（导入闭包） | **240.9 KiB / 17 文件**（仓库内实测；解包后因 import 路径改写约 +0.6 KiB；以 `reports/nonfunctional-baseline.json` 为准，文档机检容差 0） |
| 外部运行时依赖 | **0 个**（只用 `node:` 内置） |
| 冷启动 | **≈95 ms**（口径：测脚本 T0 → **首次 readAnchor 返回**，**不含 Node 引导**；其中模块导入 ≈87 ms。跨机/跨缓存不可比，外部整进程实测会是另一个数；实测值见 `reports/nonfunctional-baseline.json`） |
| RSS（闭环后） | **58.0 MiB** |

## 路线结论（一句话）

**Adapter first，不抽 Lite**：需要的能力在六合现成实现里全都存在且每天在用；抽出来的收益（体积）≈ 0，风险（第二套事务系统）最高。详见 `LIUHE-LITE-FEASIBILITY.md` §6。

## 接入说明（交付清单第 6 项）

- 首个原型**不强制接 MCP**：本目录是普通 ESM 模块，`import` 即用（零构建、零外部依赖）。
- 未来若要跨进程调用，**保留以正式 MCP 作为传输的选择**：
  - Lite 自身不定义 RPC，不引入私有协议；
  - 六个动作与回执 schema 都可直接映射成 MCP tool（`readAnchor` / `preview` / `apply` / `inspect` / `undo` / `reconcile`），
    传输层换成 MCP 后，土行孙侧无需改回执语义。
- 集成位置：本目录在**六合仓库**内，**不提交到土行孙 `src/core/`**；是否整合为可选插件由土行孙专家根据实测决定。

## 边界（不要误读成“已支持”）

- 只处理 UTF-8 文本文件、默认 ≤1 MiB、单文件、单工作区。
- 不跑代码检查（`verification` 恒 `not_run`）；不撤销 shell / 网络 / 远程 API / 外部进程。
- 不是 OS 沙箱；不自动继承 Cell 授权；不越过受权工作区。
- **只能撤销自己创建的事务**（`FOREIGN_JOURNAL`）；不接管产品 `write_symbol` / `edit_batch` / 其它实现的日记。
- 脱敏只覆盖路径类（POSIX / Windows / UNC / 工作区根 / URL 不误伤），**不做密钥与正文的语义级脱敏**。
- 完整边界与证据见 `SAFETY.md`。
