#!/usr/bin/env bash
# 外部消费者验收（专家 rc.34 裁决 §5.4）：在一个**空的、脱离源码树**的目录里，用发布 tarball
# 装出 `tusunsun`，再用裸包名跑 Cell / 工具任务。
#
# 用法：bash verification/external-consumer/run.sh <path/to/tusunsun-<ver>.tgz>
# 输出：逐步结论 + 每阶段一段 JSON 回执；退出码 0 = 六个步骤全部成立。
#
# 为什么值得单独跑：`npm run check`、单测、门禁全都在**源码树里**跑 —— 它们证明"仓库里的
# 那份代码是对的"，不证明"发布 tarball 装到别人机器上能用"。这里装的是 tarball 本身。
#
# 一个阶段一个进程：v0 是 1 Cell : 1 Core : 1 OS process，同进程建第二个 Cell 会被
# `cell_quota_exceeded` 拒（consumer.mjs 顶部的注释写了原因）。
set -u

TGZ=${1:?usage: run.sh <path/to/tusunsun-x.y.z.tgz>}
TGZ=$(cd "$(dirname "$TGZ")" && pwd)/$(basename "$TGZ")
[ -f "$TGZ" ] || { echo "找不到制品：$TGZ" >&2; exit 2; }

HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d /tmp/tusunsun-ext-consumer-XXXXXX)
FAILED=0
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

echo "== 1. 空目录 + 离线安装发布 tarball =="
mkdir -p "$WORK/consumer" || exit 2
cd "$WORK/consumer" || exit 2
printf '{\n  "name": "tusunsun-external-consumer",\n  "private": true,\n  "type": "module"\n}\n' > package.json
# `--offline`：不访问网络；`--ignore-scripts`：不为验收放开安装期脚本。
if ! npm install --offline --ignore-scripts --no-audit --no-fund "$TGZ" >/tmp/ext-consumer-install.log 2>&1; then
  echo "FAIL 安装失败，日志：/tmp/ext-consumer-install.log" >&2
  tail -20 /tmp/ext-consumer-install.log >&2
  exit 1
fi
echo "PASS 安装成功：$(node -e "import('tusunsun/package.json',{with:{type:'json'}}).then(m=>console.log(m.default.name+'@'+m.default.version))")"
echo "     位于 $WORK/consumer/node_modules/tusunsun（土行孙源码树不在模块搜索路径里）"
cp "$HERE/consumer.mjs" ./consumer.mjs

run_phase() {
  local name=$1 dir=$2
  echo
  echo "== $name（独立进程，base=$dir）=="
  mkdir -p "$dir"
  if node consumer.mjs "$name" "$dir"; then
    :
  else
    FAILED=1
  fi
}

# 阶段一：正常执行 → 失败恢复 → 关闭（base/main 里留下上一世 stopped 的状态）
run_phase run   "$WORK/main"
# 阶段二：权限拒绝（另一份 stateDir，因为 1 Cell : 1 Core 不允许同进程换能力）
run_phase deny  "$WORK/deny"
# 阶段三：**新进程**在同一份 stateDir 上重建同一个 cell_id —— 上一世 stopped 必须被读回
run_phase restart "$WORK/main"
# 阶段四：另一份 stateDir 上的新身份，照常跑任务
run_phase after "$WORK/after"

echo
if [ "$FAILED" -eq 0 ]; then
  echo "EXTERNAL-CONSUMER PASS（四个阶段都是 exit 0）"
  exit 0
fi
echo "EXTERNAL-CONSUMER FAIL（见上面各阶段）"
exit 1
