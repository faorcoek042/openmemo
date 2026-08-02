#!/usr/bin/env bash
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
  # Make the pack relocatable: resolve sibling .so files relative to the binary itself,
  # so an extracted pack runs from anywhere with no LD_LIBRARY_PATH. Same flags
  # llama.cpp's release CI uses. Verified: extracted to a clean dir and run under
  # `env -u LD_LIBRARY_PATH`, whisper-cli loaded libggml-cpu-zen4.so from its own folder.
  -DCMAKE_INSTALL_RPATH='$ORIGIN'
  -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON
)

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
PACK_ID="whispercpp-${BACKEND}-${HOST_OS}-${HOST_ARCH}"

log "host=${HOST_OS}/${HOST_ARCH} backend=${BACKEND} jobs=${JOBS}"
log "src=${SRC_DIR}"
log "build=${BUILD_DIR}"

# --------------------------------------------------------------------------------------
# configure + build
# --------------------------------------------------------------------------------------
rm -rf "${BUILD_DIR}"
cmake -S "${SRC_DIR}" -B "${BUILD_DIR}" "${COMMON_FLAGS[@]}" "${BACKEND_FLAGS[@]}"
cmake --build "${BUILD_DIR}" --config Release -j "${JOBS}"

BIN_DIR="${BUILD_DIR}/bin"
[[ -d "${BIN_DIR}" ]] || BIN_DIR="${BUILD_DIR}/Release/bin"
[[ -d "${BIN_DIR}" ]] || die "cannot locate build output dir under ${BUILD_DIR}"

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

case "${HOST_OS}" in
  win32)  SO_EXT="dll";   LIB_PREFIX="" ;;
  darwin) SO_EXT="dylib"; LIB_PREFIX="lib" ;;
  *)      SO_EXT="so";    LIB_PREFIX="lib" ;;
esac

copy_if_exists() { for f in "$@"; do [[ -e "$f" ]] && cp -a "$f" "${STAGE}/"; done; true; }

if [[ "${BACKEND}" == "cpu" ]]; then
  copy_if_exists \
    "${BIN_DIR}/${LIB_PREFIX}ggml-base."*"${SO_EXT}"* \
    "${BIN_DIR}/${LIB_PREFIX}ggml."*"${SO_EXT}"* \
    "${BIN_DIR}/${LIB_PREFIX}ggml-cpu-"*".${SO_EXT}" \
    "${BIN_DIR}/${LIB_PREFIX}whisper."*"${SO_EXT}"* \
    "${BIN_DIR}/${LIB_PREFIX}parakeet."*"${SO_EXT}"* \
    "${BIN_DIR}/whisper-cli"* \
    "${BIN_DIR}/whisper-server"* \
    "${BIN_DIR}/whisper-bench"* \
    "${BIN_DIR}/whisper-vad-speech-segments"*
else
  # Accelerator packs carry ONLY the delta over the core pack.
  copy_if_exists "${BIN_DIR}/${LIB_PREFIX}ggml-${BACKEND}.${SO_EXT}"
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
# input to the shared downloader (ADR-003 decision 6). SHA256 of every file is recorded
# here so the downloader can verify -- Ollama's downloader famously does not, and
# ADR-004 decision 5 requires us to fix that.
# --------------------------------------------------------------------------------------
emit_manifest() {
  local archive="$1"
  local mf="${OUT_DIR}/${PACK_ID}.json"
  {
    printf '{\n'
    printf '  "schemaVersion": 1,\n'
    printf '  "id": "%s",\n' "${PACK_ID}"
    printf '  "engine": "whisper.cpp",\n'
    printf '  "engineVersion": "%s",\n' "$(git -C "${SRC_DIR}" describe --tags --always 2>/dev/null || echo unknown)"
    printf '  "engineCommit": "%s",\n' "$(git -C "${SRC_DIR}" rev-parse HEAD 2>/dev/null || echo unknown)"
    printf '  "ggmlAbi": "%s",\n' "${GGML_ABI}"
    printf '  "backend": "%s",\n' "${BACKEND}"
    printf '  "tier": "%s",\n' "$([[ "${BACKEND}" == "cpu" ]] && echo builtin || echo downloadable)"
    printf '  "os": "%s",\n' "${HOST_OS}"
    printf '  "arch": "%s",\n' "${HOST_ARCH}"
    printf '  "buildHost": "%s",\n' "$(uname -srm)"
    printf '  "builtAt": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    [[ -n "${CUDA_ARCH}" ]] && printf '  "cudaArchitectures": ["%s"],\n' "${CUDA_ARCH//;/\",\"}"
    printf '  "benchmark": null,\n'
    printf '  "archive": {\n'
    printf '    "name": "%s",\n' "$(basename "${archive}")"
    printf '    "sizeBytes": %s,\n' "$(stat -c%s "${archive}" 2>/dev/null || stat -f%z "${archive}")"
    printf '    "sha256": "%s"\n' "$(sha256sum "${archive}" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "${archive}" | cut -d' ' -f1)"
    printf '  },\n'
    printf '  "files": [\n'
    local first=1
    while IFS= read -r f; do
      local rel; rel="${f#"${STAGE}/"}"
      local sz;  sz="$(stat -c%s "$f" 2>/dev/null || stat -f%z "$f")"
      local sum; sum="$(sha256sum "$f" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$f" | cut -d' ' -f1)"
      [[ ${first} -eq 0 ]] && printf ',\n'
      printf '    { "name": "%s", "sizeBytes": %s, "sha256": "%s" }' "${rel}" "${sz}" "${sum}"
      first=0
    done < <(find "${STAGE}" -type f | sort)
    printf '\n  ]\n}\n'
  } > "${mf}"
  log "manifest: ${mf}"
}

if [[ "${DO_PACKAGE}" == "1" ]]; then
  mkdir -p "${OUT_DIR}"
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
