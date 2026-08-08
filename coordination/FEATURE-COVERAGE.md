# 功能覆盖矩阵 —— 找遗漏用（Manager 维护）

> **用户指令（2026-08-02）：功能有效优先，性能靠后。先补全功能、找出遗漏与缺失点，再做决策。**
> 状态：🟢 端到端可用 · 🟡 部件可用但未接通 · 🔴 未实现/无入口 · ⚪ 未知 · ✂️ 已裁决不做
> 数据来源：`gpu-runtime`(T-030/031)、`architect`(T-029 审计)、`oss-scout`、`model-mgmt` 的实跑报告

---

## 🚩 2026-08-06 逐条复核：**20 条 🔴 里 16 条是假阴性**

> 本表的 20 行 🔴 已逐条实测复核。**16 条早已上线**（功能在、路由在、组件在），
> **只有 3 条今天仍然成立**，另 1 条需要真 API Key 才能证伪。
> 下面正文里每一条订正都保留了"此前写着什么"，方便对照。
>
> **为什么会集体假阴性**：本表的多条结论来自 `grep -rn` 的**零命中**，而
> ① 有三个 `.ts` 源文件当时带**裸控制字节**，`grep` 默认对它们静默零输出（已由另一 agent 修复 +
> 加了 `packages/pipeline/src/subprocess/__tests__/sourceIsGreppable.test.ts` 守卫）；
> ② 多条命中**全落在注释里**（见下方 i18n 与 reduce 两例）。
> **今后做这类审计：`grep -a` + 剥注释，两步都不能少。**
>
> ### ✅ 今天仍然成立的只有这 3 条 —— 抢救就抢救这些
>
> （「原行号」= **订正前**本文件的行号，仅供与旧引用对照；本次订正后行号已整体下移。）
>
> | 优先  | 原行号 | 事项                                            | 为什么仍成立                                                                                                                                                                                                                                                                                                                                                                                                                         |
> | ----- | ------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
> | **1** | `:50`  | **笔记删除 / 重命名 / 移动无 UI（M-6）**        | **只差一个按钮**。`features/notes/api.ts:246` `useDeleteNoteMutation()`（软删除，注释还写着"配合 Toast 的撤销"）、`:255` `useRenameNoteMutation()`、`features/folders/api.ts:164` `useMoveNoteMutation()` 三个 hook 齐全且已 re-export，**但除定义与 re-export 外零个组件调用**；`NotesListPage.tsx` / `NoteDetailPage.tsx` 里 `Trash2\|Pencil\|MoreVertical\|MoreHorizontal` 零命中。**"有代码但用户到不了"，成本是一个下拉菜单。** |
> | **2** | `:42`  | **reduce 阶段语义去重**                         | `packages/mindmap/src/generate.ts` 剥注释后 `去重`/`reduce`/`dedup`/`merge` **全部 0 命中**；唯一命中在 `:18` 的**块注释**里。真实实现 `:243-310` 每个 window 各调一次 `chatStructured` 后**直接挂到 `rootKey` 下**，**没有第二次 LLM 调用、没有任何合并/去重**。（附带：`generate.ts:18` 那条注释描述了一个不存在的阶段，本身也是债。）                                                                                             |
> | **3** | `:45`  | **向量检索** —— 事实成立，但**应标 ✂️ 而非 🔴** | 链路确实断（`rest/search.ts:190` 「向量路：扩展在也没用，因为没有任何地方生成 embedding」）；但 `PENDING-USER-DECISIONS.md` §D「我已经替你拍板的」已把「向量检索 v1 砍掉」列为 Manager 已拍板项 → 它是**已裁决不做**，不是**未实现的缺口**。已在正文改标 ✂️。                                                                                                                                                                        |
>
> ### ⚠️ 仍需真环境才能判的（本轮**一个字都没动**）
>
> 播客 RSS（原 `:25`）· HLS（原 `:26`）· LLM 云 provider（原 `:73`，需真 Key）·
> LLM 档 2 探测（原 `:74`，需装 Ollama/LM Studio）·
> 运行时管理页「未在真浏览器点过」（原 `:58`；全仓无 playwright/puppeteer，三条测试道都是 jsdom）。

---

## ✅ 三个交付阻塞 —— **B-1 / B-2 / B-3 全部已闭合**（2026-08-06 复核）

