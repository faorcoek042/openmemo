---
id: FX-PARITY
author: memo-compare
status: ready
date: 2026-08-07
scope: 章程 F1–F5 + 要求 2.1 / 2.2，双层判据（功能点 + 实现方式）
---

## TL;DR（≤ 25 行，Manager 只读这里）

- **判据是两层的**：不写"我们也有思维导图"，写"交互与实现是否等价"。
  按这个尺子，**F1/F2/F5 我们等价或更强，F3 等价，F4 交互更强但导出残废，2.1 我们远强，2.2 我们更强**。
- **唯一一处 memo.ac 真正赢我们的功能面：Windows 上 AMD/Intel 显卡能用 GPU 跑转写**
  （DirectCompute，见 `GPU-BACKENDS.md`）。我们 Windows 只有 CPU + CUDA，**N 卡以外一律 CPU**。
  而章程 §3 明确要求「Windows + AMD → Vulkan / DirectML」。**这是章程未达标项，不只是竞品差距。**
- **而且我们的修法几乎是免费的**：`windows-x64-vulkan` 这条 CI 腿**已经绿了**
  （run 31155359839），产物 23 MB、sha256 已算好、manifest 条目已生成 —— 
  **只差把它传到 release 并把 `mirrors` 填上**。同一批还有 `metal-macos-arm64`、`cuda-linux-x64` 一起漏了。
  → **CI 编了 9 个 whisper 包，用户只拿得到 5 个。**
- **F4 的差距是反向的**：memo.ac 的导图是 markmap（Markdown→SVG），**节点不可编辑**，
  导出只有 html2canvas 位图（它自己的 issue #133「导出图片字看不清」就是这么来的）。
  我们是 mind-elixir，**节点级可编辑 + 矢量 SVG 导出**。
  **但我们服务端 4 种导图导出格式（md/opml/mm/json）在界面上一个入口都没有** —— 写了、测了、点不到。
- **纠正上一版的一条**：R-06 说「memo.ac 有标签系统」**过度纠正了**。表是有，但
  **0 个 tag IPC 通道**，locale 里 5 个 tag 键全是「AI 摘要里输出关键词」的字段名。
  → 它没有可用的笔记标签功能；**我们有**（真 DB + 真增删 UI）。
- 规模对照：IPC/接口 342 vs 我们 83 REST+2 WS；ASR 引擎 8 条路径 vs 我们 3；
  ASR 模型 47 vs 27；LLM 供应商 24 vs 24（我们 23 可用）；设置页签 12 vs 1。
- 未验证/存疑与不该抄的东西：见 §5、§6。

---

## 1. 判据说明（为什么这张表和以前几张不一样）

- **memo.ac 侧**：本轮**首次解开 Windows 包**（当年因无 7z 未解），macOS 包同步复核。
  产物清单见 `win-package-listing.txt`，事实台账见 `ipc-channels.txt` / `settings-schema.txt` /
  `feature-list.txt` / `asr-engines.txt` / `export-formats.txt`。
- **我们这侧的每一个「有」都要落到 file:line**，并且**专门去找"写了但永远触发不了"的代码**。
  本轮真的找出来 4 处（§3 gap 3/4/5/8）—— 这正是本项目反复栽跟头的形态。
- 标记约定：`[实测]` 我本人核过；`[报告]` 引自他人未复核；`[未验证]`；`UNKNOWN`。

---

## 2. F1–F5 / 2.1 / 2.2 逐条对照

### F1 音视频链接导入

| | memo.ac | 我们 | 差距 |
|---|---|---|---|
| 功能点 | 粘贴 URL → 下载 → 转写 | 同 | **无** |
| 下载器 | 内置 `yt-dlp.exe` 18 MB **随包出厂** | `yt-dlp` 走 backend pack，**需先一键安装** | ⚠️ 轻微：首次要多点一次 |
| 探测 | yt-dlp 单一路径 | **多源打分链**：直链/HLS(80/30)、RSS(85)、yt-dlp(10) 兜底 `packages/pipeline/src/media/sources/*` | ✅ 我们更强 |
| 失败反馈 | UNKNOWN | 422 `NO_MEDIA_SOURCE` + remediation 文案 | ✅ 我们更强 |
| 代理 | yt-dlp `--proxy` + `--socket-timeout 60`，约 37 处注入点 `[报告 R-06]` | `proxy.ts` 质量更高，但 **daemon/downloader 接线仍缺** `[报告 R-06]` | ⚠️ 见 §4 gap 7 |

