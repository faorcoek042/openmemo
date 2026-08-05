# inbox / pack-publish

## [2026-08-06 03:20] T-146 PROGRESS

交付:
- `vendor/manifests/backends.json`（+2 个 ffmpeg 包）
- `vendor/manifests/components.json`（+16 条来源/许可证条目，把**反方向**的洞补齐）
- `apps/daemon/src/pipeline/platformPacks.test.ts`（**新增**，9 条守卫）
- `packages/runtime/src/selfcheck.ts` + `index.ts`（新自检项 `asr.coreml` + 导出 `coreMlEncoderNameFor`）
- `scripts/build-whisper.sh`（macOS 核心包带 CoreML；坏掉的 `coreml` 分支改成当场 die）
- `scripts/ci/cold-start-audit.mjs` + `.github/workflows/cold-start-audit.yml`（`--transcribe` 可行性证明）
- 提交 `2075a88`，已 push

**未碰**：`/root/data-memo`（一个字节没读没写）、`~/.local/share/openmemo/datadir.json`、
`:10000`（一次请求都没发）、`apps/web/dist`（构建全程 `pnpm build:safe`）。
**没有建 release、没有改仓库可见性、没有改分支保护、没有 `pkill -f`、没有 `git add -A`**
（`git status` 里 4 个文件是别人的在途改动，逐个避开了，见 §8）。

---

# TL;DR

## ★ 一张表回答用户的问题（这就是你要拿给他看的那张）

「各个系统都是通过网页去调用再自下载各种依赖吗」—— **机制是真的。今天之前覆盖只有 Linux；现在 Windows 也齐了，macOS 差最后一步。**

| 平台 | ffmpeg / ffprobe | 转写引擎 (whisper.cpp) | ANE / GPU 加速 | yt-dlp | 中文检索 | **这台机器能转写吗** |
|---|---|---|---|---|---|---|
| **Linux x64** | ✅ BtbN 7.1.5<br>`[本机+CI 实测]` | ✅ 上游 v1.9.1<br>`[本机+CI 实测]` | CUDA/Vulkan **已编出、待发布**（§1） | ✅ | ✅ `[CI 实测]` | ✅ **能**（唯一一路走通过的） |
| **Windows x64** | ✅ **本次补上**<br>BtbN 同一个已钉 tag | ✅ 上游 v1.9.1（cpu / cuda 12.4） | CUDA 已有；Vulkan **已编出、待发布** | ✅ | 🔴 libsimple 装了不加载<br>（`ci-runner` CI 实测，产品 bug） | 🟡 **理论齐了，等 CI 实跑判定**（§5） |
| **macOS arm64** | ✅ **本次补上**<br>jellyfin 7.1.4-3 | 🔴 **差最后一步**：CI 已经编出来了，**等你批 release 才有下载地址**（§1） | Metal 已编出；**ANE 本次接通到构建层**（§3） | ✅ | ✅ `[CI 实测]` | 🔴 **还不能** —— 卡在 whisper 没有发布地址 |
| linux-arm64 / macos-x64 / linux-x64-rocm | — | — | — | — | — | **用户 2026-08-05 明确不需要，没补** |

**证据口径**：`[本机实测]` = 我在这台 Linux x64 上跑过；`[CI 实测]` = GitHub runner 上跑过；
其余一律标出来源。**本机只有 Linux x64，非 Linux 的行为结论我一条都不声称"已验证"。**

## 三条最值得你先看的

**① macOS ffmpeg：我否掉了 `platform` 建议的那个源，理由是查出来的**

`platform` T-141 §2.2 推荐 `eugeneware/ffmpeg-static`。顺着它的构建脚本查到源头：

```
# eugeneware/ffmpeg-static @ b6.1.1 · download-binaries/index.sh
echo 'darwin arm64'
echo '  downloading from osxexperts.net'
download 'https://www.osxexperts.net/ffmpeg6arm.zip' ffmpeg-darwin-arm64.zip
```

**一个没有版本号、会被原地覆盖的 URL，全程零校验和。** 把信任接到那上面，
等于把我们在别处费劲做的「钉 tag + sha256」整个作废。而且是 ffmpeg 6.1.1，
与 Linux 侧的 7.1.5 差一个大版本。

evermeet.cx 也出局，官网原话（我实测抓的页面）：
> "I do not plan to provide native ffmpeg binaries for Apple Silicon ARM."

改用 **`jellyfin/jellyfin-ffmpeg v7.1.4-3`**，核实强度见 §2。**但它是 fork 不是上游原版，
而且我没在 Mac 上跑过它 —— §2 里全部是静态分析，运行验证要等 macOS runner。**

**② CoreML/ANE：用户那半句话的方向反了，而且是上游源码级的反**

- CoreML **只接管 encoder**（`whisper.cpp:2412`；生成脚本结尾原文 `# TODO: decoder`）
- **量化模型可以配 CoreML，是上游显式支持**：`whisper.cpp:3336-3342` 拼 `.mlmodelc` 路径时
  **主动剥掉 `-qX_X` 后缀**，同一份 encoder 给该模型所有量化档位共用。
  → **"用上 ANE 就得多发一份更大的非量化模型"不成立**，不需要做那个产品决策。

**但 ANE 今天还接不通**，链路上有 **4 处独立断点**，任何一处都足以让它完全不生效
且全部静默。本轮我修了第 1 处（构建）并加了让它可见的自检项；另外 3 处要你裁（§3）。

