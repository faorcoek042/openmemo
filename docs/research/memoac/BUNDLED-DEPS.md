---
id: FX-BUNDLED
author: memo-compare
status: ready
date: 2026-08-09
source: win-package-listing.txt（Windows 包 v1.7.5 完整清单）+ asr-engines.txt + ipc-channels.txt
---

## TL;DR（Manager 只读这里）

- **① memo 不内置任何转写模型。** `[已核实]` 全包**零个** `ggml-*.bin` 权重；
  15 个 whisper 模型**每一个都带 `downloadLink`**，首次运行必须下。
  ⇒ **"memo 开箱即用"这个前提，对"转写"这件事不成立** —— 它开箱即用的是**工具链**，不是**模型**。
- **② memo 内置了 ffmpeg，194.7 MB（解包后）**，`[已核实]`
  而**全包只有 3 个许可证文件**（Electron / Chromium / font-list）——
  **没有 ffmpeg 的 LICENSE、没有 COPYING、没有源码 offer、没有第三方声明**。
  ⇒ 它在分发 ffmpeg 且**看不到任何 GPL 合规动作**。**这一条不是可抄的做法，是反面教材。**
- **③ 首次运行仍要下**：至少一个 ASR 模型（`tiny` 约 75 MB → `large` 约 3 GB 量级，取决于选哪个）；
  CUDA 用户还要再下一个 `whisper-cublas-12.2.0-bin-x64.zip`。
- **④ 更新检测确实有**：`check-update` / `check-version` / `check-electron-version` /
  `get-remote-models` / `llm:model-registry:check-update` 等 IPC 通道 `[已核实]`。
- **⑤ cublas 那条会改变我们的 100 MB 界线的判断依据**：memo 塞进包里的 CUDA 只有
  **18.2 MB（压缩态 7z）**，解开约 107 MB —— 而我们的 CUDA 包是 **678 MB**。
  **不是它塞得下、我们塞不下，是两边装的根本不是同一样东西。**（见 §5）
- **⑥ 一个反面参考**：memo 的 Windows 包里塞了 **130 MB 的 macOS `.dylib`**
  （sherpa-onnx darwin-arm64 + darwin-x64）—— Windows 用户永远用不到。
  **1.10 GB 里有 12% 是别的平台的二进制。**

---

## 1. 方法

数据全部来自 `docs/research/memoac/win-package-listing.txt`（197 文件 / 40 目录 /
解包后 **1,103,987,483 B = 1.10 GB**，7z 列出的**未压缩**列）。
**只读清单，不读任何结论性笔记**；只做静态取证，**未运行 memo 的任何二进制**。

⚠️ 本文一切体积均为**解包后**。包本身 305 MB（压缩态）。

---

## 2. ① 内不内置模型 —— **不内置**（这是最重要的一条）

`[已核实]` 全包里**所有**权重类文件（`.bin` / `.onnx` / `.wasm`）只有这些：

| 文件                               | 体积          | 用途               |
| ---------------------------------- | ------------- | ------------------ |
| `addon/ocr/paddle-model/rec.onnx`  | 10.69 MB      | OCR 识别           |
| `addon/ocr/paddle-model/det.onnx`  | 2.43 MB       | OCR 检测           |
| `addon/ocr/paddle-model/cls.onnx`  | 0.59 MB       | OCR 方向分类       |
| `addon/vad/silero_vad.onnx`        | 1.81 MB       | VAD                |
| `addon/vad/ggml-silero-v6.2.0.bin` | 0.89 MB       | VAD（ggml 版）     |
| `nlp/jieba/jieba_rs_wasm_bg.wasm`  | 3.72 MB       | 中文分词           |
| **合计**                           | **≈ 20.1 MB** | **全是"辅助模型"** |

**转写模型：0 个。**
⚠️ 唯一形似的命中是 `addon/whisper/bin/1.8.6/ggml-base.dll` —— **那是库不是权重**
（`.dll`，不是 `.bin`）。这个坑很容易踩，专门记一笔。

佐证：`asr-engines.txt` `[已核实]` 记着
`grep -c '"downloadLink"' presets/whisper-models.js` = **15** ——
**15 个 whisper 模型条目，每一个都有下载地址**，即全部运行时下载。
另有 2 条指向 `https://model.memo.ac/<file>`（`Memo-large.zh.bin` / `Memo-large.ja.bin`，自家微调版）。

> **结论：memo 把"引擎和工具链"装进盒子，把"模型"留在网上。**
> 那句"它把引擎装在盒子里"是准确的 —— **但"盒子里有模型"是我们自己脑补的**。

---

## 3. ② ffmpeg：内置了，194.7 MB，而且看不到任何 GPL 合规动作

