# inbox / amd-vulkan

## [2026-08-07 00:52] T-161 SHARED-CHANGE 申报（动 manifest 之前）

`git status --short` 此刻只有我自己的两个未跟踪文件 + `progress-audit` 的回执，
`vendor/manifests/` **没有任何人的在途改动**。我接下来要改：

| 文件 | 改什么 | 冲突风险 |
|---|---|---|
| `vendor/manifests/backends.json` | `media-tools-linux-x64` / `media-tools-win-x64` 两条的 ffmpeg 7.1.5 → 8.1.2，**并把 tag 从 `autobuild-2026-08-02-13-17` 换到月末 tag**（前者约 9 天后会被上游删除，见下一条回执 §2） | 低（只改这两条的 5 个字段） |
| `vendor/manifests/components.json` | 同上两条的 `pinnedVersion` / `sizeBytes` / `sha256` / `sha256Provenance` / `tagPattern` | 低 |
| `package.json` | 一行：把 `selftest-elf-glibc.mjs` 接进 `test:ci-scripts`（已提交 `8092027`） | 低 |
| `apps/daemon/src/pipeline/ffmpegPinRot.test.ts` | **新文件**（不改 `pack-publish` 的 `platformPacks.test.ts`） | 无 |
| `scripts/build-whisper.sh` · `.github/workflows/build-backends.yml` · `scripts/ci/*` | 我的地盘（已提交 `8092027`） | 无 |

**macOS 那条我不动** —— 升 8.x 需要把 `stableOnly: true` 主动放松，那是要人拍板的，见下一条回执。

反向验证一律跑在 `/tmp/amd-vulkan/` 的隔离副本上（PROTOCOL §10），共享树的
`vendor/manifests` 在验证期间不被改动。

---

## [2026-08-07 01:35] T-161 PROGRESS

交付：提交 `8092027`（Vulkan 包的两条阻碍）、`f697817`（ffmpeg 8.1.2 + pin 会烂掉那条），已 push。
新文件：`scripts/ci/check-elf-glibc.mjs`、`scripts/ci/selftest-elf-glibc.mjs`、
`apps/daemon/src/pipeline/ffmpegPinRot.test.ts`。
门禁：`pnpm -r test` **1162 / 0** · `tsc -b` 0 · `eslint` 0 · `test:ci-scripts` 全绿 ·
`lint-workflows` 506 条。

---

# ★★★ 你要直接回答用户的那一句：**「那块 Radeon 8060S 现在能不能吃到 GPU 加速」**

## **不能。而且原因不在包上 —— 跑 daemon 的这台机器上根本没有那块 GPU。**

`[本机实测]`，全部是只读探测，没碰 `:10000`：

```
$ systemd-detect-virt                      → kvm            ← 这是一台 KVM 虚拟机
$ ls /sys/class/drm                        → No such file or directory
$ ls /dev/dri                              → No such file or directory
$ ls /dev/kfd                              → No such file or directory   （ROCm 的入口）
$ grep -i drm /proc/devices                → （空，内核里没有 DRM 子系统）
$ lspci | grep -i vga                      → 00:02.0 Device 1234:1111     ← QEMU 虚拟 VGA
$ 遍历 /sys/bus/pci/devices/*/vendor 找 0x1002 → 一个都没有（全机 8 个 PCI 设备）
```

**跑产品自己的探测函数**（`packages/runtime/src/detect/gpu.ts` 的 `detectGpus()`，不是我另写的）：

```json
{ "gpus": [],
  "warnings": ["/sys/class/drm not readable (headless VM, container, or no DRM driver)",
               "no GPU detected; CPU backend only"] }
```

## ⚠️ 「AMD RYZEN AI MAX+ 395 w/ Radeon 8060S」那行字是 **CPU 名字**，不是探到的显卡

```
$ grep -m1 "model name" /proc/cpuinfo
model name : AMD RYZEN AI MAX+ 395 w/ Radeon 8060S

$ node -e "detectCpu()"
{ "brand": "AMD RYZEN AI MAX+ 395 w/ Radeon 8060S", "physicalCores": 32, ... }
```

`detectCpu()` 读的就是 `/proc/cpuinfo` 的 `model name`（`detect/system.ts:117`）。
**8060S 是这颗 APU 的核显营销名，被写进了 CPU 型号串里**，KVM 把宿主 CPU 型号透传给了 guest。
所以 `/runtime` 上那行字**不构成"这台机器上有一块可用的 GPU"的证据** ——
它和 `hw.probe`、`detectGpus()` 说的是两件事，而只有后两者是在回答"有没有设备"。

> 顺带订正一处措辞：8060S 是**核显（iGPU）**，不是独显。这影响的是预期
> （共享内存、gfx1151、ROCm 支持另说），不影响上面的结论。

## 更要紧的一条：**`gates-fix` 说的那条"门禁已解开"，在这台机器上不会触发**

`gates-fix` T-160 §2.2 写着：

> `AMD RYZEN AI MAX+ 395 w/ Radeon 8060S` → Linux advisory 走
> `/sys/class/drm/card*/device/vendor` 读到 `0x1002` → `candidateBackends: ['vulkan']`

**那是一条推断，不是实测；这台机器上 `/sys/class/drm` 整个目录都不存在。**
`detectGpus()` 返回 `gpus: []` → `advisoryCandidates` 为空 →
`applicability.ts` 的新规则 2 需要「advisory 认为本机硬件是它的候选」，条件不成立 →
**即使包补进 `backends.json`，在这台机器上它仍然会被判为"不适用"。**
门禁那一侧的修复本身是对的（它解开的是自指死锁），只是**这台机器不落在被解开的那一格里**。

## 如果强行装上会怎样？—— 我查到了，**不会更慢，但也什么都不会发生**

这台机器上 `libvulkan.so.1` 与 Mesa 的全套 ICD 都在（含 `radeon_icd.json`），
`vulkaninfo --summary` 只枚举到**一个**设备：

```
GPU0:  deviceType = PHYSICAL_DEVICE_TYPE_CPU
       deviceName = llvmpipe (LLVM 21.1.8, 256 bits)
       driverID   = DRIVER_ID_MESA_LLVMPIPE
```

