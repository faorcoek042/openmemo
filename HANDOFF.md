# HANDOFF —— OpenMemo 交接文档

> **这份文档是给"下一个接手的人（或模型）"看的。**
> 它不是变更日志（`git log` 已经很详细了，约 90 个提交，commit message 是本项目最好的事实来源之一）。
> 它回答三件事：**现在是什么状态 · 下一步该干什么 · 有哪些坑别再踩**。
>
> 维护者：`handoff` agent。最后更新：2026-08-03。
> **证据等级标注（每条"能用"都必须带）**：
> `[实测]` 我本人跑过命令 / 打过接口，附输出 ·
> `[读码]` 我读过源码，附 `文件:行号` ·
> `[报告]` 只有别人的回执支持，**我没有独立核实** ·
> `[未验证]` 没人验过。
> 本项目出现过至少四次"报告说做了、实际没接线"，所以 `[报告]` 一律不当作事实使用。

---

## ① 30 秒读懂：这是什么、现在能干什么

**OpenMemo 是 memo.ac 的本地优先复刻版**：粘贴一个音视频链接、拖一个本地文件、或者直接在浏览器里录音
→ 自动下载/抽音轨 → 本地 ASR 转写 → 云端 LLM 结构化成思维导图与摘要 → 存进本地 SQLite，可全文检索、可与音频时间轴联动。
**所有数据在本机，唯一的云依赖是用户自己填的 LLM API Key。**

形态是 **本地 daemon（Node/TS）+ 浏览器 React SPA**，不是 Electron。用户全程只在网页上点，不碰命令行 —— 包括装 GPU 后端和管模型（章程要求 2.1 / 2.2）。

### 已在**当前这台机器**上实测可用的能力

以下每条都是我（`handoff`）**本轮亲自打接口拿到的输出**，对象是正在跑的 demo（`http://127.0.0.1:10000`，dataDir `/root/data-memo`）：

| 能力 | 证据 |
|---|---|
| **daemon 健康 + 扩展全绿** | `[实测]` `GET /api/health` → `libsimple:true sqliteVec:true tokenizer:"simple" search.ok:true`，`pipeline.missing:[]` |
| **自检 11 ok / 2 warn / 0 fail** | `[实测]` `GET /api/selfcheck` → `counts:{ok:11,warn:2,fail:0}`；ffmpeg/ffprobe/whisper-cli/whisper-vad 全部解析到 dataDir 内的真实路径 |
| **F5 全文搜索（含中文分词）** | `[实测]` `GET /api/search?q=country` → 命中真实转写段，带 `startMs/endMs/snippet`；`modes.chineseTokenizer:true`；自检里「中文双字词可搜索」= `用户:1 推特:1 中国:1 服务:1` |
| **F5 笔记列表 / 详情 / 资产** | `[实测]` `GET /api/notes` → 2 条真实笔记；详情返回 `original` + `audio16k` 两个 asset 的 `/media/asset/<uid>` URL |
| **F4 思维导图（真实 DeepSeek 产物）** | `[实测]` `GET /api/notes/<uid>/mindmap` → `generatedBy:"llm:deepseek"`，4 节点，**节点 refs 带真实 `transcriptUid`/`startMs`/`endMs`/`quote`** —— 印证 ADR-013 决策 2「LLM 只给指针，时间与引文由我们从转写稿算」是真落地的 |
| **daemon 自己托管 SPA** | `[实测]` `GET /` → 200 `text/html`，引用 `/assets/index-*.js`（`apps/web/dist` 的产物）。⚠️ `apps/web/vite.config.ts:55` 的注释写「这一段目前尚未实现」，**该注释已过期**，`apps/daemon/src/http/static.ts` 是实现且正在生效 |
| **代理配置端点** | `[实测]` `GET /api/settings/proxy` → `mode:"system"`（默认跟随系统），`modes:["off","system","manual"]` |
| **硬件探测（CPU 侧）** | `[实测]` `GET /api/runtime/hardware` → 真实 CPU 型号/32 核/14 个指令集特性/16766MB RAM。**GPU 侧为空**，见 ⑥ |
| **LLM 设置真的落库了** | `[实测]` `GET /api/settings` → 含 `llm.defaultProviderId:"deepseek"` + `llm.defaultModelId` + `llm.providers[]` —— 这正是 T-108 修的那两个键 |

### 前端功能接线情况（`[读码]`，本轮逐文件核实）

**daemon 侧共约 83 条 REST 路由（method+path 组合）+ 2 条 WS**，不是任何旧文档里说的"6 个端点"。
前端 `routes.tsx` 聚合 12 个 feature 路由分片。逐项核实结果：

| 功能 | 结论 | 证据 |
|---|---|---|
| TipTap 笔记编辑器 | **已接通** | `NoteEditor.tsx` 真 `useEditor` + 800ms 防抖自动保存 |
| 拖拽上传 `onDrop` | **已接通** | `CapturePage.tsx:49-79,107-111` 真 `handleFiles`（注释里记着"曾经是空函数"这个坑） |
| 转写段落编辑 | **已接通** | `SegmentRow.tsx` 双击→textarea，提交/还原 |
| 导图编辑 + SVG/PNG 导出 | **已接通** | `MindmapView.tsx` 真 mind-elixir 编辑；`export.ts` 用 `exportSvg()`/`exportPng()` **矢量导出而非截屏** |
| 搜索 UI | **已接通** | `SearchPage.tsx` 三种模式 |
| 标签 / 星标 / 文件夹**写入** | **已接通** | `TagEditor.tsx` 增删；`notes/api.ts:135-140` star PUT；`folders/api.ts` 建/改名/删/移动 |
| 首启引导 `/onboarding` | **已接通** | 四步可跳过向导，真 `markOnboardingDone()` |
| 设置页：LLM Key / 代理 / 数据目录 | **已接通** | 三个 Section 都真调对应端点 |
| 任务中心持久化 | **已接通** | `tasks/api.ts` 把 `GET /api/jobs`（服务端真相，刷新不丢）与内存 `progressStore`（实时百分比）合并 |
| **F3 录音页（麦克风 → WebSocket）** | 🔴 **前端是 mock** | `RecorderPage.tsx:136` 注释 `// MOCK：真实实现走 /ws/recorder…`；`start()` 用 `setInterval` 播放硬编码的 `MOCK_LINES`（375-383），`stop()` 硬编码 `{updated:47, preserved:3, noCounterpart:1}`。**只有 `requestMic()` 是真的 `getUserMedia`，仅用于权限检查。** daemon 侧 `/ws/recorder` 是真实现（`http/ws.ts`，二进制音频帧 + JSON 控制 + Origin 校验）。→ **这是当前最大的"后端做好了、前端还是假的"缺口** |

### 只有别人的报告支持、我未独立核实的能力（**别当成已验证**）

