#!/usr/bin/env bash
#
# 预编译包的**出厂检查**：把归档解到别处，逐件确认该在的东西还在。
#
# ## 为什么这一步和组装脚本里的检查不是同一件事
#
# `scripts/build-bundle.mjs` 已经会在缺件时退出 1。但它检查的是**它自己刚摆好的目录**。
# 这一步检查的是**归档解开之后的样子** —— 两者之间隔着 tar/zip，而那一段有它自己的
# 失败方式：glob 漏掉、排除规则写错、符号链接没跟随、Windows 上路径分隔符。
#
# 本仓已经栽过一次同构的：build-backends.yml 的 C5 —— 签名检查 `for f in <不匹配的 glob>`，
# 每次迭代都 `continue`，那一步**检查了零个文件然后报绿**。
# 所以这里的每一条断言都计数，**数到 0 条就红**。
#
# 用法：
#   bash scripts/ci/verify-bundle.sh --archive <包.tar.xz|.zip|.tar.gz> --target <linux-x64|win-x64|darwin-arm64>

set -euo pipefail

ARCHIVE=""
TARGET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --archive) ARCHIVE="$2"; shift 2 ;;
    --target)  TARGET="$2";  shift 2 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done
[ -n "$ARCHIVE" ] || { echo "::error::--archive 必填" >&2; exit 2; }
[ -n "$TARGET" ]  || { echo "::error::--target 必填" >&2; exit 2; }
[ -f "$ARCHIVE" ] || { echo "::error::归档不存在：$ARCHIVE" >&2; exit 2; }

case "$TARGET" in
  linux-x64)    LIBEXT="so";    NODEEXE="node";     LAUNCHER="start.sh";        PREBUILD="linux-x64.node";  SHERPA="sherpa-onnx-linux-x64" ;;
  darwin-arm64) LIBEXT="dylib"; NODEEXE="node";     LAUNCHER="OpenMemo.command"; PREBUILD="darwin-arm64.node"; SHERPA="sherpa-onnx-darwin-arm64" ;;
  win-x64)      LIBEXT="dll";   NODEEXE="node.exe"; LAUNCHER="start.cmd";       PREBUILD="win32-x64.node";  SHERPA="sherpa-onnx-win-x64" ;;
  *) echo "::error::未知 target：$TARGET" >&2; exit 2 ;;
esac

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "解开 $ARCHIVE → $WORK"
case "$ARCHIVE" in
  *.tar.xz) tar -xJf "$ARCHIVE" -C "$WORK" ;;
  *.tar.gz) tar -xzf "$ARCHIVE" -C "$WORK" ;;
  *.zip)    unzip -q "$ARCHIVE" -d "$WORK" ;;
  *) echo "::error::认不出归档类型：$ARCHIVE" >&2; exit 2 ;;
esac

# 解出来是 openmemo-<version>-<target>/ 一层壳
B="$(find "$WORK" -maxdepth 1 -mindepth 1 -type d | head -1)"
[ -n "$B" ] || { echo "::error::归档里没有顶层目录" >&2; exit 1; }
echo "包根：$B"
echo

CHECKED=0
FAILED=0

ok()   { CHECKED=$((CHECKED+1)); printf '  \033[32m✔\033[0m %s\n' "$1"; }
bad()  { CHECKED=$((CHECKED+1)); FAILED=$((FAILED+1)); printf '  \033[31m✘\033[0m %s\n' "$1"; }

need_file() {
  if [ -f "$B/$1" ]; then ok "$1${2:+  ($2)}"; else bad "缺文件：$1${2:+  —— $2}"; fi
}
need_dir_nonempty() {
  if [ -d "$B/$1" ] && [ -n "$(ls -A "$B/$1" 2>/dev/null)" ]; then ok "$1/ 非空"; else bad "缺目录或为空：$1/${2:+  —— $2}"; fi
}

echo "── 运行时"
need_file "runtime/$NODEEXE" "自带 Node —— 用户机器上不需要预装"

# 真的执行一次。存在 ≠ 能跑（架构不符、权限位丢失、Mach-O 签名坏掉都只在这里显形）。
# ⚠️ 只有在**同平台**上才跑得动：在 Linux runner 上验 Windows 包时跳过并明说。
HOST=""
case "$(uname -s)" in
  Linux)  HOST="linux-x64" ;;
  Darwin) HOST="darwin-arm64" ;;
  MINGW*|MSYS*|CYGWIN*) HOST="win-x64" ;;
