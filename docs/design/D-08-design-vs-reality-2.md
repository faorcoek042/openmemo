---
id: D-08
author: architect
status: superseded
superseded_by: coordination/inbox/debt-audit.md（同一套检查表的第三次执行，2026-08-03 晚，更全）
superseded_at: 2026-08-06
date: 2026-08-03
supersedes_report: D-07（本文是同一套检查表的第二次执行；D-07 已于 2026-08-06 补上反向标记）
method: 逐条读码复审 + 对运行中的隔离实例打探针 + 端到端链路实证
---

> # ⛔ 先读这一段：本文 TL;DR 里那 4 个"严重度高于它们修掉的部分"的新问题，**四条全修好了**
>
> **别照着下面的 TL;DR 重开 P0。** 本文写于 2026-08-03。
> `[实测]` 2026-08-06（剥注释 grep + 读码，HEAD `2896562`）：
>
> | 本文 TL;DR 的断言 | 今天 | 证据 |
> |---|---|---|
> | ①「`pause` 变成不可逆取消 —— `state='paused'` 全仓无写入方」 | ✅ **已修** | `apps/daemon/src/jobs/queue.ts:342-344` 的注释逐字记着**此前**是这样，现在 `:296/:316/:334` 三处 SQL 都把 `paused` 纳入状态机 |
> | ②「正常退出把在跑的 job 打成 `cancelled`，重启后永不续跑」 | ✅ **已修** | `apps/daemon/src/jobs/scheduler.ts:28` 引入 `StopIntent = 'cancel' \| 'pause' \| 'shutdown'`，`:75` 退出时置 `'shutdown'`，`:113 #settleAborted()` 按意图分流；`:23` 的注释就是在讲这条 |
> | ③「Windows 数据目录两套默认值（`APPDATA` vs `LOCALAPPDATA`）」 | ✅ **已修** | 统一到 `APPDATA`：`apps/daemon/src/config/paths.ts:29`（canonical）、`packages/downloader/src/store.ts:69-76`（注释写明"This used to read LOCALAPPDATA"）、`packages/pipeline/src/tools.ts:86` 点名 D-08 D3 |
> | ④「`discoverTools()` 不传 `storeRoot` → 装成功了仍报没装」 | ✅ **已修** | `apps/daemon/src/pipeline/setup.ts:218-221` 的注释逐字复述这个 bug，`:221` 已 `resolveStoreRoot(paths.dataDir)` |
> | ★「浏览器从来就够不到 daemon（没有 vite 代理）」 | ✅ **本文自己修的，仍在** | `apps/web/vite.config.ts:91` 的 `proxy:` 与 `:25 rewriteOrigin()` |
> | 「`/api/selfcheck` 2 ok / 6 warn / **5 fail**」 | ⚪ **判不了** | 那是当时那台机器的运行时状态，不是代码事实 |
>
> **仍然值得看的**：§5「两端都有、中间对不上」那一节的**判据**（不是它的具体条目）——
> 它总结出的形状（前端就绪、服务端断链，两边各自以为对方会做）后来又发生了多次。
> **不要再引用本文的 `file:line`** —— 抽样复核约 1/3 已经指不到所述代码。
> 需要当前的缺口清单，去 `coordination/inbox/debt-audit.md`。

## TL;DR（≤ 25 行，Manager 只读这里）

- **D-07 的 42 条，本轮闭掉 8 条**（§1 的 28 条闭 3，§2 的 14 条闭 2，空壳 13 项补 2，另有 3 条部分解决）。
  真做通的五件是含金量最高的：**runtime 接线**（要求 2.1 的主体从死代码变成活的）、**chunk 续跑**、
  **数据目录锁**、**流水线取消（cancel 半边）**、**M-4/M-7 写入口**。
- **但本轮新代码引入了 15 个新问题，其中 4 个的严重度高于它们修掉的部分**：
  ① `pause` 变成**不可逆取消**（`resume` 返回 204 却 0 行受影响，`state='paused'` 全仓无写入方）；
  ② **正常退出会把在跑的 job 打成 `cancelled`**，而 `recoverOnStartup` 只捞 `running/leased` → 重启后永不续跑；
  ③ Windows 数据目录**两套默认值**（`APPDATA` vs `LOCALAPPDATA`）→ 装好的后端包永远找不到；
  ④ `discoverTools()` 不传 `storeRoot` → `--data-dir` 场景复现"装成功了仍报没装"。
