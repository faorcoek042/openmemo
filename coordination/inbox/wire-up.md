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

---

## [2026-08-03 23:40] T-138b DONE —— 侧栏高亮：判据只覆盖了列表页

### TL;DR（≤25 行）

1. **报上来的是详情页两项同时亮，查下去发现同一个成因有两个方向相反的症状**，逐地址枚举实测：

   | 地址 | 修前高亮项数 | 症状 |
   |---|---|---|
   | `/notes/<uid>` · `/notes/<uid>?tab=mindmap` | **2** | 详情页是 `/notes` 的**子路径** → `pathname === linkPath` 不成立 → 交回 `NavLink` 前缀匹配 → 「全部笔记」与「星标」一起亮（你截图里那个） |
   | **`/models?tab=llm`** | **0** | pathname 相同、查询串不同 → 精确比对判否 → **「模型」自己灭了**，用户切个 Tab 就不知道自己在哪一页 |

   **这条是你没看到的另一半**，我没有只按报上来的那条修。
2. **成因一句话**：那个判据问的是「**地址一样吗**」，而该问的是「**这个地址归谁管**」。
3. **"什么时候前缀、什么时候精确"的答案不在"有没有查询串"，在"这个查询串是不是某个导航目标本身的一部分"**：
   - **带查询串的条目 = 集合的「筛选视图」**（`/notes?starred=1`）→ **只在地址完全相同时亮**。筛选**不向下延伸到成员**：那条笔记加没加星不一定，用户也可能从「全部笔记」点进去。
   - **不带查询串的条目 = 「区域」**（`/settings`、`/models`、`/notes`）→ **前缀匹配（按段边界）**。`/settings/*` 要的正是这个，没被改掉。
   - **不属于任何导航目标的查询串 = 页内视图状态**（`?tab=llm`、`?tab=mindmap`）→ **一律不参与判定**。这就是 `/models?tab=llm` 那盏灯的修法。
4. **结构上的改动，不只是换判据**：规则挪进纯函数 `lib/nav/activeNav.ts`，它返回**哪一个**该亮，而不是逐项判**是不是**。因为真正要守的性质是「**至多一项高亮**」—— 逐项独立判断时**没有任何地方在管这条性质**，全对只是巧合，而上面那张表说明巧合会破。返回单个 target 之后它由类型保证。
5. **侧栏条目改成数据驱动**：`collectionNav` / `systemNav` 两个数组既用来渲染、也用来算高亮。**清单与链接不可能再漂移** —— 否则新加一个 `SideLink` 忘了登记，那条链接会永远不高亮且什么都不报。
6. **顺带查出并修掉一个看不见的同源缺陷**：`NavLink` 会**自己**按 `isActive` 写 `aria-current="page"`，外面传的 `aria-current` 只能改取值、**关不掉**。也就是说这个 bug **在无障碍层也存在**：`[实测]` `/notes` 与 `/notes/<uid>` 上两项都被标成"当前页"，读屏用户听到"你同时在两个地方"。视觉上的双高亮至少能被看见并报上来，**这一条谁都看不见**。既然已经不用它的 `isActive`，`SideLink` 换成 `Link` 一并解决。
7. **反向验证 3 组，全部贴真实红灯**（§B）。RV-9 把两个症状**逐字复现**了出来。
8. **真浏览器复验 11 个地址全绿**（§C）：视觉高亮与 `aria-current` 逐个地址完全一致，且恒为 1 项。
9. **门禁**：`tsc -b` 0 · `eslint .` 全仓 0 · **614 passed / 0 failed**（db 47 / pipeline 132 / daemon 196 / web 单测 48 + 宿主 10 + 组件 181）。本节新增 14 条（单测 9 + 组件 5）。
10. **一条不是我的、但已被实测量化的同源缺陷**：`FolderTree` 也用 `NavLink` + 裸 `isActive`（`to={/notes?folder=<uid>}`），于是**每个文件夹在任意 `/notes*` 地址上都被标成"当前页"** —— 包括 `/notes?starred=1` 这种一个文件夹都没选中的地方。归 `folders`/`architect`，**我只报不动**，详见 §D。

---

## §A 改法

**新增 `apps/web/src/lib/nav/activeNav.ts`**（纯函数，进 CJS 单测通道）：