**③ 我在 `build-whisper.sh` 里找到一段"描述了不存在事物"的代码**

`--backend coreml` 分支走的是"只拷 `libggml-<backend>` 增量包"那条路，
于是它去找 **`libggml-coreml.so` —— 那个文件永远不存在**：CoreML 编在 `libwhisper` 里
（`vendor/whisper.cpp/src/CMakeLists.txt:57-83,152-154`），
`ggml/src/` 下**没有 coreml 这个 backend 目录**。它从来没被执行过，所以从来没人发现。
与今天那个「1.4 MB、零个 ggml 后端模块、却报告成功」的 macOS 包是同一族。

---

需要 Manager 决策:
1. **release**（§1）—— 你说在去拿用户授权。**现在多一条理由等**：macOS 核心包已经改成带
   CoreML，`build-backends` 我刚重新触发（run 31037981498），跑完的产物才是要发的那一版。
2. **ANE 剩下的 3 处断点**（§3.3）—— 其中「解包多一层同名目录」是个真 bug，
   「前端从不传 `includeOptional:["coreml-encoder"]`」是 UI 改动，
   「只有 f16 条目挂了 encoder、默认推荐的 q5_0 没挂」是清单决策。三条都超出本任务。
3. **`sha256Provenance` 我给 jellyfin 那条写了很长一段免责**（fork / 未在 Mac 运行），
   要不要精简成一句、把详情留在这份回执里。

下一步建议:
1. 等 `cold-start-audit` run 31037964581 出三平台的转写可行性结论（§5）。
2. 等 `build-backends` run 31037981498 确认 macOS 带 CoreML 还编得出来（§3.1 的风险）。
3. release 批下来后我补 macOS whisper 的两条 manifest + 再跑一次 CI 收尾。

---

# §1 macOS whisper：产物已经有了，**只差一个下载地址**

## 1.1 我核过的东西（`[本机实测]`）

来源：`build-backends` **run 31030922716**，**9/9 全绿**（8 条构建腿 + merge-manifest）。
这是任务书说的"第 5 轮" —— 第 4 轮 merge-manifest 正确地拒绝写空清单，第 5 轮修完之后真的写出来了。

我把 artifact 逐个下下来**独立复算 sha256**，与 CI fragment 里声明的**逐字符一致**：

```
4b500163f5ff570abee279c363e3b61b0321e55dbe289845108d76858549b780  whispercpp-cpu-macos-arm64.tar.gz   1,838,307 B
6e07a88c2567459cacf7763563d2746d84e2d244dab055247945319b0611ea15  whispercpp-metal-macos-arm64.tar.gz   163,225 B
```

**确认它是修复后那一版**（任务书点名要确认的）—— 包内容逐个列过：

```
whispercpp-cpu-macos-arm64/whisper-cli                    773,184
whispercpp-cpu-macos-arm64/libggml-cpu.so                 811,952   ← ★ 就是它
whispercpp-cpu-macos-arm64/libggml-blas.so                 72,800
whispercpp-cpu-macos-arm64/libggml-base.0.15.1.dylib      654,272
whispercpp-cpu-macos-arm64/libwhisper.1.9.1.dylib         371,680
… 共 18 条（含 8 条 symlink）
whispercpp-metal-macos-arm64/libggml-metal.so             828,512   ← 单文件，核心包的 GPU 增量
```

不是那个 1.4 MB / 零后端模块的假绿包。`build-whisper.sh` 现在有守卫：
核心包里没有 `ggml-cpu*` 模块就当场 die（**我这次没有靠它，是真的把包解开数的**）。

## 1.2 为什么必须是 GitHub Release（可选项我都查了）

| 通道 | 判定 |
|---|---|
| Actions artifact 直链 | ✘ **有保留期**，这一批 `expires_at = 2026-11-03`。清单里的 URL 是给用户机器取的，会过期的地址等于没有 |
| `raw.githubusercontent.com/<o>/<r>/<sha>/…` | ✘ host 在允许名单里，但要求**把二进制提交进仓库** —— 破坏 D-11 §6.2「仓库里没有二进制，最大已跟踪文件 255 KB」 |
| `huggingface.co` | ✘ 在名单里，但那是第三方账号，等于换一个我们不控制的托管方 |
| **`github.com/<o>/<r>/releases/download/<tag>/<file>`** | ✅ 不可变、无保留期、host 已在 `ALLOWED_DOWNLOAD_HOSTS` |

⚠️ **一条容易踩的**：`build-backends.yml` 的 publish 输入写的是「Attach the packs to a **draft** release」——
**draft release 的附件不能匿名下载**（要 token）。所以这个 release 必须是**已发布**的
（可以标 prerelease），不能是 draft。

## 1.3 现在这些包在清单里是什么状态

`merge-manifest` 产出的 14 个包里，我们自己编的 6 个全部是 `availability: "pending-ci"` + `mirrors: []`。
这**不是将就，是 schema 设计好的诚实状态**：`BackendManifestSchema` 的 `superRefine` 要求
`published` 必须有 mirror，而 `pending-ci` 允许空；前端 `BackendPackCard.tsx:50` 读到它会**禁用安装按钮**。

**我没有把这 6 条写进仓库的 `backends.json`** —— 一个用户下不下来的东西先不进目录。
release 一批下来，它们同时拿到 URL 和 `published`。

