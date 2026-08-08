# HANDOFF —— OpenMemo 交接文档

> **这份文档是给"下一个接手的人（或模型）"看的。**
> 它不是变更日志（`git log` 已经很详细了，**108 个提交** `[实测]`，commit message 是本项目最好的事实来源之一 ——
> **但本轮查出它也会串档，见 ⑤J**）。
> 它回答三件事：**现在是什么状态 · 下一步该干什么 · 有哪些坑别再踩**。
>
> 维护者：`handoff` agent。最后更新：**2026-08-03 20:40**，对齐到 **`ae9bdb3`（T-128）+ 两路未提交的在途工作**。
> ⚠️ 本轮写作期间工作区一直在动（`storage-fix` 的 T-128 在我写到一半时被合并）。
> **④ 的在途表是 20:40 的快照，动手前请自己再跑一次 `git status` 与 `git log --oneline | head`。**
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

形态是 **本地 daemon（Node/TS）+ 浏览器 React SPA**，不是 Electron。用户全程只在网页上点，不碰命令行 ——
包括装 GPU 后端和管模型（章程要求 2.1 / 2.2）。

### 已在**当前这台机器**上实测可用的能力

以下每条都是我（`handoff`）**本轮亲自打接口拿到的输出**，对象是正在跑的 demo（`http://127.0.0.1:10000`，dataDir `/root/data-memo`）：

| 能力                                       | 证据                                                                                                                                                                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **daemon 健康 + 扩展全绿**                 | `[实测]` `GET /api/health` → `libsimple:true sqliteVec:true tokenizer:"simple" search.ok:true`，`pipeline.missing:[]`                                                                                                                                  |
| **版本可回答"重启生效了没有"（T-127 新）** | `[实测]` `health.build` = `{commit:"6b1cac01", commitTime:"2026-08-03T19:56:04+08:00", dirty:true, builtAt:…, startedAt:…}`。commit 单独不够用（同一 commit 重启两次号一样），所以**启动时刻必须一起给**。⚠️ 界面上这行**在"全部接通"时看不见**，见 ⑤D |
| **自检 19 ok / 5 warn / 0 fail**           | `[实测]` `GET /api/selfcheck` → `counts:{ok:19,warn:5,fail:0}`。**上一版 HANDOFF 写的是 11/2/0，那是"HTTP 自检缺三项"时代的数** —— 那个缺口已补齐（见 ⑤F）                                                                                             |
| **F5 全文搜索（含中文分词）**              | `[实测]` 自检里「中文双字词可搜索」通过；`modes.chineseTokenizer:true`                                                                                                                                                                                 |
| **F5 笔记列表 / 详情 / 资产**              | `[实测]` `GET /api/notes` → 真实笔记；详情返回 `original` + `audio16k` 的 `/media/asset/<uid>` URL                                                                                                                                                     |
| **F4 思维导图（真实 DeepSeek 产物）**      | `[实测]` `generatedBy:"llm:deepseek"`，节点 refs 带真实 `transcriptUid`/`startMs`/`endMs`/`quote` —— 印证 ADR-013 决策 2「LLM 只给指针，时间与引文由我们从转写稿算」                                                                                   |
| **daemon 自己托管 SPA**                    | `[实测]` `GET /` → 200，引用 `apps/web/dist` 的产物                                                                                                                                                                                                    |
| **LLM 已配置且 daemon 认**                 | `[实测]` `health.llm` = `{configured:true, providerId:"deepseek", source:"cloud"}`；`GET /api/settings` 有 `llm.defaultProviderId/defaultModelId`。用户实测 `deepseek-v4-flash` 可用（4.3 秒出图）`[报告]`                                             |
| **硬件探测（CPU 侧）**                     | `[实测]` 真实 CPU 型号（AMD RYZEN AI MAX+ 395）/32 核/14 个指令集特性。**GPU 侧仍为空**，见 ⑥                                                                                                                                                          |
| **安装记录已迁移干净（T-118）**            | `[实测]` `GET /api/models/installed` 里**再无 `/tmp/` 悬空绝对路径、再无 `installPath` 字段** —— 上一版 HANDOFF 独立查出的那个 bug 已闭环                                                                                                              |

**demo 上当前的 5 条 warn（逐条都要知道）** `[实测]`：

| warn                                      | 意味着什么                                                                                                            |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `tool.ytDlp 未找到`                       | 🔴 **F1「粘链接导入」在这台机器上现在用不了。** 这是本轮新出现的，上一版 HANDOFF 没有                                 |
| `hw.probe 未安装`                         | GPU 后端能力未知（→ ⑥ 的 L2 加速包装不了）                                                                            |
| `model.vad 未安装`                        | 切分降级为固定窗口（能跑，质量下降）                                                                                  |
| `llm.tier2 未探测到 Ollama / LM Studio`   | 正常，用户没装本地推理服务                                                                                            |
| `datadir.assetsPresent：3 条文件已不存在` | 历史遗留资产（`jfk.wav`、两条 `media/legacy/*-audio16k.wav`）。**这一条正是那个查出过真问题的检查**，别把它当噪声关掉 |

### 前端功能接线情况（`[读码]`，本轮逐文件核实）

**daemon 侧数十条 REST 路由 + 2 条 WS**（上一版数到"约 83"，本轮没有重新精确点数，别把这个数字当契约）。
前端 `routes.tsx` 聚合 12 个 feature 路由分片。逐项核实结果：

| 功能                                                     | 结论                                          | 证据                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F3 录音页（麦克风 → WebSocket）**                      | ✅ **已接通（本轮最大变化）**                 | `[读码]` `features/recorder/asrStream.ts`（**新文件**，T-117）：`AudioWorklet` 采集 → Float32→Int16 → 二进制帧推 `/ws/recorder`，下行 `ready/partial/final/overrun/stopped/error`。`RecorderPage.tsx:190` 的注释写着「此前这里是一段 `setInterval` 轮播写死的字幕」。**上一版 HANDOFF 把它列为"最大功能缺口"，那条已经过期** |
| TipTap 笔记编辑器                                        | 已接通                                        | `NoteEditor.tsx` 真 `useEditor` + 800ms 防抖自动保存                                                                                                                                                                                                                                                                         |
| 拖拽上传 `onDrop`                                        | 已接通                                        | `CapturePage.tsx` 真 `handleFiles`                                                                                                                                                                                                                                                                                           |
| 转写段落编辑                                             | 已接通                                        | `SegmentRow.tsx` 双击→textarea                                                                                                                                                                                                                                                                                               |
| 导图编辑 + SVG/PNG 导出                                  | 已接通                                        | `MindmapView.tsx` 真 mind-elixir；`export.ts` 矢量导出而非截屏                                                                                                                                                                                                                                                               |
| 搜索 UI / 标签 / 星标写入 / 文件夹 / 首启引导 / 任务中心 | 已接通                                        | 见各 feature 的 `api.ts`                                                                                                                                                                                                                                                                                                     |
| **LLM 模型选择（T-126）**                                | ✅ **已换成真 `<select>` 且两处共用一个组件** | `[读码]` `components/common/llm/LlmModelSelect.tsx`（**新**）。「AI 模型」与「按用途分别配置」两处都用它；候选来自 `vendor/manifests/llm-providers.json`（`[实测]` **24 家 / 520 条**），经 vite alias `@manifests` 引入。逃生口 =「自定义…」是下拉最后一项                                                                  |
| 设置页：LLM Key / 代理 / 数据目录                        | 已接通                                        | 三个 Section 都真调对应端点                                                                                                                                                                                                                                                                                                  |

### 只有别人的报告支持、我未独立核实的能力（**别当成已验证**）

- `[报告]` **F1 链接导入**：yt-dlp 实测跑通过（`gpu-runtime` T-030/T-031）。⚠️ 但**当前这台机器上 yt-dlp 已经找不到了**（见上表 warn），所以"现在能不能用"是未知的。
- `[报告]` **F2 本地文件**：长音频 33.6 分钟 → 80 chunk / 430 段，峰值内存 89 MB 不随时长增长。
- `[报告]` **F3 后端**：sherpa 流式 zh-14M；`architect` T-121 报告在真浏览器里验过 `partial`/`final`。当前 demo `streamAvailable:false` `[实测]`（这台机器上没装流式模型）。
- `[报告]` **中文离线引擎 Paraformer**：1 小时录音 43 秒。当前 demo `paraformerAvailable:false` `[实测]`。

---

## ② 怎么跑起来（从零到能用）

### 🚨 动手之前先记住两条硬规矩

1. **绝不 `vite build` 写进 `apps/web/dist`**（`coordination/PROTOCOL.md` §7，2026-08-03 新增）。
   `:10000` 的演示实例**直接托管这个目录**。任何人跑一次构建，用户正在看的前端就被换成别人的半成品，
   **进程没重启、版本号没变、没有任何东西报错**。验证构建一律 `--outDir /tmp/<你的名字>/`。
   `apps/web/dist` 只由 Manager 在重启前统一构建。
   （幸运的是版本戳 T-127 之后至少能事后看出来是谁的产物 —— 但只有在你想得起去看的时候。）