| #              | 此前写着（保留原文）                                                                                                                                                             | 实测                                                                                                                                                                                                                                     | 归属         |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| ~~**B-1**~~ ✅ | ~~**4 个 ASR 模型不在模型目录**（silero VAD / sherpa 流式 zh-14M / paraformer-zh-small / 标点模型）→ 要求 2.2 装不了~~                                                           | **5 条全在** `vendor/manifests/models-asr-support.json`：`vad/silero-vad-onnx`、`vad/silero-vad-ggml`、`asr/sherpa-streaming-zh-14m`、`asr/paraformer-zh-small`、`punctuation/ct-transformer-zh-en`                                      | `model-mgmt` |
| ~~**B-2**~~ ✅ | ~~**daemon 只有 6 个端点**（health/auth/events/status/shutdown/echo）；`/api/notes`、`/api/import`、`/api/search` **不存在**，`/media` 返回 501 → 前端 90% 仍跑 mock，无端到端~~ | **52 条唯一路由字面量**（`grep -a` 去重计数）。`rest/notes.ts:358` GET `/api/notes`、`:259` POST `/api/notes/import`、`rest/search.ts:78` `/api/search` 全在；`http/media.ts`（222 行）**全文无 501**。`R-06:342` 独立数出「42 条 REST」 | `oss-scout`  |
| ~~**B-3**~~ ✅ | ~~**设置页没有 API Key 输入框** → 用户无法配置 LLM，F4 在真实环境根本没法用~~                                                                                                    | 有，且是 **provider 级**：`apps/web/src/components/common/llm/LlmSettingsSection.tsx:440`（state）、`:505`（输入框 `t('settings.apiKey')`）；后端 `apps/daemon/src/http/rest/settings.ts:183` `/api/secrets`                             | `architect`  |

---

## 章程 F1–F5

