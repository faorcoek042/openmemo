# inbox / daemon-contract

## [2026-08-06 12:10] T-151 SHARED-CHANGE 申报（开工前，PROTOCOL §1 规则 2）

我要动**两个不属于我主区**的地方，先在这里报备，动之前已 `git status` 确认它们当时**未被修改**
（工作区只有 `apps/daemon/src/pipeline/platformPacks.test.ts` + `vendor/manifests/*.json` 三个 M，
是 `pack-publish` 的，我不碰）。

| 文件 | 归属 | 我要做什么 | 为什么非动不可 |
|---|---|---|---|
| `packages/shared/src/notes.ts` | `model-mgmt` 独占 | 给 `NoteAsset` 补 `state`、给 `NoteDetail` 补 `bodyJson` / `canRetranscribe` 等 daemon **实际在传**的字段 | T-151 ② 的全部内容。`notes-contract` 已定性：shared 与 daemon 一致、**分叉的是 web 那一份**；只补 shared 不切过去等于没做 |
| `apps/web/src/lib/api/types.ts` | `frontend-truth`（`apps/web/` 全归它） | 把手抄的 `NoteDetail` / `MediaAssetDto` 改成 **`import` shared 的那一份**再本地扩展 | ②的判据是「编译期能挡住」。手抄镜像与 daemon 之间没有任何连接，`tsc` **结构上看不见**这条缝 |

**我不碰 `apps/web/` 的其它任何文件**；若切换后 web 有别的文件编译不过，我会如实报出来交给
`frontend-truth`，而不是顺手改它的交付物。

（后续进展与最终回执追加在下方。）

---

## [2026-08-06 14:50] T-151 DONE —— 三件全做了

### TL;DR（≤25 行，Manager 只读这里）

1. **三件都做完了。③ 我做了，因为上一份评估的前提不成立** —— 它说「要用 ffmpeg 抽 PCM，M 级，
   且跨 `packages/pipeline`（`gpu-runtime` 独占）」。**不需要 ffmpeg**：流水线已经把音频归一化成
   16 kHz 单声道 PCM16 WAV **并归档进了 media 根**（`audio16k`），录音落的也是同一种格式 ——
   **盘上躺着的就是解码后的 PCM**。剩下的只有「按窗口取 min/max + 量化 Int8 + 写 14 字节头」，
   纯 Node，全部落在 `apps/daemon/` 内。D-07 #18 / D-08 #18 记了两轮的 🔴 现在闭合。
2. **① 先有 harness 再改那一行**（`asset-check` 的判断是对的，我照办）。harness 走**真 WS**：
   真 Origin/Host/cookie 闸门 → 真二进制帧 → 真落盘 → 真 SQLite → 真 job 入队；
   **只有 ASR 引擎是桩**（不需要麦克风、不跑 whisper）。判据钉**后果**不钉形式：
   把整个数据目录搬走，再用**播放端那份解析规则**去读同一条记录，必须真读回我送上去的字节。
3. **② 判据真的变成编译期了，并已反向验证**：daemon 删 `state` / 删 `bodyJson` → **daemon 编译红**；
   web 读 `updatedAt`/`source`/`bodyText` → **web 编译红**（三条一次全出）。
4. **🔴 顺带查出一件比任务书说的更糟的事**：`packages/shared` 的 `NOTE_KINDS` / `NOTE_STATUSES`
   里有 **4 个 DB 根本不允许的取值**（`text`/`importing`/`transcribing`/`structuring`，
   建表 CHECK 里一个都没有），而真实存在的 `plain`/`processing`/`partial` 契约里没有。
   它能错这么久是因为**全仓零 import** —— 一份没人用的契约不会被任何东西证伪。已按建表语句订正，
   并加了 6 条**双向**守卫（契约值必须真写得进去 / DB 允许的值必须都在契约里）。
5. **反向验证 6 组，全部贴真实输出**（§RV）。运行时那几组每次都先 `grep` 产物，证明坏行在**即将运行的那份 dist 里**。
6. **门禁**：`tsc -b` 0 · `eslint .` 0 · `pnpm -r test` **1005 passed / 0 failed**（我开工时基线 934；
   我贡献 **19 条**：daemon 波形 8 + 录音 harness 5 + db 契约 6，其余是并行的几路）。
