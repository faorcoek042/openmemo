# 完成度审计 —— 逐条、分档、带证据

## [2026-08-08 23:40] completion-audit DONE（只读，未改任何产品代码）

**判据分层**（Manager 2026-08-08 定，本文严格执行）：

| 档                | 含义                                                                     |
| ----------------- | ------------------------------------------------------------------------ |
| **`[用户可达]`**  | 一个刚下载解压的人，从零开始，**真的能用到**。最高档                     |
| **`[CI 实测]`**   | CI 验过，但跑在**预置组件 / 直连 HTTP / 不点界面**的条件下               |
| **`[代码在]`**    | 实现存在、有测试，无端到端证据                                           |
| **`[未验证]` / `UNKNOWN`** | 如实标，并说清缺什么才能验                                      |

> ⚠️ **本次审计建立在一个刚被证伪的前提之上**：三天前报「四条 e2e 腿三平台全绿、
> `v0.3.0` 可发」，**然后用户真机一试：探针不在包里、空数据目录装不了组件、点按钮没反应**。
> 所以**「CI 绿」这次不算顶格**。

---

## 一、主表

| 条目 | 档位 | 证据 | 用户要先跨几道坎 | 已知失效条件 |
| --- | --- | --- | --- | --- |
| **F1** 链接导入（YouTube/B 站/播客/直链）| **`[CI 实测]`** | `e2e-import` run **31258300507 success**（2026-08-08 12:54Z） | **4 道**：启动器能跑起来 → 装 media-tools + ytdlp → 装 ASR 模型 → 才谈得上粘 URL | 需联网；会员/登录内容按 ADR 已裁；yt-dlp 版本随上游 |
| **F2** 本地媒体导入 | **`[CI 实测]`** | 同上（`e2e-import` 覆盖本地文件路径） | **3 道**：启动 → 装 ffmpeg → 装 ASR 模型 | 缺 ffmpeg 时任务转 `blocked` |
| **F3** 录音转文字 | **`[CI 实测]`** | `e2e-record` run **31258974214 success** | **3 道**：启动 → 装组件/模型 → 浏览器授权麦克风 | ⚠️ **流式字幕在 macOS < 15.5 上静默不可用**（sherpa minos 15.5，本轮已做成自检 warn）；浏览器需 HTTPS 或 localhost 才给麦克风 |
| **F4** 思维导图（LLM 结构化）| **`[CI 实测]`**（mock）+ `[未验证]`（真 Key） | `e2e-notes` run **31258972781 success**；`HANDOFF` ⑥ 自陈「Anthropic/Gemini 适配器只跑过本地 mock，没有真 Key」 | **4 道**：启动 → 有转写稿 → **去设置页填一个在线 LLM 的 API Key** → 生成 | **没填 Key 就完全用不了**（ADR-016 只留在线，这是用户的决定不是缺陷）；真实厂商端点是否接受我们的请求形状 `[未验证]` |
| **F5** 笔记管理（列表/详情/搜索/标签）| **`[CI 实测]`** | `e2e-notes` run **31258972781 success** | **2 道**：启动 → 有笔记 | ⚠️ **语义/混合检索在 macOS < 14.0 上静默不可用**（vec0 minos 14.0，本轮已做成自检 warn）；关键词全文检索不受影响 |
| **要求 2.1** GPU 组件全程网页安装配置 | **`[CI 实测]`**，**`[用户可达]` 待确认** | `e2e-runtime` run **31258975830 success**；装/重启生效/卸载/换后端/切换 + 断路器自愈全绿 | **1–2 道**：启动器能跑 → 打开本机组件页。**但这正是用户卡住的那一道** | ⚠️ **Windows 空数据目录下装组件当前失败**（见下 §三）；真 GPU 上能否切过去 = **结构上验不了** |
| **要求 2.2** 模型浏览/下载/切换/删除/量化 | **`[CI 实测]`** | 同上 run 31258975830：浏览→下载→断点续传→sha256 失败处理→切换→删除（`freedBytes` 实测为真）→磁盘统计 | **2 道**：启动 → 组件装得上（模型下载与组件走同一条下载器） | 需联网；镜像不可达时下载失败 |

### 档位分布

- **`[用户可达]`：0 条**（严格按定义——见 §三，第一道坎今天仍有一格是红的）
- **`[CI 实测]`：7 条**（F1–F5 + 2.1 + 2.2）
- **`[代码在]`：0 条**（都有 CI 覆盖）
- 另有**逐条的 `[未验证]` 子项**（真 Key、真 GPU、真浏览器），见各行"失效条件"

> **一条 `[用户可达]` 都没有，不是说功能不存在** —— 而是按 Manager 定的口径：
> **「功能已实现但用户到不了」不许算完成**，而今天到达它们的**第一道坎上仍有红**。

---

## 二、结构上验不了（沿用 `HANDOFF.md` ⑥ 的分节，**验不了 ≠ 没做**）

| 条目 | 为什么托管 runner 答不了 |
| --- | --- |
| Windows + NVIDIA CUDA 真的跑起来加速 | GitHub 托管 runner **没有 N 卡**。`[CI 实测]` 加速包**能装上**、`select` 如实回 409「installed but enumerated no devices」——**"装"验到了，"装完真加速"没有** |
| 三平台真 GPU 上的加速效果 | 同上；`e2e-runtime` 的 `A-ACCEL-SWITCH` 在三平台**刻意是 UNKNOWN 不是绿**，绿会是假的 |
| macOS 13.3 真机上的分层降级文案 | 托管 runner 给不了 13.3 的 macOS。判定逻辑已做成纯函数并在 Linux 上以 11 条测试验掉，真机那格 `[未验证:需真 Mac]` |
| Windows 各 DLL 要求的 VC++ 版本 | **今天没有任何东西在量它**（`build-bundles.yml` 自陈「Windows 上没有 ELF/Mach-O 守卫可跑」）→ `UNKNOWN` |

---

## 三、今天一个新用户会卡在哪（按他实际遇到的顺序）

### 第 1 道：解压 → 双击启动

- **Linux / macOS**：`[CI 实测]` `bundle-launch-sim` run **31248222725 success**。
- ⚠️ **但那次 run 是 2026-08-08 08:21Z，而"探针随包出厂"的修复是同日 22:02 CST 才提交（`5413369`）**
  —— **启动器这条腿在修复之后没有再跑过**。修复走的正是启动器设的
  `OPENMEMO_BUNDLED_PROBE_DIR`（`build-bundle.mjs:872/933`），
  所以**"修好了"这件事今天还没有被启动器路径验证过**。`[未验证]`

### 第 2 道：本机组件页 → 装第一个组件（**用户就是卡在这里**）

- **Linux / macOS**：`[CI 实测]` `e2e-coldstart` run **31261593715** 两格 success。
- ⛔ **Windows：同一 run 里 `冷启动（win32-x64）` failure，而且是产品侧的**：

  ```
  Error: ENOENT: no such file or directory, rename
    'C:\...\data\models\blobs\sha256-3942....partial.json'
  ✘ /api/jobs/…: connect ECONNREFUSED 127.0.0.1:19810（重试 4 次后仍失败）
  ```

  下载器在 Windows 上重命名 `.partial.json` 失败 → **daemon 直接死了**（随后连接被拒）。
  也就是说**Windows 用户从空数据目录装第一个组件，今天仍会失败**。
  🔧 **修复进行中**（`e2e-coldstart` 那一路正在这条腿上），**我未改任何代码**。

### 第 3 道：点界面上的按钮

- ⛔ **`e2e-browser` run 31262130079 failure，原因是 `✘ 找不到 playwright`** ——
  **这条腿至今一次都没有真的驱动过浏览器**。
- 也就是说用户报的第三个症状（**点"安装模型"、点"测速"没反应**）：
  代码侧已修一处（`c02448a`：「去安装模型」navigate 到了用户已经在的那一页），
  但**"点了有反应"这件事今天没有任何 CI 证据** → 该类只能算 **`[代码在]`**。
  🔧 **修复进行中**（真浏览器那一路）。

### 结论

**用户今天从零开始，最快在第 2 道（Windows）或第 3 道（点按钮，全平台无证据）卡住。**
第 1 道的"已修"目前**缺一次启动器路径的复验**。

---

## 四、★ 第四类「CI 结构上看不见」的东西（本轮审计的新发现）

Manager 问有没有第四类。**有，而且它正是这次三个真机故障的共同成因：**

> **CI 直接 spawn `app/daemon/dist/main.js`，而用户双击的是启动器脚本。
> 凡是"只有启动器做的事"，CI 结构上看不见。**

启动器（`start.sh` / `start.cmd` / `OpenMemo.command`）做了、而直连 daemon 的腿不会做的事，
`[实测 build-bundle.mjs:866-874 / 928-935]` 至少有：

- `OPENMEMO_BUNDLED_PROBE_DIR` ← **探针找不到那个故障就落在这里**
- `OPENMEMO_WEB_DIST`（界面从哪来）
- `OPENMEMO_EXT_DIR`（SQLite 扩展）
- 工作目录 `cd "$DIR/app/daemon"`、以及 macOS 的 quarantine 处置

**证据**：`grep -rl OPENMEMO_BUNDLED_PROBE_DIR scripts/ .github/workflows/` 今天只命中
`build-bundle.mjs`、`e2e-coldstart.mjs`、`diagnose-probe-bootstrap.mjs` ——
**`e2e-runtime` / `e2e-import` / `e2e-record` / `e2e-notes` 四条腿都没有设它**。

⚠️ **我自己那条腿（`e2e-runtime`）就是其中之一** —— 它自己拼 env 直接起 daemon，
所以它的"三平台全绿"**结构上覆盖不到启动器那一段**。这是我的腿的已知盲区，如实记下。

**建议判据**（不替 Manager 裁）：**至少一条腿必须"像用户那样"启动**
（跑启动器脚本，而不是自己拼 env）；`bundle-launch-sim` 是现成的那条，
但它**必须在每次动 `build-bundle.mjs` 之后重跑** —— 这次就是没重跑。

---

## 五、我没有重做的测量（沿用别人的，并注明出处）

按 Manager 要求先读后量，以下**直接采信他人回执 + 我核对了 run 号与结论**，未重跑：
`e2e-import` 31258300507、`e2e-record` 31258974214、`e2e-notes` 31258972781、
`bundle-launch-sim` 31248222725、`cold-start-audit` 31261016340、`build-bundles` 31261477234。

我**自己核实**的：上述所有 run 的 `conclusion`（`gh run list/view`）、
两条红腿的**失败原文**（逐条抓日志）、启动器 env 的 grep 覆盖面、
`e2e-runtime` 31258975830 的 success（那是我自己的腿）。

---

## 六、诚实标记

- `[未验证]`：探针修复在**启动器路径**上的效果（`bundle-launch-sim` 修复后未重跑）；
  真 LLM Key 的端到端；真浏览器点击。
- `[报告]`：Windows `.partial.json` 那条我只读了 CI 日志原文，**未在 Windows 上复现**
  （无 Windows 机器），也未读修复方那一路的进展。
- `UNKNOWN`：Windows 各 DLL 的 VC++ 版本要求 —— 今天没有任何测量。
- **未改任何产品代码**；没碰 `:10000`、`/root/data-memo`、机器级指针；未用 `pkill -f`；
  未建/改/删 release；未动三路在途 agent 的任何文件。

---

# 第二轮：对着 `v0.4.0` 重判（2026-08-09）

判据与上一轮**逐字相同**，没有放松 —— 尤其那句
「**实现了但用户到不了的，不许算完成**」。

⚠️ **Manager 转述的那批"现状"我一条都没有直接采信**，下面每条都注明我自己核到的位置。

## 一、先核前提：这一批字节到底被谁验过

`[实测]` 发布闸门认的是 **`import,notes,record,runtime` 四条腿**
（`scripts/ci/verify-e2e-attestation.mjs:62` 的 `--legs` 缺省值），
**`browser` 不在其中**。四条腿各自对 **`31268366005`（= `v0.4.0` 那批字节）** 的凭证：

