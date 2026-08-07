#!/usr/bin/env bash
#
# buildbox.sh —— 在 `scripts/ci/buildbox.Dockerfile` 造出来的容器里跑一条命令。
#
# 设计理由见 buildbox.Dockerfile 的文件头（一句话：**runner 标签的生命周期由 GitHub 决定，
# 而 glibc 下限是我们对用户机器的承诺，这两件事不该绑在一起**）。
# 本文件负责的是另一半：**把宿主上那几样必须可见的东西挂进去，并且挂不上就当场红。**
#
# ## 为什么"挂不上就当场红"是这个脚本存在的主要理由
#
# 容器化最容易出的不是"跑不起来"，是**跑起来了但少挂了一个目录**：
#   · `$GITHUB_OUTPUT` 没挂进去 → `build-whisper.sh` 往一个容器内的临时文件写
#     `pack_id=` / `stage_dir=` → 宿主这边读到**空字符串** → 后面每一步都拿空路径干活。
#     `check-elf-glibc.mjs` 会因为"一个 ELF 都没数到"而红（它有那条守卫），
#     但 `upload-artifact` 之类不会 —— **一部分步骤静默地对着空气工作**。
#   · `$CCACHE_DIR` 没挂进去 → ccache 在容器里换了个目录，**每次全量重编**，
#     只表现为"CI 变慢了"，没有任何一处会说话。
#   · `$VULKAN_SDK` 没挂进去 → configure 阶段红（这条反而是好的，因为它吵）。
#
# 所以：**每一条要用的路径都在这里先断言"在某个挂载根底下"，不在就 exit 1 并说清楚是哪一条。**
# 判据不是"记得加 -v"，是"忘了加会当场红"。
#
# ## 为什么用 `--user $(id -u):$(id -g)` 而不是 root + 事后 chown
#
# root 跑出来的产物归 root，宿主这边（uid 1001 的 runner）后续步骤要读它、
# `actions/cache` 的 post 步骤要打包 ccache 目录 —— 于是要补一条 `chown -R`。
# 那条 chown **只在正常结束时跑**，和 PROTOCOL §9-bis 里那个 `after()` 是同一个形状：
# 中途失败就留下一地 root 文件。用 `--user` 从根上不产生这个状态。
# 附带解决 git 的 "detected dubious ownership"（uid 与 owner 一致就不会触发）。
# 代价：容器里没有对应的 passwd 条目 → `$HOME` 必须显式给一个可写的挂载内目录。
#
# ## 用法
#
#   scripts/ci/buildbox.sh --report                 # 打印并断言编译环境自身的 glibc
#   scripts/ci/buildbox.sh <cmd> [args...]          # 在容器里跑 <cmd>
#
# 环境变量（CI 上由 build-backends.yml 提供）：
#   BUILDBOX_IMAGE      必填，`docker build -t` 出来的 tag
#   BUILDBOX_MAX_GLIBC  可选，默认 2.35；--report 断言容器自身 glibc ≤ 它
#   GITHUB_WORKSPACE / RUNNER_TEMP / CCACHE_DIR   必须存在且会被挂载
#   VULKAN_SDK / LD_LIBRARY_PATH / GITHUB_OUTPUT / CCACHE_MAXSIZE   有就带进去
#
set -Eeuo pipefail

die() { printf '\033[31mbuildbox: %s\033[0m\n' "$*" >&2; exit 1; }
log() { printf '\033[36m==> buildbox:\033[0m %s\n' "$*" >&2; }

DOCKER="${DOCKER:-docker}"
IMAGE="${BUILDBOX_IMAGE:-}"
[[ -n "${IMAGE}" ]] || die "BUILDBOX_IMAGE 没设 —— 不知道该在哪个镜像里跑"

command -v "${DOCKER}" >/dev/null 2>&1 \
  || die "宿主上没有 \`${DOCKER}\`。**「我拿不到」≠「这里没有问题」** —— 没有它就没法把
  编译环境与 runner 镜像解耦，而直接在 runner 上编会把 GLIBC 下限抬到宿主的版本。"

# --------------------------------------------------------------------------------------
# 挂载根：宿主上这几个目录会以**同一个绝对路径**出现在容器里。
# 同路径挂载是刻意的 —— `$GITHUB_OUTPUT` / `$CCACHE_DIR` 这些变量是宿主算出来的，
# 路径一变就得在两边各翻译一次，而翻译错了是静默的。
# --------------------------------------------------------------------------------------
MOUNTS=()
MOUNT_ROOTS=()

