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
- ~~所以真正的 GPL 阻断只剩 ffmpeg 一个。~~ **2026-08-09 追加订正**：按"上游项目自己的许可证"算
  确实只有 ffmpeg；但 §14 发现 yt-dlp **官方二进制**里无条件内嵌 GPL 代码（mutagen 全平台，
  Linux 另加 Readline），Coordinator 据此把 §9.2 的 yt-dlp 定案由"内置"改判"下载"——
  **实际需要下载的 GPL 相关项其实是两个：ffmpeg 与 yt-dlp**，理由不同（前者项目本身就是
  GPL，后者是二进制内嵌依赖），结论相同（字节都不能进我们的产物）。
  ffmpeg 那部分**可能不成立**：BtbN 同时发 **lgpl 变体**，
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

**这条更正直接改变结论**：~~yt-dlp **内置不触发任何 copyleft 义务**。~~
⚠️ **2026-08-09 追加订正（§14 交卷后）**：上面这句话**在"项目源码许可证"层面仍然成立**
（yt-dlp 自己的代码确实是 Unlicense），**但在"我们要分发的那份二进制字节"层面不成立**——
§14 静态提取四平台官方 PyInstaller 二进制后证实：**二进制里无条件内嵌 `mutagen`
（GPL-2.0-or-later，四平台全部命中）**，Linux x64/arm64 额外内嵌 GNU Readline
（GPL-3.0-or-later）。据此 Coordinator 已将 §9.2 的 yt-dlp 定案由"内置"改判为"下载"
（理由与 ffmpeg 相同：字节不下载进我们的产物，就不构成 conveying）——详见 §9.2、§14.6。

⚠️ **但有一条必须先查清再动手**（我**没查完**，标 `[未验证]`）：
我们分发的是 **PyInstaller 单文件二进制**，它内嵌 CPython 与若干第三方库 ——
**源码是 Unlicense，二进制里那些库各有各的证**。yt-dlp README 自己列了一部分：
`certifi`（**MPL-2.0**）、~~`yt-dlp-ejs`（Unlicense）~~、`brotli` 等。
**内置前必须把该二进制的内嵌依赖清单逐个过一遍**（尤其有没有 GPL 的可选依赖被打进去）。
这是**可执行的一步**，不是"注意合规"。

⚠️ **`yt-dlp-ejs` 那一项本身也订正**：上面把它记成单一 **Unlicense** 不准确。
§14.4 逐个打开压缩包内的 `yt_dlp_ejs/yt/solver/{core,lib}.min.js` 后，明文可见
**至少三种版权/许可标注混在一起**：Unlicense 字样、一段 **ISC License**
（`Copyright (c) 2015, David Bonnet`）、以及一段独立的
`Copyright (c) 2019 and later, KFlash and others.`——是多个 JS 库打包进同一个
`min.js` 的**复合许可证**，不是单一 Unlicense。三者都是宽松许可证，**不构成新的阻断**，
但"单一 Unlicense"这个说法本身讲得过于简单，如实订正为复合。

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
| **yt-dlp**                       | 项目本身 **Unlicense**；⚠️ 但官方二进制内嵌 GPL（mutagen 全平台 GPL-2.0-or-later，Linux 另加 Readline GPL-3.0-or-later，见 §14） | 18.2–39.9 MB   | ~~内置~~ → **下载**（2026-08-09 Coordinator 改判，依据 §14；见 §14.6） | 二进制字节含 GPL，按用户规则（GPL → 下载）判不了内置；理由与 ffmpeg 相同：字节不经过我们就不构成 conveying |
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

⚠️ **2026-08-09 追加订正**：下表原本把 yt-dlp 算进"内置"，随 §9.2 改判为"下载"后
从合计里扣除（yt-dlp 各平台体积见 §4.1：linux 39.9 / win 18.2 / mac 38.3 MB）。
旧数字用删除线保留，新数字紧跟其后：

