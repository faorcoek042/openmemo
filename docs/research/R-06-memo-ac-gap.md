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
- **【T-080 追加，见文末附录 A】** 三条取证结论：① memo.ac 的「空间」= Workspace 一等公民，
  且**与用户指定的磁盘目录一一绑定**（逻辑分区与存储位置是同一个功能的两面），我们**零实现**；
  ② 代理是 `none/system/custom` 三态（**出厂默认 `system`**）+ 可切换的多条目列表，
  **无认证、无用户可配 bypass**（只有一条硬编码的、仅护 LLM 本地端点的 bypass）；子进程侧只覆盖 yt-dlp，
  但**云 LLM/云 ASR/模型下载全部经 agent 走代理**。我们的 `proxy.ts` 校验与 loopback 保护比它强，
  **但 daemon/downloader 侧零接线 —— 模型下载走不了代理，而它能**；
  ③ 云 LLM 是**混合制**：**Claude / Gemini / Mistral / Ollama 用原生客户端**，其余约 20 家走 OpenAI 兼容 + 每家 `baseURL`。
  → 我们的 `openai-compatible.ts` 方向对，但**接 Claude 与 Gemini 必须各写一个原生适配器**，不是加条注册表记录就行。
  （⚠️ 我在附录 A-3.2 第一版把这条判反了，已推翻并记录错因：把"打包器内联导致依赖清单里看不见"误读成"没装"。）

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

---

# 附录 A（T-080 追加）：空间管理 · 代理配置 · 云 LLM 接入

> 追加日期 2026-08-03，author memo-compare。触发：用户 5 条指令中的第 3/4/5 条。
> 本节全部证据等级 **[F]**（`/root/memo-forensics/` 解包原文，我本人复核），
> 少量标 **[F-推测]** 或 **NOT FOUND** 的已逐条注明。

## A-1. 「空间管理」是什么 —— 答案：**Workspace，一等公民，且与磁盘目录一一绑定**

**先回答 Manager 的歧义问题：两种含义在 memo.ac 里是同一个功能。**
它的「空间」既是 Notion-space 式的**逻辑分区**，又**物理上就是一个用户指定的磁盘目录**，
UI 里还直接显示该目录的**已用体积**与**可用空间**。不是两件事，是一件事的两面。

### A-1.1 数据模型 **[F]**

`workspace` 表字段（knex 建表语句）：
`id` · `name`(NOT NULL) · **`folder`(NOT NULL —— 文件系统路径)** · `icon` · `thumbnail` ·
`backgroundColor` · `description` · `created_at` / `updated_at`

层级与外键（全部实读建表语句）：

```
workspace (id, name, folder=磁盘路径, icon, thumbnail, backgroundColor, description)
   ├── folder.workspaceId      FK → workspace.id     （folder 另有 parentId → 子文件夹嵌套）
   │      └── resource.folderId FK → folder.id
   ├── resource.workspaceId    FK → workspace.id
   └── doc.workspaceId         FK → workspace.id     （doc 另有 noteId FK → note.id）
```

> ⚠️ **`note` 表的建表语句里没有 `workspaceId` 列**，但渲染层确实向 `noteData("update", …)`
> 传 `workspaceId` / `folderId`。**推测**由后续 migration 补列（R-01 记有 7 个 migration 文件），
> 但我**在 bundle 里没找到 `alterTable("note"` 或 `hasColumn("note"`**，故此条标 **[F-推测]，未核实**。
> 对我们的决策不影响：真正承载工作空间归属的是 `resource` / `doc` / `folder` 三张表。

### A-1.2 用户可见形态 **[F]**

| 维度 | 事实 |
|---|---|
| 入口 | 设置弹窗 12 个 tab 中的**第 2 个**，标签文案取自 i18n `workspace.manage workspace`（英文 "Workspace"） |
| 切换 | 侧栏顶部下拉；选中 → `selectCurrentWorkspace(ws, true)` → 立即 `navigate("/home", {replace:true})` |
| 新建表单字段 | **名称**（必填）· **存储文件夹**（必填，目录选择器）· **背景色**（取色器，默认随机）· **描述**（≤200 字） |
| 提交约束 | 名称与文件夹**两者都填**才允许提交（实读 `setDisabled(!folder \|\| !name)` 等价逻辑） |
| 数量上限 | **未见上限**（`workspaceList` 数组 + `unshift`，无容量判断） |
| 保底 | `workspaceList` 为空时自动重新拉取并选中第一个 → **始终至少 1 个** |
| 当前空间的持久化 | electron-store 键 `currentWorkspace`（不是数据库） |
| 磁盘体积 | 切换器挂载时调 `getWorkspaceFolderSize(id)` 并显示 |
| 删除 | `removeWorkspace({ id, deleteFolder: true })` —— **`deleteFolder` 硬编码为 true，连磁盘目录一起删**；文案明确警告不可撤销 |

官方英文文案（i18n 原文，可直接证明产品意图）：
- create → `Create a new workspace to consolidate all your resources.`
- workspace → `Set the folder where the workspace is located.`
- path → `Storage location`

IPC 通道 5 条 **[F]**：
`workspace-data`（CRUD 多路复用：`find`/`create`/`update`）· `remove-workspace` ·
`get-workspace-folder-size`（已用体积）· `get-workspace-folder-space`（**剩余可用空间**）· `open-workspace-folder`

> 产品动机 **[R1]**：R-01 引更新日志称 v1.0.4 引入「空间隔离」，为**共用电脑**场景设计；v1.5.3 加子文件夹（beta）。本次未复核更新日志。

