# e2e-notes 回执

## [2026-08-08 16:30] F4 思维导图 + F5 笔记管理与检索 · 三平台端到端 DONE

交付:

- `.github/workflows/e2e-notes.yml`（新建，没碰任何别人的 workflow）
- `scripts/ci/e2e-notes-audit.mjs`（新建，33 条断言 + 9 条变异证明）
- commit `700a965`（主体）、`1dce8f1`（修我自己脚手架的一个 bug）

**CI 实测：run `31247533926`，三个平台全绿。**

| 平台                        | 结果                                |
| --------------------------- | ----------------------------------- |
| ubuntu-24.04 (linux-x64)    | ✅ 断言 33 · 变异证明 9 · 失败 0    |
| macos-26 (darwin-arm64)     | ✅ 断言 33 · 变异证明 9 · 失败 0    |
| windows-2025 (win32-x64)    | ✅ 断言 33 · 变异证明 9 · 失败 0    |

用的是 **build-bundles run `31208766871` 的 artifact** —— 就是用户下载的那个
v0.2.0 预编译包（linux 43.0 MB tar.xz / win 51.4 MB zip），解开归档、用**包自带的
Node**（win 上 `runtime/node.exe` 86,989,128 B）起 daemon，全程走产品自己的 HTTP。
**没有用源码树跑。** 取不到 artifact 会红，不会静默回落到现场组装。

---

## 一、回报重点 ①：三个平台的中文两字词检索**都能搜到**

这是最容易静默坏的一条，所以先说结论：**三个平台全部搜得到。**

| 平台    | tokenizer | libsimple | 会议 | 纪要 | 预算 | 客户 | `ext.chineseSearch` |
| ------- | --------- | --------- | ---- | ---- | ---- | ---- | ------------------- |
| linux   | `simple`  | `true`    | 1 条 | 1 条 | 1 条 | 1 条 | `ok`                |
| darwin  | `simple`  | `true`    | 1 条 | 1 条 | 1 条 | 1 条 | `ok`                |
| **win** | `simple`  | `true`    | 1 条 | 1 条 | 1 条 | 1 条 | `ok`                |

走的是**产品真实路径**：`PATCH /api/notes/:uid` 写一段中文正文（触发 `notes_fts`
的更新触发器）→ `GET /api/search?q=会议`。不是 selfcheck 那张自建的临时表 ——
那张表 cold-start 已经在验，这里验的是**用户真的搜自己的笔记**这条路。

### Windows 的 `simple.dll` vs `libsimple.dll` 陷阱：**已经闭合，有实物证据**

`[CI 实测]` 包里 `extracted/openmemo-0.2.0-win-x64/ext` 的实际内容：

```
drwxr-xr-x  dict
-rwxr-xr-x  1518592  libsimple.dll     ← 加载侧 defaultExtensionPaths() 找的正是这个名字
-rwxr-xr-x   289280  vec0.dll
```

上游 `libsimple-windows-x64.zip` 里叫 **`simple.dll`（MSVC 不加 lib 前缀）**，
而 `packages/db/src/extensions.ts` 的 `defaultExtensionPaths()` 找的是
`libsimple.dll`。`scripts/build-bundle.mjs` 调**产品自己那个**
`sqliteExtensionSources()` 做重命名（候选列表 `['libsimple.dll','simple.dll']`），
所以包出厂时已经是对的名字。**这一格在出厂环节闭合，不是在运行期靠运气。**

### 这条断言**证明过自己看得见那个静默**（本轮最值钱的一条）

判据不是"它绿了"，是"它在坏的时候会红"。第 13 节另起一个
`OPENMEMO_EXT_DIR` 指向空目录的 daemon（数据目录 `mkdtemp`），
**把 F5-d1 那条断言原样搬过去量它**：

```
[变异实例] tokenizer=trigram libsimple=false sqliteVec=false
[变异实例] q=会议  HTTP 200  命中 0 条    ← 200，不报错，就是 0 条
✔ [变异] ★ F5-d1 的证伪能力（没有 libsimple 时，同一条断言必须红）—— 如期变红
✔ MUT-1 静默：四个词全是 HTTP 200 + 0 条，一个错都不报 —— 这就是那个静默
✔ MUT-2 变异实例上 modes.chineseTokenizer 如实报 false
```

三个平台都跑了这条，都如期变红。

---

## 二、回报重点 ②：四种导出的**实际返回**

`GET /api/notes/:uid/export?what=mindmap&format=…`，每种都真发 HTTP 拿回正文。
下面是 **win32-x64 那一格的真实返回**（三平台字节级一致）：

| format | HTTP | content-type                        | 正文    | 时间戳    |
| ------ | ---- | ----------------------------------- | ------- | --------- |
| `md`   | 200  | `text/markdown; charset=utf-8`      | 100 字符 | ✅ 带得走 |
| `opml` | 200  | `text/x-opml; charset=utf-8`        | 319 字符 | ❌ 丢     |
| `mm`   | 200  | `application/x-freemind; charset=utf-8` | 207 字符 | ❌ 丢 |
| `json` | 200  | `application/json; charset=utf-8`   | 778 字符 | ✅ 带得走 |

```markdown
# jfk (CI 可行性证明) 已编辑E2EMMEAE3906C82
- 会议主题 E2EMMEAE3906C82 [0:00]
  - 时间戳载体 E2EMMEAE3906C82 [12:34]
```

```xml
<opml version="2.0"> … <outline text="会议主题 E2EMMEAE3906C82">   ← 只有 text，没有时间
<map version="1.0.1"> … <node ID="n1" TEXT="会议主题 E2EMMEAE3906C82">  ← 只有 TEXT
```

**「时间戳只有 md 和 json 带得走，opml/mm 会丢」—— 2026-08-08 仍然成立，三平台实测。**

界面上那句损耗说明**还在**，且与实测完全对得上
（`apps/web/src/app/i18n/locales/zh-CN.json:774`，渲染于
`MindmapExportMenu.tsx:144`）：

> 「只有 JSON 是无损的。时间戳只有 Markdown 与 JSON 带得走 —— OPML 与 FreeMind
> 里没有它，导出后跳不回录音的那一秒。」

`[本机实测]` 它也**真的随包出厂**（在构建产物 `apps/web/dist/assets/i18n-*.js`
里能 grep 到），不是只存在于源码。

⚠️ 附带一条实测细节：`content-disposition` 的 ASCII 回退名会把中文压成下划线
（`jfk (CI _____).md`），但 `filename*=UTF-8''…` 带着正确的名字 ——
这是 RFC 5987 的正常形态，不是缺陷。

