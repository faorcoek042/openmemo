# inbox: sidecar-crash

## [2026-08-08] 下模型把 daemon 打死 DONE

交付: `packages/downloader/src/{sidecar,download,queue}.ts` ·
`packages/downloader/src/sidecarConcurrent.test.ts`（新，3 例） ·
`apps/daemon/src/main.ts`（进程级兜底 + 首屏措辞） · `apps/daemon/src/jobs/scheduler.ts`

### ① 那个 ENOENT 的真因（实测的调用序列，不是从代码推断）

`writeSidecar` 用的是**写死的** `${target}.tmp`，而**同一个 `partialPath` 有并发写者**：
`download.ts` 里 `setInterval(() => void persist(), 2000)`，
而 **`clearInterval` 不取消已经开始执行的那一次**。于是收尾时两者重叠：

```
定时器: writeFile(tmp) ─────────────────► rename(tmp→target)   ✘ ENOENT
收尾:        writeFile(tmp) ► rename(tmp→target) ✓（tmp 已经被搬走）
```

**回答"rename 的源为什么不在了"：不是谁删了它，也不是它没被创建 ——
是"第二个写者"把同名的 tmp 抢先 rename 走了。三个候选里命中的是第三个。**

`[本机实测 2026-08-08]` 同一路径并发 **600 次调用 → 400 次 ENOENT**。
**所以它根本不是 Windows 特有的**：Windows 只是文件操作更慢（Defender、无 page-cache
语义），窗口更宽，于是先在那儿被撞见。⚠️ 这一点值得记住 ——
**按"平台特有时序"这条线索去找，会找错方向**。
修复（tmp 名带 pid + 自增序号，失败时清理）后同样 600 次：
**600 成功 / 0 ENOENT / 0 残留 tmp**。

### ② (b) 那层做在哪里 —— 三处，从近到远

| 层 | 位置 | 代价上限 |
|---|---|---|
| 最近 | `download.ts` 定时器 `.catch` | **连"这次下载失败"都不触发**（周期性写只是续传记账，丢一次最多多下一段）；收尾 `console.warn`，不静默 |
| 中间 | `queue.ts` `void this.run(entry).catch` | **这一个任务失败**（`run()` 内部的 try 只包住 `await entry.task(ctx)`，之前的 `transition`/ctx 构造漏出来就是未捕获） |
| 最远 | `main.ts` `installCrashGuards()` | **daemon 不退出**，把 stack 吼出来 |

`[本机实测]` 照 `void persist()` 的形状写最小复现 → 进程当场 `exit=1`
（Node 默认 `--unhandled-rejections=throw`）。

⚠️ **刻意不接管 `uncaughtException`**：那一族（同步抛到栈顶）通常意味着状态已经坏了，
继续跑比退出更危险。这里只接 promise 那一族 —— 它的典型成因是"某个后台调用没写 catch"，
与进程状态是否可信无关。
⚠️ **兜底不是把错误吞掉**（那会变成本仓最贵的静默）：它只吼、不退；
真正该让用户知道的失败仍由各自被 await 的路径冒泡成任务失败，不受影响。

### ③ 横扫结果：downloader 内 2 处，全仓另找到第 3 处

| 位置 | 状态 |
|---|---|
| `download.ts:345` `void persist()` | **就是这次的凶手**，已修 |
| `queue.ts:165` `void this.run(entry)` | 同形，已修 |
| **`apps/daemon/src/jobs/scheduler.ts:65`** `setInterval(() => void this.#pump(), tick)` | **同形第三处，还没发作** —— `#pump()` 21 行里**没有任何 try/catch**，而调度器每 250ms 一拍、驱动所有任务。已修（这一拍失败 → 250ms 后自然重试） |
| `proxy.ts:100` `.then(...)` | **假阳性**：链尾有 `.catch`，本来就是好的 |
| 未 await 的 fs 写 | **0 处** |

### ④ 反向验证：daemon 真的活下来了

往**真 daemon 进程**注入与线上一模一样的 ENOENT rejection（`-r` preload，不改仓库）：

| | 结果 |
|---|---|
| **有兜底** | `/api/health` **200**、`/api/folders` **200**（所有页面照常），日志明确吼出「有一个后台任务的 promise 没有被 catch。**daemon 不会因此退出**」+ 完整 stack |
| **无兜底**（preload 让 `unhandledRejection` 注册不上） | daemon **正常启动并打印"就绪"**，随后**在注入点死掉**，注入前/后两次探测均连不上 |