| 腿          | run          | 含该批凭证 |
| ----------- | ------------ | ---------- |
| e2e-runtime | 31273755455  | ✅ 1 个     |
| e2e-import  | 31272182590  | ✅ 1 个     |
| e2e-record  | 31272184838  | ✅ 1 个     |
| e2e-notes   | 31272187115  | ✅ 1 个     |

（我是逐个 run 去列 artifact、按名字里含 `31268366005` 筛出来的，不是读回执。）

## 二、上一轮那三道坎，我自己核的结果

| 坎                        | 我核到的证据                                                                                                                     | 判定       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| ① 启动器没被执行过        | `grep -rln launcher-spawn scripts/ci/*.mjs` → **runtime / import / record / notes / coldstart 五条都在用**                        | **已拆**   |
| ② 空目录装不了组件        | `build-bundle.mjs:955` 把 `vendor/manifests` 拷进 STAGE；我自己数清单：`backends 14 + sqlite-ext 11 = **25**`，非 llm 分组 = **16** | **已拆**   |
| ③ 点按钮没有 CI 证据      | `e2e-browser-audit.mjs` **11 条 `await check(`**；`KNOWN_DEAD` 数组**是空的**（注释记着最后一条被修好后清单被迫更新）             | **已拆**   |

⚠️ 关于 ②：那三个数（25 / 16）是我从 `vendor/manifests` 自己算的，
与"包里实际有多少"是两件事 —— 后者我没有解包核 `[未验证]`，
但四条腿的凭证是对那批字节发的，间接支持它。

## 三、主表（第二轮）

| 条目 | 上轮 | **本轮** | 今天的证据 | 用户要跨几道坎 | 失效条件 |
| --- | --- | --- | --- | --- | --- |
| **F1** 链接导入 | `[CI 实测]` | **`[用户可达]`** | `e2e-import` 对 v0.4.0 字节发了凭证，且该腿**从真实启动器起 daemon** | **0 道**（组件在页面上装得上了） | 需联网；会员内容已裁 |
| **F2** 本地媒体导入 | `[CI 实测]` | **`[用户可达]`** | 同上（同一条腿覆盖本地文件路径 `[报告]`，我没逐断言核） | 0 道 | 缺 ffmpeg 时转 blocked |
| **F3** 录音转文字 | `[CI 实测]` | **`[用户可达]`** | `e2e-record` 对 v0.4.0 字节发了凭证 + 走启动器 | 0 道，但要**浏览器授权麦克风** | ⚠️ 流式字幕 **macOS < 15.5 静默不可用**（已做成自检 warn） |
| **F4** 思维导图 | `[CI 实测]`+`[未验证]` | **`[CI 实测]`**（未升档） | `e2e-notes` 有凭证；但**真厂商 Key 的往返仍无证据** | **1 道**：去设置页填一个在线 LLM 的 Key | **没 Key 就完全不能用**（ADR-016 的决定，非缺陷） |
| **F5** 笔记管理 | `[CI 实测]` | **`[用户可达]`** | `e2e-notes` 有凭证；本轮另接上文件夹改名 / 笔记移动 / 删除可撤销 | 0 道 | ⚠️ 语义检索 **macOS < 14.0 静默不可用** |
| **要求 2.1** | `[CI 实测]` | **`[用户可达]`** | `e2e-runtime` 31273755455 对 v0.4.0 字节全绿并发凭证；`[实测]` 探针不再报 `probe did not complete` | 0 道 | 真 GPU 加速 = 结构上验不了 |
| **要求 2.2** | `[CI 实测]` | **`[用户可达]`** | 同上（浏览/下载/续传/校验失败/切换/删除/统计） | 0 道 | 需联网 |

### 档位分布与移动

| 档 | 上一轮 | **本轮** |
| --- | --- | --- |
| `[用户可达]` | **0** | **6** |
| `[CI 实测]` | 7 | 1（F4，卡在"要用户自己的 Key"） |
| `[代码在]` | 0 | 0 |

**移动了 6 条**，全部由「三道坎被拆 + 四条腿对同一批字节发凭证」带来。

## 四、结构上验不了（沿用 `HANDOFF` ⑥ 那节，**验不了 ≠ 没做**）

未变，仍是四条：Windows+NVIDIA 真加速、三平台真 GPU 加速、macOS 13.3 真机分档文案、
Windows 各 DLL 的 VC++ 版本（`UNKNOWN`，今天仍无任何测量）。

## 五、一个新用户「从下载到第一次转出文字」要几步

按今天的证据推，**5 步，其中只有第 3 步会因外部原因失败**：

1. **下载解压** —— 三平台产物齐（`build-bundles 31268366005`）。
2. **双击启动器** —— `start.sh` / `start.cmd` / `OpenMemo.command`；四条腿现在都从它起 daemon。
3. **本机组件页装组件**（ffmpeg / ffprobe，以及要转写就还要一个 ASR 模型）
   —— ⚠️ **唯一会失败的一步**：要联网、要镜像可达。
4. **导入一个音视频**（粘 URL 或拖文件）。
5. **等转写出文字。**

⚠️ **"0 道坎"指的是不再有产品自身的死路**，不是"不会失败"：第 3 步依赖网络。
另外 `whisper-cli` 已随包出厂，所以**可失败环节从 3 个降到 2 个** `[报告]` ——
这条我没自己数，是 Manager 转述的。

## 六、★ 第五类「CI 结构上看不见」—— **有，而且就在本轮的成绩单里**

> **唯一证明"界面能点"的那条腿，跑的不是发出去的那批字节，而且不在发布闸门里。**

`[实测]` 两条都核过：

- **不在闸门里**：`verify-e2e-attestation.mjs:62` 的 legs 缺省是
  `import,notes,record,runtime` —— **没有 browser**；
  我去列 `e2e-browser` 最近一次 run（31262503013）的 artifact，**一个凭证都没有**。
- **跑的不是那批字节**：`e2e-browser.yml:39` 的包来源缺省是
  「**留空 = 用本次 checkout 现场组装**」，而它最后一次跑是 `14:39Z`，
  **早于 `build-bundles` 的 `17:00Z`** —— 也就是说它连时间上都不可能碰过 v0.4.0 的产物。

**后果**：这一轮"40 个按钮全扫、0 个死按钮"证明的是**当时那棵源码树**的界面，
**不是用户下载的那个包的界面**。而四条闸门腿全部走 HTTP，**没有一条点过界面**。
于是「**用户下载的那个包，界面能不能点**」今天**没有任何证据**。

与前四类同源、但换了一个面：

| 类 | 问的是                                   |
| -- | ---------------------------------------- |
| 四 | 我测的是不是**用户启动的方式**？         |
| **五** | 我测的是不是**用户下载的那份字节**？ |

**建议判据**（不替 Manager 裁）：要么把 `browser` 加进闸门的 legs 并让它默认吃 artifact，
要么明确写下"界面层不在发布闸门内"——**但不许两者都不做**，
否则下次界面在包里坏掉，闸门仍然会放行。

### 另外两处同族（较轻，一并记）

- `bundle-launch-sim` 最后一次跑是 **08:21Z**，早于 v0.4.0 —— 启动器**模拟用户双击**那条腿是陈的 `[实测]`。
- `e2e-browser` 的横扫**刻意跳过破坏性/重量级按钮**（脚本里 `跳过的破坏性/重量级按钮（N 个，明确记在案，不算通过）`）
  —— 那批按钮至今没被点过，**脚本自己如实说了"不算通过"**，这点是对的。

## 七、诚实标记

- `[实测]`：闸门 legs 缺省值、四条腿的凭证、五条腿用 launcher-spawn、
  `build-bundle.mjs:955`、清单 25/16、`KNOWN_DEAD` 为空、11 条 check、
  browser 无凭证且默认 checkout 组装、各 run 时间戳。
- `[报告]`（Manager 或他人回执转述，我未独立核）：F2 在 import 腿里的具体断言；
  "可失败环节 3 → 2"；`writeSidecar` 并发 600→400 的数字。
- `[未验证]`：解包后的真包里 `packs` 到底是不是 25（我只核了清单源）；
  真厂商 Key 的 F4 往返；破坏性按钮的行为。
- `UNKNOWN`：Windows 各 DLL 的 VC++ 版本要求。
- **只读审计，未改任何产品代码**；未碰 `:10000` / `/root/data-memo` / 机器级指针；
  未用 `pkill`；未建改删 release；未动文档那一路在改的 `README` / `docs/**` / `HANDOFF.md`。

---

# 硬件卡两条假话：定位报告（2026-08-09）

⚠️ **本条只交定位与证据，修复未实施** —— 见末尾"我没做什么"。

## ① 「不支持 AVX2」——**根因不是探测读错了，是 Windows 上压根没有探测**

`[实测·读码]` `packages/runtime/src/detect/system.ts:190-205` 的 `detectCpuWin32()`
**没有任何分支**，最后一行是无条件的：

```ts
return { brand, physicalCores, logicalCores, features: [] };
```

它只用 PowerShell 查了**物理核数**，**从不查任何 ISA 标志**。
所以 Windows 上 `cpu.features` **恒为空集** —— 与是不是 Zen 4 无关，
与 CPU 支不支持 AVX2 无关。**用户那台 7840HS 的输出就是复现本身**：
一台确实支持 AVX2（且支持 AVX-512）的机器被报成"不支持"。

### 它本来有个缓解措施，而那个措施**从来没接上**

同一段注释写着：「我们改从 **ggml 实际选中的 CPU 后端**反推 ISA ——
见 `inferIsaFromBackendPath`」。

`[实测]` 全仓 grep `inferIsaFromBackendPath`（排除定义处与 `dist/`）：
**只有 `packages/runtime/src/index.ts:80` 的一句再导出，零个真实调用方。**

⇒ 那个"更好的证据"**一次都没有被使用过**。于是空集不是"探测前的临时状态"，
而是**Windows 上的永久状态**。这正是本仓反复栽的那个形状：
**注释描述的是设计意图，不是代码事实。**

## ② 这个错**有没有影响变体选择** —— 你最关心的那条：**没有，但影响的是别的东西，而且更糟**

**变体选择（3.4 倍那条）不受影响** `[实测·读码]`：
`ADR-003 附录 A.2` 说的 CPU 微架构变体（`libggml-cpu-zen4` / `haswell` / …）
是 **ggml 自己在加载时挑的**（后端包里并排放着多个 `libggml-cpu-*`），
**我们的代码里没有任何一处按 `cpu.features` 去挑变体** ——
`ISA_BY_VARIANT` 只被那个零调用方的 `inferIsaFromBackendPath` 用。
所以用户**不会**白白损失 3.4 倍。

**但它影响了模型可用性判定，那是用户可见的功能缺陷** `[实测]`：

`packages/shared/src/fitness.ts:319-331` 规则 2：

```ts
const missing = input.requirements.cpuFeatures.filter(
  (f) => !hw.cpu.features.includes(f.toLowerCase()),
);
if (missing.length > 0) return { tier: 'unsupported', reasonZh: `CPU 不支持所需指令集（…）` };
```

我数了清单：**35 个模型里有 5 个声明 `requirements.cpuFeatures: ['avx2']`**。

⇒ **在每一台 Windows 机器上，这 5 个模型都会被判成 `unsupported`**，
理由写着「CPU 不支持所需指令集（avx2）」—— 包括那台 Zen 4。
**用户看到的是"我的 CPU 不行"，而事实是"我们没去查"。**

⚠️ 这比显示文案严重：它**挡掉了模型**，不只是说错一句话。

## ③ 显示层：同一个坑，上一次只填了一半

`apps/web/.../HardwareCard.tsx:84`：

```tsx
{hw.os.arch === 'x64' && !hw.cpu.features.includes('avx2') ? <告警> : null}
```

