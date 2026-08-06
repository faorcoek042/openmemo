---
id: D-05
author: architect
status: draft
date: 2026-08-02
depends_on: D-01, D-02, ADR-002, ADR-003, ADR-004, ADR-005, ADR-006, packages/shared@CONTRACT_VERSION=1
---

## TL;DR（≤ 25 行，Manager 只读这里）

- **本文的唯一目的是让 T-021 / T-022 / T-023 能并行开工而不互相踩踏。** 最关键的一节是 §3（目录与所有权），不是 UI 好不好看。
- **反冲突的核心手法：把"聚合点"变成"分片导出"。** `routes.tsx` 与 SSE 的 `bindings.ts` 是天然的三方冲突热点 → 改为**每个 feature 导出自己的路由片段与 SSE 绑定片段**，聚合文件只在新增 feature 时动一行。`features/<x>/**` 各自独占，横向 import 由 eslint 禁止。
- **状态三分**：服务端状态 = TanStack Query（唯一真相）；客户端 UI 状态 = Zustand 分片；**高频瞬时流（播放位置 10Hz、下载进度 4Hz、流式字幕）既不进 Query 也不进普通 React state**——走独立的 transient store + ref/canvas 直写，否则 3000 行转写稿必掉帧。
- **SSE 分发有一个必须写进文档的坑**：`packages/shared` 的 `formatSseFrame()` 写的是 `event: <type>`，**因此 `EventSource.onmessage` 永远不会触发**，必须对 **`SSE_EVENT_TYPES` 的全部 30 个**类型逐一 `addEventListener`——**别写死数字，遍历常量**（`packages/shared/src/events.ts:31`）。**此前写着"14 个"**。三个任务只要有一个人踩到就会浪费半天。⚠️ 顺带记一条契约漂移风险：前端在 `apps/web/src/lib/events/types.ts:130` 维护了**第二份** `ALL_SSE_EVENT_TYPES`，与 shared 那份是两条独立清单，需另行核对是否同步。
- **多标签页会吃掉 HTTP/1.1 的 6 连接预算**（3 个标签 = 3 条 SSE）→ 用 **Web Locks 选主**，全浏览器只有一个标签持有 EventSource，其余靠 `BroadcastChannel` 转播。这同时解决了 D-01 §3.3"第二条连接进来就关掉旧的"与多标签页的冲突。
- **F3 两阶段转写的 UI 呈现是本文的产品重点**：`partial` 用灰斜体、`final` 用正常字重，停止后明说"正在用更准确的模型重听"，完成时给"已更新 N 段，你编辑过的 3 段已保留"。不这么做用户会以为软件在乱改自己的字。
- **长任务后台化**：任务在 daemon 里，前端只是观察者 —— 但用户不知道，所以 UI 必须**主动说**"可以关闭此页面，任务会继续"。全局任务中心 + 顶栏徽标 + 回访续看。
- **设计令牌已用脚本实测校验**（非目测）：明/暗双档、状态色固定不随主题变、存储分解条的 4 个分段在明暗两档**全部 PASS**；明档 aqua/yellow 对比度 <3:1 → 强制配可见标签（图例已满足）。所有数值与校验输出见 §7。
- 🔄 **§7.1 表层 / §7.2 品牌两张表已于 2026-08-03 回写更新**（T-124 实测 → T-131 裁决），原因是原表的"三级抬升"在明档实测两两只有 **1.03:1**，**从未真正存在过** —— 那不是一条被违反的规范，是一条描述了不存在事实的规范。变更说明与新判据见 **§7.1b**；四个状态锚点与 `--data-1..4` 未动。
- **与 `packages/shared` 实际契约的 3 处差异 —— 全部已解决**：① 路由前缀 `/api` —— **D-01 已于 2026-08-02 订正**（D-01 §3.5，订正批次①），无分歧；② 错误信封 —— **D-01 §3.5 已改用实现版本** `{error:{code,message,messageZh,retryable,remediation}}`，不再是 RFC 9457；③ `SSE_EVENT_TYPES` **已补齐到 30 个**，F1–F5 全覆盖（`transcribe.started/partial/segment/done/replaced`、`mindmap.delta/done`、`note.created/updated/deleted`、`media.ready/media.asset.ready`、`record.state` 等均在，见 `packages/shared/src/events.ts:31`）。**此前这三条写着"需 Manager 裁决"，其中 ③ 写着"只有模型/下载域的 14 个事件，F1–F5 一个都没有"。**
- **本次核实到一件必须上报的事**：**shadcn/ui 已于 2026-07-03 把默认底层库从 Radix 换成 Base UI**（`@base-ui/react` v1.6.0，一个包 vs Radix 的十几个包）。仓库里 `components/ui/SOURCE.md` 仍写着"底层依赖 Radix"，需订正，否则 ADR-002 决策 2 的"可追溯"豁免条件不成立。
- **基建缺口（已收敛到 1 项）**：路由库 ✅ 已装 `react-router@8.3.0`（**Data 模式**——v8 已移除 `react-router-dom`）；i18n ✅ 已装 `i18next@26.3.6` + `react-i18next@17.0.11`（**peer 版本强制联动**）；虚拟滚动 ✅ 已装 `@tanstack/react-virtual@3.14.9`。**仍缺 shadcn 底层库** —— `components/ui/` 至今只有 `SOURCE.md`，零组件，`pnpm-lock.yaml` 里 `base-ui`/`@radix-ui` 命中数为 0。**此前写着这四项全缺、全部"归 `oss-scout`，需补装"**。
- **Tailwind v4 有个会静默坑人的限制**：`@theme{}` 里的变量不能嵌套在选择器/媒体查询中 → 明暗双档**必须**用 `:root`/`.dark` 定义语义变量 + **`@theme inline`** 转发；写成普通 `@theme` 会在定义处求值，**暗色永远不生效**（§7.5）。
- **未验证/存疑**：本文无任何代码执行；Web Locks 在 Safari 的可用性、React 19 StrictMode 下的 EventSource 单例行为、虚拟滚动库选型仍未定（§9）。另已核实：**TanStack Query 没有官方 SSE 指南**，§2.3 的映射表是社区共识而非官方定式，已如实标注。
- **对其他 agent 的影响**：T-021 首建 §3 的共享基建（`app/`、`lib/`、`styles/tokens.css`）后**即冻结**，后续改动走 `SHARED-CHANGE:` 申报；T-022 的模型/运行时页线框**仍以 R-04 §9 与 D-03 为准**，本文只定它们在 IA 中的位置与共用规范；T-023 只碰 `features/mindmap/**` 与 `packages/mindmap/**`。

---

# 详细内容

> **诚实标记**：`[已定]` = ADR / 已落地代码既成事实；`[设计]` = 我的决策，**未执行任何代码**；
> `[已核实]` = 本次实地读取上游源码/文档/脚本输出；`[待核实]` = 需实证；`UNKNOWN` = 查不到，不编。
> **本文档零代码交付**（BOARD + ADR-005 所有权表：`architect` 只写 `docs/design/D-01* D-02* D-05*`）。

---

## §0 既成事实盘点（写本文前我实地读了这些）

`[已核实]` 2026-08-02 读取 `/root/memo/apps/web/package.json` 与 `/root/memo/packages/shared/src/**`：

| 项 | 现状 | 影响 |
|---|---|---|
| 框架 | React **19.2**、Vite **8**、Tailwind **4.3**（`@tailwindcss/vite`，CSS-first） | 已定，本文不改选型 |
| 状态 | `@tanstack/react-query` **5.101**、`zustand` **5.0** 已装 | 与 §2 选型一致 ✅ |
| 编辑器 | `@tiptap/react` **3.29** + `starter-kit` + `pm` | 笔记正文（D-02 `notes.body_json`） |
| 导图 | `mind-elixir` **5.14**、`markmap-lib`/`markmap-view` **0.18.12** | 与 ADR-006 决策 8 一致 ✅ |
| 音频 | `wavesurfer.js` **7.12** | F5 波形 |
| shadcn 栈 | `cva` + `clsx` + `tailwind-merge` + `lucide-react` 已装，**无底层无头组件库** | ⚠️ 见 §0.1 —— shadcn 的默认底层库已于 **2026-07-03 从 Radix 改为 Base UI**，这改变了"要装什么" |
| **路由** | ⚠️ **完全没有路由库** | §1 的路由表无法落地 → 需补装（选型见 §0.2） |
| **i18n** | ⚠️ **完全没有 i18n 库** | §6.1 需补装（选型见 §6.1） |
| 契约 | `packages/shared` 已产出 10 个文件、`CONTRACT_VERSION = 1` | §2/§5 全部对齐它 |
| SSE | `GET /api/events`，`formatSseFrame()` → `event: <type>`，**30** 个事件类型（**此前写着 14 个** —— 那是 2026-08-02 盘点时的数，F1–F5 域事件后续已补齐），`PROGRESS_THROTTLE_HZ=4`，`SSE_REPLAY_BUFFER_SIZE=256`，`KEEPALIVE_INTERVAL_MS=15000` | §2.3 按此实现；数量以 `SSE_EVENT_TYPES` 常量为准，别写死 |
| 作业状态机 | `JOB_STATES` 8 态 + `JOB_TRANSITIONS`，已与 D-02 §1.7 对齐 | §4/§5 直接复用，**前端不得自造状态词汇** |
| 错误 | `ApiErrorBody = {error:{code,message,messageZh,retryable,details?}}` | §5/§6 按此，但见 §8 差异 |
| ULID | `packages/shared/src/ulid.ts` **故意未从 `index.ts` 导出** | ✅ 正确：它 `import 'node:crypto'`，进浏览器包会炸。**前端严禁 import 它**（§2.6） |

### 0.1 ⚠️ shadcn/ui 的底层库已变更（本次核实到的最意外事实）

`[已核实]` 官方变更日志 `https://ui.shadcn.com/docs/changelog/2026-07-base-ui-default`（2026-07-03）：

- **shadcn CLI 的默认无头组件库已从 Radix UI 改为 Base UI**。二者**不是同一套代码**（Base UI 出自 MUI 团队，不是 Radix 的分支或包装）。官方给出的理由：`shadcn create` 新建项目中 Base UI 对 Radix 的采纳率已达 **2:1**。
- **Radix 未被弃用**，官方自己生产仍在用；两条线并行维护。要继续用 Radix 必须显式传参：`pnpm dlx shadcn init -b radix`。
- 包名（`[已核实]` npm registry）：**`@base-ui/react` v1.6.0**，peer `react: ^17 || ^18 || ^19` → 支持 React 19。
  ⚠️ **有一个极易混淆的旧包名 `@base-ui-components/react`，停在 `1.0.0-rc.0`，是被取代的命名，不要装它。**
- Radix 侧仍健康：`@radix-ui/react-dialog` v1.1.23，peer 含 `^19.0` → 也支持 React 19。但 Radix 是**逐组件一个包**（dialog/select/tooltip… 各一个）。
- shadcn 官方明确写 "Tailwind v4 and React 19. Ready for you to try out" —— 我们的栈在支持范围内。

**我的建议 `[设计]`：走 Base UI 默认路径。** 理由不是"新即是好"，而是两条具体的工程收益：
① **一个包 vs 十几个包** —— ADR-005 决策 4 刚刚确立"许可证报告必须逐依赖登记"，依赖面小一个数量级就是实打实的维护成本降低；
② 它是 CLI 默认路径，`shadcn add` 不需要每次记得加 `-b radix`，**少一个静默出错的机会**（CI 里忘了传参会拿到另一套组件）。
若 Manager 更看重 Radix 的成熟度，切换成本仅为 `init -b radix` + 按组件补 `@radix-ui/react-*`。**这是决策项（§10-7）。**

> 📌 **需要订正的既有文件**：`apps/web/src/components/ui/SOURCE.md`（`oss-scout` 所有）当前写着
> "底层依赖：Radix UI Primitives（MIT）"。无论最终选哪条路径，该行都需按实际情况更新，
> 否则 ADR-002 决策 2 的"可追溯"豁免条件不成立。

### 0.2 路由库选型 `[已核实版本，选型为设计建议]`

| 候选 | 版本 | 事实 |
|---|---|---|
| **`react-router` v8** | **8.3.0**（2026-07-22） | 基线要求 **React ≥19.2.7、Vite ≥7、Node ≥22.22.0**，**纯 ESM**。我们是 React 19.2.8 / Vite 8 / Node ≥24 → **全部满足**。⚠️ **v8 彻底移除了 `react-router-dom` 包**，`RouterProvider` 改从 `react-router/dom` 导入，其余从 `react-router`。旧 `react-router-dom` 仍在 v7 线（7.18.2）并行维护，未废弃 |
| `@tanstack/react-router` | 1.170.18 | peer 明确支持 React 19；**不强制文件路由/代码生成**，可用 `createRootRoute` + `createRoute` 手写路由树（`[文档]` 级，未逐字抓取原文） |

**建议：`react-router` v8，Data 模式**（`createBrowserRouter(routes)` + `<RouterProvider>`）。

