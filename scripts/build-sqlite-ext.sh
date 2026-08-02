#!/usr/bin/env bash
#
# ══════════════════════════════════════════════════════════════════════════════════════
#  ⚠️  停用（ADR-015：上游预编译优先）—— 默认路径不再使用本脚本
#
#  上游已经发布了我们需要的现成产物，实地核实（T-063）：
#    libsimple  v0.7.1  12 个平台包（linux/osx/windows/android/ios）
#               libsimple-linux-ubuntu-22.04.zip  5,337,804 B
#               sha256 0c9a7a578fc50ef5480e69e1e1880535ae68d75e1c1580f6bf106073087642a5
#               内含 libsimple.so + 完整 dict/（含 jieba.dict.utf8、idf.utf8、pos_dict/）
#               —— 比本脚本打出来的还全，本脚本只打了 5 个 .utf8、漏了 pos_dict/
#    sqlite-vec v0.1.9  loadable-{linux,macos,windows}-*，另有官方 checksums.txt
#               sqlite-vec-0.1.9-loadable-linux-x86_64.tar.gz  61,507 B
#               sha256 b959baa1d8dc88861b1edb337b8587178cdcb12d60b4998f9d10b6a82052d5d7
#               （与官方 checksums.txt 逐字一致）
#
#  两者都已按上游直连写进 vendor/manifests/，走与其它制品相同的下载安装机制。
#
#  **本脚本保留而非删除**，因为它仍是唯一的退路：上游哪天缺某个平台/架构（例如需要
#  自定义编译选项、或上游停更某个平台）时，用它自建。日常不要跑。
#
#  自我更正记录：T-037 写这个脚本时我没有先去看上游 releases 就开始从源码编译。
#  判据应当是"上游有没有我们要的那个平台的产物"，而不是"能不能编出来"。
# ══════════════════════════════════════════════════════════════════════════════════════
#
# build-sqlite-ext.sh — build the two SQLite loadable extensions the product needs.
#
# OWNER: gpu-runtime (ADR-005 decision 3: scripts/build-* is mine).
#
# WHY THIS SCRIPT EXISTS — a measured functional failure, not a nice-to-have:
#   Without libsimple, FTS5 falls back to SQLite's built-in `trigram` tokenizer, which
#   structurally CANNOT match a query shorter than 3 characters. Chinese is dominated by
#   two-character words, so on a real Chinese transcript we measured:
#       用户 -> 0 hits (appears in 7 segments)      推特 -> 0 hits (14 segments)
#       中国 -> 0 hits (6 segments)                 服务 -> 0 hits (3 segments)
#   Every one of those is a word a user would actually type. Chinese search was not
#   "degraded", it was broken. The submodule was vendored, the loader was written and the
#   fallback was written — nobody owned actually producing the .so.
#
# OUTPUT LAYOUT — fixed by packages/db/src/extensions.ts `defaultExtensionPaths()`:
#     <root>/libsimple.<so|dylib|dll>
#     <root>/dict/*.utf8          (jieba dictionaries; without them segmentation degrades)
#     <root>/vec0.<so|dylib|dll>
#
# LICENSING (R-03 §2 D9, ADR-002):
#   libsimple is dual MIT / GPL-3.0-or-later and lets the USER pick. **This project takes
#   the MIT branch.** That is a licence election, not a build flag — recorded here and in
#   the emitted manifest so the choice is auditable.
#   sqlite-vec is Apache-2.0 OR MIT; we take MIT for consistency.
#
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

SIMPLE_SRC="${REPO_ROOT}/vendor/libsimple"
VEC_SRC="${REPO_ROOT}/vendor/sqlite-vec"
OUT_DIR="${REPO_ROOT}/dist/ext"
BUILD_ROOT="${REPO_ROOT}/.build"
JOBS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"
DO_PACKAGE=1
WITH_JIEBA=ON

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
log() { printf '\033[36m==>\033[0m %s\n' "$*" >&2; }

usage() {
  cat >&2 <<'EOF'
usage: scripts/build-sqlite-ext.sh [options]

  --out <dir>        output directory              default: dist/ext
  --build-root <dir> cmake build parent            default: .build
  --jobs <n>         parallel build jobs
  --no-jieba         build libsimple without cppjieba (smaller, worse segmentation)
  --no-package       skip archive + manifest emission
  -h, --help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)        OUT_DIR="$2"; shift 2 ;;
    --build-root) BUILD_ROOT="$2"; shift 2 ;;
    --jobs)       JOBS="$2"; shift 2 ;;
    --no-jieba)   WITH_JIEBA=OFF; shift ;;
    --no-package) DO_PACKAGE=0; shift ;;
    -h|--help)    usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

