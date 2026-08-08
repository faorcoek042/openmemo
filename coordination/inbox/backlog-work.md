# inbox / backlog-work

## [2026-08-07 13:40] T-164 DONE —— 剩余待办按「用户能不能撞上」清了一轮

---

# TL;DR（Manager 只读这里）

## 数字（三处清单去重后的准确值）

|                        |   条数 | 说明                                                                                                                                                               |
| ---------------------- | -----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 三处清单原始条目       | **39** | `progress-audit §4` 13 条（①–⑬，不是 12）+ `§2` A5/B8/C9 = 22 条 + `gates-fix §5` 4 条                                                                             |
| 去重后                 | **38** | **只有一对真重复**：`progress-audit A4`（Vulkan 补目录）≡ `gates-fix §5.1`。`A3` 与 `§4⑦⑧` 看着像重复，其实 A3 是三个子断点的伞，⑦⑧ 各是其中一个 —— 按"件"算不重复 |
| 我开工前**已经做掉**的 |  **7** | 全部是 T-160(`gates-fix`) 的成果。**我对着代码逐条复核过，不是采信回执**（证据见 §1）                                                                              |
| **我这轮修掉**         |  **7** | 见下表                                                                                                                                                             |
| **剩余**               | **24** | 排序表在 §3，可直接拿来排期                                                                                                                                        |

外加**半条**：`§4⑬` 的「`runTranscribeJob` 零测试引用」——现在有了（`jobs/mergeWords.test.ts` 真跑一遍 runner）。
另一半（HEAD 从未跑过 CI）仍开着，归你。

## 修掉的 7 条，按「用户多快撞上」排

| #     | 事                                              | 用户此前会遇到什么                                                                                                                           | 撤掉后变红？         |
| ----- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| **1** | **录一次音留一条 ready 死笔记**（§4②）          | 没装流式模型时点一次「开始录音」→ 停止（或**只是关掉标签页**）→ 列表里多一条 0 秒、打不开、状态却是「就绪」的笔记。**每次录音都会中招**      | ✅ M1 / M2 各 1 条红 |
| **2** | **录完的笔记在重跑结束前根本没有音源**（§4③）   | 波形和时间码都在，`<audio>` 却不进 DOM —— 播放键点了没反应、点段落也不跳，**零报错**。一句话都没识别出来时连重跑 job 都不排 → **永远**播不了 | ✅ M8 1 条红         |
| **3** | **重新转写丢词级时间戳**（§4④）                 | 点一次「重新转写」或任何 F3 离线重跑 → **全稿** `words` 变 NULL → 逐字高亮永久降级成整句，而 `WordLevelBadge` 还告诉他"这个引擎只有句级"     | ✅ M3 **3 条红**     |
| **4** | **搜索三档模式是装饰品**（§4⑤）                 | 切到「语义」以为换了检索方式，服务端从头到尾不读 `mode`，三档同一份关键词结果，界面一个字不说                                                | ✅ M5 **4 条红**     |
| **5** | **删模型报假 freedBytes、磁盘不回收**（§4⑥）    | 删掉一堆模型、看着"已释放 N MB"、`du` 一个字节没少（硬链还在）。而且 `by-name/` 是发现路径 —— "已删除"的模型继续被当成装着                   | ✅ M4 **3 条红**     |
| **6** | **自检结果到不了界面**（`gates-fix §5.2`→§5.3） | 你亲手点的那次自测 `passed:true / 18.6x`，刷新一下什么都没有 —— 通过徽章 / 失败徽章 / `anyFailed` 横幅三条分支永不亮                         | ✅ M6 / M7 各 1 条红 |
| **7** | **三处注释在说谎**（§4⑫）                       | 无用户可见症状，但**每一条都会把下一个人带偏**（"probe 端点不存在"/"PATCH 端点不存在"/"把问题带出去"）                                       | — 文档类，无断言     |

**门禁**：`pnpm -r test` **1214 / 0** · `tsc -b` 0 · `eslint .` 0 · `check:sources` ✔ · `check:orphans` ✔（棘轮基线一个字没动）。
开工基线 1162/0；+52 里**我贡献 26 条**（daemon 16 / web 10），另外 26 条是 `pack-select` 与 `runner-migrate` 同期加的。

**反向验证 8/8**，全部跑在 `/tmp/backlog-work/rv` 的隔离副本上（PROTOCOL §10），
**每一条都先跑对照组确认未变异的产物全绿**。脚本留在 `/tmp/backlog-work/reverse-verify.mjs`，可重跑。
逐条输出见 §4。