- Data 模式**不需要任何 Vite 插件**，是纯库调用 —— 与 §3.4 的"每个 feature 导出路由对象数组、聚合文件只做拼接"完美契合（`createBrowserRouter` 吃的就是路由对象数组）。
- **不选 Framework 模式**：它需要 `@react-router/dev` 插件 + 约定式 `routes.ts`，会把路由结构绑到它的构建约定上，削弱 §3.4 的反冲突设计；而我们纯 SPA 不需要它的 SSR/自动分包。
- 官方文档原文的立场是"想要免构建插件的库就用 Data Mode" —— 与我们的需求一致。
- ⚠️ **Node 基线细化**：ADR-006 决策 7 定为 `>=22`，但 react-router v8 要求 **≥22.22.0**。根 `package.json` 现为 `>=24.0.0`，无冲突；若日后放宽到 22，请写 `>=22.22.0`。

---

## §1 信息架构与路由表

### 1.1 导航骨架

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│ ⌘K 搜索           OpenMemo                    [⚡2 个任务进行中]  [🌙]  [中/EN]  [⚙] │  ← 顶栏（常驻）
├──────────────┬─────────────────────────────────────────────────────────────────────┤
│              │                                                                     │
│  ＋ 新建捕获  │                                                                     │
│              │                                                                     │
│  📄 全部笔记  │                        主内容区（路由出口）                          │
│  ⭐ 星标      │                                                                     │
│  🎙 录音      │                                                                     │
│  📁 文件夹 ▸  │                                                                     │
│    ├ 课程     │                                                                     │
│    └ 播客     │                                                                     │
│  🏷 标签 ▸    │                                                                     │
│              │                                                                     │
│ ──────────── │                                                                     │
│  ⚙ 运行时     │  ← 章程要求 2.1（一等公民，不埋进设置）                                │
│  📦 模型      │  ← 章程要求 2.2                                                     │
│  ⚙ 设置      │                                                                     │
└──────────────┴─────────────────────────────────────────────────────────────────────┘
                                       ▲
                    点顶栏"任务进行中"从右侧滑出【任务中心抽屉】（§4.5）
```

**为什么"运行时"和"模型"在侧栏一级而不是埋进设置**：章程要求 2.1/2.2 把"网页里装 GPU 后端、管模型"列为硬性功能。memo.ac 把它们埋在设置里（R-01 §B6/B7），导致用户找不到、FAQ 里"模型下载卡 0%"成了最高频问题。一级导航是产品判断，不是审美。

### 1.2 完整路由表 `[设计]`

**路由模式 = History（非 hash）**。daemon 对未知路径回落 `index.html`，但**必须排除** `/api`、`/ws`、`/media`、`/assets`（D-01 §3.1）。

| 路由 | 页面 | 职责 | Wave 3 归属 |
|---|---|---|---|
| `/` | — | 重定向到 `/notes`（首启未完成则 `/onboarding`） | T-021 |
| `/onboarding` | 首启引导 | 3 步：选界面语言 → 检测硬件并推荐后端 → 装第一个 ASR 模型（可跳过，L1 CPU 兜底永远可用） | T-022 主笔（含硬件/模型步），T-021 提供壳 |
| `/notes` | 笔记列表 | F5：列表/网格切换、文件夹与标签筛选、排序、批量操作、空态 | T-021 |
| `/notes/:noteUid` | **笔记详情**（产品心脏） | F5：播放器 + 波形 + 转写稿 + 右侧 Tab(`?tab=summary\|mindmap\|notes`) | T-021（导图 Tab 内嵌 T-023 的组件） |
| `/notes/:noteUid/mindmap` | 导图全屏 | F4：编辑、布局、导出 | **T-023** |
| `/capture` | 捕获 | F1 粘贴链接 / F2 拖文件；解析确认卡片；批量队列 | T-021 |
| `/record` | 录音 | F3：设备选择、授权、波形、流式字幕、两阶段提示 | T-021 |
| `/search` | 全局搜索 | 关键词/语义/混合三档；结果直达时间点（D-02 §4.4） | T-021 |
| `/tasks` | 任务中心（整页） | 抽屉的完整版：历史、失败重试、日志 | T-021 |
| `/runtime` | **运行时与加速后端** | 章程 2.1：硬件卡片、后端包列表、安装/自检/切换 | **T-022** |
| `/models` | **模型管理** | 章程 2.2：目录、量化选择、fit 徽标、下载、导入、存储 | **T-022** |
| `/models/:modelId` | 模型详情 | 变体、许可证、跑基准 | **T-022** |
| `/settings` | — | 重定向 `/settings/general` | T-021 |
| `/settings/general` | 通用 | 语言、主题、开机自启、端口、默认行为 | T-021 |
| `/settings/asr` | 转写 | 默认引擎/模型/语言、VAD、说话人分离、提示词 | T-021（模型选择器复用 T-022 组件） |
| `/settings/llm` | LLM | provider、baseUrl、API Key（**必须显式告知明文存储**，ADR-006 决策 1） | T-021 |
| `/settings/storage` | 存储 | 数据目录、迁移、GC、存储分解条（§7.5） | T-022（复用其 storage API） |
| `/settings/about` | 关于 | 版本、契约版本、许可证清单、**导出诊断包** | T-021 |
| `/diagnostics` | 安全模式诊断 | daemon 进入安全模式时**强制跳转**（D-01 §2.7 D）：崩溃栈、日志、重置按钮 | T-021 |

**约定**
- **URL 是可分享/可书签的状态**：笔记详情的 Tab、播放位置（`?t=754000`）、搜索词与模式、模型筛选，全部进 URL query。用户把"这一秒"发给自己是真实需求。
- **`:noteUid` / `:modelId` 一律用 ULID**（ADR-006 决策 5），**前端永不见整数 PK**。
- 深链接进入未完成的笔记 → 正常渲染 + 顶部进度条，不做"加载中"全屏遮罩。

### 1.3 与 T-022 的边界（避免重画）

`/runtime`、`/models`、`/models/:id`、`/settings/storage` 的**线框与交互细节以 `R-04 §9` 与 `D-03` 为准**，本文只规定：
① 它们在 IA 里的位置（一级导航）；② 必须复用 §7 的令牌与 §3 的 `components/ui`、`components/common`；
③ 它们导出的模型选择器 / fit 徽标 / 后端状态芯片必须提升到 `components/common/`，供 `/settings/asr` 与 `/onboarding` 复用（见 §3.3 的提升协议）。

---

## §2 状态管理

### 2.1 三类状态，三种机制（**先分类，再选库**）

| 类别 | 例子 | 机制 | 为什么不用另外两种 |
|---|---|---|---|
| **服务端状态** | 笔记、转写稿、任务列表、模型目录、硬件信息 | **TanStack Query v5** | 它有缓存、去重、失效、重试、`staleTime`。放进 Zustand 等于自己重写一遍 Query 且必然写差 |
| **客户端 UI 状态** | 侧栏折叠、主题、语言、任务抽屉开合、列表视图模式、当前选中段 | **Zustand v5**（按 feature 切片） | 与服务器无关，放进 Query 是滥用；用 Context 会导致整棵树重渲染 |
| **高频瞬时流** | 播放位置(≈10Hz)、下载进度(4Hz×N)、录音电平(≈30Hz)、流式 partial 字幕 | **独立 transient store + ref/canvas 直写**（§2.4） | 进 Query 会每帧写缓存；进普通 React state 会每帧重渲染 3000 行虚拟列表 → 掉帧 |

### 2.2 TanStack Query 约定 `[设计]`

```ts
// app/query.ts —— 唯一的 queryKey 工厂，三个任务都从这里取，禁止手写字符串数组
export const qk = {
  notes:      { all: ['notes'] as const,
                list: (f: NoteFilter) => ['notes', 'list', f] as const,
                detail: (uid: string) => ['notes', 'detail', uid] as const },
  transcript: (noteUid: string) => ['transcript', noteUid] as const,
  mindmap:    (noteUid: string) => ['mindmap', noteUid] as const,
  jobs:       { all: ['jobs'] as const, detail: (id: string) => ['jobs', id] as const },
  models:     { catalog: ['models','catalog'] as const,
                installed: ['models','installed'] as const,
                storage: ['models','storage'] as const,
                sources: ['models','sources'] as const },
  backends:   { catalog: ['backends','catalog'] as const,
                installed: ['backends','installed'] as const },
  runtime:    { hardware: ['runtime','hardware'] as const },
};
```

- **`queryKey` 必须来自 `qk` 工厂**。手写数组是缓存失效失灵的头号原因，且三个任务各写各的必然拼错。eslint 规则由 T-021 加（`no-restricted-syntax` 禁止字面量 `queryKey`）。
- **默认 `staleTime`**：`0`（本地 daemon，请求几乎零成本，宁可多拉一次也不显示旧数据）。**例外**：`models.catalog`（60s，目录带 ETag 缓存）、`runtime.hardware`（5min，探测慢且贵，R-02 §A.1 明确 `system_profiler` 可达数秒）。
- **`refetchOnWindowFocus: false`**：我们有 SSE，不需要靠聚焦兜底；开着会在多标签间制造请求风暴。
- **`retry`**：默认 1 次。**`retryable === false` 的错误（见 `shared/jobs.ts`）绝不重试**——用服务端给的判断，不在前端另造一套。
- **Mutation 一律返回 jobId 而非结果**（D-01 §3.2 规则 2）：`POST` → `202` → 进度走 SSE。因此 mutation 的 `onSuccess` **只做一件事**：把新 job 塞进 `qk.jobs.all` 缓存，不做乐观业务更新。

### 2.3 ★ SSE 单流分发模式（本节是三个任务的公共基建）

```
                    ┌──────────────────────────────────────────────┐
                    │  daemon  GET /api/events （全局唯一，ADR-004）│
                    └───────────────────────┬──────────────────────┘
                                            │ id: <n>  event: <type>  data: {...}
┌───────────────────────────────────────────▼───────────────────────────────────────┐
│ lib/events/source.ts   ★ 单例。Web Locks 选主 → 全浏览器只有一个标签持有 EventSource │
│   · addEventListener(t) for t of SSE_EVENT_TYPES   ← 见下方【必读的坑】             │
│   · Last-Event-ID 由 EventSource 自动带；服务端环形缓冲 256 条                       │
│   · 连接态 → connectionStore：connecting|open|reconnecting|degraded                 │
│   · 非主标签：BroadcastChannel('om-sse') 接收转播                                   │
└───────────────────────────────────────────┬───────────────────────────────────────┘
                                            │ bus.emit(type, payload)
              ┌─────────────────────────────┼─────────────────────────────┐
              ▼                             ▼                             ▼
