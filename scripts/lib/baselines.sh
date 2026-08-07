# shellcheck shell=bash
#
# 平台运行时基线 —— **单一事实来源**。
#
# ══════════════════════════════════════════════════════════════════════════════════════
# 为什么这个文件存在
# ══════════════════════════════════════════════════════════════════════════════════════
#
# D-11 §8.0 那一族：「构建机总是那个最新、装得最全的环境，而用户的机器不是。
# 凡是**不显式指定就取构建机当前值**的东西，都会把构建机的新度焊进产物。」
#
# 这条规律在本仓已经现形三次，每次都是**同一个数字被写在两个地方，然后只改了一个**：
#
#   ① `[CI 实测 T-146]` macOS 包的 12 个二进制 `minos=26.0.0`
#      —— `build-whisper.sh` 没设 `CMAKE_OSX_DEPLOYMENT_TARGET`，取了 runner(macos-26) 的版本。
#   ② `[CI 实测 T-161/T-163]` Linux Vulkan 包需要 `GLIBC_2.38`
#      —— 为拿 glslc 把 runner 从 22.04 挪到 24.04 时顺手抬上去的。
#   ③ `[本机实测 T-167]` **`openmemo-probe` 在 macOS 上仍是 `minos=26.0.0`**
#      —— ① 只修了 `build-whisper.sh`，`build-probe.sh` 是另一个文件，没人想到它。
#      同一轮 CI 的产物里，包内 20 个 Mach-O 全是 13.3.0，包外那个探针是 26.0.0。
#
# 三次的形状完全一样：**基线是一个约定，而约定分散在多个文件里。**
# 所以它现在是一个文件里的两个变量，由 `build-whisper.sh` / `build-probe.sh` 共同 source，
# 并由 `scripts/ci/lint-workflows.mjs` 断言 workflow 里那两个 `--max` 与它逐字一致 ——
# 改了这里不改那里会当场红，而不是等用户"装了打不开"。
#
# ⚠️ 这两个数字**不是拍的**：
#   · 13.3  = 上游 `vendor/whisper.cpp/build-xcframework.sh:5` 自己写的
#             `MACOS_MIN_OS_VERSION=13.3`（同一份代码，上游测过的下限；
#             所有 Apple Silicon 机器都能跑 macOS 13）。
#   · 2.34  = 在 Ubuntu 22.04(glibc 2.35) 上编出来的实测最高符号版本。
#             发行版对照：Ubuntu 22.04=2.35 · Debian 12=2.36 · Ubuntu 24.04=2.39 · Debian 13=2.41。

# macOS 部署目标（写进 Mach-O 的 LC_BUILD_VERSION.minos）。
OPENMEMO_MACOS_DEPLOYMENT_TARGET="13.3"

# Linux 产物允许引用的最高 GLIBC 符号版本。
OPENMEMO_LINUX_GLIBC_MAX="2.34"