### A-1.3 另有一套**纯磁盘管理**面（与上面是两回事）**[F]**

设置 → 通用里有独立的 `preferences.folder management` 分区，条目：
`extension package`（扩展包目录）· `model folder`（模型目录，可改、可打开）· `config folder` · 临时目录 ·
`language folder`，每条右侧都是「打开目录 / 更换目录」按钮。
另有 IPC `check-download-folder-space` / `checkDownloadSpace` 做**下载前空间预检**。

### A-1.4 对照我们 + 对 ADR-006 决策 4 的事实输入

| 项 | memo.ac **[F]** | OpenMemo **[O]** |
|---|---|---|
| 工作空间层 | 有，一等公民，独占一个设置 tab | **无**（全仓 `apps/*/src` `packages/*/src` grep `workspace` **零命中**） |
| 文件夹树 | 有（`folder.parentId` 嵌套） | 有（`folders.parent_id`），且已有 `color` / `icon` / `sort_order` / `deleted_at` |
| 存储位置 | **每个空间一个目录**，用户可选 | **全局一个 `dataDir`**，模型目录可在 `/settings/storage` 看到（`modelsRoot`） |
| 空间体积 / 剩余空间 | 有（两条 IPC） | 有 `GET /api/models/storage`（仅模型目录口径） |
| 删除即删盘 | 是（硬编码 `deleteFolder:true`） | N/A |

**给 Manager 的事实判断（不替你决策）**：
- ADR-006 决策 4 说「日后加只需一列 + 一次迁移」—— **这个成本估计是对的**，而且比你想的还低：
  我们的 `folders` 表已有 `parent_id` / `color` / `icon` / `deleted_at`，
  补一张 `workspaces` 表 + `folders.workspace_id` 一列即可，`notes` 通过 `folder_id` 间接归属，**不需要动 notes**。
- 但**有一处成本你的 ADR 没算到**：memo.ac 的空间**绑定磁盘目录**。
  如果要 1:1 对齐，就不只是加一列，而是要把「每空间独立存储根」引入 daemon 的路径解析层
  （目前 `resolvePaths(dataDir)` 是全局单例）。**这才是真正的工作量所在。**
- **可拆**：逻辑分区（低成本）与每空间独立磁盘根（高成本）是两件事，可以只做前者。
  用户说的「没有空间管理功能」**未指明**是哪一层 —— **建议先向用户确认，不要替他选。**

---

## A-2. 代理配置 —— memo.ac 的形态

### A-2.1 三态模式 **[F]**

设置 → `preferences.proxy setting`（英文 "Proxy"），一组 radio，三选一：

| 值 | i18n key | 英文文案 |
|---|---|---|
| `none` | `preferences.disable proxy` | Disable proxy |
| `system` | `preferences.use system settings` | System proxy settings |
| `custom` | `preferences.use custom proxy` | Custom proxy |

持久化形状（实读运行时读取逻辑）：

```
{ type: "none" | "system" | "custom",
  proxy: [ { hostname, port, type, active }, … ] }     // custom 模式下是一个数组
```

- **`custom` 是一个列表，取其中 `active === true` 的那条生效** —— 即可以存多条代理配置来回切。
- 条目字段只有 `hostname` / `port` / `type` / `active`；表单里**只有 hostname 与 port 两个输入框**
  （占位符 `127.0.0.1` / `7890`）。
- **存储位置不是 electron-store**，而是自建的 `conf/setting.conf` JSON（electron-store 在这个 App 里另有他用）。
- **出厂默认值是 `{ type: "system" }`** —— 即开箱即跟随系统代理，不是 `none`。这个默认值选得好，值得抄。

### A-2.2 协议与能力 **[F]**

| 能力 | 结论 |
|---|---|
| HTTP 代理 | ✅ `type === "http"`（UI 标签 "Http(s)"）→ 构造 `http://host:port`，用 HttpsProxyAgent |
| SOCKS 代理 | ✅ UI 标签 "Socks5"；非 http 条目拼 `socks://host:port`，走 SocksProxyAgent |
| **UI 只暴露两种** | ⚠️ 协议选择是**两个 tab：`http` / `socks5`**。底层 vendored 的 SocksProxyAgent 支持 `socks4/4a/5/5h`，但**`socks4` 系没有入口** |
| **代理认证（用户名/密码）** | **NOT FOUND** —— 条目结构无 `username`/`password`，表单无对应输入框。（bundle 里确有 `proxyAuth` → `Proxy-Authorization: Basic` 的代码，但那是**第三方 tunnel 库的未接线管道**，没接到它的设置项上） |
| **用户可配的 bypass / no_proxy 列表** | **NOT FOUND** —— 没有这个设置项 |
| **硬编码的内部 bypass** | ✅ **有，但只作用于 LLM 端点**：构造 LLM 客户端时，若 `baseURL` 的主机名属于 `localhost` / `127.0.0.1` / `0.0.0.0` / `::1` / `[::1]` 或以 `.local` 结尾，**跳过代理注入**（避免把本地 Ollama 的请求送进代理）。其余链路无此保护 |

> 关于 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量：我自己 grep 主进程 bundle 得到 `HTTPS_PROXY` **2 处命中**，
> 但两处都在**第三方库内部**（一个 proxy-from-env 式的辅助函数、以及内置的 Mixpanel 遥测客户端），读的是 `process.env`。
> **memo.ac 自己的代码从不设置这三个环境变量。**（我的 subagent 报告称 0 命中，与我的实测不符；
> 以我的直接 grep 为准，两者结论方向一致：**它不靠 env 传代理**。）

### A-2.3 system 模式怎么探测 **[F]**

