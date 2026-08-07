---
id: FX-GPU
author: memo-compare
status: ready
date: 2026-08-07
supersedes: R-01 B5（「memo.ac 仅支持 CUDA，无 Vulkan/DirectML」，该结论标记为未验证）
---

## TL;DR（≤ 25 行）

- **当年那个「未验证」项现在有答案了，而且原结论是错的。**
  R-01 判「memo.ac 加速后端只有 CUDA（Windows）/ Metal+CoreML（macOS）」，
  因为**只解了 macOS 包**。本轮把 Windows NSIS 包解开后：
  **Windows 上有第三个 GPU 后端 —— DirectCompute（Direct3D 11 计算着色器）。**
- 它不是 Vulkan，也不是 DirectML —— 是 R-01 没有列入排查清单的第三种东西，
  所以 grep `vulkan|directml|rocm` 全部落空是**必然的**，而不是"证明了只有 CUDA"。
- **这条后端是厂商中立的**：D3D11 计算着色器在 AMD / Intel / NVIDIA 上都跑。
  → memo.ac 首页那句 "NVIDIA and AMD GPU Acceleration" **在 Windows 上是成立的**，
  R-01 判其为"夸大宣传"**应予撤回**（macOS 侧 R-01 的结论仍然正确）。
- 实现来源：**Const-me/Whisper 的自建分支**。版本资源 FileDescription 原文
  `DirectCompute port of whisper.cpp library`；PDB 路径泄露了构建者与分支名
  `C:\Users\guochao\Desktop\em2er-whisper\x64\Release\main.pdb`。
- **用户能看到的形态是一个三选一分段控件**（不是自动探测）：
  Windows `CPU / GPU / Cuda`，macOS `CPU / coreML / GPU`。出厂默认 **CPU**。
- **GPU 加速是付费功能**：走 GPU/cuBLAS/Metal 的本地 whisper 会 `useProLimit()` 扣试用额度，
  额度耗尽弹窗劝退（`pro.limit`: "…You can switch to CPU mode to transcribe content."）。
- DirectCompute 这条路有**两个实测能拿到的功能缺口**：不支持 `ggml-large-v3`
  （下拉里被 disabled，选中会被强制降到 large-v2）；不支持"重复片段自动修复"。
- **Linux：零产物**，memo.ac 根本不出 Linux 包 —— 这是我们最大的结构性优势，不是小差距。
- 未验证/存疑：见文末 §6。**没有运行过 memo.ac 的任何二进制。**

---

## 1. 取证方法与产物指纹

| 项 | 值 |
|---|---|
| 版本 | v1.7.5（`Makememo/MemoAI` 最新 release，published 2026-06-24；本轮 2026-08-07 复查仍是最新） |
| Windows 包 | `Memo_1.7.5_win32_x64.exe`，305,233,832 B，sha256 `6a773f00b8f2a6b2b0266ac2779fbc473086981120521e8ec8133d64663e6c97` |
| macOS 包 | `Memo_1.7.5_darwin_arm64.zip`，322,856,974 B，sha256 `ffb5f8e03d4e5c6e88c111c3f44484dcb9c573ecfe7735efe22d2ca111c13d1d` |
| 解包链 | NSIS → `$PLUGINSDIR/app-64.7z` → `resources/app.asar`（42,362 条目） |
| 工具 | `p7zip-full`(7z 26.02) + 自写 asar parser + 自写 PE import 解析（纯 Python） |

**当年解不开的原因是本机没有 7z**；本轮 `apt-get install -y p7zip-full` 后一次成功。
（另：单连接被限速到 ~24 KB/s，改用 `aria2c -x16` 后 2.3 MB/s，否则 305 MB 要下 3 小时。）

⚠️ **只做静态取证**：解包、读文件、读配置、解析 PE 导入表。
**未运行 memo.ac 的任何二进制，未注册账号，未向其发送任何数据。**

---

## 2. Windows 的三个 whisper 后端（实测）

### 2.1 随包分发的产物

