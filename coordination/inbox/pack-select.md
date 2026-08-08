# inbox / pack-select

## [2026-08-07 12:15] T-162 DONE —— 加速包装上之后终于会被真的调用

---

# TL;DR（Manager 只读这里）

**`findInBackendPacks()` 从"看 `readdir` 心情"改成"按用户的选择 → `priority` → 确定的字典序"。**
`amd-vulkan` §1.3 那条实测（装了 Vulkan 包跑的还是 CPU 包的 whisper-cli，两种安装顺序结果相同）
在改后不再成立；Windows 的 CUDA 包同一条也一起解掉。

| #   | 事                                                                             | 状态 | 撤掉后变红？     |
| --- | ------------------------------------------------------------------------------ | ---- | ---------------- |
| ①   | 候选按 `readdir` 顺序取第一个 → 改成三层确定排序                               | ✅   | ✅ M1 红 10 条   |
| ②   | `selectedBackend` 是装饰品（只驱动两个徽章） → 现在真的决定跑哪个包            | ✅   | ✅ M2 红 5 条    |
| ③   | `BackendPack.priority` 11 条声明 **0 个读取方** → 抄进安装记录并成为兜底排序键 | ✅   | ✅ M3/M7 红 3 条 |
| ④   | 选中的包缺文件 → **显式决定：回退并出声**（不是沿用现状，也不报错）            | ✅   | ✅ M4 红 2 条    |
| ⑤   | 那句错注释 "newest first" → 订正，并把原文保留在原地                           | ✅   | —                |
| ⑥   | 「跑的是哪个包」现在能从自检 / daemon 日志看出来                               | ✅   | ✅ M4            |

**门禁**：`pnpm -r test` **1202 pass / 3 fail** · `tsc -b` 0 · `eslint`（我的 14 个文件）0。
⚠️ **那 3 条红不是我的**，是共享树里两位在途 agent 的半成品，证据在 §6 —— 我复核到了具体断言。

**⚠️ 判据边界（按你的要求写在最前）**：`amd-vulkan` 说这台机器上没有任何真实 GPU，
**我自己复验了**：`systemd-detect-virt=kvm`，`/sys/class/drm`、`/dev/dri`、`/dev/kfd` 全不存在，
`/proc/devices` 里 0 个 drm。**所以本机无法端到端验证"GPU 后端真的被用上了"**。
本轮判据一律退到可验证的那一层：**解析器选中了哪个包**（用两个假包在本机验，正反都验）。
"选中的包真的跑出了 GPU 加速"——`[无法在本机验证]`，需要一台有 GPU 直通的机器。

**未提交**（§7）：`apps/daemon/src/http/rest/state.ts` 里**同时有我和 T-164 那位的改动**，
`git add` 会把别人的半成品一起带走。要我提交就说一声，我按文件挑。

**需要 Manager 决策**：2 条，见 §8（`runBackendSelfTest` 仍不接受 pack id；老安装记录的 priority 回填）。

---

# §1 定性：`findInBackendPacks()` 现在被谁调用（改之前先摸清楚）

`gates-fix` 把 whisper-cli 与 probe 都归一到它之后，它是**唯一**的解析器。全仓调用点 5 处、
跨 3 个包 2 个进程：

| #   | 调用方                                                          | 找什么                                                                | 影响                                                    |
| --- | --------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------- |
| 1   | `packages/pipeline/src/tools.ts` `discoverTools()`              | ffmpeg / ffprobe / whisper-cli / whisper-vad-speech-segments / yt-dlp | 整条转写链                                              |
| 2   | `apps/daemon/src/runtime/setup.ts:229` `resolveRuntimeLayout()` | `openmemo-probe`                                                      | 硬件探测 + `backendDir`（ggml 从二进制同级目录 dlopen） |
| 3   | `apps/daemon/src/runtime/setup.ts:644` `runBackendSelfTest()`   | whisper-cli                                                           | `POST /api/backends/selftest`                           |
| 4   | `apps/daemon/src/http/rest/selfcheck.ts:105`                    | `openmemo-probe`                                                      | `GET /api/selfcheck`                                    |
| 5   | `scripts/selfcheck.mjs:279`                                     | `openmemo-probe`                                                      | CLI 自检（**拿不到 `RestState`**）                      |