用 Electron 的 `session.resolveProxy("https://www.google.com")`：
返回非 `"DIRECT"` 时按空格切出 `PROXY host:port` 再拆成 host / port，构造 `http://host:port`。
探测期间向渲染层推两个事件：`proxy:check:system:start` → `proxy:check:system:stop`（1 秒后）。

> ⚠️ **设计教训（值得我们避开）**：探测目标写死 `https://www.google.com`。
> 而这个功能的主要受众正是**被墙的中国用户** —— 探测目标本身不可达。
> 我们若做 system 探测，应改用可达且中立的目标，或直接读系统代理设置而非发探测请求。

### A-2.4 代理作用到哪些链路 **[F]**

| 链路 | 是否走代理 | 证据 |
|---|---|---|
| **yt-dlp 子进程** | ✅ **argv 显式传** `--proxy <url>` + `--socket-timeout 60`；SOCKS 时传 `--proxy socks://host:port` | 实读 `applyProxyArgs()` |
| 自身 HTTP 客户端（模型下载 / API） | ✅ 通过 agent 注入（`{ httpAgent, httpsAgent }` 形式的 agent 包装） | 实读 agent 构造函数 |
| **Electron 会话级**（`session.setProxy` / `--proxy-server` 开关） | **NOT FOUND** —— 两者在 12 MB 主进程 bundle 里 0 命中。**渲染层自身的网络请求不走用户配置的代理** | 实测 grep |
| ffmpeg / whisper-cli 等其他子进程 | **NOT FOUND** —— 没找到为它们注入 `HTTP_PROXY` 的环境构造 | 实测 grep |
| **云 LLM / 云 ASR 调用** | ✅ **走**（已核实）：云转写把 agent 塞进 `fetchOptions`；翻译与 LLM 客户端经同一个 agent 工厂注入 `httpAgent`（受 A-2.2 的本地 bypass 约束） | 实读调用点 |
| 授权校验 / 插件与扩展下载 / RSS / GitHub 版本检查 / TTS | ✅ 全部走同一个 agent 工厂（约 37 处调用点） | 实读 |

### A-2.5 有没有「测试连接」**[F]**

> ⚠️ **本小节是对我自己前一版结论的更正。** 我最初写的是"测试连接测的不是代理，而是下载源"——**错了**。
> 深挖后确认：**是两个独立的测试**，代理有自己专属的那一个。

**（A）代理专属的「测试连接」** —— IPC `test-proxy`：
用当前代理 agent 请求 **`https://youtube.com`**，测往返延迟并把毫秒数回给 UI；失败则报错。
按钮文案 `preferences.test connection`，仅在 `type === "system"` 或（`custom` 且已有条目）时可用。
> 选 `youtube.com` 作为探测目标是**合理**的（用户配代理多半就是为了访问它），
> 与 A-2.3 里 system 探测选 `google.com` 的问题不同——后者是探测**系统设置**却依赖出网，那才是设计缺陷。

**（B）下载源的域名延迟表** —— IPC `test-domain` / `get-domain-test-result`：
对三个 whisper 模型镜像域名（`huggingface.co` / `hf-mirror.com` / `aifasthub.com`）逐个 ping（不可用则 HTTP HEAD），
超时 5000 ms，每域返回 `{domain, latency, status, error, method}`。
UI 成功显示 `preferences.network latency` + 毫秒数，失败显示 `preferences.connection error`；
配套 `download source` / `current source` / `system choose`（"If no source is specified, the system will automatically select"）。
→ 即：**多下载源 + 逐域名测延迟 + 自动选最快**。**注意它也会经过代理 agent。**

**代理相关 IPC 通道**：`check-system-proxy` · `test-proxy` · `test-domain` · `get-domain-test-result` ·
`check-network`（对 HuggingFace + GitHub 做 HEAD 探活）· 以及通用的 `change-setting` / `get-setting`。

### A-2.6 对照我们 **[O]**

**我们的子进程侧已经做得比 memo.ac 好，但只做了一半（下半截全缺）。**

已有（`packages/pipeline/src/subprocess/proxy.ts`，189 行，`gpu-runtime` 交付）：

| 能力 | 我们 | memo.ac |
|---|---|---|
| 协议 | http / https / **socks5 / socks5h / socks4 / socks4a**（`PROXY_SCHEMES`） | UI 只有 `http` 与 `socks5` 两档 |
| **用户可配的 no_proxy / bypass** | ✅ 有 `noProxy` 字段 | ❌ NOT FOUND |
| **loopback 保护** | ✅ **无条件强制预置** `localhost,127.0.0.1,::1`，覆盖**全部**链路 | ⚠️ 有，但**只保护 LLM 端点**（`localhost`/`127.0.0.1`/`0.0.0.0`/`::1`/`[::1]`/`*.local`），其余链路无 |
| 输入校验 | ✅ scheme 白名单 / 控制字符 / 前导 `-`（防 argv 注入）/ 1024 字节上限；**先查控制字符再 `new URL()`**（避免解析器把恶意串洗白） | 未见等价校验 |
| 凭据脱敏 | ✅ `redactProxyUrl()` 进日志前抹掉用户名密码 | 未见（但它也没有认证字段，无从泄露） |
| yt-dlp | ✅ `ytDlpProxyArgs()` → `--proxy <url>` | ✅ 同（另加 `--socket-timeout 60`，**这一条值得抄**） |
| **ffmpeg** | ✅ `ffmpegProxySupport()`，并**如实报告 ffmpeg 不支持 SOCKS**（libavformat 只读 `http_proxy`），返回 `{supported, reason}` 让上层能准确告警而不是静默直连 | ❌ 未处理 |
| 大小写双写 env | ✅ `http_proxy`+`HTTP_PROXY`+…（两派工具各读一套）；SOCKS 时补 `ALL_PROXY` | ❌ 不走 env，全靠 agent 注入 + yt-dlp argv |
| 默认值 | ⚠️ 无（还没有设置项） | ✅ 出厂即 `{type:"system"}` |

