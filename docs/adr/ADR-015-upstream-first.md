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

### 7.5 订正（2026-08-08，`prebuilt` 就地改，Manager 当轮授权）：§7 是对的，但**不完整**

§7.2 的三条实测事实**今天逐条复核，全部仍然成立**
（`[本机实测 2026-08-08]` `objdump -p openmemo-probe` 仍是
`NEEDED libggml-base.so.0 · NEEDED libggml.so.0 · RUNPATH $ORIGIN`）。
**这一节的结论没有被推翻。** 被订正的是它**漏掉的那一半**。

#### 漏掉的那一半：探针只在**装完包之后**才存在

~~上游 `ggml-org` 的归档里永远不会有我们的探针 ⇒ 探针只能随包出厂。~~
→ 前半句仍然对；**后半句少说了一句「那用户装包之前怎么办」**。

`[用户真机实测 2026-08-08, Windows, v0.3.0]` 用户下载 zip、解压、运行，
**本机组件页六个后端全部**报：

```
probe did not complete: probe executable not found:
  C:\Users\...\AppData\Roaming\OpenMemo\bin\runtime\openmemo-probe.exe
```

`[本机复现 2026-08-08, linux-x64, 全新空数据目录]` 六行一模一样。

**这是一个环**：探针随 whisper 包出厂 → 可用户**要先探测硬件才知道该装哪个包**。
章程要求 2.1「网页检测硬件 → 推荐后端」那一步，在**任何包都还没装的时候**
恰恰是最需要的 —— 而那正是它唯一不可用的时候。

**CI 为什么没撞到**：`e2e-runtime` 那条腿自己调
`POST /api/backends/install` **直接指定包 id** 去装，**跳过了「探测→推荐」这一步**。
产品最常见的第一屏，此前没有任何一条 CI 腿走过。

#### 订正后的形状：**随包出厂 + 预编译包自带一份最小的兜底**

预编译包（D-17）现在自带 `runtime/probe/`：探针 + ggml 核心 + **一个** CPU 后端模块。
`[本机实测 2026-08-08]` 共 **1,681,444 B（1.60 MiB）**，包体 176.3 → **178.0 MiB**。
来源是**已经钉死并校验过的** `whispercpp-cpu-*` 归档（manifest 的 sha256），
**没有新开获取通道**，也没有引入第二份 ggml 来源 —— §4 决策 1/3 不受影响。

**它排在探针查找顺序的最后一位**，这一点是本次订正里最要紧的约束：

```
OPENMEMO_PROBE > <dataDir>/bin/runtime > 已安装的后端包 > 包内兜底
```

因为 `backendDir = dirname(probePath)`（§7.2 第 2 条），而包内那个目录**只有 CPU 模块**。
它一旦排到已安装后端包**前面**，用户装完 Vulkan 包之后探针仍会去扫包内目录，
于是「**装了却检测不到**」—— 那比原来的 bug 更糟，因为它发生在用户**以为已经装好之后**。

#### 它**不能**回答什么（写下来，别让下一个人以为环已经全解开了）

**「验证后端 X 能用」在装 X 之前结构上无解。** `libggml-cuda.so` 本身就有 564 MB ——
那正是用户要决定装不装的东西。包内探针只能枚举 CPU。

但这**不是**静默降级：`packages/runtime/src/backends/manager.ts` 的判定链是
`!probe.ok` → `!installed` → `!probed` → …，**`installed` 排在 `probed` 之前**。
所以探针一旦跑得起来，未装的后端得到的是
**`backend package not installed`** —— 一句真话，既不是带内部路径的
`probe did not complete`，也不是「你没有 CUDA」这种自信的假阴性。

`[本机实测 2026-08-08，同一个空数据目录，前后对比]`

|                                       | 修复前                                                  | 修复后                              |
| ------------------------------------- | ------------------------------------------------------- | ----------------------------------- |
| cuda / vulkan / rocm / metal / coreml | `probe did not complete: probe executable not found: …` | **`backend package not installed`** |
| cpu                                   | 同上                                                    | **`available=true probed=true`**    |

顺带买到的一件事：ADR-003 决策 3 的 **L1「内置 CPU 后端 · 永不失败的兜底」
此前从来没有被真正验证过**（没有探针 ⇒ CPU 这一档也只是推断）。现在它是实测的。

#### 守卫

