---
id: D-20
author: e2e-import
status: draft
date: 2026-08-09
---

## TL;DR（≤ 25 行，Manager 只读这里）

- 用户裁决：**改成和 memo 一样内置依赖 + 检测更新**。本文只出**范围与数字**，一行产品代码没动。
- ⚠️ **先更正一条我们自己写错的许可证**：**`yt-dlp` 不是 GPL，是 Unlicense（公共领域）。**
  `[实测]` 拉 `yt-dlp/yt-dlp@2026.07.04` 的 `LICENSE`：0 处 "GNU GENERAL PUBLIC"、3 处 "public domain"。
  而 `vendor/manifests/backends.json` 的 4 个 `ytdlp-*` 和 `D-17 §1` 都写着 `GPL-3.0-or-later`。**是错的。**
- ⚠️ **再更正一条范围**：`libsimple` / `sqlite-vec` **今天已经在包里了**，不是"要下载"
  （`build-bundle.mjs:613` 构建期取件校验 sha256 → `ext/`；`[实测]` 走启动器起新数据目录得到 `tokenizer=simple vec=on`）。
- **所以真正的 GPL 阻断只剩 ffmpeg 一个。** 而且它**可能不成立**：BtbN 同时发 **lgpl 变体**，
  而我们对 ffmpeg 的全部用法是**解码 → 单声道 16 kHz PCM**（`-c:a pcm_s16le -ar 16000 -ac 1 -vn`），
  **不编码 H.264/MP3** —— 这正是 GPL 组件（libx264 等）所在的那一侧。`[未验证]` 需实测 lgpl 构建能否解我们支持的全部输入格式。
- **体积**（下载体积，压缩态）：最小可用组合 **linux 201 MB / win 252 MB / mac 129 MB**（今天是 43/51/63 MB）。
- **CUDA 678 MB 不该内置**，Vulkan（25–30 MB）可考虑。
- **「检测更新」必须有一个远端可问的东西** —— 而我们刚删掉那条线。这是真实的设计回摆，代价见 §5。
- 未验证/存疑：~~lgpl ffmpeg 的解码覆盖面~~（Linux 已实测 19/19 通过，Windows/macOS 有缺口，见 §13）、
  ~~yt-dlp **二进制**内嵌依赖的完整许可证清单~~（`ytdlp-binary-audit` 2026-08-09 已交卷，见 §14 ——
  **⚠️ 结果是二进制里有 GPL：四平台全部内嵌 mutagen(GPL-2.0-or-later)，Linux 两平台另内嵌 GNU
  Readline(GPL-3.0-or-later)，与 §9.2「yt-dlp → 内置」冲突，未改 §9.2，交裁**）、GPL 合规清单的
  法律充分性（我不是律师）。
- 对其他 agent 的影响：若换 lgpl ffmpeg，**我那份 `e2e-import-audit.mjs` 会坏**（它用 libmp3lame/libx264 造样本）。

---

## 1. 许可证：先把我们自己写错的两条更正掉

### 1.1 `yt-dlp` —— **Unlicense，不是 GPL**

`[实测 2026-08-09]`：

```
$ curl -sSL https://raw.githubusercontent.com/yt-dlp/yt-dlp/2026.07.04/LICENSE
This is free and unencumbered software released into the public domain.
...
$ grep -c "GNU GENERAL PUBLIC" → 0
$ grep -ci "unlicense|public domain" → 3
```

**我们写错的地方**（两处，都该改）：

| 位置                                                  | 现在写的            | 应为        |
| ----------------------------------------------------- | ------------------- | ----------- |
| `vendor/manifests/backends.json` 的 4 个 `ytdlp-*` 包 | `GPL-3.0-or-later`  | `Unlicense` |
| `docs/design/D-17-prebuilt-bundles.md:113`            | 🔴 GPL-3.0-or-later | Unlicense   |

**这条更正直接改变结论**：yt-dlp **内置不触发任何 copyleft 义务**。

⚠️ **但有一条必须先查清再动手**（我**没查完**，标 `[未验证]`）：
我们分发的是 **PyInstaller 单文件二进制**，它内嵌 CPython 与若干第三方库 ——
**源码是 Unlicense，二进制里那些库各有各的证**。yt-dlp README 自己列了一部分：
`certifi`（**MPL-2.0**）、`yt-dlp-ejs`（Unlicense）、`brotli` 等。
**内置前必须把该二进制的内嵌依赖清单逐个过一遍**（尤其有没有 GPL 的可选依赖被打进去）。
这是**可执行的一步**，不是"注意合规"。

### 1.2 `libsimple` / `sqlite-vec` —— **不在"要下载"那一栏，它们已经内置了**

`build-bundle.mjs:612-636` 在**构建期**按 `vendor/manifests/sqlite-ext.json` 的 sha256
取件校验，放进包内 `ext/`；启动器设 `OPENMEMO_EXT_DIR` 指过去。

`[实测]` 走启动器、全新数据目录、屏蔽宿主 PATH，daemon 第一行就是
`db=better-sqlite3 sqlite=3.53.4 schema=v1 tokenizer=simple vec=on` ——
**中文分词与向量检索开箱即用**，不需要任何下载。两者都是 MIT。

**所以它们不该出现在这次的决策表里。**

### 1.3 剩下的 GPL 阻断：**只有 ffmpeg 一个**

`media-tools-*`（ffmpeg + ffprobe）是 `GPL-3.0-or-later`，用的是 BtbN 的 **gpl** 构建。

---

## 2. ffmpeg：GPL 可能根本不必触发

### 2.1 我们实际用到什么

`[实测 grep]` `packages/pipeline/src/audio/ffmpeg.ts` 里出现过的全部旗标：

```
-ac  -ar  -c:a  -f  -map  -protocol_whitelist  -ss  -t  -vn
输出编码器只有一个：pcm_s16le（两处，205 / 282 行）
```

翻译成人话：**把任意输入解码成单声道 16 kHz 的 PCM WAV**，外加按时间裁剪、丢弃视频轨、
远端读流的协议白名单。**我们不编码任何有损格式，也不编码视频。**

而 ffmpeg 里需要 `--enable-gpl` 的部分，主要是 **libx264 / libx265 / libxvid** 这类**编码器**
和少数 GPL 滤镜 —— **恰好落在我们不用的那一侧**。
`pcm_s16le` 是内置编码器；mp3/aac/opus/flac/vorbis 的**解码器**是 ffmpeg 原生实现（LGPL 侧）。

### 2.2 BtbN 确实提供 LGPL 构建

`[实测]` `BtbN/FFmpeg-Builds` 最新 release 的资产里**同时存在**：

```
ffmpeg-master-latest-linux64-gpl.tar.xz     ← 我们现在用的这一支
ffmpeg-master-latest-linux64-lgpl.tar.xz    ← 存在
```

**所以"内置 ffmpeg = 必须 GPL"这个前提，很可能不成立。**

### 2.3 ⚠️ 换 LGPL 之前必须实测的三件事（都没做）

1. **解码覆盖面**：LGPL 构建能不能解我们声明支持的全部扩展名
   （`.mp3 .m4a .wav .flac .ogg .opus .aac .wma .mp4 .m4v .mkv .mov .avi .webm .mpeg .mpg .flv .wmv .ts`）。
   ⚠️ 我**没测**。判据应当是：拿每种容器各造一个样本，走产品真实路径转一遍。