esac
if [ "$HOST" = "$TARGET" ]; then
  if V="$("$B/runtime/$NODEEXE" --version 2>&1)"; then
    ok "自带 Node 真的能执行：$V"
  else
    bad "自带 Node execute 失败：$V"
  fi
else
  echo "  · 跳过「真的执行一次」——宿主是 ${HOST:-未知}，包是 $TARGET（跨平台，跑不动是正常的）"
fi

echo
echo "── 网页 bundle（缺了用户打开是白页，且没有任何一处会报错）"
need_file "app/apps/web/dist/index.html" "★ 只有 pnpm -r build 会产出"
need_dir_nonempty "app/apps/web/dist/assets" "白页包不许出厂"

echo
echo "── daemon 与 workspace 包"
need_file "app/daemon/dist/main.js"
need_file "app/daemon/dist/build-info.json" "/api/health 靠它报版本"
for p in db downloader llm mindmap pipeline runtime shared; do
  need_file "app/node_modules/@openmemo/$p/package.json"
done
need_dir_nonempty "app/node_modules/@openmemo/db/migrations" "schema 迁移靠它"

echo
echo "── 原生模块"
need_file "app/node_modules/better-sqlite3/prebuilds/$PREBUILD" "N-API，跨 Node 版本通用"
# 反向断言：**只能有本平台那一个**。多留 7 个是 16 MB 的死重，
# 而且会掩盖"平台判断写错了"这类错误（错的那个也在，于是看起来还是对的）。
NPRE=$(ls -1 "$B/app/node_modules/better-sqlite3/prebuilds" 2>/dev/null | wc -l | tr -d ' ')
if [ "$NPRE" = "1" ]; then ok "prebuilds/ 里只有 1 个 .node（已裁到本平台）"; else bad "prebuilds/ 里有 $NPRE 个文件，应当只有 1 个"; fi

# ★★ sherpa-onnx：最容易漏的那一格（它是 os/cpu 门控的 optional dep，
#    pnpm 只装宿主那一个）。漏了的话，包在**别的平台**上才炸。
if [ -d "$B/app/node_modules/$SHERPA" ]; then
  NNAT=$(find "$B/app/node_modules/$SHERPA" -type f \( -name '*.node' -o -name '*.so' -o -name '*.so.*' -o -name '*.dylib' -o -name '*.dll' \) | wc -l | tr -d ' ')
  if [ "$NNAT" -ge 2 ]; then
    ok "$SHERPA 在包里，含 $NNAT 个原生件"
  else
    bad "$SHERPA 在包里但只有 $NNAT 个原生件 —— 它的 .node 需要兄弟 .so 同目录"
  fi
else
  bad "$SHERPA 不在包里 —— 该平台上流式 ASR / VAD 整条不可用，且只在那个平台显形"
fi
need_file "app/node_modules/sherpa-onnx-node/package.json"

echo
echo "── SQLite 扩展（用户 2026-08-08 裁决 ②：随包出厂）"
need_file "ext/libsimple.$LIBEXT" "缺了中文两字词搜索静默返回 0 条"
need_file "ext/vec0.$LIBEXT"
need_dir_nonempty "ext/dict" "jieba 词典"

echo
echo "── 最小探针运行时（鸡生蛋那一环 —— 用户 2026-08-08 真机撞到过）"
# ★ 这道守卫的存在理由：`v0.3.0` 的包**没有探针**，用户解压运行后运行时页
#   六个后端全部报 `probe did not complete: probe executable not found`。
#   包里缺探针这件事，此前**只有用户能发现** —— 现在打包时当场红。
if [ "$TARGET" = "win-x64" ]; then PROBEBIN="openmemo-probe.exe"; else PROBEBIN="openmemo-probe"; fi
need_file "runtime/probe/$PROBEBIN" "缺了它用户第一屏六个后端全报找不到探针"
# 探针**动态链接 ggml**（ADR-015 §7.2，RUNPATH \$ORIGIN），只搬 exe 搬不动
NGGML=$(find "$B/runtime/probe" -maxdepth 1 -name '*ggml-base*' 2>/dev/null | wc -l | tr -d ' ')
if [ "$NGGML" -ge 1 ]; then ok "runtime/probe/ 里有 ggml 核心（$NGGML 个 ggml-base 文件/软链）"; else bad "runtime/probe/ 缺 ggml-base —— 探针动态链接它，缺了根本起不来"; fi
NCPU=$(find "$B/runtime/probe" -maxdepth 1 -name '*ggml-cpu*' 2>/dev/null | wc -l | tr -d ' ')
if [ "$NCPU" -ge 1 ]; then ok "runtime/probe/ 里有 $NCPU 个 CPU 后端模块（否则只能枚举出 0 个设备）"; else bad "runtime/probe/ 没有任何 ggml-cpu 模块 —— 探针会枚举出 0 个设备"; fi