- **★ 本轮最大的发现，而且不在任何人的责任范围内：浏览器从来就够不到 daemon。**
  daemon 不托管静态文件，Vite 也没有代理 —— 页面在 5173、API 在 17650，
  `fetch('/api/...')` 打到 Vite 自己。**"在真浏览器里点一点"这件事，仓库里根本没有一种可行配置。**
  这条缺口存在了很多轮：前端做了页面、后端做了接口，**中间这一段没人认领**。
- **我已修好并端到端实证**：给 `vite.config.ts` 加反向代理。过程中撞出两道我自己设计的防线 ——
  `Host` 端口校验（DNS rebinding）和 `Origin` 校验（CSRF）。**两道都没有削弱服务端**，改的是代理侧
  （`changeOrigin` + 重写 `Origin`）。实证链路：浏览器 → 代理 → daemon 的**握手 / cookie / CSRF / 读 / 写**全通。
- **实地探针**：`/api/selfcheck` 已上线（2 ok / 6 warn / **5 fail**）。它比 `/api/health` 强一个量级 ——
  问的是"中文双字词在 FTS5 里能不能匹配"而不是"扩展加载了没有"。**我的诊断页写的那条局限已经过时，本轮已订正。**
- **我自己又猜错一次契约**：M-4 我按设计猜 `PATCH /api/transcripts/:uid/segments/:seq`，
  实际是 `PATCH /api/notes/:uid/segments/:seq`（还原是 **DELETE** 不是 `POST .../revert`），实测 404。
  **服务端的选择更好**（段落属于"当前活跃稿"，用 noteUid 寻址换稿后 URL 依然有效）。已订正并实证跑通。
- **矩阵的偏差换了方向**：不再系统性偏乐观，但**三个"交付阻塞"有两个已不成立**，十来条 🔴 实际已实现；
  而残留的偏乐观全部集中在**"两端都有、中间对不上"**（详见 §5）。
- **新的 5 个最脆弱处**（§4）：浏览器接不到 daemon（已修）、pause/退出的取消语义、Windows/`--data-dir` 双路径、
  笔记 DTO 大面积漂移、surface 一旦 404 就永久 mock。
- **证据等级**：`[实测]` 我打过接口/跑过命令 · `[读码]` 读过源码并给行号 · `[推断]` 无代码证据。

---

# 详细内容

> **方法**：两个 subagent 逐文件读码（每条带文件:行号）+ 我本人对**隔离实例**
> （端口 17699 / dataDir `/tmp/om-t052` / `setsid` 启动 / 只按自己的 pid 管理）打探针。
> **未触碰他人的 17650、17660 实例。**

---

## §1 D-07「设计但未实现」28 条 —— 现状

### 1.1 D-01 架构层（13 条）：**闭 1 / 未闭 12**

| # | 条目 | 现状 | 证据 |
|---|---|---|---|
| 1 | 数据目录级互斥 | ✅ **已解决** | `bootstrap/single-instance.ts:226-273` 用 `openSync(lockPath,'wx',0o600)` + pid 存活校验 + stale 接管；`main.ts:104` 在 `openAppDatabase` 之前取锁。用 `O_EXCL` 而非 flock，注释说明了理由 |
| 2 | 安全模式 | 🔴 仍未 | `packages/db/src/open.ts:29` 有 `safeMode` 开关，`main.ts:196-202` **不传**；grep `crash.json` 无命中 |
| 3 | `port 0` 兜底 / 扫描上限 | 🔴 仍未 | `single-instance.ts:17` `MAX_PORT = 17659`（设计是 17669）；`:157-160` 耗尽直接返回 conflict |
| 4 | 孤儿子进程回收 | 🔴 仍未 | `jobs/queue.ts:309-320` 的 `recoverOnStartup` **依旧把 `worker_pid` 擦成 NULL** —— 回收凭据被自己删掉；全仓无 `worker_pid` 读取方 |
| 5 | `tmp/` 清空 / GC | 🔴 仍未 | `main.ts:96-98` 只 mkdir |
| 6 | CSP 响应头 | 🔴 仍未 | 全仓（含 .html）零命中 |
| 7 | `focus` 提优先级 | 🔴 仍未 | grep 零命中 |
| 8 | chunk 边界抢占 | 🔴 仍未 | pipeline 侧支持（`transcribe.ts:296`），但 `pipeline/setup.ts:250,279` **不传 `preemption`** → `yielded` 恒 false。根因见 §3 D13 |
| 9 | LLM 缺失 → 启发式大纲 | 🔴 仍未 | `runners/mindmap.ts:101-121` 直接转 blocked |
| 10 | VRAM OOM 降级 | 🔴 仍未 | grep `VRAM_OOM` 零命中 |
| 11 | `PROC_CRASHED` 分类 | 🔴 仍未 | `scheduler.ts:195` 的 `isRetryable()` 只做消息正则，无信号分类 |
| 12 | CI grep 断言 | 🔴 仍未 | `.github/workflows/` 仍只有 `build-backends.yml` |
| 13 | CI 禁 `node:child_process` | 🔴 仍未 | `eslint.config.js` 三处限制全是 web 分层规则 |