### 时间戳判据**刻意不用真转写稿的那个值**

jfk.wav 用 whisper-tiny 只转出 **1 段，起点 0ms**。拿 `0:00` / `0` 去断言
「opml/mm 里没有时间戳」等于断言了个恒真的东西 —— 那正是本仓栽过的
「夹具里恒为假」的镜像面。所以导出这一节改用 `PATCH` 一个合成 ref
（`754321ms` → `12:34`，走的仍是用户编辑导图的真实路径），
判据串在任何文本里都不可能碰巧出现。并且配了两条变异：

- decoy 数字 `999777` 在 md/json 里也必须查不到（证明不是 `includes` 恒真）；
- **把「没有时间戳」这个谓词原样拿去量 md，必须红**（证明缺席检测有区分力）。
  两处共用同一个谓词函数，不是各写一份。

---

## 三、回报重点 ③：星标 / 分页边界**真的跑到了**

`[CI 实测]` 三平台都：造 56 条笔记（走 `POST /api/notes/import` 真实路径），
星标 53 条、留 3 条不加星，然后逐页翻到底：

```
翻了 2 页：50 + 3 条        total=53
```

断言（每条都带**非空虚前提**，防止恒真）：

- `total > 50` —— 不超过一页就等于这条边界根本没跑到，直接红；
- 第 1 页**必须满 50 条**且 `hasMore=true`；
- 所有页并起来的**去重条数 == total** —— 少一条就是被静默吞了；
- **最早建的那条星标笔记必须出现在某一页里** ——
  按 `created_at DESC` 它在最后一页，正是老事故（limit 先切、starred 后筛）
  会吞掉的那一条；
- 变异证明：**只看第一页时，最早那条必须查不到** —— 如期红，
  说明"翻到第二页"这件事真的发生了，不是数据恰好只有一页。

翻页用循环而不是写死两页：写死的话数据一多就会在 `page2.hasMore` 上红，
那是测试的脆弱不是产品的问题，而一个会因为数据变多就红的门禁训练所有人忽略它。
（本机复跑时累计到 212 条、翻了 5 页，同一份断言照常绿。）

另外三条边界也验了：`?starred=0` 被拒 400（不被读成"未加星的"）、
不存在的 `folder` uid 被拒 400（不静默回落到"全部"）、
`offset` 越过 `total` 返回空页而不是绕回第一页。

---

## 四、F4 走的是**真的在线大模型链路**，且没花用户一分钱

约束是「不许用真 Key、不许替他花钱，但产品侧一段都不许绕过」。
做法是**只伪造对面那半**：脚本内起一个本地 OpenAI 兼容端点，
让产品用**它自己的** `OpenAiCompatibleProvider` 去调 —— 那正是产品支持的形态
（`resolve.ts` 的 `kind:'openai-compatible'` + `llm.baseUrl.<id>`，
本来就是给 Ollama / LM Studio 用的，且明写"本地后端可以没有 apiKey"）。

配置也走真接口：`PATCH /api/settings` 写 `llm.providers` / `llm.defaultProviderId`
/ `llm.defaultModelId` / `llm.baseUrl.<id>`，再 `POST /api/notes/:uid/mindmap`。

产品这半**一行没换**：设置读取、provider 解析、`generateMindMap` 的分窗 map-reduce、
`chatStructured` 的 schema 与重试、`parseOutline` 的编号清洗、`refFromIndices`
的时间戳计算、`validate`、落库、SSE。

`[CI 实测]` 假端点三平台各收到 **2 条请求：1 条能力探测（`json_schema` 探测）
+ 1 条真请求**，且**没带 Authorization 头**（回环地址不该要求 key ——
产品做对了，没有伪造一个 `Bearer sk-no-key`）。

判据是 **nonce**：假端点回的主题标题里埋一个本次运行的随机串，
它必须出现在导图节点与四种导出的正文里。产品若在任何一环凭空造了一张图，
nonce 就不在。配了变异：换一个没用过的 nonce 必须查不到。

**这个假端点不是"回什么都行"的桩** —— 它要真读懂输入：user prompt 里每行开头是
`[编号] 原文`，必须把编号解析出来再回引用，否则 `parseOutline` 会把越界编号全丢掉，
得到「没有任何有效主题」然后重试三次失败。

还验了：`generatedBy == llm:<我的 providerId>`、导图可编辑
（`PATCH` → revision 前进 → 回读内容持久 → `generatedBy` 转 `user`）、
非法 doc 被 400 `INVALID_MINDMAP` 拒掉（校验不是摆设）、
未知 format 被 400 `BAD_FORMAT` 拒掉（不静默回落到 md）。

### 时间戳核对是**非循环**的（第一版写错了，已订正）

第一版拿「导图报的 startMs」去转写稿里**找一个相等的段落**，找到就算过 ——
那是循环论证：只证明了它是某个真实段落的起点，**没证明它是对的那一个**，
产品把主题指到隔壁段落照样绿。这正是本仓栽过的第二种假绿
（「断言的是报出来的值，而非实际用的值」）。

现在：**我这边记得自己回给产品的是哪个编号**，期望值直接由
`trSegs[那个编号].startMs` 给出，与产品输出无关。变异是把同一个比对函数
喂一个整体平移 1 秒的段落 —— 必须红（三平台如期红）。
刻意不用"换成转写稿里的另一段"：只有 1 段的转写稿上那种变异永远造不出来，
会被静默跳过。

---

## 五、`?t=` 直达时间点：**服务端这半条链**验了，前端那半说清边界

`?t=` 本身是前端参数（`SearchPage` 发、`NoteDetailPage` 用 `parseSeekParam` 解），
**服务端没有任何 `t` 参数**。所以这一节明确只验服务端那半：

- **F5-e1** segment 命中带得回可用的 `startMs`（`?t=` 的取值来源）；
- **F5-e2 越界边界**：`durationMs > 0`（**上界必须存在且为正** ——
  `parseSeekParam` 明写 `durationMs<=0` 时不夹取，上界一旦是 0，
  "越界夹到末尾"这条产品行为在结构上不可能发生），且命中的 `startMs ≤ durationMs`；
- **F5-e3 媒体未加载完边界**：刚导入、转写没做完时 `GET /api/notes/:uid`
  如实回 `durationMs=0`，**不编一个非零上界**（编了会把对的 `?t=` 夹坏）；
- **F5-e4** 深链 `/notes/<uid>?t=<ms>` 在包里真的可达（200 + 应用外壳）。

