# inbox / platform

## [2026-08-04 00:31] T-141 DONE（**计划，未实施**）

交付: 本文件（`coordination/inbox/platform.md`）
**本轮未修改仓库任何文件。** 零 `git add`、零 commit、零 push、零 remote 操作；未碰
`vendor/manifests/`、`packages/downloader`、`.github/`；未碰 `/root/data-memo`、未写
`datadir.json`、未重启/占用 `:10000`（只发过 GET）、未跑 `pnpm -r build`、未用 `pkill -f`、
未跑本地 whisper 转写。临时脚本写在 `/tmp/platform/`、`/tmp/platform-scan/`。

---

# TL;DR

> ⚠️ **这是一份未实施的计划。** 任务中途收到范围收缩指令（用户选择「跨平台先放着，专心把
> Linux 上的债还完」），因此**一行 manifest、一行代码、一行 workflow 都没有改**。
> 下面所有「可以补 / 应该改」都是**待办**，不是已完成。
>
> **本机只有 Linux x64。** 凡涉及 macOS / Windows / arm64 的行为结论一律标 `[未验证]`。
> 上游产物的体积与 sha256 来自 **GitHub Releases API 的 `digest` 字段**（我本机没有下载
> 那些文件），标 `[上游 API]` —— **日后落地前必须重新核，上游可能已发新版**。

## 1. 你交给我验证的那个判断：**一半成立，一半不成立**

「上游都发布多平台预编译包，所以补齐平台覆盖主要是 manifest 的活」——

| 组件                   | 判断成立？                | 依据                                                                                                                                                                                                |
| ---------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| yt-dlp                 | ✅ 成立                   | 上游 `2026.07.04` 有 24 个资产，覆盖 mac(universal2) / win(x64,arm64,x86) / linux(x64,aarch64,armv7,musl) `[实测 API]`                                                                              |
| ffmpeg / ffprobe       | ✅ 成立（macOS 要换上游） | BtbN 同一个不可变 tag 有 linux64 / linuxarm64 / win64 / winarm64 `[实测 API]`；**BtbN 没有 macOS** `[实测：49 个资产逐个列过]`                                                                      |
| libsimple / sqlite-vec | ✅ 成立，**且已经补齐了** | `sqlite-ext.json` 11 个包已覆盖 6 个平台组合 `[实测]`                                                                                                                                               |
| sherpa-onnx            | ✅ 成立                   | npm `sherpa-onnx-node@1.13.4` 的 optionalDependencies 覆盖 darwin-{arm64,x64} / linux-{x64,arm64} / win-{x64,ia32}，**且 `pnpm-lock.yaml` 里六个全在** `[实测]`                                     |
| **whisper.cpp**        | 🔴 **不成立**             | v1.9.1（**当前 latest**）9 个资产：ubuntu-{x64,arm64}、Win32/x64（含 blas）、cublas-{11.8,12.4}-x64、xcframework。**没有 macOS CLI、没有 Vulkan、没有 ROCm、没有 Linux CUDA** `[实测 API 逐个列过]` |

**结论**：ASR 引擎——也就是让这个产品成立的那个东西——**在 macOS 上没有任何可下载的上游产物**，
在 Windows+AMD / Linux+NVIDIA / Linux+AMD 上**没有加速后端**（只能退回 CPU 包）。
这一条不是 manifest 能解决的。ADR-015 §1 与 `gpu-runtime` 的 T-063 早就是这个结论，
**我这次重新拉了一遍上游资产清单，与它们一致，没有变化。**

## 2. 但真正最急的缺口不是 whisper —— 是 **ffmpeg 只有 linux/x64 一条**

`[实测]` 从 `backends.json` 程序化算出来：**`engine === 'ffmpeg'` 的包全仓只有 1 个**
（`media-tools-linux-x64`）。而 `packages/pipeline/src/transcribe.ts:22` 每条转写路径都要
`normalizeToPcm16k` + `probeMedia`，两者都调 ffmpeg。

→ **Windows 用户即使装上了 whisper CUDA 包，F1/F2/F3 依然全废**，因为没有 ffmpeg 可装。
→ 而 BtbN 在**我们已经钉住的那个 tag** 里就有 `win64` 与 `linuxarm64` 的现成产物。
**这是三条 manifest 的事，性价比最高的一块。**

## 3. 第二个「一行都没写」的缺口：`components.json` 是纯 Linux x64 的

`[实测]` 交叉比对三份清单：`backends.json` + `sqlite-ext.json` 共 26 个包，
其中 **20 个在 `components.json` 里没有条目**（全部非 Linux-x64 的包，一个不剩）。
而 `apps/daemon/src/http/rest/components.ts` 全文 188 行**没有一处 `os`/`arch`/`platform`** `[读码]`。

→ 一个 Mac / Windows 用户打开「组件与来源」页，看到的是 6 条 **Linux x64** 组件，
**他自己那台机器上要装的每一个组件，来源与许可证一条都查不到**。ADR-001 的可追溯性保证
在非 Linux 平台上是空的。T-132 加的那条守卫只查了 `components → backends` 一个方向，
**反方向没人查**。

## 4. 代码里的平台假设：清单 **49 条**（含 12 条「核对过、没问题」），其中 6 条是「现在就在 Linux 上错着，只是症状要到别的平台才显形」

另有一个总数字：全仓 **42 处** `process.platform`/`os.platform()`/`os.arch()` 分支，
**34 处（81%）在本机永远走不到**，而 CI 里没有任何一个 job 跑 TS 测试 ——
**这 34 条分支从写下来那天起没有被任何自动化执行过一次**（§3.2）。

完整清单在 §3（49 行表，每条带 file:line + 证据级别）。最值得先看的六条：

|     | 位置                                               | 一句话                                                                                                                                                                                     |
| --- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 🔴  | `apps/daemon/src/main.ts:1075`                     | 入口守卫手拼 `file://` 而不是 `pathToFileURL()`。**Windows 上永远不匹配 → `node dist/main.js` 静默退出 0 什么都不做**；Linux 上路径含空格/中文就已经触发 `[实测]`                          |
| 🔴  | `packages/pipeline/src/subprocess/argGuard.ts:331` | `assertWithinRoot` 还在读宿主 `process.platform` —— **正是 `isSafeExecutable` 刚修掉的那个 bug，原封不动留在隔壁函数里**。实测 UNC 路径 `\\server\share\evil` 被判为「合法子路径」`[实测]` |
| 🔴  | 全仓 0 命中 vs `docs/adr/ADR-003:83`               | ADR 明写「daemon 首次运行自动 `xattr -dr com.apple.quarantine`」——**运行时代码里一个字都没有**。构建脚本里有 `codesign`，运行期零处理 `[实测 grep]`                                        |
| 🔴  | `packages/pipeline/src/subprocess/runner.ts:190`   | 注释写「On Windows this is emulated via taskkill below」——**全仓 0 个 `taskkill`**。Windows 上只杀直接子进程，ffmpeg/yt-dlp 派生的 helper 留活 `[实测 grep]`                               |
| 🟡  | `apps/daemon/src/storage/move.ts:470`              | `fs.cp({verbatimSymlinks:true})` 是**唯一没有 Windows 回退**的链接路径（`store.ts` / `unpack.ts` / `tools.ts` 三处都有 EPERM→copy 回退）。Windows 无开发者模式 → 搬家永远失败              |
| 🟡  | `apps/daemon/src/storage/migrateAssets.ts:93`      | `abs.split('/')` 对**文件系统路径**硬编码 `/`。同文件 `:111,113` 用了 `split(sep)` —— 作者知道，漏了这一处                                                                                 |

**并且我要更正任务书里的一条前提**：`asset-check` 说「大小写不敏感文件系统上的路径解析
无法在本机验证」——**这条不成立**。我们用 `mkfs.vfat` + loop mount 在本机造了一个真的
大小写不敏感文件系统跑通了，结论是：**后果是功能不是安全**（字符串前缀比较只会过度拒绝，
不可能放过根外路径）。见 §3 第 7 条。

## 5. CI workflow：**它一旦真跑起来，会把 `backends.json` 毁掉**

只读通读，**未改一个字**（按指令）。最严重的一条：`merge-manifest` job 把
`vendor/manifests/backends.json` **整份覆盖**为只含本次构建产物的新文件 —— 现有 15 个
上游直连包（yt-dlp ×4、ffmpeg、llama.cpp ×7、whisper ×3）**全部消失**。
而且 `build-whisper.sh` 吐出的 fragment 与 `BackendPackSchema`（`.strict()`）**结构不兼容**：
缺 8 个必填字段、多 4 个未声明字段、**没有任何 `mirrors` URL**，顶层还漏 `catalogVersion`。
→ 合并出来的文件 `validateBackendManifest` 一定不过 → **daemon 加载不了目录**。
完整 11 条见 §4。**这正是「从来没跑过的东西里必然有从来没被执行过的错误」的教科书样本。**

## 6. 现在这台机器上，7 行平台矩阵的真实分数

**能完整用起来的：1 / 8。**（Linux x64 CPU）
详见 §1 的覆盖表 —— 每一格都注明了证据来源，包括「上游不提供」和「查不到」。

---

# §0 这份文档的状态与证据口径

**状态**：计划，**未实施**。可以照着执行，但每一步落地前请重新核上游。

**证据口径**（全文统一）：

| 标记         | 含义                                                                           |
| ------------ | ------------------------------------------------------------------------------ |
| `[实测]`     | 我在本机（Linux x64）跑了命令 / 打了接口，附真实输出或可复现的命令             |
| `[上游 API]` | 值取自 GitHub Releases API 的 `digest` / `size` 字段，**我没有下载该文件复算** |
| `[上游文档]` | 上游 README / formula 的文字，附具体位置                                       |
| `[读码]`     | 我读了源码，附 `绝对路径:行号`                                                 |
| `[推测]`     | 明确标出，并写明依据                                                           |
| `[未验证]`   | 需要 mac / Windows / arm64 真机，本机拿不到任何证据                            |

**一条硬规则**：本文件里**没有任何一个非 Linux-x64 平台上的行为是被验证过的**。
凡是写「装得上 / 能跑」的地方，读作「上游声称有这个产物，且我们的下载路径在结构上支持它」。

---

# §1 覆盖表：章程 §3 的 7 行 × 各组件

## 1.1 逐平台的原始事实（`[实测]`，脚本 `/tmp/platform/coverage.mjs` 从三份 manifest 算出）

