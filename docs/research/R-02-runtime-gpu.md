---
id: R-02
author: gpu-runtime
status: ready-with-corrections
date: 2026-08-02
corrected-date: 2026-08-06
---

# ⚠️ 读之前先看：一条核心结论已被 ADR-015 推翻（2026-08-06 订正）

> **此前本文标 `status: ready`**，其「**必须自建 whisper.cpp CI（约 1 人周）**」的结论
> （`:11` 与 `:17` 两处）被当作待办引用。**该结论已被 `ADR-015-upstream-first.md` 明文推翻。**
>
> | 项 | 此前写着 | 现在 |
> | --- | --- | --- |
> | whisper.cpp 二进制来源 | **一律自建**（GitHub Actions 矩阵） | **上游预编译优先**：`ADR-015:47-51`「manifest 一律填上游地址」。`ADR-015:7` 明写 `supersedes: ADR-003 决策 2（自建 whisper.cpp CI）的适用范围` |
> | 自建的适用范围 | 全平台 | **收窄为：仅当用户实际需要 macOS / Vulkan / ROCm 时才启用** |
> | 成本估算「约 1 人周」 | 作为必付成本列出 | 变成**按需成本**；Linux / Windows 路径不再需要它 |
>
> **⚠️ 但本文的论据事实上仍然成立** —— 官方 release 覆盖确实窄（v1.9.1 只有 Win cpu/blas/cublas +
> Linux cpu + iOS xcframework，无 macOS CLI / 无 Vulkan / 无 ROCm）。**变的是结论，不是事实。**
> 后果今天仍在：`vendor/manifests/backends.json` **零个** vulkan / rocm / metal / coreml 包，
> 见 `docs/design/D-11-ci-platform-facts.md:15-18` 与 `docs/research/R-06-memo-ac-gap.md` §6 第 4 条。
>
> 本文其余部分（`GGML_BACKEND_DL` 机制、CUDA 体积实测、分层降级链、签名调研、LLM 三档）未发现失效。

## TL;DR（≤ 25 行，Manager 只读这里）

- **决定性发现（已验证）**：ggml 的 `GGML_BACKEND_DL=ON` 让后端编译成独立 `.dll/.so`，运行时扫描目录、打分、失败静默跳过。whisper.cpp 官方 release CI 已启用。我实测拆开官方 zip：CPU 包与 CUDA 包**目录结构完全一致**，CUDA 包只是多了 `ggml-cuda.dll` + CUDA 运行时 DLL。→ **要求 2.1「网页下载对应后端」= 往同一目录再丢一个 dll**，是 ggml 一等公民能力，不是 hack。
- **ASR 明确推荐：whisper.cpp（ggml）为主引擎，~~但二进制我们自己在 GitHub Actions 出~~**。理由：官方 release 覆盖太窄（已核实 v1.9.1 只有 Win cpu/blas/cublas + Linux cpu + iOS xcframework，**无 macOS CLI、无 Vulkan、无 ROCm**），而源码 `-DGGML_VULKAN=1 / -DGGML_HIP=1 / -DWHISPER_COREML=1` 全部支持。
  > 📝 **此前本行写「二进制我们自己在 GitHub Actions 出」**（无条件自建）。**已被 ADR-015 推翻**：改为
  > **上游预编译优先**，Linux/Windows 走上游地址，macOS/Vulkan/ROCm **按需**才自建。**括号里的覆盖窄事实仍成立。**
- **淘汰 faster-whisper/CTranslate2**：已核实 Apple Silicon **不支持 Metal/MPS**（`device="mps"` 直接报错），且 cuBLAS/cuDNN **不打包**、要用户装 `nvidia-*` pip 包 + 配 `LD_LIBRARY_PATH`。违反"不碰命令行"。
- **CUDA 体积是最大现实问题（已实测）**：官方 `whisper-cublas-12.4.0-bin-x64.zip` = **677.9 MB**，解压 1.21 GB；其中 `cublasLt64_12.dll` 328 MB、`ggml-cuda.dll` 251 MB（多架构 fat binary）。对比 llama.cpp `win-vulkan-x64` 仅 **32.51 MB**。→ 建议**自建单架构 CUDA 包**（按检测到的 compute capability 分发）+ **把 Vulkan 作为 NVIDIA 用户的"小包"选项**。
- **分层降级链（推荐方案）**：`L0 浏览器 WebGPU（零安装兜底）` → `L1 随安装包内置 CPU（~10-20 MB，永远可用）` → `L2 按需下载加速后端包（Metal 内置/CUDA/Vulkan/ROCm）`。探测用**独立子进程**跑我们自建的 `ggml probe`，超时 + 崩溃隔离。
- **签名是能落地的关键，结论如下**：macOS 上 Apple Silicon **所有可执行文件必须至少 ad-hoc 签名才能运行**（Apple 官方声明）；`stapler` **不能** staple 裸 Mach-O（Apple DTS 工程师原话），只支持 .app/.dmg/.pkg。→ 我们必须用**自己的 Developer ID 重签所有下载的二进制**（否则 hardened runtime 的 library validation 会拒绝加载），notarize zip，靠"自己下载不打 quarantine xattr"绕开 Gatekeeper 首次运行拦截 + `xattr -dr` 兜底。Windows 侧：程序化下载不带 MOTW，SmartScreen 只拦用户浏览器下载的安装包 → 签安装包即可；**EV 证书已不再给即时 SmartScreen 信誉**（微软 2024 根程序变更）。
- **LLM 明确推荐三档**：① BYO API Key（Anthropic/OpenAI/DeepSeek/任意 OpenAI 兼容 base_url）为默认；② 探测复用已装的 Ollama(`:11434`)/LM Studio(`:1234`)；③ 内置 llama.cpp `llama-server`——它的官方预编译矩阵**极其完整**（Win: cpu/cuda/vulkan/hip/sycl/openvino；Linux: cpu/vulkan/rocm/sycl/openvino；macOS: arm64+x64），可直接用，不必自建。
- **关键取舍**：为了 macOS + Vulkan + ROCm 覆盖，~~我们必须自建 whisper.cpp CI（约 1 人周）~~，换来完整的要求 2.1 落地能力。不自建则 mac 用户没有可下载的 CLI 二进制。
  > 📝 **此前本行写「必须自建（约 1 人周）」并把它当作必付成本。** ADR-015 把它改成**按需成本**：
  > `ADR-015:47-51` 「manifest 一律填上游地址…适用范围收窄为：仅当用户实际需要 macOS/Vulkan/ROCm 时才启用」。
  > **今天的实况**：macOS-arm64 CPU 后端已发布（`backends.json` 的 `whispercpp-cpu-macos-arm64`），
  > 而 **Vulkan / ROCm / Metal / CoreML 仍然零产物** —— 本行的警告在那三条上依然有效。
- **未验证/存疑**：① Vulkan vs CUDA 在 whisper 推理上的相对性能 —— **UNKNOWN，无可信数据，必须做 spike 实测**；② whisper.cpp 官方 bench 帖里**没有任何 GPU 数字**（只有 CPU/WASM）；③ 单架构 CUDA 包能压到多小 —— 未实测；④ llama.cpp 编出的 `ggml-cuda.dll` 能否被 whisper.cpp 直接复用（ggml soname 已验证为 `0.15.1`，ABI 需实测）；⑤ macOS 15/26 上"自己下载不打 quarantine"是否仍成立 —— **无 mac 机器，未验证**；⑥ Azure Trusted Signing 具体美元价格（页面动态渲染，UNKNOWN）。
- **对其他 agent 的影响**：架构组请按「本地 daemon（Node 或 Rust）+ 子进程 probe + 后端包管理器」设计；网页只跟 daemon 的 REST/WS 通；模型下载（要求 2.2）与后端包下载共用同一套 manifest/sha256/断点续传组件。CI 组请预留 GitHub Actions self-built whisper.cpp 矩阵。

---

# 详细内容

> **诚实标记约定**：
> `[已验证]` = 我在本机（Linux x86_64, 无 GPU）实际跑过命令或实际拉取/解析了字节。
> `[已核实]` = 我或我派出的 subagent 实地抓取了官方页面/API 并引用了原文。
> `[未验证]` = 合理推断，没有实证。
> `UNKNOWN` = 查不到，禁止编造。
> 本机环境：`Linux 7.1.3+deb14-cloud-amd64 x86_64`，CPU `AMD RYZEN AI MAX+ 395`（KVM 虚拟机，32 vCPU，15.6 GB RAM），**无 GPU、无 /dev/dri、无 nvidia-smi/rocminfo/vulkaninfo**。mac/Windows 侧一律**未验证**。

---

## A. 硬件检测

### A.0 最重要的一条经验（本机实测得出）

我在本机跑了探针，得到一个反直觉但极其重要的结果 `[已验证]`：

```
libvulkan.so.1 => /usr/lib/x86_64-linux-gnu/libvulkan.so.1      # 存在！
libOpenCL.so.1 => /usr/lib/x86_64-linux-gnu/libOpenCL.so.1      # 存在！
/sys/class/drm  => (空)
/dev/dri        => 不存在
lspci 0300      => 00:02.0 VGA compatible controller [1234:1111]  # QEMU 虚拟显卡
```

即：**Vulkan loader 和 OpenCL loader 都在，但机器上根本没有可用 GPU。**
`libvulkan.so.1` 是 Debian 很多桌面包的传递依赖，它的存在**完全不能**证明有可用的 Vulkan 设备（loader ≠ ICD ≠ 硬件）。

→ **设计结论（硬性）**：
1. 文件/命令的**存在性检测只能作为"建议性预判"**（advisory pre-check），用来决定"先下哪个包"。
2. **唯一权威的判定是：真的把后端加载起来、真的枚举出设备数 > 0。**
3. 因此我们必须自建一个极小的 **probe 二进制**（~50 行 C，链接 ggml），调用
   `ggml_backend_load_all()` → `ggml_backend_dev_count()` → `ggml_backend_dev_get_props()`，
   输出 JSON。**在独立子进程中运行，带超时。**（Ollama 官方文档明确记载 AMD 驱动过旧时"GPU 初始化会在设备发现阶段挂起直到超时" `[已核实]` —— 所以超时不是可选项。）

### A.1 分平台检测手段

#### macOS `[未验证 —— 无 mac 机器]`

