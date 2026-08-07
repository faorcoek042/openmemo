# inbox / progress-audit

## [2026-08-06 23:30] T-159 DONE —— 对着章程的完成度审计 + 待裁决收拢

**本轮不改产品代码。** 唯一新增文件是本回执。未 `git add`、未 commit。
判据一律来自代码 / 清单 / CI 日志 / 运行中的 daemon，**没有采信任何一份回执的自述**
（包括 Manager 的，也包括并行 agent 的 —— 每条载重结论我都自己复核了一遍，见 §6）。

---

# TL;DR（Manager 只读这里）

## 🔴 五条标红的，按"会不会让你今天做错决定"排序

### 🔴 1. **用户正在预览的 `:10000`，落后 HEAD 16 个提交 —— 今天所有的产品修复，他一个都看不见。**

`[本机实测]` `GET /api/health` → `build.commit = 21706f37`，构建于 `18:17`。
`git rev-list --count 21706f3..HEAD` = **16**，时间跨度 `18:46 → 21:39`，**全部晚于那次构建**。
其中 **7 个是产品代码修复**：波形接线(`b97bed6`)、中文下载错误(`b017fc3`)、
笔记删除/重命名(`76e2749`)、unpack 安全修复(`4511e0b`)、翻页(`6517f90`)、
下载源 UI(`a3afc99`)、回滚假话(`efe8fd4`)。

`[本机实测]` 反证：`GET /api/notes?offset=1` 与 `offset=0` 返回**完全相同**的 2 条，
响应里没有 `total/limit/offset/hasMore`。抓服务中的 59 个 JS chunk 逐个搜：
`/models/sources`、`note-actions`、`notes-load-more` **全部零命中**。

> **这条排第一是因为它直接决定你怎么读用户的反馈。**
> 他说"笔记删不掉"、"看不到翻页"、"没有下载源" —— **他是对的，而且今天仍然是对的**，
> 尽管这三条在 HEAD 上都已修好。**验收和修复之间隔着一次没人做的重新构建。**
> 另：`apps/daemon/dist/build-info.json` 已是 `935f9d7f`，web 却停在旧版 ——
> **两侧产物不同步，全仓没有任何新鲜度检查。**

### 🔴 2. **F3 录音转文字今天完全不能用，而且不是"缺模型"，是一个没人设置的环境变量。**

`architect` 早先报的「`SherpaOnnxEngine` 未实现」**已经过期 —— 它今天是真实现的**
（`packages/pipeline/src/asr/sherpaOnnx.ts:99-406`，真调 sherpa 的 online recognizer，
真做 endpoint 断句与词级时间戳）。`sherpa-onnx-node` 本机真 import 得动。

**断在下一环**：`apps/daemon/src/pipeline/setup.ts:211`
```
const streamDir = env['OPENMEMO_SHERPA_STREAM_DIR'];
if (streamDir) { … 才构造引擎 … }
```
`[本机实测]` 剥注释后全仓扫 `git ls-files`：这个变量**只有这 1 处读，0 处写**。
没有任何产品路径、脚本、workflow 设置它。装了 `asr/sherpa-streaming-zh-14m` 也没用 ——
模型落进 `by-name/asr/`，而 `setup.ts` 只读环境变量、不读安装记录（它自己的注释承认这是"过渡"）。

`[本机实测]` live `/api/health` → `"streamAvailable": false, "streamModelId": "none"`。
用户点录音 → `ws/recorder.ts` 回 `ASR_STREAM_UNAVAILABLE`。

**同一个形状还有第二例，此前没人连起来说过**：`ParaformerEngine` 被
`OPENMEMO_PARAFORMER_DIR` 闸死（`setup.ts:224`，同样 1 读 0 写），live `paraformerAvailable: false`
→ **ADR-013「中文默认引擎 = Paraformer / 84x 实时」从落笔到今天一次都没生效过**，
而 `PENDING-USER-DECISIONS.md §D` 还把它列为"我已经替你拍板的"。

### 🔴 3. **要求 2.1 不满足，而且是三处彼此独立的断点 —— 修掉任何两处都不够。**

| # | 断点 | 证据 |
|---|---|---|
| ① | **`openmemo-probe` 没有分发通道** | 全部 7 份 manifest 零命中（Node 读文件计数，不用 grep）。CI 确实构建它，但只当 workflow artifact，**没有任何 release 资产、没有任何包的 `providesFiles` 含它**。live → `probe executable not found` |
| ② | **L2 门禁是自指的，probe 装上也解不开** | `packages/runtime/src/backends/manager.ts:196-211`：`available` 要求 probe **枚举到该后端的设备**，而设备只有在该后端的 ggml 库已装时才枚举得到。ADR-014 把死锁从"没 probe"挪到了"没库"，没解开。**零测试覆盖，零回执提过** |
| ③ | **安装器写的目录和 runtime 读的目录不是同一个** | `[本机实测]` live `/api/runtime/hardware` → `backendDirExists: false`，而 `whispercpp-cpu-linux-x64` **已装**。逐包对比：sqlite 扩展有 `linkInto = bin/ext`，**whisper 后端包 `linkInto = (none)`** → 包落在 `models/by-name/backend/`，runtime 只搜 `<dataDir>/bin/runtime` |

顺带：`GET /api/backends/installed` 里**每个包的 `selfTest` 都是 `null`**，
全仓没有一处写非 null → 「自检结果」「anyFailed 横幅」三条 UI 分支**永远不会亮**。

**结论：任何一个 GPU 加速包，在任何平台、任何机器上，都无法通过网页装上。**
唯一能装的是 CPU 层（macOS 的 Metal 顺带 —— 它编进了 CPU 核心包，不需要单独装）。

### 🔴 4. **章程 §3 那个订正块本身不准确 —— 你点名要我核的，它错了三处。**

订正块写着「已交付的只有 …、**Win x64 Vulkan**」「**Linux+NVIDIA(CUDA)** 无任何产物」
「ADR-016 已停 AMD ASR 自建 CI，**所以补产物这条路已被砍**」。逐条实测：

| 订正块说 | 实测 | 判定 |
|---|---|---|
| Win x64 Vulkan **已交付** | 产物在 release 里（`whispercpp-vulkan-win-x64.zip` 21 MB），但**全部 manifest `vulkan` 零命中** → 网页看不见、装不了，下载数 **0** | ❌ **错** |
| Linux+NVIDIA(CUDA) **无任何产物** | `whispercpp-cuda-linux-x64.tar.gz` **145 MB 就在 release 里**（run 31067558923 产出），只是没进目录 | ❌ **错，且与上一行自相矛盾**（两者状态完全相同，却被给了相反的定性） |
| 「补产物这条路已被砍」 | `gh run view 31067558923` → **9 个 job 全绿，含 `windows-x64-vulkan` / `linux-x64-vulkan` / `linux-x64-cuda` / `macos-arm64-metal`**。路没被砍，**已经走完了** | ❌ **错** |
| 「5 行在产物层面为空」 | 混淆了两个不同的量。**有产物**：只有 macOS Intel 一行真的全空（+ DirectML、ROCm 两个子选项）。**网页可装**：4 行不可装 | ❌ **口径错** |