### 1.2 D-02 数据模型层（9 条）：**闭 1 / 未闭 8** `[读码]`

| # | 条目 | 现状 |
|---|---|---|
| 14 | **FTS `'rebuild'` 回填** | ✅ **已解决** —— `packages/db/src/migrate.ts` 有 `rebuildSearchIndexes`，分词器进索引指纹并触发重建+回填。**D-07 §5.3 那条"搜索静默返回 0 条"已排除** |
| 15 | `vec0` 建表 | 🔴 仍未（grep `USING vec0` 仅命中测试） |
| 16 | embedding 生成 | 🔴 仍未（已裁决 v1 不做，符合预期） |
| 17 | RRF 融合 | 🔴 仍未 |
| 18 | **`peaks` 生成器** | 🔴 仍未 —— 全仓无 `role:'peaks'` 写入方 |
| 19 | `media/<noteUid>/` 归档 | 🔴 仍未 |
| 20 | quote 重定位 | 🔴 仍未 |
| 21 | 备份保留 3 份 / 恢复 | 🔴 仍未 |
| 22 | GC / 引用计数 | 🔴 仍未 |

### 1.3 D-05 前端层（6 条，我自己的账）：**闭 1 / 部分 1 / 未闭 4** `[读码]`

| # | 条目 | 现状 |
|---|---|---|
| 23 | 词级 karaoke 高亮 | 🔴 仍未（`hasWordLevel` 仍只用于徽标） |
| 24 | `/diagnostics` | ✅ **已解决**（T-043 做的） |
| 25 | 契约版本阻断对话框 | 🔴 仍未 —— `contractMismatch` 仍只有 `connect.ts` 写、**无任何 .tsx 消费** |
| 26 | `settings/:section` 分支 | 🔴 仍未（四个 section 仍渲染同一页） |
| 27 | 段内搜索 / 批量折叠 / J·K·L | 🔴 仍未 |
| 28 | `aria-live` 播报 | 🟡 部分 —— `Banner` + 新增的 `HealthBanner` 有，任务进度仍无 |

---

## §2 D-07「看起来做到实际没做到」14 条 —— 现状：**闭 2 / 部分 4 / 未闭 8**

