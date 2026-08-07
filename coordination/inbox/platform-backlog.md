# inbox / platform-backlog

## [2026-08-07 15:40] T-167 PROGRESS —— 探针那一族

# TL;DR（只读这里）

## ★ 一句话：**「缺的只剩把它发出去」不成立 —— 我查到三条别的阻碍，两条已修，第三条要你拍板**

| # | 事 | 状态 |
|---|---|---|
| ① | 探针**不能**单独分发：它动态链接 ggml，裸跑报 `libggml-base.so.0: cannot open shared object file` | ✅ **已解**：改成**随包出厂**（每个包各带一份），`[CI 实测]` |
| ② | **macOS 探针 `minos = 26.0.0`** —— 同一轮 CI 里包内 20 个二进制是 13.3.0，探针是 26.0.0 | ✅ **已修 + 上守卫**，`[CI 实测]` 现在 13.3.0 |
| ③ | 目录里 **Linux / Windows 的核心包指的是上游** `ggml-org` 的归档，我们的探针进不去 | 🔴 **要你拍板 + 一次 release** —— 清单见下面「要发 release 的清单」 |
| ④ | 「Windows 适用包 5 变 6」 | ❌ **因果关系不成立**，而且**这个 runner 结构上验不了**。实测四格矩阵见 §2 |

提交 `3ef8734`（已 push）。`build-backends` run **31155359839**（`legs=all`，8 条腿）
—— 7 条 success，`windows-x64-cuda` 写这封时还在跑。

## 数字

- `pnpm test:ci-scripts` 全绿：`lint-workflows` **556**（+20）· `selftest-macho-minos` **15/15**（新，含 7 条反向）·
  `selftest-build-whisper` **22/22**（+13，含新增 RV-D）· `selftest-elf-glibc` / `selftest-buildbox` 未受影响。
- `[CI 实测]` 包里的产物计数变化 = 探针真的进包了：
  `linux-cpu` ELF 22→**23** · `linux-vulkan` 23→**24** · `macOS` Mach-O 12→**13** · codesign 12→**13** 个文件。
- 未跑 `pnpm -r test`（本轮一行 `apps/**` / `packages/**` 都没改；基线仍是别人报的 1214/0）。

## ⚠️ 我没做的（硬边界）

**没有建 / 改 / 删任何 release，也没有 dispatch `release-upload.yml`。**
`gh` 只用了 `run list/view/download`、`api …/logs`（只读）与一次 `workflow run`（dispatch）。
所以判据里那句「干净机器上从网页装完之后 …」**本轮拿不到**：清单还指着上游的包，
新产物没有下载地址。要我接着往下走，请照「要发 release 的清单」建 tag。

---

# §1 ① 探针到底卡在哪 —— 三条，不是一条

## 1.1 🔴 它**不是**一个可以单独分发的可执行文件（`[本机实测]`）

对象是 run 31147884172 的 `dist/probe/openmemo-probe`（17,208 B，就是今天 CI 在产的那个）：

```
$ objdump -p openmemo-probe | grep -E 'NEEDED|RUNPATH'
  NEEDED   libggml-base.so.0        ← 在包里
  NEEDED   libggml.so.0             ← 在包里
  NEEDED   libc.so.6
  RUNPATH  $ORIGIN

$ ./openmemo-probe                  # 同目录没有那两个库
  error while loading shared libraries: libggml-base.so.0: cannot open shared object file

$ cp openmemo-probe <解开的 whispercpp-cpu-linux-x64>/ && cd 该目录
$ env -u LD_LIBRARY_PATH ./openmemo-probe .
  {"schemaVersion":1,"ggmlVersion":"0.15.1","deviceCount":1,"devices":[{"name":"CPU",…}]}
```

**所以「像 yt-dlp 那样单独发一个文件」这条路是死的** —— 它会装得上、校验通过、
`probeExists: true`，然后**一次都启动不了**；而它启动不了的表现是
「尚未探测到硬件能力」，与"这台机器真的没有 GPU"在界面上完全一样。

## 1.2 它必须在**每一个**包里，不只是核心包（三条依据）

1. §1.1：要和 `libggml-base` 同目录才起得来；
2. `apps/daemon/src/runtime/setup.ts` 的 `backendDir` **定义**就是 `dirname(probePath)`；
3. `probe.c:110` 只调一次 `ggml_backend_load_all_from_path(backend_dir)` ——
   **它只能枚举与它同目录的后端**。只有核心包带探针的话，装了 Vulkan 包的用户
   永远枚举不到 vulkan 设备。

`[本机实测]` 用**产品自己的** `resolveRuntimeLayout()` 在真 store 上跑三个场景：

```
cpu-only             probePath = <models>/by-name/backend/whisper-bin-ubuntu-x64.tar.gz/openmemo-probe
                     backendDir = 同目录     probeExists=true   runProbe.ok=true   deviceCount=1
cpu+vulkan（未选）   probePath = …/whispercpp-vulkan-linux-x64.tar.gz/openmemo-probe
                     ← priority 80 > 10，**加速包那份探针胜出，backendDir 自动对上** ✅ 这条是好消息
cpu+vulkan + 显式选 cpu
                     probePath 回到 CPU 包   ← §3 的残留缺口
```

→ 改法：`scripts/build-whisper.sh` 把探针编进**每个** stage（在 strip / codesign **之前**，
两步一起管它），编不出来当场 die。`[CI 实测]` 三个平台全部生效。

## 1.3 ★ 判据本身：自检那一行真的从 warn 变 ok（`[本机实测]`）

逐行复刻 `packages/runtime/src/selfcheck.ts` 里 `hw.probe` 那一条的逻辑，喂真 store：

```
① 今天（release 上那个包，里面没有 openmemo-probe）：
   hw.probe  status=warn  detail='openmemo-probe 未安装（后端能力未知）'
② T-167 之后（同一个包 + 探针）：
   hw.probe  status=ok    detail='1 个设备, ggml 0.15.1'
```

⚠️ **记一笔我自己差点犯的错**：第一次跑这两格，① 也报 `ok` ——
因为我早先做实验时往那个解开目录里拷过一次探针，**夹具被污染了**。
重新从归档解一遍才拿到上面这个对照。**一个不是从原始产物重新解出来的对照组，
证明不了任何事**，而它长得和成功一模一样。

---

# §2 ④ 「Windows 适用包 5 变 6」—— 因果关系不成立，而且这个 runner 验不了

这条推断来自 `docs-public` §3.3，三条证据拼成。**其中第 2 条在写下之后被改掉了**：
`gates-fix` T-160（`4bb846e`）给 L2 加了 advisory 逃生口，而它引用的那次 CI 观测
（run 31076010999）**早于** T-160。

`[本机实测]` 用**产品自己的** `evaluateApplicability()` 跑真目录
（`loadBackendCatalog` 会读的全部 23 个包，Windows x64 占 6 个）：