case "$(uname -s)" in
  Linux)  HOST_OS="linux";  LIB_EXT="so" ;;
  Darwin) HOST_OS="darwin"; LIB_EXT="dylib" ;;
  MINGW*|MSYS*|CYGWIN*) HOST_OS="win32"; LIB_EXT="dll" ;;
  *) die "unsupported host OS: $(uname -s)" ;;
esac
case "$(uname -m)" in
  x86_64|amd64)  HOST_ARCH="x64"   ;;
  arm64|aarch64) HOST_ARCH="arm64" ;;
  *) die "unsupported host arch: $(uname -m)" ;;
esac

[[ -f "${SIMPLE_SRC}/CMakeLists.txt" ]] || die "libsimple not found at ${SIMPLE_SRC}
  Run: git submodule update --init --depth 1 vendor/libsimple"
[[ -f "${VEC_SRC}/sqlite-vec.c" ]] || die "sqlite-vec not found at ${VEC_SRC}
  Run: git submodule update --init --depth 1 vendor/sqlite-vec"

mkdir -p "${OUT_DIR}/dict"

# =======================================================================================
# 1. libsimple — FTS5 tokenizer with Chinese word segmentation + pinyin
# =======================================================================================
SIMPLE_BUILD="${BUILD_ROOT}/libsimple-${HOST_OS}-${HOST_ARCH}"
log "building libsimple (jieba=${WITH_JIEBA})"

rm -rf "${SIMPLE_BUILD}"
cmake -S "${SIMPLE_SRC}" -B "${SIMPLE_BUILD}" \
  -DCMAKE_BUILD_TYPE=Release \
  -DSIMPLE_WITH_JIEBA="${WITH_JIEBA}" \
  -DBUILD_TEST_EXAMPLE=OFF \
  -DBUILD_SHELL=OFF \
  -DCMAKE_POSITION_INDEPENDENT_CODE=ON >/dev/null
cmake --build "${SIMPLE_BUILD}" -j "${JOBS}" >/dev/null

SIMPLE_LIB="$(find "${SIMPLE_BUILD}" -name "libsimple.${LIB_EXT}" -o -name "simple.${LIB_EXT}" | head -1)"
[[ -n "${SIMPLE_LIB}" ]] || die "libsimple build produced no ${LIB_EXT}"
cp -f "${SIMPLE_LIB}" "${OUT_DIR}/libsimple.${LIB_EXT}"
log "  -> ${OUT_DIR}/libsimple.${LIB_EXT}"

# The jieba dictionaries are DATA, not build output, but libsimple only stages them under
# its test tree. Without them the tokenizer still loads and still beats trigram, but word
# segmentation degrades toward character splitting — so they ship with the extension.
DICT_SRC="$(find "${SIMPLE_BUILD}" -type d -name dict | head -1)"
if [[ -z "${DICT_SRC}" ]]; then
  DICT_SRC="$(find "${SIMPLE_SRC}" -type d -name dict | head -1)"
