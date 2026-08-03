# inbox / notes-contract

## [2026-08-04 01:00] T-139 DONE —— 笔记详情契约断链

### TL;DR（≤25 行，Manager 只读这里）

1. **A1 / A1b / A3 三条全部复现并修好，四条都在真浏览器里验过产品真实路径**（playwright chromium → vite dev `:5231` → 代理 → 我自建的真 daemon `:17971` → 真 SQLite → 真 SSE）。
   - **A1**（`assets[].state` 缺失）修前 `<audio> 在 DOM 里: false`，修后 `true` + 真 src。
   - **A1b**（`bodyJson` 缺失）修前"打字→保存→刷新 = 空"，修后刷新仍在。**用户的正文此前正在无声丢失，这条是四条里最贵的。**
   - **A3**（编造波形）修前波形画了 **11000** 个非空像素而后端零处产 peaks；修后无真 peaks 时 **1912**（只剩基线+游标），有真 `.ompk` 时 **20948**（真的 fetch + decode 出来的）。
2. **🔴 C10 的判断是错的，我有实测反证 —— 但症状是真的，根因在别处，已修。**
   `mindmap.done` 确实无订阅者，**但那不是原因**：daemon 落库时**同时**发 `note.updated{changed:['mindmap']}`，`notesSse` 一直订阅着它并 invalidate `qk.mindmap` —— 浏览器网络日志里那次 `GET /notes/:uid/mindmap` **真的发生了、拿到了新 revision**。断的是**渲染器**：`MindmapView` 只在 `doc.uid` 变化时重建，而 `doc.uid` 是**笔记的 uid**，同一条笔记里永远不变 → **数据换了、图没换**。这解释了"rev 3、生成成功、页面不更新"。→ 不补 `mindmapSse`（会造出第二个触发源且覆盖不到 PATCH 路径），改用**内容签名**就地 `refresh()`。
3. **A1/A1b「同一根因」成立，但盘点那句"共享契约已落地、切过去就好"不成立** —— `packages/shared` 的 `NoteAsset` **也没有 `state`**、`NoteDetail` **也没有 `bodyJson`**。切过去不会自动修好，只会让 `NoteDetailPage` 编译报错（那也是好事）。详见 §根因。
4. **反向验证 6 组，全部贴了真实红灯输出**（§RV）。含把整个 `GET /api/notes/:uid` 改成 `throw` 的变异：**我的 8 条里 7 条红**（E1 那个洞被堵上了）。
5. **门禁**：`tsc -b` 0 · `eslint .` 0 · **`pnpm -r test` 842 passed / 0 failed**（基线 641；+201 里**我贡献 28**，其余是并行的三路）。
6. **🔴 需要 Manager：我的一处改动被扫进了别人的提交**（`8ecac4f` T-138④ 含 `repos.ts` 的 `body_json` 那 11 行，是我的 T-139）。⑤J 第六例，形式与前五例相同。历史改不了，记在案。
7. **重叠**：`test-gaps` 独立地给同一个端点写了 `http/rest/noteDetail.test.ts`。两份都留着，我不动别人的交付物；合并建议写在我那个测试文件的头部。
8. **未做（明知而未做，不是漏了）**：daemon 侧**不产 peaks** —— 我只拆掉了假的、接通了真的那条路径。要真波形得让 daemon 用 ffmpeg 预生成 `.ompk`，那是 pipeline/daemon 的 M 级改动，见 §A3 的取舍与建议。

---

## 纪律声明（逐条）

- **`apps/web/dist` 一次都没构建**：mtime 仍是 `2026-08-03 23:53:32`（非我）。验证构建全走 `pnpm build:safe`；web 的三条测试分别写 `.test-out/{unit,host,components}`。
- **`:10000` 只读**：全程只发过 **1 次** `GET /api/health`（收尾确认它还活着）。没重启、没 kill、没占用该端口。
- **`~/.local/share/openmemo/datadir.json` 未被我改动**：开工时 `md5sum` 存档，收尾 `md5sum -c` → `OK`，内容仍是 `/root/data-memo` / `updatedAt 2026-08-03T14:15:00.000Z`。
  ⚠️ 顺带一条观察：开工时该文件的 **mtime 是 00:05:36**（内容不变）。我核实过 daemon 启动路径**只读不写**指针（`config/paths.ts` 里 `writeDataDirPointer` 唯一调用方是 `rest/storage.ts`），所以不是我；最可能是并行某路跑了 `restart-datadir.test.ts`（它备份→还原，会刷新 mtime）。**内容是对的**，按 PROTOCOL §9 报备。
