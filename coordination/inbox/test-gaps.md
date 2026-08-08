# test-gaps —— 护栏本身的债（T-142）

---

## [2026-08-04 01:35] T-142e DONE —— 参考服务器关进盒子 + 端口判据变成会红的东西

门禁 **`867 passed / 0 failed / 0 todo`**（`tsc -b` 0 · `eslint` 0 · 变异 18/18 全红）。
**867 = 856 + 11**，新增的全是护栏：`testPorts.test.ts` 5 条 + `storeRootPrecedence.test.ts` 6 条。

**动过的文件（精确，未 `git add`）**：
`packages/downloader/scripts/reference-server.mjs`（改）、
`apps/daemon/src/testPorts.test.ts`（新）、
`packages/pipeline/src/__tests__/storeRootPrecedence.test.ts`（新）。
**在途核对**：动手前后各 `git status` 一次，工作区只有我这三个文件 ——
`path-guard` 的 `assetPaths.ts`/`selfcheck.ts` 与 `notes-contract` 的笔记契约都已进 `a401d59`/`20987e3`，
我一个字没碰。

### ① 固定名 `/tmp/openmemo-refserver` → `--models-root` 必填

不带就 `exit 2`，并把老兜底原样印出来说明它为什么危险。
同时**去掉 `process.env.OPENMEMO_MODELS` 这条读取**（全文件现在只剩注释里那一处，描述的是旧代码）。

顺带按你说的，**不再把上一次运行写下的 `active.json` 读回来当真相** ——
每次启动都从 `{asr:null, llm:null}` 开始。文件仍然写（供人事后查看），
但在 `persistActive()` 上单独标明**永远不读回来**，免得下一个人以为它是状态来源。

### ② 删除许可证：标记文件（这条你说最重，我做成了"指错了也删不动"）

不是"记得别导出那个变量"，判据是 **store 根目录里必须有本工具亲手放下的
`.openmemo-refserver-sandbox`**。两道：

- **启动时**：目录非空且无标记 → 拒绝启动（`exit 2`）；
- **每次删除前重新读一遍磁盘** —— 不信任启动时那次检查，因为进程可能已经跑了几小时，
  `--models-root` 底下的东西可能已经被换掉了（比如换成指向真实 store 的符号链接）。
  一次 `access` 很便宜，而它挡的是"删错了就没了"。

`[实测]` 四条路径全验：

```
① 不带 --models-root
   `--models-root` 是必填的。…                                    exit=2

② 指向「非空且无标记」的目录（模拟用户真实模型库）
   拒绝启动：/tmp/…/fakestore-bQHn 里已经有东西，但没有本工具的沙箱标记。  exit=2
   用户的假模型包还在吗: pretend-installed-pack          ← 一个字节没动

③ 全新目录 → 自建 + 放标记 → 删除类端点正常
   POST /api/models/gc → 200

④ 运行中把标记删掉（模拟 --models-root 被换成真实 store）
   POST /api/models/gc          → HTTP 403  NOT_A_SANDBOX
   DELETE /api/models/:id       → HTTP 403  NOT_A_SANDBOX
```

（③④ 起的是 19451 端口，跑完按**精确 pid** 停掉，未用 `pkill`。）

另：`OPENMEMO_MODELS=<真实库>` 现在对它**完全没有影响** —— 它压根不看那个变量了。

### ③ 默认端口 17650 → 19450，并且**纳入了那个会红的检查器**

新增 `apps/daemon/src/testPorts.test.ts`（5 条），扫全部 daemon 测试 + 参考服务器默认端口。

判据我特意挑了**不可能误判**的那个：**所有端口基数 ≥ 19000** ——
不是"不许等于 17650"。理由是 `maxPort` **只向上扫**，起点在 19000 以上就永远回不到 17650，
于是这条判据**不需要算出每个区间到底多宽**，也就不会因为算错宽度而误红（假红灯同样要当 bug）。
另外两条：基数两两至少隔 30（node:test 并行跑，两个文件挑同一段会互抢）、
能静态算出宽度的写法必须真的放得下。

**最重要的一条是它不许变瞎**：每一行 `const port = …` / `let portCursor = …`
都必须被归入某一类，**归不了类就当场红**并打出原文。
扫描器最坏的失败不是报错，是遇到没见过的写法就跳过、然后一直报绿。

**四种失效都反向验过（`[实测]`，每次只坏一处，跑完还原）**：

```
P1 把 settings.roundtrip 改回撞 17650 的老写法  → fail 1  ✖ 端口基数必须 ≥ 19000
P2 参考服务器默认端口改回 17650                 → fail 1  ✖ 参考服务器默认端口…
P3 两个文件挑到挨太近的基数                     → fail 1  ✖ 各段之间不许挨太近
P4 引入一种扫描器没见过的写法                   → fail 1  ✖ 扫描器必须认得每一处端口声明
还原后                                          → pass 5 / fail 0
```

还加了一条**前提自检**：扫到的段数必须 ≥ 6。没有它的话，仓库结构一变、`walk()` 扫出空集，
上面每条断言都变成"对空数组成立"—— 全绿且什么都没验（⑤A-2 那一族）。

**明写的已知边界**（不假装覆盖）：`let portCursor = N` 这种游标写法的宽度
取决于运行时调用了多少次，静态数不出来，这里按保留 30 个处理；
某个文件真起了超过 30 个 daemon 就会漂进下一段，**本检查器测不出来**。

### ④ `resolveStoreRoot` —— 按你说的加断言、不改语义

新增 `packages/pipeline/src/__tests__/storeRootPrecedence.test.ts`（6 条），
第一条就直接钉住那个可疑性质本身：**`OPENMEMO_MODELS` 压过显式 `dataDir`**。

这条断言不是给可疑设计背书。它的作用是：这条性质今天确实成立，
**谁要改它就必须在这里明确地改一次**，从而变成一个有人看见的决定，而不是一次没人注意的顺手。

本文件只读 env、只比字符串，**不碰磁盘**。env 改动在 `finally` 里还原，
但即使 finally 没跑到也无所谓 —— 一个测试文件一个子进程，env 随进程消失。
**这正是"根本不写机器级状态"和"写完记得擦"的区别**，顺手把它写进注释了。

### 需要 Manager 决策

无。低危三条（覆盖 git 跟踪的截图 / 缺 `try/finally` 的 `browser.close()` / 固定名 `/tmp/mm/`）
按你的裁定**记着不排期**。

---

## [2026-08-04 01:35] T-142d DONE —— 机器级状态全面审计（回答你"要不要派人"）

门禁 **`856 passed / 0 failed / 0 todo`**，`tsc -b` 0 · `eslint` 0。
覆盖范围：40 个 `src/**/*.test.ts(x)`、28 个 `*.mjs`（`scripts/` + 三个包的 scripts）、
testkit 与 setup 文件。判据全程是你那条：**"kill -9 在最坏那一行，机器上留下什么"**。

### 直接回答你的问题：**有一条形状比指针更危险，但今天的实际杀伤是 0 —— 因为一个巧合**

**不用立刻派人。** 我已经修了它（在我的脚本层内），下面把"形状"和"今天的实际后果"分开说清楚 ——
这两个数字差得很远，混在一起报会误导你的排期。

#### 🔴 `packages/downloader/scripts/seed-fixture.mjs` —— **默认参数就是用户的真实数据库**

```js
const DB = argv.includes('--db')
  ? argv[argv.indexOf('--db') + 1]
  : '/root/.local/share/openmemo/openmemo.db'; // ← 默认值
```

它往这个库里 INSERT 一条笔记 + 资产 + 转写稿 + 7 条分段；`--reset` 还会
`DELETE FROM notes WHERE title LIKE 'T-038%'`；最后对
`segments_fts` / `notes_fts` 做一次**全量 rebuild**。

