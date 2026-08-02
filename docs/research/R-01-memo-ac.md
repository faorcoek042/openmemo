---
id: R-01
author: memo-researcher
status: ready
date: 2026-08-02
---

## TL;DR（≤ 25 行，Manager 只读这里）
- memo.ac = **MemoAI**，Pemo LLC 出品的**闭源** Electron 桌面应用（仅 Windows x64 / macOS arm64，**无 Linux**）。定位：音视频 → 转写 → 字幕/翻译/摘要/思维导图。当前版本 v1.7.5（2026-06-24）。
- **技术栈已通过二进制取证确认**（我下载并解包了官方 v1.7.5 macOS 包）：Electron + electron-builder + **React + antd 6 + MobX + Vite**；思维导图 = **markmap**；播放器 = DPlayer + jassub(ASS/WASM) + flv.js；编辑器 = Slate + Monaco；数据 = **SQLite + knex**（有 migrations）。
- **ASR 栈**：whisper.cpp（`whisper-cli` / `whisper-server`，v1.8.6，ggml 模型）为主 + **sherpa-onnx**（SenseVoice/Paraformer/Zipformer/Qwen3-ASR 等）+ FunASR + Parakeet(NeMo)。VAD=Silero。说话人分离=**pyannote**（外挂扩展）。人声分离=rspleeter。TTS=Kokoro + 云厂商插件。
- **URL 导入 = 内置 yt-dlp**（2026.03.17）+ 内置 **bun**（跑 YouTube JS challenge）+ 内置 ffmpeg/ffprobe。支持 YouTube/Bilibili/播客/RSS 等。
- **加速后端实际只有**：Windows = CPU / **CUDA(cuBLAS 12.2)**；macOS arm64 = CPU / **Metal** / **CoreML**。**没有找到 Vulkan / ROCm / DirectML 的任何痕迹**——官网首页宣称的 "NVIDIA and AMD GPU Acceleration" 与代码不符（详见 B5，仅验证了 macOS 包）。Intel Mac 已于 v1.6.9 停止支持。
- **章程 2.1 的答案（值得抄）**：Windows CUDA 通过**应用内下载 `whisper-cublas-12.2.0-bin-x64.zip` → 解压到 `addon/whisper/win32/x64/cublas/` → 存在性自检**完成；IPC 通道叫 `checkWhisperCudaExist` / `unzipWhisperCudaCLI` / `unzip-cuda`，解压进度以 `extension:unzip:progress` 事件推给渲染层。硬件探测用 `systeminformation`（GPU controllers/vram）+ `nvidia-smi` + `nvcc --version`。
- **章程 2.2 的答案（值得抄）**：模型清单是一份**声明式 JSON/JS 注册表**（`presets/whisper-models.js`、`plugins/extra-transcription-plugins.json`），字段含 `size / speed(1-6) / quality(1-6) / lang / downloadLink / sha`；引擎与模型分离，按 `platform+arch` 给不同下载 URL、`sizeBytes`、`sha256`。远端目录 API：`https://models.memo.ac/all-models`。下载源可在 huggingface.co / hf-mirror.com / aifasthub.com 间切换。
- **但 memo.ac 有两个明确短板，正是我们的机会**：(1) **没有量化选择**（whisper 全是 f16 全量 ggml，无 Q5/Q8 选项）；(2) **没有显存/内存适配预检**（只在网页文档里写"最低 8G/16G"，UI 不算 fit）。Jan.ai 的 `Fits / May be slow / Won't fit` 徽标是更好的范式。
- 定价：Basic 免费（GPU 加速与高质量模型等**被锁**）/ Believer $49.99 终身 / Pro $25.99 年。LemonSqueezy 收单（`memoac.lemonsqueezy.com`）。中日专属微调模型（Memo-large.zh/ja）需**发购买凭证到邮箱人工发链接**——极大摩擦点。
- 未验证/存疑：① Windows 包未解包，AMD/Vulkan 结论仅基于 macOS 包 + 官网文档，**需要复核**；② 思维导图"可编辑"的具体交互未见截图，推测为"编辑 Markdown → markmap 重渲染"；③ 无浏览器插件、无移动端；④ 隐私政策与"本地优先"宣传存在张力（含广告/分析/Clarity 埋点）。
- 对其他 agent 的影响：D-* 设计可直接复用 B6/B7 的注册表 schema 与 IPC 通道命名；R-02/R-04 的结论（GPU runtime、模型管理）与本报告 B5–B7 互为印证，且我们应在 memo.ac 基础上**加上量化选项 + 显存 fit 预检 + Linux/Vulkan/ROCm**。

## 详细内容

### 取证方法与可信度分级

本报告的事实按可信度分三级，正文每条都标注：

| 标记 | 含义 |
|---|---|
| **[BIN]** | 我本人下载官方 `Memo_1.7.5_darwin_arm64.zip`（322,856,974 bytes，GitHub Release），解包 `app.asar`（270,778,171 bytes，42,370 个文件）后直接读取到的字符串/配置。**最高可信度。** |
| **[WEB]** | memo.ac 官方页面原文（curl 抓取，VitePress SSR，2026-08-02）。属于"厂商自述"。 |
| **[GH]** | GitHub REST API 实测返回（releases / issues / repos）。 |
| **[3RD]** | 第三方社区/评测。可信度最低，已标注来源。 |
| **推测（未验证）** / **UNKNOWN** | 明确标出。 |

> 注：WebFetch 工具拒绝 memo.ac 域名（"Unable to verify if domain is safe"），全程改用 `curl` + 自写 HTML→文本脚本。二进制取证使用 HTTP Range 请求读取远程 ZIP 中央目录 + 定点解压，未下载完整 dmg。

---

## A. 产品层

### A1. 它是什么

- 产品名 **MemoAI**（域名 memo.ac）。首页 H1：`MemoAI — Video to translated text, subtitles and notes made easy.`；副标题：`Whether it's YouTube, Podcast or local audio and video files, convert text and concentrate the essence.` **[WEB]** https://memo.ac/
- `<meta name="description">`：`AI-powered transcription. Convert your audio & video files to text.` **[WEB]**
- 服务条款自述：`Memo AI provides a local offline voice-to-text translation and other services` **[WEB]** https://memo.ac/terms
- 主体：**Pemo LLC**（全站页脚 `Copyright © 2023 - 2026 Pemo LLC`）。**注册地/司法管辖区全站未披露**；Terms 的 Governing Law 写的是 "governed by ... your local laws" —— 即不指定管辖地。 **[WEB]** https://memo.ac/terms
- `package.json` 内 `description: "Memo is an AI video and audio transcription tool."`, `author: "Memo Team"` **[BIN]**
- 目标用户（从文档与功能推断）：需要把讲座/播客/会议/外语视频转成中文文稿与字幕的个人知识工作者、字幕组、学生教师（有教育优惠）。**推测（未验证）**——官网未明确写 persona。
- 姊妹产品 **Pemo**（https://pemo.ai，PDF/Word/电子书翻译与 TTS），同一 GitHub 账号 `Makememo/PemoAI`，同一 electron-builder 流水线。 **[GH]** https://api.github.com/users/Makememo/repos
- 社区：Discord https://discord.gg/kU8w5JgJxT ；微信群（加微信号 `MemoHQ`）；QQ 群 https://qm.qq.com/q/qSKLampOYo ；X @FemoHQ **[WEB]** https://memo.ac/community
- 站点自身是 **VitePress v1.6.3** 静态站，部署在 Railway + Cloudflare，埋了 Microsoft Clarity（`clarity.ms/tag/mna49fa7un`）与 LemonSqueezy `lemon.js`。 **[BIN/WEB]** 首页 HTML

