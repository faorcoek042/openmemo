# job-events —— 回执

## [2026-08-03 21:15] T-130 DONE — 没装 ASR 模型时导入媒体，页面零反馈

## TL;DR (≤25 lines)

1. **`ui-polish` 的描述基本准确，但有一处关键出入**：它说"transcribe/mindmap 两类 job 刻意不发 `job.created`" ——
   `/api/notes/import`、`/api/notes/:uid/mindmap`、`/api/notes/:uid/retranscribe`、录音重跑 **确实不发**；
   但 **F2 拖拽上传（`/api/notes/upload`）发了一条，而且是坏的**：`as never` 塞进去的 `{jobUid,kind,label}`，
   前端读 `ev.job.jobId` → `[实测]` **每次上传都抛一次 `TypeError`**，被 bus 的 try/catch 吞掉。发错比不发更糟。
2. **"刻意不发"的原意图正当，不能当疏漏删掉**：`JobCreatedEvent.job` 要求完整 `DownloadJob`（totalBytes/parts/fileIndex…），
   转写 job 填不进去，**拒绝伪造是对的**。错的是后半句结论（"前端从 202 拿 jobUid 就够了"）——
   那个 jobUid 只活在发起请求的调用点上，全局 toast 层/任务中心**没参与那次请求**，收到的是一串没被介绍过的 id。
   → 修法不是"那就发吧"，是给流水线 job 一个**诚实的形状**：shared 新增 `PipelineJob`（无字节计数），`JobCreatedEvent.job` 变 `AnyJob` 联合。
3. **`upsert` 不补建是同一问题的另一半，但"一律丢弃"才是错的**：刷新页面重放的 `job.state` 不该造 toast（对），
   但 `blocked` / 终态 `failed` 丢掉 = 一次零报错的卡住（错）。现在按"是否需要用户动手"分流，兜底层保留为**冗余**。
4. **同链路走不到前端的状态一共 6 处，不止 blocked**（扫法与清单见 §2）：
   `blocked`、终态 `failed`、`succeeded`（调度器只发 `job.done` 不发 `job.state(succeeded)` → 转写跑完提示永远停在"转写中"）、
   退避重试（`willRetry` 分支对流水线**永不触发**）、自动解除阻塞（`unblock()` 静默改状态）、
   以及 **REST 侧**：`GET /api/jobs` 只返回下载队列 → `[实测]` 库里 5 条 blocked，接口返回 `jobs: []`，
   而 blocked 提示的第二个按钮正是「任务中心」。全部已修。
5. **复现前后**（真浏览器 + 真 daemon + 空数据目录，§3 贴了逐帧文本与截图）：
   修前 `toaster=0`、页面新增文本 0 条关于原因的字；修后 `t=+400ms` 出现「暂时无法继续 · **sample-tone.wav**」
   —— 标题是**真实笔记标题**（来自新的 `job.created`），不是兜底名字，这就是"根因已修、兜底变冗余"的判据。
6. **反向验证 4 次全部变红**（§4 贴真实输出）：撤 daemon 钩子 / 撤 `/api/jobs` 合并 / 撤前端根因分支 / 撤兜底层。
7. `tsc -b` 全仓 0 错 · eslint 我的范围 0 · db 47/47 · web 单测 36/36（新增 9）· web 组件 144/145 · daemon 169/171（新增 2）。
   **两处失败与最后冒出的 1 条 eslint warning 都不是我的**（§6 有归属证据与复核命令）。
8. **⚠️ 另一个更致命的发现（不在我职责内，请 Manager 裁决）**：鉴权关闭时 `POST /api/auth/session` 仍 401，
   而 `providers.tsx` **只在 `authed===true` 时才 `startSse()`** → **不带 `#t=` 打开页面 = 全站没有任何 SSE**。
   `:10000` 演示实例 `OPENMEMO_AUTH` 未设（我读了 `/proc/<pid>/environ`），**用户从 NAT 打开的那个地址正是这种情况**。
   我这次的修复在那种会话里**一个字都看不到**。详见 §5。

---

## §1 我独立复核的三件事（逐条回答任务里的问题）

