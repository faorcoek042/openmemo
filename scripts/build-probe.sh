#!/usr/bin/env bash
#
# build-probe.sh — compiles packages/runtime/src/native/probe.c into `openmemo-probe`.
#
# OWNER: gpu-runtime (T-012).
#
# The probe is the ONLY trustworthy answer to "which accelerators can this machine
# actually use". It links just ggml-base + ggml and dlopen's whatever backend libraries
# are present in the directory it is pointed at, then prints the enumerated devices as
# JSON. See packages/runtime/src/native/probe.c for why file-existence checks are not
# acceptable (two reverse-examples were measured on the T-012 box).
#
# It is deliberately a SEPARATE EXECUTABLE, not an N-API addon: with no CPU backend
# present ggml calls ggml_abort() and the process dies with SIGABRT (measured: exit 134).
# In-process, that would kill the daemon.
#
# Usage:
#   scripts/build-probe.sh                          # uses vendor/whisper.cpp + .build/...
#   scripts/build-probe.sh --ggml-lib-dir <dir> --out <file>
#
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

SRC_C="${REPO_ROOT}/packages/runtime/src/native/probe.c"
INCLUDE_DIR="${REPO_ROOT}/vendor/whisper.cpp/ggml/include"
GGML_LIB_DIR=""
OUT=""

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
log() { printf '\033[36m==>\033[0m %s\n' "$*" >&2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ggml-lib-dir) GGML_LIB_DIR="$2"; shift 2 ;;
    --include)      INCLUDE_DIR="$2";  shift 2 ;;
    --out)          OUT="$2";          shift 2 ;;
    -h|--help)      sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

case "$(uname -s)" in
  Linux)  HOST_OS="linux"  ;;
  Darwin) HOST_OS="darwin" ;;
  MINGW*|MSYS*|CYGWIN*) HOST_OS="win32" ;;
  *) die "unsupported host OS: $(uname -s)" ;;
esac
case "$(uname -m)" in
  x86_64|amd64)  HOST_ARCH="x64"   ;;
  arm64|aarch64) HOST_ARCH="arm64" ;;
  *) die "unsupported host arch: $(uname -m)" ;;
esac

[[ -n "${GGML_LIB_DIR}" ]] || GGML_LIB_DIR="${REPO_ROOT}/.build/whisper-${HOST_OS}-${HOST_ARCH}-cpu/bin"
[[ -n "${OUT}" ]] || OUT="${REPO_ROOT}/dist/probe/openmemo-probe$([[ "${HOST_OS}" == "win32" ]] && echo .exe)"

[[ -f "${SRC_C}" ]]        || die "probe source not found: ${SRC_C}"
[[ -d "${INCLUDE_DIR}" ]]  || die "ggml headers not found: ${INCLUDE_DIR}
  Run: git submodule update --init --depth 1 vendor/whisper.cpp"
[[ -d "${GGML_LIB_DIR}" ]] || die "ggml libraries not found: ${GGML_LIB_DIR}
  Build the CPU pack first: scripts/build-whisper.sh --backend cpu"

mkdir -p "$(dirname "${OUT}")"

CFLAGS=( -O2 -Wall -Wextra -std=c11 -I "${INCLUDE_DIR}" )
LDFLAGS=( -L "${GGML_LIB_DIR}" -lggml-base -lggml )

# Resolve the ggml libs relative to the probe's own location so the pack stays relocatable.
case "${HOST_OS}" in
  linux)  LDFLAGS+=( -Wl,-rpath,'$ORIGIN' ) ;;
  darwin) LDFLAGS+=( -Wl,-rpath,@executable_path ) ;;
esac

log "compiling ${SRC_C}"
log "  include: ${INCLUDE_DIR}"
log "  libs:    ${GGML_LIB_DIR}"
"${CC:-cc}" "${CFLAGS[@]}" -o "${OUT}" "${SRC_C}" "${LDFLAGS[@]}"

# Apple silicon will not execute an unsigned binary at all (ADR-003 decision 4).
if [[ "${HOST_OS}" == "darwin" ]]; then
  codesign --force --sign - "${OUT}" 2>/dev/null || log "warn: ad-hoc codesign failed"
fi

log "built: ${OUT} ($(du -h "${OUT}" | cut -f1))"
log "smoke test:"
# ★ T-145（第一次真跑 Windows 才看得见）：这条冒烟测试原本只设
#   `LD_LIBRARY_PATH` / `DYLD_LIBRARY_PATH` —— **在 Windows 上这两个变量都是死的**
#   （platform T-141 §3 第 18 条早就点名了这一点，但当时是 `[读码]`）。
#   Windows 的加载器按「exe 自己的目录 → PATH → …」找 DLL，而 ggml 的 DLL 在
#   `${GGML_LIB_DIR}`（= .build/…/bin/Release），probe.exe 却被写到 dist/probe/ 。
#   实测（run 31017917421, windows-x64-cpu）：
#     ==> built: dist/probe/openmemo-probe.exe (60K)
#     ==> smoke test:
#     error: probe did not produce output
#   —— 编得出来、跑不起来，而且**上一步刚刚成功打出了第一个 Windows 包**，
#      所以这条是新暴露出来的下一层，不是回归。
#   → Windows 上把库目录加进 PATH。三个变量都设是刻意的：**没有哪个平台会因为
#     多了一个它不认识的环境变量而出错**，而"每个平台各设各的"要靠人记得。
if PATH="${GGML_LIB_DIR}:${PATH}" \
   LD_LIBRARY_PATH="${GGML_LIB_DIR}" DYLD_LIBRARY_PATH="${GGML_LIB_DIR}" \
   "${OUT}" "${GGML_LIB_DIR}" 2>/dev/null | head -8; then
  log "probe OK"
else
  die "probe did not produce output
  GGML_LIB_DIR=${GGML_LIB_DIR}
  该目录的内容：
$(ls -la "${GGML_LIB_DIR}" 2>&1 | sed 's/^/    /' || true)"
fi