┌───────────────────────┐   ┌───────────────────────────┐   ┌──────────────────────┐
│ progressStore          │   │ bindings（分片聚合）        │   │ useSseEvent(type)    │
│ (transient, 非 React)  │   │ 事件 → queryClient 操作      │   │ 组件级订阅，少用      │
│ job.progress 专用       │   │ features/*/sse.ts 各自导出  │   │ 只给必须逐事件反应的  │
│ 200ms 节流后才 commit   │   │ 由 lib/events/bindings.ts   │   │ UI（如 toast）        │
└───────────────────────┘   │ 聚合 —— ★ 反冲突设计         │   └──────────────────────┘
                            └───────────────────────────┘
```

#### 【必读的坑】`onmessage` 不会触发

`[已核实]` `packages/shared/src/events.ts` 的 `formatSseFrame()` 产出：

```
id: 42
event: job.progress
data: {"type":"job.progress",...}
```

按 SSE 规范，带具名 `event:` 字段的消息**只会派发到 `addEventListener('job.progress', …)`**，
**`EventSource.onmessage` 永远不会触发**（它只接 `event: message` 或无 `event:` 的帧）。

→ **实现必须遍历 `SSE_EVENT_TYPES` 逐一 `addEventListener`**。
这条写在这里，是因为三个任务里只要有一个人按 `onmessage` 写，就会得到"连上了但什么都收不到"的静默失败，
排查成本远高于读这一段。

```ts
import { SSE_EVENT_TYPES } from '@openmemo/shared';
for (const t of SSE_EVENT_TYPES) {
  es.addEventListener(t, (e) => bus.emit(t, JSON.parse((e as MessageEvent).data)));
}
```

#### 事件 → 动作映射（默认策略）

| 事件 | 动作 | 理由 |
|---|---|---|
| `job.progress` | **不碰 Query 缓存**，写 `progressStore`（200ms 节流后 commit） | 4Hz × N 个任务写缓存 = 全列表反复重渲染 |
| `job.created` | `setQueryData(qk.jobs.all, 追加)` | 已有完整 `DownloadJob` 载荷，直接写，省一次往返 |
| `job.state` | `setQueryData` 改状态 + 进入终态时 `invalidateQueries(qk.jobs.detail)` | |
| `job.failed` | `setQueryData` + **toast（`willRetry===false` 时才弹）** | 自动重试中的失败不该打扰用户 |
| `model.installed` / `model.removed` | `invalidate(qk.models.installed, qk.models.catalog, qk.models.storage)` | |
| `model.activated` | `setQueryData(qk.models.installed)` 改 active | |
| `backend.installed` / `backend.removed` | `invalidate(qk.backends.*)`；`selfTestPassed===false` 时弹**持久**告警 | 自检失败必须显性（ADR-003 决策 3） |
| `storage.changed` | `setQueryData(qk.models.storage)` | |
| `catalog.updated` | `invalidate(qk.models.catalog)` | |
| `sources.probed` | `setQueryData(qk.models.sources)` | |
| `hardware.changed` | `invalidate(qk.runtime.hardware` **和** `qk.models.catalog)` | ⚠️ `shared/events.ts` 注释明确：硬件变了**所有 fit 判定失效**，必须重拉目录 |
| `keepalive` | **只重置看门狗计时器**，不派发 | 15s 没收到任何帧（含 keepalive）→ 判定连接死了，主动重连 |

**总原则（承 D-01 §3.3）：SSE 事件是"该去拉数据了"的提示，不是数据本身。**
唯二例外：`job.progress`（用完即弃）与未来的 `transcribe.segment`（有序追加）。
这条规则一次性消灭"前后端状态不一致"的一整类 bug。

#### 多标签页与 6 连接预算 `[设计]`

浏览器对同一 origin 的 HTTP/1.1 并发连接上限约 6 条，**且在同一浏览器进程内跨标签共享**。
3 个标签各开一条 SSE = 预算去掉一半，媒体 Range 请求和 REST 会随机排队卡住。
而 D-01 §3.3 又规定 daemon 对同一 session 只保留 1 条 SSE（第二条进来关掉旧的）——两者叠加会让多标签直接坏掉。

**解法：Web Locks 选主。**

```
navigator.locks.request('openmemo-sse', {mode:'exclusive'}, async () => {
    开 EventSource；收到事件 → BroadcastChannel('om-sse').postMessage(evt)
    await new Promise(() => {})   // 永不释放；标签关闭时浏览器自动释放，下一个标签自动接管
});
非主标签：只监听 BroadcastChannel，不开 EventSource
```

- 主标签关闭 → 锁自动释放 → 另一个标签**秒级接管**，无需心跳选举。
- 降级：`navigator.locks` 不可用时（`[待核实]` Safari 支持情况见 §9）→ 退化为"每个标签各开一条"，并在 UI 提示"建议只开一个标签页"。
- **v1 也可以选择只支持单标签**（在第二个标签显示"OpenMemo 已在另一个标签页打开"）。见 §10 决策项。

#### 断线与降级

```
open ──断──> reconnecting（EventSource 自动重连，服务端已设 retry）
                │ 连续 5 次失败（约 15s）
                ▼
             degraded：改用 5s 轮询 qk.jobs.all；顶栏常驻黄条"实时更新已断开，正在轮询"
                │ 任一次重连成功
                ▼
              open：清黄条 + invalidate 全部查询（重放缓冲只有 256 条，可能已滚过）
```
- **重连后必须全量失效**：`SSE_REPLAY_BUFFER_SIZE = 256`，一次大批量下载就能滚过。宁可多拉一次。
- **`CONTRACT_VERSION` 校验**：应用启动时比对 `@openmemo/shared` 的 `CONTRACT_VERSION` 与 `/api/health` 返回值；不匹配 → 阻断对话框"前端与本地服务版本不一致，请刷新/升级"。**静默不匹配比崩溃更糟**。

### 2.4 高频瞬时流：不要经过 React

| 流 | 频率 | 通道 | 落点 |
|---|---|---|---|
| 播放位置 | `requestAnimationFrame`，节流 ~10Hz | `<audio>.currentTime` → transient store（`subscribeWithSelector`） | 只有"当前高亮段变了"才 setState；位置本身写进 ref + 直接改 DOM `transform`（波形游标） |
| 波形绘制 | 随位置 | 预计算 peaks（D-02 §3.4）→ canvas 直写 | 完全不进 React |
| 录音电平 | ~30Hz | AudioWorklet → transient store | canvas 直写 |
| 流式 partial 字幕 | 高频覆盖 | WS → transient store | 单独一个"当前 partial"组件订阅，**不进转写稿列表** |
| `final` 字幕 | 低频追加 | WS/SSE → `setQueryData(qk.transcript(uid), 追加)` | 进 Query，因为它是真数据 |
| 下载进度 | 4Hz×N | SSE → `progressStore`（200ms 节流） | 只有进度条组件订阅自己那一个 jobId |

**判据（写给三个任务的一句话）**：
> 这个值刷新时，**是否需要让超过一个组件重新渲染**？不需要 → 别进 React state。

### 2.5 乐观更新的边界

| 场景 | 乐观？ | 理由 |
|---|---|---|
| 改笔记标题 / 标签 / 星标 / 文件夹 | ✅ 乐观 + 失败回滚 | 本地毫秒级，必然成功；等待会显得卡 |
| 编辑转写段落文本 | ✅ 乐观 | 同上；`text_raw` 在后端保留原文，可撤销 |
| 思维导图节点拖拽/改字 | ✅ 乐观（走 `revision` 乐观锁，409 时提示，见 D-01 §5 F4） | 交互密集，等往返必然卡顿 |
| 删除笔记 | ⚠️ 半乐观：立即从列表移除 + Toast「已删除 · 撤销」 | 软删（D-02），撤销成本低 |
| 触发转写 / 下载 / 安装后端 | ❌ **绝不乐观** | 它们会失败、会 `blocked`、会排队。假装成功是欺骗 |
| 激活模型 | ❌ | `reloadRequired` 语义在服务端（`ActivateResponse`），前端猜不了 |

### 2.6 前端硬禁忌

1. **禁止 `import { ulid } from '@openmemo/shared/ulid'`** —— 它 `import 'node:crypto'`，会炸浏览器构建。`[已核实：ulid.ts 故意未从 index.ts 导出]`。前端需要临时 key 用 `crypto.randomUUID()`，且**只能用于本地列表 key，绝不发给服务端当 id**。
2. **禁止前端重算业务判定**。`shared/api.ts` 的注释已经明说：`fitness` 由服务端算，"UI 渲染它，MUST NOT recompute the rules"。同理适用于 `retryable`、`reloadRequired`、`applicable`、作业状态转移（用 `canTransition()`）。
3. **禁止第二条 `EventSource`**。
4. **禁止在组件里 `new EventSource` / `new WebSocket`** —— StrictMode 双挂载会开两条。一律走 `lib/` 的单例 + Provider。

---

## §3 ★ 组件分层与目录约定（决定 Wave 3 能否并行）

### 3.1 目录树 `[设计]`

```
apps/web/src/
├── main.tsx                     ⬛ 共享  引导：Providers + Router，创建 SSE 单例
├── App.tsx                      ⬛ 共享  外壳：顶栏 + 侧栏 + <Outlet/>
├── routes.tsx                   ⬛ 共享  ★ 只做聚合，见 §3.4
│
├── app/                         ⬛ 共享基建（T-021 首建后冻结）
│   ├── providers.tsx            QueryClientProvider / ThemeProvider / I18nProvider / SseProvider
│   ├── query.ts                 queryClient 配置 + qk 工厂（§2.2）
│   └── i18n/                    i18n 初始化 + locales/{zh-CN,en}/*.json
│                                （★ 路由**实例**在 `main.tsx`：`createBrowserRouter(routes)`；
│                                  聚合表在仓库根 `src/routes.tsx`，见上。
│                                  **此前这里写着 `app/router.ts` —— 该文件不存在**）
│
├── lib/                         ⬛ 共享工具（纯函数 / 单例，无 UI）
│   ├── api/                     REST 客户端；按 shared 的 ENDPOINTS 表组织，一域一文件
│   ├── events/
│   │   ├── source.ts            EventSource 单例 + Web Locks 选主 + 连接态
│   │   ├── bus.ts               轻量 pub/sub
│   │   └── bindings.ts          ★ 只做聚合，见 §3.4
│   ├── format/                  时长/字节/相对时间/时间码（全部走 Intl）
│   └── utils.ts                 cn() 等
│
├── components/
│   ├── ui/                      ⬛ shadcn 豁免区（ADR-002 决策 2）——**只增不改**，改动须更新 SOURCE.md
│   └── common/                  ⬛ 共享业务组件（跨 feature 复用的才放这）—— 下面是**实际清单**
│       ├── EmptyState.tsx  ErrorBlock.tsx  Banner.tsx  ReadinessBanner.tsx
│       ├── StatusChip.tsx  ProgressMeter.tsx  RemediationButton.tsx  PanelBoundary.tsx
│       ├── Emphasis.tsx  Button.tsx  MockNotice.tsx  JobToaster.tsx
│       ├── AsrEngineStatus.tsx  AsrModelPicker.tsx  TranscribeOptions.tsx
│       └── BackendChip.tsx  FitBadge.tsx  statusTone.ts  llm/
│
├── features/                    ★★ 并行主战场：一个目录一个 owner，互不越界 ★★
│   ├── capture/      T-021   F1/F2 捕获
│   ├── notes/        T-021   F5 列表 + 详情外壳
│   ├── transcript/   T-021   F5 转写稿（虚拟列表、编辑、说话人）
│   ├── player/       T-021   F5 播放器 + 波形 + 时间轴
│   ├── recorder/     T-021   F3 录音
│   ├── search/       T-021   搜索
│   ├── tasks/        T-021   任务中心
│   ├── settings/     T-021   设置各页
│   ├── runtime/      T-022   章程 2.1
│   ├── models/       T-022   章程 2.2
│   ├── mindmap/      T-023   F4（渲染适配层消费 packages/mindmap 的 MindMapDoc）
│   ├── components/           组件目录页（★ 此前未列）
│   ├── diagnostics/          自检/诊断页（★ 此前未列）
│   ├── folders/              文件夹树（★ 此前未列）
│   └── onboarding/           首次运行引导（★ 此前未列）
│
└── styles/
    └── tokens.css               ⬛ 设计令牌（§7；architect 定值，T-021 落地后冻结）
```

> **两处结构订正（2026-08-06，照抄前请读这段）：**
>
> 1. **`components/common/` 的清单已按实际重写。此前这里列的 `ProblemBanner` / `JobStateChip` /
>    `StorageBar` / `TimeCode` / `ByteSize` / `RelativeTime` / `ModelPicker` 七个文件从未存在**
>    （12 个里 7 个是空的，58%）——不是改过名，是全仓 grep 零命中。它们的职责实际落在：
>    时间/字节格式化在 **`lib/format/{time.ts,bytes.ts}`**（本来就该在 `lib/format/`，见上）；
>    状态芯片在 **`StatusChip.tsx`**；问题横幅在 **`Banner.tsx` / `ReadinessBanner.tsx`**；
>    模型选择器在 **`AsrModelPicker.tsx`** 与 `llm/` 子目录。
>    反过来，实有而旧清单没列的有 `Banner` / `ReadinessBanner` / `StatusChip` / `RemediationButton` /
>    `PanelBoundary` / `Emphasis` / `Button` / `MockNotice` / `JobToaster` / `AsrEngineStatus` /
>    `AsrModelPicker` / `TranscribeOptions` / `statusTone.ts` / `llm/`。
> 2. **`features/` 此前只列了 11 个**，实有 15 个目录：补上了 `components/`、`diagnostics/`、
>    `folders/`、`onboarding/` 四个。

**每个 feature 内部的标准形状**（统一后，三个任务读彼此的代码不用重新学）：

```
features/<name>/
├── index.ts          对外唯一出口（其它 feature 只能从这里 import —— 但见 §3.5，通常压根不该 import）
├── <Name>.routes.tsx ★ 导出本 feature 的路由片段
├── sse.ts            ★ 导出本 feature 的 SSE 绑定片段
├── api.ts            本域的 Query/Mutation hooks（用 qk 工厂）
├── store.ts          本域的 Zustand 切片（可选）
├── components/       本域私有组件
└── hooks/
```

### 3.2 所有权矩阵（硬约束）

| 路径 | 独占 owner | 其他人 |
|---|---|---|
| `apps/web/src/features/capture,notes,transcript,player,recorder,search,tasks,settings/**` | **T-021** | 只读 |
| `apps/web/src/features/runtime,models/**` | **T-022** | 只读 |
| `apps/web/src/features/mindmap/**` + `packages/mindmap/**` | **T-023** | 只读 |
| `apps/web/src/{app,lib,components,styles}/**`、`main.tsx`、`App.tsx`、`routes.tsx` | **T-021 首建，之后为共享区** | 见 §3.3 |
| `apps/web/package.json` | `oss-scout`（ADR-005 所有权表） | 三方**都不改**，需要新依赖 → inbox 申报 |
| `packages/shared/src/**` | `model-mgmt` | 三方**都不改**，需要新类型/事件 → inbox 申报（§8） |

### 3.3 共享区变更协议

1. **默认只读。**
2. **只增不改优先**：新增文件到 `components/common/` 或 `lib/` 不需要申报（但要遵守命名与依赖规则）。
3. **修改既有共享文件**：在 `coordination/inbox/<自己>.md` 写一行
   `SHARED-CHANGE: apps/web/src/lib/format/duration.ts — 需要支持 >24h 的时长` 然后再改。**先申报后改**，Manager 事后审。
4. **提升（promotion）**：一个组件被第二个 feature 需要时才从 `features/X/components/` 移到 `components/common/`，移动方**必须**在 inbox 申报。**不要预先猜测哪些会被复用**——过早提升会造出没人用的抽象。
5. **`components/ui/`（shadcn）**：只能通过 CLI 新增，且**必须**在 `SOURCE.md` 表格追加一行（ADR-002 决策 2 的豁免条件，不做就等于豁免失效）。**禁止手改已生成组件**；要变体用 `cva` 在 `components/common/` 包一层。

### 3.4 ★ 反冲突的关键手法：把聚合点变成分片导出

`routes.tsx` 和 `lib/events/bindings.ts` 是天然的三方冲突热点——每个人都要往里加东西。解法是让它们**只做聚合**：

```tsx
// routes.tsx —— 共享，但只在"新增一个 feature"时才动，平时零冲突
import { captureRoutes }  from '@/features/capture/Capture.routes';
import { notesRoutes }    from '@/features/notes/Notes.routes';
import { mindmapRoutes }  from '@/features/mindmap/Mindmap.routes';   // T-023 独占那个文件
import { modelsRoutes }   from '@/features/models/Models.routes';     // T-022 独占那个文件
export const routes = [ ...captureRoutes, ...notesRoutes, ...mindmapRoutes, ...modelsRoutes, /* … */ ];
```

```ts
// lib/events/bindings.ts —— 同理
import { notesSse } from '@/features/notes/sse';
import { modelsSse } from '@/features/models/sse';
export const registerAllSseBindings = (qc: QueryClient) => [notesSse, modelsSse, /*…*/].forEach(f => f(qc));
```

**效果**：T-021/T-022/T-023 各自只改**自己 feature 目录里的那个文件**；两个聚合文件在 Wave 3 开工时由 T-021 一次性建好，之后基本不动。这是本文档最有实用价值的一条。

### 3.5 依赖方向规则（eslint 强制）

```
features/*  ──可以──>  app/ · lib/ · components/ui · components/common · @openmemo/shared
features/A  ──禁止──>  features/B          ★ 横向依赖，需要复用就走"提升"
components/ui ──禁止──> features/* · lib/api    （保持纯展示，可独立预览）
components/common ──禁止──> features/*
lib/*       ──禁止──>  features/* · components/*
```

用 `eslint` 的 `no-restricted-imports` + `patterns` 实现（规则由 T-021 落在 `eslint.config.js`，需向 `oss-scout` 申报，因为根配置归他）。
**理由**：横向依赖是"三个人并行 → 一周后合不进去"的最常见死法。禁止它，复用只能走提升，提升要申报——冲突就被结构性消灭了。

### 3.6 命名约定

| 类型 | 约定 | 例 |
|---|---|---|
| 组件文件 | `PascalCase.tsx`，一个文件一个默认导出组件 | `TranscriptList.tsx` |
| hooks | `use*.ts` | `useActiveSegment.ts` |
| Zustand | `*.store.ts`，导出 `use<Name>Store` | `player.store.ts` |
| Query hooks | `api.ts` 内，`useXxxQuery` / `useXxxMutation` | `useNotesQuery` |
| 路由片段 | `<Name>.routes.tsx` | `Notes.routes.tsx` |
| SSE 片段 | `sse.ts`，导出 `<name>Sse` | `models/sse.ts` |
| 类型 | 与 `@openmemo/shared` 同名类型**禁止本地重定义**，一律 import | — |
| i18n key | `<feature>.<区块>.<语义>` | `capture.urlInput.placeholder` |
| test id | `data-testid="<feature>-<element>"` | `capture-submit` |

---

## §4 关键交互设计

### 4.1 F1 链接导入：全过程进度反馈

**状态机（用户视角，与 `JOB_STATES` 一一对应）**

```
输入URL ─校验─> 解析中(probe) ─> 确认卡片 ─用户点开始─> queued ─> running(下载→抽音轨→切分→转写→结构化) ─> succeeded
   │失败              │失败                                    │           │
   ▼                  ▼                                        ▼           ▼
INPUT_URL_INVALID   无法解析（给"改用本地文件"出口）          blocked   failed(可重试/部分成功)
```

```
┌─ /capture ─────────────────────────────────────────────────────────────────────┐
│                                                                                │
│   把链接粘到这里，或把文件拖进来                                                  │
│  ┌──────────────────────────────────────────────────────────────┐ ┌──────────┐ │
│  │ https://www.youtube.com/watch?v=…                            │ │  开始    │ │
│  └──────────────────────────────────────────────────────────────┘ └──────────┘ │
│   支持 YouTube / Bilibili / 播客 / RSS / 直链 · 或拖入本地音视频                  │
│                                                                                │
│  ┌─ 解析结果（probe 秒级返回，**先于下载**）──────────────────────────────────┐  │
│  │ ┌──────┐  深度学习导论 第 3 讲：反向传播                                  │  │
│  │ │ 封面 │  某某大学 · 1:47:32 · 来源 youtube                              │  │
│  │ └──────┘                                                                 │  │
│  │  转写模型 [large-v3-turbo Q5_0 ▾]  ✅ 可流畅运行     语言 [自动检测 ▾]     │  │
│  │  ☑ 说话人分离   ☐ 保留视频（+1.2 GB）   ☑ 完成后生成摘要与思维导图         │  │
│  └──────────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────────┘
```

**为什么 probe 必须先行且单独展示**（D-01 §5 F1）：拿到标题/时长/封面只要秒级，用户立刻知道"认对了没有"；
而"需要登录/格式不支持"这类失败也在此刻暴露，而不是下了 400MB 之后。

**开始后立即跳转到 `/notes/:noteUid`**（笔记已建，只是还没内容），顶部挂进度条：

```
┌─ /notes/01J8… ──────────────────────────────────────────────────────────────────┐
│ ⏳ 转写中 · 第 37/128 段 · 约 6 分钟  [暂停] [取消]        ▸ 可以关闭此页面，任务会继续 │
│ ████████████░░░░░░░░░░░░░░░░░░░░░░░░░░  29%                                      │
├─────────────────────────────────────────────────────────────────────────────────┤
│  深度学习导论 第 3 讲：反向传播                            [⭐] [🏷 加标签] [⋯]    │
│                                                                                 │
│  00:00  好，我们上节课讲到了前向传播…                    ← 转写结果**逐段浮现**    │
│  00:14  那么今天要解决的核心问题是…                                              │
│  00:31  ▌                                                  ← 光标位置示意正在转   │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

**六条硬规则**
1. **阶段名说人话**：`fetch/demux/vad/asr` → "下载中 / 提取音轨 / 分析语音 / 转写中 / 整理笔记"。
2. **边转边看**：`transcribe.segment` 一到就追加渲染。这是相对 memo.ac 的体感差异点——不是"等 40 分钟看结果"，是"14 秒后就有字"。
3. **"可以关闭此页面"必须写出来**（§4.5）。用户默认认为关页面 = 任务没了。
4. **ETA 只在有依据时显示**，且四舍五入到"约 X 分钟"。**不显示"剩余 03:47"这种假精确**——RTF 会波动。
5. **暂停/取消 200ms 内必须有视觉反馈**（按钮转"正在停止…"），否则用户会连点。
6. **部分成功要能看**：failed 时前 36 段仍完整显示，配一条"转写在第 37 段失败 · [从这里继续] [查看原因]"。

**批量（拖 50 个文件）**：不在页面里堆 50 张卡片，折叠成一行 `批量导入 · 12/50 完成 · [展开]`，明细进任务中心。（对冲 R-01 §C11 #11：memo.ac 批量 300+ 视频白屏卡死。）

### 4.2 F2 本地媒体导入

复用 F1 的确认卡片与进度呈现，差异只在**入口与上传阶段**：

```
拖拽悬停时整个窗口出现虚线边框 + "松开以导入"
     ↓
逐文件：上传中 12% ──> 已上传，排队中 ──> 与 F1 完全相同的后续
     ↓ 大文件（>500MB）
明确显示 "正在复制到 OpenMemo 数据目录"，并给出"完成后删除原文件"选项（默认关）
```
- **必须解释为什么要"上传"本地文件**：一句副文案"浏览器出于安全限制无法直接读取本地路径，文件会被复制到数据目录"。不解释的话用户会困惑"我文件就在本机为什么要传"。
- 分块上传支持断点（D-01 §5 F2），刷新页面后可续。

### 4.3 F3 录音：授权、波形、流式字幕、两阶段

**麦克风权限三态**（不同浏览器恢复路径不同，必须分别给指引）

```
┌─ 未授权 ────────────┐  ┌─ 已授权 ──────────┐  ┌─ 被拒绝（最容易卡死用户）──────────┐
│  🎙                 │  │ 设备 [MacBook麦▾] │  │ ⚠ 浏览器已阻止麦克风              │
│  开始录音需要麦克风   │  │ 电平 ▁▃▅▇▅▃▁     │  │ 点击地址栏左侧的 🔒 → 麦克风 → 允许│
│  [ 允许并开始 ]      │  │ [ 开始录音 ]      │  │ 然后 [ 重新检测 ]                 │
└─────────────────────┘  └───────────────────┘  └───────────────────────────────────┘
```
> ⚠️ 若 daemon 端口发生过漂移（ADR-006 决策 2），此处**必须**额外显示：
> "端口已从 17650 变为 17652，浏览器会把它当作新站点，需要重新授权麦克风。"

**录音中**

```
┌─ /record ───────────────────────────────────────────────────────────────────────┐
│  ● 录音中  12:47                                        [暂停] [■ 停止并转写]     │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │  ▁▂▃▅▇▅▃▂▁▂▄▆▇▆▄▂▁▃▅▇▅▃▁▂▄▆█▆▄▂▁                    ← 实时波形（canvas 直写）│  │
│  └───────────────────────────────────────────────────────────────────────────┘  │
│                                                                                 │
│  12:31  所以这里的关键在于梯度的方向                    ← final：正常字重          │
│  12:39  我们可以把它理解成一个                          ← final                  │
│         下降的过程 那么                                 ← partial：灰色 + 斜体    │
│                                                                                 │
│  ⓘ 实时字幕使用快速模型，停止后会自动用更准确的模型重听一遍                        │
└─────────────────────────────────────────────────────────────────────────────────┘
```

**★ 两阶段（流式 → 离线重跑）的呈现 —— 这是本节的产品重点**

D-01 §5 F3 设计了"流式出稿 → 停止后用离线大模型重跑覆盖"。这个设计如果不说清楚，用户会以为**软件在乱改自己的字**。呈现规则：

1. **录音过程中就预告**：底部常驻那句 `ⓘ 实时字幕使用快速模型，停止后会自动用更准确的模型重听一遍`。**先说，别等事后解释。**
2. **partial 与 final 视觉分离**：partial 灰色斜体（"还没定稿"的通用语义），final 正常。**不用动画/闪烁**（`prefers-reduced-motion` 且干扰阅读）。
3. **停止后进入重跑**，不遮挡内容：
   ```
   ┌───────────────────────────────────────────────────────────────────────┐
   │ 🔄 正在用 large-v3-turbo 重新识别，以获得更准确的结果…  68%  [跳过]     │
   │    你现在看到的是快速模型的初稿，可以先编辑，编辑不会被覆盖。            │
   └───────────────────────────────────────────────────────────────────────┘
   ```
4. **覆盖时保留用户编辑**（D-01 §5 F3 已定：按段 diff，只覆盖未编辑段），完成后给可关闭的结果条：
   ```
   ✅ 已更新 47 段转写 · 你编辑过的 3 段已保留 · [查看改动] [撤销这次更新]
   ```
   `[查看改动]` 打开逐段 diff（旧→新）。**"撤销"必须存在**——否则"重跑让结果变差了"就无解（旧稿在 DB 里 `is_active=0`，D-02 §1.5 已支持）。
5. **允许跳过**：`[跳过]` 保留初稿。用户赶时间时不该被强制等待。

### 4.4 F5 转写稿 ↔ 音频时间轴双向联动

```
┌─ /notes/01J8…?tab=mindmap&t=754000 ─────────────────────────────────────────────────┐
│  深度学习导论 第 3 讲                                    [⭐][🏷 机器学习 ×][⋯]      │
├──────────────────────────────────────────┬──────────────────────────────────────────┤
│ 转写稿      [🔍段内搜索] [跟随播放 ✅]     │  [ 摘要 | 思维导图 | 笔记 ]              │
│ ┌──────────────────────────────────────┐ │  ┌────────────────────────────────────┐ │
│ │ ⬤张老师 12:22  这里的关键在于…        │ │  │        （T-023 的导图组件）          │ │
│ │ ⬤张老师 12:31  我们把它理解成…        │ │  │   节点右上角有 ⏱ 角标 → 点击 seek    │ │
│ │▶⬤张老师 12:34  ██梯度██ 下降的过程    │ │  │                                    │ │
│ │        ↑当前段高亮 + 词级 karaoke     │ │  └────────────────────────────────────┘ │
│ │ ⬤学生A  12:47  老师那如果…            │ │                                          │
│ │  ⚠ 12:52  （检测到重复，可能是幻觉）   │ │  笔记正文里的 ⏱12:34 锚点点击也能 seek   │
│ └──────────────────────────────────────┘ │                                          │
├──────────────────────────────────────────┴──────────────────────────────────────────┤
│  ▶  12:34 / 1:47:32   ▁▃▅▇▅▃▁▂▄▆█▆▄▂▁▃▅▇▅▃▁▂▄▆█▆▄▂▁▃▅▇▅▃▁▂▄▆█▆▄▂▁    1.0× 🔊       │
│                                    ▲playhead    （已播=accent，未播=muted，2px 游标）│
└─────────────────────────────────────────────────────────────────────────────────────┘
```

**交互契约**

| 动作 | 结果 |
|---|---|
| 播放推进 | 二分查找当前段 → 高亮 + （若开"跟随"）滚动到视野中部；有 `words_json` 时词级 karaoke |
| **用户手动滚动** | **自动关闭"跟随播放"**并把开关变灰 —— 经典细节：不做的话用户往回翻会被强行拽回来 |
| 点转写段 | `audio.currentTime = start_ms/1000`；不自动播放（尊重当前播放态） |
| 点笔记锚点 / 导图节点 ⏱ | 同上，来源分别是 `note_anchors` / `mindmap_node_refs`（D-02 §3.3） |
| 拖波形 | 像素 → 时间 → seek |
| 双击段落文本 | 进入编辑（乐观更新）；`Esc` 取消，`⌘Enter` 保存 |
| 选中文本 → 浮起工具条 | 「引用到笔记（带时间戳）」「复制」「作为导图节点」 |
| `Space` / `←→` / `J K L` | 播放暂停 / ±5s / 后退-暂停-前进（视频编辑通用手势） |
| ⚠ 幻觉标记（`flags` bit0） | 段落左侧黄色竖条 + 悬浮"疑似重复，[仅重跑此段]" |

**性能硬要求**：转写稿必须虚拟滚动（3 小时 ≈ 3000+ 段）；高亮变更只重渲染**受影响的两段**，不是整列表（§2.4）。

### 4.5 长任务后台化：任务中心

用户的真实心智是"关掉页面 = 任务没了"。事实相反（任务在 daemon），所以**产品必须主动告知**。

```
顶栏徽标：[⚡ 2]  ← 有活跃任务时出现，数字 = running+queued，点击展开抽屉
```
```
┌─ 任务中心（右侧抽屉）─────────────────────────────────────────┐
│  进行中 (2)                                    [全部暂停] [⋯] │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ 🎬 深度学习导论 第 3 讲                                  │ │
│  │    转写中 · 37/128 段 · 约 6 分钟                        │ │
│  │    ████████████░░░░░░░░░░░░░░░░  29%      [⏸] [✕]      │ │
│  ├─────────────────────────────────────────────────────────┤ │
│  │ 📦 whisper large-v3-turbo (Q5_0)                        │ │
│  │    下载中 · 412 MB / 574 MB · 8.2 MB/s · 来源 modelscope│ │
│  │    ██████████████████████░░░░░░  72%      [⏸] [✕]      │ │
│  └─────────────────────────────────────────────────────────┘ │
│  等待中 (1)   ▸ 播客 EP.42（等待"转写"通道空闲）               │
│  需要处理 (1) ▸ ⚠ 会议录音 — 磁盘空间不足  [清理空间] [重试]   │
│  已完成 (12)  ▸ [展开]                                        │
│                                                              │
│  ⓘ 任务在本地服务中运行，关闭浏览器或本页面都不会中断。         │
└──────────────────────────────────────────────────────────────┘
```

- **分组用 `JOB_STATES`**：进行中(`running`,`leased`) / 等待中(`queued`,`paused`) / **需要处理(`blocked`,`failed`)** / 已完成(`succeeded`,`cancelled`)。
- **"需要处理"排在已完成之前**，且顶栏徽标在有 `blocked`/`failed` 时变红。**`blocked` 必须带可点按钮**（D-01 §7.1 的 `remediation`）——这是"用户不碰命令行"的落地点。
- **回访续看**：任何时候进 `/notes/:uid`，未完成任务的进度条自动出现（数据来自 `qk.jobs`，与页面无关）。
- **等待原因要说清**：不是干巴巴的"排队中"，而是"等待『转写』通道空闲"（对应 D-01 §4.2 的 lane）。

### 4.6 F4 思维导图（IA 与共用规范；细节归 T-023）

- 两个入口：笔记详情右侧 Tab（内嵌、只读优先，可切编辑）与 `/notes/:uid/mindmap` 全屏编辑。
- 生成过程走 `mindmap.delta` **渐进渲染**（D-01 §5 F4）——不要转圈等 60 秒。
- **渲染器切换器**：`[编辑视图 mind-elixir] / [大纲视图 markmap]`，切到 markmap 时**必须提示损失**（D-02 §2.3 损失矩阵）：`该视图不显示 3 条关联线与节点样式`。
- 节点 ⏱ 角标 → seek（§4.4）。
- 导出走 `packages/mindmap` 直出（MD/OPML/FreeMind/JSON/SVG/PNG），**位图导出用 SVG 序列化 + scale，禁止 html2canvas 截屏**（ADR-006 附注 / R-01 §C10 #8）。

---

## §5 错误与降级的 UI 呈现

### 5.1 四个呈现层级（选错层级本身就是 bug）

| 层级 | 用在哪 | 特征 |
|---|---|---|
| **内联**（字段旁） | 表单校验：URL 非法、路径不存在 | 红字 + 图标，不打断 |
| **区块错误** | 某个区域拉取失败（转写稿加载失败、目录拉不到） | 卡片内替换，带 [重试]，**其余页面照常可用** |
| **Toast** | 异步动作的结果通知（下载失败且不再重试、导出完成） | 5s 自动消失；**带动作的 toast 不自动消失** |
| **持久条幅** | 全局降级态：SSE 断开、磁盘将满、后端自检失败、端口漂移 | 顶部常驻，可折叠不可关闭（问题还在就不该消失） |
| **阻断对话框** | 只有两种：契约版本不匹配、数据库版本过新 | 除此之外**一律不要**阻断 |

### 5.2 错误映射表（`code` → UI）

`[已核实]` `code` 取自 `packages/shared/src/jobs.ts` 的 `ERROR_CODES` 与 D-01 §7.1 的分类前缀。

| code / 场景 | 层级 | 文案要点 | 动作按钮 |
|---|---|---|---|
| `NETWORK_TIMEOUT` / `CONNECTION_RESET`（`retryable`） | 无（静默重试） | 只在任务中心显示"重试中 2/5" | — |
| 下载多次失败 | Toast + 任务中心 | "下载失败：连接反复中断" | [换个下载源] [重试] |
| `CHECKSUM_MISMATCH` | 持久条幅 | **"文件校验未通过，已丢弃"**（绝不"凑合用"，ADR-004 决策 5） | [换源重下] [查看详情] |
| 磁盘不足（`blocked`） | 持久条幅 + 任务中心 | "需要 3.2 GB，可用 1.1 GB" | [清理空间]→`/settings/storage` |
| 后端未安装（`blocked`） | 区块 + 任务中心 | "转写需要先安装加速后端" | [去安装]→`/runtime` |
| 后端自检失败 | 持久条幅 | 显示**真实原因**（如"你的算力架构 sm_120 不被此构建支持"，对冲 R-01 §C11 #9） | [改用 CPU] [重试自检] |
| 自动降级发生 | Toast（一次性）+ 运行时页标记 | "CUDA 加载失败，已切换到 Vulkan" | [了解原因] |
| 无 LLM 可用 | 区块（导图 Tab 内） | "未配置 AI 模型，已生成基础大纲" | [配置 LLM]→`/settings/llm` |
| yt-dlp 需要登录 | 区块（捕获页） | "该视频需要登录才能访问" | [使用浏览器 Cookie] [改为拖入本地文件] |
| 端口漂移 | 持久条幅 | "端口已变更为 17652，**麦克风需要重新授权**" | [了解] |
| SSE 断开 | 持久条幅（黄） | "实时更新已断开，正在轮询" | 自动恢复 |
| `CONTRACT_VERSION` 不匹配 | **阻断对话框** | "前端与本地服务版本不一致" | [刷新页面] |
| 数据库版本过新 | **阻断** | D-01 §2.6 | [查看备份] |
| 安全模式 | 强制跳 `/diagnostics` | "OpenMemo 连续启动失败，已进入安全模式" | [导出诊断包] [重置后端选择] |

### 5.3 三条呈现原则

1. **降级必须可见**（D-01 §7.2）：绝不静默换后端/模型。用户不该靠"感觉变慢了"来发现。
2. **每个 `blocked` 都有按钮**：`remediation` 是一等公民。只给文字 = 没做到章程"不碰命令行"。
3. **错误文案三段式**：发生了什么 → 为什么 → 现在能做什么。**禁止**把 `error.detail` 原样甩给用户；技术细节折叠在 `[查看详情]` 里。

### 5.4 空态与首启

| 场景 | 呈现 |
|---|---|
| 零笔记 | 大号插画位 + "粘贴一个链接开始" + 输入框直接可用（**空态即入口**，不要只放一句"暂无数据"） |
| 零搜索结果 | 建议：换关键词 / 试试语义搜索 / 检查筛选条件 |
| 未装 ASR 模型 | 引导到 `/models` 的推荐项；同时说明"内置 CPU 后端可用，只是较慢"（L1 永不失败，ADR-006 决策 3） |
| 首启 | `/onboarding` 三步，**每步都能跳过**。R-04 §1.5 引述的经验：第一次不要让用户做任何配置决策 |

---

## §6 可访问性与国际化基线

### 6.1 i18n

- **默认 `zh-CN`，第二语言 `en`**（产品面向中文用户）。语言选择在顶栏 + `/settings/general`，存 `settings` 并落 localStorage 以便首帧不闪。
- **key 命名**：`<feature>.<区块>.<语义>`，禁止用中文原文当 key（改文案就得改所有引用）。
- **复数与插值**必须用库的能力，禁止字符串拼接（中文无复数但英文有）。
- **数字/日期/相对时间/字节**一律走 `Intl`（`NumberFormat` / `DateTimeFormat` / `RelativeTimeFormat`），封装在 `lib/format/`。**禁止各 feature 自己写"3 分钟前"**。
- **时间码格式**（`HH:MM:SS` / `MM:SS`）不随 locale 变，属于媒体惯例，单独实现。
- **选型建议：`i18next` + `react-i18next`** `[版本已核实]`

  | 候选 | 版本 | 事实 |
  |---|---|---|
  | **`react-i18next`** | **17.0.11** | ⚠️ peer 要求 **`i18next >= 26.2.0`** —— **版本联动，不能配旧 i18next**，装错会在运行时静默出错 |
  | `i18next` | 26.3.6 | 纯运行时，JSON 词条，**无编译步骤** |
  | `@lingui/core` | 6.6.0 | peer 含 `babel-plugin-macros`，且需 `@lingui/cli` 做 extract + compile **两步编译**（`[文档]` 级） |
  | `typesafe-i18n` | 5.27.1 | 需要常驻 generator 进程生成类型（`[文档]` 级） |

  选 i18next 的理由：**它是唯一零编译步骤的方案**。Wave 3 有三个任务并行，多一个代码生成步骤就多一处"我本地能跑你那儿不行"。类型安全的收益抵不上并行期的构建复杂度。
- **`Intl.RelativeTimeFormat` / `Intl.NumberFormat` 无需 polyfill** —— 均已 Baseline widely available 多年（`[文档]` 级，来自 caniuse）。
- 无论选谁，**必须封装在 `app/i18n/`**，feature 只用 `t()`，以便日后更换。

### 6.2 服务端文案与客户端文案的边界（**有张力，需 Manager 裁决**）

`packages/shared` 的 `ApiErrorBody` 是 `{ code, message, messageZh, retryable, details? }` —— **把 zh/en 两种文案硬编码在后端**。

| 问题 | 说明 |
|---|---|
| 加第三种语言要改后端 | 语言与业务逻辑耦合 |
| 前端无法按上下文调整措辞 | 同一个 `DISK_FULL` 在下载页和转写页该说的话不同 |
| 文案分散在两个仓位置 | 翻译工作流会割裂 |

**我的建议 `[设计]`**：
- **前端优先用 `code` 查本地文案表**（`errors.<CODE>.title/detail/action`）；
- `message`/`messageZh` **仅作未知 code 的兜底**（前端版本旧、后端加了新 code 时不至于白屏）；
- `details` 作为插值参数（如 `{requiredBytes, freeBytes}`）——这要求后端把参数**结构化**给出，而不是拼进 message。

→ 需 Manager 协调 `model-mgmt` 确认（§10 决策项 3）。**在裁决前，T-021/T-022 一律先按"code 查本地表 + message 兜底"实现**，这样两种裁决结果都能兼容。

### 6.3 可访问性基线（三个任务的验收项）

| 项 | 要求 |
|---|---|
| 键盘 | 所有交互可 Tab 到达；焦点顺序符合视觉顺序；`Esc` 关闭浮层；**焦点陷阱**只在模态里 |
| 焦点可见 | 统一 `:focus-visible` 环（§7 令牌 `--ring`），**禁止 `outline: none` 不补替代** |
| 语义 | 用 `<button>`/`<nav>`/`<main>`/`<h1-h3>`；`div` + `onClick` 一律不通过评审 |
| 动态通知 | 任务进度 → `aria-live="polite"`；错误 → `aria-live="assertive"`。**但进度不要每 250ms 播报**——只在阶段切换与终态播报 |
| 虚拟列表 | 转写稿用 `role="list"`/`listitem`，并提供"跳到转写稿"跳转链接 |
| 播放器 | 原生 `<audio controls>` 作为无障碍回退可用；自定义控件必须有 `aria-label` 与快捷键说明 |
| 颜色 | **状态绝不只用颜色**：图标 + 文字标签同时出现（与 §7 状态色规则一致——明档 warning/serious 对比度 <3:1，就是靠图标+标签兜底） |
| 对比度 | 正文 ≥ 4.5:1，大字/图形 ≥ 3:1（§7 已按此选值并**跑脚本验证**） |
| 动效 | 尊重 `prefers-reduced-motion`：关闭位移与缩放动画，保留透明度 |
| 缩放 | 200% 缩放下不横向滚动、不截断 |
| 语言标注 | `<html lang>` 随 locale 变；转写稿容器按 `transcripts.language` 标 `lang` |

---

## §7 设计令牌（无 UI 库依赖）

> **这些值不是目测的。** 颜色取自经过校验的参考调色板，并且我**实际运行了校验脚本**
> （六项检查：明度带、彩度下限、CVD 相邻分离、常视觉分离、对比度）。输出见 §7.5。

### 7.1 表层与墨色

> 🔄 **本表已被回写更新（2026-08-03，见 §7.1b 变更说明）。下面就是当前代码里的真值** ——
> `apps/web/src/styles/tokens.css`。**旧值不要再照抄**，它已经不在代码里了。

| 角色 | 令牌 | 亮色 | 暗色 |
|---|---|---|---|
| 页面底板 / 卡片内的内嵌字段（输入框、pre、标签片） | `--surface-0` | `#edf0f5` | `#14161d` |
| 卡片 / 侧栏 / 顶栏 | `--surface-1` | `#ffffff` | `#242732` |
| 抬升（弹层/抽屉/toast） | `--surface-2` | `#ffffff`（**与 surface-1 同值**） | `#242732`（**同值**） |
| hover 填充 | `--fill-hover` | `rgb(15 23 42 / 6%)` | `rgb(255 255 255 / 7%)` |
| 按下填充 | `--fill-active` | `rgb(15 23 42 / 9%)` | `rgb(255 255 255 / 10%)` |
| 主文字 | `--ink-primary` | `#161a23` | `#f2f4f9` |
| 次文字 | `--ink-secondary` | `#4a5263` | `#c3c9d6` |
| 弱化（占位/轴标/说明正文） | `--ink-muted` | `#576170` | `#9da9be` |
| 分隔线 | `--line` | `#d8dee8` | `#383c4a` |
| 边框环 | `--border` | `rgb(15 23 42 / 12%)` | `rgb(255 255 255 / 12%)` |

**★ 两条随本表一起失效的旧规则**（照旧规则写出来的代码现在是错的，不是过时而已）：

1. **不要再用"表层差一档"表达 hover / 选中。** 明暗两档现在都只有**两级**表层
   （`--surface-2 === --surface-1`），`hover:bg-surface-2` 压在 `bg-surface-1` 上实测 **1.02:1**
   = 完全没有反馈。hover/按下一律用 `--fill-hover` / `--fill-active`（半透明，压在任何一层上都成立），
   选中态用品牌淡底 `--accent-tint`（**选中是语义，不是层级**）。
2. **抬升靠阴影，不靠提亮。** 明档卡片已经是纯白，没有"更亮的一档"可给弹层；
   暗档面色的上限是被 3:1 卡死的（面亮到 `#262a36` 时主按钮块面与 critical 实心块**同时**跌到 2.98:1）。
   弹层用 `--shadow-2` + `--line`。`--surface-2` 这个名字保留，是为了让 7 处弹层调用点仍有语义钩子。

### 7.1b 变更说明 —— 这两张表为什么被改（不要静默覆盖，所以留在原处）

| | |
|---|---|
| **谁改的** | `handoff` agent 执行回写；新取值与实测出自 `ui-polish`（T-124） |
| **什么时候** | 2026-08-03（T-124 代码落地 `6b1cac0`；T-131 裁决回写本文档） |
| **依据哪次实测** | `ui-polish` T-124：Playwright/Chromium 像素取样 + `apps/web/src/styles/tokens.contrast.test.ts` 从 `tokens.css` **现场解析**的 88 对对比度断言（T-114 时是 64 对）。逐条过程见 `docs/design/D-09-ui-gap.md` §8 与 `coordination/inbox/ui-polish.md`（2026-08-03 19:45 / 19:55 两条） |
| **裁决** | **D-09 §8 是现行事实，回写 D-05。** 本表即回写结果 |

**为什么是"改规范"而不是"代码违反了规范"** —— 这一条值得下一个人读完：

原 §7.2 的表层三档（`#f9f9f7` / `#fcfcfb` / `#ffffff`）在明档实测**两两只有 1.03:1**。
也就是说，本节承诺的"三级抬升"**在亮色主题里从未真正存在过** ——
它不是一条被违反的规范，而是**一条描述了不存在事实的规范**。
`hover:bg-surface-2`（1.02:1）与侧栏选中态（同色于 hover）这两处"看不见的交互态"，
是照着这条规范一字不差写出来的，**代码没错，规范错了**。

它能活这么久，是因为当时全部对比度断言管的都是**"前景 vs 背景"**（文字压在底上够不够 4.5:1），
而这里坏掉的是**"背景 vs 背景"** —— 没有任何一条断言在看这件事，
所以三档挤成一档这件事**既没有红灯、也没有人肉眼看得出来**（1.03:1 本来就是看不出来的意思）。

> **★ 规矩：规范和现实冲突时，先问哪一个是错的，别默认是代码错了。**
> 一条从未被任何断言覆盖过的规范，很可能从落笔那天起就是错的。
> 判据补上了：新增的表层可分辨性断言阈值 `SURFACE_MIN = 1.06`，
> **明确标注为本仓库自定、不是 WCAG**（标准里没有"两块背景要差多少"这一项），不冒充无障碍标准。

### 7.2 品牌与状态

> 🔄 **品牌三行已被回写更新（同 §7.1b）。四个状态锚点一个字没动。**

| 角色 | 令牌 | 亮色 | 暗色 | 说明 |
|---|---|---|---|---|
| 主色/强调（**块面色**） | `--accent` | `#575bc7` | `#6268d5` | 主按钮底、播放进度。判据「白字压在上面 ≥ 4.5:1」→ 实测明 5.64:1 / 暗 4.71:1 |
| 主色前景 | `--accent-fg` | `#ffffff` | `#ffffff` | |
| 主色**文字色** | `--accent-ink` | `#5457c4` | `#a9aef5` | 链接、选中项文字。判据「对最不利表层 ≥ 4.5:1」**且**压得住 `--accent-tint` |
| 品牌淡底 | `--accent-tint` | `#e2e4fa` | `#2a2e5c` | 选中项 / 搜索命中 / 拖放目标 / 存储条底。**原名 `--accent-track`，已更名** |
| 焦点环 | `--ring` | `var(--accent-ink)` | `var(--accent-ink)` | 2px + 2px offset |
| 成功 | `--status-good` | `#0ca30c` | `#0ca30c` | **状态色四个都不随主题变** |
| 警告 | `--status-warning` | `#fab219` | `#fab219` | |
| 严重 | `--status-serious` | `#ec835a` | `#ec835a` | |
| 危险/失败 | `--status-critical` | `#d03b3b` | `#d03b3b` | |

> **状态色的硬规则**：`--status-warning`（明档 1.79:1）与 `--status-serious`（明档 2.57:1）
> **在亮色背景上达不到 3:1，这是设计取舍不是疏漏** —— 缓解手段是**强制配图标 + 文字标签**（§6.3）。
> 因此：**任何状态指示都不许只有一个彩色圆点。** 这条同时是 a11y 要求和视觉规范。
> 状态色也**不得**被拿来当"第 5 个分类色"，否则状态语义就废了。

> **⚠️ 上面四个是"锚点"，不是可以直接拿去当文字色的值。**
> T-114 实测：整个应用把它们当文字色在用（`text-warning` 等 54 处），而文字要 4.5:1 ——
> 明档 warning 1.74 / serious 2.50 / good 3.18 / accent 4.19，**四个全不达标**。
> 因此每个语义色现在有**四层展开**（`-ink` 文字 / `-tint` 淡底 / `-line` 描边 / `-solid` 实心块），
> 各有各的达标线；另新增第 5 个语义位 `--status-info`（"正在发生"，明 `#2570cd` / 暗 `#3987e5`）。
> **这一层的完整取值与判据在 `docs/design/D-09-ui-gap.md` §7，本节不复制**（复制就会漂移）。
> `--status-info` 必须与 `--accent` 分家：品牌换靛紫之后，**靛紫 = 品牌与可点，蓝 = 正在发生**。

### 7.3 数据展示（进度条 / 存储分解 / 波形）

| 元素 | 规格 |
|---|---|
| **进度条（meter）** | 高 6px（行内）/ 8px（抽屉）；**填充端 4px 圆角、基线端方角**；填充按严重度 `accent → warning → critical`。⚠️ **轨道色已变更**：本表原写"同色系更浅一档（亮 `#cde2fb` / 暗 `#184f95`）"，T-114 起改为跟着 tone 走的 `--status-*-tint` / `--accent-tint`（判据见 D-09 §7.5），**这两个十六进制值已不在代码里** |
| **存储分解条** | 水平堆叠，**厚度 ≤ 24px**；**段与段之间 2px 表层色缝隙**（不是描边）；分段用下表 4 色；**必须配图例 + 字节数标签** |
| **波形** | 已播 = `--accent`；未播 = `--ink-muted`（约 40% 不透明）；游标 2px `--accent`；选区 = accent 10% 洗；峰值来自预计算 `peaks`（D-02 §3.4），**不在浏览器解码音频**。落地细节见 §7.3a |
| **说话人色条** | 用分类槽 1–8 的固定顺序分配，**按说话人实体分配、绝不按当前排名循环**；配文字标签 |
| **稀疏值** | 未测量的指标（如未跑基准的模型速度）显示 **"未测量"**，不显示 0、不显示占位数字（ADR-004 决策 3） |

**分类分段色（存储分解 / 说话人，固定顺序，不得循环）**

| 槽 | 语义示例 | 亮色 | 暗色 |
|---|---|---|---|
| 1 | 模型 | `#2a78d6` | `#3987e5` |
| 2 | 加速后端 | `#eb6834` | `#d95926` |
| 3 | 媒体文件 | `#1baf7a` | `#199e70` |
| 4 | 缓存/临时 | `#eda100` | `#c98500` |

> 超过 4 类 → 归入"其他"，**不要新造颜色**。

### 7.3a 波形落地：wavesurfer.js v7 的两个关键选项 `[已核实]`

> ### ⚠️ 2026-08-06 订正：**落地时没有用 wavesurfer，自己写了 canvas**
>
> 本节下面这句「**不需要我们自己写 canvas**」**已经不成立** —— 实现走的正是另一条路。
>
> `[实测]` HEAD `fca18f6`：`wavesurfer.js` 在 `apps/web/package.json:43` 里声明着，
> 而**全仓零 import**（剥注释后 `.ts/.tsx` 全库 0 命中；只在本节、`peaks.ts` 的注释、
> `R-03` 的许可证表里被"提到"）。这个依赖从**第一个脚手架提交**（`4018e23` T-011）就在，
> 一次没被用过。
>
> 真正在画波形的是 `apps/web/src/features/player/Waveform.tsx`，**手写 canvas**，
> 它的文件头写着刻意的理由：「**canvas 直写，完全不进 React。**
> 播放位置以 ~10Hz 变化，走 React 会拖垮整页。」—— 这个约束 wavesurfer 的 React 用法满足不了，
> 所以这不是"忘了用"，是**一个没有被写下来的相反决定**。
>
> 本节仍然成立的部分：**`.ompk` → 每声道归一化 −1..1 数组**这层转换（`lib/format/peaks.ts`）
> 仍然存在、且现在真的在产品路径上（`NoteDetailPage.tsx:93` 是它的第一个调用方），
> 只不过消费方是我们自己的 canvas，不是 wavesurfer。
> **「不在浏览器解码音频」这条设计要求也仍然成立且做到了。**
>
> **待决**：`wavesurfer.js` 这个依赖要么用起来（唯一还说得通的理由是它的
> `regions/timeline` 插件 —— 转写稿↔音频的段落高亮还没做），要么下掉。
> 见 `coordination/inbox/debt-cleanup.md`。**本轮没有替 `apps/web` 做这个决定。**

D-01/D-02 的设计要求"绝不在浏览器解码音频"（2 小时文件 `decodeAudioData` 会吃几百 MB 内存并阻塞主线程）。
核实结果（**写作当时**）：**wavesurfer.js v7.12.11 原生支持这两点**，不需要我们自己写 canvas：

| 选项 | 类型 | 用途 |
|---|---|---|
| `peaks` | `(Float32Array \| number[])[]` —— **二维，每声道一个数组** | 直接喂预计算峰值，**跳过解码**。必须同时给 `duration` |
| `media` | `HTMLMediaElement` | 绑定我们自己的 `<audio>`（指向 `/media/asset/<uid>`），而不是让它自建媒体元素 → 播放控制、Range 请求、cookie 鉴权全部仍由我们掌握 |

插件路径（`[文档]` 级，未逐一在源码确认）：
`wavesurfer.js/dist/plugins/{regions,timeline,minimap}.esm.js`

⚠️ **一处必须做的格式转换**：我们的 `peaks.ompk`（D-02 §3.4）存的是 **Int8 的 min/max 对**，
而 wavesurfer 期望 **归一化到 −1..1 的 Float32 每声道数组**。
→ `lib/format/peaks.ts` 负责 `ompk → Float32Array[]`（`v / 127`）。**这层转换属于共享工具，不放 feature 里**。
若日后换掉 wavesurfer，只有这一个文件和 player feature 受影响 —— `.ompk` 格式本身不绑任何库。

### 7.4 尺度

```
间距 (4px 基)   --space-{0,1,2,3,4,5,6,8,10,12,16} = 0,4,8,12,16,20,24,32,40,48,64 px
圆角            --radius-{sm,md,lg,xl,full} = 4,6,8,12,9999 px
字号            --text-{xs,sm,base,md,lg,xl,2xl,hero} = 12,13,14,16,18,20,24,48 px
行高            正文 1.6；转写稿 1.75（长时间阅读）；标题 1.25
字重            400 / 500 / 600（不用 700 以上）
字体            system-ui, -apple-system, "Segoe UI", "PingFang SC",
                "Microsoft YaHei", "Noto Sans SC", sans-serif      ← 中文回退必须显式列出
数字            默认比例数字；**仅**表格列与时间码用 font-variant-numeric: tabular-nums
阴影            --shadow-{1,2}：极轻，只给浮层；卡片用 --line 分隔，不用阴影堆叠
动效            --dur-{fast,base,slow} = 120,180,240 ms；缓动 cubic-bezier(.2,0,0,1)
z-index         内容 0 · 吸顶 10 · 抽屉 30 · 弹层 40 · Toast 50 · 阻断对话框 60
断点            单一桌面优先；≥1280 双栏，1024–1280 折叠右侧 Tab，<1024 单栏堆叠
```

### 7.5 落地形态与校验记录

- 令牌以 **CSS 自定义属性**写在 `apps/web/src/styles/tokens.css`，**不依赖任何 UI 库**（本节标题的要求）。
- 暗色**必须同时**声明在 `@media (prefers-color-scheme: dark)` 与 `:root[data-theme="dark"]` 两个作用域，且让手动切换在两个方向都能压过系统设置。

**Tailwind v4 接法** `[已核实：tailwindcss.com/docs/theme + /docs/dark-mode + /docs/upgrade-guide]`

v4 是 CSS-first 配置，但有一个**关键限制会直接影响我们**：

> `@theme {}` 里的变量**必须写在顶层**，不能嵌套进选择器或媒体查询。

也就是说 **不能**把明/暗两套值都塞进 `@theme`。正确做法是**两层结构**：

> ⚠️ **下面这段 CSS 是在演示"两层结构"这个手法，里面的十六进制值是 2026-08-02 的旧值，
> 已被 §7.1/§7.2 回写取代。** 手法仍然成立，**别照抄值** —— 真值只有一处：`apps/web/src/styles/tokens.css`。

```css
/* apps/web/src/styles/tokens.css —— 第 1 层：语义令牌（唯一真值来源，纯 CSS，零库依赖） */
:root {
  --surface-1: #fcfcfb;  --ink-primary: #0b0b0b;  --accent: #2a78d6;  /* ← 旧值，仅作结构示意 */
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) {
    --surface-1: #1a1a19; --ink-primary: #ffffff; --accent: #3987e5;  /* … */
  }
}
:root[data-theme="dark"] {
  --surface-1: #1a1a19; --ink-primary: #ffffff; --accent: #3987e5;    /* … */
}
```

```css
/* apps/web/src/index.css —— 第 2 层：把语义令牌转发给 Tailwind 生成工具类 */
@import 'tailwindcss';
@import './styles/tokens.css';

