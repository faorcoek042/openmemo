---
id: D-04
author: gpu-runtime
status: ready
date: 2026-08-02
task: T-012
supersedes_unknowns_in: R-02
---

## TL;DR（≤ 25 行，Manager 只读这里）

- **R-02 的核心论断已实证，不再是"读源码得出的推断"**。在本机真编译了 whisper.cpp v1.9.1（`vendor/whisper.cpp`，pin v1.9.1），并跑完整条链路。`GGML_BACKEND_DL=ON` 成立：`libwhisper.so` 只链接 `libggml.so.0` + `libggml-base.so.0`，**12 个 CPU 后端一个都不链接**，全部运行时 dlopen。
- **要求 2.1 的完整闭环已在本机跑通**：L1 core 包（7.7 MB tar.gz，21 个文件）解压 → probe 报 1 个设备(CPU) → **丢进 1 个文件** `libggml-vulkan.so` → 重新 probe → Vulkan 后端加载成功。**没有重装、没有重启、没有改配置。**
- **第一批真实性能数字**（AMD Ryzen AI MAX+ 395，8 线程，11.0s 音频，ggml v1.9.1）：
  | 模型 | 后端 | wall | **RTF** | 倍速 |
  |---|---|---|---|---|
  | tiny.en | CPU(zen4 自动选中) | 0.295–0.323 s | **0.027–0.029** | ~35x |
  | base.en | CPU(zen4) | 0.439–0.450 s | **0.040** | ~25x |
  | tiny.en | CPU(**强制 sse42 兜底**) | 1.029–1.136 s | **0.094–0.103** | ~10x |
  → **最优与最差 CPU 变体差 3.4 倍**。这就是 `GGML_CPU_ALL_VARIANTS` 必须开的量化理由，也说明我们**根本不需要自己检测 AVX 等级**。
- **Vulkan 后端编译成功**（v1.9.1，本机无 GPU 也能编）。**L2 加速包 = 恰好 1 个文件**：`libggml-vulkan.so` 74.1 MB stripped → **22.7 MB tar.gz**。对比 R-02 从 llama.cpp 外推的 "~15-35 MB"，**外推成立**。
- **发现了 R-02 没预料到的二阶陷阱（本机实测）**：装了 `vulkan-tools` 后，Mesa lavapipe ICD 让**一台没有 GPU 的机器开始报告 1 个 Vulkan 物理设备**（`llvmpipe`，deviceType = **CPU**）。→ **"枚举到设备 > 0" 同样不可信**，必须看 `deviceType` 并过滤软件光栅化器。ggml-vulkan 上游已正确过滤（只收 eDiscreteGpu/eIntegratedGpu），我们的 probe 额外打 `softwareRenderer` 标记供 UI 解释。
- **降级链行为已逐项实测**：删 zen4 → 自动落 cooperlake → 再删所有 AVX512 → 落 alderlake → 只剩 sse42 → 仍正常工作。丢一个 200 KB 随机字节的假 `libggml-cpu-evilcorp.so` 进去 → **静默跳过，毫无影响**。
- **⚠️ 但发现一个必须防御的硬故障**：**删光所有 CPU 后端时 whisper.cpp 不是报错，而是 `ggml_abort()` + SIGABRT（exit 134）**。→ 这实证了"probe 必须跑子进程"不是保守设计而是**刚需**：进程内 N-API 绑定会被一起打死。**L1 CPU 包是承重墙，永不可卸载。**
- **在装了 Vulkan 包但无 GPU 的机器上跑推理：0 性能损失、0 报错、静默回落 CPU**（0.277–0.354 s，与纯 CPU 构建同档）。→ **给 NVIDIA 用户默认推 Vulkan 的风险比想象中低**：装错了也不会坏。
- **自己的代码被自己的测试抓到一个真 bug**：`selfTest` 最初报 `backendUsed: "Vulkan"`，而实际计算全在 CPU 上——因为我 grep 了第一条 `load_backend: loaded X`，但 ggml 会**先加载所有后端再选**。已修（改用 `whisper_backend_init_gpu` 行判定）并复测为 `"CPU"`。**"loaded" ≠ "used"。**
- **产物**：`scripts/build-whisper.sh`（平台×后端参数化，已跑通 cpu/vulkan 两个包）、`scripts/build-probe.sh`、`packages/runtime/src/**`（`pnpm -r build` **EXIT=0**）、`.github/workflows/build-backends.yml`。
- **ggml ABI 实测**：v1.9.1 = **0.15.1**（master 已到 0.18.0）。跨引擎复用后端包必须按此值 gate。
- **关键取舍**：ADR-003 决策 3 让 Vulkan 当 NVIDIA 默认，本次实测**没有推翻也没有证实**它——本机无 GPU，**CUDA vs Vulkan 的性能比仍是 UNKNOWN**，仍需有卡的机器做 spike。
- **未验证/存疑**：mac/Windows **已在 CI 真机上部分验过**（见 §10.2 #2/#3 与 D-11 §3/§4），仍未验的只剩 quarantine/Gatekeeper、SmartScreen/MOTW 与非管理员账户行为；CI workflow **已执行多轮**（run 31014564498 等，结论见 D-11 §4/§8）；CUDA 包**已在 CI 编出**（Windows CUDA 12.4，见 D-11 §4.3），ROCm 已按用户指示裁掉；单架构 CUDA 瘦身**仍未实测**。**此前这一行写着"mac/Windows 全部分支（无机器）；CI workflow 从未执行过（无 git remote）；CUDA/ROCm 包未编译"** —— `git remote -v` 现为 `origin https://github.com/faorcoek042/openmemo.git`。
- **对其他 agent 的影响**：`model-mgmt` —— 我按 `packages/shared/src/hardware.ts`（**此前写着 `packages/shared/hardware.ts`，少了 `src/`**）契约实现了 producer 端，**字段全部对齐，无 DISPUTE**；`detectHardware()` 已可直接接 `GET /api/runtime/hardware`。`architect` —— probe 必须子进程 + 10s 超时是**实测结论**，请勿在 daemon 内联。