---

# §2 ffmpeg：两条都补上了，核实过程写在这里

## 2.1 Windows x64 —— BtbN，**与 Linux 包同一个不可变 tag**

```
资产   ffmpeg-n7.1.5-12-g1fdbca85aa-win64-gpl-7.1.zip
tag    autobuild-2026-08-02-13-17          ← 和 media-tools-linux-x64 同一个
体积   158,697,121 B
sha256 5fef81d2a19752cafacb1bb396b3c7d64d31845d7ce4878ac65d24dd3abda00d
```
`[本机实测]` **全量下载复算**，与 GitHub Releases API 的 digest 逐字符一致。

**守卫钉的是"同一个 tag"而不是"某个 tag"**：BtbN 的 `latest` 是移动 tag，
钉同一个日期 tag，两个平台的 ffmpeg 才是同一次上游构建。

## 2.2 macOS arm64 —— jellyfin/jellyfin-ffmpeg

```
资产   jellyfin-ffmpeg_7.1.4-3_portable_macarm64-gpl.tar.xz
tag    v7.1.4-3
体积   31,063,636 B
sha256 99d689816a41075574928a0b3059101fd454fc58f465c99105a73b5c415ac86d
```
`[本机实测]` **全量下载复算**，与 API digest 逐字符一致。

解开正好两个文件：`ffmpeg` 53,441,720 B + `ffprobe` 53,300,504 B。
**ffprobe 在** —— 这正是当年否掉 `ffmpeg-static` 的唯一理由
（`build-media-tools.sh` 文件头：D-01 §8.5 要求真实媒体类型只能来自 ffprobe；
T-026 那个安全修复靠 ffprobe 的 `format_name` 认出被改名的 `.m3u8`）。

**Mach-O 静态分析**（`[本机实测]`，自己写的 load-command 解析器）：

```
file: Mach-O 64-bit arm64 executable
26 条 LC_LOAD_DYLIB —— 全部指向 /System/Library/Frameworks/** 与 /usr/lib/**
0 条 @rpath · 0 条 /opt/homebrew · 0 条 /usr/local · 0 条 LC_RPATH
LC_CODE_SIGNATURE  有（Apple Silicon 上没签名的 Mach-O 根本不启动）
LC_BUILD_VERSION   platform=macOS  minos=12.0.0  sdk=15.5.0
```
→ `requiresDriver.macosVersion: "12.0"` 是**量出来的**，不是抄的。
（`emit-pack-manifest.mjs` 的规矩是「没测过写 null」，测过就写。）

⚠️ **诚实边界，两条**：
1. jellyfin-ffmpeg 是 ffmpeg 的 **fork**（带 jellyfin 的 hwaccel 补丁），不是上游原版。
2. **我没有在 Mac 上运行过它。** 上面全部是静态分析。
   「它真能归一化 + 探测」要靠 macOS runner 实跑证明（§5）。

## 2.3 落盘布局：走**真实安装器**验过（`[本机实测]`）

这一段与平台无关（解包 + 硬链 + 目录布局），所以本机能验。
起一个本地 HTTP 源、让 `install()` 真的下载 → 校验 sha256 → 解包 → 链接，
再用产品的 `findInBackendPacks` 去找：

```
══════ media-tools-win-x64 ══════
  清单声明: 158697121 B  5fef81d2…
  本机实文件: 158697121 B  5fef81d2…          一致: ✔ 是
  install() 返回 1 个文件，耗时 2.3s
  findInBackendPacks(ffmpeg.exe)  = <store>/by-name/backend/ffmpeg-…-win64-gpl-7.1/ffmpeg-…-win64-gpl-7.1/bin/ffmpeg.exe
  findInBackendPacks(ffprobe.exe) = <store>/by-name/backend/ffmpeg-…-win64-gpl-7.1/ffmpeg-…-win64-gpl-7.1/bin/ffprobe.exe

══════ media-tools-macos-arm64 ══════
  清单声明: 31063636 B  99d68981…
  本机实文件: 31063636 B  99d68981…            一致: ✔ 是
  install() 返回 1 个文件，耗时 1.7s
  findInBackendPacks(ffmpeg)  = <store>/by-name/backend/jellyfin-ffmpeg_7.1.4-3_portable_macarm64-gpl.tar.xz/ffmpeg
  findInBackendPacks(ffprobe) = <store>/by-name/backend/jellyfin-ffmpeg_7.1.4-3_portable_macarm64-gpl.tar.xz/ffprobe
```

**顺带实测到一条**：产品的下载器是**分片 Range 下载**，服务端不支持 Range 它会直接
`DownloadError … RANGE_NOT_SUPPORTED` 而不是退化成整文件下载。我的第一版桩服务器就是这么红的。

---

# §3 CoreML / ANE —— 查清楚了，但**今天还接不通**

## 3.1 本轮做了什么

**`build-whisper.sh`：macOS 的核心包（`--backend cpu`）自动带上**
`-DWHISPER_COREML=ON -DWHISPER_COREML_ALLOW_FALLBACK=ON`。

为什么加在核心包上而不是做成独立加速包 —— 这是**源码事实不是偏好**：
`WHISPER_COREML` 编出 `whisper.coreml` 目标并 **PRIVATE 链进 libwhisper**
（`vendor/whisper.cpp/src/CMakeLists.txt:57-83, 152-154`，链的 framework 只有
`Foundation` 与 `CoreML`），**不是 dlopen 的 ggml 模块**。
所以 CUDA/Vulkan 那种「核心包 + 再装一个 `.so`」的模型在这里结构上不成立。

