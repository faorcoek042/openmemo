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