**缺的下半截（全部实测确认）**：
1. **daemon 侧零接线** —— `apps/daemon/src` 与 `packages/downloader/src` grep `proxy` 除一处无关注释外**零命中**。
   即**模型下载根本走不了代理**，而这恰恰是最需要代理的链路。memo.ac 在这条链路上是覆盖到的（agent 注入）。
2. **无持久化** —— `settings` 表当前为空，`settings.ts` 里没有 proxy 键。
3. **设置页无 UI**。
4. **无「测试连接」** —— memo.ac 有两个测试（代理专属的 `test-proxy` + 下载源域名延迟表）。
   我们已有 `POST /api/models/sources/probe`（多镜像探活），**形态与它的下载源延迟表几乎一致，接上代理即可复用**；
   但**代理专属的那一个（一次带 agent 的真实往返 + 报延迟）我们完全没有，需要新做**。

**三条可直接抄的设计**：① 默认 `system` 而非 `none`；② yt-dlp 附带 `--socket-timeout 60`（代理慢时不会挂死）；
③ 代理测试与下载源测试**分开两个按钮**——前者答"我的代理通不通"，后者答"哪个镜像最快"，混在一起用户无法定位问题。

---

## A-3. 云端 LLM 接入（用户指令 3：不做本地模型，改接在线 API）

### A-3.1 供应商清单 —— **两份并存的名单，互不相等** **[F]**

⚠️ 重要：bundle 里有**两套**供应商标识集合，**内容不一致**，不能当成一份用。

**（甲）枚举常量，24 项**（编译后的 TS enum）：
`gemini` · `openai` · `claude` · `ollama` · `deepseek` · `doubao` · `groq` · `xai` ·
`siliconcloud` · `openrouter` · `together` · `zhipuai` · `zhipuaicodingplan` · `moonshot` ·
`kimicodingplan` · `lmstudio` · `minimax` · `minimaxtokenplan` · `mistralai` · `qianfan` ·
`qwen` · `xiaomimimo` · `aliyun` · `azura`

**（乙）带 displayName/description 的服务注册表，24 项**：

| id | 显示名 | | id | 显示名 |
|---|---|---|---|---|
| `openai` | OpenAI GPT | | `siliconcloud` | SiliconFlow |
| `claude` | Anthropic Claude | | `xai` | xAI Grok |
| `gemini` | Google Gemini | | `mistral` | Mistral AI |
| `deepseek` | DeepSeek AI | | `meta` | Meta Llama |
| `zhipuai` | ZhipuAI | | `moonshot` | Moonshot AI (Kimi) |
| `zhipuaicodingplan` | ZhipuAI Coding Plan | | `poe` | Poe by Quora |
| `kimicodingplan` | Kimi Coding Plan | | `volcengine` | Volcano Ark |
| `huggingface` | Hugging Face | | `lmstudio` | LM Studio Local |
| `openrouter` | OpenRouter | | `ollama` | Ollama Local |
| `perplexity` | Perplexity AI | | `minimax` | MiniMax API |
| `vertexai` | Google Vertex AI | | `minimaxtokenplan` | MiniMax Token Plan |
| `alibaba` | Alibaba Cloud Bailian | | **`custom`** | **Custom Service** |

两份并集约 **31 个**独立标识。甲表独有：`doubao` `groq` `together` `qianfan` `qwen` `xiaomimimo` `aliyun` `azura`；
乙表独有：`huggingface` `perplexity` `vertexai` `meta` `poe` `volcengine` `custom`。
**推测**甲是较早的翻译/转写 provider 枚举、乙是较新的 LLM 服务注册表，**未核实**。

### A-3.2 ⭐ 架构：**混合制 —— 4 家原生 SDK + 其余走 OpenAI 兼容**

> 🛑 **本小节是对我自己前一版结论的推翻。** 我上一版写的是
> **"它没有为任何一家装 SDK，~31 家全靠 OpenAI 兼容 + baseURL"**，并标了"高置信，独立双源核实"。
> **这是错的**，而且**错在方法上**，值得记录下来。

**我的错误链条**：我查了 `app_package.json`（29 个 runtime 依赖）与 `nm.txt`（417 个 node_modules 目录），
两处都没有 `@ai-sdk/anthropic` / `@ai-sdk/google` 之流，于是断定"没装"。
**但这两个"来源"根本不独立** —— 它们量的是同一件事：**以独立目录形式随包分发的依赖**。
纯 JS 的库会被打包器**内联进 `dist-electron/main/index-*.js`**，从两处同时消失；
只有原生模块（`sqlite3`、`sherpa-onnx-node`…）才会留在 `nm.txt` 里。
**「两处都查不到」对纯 JS 库不构成任何证据。我把"没看见"当成了"不存在"。**

**实际情况（我在 12 MB 主进程 bundle 里直接 grep 计数，非转述）**：