|       | 今天    | 定案后                            | 增量                     |
| ----- | ------- | ---------------------------------- | ------------------------ |
| linux | 43.0 MB | ~~145.5 MB~~ → **105.6 MB**        | ~~+102.5~~ → **+62.6**   |
| win   | 51.4 MB | ~~127.8 MB~~ → **109.6 MB**        | ~~+76.4~~ → **+58.2**    |
| mac   | 62.8 MB | ~~136.2 MB~~ → **97.9 MB**         | ~~+73.4~~ → **+35.1**    |

（＝当前包 + 本平台 GPU 后端 + VAD 0.9 + tiny 32.2；**不再含 yt-dlp**。下载体积上界估算，
实际打包会略小。`[未验证]` 没有真打包量过，也没有验证这个减法本身。）

~~三平台全部落在 150 MB 以内，而换来的是：链接导入、GPU 加速、语音切分、
以及首次运行就能转出字 —— 全部开箱即用。只剩 ffmpeg 一个要下载。~~
**2026-08-09 追加订正**：yt-dlp 改判"下载"后，**链接导入不再是开箱即用**——
和 ffmpeg 一样，用户首次用到"粘链接导入"这个功能时才会触发下载，走的是同一条
`POST /api/backends/install` 安装器路径。三平台体积仍在 150 MB 以内（见上表新数字），
换来的是 GPU 加速、语音切分、首次运行就能转出字——但不含链接导入。

### 9.6 ⚠️ ffmpeg／yt-dlp 都仍下载 ⇒ 安装器那条路**不许退化**

`[2026-08-09 追加]` 本节标题原来只提 ffmpeg；yt-dlp 改判"下载"后（§9.2），
下面这几条对 yt-dlp 同样成立，不是 ffmpeg 独有。

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

**一句话结论：Linux 上 19/19 全部实测通过（含远端协议、切片、ffprobe）；Windows 起初因
沙箱无 wine 未能验证，已于 2026-08-09 在真实 `windows-2025` GitHub Actions runner 上补测，
同样 19/19 全部通过（§13.7，判据与 Linux 那一轮逐条相同，未放宽任何一条）；macOS 当前
供应商（jellyfin-ffmpeg）根本不发 LGPL 变体 —— 这不是配置问题，是供应商缺口，本轮按指示
未触碰。§9 的"ffmpeg 下载"定案本节仍不改，只交测试结果，换不换由 Manager/用户裁。**

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
| **Windows x64** | BtbN | `ffmpeg-n8.1.2-34-g9b6c8969e0-win64-lgpl-8.1.zip`，145,349,121 字节，`[实测]` 已下载并核对字节数 | **实机跑过 19/19 + sliceWav + 远端 + ffprobe**（2026-08-09 补测，见 §13.7；GitHub Actions `windows-2025` 真机，判据与 Linux 那一轮完全相同，未放宽） |
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
- **Windows 已于 2026-08-09 在真实 CI（`windows-2025` runner）补测，19/19 通过**（§13.7）——
  不再是"待验证"；**macOS 无 LGPL 可换，本轮按指示未触碰**——这条仍是本节交出的"限制"，
  不是"待办打勾"，务必在转达结论时一并带上，不能因为 Linux/Windows 都过了就让人以为
  macOS 也能换。

### 13.7 Windows 补测（2026-08-09 追加，`windows-2025` 真机 CI，非本地沙箱）

`[实测]` §13.4 上一轮里 Windows 那格标的是"没条件测"（沙箱没有 `wine`），不是"测不过"。
本轮在真实 GitHub Actions `windows-2025` runner 上把它变成数：新增
`.github/workflows/ffmpeg-lgpl-verify.yml` + `scripts/ci/ffmpeg-lgpl-verify.mjs`
（仅 CI/脚本基础设施，**未改动任何产品代码**，`workflow_dispatch` 手动触发，不挂在任何
门禁上，不影响任何 release 流程）。判据与 §13.1–13.2 那一轮**逐条相同，未放宽任何一条**：