- **`/root/data-memo`**：零读零写。**唯一的例外要说清楚** —— 收尾时我执行过一次 `ls /root/data-memo >/dev/null`（只判断目录还在，输出丢弃，没有进入、没有读任何文件）。事后看这一条本可以不做。
- **没有跑本地 whisper 转写**。C10 的 LLM 用**我自己的假 OpenAI 兼容服务器**顶替厂商（`/tmp/notes-contract/fake-llm.mjs`），**我没有、也不会去读用户的 DeepSeek key**；除了"厂商是假的"，其余全是产品真实路径（真 daemon、真 job queue、真 `resolveConfiguredProvider` 的 openai-compatible 分支、真 HTTP）。settings/secrets 只写进**我自己的临时 dataDir** `/tmp/notes-contract/data`。
- **没用 `pkill -f`**：起的三个进程按 pid 逐个 kill（daemon 3240299、fake-llm 3234987、vite 3232446），`ss -ltnp` 确认 `17971 / 17972 / 5231` 全部释放。中途换过一次 daemon 实例，也是按 `ss` 查出的 pid 精确 kill。
- **未 commit、未 `git add`**。精确清单见 §交付。
- **未派生 subagent。**

---

## §根因：A1 与 A1b 是不是同一个？——**是，但盘点的处方不对**

**同一个根因**：`apps/web/src/lib/api/types.ts` 是一份**手抄的镜像**（文件头自己写着），与 daemon 的实际输出之间**没有任何东西连着** —— 不是断言写松了，是编译器**结构上看不见**这条缝。于是：

| | web 声明 | daemon 实际发 | 结果 |
|---|---|---|---|
| `MediaAssetDto.state` | **必填** | 不发 | `a.state === 'ready'` 恒 false → 播放器无音源 |
| `MediaAssetDto.url` | 没有 | **一直在发** | 前端只好自己再拼一次路径 |
| `NoteDetail.bodyJson` | 必有 | 不发 | 编辑器初值恒空 → 刷新即"丢内容" |

**但盘点的处方「共享的 notes 契约已经落地，没人切过去」——切过去也修不好。** `[实测/读码]`：

```
packages/shared/src/notes.ts:87  NoteAsset  { uid, role, mime, bytes, durationMs, url }   ← 没有 state
packages/shared/src/notes.ts:111 NoteDetail { …14 个键… }                                  ← 没有 bodyJson，也没有 canRetranscribe
```

也就是说 **shared 与 daemon 是一致的，分叉的是 web 那一份**。切到 shared 的真实价值不是"自动补上字段"，而是**`NoteDetailPage.tsx:52` 那行会当场编译不过**（`Property 'state' does not exist on type 'NoteAsset'`）——把一个静默失效变成一个红色的构建错误。**这仍然值得做，但它是 C8 的活，且要先补 shared 的字段，属 `model-mgmt` 独占区，我没碰。** 建议见 §给 Manager。

---

## §A1 `state` —— 修法与取证

**改法**：`rest/notes.ts` 的资产序列化补一个 `state: a.state`（`media_assets.state` 从 `0001_init.sql` 起就在，`NOT NULL` + `CHECK(pending|ready|missing|failed)`）。

**如实标注**：写入方 `createAsset` 一律写 `'ready'`，全仓没有任何一处把它改成别的值 —— **今天它恒等于 `'ready'`**。那为什么还要发？因为它是这条记录**自己的事实**，而前端已经在按它判断；让服务端不发、前端瞎猜，正是这个 bug 的成因。这句话写进了代码注释，不留给下一个人猜。

**前端侧**：判"能不能用"抽成 `features/notes/noteAssets.ts`（纯函数，可单测），并且**`state` 缺失一律按可用处理** —— 判据抄自同一份 DTO 里 `canRetranscribe` 已经立过的规矩：**"字段缺失"绝不能读成"不可用"**，那会对所有旧响应静默藏掉一个本来能用的功能，也正是这次事故的形状。

**真浏览器取证**（同一条笔记，修前/修后）：

```
修前:  A1 <audio> 在 DOM 里: false      A1 <audio src>: null
修后:  A1 <audio> 在 DOM 里: true       A1 <audio src>: /media/asset/01KZ48R2B3EAD6EB0BGWZF29JM
```

