#!/usr/bin/env bash
#
# 本机跑通 `scripts/build-whisper.sh` 的**全部非编译逻辑**，不真的编译 whisper.cpp。
#
# ## 为什么需要它
#
# `build-whisper.sh` 里除了两行 `cmake` 之外的每一件事 —— pack id 怎么拼、输出目录怎么找、
# stage 怎么装、manifest fragment 长什么样 —— 都是**只有在 GitHub runner 上才会被执行**的
# 代码，而那个 workflow 从来没跑过。`platform` T-141 §4 抓到的 C2/C7/C9 三条全在这一段里。
#
# 编译一次 whisper.cpp 要几分钟且占满共享机器的 CPU，而**要验的东西一行都不在编译器里**。
# 所以这里把 `cmake` 换成一个桩：它按真实的目录布局造出假的产物，
# 然后 build-whisper.sh **原封不动地跑它自己的逻辑**。
#
# 覆盖到：
#   · PACK_OS 映射（C9：pack id 用 win/macos，schema 的 os 字段用 win32/darwin）
#   · BIN_DIR 三候选（C7：MSVC 多配置生成器输出到 bin/Release）
#   · GITHUB_OUTPUT 导出（C7：workflow 不再硬编码路径）
#   · stage 装配 + 打包 + emit_manifest → 真 schema 校验（C2）
#
# 覆盖不到（老实说）：真编译、rpath 在 macOS 上的实际效果（C8）、codesign、
# Windows 的 zip/7z 分支（本机没有 MINGW，`uname -s` 骗不过去）。
#
# 跑：`pnpm test:ci-scripts`（会先跑 selftest-ci-manifest.mjs）
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/om-bw-selftest-XXXXXX")"
trap 'rm -rf "${WORK}"' EXIT

pass=0; fail=0
ok()   { printf '  \033[32m✔\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31m✘\033[0m %s\n' "$1"; printf '      %s\n' "${2:-}"; fail=$((fail+1)); }

# ──────────────────────────────────────────────────────────────────────────────
# cmake 桩：`-B <dir>` 时记下构建目录；`--build` 时按 LAYOUT 造假产物。
# ──────────────────────────────────────────────────────────────────────────────
#
# 第三个参数 OMIT（T-161）：**故意不产出**这几个文件名，空格分隔。
# 用来把"编译看起来成功、但某个产物没出来"这件事做成可复现的输入 ——
# 这正是 T-145 在 macos-arm64-cpu 上撞到的真实形状，只不过那次没人能复现它。
make_stub_cmake() {
  local layout="$1" stubdir="$2" omit="${3:-}"
  mkdir -p "${stubdir}"
  cat > "${stubdir}/cmake" <<STUB
#!/usr/bin/env bash
set -Eeuo pipefail
LAYOUT="${layout}"
OMIT="${omit}"
STUB
  cat >> "${stubdir}/cmake" <<'STUB'
build_dir=""
mode="configure"
prev=""
for a in "$@"; do
  if [[ "$a" == "--build" ]]; then mode="build"; fi
  if [[ "$prev" == "-B" ]]; then build_dir="$a"; fi
  if [[ "$mode" == "build" && "$prev" == "--build" ]]; then build_dir="$a"; fi
  prev="$a"
done
[[ -n "$build_dir" ]] || { echo "stub-cmake: no build dir in: $*" >&2; exit 1; }

if [[ "$mode" == "configure" ]]; then
  mkdir -p "$build_dir"
  # 把 configure 时收到的旗标留下来，测试要检查 rpath 那条。
  printf '%s\n' "$@" > "$build_dir/.stub-configure-args"
  exit 0
fi

case "$LAYOUT" in
  single) out="$build_dir/bin" ;;          # Linux / macOS：Makefile / Ninja
  msvc)   out="$build_dir/bin/Release" ;;  # Visual Studio 多配置生成器
  legacy) out="$build_dir/Release/bin" ;;  # 老脚本猜的那个位置
  *) echo "stub-cmake: unknown layout $LAYOUT" >&2; exit 1 ;;