- `[报告]` **F1 链接导入**：yt-dlp 实测 `Me at the zoo` 19s → 2 段；HTTP 直链 220.2s → 9 chunk / 45 段（`gpu-runtime` T-030/T-031）。
- `[报告]` **F2 本地文件**：11.0s 音频 → 0.80s（RTF 0.047）；长音频 33.6 分钟 → 80 chunk / 430 段，峰值内存 89 MB 不随时长增长。
- `[报告]` **F3 后端**：sherpa 流式 zh-14M RTF 0.010–0.066；两阶段合并保留用户编辑实测通过。当前 demo `streamAvailable:false` `[实测]`（这台机器上没装流式模型）。
- `[报告]` **中文离线引擎 Paraformer**：1 小时录音 43 秒（84x 实时）vs large-v3-turbo 22 分钟。当前 demo `paraformerAvailable:false` `[实测]`，即**这台机器上没装**。
- `[报告]` **F4 在真浏览器里能渲染/拖拽/导 SVG+PNG**（`model-mgmt` T-109，附截图路径）。保存（PATCH）当时是关着的，关它的常量已删除 `[读码]`，但**真浏览器里拖一下看有没有发出 PATCH，至今没人验过**。

---

## ② 怎么跑起来（从零到能用）

### 前置
- Node **≥ 22**（`.nvmrc` = 22；本机跑的是 24.18.0）`[读码]`
- pnpm **10.15.0**（`packageManager` 字段已钉死）`[读码]`
- Linux x64 是唯一被验证过的平台。**macOS / Windows / arm64 / musl 全部未验证**。

### 步骤

```bash
cd /root/memo

# 1. 装依赖
pnpm install
#    pnpm-workspace.yaml 的 onlyBuiltDependencies 只放行 4 个包
#    （ffmpeg-static / youtube-dl-exec / esbuild / @tailwindcss/oxide）。
#    better-sqlite3 **刻意不在其中**（ADR-005 决策 6：它用 prebuildify，
#    放进去只会空转一次 node-gyp，安装从 500ms 变成 1m24s）。

# 2. 构建（★ 必须是 -r，不能只跑根的 pnpm build）
pnpm -r build
#    根 package.json 的 "build": "tsc -b" 只走 TS project references。
#    apps/web 的 tsconfig 是 emitDeclarationOnly:true —— 根 build **不会产出 SPA bundle**。
#    真正的打包在 apps/web/package.json 的 "build": "tsc -b && vite build"。
#    只跑根 build 的话，daemon 起来会没有前端可托管。

# 3. 启动 daemon
node apps/daemon/dist/main.js --port 10000
#    只有两个 CLI 旗标：--port 与 --data-dir（apps/daemon/src/main.ts:836-844）。
#    没有 --host 旗标，绑定地址只能走环境变量。

# 4. 打开浏览器
#    http://127.0.0.1:10000     （daemon 自己托管 apps/web/dist）
```

### 当前 demo 的确切状态

```
命令行  node apps/daemon/dist/main.js --port 10000        [实测] ps
监听    0.0.0.0:10000  pid 2226023                        [实测] ss -ltnp
环境    OPENMEMO_HOST=0.0.0.0                             [实测] /proc/<pid>/environ
鉴权    关闭 —— 不带任何凭据 GET /api/notes 直接 200      [实测] curl
dataDir /root/data-memo（514 MB / 74 文件）
```
- 鉴权关闭这件事我是**从行为观测到的**（无凭据可读可写），不是从环境变量读到的；代码上 `OPENMEMO_AUTH` 未设置时默认就是 `none`（`auth.ts:41-42`），两者一致。
- 它**没有传 `--data-dir`** —— dataDir 来自机器全局指针文件 `~/.local/share/openmemo/datadir.json`（内容 `/root/data-memo`）。

### 关键环境变量（全表在 `apps/daemon/src/**`，以下是最常用的）`[读码]`

| 变量 | 默认 | 作用 |
|---|---|---|
| `OPENMEMO_AUTH` | **`none`** | 只有精确等于 `token` 才开启鉴权。`auth.ts:41-42`。**用户显式要求关掉鉴权**，见 ⑤ 的安全警告 |
| `OPENMEMO_HOST` | `127.0.0.1` | 绑定地址。设成 `0.0.0.0` 才对外可达（`bootstrap/single-instance.ts:32`） |
| `OPENMEMO_DATA_DIR` | `~/.local/share/openmemo` | 优先级最高：env > `--data-dir` > 指针文件 > OS 默认（`config/paths.ts:71`） |
| `OPENMEMO_TLS` | 关 | `self-signed` / `1` / `true` → 自签 HTTPS（录音需要安全上下文时用） |
| `OPENMEMO_WEB_DIST` | 自动解析 `apps/web/dist` | 覆盖被托管的 SPA 目录 |
| `OPENMEMO_DB_DRIVER` | 自动 | 强制 `better-sqlite3` 或 `node:sqlite` |
| **`OPENMEMO_PORT`** | — | **不存在**。端口只能用 `--port`（默认 17650） |

### 开发模式（改前端时用）

```bash
OPENMEMO_DAEMON=http://127.0.0.1:10000 pnpm --filter @openmemo/web dev
# → http://127.0.0.1:5173，vite.config.ts 里有 /api、/media、/ws 的反向代理
```
⚠️ **这个代理是必需的，不是可选优化**。在它存在之前，浏览器**从来就够不到 daemon**（页面在 5173、API 在 17650、daemon 当时不托管静态、vite 也没代理）—— 这个缺口存在了很多轮，因为它不在任何一个人的责任范围内（前端做了页面、后端做了接口，中间这一段没人认领）。代理必须 `changeOrigin: true` **并且**重写 `Origin` 头，否则会被 daemon 的 DNS-rebinding / CSRF 双重校验 403。

### 测试怎么跑
**根目录没有 `test` 脚本，也没有 `pnpm -r test`。** 9 个包里只有 3 个定义了 `test`：`[读码]`
```bash
pnpm --filter @openmemo/daemon test   # node --test dist/**/*.test.js
pnpm --filter @openmemo/db     test   # 同上
pnpm --filter @openmemo/web    test   # test:unit + test:components
```
`downloader` / `llm` / `mindmap` / `pipeline` / `runtime` / `shared` **没有 `test` 脚本** —— 它们的验证脚本是各自包内的 `verify-*.mjs` / `gen-*.mjs`，得手动找。
**所有测试都跑编译产物**，所以必须先 `build` 再 `test`。

### 自检（最推荐的第一个命令）
```bash
node scripts/selfcheck.mjs --daemon http://127.0.0.1:10000
node scripts/selfcheck.mjs --json                 # 机器可读
node scripts/selfcheck.mjs --daemon ... --proxy-test   # 额外做一次真实出网探测
```
退出码：只要有 `status=fail && required` 就 `exit 1`；`warn` 不影响。

---

## ③ 架构一页纸

