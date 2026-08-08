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