## ⚠️ 边界：共享工作树里同时有两路人在改（申报）

我开工时 `git status` 干净。中途出现的这些**不是我的**：
`.github/workflows/build-backends.yml`、`vendor/manifests/{backends,components}.json`、
`scripts/ci/*`（`runner-migrate`）；`apps/daemon/src/http/rest/{backends,selfcheck}.ts`、
`apps/daemon/src/{pipeline,runtime}/setup.ts`、`packages/{downloader,pipeline,runtime,shared}/src/**`、
`scripts/selfcheck.mjs`、`packages/pipeline/src/__tests__/backendSelect.test.ts`、
`apps/daemon/src/pipeline/backendSelectWiring.test.ts`（`pack-select`）。

**一处真的重叠**：`apps/daemon/src/http/rest/state.ts` ——
`pack-select` 改的是 `backendPrefsPath()` 那一格，我加的是 `dropInstalledFiles()`。
**两块互不相交，我没动他那几行。** `git add` 时请逐块看 hunk，别整文件覆盖。

中途撞到过两次**别人写到一半的中间态**，记在这里免得下一个人去查一个不存在的 bug：

- `backends.ts(174,22): Cannot find name 'toInstalledRecord'`（几十秒后自己没了）；
- `vendor/manifests/components.json` 有一次 `JSON.parse` 失败（同上）。

---

# §1 那 7 条「已经做掉的」，我是怎么核的

**没有采信任何一份回执的自述**（包括 `gates-fix` 自己的）。逐条对着 HEAD 的代码：

| 条目                               | 判据（我实际跑的）                                                                             | 结论                                                             |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| §4① F2 上传不能重新转写            | `apps/daemon/src/http/upload.ts:641` = `originalUrl: finalPath`                                | ✅ 属实                                                          |
| §4⑦ 安装器目录 ≠ runtime 目录      | `apps/daemon/src/runtime/setup.ts` 三处改走 `findInBackendPacks()`                             | ✅ 属实                                                          |
| §4⑧ L2 门禁自指                    | `packages/runtime/src/backends/applicability.ts:110-117` 有 `advisoryCandidates` 与两条边界    | ✅ 属实                                                          |
| §2 A2 F3 两个引擎闸门              | `apps/daemon/src/pipeline/setup.ts:620,654` 走 `listInstalledModelRecords()`，不再只认环境变量 | ✅ 属实                                                          |
| §2 B1 零调用方门禁的 barrel 盲区   | `scripts/check-orphan-exports.mjs` 有第三档，实跑输出 21 条「只被再导出」                      | ✅ 属实                                                          |
| §2 C2 `/api/health` 的 host 硬编码 | `apps/daemon/src/http/server.ts:135` = `host: deps.host()`                                     | ✅ 属实                                                          |
| §2 C4 `.gitmodules` 过期注释       | 文件里已改成「从上游预编译包安装（BtbN / jellyfin-ffmpeg）」                                   | ✅ **已被别人做掉**（不在 `gates-fix` 的清单里，是顺手核出来的） |

> 这一轮的比例值得记一笔：**38 条里 7 条（18%）在清单写下之后已经被做掉了**。
> 比 `debt-cleanup`（113/187）和 `backlog-sweep`（61/105）低得多 —— 因为这三份清单本身就很新。
> 但方向一致：**清单的年龄就是它的失真度**。

---

# §2 我改了什么（逐条附成因与判据）

## 2.1 ★ 录一次音留一条「就绪」的死笔记（§4②）—— 排第一

**病灶**：`apps/daemon/src/ws/recorder.ts` 原来的顺序是
建 note → 建 transcript → 建 WAV 文件 → **最后才** `openStream()`。
拿不到引擎时只发一条 error + `#emitState('failed')` 然后 `return`，
**但 `start()` 正常 resolve** → `http/ws.ts` 把 `started` 置真、socket 不关。

用户接下来做什么都会中招：

- 点「停止」→ `stop()`；
- **只是关掉标签页** → `ws.on('close')` → `abandon()` → 同一个 `stop()`。

`stop()` 会跑完整条收尾链：回填 44 字节的空 WAV 头 → `createAsset` →
对 0 采样的文件生成 peaks → `updateNote(status:'ready')`。

**改法**（判据：_失败时不许在库里留下任何行_）：