| 功能              | 子项                           | 状态                          | 说明                                                                                                                                                                                                                                                                                                                                                                |
| ----------------- | ------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F1 链接导入**   | yt-dlp 全链路                  | 🟢                            | ⚠️ 曾对**每个视频都失败**，修 2 个 bug 后通：`Me at the zoo` 19s→2 段                                                                                                                                                                                                                                                                                               |
|                   | HTTP 直链                      | 🟢                            | 220.2s → 9 chunk / 45 段                                                                                                                                                                                                                                                                                                                                            |
|                   | 播客 RSS                       | 🟡                            | 只解析 feed，**没下载并转写过一集**（T-031 修复中）                                                                                                                                                                                                                                                                                                                 |
|                   | HLS                            | 🟡                            | 拉流验证过，**没在 HLS 音频上跑过 ASR**（T-031 修复中）                                                                                                                                                                                                                                                                                                             |
|                   | `DirectHttpSource` 断点续传    | 🟢                            | 走共享的 `resumableFetch`：`packages/pipeline/src/media/sources/directHttp.ts:18,160,167` + `packages/pipeline/src/media/resumableFetch.ts`。**此前标 🔴「播客几百 MB，断网从头再来」**                                                                                                                                                                             |
|                   | 会员内容（cookie）             | ⏸️                            | **`--cookies` 是任意读文件入口，需用户先做安全决策**                                                                                                                                                                                                                                                                                                                |
| **F2 本地媒体**   | 本地文件转写                   | 🟢                            | 11.0s→0.80s；长音频 33.6 分钟 80 chunk                                                                                                                                                                                                                                                                                                                              |
|                   | **拖拽上传**                   | 🟢                            | **M-2 已闭合**：`apps/web/src/features/capture/CapturePage.tsx:49-52`（`handleFiles`）、`:107-111`（`onDrop`）是真实现，`:46` 的注释自陈"之前是空函数"。**此前标 🔴「`onDrop` 是空函数，是个死的装饰」**                                                                                                                                                            |
|                   | daemon 上传端点                | 🟢                            | `POST /api/notes/upload` 在：`apps/daemon/src/http/upload.ts:465`，测试 `upload.test.ts:357`。**此前标 🔴，理由是 B-2 —— B-2 已闭合**                                                                                                                                                                                                                               |
| **F3 录音转文字** | 流式 ASR 引擎                  | 🟢                            | ⚠️ 此前**能跑是运气**（sherpa CJS interop bug，已修）                                                                                                                                                                                                                                                                                                               |
|                   | 两阶段合并保留用户编辑         | 🟢                            | 后端实测通过                                                                                                                                                                                                                                                                                                                                                        |
|                   | **转写段落编辑 UI**            | 🟢                            | **M-4 已闭合**：`apps/web/src/features/transcript/SegmentRow.tsx:28,30,36,38,61,88,110-111,168` —— `SegmentRow` 双击即可编辑。**此前标 🔴「前端没入口 → 后端逻辑永远走不到」**                                                                                                                                                                                      |
|                   | 浏览器麦克风采集               | 🟢                            | `apps/web/src/features/recorder/asrStream.ts:2` 自陈是「F3 实时录音的**真实**上行通道」，`:108-122` 是真 `WebSocket`。**此前标 🔴「未接」**                                                                                                                                                                                                                         |
|                   | daemon `/ws/recorder`          | 🟢                            | 后端 `apps/daemon/src/ws/recorder.ts`（366 行）+ 前端 `asrStream.ts:72`（`new URL(…/ws/recorder)`）**已接通**。**此前标 🔴「未接」**；`R-06 §5` 的 N-2「RecorderPage 是 MOCK」也随之作废                                                                                                                                                                            |
| **F4 思维导图**   | 转写稿→LLM→导图                | 🟡                            | 后端跑通（38 段→12 节点），~~但受 **B-3** 阻塞，用户配不了 Key~~ ← **B-3 已闭合（见文首），此阻塞理由已消失**；🟡 保留是因为**本轮未复核**端到端（需真 API Key，见「跨领域 · LLM 云 provider」一行）                                                                                                                                                                |
|                   | 库无关 schema + 双适配器       | 🟢                            |                                                                                                                                                                                                                                                                                                                                                                     |
|                   | Markdown/OPML/FreeMind 导出    | 🟢                            | 往返各 31 节点校验通过                                                                                                                                                                                                                                                                                                                                              |
|                   | **导图编辑（拖拽/右键/撤销）** | 🟢                            | **本轮补上**——这是选 mind-elixir 而非 markmap 的全部理由                                                                                                                                                                                                                                                                                                            |
|                   | **SVG/PNG 导出**               | 🟢                            | **本轮补上**，用 `exportSvg()`/`exportPng()` 矢量导出，非截屏                                                                                                                                                                                                                                                                                                       |
|                   | reduce 阶段语义去重            | 🔴 **★仍成立（抢救第 2 名）** | 长稿可能主题碎片化。**2026-08-06 复核确认仍成立**：`packages/mindmap/src/generate.ts` 剥注释后 `去重`/`reduce`/`dedup`/`merge` 全部 0 命中（唯一命中在 `:18` 的**块注释**）；`:243-310` 每个 window 各调一次 `chatStructured` 后直接挂到 `rootKey` 下，**无第二次 LLM 调用、无合并去重步骤**                                                                        |
| **F5 笔记管理**   | 数据模型（26 表）              | 🟢                            |                                                                                                                                                                                                                                                                                                                                                                     |
|                   | **全文搜索**                   | 🟢                            | 关键词路已端到端：`apps/daemon/src/http/rest/search.ts:78` + 前端 `apps/web/src/routes.tsx:11,39`。**此前标 🟡「daemon `/api/search` 不存在（B-2）」—— 该端点一直都在**（向量路另见下一行）                                                                                                                                                                         |
|                   | 向量检索                       | ✂️                            | **已裁决 v1 不做**（`PENDING-USER-DECISIONS.md` §D「我已经替你拍板的」，Manager 已拍板，索引本就设计成可重建缓存）。**此前标 🔴「没有任何地方生成 embedding，链路是断的」—— 事实完全属实**（`rest/search.ts:5,190,193`、`roleMap.ts:28` 均自陈）**，但它是"已裁决不做"，不是"未实现的缺口"**，挂 🔴 会让人误以为要补                                                |
|                   | 时间轴联动                     | 🟡                            | ~~`/media` 501~~ ← **不成立**：`apps/daemon/src/http/media.ts`（222 行）**全文无 501**，`GET /media/asset/:ulid` 有完整 Range 支持（`R-06 §3.4` 第 35 条独立复核为"➖ 相当"）。🟡 保留是因为**本轮未复核**前端联动交互                                                                                                                                              |
|                   | **标签/星标/文件夹**           | 🟢                            | 后端 8 条写路由：`apps/daemon/src/http/rest/organize.ts:70-75`（tags GET/POST）、`:237-246`（folders）、`:304`（PATCH）、`:408`（DELETE）；前端 `features/notes/TagEditor.tsx`、`features/folders/FolderTree.tsx`。**此前标 🔴「前端只读、零写入路径」**                                                                                                            |
|                   | **笔记编辑器（TipTap）**       | 🟢                            | 215 行 TipTap 编辑器 `apps/web/src/features/notes/NoteEditor.tsx:3-4,58` + `apps/web/package.json:27-30` 四个 `@tiptap/*` + 后端 `PATCH /api/notes/:uid`。**此前标 🔴「完全遗漏，代码里只有一句占位文字」**                                                                                                                                                         |
|                   | **笔记导出**                   | 🟢                            | `apps/web/src/features/notes/ExportMenu.tsx`（5 格式）+ `GET /api/notes/:uid/export` + 导出测试 `apps/daemon/src/http/rest/content.export.test.ts`。**此前标 🔴「零实现零入口，全仓 grep 无命中」—— 那次 grep 是假阴性**                                                                                                                                            |
|                   | 笔记删除/重命名/移动           | 🔴 **★仍成立（抢救第 1 名）** | 无 UI（M-6）。**2026-08-06 复核确认仍成立，而且只差一个按钮**：`features/notes/api.ts:246` `useDeleteNoteMutation()`（软删除）、`:255` `useRenameNoteMutation()`、`features/folders/api.ts:164` `useMoveNoteMutation()` 三个 hook 已写好且已 re-export，**但除定义与 re-export 外零个组件调用**；两个笔记页里 `Trash2\|Pencil\|MoreVertical\|MoreHorizontal` 零命中 |
|                   | "引用此刻"锚点                 | 🟢                            | **M-7 已闭合**：TipTap 自定义 node `apps/web/src/features/notes/TimeAnchor.ts:1-4` + 工具栏 `NoteEditor.tsx:137-161`（`{/* ★ M-7「引用此刻」*/}` + `Clock` 按钮 + `type:'timeAnchor'` 插入）。**此前标 🔴「无 UI」**                                                                                                                                                |