7. **越界申报**：动了 `apps/web/` 三个文件（`lib/api/types.ts` 已在开工前申报；另外
   `lib/api/mock.ts` 与 `features/notes/noteAssets.ts` 是**切过去之后编译不过**才动的，
   都只改声明不改逻辑）。详见 §越界。
8. **只报不动**：`NoteSummary`（列表 DTO）仍是手抄的，且 `source`/`coverAssetUid`/`folderUid`
   **daemon 一个都不发** → `NotesListPage.tsx:157` 的站点徽标在真实环境里恒不渲染。见 §只报不动。
9. **纪律**：没碰 `/root/data-memo`、没碰指针（内容/mtime 均未变）、没构建 `apps/web/dist`
   （mtime 仍是 02:15:09，早于我开工）、没起也没碰 `:10000`、没用 `pkill`、没跑 whisper、没 commit。

---

## ① 录音把绝对路径写进 `rel_path`

### 先有 harness：`apps/daemon/src/ws/recorder.test.ts`（🆕 5 条）

`asset-check` 不改那一行的理由我完全认同，所以顺序是**先建 harness**。它覆盖：

```
node:http 服务器 + attachWebSocket（真 guardRequest：Host 必须 IP 字面量 + 端口相符、
Origin 严格同源、必须带 om_sid cookie）
  → 真 ws 客户端发真二进制帧 → RecorderSession.writeAudio → 真 createWriteStream 落盘
  → 真 {"type":"stop"} → 真 #finalizeWav() 回填头 → 真 Repos.createAsset 落进真 SQLite
  → 真 JobQueue.enqueue（离线重跑）
```

**唯一被顶替的是 `openStream`**（手写 `AsrStream` 桩）。不需要麦克风、不需要模型、
**不跑任何转写**。这与 `notes-contract` 用假 LLM 顶替厂商是同一条边界，已写进文件头。

### 判据：钉后果，不钉「那一行长什么样」

「`rel_path` 不许是绝对路径」是**形式**，而形式在不搬家的机器上看不出任何区别 ——
读取侧的候选式解析对绝对路径也认得。**宽容的读取会把不一致的写入藏起来**，这正是它活到今天的原因。

藏不住的那一刻是**数据目录搬家**（这一列存在的全部理由，D-02 §1.1；建表语句的注释就写着
「相对 `<data_root>/media`，**绝不存绝对路径**」）。所以主断言是：
`cp -r` 整个数据目录到新位置 → 用 `probeAssetFile`（T-136 收敛的那唯一一份）读同一条记录 →
必须**逐字节等于我送上去的 PCM**。

### 修法：写入侧也归一

新增 `packages/runtime/src/assetPaths.ts` 的 **`canonicalAssetRelPath(dataDir, abs, platform?)`**
—— 与同文件的 `mediaAssetRoots` / `assetCandidates` **读写严格配对**，
`platform` 是**入参**（`argGuard.isSafeExecutable` / `assertWithinRoot` / `isWithinImportRoots` 同一形状），
算不出相对路径时返回 `null` 而**不兜底成绝对路径**（兜底 = 把缺陷静默放回来）。

三个写入方现在共用它：`ws/recorder.ts`（本次修的那条）、`storage/migrateAssets.ts`
（原来是这个模块自己的一行实现）、新增的 `media/peaksAsset.ts`。
`transcribe.ts` 的 `archiveIntoMedia` 产出的已经就是同一形态（相对 media 根），未动。

**顺带堵掉一个真会打死 daemon 的洞**：`stop()` 现在会在算不出规范路径时抛，
而 `http/ws.ts` 那三个调用点原来都是光秃秃的 `void session.stop()` / `void session.abandon()`
—— 真抛出来会变成 unhandled rejection，**Node 默认直接终止整个进程**，
用户看到的只是"停止录音时应用突然退出"。三处统一收口成 `finish()`：告诉前端 + 记日志 + 正常关闭。

---

## ② 共享契约收敛（C8）

### 补了什么（`packages/shared/src/notes.ts`）

| | 补/改 | daemon 是否一直在发 |
|---|---|---|
| `NoteAsset.state` | 🆕 **必填** `MediaAssetState` | 是（T-139 后） |
| `NoteAsset.mime` / `bytes` | `string`/`number` → **可空** | 两列都没有 NOT NULL，录音路径确实不填 |
| `NoteDetail.bodyJson` | 🆕 `unknown \| null` | 是 |
| `NoteDetail.canRetranscribe` | 🆕 **必填** | 是 |
| `NoteListItem.starred` / `tags` | 🆕 | **一直在发，契约里一直没有** |
| `NOTE_KINDS` / `NOTE_STATUSES` | **按建表 CHECK 订正**（见 TL;DR 4） | — |
| `MEDIA_ASSET_STATES` / `MEDIA_ASSET_ROLES` / 三个类型守卫 | 🆕 | — |