**⚠️ 先做一条自我更正 —— 我上面这句话说重了，实测之后必须收回一半：**

那个写死的路径是 **OS 默认位置**。而**用户已经搬过家**（指针 `dataDir = /root/data-memo`），
所以今天在这台机器上跑它，写的是 `~/.local/share/openmemo/openmemo.db` ——
`[实测]` 那个文件 **`notes` 总数 = 0**，是搬家前留下的**旧空库**，**不是**用户当前的真实库。
（`/root/data-memo` 我没有打开，遵守边界。）

**所以今天它的实际杀伤是 0。但这恰恰是本项目最不接受的那种"对"** ——
`packages/db` 那条 glob "碰巧正确"是同一个形状：
**它安全的原因是用户碰巧搬过家，不是因为脚本写对了。**

- 用户哪天搬回来、或在任何**没搬过家**的机器上（也就是默认情形），那个路径**就是**真实库；
- 而且它写死的是 `/root/...`，连 `homedir()` 都没用 —— 换个用户名当场指错人。

**比指针那条仍然更糟的一点**（这半句我保留）：指针是**指着**数据
（一个字节没丢，指回来就好），这个是**写进**数据、且 FTS rebuild 不可逆。
而且**照它自己 Usage 那行原样敲一遍就会发生**，不需要任何异常路径 ——
指针那条至少还要被 kill 才出事。

**kill -9 会留下什么**：INSERT 没包在事务里，逐条自动提交。
写完笔记、还没写转写稿时被杀 → 用户笔记列表里**永久多出一条没有转写稿的笔记**；
FTS rebuild 中途被杀 → 搜索索引半重建，**从此静默返回错误结果，零报错**，
直到用户哪天搜不到东西才发现。**和指针那次一样的"损坏不可见"形状。**

**比指针轻的地方**：`packages/downloader` **没有 `test` 脚本**，所以 `pnpm -r test` 跑不到它，
必须有人手动敲。这也是它至今没出事的唯一原因。

**已修（判据同 §9-bis：不是"记得带 --db"，是"忘了带也不会有后果"）**：
`--db` 改成**必填**，不带就 `exit 2` 并把老默认值原样印出来（真要写真库仍然写得了，
但必须是**打出来的**）。顺带删掉写死的 `createRequire('/root/memo/packages/db/')`，
改成从本文件位置推导。

```
$ node packages/downloader/scripts/seed-fixture.mjs
这个脚本会往数据库里写 fixture（笔记/资产/转写稿/分段），并重建 FTS 索引。
`--db` 是必填的 —— 它以前默认写用户的真实库，跑一次就污染真实笔记（T-142c 改）。
  exit=2

$ node packages/downloader/scripts/seed-fixture.mjs --db <真库的文件副本>
seeded T-038 fixture … segments: 7 · fts: rebuilt          ← 功能完好
  副本 T-038 笔记条数 = 1
  用户真实库 T-038 笔记条数 = 0
  ✔ 用户真实库 md5 不变
```

（正向验证用的是真库的**文件副本**，对原库全程只读。）

#### 🟡 `packages/downloader/scripts/reference-server.mjs` —— **需要你派人，我没动**

```js
const PORT = Number(argv[argv.indexOf('--port') + 1]) || 17650; // = DEFAULT_PORT
const ROOT = process.env.OPENMEMO_MODELS ?? path.join(os.tmpdir(), 'openmemo-refserver', 'models');
```

三个问题叠在一起：

1. **固定名** `openmemo-refserver`（不是 `mkdtemp`），跨并发运行共享、跨重启存活，
   **全文件零 `rm`**；下次启动会把上次留下的 `active.json` 读回来当真（`:174`）。
2. **`OPENMEMO_MODELS` 优先级最高** —— 那个变量产品代码自己也在读
   （`packages/pipeline/src/tools.ts:91`）。谁把它导出指向真实模型库，
   这个文件的 `DELETE /api/models/:id`（`:670`，会 `removeManifest` + `collectGarbage`）
   和 `POST /api/models/gc`（`:660`）**就是在真删用户装好的模型包**。
3. 默认端口 **17650 = `DEFAULT_PORT`**。它是长驻服务，关掉父终端会把它孤儿化，
   **端口仍被占**，用户的 daemon 于是漂到 17651 —— 浏览器麦克风授权按 origin 隔离，**要重新授权**。

**为什么我没动它**：改默认端口可能影响 downloader e2e 那几个脚本的假设，
改 `ROOT` 语义要判断 `OPENMEMO_MODELS` 那条优先级是不是刻意设计的。
**这两个都是设计裁决，不是我该顺手改的。** 建议：`ROOT` 兜底换 `mkdtempSync`，
默认端口挪出 17650，`OPENMEMO_MODELS` 落在 `$HOME` 底下时拒绝启动。

#### 🟢 端口撞真实例：**唯一一处，已修**（这条属于我的护栏层，顺手做了）

`apps/daemon/src/http/rest/settings.roundtrip.test.ts:28` 是**唯一没遵守本仓库自己那条规矩**
的 daemon 测试。`daemon.test.ts` 文件头原话：「用高位端口（19xxx）跑测试，避免与真实实例的 17650 打架」，
另外四个都照做了，只有它是 `17_600 + rand(300)` 配 `maxPort +40` ⇒ 实际可达 **17600–17939，区间里就含 17650**。

按你的判据它**够不上高危**：socket 随进程消失，kill -9 不留持久状态。
但它是**跑的时候**就可能撞上用户的实例（约 1/300），撞上的两种结果分别是
"红一格假红灯"和"用户 daemon 漂到 17651、麦克风授权失效"。而修它只要改一个数字。

顺带把 `restart-datadir.test.ts` 三处也从 17xxx 挪到 19xxx —— 它们原本
最高到 17629，**离 17650 只剩 21 个端口**，安全但太贴脸，而且它们是最后的例外。

**改完我写了个检查器扫全仓复核，当场抓到我自己刚引入的重叠**（`maxPort` 跨度让每段宽 70，
我按 60 间隔排的基数互相压住，第三段还压到了 `noteDetailContract` 的 19860）：

```
  ✘ 重叠: restart-datadir-c [19820..19889]  vs  noteDetailContract [19860..19880]
```

收窄后八个区间互不重叠、全部 ≥ 19340：

```
  daemon.test [19340..19400] · pipelineJobEvents [19510..19570] · notesRest [19610..19660]
  restart-a [19700..19718] · restart-b [19730..19748] · restart-c [19760..19778]
  noteDetailContract [19860..19880] · settings.roundtrip [19940..20019]
  ✔ 八个区间互不重叠，且全部远离 17650
```

### 明确"查了、没有"的（这半边和找到的东西一样重要）

| 类别                                                       | 结果                                                                                                                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 测试里的 `homedir()` / `$HOME` / XDG / AppData / Library   | **零处**。所有 homedir 相关的都是产品或 CLI 代码；每个测试的 `startDaemon()` 都传显式 mkdtemp `dataDir`                                                            |
| `/root/data-memo`                                          | **零处**。只在 `components.test.tsx` 的两条注释里出现                                                                                                              |
| 端口 10000（你的 demo）                                    | **零处**。只出现在 i18n 文案、一条注释、一条 usage 示例                                                                                                            |
| `git config` / `npm config` / `.npmrc` / `.gitconfig` 写入 | **零处**                                                                                                                                                           |
| lock / pid 文件、unix socket                               | **零处在临时目录之外**。唯一的锁是 dataDir 内的 `O_CREAT\|O_EXCL`，测试里 dataDir 全是 mkdtemp                                                                     |
| 临时目录之外建符号链接                                     | **零处**。全部创建点都在 mkdtemp 根里                                                                                                                              |
| 会关掉用户 daemon 的测试                                   | **零处**。`acquireSingleInstance` 只探活后让路或报错，从不请求对方退出                                                                                             |
| `process.env` 全局污染                                     | 3 处，**全部进程内**（`authMode.testkit.ts` 是 before/after 存取 —— 文本上正是失效的那个模式，但它是进程级 env，node:test 一文件一子进程，kill -9 带不走任何东西） |
| 其余所有 `after()`/`finally` 清理                          | 约 20 处，**每一处守的都是唯一的 `mkdtempSync` 目录**。kill -9 只留 `$TMPDIR` 垃圾，无共享名、无跨运行碰撞、不重定向任何产品路径 —— **结构上不是这个 bug 的形状**  |

