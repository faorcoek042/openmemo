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