**结论：功能等价，实现我们更强（多源探测），唯一不足是 yt-dlp 非出厂自带。**

### F2 本地媒体导入

| | memo.ac | 我们 | 差距 |
|---|---|---|---|
| 拖拽 | 有 | 有，`CapturePage.tsx:102-111` `onDragOver`/`onDrop` `[实测经审计]` | 无 |
| 上传 | 本地进程直接读盘 | `XMLHttpRequest` multipart → `POST /api/notes/upload`，**真进度**，流式落盘 `apps/daemon/src/http/upload.ts:459` | 形态不同，能力等价 |
| 路径导入 | 原生文件对话框 | 服务端绝对路径导入 + **路径穿越防护** `rest/notes.ts:249-273` | ✅ 我们多一层防护 |

**结论：等价。**（架构差异：它是桌面应用直接读盘，我们是浏览器上传 —— 这是 local-first web 形态的必然，不是缺陷。）

### F3 录音转文字

| | memo.ac | 我们 | 差距 |
|---|---|---|---|
| 录音 | `addon/asr/memo-recorder.exe` 原生录音器 | 浏览器 `AudioWorklet` Float32→Int16 → WS 上行 `asrStream.ts:122` | 形态不同，等价 |
| 流式 ASR | sherpa-onnx 在线（`asr_online_process.js`） | sherpa-onnx 流式，`setup.ts:535-544` | 等价 |
| 落库 | UNKNOWN | partial/final → DB + SSE，stop 后**离线重跑**并生成波形 `ws/recorder.ts:367-384` | ✅ 我们的两段式更完整 |

**⚠️ 重要更正**：R-06 曾记「我们的 RecorderPage 是 mock，端到端从未跑通」。
**该结论已过期** —— `asrStream.ts` 是真 `WebSocket`，旧的 `setInterval` 假字幕循环已删除。`[实测经审计]`

**结论：等价。**（残留问题：`RecorderPage.tsx:48,468` 注释承诺「可以撤销」，界面上没有撤销按钮 —— 注释撒谎，UI 没有。）

### F4 思维导图整理 ★ 这条差异最大，且方向和直觉相反

| 维度 | memo.ac | 我们 | 判定 |
|---|---|---|---|
| 库 | **markmap** `[实测]` 渲染层 39 处命中，`Markmap.create("svg#mindmap", …)` | **mind-elixir ^5.14.0** `apps/web/package.json:35` `[实测]` | — |
| 节点从哪来 | LLM 生成 **Markdown** → markmap 解析 | LLM → `MindMapDoc` → 适配器 → mind-elixir `jobs/runners/mindmap.ts:118`；无 provider 则 job `blocked` + remediation，**绝不编造** | 我们更诚实 |
| **能不能编辑** | **不能。** markmap 是渲染器，只有折叠/缩放（`.markmap-node>circle{cursor:pointer}`）。改内容 = 改 Markdown 原文 | **能，节点级。** `contextMenu / toolBar / keypress / allowUndo` 全开，拖拽改结构 `MindmapView.tsx:56-65` `[实测]` | ✅ **我们明显更强** |
| 编辑持久化 | N/A | `bus.addListener('operation')` → `fromMindElixir` → 防抖 `PATCH /api/notes/:uid/mindmap` → `mindmaps.save({generatedBy:'user'})` + revision `[实测经审计]` | ✅ |
| **导出成什么** | **png / jpg / svg，走 `html2canvas`**（10 处命中，**0 处 `exportSvg`/`exportPng`**）`[实测]` | **svg / png，走 `instance.exportSvg()` 矢量序列化**，明确不用截屏 `features/mindmap/export.ts:22-32` `[实测]` | ✅ 我们更强（它的 issue #133「导出图片字看不清」根因就是截屏） |
| 结构化导出 | **无。** opml/freemind/xmind 全部 0 命中（命中全在 mime-db 与公共后缀表里）`[实测]` | 服务端**有 4 种**：md / opml / mm(FreeMind) / json `rest/content.ts:425-439` | 我们有它没有 —— **但见下** |
| 🔴 | — | **这 4 种在界面上点不到。** 全 `apps/web/src` grep `what=mindmap` **只命中 1 个测试注释 + 1 个 README**；`ExportMenu.tsx:31` 只给 `['txt','md','srt','vtt','json']` 且从不带 `what=` `[实测，我本人 grep]` | **写了、测了、用户点不到** |

