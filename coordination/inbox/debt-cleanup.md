# debt-cleanup —— 技术债清理回执

## [2026-08-06] T-152 DONE

交付: 见下方「§改了什么」。5 个提交，全部逐个 `git add`（**没有用过 `-A`**）。
未碰 `/root/data-memo`、未写 `datadir.json`、未重启/占用 `:10000`（**一个请求都没发**）、
未跑 `pnpm -r build`、未构建 `apps/web/dist`、未用 `pkill -f`、未跑本地 whisper 转写、
未建/改/删 release。

---

# TL;DR

**基线**：我开工时 `[实测]` `pnpm -r test` = **934 pass / 0 fail**（任务书写的 931 已被在途 agent 涨过）。
收尾时**我自己的包全绿**；工作区里有 **11 条红全部来自别人的在途改动**，逐条定位见 §红灯归属。

## 🔴 本轮最重要的发现（不在盘点清单上，是清理过程中撞出来的）

**`packages/pipeline/src/subprocess/argGuard.ts` 里有三个字面控制字节（`0x00`/`0x1f`/`0x7f`），
于是 `grep -r` 和 `git diff` 都在静默跳过这个文件。**

- 它是**参数注入防线、SSRF 私网判定、媒体扩展名白名单、可执行文件白名单**所在的文件 ——
  本仓库最该被审计的一个。
- `grep -r` 见到 NUL 判 binary → **一声不响跳过**。不报错、不打 "Binary file matches"、就是没有输出。
- **本项目历次盘点大量依赖 `grep -rn … → 0 命中` 下结论，对这两个文件每一条都是无效的。**
- `[实测]` 我自己当场中枪：先用 `grep -r` 查 `redactProxyUrl`，得到"只有一处，D4 那条重复已修好"。
  装上守卫、把文件改回文本后再查 —— `proxy.ts:178` 的**第二份一直都在**。那条结论是假的。
- **`git` 也一样**。历史上每次改 `argGuard.ts` 在 review 里长这样：
  ```
  3628df2  packages/pipeline/src/subprocess/argGuard.ts | Bin 19155 -> 21234 bytes
  a401d59  packages/pipeline/src/subprocess/argGuard.ts | Bin 16883 -> 19155 bytes
           1 file changed, 0 insertions(+), 0 deletions(-)
  ```
  `a401d59` 的标题是「fix: 路径守卫一族 —— 越界读取实证并堵死 (T-143)」。
  **一次安全修复的 diff，谁都没看见过。**
- 与 ⑤G（`.gitignore` 少一个前导 `/`）同族：**让工具静默忽略源码**。已修 + 加守卫。
- **守卫上线当天就抓到第四例**（`catalog-truth` 刚写进 `components.test.tsx` 的一个 `?? '\x00'`）。

**建议写进 HANDOFF ⑤**，与 ⑤G 并列。

## 清了什么（按"会不会误导人"排，不按数量）

| 优先级 | 族 | 结果 |
|---|---|---|
| 1 | **文档断言** | 核了 **187 条**，判定 **113 条已不成立**；已落地订正见 §1。**这是本轮的大头** |
| 2 | **重复实现（8 处已分叉）** | 清 **2 处**（D5 时间码 = 真 bug、D4 代理脱敏）；**1 处证实仍全开但跨三家地界**（D1 扩展名）；其余见 §2 |
| 3 | **34 个没人读的字段** | **做了判定不做修改**（全在别人地界）。结论见 §3 —— 其中 **6 个"前端其实读了"是假的**，是同名碰撞 |
| 4 | 死导出 / 死词条 / wavesurfer | **基本没清**，理由在 §4。**这是有意的**，不是没做完 |

## 没清的，说清楚为什么（这一节比上面那张表重要）

- **84 个死导出：一个没删。** 我把 32 个（我地界内的）用 AST 复核到位了，**但没有删**。
  理由：其中有几个是**刻意留着的**（benchmark 子系统、`WhisperServerEngine` —— 债是那条缺失的注册线，
  不是这些代码），删掉等于扔掉能用的东西；而剩下的机械删除**现在做会和四个在途 agent 撞车**。
  **删 32 个换来一次冲突，不如交出一份复核过的清单。** 检测脚本已交（`/tmp/debt-cleanup/dead-exports.mjs`）。
- **60 条死 i18n 词条：一条没删。** `apps/web/src/app/i18n/locales/*.json` 是 `frontend-truth` 的地界
  且是热区，任务书点名要先申报。而且**这张表最大的价值不是删 120 条字符串，是它是一张
  「哪些功能只写了文案」的地图** —— 删掉就把地图也删了。建议留到那些功能有结论之后再动。
- **`wavesurfer.js`：没删，也不建议现在删。** 查清楚了（§5），但决定权在 `frontend-truth`。
- **`packages/runtime` 的 P7（三份 execFile 包装）：没动**，但**从里面查出两个真分歧**（§2.4）。
  没动是因为 `packages/runtime/src/index.ts` 当时正被别人改着。

---

# §1 文档：核了 187 条，113 条已不成立

## 1.1 方法（为什么这次的数字可信）

两路独立核查，**每条判决都带 `[实测]`（命令 + 真实输出）或 `[读码]`（绝对路径:行号）**，
判"零命中"时**同时给出含注释与剥注释两个数字**（剥注释用 TS scanner 状态机，不是正则）。
判决表存档：`/tmp/debt-cleanup/verdicts-design.md`、`/tmp/debt-cleanup/verdicts-research.md`。

