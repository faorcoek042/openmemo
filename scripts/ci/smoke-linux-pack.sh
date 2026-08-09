#!/usr/bin/env bash
#
# smoke-linux-pack.sh —— 把打好的 Linux 包解到别处、在**编译环境**里裸跑一次。
#
# 这段逻辑原来是 `build-backends.yml` 里的一段内联 shell（T-161 加的）。T-163 把它搬成
# 文件，理由和 C1/C3 把 `node -e` 搬出 YAML 是同一条：**内联在 YAML 里的脚本没有任何测试
# 碰得到它**。反向用例见 `scripts/ci/selftest-buildbox.sh`。
#
# ## 它回答两个问题（都只在 x64 Linux 上成立）
#
#   ① **这个包自包含吗** —— 解到一个全新目录、`env -u LD_LIBRARY_PATH ./whisper-cli --help`
#      起得来，就说明它不依赖任何**别的包**的目录。
#      （T-161 修复前：Vulkan 包里只有一个 `libggml-vulkan.so`，`dlopen` 报
#        `libggml-base.so.0: cannot open shared object file`。）
#   ② **加速模块自己的依赖解析得了吗** —— `ldd` 里不该再有 `libggml-*` 的 `not found`。
#
# ## ⚠️ 它**必须**跑在 buildbox 容器里，不是 runner 上（T-163）
#
# T-163 把三条 Linux 腿的 runner 从 `ubuntu-22.04` 升到 `ubuntu-24.04`，编译挪进
# glibc 2.35 的容器。如果这条烟雾测试留在宿主上跑，它证明的就变成
# 「这个包在 **Ubuntu 24.04** 上跑得起来」—— 而那是一句弱得多的话：
# 一个需要 GLIBC_2.38 的产物在 2.39 的宿主上照样跑得欢，正是 D-11 §8.2 那个 bug 的原貌。
# 判据要跑在**下限那一侧**才算数。
#
# ## 能力边界（照 D-11 §3.4 的判据写清楚）
#
# 「构建机上"能做到"不等于用户机器上"能做到"；只有构建机上"做不到"才是硬结论。」
# 容器里挂着 Vulkan SDK / 装着 CUDA，所以 `libvulkan.so.1` / `libcudart.so.12` 这类
# **由构建环境提供**的依赖在这里一定解析得到，用户机器上未必。因此断言**只收窄到
# `libggml-*`** —— 那些是我们自己应当随包出厂的。
# 「一条会对不相干的东西发表意见的检查，说对的时候也不该被相信。」
#
# 已知一条这里验不出来的真缺口：Linux 的 CUDA 包链的是 `CUDA::cudart`（动态，
# `ggml-cuda/CMakeLists.txt:176`，我们没开 `GGML_STATIC`），而打包时只拷了 Windows 命名的
# `cudart64_*.dll` —— Linux 侧一个都没拷。→ 没装 CUDA 工具链的机器上仍然装了没用。
#
# 用法：
#   scripts/ci/smoke-linux-pack.sh --archive <pack.tar.gz> --pack-id <id> --backend <cpu|vulkan|cuda>
#
set -Eeuo pipefail

die() { printf '::error::%s\n' "$*"; exit 1; }

ARCHIVE=""; PACK_ID=""; BACKEND=""; WORKDIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --archive) ARCHIVE="$2"; shift 2 ;;
    --pack-id) PACK_ID="$2"; shift 2 ;;
    --backend) BACKEND="$2"; shift 2 ;;
    --workdir) WORKDIR="$2"; shift 2 ;;
    *) die "smoke-linux-pack.sh: 不认识的参数 $1" ;;
  esac
done

[[ -n "${PACK_ID}" ]] || die "build 步骤没有报出 pack_id —— 空的 pack id 会让下面每一条断言对着空气工作"
[[ -n "${BACKEND}" ]] || die "缺 --backend"
[[ -n "${ARCHIVE}" ]] || die "缺 --archive"
[[ -f "${ARCHIVE}" ]] || die "找不到归档 ${ARCHIVE}"

WORKDIR="${WORKDIR:-${TMPDIR:-/tmp}/openmemo-smoke}"
rm -rf "${WORKDIR}"
mkdir -p "${WORKDIR}"
tar xzf "${ARCHIVE}" -C "${WORKDIR}"

PACK_DIR="${WORKDIR}/${PACK_ID}"
[[ -d "${PACK_DIR}" ]] || die "归档解开后没有 ${PACK_ID}/ 这个目录（实得：$(ls -A "${WORKDIR}" | tr '\n' ' '))"
cd "${PACK_DIR}"

# ⚠️ **不要写成 `ldd --version | head -1`**。`set -Eeuo pipefail` 下，`head` 读满一行就退出，
# `ldd` 拿到 SIGPIPE（退出码 141），`pipefail` 把 141 当成整条管道的状态 → `set -e` 当场杀掉脚本。
# 这是**竞态**：ldd 写得快就没事，写得慢就死 —— 本机实测同一条用例两次跑出不同结果。
# 一个时灵时不灵的判据，比没有判据更坏。所以先整段取回来，再用参数展开取第一行。
ldd_version="$(ldd --version 2>&1 || true)"
echo "== 编译/运行环境 =="
printf '%s\n' "${ldd_version%%$'\n'*}"

