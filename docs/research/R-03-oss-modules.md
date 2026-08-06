---
id: R-03
author: oss-scout
status: superseded
date: 2026-08-02
superseded-date: 2026-08-06
superseded-by: ADR-002 v2 · ADR-003 决策 1
retained-sections: §3（许可证风险分级矩阵）· §4（FFmpeg LGPL 专题）· §5（yt-dlp 分级）
---

# ⚠️ 本文状态：`superseded`（2026-08-06）—— 但 §3 / §4 / §5 必须保留

> **此前本文标 `status: ready`，被当作现行选型依据引用。** 现改标 `superseded`。
> **正文一行未删**，因为其中三节是全仓唯一来源（见下）。读本文前请先看清哪些前提已经不成立。

## ❌ 已不成立的前提（不要照本文的技术栈做事）

| 前提 | 出现位置 | 真实情况 |
| --- | --- | --- |
| **技术栈 = Tauri v2 + Rust crates**（rusqlite / Symphonia / rubato / tokio / `reqwest` + `feed-rs`） | `:24`（D11 选型）、`:25`（sidecar 论证）、`:88`（【B】包管理器分类）、§1/§2/§7 各处 | **仓库里零行 Rust**：`find . -name "*.rs"` → **0**，`find . -name "Cargo.toml"` → **0**。**ADR-003 决策 1 改为 Node daemon + 浏览器 SPA（web-first）**，Tauri 外壳被 `PENDING-USER-DECISIONS.md` D 节裁决为"后置" |
| **红线 1：`ffmpeg-static` npm 禁用** | `:379`（§3 表）、`:567`（§6.1 表第 1 行） | **ADR-002 v2 明文 ✅ 允许使用**（个人自用档）。当前依赖里确实没有它，但删除理由是 T-145 的"减少第二条依赖通道"，**不是本条红线** |
| **红线 4：不得捆绑 yt-dlp 官方 release 二进制** | `:380`（§3 表）、`:570`（§6.1 表第 4 行） | **已被推翻且已发货**：`ADR-002:14,23`「F1 **直接内置** yt-dlp，不做双路径区分」；`vendor/manifests/backends.json` 里 `ytdlp-{linux-x64,linux-arm64,macos-arm64,win-x64}` 4 个包全部指向 yt-dlp 官方 release |
| **「yt-dlp 做成默认关闭的可选插件，默认路径走 RSS/直链」** | `:21`（TL;DR）、§2 D1 推荐（`:105-108`）、§5.4 | 同上 —— 已改为直接内置 |
| **「不要用 `youtube-dl-exec`」** | §2 D1 表（`:105-108`） | 该依赖**曾被真的引入过**，后于 T-145 删除（见 `packages/pipeline/package.json:27` 的 `_comment:removed-deps`：`youtube-dl-exec (^3.1.9) 已删除`）。红线曾被违反后自愈 |

> 另外两条红线（`--enable-nonfree` / `--enable-gpl` 的 FFmpeg 构建）**未被推翻，仍然有效**。

## ✅ 仍然有效，且是**全仓唯一来源** —— 不得删

这三节已实测确认在 `docs/adr/*.md` + `docs/design/*.md` + 其余 `docs/research/R-0*.md` + `docs/SECURITY.md`
里**没有第二份**（搜 `许可证矩阵|LGPL|GPLv3|Unlicense|MereAggregation` 共 9 条命中，
逐条看下来全是裁决表、一句话结论或架构图标签，无一含分析）。`vendor/README.md:33` 还在引用本文。

| 节 | 内容 | 为什么独家 |
| --- | --- | --- |
| **§3** | 36 行**许可证风险分级矩阵**，含 `@blocknote/xl-*` / Moonshine 非英语模型 / Meilisearch EE / ten-vad 非竞争条款的**原文引用** | `ADR-002:22-23` 只是 allow/deny 裁决表，无分析；`license-report.md` 是 npm 依赖清单，不含二进制 |
| **§4** | **FFmpeg 专题**：LGPL vs GPL 的构建分界、FSF `#MereAggregation` 官方 FAQ、预编译源可得性调查 | 全仓无第二份 LGPL 分析 |
| **§5** | **yt-dlp 分级**：README 分层许可证（仓库/PyPI = Unlicense，release 二进制 = GPLv3+）、OLG Hamburg 2024 判决、Apple 5.2.3 | 全仓无第二份 |

> 注意：§3/§4/§5 的**事实与分析**有效；其中若干**行动建议**（"禁止"/"不随产品分发"）已被 ADR-002 v2 放行，
> 上表已逐条标出。**读结论看 ADR-002，读理由看这里。**

---

## TL;DR（≤ 25 行，Manager 只读这里）

> ⚠️ 以下 TL;DR 写于 2026-08-02，**其中的 D11 Tauri v2 与 yt-dlp「可选插件」结论已不成立**，见上方状态块。

- **C2「一律 submodule」不可照做**，会毁掉依赖解析和许可证隔离。建议改为三分法：
  **(A) 需要我们自己 CI 编译的 C/C++ → git submodule**（whisper.cpp / sherpa-onnx / llama.cpp / ffmpeg / sqlite-vec / libsimple）；
  **(B) 纯语言级库（npm/crates.io）→ 包管理器 + lockfile**；
  **(C) 终端用户机器上的大二进制与模型权重 → 运行时下载 + SHA256 + manifest 入 git**。
- **必须避免（4 个真坑）**：① `ffmpeg-static` npm 是 **GPL-3.0-or-later** 二进制，用了我们发行物就背 GPLv3；
  ② **yt-dlp 官方 release 二进制是 GPLv3+**（PyInstaller 打包引入），只有 git 仓库/PyPI 包才是 Unlicense；
  ③ **tldraw** 是专有许可证（生产需付费）；④ **ten-vad** 带非竞争条款，非 OSI。（均已核实）
- **FFmpeg 结论**：默认 LGPL-2.1+，`--enable-gpl`（x264/x265/frei0r…）转 GPL，`--enable-nonfree`（fdk-aac）**不可分发**。
  FSF 官方 FAQ 明确：pipes/exec/命令行参数通常使程序保持**独立作品**（`#MereAggregation`）。
  → **推荐：CLI 子进程调用 + 自建 LGPL-only FFmpeg**（vendor submodule + CI 编译）。macOS 无现成 LGPL 预编译（BtbN 只有 win/linux）。
- **yt-dlp 结论**：Unlicense（仓库），但德国 OLG Hamburg 2024 终审判托管 youtube-dl 网站违法；Apple 5.2.3 明令禁止此类 App 上架。
  → **推荐：不随产品分发，做成"可选运行时下载"的插件**（默认关闭，用户主动启用）。F1 的默认路径走 播客 RSS/直链 HTTP。
- **核心选型**：D2 FFmpeg(LGPL,子进程) · D4 Silero-VAD(MIT) · D5 sherpa-onnx(Apache-2.0，避开 pyannote 的 HF gating)
  · D6 llama.cpp(MIT) · **D7 mind-elixir-core(MIT) 为主 + simple-mind-map 的导出思路** · D8 TipTap core(MIT，不碰 Pro)
  · D9 SQLite FTS5 + libsimple(选 MIT 支) + sqlite-vec · D10 SQLite(公有领域) · D11 **Tauri v2**(MIT/Apache) · D12 React+Tailwind+shadcn/ui。
- **关键取舍**：Tauri 的 sidecar 机制（已核实）天然契合"FFmpeg/whisper 作为独立子进程"的许可证隔离叙事，比 Electron 更干净。
- **未验证/存疑**：`macOS 的 LGPL FFmpeg 预编译源 = UNKNOWN`，需自建；sherpa-onnx 各 diarization **模型权重**许可证需逐个核实（NeMo/3D-Speaker）；
  未跑通任何编译（本任务只做选型，无构建验证）。
- **对其他 agent 的影响**：`gpu-runtime`(R-02) 的 ASR 引擎结论优先，本文只定其**集成方式**（submodule + CI 矩阵编译）；
  `model-mgmt`(R-04) 请复用本文 §7 的 `vendor/manifests/*.json` 清单格式；架构 agent 请按 §1 判定规则写 ADR。

---

# 详细内容

> **核实方法**：GitHub REST API（`gh api`，已认证）读 star/license/pushed_at/release assets；npm registry API 读 license + 最新发布日期；
> crates.io API 读 crate 版本；LICENSE 文件逐个 base64 解码读原文；官方文档 WebFetch。
> 标注 **已核实** 的条目均在 **2026-08-02** 当天实地拉取。凡未实地拉取的一律标 `UNKNOWN` 或「未核实」。

---

## §1 判定规则：submodule vs 包管理器 vs 运行时下载（**Manager 写 ADR 用这一节**）

### 1.1 为什么不能「一律 submodule」

C2 的立法本意是**「禁止复制粘贴源码、保留可追溯的上游」**，这个目标是对的。但把它字面执行成"所有开源模块都 submodule"会产生四个具体故障：

| # | 故障 | 说明 |
|---|------|------|
| F-1 | **依赖解析崩坏** | 把 `react` / `@tiptap/core` 做成 submodule 后，npm 无法参与版本求解，peer-dep 冲突、重复实例（如两份 React）无法被 dedupe。 |
| F-2 | **失去 semver 与安全告警** | Dependabot / `npm audit` / `cargo audit` 只认 lockfile。submodule 里的库不在告警覆盖范围内。 |
| F-3 | **许可证污染叙事** | 把 GPL 组件 submodule 进构建树，会让"我们只是调用一个独立进程"的论证变弱（见 §4.3）。合规上应当**物理隔离**。 |
| F-4 | **仓库体积与 clone 时间** | FFmpeg 源码约数百 MB 级、llama.cpp/whisper.cpp 带完整历史。全量 submodule 会让新人 clone 变成灾难（可用 `--depth` 缓解，但 npm 库根本不需要付这个成本）。 |

