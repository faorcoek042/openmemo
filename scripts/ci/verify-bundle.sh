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

# ★ 残包标记：构建一开始就落、成功走完才删（见 scripts/build-bundle.mjs）。
#   看到它就说明那次构建**中止在半路**，产物是残的 —— 立刻拒绝，不要往下逐项检查。
#   `[实测 2026-08-09]` 断网时构建停在 assembleModels()，而 writeLauncher() 排在其后，
#   于是留下一个 app/ext/runtime 齐全、却没有 start.sh 的目录：
#   **看起来像个包，其实双击打不开，且没有任何东西说它是残的。**
#   判据刻意不是"逐个文件点名"（清单会和现实漂移），而是"这次构建有没有跑完"。
if [ -f "$B/.openmemo-build-incomplete" ]; then
  echo "::error::这个包是**残的** —— 构建没有跑完（存在 .openmemo-build-incomplete 标记）" >&2
  cat "$B/.openmemo-build-incomplete" >&2
  exit 1
fi

CHECKED=0
FAILED=0

ok()   { CHECKED=$((CHECKED+1)); printf '  \033[32m✔\033[0m %s\n' "$1"; }
bad()  { CHECKED=$((CHECKED+1)); FAILED=$((FAILED+1)); printf '  \033[31m✘\033[0m %s\n' "$1"; }
# 计入 CHECKED 但不计入 FAILED —— 用于"今天理应如此、明天会自动升级成 bad()"的过渡态。
# 见下面 ffmpeg 双向核对：这是本文件唯一允许出现 warn() 的地方，不要当成通用的降级出口。
warn() { CHECKED=$((CHECKED+1)); printf '  \033[33m⚠\033[0m %s\n' "$1"; }

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
  # ⚠️ 路径**用环境变量递进去**，绝不拼进 JS 源码。
  #    `[CI 实测 run 31264740214]` 第一版把 $B 拼进字符串字面量，
  #    Windows 上的 `D:\a\...` 里的反斜杠被当成转义 → require 失败 → catch 成 0
  #    → 报「backends.json 解析出 0 个包」。**包是好的，红的是这条守卫自己。**
  #    linux/macOS 都过，只有 Windows 红 —— 典型的路径转义坑。
  NPACKS=$(OM_MANIFEST="$B/vendor/manifests/backends.json" node -e "try{const m=require(process.env.OM_MANIFEST);console.log((m.packs||[]).length)}catch(e){console.log(0)}" 2>/dev/null || echo 0)
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
echo "── THIRD-PARTY-NOTICES ↔ 包内容 双向核对（ffmpeg / ffprobe）"
# 这条守卫要防的事故形状，本仓已经栽过三次，全部是**人肉**发现，机器从没抓过一次：
#   ① 文档写了探针在包里，包里其实没有；② 设计文档写了 vendor/manifests 随包出厂，
#   包里其实没有；③ CUDA 后端的 providesFiles —— 一份**手写清单** —— 写着它提供后端，
#   实际一个 CUDA 运行时库都没列进去。手写清单和产物之间没有任何机制保证同步，
#   它们只在写下的那一刻是对的，之后只会漂移，且没人会自动发现。
#
# 所以两侧都不查"清单"，而是互相拿对方现场核对：
#   「声称」这一侧：不在这里重新判断"这个平台该不该内置 ffmpeg"——那是
#     writeNotices()（scripts/build-bundle.mjs，按 T.platform 分叉）已经决定过一次
#     的平台策略。这里只读它写进 THIRD-PARTY-NOTICES 的**结论原文**（两条互斥的
#     固定措辞）。如果在这里用 $TARGET 再判断一次"是不是 linux/win"，就会长出第二份
#     独立维护的平台策略——两处一旦分叉，没人会发现，这正是清单类 bug 的形状。
#   「事实」这一侧：不用手写的"ffmpeg 应该包含哪些文件"清单（那正是 providesFiles
#     出事的地方），而是复用下面「反向断言」那条已经吃过一次教训的 basename 匹配
#     （ffmpeg.js 误伤事故之后收窄成"恰好等于工具名"）去现场问包"文件真的在不在"。
#
# 四种结果，只有一种不阻断：
#   声称内置 + 实际没有 → ⚠️ warn，不阻断。这是**今天**在 Linux/Windows 上的真实状态
#     （ec641fd 让 writeNotices() 按平台无条件声明"内置"，但把 ffmpeg 字节真的搬进
#     stage 是打包实现那一路的活，见 D-20 §13.6 / a6553151…，此刻还没有落地）。
#     这条 warn 本身就是可执行的过期判据：**一旦某次构建真的把 ffmpeg 字节搬进了
#     stage，这个分支会在那次构建上自动滑到下面「声称内置+实际存在」的阻断分支——
#     不需要谁记得回来把 warn 改成 bad，判据就是"文件出现了没有"，不是日期。**
#   声称内置 + 实际存在 → 真的把关（阻断，无过渡期）：LICENSE 类文件里必须能找到
#     LGPL 许可证全文；同平台时 ffmpeg 自己的 `-L` 版权横幅也必须承认 Lesser——
#     GPL-only 版和 LGPL 版 basename 完全一样，唯一能分辨的是它自己怎么说自己。
#   声称不含 + 实际存在 → 阻断，不分平台、没有过渡期：未声明的第三方二进制混进包里，
#     比"声称了没验到"更危险。
#   声称不含 + 实际没有 → 通过（今天 macOS 的真实状态）。
FFCLAIM="unknown"
if grep -qF '本包**内置** ffmpeg' "$B/THIRD-PARTY-NOTICES" 2>/dev/null; then
  FFCLAIM="bundled"