fi
if [[ -n "${DICT_SRC}" ]]; then
  cp -f "${DICT_SRC}"/*.utf8 "${OUT_DIR}/dict/" 2>/dev/null || true
  log "  -> ${OUT_DIR}/dict/ ($(find "${OUT_DIR}/dict" -name '*.utf8' | wc -l | tr -d ' ') dictionaries)"
else
  log "  warn: jieba dictionaries not found; segmentation quality will be reduced"
fi

# =======================================================================================
# 2. sqlite-vec — vec0 virtual table
#
# Single-file amalgamation, so no cmake. Its header is generated from a template by the
# upstream Makefile via envsubst; we do the same rather than hand-writing it, so the
# version constants baked into the binary stay truthful.
# =======================================================================================
VEC_BUILD="${BUILD_ROOT}/sqlite-vec-${HOST_OS}-${HOST_ARCH}"
log "building sqlite-vec"
mkdir -p "${VEC_BUILD}"

(
  cd "${VEC_SRC}"
  VERSION="$(cat VERSION)"
  export VERSION
  export DATE="$(date -u +'%FT%TZ%z')"
  export SOURCE="$(git log -n1 --pretty=format:%H 2>/dev/null || echo vendored)"
  export VERSION_MAJOR="${VERSION%%.*}"
  local_rest="${VERSION#*.}"
  export VERSION_MINOR="${local_rest%%.*}"
  patch="${VERSION##*.}"
  export VERSION_PATCH="${patch%%-*}"
  envsubst < sqlite-vec.h.tmpl > "${VEC_BUILD}/sqlite-vec.h"
)

# NOTE: do NOT pass -DSQLITE_CORE (not even =0).
#
# sqlite-vec.h keys off `#ifndef SQLITE_CORE` to decide between `sqlite3ext.h`
# (loadable-extension mode, which also emits SQLITE_EXTENSION_INIT1) and `sqlite3.h`
# (statically-linked-into-SQLite mode). `-DSQLITE_CORE=0` DEFINES the macro, so the
# header takes the static path, the extension API pointer is never initialised, and the
# .so builds cleanly then segfaults the host process the moment it is loaded — measured,
# exit 139 on `db.loadExtension()`.
VEC_CFLAGS=(-O3 -fPIC -shared -I"${VEC_BUILD}")
if [[ "${HOST_OS}" == "darwin" ]]; then
  # Loadable modules on macOS must not have undefined symbols resolved at link time —
  # sqlite3_* come from the host process.
  VEC_CFLAGS+=(-undefined dynamic_lookup)
fi

"${CC:-cc}" "${VEC_CFLAGS[@]}" -o "${OUT_DIR}/vec0.${LIB_EXT}" "${VEC_SRC}/sqlite-vec.c"
log "  -> ${OUT_DIR}/vec0.${LIB_EXT}"

# macOS: Apple silicon refuses to execute/load unsigned code (ADR-003 decision 4).
if [[ "${HOST_OS}" == "darwin" ]]; then
  for f in "${OUT_DIR}/libsimple.${LIB_EXT}" "${OUT_DIR}/vec0.${LIB_EXT}"; do
    codesign --force --sign - "$f" 2>/dev/null || log "warn: ad-hoc codesign failed for $f"
  done
fi

# =======================================================================================
# 3. Self-test — the ONLY acceptance criterion is "a two-character Chinese word matches".
#
# "The extension loaded" is not a test: trigram also loads, and trigram is what was
# broken. So we build a tiny FTS5 table with the `simple` tokenizer and search the exact
# words that returned zero before.
# =======================================================================================
log "self-test: two-character Chinese search"
# Exclude @types/* — it matches the directory name but holds only .d.ts files.
BS3="$(find "${REPO_ROOT}/node_modules/.pnpm" -maxdepth 4 -type d -name better-sqlite3 2>/dev/null | grep -v '@types' | head -1)"
if [[ -z "${BS3}" ]]; then
  log "  warn: better-sqlite3 not installed; skipping self-test"
else
  # Written to a file and given its inputs as argv rather than inlined with -e:
  # nesting JS quotes inside a double-quoted shell string mangles the program (it was
  # being echoed instead of run, and the shell exited 139).
  SELFTEST="${BUILD_ROOT}/ext-selftest.mjs"
  mkdir -p "${BUILD_ROOT}"
  cat > "${SELFTEST}" <<'SELFTEST_EOF'
import { createRequire } from 'node:module';

const [bs3, simplePath, dictPath, vecPath] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const Database = require(bs3);

const db = new Database(':memory:');
db.loadExtension(simplePath);
db.exec(`select jieba_dict('${dictPath.replace(/'/g, "''")}')`);
db.exec("CREATE VIRTUAL TABLE t USING fts5(x, tokenize='simple')");

const ins = db.prepare('INSERT INTO t(x) VALUES (?)');
for (const s of [
  'Twitter,非官方中文名称推特,是一个社交网络及微博客服务',
  '用户可以经由SMS、即时通讯、电邮、Twitter网站或Twitter用户端软件',
  '2009年6月2日下午,中国大陆封锁了推特',
  '目前手机SMS更新服务暂时只有在美国、加拿大及英国可获得免费服务',
]) ins.run(s);

// The acceptance criterion. "Extension loaded" proves nothing — trigram loads too, and
// trigram is exactly what was broken.
let bad = 0;
for (const q of ['用户', '推特', '中国', '服务']) {
  const n = db.prepare('SELECT count(*) c FROM t WHERE t MATCH ?').get(q).c;
  console.log(`    ${q} -> ${n} hits`);
  if (n === 0) bad += 1;
}

db.loadExtension(vecPath);
console.log(`    vec_version: ${db.prepare('select vec_version() v').get().v}`);

if (bad > 0) {
  console.error(`FAIL: ${bad} two-character Chinese queries returned zero hits`);
  process.exit(1);
}
SELFTEST_EOF

  node "${SELFTEST}" "${BS3}" \
    "${OUT_DIR}/libsimple.${LIB_EXT}" "${OUT_DIR}/dict" "${OUT_DIR}/vec0.${LIB_EXT}" \
    || die "self-test failed: Chinese two-character search still returns nothing"
  log "  self-test passed"
fi

# =======================================================================================
# 4. Package + manifest (ADR-001 class C: runtime download, sha256 in git)
# =======================================================================================
if [[ "${DO_PACKAGE}" == "1" ]]; then
  PACK_ID="sqlite-ext-${HOST_OS}-${HOST_ARCH}"
  STAGE="${BUILD_ROOT}/stage/${PACK_ID}"
  rm -rf "${STAGE}"; mkdir -p "${STAGE}/dict"
  cp -f "${OUT_DIR}/libsimple.${LIB_EXT}" "${OUT_DIR}/vec0.${LIB_EXT}" "${STAGE}/"
  cp -f "${OUT_DIR}/dict/"*.utf8 "${STAGE}/dict/" 2>/dev/null || true

  if [[ "${HOST_OS}" == "win32" ]]; then
    ARCHIVE="${OUT_DIR}/${PACK_ID}.zip"
    rm -f "${ARCHIVE}"
    ( cd "$(dirname "${STAGE}")" && (command -v 7z >/dev/null && 7z a -tzip "${ARCHIVE}" "$(basename "${STAGE}")" >/dev/null || zip -qr "${ARCHIVE}" "$(basename "${STAGE}")") )
  else
    ARCHIVE="${OUT_DIR}/${PACK_ID}.tar.gz"
    rm -f "${ARCHIVE}"
    tar czf "${ARCHIVE}" -C "$(dirname "${STAGE}")" "$(basename "${STAGE}")"
  fi

  sum() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$1" | cut -d' ' -f1; }
  size() { stat -c%s "$1" 2>/dev/null || stat -f%z "$1"; }

  {
    printf '{\n'
    printf '  "schemaVersion": 1,\n'
    printf '  "id": "%s",\n' "${PACK_ID}"
    printf '  "kind": "sqlite-extension",\n'
    printf '  "os": "%s",\n' "${HOST_OS}"
    printf '  "arch": "%s",\n' "${HOST_ARCH}"
    printf '  "builtAt": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '  "buildHost": "%s",\n' "$(uname -srm)"
    printf '  "components": [\n'
    printf '    { "name": "libsimple", "version": "%s", "license": "MIT",\n' "$(git -C "${SIMPLE_SRC}" describe --tags --always 2>/dev/null || echo unknown)"
    printf '      "licenseNote": "dual MIT OR GPL-3.0-or-later; this project elects MIT (R-03 D9)",\n'
    printf '      "purpose": "FTS5 Chinese word segmentation + pinyin. Without it FTS5 falls back to trigram, which cannot match queries shorter than 3 characters." },\n'
    printf '    { "name": "sqlite-vec", "version": "%s", "license": "MIT",\n' "$(git -C "${VEC_SRC}" describe --tags --always 2>/dev/null || echo unknown)"
    printf '      "licenseNote": "dual Apache-2.0 OR MIT; this project elects MIT",\n'
    printf '      "purpose": "vec0 virtual table for vector search." }\n'
    printf '  ],\n'
    printf '  "installPath": "bin/ext",\n'
    printf '  "providesFiles": ["libsimple.%s", "vec0.%s", "dict/jieba.dict.utf8"],\n' "${LIB_EXT}" "${LIB_EXT}"
    printf '  "archive": { "name": "%s", "sizeBytes": %s, "sha256": "%s" },\n' \
      "$(basename "${ARCHIVE}")" "$(size "${ARCHIVE}")" "$(sum "${ARCHIVE}")"
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

  log "pack:     ${ARCHIVE} ($(du -h "${ARCHIVE}" | cut -f1))"
  log "manifest: ${OUT_DIR}/${PACK_ID}.json"
fi

log "done: ${PACK_ID:-sqlite-ext} (${HOST_OS}/${HOST_ARCH})"