### 1.2 判定决策树（建议写进 ADR）

```
对每个第三方组件 X，依次问：

Q1. 我们是否需要「自己编译 X」，或需要「对 X 打补丁」，
    或 X 的 ABI/模型格式与我们的代码强耦合（必须 pin 到具体 commit）？
    ├─ 是 → 【A】git submodule 到 vendor/X，pin 到 tag/commit
    └─ 否 → Q2

Q2. X 是否有官方的包管理器发行（npm / crates.io / PyPI），
    且我们只通过其公开 API 调用（不改源码）？
    ├─ 是 → 【B】包管理器依赖，版本锁进 lockfile
    └─ 否 → Q3

Q3. X 是否是「独立可执行文件 / 平台相关预编译二进制 / 模型权重」？
    ├─ 是 → 【C】运行时下载：不进 git、不进 submodule。
    │        下载 URL + SHA256 + 版本矩阵写进 vendor/manifests/*.json（这个 JSON 进 git）
    └─ 否 → 回到 Q1 重新评估；若仍无法归类，升级给 Manager 决策
```

### 1.3 三条覆盖规则（优先级高于决策树）

| 规则 | 内容 | 理由 |
|------|------|------|
| **R-A 许可证隔离** | 任何 **GPL / AGPL / source-available（BUSL、非竞争条款）** 组件**一律不得**作为 submodule 进入构建树。只能以【C】运行时下载 或「用户自行安装」存在，且必须是独立进程边界。 | 保住商用/闭源可能性（§4.3、§6） |
| **R-B fork-before-patch** | 若预计要改 X 的代码，必须先 fork 到我们自己的 org，submodule 指向 **我们的 fork 的分支**，补丁以 commit 形式存在。**禁止**在 `vendor/X/` 里直接改文件。 | submodule 里的本地修改会在 `git submodule update` 时静默丢失 |
| **R-C 一律 pin** | submodule 全部 pin 到 **tag 或 commit SHA**，禁止跟踪分支（`branch = main`）。升级走 PR + CI 全矩阵重编译。 | 可复现构建 |

### 1.4 规则套用后的实际归类

| 类别 | 组件 | 数量 |
|------|------|------|
| **【A】submodule** | `ffmpeg`、`whisper.cpp`、`sherpa-onnx`、`llama.cpp`、`sqlite-vec`、`libsimple` | 6 |
| **【B】包管理器** | 全部前端库、Tauri 及其插件、Rust crates（rusqlite/symphonia/rubato/tokio…）、TipTap/mind-elixir/wavesurfer 等 | ~40 |
| **【C】运行时下载** | FFmpeg 二进制（若不自建）、yt-dlp、ASR/VAD/LLM 模型权重、GPU 后端运行时（CUDA/ROCm 相关） | 见 §7 manifests |

> **一句话总结给 ADR**：*submodule 是"编译单元"的引入方式，包管理器是"库"的引入方式，运行时下载是"资产"的引入方式。C2 的精神（不复制粘贴、可追溯上游）由这三者共同满足。*

---

## §2 各功能域候选与推荐

图例：✅ 推荐 · ⚠️ 有条件 · ❌ 避免。所有 star / 最近提交 数据 = **2026-08-02 实地核实**。

### D1 媒体链接下载

| 候选 | 仓库 | 许可证 | Star | 最近提交 | 语言/分发 | 引入方式 |
|------|------|--------|------|----------|-----------|----------|
| ✅ **yt-dlp**（可选插件） | `yt-dlp/yt-dlp` | **Unlicense**（仓库/PyPI）<br>**GPLv3+**（release 二进制） | 181.8k | 2026-07-23 | Python；官方 24 个 release 资产（win/mac/linux 单文件） | **【C】运行时下载**，默认不启用 |
| ⚠️ streamlink | `streamlink/streamlink` | BSD-2-Clause | 11.7k | 2026-08-01 | Python | 【C】；偏直播流，站点覆盖远少于 yt-dlp |
| ❌ youtube-dl | `ytdl-org/youtube-dl` | Unlicense | 140.8k | 2026-02-19 | Python | 维护明显放缓（半年无提交），站点提取器落后 |
| ⚠️ youtube-dl-exec (npm) | `microlinkhq/youtube-dl-exec` | MIT | 614 | 2026-07-14 | npm 3.1.9 (2026-07-06) | 只是 yt-dlp 的 Node 包装器；**它会帮你下载 yt-dlp 二进制**，等于把 GPLv3 拉进 node_modules。<br>📝 **后续实况**：本文写"不要用"，但该依赖**曾被真的引入过**（`^3.1.9`），后于 T-145 删除 —— 见 `packages/pipeline/package.json:27` 的 `_comment:removed-deps`。**红线曾被违反后自愈** |
| ❌ yt-dlp-wrap (npm) | — | MIT | — | **npm 最后发布 2023-09-13** | 已停更 | 弃用 |
| ❌ @distube/ytdl-core | `distubejs/ytdl-core` | MIT | 515 | **仓库已 archived** | — | 已归档 |

**推荐**：**分两条路径**（详见 §5.4）
1. **默认路径（随产品分发）**：播客 RSS enclosure + 通用直链，用 Rust `reqwest` + `feed-rs`/`rss` crate 自己实现。零法律风险。
2. **可选路径（用户主动启用）**：yt-dlp 作为**运行时下载的外部工具**，我们只写 CLI 包装层（子进程 + JSON 输出解析）。UI 上明确提示"由用户自行决定用途"。
   *不要*用 `youtube-dl-exec`——它把二进制下载埋进 npm install，破坏我们"不分发 GPLv3"的边界。

> ⚠️ **以上「分两条路径」的推荐已不成立（2026-08-06 订正，原文保留在上）**：
> ① Rust 实现从未采纳（ADR-003 决策 1 = Node daemon，仓库零行 Rust）；
> ② ADR-002 v2 决策 2 改为「**F1 直接内置 yt-dlp，不做双路径区分**」，不再有"默认关闭的可选插件"这一档。
> **仍然成立的是 §5 的分级事实本身**（仓库/PyPI = Unlicense、release 二进制 = GPLv3+、
> OLG Hamburg 2024、Apple 5.2.3）——那是全仓唯一来源，见文首状态块。

---

### D2 音视频处理（解码 / 16kHz mono 重采样 / 切片 / 转码）

| 候选 | 仓库/包 | 许可证 | Star | 最近提交 | 分发 | 引入方式 |
|------|---------|--------|------|----------|------|----------|
| ✅ **FFmpeg CLI（LGPL 构建）** | `FFmpeg/FFmpeg` | **LGPL-2.1+**（默认）/ GPL（`--enable-gpl`） | 62.6k | 2026-08-01 | C；需自建或用 BtbN 预编译 | **【A】submodule + CI 编译** 或【C】下载 |
| ⚠️ Symphonia | `pdeljanov/Symphonia` | **MPL-2.0** | 3.3k | 2026-07-23 | Rust crate 0.6.0 (2026-05-15) | 【B】纯解码，**不支持编码**；容器覆盖不如 FFmpeg |
| ✅ **rubato**（配合 Symphonia） | `HEnquist/rubato` | **Apache-2.0 OR MIT**（已读 LICENSE.txt 核实） | 348 | 2026-07-18 | Rust crate 4.0.0 (2026-07-09) | 【B】高质量重采样 |
| ❌ **ffmpeg-static (npm)** | `eugeneware/ffmpeg-static` | **GPL-3.0-or-later**（npm 5.3.0 自报） | 1.4k | 2026-03-21 | npm，自动下载 GPL 二进制 | **禁用**，见 §6 |
| ⚠️ @ffmpeg-installer/ffmpeg | — | LGPL-2.1 | — | **npm 最后发布 2021-07-15** | 停更 5 年，FFmpeg 4.x 时代 | 不用 |
| ❌ fluent-ffmpeg | `fluent-ffmpeg/node-fluent-ffmpeg` | MIT | 8.2k | **仓库已 archived**（2025-05） | — | 已归档 |
| ⚠️ ffmpeg.wasm | `ffmpegwasm/ffmpeg.wasm` | MIT（包装层）；**内含的 FFmpeg 仍受 LGPL/GPL 约束** | 17.7k | 2026-02-01 | npm `@ffmpeg/ffmpeg` 0.12.15 | 浏览器内转码；本地优先桌面场景性能不划算 |

**推荐**：
- **主力：FFmpeg CLI 子进程**（`ffmpeg -i in -vn -ac 1 -ar 16000 -f wav -`），LGPL-only 构建。
  这是唯一能覆盖"任意容器 → 音轨"的方案，且子进程边界给我们最强的许可证论证（§4.3）。
- **辅助：Symphonia + rubato**（纯 Rust）做**已知常见格式的快速路径**（mp3/m4a/wav/flac），避免所有场景都起子进程。
  MPL-2.0 是 file-level copyleft，动态/静态链接不传染我们的代码，商用安全。
- 通过 **Tauri sidecar**（`bundle.externalBin` + `shell:allow-execute`，已核实）管理 FFmpeg 二进制。

---

### D3 ASR 转写（**引擎选型归 `gpu-runtime` R-02，本文只定集成方式**）

> ⚠️ 依赖：`docs/research/R-02-runtime-gpu.md` 撰写时尚不存在。本节**不对引擎优劣下结论**，只给集成形态。