---

# 详细内容

> **证据等级**：`[实测]` = 本机真跑过，附命令与输出。`[未验证]` = 无对应机器/环境，来自文档。`UNKNOWN` = 查不到，不编。
>
> **本机**：`Linux 7.1.3+deb14-cloud-amd64 x86_64`，AMD Ryzen AI MAX+ 395（KVM，32 vCPU，15.6 GB RAM），**无 GPU、无 /dev/dri**。
> **被测源码**：`vendor/whisper.cpp` @ `f049fff95a089aa9969deb009cdd4892b3e74916`（tag **v1.9.1**）。

---

## 1. 环境搭建（含踩到的坑）

本机初始状态缺 `cmake`、`ninja`、`glslc`、Vulkan 头文件。`[实测]`

```
apt-get install -y cmake                                   # cmake 4.3.4
apt-get install -y glslc libvulkan-dev vulkan-tools         # Vulkan 编译链
apt-get install -y spirv-headers glslang-tools spirv-tools  # ← 这一条是坑，见下
```

**坑 1（花了一个构建周期）**：只装 `glslc + libvulkan-dev` 时，Vulkan 构建在 **configure 阶段**就失败：

```
-- Found Vulkan: /usr/lib/x86_64-linux-gnu/libvulkan.so (found version "1.4.341")
     found components: glslc  missing components: glslangValidator
CMake Error at ggml/src/ggml-vulkan/CMakeLists.txt:14 (find_package):
  Could not find a package configuration file provided by "SPIRV-Headers"
```

→ 必须额外装 **`spirv-headers`**（提供 `/usr/share/cmake/SPIRV-Headers/SPIRV-HeadersConfig.cmake`）和 `glslang-tools`。这条已写进 CI workflow 的注释里，避免下一个人重踩。

---

## 2. 核心论断实证：`GGML_BACKEND_DL` 是真的

### 2.1 构建配置 `[实测]`

```bash
cmake -B build-cpu -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=ON \
  -DGGML_BACKEND_DL=ON -DGGML_CPU_ALL_VARIANTS=ON -DGGML_NATIVE=OFF \
  -DWHISPER_BUILD_TESTS=OFF -DWHISPER_SDL2=OFF
```

configure 输出确认 ggml **自动展开了 12 个 CPU 微架构变体**：

```
-- Adding CPU backend variant ggml-cpu-piledriver:     -msse4.2 -mf16c -mfma -mavx
-- Adding CPU backend variant ggml-cpu-haswell:        ... -mavx2
-- Adding CPU backend variant ggml-cpu-skylakex:       ... -mavx512f -mavx512bw
-- Adding CPU backend variant ggml-cpu-cannonlake:     ... -mavx512vbmi
-- Adding CPU backend variant ggml-cpu-cascadelake:    ... -mavx512vnni
-- Adding CPU backend variant ggml-cpu-icelake:        ... -mavx512vbmi -mavx512vnni
-- Adding CPU backend variant ggml-cpu-cooperlake:     ... -mavx512bf16
-- Adding CPU backend variant ggml-cpu-zen4:           ... -mavx512vbmi -mavx512vnni -mavx512bf16
-- Adding CPU backend variant ggml-cpu-alderlake:      ... -mavxvnni
-- Adding CPU backend variant ggml-cpu-sapphirerapids: ... -mamx-tile -mamx-int8
-- ggml version: 0.18.0 / 0.15.1 (master / v1.9.1)
```