我原本担心 ggml 会挑中 llvmpipe 去跑软件光栅化（那会**比 CPU 后端更慢**，
`detect/gpu.ts` 的文件头把这条当成反例记着）。**去读源码之后这个担心不成立**：
`vendor/whisper.cpp/ggml/src/ggml-vulkan/ggml-vulkan.cpp:6641,6731-6740` 里，
主选择只收 `eDiscreteGpu | eIntegratedGpu`，兜底只收"非 CPU 设备"，
`eCpu` 两处都被排除 → `ggml_vulkan: No devices found.` → 照常走 CPU。

**结论：装了不会变慢，但也不会变快。**

## 那要怎样他才能吃到 GPU

判据不在我们这边，在**这台 daemon 跑在哪儿**：

| 前提 | 现状 | 谁能改 |
|---|---|---|
| daemon 所在的系统里有 `/dev/dri/renderD*`（amdgpu 驱动 + 设备可见） | ❌ KVM guest 里没有 | 虚拟化层：GPU 直通，或把 daemon 跑在宿主机上 |
| Vulkan 能枚举到 `eIntegratedGpu` 的 AMD 设备 | ❌ 只有 llvmpipe | 同上 |
| 目录里有一个能装的 Linux Vulkan 包 | 🟡 本轮消掉两条阻碍，**还差第三条**（见 §1.3） | 我 + 解析器那边 |
| advisory 探测认出 0x1002 | ❌ 见上（没有 GPU 就没有 vendor id 可读） | 同第一行 |

**四条里有三条卡在同一件事上：那块核显没有暴露给这台虚拟机。**
先解决这一条，其余才有意义 —— 反过来说，**在解决它之前，把包补进目录也只是多一个装了没用的按钮。**

---

# §1 ①「让 Linux Vulkan 包真的能用」—— 两条消掉了，**我又查出第三条**

## 1.0 结论先给

| 阻碍 | 状态 | 判据 |
|---|---|---|
| 1 · 增量包不自包含 | ✅ **消掉**（构建侧） | 加速包现在 = 核心 + 后端模块；CI 上 `whisper-cli --help` 从解压目录裸跑成功 |
| 2 · GLIBC_2.38 | ✅ **消掉**（构建侧） | vulkan 腿挪回 `ubuntu-22.04`，glslc 改走 LunarG SDK；守卫钉住 ≤ 2.34 |
| 3 · **解析器不认包，谁先被 `readdir` 到就跑谁** | 🔴 **没消掉，也不在我地盘** | 见 §1.3 —— **它单独一条就足以让前两条白做** |

**所以我没有把它补进 `backends.json`。** 按已批准的判据：现在补进去，用户会得到一个
"看得见、点得动、装得上、**跑起来还是 CPU**"的包 —— 比"看不见"更糟，而不是更好。

## 1.1 阻碍 1：不自包含 —— 我自己把 release 上那个包解开验的

不是转述 `pack-publish`，是我自己下下来的：

```
$ curl -sSL .../backend-packs-2026.08.06/whispercpp-vulkan-linux-x64.tar.gz
  19,187,014 B   sha256 00b6822af5972d9b8e5d54dfbf8b21e3f2dc716ba5d18eec4837038a671837b0
$ tar tzf
  whispercpp-vulkan-linux-x64/
  whispercpp-vulkan-linux-x64/libggml-vulkan.so      ← 整个包**只有这一个文件**（解开 62,430,704 B）

$ objdump -p libggml-vulkan.so | grep -E 'NEEDED|RUNPATH'
  NEEDED   libggml-base.so.0     ← ★ 它在**另一个包**的目录里
  NEEDED   libvulkan.so.1
  NEEDED   libstdc++.so.6 / libm.so.6 / libgcc_s.so.1 / libc.so.6
  RUNPATH  $ORIGIN

$ cd 解压目录 && python3 -c "ctypes.CDLL('./libggml-vulkan.so')"
  dlopen 失败: libggml-base.so.0: cannot open shared object file: No such file or directory
```

**最后那一行是实测，不是推理** —— 而且是在一台 glibc 2.42（远新于 2.38）的机器上，
也就是说**阻碍 1 单独就足以致命，与阻碍 2 无关**。

### 修法（`scripts/build-whisper.sh`）

把「核心包才拷引擎」那一串抽成 `copy_core_files()`，**每个包都先跑一遍**；
加速包在此之上再拷自己那个 `ggml-<backend>` 模块。
形状照抄目录里唯一被认为"能用"的加速包 —— 上游的 `whispercpp-cuda-12.4-win-x64`，
它的 `providesFiles` 里就有 `whisper-cli.exe`。

脚本里那段「L2 = **ONLY** the single ggml-`<backend>` shared library」的设计注释
（T-146 已指出它与实现不符、但当时把不一致原样留着）**按 B 的方向解决了**，注释同步改写。

### ⚠️ 这个改动把旧守卫的前提抽掉了，所以必须在原地补守卫

改之前：加速模块没编出来 → stage 为空 → `emit-pack-manifest` 当场 die（红）。
改之后：核心文件先进 stage，**stage 永远非空** → 同一个失败会打出一个
"能下载、能安装、里面根本没有加速器"的包并**报绿**。
**那正是 T-145 在 `macos-arm64-cpu` 上实测到的形状，只是换了一格。**

所以同一次改动里加了三条守卫（加速模块 / `whisper-cli` / `ggml-cpu*` 各一条），
并在 `selftest-build-whisper.sh` 里补了三条反向用例（RV-A/B/C）。

**变异验证**（`/tmp/amd-vulkan/rv-tree` 隔离副本，PROTOCOL §10）——
把那条守卫整段删掉，其余一字不动：

```
⑤ ★反向（T-161）
  ✘ RV-A · 加速模块没编出来 → 红（此前靠「stage 为空」接住，现在接不住了）
      居然成功了。stage 内容：
      ==> pack: .../whispercpp-vulkan-linux-x64.tar.gz (4.0K)
        whisper-cli / libwhisper.so.1.9.1 / libggml-cpu-haswell.so /
        libggml.so.0.15.1 / libggml-base.so.0.15.1
      ==> done: whispercpp-vulkan-linux-x64          ← 叫 vulkan，里面零个 vulkan
  ✔ 17 passed, 1 failed
```

