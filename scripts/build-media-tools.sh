#!/usr/bin/env bash
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