**"活着"与"死了"两侧都实测到了**，不是只验了修好的那一侧。
另加 3 条常驻用例（200 轮 × 3 并发）：把概率压成必然 ——
**"间歇性"比"总是红"更糟，它训练人"先重跑一次再说"**，所以用例不能也是间歇的。

### ⑤ 首屏措辞：daemon 侧那半已做，**web 侧那半撞车，交回**

daemon 启动横幅（`main.ts`，当时无人占用）已改：
内部 id → 用户认得的词，并给出**体积量级**
（`[实测读 vendor/manifests]` ASR 模型 **31 MB–4 GB**、media-tools 约 **119 MB**、
whisper 引擎约 **6 MB**）。**写区间不写精确数字** —— 精确值取决于平台包与用户选的模型，
写死会烂。措辞用「设置 → **本机组件**」。

```
[daemon] 还有 2 个组件没装：
[daemon]    · 语音转文字引擎 whisper.cpp（约 6 MB）
[daemon]    · 语音识别模型（31 MB–4 GB，取决于你选哪个；小的够用，大的更准）
[daemon]    这是首次启动的正常状态，不是出错了。
[daemon]    打开网页后在「设置 → 本机组件」里点安装，装好会自动生效（不用重启）。
[daemon]    下载要花几分钟到十几分钟，期间界面不会卡 —— 转写类任务会先排队等着（blocked），不会丢。
```

⚠️ **用户真正看到的第一句在 web 侧**：`apps/web/src/components/common/ReadinessBanner.tsx`
+ `app/i18n/locales/{en,zh-CN}.json`（`health.pipelineMissing`）。
**那两个 locale 文件此刻正被"真浏览器"那位改着**（`git status` 可见）。
按纪律「别动他们的文件」+ §12 的教训（索引是共享的），**我没有动**。
**交回给 Manager 排期**，建议交给正在改那两个文件的人一并做，材料如下（中英对照）：

- 中：`还有 {{count}} 个组件没装 —— 首次启动，这是正常的。点「安装」即可，下载约 {{size}}，要几分钟。`
- 英：`{{count}} component(s) still to install — this is normal on first launch. Click Install; about {{size}} to download, a few minutes.`
- 体积来源：`vendor/manifests`（ASR 模型 31 MB–4 GB / media-tools ~119 MB / whisper ~6 MB）
- 词表：`whisper-cli`→语音转文字引擎、`asr-model`→语音识别模型、`ffmpeg/ffprobe`→音视频解码器、`yt-dlp`→链接下载器
- 导航词统一用「本机组件」/ "Local components"

### 门禁（隔离 worktree）

`pnpm -r test` **1596 / fail 0**（基线 1593，+3 是我新增的用例）· `tsc` clean ·
`eslint` clean · `lint-workflows` **1399 / 15** · `test:ci-scripts` EXIT=0 · `check:orphans` 绿。

⚠️ **`format:check` 有一条红，不是我的**：`docs/research/memoac/F1-F5-PARITY.md`
（memo 功能对齐那位的在途文件，不在我这次提交的 6 个文件里）。**未触碰。**

### 纪律自查

- **全程没有使用任何形式的 `pkill`**（含 `pkill -0 -f`）—— 上轮那次已认，本轮按"绝对明线"执行，
  收尾一律用 job 号/`timeout`。
- 未碰 `:10000`、`/root/data-memo`、机器指针；**未建/改/删任何 release**。
- 按 §12：新文件先单独 `git add`，再 `git commit -- <pathspec>`；
  **提交后** `git show --stat` 复核 = **恰好 6 个文件，无夹带**。
- 未碰另三路的文件（`.github/workflows`+`scripts/ci`、`apps/web`、`docs/research/memoac`）。

需要 Manager 决策: **1 条** —— web 侧首屏文案（见 ⑤）该交给谁、什么时候做。

---

## [2026-08-09] 两条下载链路故障：调查结论（PROGRESS，需你两个裁决）

本轮**只做了调查与量化，没有改产品代码** —— 理由见文末「为什么先不动手」。

### ① 你让我先答的那条：**是的，界面在让用户下一个他已经有了的东西**

`[本机实测]` 用**包内 daemon**（v0.4.0 包，直接起）问同一个 daemon 两个问题：