| 目标 | 手段 | 无驱动时 | 备注 |
|------|------|----------|------|
| 芯片名/架构 | `sysctl -n machdep.cpu.brand_string`；`sysctl -n hw.optional.arm64`（1 = Apple Silicon） | 不会失败 | 内核内置 |
| Intel Mac AVX2 | `sysctl -n machdep.cpu.leaf7_features` 里含 `AVX2` | 不会失败 | Apple Silicon 上此 key 不存在，需容错 |
| 物理核/性能核 | `sysctl -n hw.perflevel0.physicalcpu`（P 核）/ `hw.perflevel1.physicalcpu`（E 核） | Intel 上 key 不存在 | ggml 线程数建议按 P 核数设 |
| 内存 | `sysctl -n hw.memsize` | 不会失败 | Apple Silicon 统一内存，"显存"= 系统内存 |
| GPU 型号 / Metal | `system_profiler -json SPDisplaysDataType` → `sppci_model`、`spdisplays_mtlgpufamilysupport` | 不会失败 | **耗时可达数秒，必须缓存**。加 `-detailLevel mini` |
| 机型 | `system_profiler -json SPHardwareDataType` | 不会失败 | |
| GPU 可用显存上限 | `sysctl iogpu.wired_limit_mb`（0 = 系统默认，约 RAM 的 65-75%） | 不会失败 | 决定能不能装 large-v3 |

**Metal 不需要检测驱动**：macOS 10.13+ 的所有 Mac 都有 Metal，Metal shader 用 `GGML_METAL_EMBED_LIBRARY=ON` 直接嵌进二进制（whisper.cpp release CI 已用此 flag `[已验证]`），**Metal 后端零额外下载**。这是 mac 侧最大的好消息。

**CoreML/ANE**：whisper.cpp README 明确写 `[已核实]`：Encoder 可走 ANE，"can result in significant speed-up - more than x3 faster compared with CPU-only execution"（**注意这是 vs CPU-only，不是 vs Metal**）。但代价是需要**为每个模型单独生成 `.mlmodelc`**（`./models/generate-coreml-model.sh base.en`，依赖 Python + coremltools + Xcode CLT），且 README 明确说"The first run on a device is slow, since the ANE service compiles the Core ML model to some device-specific format"。
→ **建议：v1 不做 CoreML**。要做的话必须由我们在 CI 里预生成 `.mlmodelc` 并作为模型包的一部分分发，绝不能让用户装 Python。

#### Windows `[未验证 —— 无 Windows 机器]`

| 目标 | 首选手段 | 降级手段 | 坑 |
|------|----------|----------|-----|
| CPU 指令集 | `IsProcessorFeaturePresent(PF_AVX2_INSTRUCTIONS_AVAILABLE)` / 原生 `__cpuid` | Node `os.cpus()` 只给型号串 | **其实不必自己做**：ggml 的 `GGML_CPU_ALL_VARIANTS` 会自己选（见 C.2） |
| GPU 厂商/型号/显存 | **DXGI**：`CreateDXGIFactory1` → `IDXGIFactory6::EnumAdapterByGpuPreference` → `DXGI_ADAPTER_DESC1`（`VendorId`、`Description`、`DedicatedVideoMemory`） | PowerShell `Get-CimInstance Win32_VideoController` | ① **`wmic` 已弃用，Win11 24H2 起不在默认镜像里** —— 不要用 `wmic path win32_VideoController`；② `Win32_VideoController.AdapterRAM` 是 **uint32**，>4 GB 显存会回绕出错；③ DXGI 在 32 位进程里 `DedicatedVideoMemory` 也会被截到 4 GB → **daemon 必须是 64 位** |
| VendorId 对照 | `0x10DE`=NVIDIA, `0x1002`=AMD, `0x8086`=Intel, `0x1414`=Microsoft(WARP 软件渲染器，**必须排除**) | | 遇到 `0x1414` 说明没有真 GPU |
| NVIDIA 驱动/CUDA | `nvidia-smi --query-gpu=name,memory.total,driver_version,compute_cap --format=csv,noheader`（驱动装好时在 `C:\Windows\System32\nvidia-smi.exe`） | 直接 `LoadLibrary("nvml.dll")` 调 NVML | 没装驱动 → **命令不存在**，是干净的负信号。注意 `nvidia-smi` 报的是**驱动支持的最高 CUDA 版本**，不是已装 Toolkit 版本 |
| Vulkan | `LoadLibrary("vulkan-1.dll")` → `vkEnumerateInstanceVersion` → `vkCreateInstance` → `vkEnumeratePhysicalDevices`；显存看 `VkPhysicalDeviceMemoryProperties` 里 `DEVICE_LOCAL` heap | — | **不要依赖 `vulkaninfo.exe`**，它属于 Vulkan SDK，普通用户不会装。`vulkan-1.dll` 由显卡驱动装（NVIDIA/AMD/Intel 现代驱动都带） |
| DirectML | `DirectML.dll` 自 Win10 1903 起随系统；真正要查的是 D3D12 feature level ≥ 11_0 | — | 见 B.5 结论：**不推荐走 DirectML** |
| ROCm/HIP on Windows | HIP SDK 的 `hipInfo.exe` | — | 覆盖极差，见 C.4 |

#### Linux `[已验证]`

以下全部在本机实跑过：

| 目标 | 命令 | 本机实测结果 |
|------|------|--------------|
| 架构/内核 | `uname -m` / `uname -r` | `x86_64` / `7.1.3+deb14-cloud-amd64` ✅ |
| 指令集 | `grep -m1 ^flags /proc/cpuinfo` | 检出 `avx avx2 avx512f f16c fma sse4_2` ✅ |
| CPU 型号/核数 | `lscpu` / `nproc` | `AMD RYZEN AI MAX+ 395`, 32 ✅ |
| GPU 枚举 | `lspci -nn -d ::0300` | `00:02.0 VGA [1234:1111]`（QEMU 虚拟卡）✅ |
| GPU 厂商（无 lspci 时） | `cat /sys/class/drm/card*/device/vendor` | **本机 `/sys/class/drm` 为空** —— 必须容错 ✅ |
| AMD 显存 | `/sys/class/drm/card0/device/mem_info_vram_total`（amdgpu 驱动提供） | 不存在（无 GPU）✅ |
| NVIDIA | `nvidia-smi`；`/proc/driver/nvidia/version` | **均不存在** ✅ |
| CUDA 用户态库 | `ldconfig -p \| grep libcuda.so.1` | **NOT FOUND**（干净负信号）✅ |
| ROCm | `rocminfo` / `rocm-smi` / `/opt/rocm/.info/version` / `ldconfig -p \| grep libamdhip64` | 均不存在 ✅ |
| Vulkan | `ldconfig -p \| grep libvulkan.so.1` | **FOUND，但无 GPU** ⚠️ 见 A.0 |
| Vulkan ICD 清单 | `ls /usr/share/vulkan/icd.d/*.json` | 判断有没有真驱动的更好信号 |
| 权限坑 | `/dev/dri/render*` 需要用户在 `render`/`video` 组 | 本机无 `/dev/dri` |

**Linux 特有降级坑**：容器/WSL2/无头服务器上 `/dev/dri` 常缺失或权限不足。WSL2 有 `/dev/dxg` + `/usr/lib/wsl/lib/libcuda.so.1`（NVIDIA 在 WSL 走 D3D12 转译），需要单独识别（`grep -qi microsoft /proc/version`）。

### A.2 现成的库能不能用？

| 方案 | 评估 | 结论 |
|------|------|------|
| **`systeminformation` (npm)** | **本机实测 v5.33.1** `[已验证]`：`si.cpu()` / `si.cpuFlags()` / `si.osInfo()` **完全正确**（正确识别 AMD、avx512f、Debian、x64）。但 `si.graphics()` 返回 `{vendor:"", model:"", vram:16, pciID:""}` —— **厂商和型号全空**，识别失败。它内部就是 shell 调 `lspci`/`wmic`/`system_profiler` 再正则解析。 | **CPU/OS/内存/磁盘：用它。GPU：不要信它。** |
| **`wgpu` (Rust) `Instance::enumerate_adapters`** | 跨平台统一枚举（Vulkan/Metal/DX12/GL），返回 `AdapterInfo{ name, vendor, device, device_type, backend }`。优点：一次调用覆盖三大平台，且**它枚举出来的东西是真能用的**（因为它真的初始化了 API）。缺点：拿不到精确显存、拿不到 CUDA/ROCm 信息；引入 wgpu 依赖较重。 | **若 daemon 用 Rust，作为"advisory 预判"很好用。** 不能替代 ggml probe |
| **`ash` (Rust) / 直接 dlopen `vulkan-1.dll`/`libvulkan.so.1`** | 最轻量、最准确的 Vulkan 设备+显存来源 | **推荐**（比 wgpu 轻） |
| **`nvml-wrapper` (Rust) / `node-nvidia-smi` 等解析库** | NVML 是 NVIDIA 官方 C API，比解析 `nvidia-smi` 文本稳。但 npm 上的 nvidia-smi 解析库普遍年久失修 | **自己写 `--format=csv,noheader` 解析**（格式稳定），或直接 dlopen `nvml.dll`/`libnvidia-ml.so.1` |
| **DXGI（Windows）** | Win32 原生，无第三方依赖，最可靠 | **Windows GPU 检测首选** |
| **我们自建的 ggml probe** | 唯一权威 | **必做** |

**推荐组合**：
`systeminformation`（OS/CPU/RAM/磁盘） + 平台原生 GPU 预判（DXGI / `system_profiler` / `lspci`+`/sys`） + `nvidia-smi`/NVML（NVIDIA 详情） + **自建 ggml probe 子进程（最终裁定）**。

---

## B. ASR 引擎选型

### B.1 whisper.cpp —— 官方预编译产物实地核实

**仓库已改名**：`ggerganov/whisper.cpp` → **`ggml-org/whisper.cpp`**（旧地址重定向）`[已核实]`。License: MIT。
最新 release **`v1.9.1`，published 2026-06-19T05:53:19Z** `[已验证 —— 我直接调了 GitHub API]`。

**全部 9 个 asset（精确文件名 + 字节数）`[已核实]`**：