### `[CI 实测]` 真 runner 上的正面证据（run 31119961630，`linux-x64-cuda` **success**）

Vulkan 那条腿本轮被 GitHub 的服务故障打掉了（见 §3），但**同一个改动**在 CUDA 腿上跑通了，
而 CUDA 与 Vulkan 走的是同一段代码：

```
pack is relocatable                       ← 解到 /tmp、env -u LD_LIBRARY_PATH、./whisper-cli --help 成功
== ldd libggml-cuda.so ==
    libggml-base.so.0 (0x00007f8edf34d000)          ← ★ 从**包内**解析到了（修复前是 dlopen 报错那条）
    libcudart.so.12 => /usr/local/cuda-12.4/...
    libcuda.so.1 => not found                        ← NVIDIA 驱动，本来就不许随包分发
libggml-cuda.so 的 libggml-* 依赖全部解析得到（其余为宿主提供，见上）
```

> `libcuda.so.1 => not found` 这一行正是我把断言收窄到 `libggml-*` 的理由：
> 如果断言"任何 not found 都算红"，这条完全正确的腿会被判红，
> 而**一条会对不相干的东西发表意见的检查，说对的时候也不该被相信**。

## 1.2 阻碍 2：GLIBC_2.38 —— **22.04 上拿得到 glslc，而且是两个坑不是一个**

### 先回答"能不能拿到"：**能。**

| 路线 | 拿得到 glslc？ | 结论 |
|---|---|---|
| jammy 官方 apt | ❌ | `glslc` 二进制包**首次出现在 noble**；jammy 连 `shaderc` 源码包都没有；backports 也没有。按**文件名**搜 jammy/amd64 的 `glslc`，6 条命中全是 `SPIRVGLSLCanonicalization.h` 之类无关文件。`glslang-tools` 只给 `glslangValidator` |
| **LunarG SDK（tarball，经 `jakoch/install-vulkan-sdk-action`）** | ✅ **选它** | 就是**下面 Windows 腿已经在用的那个 action**；x86_64 分支不看发行版，下的是 LunarG 官方 tarball |
| LunarG apt（`lunarg-vulkan-jammy.list`） | ✅ | 仓库还活着（`dists.json` 仍把 Ubuntu 22.04 列为 SupportedDistro），但**整个 Linux apt 频道自 2025-05-06 起停更**（jammy 与 noble 一起冻），tarball 频道还在走 |
| 24.04 上用编译器开关压住 C23 重定向 | ❌ **不可行** | 见下 |
| 24.04 编 shader → 22.04 编 C++ | ❌ 不推荐 | ggml **没有任何开关**支持；`find_package(Vulkan COMPONENTS glslc REQUIRED)` 在 configure 阶段就红，而且 CMake 会**真的跑 glslc** 做 5 次特性探测再喂给 `add_compile_definitions` |

### ★ 第二个坑（此前没人提过，光有 glslc 也过不去）

`ggml-vulkan/CMakeLists.txt:14` 要的是 `find_package(SPIRV-Headers **CONFIG** REQUIRED)` ——
**CMake package config**。而：

```
jammy   spirv-headers 文件列表 grep -i cmake → 空（只有 /usr/share/pkgconfig/SPIRV-Headers.pc）
noble   spirv-headers                        → /usr/share/cmake/SPIRV-Headers/SPIRV-HeadersConfig.cmake
LunarG  tarball                              → x86_64/share/cmake/SPIRV-Headers/SPIRV-HeadersConfig.cmake
```

**所以就算凭空变出一个 glslc，jammy 的 stock 包仍然会在 configure 阶段红。**
LunarG SDK 一次解决两条，而且 `ggml-vulkan/CMakeLists.txt:11-13` 恰好写着
「`$VULKAN_SDK` 存在就 append 进 `CMAKE_PREFIX_PATH`」—— 两样东西一次到位。

`[实测]` LunarG tarball 里那个 `glslc` 自身最高只要 **GLIBC_2.29**，jammy(2.35) 上跑得动，
`objdump -T | grep -c isoc23` = 0。带版本号的不可变 URL 活着：
`sdk.lunarg.com/sdk/download/1.4.313.0/linux/vulkansdk-linux-x86_64-1.4.313.0.tar.xz` → HTTP 200, 341,756,484 B。

### 为什么"留在 24.04 想办法压住 C23"这条路被排除（实测矩阵）

触发源是 **g++ driver 无条件注入的 `-D_GNU_SOURCE`**
（`gcc/config/gnu-user.h` 的 `CPLUSPLUS_CPP_SPEC`，**gcc-12 与 gcc-13 两个分支字节相同**），
它经 `features.h` 打开 `__GLIBC_USE(ISOC2X/ISOC23)`，再由 `stdlib.h` 把 `strtol` 换成 `__isoc23_strtol`：

```
C   -std=gnu17  → plain strtol          C++ -std=c++11 → __isoc23_strtol
C   -std=c17    → plain strtol          C++ -std=c++17 → __isoc23_strtol   ← ★ 不够
C   -std=c23    → __isoc23_strtol       C++ -std=c++20 → __isoc23_strtol
                                        C++ -std=gnu++23 → __isoc23_strtol
```

**C++ 侧任何 `-std=` 都无效**；换 gcc-12 也无效（重定向在 glibc 2.39 的**头文件**里）。
另外即使把 `__isoc23_*` 全清掉，24.04 也未必回得到 2.34 —— 它的 `libm` 里
`fmod` 的**默认符号版本就是 `fmod@@GLIBC_2.38`（实测 readelf）**。
whisper.cpp 眼下没用到 `fmod`（全仓 grep 0 命中），但那是运气，不是保证。