**结论：交互与实现我们都更强，但最能拉开差距的结构化导出是死的。这是本轮最便宜的一条修复。**

### F5 笔记管理

| | memo.ac | 我们 | 判定 |
|---|---|---|---|
| 列表/详情/搜索 | 有 | 有；搜索是真 FTS5 + bm25 + libsimple 中文分词，降级 trigram **如实告知** | 等价/我们更透明 |
| **标签** | ❌ **表有，功能没有。** `tag`/`note_tag`/`doc_tag` 三表 `[报告 R-06]`，但 **0 个 tag IPC 通道** `[实测]`，locale 里 5 个 tag 键全属「AI 摘要输出关键词」`[实测]` | ✅ **真有**：`tags`+`note_tags` 表 + `TagEditor` 增删 UI | ✅ **我们更强（且推翻 R-06 的"它有标签系统"）** |
| 文件夹 | 有（`folder.workspaceId`） | 有，但**无重命名 UI、无拖拽移动**（`useRenameFolderMutation`/`useMoveNoteMutation` 零调用） | ⚠️ 我们残 |
| **空间 Workspace** | ✅ 一等公民，与磁盘目录绑定，设置里独占第 2 个页签 `[报告 R-06]` | ❌ **零实现** | ❌ 缺（ADR-006 曾决定不做，R-06 请求裁决，**至今未裁**） |
| 星标 | UNKNOWN | ✅ 完整（DB 列 + UI + 导航） | — |
| 回收站 | UNKNOWN | ⚠️ **软删除是真的**（`repos.ts:371` `UPDATE notes SET deleted_at`，全仓 0 处 `DELETE FROM notes`），但**没有回收站 UI、没有恢复入口**，行永久孤儿化 | ⚠️ 半成品 |
| **转写稿↔音频联动** | 有 | ✅ **双向都是真的**：点时间码 → `requestSeek` → `PlayerBar` 设 `currentTime`；播放中 rAF + 二分查找高亮当前行并自动滚动，手动滚动关闭跟随 | 等价/我们更细 |
| 🔴 | — | **搜索结果跳时间点是死的**：`SearchPage.tsx:135-139` 带 `?t=<ms>` 跳转并注释「详情页据此 seek」，而 `NoteDetailPage` **从不读 `t`** → 点搜索结果永远从 0:00 开始 | **注释自称"杀手体验"，实际没接** |

**长期未决**：R-06 提出的「软删除到底软不软」本轮**已定论**：软删除，但无回收站 UI。

### 要求 2.1 GPU 组件全程网页安装配置

| 步骤 | memo.ac | 我们 |
|---|---|---|
| 检测硬件 | ❌ **没有**。`nvidia-smi` / `nvcc --version` 的输出**原样显示**在「View CUDA information」弹窗里，不驱动任何决策 `[实测]` | ✅ `GET /api/runtime/hardware` → 真 spawn `nvidia-smi` / `system_profiler` |
| 推荐后端 | ❌ 没有。三个按钮 `CPU / GPU / Cuda`，**出厂默认 CPU**，选错了自己负责 | ⚠️ 有，但**纯 CPU 机器上那个"推荐"徽章永远不渲染**（需要存在同引擎不同后端的包才narrow得出来） |
| 下载二进制 | ⚠️ 半：CUDA 靠**随包 18 MB 7z** + 应用内下载 `whisper-cublas-12.2.0-bin-x64.zip` | ✅ backend pack + 镜像探测 + sha256 校验 |
| 安装 | 解压到 `addon/whisper/win32/x64/cublas`，**判据 = 文件存在性** | ✅ 临时目录 → 校验 → 原子 rename |
| 自检 | ❌ 只有存在性检查（`checkWhisperCudaExist`） | ✅ **真跑一次推理**，结果**写回 install manifest**，刷新后仍在 |
| 显示状态 | ⚠️ 只有 CUDA 信息弹窗 | ✅ 每包状态徽章，且区分「通过但没加速」（`devicesFound===0`） |

**结论：要求 2.1 我们全面强于 memo.ac。它根本没做"检测→推荐"这一步。**
**但**：我们在 **Windows AMD/Intel 这一格干脆没有产物**，而它有（DirectCompute）。
→ **流程我们赢，覆盖面它赢一格。**