esac
mkdir -p "$out"
# multi-config 下 bin/ 会作为父目录存在但没有文件 —— 正是老逻辑会挑错的那一步。
[[ "$LAYOUT" == "msvc" ]] && mkdir -p "$build_dir/bin"
for f in libggml-base.so.0.15.1 libggml.so.0.15.1 libggml-cpu-haswell.so \
         libwhisper.so.1.9.1 whisper-cli libggml-vulkan.so; do
  skip=0
  for o in ${OMIT}; do [[ "$f" == "$o" ]] && skip=1; done
  [[ "$skip" == "1" ]] && continue
  # ★ T-190：假产物必须是**真 ELF**，不能是 `printf 'fake'`。
  # 新加的 `pack-native-deps.mjs --verify` 守卫会读每个文件的 DT_NEEDED / PE 导入表，
  # 而"一个可解析的二进制都没有"在它那里是**红**（那正是"什么都没检查"的形状）。
  # 拿一个真系统二进制当模板：它的 NEEDED 只有 libc，会被归进 os 类，不影响判定，
  # 但整条链路（解析 → 分类 → 判定）在自检里是**真的跑到了**的。
  if [ -r /bin/true ]; then cp /bin/true "$out/$f"; else printf 'fake\n' > "$out/$f"; fi
done
[[ -e "$out/whisper-cli" ]] && chmod +x "$out/whisper-cli"
exit 0
STUB
  chmod +x "${stubdir}/cmake"
}

# ──────────────────────────────────────────────────────────────────────────────
# ★ T-167：cc 桩
#
# `build-whisper.sh` 现在会把 `openmemo-probe` **编进包里**（探针必须与 ggml 库同目录，
# 否则在用户机器上一次都启动不了 —— 理由写在 build-whisper.sh 里）。
# 而这里的 cmake 桩产出的 "库" 是 5 字节的文本文件，真 `cc` 链不了它们
# （`[实测]` `cannot find -lggml-base`）。
#
# 桩掉 `cc` 的理由与桩掉 `cmake` 完全相同：**要验的东西一行都不在编译器里**。
# 桩产出一个能跑、会打印 JSON 的可执行文件 —— 那正是 build-probe.sh 冒烟测试要的。
#
# 第二个参数 BROKEN=1：编译"成功"但**什么都不产出**。
# 这是 RV-D 的输入，用来确认"探针没编出来"不会被静默放过。
# ──────────────────────────────────────────────────────────────────────────────
make_stub_cc() {
  local stubdir="$1" broken="${2:-0}"
  mkdir -p "${stubdir}"
  cat > "${stubdir}/cc" <<STUB
#!/usr/bin/env bash
BROKEN=${broken}
STUB
  cat >> "${stubdir}/cc" <<'STUB'
out=""; prev=""
for a in "$@"; do
  [[ "$prev" == "-o" ]] && out="$a"
  prev="$a"
done
[[ "$BROKEN" == "1" ]] && exit 0
[[ -n "$out" ]] || { echo "stub-cc: no -o in: $*" >&2; exit 1; }
mkdir -p "$(dirname "$out")"
cat > "$out" <<'PROBE'
#!/usr/bin/env bash
echo '{"schemaVersion":1,"ggmlVersion":"0.15.1","ggmlCommit":"stub","searchPath":"","deviceCount":0,"devices":[]}'
PROBE
chmod +x "$out"
STUB
  chmod +x "${stubdir}/cc"
}