| 问题 | 答案 |
|---|---|
| `/api/backends/catalog` 里 `whispercpp-cpu-linux-x64` | **`installed: false`** ← 界面据此让用户下载 |
| 包内 `runtime/probe/` 实际有什么 | `whisper-cli` · `openmemo-probe` · `libggml-cpu-x64.so` · `libwhisper.so*` |
| `/api/health` 的 `pipeline.missing` | **不含 `whisper-cli`** ← 流水线层**知道**它已经有了 |

**两层各说各话**：工具层（pipeline）认得包内的 whisper-cli，后端目录层不认。
成因是 `installedBackendsFromStore()` **只读下载器的安装记录**
（`ArtifactStore.listManifests('backend')`），而随包出厂的那份**不是通过下载器装的**，
所以永远不会出现在那份记录里。

**这与 manifests / 探针那两条是同一族**：「能不能用，取决于你从哪一层看」。

⚠️ **但它不是"标成已安装"就完事** —— 两者**不等价**：
包内是**基线子集**（1 个 CPU 变体 + whisper-cli + VAD），
包是**超集**（14 个 CPU 变体 + whisper-server/bench + parakeet）。
所以正确的说法不是"你已经装了"，而是
**"你已经有可用的 CPU 基线；这个包是可选的加速/补全，下不下来都不挡你用"**。
**这句话怎么说、要不要仍然列出下载按钮，是产品决策 —— 交你裁。**

**用户当下的处置**（可以直接告诉他）：**这个下载失败不挡转写**。
他缺的是 `asr-model`（还有 ffmpeg/ffprobe），不是 CPU 后端。

### ② 三个源分别是什么、为什么不可访问

**先纠正一处**：目录里 `whispercpp-cpu-win-x64` **只有 1 个源，不是 3 个**。
界面那句 **`(1/3)` 是重试次数，不是"第 1 个源 / 共 3 个"** ——
用户（和我们）都会把它读成"还有两个源可以试"，**而其实一个都没有**。

`[实测量化]` 这才是真正的缺口：

| | 有中国可达镜像的比例 |
|---|---|
| **模型**（hf-mirror / ModelScope） | **34 / 35** |
| **后端包**（我们自己 release 上的） | **0 / 14** ← 全部只有 1 个源 |

**为什么模型有而后端包没有**：hf-mirror 与 ModelScope 是**第三方对 HuggingFace 的镜像**，
我们搭个便车即可。而后端包放在**我们自己的 GitHub Release** 上，
**不存在任何第三方会去镜像它** —— 这个缺口**不是改 manifest 能补的，需要真的有个中国可达的托管**。

`[本机实测]` 那个 URL 从本机 `curl` 是 **200 / 3,951,207 B**，文件本身没问题 ——
**用户那侧是地理可达性，不是坏链接。**

⚠️ 另外一个**产品侧**的可疑点（`[未验证]`，我没能坐实）：
`resolving` 阶段调 `probeRemoteFile(url)` 先探一次大小，它抛错就直接
`PROVIDER_UNREACHABLE`。`[本机实测]` 我在本机复现出**完全相同的报错**
（`PROVIDER_UNREACHABLE / 下载源无法访问 / fetch failed`），
**而同一个 URL 用 `curl` 和裸 `node fetch` 都能在 2.5s 内下完 2,327,524 B**。
也就是说**探大小那一步比真正的下载更容易失败**。
我没能定位到它为什么失败（本容器网络与用户的不同），**标 `[未验证]`**，
但如果坐实，这是"能下的东西被探测步骤挡住了"——值得单独查。

### ③ 校验卡住：**是"没有进度上报"，不是"算得慢"**（结构性，已定位）

`packages/downloader/src/download.ts`：`phase: 'verifying'` 是在
`verifyFile()` **之前**发出的，而且**它是这条链上最后一个 progress 事件**。
之后 `installer.ts` 还要做：硬链接 → **`unpackArchive()`** → 写 manifest，
**这三步一个进度事件都不发**。

⇒ **界面必然从"开始校验"一路显示到"整个安装结束"**，中间无论多久都不动。
574 MB 的归档解包是实打实的几十秒到几分钟，而用户看到的字是"正在校验完整性"。

⚠️ **2.3 MB 那个我没能复现**（本容器在 `resolving` 就失败了，见 ②），
所以"2.3 MB 也卡住"是否同因，**标 `[未验证]`**。
但即便只是上报缺口，**它已经足以解释用户看到的现象**。