| 文件                                 | 解包后                           |
| ------------------------------------ | -------------------------------- |
| `resources/addon/ffmpeg/ffmpeg.exe`  | **131.67 MB**                    |
| `resources/addon/ffmpeg/ffprobe.exe` | **63.06 MB**                     |
| 合计                                 | **194.7 MB**（压缩态约 56.5 MB） |

**全包的许可证文件只有 3 个** `[已核实]`（grep `licen|notice|copying|third.?party` 全清单）：

```
LICENSE.electron.txt                              (Electron)
LICENSES.chromium.html                            (Chromium)
app.asar.unpacked/node_modules/font-list/LICENSE  (一个 npm 包)
```

⇒ **没有 ffmpeg 的许可证文本、没有 COPYING、没有"源码索取"声明、没有 yt-dlp 的声明。**

- `UNKNOWN` 它内置的是 **GPL 版还是 LGPL 版**：单文件 131 MB 的 `ffmpeg.exe`
  **看起来**像常见的完整静态构建（那类通常是 GPL），但**我没有运行它、也没读 PE 里的版本串**，
  **所以不下判断**。要坐实只需读一次 `ffmpeg -version` 的 banner —— 而那需要运行它，本轮纪律禁止。
- ⚠️ **无论它是哪个版本，"不带任何许可证文本就分发"都不是可抄的做法。**
  用户裁定"我们不内置 ffmpeg"**在合规方向上比 memo 更稳**，
  这条取证**支持**那个决定，而不是动摇它。

---

## 4. ③ 首次运行还要下什么

| 必须下                                         | 体积                              | 依据                                |
| ---------------------------------------------- | --------------------------------- | ----------------------------------- |
| **一个 ASR 模型**                              | 75 MB（tiny）～ 3 GB（large）量级 | 15 条全带 `downloadLink` `[已核实]` |
| CUDA 用户：`whisper-cublas-12.2.0-bin-x64.zip` | `UNKNOWN`（远端文件，未下载）     | 主进程里的下载常量 `[报告]`         |

⇒ **memo 的"开箱即用"= 装完就能打开、能导入、能看界面；但要转写，仍然得先下模型。**
和我们的差别**不是"要不要下模型"（两边都要），而是"要不要下引擎/工具链"**。

---

## 5. ⑤ 逐项内置清单（解包后体积）

| 项                                                               | 体积          | 说明                                 |
| ---------------------------------------------------------------- | ------------- | ------------------------------------ |
| `addon/ffmpeg`（ffmpeg + ffprobe）                               | **194.7 MB**  | 见 §3，无许可证文本                  |
| `addon/bun/bun.exe`                                              | **113.25 MB** | JS 运行时（供插件 / yt-dlp 包装）    |
| `addon/ocr`（RapidOcrOnnx + 3 个 paddle 模型）                   | **30.5 MB**   | 我们无此功能                         |
| `addon/whisper`（三档，见下）                                    | **22.3 MB**   |                                      |
| `yt-dlp/yt-dlp.exe`                                              | **18.45 MB**  |                                      |
| `addon/vad`（onnxruntime + paddle2onnx + fastdeploy + 2 个权重） | **18.0 MB**   |                                      |
| `addon/asr/memo-recorder.exe`                                    | **6.04 MB**   | 原生录音器                           |
| `nlp/jieba`                                                      | **3.72 MB**   |                                      |
| `addon/font`                                                     | 0.18 MB       |                                      |
| **sherpa-onnx（四平台全塞）**                                    | **162.0 MB**  | **其中 130 MB 是 macOS 的 dylib** ⚠️ |

**whisper 的三档**（合计 22.3 MB）：

| 档                | 内容                                                      | 体积         |
| ----------------- | --------------------------------------------------------- | ------------ |
| CPU               | `bin/1.8.6/`（whisper-cli/server + ggml×3 + whisper.dll） | ≈ 2.5 MB     |
| **DirectCompute** | `bin/gpu/`（`main.exe` + `Whisper.dll`）                  | ≈ 0.9 MB     |
| **CUDA**          | `cublas/whisper-cuda-bin-x64.7z`（**压缩态随包**）        | **18.20 MB** |

### ★ cublas 那条：**它没有推翻我们的界线，但推翻了我们的类比**

- memo 包里的 CUDA = **18.2 MB 压缩 / 约 107 MB 解开**（内含 `ggml-cuda.dll` 103 MB）`[已核实，上一轮解过那个 7z]`
- 我们的 `whispercpp-cuda-12.4-win-x64` = **677.9 MB**