2. **LGPL 自身的义务**：它比 GPL 轻，但**不是零** —— 见 §3.2。
3. **副作用**：`[已知]` 我那份 `scripts/ci/e2e-import-audit.mjs` 用 `libmp3lame` / `libx264`
   **造测试样本**。LGPL 构建里没有这两个编码器，**那条腿会当场坏**。
   （产品不受影响 —— 产品只解码。但 CI 要改成用别的方式造样本。）

---

## 3. 若坚持内置 GPL 版 ffmpeg：**可执行的合规清单**

⚠️ **我不是律师，下面是工程清单，不是法律意见。** 最终由用户裁决。

GPL-3.0 对**分发二进制**要求（对应 §4、§6）：

| #   | 要做的事                                                   | 今天有没有                                  | 怎么做                                                                                                                                  |
| --- | ---------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 随分发附**许可证全文**                                     | 包里已有 `LICENSE` 与 `THIRD-PARTY-NOTICES` | 增补 GPL-3.0 全文                                                                                                                       |
| 2   | **显著声明**该组件受 GPL 管辖及其版权信息                  | 部分（NOTICES 里有）                        | 在 NOTICES 里点名 ffmpeg 及其版本                                                                                                       |
| 3   | **提供对应源码**：随附，或给一份**至少三年有效**的书面报价 | ❌ **没有**                                 | 最省事：随 release 附上 BtbN 用的那份源码 tarball 与构建脚本链接；**"给个上游 URL"不够** —— 义务是"你分发的那个二进制对应的源码"        |
| 4   | 不得附加与 GPL 冲突的限制                                  | 需复核我们自己的 LICENSE 与条款             | 复核                                                                                                                                    |
| 5   | ⚠️ **整体作品的传染性判定**                                | **UNKNOWN**                                 | ffmpeg 是**独立可执行文件**、我们用 `spawn` 调用（不是链接），业界普遍视为"聚合"而非"衍生"——**但这一条必须由用户/法务确认，我不下结论** |

**LGPL 版（§3.2）**：① ② 同上；③ **只需提供 LGPL 部分的源码**；
④ 额外要求**允许用户替换该库**（我们是独立可执行文件 + 单独目录，天然满足）。
**明显轻得多，这也是我建议先去核 §2.3 的原因。**

---

## 4. 逐项范围表（数字全部来自 `vendor/manifests/*.json`，下载体积/压缩态）

### 4.1 后端与工具

| 项                     | 今天                    | 体积（下载）                              | 许可证                             | 内置的代价                                                     | 不内置的代价                                       |
| ---------------------- | ----------------------- | ----------------------------------------- | ---------------------------------- | -------------------------------------------------------------- | -------------------------------------------------- |
| whisper.cpp CPU        | **已内置**（v0.4.0 起） | 2.0–6.8 MB                                | MIT                                | ——                                                             | ——                                                 |
| **ffmpeg/ffprobe**     | 下载                    | **linux 124.9 / win 167.4 / mac 32.9 MB** | GPL-3.0（gpl 构建）／**可换 LGPL** | 体积 +125～167 MB；GPL 或 LGPL 义务（§3）                      | **今天一大半故障来自它**：源不可达、卡校验、目录空 |
| **yt-dlp**             | 下载                    | linux 39.9 / win 18.2 / mac 38.3 MB       | **Unlicense**（更正）              | 体积 +18～40 MB；**无 copyleft 义务**；⚠️ 二进制内嵌依赖待清点 | 链接导入完全不可用                                 |
| whisper Vulkan         | 下载                    | linux 29.5 / win 25.1 MB                  | MIT                                | +25～30 MB                                                     | GPU 加速要再下一次                                 |
| whisper Metal          | 下载                    | mac 2.0 MB                                | MIT                                | **+2 MB，几乎免费**                                            | mac 上白白慢                                       |
| **whisper CUDA**       | 下载                    | **win 677.9 MB**                          | MIT                                | **体积翻十倍**                                                 | N 卡用户要等一次大下载                             |
| libsimple / sqlite-vec | **已内置**（更正）      | ——                                        | MIT                                | ——                                                             | ——                                                 |

### 4.2 模型（`role=asr` 前几档 + 必需的 VAD）

| 模型                               | 体积               | 许可证                              |
| ---------------------------------- | ------------------ | ----------------------------------- |
| `vad/silero-vad-ggml`              | **0.9 MB**         | MIT                                 |
| `asr/whisper-tiny-q5_1`            | **32.2 MB**        | MIT                                 |
| `asr/whisper-base-q5_1`            | 59.7 MB            | MIT                                 |
| `asr/paraformer-zh-small`（中文）  | 81.9 MB            | Apache-2.0                          |
| `asr/whisper-small-q5_1`           | 190.1 MB           | MIT                                 |
| `asr/whisper-large-v3-turbo-q5_0`  | 1 747 MB           | MIT                                 |
| `punctuation/ct-transformer-zh-en` | 298.6 MB           | Apache-2.0                          |
| LLM（`qwen3-4b-q4_k_m` 等）        | **2 490–5 028 MB** | Apache-2.0 / **Gemma-Terms-of-Use** |

⚠️ **模型许可证不是清一色 MIT**：whisper 全系 MIT，sherpa/paraformer/标点是 Apache-2.0，
而 **`llm/gemma-3-4b-it-q4_k_m` 是 `Gemma-Terms-of-Use`（非标准 OSS 证，有使用限制）**——
**若要内置任何 LLM，这一个必须单独看。**

---

## 5. 打包组合与总体积（让用户在"体积"与"省事"之间选）

基线：今天的包 `[实测下载]` **linux 43.0 / win 51.4 / mac 62.8 MB**。

| 组合              | 含什么                            | linux   | win     | mac     | 换来什么                                      |
| ----------------- | --------------------------------- | ------- | ------- | ------- | --------------------------------------------- |
| **A 今天**        | 现状                              | **43**  | **51**  | **63**  | 首次使用必须联网下 ffmpeg + 模型              |
| **B 只加 ffmpeg** | A + ffmpeg/ffprobe                | **168** | **219** | **96**  | 消掉"下载源不可达/卡校验"这一整类；仍需下模型 |
| **C 最小可用**    | B + VAD + tiny ASR                | **201** | **252** | **129** | **开箱即可转写一段**，完全不需要联网          |
| **D 舒适**        | C + yt-dlp + base ASR（替 tiny）  | **268** | **297** | **195** | 链接导入也开箱可用                            |
| **E 中文友好**    | C + yt-dlp + paraformer-zh + 标点 | **619** | **648** | **546** | 中文开箱好用，但体积破 600 MB                 |
| ⛔ **含 CUDA**    | D + CUDA                          | ——      | **975** | ——      | **不建议**：单平台近 1 GB                     |

（体积＝各项下载体积直接相加，压缩态；实际打包后**会略小**于此，因为归档会重压一遍。
`[未验证]` 我没有真打一个组合出来量，这是**上界估算**。）

**我的读法（供参考，不替用户决定）**：
**B 或 C** 是性价比拐点 —— 它们消掉的正是用户这几天撞到的那一整类故障，
而体积代价（+125～190 MB）远小于 CUDA/大模型那一档。

---

## 6. 「检测更新」那一半：这是一次真实的设计回摆

### 6.1 问题

内置之后，依赖**出厂即冻结**。要"检测更新"，就必须**有一个远端的东西可问** ——
而我们刚刚才删掉那条线（`loadManifest` / `verifyCatalogSignature` 的远端目录 + 签名校验）。
**把它接回来是回摆，代价必须说清。**

### 6.2 三个选项