| 标记 | 主进程 bundle 命中数 |
|---|---|
| `ChatOpenAI` | **19** |
| `/v1/messages`（Anthropic Messages API 路径） | **28** |
| `x-api-key`（Anthropic 认证头） | **11** |
| `api.anthropic.com` | **7** |
| `ChatAnthropic` | **5** |
| `generativelanguage.googleapis.com` | **5** |
| `ChatGoogleGenerativeAI` | **4** |
| `ChatOllama` | **2** |
| `anthropic-version` | **2** |
| `ChatMistralAI` / `@anthropic-ai/sdk` / `@google/genai` | 各 **1** |
| `ChatDeepSeek` / `ChatXAI` / `ChatZhipuAI` / `ChatGroq` / `ChatTogetherAI` | **各 0** |

→ **修正后的结论**：memo.ac 是**混合制**。

- **4 家有原生客户端**（协议不兼容 OpenAI，必须单独适配）：
  **Claude**（Anthropic Messages API：`/v1/messages` + `x-api-key` + `anthropic-version` 头）、
  **Gemini**（`generativelanguage.googleapis.com`）、**Mistral**、**Ollama**。
- **其余约 20 家走同一个 OpenAI 兼容客户端 + 每家一个 `baseURL`**
  （DeepSeek / xAI / 智谱 / Groq / Together / 通义 / 豆包 / MiniMax / 千帆 / SiliconCloud / OpenRouter / LM Studio … 均无专用类）。

**对我们的真实含义（比我上一版给的建议更贵，请以此版为准）**：
- OpenAI 兼容这条路**确实覆盖了大多数（约 20/24）**，我们 `openai-compatible.ts` 的方向没错。
- **但 Claude 与 Gemini 覆盖不了** —— 这两家恰恰是最主流的两家。
  想接它们，`packages/llm` **必须新增两个适配器**（Anthropic Messages 格式 + Gemini 格式），
  这不是"加一条注册表记录"就能解决的。**上一版我说"缺的只是清单与 UI"，低估了工作量。**
- 附带发现：bundle 里还内联了 `@alicloud/tingwu20230930`（阿里"通义听悟"，是**语音/会议转写**服务而非 LLM），
  **推测**为第 5 条云 ASR 通路，但仅 1 处命中，**未核实**。

### A-3.3 供应商描述符的 schema（这份值得抄）**[F]**

远端注册表 `https://model.memo.ac/llm-models/manifest.json`，本地缓存在
`conf/llm-models/manifest.json` + 每家一个 `<provider>.json`，带 **sha256** 校验。

每个供应商描述符的字段：
`name` · `description` · `provider` · `icon` · `homepage` · `documentation` ·
**`modelListSource`** · **`baseURL`** · `capabilities` · `models` · `defaultModel` · **`configFields`**

两个关键设计：
- **`configFields`** = 配置表单由数据描述，不是每家写一个 React 组件。加一家 = 加一条 JSON。
- **`modelListSource`** = 模型清单从哪来（供应商的 `/models` 端点 or 内置列表），做到**模型下拉自动填充**。

IPC 5 条：`llm:model-registry:{get-status, ensure-dir, check-update, update, reload}`
→ 注册表可**独立于主程序热更新**（新供应商上线不必发版）。

补充细节 **[F]**：
- `configFields` 的**字段键全集**只有 7 个：`apiKey`（password）· `model`（select）· `baseURL`（url）·
  `temperature`（number）· `maxTokens`（number）· `deploymentId` · `apiVersion`。
  后两个**只有 Azure 一家**用。没有 `topP` / `contextWindow` / `timeout` / `organization` 的表单项。
- `modelListSource` 有**三种取值**：`official-doc`（注册表内置静态清单，条目带 `checkedAt` 日期，人工策展）·
  `official-api`（实时打供应商的 `/models`，如 OpenRouter、SiliconCloud）·
  `local-api`（打本地服务，如 Ollama 的 `/api/tags`、LM Studio）。
- 注册表更新是**原子写**（`.tmp` + `.bak`），差异原因枚举 `version` / `updatedAt` / `missing` / `same`。
- ⚠️ **表单的 label/help 文案是硬编码在注册表数据里的英文（部分是中文），完全没走 i18n** ——
  这是它的一个**缺陷**，不要抄。我们做注册表时应把 label 存成 i18n key。

### A-3.4 自定义 / OpenAI 兼容端点 **[F]**

- 注册表里有 `custom` → **"Custom Service"**，渲染层有 `addCustomService` 动作与 `pendingAddCustomLLMService` 状态，
  主进程有 `llm:save-custom-service` / `llm:get-custom-services` / `llm:delete-custom-service` 三条 IPC。
  → **可以填任意 OpenAI 兼容 base URL + 任意 model id。**
- 自定义服务还支持 **`dynamicModelsEnabled` + `dynamicModelsUrl`** —— 指向用户自己的 `/models` 端点自动拉模型清单。
  存储对象含 `maxContextToken` / `maxOutputToken` / `pricing` 等字段。
- **「只有 OpenAI 能配自定义 base URL」这个说法已被推翻**（R-01 引其 issue #353/#359）：
  实测 **24 家里 22 家的 `configFields` 都有可编辑的 `baseURL`**。
  唯二例外：**Mistral**（整个字段都没有，因为走原生 SDK）与 **Azure**（`baseURL` 必填且无默认值，另需 `deploymentId` + `apiVersion`）。
  → **R-01 的这条转述不成立，请勿再引用。**

### A-3.5 对照我们 **[O]**

