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
    [[ "${HOST_OS}" == "darwin" ]] || die "coreml backend requires a macOS host"
    # UNVERIFIED: needs per-model .mlmodelc generated by CI (coremltools). Requirement
    # 2.1 forbids making the user run Python, so the encoder must be pre-generated.
    BACKEND_FLAGS+=( -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DWHISPER_COREML=ON -DWHISPER_COREML_ALLOW_FALLBACK=ON )
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
# L2 "accel" = ONLY the single ggml-<backend> shared library (+ vendor runtime libs).
#              This is the on-demand download. Keeping it to just the delta is what
#              makes requirement 2.1 cheap.
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

copy_if_exists() { for f in "$@"; do [[ -e "$f" ]] && cp -a "$f" "${STAGE}/"; done; true; }

if [[ "${BACKEND}" == "cpu" ]]; then
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

  # ★ 守卫：核心包里**必须**至少有一个 ggml CPU 后端模块。
  #   上面那个 bug 的要害不是"少拷了一个文件"，是**少拷了它还报绿**。
  #   判据不是"记得把后缀写对"，是"写错了会当场红"。
  if ! ls "${STAGE}/${LIB_PREFIX}ggml-cpu"*".${MOD_EXT}" >/dev/null 2>&1; then
    {
      echo "==> BIN_DIR (${BIN_DIR}) 实际内容："
      ls -la "${BIN_DIR}" 2>&1 || true
    } >&2
    die "核心包里没有任何 ggml CPU 后端模块（找的是 ${LIB_PREFIX}ggml-cpu*.${MOD_EXT}）。
  GGML_BACKEND_DL=ON 下后端是运行时加载的模块，少了它 whisper-cli 一个后端都注册不到 ——
  **而这种包在过去是能打出来并报绿的**（T-145 在 macos-arm64-cpu 上实测到）。"
  fi
else
  # Accelerator packs carry ONLY the delta over the core pack.
  # ★ T-145：加速后端也是 MODULE，darwin 上同样是 `.so`（见上面那段）。
  copy_if_exists "${BIN_DIR}/${LIB_PREFIX}ggml-${BACKEND}.${MOD_EXT}"
  # Vendor runtime libraries that ggml links but the OS does not provide.
  # NOTE: libcuda / nvcuda ships with the NVIDIA *driver* and must NEVER be redistributed.
  case "${BACKEND}" in
    cuda)
      copy_if_exists \
        "${BIN_DIR}/cudart64_"*.dll "${BIN_DIR}/cublas64_"*.dll \
        "${BIN_DIR}/cublasLt64_"*.dll "${BIN_DIR}/nvrtc"*.dll
      ;;
  esac
fi

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