- `openStream()` 提到**任何落库/落盘之前**；拿不到就 `#closed = true` + 发错误 + 返回 —— 一行不建、一个文件不落，`stop()`/`abandon()` 从此是 no-op；
- 新增 `get active()`，`http/ws.ts` 据此**主动关闭 socket**（否则浏览器继续录、继续推，界面停在「录音中」）；
- `RecorderPage.tsx` 收到 `ASR_STREAM_UNAVAILABLE` / `RECORD_START_FAILED` 时回到 `idle` 并**放开麦克风**（原来只弹一句红字，计时器还在走、麦克风灯还亮着）。

**断言为什么钉得住**：钉的是 `notes/transcripts/media_assets/jobs` **四张表一行都没有** + 盘上没有空 WAV，
**不是**「status ≠ ready」—— 后者把状态改成 `failed` 就能骗过去，而用户仍然会看到一条 0 秒打不开的笔记躺在列表里。

⚠️ 用例**刻意不走 WS** 来验落库那一半：经 WS 的话 `stop()` 是服务端在 `ws.on('close')` 里异步触发的，
断言可能跑在它前面 —— **那样把缺陷放回去也照样绿**。所以落库那条全程 `await` 直接驱动 `RecorderSession`，
WS 那一半（服务端会不会关连接）由另一条**客户端一个字都不发**的用例单独钉。

## 2.2 ★ 录完的笔记在重跑结束前根本没有音源（§4③）

`ws/recorder.ts` 只建 `role:'original'` 的 WAV，而 `pickAudioAsset` **只认 `audio16k`**
（后者要等离线重跑归档才出现）。→ 录完立刻打开笔记，`<audio>` 不进 DOM。
**更糟的一格**：一句话都没识别出来时 recorder 连重跑 job 都不排（`segments.length > 0` 才 enqueue）
→ 那条录音**永远**没有 `audio16k`，也就永远播不了 —— 而那恰恰是最想回去听一遍的时候。

改法：`pickAudioAsset` 首选 `audio16k`，没有就回退到 **mime 明说是 `audio/`** 的 `original`。
**不赌容器**：F1/F2 的 original 可能是 `video/*` 或站点给的任意封装，那种交给 `<audio>` 是把一种失败换成另一种。
`mime` 为 null 同样不回退。

## 2.3 ★ 重新转写丢词级时间戳（§4④）

`jobs/runners/transcribe.ts` 两阶段合并把 DB 行映射回 `MergeableSegment` 时**两处都写死 `words: null`**，
而 `words_json` 明明在库里。合并经 `replaceSegments` **整表覆盖** → 该稿所有段的词级时间戳变 NULL，**不可逆**。

改法：`words_json` 的解析**收成唯一一份** `parseWordsJson()`（放在 `db/repos.ts`，它是这一列的主人），
`rest/notes.ts` 原来那份 `parseWords` 删掉改为引用它。此前这一列有**两个读取方、行为相反** ——
一个真解析（所以第一次转写后的逐字高亮是好的），一个写死 null（所以重跑一次就没了）。

**顺带补上 `§4⑬` 的一半**：新增 `apps/daemon/src/jobs/mergeWords.test.ts` ——
`runTranscribeJob` 此前**零测试引用**（改坏它 CI 一片绿）。现在真跑一遍 runner：
真 SQLite、真 `Repos`、真 `JobQueue`、真 `SseHub`、真落盘归档，
**唯一被顶替的是 `TranscribePipeline`**（它要 ffmpeg / whisper / 真模型，而你禁止本机跑转写）。

## 2.4 ★ 搜索三档模式是装饰品（§4⑤）

服务端一直在如实告知 `{semantic:false, hybrid:false, semanticReason:"…尚无 embedding 生成环节"}`，
而前端 `select: (d) => d.hits` **把整个 `modes` 丢掉**，再用写死常量恒渲染三个 tab、默认停在 `hybrid`。
`SearchPage.tsx` 自己的注释写着「向量不可用时 UI 相应隐藏后两档」——**那段逻辑从来不存在**。

改法：档位规则抽成纯模块 `features/search/modes.ts`（`normalizeModes` / `availableModes` /
`effectiveMode` / `missingModes`），`SearchPage` 只渲染服务端真提供的那几档；
只剩一档时**不渲染选择器**；缺的那几档**用服务端给的原话**说出来（新增两条 i18n 键）。
顺带把 `noResultsHint` 那句「或试试「语义」模式」改掉 —— 它在推荐一个不存在的东西。

