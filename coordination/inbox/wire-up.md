# inbox / wire-up

## [2026-08-03 23:25] T-138 DONE —— 三处「代码写了，但用户到不了」

### TL;DR（≤25 行，Manager 只读这里）

1. **三条全部接通，`600 passed / 0 failed`**（基线 555 + 我的 30 + `asset-check` 在途的 15）。`tsc -b` 0 · `eslint .` 全仓 0。
2. **① F4 生成入口**：`useGenerateMindmapMutation` + `GenerateMindmapButton`，接在**两个空态**上（详情页 mindmap tab + `/notes/:uid/mindmap` 全屏页）。位置不是拍脑袋：`R-01 §A2.4` 取证 memo.ac 的生成就发生在详情页 mindmap tab 里，我们放同一处。
3. **进行中状态用 T-130 的契约，没另造一套**：`GET /api/jobs`（`PipelineJob` 自带 `noteUid`/`kind`）+ `job.*` 事件。**不是** mutation 的 `isPending` —— 那只有 HTTP 往返几毫秒，而 LLM 要几秒。关窗口的手法：`onSuccess` **返回** invalidate 的 promise，react-query 会等它 resolve 才判 settled，于是"点完 → 任务列表里出现"之间**没有一帧按钮是可点的**。真浏览器实测：连点两次只发出 **1 条** POST。
4. **② 方向选了「从 job 事件流取」，否决「给笔记 DTO 补 `activeJobId`」**，三条理由见下（§2）。最硬的一条：**单加那个字段并不能让进度行活过来** —— 旧组件的渲染条件是"进度 store 里有这个 jobId"，而 `queued`/`blocked` 一条 `job.progress` 都不会发。走 DTO 要改两处，走事件流只改一处。`activeJobId` 已从 `types.ts` 与 `mock.ts` **删除**（不是留着不用），并有回归断言挡它回来。
5. **③ 端点真支持了**：`GET /api/notes?starred=1` 在 SQL 的 WHERE 里筛。判据不是"筛出来的都带星标"（前端过滤同样能过），而是**筛在 limit 之前** —— 建 3 条只给最早那条加星、`?starred=1&limit=2`，这是 N=51 那个 bug 在 N=3 上的等价复现。`NotesListPage` 里那句「真修法在端点」已按要求更新，前端的 `.filter()` **故意删掉**（留着会让护栏测的是前端那层）。
6. **反向验证 8 组，全部贴了真实红灯输出**（§4）。其中 RV-1 的 `actual` 直接把 bug 打了出来：`?starred=1&limit=2` 返回的是**两条最新的未加星笔记**。
7. **踩到并写下一个坑**：我的第一版断言 `/activeJobId/.test(src)` **被自己旁边的注释匹到**（与 T-129b 那次 `/\bEmphasis\b/` 同族）。修法不是改注释，是**先剥注释再断**（注释值得留着，它记录了这个 bug 为什么藏得住）。
8. **另一个诚实的取舍**：本想加一条"星标页取消星标要立刻消失"的组件用例，但它必须抢在 `onSettled` 重取之前断言 —— **依赖时序、绿也说明不了什么**。改成把规则抽成纯函数 `lib/api/notesCache.ts` 用单测钉（5 条），组件层只钉不依赖时序的那一半。
9. **F4 端到端已跑通（含 LLM 请求与落库）**：`generatedBy = "llm:deepseek"`、5 节点、218ms，节点 refs 带真实 `transcriptUid/startMs/endMs/quote`。
   ⚠️ **真正的在线 DeepSeek `[未跑通]`** —— 我没有自己的 key，**没有也不会去读用户的**。用一个本机假 OpenAI 兼容服务器顶替厂商，**其余全是产品真实路径**（真 daemon、真 runner、真 `resolveConfiguredProvider` 的 openai-compatible 分支）。实录到的请求：`POST /v1/chat/completions`、`Authorization: Bearer sk-fake…`、`model=deepseek-v4-flash`、prompt 里是真实转写稿 —— 即"请求已正确发出"。
