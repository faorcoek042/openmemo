# inbox — architect

## [2026-08-02 14:05] T-010 DONE

交付:
- `/root/memo/docs/design/D-01-architecture.md` （id: D-01，status: draft）
- `/root/memo/docs/design/D-02-data-model.md` （id: D-02，status: draft）

要点:
- D-01 覆盖：组件图 / 进程与生命周期（端口 17650 + 端口即单实例锁 + token 走 URL fragment 换 HttpOnly cookie + 优雅退出 + 崩溃恢复 + 安全模式）/ API 四通道分层（REST · **全局单 SSE** · WS · 独立 `/media` 字节流）/ 任务队列（Job-Step-**Chunk** 三层，chunk 边界 = 抢占点 = 续跑点 = 进度点）/ F1–F5 五张 mermaid 时序图 / 四个适配层 / 降级矩阵 + 熔断 / 安全（含 **7 层命令注入防护**）。
- D-02 覆盖：完整 DDL（**26 张普通表 + 4 张虚拟表**）/ 库无关 `MindMapDoc`（map-of-nodes + `extensions` 沙箱 + 损失矩阵 + MD/OPML/FreeMind 导出）/ F5 联动的**三层引用**（时间权威 + quote 重定位 + segment_id 仅缓存，**重转写后链接不失效**）/ FTS5+libsimple+sqlite-vec+RRF 混合检索 / 迁移策略 / 三 OS 存储布局。
- **我只写了这两份文档，未写任何代码**（遵守 BOARD 文件所有权表）。
- 派生了 2 个 sonnet subagent（均已完成，可复用）：`a87e28047aee41606`（forensics 挖掘）、`a1d3c731e8b1b2ec0`（上游 API 核实）。

已核实并**订正上游文档**的 3 处（重要）:
1. **npm 包名是 `mind-elixir`（v5.14.0），不是 `mind-elixir-core`** —— 后者是 GitHub 仓库名，npm 上 **404**。ADR-002 决策 3、R-03 §D7、BOARD 均写作 `mind-elixir-core`，**请 Manager 决定是否订正 ADR-002 措辞**；无论如何 T-011 写 `package.json` 时必须用 `mind-elixir`。（另：`MindElixirData` **没有 `linkData` 字段**，自由连线只有 `arrows`。）
2. **R-01 §A2.5 判定 memo.ac「无标签系统」有误** —— 本次从 `app.asar` 逆向出的 knex schema 里 `tag` / `note_tag` / `doc_tag` **三张表确实存在**（可能 UI 未开放）。不影响我们的设计（我们照样做标签），但 R-01 该条结论建议标注订正。
3. **R-01 §A2.5 的「7 个 migration 文件 [BIN]」在 `app.asar` 中无法复现** —— 全量 grep `note_mp3_path` 零命中，asar 内无应用层 migration 文件。疑似该证据来自其 GitHub 源码仓库而非打包产物，**证据等级标签 `[BIN]` 可能不准**。（memo.ac 实际是运行时 `hasTable→createTable` 幂等建表，**无 `PRAGMA user_version`**，无 schema 版本机制。）

下一步建议:
1. Wave 3 开工前必须先做 3 个 spike：① `better-sqlite3` v13 的 bundled SQLite 能否 `loadExtension` 加载 libsimple/sqlite-vec（R-03 §U-5 已列，**决定 §4 全部检索方案是否降级**）；② 浏览器 WebGPU(transformers.js) 转写是否真能用（决定 L0 档存废）；③ Vulkan vs CUDA 的 whisper 实测（ADR-003 决策 3 明说是临时立场）。
2. D-01/D-02 目前是 `draft`。建议在 T-011 把 `0001_init.sql` **实测跑通**、T-013 的 D-03 契约定稿后，我再做一轮收敛并转 `ready`。
3. `packages/mindmap` 在 BOARD 的文件所有权表里**无 owner**，但 D-02 §2 的类型与转换器需要有人写 —— 建议 Wave 3 的 T-023 认领。