```
resources/addon/whisper/bin/1.8.6/     whisper-cli.exe, whisper-server.exe,
                                       whisper.dll, ggml.dll, ggml-cpu.dll, ggml-base.dll   ← CPU
resources/addon/whisper/bin/gpu/       main.exe, Whisper.dll                                 ← DirectCompute
resources/addon/whisper/cublas/        whisper-cuda-bin-x64.7z (18 MB)                       ← CUDA（压缩态随包）
```

**注意 `bin/1.8.6/` 里没有 `ggml-cuda.dll` 也没有 `ggml-vulkan.dll`** ——
基础包是纯 CPU，CUDA 靠那个 7z，GPU 靠 `bin/gpu/`。

`whisper-cuda-bin-x64.7z` 内容（`7z l` 实测）：
`ggml-cuda.dll` (103,261,184 B) + `ggml-base/cpu/ggml.dll` + `whisper.dll` + `whisper-cli.exe` + `whisper-server.exe`。
即 **CUDA 版是一整套并行的 whisper.cpp 二进制**，不是插件式加载。

### 2.2 `bin/gpu/Whisper.dll` 到底是什么 —— PE 导入表实测

```
Whisper.dll  [PE32+]  imports: d3d11.dll, dxgi.dll, MF.dll, MFPlat.DLL,
                               MFReadWrite.dll, ole32.dll, SHLWAPI.dll,
                               KERNEL32.dll, USER32.dll
main.exe     [PE32+]  imports: Whisper.dll, KERNEL32.dll, api-ms-win-core-path-l1-1-0.dll
```

- **`d3d11.dll` + `dxgi.dll` = Direct3D 11 + 适配器枚举**。没有 `nvcuda.dll`、没有 `vulkan-1.dll`、
  没有 `directml.dll`。→ 这是 **DirectCompute（D3D11 compute shader）**，厂商中立。
- `MF*.dll` = Media Foundation，用于自己解音频（所以这条路不依赖 ffmpeg）。
- 对照：CPU 版 `whisper-cli.exe` 导入的是 `ggml.dll`/`whisper.dll`，两条链完全独立。

**provenance（版本资源与符号，实测）**
- 版本资源字符串：`DirectCompute port of whisper.cpp library` ← Const-me/Whisper 的 FileDescription
- C++ 符号：`.?AUiTensorArena@DirectCompute@@`、`.?AVMlContext@DirectCompute@@`、
  `.?AVDecoderLayerPool@WhisperContext@DirectCompute@@`、`.?AUiSpectrogram@Whisper@@` …
- 二进制内字符串：`Compute Shaders`、`GPU Tasks`、`Available graphic adapters:`、`Unable to enumerate GPUs`
- **PDB 路径**：`C:\Users\guochao\Desktop\em2er-whisper\x64\Release\main.pdb`
  → 不是直接拿的官方 release，是**自己 fork 后重编**（分支名 `em2er-whisper`，构建者 `guochao`）。

`main.exe` 的 CLI（strings 实测）证实它按**图形适配器**选设备，而不是按 CUDA 设备：
```
-la,  --list-adapters  List graphic adapters and exit
-gpu, --use-gpu        The graphic adapter to use for inference
-m FNAME, --model FNAME / -l LANG, --language LANG / --prompt / -tr / --detect-lang
```

### 2.3 三条路是怎么被选中的（主进程 bundle 实测）

`dist-electron/main/index-f11e3e4b.js`，调度函数（原文，已格式化）：

```js
function m0r(t){
  const e = Ds.platform(), n = Ds.arch(), i = t.windowsWhisperMode;
  if (e === "darwin") {
    if (n !== "arm64") throw new Error(`Whisper transcription is not supported on macOS ${n}`);
    return wjt;                                  // macOS 单一 runner
  }
  if (e === "win32") {
    if (i === "GPU")    return Asi;              // → DirectCompute
    if (i === "cuBLAS") return vsi;              // → CUDA
  }
  return wjt;                                    // 兜底 = CPU
}
```