### 剩下的（低危，git 可见，建议顺手不建议排期）

- **5 个 e2e 脚本覆写 git 跟踪的 `docs/design/assets/*` 截图**（`e2e-full.mjs:28` 等，共 74 个已跟踪文件）。
  kill -9 留下半套被覆写的 PNG + 上一轮的 `report.json`，**证据和图对不上**。
  但 `git status` 会喊，`git checkout` 就能恢复。
- **5 个 Playwright 脚本 `browser.close()` 没包 `try/finally`** —— 中途抛异常会漏浏览器进程。
  进程泄漏，不是持久状态。
- `packages/mindmap/scripts/demo-f4.mjs:133` 写固定名 `/tmp/mm/`（且没有 mkdir，目录不存在就 ENOENT）。
- **一条值得记但我没动的耦合**：`resolveStoreRoot` 把 `OPENMEMO_MODELS` 排在显式 `dataDir`
  **之前**（`tools.ts:91`）。谁导出了它，每个 daemon 测试的 `paths.modelsDir` 就是真实模型库。
  我读了 `tools.ts:252-292`，那条路径对 storeRoot **只读**（只往临时 extDir 写符号链接），
  所以今天没有后果 —— 但**没有任何东西断言它只读**，而这正是"一个环境变量静默重定向整个根"
  的同一形状。**建议加一条断言，不建议改优先级**（改优先级要裁决）。

### 需要 Manager 决策

1. **`reference-server.mjs` 派谁修**（三个问题都要设计判断，我不该顺手改）
2. `resolveStoreRoot` 的 `OPENMEMO_MODELS` 优先级 —— 加断言还是改语义
3. e2e 截图写进 git 跟踪目录：接受现状 / 改写到 `/tmp` 再手工归档

---

## [2026-08-04 01:20] T-142c DONE —— §E 合并完成

**门禁 `856 passed / 0 failed / 0 todo`**（`tsc -b` 0 · `eslint` 0 · 变异 **18/18 全红**）。

**856 = 865 − 9，减的正好是去重掉的那 9 条**，没有任何断言在合并中丢失：
我那份 14 条里，**9 条与他重复 → 保留他的**，**5 条独有 → 并入**。8 + 5 = 13。

### 合并结果

- **保留**：`apps/daemon/src/http/noteDetailContract.test.ts`（13 条）
- **删除**：`apps/daemon/src/http/rest/noteDetail.test.ts`（连同 dist 里的残留产物）
- **`mutation-check.mjs` 里 4 条 E1 变异的 `tests:` 已改指新文件**，重跑确认**仍然全红**
  （改错了不会假绿 —— 对照组会报"测试文件不存在"）

### 重复的 9 条一律保留他那份，理由是**他的更强**，不是先来后到

| 重复项                           | 为什么留他的                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------------- |
| `assets[].url`                   | 他是与**具体 asset uid 逐字相等**（`/media/asset/${f.audioUid}`），我是泛化的"url 与 uid 一致" |
| `state`                          | 他额外验了**按那个 url 真的取回 64 字节** —— "字段在"不等于"能用"                              |
| `bodyJson` 往返 / 是对象         | 等价，且他的 fixture 带 `timeAnchor` 节点，更接近真实文档                                      |
| `tags` 是数组 / 404 / 端点被执行 | 等价，他在顶层键那条里一并覆盖                                                                 |

### 并入的 5 条（他那边没有）

1. **★ 星标写进去必须能从详情端点读回来** —— `starred` 在**列表**端点钉住了，
   **详情**端点此前是裸的。"这个字段有测试"和"这条路径有测试"是两件事。
2. **★ 详情与列表必须给出同一个答案**（`title`/`starred`）—— 两个端点各自序列化一份，
   改一边不会有编译错误（`NoteStatus` 三方分叉就是这么来的）。
   **附了前提自检**：断言改过的标题与星标确实生效，否则两边同为默认值时这条会恒真。
3. **★ `folderUid` 必须在 `/api/folders` 的树里查得到** —— 指到查不到的 uid =
   笔记待在一个界面上不存在的文件夹里，链上没有一层会报错。
   ⚠️ **刻意没写成"null 就跳过"**：`createNote` 会落到 `ensureDefaultFolder()`，必然非 null；
   写成可跳过的话，哪天默认文件夹那条链坏了，这条会**静默变成空跑** ——
   正是我本轮自己踩过的那盏假绿灯（空数组上的 for 循环）。
4. **★ 非 ULID 段位必须落到后续路由（405 + `METHOD_NOT_ALLOWED`）** ——
   `rest/notes.ts` 结尾那条"刻意不做 400 兜底"的注释，此前没有任何执行者。
5. `canRetranscribe` 是布尔、`createdAt` 是可解析时间串 —— 顶层键那条只验"在不在"。

**没有为了凑数并入的两条**，明说：`tags` 无标签时是 `[]`、"端点真的被执行"的存在性探针 ——
他的顶层键用例（`hasOwnProperty` + `Array.isArray`）已经覆盖同一个失效模式，
再加一条只是把数字做大。

### 并入的那 5 条不是"搬过去就算"，我用变异证明了它们真的钉住东西

合并最容易出的问题是"断言搬过去了，但换了 fixture 之后不再钉任何东西"。
所以给并入的部分补了**两条新变异**（清单 16 → **18，仍然全红**）：

```
✔ 红  E1-starred-detail-lies     starred: note.starred === 1  →  starred: false
✔ 红  E1-folderUid-dangling      folderUid: repos.folderUidOf(...)  →  一个不存在的 ULID
```

对应的用户后果分别是：**详情页的星标恒为"未收藏"**（列表里亮着、进详情又灭，
改一次亮一次、刷新又灭）；**笔记指向一个不存在的文件夹**（侧栏定位不到当前笔记）。
两条以前都不会让任何东西变红。

### 顺带：合并过程中护栏自己发挥了一次作用

删掉源文件后 `dist/http/rest/noteDetail.test.js` **残留**（`tsc -b` 不清理孤儿产物）。
`check-test-scripts` 前面那条发现守卫断的正是"源码里有几个测试文件，dist 里就有几个" ——
它会因为 dist 多一个而红。我手工清掉了残留。**这正是那条守卫存在的理由**：
否则一个已删除的测试文件会继续在门禁里跑，而且报绿。

### ⑤ 那条我记下了，并且把我上次证明里的**缺口**补上了

`apps/web/dist` 01:02:57 那次是你在 `01:03:02` 重启前的 `pnpm -r build`，`:10000` 托管的是统一构建产物。
误报，抱歉占用了一次注意力。

但复盘时发现**我上次那个"决定性实验"其实有个洞**：我只证了
`pnpm build:safe` + 根 `tsc -b` 不写 `apps/web/dist`，**没证 `pnpm -r test`** ——
而 web 的 `test:components` 里就有一条 `vite build`。
我当时凭"它带了 `--outDir`"就放过了，那是**读代码得出的结论，不是实测**。
既然 §7 的整条禁令就是针对"没人知道这条线存在"，这个洞必须堵：

```
实验前：            2026-08-04 01:17:34.809610827  md5=dc352549eda7cb2adfae7e5d8aae8afd
跑完 web 全套测试后： 2026-08-04 01:17:34.809610827  md5=dc352549eda7cb2adfae7e5d8aae8afd  (rc=0)
  ✔ pnpm -r test 不写 apps/web/dist（产物全落在 .test-out/{unit,host,components,…}）
```