`state` 与 `canRetranscribe` 都声明为**必填**，这是刻意的：可选的话 daemon 删掉那一行**不会**编译失败，
A1 那个洞就还开着。**消费侧的宽容是另一条规矩**（老响应真的没有这个键 → 按可用处理），
所以 `isUsableAsset` 的**参数类型故意比 DTO 宽**（`{ state?: string }`），注释里写清了分工。

### 两侧都 import 它

- **daemon** `http/rest/notes.ts`：`const detail: NoteDetail = {…}` / `const assets: NoteAsset[] = …` /
  `const notes: NoteListItem[] = …`。少一个键、多一个键都在这里编译失败。
  DB 的 `TEXT` 列 → 字面量联合走 `narrowColumn`（**认不出就抛，不兜底成默认值** ——
  兜底就是"把一次响亮的失败换成一次安静的谎话"；CHECK 约束保证它到不了）。
  文件头那段「一旦 shared 补上正式类型，本文件应改为 import 它们」的悬空 TODO **已兑现并改写**。
- **web** `lib/api/types.ts`：`NoteDetail` / `MediaAssetDto` 直接是 shared 那一份。
  ⚠️ `NoteDetail` **不再 `extends NoteSummary`** —— 详情端点不发 `updatedAt`/`coverAssetUid`/
  `source`/`bodyText`，让详情继承列表就是**用类型系统替四个不存在的字段背书**。

### 🆕 契约 ↔ 建表 CHECK 的双向守卫（`packages/db/src/schemaContract.test.ts`，6 条）

只订正一次没用 —— 没有任何东西会阻止它再漂一次，而现在它已经是**产品行为**了
（联合里少一个 DB 允许的值 → `narrowColumn` 抛 → 那种笔记的详情页 **500**）。所以：

- **契约 ⊆ DB**：每个契约值都**真的 INSERT 一遍**（不是比字符串）；
- **DB ⊆ 契约**：从 `sqlite_master` 里抠出 CHECK 的取值列表逐一比对（**只有这半边能发现"我不知道的值"**）；
- 外加一条**对照**：故意插一个越界值必须被拒 —— 否则上面那几条"写得进去"会退化成"这个库什么都收"。

---

## ③ daemon 产出真波形 peaks —— **做了**

### 评估：上一份的成本估算建立在一个不成立的前提上

> 「要在音轨落地后用 ffmpeg 抽 PCM → 按桶算 min/max → 写 .ompk → 建资产 → 发事件，M 级，
>  且要跨 `packages/pipeline`（`gpu-runtime` 独占）」

`transcribe.ts` 的 `archiveIntoMedia` **已经**把归一化音频（16 kHz 单声道 PCM16 WAV）搬进了
media 根并登记成 `role='audio16k'`；录音会话落的是同格式的 WAV。**盘上躺着的就是解码后的 PCM。**
再 spawn 一个 ffmpeg 是把做完的事重做一遍。真正要写的只有：RIFF 块链表解析 + 按窗口取 min/max +
量化到 Int8 + 14 字节头。**不碰 `packages/pipeline`，不碰任何别人的地界。**

### 交付

- 🆕 `apps/daemon/src/media/peaks.ts` —— 纯计算：`readWavPcmInfo` / `computeWavPeaks` / `encodeOmpk`。
  **流式读**（2 小时音轨 = 230 MB，而这个函数跑在还挂着 whisper 进程的 job 里）。
- 🆕 `apps/daemon/src/media/peaksAsset.ts` —— 落盘 + 建资产 + 发 `media.asset.ready`。
- 接线：`jobs/runners/transcribe.ts`（转写后）与 `ws/recorder.ts`（停止后）。
- 🆕 `apps/daemon/src/media/peaks.test.ts`（8 条）+ 录音 harness 里 1 条端到端。

### 三个关键取舍