# ──────────────────────────────────────────────────────────────────────────────
# ★ T-167：**源码树桩** —— 这条是被 CI 打脸打出来的，值得写清楚。
#
# 原来每个 case 都不传 `--src`，于是用的是**真的** `vendor/whisper.cpp` submodule
# （注释里写着"脚本要 git -C 它拿版本号"）。这在开发机上一直好用 ——
# 因为开发机上 submodule 是拉过的。
#
# `[CI 实测 run 31155338320]` 门禁上当场三条红：
#     error: ggml headers not found: /home/runner/work/openmemo/openmemo/vendor/whisper.cpp/ggml/include
# 成因是 `ci.yml` **刻意不拉 submodule**（"TS 侧一行都不需要 vendor/ 里的 C++ 源码，
# whisper.cpp + sherpa-onnx 加起来几百 MB"）。在探针进包之前，本脚本恰好没有任何一步
# 真的**读**过那棵树，所以这条依赖一直是隐形的。
#
# → 判据不是"CI 上把 submodule 拉下来"，是「**这个自检本来就不该依赖那棵树**」：
#   它要验的是 pack id / BIN_DIR / stage 装配 / fragment，一行都不在 C++ 源码里。
#   所以造一棵最小的假源码树（含一个真 git 仓库，好让 engineVersion 仍是一个真 sha
#   而不是 "unknown" —— 后者会让 fragment 的语义悄悄变掉）。
# ──────────────────────────────────────────────────────────────────────────────
make_stub_src() {
  local srcdir="$1"
  mkdir -p "${srcdir}/ggml/include"
  printf '/* stub */\n' > "${srcdir}/ggml/include/ggml.h"
  printf '/* stub */\n' > "${srcdir}/ggml/include/ggml-backend.h"
  printf 'cmake_minimum_required(VERSION 3.10)\n' > "${srcdir}/CMakeLists.txt"
  git -C "${srcdir}" init -q 2>/dev/null || true
  git -C "${srcdir}" -c user.email=ci@example.com -c user.name=ci \
      -c commit.gpgsign=false add -A 2>/dev/null || true
  git -C "${srcdir}" -c user.email=ci@example.com -c user.name=ci \
      -c commit.gpgsign=false commit -q -m stub 2>/dev/null || true
}

# ★ T-167：`run_case` 以前用 `echo "${case_dir}"` 回传路径，调用方写
#   `if cd1="$(run_case …)"`。**那让 `bad` 的输出被 `$( )` 吞进变量、
#   `fail` 的自增发生在子 shell 里于是丢掉**，失败的那个 case 表现为
#   「那一节一条断言都没打印」，而总计仍然是 "N passed, 0 failed"。
#   `[实测]` 我把探针加进 build-whisper.sh 之后第一次跑，①② 两节整节消失，
#   脚本报的却是 `✔ 9 passed, 0 failed` —— **正是本仓在清的那种假绿**。
#   改成全局变量回传：`bad` 直接打到终端，`fail` 在当前 shell 里加。
CASE_DIR=""
run_case() {
  local name="$1" layout="$2" backend="$3"
  local case_dir="${WORK}/${name}"
  local stub="${case_dir}/stub"
  mkdir -p "${case_dir}"
  make_stub_cmake "${layout}" "${stub}"
  make_stub_cc "${stub}"
  make_stub_src "${case_dir}/src"
  CASE_DIR="${case_dir}"

  local gh_out="${case_dir}/gh_output"
  : > "${gh_out}"

  # `--src` 指向**假的**源码树（见 make_stub_src：T-167 之前这里用的是真 submodule，
  # 而门禁刻意不拉 submodule，于是这条隐形依赖在 CI 上当场变红）。
  # 产物全部落在临时目录里 —— 不碰仓库的 .build / dist。
  if ! PATH="${stub}:${PATH}" GITHUB_OUTPUT="${gh_out}" \
      bash "${REPO_ROOT}/scripts/build-whisper.sh" \
        --backend "${backend}" \
        --src "${case_dir}/src" \
        --out "${case_dir}/packs" \
        --build-root "${case_dir}/build" \
        --no-strip \
        > "${case_dir}/log" 2>&1; then
    bad "${name}: build-whisper.sh 退出非零" "$(tail -20 "${case_dir}/log")"
    return 1
  fi
  return 0
}