```
        ┌──────────────────────── 浏览器（唯一 UI）────────────────────────┐
        │  React 19 SPA · react-router 8 · TanStack Query · Zustand        │
        │  TipTap 编辑器 · mind-elixir(编辑) + markmap(只读) · wavesurfer  │
        └───────────────┬─────────────────────────────────────────────────┘
      四条通道（HTTP/1.1 每 origin 6 连接是硬预算：1 SSE + 2 媒体 + 3 REST）
        REST /api/**  │  SSE /api/events（全局唯一一条）│ WS /ws/**（仅实时录音）│ /media/**（Range 字节流）
        └───────────────┬─────────────────────────────────────────────────┘
        ┌───────────────┴─── 本地 daemon（Node 22 + TS，node:http 无框架）───┐
        │ http/(static,guard,auth,rest/*) · jobs/(scheduler,runners) · db   │
        │ pipeline · runtime · downloader · llm · mindmap                    │
        └───────────────┬─────────────────────────────────────────────────┘
                 子进程 spawn（崩溃隔离 + 许可证隔离 + 可独立升级）
        ┌───────────────┴─────────────────────────────────────────────────┐
        │ ffmpeg / ffprobe │ yt-dlp │ whisper-cli │ whisper-vad │ probe    │
        └─────────────────────────────────────────────────────────────────┘
```

### 包与职责边界（`pnpm-workspace.yaml`：`apps/*` + `packages/*`）

| 包 | 职责 | 不该出现在这里的东西 |
|---|---|---|
| `packages/shared` | **唯一契约源**：API schema、SSE 事件表、数据模型、TS 类型 | 任何 `node:*` import（曾经误引 `node:crypto` 污染浏览器包） |
| `packages/db` | SQLite 适配层（better-sqlite3 主 / `node:sqlite` 备胎）+ 26 表 migration + FTS5 | 业务逻辑 |
| `packages/downloader` | 统一下载器（manifest + SHA256 + Range 续传 + 多源探测 + 解包）。**后端包与模型共用同一个** | 第二条下载路径（见 ⑤） |
| `packages/runtime` | 硬件探测 + GPU 后端包管理 + 熔断器 | — |
| `packages/pipeline` | 媒体源 → 转写 → 结构化。**`SubprocessRunner` 是全项目唯一允许 `spawn` 的出口** | 任何别处的 `child_process` 调用 |
| `packages/llm` | LLM 适配层：OpenAI-compatible（覆盖约 20 家）+ Anthropic 原生 + Gemini 原生 | — |
| `packages/mindmap` | **库无关**的导图数据模型 + mind-elixir / markmap 双适配器 + 导出 | 渲染器 API 泄漏 |
| `apps/daemon` | HTTP/SSE/WS 服务、任务队列、静态托管、鉴权 | — |
| `apps/web` | React SPA，`features/<name>/` 每人独占一个目录 | `features/A → features/B` 的横向 import（eslint 已禁） |

### 前端的反冲突结构（D-05 §3.4，**已被实战检验**）
路由与 SSE 绑定这两个"三方必然冲突的热点"被拆成分片：每个 feature 导出自己的 `<Name>.routes.tsx` 与 `sse.ts`，聚合文件只在新增 feature 时加一行 import + 一个数组项。T-022 两个 feature 并行落地，**零冲突零协调** `[报告]`。

### 数据流（一次导入的完整路径）
```
浏览器 POST /api/import ─202 jobUid─> 任务队列（lane 信号量：asr/llm 各 1，不可超卖显存）
  → 媒体源适配（yt-dlp / 直链 / RSS / HLS / 本地）→ ffmpeg 抽 16k 单声道
  → VAD 切 chunk ──► **每 chunk 落库**（"抢占点 = 续跑点 = 进度点"三合一）
  → whisper-cli / sherpa → transcript_segments
  → SSE `transcribe.segment` 推给前端（扁平信封 + 具名 event + seq）
  → （用户点）LLM 结构化 → mindmap（LLM 只回段落编号，时间与 quote 由我们从真实转写稿算）
  → FTS5（libsimple 中文分词）建索引 → /api/search 可搜
```

### API 面速查（`[读码]`，约 83 条 REST + 2 条 WS）
| 前缀 | 内容 |
|---|---|
| `/api/health` `/api/auth/session` `/api/events`(SSE) `/api/daemon/{status,restart,shutdown}` `/api/echo` | `http/server.ts` 直接处理；**`/api/health` 在 auth gate 之前返回**（无凭据可读，会泄露 `dataDir` 等绝对路径） |
| `/api/notes*` | `rest/notes.ts`（probe/import/list/detail/transcript/delete）+ `rest/content.ts`（PATCH 笔记、段落 PATCH/DELETE、anchors、retranscribe、mindmap 的 POST/PATCH/GET、export） |
| `/api/search` `/api/notes/upload` | `rest/search.ts` / `rest/upload.ts` |
| `/api/tags*` `/api/folders*` `/api/notes/:uid/{tags,star,folder}` | `rest/organize.ts` |
| `/api/settings` `/api/secrets/*` `/api/settings/proxy*` `/api/settings/data-dir` | `rest/{settings,proxy,storage}.ts` |
| `/api/runtime/{hardware,breaker}` `/api/backends/*` `/api/models/*` `/api/components/*` `/api/jobs/*` | `rest/{hardware,backends,models,components,jobs}.ts` |
| `/api/selfcheck` | `rest/selfcheck.ts` |
| `/media/asset/:uid`（GET/HEAD，Range） | `rest/media.ts` |
| `/ws/recorder`（真） · `/ws/asr-worker`（**显式 NOT_IMPLEMENTED**，ADR-006 决策 3 降为实验） | `http/ws.ts` |

⚠️ **路由是"先注册先赢"**（`main.ts` 里 `routers.push(...)` 的顺序 → `server.ts:350-352` 首个匹配胜出）。
已经因此产生一处**不可达的死代码**：`POST /api/backends/selftest` 定义了两次 —— `backends.ts` 里的 501 桩被 `hardware.ts` 里的真实现永久遮蔽。
另有一个真桩：`POST /api/models/benchmark` → 501。

### 几条容易踩的架构约定
- **SSE 只开一条**（ADR-004 决策 5）。多标签页用 Web Locks 选主 + BroadcastChannel 转播，Safari 不支持时降级回"最后一个标签页胜出"。
- **token 走 URL fragment**（`/#t=…`，不进日志、不进 Referer）→ 立刻换成 HttpOnly cookie。原因是技术性的：SSE / WS / `<audio src>` **三类通道都带不了 `Authorization` 头**。
- **双 ID**：内部整数 PK（FTS5 外部内容表的 `content_rowid` 与 sqlite-vec rowid 都要求整数）+ 对外 ULID。
- **时间一律整数毫秒**（ADR-013 决策 3）。
- 更细的请直接读 `docs/design/D-01`（架构）、`D-02`（26 表数据模型）、`D-05`（前端规范）。**别把它们全文抄进这里。**

---

## ④ 当前工作分工与在途任务

> 来源：`coordination/inbox/*.md` 的最新条目 + `git log` + `apps/web/src/features/README.md`。
> ⚠️ **`coordination/BOARD.md` 与 `ROSTER.md` 已严重过期**（还停在 Wave 2，写着"daemon 只有 6 个端点"那个时代）。
> **别信它们，信 inbox 和 git log。**