## 要求 2.1 / 2.2

| 要求         | 子项                             | 状态 | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------ | -------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **2.1**      | 硬件探测 / 后端下载安装自检      | 🟢   | 丢 1 个 `.so` 即生效，实证闭环                                                                                                                                                                                                                                                                                                                                                                                                             |
|              | 运行时管理页                     | 🟡   | **未在真浏览器点过**（T-027 进行中）                                                                                                                                                                                                                                                                                                                                                                                                       |
|              | mac/Windows 二进制               | 🟡   | **此前标 🔴「无 GitHub remote，CI 从未执行」—— 两条都已不成立**：`git remote -v` = `https://github.com/faorcoek042/openmemo.git`；`docs/design/D-11-ci-platform-facts.md:9-11`「CI 第一次真的跑起来了…此前 138 个提交、零次 workflow 运行」；`backends.json` 的 `whispercpp-cpu-macos-arm64` 已指向我们自己的 `backend-packs-2026.08.06` release。**仍缺的是 Vulkan / ROCm / Metal / CoreML / Linux-CUDA 产物**（全为零，见 `D-11:15-18`） |
| **2.2**      | 目录/量化/fit/下载/校验/删除     | 🟢   | 真下 59.7MB，Zip-Slip 38/38                                                                                                                                                                                                                                                                                                                                                                                                                |
|              | 模型管理页                       | 🟡   | 同上                                                                                                                                                                                                                                                                                                                                                                                                                                       |
|              | ~~**模型目录缺 4 个 ASR 模型**~~ | 🟢   | **B-1 已闭合**：`vendor/manifests/models-asr-support.json` 里 5 条全在（silero-vad-onnx / silero-vad-ggml / sherpa-streaming-zh-14m / paraformer-zh-small / ct-transformer-zh-en）。**此前标 🔴「缺 4 个」**                                                                                                                                                                                                                               |
| **两者共同** | **首启引导 `/onboarding`**       | 🟢   | **M-3 已闭合**：路由 `apps/web/src/routes.tsx:9,35` + `features/onboarding/{OnboardingPage.tsx,Onboarding.routes.tsx,state.ts}` 齐全，已接入首屏重定向。**此前标 🔴「新用户打开一片空白，没人告诉他要先装模型」**                                                                                                                                                                                                                          |

## 跨领域