| 文件名 | 大小 | 平台/架构 | 后端 |
|--------|------|-----------|------|
| `whisper-bin-ubuntu-arm64.tar.gz` | 4,555,819 B | Linux arm64 | CPU |
| `whisper-bin-ubuntu-x64.tar.gz` | 9,379,235 B | Linux x64 | CPU |
| `whisper-bin-Win32.zip` | 5,068,706 B | Win x86 | CPU |
| `whisper-bin-x64.zip` | 7,982,101 B | Win x64 | CPU |
| `whisper-blas-bin-Win32.zip` | 12,100,146 B | Win x86 | OpenBLAS |
| `whisper-blas-bin-x64.zip` | 20,769,031 B | Win x64 | OpenBLAS |
| `whisper-cublas-11.8.0-bin-x64.zip` | 278,557,654 B | Win x64 | CUDA 11.8 |
| `whisper-cublas-12.4.0-bin-x64.zip` | **677,887,125 B** | Win x64 | CUDA 12.4 |
| `whisper-v1.9.1-xcframework.zip` | 50,438,515 B | Apple（嵌入用 framework） | Metal |

**关键缺口 `[已核实]`**：
- ❌ **没有 macOS 命令行二进制**（只有给 Xcode 嵌入的 xcframework）
- ❌ **没有 Vulkan 构建**
- ❌ **没有 ROCm/HIP 构建**
- ❌ 没有 Linux CUDA 构建

我进一步核实了 `.github/workflows/release.yml` `[已验证 —— 我下载并解析了该文件]`，其 job 只有：
`determine-tag / ubuntu-cpu / windows / windows-blas / windows-cublas / ios-xcode-build / release`。
用到的 ggml flag 统计：`GGML_NATIVE`(4) `GGML_CPU_ALL_VARIANTS`(4) `GGML_BACKEND_DL`(4) `GGML_BMI2`(2) `GGML_METAL_USE_BF16`(1) `GGML_METAL_EMBED_LIBRARY`(1) `GGML_CUDA`(1) `GGML_BLAS`(1)。
**确认无 `GGML_VULKAN` / `GGML_HIP`。**

但 **源码全部支持** `[已核实 —— README 原文]`：
```
cmake -B build -DGGML_CUDA=1                                  # NVIDIA
cmake -B build -DGGML_VULKAN=1                                # 跨厂商
cmake -B build -DGGML_HIP=1 -DAMDGPU_TARGETS="gfx1201"        # AMD ROCm
cmake -B build -DGGML_BLAS=1                                  # OpenBLAS
cmake -B build -DWHISPER_COREML=1                             # Apple ANE
cmake -B build -DWHISPER_OPENVINO=1                           # Intel
```

→ **这就是"我们必须自建 CI"的完整论据。**

### B.2 我实测拆开了官方 zip（这是本报告最有价值的一段）

我用 HTTP Range 请求只下载 zip 尾部的 central directory 并解析 `[已验证]`，得到 `whisper-cublas-12.4.0-bin-x64.zip` 的**完整清单与逐文件大小**：

```
Release/cublasLt64_12.dll            zip= 328.40MB  raw= 473.55MB   <-- 最大单体
Release/ggml-cuda.dll                zip= 251.44MB  raw= 564.59MB   <-- 多架构 fat binary
Release/cublas64_12.dll              zip=  70.15MB  raw= 100.03MB
Release/nvrtc64_120_0.dll            zip=  18.61MB  raw=  44.74MB
Release/nvrtc-builtins64_124.dll     zip=   1.18MB  raw=   5.37MB
Release/cudart64_12.dll              zip=   0.17MB  raw=   0.55MB
Release/nvblas64_12.dll              zip=   0.13MB  raw=   0.33MB
Release/ggml-base.dll                zip=   0.27MB
Release/ggml-cpu-{alderlake,cannonlake,cascadelake,haswell,icelake,
                  sandybridge,skylakex,sse42,x64}.dll     各 ~0.3MB
Release/ggml.dll  whisper.dll  parakeet.dll
Release/whisper-cli.exe  whisper-server.exe  whisper-stream.exe
Release/whisper-bench.exe  whisper-vad-speech-segments.exe
Release/parakeet-cli.exe  ... (共 44 项)
TOTAL entries=44  zipped=677.9MB  raw=1209.5MB
```

同样手法拆 `whisper-bin-x64.zip`（CPU 版，8 MB）`[已验证]`：
```
Release/ggml-base.dll
Release/ggml-cpu-{alderlake,cannonlake,cascadelake,haswell,icelake,
                  sandybridge,skylakex,sse42,x64}.dll
Release/ggml.dll  whisper.dll  parakeet.dll  SDL2.dll
Release/whisper-cli.exe  whisper-server.exe  ...  （与 CUDA 版完全同名同结构）
```

Linux tarball `whisper-bin-ubuntu-x64.tar.gz`（我完整下载并 `tar tzf` 了）`[已验证]`：
```
libggml-base.so.0.15.1   libggml.so.0.15.1   libwhisper.so.1.9.1   libparakeet.so.1.9.1
libggml-cpu-{ivybridge,haswell,skylakex,icelake,cascadelake,cooperlake,
             sapphirerapids,alderlake,piledriver,zen4,sse42,x64}.so
whisper-cli  whisper-server  whisper-bench  whisper-quantize
whisper-vad-speech-segments  parakeet-cli  parakeet-quantize  LICENSE
```

**三个可直接转化为架构决策的结论**：

1. **CPU 包和 CUDA 包的差集 = `ggml-cuda.dll` + 6 个 CUDA 运行时 DLL。其余 100% 相同。**
   → "按需下载加速后端"在 ggml 上就是**往同一目录多丢几个文件**。这正是要求 2.1 想要的形态。
2. **`cudart64_12.dll` / `cublas64_12.dll` / `cublasLt64_12.dll` / `nvrtc*` 全部随包分发** → **用户不需要装 CUDA Toolkit**，只需要**足够新的显卡驱动**（`libcuda.so.1` / `nvcuda.dll` 由驱动提供，不可分发）。**注意：没有 cuDNN**——whisper.cpp/ggml 不依赖 cuDNN（这是它相对 CTranslate2 的巨大优势）。
3. **`ggml-cpu-*.dll` 一堆微架构变体** = `GGML_CPU_ALL_VARIANTS=ON`。ggml 在运行时给每个候选 `.dll` 调 `ggml_backend_score()` 打分选最优（我读了 `ggml/src/ggml-backend-reg.cpp` 确认 `[已验证]`）。
   → **我们完全不需要自己检测 AVX2/AVX512** —— ggml 自己搞定，且对不支持的 CPU 静默跳过。

### B.3 ggml 动态后端加载机制（架构基石）`[已验证]`

llama.cpp `docs/build.md` 原文：
> "In most cases, it is possible to build and use multiple backends at the same time. For example, you can build llama.cpp with both CUDA and Vulkan support by using the `-DGGML_CUDA=ON -DGGML_VULKAN=ON` options with CMake. At runtime, you can specify which backend devices to use with the `--device` option. To see a list of available devices, use the `--list-devices` option."
>
> "**Backends can be built as dynamic libraries that can be loaded dynamically at runtime. This allows you to use the same llama.cpp binary on different machines with different GPUs.** To enable this feature, use the `GGML_BACKEND_DL` option when building."

我读了 `ggml/src/ggml-backend-reg.cpp` 源码确认其行为 `[已验证]`：
- 搜索路径顺序：`GGML_BACKEND_DIR`（编译期）→ **可执行文件所在目录** → 当前工作目录 → 用户指定路径。
- 对每个候选 `.so/.dll`：`dlopen` → 找 `ggml_backend_score()` → **`score()==0` 表示"不支持本机"，直接跳过**（日志 `backend %s is not supported on this system`）→ 找 `ggml_backend_init()` → 检查 API 版本兼容。
- `ggml_backend_load_all()` 内部 **`silent = true`**，即**加载失败不报错、不崩溃，安静跳过**。

→ **这就是天然的降级链**：把 `ggml-cuda.dll`、`ggml-vulkan.dll` 都丢进目录，能用哪个用哪个，一个都不能用就落回 `ggml-cpu-*.dll`。我们的降级逻辑只需要在**外层**加超时和崩溃隔离。

### B.4 whisper.cpp v1.9.1 已内置 Parakeet `[已验证]`

`include/` 目录下有 **`parakeet.h`（16,133 B）**，与 `whisper.h`（37,439 B）并列为公开头文件；release 产物里有 `parakeet-cli` / `libparakeet.so` / `parakeet.dll` / `test-parakeet-full-{jfk,gb1,diffusion}`。
但 **top-level README 完全没提 Parakeet** `[已验证 —— grep 无匹配]`，仓库也没有 `docs/` 目录。
→ 这是个**新加入、文档缺失**的能力。NVIDIA `parakeet-tdt-0.6b-v2` 是 **CC-BY-4.0**（可商用）`[已核实]`，Open ASR Leaderboard 上英文 avg WER **6.05**、RTFx **3380**（batch 128）`[已核实 —— 引自 HF model card]`。
→ **值得做一个 spike**：如果 whisper.cpp 的 parakeet 后端可用，我们可能同时拿到"最快 + 最准（英文）"，且**复用完全相同的后端分发管线**。标记为 **待验证的高价值方向**。

### B.5 候选对比与支持矩阵

#### 支持矩阵表：平台 × 后端 × 引擎（重点看"有无官方预编译产物"）

图例：`✅官` = 官方有预编译产物且可直接跑 · `🔧自建` = 源码支持，需我们 CI 出包 · `❌` = 不支持 · `⚠️` = 有但有重大附加条件