- 同一个 BtbN release tag（`autobuild-2026-07-31-14-10`）、同一个 FFmpeg 源码 commit
  （`n8.1.2-34-g9b6c8969e0`）——与 `vendor/manifests/backends.json` 里 Windows GPL 那条
  pin 住的完全一致，只换 gpl→lgpl 变体。GPL 构建（167,405,723 字节）只用于造样本，
  LGPL 构建（145,349,121 字节）才是被测对象；两者字节数在 CI 里先做下载校验，
  不一致直接 `exit 1`，不继续往下跑。
- LGPL 构建的 `LICENSE.txt` 头三行实测确为 `GNU LESSER GENERAL PUBLIC LICENSE
  Version 3`——不是信文件名/URL，是真的读了压缩包解出来的文件内容。
- 19 个扩展名（同样从 `UPLOAD_MEDIA_EXTENSIONS` 现场重新 grep 出来，不是抄清单）
  逐个用 GPL 构建现造样本，再用 LGPL 构建跑产品里逐字抄下来的真实 argv
  （`normalizeToPcm16k`），判据同样是 `volumedetect` 量出的真实电平，不是退出码/文件非空：
  **19/19 全部产出非静音 PCM**，`mean_volume` 分布与 Linux 那一轮同一量级（约 -20 ~ -25 dB）。
- `sliceWav`（`-ss`/`-t`）：`pass`，`meanDb=-21.5`。
- `ffprobe` 本地：19/19 JSON 全部可解析且正确识别各自的编解码器。
- `-protocol_whitelist` 远端：对同一个公网 HTTPS mp3（`interactive-examples.mdn.mozilla.net`）
  `probeMedia`/`normalizeToPcm16k` 均 `pass`，`mean_volume -24.8 dB`（非静音——与 Linux 那
  一轮同一份远端资源测出的 -24.8 dB 完全一致，两个平台独立取流结果吻合，顺带是一次交叉验证）。
- 明文 `http://` 回归：同一份 LGPL 二进制上把 URL 换成 `http://`，实测**仍被拒**
  （`Protocol 'http' not on whitelist`），白名单行为在 Windows 上与 Linux 一致，没有变松。

**CI 跑了两次，不是一次就绿**：第一次运行（run `31313423081`）在 LICENSE.txt 校验步骤就
失败了——不是判据被卡，是脚本自身的 bug：PowerShell 7 的 `Get-Content` 不允许同时给
`-Raw` 和 `-TotalCount`（本地沙箱没有 `pwsh` 7，这个 bug 只有真的在 Windows runner 上跑
才会暴露，属于"CI 结构上看不见"的又一个真实例子）。修好（改成
`(Get-Content ... -TotalCount 3) -join "`n"`）、按 §12 提交协议提交（commit `667caab`）、
rebase 检查、推送后，第二次运行（run `31313577280`，27 秒完成）**19/19 全部通过**，
结果 JSON 里 `overallOk: true`。结果 JSON 与生成的样本已作为 artifact
（`ffmpeg-lgpl-verify-win32-x64`）随 run 上传，供复核。

**结论：19/19（Linux）+ 19/19（Windows，真机 CI）——两个平台的 LGPL 解码覆盖面已用真实
二进制逐项验证完毕，判据全程一致，没有为了让 Windows"看起来过了"而放宽任何一条。macOS
按指示本轮未触碰（供应商缺口，见 §13.4，不是改个下载 URL 能解决的），§9.2「ffmpeg → 下载」
定案维持不变，是否换、是否值得为此单独解决 macOS 供应商问题，交 Manager/用户裁。**

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

**✅ 2026-08-09 已裁定（追加）**：Coordinator 拍板"下载"，明确拒绝工程规避路径
（理由：规避需要为四平台自建 yt-dlp，长期维护代价不可持续）。§9.2 表格文字已改，
§9.5/§9.6 的直接下游数字与结论也已同步更新。本条冲突到此**闭环**。

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