### 六路 agent（+ 本文档负责人）

| 代号 | 领域 | 独占写入（硬约束，防写冲突） | 最近一次交付 |
|---|---|---|---|
| `architect` | **前端主体**：app 外壳、路由、鉴权握手、notes/capture/recorder/transcript/player/search/tasks/settings/mindmap 页 | `apps/web/src/{app,lib,components/common}/**`、`features/{capture,notes,transcript,player,recorder,search,tasks,settings,mindmap,onboarding,folders,diagnostics}/**`、`docs/design/D-01,D-02,D-05,D-07,D-08` | **T-108 / T-112**：删掉 `MINDMAP_SAVE_SUPPORTED`、LLM 配置两处统一数据源、新增 `lib/api/auth-mode.ts` |
| `oss-scout` | **daemon + DB + 根配置** | `apps/daemon/src/**`、`packages/db/src/**`、`packages/mindmap/**`(T-023)、根 `package.json`/`tsconfig.base.json`/`pnpm-workspace.yaml`/`.gitignore`/`eslint.config.js`、`scripts/license-report.mjs` | **T-110**：统一自我重启与正常启动的 dataDir 优先级；**T-111**：拒绝关闭 token 鉴权（见下） |
| `gpu-runtime` | **流水线 + 运行时 + 自检** | `packages/pipeline/src/**`、`packages/runtime/src/**`、`scripts/build-*.sh`、`scripts/selfcheck.mjs`、`.github/workflows/**`、`docs/design/D-04,D-06`、`docs/SECURITY.md` | **T-093**：冷启动 selfcheck 归零、`materializeSqliteExtensions()`、自检判据往严改 |
| `model-mgmt` | **契约 + 下载器 + 模型/运行时页** | `packages/shared/src/**`、`packages/downloader/src/**`、`vendor/manifests/*.json`、`apps/web/src/features/{models,runtime}/**`、`docs/design/D-03` | **T-102**：whisper 目录 9→25 条；**T-109**：真浏览器取证（设置页两处不一致 + F4 导图可用性） |
| `ui-polish` | **视觉/密度/文案层**（不碰 mutation 与业务判定） | `apps/web/src/index.css`、`components/common/JobToaster.tsx`、各 feature 的**呈现层**、`docs/design/D-09` | **T-101**：JobToaster + 五阶段安装文案 + `/runtime` 页高 4047→2100px |
| `memo-compare` | **竞品对比（只读研究，不写代码）** | `docs/research/R-06` | **T-080**：memo.ac 的空间管理 / 代理 / 云 LLM 三项取证，并**两次推翻自己的结论** |
| `handoff`（本文档） | 交接文档 | `HANDOFF.md`、`coordination/inbox/handoff.md` | 本文件 |

### 在途 / 刚落地但未闭环的任务

| 项 | 状态 | 归属 | 说明 |
|---|---|---|---|
| **`OPENMEMO_AUTH=none` 免鉴权模式** | 🟡 已生效，但**契约还没定** | `oss-scout` → `architect` | 默认值是 `none`（`auth.ts:42`）。`GET /api/health` **至今没有 `auth` 字段** `[实测]`，而 `architect` 的 `lib/api/auth-mode.ts` 正在等它 —— 目前用"宽容读"临时顶着（认 `auth`/`authMode`/`authRequired` 三种写法），**契约定稿后必须收紧成单一字段**。⚠️ 这段代码是被 `d12ab1e` 顺带带进去的，见下方"提交卫生" |
| **云 LLM 供应商注册表** | 🔵 **在途，未提交** | `model-mgmt` | `git status` 有未提交的 `packages/shared/src/providers.ts`（新）+ `vendor/manifests/llm-providers.json`（新）+ `shared` 的 `index/models/schemas` 与三份 manifest 被改。方向是 `memo-compare` T-080/T-113 的建议：把硬编码供应商清单改成 JSON 注册表（对齐 memo.ac 的 `configFields` / `modelListSource`），**注册表进 git 而不是远端拉取**（章程是 local-first） |
| **T-113 memo.ac 内置清单取证** | 🟢 刚提交（`d12ab1e`） | `memo-compare` | 24 家供应商 / 520 条模型，落到 `docs/research/assets/memoac-{asr-models,llm-providers}.json` |
| **F3 录音页前端还是 mock** | 🔴 **最大的功能缺口** | `architect` | `[读码]` `RecorderPage.tsx:130-163` 用 `setInterval` 播硬编码字幕、`stop()` 硬编码"已更新 47 / 已保留 3"。daemon 的 `/ws/recorder` 是真的。**章程 F3 目前在 UI 上是假的** |
| **导图保存（F4 PATCH）** | 🟡 后端有、前端刚打开、**真浏览器未验** | `architect` → 需 `model-mgmt` 复验 | 验收动作：拖一个节点 → 应看到一条 `PATCH /api/notes/:uid/mindmap` → 刷新后仍在 |
| **纯 UI 保存 LLM 配置** | 🟡 隔离实例验过、demo 上未做 | 需要能开浏览器的人 | `architect` 明说做不到：他只能重放 HTTP 请求，那证明不了 React 那侧的接线 |
| **401 自愈的真实往返** | 🟡 只有单测 + 代码路径 | 需 `model-mgmt` 真浏览器复验 | |
| **ffmpeg 的可分发性** | 🟢 已修（T-094 端到端实测装上）| `model-mgmt` | 当前 demo 的 ffmpeg/ffprobe 已解析到 dataDir 内 `[实测]` |
| **`llamacpp-cpu-*` 与 4 组 GGUF 仍在目录里** | 🔴 未清 | `model-mgmt`/`oss-scout` | ADR-016 说砍掉本地 LLM，目录还没清 |
| **`measureTree` 不识别硬链接** | 🔴 未修 | `oss-scout` | 实测报 1371MB，`du` 实为 705MB |
| **`components/common/HealthBanner.tsx` 是死文件** | 🔴 未清 | 待裁决 | `ReadinessBanner` 已接管它的挂载点 |

### ⚠️ 提交卫生：`git add -A` 已经两次把不相关的改动扫进别人的提交
- `f27c317` 的 message 只写了 T-043，但 T-040 的整批代码（F3 `/ws/recorder`、Paraformer 接线、runtime 接线、FTS 回填）一并入库 —— 后来靠一条空提交补记归属。
- `d12ab1e` 的 message 是「memo.ac 内置清单取证 (T-113)」，但它同时带进了 **`apps/daemon/src/http/{auth.ts,server.ts}` 的免鉴权改动**（38 + 24 行）—— 一个安全边界的变更藏在一个 docs 提交里。
> **★ 规矩：提交前跑 `git status`，只 add 自己这轮改的路径。** 本项目把 commit message 当作最重要的事实来源，`add -A` 会直接污染这个来源。