elif grep -qF '本包**不含** ffmpeg' "$B/THIRD-PARTY-NOTICES" 2>/dev/null; then
  FFCLAIM="not-bundled"
fi

FFBINS=$(find "$B" -type f \( -name 'ffmpeg' -o -name 'ffmpeg.exe' -o -name 'ffprobe' -o -name 'ffprobe.exe' \) 2>/dev/null)

case "$FFCLAIM" in
  unknown)
    bad "THIRD-PARTY-NOTICES 里找不到「内置 ffmpeg」或「不含 ffmpeg」这两句固定措辞中的任何一句 —— writeNotices() 的文案改了但这条核对没跟着改，锚点失效，不能再判断声称与事实是否一致（先去对 scripts/build-bundle.mjs 里 T.platform 分叉那两句）"
    ;;
  bundled)
    if [ -z "$FFBINS" ]; then
      warn "THIRD-PARTY-NOTICES 声称内置 ffmpeg，但包里没找到 ffmpeg/ffprobe 二进制 —— 打包实现还没把字节真的搬进 stage（已知过渡态，不阻断；见上面注释）"
    else
      ok "THIRD-PARTY-NOTICES 声称内置 ffmpeg，包里确实有：$(printf '%s\n' "$FFBINS" | head -1 | sed "s#^$B/##")"

      # 许可证义务：LGPL 全文必须真的出现在某个随包出厂的 LICENSE 类文件里，
      # 不能只是 NOTICES 里一句话带过（那是义务的转述，不是义务本身）。
      # ★ `grep -F` 是逐行匹配的：真实许可证文本按 ~70-80 列硬换行是常态，
      #   "Lesser General Public License" 这个短语完全可能被硬换行劈成两行
      #   （本地拿合成 fixture 复现过一次：换行点恰好落在这句话中间，逐行 grep
      #   因此漏判为"没找到"，而人眼一看那明明就是 LGPL 全文）。
      #   所以先把整份文件的换行压成空格，按"一整段话"去找，不按"一行"去找。
      LICENSE_FILES=$(find "$B" -type f \( -iname 'LICENSE' -o -iname 'LICENSE.txt' -o -iname 'LICENSE.md' \
        -o -iname 'LICENCE' -o -iname 'LICENCE.txt' -o -iname 'COPYING' -o -iname 'COPYING.md' -o -iname 'NOTICE' \) 2>/dev/null)
      LGPLFOUND=""
      if [ -n "$LICENSE_FILES" ]; then
        while IFS= read -r lf; do
          [ -n "$lf" ] || continue
          if tr '\n' ' ' < "$lf" 2>/dev/null | grep -qF "Lesser General Public License"; then
            LGPLFOUND="$lf"
            break
          fi
        done <<< "$LICENSE_FILES"
      fi
      if [ -n "$LGPLFOUND" ]; then
        ok "LGPL 许可证全文真的在包里：$(printf '%s\n' "$LGPLFOUND" | sed "s#^$B/##")"
      else
        bad "包里内置了 ffmpeg，但翻遍 LICENSE/COPYING/NOTICE 类文件都没找到 Lesser General Public License 的正文 —— 许可证全文可得这条义务没被满足"
      fi

      # 同平台时问 ffmpeg 自己，而不是只信文件名 —— GPL-only 版和 LGPL 变体
      # basename 完全一样（都叫 ffmpeg），唯一能分辨的是它自己 -L 报的横幅。
      if [ "$HOST" = "$TARGET" ]; then
        FFMPEG_BIN=""
        while IFS= read -r fb; do
          [ -n "$fb" ] || continue
          case "$(basename "$fb")" in
            ffmpeg|ffmpeg.exe) FFMPEG_BIN="$fb"; break ;;
          esac
        done <<< "$FFBINS"
        if [ -n "$FFMPEG_BIN" ]; then
          if BANNER="$("$FFMPEG_BIN" -L 2>&1)"; then
            if printf '%s' "$BANNER" | tr '\n' ' ' | grep -qF "Lesser General Public License"; then
              ok "ffmpeg -L 真的执行了，横幅自认 Lesser（不是猜文件名，是它自己说的）"
            else
              bad "ffmpeg -L 跑起来了，但横幅里没有 Lesser General Public License —— 这可能是 GPL-only 构建，ADR-002 不许出厂"
            fi
          else
            bad "ffmpeg -L 执行失败：$(printf '%s' "$BANNER" | head -1)"
          fi
        else
          echo "  · FFBINS 里没有 ffmpeg 本体（只有 ffprobe）—— 跳过 -L 执行检查"
        fi
      else
        echo "  · 跳过「-L 真的执行一次」——宿主是 ${HOST:-未知}，包是 $TARGET（跨平台，跑不动是正常的）"
      fi
    fi
    ;;
  not-bundled)
    if [ -n "$FFBINS" ]; then
      bad "THIRD-PARTY-NOTICES 声称不含 ffmpeg，但包里真的找到了：$(printf '%s\n' "$FFBINS" | head -3 | sed "s#^$B/##" | tr '\n' ' ') —— 未声明的第三方二进制混进了包里"
    else
      ok "THIRD-PARTY-NOTICES 声称不含 ffmpeg，包里也确实没有"
    fi
    ;;
