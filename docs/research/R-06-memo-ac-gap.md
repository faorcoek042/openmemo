---
id: R-06
author: memo-compare
status: ready
date: 2026-08-03
---

## TL;DR（≤ 25 行，Manager 只读这里）

- **用户那句"识别引擎只有两个可选"的根因已定位，且比"只有两个"更糟**：唯一的引擎选择器在
  `apps/web/src/features/recorder/RecorderPage.tsx:49`，是一个写死的 `useState<'paraformer'|'turbo'>` 两态按钮，
  **既不来自 manifest，也从不发给后端**（该文件里 `engine` 值没有任何 API 调用消费它），而且 `'turbo'`
  在后端三值联合 `EngineId = 'whisper.cpp'|'paraformer'|'sherpa-onnx'` 里**根本不存在**。
  真实引擎切换只能靠环境变量 `OPENMEMO_ASR_ENGINE`，全前端 grep 无命中。**导入页 CapturePage 连引擎/模型/语言/prompt 都没有。**
- **引擎数量差距（forensics 原文核实）**：memo.ac 本地 4 个（`whisper` / `sherpa-onnx` / `funasr-cli` / `parakeet-cli`）
  + 云端 4 个 ASR 插件（Deepgram / ElevenLabs / Groq / OpenAI）= **8 条可选路径**；我们后端 3、前端 0 条真实可选。
- **ASR 模型条目差距**：memo.ac **47 条**（whisper 15 + sherpa 27 + parakeet 4 + funasr 1）；我们 **11 条**
  （whisper 9 个量化档 + sherpa 2）。差得最狠的是 sherpa 侧 27→2：**SenseVoice、Qwen3-ASR、Omnilingual-1600语种、
  Moonshine、各 zipformer/wenet 全缺**。技术根因：`packages/pipeline/src/asr/paraformer.ts:257` 把
  `modelConfig.paraformer` 分支写死，加 SenseVoice 等需要补 `senseVoice/whisper/zipformer2Ctc/wenetCtc` 兄弟分支。
- **"设置/模型/运行时点不动"已被 T-074（commit 3bf3cfa, 02:43）修掉**：`SideLink` 的 `pending` 分支把
  `/runtime` `/models` 渲染成惰性 `<span>`。**git 全历史核实：`/settings` 从未被 `pending` 标记** ——
  用户感知的"设置也点不动"应归因于同 commit 修的第 2 个根因（握手竞态导致满屏"未认证"），不是导航本身。
- 三列表统计（共 **58** 条，逐条复核）：**完全没做 18** · **做了但残 10** · **我们更好 15** · **相当/并列 9** · **章程明确不做 6**。
- **前人报告列为"我们更好"的项里，有 2 条经核实不成立，本报告予以纠正（已从 15 条里剔除）**：
  ① **"可导入任意 HF GGUF"是假的** —— `/api/models/import` 的 `kind:'hf_repo'` 硬编码返回 501（models.ts:724），
  只有 `local_file` 能用；② **AMD/Vulkan 只覆盖 LLM，不覆盖 ASR** —— backends.json 里 vulkan/rocm 包全是 llama.cpp，
  whisper.cpp 只有 cpu×2 + cuda-win×1，上游 v1.9.1 压根没出 Vulkan/ROCm 产物（ADR-015 已记）；
  ③ 真正站得住的是**量化选择**（9 个 whisper 变体覆盖 f16/q5_0/q5_1/q8_0，memo.ac 全是 f16）与
  **显存 fit 预检**（实测 /api/models/catalog 每个变体都返回 `fitness.tier`，memo.ac 零该字段）。
- **R-01 的两处错误再确认**：memo.ac **有标签系统** —— SQLite 建表核实为 9 张表，含 `tag`/`note_tag`/`doc_tag` 三张；
  R-01 判"无标签、无双链"错误。另：R-01 说 macOS 包无 Vulkan/ROCm/DirectML，本次全量文件名复查**成立**
  （命中全是 Electron 自带 SwiftShader 与 Monaco 语法高亮词表）。
- 未验证/存疑：① Windows 包仍未解包，AMD 结论仍只覆盖 macOS 包；② memo.ac 思维导图是否节点级可编辑仍无证据；
  ③ 我方 `/ws/recorder` 后端为真实实现，但 `RecorderPage` 前端仍是 mock 字幕流，端到端**未跑通**；
  ④ 本报告未在真浏览器点击验证任何页面（只读 API + 读码 + 读 git 历史）。
- 对其他 agent 的影响：`model-mgmt` 应优先补 sherpa 离线分支 + SenseVoice；`architect` 应把引擎选择器从
  RecorderPage 提到导入/设置两处并改为 catalog 驱动；Manager 应把 FEATURE-COVERAGE 的 B-2（"daemon 只有 6 个端点"）
  作废 —— **实测 42 条 REST + 2 条 WS**。

## 详细内容

### 0. 证据等级与方法

| 标记 | 含义 |
|---|---|
| **[F]** | 从 `/root/memo-forensics/` 解包原文核实（我或我的 subagent 直接读到）。最高可信度。 |
| **[O]** | 从 OpenMemo 仓库源码 / 运行中 demo 的只读 API / git 历史核实。 |
| **[R1]** | 仅来自 R-01 的转述，本次**未**独立核实。 |
| **推测** | 明确标注。 |