add_mount() {
  local path="$1" what="$2" required="$3"
  if [[ -z "${path}" ]]; then
    [[ "${required}" == "required" ]] && die "${what} 是空的"
    return 0
  fi
  if [[ ! -d "${path}" ]]; then
    [[ "${required}" == "required" ]] && die "${what} 指向 \`${path}\`，但那不是一个目录"
    return 0
  fi
  # 规范化，免得 `/a/b/` 与 `/a/b` 被当成两条
  path="$(cd "${path}" && pwd -P)"
  for existing in ${MOUNT_ROOTS[@]+"${MOUNT_ROOTS[@]}"}; do
    [[ "${path}" == "${existing}" ]] && return 0
  done
  MOUNT_ROOTS+=("${path}")
  MOUNTS+=(-v "${path}:${path}")
}

# `is_inside <路径> <说明>` —— 断言某个**文件**路径落在已挂载的根底下。
# 这就是上面文件头讲的那条：忘了挂就当场红，而不是让某一步对着空气工作。
is_inside() {
  local target="$1" what="$2"
  [[ -n "${target}" ]] || return 0
  local root
  for root in ${MOUNT_ROOTS[@]+"${MOUNT_ROOTS[@]}"}; do
    [[ "${target}" == "${root}" || "${target}" == "${root}/"* ]] && return 0
  done
  die "${what} = \`${target}\`，**不在任何一个挂载根底下**（挂载根：${MOUNT_ROOTS[*]}）。
  容器里那条路径要么不存在、要么指向容器自己的一个临时文件，
  两种情况都不会报错，只会让宿主这边读到空值 —— 这正是本脚本存在的理由。
  修法是在 buildbox.sh 里把它的目录加进 add_mount，不是把这条断言删掉。"
}

WORKSPACE="${GITHUB_WORKSPACE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)}"

# ccache 的目录**可能还不存在**：`ggml-org/ccache-action` 只写 ccache 的配置文件，
# 真正建目录的是 `actions/cache` 的恢复步骤 —— 而**冷缓存（第一次跑）没有命中就不会建**。
# 不先建的话下面 `is_inside` 会当场红，而那是一条"环境正常但守卫误伤"的假红。
# `VULKAN_SDK` **刻意不 mkdir**：它不存在就是真的出问题了，那条红是对的。
[[ -n "${CCACHE_DIR:-}" ]] && mkdir -p "${CCACHE_DIR}"

add_mount "${WORKSPACE}"           'GITHUB_WORKSPACE'  required
add_mount "${RUNNER_TEMP:-}"       'RUNNER_TEMP'       optional
add_mount "${CCACHE_DIR:-}"        'CCACHE_DIR'        optional
add_mount "${VULKAN_SDK:-}"        'VULKAN_SDK'        optional

# node：`build-whisper.sh` 用它跑 `emit-pack-manifest.mjs`（脚本里 `command -v node` 拿不到
# 就 die）。jammy 的 apt 只有 node 12，所以不装，直接把 runner 上 setup-node 装好的那个
# 挂进去 —— 官方 linux-x64 构建的下限是 GLIBC_2.28，在 2.35 的容器里跑得动。
NODE_BIN=""
if NODE_PATH_HOST="$(command -v node 2>/dev/null)"; then
  NODE_BIN="$(cd "$(dirname "${NODE_PATH_HOST}")" && pwd -P)"
  add_mount "${NODE_BIN}" 'node bin 目录' optional
fi

# 容器里的 $HOME。没有 passwd 条目时 HOME 是空的，而 ccache / cmake 都会去写它。
# 放在 RUNNER_TEMP（或 workspace）底下，随 job 一起消失。
BUILDBOX_HOME="${RUNNER_TEMP:-${WORKSPACE}}/buildbox-home"
mkdir -p "${BUILDBOX_HOME}"
add_mount "${BUILDBOX_HOME}" 'buildbox HOME' required

is_inside "${GITHUB_OUTPUT:-}" 'GITHUB_OUTPUT'
is_inside "${GITHUB_ENV:-}"    'GITHUB_ENV'
is_inside "${GITHUB_STEP_SUMMARY:-}" 'GITHUB_STEP_SUMMARY'
is_inside "${VULKAN_SDK:-}"    'VULKAN_SDK'
is_inside "${CCACHE_DIR:-}"    'CCACHE_DIR'

ENVS=(-e "HOME=${BUILDBOX_HOME}")
for v in CI GITHUB_OUTPUT GITHUB_ENV GITHUB_STEP_SUMMARY GITHUB_WORKSPACE \
         CCACHE_DIR CCACHE_MAXSIZE VULKAN_SDK LD_LIBRARY_PATH CC CXX; do
  [[ -n "${!v:-}" ]] && ENVS+=(-e "${v}=${!v}")