同一形状的公开先例：`premake/premake-core#2758`（标题就是「Ubuntu 22.04 (glibc 2.35)」），
beta4 用 22.04 编 → 最高 2.34 能跑；beta5 换 24.04 → 需要 2.38 → 在 22.04 上挂；
新增符号里就有 `__isoc23_strtol@GLIBC_2.38` 与 `fmod@GLIBC_2.38`。
GitHub 全站 `"__isoc23_strtol"` 有 187 条 issue/PR，**实际采用的修法全是"换到更老的 glibc 上编"**，
没有一个是靠编译器 flag 解决的。

### 把基线从注释变成守卫（`scripts/ci/check-elf-glibc.mjs`）

D-11 §8.2 自己写着「**一条靠"记得别动它"维持的基线，等价于一条迟早会被绕过的基线**」——
它已经被绕过一次了，而且是在解决另一个问题（glslc）的过程中**顺手**绕的。
所以现在它是 CI 上的一步：遍历 stage 里所有 ELF，取最高 `GLIBC_x.y`，> 2.34 就红并**点名符号**。

`[本机实测]` 拿它跑那个真实的 release 产物：

```
check-elf-glibc: 1 个 ELF，上限 GLIBC_2.34，实测最高 GLIBC_2.38
  ✘ GLIBC_2.38   whispercpp-vulkan-linux-x64/libggml-vulkan.so
      (GLIBC_2.38) __isoc23_strtol
      (GLIBC_2.38) __isoc23_strtoul
      (GLIBC_2.38) __isoc23_strtoull
exit=1
```

`[CI 实测]` 同一个守卫在真 runner 上（run 31119961630）：

```
linux-x64-cpu   check-elf-glibc: 22 个 ELF，上限 GLIBC_2.34，实测最高 GLIBC_2.34  ✔
linux-x64-cuda  check-elf-glibc: 23 个 ELF，上限 GLIBC_2.34，实测最高 GLIBC_2.34  ✔
```

**注意它打印了"22 个 / 23 个"** —— 数到 0 个会当场红（`ci-prep` C5 那一族），
一个什么都没检查的检查器是最坏的那种绿。
配套 `selftest-elf-glibc.mjs` 13 条用例，含 5 条反向：超标必须红并点名符号 /
空集必须红 / `2.9` 不许被判成大于 `2.34` / 没有 `objdump` 必须红（**「我拿不到」≠「这里没有」**）。

## 1.3 🔴 阻碍 3（**我新查出来的，前两条消掉也白搭**）：跑起来的是**哪一个** whisper-cli 是未定义的

`packages/pipeline/src/tools.ts` 的 `findInBackendPacks()` 按 `readdir` 顺序取**第一个**命中：
**不排序、不看 `BackendPack.priority`、不看 `selectedBackend`。**
（它的文档注释写着 "We scan two levels, **newest first**, and take the first hit" ——
**实现里没有任何排序**，那句是错的。）

`[本机实测]`，用**真的归档名**造布局、调**产品自己的**那个函数：

```
readdir: whisper-bin-ubuntu-x64.tar.gz  whispercpp-vulkan-linux-x64.tar.gz
discoverTools 会跑的那个 whisper-cli =>
   whisper-bin-ubuntu-x64.tar.gz/whisper-bin-ubuntu-x64/whisper-cli     ← CPU 那个
```

两种安装顺序（先 cpu 再 vulkan / 先 vulkan 再 cpu）**结果相同，都是 CPU 那个**。

### 三条推论

1. **一个自包含的 Vulkan 包装上去，跑的仍然是 CPU 包里的 whisper-cli** ——
   而 ggml 只在**它自己所在的目录**里 dlopen 后端模块，
   所以 Vulkan 模块虽然就在盘上，也永远不会被加载。**症状与修复前完全一样，且同样静默。**
2. **`selectedBackend` 是装饰性的。** `/api/backends/select` 写进 prefs 与
   `hardware.selectedBackend`，只驱动 `recommended` / `active` 两个展示标志；
   `buildPipeline()` → `discoverTools()` **从来看不到它**（全仓查过接线）。
3. **这条已经在生效，不是将来时**：目录里那个"唯一能用的加速包"
   `whispercpp-cuda-12.4-win-x64` 与 `whispercpp-cpu-win-x64` 同时装着时，
   `[本机实测]` 解析到的是 `whisper-bin-x64.zip/Release/whisper-cli.exe`（CPU 那个）。
   也就是说 **Windows CUDA 那条"能用"的路，可能一直没有真的走通过。**
4. 附带一条：`runBackendSelfTest()`（`runtime/setup.ts:641-644`）也走同一个
   `findInBackendPacks` 且**不接受 pack id** —— 给某个加速包点"自测"，
   跑的可能是另一个包的二进制。**它给出的绿是关于别的东西的绿。**

### 我为什么没有自己修

`tools.ts` / `runtime/setup.ts` 是 `gates-fix` 正在收敛的解析器那一片（任务书划的边界），
我在 `.github/workflows` / `scripts` / `vendor/manifests`。**建议的判据**（给接手的人）：

> `findInBackendPacks()` 必须**确定性**且**能表达偏好**：候选先排序（消除 `readdir` 依赖），
> 再按「`selectedBackend` 对应的包 > 其它加速包（`priority` 降序）> 核心包」挑。
> 「自包含」是这条修法安全的**前提**：包里带全 CPU 模块，所以即使 GPU 不可用，
> 挑了加速包的二进制也只是退回 CPU，不会更差。**两个改动是配套的，缺一不可。**

⚠️ 同时**订正 `gates-fix` 回执 §5.1 的一句话**：
「接手的人只要把包修好、补一条 manifest 条目，用户那块 8060S 就能装上了 —— 门禁不会再挡。」
—— **"装得上"是对的，"能用上"不是**：还差这条解析器，以及这台机器上根本没有 GPU（见开头）。

---

# §2 ② ffmpeg —— 升到 8.1.2，**顺带修掉一个 9 天后就会 404 的 pin**

## 2.1 ★ 比"版本旧"严重得多：我们钉的那个 tag 会被上游删掉

`[实测]` `raw.githubusercontent.com/BtbN/FFmpeg-Builds/master/util/prunetags.sh`：

```bash
KEEP_LATEST=14      # 只保留最近 14 个 autobuild tag
KEEP_MONTHLY=24     # 外加每月**最后一个** build，保留 24 个月
gh release delete --cleanup-tag --yes "${TAG}"
```