# ★★ 同平台时**真的跑一次**：存在 ≠ 能跑（缺软链、架构不符、权限位丢失都只在这里显形）。
#    判据是 deviceCount ≥ 1 —— 「探针在」和「探针能答出东西」是两件事。
if [ "$HOST" = "$TARGET" ]; then
  if OUT="$("$B/runtime/probe/$PROBEBIN" 2>&1)"; then
    DC=$(printf '%s' "$OUT" | tr -d ' \n' | sed -n 's/.*"deviceCount":\([0-9]*\).*/\1/p')
    if [ -n "$DC" ] && [ "$DC" -ge 1 ]; then
      ok "探针真的跑起来并枚举出 $DC 个设备"
    else
      bad "探针跑起来了但 deviceCount=${DC:-?} —— 等于没有答案（CPU 模块没加载上？）"
    fi
  else
    bad "探针跑不起来：$(printf '%s' "$OUT" | head -1)"
  fi
else
  echo "  · 跳过「真的跑一次」——宿主是 ${HOST:-未知}，包是 $TARGET"
fi

# ─────────────────────────────────────────────────────────────────────────────────
# CPU 基线转写链（Manager 2026-08-08 裁决：把引擎装进盒子里）
#
# 判据不是"文件在"，是**用户解压之后不装引擎就能转写第一段音频**。
# 之前这一格是空的：`ADR-003` 决策 3 的 L1「永不失败的兜底」从来没被验证过，
# 因为兜底的那个包根本不在包里。
# ★ 与探针**共用** runtime/probe/ 这一个目录（共享同一份 ggml，不长第二份）。
# ─────────────────────────────────────────────────────────────────────────────────
echo
echo "── 组件目录 vendor/manifests（缺了它用户的组件页是空的，什么都装不了）"
need_dir_nonempty "vendor/manifests" "★ 缺了它 packs=0 / groups=0，ffmpeg / whisper / 模型一个都装不了"
NMAN=$(find "$B/vendor/manifests" -maxdepth 1 -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
if [ "$NMAN" -ge 3 ]; then
  ok "vendor/manifests/ 里有 $NMAN 份清单"
else
  bad "vendor/manifests/ 只有 $NMAN 份清单 —— 至少要有 backends/models 那几份"
fi
# 后端目录必须真的解析得出包：`[实测]` 用户那边 packs=0 的表现就是这一格空的
if [ -f "$B/vendor/manifests/backends.json" ]; then
  NPACKS=$(node -e "try{const m=require('$B/vendor/manifests/backends.json');console.log((m.packs||[]).length)}catch(e){console.log(0)}" 2>/dev/null || echo 0)
  if [ "${NPACKS:-0}" -ge 1 ]; then
    ok "backends.json 解析得出 $NPACKS 个包"
  else
    bad "backends.json 解析出 0 个包 —— 组件页会是空的"
  fi
else
  bad "缺 vendor/manifests/backends.json"
fi

echo
echo "── CPU 基线转写链（不装任何东西就能转写的那条）"
if [ "$TARGET" = "win-x64" ]; then CLIBIN="whisper-cli.exe"; else CLIBIN="whisper-cli"; fi
need_file "runtime/probe/$CLIBIN" "缺了它用户必须先下一个引擎包才能转写第一段音频"

NWHISPER=$(find "$B/runtime/probe" -maxdepth 1 -name '*whisper*' \
  ! -name "$CLIBIN" ! -name 'whisper-vad*' 2>/dev/null | wc -l | tr -d ' ')
if [ "$NWHISPER" -ge 1 ]; then
  ok "runtime/probe/ 里有 libwhisper（$NWHISPER 个文件/软链）"
else
  bad "runtime/probe/ 缺 libwhisper —— whisper-cli 动态链接它，缺了起不来"
fi

# ★★ 同平台时**真的跑一次**。与探针那条同一个理由：存在 ≠ 能跑。
#    `[本机实测 2026-08-08 linux-x64]` 只搬 exe 不搬 libwhisper/ggml 时，
#    报的是 `error while loading shared libraries` —— 只有真跑才看得见。
if [ "$HOST" = "$TARGET" ]; then
  if OUT="$("$B/runtime/probe/$CLIBIN" --help 2>&1)"; then
    if printf '%s' "$OUT" | grep -q "usage:"; then
      ok "whisper-cli 真的跑起来了（--help 打出 usage）"
    else
      bad "whisper-cli 跑起来了但输出不像 usage：$(printf '%s' "$OUT" | head -1)"
    fi
  else
    bad "whisper-cli 跑不起来：$(printf '%s' "$OUT" | head -1)"
  fi
else
  echo "  · 跳过「真的跑一次」——宿主是 ${HOST:-未知}，包是 $TARGET"
fi

echo
echo "── 启动与许可证"
need_file "$LAUNCHER"
need_file "LICENSE" "公开分发必须说明自身授权状态"
need_file "THIRD-PARTY-NOTICES" "MIT/Apache-2.0 要求保留版权声明"
# 声明文件必须真的提到 libsimple 的 MIT election（vendor/README.md:40 的长期要求）
if grep -q "elects the MIT option" "$B/THIRD-PARTY-NOTICES" 2>/dev/null; then
  ok "THIRD-PARTY-NOTICES 写明了 libsimple 的 MIT election"
else
  bad "THIRD-PARTY-NOTICES 里没有 libsimple 的 MIT election —— 双许可不声明可能被读成 GPL-3.0"
fi

echo
echo "── 反向断言：GPL 组件**不许**在包里"
# 这条是 D-17 §1 那整套论证的最后一道闸：论证再对，也架不住有人往包里塞一个 ffmpeg。
#
# ★ 匹配的是**二进制本身的文件名**，不是"名字里含 ffmpeg 的任何文件"。
#   第一版写的是 `-iname 'ffmpeg*'`，当场命中了
#   `@openmemo/pipeline/dist/audio/ffmpeg.js` —— **那是我们自己的代码**
#   （去 spawn ffmpeg 的那个模块），不是 GPL 的字节。
#   守卫本身是对的（它红了而不是静默放过），要改的是模式不是守卫
#   —— 与 build-backends.yml 的 C5 是同一条。
#
#   所以：basename 必须**恰好**是工具名（可带 .exe），
#   并且排掉源码/文本类后缀。真的 ffmpeg 二进制叫 `ffmpeg` 或 `ffmpeg.exe`，
#   不叫 `ffmpeg.js`。
GPLHITS=$(find "$B" -type f \
  \( -name 'ffmpeg' -o -name 'ffmpeg.exe' \
  -o -name 'ffprobe' -o -name 'ffprobe.exe' \
  -o -name 'yt-dlp' -o -name 'yt-dlp.exe' \
  -o -name 'youtube-dl' -o -name 'youtube-dl.exe' \
  -o -name 'libav*.so*' -o -name 'libav*.dylib' -o -name 'avcodec*.dll' \) | head -5)
if [ -z "$GPLHITS" ]; then
  ok "包里没有 ffmpeg / ffprobe / yt-dlp（GPL-3.0-or-later）"
else
  bad "包里发现 GPL 组件 —— 这会当场触发 ADR-002 的分发阻断："
  echo "$GPLHITS" | sed 's/^/        /'
fi

echo
echo "─────────────────────────────────────────────"
echo "检查了 $CHECKED 条，失败 $FAILED 条"
# C5 的教训：一个什么都没检查的检查器是最坏的那种绿。
if [ "$CHECKED" -lt 29 ]; then
  echo "::error::只检查了 $CHECKED 条（应 ≥29）—— 断言集被意外缩小了，这不是通过"
  exit 1
fi
if [ "$FAILED" -ne 0 ]; then
  echo "::error::$FAILED 条失败"
  exit 1
fi
echo "✔ 全部通过"