| 选项                          | 怎么判"有新版"                                | 代价                                                     | 信任模型                                                          |
| ----------------------------- | --------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------- |
| **① 不做**                    | 随应用版本走：要新依赖就发新版应用            | 零新增代码；用户更新依赖＝更新整个应用（几百 MB）        | 与今天相同（出厂即冻结）                                          |
| **② 静态清单 + 签名**         | 远端放一份**签名过的** manifest，客户端定期拉 | 要把 `verifyCatalogSignature` 那条线接回来；**要管密钥** | 需要一把发布密钥；**密钥一旦泄漏，等于可以给所有用户投毒**        |
| **③ 复用 GitHub Release API** | 问 `releases/latest` 的 tag/asset             | 最省事，无需自建                                         | 信 GitHub + 传输层 TLS；⚠️ **中国网络下正是今天出问题的那一条链** |

⚠️ **无论选哪个，"更新"仍然要走网络** —— 所以网络问题**不会消失**，
但性质变了：从**首次使用就被挡住**（今天）变成**已经能用、更新失败只是维持现状**。
**这大概率正是用户想要的那个改变。**

### 6.3 建议的最小形状（未实现）

**①＋按需②**：先内置（消掉首次使用的阻塞），更新通道**第一版只做"告知"不做"自动装"** ——
即只回答"有没有更新"，装不装由用户点。这样即使更新通道不通，产品也**完全可用**，
而不是又造出一条新的"卡住"路径。

---

## 7. 需要用户裁决的（我不替他决定）

1. **ffmpeg 走 GPL 版还是 LGPL 版？** —— 前者要 §3 那份清单（含**三年源码供应**义务），
   后者要先做完 §2.3 的解码覆盖面实测。
2. **内置到哪一档？** —— B / C / D / E（§5 的表）。
3. **要不要内置任何 LLM？** —— 若要，`Gemma-Terms-of-Use` 那个必须单独看。
4. **更新通道选 ①②③ 哪个？** —— ② 意味着我们要开始管一把发布密钥。

## 8. 未验证 / UNKNOWN（逐条）

- `[未验证]` LGPL 版 ffmpeg 对我们全部支持格式的解码覆盖面。
- `[未验证]` yt-dlp **二进制**内嵌第三方依赖的完整许可证清单（源码是 Unlicense 已实测）。
- `[未验证]` §5 的体积是**上界估算**，没有真打包量过。
- `UNKNOWN` GPL 传染性对"独立可执行文件 + spawn 调用"这一形态的判定 —— 需法务/用户确认。
- `UNKNOWN` 各模型权重的**上游再分发条款**（清单里的 `license` 字段是我们自己填的，
  我这次**没有逐个回上游核**；whisper 系 MIT 可信度高，Gemma 那个必须核）。

---

## 9. 用户裁定之后的定案表（2026-08-09）

**用户规则**：GPL → 仍然下载；非 GPL → 内置。
**Manager 补的第二根轴**：**非 GPL 但巨大的仍然下载**。两条**同时满足**才内置。

### 9.1 「体积可控」的界线：**用数据画，不是拍脑袋**

把所有候选项按体积排开，**中间有一个 10 倍的空档**：

```
最大的“该内置”候选   yt-dlp linux      39.9 MB
                     whisper Vulkan     29.5 MB
                     whisper-tiny-q5_1  32.2 MB
─────────────────────── 10× 空档 ───────────────────────
最小的“该排除”候选   标点 ct-transformer 298.6 MB
                     CUDA               677.9 MB
                     LLM              2 490+ MB
```

**界线画在 100 MB/项**：它落在空档正中，**上下各有 7.5 倍余量** ——
也就是说这条线不是"刚好卡住某一项"，任何一项体积翻 7 倍或缩 7 倍都不会改变归属。
**这是数据本身给的分界，不是我选的数。**

### 9.2 逐项定案

| 项                               | 许可证（**核过**）                    | 体积           | 定案                 | 理由                                            |
| -------------------------------- | ------------------------------------- | -------------- | -------------------- | ----------------------------------------------- |
| whisper.cpp CPU 引擎             | MIT                                   | 2.0–6.8 MB     | **已内置**           | ——                                              |
| **yt-dlp**                       | **Unlicense**（实测 LICENSE，非 GPL） | 18.2–39.9 MB   | **内置**             | 非 GPL ✔ 体积 ✔ ⚠️ 二进制内嵌依赖待清点（§1.1） |
| whisper Vulkan（win/linux）      | MIT                                   | 25.1 / 29.5 MB | **内置（各带各的）** | 非 GPL ✔ 体积 ✔                                 |
| whisper Metal（mac）             | MIT                                   | 2.0 MB         | **内置**             | 几乎免费                                        |
| **whisper CUDA**                 | MIT                                   | **677.9 MB**   | **下载**             | 非 GPL 但**超线 6.8 倍**                        |
| **ffmpeg / ffprobe**             | **GPL-3.0**（gpl 构建）               | 32.9–167.4 MB  | **下载**             | **GPL —— 用户规则直接判定**                     |
| libsimple / sqlite-vec           | MIT                                   | ——             | **已内置**           | 构建期入包（§1.2）                              |
| **VAD `silero-vad-ggml`**        | MIT                                   | **0.9 MB**     | **内置**             | 非 GPL ✔ 体积 ✔ 缺它切分降级                    |
| **默认 ASR `whisper-tiny-q5_1`** | MIT                                   | **32.2 MB**    | **内置**             | 见 §9.3                                         |
| 标点 ct-transformer              | Apache-2.0                            | 298.6 MB       | **下载**             | 非 GPL 但超线 3 倍                              |
| paraformer-zh（中文）            | Apache-2.0                            | 81.9 MB        | **待定**             | 在线内（81.9<100）但只服务中文，见 §9.4         |
| 其余 ASR / LLM                   | MIT / Apache-2.0 / **Gemma-ToU**      | 59.7 MB–5 GB   | **下载**             | 超线；Gemma 那个另有条款                        |

### 9.3 默认内置哪个 ASR：**`whisper-tiny-q5_1`（32.2 MB, MIT）**

理由（不是挑最小，是挑**能证明"开箱可用"**的最小）：

- 它是清单里**唯一被 CI 真跑通过转写的**那一个（我那条 e2e 腿三平台都用它，
  实测能从 5 秒音频转出非空文本）——**已知它能跑，不是推测**。
- 32.2 MB 让三平台包体都停在 **150 MB 以内**（§9.5）。
- MIT，无附加条款。
- ⚠️ **它的识别质量只够证明"通了"**，不够日常用。所以**首屏必须明说
  「已内置一个最小模型，可以直接试；要好效果去『模型』页装更大的」** ——
  否则用户会拿 tiny 的结果判断产品质量。**这句话不写，内置反而是负分。**

### 9.4 `paraformer-zh-small` 待定（81.9 MB）

它在 100 MB 线内，但**只服务中文**。内置＝让所有英文用户也背 82 MB。
**这是产品取舍不是工程取舍，留给用户裁。**（若产品定位是中文优先，它该内置。）

### 9.5 定案之后的三平台体积

|       | 今天    | 定案后       | 增量   |
| ----- | ------- | ------------ | ------ |
| linux | 43.0 MB | **145.5 MB** | +102.5 |
| win   | 51.4 MB | **127.8 MB** | +76.4  |
| mac   | 62.8 MB | **136.2 MB** | +73.4  |

（＝当前包 + yt-dlp + 本平台 GPU 后端 + VAD 0.9 + tiny 32.2；下载体积上界估算，
实际打包会略小。`[未验证]` 没有真打包量过。）