| 平台 (os/arch) | whisper.cpp (ASR)                                          | ffmpeg/ffprobe          | yt-dlp              | libsimple | sqlite-vec |
| -------------- | ---------------------------------------------------------- | ----------------------- | ------------------- | --------- | ---------- |
| darwin/arm64   | ❌                                                         | ❌                      | `ytdlp-macos-arm64` | ✅        | ✅         |
| darwin/x64     | ❌                                                         | ❌                      | ❌                  | ✅        | ✅         |
| win32/x64      | `whispercpp-cpu-win-x64`<br>`whispercpp-cuda-12.4-win-x64` | ❌                      | ✅                  | ✅        | ✅         |
| linux/x64      | `whispercpp-cpu-linux-x64`                                 | `media-tools-linux-x64` | ✅                  | ✅        | ✅         |
| linux/arm64    | ❌                                                         | ❌                      | ✅                  | ✅        | ✅         |
| win32/arm64    | ❌                                                         | ❌                      | ❌                  | ✅        | ❌         |

（`llama.cpp` 有 7 个包但 ADR-016 已砍掉本地 LLM 线，不计入。）

## 1.2 对齐章程 §3 那 7 行

每格格式：`结论 ｜ 证据来源`。

| #   | 章程行                | 加速后端          | 转写引擎                                                                                      | ffmpeg                                                                   | yt-dlp                                                                                                                                  | 中文检索 | **这一行能用吗**                                |
| --- | --------------------- | ----------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------- |
| 1   | macOS (Apple Silicon) | Metal / CoreML    | 🔴 **无** ｜上游 v1.9.1 无 macOS CLI `[实测 API]`                                             | 🔴 无 ｜BtbN 无 macOS `[实测 API]`；换源可解，见 §2.2                    | ✅ ｜`[上游 API]`                                                                                                                       | ✅       | 🔴 **不能**。装不了任何转写引擎，也没有 ffmpeg  |
| 2   | macOS (Intel)         | CPU (AVX2)        | 🔴 **无** ｜同上                                                                              | 🔴 无 ｜同上                                                             | 🔴 **无** ｜上游那个文件是 universal2（`[上游文档]` README:99「Universal MacOS (10.15+)」），**但 manifest 只写了 `arch:"arm64"` 一条** | ✅       | 🔴 **不能**，且比 Apple Silicon 还差一格        |
| 3   | Windows + NVIDIA      | CUDA              | ✅ ｜`whispercpp-cuda-12.4-win-x64`（另有上游 11.8 未收录）                                   | 🔴 **无** ｜BtbN **有** `win64-gpl` 现成产物，manifest 没写 `[实测 API]` | ✅                                                                                                                                      | ✅       | 🔴 **不能** —— 卡在 ffmpeg，不是卡在 ASR        |
| 4   | Windows + AMD         | Vulkan / DirectML | 🟡 **只能退 CPU** ｜上游无 Vulkan/ROCm 版 whisper `[实测 API]`；`whispercpp-cpu-win-x64` 可用 | 🔴 无 ｜同 #3                                                            | ✅                                                                                                                                      | ✅       | 🔴 **不能**（同 #3），且**永远拿不到 AMD 加速** |
| 5a  | Windows CPU           | AVX2/AVX512       | ✅ ｜`whispercpp-cpu-win-x64`（上游还有 `whisper-blas-bin-x64.zip` 未收录）                   | 🔴 无 ｜同 #3                                                            | ✅                                                                                                                                      | ✅       | 🔴 **不能** —— 只差 ffmpeg                      |
| 5b  | Linux CPU             | AVX2/AVX512       | ✅                                                                                            | ✅                                                                       | ✅                                                                                                                                      | ✅       | ✅ **能** —— **8 个组合里唯一完整的一行**       |
| 6   | Linux + NVIDIA        | CUDA              | 🟡 **只能退 CPU** ｜**上游没有 Linux CUDA 的 whisper 包** `[实测 API]`                        | ✅                                                                       | ✅                                                                                                                                      | ✅       | 🟡 能跑，**但拿不到 CUDA 加速**                 |
| 7   | Linux + AMD           | ROCm / Vulkan     | 🟡 **只能退 CPU** ｜上游无 `[实测 API]`                                                       | ✅                                                                       | ✅                                                                                                                                      | ✅       | 🟡 能跑，**但拿不到 AMD 加速**                  |

**附加一行（章程没列，但 manifest 里已是事实上的目标）**：

| #   | 平台        | 转写引擎                                                                         | ffmpeg                                                           | yt-dlp | sqlite ext | 能用吗                      |
| --- | ----------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------ | ---------- | --------------------------- |
| 8   | Linux arm64 | 🔴 无 ｜**上游有 `whisper-bin-ubuntu-arm64.tar.gz`，manifest 没写** `[实测 API]` | 🔴 无 ｜**BtbN 有 `linuxarm64-gpl`，manifest 没写** `[实测 API]` | ✅     | ✅         | 🔴 不能，**两条都是纯漏写** |

### 判分口径（写下来备查）

- 「能用」= F1/F2/F3 中至少一条能端到端跑通。判据是 `packages/pipeline/src/transcribe.ts`
  的必需工具集：**ffmpeg（归一化）+ ASR 引擎**，两者缺一即全废 `[读码]`。
- 「加速」不计入「能用」——退回 CPU 仍算能用，但会另标 🟡。
- yt-dlp 只影响 F1 的站点类链接（直链走 `DirectHttpSource` 不受影响）。

## 1.3 三个「看起来有、其实没有」的东西

1. **`llamacpp-metal-macos-arm64` 让 macOS 看起来被支持了** —— 它是 ADR-016 已砍的
   本地 LLM 线，**和转写一点关系都没有**。`debt-audit` C16 已列。
2. **`models-whisper.json` 里有 2 条 darwin/arm64 的 CoreML encoder**
   （`asr/whisper-large-v3-f16` 与 `-turbo-f16` 的 optional `coreml-encoder` 文件，
   `platforms: [{os:darwin,arch:arm64}]`）`[实测]` —— 但**没有任何一个能消费它们的
   macOS `whisper-cli`**。目录里躺着两个永远装不上的东西。
3. **`sqlite-vec` 没有 win32/arm64** —— 这一条是**上游真的没有**：
   v0.1.9 的 loadable 资产里 windows 只有 `x86_64` `[实测 API]`。libsimple 有 arm64。
   → Windows on ARM 上中文向量检索无解（除非 x64 模拟，但原生扩展 DLL 跨架构加载不了 `[推测]`）。

---

# §2 逐组件的上游实况

> 下面所有体积/sha256 **一律来自 GitHub Releases API 的 `digest` 字段**，
> 我**没有下载**其中任何一个文件复算。日后落地时请按 `ytdlp-install` 的做法
> ——**至少与上游自己的 checksums 文件二次比对**——再写进 manifest。

## 2.1 whisper.cpp — 唯一真正的硬缺口

`[实测]` `GET /repos/ggml-org/whisper.cpp/releases/tags/v1.9.1`，
且 `releases/latest` 的 `html_url` 就是 `v1.9.1` → **v1.9.1 是当前最新稳定版**。

全部 9 个资产：

| 资产                                |        体积 | sha256（API digest） | 我们的状态                                                                                                                                                                                                                                               |
| ----------------------------------- | ----------: | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `whisper-bin-ubuntu-x64.tar.gz`     |   9,379,235 | `f3bf3b43…15c5`      | ✅ 已收录                                                                                                                                                                                                                                                |
| `whisper-bin-ubuntu-arm64.tar.gz`   |   4,555,819 | `e0b66cd5…94b3`      | ❌ **未收录（可补，Linux arm64 CPU）**                                                                                                                                                                                                                   |
| `whisper-bin-x64.zip`               |   7,982,101 | `7d8be46e…3539`      | ✅ 已收录                                                                                                                                                                                                                                                |
| `whisper-bin-Win32.zip`             |   5,068,706 | `be1ea26c…c954`      | ❌ 未收录（win x86，不在章程矩阵内）                                                                                                                                                                                                                     |
| `whisper-blas-bin-x64.zip`          |  20,769,031 | `3c319eab…4f71`      | ❌ 未收录（Windows OpenBLAS CPU，可选提速）                                                                                                                                                                                                              |
| `whisper-blas-bin-Win32.zip`        |  12,100,146 | `b7f66258…7d06`      | ❌ 未收录（x86）                                                                                                                                                                                                                                         |
| `whisper-cublas-11.8.0-bin-x64.zip` | 278,557,654 | `aecdce0e…c963`      | ❌ 未收录（老驱动的 CUDA 退路）                                                                                                                                                                                                                          |
| `whisper-cublas-12.4.0-bin-x64.zip` | 677,887,125 | `106a2030…601b`      | ✅ 已收录                                                                                                                                                                                                                                                |
| `whisper-v1.9.1-xcframework.zip`    |  50,438,515 | `8c3ecbe7…1a4c`      | ❌ **不可用**：Apple 平台的 xcframework 是**库**不是可执行程序，我们的流水线 spawn 的是 `whisper-cli` 进程（`packages/pipeline/src/asr/whisperCpp.ts`）。⚠️ **我没有下载解包核实其内容**，依据是资产名与上游 release 分类，以及 ADR-015/T-063 的同一结论 |

**上游没有的（4 类）**：macOS CLI、Vulkan、ROCm、Linux CUDA。

**macOS whisper 的三条替代路线（都没验过，按可行性排序）**：

| 路线                               | 需要什么                                                                                                      | 卡点                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. 在一台 Mac 上本机自建**       | `scripts/build-whisper.sh --backend metal`（脚本已在，ADR-015 保留了它）                                      | 需要一台 Mac。**不需要 GitHub remote** —— 见 §5.2 的本地 HTTP 投递法                                                                                                                                                                                                                                                                                                                                                                              |
| **B. GitHub Actions macOS runner** | 建仓 + 推远端                                                                                                 | 用户已明确不推远端                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **C. Homebrew bottle**             | `whisper-cpp` 1.9.1，bottle 覆盖 `arm64_tahoe/sequoia/sonoma` + `sonoma`(Intel) `[实测 formulae.brew.sh API]` | 🔴 三重卡点：① `root_url` 是 `ghcr.io`，**不在 `ALLOWED_DOWNLOAD_HOSTS` 里**（`packages/shared/src/schemas.ts:39`）；② OCI 拉取要先换匿名 token，不是一条 `GET`，等于给下载器开第二条代码路径（ADR-015 §4 决策 4 明确否决过这种事）；③ **它 `dependencies: ["ggml","sdl2-compat"]`** `[实测]` → bottle 里的二进制链接的是 Homebrew 前缀下的 dylib，**不是自包含可重定位包**，直接搬走跑不起来 `[推测，依据 Homebrew bottle 的 install_name 机制]` |