---

## §A1b `bodyJson` —— 用户的正文一直在无声丢失

**改法**：GET 补 `bodyJson: parseJsonOrNull(note.body_json)`；`NoteRow` 补上 `body_json` 列（这一列一直在库里、`SELECT *` 一直取得到，只是**不在那个 interface 上**，于是也就没人想起来发）。

**发对象不发字符串**：`NoteEditor` 把它直接喂给 TipTap 的 `content`，那里要的是文档对象；发字符串会变成"一段显示为 JSON 源码的正文"。解析失败回 `null`（与 `parseWords` 同一条约定）。

**修前的实测链**（我自己的 daemon，非用户库）：

```
PATCH /api/notes/<uid> {"bodyJson":{...}}
  → 200 {"uid":"…","title":"…","status":"ready","hasBody":true}     ← 响应甚至说"我有正文了"
SELECT body_json FROM notes                                          ← 真落库，一个字节没少
  '{"type":"doc","content":[…"用户亲手写的一行字"…]}'
GET /api/notes/<uid>  →  bodyJson in GET: false                      ← 15 个顶层键里没有它
```

**真浏览器取证**（TipTap 里真打字 → 等自动保存 → `page.reload()`）：

```
修前:  A1b 保存后编辑器内容: 用户亲手敲进去的一句话
       A1b 刷新后编辑器内容:                       ← 空
修后:  A1b 保存后编辑器内容: 用户亲手敲进去的一句话
       A1b 刷新后编辑器内容: 用户亲手敲进去的一句话
```

---

## §A3 波形 —— 「正确形态」这个问题的答案

盘点问：该由 daemon 产真 peaks，还是老实显示"无波形"？**两件事都要做，但顺序不能反，本轮只做了必须先做的那一半。**

1. **必须立刻做的：把假的拿掉。** 原逻辑是**反的**：
   `有 peaksAsset → setPeaks(null)`（把真数据丢掉，带一条 `TODO(T-021)`）/ `没有 → mockPeaks()`（凭空造）。
   而 daemon 全仓零处产 peaks ⇒ **每一位用户看到的每一条波形都是随机函数画出来的**，界面上一个字都不说 —— 同一段注释还写着"并在 UI 上标注（诚实规则：不许把 mock 说成真数据）"，**那句标注从来不存在**。
   判据用的是 architect 立的那条：**用户看到的每一个具体东西，要么来自后端，要么根本不提。** 一条编出来的波形**不是占位符，它是一个断言** —— 用户会据此判断哪段是安静的、该把游标拖到哪。加个小字标注收不回这个断言，所以是**删**不是"标注"。
   `mockPeaks` **整个函数删掉**（不是留着不用）——与 `MINDMAP_SAVE_SUPPORTED` 当初被整个删掉是同一条理由：留着，下一个人看到空波形就会顺手拿它顶上。有回归用例钉住"这个模块只准导出 `decodeOmpk`"。
2. **顺带接通真的那条路径**：`peaksAsset` 存在时按 daemon 给的 `url` fetch → `decodeOmpk()`。`decodeOmpk` 早就写好了、**一个调用方都没有**，现在它第一次上产品路径，并补了 5 条单测（含"坏数据必须抛，不能尽力解出一点 —— 半份波形和编的波形一样是谎"）。
3. **没有真峰值时长什么样**：`Waveform` 里那个诚实分支（"无峰值数据时画一条基线，而不是留空白装作正常"）**本来就写好了，只是从来没被走到过**。基线 + 可点击定位的游标，**定位功能一点不少**。

**真浏览器像素取证**（同一块 canvas，918×40）：

```
修前 · 无 peaks 资产:  nonEmptyPixels 11000   ← 编出来的波形柱
修后 · 无 peaks 资产:  nonEmptyPixels  1912   ← 只剩基线 + 游标
修后 · 有真 .ompk    :  nonEmptyPixels 20948   ← 真的 fetch 回来解码画的
                       媒体请求: GET /media/asset/<peaks uid> | GET /media/asset/<audio uid>
```