方法说明：
- memo.ac 侧全部重新读原文，未依赖 R-01 转述。核实到 R-01 的一处硬错误（标签系统）。
- 我方状态全部读代码 / 读 manifest / 打运行中的 demo（`GET` only，未写、未重启）。
  **未采信 FEATURE-COVERAGE.md 的任何状态**——实测发现该矩阵在两个方向上都已失真（见 §5）。
- ⚠️ 审计期间仓库处于并发编辑中：`App.tsx` 在我读取的两次之间发生了变更（T-074 的修复落地），
  demo 实例也被其他 agent 重启过一次（pid 2066756 → 2075454）。相关结论已标注时间点。
- ⚠️ memo.ac 是闭源专有代码。本报告只记录**事实性标识符与结构**（模型 id、引擎名、通道名、表名、条目计数），
  **未复制任何其源码进本仓库**，也不建议任何 agent 这样做。

---

### 1. 识别引擎（ASR）—— 用户第一关切

#### 1.1 memo.ac 到底有几个引擎 **[F]**

引擎选择在其渲染层是两层结构：

| 层 | 取值 | 证据 |
|---|---|---|
| `transcriptType` | `local` / `cloud` | 渲染层 `transcriptSetStore` 默认值 `"local"` |
| `localEngine`（`transcriptType==='local'` 时） | `whisper`（默认）· `sherpa-onnx` · `funasr-cli` · `parakeet-cli` | 渲染层条件分支 `l==="funasr-cli"` / `l==="sherpa-onnx"` / `h==="parakeet-cli"` 逐个命中 |
| 云端 provider（`transcriptType==='cloud'` 时） | 4 个 ASR 插件 | `plugins.json` 的 `type:"transcription"` 条目 |

**本地 4 个引擎**：
1. `whisper` = whisper.cpp **1.8.6**，随包内置。macOS 出两套构建：`addon/whisper/bin/1.8.6/`（含 `libggml-metal`，即 Metal+CPU）
   与 `addon/whisper/bin/1.8.6/coreml/`（额外含 `libwhisper.coreml.dylib`）。Windows 的 CUDA 版是**按需下载**的 `.7z`，不随包。
2. `sherpa-onnx` = 走 npm 包 `sherpa-onnx-node` + `libonnxruntime 1.24.4`，无独立引擎二进制。
3. `funasr-cli` = 可下载引擎插件（darwin/arm64 + win32/x64）。
4. `parakeet-cli` = 可下载引擎插件（NVIDIA NeMo Parakeet TDT），Windows 引擎包 **1.8 GB**。

**云端 4 个 ASR 插件**（`plugins.json`，共 33 条插件中 `type:"transcription"` 的 4 条）：
`memo-plugin-asr-deepgram` · `memo-plugin-asr-elevenlabs` · `memo-plugin-asr-groq` · `memo-plugin-asr-openai`。

> 插件市场全貌 **[F]**：33 条 = translate 22 + tts 5 + transcription 4 + app 2，全部 `author: "Memo Team"`，
> 全部 `version_name: "beta"`，平台一律 win32+darwin。其中 7 个 `.memox` 随包预置，其余按需下载。

#### 1.2 我们有几个 **[O]**

| 层 | 现状 | 文件 |
|---|---|---|
| 后端引擎联合类型 | **3 个**：`'whisper.cpp' \| 'paraformer' \| 'sherpa-onnx'` | `packages/pipeline/src/asr/selectEngine.ts:22` |
| 引擎实际构造 | `whisper` 恒构造；`sherpa` 需 `OPENMEMO_SHERPA_STREAM_DIR` 环境变量 + 模型解析成功；`paraformer` 需 `OPENMEMO_PARAFORMER_DIR` | `apps/daemon/src/pipeline/setup.ts` |
| 引擎选择入口 | **只有环境变量** `OPENMEMO_ASR_ENGINE` | `apps/daemon/src/pipeline/setup.ts` `pickEngine()` |
| 前端选择器 | **写死两态** `useState<'paraformer' \| 'turbo'>('paraformer')` | `apps/web/src/features/recorder/RecorderPage.tsx:49` |
| 云端 ASR | **完全没有**（grep `deepgram|elevenlabs|assemblyai|asrProvider` 在 ASR 语境零命中；Groq 只出现在 LLM provider 注释里） | — |

**前端选择器的三个独立缺陷（全部实测）**：
1. **只有两个值**，且不是下拉框而是一个来回切的 `<Button>`。
2. **两个值不是引擎**。`'turbo'` 不在后端 `EngineId` 里；后端有的 `'whisper.cpp'`/`'sherpa-onnx'` 前端一个都没有。
   `'turbo'` 推测指 whisper large-v3-turbo 模型，但代码里**找不到任何映射**。
3. **选了也没用**。该文件里 `engine` 只被用来算展示用的 `speedRatio`（84x vs 2.7x）和切文案，
   **从未进入任何 API 调用**。同页 `start()` 里的字幕流本身还是 MOCK（注释自陈"真实实现走 /ws/recorder"）。
4. **导入路径（`CapturePage.tsx`，259 行）零转写设置** —— grep `model|language|prompt|vad` 只命中格式化工具函数。
   对照 memo.ac：每次导入都有完整设置面板（引擎/模型/语言/prompt/maxLen/VAD/GPU/flash-attn）。

#### 1.3 差在哪、为什么差