⚠️ **F5-e4 第一版是我写错了，不是产品的问题**，值得记一笔：
裸 `fetch` 打这条深链拿到 **404**，我一度以为包里缺网页。
**不是 —— 产品做得对**：SPA 兜底刻意只对真正的浏览器导航生效
（`server.ts:215` 看 `sec-fetch-mode: navigate` 或 `Accept: text/html`），
因为"任何无扩展名路径都回 index.html"会把 `/media/../../etc/passwd`
也变成 200，而**把本该 404 的东西变成 200 就是在遮蔽后端的拒绝**。
改成带浏览器导航头之后 200。并配了变异：**非导航请求打同一条深链不该拿到外壳** ——
如期红，证明那个 200 是 SPA 兜底给的，不是"什么路径都回 200"。

**未验证（明写）**：`parseSeekParam` 的三个分支本身（`clamped` / `malformed` /
媒体未加载时不 seek）是纯前端函数，**本轮 E2E 没有覆盖**；
它们由源码树里的 `apps/web/src/features/notes/seekParam.test.ts` 覆盖
（在 `pnpm -r test` 的基线里）。我没有在真浏览器里点过这条链 —— `[未验证]`。

---

## 六、发现的真实缺陷

### 🔴 软删之后 `GET /api/notes/:uid` 仍然回 200 + 完整正文（三平台复现）

```
GET /api/notes/<已删除的 uid> → HTTP 200
```

- **成因**：`apps/daemon/src/db/repos.ts:290` 的
  `noteByUid()` 是 `SELECT * FROM notes WHERE uid = :uid`，**没有 `deleted_at IS NULL`**；
  `apps/daemon/src/http/rest/notes.ts:562` 的 GET 处理器自己也没补这一条。
- **不一致在于**：列表（`notesFilter`）和搜索（SQL 里的 `n.deleted_at IS NULL`）
  **都已经筛掉它了** —— 同一份 API 对「这条笔记还在不在」给出两种答案。
- **用户形态**：删掉一条笔记之后，任何还留着的链接 / 书签 / 搜索结果深链
  （`/notes/<uid>?t=`）打开仍然是那条笔记的完整内容与音频。
- **我没有修**：修法有两种（404 还是 410、要不要保留"回收站"语义），
  那是 notes 那条线 owner 的决定，不该由一个审计脚本替他做。
- **也没有把它做成红灯**：一个**永远红**的门禁等于没有门禁 —— 它训练所有人忽略这盏灯
  （`cold-start-audit.yml` 里已经写过这条道理）。所以脚本里它是
  **只打印、不判红绿的观测项**（与 `cold-start-audit.mjs` 第 6b 节同一个处理）。
  真被修好之后，脚本会自动改口打印「✔ 回的是 404 —— 与列表、搜索一致」。

**需要 Manager 决策**：这条派给谁、修成 404 还是 410。

### 🟡 我自己脚手架的一个 bug（已修，记下来因为它是一类）

`[CI 实测 run 31247230961]` 三个平台在「解开归档」同时红，
而上一步刚刚成功下载了 43 MB 的包。成因是我写的一行：

```bash
A="$(ls a.tar.xz b.tar.gz c.zip 2>/dev/null | head -1)"
```

linux 只有 `.tar.xz`，`ls` 对另外两个不存在的 glob 返回非零；
`2>/dev/null` **只挡住了 stderr，挡不住退出码**，`set -euo pipefail`
就在赋值那一行把整步毙了。已改成纯 bash 的 nullglob 数组（没有管道、没有
子命令退出码，这类坑在结构上不存在），并在本机用真的 `.tar.xz` + 同名 `.json`
逐字跑过。

⚠️ **值得 Manager 注意的是：另一路 `e2e-import` 在同一天独立踩了同一行同一个坑**
（commit `564b68b`：「取包那步的 `ls 多个 glob` 在 set -e 下必炸 —— 三条腿全死在这一行」）。
两路 agent 各自从零写"取 artifact → 解归档"这段脚手架，各自踩同一个坑、
各自修一遍。**这段该抽成一个共享 step / 脚本**，否则第三路还会再踩一次。

---

## 七、门禁状态（诚实版）

| 门禁              | 结果                                                       |
| ----------------- | ---------------------------------------------------------- |
| `pnpm -r test`    | ✅ **1532 通过 / 0 失败**（基线 1508 守住；+24 是别人新增的 daemon 用例，我这轮加 0 条） |
| `tsc -b`          | ✅                                                         |
| `build:safe`      | ✅                                                         |
| `lint-workflows`  | ✅ 1027 条断言（12 个 workflow）                            |
| `test:ci-scripts` | ✅ 22 passed / 0 failed                                    |
| `check:orphans`   | ✅ **70 / 基线 70**（没升）                                 |
| `eslint`          | ⚠️ 仓库级 5 条 error，**全部在别人的文件里**；我的文件 0 条 |
| `format:check`    | ⚠️ 仓库级红，**3 个文件全是别人的**；我的两个文件 ✅        |

`eslint` 的 5 条在 `scripts/build-bundle.mjs`、`scripts/ci/e2e-runtime-audit.mjs`；
`format:check` 红在 `scripts/build-bundle.mjs`、`scripts/ci/e2e-runtime-audit.mjs`、
`scripts/ci/simulate-user-launch.mjs`。**这三个文件我一个字都没碰**，
当时都处在别的 agent 未提交的编辑中途（`scripts/build-bundle.mjs` 一度**语法都不完整**，
`node --check` 直接报 `SyntaxError`）。按 PROTOCOL §10「在最坏的那一秒，别人看到的是什么」
——我看到的就是那一秒，所以**不认领、也不代为格式化**（那会改到别人的交付物）。
我自己的两个文件单独跑 `prettier --check` 与 `eslint` 都是干净的，
prettier 跑两遍到不动点。

`pnpm -r test` 有一轮出现过 `fail 1`，紧接着两轮全量复跑都是 0 ——
**我没能定位到是哪一条**（当时的 grep 把它滤掉了），标 `UNKNOWN`。
考虑到当时有三路 agent 正在往同一棵树里写文件，偶发的可能性很大，
但我不替它下结论。

⚠️ **提交前核对过 `git diff --cached --name-only` 的全量列表**，两次提交都**只有我自己的文件**：
`.github/workflows/e2e-notes.yml`、`scripts/ci/e2e-notes-audit.mjs`。

---

## 八、纪律与边界