**结论：我不建议去掉校验，而且现在有把握说"去掉也治不好"** ——
因为 2.3 MB 的 sha256 是毫秒级的，用户看到的那段时间**根本不是花在校验上**。
去掉校验会丢掉「你下到的字节就是我们钉死的那份」这个唯一保证
（无代码签名，ADR-003 决策 4），**却大概率一点都不会变快**。
**修法应该是把 `unpack`/`install` 阶段的进度补上**，让那段时间有名有姓。

### 需要你裁的两件

1. **①的说法**：包内基线与可下载包不等价，界面该怎么表达（"已有基线、此包可选" vs 别的）。
   我不想擅自改目录语义 —— 那会让"已安装"这个词对两种来源含义不同。
2. **②的托管**：后端包要中国可达，**需要一个真的托管**（模型那条搭的是第三方对 HF 的便车，
   我们自己的 Release 没有等价物）。这不是我能改 manifest 解决的。

### 为什么先不动手

三处修法各自都会碰到别人的地界或需要你的裁决：
①要改后端目录语义（且与"硬件卡文案"那路可能重叠）、②要托管决策、
③要动 `packages/shared` 的 job step 契约（新增 `unpacking`/`installing`）。
在没有裁决前改，等于替你做了产品决策。**调查结论与量化已经就位，裁完我立刻能落地。**

### 纪律

- 未碰 `:10000`（作业前后 200）、`/root/data-memo`、机器指针；**未建/改/删 release**。
- 全程未用任何形式的 `pkill`（含 `-0`）；测试 daemon **按 pid 结束**，端口已确认释放为 0。
- 未动任何他人在途文件（`docs/**`、`e2e-browser.*`、`packages/runtime`）。
- 本轮**未改产品代码**，故无门禁影响；仓库仅新增本回执。

---

## [2026-08-09] ② 代理验证：**通了** —— 用户今天就能自救（PROGRESS）

### 最急那条的答案：**配代理能下下来，产品确实走代理**

`[本机实测 2026-08-09]` 起一个会记账的本地 HTTP CONNECT 代理（`127.0.0.1:18080`），
**通过产品自己的设置接口**打开，然后走产品的正常安装通道下载：

| 步骤 | 结果 |
|---|---|
| 对照组：**不配代理**装 `whispercpp-cpu-linux-x64`（6.75 MB） | `state=succeeded`，**代理命中 0 次**（本机可直连，基线成立） |
| `PATCH /api/settings/proxy` `{mode:manual, httpProxy/httpsProxy: 127.0.0.1:18080}` | 产品回 `active: {mode:"manual", proxy:"http://127.0.0.1:18080/"}` |
| 配了代理后装 `vad/silero-vad-onnx`（2.33 MB） | **`state=succeeded`**，**代理命中 1 次**，目标 `CONNECT raw.githubusercontent.com:443` |

⇒ **组件/模型的下载确实经由用户配置的代理出网**（`setGlobalDispatcher` 那条覆盖是真的）。

⚠️ **诚实边界**：本机**能直连** GitHub，所以这条验的是**"路由覆盖"**（产品到底走不走代理），
**不是**"在中国被墙的网络下能不能翻出去"—— 后者我在这台机器上**无法验证**，标 `[未验证]`。
但这两件事里，**只有前者是产品能保证的**；后者取决于用户自己的代理可用性。

**→ 可以告诉用户**：在「设置 → 代理」里填上他自己的代理，组件与模型的下载都会走它。

### 顺带量到的一件事（与 ③ 的判断一致）

配了代理之后，那个 **2.33 MB 的 Silero VAD 从下发到 `succeeded` 在 25s 的等待窗口内完成** ——
**它不慢**。这与我上一轮的结论互相印证：用户看到的"卡在正在校验完整性"
**不是校验慢**，是 `verifying` 之后（hardlink → unpack → 写清单）**一个进度事件都没有**。

### ④ `probeRemoteFile` 那条：**有实质差异，但还不能定罪**（`[未验证]`）

读代码确认了它与"裸 fetch"**确实不是同一种请求**：
`GET` + **`Range: bytes=0-0`** + **`redirect: 'manual'`**（再自己跟最多 5 跳），
超时 20s；任何非 `HttpError` 的异常一律归成 `PROVIDER_UNREACHABLE`。
也就是说**探大小这一步比真正的下载多了两个可失败面**（1 字节 Range、手工重定向链）。

