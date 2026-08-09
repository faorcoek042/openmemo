#!/usr/bin/env bash
#
# ══════════════════════════════════════════════════════════════════════════════════════
#  ⚠️  不进默认流程（ADR-015：上游预编译优先）
#
#  上游 whisper.cpp v1.9.1 已有我们当前需要的产物（T-063 再次实地核实资产清单）：
#    Linux  x64 / arm64  CPU        ✅  whisper-bin-ubuntu-{x64,arm64}.tar.gz
#    Windows x64 / Win32 CPU+BLAS   ✅
#    Windows CUDA 11.8 / 12.4       ✅
#  这些已按上游直连写进 vendor/manifests/backends.json（tag v1.9.1 不可变）。
#
#  上游**仍然没有**的：macOS CLI、Vulkan、ROCm、Linux CUDA。
#  按当前前提（个人自用 + 实际跑 Linux），这几项都不在需求内，**因此自建 CI 暂停**。
#
#  **本脚本保留**：将来真需要 Vulkan / ROCm / macOS CLI 时，它是唯一途径
#  （ADR-003 决策 2 的原始理由在那时才重新成立）。
# ══════════════════════════════════════════════════════════════════════════════════════
#
# build-whisper.sh — parameterised whisper.cpp build (platform x backend).
#
# OWNER: gpu-runtime (T-012). See docs/design/D-04-build-and-runtime.md.
#
# WHY WE BUILD THIS OURSELVES (ADR-003 decision 2):
#   whisper.cpp v1.9.1's official release ships ONLY: Windows cpu/blas/cublas,
#   Linux cpu, and an iOS xcframework. There is NO macOS CLI binary, NO Vulkan
#   build and NO ROCm build (verified against .github/workflows/release.yml).
#   Charter requirement 2.1 is unsatisfiable on macOS without building our own.
#
# THE OUTPUT SHAPE IS THE WHOLE POINT (ADR-003 decision 3):
#   Everything is built with GGML_BACKEND_DL=ON, so each backend lands as a
#   standalone ggml-<backend>.{so,dll,dylib} that ggml dlopen's at runtime from the
#   binary's own directory. Installing an accelerator is therefore "drop one more
#   file into the same folder" -- not a reinstall. Verified end-to-end on Linux;
#   see D-04 §2 for the measured transcript.
#
# Usage:
#   scripts/build-whisper.sh --backend cpu
#   scripts/build-whisper.sh --backend vulkan --out dist/packs
#   scripts/build-whisper.sh --backend cuda --cuda-arch 86
#
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# 平台运行时基线（macOS 部署目标 / Linux glibc 上限）的单一事实来源。
# 见该文件顶部：同一个数字写在两个地方然后只改一个，已经在本仓现形三次。
# shellcheck source=lib/baselines.sh
source "${SCRIPT_DIR}/lib/baselines.sh"

# --------------------------------------------------------------------------------------
# defaults
# --------------------------------------------------------------------------------------
BACKEND="cpu"
SRC_DIR="${REPO_ROOT}/vendor/whisper.cpp"
OUT_DIR="${REPO_ROOT}/dist/packs"
BUILD_ROOT="${REPO_ROOT}/.build"
CUDA_ARCH=""            # empty => fat binary across all archs (huge; see D-04 §5)
ROCM_TARGETS="gfx1100;gfx1101;gfx1201"
JOBS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"
DO_STRIP=1
DO_PACKAGE=1
ADHOC_SIGN=1            # macOS: ADR-003 decision 4 -- ad-hoc only, we buy no certificates

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
log() { printf '\033[36m==>\033[0m %s\n' "$*" >&2; }

usage() {
  sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  cat >&2 <<'EOF'

Options:
  --backend <cpu|vulkan|cuda|rocm|metal|coreml>   default: cpu
  --src <dir>          whisper.cpp checkout        default: vendor/whisper.cpp
  --out <dir>          output dir for packs        default: dist/packs
  --build-root <dir>   cmake build dir parent      default: .build
  --cuda-arch <list>   e.g. 86  or  "86;89"        default: (fat binary)
  --rocm-targets <list>                            default: gfx1100;gfx1101;gfx1201
  --jobs <n>           parallel build jobs
  --no-strip           keep debug symbols
  --no-package         build only, do not tar/zip
  --no-sign            macOS: skip ad-hoc codesign
  -h, --help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backend)      BACKEND="$2"; shift 2 ;;
    --src)          SRC_DIR="$2"; shift 2 ;;
    --out)          OUT_DIR="$2"; shift 2 ;;
    --build-root)   BUILD_ROOT="$2"; shift 2 ;;
    --cuda-arch)    CUDA_ARCH="$2"; shift 2 ;;
    --rocm-targets) ROCM_TARGETS="$2"; shift 2 ;;
    --jobs)         JOBS="$2"; shift 2 ;;
    --no-strip)     DO_STRIP=0; shift ;;
    --no-package)   DO_PACKAGE=0; shift ;;
    --no-sign)      ADHOC_SIGN=0; shift ;;
    -h|--help)      usage; exit 0 ;;
    *)              die "unknown argument: $1 (try --help)" ;;
  esac
done

# --------------------------------------------------------------------------------------
# host identification
# --------------------------------------------------------------------------------------
case "$(uname -s)" in
  Linux)  HOST_OS="linux"  ;;
  Darwin) HOST_OS="darwin" ;;
  MINGW*|MSYS*|CYGWIN*) HOST_OS="win32" ;;
  *) die "unsupported host OS: $(uname -s)" ;;
esac

case "$(uname -m)" in
  x86_64|amd64) HOST_ARCH="x64"   ;;
  arm64|aarch64) HOST_ARCH="arm64" ;;
  *) die "unsupported host arch: $(uname -m)" ;;
esac

# ★ T-144 (platform C9): the **pack id** uses a different OS token than the **schema
# field**. This is not sloppiness, it is two namespaces that were already diverging:
#
#   schema `os` field  -> linux / darwin / win32   (OsPlatformSchema; matches process.platform)
#   pack id token      -> linux / macos  / win     (what every hand-written entry in
#                                                   vendor/manifests/backends.json uses:
#                                                   whispercpp-cpu-win-x64, ytdlp-macos-arm64)
#
# The old script used HOST_OS for both, so CI would have produced
# `whispercpp-cpu-win32-x64` next to the hand-written `whispercpp-cpu-win-x64`
# -- **the same pack under two ids**, both shown in the UI, neither knowing about
# the other. Nothing would have caught it: both are valid schema-wise.
case "${HOST_OS}" in
  linux)  PACK_OS="linux" ;;
  darwin) PACK_OS="macos" ;;
  win32)  PACK_OS="win"   ;;
esac