`ALLOW_FALLBACK=ON` 的语义（`whisper.cpp:3440-3452`）：`.mlmodelc` 加载失败时
**打一行 ERROR 然后照常跑**。所以带 CoreML 的二进制在没装 encoder 的机器上
行为与不带时一致 —— **一个包吃两种情况**，不需要发两个包。

⚠️ **风险（如实说）**：`WHISPER_COREML=ON` 在 macOS runner 上**从来没编过**。
`src/CMakeLists.txt:30-45` 找不到 `CoreML.framework` 就 `FATAL_ERROR`。
我刚触发的 run 31037981498 就是来回答这个的。**编不出来我会退回去并报你。**

**坏掉的 `--backend coreml` 分支改成当场 die**，并在错误信息里写清正确做法。
与其留一段跑一次红一次、且描述了不存在事物的代码。

## 3.2 🔴 配套的自检项 `asr.coreml` —— 你点名要的那条

你原话：「请确保自检或界面能看出当前到底走没走 ANE，否则我们就造了一个新的假绿灯。」

**这个担心不是理论上的，它已经被两处代码坐实了**：

```
ALLOW_FALLBACK=ON        →  whisper.cpp:3440-3452  加载失败 → 打一行 ERROR → 继续跑
--no-prints              →  whisperCpp.ts:101 传的
whisper-cli 收到 --no-prints →  cli.cpp:1039-1040  whisper_log_set(cb_log_disable, NULL)
                              ↑ 整个日志通道被关掉，那行 ERROR 谁也看不见
```

所以我加了 `packages/runtime/src/selfcheck.ts` 的 `asr.coreml`（**只在 darwin/arm64 出现**）：

| 档 | 条件 | 文案要点 |
|---|---|---|
| `ok` | encoder 目录在，**且里面有 `coremldata.bin`** | ANE 已就绪（只接管 encoder，decoder 仍走 Metal/CPU） |
| `warn` | 没装 encoder | 未启用 ANE —— 走 Metal/CPU，**功能正常只是慢** |
| `fail` | 目录在、但**里面没有 `coremldata.bin`** | CoreML encoder 结构不对，whisper 会**静默回退** |

- **判据是"目录里有没有 `coremldata.bin`"，不是"目录在不在"** ——
  只查存在性会把 `fail` 那档读成 `ok`，而 `fail` 那档正是 §3.3 第 1 条那个空壳。
- `required: false` 是有意的：没有 ANE 不影响能不能转写，只影响快慢。
  标成 required 会让一台完全正常的 Mac 报红 —— **那是另一种谎。**

路径规则 `coreMlEncoderNameFor()` **逐条复刻 `whisper.cpp:3326-3348`**，并被守卫钉住
（`platformPacks.test.ts` ④），因为 `whisper-cli` 不接受 `.mlmodelc` 参数、
它自己从 `-m` 推路径 —— **文件名差一个字，ANE 就静默不生效**。

## 3.3 ⚠️ 剩下 3 处断点（需要你裁，都超出本任务）

| # | 断点 | 位置 | 后果 |
|---|---|---|---|
| 1 | **解包多一层同名目录** | `installer.ts:236-238` 的 `stripExt(f.name)` 得到 `X-encoder.mlmodelc`，而 zip 内部**自带一层同名顶层目录**，`unpack.ts` 又不做 strip-components → 真实结构是 `X-encoder.mlmodelc/X-encoder.mlmodelc/coremldata.bin`，**外层是个空壳** | whisper 静默回退。**新自检项会把它报成 `fail`**，所以至少不再是静默的 |
| 2 | **前端从不传 `includeOptional`** | `coreml-encoder` 是 optional 文件，只有 `POST /api/models/pull` 带 `includeOptional:["coreml-encoder"]` 才会下载（`rest/models.ts:385`）。全仓 `apps/web` 里**没有任何地方传这个值** | **用户在界面上没有任何办法装 CoreML encoder** |
| 3 | **只有 f16 条目挂了 encoder** | `models-whisper.json` 里只有 `whisper-large-v3-f16` / `-turbo-f16` 有 `coreml-encoder`；产品默认推荐的是 `whisper-large-v3-turbo-q5_0`，它没挂 | 装了默认模型的用户拿不到 ANE。⚠️ 注意**技术上完全可以挂**（§TL;DR ②：q5_0 会去找同一个 `-turbo-encoder.mlmodelc`），只是清单没写 |

关于 #3 的一条补充事实（来自我派的调研，`[未直连 HF 核实]`）：上游 HF 仓库有
tiny/base/small/medium/large 全套 `*-encoder.mlmodelc.zip`，**最小的 tiny 只有 ~14.3 MiB**。
本环境直连 `huggingface.co` 被网络策略挡住（三次 connection timed out），
该清单是从 ModelScope 的三份镜像交叉验证来的，并用两个 `sizeBytes` 与我们
`models-whisper.json` 里现有条目**逐字节对上**作为锚点。**HF API 直查：查不到。**

## 3.4 ANE 与 Metal 的关系（你问的）