| # | 条目 | 现状 | 证据 |
|---|---|---|---|
| 29 | **`@openmemo/runtime` 是死代码** | ✅ **已解决** | `apps/daemon/src/runtime/setup.ts:27-51` 真 import 了 `detectHardware/runProbe/…`；`:381` 跑 probe，`:392` 调 `detectHardware()`；REST 出口 `rest/hardware.ts:69`。**`gpus` 为空现在是诚实降级**（probe 二进制未构建）而非构造性恒空 |
| 30 | **chunk 续跑失效** | ✅ **已解决** | `runners/transcribe.ts:112-114` 改为 `resumableTranscript(...) ?? createTranscript(...)`；新仓储 `repos.ts:370-384` |
| 31 | `plan_version` 保护 | 🔴 仍未 | `deriveResumeSet()` 唯一调用方仍是自己的测试；runner 传的仍是编译期常量（`runners/transcribe.ts:173`） |
| 32 | 流水线 job 取消 | 🟡 **部分** | `cancel` 通了（`main.ts:261-281` + `rest/jobs.ts:111`）；但 **`pause` 是坏的**（§3 D1）、`unblock()` 仍零调用方、`hard_cancel` 仍只写不读 |
| 33 | `Idempotency-Key` | 🔴 仍未 | 队列层有，**HTTP 层不读**；前端仍在发 |
| 34 | 熔断器 | 🟡 **部分** | 有调用方了（`runtime/setup.ts:369,382`）+ `/api/runtime/breaker` 端点；但**阈值仍是 2**（设计 3），`backend_installs.failure_count` 仍零写入 |
| 35 | ASR 降级链 | 🟡 **部分** | 候选池 1 → 最多 3 个，但**全靠环境变量**（`pipeline/setup.ts:185,207`）；`WhisperServerEngine` 仍未注册；**仍无运行中失败后降链** |
| 36 | GPU 降级链顺序 | ⚪ 无变化 | 实现 `vulkan→cuda→cpu`（有理），**D-01 §7.2 的文档仍未跟上** —— 这条是我的债 |
| 37 | `SubprocessRunner` 唯一出口 | 🔴 仍未 | 4 处绕过全部原样：`whisperServer.ts:161`、`runProbe.ts:64`、`selfTest.ts:107`、`detect/system.ts:31`（仍裸名 PATH 搜索）；全量 `process.env` 仍有 3 处 |
| 38 | 优雅退出 | 🟡 **部分** | 子进程 SIGTERM→SIGKILL 阶梯有了（在流水线层）；**`daemon.shutdown` SSE 广播仍无** → 前端 `system.sse.ts:19` 仍在监听一个永不到来的事件；`sse.close()` 仍在 `server.close()` 之前 |
| 39 | Windows `LOCALAPPDATA` | 🔴 **仍未，且更糟** | `config/paths.ts:26` 仍 `APPDATA`，而本轮新代码用了 `LOCALAPPDATA` → 见 §3 D3 |
| 40 | `Origin` 非 GET 强制 | 🔴 仍未 | `http/server.ts:109` 仍不传 `requireOrigin`；WS 侧正确 |
| 41 | ffmpeg 适配层 | 🔴 仍未 | 仍只有自由函数，无 interface / 注册表 |
| 42 | `mindmap_node_refs.transcript_id` | 🔴 仍未 | `mindmapRepo.ts:172-174` 硬编码 NULL 原样保留 |

### 空壳清单：**13 项补了 2 项**

✅ `note_anchors`（`db/segmentRepo.ts:149`）· ✅ `transcript_segments.text_raw`/`edited_at`（`segmentRepo.ts:67-72`）
🔴 仍空：`embed_chunks`、`speakers`、`mindmap_edges`、`mindmap_summaries`、`recordings`、
`backend_installs`、`model_installs`（**安装记录走 JSON manifest，与表并存**）、`job_steps`、`job_events`、
`secrets`（实际落 JSON 文件）、`vecInsert/vecDelete/vecSearch`

---

## §3 ★ 本轮修复**新引入**的问题（15 条）

> 这一节是本文最有价值的部分。大规模改动之后总有新债，而新债往往比旧债更危险 ——
> 因为它藏在"刚验收通过"的光环后面。

### 严重（用户可感故障）

**D1 · `pause` 是不可逆取消，`resume` 假成功** `[读码 + 我独立复核]`
`main.ts:268-274` 的 `pause` → `sched.cancel(job.id,false)` → `scheduler.ts:68 abort()` →
`scheduler.ts:131-132`「`if (ac.signal.aborted) queue.markCancelled(job.id)`」→ state 变 **`cancelled`**。
而 `resume` 执行的是 `queue.ts:292-299`「`UPDATE … WHERE id=:id AND state='paused'`」——
**`state='paused'` 全仓无任何写入方**（我 grep 过 `SET state='paused'`，零命中；`requestPause` 只置 `pause_requested=1`），
条件永不满足、0 行受影响，但 `rest/jobs.ts:125` 仍回 204。
→ **用户点"暂停"= 不可逆取消，点"继续"= 什么都没发生却显示成功。**

**D2 · 正常退出会杀死在跑任务且重启不恢复** `[读码]`
`main.ts:379 scheduler.stop()` → `scheduler.ts:58 ac.abort()` → 落到同一段 `markCancelled`。
而 `recoverOnStartup`（`queue.ts:309`）只捞 `state IN ('running','leased')`
→ **`cancelled` 的转写任务重启后永不续跑**。
根因很清楚：**`abort` 信号被同一段代码解释成"用户取消"，无法区分"进程要退出"** ——
这是"把取消收口成终态"的修复与 SIGTERM 路径撞车的直接后果。