# --------------------------------------------------------------------------------------
# backend -> cmake flags
#
# NOTE ON GGML_CPU_ALL_VARIANTS: builds ~12 micro-architecture CPU backends
# (sse42, sandybridge, haswell, skylakex, icelake, zen4, sapphirerapids, ...) and lets
# ggml_backend_score() pick the best at runtime. MEASURED on the T-012 box: zen4 was
# selected automatically and ran tiny.en at 0.30 s for 11 s of audio; forcing the sse42
# fallback took 1.03 s -- a 3.4x spread. This is why we never hand-detect AVX levels.
# It requires GGML_NATIVE=OFF (otherwise the build pins itself to the builder's CPU).
# --------------------------------------------------------------------------------------
COMMON_FLAGS=(
  -DCMAKE_BUILD_TYPE=Release
  -DBUILD_SHARED_LIBS=ON
  -DGGML_BACKEND_DL=ON
  -DGGML_NATIVE=OFF
  -DWHISPER_BUILD_TESTS=OFF
  -DWHISPER_BUILD_EXAMPLES=ON
  -DWHISPER_SDL2=OFF
  -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON
)

# ★★ T-146（**发布前最后一刻抓到的，差一点就发出去了**）
#
# macOS 上不显式设部署目标，CMake 就取**构建机自己的系统版本**。
# runner 是 `macos-26`，于是产物的 `LC_BUILD_VERSION.minos` = **26.0.0**：
#
#   $ 解析 whispercpp-cpu-macos-arm64/whisper-cli 的 LC_BUILD_VERSION
#     platform 1  minos 26.0.0  sdk 26.5.0
#
# 后果：**在任何低于 macOS 26 的 Mac 上，dyld 直接拒绝加载** —— 而 macOS 26 是最新版，
# 绝大多数用户的机器都不是。也就是说那个包会「下载成功、校验通过、一执行就死」，
# 而 selfcheck 只看得到"文件在"。**这正是本仓最贵的那类形状，只是换了一层皮。**
#
# 对照：我们选的那个 macOS ffmpeg（jellyfin）minos 是 **12.0**。
# 我们自己编的东西反而是三个平台里唯一挑机器的那个。
#
# 13.3 不是我拍的：**是上游自己 `build-xcframework.sh:5` 写的
# `MACOS_MIN_OS_VERSION=13.3`** —— 同一份代码，上游测过的下限。
# （所有 Apple Silicon 机器都能跑 macOS 13。）
#
# ★ T-167：13.3 这个字面量从这里搬进了 `scripts/lib/baselines.sh`。
#   理由不是整洁：**同一个数字当时也该写进 `build-probe.sh`，而没有** ——
#   于是探针在真产物里是 `minos=26.0.0`，包里 20 个二进制是 13.3.0（本机实测）。
if [[ "${HOST_OS}" == "darwin" ]]; then
  COMMON_FLAGS+=( "-DCMAKE_OSX_DEPLOYMENT_TARGET=${OPENMEMO_MACOS_DEPLOYMENT_TARGET}" )
fi

# --------------------------------------------------------------------------------------
# Relocatability: resolve sibling shared libraries relative to the binary itself, so an
# extracted pack runs from anywhere with no LD_LIBRARY_PATH. Verified on Linux: extracted
# to a clean dir and run under `env -u LD_LIBRARY_PATH`, whisper-cli loaded
# libggml-cpu-zen4.so from its own folder.
#
# ★ T-144 (platform C8): `$ORIGIN` is an **ELF/Linux** concept. macOS's dyld does not
# understand it -- it uses `@loader_path` / `@executable_path`. The old code passed
# `$ORIGIN` unconditionally, so "the pack is fully relocatable" (D-04 §331) was simply
# **not true on macOS**, and nothing would have said so: the build succeeds, the pack
# tars up fine, and it only fails on a user's machine that does not happen to have the
# libraries somewhere dyld looks.
#
# scripts/build-probe.sh:70-73 already had the per-platform split. Two scripts, one of
# them right -- copying the right one over is the whole fix.
# UNVERIFIED on macOS: no Mac available on this box. Linux behaviour is unchanged.
# --------------------------------------------------------------------------------------
case "${HOST_OS}" in
  darwin) COMMON_FLAGS+=( -DCMAKE_INSTALL_RPATH='@loader_path' ) ;;
  win32)  : ;;  # Windows resolves DLLs from the exe's own directory; no rpath concept.
  *)      COMMON_FLAGS+=( -DCMAKE_INSTALL_RPATH='$ORIGIN' ) ;;
esac

# CPU variant fan-out is x86-only; on arm64 ggml uses runtime feature detection instead.
if [[ "${HOST_ARCH}" == "x64" ]]; then
  COMMON_FLAGS+=( -DGGML_CPU_ALL_VARIANTS=ON )
fi