2. **`:10000` 与 `/root/data-memo` 只读。** 不重启、不 kill、不占用该端口、不发写请求。要起服务用你自己的端口 + 全新 dataDir。

### 前置

- Node **≥ 22**（`.nvmrc` = 22；本机跑的是 24.18.0）`[读码]`
- pnpm **10.15.0**（`packageManager` 字段已钉死）`[读码]`
- Linux x64 是唯一被验证过的平台。**macOS / Windows / arm64 / musl 全部未验证。**

### 步骤

```bash
cd /root/memo

# 1. 装依赖
pnpm install
#    pnpm-workspace.yaml 的 onlyBuiltDependencies 只放行 4 个包。
#    better-sqlite3 **刻意不在其中**（ADR-005 决策 6：它用 prebuildify，
#    放进去只会空转一次 node-gyp，安装从 500ms 变成 1m24s）。

# 2. 构建（★ 必须是 -r，不能只跑根的 pnpm build）
pnpm -r build
#    根 package.json 的 "build": "tsc -b" 只走 TS project references，
#    apps/web 的 tsconfig 是 emitDeclarationOnly:true —— 根 build **不会产出 SPA bundle**。
#    ⚠️ 而 apps/web 的 build = `tsc -b && vite build` —— 它会写 apps/web/dist，
#       也就是上面那条禁令针对的东西。**只有 Manager 该跑它。**
#    apps/daemon 的 build 现在还会跑 scripts/gen-build-info.mjs，
#    把 commit / commitTime / dirty / builtAt 烘焙进 dist/build-info.json（T-127）。

# 3. 启动 daemon（用你自己的端口和 dataDir）
node apps/daemon/dist/main.js --port 17999 --data-dir /tmp/<你的名字>-data
#    只有两个 CLI 旗标：--port 与 --data-dir。没有 --host，绑定地址只能走环境变量。
```

**为什么版本号要跟着产物走**（`scripts/gen-build-info.mjs` 的注释值得读）：启动时读 `git log -1` 拿到的是
**工作区当前的 commit**，而 daemon 跑的是 `dist/` 里**上一次构建**出来的 JS。改完提交但没重建，
页面会显示新 commit **而实际跑的是旧代码** —— 一个报告真相的东西报告了另一码事，比没有更糟。

### 当前 demo 的确切状态 `[实测]`

```
命令行  node apps/daemon/dist/main.js --port 10000
监听    0.0.0.0:10000   pid 2992138（本轮已被 Manager 重启过，不是上一版那个 pid）
构建    commit 6b1cac01 +dirty · builtAt 2026-08-03T11:56:23Z · startedAt …11:56:27Z
环境    OPENMEMO_HOST=0.0.0.0
鉴权    关闭 —— 不带任何凭据 GET /api/notes 直接 200
dataDir /root/data-memo（来自机器全局指针文件 ~/.local/share/openmemo/datadir.json，不是 --data-dir）
```

### 关键环境变量 `[读码]`

| 变量                 | 默认                      | 作用                                                                              |
| -------------------- | ------------------------- | --------------------------------------------------------------------------------- |
| `OPENMEMO_AUTH`      | **`none`**                | 只有精确等于 `token` 才开启鉴权（`auth.ts`）。**用户显式要求关掉**，见 ⑥ 安全警告 |
| `OPENMEMO_HOST`      | `127.0.0.1`               | 设成 `0.0.0.0` 才对外可达                                                         |
| `OPENMEMO_DATA_DIR`  | `~/.local/share/openmemo` | 优先级：env > `--data-dir` > 指针文件 > OS 默认                                   |
| `OPENMEMO_TLS`       | 关                        | `self-signed` → 自签 HTTPS（录音需要安全上下文时用）                              |
| `OPENMEMO_WEB_DIST`  | 自动解析 `apps/web/dist`  | **想在别的目录托管 SPA 就用它，别去动 dist**                                      |
| `OPENMEMO_DB_DRIVER` | 自动                      | 强制 `better-sqlite3` 或 `node:sqlite`                                            |
| **`OPENMEMO_PORT`**  | —                         | **不存在**。端口只能用 `--port`（默认 17650）                                     |

### 开发模式（改前端时用 —— 也是不碰 dist 的正解）

```bash
OPENMEMO_DAEMON=http://127.0.0.1:10000 pnpm --filter @openmemo/web dev -- --port 5199
```

⚠️ **`vite.config.ts` 里的 `/api`、`/media`、`/ws` 反向代理是必需的，不是可选优化**。
在它存在之前浏览器**从来就够不到 daemon**（页面在 5173、API 在 17650、daemon 当时不托管静态、vite 也没代理）——
这个缺口存在了很多轮，因为它不在任何一个人的责任范围内（前端做了页面、后端做了接口，中间这段没人认领）。
代理必须 `changeOrigin: true` **并且**重写 `Origin` 头，否则会被 daemon 的 DNS-rebinding / CSRF 双重校验 403。
同一份配置里还有 T-126 加的 `resolve.alias['@manifests'] → vendor/manifests`。

### 测试怎么跑

**根目录没有 `test` 脚本，也没有 `pnpm -r test` 的统一入口脚本**（但 `pnpm -r test` 本身能用，会跑有 test 的 **4** 个包）。`[读码]`

```bash
pnpm build:safe                       # ★ 先 build：所有测试都跑编译产物（**不要** pnpm -r build，见 PROTOCOL §7 补充）
pnpm --filter @openmemo/daemon   test
pnpm --filter @openmemo/db       test
pnpm --filter @openmemo/pipeline test  # 🆕 T-135 新加（此前本包**没有 test 脚本**，TD-002 的 7 条回归从没跑过）
pnpm --filter @openmemo/web      test  # = test:unit + test:components（后者含 test:host）
```

- ⚠️ **db / pipeline / daemon 三个包的 `test` 脚本必须保持同一行写法**，不要"顺手简化"回
  `node --test dist/**/*.test.js` —— 那一行会被 sh 吃掉 `**`，**静默漏跑**（⑤A-19，实测漏 30%）。
  现在的写法是 `node -e "<发现守卫>" && node --test`：不给位置参数（node 自己递归发现），
  前置守卫断言"源码里有几个测试文件，dist 里就有几个"（因为 `node --test` 对空集返回 exit 0）。
  **web 是例外且必须是例外**：它得显式指 `.test-out/unit/`，否则默认发现会把组件套件也扫进来；
  它的 glob **一直是带引号的**（别去掉），另配了一条守卫挡"新写的单测忘了加进 `tsconfig.test.json` 的 include"。
- ✅ **web 的三条测试都不写 `dist`**：`test:unit` → `.test-out/unit/`，`test:host` → `.test-out/host/`，
  `test:components` → `vite build --ssr … --outDir .test-out/components`。跑它们不违反 PROTOCOL §7。
- `downloader` / `llm` / `mindmap` / `runtime` / `shared` **没有 `test` 脚本** ——
  它们的验证脚本是包内的 `verify-*.mjs` / `gen-*.mjs`（如 `packages/downloader/scripts/verify-offline.mjs`，62 条断言）。
- **所有测试都跑编译产物**，必须先 build 再 test。
- 最近一次全绿记录 `[实测]`（T-135）：**`db 47 / pipeline 132 / web 单测 27 + 宿主 10 + 组件 162 / daemon 177 = 555 passed, 0 failed`**。
  ⚠️ daemon 从 113 跳到 177 **不是有人写了 64 条新测试**，是 ⑤A-19 那个 glob 修好之后，
  原本就存在却从没被跑过的 4 个文件回来了。**拿旧数字做基线的人会对不上。**

### 自检（最推荐的第一个命令）

```bash
node scripts/selfcheck.mjs --daemon http://127.0.0.1:10000
node scripts/selfcheck.mjs --json
```

退出码：只要有 `status=fail && required` 就 `exit 1`；`warn` 不影响。
**`GET /api/selfcheck` 与它的差距已经补上了**（见 ⑤F），但 CLI 版仍是验收基准。

---

## ③ 架构一页纸

```
        ┌──────────────────────── 浏览器（唯一 UI）────────────────────────┐
        │  React 19 SPA · react-router 8 · TanStack Query · Zustand        │
        │  TipTap 编辑器 · mind-elixir(编辑) + markmap(只读) · wavesurfer  │
        └───────────────┬─────────────────────────────────────────────────┘
      四条通道（HTTP/1.1 每 origin 6 连接是硬预算：1 SSE + 2 媒体 + 3 REST）
        REST /api/**  │  SSE /api/events（全局唯一一条）│ WS /ws/**（实时录音，已接通）│ /media/**（Range）
        └───────────────┬─────────────────────────────────────────────────┘
        ┌───────────────┴─── 本地 daemon（Node 22 + TS，node:http 无框架）───┐
        │ http/(static,guard,auth,rest/*) · jobs/(scheduler,runners) · db   │
        │ storage/(move,migrateRecords,migrateAssets) · pipeline · runtime  │
        │ downloader · llm · mindmap                                        │
        └───────────────┬─────────────────────────────────────────────────┘
                 子进程 spawn（崩溃隔离 + 许可证隔离 + 可独立升级）
        ┌───────────────┴─────────────────────────────────────────────────┐
        │ ffmpeg / ffprobe │ yt-dlp │ whisper-cli │ whisper-vad │ probe    │
        └─────────────────────────────────────────────────────────────────┘
```