### 1.1 transcribe/mindmap 为什么"刻意不发 `job.created`"？有正当理由吗？

**有，而且理由成立。** 原注释在 `apps/daemon/src/jobs/events.ts` 头部（改前）与两个 REST 入口：

> `JobCreatedEvent` 要求一个完整的 `DownloadJob`（`kind:'model'|'backend-pack'`、`totalBytes`、`parts`、`fileIndex`…），
> 那是为**下载**建模的，转写/导图这类流水线 job **无法诚实地填进这个形状**。

我核对了 `packages/shared/src/jobs.ts` 的 `DownloadJob`：15 个字段里有 8 个对转写毫无意义
（`targetId` 是目录 slug、`parts[]` 是分片续传、`fileIndex/fileCount`、`provider`、`speedBps`、`completedBytes`…）。
**填 0 会在界面上渲染成 `0 B / 0 B` 的下载条 —— 一个看起来卡死的下载。** 所以"不伪造"是对的。

**但结论的后半句是错的**："前端从 POST 的 202 响应拿到 jobUid，后续状态由 job.state/job.progress 提供"。
202 里的 jobUid 只交给了**发起那次请求的那个组件**（`CapturePage` 拿到后直接 `navigate` 走了）。
`job.state`/`job.blocked` 只带 id 不带身份，而消费方（右下角全局 toast 层、任务中心）**没参与那次请求**。
于是流水线 job 的每一个状态在界面上都不存在。

→ **修法保住了原意图**：不伪造 `DownloadJob`，而是给流水线 job 一个只含它真有的字段的表示。

### 1.2 `upsert` 不补建是不是另一半？没见过的 jobId 该怎么办？

是另一半，而且它的理由**也**成立：SSE 重连会重放（`SSE_REPLAY_BUFFER_SIZE=256`），
刷新页面时不该凭空冒出一堆早就结束的任务的 toast。

**我的答案：按"这条事件是否需要用户动手"分流，而不是"是否见过这个 id"。**

| 事件                                | 没见过这个 id 时 | 理由                                                       |
| ----------------------------------- | ---------------- | ---------------------------------------------------------- |
| `job.state` → running/queued/paused | **丢弃**（不变） | 既没有名字也不需要用户做什么，补建出来是一条没有主语的提示 |
| `job.blocked`                       | **补建**         | 自带"为什么停 + 怎么办"，缺的只是名字；丢掉 = 零报错的卡住 |
| `job.failed` 且 `willRetry=false`   | **补建**         | 失败是用户必须知道的事                                     |
| `job.failed` 且 `willRetry=true`    | 丢弃             | 重试成功了他根本不用知道（D-05 §2.3）                      |

实现上把"补建用的最小信息"变成一个显式的 `seed` 参数：传了才补建，**且 `seed` 只在补建时生效、不覆盖已有条目**
（否则 `job.created` 带来的真实笔记标题会被 `job.blocked` 的兜底名字盖掉，修完反而比修前更差 —— 有测试钉住）。

### 1.3 除了 `blocked`，还有哪些状态走不到前端？（怎么扫的 + 清单）

**扫法**（三遍，不是只看被报的那条）：

1. **发送侧穷举**：`grep -rn "sse.publish|makeEvent" apps/daemon/src` 逐个看，
   把流水线 job 在 `queue.ts` 里能到达的**每一个状态写入点**（`succeed/fail/block/unblock/markPaused/markCancelled/markInterrupted/requeue`）
   与"这里发了什么事件"对照，列出空缺。
2. **接收侧穷举**：`JobToaster` + `features/tasks/sse.ts` + `features/tasks/api.ts` 的每个 `bus.on` 与 REST 数据源，
   反过来问"这条事件到达后能不能变成用户看得见的东西"。
3. **两套队列对照**：下载队列（`rest/state.ts` 的 bridge）与流水线队列（`scheduler.ts`）**发的事件集合不一样** ——
   凡是一边发另一边不发的，都是嫌疑点。这一步找出了 `succeeded` 那条。

**结果（6 处，全部已修）**：