### 要求 2.2 模型浏览/下载/切换/删除/量化

| 动作 | memo.ac | 我们 |
|---|---|---|
| 浏览 | ✅ 15 个 whisper + 双轴筛选卡片（`lang` × `speedValue`） | ✅ `/api/models/catalog`，27 条 ASR / 14 组 / 3 族 |
| 下载 | ✅ 清单从 `models.memo.ac/all-models` **运行时热更新** | ✅ 幂等键 + 镜像 |
| 切换 | ✅ | ✅ 两个独立入口（ModelCard + AsrModelPicker） |
| 删除 | UNKNOWN | ✅ `DELETE /api/models/:id`，409 `MODEL_IN_USE` 保护 + 孤儿 blob GC |
| **量化选择** | ❌ **没有，whisper 全 f16** | ✅ f16/q8_0/q5_0/q5_1 四档，且**真的改变下载的 variant** |
| 显存 fit 预检 | ❌ 无 | ✅ `fitness.tier` |
| 🔴 | — | **「跑基准」按钮打的是永久 501**，且该页**不渲染 error** → 点了毫无反应 `rest/models.ts:271-283` |

**结论：要求 2.2 我们更强（量化 + fit 预检是它没有的）。**

---

## 3. 规模对照（纯事实）

| 维度 | memo.ac v1.7.5 | OpenMemo | 备注 |
|---|---|---|---|
| IPC / 接口 | **342** `ipcMain.handle`（0 个 `ipcMain.on`） | **83** REST + **2** WS | 形态不同，不可直接比大小 |
| 本地 ASR 引擎 | 4（whisper / sherpa-onnx / funasr-cli / parakeet-cli） | 3（whisper.cpp / paraformer / sherpa-onnx） | 我们另有 1 个**零调用**的 `whisper.cpp-server` |
| 云 ASR | 4 个插件（Deepgram/ElevenLabs/Groq/OpenAI），**全走插件市场**，bundle 内 0 硬编码 | 0 | 章程未要求 |
| ASR 模型条目 | **47**（whisper 15 + sherpa 27 + parakeet 4 + funasr 1） | **27**（14 组 / 3 族） | 我们多一个量化维度 |
| LLM 供应商 | 24（JSON 注册表 + 远端热更新） | 24（`vendor/manifests/llm-providers.json`，23 可用，`mistralai` 明示禁用） | 持平 |
| 设置页签 | **12** | **1**（且 `/settings/:section` 的 `section` 参数从不被读取） | ❌ 差距明显 |
| SQLite 表 | 9 | — | |
| UI 语言 | 8 | — | |
| 文件格式产出 | 17 + 2 集成 | 5 笔记 + 6 导图（4 死） | |
| OCR | ✅ RapidOcrOnnx + PaddleOCR / macos-vision-ocr | ❌ 无 | 章程未要求 |
| PDF 导出 | ❌ **死代码**，菜单项 `disabled:!0`，无 PDF 引擎 | ❌ 无 | 双方都没有 |

---

## 4. 差距清单（按"值不值得做"排序）

> 排序依据 = 用户可感知后果 ÷ 代价。**已被裁掉的（TTS / 移动端 / 协作 / 云账号 / 支付 /
> cookie 下会员内容 / macOS Intel / linux-arm64 / ROCm）与「LLM 接在线 API」不在此列。**

### 🥇 gap 1 — Windows AMD/Intel 显卡拿不到任何 GPU 加速（**章程未达标**）

- **用户可感知后果**：Windows 上非 N 卡用户只能跑 CPU，转写慢 2–10 倍。
  竞品在同一台机器上能用 GPU（DirectCompute）。章程 §3 写着「Windows + AMD → Vulkan / DirectML」。
- **代价：低。** `windows-x64-vulkan` CI 腿**已绿**（run 31155359839），
  产物 `packs-windows-x64-vulkan` 23 MB **未过期**，manifest 条目已生成、
  `sizeBytes: 25067783` / `sha256: 50de90bd…` 都在，**唯一缺的是 `mirrors: []`（没传 release）**。
  参照 `whispercpp-vulkan-linux-x64` 已经填好的 mirror 照做即可。
- **建议：做。** 这是投入产出比最高的一条。
- ⚠️ **需要用户拍板的部分**：传 release 属于「建/改 release」，本轮纪律禁止我做 —— **请指派或授权**。