需要 Manager 决策:
1. **API Key / secrets 存储方式**。选项 A：SQLite `secrets` 表明文 + 文件 0600/目录 0700 + UI 明确告知"未加密"（零依赖，v1 默认）；选项 B：OS keychain（macOS Security / Windows DPAPI / libsecret）—— 但 `keytar` 已归档无维护，需自己写或找替代原生依赖，**跨平台成本不低且与"无 Electron"的 web-first 架构不太合拍**。我倾向 A + schema 已预留 `enc` 字段可平滑升级。
2. **默认端口拍板**。我提议 **17650**（已确认在 Linux/Windows/macOS 三家的临时端口段之外，且不撞 3000/5173/8080/11434/1234/9588）。端口一旦定下需同步给 T-011（快捷方式壳）、T-013（前端 baseURL）。**注意：端口稳定不是美观问题——浏览器的麦克风授权按 origin 隔离，端口变了 F3 每次都要重新授权。**
3. **`/ws/asr-worker`（浏览器 WebGPU 作为 ASR worker）的协议归谁写**。它跨了 T-013 的 `packages/shared` 契约边界（T-013 的任务书是 REST/SSE 契约）。建议：契约仍归 T-013 落在 shared 里，实现归 Wave 3 的 T-020/T-021。若 Manager 认为 L0 档不值得做，请明说 —— 我会把它从 D-01 §6.1 降级为"可选实验特性"。
4. **是否引入 workspace 层级**。memo.ac 有（为共用电脑设计），我**建议不引入**，只做 `folders` 自引用树。个人自用场景多一层导航的成本大于收益，且日后加 workspace 只是给现有表加一列 + 一次迁移，代价可控。
5. **对外 ULID `uid` + 对内整数 PK 的双 ID 约定需 T-013 认可**。这不是洁癖：FTS5 外部内容表的 `content_rowid` 与 sqlite-vec 的 rowid 关联**都要求整数**，不这么做检索方案接不上。API 只暴露 `uid`。请 Manager 转达给 T-013 以免 D-03 与 D-02 冲突。
6. **翻译 / 双语字幕 / 字幕导出是否进 v1**。章程 F1–F5 未包含，但 memo.ac 有 30 个相关 IPC 通道，是其主打卖点之一。D-02 已预留 `segment_translations` 表（不启用则可从 `0001_init.sql` 移除）。请裁决。
7. **Node 版本基线 = 22**（次要，但需尽快同步给 T-011/T-012）。`better-sqlite3` v13.0.2 的 `engines.node` 硬性要求 `>= 22`（已核实 package.json）。若 T-011 已按更低版本建骨架，需要改。
8. **ADR-002 措辞是否订正**（见上文"已核实并订正上游文档"第 1 条）。这是事实性订正，不推翻 ADR-002 的任何决策实质。

诚实声明:
- D-01/D-02 中**没有任何一行代码被执行过**，所有 DDL、时序图、接口签名均为设计意图。文中已逐条标注 `[已定]/[设计]/[待核实]/UNKNOWN`，两份文档各自末尾有独立的"待验证清单"（D-01 §10 共 9 条，D-02 §7 共 11 条）。
- 未编造任何 API、版本号或性能数字。所有版本号（`mind-elixir` 5.14.0、`markmap-lib` 0.18.12、`sqlite-vec` v0.1.9、`libsimple` v0.7.1、`better-sqlite3` 13.0.2）均由 subagent 于 2026-08-02 直接从 npm registry / GitHub API / 上游源码取得。
- 未修改任何他人的交付物；未创建 ADR；`/root/memo-forensics/` 只读引用，未复制其源码进本仓库。

---

## [2026-08-02 16:20] T-015 DONE

交付:
- `/root/memo/docs/design/D-05-frontend.md` （id: D-05，status: draft，约 900 行）
- 附带订正 `/root/memo/docs/design/D-01-architecture.md`（我独占，见下"订正批次"）

