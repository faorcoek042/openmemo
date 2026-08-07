#!/usr/bin/env bash
#
# ══════════════════════════════════════════════════════════════════════════════════════
#  ⚠️  降级为「可选重打包」（ADR-015：上游预编译优先）
#
#  默认路径改为**直连上游** BtbN/FFmpeg-Builds 的不可变日期 tag，例如
#    autobuild-2026-08-02-13-17 / ffmpeg-n7.1.5-12-g1fdbca85aa-linux64-gpl-7.1.tar.xz
#  该构建同时含 ffmpeg 与 ffprobe（T-050 实测：ffprobe 真能探测，非仅存在）。
#  这样我们不必自己托管任何东西，也就不需要 GitHub release —— 正是这一点解开了
#  "发布渠道"阻塞。
#
#  **本脚本保留**，用途只剩两个：
#    1. 瘦身 —— 上游包 119 MB，含大量我们用不到的东西；本脚本只留两个二进制；
#    2. macOS —— evermeet.cx 把 ffmpeg / ffprobe 拆成两个归档，上游没有单一现成包。
#
#  前置条件说明：上游是 .tar.xz，需要解包器支持 xz（已转 model-mgmt）。
#  若不加 xz 支持，退路就是用本脚本重打包成 tar.gz。
# ══════════════════════════════════════════════════════════════════════════════════════
#
# build-media-tools.sh — package ffmpeg + ffprobe as an OpenMemo backend pack.
#
# OWNER: gpu-runtime (T-050). Companion to build-whisper.sh / build-sqlite-ext.sh.
#
# ── WHY A BACKEND PACK AND NOT `ffmpeg-static` (the decision, with the reasoning) ──────
#
# ADR-002 v2 permits `ffmpeg-static` (GPL, personal-use tier), and it would have been the
# faster route. It is not usable, for a reason that is decisive rather than stylistic:
#
#   **`ffmpeg-static` ships ffmpeg ONLY. There is no ffprobe in the package.**
#   (verified: the installed package contains `ffmpeg` and nothing else executable)
#
# The pipeline depends on ffprobe in ten places, and not for cosmetics:
#   - D-01 §8.5 requires the true media type to come from ffprobe, never from the
#     extension or the server's Content-Type;
#   - the T-026 security fix rejects local playlist imports by checking ffprobe's
#     `format_name` for hls/applehttp — a renamed `.m3u8` is caught there and nowhere else.
# So option (a) cannot satisfy the product; we would need a second package
# (`ffprobe-static`) with a second licence and a second update path.
#
# Two further reasons the pack route is right rather than merely adequate:
#   - ADR-001 class C requires runtime-downloaded binaries to carry a manifest entry with
#     a SHA-256 in git. `ffmpeg-static` downloads its binary during `npm install` from a
#     URL we do not record — outside the "what did we download" audit trail entirely.
#   - Keeping a GPL component as a separately-downloaded pack preserves the same licence
#     isolation story we use for yt-dlp: it never enters the build tree.
#
# ── WHY WE REPACKAGE INSTEAD OF POINTING AT UPSTREAM DIRECTLY ──────────────────────────
# BtbN/FFmpeg-Builds publishes static builds containing BOTH binaries, but:
#   1. they are `.tar.xz`, and our unpacker supports only zip and tar.gz;
#   2. the release tag is literally `latest` — a moving target, so a pinned SHA-256 would
#      break on every upstream rebuild, which defeats the point of pinning.
# So we fetch once, record the digest of exactly what we fetched, strip it to the two
# binaries we need (~120 MB of source archive becomes a much smaller pack), and emit our
# own tar.gz with our own manifest. Same shape as every other pack.
#
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

OUT_DIR="${REPO_ROOT}/dist/packs"
BUILD_ROOT="${REPO_ROOT}/.build"
DO_PACKAGE=1
SOURCE_URL=""

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
log() { printf '\033[36m==>\033[0m %s\n' "$*" >&2; }