**三平台全部落在 150 MB 以内**，而**换来的是**：链接导入、GPU 加速、语音切分、
以及**首次运行就能转出字** —— 全部开箱即用。**只剩 ffmpeg 一个要下载。**

### 9.6 ⚠️ ffmpeg 仍然下载 ⇒ 安装器那条路**不许退化**

它现在同时是 **GPL 合规路径**和**更新路径**。这一轮修好的东西
（死按钮、`void mutateAsync`、SSE 抢跑、`writeSidecar` 竞态、进度阶段）**一样都不能回退**。
⚠️ 新增内置产物必须有**一条腿在真包上**证明：解压之后它**真的在那儿、真的被找到、真的能跑**
—— 不是在源码树上测（这一轮五类"CI 结构上看不见"全部出在这个缝里）。

### 9.7 若要连 ffmpeg 也内置：先做 §2.3 那三项实测

`[实测]` BtbN **确实发 lgpl 变体**，而我们对 ffmpeg 的全部用法是
**解码 → 单声道 16 kHz PCM**（`-c:a pcm_s16le -ar 16000 -ac 1 -vn`），
**不编码 H.264/MP3** —— 正是 GPL 组件所在的另一侧。
**所以"ffmpeg 必须 GPL"很可能不成立。** 但在 §2.3 三项实测做完之前，
**按用户规则它就是 GPL，就得下载**。⚠️ **不为了想要的结论去凑。**

---

## 10. ① paraformer 到底是不是 F3 的必需件 —— **不是**（核过，过程如下）

Manager 给的判据：**离了它 F3 还能不能工作**。能顶 → 不内置；开箱即死 → 内置。

**核的过程**（三步，都是读产品自己的代码）：

1. `apps/daemon/src/ws/recorder.ts:203` —— 流式会话**写死** `engineId: 'sherpa-onnx'`。
   所以 F3 实时**不走 whisper**，"whisper 顶上"这条路**在代码层面就不存在**。
2. `apps/daemon/src/pipeline/setup.ts:866` —— 流式那一路要的模型是
   **`modelId: 'streaming-zipformer-zh-14M'`**。
3. `apps/daemon/src/ws/recorder.ts:155` —— 缺它时的行为是
   `messageZh: '流式识别引擎不可用（未安装流式模型）'`，会话**开不起来**
   （另有用例钉着"开不起来就不许留下一条『就绪』的死笔记"，T-164 ②）。

### 结论：**问题里的那个模型问错了**

- **`paraformer-zh-small`（81.9 MB）不是 F3 的必需件** —— 它是**离线**中文识别的质量档，
  F3 实时根本不调它。→ **不内置**（只服务中文，且"内置是为了跑得通不是效果好"）。
- **真正让 F3「开箱即死」的是 `asr/sherpa-streaming-zh-14m`（25.4 MB，Apache-2.0）** ——
  就是上面那个 `streaming-zipformer-zh-14M`。**它符合 Manager 给的内置条件**：
  非 GPL ✔、25.4 MB 远在 100 MB 线内 ✔、**缺了 F3 整条功能开箱即死** ✔。

⚠️ **这是这一轮第三次"给我的清单本身有错"**（前两次：yt-dlp 的证、libsimple 已内置）。
我把它写在这里，不是邀功，是因为**照单填表会得到一个错的决定**：
按原问题只会讨论"要不要背 82 MB 的中文模型"，而真正该问的是
"要不要为 F3 背 25.4 MB" —— **两个问题的答案相反**。

### 对体积的影响

若采纳「内置 sherpa-streaming-zh-14m」：三平台各 **+25.4 MB**
→ linux **170.9** / win **153.2** / mac **161.6** MB（仍全部 ≤ 175 MB）。
⚠️ `[未验证]` 我**没有实测过 F3 在只装这一个流式模型时能不能真的转出字** ——
判据应当是真跑一次录音，不是"文件在那儿"。**这一条必须在实现时补上。**

⚠️ **待用户裁**：为 F3「开箱即用」多背 25.4 MB，值不值。
我给的是判据与数字，**不替他决定**。

---

## 11. 实现前必须先定的两件事（`prebuilt` 2026-08-09 补，**含一个会改变工作量估计的发现**）

### 11.1 ⚠️ 「内置模型」**不是** `build-bundle.mjs` 一个文件的改动

`[实测 2026-08-09]` 两条查证：

```
grep -rn "BUNDLED_MODELS|bundledModels|resolveBundledModel" apps/daemon/src packages/*/src → 0 命中
包内目录结构 → 没有 models/
```

**模型的唯一发现路径是 `ArtifactStore`，它只认数据目录下的 `blobs/` + `manifests/`。**
`smallestInstalledModel(layout.modelsRoot)`、自检的 `model`、ASR 选型、
`/api/models/catalog` 的 `installed` —— **全部读那一处**。

⇒ 只把 55.7 MB 的模型字节塞进包里，**产品一个都读不到**。
那正是本仓最贵的形状：**内置了、但用不了，而且没有任何一处会报错**
（与「探针在包里但自检看不见」「whisper-cli 在包里但 `fromBundle` 只认环境变量」同族，
这已经是第三次了）。

**所以工作量不是"改打包脚本"，是"打包 + 一条模型的解析/落地路径 + 三平台取证"。**

### 11.2 建议的形状：**首次运行把包内模型「装」进数据目录**，而不是加第四条解析路径

两条路，我推荐后者：

|                             | 加一条"包内模型"解析路径                                         | **首次运行导入 store（推荐）**           |
| --------------------------- | ---------------------------------------------------------------- | ---------------------------------------- |
| 改动面                      | `ArtifactStore` 的每一个读取方都要再认一个来源                   | 只在启动时做一次导入                     |
| 「装没装」                  | **又多一个答案** —— `installed:false` 但能用                     | **只有一个答案**：导入后它**真的**装好了 |
| 卸载 / 更新 / 自检 / 目录页 | 每一处都要单独适配                                               | **全部不用改**，因为记录是真的           |
| 与既有规矩                  | 与 `backendReconcile.ts`「**装没装只准有一个回答的人**」**冲突** | 相容                                     |

**做法**：包内放 `models/<id>/<file>`；daemon 启动时若 store 里没有该 id，
就按 `installer.ts` 现成的落点约定写入（**优先硬链、跨文件系统再退回复制**，
`ArtifactStore.linkByName` 已经是这个形状），然后写一份**诚实的**安装记录
（`sha256` **现算**、`installedAt` 取文件 mtime、`selfTest: null`）——
这几条 `backendReconcile.ts` 已经立过规矩，**照抄，别发明第二套**。

⚠️ 代价必须写下来：**字节会在包内与数据目录各存一份**（约 56 MB），
除非用硬链且同盘。**这一条要 Manager 拍板**：接受双份，还是首次运行后删包内那份
（后者会让包不可重复解压使用）。

### 11.3 「检测更新依赖」的信任模型（用户要的另一半）

目录**随包出厂、出厂即冻结**。要检测更新就必须有个**远端**可问，
而那条线（`loadManifest` / `verifyCatalogSignature`）**这一轮刚被当死代码删掉**。

接回来**不是纯工程决定**：

> **远端目录 = 我们在用户装完之后，仍然能改变他机器上会被下载/执行的东西。**

所以它必须满足三条，缺一条都不该接：

1. **签名**：远端目录必须带我们私钥的签名，客户端**钉死公钥**校验
   （`verifyCatalogSignature` 原本就是干这个的，删掉的是实现不是需求）；