| 场景 | 适用 | CUDA 那条被判成什么 |
|---|---|---|
| **A** 今天的 CI runner（无探针、无 NVIDIA） | **5 / 6** | 「尚未探测到硬件能力；请先安装 CPU 基础包」 |
| **B** 今天的真 N 卡 Windows（无探针，`nvidia-smi` 在） | **6 / 6** | ✅ **今天就是 6，不需要探针** |
| **C** 探针发出去后的 CI runner（无 NVIDIA） | **5 / 6** | 「backend package not installed」 |
| **D** 探针发出去后的真 N 卡 Windows | **6 / 6** | ✅ |

机制（`packages/runtime/src/detect/gpu.ts`）：Windows 分支先跑 `nvidia-smi`，
成功才给 `candidateBackends: ['cuda','vulkan']`；
`Get-CimInstance Win32_VideoController` 那条**永远只给 `['vulkan']`**，
软件适配器还被 `SOFTWARE_ADAPTER_NAMES` 过滤掉。
GitHub 的 `windows-2025` 没有 NVIDIA 驱动 → 没有 `nvidia-smi` → cuda 永不入选。

**两条结论：**

1. **「Windows CUDA 包今天装不上」要限定到"没有 N 卡的机器"** —— 而那是**正确行为**。
   有 N 卡的 Windows 上它今天就是可装的（B 格）。这一条建议同步进 README / DEPLOYMENT
   （`docs-public` 的地盘，我没改）。
2. **这条判据在任何 GitHub 托管 runner 上都验不了** —— 不是"还没验"，
   是把它从 5 变 6 需要一块真 NVIDIA 卡。我不拿一个验不了的判据当"待办"挂着。
   探针真正买到的是 §1.3 那一行（`hw.probe` warn → ok）与 `/api/runtime/hardware`
   从"猜"变成"量"。

C 格还顺带改善了一句话：拒绝理由从「请先安装 CPU 基础包」（而它已经装了）
变成「backend package not installed」（说的是 CUDA 包自己）。

---

# §3 ② L2 门禁复核：**规则仍然成立，两条路不打架**；但有第三样东西

## 3.1 复核结论

`evaluateApplicability` 的顺序是：
`probe 说可用 → 适用` ＞ `包没装 且 advisory 认得这块硬件 → 适用` ＞ `否则不适用`。

探针发出去之后逐格核过（就是 §2 那张表的 C/D 两行 + 已装包的情形）：

| 情形 | 探针缺席时 | 探针在场时 | 打架吗 |
|---|---|---|---|
| 有对应硬件、包没装 | advisory → 适用 | `installed=false` → 仍走 advisory → 适用 | 否 |
| 有对应硬件、包已装、探针枚举到 | — | `available=true` → 适用（**最强证据**） | 否 |
| 有对应硬件、包已装、探针枚举不到 | — | 不适用，理由来自探针 | 否（**这是设计**：探针有过机会） |
| 无对应硬件 | 不适用 | 不适用 | 否 |

**"probe 在场以 probe 为准、不在场用 advisory"这条规则一格都没被推翻。**
`gates-fix` 用 `AdvisoryGpu.candidateBackends` 解开死锁那条修法，在探针发出去之后仍然对。

## 3.2 🔴 但我查到**第三样东西**：`backendDir` 是单值的（**没修，交给 `daemon-backlog`**）

`resolveBackendTool()` 只挑**一个**包，`backendDir = dirname(probePath)`。于是：

> 用户**显式**选了 `cpu`（或同时装了两个加速包）时，探针只看一个目录，
> 另一个已安装的加速包会被报成
> `installed but enumerated no devices (driver missing or too old)`
> —— **一句具体的、而且是错的诊断**（它在怪驱动，真实原因是探针看错了目录）。

`[本机实测]` 已复现（§1.2 第三个场景）。**今天不伤人，因为今天根本没有探针**；
探针一发出去它就成立了。**这是我这轮改动带出来的下一层，我不藏着。**

建议的判据（给 `daemon-backlog`）：

> `detectHardware` 对**每一个已安装的后端包目录**各跑一次探针并取并集，
> 而不是只跑 `dirname(probePath)` 那一个。
> 判据：CPU 包 + Vulkan 包同时装着、用户显式选 cpu 时，
> `hardware.backends.vulkan` 仍然报得出真实结论（而不是怪驱动）。

⚠️ 这一片是 `apps/daemon/src/runtime/setup.ts` + `packages/runtime`，
**我一个字没改**（`daemon-backlog` / `pack-select` 正在那儿）。

---

# §4 ★★ 要发 release 的清单

**我不建、不改、不删 release，也没有 dispatch `release-upload.yml`。** 下面是交给你的材料。

## 4.1 为什么必须是**新 tag**

现有两个 release 上已经有同名资产
（`backend-packs-2026.08.06/whispercpp-cpu-macos-arm64.tar.gz`、
`backend-packs-2026.08.07/whispercpp-{cpu,vulkan}-linux-x64.tar.gz`），
而 `release-upload.mjs` 按设计**不能 `--clobber`、不能删资产**
（`lint-workflows` 有断言钉着）。同名不同内容会**当场失败**，这是对的。

→ 建议 tag：**`backend-packs-2026.08.07b`**（已发布 / 可 prerelease / **不能是 draft**，
draft 的附件不能匿名下载）。

## 4.2 清单（全部来自 `build-backends` run **31155359839**，sha256 **本机重下复算**，与 CI fragment 逐字符一致）

| # | 文件 | 字节 | sha256（本机复算） | artifact |
|---|---|---:|---|---|
| 1 | `whispercpp-cpu-linux-x64.tar.gz` | 6,752,275 | `7075ef1ce24087798d2a7f4ddaaf7506559560d5b35ec8af49a5a6854dca6ba8` | `packs-linux-x64-cpu` |
| 2 | `whispercpp-vulkan-linux-x64.tar.gz` | 29,499,386 | `5bad8cf2384069942972b67d408f2f9835daf4ecd0a16bed0fbf2edf95cc2d22` | `packs-linux-x64-vulkan` |
| 3 | `whispercpp-cpu-macos-arm64.tar.gz` | 2,015,162 | `b33060e6c00be7ab6dbc00949e4c34ec52c2037802c3d331c38a3cee0c10a257` | `packs-macos-arm64-cpu` |
| 4 | `whispercpp-cpu-win-x64.zip` | 3,951,207 | `a1d101cbe2f12636d23cdf43ea8f0faa014306230ddb8b4597e53fae48497e86` | `packs-windows-x64-cpu` |

四个包**每个里面都有一份探针**（`[本机实测]` 逐个解开数过：
`openmemo-probe` / `openmemo-probe.exe` 各 1 个，且都在 `providesFiles` 里）。

`ci-upload` 那条链可用：`release-upload.yml`，输入
`tag=backend-packs-2026.08.07b`、`run_id=31155359839`、
`artifacts=packs-linux-x64-cpu,packs-linux-x64-vulkan,packs-macos-arm64-cpu,packs-windows-x64-cpu`。
它会现场复算、匿名重下复算，两处都会真的红。

## 4.3 ⚠️ 3 与 4 是**替换**，不是新增 —— 这条要你拍板