esac

echo
echo "── 反向断言：GPL 组件**不许**在包里（yt-dlp / libav 系；ffmpeg / ffprobe 已改由上面那条双向核对以平台+许可证文本的完整精度把关，这里不再重复判断，避免同一件事有两处独立维护的判据）"
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
#
#   ★ 2026-08-09（ffmpeg-lgpl-manifest 之后）：ffmpeg / ffprobe 从这份"逮到就阻断"的
#   清单里**拿掉了**——Linux/Windows 现在允许内置 LGPL 变体，"basename 是 ffmpeg"
#   本身不再等于违规，需要看平台 + 许可证文本，那份精度已经在上面「THIRD-PARTY-NOTICES
#   ↔ 包内容 双向核对」里做了，两处都判会变成两份独立维护的判据，删掉这里重复的半份。
#   yt-dlp / youtube-dl / libav* 不受这条 ffmpeg 裁决影响，原样留在这份硬清单里。
GPLHITS=$(find "$B" -type f \
  \( -name 'yt-dlp' -o -name 'yt-dlp.exe' \
  -o -name 'youtube-dl' -o -name 'youtube-dl.exe' \
  -o -name 'libav*.so*' -o -name 'libav*.dylib' -o -name 'avcodec*.dll' \) | head -5)
if [ -z "$GPLHITS" ]; then
  ok "包里没有 yt-dlp / libav 系（GPL-3.0-or-later，ffmpeg/ffprobe 见上面的双向核对）"
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