### 包与职责边界（`pnpm-workspace.yaml`：`apps/*` + `packages/*`）

| 包                    | 职责                                                                                                                                                                                                                                 | 不该出现在这里的东西                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `packages/shared`     | **唯一契约源**：API schema、SSE 事件表、数据模型、TS 类型、`SpeedEvidence`                                                                                                                                                           | 任何 `node:*` import（曾经误引 `node:crypto` 污染浏览器包） |
| `packages/db`         | SQLite 适配层 + 26 表 migration + FTS5                                                                                                                                                                                               | 业务逻辑                                                    |
| `packages/downloader` | 统一下载器（manifest + SHA256 + Range 续传 + 多源探测 + 解包）。后端包与模型共用同一个                                                                                                                                               | 第二条下载路径                                              |
| `packages/runtime`    | 硬件探测 + GPU 后端包管理 + 熔断器 + `selfcheck.ts` 实现                                                                                                                                                                             | —                                                           |
| `packages/pipeline`   | 媒体源 → 转写 → 结构化。**`SubprocessRunner` 是全项目唯一允许 `spawn` 的出口**                                                                                                                                                       | 任何别处的 `child_process`                                  |
| `packages/llm`        | LLM 适配层：OpenAI-compatible + Anthropic 原生 + Gemini 原生                                                                                                                                                                         | —                                                           |
| `packages/mindmap`    | **库无关**的导图数据模型 + 双适配器 + 导出                                                                                                                                                                                           | 渲染器 API 泄漏                                             |
| `apps/daemon`         | HTTP/SSE/WS、任务队列、静态托管、鉴权、**数据目录搬迁与记录迁移**                                                                                                                                                                    | —                                                           |
| `apps/web`            | React SPA，`features/<name>/` 每人独占一个目录                                                                                                                                                                                       | `features/A → features/B` 的横向 import（eslint 已禁）      |
| `vendor/manifests/`   | **进 git 的数据注册表**（章程是 local-first，不远端拉取）：`llm-providers.json`（24 家/520 条）、`models-whisper.json`（25 条）、`models-asr-support.json`、`models-llm.json`、`backends.json`、`components.json`、`sqlite-ext.json` | 硬编码在前端的第二份清单                                    |

### 三条"唯一出处"约定（新近确立，违反了不会报错，所以写在这里）

1. **LLM 供应商与型号清单 = `vendor/manifests/llm-providers.json`。** 前端不再手写。
   历史教训：手写清单只有 `deepseek-chat`/`deepseek-reasoner`，而**用户实际在用的 `deepseek-v4-flash` 在旧下拉里根本不存在**
   —— 手写清单的问题不是"少"，是"错"。
2. **模型速度 = `ModelEntry.speedEvidence`（必填三态：`measured` / `estimated` / `unmeasured`）。**
   读的时候走 `describeSpeed()` / `referenceSpeedOf()`，**别自己读 `.rtf`**。
   `unmeasured` **结构上没有 `rtf` 字段** —— 不是 `rtf: null`，是"放不下数字"，所以必填不会逼出假数据。
   `[实测]` 覆盖率 `2/35 → 9/35`（其余 26 条：`not_run` 20 / `out_of_scope` 5 / `artifact_differs` 1）。
3. **LLM 协议分派 = provider 的 `kind` 字段，绝不按 id 字面量。** `llm/resolve.ts` 已改（原来是 `providerId === 'anthropic'`），
   因为新目录里 Anthropic 那家的 id 是 **`claude`**（另有 `zhipuai`/`qwen`/`siliconcloud` 同类改名）——
   按 id 判会让 Anthropic 静默落进 OpenAI 兼容分支。

### ★ `llm.*` 设置的权威关系（**本轮定案，写代码前必须知道**）`[读码]`

| 键                                             | 谁读                                                                        | 语义                                                       |
| ---------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `llm.defaultProviderId` / `llm.defaultModelId` | **daemon（`llm/resolve.ts:51-52`）**                                        | **权威。** 这是"现在实际会用哪家哪个型号"                  |
| `llm.providers[i].model`                       | **daemon 一处都不读**（全仓核实：daemon 只读 `llm.providers[i].{id,kind}`） | 只是"这家上次选的型号"的**记忆**，用于切换 provider 时恢复 |
| `llm.purposes.<purpose>.{providerId,model}`    | daemon，**逐字段**回退到上面的默认                                          | 按用途覆盖（只填 model 也成立）                            |

> **T-126b 修的就是这条关系被搞反**：表单初值从**记忆值**取，于是"打开表单什么都不改直接点确定"
> 会把权威值 `deepseek-v4-flash` 静默改成记忆值 `deepseek-chat`。
> 修法只有一句 —— **初值改成从权威那边读**，**没有**加任何"两者不同就双向同步"的猜测。
> `[实测]` demo 现在仍然是 `defaultModelId=deepseek-v4-flash` 而 `providers[0].model=deepseek-chat`：
> **这不再是"自相矛盾"，是"权威 vs 记忆"，两者本来就允许不同。** 上一版 HANDOFF 把它列为缺陷，那条已经过期。

### 数据流（一次导入的完整路径）

```
浏览器 POST /api/import ─202 jobUid─> 任务队列（lane 信号量：gpu.asr / gpu.llm 各 1，不可超卖显存）
  → 媒体源适配（yt-dlp / 直链 / RSS / HLS / 本地）→ ffmpeg 抽 16k 单声道
  → VAD 切 chunk ──► **每 chunk 落库**（"抢占点 = 续跑点 = 进度点"三合一）
  → whisper-cli / sherpa → transcript_segments
  → SSE `transcribe.segment` 推给前端（扁平信封 + 具名 event + seq）
  → （用户点）LLM 结构化 → mindmap（LLM 只回段落编号，时间与 quote 由我们从真实转写稿算）
  → FTS5（libsimple 中文分词）建索引 → /api/search 可搜
```

### 几条容易踩的架构约定

- **SSE 只开一条**（ADR-004 决策 5）。多标签页用 Web Locks 选主 + BroadcastChannel 转播。
- **token 走 URL fragment**（`/#t=…`）→ 立刻换成 HttpOnly cookie。原因是技术性的：SSE / WS / `<audio src>` **三类通道都带不了 `Authorization` 头**。
- **双 ID**：内部整数 PK（FTS5 与 sqlite-vec 都要求整数）+ 对外 ULID。
- **时间一律整数毫秒**（ADR-013 决策 3）。
- ⚠️ **路由"先注册先赢"**（`main.ts` 里 `routers.push(...)` 的顺序）。`POST /api/backends/selftest` 曾因此有一处不可达死码 ——
  **已清**：`backends.ts:350` 现在只留一条注释说明真实现在 `hardware.ts:195`。真桩仍有一个：`POST /api/models/benchmark` → 501。
- 更细的读 `docs/design/D-01`（架构）、`D-02`（26 表数据模型）、`D-05`（前端规范）、`D-10`（模型域信息架构）。**别把它们全文抄进这里。**

---

## ④ 当前工作分工与在途任务

> 来源：`coordination/inbox/*.md` 的最新条目 + `git log` + `git status`。
> ⚠️ **`coordination/BOARD.md`、`ROSTER.md`、`FEATURE-COVERAGE.md` 已严重过期**，别信它们，信 inbox 和 git log。

### 长期 agent

| 代号                | 领域                                                  | 独占写入（硬约束）                                                                                                                                  | 最近一次交付                                                                          |
| ------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `architect`         | **前端主体**：app 外壳、路由、鉴权握手、各 feature 页 | `apps/web/src/{app,lib,components/common}/**`、`features/**`、`docs/design/D-01,D-02,D-05,D-07,D-08`                                                | **T-117**：F3 录音接真 WebSocket，删掉 mock 轮播；**T-121**：真浏览器验 partial/final |
| `oss-scout`         | **daemon + DB + 根配置**                              | `apps/daemon/src/**`、`packages/db/src/**`、根配置、`scripts/license-report.mjs`                                                                    | **T-118**：安装记录迁移 + 删死桩 + SECURITY.md 如实 + AUTH_MODE 单向门                |
| `gpu-runtime`       | **流水线 + 运行时 + 自检**                            | `packages/pipeline/src/**`、`packages/runtime/src/**`、`scripts/selfcheck.mjs`、`.github/workflows/**`、`docs/design/D-04,D-06`、`docs/SECURITY.md` | T-093                                                                                 |
| `model-mgmt`        | **契约 + 下载器 + 模型/运行时页**                     | `packages/shared/src/**`、`packages/downloader/src/**`、`vendor/manifests/*.json`、`features/{models,runtime}/**`、`docs/design/D-03`               | **T-116**：24 家/520 条目录 + `speedClass`；**T-125**：`speedEvidence` 落地           |
| `ui-polish`         | **视觉/密度/文案层**（不碰 mutation 与业务判定）      | `apps/web/src/index.css`、`styles/tokens.css`、各 feature 的**呈现层**、`docs/design/D-09`                                                          | **T-114**：状态色四层展开；**T-124**：表层与品牌配色 + 对比度断言 64→88               |
| `memo-compare`      | 竞品对比（只读研究）                                  | `docs/research/R-06`                                                                                                                                | T-113：24 家/520 条取证                                                               |
| `ia-design`         | **模型域信息架构规格**（只写规格，零代码）            | `docs/design/D-10`                                                                                                                                  | **T-115**：D-10，29 条迁移表                                                          |
| `llm-picker`        | LLM 选择器（窄任务）                                  | `components/common/llm/**`                                                                                                                          | **T-126 / T-126b**                                                                    |
| `handoff`（本文档） | 交接文档                                              | `HANDOFF.md`、`coordination/inbox/handoff.md`、被裁决授权的回写                                                                                     | 本文件 + D-05 §7.1/§7.2 回写                                                          |