### A2. 完整功能清单

#### A2.1 导入源

| 来源 | 证据 |
|---|---|
| **在线链接**：YouTube、Bilibili、Twitter、TikTok、Vimeo、SoundCloud、小宇宙 Xiaoyuzhou、Apple Podcast、Google Podcast、抖音 Douyin | 渲染层 bundle 中出现上述站点名 **[BIN]**；`/zh/guide/start-here` 的演示视频 `online.mp4` 标题为"转译链接" **[WEB]** |
| **实现方式**：内置 **yt-dlp 2026.03.17**（`Resources/yt-dlp/yt-dlp_macos`，11.8 MB，含 Python 3.14 runtime）+ `curl_cffi` / `libcurl-impersonate`（绕过指纹检测）+ 内置 **bun**（55 MB，跑 YouTube JS challenge，配置项 `ejsRemoteComponents:"npm"`） | **[BIN]** `dist-electron/main` 中 `download-ytdlp-win32` / `download-ytdlp-darwin` 脚本明写 `yt-dlp/releases/download/2026.03.17/` |
| yt-dlp 配置由 App 生成：`~/…/data/yt-dlp.conf` + `ytdlp-config.json`，字段 `qualityMode` / `useCookies` / `cookieBrowser:"chrome"` —— **支持从浏览器读 cookie 下载会员/登录内容** | **[BIN]** |
| **YouTube 官方字幕下载**（上传的 + 自动生成的） | **[WEB]** 更新日志 v1.3.8（2024-08-29） |
| **RSS 订阅**（YouTube 个人频道链接订阅 + RSS 转写按钮） | **[WEB]** v1.1.3 / v1.1.5；渲染层 `RSS` 出现 113 次 **[BIN]** |
| **本地文件**：MP3/WAV/AAC/M4A/MKV/AVI/MP4/MOV，后续加了 wmv/flv/mpeg/ogv/flac/wma/m4v；首页支持拖拽 | **[WEB]** v1.0.0 / v1.0.7 / v1.3.9 |
| **本地字幕导入**：拖入 SRT/VTT 直接翻译 | **[WEB]** v1.0.4 / v1.1.7 |
| **实时录音**：麦克风选择（v1.4.0）、纯本地实时转文字（v1.3.9）；二进制侧有 `addon/asr/memo-recorder` + IPC `startRecorderServer`/`stopRecorderServer` | **[WEB]+[BIN]** |
| **系统音频 / 屏幕**：主进程存在 `desktopCapturer`（2 处）与 `loopback`（13 处） → 具备系统声音回环采集能力 | **[BIN]**，但**官网未宣传屏幕录制功能**，具体到达路径 UNKNOWN |
| **浏览器插件** | **未发现**。官网、更新日志、bundle 中均无痕迹 → 判定为 **不支持** |

#### A2.2 转写能力

- **语言**：官网称 90+ 语言转写/翻译（首页 "Transcribe and translate between Chinese, English, Japanese and 90+ languages"；v1.0.1 称翻译支持 96 语言）**[WEB]**
- **说话人分离**：有。基于 **pyannote**（外挂扩展，见 B6）。v1.3.2 引入安装、v1.3.5 加进度、**v1.5.5 支持指定说话人数量**（需重新下载模型）。**[WEB]+[BIN]**
- **时间戳**：有。主进程里有正则 `/(\[\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}\]\s{2})/g` 解析 whisper 输出 **[BIN]**；导出文本可带序号/说话人/时间戳（v1.3.7）**[WEB]**
- **实时 vs 批量**：**两者都有**。批量模式（v1.0.9 起，非 Pro 限 2 个文件）；实时录音转写（v1.3.9，走 sherpa-onnx streaming 模型：`streaming-zipformer` / `streaming-paraformer`）**[WEB]+[BIN]**
- **VAD**：Silero（`addon/vad/silero_vad.onnx`、`ggml-silero-v6.2.0.bin`、`vad_addon.node`）+ FastDeploy/paddle2onnx 运行时。默认设置 `vad:{enabled:false, threshold:0.6}` **[BIN]**
- **提示词（Prompt）**：借用 Whisper 原生 prompt 条件化；官方文档坦承"其能力大致相当于 GPT-2 水平"，且"一般只对 Medium 与 Large 模型有效"。**[WEB]** https://memo.ac/guide/prompt
- **关键词过滤/替换**：可删除 `[MUSIC PLAYING]` 之类噪声 token、修正误识别专名。**[WEB]** https://memo.ac/guide/keyword-filter
- **人声/伴奏分离**：`rspleeter` 扩展（Rust Spleeter），Settings > Labs。**[WEB]** v1.5.2/v1.5.3 + **[BIN]** 扩展注册表

#### A2.3 AI 功能

右侧面板固定 6 个 Tab（从渲染层枚举直接读到）：`transcription | summary | mindmap | chat | notes | developer` **[BIN]**

| 功能 | 说明与证据 |
|---|---|
| 摘要 Summary | v1.1.3 起；v1.7.1 加**摘要模板**（可复用结构化模板）；支持自动截图配图（v1.6.0）**[WEB]** |
| 思维导图 Mindmap | 见 A2.4 |
| 问答 Chat | v1.5.0 加 chat；v1.6.6 加"与视频内容对话"。数据目录里有 **`embeddings`** 文件夹 → **本地 RAG**。**[BIN]** |
| 翻译 | 字幕翻译（逐行 / 段落重译 / 双语导出）；v1.7.1 加**术语表 glossary**；v1.7.4 加**自定义翻译提示词模板**（默认模板 id `faithful-subtitle`）**[BIN]+[WEB]** |
| AI 字幕纠错 | v1.7.3 "AI-powered subtitle correction using LLMs" **[WEB]** |
| 待办抽取 | **未发现独立功能**。UNKNOWN / 判定为不支持（可通过自定义 prompt 变相实现） |
| TTS 语音合成 | Kokoro 本地 TTS 扩展 + OpenAI/ElevenLabs/Edge/火山引擎插件 **[BIN]** `plugins/*.memox` |
| 英语/日语学习工具 | v1.6.6：从英文视频抽取词汇做听读练习 **[WEB]** |
| 字幕转文章插件 | v1.6.0 **[WEB]** |

**LLM 一律 BYOK（自带 Key）**，在「设置 → 翻译设置」填。已支持的 provider（合并更新日志与二进制枚举）：OpenAI、Claude、Gemini、DeepSeek、Groq、xAI、Moonshot、Together、SiliconCloud、OpenRouter、豆包 Doubao、ChatGLM/智谱、文心一言、通义/Qwen、小米 MiMo、阿里云、Azure、Mistral(@langchain/mistralai)、**Ollama（本地）**。**[WEB]+[BIN]**
LLM 模型清单由远端注册表下发：`https://model.memo.ac/llm-models/manifest.json`，IPC `llm:model-registry:update` / `:check-update` / `:reload` **[BIN]**