| 候选 | 仓库 | 许可证 | Star | 最近提交 | 预编译资产 | 建议集成方式 |
|------|------|--------|------|----------|-----------|--------------|
| whisper.cpp | `ggml-org/whisper.cpp` | **MIT** | 52.5k | 2026-07-31 | v1.9.1 (2026-06-19)，9 个资产：ubuntu-x64/arm64、Win32/x64、blas、**cublas-11.8 / cublas-12.4**、xcframework | **【A】submodule + 我们自己 CI 多后端矩阵编译** |
| sherpa-onnx | `k2-fsa/sherpa-onnx` | **Apache-2.0** | 13.9k | 2026-07-31 | 官方 npm/Rust/Tauri 绑定齐全 | 【A】submodule（同时供 D4/D5 复用） |
| faster-whisper | `SYSTRAN/faster-whisper` | MIT | 24.7k | **2025-11-19（8 个月无提交）** | Python 包，需 Python 运行时 | 不建议（拖 Python 依赖进桌面应用） |
| FunASR（中文） | `modelscope/FunASR` | MIT | 19.6k | 2026-07-31 | Python | 模型可经 sherpa-onnx 以 ONNX 形式使用 |
| WhisperKit | `argmaxinc/argmax-oss-swift` | MIT | 6.3k | 2026-07-31 | Swift/CoreML | macOS-only；仅在 mac 分支考虑 |
| whisperX | `m-bain/whisperX` | BSD-2-Clause | 23.4k | 2026-07-13 | Python | 其 diarization 依赖 pyannote（HF gating，见 D5） |

**本文给 R-02 的集成建议（唯一结论）**：
1. ASR 引擎一律 **【A】submodule + 我们自己的 CI 编译矩阵**，不用上游 release 资产。
   理由：章程要求 2.1 要"按硬件下发对应后端二进制"，上游 release 只覆盖部分组合（whisper.cpp 官方无 Vulkan/ROCm/Metal 独立包）。
2. 编译产物 + 模型权重走 **【C】运行时下载**，清单写 `vendor/manifests/`。
3. **whisper.cpp 已内置 VAD**（`--vad` + `-vm ggml-silero-v6.2.0.bin`，已核实 README），这会影响 D4 的取舍。

---

### D4 VAD / 静音切分

| 候选 | 仓库 | 许可证 | Star | 最近提交 | 分发 | 引入方式 |
|------|------|--------|------|----------|------|----------|
| ✅ **Silero VAD** | `snakers4/silero-vad` | **MIT**（已读 LICENSE 核实） | 9.8k | 2026-07-16 | ONNX/JIT 模型 + Python | 【C】模型权重下载；推理走 whisper.cpp/sherpa-onnx/ort |
| ✅ **whisper.cpp 内置 VAD** | 同 D3 | MIT | — | — | `--vad` CLI 参数 + silero ggml 模型 | 【A】随 whisper.cpp submodule 白拿 |
| ⚠️ @ricky0123/vad-web | `ricky0123/vad` | **ISC**（已读 LICENSE 核实） | 2.0k | 2026-01-30 | npm 0.0.30 (2025-11-21) | 【B】**浏览器端实时 VAD**，F3 录音场景有用；版本仍 0.0.x |
| ⚠️ py-webrtcvad | `wiseman/py-webrtcvad` | MIT | 2.5k | **2024-07-04（2 年无提交）** | Python | 老派能量法，准确率低于 Silero |
| ❌ **ten-vad** | `TEN-framework/ten-vad` | **Apache-2.0 + 非竞争附加条款** | 2.2k | 2026-02-02 | C | **避免**，见 §6 |

**推荐**：
- **后端切分**：直接用 **whisper.cpp 的 `--vad`**（零额外依赖，MIT，模型也是 MIT）。若走 sherpa-onnx 路线则用它内置的 Silero VAD。
- **前端实时录音（F3）**：`@ricky0123/vad-web`（ISC）在浏览器里做静音检测 → 分段推流给后端。⚠️ 0.0.x 版本，API 可能变动。

---

### D5 说话人分离（diarization，可选功能）

| 候选 | 仓库 | 许可证 | Star | 最近提交 | 模型获取 | 可行性 |
|------|------|--------|------|----------|----------|--------|
| ✅ **sherpa-onnx diarization** | `k2-fsa/sherpa-onnx` | **Apache-2.0** | 13.9k | 2026-07-31 | **GitHub Releases 直链，无 gating**（已核实官方文档）；segmentation = `sherpa-onnx-pyannote-segmentation-3-0` / `reverb-diarization-v1`，embedding = 3D-Speaker / NeMo | **可行**。有 **Rust 绑定 `sherpa-rs` 0.6.8** + 官方 Tauri 示例 |
| ⚠️ pyannote-audio | `pyannote/pyannote-audio` | 代码 MIT | 10.4k | 2026-07-24 | **HuggingFace gated**：必须接受两处 user conditions + 创建 access token（已核实模型页） | **不适合 local-first 桌面**：要求终端用户注册 HF 并交出 token |
| ⚠️ NVIDIA NeMo Speech | `NVIDIA-NeMo/Speech` | Apache-2.0 | 17.8k | 2026-08-01 | Python，重依赖 | 桌面端过重 |
| ⚠️ 3D-Speaker | `modelscope/3D-Speaker` | Apache-2.0 | 3.1k | 2025-12-08 | 模型可转 ONNX | 已被 sherpa-onnx 收编，直接用 sherpa 更省事 |
| ⚠️ diart | `juanmc2005/diart` | MIT | 2.0k | 2026-06-19 | 底层仍是 pyannote | 继承 gating 问题 |

**推荐**：**sherpa-onnx**（Apache-2.0，模型托管在 GitHub Releases 无需 token，Rust 绑定齐全）。
一个组件同时覆盖 **D3 ASR + D4 VAD + D5 diarization**，是本次选型中性价比最高的单点。

> ⚠️ **需法务确认**：sherpa-onnx 的**代码**是 Apache-2.0，但它托管的**模型权重**来源各异（pyannote-segmentation-3.0 上游是 MIT；NeMo titanet / 3D-Speaker 的具体权重许可证**本次未逐个核实 = UNKNOWN**）。
> 商用前必须逐个模型核对，尤其警惕 CC-BY-NC 类非商用条款。

---

### D6 本地 LLM 推理

| 候选 | 仓库 | 许可证 | Star | 最近提交 | 分发 | 引入方式 |
|------|------|--------|------|----------|------|----------|
| ✅ **llama.cpp** | `ggml-org/llama.cpp` | **MIT** | 122.3k | 2026-08-01 | C++；多后端（CUDA/Metal/Vulkan/ROCm/CPU） | **【A】submodule + CI 矩阵编译** |
| ⚠️ node-llama-cpp | `withcatai/node-llama-cpp` | MIT | 2.1k | 2026-07-20 | npm 3.19.1 (2026-07-20) | 【B】若前端/Node 侧直接调用可用；但会与我们自己的编译矩阵重复 |
| ⚠️ Ollama | `ollama/ollama` | MIT | 177.5k | 2026-07-31 | Go，独立 daemon | 【C】作为**可选外部后端**；自带模型仓库与我们的 R-04 模型管理会打架 |
| ⚠️ candle | `huggingface/candle` | Apache-2.0 | 20.8k | 2026-07-30 | Rust crate | 【B】纯 Rust 很诱人，但 GGUF 生态与量化支持不及 llama.cpp |
| ⚠️ MLC-LLM | `mlc-ai/mlc-llm` | Apache-2.0 | 23.0k | 2026-07-31 | 需 TVM 编译链 | 构建复杂度高 |

**推荐**：**llama.cpp（submodule + 我们自己编译）**。
理由：与 D3 的 whisper.cpp **共用 ggml 后端与编译矩阵**（同一套 CUDA/Metal/Vulkan/ROCm CMake 参数），CI 复杂度几乎不增加；MIT 无任何商用限制；GGUF 量化生态最全，直接支撑章程要求 2.2 的"量化选择"。
⚠️ **模型权重许可证与代码无关**：Llama / Qwen / Gemma 各有自己的条款（部分含使用限制/月活门槛），必须由 `model-mgmt`(R-04) 在下载 UI 中逐个展示并要求用户确认。

---

### D7 思维导图渲染与编辑（**F4 核心**）

需求硬指标：**可交互编辑** + **导出 PNG / SVG / Markdown / OPML / FreeMind**。

| 候选 | 仓库/包 | 许可证 | Star | 最近发布 | 编辑能力 | 内置导出 |
|------|---------|--------|------|----------|----------|----------|
| ✅ **mind-elixir-core** | `SSShooter/mind-elixir-core` | **MIT** | 3.1k | npm `mind-elixir` **5.14.0 (2026-07-12)** | **强**：`nodeOperation` / `contextMenu` / `nodeDraggable` / `operationHistory`(撤销重做) / `selection`（已核实源码目录） | `exportImage.ts` → **PNG/SVG**；`plaintextConverter` 双向纯文本；JSON 数据模型 |
| ✅ **simple-mind-map** | `wanglin2/mind-map` | **MIT** | 12.5k | npm `simple-mind-map` **0.14.0-fix.3 (2026-07-07)** | 强（含富文本节点、关联线、外框、协同） | **最全**（已核实 `Export.js`）：`png / jpg / pdf / svg / xmind / json / smm / md / txt`；`parse/` 支持 **markdown、xmind 导入** |
| ⚠️ markmap | `markmap/markmap` | MIT | 13.0k | npm `markmap-view` 0.18.12 (2025-06-12) | **弱**：只有折叠/展开，**不是编辑器** | SVG | 
| ⚠️ jsMind | `hizzgdev/jsmind` | **BSD-3-Clause**（已读 LICENSE 核实） | 3.8k | npm 0.9.1 (2025-12-15) | 中等 | PNG；freemind/nodetree 数据格式 |
| ⚠️ @antv/g6 | `antvis/G6` | MIT | 12.2k | npm 5.1.1 (2026-05-08) | 通用图引擎，思维导图要自己搭 | 需自研 |
| ⚠️ xyflow (React Flow) | `xyflow/xyflow` | MIT | 37.9k | npm `@xyflow/react` 12.11.2 (2026-07-06) | 通用节点编辑器，导图布局/折叠需自研 | 需自研 |
| ❌ **tldraw** | `tldraw/tldraw` | **专有 tldraw license** | 49.5k | 2026-08-01 | 强 | **禁用**，见 §6 |