三个 runner 对象与其**实际 spawn 的二进制**（我用正则定位函数体、逐个核对 spawn 的第 0 参，非推测）：

| runner | run 函数 | spawn 的路径变量 | 实际二进制 |
|---|---|---|---|
| `wjt` | `usi` | 局部计算 `f` | `addon/whisper/bin/1.8.6/whisper-cli[.exe]`（mac 上按 mode 走 `coreml/` 子目录） |
| `vsi` | `_si` | `VJe` | `<userData>/.memo-ai/addon/whisper/win32/x64/cublas/whisper-cli.exe` |
| `Asi` | `bsi` | `XSe` | `../addon/whisper/bin/gpu/main.exe` |

另有一处把 mode 翻译成 whisper 参数：
```js
S.macOSWhisperMode==="CPU"    && darwin && arm64      → A.use_gpu = false   // 即 -ng
S.macOSWhisperMode==="coreML" && darwin && arm64 && P → A.use_gpu = true
S.macOSWhisperMode==="Metal"  && darwin && arm64 && P → A.use_gpu = true
(b==="GPU" || b==="cuBLAS")   && win32                → A.use_gpu = true
```
（`t.use_gpu || T.push("-ng")` —— 关 GPU 就是给 whisper-cli 加 `-ng`。）

### 2.4 用户界面：三选一分段控件，不是自动探测

渲染层 `dist/assets/index-d5bec8ed.js` 原文：

```jsx
window.AIM.isMac && <Segmented value={e.macOSWhisperMode || "CPU"}>
  <Item value="CPU"    onClick={changeSetting("macOSWhisperMode","CPU")}>CPU</Item>
  {e.enableCoreML && <Item value="coreML" …>coreML</Item>}
  <Item value="Metal"  …>GPU</Item>          {/* 注意：值是 Metal，标签写 "GPU" */}
</Segmented>

window.AIM.isWindows && <Segmented value={e.windowsWhisperMode || "CPU"}>
  <Item value="CPU"    …>CPU</Item>
  <Item value="GPU"    …>GPU</Item>          {/* 这一项就是 DirectCompute */}
  <Item value="cuBLAS" …>Cuda</Item>
</Segmented>
```

**出厂默认是 `"CPU"`**（`|| "CPU"` 兜底）。**没有"检测硬件→推荐后端"这一步** ——
用户自己在三个按钮里挑，挑错了就是慢或者报错。

另有一个**独立**的 FunASR 设备选择器（与 whisper 无关）：
```js
function war(){ return isWindows ? [{label:"CPU",value:"cpu"},{label:"CUDA",value:"cuda"}]
                : isMac ? [{label:"CPU",value:"cpu"},{label:"MPS",value:"mps"}]
                : [{label:"CPU",value:"cpu"}]; }
```
⚠️ **R-01 引的 `["cpu","cuda"]` 就是这个函数**（主进程侧同名实现 `Eai()`）。
它是 **FunASR 的 device 参数**，不是全 app 的后端枚举 —— 当年把它当成了后者，这是错因。

---

## 3. macOS 侧复核（R-01 结论成立）

```
addon/whisper/bin/1.8.6/         libggml-metal.dylib, libggml-blas, libggml-cpu, libggml-base,
                                 libwhisper.1.8.6.dylib, whisper-cli, whisper-server
addon/whisper/bin/1.8.6/coreml/  同上 + libwhisper.coreml.dylib
```
全 `.app` 内 `-iname` 扫描 vulkan/directml/rocm/opencl/cuda：**零命中**
（唯一 `hip` 命中是 `Squirrel.framework/.../ShipIt`，误报）。
→ **macOS = CPU(BLAS) / Metal / CoreML，无 Vulkan/DirectML/ROCm。R-01 此处正确。**

macOS Intel 被硬拒：`if (n !== "arm64") throw new Error("Whisper transcription is not supported on macOS " + n)`。

---

## 4. 最终答案：memo.ac 的 GPU 后端支持面