| 目录里那条 | 现在指向 | 建议改成 | 为什么 |
|---|---|---|---|
| `whispercpp-cpu-linux-x64` | 上游 `ggml-org` 的 `whisper-bin-ubuntu-x64.tar.gz`（9,379,235 B） | 我们编的（6,752,275 B） | **上游的包里永远不会有我们的探针**。而且我们这个有 glibc ≤2.34 守卫、自包含、CI 上跑过 relocatable 冒烟 |
| `whispercpp-cpu-win-x64` | 上游 `whisper-bin-x64.zip`（7,982,101 B） | 我们编的（3,951,207 B） | 同上。内容清点过：`whisper-cli.exe` / `whisper-server.exe` / `whisper-bench.exe` / `whisper-vad-speech-segments.exe` / `whisper.dll` / `ggml*.dll` × 11 / `parakeet.dll` / `openmemo-probe.exe`，共 18 个文件 |

**代价与未知，如实列：**

- ⚠️ 我们的 Windows 包只有 **10 个 `ggml-cpu-*` 变体**（上游那个我没解开数过，`UNKNOWN`）。
  ggml 按 CPU 特性选变体，少一个变体不会失败、只会退到更保守的那个。
- ⚠️ `emit-pack-manifest` 给 Windows 包算出的 `ggmlAbi` 是 **null** —— `build-whisper.sh`
  的 ABI 探测只找 `libggml.so.*` / `libggml.*.dylib`，**不认 `ggml.dll`**。
  目录里现有那条写的是 `"0.15.1"`。这是个**既存**小缺陷（不是我引入的），
  补目录时要手填，或者先修那段探测。我倾向先修探测再补目录。
- ⚠️ **换完必须重跑一轮 `cold-start-audit --transcribe`**（三平台），
  判据仍是「屏蔽宿主 PATH 的干净机器上真的转出非空文本」。**没跑之前我不会去补目录。**
- 🔴 `whispercpp-cuda-12.4-win-x64` **仍然是上游的包，里面没有探针**。装上它之后会落进
  §3.2 那个缺口（探针从 CPU 包解析出来 → 看不到 cuda → 报「installed but enumerated
  no devices (driver missing or too old)」）。**两条出路**：
  ① 先修 §3.2（推荐，结构性）；
  ② 换成我们自己编的 Windows CUDA 包（run 31155359839 有产出，**138 MB vs 上游 678 MB**），
     但我们只编 `--cuda-arch 86;89`（RTX 30/40 系），**比上游的 fat 包窄** —— 这是产品取舍，你定。

**我没有把任何一条写进 `vendor/manifests/`。** 理由与 `amd-vulkan` T-161 当时一样：
**在资产有下载地址之前补目录，只是多一个装了没用的按钮。**

---

# §5 ★ `docs/00-CHARTER.md` §3 的补丁（**我没有改这个文件**，PROTOCOL §1）

把 §3 顶部那个订正块整段替换成下面这段。三处订正 + 一处新增，逐条都有出处：

```markdown
> ⚠️ **产物现状（2026-08-07 实测）—— 分两层看，此前本块把这两层混为一谈**
>
> **第一层：CI 能不能编出来。** `build-backends` run **31155359839**（`legs=all`）
> macOS ×2 / Linux ×3 / Windows ×3 八条腿全部跑过，含 metal / vulkan / cuda。**路是通的。**
>
> **第二层：用户能不能在网页上装。** 这一层才是对外口径。
>
> | 平台 / 加速 | 网页可装？ | 依据 |
> |---|---|---|
> | macOS arm64（CPU + Metal + CoreML 同一个自包含核心包） | ✅ | 目录里是我们自己编的包 |
> | Linux x64 CPU · Windows x64 CPU | ✅ | 目录里指的是**上游 ggml-org** 的归档 |
> | **Linux x64 Vulkan** | ✅ **2026-08-07 起**（`8cb3b35`，三条阻碍全消之后才补的） | — |
> | Windows x64 CUDA | ✅ **在有 NVIDIA 驱动的机器上** / ❌ 没有 N 卡的机器上不适用（**这是正确行为**） | `[实测]` 用 `evaluateApplicability` 跑真目录：有 `nvidia-smi` → 6/6 适用；没有 → 5/6 |
> | Windows x64 Vulkan · Linux x64 CUDA | 🟡 有产物、未进目录 | Linux CUDA 缺 `libcudart` 随包分发，装了没用 |
> | AMD ROCm · linux-arm64 · macOS Intel | ⛔ 无产物 | 用户 2026-08-05 明确裁掉 |
>
> ⚠️ **本块此前有三处错，来源不同，一并订正：**
> 1. 「Linux Vulkan 有产物、未进目录」—— **已进目录**（`8cb3b35`）。
> 2. 「Win CUDA 在目录里但今天装不上（L2 门禁 + `openmemo-probe` 无分发通道）」——
>    **两个理由都不再成立**：L2 死锁已由 `gates-fix` T-160（`4bb846e`）用 advisory 探测解开；
>    而 `[实测]` 探针在不在**不改变**这一格的判定（探针枚举不到未安装的后端，
>    这一格从来是 advisory 在答）。今天在真 N 卡 Windows 上它是可装的。
> 3. 沿用旧的「适用包 5 个不是 6 个」时**没有说清前提** —— 那是**没有 N 卡的 runner** 上的数。
>
> ➕ **新增一条现状**：`openmemo-probe`（要求 2.1 里「检测硬件」那一步的执行者）
> 从 T-167 起**随每个我们自编的包出厂**（`[CI 实测]`），但
> **Linux / Windows 的核心包在目录里指的是上游归档，进不去我们的探针** ——
> 所以这两个平台上「网页检测硬件」这一步今天仍然只有 advisory 一档证据。
> 要补齐，需要把这两条目录项换成我们自己的构建 + 一次 release（清单在
> `coordination/inbox/platform-backlog.md` §4）。
```

---

# §6 本轮改了什么（逐个文件）

改：

```
scripts/build-whisper.sh            把 openmemo-probe 编进每个 STAGE + 守卫；13.3 改从 baselines.sh 取
scripts/build-probe.sh              darwin 上传 -mmacosx-version-min；source baselines.sh
.github/workflows/build-backends.yml  macOS 加 Guard macOS deployment target；三条腿的 Build probe
                                      改成从 stage **复制**（upload 的与包里的必须是同一份字节）
scripts/ci/lint-workflows.mjs       +20 条断言（536 → 556），把上面这些钉成结构
scripts/ci/selftest-build-whisper.sh  cc 桩 + 探针两条正向断言 + RV-D；**修掉它自己的一处假绿**
package.json                        一行：selftest-macho-minos 接进 test:ci-scripts
docs/design/D-11-ci-platform-facts.md  **追加 §9**（节首标明作者与来源，正文其余一字未改）
```

新增：

```
scripts/lib/baselines.sh            13.3 与 2.34 的单一事实来源
scripts/ci/check-macho-minos.mjs    Mach-O minos 守卫（纯 node 解析，不依赖 otool）
scripts/ci/selftest-macho-minos.mjs 15 条，含 7 条反向
coordination/inbox/platform-backlog.md   本文件
```

## 6.1 ⚠️ 我动了别人立的一条守卫，说明理由