1. **格式以解码器的代码为准，不以文档为准。** D-02 §3.4 与 web 的注释都写「各声道**交错**存放」，
   而 `decodeOmpk` 的实现是 `body[c * perChannel + i]` —— **平铺（planar）**。
   按文档写会产出"解得开、但声道错位"的文件，界面**照样画得出东西**，只是画的是别的声道。
   测试里**逐行照抄** `decodeOmpk` 反解回来核对**解出来的浮点值**（不是核对字节），
   另有一条护栏读 web 源码确认它仍是 planar 索引（**先剥注释再匹配** —— 那个文件的注释里
   就写着"交错"，直接 grep 关键词会得出与代码相反的结论）。
2. **落点每条笔记固定一个**：`<mediaRoot>/<noteUid>/peaks.ompk`，不带随机成分。
   `createAsset` 对 `rel_path` 幂等 ⇒「录完生成一次 + 离线重跑再生成一次」**不会长出两条**
   （长两条的后果不是多一行：前端 `pickPeaksAsset` 取 `find` 的第一条，可能画的是上一次的波形）。
3. **`data` 块声明的长度不能全信**：录音的 WAV 头是"占位 0 → 停止时回填"，
   而回填在 `#finalizeWav()` 里被 try/catch 包着。真发生时头里是 0，照它算的结论是
   "这段录音没有波形" —— 一个由**元数据**造成、却表现成**内容缺失**的假象。有专门一条用例。

### 失败策略

波形是派生产物，算不出来**不让整单转写失败**，但**必须出声**（`[peaks] ⚠️` 日志 + 返回 null），
**绝不写半份 `.ompk`**（半份波形和编出来的波形一样是谎，与 `decodeOmpk` 那条
"坏数据必须抛，不能尽力解出一点"同一判据）。

---

## §RV 反向验证（6 组，全部真实输出）

> 运行时那几组每次都先 `pnpm build:safe` 再 `grep` 产物，**证明坏行在即将运行的那份 dist 里**
> （防"`mv` 还原出的旧 mtime 让 `tsc -b` 跳过重建"那种骗局）。收工时源码与产物 `grep MUTANT_T151` 均 **0**。

**RV-1｜①：`relPath` 退回 `this.#wavPath`（事故形态）**
产物 `dist/ws/recorder.js:225` 命中 `MUTANT_T151_RV1`。
```
✖ ★ 数据目录搬家后，录音仍然读得回来（rel_path 不许是绝对路径）
  数据目录搬到 /tmp/om-rec-moved-FKNi3L 之后就读不到了：
  rel_path=/tmp/om-rec-e2jGWP/media/recordings/01KZAWW6EHNMZ3P7A8585RB2B6.wav
  找过：一个候选都没有（记录指到了所有根之外 —— 典型的绝对路径）
✖ ★ rel_path 落进 media 根这一档（与 transcribe.ts 同一种规范形态）
ℹ pass 3  ℹ fail 2
```

**RV-2｜②：daemon 删掉 `state: assetStateOf(a.state)`**
```
src/http/rest/notes.ts(531,17): error TS2322: ... 
  Property 'state' is missing in type '{ uid; role; mime; bytes; durationMs; url; }'
  but required in type 'NoteAsset'.
```

**RV-3｜②：daemon 删掉 `bodyJson: parseJsonOrNull(...)`**
```
src/http/rest/notes.ts(569,17): error TS2741: Property 'bodyJson' is missing in type
  '{ uid; title; status; kind; language; durationMs; ... 8 more ...; createdAt; }'
  but required in type 'NoteDetail'.
```

**RV-4｜②：web 读三个 daemon 详情端点不发的字段**（`NoteDetailPage.tsx` 临时加一行，已按 sha256 逐字节还原）
```
src/features/notes/NoteDetailPage.tsx(119,17): error TS2339: Property 'updatedAt' does not exist on type 'NoteDetail'.
src/features/notes/NoteDetailPage.tsx(119,30): error TS2339: Property 'source'    does not exist on type 'NoteDetail'.
src/features/notes/NoteDetailPage.tsx(119,40): error TS2339: Property 'bodyText'  does not exist on type 'NoteDetail'.
```
> 这正是 `notes-contract` 预言的那一条：「切过去的价值是让 `NoteDetailPage` 当场编译报错」。

**RV-5｜②：把 `NOTE_STATUSES` 退回订正前那份**（产物 `packages/shared/dist/notes.js:37` 命中）
```
✖ ★ notes.status：契约里的每个值都必须真的写得进去
  SqliteError: CHECK constraint failed: status IN ('draft','processing','ready','partial','failed')
✖ ★ notes.status：DB 允许的每个值都必须在契约里
ℹ pass 4  ℹ fail 2
```