| 平台 / 硬件 | 后端 | **whisper.cpp** | **sherpa-onnx** | **faster-whisper (CT2)** | **ONNX Runtime GenAI/DML** | **transformers.js (浏览器)** |
|---|---|---|---|---|---|---|
| macOS Apple Silicon | Metal | 🔧自建（源码 `GGML_METAL`；官方只有 xcframework） | ❌（ORT 无 Metal EP） | ❌ **明确不支持 MPS** | ❌ | ✅ WebGPU |
| macOS Apple Silicon | CoreML/ANE | ⚠️ 源码支持，需预生成 `.mlmodelc` | ⚠️ ORT CoreML EP 标注 **(preview)** | ❌ | ❌ | — |
| macOS Apple Silicon | CPU | ✅官(xcfw)/🔧自建 CLI | ✅官 `sherpa-onnx-darwin-arm64` (npm) | ✅官 pip wheel `macosx_11_0_arm64` | ✅ | ✅ WASM |
| macOS Intel | CPU/AVX2 | 🔧自建 | ✅官 `sherpa-onnx-darwin-x64` | ✅官 wheel | ✅ | ✅ |
| Windows + NVIDIA | CUDA | ✅官 `whisper-cublas-12.4.0-bin-x64.zip`（**678 MB**） | ✅官 `...-cuda-12.x-cudnn-9.x-win-x64-cuda.tar.bz2` | ⚠️ 需自行装 `nvidia-cublas-cu12`+`nvidia-cudnn-cu12` | ✅ `onnxruntime-genai-cuda` | — |
| Windows + AMD | Vulkan | 🔧自建（源码 `GGML_VULKAN`） | ❌ 未见 Vulkan 产物 | ❌ | ❌ | ✅ WebGPU（走 D3D12） |
| Windows + AMD | DirectML | ❌ ggml 无 DML 后端 | ❔ 未在 asset 中观察到 | ❌ | ✅ `onnxruntime-directml` (PyPI 1.24.4) / `onnxruntime-node` **Windows 默认自带 DML** | — |
| Windows + AMD | ROCm/HIP | 🔧自建（`GGML_HIP`） | ❌ | ⚠️ 单独 release wheel | ⚠️ ORT ROCm EP 官方标 **(deprecated)** | — |
| Windows CPU | AVX2/AVX512 | ✅官 `whisper-bin-x64.zip`（8 MB） | ✅官 `sherpa-onnx-win-x64` (npm) | ✅官 wheel `win_amd64` | ✅ | ✅ WASM |
| Linux + NVIDIA | CUDA | 🔧自建（官方无 Linux CUDA 包） | ✅官 `...-cuda-12.x-cudnn-9.x-linux-x64-gpu.tar.bz2` | ⚠️ 同上 | ✅ `onnxruntime-node` **Linux x64 默认自动装 CUDA12** | — |
| Linux + AMD | ROCm | 🔧自建 | ❌ | ⚠️ | ⚠️ deprecated | — |
| Linux + AMD/Intel | Vulkan | 🔧自建 | ❌ | ❌ | ❌ | ⚠️ Firefox/Linux 尚未默认开 |
| Linux CPU | AVX2/AVX512 | ✅官 `whisper-bin-ubuntu-x64.tar.gz`（9 MB） | ✅官 `sherpa-onnx-linux-x64` (npm) | ✅官 wheel | ✅ | ✅ |
| Linux ARM64 | CPU/NEON | ✅官 `whisper-bin-ubuntu-arm64.tar.gz` | ✅官 `sherpa-onnx-linux-arm64` | ✅官 `manylinux_2_28_aarch64` | ✅ | — |

（ONNX Runtime EP 状态、`onnxruntime-node` 默认捆绑行为、CT2 wheel 平台、CT2 不支持 MPS —— 均 `[已核实]`，见附录 F 来源。）

#### 逐个候选评估

**① whisper.cpp（GGML）—— ✅ 推荐为主引擎**
- License **MIT**。C/C++ 零运行时依赖（不需要 Python、不需要 cuDNN）。
- 后端覆盖最广（Metal/CUDA/Vulkan/ROCm/BLAS/CPU/CoreML/OpenVINO/SYCL），且**共享同一套 `GGML_BACKEND_DL` 分发模型**。
- 自带 `whisper-server`（HTTP 服务）、`whisper-stream`（流式，F3 需要）、VAD（`whisper-vad-speech-segments`）、量化工具。
- 模型体积（GGML 格式，官方 `models/README.md` `[已验证]`）：
  `tiny 75 MiB` / `base 142 MiB` / `small 466 MiB` / `medium 1.5 GiB` / `large-v3 2.9 GiB` / **`large-v3-turbo 1.5 GiB`** / **`large-v3-turbo-q5_0 547 MiB`** / `large-v2-q5_0 1.1 GiB` / `large-v3-q5_0 1.1 GiB`。
- **缺点**：官方预编译矩阵窄（见 B.1）→ 必须自建 CI。
- **速度**：官方 bench 汇总帖（discussions/89）`[已核实]` **只有 CPU/WASM 数字，没有任何 GPU 数字**。摘录（encode 时间 ms，非 RTF）：
  | 机器 | 线程 | tiny | base | small | medium | large |
  |---|---|---|---|---|---|---|
  | MacBook M1 Pro (NEON+BLAS) | 8 | 102 | 220 | 685 | 1928 | 3350 |
  | Mac Mini M1 | 4 | 194 | 380 | 1249 | 3980 | 7979 |
  | Ryzen 9 5950X (AVX2) | 8 | 197 | 421 | 1393 | 4404 | 8118 |
  | Ryzen 9 3900X (AVX2) | 8 | 422 | 880 | 2874 | 9610 | 16917 |
  | Raspberry Pi 4 (NEON) | 4 | 13839 | 30552 | — | — | — |
  | M1 Pro / Firefox WASM | 8 | 2626 | 6226 | — | — | — |
  **⚠️ 这些是老数据（commit 206fc93 / fcf515d 时代）、且是 encode-only，不是端到端 RTF。不要拿去做产品承诺。**
  **whisper.cpp 各 GPU 后端的 RTF：UNKNOWN —— 必须自己测。**

**② faster-whisper / CTranslate2 —— ❌ 淘汰**
- License 均 MIT。pip wheel 覆盖 linux x86_64 / linux aarch64 / macOS arm64 / macOS x86_64 / win_amd64（`ctranslate2` 4.8.1, 2026-07-03）`[已核实]`。
- **致命伤 1：Apple Silicon 不支持 GPU**。`device="mps"` 抛 `ValueError: unsupported device mps`（OpenNMT/CTranslate2#1562、SYSTRAN/faster-whisper#911/#515）`[已核实]`。只能走 Accelerate 的 CPU 路径。macOS 是我们的一等平台 → 出局。
- **致命伤 2：CUDA 依赖不打包**。faster-whisper README 明确要求用户 `pip install nvidia-cublas-cu12 nvidia-cudnn-cu12==9.*` 并**手动设 `LD_LIBRARY_PATH`** `[已核实]`。直接违反"用户不碰命令行"。
- **致命伤 3：Python 运行时**。要么要求用户装 Python，要么我们打包 embedded Python（几百 MB + 平台适配地狱）。
- AMD：ROCm wheel 只在 GitHub releases 页，不在 PyPI。
- → **不用**。（精度上它和 whisper.cpp 同源同模型，没有换取代价的收益。）

**③ sherpa-onnx —— ✅ 推荐为"副引擎"（流式 + VAD + 非 Whisper 模型）**
- License **Apache-2.0**。最新版本 **v1.13.4（2026-07-07）**，约 300 个 asset `[已核实]`。
- **最大优势：npm 上有完整的 per-platform 预编译包** `[已核实]`：
  `sherpa-onnx-node@1.13.4` + `sherpa-onnx-{linux-x64, linux-arm64, darwin-arm64, darwin-x64, win-x64, win-ia32}@1.13.4`。
  → **Node 集成成本几乎为零**（`npm i` 就完事，optionalDependencies 按平台自动选）。这对我们的本地 daemon 极有吸引力。
- 后端：CPU 全平台；**CUDA 有官方产物**（`sherpa-onnx-v1.13.4-cuda-12.x-cudnn-9.x-{linux-x64-gpu,win-x64-cuda}.tar.bz2`）；另有 RKNN/AXCL 等 NPU。
  **Vulkan / DirectML / CoreML 变体：在抽样到的 asset 里未观察到；因 asset 列表被截断，标记为 ❔未确证，不能断言不存在。**
- 模型支持（官方文档确认 `[已核实]`）：Whisper（tiny.en~large-v3）、**Parakeet**（`sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8`，25 语言）、**Moonshine**、**SenseVoice**（中/英/日/韩/粤）。
- **定位建议**：用于 **F3 浏览器实时录音转写的流式后端**、**VAD/说话人分段**、以及"英文用 Parakeet 更快"的可选档位。不作为主引擎（因为它的 GPU 后端覆盖不如 ggml 广，且 ORT 的 ROCm EP 官方已标 deprecated）。

**④ ONNX Runtime GenAI / DirectML —— ⚠️ 不作为 ASR 方案，仅作 Windows-AMD 的备胎认知**
- `onnxruntime-directml`（PyPI 1.24.4, 2026-03-17, Windows only）与 `Microsoft.ML.OnnxRuntimeGenAI.DirectML`（NuGet）确有官方预编译 `[已核实]`。
- **`onnxruntime-node` 在 Windows x64/arm64 上默认就捆绑 DirectML**（还有 WebGPU）；在 Linux x64 上**默认自动装 CUDA 12 EP**（可用 `--onnxruntime-node-install=skip` 关掉）`[已核实 —— 引自 microsoft/onnxruntime `js/node/README.md`]`。这点很香。
- **但**：ggml 没有 DirectML 后端，whisper.cpp 走不了 DML。要用 DML 就得整条链换成 ORT（=换成 sherpa-onnx 或自己写 ORT 推理）。
- 另外 **ORT 的 ROCm EP 官方文档已标注 "(deprecated)"**（EP 列表里唯一被这样标的）`[已核实]` —— AMD Linux 路线在 ORT 上是死路。
- → **结论：Windows+AMD 走 Vulkan（ggml），不走 DirectML。** 保留 sherpa-onnx+DML 作为 Vulkan 失败时的"实验性备胎"。

**⑤ transformers.js + WebGPU —— ✅ 强烈推荐作为"零配置兜底档位 L0"，但要诚实标注限制**
- 模型（`onnx-community/*`，HF Files 页实测大小 `[已核实]`）：
  | 模型 | encoder q4 | decoder_merged q4 | 合计下载 |
  |---|---|---|---|
  | `onnx-community/whisper-base` | 18.8 MB | 124 MB | **≈143 MB** |
  | `onnx-community/whisper-large-v3-turbo`（q4f16） | 370 MB | 194 MB | **≈564 MB** |
  （另有 fp32/fp16/int8/bnb4 变体；`whisper-tiny.en` 官方 WebGPU 指南示例即用它。small/medium 是否有对应 onnx-community 仓库：**UNKNOWN，未确证**。）