`lint-workflows.mjs` 里 `runner-migrate` T-163 那条 `COMPILE_MARKERS` 要求
**linux job 的某一步直接调 `scripts/build-probe.sh` 且必须经过 buildbox**。
探针改成由 `build-whisper.sh` 调用之后，workflow 里不再直接出现它 ——
那条断言会因为"没东西可查"报出一个**假红**。

我**没有删掉那条性质**，只是换了钉的位置，并且钉得更细：
`build-probe.sh` 从 marker 表里移走（`build-whisper.sh` 仍在表里、仍必须过 buildbox，
所以"探针在容器里编"这条性质是传递成立的），同时新增四组断言 ——
build-whisper.sh 里那次调用的落点必须是 `${STAGE}/`、那条 `die` 必须还在、
三条腿产出 `dist/probe` 的步骤里**不许**再出现 `build-probe.sh`（否则就是编了第二遍）、
以及 macOS 的 minos 守卫必须存在且 `--max` 是字面量 13.3。

## 6.2 ⚠️ 顺手修掉一个**自检自己的假绿**（记账）

`selftest-build-whisper.sh` 的 `run_case` 用 `echo "${case_dir}"` 回传路径，
调用方写 `if cd1="$(run_case …)"`。于是失败时 **`bad` 的输出被 `$( )` 吞进变量、
`fail` 的自增发生在子 shell 里丢掉**，表现是「那一节一条断言都没打印」。

`[实测]` 我第一次把探针加进 `build-whisper.sh` 时，①② 两整节消失，
脚本报的却是 `✔ 9 passed, 0 failed` —— **正是本仓在清的那种假绿，而且长在自检自己身上**。
改成全局变量回传（`CASE_DIR`），`bad` 直接打到终端。现在同样的输入会打印 `✘`。

---

# §7 CI 实测（run **31155359839**，commit `3ef8734`，`legs=all`）

七条腿 success（写这封时 `windows-x64-cuda` 还在跑）。关键行原文：

```
macos-arm64-cpu
  ==> building openmemo-probe into the pack
  ==> built: .../stage/whispercpp-cpu-macos-arm64/openmemo-probe ( 52K)
  check-macho-minos: 13 个 Mach-O（13 个 slice），上限 minos 13.3，实测最高 13.3.0
    ✔ minos 13.3.0 sdk 26.5.0 macOS   .../whispercpp-cpu-macos-arm64/openmemo-probe   ← ★ 修好了
  ✔ 全部 minos ≤ 13.3
  .../openmemo-probe: valid on disk / satisfies its Designated Requirement
  verified 13 signed file(s)                                           ← 12 → 13

macos-arm64-metal   check-macho-minos: 12 个 Mach-O … 实测最高 13.3.0 ✔（metal 包也带探针了）
linux-x64-cpu       check-elf-glibc: 23 个 ELF … 最高 GLIBC_2.34 ✔（22 → 23）
                    check-elf-glibc:  1 个 ELF（dist/probe 那份副本）… 2.34 ✔ · pack is relocatable
linux-x64-vulkan    check-elf-glibc: 24 个 ELF … 最高 GLIBC_2.34 ✔（23 → 24）
windows-x64-cpu     ==> probe OK
```

## 7.1 ★反向验证

| 撤掉什么 | 结果 | 红在哪 |
|---|---|---|
| **拿真产物喂新守卫**（不是变异，是真的旧产物） | ✔ exit 1 | `.../dist/probe/openmemo-probe minos 26.0.0（sdk 26.5.0）`，同一目录的 20 个包内二进制全绿 —— **守卫在真实缺陷上第一次运行就抓到了它** |
| minos = 26.0 的探针混在合规文件里 | ✔ exit 1 | 点名 `openmemo-probe` + `minos 26.0.0`，**不连坐** `libggml-base` |
| 目录里一个 Mach-O 都没有 | ✔ exit 1 | 「空集 ≠ 没问题」 |
| 既无 `LC_BUILD_VERSION` 也无 `LC_VERSION_MIN_MACOSX` | ✔ exit 1 | 「我读不出来 ≠ 这里没问题」 |
| platform=iOS 的 slice | ✔ exit 1 | — |
| universal binary 里**第二个** slice 超标 | ✔ exit 1 | 点名 `slice 1`（只看第一个的话会漏） |
| `minos 9.0` vs `--max 13.3` | ✔ exit 0 | 版本按数字比，不是字符串（假红同样是谎） |
| 老式 `LC_VERSION_MIN_MACOSX` 里的超标 | ✔ exit 1 | 只认新 load command 会整个绕过守卫 |
| 同一份输入 `--max 13.3` / `--max 26.0` | ✔ 一红一绿 | 阈值参数真的参与判断 |
| **RV-D**：`cc` 编译"成功"但不产出探针 | ✔ exit 1 | 「probe did not produce output」，且失败路径下**一个 fragment 都没写** |

全部跑在 `/tmp/platform-backlog/` 与 `mkdtemp` 的隔离副本上（PROTOCOL §10），
共享工作树全程没有被改成坏状态。

⚠️ **诚实边界**：`build-whisper.sh` 里那条 `[[ ! -e "${STAGE}/${PROBE_NAME}" ]] → die`
**桩不出来**（build-probe.sh 正好写在那个位置）。它防的是**将来有人给那次调用加 `|| true`**，
由 `lint-workflows` 的结构断言钉住，不是由 RV-D 钉住。我没把它算进"已反向验证"那一栏。

---

# §8 我没做 / 做不到的（如实列）

| 项 | 状态 |
|---|---|
| 「干净机器上从网页装完之后 `/api/runtime` 报出 probe 已就位」 | ⛔ **本轮拿不到** —— 新产物没有下载地址，而我不建 release。运行时那一侧已在本机逐格验过（§1.2 / §1.3） |
| 「Windows 适用包 5 变 6」 | ❌ **判据本身不成立**，且 GitHub runner 结构上验不了（§2）。不是"没验" |
| `vendor/manifests/**` | ✅ **一个字节没改**。等 release |
| §3.2 那个 `backendDir` 单值缺口 | 🔴 **没修** —— 在 `daemon-backlog` / `pack-select` 的地盘。判据已写好交出去 |
| Windows 上「我们的 CPU 包」端到端能不能转写 | ⏳ **未验证** —— 要等换目录 + 一轮 `cold-start-audit --transcribe` |
| 上游 `whisper-bin-x64.zip` 里有几个 `ggml-cpu-*` 变体 | ⚠️ `UNKNOWN`，没下下来数 |
| `whispercpp-cpu-win-x64` 的 `ggmlAbi` 探测（认不出 `ggml.dll`） | 🟡 **既存缺陷，没修**，见 §4.3 |
| `whispercpp-vulkan-win-x64` 要不要一起发 | ⏳ artifact 下到一半（本轮网络慢），没复算 sha256，**不列进清单** |
| Windows 的 VC++ 运行时依赖（D-11 §8.3） | ⛔ 没碰。探针自己只要 UCRT，但它链的 `ggml-base.dll` 仍然要 VC++ |
| 真 GPU 上验证探针枚举到加速器 | ⛔ 本机是 KVM 无 GPU，CI runner 也没有。全程退到"能不能起来、枚举到什么"这一可验证层 |