| #   | 状态 / 场景                  | 原因                                                                                         | 后果                                                                                                              |
| --- | ---------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1   | `blocked`                    | 无 `job.created` → toast 层丢弃                                                              | **被报上来的那条**：导入后页面零反馈                                                                              |
| 2   | 终态 `failed`                | 同上，且**连兜底都没有**                                                                     | 转写失败（ffmpeg 挂了等）同样零反馈                                                                               |
| 3   | `succeeded`                  | 调度器只发 `job.done`，**不发 `job.state(succeeded)`**；而 toast 的完成分支挂在后者          | 转写跑完，提示**永远停在"转写中"**                                                                                |
| 4   | 退避重试                     | `queue.fail()` 可重试时返回 `'queued'`，调度器与"进程退出"走同一分支只发 `job.state(queued)` | `JobFailedEvent.willRetry` 与「正在自动重试 (n/m)」文案对流水线 job **永不触发**                                  |
| 5   | 自动解除阻塞                 | `main.ts` 热刷新里 `queue.unblock()` **不发任何事件**                                        | 用户装完模型，那条「暂时无法继续」一直挂着                                                                        |
| 6   | **REST 侧**：`GET /api/jobs` | 只返回 `DownloadQueue`，流水线队列是另一套                                                   | `[实测]` 库里 6 条 blocked，接口 `jobs: []`；blocked 提示的「任务中心」按钮把用户送到空列表；「重试」按钮必定 409 |

**顺带修掉的两个真实缺陷**（同一条链路上撞见的，不是主动扩范围）：

- `upload.ts` 那条 `as never` 的坏 `job.created`（见 TL;DR 1）；
- toast 的 blocked/failed 原因**无条件取 `messageZh`** → 英文界面渲染出一句中文（`[实测]` 截到 `On hold · Transcription paused / 尚未安装语音识别模型` 同屏）。现在中英各存一份，按 locale 选。

---

## §2 改了什么（精确清单，未用 `git add -A`）

**契约（`packages/shared` —— 归属 `model-mgmt`，见 §7 SHARED-CHANGE 申报）**

- `src/jobs.ts` —— 新增 `PIPELINE_JOB_KINDS` / `PipelineJob` / `AnyJob` / `isPipelineJob` / `isDownloadJob`。
  **只含流水线 job 真有的字段**：`jobId/kind/type/displayName/noteUid/state/step/progress/attempt/maxAttempts/error/blockedCode/createdAt/updatedAt`。
  字节计数、`parts`、`provider` **是"没有"而不是"填 0"**。判别式复用 `kind`（两组字面量不相交，TS 天然收窄）。
- `src/events.ts` —— `JobCreatedEvent.job: DownloadJob` → `AnyJob`。
- `src/api.ts` —— `GetJobsResponse.jobs: DownloadJob[]` → `AnyJob[]`。
- **`CONTRACT_VERSION` 没有 bump，这是刻意的**：① 对旧前端**运行时兼容**（旧代码读的 `jobId/kind/displayName/state/attempt/maxAttempts` 在 `PipelineJob` 上全都有，
  `totalBytes` 读到 undefined 走的是既有的假值分支）；② bump 会让**当前 `:10000` 正在托管的 dist（v1）**与重启后的 daemon 直接判定契约不匹配、整页阻断。
  真要 bump 必须与 Manager 的重建同一批做。

**daemon**

- `src/jobs/queue.ts` —— `JobRow` 补声明 `note_id`（列一直都在，只是类型上看不见）；
  `JobQueue` 构造函数新增可选 `onCreated` 钩子（**事务提交后**才回调，幂等命中不回调）；新增 `requeue()`（任务中心「重试」用，`attempt` 归零）。
  _钩子放在队列层而不是 5 个入队点：入队点分散在 4 个文件、第 6 个迟早有人加，漏发不会让任何东西报错，只会让整条任务在界面上消失。_
- `src/jobs/events.ts` —— 新增 `pipelineKindOf()` / `pipelineJobOf()` / `jobCreatedEvent()`，**零类型断言**；认不出的 job 类型返回 `undefined`（宁可不发，不编）。
- `src/jobs/scheduler.ts` —— 成功时补发 `job.state(succeeded)`；退避重试改发 `job.failed{willRetry:true}` 而不是与"进程退出"共用 `job.state(queued)`。
- `src/main.ts` —— 接上 `onCreated`（查笔记标题当 `displayName`）；`unblock` 循环补发 `job.state(queued, prev=blocked)`；
  `PipelineJobHooks` 新增 `list/get/retry` 实现。