### 2.2 决定性证据：`libwhisper.so` 不链接任何 CPU 后端 `[实测]`

```
$ ldd build-cpu/bin/libwhisper.so
    libggml.so.0      => .../libggml.so.0
    libggml-base.so.0 => .../libggml-base.so.0
    libstdc++.so.6, libm.so.6, libgcc_s.so.1, libc.so.6, libgomp.so.1
```

**12 个 `libggml-cpu-*.so` 一个都没出现在链接表里。** 它们是纯运行时 dlopen 的插件。

### 2.3 运行时确实在扫描目录并打分 `[实测]`

```
$ ./build-cpu/bin/whisper-cli -m models/ggml-tiny.en.bin -f samples/jfk.wav
load_backend: loaded CPU backend from .../libggml-cpu-zen4.so
```

从 12 个候选里**自动选中 `zen4`** —— 本机是 Zen 5 架构且报告 `avx512_bf16`/`avx512_vbmi`/`avx512_vnni`，zen4 变体正是最优匹配。**我们没有传任何 CPU 相关参数。**

### 2.4 结论

R-02 §B.3 的论断（读源码得出）**全部成立**，且现在有本机实证。
**要求 2.1「网页下载对应后端」= 往同一目录多丢几个文件**，这是 ggml 的一等公民能力。

---

## 3. 第一批真实性能数字

### 3.1 测试条件

| 项 | 值 |
|---|---|
| 音频 | `samples/jfk.wav`，ffprobe 实测：`pcm_s16le / 16000 Hz / 1ch / duration=11.000000` |
| 模型 | `ggml-tiny.en.bin` (77,704,715 B, sha256 `921e4cf8…`)、`ggml-base.en.bin` (147,964,211 B) |
| 线程 | 8（`-t 8`，本机 32 vCPU） |
| 计时 | wall-clock 包含进程启动 + 模型加载 + 推理，即**用户真实等待时间** |
| RTF | `wall_seconds / 11.0`（越小越快）；倍速 = `1 / RTF` |

### 3.2 结果 `[实测，各跑 3 次]`

| 模型 | CPU 后端 | wall (s) | RTF | 倍速 |
|---|---|---|---|---|
| tiny.en | zen4（自动） | 0.308 / 0.323 / 0.295 | 0.028 / 0.029 / 0.027 | 35.7x / 34.0x / 37.3x |
| base.en | zen4（自动） | 0.450 / 0.450 / 0.439 | 0.041 / 0.041 / 0.040 | 24.5x / 24.4x / 25.1x |
| tiny.en | **sse42（强制最差）** | 1.136 / 1.033 / 1.029 | 0.103 / 0.094 / 0.094 | 9.7x / 10.6x / 10.7x |

转写文本逐字正确：
> ` And so my fellow Americans ask not what your country can do for you, ask what you can do for your country.`

### 3.3 最重要的一条推论

**同一台机器、同一个模型，最优 CPU 变体（zen4）比最差（sse42）快 3.4 倍。**

→ `GGML_CPU_ALL_VARIANTS=ON` 带来的成本是 L1 包多 ~10 MB，收益是**在老 CPU 上不崩、在新 CPU 上快 3.4 倍**。
→ 同时证明：**我们不需要自己检测 AVX2/AVX512**。ggml 的 `ggml_backend_score()` 已经做对了这件事，而且比我们做得可靠（它是编译期真实特性检测，不是字符串匹配）。

### 3.4 与 R-02 引用的官方数字对照

R-02 §B.5 引用官方 bench 帖的 Ryzen 9 5950X（AVX2，8 线程）tiny = 197 ms **encode 时间**。本次实测是**端到端 wall time**（含加载），两者不可直接比较。**这正是为什么产品 UI 必须展示端到端 RTF 而不是 encode 时间** —— 用户等的是前者。

---

## 4. Vulkan 后端：编译成功 + 二阶陷阱

### 4.1 编译结果 `[实测]`

```bash
cmake -B build-vk ... -DGGML_VULKAN=ON     # configure rc=0
cmake --build build-vk -j 32                # build rc=0
```