要点:
- D-05 覆盖你要求的 7 项：IA 与路由表（18 条路由 + 归属）/ 状态管理（三分 + SSE 单流分发模式）/ 目录与所有权（含反冲突手法）/ F1·F2·F3·F5 关键交互 ASCII 线框 + 长任务后台化 / 错误与降级 UI（四层级 + 映射表）/ a11y 与 i18n 基线 / 无 UI 库依赖的设计令牌。
- **最有实用价值的一条是 §3.4「把聚合点变成分片导出」**：`routes.tsx` 与 `lib/events/bindings.ts` 是三方必然冲突的热点 → 改为每个 feature 导出自己的路由片段与 SSE 绑定片段，聚合文件只在新增 feature 时动一行。配合 §3.5 的 eslint 禁止横向 import（`features/A` 不得 import `features/B`），把冲突结构性消灭，而不是靠约定君子协议。
- **`model-mgmt` 的模型/运行时线框我一张都没重画**（按你的边界要求），只定了它们在 IA 中的一级导航位置 + 必须复用共享令牌与共享组件 + 需向 `components/common/` 提升的三个组件（ModelPicker / FitBadge / BackendChip，因为 `/settings/asr` 与 `/onboarding` 也要用）。
- 设计令牌的颜色**不是目测的**：我实际运行了调色板校验脚本（六项检查），明暗双档输出记录在 §7.5。明档有一条 WARN（aqua 2.74:1、yellow 2.11:1 低于 3:1）→ 这把"存储分解条必须带图例和数字标签"从审美建议变成了硬性要求，已写进 §7.3。
- 派生 1 个 sonnet subagent 核实前端事实（`a5041d803ac5ca4ce`，已完成可复用）。加上 T-010 的两个，共 3 个 agent 待命。

**核实到 4 项事实，其中 1 项需要立刻处理**:
1. ⚠️ **shadcn/ui 已于 2026-07-03 把默认底层库从 Radix 换成 Base UI**（`@base-ui/react` v1.6.0；出自 MUI 团队，**不是** Radix 的分支）。Radix 未废弃，但要继续用必须显式 `shadcn init -b radix`。
   → **仓库里 `apps/web/src/components/ui/SOURCE.md` 仍写着"底层依赖：Radix UI Primitives"，需订正**（该文件归 `oss-scout`）。不订正的话 ADR-002 决策 2 的"可追溯"豁免条件不成立。
   → 另有一个易混淆的旧包名 `@base-ui-components/react`（停在 1.0.0-rc.0），**装错会踩坑**。
2. **`react-router` 已到 v8.3.0**，且 **v8 彻底移除了 `react-router-dom` 包**（`RouterProvider` 改从 `react-router/dom` 导入）。v8 基线要 Node **≥22.22.0** —— ADR-006 决策 7 写的是 `>=22`，根 package.json 现为 `>=24` 无冲突，但若日后放宽到 22 请写 `>=22.22.0`。
3. **Tailwind v4 有个会静默坑人的限制**：`@theme{}` 里的变量不能嵌套进选择器/媒体查询 → 明暗双档必须用 `:root`/`[data-theme=dark]` 定义语义变量 + **`@theme inline`** 转发。写成普通 `@theme` 会在定义处求值，**暗色永远不生效**，且不报错。已在 §7.5 给出可直接抄的两层结构。
4. **`react-i18next` 17.0.11 的 peer 强制要求 `i18next >= 26.2.0`** —— 版本联动，装错组合会在运行时静默出错。

**D-01 订正批次（我独占该文件，已改）**：按 `packages/shared` 的落地实现对齐三处 —— 路由前缀 `/api`（原 `/api/v1`）、SSE 帧用具名 `event: <type>`（原提议 `event: message`）、重放缓冲 256（原 2000）；错误信封改用实现版本。另订正 token fragment 写法为 `/#t=<token>`（因前端用 History 路由，fragment 不参与路由）。**这些是我向实现让步，不是实现向我让步 —— 请追认。**

下一步建议:
1. **§8 差异 3 是 Wave 3 的真实阻塞点**，建议在 T-021/T-023 开工前解决，否则他们只能写轮询然后返工。
2. D-05 状态仍是 `draft`。建议 T-021 把共享基建（`app/` `lib/` `styles/tokens.css`）建起来、跑通一条 SSE→UI 的端到端链路后，我再收敛一轮转 `ready`。
3. 建议把 §3.2 的前端所有权矩阵并入 BOARD 的文件所有权表，与后端所有权同一处维护。