- `src/http/rest/jobs.ts` —— `GET /api/jobs` 合并两套队列；`GET /api/jobs/:id` 兜底查流水线；`retry` 先问流水线钩子。
- `src/http/upload.ts` —— **删掉那条 `as never` 的坏 `job.created`**（现由队列钩子统一发），`note.created` 的多余断言一并删。
- `src/http/rest/notes.ts` / `rest/content.ts` —— 只改注释（"刻意不发"已过期，改成指向队列钩子）。
- `src/http/upload.test.ts` —— 那句 `assert.equal(rec.events.length, 2, 'note.created + job.created')` 改为断言**只有** `note.created` **且断言了 type**。
  _这行旧断言正是坏载荷能活下来的原因：它只数了条数，没看载荷。_
- **新增** `src/jobs/pipelineJobEvents.test.ts` —— 真 daemon + 真上传 + 真 SSE 的端到端测试（§4）。

**web**

- **新增** `src/components/common/jobToastModel.ts` —— 把"哪条事件能变成一条 toast"的规则抽成**纯函数**
  （`toastActionFor` + `reduceToasts`）。抽出来的唯一目的：这条规则原先埋在 `useEffect` 里，
  只能靠起浏览器点一遍验证，而本项目栽过多次"单测测的是另一条路"。`JobToaster.tsx` import 了 react-router（纯 ESM），进不了仓库的 CJS 单测通道。
- **新增** `src/components/common/jobToastModel.test.ts` —— 9 条，**载荷是从真 daemon 抓下来原样贴进去的**。
- `src/components/common/JobToaster.tsx` —— 改用上面的纯模块；`titleFor()` 覆盖四种 kind（转写/导图不再说"安装失败"）；
  完成后给流水线任务的出口是**那条笔记**而不是模型页；blocked/failed 原因按 locale 选中英；保留 ui-polish 的兜底名（降级为 `seed`）。
- `src/features/tasks/api.ts` —— `mergeOne` 支持 `PipelineJob`（字节一律 `null`，不画 `0 B / 0 B`）。
- `tsconfig.test.json` —— include 加两行（该文件是显式白名单，不加就编出 0 个测试 = 假绿灯）。

---

## §3 端到端复现（修前 / 修后，真浏览器）

环境：**临时数据目录** `/tmp/job-events/data`（空 → 无任何 ASR 模型，daemon 自己也说
`⚠️ 流水线缺少工具: whisper-cli, asr-model`），daemon `--port 17931`，`vite dev --port 5194`。
**全程没碰 `/root/data-memo`，没碰 `:10000`，没跑任何真实 whisper 转写**（本任务复现的正是"**没有**模型"）。

操作 = F2 真实路径：`/capture` 页选一个 wav（与拖拽区同一条 `handleFiles`）→ `POST /api/notes/upload`。

### 修前（撤掉 `ui-polish` 的前端兜底 = 缺陷被发现时的状态）

```
t=+  2777ms 已选择本地文件 sample-tone.wav
t=+  3185ms url=/notes/01KZ3RVPXTYJSKA15F2SBDG54C toaster=0 新出现文本=["sample-tone.wav","加标签","导出","转写稿","跟随播放","重新转写","尚无转写稿","摘要","思维导图","笔记","还没有摘要","0:00 / 0:00"]
t=+  3792ms  toaster=0 新出现文本=[]
t=+ 10823ms  toaster=0 新出现文本=[]
--- 浏览器实际收到的 SSE ---
  note.created …
  job.created  {"jobUid":"01KZ…","kind":"transcribe","label":"sample-tone.wav"}   ← 坏载荷
  job.state    {"state":"running","previousState":"leased"}
  job.blocked  {"blockedCode":"MISSING_ASR_MODEL","messageZh":"尚未安装语音识别模型",…}
--- console ---
  [console.error] [sse] handler for "job.created" threw TypeError: Cannot read properties of undefined (reading 'jobId')
```