**✅ 2026-08-09 已执行（追加）**：§9.2 裁定"下载"之后，上面第 1 点的顾虑不再适用
（不再需要一个表达"内置但混了 GPL"的复合字段）。已按平台分别改：
`ytdlp-linux-x64`/`ytdlp-linux-arm64` 维持 `GPL-3.0-or-later`（对应 Readline，本来就对）；
`ytdlp-macos-arm64`/`ytdlp-win-x64` 改为 `GPL-2.0-or-later`（只含 mutagen，url 同步换成
GPL-2.0 文本）。取值口径：单值字段取"分发字节里实际出现的最强许可证"，逐平台判断——
仍然不引入复合字符串，第 2 点关于 schema 表达力缺口的判断依然成立，只是不需要为此改
schema 了。`docs/design/D-17-prebuilt-bundles.md:113` 一并订正，见该文件自己的改动记录。

### 14.8 本节没做的事（如实登记）

- **没有运行任何一个目标二进制**——全程静态提取，未执行。
- ~~没有修改 §1–§13 任何已有决策或定案表~~；**2026-08-09 追加**：Coordinator 裁定"下载"后，
  §9.2「yt-dlp → 内置」表格文字**已改**为"下载"，§9.5/§9.6 的直接下游数字与结论同步更新，
  §1.1 的 `yt-dlp-ejs` 复合许可证也已订正——冲突不再悬而未决，14.6 已闭环。
- ~~没有修改~~ `vendor/manifests/backends.json` 的 4 个 `ytdlp-*` `license.id` 字段——
  **2026-08-09 已改 macOS/Windows 两条**（Linux 两条本来就对），理由见 14.7 追加段。
- ~~没有修改~~ `docs/design/D-17-prebuilt-bundles.md:113`——**2026-08-09 已改**，见该文件
  自己的提交记录（理由从"yt-dlp 项目本身是 GPL"订正为"官方二进制内嵌 GPL 依赖"）。
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

## 15. CUDA 那 678 MB 里到底是什么 —— §12.3 留的那个 `UNKNOWN`（`amd-vulkan` 2026-08-09，取证，未改本文任何决策）

> **一句话**：678 MB 里 **418.6 MB（61.8%）是 NVIDIA 运行库**，251.4 MB（37.1%）是我们编的
> `ggml-cuda.dll`，其余 7.8 MB（1.1%）是引擎本体。
> **我们自己那一半砍得动（153.6 MB → 39.7 MB），运行库那一半砍不动** ——
> 光 cuBLAS 一项的地板就是 **398.7 MB**，**是 100 MB 界线的 4.0 倍**。
> **⇒ §9.2「whisper CUDA 下载」的定案不变，而且理由从"体积超线"变成了一条更硬的"结构上超线"。**

**本节一行产品代码没改，`build-bundle.mjs` 一个字节没碰。**

### 15.1 678 MB 的逐项拆解（`[实测]`，**没有下载那 678 MB**）

做法：HTTP `Range` 只取 ZIP 尾部，解析 **EOCD + 中央目录**，拿到 44 条记录的
压缩/解压字节数（形状抄 `pack-publish` T-150 读 artifact 中央目录那次）。
解析出的条数 44 与 EOCD 声明的 44 一致 —— 对不上就不作结论。

| 分类 | 压缩(B) | 解压(B) | 占压缩包 | 条数 |
| --- | ---: | ---: | ---: | ---: |
| **NVIDIA 运行库** | **418,649,015** | 624,576,512 | **61.8%** | 6 |
| **`ggml-cuda.dll`（我们编的）** | **251,437,412** | 564,585,984 | **37.1%** | 1 |
| 其余（whisper/ggml/CPU 变体/示例/SDL2） | 7,795,096 | 20,325,376 | 1.1% | 37 |
| 合计 | 677,881,523 | 1,209,487,872 | 100% | 44 |

NVIDIA 那 6 个逐条：

| 文件 | 压缩(B) | 解压(B) | 必须随包吗 |
| --- | ---: | ---: | --- |
| `cublasLt64_12.dll` | 328,398,141 | 473,551,360 | ✅ **必须**（见 15.3） |
| `cublas64_12.dll` | 70,150,084 | 100,033,536 | ✅ **必须** |
| `cudart64_12.dll` | 171,402 | 553,984 | ✅ **必须** |
| `nvrtc64_120_0.dll` | 18,614,676 | 44,738,048 | ❌ **不需要** |
| `nvrtc-builtins64_124.dll` | 1,180,912 | 5,367,808 | ❌ **不需要** |
| `nvblas64_12.dll` | 133,800 | 331,776 | ❌ **不需要** |
| **必需小计** | **398,719,627** | 574,138,880 | |
| 白带的 | 19,929,388 | 50,437,632 | |

