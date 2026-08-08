# memo-compare 回执

## [2026-08-03 03:05] T-072 DONE

交付: `/root/memo/docs/research/R-06-memo-ac-gap.md`

要点:

- **识别引擎两个可选的根因**：`apps/web/src/features/recorder/RecorderPage.tsx:49` 写死
  `useState<'paraformer'|'turbo'>`，非 manifest 驱动、值从不发给后端、`'turbo'` 在后端
  `EngineId` 三值联合里根本不存在；导入页 `CapturePage` 连引擎/模型/语言都没有。
  memo.ac 是本地 4 引擎 + 云端 4 家 = 8 条路径（forensics 原文核实）。
- **模型清单差距**：memo.ac ASR 模型条目 47（whisper 15 + sherpa 27 + parakeet 4 + funasr 1），
  我们 11。最大单点缺口是 sherpa 27→2，技术根因在 `paraformer.ts:257` 把 `modelConfig.paraformer`
  写死为单分支。
- **导航点不动已被 T-074（3bf3cfa）修掉**。git 全历史核实：`/settings` 从未被 `pending` 标记，
  用户感知的"设置也点不动"应归因于同 commit 修的握手竞态（满屏"未认证"）。
- 三列表 58 条：完全没做 18 · 做了但残 10 · 我们更好 15 · 相当/并列 9 · 章程明确不做 6。
- **纠正两处前人吹过头的结论**：① `POST /api/models/import` 的 `kind:'hf_repo'` 硬编码 501，
  "可导入任意 HF GGUF"不成立；② vulkan/rocm 后端包全是 llama.cpp，whisper.cpp 只有 cpu×2+cuda-win×1，
  "真 AMD 支持"目前**只覆盖 LLM 不覆盖 ASR**。站得住的是量化选择与显存 fit 预检（均已实测）。

下一步建议:

1. 引擎/模型选择器改 catalog 驱动，从 RecorderPage 提到导入页 + 设置页（数据源 `/api/models/catalog` 现成）。
2. 补 sherpa 离线分支 + SenseVoice 进目录 —— 中文体验最大缺口，成本最低。
3. 接通 `RecorderPage` ↔ `/ws/recorder`（后端是真的，前端是 mock，F3 端到端从未跑通）。

需要 Manager 决策:

- **FEATURE-COVERAGE.md 需大改**：B-1/B-2/B-3 三个"交付阻塞"实测全部已解（daemon 实有 42 条 REST + 2 条 WS，
  非 6 条）；另 5 处标 🔴 的实际已实现（拖拽/标签写入/导出/TipTap/onboarding）。
  同时要新增两条它没有的：N-1 前端引擎选择器与后端脱节、N-2 F3 端到端未跑通（矩阵标 🟢 属偏乐观）。
- **对外话术需修正**："真 AMD 支持"与"可导入任意 HF GGUF"两条目前不成立，是继续投入实现，还是改口径。
- 未派生任何 subagent 保留（两个 Explore 均为一次性事实提取，已完成）。

诚实声明:

- 全程只读 demo 实例（仅 GET），未写未重启。审计期间该实例被其他 agent 重启过一次
  （pid 2066756 → 2075454，绑定由 0.0.0.0 变回 127.0.0.1），非我所为。
- **未在真浏览器点击验证任何页面**，结论基于只读 API + 读源码 + 读 git 历史。
- memo.ac 为闭源专有代码，本次只提取事实性标识符与计数，**未复制其任何源码进本仓库**。
- 引用的 memo.ac GitHub issue 编号沿用 R-01，**本次未复核**，已在报告中标 [R1]。

## [2026-08-03 04:10] T-080 DONE

交付: `docs/research/R-06-memo-ac-gap.md`（新增文末「附录 A」，未改动原有内容）

要点:

- **① 空间管理 = Workspace，一等公民，且与磁盘目录绑定**。表 `workspace{id,name,folder(磁盘路径,NOT NULL),
icon,thumbnail,backgroundColor,description}`；`folder.workspaceId` / `resource.workspaceId` / `doc.workspaceId`
  三条 FK。设置弹窗 12 个 tab 里独占第 2 个。新建表单 = 名称 + **存储文件夹** + 背景色 + 描述。
  切换器显示该目录已用体积；删除时 `deleteFolder:true` **连磁盘目录一起删**。数量无上限，保底恒 ≥1。
  **两种含义是同一件事**：逻辑分区 ×（每空间独立存储根）。另有一套独立的纯磁盘管理面（模型/配置/临时目录）。
- **② 代理 = `none`/`system`/`custom` 三态**；custom 是**可切换的多条目列表**，条目只有
  `{hostname,port,type,active}`。**无认证、无 bypass/no_proxy**（NOT FOUND）。system 模式用
  `session.resolveProxy("https://www.google.com")` —— 探测目标对其主要受众（被墙用户）本身不可达，
  这是可直接避开的设计缺陷。作用链路：yt-dlp（argv `--proxy` + `--socket-timeout 60`）+ 自身 HTTP agent；
  **`session.setProxy` / `--proxy-server` 均 NOT FOUND**，ffmpeg 等其他子进程也没注入。
  「测试连接」测的是**下载源域名延迟**，不是代理本身。
- **③ 云 LLM：memo.ac 没有为任何一家装 SDK**。`nm.txt` 417 个包 + `app_package.json` 29 个依赖里，
  只有 `ai`/`@ai-sdk/{react,provider,provider-utils,gateway}`/`openai`/`langchain`/`@langchain/{core,openai,mistralai}`；
  **`@ai-sdk/anthropic|google|deepseek` 等一个都没有**。→ ~31 家全靠 OpenAI 兼容客户端 + 每家 `baseURL`。
  两份并存且不相等的供应商名单（枚举 24 + 服务注册表 24，并集约 31），含 `custom`「Custom Service」。
  描述符 schema 含 **`configFields`**（表单数据驱动）与 **`modelListSource`**（模型下拉自动填充），
  远端 `model.memo.ac/llm-models/manifest.json` + sha256 + 可热更新。

下一步建议:

1. **先问用户**「空间管理」要哪一层：逻辑分区（低成本，`folders` 已有 parent_id/color/icon，加一表一列即可，
   `notes` 经 `folder_id` 间接归属、不用动）还是**每空间独立磁盘根**（要改 daemon 的 `resolvePaths` 全局单例，
   工作量在这里）。**别替他选。**
2. 代理：`packages/pipeline/src/subprocess/proxy.ts` 质量已超竞品（socks 全系 + 强制 loopback bypass +
   argv 注入防护 + 凭据脱敏 + ffmpeg 不支持 SOCKS 如实告警）。缺的是 **daemon/downloader 接线 + 持久化 + 设置 UI**。
   「测试连接」不用新做，`POST /api/models/sources/probe` 形态已经和它一致，接上代理即可。
3. 云 LLM：架构不用改。把硬编码供应商清单改成 JSON 注册表，字段对齐 `configFields`/`modelListSource`；
   **建议注册表进 git 仓库而非远端拉取**（章程是 local-first，不宜新增云依赖）。

需要 Manager 决策:

- **用户指令 3 触发一次连锁删除**：砍掉本地 LLM ⇒ `models-llm.json` 5 个 GGUF + llama.cpp 后端包 4 个失去用途。
  而 vulkan/rocm 后端包**只属于 llama.cpp** —— 删掉后「真 AMD 支持」将彻底不成立（whisper.cpp 侧本就只有
  cpu×2 + cuda-win×1）。**这是删除决策 + 对外话术更正，两件事都要你拍板。**
- ADR-006 决策 4（不引入 workspace 层）：竞品有、且是一等公民。事实已给出，成本拆成两层也已给出，请你裁决。

诚实声明:

- 三条结论均由我本人从 forensics 原文复核（表结构 / 渲染层逻辑 / IPC handler / package.json + nm.txt 双源）。
- 明确标 NOT FOUND 的：代理认证、代理 bypass、`session.setProxy`、`--proxy-server`、非 yt-dlp 子进程的代理注入。
- 明确标**未核实**的：`note` 表是否由 migration 补 `workspaceId`；代理是否作用于云 API 调用；
  memo.ac 的 Key 存储方式；非 OpenAI 家能否改 baseURL（R-01 引的 issue #353/#359 本次未复核，
  且与实测「`baseURL` 字段人人都有」相矛盾，**请勿当事实引用**）；甲/乙两份供应商名单的分工。