| 项 | memo.ac | OpenMemo |
|---|---|---|
| 架构 | **混合**：Claude/Gemini/Mistral/Ollama 原生客户端 + 其余 ~20 家走 OpenAI 兼容 | 只有 OpenAI 兼容一条路 → **接 Claude/Gemini 需新写两个适配器** |
| 供应商数量 | 24 内置 + 自定义（另有一份 24 项的旧枚举，并集约 31） | 注释列了 OpenAI/DeepSeek/Groq/xAI/Moonshot/SiliconCloud/OpenRouter/通义/智谱/Ollama/LM Studio/内置 llama-server；**清单硬编码在代码里，非注册表** |
| 供应商注册表 | 远端 JSON + sha256 + 原子写 + 热更新 + `configFields` 动态表单 | **无** |
| 模型下拉自动填充 | `modelListSource` 三模式 | **无** |
| 每功能独立选模型 | ✅ chat / (summary+mindmap) / translate **各自独立**的 provider+model | **无**（只有全局一处） |
| 自定义端点 | ✅ `custom` 服务 + 动态模型 URL | ✅ 有（任意 baseURL），**无动态模型拉取** |
| **Key 存储** | ⚠️ **明文 JSON**（`conf/setting.conf`）。全 bundle **`safeStorage` 0 命中**。唯一的 AES-256-CBC 用了**硬编码静态密钥+IV**，且只加密 Notion 的 secret，**LLM key 不经过它** | `secrets` 表 + `SecretStore`，`GET /api/secrets` 只返回掩码，且**强制向用户明示「明文存储在 <路径>，权限 0600」**（ADR-006 决策 1） |
| 本地 LLM | Ollama / LM Studio | 同 + **内置 llama.cpp**（用户指令 3 要求砍掉本地自接，此项将成为待裁撤项） |

> Key 存储这条值得说清楚：**双方实质都是明文落盘，谁也不比谁安全**。
> 差别在于**我们明确告诉用户**（ADR-006 强制 disclosure），而它不说。
> 它那把硬编码静态密钥的 AES 属于**安全剧场**——密钥就在同一个二进制里，拆包即得。**不要抄。**

**给 Manager 的四条落地建议（第 1 条已按新证据改写）**：
1. ~~架构不用改~~ → **架构要补**。OpenAI 兼容覆盖约 20/24 没错，
   但 **Claude 与 Gemini 必须各写一个原生适配器**（Anthropic Messages `/v1/messages` + `x-api-key` + `anthropic-version`；
   Gemini 的 `generativelanguage.googleapis.com`）。这两家是主流，不接说不过去。**这是我上一版漏报的工作量。**
2. **把硬编码供应商清单改成一份 JSON 注册表**，字段对齐 A-3.3（尤其 `configFields` 与 `modelListSource`），
   但**两处要比它做得好**：① 注册表**进 git 仓库而非远端拉取**（章程 local-first，不宜新增云依赖）；
   ② label/help **存 i18n key 而非硬编码英文**。
3. **每功能独立选模型**（chat / 摘要+导图 / 翻译各自一套）是它的设计，我们目前只有全局一处 —— 值得跟进。
4. **用户指令 3 触发的连锁删除**：`llm/*` 5 个 GGUF 模型 + llama.cpp 后端包 4 个（cpu/cuda/vulkan/rocm）将失去用途。
   **这是需要你裁决的删除决策，我不替你做。**
   注意：删掉本地 LLM 后 `vulkan`/`rocm` 后端包也随之无用 —— 那正是我们唯一的 AMD 加速路径（见 §3.6 #44），
   **删除后「真 AMD 支持」将彻底不成立，对外话术必须同步更正。**

---

## A-4. 本节诚实清单

| 事项 | 状态 |
|---|---|
| `note` 表是否由 migration 补了 `workspaceId` 列 | **未核实**（未找到 alterTable/hasColumn 证据） |
| memo.ac 空间数量是否真无上限 | **未见上限判断**，但不排除在我没读到的代码路径里 |
| 代理是否作用于云 LLM / 云 ASR 调用 | ✅ **已核实为「是」**（初版标未核实，后由 subagent 定位到调用点后更正） |
| 「测试连接」测的是什么 | ✅ **已更正**：初版我写"只测下载源"是**错的**，实为两个独立测试，代理有专属的 `test-proxy`（打 `youtube.com` 测延迟） |
| memo.ac 的 API Key 存储方式与是否加密 | ✅ **已核实**：明文 JSON（`conf/setting.conf`），`safeStorage` 0 命中；唯一的静态密钥 AES 只用于 Notion secret，不覆盖 LLM key |
| 非 OpenAI 供应商能否改 baseURL | ✅ **已核实并推翻 R-01**：24 家里 22 家的 `configFields` 都有可编辑 `baseURL`；例外只有 Mistral（走原生 SDK，无该字段）与 Azure（必填无默认）。R-01 引的 issue #353/#359 说法**不成立** |
| **A-3.2「它没装任何厂商 SDK」（本报告第一版结论）** | ❌ **已推翻**。实测 bundle 内联了 `@anthropic-ai/sdk` / `@google/genai` / `@langchain/{anthropic,google-genai,ollama,mistralai}`，`/v1/messages` 28 处、`x-api-key` 11 处、`api.anthropic.com` 7 处。**错因：把"打包器内联后依赖清单里看不见"误当成"没装"，且把两个同源指标当成了独立双源。** |
| `@alicloud/tingwu20230930`（阿里通义听悟）是否为第 5 条云 ASR 通路 | **推测，未核实**（仅 1 处命中） |
| 甲/乙两份供应商名单里 `poe`/`perplexity`/`vertexai`/`meta`/`huggingface` 是否真的可用 | **未核实** —— 它们出现在 displayName 注册表里，但不在 24 项内置 registry 对象中 |
| 甲/乙两份供应商名单的确切分工 | **推测**，未核实 |
| 用户说的「空间管理」指逻辑分区还是每空间独立磁盘根 | **未知 —— 建议直接问用户** |

---