BACKEND_FLAGS=()
case "${BACKEND}" in
  cpu)
    # ★★ T-146：**macOS 的核心包一律带 CoreML（ANE）能力。**
    #
    # 为什么加在 `cpu` 这个"核心包"上而不是做成一个独立的 `coreml` 包
    # （这一条是查 whisper.cpp v1.9.1 源码得到的，不是偏好）：
    #
    #   `WHISPER_COREML` 编出来的是 `whisper.coreml` 这个目标，并且
    #   **PRIVATE 链进 libwhisper**（vendor/whisper.cpp/src/CMakeLists.txt:57-83,152-154），
    #   链的 framework 只有 Foundation 与 CoreML。
    #   它**不是 ggml 后端模块** —— 全仓没有任何 `ggml-coreml` 目标
    #   （ggml/src/ 下的 backend 目录里没有 coreml 这一项）。
    #   所以 CUDA/Vulkan 那种「核心包 + 额外装一个 .so」的模型在这里**结构上不成立**：
    #   要有 CoreML 就必须重编 libwhisper / whisper-cli 本身。
    #
    # `ALLOW_FALLBACK=ON` 的含义（whisper.cpp:3440-3452）：`.mlmodelc` 找不到时
    # **打一行 ERROR 然后继续跑**，不是拒绝启动。所以带 CoreML 的二进制在
    # 没装 encoder 的机器上行为与不带时一致 —— 一个包吃两种情况。
    #
    # ⚠️ **但这个"静默回退"正是本仓最贵的那类 bug 的形状**，而且它真的是静默的：
    #    `packages/pipeline/src/asr/whisperCpp.ts:101` 传了 `--no-prints`，
    #    而 whisper-cli 的 `--no-prints` 做的第一件事就是
    #    `whisper_log_set(cb_log_disable, NULL)`（examples/cli/cli.cpp:1039-1040）——
    #    **那一行 ERROR 谁也看不见**。
    #    → 所以配套加了自检项 `asr.coreml`（packages/runtime/src/selfcheck.ts），
    #      它直接看磁盘上 `.mlmodelc` 在不在、是不是空壳，**用户能看见到底走没走 ANE**。
    #      没有那一项就不该开这个开关。
    #
    # ANE 与 Metal 是**互补**不是二选一：CoreML 只接管 encoder
    # （whisper.cpp:2412 用 whisper_coreml_encode 替掉 encoder；
    #  models/generate-coreml-model.sh 结尾写着 `# TODO: decoder`），
    # decoder 仍然走 ggml 的后端（Metal 包或 CPU）。
    # ★ T-146：**macOS 的核心包同时带 Metal**。
    #   理由见下面「assemble the pack」那段：纯增量的加速包在本产品里找不到 ——
    #   ggml 只在 whisper-cli 自己的目录里找后端模块，而增量包解在另一个目录。
    #   `GGML_METAL_EMBED_LIBRARY=ON` 让着色器编进二进制，所以 Metal 是唯一一个
    #   "跟着核心包出厂就位置正确"的加速后端。
    #   于是一台 Mac 装一个包就同时拿到：ANE（encoder）+ Metal（GPU）+ CPU 兜底。
    if [[ "${HOST_OS}" == "darwin" ]]; then
      BACKEND_FLAGS+=(
        -DWHISPER_COREML=ON -DWHISPER_COREML_ALLOW_FALLBACK=ON
        -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON
      )
    fi
    ;;
  vulkan)
    BACKEND_FLAGS+=( -DGGML_VULKAN=ON )
    ;;
  cuda)
    BACKEND_FLAGS+=( -DGGML_CUDA=ON )
    # Single-architecture builds are the headline size lever: the shipped fat
    # ggml-cuda.dll measured 564.59 MB unpacked (R-02 §B.2). See D-04 §5.
    [[ -n "${CUDA_ARCH}" ]] && BACKEND_FLAGS+=( -DCMAKE_CUDA_ARCHITECTURES="${CUDA_ARCH}" )
    ;;
  rocm)
    BACKEND_FLAGS+=( -DGGML_HIP=ON -DAMDGPU_TARGETS="${ROCM_TARGETS}" )
    ;;
  metal)
    [[ "${HOST_OS}" == "darwin" ]] || die "metal backend requires a macOS host"
    # EMBED_LIBRARY compiles the .metal shaders into the binary, so the Metal pack
    # needs no companion resource file -- it is a zero-extra-download backend.
    BACKEND_FLAGS+=( -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON )
    ;;
  coreml)
    # ★★ T-146：**这个分支以前是坏的，而且它描述了一件不存在的事。**
    #
    # 它走的是下面 `else` 那条打包路径（非 cpu = 只拷 `libggml-<backend>.<ext>` 的增量包），
    # 于是它会去找 `libggml-coreml.so` —— **那个文件永远不存在**：
    # CoreML 不是 ggml 后端模块，是 `WHISPER_COREML=ON` 编进 libwhisper 的
    # （vendor/whisper.cpp/src/CMakeLists.txt:57-83,152-154；ggml/src/ 下没有 coreml 目录）。
    # 结果必然是「暂存目录为空 → emit-pack-manifest die」。
    # 它从来没被执行过，所以这件事从来没被发现 —— 与 macOS 那个
    # 「1.4 MB、零个 ggml 后端模块、却报告成功」的包是同一族。
    #
    # 与其留一段跑一次红一次的代码，不如让它当场说清楚正确做法：
    die "CoreML 不是一个独立的后端包。
  CoreML 编在 libwhisper 里（不是 dlopen 的 ggml 模块），所以它随 **macOS 的核心包**
  一起出厂 —— \`--backend cpu\` 在 darwin 上已经自动带上
  -DWHISPER_COREML=ON -DWHISPER_COREML_ALLOW_FALLBACK=ON（见上面 cpu 分支）。
  GPU 侧要的是 \`--backend metal\`。两者互补：ANE 跑 encoder，Metal 跑其余部分。"
    ;;
  *)
    die "unknown backend: ${BACKEND}"
    ;;
esac

[[ -d "${SRC_DIR}" ]] || die "whisper.cpp source not found at ${SRC_DIR}
  Run: git submodule update --init --depth 1 vendor/whisper.cpp"

BUILD_DIR="${BUILD_ROOT}/whisper-${HOST_OS}-${HOST_ARCH}-${BACKEND}"
PACK_ID="whispercpp-${BACKEND}-${PACK_OS}-${HOST_ARCH}"

log "host=${HOST_OS}/${HOST_ARCH} backend=${BACKEND} jobs=${JOBS}"
log "src=${SRC_DIR}"
log "build=${BUILD_DIR}"

# --------------------------------------------------------------------------------------
# configure + build
# --------------------------------------------------------------------------------------
rm -rf "${BUILD_DIR}"
# ★ T-145（第一次真跑 CI 才发现的，本机 Linux 永远看不见）：
#   `set -u` + **空数组** + **bash 3.2** = `unbound variable`。
#   macOS 的 /bin/bash 至今是 **3.2**（Apple 因 GPLv3 停在 2007 年那一版），
#   而 bash 4.4 才把「空数组展开不算未绑定」修掉。BACKEND_FLAGS 在 backend=cpu 时
#   **恰好是空的** —— 于是：
#     macos-26 / macos-15-intel, backend=cpu
#       scripts/build-whisper.sh: line 229: BACKEND_FLAGS[@]: unbound variable
#   而同一行在 ubuntu（bash 5.x）上跑了几十次都是绿的。
#   `${ARR[@]+"${ARR[@]}"}` 是 bash 3.2 下唯一安全的空数组展开写法。
#   COMMON_FLAGS 今天非空，但一样加上 —— 判据是「以后有人把它清空也不会炸」。
cmake -S "${SRC_DIR}" -B "${BUILD_DIR}" \
  ${COMMON_FLAGS[@]+"${COMMON_FLAGS[@]}"} \
  ${BACKEND_FLAGS[@]+"${BACKEND_FLAGS[@]}"}
cmake --build "${BUILD_DIR}" --config Release -j "${JOBS}"

# ★ T-144 (platform C7): multi-config generators (Visual Studio, Xcode) append the
# configuration name to CMAKE_RUNTIME_OUTPUT_DIRECTORY, so whisper.cpp's `${BUILD}/bin`
# actually becomes `${BUILD}/bin/Release`. The old code only tried `bin` and
# `Release/bin` -- **neither of which is where MSVC puts things** -- and the workflow
# then hard-coded a third path of its own. Try all three, in the order that puts the
# single-config (Linux/macOS Makefile+Ninja) answer first.
BIN_DIR=""
for cand in "${BUILD_DIR}/bin" "${BUILD_DIR}/bin/Release" "${BUILD_DIR}/Release/bin"; do
  # A directory that exists but holds no regular files is not the output dir -- on MSVC
  # `${BUILD}/bin` exists as the *parent* of `bin/Release`, so `-d` alone picks the wrong one.
  if [[ -d "${cand}" ]] && [[ -n "$(find "${cand}" -maxdepth 1 -type f -print -quit 2>/dev/null)" ]]; then
    BIN_DIR="${cand}"; break
  fi
done
[[ -n "${BIN_DIR}" ]] || die "cannot locate build output dir under ${BUILD_DIR}
  tried: bin, bin/Release, Release/bin (all missing or empty)"

# ★ T-144 (platform C7): tell the caller where things landed instead of making it guess.
# The workflow used to hard-code `.build/whisper-win32-<arch>-cpu/bin`, which is both the
# wrong OS token (see PACK_OS above) and the wrong sub-directory on MSVC. Exporting the
# resolved values means the workflow can never drift from the script again.
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    printf 'pack_id=%s\n' "${PACK_ID}"
    printf 'bin_dir=%s\n' "${BIN_DIR}"
    printf 'build_dir=%s\n' "${BUILD_DIR}"
  } >> "${GITHUB_OUTPUT}"
fi

# --------------------------------------------------------------------------------------
# record the ggml ABI.
#
# The backend .so files are only interchangeable between engines when the ggml ABI
# matches. R-02 flagged whisper.cpp<->llama.cpp backend sharing as UNVERIFIED; recording
# the version here is what lets `BackendPack.ggmlAbi` gate it instead of guessing.
# --------------------------------------------------------------------------------------
GGML_ABI="unknown"
for cand in "${BIN_DIR}"/libggml.so.*.* "${BIN_DIR}"/libggml.*.dylib; do
  [[ -e "${cand}" ]] || continue
  GGML_ABI="$(basename "${cand}" | sed -E 's/^libggml\.(so\.)?//; s/\.dylib$//')"
  break
done
log "ggml ABI: ${GGML_ABI}"

# --------------------------------------------------------------------------------------
# assemble the pack
#
# L1 "core"  = engine + ALL cpu variants + CLI/server. Ships inside the installer.
# L2 "accel" = the same core PLUS the single ggml-<backend> shared library
#              (+ vendor runtime libs). ★ T-161 改成这样的，理由见下。
#
#              这里原本写的是 “ONLY the single ggml-<backend> shared library …
#              Keeping it to just the delta is what makes requirement 2.1 cheap”，
#              **那句话描述的东西在本产品里结构上不可能生效** —— 见下面 T-146 的三条证据。
#              T-161 没有再让它挂着，而是按证据把实现改成了自包含。
#
# ★★ T-146：**上面那句 L2 的设计与产品实际解析后端的方式对不上，从来没人对过。**
#
# ggml 找后端模块只看三个地方（`ggml/src/ggml-backend-reg.cpp:479-489`）：
#   ① 编译期的 GGML_BACKEND_DIR   ② `get_executable_path()`   ③ `fs::current_path()`
# 也就是**只找 whisper-cli 自己所在的目录**和 cwd。
# 而安装器把每个包解到 `by-name/backend/<各自的归档名>/` —— 增量包里的
# `libggml-vulkan.so` 与 whisper-cli **永远不在同一个目录**；cwd 是 job 的临时目录，也不是。
# `GGML_BACKEND_PATH` 环境变量存在，但 `runner.ts:92-94` 的 env 白名单里没有它。
# 全仓也没有任何东西把后端模块搬到引擎目录旁边（`materializeSqliteExtensions()`
# 只服务 SQLite 扩展）。
#
# → **纯增量的加速包装上去会 succeeded，然后什么都不会发生。**
#   反证：目录里那个**能用**的加速包 `whispercpp-cuda-12.4-win-x64`，
#   `providesFiles` 是 `["ggml-cuda.dll","whisper-cli.exe"]` —— **它自带 whisper-cli**。
#   本产品事实上的约定是「加速包必须自包含」。
#
# ★★ T-161：**这条债已经在本脚本里还掉了 —— 选的是"让加速包自包含"那一条。**
#   （原文写的是「这条债不在本脚本的范围内（要么补搬运机制、要么让加速包自包含）」。）
#   两条路里选后者，是因为它只改构建、不改运行时，而运行时那条要动的是
#   `discoverTools()` 的解析顺序 —— 那是另一个人的地盘，且**它本身另有一个未解的洞**：
#   `findInBackendPacks()` 按 `readdir` 顺序取第一个命中，既不排序、也不看
#   `BackendPack.priority`、也不看 `selectedBackend`。所以核心包与加速包
#   **同时装着**时，跑起来的是哪一个 whisper-cli 是未定义的。
#   → 自包含是**必要**条件，不是充分条件。见 coordination/inbox/amd-vulkan.md。
#
# 另外 **macOS 的 Metal 是个例外，可以就地解决**：`GGML_METAL_EMBED_LIBRARY=ON`
# 把着色器编进二进制、不需要伴随资源文件，所以 `libggml-metal.so` 只要跟着核心包一起出厂
# 就位置正确了 —— 这也正是 workflow 自己的注释早就写着的
# 「Metal … 的 pack 其实装在核心包里」。见下面 cpu 分支里的 darwin 特判。
# --------------------------------------------------------------------------------------
STAGE="${BUILD_DIR}/stage/${PACK_ID}"
rm -rf "${STAGE}"; mkdir -p "${STAGE}"
[[ -n "${GITHUB_OUTPUT:-}" ]] && printf 'stage_dir=%s\n' "${STAGE}" >> "${GITHUB_OUTPUT}"

case "${HOST_OS}" in
  win32)  SO_EXT="dll";   LIB_PREFIX="" ;;
  darwin) SO_EXT="dylib"; LIB_PREFIX="lib" ;;
  *)      SO_EXT="so";    LIB_PREFIX="lib" ;;
esac

# ★★ T-145（**本轮最贵的一条，只有真 macOS runner 才看得见**）
#
# `-DGGML_BACKEND_DL=ON` 让每个后端变成一个**运行时加载的模块**，而 CMake 对
# `add_library(... MODULE)` 用的是 `CMAKE_SHARED_MODULE_SUFFIX` —— 在 **Apple 平台上
# 它是 `.so`，不是 `.dylib`**（dylib 是给 SHARED 库的）。真机日志逐行印证：
#
#     [ 21%] Linking CXX shared library ../../bin/libggml-base.dylib   ← SHARED → dylib
#     [ 33%] Linking CXX shared module  ../../../bin/libggml-blas.so   ← MODULE → .so
#     [ 46%] Linking CXX shared module  ../../../bin/libggml-metal.so  ← MODULE → .so
#     [ 60%] Linking CXX shared module  ../../bin/libggml-cpu.so       ← MODULE → .so
#
# 后果分两种，**而危险的是绿的那种**：
#   · macos-arm64-metal：只找 `libggml-metal.dylib` → 一个都没匹配 → 暂存目录空
#     → `emit-pack-manifest` 报错 → **红**（被 ci-prep 的 C5 族守卫接住了）
#   · macos-arm64-cpu ：`libggml-cpu.so` 同样没匹配上，**但别的 dylib 匹配上了**
#     → 暂存目录非空 → 打出一个 1.4 MB 的 tar.gz → **job success，CI 全绿**
#     实测内容只有 8 个文件、且**没有任何 ggml 后端模块**：
#       libggml-base.0.15.1.dylib / libggml.0.15.1.dylib /
#       libwhisper.1.9.1.dylib / libparakeet.1.9.1.dylib / whisper-cli
#     对照 Windows 同一轮的包：17 个文件 3.8 MB，含 10 个 ggml-cpu-*.dll。
#     **BACKEND_DL 模式下没有后端模块 = whisper-cli 起来后一个后端都注册不到 = 不能推理。**
#     也就是说：**一个绿灯的、能下载的、装上去用不了的 macOS 包。**
#
# → 模块后缀与共享库后缀必须分开。
MOD_EXT="${SO_EXT}"
[[ "${HOST_OS}" == "darwin" ]] && MOD_EXT="so"

# ⚠️ **这是一个静默 no-op**：找不到就当没这回事，不报错、不影响退出码。
#    它对"这个平台上本来就没有的可选产物"（whisper-server / parakeet / blas 变体…）是对的，
#    但对**必需件**是致命的 —— T-190 那条 CUDA 缺件就是这么来的：
#    glob 写成了 Windows 命名，在 Linux 上永远不匹配，而它一声不吭。
#    同族：`git commit -- <pathspec>` 对未跟踪文件也是静默 no-op（PROTOCOL §12）。
#
#    **判据：凡是"少了它包就不能用"的东西，一律不许只靠这个函数。**
#    必需件由下面那几条 `die` 守卫 + `pack-native-deps.mjs --verify` 兜底。
copy_if_exists() { for f in "$@"; do [[ -e "$f" ]] && cp -a "$f" "${STAGE}/"; done; true; }

# ★★ T-161：**每一个包都带上引擎本体**（原来只有 `cpu` 分支带）。
#
# 这是把上面那段「写着 A、实现是 B」的不一致按 **B 的方向**解决掉：
# 设计注释说 L2 = 只带一个 `ggml-<backend>` 增量；而产品实际解析后端的方式
# （ggml 只在 whisper-cli 自己的目录里 dlopen 模块）**让增量包结构上不可能生效**。
# 两条路只能选一条 —— 要么给产品补一套"把模块搬到引擎旁边"的机制，
# 要么让加速包自包含。选后者的理由是它**只改构建、不改运行时**，
# 而且目录里那个唯一被认为"能用"的加速包 `whispercpp-cuda-12.4-win-x64`
# （上游的）本来就是这个形状：它的 `providesFiles` 里有 `whisper-cli.exe`。
#
# 代价如实说：加速包从"增量"变成"核心 + 一个模块"，Linux vulkan 由此多出
# 一个核心包的体积。这不是浪费 —— 一个装了不生效的 19 MB 才是浪费。
copy_core_files() {
  copy_if_exists \
    "${BIN_DIR}/${LIB_PREFIX}ggml-base."*"${SO_EXT}"* \
    "${BIN_DIR}/${LIB_PREFIX}ggml."*"${SO_EXT}"* \
    "${BIN_DIR}/${LIB_PREFIX}ggml-cpu.${MOD_EXT}" \
    "${BIN_DIR}/${LIB_PREFIX}ggml-cpu-"*".${MOD_EXT}" \
    "${BIN_DIR}/${LIB_PREFIX}ggml-blas.${MOD_EXT}" \
    "${BIN_DIR}/${LIB_PREFIX}whisper."*"${SO_EXT}"* \
    "${BIN_DIR}/${LIB_PREFIX}parakeet."*"${SO_EXT}"* \
    "${BIN_DIR}/whisper-cli"* \
    "${BIN_DIR}/whisper-server"* \
    "${BIN_DIR}/whisper-bench"* \
    "${BIN_DIR}/whisper-vad-speech-segments"*
}

copy_core_files

if [[ "${BACKEND}" == "cpu" ]]; then
  # ★ T-146：macOS 的核心包把 Metal 模块一起带上（见上面 cpu 分支的理由）。
  #   放在这里而不是加进上面那串：它只在 darwin 上存在，混进公用列表会让人以为
  #   别的平台也该有。
  if [[ "${HOST_OS}" == "darwin" ]]; then
    copy_if_exists "${BIN_DIR}/${LIB_PREFIX}ggml-metal.${MOD_EXT}"
    # 守卫与 CPU 那条同形：**少拷了它不许报绿**。
    # 少了它 macOS 用户拿到的是一个"以为有 GPU、实际纯 CPU"的包，
    # 而 whisper.cpp 不会为此报错 —— 它只是注册不到 Metal 后端然后照常跑。
    if [[ ! -e "${STAGE}/${LIB_PREFIX}ggml-metal.${MOD_EXT}" ]]; then
      {
        echo "==> BIN_DIR (${BIN_DIR}) 实际内容："
        ls -la "${BIN_DIR}" 2>&1 || true
      } >&2
      die "macOS 核心包里没有 ${LIB_PREFIX}ggml-metal.${MOD_EXT}。
  cpu 分支在 darwin 上传了 -DGGML_METAL=ON，编出来却没落到 BIN_DIR ——
  要么 CMake 没编它，要么后缀又变了（MODULE 目标在 Apple 上是 .so 不是 .dylib，见 T-145）。"
    fi
  fi
else
  # ★ T-161：加速包 = 核心（上面 copy_core_files 已经拷了）+ 这一个后端模块。
  #   **原来这里只有这一行**，包里除了 `libggml-vulkan.so` 什么都没有 ——
  #   而 ggml 只在 whisper-cli 自己的目录里找模块，那个包因此结构上不可能生效。
  # ★ T-145：加速后端也是 MODULE，darwin 上同样是 `.so`（见上面那段）。
  copy_if_exists "${BIN_DIR}/${LIB_PREFIX}ggml-${BACKEND}.${MOD_EXT}"

  # ★★ T-161 守卫：加速包里**必须**有它自己那个后端模块。
  #
  #   这条守卫是随 copy_core_files 一起**必须**加的，不是锦上添花：
  #   在此之前，加速模块没拷到 → 暂存目录是空的 → emit-pack-manifest 当场 die（红）。
  #   现在核心文件先进了 stage，**stage 永远非空** —— 于是同一个失败会
  #   打出一个"能下载、能安装、里面根本没有加速器"的包并报绿。
  #   **正是 T-145 在 macos-arm64-cpu 上实测到的那个形状，只是换了一格。**
  #   一个改动把旧守卫的前提抽掉了，就得在原地把守卫补回来。
  if [[ ! -e "${STAGE}/${LIB_PREFIX}ggml-${BACKEND}.${MOD_EXT}" ]]; then
    {
      echo "==> BIN_DIR (${BIN_DIR}) 实际内容："
      ls -la "${BIN_DIR}" 2>&1 || true
      echo "==> ${BUILD_DIR} 底下所有 ggml*："
      find "${BUILD_DIR}" -name '*ggml*' -maxdepth 4 2>/dev/null | head -40 || true
    } >&2
    die "加速包 ${PACK_ID} 里没有 ${LIB_PREFIX}ggml-${BACKEND}.${MOD_EXT}。
  编译看起来成功了，但那个后端模块没有落到 BIN_DIR ——
  没有它的话这个包 = 一份和核心包一模一样的引擎，装上去用户不会变快，
  而 GGML_BACKEND_DL 下 whisper 不会为此报任何错。"
  fi

  # ★★★ T-190：**这一段以前是坏的，而且坏得一声不吭。**
  #
  # 原文是：
  #   case "${BACKEND}" in
  #     cuda) copy_if_exists "${BIN_DIR}/cudart64_"*.dll "${BIN_DIR}/cublas64_"*.dll \
  #                          "${BIN_DIR}/cublasLt64_"*.dll "${BIN_DIR}/nvrtc"*.dll ;;
  #   esac
  #
  # 三层同时失效，任何一层单独出现都足以让包坏掉：
  #   ① 它只在 **BIN_DIR**（构建输出目录）里找，而 CMake **不会**把 toolkit 的
  #      DLL / .so 拷到那里 —— 那些库在 `$CUDA_PATH` 底下；
  #   ② Linux 侧那几个 glob 是 **Windows 命名**（`cudart64_*.dll`），
  #      在 Linux 上**永远匹配不到**；
  #   ③ `copy_if_exists` 是「有就拷、没有就算」—— **它一声不吭**。
  #
  # `[实测 2026-08-09]` 后果：`whispercpp-cuda-win-x64` / `whispercpp-cuda-linux-x64`
  # 的 `providesFiles` 里**一个 CUDA 运行库都没有**，而 `ggml-cuda` 的导入表要
  # `cublas64_12.dll` + `cudart64_12.dll`（Linux: `libcudart.so.12` / `libcublas.so.12`）。
  # → 装得上、`dlopen` 失败、而 `GGML_BACKEND_DL=ON` 下失败不是错误，
  #   只是"这个后端没注册上" → 静默回落 CPU。**装了不会变快，没有任何一处会说话。**
  #
  # 换成 `scripts/ci/pack-native-deps.mjs --collect`，判据整个换了一层：
  #   · **要哪些库是问二进制自己的**（ELF `DT_NEEDED` / PE 导入表），不是手写清单 ——
  #     手写清单会漂（上面 ② 就是漂的结果）；
  #   · **传递闭包**：拷进 `libcublas.so.12` 之后再问它一遍，`libcublasLt.so.12`
  #     被自动带上，**不需要有人知道它的存在**（它是 328 MB 里最大的一块）；
  #   · **找不到就 die**，不再有"没有就算"这一档；
  #   · 只带真正被引用的 —— 上游 `release.yml` 用 `xcopy /E` 把整个 redist 目录扫进包里，
  #     于是多了 `nvrtc`×2 + `nvblas` 共 19.9 MB。**ggml 全树零引用，我们不抄。**
  #
  # ⚠️ 不带 `libcuda.so.1` / `nvcuda.dll`：那是 **显示驱动**带的，
  #    不在 NVIDIA 可再分发清单里（脚本的 `DRIVER_PROVIDED` 一类**永远不收集**）。
  if [[ "${BACKEND}" == "cuda" ]]; then
    CUDA_ROOT="${CUDA_PATH:-${CUDA_HOME:-}}"
    if [[ -z "${CUDA_ROOT}" ]] && command -v nvcc >/dev/null 2>&1; then
      CUDA_ROOT="$(cd "$(dirname "$(command -v nvcc)")/.." && pwd)"
    fi
    [[ -n "${CUDA_ROOT}" ]] || die "找不到 CUDA toolkit 根目录（CUDA_PATH / CUDA_HOME / PATH 上的 nvcc 都没有）。
  运行库必须从 toolkit 里取 —— CMake 不会把它们拷进构建输出目录。"
    log "CUDA toolkit: ${CUDA_ROOT}"
    # 各平台的库都在哪：Windows 是 `bin/`（DLL 与 exe 同目录），Linux 是 `lib64/`
    # 或 `targets/<triple>/lib/`。**全都给出去，让脚本自己找** —— 少给一个目录的表现
    # 是"找不到 → 红"，那至少是响的；写死一个目录的表现才是静默。
    CUDA_SEARCH=(
      --search "${BIN_DIR}"
      --search "${CUDA_ROOT}/bin"
      --search "${CUDA_ROOT}/lib64"
      --search "${CUDA_ROOT}/lib"
      --search "${CUDA_ROOT}/targets/x86_64-linux/lib"
      --search "${CUDA_ROOT}/targets/sbsa-linux/lib"
    )
    command -v node >/dev/null || die "node is required to collect the CUDA runtime libraries"
    node "${REPO_ROOT}/scripts/ci/pack-native-deps.mjs" \
      --collect --dir "${STAGE}" "${CUDA_SEARCH[@]}"
  fi
fi

# ★ 守卫：**任何**包里都必须至少有一个 ggml CPU 后端模块 + whisper-cli 本体。
#   （T-146 时这两条只守着 cpu 分支；T-161 让每个包都自带引擎之后，
#    它们对每个包都成立，所以移到分支外面 —— 判据没变，覆盖面变了。）
#   上面那个 bug 的要害不是"少拷了一个文件"，是**少拷了它还报绿**。
#   判据不是"记得把后缀写对"，是"写错了会当场红"。
#
#   CPU 模块对加速包同样是必需的：Vulkan/CUDA 只接管一部分算子，
#   其余仍然落到 CPU 后端；而且设备不可用时 ggml 就是靠它兜底的。
if ! ls "${STAGE}/${LIB_PREFIX}ggml-cpu"*".${MOD_EXT}" >/dev/null 2>&1; then
  {
    echo "==> BIN_DIR (${BIN_DIR}) 实际内容："
    ls -la "${BIN_DIR}" 2>&1 || true
  } >&2
  die "包 ${PACK_ID} 里没有任何 ggml CPU 后端模块（找的是 ${LIB_PREFIX}ggml-cpu*.${MOD_EXT}）。
  GGML_BACKEND_DL=ON 下后端是运行时加载的模块，少了它 whisper-cli 一个后端都注册不到 ——
  **而这种包在过去是能打出来并报绿的**（T-145 在 macos-arm64-cpu 上实测到）。"
fi

# whisper-cli 是「自包含」的判据本身：ggml 只在**它自己的目录**里 dlopen 后端模块
# （ggml-backend-reg.cpp:479-489），所以一个没有 whisper-cli 的包里的加速模块
# 永远不会被任何进程看见。
if ! ls "${STAGE}/whisper-cli"* >/dev/null 2>&1; then
  {
    echo "==> BIN_DIR (${BIN_DIR}) 实际内容："
    ls -la "${BIN_DIR}" 2>&1 || true
  } >&2
  die "包 ${PACK_ID} 里没有 whisper-cli。
  ggml 只在 whisper-cli 自己所在的目录里 dlopen 后端模块，
  所以不带引擎的包 = 一堆永远不会被加载的 .so（D-11 §8.4 三条独立证据）。"
fi


# ══════════════════════════════════════════════════════════════════════════════════════
# ★★★ T-167：**探针随包出厂**。这是 `openmemo-probe` 的分发通道本身。
#
# ── 为什么它必须在包**里面**，而不是一个单独可下载的小文件 ────────────────────────────
#
# 三条，每一条单独就足以否掉"单独发一个 openmemo-probe"这个方案：
#
#   ① `[本机实测 2026-08-07]` 探针是**动态链接** ggml 的，不是自包含的：
#          $ objdump -p openmemo-probe | grep NEEDED
#            NEEDED  libggml-base.so.0     ← 在包里
#            NEEDED  libggml.so.0          ← 在包里
#            RUNPATH $ORIGIN
#          $ ./openmemo-probe            # 同目录没有那两个库
#            error while loading shared libraries: libggml-base.so.0: cannot open ...
#      把它单独放进 `by-name/backend/openmemo-probe`（yt-dlp 那种扁平落点），
#      它**一次都不会启动成功**。
#
#   ② `apps/daemon/src/runtime/setup.ts` 的 `backendDir` 定义就是
#      `path.dirname(probePath)` —— 产品从设计上就假定"探针与 ggml 后端模块同目录"。
#      而这个假定是对的：探针的工作就是 `ggml_backend_load_all_from_path(backendDir)`，
#      **它只能枚举与它同目录的那些后端**。
#
#   ③ 由 ② 推出一条更强的：探针必须在**每一个**包里，不只是核心包。
#      只有核心包带探针时，装了 Vulkan 加速包的用户，探针看的仍是核心包那个目录 ——
#      枚举不到 vulkan 设备，`hardware.backends.vulkan.available` 恒 false，
#      而那正是「装了没变快」在界面上唯一可能出声的地方。
#      现在每个包各带一份自己的探针（几十 KB），`resolveBackendTool()` 按
#      selectedBackend / priority 挑中哪个包，就用哪个包的探针，backendDir 自然对上。
#
# ── 为什么放在这里（顺序是有依据的）────────────────────────────────────────────────
#
# 必须在 `copy_core_files` 之后：探针链接的 `libggml-base` / `libggml` 就是它们。
# 必须在 strip / codesign 之前：strip 会让签名失效，而 Apple Silicon 上
# **没有签名的二进制根本不启动**（ADR-003 决策 4）。放在这里，下面那两步一起管它。
#
# ── 守卫（与上面两条同形）──────────────────────────────────────────────────────────
#
# 编不出来必须**当场红**。不设守卫的话，`|| true` 一类的手滑会打出一个
# "能下载、能安装、里面没有探针"的包并报绿 —— 而缺探针的表现是
# 「尚未探测到硬件能力」，与"这台机器真的没有 GPU"在界面上完全一样。
# ══════════════════════════════════════════════════════════════════════════════════════
PROBE_NAME="openmemo-probe"
[[ "${HOST_OS}" == "win32" ]] && PROBE_NAME="openmemo-probe.exe"

#
# `--include` 显式传：build-probe.sh 的默认值是 `REPO_ROOT/vendor/whisper.cpp/ggml/include`，
# 而本脚本的源码树由 `--src` 决定。两边各算各的 = 又一次「产出方与使用方用了两个定义」。
# `[CI 实测 run 31155338320]` 这条**不是假想**：ci.yml 的门禁刻意不拉 submodule
# （"TS 侧一行都不需要 vendor/ 里的 C++ 源码，几百 MB"），
# 于是默认路径不存在，selftest-build-whisper 当场三条红。
log "building ${PROBE_NAME} into the pack"
bash "${SCRIPT_DIR}/build-probe.sh" \
  --ggml-lib-dir "${BIN_DIR}" \
  --include "${SRC_DIR}/ggml/include" \
  --out "${STAGE}/${PROBE_NAME}"

if [[ ! -e "${STAGE}/${PROBE_NAME}" ]]; then
  {
    echo "==> STAGE (${STAGE}) 实际内容："
    ls -la "${STAGE}" 2>&1 || true
  } >&2
  die "包 ${PACK_ID} 里没有 ${PROBE_NAME}。
  探针是「这台机器能用哪些加速器」的唯一可信答案（ADR-003 决策 3），
  而它必须与 ggml 后端模块同目录才跑得起来（它动态链接 libggml-base，且
  runtime/setup.ts 的 backendDir = dirname(probePath)）。
  少了它，L2 加速包在用户机器上只能靠 advisory 探测将就，
  而 hw.probe 会永远报「openmemo-probe 未安装（后端能力未知）」。"
fi

# 让打出来的 GITHUB_OUTPUT 里有它，workflow 才能把同一份字节 upload 成独立 artifact
# （**upload 的和包里的必须是同一个文件**，否则守卫验的和用户拿到的是两样东西）。
[[ -n "${GITHUB_OUTPUT:-}" ]] && printf 'probe_path=%s\n' "${STAGE}/${PROBE_NAME}" >> "${GITHUB_OUTPUT}"

# ★ T-145：暂存目录空掉时，**把 BIN_DIR 的真实内容打出来**再让下游去红。
#   第一次真跑 CI 时 macos-arm64-metal 完整编译成功（100% built whisper-cli/…），
#   随后 emit-pack-manifest 报「stage dir is empty」——
#   **而日志里没有任何东西能告诉我们 BIN_DIR 里到底有什么**，
#   于是「libggml-metal.dylib 叫什么名字 / 在不在 bin 下」只能靠猜。
#   这一段不改变红绿（它不 exit），只保证下一次失败自带证据。
if [[ -z "$(find "${STAGE}" -type f -print -quit 2>/dev/null)" ]]; then
  {
    echo "==> stage is EMPTY: ${STAGE}"
    echo "==> backend=${BACKEND} looked for: ${BIN_DIR}/${LIB_PREFIX}ggml-${BACKEND}.${SO_EXT}"
    echo "==> actual contents of BIN_DIR (${BIN_DIR}):"
    ls -la "${BIN_DIR}" 2>&1 || true
    echo "==> any ggml* under ${BUILD_DIR}:"
    find "${BUILD_DIR}" -name '*ggml*' -maxdepth 4 2>/dev/null | head -40 || true
  } >&2
fi

if [[ "${DO_STRIP}" == "1" ]]; then
  log "stripping symbols"
  case "${HOST_OS}" in
    darwin) find "${STAGE}" -type f -perm -u+r -exec strip -x {} + 2>/dev/null || true ;;
    *)      find "${STAGE}" -type f -exec strip --strip-unneeded {} + 2>/dev/null || true ;;
  esac
fi

# --------------------------------------------------------------------------------------
# macOS ad-hoc signing (ADR-003 decision 4)
#
# Apple silicon REFUSES to execute any binary without at least an ad-hoc signature --
# this is not a Gatekeeper prompt, the process simply will not start. `codesign -s -`
# satisfies it and costs nothing. Stripping invalidates any existing signature, so this
# must run AFTER strip.
#
# NOT done here (deliberately, per ADR-003 decision 4 -- no certificates purchased):
#   Developer ID signing, notarisation, stapling. Consequence: the daemon must clear the
#   quarantine xattr after download. See D-04 §7 for the upgrade path.
# --------------------------------------------------------------------------------------
if [[ "${HOST_OS}" == "darwin" && "${ADHOC_SIGN}" == "1" ]]; then
  log "ad-hoc signing (codesign -s -)"
  find "${STAGE}" -type f \( -name '*.dylib' -o -perm -u+x \) -print0 |
    while IFS= read -r -d '' f; do
      codesign --force --sign - --timestamp=none "$f" 2>/dev/null || log "  warn: could not sign $f"
    done
fi

# ══════════════════════════════════════════════════════════════════════════════════════
# ★★★ T-190 守卫：**包里必须提供它自己导入表所要求的每一个非系统库。**
#
# 上面那几条守卫钉的是"某个我们知道名字的文件在不在"（whisper-cli / ggml-cpu* /
# ggml-<backend>）。它们**逐条都对，合起来仍然漏掉了整整一族** ——
# 因为它们检查的是**我们想到的那几个名字**，而 CUDA 运行库那三个**没有人想到**。
#
# 这一条不同：**它不带任何名字**。它读每个二进制自己的 `DT_NEEDED` / PE 导入表，
# 把"谁提供"分成 os / driver / 已立案缺口三类，**其余一律必须在包里**。
# 判据来自二进制而不是清单，所以：
#   · 换后端（rocm / 将来的别的）自动覆盖，不需要有人回来加一行；
#   · 上游改了链接方式（比如某天 ggml 开始链 nvJitLink）会**当场红**，而不是等用户装了不生效。
#
# 判据一句话：**"少一个文件"必须是红，不能是"装上去没变快"。**
#
# ⚠️ **位置是 CI 第一次真跑之后改的**：它原来放在装配阶段末尾，而 `openmemo-probe`
#    是在那之后才编进包的 —— `[CI 实测 run 31316557506]` 日志里守卫报「22 个二进制」
#    而 fragment 报「23 staged files」，**差的正是探针**。探针动态链接 libggml-base，
#    正是这条守卫该覆盖的东西。现在它排在 strip / codesign / 探针**全部做完之后**、
#    打包之前 —— 也就是「包里最终有什么」定下来的那一刻。
# ══════════════════════════════════════════════════════════════════════════════════════
if command -v node >/dev/null 2>&1; then
  node "${REPO_ROOT}/scripts/ci/pack-native-deps.mjs" --verify --dir "${STAGE}"
else
  die "node is required to run the pack dependency guard (scripts/ci/pack-native-deps.mjs)"
fi

# --------------------------------------------------------------------------------------
# manifest fragment
#
# Emitted per pack and later merged into vendor/manifests/backends.json, which is the
# input to the shared downloader (ADR-003 decision 6).
#
# ★ T-144 (platform C2) — this used to be ~35 lines of `printf` right here, and what it
# produced was **structurally incompatible with BackendPackSchema**:
#     missing 8 required fields  (displayName / displayNameZh / totalSizeBytes /
#                                 requiresDriver / license / providesFiles / priority /
#                                 catalogVersion)
#     4 undeclared fields        (engineCommit / buildHost / builtAt / archive)
#                                -- the schema is `.strict()`, one extra key is fatal
#     files[] missing            role / mirrors  (ArtifactFileSchema)
#     zero URLs anywhere         -- so even with the fields fixed, the manifest-level
#                                superRefine would reject it
#
# It had never been executed, so none of that had ever been noticed. The root cause is
# not carelessness: **the schema lives in TypeScript and the fragment was assembled in
# bash printf, and nothing existed that could ever compare the two.** The only checker
# ran three jobs later, on a runner that had never run.
#
# Now the fragment is produced by scripts/ci/emit-pack-manifest.mjs (plain node, no
# dependencies -- the build jobs deliberately do not `pnpm install`), and
# scripts/ci/selftest-ci-manifest.mjs feeds that emitter's output through the **real**
# `validateBackendManifest` on this machine. Run it with `pnpm test:ci-scripts`.
#
# NOTE: per-file SHA256 is no longer recorded. The downloadable unit is the archive, and
# ArtifactFileSchema describes *that*; the per-file hashes had no consumer and no place
# to live in the schema. Archive SHA256 is still recorded and still mandatory.
# --------------------------------------------------------------------------------------
emit_manifest() {
  local archive="$1"
  local mf="${OUT_DIR}/${PACK_ID}.json"
  local tier; tier="$([[ "${BACKEND}" == "cpu" ]] && echo builtin || echo downloadable)"
  local engine_version; engine_version="$(git -C "${SRC_DIR}" describe --tags --always 2>/dev/null || echo unknown)"
  # Catalog version = the build date. The merge step keeps the existing catalogVersion of
  # backends.json by default, so this value only matters for a fragment inspected alone.
  local catalog_version; catalog_version="$(date -u +%Y.%m.%d)"

  command -v node >/dev/null || die "node is required to emit the manifest fragment
  (scripts/ci/emit-pack-manifest.mjs). Install Node >= 22 on the build runner."

  local args=(
    --pack-id        "${PACK_ID}"
    --engine         "whisper.cpp"
    --engine-version "${engine_version}"
    --ggml-abi       "${GGML_ABI}"
    --backend        "${BACKEND}"
    --os             "${HOST_OS}"
    --arch           "${HOST_ARCH}"
    --tier           "${tier}"
    --archive        "${archive}"
    --stage          "${STAGE}"
    --catalog-version "${catalog_version}"
    --out            "${mf}"
  )
  [[ -n "${CUDA_ARCH}" ]] && args+=( --cuda-arch "${CUDA_ARCH}" )

  node "${REPO_ROOT}/scripts/ci/emit-pack-manifest.mjs" "${args[@]}"
  log "manifest: ${mf}"
}

if [[ "${DO_PACKAGE}" == "1" ]]; then
  mkdir -p "${OUT_DIR}"
  # ★ T-145（第一次真跑 CI 才发现的，**只在 Windows 上错**）：
  #   `--out dist/packs` 是**相对路径**。下面 zip 那条要先 `cd "$(dirname STAGE)"`，
  #   于是相对的 ARCHIVE 就相对到了 `.build/whisper-win32-x64-cpu/stage/` 底下 ——
  #   zip **成功了**（exit 0），文件写在了没人看的地方，随后：
  #     windows-x64-cpu
  #       emit-pack-manifest: archive not found: dist/packs/whispercpp-cpu-win-x64.zip
  #   tar 那条没这个毛病，纯属运气：`tar -C` 是在**打开归档文件之后**才切目录的。
  #   → 先解析成绝对路径，两条分支都不再依赖 cwd。
  #   `pwd -W`：Git Bash 下给出 `D:/a/...` 这种 Windows 形态的绝对路径。
  #   7z / zip 是**原生 Windows 程序**，喂它 MSYS 形态的 `/d/a/...` 是在赌
  #   Git-for-Windows 的参数路径转换 —— 不赌。其它平台没有 `-W`，回退到 `pwd`。
  OUT_DIR="$(cd "${OUT_DIR}" && { pwd -W 2>/dev/null || pwd; })"
  if [[ "${HOST_OS}" == "win32" ]]; then
    ARCHIVE="${OUT_DIR}/${PACK_ID}.zip"
    rm -f "${ARCHIVE}"
    ( cd "$(dirname "${STAGE}")" && (command -v 7z >/dev/null && 7z a -tzip "${ARCHIVE}" "$(basename "${STAGE}")" >/dev/null || zip -qr "${ARCHIVE}" "$(basename "${STAGE}")") )
  else
    ARCHIVE="${OUT_DIR}/${PACK_ID}.tar.gz"
    rm -f "${ARCHIVE}"
    tar czf "${ARCHIVE}" -C "$(dirname "${STAGE}")" "$(basename "${STAGE}")"
  fi
  emit_manifest "${ARCHIVE}"
  log "pack:     ${ARCHIVE} ($(du -h "${ARCHIVE}" | cut -f1))"
fi

log "contents:"
find "${STAGE}" -type f -printf '  %-46f %10s\n' 2>/dev/null ||
  find "${STAGE}" -type f -exec sh -c 'printf "  %-46s %10s\n" "$(basename "$1")" "$(stat -f%z "$1")"' _ {} \;

log "done: ${PACK_ID}"