- 新建自己的 workflow，**没有改任何别人的**（`cold-start-audit.yml` /
  `build-bundles.yml` / `start.cmd` / `OpenMemo.command` / `start.sh` 一个字没动）。
- `cold-start-audit.mjs` 是**调用**，不是复制：F4 的硬前提（一条带转写稿的笔记）
  由它造，我不另写一份下载 + 转写的实现。判据只要有两份实现就会漂成两条。
- **屏蔽宿主 PATH**（同名假二进制放 PATH 最前，不删目录）。
  `[CI 实测]` 三平台**借了宿主 0 个**，产品自己下载并校验的 5 个
  （`tool.ffmpeg` / `tool.ffprobe` / `tool.whisperCli` / `tool.whisperVad` / `tool.ytDlp`）。
- `OPENMEMO_POINTER_FILE` 一律重定向到临时目录（§9），**绝不写**机器级指针；
  变异实例的数据目录用 `mkdtemp`；跑完就删，**被 kill 也不会留下机器级坏状态**（§9-bis）。
- 端口 199xx 段（19960 / 19961 / 19970），避开 `:10000`、`17650`，
  也避开测试文件的最高游标 19900+30。
- 没有 `pkill -f`（只 kill 自己 spawn 的 child）；没建 / 改 / 删任何 release；
  没碰 `/root/data-memo`、没碰 `:10000`。
- 断言 DOM / 对象一律先转字符串再比并截断（§8，不会 OOM 成"测试文件炸了"）。

## 九、未验证 / UNKNOWN（明写）

- `parseSeekParam` 的 `clamped` / `malformed` / 媒体未加载三个分支：**本轮 E2E 未覆盖**，
  由源码树单测覆盖；真浏览器里没点过 —— `[未验证]`。
- 转写稿只有 **1 段**（jfk.wav + whisper-tiny），所以「多段导图分窗 map-reduce」
  只走了 1 个窗口 —— **多窗口 reduce 路径本轮没跑到** `[未验证]`。
- `pnpm -r test` 那一次 `fail 1` 具体是哪条 —— `UNKNOWN`（复跑不再出现，未能定位）。
- 本轮验的是 **v0.2.0 那个包**（build-bundles run `31208766871` 的 artifact），
  **不是当前 HEAD 组装出来的包**。HEAD 上 `scripts/build-bundle.mjs` 当时正被别人改着，
  我没有、也不该在那个中间态上组装。
- ⚠️ 任务书里写的 runner 是 `macos-14`，但 `cold-start-audit.yml` **现用的是 `macos-26`**。
  按「照抄现用版本」取了 `macos-26`。若确实要 `macos-14`，请 Manager 明示 ——
  两个 workflow 的平台口径分叉会让"某平台验过了"这句话失去意义。

下一步建议:

1. 派人处置「软删之后 GET 仍回 200」，定 404 还是 410。
2. 把「取 build-bundles artifact → 解归档 → 拿包根」抽成共享 step —— 两路 agent 已各踩一次。
3. 别的 agent 手上那三个文件收工后，重跑一次仓库级 `format:check` / `eslint` 收口。

需要 Manager 决策: 上面第 1、2 条；以及 `macos-14` vs `macos-26` 的口径。

---

## [2026-08-08 17:05] 软删除 404 修复 + 仓储层同形漏审计 DONE

交付:

- `apps/daemon/src/db/repos.ts`（修 2 行 SQL + 写下读取契约）
- `apps/daemon/src/db/repos.softDelete.test.ts`（新建，6 条，两侧都钉死）
- `scripts/ci/e2e-notes-audit.mjs`（观察翻成断言 + 修我自己一个"数据一多就换答案"的前置检查）
- `.github/workflows/e2e-notes.yml`（默认模式改判 + 组装模式的 cp 修复）
- commit `1350786`（修复）、`3bd6201`（默认模式）、`f0d1f2e`（cp 修复）

**CI 实测：run `31249521405`，三平台全绿，各 35 条断言 + 10 条变异证明、0 失败。**

| 平台 | `F5-a5` 已删除 → GET | `F5-a6` 写路径 | 变异（拿活笔记量"必须 404"） |
| --- | --- | --- | --- |
| linux-x64 | ✅ 404 `NOTE_NOT_FOUND` | ✅ PATCH/star/export 全 404 | ✅ 如期红（实得 200） |
| darwin-arm64 | ✅ 404 `NOTE_NOT_FOUND` | ✅ 全 404 | ✅ 如期红 |
| win32-x64 | ✅ 404 `NOTE_NOT_FOUND` | ✅ 全 404 | ✅ 如期红 |

---

### 一、回报重点：仓储层**还有一个**同形漏 —— `folderByUid`

先说审计范围，好让"有没有漏掉"这件事可判定：

- **全库只有两张表有 `deleted_at`**：`notes`（`0001_init.sql:96`）与 `folders`（:73）。
- **`repos.ts` 之外没有任何地方直接 SQL 读 `notes`**
  （`grep "FROM notes\b"` 去掉 repos.ts 与测试之后为空）——
  所以仓储层是**唯一收口点**，修在这里就够，不需要每个 handler 补一句。

逐个函数的结论：

| 函数 | 之前 | 处置 |
| --- | --- | --- |
| `noteByUid` | ❌ 没过滤 | **补** `AND deleted_at IS NULL`（已知缺陷） |
| **`folderByUid`** | ❌ 没过滤 | **补** —— **本轮新查出的第二个同形漏，此前没人撞到过** |
| `noteById` | 没过滤 | **刻意保留**（见下方契约） |
| `folderById` | 没过滤 | **刻意保留** |
| `folderSubtreeIds` | 没过滤 | **刻意保留**（它自己就是删除路径，要能重扫已删子树） |
| `listNotes` / `countNotes` / `listFolders` / `folderNoteCounts` / `nextFolderSortOrder` / `FOLDER_CLOSURE_CTE` / `search.ts` | ✅ 本来就有 | 不动 |

**`folderByUid` 的用户可见形态**（5 个调用点全是 API 入口）：最难看的一格是
**把笔记移进一个已软删的文件夹** —— 请求成功（200），而侧栏的文件夹树来自
`listFolders()`（过滤已删）、计数来自 `folderNoteCounts()`（走 `FOLDER_CLOSURE_CTE`，
同样过滤已删）。于是那条笔记挂在一个**界面上不存在的文件夹**下面：
它仍在「全部笔记」里所以不丢数据，但归属是错的，而且用户**改不回来**
（那个文件夹他根本点不到）。