- 未写任何仓库外文件，未复制 memo.ac 源码进本仓库，未碰运行中的 demo 实例。

## [2026-08-03 04:40] T-080 UPDATE（自我更正）

交付: `docs/research/R-06-memo-ac-gap.md` 附录 A-2 已修订

**我在 04:10 那份回执里有一条写错了，现更正：**

- ❌ 我写的：「『测试连接』测的是下载源域名延迟，不是代理本身」
- ✅ 实际：**是两个独立的测试**。代理有**专属**的 `test-proxy` —— 用当前代理 agent 请求
  `https://youtube.com`、测往返延迟、把毫秒数回显；下载源那张域名延迟表是**另一个** IPC
  （`test-domain` / `get-domain-test-result`，三个镜像域名，ping 不通则 HTTP HEAD，5000 ms 超时）。
  → 影响 `model-mgmt` / `gpu-runtime`：**要做两个按钮，不是一个**。前者答「我的代理通不通」，
  后者答「哪个镜像最快」。混成一个用户没法定位问题。

**另外三条补充（都是我初版没查到、深挖后确认的）**：

1. **出厂默认是 `{type:"system"}`**（跟随系统代理），不是 `none`。这个默认值值得抄。
2. **代理确实作用于云 LLM / 云 ASR / 模型下载 / 授权校验 / RSS / GitHub 版本检查**（约 37 处 agent 注入点）。
   我初版把这条标了「未核实」，现已核实为「是」。→ **我们 daemon/downloader 侧零接线这件事，
   比我原先说的更严重：这是它覆盖到而我们没覆盖的链路。**
3. **它有一条硬编码 bypass，但只护 LLM 端点**（`localhost`/`127.0.0.1`/`0.0.0.0`/`::1`/`[::1]`/`*.local`），
   其余链路无保护。我们的 `proxy.ts` 是**无条件全链路**强制 loopback bypass，这一项我们仍然更强，
   但我初版写「它没有 bypass」过于绝对，已改为准确表述。

**协议细节更正**：它的 UI 只有 `http` 与 `socks5` **两个 tab**；底层库支持 socks4/4a/5h 但无入口。
我初版笼统写「SOCKS 系」，已改准。

**给下游的三条可直接抄**：① 默认 `system`；② yt-dlp 附 `--socket-timeout 60`（代理慢时不挂死）；
③ 代理测试与下载源测试分开两个按钮。

诚实声明: 本次更正来自我派出的 subagent 的深挖，其结论我逐条与自己的 grep 交叉验证过。
有一处不一致已在文档里注明：subagent 称主进程 bundle 里 `HTTPS_PROXY` 0 命中，我实测 2 命中
（两处均在第三方库内部，读 `process.env`）——**以我的直接 grep 为准**，两者方向一致：它不靠 env 传代理。
LLM 侧的 subagent 仍在跑，其结论若与 A-3 冲突我会再发一次更正。

## [2026-08-03 05:15] T-080 UPDATE 2（推翻我自己的一条核心结论）

交付: `docs/research/R-06-memo-ac-gap.md` 附录 A-3 已重写

**🛑 我在 04:10 回执里给你的第 ③ 条是错的，现推翻。**

- ❌ 我写的：「**memo.ac 没有为任何一家 LLM 装 SDK**，~31 家全靠一个 OpenAI 兼容客户端 + 每家一个 baseURL」，
  还标了「高置信，独立双源核实」。