**两条判据写在代码里**：

- URL 里写着 `mode=semantic` 时**真正发出去的是 keyword**（原样转发正是那个谎的载体）；
- 响应里没有 `modes` 时按「只有关键词」处理 —— 与 `isUsableAsset`「字段缺失 ≠ 不可用」**方向相反，是刻意的**：
  判据不是"缺省该宽该严"，是**"哪个默认值会让界面说一句不成立的话"**。

## 2.5 ★ 删模型报假 freedBytes、磁盘不回收（§4⑥）

成因两半：`dropInstalledRecord()` **只删 manifest**（`by-name/` 与 `by-model/` 的硬链原封不动），
而 `findGarbage()` **只扫 `blobs/`** —— 它把 blob 删了就按 blob 的大小报数，
可硬链与 blob 共用 inode，**只要还有一条链指着，磁盘一个字节都不会回收**。

改法：新增 `RestState.dropInstalledFiles(id)`，在删 manifest **之前**按记录里点名的
`files[].relPath` 逐条删（用 `resolveInstalledFile()`，它自带越界检查 —— 记录若指到 models 根之外会抛，
而不是让我们 `rm` 到别人家里去），归档目录按 `unpackDirName()` 推（安装器与发现侧**唯一**的那份约定），
`by-model/<id>/` 用新导出的 `byModelDir()`（写入方与清理方共用一份，避免 `sanitizeId` 一改清理方就静默删不到）。

**判据钉的是 `du`，不是"文件不见了"**：用例自己按 **(dev, ino) 去重**算一次真实占用（`du` 的算法），
删前删后各一次，要求降幅 ≥ 4 MiB；并要求 **`model.removed` 报的 `freedBytes` 不许超过实际降幅**。
缺陷版本下降幅只有 manifest 那 893 字节，而它报 4194304 —— 差四个数量级。

## 2.6 ★ 自检结果没回写（`gates-fix §5.3`）

自检 T-160 已经修到**跑得起来**（你实测 `passed:true, 18.6x`），但结果没有人写回
`InstalledBackendPack.selfTest` —— 全仓写这个字段的只有 `backends.ts` 那句 `selfTest: null`。
三条 UI 分支（通过徽章 / 失败徽章 / `anyFailed` 横幅）永不亮，而 D-05 明说 `passed:false` 要留**持续**的警告。

改法：`hardware.ts` 的 `POST /api/backends/selftest` 读 `{id}`（前端本来就在发），
跑完调新增的 `recordSelfTest()` 写回 `manifests/backend/<id>.json`。
**不需要跨到 `RestState`**（`gates-fix` 担心的那点）—— `listInstalledBackends()` 每次都从磁盘现读，
manifest 就是那份唯一事实，写文件即可，前端已有的 `invalidateQueries` 一刷就看得见。

**一半的用例在验它什么时候必须拒绝写**：自检跑的是"当前找得到的那套 whisper-cli"，不是按包 id 分派的。
所以请求里的 `id` 只是候选，只有 `pack.backend === outcome.backendUsed` 才写。
不设这道防线的话，用户在 CUDA 包卡片上点一次自测（实际跑 CPU）会被记成"CUDA 包自检通过"——
那不是少一个功能，那是**发明一条不成立的证据**，比 `selfTest: null` 坏得多。

⚠️ 为此给 `RuntimeRoutesDeps` 加了一个**可注入的 `runSelfTest`**（默认就是真的那个）。
理由：这个仓库反复吃亏的形状是「函数写好了、没有人调它」（笔记删不掉 / 中文错误不显示 / 回滚永不可用），
而单测 `recordSelfTest()` 在那种情况下**照样全绿**。所以有一条用例打在**路由**上：
请求进去、磁盘上的 manifest 出来。边界与 `RecorderDeps.openStream` 一样：**被顶替的只有引擎**。

## 2.7 三处说谎的注释（§4⑫）