第 5 条决定了这次的接口形状 —— 见 §3。

---

# §2 选择规则，逐条给依据（不是"随便定个顺序"）

排序键是三层，**每层都确定**：任何一层留成 `readdir` 顺序，这个函数就又变回看文件系统心情。

| 层  | 键                                                          | 依据                                                                                                                                                                                                                                   |
| --- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | **扁平命中最先**（`by-name/backend/<name>`）                | 它不是搜索是查表：安装器写的就是这个精确位置，而且只有"包本身就是一个可执行文件"的包（yt-dlp）落在这里，不可能与任何 whisper 包争同名。T-132 的回归守卫钉的就是它，我留着没动                                                          |
| 1   | **用户选中的后端**（`prefs.selectedBackend`）对应的包       | `POST /api/backends/select` 是产品里**唯一**一处"用户表达后端偏好"的入口。在此之前它只驱动 `recommended` / `active` 两个徽章（`amd-vulkan` §1.3 推论 2 说的"装饰性"）。**用户能改的东西必须真的管事**                                  |
| 2   | **`priority` 降序**                                         | 这正是 `BackendPack.priority` 自己的文档语义："Higher wins when several packs match the same hardware"。目录里 cuda 包 90、cpu 包 10 —— 装了加速包又没另行指定，就用加速包                                                             |
| 3   | **packId 字典序**；没有安装记录的目录整体排在最后，按目录名 | 平手时只要求**确定性**：与 `readdir` 的区别是它与文件系统、安装顺序、磁盘状态都无关，可复现可断言。无安装记录的目录是"装到一半崩在 `writeManifest` 之前"或手工解包的产物（`gates-fix` §5.2 的 A/B 分叉），**证据强度更低，所以排后面** |

## 2.1 层 2 的安全性依据（这条与 T-161 配套，缺一不可）

没选过后端时优先跑加速包，安全的前提是**加速包自包含**：T-161 起每个包都带全套 CPU 模块与
whisper-cli（CI 实测 `providesFiles` 23 个）。所以即使 GPU 不可用，ggml 也只是
`No devices found.` 退回 CPU 跑，**不会更差**。`amd-vulkan` §1.3 的建议原话就是
「两个改动是配套的」——我按这条做的，并把它写进了函数注释。

## 2.2 目录 → 包的反查按**结构**，不按关键词

证据是安装记录 `<storeRoot>/manifests/backend/<id>.json`（`InstalledBackendPack`），
不是目录名里的字符串。理由很具体：`whispercpp-vulkan-linux-x64` 只是上游今天的命名习惯，
而 `jellyfin-ffmpeg_8.1.2-2_portable_macarm64-gpl.tar.xz` 里一个后端名都没有。
按名字猜属于「同名不同物、而系统按名字工作」那一族（`tokens.txt` 互相顶掉是最近一例）。

反查用的是 `unpackDirName(files[].name)` —— 我把安装器里那个私有的 `stripExt` **导出**了，
因为它是**安装器与工具发现之间唯一的约定**：安装器用它建目录，解析器用它把目录反查回包。
两份实现必然在扩展名列表上分叉，而那份列表不可猜（`.tar.xz` **刻意不剥**，
所以 jellyfin 的 mac ffmpeg 真的解包到一个名字带 `.tar.xz` 的目录里）。

> 顺带：T-164 那位已经在用这个新导出了（他的 `state.ts` diff 里写着
> 「那是安装器与发现侧**唯一**的那份约定，不另写一份」）。

---

# §3 「选中的包缺文件怎么办」—— 显式决定：**回退，而且必须出声**

**这是决定，不是沿用现状。** 三条依据：

1. 同一个函数还在解析 ffmpeg / ffprobe / yt-dlp / openmemo-probe，它们与"选哪个后端"毫无关系；
   为 whisper-cli 报错会把不相干的工具一起打死。