/* ★ 必须用 `@theme inline`：它让变量在**使用处**解析，
   于是 bg-surface-1 会跟随 :root / .dark 作用域切换；
   用普通 @theme 则在定义处求值，暗色永远不生效。 */
@theme inline {
  --color-surface-0: var(--surface-0);
  --color-surface-1: var(--surface-1);
  --color-ink-primary: var(--ink-primary);
  --color-accent: var(--accent);
  --color-status-good: var(--status-good);
  /* … */
  --radius-md: 6px;
  --text-transcript: 15px;
  --text-transcript--line-height: 1.75;
}

/* 手动主题切换：v4 没有 darkMode:'class' 这个 JS 配置项了，必须重定义变体 */
@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));
```

命名空间 → 工具类的对应关系（`[已核实]`，只列我们用到的）：

| `@theme` 前缀 | 生成的工具类 |
|---|---|
| `--color-*` | `bg-* / text-* / border-* / fill-*` |
| `--spacing-*` | `p-* / m-* / gap-* / w-* / h-*` |
| `--text-*`（+ `--text-<n>--line-height` 修饰符） | 字号 |
| `--radius-*` | `rounded-*` |
| `--shadow-*` | `shadow-*` |
| `--ease-*` / `--animate-*` | 过渡与动画 |
| `--breakpoint-*` | 响应式变体 |

其它已核实要点：
- **`tailwind.config.js` 仍受支持但 v4 不再自动探测**，要用必须在 CSS 里显式 `@config "…"`。我们**不用**它 —— CSS-first 一条路走到黑，避免两处配置漂移。
- v4 中 `corePlugins` / `safelist` / `separator` 三个 JS 配置项**已不支持**（safelist 改用 `@source inline()`）。
- `@custom-variant` 是**定义/重定义**变体；`@variant` 是在自定义 CSS 里**应用**已有变体。两者不是一回事，别写反。
- **无论 Tailwind 怎么接，`tokens.css` 的 CSS 变量都是唯一真值来源** —— Tailwind 大版本变动时只需重写第 2 层。

**校验脚本实测输出**（分类分段色，2026-08-02 本机运行）`[已核实]`

```
亮色（surface #fcfcfb）: #2a78d6,#eb6834,#1baf7a,#eda100
  [PASS] 明度带 · [PASS] 彩度下限
  [PASS] CVD 相邻分离   最差 #eda100↔#1baf7a ΔE 9.1 (protan)
  [PASS] 常视觉分离     最差 ΔE 22.9
  [WARN] 对比度         #1baf7a 2.74:1、#eda100 2.11:1 低于 3:1
        → 触发"救济规则"：必须配可见标签或表格视图（我们的图例已满足）
