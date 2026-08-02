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