**成功。** 且是在一台**完全没有 GPU** 的机器上编出来的 —— 这符合预期（编译只需要 SDK，不需要硬件），也意味着 **CI runner 不需要 GPU 就能出 Vulkan 包**，这对我们的 CI 设计是好消息。

产物体积：

| 文件 | unstripped | stripped | gzip |
|---|---|---|---|
| `libggml-vulkan.so` (master, ggml 0.18.0) | 51,738,872 | 51,404,832 | 15,704,870 |
| `libggml-vulkan.so` (**v1.9.1**, ggml 0.15.1) | — | 74,145,568 | **tar.gz 22,721,724** |

→ **R-02 从 llama.cpp 外推的 "~15–35 MB" 落在区间内，外推方法成立。**

### 4.2 二阶陷阱：软件光栅化器 `[实测，R-02 未预料到]`

R-02 §A.0 的一阶反例是「`libvulkan.so.1` 存在但无 GPU」。本次装了 `vulkan-tools` 之后出现了**更危险的二阶反例**：

```
$ ls /usr/share/vulkan/icd.d/
asahi_icd.json  freedreno_icd.json  intel_icd.json  lvp_icd.json  ...
                                                    ^^^^^^^^^^^^ Mesa lavapipe

$ vulkaninfo
Vulkan Instance Version: 1.4.341
    GPU id = 0 (llvmpipe (LLVM 21.1.8, 256 bits))
    deviceType = PHYSICAL_DEVICE_TYPE_CPU        ← 注意
    deviceName = llvmpipe (LLVM 21.1.8, 256 bits)
```

**一台没有任何 GPU 的机器，现在报告有 1 个 Vulkan 物理设备。**

如果我们的判定逻辑是「枚举到设备 > 0 → 装 Vulkan 包」，结果会是：装上 22.7 MB 的包，然后**用 CPU 软件光栅化跑矩阵乘法**，比原生 CPU 后端慢得多，而 UI 还会显示"GPU 加速已启用"。

**好消息：ggml-vulkan 上游已经做对了。** 源码 `vendor/whisper.cpp/ggml/src/ggml-vulkan/ggml-vulkan.cpp:6641`（v1.9.1 = `f049fff`，即本文声明的被测 tag）：

> **此前这里写的是 `ggml/src/ggml-vulkan/ggml-vulkan.cpp:7208` —— 7208 是 master 的行号，不是本文自己声明的被测 tag**；在 v1.9.1 里 7208 行是一段 pinned-memory free 的警告。

```cpp
if ((new_props.properties.deviceType == vk::PhysicalDeviceType::eDiscreteGpu ||
     new_props.properties.deviceType == vk::PhysicalDeviceType::eIntegratedGpu) &&
     ggml_vk_device_is_supported(devices[i])) { ... }
```

只接受独显和核显，CPU 类型直接拒。实测行为：

```
ggml_vulkan: No devices found.
load_backend: loaded Vulkan backend from .../libggml-vulkan.so
load_backend: loaded CPU backend from .../libggml-cpu-zen4.so
```

**我们的防御**：`probe.c` 仍然输出 `softwareRenderer` 布尔标记（名字匹配 llvmpipe/lavapipe/SwiftShader/WARP），`manager.ts` 的 `isUsableAccelerator()` 也独立过滤 `type === 'cpu'`。理由有二：① 不能假设每个后端都像 ggml-vulkan 这么谨慎；② UI 需要能说清"你有 Vulkan 但没有可用 GPU"，而不是只显示一个沉默的失败。

### 4.3 装了用不上的包 = 无害 `[实测]`

在装有 Vulkan 包、但无可用 GPU 的机器上跑推理：

| 构建 | wall (s) | 倍速 |
|---|---|---|
| 纯 CPU 构建 | 0.295–0.323 | ~35x |
| **CPU + Vulkan 包** | 0.277 / 0.323 / 0.354 | ~31–40x |

**性能无差异、无报错、无用户干预。**

→ 这条实测**降低了 ADR-003 决策 3 的风险**：给 NVIDIA/AMD 用户默认推 Vulkan，即使推错了，最坏结果只是白下 22.7 MB，不会让产品变慢或变坏。

---

## 5. 降级链：逐项实测

### 5.1 CPU 变体降级 `[实测]`

| 实验 | 操作 | ggml 选中 |
|---|---|---|
| EXP-1 | 12 个变体齐全 | `zen4` |
| EXP-2 | 移走 zen4 | → `cooperlake` |
| EXP-3 | 再移走全部 AVX512 变体 | → `alderlake` |
| EXP-4 | 只剩 sse42 | → `sse42`（仍正常转写） |