- **速度：官方 transformers.js WebGPU 指南里没有任何数字**（无 "Nx faster"、无 "realtime" 之类）`[已核实]`；`Xenova/whisper-webgpu` Space 页面抓不到内容。
  → **WebGPU Whisper 的实测 RTF：UNKNOWN。禁止在 UI 上承诺任何速度。必须我们自己在真机上测完再决定要不要把它设为默认。**
- **浏览器支持**（最权威来源：gpuweb wiki Implementation Status，最后编辑 2026-05-28）`[已核实]`：
  - Chrome/Edge：macOS / Windows(x86,x64) / ChromeOS 自 v113 **默认开启**。**Linux 只有 Intel Gen12+（v144+）和 NVIDIA+Wayland（驱动 535.183.01+，v147+）默认开**，其余 Linux 仍需 `--enable-unsafe-webgpu`。Windows ARM64 仍需 flag。
  - Firefox：**Windows 自 v141 默认开**；macOS Apple Silicon 自 v145（macOS 26+），全 macOS 自 v147；**Linux 仅 Nightly**。
  - Safari：**26（macOS Tahoe 26 / iOS 26）默认开启**。
  → **Linux 桌面用户在浏览器内跑 WebGPU 大概率不可用**，这一档在 Linux 上必须自动落回 WASM。
- **显存/缓冲区限制** `[已核实 —— WebGPU 规范 gpuweb.github.io/gpuweb/#limits]`：`maxStorageBufferBindingSize` 规范默认 **134,217,728 B（128 MiB）**，`maxBufferSize` 默认 **268,435,456 B（256 MiB）**。这是**必须支持的最小值**，不是硬上限；要更大必须在 `requestDevice({requiredLimits})` 里显式申请，适配器不支持就直接失败。桌面 GPU 常可到 GB 级。**没有规范级的 2GB/4GB 硬限制**，但 large-v3-turbo 这种要仔细做分块。
- **定位**：**L0 兜底档 + 首次体验的 "先跑起来" 路径**。用户点进网页立刻能转写一段短音频（whisper-base，143 MB 下载，浏览器缓存），完全零安装。想要更快/更准/长音频 → 引导安装本地 daemon。

**⑥ 轻量方案**
- **Moonshine**（`moonshine-ai/moonshine`）`[已核实]`：代码 MIT；**模型权重的 license 页面未声明 → UNKNOWN**。Base 英文：`encoder_model.ort 29.9 MB` + `decoder_model_merged.ort 104 MB`。仓库自报 WER（fp 参考值，作者自己说"实际发布的量化模型分数会更差一些"）：Tiny 12.66% / Base 10.07% / Small Streaming 7.84% / Medium Streaming 6.65%。自报流式延迟表（MacBook Pro）：Medium Streaming 107 ms vs Whisper Large v3 11,286 ms —— **作者自己承认这是"a pretty opinionated benchmark"**（从 VAD 检出的句尾开始计时，结构性偏袒流式模型，且 Whisper 基线用的是 CPU-only faster-whisper）。**只跑 ONNX Runtime**。sherpa-onnx 已支持。
  → **英文短句/流式场景很强，但只支持有限语言。作为 F3 的可选档位。**
- **NVIDIA Parakeet** `[已核实]`：`parakeet-tdt-0.6b-v2`，**CC-BY-4.0**，0.6B 参数，"至少 2GB RAM"。Open ASR Leaderboard 英文 avg WER **6.05**，**RTFx 3380**（batch 128）。官方只声明 NeMo/Riva 支持，但 **sherpa-onnx 已打包 int8 版本**，且 **whisper.cpp v1.9.1 已内置 `parakeet.h` + `parakeet-cli`**（见 B.4）。
  → **英文场景性价比极高的方向，v1.1 重点评估。**
- **Vosk** `[已核实]`：模型 13 MB ~ 4.4 GB；`vosk-model-small-en-us-0.15` 40 MB（WER 9.85 librispeech test-clean）、`vosk-model-en-us-0.22` 1.8 GB（WER 5.69）。License **混杂**：多数 Apache-2.0，但有 AGPL / LGPL-3.0 / **CC-BY-NC-SA 4.0（禁商用）** / GPLv3 的模型 → **法务风险，逐模型审。**
  → **不推荐**：精度不如 Whisper，license 复杂，且没有 GPU 加速故事。

### B.6 ASR 最终推荐

| 档位 | 引擎 | 何时用 |
|---|---|---|
| **L0 零安装** | transformers.js + WebGPU/WASM，`whisper-base` q4（≈143 MB） | 用户还没装 daemon；短音频试用；企业受限机器 |
| **L1 本地 CPU（安装即有）** | whisper.cpp CPU（`ggml-cpu-*` 自动选微架构） | 任何机器的保底 |
| **L2 本地加速** | whisper.cpp + Metal / CUDA / Vulkan / ROCm（按需下包） | 主力路径 |
| **副引擎（可选）** | sherpa-onnx（npm 预编译）：流式 ASR、VAD、Parakeet/SenseVoice | F3 实时录音；英文加速档 |

---

## C. 二进制分发（要求 2.1 的核心）

### C.1 三种方案对比

| 方案 | 安装包体积 | 优点 | 缺点 | 判定 |
|---|---|---|---|---|
| **(a) 全量打包所有后端** | 参考 Ollama：`OllamaSetup.exe` **1.56 GB**、`ollama-linux-amd64.tar.zst` **1.42 GB**、`ollama-linux-amd64-rocm.tar.zst` **1.05 GB** `[已核实]`。我们若照做：Windows ≈ 700 MB(CUDA) + 30 MB(Vulkan) + 8 MB(CPU) ≈ **750 MB+**，Linux 类似 | 离线可用、无网络失败面 | 90% 用户下了用不上的东西；CDN 成本；更新一次全量重下 | **作为"离线安装包"变体保留，不作默认** |
| **(b) 运行时按需下载** | 主安装包只含 CPU：**Windows ≈ 8 MB / Linux ≈ 9 MB / macOS ≈ 待定** | 默认包极小；按硬件精确投递；后端可独立热更新 | 需要 manifest/校验/续传/签名整套基建；首次使用有等待；离线环境不可用 | **✅ 默认方案** |
| **(c) 复用用户已装的** | 0 | 免下载 | 版本不可控；whisper 没有"人人都装了的"运行时；Ollama 只解决 LLM 不解决 ASR | **✅ 但只用于 LLM（见 E），ASR 不依赖** |

### C.2 推荐组合（分层）

```
┌─ L0  浏览器内 WebGPU/WASM          0 字节安装      永远可用（Linux 上落 WASM）
├─ L1  安装包内置 whisper.cpp CPU     ~8-20 MB       永远可用，永不失败
└─ L2  按需下载的后端包（backend pack）
       ├─ macOS(arm64/x64)  Metal    0 额外字节（GGML_METAL_EMBED_LIBRARY 已嵌入 L1 二进制）
       ├─ Windows/Linux     Vulkan   ~15-35 MB      ← 推荐给 AMD/Intel，也作为 NVIDIA 的"小包"选项
       ├─ Windows/Linux     CUDA     见 C.3（需要瘦身）
       └─ Linux             ROCm     ~124 MB（参考 llama.cpp ubuntu-rocm-7.2 = 124.05 MB）
```

**为什么 L1 一定要内置而不是也下载**：① 保证"装完就能用"，不受网络/公司代理影响；② 给 L2 失败提供确定性兜底；③ 才 8-20 MB，几乎零成本。

**为什么 L2 可以只是"多丢几个文件"**：见 B.2/B.3 —— ggml 的 `GGML_BACKEND_DL` + 目录扫描 + `ggml_backend_score()` 让这变成一等公民能力。**后端包 = 一个只含 `ggml-<backend>.{dll,so,dylib}` + 其运行时依赖的压缩包，解压到 L1 的同一目录即可。**

**Vulkan 包体积估算依据**：llama.cpp 官方 `llama-b10221-bin-win-vulkan-x64.zip` = **32.51 MB**，`llama-b10221-bin-win-cpu-x64.zip` = **17.50 MB** `[已核实]` → `ggml-vulkan.dll` 的增量约 **15 MB**。whisper.cpp 的 Vulkan 包应在同一量级。**标记为 [未验证] 的外推，需自建 CI 后实测。**

### C.3 下载器必须做的事

1. **Manifest**：我们自己托管一个 `backends.json`（走 GitHub Release 或 CDN），结构：
   ```json
   {"schemaVersion":1,"generatedAt":"...","packs":[
     {"id":"whispercpp-vulkan-win-x64","engine":"whisper.cpp","engineVersion":"1.9.1",
      "ggmlAbi":"0.15.1","backend":"vulkan","os":"win32","arch":"x64",
      "url":"https://.../whispercpp-1.9.1-vulkan-win-x64.zip",
      "sizeBytes":34012345,"sha256":"...","minDriver":{"vulkanApi":"1.2"},
      "files":["ggml-vulkan.dll"]}
   ]}
   ```
   **manifest 本身要有 detached 签名（minisign/cosign），公钥硬编码在客户端**——否则 CDN/中间人被攻破就等于任意代码执行。
2. **完整性**：下载后算 **sha256** 比对 manifest。**注意：whisper.cpp 官方 `models/README.md` 给的是 SHA1 不是 SHA256** `[已验证]`，模型下载要单独处理（用 HF 的 ETag / `.sha256` 旁文件，或我们自己重新算并写进 manifest）。
3. **断点续传**：HTTP `Range: bytes=N-` + 校验 `ETag`/`Last-Modified` 一致性；写 `.part` 临时文件，校验通过才原子 rename。GitHub Release 与常见 CDN 均支持 Range（本报告的 zip 拆解就是用 Range 做的 `[已验证]`）。
4. **版本管理**：目录布局
   ```
   <appdata>/openmemo/runtimes/
     whispercpp/1.9.1+ggml0.15.1/
       core/           <- L1，随安装包铺进来
       backends/cuda-sm86/   backends/vulkan/
       active -> ...   <- 符号链接/junction 指向当前生效版本
   ```
   保留上一版本以便一键回滚。
5. **离线兜底**：提供 `openmemo-offline-<os>-<arch>.zip`（含全部后端包），网页上给"离线安装包"入口，用户手动导入；daemon 校验 sha256 后就地展开。**同一套 manifest 复用**。
6. **失败面**：公司代理/防火墙、GitHub 被墙 → 支持配置镜像 base URL（对国内用户是刚需，与 F1 的 Bilibili 场景是同一批用户）。

