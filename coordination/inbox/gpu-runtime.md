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