---

# §9 纪律申报

- **没有建 / 改 / 删任何 release**，**没有 dispatch `release-upload.yml`**。
  `gh` 用到的：`release list` / `release view`（只读）、`run list` / `run view` /
  `run download` / `api …/logs`（只读）、`workflow run`（一次 dispatch）。
- **`:10000` 全程零请求**，未重启 / 未 kill / 未占用。
- **`/root/data-memo` 与 `~/.local/share/openmemo/datadir.json` 一个字节没读没写。**
  本机验证全部走纯函数 + `mkdtemp` 的假 store（`OPENMEMO_MODELS` 只在子进程里设），
  **不启 daemon、不写指针**（PROTOCOL §9-bis）。
- **`apps/web/dist` 未被触碰** —— 本轮一次 `vite build` / `pnpm -r build` 都没跑
  （也没跑 `build:safe`：改的全是 shell / mjs / workflow）。
- **没有 `pkill -f`；本机一次 whisper 转写都没跑。** 真的执行过的二进制只有
  `openmemo-probe`（Linux x64，只读枚举）与 `objdump` / `tar` / `sha256sum`。
- **新增的外部引用：0 个。** 没有新 pin，没有新 URL，`upstream.ts` 的守卫不受影响。
- **`git add` 逐个文件**，提交前用 `git diff --cached --name-only` 核对过；
  `git status` 里 `ui-backlog` / `daemon-backlog` 的 20 多个在途改动**一个都没 add**。
- 反向验证全部在 `/tmp/platform-backlog/` 与 `mkdtemp` 的隔离副本（PROTOCOL §10）。
- 派出的 subagent：**0 个**。

## SHARED-CHANGE

| 文件 | 归属 | 我做了什么 | 冲突风险 |
|---|---|---|---|
| `package.json` | 公共 | 一行：`selftest-macho-minos.mjs` 接进 `test:ci-scripts` | 低（照 T-161/T-163 的先例） |
| `scripts/ci/lint-workflows.mjs` | `runner-migrate` | 改了它一条断言的**钉法**（不是删性质），+20 条。理由见 §6.1 | 中 —— 请 `runner-migrate` 复核 §6.1 |
| `scripts/build-whisper.sh` | `gpu-runtime` / CI 共管 | 加探针那一段 + 13.3 改从 baselines 取 | 低 |
| `docs/design/D-11-ci-platform-facts.md` | `ci-runner` | **只追加 §9**，节首标明作者与来源，正文其余一字未改（照 `pack-publish` 追加 §8 的先例） | 低 |

# §10 需要 Manager 决策

1. **建 tag `backend-packs-2026.08.07b` 并上传 §4.2 那 4 个资产**（我不建）。
2. **Linux / Windows 的核心包换成我们自己的构建吗**（§4.3）——
   这是探针到达那两个平台的**唯一**通路，但它把两条目录项从上游换成自建。
3. **Windows CUDA 那条怎么办**（§4.3 最后）：先修 §3.2，还是换成我们自建的 138 MB 窄包。
4. **`00-CHARTER.md` §3 的补丁**（§5）—— 只有你能写。

---

## [2026-08-07 16:15] T-167 追加 —— ★ 我把门禁打红了 25 分钟，成因与修法

# 先说给别人听的那句

**`ci.yml` run `31155338320`（commit `3ef8734`，我的）与 `31157170184`
（commit `eacd158`，别人的提交继承了我的坏状态）两次 failure，都是我。**
撞上这两条红的人不用去查自己的改动。已修：`7bb6d2a`，`ci.yml` run **31157500574 success**。

# 红在哪（真实输出）

```
✘ linux-cpu: build-whisper.sh 退出非零
    error: ggml headers not found: /home/runner/work/openmemo/openmemo/vendor/whisper.cpp/ggml/include
✘ msvc-vulkan: 同上
✘ RV-D（红了，但理由不对）
✘ 10 passed, 3 failed
```

# 成因：**一条一直存在、但直到今天才被真的踩到的隐形依赖**

`selftest-build-whisper.sh` 的每个 case 都不传 `--src`，于是用的是真的
`vendor/whisper.cpp` submodule（它自己的注释写着"脚本要 `git -C` 它拿版本号"）。
而 `ci.yml` 的 checkout **刻意不拉 submodule**：

> `# submodules 刻意**不拉**：TS 侧一行都不需要 vendor/ 里的 C++ 源码，`
> `# 而 whisper.cpp / sherpa-onnx 加起来是几百 MB 的 checkout。`

**在探针进包之前，这个自检恰好没有任何一步真的「读」过那棵树** ——
`git -C <空目录> describe` 有 `|| echo unknown` 兜底，`cmake -S` 是桩。
所以那条依赖存在了很久，一直看不见。探针那一步要 ggml 头文件，一读就现形。

# 修法：**让它本来就不该依赖那棵树**，不是"把 submodule 拉下来"

给门禁加 `submodules: recursive` 是最省事的一条，我没选：
那会给**每一次**门禁运行加上几百 MB 的 checkout，只为了让一个"要验的东西一行都不在
C++ 源码里"的自检跑起来。两条真正的修法：

1. `build-whisper.sh` 给 `build-probe.sh` 显式传 `--include "${SRC_DIR}/ggml/include"`。
   此前 build-probe.sh 用**它自己的默认值** `REPO_ROOT/vendor/whisper.cpp/ggml/include`，
   而源码树由 `--src` 决定 —— **又一次「产出方与使用方各算各的」**，
   和本仓那几次事故是同一个形状，只是这次代价只是 CI 红了一次。
2. 自检新增 `make_stub_src`：造一棵最小的假源码树（含一个真 git 仓库，
   好让 `engineVersion` 仍是一个真 sha 而不是 `unknown` —— 后者会让 fragment 的
   语义悄悄变掉），三处 case runner 全部改用它，并订正那句已经不成立的注释。

# 反向验证（复现门禁条件）

在 `/tmp/platform-backlog/nosub` 造了一份树：`vendor/whisper.cpp` 是**空目录**，
其余全部软链回本仓（**共享工作树一个字节没改**，PROTOCOL §10）。
在那棵树上跑 `pnpm test:ci-scripts` → **全绿**，`selftest-build-whisper` 22/22。

# 值得记的一条

**这次是那个自检自己救了自己**：如果我没有先修掉 §6.2 那个
「`bad` 被 `$( )` 吞掉、`fail` 在子 shell 里丢掉」的假绿，
这三条红会表现为「①② 两节一条断言都没打印，但脚本报 `✔ N passed, 0 failed`」——
**门禁会是绿的，而 build-probe.sh 的调用在 CI 上从来没跑成功过。**
我会一直以为它是对的，直到某天有人去读日志。

---

## 两处对上一封的订正

1. **§4.3 里我写「我倾向先修 ggmlAbi 探测再补目录」——那句话的前提是错的。**
   再去看了一遍：`build-whisper.sh` 的 ABI 是从**文件名**里取的
   （`libggml.so.<x.y.z>` / `libggml.<x.y.z>.dylib`），而 **Windows 的 `ggml.dll`
   文件名里根本没有版本号**。所以这不是一个"glob 写窄了"的 bug，是**结构上取不到**。
   → 换目录时那一格只能另找来源（whisper.cpp submodule 的 ggml 版本）或手填。
   **我没有改它**，也不再建议"先修探测"——那是一句没查清就说出口的话。