### C.4 CUDA 的现实问题

**实测事实 `[已验证]`（whisper.cpp v1.9.1 CUDA 12.4 Windows 包）**：
- 打包分发的 CUDA 运行时：`cudart64_12.dll`(0.55 MB) + `cublas64_12.dll`(100 MB) + `cublasLt64_12.dll`(473 MB) + `nvblas64_12.dll`(0.33 MB) + `nvrtc64_120_0.dll`(44.7 MB) + `nvrtc-builtins64_124.dll`(5.4 MB)。解压后 CUDA 运行时合计 **≈624 MB**。
- **没有 cuDNN** —— ggml 不需要它。（对比：CTranslate2/faster-whisper 需要 cuDNN 9 且不打包 `[已核实]`。）
- `ggml-cuda.dll` 本身解压后 **564.59 MB**，因为是**跨所有 SM 架构的 fat binary**。

**用户需要装 CUDA Toolkit 吗？→ 不需要。** 只需要**显卡驱动**（提供 `nvcuda.dll` / `libcuda.so.1`，这两个是驱动组件，NVIDIA 不允许我们分发）。
参考 Ollama 的驱动门槛 `[已核实]`："Supports Nvidia GPUs with compute capability 5.0+ and driver version 550 and newer"，5.0–6.2 的卡"require driver version 570 or newer"。

**静态链接 vs 动态**：CUDA 数学库有静态版（`cublas_static.lib` 等），但静态链接 cuBLAS 通常**不会变小**（还是要把用到的 kernel 全带上），且失去 `GGML_BACKEND_DL` 的可插拔性。→ **保持动态。**

**瘦身路线（按收益排序，均 `[未验证]`，需实测）**：
| 手段 | 预期收益 | 代价 |
|---|---|---|
| **按 compute capability 出单架构包**（`-DCMAKE_CUDA_ARCHITECTURES=86` 等），检测到 `compute_cap` 后精确投递 | `ggml-cuda.dll` 从 564 MB 降到可能 **1/6 ~ 1/10** | CI 矩阵变大（sm_75/80/86/89/90/120…）；检测失败要有 fallback 到 fat 包 |
| **cudart 包独立、可缓存**（学 llama.cpp：`cudart-llama-bin-win-cuda-12.4-x64.zip` 373 MB 是独立 asset `[已核实]`） | 后端更新时不必重下 624 MB 运行时 | 多一次依赖解析 |
| **优先 CUDA 13**（llama.cpp `win-cuda-13.3-x64.zip` **139.72 MB** vs `win-cuda-12.4-x64.zip` **238.85 MB** `[已核实]`，CUDA 13 砍掉了老架构） | 后端体积近乎腰斩 | 要求更新的驱动，老卡用户走 12.x 或 Vulkan |
| **对老卡/低速网络直接推荐 Vulkan**（~15-35 MB） | 体积降 95%+ | 性能未知（见下） |

**⚠️ 必须诚实说明**：**CUDA 相对 Vulkan 在 whisper 推理上快多少 —— UNKNOWN。** 我没有找到任何可信的、针对 whisper.cpp 的 CUDA-vs-Vulkan 对比数据。whisper.cpp 官方 bench 帖里连一个 GPU 数字都没有 `[已核实]`。**这是本方案里唯一会影响"默认给 NVIDIA 用户推哪个包"的未知量，必须做 spike 实测后再定。**

### C.5 AMD 的现实问题

- **Windows 上 ROCm 很差**：AMD 的 Windows HIP SDK 只覆盖有限几款 GPU，且要求用户装 HIP SDK。llama.cpp 有官方 `llama-b10221-bin-win-hip-radeon-x64.zip`（**309.56 MB**）`[已核实]`，说明技术上可行但包很大且硬件覆盖窄。
- **Vulkan 是更好的通用选择**，理由（工程性，非性能性）：
  1. **驱动即得**：AMD/NVIDIA/Intel 的现代 Windows 驱动都自带 `vulkan-1.dll`，用户什么都不用装。
  2. **一个包通吃**：同一个 `ggml-vulkan.dll` 覆盖 AMD + Intel Arc + Intel 核显 + NVIDIA + 部分 ARM GPU。
  3. **体积小 15 MB 量级** vs ROCm 309 MB / CUDA 678 MB。
  4. **跨 OS**：Windows 和 Linux 同一后端，CI 成本减半。
  5. ORT 的 ROCm EP 官方已标 deprecated `[已核实]`，AMD 在 ONNX 路线上也不稳。
- **Vulkan 相对 CUDA 的性能水平：UNKNOWN。** 不编造。需实测。
- **Linux + AMD**：ROCm 可用（llama.cpp `ubuntu-rocm-7.2-x64.tar.gz` 124.05 MB `[已核实]`），但要求用户装 `amdgpu-install`/ROCm 内核驱动（Ollama 文档明确要求 "ROCm v7 driver on Linux" `[已核实]`）→ **默认给 Vulkan，把 ROCm 作为"高级用户可选"**。

### C.6 代码签名 / Gatekeeper / SmartScreen（能否落地的关键）

#### macOS `[未验证 —— 无 mac 机器，以下均为文档核实 + 推理]`

**四条已核实的硬事实**：
1. **Apple Silicon 上所有可执行文件必须至少有 ad-hoc 签名才能运行。** Apple 官方 Universal Apps 发布说明原文（经 eclecticlight.co 引用）`[已核实]`：*"the operating system will enforce that any executable must be signed with a valid signature before it's allowed to run"*，*"a simple ad-hoc signature issued locally is sufficient, which includes signatures which are now generated automatically by the linker"*。（不适用于 Rosetta 下的 x86 二进制，也不适用于 Intel Mac。）
2. **Hardened Runtime 下的 Library Validation**：加载到我们进程里的 dylib 必须**与主程序同一 Team ID 签名**，或由 Apple 签名，否则 `dyld` 拒绝加载。豁免要加 `com.apple.security.cs.disable-library-validation` 熵权限 `[已核实 —— Apple 官方 entitlement 文档]`。
3. **`stapler` 不能把票据钉到裸 Mach-O 上。** Apple DTS 工程师在官方论坛原话 `[已核实]`：*"Now we cannot staple the ticket to the binary since Mach-O stapling is not supported."* / *"You can't staple a Mach-O at this time, but... you can staple a pkg. You can also staple disk images."* stapler 只支持 **.app / .dmg / .pkg**。
4. **notarytool 接受的上传格式**：Apple 官方 developer-id 页原文 `[已核实]`：*"Several file types are supported, including ZIP, PKG, and DMG"*。`altool` 自 2023-11-01 起不再受理。Apple Developer Program **$99/年**（官方页原文）`[已核实]`。

**→ 推荐的 macOS 落地流程**：
```
CI 阶段（我们做）：
 1. 编译 whisper-cli / whisper-server / libggml-*.dylib / libwhisper.dylib
 2. 用【我们自己的 Developer ID Application 证书】逐个签名：
    codesign --sign "Developer ID Application: <Us> (TEAMID)" \
             --options runtime --timestamp --force <每个 .dylib 和可执行文件>
    ★ 必须是我们自己的 Team ID —— 这样 hardened runtime 的 library validation 自然通过，
      不需要 disable-library-validation（也就不用向 Apple 解释为什么要削弱安全）
 3. 打成 zip，xcrun notarytool submit backend-metal-arm64.zip --wait
 4. ★ 不能 staple（裸 Mach-O 不支持）→ 接受"票据只能在线查"
 5. 计算 sha256 写进 manifest，manifest 用我们的 minisign 私钥签

运行时（daemon 做）：
 6. 用普通 HTTP 客户端下载（Node fetch / Rust reqwest）
    ★ 关键假设：程序化写文件【不会】打 com.apple.quarantine —— quarantine 由
      浏览器/Mail 这类应用通过 LSFileQuarantineEnabled 或沙盒机制主动打上。
      我们的 daemon 不开沙盒、不设该 key。
 7. 解压到 runtimes 目录
 8. 兜底：xattr -dr com.apple.quarantine <runtimes 目录>   （不需要 admin 权限）
 9. spawn 子进程运行 probe → 成功
```
**⚠️ 第 6 步是整个方案里风险最高的一条假设。** macOS 15 Sequoia 起 Apple 持续收紧 Gatekeeper，**我无 mac 机器，无法验证在 macOS 15/26 上是否仍然成立**。
**缓解措施（必须准备）**：如果实测被拦，退路是把后端包做成**签名+公证+已 staple 的 `.pkg`**，用 `installer -pkg ... -target CurrentUserHomeDirectory`（用户域安装，**不需要 admin**）。这会牺牲一点体积和流程简洁性，但 100% 合规。
**行动项**：给团队里有 Mac 的同学分一个 30 分钟的验证任务（下载一个 dylib → `xattr -l` 看有没有 quarantine → 运行）。

#### Windows `[未验证 —— 无 Windows 机器，以下均为文档核实]`

1. **MOTW（Mark of the Web）来源** `[已核实 —— Microsoft Learn 原文]`：*"Mark of the Web is added by Windows to files from an untrusted location, such as the internet or Restricted Zone. For example, browser downloads or email attachments."* 存在 NTFS 备用数据流 `Zone.Identifier`，ZoneId `3` = Internet、`4` = Restricted。`Unblock-File` cmdlet 可清除。**仅适用于 NTFS，FAT32 上不生效。**
   → **我们的 daemon 用 HTTP 客户端写文件，不经过 `IAttachmentExecute`/`URLDownloadToFile`，因此不带 MOTW** `[未验证，但机制上如此]`。SmartScreen 的 App Reputation 检查以 MOTW 为触发条件 → **下载的后端包不会触发 SmartScreen 弹窗**。
   → 兜底：安装后对 runtimes 目录跑一次清除（PowerShell `Unblock-File` 或直接删除 `:Zone.Identifier` 流）。