done

# 宿主的 node 目录接在 PATH 前面。容器里的 PATH 由镜像的 ENV 决定（含 CUDA），
# 这里只**追加**，不覆盖 —— 覆盖会把 nvcc 从 PATH 上打掉，而那个失败发生在 configure 阶段。
# 同理下面用的是 `bash -c` 而**不是** `bash -lc`：登录 shell 会去跑 `/etc/profile` 与
# `/etc/profile.d/*`，那里面有把 PATH 重写掉的东西，而重写掉 CUDA 那一段是静默的。
if [[ -n "${NODE_BIN}" ]]; then
  ENVS+=(-e "BUILDBOX_NODE_BIN=${NODE_BIN}")
fi

run_in_box() {
  "${DOCKER}" run --rm \
    --user "$(id -u):$(id -g)" \
    ${MOUNTS[@]+"${MOUNTS[@]}"} \
    "${ENVS[@]}" \
    -w "${WORKSPACE}" \
    "${IMAGE}" \
    bash -c 'if [ -n "${BUILDBOX_NODE_BIN:-}" ]; then export PATH="${BUILDBOX_NODE_BIN}:${PATH}"; fi; exec "$@"' \
    buildbox "$@"
}

# --------------------------------------------------------------------------------------
# --report：把编译环境自己的版本打出来，并**断言它的 glibc 不高于基线**。
#
# 这一条不是装饰：它回答的是「我们以为在容器里编，实际上是不是」。
# 如果哪天镜像被顺手换成 `ubuntu:24.04`，这里会当场红，
# 而不是等到 `check-elf-glibc` 那一步（那一步也会红，但要等整个编译跑完）。
# --------------------------------------------------------------------------------------
if [[ "${1:-}" == "--report" ]]; then
  MAX_GLIBC="${BUILDBOX_MAX_GLIBC:-2.35}"
  host_ldd="$(ldd --version 2>&1 || true)"
  log "image = ${IMAGE}"
  log "挂载根 = ${MOUNT_ROOTS[*]}"
  log "宿主 glibc = ${host_ldd%%$'\n'*}"
  # ⚠️ 容器里那段刻意**一个 `| head` 都不用**。`set -e` + `pipefail` 下 `head` 读够就退出，
  #    上游命令拿到 SIGPIPE（141），整条管道被判失败，脚本当场死掉 —— 而且是**竞态**，
  #    本机实测同一条用例两次跑出不同结果。一个时灵时不灵的判据比没有判据更坏。
  out="$(run_in_box bash -c '
    set -u
    # herestring（<<<）不是管道，不会有 SIGPIPE；这就是这里不用 `| head -1` 的全部原因。
    first() { local o line; o="$("$@" 2>&1 || true)"; IFS= read -r line <<< "$o" || true; printf "%s\n" "$line"; }
    first ldd --version
    first gcc --version
    first cmake --version
    first ccache --version
    if command -v node  >/dev/null 2>&1; then first node --version; else echo "node: 不可用（build-whisper.sh 会 die）"; fi
    if command -v nvcc  >/dev/null 2>&1; then nvcc --version 2>&1 || true; fi
    if command -v glslc >/dev/null 2>&1; then first glslc --version; fi
  ')"
  printf '%s\n' "${out}"
  box_glibc="$(printf '%s' "${out%%$'\n'*}" | grep -oE '[0-9]+\.[0-9]+$' || true)"
  [[ -n "${box_glibc}" ]] \
    || die "从容器的 \`ldd --version\` 里没解析出版本号。**解析不出来 ≠ 没问题** —— 拒绝继续。"
  # 数值比较，不是字符串比较：字符串比会把 2.9 判成大于 2.35（check-elf-glibc.mjs 同一条教训）
  awk -v a="${box_glibc}" -v b="${MAX_GLIBC}" 'BEGIN{
    split(a,x,"."); split(b,y,".");
    if (x[1]>y[1] || (x[1]==y[1] && x[2]>y[2])) exit 1; exit 0 }' \
    || die "编译环境自己的 glibc 是 ${box_glibc}，高于基线 ${MAX_GLIBC}。
  产物的下限不可能低于编译环境的 —— 换回一个 glibc ≤ ${MAX_GLIBC} 的 BASE_IMAGE。"
  log "编译环境 glibc = ${box_glibc} ≤ ${MAX_GLIBC} ✔"
  exit 0
fi

[[ $# -gt 0 ]] || die "没有给要执行的命令（用法见文件头）"
run_in_box "$@"