需要 Manager 决策:
1. **【最高优先级，阻塞 Wave 3】`packages/shared` 的 `SSE_EVENT_TYPES` 只有 14 个事件，全部是模型/下载/后端域，F1–F5 需要的实时事件一个都没有** —— `transcribe.segment`（边转边看）、`mindmap.delta`（渐进渲染导图）、通用 `job.progress` 的 pipeline 载荷、`note.*`。缺了它们，§4.1 的"14 秒后就有字"、§4.3 的流式字幕、§4.6 的渐进导图全部塌掉，T-021/T-023 只能退化成轮询。该文件归 `model-mgmt` 独占，我不能改。**需要你指派谁来扩、按什么时间点交。**
2. **`ApiErrorBody` 是否补 `remediation?: {action, params}`**。它不是锦上添花：章程要求 2.1「用户不碰命令行」直接依赖它——错误若只能给一段文字，用户还是得去查文档。同样归 `model-mgmt`。
3. **错误文案归属**：我建议前端按 `code` 查本地文案表，后端的 `message`/`messageZh` 仅作未知 code 的兜底；`details` 作为结构化插值参数。理由：现在的两语硬编码意味着加第三种语言要改后端，且同一个 `DISK_FULL` 在下载页和转写页该说的话不同。裁决前我已让两边都按"code 优先 + message 兜底"实现，两种结果都能兼容。
4. **补装前端依赖**（`apps/web/package.json` 归 `oss-scout`）：`react-router@^8.3.0`、`i18next@^26.3.6` + `react-i18next@^17.0.11`（版本联动）、shadcn 底层库（见第 7 项）、虚拟滚动库（T-021 定后申报）。
5. **多标签页策略**：我建议用 Web Locks 选主（全浏览器只有一个标签持有 EventSource，其余靠 BroadcastChannel 转播）。理由是 3 个标签 = 3 条 SSE，直接吃掉 HTTP/1.1 六连接预算的一半，且与 D-01 §3.3「第二条连接进来关掉旧的」冲突。备选：v1 只支持单标签（第二个标签显示提示）。Safari 的 Web Locks 支持我**未核实**。
6. **追认 D-01 的订正批次**（见上）。
7. **shadcn 底层库：Base UI（我建议）vs Radix**。我倾向 Base UI 的理由是工程性的而非追新：一个包 vs 十几个包，而 ADR-005 决策 4 刚确立"许可证必须逐依赖登记"，依赖面小一个数量级是实打实的成本；且它是 CLI 默认路径，少一个"CI 里忘了传 -b radix 拿到另一套组件"的静默出错机会。若你更看重 Radix 的成熟度，切换成本只是 `init -b radix`。

诚实声明:
- D-05 **零代码执行**。唯一的实测是 §7.5 的调色板校验脚本输出。所有线框、状态模式、目录约定均为设计意图。
- 版本号与 API 事实均由 subagent 于 2026-08-02 实地拉取 npm registry / GitHub / 官方文档，逐条标了"已验证/文档/UNKNOWN"。**明确记录了一条否定结论**：TanStack Query **没有**官方 SSE 集成指南，§2.3 的事件→缓存映射是社区共识而非官方定式；另 `experimental_streamedQuery` 虽存在但用途不同（AsyncIterable 流式 queryFn），不要混用。
- 未修改任何他人的交付物（`packages/shared`、`apps/web/**`、`SOURCE.md`、`package.json` 我都只读未写）。

---

## [2026-08-02 17:05] T-021 PROGRESS —— ★ SSE 事件规格已就绪，可以去催 `model-mgmt` 了

交付（第一优先项已完成）:
- `docs/design/D-05-frontend.md` **§11「F1–F5 SSE 事件规格」** —— 这就是 ADR-007 决策 1 里说的那份规格。