echo
echo "① Linux 单配置布局（bin/）"
if run_case linux-cpu single cpu; then
  cd1="${CASE_DIR}"
  gh="${cd1}/gh_output"
  pack_id="$(sed -n 's/^pack_id=//p' "${gh}")"
  bin_dir="$(sed -n 's/^bin_dir=//p' "${gh}")"
  stage_dir="$(sed -n 's/^stage_dir=//p' "${gh}")"

  [[ "${pack_id}" == "whispercpp-cpu-linux-x64" ]] \
    && ok "pack id = ${pack_id}（与手写 manifest 同一套命名）" \
    || bad "pack id 不对" "得到 ${pack_id}"

  [[ "${bin_dir}" == */bin ]] \
    && ok "BIN_DIR 落在 bin/（${bin_dir##*/build/})" \
    || bad "BIN_DIR 不对" "${bin_dir}"

  [[ -n "${stage_dir}" && -d "${stage_dir}" ]] \
    && ok "stage_dir 已导出给 workflow（C7：不再硬编码路径）" \
    || bad "stage_dir 没导出" "${stage_dir}"

  grep -q -- "-DCMAKE_INSTALL_RPATH=\$ORIGIN" "${cd1}/build"/*/.stub-configure-args \
    && ok "Linux 用 \$ORIGIN 作 rpath" \
    || bad "rpath 旗标不对" "$(grep -i rpath "${cd1}/build"/*/.stub-configure-args || echo '(无 rpath 旗标)')"

  frag="${cd1}/packs/${pack_id}.json"
  if [[ -f "${frag}" ]]; then
    ok "emit_manifest 产出了 fragment"
    if node -e '
      const fs=require("node:fs");
      const {pathToFileURL}=require("node:url");
      const frag=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
      import(pathToFileURL(process.argv[2]).href).then(({validateBackendManifest})=>{
        const v=validateBackendManifest({schemaVersion:1,catalogVersion:"2026.08.05",
          generatedAt:new Date().toISOString(),packs:[frag]});
        if(!v.ok){console.error(v.errors.join("\n"));process.exit(1);}
        if(frag.os!=="linux"){console.error("os 字段应为 linux，得到 "+frag.os);process.exit(1);}
        if(frag.availability!=="pending-ci"){console.error("availability 应为 pending-ci");process.exit(1);}
        if(!frag.providesFiles.includes("whisper-cli")){console.error("providesFiles 里没有 whisper-cli");process.exit(1);}
      }).catch(e=>{console.error(String(e));process.exit(1);});
    ' "${frag}" "${REPO_ROOT}/packages/shared/dist/index.js" 2>"${cd1}/schema.err"; then
      ok "fragment 通过真 BackendPackSchema（C2）"
    else
      bad "fragment 没通过 schema" "$(cat "${cd1}/schema.err")"
    fi

    # ★★ T-167：探针必须**在包里**，而且必须在 `providesFiles` 里被声明出来。
    #   两条分开断言是有意的：
    #     · 文件在包里 → 用户装完盘上真的有它；
    #     · providesFiles 里有它 → `platformPacks.test.ts` 那一族的清单守卫看得见它，
    #       而 `pack-select` 的解析器也是按声明去找的。
    #   只验前者的话，一个"文件在、清单里没有"的包会照样通过，
    #   而目录侧的守卫（"每个平台都要有探针"）就永远查不到它。
    [[ -e "${stage_dir}/openmemo-probe" ]] \
      && ok "★ 探针随包出厂：stage 里有 openmemo-probe" \
      || bad "stage 里没有 openmemo-probe" "$(ls -la "${stage_dir}" 2>&1 | head -20)"

    if grep -q '"openmemo-probe"' "${frag}" 2>/dev/null; then
      ok "★ fragment 的 providesFiles 声明了 openmemo-probe"
    else
      bad "fragment 没声明 openmemo-probe" "$(cat "${frag}")"
    fi
  else
    bad "没有 fragment" "找不到 ${frag}"
  fi
fi