### ✅ 刚落地：`storage-fix` T-128（`ae9bdb3`，20:09）

**数据目录搬迁的符号链接修复已合并**，三处改动：
`fs.cp` 加 `verbatimSymlinks: true`；`verifyTreesMatch` 把符号链接**纳入校验**（比 `readlink` 的结果，
并区分"链接被 deref 成真文件"）；新增 `findStaleLinks()` 查"搬完之后还有没有链接指着即将被删的旧位置"。
`MoveResult` 新增 `links` / `staleLinks` / `warningZh`（纯新增，无破坏性改动），`measureTree` 返回值加 `links`。
测试 13 → 32 条，**四组反向验证**（见 ⑤A 的规矩 1）。
合并很干净：`ae9bdb3` 只有 `move.ts` + `move.test.ts` + `inbox/storage-fix.md` 三个文件，**没有夹带**。

> ⚠️ 两条已知边界（作者自己标的，别当成已覆盖）：**只在 Linux/ext4 验过**（Windows 建符号链接需要额外权限，
> 行为可能不同）；`findStaleLinks` **不覆盖**"相对链接跨出数据目录"（如 `../../x`）—— **明知而未做，不是漏了**。
> 另：`measureTree` 现在把链接自身的 `lstat().size` 也算进 `bytes`，**对着旧字节数做过基线的人会对不上**。

### 🔵 **正在跑、尚未提交**的两路（20:40 快照，`git status` 为准，**别当成已落地**）

| 代号              | 任务                                                     | 工作区状态 `[实测]`                                                                                                                                                                                                                                                                                                                          | 接手时要知道什么                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `models-page-fix` | `/models` 页与呈现层修复                                 | `M features/models/{ModelsPage,ModelDetailPage}.tsx`、`components/{ModelCard,DownloadRow,QuantSelector,StorageBreakdown}.tsx`、`components/common/{FitBadge,JobToaster,llm/LlmSettingsSection}.tsx`、`features/notes/NotesListPage.tsx`、`features/settings/DataLocationSection.tsx`、两个 locale、`?? components/common/Emphasis.tsx`（新） | 正在修「`?tab=llm` 时 Tab 切换条自己消失」（切换条原本写在 `tab==='asr'` 的 `hidden` section 里面，`ModelsPage.tsx:288` 有注释记着）。另新增 `Emphasis.tsx`：把文案里的 `**强调**` 渲染成 `<strong>`，而不是把星号原样吐给用户 —— 因为 `GET /api/secrets` 的 `disclosure.messageZh`（"API Key 以\*\*明文\*\*保存在…"）**按 ADR-006 必须由服务端给**（路径随 dataDir 变），前端不能就地删星号 |
| `job-events`      | **T-130 job 事件契约**（`job.created` 的载荷类型不够用） | `M packages/shared/src/{jobs,events,api}.ts`、`M packages/runtime/src/selfcheck.{ts,test.ts}`、`M apps/daemon/src/http/rest/storage.ts`、`M apps/web/src/test/components.test.tsx`                                                                                                                                                           | `JobCreatedEvent.job` 从 `DownloadJob` 改成 `AnyJob` 判别联合（`DownloadJob \| PipelineJob`，按 `kind` 判别）—— **转写与导图任务根本描述不成 `DownloadJob`**（没有字节计数器）。消费方必须用 `isPipelineJob()`/`isDownloadJob()` 收窄。⚠️ 它同时在 `rest/storage.ts` 里**把 T-128 的 `staleLinks`/`warningZh` 接出到搬迁响应** —— 即下面 ⑥ 那条"没有出口"正在被关掉，但**尚未提交**          |

### 在途 / 刚落地但未闭环

| 项                                           | 状态                                | 归属                       | 说明                                                                                                                                                                            |
| -------------------------------------------- | ----------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **搬迁 `warningZh` 接到 UI**                 | 🔵 daemon 侧已在工作区、前端侧未见  | `job-events`               | daemon 响应已加 `staleLinks`/`warningZh`（未提交）。**`DataLocationSection.tsx` 那头要渲染出来**才算闭环 —— 只回不渲染 = 把假绿灯换成一盏没接线的红灯                           |
| **`/models?tab=llm` Tab 条消失**             | 🔵 修复未提交                       | `models-page-fix`          | `[实测]` HEAD 上仍复现                                                                                                                                                          |
| **侧栏「星标」筛选根本没实现**               | 🔴 未修                             | notes owner（`architect`） | `[读码]` `NotesListPage.tsx` 只有"渲染星标图标"和"切换星标"，**没有任何一处读 `useSearchParams()` 的 `starred`** → `/notes?starred=1` 与「全部笔记」完全一样                    |
| **T-127 的版本戳在"全部接通"时不显示**       | 🔴 未修                             | `architect`                | 见 ⑤D                                                                                                                                                                           |
| **`role=llm` 的 5 条 GGUF 仍在目录里**       | 🔴 未清                             | `model-mgmt`               | ADR-016 砍了本地 LLM，`models-llm.json` 里 5 条已标 `out_of_scope` 但**下架动作没做**（D-10 #7，等 Manager 裁决停用范围）。`backends.json`/`components.json` 里的 llamacpp 同理 |
| **「+ 添加服务商」只有 11 个预设**           | 🔴 未做                             | `architect`                | 目录 24 家 / 520 条，实际接进下拉的是 11 家 / 283 条。**够不到的 13 家 / 237 条不是漏了，是用户加不进去**（D-10 #24）                                                           |
| **`OPENMEMO_AUTH=none` 的契约字段**          | 🟡 已生效，契约未定                 | `oss-scout` → `architect`  | `GET /api/health` **至今没有 `auth` 字段** `[实测]`；前端 `lib/api/auth-mode.ts` 用"宽容读"顶着（认三种写法），**契约定稿后必须收紧成单一字段**                                 |
| **纯 UI 保存 LLM 配置 / 401 自愈的真实往返** | 🟡 隔离实例验过、demo 未做          | 需要能开浏览器的人         |                                                                                                                                                                                 |
| **F4 导图保存（PATCH）真浏览器验证**         | 🟡 后端有、前端已打开、真浏览器未验 | 需复验                     | 验收动作：拖一个节点 → 应看到一条 `PATCH /api/notes/:uid/mindmap` → 刷新后仍在                                                                                                  |
| **`components/common/HealthBanner.tsx`**     | ✅ 已删                             | —                          | `git log --diff-filter=D` 确认删于 `70210a0`。上一版 HANDOFF 说它还在，**那条已过期**                                                                                           |

---

## ⑤ 踩过的坑与由此立下的规矩

> **这是这个项目最有价值的产出。** 下面每一条都是真实事故，不是假想风险。

### A. 假绿灯家族（十八例）—— 本项目最贵的一类 bug