> **给 Manager 的取舍**：daemon 侧产真 peaks 我**没做**。它要在音轨落地后用 ffmpeg 抽 PCM → 按桶算 min/max → 写 `.ompk` → 建 `peaks` 资产 → 发 `media.asset.ready`（shared 里这个事件**已经有了**，前端 `notesSse` 也**已经订阅**并会 invalidate 详情）。落点在 `jobs/runners/transcribe.ts`（daemon）或 `packages/pipeline`（**`gpu-runtime` 独占**），M 级，且要真音频跑 ffmpeg —— 跨了别人的地界，也超出本任务四条的范围。**现在的状态是如实的空，不是把假数据留着装满。** `apps/web/package.json` 里 `wavesurfer.js` 依赖仍是**全仓零 import**（不是我引入的，一并报出）。

---

## §C10 —— 盘点的判断错了，症状是真的，根因在别处

### 我先去证伪，再动手（结论：`mindmap.done` 无订阅者 = 事实，但**不是原因**）

**① 线上真的发了什么**（`/tmp/notes-contract/wire-sse.mjs`：真开一条 `GET /api/events`，POST 生成，抓帧）：

```
[frame] job.created   …
[frame] mindmap.done  {"mindmapUid":"01KZ46QS1HPQMQK2ZTPRST0D7A","noteUid":"01KZ46CN6P…"}
[frame] note.updated  {"noteUid":"01KZ46CN6PGJEQ4R4FSEMSTBBM","changed":["mindmap"]}
收到的事件类型: ["job.created","job.state","mindmap.done","note.updated","job.state","job.done","job.progress"]
```

`runners/mindmap.ts:156,163` **两条都发**。而 `features/notes/sse.ts:66` 一直订阅着 `note.updated` 并在 `changed.includes('mindmap')` 时 invalidate `qk.mindmap(noteUid)`。

**② 浏览器那头收到了、也重取了**（`page.on('request')` 实录，SSE 触发之后浏览器自己发出的请求）：

```
GET /api/jobs
GET /api/notes/01KZ46V9JT9D1403P5Z651H6ZW/mindmap        ← 重取真的发生了
  → 200 {"mindmap":{…,"revision":3,…}                     ← 拿到的是新 revision
屏幕上: 契约验证用笔记 第2次生成的主题 第2次生成的要点 …   ← 还是上一版
```

**缓存这一层完全没断。** 所以补一个 `mindmapSse` 不会修好任何东西。

**③ 断在哪**：`MindmapView.tsx` 的渲染器只在 `doc.uid` 变化时重建，而 `doc.uid` **是笔记的 uid**（`runners/mindmap.ts` 生成时传的就是 `note.uid`）—— 同一条笔记里**永远不变**，重建条件恒不成立。旁边那句注释写着「doc 内容变化由外部走 refresh」，**全仓没有任何一处 refresh**：又一条描述了不存在机制的注释。

**复现**（真浏览器，页面停着不动，后台 POST 重新生成）：

```
重新生成前，屏幕上是: … 第6次生成的主题 …
POST 重新生成: 202
重新生成后，屏幕上是: … 第6次生成的主题 …        ← 没变
服务端此刻是 revision 2，根下: 第8次生成的主题     ← 服务端已经换了
手动刷新后，屏幕上是: … 第8次生成的主题 …          ← 只有刷新才看得到
```

**这就是"真 DeepSeek 10.1 秒、rev 3、页面不更新"的全部真相**：第一次生成（空态 → 有图）是**挂载**，所以看起来是好的；**从第二次起才复现**。

### 修法：内容签名 + 就地 `refresh()`，不重建实例

- **为什么不用 `revision` 当判据**：用户拖一个节点 → 防抖 600ms → PATCH → revision +1 → 重取 → 重建 → **视图在用户手底下被重置**（缩放、选中、撤销栈全丢）。原注释担心的"编辑时被自己覆盖"**是真问题**，只是它选的解法（`doc.uid`）问错了问题。
- **签名只取用户看得见的东西**（标题 + 从根按显示顺序遍历的节点文本）：别人改了 → 签名不同 → 换图；自己刚编辑完、服务端回来的就是我这份 → 签名相同 → 一个字都不动。节点 key / 样式 / 折叠 / `ext` 不进签名（往返里最容易无意义抖动的正是它们）。
- `me.bus.addListener('operation')` 里**同步更新签名**（哪怕是只读视图没有 `onChange`）—— 不更新的话，自己这次编辑存回去再拉回来会被判成"别人改的"。

**修后**（同一脚本）：