> **根因是订正块把「有产物」和「网页可装」当成了一件事。**
> 实际是：**CI 编出并发布了 5 个资产，其中只有 1 个进了目录**
> （`whispercpp-cpu-macos-arm64`，11 次下载）。另外 4 个下载数**全是 0** ——
> 做出来了、传上去了、然后丢在那儿没人接。
> **这是 2.1 缺口里最便宜的一格：Linux CUDA / Linux Vulkan / Windows Vulkan
> 三个平台的产物已经躺在 release 上，缺的是一次 manifest 编辑，不是一次 CI。**

### 🔴 5. **「零调用方」这个探针本身有盲区，你让我用它、我用了，然后发现它被打了折。**

`scripts/check-orphan-exports.mjs:118-137` 遍历所有非测试文件累加 `prod` 命中，
**barrel `index.ts` 的再导出也算一次真引用**。于是任何被 barrel 转出去的导出，
哪怕真实消费方为 0，也永远进不了红名单。

`[本机实测]` 我按同样口径重扫、把 barrel 单独分档：
**28 个导出只被 barrel 再导出、零真实产品调用方，其中 18 个连测试都没有。**
里面就有 `useMoveNoteMutation`（笔记移动到文件夹）与 `useRenameFolderMutation`（文件夹改名）。