echo
echo "② MSVC 多配置布局（bin/Release/）—— C7 的正面验证"
if run_case msvc-vulkan msvc vulkan; then
  cd2="${CASE_DIR}"
  bin_dir="$(sed -n 's/^bin_dir=//p' "${cd2}/gh_output")"
  [[ "${bin_dir}" == */bin/Release ]] \
    && ok "BIN_DIR 找到了 bin/Release（老逻辑只试 bin 与 Release/bin，两个都会落空）" \
    || bad "BIN_DIR 没找到 bin/Release" "得到 ${bin_dir}"
  pack_id="$(sed -n 's/^pack_id=//p' "${cd2}/gh_output")"
  [[ -f "${cd2}/packs/${pack_id}.json" ]] \
    && ok "多配置布局下同样产出 fragment（${pack_id}）" \
    || bad "多配置布局下没有 fragment" "${pack_id}"

  # ★★ T-161：加速包必须**自包含**。判据不是"包里有加速模块"，
  #   是"包里同时有加速模块**和引擎本体**" —— ggml 只在 whisper-cli 自己的目录里
  #   dlopen 后端模块（ggml-backend-reg.cpp:479-489），所以缺了引擎的那半边，
  #   加速模块永远不会被任何进程看见（D-11 §8.4 的三条独立证据）。
  if [[ -f "${cd2}/packs/${pack_id}.json" ]]; then
    if node -e '
      const frag=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));
      // ★ T-167：加速包也要带探针 —— 探针只能枚举与它**同目录**的后端模块，
      //   只有核心包带探针的话，装了 Vulkan 包的用户永远枚举不到 vulkan 设备。
      const need=["whisper-cli","libggml-vulkan.so","libggml-cpu-haswell.so","openmemo-probe"];
      const miss=need.filter((n)=>!frag.providesFiles.includes(n));
      if(miss.length){console.error("providesFiles 缺: "+miss.join(", ")+
        "\n实际: "+frag.providesFiles.join(", "));process.exit(1);}
    ' "${cd2}/packs/${pack_id}.json" 2>"${cd2}/selfcontained.err"; then
      ok "★ 加速包自包含：providesFiles 同时含 whisper-cli + 加速模块 + CPU 模块"
    else
      bad "加速包不自包含" "$(cat "${cd2}/selfcontained.err")"
    fi
  fi
fi

echo
echo "③ 假的 uname —— C9（pack id 用 win/macos）与 C8（rpath 分平台）"
# 本机是 Linux，`uname -s` 骗不过去就永远测不到另外两条分支 —— 而那两条分支正是
# 「从写下来那天起没有被任何自动化执行过」的那一类。桩掉 uname 就能在本机走到。
# 这两个 case 用 --no-package：打 zip 需要 zip/7z（本机都没有），
# 而要验的 PACK_OS / rpath 都在打包之前就定下来了。
uname_case() {
  local name="$1" uname_s="$2" uname_m="$3"
  local case_dir="${WORK}/${name}" stub="${WORK}/${name}/stub"
  mkdir -p "${case_dir}"
  make_stub_cmake single "${stub}"
  make_stub_cc "${stub}"
  make_stub_src "${case_dir}/src"
  cat > "${stub}/uname" <<STUB
#!/usr/bin/env bash
case "\$1" in
  -s) echo "${uname_s}" ;;
  -m) echo "${uname_m}" ;;
  *)  echo "${uname_s} 0.0 ${uname_m}" ;;
esac
STUB
  chmod +x "${stub}/uname"
  local gh="${case_dir}/gh_output"; : > "${gh}"
  PATH="${stub}:${PATH}" GITHUB_OUTPUT="${gh}" \
    bash "${REPO_ROOT}/scripts/build-whisper.sh" \
      --backend cpu --src "${case_dir}/src" \
      --out "${case_dir}/packs" --build-root "${case_dir}/build" \
      --no-strip --no-sign --no-package > "${case_dir}/log" 2>&1
  echo "${case_dir}"
}