| 平台 | 后端 | 实现 | 用户入口 |
|---|---|---|---|
| Windows x64 | **CPU** | whisper.cpp 1.8.6（ggml-cpu） | `windowsWhisperMode="CPU"`（默认） |
| Windows x64 | **DirectCompute (D3D11)** | Const-me/Whisper 自建分支 `em2er-whisper` | `windowsWhisperMode="GPU"` |
| Windows x64 | **CUDA (cuBLAS 12.2)** | whisper.cpp + ggml-cuda.dll（随包 7z，103 MB） | `windowsWhisperMode="cuBLAS"`，标签 "Cuda" |
| macOS arm64 | **CPU / Metal / CoreML** | whisper.cpp 1.8.6 + coreml 子目录 | `macOSWhisperMode="CPU"/"Metal"/"coreML"` |
| macOS x64 (Intel) | ⛔ 抛异常，不支持 | — | — |
| **Linux** | ⛔ **无任何产物** | — | — |

**没有 Vulkan。没有 DirectML。没有 ROCm。没有 OpenCL。没有 SYCL/oneAPI。**
（`vulkan-1.dll` / `vk_swiftshader.dll` / `vk_swiftshader_icd.json` 确实在包里，
但那是 **Electron/Chromium 自带的 SwiftShader**，不参与 ASR —— 与 R-01 在 macOS 侧的判断一致。）

**AMD 用户在 Windows 上真的能用 GPU 跑转写**，路径是 DirectCompute 而非 ROCm/Vulkan。

---

## 5. DirectCompute 这条路的已知限制（实测，非推测）

1. **不支持 large-v3。** 渲染层两处硬编码：
   - 模型下拉项 `disabled: u.windowsWhisperMode==="GPU" && k.value==="ggml-large-v3.bin"`
   - `useEffect`：`windowsWhisperMode==="GPU" && b==="ggml-large-v3.bin"` → 强制切到 `ggml-large-v2.bin`
2. **不支持「重复片段自动修复」。**
   `canAutoFixRepeatSegments = fni(e, settings)`，而
   `fni(n,e) = isLocalWhisper(n) ? (!isWindows || e.windowsWhisperMode !== "GPU") : false`
   → Windows + GPU 模式下该能力被关掉。
3. **GPU 加速整体是付费功能。**
   `vjt(n,e) = isLocalWhisper(n) && (windowsWhisperMode==="GPU" || ==="cuBLAS" || macOSWhisperMode==="Metal")`
   两个调用点：开始转写前 `vjt(...) && window.AIM.app.useProLimit()`（扣额度）；
   以及 `vjt(pt,Ze) && await window.AIM.app.getProLimit()===0` → 弹窗。
   文案 `pro.limit`：*"The trial of acceleration capabilities has been used up.
   You can switch to CPU mode to transcribe content."*，
   `pro.continue`：*"…2 - 10 times faster transcription speed."*

---

## 6. 未验证 / 存疑（诚实声明）

- `[未验证]` **没有在真 Windows 机器上运行过任何 memo.ac 二进制**。以上全部为静态取证：
  PE 导入表、版本资源、字符串、以及 bundle 内的调度代码。
  "DirectCompute 在 AMD 卡上实际跑得动、跑得快"**未实测**，仅由 D3D11/DXGI 依赖推断其厂商中立性。
- `[未验证]` CUDA 12.2 之外的 CUDA 版本能否工作、Blackwell(sm_120) 是否仍崩 —— 本轮未查。
- `UNKNOWN` `enableCoreML` 这个开关由什么条件置位（是机型探测还是用户开关），未定位到其写入点。
- `UNKNOWN` Pro 额度的具体数值与计量单位（次数？分钟？）—— `useProLimit()` 的实现在主进程，未追。
- `[未验证]` 本文所有 memo.ac 结论均针对 **v1.7.5**；更早/更晚版本可能不同。
- 本文**未复制 memo.ac 的源码**；引用的代码片段为识别调度逻辑所必需的最小片段（均 < 400 字符），
  且已注明其为压缩混淆产物中的标识符。**未提交任何 memo.ac 的二进制、模型或受版权资源。**