上一轮已经为 arm64 修过一次（M 系列 Mac 上"不支持 AVX2"是**不适用**维度），
注释里写着判据：**「不适用」和「不支持」必须区分得开**。

**但它只分了两态。** 这里需要的是**三态**：

| 状态       | 今天                     | 应该                         |
| ---------- | ------------------------ | ---------------------------- |
| 不适用（arm64） | 不渲染 ✅               | 不渲染                       |
| **未知**（win32，没查） | **渲染成"不支持"** ❌ | 「未检测」或不渲染           |
| 确实不支持（x64 老 CPU） | 渲染 ✅               | 渲染告警                     |

**`空集` 被当成了 `已知不支持`** —— 与 ① 是同一个根因的两个出口。

## ④ GPU 那一栏：技术上成立，但和下一行自相矛盾

用户看到的两句话并排：

```
显卡：未检测到可用 GPU
后端：CUDA/Vulkan/ROCm/Metal/CoreML 不可用（backend package not installed）
```

第一句成立（Vulkan 包没装 ⇒ 探针枚举不到设备），但**用户只会记住第一句**，
而他的 780M 明明在那儿。判据仍是那条已经用过的：
**「不适用」「未安装」「真的没有」必须区分得开。**

**建议文案（未实施）**：加速后端包一个都没装时，那一栏不说"未检测到可用 GPU"，
改说「**尚未安装 GPU 后端包，无法检测**」+ 一个「去安装」入口
（`remediation` 机制现成，`action: 'install_backend'` 已经在用）。
`UNKNOWN`：GPU 那一栏的具体渲染位置我**没有定位到**（`HardwareCard.tsx` 里
grep `未检测到可用 GPU` / `gpus.length` 均无命中），文案可能来自 i18n 键或另一组件。

## ⑤ 我没做什么（诚实边界）

- **两条都没有修** —— 本轮只做到定位。理由：修 ① 要在 Windows 上真的做特性探测
  （或把 `inferIsaFromBackendPath` 接上），涉及 `detect/system.ts` + `fitness.ts` +
  `HardwareCard.tsx` 三处与配套测试，我的余量不足以把它做完并跑完门禁 ——
  **做一半比不做更糟**（半个探测会产生另一种假话）。
- `[未验证]`：Windows 上 CPUID 实际会报出什么标志 —— **我没有 Windows 机器**，
  也没有在 Windows runner 上跑过一次特性枚举。但这一条不影响上面的结论：
  代码路径是**无条件返回空集**，没有"读到了但读错"的可能。
- `[报告]`：ADR-003 附录 A.2 的 3.4 倍差距我引用未复核。
- **只读**：未改任何产品代码；未碰 `:10000` / `/root/data-memo` / 机器级指针；
  未用 `pkill`；未建改删 release；未动文档、浏览器腿、downloader 三路在改的文件。

## ⑥ 给下一轮的最小可行修法（建议，不替 Manager 裁）

1. **`fitness.ts` 先止血**：`features` 为空 ⇒ 那是**未知**，不是**缺失**。
   规则 2 在空集时不该判 `unsupported`（否则 5 个模型在所有 Windows 上被挡掉）。
   这一条改动最小、收益最大，且不需要任何新的探测能力。
2. **把 `inferIsaFromBackendPath` 真的接上**（它已经写好了、零调用方），
   用探针 stderr 里 `load_backend: … libggml-cpu-zen4…` 反推 —— 那是 ggml 自己的结论。
3. **显示层改三态**；GPU 栏在"后端包一个都没装"时改说"无法检测"+去安装入口。

---

# 「允许借系统 ffmpeg，只是优先级低」—— 立场订正（2026-08-09）

提交 `444043d`。**改的是文字与呈现，行为一个字没动**（行为本来就对）。

## ① 今天到底借不借 —— **借。实测。**

`[实测 2026-08-09，linux-x64]` 全新空数据目录 + **不屏蔽** PATH，系统装着
`/usr/bin/ffmpeg`、`/usr/bin/ffprobe`，起 daemon 问 `GET /api/selfcheck`：

```
tool.ffmpeg     warn   "/usr/bin/ffmpeg（来自系统 PATH，非本产品安装 —— 用户机器上不一定有）"
tool.ffprobe    warn   "/usr/bin/ffprobe（来自系统 PATH，非本产品安装 —— 用户机器上不一定有）"
tool.whisperCli fail   "未找到"
tool.whisperVad warn   "未找到"
tool.ytDlp      warn   "未找到"
```

⇒ **产品用了它，没有报"缺 ffmpeg"。** 与用户的策略一致。

⚠️ `[未验证]`：**只在 linux 上真跑了**。win32 / darwin 我没跑
（解析走的是同一段与平台无关的 `fromPath()`，但按纪律**不推**，标未验证）。

## ② 借了之后界面说什么 —— **说了路径，但口气是"缺陷"，且没有版本**

上面那句就是用户会看到的原文。评价分两半：

**做对的**：**报了绝对路径**。这正是安全那一半要的 —— 用户看得见自己用的是哪一个。

**不对的**：

- **状态是 `warn`**，读起来像"有问题"，而按用户的策略这是**受支持的正常路径**；
- 措辞「**非本产品安装 —— 用户机器上不一定有**」是站在**打包者**视角说的
  （"这台机器上能用不代表别人能用"），不是站在**用户**视角
  （"正在用你系统里的这一个"）；
- **没有版本号**。用户现在正卡在"CPU 后端下不动"上 ——
  如果他系统里那个 ffmpeg 用得上，**他需要知道产品正在用它、以及是哪个版本**。

**我没有改这段文案** —— 它在 `packages/runtime/src/selfcheck.ts`，
而 AVX2 三态那一路此刻正在动 `packages/runtime/` 与 `HardwareCard.tsx`
（`git status` 实测：`fitness.ts`、`HardwareCard.tsx`、两份 locale 都在他手里）。
**撞上去会把他的在途工作卷进我的提交。** 建议由他或下一轮统一改，方向：

> `ok` 或一个中性档 + 「**正在用你系统里的 ffmpeg（<绝对路径>，版本 X）**；
> 产品自带的优先级更高，装上后会自动切过去」+ 一个「去安装自带版本」的入口。

## ③ 立场订正（§13，原文删除线保留）

`packages/pipeline/src/tools.ts`：

- 搜索顺序第 3 条 `PATH — ~~development convenience ONLY~~`
  → **受支持的兜底，只是刻意排在后面**；
- 文件头 `~~discoverTools exists for tests and local development only~~`
  → 它就是**生产路径**的解析器。

依据写的是用户 2026-08-09 的原话，注明何时、被谁、依据什么。

### ⚠️ 一处**误引**，顺带查出来了

原注释写着「**D-01 §8.4 L2 forbids PATH lookups for real invocations**」。

`[实测]` 我去查了 `docs/design/D-01-architecture.md` §8.4：
**第二层（L2）是「绝不经过 shell」**（`:1172`，正文是
`✅ spawn(absoluteBin, argv[], {shell:false})`），**通篇没有禁止 PATH 查找**。

⇒ **那条禁令是这段注释自己发明、并挂到文档名下的。文档没错，错的是引用。**
所以 **`D-01` 一个字未改** —— 按 §13 的判据，该改的是不实的那一方。

（这也是本仓反复出现的一个形状的新变种：以前是"文档过期、代码对"，
这次是**"代码凭空发明了一条文档从没写过的规则，还引了出处"** ——
比过期更难查，因为它看起来有据可依。）

## ④ 安全那一半：**一个字没松**

D-01 §8.4 真正防的是**注入**：PATH 里靠前的一个恶意 `ffmpeg` 会赢。缓解措施不变：

- **永远 spawn 解析后的绝对路径，绝不 spawn 裸命令名**（本仓既有做法，**未动**）；
- 借到的那一个**必须在自检里报出绝对路径**（今天已经做到，见 ①）。

**「允许借」≠「不设防」：允许的是使用，防的是冒名。** 这句写进了注释。

## ⑤ 扫出多少处把「CI 判据」写成「产品属性」—— **0 处**

全仓扫 `不会使用你系统 / 不使用系统 / 禁止走 PATH / 绝不借 / 不借用 /
development convenience / 开发方便`（`.ts` `.tsx` `.md`，排除 `dist/`）：

| 命中                                   | 判定                                          |
| -------------------------------------- | --------------------------------------------- |
| `packages/pipeline/src/tools.ts:812`   | **就是本轮要改的那条** —— 已订正              |
| `docs/design/D-08:334`、`apps/web/vite.config.ts:23,91` | 说的是**开发代理白名单**，与 PATH 借用无关 —— 不动 |

`docs/DEPLOYMENT.md:520` 那句「借宿主 PATH 的都是 **0**」：
**没有被写成产品属性**，它在"证明自给自足"的语境里，是 CI 实测值。
⚠️ 但那份文件**此刻在文档精简那一路手里**（`git status` 显示 `HANDOFF.md` /
`docs/SECURITY.md` / `D-19` 在动），我**没有动它**，也没有为它加注 ——
建议由他在精简时顺带确认那句的语境仍然清楚。

⇒ **没有发现任何一处把 CI 判据当成产品属性对外宣称。**

## ⑥ CI 判据不用改（与 Manager 同判）

四条腿的「屏蔽宿主 PATH 之后借用 0 个」**仍然成立、仍然有价值** ——
它证明的是「**产品有能力自给自足**」，不是「产品禁止借」。
我那条腿的输出里本来就把两者分开了：屏蔽下落在 shim 上的算
「**不屏蔽的话产品会去借的**」，只有**shim 与包之外**的路径才判红。

## ⑦ 诚实边界

- `[实测]`：linux 上的借用行为与自检原文、D-01 §8.4 L2 的真实内容、全仓措辞扫描。
- `[未验证]`：win32 / darwin 上的借用行为（同一段代码，但没跑）；借到的 ffmpeg 版本号
  （产品今天**根本没取版本**）。
- `UNKNOWN`：无。
- **未改行为、未改 D-01**；未碰 `:10000` / `/root/data-memo` / 机器级指针；
  未用 `pkill`；未建改删 release；未动另外四路在改的文件
  （`packages/runtime/**`、`packages/shared/src/fitness.ts`、`HardwareCard.tsx`、
  两份 locale、`HANDOFF.md`、`docs/SECURITY.md`、`D-19`、`packages/downloader/**`）。

---

## [2026-08-09 14:20] e2e-import 接手：Windows「CPU 不支持 avx2」 DONE（第 3 步未做，有依据）

交付: `packages/shared/src/fitness.ts`、`packages/runtime/src/detect/system.ts`、
`packages/runtime/src/index.ts`、`apps/web/.../HardwareCard.tsx`、两份 i18n。
提交 `b4a7ce1`。

### A. 那 5 个模型在 Windows 上现在是什么状态（核心）

**从 `unsupported`（不可下载）变回可用。** `[实测]` 用真实形状的硬件快照跑 `computeFit`：

| 场景 | tier | reasonCode | cpuFeaturesUnverified |
| --- | --- | --- | --- |
| **Windows：特性集为空（＝从没查过）** | `slow_cpu` | `cpu_only_slow` | `["avx2"]` |
| 查到了 avx2 | `slow_cpu` | `cpu_only_slow` | `[]` |
| **查过、确实没有 avx2** | `unsupported` | `missing_cpu_feature` | `[]` |

第三行是关键：**真检查一点没被削弱** —— 有证据时该拦的照样拦。
被解锁的 5 个：`llm/qwen3-1.7b-q8_0`、`llm/qwen3-4b-q4_k_m`、`llm/qwen3-4b-q5_k_m`、
`llm/qwen3-8b-q4_k_m`、`llm/gemma-3-4b-it-q4_k_m`。

**没走到另一个极端**：未知**不等于**支持。做法是不动主判据（RAM/GPU 各自独立、仍然有意义），
另加一个**正交**字段 `cpuFeaturesUnverified: string[]`。把"没能确认"塞进 `reasonCode`
会逼它和"不支持"共用一个位置，而那正是这次事故的成因。