```
activeNavTarget(targets, {pathname, search}) -> to | undefined
  ① 地址完全命中（pathname 相同 且 查询串归一化后相同）→ 就是它     ← 筛选视图只认这一种
  ② 否则：管辖范围覆盖当前 pathname 的、路径最长的那个「不带查询串」的条目
  ③ 都没有 → undefined（例如 /capture —— 它是侧栏顶部那个按钮，不是 SideLink）
```

两处细节写了理由：
- **段边界前缀**（`/notes` 管 `/notes/x`，不管 `/notesomething`）—— 裸 `startsWith` 会算进去。
- **取最长而不是取第一个** —— 将来若同时有 `/settings` 与 `/settings/advanced`，写"第一个匹配"就变成一条**只有改了数组顺序才会坏、且坏了不报错**的规则。有用例把数组反过来跑一遍。
- 查询串**归一化后**比较（`?a=1&b=2` 与 `?b=2&a=1` 是同一个地址）。

**`App.tsx`**：条目变数据 → 一次算出 `activeNav` → `SideLink` 只收 `active: boolean`，自己不再判断；`NavLink` → `Link`（理由见 TL;DR 6）。

---

## §B 反向验证（3 组，真实输出）

**RV-9 退回「逐项各判各的」（把 `App.tsx:203-204` 的原判据原样搬回来）**
```
✖ ★ 笔记详情页只高亮「全部笔记」（此前它和「星标」同时亮）
  AssertionError: 详情页上的侧栏高亮不对（实际：["全部笔记","星标"]）。
  两项一起亮 = 判定交回了 NavLink 的前缀匹配；一项都不亮 = 判定把 ?tab= 当成了导航的一部分
✖ ★ /models?tab=llm 上「模型」不许自己灭掉
  AssertionError: 页内 Tab 状态把区域的灯弄灭了 —— 用户切个 Tab 就不知道自己在哪一页了
✖ ★ 穷举：真实地址上侧栏高亮数永远 ≤ 1
  AssertionError: /notes/01KZ1H8YABCDEFGHJKMNPQRST 上有 2 项同时高亮：["全部笔记","星标"]
ℹ tests 181  ℹ pass 178  ℹ fail 3
```
> **两个症状被逐字复现**，包括你截图里那条。

**RV-10 `Link` 换回 `NavLink`**（证明第 6 条那个换法是**承重的**，不是顺手改风格）
```
✖ ★ 笔记详情页只高亮「全部笔记」 —— AssertionError: 实际：["全部笔记","星标"]
✖ ★ 「星标」页只高亮「星标」
✖ ★ 穷举：真实地址上侧栏高亮数永远 ≤ 1
ℹ tests 181  ℹ pass 178  ℹ fail 3
```
> 视觉高亮此时是**对的**（`active` 属性还在起作用），红的是 `aria-current` —— `NavLink` 按自己的前缀匹配又把「星标」标成了当前页。**这正是那条看不见的缺陷。**

**RV-11 让「筛选视图」也参与区域前缀匹配**（纯规则层）
```
✖ ★ 详情页只亮「全部笔记」—— 它是 /notes 的子路径，不属于「星标」这个筛选视图
✖ ★ 页内视图状态（?tab=）不许把区域的灯弄灭
ℹ tests 48  ℹ pass 46  ℹ fail 2
```

三组还原后复跑全绿。

**为什么纯函数那 9 条不够、必须再有 5 条组件用例**：纯函数证明的是**规则对**，组件用例证明的是**规则被接上了**。上一版的缺陷恰恰不是规则写错，而是判定散在每个 `SideLink` 里没人管"至多一项"。RV-9 把 `App.tsx` 改回逐项判断时，**纯函数那 9 条照样全绿** —— 只有组件那 5 条会红。

判据用 `aria-current="page"` 而不是 `bg-accent-tint`：前者既是无障碍语义，也不会因为换主题就得改测试 —— "高亮"这件事跟具体是哪个色号无关。

---

## §C 真浏览器复验（自建 daemon `:17942` + 临时 dataDir + `vite dev :5207`）

侧栏一级导航（`nav` 的直接子链接），11 个地址逐个数灯 —— **视觉高亮与 `aria-current` 完全一致，且恒为 1 项**：