2. 顶格的包缺文件恰恰是「装到一半」这个**按设计会发生**的中间态
   （安装器刻意 blob 先落、manifest 最后写）。把降级状态变成死机不是修复。
3. cpu 是 ADR-003 降级链的地板，`manager.ts` 实测记着 ggml 在加速包不可用时优雅降级
   ——"our job is not to prevent it; it is to explain it"。

**代价是"解释"这半边必须真的做到**，否则就是把同一个静默 bug 换个位置重来一遍。所以：

- `ResolvedBackendTool.degraded` 翻真；
- `buildPipeline()` 打一条 warn（实测输出）：
  ```
  [daemon] ⚠️ 已选中后端 vulkan，但 whisper-cli 来自 whispercpp-cpu-linux-x64（backend=cpu）
           —— 选中的那个包里没有 whisper-cli，已退回。加速不会生效。
  ```
- 自检多一条 `backend.selection`（见 §4）。

## 3.1 `degraded` **不许**对不相干的工具报警（假红灯也是 bug）

限定条件是「**同一个引擎**」（`InstalledBackendPack.engine`）：选了 vulkan 时 ffmpeg 来自
`media-tools-*`（engine=`ffmpeg`）是**正常**的。不加这一格，`degraded` 会对每一个工具都喊一声，
而「一条会对不相干的东西发表意见的检查，说对的时候也不该被相信」。有专门一条用例钉它。

来源不明的目录（没有安装记录）一律**不**声称降级 —— 无从判断时不下结论，「我拿不到」≠「这里没有」。

---

# §4 「能看出当前用的是哪个」

`[本机实测]` 同一份布局、只改 `prefs.json`，跑真实的 `scripts/selfcheck.mjs`（CLI 那个出口）：

```
### 选中 vulkan
  ✔ 实际生效的后端包      选中 vulkan → 实际使用 whispercpp-vulkan-linux-x64（backend=vulkan）
  ✔ whisper-cli          .../by-name/backend/whispercpp-vulkan-linux-x64/whisper-cli

### 选中 cpu（磁盘一个字节没动）
  ✔ 实际生效的后端包      选中 cpu → 实际使用 whispercpp-cpu-linux-x64（backend=cpu）
  ✔ whisper-cli          .../by-name/backend/whisper-bin-ubuntu-x64/whisper-cli

### 选中 vulkan，但 vulkan 包里没有 whisper-cli
  ! 实际生效的后端包      选中 vulkan → 实际使用 whispercpp-cpu-linux-x64（backend=cpu）
```

新检查项 `backend.selection` 在 `packages/runtime/src/selfcheck.ts`，**daemon 与 CLI 两个出口都接了**
（T-148/T-149 立的规矩：两个出口必须给同一个答案，`--daemon` 的逐 id 比对会当场抓漂移）。
探针没接时按 `probePath` 的先例走 `notProbed()` —— **这一项照常出现**，如实说"未探测"，
因为「少一项」和「这一项通过了」在报告里长得一模一样。

---

# §5 反向验证：8 条变异，**存活 0 条**（全部跑在 `/tmp/pack-select/rv`，PROTOCOL §10）

隔离副本 = 各包 `dist` + `package.json` + 包内 `node_modules`（相对软链，在副本内闭合），
根 `node_modules` / `vendor` 软链回真仓库。**共享工作树全程未被改动**，脚本留在
`/tmp/pack-select/rv.mjs`（可重跑），锚点是源文本、必须唯一，找不到就当场报错不猜。

**先跑对照组**（不先证明这一点，下面每一条红都不证明任何事）：

```
=== ⓪ 对照组：未变异的副本必须全绿
  ✔ pipeline: exit=0 pass=14 fail=0
  ✔ daemon:   exit=0 pass=9  fail=0
```