### B. 三态在界面上各自说什么话

| 状态 | 条件 | 中文 | English | 颜色 |
| --- | --- | --- | --- | --- |
| **不适用** | `arch !== 'x64'` | （一个字都不说） | (nothing) | — |
| **未知** | x64 且 `features.length === 0` | ` · 无法确认是否支持 AVX2` | ` · AVX2 support could not be determined` | 次要灰 |
| **不支持** | x64 且查到了特性但没有 avx2 | ` · 不支持 AVX2` | ` · no AVX2 support` | `text-critical` 红 |

上一次修复只分出了前两态里的"不适用"，**空集合仍然落进红色的"不支持"** —— 那就是 Windows 的现状。

### C. GPU 那一栏：**找到了**（上一位标的 UNKNOWN 可以撤销）

他搜不到是因为**那句话在 i18n 里，不在 tsx 里**：

```
apps/web/src/app/i18n/locales/zh-CN.json:341   "noGpu": "未检测到可用 GPU"
apps/web/src/app/i18n/locales/en.json:341      "noGpu": "No usable GPU detected"
apps/web/src/features/runtime/components/HardwareCard.tsx:49   {t('runtime.hw.noGpu')}
```

（搜 `gpus.length` 也搜不到，是因为那里判的是 `hw.gpus.length > 0 ? … : unifiedMemory ? … : noGpu`
这条三元链的**最后一支**。）

已按他的建议改成同病同治：**没装过任何后端包时**说
「尚未安装 GPU 后端包，无法检测」/「No GPU backend pack installed yet — cannot detect」，
装过了才说「未检测到可用 GPU」。判据是 `hw.backends.some((b) => b.installed)`。
理由与 CPU 那条完全一样：**GPU 枚举是探针干的，探针随后端包出厂 —— 没装就是没查过。**

⚠️ `[未验证]` 我没有真机跑过这一屏；改的是渲染分支，`apps/web` 458 条测试全绿，
但"它在浏览器里长什么样"本轮没有截图证据。

### D. `inferIsaFromBackendPath` 的处置：**删了**

- 全仓引用只有三处：它自己的定义、`packages/runtime/src/index.ts` 的转发、
  以及 `detectCpuWin32()` 上面那段**声称在用它**的注释。**零真实调用方**，零测试。
- 它本来就挂在 `check:orphans` 基线上。删掉之后 `check:orphans` 仍然
  「没有新的零引用导出，基线也没有过期条目」。
- 与被删掉的 `degradationChain` 同一形状，按本仓既定原则处理。

**更要紧的是那段注释**：它写着"我们因此从 ggml 实际选中的后端推断 ISA —— 见
`inferIsaFromBackendPath`"，读起来像一层已经存在的缓解。
**注释描述的是意图，不是代码**，于是每个读到这里的人（包括第一次审计）都以为
Windows 有这层保护。现已改写成：我们没做、为什么没做（wmic 已废、CIM 不报 ISA）、
将来要做该用 `IsProcessorFeaturePresent`（kernel32，`PF_AVX2_INSTRUCTIONS_AVAILABLE = 40`，
PowerShell `Add-Type` P/Invoke）、**以及不要在没有真 Windows 机器验证的情况下发出去**。

### E. 第 3 步（真的去查 Windows 指令集）：**这轮没做**，依据如下

1. **我没有 Windows 机器。** 唯一可靠的来源是 `IsProcessorFeaturePresent`，
   而它要 P/Invoke；`Add-Type` 需要现场编译，可能被执行策略挡。
   这些失败模式**只能在真 Windows 上才看得见**。
2. 上一位不修的理由在这里同样成立、而且更强：
   **「一个改到一半的探测器只会产出另一句假话」** ——
   而这个字段的全部毛病，恰恰就是"说得比它有资格说的更确定"。
3. 不做的代价现在是**有界且诚实的**：Windows 永远是"未知"，
   界面如实说"无法确认"，模型不再被误锁。**这比一个猜出来的 true/false 好。**

### F. 门禁

`tsc -b` 0、`build:safe` 0、`check:orphans` 干净（且少了一个孤儿）、
`@openmemo/shared` 47/0、`@openmemo/runtime` 130/0、`apps/web` 136+10+312 全 0 fail、
我的 6 个文件 `eslint` / `format:check` 通过。

⚠️ 全量 `pnpm -r test`（基线 1600）本轮**没有量**：按我自己那条脏树提示，
工作区里有别人在飞的改动（`HANDOFF.md`、`docs/SECURITY.md`、
`scripts/ci/e2e-allcomponents.mjs`、`scripts/ci/check-pending-claims.mjs`，
以及**有人正在扩写我那份 `verify-e2e-attestation.mjs` 去支持第 5 条腿**），
**在那里红不能归因于 master，在那里绿也不能证明 master 绿**。所以标 `[未验证]`，不假称量过。

---

# VAD 装错：实测 + 未做的部分 + PROTOCOL 条款起草（2026-08-09）

提交 `7249151`（只改了那句警告；其余是分析与起草，**未实施**）。

## ① `/models` 的 VAD 那一栏实际渲染成什么 —— **完全不显示 `engines`**

`[实测·全仓扫描]` `grep -rn "engines" apps/web/src`（排除测试）的**全部**命中：

- `app/query.ts:64`、`components/common/AsrEngineStatus.tsx`（6 处）
  —— 全是 **`pipeline.engines`**，即 daemon 侧"哪个 ASR 引擎构造成功了"，
  **与模型条目上的 `engines` 字段是两回事**；
- `features/models/**` 下 **零命中**。

⇒ **模型卡片从来没有渲染过 `engines`。** 用户在 `/models` 上看到两个名字相近的 VAD
（`silero-vad-onnx` / `silero-vad-ggml`），**没有任何一处告诉他哪个配他的引擎**。
这是"绝对没有"，不是"我没找到"——依据是界面代码里根本不存在这个字段的读取方。

⚠️ 三平台：这是**同一份前端代码**，与平台无关；我**只在代码层证实**，
没有在三平台各跑一次真浏览器 `[未验证]`（真浏览器那条腿归别人）。

## ② 那句警告改成什么（已实施，中英）

原文只说"加载不了 + 降级了"。现在追加：

> 「…你装的多半是 sherpa-onnx 用的那一个；whisper.cpp 需要「vad/silero-vad-ggml」，
> 去「模型」页装上它即可恢复按静音切分。」
> `/ …You most likely installed the sherpa-onnx one; whisper.cpp needs
> "vad/silero-vad-ggml" — install it from the Models page to restore silence-based chunking.`

**没带 UI 入口**：这是 `console.warn` 的日志行，不是界面元素。
界面侧的入口应该长在 `/models` 那一栏上（见 ④ 的建议），而那要动 locale ——
**locale 与 `HardwareCard` 此刻是 AVX2 那一路的在途文件**，我没碰。

## ③ 为什么重复 4 次 —— **是状态被真的重测了 4 次，不是日志被打了 4 次**

`[实测·读码]` `console.warn` 在 `apps/daemon/src/pipeline/setup.ts:340`，
位于 `buildPipeline()` 内；而 `buildPipeline()` 在 **启动时**（`main.ts:633`）
**以及组件装好后的热重建**（`main.ts:670`）都会跑。

⇒ 用户那段日志里出现 4 次 = 那一会儿装配了 4 次（启动 + 数次装完组件后的重建）。
**所以按你的判据，不该加去重** —— 去重会把"最后一次的真实状态"也一起吞掉。
该改的是**每次都重复的那句话里没用的部分**（没说怎么办），这部分已改。

⚠️ `[未验证]`：**具体是不是恰好 4 次装配**（我没有他的完整日志，也没复现）。
成因链是读码确认的，次数不是。

## ④ 目录层的结构性做法（**建议，未实施**）

判据你已经定了：**不是过滤掉不匹配的**（用户会换引擎），
而是**"用户在点之前就知道这个适不适用于他现在的引擎"**。

我的建议与依据：

1. **卡片上直接标注 `engines`**（"whisper.cpp 用" / "sherpa-onnx 用"），
   并按**当前生效引擎**把匹配的排前面 + 给一枚「推荐」角标。
   依据：`engines` 是**目录里已有的事实**，不需要新数据；
   而排序/标注**不隐藏**任何东西 —— 换引擎的人照样找得到另一个。
2. **不做过滤**。依据同上，也与本仓既有判据一致
   （`ModelsPage` 对语言不匹配的变体是"默认折叠 + 显式告诉你藏了几个"，
   而不是删掉 —— 那条已经证明可行）。

### 能不能做成"编译不过或当场红"（你问的那条）

**能做一半，而且那一半正是最有价值的：**

- ⛔ **做不成编译期**：`role='vad'` 底下有两个互不兼容的权重，
  这是**目录数据**的性质，不是类型的性质；TS 挡不住"清单里两条 engines 不同"。
- ✅ **能做成清单门禁（当场红）**：加一条 manifest 校验 ——
  **同一个 `role` 下若存在 `engines` 不相交的条目，则该 role 的每个条目
  都必须带上可供界面区分的标注**（今天 `engines` 已经有，所以这条**立刻可满足**）；
  再加一条**前端侧**的：**渲染模型卡片的组件必须消费 `engines`**
  —— 用现成的 `check-orphan-exports` 那类"零引用"思路反过来做
  （`engines` 在 `apps/web/features/models/**` 里零引用 ⇒ 红）。
  这正好把今天这个缺陷变成**机器可判定**的。

⚠️ 这两条我**没有实现**（需要动 manifest 校验器与前端，而前端 locale 在别人手里）。

## ⑤ 起草：PROTOCOL 新条款（**未写进 `PROTOCOL.md`，交你裁**）

### 建议标题：**「有出处的断言，出处里可能根本没有那句话」**

**形状**：代码/注释里一条"依据 X"的断言，而 X 里**从来没有过那句话**。

**本轮实例**（`[实测]`）：`packages/pipeline/src/tools.ts` 注释称
「**D-01 §8.4 L2 forbids PATH lookups for real invocations**」。
去读 `D-01 §8.4`：**第二层（L2）是「绝不经过 shell」**（`D-01:1172`），
**该节从头到尾没有禁止过 PATH 查找**。那条禁令是注释**凭空发明并挂到文档名下的**。

**为什么比 §13 更危险**：

| 条 | 形状                                     | 为什么难查                         |
| -- | ---------------------------------------- | ---------------------------------- |
| §13 | 裁决了，**没回去改原文**                 | 原文看起来还活着                   |
| **本条** | **原文从来没这么说，是引用者编的** | **带出处的断言看起来已经被审过了** |

后果是**复利**的：下一个人不会去核一条"有据可依"的规则，
反而会**在它上面再加规则**。本轮那条就直接把产品立场写反了
（把用户明确允许的"借系统 ffmpeg"写成了"禁止"）。

**判据**：**引用即承诺。写下"依据 X"的人，有义务确认 X 里真的有那句话；
核不到就不许写出处** —— 宁可写"我们的判断是…"，也不要挂一个没有的出处。

### 能不能机器可判定 —— **能，但只能做到"提醒去核"，不能做到"判对错"**

- ✅ **可行的那半**：扫 `.ts/.tsx/.md` 注释里形如 `D-\d+ §[\d.]+`、`ADR-\d+ 决策 \d`、
  `PROTOCOL §\d+` 的引用，**校验被引文件与该锚点存在**（文件在、章节号在）。
  这条是纯结构的，不会常态红。
- ⛔ **做不到的那半**：**"那句话是不是真的那个意思"** ——
  本轮这条的锚点 `§8.4` **是存在的**，错的是内容。
  自动判定它需要语义比对，**做成检查就会常态红或大量假阳**，那正是你禁止的。