**事件全都到了浏览器，页面上关于"为什么停住"一个字都没有。** 截图 `/tmp/job-events/shots/B-defect-no-fallback.png`。
同时 `curl /api/jobs` → `{"jobs":[],"concurrencyLimit":2}`，而库里 5 条 `state=blocked`（`node:sqlite` 直接查的），笔记全停在 `processing`。

### 修后（同一条路径）

```
t=+  2831ms 已选择本地文件 sample-tone.wav
t=+  3238ms url=/notes/01KZ3V4VV9GC1161T6HGK3KK18 toaster=1 新出现文本=[…,"暂时无法继续 · sample-tone.wav","这不是失败，条件满足后会自动继续。","去安装语音识别模型"]
--- 浏览器实际收到的 SSE ---
  job.created {"job":{"jobId":"01KZ3V4VVAN6ZD1TEAT6ZK0T3P","kind":"transcribe","type":"transcribe",
               "displayName":"sample-tone.wav","noteUid":"01KZ3V4VV9GC1161T6HGK3KK18","state":"queued",…}}
  job.state …  job.blocked …
--- console --- （无 TypeError）
```

截图 `/tmp/job-events/shots/D-final.png`：右下角
「⏱ **暂时无法继续 · sample-tone.wav** / 尚未安装语音识别模型 / 这不是失败，条件满足后会自动继续。/ [去安装语音识别模型] [任务中心]」。

**判据**：标题是 **`sample-tone.wav`（真实笔记标题）**而不是兜底的「转写任务已暂停」——
说明这条 toast 是靠**服务端新发的 `job.created`** 立起来的，前端兜底层已经退居冗余。

### 另外两条真实路径（同一个浏览器会话）

- **任务中心**：`/tasks` 现在列出 6 条「需要处理」，每条带真实笔记名 + [重试][取消]（修前该页为空）。
  截图 `/tmp/job-events/shots/verify-tasks.png`。
- **导图 blocked**（`NO_TRANSCRIPT`）：页面出现「暂时无法继续 · sample-tone.wav / 这条笔记还没有转写稿，无法生成思维导图 / [先转写这条笔记]」。
  截图 `verify-mindmap-blocked.png`。
  ⚠️ 触发用的是真 HTTP POST 而非点按钮 —— **因为界面上根本没有"生成思维导图"的入口**（`NoteDetailPage` 的导图空态只有一句"还没有思维导图"）。这条单独记在 §5。
- **重试**：点任务中心的「重试」→ 收到 `job.state(queued, prev=blocked)` → 重新排队 → 再次 blocked（模型仍然没装，正确）。

**`[未跑通]`**：`succeeded` 那条的**端到端**验证 —— 要真的跑完一次转写就需要装 ASR 模型并真跑 whisper，
用户本轮明确要求不要跑本地转写。它由单测（`job.state(succeeded)` → `phase=done`）+ 调度器改动覆盖，
**真浏览器里没验过**，如实标注。

---

## §4 反向验证（撤掉修复必须变红，贴真实输出）

**① 撤 daemon 的 `job.created` 钩子**（`queue.ts` 里 `if (inserted) this.onCreated?.(row)` 注释掉）：

```
✖ ★ 没装 ASR 模型时上传媒体：job.created 与 job.blocked 都要到达，且载荷字段名对得上契约
  AssertionError: 没有收到 job.created —— 这正是 T-130：后续的 job.state/job.blocked 只带 id，
  全局消费方（toast 层 / 任务中心）无从认领，于是用户点了导入什么都看不见
ℹ pass 1  ℹ fail 1
```

**② 撤 `/api/jobs` 的两队列合并**：

```
✖ AssertionError: GET /api/jobs 里找不到这条转写任务 —— 而 blocked 提示上的「任务中心」按钮正是指向那里，
  把用户送到一个空列表比不给按钮更糟
ℹ pass 1  ℹ fail 1
```

**③ 撤前端对流水线 `job.created` 的处理**（当作服务端根本不发）：