| 差距 | 性质 | 根因（已核实） |
|---|---|---|
| 缺 FunASR 引擎 | 完全没做 | 无人认领；memo.ac 靠可下载插件包解决，我们连注册表条目都没有 |
| 缺 Parakeet 引擎 | 完全没做 | 同上 |
| 缺云端 ASR（4 家） | 完全没做 | 我方 BYOK 抽象只做了 LLM（`packages/llm`），ASR 侧无 provider 层 |
| sherpa 只跑流式，不跑离线 | 做了但残 | `setup.ts` 注释自陈"sherpa-onnx 默认不为批量/离线构造，只接了流式" |
| 前端引擎选择器是死的 | 做了但残 | 见上 3 条 |
| 引擎选择只能靠环境变量 | 做了但残 | `OPENMEMO_ASR_ENGINE` 在前端 grep 零命中 |

---

### 2. 模型清单

#### 2.1 memo.ac 原文条目数 **[F]**

**（a）`Resources/presets/whisper-models.js` —— 15 条**，字段
`{label, value, size, description(i18n key), disabled, downloadLink, speed(1–6), speedLabel, speedValue(fast|balance|quality), quality(1–6), download, lang, langLabel, sha(SHA-1)}`。

| # | label | 文件 | 体积 | speed/quality | lang |
|---|---|---|---|---|---|
| 1–2 | Tiny / Tiny.en | `ggml-tiny(.en).bin` | 77.7 MB | 6 / 2 | multi / en |
| 3–4 | Base / Base.en | `ggml-base(.en).bin` | 148 MB | 5 / 3 | multi / en |
| 5–6 | Small / Small.en | `ggml-small(.en).bin` | 488 MB | 4 / 4 | multi / en |
| 7–8 | Medium / Medium.en | `ggml-medium(.en).bin` | 1.53 GB | 3 / 5 | multi / en |
| 9–11 | Large(v1/v2/v3) | `ggml-large-v{1,2,3}.bin` | 3.09 GB | 2 / 6 | multi |
| 12 | Large(v3)-turbo | `ggml-large-v3-turbo.bin` | 1.62 GB | 4 / 6 | multi |
| 13 | Distil Large(v3) | `ggml-distil-large-v3.bin` | 1.52 GB | 2 / 6 | en |
| 14 | Memo-large.zh | `Memo-large.zh.bin` | 2.88 GB | 2 / 6 | zh |
| 15 | Memo-large.ja | `Memo-large.ja.bin` | 2.88 GB | 2 / 6 | ja |

> 前 13 条源 `huggingface.co/ggerganov/whisper.cpp`（**无 revision 钉版，走 `main` 分支**）；
> 后 2 条源自有域名 `model.memo.ac`，且**需发购买凭证到邮箱人工发链接**。
> **15 条全部 f16 —— 没有任何量化档。**

**（b）`Resources/plugins/extra-transcription-plugins.json` —— 3 个引擎 / 37 条模型**

| 引擎 id | 引擎平台 | 模型条目 | 备注 |
|---|---|---|---|
| `parakeet-cli` | darwin/arm64 · win32/x64 | **4** | `parakeet-tdt-0.6b-v2/v3` 各出 `.nemo`（win）与 `-coreml`（mac）双版；v3 覆盖 25 种欧洲语言 |
| `funasr-cli` | darwin/arm64 · win32/x64 | **1** | `funasr-models` 打包 ASR/VAD/PUNC/SPK 四件套，约 1 GB |
| `sherpa-onnx` | （无独立引擎二进制） | **32** | 其中 **ASR 27** + TTS 2（kokoro f32/int8）+ 标点 3 |

sherpa 侧 27 条 ASR（全部 `platform:"all"`，直链 k2-fsa 的 GitHub release，每条带 `sizeBytes`+`sha256`+`languages[]`）：
SenseVoice-zh-en-ja-ko-yue（1.05 GB，5 语）· Qwen3-ASR-0.6B-Int8（879 MB）·
Cohere-Transcribe-14Lang-Int8（1.70 GB）· Omnilingual-300M-Int8（**1600 语种**，293 MB）·
Moonshine-Tiny-Ko · Paraformer-bilingual-zh-en · Zipformer-Korean / Streaming-Zipformer-Korean ·
Zipformer-bilingual-zh-en · Zipformer-ctc-small · Zipformer-multi-zh-hans · Zipformer-en-20M ·
Whisper ONNX 版 ×10（tiny/tiny.en/base.en/small/small.en/medium/medium.en/large-v1/v2/v3/turbo/distil-v2/v3）·
Zh-Wenet-Aishell · En-Wenet-Gigaspeech。

**memo.ac ASR 模型条目合计 = 15 + 4 + 1 + 27 = 47。**

`Resources/presets/sherpa-onnx-config.js` 另存 10 个模型架构的配置模板，分支覆盖
`senseVoice` / `paraformer` / `transducer` / `zipformer2Ctc`（含 HLG.fst 解码）/ `whisper` / `wenetCtc`。 **[F]**

#### 2.2 我们的条目数 **[O]**

实测 `GET /api/models/catalog`（运行中 demo）：**14 组 / 19 变体**。

| role | 组 | 变体 | 明细 |
|---|---|---|---|
| asr（whisper） | 6 | **9** | large-v3-turbo(q5_0/q8_0/f16)、large-v3(q5_0/f16)、medium(q5_0)、small(q5_1)、base(q5_1)、tiny(f16) |
| asr（sherpa） | 2 | **2** | `sherpa-streaming-zh-14m`(q8_0, 25 MB)、`paraformer-zh-small`(q8_0, 82 MB) |
| vad | 1 | 2 | silero ONNX（给 sherpa）+ silero ggml（给 whisper.cpp） |
| punctuation | 1 | 1 | ct-transformer-zh-en |
| llm | 4 | 5 | Qwen3 1.7B/4B×2/8B、Gemma-3-4B-it（全 GGUF，llama.cpp） |