⇒ **建议只收"锚点存在性"这一条机器检查**，语义那半靠本条款的judgment。
**如果你觉得连锚点检查都会吵，那就只收条款不收检查** —— 我不认为它值得用一条吵闹的门禁换。

### 那两条同族要不要合并 —— **我的判断：分开，但放同一节**

- `folderById` 声称"由调用方决定 deleted 算不算 404"而五个调用方无一检查、
  `runner.ts:190` 声称 Windows 用 `taskkill` 杀进程树而全仓零实现
  —— 这两条是**「声称已做，实则零实现」**；
- 本轮这条是**「声称有出处，实则出处里没有」**。

**共同点**：都是**一句让人停止追问的话**（"已经做了" / "有依据"）。
**不同点**：前者可以被**存在性检查**抓（有没有那段代码/那个调用），
后者的锚点**是存在的**，只有内容不符 —— **可检测性完全不同**，
合并会让"能机器抓的那半"被"抓不了的那半"拖着一起变成纯口号。

⇒ **建议：一节两小条**，共用一句总纲
（**「让人停止追问的那句话，必须自己先被追问一次」**），
但把"声称已做"与"声称有据"分列，各自写各自的检测手段。

## ⑥ 诚实边界

- `[实测]`：`engines` 在 `features/models/**` 零引用；警告出处与 `buildPipeline()`
  的两个调用点；`D-01 §8.4` L2 的真实内容；两个 VAD 的 `engines` 取值。
- `[未验证]`：三平台真浏览器上 VAD 那一栏的视觉呈现；"恰好 4 次"这个次数。
- `UNKNOWN`：无。
- **未实施**：卡片标注/排序、清单门禁、前端 `engines` 零引用检查、PROTOCOL 条款（仅起草）。
- 未碰 `:10000` / `/root/data-memo` / 机器级指针；未用 `pkill`；未建改删 release；
  未动另外四路在改的文件（`packages/runtime/**`、`fitness.ts`、`HardwareCard.tsx`、
  两份 locale、`packages/downloader/**`、`docs/**`）。

---

## [2026-08-09 18:10] e2e-import：「missing [无]」那一行 DONE

交付: `apps/daemon/src/bootstrap/tool-refresh-message.{ts,test.ts}`（新）、
`apps/daemon/src/main.ts`。提交 `0bbc201` + `65a126d`。

### A. 改完之后那一行长什么样

```
[daemon] 工具表已热刷新：四项必需组件（ffmpeg、ffprobe、whisper-cli、asr-model）都装齐了，当前一项都不缺。
[daemon] 工具表已热刷新：现在缺 2 项：whisper-cli、asr-model（刚才还是齐的）。
[daemon] 工具表已热刷新：仍缺 1 项：asr-model（此前缺 2 项：whisper-cli、asr-model）。
```

三条规则：**状态词绝不进列表位**；三个方向（装齐／变缺／中间态）都说得出；
数量为 0 时**根本不进"缺 N 项"句式**，所以不可能出现「缺 0 项」这种读法。

⚠️ **刻意没写「转写可以用了」** —— 理由见 §C。这条日志没有资格替运行时打包票。

**关于中英**：`[未做，有依据]` daemon 控制台**没有任何 i18n 机制**，
从启动横幅到每一条 `[daemon]` 日志全部是中文（`ready-banner.ts` 亦然）。
把其中**一行**做成双语，只会让这块界面变得不一致。要做就该整块做，
那是另一件事、也不是这一轮该顺手开的。英文措辞若将来要用：
`All four required components (ffmpeg, ffprobe, whisper-cli, asr-model) are installed — nothing is missing.` /
`Now missing 2: whisper-cli, asr-model (they were all present a moment ago).` /
`Still missing 1: asr-model (previously missing 2: whisper-cli, asr-model).`

### B. 横扫同形：**真阳性只有这一处**

全仓扫了 `join(...) || '…'`、`[${… || '无'}]`、以及 `${n} 个` 这三类
（`apps/*/src`、`packages/*/src`、`scripts/`），命中约 20 处，逐条判读之后：

| 判定 | 数量 | 例子与理由 |
| --- | --- | --- |
| **确实有歧义** | **1** | `main.ts:675` 本条 —— 状态词占着名字的位置，且标签只写 `missing` |
| 其实没问题（名词自带） | 多 | `selfcheck.ts:748` `…|| '未检出'`（**恰好就是 AVX2 那一课的正解**）、`selfcheck.ts:1484` `'无探针结果'`、`verify-offline.mjs` `'无残留'` —— 那个词**自己带着名词**，读不反 |
| 其实没问题（数量在旁边） | 多 | `probe-cold-timing.mjs:188` `后端库（${libs.length}）：${… || '(无)'}` —— **数量和列表并排**，`（0）：(无)` 不可能读反 |
| 计数类 | 5 | `还有 N 个组件没装` / `解除 N 个任务的阻塞` / `N 个符号链接` —— 名词都写死在句子里，0 也不歧义 |

**结论：这个形状在本仓是罕见的，绝大多数地方已经写对了。** 所以我只改了这一处，
没有为了"横扫"去动本来没问题的行（尤其 `packages/downloader` 与 `docs/` 正有别人在飞）。

### C. `pipeline.missing` 为空 **不严格等价于**「能转写」——但用户确实可以转写

`missing` 只由四项构成（`setup.ts:359-432`）：`ffmpeg` / `ffprobe` / `whisper-cli` / `asr-model`
（其中 asr-model 还过了一道「ASR 绝不能等于 VAD 权重」的闸）。

**不在 `missing` 里、但会影响转写的**：

1. **VAD** —— **刻意不算缺件**。缺 VAD 会退回固定窗口切分，**仍然转得出字**（T-148），
   只是切分质量差一档。所以它不该阻塞，现状是对的。
2. **引擎与模型格式是否匹配** —— 由 `canEngineLoad` 判，而它跑在
   **job 运行时**（`jobs/runners/transcribe.ts:313`），不是 `buildPipeline` 时。
   正常安装路径有安装记录、`resolveModelById` 带 `engine:'whisper.cpp'` 过滤，
   到不了这里；但 setup 的**回退** `scanByName(…, {ext:'.bin', excludes:'silero'})`
   （`modelStore.ts:329`）**只按扩展名和文件名挑，不过 engine 过滤** ——
   手工塞一个非 ggml 的 `.bin` 就会：`missing` 为空、健康检查绿，**转写在 job 里才失败**。
   好消息是它**响亮地失败**（「引擎 whisper.cpp 加载不了这个模型…（它要的是 ggml 格式）」），
   不是静默出垃圾。

**对用户这一问的回答**：他的 `missing` 已空 ⇒ 四项必需组件都在 ⇒ **他可以转写**。
上面第 2 条是理论缺口，只在手工摆放模型时才会碰到；他是走产品自己的组件安装流程装的。

⚠️ Manager 那句"你已经装齐了"**结论对、方法错**（没核就说）——
这次是核过的：`missing` 的构成、VAD 不阻塞、`canEngineLoad` 的时机，逐条读过源码。
⚠️ `[未验证]` 我没有在用户那台机器上真跑一次转写。

### D. 守卫：**做不成全仓机器判据**，只做成了这一处的性质断言

**做不成的依据是量出来的**：候选约 20 处，真阳性 1 处。
一条禁止 `|| '无'` 的正则会把 `'未检出'`、`'无探针结果'`、`'无残留'`、
以及"数量并排"那几处**全部误报** —— 命中率 1/20。
本仓已经有明规矩：**一条常态红的守卫等于一条被删掉的守卫**；
一条 95% 误报的守卫会更快地训练所有人无视它。
"这个空值占的是不是列表位"需要理解**语义**，正则读不出来。

**做成了的那一半**：把措辞抽成纯函数（与 `ready-banner.ts` 同一理由 ——
让措辞变成可断言的性质），5 条用例钉的是**性质**不是具体字句，其中一条遍历四种
前后组合，断言**任何一支都不许把 无/空/none/N/A 渲染进方括号或圆括号的列表位**。
这一行再退回去，当场红。

### E. 一件事故：我的 `main.ts` 改动在两条命令之间被还原了

第一次提交 `0bbc201` **只落了纯函数与用例，调用点没进去** ——
`git commit -- <pathspec>` 执行时 `main.ts` 已经没有 diff 了：
在我改完它与提交之间，那个文件被别人还原过（同期 `a79baad` 等提交在动 main.ts）。

**这正是 §12 那条**：「一个在检查那一刻为真的结论，不等于在你据此行动那一刻仍然为真」。
`git show --stat` 的提交后复核**当场抓到了**（预期 3 个文件、实得 2 个），
已用 `65a126d` 补上，且重放脚本用 `assert` 钉住锚点：**对不上就停手，不猜**。

### F. 门禁

`tsc -b` 0、`build:safe` 0、`check:orphans` 干净、`@openmemo/daemon` **573/573 fail 0**
（含新增 5 条）、我的 3 个文件 `eslint` / `format:check` 通过。

⚠️ 全量 `pnpm -r test`（基线 1600）**没有量**：脏树提示显示同期有别人在飞的改动
（`apps/web` 的 locale 与 `ModelCard.tsx`＝VAD 那一路、`packages/downloader/src/download.ts`），
按那条提示自己的规矩 —— **在那里绿也不能证明 master 绿**。标 `[未验证]`。

---

# 引擎适配标注 + §14 落地（2026-08-09）

提交 `e5bcefb`（界面 + 守卫）、`coordination/PROTOCOL.md` §14、本回执。

## ⚠️ 先更正我上一轮的一个错误结论

我上轮说：「`engines` 在 `features/models/**` **零引用** ⇒ 界面从来没显示过适配信息，
这是**确定不存在**而不是没找到」。**那句话是错的。**

`[实测]` 我把 `grep` 输出 `head -8` 截断了，漏看了
`apps/web/src/features/models/components/QuantSelector.tsx:47-51` ——
它**一直在**按 `enginesOf(v)` 给量化档打标（`git log -S` 定位到 `f02332a`，
**早于**用户 2026-08-09 那次事故）。

**所以 `engines` 不是零读者。** 我那句"确定不存在"本身就是一次
**"没找到当成不存在"** —— 正是我这几轮反复在别处指出的形状，这次犯在我自己身上。收回。

**真实缺口比我说的窄**：标注**只在量化下拉里**、且**只在同组变体 engines 不同时**才出现；
卡片主体没有常驻标识，**也没有任何地方把它与本机当前可用的引擎对照**。

## ① `/models` 上用户现在看到什么（真实文案）

卡片标题旁常驻一枚 chip（`data-testid="model-engine-fit"`）：

| 情形 | zh | en |
| --- | --- | --- |
| 适配、本机可用 | **适配 whisper.cpp** | **For whisper.cpp** |
| 适配、但本机当前引擎不在其列 | **适配 sherpa-onnx · 当前用不上**（警告色） | **For sherpa-onnx · not usable now** |
| hover | 你这台机器上当前可用的引擎不在这个列表里 —— 装了也不会被加载。换引擎后它就能用。 | None of the engines available on this machine are in that list — installing it will not make it load. It becomes usable if you switch engines. |

**判据按裁定：标注、不过滤** —— 什么都不隐藏，换引擎的人照样找得到另一个。
引擎还没探回来（`ready === false`）时**只标适配、不下"用不上"的判断**（三态，不猜）。
空 `engines` 不渲染（`shared/models.ts:495` 明说其语义是 "nothing can load this"，
那是清单缺陷，不该在卡片上冒充成结论）。

⚠️ `[未验证]`：**三平台真浏览器上的实际渲染**。web 组件测试 312 pass / 0 fail，
但真浏览器那条腿归别人，我没跑。

## ② 零读者守卫的反向验证

`scripts/check-contract-fields-shown.mjs` —— 孤儿导出那招的**反面**：
「已经送到前端的字段，界面必须真的读它」。规则**人挑、逐条附"坏了会怎样"**。