| 位置                                   | 原文说                                                  | 事实                                                                                                                            |
| -------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/features/notes/api.ts`   | 「daemon 目前没有独立的 probe 端点…会 404 → 回落 mock」 | `POST /api/notes/probe` 在 `rest/notes.ts:173`；它是 POST，而 `client.ts` 明写「写操作**永不**静默回落 mock」。**三句都不成立** |
| `apps/web/src/features/mindmap/api.ts` | 「服务端尚无对应端点…**不再对着不存在的路由发请求**」   | 紧接着的 `mutationFn` **正在发 PATCH**，端点在 `content.ts:328`                                                                 |
| `packages/mindmap/src/generate.ts`     | 「把问题带出去而不是静默产出坏数据」                    | 代码是**再 repair 一次然后照常返回**，什么都没带出去                                                                            |

前两条改成如实描述（并把当初那个中间态的教训保留下来）；第三条**顺手让它真的出声**：
`repair` 是幂等的（无损清理），"再 repair 一次"本就不可能修好第一次没修好的东西 ——
现在仍不合法就打一行带 issue 码的告警。**没有改 `GenerateResult` 的形状**（那会牵动 runner 与端点，是另一件事）。

---

# §3 剩余 24 条 —— 排序表（可直接拿来排期）

> ⚠️ **[2026-08-07 15:05 · `ui-backlog` T-165] 这张表已过期，最新状态见 `coordination/inbox/ui-backlog.md §3`。**
> 本轮做掉 A-1 / A-2 / A-3 与 B-12 的侧栏那半；另外查出 **B-12 的「换数据源」那半在本表写下之前就已经做完了**、
> **A-6 在 web 这一侧不欠债**。下面的原文一行未改（PROTOCOL §1），只加这条指针。

排序判据（照你给的）：**用户能不能撞上 > 会不会误导人 > 其它**。
「界面明文承诺了、但必然失败」排在「点得到但恒不可用」前面，后者又排在「压根没有」前面。

## 🔴 A 组：用户能撞上（7 条）

|     # | 项                                                                        | 用户会看到什么                                                                         | 规模 | 归属                      | 我核过的事实                                                                                                                                                                                                                                                                                                                                       |
| ----: | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | `/runtime` 对**已装的** ffmpeg 显示「Install 119 MB」（`gates-fix §5.2`） | 装好的东西界面说没装，点下去重下 119 MB                                                | S    | `pack-select`             | 全仓两个互不相干的"已安装"：A=盘上有文件（`findInBackendPacks`）、B=有 manifest。**B 的写入方全仓只有 `startPackInstall()` 那一句**，安装器刻意"blob 先落、manifest 最后写"，**崩在中间就是这个状态**。修法见 `gates-fix §5.2`（启动对账 / catalog 现算，建议两条都做）。⚠️ 我**没动**：`findInBackendPacks` 及其调用方是 `pack-select` 在跑的地盘 |
| **2** | 「推荐」徽章等于零信息量（§4⑩）                                           | CPU 机器上**每个可装的包**都戴推荐徽章 + 主按钮                                        | S    | `architect`+`gpu-runtime` | `[实测]` `backends.json` 11 个包 = `{cpu:10, cuda:1}`；`backends.ts:261` `recommended = applicable && backend === selectedBackend`；`BackendPackCard.tsx:130` 真渲染徽章、`:81` 还把按钮变 primary                                                                                                                                                 |
| **3** | `inapplicableKind` 白做了（§4⑪）                                          | 干净机器上「不可用」不分「还没探测到」与「确认不支持」，用户以为自己机器不支持就不装了 | S    | `architect`               | `[实测]` `backends.ts` 精心区分 `platform/undetermined/unsupported` 并在 `:259` 发出去，**`apps/web` 零命中**。它想防的正是这件事                                                                                                                                                                                                                  |
| **4** | `openmemo-probe` 没有分发通道（A3 剩下的那一格）                          | Win/Linux 有 N 卡的用户永远看到「尚未探测到硬件能力」                                  | M    | `pack-publish`            | `gates-fix` 已把**接线侧**备好（包里一有它就找得到）。缺的是一次 release 资产 + 一条 manifest 条目。**"不建/改/删 release" 是硬边界**，agent 做不了                                                                                                                                                                                                |
| **5** | `ytdlp-macos-arm64` 装的是 universal2 却声明 `arch:"arm64"`（§4⑨）        | Intel Mac **一个组件都装不上**                                                         | XS   | `runner-migrate`          | `[实测]` `backends.json:407` `os:darwin, arch:arm64`，而 `displayNameZh` 自己写着「macOS 通用二进制」。⚠️ macOS Intel 已被你 08-05 裁掉，所以**影响面已经很小**；`vendor/manifests/` 是 `runner-migrate` 的地盘，我没碰                                                                                                                            |
| **6** | `sourceBaseUrl`（自定义下载源）是半截（B5）                               | 存得下来、永远不生效                                                                   | XS   | `model-mgmt`              | `[实测]` 唯一写入 `models.ts:953`，**零读取方**。`progress-audit` 建议删（连同 `SelectSourceRequest.baseUrl`），我同意：留字段不做界面是把半截藏起来                                                                                                                                                                                               |
| **7** | 组件「回滚」（C3）                                                        | `efe8fd4` 已把假承诺拿掉，**现状不再撒谎**，降级为产品取舍                             | S    | 你（写进 ADR）            | `[实测]` `stashForRollback` 仍零调用方（`components.ts:207` 定义 + 两处注释/测试引用）。建议按 `progress-audit` 说的「v1 不做，写进 ADR」封掉，别继续挂着                                                                                                                                                                                          |

## 🟠 B 组：会误导人 / 攒技术债（9 条）

|      # | 项                                                                     | 不做会怎样                                                                                                        | 规模                      | 归属                          |
| -----: | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------- | ----------------------------- |
|  **8** | **A1 重建 `apps/web/dist` 并重启 `:10000`**                            | 你和用户对着一个落后十几个提交的界面做验收。**我这轮 7 条修复他一条也看不见**                                     | XS                        | **只有你能做**（PROTOCOL §7） |
|  **9** | A5 章程 §3 订正块重写                                                  | 它把「有产物」与「网页可装」混为一谈，照它决策会走偏                                                              | S                         | 你                            |
| **10** | `gates-fix §5.4` `PENDING-USER-DECISIONS §D` 订正                      | ADR-013「中文默认=Paraformer」被列为"已生效"，实际是「已实现，未默认安装」                                        | XS                        | 你                            |
| **11** | C1 两个 TOCTOU 的裁决依据已失效 + `SECURITY.md §0` 措辞                | 「这次部署的选择」被写成「产品默认」，所有基于它的风险评估都偏一档                                                | S                         | 你                            |
| **12** | C6 诊断页换 `/api/selfcheck` + **`/diagnostics` `/components` 进侧栏** | 要求 2.1 说的"显示状态"页，用户平时点不到                                                                         | XS（侧栏）/ L（换数据源） | `architect`                   |
| **13** | B8 `hf-mirror` 的口径                                                  | 3 份 manifest 里 78 处标着"镜像"，实测只是 308 跳回源站 —— 假冗余                                                 | S                         | `model-mgmt`                  |
| **14** | B2 `markmap-lib` / `markmap-view` 删不删                               | 两个零 import 的依赖挂在供应链上。⚠️ 删时**连带**拿掉 `MindmapView.tsx` 那句「切到大纲视图…」——产品里没有大纲视图 | S                         | `oss-scout`                   |
| **15** | C7 老安装记录补 `role` 迁移                                            | 自检里进 `skippedWithoutRole`，会出声不会自愈 —— 长期训练人忽略自检输出                                           | S                         | `model-mgmt`                  |
| **16** | B7 ANE 真机验证（一次 macOS runner）                                   | mac 用户可能吃 48× 延迟且无提示；接线三处已改，没人在真机确认过                                                   | M                         | `pack-publish`                |

## 🟡 C 组：需要拍板但不阻塞任何人（8 条）

|      # | 项                                                                 | 建议                                                                                                                                             |
| -----: | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **17** | A4 / `gates-fix §5.1` Vulkan 补目录                                | **你已裁定先别补**，两位都同意。门禁侧已解开，剩包本身：不自包含 + `GLIBC_2.38`。`amd-vulkan` T-161 报这两条已消，**补目录前请让它出具一次实测** |
| **18** | B3 `check` 脚本 `pnpm -r build` → `tsc -b && build:safe` 追认/回退 | 追认。⚠️ 根 `"build": "pnpm -r build"` **还在**，陷阱只是从 `check` 挪开了                                                                       |
| **19** | B4 `unpackArchive` 失败自清 `destDir`                              | 不改，改成写进契约 + 一条断言钉住                                                                                                                |
| **20** | B6 翻页次级键 `n.id DESC` 的定性                                   | 接受"规范收紧"，但在 HANDOFF 上留一句"它没被任何断言覆盖过"                                                                                      |
| **21** | C5 GitHub 仓库描述 + topics                                        | 用 `docs-public` 的①，**不要**写"支持 CUDA / AMD / 全平台加速"                                                                                   |
| **22** | C8 `unpack` 行为变化转达 `pack-publish`                            | 转达即可，不动代码                                                                                                                               |
| **23** | C9 `no-restricted-imports` 维持如实降级                            | 维持。加一条守不住的规则比诚实地没有规则更危险                                                                                                   |
| **24** | §4⑬ **HEAD 从未跑过 CI**                                           | 归你。`runTranscribeJob` 零测试那一半**我这轮补上了**，另一半（真的跑一次 CI）不是 agent 能做的                                                  |

---

# §4 反向验证（8/8，全部在 `/tmp/backlog-work/rv` 的隔离副本）

**共享工作树全程没有坏过一秒** —— 变异打在副本的**源码**上再重新编译（`npx tsc -b`，3.8s），
不是改 `dist`。每条**先跑对照组**要求未变异的产物全绿；对照组不绿整条作废。
锚点在源文件里必须**恰好出现一次**，否则脚本当场报错拒绝乱改。

| 撤掉什么（= 缺陷原状）                                                   | 结果                 | 红在哪                                                                   |
| ------------------------------------------------------------------------ | -------------------- | ------------------------------------------------------------------------ |
| M1 `recorder.ts` 的引擎前置 + `#closed`（回到"先建 note 再 openStream"） | ✔ exit 1             | 「引擎不可用却建了笔记 —— 这就是那条 0 秒打不开的「就绪」死笔记」        |
| M2 `ws.ts` 的 `if (!session.active) ws.close()`                          | ✔ exit 1             | 「服务端却把 WS 留着 —— 浏览器会继续录、继续推」                         |
| M3 `transcribe.ts` 两处 `parseWordsJson` → `null`                        | ✔ exit 1（**3 条**） | 「「我改过这一句」的 words_json 是 NULL —— 逐字高亮从这一刻起永久降级」  |
| M4 `state.ts` 的 `dropInstalledFiles(id)` 调用                           | ✔ exit 1（**3 条**） | 「磁盘只少了 **893** 字节，至少应当少 **4194304**」                      |
| M5 `modes.ts` 的 `availableModes` 改回写死三档                           | ✔ exit 1（**4 条**） | 「服务端明说 semantic/hybrid 为假，它们却仍然可选」                      |
| M6 `hardware.ts` 里 `recordSelfTest()` 的调用                            | ✔ exit 1             | 「响应说没记下来：`"recorded":false`」+ manifest 里 `selfTest` 仍是 null |
| M7 `recordSelfTest` 的 backend 认领防线                                  | ✔ exit 1             | 「把一次 CPU 自检记成了 CUDA 包通过」                                    |
| M8 `pickAudioAsset` 的 original 回退                                     | ✔ exit 1             | 「刚录完的笔记选不出音源：波形和时间码都在，点播放什么都不发生」         |