**推荐：mind-elixir-core 为主**，理由：
1. 它是**编辑优先**（edit-first）设计，撤销/重做、拖拽、右键菜单开箱即用——这是 F4"可交互编辑"的硬需求，markmap 根本不满足。
2. 体积小、框架无关（TS，无 Vue/React 绑定），适配我们任意前端选型。
3. MIT，最近发布 3 周内（2026-07-12），活跃。
4. 数据模型是**朴素的递归树 JSON**，写 Markdown / OPML / FreeMind 序列化器**各约 50 行**，成本极低。

**导出方案（补齐缺口）**：
| 格式 | 来源 |
|------|------|
| PNG / SVG | mind-elixir 内置 `exportImage` |
| Markdown | 自研序列化器（树 → `#`/缩进列表），~50 行 |
| **OPML** | 自研序列化器；或用 npm `opml` (MIT, 0.5.8, 2025-12-08) 双向读写 |
| **FreeMind (.mm)** | 自研 XML 序列化器（`<node TEXT="..">` 嵌套），~60 行。**未找到维护中的 npm 库**（`freemind-parser` 不存在 = 已核实 404） |
| XMind / PDF | 若需要，参考 `simple-mind-map` 的 `ExportXMind.js` / `ExportPDF.js` 实现思路（**不复制代码**，C2 禁止） |

> **备选路线**：若后续发现导出需求压过编辑体验，改用 **simple-mind-map**（导出矩阵最全，12.5k star）。两者数据模型都是树 JSON，迁移成本可控。
> **额外用途**：markmap 可作为"Markdown 笔记 → 只读导图预览"的轻量二级视图（与 D8 编辑器天然联动），但**不承担编辑职责**。

---

### D8 富文本 / Markdown 编辑器

| 候选 | 仓库/包 | 许可证 | Star | 最近发布 | 备注 |
|------|---------|--------|------|----------|------|
| ✅ **TipTap core** | `ueberdosis/tiptap` | **MIT**（core） | 37.9k | npm `@tiptap/core` **3.29.2 (2026-07-28)** | 基于 ProseMirror；**自定义 Node/Mark 机制最适合做"时间戳锚点"**。⚠️ Pro Extensions / UI Components / Templates 为**付费专有许可**（已核实 pro-license 页），必须只用 MIT 部分 |
| ⚠️ ProseMirror | `ProseMirror/prosemirror` | MIT | 8.7k | **元仓库 archived**（各 `prosemirror-*` 包仍活跃） | 底层，API 陡峭。TipTap 已封装 |
| ⚠️ Milkdown | `Milkdown/milkdown` | MIT | 11.8k | npm `@milkdown/core` 7.21.3 (2026-07-12) | Markdown-first（基于 ProseMirror + remark），若笔记以 md 为唯一真相则很合适 |
| ⚠️ Lexical | `facebook/lexical` | MIT | 23.7k | npm 0.49.0 (2026-07-30) | Meta 出品，性能好；**仍是 0.x**，破坏性变更风险 |
| ⚠️ **BlockNote** | `TypeCellOS/BlockNote` | **MPL-2.0（core）+ GPL-3.0（`@blocknote/xl-*`）** | 10.0k | npm `@blocknote/core` 0.52.1 (2026-07-20) | Notion 风格开箱即用，但**必须严格排除所有 `xl-*` 包**（GPL-3.0），见 §6 |
| ⚠️ CodeMirror 6 | `codemirror/dev` | **MIT**（已读 LICENSE 核实） | 7.8k | npm `@codemirror/state` 6.7.1 (2026-07-05) | 纯文本/代码编辑，不适合富文本笔记 |
| ❌ Novel | `steven-tey/novel` | Apache-2.0 | 16.4k | **2025-01-18（1.5 年无提交）** | 停更 |

**推荐**：**TipTap core（MIT）+ 自研 `TimestampMark`**。
- 时间轴联动实现路径：给转写稿的每个 segment 加一个自定义 **Mark**，属性携带 `startMs/endMs`；点击 → 驱动播放器 seek；播放进度 → 高亮对应 Mark。TipTap 的 Mark/Decoration API 是这套需求最直接的匹配。
- **配套**：`wavesurfer.js`（**BSD-3-Clause**，7.12.11 / 2026-07-17，已核实）做波形 + 区域高亮。
- **红线**：只用 `@tiptap/core` + `@tiptap/starter-kit` + 官方 MIT 扩展。任何 `@tiptap-pro/*` / Collaboration / AI Toolkit / Comments 一律不引入（付费专有）。

---

### D9 全文检索（中文分词 + 向量）

| 候选 | 仓库/包 | 许可证 | Star | 最近活动 | 形态 |
|------|---------|--------|------|----------|------|
| ✅ **SQLite FTS5 + libsimple** | `wangfenjin/simple` | **MIT OR GPL-3.0 双授权（我们选 MIT 支）**（已读 LICENSE 核实） | 855 | 2026-05-17；release v0.7.1 (2026-02-23) | **FTS5 tokenizer 扩展**，jieba 中文分词 + 拼音。**12 个预编译资产**：osx-arm64/x64、windows-x64/arm64/x86、linux ubuntu-22.04/24.04-arm/latest |
| ✅ **sqlite-vec** | `asg017/sqlite-vec` | **Apache-2.0 / "MIT OR Apache" (npm)** | 8.0k | 2026-05-18；release v0.1.9 (2026-03-31)，27 个跨平台 loadable 资产 | SQLite 向量扩展，零外部依赖。⚠️ **仍是 0.1.x** |
| ⚠️ Tantivy | `quickwit-oss/tantivy` | MIT | 15.6k | 2026-07-29；crate 0.26.1 | Rust 全文引擎，性能强；但需**独立索引存储**，与 SQLite 双写一致性是额外工作量 |
| ⚠️ LanceDB | `lancedb/lancedb` | Apache-2.0 | 11.1k | 2026-08-01 | 嵌入式向量库，功能强但引入第二套存储 |
| ⚠️ @node-rs/jieba | — | MIT | — | npm 2.0.1 (**2024-12-05**) | 应用层分词；须与 FTS5 tokenizer 二选一 |
| ❌ sqlite-vss | `asg017/sqlite-vss` | MIT | 2.0k | **2024-05-05（2 年无提交）** | 已被作者的 sqlite-vec 取代 |
| ❌ **Meilisearch** | `meilisearch/meilisearch` | **MIT AND BUSL-1.1**（EE 部分，已读 LICENSE 核实） | 58.8k | 2026-08-01 | 独立 server 进程 + BUSL 部分，见 §6 |
| ⚠️ Orama | `oramasearch/orama` | Apache-2.0 | 10.5k | npm 3.1.18 (2025-12-19) | 纯 JS，中文分词需额外配置；数据量大时内存吃紧 |

**推荐**：**SQLite 单一存储 + FTS5(libsimple) + sqlite-vec**。
- **最大优点**：一个 `.db` 文件承载笔记、转写稿、全文索引、向量索引。备份/同步/迁移全都是"复制一个文件"，完美契合 local-first。
- libsimple 选 **MIT 分支**（务必在 NOTICE 中写明选择 MIT，避免歧义）。
- 两者都是 **loadable extension**（`.dylib`/`.dll`/`.so`），走 **【A】submodule + CI 编译**（因为要覆盖我们的全平台矩阵，上游预编译不含全部组合）。
- ⚠️ **风险**：`sqlite-vec` 处于 **0.1.x**，API 与磁盘格式可能变更 → 索引层要能**重建**（把向量原始数据存在普通表里，vec 索引视为可再生的缓存）。

---

### D10 数据库

| 候选 | 仓库/包 | 许可证 | Star | 最近活动 |
|------|---------|--------|------|----------|
| ✅ **SQLite** | `sqlite/sqlite` | **Public Domain**（已读 LICENSE.md 核实："SQLite Is Public Domain"） | 10.1k(镜像) | 2026-08-01 |
| ✅ **rusqlite** | `rusqlite/rusqlite` | MIT | 4.3k | crate 0.40.1 (2026-06-06) |
| ⚠️ Tauri plugin-sql | — | **MIT OR Apache-2.0** | — | npm 2.4.0 (2026-04-04) | 前端直连 DB；但业务逻辑应在 Rust 侧，此插件只适合简单读 |
| ⚠️ better-sqlite3 | `WiseLibs/better-sqlite3` | MIT | 7.4k | npm 13.0.2 (2026-07-29) | 仅当选 Electron/Node 后端时 |
| ⚠️ libSQL | `tursodatabase/libsql` | MIT | 17.0k | 2026-07-24 | SQLite 分支；除非要云同步，否则无必要 |
| ⚠️ SQLCipher | `sqlcipher/sqlcipher` | BSD-3-Clause | 7.2k | 2026-07-08 | 若需静态加密。⚠️ 社区版 BSD-3，商业版条款不同（**未核实**） |
| ❌ DuckDB | `duckdb/duckdb` | MIT | 39.9k | 2026-08-01 | OLAP 取向，非本场景 |

**推荐**：**SQLite（公有领域）+ rusqlite（MIT）**，WAL 模式，扩展加载走 `load_extension`（libsimple / sqlite-vec）。
⚠️ 注意 rusqlite 的 `bundled` feature 会静态编译 SQLite——这与 D9 的 **loadable extension** 需要 `SQLITE_ENABLE_LOAD_EXTENSION` 编译开关有关，构建时必须显式启用（**未验证**，需在 T-011 骨架搭建时跑通）。