⚠️ 另外值得记一笔：`folderById` 原本的注释写着
「不过滤 `deleted_at` —— 由调用方决定"已删"要回 404 还是照常处理」。
那句话描述的是一个**不存在的分工**：5 个调用点**没有一个**检查过 `deleted_at`。
一条把责任推给调用方、而调用方并不知情的注释，比没有注释更坏 ——
读到它的人会以为这件事已经有人管了，于是不去建。（与 `generate.ts` 那条
"把问题带出去"的注释是同一个形状。）

**`noteByUid` 的严重性也比原先报告的高**：它有 10 个调用点，全是 API 入口 ——
改标题、改正文、锚点、重新转写、生成导图、导出、打星标、改标签、移动文件夹。
也就是说一条"已删除"的笔记此前**还能被继续编辑和重新转写**，不只是能被读到。
所以 E2E 里除了 `F5-a5`（读）另加了 `F5-a6`（写路径同样 404）。

### 二、产品内部真需要读已删记录的地方，怎么处理的

写成一条**显式契约**，就放在两个函数正上方（`repos.ts`）：

> **`uid` 是对外标识，`id` 是内部 rowid —— 两者的删除语义刻意不同。**
> `*ByUid()` 只看未删的：uid 是 HTTP 上唯一能被外界说出来的名字，
> 所以凡是从 uid 进来的请求，"已删"就必须等于"不存在"。
> `*ById()` 包含已删的：id 只有**已经握着引用**的内部代码才拿得到
> （job payload、刚 INSERT 的 rowid、闭包查询结果），
> 它们要的是"那一行还在不在库里"，不是"用户还看不看得见它"。

四个合法消费者，逐个写进了注释：

1. `main.ts` 把 job 列表里的 `note_id` 翻成标题 —— 笔记删了，那条 job 仍在任务中心，
   **标题不该因此变成空白**；
2. `folderAncestorIds()` 的环检测 —— 被一个已删节点挡住就等于瞎了；
3. `softDeleteFolderTree()` / `folderSubtreeIds()` —— 它自己就是删除路径，
   必须能重扫已删子树（`markDeleted` 带 `AND deleted_at IS NULL` 保证幂等）；
4. `createNote()` / `createFolder()` / `updateFolder()` / `content.ts` 回读刚写的那一行。

**没有走"新增一个 includingDeleted 变体"那条路**，两个理由：
① 那要改 `main.ts` 等文件，而它们当时正被别的 agent 改着（纪律：别动他们的文件）；
② uid/id 的分工本身就是一条**能站住的契约**，不是权宜 —— id 拿不到就说明调用方
本来就没有引用，那种代码根本到不了这里。
若 Manager 更想要显式命名（`noteByIdIncludingDeleted`），那是一次纯机械改名，
建议等 `main.ts` 空出来再做，**并且照样得保留这条契约注释**。

### 三、那条观察翻成断言之后长什么样

原来是"只打印、不判红绿"的观测项（缺陷未修时那个处理是对的 ——
**永远红的门禁等于没有门禁**）。现在缺陷修了，翻成三条：

```
✔ F5-a5 ★ 软删之后 GET 这条笔记回 404 —— 与列表、搜索口径一致  —— HTTP 404 NOTE_NOT_FOUND
✔ F5-a6 ★ 已删除的笔记不能再被编辑 / 打星标 / 重新转写（写路径同样 404）
✔ [变异] F5-a5 的证伪能力（拿活着的笔记去量"必须 404"，必须红）—— 如期变红：期望 404，实得 200
```

两个刻意的选择：

- **断言的是 404 这个具体码，不是"反正别 200"** —— 400/500 也不是 200，
  但它们都不是"这条笔记不存在"的正确表达；顺带把 `error.code` 也钉成 `NOTE_NOT_FOUND`。
- **配了变异**：不加的话，"删掉的回 404"可能只是因为**这个 uid 从来就不存在**
  （拼错也 404），断言等于空的。拿一条**活着的**笔记去量同一个谓词，必须红。

### 四、反向验证（PROTOCOL §10：跑在 `/tmp` 隔离副本，共享工作树一个字没动）

把 `apps/daemon/src` 整棵拷到 `/var/tmp/e2e-mut`、`node_modules` 用符号链接借主树的，
在**副本里**改 `repos.ts`：

```
对照组（未变异）                                          → pass 6 · fail 0
变异 A：拿掉 noteByUid 的 deleted_at 条件（复现原缺陷）    → fail 1
变异 B：拿掉 folderByUid 的条件                           → fail 2
变异 C：「顺手统一」把 noteById 也过滤掉                   → fail 1  ★
还原后对照组                                              → pass 6 · fail 0
```

**变异 C 是这组里最该留意的一条**：它证明「`*ById` 仍然读得到」这一侧也被钉住了。
只钉 uid 那一侧的话，哪天有人把两边"统一"成都过滤，
`main.ts` 里那些笔记已删、job 还在任务中心的条目会**集体失去标题，而没有任何测试会红**。
跑完已确认共享树里 `repos.ts` 无任何变异残留（三条 grep 计数：1 / 1 / 0）。

### 五、顺带修掉的两个我自己的东西

1. **E2E 前置检查"数据一多就换答案"**：原来只看 `GET /api/notes?limit=200` 的第一页
   找带转写稿的笔记。CI 上碰巧一直对（全新数据目录），但本机连跑几轮攒到 **233 条**
   之后，jfk 是**最早**建的那条、按 `created_at DESC` 掉出了第一页 ——
   脚本于是报「一条带转写稿的笔记都没有」，那句话读起来像产品结论，其实是我的窗口太小。
   改成翻完所有页 + 按 `durationMs>0` 粗筛（筛不到**退回全扫**，不让优化变成新的静默依赖）。

2. **workflow 默认模式改判**（这条值得 Manager 看一眼）：
   修完 404 之后 E2E 多了「已删除必须 404」，而 v0.2.0 那个 artifact 是**修复之前**
   编出来的 —— 拿新断言去量旧产物，它**理应**红。这不是 bug，是我把两件事挤进了
   一个默认值：「HEAD 有没有回归」和「某个已发布的包有没有毛病」是两个问题。
   默认取"最近一次成功的 artifact"还会让门禁含义随**别人什么时候跑 build-bundles**
   而漂移 —— 正是本仓最怕的「结论取决于机器状态」。
   → 默认改成 `assembleFromSource: true`（用本次 checkout 现场组装；**仍然是预编译包**：
   同一个 `build-bundle.mjs`、包自带的 Node、走产品自己的 HTTP）；
   发布审计降为**显式**模式（`assembleFromSource: false` + `bundleRunId`）。
   **模式 ② 对着旧包报红是有价值的信息**（"这个发布确实带着那个毛病"），
   已在 workflow 注释里写明：不要因为它红就去删断言。