**我方 ASR 模型条目 = 11。差距 47 → 11，缺 36 条。**

按引擎拆：whisper 15→9（但我们是 6 个逻辑模型 × 量化档，覆盖面小、深度大）；
sherpa **27→2**（缺 25，这是最大单点缺口）；parakeet 4→0；funasr 1→0。

#### 2.3 差在哪、为什么差

1. **sherpa 27→2 的技术根因已定位**：`packages/pipeline/src/asr/paraformer.ts:257` 构造 `OfflineRecognizer` 时
   把 `modelConfig` 写死为 `paraformer: { model }` 单分支。要接 SenseVoice / Whisper-ONNX / zipformer2Ctc / wenetCtc，
   必须补兄弟分支（memo.ac 的 `sherpa-onnx-config.js` 正是把这 6 类分支做成了模板表——**这是它的正确做法，值得学结构、不抄代码**）。
   流式侧 `sherpaOnnx.ts` 同理只接了 `transducer`。
2. **中文最强的 SenseVoice 没进目录**，导致中文离线只能靠 82 MB 的 paraformer-zh-small（无逐字时间戳）
   或 CPU 上 2.7x 实时的 whisper-turbo。这是**中文体验的核心缺口**。
3. **memo.ac 的中日专属微调模型（Memo-large.zh/ja）我们无对应物**，且它需人工发链接——这是它的摩擦点，
   我们可用开源中文微调模型（如 BELLE-whisper-large-v3-zh，正是其 issue #218 至今未做的）做出正差。**[R1] 未核实该 issue 现状。**

---

### 3. 三列对照表（58 条）

图例：**❌ 完全没做** · **⚠️ 做了但残** · **✅ 我们更好** · **➖ 相当/并列**（双方都有，或双方都没有）· **✂️ 章程明确不做**

> 为什么把「我们更好」和「相当」拆开：合并计数会得出"我们在 24 项上更好"，那是失衡的读法。
> 真正构成**差异化**的只有 15 项，另外 9 项只是把它已有的做到同等水平。

#### 3.1 导入与采集（10 条）

| # | memo.ac 有什么 **[F]** | OpenMemo 有没有 **[O]** | 差距性质 |
|---|---|---|---|
| 1 | URL 导入：yt-dlp 2026.03.17（PyInstaller 冻结含 Python 3.14 + curl_cffi + yt_dlp_ejs）+ 内置 bun 解 nsig | 有 yt-dlp 全链路（`packages/pipeline/src/media/sources/ytdlp.ts`） | ⚠️ 做了但残（无 JS challenge runtime，YouTube 反爬变更即失效） |
| 2 | 浏览器 cookie 导入（`cookieBrowser`, `ytdlp:export-cookies`, `ytdlp:open-youtube-login`）→ 会员内容 | 无 | ❌（章程未裁决；FEATURE-COVERAGE 标"待用户决策：`--cookies` 是任意读文件入口"） |
| 3 | yt-dlp 可独立于主程序在线升级（`ytdlp:check-update` / `:download-version` / `:reset-to-builtin`） | 无（yt-dlp 甚至不在 `vendor/manifests/components.json` 里，grep 零命中） | ❌ 完全没做 |
| 4 | 本地文件拖拽（多格式） | `CapturePage.tsx:92` 有真 `onDrop`；`POST /api/notes/upload` 多部分流式落盘 | ➖ 相当（前人矩阵标 🔴 已过时） |
| 5 | 实时录音 + 麦克风选择 + 本地 recorder server | `/ws/recorder` 后端为真实实现（二进制帧上行 + 控制 JSON） | ⚠️ 做了但残：`RecorderPage` 前端仍是 MOCK 字幕流，**端到端未跑通** |
| 6 | RSS 订阅 + YouTube 频道订阅（9 个 IPC） | `packages/pipeline/src/media/sources/rss.ts` 只解析 feed | ⚠️ 做了但残（没下载并转写过一集） |
| 7 | YouTube 官方字幕直接拉取（上传的 + 自动生成的） | 无 | ❌ 完全没做 |
| 8 | 本地字幕导入（SRT/VTT 拖入直接翻译） | 无（我们只有导出方向） | ❌ 完全没做 |
| 9 | 系统音频回环 / 桌面采集（`get-desktop-sources`、`loopback`） | 无 | ❌ 完全没做（浏览器架构下需 getDisplayMedia，可行但未做） |
| 10 | 截图（`screenshots` / `abort-screenshots`，摘要自动配图） | 无 | ❌ 完全没做 |

#### 3.2 转写与引擎（9 条）