| | 核了 | 已不成立 | 仍成立 | 拿不准 |
|---|---|---|---|---|
| D-01…D-06 / D-11 | 93 | 57 | 30 | 6 |
| SECURITY / R-* / coordination | 94 | 56 | 30 | 8 |
| **合计** | **187** | **113** | **60** | **14** |

「写着没做实际做了」在设计文档里占 **31/57**，与盘点自评的「约 60%」吻合。

## 1.2 两条推翻了盘点结论的元发现

**① 真正的大头不是失效的 `file:line`，是「结构清单」。**
`file:line` 引用全 7 份设计文档只有 15 条，指不到的 4 条（**27%**，盘点自评 1/3，基本准确）。
但：

- `D-01 §1.2` 的 daemon 目录树 **20 项里 10 项不存在**（50%）
- `D-05 §3` 的 `components/common/` 清单 **12 个文件里 7 个从来不存在**（58%，`ProblemBanner`/
  `JobStateChip`/`StorageBar`/`TimeCode`/`ByteSize`/`RelativeTime`/`ModelPicker`，含注释 0 命中 ——
  不是改名了，是**从来没有过**）

**这两处是新人建骨架时照抄的东西。** 只修行号会漏掉更贵的那一类。
（`D-05 §3` 这条还正好解释了盘点附录 §3.3 那 7 组前端呈现层重复：
"复用别重写"的清单指向 7 个不存在的组件，于是每个人只好再写一遍。）

**② 最脏的一类是「同一份文档自己打自己」，而读者只读 TL;DR。**

- `D-03` 的 TL;DR(:33) 说解压/验签"未实现"，它自己的 §11(:564) 说"✅ 已实现"
- `D-02` 的 TL;DR(:23) 说 DDL 已跑通，它自己的 V-1(:1314) 说"26 张表尚未整体执行"
- `D-11` 的 §6.1(:316) 把两个 npm 包列为活着的例外，它自己的 §7.4(:591) 说已删除
- `SECURITY.md` 的 `:325` 说解压防护"❌ 未实现"，它自己的 `:219-224` 说做了

**订正时一律优先让每份文档内部自洽。**

## 1.3 单条最危险的：文档在替一个不存在的防线背书

`D-01:1061` 与 `D-01:817` 声称「CI 用 `no-restricted-imports` **强制**，
`apps/daemon/src/subprocess/**` 之外禁止 import `node:child_process`」，
TL;DR `:11` 还特意声明这是「**架构强制点，不是编码规范建议**」。

`[实测]`：
- `eslint.config.js` 全文 115 行，`child_process` **零命中**（含注释一起 grep 也是 0）
- 那三处 `no-restricted-imports`（`:64`/`:86`/`:104`）**全是前端分层护栏**，与子进程无关
- 那个目录**不存在**（真正的 runner 在 `packages/pipeline/src/subprocess/runner.ts`）
- 剥注释后（AST，非 grep）**产品代码 7 处** import `node:child_process`，
  **除权威出口 `runner.ts` 外还有 6 处**；**全仓 19 处**
  ⚠️ 两路核查里有一路把这个数报成了「5 处 / 3 处在 runner 之外」——
  **它漏了 `packages/runtime/src/detect/system.ts`**。我独立重数后已把落到 `D-01` 的
  数字订正为 7/6 并附逐文件性质表。**记在这里是因为：连"数一遍"这件事本身也会出错，
  而两路独立核查正是为了抓这个。**
- `SECURITY.md:109` 与 `D-06:330` 重复同一条 —— **三份文档互相引用，看起来像被三处证实**
- `D-06:330-333` 里那段 `grep -rn "node:child_process" … && exit 1` 的 CI 代码块
  **只活在 markdown 里**，没有任何 workflow 引用它

这不是文档过时，是 **`D-01 §8.4` 整节的立论前提（"所有防护集中在一个文件里审计"）是假的**。
已在三份文档里改成如实（"约定，尚未机器强制"）并列出实际例外。
**要么补规则+白名单，要么保持如实 —— 但不许留着原来那句。** → §需要 Manager 决策 ①

## 1.4 改了哪些文件

| 文件 | 处置 |
|---|---|
| `docs/SECURITY.md` | 三条点名项订正（解压防护 ❌→✅、"唯一 import child_process" 如实降级、补记 auth 的 same-origin fallback）+ 附录「验证状态」表 3 行订正 |
| `docs/design/D-01`…`D-06`、`D-11` | 逐条落地判决表（含 §1.2 目录树、§3 组件清单两处重写） |
| `docs/design/D-07` / `D-08` | **标 `superseded` 并互相补上反向链接**（此前 D-08 只单向声明、D-07 什么标记都没有）+ TL;DR 前加逐条对照表 |
| `docs/design/D-09` / `D-10` | TL;DR 前加对照表：四条 🚨 里已闭合的逐条标出，**仍成立的如实保留** |
| `docs/design/D-05 §7.3a` | 订正 wavesurfer（见 §5） |
| `docs/research/R-03` | 标 superseded + header；**§3 许可证矩阵 / §4 FFmpeg LGPL / §5 yt-dlp 分级保留**（实测确认全仓独家，9 条命中无一重复，且 `vendor/README.md` 引用它） |
| `docs/research/R-01/R-02/R-06` | 加 header + 就地划线 |
| `coordination/FEATURE-COVERAGE.md` | 20 条 🔴 里 **16 条是假阴性**，逐条订正；**3 条仍值得抢救的单独标出** |
| `coordination/PENDING-USER-DECISIONS.md` | A-1「唯一硬阻塞」已被 ADR-015 明文撤销；C-2 的裁决依据两个前提都已被用户推翻 |