暗色（surface #1a1a19）: #3987e5,#d95926,#199e70,#c98500
  [PASS] 全部五项（对比度均 ≥ 3:1）
```

> 这条 WARN **不是可以忽略的**：它把"存储分解条必须带图例和数字标签"从审美建议变成了硬性要求。

---

## §8 与 `packages/shared` 实际契约的差异（需裁决，我不能自行修改他人文件）

`[已核实]` 读 `packages/shared/src/{api,events,jobs}.ts`（`model-mgmt` 独占，PROTOCOL 规则 3 禁止我修改）：

| # | D-01 写的 | `packages/shared` 实现的 | 影响 | 我的建议 |
|---|---|---|---|---|
| 1 | 路由前缀 `/api/v1/**` | `/api/**`（`ENDPOINTS` 表无版本段） | 前端 baseURL 二选一 | **以实现为准（`/api`）**，用 `CONTRACT_VERSION` 承担版本职责已足够；请 Manager 追认并订正 D-01 §3.1 |
| 2 | 错误信封 RFC 9457 `application/problem+json` + `remediation` 对象 | `{error:{code,message,messageZh,retryable,details?}}`，**无 `remediation` 字段** | §5.3"每个 blocked 都有按钮"落不了地——前端只能靠 `code` 硬编码动作 | 建议在 `ApiErrorBody.error` 加可选 `remediation?: {action, params}`。**这是章程要求 2.1「不碰命令行」的直接依赖** |
| 3 | 事件含 `transcribe.segment` / `mindmap.delta` / `job.progress`(通用) / `note.*` | `SSE_EVENT_TYPES` 只有 14 个，**全部是模型/下载/后端域** | **F1–F5 的实时反馈一个事件都没有**（§4.1 边转边看、§4.3 流式字幕、§4.6 渐进导图全部依赖它们） | **最高优先级**：需 `model-mgmt` 扩 `SSE_EVENT_TYPES` 与对应 payload 类型；否则 T-021/T-023 只能轮询，产品体验直接塌掉 |
| 4 | SSE 重放缓冲 2000 条 | `SSE_REPLAY_BUFFER_SIZE = 256` | 断线稍久必然丢事件 | **接受 256**（我在 §2.3 已设计"重连后全量失效"来兜底），订正 D-01 §3.3 |
| 5 | SSE 帧 `event: message` + `data.type` | `event: <type>` | 前端必须 `addEventListener` 逐类型 | **接受实现**，已写进 §2.3 并加粗标注为坑；订正 D-01 §3.3 |

> 差异 1/4/5 我建议**以实现为准**，D-01 由我订正；差异 2/3 需要 `model-mgmt` 改文件，**必须由 Manager 协调**。

---

## §9 待验证清单（诚实）

| # | 事项 | 影响 | 状态 |
|---|---|---|---|
| V-1 | Tailwind v4 `@theme` 写法、CSS 变量命名、暗色变体、是否需 `tailwind.config.js` | §7.5 | ✅ **已核实**（官方文档原文）。关键发现：`@theme` 不能嵌套 → 必须用 **`@theme inline` 两层结构**，否则暗色不生效 |
| V-2 | 路由库选型与版本 | §0.2 / §1.2 | ✅ **已核实**：`react-router` **8.3.0**（v8 移除 `react-router-dom`，`RouterProvider` 改从 `react-router/dom` 导入）；`@tanstack/react-router` 1.170.18 可手写路由树。**建议 react-router v8 Data 模式**。**已补装并在用**（`apps/web/package.json` → `react-router@^8.3.0`；`apps/web/src/main.tsx:29` `createBrowserRouter(routes)`）。**此前写着"仍需 `oss-scout` 补装"** |
| V-3 | i18n 库选型与版本 | §6.1 | ✅ **已核实**：`react-i18next` 17.0.11 + `i18next` 26.3.6（**peer 强制 i18next ≥26.2.0**）；lingui / typesafe-i18n 均需编译步骤。**已补装**（`i18next@^26.3.6` + `react-i18next@^17.0.11`，`apps/web/src/app/i18n/locales/{zh-CN,en}` 已建）。**此前写着"仍需补装"** |
| V-4 | shadcn/ui 的底层依赖 | §0.1 | ✅ **已核实，且结论出人意料**：默认底层库 2026-07-03 起为 **Base UI（`@base-ui/react` 1.6.0）**，非 Radix。Radix 仍可用（`init -b radix`）。**SOURCE.md 需订正** |
| V-5 | `navigator.locks`（Web Locks）跨浏览器支持，特别是 Safari | §2.3 多标签选主 | **仍待核实**；有 BroadcastChannel 降级与"仅支持单标签"两条退路 |
| V-6 | `wavesurfer.js` v7 的 `peaks` / `media` 选项 | §4.4 / §7.3a | ✅ **已核实**：`peaks?: (Float32Array\|number[])[]`（二维，配 `duration`）与 `media?: HTMLMediaElement` 均存在 → 两项需求都满足。插件路径为 `[文档]` 级 |
| V-7 | React 19 + StrictMode 下 EventSource 单例行为 | §2.3 | 未验证 |
| V-8 | 虚拟滚动库选型（3000+ 段转写稿） | §4.4 性能 | ✅ **已定并已装：`@tanstack/react-virtual@^3.14.9`**。**此前写着"未选型，需 T-021 定并向 `oss-scout` 申报依赖"** |
| V-9 | TanStack Query 的 SSE 官方模式 | §2.2/§2.3 | ✅ **已核实：不存在官方 SSE 指南**。`invalidateQueries` / `setQueryData` 两种手法是**社区共识而非官方定式**（我在 §2.3 的映射表按此诚实标注）。另：`experimental_streamedQuery` 确实存在，但它是给 `AsyncIterable` 流式 `queryFn` 用的（如 LLM 输出），**与"SSE 触发缓存失效"是两回事，不要混用** |
| V-10 | 本文所有线框、令牌落地、状态模式 | 全局 | **零代码执行**。仅 §7.5 的调色板校验是脚本实测 |

---

## §10 需要 Manager 决策的事项

见 `coordination/inbox/architect.md`。摘要：

1. ~~**`SSE_EVENT_TYPES` 缺 F1–F5 的全部事件**（§8 差异 3）—— 最高优先级，阻塞 T-021/T-023 的实时体验。~~
   ✅ **已完成，无需决策**：`SSE_EVENT_TYPES` 现有 **30** 个事件，F1–F5 全覆盖（`packages/shared/src/events.ts:31`）。
   **此前这条写着"缺 F1–F5 的全部事件"。**
2. **`ApiErrorBody` 是否加 `remediation`**（§8 差异 2）—— 直接关系章程要求 2.1。
3. **错误文案归属**：`code` 查前端表（我建议）vs 用后端 `message/messageZh`（§6.2）。
4. **补装前端依赖**（`apps/web/package.json` 归 `oss-scout`）：
   `react-router@^8.3.0` · `i18next@^26.3.6` + `react-i18next@^17.0.11`（**版本联动**）· shadcn 底层库（见第 7 项）· 虚拟滚动库（T-021 定）。
5. **多标签页策略**：Web Locks 选主（我建议）vs v1 只支持单标签（§2.3）。
6. **路由前缀 `/api` 追认**与 D-01 相应订正（§8 差异 1/4/5）。
7. **shadcn 底层库：Base UI（我建议，一个包）vs Radix（成熟，十几个包）**（§0.1）。
   附带：`apps/web/src/components/ui/SOURCE.md` 里"底层依赖：Radix UI Primitives"一行需按裁决结果订正（归 `oss-scout`）。

---

## §11 ★ F1–F5 SSE 事件规格（**交付给 `model-mgmt` 在 `packages/shared` 实现**）

> **状态**：ADR-007 决策 1 —— 规格由 `architect` 出，实现归 `model-mgmt`（他独占 `packages/shared`）。
> **本节即那份规格。** 现有 14 个模型/下载域事件保持不变，本节是**增量**。
> **诚实标记**：以下全部是 `[设计]`，尚无任何实现。payload 字段名一旦落地即为契约。

### 11.0 三条总则（先定规矩，再列事件）

| # | 规则 | 理由 |
|---|---|---|
| **1** | **事件分两类：`hint`（提示去拉数据）与 `data`（载荷即真相）。每个事件必须显式归类。** | D-01 §3.3 的"SSE 是提示不是数据源"原则需要可执行的判据。归错类会导致要么白白多拉、要么状态不一致 |
| **2** | **只有 `data` 类事件允许"必达且有序"，其余一律可丢可乱序。** 前端对 `hint` 类做去重合并即可 | 让服务端有明确的节流自由度：`hint` 随便合并，`data` 必须逐条发 |
| **3** | **所有事件带 `noteUid`（若与笔记相关）** | 前端要按笔记路由到不同页面/组件；没有它就得反查，多一次往返 |

**`data` 类事件只有三个**（其余全是 `hint`）：`transcribe.segment`、`mindmap.delta`、`summary.delta`。
它们是"增量内容流"，丢了就少一段文字，无法靠重拉便宜地补（重拉要传整篇）。
→ 这三个**不节流、不合并、带单调 `seq`**，前端按 `seq` 检测缺口，缺口则回退整篇重拉。

### 11.1 通用作业进度（改造既有 `job.progress`）

现有 `JobProgressEvent` 是**下载专用**的（`completedBytes`/`totalBytes`/`speedBps`）。
F1/F2 的流水线作业（下载→抽音轨→切分→转写→结构化）没有"字节"这个单位，
硬套会让前端要么显示 0 字节、要么另开一套事件——**两套词汇正是 `model-mgmt` 在 `JobState` 上已经避免过一次的错误**（见 `jobs.ts` 顶部注释）。

**建议：向后兼容地扩展，不新增事件名。**

```ts
export interface JobProgressEvent {
  type: 'job.progress';
  jobId: string;
  state: JobState;

  /* ── 新增：所有 job 都有的通用字段 ── */
  jobType: string;              // D-02 jobs.type，如 'import.url' | 'download.model'
  noteUid?: string;             // 与笔记相关时必填（总则 3）
  progress: number;             // 0..1，总体进度。前端进度条只认它
  step: string | null;          // D-02 jobs.current_step，如 'downloading' | 'asr'
  stepIndex?: number;           // 第几步 / 共几步，用于"3/7 抽取音轨"
  stepCount?: number;

  /* ── 既有：下载专用，改为可空 ── */
  completedBytes: number | null;
  totalBytes: number | null;
  speedBps: number | null;
  etaSeconds: number | null;
}
```

- **`progress` 是必填的唯一进度真相**；`completedBytes` 等只在 `jobType` 以 `download.` 开头时非空。
- 类别 `hint`。节流：**沿用既有 `PROGRESS_THROTTLE_HZ = 4`**，按 `jobId` 合并，只保留最新。
- 前端落点：`progressStore`（不进 Query 缓存，D-05 §2.3）。

### 11.2 转写域 `transcribe.*`（F1 / F2 / F3）

```ts
/** 转写稿的段落 DTO。建议放 packages/shared/src/transcripts.ts，对齐 D-02 §1.5。 */
export interface TranscriptSegmentDto {
  seq: number;                  // D-02 transcript_segments.seq，稳定
  startMs: number;
  endMs: number;
  text: string;
  speakerLabel: string | null;  // 'SPEAKER_00'；显示名前端自己查
  confidence: number | null;
  noSpeechProb: number | null;
  words: { w: string; s: number; e: number; p: number }[] | null;  // 词级，可空
  chunkIdx: number | null;
  flags: number;                // 位图：bit0 疑似幻觉 / bit1 低置信 / bit2 人工确认 / bit3 静音
}
```

| 事件 | 类别 | payload | 触发时机 | 频率 / 保证 |
|---|---|---|---|---|
| `transcribe.started` | hint | `{ transcriptUid, noteUid, jobId, engineId, modelId, backend, language, durationMs, totalChunks }` | ASR 步骤开始 | 每次转写 1 条 |
| **`transcribe.segment`** | **data ★** | `{ transcriptUid, noteUid, seq, chunkIdx, segments: TranscriptSegmentDto[] }` | **每个 VAD chunk 落库后立刻发**（D-01 §4.1：chunk 边界 = 落库点） | **不节流、不合并、必达有序**。`seq` 为本次转写内单调递增的**批次号**（不是段序号），前端检缺口 |
| `transcribe.chunk` | hint | `{ transcriptUid, noteUid, doneChunks, totalChunks, lastEndMs }` | 同上，与 segment 成对 | 4Hz 合并。给进度条用，**与 `transcribe.segment` 分开**，这样节流不会拖累内容流 |
| `transcribe.done` | hint | `{ transcriptUid, noteUid, segmentCount, rtf, durationMs, speakers: {label,totalMs}[] }` | 转写完成并落库 | 1 条 |
| `transcribe.failed` | hint | `{ transcriptUid, noteUid, error: JobError, partial: boolean, lastEndMs: number\|null }` | 失败终态 | 1 条。`partial=true` 时前端显示"前 N 段可用 + 从这里继续"（D-05 §4.1 规则 6） |
| **`transcribe.replaced`** | hint | `{ noteUid, oldTranscriptUid, newTranscriptUid, updatedSegments, preservedEditedSegments, canUndo: boolean }` | **F3 两阶段重跑覆盖完成时** | 1 条 |

> **`transcribe.replaced` 是 F3 产品成败点的数据来源**（D-05 §4.3 步骤 4）：
> UI 要渲染「已更新 47 段 · 你编辑过的 3 段已保留 · [查看改动] [撤销这次更新]」。
> 没有 `updatedSegments` / `preservedEditedSegments` 这两个数字，这句话就写不出来，
> 用户就会认为软件在乱改自己的字。**这不是可选字段。**

> **`recording.*` 不进 SSE**：录音过程中的 `partial`/`final` 走 `/ws/recorder`（D-01 §3.4，双向且带二进制音频帧）。
> 只有停止后的"离线重跑"阶段回到 SSE，复用上面的 `transcribe.*`。**不要为录音再造一套 SSE 事件。**

### 11.3 结构化域 `mindmap.*` / `summary.*`（F4）

```ts
/** LLM 增量产出的节点草稿。最终规范化由 packages/mindmap 的 normalize() 做。 */
export interface MindMapNodeDraft {
  key: string;
  parentKey: string | null;
  text: string;
  refs?: { startMs: number; endMs: number; quote?: string }[];  // D-02 §2.1 的 refs
}
```

| 事件 | 类别 | payload | 触发 | 频率 |
|---|---|---|---|---|
| `mindmap.started` | hint | `{ mindmapUid, noteUid, jobId, modelId, providerId }` | 结构化开始 | 1 条 |
| **`mindmap.delta`** | **data ★** | `{ mindmapUid, noteUid, seq, nodes: MindMapNodeDraft[] }` | LLM 流式产出，**服务端按 ~250ms 批量成组**再发 | 有序必达；`seq` 单调。**不要每个 token 发一条** |
| `mindmap.done` | hint | `{ mindmapUid, noteUid, nodeCount, edgeCount, revision }` | 落库后 | 1 条 |
| `mindmap.failed` | hint | `{ mindmapUid, noteUid, error: JobError, degradedTo: 'heuristic' \| null }` | 失败 | 1 条。`degradedTo='heuristic'` 对应 D-01 §7.2 的"无 LLM 时启发式大纲" |
| `summary.delta` | **data ★** | `{ noteUid, seq, textDelta: string }` | 摘要流式生成 | 同 `mindmap.delta` |
| `summary.done` | hint | `{ noteUid, chars }` | | 1 条 |

> **为什么 `mindmap.delta` 发结构化节点而不是原始 token**：D-01 §5 F4 已定 LLM 必须走强制结构化输出
> （memo.ac 自陈"72B 以下模型思维导图转换有问题"，本质是自由文本解析太脆）。
> 服务端解析好了再发，前端就不需要写一个增量 JSON 解析器 —— 那是必然出 bug 的地方。

### 11.4 笔记与媒体域 `note.*` / `media.*`（F5）

| 事件 | 类别 | payload | 触发 | 频率 |
|---|---|---|---|---|
| `note.created` | hint | `{ noteUid, title, kind, folderUid: string\|null }` | 笔记建行（F1 在 probe 前就建草稿） | 1 条 |
| `note.updated` | hint | `{ noteUid, fields: string[] }` | 服务端侧改动（如 probe 回填标题/时长/封面） | 合并，≤2Hz。**`fields` 让前端只失效相关查询** |
| `note.status` | hint | `{ noteUid, status: 'draft'\|'processing'\|'ready'\|'partial'\|'failed' }` | 状态流转 | 1 条/次 |
| `note.deleted` | hint | `{ noteUid, purged: boolean }` | 删除 | 1 条 |
| `media.asset.ready` | hint | `{ noteUid, assetUid, role, bytes, durationMs? }` | 某个媒体产物就绪 | 每产物 1 条 |

> **`media.asset.ready` 是必需的**：`role='peaks'`（波形）与 `role='transcode'` 是**异步生成**的，
> 前端在它们就绪前不能去 `/media/asset/<uid>` 拉（会 404 或拿到半个文件）。
> 没有这个事件，前端只能轮询或者干等 —— 而波形直接决定 F5 时间轴能不能画（D-05 §4.4）。

### 11.5 系统域

| 事件 | 类别 | payload | 触发 | 前端动作 |
|---|---|---|---|---|
| ⬜ `daemon.shutdown` | hint | `{ graceMs: number }` | 优雅退出开始（D-01 §2.5） | 顶部条幅"本地服务正在退出"，停止发起新请求 |
| ✅ `sync.required` | hint | `{ reason: 'replay_gap' \| 'contract_mismatch' }` | `Last-Event-ID` 未命中重放缓冲（256 条已滚过） | **全量 `invalidateQueries()`** |
| ⬜ `index.progress` | hint | `{ kind: 'fts' \| 'vector', done: number, total: number }` | 后台重建检索索引（D-02 §4.5） | 设置页进度，不打扰主界面 |

> ⬜ = **从未加入 `SSE_EVENT_TYPES`**。本节三个系统域事件里只有 `sync.required` 落地了；
> `daemon.shutdown` 与 `index.progress` 至今不存在，前端不要给它们注册监听。

### 11.6 汇总：本节提议的事件类型（原写"需要新增的事件类型（21 个）"，实列 20 个）

> ⚠️ **这块此前写得像一份已批准的实现清单，其实不是。** 下面按 `packages/shared/src/events.ts:31`
> 的实际内容逐项标注：**✅ = 已落地，⬜ = 从未加入 `SSE_EVENT_TYPES`**。20 项里 **9 项是 ⬜**。
> 以常量为准，不要照抄本清单去写监听。

```ts
// 对照 packages/shared/src/events.ts 的 SSE_EVENT_TYPES（现共 30 个）
✅ 'transcribe.started'  ✅ 'transcribe.segment'  ⬜ 'transcribe.chunk'
✅ 'transcribe.done'     ⬜ 'transcribe.failed'   ✅ 'transcribe.replaced'
⬜ 'mindmap.started'     ✅ 'mindmap.delta'       ✅ 'mindmap.done'    ⬜ 'mindmap.failed'
⬜ 'summary.delta'       ⬜ 'summary.done'
✅ 'note.created'        ✅ 'note.updated'        ⬜ 'note.status'     ✅ 'note.deleted'
✅ 'media.asset.ready'
⬜ 'daemon.shutdown'     ✅ 'sync.required'       ⬜ 'index.progress'
// 另：本清单**漏了**一个实际已落地的事件 —— ✅ 'transcribe.partial'（F3 两阶段的灰斜体来源）
// 外加 1 处**修改**（非新增）：JobProgressEvent 扩展通用字段，见 §11.1
```

**实现顺序建议**（若要分批交付，按这个顺序对前端解阻塞最快；⬜ 的事件至今不存在，遇到就跳过）：
1. `job.progress` 扩展 + ✅`note.created` / ~~⬜`note.status`~~ → F1/F2 的进度条能动（**最小可用**）
2. ✅`transcribe.segment` / ~~⬜`transcribe.chunk`~~ / ✅`transcribe.done` → "边转边看"成立（**F1 的核心体验**）
3. ✅`media.asset.ready` → F5 波形与时间轴能画
4. ✅`transcribe.replaced` → F3 两阶段能说清楚
5. ✅`mindmap.delta` / ~~⬜`summary.delta`~~ → F4 渐进渲染（摘要流式至今没有事件）
6. 系统域三个 → 健壮性（其中只有 ✅`sync.required` 落地）

### 11.7 前端侧的对应实现状态

`apps/web/src/lib/events/` 已按本规格实现了**分发骨架**（逐类型 `addEventListener`、`data` 类的 `seq` 缺口检测、
`hint` 类的合并失效）。**`packages/shared` 已落地，mock 也已删除：前端现在直接消费真事件**
（`apps/web/src/lib/events/source.ts:102` 遍历 `ALL_SSE_EVENT_TYPES` 逐类型注册）。
**此前这里写着"在 `packages/shared` 落地前，前端用 `mockEventSource` 产生同形状事件驱动 UI"**
—— `mockEventSource` 这个标识符现在全仓零命中（含注释、含测试），照它去找会扑空。
当初预言的"分发层零改动"成立了。