| #      | 事故                                                                                 | 后果                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------ | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1      | **`as never` 关掉类型检查**                                                          | T-028 报"端到端打通"，但 daemon 发出的每个 SSE 事件**字段名全是错的**，前端只会拿到一堆 `undefined`。e2e 脚本**只断言了事件类型、没断言 payload 字段名**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2      | **`node --test` 对空集返回绿**                                                       | 出现过**三次**（tsconfig 继承 `exclude` 编出 0 个测试 / 产物落进 `node_modules` 被默认跳过 / 产物放 `dist/test` 被 `emptyOutDir` 清掉）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 3      | **`git check-ignore` 默认看索引**                                                    | 文件一旦被 track 它就闭嘴，而 Tailwind 的目录扫描**根本不看 git 索引**。必须加 `--no-index`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 4      | **只断言"返回 200"**                                                                 | "发一个没用的令牌"也能过。改成断言**"返回的 CSRF 令牌真的能写"**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 5      | **只断言前置条件的测试**                                                             | "普通重启不换目录"那条**根本没重启**，它会永远绿。作者自评：**"只断言前置条件的测试，和不写测试是一样的。"**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 6      | **假代理没监听 `CONNECT`**                                                           | 差点写出"全局 fetch 不受 setGlobalDispatcher 影响"的假结论，**差一点就因为自己的坏测试去改一个没坏的东西**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 7      | **VAD 模型被当成 ASR 模型**                                                          | 按目录归类 → 自检"有 ASR 模型"变绿                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 8      | **`isSafeExecutable` 用宿主的 `path.isAbsolute` 判 Windows 路径**                    | 在 Linux 上 CVE 分支**不可达**，`.bat` 测试**一直在为错误的理由通过**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 9      | **金丝雀被别人挡住了**                                                               | 挡住恶意 HLS 的其实是 **ffmpeg 自己的 `allowed_segment_extensions`**。**"挡住了"不等于"是我们挡住的"**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 10     | **`redirect:'follow'` 丢掉 `x-linked-size/etag`**                                    | 预校验**静默失效且不报错**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 11     | **TD-002 被过早关闭**                                                                | 依据的测试走的**不是产品的真实导入路径**。**GPL 兜底在真实路径上从未触发过**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 12     | **"包全装上了但扩展加载不了"**                                                       | 7 个包全 `succeeded`、sha256 全过，daemon 起来 `tokenizer=trigram vec=off`，**中文双字词搜不到，零报错**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 13     | **修复本身无效**                                                                     | `extractJson` 第一次修时把检测放在内层扫描**之后**，等于没修 —— 顺序反了不会让任何用例变红                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **14** | 🆕 **`verifyTreesMatch` / `measureTree` 显式跳过符号链接**                           | **移动数据目录 = 静默弄坏转写后端，而自检报"两棵树一致"。** `fs.cp` 默认把相对链接改写成**指向源目录的绝对路径**，紧接着删源 → 8 条 `.so` 链当场全断（`libwhisper.so → .so.1 → .so.1.9.1` 两级链**两跳都被改写**）。用户的 `:10000` **真的中过这一枪**，whisper 后端装着但 `error while loading shared libraries`。⚠️ **坏了还告诉你没坏，比坏了更严重**。✅ 根因已修（T-128 / `ae9bdb3`）；`[实测]` demo 上那 8 条链也已被手工重建为相对链接并可解析                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **15** | 🆕 **旧测试把 bug 写成了期望**                                                       | `llm-picker` 发现一条断言写着 `assert.equal(sel.value, 'deepseek-chat')` —— **而那正是缺陷行为**（表单从"记忆值"取初值）。修复时不是悄悄换掉，而是改成断言权威值并**说明旧断言写错了方向**，同时保留"记忆值不许从候选里消失"那一半                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **16** | 🆕 **Tailwind 对不存在的类不报错**                                                   | 提交串档造成 `bg-accent-tint` 的悬空引用：`[实测]` `e896e2b` 那一刻 `LlmSettingsSection` 用了它，而 `index.css`/`tokens.css` 都**没有定义**（各 0 命中）。**从那个 commit 干净检出，LLM 服务商卡片的"选中"底色会渲染成没有底色，一个字都不提示。** 与更早那次 `text-success` 是同一种失败模式。（该洞已被 `6b1cac0` 闭合）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **17** | 🆕 **对比度断言全在管"前景 vs 背景"**                                                | 所以"背景 vs 背景"从没被看过：明档 `--surface-0/1/2` 三档两两只有 **1.03:1**，`hover:bg-surface-2` 压在卡片上 **1.02:1**（18 处调用点的鼠标反馈等于没有），侧栏选中态与 hover **完全同色**。**D-05 §7.2 承诺的"三级抬升"在亮色主题里从未真正存在过** —— 那不是一条被违反的规范，是**一条描述了不存在事实的规范**。已回写（见 ⑤K）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **18** | 🆕 **测试的名字和它实际断言的东西可以完全无关**                                      | 用例名叫「回车跳转到 `/search?q=…`」，**却从没断言过 URL**。`[实测]` 把 `navigate(...)` 整句删掉，两条**照样绿**；换成断言 location 后同一个变异体当场红。关键是**为什么没有机制能发现**：名字是字符串、断言是代码，**两者之间不存在任何约束** —— 编译器不看、类型不看、lint 不看、**覆盖率更不看**（覆盖率只问"这行跑没跑过"，而它确实跑过了 `SearchBox` 的每一行，包括 `navigate` 所在的那个函数）。**它是覆盖率报告上的一条绿线。**<br>**规矩 1：读测试先读断言** —— 把名字遮住，问"这些断言什么时候会失败"。<br>**规矩 2：答不上来就变异** —— 把被测行为整句删掉跑一遍，不红就说明钉住的是零。<br>**规矩 3：诚实地记下妥协，不等于妥协是对的** —— 该用例注释写着"不方便断言"然后就地降级，而那个"不方便"实际上是 5 行代码的事。（✅ 已换掉，T-133b / `8a48568`，组件测试现为 **151/151 零 skip**）                                                                                                                                                                                                                             |
| **19** | 🆕 **测试脚本里的 `**` 被 shell 吃掉，于是「跑了一部分」看起来和「全跑了」一模一样** | `node --test dist/**/*.test.js` **没加引号**：pnpm 用系统 sh 跑脚本，而 **sh 不认 `**`**，它等价于 `dist/*/*.test.js`（**恰好两层**）。`[实测]` `apps/daemon` 13 个测试文件**只跑到 9 个**，报 `113 pass / 0 fail`；带引号跑全部则是 `174`，**其中 7 条是红的**（鉴权用例，见 ⑤J 第五例）。`packages/pipeline` 10 个文件**只跑到 1 个**（132 条只报 6 条，exit 0）。`packages/db` 当时是绿的，但**正确的原因是巧合** —— 它三个文件恰好都在一层，sh 匹配不到、按 POSIX 把 pattern 原样透传给 node，node 自己的 glob 才认 `**`；**任何人加一个两层深的测试文件，另外三个当场静默消失**。<br>**这一条最坏的地方是它污染的是判断依据本身**：Manager 据「门禁全绿」做过的每一次决定（含重启 demo），当时都建立在一个漏跑 30% 的脚本上。<br>**判据不是「要记得加引号」，是「写错了也不会有后果」**：改成 `node --test`（不给位置参数，用 node 自己的递归发现）+ 一条前置守卫断言「源码里有几个测试文件，dist 里就有几个」——因为 `node --test` **对空集返回 exit 0**（⑤A-2 的第四次）。db / pipeline / daemon 现已统一成同一行（T-135）。 |

> ### ★ 由此立下的规矩（不可协商）
>
> 1. **任何新加的检查，先证明它会红。** 没见过它红过，就不知道它在检查什么。
>    （做得最好的一次是 T-128：**四组反向验证**，逐组把修复拆掉一半、贴真实的 `✖ fail` 输出，
>    其中一组还原到"事故当天的代码"，把假绿灯**一比一复现**出来。这是本项目验证工作的标杆。）
> 2. **怀疑代码之前，先证明测试是对的。** 本项目"测试的结论不可信"至少出现 7 次（第 7 次是 A-15）。
> 3. **验收"某性质成立"时，必须确认测试覆盖的是产品的真实路径**，而不是一条为测试而设的旁路。
> 4. **测试通过时要问一句"它通过的理由对不对"。**
> 5. **禁止 `as never` / 无谓的类型断言**。把契约交给编译器守，不要交给人记。
> 6. 🆕 **"跳过 = 撒谎"。** 一个校验函数如果显式跳过某类对象，它就**不许**声称"两边一致"。
>    要么覆盖它，要么把跳过的范围如实写进返回值。
> 7. 🆕 **断言要钉后果，不要钉形式。** T-128 那几条 `.so` 的最终断言是
>    "顺着链 `readFile` 真的读到目标内容"，不是 `access()` / `lstat()` ——
>    **悬空链接 `lstat` 照样成功**，"组件存在"在这个 bug 上恰恰就是那盏假绿灯。

### B. 假红灯同样危险

`pgrep` 数到了并行任务 → 误报孤儿进程泄漏；`pkill -f` 打断了别人的 daemon → 冷启动"43→3"被误读成产品 bug。
还有一次是自检本身：中文检索探针最初查在**用户的 `segments_fts`** 上，全新安装（库是空的）四个词全 0 → 报红。
**新用户第一次打开诊断页就看到红叉，久了就学会无视红灯。** 改成建临时表 + 自带语料，结果与用户数据无关。

> **规矩：假红灯会训练人忽略告警，和假绿灯一样要当 bug 修。** 出现红灯先问"这个红是真的吗"。

### C. 「写得进读不回 / 前后端键名对不上」—— 五次

| 字段                    | 症状                                                                                                                                                                                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `textRaw`               | `PATCH` 写进去了，`GET transcript` 的序列化**没带这个字段** → 落地即丢                                                                                                                                                                             |
| `noSpeechProb`          | `whisperServer.ts` 把它**硬编码成 null**。（顺带查明：CLI 路径上这个字段**永远是 null**，`cli.cpp` 的 `output_json()` 从未调用那个公开 API，**没有任何 flag 能改，不是我们的 bug**）                                                               |
| `installPath`           | **一个名字底下藏着三个概念** → 拆成 `linkInto` / 删除 / `unpackInto`。✅ `[实测]` **已彻底清干净**：`packages/shared/openapi.yaml` 0 命中，dataDir 里的旧安装记录也被 `storage/migrateRecords.ts` 迁移过（`GET /api/models/installed` 再无该字段） |
| `settings` 双层嵌套     | `GET` 回 `{settings:{…}}`、`PATCH` 只收扁平的 → **把 GET 的结果原样 PATCH 回去**会造出一个字面名叫 `settings` 的键                                                                                                                                 |
| `llm.defaultProviderId` | 前端 `onSave` 写了 `providers` + `baseUrl`，**唯独这个键一次都没写过**，而它是 daemon 唯一认的键                                                                                                                                                   |