- **对照组（今天）**：✔ 绿，`engines` 有 **2 个读者**（`ModelCard` / `QuantSelector`）。
- **反向验证**：`/tmp` 隔离副本里把**两个读者都**改名 → **`exit 1` 当场红**，并打印后果。
- ⚠️ **只拿掉其中一个不会红** —— 我第一次的反向验证正是这么"没红"的，
  也正是它逼我发现上面那个更正。这条守卫守的是**"有没有人显示"**，不是"显示得够不够"，
  **边界已写进脚本注释**。
- 匹配**标识符**（`\bengines\b`）不是散文 ——「靠散文措辞撑着的守卫会静默停止工作」。

## ③ 警告的界面入口

`console.warn` 那行上一轮已改成说清"去装 `vad/silero-vad-ggml`"；本轮补上**界面侧对照** ——
用户拿着日志回到 `/models`，卡片上直接写着哪个适配 whisper.cpp、哪个"当前用不上"。
⚠️ **没做**从日志直接跳转的深链（需 daemon 往日志塞 URL，且要与"日志文案"那一路对齐）。

## ④ PROTOCOL §14 已写入

一节两小条、不合并，统一句用原话
「**让人停止追问的那句话，必须自己先被追问一次。**」
§14.1 声称已做实则零实现（可机械化，点名两个现成实现）；
§14.2 声称有出处而出处里没有（与 §13 反向，写明它把产品立场写反了）。
**机械化只收锚点存在性**，明写语义比对做不到（会常态红），故本条不配套检查。

## ⑤ 边界与诚实标记

- `[实测]`：`QuantSelector` 早已读 `engines` 及其落地 commit；守卫对照组与反向验证；
  web 组件测试 312/0。
- `[未验证]`：三平台真浏览器渲染；用户看到新 chip 后能否自行解决。
- `UNKNOWN`：无。
- 我的提交 `e5bcefb` 经 `git show --name-only` 按 **hash** 复核 = 恰好我的 4 个文件，无夹带。
  ⚠️ 期间 HEAD 被别人推进了数次，所以我按 §12 用 hash 复核而不是看 HEAD。
- 未碰 `:10000` / `/root/data-memo` / 机器级指针；未用 `pkill`；未建改删 release；
  未动 `packages/downloader/**`、`e2e-browser.*`、`docs/**` 等他路在途文件。

---

# SSE 流实测：是 ②，而且比"没推"更具体（2026-08-09）

提交 `7306f3d`。**先答你要的那条。**

## ① 五个 step 各自发没发、什么时刻发（接 `/api/events`，不是轮询）

`[实测 2026-08-09, linux, 拉 vad/silero-vad-ggml]` 完整事件流（ms 自订阅起）：

```
   928  job.created
   928  job.state       state=running
  5931  sources.probed
  6187  job.progress    step=resolving     pct=0
 16665  job.progress    step=resolving     pct=0
 21499  job.progress    step=downloading   pct=0
 22287  job.progress    step=downloading   pct=0.017
 …
 23665  job.progress    step=downloading   pct=0.572
 23835  model.activated / model.installed / storage.changed
 23836  job.state       state=succeeded
 23836  job.done
 24029  job.progress    step=verifying     pct=1        ← ★ 比终态晚 193ms
```

| step | 发了吗 | 何时 |
| --- | --- | --- |
| `resolving`  | ✔ | 6187ms（下载前） |
| `downloading`| ✔ | 21499ms 起，多条 |
| `verifying`  | ✔ **但排在终态之后** | **24029ms，`job.done` 之后 193ms** |
| `installing` | ✘ **一次都没有** | — |
| `succeeded`  | ✔（`job.state`） | 23836ms |

## ② 是 ① 还是 ②：**是 ②，两种形态**

**不是"太短被漏掉"** —— SSE **不采样**，发了就一定收得到。所以：

- **`installing` 是真的没推**（0 次）；
- **`verifying` 推了，但顺序是错的** —— 它在 `job.done` **之后**才到，
  于是客户端收到的**最后一条**是「正在校验完整性 100%」，**界面就永远停在那儿**。

⚠️ **这正好是用户症状的形状**，而且解释了为什么"活儿干完了界面还卡着"：
**界面显示的是它收到的最后一个状态，而那个状态是过期的。**

## ③ 丢在哪一层 —— 两层，分别是

**(a) 顺序：`apps/daemon/src/http/sse.ts` 的 `publish()`**（已修）

节流事件进 `#pending` 等 **250ms**；未节流事件走 `#flushOne` **立刻发**。
⇒ 终态**超车**过期进度。
**修法**：未节流事件发出前，先把**同一 topic** 上压着的那条节流事件放出去。
`job.progress` 与 `job.done` 同用 `topics.job(jobId)`，按 topic 冲刷即可恢复因果顺序，
**又不会**因为别的 job 发终态而打掉全局节流。
`[实测·修后同一观测]` `verifying` 现在排在 `job.state succeeded` / `job.done` **之前**。

**(b) `installing` 从来没有载体：`packages/downloader/src/queue.ts:208-211`**（**未修**）

```ts
setStep: (s) => { job.step = s; job.updatedAt = …; },   // ← 不 emit 任何东西
setProgress: (p) => { …; this.emit('job.progress', job); }  // ← 只有它发事件
```

`step` **本身不是一个事件**，它只是**搭 `job.progress` 的车**（该事件的载荷里带 `step`，
契约 `events.ts:129` 确实有这个字段）。安装阶段不报字节进度 ⇒ 没有车可搭 ⇒
`installing` 永远到不了前端。

**我没有顺手加 emit**，因为你说的那条：**"别改成多发几个事件就完事"**。
`installing` 该怎么表达是个产品判断（要不要给它一个不确定进度条？要不要说"这一步通常几秒"？），
而且它与「82MB/574MB 在 Windows 上到底多久」是同一个问题的两半 —— **建议一起裁**。

## ④ 那三件顺带的：我只做了 0 件，如实说

`builtinBaseline` 独立字段、`unpack.ts` 注释与实现互相矛盾（§14 同族）、
82MB/574MB 的 Windows 耗时 —— **一件都没做**。
理由：本轮预算全部用在 SSE 观测 + 定位 + 修顺序 + 验证上。
⚠️ 其中 **`unpack.ts:16-19` vs `:169-183`** 我连**读都没读**，
所以**连"哪边对"都还不知道** —— 标 `UNKNOWN`，不猜。

## ⑤ 诚实标记

- `[实测]`：上面整张事件表（修前/修后各跑一次真下载，接 SSE 非轮询）；
  `setStep` 不 emit；节流与 `#flushOne` 的分支；daemon http 测试 113 pass / 0 fail。
- `[未验证]`：**Windows 上的同一张表**（本轮只在 linux 上跑）。
  ⚠️ 修的是**顺序**，与平台无关；但"Windows 上某一步是不是真的很久"仍然没有数据 ——
  按你的判断那本来就该由「每个组件都下一遍」那条腿去量。
- `UNKNOWN`：`unpack.ts` 那处矛盾谁对；`installing` 该以什么形式呈现。
- 我的提交 `7306f3d` 按 **hash** 复核 = 只有 `apps/daemon/src/http/sse.ts`，无夹带。
- 未碰 `:10000` / `/root/data-memo` / 机器级指针；未用 `pkill`（daemon 走
  `/api/daemon/shutdown` 关停）；未建改删 release；未动他路在途文件
  （`packages/downloader/**`、`docs/**`、`e2e-browser.*` 等）。

---

## [2026-08-09 22:40] e2e-import：给 `installing` 一个载体 DONE（4 件里做了 2 件，另 2 件明说没做）

交付: `packages/downloader/src/queue.ts`、`apps/daemon/src/http/rest/state.ts`、
`apps/web/{features/models/sse.ts,lib/stores/progress.store.ts,features/tasks/api.ts,
features/recorder/RecorderPage.tsx}`、两份 i18n。提交 `7a48b3b`。

### A. 加了载体之后，SSE 流里五个 step 的实际顺序与时刻

**用真 SSE 流量的**（起 daemon → 接 `/api/events` → 拉 `vad/silero-vad-ggml` 0.9 MB），
不是单测：

```
    ms   event         step          pct
    73   job.created   -             -
    73   job.state     -             -        (running)
  5331   job.progress  resolving     0
 15811   job.progress  resolving     0
 23143   job.progress  downloading   null     ← 阶段公告（新）
 23393   job.progress  downloading   0
 27096…28279  job.progress downloading 0.017→0.59
 28279   job.progress  verifying     null     ← 阶段公告（新）
 28284   job.progress  verifying     1
 28284   job.progress  installing    null     ← **以前根本不存在**
 28290   job.state     -             (succeeded)
 28290   job.done      -             -
```

**两条判据都成立**：

- `installing` **出现了**，且 `pct=null`（没有编百分比）。
- **最后一个 `job.progress` = 28284ms（installing） < `job.done` = 28290ms**
  —— **没有任何进度事件晚于终态**，顺序修复覆盖到了新事件。
  （对照：修之前那位量到的是 `job.done` 23836ms、`job.progress verifying` 24029ms，晚 193ms。）

还能看到设计生效的痕迹：每个阶段都是**先到未节流的公告（null）、再到节流的数值**
（23143 null → 23393 0；28279 null → 28284 1）。

⚠️ **一处异常，如实报**：`resolving` **没有产生阶段公告**（只有 5331ms 那条 pct=0 的
节流进度）。`startModelPull` 确实调了 `ctx.setStep('resolving')`，`job.step` 初值是
`null` 所以"变化"判定应当为真，而 `downloading`/`verifying`/`installing` 三个都正常发出。
**成因 `UNKNOWN`** —— 我没有把它查到底就停了（预算），也没有编一个解释。
影响面小（resolving 阶段本来就有节流进度在走，界面不会空白），但它是个真缺口，建议后续查。

### B. 界面在安装阶段现在显示什么

- 事件：`step='installing'`、`pct=null`、字节计数一并 null
  （留着上一阶段的字节，界面会继续画一条"574MB/574MB"的满条，看起来像还在下载）。
- `features/models/sse.ts` 以前把 `pct: null` **兜底成 0** —— 于是"正在安装"会渲染成
  **一条停在 0% 的进度条**，一个看起来精确的假话。现在原样传 `null`，
  `progress.store` 的 `progress` 改成 `number | null`。
  ⚠️ 改成可空之后**编译器当场逼出两个消费者**（`RecorderPage.tsx`、`tasks/api.ts`），
  都按"不确定"处置了 —— 这也是这次唯一算得上"守卫"的东西：类型让漏网无处可去。
- 文案：`jobToast.installingHint` 原文是「正在解压并写入模型目录，**马上就好**。」
  / 「…, **almost done**.」—— **两处都是没量过的时长承诺**，已删。
  现在：「正在解压并写入模型目录。这一步没有进度刻度，请稍候。」/
  「Unpacking and writing to the models folder. This step has no progress scale — please wait.」

**契约没动**：`JobProgressEvent.pct` 本来就是 `number | null`，注释原话
「Null when the step genuinely cannot report a fraction.」—— 载体一直在，只是没人用。

### C. 没做的两件（明说）

1. **`unpack.ts` 注释与实现互相矛盾那笔债 —— 没做。**
   `[未核实]` 我**连打开都没打开**，与上一位同样标 `UNKNOWN`。不是判断它不重要
   （§14 同族、一句让人停止追问的话），是预算到这里已经不够再开一条线，
   而**半读一遍再下结论**正是这一族毛病本身。留给下一位，或我下一轮。
2. **`OPENMEMO_TIMING=1` 接到「每个组件都下一遍」那条腿 —— 没做。**
   那条腿的主人正在查 `whispercpp-*` 全族装不上，Manager 已提示别抢那个文件。
   我判断此刻去动它**收益不确定、冲突确定**。82MB / 574MB 在 Windows 上的耗时
   仍然 `[未量]` —— 所以本轮**一个时长数字都没写进产品**（见 §B）。