**互补，不是二选一。** CoreML 只接管 encoder（`whisper.cpp:2412` 用
`whisper_coreml_encode` 替掉 encoder 图；`models/generate-coreml-model.sh` 结尾
原文 `# TODO: decoder (sometime in the future maybe)`），decoder 仍走 ggml 的后端 ——
也就是 Metal 包（GPU）或 CPU 模块。所以理想形态是**核心包(带 CoreML) + metal 包 + encoder**
三者同时在，encoder 跑 ANE、decoder 跑 GPU。

---

# §4 两份 manifest：**反方向的洞也补了**

`ytdlp-install` T-132 立的规矩（要下载的组件两处都写）只有**一个方向**的守卫
（`components → backends`）。`platform` T-141 §3 实测反方向有 **20 个包**在
`components.json` 里一条都没有 ——「一个 Mac / Windows 用户打开「组件与来源」页，
**他自己那台机器上要装的每一个组件，来源与许可证一条都查不到**」。

本轮：
- 新增 **16 条** `components.json` 条目，把 `backends.json`(10) + `sqlite-ext.json`(11) 里
  所有 `published` 的包补齐（`pending-ci` 的**刻意排除** —— 用户下不下来的东西不该出现在来源页）；
- 加**反方向守卫**：每个可下载的包必须在 `components.json` 里查得到来源与许可证；
- 再加一条：同一个 id 在两份清单里的**体积与摘要必须一致**（不一致 = 用户看到的和实际下载的不是同一个文件）。

守卫都带「数了几个」的计数断言 —— 零个也能"全部通过"，那正是 `ci-prep` C5 修掉的形状。

---

# §5 端到端验证：本机能验的都验了，其余交给 CI

## 5.1 本机（Linux x64）`[本机实测]`

| 项 | 结论 |
|---|---|
| 两个新归档的 sha256 与清单一致 | ✅ 全量下载复算 |
| 走真实 `install()` 下载→校验→解包→硬链 | ✅ §2.3 |
| `findInBackendPacks` 真能找到 4 个二进制 | ✅ §2.3 |
| `backends.json` 过真的 `validateBackendManifest` | ✅ 10 个包全 `published` |
| 门禁 | `tsc -b` 0 · `eslint` 0 · `pnpm -r test` **897 / 0** |

⚠️ **本机没有也不可能验的**：那两个二进制在 Windows / macOS 上**真的能跑**。
按用户指示，本地 whisper 转写测试**一次都没跑**。

## 5.2 CI：把判据从"文件下下来了"改成"真的转出字来"

用户 2026-08-06：「实测速度不重要，对于 CI 来说重要的是验证可行性」。
所以 `cold-start-audit.mjs` 加了 `--transcribe`：**走产品真实路径**

```
POST /api/notes/import  (本地 wav)  →  transcribe job  →  GET /api/notes/:uid/transcript
```

- 样本用 whisper.cpp submodule 自带的 `samples/jfk.wav`（352,078 B，约 11 秒），
  **随 `submodules: recursive` 一起 checkout，不需要联网另取、不需要造音频**；
- 判据写死在脚本里：**段数 > 0 且去空白后文本长度 ≥ 20**。
  不断言具体内容 —— tiny 模型认错词是正常的，**这一步证的是"能跑通"不是"准不准"**；
- 另外显式挑一个最小的 ASR 模型来拉：`required-core` 里**一个 ASR 都没有**
  （`ci-runner` T-145 §7.3 的产品结论），不显式挑就永远没得转；
- **只在屏蔽宿主 PATH 那一遍开**。对照组可能借到 runner 自带的工具，
  那样跑出来的绿证明不了"我们自己装的那套能用" —— 保留屏蔽正是你交代的理由。

**已触发**：`cold-start-audit` run **31037964581**、`build-backends` run **31037981498**。
⏳ **两轮结果我还没拿到**，拿到之前 Windows / macOS 那两格一律 `[未验证]`。

## 5.3 反向验证（撤掉修复 → 变红，真实输出）

**R1 · 从 `backends.json` 删掉 `media-tools-win-x64`**

```
✖ ★ 任何一个能装 whisper.cpp 的平台，同一个平台必须也能装 ffmpeg
  AssertionError: 这些平台有转写引擎但装不到 ffmpeg —— 装完自检会绿，转写会全废
                  （transcribe.ts 每条路径都要 normalizeToPcm16k + probeMedia）：win32/x64
✖ Windows x64 的 ffmpeg 来自我们已经钉住的那个 BtbN tag
  AssertionError: backends.json 里没有 win32/x64 的 ffmpeg 包 —— Windows 上转写全废
ℹ tests 7 / pass 4 / fail 3
```
↑ **这一行就是 Windows 今天之前的真实处境。**

**R2 · 只写 `backends.json`、忘了写 `components.json`（ffmpeg 两次成灾的那个形状）**

```
✖ ★ 每个可下载的包都必须在 components.json 里查得到来源与许可证
  AssertionError: 这些包装得上、但用户在「组件与来源」页查不到它从哪来、什么许可证
                  （ADR-001 可追溯性）：media-tools-macos-arm64, media-tools-win-x64
ℹ tests 7 / pass 6 / fail 1
```

两组跑之前都 `grep` 确认过坏行在**即将运行的产物**里（`dist/pipeline/platformPacks.test.js`），
跑完都已还原（`git status` 里 `vendor/manifests/*` 只有我要提交的那一版）。