**订正一律保留「此前写着 X」**（⑤D-bis 的规矩），一处都没有抹掉旧说法。
**没有删任何章节、没有动任何章节号** —— D-01 有 350+ 处代码注释按章节号引用它。

**一处刻意的部分执行（如实记）**：`D-01 §1.1` 那张 ASCII 全局框图里仍标着 `/ws/asr-worker`
（ADR-006 决策 3 已降为实验特性、v1 不实现）。**没改**，因为那是等宽 box-drawing 对齐的框，
加字会把整框拉歪。订正落在 `§3.1` / `§3.4` 的表格与表下说明、以及重写后的 `§1.2` 树里
（新树已不再提它）。要连框图一起标，得单独调整那一整块的对齐。

## 1.5 我**没有**动的文档（PROTOCOL §1「仅 Manager 写」）

`coordination/BOARD.md`、`coordination/ROSTER.md`、`docs/adr/**`、`docs/00-CHARTER.md`。
**已核实的问题 + 可直接抄的补丁文本**见 §需要 Manager 决策 ②。

---

# §2 重复实现

## 2.1 ✅ D5 `formatTimestamp` —— 这是一个真的用户可见 bug，已修（提交 `a515216`）

`packages/mindmap` 里有两份，输出不同：

| 输入 ms | `adapters/markmap.ts` | `serialize/markdown.ts` |
|---|---|---|
| 90500 | `1:30` | `01:31` |
| 3599999 | `59:59` | `1:00:00` |

两处差异各自独立：`Math.floor` vs `Math.round`（后者把 90.5s **进位到 91s**，
时间码指向那一刻**之后** —— 跳过去会错过用户要找的那句话的开头），以及分钟位补不补零。

**后果**：同一张导图，在 markmap 视图里看到的时间码，和导出成 Markdown 拿到的不是同一个数；
而 Markdown 那份还与播放器（`apps/web/src/lib/format/time.ts` 的 `timecode()`）也对不上 ——
**用户照着导出的 Markdown 去拖播放进度会拖错地方**。

保留 markmap 那份（与播放器逐字节同义），两处改为 import `../timecode.js`。

⚠️ **旧测试把 bug 写成了期望**（⑤A-15 同族）：`serialize.test.ts` 断言的正是 `A [01:23]` ——
**这条测试一直在保护那个用户可见的不一致**。已改成断言权威值并说明旧断言写错了方向。

## 2.2 ✅ D4 `redactProxyUrl` —— 已修（提交 `2896562`）

`[实测]` 7 个输入里 6 个不一样：

| 输入 | pipeline 那份 | shared 那份 |
|---|---|---|
| `http://user:pass@proxy:3128` | `http://***@proxy:3128` | `http://***:***@proxy:3128/` |
| `http://:pass@h:80` | `http://***@h`（**端口丢了**） | `http://:***@h/` |
| `''` | `<invalid proxy url>` | `null` |

第二行最难看：只有密码没有用户名时端口被规范化掉，且打码结果看起来像"只填了用户名"。
第三行会把"没配代理"显示成"配错了代理"。

**但这里不需要裁决"哪份对"**：`[实测]` pipeline 那份**没有任何生产调用方** ——
三个真消费方（daemon `rest/proxy.ts`、daemon `selfcheck.ts`、`downloader/src/proxy.ts`）
**全部** import 的是 shared 那份，只有本包自己的测试在用它。所以是删影子，不是选边。

⚠️ 旧测试同样钉的是那份影子，让"有两份实现"看起来是被覆盖的。已改成断言权威值。

## 2.3 🔴 D1 媒体扩展名白名单 —— **证实仍全开**，但跨三家地界，我没动

`[实测]` 三份清单的真实集合（HEAD `fca18f6`）：

```
pipeline MEDIA_EXTENSIONS   (24): aac aif aiff ass avi flac flv m3u8 m4a m4v mkv mov
                                  mp3 mp4 oga ogg opus srt ts vtt wav webm wma wmv
daemon   ALLOWED_UPLOAD_EXT (17): aac avi flac m4a m4v mkv mov mp3 mp4 mpeg mpg ogg
                                  opus ts wav webm wma
web      looksLikeMedia     (18): aac avi flac flv m4a m4v mkv mov mp3 mp4 mpeg mpg
                                  ogg opus wav webm wma wmv
```

四个方向的差集**逐个实测**（脚本 `/tmp/debt-cleanup/ext.mjs`）：

| 差集 | 内容 | 用户看到什么 |
|---|---|---|
| **web ∖ daemon** | `flv` `wmv` | 拖一个 `.flv`：**前端放行、出现上传行、服务端拒收** |
| **daemon ∖ web** | `ts` | 服务端收，前端的拖拽预检不认它 |
| **daemon ∖ pipeline** | `mpeg` `mpg` | 传得上去，但不在 pipeline 的媒体白名单里 |
| **pipeline ∖ daemon** | `aif` `aiff` `ass` `flv` `m3u8` `oga` `srt` `vtt` `wmv` | pipeline 认得（字幕/HLS/播放列表类多为有意），上传端一律拒 |

⚠️ 盘点当时报的是 `web∖daemon = {.flv,.wmv}` + `daemon∖pipeline = {.mpg,.mpeg}`，
**都仍然成立**；我另外查出 `daemon ∖ web = {ts}` 这一条盘点没提到。

三份分别属 `daemon-contract` / `frontend-truth` / 我。**正解是收到 `packages/shared` 一份，
三家都 import** —— 那是一次 SHARED-CHANGE，需要协调。→ §需要 Manager 决策 ③

⚠️ **E5 我本人重做了一遍，两个方向都实测**（不是引用盘点）：