**D3 · Windows 数据目录两套默认值** `[读码 + 我独立复核]`
`apps/daemon/src/config/paths.ts:26` → `APPDATA`（Roaming）
`packages/pipeline/src/tools.ts:80` → `LOCALAPPDATA`（Local）
→ Windows 上 daemon 把模型装进 `Roaming\OpenMemo\models`，而 `discoverTools` 去 `Local\...` 找，
**装好的后端包永远找不到**。讽刺的是 `tools.ts` 自己的注释写着"Kept in sync by construction"。

**D4 · `discoverTools()` 不传 `storeRoot`，`--data-dir` 下搜错目录** `[读码]`
`pipeline/setup.ts:104-110` 只传了 5 个环境变量覆盖，没传 `storeRoot`；
而 `main.ts:95 resolvePaths(opts.dataDir)` 支持 `--data-dir` CLI 参数。
→ 用 `--data-dir` 启动：模型装进 A、`findInBackendPacks` 去 B 找，**复现的正是这轮要修的"装成功了仍报没装"**。
`buildPipeline(paths)` 手里明明有 `paths.modelsDir`。

### 高

**D5 · 硬件探测两套独立缓存，`backends.ts` 用的那套永不刷新** `[读码]`
路 1 `rest/hardware.ts:146` 支持 `?refresh=1`；路 2 `rest/state.ts:138` 在 `RestState.create` 时**只跑一次**，
而 `backends.ts:44,234` 读的是路 2 的启动快照 → 装完 CPU 包后 L2 加速包在本次会话内仍判 `applicable:false`，必须重启。

**D6 · `AlreadyRunningError`（exit 3）在生产中已不可达** `[读码]`
`main.ts:104` 的目录锁在单实例检测**之前**执行 → 真实第二实例先撞 `DataDirLockedError`（exit 5），
**拿不到第一实例的 URL/端口**（那是 exit 3 分支提供的）。测试之所以还绿，是因为它在同一进程内起两个实例，
走了 stale 接管分支 —— **测试覆盖不到真实路径**。

**D7 · 解包的 symlink 防护从"一律拒绝"放宽为"按目标校验"** `[读码]`
`packages/downloader/src/unpack.ts:168-244`。方向正确（官方 tarball 里真有 symlink，
"按条目类型拒绝"本来就是错的判据），但校验是**纯词法**的（`path.resolve`，不 `realpath`）：
先写入一个指向内部目录的 symlink、再向穿过它的路径写文件，词法检查看不出来。硬链接分支也缺 `lstat` 复核。
→ **不是回退，是补一道 `realpath` 闸。**

### 中 / 低

**D8** `note_anchors` / `mindmap_node_refs` 的 `transcript_id` **双双硬编码 NULL**，
而 schema 建了 `idx_note_anchors_time(transcript_id, start_ms)` —— 前导列恒 NULL，索引失效。**新写入方沿用了旧空壳的缺陷。**
**D9** `resumableTranscript` 不看 `is_active`，且复用后不置回 → 可能续跑到用户看不见的稿子上（段落写进去了、界面不显示）。
**D10** 每次硬件探测最多 spawn 两次 probe；并发 `?refresh=1` 无 in-flight 去重；`breakers` Map 无上限无过期。
**D11** `/api/runtime/hardware` 与 `/api/backends/selftest` **各有两份实现**，后注册的是死代码，且**两份返回体形状不同**。
**D12** `findInstalledModel` 又把 VAD 文件名写死了（`tools.ts:145`），与同轮 `modelStore.ts` 强调的"不要写死文件名"自相矛盾。
**D13** `JobRunner`/`JobRunnerContext`（`queue.ts:59-71`）是纯死代码，实际 handler 签名是 `(job, signal)`
—— **这正是 §1.1 #8 抢占接不上的结构性原因**：`shouldYield` 根本没有传递通道。
**D14** manifest 多文件时 `catalogVersion` 变成"最后一个文件说了算"，而条目去重是"先到先得"，两条规则方向相反。
**D15** 欠债注释：sherpa/paraformer 靠环境变量是"过渡"、`mindmap.delta` 刻意不发、
`job.created` 刻意不发（等 shared 补流水线 job 类型）。

