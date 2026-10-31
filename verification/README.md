# verification/ — 形式化验证与证据链

这是**验证产物**目录，不是产品代码目录。`package.json` 的 `files` 不包含它，因此它不会进入发行 `.tgz`。

公开仓保留可复跑的模型、反例与外部消费者验收；**生成物**（`baseline.json`、`reports/`）
不随公开仓提交，运行脚本后在本地产出。

## 看什么

| 路径 | 内容 |
|---|---|
| `contracts/oss-core-v1.md` | F01–F08 不变式（规范）与现状（证据） |
| `model/` | 四份模型（`Lifecycle` / `Ownership` / `HostControl` / `Dependency`）+ 参考 cfg + 突变体 cfg + TLC 供应链 pin |
| `adapter/replay.mjs` | 真实实现重放（跑 `src/`，不是模型） |
| `adapter/mapping.csv` | 模型动作 → 实现位置的逐条映射（`MAPPED` / `PARTIALLY_MAPPED` / `UNMAPPED`） |
| `counterexamples/index.jsonl` | 反例索引；`kind` 区分 `mutant`（模型变体）与 `implementation`（真实重放） |
| `counterexamples/*.mjs` | **独立实现层反例**（不复用单测夹具，自带正控，修后退出 0）：`f05-host-takeover` / `f06-stop-order-vs-stopped` / `r15-01-cross-scc-exemption` / `r15-02-public-reaper` / `r15-03-same-owner-forgery` |
| `external-consumer/` | 脱离源码树的发布 tarball 安装与 Cell 生命周期验收 |
| `perf/` | 性能基线与量法；不进 npm 制品 |
| `run-formal.mjs` | 一把跑完模型轨 + 实现轨，并在本地产出 `reports/` 与 `baseline.json` |

## 跑一次

```bash
node verification/model/fetch-tlc.mjs   # 下载 + 校验 sha256（离线用 TLA2TOOLS_JAR）
node verification/run-formal.mjs        # 模型轨 + 实现轨 → 本地 reports/
for f in verification/counterexamples/*.mjs; do node "$f"; done   # 实现层反例（应全绿）
bash verification/external-consumer/run.sh <path/to/tusunsun-0.20.0.tgz>
```

生成的 `reports/` 与 `baseline.json` 描述的是**运行当时的那棵树**；换树或改文件后必须重跑，
不能把旧报告当当前证据。公开仓不提交这些生成物。