```
把 packages/pipeline/src/subprocess/argGuard.ts:460 的
  return MEDIA_EXTENSIONS.has(name.slice(dot).toLowerCase());
换成 → return true;            （evil.exe / payload.sh 全部放行）
  ℹ tests 187  ℹ pass 187  ℹ fail 0      ← 全绿
换成 → throw new Error(...)    （对照组，证明这个函数确实被测试执行到）
  ℹ tests 187  ℹ pass 181  ℹ fail 6      ← 6 条红
还原后：ℹ pass 187 ℹ fail 0，`git diff packages/pipeline/` 为空
```

**这是"覆盖率与变异给出相反答案"的活样本**：函数确实被执行（行覆盖好看），
但**没有任何一条测试依赖它拒绝过什么**。
所以三份清单统一之后**必须同时补"拒绝"侧的断言** —— 否则统一完还是钉不住。

## 2.4 🟡 P7 `packages/runtime` 三份 execFile 包装 —— 没动，但查出**两个真分歧**

我没动它（当时 `packages/runtime/src/index.ts` 正被别人改着），但查出来的不只是"重复"：

1. **`detect/system.ts:31` 没有 `killSignal: 'SIGKILL'`**，另两处（`probe/runProbe.ts:71`、
   `selfTest.ts:113`）都有。默认是 SIGTERM —— 一个忽略 SIGTERM 的子进程超时后**永不 close**，
   promise 永不 settle。这条路径上跑的是 `lspci`/`wmic`/`sw_vers` 之类，
   **硬件探测会在启动时挂住**。（与 ADR-014「冷启动探针死锁」同一族，值得那边的人看一眼。）
2. **`selfTest.ts:116` 覆盖而不是前置 `LD_LIBRARY_PATH`**：
   写的是 `LD_LIBRARY_PATH: dirOf(whisperCliPath)`，而 `runProbe.ts:76` 用的是
   `joinPathVar(process.env.LD_LIBRARY_PATH, backendDir)`（前置保留原值）。
   用户机器上本来有 `LD_LIBRARY_PATH`（conda / nix / HPC 很常见）时，**自检会把它整个丢掉**。

**两条都没修**（跨地界 + 是行为改动，不是清理）。→ §需要 Manager 决策 ④

## 2.5 其余各条在 HEAD 上的状态（复核过，未动）

| # | 状态 | 归属 |
|---|---|---|
| D2 `resolveInstalledFile` | 🔴 仍 2 份（`downloader/store.ts:322` + `daemon/rest/models.ts:67`） | daemon-contract |
| D3 CSRF 令牌读取 | 🔴 仍 2 份（`client.ts` + `capture/upload.ts:132`） | frontend-truth |
| D6 笔记 DTO 镜像 | 🔴 仍在（正被 daemon-contract 收敛中） | daemon-contract |
| D7 LLM 供应商预设 | 🔴 仍在（`catalog-truth` 正在动 `llm-catalog.ts`） | catalog-truth |
| D8 provider `kind` 枚举 | 🔴 仍 3 套（shared 6 值 / llm 3 值 / web 3 值） | 跨 |
| U2–U8（daemon `http/rest/` 内部 7 处） | 🔴 仍在，全 XS | daemon-contract |
| U13 `RECORD_SAMPLE_RATE` | 🔴 仍 2 份（WebSocket 线协议常量，漂了 = 静默乱码转写） | 跨 |
| P1/P2/P3/P6 | 🟡 未分叉，未动 | 我（下一轮） |

---

# §3 34 个「daemon 发了、前端不读」的字段 —— 做了判定，没有修改

全在 `apps/daemon` / `apps/web` / `packages/shared` 三家地界内，所以我**只出判定**。

## 3.1 先说一个方法结论：naive grep 会给出 6 个假的"前端读了"

`[实测]` 28 个字段逐个在**剥注释后**的语料里查，6 个看起来"web 有命中"的**全是同名碰撞**：

| 字段 | 看起来命中在 | 实际是什么 |
|---|---|---|
| `requiresAuth` | `lib/api/types.ts:136` | **只是类型声明**，不是读取 |
| `nodeCount` | `features/mindmap/api.ts:9` | 同上 |
| `concurrencyLimit` | `features/tasks/api.ts:41` | 同上 |
| `keyword` / `semantic` | `features/search/SearchPage.tsx:12` | `SearchMode` 枚举值，**另一个概念** |
| `effective` | `ProxySettingsSection.tsx:341` | i18n 键 `settings.proxy.effective` + 本地计算 |
| `selected` | `ModelsPage.tsx:334` | `aria-selected` |

**28 个抽查的全部确认为真的没人读。** 盘点那 34 条是对的。

## 3.2 判定：不是所有的都该"接上"，有两条其实**该反过来**

我逐个读了产出侧。抽样深查 4 条，结论有两条推翻了"前端漏读"这个默认框架：

| 字段 | 判定 | 依据 |
|---|---|---|
| **`ProbeResult.requiresAuth`** | **不该发** | `apps/daemon/src/http/rest/notes.ts:211-214` **硬编码 `false`**，注释自己写着「猜出一个假的 `requiresAuth` 比没有这个字段更糟」。**契约声明了一个谁都没在算的字段** —— 前端不读是对的，债在契约那头 |
| **`ActivateResponse.reloadRequired`** | **不该发（第二事实来源）** | `rest/models.ts:569` **硬编码 `true`**；而前端的"需要重启"UI 读的是另一条路（`ReadinessBanner.tsx:145` ← `/api/health` 的 `restartRequired`）。两个来源、其中一个恒真 |
| **`TranscribeDoneEvent.partial`** | 低价值 | `transcribe.ts:507` 是真值，但同样的信息经 `note.status === 'partial'` 已经到了界面（`NotesListPage.tsx:177`）。接它只省一次 refetch |
| **`GcResponse.removedFiles`** | **前端漏读**，值得接 | 现在只说清了多少字节，不说清了几个文件 |