10. **真浏览器复验**（自建 `:17942` daemon + 全新临时 dataDir + `vite dev :5207`）：空态有按钮 → 点击变 `Generating…`+disabled → 4.5 秒后导图渲染出来；`/notes?starred=1` 实际请求 `GET /api/notes?starred=1`，2 条 → 1 条；**列表页出现 2 条 `On hold 0%` 进度行，而同一次 `GET /api/notes` 的 DTO 字段里根本没有 `activeJobId`** —— 这就是 ② 修好了的判据。
11. **纪律**：`apps/web/dist` 一次都没构建（mtime 仍是 22:09，非我）· 验证构建全走 `pnpm build:safe` · `:10000` 全程只读（收尾发过 1 次 `GET /api/health`）· `/root/data-memo` 零写入 · `~/.local/share/openmemo/datadir.json` 内容与 `updatedAt` 均未变（`cat` 核对过）· 没跑本地 whisper · 未用 `pkill -f`（按 pid 逐个 kill，三个端口已确认释放）· 未 commit · 未派生 subagent。
12. **需要 Manager**：见 §7（三条，都是别人地界的顺带发现，我只报不动）。

---

## §1 ① 思维导图没有 UI 生成入口

### 1.1 现状（动手前查清楚的）

| 问题 | 实情 |
|---|---|
| 编辑器里有没有半成品入口？ | **没有。** `features/mindmap/api.ts` 只有 `useMindmapQuery`(GET) 与 `useSaveMindmapMutation`(PATCH)，**全仓没有任何一处调 `POST /api/notes/:uid/mindmap`** |
| `packages/mindmap` 的查看器接上了没有？ | **接上了，而且是完整的**：`MindmapView` 真 mind-elixir（拖拽/撤销/重做）、`export.ts` 矢量导出、PATCH 保存已打开（T-1xx 把 `MINDMAP_SAVE_SUPPORTED` 整个删了）。**唯独没有"从哪来"** |
| 空态说了什么？ | 详情页 tab：一句 `mindmap.empty`（"还没有思维导图"）。全屏页：`EmptyState` 带 `emptyHint`「转写完成后**可以让 AI 生成**，也可以从空白开始手动整理」—— **一句描述了不存在功能的文案** |
| 后端呢？ | 全通。`content.ts:310` POST → `queue.enqueue({type:'mindmap', lane:'gpu.llm'})` → `runners/mindmap.ts`（LLM → validate → 落库 → `note.updated{changed:['mindmap']}`） |

`job-events` 的 T-130 回执 §5③ 已经报过同一件事，并说明它当时是**用 curl 直接打接口**才验到导图 blocked 的。

### 1.2 放在哪 —— 参考 memo.ac，不是凭感觉

`docs/research/R-01-memo-ac.md §A2.4`（二进制取证）：memo.ac 详情页右侧固定 6 个 tab，`mindmap` 是其中之一；生成是 LLM 流式推进那个 tab（`mindmap:start/thinking/message/complete`）。**生成入口就在"用户想看导图却没有"的那一刻**。

所以两处都接：

| 位置 | 理由 |
|---|---|
| `NoteDetailPage` 的 mindmap tab 空态 | 与 memo.ac 同位。用户点开 tab 发现空的，下一步动作就在眼前 |
| `MindmapPage`（`/notes/:uid/mindmap`）的 `EmptyState` | 侧栏/详情页的「去导图页编辑」会把人送到这里；到了之后同样得能生成，否则是个死胡同 |

`EmptyState` 本来就有 `action` 槽（D-05 §5.4「空态即入口」，`NotesListPage` 已在用同一模式）—— **没有新造版式**。

`mindmap.emptyHint` 一并改写：删掉「也可以从空白开始手动整理」（**那个入口至今不存在**，留着就是下一个"文案承诺了没有的东西"），改成描述真实发生的事。有用例钉住这句不许回来。

### 1.3 进行中状态：为什么不能用 `isPending`

端点是 **202 + jobUid**，真正的生成在队列里。`isPending` 只覆盖 HTTP 往返的几毫秒 → 按钮闪一下就恢复可点 → 用户在 LLM 跑的那几秒里必然再点 → **每一次都真的多排一条任务**（端点没有幂等键，而那是**刻意的**：重新生成是合法操作，不该被 24h 幂等窗口吃掉）。

进行中状态读的是 **T-130 刚定的那套**，一个字都没自己造：