**差 6 倍不是打包技巧，是内容不同**：memo 只放**编译好的 ggml-cuda**，
**把 CUDA 运行库留给用户**（它的 GPU 文档要求"确保 Cuda 驱动是 12.2"，
并提供应用内下载 `whisper-cublas-12.2.0-bin-x64.zip` 补运行库）。
我们那 678 MB 里装着**随包分发的 CUDA 运行库**。

⇒ **对 D-20 的 100 MB 界线：不构成推翻。**
memo 的 18.2 MB 能进箱子，是因为它**把 560 MB 的运行库推给了用户**——
那正是我们要避免的"多一个可失败环节"。**要改界线得先改这个取舍，不是改数字。**
⚠️ **但有一个真问题**：我们是否**必须**随包分发 CUDA 运行库？
`UNKNOWN` —— 我没有核过我们那 678 MB 的构成。**这条值得单独查一次**，
因为如果其中大头也是运行库，那"CUDA 要不要进箱子"就变成了和 memo 同一道选择题。

---

## 6. ④ 更新检测：确实有，通道名已抄录

`[已核实]`（`ipc-channels.txt` 342 个通道里的相关项）：

```
check-update                      check-version                check-electron-version
get-remote-models                 llm:model-registry:check-update
llm:model-registry:update
```

⇒ 它把**应用自身更新**（`check-update` / `check-electron-version`）与
**目录/模型注册表更新**（`get-remote-models` / `llm:model-registry:*`）**分成两套**。
`UNKNOWN`：各自的远端地址、校验方式、以及触发时机（未读实现，只读通道名）。
已知的一条远端：`model.memo.ac`（模型下载源）与 `models.memo.ac/all-models`（清单）`[报告]`。

---

## 7. ⑥ 对照：它内置了而我们决定不内置的

| 项                     | memo                                | 我们（D-20 决策）          | 它为什么能 / 我们为什么不                                           |
| ---------------------- | ----------------------------------- | -------------------------- | ------------------------------------------------------------------- |
| **ffmpeg**             | 内置 194.7 MB，**无任何许可证文本** | **下载**（GPL）            | **不是它"能"，是它没做合规动作。** 我们的决定更稳，本取证**支持**它 |
| **OCR**                | 内置 30.5 MB                        | 无此功能                   | 功能范围不同，不是打包问题                                          |
| **bun**                | 内置 113.25 MB                      | 无                         | 它用 bun 跑插件/yt-dlp 包装；我们不需要第二个 JS 运行时             |
| **CUDA(whisper)**      | 内置 18.2 MB 压缩                   | 排除在 100 MB 外（678 MB） | **内容不同**，见 §5                                                 |
| **sherpa-onnx 四平台** | 全塞（其中 130 MB 是别平台的）      | —                          | **这是缺陷不是做法**，别抄                                          |

**我们内置了而 memo 没有的**：`libsimple` / `sqlite-vec`（中文搜索与向量检索）`[报告 D-20]` ——
memo 的 9 张表里没有对应物，它的搜索走别的路径 `UNKNOWN`。

---

## 8. 与 D-20 的冲突（**我不改它的决策，只把冲突写出来**）

1. **D-20 的前提"memo 是开箱即用的"需要限定。** `[已核实]` memo 不内置转写模型 ——
   要转写仍然得先下模型。**"开箱即用"在 memo 那儿指的是工具链，不是端到端可用。**
   ⇒ 如果 D-20 内置 `whisper-tiny-q5_1`(32.2 MB)，**我们在这一点上会比 memo 更开箱即用**。
   这是个**加分项**，但它的依据不该写成"memo 也这么做"——**memo 没这么做**。
2. **"100 MB/项"界线**：memo 的对照**不构成推翻**（§5），但暴露出一个我们没查过的问题 ——
   我们那 678 MB 里有多少是 CUDA 运行库、是否必须随包。**`UNKNOWN`，建议单独查。**
3. **ffmpeg 继续下载**这条：memo 的做法（内置且无许可证文本）**不能拿来当"可以内置"的先例**。

---

## 9. 未验证 / UNKNOWN（逐条）

- `UNKNOWN` memo 内置的 ffmpeg 是 GPL 还是 LGPL 构建（要读版本 banner，需运行二进制，纪律禁止）。
- `UNKNOWN` `whisper-cublas-12.2.0-bin-x64.zip` 的体积（远端文件，未下载）。
- `UNKNOWN` 更新检测的远端地址 / 校验方式 / 触发时机（只读了通道名，未读实现）。
- `UNKNOWN` 我们 678 MB CUDA 包的构成（**这条最值得补**，见 §8.2）。
- `[未验证]` macOS 包的对应体积（本文只解了 Windows 包的清单；macOS 包结构已知但未逐项统计）。
- 本文**未运行 memo 的任何二进制**，**未把 memo 的任何二进制/模型/受版权资源提交进仓库**。