`[实测]` GitHub API 数出 BtbN **全仓库只剩 37 个 release**：
22 个月末（`2024-09-30` … `2026-06-30`，每月恰好一个）+ 最近 14 个日构建
（`07-23 … 08-06`）。**中间的日构建一个都不剩 —— 策略在执行。**

我们钉的 `autobuild-2026-08-02-13-17` 是日构建，从新往旧数第 5 个 →
**再来 9 次日构建就出局，URL 变 404**。

> **形状与本仓最贵的那一类完全一致**：清单校验通过、sha256 正确、代码一行没改，
> 而某一天之后**所有新用户的 ffmpeg 下载变成 404**；已经装过的人毫无感觉，
> 所以不会有人报障。

**成因在我们自己的注释里**：`packages/downloader/src/upstream.ts:94` 写着
「a moving `latest` tag and **immutable** `autobuild-<date>` tags」——
**那句 "immutable" 是错的**，而正是它让人放心地钉了一个日构建。已订正。

→ 新 pin：**`autobuild-2026-07-31-14-10`**（7 月最后一天，受 `KEEP_MONTHLY` 保护约 24 个月）。
→ 新守卫 `apps/daemon/src/pipeline/ffmpegPinRot.test.ts`：只允许钉「每月最后一天」的 tag，
   判据钉的是**结构**（tag 里的日期是不是它那个月的最后一天，含闰年），不是关键词；
   `components.json` 的 `tagPattern` 同步收紧到 `^autobuild-\d{4}-\d{2}-(2[89]|3[01])-`
   （regex 表达不了"该月最后一天"，取它的超集，剩下的由守卫兜底）。

## 2.2 要发的清单（三平台一起看）

| 平台 | 资产 | 字节 | sha256（**本机全量下载后复算**） | tag |
|---|---|---:|---|---|
| **linux-x64** ✅ 已改 | `ffmpeg-n8.1.2-34-g9b6c8969e0-linux64-gpl-8.1.tar.xz` | 124,917,816 | `09fc77be269c7053e438b7e96548e4af97604faf96a42c4a3c56a1ad74c22c0a` | `autobuild-2026-07-31-14-10` |
| **win-x64** ✅ 已改 | `ffmpeg-n8.1.2-34-g9b6c8969e0-win64-gpl-8.1.zip` | 167,405,723 | `cc4156d51387566ea8ba653fc3a04897bdf812fddf652428d9030bbf7ae24835` | 同上（守卫要求两平台同 tag） |
| **macos-arm64** ⛔ **没动，等你裁** | `jellyfin-ffmpeg_8.1.2-2_portable_macarm64-gpl.tar.xz` | 32,894,656 | `397642a17f0e34882875f3127cc065b8f225a3d5b0fc4c068c1fe6ad49e5485c` | `v8.1.2-2`（**GitHub prerelease=true**） |

三个都是匿名下载（`env -u GITHUB_TOKEN -u GH_TOKEN curl`），复算值与 GitHub API 的
`digest` 字段**逐字符一致**。**不需要建任何 release** —— 这三个都是上游的资产，我们只是指过去。

变体仍选 `gpl`（静态、单文件）：解开就是 `<top>/bin/{ffmpeg,ffprobe}`，
与 `tools.ts:166` 记的 BtbN 布局一致，`findInBackendPacks` 不用改。
`gpl-shared` 会带一整套 `libav*.so` 反而更碎。体积代价 +5%（linux +5.9 MB / win +8.7 MB）。

## 2.3 macOS 那条为什么我没动（这条要你拍板）

**上游不是"只有 7.x"** —— `jellyfin-ffmpeg` 有 `v8.1.2-2`（2026-07-21）。
但它和 `v8.1.2-1` / `v8.1.1-4` 一样是 **`prerelease=true`**，
而 `/releases/latest` 返回的是 `v7.1.4-3, prerelease=false`。

而我们 `components.json` 里那条写着 **`"stableOnly": true`**，
`packages/downloader/src/upstream.ts:122` 会据此 `.filter(r => !r.prerelease)` ——
**我们自己的升级检查器会主动过滤掉全部 8.x**。

> 也就是说：升 macOS = **主动放松一条既有的保守约束**（`stableOnly: true → false`），
> 而放松之后它对**将来所有版本**都生效。这是产品决策，不是我能替谁做的。

材料已备齐，你说升我十分钟就能补上：
- sha256 已本机复算（见上表）；
- `[本机实测]` Mach-O 解析：**`LC_BUILD_VERSION` minos 仍是 12.0（没抬高）**，
  27 条 `LC_LOAD_DYLIB` 全部指向 `/System/Library/Frameworks/` 与 `/usr/lib/`，
  **0 条 `@rpath`、0 条 LC_RPATH、有 `LC_CODE_SIGNATURE`**；归档仍是扁平的 `ffmpeg` + `ffprobe`。
  → `requiresDriver.macosVersion: "12.0"` 不用改。
  ⚠️ jellyfin 的 mac 构建脚本里**没有任何 `MACOSX_DEPLOYMENT_TARGET`**，跑在 `macos-latest` 上 ——
  minos 这次没漂是**运气不是保证**，每次升级都该重跑这条检查（与 D-11 §8.1 是同一族）。
- ⚠️ `UNKNOWN`：jellyfin 何时把 8.x 从 prerelease 转正 —— 查不到 roadmap，issue 里只有 1 条无关 bug。

**不改的代价**：三平台 ffmpeg 大版本不齐（Linux/Win 8.1.2，macOS 7.1.4）。
功能上无害（我们只用 wav 转码 + probe，两版行为逐条验过一致），
但 `checkFfmpeg` 上报的版本号会分叉。
**我不为了整齐去找一个不可信的源** —— `evermeet.cx` 官网明说不做 Apple Silicon；
`osxexperts.net` 是无版本号 URL（本项目已否决）；
`ffmpeg.martin-riedl.de` 有 macOS arm64 的 9.0，但它的 sha256 与文件同源
（源站被攻破两者一起变），**凭证强度低于 GitHub 自己算的 digest**，按否掉
`eugeneware/ffmpeg-static` 的同一把尺子，它不合格。