- ✅ 实际：**混合制**。我在 12 MB 主进程 bundle 里直接 grep 计数：
  `/v1/messages` **28** 处、`x-api-key` **11** 处、`api.anthropic.com` **7** 处、`ChatAnthropic` **5** 处、
  `generativelanguage.googleapis.com` **5** 处、`ChatGoogleGenerativeAI` **4** 处、`ChatOllama` **2**、
  `ChatMistralAI` / `@anthropic-ai/sdk` / `@google/genai` 各 **1**。
  → **Claude / Gemini / Mistral / Ollama 四家有原生客户端**；其余约 20 家（DeepSeek/xAI/智谱/Groq/Together/
  通义/豆包/MiniMax/千帆/SiliconCloud/OpenRouter/LM Studio…，`ChatDeepSeek`/`ChatXAI`/`ChatGroq` 等均 0 命中）
  才是走 OpenAI 兼容 + baseURL。

**错因（方法论，请记下来）**：我查了 `app_package.json` 与 `nm.txt` 两处都没有 `@ai-sdk/<厂商>`，就断定没装。
但这两处**不是独立双源** —— 它们量的是同一件事：**以独立目录形式随包分发的依赖**。
纯 JS 库会被打包器内联进 `dist-electron/main/index-*.js`，从两处同时消失；只有原生模块才留在 `nm.txt`。
**「两处都查不到」对纯 JS 库不构成证据。我把"没看见"当成了"不存在"。**

**对我们的实际影响（比我上一版给的更贵）**：

- `openai-compatible.ts` 方向没错，覆盖约 20/24。
- **但 Claude 与 Gemini 覆盖不了，必须各写一个原生适配器**
  （Anthropic Messages `/v1/messages` + `x-api-key` + `anthropic-version` 头；Gemini 的 generativelanguage 端点）。
  这两家是最主流的两家。**上一版我说"缺的只是清单与 UI"，低估了工作量，请以此版为准。**

**同批次另外四条已核实的（原标未核实）**：

1. **Key 存储**：memo.ac 是**明文 JSON**（`conf/setting.conf`），全 bundle `safeStorage` **0 命中**；
   唯一的 AES-256-CBC 用**硬编码静态密钥+IV**，且只加密 Notion secret，**LLM key 不经过它**。
   → 双方实质都是明文落盘，**差别是我们明确告知用户（ADR-006 强制 disclosure），它不说**。
   它那把静态密钥 AES 是安全剧场，**别抄**。
2. **推翻 R-01 一条**：「只有 OpenAI 能配自定义 base URL」**不成立** —— 24 家里 **22 家**的 `configFields`
   都有可编辑 `baseURL`；例外只有 Mistral（走原生 SDK 无此字段）与 Azure（必填无默认 + 需 deploymentId/apiVersion）。
3. **每功能独立选模型**：chat / (摘要+导图) / 翻译**各自一套** provider+model。我们只有全局一处，值得跟进。
4. `configFields` 键全集只有 7 个（apiKey/model/baseURL/temperature/maxTokens/deploymentId/apiVersion）；
   `modelListSource` 三模式（official-doc 人工策展带 checkedAt / official-api 打厂商 /models / local-api 打本地）。
   ⚠️ 它的表单 label/help **硬编码英文（部分中文）不走 i18n**，这是缺陷，我们做注册表时应存 i18n key。

需要 Manager 决策: 无新增（A-3.5 第 4 条的本地 LLM 删除决策仍待你拍板）。

诚实声明: 本次推翻由我派出的 LLM subagent 发现线索，**结论中的每一个命中数都是我自己重跑 grep 确认的**，非转述。
两个 subagent 均已完成，我停不掉它们（归属限制），但已无待办。

## [2026-08-03 14:20] T-113 DONE

交付:

- `docs/research/assets/memoac-llm-providers.json`（24 家 / 520 条模型 / 255 KB）
- `docs/research/assets/memoac-asr-models.json`（whisper 15 条 + 三个越界引擎 + UI 呈现方案 / 36 KB）
- `docs/research/R-06-memo-ac-gap.md` 新增「附录 B」（未动前文）

要点:

- **LLM 24 家 / 520 条内置模型**。默认选中 = **`openai` / `gpt-5.4-mini`**，
  **但主进程默认设置对象里根本没有 LLM 供应商键 —— memo.ac 出厂状态没有任何可用 LLM**，
  `openai` 只是下拉初始高亮。照抄时要连这个诚实的空状态一起抄。