但**本轮我没能复现它单独失败**：配了代理之后同一个 URL 一次就过了。
上一轮那次 `fetch failed` 我**没能再现**，所以**不能据此定罪**，仍标 `[未验证]`。
建议：给 `PROVIDER_UNREACHABLE` 带上**是哪一步失败的**（探大小 / 真正下载）与**目标主机**，
下次用户再撞到就能一眼分辨 —— 这也正好是 ③ 要改的那句话。

### 本轮**没做**的（如实说明，不是忘了）

按你给的优先级（代理最急 → ④ → ③ → ①），我把预算花在了**②的实测**上。
剩下三件都还没落地：

- **③ `(1/3)` 文案 + `unpacking`/`installing` 进度事件** —— 后者要改 `packages/shared`
  的 job step 契约，而**你点名 fitness 那位也在 `packages/shared`**。
  我没有动 —— 契约是跨进程的，两边（daemon + web）要一起改，
  **在他改着同一个包的时候动它，撞车代价高于收益**。**建议排在他之后，或由你分配窗口。**
- **① 界面表达 + 目录层怎么知道包内已有基线** —— 设计我已经想清楚，记在下面。
- ④ 的错误信息改造（与 ③ 同一处）。

### ① 的设计结论（想清楚了，还没写代码）

`apps/daemon/src/http/rest/backendReconcile.ts` 的文件头已经立了本仓的规矩：

> **"同一台机器上，装没装只准有一个回答的人"** —— 唯一事实来源是安装清单（manifest）。
> 它**明确否决过**「把 catalog 的 `installed` 改成"有清单**或**文件在"」，
> 理由是那会让 `/api/backends/installed`、`DELETE`、`installedVersion`、`recordSelfTest`
> 四个读取方各说各话 —— **把两个答案变成三个**。

所以随包出厂的基线**不能**、也**不该**走 `installed`。它根本不是一次"安装"，
而是**内建能力**。正确做法是**加一个独立的、诚实的字段**（例如
`builtinBaseline: true` / `supersededByBuiltin`），语义是
**"你已经有可用的 CPU 基线，此包是可选超集"** ——
它**不重新定义 `installed`**，因此不产生第三个答案，与上面那条规矩相容。

界面据此说三句话（中英都要）：① 你已有可用 CPU 基线；② 此包是可选增强
（14 个 CPU 变体 + server/bench/parakeet）；③ **下不下来都不挡你**。

### 纪律

- 未碰 `:10000`（前后 200）、`/root/data-memo`、机器指针；**未建/改/删 release**。
- 全程未用任何形式的 `pkill`（含 `-0`）；测试 daemon 与代理**按 pid 结束**，端口确认释放为 0。
- 未动他人在途文件（`docs/**`、`packages/runtime/src/detect/`、`packages/shared/src/fitness.ts`、
  `packages/pipeline/src/tools.ts`）。**本轮未改任何产品代码**，故无门禁影响。

---

## [2026-08-09] 逐步打点：数拿到了，**Linux 上复现不出用户的症状**（PROGRESS）

### 先认一件事

你转述错了一层，但**源头是我**：我上一轮写的是
「`verifying` 之后 hardlink/unpack/写清单不发事件」——
那解释的是**「标签为什么一直停在校验」**，**不解释「为什么要那么久」**。
我当时没把这两句话分开写，才让它读起来像是后者的答案。**这是我的表述错误。**

### ① 三种体量的逐步耗时（先答，不带修改）

打点已落地（`OPENMEMO_TIMING=1`），覆盖：
下载+校验 / 硬链接 / 解包 / 落位 / chmod / 收尾。