| # | memo.ac **[F]** | OpenMemo **[O]** | 性质 |
|---|---|---|---|
| 11 | 本地 4 引擎（whisper / sherpa-onnx / funasr-cli / parakeet-cli） | 后端 3（whisper.cpp / paraformer / sherpa-onnx），前端 0 条真实可选 | ⚠️ 做了但残 |
| 12 | 云端 ASR 4 家（Deepgram / ElevenLabs / Groq / OpenAI） | 无 ASR provider 层 | ❌ 完全没做 |
| 13 | 47 条 ASR 模型条目 | 11 条 | ⚠️ 做了但残（缺 36） |
| 14 | 每次导入都有完整转写设置面板（引擎/模型/语言/prompt/maxLen/VAD/GPU/flash-attn） | `CapturePage` 零设置项 | ❌ 完全没做 |
| 15 | VAD（Silero，`vad_addon.node` + FastDeploy 运行时），设置项 `preferences.transcription vad` | 有 VAD 模型（双格式）+ `whisper-vad-speech-segments`；demo 自检显示"未安装 → 降级为固定窗口" | ➖ 相当（我们把 ggml/onnx 双格式在目录里显式区分并写进描述，避免装错） |
| 16 | Whisper prompt 条件化 + 关键词过滤/替换（`insert-keyword` 等 4 个 IPC） | 无 prompt、无关键词过滤 | ❌ 完全没做 |
| 17 | 说话人分离（pyannote 外挂扩展，可指定人数；`speaker.*` 33 个 i18n key） | `speakers` 表存在、`diarization: boolean` 字段存在，无引擎无 UI | ✂️ 章程已裁决不做（但数据模型已留位） |
| 18 | 人声/伴奏分离（rspleeter，Settings > Labs） | 无 | ✂️ 章程明确不做 |
| 19 | AI 字幕纠错 + 术语表（`correction:*` 16 个 IPC，含 glossary CRUD） | 无（grep `glossary` 零命中） | ❌ 完全没做 |

#### 3.3 AI 功能（8 条）

| # | memo.ac **[F]** | OpenMemo **[O]** | 性质 |
|---|---|---|---|
| 20 | 摘要 Summary + 可复用摘要模板（`ai-summarize` / `summarize` / `getPromptTemplates`） | 无 summary 生成端点（`mindmap_summaries` 表存在但无路由） | ❌ 完全没做 |
| 21 | 思维导图（markmap，LLM 流式 `mindmap:start/thinking/message/complete`） | `POST/PATCH/GET /api/notes/:uid/mindmap` + `MindmapPage` + 26 张表里 4 张 mindmap 表 | ✅ 我们更好：**节点级拖拽编辑 + 撤销**（mind-elixir），并用 `exportSvg()/exportPng()` 矢量导出而非截屏——正是 memo.ac issue #133「导出字看不清」的根因 **[R1] 该 issue 未复核** |
| 22 | 导图/摘要各自可设自定义 prompt | 无 | ❌ 完全没做 |
| 23 | 与视频内容对话 Chat + 本地 `embeddings` 目录（本地 RAG） | `embed_chunks` 表 + sqlite-vec 组件存在，但 `search.ts:186` 的 `modeReport()` 明确返回 `semantic: false` | ⚠️ 做了但残（embedding 生成链路是断的） |
| 24 | 翻译：逐行 / 段落重译 / 双语导出 / 术语表 / 自定义翻译模板 / 22 家 provider 插件 | `segment_translations` 表存在，无翻译端点无 UI | ✂️ 章程明确不做（"翻译字幕"已裁决） |
| 25 | LLM BYOK ~19 家 + 远端 LLM 注册表（`model.memo.ac/llm-models/manifest.json`，16 个 `llm:*` IPC） | `packages/llm` 的 OpenAI-compatible 抽象覆盖同一批云厂商 + Ollama/LM Studio/内置 llama-server；`LlmSettingsSection` 有 UI | ✅ 我们更好：**所有 provider 都能配 baseURL**（memo.ac 只有 OpenAI 能，是其 issue #353/#359 的抱怨点 **[R1] 未复核**）；且我们能跑**内置本地 llama.cpp**，无需装 Ollama |
| 26 | TTS（Kokoro 本地 + 5 家云插件 + Temo 独立子应用，61 个 i18n key） | 无（`tts` 只作为 model role 枚举存在） | ✂️ 章程明确不做 |
| 27 | 英语/日语学习工具 · 字幕转文章（app 类插件 ×2） | 无 | ✂️ 章程明确不做（非目标） |

#### 3.4 笔记组织与检索（9 条）

| # | memo.ac **[F]** | OpenMemo **[O]** | 性质 |
|---|---|---|---|
| 28 | 层级 Workspace → Folder → Note；9 张 SQLite 表（`workspace/folder/note/doc/tag/note_tag/doc_tag/resource/download`） | `folders` + `notes`，26 张业务表（另 15 张 FTS 影子表） | ➖ 相当；我们表更细（jobs/job_steps/job_events、media_assets/media_sources、mindmap 四表、note_anchors、recordings、secrets） |
| 29 | **标签系统（`tag` / `note_tag` / `doc_tag` 三张表）** ← R-01 判"无标签"**是错的** | `tags` + `note_tags` 两张表；`GET/POST /api/tags`、`DELETE /api/tags/:uid`、`POST /api/notes/:uid/tags`、`DELETE .../tags/:tagUid` 全部真实；前端 `TagEditor.tsx` | ➖ 相当（前人矩阵标"前端只读、零写入路径"已过时） |
| 30 | 星标 | `PUT /api/notes/:uid/star` + 侧栏 `/notes?starred=1` | ➖ 相当 |
| 31 | 双链 / 反向链接 | 无 | ❌ 双方都没有（并列，非差距） |
| 32 | 字幕搜索/替换（正则 + 大小写 + Title Case） | `GET /api/search`（FTS5 + libsimple 中文分词），`SearchPage` + 顶栏 `SearchBox` | ✅ 我们更好：**中文分词 FTS**（libsimple v0.7.1 含完整 pos_dict）；memo.ac 靠 jieba WASM 但只用于分词，未见 FTS |
| 33 | 向量检索 | 表 + sqlite-vec 组件齐备，`semantic: false` | ⚠️ 做了但残 |
| 34 | 回收站（`/trash` 路由 + 7 个 i18n key，含永久删除/还原） | 无（`DELETE /api/notes/:uid` 直接删） | ❌ 完全没做 |
| 35 | 转写稿 ↔ 时间轴联动（点击字幕跳转、浮动字幕窗、悬浮笔记带时间戳与截图） | `GET /media/asset/:ulid` 完整 Range 支持；`note_anchors` 表 + `GET /api/notes/:uid/anchors` + `TimeAnchor.ts` | ➖ 相当 |
| 36 | 转写段落编辑 | `PATCH/DELETE /api/notes/:uid/segments/:seq`（可回退到原文） | ✅ 我们更好：**段落编辑可逐段 revert**，且两阶段重跑保留用户编辑（`POST /api/notes/:uid/retranscribe`） |