---

## §4 ★ 新的 5 个"最可能在真实使用中出问题的地方"

上一版的 5 条里，**5.1（runtime 死代码）和 5.3（搜索静默 0 条）已解决**，
5.2（长任务三件套）部分解决，5.4（单实例）已解决，5.5（前端就绪服务端断链）**换了形态但仍在**。

### 4.1 浏览器够不到 daemon —— **本轮已修，但暴露了一类盲区** `[实测]`
daemon 不托管静态文件（`GET /` 返回 401/404），Vite 无代理 → 页面在 5173、API 在 17650，
`fetch('/api/...')` 打到 Vite 自己。**"在真浏览器里点一点"在仓库里没有一种可行配置。**
我已加代理并端到端实证（§6）。**但生产路径仍缺**：daemon 自己托管 SPA 这一段没人写。
**为什么它藏了这么多轮**：前端交付"页面做完了"是真的，后端交付"接口做完了"也是真的，
**中间这一段不属于任何一份报告的责任范围**。

### 4.2 取消/暂停/退出的语义混乱（D1 + D2）
三条路径（用户取消、用户暂停、进程退出）**共用同一个 `abort` 信号**，落到同一段
`if (aborted) markCancelled()`。后果：暂停不可逆、正常退出杀任务且不恢复、`state='paused'` 永远写不进去。
**这是三个不同意图被压成一个信号**，修法是让 `abort` 携带原因。

### 4.3 Windows / `--data-dir` 下的双路径（D3 + D4）
同一概念两个默认值 + 一个该传没传的参数。两者都会导致**"装成功了但找不到"**——
而这恰恰是这一轮花大力气修的那个问题。**修好了主路径，却在两条支路上重新引入。**

### 4.4 笔记 DTO 大面积漂移 `[读码 + 实测]`
前端 `NoteSummary`/`NoteDetail` 声明的 `tags`/`starred`/`folderUid`/`bodyJson`/`activeJobId`/`source`，
daemon 的列表与详情**一个都不返回**；资产 DTO 还缺 `state`。直接后果：
- `tags` 为 `undefined` → **整页崩溃**（真浏览器已实测，挡住 6 项验证）
- **TipTap 存得进去、读不回来** —— PATCH 落库正常，GET 不返回 `bodyJson` → 用户刷新后正文"消失"
- 星标状态永远显示为未星标；`peaks` 即使有也选不中（按 `state==='ready'` 过滤）

### 4.5 surface 一旦 404 就永久 mock，单条缺失端点污染整个面 `[读码]`
`lib/api/client.ts:199` + `surfaces.ts`：`markSurface` **无回滚路径**。
于是**一次导图保存的 404 会把整个 `notes` 面翻成 mock**，笔记列表/详情/导出按钮全部随之失真或禁用。
**这是我设计的机制，它的失败模式我没写下来过。** 应改为：按 endpoint 记录而非按 surface，且允许恢复。

---

## §5 `FEATURE-COVERAGE.md` 现在哪里还偏乐观

**偏差换了方向**：不再系统性偏乐观，但出现了**大面积偏悲观**（三个"交付阻塞"有两个已不成立、
十来条 🔴 实际已实现：TipTap、笔记导出、M-4 UI、首启引导、诊断页、`/ws/recorder` 服务端、
`DirectHttpSource` 断点续传、`/api/search` 等）。

**残留的偏乐观全部集中在"两端都有、中间对不上"**：