for spec in "win:MINGW64_NT-10.0:x86_64:whispercpp-cpu-win-x64:" \
            "macos:Darwin:arm64:whispercpp-cpu-macos-arm64:@loader_path"; do
  IFS=: read -r cname us um want_id want_rpath <<< "${spec}"
  if cdir="$(uname_case "${cname}" "${us}" "${um}")"; then
    got_id="$(sed -n 's/^pack_id=//p' "${cdir}/gh_output")"
    [[ "${got_id}" == "${want_id}" ]] \
      && ok "${cname}: pack id = ${got_id}（不是 ${us%%_*} 那种 process.platform token）" \
      || bad "${cname}: pack id 不对" "want ${want_id}, got ${got_id}"

    cfg="$(cat "${cdir}/build"/*/.stub-configure-args 2>/dev/null || true)"
    if [[ -z "${want_rpath}" ]]; then
      grep -q -- '-DCMAKE_INSTALL_RPATH' <<< "${cfg}" \
        && bad "${cname}: 不该有 rpath 旗标（Windows 没有 rpath 概念）" "$(grep -i rpath <<< "${cfg}")" \
        || ok "${cname}: 没有传 rpath 旗标 —— 正确"
    else
      grep -qF -- "-DCMAKE_INSTALL_RPATH=${want_rpath}" <<< "${cfg}" \
        && ok "${cname}: rpath = ${want_rpath}（C8：\$ORIGIN 是 ELF 概念，dyld 不认）" \
        || bad "${cname}: rpath 不对" "$(grep -i rpath <<< "${cfg}" || echo '(无)')"
    fi
  else
    bad "${cname}: build-whisper.sh 退出非零" "$(tail -20 "${cdir:-}/log" 2>/dev/null)"
  fi
done

echo
echo "④ ★反向：构建什么都没产出时必须失败，而不是打出一个空包"
empty_case="${WORK}/empty"
mkdir -p "${empty_case}/stub"
cat > "${empty_case}/stub/cmake" <<'STUB'
#!/usr/bin/env bash
# 配置成功、构建"成功"，但一个产物都不产 —— 真实世界里这就是编译静默失败的形状。
prev=""; build_dir=""
for a in "$@"; do
  [[ "$prev" == "-B" ]] && build_dir="$a"
  [[ "$prev" == "--build" ]] && build_dir="$a"
  prev="$a"
done
[[ -n "$build_dir" ]] && mkdir -p "$build_dir/bin"
exit 0
STUB
chmod +x "${empty_case}/stub/cmake"
make_stub_src "${empty_case}/src"
if PATH="${empty_case}/stub:${PATH}" bash "${REPO_ROOT}/scripts/build-whisper.sh" \
      --backend cpu --src "${empty_case}/src" \
      --out "${empty_case}/packs" --build-root "${empty_case}/build" --no-strip \
      > "${empty_case}/log" 2>&1; then
  bad "空产物构建居然成功了" "$(tail -5 "${empty_case}/log")"
else
  if grep -qE "cannot locate build output dir|stage dir is empty" "${empty_case}/log"; then
    ok "失败了，且理由指向「构建没产出东西」而不是别的"
  else
    bad "失败了但理由不对" "$(tail -5 "${empty_case}/log")"
  fi
  if [[ -n "$(find "${empty_case}/packs" -name '*.json' 2>/dev/null)" ]]; then
    bad "失败路径下仍然写出了 fragment" "$(find "${empty_case}/packs" -name '*.json')"
  else
    ok "失败路径下一个 fragment 都没写"
  fi
fi

echo
echo "⑤ ★反向（T-161）：自包含改动把旧守卫的前提抽掉了，必须在原地把守卫补回来"
# 在 T-161 之前，加速包只拷一个 `libggml-<backend>` —— 它没编出来时 stage 是空的，
# `emit-pack-manifest` 会当场 die。**现在核心文件先进 stage，stage 永远非空**，
# 于是同一个失败会打出一个"能下载、能安装、里面根本没有加速器"的包并报绿。
# 这两条反向用例就是为了让那件事不可能悄悄发生。
reverse_case() {
  local name="$1" backend="$2" omit="$3" want_msg="$4" desc="$5"
  local case_dir="${WORK}/rv-${name}" stub="${WORK}/rv-${name}/stub"
  mkdir -p "${case_dir}"
  make_stub_cmake single "${stub}" "${omit}"
  make_stub_cc "${stub}"
  make_stub_src "${case_dir}/src"
  if PATH="${stub}:${PATH}" bash "${REPO_ROOT}/scripts/build-whisper.sh" \
        --backend "${backend}" --src "${case_dir}/src" --out "${case_dir}/packs" \
        --build-root "${case_dir}/build" --no-strip \
        > "${case_dir}/log" 2>&1; then
    bad "${desc}" "居然成功了。stage 内容：$(tail -8 "${case_dir}/log")"
    return
  fi
  if grep -qF "${want_msg}" "${case_dir}/log"; then
    ok "${desc}"
  else
    bad "${desc}（红了，但理由不对）" "$(tail -8 "${case_dir}/log")"
  fi
  if [[ -n "$(find "${case_dir}/packs" -name '*.json' 2>/dev/null)" ]]; then
    bad "${desc}：失败路径下仍然写出了 fragment" "$(find "${case_dir}/packs" -name '*.json')"
  fi
}