3. **`cp dist/bundles/*` 被暂存目录噎住**（`[CI 实测 run 31249161030]` 三平台同时红，
   而包已经好好打出来了）：那个目录里除了归档还有组装暂存目录，`cp` 没 `-r` 碰到目录就 exit 1。
   **这是同一类 shell 坑的第三次**（前两次是 `ls 多个 glob` 在 `set -e` 下的退出码，
   其中一次是 `e2e-import` 那路独立踩的）。照同一个结构修：nullglob 数组 + 空集显式报错。
   → **再次建议把"取包 / 组装 → 解归档 → 拿包根"抽成共享 step**，三次了。

### 六、门禁（**在 `/var/tmp/e2e-gates` 这个干净 worktree 上跑的，检出我自己的 commit `1350786`**）

按 Manager 要求，工作区脏就另开 worktree 跑门禁。结果是**八项全绿**：

| 门禁 | 结果 |
| --- | --- |
| `pnpm -r test` | ✅ **1541 通过 / 0 失败**（含我新增的 6 条；基线 1508 守住） |
| `tsc -b` | ✅ |
| `eslint` | ✅ **全仓 0 条**（上一轮那 5 条确认是别人在途文件，现已随他们提交消失） |
| `format:check` | ✅ **全仓通过**（同上） |
| `build:safe` | ✅ |
| `lint-workflows` | ✅ 1113 条断言（13 个 workflow） |
| `test:ci-scripts` | ✅ 22 passed / 0 failed |
| `check:orphans` | ✅ **70 / 基线 70**（没升） |

这一轮**全仓 `eslint` 与 `format:check` 都是干净的** —— 也就是说上一轮我标注的
"红在别人在途文件上"得到了独立印证：那些文件提交之后，红自己消失了，我一个字没碰。

⚠️ 三次提交前都核对过 `git diff --cached --name-only` 的全量列表，
每次都**只有我自己的文件**（`repos.ts` / `repos.softDelete.test.ts` /
`e2e-notes-audit.mjs` / `e2e-notes.yml`）。

### 七、未验证 / UNKNOWN

- **真浏览器里没点过**：删完之后前端拿到 404 的渲染表现（是跳回列表还是显示错误页）
  `[未验证]` —— 我只验到 HTTP 层。
- 「把笔记移进已软删文件夹」那一格，我是**读码 + 单测**确认的
  （`folderByUid` 现在读不到 → `organize.ts:511` 回 404），**没有在 HTTP 层专门跑一遍**
  `PUT /api/notes/:uid/folder {folderUid:<已删>}` `[未验证]`。
  单测钉的是仓储层那一侧，够守住回归，但不是端到端证据。
- `main.ts` 的 job 标题回填在**笔记已删**时的真实表现，我是靠契约与单测保证的，
  **没有真的删一条笔记再去看任务中心** `[未验证]`。
- 本轮三平台验的是**本次 checkout 现场组装的包**，不是 v0.2.0 那个发布产物
  （原因见上方第五节第 2 条）。v0.2.0 **确实带着这个缺陷**，
  用发布审计模式指着 run `31208766871` 跑会红 —— 那是事实，不是门禁坏了。

下一步建议:

1. 下次发版前跑一次 build-bundles，再用**发布审计模式**对新 artifact 跑一遍 e2e-notes，
   确认这个修复真的进了要发出去的那个包。
2. 把"取包/组装 → 解归档 → 拿包根"抽成共享 step（同类坑第三次了）。
3. 若要把 `noteById` 显式改名成 `noteByIdIncludingDeleted`，等 `main.ts` 空出来再做。

需要 Manager 决策: 上面第 2、3 条。

---

## [2026-08-08 18:40] 取包/解包脚手架提成共享的一份 DONE

交付:

- `scripts/ci/resolve-bundle.mjs`（新建，共享脚手架）
- `scripts/ci/selftest-resolve-bundle.mjs`（新建，11 条反向验证，已挂进 `pnpm test:ci-scripts`）
- 四条腿改用它：`e2e-notes.yml` / `e2e-import.yml` / `e2e-record.yml` / `e2e-runtime.yml`（后者两处）
- `scripts/ci/e2e-notes-audit.mjs`（补齐 PROTOCOL §11）
- commit `2824e03` → `5df6679` → `…` → 最终 `31251924045` 验证通过

**CI 实测：run `31251924045`，三平台全绿，各 35 条断言 + 10 条变异证明、0 失败。**

```
linux-x64    归档 openmemo-0.2.0-linux-x64.tar.xz（43,023,716 B）→ 包根 …/openmemo-0.2.0-linux-x64
             ✔ app/daemon/dist/main.js   ✔ runtime/node
darwin-arm64 归档 …-darwin-arm64.tar.gz（62,848,886 B）
             ✔ app/daemon/dist/main.js   ✔ runtime/node
win32-x64    归档 …-win-x64.zip（51,405,463 B）
             ✔ app/daemon/dist/main.js   ✔ runtime/node.exe   ← 拼写按平台，见下
```

---

### 一、选型：`scripts/ci/` 下的 **Node 脚本**，不是 composite action

两条依据，**第二条是决定性的**：

1. **病因就是 shell 语义本身。** 三次事故全部是「glob 匹配不到时的退出码」与
   「`cp`/`ls` 碰到目录的行为」。composite action 里装的还是 bash ——
   等于把同一段危险代码换个地方放，下一次照样撞。
   换一门**不用 glob 退出码决定成败**的语言，这一整类 bug 在结构上消失。
2. **composite action 的 bash 在本机永远跑不到。** 本仓 `package.json` 自己写着判据：
   「`.github/workflows/**` 里的关键步骤在本机跑一遍。**CI 从来没执行过，
   所以它里面装着从来没被执行过的错误**」——`lint-workflows.mjs` 与
   `test:ci-scripts` 就是为这件事存在的。放进 `scripts/ci/` 才能被 selftest
   逐个坏输入量一遍，并挂进**已有**的门禁。

> 一段"只有推上去才知道对不对"的共享脚手架，是把三次事故的成因**集中**了，不是修掉了。

这个判断当场就被验证了 —— 见下面第四节：**共享脚手架自己带着两个 bug 出厂**，
两个都是 selftest 补上用例之后才钉住的。