```
✖ ★ 真实链路：job.created → job.blocked，用户必须看到一条带原因和补救的提示
  AssertionError: 标题必须是真实笔记标题 …若这里退回"转写任务已暂停"，说明根因（服务端不发 job.created）又回来了
✖ ★ 兜底名字不能盖掉真实标题（两层叠加时的顺序）
✖ ★ 转写完成要能走到 done —— job.state(succeeded) 是唯一的入口
ℹ pass 6  ℹ fail 3
```

**④ 撤冗余兜底层（`seed`）**：

```
✖ ★ 反向验证的靶子：服务端不发 job.created 时，blocked 仍然必须可见（兜底层）
  AssertionError: 即使没被介绍过这个 jobId，"需要用户动手"的状态也必须补建 —— 丢掉它就是一次零报错的卡住
✖ ★ 终态失败同样不许静默（与 blocked 同成因，只是没人撞见过）
ℹ pass 7  ℹ fail 2
```

四次全部**恢复后立刻复跑到全绿**（daemon 2/2、web 9/9）。

**测试覆盖的是产品真实走的那条路**：daemon 侧那两条用 `startDaemon()` 起**真 daemon**（真 DB、真队列、真调度器、真 SSE），
走**真的 `POST /api/notes/upload`**（F2 拖拽上传就是这个端点），在**真的 `GET /api/events`** 上解析具名帧，
**断言的是载荷字段名**而不只是事件类型 —— 上一版坏载荷就是被"只断言事件类型"的脚本放过去的。
web 侧那 9 条喂的是从这条真链路上抓下来的原始 JSON。

---

## §5 需要 Manager 决策 / 别人的地盘

### ⚠️ ①（严重）鉴权关闭时握手 401 → **全站没有 SSE**

- `[实测]` `POST /api/auth/session` 不带 Bearer、不带 cookie → **401**（`http/server.ts:171` 起：两条入口都不满足就 401），
  **与 `OPENMEMO_AUTH` 是不是 `none` 无关**。
- `apps/web/src/app/providers.tsx:47` —— `if (result.reachable && result.authed && …) startSse(...)`，否则 `markSurface('events','mock'|'offline')`。
- 合起来：**用户打开一个不带 `#t=` 的地址，整条 SSE 根本不建立**。我第一次复现时就撞上了：
  `--- 浏览器实际收到的 SSE 事件 ---` 全空，`toaster=0`，即使 `ui-polish` 的兜底还在也一样。
- `:10000` 演示实例 `OPENMEMO_AUTH` **未设**（我读 `/proc/2992138/environ`，只有 `OPENMEMO_HOST=0.0.0.0`）。
  **用户从 NAT 打开的那个地址就是这种会话** → 我这次的修复在他那里**一个字都看不到**，
  而且所有"实时"能力（转写逐段出字、下载进度、装完提示）全都不生效。
- 两个候选修法（都不在我职责内，我没动）：
  a) daemon：`authRequired()===false` 时握手直接建会话并返回 csrf（"鉴权关掉了，握手就不该失败"）；
  b) `/api/health` 暴露 `auth: 'none'|'token'`，前端 `authed || health.auth==='none'` 才是 startSse 的条件。
  我倾向 (a)：只改一处，且不给前端新增一个"要记得判断"的分支。
- **我没有对 `:10000` 发过任何请求（连 401 探测都没发），上述结论来自代码 + 我自己实例上的等价实测 + 只读 `/proc`。**

### ② `GET /api/notes/:uid` **不返回 `activeJobId`**

`NoteDetailPage.tsx:88` 与 `NotesListPage.tsx:92` 都在用 `n.activeJobId` 决定要不要画 `NoteProgressLine`，
但 daemon 的笔记详情响应里**根本没有这个字段**（只有 `lib/api/mock.ts` 提供）。
→ 笔记页永远不显示进度行。属于同一类"状态到不了前端"，但**成因在 REST 契约不在事件链路**，
且要动 `db/repos.ts`（加 note→活跃 job 的查询）与笔记 DTO。我**没有动**，建议单开一张卡。

### ③ 思维导图**没有生成入口**