---

### D11 桌面外壳

| 候选 | 仓库 | 许可证 | Star | 最近提交 | 关键能力 |
|------|------|--------|------|----------|----------|
| ✅ **Tauri v2** | `tauri-apps/tauri` | **Apache-2.0 OR MIT** | 109.8k | 2026-08-01 | **sidecar 已核实**：`bundle.externalBin` + target-triple 后缀 + `shell:allow-execute/spawn` capability；插件齐全（sql/http/shell/upload/updater/store/fs…，全部 MIT OR Apache-2.0） |
| ⚠️ Electron | `electron/electron` | MIT | 122.3k | 2026-08-01 | 生态最成熟；但**捆绑 Chromium**，体积与内存显著更高（具体数字**未实测 = UNKNOWN**） |
| ⚠️ Wails | `wailsapp/wails` | MIT | 35.6k | 2026-08-01 | Go 后端；若后端选 Rust 则不适用 |
| ⚠️ Neutralino | `neutralinojs/neutralinojs` | **MIT**（已读 LICENSE 核实） | 8.6k | 2026-08-01 | 极轻，但插件/系统集成能力弱 |
| ⚠️ 纯 localhost 服务 + 浏览器 | — | — | — | — | 最简，但"下载/安装 GPU 后端"（要求 2.1）需要文件系统与提权，浏览器沙箱不便；且失去托盘/自动更新 |

**推荐：Tauri v2**，三条理由：
1. **许可证隔离最干净**：sidecar 机制天然把 FFmpeg / yt-dlp / whisper 放在**独立进程 + 独立可执行文件**里，正好对应 FSF `#MereAggregation` 的 "arm's length" 论证（§4.3）。
2. **要求 2.1/2.2 需要的能力齐全**：`plugin-http`(下载) + `plugin-fs` + `plugin-shell`(执行自检) + `plugin-updater`，全部 MIT/Apache 双授权。
3. Rust 后端与 D9/D10（rusqlite）、D2（symphonia/rubato）、D5（sherpa-rs）同语言，无 FFI 断层。

⚠️ **风险**：Tauri 用系统 WebView（Windows=WebView2、macOS=WKWebView、Linux=WebKitGTK）→ **跨平台渲染差异**，尤其 Linux WebKitGTK 版本碎片化。思维导图这类重 SVG/Canvas 的 UI 需要在 Linux 上专门测试（**未验证**）。

---

### D12 前端框架与 UI 库

| 域 | 候选 | 许可证 | Star | 最近提交 | 推荐 |
|----|------|--------|------|----------|------|
| 框架 | React `facebook/react` | MIT | 246.8k | 2026-08-01 | ✅ 生态最大；mind-elixir/TipTap/wavesurfer 都有成熟 React 用法 |
| 框架 | Vue `vuejs/core` | MIT | 54.1k | 2026-08-01 | ⚠️ 若团队偏好；`simple-mind-map` 生态更亲 Vue |
| 框架 | Svelte | MIT | 87.7k | 2026-07-30 | ⚠️ 体积最优，生态较小 |
| 框架 | SolidJS | MIT | 35.8k | 2026-07-31 | ⚠️ 同上 |
| 样式 | **Tailwind CSS** | MIT | 96.1k | 2026-07-31 | ✅ |
| 组件 | **shadcn/ui** | MIT | 120.3k | 2026-07-31 | ✅ **代码复制进项目**的模式 → 与 C2「禁止复制粘贴」表面冲突，需 ADR 明确豁免（它的设计意图就是"你拥有这些代码"，不是依赖） |
| 组件 | Radix Primitives | MIT | 19.1k | 2026-07-31 | ✅ shadcn 的底座，无样式无障碍原语 |
| 组件 | MUI | MIT | 98.7k | 2026-07-31 | ⚠️ 体积大，设计语言强 |
| 组件 | Ant Design | MIT | 98.9k | 2026-08-01 | ⚠️ 中文场景友好，但偏后台风格 |
| 组件 | Mantine | MIT | 31.5k | 2026-07-31 | ⚠️ 好选择 |
| 组件 | HeroUI | Apache-2.0 | 30.3k | 2026-08-01 | ⚠️ |
| 状态 | Zustand | MIT | 58.5k | 2026-07-29 | ✅ 轻量 |
| 数据 | TanStack Query | MIT | 50.0k | 2026-08-01 | ✅ 管任务轮询/长任务状态 |
| 构建 | Vite | MIT | 82.2k | 2026-07-31 | ✅ Tauri 官方模板默认 |

**推荐**：**React + TypeScript + Vite + Tailwind + shadcn/ui(Radix) + Zustand + TanStack Query**，全 MIT。
⚠️ **给 Manager 的决策点**：shadcn/ui 的分发方式是 CLI 把源码**写进你的仓库**。这与 C2 字面冲突，但它不是"抄袭上游库"，而是官方设计的使用方式。建议 ADR 中明确：**"官方以源码分发（source-distributed）的组件库不受 C2 约束，但必须保留原始 LICENSE 与来源标注。"**

---

## §3 许可证矩阵总表

**风险等级**：🟢 无条件可商用闭源 · 🟡 有义务但可满足 · 🔴 与闭源/商用冲突，必须避免或隔离

| 组件 | 许可证 | 等级 | 我们的用法 | 义务 / 备注 |
|------|--------|------|-----------|------------|
| SQLite | Public Domain | 🟢 | 静态链接 | 无 |
| whisper.cpp | MIT | 🟢 | submodule + 自编译 | 保留版权声明 |
| llama.cpp | MIT | 🟢 | submodule + 自编译 | 保留版权声明 |
| sherpa-onnx | Apache-2.0 | 🟢 | submodule + 自编译 | 保留 NOTICE，标注修改 |
| sqlite-vec | Apache-2.0 (MIT OR Apache) | 🟢 | submodule + 自编译 | NOTICE |
| **libsimple** | **MIT OR GPL-3.0（双授权）** | 🟢 | submodule + 自编译 | **必须书面声明我们选择 MIT 支**，否则默认可能被解读为 GPL |
| Silero VAD（代码+模型） | MIT | 🟢 | 模型下载 | 保留版权声明 |
| rusqlite / tokio / reqwest | MIT / Apache-2.0 | 🟢 | crate | — |
| rubato | Apache-2.0 OR MIT | 🟢 | crate | — |
| Tauri v2 + 全部官方插件 | Apache-2.0 OR MIT | 🟢 | crate + npm | — |
| React / Tailwind / shadcn / Radix / Zustand / TanStack | MIT | 🟢 | npm | 保留 LICENSE |
| **TipTap core** | MIT | 🟢 | npm | ⚠️ **`@tiptap-pro/*` 是付费专有 → 禁止引入** |
| mind-elixir-core | MIT | 🟢 | npm | — |
| simple-mind-map | MIT | 🟢 | npm（若采用） | — |
| markmap | MIT | 🟢 | npm | — |
| jsMind | BSD-3-Clause | 🟢 | npm | 保留声明 + **禁止用作者名背书** |
| wavesurfer.js | BSD-3-Clause | 🟢 | npm | 同上 |
| onnxruntime-node / -web | MIT | 🟢 | npm | — |
| @ricky0123/vad-web | ISC | 🟢 | npm | — |
| @node-rs/jieba | MIT | 🟢 | npm | — |
| opml (npm) | MIT | 🟢 | npm | — |
| Orama | Apache-2.0 | 🟢 | npm | — |
| Tantivy | MIT | 🟢 | crate | — |
| **Symphonia** | **MPL-2.0** | 🟡 | crate（不改源码） | **file-level copyleft**：只要不修改其源文件，我们的代码不受影响。若改了 Symphonia 的文件 → **必须公开那些文件的修改** |
| **BlockNote core** | **MPL-2.0** | 🟡 | npm（若采用） | 同上；**`@blocknote/xl-*` 是 GPL-3.0 → 🔴 禁止** |
| **FFmpeg（LGPL 构建）** | **LGPL-2.1+** | 🟡 | **CLI 子进程** | 见 §4。若改为动态链接 libav*，须满足 LGPL §6（可替换的共享库 + 提供 FFmpeg 源码） |
| pyannote-audio | MIT（代码） | 🟡 | **不采用** | 模型 HF gated，需终端用户 token |
| SQLCipher 社区版 | BSD-3-Clause | 🟡 | 可选 | 商业版条款**未核实** |
| **FFmpeg（GPL 构建）** | **GPL-2.0+** | 🔴 | **避免** | 含 x264/x265/frei0r/librubberband/libvidstab/libxvid 等（已核实 LICENSE.md 清单） |
| **FFmpeg（nonfree 构建）** | 不兼容 | 🔴 | **绝对禁止** | 官方原文："This will cause the resulting binary to be **unredistributable**" |
| **ffmpeg-static (npm)** | **GPL-3.0-or-later** | 🔴→⚠️ | ~~**禁止**~~ → **ADR-002 v2 已放行** | 包自报 license；二进制源自 gyan.dev/evermeet（均为 GPL 构建）。**许可证事实仍准确**；但 `ADR-002:22` 在个人自用档下 ✅ 允许。当前依赖里没有它，删除理由是 T-145 的"减少第二条依赖通道"，不是本条 |
| **yt-dlp release 二进制** | **GPLv3+** | 🔴→⚠️ | ~~**不随产品分发**~~ → **已决定直接内置** | README 原文："the PyInstaller-bundled executables include GPLv3+ licensed code, and as such the combined work is licensed under GPLv3+"。**许可证事实仍准确**；但 `ADR-002:14,23`（v2 决策 2）改为直接内置，`backends.json` 4 个 `ytdlp-*` 包已发货，GPLv3+ 义务记在各包的 `license` 字段 |
| yt-dlp git 仓库 / PyPI 包 | Unlicense | 🟡 | 见 §5 | README："The git repository, the PyPI source distribution and the PyPI built distribution (wheel) only contain code licensed under the Unlicense" |
| **tldraw** | **专有 tldraw license** | 🔴 | **禁止** | "Production Environment" 使用需另购许可 |
| **ten-vad** | Apache-2.0 + **非竞争附加条款** | 🔴 | **禁止** | "You may not Deploy the ten-vad in a way that competes with Agora's offerings" — 非 OSI，field-of-use 限制 |
| **Meilisearch EE** | **BUSL-1.1** | 🔴 | **不采用** | `SPDX: MIT AND BUSL-1.1` |
| **Moonshine 非英语模型** | **Moonshine Community License（非商用）** | 🔴 | **禁止商用** | 原文："Models for other languages are released under the Moonshine Community License, which is a non-commercial license"（英文模型是 MIT，🟢） |
| Whisper / Llama / Qwen 等**模型权重** | 各不相同 | 🔴 **待核实** | 见 §6 | 与代码许可证**无关**，必须逐个核对，交由 R-04 在 UI 呈现 |