- **不像一堵墙的关键是三桶分组**：`configured` / `mainstreamUnconfigured` / `more`，
  置顶名单硬编码为 `["openai","claude","gemini","deepseek","ollama","lmstudio"]` 六家，其余十几家收进 `more`。
- kind 分布：`openai-compatible` **19** · anthropic-native 1(claude) · google-native 1(gemini) ·
  mistral-native 1 · ollama-native 1 · anthropic-compatible 1(kimicodingplan)。
  **24 家里 23 家 `baseURL` 可编辑**（唯一无该字段的是 mistralai；azura 必填无默认 + 需 deploymentId/apiVersion）。
- 模型条目最多：千帆 82 · 通义 70 · siliconcloud 66 · azura 35 · openai/openrouter 各 30。
  `modelListSource` 三模式：official-doc（人工策展带 checkedAt）/ official-api（打厂商 /models）/ local-api。
- **ASR 呈现方案才是重点**：它的转写设置里是**双轴筛选卡片**（`lang` Select × `speedValue` Tabs），
  任一时刻只显示 1～3 张卡而不是 15 行；每档配一句代价提示文案。

**发现一处真实的 schema 缺口（这才是我们和 memo「对不上」的根因之一）**:
我们 25 条 / 12 组，比它 15 条**长 67%**，还多一个量化维度 —— 它那套平铺我们照抄只会更糟。
而要做双轴，**我们少一根轴**：`languages` 有，但**没有速度档**。
我们的 `quantTier`（实测取值 `small`/`balanced`/`full`/`large`）是**量化体积轴，不是速度轴** ——
tiny-f16 和 large-v3-f16 都落进「full」，可两者速度差几十倍。
→ 建议给 manifest 加 `speedTier: fast|balance|quality`（按模型族定），**与 quantTier 并存**。

下一步建议:

1. `model-mgmt`：加 `speedTier` 字段（12 组各定一次，工作量很小），然后按附录 B-2.3 的三层结构改下拉——
   卡片=groupId（双轴筛选）→ 量化=卡内分段控件 → fit/下载状态画在卡上。
2. `architect`：LLM 下拉直接照三桶分组 + 六家置顶实现，JSON 里 `_meta.dropdownGrouping` 有完整判据。
3. `ui-polish`：`icon` 是字符串 id（24 家都有），但**品牌色注册表里没有**，需自定，别说是抄的。

需要 Manager 决策:

- **模型 id 的时效性**：JSON 里的 520 条是 memo.ac 的人工策展快照（`checkedAt` 多为 2026-05-31）。
  是直接照搬它的清单（快，但可能已过时/与厂商不符），还是只抄结构、清单走 `official-api` 动态拉取？
  我倾向后者对主流几家用动态拉取，但这会引入出网依赖，**归你裁决**。

诚实声明:

- 24 家供应商对象**全部由程序逐层展开压缩变量后解析，24/24 成功 0 失败**，520 条为程序化统计非人工计数。
  取证方法写进了 JSON 的 `_meta.evidence`——因为我上次犯过"把没看见当成不存在"的错，这次把路径留痕。
- **品牌色 NOT FOUND**（明确查过 24 家全部字段，无 color/brandColor/theme）。
- **未核实**：`icon` 字符串 id 映射到哪个图标包的哪个图形；甲/乙两份旧名单与本次 registry 的分工差异。
- 两份 JSON 均为**事实性数据目录**（id/端点/模型名/体积/分组轴），非 memo.ac 源码，文件头 `_meta` 已注明。

## [2026-08-08 00:06] T-171 DONE（用户亲自点名：重解 memo 包、对齐功能点与实现）

交付:

- `docs/research/memoac/GPU-BACKENDS.md` —— ★ 当年那个「未验证」项的答案
- `docs/research/memoac/F1-F5-PARITY.md` —— ★ F1–F5 + 2.1/2.2 双层对照 + 差距清单（按性价比排序）
- `docs/research/memoac/README.md` + `{ipc-channels,settings-schema,feature-list,asr-engines,export-formats}.txt`
  - `win-package-listing.txt` —— 取证台账落盘（当年在 `/tmp/memoac/`，已随重启消失）