**那 19.9 MB 是上游 `xcopy` 扫进来的**，不是需要：`release.yml:386-394` 把
`cuda_nvrtc` / `libcublas` 等整个 redist 归档 `xcopy /E` 进 toolkit 目录再整目录打包。
证据两条，互相独立：① 本仓 `vendor/whisper.cpp/ggml/` 全树 grep `nvrtc` / `nvblas` **零命中**；
② 我们自己编的 `ggml-cuda.dll` 导入表里也没有它们（15.2）。

### 15.2 ⚠️ 顺带查出一个**现存缺陷**：我们自己的两个 CUDA 包**没带运行库，装上加载不了**

`[实测]` 读我们自己 CI 产物（run **31155359839**，`3ef8734`，全绿）里
`ggml-cuda.dll` 的 **PE 导入表**：

```
cublas64_12.dll        ← Toolkit 组件，用户机器上没有
cudart64_12.dll        ← Toolkit 组件，用户机器上没有
nvcuda.dll             ← 显示驱动带的，正常
ggml-base.dll          ← 在包里 ✔
MSVCP140 / VCRUNTIME140{,_1}.dll + api-ms-win-crt-*   ← D-11 §8.3 那条老债
（没有 nvrtc，没有 nvblas）
```

Linux 侧同形（`objdump -p libggml-cuda.so`）：
`NEEDED libcudart.so.12` / `libcublas.so.12` / `libcuda.so.1`。

而这两个包的 `providesFiles` 里**一个 CUDA 运行库都没有**：

```
whispercpp-cuda-win-x64   143,594,259 B   19 个文件，无 cudart64 / cublas64 / cublasLt64
whispercpp-cuda-linux-x64 152,248,220 B   24 个文件，无 libcudart.so.12 / libcublas.so.12
```

成因在 `scripts/build-whisper.sh` 的打包分支：`copy_if_exists "${BIN_DIR}/cudart64_"*.dll …`
只在**构建输出目录**里找，而 CMake 不会把 toolkit 的 DLL 拷到 `bin/Release`；
Linux 侧那几个 glob 是 Windows 命名（`cudart64_*.dll`），**在 Linux 上永远匹配不到**。
`copy_if_exists` 的语义是"有就拷、没有就算"，**所以它一声不吭**。

**后果是本仓最贵的那一族**：`GGML_BACKEND_DL=ON` 下 `dlopen` 失败**不是错误**，
只是"这个后端没注册上" → whisper 照常用 CPU 跑完 → 用户只会觉得"装了 CUDA 包但没变快"。
`[未验证]` 我们没有 N 卡 runner，**没有实测过这条失败路径**；上述是从导入表 + 包内容推出的，
不是跑出来的。**但它不需要实测就已经是缺陷**：包里没有它必需的文件，这是清单事实。

> ⚠️ 这条**不属于本节的取证任务**，我也**没有修**（纪律：不改产品代码）。
> 记在这里是因为它改变了 §12.3 那张对照表的读法：
> **我们那两个 143/152 MB 的包和上游那个 678 MB 的不是同一类东西** ——
> 前者缺了后者里那 398.7 MB 的运行库。拿 143 MB 去和 100 MB 界线比是**比错了**。

### 15.3 `cublasLt` 为什么砍不掉（这条决定了整个结论）

`[实测]` 从那 678 MB 的 zip 里**只取出 `cublas64_12.dll` 这一条**
（Range 取该 entry 的 70,150,084 B → inflate 得到 100,033,536 B，与中央目录声明一致），
读它的 PE 导入表：

```
Release/cublas64_12.dll 的 PE 导入表（2 条）：
   KERNEL32.dll
   cublasLt64_12.dll        ← ★ 硬导入，不是可选加载
```