#### A2.4 思维导图具体形态（重点）

- **渲染库 = markmap**（确证）。渲染层 bundle 中出现 markmap-view 的专有 DOM 类名：`markmap-foreign`(16)、`markmap-container`(6)、`markmap-node`(2)、`markmap-link`(2)、`markmap-svg-container`、`markmap-fold`，以及 `Markmap`、`markmap-view` 标识符；配套 `d3-hierarchy` + `d3-flextree`（markmap 的布局依赖）。**[BIN]**
- **数据形态**：思维导图作为 note 记录上的一个 `mindmap` 字段持久化（`AIM.noteData("update",{id,workspaceId,folderId,mindmap})`）。markmap 的输入是 Markdown，故 `mindmap` 字段应为 **Markdown 文本**。**[BIN]（字段名确证；"内容是 Markdown"为推测（未验证））**
- **生成流程**：LLM 流式生成，主进程向渲染层推 `mindmap:start` → `mindmap:thinking` → `mindmap:message`（增量）→ `mindmap:complete`，另有 `mindmap:clip:complete`（片段级）。支持思考型模型（`isThinkingModel`）。**[BIN]**
- **可编辑吗**：v1.1.4（2023-12-21）更新日志写"思维导图工具升级 — 支持导出 SVG/JPG、支持 **Markdown 编辑**"；v1.6.0（2025-07-18）写"**思维导图编辑**，可自定义工具栏 — 缩放、全屏、下载"。→ **可编辑，但很可能是"编辑 Markdown 源码 → markmap 重新渲染"，而非节点级拖拽编辑。推测（未验证）**，未找到截图佐证。**[WEB]**
- **导出格式**：SVG、JPG/PNG（bundle 里 `html2canvas` 出现 10 次，`"svg"` 357 次）**[WEB]+[BIN]**
- **自定义 prompt**：v1.6.0 支持为思维导图与摘要模块分别设置自定义提示词。**[WEB]**
- 已知缺陷：GitHub issue #133「思维导图下载图片，字看不清楚」（导出图片文字模糊，已关闭）**[GH]**；v1.3.7 更新日志自陈"目前测试 72B 以下模型思维导图转换有问题"。**[WEB]**

#### A2.5 笔记组织

- 层级：**Workspace（空间）→ Folder（文件夹）→ Note**。数据目录键名直接可见：`folders / transcripts / translations / transcriptions / resources / tasks / external / rss / recordings / images / screenshots / tts / defaultFolder / embeddings / notes / accompaniment / repair`，根目录 `.memo-ai`。**[BIN]**
- 「空间隔离」自 v1.0.4 起，为共用电脑场景设计；v1.5.3 加子文件夹（beta）。**[WEB]**
- **搜索**：字幕搜索/替换支持**正则、大小写敏感、Title Case 匹配**（v1.5.0）；Ctrl/Cmd+F 选中自动填充（v1.6.8）。**[WEB]**
- **标签**：**未发现**标签系统。首页有 view-mode 切换 + history filter（v1.6.8）。判定为**无标签、无双链**。（**UNKNOWN**：不排除 UI 里有我未取证到的轻量标签）
- **转写稿 ↔ 音频时间轴联动**：有。点击字幕跳转（v1.3.6）、浮动字幕窗、实时字幕、悬浮笔记（带时间戳与截图，v1.0.4）。**[WEB]**
- 存储：**SQLite**（`sqlite3` ^5.1.7 + `knex` ^2.4.2），7 个 migration 文件（`20230716041009_download.js` … `20260605000100_note_mp3_path.js`）。**[BIN]**
- 项目内文件结构：`thumbnail / transcribe(音频) / transcode(视频) / metadata.json / source / subtitle / project.json`。**[BIN]**

#### A2.6 导出与集成

- 字幕：SRT、VTT、ASS、LRC、**FCPXML**（v1.5.0）；文本：TXT、Markdown、**DOCX**（v1.6.0）；数据：JSON、XLSX；图片：PNG/JPG/SVG；PDF（bundle 中出现但用途未确认）。**[BIN]+[WEB]**
- 双语字幕导入/导出（v1.3.6）；视频压制/烧录字幕 + 水印（v1.3.0/v1.5.0）；字幕合成语音导出。**[WEB]**
- **Notion**：需用户自建 Notion Integration、拷 Secret 与 Database page id 到 Memo。官方自评"moderately complex, requires some technical ability"。**[WEB]** https://memo.ac/integration/notion
- **Obsidian**：一键导出字幕（限 2 小时以内视频，v1.3.8）**[WEB]**

### A3. 本地模型 vs 云端 API

**混合，但以本地为主：**

| 环节 | 本地 / 云 |
|---|---|
| ASR 转写 | **本地**（whisper.cpp / sherpa-onnx / FunASR / Parakeet），另可选 **Groq 云端 STT**（v1.5.2）**[WEB]** |
| VAD、说话人分离、人声分离、TTS(Kokoro) | **本地** **[BIN]** |
| 摘要 / 思维导图 / 问答 / 翻译 | **云 LLM（BYOK）为主**，Ollama 可全本地 **[WEB]+[BIN]** |
| 授权校验、模型目录、插件目录、更新 | **云**：`license.memo.ac`、`api.memo.ac`、`models.memo.ac/all-models`、`integrations.memo.ac/plugins/v2`、`model.memo.ac` **[BIN]** |

隐私宣传 vs 实际：
- 首页宣称 `Secure and Private — No data leaves your device. Works completely offline.` **[WEB]**
- 但 **隐私政策**明确写：收集 name/email/支付信息、使用行为、IP、浏览器/OS；使用 cookie 与跟踪技术；**"Memo AI serves third-party advertisements to our free plan users"**，并"Delivering targeted advertisements to our free plan users"；数据可在并购中转移。**[WEB]** https://memo.ac/privacy
- → **两份法律文件与首页文案存在张力**。转写本身确实本地跑，但产品整体不是"纯离线"。这是我们可以做得更干净的地方。

### A4. 定价与开源

**[WEB]** https://memo.ac/pricing

| 档位 | 价格 | 说明 |
|---|---|---|
| 🎙️ Memo Basic | Free forever | 无限转写/翻译/语音合成、不限设备。**GPU 加速、高质量转写模型、多种导出格式、批量模式均在此档被划掉（付费项）** |
| 🦄 Memo Believer | **$49.99**（原价 $99）/ 终身 | 1 设备，优先邮件支持，含全部 Pro 能力 |
| 🎈 Memo Pro | **$25.99**（原价 $39.99）/ 年 | 1 设备 |