（另：`e2e-runtime` 早就有 `scripts/ci/resolve-bundle-run.sh` 干 run-id 解析，
本仓已有"CI 逻辑放 scripts/ci"的先例，我这份是它的下一段，不重叠。）

### 二、哪些参数**必须各腿自留**（以及为什么）

| 东西 | 处置 | 依据 |
| --- | --- | --- |
| **取包方式**（`gh run download` / `actions/download-artifact` / 现场组装） | **各腿自留** | 差异是真的（前者能在 shell 里挑 run，后者有 `run-id` 输入）。所以**接缝定在字节已落盘之后**：给我一个目录，我只管挑归档→解开→找根→验结构。 |
| **`e2e-runtime` 的 `--skip-archive` 组装路线** | **不走这个脚手架** | 那条路**压根没有归档**，硬套会得到 `NO_ARCHIVE`。只有它的 artifact 路线用共享脚手架。 |
| **模式默认值**（回归门禁 vs 发布审计） | **各腿自留** | 见第五节，这是一条刻意的不对称。 |
| **`--require` 要哪些条目** | **各腿自留** | `e2e-import` 只要 daemon 入口；notes/record/runtime 还要包自带 Node。不替它们猜。 |
| **包自带 Node 的*文件名*** | **收进共享脚手架** | 见下 ⚠️ |
| **Windows 的 `unzip \|\| tar` 兜底** | **统一** | `import`/`record` 有、`notes`/`runtime` 没有 —— 后两条只是**碰巧**没撞上（runner 镜像里恰好有 unzip）。这不是有意为之的差异，是漏。 |

⚠️ **最值得记的一条**，因为我在这上面栽了一次（`[CI 实测 run 31251484499]`
linux ✅ darwin ✅ **win32 ✘ MISSING_ENTRIES**）：

> **统一"意图"是对的，统一"拼写"是错的。**

各腿要问的意图是同一个「这个包自带运行时吗」；而文件名在 posix 上是
`runtime/node`、Windows 上是 `runtime/node.exe`。我一开始三条腿统一写死
`runtime/node` —— 那是**把拼写也统一了**。但正确的修法**也不是**退回各腿去拼
`${{ matrix.leg == 'windows' && '.exe' || '' }}`（那等于把同一条知识抄三份，
下一条腿照样写错）：**拼写是包格式的知识，不是每条腿的知识**，
所以收进 `resolve-bundle`，各腿只用 `--require-node-runtime` 表达意图。

### 三、三种坏输入的反向验证（`selftest-resolve-bundle.mjs`，11 条，已进 `test:ci-scripts`）

刻意分两组，**别混着看**：

**A 组「必须绿」= 三次真实事故的输入形状。** 那三次都是**假红**（包好好地打出来了，
是脚手架自己把步骤带走了），所以新脚手架对这些输入必须**成功**：