**全自动，无配置，无报错。**

### 5.2 抗污染 `[实测]`

```bash
head -c 200000 /dev/urandom > libggml-cpu-evilcorp.so   # 200 KB 垃圾，伪造 ELF 魔数
```

结果：`load_backend: loaded CPU backend from .../libggml-cpu-zen4.so`，exit=0。**静默跳过，毫无影响。**

这与 R-02 读源码得出的结论一致（`ggml_backend_load_all()` 内部 `silent = true`）。

### 5.3 ⚠️ 硬故障：无 CPU 后端时 **SIGABRT** `[实测，这是最重要的负面发现]`

移走**全部** `libggml-cpu-*.so` 后：

```
$ ./whisper-cli -m models/ggml-tiny.en.bin -f samples/jfk.wav
whisper_init_with_params_no_state: devices    = 0
whisper_init_with_params_no_state: backends   = 0
whisper_model_load: loading model
/bin/bash: line 4: 1199364 Aborted   ./whisper-cli ...
EXIT CODE = 134
```

backtrace：
```
#3 ggml_print_backtrace ()          from libggml-base.so.0
#4 ggml_abort ()                    from libggml-base.so.0
#5 ggml_backend_dev_backend_reg ()  from libggml-base.so.0
#6 make_buft_list(whisper_context_params&) () from libwhisper.so.1
#7 whisper_model_load(...)          from libwhisper.so.1
```

**不是返回错误码，是 `ggml_abort()` 直接杀进程。**

两条硬性设计结论：

1. **probe 必须跑独立子进程。** ADR-003 决策 3 原本是"保守设计"，现在它是**实证刚需** —— 进程内 N-API 绑定遇到这种情况会把整个 daemon 打死。`runProbe.ts` 显式识别 `SIGABRT` / exit 134 / `SIGSEGV` / exit 139 并归类为 `kind: 'crash'`。
2. **L1 CPU 包是承重墙。** 它必须随安装包分发、必须不可卸载、必须在任何"清理缓存"逻辑中被排除。

---

## 6. 要求 2.1 完整闭环实测

这是本次 spike 最有说服力的一段。`[实测]`

### 步骤 1 — 只有 L1 core 包（模拟"用户刚装完"）

```
$ tar xzf whispercpp-cpu-linux-x64.tar.gz     # 7,695,565 B
$ ./openmemo-probe ./runtime
   deviceCount = 1  ggmlAbi = 0.15.1
   - CPU | cpu | AMD RYZEN AI MAX+ 395 w/ Radeon 8060S | sw= False
   stderr: load_backend: loaded CPU backend from .../libggml-cpu-zen4.so
```

### 步骤 2 — "用户在网页上点了 [安装 Vulkan]"

```
$ tar xzf whispercpp-vulkan-linux-x64.tar.gz  # 22,721,724 B
$ cp whispercpp-vulkan-linux-x64/libggml-vulkan.so runtime/
   added: libggml-vulkan.so  (74145568 bytes)
```

**L2 包里恰好只有 1 个文件。**

### 步骤 3 — 重新 probe（无重装、无重启）

```
$ ./openmemo-probe ./runtime
   deviceCount = 1  ggmlAbi = 0.15.1
   - CPU | cpu | AMD RYZEN AI MAX+ 395 w/ Radeon 8060S | sw= False
   stderr: ggml_vulkan: No devices found.
   stderr: load_backend: loaded Vulkan backend from .../libggml-vulkan.so
   stderr: load_backend: loaded CPU backend from .../libggml-cpu-zen4.so
```

**Vulkan 后端确实被加载了**（本机无 GPU 所以枚举为 0，正确降级）。

### 步骤 4 — 包的可重定位性

解压到全新目录、`env -u LD_LIBRARY_PATH` 运行：

```
$ cd /tmp/packtest/whispercpp-cpu-linux-x64
$ env -u LD_LIBRARY_PATH ./whisper-cli -m ... -f ...
load_backend: loaded CPU backend from /tmp/packtest/whispercpp-cpu-linux-x64/libggml-cpu-zen4.so
PACK RTF=0.0285 speedup=35.0x
```

**完全可重定位**（靠 `-DCMAKE_INSTALL_RPATH='$ORIGIN' -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON`，与 llama.cpp 官方 CI 同款）。

### 6.1 包体积实测汇总