| 变异（撤掉什么）                                            | 结果                                         | 红在哪（节选真实输出）                                                                         |
| ----------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **M1** 回到缺陷原状：不排序、不看偏好                       | ✔ 红 pipeline **fail=8** / daemon **fail=2** | `✖ ★ 同一份磁盘布局：选 vulkan 跑 vulkan 包，选 cpu 跑 cpu 包`、`✖ 安装（创建）顺序不影响结果` |
| **M2** 只拿掉「用户选择优先」这一档（`priority` 仍在）      | ✔ 红 4 / 1                                   | `✖ 显式选择压过 priority（选了低优先级的那个，就跑它）`                                        |
| **M3** 只拿掉 `priority`（同层按 packId 排，确定性还在）    | ✔ 红 2                                       | `✖ ★ 同一份布局：priority 90 的包赢；把两个 priority 对调，答案就反过来`                       |
| **M4** `degraded` 恒 false（只回退不出声）                  | ✔ 红 1 / 1                                   | `✖ ★ 选了 vulkan，但 vulkan 包里没有 whisper-cli → 用 cpu 包的，degraded=true`                 |
| **M5** 读取侧自己拼 prefs 路径（写读分叉）                  | ✔ 红 3 / 3                                   | `✖ ★ 走 RestState 自己的 persistPrefs()，readSelectedBackend() 必须读得到`                     |
| **M6** 键名分叉（读 `.backend` 而不是 `.selectedBackend`）  | ✔ 红 3 / 3                                   | 同上                                                                                           |
| **M7** 安装记录不抄 `priority`                              | ✔ 红 1                                       | `✖ ★ 拿真实目录里的每一条包过一遍 toInstalledRecord()，priority 必须逐条相等`                  |
| **M8** `unpackDirName` 变成恒等（安装器与解析器的约定断掉） | ✔ 红 **11**                                  | 目录全部变"来源不明"，偏好与 priority 一起失效                                                 |

## 5.1 变异打准了没有 —— 这一条要单独说

`amd-vulkan` 的实测是「**两种安装顺序结果相同**」，所以"能找到一个"这种用例钉的是零。
主用例的形状因此是：**同一份磁盘布局、只改偏好，两次必须给出不同的答案**。
`readdir` 的返回顺序在两次调用之间是同一个，所以**任何按顺序取第一个的实现都不可能让它们同时成立**；
反过来，一条只断言"vulkan 赢"的用例在"按名字倒序"这种实现上照样绿。
M2 / M3 是分辨力的证据：它们各自只拿掉一层排序、**保留其余两层**，粗糙的用例抓不到，而这里都红了。

另有一条「平手时排的是 packId 还是目录名」的用例，故意让两者反序 —— 否则那条断言无分辨力。

## 5.2 我自己踩到并如实记下的一条

第一版 M8 是「让 `unpackDirName` 顺手把 `.tar.xz` 也剥掉」，**它存活了**。
追下去发现是**等价变异**：origins 表同时用 `unpackDirName(name)` 与 `name` 本身做键，
而 `.tar.xz` 的解包目录名恰好**等于**归档名，所以第二个键把它兜住了。
换成「`unpackDirName` 变成恒等」（这才让 zip/tar.gz 失去反查）之后红了 11 条。
—— 记下来是因为：**一条存活的变异不一定说明测试不够，也可能说明那条变异什么都没改。**

---

# §6 那 3 条红为什么不是我的（PROTOCOL §10：撞上红灯先判断归属）

跑门禁期间共享树里**至少两位 agent 在途**。我逐条追到了断言：

| 红                                                      | 归属证据                                                                                                                                                                                                                                           |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `T-164 ⑥ 删模型必须真的回收磁盘` 2 条                   | 测试文件 `apps/daemon/src/http/rest/modelDiskReclaim.test.ts` 是**未跟踪的新文件**，不是我建的；断言 `磁盘只少了 4195197 字节，应当少 4194304` —— 差 893 字节，是他正在收的尾                                                                      |
| `T-146 ③ 两份清单里同一个 id 的体积与摘要必须一致` 1 条 | `media-tools-macos-arm64` 在 `components.json` 是 32,894,656（刚改成 8.1.2），`backends.json` 还是 31,063,636（7.1.4）。**`backends.json` 我没碰、`git status` 也显示它未修改** —— 这是 T-163 那位在执行 `amd-vulkan` §2.3 的 macOS 决策，改了一半 |