# ══════════════════════════════════════════════════════════════════════════════════════
#  ⛔ GPL 确认闸门（2026-08-08，`prebuilt`；用户当日裁决 ① 之后加）
#
#  **这个脚本的产物是一个 GPL-3.0-or-later 的二进制，被重新打包成了我们自己的格式。**
#  脚本头上写得很清楚：“we emit our own tar.gz with our own manifest”。
#
#  在"个人自用"的前提下这没问题。但用户 2026-08-08 裁决把预编译包发到**公开 Release**，
#  前提变了：一旦这个产物被传上去，**我们就成了 ffmpeg 的分发者** ——
#  ADR-002 的「一旦要分发就是硬阻断」当场触发，而 D-17 §1 那整套
#  「GPL 不触发」的结论会随之全部失效。
#
#  通往那里的路是现成的：`scripts/ci/release-upload.mjs` 读 `dist/packs`，
#  而本脚本的默认输出目录**正是 `dist/packs`**。也就是说跑一次它、再跑一次上传，
#  中间没有任何一步会说话。
#
#  → 上传那一侧现在有许可证闸门了（release-upload.mjs 会拒绝 GPL 资产），
#    这里这道是**第二层**：让"我正在生产一份 GPL 产物"这件事在**生产的那一刻**
#    就需要一次明确的确认，而不是等到上传时才被拦。
#
#  判据仍是 PROTOCOL §7 补充那条：**不是"要记得别跑"，是"跑错了也不会造成后果"。**
#  两层都拦，且都不依赖任何人记得什么。
# ══════════════════════════════════════════════════════════════════════════════════════
if [[ "${OPENMEMO_ALLOW_GPL_REPACK:-}" != "1" ]]; then
  cat >&2 <<'GPLGATE'
[31merror:[0m 拒绝执行 —— 本脚本会产出一份 GPL-3.0-or-later 的产物（ffmpeg/ffprobe），
       并把它打包成 OpenMemo 自己的 pack 格式，默认落在 dist/packs/。

  为什么现在需要确认（以前不需要）：
    用户 2026-08-08 裁决把预编译包发到**公开 Release**。在那个前提下，
    把这个产物传上去 = 我们分发 GPL 二进制 = ADR-002 的硬阻断当场触发，
    且 docs/design/D-17-prebuilt-bundles.md §1 的整套结论随之失效。

  绝大多数情况下你不需要它：
    ADR-015 已把默认路径改成**直连上游** BtbN/FFmpeg-Builds，
    由**用户自己的机器**去取。那条路不触发任何分发义务。

  确实需要本地重打包（瘦身 / macOS 拆包）时：
    OPENMEMO_ALLOW_GPL_REPACK=1 bash scripts/build-media-tools.sh ...

  ⚠️ 即使这样产出了，也**不要**上传到我们的 Release ——
     scripts/ci/release-upload.mjs 的许可证闸门会拒绝它（那是第二层拦截）。
GPLGATE
  exit 1
fi
log "⚠️ OPENMEMO_ALLOW_GPL_REPACK=1 —— 正在生产 GPL 产物，请勿上传到我们自己的 Release"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)        OUT_DIR="$2"; shift 2 ;;
    --build-root) BUILD_ROOT="$2"; shift 2 ;;
    --source)     SOURCE_URL="$2"; shift 2 ;;
    --no-package) DO_PACKAGE=0; shift ;;
    -h|--help)
      sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

case "$(uname -s)" in
  Linux)  HOST_OS="linux";  EXE="" ;;
  Darwin) HOST_OS="darwin"; EXE="" ;;
  MINGW*|MSYS*|CYGWIN*) HOST_OS="win32"; EXE=".exe" ;;
  *) die "unsupported host OS: $(uname -s)" ;;
esac
case "$(uname -m)" in
  x86_64|amd64)  HOST_ARCH="x64"   ;;
  arm64|aarch64) HOST_ARCH="arm64" ;;
  *) die "unsupported host arch: $(uname -m)" ;;
esac