```
✅ /notes                             高亮=["All notes"]  aria-current=["All notes"]
✅ /notes?starred=1                   高亮=["Starred"]    aria-current=["Starred"]
✅ /notes/01KZ43C3VD…                 高亮=["All notes"]  aria-current=["All notes"]   ← 报上来的那条
✅ /notes/01KZ43C3VD…?tab=mindmap     高亮=["All notes"]  aria-current=["All notes"]
✅ /notes/01KZ43C3VD…/mindmap         高亮=["All notes"]  aria-current=["All notes"]
✅ /record /runtime /models /tasks    各自 1 项
✅ /models?tab=llm                    高亮=["Models"]     aria-current=["Models"]      ← 修前是 0 项
✅ /settings/storage                  高亮=["Settings"]   aria-current=["Settings"]    ← 前缀语义没被改掉
```
截图：`/tmp/wire-up/shots/6-sidebar-detail.png`

---

## §D 不是我的，但已实测量化：`FolderTree` 同源

`features/folders/FolderTree.tsx:105-108` 用 `NavLink to={/notes?folder=<uid>}` + 裸 `isActive` ——
`isActive` 只比 pathname，于是**任意 `/notes*` 地址上每个文件夹都被标成"当前页"**：

```
/notes                      文件夹链接 1 条，其中被标成"当前页" 1 条
/notes?starred=1            文件夹链接 1 条，其中被标成"当前页" 1 条     ← 一个文件夹都没选中
/notes/01KZ43C3VD…          文件夹链接 1 条，其中被标成"当前页" 1 条
```

与侧栏那条**同一个根因**（`isActive` 表达不了筛选视图）。视觉上它只改 `text-ink`/`text-ink-secondary`，
不如侧栏刺眼，但 `aria-current` 那一面是实打实错的。

修法就是复用本轮的公共件：文件夹链接属于「筛选视图」那一类，
`activeNavTarget([to], location) === to`（或直接 `Link` + 精确比对）。**一行的事。**

**我没有动它** —— 那是 `folders`/`architect` 的地界，且你这次只点了侧栏那条。请裁决派给谁。

---

## §E 本节改动清单（**请勿 `git add -A`**）

```
git add apps/web/src/App.tsx \
        apps/web/src/lib/nav/activeNav.ts \
        apps/web/src/lib/nav/activeNav.test.ts \
        apps/web/src/test/components.test.tsx \
        apps/web/tsconfig.test.json \
        coordination/inbox/wire-up.md
```
（前一节 T-138 的清单见 §6；`apps/daemon/src/db/repos.ts` 已被 `a33fe31` 带走，`fda3e66` 之后不必再加。）

---

## §F 收尾与诚实声明

- 起过的进程：daemon `--port 17942 --data-dir /tmp/wire-up/data`、`vite dev :5207`。**按 pid 逐个 `kill`，未用 `pkill -f`**；两个端口收尾 `curl` 均为 `000`。
- `:10000` 只读（收尾一次 `GET /api/health` → 200）；`/root/data-memo` 零写入；`~/.local/share/openmemo/datadir.json` 仍是 `{"dataDir":"/root/data-memo","updatedAt":"2026-08-03T14:15:00.000Z"}`，`cat` 核对过。
- ⚠️ **`apps/web/dist/index.html` 的 mtime 从 22:09 变成了 23:32**（我进场时是 22:09）。**不是我**：我这轮跑过的只有 `tsc -b`（web 是 `emitDeclarationOnly`）、`vite dev`（不写 dist）、`test:components`（package.json 里自带 `--outDir .test-out/components`）。时间点与你提交 `fda3e66` / 用真 key 复验那一段吻合，**但我只给事实，不替你确认**。
- 未跑本地 whisper。未 commit。未派生 subagent。
- **诚实声明**：§B 三段红灯是实际输出复制的。`/models?tab=llm` 那条**不是你报的**，是我按"别只为详情页打补丁"去枚举地址时撞出来的 —— 它在 `fda3e66` 之前就已经坏着，不是本轮引入的。§D 那条我**只测量、没修**。

---

## [2026-08-04 00:00] T-138c DONE —— FolderTree 同源修复

### TL;DR（≤25 行）