reverse_case accel-missing vulkan libggml-vulkan.so \
  "里没有 libggml-vulkan.so" \
  "RV-A · 加速模块没编出来 → 红（此前靠「stage 为空」接住，现在接不住了）"

reverse_case engine-missing vulkan whisper-cli \
  "里没有 whisper-cli" \
  "RV-B · 包里没有引擎本体 → 红（模块再全也永远不会被 dlopen 到）"

reverse_case cpumod-missing vulkan libggml-cpu-haswell.so \
  "里没有任何 ggml CPU 后端模块" \
  "RV-C · 加速包里没有 CPU 后端模块 → 红（Vulkan 只接管一部分算子）"

# ★★ RV-D（T-167）：**探针没编出来 → 整条链必须红，而且不许写 fragment。**
#
# 这一条守的是 T-167 新加的那一步。少了它的后果与 RV-A 同族但更隐蔽：
# 打出一个"能下载、能安装、里面没有探针"的包并报绿，而缺探针在界面上的表现是
# 「尚未探测到硬件能力」—— 与"这台机器真的没有 GPU"完全一样。
#
# ⚠️ 诚实边界：这里触发的是 `build-probe.sh` 自己那条「probe did not produce output」，
# 而不是 `build-whisper.sh` 里那条 `[[ ! -e "${STAGE}/${PROBE_NAME}" ]]`。
# 后者防的是**将来有人给这次调用加 `|| true`** 之类的手滑，桩不出来 ——
# 它由 `lint-workflows.mjs` 的结构断言钉住（"那条 die 必须还在"），不是靠这里。
{
  local_dir="${WORK}/rv-probe-missing"
  mkdir -p "${local_dir}/stub"
  make_stub_cmake single "${local_dir}/stub"
  make_stub_cc "${local_dir}/stub" 1     # ← 编译"成功"，但什么都不产出
  make_stub_src "${local_dir}/src"
  if PATH="${local_dir}/stub:${PATH}" bash "${REPO_ROOT}/scripts/build-whisper.sh" \
        --backend cpu --src "${local_dir}/src" --out "${local_dir}/packs" \
        --build-root "${local_dir}/build" --no-strip \
        > "${local_dir}/log" 2>&1; then
    bad "RV-D · 探针没编出来 → 红" "居然成功了。日志尾部：$(tail -8 "${local_dir}/log")"
  else
    if grep -qE "probe did not produce output|里没有 openmemo-probe" "${local_dir}/log"; then
      ok "RV-D · 探针没编出来 → 红（缺探针的包不许出厂）"
    else
      bad "RV-D（红了，但理由不对）" "$(tail -8 "${local_dir}/log")"
    fi
    if [[ -n "$(find "${local_dir}/packs" -name '*.json' 2>/dev/null)" ]]; then
      bad "RV-D：失败路径下仍然写出了 fragment" "$(find "${local_dir}/packs" -name '*.json')"
    else
      ok "RV-D · 失败路径下一个 fragment 都没写"
    fi
  fi
}

echo
if [[ ${fail} -eq 0 ]]; then
  printf '\033[32m✔\033[0m %d passed, 0 failed\n' "${pass}"
else
  printf '\033[31m✘\033[0m %d passed, %d failed\n' "${pass}" "${fail}"
  exit 1
fi