**把名字遮住之后这些断言什么时候会失败**（自问自答，逐条）：

- M1/M2 → 有人把"引擎不可用"这条路上的任何一步挪回落库之后，或者忘了关连接；
- M3 → 任何人再把 `words` 在合并链上写成 null（含"顺手简化"）；
- M4 → 任何人只删 manifest 不删链，或让 `freedBytes` 报一个没真释放的数；
- M5 → 任何人把档位改回写死，或把 URL 里的 mode 原样转发；
- M6/M7 → 自检结果不落库，或落到没跑过它的那个包头上；
- M8 → 回退被删掉，或反过来把 `original` 顶掉 `audio16k`（有阳性对照钉着）。

⚠️ M7 第一版我写成 `if (false)`，**变异后编译不过** —— 那只证明"改坏了编译不了"，不证明测试抓得住。
改成 `asked.backend !== used && asked.id === '__never_matches__'`（类型合法、恒假）后才是真的红。

---

# §5 交付文件（**请 `git add` 后用 `git diff --cached --name-only` 逐条核对**）

改：

```
apps/daemon/src/ws/recorder.ts               引擎前置 + #closed + get active()
apps/daemon/src/ws/recorder.test.ts          +3（引擎不可用不留任何行 / active / WS 关闭）
apps/daemon/src/http/ws.ts                   start() 完成后按 active 决定关不关 socket
apps/daemon/src/db/repos.ts                  parseWordsJson()（words_json 唯一的一份读法）
apps/daemon/src/http/rest/notes.ts           删掉本地那份 parseWords，改用 repos 的
apps/daemon/src/jobs/runners/transcribe.ts   两处 words: null → parseWordsJson(r.words_json)
apps/daemon/src/http/rest/state.ts           dropInstalledFiles() + dropInstalledRecord 调它
apps/daemon/src/pipeline/modelStore.ts       导出 byModelDir()（写入方与清理方共用）
apps/daemon/src/http/rest/hardware.ts        selftest 读 {id} + recordSelfTest() + 可注入 runSelfTest
apps/web/src/features/recorder/RecorderPage.tsx   致命错误回 idle 并放开麦克风
apps/web/src/features/notes/noteAssets.ts    pickAudioAsset 回退到 audio/* 的 original
apps/web/src/features/notes/noteAssets.test.ts    +4
apps/web/src/features/search/api.ts          不再丢掉 modes
apps/web/src/features/search/SearchPage.tsx  档位由服务端决定 + 缺的那几档如实说出来
apps/web/src/app/i18n/locales/{zh-CN,en}.json     +2 键、改 1 句（只动 search 段，未重排既有键）
apps/web/tsconfig.test.json                  登记 searchModes.test.ts + modes.ts
apps/web/src/features/notes/api.ts           说谎注释①
apps/web/src/features/mindmap/api.ts         说谎注释②
packages/mindmap/src/generate.ts             说谎注释③ + 让它真的出声
```