```
POST → 202 {jobUid}
     → JobQueue.onCreated 钩子发 job.created{ job: PipelineJob }   （T-130）
     → GET /api/jobs 里合并了流水线队列，PipelineJob 自带 noteUid / kind  （T-130）
     → job.state / job.progress / job.blocked 更新
```

`useActiveNoteJob(noteUid, 'mindmap')` 就是从这条流里认领的。**好处是刷新页面它还在**（REST 列表是真相，SSE 只是提示，D-01 §3.3）。

关"重复点击"那个窗口的手法值得单说：`onSuccess` **返回** `qc.invalidateQueries(...)` 的 promise。react-query 会 await 它才把 mutation 判为 settled，于是 `isPending` 一直覆盖到"任务列表里已经能看见这条任务"为止 —— **没有额外的本地 state，也没有一帧空窗**。

`blocked` 单独说话：按 daemon 给的 `blockedCode` 查 `mindmap.blocked.<code>` 文案（`NO_TRANSCRIPT` / `LLM_NOT_CONFIGURED` / 认不出的回落到 `UNKNOWN`）。**不在前端重新判断一次条件** —— "有没有转写稿""配没配 LLM"只有 daemon 说了算。

---

## §2 ② `NoteProgressLine` 是死代码 —— 选了哪条路、为什么否决另一条

**选：从 job 事件流取（组件改成按 `noteUid` 问 `useActiveNoteJob`）。**
**否决：把 `activeJobId` 补进 `GET /api/notes(/:uid)`。**

三条理由，按重量排：

1. **它会造出第二个事实来源。** T-130 之后 `GET /api/jobs` 已经如实列出流水线任务且**自带 `noteUid`**，SSE 的 `job.created/state/progress` 也已成契约。再让笔记 DTO 回答一次"哪个 job 在跑"，两处就可能给出不同答案。今天已经吃过这个亏（`/models` 与 `/settings` 对同一个问题给出相反答案）。**任务明确说了不要两边都加，我连"加了但不用"都没留。**
2. **单加那个字段并不能让进度行活过来 —— 这条是决定性的。** 旧组件的渲染条件是 `useProgressStore.byJob[jobId]` 有快照，而 store 只由 `job.progress` 事件喂养。**`queued` 与 `blocked` 一条 progress 都不会发**（这两种恰恰是用户最想知道"它在等什么"的时刻）。所以走 DTO 那条路要**同时**改 DTO **和**组件；走事件流只改组件一处。
3. **一条笔记可以同时有多个未完成任务**（转写 + 导图），`activeJobId` 是单数：要么随便挑一个（挑错了就是显示错的），要么改成数组 —— 而"一个 noteUid 对应一组 job"正是 `/api/jobs` 已经在做的事。

附带的第 4 条：REST 列表**刷新后仍在**，纯 SSE 不行。（另：`job-events` 报过的"鉴权关闭时 SSE 起不来"如果成立，走 REST 这条路仍然能显示，走纯事件那条就全瞎了。）

**执行细节：**
- `activeJobId` 从 `lib/api/types.ts` **删除**（不是留着不用），并写清"为什么没有补进 daemon"。
- `lib/api/mock.ts` 同步改造：以前它在 `note.activeJobId` 上记 job id，**mock 比真后端多长了一个字段 —— 这正是这个 bug 藏了这么久的原因**。现在 mock 与 daemon 走同一条路：把一条真实形状的 `PipelineJob` 放进 `GET /api/jobs`，笔记 DTO 里没有它。
- 决策规则抽成纯函数 `lib/jobs/noteJobs.ts`（`isActiveJobState` / `activeNoteJobs` / `pickActiveNoteJob`），进 CJS 单测通道，7 条单测逐条钉。
  - `blocked` **算未结束**（把它当终态 = T-130 修掉的那种零报错的卡住又回来）。
  - 多条未完成时取**最新创建**的（不是"取 running 的那条" —— 那会让刚点完还在 `queued` 的任务输给一个早就卡住的旧任务，表现就是"我点了但什么都没变"）。排序**在这里显式做**，不依赖 `/api/jobs` 恰好新的在前。
- 组件保留了原来那条关键性质：**selector 只订阅自己那一条 jobId**（D-05 §2.4），列表页每行不会随任意任务的 4Hz 进度重渲染。
- 详情页那句「可以离开此页面」并进 `hint` 属性 —— 它和进度行**同生共死**，不该再由外面一个独立条件包住（⑤D「嵌套条件」同族）。