| 包 | 内容 | 解压 | tar.gz |
|---|---|---|---|
| **L1 core** `whispercpp-cpu-linux-x64` | 12 个 CPU 变体 + libwhisper + libparakeet + whisper-cli/server/bench/vad（21 文件） | 20.8 MB | **7.70 MB** |
| **L2 vulkan** `whispercpp-vulkan-linux-x64` | **`libggml-vulkan.so` 一个文件** | 74.1 MB | **22.72 MB** |

对照 whisper.cpp 官方 Linux CPU tarball 9,379,235 B —— 我们的 7.70 MB 更小（去掉了 parakeet 测试可执行文件等）。**R-02 估计的 "L1 8–20 MB" 成立。**

---

## 7. 构建系统

### 7.1 `scripts/build-whisper.sh` `[实测跑通 cpu + vulkan]`

平台 × 后端参数化。关键设计：

- **L1 vs L2 的产物形态不同**：`cpu` 包含引擎+全部 CPU 变体+CLI；其他后端**只装 `ggml-<backend>` 那一个库**（加必要的厂商运行时 DLL）。这是"L2 只是 delta"的实现。
- **记录 ggml ABI** 进 manifest（实测 v1.9.1 = `0.15.1`），用于 gate 跨引擎复用。
- **macOS ad-hoc 签名在 strip 之后执行** —— strip 会使签名失效，顺序反了就白签。
- **`libcuda`/`nvcuda` 绝不打包** —— 它们是驱动组件，NVIDIA 不允许再分发。脚本里显式注释了这一点。
- 自动产出**每文件 SHA256** 的 manifest 片段（ADR-004 决策 5：Ollama 的下载器没做校验，我们必须做）。

实测输出：
```
==> ggml ABI: 0.15.1
==> pack:     dist/packs/whispercpp-cpu-linux-x64.tar.gz (7.4M)     [46.6 s]
==> pack:     dist/packs/whispercpp-vulkan-linux-x64.tar.gz (22M)
```

### 7.2 `scripts/build-probe.sh` `[实测跑通]`

编译 `packages/runtime/src/native/probe.c`，链接 `ggml-base` + `ggml`，带自检 smoke test。

### 7.3 `.github/workflows/build-backends.yml` — **已在 CI 执行过**

✅ **已执行多轮**（首轮 run 31014564498：12 job，3 success / 8 failure / 1 skipped），逐平台结论见 D-11 §4 与 §8。
**此前这里写着"⚠️ 本仓库无 git remote，此 workflow 从未执行过"** —— remote 已配（T-145，`origin https://github.com/faorcoek042/openmemo.git`）。矩阵：

| 平台 | runner | 后端 |
|---|---|---|
| macOS arm64 | `macos-26` | metal, cpu |
| macOS x64 | `macos-15-intel` | cpu |
| Linux x64 | `ubuntu-22.04` | cpu, vulkan, cuda, rocm |
| Linux arm64 | `ubuntu-24.04-arm` | cpu, vulkan |
| Windows x64 | `windows-2025` / `windows-2022`(cuda) | cpu, vulkan, cuda |

**runner label 已核实（2026-08-02）**：`macos-13` 已从 runner-images **完全移除**，`macos-14` 已标记 deprecated → 因此用 `macos-15-intel` 和 `macos-26`。`ubuntu-24.04-arm` 对公开仓库免费。Node 基线按 **ADR-006 决策 7 = 22**。

**第一次真跑一定会失败**，可预期的问题：CUDA/ROCm job 撞 14 GB 磁盘上限（已加 `jlumbroso/free-disk-space@v1.3.1`）、SDK 路径漂移、MSVC generator 差异。

---

## 8. `packages/runtime` 实现

`pnpm -r build` **EXIT=0**（全工作区通过）。

| 文件 | 职责 | 验证 |
|---|---|---|
| `native/probe.c` | 权威设备枚举，输出 JSON | **[实测]** 编译并运行 |
| `probe/runProbe.ts` | 子进程 + 10s 超时 + SIGABRT/SIGSEGV 识别 + 熔断 | **[实测]** 编译产物真跑 |
| `detect/system.ts` | OS/CPU/RAM/磁盘 | **[实测]** Linux 分支；mac/Win **未验证** |
| `detect/gpu.ts` | **advisory** GPU 提示 | **[实测]** Linux 分支；mac/Win **未验证** |
| `backends/manager.ts` | 融合成 `HardwareInfo`、降级链、ABI gate | **[实测]** 真机产出契约对象 |
| `selfTest.ts` | 真实推理自检 + RTF | **[实测]** 见下 |

### 8.1 契约对齐（回应 `model-mgmt`）