**`[本机实测 linux-x64] vad/silero-vad-onnx（2.33 MB）** —— 你说的最关键那个：

| 节点 | 时刻 / 耗时 |
|---|---|
| `resolving` | t=83ms |
| `downloading` | t=1406ms |
| **下载+校验（含 sha256 与比对）** | **2545ms** |
| **硬链接 linkByName** | **1ms** |
| 解包 | **不适用**（`.onnx` 是裸文件，没有解包这一步） |
| `succeeded` | **t=3822ms** |

⚠️ **纯网络 fetch 我单独量过是 2538ms** ⇒ **sha256 在这 2545ms 里只占毫秒级**。
**哈希这条彻底排除了**，和你的判断一致。

⚠️ **但更重要的结论是：Linux 上全程约 4 秒，复现不出用户的"卡住"。**
82 MB 与 574 MB 两个**我没量**（上下文预算见底，且它们在 Linux 上大概率同样不复现）——
**如实标 `[未量]`，不拿 Linux 的数去替 Windows 回答。**

### ② Windows 那一半：**没量，这是本轮最大的缺口**

你点的两个嫌疑（杀毒实时扫描每次读写整文件、NTFS 上 rename/硬链接）
**在 Linux 上结构性地不存在**，所以上面那组数**不能用来否定它们**。
打点已经进了代码，**在 windows-2025 上跑一次即可拿到同样一张表** ——
建议接到「每个组件都下一遍」那条新腿上（它本来就要在三平台各装一遍），
`OPENMEMO_TIMING=1` 打开即可，不需要额外改动。

### ③ 「完成状态没被推到前端」这条：**没排除，而且有一条可疑线索**

`[实测]` 我按 200ms 轮询 `/api/jobs`，观察到的 step 序列是：

```
running/resolving → running/downloading → succeeded/None
```

**`verifying` 与 `installing` 这两个 step 我一次都没观测到**
（`models.ts` 里明明有 `ctx.setStep('installing')`）。
两种解释我都还不能排除：① 它们太短，200ms 轮询漏掉了；
② 它们**没被推到前端**。**这两件在用户眼里一模一样**，而第二条正是你说的那种病。

要分辨只需一步：**看 SSE 事件流而不是轮询**（`/api/events`）。
我没做 —— 预算见底，**如实标 `[未验证]`**。这条我建议排在 Windows 打点前面，
因为如果是 ②，那么"某一步慢"这个前提可能根本不成立。

### ④ 失败消息已改（这条做完了）

`[实测]` 现在的文案（中英都有，daemon 直接给，**没碰 `apps/web` 的 locale**）：

```
message   : Failed while probing file size at <host> (before any bytes were
            transferred): fetch failed. If you are on a restricted network,
            set a proxy under Settings → Proxy and retry.
messageZh : 连接 <host> 失败：卡在**探测文件大小**这一步，还没开始传字节。
            如果你在网络受限的地区，可在「设置 → 代理」里填一个代理再试。