2. **`whispercpp-vulkan-win-x64` 的 artifact 我最终没下下来**（两次都超时），
   所以它**不在**清单里，sha256 我一个字都没写。

## build-backends run 31155359839 的最终状态

七条腿 success；`windows-x64-cuda` 到写这封时**仍在跑**（已 ~50 分钟，
它是矩阵里最慢的一条）。**因此 `merge-manifest` 还没跑**，
而这不影响 §4.2 那四个资产 —— 它们各自的腿都已经 success 并产出了 artifact。
如果 CUDA 那条最终红了，那是它自己的事（我们不发 Linux/Windows CUDA 包），
但请注意 `merge-manifest` 会因此 skipped —— **这是 C4 的设计，不是缺陷**。

---

## [2026-08-07 16:30] T-167 ③ —— `backlog-work` §3 里平台/CI 那几条的处置

| §3 编号 | 项 | 我做了什么 |
|---|---|---|
| A-4 | `openmemo-probe` 没有分发通道 | 🟡 **机制做完了、CI 实测过了，卡在 release**。本文件 §1/§4 |
| A-5 | `ytdlp-macos-arm64` 装的是 universal2 却声明 `arch:"arm64"` | ⏸ **刻意没动**，理由见下 |
| C-17 | Vulkan 补目录 | ✅ **已完成**（`8cb3b35`，`runner-migrate` 做的）。我复核过：目录里那条指向 `backend-packs-2026.08.07`，`availability` 不是 `pending-ci` |
| C-21 | GitHub 仓库描述 / topics | ⛔ 没碰 —— 改仓库设置是对外动作，与"不建/改/删 release"同一类 |
| C-24 | 「HEAD 从未跑过 CI」 | ✅ **不再成立**：`ci.yml` 现在 `on.push` 自动触发，本轮我这几个提交各触发一次（含一次真红一次真绿，见上一条） |
| B-16 | ANE 真机验证 | ⛔ 没碰（`pack-publish` 的地盘，需要一次 macOS runner 上的转写） |
| B-13 | `hf-mirror` 口径 | ⛔ 没碰（`model-mgmt` 的地盘） |

## A-5 为什么刻意没动

两条：

1. **它不是一个"改一个字就对"的错。** `yt-dlp_macos` 确实是 universal2，
   所以 `arch:"arm64"` 这条声明**低估**了它。要"修对"有两条路：
   ① 把 displayName 里那句「macOS 通用二进制」改成「Apple Silicon」（**收窄承诺**）；
   ② 再加一条 `ytdlp-macos-x64`（**放开支持面**）。
   ②与用户 2026-08-05「macOS Intel 我用不到」的裁定冲突，而且会造出一个
   **只有 yt-dlp 装得上、转写引擎一个都没有**的平台格 —— 那比现在更误导人。
   ①是对的，但它是**产品口径**不是 bug 修复。
2. **本轮 `vendor/manifests/` 我一个字节没改是有意的**：那份文件此刻的状态是
   「等 release」，掺一条无关的文案改动进去，会让下一个人分不清哪些改动是发布必需的。

建议：等 §4 那次 release 落地、我补目录时，把 ①**连同**那几条一起改，一次说清楚。

---

## [2026-08-07 16:55] T-167 DONE —— CI 收尾

# ★ `build-backends` run **31155359839**（commit `3ef8734`，`legs=all`）：**9/9 全绿**

```
macos-arm64-cpu    success      macos-arm64-metal  success
linux-x64-cpu      success      linux-x64-vulkan   success      linux-x64-cuda    success
windows-x64-cpu    success      windows-x64-vulkan success      windows-x64-cuda  success
merge-manifest     success      ← 八条腿全绿它才跑（C4 的设计）
```

**Windows / macOS 那五条腿本轮重跑了**，因为我这轮的改动会影响它们（探针打进包里）——
这正是任务书说的那个条件。它们的定义我一个字没改，跑出来全绿。

`ci.yml` 门禁在 HEAD（`d32d2c5`）上 **success**。

# 本轮全部提交

```
3ef8734  feat(ci): 探针随包出厂 + macOS 部署目标守卫 (T-167 ①)
70ccfed  docs: T-167 探针分发的三条阻碍 + D-11 §9（回执）
7bb6d2a  fix(ci): 门禁刻意不拉 submodule，而探针那一步开始真的读它了
8cf0294  docs: T-167 追加 —— 我把门禁打红了 25 分钟
d32d2c5  docs: T-167 ③ —— §3 里平台/CI 各条的处置
```

# 还在你手上的四件事（不变）

1. 建 tag `backend-packs-2026.08.07b` + 上传 §4.2 那 4 个资产（清单已备好，sha256 本机复算过）。
2. Linux / Windows 的核心包换不换成我们自己的构建（§4.3）—— 探针到那两个平台的唯一通路。
3. Windows CUDA 那条：先修 §3.2 的 `backendDir` 单值缺口，还是换我们自建的 138 MB 窄包。
4. `00-CHARTER.md` §3 的补丁（§5，全文已写好）。

---

## [2026-08-07 17:40] T-167 ② 换目录 DONE —— release 已落地，三条裁决全部执行

# TL;DR

| 裁决 | 状态 |
|---|---|
| ① Linux / Windows 核心包换成自建 + ADR-015 补例外 | ✅ **做完**，提交 `ec29792`。判据本机走产品真实路径验到了 |
| ② Windows CUDA 先不动，状态记进 D-11 | ✅ **记了**（D-11 §9.7），原话是「可能已经好了，但验不了」 |
| ③ `00-CHARTER.md` §3 补丁 | ✅ **全文已发给你**（本文件 §5 的更新版），我没有改那个文件 |

门禁：`pnpm -r test` **1270 / 0** · `tsc -b` 0 · `eslint` 0 · `test:ci-scripts` 全绿。

# §11 release 复核：**我自己重下复算的，没抄转达值**

```
$ env -u GITHUB_TOKEN -u GH_TOKEN -u GH_ENTERPRISE_TOKEN curl -sSL <4 个资产>
$ sha256sum -c expected.txt        # expected.txt 是我上一封那张表
whispercpp-cpu-linux-x64.tar.gz:    OK      6,752,275 B
whispercpp-vulkan-linux-x64.tar.gz: OK     29,499,386 B
whispercpp-cpu-macos-arm64.tar.gz:  OK      2,015,162 B
whispercpp-cpu-win-x64.zip:         OK      3,951,207 B
exit=0
```

# §12 ★ 判据本身：**走产品真实路径，第一次真的成立**（Linux x64）

真的东西：真 manifest 条目（改完的 `backends.json`，一个字没再动）、真 `install()`
（分片下载 → 校验 sha256 → 解包 → 硬链）、真 release URL（不带任何凭证）、
真 `resolveRuntimeLayout()`、真 `runProbe()` 子进程。
假的东西：**没有**。数据目录是 `mkdtemp`，**不启 daemon、不写指针**（PROTOCOL §9-bis）。