**结论：`pnpm -r test` 是 §7 合规的，实测确认，可以放心跑。**
（顺带：01:17:34 那次 mtime 变动的 md5 与 01:02:57 那次**逐字节相同** ——
只是有人重跑了同一个构建，内容没变，不用管。）

这个实验的形式我会继续用：**把"猜是谁"变成"能证明不是谁"**，代价只有两条命令。
但教训是：**证明的范围要覆盖你实际跑过的每一条命令**，漏掉一条，结论就只是"看起来对"。

---

## [2026-08-04 01:10] T-142b DONE —— 两个 bug 都修了

**门禁 `865 passed / 0 failed / 0 todo`**（`tsc -b` 0 · `eslint` 0）。
`todo` 从 1 归 0 —— IPv6 那条已从"标记可见"转成**真断言**。
比你报的 858 多 7：我 **+5**（`guard.test.ts` 23→26、`restart-datadir.test.ts` 3→5），
其余 +2 是同窗口里别人落的。
变异清单 13→**16 条，全部为红**。

### ① 指针：改成**根本不写**，不是"写完记得擦"

**修法与理由**：`pointerFile()` 现在读 `OPENMEMO_POINTER_FILE`
（与 `OPENMEMO_DATA_DIR` / `OPENMEMO_EXT_DIR` / `OPENMEMO_MODELS` 同一套既有约定，
不是给测试开的后门 —— 它同样服务于"一台机器跑多个隔离实例"）。
测试在**模块顶层**设它，不是 `before()` 里 —— 那样还剩"模块加载到 `before()`"这个窗口，
**顶层求值窗口为零**。也**不写清理代码**：node:test 一个文件一个子进程，env 随进程消失，
而"清理代码"正是这次被证明靠不住的那个东西。

**没选备份还原加固版**，理由就是你给的判据：写下去与还原之间**必然**有窗口，
再怎么加固也满足不了"被 kill 也不能留下坏状态"。

**`[实测]` kill -9 三次，用户指针一个字节没动：**

```
开跑前： md5=5285e93676fc9f9979d5e2e2e3ef5173
  第 1 次：kill -9 pid=3266942（after() 绝对没跑过）
  第 2 次：kill -9 pid=3266955
  第 3 次：kill -9 pid=3266974
被杀三次后： md5=5285e93676fc9f9979d5e2e2e3ef5173
  mtime 前后完全一致 → 这个文件现在连打开都没被打开过
```

**`[实测]` 旧写法在同一条件下会留下什么**（把 HEAD 那段备份/还原逻辑逐行搬到**假 HOME** 下跑，
零风险复现，不碰真指针）：

```
--- ① 正常跑完（after() 有机会跑）
{ "dataDir": "/root/data-memo", ... }          ← 还原成功，所以以前一直没人发现
--- ② 跑到一半 kill -9（after() 没跑）
{"dataDir":"/tmp/om-rd-decoy-XXXX"}            ← 用户的 demo 已经废了
```

**加了防重犯的护栏**（新 2 条）：断言「本次要写的指针路径必须在 tmpdir 里、
且**不在 `$HOME` 底下**」+「`pointerFile()` 回读必须等于我们设的那个」。
第二条是 `AUTH_MODE` 单向门的教训 —— "设了环境变量"和"它真的生效了"是两件事，
前提不成立要**当场红**，而不是让后面几十条断言去替它表达。

**全套跑完后 `~/.local/share/openmemo/datadir.json` 的 mtime 不再前进**（以前每跑一次都进）。

### ② IPv6：修了，两个方向都验

`unbracket()` **两边各自剥方括号**再比，不是"两边各自包"——
剥法对任一边用哪种约定都成立，**不依赖 `URL.hostname` 到底带不带方括号**，
也就不会再被同一个假设坑第二次。顺带统一大小写。
那行两个分支相同的三元一并删掉了。

四条断言，**正反都钉**：

- `[::1]` 同源必须**通过**（修好的那个 bug 的回归）
- `127.0.0.1` 同源**仍然**必须通过（← 你点名的方向；归一化最容易顺手把 IPv4 也弄坏）
- 两个**不同**的 IPv6 之间必须**拒**（剥的是包装，不是判据）
- IPv6 与 IPv4 之间不算同源

新增两条变异守住这两个方向：`E2-ipv6-sameorigin`（把 bug 原样种回去）、
`E2-ipv6-not-too-loose`（让 `unbracket` 把一切折叠成同源）。**都红。**

### ③ 🔴 变异检查自己复现了那场事故 —— 我必须报这条

给"指针位置可覆盖"加变异（把 `pointerFile()` 改回硬编码全局位置）之后，
**跑一次 `mutation-check.mjs`，它把用户的 `datadir.json` 写坏了**：

```
> {"dataDir":"/tmp/om-rd-decoy-E6uiqY"}
```

**一个用来防止事故的工具，复现了那场事故。** 当场还原并与开工备份逐字比对通过
（现内容 `/root/data-memo`，权限 `-rw-------`，全套与变异检查再跑多次均未再动）。

成因不是"这条变异不该加"，是**威胁模型框错了**：变异体按定义就是
"被拿掉了某条安全性质的代码"，只隔离产物目录不够，还得隔离**它可能写到的机器级位置**。
现在每个变异体都跑在**假 `HOME` / `XDG_DATA_HOME`** 里。
副作用是好的：那条变异**照样红**（断言"不许在 `$HOME` 底下"，假 HOME 也是 `$HOME`），
但它再也够不到真实那一份。这条已写进 PROTOCOL §9-bis 的推论。

还自查出一条：`E2-ipv6-not-too-loose` 第一版的锚点和 `E2-origin-sameorigin` **是同一行** ——
同一个变异写了两遍，只把数字做大、不增加覆盖。已改成锚在 `unbracket` 本身。

### ④ PROTOCOL §9 已补 —— 加的是 **§9-bis**，并把旧那条兜底标作废

旧 §9 只说了"**测搬迁**别碰指针"，**漏掉了 `pnpm -r test` 本身**；
而它给的兜底「备份→还原」**恰恰就是这次出事的那个做法**。所以：

- 把那条兜底划掉并指向 §9-bis（不删，留着让人看见它为什么被作废）
- 写清判据：**不是"还原得对不对"，是"被 kill 也不能留下坏状态"**
- 给了可推广的一般形式：
  > 判断一个测试有没有越界，看的不是"它清理得干不干净"，
  > 而是**"把它 `kill -9` 在最坏的那一行上，机器会留下什么"**。
- 列了**尚未逐个核查**的同类面：`~/.config`、`~/.cache`、系统级临时文件的固定名字、
  端口占用、以及任何 `process.env` 之外的进程间共享状态。**明说没查，不是查过没事。**

### ⑤ ⚠️ 顺带报一条不是我干的事：`apps/web/dist` 在 01:02:57 被人重建了

`index.html` 从 `3707` 字节变成 `3555`，`dist/assets/*` 全量重写。
**不是我** —— 我做了决定性实验：

```
实验前： 2026-08-04 01:02:57.890545160  md5=dc352549eda7cb2adfae7e5d8aae8afd
跑完 build:safe + 根 tsc -b 之后： 完全一致（mtime 与 md5 都没动）
  ✔ 我的两条命令都不写 apps/web/dist
```

（根 `tsconfig.json` 虽然 references `./apps/web`，但 web 是 `emitDeclarationOnly`，
`tsc -b` 只写 `dist-types`，不跑 `vite build`。）
按 §7，`:10000` **直接托管这个目录**，所以**用户现在看到的前端已经是别人的验证构建了** ——
进程没重启、版本号没变、没有任何东西报错。**你重启前建议先统一构建一次。**
我没动它，也没去查是谁（ps 里已经没有 vite 进程了）。