**中途还撞到过一次 24 条红**（含我自己的用例）：成因是那一刻 `vendor/manifests/components.json`
**正处于半写状态、不是合法 JSON**（`SyntaxError ... position 11863`，所有加载目录的套件一起挂）。
几分钟后再校验已经 VALID，重跑降到 3 条。
→ 我没有把它当成"自己的 bug"去改代码，也没有去动别人的文件。**如实记在这里给下一个撞上的人。**

我的 10 个 T-162 套件在最终那次门禁里**全绿**（pipeline 5 组 14 条、daemon 4 组 9 条）。

---

# §7 交付文件（**未 commit**，理由在下面）

改（12）：

```
packages/pipeline/src/tools.ts             ★ 主体：resolveBackendTool / findInBackendPacks
                                              + readSelectedBackend / backendPrefsPath
                                              + 订正那句 "newest first"（原文保留在原地）
packages/pipeline/src/index.ts             导出上述
packages/downloader/src/installer.ts       stripExt → 导出的 unpackDirName（唯一的那份约定）
packages/shared/src/backends.ts            InstalledBackendPack.priority?（可选，老记录无此字段）
packages/runtime/src/selfcheck.ts          新检查项 backend.selection + BackendSelectionInfo
packages/runtime/src/index.ts              导出该类型
apps/daemon/src/http/rest/backends.ts      抽出 toInstalledRecord()（把 priority 抄进安装记录）
apps/daemon/src/http/rest/state.ts         prefsFile 改用 backendPrefsPath（⚠️ 与 T-164 共用此文件）
apps/daemon/src/http/rest/selfcheck.ts     接 backendSelection 探针（daemon 出口）
apps/daemon/src/pipeline/setup.ts          bundle.whisperCliOrigin + 降级 warn
apps/daemon/src/runtime/setup.ts           导出 whisperCliName()（两处别各写一份字面量）
scripts/selfcheck.mjs                      接 backendSelection 探针（CLI 出口）
```

新增（2）：

```
packages/pipeline/src/__tests__/backendSelect.test.ts     14 条（解析规则本身）
apps/daemon/src/pipeline/backendSelectWiring.test.ts       9 条（两头的接线 + 自检出口）
```

**为什么没有 `git add`**：`apps/daemon/src/http/rest/state.ts` 的当前 diff 里
**同时有我的 9 行和 T-164 那位的 58 行**（`byModelDir` / `resolveInstalledFile` / 删模型回收硬链）。
按文件 `git add` 会把他没写完的东西一起带走。**Manager 已裁定等三路都交付后统一分拆提交**，
我不再动树。

## §7-bis `state.ts` 里**哪几行是我的** —— 逐 hunk 归属（供提交信息署名用）

`git diff --numstat` 说这个文件是 **67 插入 / 2 删除**。七个 hunk 全部认领完，**没有一行悬空**：

| hunk 头                | 内容                                                                                                           | 归属            | 增/删   |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- | --------------- | ------- |
| `@@ -13 +13 @@`        | `import { backendPrefsPath, resolveStoreRoot } from '@openmemo/pipeline';`（原文只 import `resolveStoreRoot`） | **T-162（我）** | +1 / −1 |
| `@@ -21,0 +22,2 @@`    | 在 `@openmemo/downloader` 那个 import 块里加 `resolveInstalledFile` / `unpackDirName`                          | T-164           | +2      |
| `@@ -52,0 +55 @@`      | `import { byModelDir } from '../../pipeline/modelStore.js';`                                                   | T-164           | +1      |
| `@@ -181,0 +185,7 @@`  | `prefsFile` getter 上方 7 行注释（「路径由 `@openmemo/pipeline` 定义，这里只是引用」）                         | **T-162（我）** | +7      |
| `@@ -183 +193 @@`      | `return path.join(this.modelsRoot, 'prefs.json')` → `return backendPrefsPath(this.modelsRoot)`                 | **T-162（我）** | +1 / −1 |
| `@@ -345,0 +356,53 @@` | `dropInstalledFiles()` 整个方法 + 其文档注释                                                                   | T-164           | +53     |
| `@@ -347,0 +411,2 @@`  | 删除流程里调用 `dropInstalledFiles(id)` 的两行                                                                 | T-164           | +2      |