**所以 `cublasLt64_12.dll`（473.6 MB 解压 / 328.4 MB 压缩）随 cuBLAS 一起是强制的。**

而 cuBLAS 本身也去不掉：本仓 `ggml/CMakeLists.txt:199-210` 里
**没有任何"不链 cuBLAS"的开关**（`GGML_CUDA_FORCE_MMQ` 只改**优先走哪条 matmul 路径**，
不改链接；`ggml-cuda` 的 `*.cu`/`*.cuh` 里 **66 行**出现 `cublas`，且不在任何「不用 cuBLAS」的条件编译里）。

NVIDIA 官方 redist 清单（`developer.download.nvidia.com/compute/cuda/redist/redistrib_12.4.0.json`）
给的归档体积也对得上这个量级：`libcublas` linux-x86_64 **466,144,480 B**、
windows-x86_64 **391,101,865 B**（含静态库与头文件，比我们只取两个 DLL 略大）。

⚠️ `UNKNOWN`：**有没有办法只保留 cuBLAS 里我们用到的那些架构**。我没找到 NVIDIA 提供的
"精简版 cuBLAS"或按架构裁剪的官方途径，也没找到可信的社区做法。
**我不提一个查不到出处的瘦身方案。**
`GGML_STATIC=ON` 会改链 `cublas_static` + `cublasLt_static`（`ggml-cuda/CMakeLists.txt:158-171`），
理论上链接器可以只保留用到的符号 —— **但我没有实测过静态链接后的体积**，
而且源码注释自己写着「As of 12.3.1 CUDA Toolkit for Windows does not offer a static cublas library」。
标 `[未验证]`，**不作为方案提出**。

### 15.4 `ggml-cuda` 那一半：**95% 是 fatbin，而且砍得动**

`[实测]` 我们自己的 Linux 产物 `libggml-cuda.so` = 393,191,672 B，段大小：

```
.nv_fatbin   373,465,832   (95.0%)      ← 设备代码
.text         13,922,786
.rodata        4,322,120
```

Windows 同形：`ggml-cuda.dll` 388,632,576 B，`.nv_fatb` 375,064,576 B（96.5%）。

**把 `.nv_fatbin` 按条目拆开数**（解析 fatbin 容器头 + entry 头；
先把前 8 条 entry 的原始字段打出来核对布局解对了没有，再统计；
**统计覆盖 373,463,624 / 373,465,832 = 100.0%**，138 个容器）：

| 类型 | 架构 | 字节 | 占 `.nv_fatbin` |
| --- | --- | ---: | ---: |
| CUBIN（SASS） | sm_86 | 118,403,568 | 31.7% |
| CUBIN（SASS） | sm_89 | 118,040,304 | 31.6% |
| PTX（JIT 源） | compute_86 | 68,598,656 | 18.4% |
| PTX（JIT 源） | compute_89 | 68,421,096 | 18.3% |

也就是说 **PTX 占了 36.7%** —— 那是"将来的新卡也能跑"的前向兼容兜底。
（`CMAKE_CUDA_ARCHITECTURES="86;89"` 在 CMake ≥3.18 下同时产 real + virtual，
所以两种都在。写成 `86-real;89-real` 就只剩 CUBIN。）

### 15.5 各档位的**实际压缩体积**（`[实测]`，不是按比例估）

做法：把该保留的字节**真的拼出来再真跑 gzip**，不用任何压缩率假设。
**校准**：对"现状"档算出 153,617,353 B，而 CI 真打出来的 tar.gz 是 152,248,220 B ——
**误差 +0.9%，方向是上界**（分块拼接比整体压缩略差）。其余各行按同一方法同一误差量级读。