### ⚠️ 我自己在反向验证里犯的一个错（记账）

R1 第一版打印出来的是「**有 ffmpeg 的平台只有 1 个，断言失去意义**」——
真正该说的那句「这些平台有转写引擎但装不到 ffmpeg」**一个字都没印出来**。
成因：我给 `withEngine` 和 `withFfmpeg` **都**加了"集合非空"守卫，
而 `withFfmpeg` 变空恰恰是这条断言要**报告的内容**，不是它的前提。

> **教训**：空集守卫是用来防"筛空了还报绿"的，不能加在**被检查的那个量**上 ——
> 加上去，它就会在真出问题时抢在真正的错误消息前面炸掉，
> 于是**守卫红了，但它没告诉你为什么**。
> 我在源码里把这条写成了注释，免得下一个人再加回去。

---

# §6 给 D-11 的补充（**我没有直接改 D-11**）

D-11 是 `ci-runner` 的交付物，PROTOCOL §1 规则 3 说不改别人的交付物，
而且它此刻很可能正在被写。你要的「ANE 与 Metal 的关系写进 D-11」我写在了
本文件 §3，**内容随时可以整段搬过去**，或者由 `ci-runner` 自己收。
如果你希望我直接写进 D-11，说一声我就写。

同时**订正 D-11 / T-141 的两条**（都在我这边有新证据）：
1. `platform` T-141 §2.2 给的 macOS ffmpeg 候选（`eugeneware/ffmpeg-static`）**不可用**，
   理由见 §TL;DR ①。它当时标的是「未落地前必须重新核」——**核了，结论是换掉**。
2. D-11 §5 遗留第 1 条「macOS metal 包为何是空的」已经解决（第 3 轮的 `.so` 后缀修复），
   我这次解开 metal 包确认里面**确实有** `libggml-metal.so` 828,512 B，不是空的。

---

# §7 我没做 / 做不到的（如实列）

| 项 | 状态 |
|---|---|
| macOS whisper 进清单 | ⛔ **等 release 授权**。产物、sha256、URL 形态都备好了 |
| linux-x64 vulkan/cuda、win-x64 vulkan 进清单 | ⛔ 同上（同一个 release） |
| Windows / macOS 上二进制真的能跑 | ⏳ **CI 跑着，结果没拿到**。本机验不了 |
| ANE 真的被用上 | 🔴 **今天不成立**，4 处断点修了 1 处（§3.3） |
| macOS 上 `WHISPER_COREML=ON` 编得出来吗 | ⏳ **未验证**，run 31037981498 正在答 |
| `openmemo-probe` 的分发 | ⛔ 没碰。CI 产出了它（macOS 52,896 B / Linux 17,208 B）但没有分发通道，`probeExists` 恒 false 这条老债还在 |
| `whispercpp-cuda-11.8` / `whisper-blas` 等上游未收录资产 | ⛔ 没碰，不在本任务范围 |
| linux-arm64 / macos-x64 / linux-x64-rocm | ⛔ **用户明确不需要，刻意没补** |

---

# §8 纪律申报

- **`git add` 逐个文件**，`git status` 里这 4 个是**别人的在途改动，我一个都没 add**：
  `apps/daemon/src/pipeline/ytdlpInstall.test.ts`、`apps/daemon/src/storage/migrateRecords.test.ts`、
  `packages/pipeline/src/media/__tests__/ytdlpRemoval.test.ts`、`scripts/check-tracked-sources.mjs`。
- 构建**全程 `pnpm build:safe`**，一次 `pnpm -r build` 都没跑，`apps/web/dist` 时间戳未变。
- `:10000` **一次请求都没发**；`/root/data-memo` 一个字节没读没写；
  `~/.local/share/openmemo/datadir.json` 没碰（本机验证用的是 `install()` 纯函数路径 + `mkdtemp`，
  **不启 daemon、不写指针**）。
- 没有 `pkill -f`。没有建 release / 改可见性 / 改分支保护。
- 临时文件在 `/tmp/pack-publish/`，验证脚本跑完即删（`apps/daemon/.tmp-packverify/` 已 `rm -rf`）。

## SHARED-CHANGE 申报

| 文件 | 归属 | 我做了什么 | 冲突风险 |
|---|---|---|---|
| `packages/runtime/src/selfcheck.ts` | `storage-fix` / `gpu-runtime` | **纯新增**：一个导出函数 + 一个私有函数 + `model.asr` 之后加一行调用 | 低（不改任何既有检查项的判据或文案） |
| `packages/runtime/src/index.ts` | 同上 | 导出列表加一行 | 低 |
| `scripts/ci/cold-start-audit.mjs`、`.github/workflows/cold-start-audit.yml` | **`ci-runner`（在途）** | 加 `--transcribe`（默认关）+ 3b 里多挑一个 ASR 模型 + 末尾新增第 7 节 | 🟡 **中** —— `ci-runner` 可能正在改同一个文件，请他 rebase 时留意 |
| `scripts/build-whisper.sh` | `gpu-runtime` | cpu 分支加 darwin 条件；coreml 分支改成 die | 低 |
| `vendor/manifests/*.json` | `model-mgmt` | 追加条目 | 低（数组末尾追加） |

---

## [2026-08-06 03:40] T-146 PROGRESS（CI 三轮跑完，**抓到三条真机结论 + 一条产品级 bug**）

# TL;DR 追加

