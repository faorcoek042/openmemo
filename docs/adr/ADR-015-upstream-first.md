---
id: ADR-015
title: 上游预编译优先 —— 停止自建，发布渠道阻塞消解
status: accepted
date: 2026-08-02
decider: 用户（指令）/ Meta Manager（落地）
supersedes: ADR-003 决策 2（自建 whisper.cpp CI）的适用范围
---

## 用户指令（2026-08-02）

> **"自用不一定要发布，一定要 GitHub 链接吗，是为了 runner 验证？"**
> **"尽量下载上游编译打包好的二进制来调用"**

## 0. Manager 认错：我把"硬阻塞"判错了

我在最终报告里把"没有 GitHub 发布渠道"列为**唯一硬阻塞**。用户一句反问点破：
**个人自用根本不需要我们自己发布。**

我的错误链条是：批准自建 → 自建出产物 → 产物要发布 → 需要发布渠道 → 报成硬阻塞。
**而链条第一环就不该成立** —— 上游本来就有现成的。

## 1. 逐组件核实结果（`gpu-runtime` 实地核实，**7/7 全部可改上游**）

| 组件               | 上游产物                                                                                                                                   | 结论                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| **sqlite-vec**     | `v0.1.9` loadable × linux/macos/windows + **官方 checksums.txt**；linux-x86_64 61,507B sha256 `b959baa1…d5d7`（与 checksums.txt 逐字一致） | **改上游**                           |
| **libsimple**      | `v0.7.1` 12 个 zip；ubuntu-22.04 5,337,804B sha256 `0c9a7a57…42a5`，含 `libsimple.so` + **完整 dict（含 `pos_dict/`）**                    | **改上游**                           |
| **whisper.cpp**    | `v1.9.1` Linux x64/arm64 CPU ✅、Win CPU/BLAS/CUDA ✅；**仍无 macOS CLI / Vulkan / ROCm / Linux CUDA**                                     | Linux/Win **改上游**；其余**自建停** |
| **llama.cpp**      | 官方矩阵极完整                                                                                                                             | **上游**（本就不该自建）             |
| **sherpa-onnx**    | npm 全平台 1.13.4                                                                                                                          | **上游**，已在用                     |
| **ffmpeg/ffprobe** | BtbN 有**不可变日期 tag**，资产名带完整版本号                                                                                              | **改上游 + 钉日期 tag**              |
| **yt-dlp**         | `2026.07.04` 四平台 + 官方 SHA2-256SUMS                                                                                                    | **上游**，已在用                     |

## 2. `gpu-runtime` 的自我更正

> **我在 T-037 从源码自建 `libsimple`/`sqlite-vec`，上游本来就有预编译，
> 而且 libsimple 的比我打的还全（多了 `pos_dict/`）。我当时没看上游 releases 就开编。**

→ 一周多的自建工作，起因是**没先查上游**。这条记录下来。

## 3. 两个技术前置，都已解决

- **"移动靶"**：BtbN 除 `latest` 外还有**不可变日期 tag**，钉它则 sha256 稳定。
- **`.tar.xz`**：`model-mgmt` 已用 `xz-decompress`（MIT，WASM，不依赖系统 `xz`——
  因为默认 Windows 装机没有）。与 `.tar.gz` **共用同一个 tar 提取器**，
  **不存在第二条提取路径**，故自动继承全部防护。`verify-unpack` **53/53**。

## 4. 决策

1. **manifest 一律填上游地址 + 钉不可变版本 tag + sha256。** 我们不托管任何东西。
2. **`build-sqlite-ext.sh` 停用**；`build-media-tools.sh` 降为可选重打包；
   `build-whisper.sh` 保留但**不进默认流程**；CI 降为**按需触发**。
3. **ADR-003 决策 2（自建 whisper.cpp CI）的适用范围收窄**为：
   仅当用户实际需要 **macOS / Vulkan / ROCm** 时才启用。Linux/Windows 走上游。
4. **本地托管方案保留但降为兜底**（`http://127.0.0.1:<port>/local-artifacts/`）。
   `model-mgmt` 否决了 `file://`，理由成立：**Node `fetch` 读不了 → 必须在下载器开分支 →
   那条分支会绕过 Range/续传/校验/去重/重试 —— 第二条代码路径正是漏洞来源。**

## 5. **`PENDING-USER-DECISIONS.md` 的 A-1（GitHub 仓库）撤销**

不再是阻塞。mac/Windows 二进制若日后需要，才重新提出。

## 6. 一项未完成（如实记录）

**ffmpeg 钉死 tag 的 sha256 未取到** —— 119 MB 在本机网络两次都停在 85 MB。
名称/大小已从 API 核实、内容含 `ffprobe` 是 T-050 实测，
但**该文件 sha256 落 manifest 前必须补**。

---

## 7. 例外（2026-08-07，T-167）：四个 whisper.cpp 包改回自建托管

> 本节由 `platform-backlog` 按 Manager 2026-08-07 的裁决追加，§0–§6 一个字未改。
> **它是一条例外，不是对 §4 决策 1/3 的撤销** —— 其余 7 类组件（sqlite-vec、libsimple、
> ffmpeg、yt-dlp、sherpa-onnx、llama.cpp、以及 whisper.cpp 的**源码**）仍然一律走上游。

### 7.1 例外的四个 id