**其余 30 条我按语义归类，没有逐个深查**（诚实标注）。我的建议分档：

- **值得接（有对应空位）**：`InstalledModel/InstalledBackendPack.installedAt`+`verifiedAt`（4 条 ——
  与 `build` 字段那次**完全同形**：后端发了、前端逐字段手抄漏掉）、`GcResponse.removedFiles`、
  `ProbeResult.mediaCount`、`MediaReadyEvent.hasVideo`、`BackendStatus.isa`、`DiskInfo.mount`、
  `ResourceRequirements.diskRequiredMB`、`ProxyProbe/SourceLatency.httpStatus`
- **该删或该建 UI，二选一**：`ModelActivatedEvent.previous` / `ActivateResponse.previous`
  （它俩是为"撤销"准备的，而撤销 UI 不存在）
- **内部键，前端本来就不该用**：`hardwareSnapshotId` / `snapshotId` / `eventsUrl`
  （`eventsUrl` 还是个 URL 拼装的第二来源）

**判据建议**（比逐条清单有用）：*一个字段进契约的门槛，应该是"有人会读它"，
不是"我算得出来"。* 现在这 34 条里至少 2 条是**硬编码的假值**，那比不发更糟 ——
它让下一个人以为这个信息存在。

---

# §4 死导出 / 死词条：为什么基本没清

## 4.1 死导出：复核到位了，**一个没删**，这是有意的

我写了 AST 检测器（`/tmp/debt-cleanup/dead-exports.mjs`），过程中**自己踩了三个坑**，
每个都值得记下来，因为它们正是"grep 判据不可信"的具体形态：

1. **排除了声明文件本身 → 只在本文件内使用的符号全被判死。** 第一版报 89 个，
   其中 `probeSource`/`loadManifest`/`planParts` 等**在自己文件里就有调用**。
   那类是"`export` 多余"，不是死码（盘点也把这 487 个列为"不值得修"）。
2. **barrel 的 `export { X } from './y.js'` 被算成"被引用了"。** benchmark 三件套、
   `WhisperServerEngine`、`isAbiCompatible` 等**只在 `index.ts` 里被转发一次**，
   于是全部假活。修法：AST 抹掉带 `moduleSpecifier` 的 `ExportDeclaration`。
3. **跨包同名互相"证明"对方活着。** `PACKAGE_NAME` 在 7 个包各导出一次、全仓零读，
   而正则 `\bPACKAGE_NAME\b` 让它们**互相计为引用**。
   （**这正是任务书点名的 `activeJobId` 陷阱的第二次现身。**）
4. **`.md` 命中不算使用。** 盘点报告点名一个符号，恰恰因为它是死的 ——
   把 `.md` 命中当引用，会让债务清单自己把自己洗白。

修完之后，我地界内 6 个包的结果与盘点**独立对上**（32 个）。

**为什么不删**：
- 其中 **benchmark 三件套 + `WhisperServerEngine`** 是**刻意留着的**（D-07/D-08 记为
  "已实现、尚未注册进候选池"）—— 债是那条缺失的注册线，删掉等于扔掉能用的东西
- `resolveModelsRoot`/`bucketForRole` 是**重复实现的另一半**（daemon 自己重写了一遍），
  正解是让 daemon 用回来，不是删掉权威那份
- 剩下的机械删除**现在做会和四个在途 agent 撞车**

**删 32 个换一次冲突，不如交出一份复核过的清单。** 脚本可直接跑。

⚠️ **我也没有把检测器装成守卫**，理由同上：它现在上线会在别人的在途改动上变红并挡住他们。
建议这一波落定后再装（那时它就是"第 33 个死导出会当场红"）。

## 4.2 死 i18n 词条：一条没删，**而且建议先别删**

`apps/web/src/app/i18n/locales/*.json` 是 `frontend-truth` 的地界 + 热区。
更重要的是：**这张表最大的价值不是删 120 条字符串，是它是一张「哪些功能只写了文案」的地图**
（`recorder.replaced*` ← 从没发过的 `x.transcribe.replaced`；`notes.rename` ← 没有入口的四个动作；
`tasks.lane.*` ← lane 标签没接进任务页）。**删掉就把地图也删了。**
建议等那些功能各自有结论之后，随功能一起处置。

---

# §5 `wavesurfer.js`：查清楚了，**结论是"该下掉"，但我没下**

`[实测]`（HEAD `fca18f6`）：

- 声明在 `apps/web/package.json:43`（`^7.12.11`），**全仓零 import** ——
  剥注释后 `.ts/.tsx` 全库 **0 命中**；只在**注释、D-05、R-03 的许可证表**里被"提到"
- 它从**第一个脚手架提交**（`4018e23` T-011）就在，**一次没被用过**
- 真正在画波形的是 `apps/web/src/features/player/Waveform.tsx`，**手写 canvas**，
  文件头写着刻意理由：「**canvas 直写，完全不进 React。** 播放位置以 ~10Hz 变化，
  走 React 会拖垮整页。」→ **这不是"忘了用"，是一个没有被写下来的相反决定**
- `notes-contract` 刚接通的 `.ompk` 解码路径（`decodeOmpk` 现在有真调用方了）
  喂的是**我们自己的 canvas**，不是 wavesurfer。`peaks.ts` 注释里那句
  "wavesurfer 期望 −1..1" 现在只是巧合成立