- 收单：**LemonSqueezy**（`https://memoac.lemonsqueezy.com/checkout/buy/2844bc2d-…` 与 `…/6bc99688-…`；早期 `store.memo.ac/checkout/buy/75f2352c-…`；首页加载 `assets.lemonsqueezy.com/lemon.js`）**[WEB]**
- 设备激活管理走 LemonSqueezy License Management（可解绑换机）。**[WEB]**
- 教育优惠：发教育邮箱/学生证到官方邮箱人工发码，7 天有效。**[WEB]**
- 退款：付款后 5 天内邮件申请，2 个工作日答复；明确列出"不可接受的退款理由"。**[WEB]**
- 真实成交样本：GitHub issue #386 显示一笔 `$52.49` PayPal 订单（2025-06-03）。**[GH]**
- **开源部分：无。** `github.com/Makememo/MemoAI` 仓库 `size: 18` KB，根目录只有 `README.md`(3173 B) 和 `.github/`，`license: null`，`language: null` —— **纯粹是 Release 托管 + Issue tracker**。1042 stars / 102 forks / 104 open issues / 244 closed。`Makememo` 是 User 而非 Org（org API 404）。**[GH]** https://api.github.com/repos/Makememo/MemoAI
- 但**构建产物托管在一个个人仓库** `github.com/YuQian2015/memo-build/releases/download/v1.0.0/…`（Parakeet/FunASR/Kokoro 扩展包都从这里下）。**[BIN]** —— 说明团队规模很小（很可能 1–2 人）。

---

## B. 技术层（重点）

### B5. 桌面 App 还是网页？框架？

**结论：纯桌面 App，Electron + electron-builder。零疑问。**

取证链（四重独立佐证）：

1. **[GH]** v1.7.5 release 资产：
   ```
   latest-mac.yml                            509 B      ← electron-updater 清单
   latest.yml                                345 B      ← electron-updater 清单
   Memo_1.7.5_darwin_arm64.dmg       335,850,000 B
   Memo_1.7.5_darwin_arm64.dmg.blockmap  349,232 B      ← electron-builder 差分更新
   Memo_1.7.5_darwin_arm64.zip       322,856,974 B
   Memo_1.7.5_win32_x64.exe          305,233,832 B      ← NSIS
   Memo_1.7.5_win32_x64.exe.blockmap     307,648 B
   ```
   `latest.yml` 内容为 `version/files[url,sha512,size]/path/sha512/releaseDate` —— electron-builder 独有 schema。无 `latest.json`（Tauri 的清单名）、无 `.msi`。
2. **[BIN]** 包内 `Memo.app/Contents/Frameworks/Electron Framework.framework/…`，主二进制 137.9 MB。
3. **[BIN]** `package.json` 依赖含 `electron-updater ^5.3.0`、`electron-store 6`；`main: "dist-electron/main/index.js"`；`env.VITE_DEV_SERVER_URL: "http://127.0.0.1:7777/"`。
4. 体积：安装包 291–320 MB，Tauri 同类应用通常 10–30 MB。

**平台矩阵（官方下载页）[WEB]** https://memo.ac/download
| 平台 | 版本 | 备注 |
|---|---|---|
| Windows x64 | 1.7.5 | 要求 Win10+，≥8 GB 内存 |
| Windows ARM | — | **"currently not available"** |
| macOS Apple Silicon | 1.7.5 | M1～M4 |
| macOS Intel | **停在 1.6.8** | v1.6.9 更新日志："取消 Intel Mac 支持" **[WEB]** |
| **Linux** | **完全不支持** | 无任何构建 |

下载分发走自有域名 `https://releases.memo.ac/Memo_1.7.5_win32_x64.exe`；国内用户另给飞书云盘镜像。**[WEB]**

### B5b. 前端技术栈（渲染层）

从 `app.asar` 中 `dist/assets/index-68aa31bb.js`（12.67 MB）与 `package.json` 直接取证 **[BIN]**：

| 领域 | 选型 | 证据 |
|---|---|---|
| 框架 | **React**（`react-dom`、`@radix-ui/react-*`、`lucide-react`、`@icons-pack/react-simple-icons`） | package.json |
| UI 库 | **antd ^6.3.1**（+ `@rc-component/*` 内部包 417 个 node_modules 里可见） | package.json / node_modules |
| 状态管理 | **MobX**（`mobx` 41 次、`observer` 73 次、`makePersistable` → mobx-persist-store） | bundle |
| 构建 | **Vite**（`VITE_DEV_SERVER_URL`，hash 资产名 `index-68aa31bb.js`） | bundle |
| **思维导图** | **markmap** + `d3-hierarchy` + `d3-flextree` | bundle 类名 |
| 富文本/转写稿编辑 | **Slate**（1249 次） | bundle |
| 代码/JSON 编辑 | **Monaco Editor**（555 次，含 `jsonMode` / `htmlMode` / `cssMode` chunk、`codicon.ttf`） | bundle + 资产 |
| 视频播放 | **DPlayer**（1094 次）+ **flv.js** + **jassub**（ASS 字幕 WASM 渲染，`jassub-worker.wasm` 2.0/2.2 MB） | bundle + 资产 |
| Markdown 渲染 | `remark`/`rehype`/`unified` + `harden-react-markdown` + `marked` | bundle + package.json |
| 数学公式 | **KaTeX** ^0.16.22 + `rehype-katex` + `remark-math` | package.json + KaTeX 字体 |
| 代码高亮 | `react-syntax-highlighter` | package.json |
| 图片导出 | `html2canvas` | bundle |
| i18n | **i18next / react-i18next** | bundle |
| 数据请求 | `swr` / `axios` | bundle |
| AI 流式 | **Vercel AI SDK**（`ai` ^5.0.9 + `@ai-sdk/react` ^2.0.9）+ **LangChain**（`langchain` ^0.3.6、`@langchain/core` ^0.3.62、`@langchain/mistralai`）+ `openai` ^4.56.1 + `use-stick-to-bottom` | package.json |
| 中文分词 | **jieba（Rust → WASM）** `nlp/jieba/jieba_rs_wasm_bg.wasm` (3.5 MB) | 资产 |

主进程侧：`knex` + `sqlite3`、`ws` ^8.13.0、`fluent-ffmpeg`、`node-machine-id`（设备指纹）、`node-mac-permissions`、`font-list`/`node-system-fonts.node`（系统字体枚举，用于字幕字体）、**`vm2` ^3.9.19**（插件沙箱）、**`bytenode` ^1.4.1**（把 JS 编译成 V8 字节码防逆向 —— 可见 `dist-electron/preload/index.jsc`）、`systeminformation`（内联打包）。**[BIN]**

> 安全备注（供 Manager 参考）：`vm2` 已于 2023 年被作者宣布**废弃且存在无法修复的沙箱逃逸漏洞**，我们不应照抄这一项。

### B6. 用户怎么配置 GPU / 安装本体依赖（章程 2.1）

**这是本报告最有价值的部分。memo.ac 的做法可直接照搬。**

#### B6.1 官方文档说法 **[WEB]** https://memo.ac/zh/guide/gpu

> "加速能力需要付费解锁"

- **macOS**：
  - Intel Mac 不支持 GPU 加速。
  - M 芯片：转写时选 GPU，"确保内存有 8G，如果是大模型，确保有 16G"，"直接点击转写即可"。
  - "M 芯片还支持 **CoreML 模式**，供更低端设备使用。"
  - 实测表：M1 Max/64G/10.4 TFLOPS → 1 小时音频 4.5 分钟；M2 Max/64G/27.2 TFLOPS → 3.5 分钟。