`scripts/ci/verify-bundle.sh` 加了 4 条（26 → 30）：探针在 / ggml 核心在 /
有 CPU 模块 / **同平台时真的跑一次且 `deviceCount ≥ 1`**。
`scripts/ci/diagnose-probe-bootstrap.mjs` 进了三条打包腿：
空数据目录 + 什么都不装，**任一后端报 `probe did not complete` 即失败**。

`[反向验证，/tmp 隔离副本，PROTOCOL §10]` 抽掉探针 → 红；抽掉 `libggml-base` →
**「探针跑不起来」**（文件存在性检查会放行，只有真跑那一条抓得到）；
抽掉 CPU 模块 → 红；还原 → 绿。

---

## 8. 补充（2026-08-09，Manager 裁决）：**自建托管的 release 从此不删**

> 本节由 `e2e-allcomponents` 按 Manager 2026-08-09 的裁决就地追加（PROTOCOL §13：
> 裁完之后回原文改，而不是另开一页）。**§0–§7 一个字未改。**

### 8.1 因果链（三段，缺一段结论都不成立）

1. **预编译包内嵌 `vendor/manifests`。**
   这是 2026-08-08 为了修「用户解压后组件页是空的、什么都装不了」而加的
   （`resolveManifestDir()` 的模块相对兜底要求清单随包出厂，见 D-17）。
2. **内嵌 ⇒ 地址在出厂那一刻就冻结。**
   包里那份清单不会再更新。用户机器上那个包，永远按**打包当天**的 URL 去下载。
3. **⇒ 删掉一个 release = 打死所有还指着它的、已经发出去的包。**
   用户看不到"某个 tag 没了"，他只看到「点安装没反应 / 下载失败」。

### 8.2 这不是假设，已经真的发生过一次

`[实测 2026-08-09，e2e-allcomponents run 31295507733]`

| 时间  | 事件                                                                           |
| ----- | ------------------------------------------------------------------------------ |
| 01:00 | 打包 `openmemo-0.4.0`（commit `99995b8`），内嵌清单里 whispercpp → **v0.3.0**  |
| 03:58 | `ddccef4` 把目录重指 **v0.4.0**（`git merge-base --is-ancestor` 证实包早于它） |
| 之后  | **v0.3.0 release 被删除**                                                      |
| 结果  | `curl` 实测 v0.3.0 → **404**、v0.4.0 → 206；安装 job 1 秒内失败报 `NOT_FOUND`  |

**后果**：三平台 whisper.cpp 一族（**含 GPU 加速包 Vulkan / Metal**）全部装不上。
只有这一族中招 —— 因为**只有它托管在我们自己的 release 上**（§7 的那个例外），
其余组件指上游，删我们的 release 打不到它们。**这条选择性反过来印证了成因。**

### 8.3 裁决与为什么不选另外两条

**从现在起不删自建托管的 release。**

| 候选                | 为什么不选                                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 改回远端拉目录      | 要复活刚删掉的死代码线（`loadManifest` / `verifyCatalogSignature`）——**那是一个带信任模型的大设计决定，不该被一个热修拖着做** |
| 给旧 tag 留资产副本 | 要复制字节，还要维护两份一致性                                                                                                |
| **不删**（采纳）    | 删 release 本来就没换来任何东西 —— 只为"页面干净"，代价是打死已发出的包。**这笔交易从一开始就是亏的**                         |

### 8.4 守卫：判据不是"记得别删"

本仓立过 **"跑错了也不会造成后果"**（PROTOCOL §7 补充）。所以配了两件，
**并且如实说清它们各自的边界**：

- `scripts/ci/check-release-refs.mjs --tag <tag>` —— 删之前问一句「还有谁指着它」，
  有人指着就 exit 1 并列出清单。**这一条给人用，拦不住"没问就删"。**
- `scripts/ci/check-release-refs.mjs --assert-live` —— **已接进 `release-upload.yml`
  的 `verify` job**（发包前）。目录里指向我们自己 release 的地址死了任何一个，
  **新包就发不出去**。这一条不依赖任何人记得什么。

⚠️ **仓库里没有任何东西能在服务端拦住 `gh release delete`**（没有 release 的分支保护，
也没有服务端钩子）。所以守的是**后果**而不是动作：删了之后**发布会当场红**，
事故止步于"我们发不出新包"，而不是走到"用户装不上"。