→ **建议 A**。理由：脚本现成、不需要远端、且 §5.2 那条投递通道 schema 上已经允许。

## 2.2 ffmpeg / ffprobe — 缺口最广，但也最好补

`[实测]` BtbN 钉死 tag `autobuild-2026-08-02-13-17`（49 个资产），gpl-7.1 系列全部 4 个：

| 资产                                                  |        体积 | sha256（API digest） | 状态                                                                  |
| ----------------------------------------------------- | ----------: | -------------------- | --------------------------------------------------------------------- |
| `ffmpeg-n7.1.5-12-g1fdbca85aa-linux64-gpl-7.1.tar.xz` | 118,999,596 | `47b2cc48…ec58`      | ✅ 已收录（**且 `gpu-runtime` 已逐字节复算过**，见其 inbox T-067 §6） |
| `…-linuxarm64-gpl-7.1.tar.xz`                         | 101,899,284 | `c567e86d…6a2a`      | ❌ **未收录（可补）**                                                 |
| `…-win64-gpl-7.1.zip`                                 | 158,697,121 | `5fef81d2…a00d`      | ❌ **未收录（可补，最高优先）**                                       |
| `…-winarm64-gpl-7.1.zip`                              | 110,733,165 | `79ee11f0…3745`      | ❌ 未收录                                                             |

**BtbN 没有 macOS** `[实测：49 个资产逐个过滤，只有 linux64/linuxarm64/win64/winarm64 四种平台]`。

**macOS ffmpeg 的候选上游**：`eugeneware/ffmpeg-static`，tag `b6.1.1`（不可变），
GitHub Releases，**host 已在允许名单里** `[实测 API]`：

| 资产                   |       体积 | sha256（API digest） |
| ---------------------- | ---------: | -------------------- |
| `ffmpeg-darwin-arm64`  | 45,568,216 | `a90e3db6…6584`      |
| `ffprobe-darwin-arm64` | 45,528,808 | `bb2db6f5…0b64`      |
| `ffmpeg-darwin-x64`    | 78,862,176 | `ebdddc93…8894`      |
| `ffprobe-darwin-x64`   | 78,780,408 | `fa3add0c…9c1e0`     |

三条要如实写进 manifest 的注意事项：

1. **版本不一致**：它是 **ffmpeg 6.1.1**，BtbN 那条是 **7.1.5**。跨平台版本漂移必须写在 `provenance` 里。
2. **许可证不同**：我下载了该 release 的 `darwin-arm64.LICENSE`（4,376 B）`[实测]`，
   正文是 FFmpeg 的通用 LICENSE.md，措辞为「LGPL v2.1+ … GPL 部分默认不启用」；
   而 `linux-x64.LICENSE` 是 35,147 B（GPLv3 全文体量）。
   → **推断** darwin 构建是 LGPL-2.1-or-later、linux 构建是 GPL。
   ⚠️ **这是从 LICENSE 文本推断的，我没有核对编译开关**，落地前请自己确认。
3. **是裸二进制不是归档**，走 `role:"binary"` + `unpack:null`，
   正好是 T-132 给 yt-dlp 修好的那条路径（`installer.ts:286` 会加可执行位）`[读码]`。
   一个包里两个 binary 文件，会被 `linkByName` 硬链成 `by-name/backend/ffmpeg` 与
   `…/ffprobe`，`findInBackendPacks` 的扁平查找认得 —— **但这条组合我没有实跑过**。

> 另一个候选 `evermeet.cx`（`gpu-runtime` 在 `build-media-tools.sh` 里提过）
> **需要改 `ALLOWED_DOWNLOAD_HOSTS`**，且它把 ffmpeg / ffprobe 拆成两个归档。
> 相比之下 `ffmpeg-static` 不用动允许名单。

## 2.3 yt-dlp — 覆盖最好，但漏了 macOS Intel

`[实测]` tag `2026.07.04` 共 24 个资产。与我们相关的：

| 资产                                      |       体积 | sha256（API digest） | 状态                                 |
| ----------------------------------------- | ---------: | -------------------- | ------------------------------------ |
| `yt-dlp_linux`                            | 39,924,536 | `6bbb3d31…10ae`      | ✅（本机实算过，见 `ytdlp-install`） |
| `yt-dlp_linux_aarch64`                    | 39,675,904 | `b6ce9764…e0b1`      | ✅                                   |
| `yt-dlp_macos`                            | 38,256,544 | `498bd0da…261b`      | ✅ 但**只挂在 arch:arm64 上**        |
| `yt-dlp.exe`                              | 18,226,085 | `52fe3c26…24b8`      | ✅                                   |
| `yt-dlp_arm64.exe`                        | 22,250,288 | `1525690b…9280`      | ❌ 未收录（Windows on ARM）          |
| `yt-dlp_x86.exe`                          | 14,300,315 | `cac3a935…8f12`      | ❌ 未收录（win x86，不在矩阵内）     |
| `yt-dlp_musllinux` / `_musllinux_aarch64` |          — | —                    | ❌ 未收录（Alpine 类发行版）         |

**macOS Intel 的修法是零成本的**：`yt-dlp_macos` 上游 README 第 99 行明写
「Universal MacOS (10.15+) standalone executable」`[上游文档，我拉了 tag 2026.07.04 的 README]`
→ 只需再加一条 `os:"darwin", arch:"x64"` 的 manifest 条目**指向同一个 URL 与同一个 sha256**。
包选择逻辑是 `os` + `arch` 精确匹配（`apps/daemon/src/http/rest/backends.ts:36-40` +
`packages/runtime/src/backends/applicability.ts:120`，arch 由
`http/rest/hardware.ts:37` 的 `process.arch === 'arm64' ? 'arm64' : 'x64'` 给出）`[读码]`
→ **今天一台 Intel Mac 拿到的是「没有任何 yt-dlp 包」，尽管那个二进制在它上面能跑。**

## 2.4 sqlite 扩展 — 已经补齐了，不用动

`[实测]` `sqlite-ext.json` 11 个包：libsimple 覆盖 darwin-{arm64,x64} / linux-{arm64,x64} /
win32-{arm64,x64} 全 6 格；sqlite-vec 覆盖 5 格，缺 win32/arm64（**上游真的没有**，§1.3-3）。
上游资产清单我重新拉过一遍，与 manifest 里写的 sha256 一致 `[实测 API]`。

## 2.5 sherpa-onnx — npm 路线，本身跨平台，但**没有验证它在 mac 上真的能跑**

`[实测]` `sherpa-onnx-node@1.13.4` 的 `optionalDependencies` 六个平台包全在，
`pnpm-lock.yaml` 里六个也全部解析过（`grep -n "sherpa-onnx-\(darwin\|win\|linux\)" pnpm-lock.yaml`
命中 12 行）→ 在一台 Mac 上 `pnpm install` **理论上**会拿到 `sherpa-onnx-darwin-arm64`。

**这一点很重要**：`packages/pipeline/src/asr/selectEngine.ts` 里 paraformer 是中文的默认引擎
（ADR-013），而 paraformer 模型是 ONNX，**与平台无关**。
→ **理论上一台 Mac 现在就能做中文转写（走 sherpa/paraformer），只是做不了 whisper。**
⚠️ 但这是**纯推断**：没有 Mac 验证过 `sherpa-onnx-darwin-arm64` 能加载、
也没验证 `ffmpeg` 缺失下前置的音频归一化能不能绕过（**大概率不能**，见 §2.2）。
**不要拿这条当「mac 已经可用」的依据。**

## 2.6 openmemo-probe — 只能自建，且现在名字就对不上

`[实测 grep]` `apps/daemon/src/runtime/setup.ts:70` 找的是 `probe` / `probe.exe`；
**其余全部使用方**（`http/rest/selfcheck.ts:94`、`packages/runtime/src/probe/runProbe.ts:32`、
`packages/runtime/src/selfcheck.ts:125,346`、`scripts/selfcheck.mjs:250`）
以及**产出方**（`scripts/build-probe.sh:3,57`、`.github/workflows/build-backends.yml:105,227,313`）
用的都是 `openmemo-probe`。

后果：`GET /api/runtime/hardware` 的 `probeExists` 恒 false → **L2 加速包永远装不上**
→ 章程要求 2.1 的「网页检测硬件 → 推荐后端」在**所有平台**上都不成立。
（`debt-audit` B0 已列为 P1；我这次独立复核，结论一致。**这不是跨平台专属问题，
但它是跨平台矩阵的总开关**。）

---

# §3 代码里的平台假设 —— 完整清单

> 调查方法：全仓 `process.platform` / `os.platform()` / `os.arch()` 分支枚举 +
> 针对性实测脚本（`/tmp/platform-scan/`，跑完已清理）。
> **本机 Linux x64；`[未验证]` 的条目一律没有真机证据。**

## 3.0 先回答任务书点名的五条

### ① `isSafeExecutable` —— **已修**，但**同一个 bug 原封不动留在隔壁函数**

`packages/pipeline/src/subprocess/argGuard.ts:275,301` `[读码+实测]`：

```ts
export function isSafeExecutable(binPath: string, platform: NodeJS.Platform = process.platform);
const absolute = platform === 'win32' ? win32.isAbsolute(binPath) : posix.isAbsolute(binPath);
```

平台是**入参**，用 `path.win32` / `path.posix` 显式区分。
`argGuard.ts:295-300` 的注释亲口记录了原来那个 bug：Linux 上
`isAbsolute('C:\\tools\\x.bat')` 为 false → 先被 `path_escape` 拦掉 →
**CVE-2024-27980 的 `.bat` 分支在测试里根本到不了，`.bat` 测试一直在「因为错误的理由通过」**。
测试 `argGuard.test.ts:206-218` 三条，都显式传 `'win32'`。

本机实测（宿主 linux）：

```
"C:\tools\yt-dlp.exe"     host:false  win32:true  posix:false
  win32  "C:\tools\yt-dlp.bat"  -> rejected:unsafe_executable   ← CVE 分支真的可达了
  win32  "C:\tools\x.CMD"       -> rejected:unsafe_executable   （大小写也挡住）
  linux  "C:\tools\yt-dlp.exe"  -> rejected:path_escape         ← 未修前的形态
```

**⚠️ 但 `assertWithinRoot`（`argGuard.ts:322`）没有 platform 参数**，
`:331` 直接读宿主 `process.platform === 'win32'`，`:340-341` 用宿主的 `relative`/`isAbsolute`。
本机实测这两条 Windows 形态**被当成合法子路径接受**：