要点:

- **Windows 包解开了（`apt-get install p7zip-full` 即可，当年就是缺这个），R-01 的结论是错的**：
  memo.ac 在 Windows 上有**第三个 GPU 后端 —— DirectCompute（D3D11）**，
  `addon/whisper/bin/gpu/{main.exe,Whisper.dll}`，PE 导入表实测 `d3d11.dll`+`dxgi.dll`，
  版本资源写着 `DirectCompute port of whisper.cpp library`（Const-me/Whisper 自建分支，
  PDB 路径泄露分支名 `em2er-whisper`）。**D3D11 厂商中立 → 它的 "AMD GPU Acceleration" 宣传是真的**，
  R-01 判其「夸大宣传」应撤回。**没有 Vulkan / DirectML / ROCm。** macOS 侧 R-01 正确（Metal/CoreML/CPU）。
- **R-01 的错因已定位**：它引的 `["cpu","cuda"]` 是 **FunASR 的 device 列表**，不是全 app 的后端枚举。
  真正的调度是 `m0r()`：win32 + `windowsWhisperMode` ∈ {CPU, GPU(=DirectCompute), cuBLAS}；界面是三按钮，默认 CPU。
- **最值得做的第一条不是"追竞品"，是"我们自己编好了没发给用户"**：CI run 31155359839
  合并出 **9 个 whisper 包，仓库 backends.json 只有 5**。漏的含 `whispercpp-vulkan-win-x64`
  （产物 23 MB 未过期，`sizeBytes`/`sha256` 都已生成，**只差 `mirrors` 没传 release**）。
  → **Windows 非 N 卡用户零 GPU 加速，而章程 §3 明确要求「Windows + AMD → Vulkan/DirectML」。这是章程未达标项。**
- **F4 的差距方向和直觉相反**：memo.ac 是 markmap（Markdown→SVG）**节点不可编辑**、导出走 `html2canvas` 位图；
  我们是 mind-elixir **节点级可编辑** + 矢量 SVG。**但我们服务端 4 种导图导出（md/opml/mm/json）
  在界面上一个入口都没有** —— 全仓 `what=mindmap` 只命中 1 个测试注释 + 1 个 README。写了、测了、点不到。
- **纠正 R-06 一条**：「memo.ac 有标签系统」是**过度纠正**。表是有，但 **0 个 tag IPC 通道**，
  locale 里 5 个 tag 键全是「AI 摘要输出关键词」的字段名 → 它没有可用的笔记标签功能，**我们有**。

下一步建议:

1. **传 `whispercpp-vulkan-win-x64` 到 backend-packs release 并补 manifest 的 `mirrors`**（照
   `whispercpp-vulkan-linux-x64` 已填好的那条抄）—— 代价最低、唯一能补上章程未达标项的一条。
2. 接通思维导图的 4 种结构化导出入口（`ExportMenu` 加 `what=mindmap`）+ 接通搜索结果的 `?t=` 跳时间点 —— 两条都是纯前端接线。
3. macOS 的 Metal 包重贴标签（现在 Metal 其实在跑，但包标成 `backend:"cpu"`，界面永远说不出"你在用 Metal"）。

需要 Manager 决策:

1. **传 release 需要授权** —— 本轮纪律禁止我建/改 release，gap 1 的最后一步卡在这里。请指派或授权。
2. **空间 / Workspace 到底做不做、做哪一层**（逻辑分区 = 低成本；每空间独立磁盘根 = 要改 daemon 路径解析全局单例）。
   ADR-006 决定不做，R-06 请求裁决，**至今无人回答**。这条卡在决策不卡在实现，**我不替你选**。
3. **「跑基准」按钮**：先隐藏还是真做？现在它打的是永久 501 且该页不渲染 error，点了静默失败。
4. Linux CUDA 包（缺 `libcudart` 随包分发）维持现状的话，**对外口径要改** —— 这条 R-06 提过，仍未做。

诚实声明:

- **未运行 memo.ac 的任何二进制、未注册账号、未向其发送任何数据**；全部为静态取证
  （解包 / 读配置 / 自写 Python 解析 PE 导入表与 asar）。