### D. 门禁

`tsc -b` 0、`build:safe` 0、`check:orphans` 干净、
`@openmemo/downloader` 40/0、`apps/web` 136+10+312 全 0 fail、
我的 8 个文件 `eslint` / `format:check` 通过。

⚠️ 全量 `pnpm -r test`（基线 1605）**没有量**：脏树提示显示 Windows 搬迁那一路正在动
`apps/daemon/src/storage/*` 与 `http/rest/storage.ts`。按那条提示自己的规矩 ——
**在那里绿也不能证明 master 绿**。标 `[未验证]`。

⚠️ §12：本次提交后**按 hash（`7a48b3b`）复核**而不是 HEAD —— 8 个文件全在、且都是我的。

---

# SSE 断线重连:客户端这条**也排除**(2026-08-09)

**直接答:不会永远停住。** 客户端有重连回填,而且**接线是通的**(不是零读者)。

## 逐条证据(全是读今天的代码,`[实测·读码]`)

| 你问的 | 答案 | 证据 |
| --- | --- | --- |
| ① 重连后重新同步吗? | **会,而且是全量失效** | `lib/events/source.ts:120-125` `onopen` 里:若之前是断的(`wasDown`)→ `bus.emit('sync.required', {reason:'replay_gap'})` |
| 那个事件有人听吗? | **有** | `lib/events/system.sse.ts:15` `bus.on('sync.required', () => void qc.invalidateQueries())` —— **全量**失效 |
| 它真的被装上了吗? | **是** | `lib/events/bindings.ts:18` import、**`:44` 出现在注册数组里** |
| ② 有心跳吗? | **两侧都有** | 服务端 `http/sse.ts:211-221` 定时 keepalive;客户端 `source.ts` watchdog —— **连 keepalive 都收不到就主动重建连接**(注释原文:"连接实际已死但浏览器没报错") |
| ③ 支持 `Last-Event-ID` 吗? | **支持** | `http/server.ts:413-415` 读 `last-event-id` 头并传给 `sse.attach(sid, res, lastId)`;`sse.ts` 有 `#ring` 重放缓冲 |
| 重放缓冲滚过了怎么办? | **已经想到了** | `source.ts:123` 注释:"重放缓冲只有 256 条,一次批量下载就能滚过 → **重连后一律全量失效,宁可多拉一次**"。另有 seq 缺口检测(`:91`)同样触发 `sync.required` |
| ④ 轮询兜底 | **有降级态** | `onerror` 累计到 `MAX_RECONNECT_BEFORE_DEGRADE` → 连接态置 `degraded` |

⇒ **"断线 → 重连 → 界面停在过期状态"这条链在代码里是断的**:
重连必然触发一次 `invalidateQueries()`,任务卡片会重新拉真实状态。
**即使 256 条重放缓冲滚过、即使 `Last-Event-ID` 那条路失效,全量失效也兜住了。**

## ⚠️ 我没做的那一件,以及它为什么重要

**第 5 条(真的在浏览器里掐一次连接看卡片会不会变)我没有做。**

所以严格说:我排除的是**"客户端结构上没有回填"这个假设** —— 它**被证伪了**。
但**"在真浏览器里、真掐断、卡片最终会更新"** 仍然是 `[未验证]`。
两者的差别正是你反复强调的那条:**代码里接上了 ≠ 界面上真的变了**。
(而这恰恰就是第七类盲区本身 —— 我这轮**仍然只是在读服务端/客户端的代码**,
没有一次是在浏览器里看的。)

## 我的判断

**这条线索大概率也该排除**,理由是回填是**无条件的**(`wasDown` 一为真就全量失效),
不依赖重放缓冲、不依赖 `Last-Event-ID`、也不依赖事件类型 —— 没有"漏掉某一类"的缝。

**但请不要据此结案**:三条线索(后端包路径、模型安装路径、客户端回填)现在**都排除了**,
而用户的现象仍然存在。**这说明我们还没找到那个真前提**,
比如:他那次是不是根本没到 `installing`(卡在 `downloading` 而 UI 文案说"正在安装")?
`任务中心` 那个卡片读的是哪个字段?**下一步该去量的是他那句话里的"任务中心"到底渲染的是什么**,
而不是继续在 SSE 这条线上加解释。

## 给 `e2e-browser` 那条腿的用例建议(未实施)

若要钉住这一类,判据必须是**"客户端最终显示正确"**而不是"服务端发了事件":

> 起一个下载 → **在浏览器里掐断 SSE**(`page.route` abort `/api/events`,或让服务端停发)
> → 等服务端把 job 跑完 → **恢复连接** → 断言**卡片文案最终变成终态**(带超时)。

⚠️ 它钉的是"最终一致",所以**不许**断言"收到了某条事件" —— 那又回到服务端视角了。

## 诚实标记

- `[实测·读码]`:上表每一行的文件与行号,都是今天这棵树上核到的。
- `[未验证]`:真浏览器里掐断连接后的实际行为;用户那次到底卡在哪一步。
- `UNKNOWN`:他说的"任务中心 正在安装"对应界面上哪个字段/哪段文案 —— 我这轮没去读。
- 本轮**未改任何代码**;未碰 `:10000` / `/root/data-memo` / 机器级指针;未用 `pkill`;
  未建改删 release。

---

# 把文案判据写成断言(2026-08-09)

**第一句直接答:我这轮也没在浏览器里看过那行字。**

所以「依次显示的是什么」我**答不了**,只能说清两件事:
① **代码路径预测**它应当依次是 `正在选择下载源 → 下载中 → 正在校验完整性 → 正在解压 → 正在安装`
(`lib/format/stepLabel.ts` 把三处兜底收敛成一处,缺词条回退到中性的「处理中」);
② **我把这条判据写成了 `e2e-browser` 里的真断言**,**下一次 CI 跑出来的就是答案**。
这正是你要的那个方向 —— **让机器去看,而不是再由一个 agent 声称自己看过。**

提交 `2ae2827`(只动 `scripts/ci/e2e-browser-audit.mjs`,**未碰产品**)。

## 写了什么(只读 DOM,一个 `/api/events` 都不看)

判据用你的原文:**客户端最终显示的字,不是发出了哪个事件。**

- **B6** 起一个真实安装,轮询任务中心的 DOM:
  - ① 出现过的阶段文案必须都在中文表里;
  - ② **任一时刻不许出现 ASCII-only 的 step token**(`unpacking` 这种机器枚举值);
  - ③ **走到后段之后不许再出现「排队中」**(阶段倒退)。
- **B6b** 下载期间 Toast 标题不许含「安装」二字。
- **B7** 三条 llm 引导:判据是**落地页上真的有那个控件**,不是"跳转发生了"。

⚠️ **刻意不断言「五个阶段都出现」**:采样观测只能证伪不能证实,
而安装那几步实测是**毫秒级**(5/6/9 ms)。写死会造出一条**随机红**的断言,
而随机红的断言等于没人信的断言。所以断言的是
「**出现过的都合法 + 没有那两种说谎形态**」。

## 你问的那条:解包时百分比掉回 0% —— 我**没有**断言它,理由如下

你倾向"断言它并让它红"。**我同意它在说谎**,但不同意这轮就让它红,理由是**位置变了**:

**`e2e-browser` 现在在发布闸门里。** 一条红的断言会挡住**所有**发布 ——
包括与它完全无关的修复。而本仓自己立过的判据是:
**一个永远红的门禁等于没有门禁,它训练所有人忽略这盏灯。**

**这条腿里已经有一个更合适的机制**:`KNOWN_DEAD` 那种**钉住集合**的做法 ——
清单之外的出现 → 红;**清单里的被修好了 → 也红**(逼人回来划掉)。
它给了可见性,又不会把闸门焊死,而且**这个机制在本仓已经真的发挥过一次作用**。

⇒ **建议**:把"解包期间百分比掉回 0%"登记进那张清单,而不是写成一条会挡发布的断言。
**我这轮没有实施**(预算见底),所以它现在**既没被断言也没被登记** —— 如实说。

## 没覆盖到的渲染链(说清楚)

- **`DownloadRow.tsx` 的 `models.download.*`** —— 上一路明说没收敛,我这轮的断言
  **也没覆盖它**:B6 读的是任务中心(`/tasks`)的 DOM,不是 `/models` 上那一行。
  ⇒ **那条渲染链目前无人守。**
- **`/settings` 那条**(如果还有引导指向它)未验。

## ⚠️ 这条线索没有结案

上面全部只解释了「为什么用户看到『正在安装』」和「中间那段界面在说错话」。
**它没有解释一个 job 在 Windows 上真的长时间不推进。**
后端包路径、模型安装路径、客户端 SSE 回填 —— 三条都排除了,现象仍在,
**真前提还没找到。**

## 诚实标记

- `[未验证]`:**B6/B6b/B7 三条断言我一次都没跑过**(本机没有装好的预编译包 +
  启动器环境,而这条腿按设计必须走真实启动器,不许退回 `node main.js`)。
  它们**语法与 lint 通过**,但**是否会在 CI 上如实变红/变绿,下一轮才知道**。
  ⚠️ 一条没跑过的断言与一条没有的断言差别不大 —— 请在下一轮 e2e-browser 上看它的结果。
- `UNKNOWN`:那行字实际依次显示什么;Windows 上 job 不推进的真因。
- 本轮**未改产品代码**;未碰 `:10000` / `/root/data-memo` / 机器级指针;未用 `pkill`;
  未建改删 release;未动五路在途文件(`packages/downloader`、`build-bundle.mjs`、
  daemon 内置模型、README/manifest/D-17 等)。

---

# 跑不到 + 钉住集合 + DownloadRow 的判断(2026-08-09)

**第一句直接答:三条断言我这轮**仍然没跑成**,所以「浏览器里那行字依次显示什么」我还是答不了。**

**不是"没去跑",是两个独立的硬阻塞,都在本机可核:**

1. **本机那个包里没有启动器。** `dist/bundles/openmemo-0.6.0-linux-x64/` 里只有
   `app` / `ext` / `runtime` —— **`start.sh` 不存在**(`ls start*` 直接 No such file)。
   而这条腿按设计**必须走真实平台启动器**(不许退回 `node main.js`),所以起不来。
2. **本机没有网络。** `git pull` 报 `Could not resolve host: github.com`。
   而 B6 要**真的装一个后端包**才会产生阶段序列 —— 下载不了,序列就不存在。

⚠️ **这两条都不是"别人的红"**(你提醒的 `ffmpeg-lgpl-verify` lint 与 `extractJson`
我根本没跑到那一步)。**我没有把别人的红算成自己的结论,也没有把跑不到说成跑过了。**

⇒ **B6 / B6b / B7 / B6c 四条,至今 `[未验证]`。** 它们过了 `node --check`、prettier、eslint,
**仅此而已**。请在下一次真实的 `e2e-browser` 上看它们的红绿 —— 那才是答案。

## ② 解包 0% 已登记(提交 `a49bfd7`)

按我上轮给的方案、你已接受:**不做成会挡发布的断言**,改用 `KNOWN_DEAD` 那种**钉住集合**:

- 清单**之外**出现新谎话 → 红;
- 清单**之内**的被修好了 → **也红**(逼人回来划掉)。

登记条目 `unpacking-percent-resets-to-zero`,带齐了可直接开修的信息:
`lib/format/bytes.ts:32-37` 的 `formatPercent` 把 `null`/`NaN` **一律渲染成 0%**、
**没有"未知"这一档**;而 `installer.ts:79` 解包阶段**只给比例、不再更新字节计数**
⇒ 分子分母缺失 ⇒ `null` ⇒ 0%。用户看到进度**从 90% 多掉回 0%**,而实际正在解压。

⚠️ 一处刻意的保守:**采不到解压那一段时,既不算"已修"也不算"仍在"**,如实报"无从判断"。
否则一次没采到就会被误读成缺陷消失了,然后有人把它从清单里划掉 —— 那是这个机制最容易坏的方式。