**RV-6a｜③：把 planar 写成文档说的"交错"**（产物 `dist/media/peaks.js:175` 命中）
```
✖ ★ 多声道按 planar 排布（照 decodeOmpk 的索引来，不照文档里的"交错"）
  AssertionError: 左声道应当恒为 +1，实得 -1
ℹ pass 7  ℹ fail 1
```

**RV-6b｜③：录音链路不再产 peaks（回到 T-151 之前）**（产物 `dist/ws/recorder.js:255` 命中）
```
✖ ★ 录完就有真波形：peaks 资产落库 + 文件能按 .ompk 解开（T-151 ③）
  peaks 资产应当恰好一条，实得 0：
  [{"uid":"01KZAX7FZ5N7ANW6Z5EJ7GQMJH","rel_path":"recordings/01KZAX7FYWSFY3PQT3ZAJJY2QW.wav",
    "bytes":9644,"role":"original"}]
ℹ pass 4  ℹ fail 1
```

---

## §越界（`apps/web/` 归 `frontend-truth`，逐条申报）

| 文件 | 为什么非动不可 | 动了什么 |
|---|---|---|
| `lib/api/types.ts` | **开工前已申报**，②的本体 | `NoteDetail`/`MediaAssetDto` 改成 import shared |
| `lib/api/mock.ts` | 切过去后**编译不过**（7 处） | `MockNote` 显式合上 `Pick<NoteSummary,…>`；删 `bodyText`（daemon 从不发、全仓无人读）；补 `segmentCount`/`canRetranscribe`；资产统一走新的 `mockAsset()`（`url` 由 uid 算出来，**不许留空**）|
| `features/notes/noteAssets.ts` | 切过去后 `isUsableAsset({})` 编译不过 | **只改参数类型**（`Pick<MediaAssetDto,'state'>` → `{state?: string}`）+ 注释。逻辑一行没动 |

**没动 web 的任何组件/页面。** 三个文件都只改声明与夹具形状。

## §只报不动

1. **🔴 `NoteSummary`（列表 DTO）仍是手抄的，且已在分叉。** `[读码]` daemon 的 `GET /api/notes`
   只发 10 个键，**不发** `source` / `coverAssetUid` / `folderUid`，而 web 声明它们是必填。
   后果：`NotesListPage.tsx:157` 的 `n.source?.site` 站点徽标**在真实环境里恒不渲染**
   （用了可选链所以不崩，与 A1/A1b 同族）；`.filter(n => n.folderUid === folderUid)` 那条
   mock 分支同理。收敛它必然要改 `NotesListPage.tsx`（`frontend-truth` 的地界），**我没动**。
   shared 的 `NoteListItem` 已经补齐并被 daemon 侧标注，**web 那一侧还没切**。
2. `apps/daemon` 的 `TranscribeRunnerDeps` 多了 `dataDir`；**转写 runner 里那一行
   `generatePeaksAsset(...)` 没有被测试执行过**（要真 ffmpeg + 真模型 + 真音频，用户明确不跑 whisper）。
   已编译验证；**同一个函数在录音链路上被端到端跑过**（真文件、真 DB、真 SSE）。如实标 `未跑通`。
3. `D-02 §3.4` 与 `apps/web/src/lib/format/peaks.ts` 的文件头注释都写「各声道**交错**存放」，
   而代码是 planar。**文档没改**（`docs/design/` 不是我的交付物），已在生成器与测试里写清以代码为准。
4. `apps/web/package.json` 的 `wavesurfer.js` 依赖**仍是全仓零 import**（`notes-contract` 也报过）。
   现在真 peaks 有了，它要么用起来要么下掉 —— 这是前端的取舍。

## §纪律自查

- ✅ **没写 `/root/data-memo`**（全程只 `stat` 过目录本身一次）
- ✅ **数据目录指针未被我改**：内容仍是 `{"dataDir":"/root/data-memo"}`，mtime 停在 `08-04 01:06:59`
  （远早于我开工）。全部测试都用自己 `mkdtemp` 出来的临时目录 + `--data-dir`，**没有任何一处会写指针**