- **未改动任何产品代码**；未碰 `:10000`、`/root/data-memo`、`~/.local/share/openmemo/datadir.json`；
  未跑任何构建；未建/改/删 release；未用 `pkill`。
- 我方所有「有」均由我本人或我派出的审计 agent 落到 file:line；**我本人复核了 F4 全链路**
  （mind-elixir 版本、editable 配置、export.ts、`what=mindmap` 零调用）与 GPU 全链路。
- **未在真浏览器点击验证任何页面**；**gap 1 的「传完 release 后 Windows AMD 真能用」未在真 AMD 硬件上验证**
  —— 与章程 §3 的 Windows+NVIDIA 那格同理，这台机器结构上验不了。
- 标 `[报告]` 的（Workspace 一等公民、代理 37 处注入点、9 张表、静态密钥 AES）引自 R-06，本轮未复核。
- `UNKNOWN`：memo.ac 的回收站/星标行为、Pro 额度数值与单位、`enableCoreML` 由谁置位、
  preload API 面（`window.AIM.*` 是 V8 字节码 `index.jsc`，未反编译）。
- **未把 memo.ac 的可执行文件、模型或任何受版权资源提交进仓库**；`docs/research/memoac/` 全部为文本事实台账。
- **WebSearch 本轮对我同样不可用**，但错误与当年不同：`400 output_config.effort 'xhigh' is not supported
when thinking is disabled`（配置错误，非网络）。`curl` / `gh` / 二进制取证均正常。

派生 subagent 记录（未 kill，可复用）:

- `abc7951ebc7336551` (Explore) — 我方 F1–F5 + 2.1/2.2 实现真伪审计（含"写了但触发不了"清单）
- `a14a443fdd54ce997` (general-purpose) — memo.ac 功能/IPC/设置/引擎/导出五份台账
- `aa4dac81d158e2a16` (general-purpose) — 我方 backends/模型/LLM/导出/接口/设置/组织 八项清点

## [2026-08-08 22:41] T-180 DONE（功能对齐点复核：加第三层判据「用户能不能走到」）

交付: `docs/research/memoac/F1-F5-PARITY.md` **就地订正**（按 §13：裁完回去改原文，不另挂警告）
—— 新增文首「已过期」对照块、新增 §2.5 第三层判据、TL;DR 整块重写、§4 差距清单按后果重排、
8 处行内过期标记就地更新。**memo.ac 侧未重新解包**（`docs/research/memoac/` 取证材料仍有效）。

### 与「完成度审计」那位的边界
**我管「和 memo 比怎么样」，他管「照章程做完了没有」。** 同一处缺陷两边都可能出现，
但判据不同：我只在**竞品对照**里给它位置（它有/我们有/差在哪 + 用户走不走得到），
**不判定章程条目是否闭合**。冲突以他的为准。

要点（我本人在代码/产物里复核，**未引用任何回执**）:
- **变好，5 条**：① gap 1 Windows 非 N 卡零 GPU 加速**已闭** ——
  `backends.json` 有 `whispercpp-vulkan-win-x64`(`backend=vulkan`,`mirrors=1`)，
  **v0.3.0 release 里真有那个 23 MB 的 zip**；whisper 包 5→**7**，
  `whispercpp-metal-macos-arm64` 已单独成包且**正确标 `backend=metal`**（不再是假 `cpu` 标签）。
  ② 导图 4 种结构化导出**已闭**（`MindmapExportMenu.tsx:49` 且**真被渲染**于 `MindmapView.tsx:176`）。
  ③ 搜索 `?t=` **已闭**（`NoteDetailPage.tsx:139` → `requestSeek`，带 `(noteUid,t)` 闩）。
  ④ 代理**已闭**（`ytdlp.ts` argv + 子进程 env 双路，覆盖 memo.ac 漏掉的 ffmpeg）。
  ⑤ 笔记改名/删除已接线（`NoteActionsMenu` 渲染于 `NoteDetailPage.tsx:196`）。