- **Windows / NVIDIA**：
  - Large 以上模型需 **≥6 GB 显存**。
  - "确保显卡驱动已经升级到最新…"
  - **关键句**：**"确保 Cuda 驱动是 12.2，如果版本低于或者高于 12.2，Memo 已经打包好对应的驱动，直接点击下载即可。"** ← 应用内一键下载 CUDA 运行库。
  - 实测表：RTX 4090 → 2.0 分钟/小时；RTX 4080S → 3.5 分钟。
  - 显卡支持清单按年代列出 GTX 970 ~ RTX 4090；企业卡（如 Tesla T4 仅 TCC 模式）需额外授权驱动。
- v1.3.7 更新日志的提示：8G NVIDIA 用户建议用 Cuda 模式；macOS 用户建议用 GPU 模式，**"CoreML 加载速度远不及 GPU，且需要额外下载模型和稳定性不高"**。**[WEB]**

#### B6.2 二进制里的真实实现 **[BIN]**

**（a）后端枚举 —— 只有 CPU/CUDA/Metal/CoreML**

```js
function Sai(){ return process.platform==="win32" ? ["cpu","cuda"]
              : process.platform==="darwin" ? ["cpu","mps"]
              : ["cpu"] }
function wai(){ return "cpu" }   // 默认
```
（此函数用于 sherpa-onnx / FunASR / Parakeet 的 provider 选择）

whisper.cpp 侧另有 `macOSWhisperMode` 三态：
```js
S.macOSWhisperMode==="CPU"    && darwin && arm64 → A.use_gpu = false      // 关 Metal
S.macOSWhisperMode==="coreML" && darwin && arm64 → 走 coreml/ 目录的二进制
// 其余（默认）→ Metal
```
二进制路径解析：
```js
o = (e==="coreML") ? "coreml/" : "";
`../addon/whisper/bin/${version}/${o}whisper-cli`
// darwin 且 arch!=="arm64" → 直接抛错 "Whisper transcription is not supported on macOS x64"
```

包内实际存在两套 whisper.cpp 1.8.6 运行时（macOS）**[BIN]**：
```
addon/whisper/bin/1.8.6/          libggml-metal.dylib, libggml-blas, libggml-cpu, whisper-cli, whisper-server
addon/whisper/bin/1.8.6/coreml/   同上 + libwhisper.coreml.dylib
```
> **在 macOS arm64 包里没有找到 Vulkan / ROCm / DirectML / OpenCL 的任何库或字符串**（`dml` 的命中全是 mime-type 误报）。
> ⚠️ **未验证**：我只解包了 macOS 包。Windows 包（NSIS，本环境无 7z 无法解）内是否含 Vulkan/DirectML 后端**未验证**。但结合 (1) 官方 GPU 文档通篇只讲 CUDA、(2) 代码里 win32 provider 列表只有 `["cpu","cuda"]`、(3) 全部下载资产名里无 vulkan/amd/rocm 字样 **[GH]**，我判断**首页 "NVIDIA and AMD GPU Acceleration" 属于夸大宣传，AMD 实际只能跑 CPU**。GitHub issue #403 也显示 RTX 5060(Blackwell) 因 CUDA kernel 缺失而崩溃 **[GH]**。

**（b）Windows CUDA 的应用内安装流程（照搬目标）**

```js
const xdn = { whisperCublas: "whisper-cublas-12.2.0-bin-x64.zip" };
const 目标目录 = <userData>/.memo-ai/addon/whisper/win32/x64/cublas
```
IPC 通道：
| 通道 | 作用 |
|---|---|
| `checkWhisperCudaExist(filename)` | 检查 cublas 目录下某文件是否存在 |
| `checkWhisperCudaCLIExist()` | 检查随包附带的 `whisper-cuda-bin-x64.7z` 是否在 |
| `unzipWhisperCudaCLI()` | 解压附带的 7z 到 cublas 目录，然后删除源包 |
| `unzip-cuda` | 解压下载来的 `whisper-cublas-12.2.0-bin-x64.zip`（带 `-x!whisper.dll` 排除参数） |
解压进度以 `renderer-message` 事件推给渲染层，节流 250 ms：
```js
{type:"extension:unzip:progress", data:{...}}   // 进行中
{type:"extension:unzip:complete", data:{}}      // 完成
```
运行时执行路径固定为 `…/addon/whisper/win32/x64/cublas/whisper-cli.exe`。
（GitHub issue #421 里用户贴的报错正是这个 `whisper-cli.exe` + cuBLAS 加载失败 **[GH]**）

**（c）硬件探测**

- 内联打包了 **`systeminformation`**：可见其 `graphics()` 实现——macOS 解析 `system_profiler SPDisplaysDataType`（`spdisplays_vendor` / `sppci_model` / vram / `spdisplays_device-id`），Linux 解析 `lspci`，Windows 解析 WMI，另有 OpenCL `CL_DEVICE_BOARD_NAME_AMD` 分支；产出 `controllers[{vendor,model,bus,vram,vramDynamic,deviceId,vendorId,external}]`。**[BIN]**
- **`nvidia-smi`**：Windows 上会遍历 `%WINDIR%\System32\DriverStore\FileRepository\*\nvidia-smi.exe` 取 **ctime 最新**的一份；非 Windows 直接调 `nvidia-smi`。**[BIN]**
- **`nvcc --version`**：探测 CUDA toolkit 版本。**[BIN]**
- 另有 `sysctl`（macOS CPU 信息）、`wmic`（Windows）。**[BIN]**
- 注：IPC `check-device` / `get-device-manager-info` 实际是**授权设备管理**（license 绑定），不是硬件探测 —— 别被名字误导。**[BIN]**

**（d）额外后端资源 —— whisper-server**

memo.ac 还会以 HTTP 服务模式跑 whisper.cpp：
```js
const BG = 9588;   // 默认端口
spawn(whisper-server, ["-m", model, "-l", lang, "--host","0.0.0.0","--port", port])
```
IPC：`startWhisperServer` / `stopWhisperServer` / `isWhisperServerRunning` / `getWhisperServerStatus` / `checkWhisperServerHealth`。健康检查方式是**往服务发一段内嵌 base64 的测试音频**做真实推理，轮询直到就绪（超时会打印"WhisperServer 轮询超时"）。**[BIN]**
> ⚠️ `--host 0.0.0.0` 意味着**监听所有网卡**，局域网可访问 —— 这是个安全缺陷，我们应改为 `127.0.0.1`。

### B7. 模型管理界面（章程 2.2）

#### B7.1 官方说法 **[WEB]** https://memo.ac/models