---

## §3 ③ 星标筛选只筛一页

**daemon**（`db/repos.ts` + `http/rest/notes.ts`）：

- `listNotes(limit, { starredOnly })` → `WHERE deleted_at IS NULL AND starred = 1`。**筛在 SQL 里，`limit` 限的才是星标笔记的条数。**
- `GET /api/notes?starred=1|true`。**认不出的取值一律 400，绝不静默忽略** —— `?starred=0` 最自然的读法是"只看没加星的"，静默忽略会返回**全部**笔记：一个既不报错、又和调用方意图相反的结果。要支持"只看未加星"就显式加分支，不靠猜。

**web**：

- `useNotesQuery({ starredOnly })` 发 `/notes?starred=1`；两种筛选是**两条缓存**（filter 参与 queryKey）。
- `NotesListPage` 里那段注释按要求更新了：「真正的修法是端点支持 starred」→ 改成"已经挪进端点了"，并写明**前端那层 `.filter()` 是故意删掉的**：留着它，端点哪天回退成不认这个参数，页面看起来照样正确，护栏测的就成了前端那层。
- 连带修一处**由这次改动引入的**问题：乐观更新原来只写空 filter 那条缓存，星标页会一动不动。改成对 `qk.notes.lists` 前缀下的每条缓存都应用 `applyStarToPage()`；星标那页还要把取消了星标的那条**移出去**（那是对"服务端下一次会返回什么"的预测，随后被 `onSettled` 的 invalidate 纠正；筛选本身仍只有 daemon 一个实现）。
- `mock.ts` 的 `/notes` 分支此前用 `path === '/notes'` 精确匹配，**带上查询串就会落到"未实现"分支直接抛错**。已改成先切查询串再匹配，并同样支持 `starred`。

---

## §4 反向验证（8 组，全部真实输出）

> 每组：改坏 → 重建 → **先确认跑的是刚改过的产物** → 跑 → 贴输出 → 还原 → 复跑全绿。
> daemon 侧每次都 `grep` 了 `dist/` 里被删掉的那个字符串，确认 `tsc -b` 真的重建了（PROTOCOL 提过有人被旧 mtime 骗过）。

**① 撤掉 SQL 里的 starred 过滤**（`listNotes` 忽略 `starredOnly`；`grep -c "starred = 1" dist/db/repos.js` → `0`）
```
✖ ★ 筛选必须发生在 limit 之前 —— 否则笔记一多，星标笔记就会无声地漏掉
  AssertionError: ?starred=1&limit=2 没返回那条加了星的笔记 —— 说明 limit 先切、starred 后筛：
  笔记数一旦超过一页，星标页就开始漏，而用户看不出少了什么
  + actual - expected
    [
  +   '01KZ42M45RZ4723W21TDRP5JVG'
  +   '01KZ42M45JKSZRMKATKWV5NXFC'
  -   '01KZ42M45DC5DMM0A6PX3X35PY'
    ]
ℹ pass 3  ℹ fail 1
```
> **`actual` 就是 bug 本身**：返回的是两条**最新的、没加星的**笔记。

**② 撤掉 400 分支**（改成静默当"不筛"；`grep -c BAD_QUERY_PARAM dist/http/rest/notes.js` → `0`）
```
✖ ★ 认不出的取值一律 400，绝不静默当成"不筛"
  AssertionError: ?starred="0" 被静默忽略了 —— 它会返回**全部**笔记，一个既不报错又和调用方意图相反的结果
  200 !== 400
ℹ pass 3  ℹ fail 1
```

**③ 导图 job 不再挂到笔记上**（`enqueue({noteId: undefined})`）
```
✖ ★ 202 的 jobUid 必须能在 /api/jobs 里认领到，且带 kind=mindmap 与 noteUid
  AssertionError: 没有 noteUid 就无从判断它属于哪条笔记
  + null
  - '01KZ42RDCX093GET4XSNA399Z8'
ℹ pass 3  ℹ fail 1
```