```
url  .../releases/download/backend-packs-2026.08.07b/whispercpp-cpu-linux-x64.tar.gz
install() → 1 个文件，4.6s
resolveRuntimeLayout()  probeExists = true
                        probePath   = <models>/by-name/backend/whispercpp-cpu-linux-x64/openmemo-probe
                        backendDir  = <models>/by-name/backend/whispercpp-cpu-linux-x64
runProbe()              ok = true   ggml 0.15.1 / f049fff9   deviceCount = 1
                          - CPU / CPU / type=cpu / software=false
自检 hw.probe           status=ok  detail='1 个设备, ggml 0.15.1'
                        ← 换目录之前这一行是 warn「openmemo-probe 未安装（后端能力未知）」
findInBackendPacks(whisper-cli) = <models>/by-name/backend/whispercpp-cpu-linux-x64/whisper-cli
                        ← 换了包不能把引擎弄丢，这条是专门验它的
```

⚠️ **只在 Linux x64 上。** Windows / macOS 同一条链 `[未验证]` ——
已触发 `cold-start-audit` run **31160171438**，判据仍是
「屏蔽宿主 PATH 的干净机器上真的转出非空文本」。**拿到之前我不声称那两格成立。**

# §13 改了什么（逐条）

`backends.json` / `components.json` **各 4 条**，其余 8 / 21 条一个字节没动
（用 `git show HEAD:` 逐个 JSON 反序列化比对确认，不是看 diff 行数）。

| id | 之前 | 现在 |
|---|---|---|
| `whispercpp-cpu-linux-x64` | 上游 `whisper-bin-ubuntu-x64.tar.gz` 9,379,235 B | 自建 6,752,275 B |
| `whispercpp-cpu-win-x64` | 上游 `whisper-bin-x64.zip` 7,982,101 B | 自建 3,951,207 B |
| `whispercpp-cpu-macos-arm64` | 自建（`backend-packs-2026.08.06`） | 新 tag，2,015,162 B |
| `whispercpp-vulkan-linux-x64` | 自建（`backend-packs-2026.08.07`） | 新 tag，29,499,386 B |

`providesFiles` 不是抄 CI fragment 的：我把四个归档**解开逐条列出来**与 fragment 比对过，
差异恰好只有 8 个 soname 软链（按既有约定不进 providesFiles），其余逐字相同。

# §14 ADR-015 §7：例外**写下来了**，守卫**没绕过也没改**

`docs/adr/ADR-015-upstream-first.md` 追加 §7（§0–§6 一字未改），四小节：
7.1 哪四个 id · 7.2 依据（探针为什么只能由我们放进包里，三条实测事实）·
7.3 **代价与未知逐条列出** · 7.4 守卫怎么办。

7.3 里点名写着你要的那两个数字与它们的成因/未知：

- `9,379,235 → 6,752,275`（小 2.6 MB）：可见成因是我们跑了 `strip --strip-unneeded`；
  **`UNKNOWN`：上游包里 `ggml-cpu-*` 变体有几条我没下下来数过**（我们 14 条）。
- `7,982,101 → 3,951,207`（小 4 MB）：我们 **10 条** `ggml-cpu-*.dll`；
  **`UNKNOWN`：上游那个有几条我没数过**。ggml 按 CPU 特性挑变体，少一条只会退到更保守的那条。

另外四条未知也在：`ggmlAbi` 在 Windows 上**结构性取不到**（`ggml.dll` 文件名没有版本号，
我填的 `0.15.1` 是**推断值**，来自同一 commit 同一轮构建的兄弟包）；端到端未重跑；
VC++ 那一格**换包既没改善也没恶化**；升级检查的语义变成「有更新 = 该重建了」。
同一份内容重复在两条 `sha256Provenance` 里 —— 那才是用户在「组件与来源」页看得到的地方。

## 守卫

`merge-backend-manifest.mjs` 那条 ADR-015 规则按**「现有条目有没有真 URL」**判定，
**不按 URL 属于谁**。所以这次替换**不触发也不削弱它**：换完之后目录里那条仍然有真 URL，
CI fragment 仍然是 `pending-ci`，规则原样生效。`selftest-ci-manifest.mjs` ④ 一个字没动。

新守卫另起一个文件 **`apps/daemon/src/pipeline/probeShipping.test.ts`**（5 条，
刻意不改 `platformPacks.test.ts` / `ffmpegPinRot.test.ts` / `ffmpegStableOnly.test.ts`）：

| # | 断言 |
|---|---|
| ① | 每个我们自己托管的 whisper 包都必须提供 `openmemo-probe`（Windows 是 `.exe`） |
| ② | 每个能装 whisper 引擎的**平台**至少有一个包带探针 |
| ③ | 四个例外 id 必须各自把「为什么例外」写在 `sha256Provenance` 里（≥300 字且提到 ADR-015 或探针），且 `releaseUrl` 与字节来源一致 |
| ④ | 白名单里不许躺着一个已不存在的 id |
| ⑤ | 例外 id 的下载地址必须是我们 release 的资产 |

⚠️ 一条设计决定：**探针文件名在守卫里刻意写死字面量，不 import `probeBinaryName()`。**
T-144 那条 bug 正是「产出方与使用方用了两个名字」；如果守卫 import 实现，
实现改名时它会**跟着改名并继续报绿** —— 判据必须独立于被测者。

## 反向验证 6/6（含对照组），跑在 `/tmp` 隔离副本（PROTOCOL §10）

| 变异 | 结果 | 红在哪（真实输出） |
|---|---|---|
| 对照组（不变异） | ✔ 全绿 | 不绿则整条验证作废 |
| 拿掉 Linux CPU 包 providesFiles 里的探针 | ✔ exit 1 | `whispercpp-cpu-linux-x64 的 providesFiles 里没有 openmemo-probe` |
| 把 Windows 包改回上游地址（"顺手统一回 ADR-015"） | ✔ exit 1 | `下载地址不是我们 release 的资产：https://github.com/ggml-org/…` |
| 抹掉例外理由 | ✔ exit 1 | `它的字节由我们自己托管…但 sha256Provenance 没有（或只有一句敷衍的）说明，实得 5 字` |
| 白名单塞一个不存在的 id | ✔ exit 1 | `…已经不存在了 —— 别让白名单变成一张没人看的免死金牌` |
| `releaseUrl` 指回上游（字节是自建的） | ✔ exit 1 | `两者对不上，用户查来源会被带偏` |

# §15 ② Windows CUDA：状态记进 D-11 §9.7，**没动它**

原话：

> 🟡 **在有 NVIDIA 驱动的 Windows 上"应该"可装且可用，但没有任何人在真硬件上看到过。**
> 要收这一格，**必须一台带 NVIDIA GPU 的 Windows**，CI 替代不了。

同时如实记了：它是上游包、**没有探针**，装上之后会落进 §9.3 那个 `backendDir` 单值缺口
（会被报成 `driver missing or too old` —— 一句具体的、错的诊断）。
以及**刻意不做**换我们自建窄包（`--cuda-arch 86;89` 比上游 fat 包窄）的理由。