# `--help` 走的是 **stderr**（whisper.cpp 的 `whisper_print_usage`），只重定向 stdout 的话
# 它会把 100 多行用法信息灌进 job 日志，正好淹掉紧接着那段 `ldd` 输出 —— 而 `ldd` 那几行
# 才是这一步要留的证据。但**不能直接丢掉**：失败时那段输出就是唯一的线索。
if ! env -u LD_LIBRARY_PATH ./whisper-cli --help > "${WORKDIR}/help.log" 2>&1; then
  echo "::error::whisper-cli 在解压目录里跑不起来 —— 这个包不是自包含的"
  cat "${WORKDIR}/help.log"
  exit 1
fi
echo "pack is relocatable"

if [[ "${BACKEND}" == "cpu" ]]; then
  exit 0
fi

MOD="libggml-${BACKEND}.so"
[[ -e "${MOD}" ]] || die "${MOD} 不在包里 —— 加速包没有加速器"

LDD_OUT="$(ldd "${MOD}" 2>&1 || true)"
echo "== ldd ${MOD} =="
printf '%s\n' "${LDD_OUT}"

# ★ 这里原来写的是 `ldd "$mod" | grep 'not found' | grep -q 'libggml'`（T-161 的内联版本）。
#   `grep -q` 一命中就立刻退出 → 中间那个 `grep` 写不下去拿到 SIGPIPE → `pipefail` 下
#   整条管道的状态变成 141（非零）→ `if` 判为**假** → **该报的红没报**。
#   `[本机实测]` 分界在管道缓冲区那一格：匹配行数 ≤ 120 时命中（正确），≥ 150 时被吞。
#   **诚实边界**：真包里不会有 150 条 not found，所以这一条在实际输入上不会发生 ——
#   我没有把它说成"已经在害人"。真正逼出这次改写的是同一族的
#   `ldd --version | head -1`：那条**必然执行**，且已在本机以 rc=141 复现（同一条自检
#   两次跑出不同结果）。一个时灵时不灵的判据，说对的时候也不该被相信，
#   所以两处一起改成"先取回文本再匹配"，一条管道都不留。
MISSING="$(printf '%s\n' "${LDD_OUT}" | grep 'not found' || true)"
# 只对 **我们自己应当随包出厂的** 那些库断言（`libggml-*`）—— 见文件头「能力边界」。
if [[ "${MISSING}" == *libggml* ]]; then
  echo "::error::${MOD} 依赖的某个 libggml-* 解析不到（见上面 ldd 输出）。"
  echo "::error::这正是 D-11 §8.4 第 2 条：找到了模块，模块自己也加载不起来。"
  echo "::error::修复前实测：dlopen 报 'libggml-base.so.0: cannot open shared object file'。"
  exit 1
fi
echo "${MOD} 的 libggml-* 依赖全部解析得到（其余为宿主提供，见上）"

# ★★ T-190：上面那条只问 `libggml-*`。**它答不了 CUDA 补齐运行库之后的那个新问题** ——
#
#   `libggml-cuda.so` 的 RUNPATH 是 `$ORIGIN`，而 **RUNPATH 不作用于传递依赖**：
#   包里放进了 `libcublas.so.12`，但它自己要的 `libcublasLt.so.12` 能不能被找到，
#   取决于 **libcublas 自己有没有 RPATH/RUNPATH** —— 那是 NVIDIA 决定的，不是我们。
#   「文件在包里」（`pack-native-deps.mjs --verify` 管这一层）**不等于**「加载得起来」。
#
#   所以这里把断言从"libggml-* 不许 not found"扩到"**任何** not found 都算红"，
#   只放行显式列出的那几个 **驱动提供** 的（与 `pack-native-deps.mjs` 的 DRIVER_PROVIDED 同义）：
#   runner 上没有 NVIDIA 显示驱动，`libcuda.so.1 => not found` 是**预期**的，
#   而且它按 NVIDIA 的条款本来就不许随包分发。
#
#   ⚠️ 能力边界不变（D-11 §3.4）：runner 上"解析得到"≠ 用户机器上"解析得到"；
#   只有 runner 上"解析不到"才是硬结论。这一条加的是后者的覆盖面。
UNEXPECTED="$(printf '%s\n' "${MISSING}" \
  | grep -v -E '^\s*(libcuda\.so\.[0-9]+|libnvidia-[a-z]+\.so\.[0-9]+|libvulkan\.so\.[0-9]+)\s' || true)"
if [[ -n "${UNEXPECTED//[[:space:]]/}" ]]; then
  echo "::error::${MOD} 有解析不到的依赖，而它们不在「驱动提供」白名单里："
  printf '%s\n' "${UNEXPECTED}"
  echo "::error::「文件在包里」不等于「加载得起来」—— RUNPATH 不作用于传递依赖。"
  exit 1
fi
echo "${MOD} 的依赖全部解析得到（未解析的只有驱动提供的那几个，见上）"