> ### ★ 规矩
>
> - **契约测试要"测对面会读的键"，不是"测我发了什么"。**
> - **让读写形状可以互换**：`GET` 的输出直接喂回 `PATCH` 必须幂等。
> - **UI 显示"当前生效"时，要读"对面会读的那个键"** —— 照自己的清单显示就永远显示正常、永远发现不了缺键。
> - **一个名字对应多个概念时，第三条路既不是"执行它"也不是"忽略它"，是先把概念拆开再分别命名。**
> - 🆕 **两个值可以合法地不同时，要在文档里写清"谁是权威、谁是记忆"**（见 ③ 的 `llm.*` 权威表）。
>   没写清的后果就是 T-126b：一个纯读的动作（打开表单点确定）静默改掉了权威值。

### D. 「后端做好了、前端还关着 / 还藏着」—— 四次

- `RecorderPage.tsx` 的 `showModel={false}`：当初写它是对的（那会儿选择器是假的），后来选择器改真了，**这个 `false` 变成了过时的保护**。已修。
- `MINDMAP_SAVE_SUPPORTED = false`：daemon 的 `PATCH /api/notes/:uid/mindmap` **早就落地了**，前端常量没跟着翻回来。已**整个删掉**（`features/mindmap/api.ts` 留了注释说明"是删除不是改成 true"，并有回归测试断言该导出必须是 `undefined`）。
- 🆕 **`/models?tab=llm` 时 Tab 切换条自己消失**：切换条写在 `<section className={tab === 'asr' ? … : 'hidden'}>` **里面**，
  于是切到「语言模型」之后**页面上再没有切回「转写」的控件**。`models-page-fix` 正在修。
- 🆕 **T-127 的版本戳在"全部接通"时看不见** `[读码]`：`daemon v0.1.0 · 08-03 19:56 · 起 19:56` 这行渲染在
  `MockNotice.tsx` 的 `ConnectivitySummary` 里面，而该组件开头就是 `if (mocked === 0) return null;`。
  **一切正常时，那个用来回答"重启生效了没有"的东西自己消失了** —— 而"一切正常"恰恰是你最需要确认它的时候。

> ### ★ 规矩：**这类开关必须与"后端有没有"绑定，不能靠人记得回来开。**
>
> 正确处置不是把 `false` 改成 `true`（那只还这一次的债），而是**把开关整个删掉**，让"后端有没有"自己说话。
> 🆕 **同一族的第三种形态是"嵌套条件"**：把 A 放进 B 的显示分支里，A 就继承了 B 的消失条件。
> Tab 条嵌在 tab 分支里、版本戳嵌在"有 mock 才显示"里 —— 两处都不是开关，所以那次"搜三类开关"的排查搜不到它们。
> **判据：问"这个东西该在什么时候出现"，再问"它实际在什么时候出现"，两句话不一样就是 bug。**

### D-bis. 注释与代码不一致 —— ✅ 三处已全部订正