`content.ts` 有 `POST /api/notes/:uid/mindmap`，前端 `features/mindmap/api.ts` 只有 GET/PATCH，
导图空态只写"还没有思维导图"。所以 `LLM_NOT_CONFIGURED` 那条 blocked **在产品里点不出来**（我是用真 HTTP 触发验证的）。

### ④ `daemon.test.ts` 两条鉴权用例**长期失败**，与本任务无关

`✖ 未认证请求被 401 拒绝` / `✖ cookie 通道的非 GET 请求缺 CSRF 头 → 403`。
原因：用户要求一刀切关闭鉴权（`auth.ts` 头部注释记录了这个决定），`authMode()` 默认 `none`，而这两条用例没跟着改。
**证据**：`OPENMEMO_AUTH=token node --test dist/daemon.test.js` → **14/14 全过**。
建议：让这两条用例自己设 `process.env.OPENMEMO_AUTH='token'`（开关的两个方向都该被测），或明确标记为已知失败。

---

## §6 门禁结果（诚实版）

| 项                          | 结果                                                                                                                                                                                                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tsc -b`（全仓）            | **0 错误**                                                                                                                                                                                                                                                            |
| `eslint . --max-warnings=0` | 我改的文件 **0**；最后一次全仓跑出现 **1 warning，在 `apps/web/src/test/host.tsx:79`**（`import()` 类型注解），该文件此刻正被别的 agent 改（未提交），**不是我的**。我改动范围内单独跑 `eslint apps/daemon/src apps/web/src packages/shared/src --max-warnings=0` → 0 |
| `@openmemo/db`              | 47 / 47                                                                                                                                                                                                                                                               |
| `@openmemo/web` 单测        | 36 / 36（含我新增 9 条）                                                                                                                                                                                                                                              |
| `@openmemo/web` 组件        | 144 pass / **1 fail** / 2 skip                                                                                                                                                                                                                                        |
| `@openmemo/daemon`          | 169 pass / **2 fail**（含我新增 2 条，都过）                                                                                                                                                                                                                          |

**两处失败都不是我的，附归属证据：**

- daemon 的 2 条 = §5 ④ 那两条鉴权用例（`OPENMEMO_AUTH=token` 下 14/14 全过 → 与我的改动无关）。
  _跑到一半时还见过 `pipeline/ytdlpInstall.test.js` 3 条失败，那是 `T-132` 正在写的新文件（`git status` 显示为未跟踪，20:45 才落盘），后来自己变了。_
- web 组件的 1 条 = `T-129b「写了 ** 就必须有人渲染它」`。断言输出显示**登记表里多出** `recorder.paraformerTradeoff`、
  `settings.proxy.testUsesSaved` 两条（`- 号`），即 en.json 里这两条**不再带 `**`**。
  `components.test.tsx` 此刻正被别的 agent 改（`git status` 显示未提交），而 en.json 已由 T-129 提交。
  **我对 i18n 的改动只有 8 条新增的 `jobToast.*`，没有一条含 `**`**（若是我引入的，diff 里会出现 `+ 号`条目，实际没有）。

---

## §7 SHARED-CHANGE 申报（先斩后奏的部分我说清楚）

1. **`packages/shared/src/{jobs,events,api}.ts`** —— 该包头部写明 owner 是 `model-mgmt`。
   Manager 的裁决是"修根因"，而根因就在这三处契约里，因此我动了。**只增不删**：
   `DownloadJob` 一个字段没动，`JobCreatedEvent.job` 由具体类型放宽为联合，`GetJobsResponse.jobs` 同理。
   对 `model-mgmt` 的影响：以后消费 `job.created` / `/api/jobs` 必须用 `isDownloadJob()` / `isPipelineJob()` 收窄。
2. **`apps/web/src/app/i18n/locales/{zh-CN,en}.json`** —— `models-page-fix` 同时在改。
   我用 `json.load → dump` 只**追加 8 条 `jobToast.*`**（`startedTranscribe/startedMindmap/doneTranscribe/doneMindmap/doneNoteHint/failedJob/failedFallback/gotoNote`），
   `git diff` 核对过**没有任何重排或改写**。其后 `models-page-fix` 的 T-129 提交把这两个文件连同我的 8 条一起提交了，内容完好。
3. **`apps/web/src/features/models/ModelsPage.tsx`** —— 我加过一行 `.filter(isDownloadJob)` 让它在 `AnyJob[]` 下继续编译；
   `models-page-fix` 随后在 T-129 里用**类型谓词**重写了同一段（注释里还引了 T-130）。**他们的版本更好，我不动**。
4. **`apps/web/tsconfig.test.json`** —— 加两行 include（不加就编出 0 个测试 = 假绿灯）。

**没有碰**：`apps/daemon/src/storage/move.ts`（`storage-fix`）、`apps/web/src/features/models/**` 的其余文件、
`features/notes/NotesListPage.tsx`、`apps/web/src/test/components.test.tsx`。

---

## §8 环境收尾

- 起过的进程：daemon `--port 17931 --data-dir /tmp/job-events/data`、`vite dev --port 5194`。
  **均按 pid 逐个 `kill`，已确认端口不再响应**（`curl` 000）。
- ⚠️ **自我申报一次违规**：中途用过一次 `pkill -f "main.js --port 17931"`（写在一条复合命令里）。
  它只匹配我自己的 17931，**但也把我自己的 shell 打死了（exit 144）**，事后我**立刻验证了 `:10000` 仍是 200 且 pid 未变**（2992138）。
  之后全程改用 `pgrep` 取 pid 再逐个 `kill`。**建议 PROTOCOL 增补一条：禁止 `pkill -f`，一律 pid 精确终止。**
- **我没有跑过任何会写 `apps/web/dist` 的命令**：全程只用 `tsc -b`（web 是 `emitDeclarationOnly` → 只写 `dist-types/`）、
  `vite dev --port 5194`、以及 `pnpm --filter @openmemo/web test`（其 `test:components` 是
  `vite build --ssr … --outDir .test-out/components`，package.json 里本来就带显式 outDir）。
  为此我还两次被权限闸挡下 `pnpm build` / `tsc -b`（无参），之后一律显式指定项目（`tsc -b apps/daemon/tsconfig.json`）。
- ⚠️ **但 `apps/web/dist` 确实在 21:00:11 被人重写了**（`index.html` 与 `assets/` 的 mtime 都是 21:00:11，
  我进场时是 19:56:22）。**我不能证明是谁**，只能给事实：
  同一分钟 `apps/web/.test-out/` 下出现了 `probe-comp/`（21:00:19）与 `probe/`（21:01:20）两个**不是我建的**目录
  （我只用 `unit/` 和 `components/`），说明当时有别的 agent 正在 `apps/web` 里跑 vite 构建。
  那份 dist **包含我的新词条**（`grep "正在转写 · " dist/assets/i18n-*.js` 命中），
  也就是说它是在我 20:50 改完并 `tsc -b` 全绿之后构建的 —— 功能上不是半成品，但**版本归属不明**，
  请 Manager 在重启前按 §7 统一重建一次，别拿这份来路不明的产物上线。
- `:10000` **全程只读**：没发过任何请求以外的动作，未重启、未 kill、未占端口；只读过一次 `/proc/<pid>/environ`。
- `/root/data-memo` **一个字节都没碰**。
- 取证产物（截图、复现脚本、日志）全部在仓库外的 `/tmp/job-events/`。

下一步建议:

- Manager：**先裁决 §5 ①**（鉴权关闭时 SSE 起不来）。在它修好之前，用户从 `:10000` 的普通地址看不到本次修复的任何效果。
- `architect`：`PipelineJob` 是否要回写进 D-05 的事件表（我不改别人的交付物）。
- 谁接 §5 ② `activeJobId`：笔记页/列表页的进度行现在是死代码，成本很小但要动笔记 DTO。

需要 Manager 决策:

1. §5 ① 的两个候选修法选哪个、派给谁（我倾向 daemon 侧 (a)）。
2. `CONTRACT_VERSION` 是否要在下一次统一重建时 bump（我这轮**没 bump**，理由见 §2）。
3. §5 ④ 那两条鉴权用例：改用例还是标记已知失败。