#### 3.5 导出与集成（5 条）

| # | memo.ac **[F]** | OpenMemo **[O]** | 性质 |
|---|---|---|---|
| 37 | 字幕：SRT / VTT / ASS / LRC / FCPXML；文本：TXT / MD / DOCX；数据：JSON / XLSX；图片：PNG/JPG/SVG | `GET /api/notes/:uid/export?format=` → md/txt/srt/vtt/json；导图 md/opml/mm/json | ⚠️ 做了但残（缺 ASS/LRC/FCPXML/DOCX/XLSX；但**导图导出格式我们更多**） |
| 38 | 视频压制 / 烧录字幕 / 水印 / 字幕样式（47 个 `subtitle.*` key） | 无 | ✂️ 章程明确不做 |
| 39 | Notion 发布（`publish-to-notion`；官方自评"需一定技术能力"，要手工建 Integration） | 无 | ❌ 完全没做 |
| 40 | Obsidian 一键导出（限 2h 以内） | 无（但 md 导出可手工放进 vault） | ❌ 完全没做 |
| 41 | 导出整个 workspace / 项目（`export-note-project` / `export vault`） | 无 | ❌ 完全没做 |

#### 3.6 要求 2.1 GPU / 后端安装（7 条）

| # | memo.ac **[F]** | OpenMemo **[O]** | 性质 |
|---|---|---|---|
| 42 | 后端 = 可下载构件（`whisper-cublas-12.2.0-bin-x64.zip` → 解压到 `addon/whisper/win32/x64/cublas/` → 存在性自检） | `vendor/manifests/backends.json` 10 个 pack，`/api/backends/{catalog,installed,install,select,selftest}` + `DELETE /api/backends/:id` | ➖ 相当，且我们**每个 pack 带 sha256 + `requiresDriver`**（nvidiaDriver 580 / vulkanApi 1.2 / rocmVersion 7.0 / macosVersion 13.0） |
| 43 | 后端枚举：win = cpu/cuda；mac = cpu/mps(Metal)/coreML。**全量文件名复查：Vulkan/ROCm/DirectML/OpenCL/CLBlast/SYCL/OpenVINO 全部 NOT FOUND**（命中皆为 Electron SwiftShader 与 Monaco 语法词表） | 10 个 pack 覆盖 cpu/cuda/vulkan/rocm/metal × win/linux/mac | ✅ 我们更好，**但有重要限定见 #44** |
| 44 | — | **vulkan/rocm 三个包全部是 llama.cpp（LLM）**；whisper.cpp 侧只有 `cpu-linux` / `cpu-win` / `cuda-12.4-win`。ADR-015 已记：上游 whisper.cpp v1.9.1 **没有 macOS CLI / Vulkan / ROCm / Linux CUDA 产物** | ⚠️ **做了但残 —— "真 AMD 支持"目前只覆盖 LLM，不覆盖 ASR。前人报告在此吹过头，本报告纠正。** |
| 45 | 硬件探测：`systeminformation` + `nvidia-smi`（Win 上遍历 DriverStore 取最新）+ `nvcc --version` | `GET /api/runtime/hardware`（`?refresh=1`/`?reset=1`）+ `GET /api/runtime/breaker`（熔断器状态） | ✅ 我们更好：**探测有熔断器**，冷启动探测死锁已由 ADR-014 处理 |
| 46 | 自检：向 whisper-server 发内嵌 base64 测试音频跑真实推理 | `POST /api/backends/selftest` 真实实现（返回 `passed`/`rtf`/`speedup`/`devicesFound`，前置不满足返回 409 `SELF_TEST_BLOCKED`）+ `GET /api/selfcheck` 13 项分层自检（tools/models/ext） | ✅ 我们更好：**分层自检 + 每项带 `remediation` 修复指引**，且 demo 实测 11 ok / 2 warn / 0 fail |
| 47 | whisper-server 常驻，`--host 0.0.0.0`（⚠️ 监听全网卡） | daemon 默认绑 127.0.0.1（demo 曾用 `OPENMEMO_HOST=0.0.0.0` 覆盖，重启后已回到 127.0.0.1）；四重防护 Host/Origin/CSRF/HttpOnly cookie | ✅ 我们更好 |
| 48 | 进度事件总线 `renderer-message` + `域:动作:阶段` 命名 + 250 ms 节流 | `GET /api/events` 单一 SSE 通道 | ➖ 相当 |