# 附录 B（T-113 追加）：memo.ac 内置清单逐条取证 —— 供对齐用

> 追加日期 2026-08-03，author memo-compare。触发：用户「模型改成下拉了，但和 memo 内置几个选项不一样，我不是让你做统一吗」。
> **交付物是两份 JSON，不是本节表格** —— `model-mgmt` 请直接读文件：
> - `docs/research/assets/memoac-llm-providers.json`（24 家 / 520 条模型 / 255 KB）
> - `docs/research/assets/memoac-asr-models.json`（whisper 15 条 + 三个越界引擎 + **UI 呈现方案**）
>
> **取证方法（因为我上次犯过"把没看见当成不存在"的错，这次说清楚）**：
> 主进程 bundle 里的供应商注册表是一个被压缩过的对象 `hHn`，24 个键的值全是压缩变量名，
> 每个变量的值又是压缩变量名，逐层套了 3～4 层。我写了一个**变量解析器**（`define`/`resolve`）
> 沿 `<var>=<literal>` 逐层展开到字面量，再用 Node 求值成 JSON。
> **24 家全部解析成功，0 失败**，`_meta.evidence` 里记了取证位置。
> 分组逻辑取自渲染层函数 `YKt`；默认值取自渲染层 mobx store 初值与主进程默认设置对象。

## B-1. LLM：24 家内置供应商

**总量：24 家 / 520 条内置模型条目。**

### B-1.1 默认选中的是哪家哪个 —— **答案有个坑，必须说清楚**

- UI 初始高亮 = **`openai`**，其默认模型 = **`gpt-5.4-mini`**（该家 `defaultModel` 字段）。
- **但主进程的默认设置对象 `pte` 里根本没有任何 LLM 供应商键**
  （它只有 `themeSource` / `translateProvider:"Microsoft"` / `language` / `vad` / `proxy` 等）。
- → **含义：memo.ac 出厂状态下没有任何可用的 LLM。** `openai` 只是下拉框的初始高亮，
  在用户填 Key 之前它是不可用的。**"默认选中 openai"≠"开箱即用"。**
  我们若照抄，要同步照抄这个诚实的空状态，而不是假装已经配好了。

### B-1.2 六家「主流置顶」+ 三桶分组 —— **这是下拉不像一堵墙的关键**

渲染层有一个硬编码的置顶序列（顺序即优先级）：

```
["openai", "claude", "gemini", "deepseek", "ollama", "lmstudio"]
```

分组函数 `YKt(services, models)` 把 24 家分成**三桶**：

| 桶 | 规则 |
|---|---|
| `configured` | 已配好的（判据：`apiKeyRequired ? hasApiKey : (isConfigured \|\| hasUserConfig \|\| hasApiKey)`） |
| `mainstreamUnconfigured` | 没配好、但在上面 6 家置顶名单里 |
| `more` | 其余全部（折叠区） |

`primary = configured + mainstreamUnconfigured`，排序键 = 置顶名单里的下标，其次是注册表原始顺序。
→ **用户第一眼只看到「已配好的 + 6 家主流」，另外十几家收进 `more`。**

### B-1.3 四家原生 + 十九家 OpenAI 兼容（`kind` 字段已写进 JSON）

| kind | 家数 | 谁 |
|---|---|---|
| `openai-compatible` | **19** | deepseek / doubao / groq / lmstudio / minimax / minimaxtokenplan / moonshot / openai / openrouter / qianfan / qwen / aliyun / azura / siliconcloud / together / xai / xiaomimimo / zhipuai / zhipuaicodingplan |
| `anthropic-native` | 1 | claude |
| `google-native` | 1 | gemini |
| `mistral-native` | 1 | mistralai |
| `ollama-native` | 1 | ollama |
| `anthropic-compatible` | 1 | kimicodingplan（`baseURL` 是 `…/anthropic`，走 Anthropic 协议） |

**`baseURL` 可编辑：24 家里 23 家**（JSON 里 `baseUrl.editable`）。
唯一没有该字段的是 **mistralai**（走原生 SDK）；**azura**（Azure）有该字段但**必填无默认**，另需 `deploymentId` + `apiVersion`。
> 这再次确认附录 A-3.4 的结论：R-01 转述的"只有 OpenAI 能配 base URL"**不成立**。

### B-1.4 模型条目最多的几家（说明为什么必须分组）

| 家 | 内置模型条目 |
|---|---|
| qianfan（百度千帆） | **82** |
| qwen（通义） | **70** |
| siliconcloud | **66** |
| azura（Azure） | 35 |
| openai / openrouter | 各 30 |
| together | 27 |
| ollama | 25 |
| mistralai | 22 |
| zhipuai | 16 · groq 15 · claude 14 · gemini 14 · doubao 13 · moonshot 13 · xai 12 |
| 其余 | ≤ 7 |

→ **520 条模型如果平铺是不可用的。** 它的解法是三层：先选供应商（三桶分组）→ 再选该家的模型 →
模型清单本身还分三种来源（`modelListSource.type`）：`official-doc`（注册表内置静态清单，带 `checkedAt` 日期，人工策展）/
`official-api`（实时打厂商 `/models`，如 openrouter、siliconcloud）/ `local-api`（打本地服务，如 ollama、lmstudio）。

### B-1.5 图标与品牌色（`ui-polish` 要的）

每家有 `icon` 字段（字符串 id，如 `openai` / `claude` / `gemini` / `doubao` / `qianfan` …），JSON 里已逐条带上。
**`icon` 只是名字，不是图片**；对应的图标资源来自渲染层依赖 `@icons-pack/react-simple-icons` + `lucide-react`。
⚠️ **注册表里没有任何品牌色字段** —— 我查了 24 家的全部字段，`color` / `brandColor` / `theme` 一律 **NOT FOUND**。
`ui-polish` 想要品牌色只能自己定，**不要说是从 memo.ac 抄的**。