### 已知的污染 / 需要人来清的东西
- `[实测]` 机器上还挂着**两个 vite dev server**（127.0.0.1:5173 与 :5188），跑了 19–24 小时，是历史 agent 留下的。
- `~/.local/share/openmemo/datadir.json` 是**机器全局的**指针文件，本会话里被不同 agent 改过至少两次，目前指向 `/root/data-memo`（正确值）。它现在已经在 `GET /api/settings/data-dir` 的 `externalFiles` 里被如实描述 `[实测]`。

---

## ⑤ 踩过的坑与由此立下的规矩

> **这是这个项目最有价值的产出。** 下面每一条都是真实事故，不是假想风险。

### A. 假绿灯家族（十余例）—— 本项目最贵的一类 bug

| # | 事故 | 后果 |
|---|---|---|
| 1 | **`as never` 关掉类型检查** | T-028 报告"端到端打通"，但 daemon 发出的每个 SSE 事件**字段名全是错的**（`durationSec` vs `durationMs`、`fraction` vs `pct`、缺 `noteUid`…），前端只会拿到一堆 `undefined`。e2e 脚本**只断言了事件类型、没断言 payload 字段名**，所以照样报 ✅。修法：新建 `jobs/events.ts` 集中构造，**零类型断言，让编译器当守门人** |
| 2 | **`node --test` 对空集返回绿** | 出现过**三次**：① 给主 tsconfig 加 `exclude` 后 test tsconfig 继承 → 编出 0 个测试；② 产物输出到 `node_modules/.test-out/`，而 `node --test` 默认跳过 `node_modules/`；③ 产物放 `dist/test` 被 `vite build` 的 `emptyOutDir` 清掉 |
| 3 | **`git check-ignore` 默认看索引** | 所以"修完永远绿" —— 文件一旦已被 track，check-ignore 就闭嘴，而 Tailwind 的目录扫描**根本不看 git 索引**。必须加 `--no-index` |
| 4 | **只断言"返回 200"** | 会话续签测试如果只断言 200，"发一个没用的令牌"也能过。改成断言**"返回的 CSRF 令牌真的能写"** |
| 5 | **只断言前置条件的测试** | "普通重启不换目录"那条只断言了"指针确实指向别处"，**根本没重启**，它会永远绿。作者自评：**"只断言前置条件的测试，和不写测试是一样的。"** |
| 6 | **假代理没监听 `CONNECT`** | undici 的 `ProxyAgent` 一律走 CONNECT 隧道，测试里的假代理只处理普通请求 → 两边都超时、双双 0 命中 → 差点写出"全局 fetch 不受 setGlobalDispatcher 影响"的假结论，**差一点就因为自己的坏测试去改一个没坏的东西** |
| 7 | **VAD 模型被当成 ASR 模型** | `listInstalled` 与另一处判定都按目录归类，VAD 进了 ASR 桶 → 自检"有 ASR 模型"变绿 |
| 8 | **`isSafeExecutable` 用宿主的 `path.isAbsolute` 判 Windows 路径** | 在 Linux 上跑时 CVE 分支**不可达**，`.bat` 测试**一直在为错误的理由通过** |
| 9 | **金丝雀被别人挡住了** | 恶意 HLS 测试第一次用 `.txt`，挡住它的其实是 **ffmpeg 自己的 `allowed_segment_extensions`**，不是我们的白名单。换 `.ts` 才隔离出真正起作用的那层。**"挡住了"不等于"是我们挡住的"** |
| 10 | **`redirect:'follow'` 丢掉 `x-linked-size/etag`** | 预校验**静默失效且不报错** |
| 11 | **TD-002 被 Manager 过早关闭** | 依据是"一个测试通过"，而那个测试走的**不是产品的真实导入路径** —— `TranscribePipeline` 直接调 `resolve()+probe()` 绕过了回退链。**GPL 兜底在真实路径上从未触发过** |
| 12 | **ADR-015 之后的"包全装上了但扩展加载不了"** | 7 个包全部 `succeeded`、sha256 全部校验通过，daemon 起来 `tokenizer=trigram vec=off`，**中文双字词搜不到，且零报错** |
| 13 | **修复本身无效** | `extractJson` 的"误导性错误" bug，第一次修时把检测放在了内层扫描**之后**，等于没修 —— 顺序反了不会让任何用例变红 |

> ### ★ 由此立下的规矩（不可协商）
> 1. **任何新加的检查，先证明它会红。** 没见过它红过，就不知道它在检查什么。
> 2. **怀疑代码之前，先证明测试是对的。** 本项目"测试的结论不可信"至少出现 6 次。
> 3. **验收"某性质成立"时，必须确认测试覆盖的是产品的真实路径**，而不是一条为测试而设的旁路。
> 4. **测试通过时要问一句"它通过的理由对不对"。**
> 5. **禁止 `as never` / 无谓的类型断言**。把契约交给编译器守，不要交给人记。

### B. 假红灯同样危险
`pgrep` 数到了并行任务 → 误报孤儿进程泄漏；`pkill -f` 打断了别人的 daemon → 冷启动"43→3"被误读成产品 bug。
**规矩：假红灯会训练人忽略告警，和假绿灯一样要当 bug 修。** 出现红灯先问"这个红是真的吗"。

### C. 「写得进读不回 / 前后端键名对不上」—— 五次

| 字段 | 症状 |
|---|---|
| `textRaw` | `PATCH` 段落时写进去了，`GET /api/notes/:uid/transcript` 的序列化**没带这个字段** → 落地即丢 |
| `noSpeechProb` | `whisperServer.ts:306` 把它**硬编码成 null** —— whisper-server 明明给了值，我们扔了。（顺带查明：CLI 路径上这个字段**永远是 null**，`examples/cli/cli.cpp` 的 `output_json()` 从未调用过那个公开 API，**没有任何 flag 能改，不是我们的 bug**） |
| `installPath` | **一个名字底下藏着三个概念**：`sqlite-ext.json` 的是"链接进这个共享目录"、`backends.json` 的是"引擎运行时目录布局（从来没人执行）"、installer 选项的是"解压到此并替换整个目录"。改一个名字只能救一个 → 拆成 `linkInto` / 删除 / `unpackInto`。⚠️ `[读码]` 代码已改干净，但 `packages/shared/openapi.yaml` 里还留着 4 处 `installPath`，且 dataDir 里的旧安装记录也还带着它（见 ⑥） |
| `settings` 双层嵌套 | `GET /api/settings` 回 `{settings:{…}}`，`PATCH` 只收扁平的 → **把 GET 的结果原样 PATCH 回去**（最自然的用法）会造出一个字面名叫 `settings` 的键 |
| `llm.defaultProviderId` | 前端 `onSave` 写了 `providers` + `baseUrl`，**唯独这个键一次都没写过**，而它是 daemon 唯一认的键 → 用户填完 Key 保存，LLM 永远 `NOT_CONFIGURED` |