```
✔ A1 只有一种扩展名匹配得到（旧写法 `ls a b c 2>/dev/null|head -1` 必炸）→ 成功
✔ A2 归档旁有暂存目录 + .json 清单（旧写法 `cp dist/bundles/*` 必炸）→ 成功
✔ A4 --out 目录还不存在 → 自己建出来并成功
✔ A3 --require + --require-node-runtime 齐全 → 成功
```

**B 组「必须红，且理由要对」。** 不只要求红，还要求**红出正确的那个代码** ——
一个"反正失败了"的错误信息和没有错误信息差不多：

```
✔ B1 一个归档都没有            → NO_ARCHIVE
✔ B2 两个归档并存              → MULTIPLE_ARCHIVES   ★ 新护栏
✔ B3 归档是坏的                → EXTRACT_FAILED
✔ B4 解出多个顶层目录          → MULTIPLE_TOP_DIRS   ★ 新护栏
✔ B5 包里没有自带 Node          → MISSING_ENTRIES
✔ B6 归档里没有顶层目录        → NO_TOP_DIR
✔ B7 --from 目录压根不存在      → NO_ARCHIVE（§11：跳过不许渲染成成功）
```

★ 两条**新护栏**：四条腿此前全是 `head -1` / `[0]` —— 两个归档并存 / 解出两个顶层目录时
**随便挑一个然后照常报绿**。那种绿灯追溯不到"到底验的是哪个东西"，正是 §11 的判据要否掉的。

### 四、⚠️ 共享脚手架自己带着两个 bug 出厂 —— 而这正是我在文件头担心的那件事

写文件头时我写了一句：「把三段重复代码合成一段，如果它自己有 bug，
就从"三条腿各红一次"变成**四条腿一起红**」。**它当天就发生了两次。**

1. **漏了 `mkdirSync(outDir)`**：`tar -C <dir>` / `unzip -d <dir>` 都不会替你建目录。
   三条腿一起红成 `EXTRACT_FAILED`（e2e-record run 31250861440、e2e-notes run 31251083538）。
   **为什么 selftest 没抓住 —— 这条比 bug 本身值得记**：夹具 `fresh()` 自己
   `mkdirSync` 了 out 目录，**比真实调用方更宽容**；夹具替被测代码把前提凑齐了，
   那个分支于是从来没被走到。**与本仓"断言的字段在夹具里恒为假"是同一族：夹具比现实友善。**
   → 补了 A4 用例，并在 `/tmp` 隔离副本上反向验证（拿掉 `mkdirSync` → A4 如期红），
   共享树未被污染（grep 计数复核）。
2. **`runtime/node` vs `node.exe`**（见第二节）。

两个都已修 + 补用例 + CI 三平台复验通过。
`e2e-record` 的 owner 当时自己加了 `mkdir -p unpacked` 兜底 —— 修好之后那行是无害的冗余，
**我没有去动他的文件**。

### 五、PROTOCOL §11 的落实

**`resolve-bundle.mjs`**：外部命令（`tar`/`unzip`）全部走 `spawnSync` 的 `timeout`，
且 `EXTRACT_TIMEOUT` 与 `EXTRACT_FAILED` **分开报**（一个是环境、一个是坏包，处置不同）；
**没有任何"没事可做就退 0"的路径** —— `--from` 不存在也是红。
它不起服务、不占端口，所以「端口」「进程树」两条不适用（适用的是各腿的 daemon 部分）。

**`e2e-notes-audit.mjs`**（我的腿，此前**确实有** §11 那个洞）：

- **起服务前先证明端口是空的**，不空当场判失败。
  `[实测]` 拿一个冒名 HTTP 服务占住 19960 → 脚本当场红
  `PORT_IN_USE: 19960 上有残留进程在应答（HTTP 200 version=IMPOSTOR）`，
  而不是连上它报绿。
- ⚠️ **只问 HTTP 不够**（这条是实测撞出来的）：上一个占用者**正在关闭**时
  HTTP 已经连不上（看起来"空了"），而套接字仍被占 —— daemon 起来一 bind 就失败，
  **静默漂到下一个端口**（`[实测]` 漂到了 `--llm-port`，那之后我再探测就会
  对着错的进程说话）。所以判据改成「既没人答话、**也能被我 bind 住**」，
  并对日志里的端口漂移单独出声。
- **收尾按 pid 收整棵进程树**：Windows 用 `taskkill /T`，POSIX 用 `detached` + 进程组
  `process.kill(-pid)`。**绝不 `pkill -f`**（模式匹配会打到别人的进程）。

### 六、附带查出的一个真缺陷：「跳过」被渲染成「成功」（§11 的教科书式发作）

`e2e-import` 本轮在三平台红在 `no artifact matches any of the names or patterns provided`
—— **不是我的改动造成的**。追下去：

```
build-bundles run 31249135458   conclusion = success
  success  bundle-macos-arm64
  skipped  bundle-linux-x64      ← 跳过
  skipped  bundle-win-x64        ← 跳过
→ 整个 run 只有 bundle-darwin-arm64 一个 artifact
```

而 `e2e-import` / `e2e-runtime` / 我的审计模式都用「取**最近一次成功**的 build-bundles run」。
**一个 2/3 被跳过的 run 对外是绿的**，于是自动选择就选到了它，
下游拿到一句没头没尾的 `no artifact matches`。

我在**自己的腿**里加了诊断（选定 run 之后核对该 artifact 是否真的存在，
不存在就说清是"部分平台的 run"并给出处置）。
`e2e-import` 与 `resolve-bundle-run.sh` 里的同一处**我没动**（不是我的文件）——
**建议 Manager 派给它们的 owner**，或把「选一个真的有该 artifact 的 run」也收进共享脚手架。

### 七、另一个不是我的文件、但值得记的潜伏 bug

`scripts/build-bundle.mjs` 的 `--out` **不能传相对路径**：归档那一步是
`execFileAsync('tar', [flag, out, NAME], { cwd: OUT_ROOT })` —— `cwd` 已切进 `OUT_ROOT`，
而 `out` 仍是相对 `OUT_ROOT` 拼出来的，于是 tar 去找 `bundle-artifact/bundle-artifact/…`。
`[CI 实测 run 31250696962]` 三平台全红。**我没有动它**，改用默认 `dist/bundles` 绕开
（共享脚手架本来就吃得下"归档旁边有暂存目录"，selftest A2 就是这个形状）。

### 八、把「回归门禁 vs 发布审计」这条写进正文（Manager 要求）

> **「HEAD 有没有退化」和「发布版 X 有没有这个 bug」是两个不同的问题，
> 不该共用一个默认值。**
>
> · **回归门禁**：对**本次 checkout 组装的包**跑全部断言。它仍然是预编译包 ——
>   同一个 `build-bundle.mjs`、包自带的 Node、走产品自己的 HTTP，
>   与用户下载的那个**同一条生产线**，只是更新。这是默认。
> · **发布审计**：显式指定某次 build-bundles 的 artifact，对它跑同一套断言。
>
> **发布审计对着旧包变红是信息，不是故障。** 本轮修掉「软删之后 GET 仍回 200」之后，
> 拿新断言去量 v0.2.0，它**理应**红 —— 那句红话的意思是"这个发布确实带着那个毛病"。
> **不要因为它红就去删断言。**
>
> 反过来，把默认设成"取最近一次成功的 artifact"，会让门禁的含义随
> **别人什么时候跑过 build-bundles** 而漂移 —— 那正是本仓最怕的
> 「结论取决于机器状态」。第六节那个 skipped-as-success 的 run 就是活证据。

### 九、门禁（在 `/var/tmp/e2e-gates2` 干净 worktree 上跑，检出我自己的 commit）

| 门禁 | 结果 |
| --- | --- |
| `pnpm -r test` | ✅ **1558 / 0 失败**（基线 1552 守住） |
| `tsc -b` / `eslint` / `format:check` / `build:safe` | ✅ 全仓干净 |
| `lint-workflows` | ✅ 1147 条断言（13 个 workflow） |
| `test:ci-scripts` | ✅ 22 + **resolve-bundle 反向验证 11 条** |
| `check:orphans` | ✅ **70 / 基线 70** |

⚠️ 每次提交前都核对了 `git diff --cached --name-only` 全量列表。
⚠️ **我改了三条别人的腿**（`e2e-import` / `e2e-record` / `e2e-runtime`）——
这是 Manager「让四条 e2e 腿都用它」的明确指派；改动是机械替换 +
`e2e-import` 的消费者名 `outputs.dir` → `bundle_dir` 对齐，各腿的真实差异都保留了。
`/tmp` 用完即清，当前 7.2G 空闲；worktree 已 `git worktree remove`。

### 十、未验证 / UNKNOWN

- **只有 `e2e-notes` 这条腿在 CI 上跑通了共享脚手架**（三平台，run 31251924045）。
  `e2e-record` 的 owner 顺手验到了解包这一步（run 31250861440 的红就是它报的）。
  **`e2e-import` 与 `e2e-runtime` 改用共享脚手架之后，我没有在 CI 上跑通过整条腿**
  `[未验证]` —— `e2e-import` 那次红在取包（第六节，与我的改动无关），
  `e2e-runtime` 我一次都没 dispatch 过（它是别人的腿，且要占三台 runner）。
  静态上过了 `lint-workflows` 与 YAML 解析，动态上没有。**建议由各自 owner 跑一次收口。**
- `EXTRACT_TIMEOUT` 这条分支**没有被真的触发过** `[未验证]`：造一个"解压超过 10 分钟"的
  归档代价太大，selftest 里没有它。代码路径与 `EXTRACT_FAILED` 只差一个判断。
- 第六节那个「选一个真的有该 artifact 的 run」**只在我的腿里加了诊断，没有加自动挑选**。

下一步建议:

1. 派人处理第六节：`e2e-import` 与 `resolve-bundle-run.sh` 的「最近一次成功 run」
   要改成「最近一次**真的有该 artifact** 的 run」，或至少加同样的诊断。
2. `build-bundle.mjs` 的 `--out` 相对路径 bug（第七节）。
3. `e2e-import` / `e2e-runtime` 各自 dispatch 一次，把共享脚手架那一步收口。

需要 Manager 决策: 上面三条的归属。