2. **真正会撞 SmartScreen 的是用户从浏览器下载的主安装包。** SmartScreen 机制 `[已核实 —— Microsoft Learn 原文]`：*"It also provides reputation checks for apps, checking downloaded programs and the digital signature used to sign a file. If a URL, a file, an app, or a certificate has an established reputation, users don't see any warnings. If there's no reputation, the item is marked as a higher risk and presents a warning to the user."*
3. **EV 证书不再给"即时 SmartScreen 信誉"** —— 这是重要的祛魅。Azure Trusted Signing FAQ 原文 `[已核实]`：*"SmartScreen reputation builds up automatically. The prompt stops appearing once the file hash has sufficient download history."* SSL.com 现行 EV 产品页也自述微软 2024 根程序变更 *"removed EV's distinct SmartScreen status"* / *"EV certificates no longer receive instant SmartScreen bypass"*（注意：同页别处仍有相反的旧营销话术，**这是厂商页面自相矛盾，按前者理解**）。
4. **签名选项与成本**：
   | 方案 | 价格 | 门槛 |
   |---|---|---|
   | **Azure Trusted Signing**（已更名 "Artifact Signing"） | **具体美元金额 UNKNOWN**（定价页动态渲染，抓不到数字）。已确认结构：Basic 5,000 次签名/月，Premium 100,000 次/月，超量按次计费；**不按比例退款，建账户即开始计费** | **美国/加拿大、成立满 3 年以上的组织**；个人开发者有 Public Preview 通道。**不签发 EV**（官方 FAQ 明确"没有计划") |
   | **SSL.com OV 代码签名** | **$129.00/年**（1 年）～ **$96.75/年**（5 年）；YubiKey 令牌 **+$379.00** | 自 2023-06-01 CA/B Forum 要求私钥必须存 FIPS 140-2 L2 硬件（USB 令牌或云 HSM）—— OV/EV 都一样 |
   | **SSL.com EV 代码签名** | **$349.00/年**（1 年）～ **$149.00/年**（5 年） | 同上；且**已不再换来即时 SmartScreen 信誉** |
   （DigiCert 价格 UNKNOWN —— 抓取失败。以上 SSL.com 数字为实地抓取 `[已核实]`。）
   → **推荐**：若公司满足 Azure Trusted Signing 资格（美/加、满 3 年）优先用它（托管 HSM，CI 集成好，无实体令牌）；否则 **OV + 云 HSM** 足矣，**不必为 EV 多付 2.7 倍**。
5. **另一个常被忽略的坑**：Windows Defender 对**新出现的、体积大的未知 DLL**（比如 251 MB 的 `ggml-cuda.dll`）可能做实时扫描导致首次加载极慢，极端情况误报隔离。→ 签名 + 向 Microsoft 提交误报 + 在 UI 里对"首次加载可能较慢"做预期管理。

---

## D. 自检与降级

### D.1 安装后自检（网页可见的"跑分"）

**测试音频**：随包内置一段 **~10 秒 16 kHz 单声道 WAV**（我们自己录/用公共领域素材；whisper.cpp 仓库的 `samples/` 里就有测试用例如 `test-parakeet-full-jfk` 所暗示的 JFK 片段，但**我们应自备以避免 license 问题**）。

**两级自检**：

| 级别 | 做什么 | 判定 | 耗时目标 |
|---|---|---|---|
| **T0 设备枚举** | 子进程跑 `openmemo-probe`（我们自建，调 `ggml_backend_load_all` → `ggml_backend_dev_count` → `ggml_backend_dev_get_props`），输出 JSON：后端名、设备名、`memory_free/memory_total` | `dev_count > 0` 且含目标后端 | **< 3 s，超时即判失败** |
| **T1 真实推理跑分** | 子进程跑 `whisper-cli -m <tiny 或 base> -f selftest.wav -oj`，计时 | 转写文本与期望文本的字符相似度 > 阈值（防"跑通了但输出乱码"）；同时算 RTF | < 30 s（tiny） |

**RTF 定义与展示**：
```
RTF = wall_clock_seconds / audio_duration_seconds      （越小越快）
speedup = 1 / RTF                                       （UI 上展示这个更直观）
```
网页展示示例：
> **加速后端：CUDA（NVIDIA GeForce RTF 4070, 12 GB）**
> 自检：10.0 秒音频耗时 **0.62 秒** → **约 16× 实时**
> 推荐模型：`large-v3-turbo-q5_0`（547 MB） · 预计 1 小时录音约需 **3.8 分钟**
> [重新检测] [切换后端] [查看日志]

**必须同时跑一次 CPU 基线**（用同一段音频），这样才能诚实地告诉用户"加速带来了 8.3×"。也让"要不要下 678 MB 的 CUDA 包"这个决定有依据。

**注意 `whisper-bench` 也可用**（release 包里有），它报 encode 时间，适合做后端间横向对比；但**面向用户展示应该用端到端 RTF**，因为那才是他等待的时间。

### D.2 降级链条设计

**降级顺序（按平台）**：
```
macOS arm64 :  Metal → CPU(NEON/Accelerate)
macOS x64   :  CPU(AVX2)                                  （Intel Mac 无 GPU 后端可选）
Win/Linux + NVIDIA : CUDA → Vulkan → CPU
Win + AMD          : Vulkan → [DirectML via sherpa-onnx，实验性] → CPU
Linux + AMD        : Vulkan → ROCm(高级用户手动开) → CPU
Win/Linux + Intel  : Vulkan → [SYCL，实验性] → CPU
无 GPU / 检测失败   : CPU
CPU 也不行（不可能，但要兜）: 引导回 L0 浏览器 WebGPU/WASM
```

**实现要点（这些比顺序本身更重要）**：

1. **probe 必须跑在独立子进程里。** GPU 驱动故障（尤其是老 AMD/Intel 驱动、虚拟机里的假 GPU）会**直接段错误**，会把 daemon 一起带走。子进程隔离 + 非零退出码 = 干净的失败信号。
2. **必须有超时。** Ollama 官方 troubleshooting 文档记载 `[已核实]`：ROCm 内核驱动过旧时"GPU initialization will hang during device discovery and eventually time out, causing Ollama to fall back to CPU"。→ probe 硬超时 10 s，kill 后判失败。
3. **失败要持久化 + 熔断。** 记录 `{backend, reason, timestamp, driverVersion}`。**同一后端连续失败 2 次 → 标记 blacklisted，直到用户显式点"重新检测"或驱动版本变化才重试。** 否则每次启动都要等 10 秒超时。
4. **ggml 自身已经是一层软降级**（`ggml_backend_load_all()` 内部 `silent=true`，加载不了就安静跳过 `[已验证]`）。我们的外层降级是为了**告诉用户发生了什么**，以及**决定要不要重新下别的包**。
5. **驱动版本门槛前置检查**（避免下了 678 MB 才发现驱动太老）：NVIDIA 驱动 < 550 → 直接推荐 Vulkan 或提示更新驱动（门槛参考 Ollama 文档 `[已核实]`）。
6. **UI 必须显示当前生效的后端和降级原因**，且给"手动指定后端"的逃生口（高级设置）。Ollama/LM Studio 都是这么做的。
7. **CPU 兜底路径的线程数**：macOS 用 P 核数（`hw.perflevel0.physicalcpu`），其他平台用物理核数而非逻辑核数（超线程对 ggml 通常无益）。

### D.3 状态机

```
UNKNOWN ──detect()──> CANDIDATE(backend=X)
                          │
                          ├─ 本地已有包? ──否──> DOWNLOADING ──失败(网络)──> 重试/切镜像/降级
                          │                          │
                          │                          └─ sha256 不符 ──> 删除重下(≤2次) ──> 降级
                          ├─ VERIFYING(签名/校验)
                          ├─ PROBING(子进程,10s超时) ──失败──> BLACKLIST(X) ──> 取下一个候选
                          ├─ SELFTEST(跑 10s 音频)   ──失败/乱码──> BLACKLIST(X) ──> 下一个
                          └─> READY(backend=X, rtf=0.062)
```

---

## E. LLM 推理（F4 思维导图 / 摘要）

### E.1 三档推荐

| 档 | 方案 | 体积 | 质量 | 隐私 | 判定 |
|---|---|---|---|---|---|
| **T1（默认）** | **用户自带 API Key**：Anthropic / OpenAI / DeepSeek / 任意 OpenAI-兼容 `base_url`（含 SiliconFlow、Moonshine、自建 vLLM） | 0 | 最好 | 数据出网 | **✅ 默认。** 思维导图结构化对模型能力要求高，本地 7B 的 JSON 结构稳定性差很多 |
| **T2** | **探测复用已装的本地服务**：Ollama `http://127.0.0.1:11434/api/tags`、LM Studio `http://127.0.0.1:1234/v1/models`（OpenAI 兼容） | 0（复用） | 取决于用户模型 | 完全本地 | **✅ 强烈推荐。** 装了 Ollama 的用户已经解决了 GPU 问题，我们白捡 |
| **T3** | **内置 llama.cpp `llama-server`**（OpenAI 兼容 API） | 见下 | 中 | 完全本地 | **✅ 做，但排在 T1/T2 之后** |

### E.2 为什么 T3 选 llama.cpp 而不是别的

**llama.cpp 的官方预编译矩阵极其完整** `[已核实 —— tag `b10221`, 2026-08-01T19:30:18Z, 25 assets]`。注意 llama.cpp **每天出多个 tag**，tag 号是移动目标，我们要**锁版本**：

| 平台 | asset | 大小 |
|---|---|---|
| Win CPU x64 | `llama-b10221-bin-win-cpu-x64.zip` | 17.50 MB |
| Win CPU arm64 | `llama-b10221-bin-win-cpu-arm64.zip` | 11.63 MB |
| Win CUDA 12.4 | `llama-b10221-bin-win-cuda-12.4-x64.zip` | 238.85 MB |
| Win CUDA 13.3 | `llama-b10221-bin-win-cuda-13.3-x64.zip` | **139.72 MB** |
| **Win Vulkan** | `llama-b10221-bin-win-vulkan-x64.zip` | **32.51 MB** |
| Win HIP (Radeon) | `llama-b10221-bin-win-hip-radeon-x64.zip` | 309.56 MB |
| Win SYCL (Intel) | `llama-b10221-bin-win-sycl-x64.zip` | 114.43 MB |
| Win OpenVINO | `llama-b10221-bin-win-openvino-2026.2.1-x64.zip` | 76.83 MB |
| Win OpenCL (Adreno) | `llama-b10221-bin-win-opencl-adreno-arm64.zip` | 12.32 MB |
| CUDA 运行时（独立） | `cudart-llama-bin-win-cuda-12.4-x64.zip` / `-13.3-` | **373.31 / 372.86 MB** |
| Linux CPU x64 / arm64 | `llama-b10221-bin-ubuntu-x64.tar.gz` / `-arm64` | 15.68 / 12.72 MB |
| **Linux Vulkan x64 / arm64** | `llama-b10221-bin-ubuntu-vulkan-x64.tar.gz` / `-arm64` | **30.92 / 25.28 MB** |
| Linux ROCm 7.2 | `llama-b10221-bin-ubuntu-rocm-7.2-x64.tar.gz` | 124.05 MB |
| Linux SYCL fp16/fp32 | `llama-b10221-bin-ubuntu-sycl-fp{16,32}-x64.tar.gz` | 50.83 / 50.59 MB |
| **macOS arm64 / x64** | `llama-b10221-bin-macos-arm64.tar.gz` / `-x64` | **10.43 / 10.70 MB** |
| Android arm64 | `llama-b10221-bin-android-arm64.tar.gz` | 73.00 MB |
| xcframework | `llama-b10221-xcframework.zip` | 254.03 MB |