- **变坏 / 被真机推翻，3 条**：① **要求 2.1 我上一轮判的「我们全面强于 memo.ac」不再成立** ——
  设计仍远强，但**健壮性它赢**（详见下条）。② **gap 5「测速」仍是永久 501 且不渲染错误**
  （`models.ts:282` + `ModelDetailPage.tsx:187` `void mutateAsync`）——
  **我 08-07 就点名了，没修，现在成了用户报的三条故障之一**。
  ③ 软删已正确 404，但**全 daemon 零 restore 路径** → **删除现在不可逆**，后果比首版更重。
- **第三层判据带来的唯一结构性发现**：**它把引擎装在盒子里，我们发的是一个安装器。**
  `[实测]` memo.ac 的 `resources/addon/whisper/bin/1.8.6/` 直接躺着 whisper-cli + dll（CPU 版），
  `bin/gpu/` 躺着 DirectCompute 版；我们 v0.3.0 **刻意不打包 whisper.cpp**
  （`build-bundle.mjs:10`）。→ 新用户到第一次转写：**它 1 个可失败环节，我们 2 个**，
  而 08-08 真机上那两个都塌了。**我们赢在能力上限，它赢在下限；用户第一次打开看到的是下限。**
- **不再是差距**：多工作区（用户 08-08 裁定不做）；「yt-dlp 非出厂自带」
  （`build-bundle.mjs:10-15` 写明是**主动规避 GPL-3.0 传染**，是决策不是遗漏）。

下一步建议（差距清单已按**用户可感知后果**重排，不按工作量）:
1. **G2「测速」静默失败 —— 立刻做，代价极低**（隐藏/禁用并注明未实现，或把 501 的 message 渲染出来）。
   判据不是"要不要做 benchmark"，是**"不许静默失败"**。这是唯一一条我上轮点名、代价极低、却因没人做而变成真机故障的。
2. **G3 删除不可逆** —— 加 `?deleted=1` 列表 + 把 `deleted_at` 置 NULL 的端点。代价低。
3. **G5 文件夹改不了名、笔记移不进文件夹** —— `useRenameFolderMutation`/`useMoveNoteMutation` 两条都写好了、**都零调用者**，接线即可。

需要 Manager 决策:
1. **G1：要不要把 CPU 基线包随包出厂**（Linux 6 MB / macOS 1 MB / Win 3 MB），
   把"能失败的环节"从 2 个降回 1 个。**许可证上与 ffmpeg/yt-dlp 不同 —— whisper.cpp 是 MIT，不触发 GPL 传染**，
   所以不打包它的理由只剩体积。这动的是 ADR 级分发策略，**我不替你选**；
   我的倾向是**做**，理由是本轮教训正是"下限决定第一印象"。
2. **Linux CUDA 维持现状的话，对外口径要改** —— R-06 提过、我 08-07 提过，**仍未做**，属 §13 那一类。

诚实声明:
- **只读审计，未改任何产品代码**；未碰 `:10000`、`/root/data-memo`、机器级指针；未跑构建；
  未建/改/删 release；未用 `pkill`。本次只改了我自己的两份交付物。
- 上面每条「已闭/未闭」**都是我本人 grep/读码/`gh release view` 核到的**，**未引用任何 agent 回执**。
- `[报告]`（非我所验）：三条真机故障的**修复状态**属 `probe-bootstrap` / `e2e-coldstart` / `e2e-browser` 三路的成果。
  我只验到「`build-bundle.mjs:763-773` 缺探针即 `die()`」这一行**代码存在**，
  **没有验证产品在真机上的运行时行为** —— Manager 称三路尚无结论，我不替他们宣布闭合。
  另：`e2e-coldstart` 最新 run 31262257036 为绿，但**该路自己在 `f5a93dd` 里申报过"被打断会假绿"**，故不作为证据。
- `[未验证]`：Windows CUDA 需真 N 卡、真 GPU 加速需真硬件 —— **托管 runner 结构上答不了**，不写成"没做"。
- `UNKNOWN`：memo.ac 的回收站/星标行为、Pro 额度数值与单位（沿用上轮，本轮未追）。
- 本轮**未派生 subagent**（复核范围明确，且四路在场，避免撞车）。