> ### ★ 规矩
> - **契约测试要"测对面会读的键"，不是"测我发了什么"。** 键名从 `@openmemo/shared` 的常量取，daemon 以后新增必读键，测试立刻红。
> - **让读写形状可以互换**：`GET` 的输出直接喂回 `PATCH` 必须幂等。这一条能一次性挡住整族"读写形状不对称"。
> - **UI 显示"当前生效"时，要读"对面会读的那个键"**，不是读自己的清单 —— 照自己的清单显示就永远显示正常、永远发现不了缺键。
> - **一个名字对应多个概念时，第三条路既不是"执行它"也不是"忽略它"，是先把概念拆开再分别命名。**

### D. 「后端做好了、前端还关着」—— 两次
- `RecorderPage.tsx:303` 的 `showModel={false}`：当初写它是对的（那会儿选择器是假的），后来 `architect` 把它改成真生效了，**这个 `false` 变成了过时的保护** → 用户在最可能用的录音页看到的模型选项数恒为 0。
- `MINDMAP_SAVE_SUPPORTED = false`：daemon 的 `PATCH /api/notes/:uid/mindmap`（`content.ts:329`，带 validate + revision 乐观锁）**早就落地了**，前端这个常量没跟着翻回来。

> ### ★ 规矩：**这类开关必须与"后端有没有"绑定，不能靠人记得回来开。**
> 正确处置不是把 `false` 改成 `true`（那只还这一次的债），而是**把开关整个删掉**，让"后端有没有"自己说话：直接发请求，端点不存在时如实抛错。
> 同源的还有 `App.tsx` 的 `pending` 分支 —— 把未认领页面渲染成不可点击的灰 `<span>`，页面做完了没人回来删，用户就"点不动"。也是整个删掉而不是删两处调用。
>
> `[读码]` 我复核了这两处：`MINDMAP_SAVE_SUPPORTED` **确已删除**（`features/mindmap/api.ts:29` 留了注释说明"是删除不是改成 true"，并有一条回归测试断言该导出必须是 `undefined`）；`showModel` 现在默认 `true`（`TranscribeOptions.tsx:22,26`），`RecorderPage.tsx:306` 传的是简写 `showModel`。全仓无 `showModel={false}`。
> **但同一类问题还有第三种形态没清干净：`RecorderPage` 的整个 mock 实现**（见 ④）—— 它不是一个开关，所以那次"搜三类开关"的排查搜不到它。

### D-bis. 第三类同源问题：**注释与代码不一致**（三处 `[读码]`）
它们不会让任何测试变红，但会让下一个人做出错误判断：
| 位置 | 注释说 | 实际 |
|---|---|---|
| `apps/web/vite.config.ts:55` | 「daemon 自己托管 SPA…**这一段目前尚未实现**」 | **已实现且正在生效**（`apps/daemon/src/http/static.ts` + `server.ts:134-142`），demo 的页面就是它发的 |
| `apps/web/src/features/settings/DataLocationSection.tsx:83-91` | 「这个端点还不存在」 | `rest/storage.ts:52` **GET 与 POST 都完整实现**（含布局统计、dry-run、运行中任务守卫、"已经是数据目录" vs "目标非空"分支） |
| `packages/shared/openapi.yaml:1478,1536,1576,1599` | 仍列着 `installPath` | 代码里已改名 `linkInto`（`daemon/…/backends.ts:123,176`），前端两个名字都不引用 |
> **★ 规矩：注释里的"尚未实现"必须带失效条件。** 更好的做法是不写这句，改成让代码自己失败（同上一条：删掉开关、直接发请求）。

### E. 跨端降级必须以对端**确实存在的行为**为依据
前端 `client.ts` 在 sessionStorage 不可用时会主动降级成**不带 CSRF 头**，注释写"由 Origin 校验兜底" —— **但服务端当时根本没有这个兜底，是硬拒**。
症状：读全通、写全挂（`GET /api/settings` 200，`PATCH` 403 `CSRF_FAILED`）→ 用户填完点保存、界面一切正常、库里 0 行。
> **★ 规矩：降级的前提必须是"对端确实这么行为"，否则那不是降级，是静默失败。**

### F. 验"功能可用"，不验"组件加载"
不要问「libsimple 在不在」，要问「`用户` 这个词能不能搜到」。
`scripts/selfcheck.mjs` 就是按这条写的：它真的建一张 FTS5 表、插中文、断言 `用户`/`推特`/`中国`/`服务` 四个双字词都能匹配；真的 spawn probe 子进程枚举 GPU；真的把 `media_assets` 的每条路径解析出来看是否落在 dataDir 内。
同源教训：
- **文件存在性检测不可信** —— `libvulkan.so.1` 存在但机器没有 GPU、没有 `/dev/dri`。
- **`枚举数 > 0` 同样不可信** —— lavapipe（软件光栅化）让无 GPU 的机器报告 1 个 Vulkan 设备。必须检查 `deviceType`，排除 `CPU`/软件实现。
- **在系统 PATH 上找到 ffmpeg 只能算 warn 不能算 ok** —— 开发机恰好有，不代表产品能装上。

### G. `.gitignore` 少一个前导斜杠 → 两种毫不相干的症状，都不报错
第 10 行是 `models/`（没有前导 `/`）。git 的语义是**匹配任意层级**同名目录，于是命中了 `apps/web/src/features/models/`：
1. **Tailwind v4 遵守 `.gitignore`**，因此从不扫描该目录 → 该目录**独有**的工具类（`w-[26rem]`、`z-20`、`grid-cols-[auto_5.5rem_5.5rem_1fr]`）**从未被生成**；而 `absolute`、`rounded-lg` 恰好别处也在用，照常生效 → **同一个 className 里一半生效一半不生效，看代码永远看不出来**（下拉宽度 416px→153px、`z-index` 回退到 auto 被后面的卡片盖住）。
2. **那 11 个源文件根本没进版本库**（`git ls-files` 返回空）。一次 `git clean -fdx` 就全没了。**这条比视觉 bug 严重得多。**

修法：`models/` → `/models/`，`bin/runtime/` → `/bin/runtime/`。
护栏：`scripts/check-tracked-sources.mjs`（用 `git check-ignore --no-index` 检查 `apps/`、`packages/` 下每个源目录是否被忽略）。
> ⚠️ **`[实测]` 这个护栏脚本目前没有任何自动调用方** —— 全仓 grep `check-tracked-sources` 除自身外 0 命中，不在任何 `package.json` 脚本、不在唯一的 GitHub workflow、没有 git hook。**它是对的，但没人跑。谁接手谁把它接进 CI 或 pre-commit。**
> ⚠️ `.gitignore` 里 `data/`、`build/`、`out/`、`dist/`、`target/` **同样没有锚定**，目前没误伤源码，但同类隐患还在。

### H. 禁止 `pkill -f`（三次事故）
本机同时跑着多个 daemon。`pkill -f 'dist/main.js'` 会把别人的实例一起杀掉：
- `gpu-runtime` 的 daemon 被误杀两次；
- 其中一次让"冷启动 43→3"被误读成产品 bug，**差点让人去改一个没坏的东西**。
> **★ 规矩：只杀自己记录下来的 pid。起进程时就把 pid 记进 inbox。** 用独立端口 + `setsid`。
> 这条已被所有 agent 遵守并在回执里显式声明（"全程未使用 `pkill -f`"）。