2. **失败即回退**：拿不到 / 验签不过 → **用包内那份**，而不是"没有目录"
   （今天用户撞到的 `packs 0` 就是"没有目录"的样子）；
3. **只增不改已钉死的**：远端目录**不许**改已内置项的 sha256 ——
   否则"内置"这个词就不成立了。新增项才允许来自远端。

⚠️ **在这三条落地之前，"检测更新"应当只做到「告诉用户有新版本」，不自动改任何东西。**

### 11.4 我这一轮**没做**的（如实登记）

- 上述任何代码**都没写**（`build-bundle.mjs` 一行未改）。
- 三平台体积、首次运行转出文本、F3 只装流式小模型能转字 —— **一个都没测**。
- `yt-dlp` 按 Manager 的发布阻断条件，**本来也不该在清单出来前打进包**。
- 原因：我的上下文预算在本轮开始时就已接近尾声，
  **而 11.1 那个发现把工作量从"改一个脚本"抬到了"跨 daemon 的一条新路径 + 三平台取证"**。
  在这个预算下动 `build-bundle.mjs` 与 daemon 启动路径，交付的会是没验过的东西。

## 12. 与 memo 的对照（`memo-compare` 2026-08-09，**取证驱动，未改本文任何决策**）

完整取证见 `docs/research/memoac/BUNDLED-DEPS.md`（数据源：Windows 包 v1.7.5 的
完整文件清单，解包后 1.10 GB；只读清单、未运行其二进制）。**这里只放会影响本文判断的三条。**

### 12.1 ⚠️ 本文的前提要限定：**memo 不内置转写模型**

`[已核实]` memo 全包**零个** `ggml-*.bin` 权重；`presets/whisper-models.js` 里
**15 个 whisper 模型条目每一个都带 `downloadLink`**，首次运行必须下。
包里那 20.1 MB 权重全是**辅助模型**（OCR 11.9 MB / VAD 1.5 MB / jieba 3.7 MB 分词表）。

⇒ **「memo 是开箱即用的」指的是"工具链开箱即用"，不是"转写开箱即用"。**
两边都要下模型，差别只在**要不要下引擎**。

**对本文的影响**：§9 定案里内置 `whisper-tiny-q5_1`(32.2 MB) 这条 ——
**它让我们在这一点上比 memo 更开箱即用**，是加分项；
但它的理由**不能写成"memo 也这么做"**，因为 memo 没这么做。**理由要另找。**

### 12.2 ffmpeg：memo 内置了 194.7 MB，且**看不到任何 GPL 合规动作**

`[已核实]` `addon/ffmpeg/ffmpeg.exe` 131.67 MB + `ffprobe.exe` 63.06 MB；
而全包**只有 3 个许可证文件**（Electron / Chromium / 一个 npm 包）——
**没有 ffmpeg 的 LICENSE、没有 COPYING、没有源码 offer。**
（`UNKNOWN` 它是 GPL 还是 LGPL 构建 —— 要读版本 banner，需运行二进制，本轮纪律禁止。）

⇒ **本文"ffmpeg 继续下载"的决定，被这条取证支持而不是动摇。**
memo 的做法**不能当作"可以内置"的先例** —— 那不是一条更聪明的路，是一条没做的功课。

### 12.3 cublas：**不推翻 100 MB 界线，但暴露一个我们没查过的问题**

|      | 包内 CUDA                                                          | 做法                                              |
| ---- | ------------------------------------------------------------------ | ------------------------------------------------- |
| memo | **18.2 MB**（压缩 7z，解开约 107 MB，内含 `ggml-cuda.dll` 103 MB） | 只放编译好的 ggml-cuda，**CUDA 运行库让用户另下** |
| 我们 | `whispercpp-cuda-12.4-win-x64` **677.9 MB**                        | 运行库**随包分发**                                |

**差 6 倍不是打包技巧，是装的东西不同。** memo 能塞进箱子，是因为它把
约 560 MB 的运行库推给了用户 —— 那正是我们要避免的"多一个可失败环节"。
**所以界线不用改。**

⚠️ **但有一个真问题，本文没答过**：我们那 678 MB 里到底有多少是 CUDA 运行库、
**是否必须随包分发**？`UNKNOWN`。如果大头也是运行库，那"CUDA 要不要进箱子"
就变成了和 memo 同一道选择题，而不是一个体积问题。**建议单独查一次。**

### 12.4 一条反面参考（别抄）

`[已核实]` memo 的 **Windows** 包里塞了 **130 MB 的 macOS `.dylib`**
（`sherpa-onnx-darwin-arm64` 70.8 MB + `sherpa-onnx-darwin-x64` 59.2 MB）——
Windows 用户永远用不到。**1.10 GB 里有 12% 是别的平台的二进制。**
我们按平台切包时，这类"整包塞进去"的省事写法要有守卫挡住。

## 13. §2.3 三项实测（`lgpl-verify` 2026-08-09，**真跑二进制，不是读 configure 猜**）

**一句话结论：Linux 上 19/19 全部实测通过（含远端协议、切片、ffprobe）；Windows 同源同
commit 但本轮没能在沙箱里真跑（无 wine）；macOS 当前供应商（jellyfin-ffmpeg）根本不发
LGPL 变体 —— 这不是配置问题，是供应商缺口。§9 的"ffmpeg 下载"定案本节不改，只交测试
结果，换不换由 Manager/用户在读完平台缺口后裁。**

### 13.1 方法：真下载、真跑产品的真命令行

`[实测]` 从与当前 `vendor/manifests/backends.json` 里 Linux/Windows 那两个 GPL 包**完全同一个
release tag、同一个 FFmpeg 源码 commit** 的 BtbN 发布里，另外下载 `lgpl` 变体：

```
release tag: autobuild-2026-07-31-14-10
commit:      n8.1.2-34-g9b6c8969e0
linux64-lgpl-8.1.tar.xz  111,679,252 字节（实际下载，非声明值）
```

解压后 `bin/ffmpeg`、`bin/ffprobe` 与 `LICENSE.txt`（**实测确为 GNU LGPL v3 全文**，非 GPL）。
`ffmpeg -version` 的 `configuration:` 行**实测**带 `--enable-version3` 与
`--disable-avisynth --disable-frei0r --disable-libdavs2 --disable-librubberband
--disable-libvidstab --disable-libx264 --disable-libx265 --disable-libxavs2 --disable-libxvid`
—— 与 FFmpeg 自己 `LICENSE.md` 列的 GPL-only 组件清单一致，且**全部落在编码器/滤镜侧**。

用 `packages/shared/src/media-extensions.ts` 的 `UPLOAD_MEDIA_EXTENSIONS`
（**独立重新从源码 grep 出来的，不是抄 D-20 已有的清单**，两者核对后确实一致）逐个格式各造
一份约 2 秒的样本（视频轨用 h264/xvid/vp9/mpeg1/mpeg2/flv/wmv2 等真实编解码器组合，
不是同一种编码器套 19 个壳），再用 `packages/pipeline/src/audio/ffmpeg.ts` 里
**逐字抄下来的产品真实 argv**（`normalizeToPcm16k`／`sliceWav`／`probeMedia`）跑这份 LGPL 二进制。

### 13.2 结果：19/19 全过，且不是"文件非空"这么弱的判据

判据不是"退出码 0"或"文件存在"，是 `ffmpeg -af volumedetect` **实测量出的平均电平**
（真的解出了声音，不是产出一个只有 WAV 头的空壳）：