1. **`FolderTree.tsx:105` 已修**，判据原样搬过来：**筛选不向成员延伸**。文件夹是筛选视图，和「星标」同类 —— 只在**地址完全相同**时才是当前页。`NavLink` → `Link`（后者会自己按 `isActive` 写 `aria-current`，外面关不掉，T-138b 在侧栏踩过同一脚）。
2. **⚠️ 修完之后我发现一件必须先说的事：这个链接的目的地是空的。** `[实测]` 点开「课程」（**0 条笔记**）→ 地址变成 `/notes?folder=<uid>` → 页面**照常列出全部 2 条**，发出的请求仍是裸 `/api/notes`。`?folder=` 在**全仓无人读取**：`NotesListPage`、`features/notes/api.ts`、daemon 的 `GET /api/notes` 三处都没有。详见 §D。
3. **这件事让我的修复变得更需要被说清楚，而不是更好**：修之前所有文件夹**永远**高亮 —— 是噪音，用户学会无视；修之后**恰好一个**高亮且与 URL 一致 —— 用户会信它。**同一句谎话变得更可信了。** 我没有为了让截图好看而不提这一点。
4. **判定要跨组件才成立，所以多了一个显式声明**：`/notes?folder=<uid>` 上，一级导航的 `/notes` 会按「区域」赢下前缀匹配 → 「全部笔记」和那个文件夹**同时**自称当前页，正是 T-138b 刚修掉的形状、只是跨了两个组件所以更难看见。修法是 `NAV_FILTER_KEYS = ['starred','folder']`：**代表兄弟筛选视图的查询串键名**。
5. **为什么 `folder` 必须显式声明而 `starred` 不用**：`starred` 从侧栏清单里就看得出来（`/notes?starred=1` 明摆着）；**文件夹是动态的**，`to` 不可能出现在静态清单里，"folder 这个键代表一个筛选视图"就成了清单**看不出来**的那部分 —— 只能说出来。声明**键名**而不是地址：键名稳定，uid 不稳定。
6. **`NAV_FILTER_KEYS` 放在 `lib/nav/`，两个组件共用同一份**。各写一份的话，谁多一个键少一个键都不报错，只会让某个地址上高亮 0 项或 2 项 —— 而"至多一项"正是这个模块存在的全部理由。
7. **`tab` 被显式挡在这张表外面，并有专门一条用例钉住**：写进去就会让 `/models?tab=llm` 退回「一项都不亮」。你说得对，那个哑的比吵的活得久，所以我给它留了一条**会说话的**护栏。
8. **反向验证 2 组，真实红灯**（§B）。RV-12 逐字复现了你给的那组数据：`/notes` 上整条侧栏 `["全部笔记","课程2","播客1"]`。
9. **真浏览器 7 个地址全绿**（§C，真 daemon + 真建的两个文件夹）：**整条侧栏**（一级导航 + 文件夹树）恒为 1 项当前页。
10. **门禁**：`tsc -b` 0 · `eslint .` 全仓 0 · **621 passed / 0 failed**（db 47 / pipeline 132 / daemon 196 / web 单测 51 + 宿主 10 + 组件 185）。本节新增 7 条（单测 3 + 组件 4）。

---

## §A 改了什么

| 文件 | 改动 |
|---|---|
| `lib/nav/activeNav.ts` | 新增导出 `NAV_FILTER_KEYS`；`activeNavTarget` 加第三参 `filterKeys` —— 当前查询串里出现这些键时，「区域」不再赢下前缀匹配（该亮的是某个筛选视图，可能不在这张清单上） |
| `App.tsx` | 调用处传 `NAV_FILTER_KEYS` |
| `features/folders/FolderTree.tsx` | `NavLink` + 裸 `isActive` → `Link` + `activeNavTarget([to], location, NAV_FILTER_KEYS) === to`；抽出 `folderTo(uid)`，**地址只在一处拼**，判定与渲染共用同一个字符串 |

判据仍然是那条：**`?tab=` 这种页内视图状态不许进 `NAV_FILTER_KEYS`**，否则就退回「一项都不亮」。

---

## §B 反向验证（2 组，真实输出）

**RV-12 `FolderTree` 退回 `NavLink` + 裸 `isActive`**
```
✖ ★ 文件夹不许在"没选中任何文件夹"的地址上自称当前页
  AssertionError: /notes 上文件夹自称当前页了（整条侧栏：["全部笔记","课程2","播客1"]）
  —— NavLink 的 isActive 只比 pathname，所有文件夹的 pathname 都是 /notes
✖ ★ 选中某个文件夹时：只有它一个当前页，一级导航要让位
  AssertionError: 整条侧栏高亮了 2 项：["课程2","播客1"]
✖ ★ 兄弟文件夹不许跟着一起亮
✖ ★ 穷举：真实地址上**整条侧栏**高亮数永远 ≤ 1（含文件夹树）
ℹ tests 185  ℹ pass 181  ℹ fail 4
```
> 第一条的实际输出**与你给的测量数据同形**（每个文件夹在每个 `/notes*` 上都自称当前页）。