---

## §4 专题：FFmpeg 许可证

### 4.1 LGPL vs GPL 构建的分界（已核实）

**官方声明**（https://ffmpeg.org/legal.html）：
> "FFmpeg is licensed under the GNU Lesser General Public License (LGPL) version 2.1 or later. However, FFmpeg incorporates several optional parts and optimizations that are covered by the GNU General Public License (GPL) version 2 or later. **If those parts get used the GPL applies to all of FFmpeg.**"
> "Note that FFmpeg is not available under any other licensing terms, especially not proprietary/commercial ones, **not even in exchange for payment**."

**触发 GPL 的组件清单**（https://raw.githubusercontent.com/FFmpeg/FFmpeg/master/LICENSE.md，已核实）：
> "The following libraries are under GPL version 2: **avisynth, frei0r, libcdio, libdavs2, librubberband, libvidstab, libx264, libx265, libxavs, libxavs2, libxvid**. When combining them with FFmpeg, FFmpeg needs to be licensed as GPL as well by passing `--enable-gpl` to configure."

**nonfree（不可分发）**：
> "There are certain libraries you can combine with FFmpeg whose licenses are not compatible with the GPL and/or the LGPL. If you wish to enable these libraries... pass `--enable-nonfree` to configure. **This will cause the resulting binary to be unredistributable.**"（涉及 Fraunhofer FDK AAC、OpenSSL）

> ✅ **对我们的关键推论**：我们只需要 **解码 + 重采样 + 切片 + 转成 wav/opus**，**完全不需要** x264/x265（视频编码）。
> 所以 LGPL-only 构建对 OpenMemo 是**功能完备的**——这不是妥协，是零成本。

### 4.2 我们动态链接 libav* 有什么义务？

LGPL-2.1 §6（https://www.gnu.org/licenses/old-licenses/lgpl-2.1.txt，已核实原文）允许你在自选条款下分发链接了该库的作品，**前提是**条款允许"modification of the work for the customer's own use and reverse engineering for debugging"，并且满足 (a)–(e) 之一。最实用的是 **(b)**：

> "b) Use a suitable shared library mechanism for linking with the Library. A suitable mechanism is one that (1) uses at run time a copy of the library already present on the user's computer system... and (2) **will operate properly with a modified version of the library, if the user installs one**..."

**若我们选择动态链接，义务清单**：
1. 以**动态共享库**（`.so`/`.dylib`/`.dll`）形式分发 libavcodec/libavformat 等，用户可自行替换为修改版；
2. 随产品提供 **FFmpeg 的完整对应源码**（或书面/网络获取途径），并写明使用的 configure 参数；
3. 在"关于/致谢"中给出 LGPL-2.1 全文与版权声明；
4. **不得**因 DRM/代码签名/静态链接而使用户无法替换该库（macOS 代码签名 + hardened runtime 会与"可替换"产生张力 → ⚠️ **需法务确认**）。

### 4.3 调用 CLI 子进程构成"衍生作品"吗？（**重点**）

**FSF 官方立场**（https://www.gnu.org/licenses/gpl-faq.html，已核实原文）：

`#MereAggregation`：
> "We believe that a proper criterion depends both on the mechanism of communication (exec, pipes, rpc, function calls within a shared address space, etc.) and the semantics of the communication... **By contrast, pipes, sockets and command-line arguments are communication mechanisms normally used between two separate programs. So when they are used for communication, the modules normally are separate programs.** But if the semantics of the communication are intimate enough, exchanging complex internal data structures, that too could be a basis to consider the two parts as combined into a larger program."

`#GPLPlugins`：
> "A main program that uses **simple fork and exec** to invoke plug-ins and **does not establish intimate communication** between them results in the plug-ins being **a separate program**."

`#GPLInProprietarySystem`：
> "...you must make sure that the free and nonfree programs communicate **at arms length**, that they are not combined in a way that would make them effectively a single program."

**结论**：
- 用 `Command::new("ffmpeg").args([...])` + stdin/stdout 管道传 **音频字节流和命令行参数**，正是 FSF 描述的"两个独立程序"的范式情形。**不构成衍生作品**。
- **必须守住的边界**：
  - ✅ 只传命令行参数 + 标准输入输出的原始媒体字节流；
  - ❌ 不通过共享内存传递 `AVFrame`/`AVPacket` 等 FFmpeg 内部数据结构；
  - ❌ 不链接 libav*（如果同时又调 CLI，会削弱"独立程序"的论证）；
  - ✅ 二进制以独立可执行文件形式存在（Tauri sidecar 天然满足）。
- ⚠️ **需法务确认**：FSF 的 FAQ 是**版权持有方的解释**，不是判例。虽然是业界通行做法，但没有法院判决直接确认 CLI 子进程边界。

### 4.4 主流产品怎么做（证据强度分级）

| 产品 | 做法 | 证据强度 |
|------|------|----------|
| **Audacity** | **不捆绑 FFmpeg，引导用户自行下载安装**。官方原文："Because of software patents, Audacity cannot include the FFmpeg software or distribute it from its own websites."（注意：理由是**专利**，不是 GPL） | ✅ 官方文档已核实 |
| **HandBrake** | 自身 GPL-2.0，捆绑 `--enable-gpl` 的 FFmpeg（含 x264/x265） | ⚠️ 二手来源，未从一手文档核实 |
| **Blender** | 自身 GPL；其预编译依赖仓库**主动构建 x264** → 说明 Blender 分发的是 **GPL 构建**的 FFmpeg | ✅ Blender PR #137670 佐证；官方 dependency 文档页 404 |
| **OBS / Shotcut / Kdenlive** | 自身均为 GPL，捆绑 GPL 构建 | ⚠️ 二手来源 |
| **ffmpeg.org/shame.html** | FFmpeg 维护的"违规名单"，~40 家消费级转换器工具（AVS Video Converter、DVDFab、Format Factory、GOM Player、KMPlayer、PotPlayer…）。**页面自述已停更**（"Shame page will be offline until entries are updated"），条目多为 2009–2010 年 | ✅ 页面已核实；⚠️ 已过时，不代表近期执法活跃 |

> 📌 **重要观察**：上面这些"捆绑 FFmpeg"的产品**自身都是 GPL**，所以对它们没有冲突。
> **我们希望保留闭源/商用可能性 → 不能照抄它们的做法**。我们的参照系应该是 Audacity 的"外部工具"模型 + LGPL-only 构建。

### 4.5 预编译 LGPL 二进制的可得性（已核实，**这是个真问题**）

| 源 | 平台 | 是否有 LGPL 变体 |
|----|------|------------------|
| **BtbN/FFmpeg-Builds** | Windows x64/arm64、Linux x64/arm64 | ✅ **有**。最新 release（2026-08-01）资产含 `ffmpeg-master-latest-win64-lgpl.zip`、`...-linux64-lgpl.tar.xz` 等，static/shared 均有。README："`lgpl` Lacking libraries that are GPL-only. Most prominently libx264 and libx265." |
| **BtbN/FFmpeg-Builds** | **macOS** | ❌ **完全不提供 macOS 构建** |
| gyan.dev | Windows | ❌ 全部 GPLv3："All builds are 64-bit, static and licensed as GPLv3" |
| evermeet.cx | macOS | ❌ configure 含 `--enable-gpl --enable-libx264 --enable-libx265 --enable-version3` → GPLv3 构建 |
| ffmpeg-static (npm) | 全平台 | ❌ 包自报 `GPL-3.0-or-later`；二进制取自 gyan.dev / evermeet / johnvansickle |

> 🔴 **macOS 的维护中的 LGPL-only 预编译源 = UNKNOWN / 本次未找到。**

**→ 这直接决定了引入方式**：我们**必须把 FFmpeg 源码作为 submodule 引入，在自己的 CI 里编译 LGPL-only 构建**（至少 macOS 必须自建）。
这恰好也让 C2 的 submodule 要求在 FFmpeg 这个最棘手的组件上**名副其实**。

推荐 configure（草案，**未跑通验证**）：
```
./configure --prefix=... \
  --disable-gpl --disable-nonfree --disable-version3 \
  --disable-doc --disable-programs --enable-ffmpeg \
  --disable-encoders --enable-encoder=pcm_s16le,libopus,flac \
  --enable-libopus \
  --disable-x86asm=no
```
⚠️ **注意**：`libopus` 是 BSD-3（LGPL 兼容 🟢）；**不要**加 `--enable-libfdk-aac`（nonfree）。

---

## §5 专题：yt-dlp 的许可证与法律风险

### 5.1 许可证：**分层的**，这是最容易踩的坑（已核实 README `#### Licensing` 第 139–149 行）