| 扩展名 | mean_volume | 扩展名 | mean_volume | 扩展名 | mean_volume |
| --- | --- | --- | --- | --- | --- |
| .mp3 | -21.5 dB | .mp4 | -21.1 dB | .mpg | -21.1 dB |
| .m4a | -21.1 dB | .m4v | -21.1 dB | .flv | -21.6 dB |
| .wav | -21.1 dB | .mkv | -21.1 dB | .wmv | -21.2 dB |
| .flac | -21.1 dB | .mov | -21.1 dB | .ts | -21.2 dB |
| .ogg | -21.0 dB | .avi | -21.6 dB | | |
| .opus | -21.1 dB | .webm | -21.1 dB | | |
| .aac | -21.2 dB | .mpeg | -21.1 dB | | |
| .wma | -21.2 dB | | | | |

**19/19 全部产出非静音 PCM。** 没有一个扩展名解不出来 —— GPL-only 的那几个组件
（avisynth/frei0r/libdavs2/librubberband/libvidstab/libx264/libx265/libxavs2/libxvid）
**确实都在编码/滤镜侧，不在我们唯一用到的解码路径上**，§2.1 的判断被实测坐实，不是推测。

另外三条也实测过，不是只测了本地文件解码：

- **`sliceWav`（`-ss`/`-t`）**：`mp3_sliced.wav` 同样非静音，切片正常。
- **`-protocol_whitelist` 远端路径**：`probeMedia` + `normalizeToPcm16k` 带
  `REMOTE_PROTOCOLS`（`https,tls,tcp,crypto,httpproxy`）实测对一个真实公网 HTTPS
  mp3（`interactive-examples.mdn.mozilla.net`）取流成功，`remote.wav` mean_volume
  **-24.8 dB**（非静音）。**顺手做的安全回归**：同一份 LGPL 二进制上，把 URL 换成
  `http://`（明文）时**实测被拒**——`Protocol 'http' not on whitelist 'https,tls,tcp,crypto,httpproxy'!`，
  退出码 234，**没有产出任何输出文件**——白名单在 LGPL 构建下行为不变。
- **`-map`**：`normalizeToPcm16k` 每一次调用都带 `-map 0:a:0`，上面 19 条本身就是带
  `-map` 跑的，不是单独一条。
- **`ffprobe`**：19 个样本逐个跑 `probeMedia` 的真实 argv，**JSON 全部可解析**且
  `streams` 里能正确识别出各自的视频/音频编解码器（如 `v.mp4` → `format=mov,mp4,m4a,3gp,3g2,mj2`,
  `streams=[('video','h264'),('audio','aac')]`）；远端路径下 `ffprobe` 对同一个 HTTPS mp3
  也正确识别出 `format=mp3, streams=[('audio','mp3')]`。**ffprobe 与 ffmpeg 两个二进制都测了，
  不是只测了 ffmpeg。**

⚠️ `[已知，非本轮新增]` §2.3③ 提前警告过的副作用**确实存在**：`scripts/ci/e2e-import-audit.mjs`
用 `libmp3lame`/`libx264` **编码**造测试样本，LGPL 构建没有这两个编码器，那条 CI 腿会当场坏。
**产品本身不受影响**（产品只解码），但如果真的换 LGPL，那个脚本的造样本方式要改
（本轮的样本改用系统另一份 GPL 构建生成，CI 脚本本身**一行没动**，因为纪律不许碰产品/脚本代码）。

### 13.3 LGPL 义务分析：subprocess ≠ 链接，但"分发"本身的义务还在

`[已核实]` `packages/pipeline/src/subprocess/runner.ts` 唯一的子进程调用方式是
`spawn(absoluteBin, argv, { shell: false })`；全仓 TS 源码里没有 `dlopen`、没有对
`libavcodec`/`libavformat`/`libavutil` 的任何链接（无论静态还是动态），ffmpeg/ffprobe
永远是**独立可执行文件**，通过命令行参数与我们的代码通信。

这一点法律上是否重要，**不是我能替用户/法务下最终结论的问题**（§8 那条 `UNKNOWN`
仍然是 `UNKNOWN`，本节不改它），但可以把已验证的事实和 FSF/LGPL 文本本身摆出来：

- **LGPL v2.1 §6（以及 v3 的对应条款）字面上是"链接"触发的**——它管的是把
  proprietary 的 "work that uses the Library" 与 Library **link** 到一起时，
  必须允许用户替换/重链接这个 Library。我们**没有 link** 这个 Library
  （无论静态动态），只是 `spawn` 一个独立可执行文件，把参数摆上命令行、
  从 stdout/文件读结果——这正是 FSF GPL FAQ 里 `#MereAggregation` / `#GPLPlugins`
  等条目描述的"通过管道/命令行通信的独立程序"的形态，不是"合并成单一作品"的形态。
- **即便如此，"分发一份 LGPL 程序的拷贝"本身的义务不会消失，也不该被这一节的
  论证悄悄抹掉**：附带许可证全文、保留版权声明、（若被问起）能提供对应版本的源码
  或指向上游源码的位置。这些是**分发 ffmpeg 这个可执行文件**的义务，
  与"我们的应用是不是被认定为衍生作品"是两件事——前者几乎零成本能满足
  （§13.2 已确认 `LICENSE.txt` 就在压缩包里，原样带上即可），后者才是那个 `UNKNOWN`。
- **"允许用户替换库"这条 LGPL 的核心诉求，在我们这个形态下天然更强**：ffmpeg 以
  独立可执行文件的形式放在自己的目录里，用户/我们随时可以整个换掉这个文件
  （不需要重新链接、不需要重新编译应用本体）——这比 LGPL 要求的"可替换的共享库
  机制"提供的保证更直接。

### 13.4 平台覆盖：不是三个平台同一个答案

| 平台 | 供应商 | 与当前 GPL 包同源同 commit 的 LGPL 资产 | 本轮验证方式 |
| --- | --- | --- | --- |
| **Linux x64** | BtbN | `ffmpeg-n8.1.2-34-g9b6c8969e0-linux64-lgpl-8.1.tar.xz`，**实测存在，已下载并逐项跑通**（§13.1–13.2） | **实机跑过 19/19 + sliceWav + 远端 + ffprobe** |
| **Windows x64** | BtbN | `ffmpeg-n8.1.2-34-g9b6c8969e0-win64-lgpl-8.1.zip`，`[实测]` 该 release tag 下**确实存在**这个资产（GitHub API 核实过文件名与字节数） | ⚠️ **本轮没有真跑**——沙箱里没有 `wine`（`apt-cache policy wine` 显示未安装），装新系统包超出"只验证不改动"的授权范围，没有强行装。**同源同 commit，理论上应与 Linux 结果一致，但这是推断，不是实测**，如实标注，不冒充测过。 |
| **macOS arm64/x64** | **jellyfin-ffmpeg**（不是 BtbN，供应商本身不同） | `[实测]` 查了 `jellyfin/jellyfin-ffmpeg` 在 `v8.1.2-2`（与 `backends.json` 当前 macOS 那条完全同版本）下的**全部**发布资产（deb ×12、portable ×6，覆盖 linux/mac/win 全部目标）——**没有一个文件名带 `lgpl`，只有 `-gpl` 后缀**。 | **无法验证，因为不存在**——这不是"没跑"，是这条路目前**根本没有 LGPL 选项**。换 LGPL 对 macOS 意味着**换一个完全不同的上游供应商**（比如换回 BtbN，但 BtbN 不发 macOS 资产；或自己交叉编译一份），工作量和风险都远大于"改一个 URL"。 |