### 🥈 gap 2 — CI 编了 9 个 whisper 包，用户只拿得到 5 个

- **实测**：CI 合并出的 manifest 有 9 个 whisper 包，仓库 `vendor/manifests/backends.json` 只有 5。
  漏的 4 个：`whispercpp-vulkan-win-x64`、`whispercpp-metal-macos-arm64`、
  `whispercpp-cuda-linux-x64`、`whispercpp-cuda-win-x64`。
- **用户可感知后果**：
  - Windows AMD/Intel：**完全没有 GPU 选项**（= gap 1）。
  - macOS：Metal **其实在跑**（`whispercpp-cpu-macos-arm64` 的 `providesFiles` 里就有
    `libggml-metal.so` / `libwhisper.coreml.dylib`），但包被标成 `backend:"cpu"` →
    界面**永远说不出"你在用 Metal"**，`recommended` 也永远匹配不上。**是标签问题，不是能力问题。**
  - Linux NVIDIA：无 CUDA 包（章程已记「缺 `libcudart` 随包分发」，这条有真实阻碍）。
- **代价**：Vulkan-win 低；metal 重贴标签中等（要动 applicability 与 `tools.ts` 偏好序）；Linux CUDA 高。
- **建议：Vulkan-win 立刻做；metal 重贴标签排进下一轮；Linux CUDA 维持现状并改口径。**

### 🥉 gap 3 — 思维导图的 4 种结构化导出，用户点不到

- **后果**：我们**唯一一处结构上超过竞品的导图能力**（md / opml / mm / json，竞品只有位图截图）
  对用户不存在。导图做完导不出到 XMind/FreeMind/Obsidian。
- **代价：很低。** 服务端 `rest/content.ts:425-439` 已实现并有测试；
  只需 `ExportMenu` 增加一组带 `what=mindmap` 的入口（或导图页加导出菜单）。
- **建议：做。** 性价比仅次于 gap 1。

### 4. gap 4 — 搜索结果点进去不跳时间点

- **后果**：`SearchPage` 自己的注释把这叫「杀手体验」，实际点任何搜索结果都从 0:00 开始。
  长音频里搜到一句话却要自己拖进度条 —— 搜索的价值被砍掉一半。
- **代价：很低。** 前端一处：`NoteDetailPage` 读 `searchParams.get('t')` → `requestSeek`。
  双向联动的两条路径都已经是真的，只差把参数接上。
- **建议：做。**

### 5. gap 5 — 「跑基准」按钮点了没反应（永久 501 且不报错）

- **后果**：用户点了以为坏了。这是"看起来实现了但不可能成功"里最刺眼的一个。
- **代价：极低（隐藏按钮）/ 中（真做 benchmark）。**
- **建议：先隐藏或明确标注"未实现"**，别让它静默失败。真做与否请用户拍板。

### 6. gap 6 — 设置页只有 1 个页签，且 `/settings/:section` 的 section 从不被读

- **后果**：竞品 12 个设置页签；我们的设置分散在 `/settings`、`/models?tab=llm`、`/runtime`、
  `/settings/storage`，且深链 `/settings/xxx` 全渲染同一页。用户找不到设置。
  另有 15 个后端 settings 键**没有任何 UI**（`asr.defaultEngineId`、`asr.language`、
  `download.concurrency`、`runtime.selectedBackend` 等）。
- **代价：中。** 纯前端信息架构 + 若干表单。
- **建议：做，但排在功能性缺口之后。**

### 7. gap 7 — 代理只有 UI 与纯函数，daemon/downloader 没接线

- **后果**：被墙用户在设置里配了代理，**下载模型/后端包时并不走它**。
  竞品覆盖约 37 处注入点（含云 LLM / 模型下载 / 版本检查）`[报告 R-06]`。
- **代价：中。** `packages/pipeline/src/subprocess/proxy.ts` 质量已超竞品，缺的是接线与持久化。
- **建议：做。** 可直接抄它三条：默认 `system`、yt-dlp 加 `--socket-timeout 60`、
  「测代理」与「测下载源」**分成两个按钮**。

### 8. gap 8 — 回收站：软删除是真的，但没有恢复入口

- **后果**：删了就再也拿不回来，而数据其实还在（行永久孤儿化）。产品自己的文案已经承认这点。
- **代价：低。** 加一个 `?deleted=1` 列表 + 恢复端点（`deleted_at = NULL`）。
- **建议：做。**