**RV-13 不声明 `folder` 是筛选视图**（`NAV_FILTER_KEYS` 去掉 `folder`）
```
✖ ★ 选中某个文件夹时：只有它一个当前页，一级导航要让位
  AssertionError: 整条侧栏高亮了 2 项：["全部笔记","课程2"]
✖ ★ 穷举：真实地址上**整条侧栏**高亮数永远 ≤ 1（含文件夹树）
  AssertionError: /notes?folder=01FOLDER… 上整条侧栏有 2 项自称当前页：["全部笔记","课程2"]
ℹ tests 185  ℹ pass 183  ℹ fail 2
```
> 这一组证明第 4/5 条那个显式声明是**承重的**：少了它，跨组件的双当前页立刻回来。
> 单测那边还有一条配套的正例，断言"**不传** filterKeys 时就是旧行为"—— 免得这条护栏钉的是零。

两组还原后复跑全绿。

---

## §C 真浏览器（自建 daemon `:17942` + 临时 dataDir + 真建的两个文件夹 + `vite dev :5207`）

数的是**整条 `nav` 里**的 `aria-current="page"`（一级导航 + 文件夹树一起数）：

```
✅ /notes                                当前页 1 项 ["All notes"]
✅ /notes?starred=1                      当前页 1 项 ["Starred"]
✅ /notes?folder=01KZ45RF73…             当前页 1 项 ["课程"]        ← 修前：3 项
✅ /notes/01KZ43C3VD…                    当前页 1 项 ["All notes"]   ← 修前：3 项
✅ /notes/01KZ43C3VD…?tab=mindmap        当前页 1 项 ["All notes"]
✅ /models?tab=llm                       当前页 1 项 ["Models"]
✅ /settings/storage                     当前页 1 项 ["Settings"]
```
截图：`/tmp/wire-up/shots/7-folder-current.png`

---

## §D ⚠️ 必须报的：这个链接的目的地是空的（`?folder=` 全仓无人读取）

`[实测]`（真浏览器 + 真 daemon，「课程」文件夹里**一条笔记都没有**）：

```
/notes                              列出 2 条笔记   发出的请求=["/api/notes"]
/notes?folder=01KZ45RF739B8SBW…     列出 2 条笔记   发出的请求=["/api/notes"]
```

三处都没有读它：`features/notes/NotesListPage.tsx`（只读 `starred`）、
`features/notes/api.ts`（`useNotesQuery` 只发 `?starred=1`）、
`apps/daemon/src/http/rest/notes.ts` 的 `GET /api/notes`（只认 `limit` 与 `starred`）。

**为什么这条必须现在说，而不是等下一轮：**

修之前，所有文件夹**永远**高亮 —— 那是噪音，用户学会无视，"点了没反应"也就不显得奇怪。
修之后，**恰好一个**高亮、且与地址一致 —— 用户会**相信**它。
于是界面开始用一种可信的口气说「你在『课程』里」，同时列出全部笔记。
**我把一句谎话变得更可信了。** 这正是本项目"假绿灯"那一族的形状，
所以我不能只交一张好看的截图。

**我没有顺手把它做掉**，理由不是范围洁癖，是**它不是一行、而且有一个真的产品决策**：
`folders` 是自引用树（`FolderTree` 自己就在渲染 `node.children`），
所以「点『课程』要不要连子文件夹里的笔记一起列」**必须有人拍板** ——
选错了会得到一个"看起来能用、数字却一直对不上"的筛选。
代码那一半与我这轮做的 `?starred=1` 几乎同型（`repos.listNotes` 加一个条件 + 端点收参 + 前端带上），
成本很小；**要拍的是语义，不是代码。**

**建议**：`GET /api/notes?folder=<uid>`，并在裁决时明确「含不含后代」。
在它落地之前，可以考虑先把文件夹链接改成不可点（或标注"即将支持"）——
**一个诚实的灰色链接，好过一个自信的错误高亮。** 这条也请你裁决，我没有擅自改。

---

## §E 本节改动清单（**请勿 `git add -A`**）

```
git add apps/web/src/App.tsx \
        apps/web/src/lib/nav/activeNav.ts \
        apps/web/src/lib/nav/activeNav.test.ts \
        apps/web/src/features/folders/FolderTree.tsx \
        apps/web/src/test/components.test.tsx \
        coordination/inbox/wire-up.md
```