**一句话版本**：`state.ts` 里属于我的是「**引用 `backendPrefsPath` 的那 9 行**」——
一行 import、一行 getter 主体、加上它上面那 7 行说明为什么不许各写各的字面量。
**其余 58 行全部是 T-164 的删模型磁盘回收。**

### ⚠️ 分拆提交时有一条**顺序约束**（不是偏好，是编译约束）

T-164 的那段 import 里有 **`unpackDirName`** —— 那是我这轮**新导出**的
（`packages/downloader/src/installer.ts`，原本是私有的 `stripExt`）。
所以：**`packages/downloader/src/installer.ts` 必须与 T-164 的提交同批或更早落地**，
否则 T-164 那一笔单独 checkout 出来 `tsc -b` 会红在"`unpackDirName` 不存在"。

（这也说明那个导出不是我一个人在用：他的注释原话是「那是安装器与发现侧**唯一**的那份约定，
不另写一份」—— 两路独立得出同一个结论，这条约定值得写进 HANDOFF。）

`tsconfig.test.json` 的登记要求：**本轮没有新增 `apps/web` 下的测试**，
两个新测试分别在 `packages/pipeline/src/__tests__/` 与 `apps/daemon/src/pipeline/`，
两个包的 tsconfig 都是 `include: ["src/**/*"]`，且各自的 test 脚本前置守卫会数
「源码里几个 test 文件 = dist 里几个」——**这条守卫在本轮真的响过一次**
（另一位刚加了新测试而我还没重编，`36 source vs 35 compiled`，当场红），所以它是活的。

---

# §8 需要 Manager 决策

1. **`POST /api/backends/selftest` 仍然不接受 pack id**（`amd-vulkan` §1.3 附带那条 4）。
   现在它至少是**确定的**：跑的是"选中的那个后端的包"，而不是 readdir 抽签。
   但「给某个具体包点自测」这个语义仍然做不到 —— 路由手里没有 pack id
   （`hardware.ts:199`）。这与 `gates-fix` §5.3「自检结果没有回写 `InstalledBackendPack.selfTest`」
   是同一片，建议一起派。**我没有动它的签名**，那会牵到 REST 契约。
2. **老安装记录的 `priority` 回填**。改动之后新装的包会带上，**已经装着的不会**（按 0 处理）。
   它只在"用户从未选过后端"时才影响排序，重装该包即可回填。
   要一次性回填的话，位置在 `apps/daemon/src/storage/migrateRecords.ts` 那一族
   （与 `catalog-truth` 决策 3「老记录补 role」同形状），归 `model-mgmt`。**我没做。**

---

# §9 我没做 / 做不到的（如实列）

| 项                                  | 状态                                                                                                                                                                               |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 「选中的包真的跑出了 GPU 加速」     | ⛔ **本机验不了**：`systemd-detect-virt=kvm`，`/sys/class/drm`、`/dev/dri`、`/dev/kfd` 全不存在（我自己复验过，不是转述）。判据已按你的指示退到"选中了哪个包"                      |
| Windows / macOS 上的真实布局        | `[未验证]`。夹具用的是 `backends.json` 里逐字抄的归档名，win 的 `.zip` 与 mac 的 `.tar.xz` 两种扩展名规则都被 M8 覆盖到了，但没有在真机上跑过                                      |
| `runBackendSelfTest` 按 pack 自测   | ⛔ 见 §8-1                                                                                                                                                                         |
| 老记录 priority 回填                | ⛔ 见 §8-2                                                                                                                                                                         |
| 前端把 `backend.selection` 渲染出来 | ⛔ 没碰 `apps/web`。`progress-audit` 说 `/diagnostics` 读的是 `/api/health` 而不是 `/api/selfcheck`（C6），所以这一条目前只在 `GET /api/selfcheck`、CLI 自检与 daemon 日志里看得见 |
| 把 Vulkan 包补进 `backends.json`    | ⛔ **不是我的地盘**，也不该由我做。但阻碍 3 现在消了 —— `amd-vulkan` 说的「先修解析器 → 再发包 → 再补目录」的第一步已经完成                                                        |