### 9. gap 9 — 文件夹无重命名 / 无拖拽移动

- **后果**：建错名字只能删了重建。`useRenameFolderMutation` / `useMoveNoteMutation` 已写好、零调用。
- **代价：低。** 接线即可。
- **建议：做（可与 gap 8 合并一轮）。**

### 10. gap 10 — 空间 / Workspace（**需要用户拍板，我不替你选**）

- memo.ac 把 Workspace 做成一等公民且**与磁盘目录一一绑定** `[报告 R-06]`；我们零实现。
- **两层成本差很多**：只做逻辑分区（`folders` 已有 `parent_id`/`color`/`icon`，加一表一列）= 低；
  做「每空间独立磁盘根」= 要改 daemon 的路径解析全局单例 = 高。
- **ADR-006 曾决定不做，R-06 请求裁决，至今无人回答。** 这条**卡在决策上，不卡在实现上**。
- **建议：需要用户拍板。**

### 不建议做（"它有我们没有" ≠ "我们该有"）

| memo.ac 有 | 为什么不建议 |
|---|---|
| OCR（RapidOcrOnnx + PaddleOCR） | 章程 F1–F5 无此项；引入两个原生二进制 + 三个 ONNX 模型，维护面大幅扩张 |
| 插件市场（`integrations.memo.ac/plugins/v2`） | 需要长期运营的服务端；且它的 `vm2` 沙箱**已废弃且有逃逸漏洞**（沿用当年判断） |
| 模型清单**运行时**从 `models.memo.ac/all-models` 热更新 | 章程是 local-first，不宜新增出网依赖；清单进 git 更可审计 |
| PDF 导出 | **它自己也没有** —— 菜单项 `disabled:!0`，无 PDF 引擎。别照抄一个死功能 |
| 云 ASR 插件 4 家 | 章程未要求；且与「本地优先」张力大 |
| **GPU 加速做成付费墙** | 它把 GPU 加速做成试用额度制（`useProLimit()`）。我们没有商业模式要养，**不要抄** |

**新发现的「明确不要照抄」**（补充当年那两条 `vm2` / `whisper-server --host 0.0.0.0`）：

1. **静态密钥 AES 安全剧场**：它用**硬编码密钥+IV** 的 AES-256-CBC 只加密 Notion secret，
   24 家 LLM 的 `apiKey` 全明文躺在 `conf/setting.conf` 旁边，全 bundle `safeStorage` 0 命中 `[报告 R-06]`。
   **加密假象比明文更危险**；我们的做法（明文但 ADR-006 强制向用户 disclosure）更诚实。
2. **`session.resolveProxy("https://www.google.com")` 探测系统代理** `[报告 R-06]`：
   探测目标对其主要受众（被墙用户）本身不可达。
3. **默认 CPU + 无硬件检测**：它把"选哪个后端"整个甩给用户。我们已经比它好，别退回去。

---

## 5. 未验证 / 存疑 / UNKNOWN（诚实声明）

- `[未验证]` **未在真浏览器里点击验证任何页面**，也**未运行 memo.ac 的任何二进制**。
  我方结论全部来自读代码 + grep + 读 manifest + `gh` 查 CI 事实；memo 侧全部为静态取证。
- `[未验证]` gap 1 的「传 release 后 Windows AMD 就能用」**未在真 AMD 硬件上验证过** ——
  与章程 §3 对「Windows + NVIDIA」那一格的说法同理：**这台机器结构上验不了**。
- `UNKNOWN` memo.ac 的删除/回收站行为、星标、Pro 额度的数值与单位、`enableCoreML` 由谁置位。
- `UNKNOWN` memo.ac 的 preload API 面（`window.AIM.*`）—— 是 V8 字节码 `index.jsc`，**未反编译**。
- `[报告]` 凡标注的（Workspace、代理 37 处注入点、9 张表、静态密钥 AES）均引自 R-06，**本轮未复核**。
- 本轮**未改动任何产品代码**，未碰 `:10000` / `/root/data-memo` / 机器级指针，未建改删 release。
- **未把 memo.ac 的可执行文件、模型或任何受版权资源提交进本仓库**；
  `docs/research/memoac/` 下全部为文本事实台账（通道名、配置 schema、清单、计数）。