## 🎉 ① Windows 第一次成为完整平台（`[CI 实测]`，屏蔽宿主 PATH）

`cold-start-audit` run 31037964581 / `win32-x64`，全新数据目录：

```
✅ 产品自己下载并校验的 (5)：  tool.ffmpeg, tool.ffprobe, tool.whisperCli, tool.whisperVad, tool.ytDlp
⚠️ 借宿主 PATH 的       (0)：  (无)
❌ 装不上/不可用        (0)：  (无)
ext.chineseSearch = ok（required=true）
```
补 ffmpeg 之前它是「引擎在、前置工具不在」。适用包 4/19 → **5/21**。

## 🎉 ② macOS 的 ffmpeg 不再是"借来的"

同一轮 `darwin-arm64`：`media-tools-macos-arm64 succeeded (5.3s)`（sha256 在真机上校验过），
`tool.ffmpeg` / `tool.ffprobe` 从 `warn（来自系统 PATH）` 变成 `ok` + 路径落在数据目录里。
**借宿主 PATH 从 3 个降到 1 个**（只剩 whisperCli，等 release）。适用包 3/19 → **4/21**。

对照 D-11 §7.1 那三行 —— 用户那句「我怕了你」问的正是这个形状，现在它少了三分之二。

## ✅ ③ CoreML 真的编进去了（`[CI 实测]`，我把包解开看的）

`build-backends` run 31037981498 的 `macos-arm64-cpu` **success**，包里多了一个文件：

```
libwhisper.coreml.dylib                    87,600 B      ← 新增
libwhisper.1.9.1.dylib 的 LC_LOAD_DYLIB：
    @rpath/libggml.0.dylib
    @rpath/libwhisper.coreml.dylib         ← 真的链上了
    @rpath/libggml-base.0.dylib
```
`src/CMakeLists.txt:30-45` 那个「找不到 CoreML.framework 就 FATAL_ERROR」的关口通过了 ——
我上一封标的风险**已排除**。

**新的 sha256（release 要发的是这一版，不是上一封那两个）**：

| 文件 | 字节 | sha256（我本机复算） |
|---|---:|---|
| `whispercpp-cpu-macos-arm64.tar.gz` | **1,847,186** | `cb9d6c5ddfd921424cf947e138f006edf12d08fb183d3d061f94c125f400db7c` |
| `whispercpp-metal-macos-arm64.tar.gz` | **163,224** | `8e1ed22320c130a1b7ba53bebc67805b811fa5b3b9eadd266127a00e1629a652` |

## 🔴 ④ **本轮最重要的发现：三个平台没有一个能在干净机器上完成转写**

这是**第一次有人在干净机器上跑产品的真实转写路径**。判据从"文件下下来了"换成"拿到非空文本"，
立刻问出了两条以前谁都没问过的事实。

| 平台 | 卡在哪 | 定性 |
|---|---|---|
| linux-x64 | `whisper-vad-speech-segments exited with code 2` → `error: failed to initialize whisper context` | 🔴 **产品 bug（新）** |
| win32-x64 | **同上，一字不差** | 🔴 **同一个 bug** |
| darwin-arm64 | `maskbin/whisper-cli exited with code 127` | 🟡 **预期之中** —— macOS 还没有 whisper 包（等 release） |

**Linux/Windows 那条的完整证据**（`[CI 实测]` run 31039460495，job.error 全文）：

```
whisper-vad-speech-segments exited with code 2
load_backend: loaded CPU backend from .../libggml-cpu-haswell.so
read_audio_data: reading audio data from '.../job-…/audio16k.wav' ...
read_audio_data: trying to decode with miniaudio
error: failed to initialize whisper context
```

**定位到具体那一行**：`vendor/whisper.cpp/examples/vad-speech-segments/speech.cpp` 里
`return 2` 有两处 ——
- `:104` 是「读音频失败」，配的文案是 `failed to read audio data from %s`；
- `:116` 是「VAD 模型初始化失败」，配的文案正是我们拿到的 `failed to initialize whisper context`。

日志里 `read_audio_data` 已经打到 `trying to decode with miniaudio`，**说明音频读到了**。
→ **失败的是 `whisper_vad_init_from_file_with_params(ggml-silero-v6.2.0.bin)`。**

**假设（未证实，明说）**：`whisper.cpp:4778` 的第一件事是校验 `GGML_FILE_MAGIC`，
不匹配就 `invalid model data (bad magic)`。我们清单里钉的是
`ggml-silero-**v6.2.0**.bin`，而 `packages/pipeline/src/tools.ts:449` 的查找列表
**第一个写的是 `ggml-silero-v5.1.2.bin`** —— 像是「代码按 v5 写的，清单换成了 v6」。
⚠️ **我没能证实**：这台机器直连 `huggingface.co` 被网络策略挡住（`curl` exit 7），
下不到那个文件去比对 magic。**只能标假设，不能当结论。**

**还有两条使它更难查的因素**：
1. `vad.ts:70` 传了 `-np`，而 `speech.cpp:95-97` 收到 `-np` 就
   `whisper_log_set(cb_log_disable)` —— **具体原因（bad magic / 打不开文件）被整个吞掉**，
   只剩下例子自己 fprintf 的那句泛泛而谈。**与 CoreML 那条是同一族**（§3.2）。