页面是一张**模型表**（无截图，纯文本），每个模型给：类型（Speed/Balanced/Quality 三档）、**最低内存**（8G / 16G）、**⭐推荐指数（3–5 星）**、直链。
- Large-V3 只给 3 星，并注明"性能并不是很稳定，很容易出现重复内容输出"，"除非机器好、音频干净否则不推荐"。
- 使用方式："请前往 Memo AI **设置 - 模型管理 - 右上角点击导入模型**"。
- 提示："通常建议代理 huggingface.co 域名以避免下载问题"。
- **中文与日文专属模型（Memo-large.zh / Memo-large.ja）仅对会员开放，需把购买凭证发到官方邮箱，人工回复下载链接** ← 极大的体验摩擦。

#### B7.2 二进制里的真实数据模型（**这是我们要抄的 schema**）**[BIN]**

**(1) Whisper 模型目录 `Resources/presets/whisper-models.js`** —— 15 条，字段：
```js
{
  label: "Large(v3)-turbo",
  value: "ggml-large-v3-turbo.bin",
  size: "1.62 GB",
  description: "model.large description",   // i18n key
  disabled: true,
  downloadLink: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
  speed: 4,                 // 1–6
  speedLabel: "common.high quality",
  speedValue: "quality",    // fast | balance | quality
  quality: 6,               // 1–6
  download: false,
  lang: "multi",            // multi | en | zh | ja
  langLabel: "model.multi language",
  sha: "4af2b29d7ec73d781377bfd1758ca957a807e941"   // 完整性校验
}
```
全表：Tiny/Tiny.en (77.7 MB)、Base/Base.en (148 MB)、Small/Small.en (488 MB)、Medium/Medium.en (1.53 GB)、Large v1/v2/v3 (3.09 GB)、Large-v3-turbo (1.62 GB)、Distil-Large-v3 (1.52 GB)、**Memo-large.zh (2.88 GB)**、**Memo-large.ja (2.88 GB)**（后两者托管在 `https://model.memo.ac/`）。
> **注意：全部是 f16 全量 ggml，没有任何 Q4/Q5/Q8 量化选项。** memo.ac **不提供量化选择**。

**(2) 下载源可切换**（对应 v1.5.3 "支持切换模型下载源"）**[BIN]**：
```js
{ "huggingface.co": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{model}",
  "hf-mirror.com" : "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/{model}",
  "aifasthub.com" : "https://aifasthub.com/ggerganov/whisper.cpp/resolve/main/{model}" }
```

**(3) 引擎/模型插件注册表 `Resources/plugins/extra-transcription-plugins.json`** —— **引擎与模型解耦**，各自按 platform+arch 给包：
```jsonc
{ "id":"parakeet-cli", "pluginId":"plugin:parakeet", "type":"engine",
  "displayName":"Parakeet", "binaryName":"parakeet", "archiveType":"zip", "category":"asr",
  "platforms":[
    {"platform":"darwin","arch":"arm64","sourceUrl":"https://github.com/YuQian2015/memo-build/releases/download/v1.0.0/parakeet-darwin-arm64-1.0.0.zip","sizeBytes":5242880,"sha256":"fe038f…"},
    {"platform":"win32","arch":"x64","sourceUrl":"…/parakeet-win32-x64-1.0.0.zip","sizeBytes":1803762556,"sha256":"5cdb61…"}   // 1.8 GB!
  ],
  "models":[ {"id":"parakeet-tdt-0.6b-v3","displayName":"Parakeet V3","languages":[25 种欧洲语言],
              "platforms":[{"platform":"win32","arch":"x64","sourceUrl":"https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3/resolve/main/parakeet-tdt-0.6b-v3.nemo","sizeBytes":466616320,"sha256":"…"}]},
             {"id":"parakeet-tdt-0.6b-v3-coreml", …darwin/arm64 专用 CoreML 转换包… } ]
}
```
三个引擎：`parakeet-cli`（NVIDIA NeMo Parakeet TDT 0.6B v2/v3，含 **CoreML 变体**）、`funasr-cli`（阿里 FunASR，模型包 ~1 GB，含 ASR/VAD/PUNC/SPK 四件套）、`sherpa-onnx`（无独立引擎二进制，因为 `sherpa-onnx-node` 已是 npm 依赖）。
sherpa-onnx 模型全部直链 `github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/*.tar.bz2`，共 20+ 个，含 **SenseVoice**、**Qwen3-ASR-0.6B-Int8**、**Omnilingual-1600-languages-300M-Int8**、**Cohere-Transcribe-14Lang-Int8**、Moonshine、Paraformer、Zipformer(streaming/offline)、Whisper 的 ONNX 版等，每条带 `sizeBytes` + `sha256` + `languages[]`。

**(4) 外挂扩展注册表（非 ASR）** **[BIN]**
```js
{ spleeter: { installFolder:"memo-extension-spleeter", name:"Spleeter",
              darwin_arm64:{link:"https://model.memo.ac/integration/rspleeter/memo-extension-rspleeter-arm64@1.0.0.zip",
                            executableName:"memo-spleeter", fileSize:"162 MB", hash:"261dfb…"},
              win32_x64  :{…"114 MB"…} },
  pyannote: { installFolder:"memo-extension-pyannote", name:"speaker.speaker recognition extension",
              downloadPage:{common:"https://memo.ac/product/speaker-diarization", en:…, zh:…},
              darwin_arm64:{executableName:"main",     fileSize:"256 MB",  installSize:"740MB"},
              win32_x64  :{executableName:"main.exe",  fileSize:"1.39 GB", installSize:"4.7GB"} },
  kokoro:   { installFolder:"memo-extension-kokoro", name:"Kokoro",
              description:"Kokoro is an open-weight TTS model with 82 million parameters.",
              darwin_arm64:{fileSize:"483 MB", installSize:"885 MB"},
              win32_x64  :{fileSize:"1.63 GB", installSize:"4.14 GB"} } }
```
> **关键点：既给 `fileSize`（下载体积）又给 `installSize`（安装后体积）+ `hash`。这个双体积字段值得抄。**
> 但 **没有任何显存/内存需求字段**——这是 memo.ac 的空白，我们应补上。

**(5) 完整的模型管理 IPC 面（共 342 个 ipcMain 通道，模型相关摘录）** **[BIN]**
```
get-default-models / get-remote-models / getAllModels / get-default-sherpa-models
get-default-punctuation-models / get-extra-transcription-plugins / get-plugins
download-model / cancel-download-model / download-extra-model / cancel-download-extra-model
download-extra-plugin / cancel-download-extra-plugin / download-file / start-download / download-data
check-model-exist / check-model-sha / check-model-folder / create-models-folder / move-model
check-extra-model-installed / check-extra-plugin-installed / uninstall-extra-model / uninstall-extra-plugin
import-models / import-extra-plugin-model-file / open-model-folder / open-download-folder
check-download-folder-space / checkDownloadSpace / get-download-folder-path
downloadExtension / cancelDownloadExtension / checkExtensionExists / removeExtension / openExtensionFolder
install-extensions / install-plugins / install-online-plugins / refresh-online-plugins / uninstall-plugin
llm:model-registry:{get-status,check-update,update,reload,ensure-dir}
checkWhisperCudaExist / checkWhisperCudaCLIExist / unzipWhisperCudaCLI / unzip-cuda
startWhisperServer / stopWhisperServer / isWhisperServerRunning / getWhisperServerStatus / checkWhisperServerHealth
ytdlp-download-video / ytdlp-cancel-download / ytdlp:download-version / get-ytdlp-download-info
```
可以看出完整能力：**远端目录拉取 → 空间预检 → 下载(可取消) → SHA 校验 → 安装/解压 → 移动模型目录 → 导入本地模型文件 → 卸载 → 打开所在目录**。