→ **LLM 这条线不需要自建 CI**，直接用官方产物（但仍需 macOS 重签名 + 公证，见 C.6）。
→ 注意 llama.cpp 把 **cudart 拆成独立 asset**（373 MB）—— **这个拆分策略我们应该在 whisper.cpp 侧照抄**（见 C.4）。

### E.3 后端包能不能在 whisper.cpp 和 llama.cpp 之间共用？

**理论上可以**（同为 ggml `ggml-cuda.dll`/`ggml-vulkan.so`），能省一半下载量。
**但 [未验证]，且有明确风险**：whisper.cpp 与 llama.cpp **各自 vendor 一份 ggml**，版本会漂移。我实测 whisper.cpp v1.9.1 的 soname 是 **`libggml.so.0.15.1` / `libggml-base.so.0.15.1`** `[已验证]`，llama.cpp `b10221` 的 ggml 版本 UNKNOWN。ggml 后端注册表会检查 API 版本并在不匹配时报 *"incompatible API version"* 后拒绝加载 `[已验证 —— 读源码]`。
→ **行动项**：在我们的 CI 里**把 whisper.cpp 和 llama.cpp 两个 submodule 的 ggml 钉到同一个 commit**，然后实测共用是否成立。成立则合并后端包；不成立则各自一份（多花约 250 MB CUDA / 15 MB Vulkan 的磁盘，可接受）。

### E.4 探测已装服务的具体做法

```
GET http://127.0.0.1:11434/api/tags      -> Ollama，返回已装模型列表
GET http://127.0.0.1:1234/v1/models      -> LM Studio（OpenAI 兼容）
GET http://127.0.0.1:8080/v1/models      -> 用户自己起的 llama-server
```
超时 500 ms，失败即视为未安装。**不要去扫描文件系统找 Ollama 安装目录** —— 端口探测更准也更快，且能直接确认服务在跑。
Ollama 也提供 `/api/ps` 看已加载模型、`/api/show` 看模型详情。

**⚠️ license 注意**：Ollama 的 CPU 库选择本身是分层的（`cpu_avx2` > `cpu_avx` > `cpu`，"slowest but most compatible"）`[已核实]` —— 印证了我们的分层降级设计方向是业界共识。

### E.5 模型建议（T3 本地）

思维导图/摘要任务需要稳定输出 JSON。建议默认 **7-9B instruct 量化到 Q4_K_M**（约 4.5-5.5 GB），并**强制用 llama.cpp 的 GBNF grammar 或 JSON schema 约束输出**（`llama-server` 支持 `response_format: {type: "json_schema"}`）。具体模型选型不在本任务范围，留给 LLM/产品线的 agent。

---

## F. 附录：验证清单（诚实归档）

### F.1 我在本机亲手验证的（Linux x86_64，无 GPU）
- `/proc/cpuinfo` 指令集检测：检出 `avx avx2 avx512f f16c fma sse4_2`
- `lscpu` / `nproc` / `uname` / `lspci -nn` 输出
- `ldconfig -p` 探针：`libvulkan.so.1` 与 `libOpenCL.so.1` **存在但无 GPU** ← 关键反例
- `/sys/class/drm` 为空、`/dev/dri` 不存在、`nvidia-smi`/`rocminfo`/`vulkaninfo` 均不存在
- `systeminformation@5.33.1` 实跑：CPU/OS/flags 正确，**`si.graphics()` GPU 识别失败**
- Node `os` API 输出
- 用 HTTP Range 拉取并解析 `whisper-cublas-12.4.0-bin-x64.zip` 与 `whisper-bin-x64.zip` 的 zip central directory → 得到 44 项完整清单与逐文件压缩/解压大小
- 完整下载并 `tar tzf` 了 `whisper-bin-ubuntu-x64.tar.gz` → 得到 so/可执行文件清单与 soname `0.15.1`
- 下载并解析 whisper.cpp `.github/workflows/release.yml` → 确认 job 列表与 ggml flag 使用统计
- 下载并 grep whisper.cpp `README.md` → 确认 Vulkan/HIP/CoreML/OpenVINO 的构建命令
- 下载并 grep llama.cpp `docs/build.md` → 引用 `GGML_BACKEND_DL` 原文
- 下载并读 `ggml/src/ggml-backend-reg.cpp` → 确认搜索路径、评分机制、`silent=true` 静默跳过
- GitHub API 确认 whisper.cpp 最新 release `v1.9.1 / 2026-06-19T05:53:19Z`、`include/parakeet.h` 存在（16,133 B）
- npm registry 确认 `@fugood/whisper.node@1.1.1`（2026-07-19, MIT）的 optionalDependencies 含 **linux/win32 的 `-vulkan` 与 `-cuda` 预编译变体**、darwin 的 x64/arm64、以及 wasm

### F.2 由 subagent 实地抓取核实的
whisper.cpp / sherpa-onnx 的 release asset 清单与 license；llama.cpp `b10221` 全量 asset 与体积；ONNX Runtime EP 状态表（ROCm 标 deprecated、DirectML 未标）与 `onnxruntime-node` 各平台默认捆绑；CTranslate2 wheel 平台矩阵与「不支持 MPS」；faster-whisper 的 cuDNN 手动安装要求；transformers.js WebGPU 文档「无速度数字」；onnx-community whisper ONNX 各 dtype 文件大小；WebGPU 浏览器支持（gpuweb wiki 2026-05-28）与 spec 默认 limits；Moonshine/Parakeet/Vosk 的 license/体积/自报指标；sherpa-onnx 官方支持的模型族；Open ASR Leaderboard 官方博文数字；Azure Trusted Signing/Artifact Signing 的 FAQ 原文与 SKU 结构；SSL.com OV/EV 实价；CA/B Forum 2023-06 硬件密钥要求；Apple Developer Program $99、notarytool 支持格式、stapler 不支持 Mach-O 的 DTS 原话；Ollama release 资产与体积、GPU 检测/驱动门槛/CPU 分层回退文档；Microsoft SmartScreen 与 MOTW/Zone.Identifier 官方说明。

### F.3 明确 UNKNOWN / 未验证（禁止当成事实使用）
| # | 项目 | 状态 |
|---|---|---|
| 1 | whisper.cpp 在 Metal / CUDA / Vulkan / ROCm 下的实际 RTF | **UNKNOWN** —— 官方 bench 帖只有 CPU/WASM 数字。必须 spike |
| 2 | Vulkan 相对 CUDA 的性能比例 | **UNKNOWN** —— 找不到可信的 whisper 专项数据 |
| 3 | 单架构（`CMAKE_CUDA_ARCHITECTURES=xx`）能把 `ggml-cuda.dll` 压到多小 | **未验证** —— 需实测 |
| 4 | whisper.cpp 自建 Vulkan 包的实际体积（我给的 ~15-35 MB 是从 llama.cpp 外推） | **未验证** |
| 5 | llama.cpp 编出的 `ggml-cuda.dll` 能否被 whisper.cpp 复用（ABI 兼容） | **未验证** —— whisper.cpp ggml soname 已验证为 0.15.1，llama.cpp 侧 UNKNOWN |
| 6 | macOS 上"程序化下载不打 quarantine"在 macOS 15/26 是否仍成立 | **未验证 —— 无 mac 机器**。已准备 .pkg 退路 |
| 7 | Windows 上 daemon 程序化下载不带 MOTW | **未验证 —— 无 Windows 机器**（机制上成立） |
| 8 | Azure Trusted Signing 的具体美元价格 | **UNKNOWN** —— 定价页动态渲染 |
| 9 | DigiCert OV/EV 现价 | **UNKNOWN** —— 抓取失败 |
| 10 | sherpa-onnx 是否有 DirectML/CoreML/Vulkan 预编译产物 | **未确证** —— 300+ asset 列表被截断，不能断言不存在 |
| 11 | `onnx-community/whisper-small` / `-medium` 仓库是否存在 | **UNKNOWN** |
| 12 | transformers.js WebGPU Whisper 的实测速度 | **UNKNOWN** —— 官方无任何数字 |
| 13 | whisper.cpp 内置 Parakeet 的可用性/质量/文档 | **未验证** —— 头文件和 CLI 确实存在，但 README 完全没写 |
| 14 | Moonshine 模型权重的 license | **UNKNOWN** —— 代码是 MIT，权重未声明 |
| 15 | LM Studio 无驱动时是否自动回退 CPU | **未在官方文档确证** |
| 16 | 所有 macOS / Windows 侧的检测命令 | **未验证 —— 无对应机器**，均来自官方文档 |

### F.4 建议立刻排的三个 spike（都很小，但会改变结论）
1. **[最高优先] 自建 whisper.cpp CI 矩阵 + 实测 RTF**：Metal(M 系列) / CUDA(sm_86) / Vulkan(同一张 N 卡) / Vulkan(A 卡) / CPU，同一段 60 秒音频、同一个 `large-v3-turbo-q5_0`。产出真实 RTF 表 → 才能决定"NVIDIA 用户默认推 CUDA 还是 Vulkan"。
2. **[中] macOS Gatekeeper 实测**：签名 → 公证 → daemon 下载 dylib → `xattr -l` → 运行。30 分钟能出结论，但决定整个 mac 分发形态。
3. **[中] 单架构 CUDA 包瘦身实测**：`-DCMAKE_CUDA_ARCHITECTURES=86` 单独构建，量一下 `ggml-cuda.dll` 体积。决定 CUDA 包是 678 MB 还是 <100 MB。