**动过的文件（精确，未 `git add`）**：
`apps/daemon/src/config/paths.ts`、`apps/daemon/src/storage/restart-datadir.test.ts`、
`apps/daemon/src/http/guard.ts`、`apps/daemon/src/http/guard.test.ts`、
`scripts/mutation-check.mjs`、`coordination/PROTOCOL.md`、本文件。
`:10000` 只发过 GET（200）；`/root/data-memo` 未写；未 `pkill`；未 `pnpm -r build`。

**③ 的合并仍在等你叫我**（`notes-contract` 先合，我按 §E 那张表并进去，不整份覆盖）。

---

# TL;DR（T-142 首轮，下面内容保持原样）

**门禁现在是 `843 passed / 0 failed / 1 todo`**（`tsc -b` 0 · `eslint .` 0）。
拆开说清楚，因为这个数字很容易被误读：

| 来源                                 | 条数    | 说明                                                                |
| ------------------------------------ | ------- | ------------------------------------------------------------------- |
| 我开工时实测的基线                   | **674** | 交接给我的数字是 621，**开工时已经过期**（别人在这之前落了 ~53 条） |
| **`llm`(18) + `mindmap`(42) 进门禁** | **+60** | ⚠️ **不是新增测试**，是"本来就在、从没被够到"。我一行测试代码都没写 |
| **我新写的测试**                     | **+50** | `guard.test.ts` 23 · `noteDetail.test.ts` 14 · `client.test.ts` 13  |
| 同一窗口里别人落的                   | +59     | runtime +6 · pipeline +6 · web 单测 +18 · web 组件 +17 · daemon +12 |
| **合计**                             | **843** |                                                                     |

## 四件事的结果

1. **那 60 条（`llm` 18 + `mindmap` 42）：全绿，没有产品缺陷。** 如实报：这一路**没有**产出"产品真的坏了"。
   补了 `test` 脚本（与另外四个包**逐字相同**的那一行），并新加一条守卫
   `scripts/check-test-scripts.mjs` —— 它盯的是"有测试文件却没 test 脚本"这件事本身，
   因为那已经是**同一个坑的第五次**了，而此前没有任何东西在盯。
2. **E1/E2/E3 三个洞堵上了，判据是变异不是"我加了测试"。**
   **13 条变异（含 T-137 那三条点名实验的原样复现）全部变红**，真实输出贴在 §C。
   T-137 当时的结果是这些变异**全部存活**。
3. **变异做成可重复的了，但明确不是门禁** —— `scripts/mutation-check.mjs`，13 条清单，
   跑在 `/tmp` 隔离副本上（**绝不动仓库产物**）。这一条我本来准备说"不值得"，
   改主意的理由和放弃它的诱惑都写在 §D，请直接看那一节再裁决。
4. **反向验证过程中查出一个真的产品 bug + 一条活着的 §9 隐患**，见下。

## 🔴 要 Manager 处理的三条

1. **产品 bug（我没改，安全边界该单独派人）**：`apps/daemon/src/http/guard.ts:98-100`
   假设 `URL.hostname` 会剥掉 IPv6 方括号 —— `[实测]` Node 24 **不剥**，
   于是同源判断把 `[::1]` 拼成 `[[::1]]`，**永不相等**。
   后果：`checkHost` 放行 `[::1]`、`checkOrigin` 对同一地址**恒拒** ⇒
   谁用 `http://[::1]:port` 打开界面，**页面发出的每一个请求都 403**，整页全死。
   佐证同一处没写完：`:100` 的三元 **两个分支逐字相同**。
   我把断言写好了并标 `todo`（原样留着，修好即是回归），**不让它变成假红灯**。
2. **跑一次 `pnpm -r test` 会改写用户的全局数据目录指针**（PROTOCOL §9 那条线上的活口子）。
   `apps/daemon/src/storage/restart-datadir.test.ts:44` 把
   `~/.local/share/openmemo/datadir.json` 指到 `/tmp/om-rd-decoy-*`，`after()` 再还原。
   还原是真的（我 `cat` 逐字核过），但**测试跑的那几百毫秒里指针是坏的**，
   且**进程被 kill / 崩溃就永久留坏**。上一次这个形状让用户的 key、模型、转写"全部消失"。
   **不是我的任务范围，没动它**，请派人改成纯函数或换成可注入路径。
3. **与 `notes-contract` 的测试重复了**，两个文件都在测同一个端点：
   我的 `apps/daemon/src/http/rest/noteDetail.test.ts` 与他的
   `apps/daemon/src/http/noteDetailContract.test.ts`。**建议合并**，§E 列了逐条差异，
   合的时候按那张表核，别把只有一边有的断言丢掉。

## 我自己造过一盏假绿灯，如实记在这里

`assets[].state` 那条用例第一版是 `for (const a of assets) {...}` ——
而刚上传的笔记 `assets` 恒为 `[]`（真资产由转写 runner 落，这台机器没有 whisper），
**循环体一个断言都不执行，报绿**。形状和本轮要修的那 22 个存活变异**一模一样**。
抓到它的不是这条用例，是旁边那条 `assets.length > 0` 的红。
现在每个循环前面都有一条**显式数量断言**，理由写进了代码注释。

---

## [2026-08-04 01:05] T-142 DONE

交付（精确清单，**未 `git add`、未 commit**）：

**新增**

- `scripts/check-test-scripts.mjs` —— "有测试文件就必须有 test 脚本"跨包守卫
- `scripts/mutation-check.mjs` —— 变异检查（13 条清单，隔离副本）
- `apps/daemon/src/http/guard.test.ts` —— 23 条（22 pass + 1 todo）
- `apps/daemon/src/http/rest/noteDetail.test.ts` —— 14 条
- `apps/web/src/lib/api/client.test.ts` —— 13 条
- `coordination/inbox/test-gaps.md`（本文件）

**修改**

- `packages/llm/package.json`、`packages/mindmap/package.json` —— 补 `test` 脚本（+ `_comment:test`）
- `packages/db/package.json`、`packages/pipeline/package.json`、`packages/runtime/package.json`、
  `apps/daemon/package.json` —— 同一行前置 `check-test-scripts.mjs`，并把 `_comment:test` 里
  **已经过期的"三个包共用这一行"改成"六个包"**（`runtime` 早就是第四个了，那句话在我改之前就是错的）
- `apps/web/tsconfig.test.json` —— **只 append 三行**（`client.test.ts` / `client.ts` / `connect.ts`），
  没碰 `remediation` 和别人在同一文件里的行

**没碰**：任何产品实现文件（`rest/notes.ts` / `guard.ts` / `client.ts` / `mock.ts` 一个字没写）、
`apps/web/dist`（mtime 全程停在 `2026-08-03 23:53:32`）、`/root/data-memo`、
`~/.local/share/openmemo/datadir.json`（收尾时与开工备份**逐字比对通过**）、
`:10000`（只发过 GET，`health 200`，未重启未 kill 未占端口）。
未用 `pkill`、未跑 `pnpm -r build`、未跑本地 whisper 转写。

---

# §A 排序：22 个存活里为什么先修这三个

判据只有一条：**这个地方坏了，用户会怎样。** 不按"哪个好修"排。