给 `model-mgmt` 的摘要（**他只需要读 D-05 §11，不用读全文**）:
- **新增 20 个事件类型 + 修改 1 个既有事件**（`JobProgressEvent` 扩通用字段）。清单在 §11.6。
- **§11.0 定了三条总则**，其中最重要的一条：**每个事件必须显式归类为 `hint`（提示去拉数据）或 `data`（载荷即真相）**。
  全部 21 个里**只有 3 个是 `data`**（`transcribe.segment` / `mindmap.delta` / `summary.delta`）——
  它们不节流、不合并、带单调 `seq`、必达有序；**其余 18 个可丢可乱序，服务端可以随便合并节流**。
  这条给了他明确的节流自由度，也让前端知道哪些要检缺口。
- **`JobProgressEvent` 我建议改造而不是新增事件名**：现有 payload 是下载专用的（`completedBytes`/`speedBps`），
  F1/F2 的流水线作业没有"字节"这个单位。硬套会逼出第二套词汇——**而这正是他自己在 `JobState` 上已经避免过一次的错误**
  （`jobs.ts` 顶部注释写得很好）。我的方案是既有字段改可空 + 新增 `progress`/`step`/`jobType`/`noteUid`，**向后兼容，他的下载代码不用动**。
- **§11.6 附了分批交付顺序**，按那个顺序做对前端解阻塞最快：先 `job.progress` 扩展 + `note.*`（进度条能动），
  再 `transcribe.segment`（"边转边看"成立），再 `media.asset.ready`（F5 波形能画）。**他不必一次交齐。**
- 两个字段我特意标了"不是可选字段"，请他别删：
  ① `transcribe.replaced` 的 `updatedSegments` / `preservedEditedSegments` —— 没有这两个数字，
     F3 那句「已更新 47 段 · 你编辑过的 3 段已保留」就写不出来，用户会以为软件在乱改自己的字（ADR-007 认定的产品成败点）。
  ② `media.asset.ready` —— 波形（`role='peaks'`）和转码是异步生成的，前端在它就绪前去拉会 404。
     没有这个事件，F5 时间轴只能轮询或干等。

**前端零改动承诺**：`apps/web/src/lib/events/` 我已按本规格实现分发骨架，
在 `packages/shared` 落地前用 mock 驱动 UI（**已标注 mock**）。`SSE_EVENT_TYPES` 一扩充，前端只需删 mock，分发层不动。

D-02 的两处修正也已完成（你转达的 T-014 发现）:
- §4.3 新增「写入 `vec0` 的绑定约定」：**一律绑 `BigInt`，转换收口到 DB 适配层，业务代码照传 `number`**。
  写死不给选择余地的理由：让每个调用方各自记得 `BigInt(...)` 是必然会漏的，而且漏了要到运行时才炸。
- §4.1 新增「验证方法说明」：**扩展能力只能实测，不能读 `PRAGMA compile_options` 推断**。
  把原理也写清楚了（该宏控制的是编译期是否 `OMIT`，未被 OMIT 时默认可用，列表里没有≠没有），
  并举了 `node-sqlite3-wasm` 作为"真的不支持长什么样"的反例。这样后人不会只记住结论而不知道为什么。
- §7 验证表：V-1 与 V-6 标注为已实证关闭，新增 V-6b（BigInt 绑定）/ V-6c（驱动定案 + `oss-scout` 如实记录的三条残留风险：
  只在 Linux x64 glibc 实测、mac/Win/arm64/musl 全未测、上游 issue #1509 未复现）。
  **同时明确了 §1 的 26 张业务表 DDL 仍未整体执行**，避免"D-02 已验证"被过度解读。
- TL;DR 与文首的诚实标记块已同步更新（§4 升级为已验证，§1 仍为未执行）。

下一步: 继续 T-021 的实现（骨架 + F1/F2/F3/F5 + 三方并行留位）。

需要 Manager 决策: 
1. **`apps/web/package.json` 的依赖尚未补装**（`react-router` / `i18next` / `react-i18next` / `@base-ui/react` 都还没有）。
   该文件归 `oss-scout`（ADR-005 所有权表），我不越界。**我先按最终依赖写代码，装不上就编译不过** ——
   请催一下，或者授权我直接改 `apps/web/package.json` 这一个文件（只加 dependencies，不动其他）。