# Upstream static builds per platform. Each ships BOTH ffmpeg and ffprobe.
if [[ -z "${SOURCE_URL}" ]]; then
  case "${HOST_OS}/${HOST_ARCH}" in
    linux/x64)
      SOURCE_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n7.1-latest-linux64-gpl-7.1.tar.xz" ;;
    linux/arm64)
      SOURCE_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n7.1-latest-linuxarm64-gpl-7.1.tar.xz" ;;
    win32/x64)
      SOURCE_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n7.1-latest-win64-gpl-7.1.zip" ;;
    darwin/*)
      # UNVERIFIED: no Mac available. evermeet.cx publishes ffmpeg and ffprobe as
      # separate archives, so the macOS path needs two fetches, not one.
      die "macOS packs are not wired up yet (needs two separate archives; no Mac to verify on)" ;;
    *) die "no known upstream source for ${HOST_OS}/${HOST_ARCH}" ;;
  esac
fi

PACK_ID="media-tools-${HOST_OS}-${HOST_ARCH}"
WORK="${BUILD_ROOT}/${PACK_ID}"
STAGE="${WORK}/stage/${PACK_ID}"
rm -rf "${WORK}"; mkdir -p "${STAGE}" "${OUT_DIR}"

sum()  { sha256sum "$1" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$1" | cut -d' ' -f1; }
size() { stat -c%s "$1" 2>/dev/null || stat -f%z "$1"; }

log "fetching ${SOURCE_URL}"
ARCHIVE="${WORK}/upstream.$( [[ "${SOURCE_URL}" == *.zip ]] && echo zip || echo tar.xz )"
curl -fsSL -o "${ARCHIVE}" "${SOURCE_URL}" || die "download failed"

UPSTREAM_SHA="$(sum "${ARCHIVE}")"
log "upstream sha256: ${UPSTREAM_SHA}"
log "  (recorded in the manifest — upstream uses a moving 'latest' tag, so this digest is"
log "   the only record of exactly which build we shipped)"

log "extracting"
EXTRACT="${WORK}/x"; mkdir -p "${EXTRACT}"
if [[ "${ARCHIVE}" == *.zip ]]; then
  (command -v 7z >/dev/null && 7z x -o"${EXTRACT}" "${ARCHIVE}" >/dev/null) || unzip -q "${ARCHIVE}" -d "${EXTRACT}"
else
  tar xJf "${ARCHIVE}" -C "${EXTRACT}"
fi

# Keep ONLY the two binaries. The upstream archive also carries headers, docs and static
# libraries we never use; shipping them would multiply the download for no benefit.
for bin in ffmpeg ffprobe; do
  found="$(find "${EXTRACT}" -type f -name "${bin}${EXE}" -perm -u+x | head -1)"
  [[ -n "${found}" ]] || die "upstream archive did not contain ${bin}${EXE}"
  cp "${found}" "${STAGE}/${bin}${EXE}"
  chmod +x "${STAGE}/${bin}${EXE}"
  log "  ${bin}${EXE} $(size "${STAGE}/${bin}${EXE}") bytes"
done

# Licence text must travel with a GPL binary.
LIC="$(find "${EXTRACT}" -maxdepth 3 -iname 'LICENSE*' -o -maxdepth 3 -iname 'COPYING*' | head -1)"
[[ -n "${LIC}" ]] && cp "${LIC}" "${STAGE}/LICENSE" || log "  warn: no LICENSE found in upstream archive"

# macOS: Apple silicon refuses to execute unsigned binaries at all (ADR-003 decision 4).
if [[ "${HOST_OS}" == "darwin" ]]; then
  for f in "${STAGE}"/ffmpeg "${STAGE}"/ffprobe; do
    codesign --force --sign - "$f" 2>/dev/null || log "warn: ad-hoc codesign failed for $f"
  done
fi

# ── Self-test: the binaries must RUN, and ffprobe must actually probe. ────────────────
# "The file exists" is not the check — the whole point of this pack is that ffprobe is
# present and functional, which is exactly what ffmpeg-static could not offer.
log "self-test"
"${STAGE}/ffmpeg${EXE}" -hide_banner -version >/dev/null 2>&1 || die "packed ffmpeg does not run"
FF_VER="$("${STAGE}/ffmpeg${EXE}" -hide_banner -version 2>/dev/null | head -1)"
log "  ${FF_VER}"

TESTWAV="${WORK}/selftest.wav"
"${STAGE}/ffmpeg${EXE}" -nostdin -hide_banner -loglevel error -y \
  -f lavfi -i "sine=frequency=440:duration=1" -ar 16000 -ac 1 -c:a pcm_s16le "${TESTWAV}" \
  || die "packed ffmpeg cannot transcode"
PROBED="$("${STAGE}/ffprobe${EXE}" -v error -show_entries stream=sample_rate,channels -of default=nw=1 "${TESTWAV}")"
echo "${PROBED}" | grep -q 'sample_rate=16000' || die "packed ffprobe returned unexpected output: ${PROBED}"
log "  ffprobe OK ($(echo "${PROBED}" | tr '\n' ' '))"

if [[ "${DO_PACKAGE}" == "1" ]]; then
  if [[ "${HOST_OS}" == "win32" ]]; then
    PACK="${OUT_DIR}/${PACK_ID}.zip"; rm -f "${PACK}"
    ( cd "$(dirname "${STAGE}")" && (command -v 7z >/dev/null && 7z a -tzip "${PACK}" "$(basename "${STAGE}")" >/dev/null || zip -qr "${PACK}" "$(basename "${STAGE}")") )
  else
    PACK="${OUT_DIR}/${PACK_ID}.tar.gz"; rm -f "${PACK}"
    tar czf "${PACK}" -C "$(dirname "${STAGE}")" "$(basename "${STAGE}")"
  fi

  {
    printf '{\n'
    printf '  "schemaVersion": 1,\n'
    printf '  "id": "%s",\n' "${PACK_ID}"
    printf '  "engine": "ffmpeg",\n'
    printf '  "backend": "cpu",\n'
    printf '  "tier": "builtin",\n'
    printf '  "os": "%s",\n' "${HOST_OS}"
    printf '  "arch": "%s",\n' "${HOST_ARCH}"
    printf '  "license": { "spdx": "GPL-3.0-or-later", "note": "ADR-002 v2 允许（仅个人自用）；作为独立下载包，不进构建树" },\n'
    printf '  "upstream": { "url": "%s", "sha256": "%s", "note": "上游用移动 tag latest，此摘要是我们实际打包的那一版的唯一记录" },\n' "${SOURCE_URL}" "${UPSTREAM_SHA}"
    printf '  "ffmpegVersion": "%s",\n' "$(printf '%s' "${FF_VER}" | sed 's/"/\\"/g')"
    printf '  "installPath": "media-tools",\n'
    printf '  "providesFiles": ["ffmpeg%s", "ffprobe%s"],\n' "${EXE}" "${EXE}"
    printf '  "builtAt": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '  "archive": { "name": "%s", "sizeBytes": %s, "sha256": "%s" },\n' \
      "$(basename "${PACK}")" "$(size "${PACK}")" "$(sum "${PACK}")"
    printf '  "files": [\n'
    first=1
    while IFS= read -r f; do
      rel="${f#"${STAGE}/"}"
      [[ ${first} -eq 0 ]] && printf ',\n'
      printf '    { "name": "%s", "sizeBytes": %s, "sha256": "%s" }' "${rel}" "$(size "$f")" "$(sum "$f")"
      first=0
    done < <(find "${STAGE}" -type f | sort)
    printf '\n  ]\n}\n'
  } > "${OUT_DIR}/${PACK_ID}.json"

  log "pack:     ${PACK} ($(du -h "${PACK}" | cut -f1))"
  log "manifest: ${OUT_DIR}/${PACK_ID}.json"
fi

log "done: ${PACK_ID}"