```
UNC    -> {"ok":true,"value":"/tmp/root-x/\\\\server\\share\\evil"}
C:rel  -> {"ok":true,"value":"/tmp/root-x/C:evil"}
```

`argGuard.test.ts:221-255` 只测了 `../`、绝对路径、symlink —— **一条 UNC / 盘符相对路径的用例都没有**。

**这是「同一个教训学了一半」的标准形态：修了被点名的那个函数，没有回头查同族。**

### ② 大小写不敏感文件系统 —— **任务书里「无法在本机验证」这条不成立**

注释原文在 `coordination/inbox/asset-check.md:271`（**只在回执里，源码里没有留痕**）：

> 「大小写不敏感文件系统（macOS/Windows）上的解析行为 —— 无法在本机验证。」

对应源码 `packages/runtime/src/assetPaths.ts:49`：

```ts
const inside = (p: string): boolean => rs.some((r) => p === r || p.startsWith(r + sep));
```

**我们在本机造了一个真的大小写不敏感文件系统**（`mkfs.vfat` + loop mount，跑完已卸载清理）`[实测]`：

```
# ground truth：两种拼法打开的是同一个真文件
  open(.../mnt/Data/media/Rec.wav)  -> 8 bytes: RIFFDATA
  open(.../mnt/data/MEDIA/rec.WAV)  -> 8 bytes: RIFFDATA

# case 1：rel_path 是大小写不同的绝对路径
  candidates = []
  probe      = {"abs":null,"tried":[],"note":"路径不在任何允许的根内"}
  => http/rest/media.ts:126 对一个能正常打开的文件返回 403 ASSET_OUT_OF_ROOT

# case 3：大小写不敏感能不能让「根外」看起来像「根内」？（安全方向）
  probe(../../etc/hostname) = []   ← 仍然拦住
  probe(/etc/hostname)      = []   ← 仍然拦住
```

**结论：后果是「功能」，不是「安全边界」。** 大小写不敏感只会让**更多**路径指向同一个文件，
所以字符串前缀比较只会**过度拒绝**（把好资产报成 403/404），不可能**放过**根外路径。
`assetPaths.test.ts`（120 行）里**没有任何一条**大小写或 Windows 路径形态的用例。