- `D-05 §7.3a` 写着「**不需要我们自己写 canvas**」—— **已订正**，并保留了此前写着什么

**我的判断**：渲染这条路已经定了（自写 canvas，且理由是性能约束，wavesurfer 满足不了），
所以留着它的唯一说得通的理由是它的 **`regions`/`timeline` 插件** ——
"转写稿 ↔ 音频段落高亮"这个 F5 招牌能力**还没做**。

**但这是 `frontend-truth` 的决定，不是我的**，而且 `daemon-contract` 那边正在做真 peaks
（工作区里已经出现 `apps/daemon/src/media/peaks.ts`）。→ §需要 Manager 决策 ⑤

**拿不准的地方我说清楚**：我不能证明将来做段落高亮时不会想用它的 `regions` 插件。
但即使要用，也是"重新引入 + 重写 Waveform"，和"现在留着一个零 import 的依赖"没有关系。

---

# §红灯归属（收尾时工作区的 11 条红，逐条定位）

**没有一条来自我。** 我提交的每一步都在自己的包上跑绿过。

| 红 | 出处 | 归属 |
|---|---|---|
| 3 条 `apps/web` `/models` Tab / 中英混排 | `ReferenceError: splitAsrSections is not defined` —— `asrSections.ts` 在源码里有、测试 bundle 是旧的 | `catalog-truth` 在途 |
| 8 条 `apps/daemon` `dist/media/peaks.test.js` | `apps/daemon/src/media/` 是**未跟踪的新目录** | `daemon-contract` 在途（真 peaks） |
| `tsc -b`：`apps/web/src/lib/api/mock.ts` 缺 `NoteAsset.url` | `packages/shared/src/notes.ts` 正在被改 | daemon-contract / frontend-truth 在途 |

我自己的包（收尾实测）：`mindmap 51/51` · `pipeline 187/187` · `db 53/53` · `llm 18/18` ·
`runtime 51/51` · `web unit 94/94` · `web host 10/10`。

---

# §跨界改动申报（SHARED-CHANGE / 一行级）

我动了两个**不属于我**的文件，都是**语义完全等价的字节级修改**，在这里显式申报：

1. `apps/daemon/src/http/rest/content.export.test.ts:150` —— `'a<NUL>b'` 的字面 NUL 改成 `'a\x00b'`。
   `[实测]` `'\x00' === String.fromCharCode(0)` → true。**已提交**（`df236a4`），因为不改它
   整个仓库的 grep 盲区就补不完整。→ 请 `daemon-contract` 知悉。
2. `apps/web/src/test/components.test.tsx:5291` —— `?? '<NUL>'` 改成 `?? '\x00'`。
   **未提交**（那个文件正被 `catalog-truth` 改着，提交会把他的在途工作扫走）。
   **这一处是新守卫上线当天、在别人正在写的文件里抓到的第四例。**

   ✅ **收尾时复查：已不需要我了。** `catalog-truth` 自己把那一行重写成了
   `?? '__no_checked_at__'`，比转义写法更清楚（`file` 确认该文件现在是
   `Unicode text, UTF-8 text`）。我那处临时修改已被他的改法自然取代，**没有留下任何残留**。
   记在这里是因为它正好演示了守卫想要的效果：**债务在被写下的当天就被拦住，
   而不是等下一次盘点。**

---

# §需要 Manager 决策

1. **`no-restricted-imports` 那条不存在的防线**（§1.3）：要**补规则 + 白名单**，
   还是**保持如实降级**？三份文档现在写的是"约定，当前无机器执行者"。
   `[实测]`（我用 AST 剥注释独立数过，与两路核查对上）：**产品代码 7 处、全仓 19 处**。
   ⚠️ 两条会让"直接加规则"变成假红灯的事实：
   - `packages/runtime` 那三处（`probe/runProbe.ts`、`detect/system.ts`、`selfTest.ts`）
     **架构上修不了** —— `pipeline` 依赖 `runtime`，反过来不行。规则必须带白名单。
   - `packages/downloader/scripts/verify-offline.mjs` 用的是
     **`await import('node:child_process')` 动态 import —— 任何静态 lint 规则都抓不到**。
     也就是说：**即使加了规则，它也守不住这一处**，而文档会因为"有规则了"再次高报。
2. **`BOARD.md` / `ROSTER.md` / `docs/adr/**` / `00-CHARTER.md` 我按 PROTOCOL §1 没有动**
   （那几份写着「仅 Manager 写」）。**可直接抄的补丁文本共 7 段，见本文件末尾 §附录 A。**
   已核实的问题摘要：
   - `BOARD.md` 的必读 ADR 只列 001–004（实有 **16 份**），其中 **ADR-003 决策 2 已被 ADR-015 收窄**、
     **ADR-004 的"可导入任意 HF GGUF"已被 `rest/models.ts:728-733` 硬 501 推翻**。
     照这张清单读 ADR 的人会读到一条被推翻的决策，并错过全部范围裁剪。
   - `BOARD.md` 仓库布局仍写 `127.0.0.1 ONLY`，而用户已决定绑 `0.0.0.0`。
   - `ROSTER.md` 列 4 个 agent 且全标"进行中"，而 `inbox/` 有 **32 份**报告；
     同时 `BOARD.md` 的 Wave 1 表把同一批 T-001…T-004 标为"全部完成" —— **两份互相矛盾**。
     ⚠️ 顺带更正一处**我这边的错**：核查判决表把它写成 `ROSTER.md:66-69`，
     **实际该文件只有 17 行**，花名册在 `:8-11`。内容判定成立，行号是错的。
   - `00-CHARTER.md` §3 的 7 行平台矩阵里 **5 行在产物层面为空**（Metal/CoreML/Vulkan/
     DirectML/ROCm/Linux-CUDA 均无预编译包），而 ADR-016 已停"AMD ASR 自建 CI" ——
     **补产物这条路已被砍，剩下的只能是改口径。**

   **另建议定一条规矩**：ADR 被推翻时**必须**在被推翻的那份上留反向标记
   （现有至少 4 处只做了单向）—— 否则必读清单会持续把人指错。
   我这次给 D-07/D-08 补的双向链接就是这条规矩的样子。