## 2.4 「升级前先确认不会破坏现状」—— 把 8.1 的真二进制拿下来跑我们真实的 argv

**先更正任务书里的一个前提：我们根本没有用任何响度 normalize 滤镜。**
全仓 `-af` / `loudnorm` / `dynaudnorm` / `-filter_complex` / `-vf` **零命中**
（唯一一处是 `ffmpeg.ts:11` 那句"永远不要用"的注释，理由是滤镜语法是第二层注入文法）。
`normalizeToPcm16k` 里的 normalize 指的是**格式归一化**。
→ **滤镜在 8.x 的行为变化对我们零影响。**

`[本机实测]`（跑的是刚下下来的 n8.1.2-34 linux64）：

| 我们用的 | 8.1 上 | 证据 |
|---|---|---|
| `ffmpeg -version` + `/ffmpeg version (\S+)/` | ✅ | `ffmpeg version n8.1.2-34-g9b6c8969e0-20260731 …` |
| `-progress pipe:1` + `/^out_time_us=(\d+)$/` | ✅ | stdout 出现 `out_time_us=3000000` |
| `-nostdin -hide_banner -loglevel error -y -vn -map 0:a:0 -ac 1 -ar 16000 -c:a pcm_s16le -f wav` | ✅ | exit 0，**stderr 零字节**（无 deprecation 警告） |
| ffprobe `-print_format json -show_format -show_streams` | ✅ | `format_name=wav` `codec_name=pcm_s16le` `sample_rate=16000` `channels=1` |
| `-protocol_whitelist`（安全边界） | ✅ **仍在拦人** | 远程白名单去探本地文件 → `Protocol 'file' not on whitelist …`，**exit 1** |
| `localFile.ts:164` 的 `/hls\|applehttp\|m3u/i` | ✅ | `ffprobe -demuxers` → `D hls  Apple HTTP Live Streaming`，名字没变 |
| glibc 下限 | ✅ **2.28** | 用我们自己新写的守卫跑的：`2 个 ELF … 实测最高 GLIBC_2.28`，**低于 2.34 基线，无代价** |
| 归档布局 | ✅ | `<top>/bin/{ffmpeg,ffprobe}`，与 7.x 相同 |

Changelog 逐条核对：8.1 唯一的移除是 `Remove the old HLS **protocol** handler`
（删的是 `hls://` 协议，不是 HLS demuxer —— `ff_hls_demuxer` 两边都在），
而我们的 `REMOTE_PROTOCOLS` 本来就不含 `hls`。
8.0 的移除项（OpenSSL <1.1.0、yasm、OpenMAX）全是构建期或我们不用的。
真正删过 CLI 选项的是 7.0（`-psnr` / `-map_channel`），我们早已在 7.1 上。
ffprobe JSON **只有新增字段**（`nb_stream_groups` / `mime_codec_string` / `disposition.multilayer`），
我们的 parser 按名取字段，无害。

⚠️ **`UNKNOWN`（不编）**：BtbN win64 的 n8.1 PE 导入表是否与 7.1 完全一致 ——
我没下 167 MB 去 dump（构建镜像层面同一套 mingw-w64 + UCRT + `-static-libgcc -static-libstdc++`，
但那是推断）。这条要靠 Windows 侧的冷启动实跑来收。

## 2.5 顺带：ffmpeg **9.0 上游已发**，但现在还不能用

`api.github.com/repos/FFmpeg/FFmpeg/tags` 有 `n9.0`，`release/9.0` 分支在。
但 **BtbN 的日常矩阵只产 `master / 8.1 / 7.1` 的 linux64**，`9.0` 只在 `include:` 里且只针对 win64，
`2026-08-06` 那个 release 的 49 个资产里**一个 n9.0 都没有**。
→ 9.0 满足不了「两平台钉同一 tag」的守卫，**8.1 是当前唯一可选的最新版**。
（记一条备忘：9.0 移除 CELT 解码，Changelog 括号里明说**不影响 Opus**，我们的 benchmark clip 是 Opus。）

---

# §3 CI 上的验证：拿到了什么、没拿到什么

**run 31119961630**（commit `8092027`）：

```
linux-x64-cpu     success    ← glibc 守卫 22 个 ELF ≤ 2.34；relocatable 通过
linux-x64-cuda    success    ← ★ 加速包自包含的正面证据（见 §1.1）
linux-x64-vulkan  failure    ← ⚠️ 不是我们的代码
macos ×2 / windows ×3  failure/cancelled  ← 同上
merge-manifest    skipped
```

**五条失败全部死在 `Set up job`，一行我们的代码都没跑到**：

```
Getting action download info
Failed to resolve action download info. Error: Service Unavailable
Retrying in 25.75 seconds
Failed to resolve action download info. Error: Service Unavailable
##[error]Service Unavailable
```

这是 GitHub Actions 的服务故障（同一时刻 `gh workflow run` 也返回 **HTTP 500**）。
日志里能看到 **`linux-x64-vulkan` 确实被分配到了 `Image: ubuntu-22.04`** —— 矩阵改动已生效，
只是 runner 拿不到 action 的下载信息。已在重试 dispatch。

> ⛔ **所以 Vulkan 那条腿的两个关键判据我目前还没拿到**：
> ① 新的 `whispercpp-vulkan-linux-x64` 包 `objdump -T` 最高 GLIBC 是不是 ≤ 2.34；
> ② 它是不是真的自包含（`whisper-cli --help` 裸跑 + `providesFiles` 含 whisper-cli）。
> **在拿到之前，这两条我一律标"未验证"**，不拿 CUDA 腿的绿去替它作答 ——
> 两条腿共用同一段打包代码，但 Vulkan 还多一个「LunarG SDK 在 ubuntu-22.04 x64 上装不装得上」
> 的未知（该 action 作者自己的 CI 矩阵里没有这一格）。

---

# §4 需要 Manager 决策

1. **macOS ffmpeg 升不升 8.1.2-2**（§2.3）—— 要把 `stableOnly: true` 主动放松成 `false`。
   材料齐了，你说升我十分钟补上；不升就三平台版本不齐，理由已写在提交信息里。