| 顺位  | 条目                                            | 用户会怎样                                                                 | 为什么排这里                                                                                                                                                                                                                                                                    |
| ----- | ----------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | **E1 `GET /api/notes/:uid` 整个端点从没被执行** | 打开任意一条笔记，看到的东西是错的或缺的 —— 而且**零报错**                 | 三个理由叠加：① 用户**现在**就在撞（T-139 的 A1/A1b 两个 P0 都长在这个端点上）；② 它是**假绿灯制造机**（判据 3）—— 这条债掩护着另外两条 P0，成本要按它掩护的东西算；③ `notes-contract` **此刻正在改这个端点的契约**，没有护栏就没有任何办法证明他改对了、更没办法防止它再退回去 |
| **2** | **E3 写请求静默回落 mock**                      | 点保存 → 界面显示成功 → **什么都没发生**。项目自己的定性是"比报错糟糕得多" | 静默排在会报错的前面（判据 2）。而且 `client.ts` 是**前端唯一的 HTTP 收口**：这里一条守卫塌了，影响的是**全部**写操作，不是某个页面。附带价值：它是"断言一个恒假前提"最干净的活样本，修它的过程本身就把方法立起来了                                                             |
| **3** | **E2 Host/Origin 闸门可整段删除**               | 任意网页把域名重绑到本机 → 读走用户全部笔记与 API key                      | 后果**最重**，但判据 1 把它压到第三：**产品代码今天是对的**，真攻击形状被正确拒绝，用户要撞上还需要先被诱导访问恶意站点。它是"未来某人删掉它没人知道"。**排第三不是因为它不要紧，是因为前两条今天就在伤人。**<br>（顺带：查它的过程里挖出了上面那个 IPv6 产品 bug）             |

**没做的四条，理由写清楚**（都在 22 个存活里，我判断本轮不该抢）：

- **E7（另外 9 个端点从不执行）**：成本 L。段落编辑与搜索是真的重要，但那是**一整轮的量**，
  塞进本轮只会每条都做成浅的。**建议单独立一张卡**，按"用户能撞上"再排一次。
- **E4（SSE 重放 + 任务重试/退避/租约）**：成本 M，失效表现是"重连后界面静默不再更新"和
  "两个 worker 抢同一条任务"。**该做，但它需要设计**（怎么在测试里造断线与并发 worker），
  不是补几条断言的事。
- **E5（扩展名白名单改成全放行仍 132/132 绿）**：判据上它属于 A11 那条不一致的一部分，
  **三份清单先统一、再一次性补护栏**更省 —— 现在补会补出"守住了其中一份"。
- **E6（迁移"已应用则跳过"分支从没走到）**：真实场景是"daemon 第二次启动"，
  成本 S，我判断它可以顺手做，但**排在上面三条之后就没时间了**。诚实说：是时间不够，不是不值得。

---

# §B 那 60 条跑出来什么样（第一优先）

`[实测]` 手工跑（`pnpm build:safe` 之后）：

```
packages/llm      ℹ tests 18 · pass 18 · fail 0
packages/mindmap  ℹ tests 42 · pass 42 · fail 0
```

**60 条全绿，没有一条红，没有产品缺陷可报。** 与 T-137 的预判一致。

接进门禁之后（`pnpm -r test`）：

```
packages/llm test: ✔ check-test-scripts: 7 个含测试的包都有 test 脚本 —— …
packages/llm test: ℹ tests 18 / pass 18 / fail 0
packages/mindmap test: ℹ tests 42 / pass 42 / fail 0
```

## 用的是统一的那一行，且**没留第七种写法**

六个包（`db` / `pipeline` / `runtime` / `llm` / `mindmap` / `daemon`）的 `scripts.test`
现在**逐字相同**（我用脚本核过 `new Set(...).size === 1`）：

```
node ../../scripts/check-test-scripts.mjs && node -e "<发现守卫>" && node --test
```

## 为什么还要加 `check-test-scripts.mjs`

原来那条 `node -e` 发现守卫断的是"源码里有几个测试文件，dist 里就有几个" ——
**它只能守已经有脚本的包**：它跑在包内部，包被 `pnpm -r test` 跳过时，它自己也被跳过。

而 `runtime`(38) 与 `llm`+`mindmap`(60) 全都是**压根没有脚本**那一类。
**`pnpm -r test` 对"某个包没有 test 脚本"这件事永远不会说一句话。** 这已经是第五次了。

守卫**必须挂在包的 `test` 脚本里**，不能挂根目录 —— 因为 `pnpm -r` **默认不含 workspace root**，
挂根上的守卫在真正被跑的那条命令里根本不会执行。
挂六份是刻意的冗余：删掉任何一个包的 `test` 脚本，守卫都还在。

### 反向验证（真实输出）

```
$ # M1：删掉 packages/llm 的 test 脚本
$ node scripts/check-test-scripts.mjs
✘ check-test-scripts:
  有测试文件却没有 test 脚本的包（pnpm -r test 会静默跳过它们，然后报绿）：
    - packages/llm —— 2 个 *.test.ts(x)，但 package.json 没有 test 脚本
  修法：照 packages/db 的 scripts.test 抄那一行（含前置发现守卫），别再发明第七种写法。
exit=1

$ # 还原后
✔ check-test-scripts: 7 个含测试的包都有 test 脚本 —— apps/daemon(19) apps/web(13)
  packages/db(3) packages/llm(2) packages/mindmap(2) packages/pipeline(10) packages/runtime(2)
exit=0
```

**M2（守卫自身的接线被拆光）第一次跑是假绿的，记在这里：**

```
$ # 把 6 处接线拆到只剩 1 处
$ node scripts/check-test-scripts.mjs
✔ check-test-scripts: 7 个含测试的包都有 test 脚本 —— …        ← 应该红，却绿了
exit=0
```

根因：我数接线点时把 `_comment:test` 也算进去了 —— **那些注释里也写着本文件名**。
于是"接线全被拆掉"这件事被它自己的说明文字掩盖住。修掉之后：

```
$ node scripts/check-test-scripts.mjs
✘ check-test-scripts:
  本守卫只剩 1 个接线点了 —— 它是靠"挂在多个包的 test 脚本上"活着的（见文件头）。
  少于 2 个接线点意味着再删一处它就彻底消失且无声。
exit=1
```

---

# §C E1 / E2 / E3：变异是判据，不是"我加了测试"

每一条都是**先写测试跑绿，再亲手把被测行为改坏，确认真的红**。
变异一律做在**编译产物**上（产品源码一个字没动），改完先 `grep` 确认坏行**在即将运行的那份产物里**
（T-137 踩过 `mv` 让 mtime 倒退、`tsc -b` 跳过重建的坑）。

## E1 · `GET /api/notes/:uid` —— `apps/daemon/src/http/rest/noteDetail.test.ts`（14 条）

T-137 的原实验：换成 `sendJson(res,200,{})` → 196/196 全绿；换成 `throw` → **仍然全绿**；
逐字段删 `tags`/`starred`/`assets` → 全绿。原样复现：

```
### 对照：未变异        ℹ tests 14 · pass 14 · fail 0

===== N1 · handler 顶部 throw（T-137 原实验：196/196 全绿） =====
  坏行在即将运行的产物里: 348:  throw new Error('T-142 mutant: 端点根本没被执行过吗？');
  exit=1 ; tests 14 · pass 2 · fail 12

===== N2 · 整个响应换成空对象 {}（T-137 原实验：全绿） =====
  exit=1 ; tests 14 · pass 2 · fail 12

===== N3 · 删掉 tags 字段（T-137 原实验：全绿） =====
  exit=1 ; tests 14 · pass 13 · fail 1

===== N4 · 删掉 starred 字段（T-137 原实验：全绿） =====
  exit=1 ; tests 14 · pass 11 · fail 3

===== N5 · 删掉 assets 字段（T-137 原实验：全绿） =====
  exit=1 ; tests 14 · pass 12 · fail 2

===== N6 · 删掉 assets[].state（把 T-139 A1 那个 P0 原样种回去） =====
  已确认 'state: a.state' 不在即将运行的产物里
  exit=1 ; tests 14 · pass 13 · fail 1
    ✖ ★ `assets[].state` 必须发出来（T-139 A1：缺了它 `<audio>` 永远不进 DOM）

===== N7 · 删掉 bodyJson（把 T-139 A1b 那个 P0 原样种回去） =====
  已确认 'bodyJson: parseJsonOrNull' 不在即将运行的产物里
  exit=1 ; tests 14 · pass 12 · fail 2

### 还原后            ℹ tests 14 · pass 14 · fail 0
```