#### 3.7 要求 2.2 模型管理（7 条）

| # | memo.ac **[F]** | OpenMemo **[O]** | 性质 |
|---|---|---|---|
| 49 | 声明式注册表 + SHA-1（whisper）/ SHA-256（插件）+ `size`/`fileSize`/`installSize` 双体积 | manifest 每文件带 **sha256 + sha1 + `totalSizeBytes` + `requirements.diskRequiredMB`** | ➖ 相当偏好 |
| 50 | **无量化选择**（15 条 whisper 全 f16） | **9 个 whisper 变体覆盖 f16 / q5_0 / q5_1 / q8_0**，按 `groupId` 分组、`quantTier` 分档（small/balanced/quality） | ✅ **我们更好（核心差异点，已实测）** |
| 51 | **无显存/内存 fit 预检**（只有官网表格写"最低 8G/16G"） | 每条带 `requirements{ramRequiredMB, vramRequiredMB, diskRequiredMB}`；`GET /api/models/catalog` **实测每个变体返回 `fitness.tier`**（recommended / slow_cpu …）+ `speedTier` | ✅ **我们更好（核心差异点，已实测）** |
| 52 | 下载源三选一（huggingface / hf-mirror / aifasthub）+ 官方代理 `download.memo.ac` | 每个文件 `mirrors[]`（hf / hf-mirror / **modelscope** / github），`GET /api/models/sources` + `POST /api/models/sources/{probe,select}` **带实测探活** | ✅ 我们更好（多一个 modelscope，且能主动测速选源） |
| 53 | 模型源**不钉 revision**（走 HF `main` 分支） | `source.revision` 钉到 commit SHA（如 `5359861c…`），URL 里直接用该 SHA | ✅ 我们更好（可复现，上游改文件不会静默换权重） |
| 54 | **不能导入任意 HF 模型**（其 issue #218 至今未做 **[R1] 未复核**）；只支持导入本地模型文件 | `POST /api/models/import`：`kind:'local_file'` 真实（流式 sha256 + 从文件名推断量化，推断不出就**拒绝而不猜**）；**`kind:'hf_repo'` 硬编码 501**（models.ts:724，理由：没有权威 SHA-256 就不装，ADR-004 决策 5） | ⚠️ **做了但残 —— "可导入任意 HF GGUF"是假的。前人报告在此吹过头，本报告纠正。** 我们与 memo.ac 在这一项上**打平**（都只能导本地文件） |
| 55 | 模型/后端页埋在设置弹窗里（其"模型下载卡 0%"是最高频用户问题 **[R1]**） | `/runtime` `/models` 是**一级侧栏导航**（App.tsx 注释明写这是刻意选择）；另有 `/models/:modelId` 详情页与 `/settings/storage` 存储页 | ✅ 我们更好（信息架构） |

#### 3.8 平台、隐私、工程（3 条）

| # | memo.ac **[F]** | OpenMemo **[O]** | 性质 |
|---|---|---|---|
| 56 | 仅 Win x64 + macOS arm64。**无 Linux**；Intel Mac 停在 1.6.8；Win ARM 无版本 | **Linux x64 实跑中**（demo 全链路在 Linux 上，ffmpeg/whisper-cli/VAD 自检全 ok） | ✅ **我们更好（已实证，非声明）** |
| 57 | 首页称"完全离线"，隐私政策却写收集 IP/行为、向免费用户投放第三方广告、埋 Clarity | 无遥测（本次未做全量 grep 验证 → **未验证**） | ✅ 我们更好（结构上；**未逐行验证**） |
| 58 | 插件沙箱用 **`vm2` ^3.9.19**（作者已宣布废弃且存在不可修复的沙箱逃逸） | 无插件系统（既是缺口也是免疫） | ❌ 完全没做（插件市场）／同时规避了该风险 |

**统计**：❌ 完全没做 **25** · ⚠️ 做了但残 **14** · ✅ 我们更好/相当 **11** · ✂️ 章程明确不做 **8** = **58 条**。
（#31 双链为"双方都没有"，计入"完全没做"栏；#44 与 #54 是对既有乐观结论的纠正，计入"做了但残"。）

---

### 4. 功能面反推的原始素材（供后续 agent 复用）

**memo.ac 导航面 [F]**
- 路由 12 条：`/`(→/home) · `/home` · `/batch-tasks`(Pro) · `/convert` · `/all` · `/edit/:id` · `/subtitle/:id` ·
  `/docs` · `/trash` · `/rss/:id` · `/folder/:id` · `/applications`
- 侧栏 6 项：Memo(/home) · 批量任务(Pro) · 媒体(/all) · 笔记(/docs) · 应用(/applications) · 回收站(/trash)
- 设置弹窗 12 个 tab：`common` `workspace` `llm` `prompt` `transcription` `translate` `tts` `integration`
  `proxy` `permission`(非 Win) `lab` `pro`
- 详情页右侧 6 个 tab：`transcription` `summary` `mindmap` `chat` `notes` `developer`(dev-only)
- 子应用窗口 2 个：`apps/ain`（笔记）· `apps/temo`（TTS 工作台）
- IPC 通道 **342** 条（R-01 的数字核实无误）

**OpenMemo 导航面 [O]**
- 路由 17 条：`/`(→/notes 或 /onboarding) · `/capture` · `/components` · `/diagnostics` ·
  `/notes` · `/notes/:uid` · `/notes/:uid/mindmap` · `/models` · `/models/:modelId` · `/onboarding` ·
  `/record` · `/runtime` · `/search` · `/settings`(→/settings/general) · `/settings/:section` ·
  `/settings/storage` · `/tasks`