2. `transcribe.ts:211` 的降级只覆盖「VAD **没装**」，不覆盖「VAD **装了但跑不起来**」——
   于是一个坏掉的 VAD 模型**直接把整单转写打死**，而不是退回固定窗口。
   ⚠️ 这一条我**故意没改**：把响亮的失败改成安静的降级，正是本仓最该避免的动作。
   要改也该是「降级 + 在 selfcheck/界面上明说」，那是产品决定，**请你裁**。

**这条不是我引入的**：我没碰 pipeline 的任何一行。它一直在那儿，只是
**从来没有人在干净机器上跑过一次真的转写**。

## ✅ ⑤ Windows 上「本地文件导入 100% 不可用」—— 已修并在真机上确认

run 31038554367 / win32-x64：一个**就放在 dataDir 里**的文件被拒
```
POST /api/notes/import → HTTP 403 PATH_NOT_ALLOWED
path outside allowed roots: C:\Users\RUNNER~1\...\data\jfk.wav
```
`notes.ts` 原写法 `real.startsWith(root + '/')` 硬编码 POSIX 分隔符，
Windows 上 `root + '/'` = `C:\…\data/`，**永远匹配不上**。
（同族第二处：`main.ts:784` 用 `':'` 切 `OPENMEMO_IMPORT_ROOTS`，`C:\media` 会被切成两半。）

修法照 `argGuard.isSafeExecutable` 的形状：**platform 作为入参**，抽成
`isWithinImportRoots(roots, candidate, platform)` —— 宿主绑定的判断在本机 Linux 上测不出来，
参数化之后本机能测两边（守卫 3 条）。

**下一轮真机确认**（run 31039460495 / win32-x64）：`POST /api/notes/import → HTTP 202`。修好了。

反向验证：把实现换回旧版 → `✖ ★ win32：dataDir 里的文件必须被接受（原实现在这里恒 false）`，
其余 11 条仍绿。`grep -rn REVERSAL` 全仓 0 命中（已还原）。

## ⑥ 我自己在这三轮里犯的错（继续记账）

| # | 错 | 后果 | 教训 |
|---|---|---|---|
| 1 | 反向验证时给**被检查的那个量**也加了"集合非空"守卫 | 该说的那句「这些平台有转写引擎但装不到 ffmpeg」**一个字没印出来**，先炸的是守卫 | **空集守卫防的是"筛空了报绿"，不能加在被检查的量上** —— 加上去它会在真出问题时抢在真错误前面炸掉：守卫红了，但它没告诉你为什么 |
| 2 | `cold-start-audit.yml` 的 checkout 没有 `submodules: recursive` | 三平台第 7 节同一行「样本不存在」 | 它**红得诚实**（说了自己缺什么），但确实什么都没证明 |
| 3 | 挑"最小的 ASR 模型"挑到了 `asr/sherpa-streaming-zh-14m` | 那是中文流式 onnx，样本是英语，而本轮要证的是 whisper.cpp + ffmpeg 这条链 | **挑错引擎的话，绿了也证明不了它该证明的东西** |
| 4 | 同一个错让 `asr.coreml` 对着 `decoder-epoch-99-avg-1.int8.onnx` 算出「缺 …-encoder.mlmodelc」 | 一句语法正确、毫无意义的话 | **一条会对不相干的东西发表意见的检查，说对的时候也不该被相信** |
| 5 | `waitForJob` 把 error 截到 200 字符 | 第一次拿到的是 `…exited with code 2\nload_backend: l` ——**正好断在最关键的那个字上** | 摘要用的截断和定位用的全文是两件事。现在第 7 节会再取一次全文（只打印、不改红绿） |

## ⑦ 一条顺带证实的（`[CI 实测 macOS]`）

`asr.coreml warn … ggml-tiny-q5_1.bin → 缺 ggml-tiny-encoder.mlmodelc`
—— **`-q5_1` 后缀真的被剥掉了**，`coreMlEncoderNameFor` 复刻上游规则的那一段在真机上行为正确。
`meta.sameSource ok 26 项逐 id 一致` —— 新自检项在 CLI 与 HTTP 两条出口上没有分歧。

---

## 逐平台覆盖表（更新版，可以直接给用户）

| 平台 | ffmpeg/ffprobe | 转写引擎 | 中文检索 | yt-dlp | **干净机器上能转写吗** |
|---|---|---|---|---|---|
| **Linux x64** | ✅ `[CI 实测]` | ✅ `[CI 实测]` | ✅ `[CI 实测]` | ✅ | 🔴 **不能** —— 卡在 VAD 模型（④，新发现的产品 bug） |
| **Windows x64** | ✅ **本次补上** `[CI 实测]` | ✅ `[CI 实测]` | 🔴 libsimple 装了不加载（`ci-runner` 已报） | ✅ | 🔴 **不能** —— 同一个 VAD bug |
| **macOS arm64** | ✅ **本次补上** `[CI 实测]` | 🔴 等 release | ✅ `[CI 实测]` | ✅ | 🔴 **不能** —— 引擎还没有下载地址 |

> **口径**：这张表比上一版更红，**因为判据变严了** ——
> 上一版问的是"工具装齐了吗"，这一版问的是"**真的转出字来了吗**"。
> 前一个问题三个平台已经基本是绿的；后一个问题今天第一次被问出口，答案是三个都不行。
> **这正是把判据从"文件下下来了"换成"拿到非空文本"的价值。**