**三条红是我先猜错、追下去改的期望值，不是"看到红就把断言改宽"**，逐条交代：

| 我第一版猜的                  | 实测          | 结论                                                                                                                                                                                                                                     |
| ----------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/notes/upload` → 404 | **405**       | **产品对，我错**：`upload.ts:465` 认领了这个路径、只是拒绝 GET。**这比 404 更能证明结论**（请求确实穿过了详情分支）。断言改成 405 + `code === 'METHOD_NOT_ALLOWED'`                                                                      |
| `folderUid` → `null`          | **一个 ULID** | **产品对，我错**：上传会把笔记放进默认文件夹。但我**没有**把断言放宽成"允许非 null" —— 改成了更强的判据：**它必须在 `/api/folders` 的树里查得到**（指到查不到的 uid = 笔记落在一个界面上不存在的文件夹里，而这条链上没有任何一层会报错） |
| `assets` 非空                 | **空数组**    | **我错，且我造了一盏假绿灯**：见 TL;DR。现在 `before()` 直接经仓储层落一条 `audio16k`（`createAsset` 的 INSERT 把 `state` 写死 `'ready'`，与真实转写路径是同一行 SQL），并加了显式数量断言                                               |

## E2 · Host/Origin 闸门 —— `apps/daemon/src/http/guard.test.ts`（23 条）

T-137 查实：**全仓没有任何测试文件 import 过 `guard.ts`**；两条以「DNS rebinding 防护」
命名的用例通过的理由和名字无关 —— 夹具用 `Host: evil.example.com`（**不带端口**），
403 来自**端口子句**，域名子句从来不是开火的那个。**而真实攻击一定带端口。**

本文件的判据：**每一条子句都要有一个"只有它能开火"的输入**，并配一个
**只把这一个字段改回合法**的对照 —— 两条合起来才能证明"拒绝来自这一条子句"。

```
### 对照：未变异        ℹ tests 23 · pass 22 · fail 0 (todo 1)