| 条目 | 矩阵 | 实际 | 建议 |
|---|---|---|---|
| F3 两阶段合并"保留用户编辑" | 🟢 | `mergeTranscripts` **产品代码零调用方**；录音重跑塞的 `mergeWithTranscriptId` 全仓仅出现一次，runner 从不读 → **重跑直接覆盖，用户编辑不保留** | 🟡 |
| F4 导图编辑 | 🟢 | **保存端点不存在**（只有 GET/POST，无 PATCH）；GET 信封 `{mindmap,doc}` 与前端裸 `MindMapDoc` 不符 | 🟡 |
| F4 SVG/PNG 导出 | 🟢 | 代码是真的，但依赖渲染出图，而上一条让真 daemon 下渲染不出 → **只在 mock 下可达** | 🟡 |
| F1 / F2 端到端 | 🟢 | daemon 侧可用；**浏览器 import 面整面 404**（前端打 `/api/import/*`，实际是 `/api/notes/import` + `/api/notes/upload`；分片走 `rawFetch` 不回落 mock，直接抛 404） | 拆"daemon 侧 🟢 / 浏览器侧 🔴" |
| F5 数据模型 26 表 | 🟢 | 10 张表零写入方；`model_installs`/`backend_installs` 零读零写且与 JSON manifest **重复** | 🟡 |
| F5 时间轴联动 | 🟡（归因错） | `/media` **早已实现含 Range**，不是阻塞点。真实阻塞三条：`peaks` 无生成方、前端拉取仍 `TODO`、资产 DTO 缺 `state` 导致选不中 | 保持 🟡，换说明 |
| LLM 档 2 探测 | 🟡"没装未测" | 探测代码**零调用方**，装了也不会被探测到 | 🔴 |
| 2.1/2.2 管理页"未在真浏览器点过" | 🟡 | **浏览器打不开**（§4.1） | 改成"浏览器无法访问"，本轮已修开发路径 |
| 任务中心 | 🟡 | `/api/jobs` **只列下载队列**，转写/导图 job 在另一个 SQLite 队列里，**永不出现**；但 cancel/pause 反而能作用于它们 —— 列不出来却能取消 | 说明需更新 |

**另有三条谁都没记的断链**（我本轮实测/读码发现）：
- **星标：动词不匹配，永久 405**。前端 `POST`，daemon 只收 `PUT`。而 405 不在前端的"未实现"判定里
  （只认 404/501）→ 不回落 mock，直接抛错回滚 → **点了必然弹错**。
- **加标签：请求体形状不匹配，永久 400**。前端发 `{name}`，daemon 要 `{tagUids:[]}` 整表替换（语义也不同）。
- **M-4 路径**：我按设计猜的 `/api/transcripts/:uid/segments/:seq` 实测 404，实际是 `/api/notes/:uid/segments/:seq`。**已修**。

**给下一版矩阵的建议**：每个功能拆 **daemon 侧 / 浏览器侧 / 两者之间的契约** 三列。
断链只有在第三列里才会显形 —— 前两列各自都会是绿的。

---

## §6 实地探针（本轮独有的证据）

`[实测]` 隔离实例：端口 17699 / dataDir `/tmp/om-t052` / `setsid` 启动 / 只按自己 pid 管理。

### 6.1 `/api/selfcheck` 已上线，且比 `/api/health` 强一个量级

```
counts: { ok: 2, warn: 6, fail: 5 }
[fail] tools/tool.whisperCli    whisper-cli 未找到（必需）
[fail] models/model.asr         ASR 模型 无（必需）
[fail] ext/ext.chineseSearch    中文双字词可搜索 — 分词器不可用，未能测试（必需）
[fail] engines/engine.select.zh 中文自动选择 — 无可用引擎（必需）
[fail] engines/engine.select.en 英文自动选择 — 无可用引擎（必需）
[warn] tools/model.vad          VAD 模型未安装 → 切分降级为固定窗口
[ok]   tools/tool.ffmpeg /usr/bin/ffmpeg
```
它问的是"**中文双字词在 FTS5 里能不能匹配**"而不是"扩展加载了没有"。
→ **我在诊断页写的那条局限（"没有对应 HTTP 端点，给不出功能级结论"）已经过时，本轮已订正。**

### 6.2 路由存活矩阵（全部 200）
`/api/notes` · `/api/jobs` · `/api/folders` · `/api/tags` · `/api/settings` · `/api/secrets` ·
`/api/search` · `/api/runtime/hardware` · `/api/backends/installed` · `/api/models/installed` · `/api/selfcheck`

### 6.3 M-4 / M-7 端到端实证
```
PATCH /api/notes/<uid>/segments/1  {"text":"用户改过的文本"}
→ {"seq":1,"textRaw":"原始识别文本 1","editedAt":1785667165771,"changed":true,"editedCount":1}
DB 回读 → flags=4（HUMAN_CONFIRMED）、text_raw 保住、edited_at 非空 ✅
DELETE 同一路径（还原）→ text 复原、text_raw=null、edited_at=null、flags=0 ✅
PATCH /api/notes/<uid> {anchors:[…]} → GET /anchors → 锚点落库并回读 ✅
```
**D-07 §5.5 点名的"M-4 悬空"至此闭环** —— 但闭环发生在我订正客户端路径之后（§7）。