```
重新生成前，屏幕上是: … 第10次生成的主题 …
POST 重新生成: 202
重新生成后，屏幕上是: … 第12次生成的主题 …        ← 没刷新，自己换了
服务端此刻是 revision 2，根下: 第12次生成的主题     ← 一致
```

**没有补 `mindmapSse`，这是刻意的**：它会是第二个"导图变了"的触发源，而 `note.updated` 还覆盖 `PATCH`（手工编辑保存）这条 `mindmap.done` **不发**的路径 —— 留一个不完整的第二来源正是本项目反复吃亏的形状。`mindmap.started` / `mindmap.failed` 全仓无人发布，`mindmap.delta` 被 runner **刻意不发**。这些都写进了 `bindings.ts` 的注释与 `features/mindmap/README.md`（那份 README 原来把 `mindmapSse` 记成"必须导出"，**已按实测订正**）。

---

## §RV 反向验证（6 组，全部贴真实输出）

> 每组都先 `pnpm build:safe`，并 **`grep` 确认坏行真的在即将运行的产物里**（防 `mv` 还原出的旧 mtime 那种骗局）。

**RV-1｜删掉 `state: a.state`** —— 产物里 `grep -c "state: a.state" dist/…/notes.js` → `0`（确认坏行已生效）

```
✖ ★ 每条资产都要有 state，且值是 media_assets 那一列的真值
  AssertionError: 资产不带 state 字段 —— 前端筛的正是它（a.state === "ready"），
  缺了就恒 false，<audio> 元素根本不进 DOM，点播放毫无反应且零报错
ℹ pass 7  ℹ fail 1
```

**RV-2｜删掉 `bodyJson: parseJsonOrNull(...)`**

```
✖ ★ PATCH 写的 bodyJson，GET 必须原样还回来（⑤C 的第七例）
  AssertionError: GET 里没有 bodyJson —— 用户写的正文真落库了，但刷新一次界面就是空的，
  而且没有任何报错。数据一个字节没丢，用户却只会认为"它没保存"
ℹ pass 3  ℹ fail 5
```

**RV-3｜把整个 `GET /api/notes/:uid` 改成 `throw`（复刻盘点 E1 那个变异）** —— 产物里 `grep -c "RV-3 变异"` → `1`

```
我的契约文件:            ℹ pass 1  ℹ fail 7
apps/daemon 全量:        ℹ tests 244  ℹ pass 224  ℹ fail 19
```

> 盘点当时的同一变异是 **196/196 全绿**。现在红的 19 条分布在
> `noteDetailContract.test.js`（我的 7 条）、`rest/noteDetail.test.js`（`test-gaps` 的）、`guard.test.js`（同上，它拿这个端点做守卫探针）。**E1 那个洞已经被三方从不同角度堵上。**

**RV-4｜把 `mockPeaks` 加回 `lib/format/peaks.ts`**

```
✖ ★ 这个模块不许再导出 mockPeaks（回归护栏，与 MINDMAP_SAVE_SUPPORTED 同一手法）
```

**RV-5｜删掉 `MindmapView` 里"就地换图"那个 effect（回到只按 `doc.uid` 重建）**

```
✖ ★ 重新生成（uid 不变、内容变了）→ 屏幕上的主题必须跟着换
  新文档到了，屏幕上还是旧的那张图 —— 这就是"生成成功但页面不更新"的真身：
  缓存换了、渲染器没换（重建条件 doc.uid 在同一条笔记里永远不变）
ℹ pass 201  ℹ fail 1
```

**RV-6｜把 `isUsableAsset` 改回严格 `state === 'ready'`**

```
✖ ★ 响应里没有 state 这个键时，仍然要选得出来 —— "字段缺失"不等于"不可用"
✖ daemon 明确说不可用的三种状态一律排除（这才是这个字段存在的意义）
ℹ pass 91  ℹ fail 3
```

**六组全部还原后**：`tsc -b` 0 · `eslint .` 0 · `pnpm -r test` **842 passed / 0 failed**。

---

## §测试与取证的方法（避开已知的坑）