| 位置                                        | 曾经写                           | 现状 `[读码]`                                                                                                                            |
| ------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/vite.config.ts`                   | 「daemon 自己托管 SPA…尚未实现」 | **已订正**，现在那段注释讲的是代理为什么必需                                                                                             |
| `features/settings/DataLocationSection.tsx` | 「这个端点还不存在」             | **已订正**：注释明写"`GET\|POST /api/settings/data-dir` **已经落地**（`rest/storage.ts`），这段注释此前还写着'端点目前不存在' —— 已订正" |
| `packages/shared/openapi.yaml`              | 4 处 `installPath`               | **0 命中**                                                                                                                               |

> **★ 规矩：注释里的"尚未实现"必须带失效条件。** 更好的做法是不写这句，改成让代码自己失败。
> 附带一条好实践：上面第二条的订正**保留了"此前写着什么"**，而不是抹掉 —— 下一个人因此知道这里改过。

### E. 跨端降级必须以对端**确实存在的行为**为依据

前端 `client.ts` 在 sessionStorage 不可用时会主动降级成**不带 CSRF 头**，注释写"由 Origin 校验兜底" —— **但服务端当时根本没有这个兜底**。
症状：读全通、写全挂（`GET` 200，`PATCH` 403 `CSRF_FAILED`）→ 用户填完点保存、界面一切正常、库里 0 行。

> **★ 规矩：降级的前提必须是"对端确实这么行为"，否则那不是降级，是静默失败。**

### F. 验"功能可用"，不验"组件加载"

不要问「libsimple 在不在」，要问「`用户` 这个词能不能搜到」。
`scripts/selfcheck.mjs` 就是按这条写的：真建 FTS5 表插中文、真 spawn probe 枚举 GPU、真把 `media_assets` 的路径解析出来看是否落在 dataDir 内。

- ✅ 🆕 **`GET /api/selfcheck` 曾是这个脚本的"真子集"（缺硬件探测 / 数据目录自洽性 / 本地 LLM 探测），现已补齐**
  `[实测]` HTTP 端点现在 19 项，`hw.probe`、`datadir.assetsPresent`、`llm.tier2` 三项都在。
  **上一版 HANDOFF 那条"网页绿了不代表 CLI 绿"已经过期。** CLI 版仍是验收基准（判据更全、退出码可用）。
- **文件存在性检测不可信** —— `libvulkan.so.1` 存在但机器没有 GPU、没有 `/dev/dri`。
- **`枚举数 > 0` 同样不可信** —— lavapipe（软件光栅化）让无 GPU 的机器报告 1 个 Vulkan 设备。必须检查 `deviceType`。
- **在系统 PATH 上找到 ffmpeg 只能算 warn 不能算 ok** —— 开发机恰好有，不代表产品能装上。

### G. `.gitignore` 少一个前导斜杠 → 两种毫不相干的症状，都不报错

第 10 行曾是 `models/`（没有前导 `/`）。git 的语义是**匹配任意层级**同名目录，于是命中了 `apps/web/src/features/models/`：

1. **Tailwind v4 遵守 `.gitignore`** → 该目录**独有**的工具类从未被生成；而 `absolute`、`rounded-lg` 恰好别处也在用，照常生效 → **同一个 className 里一半生效一半不生效，看代码永远看不出来**。
2. **那 11 个源文件根本没进版本库**。一次 `git clean -fdx` 就全没了。**这条比视觉 bug 严重得多。**

修法：`models/` → `/models/`，`bin/runtime/` → `/bin/runtime/`。
护栏：`scripts/check-tracked-sources.mjs`（`git check-ignore --no-index`）。

> ✅ 🆕 **它现在有调用方了**：根 `package.json` 的 `check:sources` 与 `check`（`check-tracked-sources && pnpm -r build && eslint .`）。
> ⚠️ **但仍然没有自动执行者** `[实测]`：仓库只有一个 workflow（`build-backends.yml`，手动触发且**从未执行过**），`.git/hooks` 里没有非 sample 的钩子。
> **谁接手谁把 `pnpm check` 接进 CI 或 pre-commit。** 上一版说"没有任何调用方"，现在准确的说法是"有入口，没人跑"。
> ⚠️ `.gitignore` 里 `data/`、`build/`、`out/`、`dist/`、`target/` **同样没有锚定**，目前没误伤源码，但同类隐患还在。

### H. 禁止 `pkill -f`（三次事故）

本机同时跑着多个 daemon。`pkill -f 'dist/main.js'` 会把别人的实例一起杀掉，其中一次让"冷启动 43→3"被误读成产品 bug。

> **★ 规矩：只杀自己记录下来的 pid。起进程时就把 pid 记进 inbox。** 用独立端口 + `setsid`。
> 这条已被所有 agent 遵守并在回执里显式声明。

### J. 🆕 提交卫生：`git add -A` 已经**五次**把不相关的改动扫进别人的提交

上一版记了两次。后来 `git show --stat` 逐个核对，又查出两次，而且形式更隐蔽 —— **commit message 和内容完全对不上**。
**第五例（T-135 查出）是其中后果最重的一例，单列在表格下面。**

| commit                   | message 说的                                                                                                          | 实际装的 `[实测]`                                                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `75474bc` (14:55)        | 「docs: D-10 模型信息架构整合规格 (T-115)」                                                                           | D-10 **加上** T-118 的全部代码（`storage/migrateRecords.ts`、`auth.ts`、`SECURITY.md`）**加上** T-117 的全部代码（`RecorderPage.tsx`、**新文件 `asrStream.ts`**） |
| `93310ea` (14:57)        | 「fix: 安装记录迁移 + 删死桩 + SECURITY.md 如实 + AUTH_MODE 单向门 (T-118)」                                          | 只剩 `DataLocationSection.tsx` + `vite.config.ts` 两个文件                                                                                                        |
| `18f205f` (14:59)        | 「feat: F3 前端接真 WebSocket，拆掉 MOCK 轮播与写死数字 (T-117)」                                                     | **只有 `coordination/inbox/architect.md`**，一行代码都没有                                                                                                        |
| `9d57689` (15:26)        | 「test: F3 真浏览器验证 (T-121)」                                                                                     | 顺带装走了 T-114 的 `components/common/statusTone.ts` 等一大批配色代码（T-114 自己的提交 `2209b19` 里只剩 docs 和 i18n）                                          |
| **`d12ab1e` (14:16)** 🆕 | 「**docs**: memo.ac 内置清单取证 —— 24 家供应商 / 520 条模型 (T-113)」，正文通篇讲竞品的 LLM 目录、**一个字没提鉴权** | 除了 R-06 与两份 research 资产，还装着 `apps/daemon/src/http/{auth.ts,server.ts}` —— **即「鉴权默认关闭」（`AUTH_MODE` 默认值翻成 `none`）这条改动本身**          |

**成因**：14:55 有人用 `git add -A` 提交，把当时磁盘上**别人已写完但还没提交**的文件一并扫走。
后面那两个"本人提交"就只剩残渣。

**后果不是洁癖问题**：

- 本项目**把 commit message 当作最重要的事实来源**（本文档开头就这么写）。串档直接污染这个来源 ——
  想知道 F3 是怎么接通的，`git log --oneline` 会把你指到一个只有 inbox 文件的提交。
- 还制造了 ⑤A-16 那个**跨提交的悬空引用**：`bg-accent-tint` 的使用被 T-126 带走，定义留在 T-124，
  两者之间的每一个 commit 检出来都是坏的，而 Tailwind 一声不吭。

> #### 🔴 第五例（`d12ab1e`）为什么单独说 —— 它污染的东西不一样
>
> 前四例污染的是「**F3 是怎么接通的**」这类实现问题：查起来绕路，但绕得过去。
> **第五例污染的是「鉴权是何时、被谁、依据什么关掉的」** ——
> 一条**安全相关的默认值变更**，被埋进了一个标题与正文都在讲竞品 LLM 目录的 `docs:` 提交里。
> 任何人用 `git log --oneline | grep -i auth` 或者按 message 找"什么时候关的鉴权"，
> **都会一无所获**，而这恰恰是接手时最该问清楚的一件事
> （当前 demo 是 `OPENMEMO_AUTH=none` + 绑 `0.0.0.0`，dataDir 里有用户真实的 API Key，见 ⑥ 安全现状）。
>
> **连带后果（T-135 实测）**：同一批改动让 `daemon.test.ts` / `settings.roundtrip.test.ts` 里
> **7 条鉴权用例的前提静默失效**（它们写于"鉴权强制开启"的年代，却没有显式声明档位）。
> 而 `apps/daemon` 的 test 脚本当时用了一个被 sh 吃掉的 glob，**这两个文件根本没被跑到** ——
> 于是 7 条红的用例存在了几小时，`pnpm -r test` 一路报绿。
> **两个缺陷叠加的效果是"红灯存在但没有任何人看得见"。** 两者均已修（T-135）。
>
> Manager 已主动认领这一例的责任并要求记录在案：**历史里那条改不了，能改的是让后来的人查得到。**

> **★ 规矩：提交前跑 `git status`，只 add 自己这轮改的路径，把精确清单写进 inbox 回执。**
> 近几轮的 agent 已经在这么做了（`ui-polish` / `llm-picker` / `model-mgmt` / `storage-fix` 的回执里都有逐行 `git add` 清单，
> 有的还主动声明"这些不是我的"）。**清单是给合并者用的，合并者要照着它 add，而不是 `-A`。**
> 另：改共享区的人和提交的人是两个人时，这个时间窗必然存在。
> `ui-polish` 的处理值得抄：发现自己的改动被别人的提交带走之后，**回来更正了自己的提交清单**并说明为什么"这不是那位 agent 的错"。

### K. 🆕 规范和现实冲突时，先问哪一个是错的

`ui-polish` 换表层配色时撞上 D-05 §7.1/§7.2（那两节把表层/品牌色钉死了）。它的处理很克制：
**没绕过，也没改别人的交付物**，而是把新规则写进自己的 `D-09 §8`，在 `tokens.css` 文件头标注指路，然后把裁决权交回 Manager。

**裁决（T-131）：D-09 §8 是现行事实，回写 D-05。** 理由不是"新的比较新"，而是：

> D-05 §7.2 的表层三档在明档实测**两两只有 1.03:1** —— 即"三级抬升"在亮色里**从未真正存在过**。
> 它不是一条被违反的规范，而是**一条描述了不存在事实的规范**。
> 照它写出来的 `hover:bg-surface-2`（1.02:1）**代码没错，规范错了**。

已完成的三件事：

1. `docs/design/D-05-frontend.md` §7.1/§7.2 更新为当前取值，**§7.1b 是变更说明**（谁改的/何时/为什么/依据哪次实测），不是静默覆盖。
2. `apps/web/src/styles/tokens.css` 文件头那条「以 D-09 §8 为准」的指路标注**已改写** —— 回写后它就成了指向已合并文档的悬空指针。
   现在写的是：规范 = D-05 §7.1/§7.2，D-09 §8 保留为**变更过程档案**，状态色四层展开仍以 D-09 §7 为准。
3. 四个 `--status-*` 锚点与 `--data-1..4` **一个都没动**。

> **★ 规矩：一条从未被任何断言覆盖过的规范，很可能从落笔那天起就是错的。**
> 判据补上了：`tokens.contrast.test.ts` 新增"表层之间可分辨"断言，阈值 `SURFACE_MIN = 1.06`，
> **明确标注为本仓库自定、不是 WCAG**（标准里没有"两块背景要差多少"这一项）——
> **自定阈值可以，冒充标准不行。**
> 该测试**从 `tokens.css` 现场解析**而不是抄一份常量：抄一份就等于允许两边分叉。`[实测]` 18/18 通过。

### I. 其它值得知道的坑

- **`fetch` 会忽略 `Host` 头**（forbidden header）→ 测 DNS rebinding 必须用 `http.request`。
- **`node:sqlite` 返回 null 原型对象**，`better-sqlite3` 返回普通对象 → `deepStrictEqual` / `hasOwnProperty` 会静默出错。
- **`vec0` 的 rowid 绑 JS `number` 必失败** → 用 BigInt / 字面量 / `CAST(? AS INTEGER)`。
- **扩展能力只能实测，不能查 `compile_options` 推断。**
- **判重一律按 SHA256，不按体积** —— `ggml-large-v1.bin` 与 `v2.bin` **字节数完全相同**，sha256 不同。
- **`json_object` 不是强约束** —— llama-server + Qwen3 会返回带 markdown 围栏的文本。只有 `json_schema` 是语法级约束。
- **`formatSseFrame()` 发 `event: <type>` → `EventSource.onmessage` 永不触发**，必须逐类型 `addEventListener`。
- **Tailwind v4 的 `@theme{}` 变量不能嵌套** → 明暗双档必须用 `:root`/`[data-theme]` + `@theme inline` 转发；写成普通 `@theme` **暗色永远不生效且不报错**。
- **jsdom 里 React 退回 IE 时代的事件 polyfill** → 一输入就抛异常。必须在 react-dom 被 import **之前**把事件属性挂到 document 上。
- 🆕 **`<select>` 遇到不在 options 里的 value 会显示成空** → 用户的配置"看起来没了"，再点一次保存就真没了。
  `LlmModelSelect` 的做法：**值不在候选里 ⇒ 自动进自定义模式并把原值原样填进文本框**。
  同一文件还记了另一条：**"是否自定义"必须是派生值不能是 state** —— 候选异步到达，首帧算出的 `true` 会永远卡住。
- 🆕 **量化几乎不影响速度** `[报告，T-125 实测]`：base 三种量化体积差 2.5 倍，RTF 差异**小于运行间噪声**。
  → 量化是省磁盘/内存的，**UI 别暗示"选小的更快"**。
- 🆕 **同名不同文件**：`sherpa-streaming-zh-14m` 上游 RTF 0.01–0.07 是 **74 MB 浮点版**，我们发的是 **25.4 MB int8 版**。
  清单里标成 `artifact_differs`，**不标出来下一个人几乎必定抄过去**。
- **设计文档里写「（略）」会被下游当成"照抄即可"，实际是空洞。DDL 不许省略。**
- **被报告过但没进任务清单的缺陷，等于没被报告。**

---

## ⑥ 已知未解决 / 未验证

### 「做了没验」

- **macOS / Windows / arm64 / musl 全部零验证。** T-128 的 `verbatimSymlinks` 同样只在 Linux/ext4 验过（Windows 建符号链接需要额外权限，行为可能不同，**作者明确不声称**）。
- **Anthropic / Gemini 适配器只跑过本地 mock**，没有真 Key。「能证明请求形状符合文档」≠「能证明真实端点会接受」。
- **代理没有在真实可用的代理后面测过** —— 用的是死代理反证法：证明了流量确实改道，**未证明"经代理能成功出网"**。
- **`verifying` / `blocked` 两个安装状态**：T-114 已补验（`blocked` 当时被发现**根本不可达**并修好）；`serious` 一档仍无真实场景截图。
- **F4 导图保存、纯 UI 保存 LLM 配置、401 自愈的真实往返** —— 见 ④。

### 「验了没通过 / 当前就是坏的」

- `[实测]` **demo 上 yt-dlp 找不到** → **F1 链接导入在这台机器上现在用不了**。这是本轮新增的 warn。
- `[实测]` **GPU 探测在 demo 上是空的**：`gpus: []`，四个后端全 `available:false`，原因都是 `probe executable not found`。**要求 2.1 的 L2 加速包在这台机器上装不了**（L1 CPU 包按 ADR-014 豁免 probe 门禁，转写本身不受影响）。
- `[实测]` **`GET /api/health` 的 `host` 字段写死 `'127.0.0.1'`**（`http/server.ts:121`），而 socket 实际绑在 `0.0.0.0:10000`。
  注释说它是给单实例探测拼提示 URL 用的，但**读它的人会得出"只绑回环"的错误结论** —— 而这恰好是 T-111 里反复强调的安全前提。
  建议要么改名，要么补一个真实的 bind 地址字段。**仍未修。**
- `[读码]` **`upload.ts:656,663` 还有两处 `as never`**（自己在 650 行标注为已报 Manager 的临时缺口：`shared` 还没给 `notes/upload` 的事件载荷类型）。
  全仓 `as any` 只剩 1 处；`jobs/events.ts` 零类型断言。→ 这一类基本清干净了，**但 upload 那两处正是 A-1 那个事故的同一形状。**
- **向量检索链路是断的**（已裁决的取舍，不是 bug）：`/api/search` 的 `modes.semantic = false`，理由是"sqlite-vec 已加载，但尚无 embedding 生成环节"。v1 已拍板砍掉，索引本就设计成可重建缓存。
- 🔵 **搬迁后的 `warningZh` 出口只做了一半**：T-128 算出了 `staleLinks`/`warningZh`；`[实测]` daemon 侧
  `rest/storage.ts` 的响应**已在工作区里加上**（`job-events`，未提交），但**前端 `DataLocationSection.tsx` 还没渲染它**。
  在两头都接上之前，"链接断了"仍然只有读日志的人看得到。

### 「没做（已明确裁决）」

TTS · 说话人分离 · 翻译/双语字幕/字幕导出 · workspace 层级 · 桌面外壳（Tauri）· L0 浏览器 WebGPU（降为实验）·
本地 LLM（`llama-server` 线整体下线，ADR-016 —— **但目录里的 5 条 GGUF 与 llamacpp 后端包还没清**）·
本地 ASR 扩容 · 代码签名证书。

### 「对外口径已被自己推翻的两条」（ADR-016 附）

- ❌ **「可导入任意 HF GGUF 模型」不成立** —— `POST /api/models/import` 的 `kind:'hf_repo'` 硬编码 501。
- ❌ **「真实 AMD 支持」只覆盖 LLM 不覆盖 ASR** —— vulkan/rocm 后端包全是 llama.cpp；而 ADR-016 又把本地 LLM 砍了。
- ✅ 站得住的差异化：**量化选择** 与 **显存 fit 预检**（memo.ac 两个硬缺口，我们都实测过）。

### 「等用户 / 等硬件」（见 `coordination/PENDING-USER-DECISIONS.md`）

- **会员内容 cookie**（yt-dlp `--cookies` 是任意文件读取入口，`--cookies-from-browser` 会读全部站点凭据）—— 需用户拍板。
- **NVIDIA / macOS / Windows / 大陆机器** —— 只影响验证覆盖率，不阻塞开发。
- ⚠️ **`A-1 GitHub 仓库` 这条硬阻塞已撤销**（ADR-015：7/7 组件改走上游预编译）。**PENDING 文件里那段"唯一硬阻塞"的表述已过期。**

### ⚠️ 安全现状（必须让接手者知道）

当前 demo 是 **`OPENMEMO_AUTH=none` + 绑 `0.0.0.0:10000`**，且 dataDir 里有 `secrets.json`（用户真实的 DeepSeek API Key，0600）。
**任何能路由到这个 IP:端口的人都能读走全部笔记、转写、音频，并能删改数据。**
`oss-scout` 在 T-111 里明确拒绝过一次"关闭鉴权"的指令（理由：授权只以转述形式存在），后来是在用户被告知上述暴露面之后才落地的。
✅ **`docs/SECURITY.md` 已更新为如实**（T-118）：原来那条「daemon 只绑 `127.0.0.1`，绝不 `0.0.0.0`」现在是**划掉的**，
并列出真实部署与恢复命令（`OPENMEMO_HOST=127.0.0.1`），还写明 SSRF 那节的"我们绑在回环"前提**在当前部署下并不成立**。
**上一版 HANDOFF 说该文档与部署不一致，那条已过期。**
Host/Origin/Sec-Fetch 三道 guard 在免鉴权模式下**仍然生效**（它们挡的是 DNS rebinding，与凭据无关），CSRF 随 token 一起关闭。

---

## ⑦ 给接手者的第一步建议

### 第 0 步：确认环境（5 分钟）

```bash
cd /root/memo
node -v && pnpm -v                        # 需要 Node ≥22 / pnpm 10.15.0
git log --oneline | head -20              # ★ commit message 是本项目最好的事实来源 —— 但会串档，见 ⑤J
git status --short                        # ★ 先看有谁正在改什么，别撞车