| 档位 | 整包压缩(B) | 相对现状 | 谁能用 / 谁静默失效 |
| --- | ---: | ---: | --- |
| ① **现状** 86+89，CUBIN+PTX | **153,617,353** | — | sm_86/sm_89 原生；**其它 NVIDIA 卡靠 PTX JIT**（首次启动慢） |
| ② 86+89，去掉 PTX | 68,647,003 | −55% | **只剩 sm_86 / sm_89**。其它算力全部失效（`[报告]` 卡型对应 sm_75≈RTX 20xx / sm_61≈GTX 10xx / sm_80≈A100 / sm_90≈H100 / sm_120≈RTX 50xx —— **这条对应关系我没有逐个查证出处**） |
| ③ 只 86（CUBIN+PTX） | 82,233,489 | −46% | sm_86 原生；sm_89 及更新的靠 JIT（**RTX 40xx 每次冷启动要 JIT 一份 68 MB 的 PTX**） |
| ④ 只 89（CUBIN+PTX） | 82,067,837 | −47% | sm_89 原生；**sm_86（RTX 30xx）失效** —— PTX 不能往低版本回退 |
| ⑤ 只 86 CUBIN | 39,695,937 | −74% | **只剩 sm_86 一代卡**。其余全部失效 |
| ⑥ 只 PTX(compute_86) | 52,693,891 | −66% | 全部靠 JIT，**没有一张卡是原生的** |

⚠️ **"失效"是什么形态**：CUDA 找不到匹配的 kernel image 时报
`no kernel image is available for execution on the device`。`[报告]` 这条报错文本来自 CUDA 的通用行为，**我没有在真卡上复现过**。
`[实测读码]` `ggml-cuda.cu` 的设备枚举（`ggml_cuda_info()`）**只读 compute capability，
不检查有没有对应的 cubin/PTX** —— 也就是说后端会**注册成功**，
然后在第一次 kernel launch 时才死。**这正是"装得上、跑不了"那一族。**
`[未验证]` 没有 N 卡 runner，这条失败路径我们没跑过。

### 15.6 加上运行库之后：**没有一档能进 100 MB**

**必需运行库地板 = 398,719,627 B（cudart + cublas + cublasLt，15.1/15.3 实测），
它自己就是 100 MB 界线的 4.0 倍。** 我们那一半再怎么砍也追不回来：

| 方案 | 我们的部分 | + 必需运行库 | 合计 | 进 100 MB 线？ |
| --- | ---: | ---: | ---: | --- |
| 现状（86+89，CUBIN+PTX） | 153,617,353 | 398,719,627 | **552,336,980** | ❌ 5.5× |
| 去 PTX（②） | 68,647,003 | 398,719,627 | **467,366,630** | ❌ 4.7× |
| 最激进（⑤，只 sm_86 CUBIN） | 39,695,937 | 398,719,627 | **438,415,564** | ❌ 4.4× |
| 理论下界（我们的部分 = 0） | 0 | 398,719,627 | **398,719,627** | ❌ 4.0× |

> **结论：砍不动。** 不是"差一点"，是**最好情况仍然超线 4 倍**，
> 而且那 4 倍全在一个我们无权也无法裁剪的第三方运行库里。
> **§9.2「whisper CUDA → 下载」不变。** 唯一要更新的是**理由**：
> 从"非 GPL 但超线 6.8 倍"改成"**cuBLAS 运行库的地板就是 4.0 倍，与我们编多少个架构无关**"。

### 15.7 我们**不是** memo 那道选择题

§12.3 猜测"如果大头也是运行库，那就变成和 memo 同一道选择题"。**取证之后：不是。**

- memo 的 18.2 MB 包**只有** `ggml-cuda.dll`，把约 560 MB 运行库推给用户单独下 `cublas` zip。
- **我们今天的两个自建包，事实上处在同一个状态 —— 但是无意的，而且没有那个"让用户另下"的通道**（15.2）。
  memo 至少给了用户一条路；我们的包是**缺了必需件却什么都不说**。
- 所以对照结论反过来了：**不是"我们要不要学 memo 把运行库推给用户"，
  而是"我们那两个包现在就是坏的，得先补上运行库"** —— 而补上之后它们会变成 ~550 MB，
  正好落回 §9.2 已经定好的"下载"那一栏。

### 15.8 与 NVIDIA 许可证的关系（`[报告]`，我不是律师）