3. **D1 媒体扩展名白名单**（§2.3）跨三家地界，需要一次 SHARED-CHANGE 把它收到 `packages/shared`。
   ⚠️ 同时 E5 仍然成立：**扩展名判定改成"什么都放行"，pipeline 187/187 全绿。**
   所以收敛的同时必须补一条"拒绝"侧的断言，否则统一完还是钉不住。
4. **`packages/runtime` 的两个真分歧**（§2.4：`killSignal` 缺失、`LD_LIBRARY_PATH` 被覆盖）——
   建议当 bug 派给 `gpu-runtime`，不要当卫生问题。第一条与 ADR-014 冷启动死锁同族。
5. **`wavesurfer.js` 下不下掉**（§5）。我的建议是下掉，但决定权在 `frontend-truth`，
   且要与 `daemon-contract` 的真 peaks 立项一起看。
6. **死导出检测器什么时候装成守卫**（§4.1）。脚本在 `/tmp/debt-cleanup/dead-exports.mjs`，
   现在装会挡住四个在途 agent。

---

# §建议写进 HANDOFF

**⑤ 假绿灯家族新增一例（与 ⑤G 同族）：源码里的字面控制字节让 grep 与 git 静默跳过整个文件。**

判据不是"要记得加 `--binary-files=text`"，是「**任何让工具静默忽略源码的东西，
都要当 bug 修，不是风格问题**」。守卫已上线（`packages/pipeline/src/subprocess/__tests__/
sourceIsGreppable.test.ts`），**上线当天就抓到第四例**。

配套的一条：**"零命中"这个证据的可信度，取决于扫描器有没有看见那个文件。**
本项目的债务盘点大量以 `grep -rn … → 0 命中` 为据 ——
对 `argGuard.ts` 与 `subprocess/proxy.ts` 的每一条这样的结论，**在本提交之前都是无效的**。

---

# §反向验证（每条护栏都撤掉确认过真红，贴真实输出）

**① 时间码：把第二份实现放回去**
```
✖ 剥掉注释后，全包恰好一个定义，且在 timecode.ts
  AssertionError: formatTimestamp 的实现份数不对（应恰好 1 份、在 timecode.ts）。
  实际：["serialize/markdown.ts","timecode.ts"]
✖ markmap 渲染与 Markdown 导出对同一个 ref 给出同一个时间码
✖ includeTimestamps 附加 [mm:ss] / [h:mm:ss]
ℹ pass 48  ℹ fail 3
```

**② 时间码：floor 改成 round（只有一份实现，但语义被改坏）**
```
✖ 90500ms → 1:30（floor，不是 round 出来的 1:31）
  AssertionError: actual: '1:31'   expected: '1:30'
✖ 3599999ms → 59:59（round 会进位成 1:00:00）
  AssertionError: actual: '1:00:00'  expected: '59:59'
ℹ pass 48  ℹ fail 3
```

**③ 纯文本守卫：把字面控制字节放回 argGuard.ts**
```
✖ ★ 全仓源码零个字面控制字节
    packages/pipeline/src/subprocess/argGuard.ts:89 含字面控制字节 0x00
ℹ pass 184  ℹ fail 1
```
`file` 同时确认：`packages/pipeline/src/subprocess/argGuard.ts: data`（改回后 `JavaScript source, UTF-8 text`）。

**④ 纯文本守卫的"判据自检"**：`FORBIDDEN` 被放宽时那条会红；
样本用 `String.fromCharCode(0)` **程序构造**，不在文件里写字面字节 ——
第一版就是没做这件事，守卫**把自己判红了**（三个 offender 里有一个是它自己）。
这条本身就是"断言前先剥注释"的同族教训。

还原后全绿：`mindmap 51/51`（原 42，+9）· `pipeline 187/187`（原 182，+5）· `daemon 302/302`。

---

# §附录 A —— 交给 Manager 的补丁文本（我没权限改那几份，逐段可直接抄）

> 依据 PROTOCOL §1：`BOARD.md` / `ROSTER.md` / `docs/adr/**` / `00-CHARTER.md` 仅 Manager 写。
> 下面每段都已核实（`[实测]`/`[读码]`），且都按本项目规矩保留了"此前写着什么"。

## A-1 `coordination/BOARD.md` 必读决策清单（只列到 ADR-004，且其中两条已被推翻）

在 `## 已生效的决策（所有 agent 必读）` 下整块替换为：