| 项                                | 状态 | 说明                                                                                                                                                                                                             |
| --------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 端到端                            | 🟢   | **此前标 🔴，理由是 B-2 —— B-2 已闭合**（52 条路由全在，见文首）。前端"按面自动切换"的设计如期生效                                                                                                               |
| 设置页                            | 🟢   | 语言/主题/明文告知 ✅；**API Key 输入框也在**（`LlmSettingsSection.tsx:440` state、`:505` 输入框，provider 级）。**此前标 🟡 并把 API Key 输入框标 🔴（B-3）**                                                   |
| 任务中心                          | 🟢   | 数据源已从内存改为 `GET /api/jobs` + 内存进度覆盖：`apps/web/src/features/tasks/TasksDrawer.tsx:14`、`apps/web/src/lib/jobs/noteJobs.ts:16-25`。**此前标 🟡「只有内存态，刷新即空」（M-5）**                     |
| `/diagnostics` 安全模式页         | 🟢   | **M-8 已闭合**：`apps/web/src/routes.tsx:4,42` + `features/diagnostics/DiagnosticsPage.tsx`。**此前标 🔴**                                                                                                       |
| LLM 云 provider                   | 🔴   | **一次没跑过**（无 Key）                                                                                                                                                                                         |
| LLM 档 2 探测（Ollama/LM Studio） | 🟡   | 本机没装这两个，未真跑                                                                                                                                                                                           |
| i18n 中英双语                     | 🟢   | **剥注释后零内联中文**：`ModelsPage.tsx` 含中文 69 行、`RuntimePage.tsx` 46 行，**剥掉块注释 + 行注释 + JSX 注释后两者均为 0** —— 命中全在注释里。**此前标 🟡「models/runtime 页仍内联中文」，是典型的注释陷阱** |
| 桌面外壳 / 说话人分离 / 翻译字幕  | ✂️   | 已裁决不做                                                                                                                                                                                                       |

---

## 汇总：待补功能清单

### ✅ 真正还没做的（2026-08-06 复核后的**全部**剩余项）

1. **M-6 笔记删除 / 重命名 / 移动的 UI** —— 三个 hook 都写好了，**只差一个下拉菜单**。成本最低、收益最直接。
2. **mindmap 的 reduce 阶段语义去重** —— 从来没实现过；`generate.ts:18` 那条注释描述了一个不存在的阶段，
   顺手把注释也改掉。
3. **whisper.cpp 的 Vulkan / ROCm / Metal / CoreML 产物**（`backends.json` 全为零）——
   ADR-016 已停"自建 CI"，所以剩下的是**改口径**：`docs/00-CHARTER.md:24,27` 与 UI 里
   不能继续宣称"真 AMD 支持"。见 `D-11:15-18` 与 `R-06 §6` 第 4 条。
4. **把"可导入任意 HF GGUF"从对外话术里撤掉** —— `rest/models.ts:728-733` 对 `kind==='hf_repo'` 硬 501，
   而 ADR-004 里那句话仍无标注。见 `R-06 §6` 第 5 条。

### ⚠️ 需要真环境才能判、不算"没做"

RSS/HLS 全链路各跑一集 · 运行时/模型管理页在真浏览器点一遍（全仓无 playwright/puppeteer）·
LLM 云 provider（需真 Key）· LLM 档 2 探测（需装 Ollama/LM Studio）。

### 📝 此前的清单（保留原文对照 —— 15 条里 11 条已完成、1 条已裁决不做）

> **第一梯队** ~~1. B-2 daemon 业务端点~~ ✅ · ~~2. B-1 模型目录补 4 个 ASR 模型~~ ✅ ·
> ~~3. B-3 设置页 API Key 输入框~~ ✅ · ~~4. M-3 首启引导~~ ✅ · ~~5. M-4 转写段落编辑 UI~~ ✅
>
> **第二梯队** ~~6. TipTap 笔记编辑器~~ ✅ · ~~7. 笔记导出~~ ✅ · ~~8. 标签/星标/文件夹的写入路径~~ ✅ ·
> ~~9. M-2 拖拽上传 `onDrop`~~ ✅ · ~~10. F3 麦克风两端接线~~ ✅
>
> **第三梯队** ~~11. M-5 任务中心持久化~~ ✅ · ~~12. 向量检索 embedding 生成~~ **✂️ 已裁决 v1 不做** · 13. RSS/HLS 全链路 ⚠️（需真跑） · ~~14. `DirectHttpSource` 续传~~ ✅ · 15. M-6 ❗**仍缺** / ~~M-7~~ ✅ / ~~M-8~~ ✅

**待用户决策**：会员内容 cookie（安全，= `PENDING-USER-DECISIONS.md` C-1）·
~~mac/Win 二进制（GitHub remote）~~ ← **已解决**：remote 已有、CI 已真跑（见上面「要求 2.1 · mac/Windows 二进制」一行与 `ADR-015`）·
云 LLM Key