若日后真要随包分发那三个运行库，`docs.nvidia.com/cuda/eula` 的 Attachment A
把 `cudart` / `cublas` / `cublasLt`（以及 `nvblas` / `nvrtc`）都列为**可再分发**，
并允许"文件名里带版本号/架构信息的变体"。附带义务（原文见 §1.1.2 Distribution Requirements）：

- "Your application must have material additional functionality, beyond the included portions of the SDK."
- "The distributable portions of the SDK shall only be accessed by your application."
- 二进制**不得修改**（§2.3："the object code files are not modified in any way (except for unzipping of compressed files)"）。
- 下游条款须与该 EULA 一致。

⚠️ **`nvcuda.dll` / `libcuda.so` 是驱动带的**（`docs.nvidia.com/deploy/cuda-compatibility/why-cuda-compatibility.html`
原文："The driver package includes both the user mode CUDA driver (`libcuda.so`) and kernel mode components"），
上游的 678 MB 包里也确实**没有**它 —— 这一条我们和上游都做对了。

⚠️ **一条现存的清单不准确**：`backends.json` 里 `whispercpp-cuda-12.4-win-x64` 的
`license` 写的是 `MIT`（whisper.cpp 的证），**而那个包里 61.8% 的字节是 NVIDIA 的再分发件，
不是 MIT**。`[报告]` 这是许可证标注的覆盖不全，**我没有改**（不在本次取证范围，且
`components.json` 的来源页也要跟着改）。**建议派人处理。**

### 15.9 驱动版本下限（顺带核实，因为它决定"用户装了能不能跑"）

`[实测]` `docs.nvidia.com/cuda/cuda-toolkit-release-notes` Table 3：
CUDA **12.4 GA** 要求 Linux x86_64 **≥ 550.54.14**、Windows x86_64 **≥ 551.61**。
Table 2（minor version compatibility）对 **12.x 家族**给的是 **≥ 525 且 < 580**。
→ `backends.json` 现写的 `requiresDriver.nvidiaDriver: "550"` **与 12.4 GA 的 550.54.14 同一量级，是对的**。

⚠️ 但有一条**与 15.5 直接打架、必须写下来**：走 minor version compatibility（驱动 ≥525 但低于 550.54.14）时，
官方明写限制是 **"No PTX (requires SASS), NVCC target architecture required"**
（`why-cuda-compatibility.html`）—— **也就是那种情况下 PTX 兜底是不生效的，只有精确匹配的 CUBIN 才行。**
所以 15.5 表里"靠 JIT"那几档，**只对驱动足够新的用户成立**。

### 15.10 本节没做 / 没验的（如实列）

| 项 | 状态 |
| --- | --- |
| 任何一档裁剪后的包**在真 N 卡上能不能跑** | `[未验证]` —— 没有 N 卡 runner，**不拿"包能装上"当"能跑"** |
| 裁剪档位的体积是**重编实测**吗 | ❌ **不是**。是把真实字节按档位拼出来真跑 gzip，对"现状"档校准误差 **+0.9%**。重编一次布局会略有不同 |
| 15.2 那条缺陷的**失败形态** | `[未验证]`（从导入表 + 包内容推出；缺件本身是清单事实） |
| cuBLAS 静态链接后的实际体积 | `[未验证]`，**没有实测，不作为方案提出** |
| cuBLAS 有没有官方瘦身途径 | `UNKNOWN` —— 查不到，不编 |
| Linux 侧 `libcublas.so.12` / `libcublasLt.so.12` 的**单文件**体积 | `UNKNOWN` —— 只拿到 NVIDIA redist 归档整体 466,144,480 B（含静态库与头文件）。Windows 侧是逐文件实测的 |

### 15.11 纪律

- **一行产品代码没改**；`scripts/build-bundle.mjs` 一个字节没碰；本节只**追加**，
  D-20 已有的任何决策一个字没动。
- **未建/改/删任何 release**；未碰 `:10000`、`/root/data-memo`、任何机器级指针；未用过 `pkill`（含 `-0`）。
- 那 678 MB **没有整个下载**：中央目录走 Range 取尾部 256 KB，
  另外只取了 `cublas64_12.dll` 那一条 entry（70,150,084 B）用来读导入表。