**④ 前端不再带 `?starred=1`**
```
✖ ★ /notes?starred=1 只列星标笔记；/notes 列全部
  AssertionError: 星标页必须把筛选交给端点（实际请求：["/notes","/jobs"]） ——
  在前端筛只能筛已取回的那一页，笔记超过 limit 之后会静默漏掉
✖ ★ 有笔记但一条都没加星时，给星标专属空态 —— AssertionError: 空态文案不对：星标plain one0 分钟3天前
✖ ★ 星标页上的星标按钮仍然是真的写入路径 —— AssertionError: 前置条件：星标页此刻应有 1 条
ℹ tests 176  ℹ pass 173  ℹ fail 3
```

**⑤ `useActiveNoteJob` 不再从任务流取数**（退回"只认 progressStore"的旧世界）
```
✖ ★ 点完之后按钮立刻不可点 —— AssertionError: 生成已经排上队了，按钮却还可以点
✖ ★ 进行中状态来自任务流，所以刷新页面它还在 —— AssertionError: 生成中途刷新页面，按钮又变回"生成"
✖ ★ blocked 要说出 daemon 给的原因 —— AssertionError: 没说它被挂起了（实际：生成思维导图）
✖ ★ 认不出的 blockedCode 回落到通用说法 —— AssertionError: 认不出的 code 让提示整块消失了
✖ ★ 列表页：daemon 说这条笔记有任务在跑，进度行就必须出现
  AssertionError: 笔记响应里没有 activeJobId（daemon 从来就不发它），进度行于是一次都没渲染过
✖ ★ 排队中 / 阻塞中也要说话 —— 这两种状态一条 job.progress 都不会发
ℹ tests 176  ℹ pass 170  ℹ fail 6
```
> **这一组同时覆盖了 ① 与 ②** —— 因为它们本来就该共用一个来源，这正是"没有两个事实来源"的证据。

**⑥ 从两个空态里删掉按钮**（组件仍在，只是没人用）
```
✖ ★ 两个空态都真的接上了这个按钮（组件造出来没人用 = 入口仍然不存在）
  AssertionError: features/mindmap/MindmapPage.tsx 没有 import GenerateMindmapButton —— 注释里提一句不算（T-129b 的教训）
ℹ tests 176  ℹ pass 175  ℹ fail 1
```

**⑦ 把 `blocked` 当成终态**（`isActiveJobState` 只认 running/leased）
```
✖ ★ blocked 算"还没结束" —— AssertionError: blocked 被当成终态 = 一次零报错的卡住又回来了
✖ ★ 多条未完成时取最新创建的那条 —— AssertionError: 刚点完还在排队的那条输给了一个早就卡住的旧任务
ℹ tests 39  ℹ pass 37  ℹ fail 2
```

**⑧ 星标页不再把取消星标的那条移出去**
```
✖ ★ 「星标」那一页：取消星标要把它移出去（否则用户点了没反应）
  AssertionError: 星标页是服务端按 starred=1 筛过的一页，取消星标之后它就不属于这一页了 ——
  留在原地等 invalidate 回来才消失，用户看到的是"点了没反应"
ℹ tests 39  ℹ pass 38  ℹ fail 1
```

八组全部还原后复跑：**db 47 · pipeline 132 · daemon 196 · web 单测 39 + 宿主 10 + 组件 176 = 600 pass / 0 fail**。

### 4.1 我自己的护栏出过一次假绿，写出来

第一版的「`activeJobId` 不许回来」断的是 `/activeJobId/.test(src)` —— **被自己旁边那句解释性注释匹到了**（`mock.ts` 里写着"mock 在 `note.activeJobId` 上记了一个 job id"）。和 T-129b 那次 `/\bEmphasis\b/` 匹到注释是同一族。

**修法不是把注释改写成不像代码的样子**（那两句注释恰恰记录了这个 bug 为什么藏得住，值得留着），而是**先剥掉注释再断代码**。

### 4.2 一条我**没有**写的用例，以及为什么

想加「在星标页取消星标，那条要立刻消失」的组件用例。写出来才发现它必须**抢在 `onSettled` 的重取回来之前**断言 —— 一条依赖时序的用例：绿说明不了什么，红也未必是产品坏了。而当前测试宿主的 `stubApi` 没法让一个请求真的挂住（返回值不被 await）。