### B-1.6 配置表单

`configFields` 键全集只有 7 个：`apiKey`(password) · `model`(select) · `baseURL`(url) ·
`temperature`(number) · `maxTokens`(number) · `deploymentId` · `apiVersion`（后两个只有 Azure 用）。
每家用其中 3～7 个，逐家清单见 JSON 的 `configFieldKeys`。
⚠️ 它的 label/help **硬编码英文（部分中文）不走 i18n** —— 缺陷，别抄，我们应存 i18n key。

## B-2. ASR：whisper 15 条 + 呈现方案

⚠️ 按 ADR-016，sherpa / parakeet / funasr **我们不补**。JSON 里它们在 `outOfScopeEngines` 下，
标了 `outOfScope: true` 与理由，只为存档完整，**不要拿去扩清单**。

### B-2.1 它的 15 条 vs 我们的 25 条 —— **我们的更长，所以更需要分组**

| | memo.ac | OpenMemo（实测 `models-whisper.json`） |
|---|---|---|
| 条目数 | **15** | **25** |
| 逻辑模型组 | 15（无组概念） | **12 组**（`groupId`） |
| 量化 | **全 f16，无选择** | f16 / q5_0 / q5_1 / q8_0 |
| 分组轴 | `lang` × `speedValue` | `groupId` × `quantization` |

**我们的清单比它长 67%，还多了一个量化维度。它那套 15 条的平铺方式我们照抄会更糟。**

### B-2.2 它怎么让 15 条不像一堵墙（**这才是要抄的**）

**面 A · 转写设置里的快速选择器** —— **是双轴筛选，不是列表**：
- 轴 1 `lang`：`multi` / `en` / `zh` / `ja`，用 Select
- 轴 2 `speedValue`：`fast` / `balance` / `quality`，用 Tabs
- 只渲染 `lang === 选中语言 && speedValue === 选中档位` 的那几条，做成**固定尺寸卡片**（不是下拉行）
- → **任一时刻画面上通常只有 1～3 张卡，而不是 15 行**
- 每个档位配一句提示文案（`model.fast/balanced/quality mode hint`）——**档位名本身没有信息量，必须配一句代价说明**
- 状态行：已装则显示「当前模型 + 名称」，未装则显示「下载模型」

**面 B · 设置里的模型管理列表**：语言 Select（默认「全部模型」）+ 选「全部」时**按语言分节渲染**，
每行 = 名称 + 「未下载」灰字 + 当前项打勾。

**面 C · 额外引擎列表**：显示前**剥掉 `sherpa-onnx-streaming-` 前缀**，名称后括号里跟体积。

### B-2.3 给 `model-mgmt` 的具体落地项（**发现一处真实的 schema 缺口**）

要做成它那种双轴，我们的 manifest **少一根轴**：

| 轴 | 我们有没有 | 说明 |
|---|---|---|
| 语言 | ✅ 有 `languages`（`["multi"]`），且已有 `-en` 分组 | 需归一成 `multi` / `en` 两档即可 |
| **速度/质量档** | ❌ **没有** | 我们只有 `quantTier`（实测取值 `small` / `balanced` / `full` / `large`）—— 那是**量化体积轴，不是速度轴**。tiny-f16 与 large-v3-f16 都会落进「full」，但两者速度差几十倍 |

→ **建议**：给 manifest 加一个 `speedTier: "fast" | "balance" | "quality"`，按模型族定
（tiny/base → fast，small → balance，medium/large → quality），**与 `quantTier` 并存互不替代**。
这样双轴筛选的两根轴才都齐。**这是我们与 memo.ac 对不齐的真正原因之一，不是选项抄漏了。**

三层结构建议（因为我们比它多一个量化维度）：
1. **卡片 = `groupId`**（12 个逻辑模型），按 `lang × speedTier` 双轴筛选 → 一屏 1～3 张
2. **量化 = 卡片内的分段控件**（f16 / q5_0 / q8_0…），不占外层列表位
3. 下载状态与 fit 徽标**画在卡上**，不做单独的「已安装」tab

## B-3. 本节诚实清单

| 事项 | 状态 |
|---|---|
| 24 家供应商对象解析 | ✅ **24/24 成功，0 失败**，逐层展开自压缩变量 |
| 520 条模型条目 | ✅ 由解析结果程序化统计，非人工计数 |
| 默认供应商 `openai` | ✅ 渲染层 store 初值；**但主进程默认设置里无 LLM 键**（即出厂无可用 LLM），两条都已核实 |
| 6 家置顶名单与三桶分组 | ✅ 渲染层 `YKt` 原文 |
| **品牌色** | ❌ **NOT FOUND** —— 注册表无 `color`/`brandColor`/`theme` 字段。`ui-polish` 需自定 |
| 图标资源本体 | **未核实** —— 只拿到 `icon` 字符串 id，没去核对它映射到哪个图标包的哪个图形 |
| 模型 id 的时效性 | ⚠️ 是 memo.ac 的**人工策展快照**（`modelListSource.checkedAt` 多为 2026-05-31）。**落地前必须对厂商官方文档复核**，不要直接当权威清单 |
| 甲表（旧枚举 24 项）与乙表（displayName 注册表 24 项）的分工 | **仍未核实**（附录 A-3.1 已记）。本次 JSON 用的是**主进程的 24 家 registry 对象**，与那两份都不完全相同 |
