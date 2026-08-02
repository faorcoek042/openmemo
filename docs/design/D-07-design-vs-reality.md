---
id: D-07
author: architect
status: ready
date: 2026-08-03
inputs: D-01, D-02, D-05, 00-CHARTER.md, apps/daemon/src/**, apps/web/src/**, packages/**
method: 逐条读码比对 + 对运行中的 daemon 实地探针
---

## TL;DR（≤ 25 行，Manager 只读这里）

- **本文是设计与实现的逐条对账**。我是 D-01/D-02/D-05 的作者，这份文档要回答的不是"做完了多少"，而是**"设计里承诺的东西，哪些在代码里根本不存在，哪些存在但永远不会被执行"**。
- **最重的一条**：`@openmemo/runtime` **整个包 daemon 从不 import**（`grep "from '@openmemo/runtime'" apps/` 零命中）。硬件探测、后端安装、GPU 降级链、熔断器全在里面，全是死代码。**章程要求 2.1 的实现主体没有接线。** daemon 用的是自己的兜底，`gpus: []` 恒为空。
- **第二重**：**chunk 级续跑事实上失效**。每次重跑先 `createTranscript` 建新行、再在这条**空的新行**上查已完成 chunk → 恒为空集 → 全量重跑，且旧稿被置 `is_active=0`（用户看不到之前转好的部分）。D-01 §4.1 把 chunk 层称为"整套设计的关键技巧"，四个收益里"续跑点"这一个是假的。
- **第三重**：**流水线 job 无法取消**。`Scheduler.cancel()` 全仓零调用方，`/api/jobs/:id/cancel` 打的是下载队列。跑飞的 whisper 只能等超时或杀 daemon。
- **一类系统性问题：前端就绪、服务端断链**。我做的 M-4 段落编辑（服务端无 `UPDATE transcript_segments`）、M-7 锚点（`note_anchors` 零写入）、B-3 LLM 设置（`/api/settings/llm` 实测 404）三条 UI 全部悬空。**两边各自以为对方会做。**
- **实地探针发现**（daemon 真在跑，`/api/health` 实测）：`libsimple` 与 `sqlite-vec` **都没加载成功**（文件不存在），tokenizer 降级为 `trigram` → **中文分词和语义检索在真实运行时都是关的**；`pipeline.missing: ["whisper-cli","asr-model"]` → **转写在本机不可用**。
- **搜索有一个会静默丢数据的 bug**：FTS 外部内容表在指纹变化后重建 DDL，但**没有 `'rebuild'` 回填** → 扩展一旦在两次启动间失效，已有数据搜索**静默返回 0 条**（不报错）。
- **单实例保护有真实缺口**：`daemon.lock`+flock 完全没实现，dataDir 一致性检查只在**端口冲突分支**执行。同 dataDir 换端口起第二个实例畅通无阻，而 `recoverOnStartup` 会**无条件**把 running 改回 queued → 第二个实例启动瞬间抢走第一个正在跑的 job。
- **安全面两条**：`/api/health` 在 guard **之前**返回，无鉴权泄露 `dataDir` 与一堆绝对路径（唯一无凭据可触达的问题）；**CSP 响应头全仓零命中**（D-01 §8.1 列了完整策略）。
- **做得确实扎实的**：yt-dlp 七层参数注入防护逐条对上；zip-slip / 路径穿越 / 文件名 ULID 化完整；SSE 单流+重放+挤旧连接；lane 信号量含我设计的 `gpu.exclusive` 互斥；幻觉检测是真代码且四个引擎全接了；Anthropic provider 是真实现不是壳；26 张表与 D-02 一一对应无多无少。
- **证据等级**：本文每条标 `[实测]`（我打过接口/跑过命令）、`[读码]`（读过源码并给行号）、`[推断]`（仅凭设计推理，无代码证据）。**没有一条是凭记忆写的。**
- **对 Manager 的影响**：§5 的 5 条是我认为最先会在真实使用中炸的；§4 的章程对账给出"真做到 / 看起来做到"的分栏。

---

# 详细内容

> **方法**：两个 subagent 逐文件读码（daemon 39 个 .ts / packages 全量），我本人对**运行中的 daemon**（127.0.0.1:17650）做实地探针，并逐条走查 apps/web。
> **证据等级**：`[实测]` 我执行过命令/打过接口 · `[读码]` 读过源码，附文件:行号 · `[推断]` 无代码证据，仅设计推理。

---

## §1 设计了但**从未实现**

### 1.1 D-01（架构）

| # | 设计条目 | 出处 | 状态 | 证据 |
|---|---|---|---|---|
| 1 | **`daemon.lock` + flock 数据目录级互斥** | §2.3 | 🔴 完全不存在 | `[读码]` grep `flock\|daemon\.lock\|O_EXCL` 于 `apps/ packages/` **无命中** |
| 2 | **安全模式**（60s 内 5 次崩溃 → 只起 http+db + 强制跳 `/diagnostics`） | §2.7 D | 🔴 触发机制不存在 | `[读码]` grep `crash.json\|safe_mode` 于 `apps/daemon` 无命中；`packages/db/src/open.ts:28` 留了 `safeMode` 开关，`main.ts:176-180` 调用处**不传** |
| 3 | 端口全占时绑 `port 0` 兜底 | §2.2 阶梯第 4 步 | 🔴 直接报错退出 | `[读码]` `single-instance.ts:157-160`；且扫描上限是 **17659 而非 17669** |
| 4 | 孤儿子进程回收（`worker_pid`+`worker_started_at` 防 PID 复用） | §2.7 B | 🔴 无读取方 | `[读码]` `queue.ts:291-302` 的 `recoverOnStartup` **主动把 `worker_pid` 清成 NULL** —— 把回收凭据擦了 |
| 5 | `tmp/` 启动清空 / `tmp/orphans` GC | §2.7 C, D-02 §6.4 | 🔴 只 mkdir 不清理 | `[读码]` `main.ts:90-92`；grep `rmSync.*tmp\|orphans` 无命中 |
| 6 | **CSP 响应头** | §8.1 | 🔴 零命中 | `[读码]` grep `content-security-policy` 全仓无命中 |
| 7 | **`POST /notes/:uid/focus` 前台自动提优先级** | §4.3 | 🔴 不存在 | `[读码]` grep `focus` 于 daemon+shared 无命中 |
| 8 | **chunk 边界协同抢占**（让出 lane 给高优先级） | §4.3 | 🔴 未接线 | `[读码]` pipeline 支持（`transcribe.ts:280 shouldYield`），但构造处 `setup.ts:152` **不传 `preemption`** → `yielded` 恒 false |
| 9 | **LLM 不可用 → 启发式大纲**（F4 必须永远产出点东西） | §7.2 | 🔴 无对应代码 | `[读码]` grep `heuristic\|启发式` 于 mindmap+daemon 无命中；`runners/mindmap.ts:10` 直接转 `blocked` |
| 10 | **VRAM OOM 自动降级重试**（换 CPU / 更小量化） | §7.2 | 🔴 无 | `[读码]` grep `RESOURCE_VRAM_OOM` 无命中 |
| 11 | `PROC_CRASHED`（信号杀死=崩溃）与失败的分类 | §7.3 | 🔴 无 | `[读码]` grep `PROC_CRASHED` 无命中；`runner.ts:51` 有 `signal` 原料但无分类代码 |
| 12 | CI grep 断言：禁 `0.0.0.0`、禁业务代码出现 `yt-dlp` | §8.1, §6.4 #2 | 🔴 无 | `[读码]` `.github/workflows/` 只有 `build-backends.yml` |
| 13 | CI `no-restricted-imports` 禁止 `node:child_process` | §8.4 L1 | 🔴 无 | `[读码]` `eslint.config.js` 的 3 处限制全是我加的 web 分层规则 |

### 1.2 D-02（数据模型）

| # | 设计条目 | 出处 | 状态 | 证据 |
|---|---|---|---|---|
| 14 | **FTS `'rebuild'` 回填** | §4.5 / §5.2 规则 2 | 🔴 无 | `[读码]` `migrate.ts:207-215` 重建 DDL 但不回填；grep `rebuild` 于 `packages/db` 无命中 |
| 15 | `vec_chunks` vec0 虚表创建 | §4.3 | 🔴 生产零调用 | `[读码]` grep `USING vec0` 仅命中 `extensions.test.ts:131` |
| 16 | **embedding 生成环节** | §4.3 | 🔴 不存在 | `[读码]` `packages/llm/src/types.ts:74`「已裁决 v1 不做（T-033）」；`search.ts:5` 自承「embedding 生成环节当前不存在」 |
| 17 | **RRF 混合检索融合** | §4.4 | 🔴 无 | `[读码]` `search.ts:173` 单路 bm25 排序，`:196` `hybrid: false` |
| 18 | **`peaks.ompk` 生成器**（波形） | §3.4 | 🔴 只有前端解码器 | `[读码]` grep `ompk` 只命中 web 的 `decodeOmpk`/`mockPeaks`；`media_assets.role='peaks'` 零写入 |
| 19 | **`media/<noteUid>/` 归档布局** | §6.2 | 🔴 未落地 | `[读码]` 产物停在 `tmp/job-<id>/`（`transcribe.ts:122`）；daemon 只好把**绝对路径**塞进 `rel_path`（`runners/transcribe.ts:55-59`）→ **违反 §1.1「路径一律相对」** |
| 20 | 重转写后三层引用重定位（quote 相似度 0.75/0.4） | §3.5 | 🔴 无实现 | `[读码]` 只有类型字段 |
| 21 | 备份保留 3 份 / §5.4 恢复流程 | §5.1/§5.4 | 🔴 无 | `[读码]` `VACUUM INTO` 有（`migrate.ts:96-101`），清理与恢复无 |
| 22 | GC / 引用计数 | §6.4 | 🔴 无 | `[读码]` grep 无命中 |

### 1.3 D-05（前端）—— 我自己的账

| # | 设计条目 | 出处 | 状态 | 证据 |
|---|---|---|---|---|
| 23 | **词级 karaoke 高亮** | §4.4 | 🔴 从未实现 | `[读码]` `TranscriptList.tsx:45` 的 `hasWordLevel` **只用于显示徽标**，从未按 `words[]` 逐字高亮 |
| 24 | `/diagnostics` 安全模式页 | §1.2 | 🔴 未注册 | `[读码]` `routes.tsx` 无此路由 |
| 25 | **契约版本不匹配的阻断对话框** | §5.1/§5.2 | 🔴 算了但从不渲染 | `[读码]` `connect.ts` 设置 `contractMismatch`，全仓**无任何 .tsx 消费它** —— D-05 只有两个"阻断对话框"场景，这是其一 |
| 26 | `settings/{asr,llm,storage,about}` 分页 | §1.2 | 🟡 路由存在但不分支 | `[读码]` `SettingsPage.tsx` 无 `section` 判断 → 所有 section 渲染同一页 |
| 27 | 段内搜索 / 批量导入折叠行 / J·K·L 手势 | §4.4/§4.1/§4.4 | 🔴 均无 | `[读码]` 文案 key 已写（`detail.searchInNote`/`capture.batchCollapsed`），UI 无 |
| 28 | 任务进度的 `aria-live` 播报 | §6.3 | 🟡 只在 Banner | `[读码]` grep `aria-live` 仅 `Banner.tsx` |

---

## §2 ★ 实现了，但**与设计不一致**或**永远不会被执行**

这一节比 §1 危险，因为**代码存在会让人以为功能存在**。

| # | 项 | 状态 | 证据与后果 |
|---|---|---|---|
| **29** | **`@openmemo/runtime` 整个包** | ⚠️ **daemon 从不 import** | `[读码]` `grep "from '@openmemo/runtime'" apps/ packages/` **零命中**（尽管 `apps/daemon/package.json` 声明了依赖）。daemon 走自己的兜底 `rest/hardware.ts`，注释自承「权威实现归 packages/runtime」，`gpus: []` 恒为空。→ **硬件探测、后端安装、GPU 降级链、熔断器全部是死代码。章程要求 2.1 的实现主体没有接线。** |
| **30** | **chunk 级续跑** | ⚠️ **事实上失效** | `[读码]` `runners/transcribe.ts:93-101` 每次先 `createTranscript`（纯 INSERT + 把旧稿置 `is_active=0`，`repos.ts:328-334`），再对**这条空的新行**查 `completedChunks` → 恒为空集。→ 2 小时播客重启后从零开始，且用户**看不到**之前已转好的部分。落库本身是对的，接线是错的。 |
| **31** | `plan_version` 跨版本保护 | ⚠️ 函数从未被调用 | `[读码]` `deriveResumeSet()`（`transcribe.ts:356`）唯一调用方是它自己的测试；runner 传的是**编译期常量** `PLAN_VERSION` 而非 `job.plan_version`（`runners/transcribe.ts:144`）→ 判断恒真，第二道保险也是空的 |
| **32** | **流水线 job 的取消/暂停** | 🟡 有实现，无调用方 | `[读码]` `Scheduler.cancel()`（`scheduler.ts:66-69`）**全仓零调用方**，`main.ts` 未把 scheduler 交给任何 router。`/api/jobs/:id/cancel` 打的是下载队列（`rest/jobs.ts:47`），pause/resume 诚实返回 501。`hard_cancel` 列写了没人读，`unblock()` 定义了没人调（**blocked job 条件满足后永不自动解除**） |
| **33** | `Idempotency-Key` | ⚠️ 前端发、服务端不读 | `[读码]` 队列层实现了幂等（`queue.ts:85-92`），**HTTP 层 grep `idempotency` 无命中**；`notes.ts:99-106` 的 `enqueue` 不传该字段。前端确实在发（`client.ts:109`） |
| **34** | **熔断器** | 🟡 实现完整，零调用方 | `[读码]` `runProbe.ts:212-246` 有 `recordProbeOutcome`/`isBlacklisted`（设计得很好，含驱动指纹失效重置），**除 re-export 外无调用**；`manager.ts:126` 的 `blacklistedBackends` 恒为空集。阈值也是 2 而非设计的 3；`backend_installs.failure_count` 零写入 |
| **35** | ASR 引擎降级链 | 🟡 只有启动前选择 | `[读码]` `selectEngine.ts:118` 是**启动前**三级选择，不是**运行中失败后降链**；且候选池只注册了 whisper（`setup.ts:130`）→ `whisper.cpp → sherpa-onnx` 在产品里**不可能触发**，尽管 4 个引擎都实现了 |
| **36** | GPU 降级链顺序 | ⚠️ 文档间不一致 | `[读码]` 实现是 `vulkan → cuda → cpu`（`manager.ts:54`，依 ADR-003 决策 3 的体积理由），D-01 §7.2 写的是 `cuda → vulkan → cpu`。**实现有理，是我的文档没跟上 ADR。** |
| **37** | **`SubprocessRunner` 是唯一 spawn 出口** | ⚠️ 另有 4 处直连 | `[读码]` 合规出口 `pipeline/subprocess/runner.ts:18`；绕过者：`asr/whisperServer.ts:161`、`runtime/probe/runProbe.ts:64`、`runtime/selfTest.ts:107`、`runtime/detect/system.ts:31`（后者还用**裸名 PATH 搜索** `sysctl`/`powershell`）。且三处把**全量 `process.env`** 传给子进程（`runProbe.ts:75`、`selfTest.ts:115`、`system.ts:31`）—— §8.4 L5 点名要剔除的 `LD_LIBRARY_PATH`/`DYLD_*` 反而被显式加回 |
| **38** | 优雅退出 | 🟡 缺三件 | `[读码]` `main.ts:302-315` 无 `daemon.shutdown` SSE 广播、无给 job 置 `cancel_requested`、无子进程 SIGTERM→10s→SIGKILL 阶梯；且 `sse.close()` 在 `server.close()` **之前**。→ **前端 `system.sse.ts:19` 在监听一条永远不会到来的事件**，实际体验是 SSE 无预警断开 |
| **39** | Windows 数据目录 | ⚠️ 违反 D-02 §6.1 硬规则 | `[读码]` `config/paths.ts:26-28` 用 `APPDATA`（Roaming）。D-02 §6.1 原文：「**Windows 用 `LOCALAPPDATA` 不用 `Roaming`** —— 域环境下漫游配置会尝试同步，几 GB 会拖垮登录」 |
| **40** | `Origin` 校验 | 🟡 非 GET 不强制 | `[读码]` `server.ts:109` 调 `guardRequest` **未传 `requireOrigin: true`**，缺 Origin 直接放行（`guard.ts:56`）。WS 侧是对的（`ws.ts:41` 传了） |
| **41** | ffmpeg 适配层（ADR-005 TD-002） | ⚠️ 只做到封装 | `[读码]` `audio/ffmpeg.ts` 导出的是自由函数，**无 interface、无注册表**，与 `MediaSource`/`AsrEngine` 形态不同。二进制路径收口了、安全加固到位，但"可替换的注册表条目"没有 |
| **42** | `mindmap_node_refs.transcript_id` | ⚠️ 硬编码 NULL | `[读码]` `mindmapRepo.ts:173-174`。→ D-02 §3.5「transcript 切换 `is_active` 时按 transcript_uid 回退」无法工作 |

### 2.1 空壳清单（建了表/接口，**零写入方**）

`[读码]` 全部经 grep `INSERT INTO <表>` 确认：

`note_anchors`（我的 M-7 前端已就绪，服务端断链）· `embed_chunks` · `speakers`（说话人分离未接）·
`segment_translations`（v1 预留，符合设计）· `mindmap_edges` · `mindmap_summaries` ·
`recordings`（F3 会话）· `backend_installs` · `model_installs`（**模型管理未接 DB**）·
`job_steps` · `job_events` · `secrets`（密钥实际落在 JSON 文件 `packages/llm/src/secrets.ts:24`，不是设计的表）·
`transcript_segments.text_raw` / `edited_at`（**我的 M-4 UI 无后端**）·
`vecInsert`/`vecDelete`/`vecSearch`（实现完整有测试，生产调用方 0）·
`recordProbeOutcome`/`isBlacklisted` · **整个 `@openmemo/runtime`** ·
`SherpaOnnxEngine`/`ParaformerEngine`/`WhisperServerEngine`（实现完整，未注册进候选池）

---

## §3 实地探针：**运行中的 daemon 实际是什么状态**

`[实测]` 2026-08-03，对 127.0.0.1:17650 的活实例：

```
$ curl -sS http://127.0.0.1:17650/api/health
{"app":"openmemo","version":"0.1.0","contractVersion":1,
 "dataDir":"/root/.local/share/openmemo","host":"127.0.0.1","port":17650,
 "db":{"driver":"better-sqlite3","sqliteVersion":"3.53.4","journalMode":"wal","schemaVersion":1,
   "extensions":{"libsimple":false,"sqliteVec":false,"tokenizer":"trigram",
     "failures":{"libsimple":"文件不存在：…/bin/ext/libsimple.so",
                 "sqlite-vec":"文件不存在：…/bin/ext/vec0.so"}},
   "search":{"ok":true,"tokenizer":"trigram"}},
 "lanes":{"net.download":{"capacity":2},"net.llm":{"capacity":2},"cpu.media":{"capacity":4},
   "gpu.asr":{"capacity":1},"gpu.llm":{"capacity":1},"io.local":{"capacity":4},
   "gpu.exclusive":{"capacity":1}},
 "pipeline":{"missing":["whisper-cli","asr-model"],"ffmpeg":"/usr/bin/ffmpeg","whisperCli":null}}
```

**读出来的四件事**：

1. ✅ **lane 配置与 D-01 §4.2 完全一致**，含我设计的 `gpu.exclusive` 互斥 —— 这条是真做到了。
2. 🔴 **`libsimple` 与 `sqlite-vec` 都没加载**（文件不存在）→ `tokenizer: "trigram"`。
   **中文分词与语义检索在真实运行时是关的**，尽管 T-014 实测过它们能用。降级路径工作正常（这是设计对的地方），但**产品处于降级态而没人知道**。
3. 🔴 **`pipeline.missing: ["whisper-cli","asr-model"]`** → **转写在本机不可用**。ffmpeg 有，ASR 没有。
4. ✅ 只绑 `127.0.0.1`（`ss -ltnp` 确认），`runtime.json` 权限实测 `600`。

**端点实测**（带 cookie + Origin）：

| 端点 | 结果 |
|---|---|
| `GET /api/notes` | ✅ 200 `{"notes":[]}` |
| `GET /api/jobs` | ✅ 200 `{"jobs":[],"concurrencyLimit":2}` |
| `GET /api/search?q=test` | ✅ 200，但 `modes:{keyword:true,chineseTokenizer:false,semantic:false}` |
| `GET /api/folders` | ✅ 200，**返回已建好的树数组**，不是 `{folders:[]}` |
| `GET /api/settings/llm` | 🔴 **404 NOT_FOUND** —— 我的 B-3 LLM 设置页无后端 |

**由此发现并已修复的前端 bug** `[实测→已修]`：
`useFoldersQuery` 按 `{folders: FolderDto[]}` 解包，实际是裸树数组 → `d.folders` 为 `undefined` →
`buildTree(undefined)` 抛 TypeError → **整个侧栏白屏**。
讽刺的是我当初特意给 `buildTree` 加了防环保护、理由正是"一条坏数据不该让侧栏白屏"，
**却把防御写在了错误的层级** —— 防住了环，没防住形状。已改为容忍两种形状并在无法识别时返回空数组。

**单实例保护实测有效** `[实测]`：用 `OPENMEMO_DATA_DIR=/tmp/om-audit` 起第二个实例，被正确拦下：
> `启动冲突：端口 17650 被另一个数据目录的 OpenMemo 实例占用（对方 dataDir=/root/.local/share/openmemo，本次 dataDir=/tmp/om-audit）`

这条 D-01 §2.3 的三条件判定是**真的работает**。但见 §5.4 的缺口。

---

## §4 章程逐条对账：真做到 vs 看起来做到

> 判据：**"真做到"= 一个只会用浏览器的用户，在本机能把这件事从头做完。**

### F1 音视频链接导入

| 环节 | 判断 | 依据 |
|---|---|---|
| URL 解析（probe） | ✅ **真做到** | `[读码]` 四个 MediaSource 实现齐全 + 回归测试；`[实测]` 他人报告 YouTube probe 成功 |
| 下载 | ✅ 真做到 | `[读码]` yt-dlp 七层防护逐条对上 |
| **转写** | 🔴 **本机不可用** | `[实测]` `pipeline.missing:["whisper-cli","asr-model"]` |
| **续跑** | 🔴 **看起来做到了** | §2 #30：代码在、事实上每次全量重跑 |
| **取消** | 🔴 **看起来做到了** | §2 #32：UI 有按钮，服务端无路由 |
| 归档到 `media/<noteUid>/` | 🔴 未做 | §1 #19：产物停在 `tmp/`，`rel_path` 存绝对路径 |

### F2 本地媒体导入
- 分块上传 ✅ 真做到（`upload.ts` + 单测，磁盘名 ULID 化）
- 后续转写与 F1 同样受阻。

### F3 录音转文字
- 流式引擎 ✅ 可用（`[读码]` sherpa/paraformer 实现完整）
- **浏览器麦克风采集 → 推流 🔴 未实现**（我标注过，属我的域）
- `recordings` 表**零写入** → 会话不落库
- 两阶段合并 ✅ 逻辑实测跑通过，但 **`edited_at` 零写入方** → "保留用户编辑"分支在真实使用中永远走不到
- **判断：🔴 端到端不成立。**

### F4 思维导图
- 转写稿 → LLM → 导图 ✅ 后端跑通过（38 段 → 12 节点）
- 前端渲染/编辑/SVG·PNG 导出 ✅ 我已接上
- **但 `/api/settings/llm` 404 → 用户配不了 API Key → F4 在真实环境不可用**
- `mindmap_edges` / `mindmap_summaries` 零写入 → 自由连线与概要不产出
- LLM 缺失时的启发式兜底 🔴 无（§1 #9）
- **判断：🟡 引擎可用，入口不通。**

### F5 笔记管理
| 子项 | 判断 |
|---|---|
| 列表 / 详情 / 标签 / 星标 / 文件夹 | ✅ 真做到（端点实测 200，前端已接） |
| **搜索** | 🟡 **看起来做到了**：端点在、UI 在，但**中文分词与语义都关着**（§3），且 FTS 缺 rebuild 会静默返回 0 条（§1 #14） |
| **时间轴联动** | 🔴 **看起来做到了**：`peaks` 无生成器 + media 未归档 → **波形画不出来**，F5 的核心体验缺主要视觉 |
| **转写段落编辑** | 🔴 UI 有，服务端无 `UPDATE transcript_segments` |
| **"引用此刻"锚点** | 🔴 UI 有，`note_anchors` 零写入 |
| 笔记正文（TipTap） | 🟡 UI 有，`PATCH /api/notes/:uid` 未实测 |
| 导出 | ✅ 真做到（纯前端，27 个测试） |

### 要求 2.1 网页装 GPU 依赖
- **🔴 看起来做到了，实际主体没接线。** `@openmemo/runtime` 整个包 daemon 从不 import（§2 #29）。
  硬件探测返回 `gpus: []`，后端安装/自检/降级链/熔断器**在产品里从未执行**。
- 后端包下载与解压本身 ✅ 实测过（Zip-Slip 38/38）。

### 要求 2.2 网页管模型
- 目录/下载/校验 ✅ 真做到（实测下过 59.7MB 模型）
- **`model_installs` / `backend_installs` 表零写入** → 安装记录不落库，D-02 §1.8 设计的"可重建索引"没有建
- **判断：🟡 下载能用，状态不持久。**

---

## §5 ★ 我认为最可能在真实使用中出问题的 5 个地方

### 5.1 `@openmemo/runtime` 整个包是死代码 —— 章程要求 2.1 的主体没接线
`[读码]` `grep "from '@openmemo/runtime'"` 零命中。
**为什么最危险**：这不是"某个函数没调用"，而是**一整个包**（硬件探测 / 后端安装 / 降级链 / 熔断器）从未进入运行时。
它有完整实现、有测试、有 package.json 依赖声明 —— 所有表面证据都指向"做完了"，
唯独没有人 import 它。任何只看交付报告或看包结构的人都会判断 2.1 已完成。
**用户症状**：运行时页面永远显示"未检测到 GPU"，装了后端也不会被使用。

### 5.2 长任务三件套：续跑失效 + 无法取消 + 孤儿子进程
`[读码]` §2 #30 / #32 / §1 #4。
三者复合出的场景是这样的：用户导入一个 2 小时的播客 → 转写跑了 40 分钟 → 想取消，**没有按钮能真的取消**
→ 关掉 daemon → whisper 子进程因为 `detached: true`（`runner.ts:170`）**活了下来继续吃 CPU**
→ 重启 daemon，`recoverOnStartup` 把 job 改回 queued → **从第 0 个 chunk 重新开始**
→ 而之前转好的段落因为旧稿被置 `is_active=0` 而**看不见了**。
**这是我在 D-01 §4.1 里专门设计 chunk 层要避免的那个失败模式，现在原样存在。**

### 5.3 搜索会静默返回 0 条
`[读码]` §1 #14 + `[实测]` §3。
FTS 外部内容表在指纹变化后重建 DDL 却**不回填**（缺 `'rebuild'`）。
而指纹变化正是 `libsimple` 加载失败时会发生的事 —— 我实测的这个实例**此刻就是这个状态**。
**用户症状**：搜索框能用、不报错、返回"没有找到匹配内容"。用户会认为自己没记过这条笔记。
**静默错误比崩溃更糟**，因为它不会被报告。

### 5.4 同 dataDir 换端口 = 两个 daemon 抢同一个数据库
`[读码]` §1 #1。`daemon.lock`+flock 完全没实现；dataDir 一致性检查**只在端口冲突分支**执行。
`--port 17651 --data-dir <同一目录>` 第一次 `tryBind` 就成功，probe 根本不会发生。
更糟的是 `recoverOnStartup` 会**无条件**把所有 running/leased 改回 queued（注释写"我们刚启动，绝不可能真在跑"）
→ **第二个实例启动的瞬间就把第一个实例正在跑的 job 抢回队列**，两份 whisper 同时写同一批 `transcript_segments`。
开发期很容易触发（我今天就起了第二个实例，只是恰好撞了端口才被拦下）。

### 5.5 一整类："前端就绪 + 服务端断链"，两边都以为对方会做
`[读码]` + `[实测]`：
- **M-4 段落编辑**：UI 完整、乐观更新完整 → 服务端**无 `UPDATE transcript_segments`**，`edited_at` 永远是 NULL
  → 连带 `gpu-runtime` 实测跑通过的两阶段合并"保留用户编辑"分支**永远走不到**
- **M-7 锚点**：`TimeAnchor` node 完整、`collectAnchors` 完整 → `note_anchors` **零写入**
- **B-3 LLM 设置**：整页 UI 完整 → `/api/settings/llm` **实测 404**
- **`/api/folders` 形状不一致** → 侧栏会白屏（我今天实测发现并修了）

**为什么这类最容易漏**：两边各自的交付报告都是真的（"UI 做完了" / "表建好了"），
**只有把两边放在一起看才能发现中间断了**。这正是这份文档存在的理由。
它也解释了为什么我们的功能矩阵会系统性偏乐观 —— 矩阵是从交付报告汇总的，而没有人报告"我和对面之间那一段没人做"。

---

## §6 做得确实扎实的地方（避免这份文档给出失衡的印象）

`[读码]` 逐条核实过、达到或超出设计的：

- **yt-dlp 七层参数注入防护**：URL 白名单/拒 `-` 开头/`--` 终止符/`--ignore-config`/固定 `--paths`/绝对路径/Windows 拒 `.bat`，**逐条对上**，还额外加了本地 `.m3u8/.pls` 拒绝
- **路径穿越与解压**：realpath + `path.relative` 断言、zip-slip 五重防护（绝对路径/`..`/双分隔符/符号链接/条目数与总大小上限）
- **文件名 ULID 化**：磁盘名与用户输入完全无关，原名只进 `display_name`
- **SSE**：单流 + 挤掉旧连接 + `Last-Event-ID` 重放 + 256 环形缓冲 + 15s keepalive + 250ms 节流且增量事件不节流
- **lane 信号量**：容量与 `gpu.exclusive` 互斥完全对齐设计（实测 `/api/health` 可见）
- **幻觉检测**：`detectRepetition()` 是真代码，专门处理无空格中文，**四个引擎全接了**，落库 + 索引 + 测试齐全
- **Anthropic provider**：真实现，正确处理 system 提顶层 / `max_tokens` 必填 / 具名流式事件
- **26 张表与 D-02 一一对应**，无多无少；双 ID、整数毫秒、软删除全部贯彻
- **`vec.ts` 的 BigInt 收口**：连整数元数据列都转，有回归测试断言绑 number 会炸（虽然目前无人调用）
- **媒体 Range**：206/416/304/`Accept-Ranges` 全有，只收 26 位 ULID
- **单实例三条件判定**：实测有效（§3）

---

## §7 建议的修复优先级（我的判断）

| 优先级 | 项 | 理由 |
|---|---|---|
| **P0** | 接线 `@openmemo/runtime`（§5.1） | 章程要求 2.1 的主体，一行 import 都没有 |
| **P0** | 补三条断链端点（§5.5）：`PATCH transcript_segments`、`note_anchors` 写入、`/api/settings/llm` | 三个已完成的 UI 因此全部悬空；`/api/settings/llm` 还卡着 F4 |
| **P0** | FTS `'rebuild'` 回填（§5.3） | 静默丢搜索结果，不会被报告 |
| **P1** | chunk 续跑接线（§5.2）：复用而非新建 transcript | 长任务的核心承诺 |
| **P1** | 把 scheduler 交给 router，让流水线 job 能取消（§5.2） | UI 上的取消按钮目前是假的 |
| **P1** | `peaks.ompk` 生成器 + `media/<noteUid>/` 归档 | F5 时间轴的主要视觉缺失；`rel_path` 存绝对路径是数据问题 |
| **P2** | flock 数据目录互斥（§5.4） | 开发期高频，产品期低频 |
| **P2** | `/api/health` 收敛为最小字段 + CSP 响应头 | 唯一无凭据可触达面 |
| **P2** | 优雅退出补广播与软停；孤儿回收 | 用户会遇到"CPU 跑满但界面什么都没在跑" |
| **P3** | Windows `LOCALAPPDATA` 订正；GPU 降级链文档订正；ffmpeg 适配层 | 单点、明确、低风险 |

---

## §8 诚实声明

- 本文的 `[读码]` 结论来自两个 subagent 的逐文件走查，**每条都带文件:行号**；`[实测]` 来自我本人对运行中 daemon 的探针与命令输出。
- **我没有验证的**：mac/Windows 行为（无机器）、真实浏览器交互（累计 12 项待补验）、
  以及所有标 `[推断]` 的条目（本文中我尽量避免使用该等级，最终只在"用户症状"的推演里出现）。
- **本文对我自己的实现同样不客气**：§1.3 的 6 条、§5.5 的 4 条都是我的账。
  `/api/folders` 那条是我今天实测才发现的 —— 我写客户端时端点还不存在，**我按设计猜了形状，猜错了**。
- 这份文档会过时。建议在 daemon 端点补齐后重跑一次同样的比对。