所以改成把规则抽成纯函数（`lib/api/notesCache.ts`）用单测钉 5 条，组件层只留「PUT 真的发出去了」这条不依赖时序的。**这是本项目 `jobToastModel.ts` 已经立过的先例**，理由写在文件头。

---

## §5 端到端验证

### 5.1 F4 全链路（真 daemon + 真 runner + 假 LLM 厂商）

环境：**全新临时数据目录** `/tmp/wire-up/data`、daemon `--port 17942`、假 OpenAI 兼容服务器 `:18801`。
**全程没碰 `/root/data-memo`，没重启/占用 `:10000`，没跑任何 whisper。**

```
POST /api/notes/:uid/mindmap → 202 { jobUid: 01KZ43AQKS…, noteUid: 01KZ435KAG… }
job 终态 = succeeded (218ms)  kind=mindmap  noteUid=01KZ435KAG…  blockedCode=null
GET  /api/notes/:uid/mindmap → {"generatedBy":"llm:deepseek","nodeCount":5,"revision":1}
节点 refs（LLM 只给段落编号，时间与引文由我们从转写稿算 —— ADR-013 决策 2）：
  {"text":"链式法则是数学基础","refs":[{"transcriptUid":"01WIREUP…","startMs":20000,"endMs":40000,
    "quote":"今天的核心问题是损失怎么反向传回去，关键在链式法则。","matchScore":1}]}
```

daemon **真的把请求发出去了**（假服务器的原始记录）：
```
POST /v1/chat/completions   Authorization: Bearer sk-fake-not-a-real-key
model = deepseek-v4-flash
messages[1] = 下面是转写稿的一部分，每行开头的 [数字] 是段落编号。…
              [0] 我们上节课讲到了前向传播的基本流程。 [1] 今天的核心问题是损失怎么反向传回去…
```

> **`[未跑通]`：真正的在线 DeepSeek 我没有跑。** 我没有自己的 API key，**也没有去读用户的**（用户的 key 在 `/root/data-memo/secrets.json`，我一个字节都没碰）。被替换掉的**只有厂商那一跳**：daemon、队列、runner、`resolveConfiguredProvider` 的 openai-compatible 分支（与真 DeepSeek 完全同一条）、prompt、JSON 解析、校验、落库、SSE，全是产品真实代码。
> **诚实补充**：第一次跑是 `failed`（`structured output failed after 3 attempts`）—— **是我的假响应形状写错了**（用了 `segments/children`，契约要的是 `seg/points`）。改对 fixture 后成功。这说明**校验那一环是真的在工作**，不是被我绕过去了。

### 5.2 真浏览器（`vite dev :5207` → 我自己的 `:17942`）

浏览器语言 en-US，所以下面是英文文案。

**① 生成入口**
```
① 空态里有没有生成按钮： 有
   按钮文案： Generate mind map     disabled： false
② 点击后 —— 文案： Generating…      disabled： true
③ 生成完成后导图渲染出来了吗： 是
④ 浏览器发出的非 GET 请求： [… "POST /api/notes/01KZ43C3VD…/mindmap"]      ← 只有 1 条
```
> **连点了两次，只发出 1 条 POST** —— §1.3 那个窗口确实关上了。
> 截图：`/tmp/wire-up/shots/{1-empty-with-entry,2-generating,3-done}.png`

**③ 星标**
```
全部笔记条数： 2
星标页条数： 1        星标页标题： Starred
星标页发出的笔记请求： ["GET /api/notes?starred=1"]      ← 筛选真的交给了端点
```

**② 进度行（最关键的一条）**
```
② 列表页进度行条数： 2
   #0: On hold 0%
   #1: On hold 0%
   daemon 的笔记 DTO 字段： ["uid","title","status","kind","language","durationMs","starred","tags","createdAt","updatedAt"]
   含 activeJobId？ false
```
> **同一次 `GET /api/notes` 的响应里根本没有 `activeJobId`，进度行照样渲染出来了。**
> 这两条笔记各有一个 `blocked` 的转写任务（这台机器没装 ASR 模型）—— 而 `blocked` 恰恰是旧实现**永远显示不出来**的状态（它一条 `job.progress` 都不会发）。修前这里是 0 条，且永远是 0 条。
> 截图：`/tmp/wire-up/shots/{4-starred,5-progress-lines}.png`