### I. 其它值得知道的坑
- **`fetch` 会忽略 `Host` 头**（forbidden header）→ 用 `fetch` 根本测不了 DNS rebinding 防护，必须用 `http.request`。
- **`node:sqlite` 返回 null 原型对象**，`better-sqlite3` 返回普通对象 → `deepStrictEqual` / `hasOwnProperty` 会静默出错。适配层已统一。
- **`vec0` 的 rowid 绑 JS `number` 必失败** → 用 BigInt / 字面量 / `CAST(? AS INTEGER)`。
- **扩展能力只能实测，不能查 `compile_options` 推断** —— 不列 `ENABLE_LOAD_EXTENSION` 也照样能加载扩展。
- **判重一律按 SHA256，不按体积** —— `ggml-large-v1.bin` 与 `ggml-large-v2.bin` **字节数完全相同**（3,094,623,691），sha256 不同。
- **`json_object` 不是强约束** —— llama-server + Qwen3 会返回带 markdown 围栏的文本，`JSON.parse` 直接失败。只有 `json_schema` 是语法级约束。
- **`formatSseFrame()` 发 `event: <type>` → `EventSource.onmessage` 永不触发**，必须逐类型 `addEventListener`。
- **Tailwind v4 的 `@theme{}` 变量不能嵌套** → 明暗双档必须用 `:root`/`[data-theme]` + `@theme inline` 转发；写成普通 `@theme` **暗色永远不生效且不报错**。
- **jsdom 里 React 退回 IE 时代的事件 polyfill**（`'oninput' in document` 特性检测被骗）→ 一输入就抛异常，报错栈全在 react-dom 内部。修法是在 react-dom 被 import **之前**把事件属性挂到 document 上，且该模块必须是第一个 import。
- **设计文档里写「（略）」会被下游当成"照抄即可"，实际是空洞。DDL 不许省略。**
- **被报告过但没进任务清单的缺陷，等于没被报告。**

---

## ⑥ 已知未解决 / 未验证

### 「做了没验」
- **macOS / Windows / arm64 / musl 全部零验证。** `materializeSqliteExtensions()` 在 Windows 走拷贝分支，未验证；Gatekeeper、SmartScreen、`taskkill /T` 取消路径、`better-sqlite3` 的 mac/arm64 prebuild 全未测。上游 issue #1509（`linux-arm64.node` 要 GLIBC_2.38）**未复现**。
- **Anthropic / Gemini 适配器只跑过本地 mock**，没有真 Key。「能证明请求形状符合文档」≠「能证明真实端点会接受」。**拿到 Key 前谁都别写"已验证可用"。**
- **代理没有在真实可用的代理后面测过** —— 用的是死代理反证法：证明了流量确实改道，**未证明"经代理能成功出网"**。
- **`verifying` / `blocked` 两个安装状态的 toast 从未在真实场景触发过**（本机构造不出样本）。
- **F4 导图保存、纯 UI 保存 LLM 配置、401 自愈的真实往返** —— 见 ④ 的在途表。

### 「验了没通过 / 当前就是坏的」
- `[读码]` **F3 录音页前端是 mock**（`RecorderPage.tsx:130-163`）—— 章程五个必备功能里唯一一个 UI 层是假的。详见 ①/④。
- `[实测]` **GPU 探测在 demo 上是空的**：`/api/runtime/hardware` → `gpus: []`，四个后端全部 `available:false`，原因都是 `probe executable not found: /root/data-memo/bin/runtime/probe`。**要求 2.1 的 L2 加速包在这台机器上装不了**（L1 CPU 包按 ADR-014 豁免 probe 门禁，所以转写本身不受影响）。
- `[实测]` **`GET /api/health` 的 `host` 字段说的是 `127.0.0.1`，而 socket 实际绑在 `0.0.0.0:10000`**（`ss -ltnp` 为证）。这个字段是给前端拼 URL 用的，但**读它的人会得出"只绑回环"的错误结论** —— 而这恰好是 T-111 里被反复强调的安全前提。建议要么改名，要么补一个真实的 bind 地址字段。
- `[实测]` **安装记录里躺着已经不存在的绝对路径**：`/root/data-memo/models/manifests/asr/asr_whisper-base-q5_1.json` 的 `files[0].path` = `/tmp/cold4/models/by-name/asr/ggml-base-q5_1.bin`，而 `/tmp/cold4` **已不存在**；`GET /api/models/installed` 把这个坏路径原样返回。同一份记录的 backend 版本里还留着 `installPath: "whispercpp/v1.9.1/cpu"` —— T-097 声称已从两份清单里删除的字段。
  → **成因是这些记录写于 08-02（早于 T-053 的"改相对路径"与 T-097 的"拆概念"），而两次修复都是 forward-only、没有做记录迁移。** 真实用户升级后会保留悬空绝对路径 + 一个已被删除的字段。**这是我本轮独立查出的，不在任何 inbox 里。**
- `[读码]` **`GET /api/selfcheck` 只是 `scripts/selfcheck.mjs` 的真子集**。两者共用 `packages/runtime/src/selfcheck.ts` 的实现，但 HTTP 端点**缺三项**：① 硬件探测（第 1 节）② **数据目录自洽性（4b，就是它查出 `audio16k` 绝对路径那个 bug）** ③ 本地 LLM 端口探测（3b）。原因是 daemon 路由传进去的 `SelfCheckProbes` 没带这三项。→ **网页上的自检绿了，不等于 `node scripts/selfcheck.mjs` 也绿。** 验收请用 CLI 那个。
- `[读码]` **`as never` 全仓只剩 6 处真实使用、`as any` 0 处**，其中唯一与契约相关的是 `apps/daemon/src/http/upload.ts:656,663`（自己在 650 行标注为已报 Manager 的临时缺口：`shared` 还没给 `notes/upload` 的事件载荷类型）。其余是第三方无类型 API 与 Node 流类型的桥接。`jobs/events.ts` 现在**零类型断言**。→ 这一类基本清干净了，**但 upload 那两处正是 A-1 那个事故的同一形状，别放着不管。**
- `[实测]` **demo 的 LLM 配置自相矛盾**：`llm.defaultModelId = "deepseek-v4-flash"`，而 `llm.providers[0].model = "deepseek-chat"`。两处都是"当前模型"的语义，值不一样。这正是 `model-mgmt` T-109 描述的"同一个概念两个标签、两个作用域"的实际后果。
- **向量检索链路是断的**（这是已裁决的取舍，不是 bug）：`[实测]` `/api/search` 的 `modes.semantic = false`，`semanticReason: "sqlite-vec 已加载，但尚无 embedding 生成环节（链路未接通）"`。ADR/PENDING 里 Manager 已拍板 v1 砍掉，索引本就设计成可重建缓存，将来补不需要迁移数据。

