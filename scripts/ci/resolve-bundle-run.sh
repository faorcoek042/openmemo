#!/usr/bin/env bash
# 找出「哪一次 build-bundles run 里有我要的那个预编译包」，把 run id 打到 stdout。
#
# ── 为什么这是一个脚本，而不是 workflow 里的两段 run: ──────────────────────────────
#
# 它**本来**就是 workflow 里抄了两份的 shell（audit 一份、mutations 一份）。
# `[实测 run 31249523201]` 我修了其中一份，另一份原样留着 ——
# 于是 mutations 那条腿继续按"最近一次成功的 run"取件，
# 而最近一次恰好是 `legs=macos` 的单腿 run，只有 darwin 产物：
# **linux 的变异验证整个 job 挂在 `Artifact not found`**，
# 一个与产品毫无关系的红。
#
# 判据照 PROTOCOL 的老规矩：不是"记得两边一起改"，是**不可能只改一边**。
#
# ── 判据本身 ──────────────────────────────────────────────────────────────────────
#
# 挑的依据是「**这次 run 里有我这条腿要的 artifact，且没过期**」，
# 不是「它是最近一次成功的 run」：
#   · build-bundles 有 `legs` 输入，可以只编一条腿 ⇒ 最近一次成功可能只有一个平台；
#   · artifact 有保留期 ⇒ 存在过不等于现在还能下。
# 两条都得看，少看一条就会得到一个"看起来像包坏了"的红。
#
# 用法：resolve-bundle-run.sh <artifact 名> [给定的 run id]
#   给了 run id 就原样回显（人工指定优先，调试时要能钉住某一次）。
set -euo pipefail

WANT="${1:?用法: resolve-bundle-run.sh <artifact 名> [run id]}"
GIVEN="${2:-}"
REPO="${GITHUB_REPOSITORY:?需要 GITHUB_REPOSITORY}"

if [ -n "$GIVEN" ]; then
  echo "$GIVEN"
  exit 0
fi

# stderr 用来解释过程，stdout **只**放 run id —— 调用方是 `$(...)`，
# 混一个字进去它就拿到一个不存在的 run。
for cand in $(gh api "repos/${REPO}/actions/workflows/build-bundles.yml/runs?status=success&per_page=20" \
  --jq '.workflow_runs[].id'); do
  if gh api "repos/${REPO}/actions/runs/${cand}/artifacts" \
    --jq '.artifacts[] | select(.expired==false) | .name' 2>/dev/null | grep -qx "$WANT"; then
    echo "选中 build-bundles run ${cand}: 它有未过期的 ${WANT}" >&2
    echo "$cand"
    exit 0
  fi
  echo "  run ${cand} 里没有未过期的 ${WANT}, 继续往前找" >&2
done

echo "::error::最近 20 次成功的 build-bundles run 里都没有未过期的 ${WANT} —— 先跑一次 build-bundles(legs=all), 或用 bundlesRunId 指定" >&2
exit 1