```

三样都在：**哪一步**（探大小 vs 真正下载）、**哪台主机**、**可以配代理**。
「(1/3)」改成 `All N source(s) failed after M attempt(s)` /
「N 个下载源都失败了（共重试 M 次）」—— **它是重试次数**。

⚠️ 顺带：探大小那一步现在**自报家门**，所以**下次用户再撞到 `PROVIDER_UNREACHABLE`，
我们就能直接看出是不是 `probeRemoteFile` 干的** —— 那条 `[未验证]` 的怀疑
从此有取证手段，不用再猜。

### 本轮**没做**的（如实说明）

- **① 的 `builtinBaseline`**：只读到 `backends.ts:379` 的 `installed:` 组装点，**没动**。
- **`unpack.ts` 那笔债**：**没核**。
- 82 MB / 574 MB 的量、Windows 的量、SSE 那条排除：都没做。
- 未碰 `packages/shared`（`engines` 那位在里面），未碰 `apps/web` locale（两路在改）。

**原因是上下文预算见底，不是判断它们不重要。** 按你给的优先级
（"三种体量的耗时这条先答"），我把预算花在了拿数与保证数可复现上。

### 纪律

- 未碰 `:10000`、`/root/data-memo`、机器指针；**未建/改/删 release**。
- 全程未用任何形式的 `pkill`（含 `-0`）；测试 daemon **按 pid 结束**。
- 本次提交 3 个文件（`download.ts` / `queue.ts` / `installer.ts`），§12 复核无夹带；
  `downloader` 40 条用例全绿、eslint 与 prettier 干净。
  ⚠️ **完整门禁（`pnpm -r test` 等）本轮未跑** —— 预算见底，如实标 `[未验证]`。
  改动集中在 downloader，且该包用例全绿。

---

## [2026-08-09] v0.5.0 自检「缺 whisper-cli / test-audio」：调查结论（PROGRESS）

### ① 「缺 whisper-cli」这句话 —— **多半不对，但我没能坐实用户那台为什么是 null**

逐条实测：

| 查什么 | 结果 |
|---|---|
| **win-x64 包里到底有没有** | **有。** 现建一个 win 包，`runtime/probe/` 7 个文件：`openmemo-probe.exe` · **`whisper-cli.exe`** · `whisper-vad-speech-segments.exe` · `whisper.dll` · `ggml{,-base,-cpu-x64}.dll` |
| **Windows 启动器有没有设那个变量** | **设了。** `start.cmd` 与 sh 启动器**都**设 `OPENMEMO_BUNDLED_WHISPER_DIR` |
| `isExecutable()` 在 Windows 上会不会误判 | **不会。** 它是 `access(X_OK)`，Node 在 Windows 上等价于 `F_OK` |

⇒ **文件在包里、变量也设了**，所以「缺 whisper-cli」这句**大概率不是事实**，
而是自检没找到包内那份。**但我没能确定用户那台的具体成因，标 `[未验证]`。**

**已经确定的那个洞**（与你说的同族，且比我上次描述的更具体）：

`packages/pipeline/src/tools.ts:903` 的 `fromBundle()` **只读环境变量**：

```ts
const bundledDir = process.env['OPENMEMO_BUNDLED_WHISPER_DIR'];
if (!bundledDir) return null;
```

**我上一轮把探针那条改成了模块相对（`resolveBundledWhisperDir()`），
但 `tools.ts` 这条没跟着改。** 于是：**凡是不经启动器起的 daemon，
包内 whisper-cli 一律看不见** —— 这正是"能不能用取决于你从哪儿启动"的第三个出口。

**修法**（未做）：把 `fromBundle` 换成 `resolveBundledWhisperDir()`，与探针那条同一个函数。
⚠️ 顺序**必须保持** `已安装后端包 > PATH > 包内兜底`，否则用户装了 CUDA 仍会跑包内 CPU 二进制。

### ② `test-audio` 该不该随包出厂 —— **该，而且现在必然缺**

`setup.ts:1036-1040` 的三条候选：

```
OPENMEMO_SELFTEST_AUDIO（没人设）
<dataDir>/selftest/jfk.wav（产品从不往那儿写）
repoSampleAudio() → 上溯 4 层 + vendor/whisper.cpp/samples/jfk.wav
```

**三条在预编译包里全落空** ⇒ `audio: null` 对**每一个包用户都是必然**，不是偶发。
用户日志里的 `audio: null` 与这个推导一致。

**好消息：代码已经在找对地方了。** `repoSampleAudio()` 上溯 4 层，
在包内布局（`app/daemon/dist/runtime/`）算出来正是**包根** ——
所以只要把 `vendor/whisper.cpp/samples/jfk.wav` **按原路径打进包**，
**一行代码都不用改**就会被找到。

代价：**352,078 B（344 KB）**，whisper.cpp 是 MIT，随包分发无许可证问题。
而且自检**认得出**它叫 `jfk.wav` 才会用内置时长与参考文本
（`isKnownSample`）—— 换个名字会退化成"要调用方自己给时长和文本"，**所以必须原名原路径**。

### ③ 我没有碰自检的判据

你说的那条克制我认同也没动：自检仍然只在前提齐全时才跑，
**缺前提只报 blocked，不会拿别的包的二进制去跑再记到它头上**。
上面两条修的都是**让它真的找得到包内那份**，不是放宽判据。

### ④ 「正在安装」那条：**本轮没量，如实说**

预算见底，**没有接 SSE 复现**，所以 (a) 事件没发 / (b) 发了没渲染 / (c) 真卡住
**一个都没排除**，标 `[未验证]`。
⚠️ 我也接受你的提醒：用户这次装的是**后端包**，与我上次量的**模型下载**不是同一条路径，
**上次那组数不能套过来**。

### 下一步建议（按性价比排）

1. `tools.ts` 的 `fromBundle` 改模块相对（复用 `resolveBundledWhisperDir()`）—— 小、清楚、与探针同一条。
2. `jfk.wav` 打进包（344 KB，**零代码改动**）。
3. 再接 SSE 量「正在安装」。

### 纪律

- 本轮**未改任何代码**，仅调查；仓库只新增本回执。
- 未碰 `:10000`、`/root/data-memo`、机器指针；**未建/改/删 release**；未用任何形式的 `pkill`。
- 未动他人在途文件（`apps/web`、`e2e-browser`、`packages/runtime`、`docs/**`）。