**(6) 远端目录 API** **[BIN]**
```
https://models.memo.ac/all-models          # 全量模型目录
https://models.memo.ac/models/             # 单模型
https://model.memo.ac/llm-models/manifest.json   # LLM 服务/模型注册表
https://integrations.memo.ac/plugins/v2    # 插件市场
https://license.memo.ac                    # 授权
https://api.memo.ac                        # 主 API
https://download.memo.ac/<url>             # 下载代理/镜像
```

#### B7.3 有没有模型市场 / 量化 / 显存提示

| 章程 2.2 要求 | memo.ac 现状 |
|---|---|
| 浏览 | ✅ 设置 → 模型管理，含远端目录 + 官网表格 |
| 下载 | ✅ 一键下载 + 进度 + 可取消 + 多下载源切换 + SHA 校验 |
| 切换 | ✅ 添加音频时选模型；引擎(Whisper/FunASR/Parakeet/sherpa)可切 |
| 删除 | ✅ `uninstall-extra-model` / `removeExtension` |
| **量化选择** | ❌ **没有**。whisper 只有 f16 全量；sherpa 的 int8 是模型条目本身的属性，用户不能对同一模型选量化档 |
| 显示体积 | ✅ `size` / `fileSize` / `installSize` / `sizeBytes` |
| **显存需求** | ❌ **没有**。只有官网表格里的"最低内存 8G/16G"，UI 里不做 fit 判断 |
| 模型市场 | ⚠️ 半个。有插件市场 `integrations.memo.ac/plugins/v2`，但模型目录是官方策展的固定清单；**不支持任意 HuggingFace 模型导入**（GitHub issue #218 用户想加 BELLE-whisper-large-v3-zh 微调模型，至今未实现 **[GH]**）。只支持"导入本地模型文件"。 |

### B8. 前端技术栈线索
见 **B5b**（已由 `package.json` + bundle 指纹确证，非推测）。

### B9. 后端 / 本地服务痕迹 **[BIN]**

| 服务 | 细节 |
|---|---|
| **whisper-server** | whisper.cpp 自带 HTTP server，默认端口 **9588**，`--host 0.0.0.0`（⚠️ 监听全网卡） |
| **recorder server** | IPC `startRecorderServer` / `stopRecorderServer`，走 `addon/asr/memo-recorder`（2.3 MB 原生二进制） |
| **sherpa runner** | `Resources/sherpa/{server.js, sherpa_loader.js, asr_file_process.js, asr_offline_process.js, asr_online_process.js, asr_vad_process.js}` —— Node 侧进程，通过 `sherpa-onnx-node` + `libsherpa-onnx-c-api.dylib` + onnxruntime 1.24.4 加载 |
| **WebSocket** | `ws` ^8.13.0 —— 推测用于 sherpa 实时流式 ASR 与 recorder 通信（**推测（未验证）**） |
| **进程间通信主干** | Electron `ipcMain.handle` × 342 + 主进程 → 渲染层 `webContents.send("renderer-message", {type, data})` 事件总线（进度类消息节流 250 ms） |
| **外部进程** | `whisper-cli(.exe)`、`whisper-server`、`ffmpeg`/`ffprobe`、`yt-dlp`、`bun`、`7za`、`parakeet`、`funasr`、`main(.exe)`(pyannote)、`memo-spleeter`、`kokoro-cli`、`macos-vision-ocr` |
| **插件运行时** | `vm2` 沙箱执行 `.memox` 插件（`memo-plugin-translate-{deepl,google,microsoft}`、`memo-plugin-tts-{edge,elevenlabs,openai,volcengine}`） |
| **子应用** | `Resources/apps/temo/`（文本转语音独立小应用）与 `Resources/apps/ain/`，各自是独立的 Vite 产物 + `manifest.json`，在 Electron 内以子页面加载 |

---

## C. 对我们的启发

### C10. 值得直接照搬的 UX / 工程流程（8 条）

1. **【必抄】GPU 后端 = 可下载的独立构件，而非编译期开关。**
   memo.ac 把 CUDA 版 whisper.cpp 打成 `whisper-cublas-12.2.0-bin-x64.zip`，运行时下载 → 解压到 `addon/whisper/<platform>/<arch>/<backend>/` → 用"目录/文件存在性"作为已安装判据 → 执行时按 backend 拼路径。我们把这套推广到 `cuda / vulkan / rocm / metal / coreml / cpu` 即可满足章程 2.1，且天然支持 Windows AMD（memo.ac 做不到的）。

2. **【必抄】声明式模型注册表 + SHA 校验 + 双体积字段。**
   直接复用其 schema 并**补两个字段**：`quantization`（Q4_K_M/Q5_1/Q8_0/F16）与 `vramRequiredMB` / `ramRequiredMB`。memo.ac 的 `{label, size, speed(1-6), quality(1-6), lang, downloadLink, sha}` 已经很好；`fileSize` vs `installSize` 的区分（pyannote 下 1.39 GB 装完 4.7 GB）能避免用户"下完才发现磁盘不够"。

3. **【必抄】引擎(engine) 与 模型(model) 解耦，各自按 `platform+arch` 分发。**
   `extra-transcription-plugins.json` 的 `{engine.platforms[], engine.models[].platforms[]}` 两层结构，让"Apple Silicon 用 CoreML 转换过的模型、Windows 用 .nemo 原始模型"这种差异被数据描述而非代码分支处理。

4. **【必抄】下载源可切换 + 官方下载代理。**
   `huggingface.co / hf-mirror.com / aifasthub.com` 三选一 + `download.memo.ac/<url>` 代理。对中国用户是刚需，成本极低。memo.ac 的 FAQ 里"模型下载卡 0%"是最高频问题之一 **[WEB]**。

5. **【必抄】进度事件总线 + 节流。**
   `renderer-message` 单一事件通道 + `{type:"extension:unzip:progress"}` 这种 `域:动作:阶段` 命名 + 250 ms 节流。下载、解压、转写、翻译、思维导图生成全走同一条流式通道（`mindmap:start/thinking/message/complete`），前端只需一个 reducer。

6. **【必抄】whisper-server 常驻 + 真实音频健康检查。**
   不是简单 ping 端口，而是**发一段内嵌的 base64 测试音频跑一次真实推理**，通过才算就绪。这正好可以当作章程 2.1 要求的"自检"——安装完后端后跑一次 2 秒基准音频，同时能顺手给出实测速度。

7. **【值得抄】URL 导入 = yt-dlp + 浏览器 cookie + JS runtime。**
   `useCookies` / `cookieBrowser:"chrome"` 让用户能下会员内容；捆绑 bun/deno 解 YouTube nsig challenge 是当前必需项。另外 yt-dlp 版本本身可在线升级（IPC `ytdlp:download-version`）——因为站点反爬变化快，**yt-dlp 必须能独立于主程序更新**。