---

## §6 改动清单（**请勿 `git add -A`**）

⚠️ **`apps/daemon/src/db/repos.ts` 不在下面这张单子里 —— 它已经被别人的提交带走了，见本节末尾。**

```
git add apps/daemon/src/http/rest/notes.ts \
        apps/daemon/src/http/notesRest.test.ts \
        apps/web/src/app/query.ts \
        apps/web/src/lib/api/types.ts \
        apps/web/src/lib/api/mock.ts \
        apps/web/src/lib/api/notesCache.ts \
        apps/web/src/lib/api/notesCache.test.ts \
        apps/web/src/lib/jobs/noteJobs.ts \
        apps/web/src/lib/jobs/noteJobs.test.ts \
        apps/web/src/features/tasks/api.ts \
        apps/web/src/features/tasks/index.ts \
        apps/web/src/features/mindmap/api.ts \
        apps/web/src/features/mindmap/index.ts \
        apps/web/src/features/mindmap/GenerateMindmapButton.tsx \
        apps/web/src/features/mindmap/MindmapPage.tsx \
        apps/web/src/features/notes/api.ts \
        apps/web/src/features/notes/NoteProgressLine.tsx \
        apps/web/src/features/notes/NoteDetailPage.tsx \
        apps/web/src/features/notes/NotesListPage.tsx \
        apps/web/src/app/i18n/locales/zh-CN.json \
        apps/web/src/app/i18n/locales/en.json \
        apps/web/src/test/components.test.tsx \
        apps/web/tsconfig.test.json \
        coordination/inbox/wire-up.md
```

新增文件 6 个（3 个源码 + 3 个测试）。i18n 新增 `mindmap.{generate,generating,generateBlocked,blocked.*}` 与 `progress.state.*`，**zh/en 逐条对称**，改写 `mindmap.emptyHint`。

⚠️ **`git status` 里还有 `asset-check` 在途的改动**（`apps/daemon/src/http/media.{ts,test.ts}`、`storage/migrateAssets.*`、`packages/runtime/**`）—— **那些不是我的**，我一个字都没碰（按分工避开了 selfcheck 与 `storage/migrateAssets` 那条线）。
⚠️ `apps/web/src/test/components.test.tsx` 是共享文件：我在**文件末尾追加**两个 describe，另**改写**了 `T-129 侧栏「星标」筛选` 那三条（桩必须分成 `/notes` 与 `/notes?starred=1` 两条，否则测不出端点有没有真的筛）—— 改写原因写在用例上方的注释里。

**新增测试 30 条**：daemon 4 · web 单测 12 · web 组件 14。
（daemon 从 177 → 196 中，另外 15 条是 `asset-check` 的 `media.test.ts` 等，不是我的。）

### ⚠️ 我的一处改动被别人的提交带走了 —— HANDOFF ⑤J 的**第六例**

`a33fe31`（23:16，message 是「fix: 媒体资产解析 …（T-136）」）里装着
**`apps/daemon/src/db/repos.ts` 的整段 T-138 ③ 改动**（`listNotes` 的 `starredOnly` 参数 + SQL 里的
`AND starred = 1`）。`git show a33fe31 -- apps/daemon/src/db/repos.ts` 显示那个 hunk
**逐行都是我的**，没有一行属于 T-136；而那条 commit message 通篇讲媒体资产解析，
**一个字没提星标筛选**。

- **后果不是功能坏了**（内容完好、`tsc`/测试全绿），**是归档串了**：
  以后有人 `git log -- repos.ts` 想知道"星标筛选是什么时候、为什么挪进 SQL 的"，
  会读到一段关于 `rel_path` 三种写入约定的说明。
- **成因**：我 23:1x 还在改工作区，`asset-check`/Manager 在 23:16:38 用 `git add -A`（或等价的全量暂存）提交。
  这与 HANDOFF ⑤J 记录的五次**完全同型**，也再一次说明那条禁令**光靠"记得别用"是拦不住的** ——
  它需要的是"提交前按清单核对"这一步存在于流程里，而不是存在于纪律里。
- **我没有去改那条已经落地的提交**（PROTOCOL §0：Manager 是唯一合并者，我不动别人的交付物）。
  请 Manager 决定是留着还是在下一次提交里补一句说明。