### 13.5 体积对比（供 Manager/用户判断"值不值得换"用，不是结论）

| 平台 | 当前 GPL 包（manifest 声明值） | 同源 LGPL 包（**实测下载值**） | 差 |
| --- | --- | --- | --- |
| Linux x64 | 124,917,816 字节（119.1 MB） | 111,679,252 字节（106.5 MB） | **-12.6 MB（-10.6%）** |
| Windows x64 | 167,405,723 字节（159.7 MB） | 145,349,121 字节（138.6 MB）`[实测資產存在，字节数经 GitHub API 核实，未下载执行]` | **-22.1 MB（-13.2%）** |
| macOS arm64 | 32,894,656 字节（31.4 MB，jellyfin-ffmpeg） | **不存在** | — |

体积差不大（多数字节是编解码器共用代码，x264/x265/xvid 只是其中一部分），
**换 LGPL 省下的是"能不能不下载"的资格，不是显著的包体空间**。

### 13.6 本节明确没做、没改的事（如实登记）

- **产品代码一行没动**——`packages/pipeline`、`packages/shared`、`build-bundle.mjs`、
  任何 CI 脚本，全部只读，未写。
- **没建/改/删任何 release**；未碰 `:10000` demo、`/root/data-memo`、任何机器级指针；
  未用过 `pkill`。
- **没有改动 §1–§12 任何一条已有决策或定案表**——§9.2「ffmpeg / ffprobe → 下载」
  在本次提交后依然是当前定案；本节只是把 §9.7/§2.3 点名要做的三项实测结果交出来，
  换不换、Windows 那条要不要补测、macOS 那道供应商缺口怎么办——**都交 Manager/用户裁**，
  不在这里替他们改 §9。
- **Windows 未实机验证**（无 wine，未装新工具链去凑）、**macOS 无 LGPL 可换**——
  这两条是本节交出的"限制"，不是"待办打勾"，务必在转达结论时一并带上，
  不能只说"Linux 过了"就让人以为三平台都能换。

---

## 14. yt-dlp 二进制内嵌依赖清点 —— §1.1/§8/§9.2 点名要的那份清单（`ytdlp-binary-audit` 2026-08-09，静态提取四平台二进制，未运行目标二进制）

**一句话结论（跟 §9.2 冲突，本节不改 §9.2，交 Manager/用户裁）：二进制里有 GPL。四平台
全部内嵌 `mutagen`（GPL-2.0-or-later），Linux x64/arm64 两个平台额外内嵌真正的 GNU
Readline（GPL-3.0-or-later，不是 libedit 替代品）。按 TL;DR 与 §9 开头用户自己定的规则
「GPL → 仍然下载；非 GPL → 内置」，这条规则问的是"这份要分发的字节里有没有 GPL"，不是
"上游项目主许可证是什么"——对 yt-dlp 这个二进制 pack 而言，答案是有，判定应为**下载**，
与 §9.2 表格当前写的"内置"矛盾。**本节不替换 §9.2 的结论，只把冲突摆出来。**

### 14.1 方法

- 直接用 `vendor/manifests/backends.json` 当前 pin 住的 4 个 `ytdlp-*` 资产
  （`engineVersion: 2026.07.04`），逐个下载后 `sha256sum` 核对与 manifest 完全一致
  （4/4 字节级 match，不是信任 manifest 里写的哈希）。
- 用 `pyinstxtractor.py`（extremecoders-re/pyinstxtractor v2.0）**静态**解包 PyInstaller
  onefile 归档 —— **全程未运行任何一个目标二进制**。Linux x64/arm64、macOS 三平台的
  PYZ 内部 Python 字节码完整反编译到目录树；Windows 因二进制是 **CPython 3.10** 构建，
  而本沙箱环境是 Python 3.14（`marshal` 版本不兼容，且 `apt-get install python3.10` 在
  本沙箱不可用），改用对 `PYZ.pyz` 原始字节做 `strings` 扫描核对 PyInstaller 目录表里
  的模块名明文 —— **这一条置信度低于其余三平台，逐条标注，不冒充同等强度**。

### 14.2 结论 A（阻断性）：`mutagen`，GPL-2.0-or-later，四平台全部命中

| 平台         | 证据                                                                                                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| linux-x64    | `PYZ.pyz_extracted/mutagen/` 目录存在（完整反编译，`find` 直接命中）                                                                                                |
| linux-arm64  | 同上，独立解包核实                                                                                                                                                  |
| macos-arm64  | 同上，独立解包核实                                                                                                                                                  |
| win-x64      | `strings -n6 PYZ.pyz` 命中 **48 处** `mutagen.*` 字符串（`mutagen._constants`／`mutagen.aac`／`mutagen.asf.*` 等一批合法子模块名，非随机撞字），`PYZ.pyz_extracted` 因版本不兼容未完整反编译。`[置信度略低于其余三平台，但证据落在 PyInstaller 目录表的明文层，伪造概率极低]` |

许可证本身用两条独立来源核实（不是只信一处）：① PyPI `mutagen` 包的 `license_expression`
元数据；② 上游 `github.com/quodlibet/mutagen` 在对应版本 tag 下 `COPYING` 文件的正文——
确为 GPL-2.0-or-later 全文。mutagen 在 yt-dlp 里用于读取媒体文件标签/元数据，**但它是无
条件被打进四平台 PyInstaller 归档的**，不是"按需 import 才触发"——打包那一刻起就已经是
二进制字节的一部分，不需要用户触发任何特定功能。

### 14.3 结论 B（平台限定）：GNU Readline，GPL-3.0-or-later，仅 Linux 两个平台

| 平台        | 是否内嵌  | 证据                                                                                                                                                             |
| ----------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| linux-x64   | **是**    | `libreadline.so.6` 位于归档顶层；`nm -D` 命中 `rl_gnu_readline_p` 符号（这是真 GNU readline 独有的符号，libedit 的仿真层没有它）；`strings` 命中版权/GNU 字样 |
| linux-arm64 | **是**    | 同上，独立解包核实                                                                                                                                              |
| macos-arm64 | **否**    | `readline.cpython-314-darwin.so` 动态链接到 `/usr/lib/libedit.3.dylib`（macOS **系统自带**，BSD 许可，未被内嵌进包内）；`strings` 命中 `_libedit_version_tag`／`_using_libedit_emulation` —— 是 libedit 仿真层，不是真 GNU readline |
| win-x64     | **否**    | `PYZ.pyz` 原始字节 `strings` 扫描 **0 处** `readline`／`pyreadline` 字符串；Windows CPython 标准库本来就不带 `readline` 模块，符合预期                          |

### 14.4 非阻断项：MPL-2.0 / Apache-2.0 组件与告知义务（供写 NOTICES 时用）