---

## §F 收尾与诚实声明

- 起过的进程：daemon `--port 17942 --data-dir /tmp/wire-up/data`、`vite dev :5207`。**按 pid 逐个 `kill`，未用 `pkill -f`**；两端口收尾 `curl` 均 `000`。
- 我在**自己的临时库**上建了两个文件夹（`POST /api/folders` ×2）用于复验 —— `/root/data-memo` 零写入，`:10000` 只读（收尾一次 `GET /api/health` → 200）。
- `~/.local/share/openmemo/datadir.json` 仍是 `{"dataDir":"/root/data-memo","updatedAt":"2026-08-03T14:15:00.000Z"}`。
- `apps/web/dist/index.html` mtime 现为 `08-03 23:53`（你重启前重建的那次）；**我这轮没跑过任何写 dist 的命令**。
- 未跑本地 whisper。未 commit。未派生 subagent。
- **诚实声明**：§D 那条**不是被要求的范围**，是我修完之后自己去点了一下才发现的；我把它写在 TL;DR 第 2、3 条而不是埋在末尾，因为它直接影响该怎么看待本节这个"修好了"。§B 两段红灯是实际输出复制的。

---

## [2026-08-04 00:35] T-138④ DONE —— `?folder=` 真的筛，且计数与筛选同源

### TL;DR（≤25 行）

1. **端点做了，语义按裁决含子孙**：`GET /api/notes?folder=<uid>`，递归用 **SQL 递归 CTE**（`FOLDER_CLOSURE_CTE`），不在 Node 里拉全表 —— 那会让 `limit` 又一次形同虚设。**过滤发生在 `limit` 之前**（同 `?starred=1` 那条判据），认不出的 uid **400**。
2. **不变量②按你的要求钉住了**：`FOLDER_CLOSURE_CTE` 是「一个文件夹包含哪些笔记」的**唯一定义**，侧栏计数（`folderNoteCounts`）与筛选（`listNotes`）**都从它来**。⚠️ 修之前 `folderNoteCounts` 是**只数直属**的 —— 也就是说，如果我只加端点不动它，交付的第一天就是"侧栏写 1、点进去 3"。
3. **那条测试写了，并且真的会红**：父 1 + 子 2，断言 **侧栏计数 == 筛选返回条数 == 3**。RV-14 把计数改回只数直属 → `AssertionError: 侧栏计数(1) 与筛选返回条数(3) 不一致`（§B）。遮住名字问"它什么时候失败"，答案就是这一句。
4. **前端接上了**：`useNotesQuery({folderUid})`、`NotesListPage` 读 `?folder=`。查询串与 queryKey **从同一个对象拼**，否则缓存键与实际请求会在某个组合上错开，表现是"切了筛选内容没变"。
5. **标题与空态也跟着走**：在文件夹里顶着「全部笔记」是同一种谎、只换了位置。文件夹名还没拉回来时退到「文件夹」而不是「全部笔记」——**宁可笼统，不可说错**。
6. **「含子孙」在界面上说出来了**（`folderEmptyHint`：「这里会连子文件夹里的笔记一起显示」），并有一条用例钉住中英两份都得交代 —— 不让用户自己猜为什么父级里冒出子级的笔记。
7. **反向验证 2 组，真实红灯**（§B）：RV-14 计数与筛选分叉、RV-15 前端不发 `?folder=`（4 条红，逐字复现"高亮准了、内容还是全部"那个状态）。
8. **我又踩了一次自己的老坑，写出来**：空态断言原本写的是"页面里不许出现『还没有笔记』"，而 `notes.empty` = 「还没有笔记」**恰好是** `notes.folderEmpty` = 「『X』里还没有笔记」的子串 —— 被自己的文案匹到。改成**钉标题整句**。这是本任务内第三次同族（前两次：`/activeJobId/` 匹到注释、T-129b 的 `/\bEmphasis\b/`）。**钉整句、钉结构，别钉关键词。**
9. **门禁**：`tsc -b` 0 · `eslint`（我的全部范围）0 · **641 passed / 0 failed**（db 47 / pipeline 132 / daemon 199 / web 单测 63 + 宿主 10 + 组件 190）。本轮我新增 **8 条**（daemon 3 + 组件 5）。
10. **两件不是我的、但会影响你读门禁数字的事**，证据在 §D：`T-142` 的新守卫 `scripts/check-test-scripts.mjs` 目前**只接了 1 个包**，它的自检因此失败并**把 `packages/db` 的 test 整条带挂**（db 直接跑是 47/47）；同一文件还有 1 条 `no-irregular-whitespace` 让**全仓 `eslint .` 变红**。另外 `remediation` 的 `RuntimePage.tsx` 半保存状态一度让我的组件测试报 `ReferenceError: Link is not defined`，他们保存完就自愈了。