- **断言钉结构不钉关键词**：顶层键用逐个 `hasOwnProperty` 而不是整体 `deepEqual`（后者会让"新增字段"变红灯，那种红灯只训练人去改断言）。
- **DOM 存在性一律先转布尔**（PROTOCOL §8）：浏览器脚本里用 `locator.count() > 0`，组件用例里用 `x === root` 比较，**没有一处 `assert.equal(domNode, null)`**。
- **fixture 是真响应，不是想象的形状**：`noteAssets.test.ts` 的载荷是 `curl` 我自己 daemon 的输出逐字粘贴；`docSignature.test.ts` 的文档是真 LLM 生成 + 落库 + 读回的产物。这个 bug 能活到今天，正是因为两边的形状**从来没有被同一段代码同时看过一眼**。
- **两侧各留一道**：daemon 侧钉"必须发 `state`/`bodyJson`"，web 侧钉"真响应喂进去必须选得出音源"。少任何一侧，这个洞都补不上。

### 顺带修的一个宿主缺口（`src/test/dom-env.ts`）

组件测试里 mind-elixir 起不来，两个都是 jsdom 宿主缺东西，**症状都指向第三方库、其实是宿主的问题**：

1. `TypeError: window.matchMedia is not a function` —— 宿主**早就**有 `define('matchMedia', …)`，但那是挂在 `globalThis` 上的；`globalThis.window` 指向 jsdom 的 window，**是另一个对象**。于是 `globalThis.matchMedia()` 好好的，写 `window.matchMedia(...)` 的库当场炸。**"看起来已经补过了"的缺口比完全没补更难查**，所以两处都挂，并把这条写进注释。
2. `ReferenceError: HTMLCollection is not defined` —— 它是**运行时会被 `instanceof` 用到**的构造器，不只是类型。补了 `HTMLCollection` / `NodeList`。

---

## §交付（精确清单，合并者请照此 `add`，不要 `-A`）

**改（10）**

```
apps/daemon/src/http/rest/notes.ts              A1 state + A1b bodyJson + parseJsonOrNull
apps/web/src/features/mindmap/MindmapView.tsx   C10 就地换图
apps/web/src/features/mindmap/README.md         订正 mindmapSse 那段（实测）
apps/web/src/features/notes/NoteDetailPage.tsx  A1 选取改走纯函数 · A3 真 .ompk / 不造假
apps/web/src/lib/api/types.ts                   MediaAssetDto: state 改可选 + 补 url
apps/web/src/lib/events/bindings.ts             删掉悬空的 mindmapSse 注释，换成实测结论
apps/web/src/lib/format/peaks.ts                删除 mockPeaks（保留一段"为什么是删"的说明）
apps/web/src/test/components.test.tsx           末尾追加 MindmapView 两条 + 顶部 2 行 import
apps/web/src/test/dom-env.ts                    window.matchMedia / HTMLCollection / NodeList
apps/web/tsconfig.test.json                     登记 3 组新单测（显式白名单）
```

**新增（5）**

```
apps/daemon/src/http/noteDetailContract.test.ts   8 条（端到端，含与 test-gaps 的合并说明）
apps/web/src/features/notes/noteAssets.ts         纯函数：选音轨 / 选波形
apps/web/src/features/notes/noteAssets.test.ts    6 条
apps/web/src/features/mindmap/docSignature.ts     纯函数：内容签名
apps/web/src/features/mindmap/docSignature.test.ts 7 条
apps/web/src/lib/format/peaks.test.ts             5 条（decodeOmpk 首次有测试 + mockPeaks 护栏）
```

**不是我的**（同期在工作区里，请勿算在 T-139 头上）：`apps/daemon/src/http/{guard.test.ts,rest/noteDetail.test.ts,media.ts,media.test.ts}`、`apps/web/src/lib/api/client.test.ts`、`apps/web/src/{App.tsx,lib/api/mock.ts,app/i18n/*}`、`packages/runtime/src/assetPaths*`、`packages/pipeline/src/subprocess/argGuard.ts`、`scripts/{check-test-scripts,mutation-check}.mjs`、各包 `package.json` 的 test 脚本、`coordination/inbox/{test-gaps,path-guard}.md`。

**已被别人提交带走的（见下）**：`apps/daemon/src/db/repos.ts` 的 `NoteRow.body_json`（11 行）——**已在 `8ecac4f` 里**，不需要再 add。

---

## §需要 Manager 决策（4 条）