| 组件                                                            | 许可证                                                                              | 覆盖平台                                                                    | 义务                                                    |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------- |
| certifi                                                            | **MPL-2.0**（文件级弱 copyleft，未修改其源码）                                        | 4/4                                                                           | 附许可证正文 + 声明使用了该文件；不要求公开我们自己的源码   |
| requests                                                           | Apache-2.0                                                                             | 4/4                                                                           | 附 LICENSE（+ NOTICE，若上游带）                             |
| packaging                                                          | Apache-2.0 OR BSD-2-Clause（双许可）                                                   | 4/4                                                                           | 同上                                                          |
| cryptography                                                       | Apache-2.0 OR BSD-3-Clause（双许可，含 Rust 组件）                                     | **仅 linux-x64/arm64**；macOS/Windows 改用 Cryptodome + 标准库 `ssl`，不含此包 | 附许可证正文                                                 |
| OpenSSL                                                            | 3.x 系 Apache-2.0；1.1.x 系 OpenSSL/SSLeay 双许可（老文本）                            | linux/macos 用 `libssl.so.3`／`libssl.3.dylib`（3.x）；**win 用 `libssl-1_1.dll`／`libcrypto-1_1.dll`（1.1.x，版本线不同）** | 附**对应版本**许可证正文，三平台不能只抄一份                 |
| `yt_dlp_ejs/yt/solver/{core,lib}.min.js`（内嵌 JS 求解器，D-20 §1.1 写成单一 Unlicense） | **不是单一 Unlicense** —— 压缩包内明文可见混入至少一段 **ISC License**（`Copyright (c) 2015, David Bonnet`）与一段 `Copyright (c) 2019 and later, KFlash and others.`，外加 Unlicense 字样，是多个 JS 库打包进一个 min.js 的复合许可证 | 4/4                                                                           | 均为宽松许可证，不阻断；但附件里要列复合清单，不能只写"Unlicense" |
| CPython 运行时本体                                                 | **PSF License**（宽松，类 BSD）                                                        | 4/4                                                                           | 附 PSF LICENSE 正文；无阻断义务                              |

### 14.5 次级项：未逐一重新核实，低优先级、如实标注

以下原生库按公开常识判断为宽松许可证：zlib/zstd 系（zlib 许可）、bzip2（BSD 系）、liblzma
（公有领域/0BSD）、libffi（MIT）、mpdecimal（BSD）、util-linux 的 libuuid（BSD/MIT 双许可）、
glibc 附带的 `libgcc_s`／`libstdc++`（名义上 GPLv3，但受 **GCC Runtime Library Exception**
豁免其传染性，编译产物分发不受影响）。**`[未验证，低优先级]` 本轮没有逐个重新去官方仓库
核实版权文件**，只是基于二进制里看到的库名做的常识性归类，核实强度与 14.2/14.3 那两条
阻断性结论不在一个量级，不应混为一谈。

### 14.6 与 §9.2 的冲突（不改 §9.2 表格文字，写冲突交裁）

§9.2 当前那一行原文：`yt-dlp | Unlicense（实测 LICENSE，非 GPL）| 18.2–39.9MB | **内置** |
非 GPL ✔ 体积 ✔ ⚠️ 二进制内嵌依赖待清点（§1.1）`。

§1.1 与 §8 都明确把"二进制内嵌依赖清单"列为内置前必须做完的前置条件，**本节就是那份清单**，
交出的结果是：**条件没有通过**。二进制资产本身含有真实的、无条件被打包进去的
GPL-2.0-or-later 代码（mutagen，四平台），Linux 平台还额外多一条 GPL-3.0-or-later
（Readline）。按用户自己在 TL;DR/§9 定的规则，这应当把 yt-dlp 判回"下载"一栏，而不是维持
"内置"。

**本节不替换 §9.2 表格里的结论文字**，只在此把冲突摆出来 —— 是否要因此把 yt-dlp 从"内置"
改回"下载"，还是走工程规避（比如打包脚本里剔除 mutagen 依赖树、Linux 平台换成不带
readline 支持的构建），两条路径的代价都没有评估过，需要 Manager/用户拍板。

### 14.7 关于 `vendor/manifests/backends.json` 我为什么没有按字面要求去改

字面指令是把 4 个 `ytdlp-*` 的 `license.id` 从 `GPL-3.0-or-later` 改成 `Unlicense`（跟随
§1.1 的更正方向）。**没有照做**，原因：

1. 那会引入一个新的事实错误——14.2/14.3 证明这份要分发的二进制字节**确实含有** GPL 代码，
   单独把这个 pack 标成 `Unlicense` 是不准确的，比现在这个错误更具误导性（现在的
   `GPL-3.0-or-later` 虽然理由错了——它当初是把 yt-dlp 项目主许可证认错——但方向歪打
   正着是对的：这份二进制资产确实含 GPL）。
2. `LicenseInfoSchema`（`packages/shared/src/schemas.ts:206`）的 `license.id` 是单值字符
   串，直接被 UI 原样展示给用户（`apps/web/src/features/models/ModelDetailPage.tsx:98`、
   `ComponentCard.tsx:243` 是同一模式的先例）；`vendor/manifests/*.json` 全仓迄今没有一个
   复合许可证字符串的先例（都是单一 SPDX id，含 ffmpeg/sherpa/whisper 等全部条目核对过）。
   这个字段本身表达不了"上游项目是 Unlicense，但要分发的这份二进制资产里混了 GPL 依赖"这种
   组合事实——是清单 schema 的表达力缺口，不是我单方面发明一个复合字符串就能解决的。
3. 这个字段该填什么，取决于 §9.2 那个还没被裁定的架构问题。若最终裁定"下载"，这条 pack 记录
   大概率维持现状字面不必改（下载态的 GPL 资产在本仓的既有写法就是照抄上游主许可证，参照
   ffmpeg 那几条）；若裁定"内置"，需要的可能不是改一个字符串，而是给 schema 加一个"内嵌子
   依赖许可证清单"字段——这是代码改动，超出本节授权（只清点，不改产品/构建代码）。

**所以这里维持 `backends.json` 原字面不变**，把冲突和两条可能路径都摆在这里，交
Manager/用户与 §9.2 的裁定一起处理。同理未改 `docs/design/D-17-prebuilt-bundles.md:113`
（同样写着 GPL-3.0-or-later）——不在本次被指派范围内，且它当前取值的结论方向（GPL）与
本节的二进制层结论恰好一致，先不动，此处点名标注，留给持有那份文档的人处理。

### 14.8 本节没做的事（如实登记）

- **没有运行任何一个目标二进制**——全程静态提取，未执行。
- **没有修改 §1–§13 任何已有决策或定案表**；§9.2「yt-dlp → 内置」在本次提交后表格文字不变，
  冲突写在 14.6，不在此处替 Manager/用户下结论。
- **没有修改** `vendor/manifests/backends.json` 的 4 个 `ytdlp-*` `license.id` 字段——理由见
  14.7。
- **没有修改** `docs/design/D-17-prebuilt-bundles.md:113`——不在指派范围内，理由见 14.7 末尾。
- **没有创建** `THIRD-PARTY-NOTICES` 文件（`find` 遍历本仓 `dist/`／`.build/`／源码树，
  除 `node_modules/.pnpm/{prettier,rolldown}` 里两个同名无关文件外，**这份文件目前在这个
  checkout 里不存在**——与"已经在产物里"的说法对不上，如实记录这个出入，不是我漏找），
  也没有改 `scripts/build-bundle.mjs` 的 `writeNotices()`——它现在生成的文案明确写"包不含
  ffmpeg/yt-dlp，均在用户机器上按需下载"，这与"是否要内置 yt-dlp"是同一个悬而未决问题的
  下游；在 14.6 的冲突裁定之前动它，会把一个还没定案的架构决策悄悄焊死进构建脚本。
- **未建/改/删任何 release**；未碰 `:10000` demo、`/root/data-memo`、任何机器级指针；
  未用过 `pkill`（含 `-0`）。
- 14.5 的次级原生库清单**没有逐一重新核实**，明确标注为低置信度，不能当成和 14.2/14.3
  同等强度的结论使用。

---