---

## §A 改法

**daemon**
- `db/repos.ts`：新增模块级 `FOLDER_CLOSURE_CTE`（`anc` 祖先含自身 → `node` 管辖的每个文件夹）。
  `UNION` 而非 `UNION ALL`：脏环也会停下来（沿用 `folderSubtreeIds` 注释里那条理由）；已软删的文件夹不进闭包。
  `folderNoteCounts()` 改为**含子孙**并走这份 CTE；`listNotes(limit, {starredOnly, folderId})` 也走它。
  只有真要按文件夹筛时才挂 CTE —— 别的查询不该为一个用不上的递归付钱。
- `http/rest/notes.ts`：解析 `?folder=`，查不到 / 已软删 → `400 BAD_QUERY_PARAM`。

**web**
- `features/notes/api.ts`：`useNotesQuery({starredOnly, folderUid})`，查询串与 queryKey 同源。
- `features/notes/NotesListPage.tsx`：读 `?folder=`；标题用文件夹名；空文件夹给专属空态。
- `features/folders/api.ts`：新增 `flattenFolders()`（树 → 扁平，带防环），从 barrel 导出。
  放在 folders 这一侧而不是让调用方自己递归 `children` —— 别处各写一次就多一处会忘记防环的地方。
- `lib/api/mock.ts`：同样认 `folder`；**并写明 mock 的文件夹是平的、不含子孙**，免得被下一个人当成契约。

---

## §B 反向验证（2 组，真实输出）

**RV-14 侧栏计数退回"只数直属"，筛选仍含子孙**（先 `grep` 确认 dist 里坏行在）
```
✖ ★ 侧栏计数 == 筛选返回条数（父 1 + 子 2 = 3）—— 两边分叉就红
  AssertionError: 侧栏计数(1) 与筛选返回条数(3) 不一致 —— 两处各算各的，
  于是侧栏写一个数、点进去是另一个数，而且没有任何一处会报错
  1 !== 3
```
> 这正是你要的那条：**两边分叉时它变红**。而且注意红的是"相等"这条断言，
> 不是"筛出来的都在这个文件夹里" —— 后者在分叉时照样绿。

**RV-15 前端不再把 `folder` 交给端点**
```
✖ ★ 点开文件夹要把 folder 交给端点 —— 此前这个查询串全仓无人读取
  AssertionError: 筛选没交给端点（实际请求：["/notes","/folders","/jobs"]）——
  点开一个空文件夹会照常列出全部笔记，而侧栏高亮却言之凿凿地说你在这个文件夹里
✖ ★ 标题要跟着走 —— 在文件夹里却顶着「全部笔记」是同一种谎，只换了位置
✖ ★ 文件夹名还没拉回来时退到「文件夹」，而不是说「全部笔记」
✖ ★ 空文件夹给它自己的空态（而不是"还没有笔记"）
ℹ tests 190  ℹ pass 186  ℹ fail 4
```
> 第一条的 `实际请求` 把 T-138c 之后那个状态**逐字复现**了出来：高亮是准的，内容是全部。

两组还原后复跑全绿。

---

## §C 我第三次踩同一族坑（写出来，不掩盖）

空态那条用例第一版是：
```ts
assert.equal(txt.includes(zhNotes['empty']), false, '不该说"还没有笔记"');
```
它**红了，但红得没道理** —— `notes.empty` = 「还没有笔记」恰好是我新写的
`notes.folderEmpty` = 「『课程』里还没有笔记」的**子串**，于是断言被自己的文案匹到。

前两次同族：本任务 ② 的 `/activeJobId/` 匹到自己旁边的注释；T-129b 的 `/\bEmphasis\b/` 同理。
**三次的成因都是"钉关键词"**。改成钉**标题那一整句**（`querySelector('h2').textContent === '「课程」里还没有笔记'`）之后就没有这个面了。