**按 `packages/shared/src/hardware.ts` 实现 producer 端，字段全部对齐，无 DISPUTE。** 特别处理：

- `unifiedMemory === true` 时 `vramTotalMB`/`vramFreeMB` **一律填 `null`**（Apple Silicon 上"显存"是范畴错误）。
- `vramFreeMB` 拿不到就填 `null`，**不拿 total 冒充**。
- Windows `Win32_VideoController.AdapterRAM` 是 **uint32**，>4 GB 显存会回绕 → 实现里**把 ≥4095 MB 一律当作 unknown**，宁可给 `null` 也不给错数。真值从 probe 的 `memTotalBytes` 取。
- `cpu.features` 在 Windows 上无法直接查（`wmic` 已被 24H2 移除，`Get-CimInstance` 不给 ISA flags）→ 提供 `inferIsaFromBackendPath()`，**从 ggml 实际选中的后端文件名反推 ISA**。这比任何 API 都准，因为它就是推理引擎自己的判断。

### 8.2 真机运行结果 `[实测]`

```
$ node -e "import('./packages/runtime/dist/index.js').then(...)"
{
 "schemaVersion": 1, "os": {"platform":"linux","arch":"x64",...},
 "cpu": { "brand": "AMD RYZEN AI MAX+ 395 w/ Radeon 8060S", "physicalCores": 32,
          "features": ["avx","avx2","avx512_bf16","avx512_vnni","avx512bw","avx512dq",
                       "avx512f","avx512vbmi","avx512vl","avx_vnni","bmi2","f16c","fma","sse4_2"] },
 "ram": { "totalMB": 16766, "availableMB": 9093 },
 "unifiedMemory": false, "gpus": [],
 "backends": [
   { "id":"cuda",   "available":false, "installed":false,
     "unavailableReason":"backend package not installed" },
   { "id":"vulkan", "available":false, "installed":true,
     "unavailableReason":"installed but enumerated no devices (driver missing or too old)" },
   ... ],
 "selectedBackend": "cpu"
}
```

自检：

```
{ "passed": true, "devicesFound": 1, "rtf": 0.0282, "speedup": 35.48,
  "backendUsed": "CPU", "transcriptSimilarity": 1, "errorMessage": null }

UI string: Self-test passed on CPU backend: 11.0s of audio in 0.31s — about 35x real time
```

### 8.3 自己抓到的 bug（值得记录）

`selfTest` 第一版报 **`backendUsed: "Vulkan"`**，但计算实际 100% 在 CPU 上。

原因：我 grep 了**第一条** `load_backend: loaded <X> backend from ...`。但 ggml 是**先把找到的后端全部加载，再决定用哪个**：

```
ggml_vulkan: No devices found.
load_backend: loaded Vulkan backend from .../libggml-vulkan.so   ← 第一条，但没用它
load_backend: loaded CPU backend from .../libggml-cpu-zen4.so
whisper_backend_init_gpu: no GPU found                           ← 这才是答案
```

**`load_backend` 只代表"加载了"，不代表"用了"。** 已改为以 `whisper_backend_init_gpu` 行判定，复测输出 `"CPU"`。

这正是 ADR-004 决策 3 要防的那类错误 —— 一个自信的、错误的数字。**如果不是真跑了一遍，这个 bug 会一路带到 UI 上骗用户。**

---

## 9. 签名与分发（ADR-003 决策 4：不买证书）

| 平台 | 本项目做法 | 后果 | 日后升级路径 |
|---|---|---|---|
| macOS arm64 | `codesign -s -`（ad-hoc，免费） | 能运行（Apple Silicon 的硬性最低要求），但 Gatekeeper 首次运行会拦（若带 quarantine） | Apple Developer Program $99/年 → Developer ID 签名 + notarytool 公证 |
| macOS | daemon 下载后自动 `xattr -dr com.apple.quarantine` | 绕开 Gatekeeper 首次运行拦截 | 公证后可省 |
| Windows | **完全不签名** | 用户下载**安装包**时 SmartScreen 会警告；**下载的后端包不会**（程序化 HTTP 下载不附加 MOTW） | Azure Trusted Signing 或 OV 证书（EV 已不再给即时信誉） |

**注意顺序**：`strip` 会使 ad-hoc 签名失效 → 构建脚本里签名**必须在 strip 之后**。已实现。

⚠️ **mac/Windows 的签名行为本次全部未验证**（无对应机器）。特别是"程序化下载不打 quarantine"在 macOS 15/26 上是否仍成立，仍是 R-02 §F.3 第 6 项 UNKNOWN，需要一台 Mac 花 30 分钟验证。