2. **阻碍 3（解析器）派给谁**（§1.3）—— 它同时影响 Windows 的 CUDA 包（已在生效的缺陷）。
   建议连同「自包含」一起验收：两个改动是配套的。
3. **`ubuntu-22.04` runner 的退役排期**（不属本任务，但影响 glibc 基线的跑道）：
   `actions/runner-images#14254` 公告 **2026-09-17 起进入 deprecation，2027-04-17 完全不支持**，
   期间有 brownout（job 硬失败）。**cpu / cuda / vulkan 三条腿现在全在 22.04 上。**
   长期解是把「glibc 下限」与「runner label」解耦（在 24.04/26.04 runner 上用
   `container: ubuntu:22.04` 或 manylinux 镜像编）—— **我没有实测这条，只是指方向。**
4. **用户的 GPU 直通**（开头那节）—— 这条不在代码里，在虚拟化层。
   在解决它之前，Vulkan 包对**这台机器**没有意义（对别的 Linux 用户有）。

---

# §5 我没做 / 做不到的（如实列）

| 项 | 状态 |
|---|---|
| 把 `whispercpp-vulkan-linux-x64` 补进 `backends.json` | ⛔ **刻意没补**。阻碍 3 未消，补了就是"看得见点不动"的升级版："装得上、跑起来还是 CPU" |
| Vulkan 腿的 CI 产物判据（glibc / 自包含） | ⏳ **未验证** —— GitHub 服务故障打掉了那条腿，已重试 dispatch |
| Linux CUDA 包能不能在没装 CUDA 工具链的机器上用 | 🔴 **不能**，且这是**新查出来的**：`ggml-cuda` 链的是 `CUDA::cudart`（**动态**，`ggml-cuda/CMakeLists.txt:176`，我们没开 `GGML_STATIC`），而打包时只拷了 Windows 命名的 `cudart64_*.dll`，Linux 侧一个都没拷。runner 上装了工具链所以 `ldd` 看不出来 |
| Windows 的 VC++ 运行时依赖（D-11 §8.3） | ⛔ 没碰 |
| macOS 升 8.1.2 | ⛔ 等裁决（§2.3） |
| BtbN win64 n8.1 的 PE 导入表 | ⚠️ `UNKNOWN`，没下 167 MB 实测 |
| 在真 AMD 硬件上验证 Vulkan 后端 | ⛔ **本机没有 GPU**（开头那节），CI runner 也没有。这条只能等一台真机 |

---

# §6 纪律申报

- **`:10000` 全程零请求**（用户在用它预览）。`/root/data-memo` 与
  `~/.local/share/openmemo/datadir.json` **一个字节没读没写**（本机验证全部走纯函数 +
  `/tmp/amd-vulkan/` 下的假 store，**不启 daemon、不写指针**）。
- **没有建 / 改 / 删任何 release**。ffmpeg 三条都是上游资产，只是指过去，不需要新产物。
- 构建**全程 `pnpm build:safe`**，一次 `pnpm -r build` 都没跑，`apps/web/dist` 未被触碰。
- **没有 `pkill -f`**；**本机一次 whisper 转写都没跑**（按用户指示）。
  跑过的只有 ffmpeg（造一个 3 秒正弦波做转码验证）与只读的 `vulkaninfo` / `objdump` / `lspci`。
- **`git add` 逐个文件**，两次都用 `git diff --cached --name-only` 核对过；
  `progress-audit` 的未跟踪回执**没有 add**。
- **反向验证全部跑在 `/tmp` 隔离副本**（PROTOCOL §10）：
  `/tmp/amd-vulkan/rv-tree`（build-whisper.sh 变异）、`/tmp/amd-vulkan/rv-mf`（manifest 变异，
  **先跑对照组确认未变异时全绿**）。共享树的 `vendor/manifests` 在验证期间未被改动。

## SHARED-CHANGE

| 文件 | 归属 | 我做了什么 | 冲突风险 |
|---|---|---|---|
| `package.json` | 公共 | 一行：把 `selftest-elf-glibc.mjs` 接进 `test:ci-scripts`（照 `ci-upload` T-154 的先例） | 低 |
| `packages/downloader/src/upstream.ts` | `model-mgmt` / `catalog-truth` | **只改注释**：把错的那句 "immutable `autobuild-<date>` tags" 订正并说明成因 | 低（零代码改动） |
| `vendor/manifests/{backends,components}.json` | `pack-publish` / `catalog-truth` | 只改 `media-tools-linux-x64` / `media-tools-win-x64` 两条 | 低 |
| `apps/daemon/src/pipeline/ffmpegPinRot.test.ts` | **新文件（我的）** | 刻意**不改** `pack-publish` 的 `platformPacks.test.ts`，避免写冲突 | 无 |

---

## [2026-08-07 01:40] T-161 DONE —— ★ CI 上拿到了，**两条判据都过了**

提交 `9bf12ef`（日志可读性，不改红绿）。

# ★ `build-backends` run **31121718587** · `linux-x64-vulkan` **success**

**Image: ubuntu-22.04**（矩阵改动生效）。glslc 的来源，日志原文：

```
🔽 Downloading Vulkan SDK 1.4.313.0
✔️ [ENV] Set env variable VULKAN_SDK -> "/home/runner/vulkan-sdk/1.4.313.0/x86_64"
-- Found Vulkan: .../x86_64/lib/libvulkan.so (found version "1.4.313")
     found components: glslc glslangValidator          ← ★ jammy 上拿到 glslc 了
-- GL_KHR_cooperative_matrix supported by glslc
-- GL_NV_cooperative_matrix2 supported by glslc
```

## 判据一：`objdump -T` 最高 GLIBC ≤ 2.34 ✅