新增：

```
apps/daemon/src/jobs/mergeWords.test.ts              3 条（**runTranscribeJob 的第一份用例**）
apps/daemon/src/http/rest/modelDiskReclaim.test.ts   4 条
apps/daemon/src/http/rest/selfTestRecord.test.ts     6 条
apps/web/src/features/search/modes.ts                档位纯逻辑
apps/web/src/features/search/searchModes.test.ts     6 条
coordination/inbox/backlog-work.md                   本文件
```

**未 commit、未 push**（没接到指令）。要我提交就说一声。
⚠️ `apps/daemon/src/http/rest/state.ts` 与 `pack-select` 共用，见 TL;DR 的边界申报。

---

# §6 纪律申报

| 条                                                                                                                                    | 结果                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/dist`                                                                                                                       | ✅ **未构建**。全程只跑 `pnpm build:safe` / `npx tsc -b`；`vite build` 一次都没跑                                                            |
| `pnpm -r build`                                                                                                                       | ✅ 未跑                                                                                                                                      |
| `:10000`                                                                                                                              | ✅ **一个请求都没发**（连 GET 都没有）。未重启、未 kill、未占用                                                                              |
| `/root/data-memo`                                                                                                                     | ✅ 未读未写                                                                                                                                  |
| 指针文件                                                                                                                              | ✅ 未碰。所有会写模型根的用例都在**模块顶层**钉 `OPENMEMO_MODELS` / `OPENMEMO_EXT_DIR` 到 `mkdtemp`（PROTOCOL §9-bis，窗口为零，无清理代码） |
| `pkill -f`                                                                                                                            | ✅ 未用                                                                                                                                      |
| release                                                                                                                               | ✅ 未建/未改/未删。`gh` 一次都没用                                                                                                           |
| 本机 whisper 转写                                                                                                                     | ✅ **一次都没跑**。`mergeWords.test.ts` 顶替的正是 `TranscribePipeline`；`selfTestRecord.test.ts` 顶替的是自检执行器                         |
| 反向验证                                                                                                                              | ✅ 全部在 `/tmp/backlog-work/rv`，共享工作树没有坏过一秒                                                                                     |
| `findInBackendPacks()` 及其调用方                                                                                                     | ✅ **未碰**（`pack-select` 在跑）                                                                                                            |
| `.github/**` · `vendor/manifests/**` · `scripts/ci/**`                                                                                | ✅ **未碰**（`runner-migrate` 在跑；`vendor/manifests` 只读过）                                                                              |
| `HANDOFF.md` / `00-CHARTER.md` / `BOARD.md` / `ROSTER.md` / `docs/adr/**` / `PENDING-USER-DECISIONS.md` / `README.md` / `SECURITY.md` | ✅ 一个字未改                                                                                                                                |
| 新增 `src/**/*.test.ts` 登记                                                                                                          | ✅ `apps/web/tsconfig.test.json` 已加两条（daemon 侧靠 `tsc -b` 全量编译，无白名单）                                                         |
| 派出的 subagent                                                                                                                       | 0 个                                                                                                                                         |