⚠️ **那个缺口从今天起不再是假设**：目录里现在真的同时有 Linux CPU 包与 Vulkan 包了。
已转 `daemon-backlog`。

# §16 纪律（本轮追加部分）

- **仍然没有建 / 改 / 删任何 release，也没有 dispatch `release-upload.yml`。**
  release 是你建的、你传的；我只做了「匿名重下 + 本机复算」。
- 本轮 `gh` 新增用到：`workflow run cold-start-audit.yml`（一次 dispatch）。
- `:10000` 零请求 · `/root/data-memo` 与指针未碰 · `apps/web/dist` 未构建 · 无 `pkill` ·
  本机零 whisper 转写（跑过的二进制只有 `openmemo-probe`，只读枚举）。
- **`git add` 逐个文件**，提交前用 `git diff --cached --name-only` 与
  「反序列化后逐 id 比对」两道核对过：`backends.json` 只有 4 个 pack 变了，
  `components.json` 只有 4 条变了，条目总数 12 / 25 都没变。
- 反向验证在 `/tmp/platform-backlog/` 与 `mkdtemp`，共享工作树没有坏过一秒。

# §17 还开着的（都标了未验证，没有装绿）

| 项 | 状态 |
|---|---|
| Windows / macOS「干净机器 → 真的转出非空文本」（换包之后） | ⏳ `cold-start-audit` run **31160171438** 跑着，**结果没拿到** |
| `backendDir` 单值缺口 | 🔴 未修，已转 `daemon-backlog`。**今天起不再是假设** |
| Windows CUDA 在真 N 卡上到底行不行 | ⚠️ `UNKNOWN`，**需要真硬件**，CI 结构上验不了 |
| 上游两个包各有几条 `ggml-cpu-*` 变体 | ⚠️ `UNKNOWN`，没下下来数 |
| `whispercpp-cpu-win-x64` 的 `ggmlAbi` | ⚠️ **推断值**，不是量出来的（已写进 ADR-015 §7.3） |

---

## [2026-08-07 18:30] T-167 ② 收尾 —— 三平台冷启动实测拿到了

# ★ 判据在 CI 上成立了（Windows 那一格我本机验不了，现在有真机数据）

`cold-start-audit` run **31160171438**（`ec29792`，换包后）对比
run **31152458527**（`8cb3b35`，换包前）—— **同一个 workflow，两轮只差目录里那四条**。

| 平台 | `hw.probe` 换包前 | `hw.probe` 换包后 | 适用包 | 转写 |
|---|---|---|---:|---|
| **linux-x64** | `warn` openmemo-probe 未安装（后端能力未知） | ✅ **`ok` 1 个设备, ggml 0.15.1** | 6 → 6 | succeeded 2.1s，108 字符 |
| **win32-x64** | `warn` openmemo-probe 未安装（后端能力未知） | ✅ **`ok` 1 个设备, ggml 0.15.1** | 5 → 5 | succeeded 3.7s，108 字符 |
| **darwin-arm64** | `warn` openmemo-probe 未安装（后端能力未知） | 🟡 **`warn` probe timed out after 10000ms** | 5 → 5 | succeeded 111.8s，108 字符 |

三平台都是「产品自己下载并校验的 (5) · 借宿主 PATH 的 (0) · 装不上/不可用 (0)」。
**换包没有弄坏任何东西** —— 这是 §17 那条「Windows/macOS 端到端未验证」的答案。

> 顺带回答一句我上一封没敢说的话：**「网页检测硬件」这一步在 Linux 与 Windows 上
> 今天第一次真的有答案了**。此前它在三个平台上全部是「未安装（后端能力未知）」。

# 🟡 但 macOS 冒出一条**新的**：探针找到了，然后超时

**不是回归。** 换包前那台机器上根本没有探针（报"未安装"）；现在它在包里、
被解析到、被启动了，**然后 10 秒没返回**。两次自检两次都超时 ——
`CIRCUIT_BREAKER_THRESHOLD = 2`，所以断路器会跳闸。

- ⚠️ **`UNKNOWN`：成因没有定性。** 最可能是加载 `libggml-metal.so` 时的 Metal 设备初始化，
  而那台 runner 是**虚拟化的 3 核 M1**（同一轮转写要 111.8s，Linux 只要 2.1s，53 倍）。
  我**分不清**「10 秒对这台 runner 太短」「虚拟化 macOS 上 Metal 初始化会挂」
  与「真有 bug」，日志里没有探针的 stderr。**要一台真 Mac 才能定性。**
- **刻意不做**：不去调大 `PROBE_TIMEOUT_MS`（ADR-003 决策 3 定死的 10 秒）。
  把一个常量改大让 warn 消失，会把「探针挂了」伪装成「探针慢」，而两者的处置完全不同。
  而且那是 `packages/runtime`，不是我的地盘。
- **实测到的后果边界**：断路器拉黑的是加速后端，但 macOS 的 `metal` 走
  `isAlwaysApplicable`（"看起来像 L2、行为像 L1"），所以 Metal 包仍可装，
  这一轮转写也照常成功。**没有观测到用户可见的损坏。**

已写进 **D-11 §9.8**（含换包前后的对照表）。

# 全部提交（T-167）

```
3ef8734  feat(ci): 探针随包出厂 + macOS 部署目标守卫
70ccfed  docs: 探针分发的三条阻碍 + D-11 §9
7bb6d2a  fix(ci): 门禁刻意不拉 submodule，而探针那一步开始真的读它了
8cf0294  docs: 我把门禁打红了 25 分钟
d32d2c5  docs: §3 里平台/CI 各条的处置
f511494  docs: build-backends 9/9 全绿
ec29792  feat(catalog): 四个 whisper 包换成带探针的自建产物（ADR-015 §7 例外）
ea4d911  docs: 换目录回执
bdbae5f  docs(D-11): §9.8 换包前后三平台冷启动对比
```

门禁：`pnpm -r test` **1270 / 0** · `tsc -b` 0 · `eslint` 0 · `test:ci-scripts` 全绿 ·
`ci.yml` 在 `ea4d911` 上 success · `build-backends` **9/9** · `cold-start-audit` **3/3**。

# 剩下的（一条都没装绿）

| 项 | 状态 | 归属 |
|---|---|---|
| macOS 探针为什么超时 | ⚠️ **`UNKNOWN`，需要真 Mac** | 待定 |
| `backendDir` 单值缺口 | 🔴 未修，**今天起不再是假设**（目录里已经同时有 CPU 与 Vulkan 包） | `daemon-backlog` |
| Windows CUDA 在真 N 卡上行不行 | ⚠️ `UNKNOWN`，**需要真硬件**，CI 结构上验不了 | 需要硬件 |
| 上游两个包各有几条 `ggml-cpu-*` 变体 | ⚠️ `UNKNOWN`，没下下来数 | 我 |
| `whispercpp-cpu-win-x64` 的 `ggmlAbi` | ⚠️ **推断值**（`ggml.dll` 文件名无版本号，结构上取不到） | 我 |
| `00-CHARTER.md` §3 补丁 | ⏳ 全文已发你，**我没改那个文件** | 你 |