| 分发形态 | 许可证 |
|----------|--------|
| **git 仓库 / PyPI sdist / PyPI wheel** | **Unlicense**（公有领域）。原文："The git repository, the PyPI source distribution and the PyPI built distribution (wheel) only contain code licensed under the Unlicense." |
| **官方 PyInstaller release 二进制**（`yt-dlp.exe` / `yt-dlp_macos` / `yt-dlp_linux`） | **GPLv3+**。原文："the PyInstaller-bundled executables include GPLv3+ licensed code, and as such the combined work is licensed under GPLv3+." |
| zipimport `yt-dlp` + `yt-dlp.tar.gz` | 含 ISC（meriyah）+ MIT（astring） |

🔴 **推论**：**任何"捆绑官方 release 二进制"的方案都会把 GPLv3+ 拉进我们的分发物**，直接摧毁闭源可能性。
（最新 release：`2026.07.04`，24 个资产，含 SHA256/512 + `.sig` 签名 — 已核实）

### 5.2 法律风险（已核实）

| 事件 | 结果 |
|------|------|
| RIAA DMCA 下架 youtube-dl（2020-10） | GitHub 先下架，EFF 介入后 **2020-11-16 恢复**；EFF 论点：youtube-dl "does not decrypt video streams encrypted with commercial DRM technologies like Widevine" |
| Sony/Universal/Warner v. **Uberspace**（youtube-dl 网站托管商，德国） | 2022-01 起诉 → **2023-04 汉堡地院判托管商败诉** → **2024-11 汉堡高等法院驳回上诉，判决终局**。法院认定 YouTube 的 "rolling cipher" 是 "an effective protective measure" |
| yt-dlp（fork 本身）的诉讼 | **未找到 = UNKNOWN**。德国系列案针对的是 youtube-dl 及其网站托管商，不是 yt-dlp 或 GitHub |
| 美国关于"分发 stream-ripping 软件"的判决 | **UNKNOWN**，本次未查到直接判例 |

### 5.3 平台 ToS 与应用商店政策（已核实）

**YouTube ToS**（https://www.youtube.com/t/terms）：
- 禁止 "access, reproduce, download, distribute... any part of the Service or Content"，除非 "expressly authorized by the Service"；
- 禁止 "circumvent, disable... any part of the Service"，包括 "features that block or limit copying"；
- 内容使用限于 "personal, non-commercial use"。

**Apple App Store Review Guidelines 5.2.3**：
> "Apps should not facilitate illegal file sharing or include the ability to save, convert, or download media from third-party sources (e.g. Apple Music, YouTube, SoundCloud, Vimeo, etc.) **without explicit authorization from those sources**."

**Google Play**：
> "Streaming apps that allow users to download a local copy of copyrighted content without authorization are prohibited."

**Microsoft Store**：未找到明确的 stream-ripping 禁令；实践上更宽松（Open Video Downloader 已上架 MS Store）。

### 5.4 同类桌面产品怎么做（已核实）

| 产品 | yt-dlp 获取方式 | 上架情况 |
|------|----------------|----------|
| Stacher | 启动时**自动下载/更新** yt-dlp | 仅官网直下 |
| Parabolic (Nickvision) | **捆绑**二进制，随版本更新 | Flathub |
| Open Video Downloader (jely2002) | 随应用附带 + 自动更新；**本身 AGPL-3.0** | **Microsoft Store** + GitHub + Homebrew/WinGet |
| Tartube | 独立安装包**捆绑 FFmpeg + yt-dlp**；另发"Strict"包（关闭应用内更新）供 Debian 等严格仓库 | SourceForge / Flathub / Snap / AUR |
| Media Downloader | **运行时下载**：首次启动 "will attempt to use the internet to download the latest version of yt-dlp" | Flathub |
| Downie（商业） | 自研提取器 | **明确不上 Apple App Store**（开发者自述："Apple doesn't allow apps that download videos from YouTube on the App Store"） |

**共同模式**：**没有任何一个把 yt-dlp 相关功能送进 Apple / Google 商店**；全部走 GitHub Releases / Flathub / 官网直下（唯一例外是 MS Store）。捆绑与运行时下载两种都常见。

### 5.5 **给 OpenMemo 的建议（推荐方案）**

```
F1「音视频链接导入」拆成两个能力：

【核心能力 · 随产品分发 · 零风险】
  - 播客 RSS enclosure 下载（feed-rs / rss crate，MIT/Apache）
  - 通用直链 HTTP 下载（reqwest）
  - 本地文件导入（F2）
  → 这些是"普通 HTTP GET"，不涉及任何技术措施规避

【扩展能力 · 可选插件 · 默认关闭】
  - "高级来源支持"：首次使用时弹窗 → 用户明确同意 →
    从 yt-dlp 官方 GitHub Releases 下载二进制到用户数据目录
  - 我们只分发一个 ~200 行的 CLI 包装层（子进程 + --dump-json 解析）
  - 弹窗必须包含：来源链接、许可证(GPLv3+)、
    "请确保你的使用符合目标网站服务条款与当地法律"的免责声明
```

**这个方案同时满足**：
1. 我们的分发物里**没有 GPLv3+ 代码** → 保住闭源/商用（§5.1 的坑被绕开）；
2. 二进制由**用户主动触发下载**，我们不是分发者 → 规避 §5.2 的分发风险；
3. 若将来要上 Mac App Store，只需在该渠道构建里**编译期关掉这个插件**，主功能不受影响（Apple 5.2.3）；
4. 与 Media Downloader / Stacher 的既有做法一致，有先例。

⚠️ **需法务确认**：即使是"运行时下载"，仍可能被论证为"提供规避工具的便利"（德国判决对**托管方**的认定即属此类外溢）。上线前需律师审阅免责声明措辞与默认开关状态。

---

## §6 🔴 必须避免 / ⚠️ 需法务确认

### 6.1 必须避免（硬红线，全部已核实）

| # | 项目 | 原因 |
|---|------|------|
| 1 | ~~**`ffmpeg-static` npm 包**~~ **← 已被 ADR-002 v2 放行** | 包自报 `GPL-3.0-or-later`；二进制来自 gyan.dev/evermeet 的 GPL 构建。装了就等于分发 GPLv3 二进制。<br>📝 **此前本行是硬红线。** `ADR-002:22`（v2）在"个人自用、不对外分发"档下明文 **✅ 允许使用**。当前依赖里确实没有它，但那是 T-145 以"减少第二条依赖通道"为由删的，**不是执行本条红线** |
| 2 | **任何 `--enable-nonfree` 的 FFmpeg 构建** | 官方明文：**unredistributable**。任何形式的分发都是侵权 |
| 3 | **`--enable-gpl` 的 FFmpeg 构建**（x264/x265/frei0r/librubberband/libvidstab/libxvid…） | 我们只做音频，根本不需要；用了就是 GPL |
| 4 | ~~**捆绑 yt-dlp 官方 release 二进制**~~ **← 已被 ADR-002 v2 推翻，且已发货** | PyInstaller 打包引入 GPLv3+，污染整个分发物。<br>📝 **此前本行是硬红线。** 用户明确决定直接内置（`ADR-002:14,23` v2 决策 2「F1 直接内置 yt-dlp，不做双路径区分」）；`vendor/manifests/backends.json` 里 `ytdlp-{linux-x64,linux-arm64,macos-arm64,win-x64}` 4 个包全部指向 yt-dlp 官方 release 2026.07.04。GPLv3+ 义务记在各包的 `license` 字段 |
| 5 | **tldraw** | 专有 tldraw license，Production Environment 需另购授权 |
| 6 | **ten-vad** | Apache-2.0 + "may not Deploy... in a way that competes with Agora's offerings" 非竞争条款，非 OSI 开源 |
| 7 | **`@blocknote/xl-*` 系列包** | GPL-3.0（core 的 MPL-2.0 可用，但必须在 lockfile 层面确保 xl-* 不被间接引入） |
| 8 | **`@tiptap-pro/*` / TipTap Collaboration / AI Toolkit / Comments** | 付费专有许可，且"may not distribute the Software... as a standalone product" |
| 9 | **Meilisearch**（含 BUSL-1.1 的 EE 部分） | `SPDX: MIT AND BUSL-1.1`；我们也不需要独立 server |
| 10 | **Moonshine 非英语模型** | Moonshine Community License = 非商用 |
| 11 | **修改 Symphonia / BlockNote core 的源文件** | MPL-2.0 是 file-level copyleft，改了就必须公开那些文件 |
| 12 | 把任何 **GPL/AGPL 组件做成 submodule** | 违反 §1.3 规则 R-A，削弱进程隔离论证 |

**建议的 CI 强制手段**（写进 T-011）：
- `cargo-deny` + `license-checker-rseidelsohn`（或 `license-checker`）在 CI 里跑**许可证白名单**，命中 GPL/AGPL/BUSL/专有 即 fail；
- 白名单：`MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, MPL-2.0, Unlicense, CC0-1.0, 0BSD, Zlib, Public Domain`；
- 单独的二进制资产清单校验：`vendor/manifests/*.json` 里每个条目必须有 `license` 字段和 `sha256`。

### 6.2 需法务确认