---

## 10. 诚实清单

### 10.1 本次实测验证的（附命令与输出）
1. `GGML_BACKEND_DL=ON` 后端独立 `.so` + 运行时 dlopen —— `ldd` 证明
2. 12 个 CPU 变体自动打分选优（zen4）
3. CPU 变体降级链 zen4 → cooperlake → alderlake → sse42
4. 垃圾 `.so` 静默跳过
5. **无 CPU 后端 → SIGABRT exit 134**（最重要的负面发现）
6. Vulkan 后端在无 GPU 机器上编译成功
7. lavapipe 软件光栅化器二阶陷阱
8. 装了 Vulkan 包但无 GPU → 零损耗静默回落
9. 要求 2.1 完整闭环（丢一个文件即装上后端）
10. 包可重定位（`env -u LD_LIBRARY_PATH`）
11. tiny.en / base.en / sse42 的端到端 RTF
12. ggml ABI v1.9.1 = 0.15.1
13. `packages/runtime` 编译通过并在真机产出契约对象
14. build 脚本端到端跑通并产出 manifest + SHA256

### 10.2 未验证 / UNKNOWN
| # | 项 | 状态 |
|---|---|---|
| 1 | **CUDA vs Vulkan 性能比** | **仍是 UNKNOWN** —— 本机无 GPU。ADR-003 决策 3 的临时立场既未证实也未推翻 |
| 2 | macOS 全部分支（Metal/CoreML/签名/quarantine） | ⚠️ **部分已验**：Metal/CoreML 已在 `macos-26` runner 上编出并 ad-hoc 签名（`build-backends.yml` 有逐文件 `codesign --verify` 守卫），产物已进 `vendor/manifests/backends.json`（`whispercpp-cpu-macos-arm64`），见 D-11 §4.1/§8.1。**仍未验的只剩 quarantine/Gatekeeper 在真实用户机上的行为**（runner 不能代表用户机器）。**此前写着"未验证 —— 无 Mac"** |
| 3 | Windows 全部分支（DXGI/CIM/SmartScreen/MOTW） | ⚠️ **部分已验**：三个 Windows 后端（cpu/vulkan/cuda）均在 `windows-2025` 编译成功（D-11 §4.3），平台探针 20 条见 D-11 §3.1。**仍未验的是 SmartScreen/MOTW，以及非管理员账户下的 symlink**（D-11 §3.4：runner 跑在管理员下）。**此前写着"未验证 —— 无 Windows 机器"** |
| 4 | CUDA 包编译与体积 | **未编译** —— 无 CUDA SDK 与硬件 |
| 5 | ROCm 包编译 | **未编译** —— 无 ROCm |
| 6 | 单架构 CUDA 瘦身实际收益 | **未实测** |
| 7 | `.github/workflows/build-backends.yml` | ✅ **已执行**：run 31014564498（首轮 12 job，3 绿）等多轮，结论见 D-11 §4/§8。**此前写着"从未执行 —— 无 git remote"** |
| 8 | llama.cpp 与 whisper.cpp 后端包能否共用 | **未验证** —— whisper.cpp v1.9.1 = ggml 0.15.1，llama.cpp b10223 侧 UNKNOWN |
| 9 | arm64（Apple/Linux）上的 CPU 变体行为 | **未验证** —— arm64 走运行时特性检测而非 `CPU_ALL_VARIANTS` |
| 10 | `whisper_backend_init_gpu` 在**有 GPU** 时的确切日志格式 | **未验证** —— `parseBackendUsed()` 里已标注 |

### 10.3 建议的下一步 spike（按价值排序）
1. **[最高] 借一台有 NVIDIA 卡的机器**，跑 CUDA vs Vulkan 的 whisper RTF 对比。这是唯一能推翻/确认 ADR-003 决策 3 的实验，且只需一台机器一小时。
2. **[高] 单架构 CUDA 包瘦身实测**：`-DCMAKE_CUDA_ARCHITECTURES=86` 编一个，量 `ggml-cuda` 体积。决定 CUDA 包是 678 MB 还是 <100 MB。
3. **[中] 一台 Mac 30 分钟**：验证 ad-hoc 签名 + 下载不带 quarantine 是否成立。决定整个 mac 分发形态。
4. ~~**[中] 给仓库配 git remote**，让 CI 真跑一次，把 mac/Win 产物拿到手。~~ ✅ **已完成（T-145）**：remote 已配，CI 已跑多轮，mac/Win 产物已进 `vendor/manifests/backends.json`。**此前这条写着待办。**