| id                            | 之前指向                                                          | 现在指向                           |
| ----------------------------- | ----------------------------------------------------------------- | ---------------------------------- |
| `whispercpp-cpu-linux-x64`    | `ggml-org/whisper.cpp` `v1.9.1` / `whisper-bin-ubuntu-x64.tar.gz` | 我们的 `backend-packs-2026.08.07b` |
| `whispercpp-cpu-win-x64`      | `ggml-org/whisper.cpp` `v1.9.1` / `whisper-bin-x64.zip`           | 同上                               |
| `whispercpp-cpu-macos-arm64`  | （本来就是自建，上游不发 macOS CLI）                              | 换到新 tag                         |
| `whispercpp-vulkan-linux-x64` | （本来就是自建，上游不发 Vulkan）                                 | 换到新 tag                         |

前两条是**真正的例外**；后两条只是换 tag，它们从一开始就落在 §4 决策 3 划出的
「macOS / Vulkan / ROCm 才启用自建」范围内。

### 7.2 依据：**一个上游包在结构上给不了的文件**

`openmemo-probe` 是章程要求 2.1「网页检测硬件 → 推荐后端」那一步的执行者，
也是 ADR-003 决策 3 里「唯一可信的设备枚举」。三条实测事实合起来决定了它只能随包出厂：

1. `[本机实测 2026-08-07]` 探针**动态链接** ggml，不是自包含的可执行文件：
   ```
   $ objdump -p openmemo-probe | grep -E 'NEEDED|RUNPATH'
     NEEDED libggml-base.so.0 · NEEDED libggml.so.0 · RUNPATH $ORIGIN
   $ ./openmemo-probe          # 同目录没有那两个库
     error while loading shared libraries: libggml-base.so.0: cannot open shared object file
   ```
2. `apps/daemon/src/runtime/setup.ts` 的 `backendDir` **定义**就是 `dirname(probePath)`；
3. `probe.c` 只调一次 `ggml_backend_load_all_from_path(backendDir)` ——
   **它只能枚举与自己同目录的后端模块**。

→ **上游 `ggml-org` 的归档里永远不会有我们的探针。** 目录指着上游 = Linux 与 Windows
上「网页检测硬件」这一步永远只有 advisory 一档证据，拿不到设备枚举。
而探针缺席的症状是「尚未探测到硬件能力」，**与"这台机器真的没有 GPU"在界面上完全一样**。

**判据不是「自建的比上游好」**（多数情况下不是），**是「这一个文件只能由我们放进去」。**

### 7.3 代价与未知（**原样记在这里，别让下一个人自己去猜**）

| 项                                                                  |        上游 |            我们 | 说明                                                                                                                              |
| ------------------------------------------------------------------- | ----------: | --------------: | --------------------------------------------------------------------------------------------------------------------------------- |
| `whisper-bin-ubuntu-x64.tar.gz` → `whispercpp-cpu-linux-x64.tar.gz` | 9,379,235 B | **6,752,275 B** | 小 2.6 MB。可见成因：我们跑了 `strip --strip-unneeded`。`UNKNOWN`：上游的 `ggml-cpu-*` 变体条数没数过（我们 14 条）               |
| `whisper-bin-x64.zip` → `whispercpp-cpu-win-x64.zip`                | 7,982,101 B | **3,951,207 B** | 小 4 MB。我们 **10 条** `ggml-cpu-*.dll`；`UNKNOWN`：上游几条没数过。ggml 按 CPU 特性挑变体，少一条只会退到更保守的那条，不会失败 |

其余四条未知/代价：

1. ⚠️ **`ggmlAbi` 在 Windows 上取不到**：`build-whisper.sh` 从**文件名**取 ABI
   （`libggml.so.<x.y.z>`），而 `ggml.dll` 文件名里没有版本号 —— **结构上取不到**，
   CI fragment 给的是 `null`。目录里写的 `0.15.1` 来自**同一 commit 同一轮构建**的
   Linux / macOS 兄弟包，是**推断值不是量出来的**。三平台哪天不再同轮构建，这一格就不可信。
2. ⚠️ **端到端未重跑**：换包之后 Linux / Windows 上「干净机器 → 真的转出非空文本」
   还没跑过（要一轮 `cold-start-audit --transcribe`）。
3. ⚠️ **VC++ 运行时那一格没变**：探针自己的导入表只有 UCRT，但它链接的
   `ggml-base.dll` / `ggml.dll` 仍然要 VC++ 可再发行组件（D-11 §8.3）。
   **换包既没改善也没恶化这一格** —— 上游包同病。
4. **升级检查的语义变了一半**：`components.json` 里这几条的 `upstream` 仍指
   `ggml-org/whisper.cpp`（回答"引擎有没有新版本"），但**上游发新版不会自动产出新的包**。
   所以这一条上的「有更新」是「**该重建了**」的提示，不是「点一下就能升」。

### 7.4 守卫怎么办：**没绕过，也没改**

`scripts/ci/merge-backend-manifest.mjs` 那条 ADR-015 规则是
「**现有条目有真 URL、进来的 CI 产物没有 → 保留现有那条**」。
它按**有没有下载地址**判定，不按 URL 属于谁 —— 所以这次替换**不触发也不削弱它**：
换完之后目录里那条仍然有真 URL，CI fragment 仍然是 `pending-ci`，规则原样生效。
`scripts/ci/selftest-ci-manifest.mjs` ④ 那组用例一个字没动。

新加的守卫在另一处（`apps/daemon/src/pipeline/probeShipping.test.ts`）：
**每一个能装 whisper 引擎的平台，它的核心包必须提供 `openmemo-probe`**，
并且这四个例外 id 必须各自带着 `sha256Provenance` 里那段理由。
少了理由会当场红 —— 免得哪天有人"顺手统一"把它们改回上游，
而那件事的后果（硬件探测全线失效）在界面上是**静默**的。
