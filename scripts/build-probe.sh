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
#
# ★ 订正（2026-08-08，`prebuilt`，PROTOCOL §13：谁发现原文不实谁就地改）
#   上面那句**按字面读是不成立的**。`[本机实测 2026-08-08]` 把探针与 ggml 核心
#   （libggml-base + libggml）单独放一个目录、**一个后端模块都不给**，然后直接跑：
#       exit 0 · {"deviceCount": 0, "devices": []}
#   —— **没有 abort，正常退出并如实报告"我一个设备都没枚举到"**。
#   （ggml 0.15.1 / commit f049fff9；来源是钉死校验过的 whispercpp-cpu-linux-x64 归档。）
#
#   ⚠️ 但这**不推翻**"独立进程而非 N-API"这个决策，也不推翻 probe.c:18 那句更窄的话
#   （它说的是 `ggml_backend_dev_backend_reg()` 里对**已枚举到的设备**取 reg 时会
#   abort，而上面这次实测 deviceCount=0，那条路径根本没走到 —— **没测到 ≠ 证伪**）。
#   GPU 驱动故障导致进程整个死掉这一条仍然成立，独立进程仍然是对的。
#   这里订正的只是"没有 CPU 后端就必然 exit 134"这个**过宽**的说法 ——
#   它恰好是"包里只带一个 CPU 模块的最小探针运行时"能否成立的前提（ADR-015 §7.5）。
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

# ══════════════════════════════════════════════════════════════════════════════════════
# ★★★ T-167：**部署目标必须显式设死** —— 这一行修的是一个已经出厂过的静默缺陷。
#
# `[本机实测 2026-08-07]` 把 CI 产物解开逐个读 `LC_BUILD_VERSION`
# （run 31121718587，macos-arm64-cpu 那条腿的两样产物）：
#
#     whispercpp-cpu-macos-arm64.tar.gz 里的 20 个 Mach-O   minos = 13.3.0
#     dist/probe/openmemo-probe                             minos = 26.0.0   ← ★
#
# 也就是说：T-146 修的是 `build-whisper.sh`（加 `-DCMAKE_OSX_DEPLOYMENT_TARGET=13.3`），
# **本文件是另一个文件，没人想到它**。而 runner 是 `macos-26`，
# 不显式指定就取构建机自己的系统版本。
#
# 后果比包里那 20 个更隐蔽：`minos` 高于用户系统时 **dyld 直接拒绝加载，进程根本不启动**，
# 而探针启动不了的表现是 `runProbe()` 返回失败 → 界面写「尚未探测到硬件能力」——
# **与"这台机器真的没有 GPU"一模一样**。清单里那条 `requiresDriver.macosVersion: "13.3"`
# 还在向用户承诺 13.3 能用。
#
# 与 T-163 在 Linux 上发现的是**同一句话**：「守卫只看包的内容，而探针是单独 upload 的」。
# 一个漏掉探针的守卫，在两个平台上各漏了一次 —— 所以 T-167 同时做了三件事：
#   ① 这一行（把值设死）；
#   ② `scripts/ci/check-macho-minos.mjs`（把它变成 CI 上会红的守卫）；
#   ③ 让探针**随包出厂**（见 build-whisper.sh），这样它自动落进既有的 stage 守卫覆盖面。
#
# 13.3 从 `scripts/lib/baselines.sh` 来，不在这里写第二遍字面量 —— 上面那三次事故
# 的共同成因就是"同一个数字写在两个地方，然后只改了一个"。
# ══════════════════════════════════════════════════════════════════════════════════════
# shellcheck source=lib/baselines.sh
source "${SCRIPT_DIR}/lib/baselines.sh"
if [[ "${HOST_OS}" == "darwin" ]]; then
  [[ -n "${OPENMEMO_MACOS_DEPLOYMENT_TARGET:-}" ]] \
    || die "scripts/lib/baselines.sh 没有给出 OPENMEMO_MACOS_DEPLOYMENT_TARGET"
  CFLAGS+=( "-mmacosx-version-min=${OPENMEMO_MACOS_DEPLOYMENT_TARGET}" )
  LDFLAGS+=( "-mmacosx-version-min=${OPENMEMO_MACOS_DEPLOYMENT_TARGET}" )
fi

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