| # | 问题 | 说明 |
|---|------|------|
| L-1 | **CLI 子进程边界是否构成衍生作品** | FSF FAQ 明确支持"独立程序"（§4.3），但这是版权方解释而非判例。建议律师出具书面意见 |
| L-2 | **LGPL §6(b) 的"用户可替换库"要求 与 macOS 代码签名 / hardened runtime 的张力** | 若最终选择动态链接而非 CLI |
| L-3 | **yt-dlp 运行时下载方案的溢出风险** | 德国 OLG Hamburg 2024 终审对**托管方**的认定；我们的免责声明措辞与默认关闭状态需律师审阅 |
| L-4 | **Apple 5.2.3 / Google Play 政策** | 若未来要上架，必须有编译期开关剔除下载功能 |
| L-5 | **所有模型权重的许可证** | 与代码许可证无关。Whisper(MIT) / Llama / Qwen / Gemma / NeMo titanet / 3D-Speaker embedding — **本次全部未逐个核实 = UNKNOWN**。移交 `model-mgmt`(R-04) |
| L-6 | **libsimple 的双授权选择须书面化** | MIT OR GPL-3.0，必须在 NOTICE / THIRD_PARTY_LICENSES 中明确"我们选择 MIT" |
| L-7 | **SQLCipher 商业版条款** | 社区版 BSD-3-Clause 已核实；若用到商业特性，条款**未核实** |
| L-8 | **shadcn/ui 源码复制模式 vs C2** | 非法务问题，是工程规范问题，需 ADR 明确豁免 |

---

## §7 `vendor/` 目录布局 + `.gitmodules` 草案

> ⚠️ **本节仅为草案，未执行任何 git 命令**（遵守任务边界，等 Manager 批准 ADR 后由 T-011 执行）。
> 所有 tag / commit 需在执行时重新核对最新稳定版。

### 7.1 目录布局

```
vendor/
├── README.md                       # 说明 §1 判定规则 + 每个 submodule 的用途与许可证
├── THIRD_PARTY_LICENSES.md         # 汇总所有第三方许可证全文（CI 自动生成 + 人工补充）
│
├── ffmpeg/                         # [submodule] LGPL-2.1+ — 仅供 CI 编译 LGPL-only 构建
├── whisper.cpp/                    # [submodule] MIT
├── sherpa-onnx/                    # [submodule] Apache-2.0 — ASR/VAD/diarization 三合一
├── llama.cpp/                      # [submodule] MIT
├── sqlite-vec/                     # [submodule] Apache-2.0 — SQLite 向量扩展
├── libsimple/                      # [submodule] MIT OR GPL-3.0（我们选 MIT）— FTS5 中文分词
│
├── patches/                        # 我们对 submodule 的补丁（规则 R-B：不直接改 submodule 内容）
│   ├── ffmpeg/                     #   若最终需要 fork，改为 fork + 分支，此目录仅存过渡期补丁
│   ├── whisper.cpp/
│   └── README.md                   #   每个补丁必须写明：为什么、上游 PR 链接（若已提交）
│
├── manifests/                      # 【C】运行时下载清单（纯 JSON，进 git，不是 submodule）
│   ├── schema.json                 #   清单的 JSON Schema
│   ├── ffmpeg.json                 #   我们 CI 产出的 LGPL FFmpeg 二进制（平台 × 版本 × sha256）
│   ├── yt-dlp.json                 #   官方 release 直链 + sha256 + license: "GPL-3.0-or-later"
│   ├── runtimes.json               #   GPU 后端运行时（CUDA/ROCm/Vulkan 相关）— 交叉引用 R-02
│   ├── models.asr.json             #   Whisper/Paraformer 等 ggml/onnx 权重 — 交叉引用 R-04
│   ├── models.vad.json             #   ggml-silero-v6.2.0.bin 等
│   ├── models.diarization.json     #   sherpa-onnx segmentation + embedding 模型
│   └── models.llm.json             #   GGUF 权重 — 交叉引用 R-04
│
└── scripts/                        # 编译脚本（不属于 submodule）
    ├── build-ffmpeg-lgpl.sh
    ├── build-whisper-matrix.sh
    ├── build-sherpa.sh
    ├── build-llama-matrix.sh
    └── build-sqlite-exts.sh
```

**manifest 条目格式草案**（`vendor/manifests/yt-dlp.json`）：
```json
{
  "$schema": "./schema.json",
  "component": "yt-dlp",
  "optional": true,
  "default_enabled": false,
  "license": "GPL-3.0-or-later",
  "license_note": "Official PyInstaller release binaries are GPLv3+. NOT redistributed by OpenMemo; downloaded by the user on explicit opt-in.",
  "upstream": "https://github.com/yt-dlp/yt-dlp",
  "version": "2026.07.04",
  "artifacts": [
    { "platform": "windows-x86_64", "url": "https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp.exe",    "sha256": "TODO-fill-at-pin-time" },
    { "platform": "macos-universal","url": "https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp_macos",  "sha256": "TODO" },
    { "platform": "linux-x86_64",   "url": "https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp_linux",  "sha256": "TODO" }
  ]
}
```

### 7.2 `.gitmodules` 草案

```ini
# vendor/ 下的 submodule 一律 pin 到 tag/commit（规则 R-C）。
# 建议 clone 时用：git submodule update --init --depth 1 --recommend-shallow
# ⚠️ 以下 tag 为 2026-08-02 的调研快照，执行前必须重新核对最新稳定版。

[submodule "vendor/ffmpeg"]
	path = vendor/ffmpeg
	url = https://github.com/FFmpeg/FFmpeg.git
	shallow = true
	# LGPL-2.1+ | 仅用于 CI 编译 LGPL-only 构建（--disable-gpl --disable-nonfree）
	# pin: 执行时选择最新 release tag（如 n7.x），不要跟 master

[submodule "vendor/whisper.cpp"]
	path = vendor/whisper.cpp
	url = https://github.com/ggml-org/whisper.cpp.git
	shallow = true
	# MIT | pin: v1.9.1（2026-06-19，已核实为当时 latest release）
	# 最终版本以 R-02 (gpu-runtime) 的结论为准

[submodule "vendor/sherpa-onnx"]
	path = vendor/sherpa-onnx
	url = https://github.com/k2-fsa/sherpa-onnx.git
	shallow = true
	# Apache-2.0 | ASR + VAD + speaker diarization
	# pin: 执行时取最新 release tag

[submodule "vendor/llama.cpp"]
	path = vendor/llama.cpp
	url = https://github.com/ggml-org/llama.cpp.git
	shallow = true
	# MIT | 与 whisper.cpp 共用 ggml 后端编译矩阵
	# pin: 执行时取最新 release tag（llama.cpp 用 bNNNN 形式）

[submodule "vendor/sqlite-vec"]
	path = vendor/sqlite-vec
	url = https://github.com/asg017/sqlite-vec.git
	shallow = true
	# Apache-2.0 (npm 自报 "MIT OR Apache") | pin: v0.1.9（2026-03-31，已核实）
	# ⚠️ 0.1.x，磁盘格式可能变更 → 索引必须可重建

[submodule "vendor/libsimple"]
	path = vendor/libsimple
	url = https://github.com/wangfenjin/simple.git
	shallow = true
	# 双授权 MIT OR GPL-3.0 —— 【我们选择 MIT】，须在 THIRD_PARTY_LICENSES.md 书面声明
	# FTS5 中文分词 tokenizer | pin: v0.7.1（2026-02-23，已核实）
```

### 7.3 **不做 submodule** 的组件及理由（写进 ADR 备查）

| 组件 | 为什么不 submodule |
|------|-------------------|
| React / TipTap / mind-elixir / Tailwind / shadcn 等全部前端库 | 规则【B】：npm 需要参与版本求解与 dedupe；submodule 会导致重复实例与 peer-dep 冲突 |
| rusqlite / symphonia / rubato / tokio / reqwest / sherpa-rs | 规则【B】：cargo 版本求解 + `cargo audit` 覆盖 |
| Tauri 及其全部官方插件 | 规则【B】：Tauri 的 CLI/构建流程假定 crate+npm 依赖 |
| **yt-dlp** | 规则【C】+ **规则 R-A**：release 二进制是 GPLv3+，绝不能进构建树。运行时下载 |
| ASR / LLM / VAD / diarization **模型权重** | 规则【C】：二进制资产不进 git；且许可证各异需隔离 |
| GPU 后端运行时（CUDA/ROCm 等） | 规则【C】：体积巨大 + 平台相关 + 各自的 EULA |
| Silero VAD | 规则【C】：只需要模型文件；推理由 whisper.cpp / sherpa-onnx 完成 |

---

## §8 未验证项与缺口（诚实清单）

| # | 项目 | 状态 |
|---|------|------|
| U-1 | **未执行任何编译/构建**。本任务为选型调研，所有"可行"结论均为**基于文档与元数据的判断，未跑通** | 未跑通 |
| U-2 | **macOS 的 LGPL-only FFmpeg 预编译源** | `UNKNOWN` — 本次未找到维护中的源，故推荐自建 |
| U-3 | sherpa-onnx 各 **diarization/embedding 模型权重**的具体许可证（NeMo titanet、3D-Speaker） | `UNKNOWN` — 需逐个核实 |
| U-4 | Whisper / Llama / Qwen / Gemma 等 **LLM 与 ASR 模型权重**许可证 | `UNKNOWN` — 移交 R-04 |
| U-5 | rusqlite `bundled` feature 与 `SQLITE_ENABLE_LOAD_EXTENSION` 的组合是否能加载 libsimple/sqlite-vec | 未验证 — T-011 必须实测 |
| U-6 | Tauri 在 **Linux WebKitGTK** 上渲染复杂 SVG 思维导图的表现 | 未验证 |
| U-7 | Electron vs Tauri 的**具体体积/内存数字** | `UNKNOWN` — 未实测，文中未给数字 |
| U-8 | HandBrake / OBS / Shotcut / Kdenlive 的 FFmpeg 捆绑细节 | 二手来源，未从一手文档核实 |
| U-9 | yt-dlp 的 release 发布**频率**（只核实了最新一次 2026-07-04） | 未量化 |
| U-10 | SQLCipher 商业版条款；GoJS 等商业导图库 | 未核实（未纳入候选） |
| U-11 | **R-02（gpu-runtime）尚未产出**，D3 的引擎结论以其为准；本文只给集成方式 | 依赖未就绪 |