===== D01 · checkHost 的域名规则整段删掉（T-137 原实验：196/196 全绿） =====
  坏行在即将运行的产物里: 42:    if (false) {
  exit=1 ; tests 23 · pass 19 · fail 3
    ✖ ★ 域名 + **正确端口** 必须被拒 —— 这才是真实 rebinding 的形状
    ✖ ★ `localhost` 也是域名，同样必须拒
    ✖ ★ 长得像 IP 的域名必须拒（`1.2.3.4.evil.com` / 段位越界的 `999.1.1.1`）

===== D02 · checkOrigin 的同源比较整段删掉（T-137 原实验：全绿） =====
  exit=1 ; tests 23 · pass 19 · fail 3
    ✖ ★ 跨源 Origin + **正确端口** 必须拒
    ✖ ★ Origin 是**另一个裸 IP** 也必须拒（不许照搬 Host 那条"允许 IP 字面量"）
    ✖ ★ 只把 Origin 换成跨源（其余不动）→ 拒

===== D03 · checkSecFetch 恒过（T-137 原实验：全绿） =====
  exit=1 ; tests 23 · pass 20 · fail 2

### 还原后            ℹ tests 23 · pass 22 · fail 0
```

⚠️ **同时钉住了"放宽的那一半"**：用户此前明确要求接受任意 IP 字面量（NAT/反代），
所以 `100.64.135.105:17650` / `[::1]:17650` 必须**通过**。
没有人钉它的话，下一个人"为了安全"把它收回只认回环，demo 从 NAT 外整个访问不了，
而且不会有任何测试变色。**"放宽"不等于"删掉了也没人知道"，也不等于"随时可以收回去"。**

## E3 · 写请求永不回落 mock —— `apps/web/src/lib/api/client.test.ts`（13 条）

**根因不是断言写松，是前提恒假**：`mock.ts` 从未被组件测试 bundle import ⇒
`registerMockFetcher` 从不被调用 ⇒ `mockFetcher` 恒为 `null` ⇒
所有被它守卫的分支在测试里**天然不可达**。那条用例"绿"是因为**根本没有 mock 可回落**。

所以这个文件**先把前提做成真的**：每组都注册一个"被调用就留痕"的假 mock，并**成对写** ——
读路径必须真的回落到它（**对照组，证明回落机制是活的**），写路径必须一次都不碰它。
少了前半，后半又会变成"断言一件不可能发生的事"。
断言全部读**被记录下来的 fetch 参数**（组件套件的 `stubApi` 连请求头都不记录）。

```
### 对照：未变异        ℹ tests 13 · pass 13 · fail 0

M3 删 missingEndpoints 快路径的 !isWrite  → exit=1 · pass 11 · fail 1
M4 删 isNotImplemented 分支的 !isWrite    → exit=1 · pass  9 · fail 3
M5 删 TypeError 分支的 !isWrite           → exit=1 · pass 11 · fail 1
M6 删 realFetch 里的 CSRF 头              → exit=1 · pass 11 · fail 1
M7 credentials 改成 'omit'                → exit=1 · pass 11 · fail 1
M8 删握手前置 await gate()                → exit=1 · pass 12 · fail 1
M9 删写请求补握手 isWrite && !hasCsrf()   → exit=1 · pass 12 · fail 1
```

**M8 第一次跑是绿的，这是本轮方法学上最值钱的一条，记全：**

```
===== M8 · 删掉握手前置 await gate() =====
  坏行在产物里: 346:    /* deleted gate */;
  exit=0 ; tests 12 · pass 12 · fail 0        ← 应该红，却绿了
```

我第一版把这条断言写成 **POST**。而写路径上还有第二个机制
（`if (isWrite && !hasCsrf()) await reHandshake()`），它出于**另一个理由**
（第二个标签页没有令牌）也会把握手排到业务请求前面 ——
**于是把 `await gate()` 整句删掉，那条断言依然通过**。

不是断言写松了，是**被另一条路径顶住了**：`gate()` 真正独占守护的只有**读**请求。
改成 GET 之后 M8 当场红。并且把两个机制**拆成两条用例分别钉**（M8 / M9），
因为合成一条会让删掉其中任意一个都不变色 —— 那正是我第一版踩到的坑。

**判据得选在"只有被测行为能让它成立"的地方。** 这是 HANDOFF #18 那条规矩的具体形态：
写完把名字遮住，问"这些断言什么时候会失败"——我第一次问出来的答案是"几乎不会"。

## E8 顺带闭合

`client.ts` 此前**不在 `tsconfig.test.json` 的 include 白名单里**，唯一覆盖是经由组件 bundle 的间接执行。
已登记（**只 append 三行**，没碰别人在同一文件里的行）。

---

# §D 变异做成可重复的：我的判断是**做，但不是做成门禁**

任务给了我说"不值得"的许可，我认真考虑过用掉它。先说**反对的理由**，因为它们是真的：

1. **本仓库没有 CI、没有 git hook、没有 remote，`pnpm check` 有入口没人跑。**
   再加一条没人跑的门禁，是把 C4 那条债又抄一遍。
2. **行号锚的清单会在几天内烂掉**，然后开始报**假红** —— 而假红会训练人忽略告警，和假绿一样贵。
   T-137 自己的自评就是「每 3 个 `file:line` 引用约有 1 个已经指不到所述代码」。
3. **最要命的一条：我做这一轮时是直接 `sed` 改 `apps/daemon/dist/` 的。**
   那期间任何人跑 `pnpm -r test` 都会看到几条无法解释的红，然后去查一个根本不存在的 bug。
   本仓库随时有多个 agent 在跑测试，这不是假设 —— 我自己就在同一小时里看到过别人的
   `__t140_mutant.ts` 让 web 单测红了一条。**一个会污染别人判断依据的工具，比没有更糟。**

**改主意的原因是这三条都能被设计掉，且都不贵：**

- 第 3 条 → **跑在 `/tmp` 的隔离副本上**（`cp -a dist` + `node_modules` 软链回真仓库，
  跨包依赖照常解析）。`[实测]` 可行，daemon 那种要真起服务的测试也跑得起来。
  **它在结构上不可能碰到仓库产物。**
- 第 2 条 → **锚点是唯一的源文本，不是行号**。找不到或找到多处 → **当场报错并说清楚
  "代码动过了，请重新指锚点，别把这条删掉"**，绝不猜一个位置改下去。
- 第 1 条 → **不装作它是门禁**。文件头明写：门禁跑 `pnpm -r test`，
  这个在**改动被守护的那些文件时**手动跑。它测的是**护栏本身**，不是产品。

还加了一条防我自己的：**每组先跑未变异的对照组并要求全绿**。
不做这一步的话，一个本来就红的产物会让**每条变异都"被检测到"**，
存活率漂亮得不像话，而它什么都没证明 —— 这是变异测试自己最容易出的假绿。

## `[实测]` 全量输出

```
$ node scripts/mutation-check.mjs
  ✔ 红  E1-endpoint-dead
  ✔ 红  E1-state-dropped
  ✔ 红  E1-bodyJson-dropped
  ✔ 红  E1-tags-dropped
  ✔ 红  E2-host-domain-rule
  ✔ 红  E2-origin-sameorigin
  ✔ 红  E2-secfetch
  ✔ 红  E3-write-no-mock-notimpl
  ✔ 红  E3-write-no-mock-offline
  ✔ 红  E3-write-no-mock-shortcut
  ✔ 红  E3-csrf-header
  ✔ 红  E3-credentials
  ✔ 红  E3-handshake-gate

共 13 条：13 条被测出，0 条存活。
✔ mutation-check: 每一条被守护的行为，改坏了都会红。
exit=0
```

## 这个脚本自己的三种失败模式我都验过（不然它就是下一盏假绿灯）

```
$ # ① 锚点失效（第一次跑就真实遇到了，不是我造的）
E3-write-no-mock-notimpl: 锚点在 apps/web/.test-out/unit/lib/api/client.js 里出现 0 次（要求恰好 1 次）——
    代码动过了，请**重新指锚点**，别把这条删掉。
exit=1

$ # ② 对照组本来就不绿 → 整组作废，不当结论
SELFTEST-control-red: **对照组就不是绿的**（未变异时 exit=1）—— 本组全部作废。
exit=1

$ # ③ 存活（用一条等价变异——只改注释文字——自检）
  ✘ 存活  SELFTEST-equivalent
共 1 条：0 条被测出，1 条存活。
exit=1
```

**清单只收我这一轮亲手验过会红的 13 条。** 没有把 T-137 那 22 个存活里我没修的那些
先写进去占位 —— 那会让脚本一跑就一片红，三天之内没人再跑它。

---

# §E 与 `notes-contract` 的重复：合并时按这张表核

两个文件都在测 `GET /api/notes/:uid`。**我全程没碰他的实现，也没碰他的文件。**

| 断言                                                    | 他的 `noteDetailContract.test.ts` | 我的 `rest/noteDetail.test.ts`                                                                    |
| ------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------- |
| `state` 存在且是 `media_assets` 那一列的真值            | ✅                                | ✅（我只断言"存在且是字符串"——刚上传的资产本来就可能还在处理中，把状态值写死才是把 bug 写成期望） |
| `state:'ready'` 时 url 真的取得回字节                   | ✅ **只有他有**                   | ❌                                                                                                |
| `bodyJson` 往返 / 是对象不是字符串 / 没写过时为 null    | ✅                                | ✅（前两条重复）                                                                                  |
| GET 的输出原样喂回 PATCH 必须幂等                       | ✅ **只有他有**                   | ❌                                                                                                |
| 顶层键必须齐                                            | ✅ **只有他有**                   | ❌                                                                                                |
| 404 NOTE_NOT_FOUND                                      | ✅                                | ✅（重复）                                                                                        |
| **非 ULID 段位落到后续路由（405，不被详情分支吃掉）**   | ❌                                | ✅ **只有我有**                                                                                   |
| **`tags` 是数组且无标签时为 `[]`**                      | ❌                                | ✅ **只有我有**                                                                                   |
| **`starred` 写进去能从详情端点读回来（往返）**          | ❌                                | ✅ **只有我有**                                                                                   |
| **`assets[].url` 与该 asset 的 `uid` 一致**             | ❌                                | ✅ **只有我有**                                                                                   |
| **`folderUid` 必须在 `/api/folders` 的树里查得到**      | ❌                                | ✅ **只有我有**                                                                                   |
| **详情与列表对同一条笔记的 `title`/`starred` 逐字一致** | ❌                                | ✅ **只有我有**                                                                                   |
| `canRetranscribe`/`segmentCount`/`createdAt` 类型       | ❌                                | ✅ **只有我有**                                                                                   |

**建议**：合成一个文件，重复的三条去掉一边即可。
`mutation-check.mjs` 里 4 条 E1 变异指向的是**我这个文件**，合并后记得改 `tests:` 那一行
（改错了不会假绿 —— 对照组会报"测试文件不存在"）。

---

# §F 顺带查实、但**我没有改**的三条

1. **`ALLOWED_HOSTS` 里的 `'::1'`（不带方括号）永远匹配不到。**
   拆 host 的正则 `^(\[[^\]]+\]|[^:]+)(?::(\d+))?$` 对任何裸 IPv6 直接 no-match，
   先一步返回 `unparsable Host`。有效的是 `'[::1]'`。
   **这不是 bug**（行为正确，RFC 7230 本来就要求方括号），是一条到不了的分支。记录，不动。
2. **`HANDOFF.md` 有三处需要更新**（我不改别人的交接文档）：
   - `:161`「`pnpm -r test` 会跑有 test 的 **4** 个包」→ 现在是 **7** 个
   - `:177`「`downloader` / `llm` / `mindmap` / `runtime` / `shared` **没有 `test` 脚本**」
     → `runtime`/`llm`/`mindmap` 三个都有了；且那句「它们的验证脚本是包内的 `verify-*.mjs`」
     对 `llm`/`mindmap` **从来就是错的** —— 它们有真的 `*.test.ts`，只是没人跑
   - `:180` 最近一次全绿记录 `555` → **843**（拆分见 TL;DR，别直接拿去当基线）
   - `:169`「db / pipeline / daemon **三个包**的 test 脚本必须保持同一行」→ **六个包**
3. **`packages/downloader` 的 13 个验证脚本仍然零 npm 入口**（T-137 的 C2）。
   本轮的守卫**盯不到它** —— 它没有 `*.test.ts`，判据不适用。
   要盯得改判据（"包内有 `verify-*.mjs` 就必须有入口"），但那条判据我拿不准会不会误伤
   （那些脚本刻意做成可独立运行的 e2e）。**没做，明说。**

下一步建议:

1. 先裁决 §E 的合并（我建议 `notes-contract` 先合，我后合；红着等会训练人忽略红灯）
2. 派人修 §TL;DR 的 IPv6 产品 bug + `restart-datadir.test.ts` 写全局指针那条
3. E7（9 个端点）单独立卡；E4/E5/E6 按 §A 末尾的理由排

需要 Manager 决策:

- §E 的合并顺序与归并到哪个文件
- `guard.ts` 的 IPv6 修复派给谁（安全边界，我判断该单独复核，不该顺手改）
- `mutation-check.mjs` 要不要写进 HANDOFF 的"怎么验"一节（我建议写，但**明确标注它不是门禁**）