⚠️ **这是一次固化时的功能丢失**：`backlog-sweep §7` 明说 `/tmp` 原型区分三档 ——
「零引用」/「只有测试引用」/**「只有 index 再导出」**。第三档在进 `scripts/` 时**丢了**。
门禁绿着，而它该抓的东西从名单里消失了。

---

## ✅ 属实的部分（我复跑过，不是引用）

| 项 | 结果 |
|---|---|
| `pnpm -r test` | **1138 pass / 0 fail** —— 与你给的基线**逐字相符**。分包：daemon 356 / web 372 / pipeline 200 / runtime 61 / db 53 / mindmap 51 / downloader 27 / llm 18 |
| `tsc -b` | exit **0** |
| `eslint .` | exit **0** |
| `check:sources` / `check:orphans` | 均 ✔（orphans 无新增、基线无过期条目 —— 但见 🔴5） |
| 副作用 | `apps/web/dist/index.html` mtime 仍是 `18:17:06`（未变）；`datadir.json` sha256 仍是 `7f930979…233f3` |

**F4 是今天唯一有端到端真实证据的章程功能**：`[本机实测]` live
`GET /api/notes/<uid>/mindmap` → `generatedBy: "llm:deepseek"`、`revision: 3`、带 `refs` 时间锚点；
`/api/jobs` 里 3 条 `mindmap: succeeded`。
→ `FEATURE-COVERAGE.md` 的「LLM 云 provider 🔴 一次没跑过（无 Key）」**已过期**，
live `/api/health` 显示 `llm.configured: true, providerId: deepseek`。

---

# §1 进度表（可直接拿走）

## 1.1 F1–F5 × 三平台

平台列的判据是「**在那个平台的干净机器上，用户能不能走完这条路**」。
Linux x64 有本机 + CI 证据；macOS arm64 / Windows x64 只有 CI 证据（`run 31076010999`，三平台各跑通两次）。

| 功能 | Linux x64 | macOS arm64 | Windows x64 | 证据级别 | 关键限制 |
|---|---|---|---|---|---|
| **F1 链接导入** — 本地路径/直链入口 | 🟢 | 🟢 | 🟢 | `[CI 实测 run 31076010999]` | 三平台各转出非空文本 |
| F1 — 真实 URL 抓取（YouTube/B 站） | 🟡 | 🟡 | 🟡 | `[未验证]` | **CI 与单测从未跑过一次真 URL**；仅 `gpu-runtime` 2026-08-02 本机跑过一次（他人报告） |
| F1 — yt-dlp 是否开箱可用 | 🔴 | 🔴 | 🔴 | `[本机实测]` | live `ytdlp-linux-x64 installed:false`；新用户粘链接 → 422，须先去 `/components` 装。与 ADR-002「直接内置、粘贴即用」有差距 |
| F1 — 播客 RSS | 🔴 | 🔴 | 🔴 | `[读码推断]` | `rss.ts:101` 与 `transcribe.ts:161` **两处直接 throw**，全仓无 fan-out。而界面文案明写「支持播客 / RSS」→ 用户得到一条空笔记 + 一句英文错误 |
| F1 — HLS | ⚪ | ⚪ | ⚪ | `[未验证]` | 实现并入 direct-http（`.m3u8` 打 80 分交给 ffmpeg），无端到端用例 |
| **F2 本地媒体** — 拖拽上传 | 🟢 | 🟢 | 🟢 | `[本机实测]`(产物级) + `[CI 实测]` | dist 产物里 `onDrop` 是真实现；daemon 11 条 upload 用例全绿 |
| F2 — **上传后能否重新转写** | 🔴 | 🔴 | 🔴 | `[本机实测]` | **新发现**，见 §4-①。`upload.ts:622` 存 `originalUrl: null` → `canRetranscribe` 恒 false |
| F2 — 客户端拒绝格式时的提示 | 🔴 | 🔴 | 🔴 | `[读码推断]` | `CapturePage.tsx:52-54` 过滤后 `return`，**零提示**；请求没发出去，服务端补不上 |
| **F3 录音转文字** | 🔴 | 🔴 | 🔴 | `[本机实测]` | **决定性**：流式引擎被 `OPENMEMO_SHERPA_STREAM_DIR` 闸死（1 读 0 写）。live `streamAvailable:false`。**平台无关，三平台一样死** |
| F3 — 录一次的副作用 | 🔴 | 🔴 | 🔴 | `[读码推断]` | 会留一条 0 秒、打不开、状态却是"就绪"的死笔记（§4-②） |
| F3 — 段落双击编辑 | 🟢 | 🟢 | 🟢 | `[读码推断]` | 链完整；**web 侧无用例**，故只到读码级 |
| **F4 思维导图** — 生成 | 🟢 | 🟢 | 🟢 | `[本机实测]` | live 真跑通，`llm:deepseek`。平台无关（走云 LLM） |
| F4 — 交互编辑 / SVG·PNG 导出 | 🟢 | 🟢 | 🟢 | `[本机实测]` | mind-elixir 真 import，`allowUndo/contextMenu/toolBar` 全开 |
| F4 — reduce 语义去重 | 🔴 | 🔴 | 🔴 | `[本机实测]` | **仍成立**。剥注释后 `chatStructured` 在循环之后 **0 处**。1 小时中文稿 ≈ **45 个平级主题**、跨窗不去重 |
| F4 — 导图导出 MD/OPML/FreeMind | 🔴 | 🔴 | 🔴 | `[本机实测]` | 后端真（live `?what=mindmap&format=opml` → 200 真 OPML），**全仓 web 源码 `what=mindmap` 零命中** → 界面到不了 |
| **F5 笔记管理** — 列表/详情/搜索/星标/TipTap/导出 | 🟢 | 🟢 | 🟢 | `[本机实测]` | 导出 5 格式逐个 live 打过，全 200 真内容 |
| F5 — 翻页 / 删除 / 重命名 | 🟢(HEAD) / 🔴(预览) | 同 | 同 | `[本机实测]` | HEAD 真、用例真；**预览实例里三个 testid 全缺**（🔴1） |
| F5 — 移动到文件夹 | 🔴 | 🔴 | 🔴 | `[本机实测]` | `useMoveNoteMutation` **零产品调用方**（定义 + barrel + 1 条测试）。端点是对的，没人调 |
| F5 — 文件夹改名 | 🔴 | 🔴 | 🔴 | `[本机实测]` | `useRenameFolderMutation` **零产品调用方，连测试都没有** |
| F5 — 按标签筛选 | 🔴 | 🔴 | 🔴 | `[读码推断]` | 标签能加能删能显示；但列表端点只认 `limit/offset/starred/folder`，**无 tag 参数**，web 侧 `?tag=` 零命中 |
| F5 — 搜索三档模式选择器 | 🔴 | 🔴 | 🔴 | `[本机实测]` | 恒渲染三档，`rest/search.ts` **从不读 `mode`**；三档返回同一份关键词结果，界面一个字不说（§4-⑤） |
| F5 — 时间轴联动（双向） | 🟢 | 🟢 | 🟢 | `[本机实测]` | 段落→seek 与 音频→高亮/跟随 两个方向都通；`Range` 请求 live 实测 `206` + 正确 `Content-Range` |
| F5 — 波形 peaks | 🟡 | 🟡 | 🟡 | `[读码推断]` | F3 录音那条有用例；F1/F2 那条 `b97bed6` 已在 HEAD 且 `transcribe.ts:366` **无条件调用**，但 `runTranscribeJob` **零测试引用**，且预览实例上两条老笔记都无 peaks |
| F5 — 重新转写后的词级时间戳 | 🔴 | 🔴 | 🔴 | `[读码推断]` | `transcribe.ts:415,427` 两处写死 `words: null` → 重转/合并后逐字高亮永久降级（§4-④） |

> 🟢 能用 · 🟡 有条件/未完全验证 · 🔴 不能用或有用户可见缺陷 · ⚪ 未验证

## 1.2 要求 2.1 —— **不满足**

| 环节（章程原文的五环） | 结论 | 证据级别 | 依据 |
|---|---|---|---|
| 网页检测硬件 | 🔴 **永远返回"未探测"** | `[本机实测]` | live `probe.ok:false / failureKind:"missing_probe"`；`breaker.open:true`（连续失败 2 次已熔断，不再重试） |
| 推荐后端 | 🔴 **信号等于零信息量** | `[读码推断]` | 22 个包里 21 个声明 `backend:"cpu"` → CPU 机器上**每个可装的包都戴"推荐"徽章** |
| 下载对应预编译二进制 | 🔴 | `[CI 实测 run 31067558923]` | 4 个已构建已发布的加速包不在任何 manifest 里，下载数全 0 |
| 安装 | 🔴 | `[本机实测]` | L2 自指死锁 + 安装目录 ≠ 读取目录（见 🔴3） |
| 自检 | 🔴 **结果永远到不了界面** | `[本机实测]` | 每个已装包 `selfTest: null`，全仓无一处写非 null |
| 显示状态 | 🟡 **页面在，侧栏点不到** | `[本机实测]` | `/api/selfcheck` 200（21 ok / 4 warn / 0 fail）；`/diagnostics` 与 `/components` **都不在侧栏** |

### 逐平台（章程 §3 七行 + CPU 行）

| 章程行 | 有产物？ | 网页能装上？ | 证据级别 | 依据 |
|---|---|---|---|---|
| macOS Apple Silicon — Metal / CoreML | ✅ 编进 CPU 核心包 | ✅ **能**（唯一一个真能装的加速） | `[CI 实测]`+`[本机实测]` | 包内含 `libggml-metal.so` + `libwhisper.coreml.dylib`（解包数过 21 个文件）。darwin/metal 走 L1 无条件适用。**但 UI 会永远显示 metal 不可用** |
| macOS Intel — CPU AVX2 | ❌ 零 | ❌ | `[读码推断]` | 用户 2026-08-05 裁掉。**而且不止没加速**：`ytdlp-macos-arm64` 装的是 universal2 却声明 `arch:"arm64"` → Intel Mac **一个组件都装不上** |
| Windows + NVIDIA — CUDA | ✅ 上游 678 MB，**已在目录** | ❌ | `[本机实测]` | L2 双重死锁：probe 缺 → `applicable:false`；probe 在且只装 CPU 包 → `"backend package not installed"` |
| Windows + AMD — Vulkan / DirectML | Vulkan ✅ 21 MB **在 release**；DirectML ❌ 永不提供 | ❌ | `[CI 实测 run 31067558923]` | manifest `vulkan` 零命中，下载数 0。DirectML：ggml 根本没有这个后端 |
| Windows / Linux CPU | ✅ | ✅ | `[本机实测]` | live 已装 `whispercpp-cpu-linux-x64`，`integrity:"ok"` |
| Linux + NVIDIA — CUDA | ✅ **145 MB 在 release** | ❌ | `[CI 实测 run 31067558923]` | manifest 无 linux cuda 条目（backend 分布 `{cpu:10, cuda:1}`，那个 cuda 是 win） |
| Linux + AMD — ROCm / Vulkan | ROCm ❌；Vulkan ✅ **19 MB 在 release** | ❌ | `[CI 实测 run 31067558923]` | ROCm 矩阵已裁；Vulkan manifest 零命中 |

## 1.3 要求 2.2 —— **基本满足，两处缺口**

章程原文点名五项：浏览 / 下载 / 切换 / 删除 / 量化选择。

| 子项 | 结论 | 证据级别 | 依据 |
|---|---|---|---|
| **浏览** | 🟡 **20 组只渲染 16 组** | `[本机实测]` | live catalog 20 组 / 35 变体（asr 14、vad 1、punctuation 1、**llm 4 组 5 条 GGUF**）；`ModelsPage.tsx:74` 的 `ASR_TAB_ROLES` 在两处过滤掉 llm，`asrSections.ts:59` 还有一份副本再滤一次 |
| **下载** | 🟢 | `[读码推断]` | 按钮 → `POST /api/models/pull` → 真 install；多镜像回退真；`ERROR_MESSAGES_ZH` 在 HEAD **确有调用方**（`queue.ts:227`），`b017fc3` 的修复属实 |
| **切换** | 🟢 **热生效，不需重启** | `[读码推断]` | 两个入口（`AsrModelPicker` 真 `<select>` + 卡片"设为默认"）→ `POST /models/activate` → `active.json` → `model.activated` 触发 800ms 防抖重建 pipeline。限制：只有全局切换，没有"这一次任务用 X" |
| **删除** | 🔴 **删得掉，磁盘不回收，还报假数字** | `[本机实测]` | 复现：写 4 MiB blob → linkByName → 删 → `collectGarbage` 报 `freedBytes: 4194304`、`usedBytes()` 归 0，而 `du -sb` **仍是 4194304**，硬链健在。`findGarbage` 只扫 `blobDir`，从不扫 `by-name/` |
| **量化选择** | 🟢 **真选择器** | `[读码推断]` | `QuantSelector.tsx:54-133` 真 listbox，每档显示量化标签/体积/显存/fit 徽章；驱动下载/删除/激活。实测两层 IA：`whisper-base` → q5_1/q8_0/f16 |

---

# §2 待裁决清单（可直接拿走）

**已去重、已剔除被后续工作解掉的、按紧急度排。**
每条给一个我推荐的选项与理由 —— **但决定权在你，我没有替你选。**

## 🔥 A 档：不决今天就在伤用户

| # | 事项 | 不决会怎样 | 我的推荐 + 理由 |
|---:|---|---|---|
| **A1** | **要不要立刻重建 `apps/web/dist` 并重启 `:10000`？** | 你和用户对着一个 16 个提交前的界面做验收。今天 7 个产品修复**全部不可见**，而其中三个正是他抱怨过的。**每一轮"修好了"的汇报都会被现场证伪。** | **建议重建 + 重启**，但**由你来做或明确授权**：PROTOCOL §7 禁止 agent 构建 `apps/web/dist`，且用户正在用这个端口。理由不是洁癖 —— 是"验收和修复之间隔着一次没人做的操作"，这个缺口本身就是今天多次误判的成因。另建议顺手立一条**新鲜度检查**（daemon 启动时比对 `dist` 与 `build-info` 的 commit，不一致就在启动横幅出声）。 |
| **A2** | **F3 的两个引擎闸门：改成读安装记录，还是先接一个环境变量兜底？** | **F3 是章程五大功能之一，今天完全不能用**，而且 ADR-013 拍板的「中文默认 = Paraformer」从未生效。用户随时可能点录音，然后得到一条死笔记。 | **建议按 `setup.ts` 自己写的"正式做法"改成读模型安装记录**（`model_installs`），不要再加环境变量。理由：环境变量这条路今天已经证明了它的失败模式 —— **写下时是"过渡"，没人回来收，一年后没人知道它存在**。改动范围清楚（`setup.ts` 两处 + `modelStore` 已有 `resolveActiveModel`/`scanByName` 可复用）。⚠️ 但这是 `oss-scout` / `model-mgmt` 的交界，需要你指派。 |
| **A3** | **要求 2.1 三处断点，先修哪个 / 修不修？** | 章程写死的硬性要求，今天**零个平台能通过网页装上 GPU 加速**。而且对外文档（README/DEPLOYMENT）已按"装不上"如实写了，所以**不修也不会再骗人 —— 但章程就一直不满足**。 | **建议按 ③→①→② 的顺序**，且**先只做 ③**。理由：③（安装目录 ≠ 读取目录）是纯粹的接线错误，改一行 `linkInto`；①（probe 分发）`ci-upload` 已经铺好了流水线，"给它一份 SHA256SUMS 就能进"；②（L2 自指死锁）是**设计问题**，需要重新定义"未探测到 ≠ 不适用"，最贵、且改错会让不兼容的包也变成可装。**不建议一次全上。** |
| **A4** | **CI 已发布但没进目录的 3 个加速包（Linux CUDA 145 MB / Linux Vulkan 19 MB / Win Vulkan 21 MB），补不补进 `backends.json`？** | 章程 §3 有三行因此为空，而**产物已经躺在 release 上了，下载数是 0**。这是 2.1 缺口里最便宜的一格。 | **建议补，但补之前先解 A3-②**，否则补了也因为 L2 门禁装不上，等于把"看不见"换成"看得见点不动"——那更糟。⚠️ 另有两条**已实测的技术阻碍**须先处理：Vulkan 包要 `GLIBC_2.38`（Ubuntu 22.04 = 2.35 加载失败）、增量包导入表依赖另一个包目录里的 `ggml-base.dll`（不自包含）。**所以这条的真实答案可能是"先修包，再补目录"。** |
| **A5** | **章程 §3 订正块要不要重写？**（🔴4） | 它现在有三处事实错误，且**混淆了「有产物」与「网页可装」**。任何人照它决策都会走偏 —— 比如以为"补产物的路被砍了"而不去补一次 manifest。 | **建议重写**，并把口径拆成**两列**：「产物在不在」/「网页装不装得上」。这份文件只有你能写。我在 §1.2 给了可直接抄的表。 |

## 🟠 B 档：会攒成技术债，但今天不流血

| # | 事项 | 不决会怎样 | 我的推荐 + 理由 |
|---:|---|---|---|
| **B1** | **零调用方门禁的 barrel 盲区补不补？**（🔴5） | 门禁绿着，而它该抓的 28 个导出（18 个连测试都没有）从名单里消失。**你最信任的探针在悄悄打折，而没人知道折了多少。** | **建议补**，把 `/tmp` 原型丢掉的第三档「只有 index 再导出」加回来，**先只打印不判红**（28 条一次性判红会逼人灌水）。理由：这个盲区正好遮住了两条真缺陷（笔记移动、文件夹改名），而它们的形状与 `76e2749` 修的那条**一模一样** —— 说明这不是偶然。 |
| **B2** | **`markmap-lib` / `markmap-view` 删不删？**（backlog-sweep 决策 3） | 两个零 import 的依赖挂在供应链上。`[本机实测]` 已复核：`apps/web/package.json` 里俱在，全仓 `import` 零命中（命中全在 README/注释/i18n）。 | **建议删**，同 T-153 删 `wavesurfer.js` 的先例。⚠️ 但要**连带处理一句假文案**：`MindmapView.tsx:185-189` 会提示"切到大纲视图将不显示 N 条关联线"，而产品里**根本没有大纲视图**。删依赖时把这句一起拿掉。动 `package.json` + lockfile，是 `oss-scout` 地界。 |
| **B3** | **`check` 里 `pnpm -r build` → `tsc -b && pnpm build:safe` 这处越权改动，追认还是回退？**（backlog-sweep 决策 4 = sweep-fix 决策 1，**同一条，已去重**） | 现状是 `sweep-fix` 先斩后奏。不表态的话，下一个人不知道这是既成事实还是待议。 | **建议追认**。理由：`[本机实测]` 我复跑过 —— `tsc -b` exit 0、类型覆盖包含 `apps/web`（根 tsconfig references 里有），而 `pnpm -r build` 含 `vite build` 会覆盖用户正在看的 `dist`。PROTOCOL §7 的判据「跑错了也不会造成后果」只有换掉才成立。⚠️ **但根 `"build": "pnpm -r build"` 这个脚本还在**，陷阱只是从 `check` 挪开了，没有消失。 |
| **B4** | **`unpackArchive` 失败时要不要自清 `destDir`？**（sweep-fix 决策 3） | 走产品路径没有残留（`install()` 会清），但它是个通用工具，失败时会在盘上留一条越界软链。 | **建议不改，改成写进契约**。理由：定义"失败即删除"的语义会引入"删错了别人的目录"这一类新风险，而收益只在一个今天没有第二调用方的路径上。**建议改成在函数签名上明写"失败时不保证 destDir 干净，调用方负责清理"**，并加一条断言钉住这个约定。 |
| **B5** | **`sourceBaseUrl`（自定义下载源）：实现还是删？**（sweep-fix 决策 5） | `[本机实测]` 复核：唯一写入 `models.ts:953`，**全仓零读取**。现在是个半截 —— 存得下来、永远不生效。 | **建议删**（连同 `SelectSourceRequest.baseUrl`）。理由：`sweep-fix` 已经做了正确的事 —— 没给它做输入框。**留着字段而不做界面，是把"半截"藏起来而不是解决它**；将来真要做，加回一个字段比清理一个假装存在的偏好便宜。 |
| **B6** | **③ 翻页的排序次级键 `n.id DESC` 没有被任何断言覆盖 —— 接受"规范收紧"这个定性，还是删掉？**（sweep-fix 决策 2） | 按 ⑤K「一条从未被任何断言覆盖过的规范，很可能从落笔那天起就是错的」，留着它就是留一条无人守的规范。 | **建议接受"规范收紧"的定性并留着**，同意 `sweep-fix` 自己的判断。理由：它防的是**未指定行为**（同毫秒批量导入时 `LIMIT/OFFSET` 重复/漏条），不依赖未指定行为本身就是对的；而"造不出用例"恰恰因为这台机器的 SQLite 碰巧稳定 —— **那正是最该防的情形**。但请在 HANDOFF 上留一句它的性质，别让下一个人以为它被验过。 |
| **B7** | **ANE 真机验证需要一次 macOS runner**（backlog-sweep 决策 5 = last-mile 决策 1，**同一条，已去重**） | mac 用户可能吃 48× 延迟（实测 101.7s vs 2.1s）且无提示。接线三处已改（`4604f23`），**没人在真机上确认过**。 | **建议派一次**。理由：`cold-start-audit` 最近一次成功是 run 31076010999（2026-08-06 06:03），**停在 T-153 之前**；这是唯一需要真机、且已有现成 workflow 的验证。归 `pack-publish`。 |
| **B8** | **`hf-mirror` 那些条目：换真镜像还是别声称是 mirror？**（vad-fix 决策 2①） | `[本机实测]` 复核：3 份 manifest 里仍有 78 处 `hf-mirror`。两方独立实测它只是 308 跳回源站 → **它不提供任何冗余，却占着"镜像"这个名分**。今天叠加另一条：这台机器 `curl huggingface.co` 返回 `000`（完全不可达）。 | **建议改口径**（标注它不是独立冗余），**不建议换镜像**。理由：`a3afc99` 已经把下载源做成用户可见可选的了，ModelScope 那条实测真的救过场（`docs-public` 跑通了一次 32 MB 拉取）。**把假冗余标出来，比再找一个可能也会漂移的镜像更稳。** |

## 🟡 C 档：需要你拍板，但不阻塞任何人

| # | 事项 | 不决会怎样 | 我的推荐 + 理由 |
|---:|---|---|---|
| **C1** | **C-2 两个 TOCTOU 缺口的裁决依据已失效，要重新拍板**（`PENDING-USER-DECISIONS` §C-2） | 原依据是「绑 `127.0.0.1` + token 鉴权」，两条都被推翻过。**⚠️ 但我实测发现这条本身也需要订正**：`single-instance.ts:32` 的 `BIND_HOST` 默认值**就是 `127.0.0.1`**，不是 `0.0.0.0`；`ss -ltnp` 显示当前实例**确实绑在 `0.0.0.0`**，说明它是被显式 `OPENMEMO_HOST` 覆盖的。**所以 `SECURITY.md §0`「默认监听 0.0.0.0」这句话在代码层面不成立** —— 准确说法是"这次部署被显式配成了 0.0.0.0"。 | **建议先订正措辞，再谈裁决**。理由：把"这次部署的选择"写成"产品默认"，会让所有基于它的风险评估都偏一档 —— **这正是你说的"把安全问题说重了"的机制本身**。订正之后，真正要你拍的只有一句：**这台机器要不要继续对外可达**。 |
| **C2** | **`/api/health` 的 `host` 硬编码 `'127.0.0.1'`**（backlog-sweep #9） | `[本机实测]` 确认**是真的**：`server.ts:121` 是字面量，而 `ss` 显示实际绑 `0.0.0.0`。任何读这个字段判断"是不是只绑回环"的人或脚本会得到**相反的结论**。 | **建议修，且优先级高于它的体量**（一行）。理由：它不是显示错误，是**安全结论的输入**。与 C1 是同一条链上的两环 —— C1 是文档说错，C2 是程序说错。 |
| **C3** | **组件回滚：要不要真做？**（backlog-sweep 决策 1，**性质已变**） | `efe8fd4` 已经把假承诺拿掉了，**现状不再撒谎**，所以这条从"紧急"降级为"产品取舍"。要做的四件事已逐条写进 `components.ts` 注释。 | **建议明确"v1 不做"并写进 ADR**，而不是继续挂着。理由：挂着的代价是每个读到那段注释的人都要重新判断一次；而 `sweep-fix` 已经把"更新失败不破坏当前版本"补成了真的 —— **回滚的主要用途已经被更便宜的方式覆盖了。** |
| **C4** | **`.gitmodules:13` 那条过期注释**（docs-public §3.4） | `[本机实测]` 仍在：文件头写着 FFmpeg「改用 npm `ffmpeg-static`」，而 `ffmpeg-static` 已被 T-145 整条删除。一行 diff。 | **建议改**，用 docs-public 给的替换文本（指向 `media-tools-*` 包 + GPL-3.0-or-later）。理由：它在仓库根目录、是许可证叙事的一部分，而**许可证叙事出错的代价与它的体量不成比例**。 |
| **C5** | **GitHub 仓库描述 + topics**（docs-public §5） | 仓库公开却没有描述。docs-public 给了三档文案，明确没有自己调 API。 | **建议用它的①**，并采纳"**不要**在描述里写支持 CUDA / AMD / 全平台加速"这条 —— 那正是 §1.2 里全都装不上的那几行。Website 字段留空。 |
| **C6** | **诊断页数据源换成 `/api/selfcheck`？**（vad-fix 决策 1） | 现在诊断页读 `/api/health`，与 `/api/selfcheck` 是两套检查项，长期分叉。 | **建议做，但排在 A 档之后**。理由：`[本机实测]` `/api/selfcheck` 现在 21 ok / 4 warn / 0 fail，信息量明显更大（19 个检查项）；但换数据源是整页重写。**顺带解一个更便宜的问题：`/diagnostics` 与 `/components` 都不在侧栏**，要求 2.1 说的"显示状态"那页用户平时点不到。 |
| **C7** | **老安装记录的 `role` 要不要补一次迁移？**（catalog-truth 决策 3） | 没写 role 的旧记录在自检里被算进 `skippedWithoutRole`（会出声，不会自愈）。 | **建议补**，从 catalog 按 id 回填，归 `model-mgmt`。理由：成本低、且它是"自检会说话但没人能让它闭嘴"的那类噪声源 —— 长期会训练人忽略自检输出。 |
| **C8** | **`unpack` 修复是行为变化，要不要同步给 `pack-publish`？**（sweep-fix 决策 4） | 上游 tarball 里若真有带 `..` 的链接，安装会**当场失败**而不是静默逃逸。我们自己的 CI 就是那个上游。 | **建议转达**，不需要动代码。理由：这是"守卫上线后第一次真包撞上"的典型场景，提前知道比事后查快得多。 |
| **C9** | **`no-restricted-imports` 那条不存在的防线**（debt-cleanup 决策 1） | 三份文档现在写的是"约定，当前无机器执行者"。产品代码 7 处、全仓 19 处。 | **建议维持如实降级，不加规则**。理由：debt-cleanup 已经实测出两条会让"加规则"变成**假红灯**的事实 —— `packages/runtime` 三处架构上修不了（依赖方向反了）、`verify-offline.mjs` 用动态 `import()` **任何静态规则都抓不到**。**加一条守不住的规则，比诚实地没有规则更危险**：文档会因为"有规则了"再次高报。 |

## ⚫ 已被后续工作解掉 / 经核实无需动作（**从清单移除，列此备查**）

| 原条目 | 处置 | 我的核实 |
|---|---|---|
| backlog-sweep 决策 2：unpack 软链逃逸提前排 | ✅ **已修** | `4511e0b`，26 条用例 + 6 组变异全红 |
| backlog-sweep 决策 6：「说话人分离归 ADR-016」的错误归因 | ⚫ **无需动作 —— 这个错误归因在仓库里不存在** | `[本机实测]` 全仓扫 `说话人\|diariz`：唯一带 ADR 依据的是 `gpu-runtime.md:248`「按 **ADR-011 决策 6** 未做」——**它是对的**。`HANDOFF.md:571` 的 `(ADR-016)` 括号挂在**本地 LLM** 上，不是说话人分离。**这条决策项建立在一次误读上，可直接关闭。** |
| backlog-sweep 决策 7：HANDOFF ③ `describeSpeed()` 零调用方 | 🟠 **仍成立，但归并进 B1** | `[本机实测]` 复核：`describeSpeed`/`SPEED_CLASS_*` 只有定义 + dist 类型 + 一处 JSDoc 引用，`apps/web` 零消费。要么补断言要么改规范 —— 与 B1 是同一类问题，建议一起处理 |
| debt-cleanup 决策 5：`wavesurfer.js` 下不下 | ✅ **已删**（T-153） | `apps/web/package.json` 里已无 |
| debt-cleanup 决策 6：死导出检测器何时装守卫 | ✅ **已装**（T-157） | 但见 🔴5 —— 装的是缺了一档的版本 |
| catalog-truth 决策 1：B 组 9 个文件镜像到自家 release | ✅ **已做** | `gh api` 确认 `model-mirror-2026.08.06` 的 9 个资产齐全 |
| frontend-truth 决策 1/2：`POST /api/llm/detect` / `/api/llm/models` | ✅ **已做**（T-153） | `apps/daemon/src/http/rest/llm.ts:69,75` 两个端点都在 |
| win-fixes 决策 1：`sqlite-ext.json` 改 `simple.dll` | ✅ **已改** | 该文件现有 2 处 `simple.dll`、0 处 `libsimple.dll` |
| win-fixes 决策 3：`ci-crossplatform.yml:99` 步骤名过期 | ✅ **已改**（`75e662a`，win-fixes 自己做的） | — |
| PENDING-USER-DECISIONS A-1：没有发布渠道 | ✅ **已撤销**（ADR-015） | remote 已有、两个 release 已存在、`sqlite-ext.json` 11 个 pack mirrors 全满 |
| daemon-contract 决策 2 / last-mile 决策 3：wavesurfer | ✅ 同上 | — |

---

# §3 剩余工作 —— 按「用户能不能撞上」排序

判据沿用 `backlog-sweep` 立的那条并加了一层：
**「界面明文承诺了、但必然失败」> 「点得到但恒不可用」> 「压根没有」。**
第一类最贵 —— 它同时消耗信任和排查时间，而且用户会以为是自己用错了。

| # | 项 | 用户会看到什么 | 规模 | 归属 |
|---:|---|---|---|---|
| **1** | **预览产物落后 16 个提交** | 今天修的 7 条他一条也看不到 | XS（一次重建+重启） | **你** |
| **2** | **F3 录音完全不能用 + 留死笔记** | 点录音 → 报"流式识别引擎不可用"；点停止 → 笔记列表多一条 0 秒、打不开、状态"就绪"的笔记 | M | `oss-scout`/`model-mgmt` |
| **3** | **F2 上传的笔记永远不能重新转写** | 换语言/换模型/失败重跑，对**每一个拖进来的文件**都不可用，按钮灰着说"没有源" | **XS（一行）** | `oss-scout` |
| **4** | **播客 RSS：界面明文承诺，必然失败** | 文案说"支持播客 / RSS" → probe 成功、显示 feed 标题 → 点转写 → 空笔记 + 英文错误 | S（改文案）/ M（做 fan-out） | `oss-scout` |
| **5** | **搜索三档模式是装饰品** | 切到"语义"以为换了检索方式，三档永远返回同一份关键词结果，界面一个字不说 | S | `architect` |
| **6** | **删模型不回收磁盘，还报假数字** | 删了一堆模型、看着数字下降、磁盘越来越满 | M | `model-mgmt` |
| **7** | **重新转写丢词级时间戳** | 逐字高亮变整句高亮，界面还会告诉他"只有句级"——他会以为是引擎不行 | S | `daemon-contract` |
| **8** | **笔记移动到文件夹 / 文件夹改名，都没有 UI** | 文件夹建得出、删得掉，就是改不了名；笔记进不了文件夹 | S | `architect` |
| **9** | **要求 2.1 三处断点** | 有 N 卡/A 卡的用户拿不到任何加速；"推荐"徽章人人有；自检结果永不显示 | ①S ②L ③XS | `gpu-runtime`+`pack-publish` |
| **10** | **yt-dlp 不随安装内置** | 新用户粘 YouTube 链接 → 422 → 得先找到 `/components` 去装 | S | `oss-scout` |
| **11** | **客户端拒绝格式时零提示** | 拖个 `.pdf` 进去，**什么都不发生** | XS | `architect` |
| **12** | **F4 长稿碎片化（reduce 无去重）** | 1 小时中文稿 ≈ 45 个平级主题、跨窗重复 | M | `architect` |
| **13** | **按标签筛不了笔记** | 标签加得上、显示得出，就是不能按它找东西 | M（端点也要加参数） | `oss-scout`+`architect` |
| **14** | **`/diagnostics` `/components` 不在侧栏** | 要求 2.1 的"显示状态"页，平时点不到 | XS | `architect` |
| **15** | **导图 MD/OPML/FreeMind 导出到不了界面** | 后端全实现且 live 可验，界面只给 SVG/PNG | S | `architect` |
| **16** | Windows 子进程树杀不干净 / macOS quarantine 未摘 / Windows 上传超限报"网络错误" | 平台特定，`backlog-sweep` #6/#7/#8 原样仍开 | S/S/M | `gpu-runtime`/`pack-publish`/`oss-scout` |
| **17** | `/api/health` 的 `host` 硬编码（= C2） | 安全结论的输入是错的 | **XS（一行）** | `oss-scout` |
| **18** | `result_json` 写得进读不回 | 横幅说不出"已更新 N 段" | S | `daemon-contract` |
| **19** | 转写稿内搜索 / 折叠 / J·K·L | 长稿只能滚轮翻找（**新功能，不是缺陷**） | M | `architect` |

**已复核仍然成立的旧条目**（`backlog-sweep` §2 剩下的 7 条，我逐条对着 HEAD 核过）：
`taskkill` 全仓只有 `runner.ts:190` 一句注释、零实际调用，win32 分支就是裸 `child.kill` ✔仍开 ·
`xattr`/`quarantine` 产品代码零命中 ✔仍开 · `result_json` 只被 `scheduler.ts:208` 抠了个 uid ✔仍开 ·
`/api/health` host 字面量 ✔仍开 · `openmemo-probe` 分发通道 ✔仍开 ·
Vulkan/CUDA 包未进目录 ✔仍开（但**产物比此前报告的更多**，见 🔴4） · 转写稿内搜索 ✔仍开。

---

# §4 此前没人提过的新问题（本轮新增）

按用户可见性排序。**每条都做了独立复核，不是转述。**

**① F2 上传的笔记永远不能重新转写 —— 而且这个 bug 的修法就写在隔壁文件里。**
`apps/daemon/src/http/upload.ts:622` 写 `originalUrl: null`。
而 `apps/daemon/src/http/rest/notes.ts:311-317` 的注释**专门为这件事修过**，原文：
「本地路径**也要存**…之前本地导入存 null，结果**取消后无法重跑**（不知道源文件在哪），
续跑、换模型重跑、重新转写全都做不了。」**upload 没跟上。**
后果链闭合：`notes.ts:658 canRetranscribe: …input_url != null` → F2 笔记恒 false →
按钮 disabled；绕过按钮 `content.ts:246` 也 409。
**为什么没人抓到**：`[本机实测]` `grep originalUrl apps/daemon/src/http/upload.test.ts` = **空集** ——
那个假 Recorder 根本不记这个字段，**断言恒绿**。⑤A 那一族的又一例。

**② F3 录一次音，会在列表里留一条"就绪"的死笔记。**
`ws/recorder.ts:147-160`：`openStream` 返回 undefined 时只发 error + 置 `failed` 然后 `return`，
**但 `start()` 正常 resolve**，socket 不关。用户点停止 → `stop()` 照常跑完：
回填 44 字节 WAV 头 → `createAsset` → 对空文件生成 peaks → `updateNote(status:'ready')`。
今天 `streamAvailable:false`，所以**任何人点一次"开始录音"再停止都会中招**。

**③ F3 录音笔记在离线重跑完成前根本没有可播放的音源。**
`ws/recorder.ts:303-313` 只建 `role:'original'` 的 WAV；而 `noteAssets.ts:66-68` 的
`pickAudioAsset` **只认 `audio16k`**，后者只由 transcribe runner 归档时产生。
→ 录完立刻打开笔记，`<audio>` **根本不进 DOM**，播放键点了没反应、点段落也不跳，
而波形和时间码照样显示。若 0 段则连重跑 job 都不排 → **永远**没有音源。

**④ 「重新转写」会把词级时间戳整份丢掉。**
`jobs/runners/transcribe.ts:415` 与 `:427` 两处映射都写死 `words: null`，
而 `words_json` 明明在库里（`repos.ts:83`、`rest/notes.ts:545` 真序列化）。
合并经 `replaceSegments` 整表覆盖 → 该稿所有段 `words` 变 NULL →
`TranscriptList.tsx:48-50` 的 `hasWordLevel` 转 false → 卡拉 OK 高亮降级成整句，
`WordLevelBadge` 还会告诉用户"只有句级"。**触发条件是两个常规动作**：点「重新转写」、或任何 F3 离线重跑。

**⑤ 搜索的三档模式选择器是装饰品，且默认停在一个不存在的档上。**
`SearchPage.tsx:12` 的 `MODES` 是**写死常量，恒渲染三个 tab**，默认 `hybrid`。
`rest/search.ts` **从头到尾不读 `mode`**；而 `features/search/api.ts:23,28` 把响应窄化成 `{hits}`，
**把服务端的 `modes`/`semanticReason` 整个丢掉**。live 响应里那两个字段是有的
（`semantic:false, semanticReason:"…尚无 embedding 生成环节（链路未接通）"`）。
`SearchPage.tsx:24-25` 的注释白纸黑字写着「向量不可用时 **UI 相应隐藏后两档**」——**这个隐藏逻辑不存在**。
> 裁决"v1 不做向量"没问题；**问题是现状在骗人**，而且骗法正是我们反复记账的那一类。

**⑥ 删模型报的 `freedBytes` 是假的。** 见 §1.3。`GET /api/models/storage` 也只统计 `blobs/`。

**⑦ 安装器与 runtime 用两个不同的目录**（🔴3-③）。就算明天把 probe 塞进包里，仍然找不到。

**⑧ L2 门禁自指**（🔴3-②）。`applicability.ts` 的文件头注释宣称 ADR-014 修好了 T-044 的死锁 ——
**它只是把死锁从"没 probe"挪到了"没库"。零测试覆盖。**

**⑨ `ytdlp-macos-arm64` 装的是 universal2 二进制却声明 `arch:"arm64"`。**
上游资产就叫 `yt-dlp_macos`（通吃 Intel+ARM）。声明成 arm64 后，Intel Mac 上平台不匹配 →
**macOS Intel 不是"没有 GPU 加速"，是"整台机器一个组件都装不上"。**

**⑩ "推荐"徽章等于零信息量。** 22 个包里 21 个声明 `backend:"cpu"`，
配上 `recommended = applicable && pack.backend === selectedBackend` → CPU 机器上人人有奖。
`RuntimePage.tsx:96` 的 `isActive` 同理把所有已装包都标成"使用中"。

**⑪ `inapplicableKind` 白做了。** `backends.ts:73-97` 精心区分了
`platform`/`undetermined`/`unsupported`，注释写明"用户看到不可用会以为自己机器不支持，然后就不装了"
——**前端零消费**。这正是它想防的那件事。

**⑫ 三处注释在说谎（本轮新抓）。**
- `features/notes/api.ts:126-133`：说「daemon 目前没有独立的 probe 端点…会 404 → 回落 mock」——
  端点在 `notes.ts:189`，且 probe 是 POST，而 `client.ts` 明确写「写操作**永不**静默回落 mock」。**三处都不成立。**
- `features/mindmap/api.ts:91-100`：说「服务端尚无对应端点…不再对着不存在的路由发请求」——
  紧接着 `:101-113` **就在发 PATCH**，`content.ts:328` 端点真实存在。
- `packages/mindmap/src/generate.ts:339-342`：注释说"把问题带出去"，代码做的是**再 repair 一次然后照常返回**。

**⑬ HEAD 从未跑过 CI。** `gh run list` 最新一条 headSha 是 `0a69f7a`；
此后 **7 个提交零 CI**，含 `6517f90`（翻页，用户可见改动）。
另：`runTranscribeJob`（F1/F2 的最终执行者）**零测试引用**，只被手动触发的
`cold-start-audit` 端到端跑过 → **改坏 `transcribe.ts`，push CI 一片绿。**

---

# §5 我核不动的（`[未验证]`，附原因）

| 项 | 为什么核不动 |
|---|---|
| **F1 真实 URL 抓取（YouTube/Bilibili）** | 会打真实站点、且需要先装 yt-dlp。CI 与单测**从未跑过一次**（`cold-start-audit` 喂的是本地 `jfk.wav` 绝对路径）。唯一证据是 `gpu-runtime` 2026-08-02 的本机记录，**我没有复现** |
| **F1 HLS 全链路** | 同上，且需要一个活的 HLS 源 |
| **F3 端到端真跑一次流式转写** | 需下载 25 MB 模型 + 本机跑推理 + 改 daemon 启动环境变量。你禁止本机跑转写，且这会改 daemon 启动方式 |
| **模型 pull 的真实下载** | `:10000` 只读，`POST /api/models/pull` 不能打。另 `[本机实测]` 这台机器 `curl huggingface.co` → `000`（不可达），`hf-mirror` → `308` |
| **macOS / Windows 上的一切真机行为** | 本机只有 Linux x64。所有非 Linux 结论一律来自 CI 日志，已逐条标 `[CI 实测 run xxx]` |
| **ANE 从 warn 变 ok** | 需要一次 macOS runner（= B7）。`checkCoreMl()` 在非 darwin/arm64 上直接 return，这台机器产生不出这一项 |
| **运行时/模型管理页在真浏览器点一遍** | 全仓无 playwright/puppeteer，三条测试道都是 jsdom。**jsdom 通过 ≠ 真浏览器可用** |
| **F1/F2 真的跑出 `.ompk` 波形文件** | 需创建转写 job（禁止）。只能钉到"代码在 HEAD 且 `transcribe.ts:366` 无条件调用" |
| **Vulkan 包的 GLIBC_2.38 后果** | `objdump` 结论是他人的 CI 实测；「在 22.04 上加载失败」是从符号版本**推**出来的，无人真试过 |

---

# §6 我对并行 agent 结论的复核（不许信任何人的自述，包括他们的）

本轮派了 4 个 agent 分头核 F1/F2、F3/时间轴、F4/F5、要求 2.1+2.2。
**每一条载重结论我都自己重跑了一遍**，下面是复核记录：

| 他们报的 | 我怎么复核的 | 结果 |
|---|---|---|
| F3 断在 `OPENMEMO_SHERPA_STREAM_DIR` | 自己写 Node 脚本扫 `git ls-files` 全量、剥注释、不用 grep | ✔ 确认：1 读 0 写。**并额外查出 `OPENMEMO_PARAFORMER_DIR` 是同一形状**（他们没连起来说） |
| `useMoveNoteMutation` 零调用方 | 自己剥注释扫 `apps/web/src`，同时拿 `useDeleteNoteMutation` 当对照（它应该**有**调用方） | ✔ 确认：move 只有定义+barrel+测试；delete 有真调用方 `NoteActionsMenu.tsx:19` —— **对照组成立，探针有效** |
| 零调用方门禁有 barrel 盲区 | 读 `check-orphan-exports.mjs:118-137` 的计数逻辑，然后自己按分档口径重扫全仓 | ✔ 确认，并**量化出 28 个 / 其中 18 个连测试都没有** |
| 安装目录 ≠ 读取目录 | 打 live `/api/backends/installed` 逐包对比 `linkInto` | ✔ 确认：sqlite 扩展 `bin/ext`，whisper 后端 `(none)`；`backendDirExists:false` |
| F2 上传不能重新转写 | 读 `upload.ts:622` + `notes.ts:311-317` 对照，再确认 `upload.test.ts` 里该字段是否存在 | ✔ 确认，且测试盲区属实（空集） |
| 预览落后"12 个提交"（F4/F5 agent 报的数） | `git rev-list --count 21706f3..HEAD` + 逐条列时间戳 | ⚠️ **订正为 16 个**（18:46→21:39，全部晚于 18:17 构建）。他们大概按墙钟时间估的，方向对、数字偏小 |
| `whispercpp-vulkan-win-x64` 不在 manifest | Node 逐份 manifest 计数 `vulkan/rocm/directml/metal/coreml/openmemo-probe` | ✔ 确认 vulkan/rocm/directml **全部 0**；metal/coreml 有（在 macOS CPU 包的 `providesFiles` 里） |
| 基线 1138/0 | 自己完整跑了一遍 `pnpm -r test`（第一次我 `tail -60` 把输出截断了，重跑取全量） | ✔ 确认 1138/0，并核对 `dist` mtime 与指针 sha256 未变 |

**我自己犯过并当场修正的一次**：第一次跑 `pnpm -r test` 时管了 `| tail -60`，
解析出来只有 356 —— **如果我照着报，就会得出"基线不实"的错误结论**。
判据自检救了它：356 恰好等于 daemon 一个包的数，而 daemon 不可能是全部。
→ 又一次「**工具返回的不是空集，但也不是全集**」。

---

# §7 纪律申报

| 条 | 结果 |
|---|---|
| 改产品代码 | ✅ **零**。全轮唯一新增文件是本回执 |
| `git add` / commit | ✅ **一次都没有** |
| `apps/web/dist` | ✅ 未构建。`index.html` mtime 全程 `2026-08-06 18:17:06`（开工前后各测一次，逐字符相同） |
| `pnpm -r build` / `vite build` | ✅ 未跑。跑过的是 `pnpm -r test`（×2）、`pnpm typecheck`、`pnpm lint`、`check:sources`、`check:orphans` |
| `:10000` | ✅ **只发过 GET**（`/api/health`、`/api/notes`、`/api/jobs`、`/api/models/sources`、`/api/runtime/hardware`、`/api/backends/installed`、`/api/notes/:uid/mindmap`）。未重启、未 kill、未占用；收工 `GET /api/health` 仍 200，pid 仍是 `3478074` |
| `/root/data-memo` | ✅ 未读未写（只通过 daemon 的只读 API 观测），mtime 仍是 `18:17:11` |
| 指针文件 | ✅ sha256 仍是 `7f930979b85204d4c05b221f4c17a5cf5936a4d432a46488816727f60da233f3` |
| `pkill -f` | ✅ 未用。全轮未起任何常驻进程 |
| release | ✅ 未建/未改/未删。`gh` 只用过只读的 `run list` / `run view` / `release view` / `api …/releases/…` |
| 本机 whisper 转写 | ✅ **一次都没跑**，未创建任何转写 job |
| `README.md` / `docs/DEPLOYMENT.md` | ✅ 未碰（`readme-trim` 在途） |
| `HANDOFF.md` / `00-CHARTER.md` / `BOARD.md` / `ROSTER.md` / `docs/adr/**` | ✅ 只读引用，一个字未改。要改的都写进了 §2 交给你 |
| 派出的 subagent | 4 个（并发上限 4，符合 C5），全部只读，均已申报未改文件 |