> 这次它表现为**假红**而不是假绿，所以我很快发现了。
> 但成因与假绿完全相同 —— 只是这次运气好，站错了边。

---

## §D 不是我的，但会影响你读门禁（附证据）

1. **`scripts/check-test-scripts.mjs`（`T-142` 在途，未跟踪，00:24 落盘）把 `packages/db` 的 test 整条带挂**：
   ```
   ✘ check-test-scripts:
     本守卫只剩 1 个接线点了 —— 它是靠"挂在多个包的 test 脚本上"活着的（见文件头）。
     少于 2 个接线点意味着再删一处它就彻底消失且无声。
   ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @openmemo/db test
   ```
   目前只接了 `packages/db` 一个包，于是它的**自检**失败 → `&&` 短路 → db 的 47 条一条都没跑。
   `[实测]` 绕过守卫直接 `node --test` → **47/47 全绿**。**db 本身没坏**，等他们把其余包接完就自愈。
   （顺带说一句：这个守卫的设计我认同 —— 它守的正是"接线点被删光后自己无声消失"。只是安装过程中间态会红。）
2. **同一文件 1 条 lint 错误让全仓 `eslint .` 变红**：`scripts/check-test-scripts.mjs:10:41 no-irregular-whitespace`。
   我自己的全部范围（`apps/web/src`、`apps/daemon/src`、`packages`）单独跑 **rc=0**。
3. **`remediation` 的 `RuntimePage.tsx` 半保存状态**一度让我的组件测试报
   `ReferenceError: Link is not defined`（`<Link>` 已用、`import` 还没落盘）。
   我**没有去改他们的文件**，等了一轮重新构建就绿了 ——
   记在这里是因为它正好演示了那条纪律：**反向验证前要确认你跑的是刚改过的那份产物**；
   这次不是我的产物旧，是别人的源码正处在两次保存之间。

---

## §E 本节改动清单（**请勿 `git add -A`**）

```
git add apps/daemon/src/db/repos.ts \
        apps/daemon/src/http/rest/notes.ts \
        apps/daemon/src/http/notesRest.test.ts \
        apps/web/src/features/notes/api.ts \
        apps/web/src/features/notes/NotesListPage.tsx \
        apps/web/src/features/folders/api.ts \
        apps/web/src/features/folders/index.ts \
        apps/web/src/lib/api/mock.ts \
        apps/web/src/app/i18n/locales/zh-CN.json \
        apps/web/src/app/i18n/locales/en.json \
        apps/web/src/test/components.test.tsx \
        coordination/inbox/wire-up.md
```

⚠️ **`apps/web/tsconfig.test.json` 本轮不是我改的**（`remediation` 往里加了
`lib/remediation/routes.test.ts` 两行）—— 前几轮我加过 nav/jobs/notesCache 那几行，**这轮没有**。
⚠️ **申报重叠**：`NotesListPage.tsx` 你说 `notes-contract` 正在改附近的笔记契约
（`state`/`bodyJson`/波形）。我这轮只动了**顶部的查询串读取、标题、空态**三处，
没碰列表项的字段渲染；`lib/api/client.ts`、`ErrorBlock.tsx`、`JobToaster.tsx`、`RemediationButton.tsx`、
`RuntimePage.tsx`、`vendor/**`、`.github/**` **一个都没碰**。

---

## §F 收尾与诚实声明

- **本轮没起任何进程**（纯代码 + 测试；上一轮的 daemon/vite 已按 pid kill、端口确认释放）。
- `:10000` 未访问；`/root/data-memo` 零写入；`~/.local/share/openmemo/datadir.json` 未碰。
- `apps/web/dist` 未构建；验证构建走 `pnpm build:safe` / `pnpm --filter @openmemo/daemon build`。
- 未跑本地 whisper。未 commit。未派生 subagent。
- **诚实声明**：
  - §B 两段红灯是实际输出复制的；§C 那次假红我如实写了，没有改完再贴。
  - **`?folder=` 我只在测试与组件层验过，本轮没起真浏览器**（上一轮起过，验的是高亮那一半）。
    daemon 侧是真 daemon + 真 HTTP + 真 SQLite 的端到端，前端侧是组件测试 —— **两者之间那一跳没有在真浏览器里连起来跑过**，如实标注。
  - 本轮**新增 8 条**（daemon 3 + 组件 5），单测 0 条；web 单测从 51 涨到 63 **是 `remediation` 的**，不是我的。