```markdown
> ⚠️ 此前本清单只列到 ADR-004。实测 `docs/adr/` 现有 **16 份**，且其中两条已被后续 ADR 收窄。
- `ADR-001` 依赖引入三分法 · `ADR-002` 许可证政策 **v2 = 个人自用档**
- `ADR-003` 进程模型 = 本地 daemon + 浏览器 UI、GPU 后端策略、ad-hoc 签名
  —— ⚠️ **决策 2（自建 whisper.cpp CI）适用范围已被 ADR-015 收窄为「仅 macOS/Vulkan/ROCm 按需」**
- `ADR-004` 模型管理：镜像运行时探测、schema 补量化与显存字段、SSE 单流
  —— ⚠️ **其中「可导入任意 HF GGUF」已被 `apps/daemon/src/http/rest/models.ts:728-733` 的硬 501 推翻**
- `ADR-005` 工作区约定 · `ADR-006` 架构决策 · `ADR-007` 前端决策 · `ADR-008` 流水线决策
- `ADR-009` daemon 与 DB · `ADR-010` 共享契约与下载器 · `ADR-011` F3 中文与 TD-002 重开
- `ADR-012` 模型 UI 与基准溯源 · `ADR-013` Paraformer 反转 · `ADR-014` 冷启动 probe 死锁
- `ADR-015` **上游预编译优先**（撤销 PENDING 的 A-1；收窄 ADR-003 决策 2）
- `ADR-016` **用户范围裁剪**（停 SenseVoice / sherpa 多模型族 / AMD ASR 自建 CI）
```

## A-2 `coordination/BOARD.md` 仓库布局里的 `127.0.0.1 ONLY`

```
apps/daemon/      Node.js + TS 本地服务（默认 0.0.0.0，可用 OPENMEMO_HOST 收回回环）
```
布局块下补一句：
> 📝 **此前写着「127.0.0.1 ONLY」**。已被用户 2026-08 的决定推翻，
> 见 `docs/SECURITY.md` §0 与 `apps/daemon/src/bootstrap/single-instance.ts` 的 `BIND_HOST`。

## A-3 `coordination/BOARD.md` Wave 2 / Wave 3 状态（停在 2026-08-02）

两个标题各加一行，**表体保留**：

```markdown
## Wave 2 — 架构与骨架 ~~（进行中，4 并发跑满）~~ → ✅ **早已完成（本表停在 2026-08-02）**
> 📝 **此前 T-010…T-013 全标 🔵 进行中。** 实测四项交付物均已存在，项目已跑到 **T-152**，
> `coordination/inbox/` 有 32 份报告。**本表仅供追溯。**

## Wave 3 — 开发 ~~（待启动）~~ → ✅ **全部已交付（本表停在 2026-08-02）**
> 📝 **此前 T-020…T-024 全标 ⚪ 待启动。** 实测 `apps/web/src/features/` 15 个 feature、
> `packages/mindmap/`、`.github/workflows/` 4 个 workflow 均已就位。**本表仅供追溯。**
```

## A-4 `coordination/ROSTER.md`（全文 17 行，花名册在 `:8-11`）

在表头前插入：

```markdown
> ⚠️ **本表停在项目第 1 个提交（2026-08-02），已严重过期，仅供追溯。**
> - 此前 4 行全标「🔵 T-00x 进行中」，而 **`BOARD.md` 的 Wave 1 表把同一批 T-001…T-004
>   标为 🟢 全部完成** —— 两份 coordination 文档互相矛盾。
> - 实际参与的 agent 远不止 4 个：`coordination/inbox/` 有 **32 份**报告，
>   含写了主要设计文档的 `architect`、`ci-runner`、`platform`、`memo-compare` 等，均未登记在册。
> - **处置建议**：重建或删除。若保留，请至少把 4 行状态改成 🟢，并指向 `coordination/inbox/`。
```

## A-5 `docs/00-CHARTER.md` §3 平台矩阵下方

```markdown
> ⚠️ **产物现状（2026-08-06 实测 `vendor/manifests/backends.json`，11 个 pack）**：
> 上表有 **5 行在产物层面为空** —— Metal / CoreML / Vulkan / DirectML / ROCm / Linux-CUDA
> **均无预编译包**。
>
> | 章程行 | 承诺的后端 | 实际产物 |
> |---|---|---|
> | macOS (Apple Silicon) | Metal / CoreML | ❌ 只有 `whispercpp-cpu-macos-arm64`（CPU） |
> | macOS (Intel) | CPU (AVX2) | ❌ 已被用户 2026-08-05 指示裁掉 |
> | Windows + AMD | Vulkan / DirectML | ❌ 无任何产物 |
> | Linux + NVIDIA | CUDA | ❌ 唯一 CUDA 条目是 `whispercpp-cuda-12.4-win-x64` |
> | Linux + AMD | ROCm / Vulkan | ❌ 无产物，`linux-x64-rocm` 已被用户裁掉 |
>
> **已交付的只有**：macOS-arm64 CPU、Linux x64 CPU、Win x64 CPU、Win x64 CUDA 12.4。
> `D-11:17` 已就此发过警告。而 **ADR-016 已停「AMD ASR 自建 CI」→ 补产物这条路已被砍，
> 剩下的只能是改口径**：这几行要么标注「规划中，v1 无产物」，要么下调。
> **不能继续对外宣称「真 AMD 支持」。**
```

## A-6 `docs/adr/ADR-004-model-management.md`「可导入任意 HF GGUF」之后

```markdown
> ⚠️ **2026-08-06 订正：本句已不成立。** `apps/daemon/src/http/rest/models.ts:728-733` 对
> `kind === 'hf_repo'` **硬返回 501**。当前实际能力是「从固定 manifest 目录里选」，不是「任意 HF」。
> 要么补上「用户手工提供 SHA-256」的导入路径，要么把这句从对外话术里撤掉。
```

## A-7 `docs/adr/ADR-003-runtime-and-process-model.md` 决策 2

frontmatter 加 `superseded-in-part: ADR-015`，决策 2 正文后加：

```markdown
> ⚠️ **适用范围已被 `ADR-015-upstream-first.md:7,47-51` 收窄**：manifest 一律填上游地址，
> 自建 whisper.cpp CI 仅在用户实际需要 macOS / Vulkan / ROCm 时才启用。
> **此前本决策要求无条件自建。**
```