1. **🔴 ⑤J 第六例，请记录在案。** `8ecac4f`（"feat: 文件夹筛选真正生效 (T-138④)"）里含 `apps/daemon/src/db/repos.ts` 的 `NoteRow.body_json` 及其 11 行注释 —— **那是 T-139 的**，写于 00:30 前后，提交时间 00:30:19。`git show HEAD~1:…/repos.ts | grep -c body_json` → `0`，`git show HEAD:…` → 有。与前五例形式相同：提交者用了跨路径的 `add`，把当时磁盘上别人**正在写、还没提交**的改动一并扫走。历史改不了，**能改的是让后来的人查得到**。（这一例的后果比前几例轻：只是一个字段的类型声明。但它也说明"改共享区的人和提交的人是两个人时，这个时间窗必然存在"这条判断仍然成立。）
2. **契约收敛（C8）由谁做。** 要真正堵死 A1/A1b 这一类，得让 `packages/shared` 的 `NoteAsset` 补 `state`、`NoteDetail` 补 `bodyJson`/`canRetranscribe`，然后 **web 与 daemon 都改成 import 它**。`packages/shared/src/**` 是 `model-mgmt` 独占，我没碰。具体补丁我已经写清楚（本文件 §根因那张表就是差异清单）。**只补 shared 而不切过去毫无意义**——那正是这次的成因。
3. **两份同端点的测试要不要并。** `noteDetailContract.test.ts`（我）与 `rest/noteDetail.test.ts`（`test-gaps`）冲着同一个 E1 洞。我不动别人的交付物；并的时候请保留我那三条独有的（`state:'ready'` 要真取得回字节 / `GET`→`PATCH` 幂等 / 顶层键全清单），说明写在我文件的头部。
4. **daemon 产真 peaks 立不立项。** 见 §A3 末尾的方案与落点（跨 `gpu-runtime` 地界）。**不立项也没关系**——现在的状态是如实的"无波形"，不是假绿灯。但 `wavesurfer.js` 这个依赖目前**全仓零 import**，要么用起来要么下掉。

---

## §顺带发现（只报不动）

- `apps/web/src/lib/api/types.ts` 的 `NoteDetail.bodyText: string` 是**必填**，而 daemon **从来不发**、全仓也**没有任何一处读 `note.bodyText`**（只有 `mock.ts` 提供）。与 A1/A1b 同族的第三处，但**零用户影响**。没改是因为 `mock.ts` 此刻正被别路改着，不值得为一个没人读的字段去撞车。建议改成可选或删掉。
- `apps/daemon/src/http/rest/notes.ts` 文件头那段「⚠️ 契约缺口（已在 inbox 报 Manager）…一旦 shared 补上正式类型，本文件应改为 import 它们」—— **shared 已经补上了，这句"一旦…就应该"没有失效条件、也没有任何检查器盯着**。我没删它（它描述的动作确实还没做），但它正是决策 2 的入口。
- `packages/mindmap` 生成的 `MindMapDoc.uid` **是笔记的 uid**，不是导图的 uid（导图自己的 uid 只在信封 `mindmap.uid` 里）。这个命名让 C10 那条重建条件看起来完全合理。建议在 `packages/mindmap/src/types.ts` 给 `uid` 加一句"这是它所属笔记的 uid"——**我没改**（那是别人的包）。

---

## §复现我的取证（脚本都在 `/tmp/notes-contract/`，未进仓库）

```bash
pnpm build:safe
node apps/daemon/dist/main.js --port 17971 --data-dir /tmp/notes-contract/data   # 你自己的临时库
node /tmp/notes-contract/seed.mjs                 # 造一条含音轨+转写稿的笔记（WITH_PEAKS=1 再造真 .ompk）
node /tmp/notes-contract/fake-llm.mjs 17972       # 假 OpenAI 兼容厂商（不需要任何真 key）
cd apps/web && OPENMEMO_DAEMON=http://127.0.0.1:17971 pnpm exec vite --port 5231 --strictPort
node /tmp/notes-contract/browser.mjs <noteUid>        # A1 / A1b / A3 / C10 首次生成
node /tmp/notes-contract/browser-regen.mjs <noteUid>  # C10 的正主：重新生成
node /tmp/notes-contract/wire-sse.mjs                 # 线上真的发了哪些 SSE 帧
```

**这几个脚本没有进仓库**，因为它们要起三个进程 + 一个浏览器，进不了 `pnpm -r test` 那条道。永久护栏是上面那 28 条测试（daemon 8 · web 单测 18 · web 组件 2）；脚本是取证工具。**如果 Manager 认为"真浏览器验收"应该常态化，这是一个值得单独立项的口子**（仓库里已经有 `playwright@1.62.1` 与 chromium，只在 `packages/downloader` 的依赖里）。