## ③ `DownloadRow.tsx` 那条链:**我判断这轮守不了,如实登记为"没有腿"**

- B6 读的是 `/tasks` 的 DOM;`DownloadRow` 在 `/models` 上,走**另一套** `models.download.*` 词条,
  **上一路明说没有收敛进 `stepLabel.ts`**。
- 要守它得在 `/models` 上再跑一遍同样的阶段序列采样 —— 而**同一个 job 只会走一次**,
  两个页面要同时观测就得开两个标签页或在两页间来回切,
  **而切页会打断采样**(阶段是毫秒级的,切一次就可能整段错过)。
- ⇒ **我没有把它硬塞进来**。硬塞的结果是一条**随机红**的断言,
  比"明确说它没被守"更糟。

**所以明确写下:`DownloadRow.tsx` 的 `models.download.*` 渲染链目前没有任何腿在守。**
建议的正确修法**不是加断言,是把它也收敛进 `stepLabel.ts`** ——
那样 B6 守住的那一处就同时守住了它(**一份实现,一处断言**),
而不是给第二份实现配第二条腿。⚠️ 这条**归产品侧**,不是我这轮的产出。

## ⚠️ 仍未结案(第四次说同一句)

以上全部只解释「为什么他看到『正在安装』」与「中间那段界面在说错话」。
**没有解释一个 job 在 Windows 上真的长时间不推进。**
知道另有一路在验「Windows 边车替换 EPERM 让 daemon 退出(600 并发 7.3%)」——
**如果那条成立,"不推进"就是 daemon 死了**,那才是真前提。我没有碰它。

## 诚实标记

- `[实测]`:本机包里无 `start.sh`;DNS 解析失败;playwright 模块在
  `node_modules/.pnpm/playwright@1.62.1` 存在(所以**阻塞不是 playwright**)。
- `[未验证]`:B6 / B6b / B6c / B7 的红绿;那行字的实际序列。
- `UNKNOWN`:Windows 上 job 不推进的真因。
- ⚠️ **本轮的提交没有 push**(网络不通),`a49bfd7` 与上一条都只在本地。
  **请在网络恢复后由我或他人推送** —— 我不会用 `--amend`(你点名禁了,理由我认)。
- 未改产品代码;未碰 `:10000` / `/root/data-memo` / 机器级指针;未用 `pkill`;未建改删 release。

---

# 终于在浏览器里看到了 —— 但看到的东西推翻了这条腿的取证能力(2026-08-09)

**第一句直接答:`downloading` 期间那几个数字动没动 —— 我答不了,因为这条腿
根本没采到 `downloading` 那一段。**

## ① 那行字实际依次显示的是什么(第四次问,这次有答案了)

`[CI 实测 run 31314976975,真浏览器,只读 DOM]`

| 平台 | 界面上依次出现过的阶段文案 |
| --- | --- |
| linux-x64 | **`["正在安装"]`** |
| darwin-arm64 | **`["正在选择下载源"]`** |

**不是五步序列,是各自只采到一个,而且两个平台采到的还不是同一个。**

成因很清楚:这条腿装的是**5.3 MB** 的小包,`resolving/downloading/verifying/unpacking`
在 CI 上全部快到 200ms 采样窗口之间就过去了 —— 我上一轮担心的"采样能证伪不能证实"
**在这里被实测坐实了**,只是比预想更严重:**连 `downloading` 都没采到。**

## ② 三条断言的红绿 —— 全 PASS,**但其中两条是空过**

| 断言 | 结果 | ⚠️ 实际证据强度 |
| --- | --- | --- |
| B6 阶段文案合法 / 无 ASCII token / 无阶段倒退 | **PASS** | **弱**:只观测到 1 个文案就通过了。它守住了"不出现英文枚举值/不倒退",但**没有守住序列本身** |
| B6b 下载期 Toast 不含「安装」 | **PASS** | ⚠️ **空过**:判定条件是"当界面出现『下载中』时"，而**『下载中』一次都没出现** ⇒ 这条检查**从未真正执行** |
| B6c 已知谎话集合一致 | **PASS** | 自述"本轮没采到解压阶段，无从判断（不是通过）"—— **保守设定按预期生效了** |
| B7 llm 落地页有控件 | **PASS** | **强**:真的点了、真的检查了落地页控件 |

⇒ **只有 B7 是货真价实的绿。** B6 弱、B6b 空过、B6c 明确弃权。
**一条空过的断言与一条不存在的断言,证据力相同** —— 这正是我上一轮说的那句话,
现在轮到我自己的断言了。

## ③ `start.sh`:**本机构建问题,不是发布阻断**

`[实测·读码]` `writeLauncher()` 在 `build-bundle.mjs:1640` 被**无条件调用**,
且**不受 `--skip-archive` 影响**(`SKIP_ARCHIVE` 只管 `:1648` 的 `makeArchive()`)。

关键在**顺序**:`writeLauncher()` 排在 `assembleModels()`(`:1638`)与
`assembleSampleAudio()`(`:1639`)**之后** —— 而这两步要联网取东西。
本机当时**没有网络**,构建在那里中止,于是留下 `app`/`ext`/`runtime` 而**没走到写启动器那一步**。
产物目录的状态与这个中止点**完全吻合**。

旁证:另一路刚在 guard 腿里驱动过 macOS 真实的 `OpenMemo.command`。

⇒ **不是真缺,不用当发布阻断。** ⚠️ 但顺带留一句:**一次中止的构建会留下一个
"看起来像包、其实打不开"的目录**,而没有任何东西标记它不完整 —— 这本身值得单独治
(建议:成功时落一个 `.complete` 标记,或让 `verify-bundle.sh` 成为出厂必经)。**归产品侧,我没动。**

## ④ 你要的那一位(数字动没动):**这条腿现在测不出来,得先改取证方式**

按你的判断:`downloading` 在 1.66 GB 上是 28 秒 / 60 条事件,窗口足够宽 —— **同意**。
问题在于**这条腿装的是 5.3 MB**,那 28 秒根本不存在。

**所以要测那一位,必须先让被观测对象足够慢**,两条路(我倾向前者):

1. **装一个足够大的东西**(几百 MB 的模型/包),让 `downloading` 真的持续几十秒;
2. 或**在 `/api/models/pull` 上人为限速**(路由注入延迟),把窗口拉开。

**我没有实施** —— 它会显著拉长这条门禁腿的时长,**该由你决定用哪条、以及愿意为它付多少 CI 时间**。
⚠️ 而在测出这一位之前,**"只有标题不动、数字在走"与"数字也不动"仍然分不开**,
这条线索**不能定案**。

## ⑤ 仍未结案(第五次)

四个假设已排除(后端包路径、模型安装路径、SSE 客户端回填、边车 EPERM),
用户的现场描述又把"进程死了/网页打不开"也排除了。
**剩下的全部症状就是"信息没有更新"**,而**区分它是"已修的文案缺陷"还是"还有别的东西"
的那一位,正是上面测不出来的那一位。**

## 诚实标记

- `[实测]`:两个平台的实际文案序列、四条断言的红绿、`writeLauncher()` 的调用位置与顺序。
- `[未验证]`:`downloading` 期间百分比/字节/速度是否变化(**这条腿采不到**);
  win32-x64 那格本轮还在跑,我没拿到它的序列。
- `UNKNOWN`:用户那次"信息没有更新"到底是不是只有标题不动。
- 未改产品代码;未碰 `:10000` / `/root/data-memo` / 机器级指针;未用 `pkill`;未建改删 release。

---

# 三平台序列拿到了 + 限速做不干净 + 我自己的登记被实测打红(2026-08-09)

**第一句:`downloading` 期间那几个数字动没动 —— 仍然答不了。三个平台**没有一个**采到
`downloading` 那一段。**

**第二句:三平台完整序列(`run 31314976975`,真浏览器,只读 DOM)**

| 平台 | 界面上依次出现过的阶段文案 |
| --- | --- |
| linux-x64 | `["正在安装"]` |
| darwin-arm64 | `["正在选择下载源"]` |
| **win32-x64** | **`["正在选择下载源","正在解压"]`** |

**三个平台采到的都不一样,而且没有一个包含「下载中」。**
⇒ 你让我留意的"两平台文案不同是不是走了不同路径"——**现在有第三个数据点了:
三平台各不相同,而且是三种不同的组合。这更像采样时机的随机,不像路径差异**;
但**在把过程拉长之前仍然不能定论** `[未验证]`。

## ① 限速那条路我判断**做不干净**,理由(你说不坚持手段)

**下载发生在 daemon 里,不在浏览器里。** `[实测]` `apps/web` 侧
`features/models/api.ts` 全文没有任何镜像 URL / 直连下载 —— 前端只发
`POST /api/models/pull` 然后订阅进度。

⇒ **`page.route()` 拦不到它**:那是 playwright 对**浏览器**发出的请求做拦截,
而真正在下载的是**服务端进程**。要限速就得在 daemon 与镜像之间插一层
(改 daemon 的 fetch、或起一个中间代理),**那是在改被测对象本身**。

**所以我建议改用「装大件」那条**:不需要新机制,只是把这条诊断跑在一个几百 MB 的产物上,
让 `downloading` 真的持续几十秒。⚠️ 我**没有实施** —— 它要多下几百 MB,
**该由你决定用哪个产物、以及愿意为它付多少 CI 时间**。

## ② ⚠️ 我自己的 B6c 变红了,而且**它红得对** —— 但它在门禁里,要尽快处理

`[CI 实测 win32-x64]` **解包期间百分比文本 = `100%`,不是 `0%`。**

我最初按**读码**登记的是「掉回 0%」(依据 `formatPercent` 把 `null`/`NaN` 渲染成 0%)。
实测是 **停在 100%**。⇒ 真实形态是
**「解包期间百分比停在下载结束时的值、不再变化」**,不是归零。
**对用户仍然是假话**(正在解压却显示 100%),但**和我写下的那句话不是同一句**。

★ **这正是钉住集合该起的作用**:它当场变红,逼我回来把登记改成**实测的样子** ——
而不是让一条"读码读出来的、听起来很对"的描述长期占着位置。
⚠️ 反过来说:**如果我当初听从"断言它并让它红",红的会是产品,而实际上错的是我的描述。**

已把登记项改成 `unpacking-percent-frozen`,判据统一为
「解包期间百分比是不是一个**不随解压推进而变化的定值**」,0% 与 100% 都算命中
(同一个成因:解包阶段字节计数不再更新)。

⚠️ **`run 31314976975` 的 `conclusion=failure` 只来自这一条**,
**不是产品缺陷,也不是别人的红** —— 是我的登记与实测不符。改完之后应当恢复。
**但在下一次跑绿之前,`e2e-browser` 这条腿会挡住发布**,请知悉。

## ③ 残包标记已做(提交 `59e7e7e`)

`build-bundle.mjs` 一开始就在 STAGE 落 `.openmemo-build-incomplete`,
所有装配成功后、**归档之前**删掉;`verify-bundle.sh` 定位到包根后**第一件事**就查它。
⚠️ 按你说的**不做成清单式判断**:清单会漂,标记不会 ——
它只回答「这次构建有没有跑完」。

## ④ 仍未结案(第六次)

四个假设已排除;用户现场又排除了"进程死了/网页打不开"。
**剩下的症状仍然是"信息没有更新",而区分它的那一位仍然没测出来。**

## 诚实标记

- `[实测]`:三平台序列;win32 上解包期百分比 = 100%;前端不直接下载(故限速拦不到)。
- `[未验证]`:`downloading` 期间数字是否变化;三平台文案不同是随机还是路径差异。
- `UNKNOWN`:用户那次"信息没有更新"是否只有标题不动。
- 未改产品代码(残包标记属构建脚本守卫,你已允许);未碰 `:10000` / `/root/data-memo` /
  机器级指针;未用 `pkill`;未建改删 release。