- 侧栏：新建捕获 · 全部笔记 · 星标 · 录音 · 文件夹树 · 运行时 · 模型 · 任务 · 设置
- daemon：**REST 42 条 + `/media/asset/:ulid` + WS 2 条**（`/ws/recorder` 真实、`/ws/asr-worker` 501 桩）

> ⚠️ `/settings/:section` 的 `section` 参数**当前被 SettingsPage 完全忽略**（只渲染一个页面），
> 这意味着未来加 tab 时路由已经就位但没接线。**已做但残，未列入 58 条表（属实现细节）。**

---

### 5. 对 FEATURE-COVERAGE.md 的纠正（实测，Manager 请更新）

| 矩阵原文 | 实测 | 方向 |
|---|---|---|
| **B-2**「daemon 只有 6 个端点，`/api/notes` `/api/import` `/api/search` 不存在，`/media` 返回 501」 | **42 条 REST**，含 `/api/notes`(6)、`/api/notes/import`、`/api/search`、`/media/asset/:ulid`（完整 Range） | 偏悲观 |
| **B-1**「4 个 ASR 模型不在模型目录」 | 4 个全在（silero×2、sherpa-streaming-zh-14m、paraformer-zh-small、ct-transformer 标点） | 偏悲观 |
| **B-3**「设置页没有 API Key 输入框」 | `LlmSettingsSection.tsx` + `GET/PUT/DELETE /api/secrets` | 偏悲观 |
| 「拖拽上传 `onDrop` 是空函数」 | `CapturePage.tsx:92` 是真实现 | 偏悲观 |
| 「标签/星标/文件夹前端只读、零写入路径」 | `organize.ts` 8 条写路由 + `TagEditor.tsx` | 偏悲观 |
| 「笔记导出零实现零入口」 | `ExportMenu.tsx`（5 格式）+ `GET /api/notes/:uid/export` | 偏悲观 |
| 「TipTap 笔记编辑器完全遗漏」 | `NoteEditor.tsx` + `PATCH /api/notes/:uid`（TipTap JSON → 纯文本） | 偏悲观 |
| 「M-3 首启引导缺失」 | `/onboarding` + `isOnboardingDone()` 已接入首屏重定向 | 偏悲观 |
| **要求 2.2「目录/量化/fit/下载/校验/删除 🟢」** | fit/量化/校验/删除属实；**「可导入任意 HF」不成立**（501） | **偏乐观** |
| 「运行时管理页 🟡 未在真浏览器点过」 | 仍然**未在真浏览器点过**（本次也没点，只打了 API） | 仍准确 |

**新增两条矩阵里没有的阻塞**：
- **N-1**：前端引擎选择器与后端 `EngineId` 完全脱节（§1.2）。这是用户当前最直接的痛点。
- **N-2**：`RecorderPage` 的字幕流是 MOCK，而 `/ws/recorder` 后端是真的 —— **F3 端到端从未跑通过**，
  只是两头各自能跑。矩阵把 F3 流式 ASR 标 🟢 属于**偏乐观**。

---

### 6. 建议优先级（给 Manager）

1. **【最高】引擎/模型选择器改为 catalog 驱动，并从 RecorderPage 提到导入页 + 设置页**。
   数据源现成：`GET /api/models/catalog` 已按 `role`/`engines` 分组，直接渲染即可。
   同时删掉 `'turbo'` 这个不存在的引擎值。
2. **【高】sherpa 离线分支 + SenseVoice 进目录**。中文体验的最大单点缺口，一个模型条目 + 一个 `senseVoice` 分支。
3. **【高】接通 RecorderPage ↔ `/ws/recorder`**，把 F3 从"两头各自能跑"变成端到端。
4. **【中】whisper.cpp 的 Vulkan/ROCm**：上游没产物，要么自建（ADR-015 刚决定不自建），
   要么**改口径**——在文档与 UI 里明说"AMD GPU 目前只加速本地 LLM，ASR 走 CPU"。**不能继续宣称"真 AMD 支持"。**
5. **【中】把"可导入任意 HF GGUF"从对外话术里撤掉**，或补上"用户手工提供 SHA-256"的导入路径
   （既满足 ADR-004 决策 5，又能真正开放任意模型）。
6. **【低】回收站 / 摘要 / prompt 模板**：memo.ac 有、我们没有、章程也没要求，属可选扩展。

---

### 7. 诚实清单（本报告未能验证的）

| 事项 | 状态 |
|---|---|
| memo.ac Windows 包内是否含 Vulkan/DirectML | **仍未验证**（沿用 R-01，只解了 macOS 包） |
| memo.ac 思维导图是否节点级可编辑 | **仍未验证** |
| 引用的 memo.ac GitHub issue（#133 #218 #353 #359）现状 | **[R1] 未复核**，仅转述 R-01 |
| 我方任何页面的真浏览器点击验证 | **未做**（本次只读 API + 读码 + 读 git 历史） |
| 我方"零遥测" | **未验证**（未做全量出网调用 grep） |
| `RecorderPage` ↔ `/ws/recorder` 端到端 | **未跑通**（前端仍是 mock） |
| demo 实例状态 | 审计期间被其他 agent 重启（pid 2066756 → 2075454，绑定由 0.0.0.0 变回 127.0.0.1）。**我全程只读，未写未重启。** |