### 「没做（已明确裁决）」
TTS · 说话人分离 · 翻译/双语字幕/字幕导出 · workspace 层级 · 桌面外壳（Tauri）· L0 浏览器 WebGPU（降为实验）· 本地 LLM（`llama-server` 线整体下线，ADR-016）· 本地 ASR 扩容（sherpa 多模型族 / SenseVoice / AMD ASR 自建 CI）· 代码签名证书。

### 「对外口径已被自己推翻的两条」（ADR-016 附）
- ❌ **「可导入任意 HF GGUF 模型」不成立** —— `POST /api/models/import` 的 `kind:'hf_repo'` 硬编码 501。
- ❌ **「真实 AMD 支持」只覆盖 LLM 不覆盖 ASR** —— vulkan/rocm 后端包全是 llama.cpp；而 ADR-016 又把本地 LLM 砍了，所以这条现在更站不住。
- ✅ 站得住的差异化：**量化选择** 与 **显存 fit 预检**（memo.ac 两个硬缺口，我们都实测过）。

### 「等用户 / 等硬件」（见 `coordination/PENDING-USER-DECISIONS.md`）
- **会员内容 cookie**（yt-dlp `--cookies` 是任意文件读取入口，`--cookies-from-browser` 会读全部站点凭据）—— 需用户拍板。
- **NVIDIA / macOS / Windows / 大陆机器** —— 只影响验证覆盖率，不阻塞开发（ADR-013 已把 GPU 从"中文可用性前提"降级）。
- ⚠️ **ADR-015 之后，`A-1 GitHub 仓库` 这条硬阻塞已撤销** —— 7/7 组件全部改走上游预编译，我们不托管任何东西。**PENDING 文件里那段"唯一硬阻塞"的表述已过期，别照着它去要资源。**

### ⚠️ 安全现状（必须让接手者知道）
当前 demo 是 **`OPENMEMO_AUTH=none` + 绑 `0.0.0.0:10000`**，且 dataDir 里有 `secrets.json`（用户真实的 DeepSeek API Key，0600）。
**任何能路由到这个 IP:端口的人都能读走全部笔记、转写、音频，并能删改数据。**
`oss-scout` 在 T-111 里明确拒绝过一次"关闭鉴权"的指令（理由：授权只以转述形式存在），后来是在用户被告知上述暴露面之后才落地的。
`docs/SECURITY.md` 里的威胁模型仍写着「daemon 只绑 `127.0.0.1`，绝不 `0.0.0.0`」——**该文档与当前部署不一致，需要更新**。
Host/Origin/Sec-Fetch 三道 guard 在免鉴权模式下**仍然生效**（它们挡的是 DNS rebinding，与凭据无关），CSRF 则随 token 一起关闭（无凭据时 CSRF 只剩下摩擦，不提供保护）。

---

## ⑦ 给接手者的第一步建议

### 第 0 步：确认环境（5 分钟）
```bash
cd /root/memo
node -v && pnpm -v                        # 需要 Node ≥22 / pnpm 10.15.0
git log --oneline | head -20              # ★ commit message 是本项目最好的事实来源
git status --short                        # 现在有未提交的 auth.ts / server.ts

# 看正在跑的 demo（只读，别重启）
curl -s http://127.0.0.1:10000/api/health | head -c 400
curl -s http://127.0.0.1:10000/api/selfcheck | head -c 300

# ★ 最推荐的一条：验功能可用，不验组件加载
node scripts/selfcheck.mjs --daemon http://127.0.0.1:10000
```
`selfcheck.mjs` 不问「libsimple 加载了没」，它真的建一张 FTS5 表、插中文、断言 `用户`/`推特`/`中国`/`服务` 四个双字词都匹配得上；
不问「whisper-cli 在不在」，它问「可执行吗、daemon 看得见吗、是装在 dataDir 里还是**碰巧在系统 PATH 上**（后者只算 warn）」；
还会把 `media_assets` 的每条路径解析出来，看是否真落在 dataDir 内（这一条查出过"搬完家资产 403"）。
**exit 0 才算过；`warn` 不会让它失败，但要逐条看。**

> ⚠️ **别用网页上那个自检代替它。** `[读码]` `GET /api/selfcheck` 是这个脚本的**真子集**，缺硬件探测、缺数据目录自洽性、缺本地 LLM 探测。网页绿了不代表 CLI 绿。

### 第 1 步：先读这几个文件（按顺序，别一上来读设计文档全文）
1. **本文件**（你在读了）
2. `git log --oneline`（约 90 条，写得很细）
3. `docs/00-CHARTER.md` —— 45 行，用户的原始需求 F1–F5 + 要求 2.1/2.2 + 六条工程约束
4. `docs/adr/ADR-016-user-scope-cuts.md` —— **最新的范围裁决，先看它再看别的 ADR**，否则会去做已经被砍掉的东西
5. `docs/design/D-07` + `D-08` 的 TL;DR —— 两份"设计 vs 实现"审计，专门列**设计里承诺了但代码里不存在、或存在但永不执行**的东西
6. `coordination/inbox/<你要接手的领域>.md` 的**最后 2–3 条** —— 信息密度最高，含每个人自己的"我错在哪"
7. 真要动某个域时才读对应的 `docs/design/D-0x`

### 第 2 步：**别读这两个文件**（已严重过期，会误导你）
- `coordination/BOARD.md` —— 还停在 Wave 2，写着"daemon 只有 6 个端点"，实际有几十条 REST + WS。
- `coordination/ROSTER.md` —— 只有 4 个 agent，实际是 6 路 + 本文档。
- `coordination/FEATURE-COVERAGE.md` —— **两个方向都偏过，本轮已逐条复核**：
  - **偏悲观**：三个"交付阻塞" B-1/B-2/B-3 全部已解；它标 🔴 的**拖拽上传、标签/星标/文件夹写入、笔记导出、TipTap 编辑器、首启引导、任务中心持久化**，`[读码]` **全部已接通**；"daemon 只有 6 个端点"实际约 83 条。
  - **偏乐观**：它把 **F3 标 🟢**，而 `[读码]` 前端至今是 mock。
  → 要用就当"找遗漏的清单"，**不要当"状态表"**。

### 第 3 步：动手之前，记住三句话
1. **先证明你的检查会红。**
2. **先质疑测试，再质疑代码。**
3. **只杀自己的 pid，永远不用 `pkill -f`。** 起 daemon 用你自己的端口 + 全新 dataDir，别碰 `:10000` 和 `/root/data-memo`。

### 第 4 步：协作规矩
- 读 `coordination/PROTOCOL.md`（81 行）。核心两条：**写自己的文件、读别人的文件**；**没验证过的写"未验证"**。
- 进展写进 `coordination/inbox/<你的代号>.md`（追加不覆盖），不要改别人的交付物。有异议写 `DISPUTE:`。
- 改到别人的文件时**先在 inbox 申报**。某个包的 `package.json` 的依赖字段由该包 `src/` 的所有者编辑（ADR-011 决策 3）；根配置归 `oss-scout`。
- **改完代码请回来更新本文件**，尤其是 ④（分工与在途）和 ⑥（未解决）两节。这份文档只有和代码同步才有价值。