---

## §7 需要 Manager 决策 / 别人地界（只报不动）

1. **`mindmap.editsNotPersisted` 是一条过期文案**：写着「导图编辑目前只在本页生效，尚未保存到本地服务（**保存接口未实现**）」—— 而 `PATCH /api/notes/:uid/mindmap` 早就落地、前端也早就在调了。全仓**没有任何地方渲染这条词条**（我 grep 过），所以今天用户看不到它，但它是下一个"注释/文案与代码不一致"的定时炸弹。归 `architect`。建议**删除**而不是改写。
2. **导图仍然只能"生成"，不能"重新生成"**：已经有导图的笔记，界面上没有再跑一次的入口（转写稿更新后导图就旧了）。端点支持（同一个 POST，无幂等键），成本是在 `MindmapView` 工具条上加一个按钮 + 一句"会覆盖当前这张"的确认。**本轮刻意没做** —— 任务是"没有生成入口"，加重新生成属于扩范围，而且它需要一次覆盖确认的交互设计。
3. **`job-events` 报的那条鉴权问题仍未解决**（`POST /api/auth/session` 在 `OPENMEMO_AUTH=none` 时仍 401 → 不带 `#t=` 打开页面全站没有 SSE）。我的验证全程带 `#t=`。**它不影响本轮的三条**（进度行与生成按钮都以 `GET /api/jobs` 为真相，SSE 只负责让它更快更新），但会让"生成中 → 完成"的切换从"秒级"退化成"下一次窗口/失效触发的重取"。请优先裁决。

---

## §8 环境收尾与诚实声明

- 起过的进程：daemon `--port 17942 --data-dir /tmp/wire-up/data`（pid 3177132）、假 LLM `:18801`（3179912）、`vite dev :5207`（3181069）。**均用 `ps -eo pid,args` 取 pid 后逐个 `kill`，未用 `pkill -f`**；三个端口收尾 `curl` 均为 `000`。
- **`apps/web/dist` 一次都没构建**：`index.html` mtime 仍是 `08-03 22:09`（我进场是 22:16，不是我）。验证构建一律 `pnpm build:safe` 或 `pnpm --filter @openmemo/daemon build`；web 侧只跑 `tsc -b`（`emitDeclarationOnly`）、`vite dev` 与 `test:components`（自带 `--outDir .test-out/`）。
- **`:10000` 全程只读**：未重启、未 kill、未占用该端口；收尾发过 **1 次 `GET /api/health`**（200）确认它还活着，此外零请求。
- **`/root/data-memo` 零写入**，`secrets.json` 未读取。`~/.local/share/openmemo/datadir.json` 收尾 `cat` 核对：`{"dataDir":"/root/data-memo","updatedAt":"2026-08-03T14:15:00.000Z"}` —— 内容与时间戳都没变（我的 daemon 全程用 `--data-dir`，日志明确写着"本次使用 /tmp/wire-up/data"）。
- **未跑任何本地 whisper 转写**。测试里的转写任务全部停在 `blocked`（没装模型），那正是被测的场景。
- 未 commit。未派生 subagent。取证产物全部在仓库外 `/tmp/wire-up/`（`shots/`、`llm-requests.json`、`daemon.log`、`fake-llm.mjs`、`gen.mjs`、`shot*.mjs`）。

### 诚实声明

- §4 的八段红灯输出**是实际复制的**，包括 §4.1 那次被自己注释骗过的假绿 —— 我把它写出来而不是直接贴改好之后的红。
- **真正的在线 DeepSeek `[未跑通]`**，理由与替代验证见 §5.1。"4.3 秒出图"那个数字是**别人的实测**，不是我的。
- §5.1 里那条 fixture 转写稿是我**直接写进自己临时库的 SQLite**（不走 whisper），这是为了绕开"不跑本地转写"的限制；**笔记本身走的是真实上传路径**。
- **F4 的"重新生成"没做**，理由见 §7.2 —— 是明知而未做，不是漏了。
- `en` 那 8 条新文案是我写的，**未经母语校对**。
- 我改写了 `T-129` 那三条既有用例的桩。**不是因为旧断言写错了方向**（它们当时是对的），而是因为筛选的实现位置变了、桩必须跟着分成两条 —— 原委写在用例上方。