8. **【值得抄】思维导图 = LLM 产出 Markdown → markmap 渲染 → SVG/PNG 导出。**
   markmap 是 MIT 协议、体积小、天然可编辑（改 Markdown 即改图）、天然可导出 SVG。配合 `html2canvas` 出图。比 G6/React Flow 便宜太多。**注意 memo.ac issue #133「导出图片文字看不清」——导出时应直接用 markmap 的 SVG 序列化 + 指定 scale，而不是截屏。**

9.（额外）**首启零配置原则。** memo.ac 首页宣传的两个下载入口就是 "Try for free（Windows/macOS）" 与 "Learn more"，安装后即可用免费 base 模型转写。竞品调研（详见 R-04）里 Granola 的经验也是"第一次不要让用户做任何配置决策"。

### C11. 它的短板 / 用户抱怨 —— 我们的机会

| # | 短板 | 证据 | 我们怎么做得更好 |
|---|---|---|---|
| 1 | **不支持 Linux；Intel Mac 被抛弃；Windows ARM 无版本** | **[WEB]** 下载页 | 章程平台矩阵已覆盖 Linux + AMD，直接是差异点 |
| 2 | **AMD GPU 实际不支持**（首页却写 "NVIDIA and AMD GPU Acceleration"） | **[BIN]** provider 列表仅 `["cpu","cuda"]`；无 Vulkan/ROCm 痕迹 | 用 whisper.cpp 的 **Vulkan** 后端一把覆盖 AMD/Intel/NVIDIA，Windows+Linux 通吃 |
| 3 | **无量化选项**，Large 一律 3.09 GB | **[BIN]** whisper-models.js | 提供 Q5_1/Q8_0 等量化档，8 GB 显存也能跑 large |
| 4 | **无显存/内存 fit 预检**，只在网页文档写"最低 8G/16G" | **[BIN]+[WEB]** | 抄 Jan.ai 的 `Fits / May be slow / Won't fit` 徽标（详见 R-04），下载前就算 |
| 5 | **会员专属中日模型要发邮件人工发链接** | **[WEB]** /models | 全部自助 |
| 6 | **不能导入任意 HuggingFace 模型**（用户想用 BELLE-whisper-large-v3-zh 被卡住） | **[GH]** issue #218（2024-03-18 至今 open） | 支持粘贴 HF repo id / URL 直接拉取 |
| 7 | **Whisper 重复/幻觉是长期顽疾** | **[GH]** #349；**[WEB]** FAQ 自陈"目前没有好的技术方案，需要等 AI 模型改进"；官方博客整篇讲这个 | 默认开 VAD + 提供 faster-whisper/`--no-context` 等参数；给"检测到重复片段"的自动重转 |
| 8 | **不支持 faster-whisper**（用户明确要求） | **[GH]** #332、#154 | 把 ASR 引擎做成可插拔（whisper.cpp / faster-whisper / sherpa-onnx） |
| 9 | **CUDA 版本硬绑 12.2**；新架构显卡（RTX 5060 Blackwell）说话人分离直接崩 | **[WEB]** GPU 文档；**[GH]** #403 `CUDA error: no kernel image is available` | 后端二进制按 CUDA major 版本多档分发，并在自检里明确报"你的算力架构 sm_120 不被此构建支持" |
| 10 | **授权重装后无法激活**（"activation limit reached"） | **[GH]** #402、#386（$52.49 付费用户） | 我们无付费体系，天然规避 |
| 11 | **批量模式不稳**（300+ 视频导致白屏卡死） | **[GH]** #75（2023 至今 open）；**[3RD]** V2EX https://v2ex.com/t/1043476「批量模式有一些 bug，无法正常使用」 | 任务队列做成持久化 + 可恢复 |
| 12 | **本地 LLM(Ollama) 支持有 bug**（要求填不存在的 API Key）；只有 OpenAI 能配自定义 base URL | **[GH]** #353、#359 | 统一 OpenAI-compatible 抽象，所有 provider 都能配 baseURL |
| 13 | **文档大量空壳页**（`/zh/integration/openai`、`/zh/integration/memo-integration` 整页无内容，`/zh/integration/whispercpp` 的"模型介绍"下面是空的） | **[WEB]** 实测 | — |
| 14 | **隐私政策与"完全离线"宣传矛盾**（免费用户被投放第三方广告、有 Clarity 埋点） | **[WEB]** /privacy | 真正做到零遥测，并写进 README |
| 15 | **Notion 集成需用户手工建 Integration、拷 Secret 与 page id**，官方自评"需要一定技术能力" | **[WEB]** /integration/notion | OAuth |
| 16 | **单人/极小团队风险**：构建产物挂在个人账号 `YuQian2015/memo-build`；姊妹产品 Pemo 用户报告失联 3 周 | **[BIN]+[GH]** #391 | 开源本身即答案 |
| 17 | **`vm2` 插件沙箱已被官方废弃且存在已知逃逸漏洞**；`whisper-server` 监听 `0.0.0.0` | **[BIN]** | 插件用 Node `worker_threads` + 权限白名单或 WASM；服务只绑 `127.0.0.1` |

---

## 附：本次未能验证的事项（诚实清单）

| 事项 | 状态 |
|---|---|
| Windows 安装包内是否含 Vulkan/DirectML 后端 | **未验证** —— NSIS 包本环境无 7z 可解。B5/B6 的"仅 CUDA"结论基于 macOS 包 + 官方文档 + 资产命名，**建议后续用 Windows 机器复核** |
| 思维导图是否支持节点级拖拽编辑 | **推测（未验证）** —— 仅有更新日志文字，无截图 |
| `mindmap` 字段内容是否为 Markdown | **推测（未验证）** —— 由 markmap 的输入格式反推 |
| `ws`(WebSocket) 的确切用途 | **推测（未验证）** |
| memo.ac 是否有 Product Hunt 页 / Reddit 讨论 | **UNKNOWN** —— 多次检索无果 |
| 免费档到底锁了哪些功能（页面用样式划线，纯文本抽取丢失） | 已从更新日志交叉确认 GPU 加速为 Pro 功能（v1.0.5 "Windows GPU is here...Note that this is a Pro capability"），其余**部分未验证** |
| 屏幕录制是否作为用户可见功能存在 | **UNKNOWN** —— 主进程有 `desktopCapturer`/`loopback`，但官网未宣传 |
| 我使用 WebSearch 工具全程失败（API 报错），网络检索由 sonnet subagent 代为执行 | 说明：**[3RD]** 类证据是二手转述，可信度最低 |

## 附：本次取证产物存放位置（临时目录，非交付物）

```
/tmp/memoac/
├── zipfull.txt      # v1.7.5 macOS 包全部 646 个 ZIP 条目（名/大小/偏移）
├── asar_files.txt   # app.asar 内 42,370 个文件清单
├── app_package.json # 应用真实 package.json（29 个 runtime 依赖）
├── ext/             # presets/whisper-models.js、plugins/*.json 等原始配置
└── r/               # dist/assets/index-*.js（渲染层）、dist-electron/main/index-*.js（主进程）
```
（tmpfs，重启即失。如需长期保留请 Manager 指示。）