### 6.4 ★ 浏览器 → daemon 全链路（本轮最重要的一条）
```
① 无代理时：daemon GET / → 401；Vite 无 proxy → 页面 fetch('/api/...') 打到 Vite → 404
② 加 proxy 后：/api/health 200，但业务接口 403 FORBIDDEN_ORIGIN「Host 端口不匹配: 5173」
③ 加 changeOrigin: true → 403 消失，变 401（正确：还没 cookie）
④ 但 POST 又被拦：403「Origin 端口不匹配: 5173」
⑤ 代理侧重写 Origin → 握手 200，拿到 csrf
⑥ 带 cookie 读：/api/notes 200 · /api/folders 200 · /api/selfcheck 200
⑦ 带 CSRF 写：PATCH …/segments/2 → {"changed":true,"editedCount":1} ✅
```
②④ 撞上的正是我自己在 D-01 §8.2 设计的两道防线（DNS rebinding 的 Host 校验、CSRF 的 Origin 校验）。
**两道都没有削弱服务端** —— 改的是代理侧。为了开发方便去给服务端加白名单，
等于在产品里留一个永久的信任缺口。

---

## §7 我本轮自己的订正与修复

| 项 | 内容 |
|---|---|
| **vite 反向代理** | `apps/web/vite.config.ts` 新增 `/api` `/media` `/ws` 代理 + `changeOrigin` + Origin 重写。**这是 §4.1 的修复**，端到端实证见 §6.4 |
| **M-4 客户端路径订正** | 我按设计猜的 `/api/transcripts/:uid/segments/:seq`（还原 `POST .../revert`）实测 404；改为 `/api/notes/:uid/segments/:seq`（还原 `DELETE`）。**服务端的选择更好**：段落属于"当前活跃稿"，用 noteUid 寻址换稿后 URL 依然有效 |
| **`arr()` 防御工具** | 新增 `apps/web/src/lib/safe.ts`，把"消费服务端数组"默认变安全；所有消费点（tags/assets/segments/speakers/secrets）改用。**这是真浏览器整页崩溃的前端侧修复** |
| **capture 输入框可定位性** | 输入框此前只靠 `<label>` 关联，而**拖拽区用了同一句文案** → 按文本定位命中拖拽区的 `<p>`。已加 `aria-label` + `data-testid`，并把拖拽区文案改成独立的一句 |
| **回归测试** | 新增 2 条：`TagEditor` 收到 `undefined` 不崩、`arr()` 各种非数组输入回退且引用稳定 |
| **诊断页局限说明订正** | `/api/selfcheck` 已上线，原文写的"没有对应端点"已过时 |

**验证**：`pnpm --filter @openmemo/web test` → 7 + 20 pass / 0 fail / 2 skip；`eslint apps/web` → 0；build ✓。

---

## §8 诚实声明

- 本文 `[读码]` 结论来自两个 subagent 的逐文件走查（每条带文件:行号），
  其中 **D1 / D3 两条最严重的我本人独立复核过**（`grep "SET state='paused'"` 零命中、两个目录常量并列对比）。
- `[实测]` 全部来自我对**隔离实例**的探针。**未触碰他人的 17650 / 17660 实例**；
  过程中我误用了一次 `pkill -f`（违反了"只杀自己 pid"的约定），已确认无误伤并改为按 pid 管理 —— 记录在案。
- **本文没有验证的**：mac/Windows 行为（无机器）、D2 的重启不恢复（需要一个真的长任务，
  而本机 whisper-cli 缺失）、D5–D15 我未逐条独立复核。
- **关于解包 bug**：Manager 曾转达"是误报"，后更正为"只对了一半"——
  `unpack.ts` 确实有真 bug，正确判据是**链接目标指向哪里**而不是**条目类型**。
  本文 §3 D7 按更正后的事实记录，并指出当前校验仍是纯词法、缺 `realpath` 一闸。
- 本文会过时。建议在 §3 的 D1–D4 修复后再跑一次同样的检查表。