```
check-elf-glibc: 23 个 ELF，上限 GLIBC_2.34，实测最高 GLIBC_2.34
  ✔ GLIBC_2.34   .../whispercpp-vulkan-linux-x64/libggml-vulkan.so      ← ★ 修复前是 2.38
  ✔ GLIBC_2.29   .../libggml-base.so.0.15.1
  ✔ GLIBC_2.34   .../libggml-cpu-{alderlake,cannonlake,…,zen4}.so       （14 个 CPU 变体）
  ✔ GLIBC_2.32   .../libwhisper.so.1.9.1
  ✔ GLIBC_2.34   .../whisper-cli / whisper-server / whisper-bench / whisper-vad-speech-segments
✔ 全部 ≤ GLIBC_2.34
```

三个 `__isoc23_strtol` 家族符号**没有了**。与 cpu 腿（22 个 ELF，同样 2.34）一致。

## 判据二：自包含（`providesFiles` 含 whisper-cli）✅

`[本机实测]` 我把 artifact 下下来，读它的 fragment 并**独立复算 sha256**：

```
whispercpp-vulkan-linux-x64.tar.gz   29,495,375 B
sha256（本机复算）  fa6feb61c13cce50a3b6b09ed2c5c9370591d698c0620fd42637c753abde636f
sha256（CI fragment）fa6feb61c13cce50a3b6b09ed2c5c9370591d698c0620fd42637c753abde636f   ✅ 一致

providesFiles（23 个）：
  whisper-cli ✅   whisper-server   whisper-bench   whisper-vad-speech-segments
  libggml-vulkan.so ✅   libggml.so.0.15.1   libggml-base.so.0.15.1
  libwhisper.so.1.9.1    libparakeet.so.1.9.1
  libggml-cpu-{alderlake,cannonlake,cascadelake,cooperlake,haswell,icelake,ivybridge,
               piledriver,sandybridge,sapphirerapids,skylakex,sse42,x64,zen4}.so
```

对照修复前那个 release 上的包：**19,187,014 B，里面只有一个 `libggml-vulkan.so`**。

## 判据三、四（我自己加的，因为前两条不足以证明"能用"）✅

```
pack is relocatable                     ← 解到 /tmp、env -u LD_LIBRARY_PATH、./whisper-cli --help 起得来
== ldd libggml-vulkan.so ==
    libggml-base.so.0 (0x00007fc1abb49000)      ← ★ 从**包内**解析到（RUNPATH=$ORIGIN），修复前这里是 dlopen 报错
    libvulkan.so.1 => /home/runner/vulkan-sdk/1.4.313.0/x86_64/lib/libvulkan.so.1
    libstdc++/libm/libgcc_s/libc/libgomp/libdl/libpthread → 全部系统库
    （**一条 not found 都没有**）
libggml-vulkan.so 的 libggml-* 依赖全部解析得到
```

## 本轮全部腿的结论

```
linux-x64-cpu      success      linux-x64-vulkan   success      linux-x64-cuda   success
macos-arm64-cpu    success      windows-x64-cpu    cancelled
windows-x64-vulkan failure ← Set up job：Failed to resolve action download info. Service Unavailable
windows-x64-cuda   failure ← 同上
macos-arm64-metal  cancelled
merge-manifest     skipped（needs 全绿才跑，C4 的设计如此，不是 bug）
```

**Windows 两条与 macOS metal 的失败全部死在 `Set up job`，一行我们的代码都没跑到** ——
GitHub Actions 当时正在故障（同一时段 `gh workflow run` 返回 HTTP 500、
`gh run cancel` 返回 HTTP 502）。**所以我不能声称 Windows 侧的 `vulkan_version` 钉死改动已验证** ——
标 `[未验证]`，等下一轮。

⚠️ 一条纪律申报：故障期间我重试 dispatch，结果**排了两个 run**
（`31121718587` 与 `31121734589`，同一个 commit）。想取消多余那个，
`gh run cancel` 连续 502/500 取消不掉。它受 `concurrency: build-backends-<ref>` 串行化，
不会并发烧 runner，但会多跑一遍。**如果你看到一个重复的 run，是我。**

---

# ★ 结论更新：①的两条阻碍**确实消掉了**，但**仍然不补 `backends.json`**

| 阻碍 | 状态 | 证据 |
|---|---|---|
| 1 · 不自包含 | ✅ **消掉，CI 实测** | `providesFiles` 含 whisper-cli；relocatable；`ldd` 零 not found |
| 2 · GLIBC_2.38 | ✅ **消掉，CI 实测** | 23 个 ELF 全部 ≤ 2.34 |
| 3 · 解析器按 `readdir` 取第一个 | 🔴 **仍在**（§1.3） | 本机实测：装了 Vulkan 包，跑的仍是 CPU 包里的 whisper-cli |
| 4 · 这台机器上没有 GPU | 🔴 **仍在**（开头） | `detectGpus()` → `gpus: []`；`/dev/dri` 不存在 |

**补进目录的前置条件是第 3 条**（第 4 条只影响这一台机器，不影响别的 Linux 用户）。
在它消掉之前，补进去等于给用户一个"装得上、装完还是 CPU、而且没有任何地方会说"的按钮。

## 要补的话我需要什么（材料已备齐）

包本身没有下载地址（fragment 是 `availability: "pending-ci"` + `mirrors: []`，
这是 schema 设计好的诚实状态，前端读到它会禁用安装按钮）。**我不建 release**，
所以要发的话，清单在这里，由你建 tag，然后走 `ci-upload` 那条 `release-upload.yml`：

| 文件 | 字节 | sha256（**我本机复算**，与 CI fragment 逐字符一致） | 来源 |
|---|---:|---|---|
| `whispercpp-vulkan-linux-x64.tar.gz` | 29,495,375 | `fa6feb61c13cce50a3b6b09ed2c5c9370591d698c0620fd42637c753abde636f` | 我们自建：`build-backends` run **31121718587**，artifact `packs-linux-x64-vulkan` |

（`ggmlAbi: 0.15.1`、`engineVersion: f049fff9`（submodule commit，没有 tag 所以 `git describe` 回落到 sha）、
`tier: downloadable`、`backend: vulkan`、`os/arch: linux/x64`。）

⚠️ **但我建议先别发** —— 顺序应该是：**先修第 3 条 → 再发包 → 再补目录**。
反过来做的话，中间那段时间里目录上就挂着一个装了没用的按钮，
而这正是我们从一开始就在避免的那件事。