触发条件是现成的：`apps/daemon/src/ws/recorder.ts:270` 往 `media_assets.rel_path`
写的是**绝对路径**（`:132` = `join(mediaDir,'recordings',…)`）`[读码]`
→ 用户改一次 `--data-dir` 的拼法（`C:\` vs `c:\`），已有录音全部 403 `[未验证：需真机]`。

**顺带在同一个函数上发现一个与平台无关的真安全问题**：`assetPaths.ts:83` 的 `open()`
**跟随符号链接却从不 realpath**（而 `argGuard.assertWithinRoot` 是 realpath 的）。实测：

```
probeAssetFile 走一条根内的、指向 /etc/hostname 的软链：
{"abs":".../media/escape.wav","bytesRead":0,"note":"0 字节"}
=> abs !== null，/media/asset/<ulid> 会把 /etc/hostname 流出去
```

**这条建议单独派人修，它今天在 Linux 上就是活的。**

### ③ 可执行位 / macOS quarantine

**可执行位是对的**。`packages/downloader/src/installer.ts:286` `[读码]`：

```ts
if (!f.unpack && f.role === 'binary' && process.platform !== 'win32') {
  await fs.chmod(linked, 0o755);
```

Windows 上**显式跳过、不抛错**，`:283-284` 写明理由（Windows 无 exec 位，`access(X_OK)` 不看它）。
`unpack.ts:427` 与 `:597` 同样处理。

**quarantine / Gatekeeper：运行时代码 0 命中** `[实测 grep]`：

```
grep -rni "quarantine|xattr|codesign|spctl|gatekeeper" apps/*/src packages/*/src  -> 0
命中全部在 scripts/*.sh（构建期）与 docs/
  scripts/build-whisper.sh:283      codesign --force --sign - --timestamp=none "$f"
  scripts/build-sqlite-ext.sh:191   codesign --force --sign - "$f"
  scripts/build-media-tools.sh:153  codesign --force --sign - "$f"
```

而 `docs/adr/ADR-003-runtime-and-process-model.md:83` 明写：

> 「首次运行时由 daemon 自动 `xattr -dr com.apple.quarantine` 清除隔离属性」

`docs/design/D-04-build-and-runtime.md:461` 与 `.github/workflows/build-backends.yml:109`
重复了同一句。**三处文档都在描述一段不存在的代码。**
（`debt-audit` D8 已经抓到过这条；我独立复核，仍然 0 命中。）

⚠️ 而且**下面那层假设本身也没验过**：R-02 §F.3 第 6 项 与
`D-04:466` 都标注「程序化下载不打 quarantine 在 macOS 15/26 上是否仍成立 = UNKNOWN」。
所以这里是**两层未知叠在一起**：假设未验证 + 兜底代码不存在。

### ④ shell 依赖 —— **运行时干净，构建/检查脚本会断**

运行时代码 `[实测 grep]`：`shell: true` **0 命中**、`execSync` **0 命中**、
`sh -c` / `bash -c` **0 命中**（`#!/bin/sh` 只出现在 `ytdlpInstall.test.ts` 造的假二进制里）。
所有 `spawn`/`execFile` 都是 `shell:false` + 数组 argv。**这一层是设计过的，没有问题。**

会在 Windows 上断的是**脚本层**：

| 位置                                   | 问题                                                                                                                                                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/check-tracked-sources.mjs:37` | `execFileSync('find', [root,'-type','d'])` —— Windows 的 `FIND.exe` 是 grep 类工具，语义完全不同 → catch → 返回 `[]` → `:45`「没找到任何源码目录」→ **exit 1，`pnpm check` 挂**                                 |
| `scripts/license-report.mjs:119`       | `execFileSync('pnpm', […])` —— Windows 上 pnpm 是 `pnpm.cmd`，Node 自 CVE-2024-27980 修复后**不带 `shell:true` 直接拒绝执行 `.cmd`** `[推测，依据即本仓 `argGuard.ts:266-273`拒绝`.bat/.cmd` 时引用的同一机制]` |
| `apps/web/package.json` `test:unit`    | `node -e "…'{\"type\":\"commonjs\"}'…"` 的反斜杠转义引号是 POSIX sh 语法，cmd.exe 不认                                                                                                                          |
| `scripts/*.sh`（4 个）                 | bash 脚本，Windows 需 Git Bash / WSL                                                                                                                                                                            |

**关于 `sh` 不认 `**`**：这个坑仓库已经踩过并修好了 —— `apps/daemon/package.json` 的
`_comment:test` 记录 T-135：`node --test dist/**/*.test.js` 被系统 `sh` 展开成「恰好两层」，
**daemon 13 个测试文件只跑到 9 个，漏掉的里面 7 条是红的**。现改为不给位置参数 + `globSync` 数量守卫。
**本轮全仓复查：没有第二处残留的 `**` shell 依赖。**

### ⑤ 符号链接 / 硬链接 —— 四处有回退，**一处没有**

| 位置                                          | 做什么                                                  | Windows 回退                                                                                                                                                            |
| --------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/downloader/src/store.ts:154`        | `fs.link()` 硬链接（`by-name/` 视图）                   | ✅ catch `EXDEV/EPERM/ENOTSUP` → `copyFile`。文件头 `:17-18` 明写「刻意用硬链接不用软链接：Windows 上 CreateHardLink 不需要特权，symlink 要开发者模式」                 |
| `packages/downloader/src/unpack.ts:217-243`   | 归档里的 symlink/hardlink 条目                          | ✅ `materialiseLink` catch `EPERM/ENOSYS/EXDEV/ENOENT` → `copyFile`（`:213-215` 注明理由）                                                                              |
| `packages/pipeline/src/tools.ts:275-287`      | SQLite 扩展 link 进 `bin/ext`                           | ✅ `win32 ? cp(...) : symlink(relative(...))`。但 `:248` 自陈 **UNVERIFIED on Windows**；且 Windows 走 cp 后，包升级/卸载留下**陈旧副本**（10 MB jieba 词典会双份占盘） |
| **`apps/daemon/src/storage/move.ts:470-474`** | 搬数据目录：`fs.cp(…, {verbatimSymlinks:true})`         | 🔴 **无回退**。Windows 无开发者模式 → `symlink` EPERM → 整个 cp 抛 → `:495` rollback → **搬家永远失败**（源数据完好，功能不可用）`[未验证：需真机]`                     |
| `packages/downloader/src/unpack.ts:547-551`   | GNU 长 linkname（`typeFlag === 'K'`）**被吃掉但不应用** | 注释说「symlinks/hardlinks 反正下面会被拒绝」——**这句是错的**，`:569-575` 会真的创建。目标 > 100 字节的链接会用被截断的 linkname。**与平台无关的 bug**                  |

## 3.1 完整表（49 条）

> 「本机可验」= 用 `path.win32`/`path.posix` 纯函数、mock `process.platform`、
> 或本机可造的文件系统就能闭环，**不需要 mac/Windows 真机**。

| #   | 位置                                                                                                                                            | 问题                                                                                                                                              | mac 上会怎样                                                                                                      | Windows 上会怎样                                                                                                                                                             | 证据                                                                                                                  | 本机可验                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 1   | `apps/daemon/src/main.ts:1075`                                                                                                                  | 入口守卫手拼 `` `file://${process.argv[1]}` `` 而不是 `pathToFileURL()`                                                                           | 路径含空格/非 ASCII → `mainCli()` **永不执行**，进程静默退出 0                                                    | **永远不匹配**（`file:///C:/…` vs `file://C:\…`）→ `node dist/main.js` 什么都不做                                                                                            | `[实测]` `/root/my dir/main.js` 真值是 `file:///root/my%20dir/main.js`，代码比的是 `file:///root/my dir/main.js` → NO | ✅ 已验                         |
| 2   | `packages/pipeline/src/subprocess/runner.ts:190,202`                                                                                            | 注释「On Windows this is emulated via taskkill below」→ **全仓 0 个 taskkill**                                                                    | 正常（`process.kill(-pid)`）                                                                                      | 只杀直接子进程，ffmpeg/yt-dlp 派生的 helper **留活**，超时/取消形同虚设                                                                                                      | `[实测 grep]`                                                                                                         | ⚠️ 「没实现」已验；现象须真机   |
| 3   | `packages/pipeline/src/subprocess/runner.ts:214-217`                                                                                            | SIGTERM → 5s → SIGKILL 两段式                                                                                                                     | 正常                                                                                                              | Node 在 Windows 上忽略信号名、一律 TerminateProcess → **第一发就是硬杀**，子进程没机会 flush                                                                                 | `[推测]`，依据 Node `subprocess.kill()` 文档 + 本仓 `main.ts:1039` 自己写的「Windows 上 OS 只给约 5 秒」              | ❌ 真机                         |
| 4   | `packages/pipeline/src/subprocess/argGuard.ts:331`                                                                                              | `assertWithinRoot` 用宿主 platform 做 UNC 检查                                                                                                    | 分支不可达                                                                                                        | 分支可达但从未被任何测试跑过                                                                                                                                                 | `[实测]` `\\server\share\evil` → `{"ok":true}`                                                                        | ✅ 可验（加 platform 入参即可） |
| 5   | `packages/pipeline/src/subprocess/argGuard.ts:340-341`                                                                                          | 宿主绑定的 `relative`/`isAbsolute`                                                                                                                | 同 Linux                                                                                                          | 跨卷 rel 会是绝对路径 —— 未测                                                                                                                                                | `[读码]` + 测试文件无任何 Windows 形态用例                                                                            | ✅ 可验                         |
| 6   | `packages/pipeline/src/subprocess/argGuard.ts:301`                                                                                              | ✅ **已修**：platform 是入参                                                                                                                      | 正确                                                                                                              | 正确，CVE 分支可达                                                                                                                                                           | `[实测]`                                                                                                              | ✅ 已验                         |
| 7   | `packages/runtime/src/assetPaths.ts:49`                                                                                                         | 大小写敏感的前缀比较用在大小写不敏感 FS 上                                                                                                        | 大小写不同的绝对 `rel_path` → **403 ASSET_OUT_OF_ROOT**，文件明明能打开                                           | 同（NTFS 默认不敏感）                                                                                                                                                        | `[实测]` 真 vfat loop 挂载                                                                                            | ✅ 已验                         |
| 8   | `packages/runtime/src/assetPaths.ts:48`                                                                                                         | 宿主绑定 `isAbsolute`                                                                                                                             | 同 Linux                                                                                                          | `/media/x.wav` 也算绝对 → 解析成 `C:\media\x.wav` → 越界 403                                                                                                                 | `[实测]` Linux 上 `C:\data\media\rec.wav` 被当成相对路径拼接                                                          | ✅ 已验                         |
| 9   | `packages/runtime/src/assetPaths.ts:83`                                                                                                         | 只 `resolve()` 不 `realpath()`，`open` 跟随软链 → **根内软链可逃逸（安全，与平台无关）**                                                          | 同                                                                                                                | 同（NTFS junction 同理）                                                                                                                                                     | `[实测]` 软链指 `/etc/hostname` → `abs !== null`                                                                      | ✅ 已验                         |
| 10  | `packages/downloader/src/installer.ts:286`                                                                                                      | ✅ Windows 跳过 chmod，理由在 `:283-284`                                                                                                          | 正常                                                                                                              | 正确                                                                                                                                                                         | `[读码]`                                                                                                              | ✅                              |
| 11  | 全仓 0 命中 vs `docs/adr/ADR-003:83`                                                                                                            | ADR 宣称的 `xattr -dr com.apple.quarantine` **运行时不存在**                                                                                      | 带 quarantine 的 dylib/二进制被 Gatekeeper 拦；Apple Silicon 上未签名 Mach-O **根本起不来**（不是弹窗，是不启动） | 无影响                                                                                                                                                                       | `[实测 grep]`                                                                                                         | ❌ 真机                         |
| 12  | `packages/pipeline/src/tools.ts:275-287`                                                                                                        | `:248` 自陈 UNVERIFIED on Windows                                                                                                                 | symlink 路径（T-093 实测过）                                                                                      | 走 cp → 陈旧副本 + 双份占盘                                                                                                                                                  | `[读码]`                                                                                                              | ⚠️ 逻辑可 mock                  |
| 13  | `apps/daemon/src/storage/move.ts:470-474`                                                                                                       | **唯一没有 Windows 回退的链接路径**                                                                                                               | 正常（T-128 实测修过）                                                                                            | 无开发者模式 → EPERM → **搬家永远失败**                                                                                                                                      | `[读码]`（`move.test.ts` 14 条全在 Linux 语义下）                                                                     | ❌ 真机                         |
| 14  | `packages/downloader/src/unpack.ts:217-243`                                                                                                     | ✅ EPERM/ENOSYS/EXDEV/ENOENT → copy                                                                                                               | 正常                                                                                                              | 优雅退化 —— 正确                                                                                                                                                             | `[读码]`                                                                                                              | ✅ 可注入 EPERM                 |
| 15  | `packages/downloader/src/unpack.ts:547-551`                                                                                                     | GNU 长 linkname 被吃掉，注释「反正下面会拒绝」是**假的**                                                                                          | 同                                                                                                                | 同（与平台无关）                                                                                                                                                             | `[读码]` `:549` vs `:569`                                                                                             | ✅ 可构造 tar                   |
| 16  | `packages/downloader/src/store.ts:154`                                                                                                          | ✅ `fs.link` + 回退                                                                                                                               | 正常                                                                                                              | CreateHardLink 免特权 + 有回退 —— 正确                                                                                                                                       | `[读码]`                                                                                                              | ✅                              |
| 17  | `apps/daemon/src/bootstrap/orphans.ts:56,60`                                                                                                    | 孤儿子进程回收**只在 Linux 实现**                                                                                                                 | 无回收：强杀 daemon 后 whisper-cli 被 launchd 收养继续吃满 CPU                                                    | 无回收（任务管理器强杀是 Windows 最常见杀法）                                                                                                                                | `[读码]` `:55` 自陈「其它平台先不做」                                                                                 | ❌ 真机                         |
| 18  | `packages/runtime/src/probe/runProbe.ts:74-76`                                                                                                  | 只设 `LD_LIBRARY_PATH` / `DYLD_LIBRARY_PATH`                                                                                                      | DYLD 生效；**但 hardened runtime 会剥掉 `DYLD_*`**                                                                | 两个变量都是死的；缓解：`setup.ts:161` 把 backendDir 设成 probe 自身目录，Windows 优先搜 exe 目录 → 恰好能工作                                                               | `[读码]` + `[推测]`（hardened runtime 依据 `R-02:441`）                                                               | ❌ 真机                         |
| 19  | `packages/runtime/src/probe/runProbe.ts:193`                                                                                                    | ✅ 分隔符分平台正确，但只喂给 `LD_/DYLD_` → Windows 上那个 `';'` 是死代码                                                                         | —                                                                                                                 | 死代码                                                                                                                                                                       | `[读码]`                                                                                                              | ✅                              |
| 20  | `packages/pipeline/src/asr/whisperServer.ts:220-231`                                                                                            | 与 #2/#3 同构                                                                                                                                     | 正常                                                                                                              | 只杀直接子进程；SIGTERM 即硬杀                                                                                                                                               | `[读码]`                                                                                                              | ❌ 真机                         |
| 21  | `apps/daemon/src/bootstrap/tls.ts:108`                                                                                                          | `execFileSync('openssl', …)` 生成自签证书                                                                                                         | macOS 自带 LibreSSL，`req -x509` 应可用 `[推测]`                                                                  | **Windows 默认没有 openssl** → `TlsUnavailableError`（`:120-127` 明确拒绝静默降级）→ `OPENMEMO_TLS=self-signed` 起不来 → **局域网访问下 F3 录音（需 secure context）不可用** | `[读码]`                                                                                                              | ❌ 真机                         |
| 22  | `apps/daemon/src/bootstrap/tls.ts:62`                                                                                                           | `openssl x509 -enddate` 判有效期，失败即 false → 每次启动重签                                                                                     | 正常                                                                                                              | 无 openssl → 恒 false → 走 #21                                                                                                                                               | `[读码]`                                                                                                              | ❌                              |
| 23  | `bootstrap/single-instance.ts:244`、`config/paths.ts:65`、`bootstrap/tls.ts:104,132` 的 `{mode:0o600}`                                          | POSIX 权限位在 Windows 上被 Node 忽略（只有只读位）                                                                                               | 生效                                                                                                              | **`runtime.json`（含 token）、`datadir.json`、`tls-key.pem` 对本机所有用户可读**，且无 ACL 回退                                                                              | `[推测]`，依据 Node `fs` 文档                                                                                         | ❌ 真机                         |
| 24  | `packages/runtime/src/detect/system.ts:176`、`detect/gpu.ts:295`                                                                                | `run('powershell'/'sysctl'/'nvidia-smi'/'system_profiler', …)` **全是裸命令名走 PATH** —— 与 `tools.ts:4-8`「绝不 PATH 查找」的纪律相反           | `/usr/bin` 里有，能跑；PATH 劫持面存在                                                                            | `powershell.exe` 走 CreateProcess 搜索链（含当前目录），有劫持面                                                                                                             | `[读码]`（两文件头都自陈 UNVERIFIED）                                                                                 | ❌ 真机                         |
| 25  | `packages/runtime/src/detect/gpu.ts:83,268`                                                                                                     | `split('\n')` 面对 Windows 的 `\r\n`                                                                                                              | —                                                                                                                 | ✅ **恰好安全**：`:84` 的 `.map(s=>s.trim())` 削掉了残留 `\r`                                                                                                                | `[读码]`（逐字段确认 trim 覆盖了最后一列）                                                                            | ✅ 可用假 stdout 验             |
| 26  | `apps/daemon/src/storage/migrateAssets.ts:93`                                                                                                   | 对**文件系统路径**硬编码 `split('/')`                                                                                                             | 正常                                                                                                              | `C:\dd\tmp\job\a.wav`.split('/') 只有 1 段 → `matchBySuffix` 永远匹配不上 → **资产迁移静默失效**                                                                             | `[读码]`（同文件 `:111,113` 用了 `split(sep)` —— 作者知道，漏了这处）                                                 | ✅ 可用 `path.win32` 复刻       |
| 27  | `packages/db/src/pragmas.ts:25`                                                                                                                 | ✅ Windows 上刻意关 mmap（避免文件占用锁死）                                                                                                      | 开                                                                                                                | 关 —— 正确                                                                                                                                                                   | `[读码]`                                                                                                              | ✅                              |
| 28  | `packages/pipeline/src/subprocess/runner.ts:169-180`                                                                                            | 硬编码 `/usr/bin/nice`，但有 `existsSync` 守卫                                                                                                    | 有，生效                                                                                                          | `platform!=='win32'` 直接跳过 —— 正确（`:166` 注明无等价物）                                                                                                                 | `[读码]`                                                                                                              | ✅                              |
| 29  | `packages/pipeline/src/subprocess/runner.ts:92-94`                                                                                              | env 白名单分平台（win32: `SystemRoot/windir/TEMP/TMP/COMSPEC/PATHEXT`；否则 `HOME/TMPDIR/LANG/LC_ALL/TZ`），且刻意排除 `DYLD_INSERT_LIBRARIES`    | ✅ 覆盖                                                                                                           | ✅ 覆盖                                                                                                                                                                      | `[读码]`                                                                                                              | ✅                              |
| 30  | `scripts/check-tracked-sources.mjs:37`                                                                                                          | POSIX `find`                                                                                                                                      | 正常                                                                                                              | `FIND.exe` 语义不同 → `pnpm check` 挂                                                                                                                                        | `[读码]`+`[推测]`                                                                                                     | ⚠️ Windows 侧须真机             |
| 31  | `scripts/license-report.mjs:119`                                                                                                                | `execFileSync('pnpm', …)`                                                                                                                         | 正常                                                                                                              | `.cmd` 不带 `shell:true` 被 Node 拒绝                                                                                                                                        | `[推测]`，依据本仓 `argGuard.ts:266-273`                                                                              | ❌ 真机                         |
| 32  | `apps/web/package.json` `test:unit`                                                                                                             | `node -e` 里反斜杠转义引号                                                                                                                        | sh 正常                                                                                                           | cmd.exe 不做 `\"` 转义 → 参数被撕碎                                                                                                                                          | `[读码]`                                                                                                              | ❌ 真机                         |
| 33  | `.github/workflows/`（**只有 `build-backends.yml`**）                                                                                           | 三平台**构建**矩阵齐全，但**没有任何 job 跑 `tsc` / `eslint` / `pnpm test`**                                                                      | 后端包能编出来，TS 侧一行没跑过                                                                                   | 同                                                                                                                                                                           | `[实测]` `ls .github/workflows/`                                                                                      | ✅ 已验                         |
| 34  | `apps/daemon/src/bootstrap/single-instance.ts:87-103,320`                                                                                       | ✅ 主锁 = TCP 端口绑定（不是 Unix socket / named pipe）；副锁 = `openSync(path,'wx')`，`:281` 明写「选 O_EXCL 不选 flock，因为 Windows 语义一致」 | 正常                                                                                                              | 正常 —— **设计上就是跨平台的**                                                                                                                                               | `[读码]`                                                                                                              | ✅                              |
| 35  | `apps/daemon/src/bootstrap/single-instance.ts:299-307`                                                                                          | `process.kill(pid, 0)` 探活，EPERM 视为存活                                                                                                       | 正常                                                                                                              | Node 在 Windows 上支持 signal 0；EPERM 语义也对                                                                                                                              | `[推测]`，依据 Node `process.kill` 文档                                                                               | ❌ 真机确认                     |
| 36  | `apps/daemon/src/http/static.ts:78-83`                                                                                                          | 静态文件穿越防护                                                                                                                                  | 安全                                                                                                              | ✅ **实测安全**：`/C:/Windows/win.ini`、`//server/share/x`、`/..%5C..%5Cwin.ini` 全被 `normalize`+`join` 收进 root                                                           | `[实测]` 用 `path.win32` 复刻                                                                                         | ✅ 已验                         |
| 37  | `apps/daemon/src/main.ts:22`、`packages/db/src/extensions.ts:38`、`packages/runtime/src/selfcheck.ts:258`、`packages/pipeline/src/tools.ts:257` | `libSuffix()`（`.dll/.dylib/.so`）**同一份逻辑复制了 4 份**                                                                                       | 四处一致                                                                                                          | 四处一致                                                                                                                                                                     | `[实测]` 逐一比对                                                                                                     | ✅                              |
| 38  | `apps/daemon/src/runtime/setup.ts:70` vs `http/rest/selfcheck.ts:94`                                                                            | `.exe` 后缀处处一致**没漏**；但**二进制名字对不上**（`probe` vs `openmemo-probe`）                                                                | 与平台无关，两条路径找不同的文件                                                                                  | 同                                                                                                                                                                           | `[实测 grep]`                                                                                                         | ✅ 已验                         |
| 39  | `packages/pipeline/src/tools.ts:346`                                                                                                            | ✅ `discoverTools` 统一加 `.exe`，`findInBackendPacks` 收到带后缀的名字                                                                           | 正常                                                                                                              | 正常；`ytdlpInstall.test.ts:95-103` 有 Windows 包名用例                                                                                                                      | `[读码]`                                                                                                              | ✅                              |
| 40  | `packages/downloader/src/installer.ts:240-247`                                                                                                  | `rm(finalDir) → mkdir → rename` 原子替换，**无 EBUSY/EPERM 重试**                                                                                 | 正常                                                                                                              | 目标目录有文件被占用（whisper-cli 在跑 / Defender 在扫）→ EBUSY/EPERM → 整包安装失败                                                                                         | `[读码]`（全仓 `grep EBUSY` 只命中 `move.ts:516` 的注释，无任何重试代码）                                             | ❌ 真机                         |
| 41  | `packages/downloader/src/store.ts:249-251`                                                                                                      | manifest 原子写，同样无重试                                                                                                                       | 正常                                                                                                              | 同 #40                                                                                                                                                                       | `[读码]`                                                                                                              | ❌                              |
| 42  | `packages/downloader/src/store.ts:355`                                                                                                          | ✅ `rel.split(path.sep).join('/')` —— 记录一律存 POSIX 分隔符                                                                                     | 正常                                                                                                              | 正确                                                                                                                                                                         | `[实测]` `path.win32.resolve` 往返验过                                                                                | ✅ 已验                         |
| 43  | `packages/downloader/src/store.ts:63`                                                                                                           | ✅ `defaultModelsRoot(platform = process.platform)` —— **平台是入参**                                                                             | ✅                                                                                                                | ✅                                                                                                                                                                           | `[实测]` 三平台根目录都算得出                                                                                         | ✅ **这是全仓唯一的正确范式**   |
| 44  | `apps/daemon/src/config/paths.ts:26-37`、`packages/pipeline/src/tools.ts:90-108`                                                                | 同样的三平台根目录推导，**这两处不接 platform 参数**，只读 `process.platform`                                                                     | 分支不可达                                                                                                        | 分支不可达                                                                                                                                                                   | `[读码]`（同一件事有 parameterized 与非 parameterized 两种写法并存）                                                  | ⚠️ 只能 mock                    |
| 45  | `APPDATA`(3) / `XDG_DATA_HOME`(3) / `homedir()`(3)                                                                                              | ✅ **`LOCALAPPDATA` / `USERPROFILE` 全仓 0 命中** —— Roaming/Local 分叉已修，`tools.ts:78-88`、`store.ts:69-75` 都留了事故记录                    | ✅ 一致                                                                                                           | ✅ 四处全部用 `APPDATA`，回退都是 `join(home,'AppData','Roaming')`                                                                                                           | `[实测]` grep 全量枚举                                                                                                | ✅ 已验                         |
| 46  | `apps/daemon/src/ws/recorder.ts:270`                                                                                                            | 往 `media_assets.rel_path` 写**绝对路径**（`:132`）—— 这是 #7 的触发条件来源                                                                      | dataDir 拼法一变，已有录音全部 403                                                                                | 同，NTFS 下更容易发生                                                                                                                                                        | `[读码]` + `[实测]`（#7 的 vfat 实验用的就是这条形态）                                                                | ✅ 后果已验                     |
| 47  | `packages/pipeline/src/subprocess/runner.ts:289`                                                                                                | ✅ `pending.split(/\r\n                                                                                                                           | \r                                                                                                                | \n/)`（`:288`注明 ffmpeg 用`\r` 报进度）                                                                                                                                     | 正常                                                                                                                  | 正常                            | `[读码]` | ✅  |
| 48  | `packages/runtime/src/detect/system.ts:97-118`                                                                                                  | `/proc/cpuinfo` 是 Linux-only，但被 `switch (os.platform())` 正确分派                                                                             | 走 `sysctl`                                                                                                       | 走 powershell，`features: []`（`:171` 明说宁可空也不猜）                                                                                                                     | `[读码]`                                                                                                              | ✅ 分派逻辑可验                 |
| 49  | `eslint.config.js:64-104`                                                                                                                       | D-06 §8 要求「`no-restricted-imports` 禁止全仓 import `node:child_process`」→ **只配了 web feature 边界，没配 child_process**                     | —                                                                                                                 | —                                                                                                                                                                            | `[实测]` 三处 restricted 全是 `apps/web` 规则                                                                         | ✅ 已验                         |

## 3.2 分支可达性统计（`[实测]`）

源码（`apps/*/src` + `packages/*/src`，排除测试）共 **42 处**平台/架构分支：

| 目标                |               命中数 | 本机（linux/x64）可达 |
| ------------------- | -------------------: | --------------------- |
| `win32`             |                   26 | ❌ 全部不可达         |
| `darwin`            |                    9 | ❌ 全部不可达         |
| `linux` / else 兜底 | 3 + 各三元的 else 支 | ✅                    |
| `arm64`             |                    4 | ❌（本机 x64）        |

**34 / 42（81%）的分支在本机永远走不到**，而 CI 里也没有任何一个 job 跑 TS 测试（#33）。
→ **这 34 条分支从写下来那天起，没有任何自动化执行过它们中的任何一条。**

只有 **1 处**（`store.ts:63`）把平台做成了参数，因而是**唯一**能在 Linux 上直接测三平台的。

## 3.3 「本机能验的」vs「必须真机」

**本机能验（12 类，不需要 mac/Windows）**：

1. `isSafeExecutable` 全部平台形态（#6）—— **已是入参，这就是可复制的正确范式**
2. `assertWithinRoot` 的 UNC / 盘符相对路径（#4/#5）—— 把 platform 提成入参即可全测；
   **当前测不了的唯一原因就是它硬读 `process.platform`**
3. 大小写不敏感 FS 上的路径解析（#7）—— `mkfs.vfat` + loop mount，**已跑通**
4. `import.meta.url` 入口守卫（#1）—— 纯函数，且**在 Linux 上就已经是 bug**
5. 静态文件穿越在 win32 语义下的行为（#36）—— `path.win32` 复刻，已验安全
6. 分隔符往返（#42）、`defaultModelsRoot` 三平台（#43）—— 已验
7. `migrateAssets.matchBySuffix` 的 `split('/')`（#26）—— 纯函数，复刻 win32 输入即可证伪
8. env 白名单分平台内容（#29）、`libSuffix()` 四处一致性（#37）、probe 命名不一致（#38）
9. nvidia-smi `\r\n` 解析（#25）—— 喂一段带 `\r\n` 的假 stdout
10. `assetPaths` 的软链逃逸（#9）—— 已验，与平台无关
11. CI 缺 TS 测试矩阵（#33）—— 已验
12. `unpack.ts` 的 EPERM→copy 回退（#14）—— 可注入错误验

**必须真机（10 类）**：

1. Windows 进程树回收（#2/#3/#20）—— taskkill 从未实现
2. macOS quarantine / Gatekeeper / hardened runtime（#11/#18）—— **R-02 标注的全项目最高风险假设**
3. Windows symlink 特权（#13）
4. Windows 文件占用 EBUSY/EPERM（#40/#41）—— 本机 ext4 复现不出来
5. Windows 上 `.cmd` spawn（#31）、cmd.exe 引号转义（#32）、`FIND.exe`（#30）
6. openssl 可用性（#21/#22）
7. POSIX 权限位在 Windows 上被忽略（#23）—— token 文件实际 ACL
8. 孤儿进程回收在 mac/Win 的替代实现（#17）—— 目前是空洞
9. `powershell` / `sysctl` / `system_profiler` / `nvidia-smi` 的真实输出格式（#24）——
   两个 detect 文件头都自陈 UNVERIFIED，解析代码是照文档写的，**一行真实输出都没见过**
10. Windows DLL 搜索路径（#18）

**查不到的（不做推断）**：`verbatimSymlinks` 在 Windows 上的确切 errno；
`fs.link` 在 ReFS / 网络盘上的行为；macOS APFS 大小写敏感卷（可选开启）下 #7 是否消失。

---

# §4 CI workflow 通读结果（**只读，未改一个字**）

对象：`.github/workflows/build-backends.yml`（**全仓唯一的 workflow**）。
前提按指令**假设它从来没跑过** —— `git remote -v` 空 `[实测]`，`on:` 只有 `workflow_dispatch`。

## 4.1 会造成实际损坏的（3 条）

| #      | 位置                                                                                                                          | 问题                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------ | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **C1** | `:346-366` `merge-manifest`                                                                                                   | **它把 `vendor/manifests/backends.json` 整份覆盖**为只含本次构建 fragment 的新文件。现有 **15 个上游直连包**（yt-dlp ×4、ffmpeg、llama.cpp ×7、whisper ×3）**全部消失**。这个 job 写于 ADR-015（上游优先）之前，**没有人回来改它**                                                                                                                                                                                                                                       |
| **C2** | `scripts/build-whisper.sh:295-334` 吐出的 fragment vs `packages/shared/src/schemas.ts:349` `BackendPackSchema`（`.strict()`） | **结构不兼容**。缺 8 个必填：`displayName`/`displayNameZh`/`totalSizeBytes`/`requiresDriver`/`license`/`providesFiles`/`priority`/`catalogVersion`；多 4 个未声明：`engineCommit`/`buildHost`/`builtAt`/`archive`（`.strict()` 会直接拒）；`files[]` 缺 `ArtifactFileSchema` 的 `role`/`mirrors`。**而且整个 fragment 里没有任何 URL** → 就算字段补齐，`BackendManifestSchema` 的 `superRefine` 也会报 `pack X is 'published' but has no mirror URL`（`schemas.ts:396`） |
| **C3** | `:356-363` 合并出的顶层对象                                                                                                   | 只有 `schemaVersion`/`generatedAt`/`packs`，**漏了 `catalogVersion`**（`BackendManifestSchema` 必填且 `.strict()`）→ `validateBackendManifest` 必失败 → **daemon 加载不了后端目录**（`packages/downloader/src/manifest.ts:169` 是唯一入口）`[读码]`                                                                                                                                                                                                                      |

**C1+C2+C3 合起来的意思**：这个 workflow 跑成功一次，产出的 `backends.json`
既**丢了全部现有条目**，又**通不过 schema**。

## 4.2 会静默变绿的（2 条 —— 假绿灯家族）

| #      | 位置                                   | 问题                                                                                                                                                                                                                                                                                                                   |
| ------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C4** | `:331` `if: always()`                  | 三个构建 job 全失败时，`merge-manifest` 照样跑，`packs` 为空数组 → 写出一个 **`packs: []` 的 backends.json** 并 `upload-artifact` 成功。**整个 workflow 绿灯，产物是空的**                                                                                                                                             |
| **C5** | `:114-120` 「Verify ad-hoc signature」 | `for f in .build/whisper-darwin-*/stage/*/*` + `[ -f "$f" ] \|\| continue`。glob 不匹配时 bash 留下字面量 → 全部 `continue` → **步骤零文件检查、绿灯通过**。（我核对过 `build-whisper.sh:223` 的 `STAGE="${BUILD_DIR}/stage/${PACK_ID}"`，**路径形状是对得上的** —— 但这条防线的失败模式是「静默通过」而不是「报错」） |

## 4.3 很可能一跑就断的（3 条）

| #      | 位置                                                     | 问题                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **C6** | `:279-280` `choco install ninja -y`                      | `build-whisper.sh` 全文**没有 `-G Ninja`** `[实测 grep]` → 装了不用。CMake 在有 VS 的 Windows 上默认用 Visual Studio 生成器（多配置）                                                                                                                                                                                                                                                                              |
| **C7** | `:311-313` Windows 的 Build probe                        | 硬编码 `.build/whisper-win32-<arch>-cpu/bin`。而 `build-whisper.sh:196-198` 自己会在 `${BUILD_DIR}/bin` 与 `${BUILD_DIR}/Release/bin` 之间探测 —— **VS 多配置生成器实际会输出到 `bin/Release`**（whisper.cpp 的 CMake 设 `CMAKE_RUNTIME_OUTPUT_DIRECTORY=${CMAKE_BINARY_DIR}/bin`，多配置下追加配置子目录）→ **脚本的两个候选和 workflow 的硬编码路径可能都落空** `[读码+推测，依据 CMake 多配置生成器的输出布局]` |
| **C8** | `build-whisper.sh:137` `-DCMAKE_INSTALL_RPATH='$ORIGIN'` | `$ORIGIN` 是 **ELF/Linux** 的概念，**macOS 的 dyld 用 `@loader_path` / `@executable_path`**。这个 flag 对 darwin 无效 → 「pack 完全可重定位」这条性质（D-04:331）**在 macOS 上不成立**。对照组：`scripts/build-probe.sh:72-74` **就分了平台**（`linux` 用 `$ORIGIN`，`darwin` 用 `@executable_path`）—— 两个脚本里只有一个做对了 `[读码]`                                                                          |

## 4.4 会产生对不上的产物（2 条）

| #       | 问题                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C9**  | **pack id 命名与手写 manifest 不一致**。`build-whisper.sh:183` `PACK_ID="whispercpp-${BACKEND}-${HOST_OS}-${HOST_ARCH}"`，`HOST_OS` 取值 `linux/darwin/win32`（`:103-105`）→ CI 会产出 `whispercpp-cpu-win32-x64` / `whispercpp-metal-darwin-arm64`；**手写 manifest 用的是 `whispercpp-cpu-win-x64` / `llamacpp-metal-macos-arm64`（`win` / `macos`）**。合并后会出现同一个包两个 id `[实测：逐个对比 id]` |
| **C10** | **probe 产物名与 daemon 找的名字不一致**（§2.6）。workflow `:105,227,313` 产出 `dist/probe/openmemo-probe`，`apps/daemon/src/runtime/setup.ts:70` 找的是 `probe`                                                                                                                                                                                                                                            |

## 4.5 结构性缺失（1 条，最重要的一条）

| #       | 问题                                                                                                                                                                                                                |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C11** | **没有任何 CI 跑 `tsc -b` / `eslint` / `pnpm test`。** 唯一的 workflow 只做二进制构建。`debt-audit` C4 已列（「123 个提交，零自动门禁」）。→ **§3.2 那 34 条非 Linux 分支，从写下来那天起就没有任何自动化碰过它们** |

## 4.6 核对过、**没有问题**的

- **runner label 全部有效** `[实测：拉 `actions/runner-images` 的 README 逐个比对]`：
  `macos-26`(arm64) ✅、`macos-15-intel`(x64) ✅、`ubuntu-22.04` ✅、`ubuntu-24.04-arm` ✅、
  `windows-2025` ✅、`windows-2022` ✅。`macos-13` 确已不在列表；`macos-14` 标着 deprecated
  ——**workflow 头部注释的那段说明是准确的**。
- **action 版本都存在** `[实测：查各仓库最新 release tag]`：
  `actions/checkout@v6`（latest v7.0.1）、`upload-artifact@v6`（latest v7.0.1）、
  `download-artifact@v7`（latest v8.0.1）、`setup-node@v6`（latest v7.0.0）、
  `ggml-org/ccache-action@v1.2.21`（该 tag 真实存在，是 `hendrikmuhs/ccache-action` 的 fork）、
  `jlumbroso/free-disk-space@v1.3.1` ✅、`Jimver/cuda-toolkit@v0.2.35`（latest v0.2.36）✅、
  `jakoch/install-vulkan-sdk-action@v1.6.0` ✅。
- `build-whisper.sh` 里 `stat -c%s`/`stat -f%z`、`sha256sum`/`shasum -a 256`、`zip`/`7z`
  **都有 BSD/GNU 双分支**，这部分写得是对的。
- Windows job 的 `git checkout` 步骤带了 `shell: bash` ✅。

## 4.7 「一旦有远端就能跑」需要什么（**我没有改，这是清单**）

按依赖顺序：

1. 修 **C2/C3**（fragment 结构 + 顶层 `catalogVersion`）—— 否则产出的东西没人能用；
2. 修 **C1**（改成**合并进**现有 `backends.json` 而不是覆盖，按 id 做 upsert）；
3. 去掉 **C4** 的 `if: always()`，或在 merge 前断言 `packs.length > 0`；
4. 统一 **C9** 的 id 命名（`win`/`macos` 还是 `win32`/`darwin`，选一个，写进 schema 或守卫）；
5. 修 **C10** 的 probe 名字（改 `setup.ts:70`，一行）；
6. Windows 路径 **C6/C7**：显式 `-G Ninja`，或让 workflow 从脚本拿输出路径而不是硬编码；
7. macOS rpath **C8**：把 `build-probe.sh` 的分平台写法搬到 `build-whisper.sh`；
8. **补一个 `ci.yml`**（**C11**）跑 `pnpm build:safe && tsc -b && eslint . && pnpm -r test`
   —— 这条**不需要构建二进制，是投入产出比最高的一个**；
9. 最后才是 `permissions` 收窄、加 `concurrency` 之类的卫生项。

**运行它还需要（与代码无关）**：一个 git remote + 一次 push；
若仓库私有，macOS runner 按 10× 计费 `[推测，依据 GitHub 计费惯例，我没有核实当前费率]`。
**这些都是用户的决定，本轮未做任何相关动作。**

---

# §5 ★ 要真正支持 mac / Windows，还缺什么

> 这一节是给排期用的。分成「不需要真机 / 不需要远端就能做的」和「必须有机器的」两半。

## 5.1 第一梯队：**不需要 Mac、不需要 Windows、不需要远端**（纯 manifest + 纯函数）

| #         | 事项                                                                                            | 拿什么补                                                 | 影响的行                                                        | 成本                                  |
| --------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------- |
| **P1-1**  | **ffmpeg win64**                                                                                | BtbN 同一个已钉 tag 的 `win64-gpl-7.1.zip` `[上游 API]`  | 章程第 3/4/5a 行 —— **三行同时解锁**                            | XS                                    |
| **P1-2**  | **ffmpeg linux-arm64 / win-arm64**                                                              | 同上 tag 的另两个资产                                    | 附加行 8                                                        | XS                                    |
| **P1-3**  | **yt-dlp macOS Intel**                                                                          | 同一个 `yt-dlp_macos`（universal2）再挂一条 `arch:"x64"` | 第 2 行                                                         | XS                                    |
| **P1-4**  | **whisper Linux arm64**                                                                         | `whisper-bin-ubuntu-arm64.tar.gz` `[上游 API]`           | 附加行 8                                                        | XS                                    |
| **P1-5**  | **`components.json` 补齐 20 条**                                                                | 现有 pack 的 provenance 照抄                             | **全部非 Linux 行的来源/许可证可追溯性**                        | S                                     |
| **P1-6**  | **加一条反向守卫**：`backends.json`/`sqlite-ext.json` 里每个包都必须在 `components.json` 有条目 | 照 `ytdlpInstall.test.ts` 已有那条的写法反过来           | 防 P1-5 再次腐烂                                                | XS                                    |
| **P1-7**  | **修 probe 名字**（`setup.ts:70` → `openmemo-probe`）                                           | —                                                        | **所有平台的 L2 加速包安装**                                    | XS                                    |
| **P1-8**  | **`assertWithinRoot` 加 platform 入参 + 补 UNC/盘符用例**                                       | 照抄 `isSafeExecutable`                                  | 安全边界，**本机可完整验证**                                    | XS                                    |
| **P1-9**  | **`main.ts:1075` 改用 `pathToFileURL()`**                                                       | —                                                        | Windows 上「daemon 启动即静默退出」；Linux 上路径含空格同样中招 | XS                                    |
| **P1-10** | **`migrateAssets.ts:93` 改 `split(sep)`**                                                       | 同文件 `:111` 已有正确写法                               | Windows 资产迁移                                                | XS                                    |
| **P1-11** | **`build-whisper.sh` 的 rpath 分平台**                                                          | 照抄 `build-probe.sh:72-74`                              | macOS 包可重定位性                                              | XS                                    |
| **P1-12** | **补 `ci.yml` 跑 TS 门禁**（§4.7-8）                                                            | —                                                        | §3.2 那 34 条分支第一次有东西碰它们                             | S（需远端才能真跑，但文件可以先写好） |

> ⚠️ P1-1～P1-4 落地前**必须重新拉一次上游资产清单** —— 本文件里的 sha256 全是
> `[上游 API]`，我没有下载任何一个文件复算，而且上游随时可能发新版。
> 建议照 `ytdlp-install` 的做法：**至少与上游自己的 checksums 文件二次比对**再写。

## 5.2 第二梯队：**macOS 的 whisper —— 不需要远端，但需要一台 Mac**

上游永远不会给（v1.9.1 至今没有，`whisper.cpp` 的 release workflow 也不产）。三步：

1. **在一台 Mac 上跑 `scripts/build-whisper.sh --backend metal`**（脚本现成，ADR-015 特意保留）。
   先修 P1-11 的 rpath，否则包不可重定位。
2. **投递**：`packages/shared/src/schemas.ts:73` 的 `LOOPBACK_HOSTS` 与 `:87` 的
   `if (protocol === 'http:' && isLoopback) return` **已经允许 `http://127.0.0.1:<port>/…`** `[读码]`。
   → **今天就能用**：在那台 Mac 上起任意静态 HTTP 服务，manifest 条目填 `http://127.0.0.1:PORT/...`
   （`provider` 用 `custom`），走**完全相同**的下载/续传/sha256/解包/安装路径。
   **不需要 GitHub、不需要远端、不需要改允许名单。**
   ⚠️ 但注意：`schemas.ts:60` 提到的「daemon 自己serve `<dataDir>/local-artifacts/**`」
   **只存在于那条注释里** —— 全仓 `grep local-artifacts` 只有这 1 处命中 `[实测]`。
   所以要么自己起个服务器，要么把那条路由补上。
3. **CoreML**：`build-whisper.sh:170` 的 coreml 分支自陈 UNVERIFIED，且需要 coremltools
   生成 per-model `.mlmodelc` —— 而章程要求 2.1 禁止让用户跑 Python。
   目录里那 2 条 CoreML encoder（§1.3-2）**在此之前都是死条目**。

**替代方案（如果不想碰 Mac 构建）**：走 sherpa-onnx/paraformer（§2.5）。
中文可用、ONNX 与平台无关、npm 已有 darwin 包。
**但英文没有替代品**（`selectEngine.ts` 的注释明写「English: whisper is the only engine we ship that handles it well」），
**且仍然需要先解决 macOS 的 ffmpeg（P1 那条换源）。**

## 5.3 第三梯队：**必须有真机才能确认的（10 类，§3.3 已列）**

按「撞上概率 × 后果」排序，我建议这个顺序：

| 顺序 | 事项                                                                | 为什么排这里                                                                             |
| ---- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1    | **Windows：daemon 到底能不能启动**（#1 入口守卫）                   | 如果这条真的中了，**后面全部无从谈起** —— 而且它是纯函数 bug，P1-9 修完再验              |
| 2    | **macOS：quarantine / ad-hoc 签名 / library validation**（#11/#18） | R-02 自己标注的**全项目最高风险假设**，而兜底代码不存在。D-04:505 估「一台 Mac 30 分钟」 |
| 3    | **Windows：openssl 缺失 → TLS 起不来**（#21）                       | 直接决定局域网访问下 F3 录音（需 secure context）能不能用                                |
| 4    | **Windows：进程树回收**（#2/#3）                                    | 转写取消/超时后 ffmpeg 留活，用户会看到「CPU 一直满」                                    |
| 5    | **Windows：文件占用 EBUSY**（#40/#41）                              | Defender 扫描期间装包失败，且**没有重试**                                                |
| 6    | **Windows：symlink 特权 → 数据搬迁**（#13）                         | 唯一没有回退的链接路径                                                                   |
| 7    | **两个 detect 文件的真实输出格式**（#24）                           | powershell / system_profiler 的解析代码**一行真实输出都没见过**                          |
| 8    | **Windows：POSIX 权限位被忽略 → token 文件谁都能读**（#23）         | 安全，但需要真机才能看到实际 ACL                                                         |
| 9    | **孤儿进程回收在 mac/Win 是空洞**（#17）                            | 强杀 daemon 后子进程继续跑                                                               |
| 10   | **构建/检查脚本在 Windows 上的可用性**（#30/#31/#32）               | 只影响开发者，不影响用户                                                                 |

## 5.4 一句话结论（给决策用）

- **Windows**：**离「能用」最近的一行**。缺的是 **1 条 ffmpeg manifest** + **1 行 probe 改名** +
  **1 行入口守卫**，剩下的是真机验证。**不需要 Mac，不需要远端。**
- **macOS**：**缺一个上游根本不提供的东西**（whisper CLI）。要么找一台 Mac 编一次
  （投递通道 schema 上已经通了），要么接受「macOS 只支持中文 paraformer」。
  且 macOS 的 ffmpeg 要**换一个上游**（版本会与其它平台不一致，必须写进 provenance）。
- **两者共同的前置**：`components.json` 的 20 条空白、probe 命名、以及 §3.2 那
  **34 条从来没被任何东西执行过的平台分支** —— 后者的解法是 §4.7-8 的 `ci.yml`，
  以及把 `store.ts:63` 那种「平台作为入参」的写法推广开（现在全仓只有 1 处这么写）。

---

# §6 我做了什么 / 没做什么

**做了**：读 manifest / 读码 / 拉上游 API 与 README / 本机纯函数与文件系统实验 / 通读 workflow。
**没做**（按收缩指令）：没改 manifest、没动 `packages/downloader`、没改 `.github/`、
没 commit、没 `git add`、没有任何 `git push` / `git remote add` / 建仓动作。

**纪律**：`:10000` 只发过 GET；`/root/data-memo` 一个字节没碰；`datadir.json` 没读没写；
没跑 `pnpm -r build`（本轮不需要构建）；没用 `pkill -f`；没跑本地 whisper 转写。

**基线未变**：本轮不改代码，`tsc -b` 0 / `eslint` 0 / 614 passed 应当原样保持
（**我没有重跑门禁** —— 因为没有任何改动需要验证，重跑只会消耗共享机器的 CPU。如需我复跑请说）。

**下一步建议**：

1. §5.1 那 12 条第一梯队随时可以派人做，**全部不需要 mac/Windows/远端**，
   其中 P1-1（ffmpeg win64）单条就解锁章程三行。
2. §4.7 的 CI 清单**先修文件、不推远端** —— 一旦用户改主意，就是 push 一次的事。
3. §5.3 第 1、2 两条是「有机器就先做这两个」的答案。

**需要 Manager 决策**：

- ① 第一梯队要不要现在插队？（用户说「Linux 债优先」，但 P1-7/P1-9/P1-10 三条
  **在 Linux 上就是活的 bug**，严格说属于 Linux 债而不是跨平台工作。）
- ② `assetPaths.ts:83` 的**软链逃逸**（§3.0-② 末尾）与平台无关，**今天在 Linux 上就能利用**
  —— 建议单开一个安全任务，不要等跨平台排期。
- ③ macOS 路线选哪条：找一台 Mac 编 whisper（§5.2）还是接受「mac 只有中文 paraformer」。
