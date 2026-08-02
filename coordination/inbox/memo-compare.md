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