# 看正在跑的 demo（只读，别重启、别构建 apps/web/dist）
curl -s http://127.0.0.1:10000/api/health | head -c 600     # 注意 build.commit / startedAt
node scripts/selfcheck.mjs --daemon http://127.0.0.1:10000
```

`selfcheck.mjs` 不问「libsimple 加载了没」，它真的建一张 FTS5 表、插中文、断言四个双字词都匹配得上；
不问「whisper-cli 在不在」，它问「可执行吗、daemon 看得见吗、是装在 dataDir 里还是**碰巧在系统 PATH 上**（后者只算 warn）」；
还会把 `media_assets` 的每条路径解析出来，看是否真落在 dataDir 内。
**exit 0 才算过；`warn` 不会让它失败，但要逐条看**（当前 5 条，见 ①）。

### 第 1 步：先读这几个文件（按顺序）

1. **本文件**（你在读了）
2. `coordination/PROTOCOL.md` —— **99 行，先读 §7（`apps/web/dist` 禁令）**
3. `git log --oneline`
4. `docs/00-CHARTER.md` —— 45 行，用户的原始需求 F1–F5 + 要求 2.1/2.2 + 六条工程约束
5. `docs/adr/ADR-016-user-scope-cuts.md` —— **最新的范围裁决，先看它再看别的 ADR**，否则会去做已经被砍掉的东西
6. `docs/design/D-07` + `D-08` 的 TL;DR —— 两份"设计 vs 实现"审计
7. `docs/design/D-10` 的 TL;DR —— 模型域信息架构与 29 条迁移表（有明确的责任 agent 与批次）
8. `coordination/inbox/<你要接手的领域>.md` 的**最后 2–3 条** —— 信息密度最高，含每个人自己的"我错在哪"
9. 真要动某个域时才读对应的 `docs/design/D-0x`

### 第 2 步：**别读这三个文件**（已严重过期，会误导你）

- `coordination/BOARD.md` —— 还停在 Wave 2，写着"daemon 只有 6 个端点"。
- `coordination/ROSTER.md` —— 只有 4 个 agent，实际是 9 路 + 三路临时。
- `coordination/FEATURE-COVERAGE.md` —— **两个方向都偏过**（把已接通的标 🔴、把当时还是 mock 的 F3 标 🟢）。
  要用就当"找遗漏的清单"，**不要当"状态表"**。

### 第 3 步：动手之前，记住五句话

1. **先证明你的检查会红。**
2. **先质疑测试，再质疑代码。**（测试可能把 bug 写成了期望 —— ⑤A-15）
3. **不要 `vite build` 进 `apps/web/dist`；不要碰 `:10000` 与 `/root/data-memo`；只杀自己的 pid，永远不用 `pkill -f`。**
4. **提交只 add 自己的路径，把精确清单写进回执。**（⑤J）
5. **"跳过 = 撒谎"。** 校验函数不许一边跳过一边声称一致。

### 第 4 步：协作规矩

- 读 `coordination/PROTOCOL.md`。核心两条：**写自己的文件、读别人的文件**；**没验证过的写"未验证"**。
- 进展写进 `coordination/inbox/<你的代号>.md`（追加不覆盖），不要改别人的交付物。有异议写 `DISPUTE:`。
- **要改别人的交付物时的正确姿势**（`ui-polish` T-124 的样板，见 ⑤K）：把新规则写进**自己的**文档，
  在代码里留一条指路注释，然后在 inbox 里请 Manager 裁决回写。**不偷偷例外，也不代替别人改他的文档。**
  裁决落地后，**记得回来清掉那条指路注释** —— 否则它就变成指向已合并文档的悬空指针。
- **改完代码请回来更新本文件**，尤其是 ④（分工与在途）和 ⑥（未解决）两节。这份文档只有和代码同步才有价值。