- ✅ **`apps/web/dist` 未被触碰**：mtime 仍是 `2026-08-06 02:15:09`（早于我开工）；
  构建一律 `pnpm build:safe`，web 只跑 `tsc -b`（`emitDeclarationOnly` → `dist-types/`，不是 `dist/`）
- ✅ **`:10000` 全程零请求**：没起、没重启、没 kill、没占该端口
- ✅ **没用 `pkill`**；没起任何长驻进程（harness 用 `listen(0)` 拿随机端口，用例结束即 close）
- ✅ **没跑 whisper 转写**；ASR 引擎全程是桩
- ✅ **未 commit、未 `git add`**（`-A` 更没用过）
- ✅ 新测试都在 `src/**/*.test.ts` 且被各包 test 脚本的**发现守卫**数到
  （daemon/db 用 `include: src/**/*`，没有 `tsconfig.test.json` 白名单；web 我没加测试）
- ✅ 未派生 subagent

### 精确交付清单（合并者请照此 `add`，**不要 `-A`**）

**新增（5）**
```
packages/db/src/schemaContract.test.ts        契约↔CHECK 双向守卫（6）
apps/daemon/src/media/peaks.ts                .ompk 生成（纯计算）
apps/daemon/src/media/peaksAsset.ts           落盘 + 建资产 + 发事件
apps/daemon/src/media/peaks.test.ts           8 条
apps/daemon/src/ws/recorder.test.ts           录音 harness 5 条
```

**修改（11）**
```
packages/shared/src/notes.ts                  ② 契约补齐 + 按建表 CHECK 订正联合
packages/runtime/src/assetPaths.ts            ① canonicalAssetRelPath（platform 入参）
packages/runtime/src/index.ts                 导出它
apps/daemon/src/ws/recorder.ts                ① 绝对路径 → 规范相对路径；③ 停止后产 peaks
apps/daemon/src/http/ws.ts                    ① 收尾失败不再变成 unhandled rejection
apps/daemon/src/http/rest/notes.ts            ② 三个响应对象标注成 shared 类型 + narrowColumn
apps/daemon/src/storage/migrateAssets.ts      ① canonicalRel 改用共享那一份
apps/daemon/src/jobs/runners/transcribe.ts    ③ 转写后产 peaks（+ deps.dataDir）
apps/daemon/src/main.ts                       两处 deps 补 dataDir
apps/web/src/lib/api/types.ts                 ② 改成 import shared（已申报）
apps/web/src/lib/api/mock.ts                  ② 切过去后的编译修复（见 §越界）
apps/web/src/features/notes/noteAssets.ts     ② isUsableAsset 参数类型放宽（仅签名）
```

**不是我的**（同期在工作区里）：`apps/daemon/src/http/rest/{models,roleMap,state}.ts`、
`packages/runtime/src/selfcheck.ts`、`apps/web/src/features/models/**`（含新文件 `asrSections.ts`）、
`apps/web/src/components/common/llm/**`、`apps/web/src/features/diagnostics/DiagnosticsPage.tsx`、
`apps/web/src/app/i18n/**`、`apps/web/src/test/components.test.tsx`、`packages/mindmap/**`、
`docs/**`、`coordination/inbox/catalog-truth.md`。

### 门禁最终数字
```
tsc -b   exit 0
eslint . exit 0
pnpm -r test  exit 0   TOTAL 1005 passed / 0 failed
  packages/db 53（+6 我） · packages/llm 18 · packages/mindmap 51 · packages/runtime 51
  packages/pipeline 187 · apps/web 103+10+221 · apps/daemon 311（+13 我）
```
> 中途见过一次 `apps/web` 组件套件 1 条红（`isSuperseded` 读到 undefined，在
> `features/models/asrSections.ts` —— 并行 agent 正在现场编辑的新文件）。**不是我的**，
> 且在我收工前已由对方修好（现 221/0）。一并报出以免被算在 T-151 头上。

### 需要 Manager 决策
1. **`NoteSummary`（列表 DTO）要不要一起收敛。** 差异清单在 §只报不动 1；shared 侧已经补齐、
   daemon 侧已经标注，只差 web 切过去 + 改 `NotesListPage.tsx`。那是 `frontend-truth` 的地界。
2. **`wavesurfer.js` 用起来还是下掉**（现在真 peaks 有了，前端有了真实数据源）。
3. **D-02 §3.4 的「各声道交错存放」是错的**（实现是 planar）。文档归 Manager，我没改。