---

# §10 纪律申报

| 条                | 结果                                                                                                                                                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `:10000`          | ✅ **零请求**。未重启、未 kill、未占用该端口                                                                                                                                                                                             |
| `/root/data-memo` | ✅ 未读未写。所有验证走 `mkdtemp` 沙箱与 `/tmp/pack-select/`                                                                                                                                                                             |
| 指针文件          | ✅ sha256 仍是 `7f930979b85204d4c05b221f4c17a5cf5936a4d432a46488816727f60da233f3`（收工复核）。新测试在**模块顶层** `delete OPENMEMO_MODELS / OPENMEMO_EXT_DIR`，并有一条用例专门断言"模型根必须在 tmpdir 里且不在 `$HOME` 下"（§9-bis） |
| `apps/web/dist`   | ✅ **未构建**。全程只跑 `pnpm build:safe`，一次 `pnpm -r build` / `vite build` 都没跑。`[复核]` `dist` 全部文件 mtime 停在 `11:37:39`（= 你重启到 `3b11de4` 那次），我此后跑了多轮构建与测试，**一个字节没被改写**                       |
| `pkill -f`        | ✅ 未用                                                                                                                                                                                                                                  |
| release           | ✅ 未建/未改/未删。`gh` 一次都没用                                                                                                                                                                                                       |
| 本机 whisper 转写 | ✅ **一次都没跑**（按用户指示）。夹具里的 `whisper-cli` 是 `#!/bin/sh; echo <packid>` 的壳脚本，判据是"解析到了哪个路径"，不需要真跑推理                                                                                                 |
| 反向验证          | ✅ 全部在 `/tmp/pack-select/rv` 隔离副本（PROTOCOL §10），**先跑对照组**；共享树未被改动过一秒                                                                                                                                           |
| `grep -r` 陷阱    | ✅ 目录/清单类断言一律用 Node 读 JSON 计数，不用 `grep`（`packages/pipeline` 那条「源码必须是纯文本」的守卫对我的新文件也是绿的）                                                                                                        |
| 空集陷阱          | ✅ `①-bis` 那条先断言「目录非空」+「priority 至少有两种取值」再断言相等 —— 否则"抄对了"和"写死一个常数"长得一样                                                                                                                          |
| 他人文件          | ✅ 一个字未改。`HANDOFF.md` / `BOARD.md` / `docs/adr/**` / `vendor/manifests/**` / `README.md` 全部只读                                                                                                                                  |
| 派出的 subagent   | 0 个                                                                                                                                                                                                                                     |

## SHARED-CHANGE

| 文件                                    | 归属                           | 我做了什么                                                                                                                       | 冲突风险                                         |
| --------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `packages/downloader/src/installer.ts`  | `model-mgmt` / `catalog-truth` | `stripExt` 改名并导出为 `unpackDirName`，行为逐字不变（同一个正则）                                                              | 低（T-164 已在用这个新导出）                     |
| `packages/shared/src/backends.ts`       | `model-mgmt`                   | `InstalledBackendPack` 加一个**可选**字段 `priority?`。可选是刻意的：必填字段在补齐所有构造点之前红是必然的（PROTOCOL §10 推论） | 低                                               |
| `packages/runtime/src/selfcheck.ts`     | `gpu-runtime`                  | 加一条检查项 + 一个**可选**探针（照 `probePath` 的先例，没接就 `notProbed`），两个出口都接上了                                   | 低                                               |
| `apps/daemon/src/http/rest/state.ts`    | 公共 / **T-164 在途**          | 只改 2 处：import 一行 + `prefsFile` getter                                                                                      | ⚠️ **中**：该文件此刻还有别人的未完成改动，见 §7 |
| `apps/daemon/src/http/rest/backends.ts` | `model-mgmt`                   | 抽出 `toInstalledRecord()`（行为等价）+ 记录里加 `priority`                                                                      | 低                                               |
| `scripts/selfcheck.mjs`                 | `gpu-runtime`                  | 接一个探针，纯新增                                                                                                               | 低                                               |
