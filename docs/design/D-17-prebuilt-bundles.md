---
id: D-17
author: prebuilt
status: ready
date: 2026-08-08
input: 用户 2026-08-08 口述；README.md；ADR-002；ADR-015；D-11；D-12；.github/workflows/build-backends.yml
---

## 第二阶段实测结果（2026-08-08，用户三条裁决之后）

**裁决已实现**：① 发公开 Release（补了 `LICENSE` + `THIRD-PARTY-NOTICES` + libsimple 的 MIT election）
② libsimple/sqlite-vec 进包 ③ sherpa-onnx 留着。

| 平台            | 组装 | 归档校验 | **冷启动转出非空文本**                | 升级不坏数据目录 | 未压缩        | 归档                   |
| --------------- | ---- | -------- | ------------------------------------- | ---------------- | ------------- | ---------------------- |
| **linux-x64**   | ✅   | ✅ 26/26 | ✅ **108 字符 · 借宿主 PATH 的 0 个** | ✅ 10/10         | **176.3 MiB** | **41.0 MiB** `.tar.xz` |
| **win-x64**     | ✅   | ✅ 26/26 | ✅ **108 字符 · 借宿主 PATH 的 0 个** | ✅ 10/10         | **132.0 MiB** | **49.0 MiB** `.zip`    |
| **macos-arm64** | ✅   | ✅ 26/26 | ✅ **108 字符 · 借宿主 PATH 的 0 个** | ✅ 10/10         | **192.4 MiB** | **59.9 MiB** `.tar.gz` |

**三平台全绿，全部是 CI 实测值，不再有推算值**（run 31204790920 / 31205369931 / 31206040985）。
转写文本三平台都是 jfk.wav 的
"And so, my fellow Americans, ask not what your country can do for you…"。

**裁决 ② 的直接收益（实测）**：包启动后是 `tokenizer=simple vec=on`；
此前是 `tokenizer=trigram vec=off` —— **中文两字词搜索从"静默返回 0 条"变成能用**。
**Windows 上也是 `simple`** —— 这一格顺带证明了 `simple.dll` / `libsimple.dll`
那个命名陷阱被正确处理了（组装器调的是产品自己的 `sqliteExtensionSources()`，
没有长出第三套命名约定）。

---

## TL;DR（≤ 25 行，Manager 只读这里）

- **GPL 不触发 —— 但理由不是"我们没装 ffmpeg"，而是比那更强的三条**：①【实测】整个 npm 依赖闭包
  **268 个包里 0 个 GPL/AGPL/LGPL**；② ~~ffmpeg / yt-dlp 由**用户机器**直连 BtbN / yt-dlp 官方
  GitHub 取，我们不转存~~；③ 我们调用它们的方式是 `spawn(绝对路径, argv, {shell:false})`
  —— 独立进程、命令行边界，不是链接。**结论：可以发。**
  > ⚠️ **订正（2026-08-09，ffmpeg-lgpl-manifest；2026-08-09 :10000 实测后再订正一次，
  > 见下方"三种情况"）**：②**这条现在只对 yt-dlp（三平台都成立）与 macOS 上的
  > ffmpeg 成立**。Linux/Windows 的 ffmpeg **计划**改判**随包内置**
  > （BtbN 的 LGPL-3.0-or-later 变体，与原下载的 GPL 变体同源同 commit）——但
  > ⚠️ **这件事今天还没发生**：`scripts/ci/verify-bundle.sh` 里核对 NOTICES 与包内容
  > 是否一致的那条守卫，今天对 Linux/Windows 报的是 `warn`（"NOTICES 说有，包里还没有"），
  > 这本身就是"字节尚未进包"的实测证据。所以准确说法要分三种情况，缺一不可：
  > **(a) 将来拿到真正内置 LGPL 字节的新预编译包的人**——字节确实经过我们，
  > "我们不转存"对这批人不再是真话；**(b) macOS 用户**——不变，仍是 GPL、仍是下载、
  > 字节不经过我们；**(c) 已经装过 `media-tools-{linux,win}-x64` 组件的老用户**——
  > 他机器上装的**可能仍是旧的 GPL 变体**，且产品目前按 pack id 而非内容判断"机器上
  > 装了什么"（`backends.ts:378`、`machineFingerprint()`），**同一个 id 的归档被换掉
  > 时产品并不知道**，这条已由另一路登记为独立的病灶（不是许可证判断本身的错），
  > 在它被修好、且用户重装之前，这批人的判定应视同 (b) 而非 (a)。
  > ③ 因此升级成**双重理由**（对 (a) 生效，其余情况见上）：
  > 对 macOS 的 ffmpeg 与全平台的 yt-dlp，它仍是"就算被读成传播也不构成衍生作品"的
  > 兜底；对 Linux/Windows **将来**内置的 ffmpeg，它是 **LGPL 链接触发义务不适用的
  > 直接原因**——我们只 `spawn` 不 `dlopen`/链接，仍需满足的只是"许可证全文可得"，
  > 靠随归档分发的 `LICENSE.txt` 满足。**结论不变，且一旦落地就没有一个新发的字节
  > 是 GPL**——Linux/Windows 计划内置的是 **LGPL**，不是 GPL；详见 §1.1 第二层的订正与
  > `docs/design/D-20-bundled-deps.md` §9.2/§13。
- **⚠️ ADR-002 第 24 行那条 `@blocknote/xl-*` (GPL-3.0) ✅允许 是个空头许可**：该包
  **从未被采用**（package.json / lockfile / node_modules / 源码 四处 grep 全 0 命中）。
  实际用的富文本编辑器是 TipTap（全 MIT）。建议 Manager 删掉那一行 —— 留着它等于
  给未来的人一张"可以引入 GPL 编辑器"的通行证，而那一天 GPL 就真的触发了。
- **推荐形态：官方 node 二进制 + 目录 + 启动脚本。不要 Node SEA。**
  决定性理由：SEA **对我们根本产不出"单文件"** —— better-sqlite3 与 sherpa-onnx 的
  `.node` 和它们的兄弟 `.so` 必须落在磁盘上并保持同目录（rpath）。SEA 的全部代价照付，
  唯一的好处拿不到。而且 SEA 注入会**摧毁 Node 官方在 macOS 上的签名+公证**。
- **[实测] 这个形态是通的**：我在 /tmp 里装出完整包并启动 —— 网页 HTTP 200、
  `db=better-sqlite3 sqlite=3.53.4` 原生模块加载成功、`dataDir` 落在 /tmp（没碰机器指针）。
- **体积**：linux-x64 **162.8 MiB / 压缩 37.4 MiB**【实测】；win-x64 ≈ 117.3 MiB、
  macos-arm64 ≈ 178.9 MiB【由实测分件推算】。**Node 运行时本身占 83–119 MiB，是大头。**
- **两条平台地板都是绿的**【实测，用的是本仓自己的 CI 守卫】：官方 node linux-x64 = `GLIBC_2.28`
  （≤2.34 ✅）；官方 node darwin-arm64 = **`minos 11.0.0`**（≤13.3 ✅）—— 用户担心的
  `minos 26.0.0` 那个坑**不在这条路上**。
- **最容易炸的地方 = `sherpa-onnx`**，不是 better-sqlite3。better-sqlite3 是 prebuildify，
  一次安装拿到全部 8 个平台且是 N-API（跨 Node 版本通用）；而 sherpa-onnx 是**每平台一个
  optional dep，pnpm 只装宿主那一个** —— 跨平台打包必须显式去取另外两个，而且它
  **一个人就占 macOS 包的 58.8 MiB**。
- 未验证/存疑：Windows 与 macOS 的包**没有真机跑过**（本机是 Linux）；`libstdc++`
  的 `GLIBCXX_3.4.29` 地板**本仓的 check-elf-glibc.mjs 查不到**；SmartScreen / Gatekeeper
  的实际拦截行为未实测。逐条见 §7。
- 对其他 agent 的影响：**只读 `scripts/lib/version.mjs` 的 `readProductVersion()`**（当前 0.2.0），
  不碰版本号文件。包名沿用该文件已经写好的约定 `openmemo-<version>-<os>-<arch>.<ext>`。
- **需要用户裁决 3 件事，见 §8** —— 其中第 2 条（要不要把 5 MB 的中文分词塞进包里）
  会直接决定"开箱能不能搜中文"。

---

## 1. 许可证：GPL 那条到底触不触发

### 1.1 结论：不触发。可以发。

用户的判据是"我们发的是我们自己的产物（Node runtime + 我们的 JS + 原生模块），
~~ffmpeg/yt-dlp 仍由用户自己在网页上下载~~"。这个边界**在写下这句话时**成立，
但**它成立的原因比表述更强**，分三层，每层单独就够用（⚠️ 这句表述对 Linux/Windows
的 ffmpeg **计划**要变——那两个平台**将来**改判随包内置，但**今天还没变**：
`verify-bundle.sh` 的 NOTICES↔包内容双向核对今天对这两个平台报的是 `warn`，
说明字节尚未进包，见第二层订正；已经装过组件的老用户机器上目前也可能仍是旧的
GPL 版本，与"包里将来是 LGPL"是两件事，同样见第二层订正。yt-dlp 与 macOS 的
ffmpeg 不受影响，仍是"用户自己在网页上下载"）：

#### 第一层：我们要发的字节里，一个 GPL 包都没有【实测】

对 `@openmemo/daemon` 的**生产**依赖闭包逐个读 `node_modules` 里已安装的
`package.json` 的 `license` 字段，16 个外部包：

| 包                                      | 版本                   | license（逐字）                 |
| --------------------------------------- | ---------------------- | ------------------------------- |
| `better-sqlite3`                        | 13.0.2                 | `MIT`                           |
| `node-addon-api`                        | 8.9.1                  | `MIT`（仅编译期头文件，可不发） |
| `zod`                                   | 4.4.3                  | `MIT`                           |
| `ws`                                    | 8.21.1                 | `MIT`                           |
| `undici`                                | 7.29.0                 | `MIT`                           |
| `socks` / `smart-buffer` / `ip-address` | 2.8.9 / 4.2.0 / 10.4.0 | `MIT`                           |
| `xz-decompress`                         | 0.2.3                  | `MIT`                           |
| `sherpa-onnx-node` + 6 个平台包         | 1.13.4                 | `Apache-2.0`                    |

`apps/web/dist` 侧：`apps/web/vite.config.ts` **没有** `rollupOptions.external`、没有
`build.lib`、没有 CDN externals —— 也就是说第三方库代码是**被复制进 dist 的 JS** 的，
必须按"我们分发了它"来算。该闭包 75 个包全部 MIT，例外只有
`class-variance-authority` (Apache-2.0) 与 `lucide-react` (ISC)，都是宽松许可。

全工作区（**含 devDependencies**）268 个包的许可证取值集合只有：
`0BSD · Apache-2.0 · BSD-2-Clause · BSD-3-Clause · BlueOak-1.0.0 · CC0-1.0 · ISC · MIT · MIT-0 · MPL-2.0`。
**没有任何 GPL / AGPL / LGPL / SSPL / BUSL / 专有 / 缺失。**

> 唯一的 copyleft 是 3 个 `MPL-2.0`（`lightningcss` 及其 linux-x64 二进制）。它是
> **文件级** copyleft，且只在 `apps/web` 的 devDependencies 里（`@tailwindcss/vite` 拉进来的），
> **不在任何生产闭包中** —— 它是构建 `apps/web/dist` 的工具，不进包。不构成阻断。
> 但注意 `scripts/license-report.mjs` 的 `WATCHLIST` **没有 MPL/EPL/CDDL 的模式**，
> 也就是说这一项是我人工发现的，工具不会告诉你。

#### 第二层：GPL 的那两个，字节从来不经过我们【实测】——⚠️ Linux/Windows 的 ffmpeg 这行**计划中**要变，今天还没变

> **订正（2026-08-09，ffmpeg-lgpl-manifest；同日 `:10000` 实测后再订正**）：这一层
> 原本把 ffmpeg 和 yt-dlp 当同一种情况——"两个 GPL 组件字节都不经过我们"。
> **这句话的 ffmpeg 部分计划要变，但今天仍然为真**：Linux/Windows 的 ffmpeg
> **将来**改判随包内置（下表已按此拆成两行），但 `scripts/ci/verify-bundle.sh` 新增的
> NOTICES↔包内容双向核对，今天对 Linux/Windows 报的是 `warn`——即"NOTICES 已经这么
> 声称，但包里实测还没有这些字节"，这本身就是"还没发生"的实测证据，不是我的推测。
> 另外，**已经装过 `media-tools-{linux,win}-x64` 组件的老用户**，机器上装的**可能仍是
> 旧的 GPL 变体**——产品目前按 pack id 而非内容判断"机器上装了什么"
> （`backends.ts:378`、`machineFingerprint()`），同一个 id 的归档换成 LGPL 变体后，
> 产品并不知道用户机器上那份还是旧的 GPL 字节，直到用户重装。这条已由另一路登记为
> 独立病灶（不是本节许可证判断的错），修好之前**不要把"内置 LGPL"当成对所有 Linux/
> Windows 用户都成立的话**。依据：`docs/design/D-20-bundled-deps.md` §9.2/§13；
> `verify-bundle.sh` 的 warn 输出；Manager 2026-08-09 的 `:10000` 实测通报。

把 `vendor/manifests/` 里的 `url` / `license` 字段逐条列出来：

| 组件                                                                    | 许可证                                              | 谁提供字节                                                             |
| ------------------------------------------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------ |
| ffmpeg / ffprobe，**macOS**（`media-tools-darwin-arm64`）                | 🔴 GPL-3.0-or-later                                  | `github.com/jellyfin/jellyfin-ffmpeg`（用户机器直连，我们不转存）      |
| ffmpeg / ffprobe，**Linux/Windows**（`media-tools-{linux,win}-x64`）     | 🟡 **计划改判 LGPL-3.0-or-later**（BtbN 变体，同源同 commit）；**今天还没进包**，见上方订正 | **将来**是我们——随包内置；今天仍是用户机器直连下载（旧 GPL 变体，见上方订正） |
| yt-dlp (`ytdlp-*`)                                                       | 🔴 GPL-3.0-or-later\*                                | `github.com/yt-dlp/yt-dlp`（用户机器直连，我们不转存，三平台一致）     |
| libsimple / sqlite-vec / 模型                                           | MIT / Apache-2.0 / Gemma ToU                        | wangfenjin、asg017、HuggingFace、ModelScope                            |

\* **订正于 2026-08-09**（见 D-20 §14，commit `9b3ea96`；回执
`coordination/inbox/ytdlp-binary-audit.md`）：这一行此前的隐含理由是"yt-dlp 项目本身
是 GPL"——**那是错的**，**yt-dlp 项目自身的许可证是 Unlicense**（公共领域）。真正的
GPL 来源是官方发布的 PyInstaller 可执行二进制里静态打包进去的运行时依赖，且**逐平台
不同**：四个平台全部内嵌 `mutagen`（GPL-2.0-or-later）；Linux x64/arm64 额外内嵌
GNU Readline（GPL-3.0-or-later）——单元格取的是四个平台里最强的一档，macOS/Windows
实际只到 GPL-2.0-or-later（`vendor/manifests/backends.json` 已按平台分别订正）。
**巧的是"🔴 需要当 GPL 处理"这个结论仍然成立**，只是把理由从"错的"换成上面这条；
这条订正跟 ffmpeg 两行无关——ffmpeg 是发行版本身声明的许可证，不像 yt-dlp 有"项目
许可证 vs 内嵌依赖许可证"的落差，不要类推。ffmpeg 两行是因为**另一件完全不同的事**
（Linux/Windows 计划内置）分裂开的，见上方表格与订正。

我们自己的 Release 上，`backend-packs-*` 系列**只有 6 个资产，全部是 whisper.cpp，
全部 MIT**（`backend-packs-2026.08.07b` / `-2026.08.08` 里的 `whispercpp-*`）——这一条
**仍然成立**，数的是"作为独立可下载 pack 发布的资产"。⚠️ 但它**将来**不能再读成
"我们发布的 Release 资产里没有 GPL/LGPL 字节"：`openmemo-<version>-{linux,win}-x64`
那个**产品预编译包本身**（另一类 Release 资产）计划内置 LGPL 的 ffmpeg——**今天这个
包里还没有这些字节**（同上方 `verify-bundle` warn），一旦真的进包，这条"只有 6 个
资产"就需要补一句限定：它说的是"待用户按需下载的组件 pack"这一类，不是"我们发布的
一切"。
下载确实发生在用户机器上：`packages/downloader` 跑在 daemon 进程内，
用户在网页点"安装"→ `POST /api/backends/install`——**这条对 yt-dlp、macOS 的 ffmpeg，
以及今天的 Linux/Windows ffmpeg（因为还没切换）都成立**；只有在 Linux/Windows 的
LGPL 内置真正落地之后，那一种情况才会改走"构建时就在包里"。

~~**这条是 GPL 判定的核心：GPL 约束的是"conveying（传播）"行为。我们没有传播那两个二进制。**~~
—— **对 yt-dlp（三平台）与 macOS 的 ffmpeg 仍然成立**：我们没有传播它们的二进制。
**对 Linux/Windows 的 ffmpeg，今天仍然成立**（字节还没进包，用户仍是直连下载）；
**一旦 LGPL 内置落地，这条对那两个平台会变成不成立**——我们届时确实会传播
（conveying）它，但传播的是 **LGPL** 变体，不是 GPL；LGPL 允许传播，前提是满足它
自己的义务（许可证全文可得，见第三层）。**没有一个字节曾经、或计划以 GPL 身份
被我们传播过。**

#### 第三层：就算退一万步，我们与 ffmpeg 的关系是进程边界，不是链接【实测】

`packages/pipeline/src/subprocess/runner.ts:213` 是全仓**唯一**允许 spawn 的地方，
形状是 `spawn(absoluteBin, argv, { shell: false })`。ffmpeg 与 yt-dlp 是
**独立进程、命令行接口、无共享地址空间**。这是 GPL 语境下被广泛接受的"独立作品"形态
（对比"把 libavcodec 链进我们的可执行文件"—— 那才会有传染性争议）。

所以即便有人主张"你引导用户下载 = 你在分发"，第三层也堵住了"衍生作品"这条路。

> **订正（2026-08-09，ffmpeg-lgpl-manifest）**：写下这一层时，它的角色是**兜底/假设性
> 防线**——"就算你不认可第二层的 conveying 论证，第三层也还有一道"。**Linux/Windows
> 的 LGPL 内置一旦落地，这一层对那两个平台会从"兜底"升级成"直接生效、必须成立的
> 理由"**：届时我们确实 conveying 了 ffmpeg 字节（第二层已订正），LGPL 的强义务
> （链接触发的那些）能不能被绕开，**直接取决于**这里说的"只 spawn、不 dlopen/链接"
> 是不是真的——不再是"就算…也…"的假设句，而是"因为…所以…"的必要条件。对 macOS
> 的 ffmpeg 与全平台的 yt-dlp，它的角色不变，仍是兜底。

### 1.2 但有三件事会把它翻过来 —— 必须钉住

这三条今天都**没有**触发，但都是**一步之遥**，且都不会有任何东西报错：

1. **`scripts/build-media-tools.sh` 还在。** 它把 BtbN 的 **GPL** ffmpeg 重新打包成
   OpenMemo 格式的 pack（脚本自己的注释：_"we emit our own tar.gz with our own manifest"_）。
   ADR-015 §4 决策 2 只是把它降级为"可选重打包"，没删。
   **谁跑一次它、再用 `scripts/ci/release-upload.mjs` 传上去，我们当场变成 GPL 二进制的分发者。**
   > ⚠️ **别跟下面这件事搞混（2026-08-09 补注）**：Linux/Windows **计划**随包内置的
   > ffmpeg 走的是**另一条、有意为之**的路——BtbN 的 **LGPL** 变体，经 §1.1 第二/三层
   > 论证过义务能被满足，且今天连字节都还没实际进包（`verify-bundle.sh` 报 `warn`）。
   > 这一条第 1 点警告的是**这个脚本**——它重新打包的是 **GPL** 变体，跑了它才会把
   > 我们变成 GPL 分发者，跟上面那条计划中的 LGPL 内置是两回事、两个变体、两种后果，
   > 不要因为"反正现在也要内置 ffmpeg 了"就误以为这个脚本变安全了——它没有。
2. **`scripts/ci/mirror-model-blobs.mjs` 按设计就是把第三方 blob 转存到我们的 Release 上。**
   今天的 `MIRROR_MODEL_IDS` 只有 3 个 Apache-2.0 的模型，安全。但它是**手工维护的
   白名单，没有许可证闸门** —— 有人加一个 GPL 或 Gemma ToU 的条目进去，会静默生效。
3. **`release-upload.mjs` 只校验 sha256 与资产状态，不校验许可证。**

**建议（第二阶段实现时一并做，成本很低）**：在 `release-upload.mjs` 里加一条闸门 ——
待上传资产必须在 manifest 里有对应条目且 `license.id` 命中宽松白名单，
否则退出 1。判据照 PROTOCOL §7 补充那条：**"跑错了也不会造成后果"，而不是"要记得别跑"。**

### 1.3 不是阻断、但发之前该补的（都是宽松许可的合规义务）

MIT 与 Apache-2.0 都要求**在分发物中保留版权与许可声明**。自用时这条永远不触发，
一旦有人下载我们的包就触发了：

- **根 `package.json` 是 `UNLICENSED` 且仓库里没有 LICENSE 文件。** 下载者拿不到任何授权。
  这是**我们自己的**代码，发不发、怎么发由用户决定 —— 但"公开可下载 + UNLICENSED"
  是个别扭的组合，建议用户明确一下意图（见 §8 问题 1）。
- **需要一份 `THIRD-PARTY-NOTICES`**，覆盖随包发出的约 91 个包。其中 3 个包
  **自己没带 LICENSE 文件**，要单独去上游取：`sherpa-onnx-node`、`sherpa-onnx-linux-x64`
  （均 Apache-2.0）、`xz-decompress`（MIT）。
- `vendor/README.md:40` 有一条一直没法执行的旧要求：**libsimple 的"我们选 MIT"这个
  election 必须出现在最终分发物的第三方许可证清单里，否则可能被读成 GPL-3.0。**
  它现在变得可执行了 —— 如果我们把 libsimple 放进包（§8 问题 2）。
- `sherpa-onnx-linux-x64` 的 npm 包里**塞了一个 `libonnxruntime.so`（26.4 MB）**，
  而那个 `.so` 的许可证不是该 npm 包自己的许可证。上游 ONNX Runtime 是 MIT
  **[报告]**，但包里没有 LICENSE 文件可以佐证 → 标 `UNKNOWN`，发之前应解决。

---

## 2. 打包形态：为什么不是 SEA

### 2.1 对比表

|                        | **A. Node SEA（单文件）**                                                                                | **B. 官方 node 二进制 + 目录 + 启动脚本 ★推荐**             | C. 打包器（pkg / nexe）                    | D. Electron / Tauri            |
| ---------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------ | ------------------------------ |
| 真的是"单文件"吗       | **不是**（见 2.2）                                                                                       | 否，是一个目录                                              | 同 A 的问题                                | 否                             |
| 用户要装 Node/pnpm/git | 否 ✅                                                                                                    | **否 ✅**                                                   | 否                                         | 否                             |
| 原生模块               | 必须写到临时文件再 `process.dlopen()`；兄弟 `.so` 的 rpath 会断                                          | **直接放在 `node_modules` 里，原样 require ✅【实测通过】** | 各家自有机制，同样别扭                     | 同 B                           |
| 需要新增 bundler 步骤  | **是**（SEA 内不读文件系统，全部 JS 必须先打成一个文件）                                                 | **否，直接用现有 `tsc` 产物 ✅**                            | 是                                         | 是                             |
| ESM 兼容               | `mainFormat:"module"` 下 `import()` **不能从文件系统加载**，且无 `createRequire` 逃生口 → 实际要改回 CJS | **原生 ESM，零改动 ✅**                                     | 普遍对 ESM 支持差                          | 好                             |
| macOS 签名             | **注入会摧毁 Node 官方签名**，只能改 ad-hoc 重签 → Gatekeeper 姿态更差                                   | **原样携带 Node 官方签名+公证 ✅**                          | 同 A                                       | 需自己签                       |
| Node 22 基线可用性     | `--build-sea` 是 v25.5.0 才有；`mainFormat` 引入版本 `UNKNOWN` → 22 上很可能只有 CJS                     | **无版本依赖 ✅**                                           | —                                          | —                              |
| 上游稳定性             | **Stability 1.1「积极开发中」**                                                                          | 稳定                                                        | `vercel/pkg` 已归档 **[报告，未独立核实]** | 稳定                           |
| 体积                   | 与 B 基本相同（见 2.3）                                                                                  | 见 §4                                                       | 相近                                       | **更大**（另带 Chromium）      |
| 与本仓宪章             | —                                                                                                        | —                                                           | —                                          | README 明写**"不是 Electron"** |

### 2.2 决定性的一条：SEA 对我们产不出单文件

SEA 的全部吸引力是"一个文件"。但我们有两个原生模块：

- `better-sqlite3` 的 `.node`
- `sherpa-onnx-node` 的 `.node`，**而且它旁边必须有 3 个兄弟 `.so`**
  （`libonnxruntime.so` 26.4 MB、`libsherpa-onnx-c-api.so`、`libsherpa-onnx-cxx-api.so`），
  靠 rpath/`$ORIGIN` 找到彼此。

Node 官方文档对 SEA 里的原生模块给的办法是：把它当 asset 嵌进去，运行时
**写到临时文件再 `process.dlopen()`**。对单个自包含 `.node` 勉强可行；对
"一个 `.node` + 三个必须同目录的 `.so`"，等于要在运行时把整套 `.so` 铺到 tmpdir 里再祈祷
rpath 解析对 —— 而这一切只是为了避免在磁盘上放一个目录。

> **判据：SEA 的代价全部要付（改 CJS、加 bundler、丢 macOS 签名、依赖 Stability 1.1 的特性），
> 而它唯一的好处"单文件"拿不到 —— 因为 `.so` 无论如何都要落盘。**

用户要的是"下载一个文件，解开就能跑"。**"解开"这个词本身就允许目录形态** ——
一个 `.tar.xz` / `.zip` 就是"一个文件"。方案 B 完全满足原始诉求。

### 2.3 SEA 也省不了体积

SEA 是把我们的 JS **注入进 node 二进制**。node 二进制 119 MiB 一分不少，
我们的 JS 只有 ~1.5 MiB。省下的是"几个 .js 文件"，不是数量级。

### 2.4 推荐的目录形态（已实测跑通）

```
openmemo-0.2.0-linux-x64/
├── runtime/node                 # 官方二进制，原样不改（macOS 上保留官方签名）
├── app/
│   ├── daemon/{package.json,dist/}
│   ├── node_modules/            # 扁平化的生产闭包（非符号链接）
│   │   ├── @openmemo/{db,downloader,llm,mindmap,pipeline,runtime,shared}/
│   │   ├── better-sqlite3/      # 只留本平台的 prebuild
│   │   └── sherpa-onnx-node/ + sherpa-onnx-<platform>/
│   └── apps/web/dist/           # ★ 网页 bundle，缺了就是白页
├── THIRD-PARTY-NOTICES
└── start.sh / start.cmd / OpenMemo.command
```

启动脚本做三件事：设 `OPENMEMO_WEB_DIST` 指向包内 `apps/web/dist`、
`cd app/daemon`、`exec ../../runtime/node dist/main.js "$@"`。

`apps/daemon/src/http/static.ts` 的 `resolveWebDist()` **已经优先读 `OPENMEMO_WEB_DIST`**，
且注释里写着"打包后布局会变" —— 这个钩子是现成的，不用改代码。

---

## 3. 原生模块：今天怎么来的，用户机器上会不会炸

### 3.1 `better-sqlite3` 13.0.2 —— 这条路比预想的好

- **来源【实测】**：prebuildify。**8 个平台的 `.node` 全在同一个 npm tarball 里**
  （linux/linuxmusl/darwin/win32 × x64/arm64），本机是 Linux 但 8 个全都在盘上。
  → **跨平台打包不需要为它做任何额外的事。**
- **无 install/postinstall 脚本**（`gypfile: false`，`scripts` 里只有手动 build 命令）。
  `pnpm-workspace.yaml` 刻意把它排除在 `onlyBuiltDependencies` 之外，理由记在那里。
  → **用户机器上不需要 make/gcc/Python，不会炸。**
- **ABI【实测三重验证】**：N-API version 10（`binding.gyp` 定义 `NAPI_VERSION=10`；
  `readelf` 导出 `napi_register_module_v1` 且**没有** `node_module_register`；
  反汇编 `node_api_module_get_api_version_v1` = `mov $0xa,%eax`）。
  实测在本机 **Node v24.18.0** 下加载 Node-22-时代的 prebuild 并成功执行
  `select sqlite_version()` → `3.53.4`。
  → **一个 `.node` 跨 Node 22/24 通用，不必按 Node 版本重发。**
- **glibc 地板【实测，用本仓 `check-elf-glibc.mjs`】**：`linux-x64.node` = `GLIBC_2.34`，
  **正好压在本仓 2.34 基线上（通过）**。
- **macOS 签名【实测】**：`darwin-arm64.node` **有 `LC_CODE_SIGNATURE`**。
  （Apple silicon 要求所有可执行代码至少 ad-hoc 签名，否则根本不加载 —— 这一格是安全的。）
- 瘦身：整包 26.09 MiB，其中 `deps/`（SQLite 源码）10.26 MiB、`src/` 0.11 MiB、
  7 个用不到的 prebuild —— **裁到单平台 ≈ 2.26 MB**。

### 3.2 ⚠️ `sherpa-onnx-node` 1.13.4 —— 这才是最容易炸的地方

它是 `packages/pipeline` 的**生产**依赖，因此在 daemon 的闭包里。

- **模型与 better-sqlite3 相反**：6 个平台包是 `optionalDependencies` + `os`/`cpu` 门控，
  **pnpm 只装宿主那一个**。本机只有 `sherpa-onnx-linux-x64`。
  → **跨平台打包必须显式去取 `sherpa-onnx-win-x64` 与 `sherpa-onnx-darwin-arm64` 的 tarball。**
  这是 CI 里必须新写的一步，也是最容易漏、且漏了只在别的平台上才显形的一步。
- **体积很不对称**【npm registry `unpackedSize`】：
  linux-x64 **31.2 MiB** · win-x64 **21.9 MiB** · **darwin-arm64 58.8 MiB**。
  它一个人就是 macOS 包比 Linux 包还大的原因。
- **不是单文件**：`.node` 旁边有 3 个 `.so` 兄弟，靠 rpath 找彼此 → **必须同目录**。
  （这也是 §2.2 里 SEA 被否掉的直接原因。）
- **glibc 地板【实测】**：最高 `GLIBC_2.16`，远低于 2.34，通过。
- **它是可降级的**：`packages/pipeline/src/asr/sherpaModule.ts` 用
  `await import(spec)` 懒加载并容忍失败，`apps/daemon/src/pipeline/setup.ts:563`
  把它转成 `unavailableReason`。**去掉它 = 失去流式 ASR / VAD，但产品仍然启动。**
  → 这是最大的一个体积杠杆，见 §8 问题 3。

### 3.3 `libsimple` / `sqlite-vec`：不是 npm 包，是运行时下载

两者都不在任何 `package.json` 里。它们是 `vendor/manifests/sqlite-ext.json` 里的
11 个 `tier: "downloadable"` pack，钉死 tag + sha256，从 wangfenjin/simple 与
asg017/sqlite-vec 的官方 Release 取，落到 `<dataDir>/bin/ext`。

**按用户判据 2，它们不进包。** 但这里有一个**沉默的功能塌陷**，我认为必须让用户知道：

我的实测启动日志最后一行是：

```
[daemon] db=better-sqlite3 sqlite=3.53.4 schema=v1 tokenizer=trigram vec=off
```

`loadExtensions()` **从不抛错**：缺 libsimple → FTS5 静默退化成 `trigram`；
缺 sqlite-vec → 语义检索关闭。而 **trigram 在结构上无法匹配长度 < 3 的查询** ——
**中文两字词搜索返回 0 条，不报任何错。** 这正是本仓 §"装得上、跑不了、自检看不见"
那一族的典型形状。

代价对比：这两个加起来**每平台仅约 5.4 MB**（其中大头是 jieba 词典），**全 MIT**。
既不是 GB 级，也不碰 GPL。→ 见 §8 问题 2。

### 3.4 需要留意但不进包的

- `openmemo-probe`（GPU 探针）**今天没有分发通道**（`apps/daemon/src/runtime/setup.ts:211`
  只在 `<dataDir>/bin/runtime` 与 `<modelsRoot>/by-name/backend` 里找）。
  它随 whisper 包出厂，所以用户装完组件才有。**包里不放它是正确的**，但要知道
  "开箱即用"不包含 GPU 检测。
- **不要发**的构建期原生模块：`@rolldown/binding-*`（19.3 MB）、`lightningcss-*`（10 MB）、
  `@tailwindcss/oxide-*`（3 MB）—— 全是 `apps/web` 的 devDependencies，产出 `dist` 后即为死重。
- `ws` 的 `bufferutil` / `utf-8-validate` 是**可选 peerDependencies，本机未安装**，
  纯 JS 路径运行，无需处理。
- `pnpm-workspace.yaml` 的 `onlyBuiltDependencies` 里 `esbuild` 是**陈旧条目**
  （vite 8 用 rolldown，esbuild 根本没装）。不影响本任务，顺带记一笔。

### 3.5 ⚠️ 一个本仓守卫查不到的地板

`better-sqlite3` 的 `linux-x64.node` 的 C++ ABI 需求是 **`GLIBCXX_3.4.29` / `CXXABI_1.3.9`**
（= GCC 11 / Ubuntu 21.04+ 起）。`NEEDED: libstdc++.so.6, libm.so.6, libc.so.6`。

**`scripts/ci/check-elf-glibc.mjs` 只 grep `GLIBC_x.y`，不看 `GLIBCXX_`。**
也就是说：一个 glibc 足够新但 libstdc++ 太老的发行版上，包会通过我们所有守卫，
然后在加载 `.node` 时死掉。README 承诺的地板是 glibc ≥ 2.34（Ubuntu 22.04 = glibc 2.35 +
GCC 12 → 满足 3.4.29），所以**在承诺范围内是安全的**，但守卫覆盖不到这一格。
→ 建议第二阶段给 `check-elf-glibc.mjs` 加 `GLIBCXX_`/`CXXABI_` 检查（小改动，反向用例好写）。

---

## 4. 体积估算

### 4.1 linux-x64【实测，不是推算】

我在 `/tmp` 里真的装出了这个包并压缩：

| 组成                                   |            字节 |       MiB |
| -------------------------------------- | --------------: | --------: |
| `runtime/node`（官方 v22.23.1 二进制） |     124,835,376 | **119.1** |
| `app/node_modules` 合计                |      43,457,635 |      41.4 |
| ├ `sherpa-onnx-linux-x64`              |      32,675,645 |      31.2 |
| ├ `zod`                                |       4,558,122 |       4.3 |
| ├ `better-sqlite3`（已裁到单平台）     |       2,264,562 |       2.2 |
| ├ `@openmemo/*` 7 个包                 |       1,460,632 |       1.4 |
| └ 其余（undici/ws/socks/…）            |      ~2,498,674 |      ~2.4 |
| `app/apps/web/dist`（★ 网页 bundle）   |       1,515,745 |       1.4 |
| `app/daemon/dist`                      |         955,902 |       0.9 |
| **合计（未压缩）**                     | **170,764,658** | **162.8** |
| **`.tar.xz`（xz -6）**                 |  **39,285,284** |  **37.4** |
| （参考）`.tar.gz`                      |      58,046,513 |      55.4 |
| （参考）`.zip` deflate                 |      58,678,363 |      56.0 |

### 4.2 三平台

win/macos 的数字是**用实测分件换算**的（换 node 二进制、换 sherpa 平台包、换
better-sqlite3 prebuild），不是拍的；但**没有在真机上装出来过**，标 [推算]。

> ⚠️ **下表是调研阶段的推算，已被实测取代 —— 保留是为了对照"推算差了多少"。**
> 真值见本文件开头的实测表。差异来源有两个：① 调研时的推算**没有算 `ext/`**
> （裁决 ② 之后才进包，解开后 14.1 MiB，压缩包只有 5.4 MB —— 我当时把压缩包大小
> 当成了占用，这是个**低估**）；② 归档压缩比按 linux 的比例外推，macOS 偏乐观。

| 平台            |             node 二进制 |   sherpa | 未压缩（推算 → **实测**） | 格式      | 压缩后（估算 → **实测**） |
| --------------- | ----------------------: | -------: | ------------------------: | --------- | ------------------------: |
| **linux-x64**   | 124,835,376 (119.1 MiB) | 31.2 MiB |     162.8 → **176.3 MiB** | `.tar.xz` |       37.4 → **41.0 MiB** |
| **win-x64**     |   86,989,128 (82.9 MiB) | 21.9 MiB |    ≈117.3 → **132.0 MiB** | `.zip`    |        ≈42 → **49.0 MiB** |
| **macos-arm64** | 112,928,848 (107.7 MiB) | 58.8 MiB |    ≈178.9 → **192.4 MiB** | `.tar.gz` |        ≈64 → **59.9 MiB** |

**推算的方向性是对的**（win 最小、macOS 最大），绝对值普遍低估 8–13%。

> Windows 只能用 `.zip`（系统自带解压），而 zip 的 deflate 比 xz 差很多 ——
> 所以 Windows 包未压缩最小、压缩后反而不是最小的。

### 4.3 两个体积杠杆（都实测过）

| 杠杆                    | linux 未压缩 | linux `.tar.xz` | 代价                                                  |
| ----------------------- | -----------: | --------------: | ----------------------------------------------------- |
| 基线                    |    162.8 MiB |        37.4 MiB | —                                                     |
| **去掉 sherpa-onnx**    |    130.9 MiB |    **30.1 MiB** | 失去流式 ASR / VAD；macOS 上省 **58.8 MiB**（最划算） |
| **`strip` node 二进制** |    145.2 MiB |        35.0 MiB | 省 16.9 MiB。**macOS 上绝对不能做** —— 会摧毁官方签名 |

`strip` 后的 node 实测仍能正常执行（`node -e` 通过）。但收益（-14%）相对风险
（丢失原生崩溃栈符号）一般，**建议先不做**。

---

## 5. 平台地板：两个已知的坑，实测都不在这条路上

用户点名担心的两条，我用**本仓自己的 CI 守卫脚本**对**官方 Node 二进制**跑了一遍：

```
$ node scripts/ci/check-macho-minos.mjs --dir <官方 node-v22.23.1-darwin-arm64> --max 13.3
  ✔ minos 11.0.0 sdk 15.0.0 macOS    → 全部 minos ≤ 13.3

$ node scripts/ci/check-elf-glibc.mjs --dir <官方 node-v22.23.1-linux-x64> --max 2.34
  ✔ GLIBC_2.28                        → 全部 ≤ GLIBC_2.34
```

- **macOS `minos` = 11.0.0**，远低于 README 承诺的 13.3。用户担心的
  "被钉在 `minos 26.0.0`、死在几乎所有 Mac 上"那个事故**成因是我们自己编译时没指定部署目标**；
  官方 Node 二进制是别人编的，且指定得很保守。**这条路上不会重演。**
- **linux `GLIBC_2.28`**，比我们自己的 2.34 基线还低 —— 也就是说
  **本包的 glibc 地板由 `better-sqlite3` 的 2.34 决定，不是由 node 决定**，正好压在基线上。
- 而且**本包不编译任何原生代码**（全是现成二进制的组装），所以
  `build-backends.yml` 里那套 buildbox 容器**不是必需的**。
  但守卫仍然要跑 —— 判据不变：**对组装好的整棵树跑 `check-elf-glibc` 与 `check-macho-minos`。**

### 签名与拦截（未实测，逐条标注）

|                         | 现状                                                                                                                    | 后果                                                                                                                                                                                                                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **macOS Gatekeeper**    | 我们**原样携带 Node 官方签名+公证**的 `node`（实测有 `LC_CODE_SIGNATURE`），但**我们自己的启动脚本与整包没有签名/公证** | 浏览器下载的归档带 `com.apple.quarantine`。用 Finder 解压会**传播**隔离属性 → 双击 `.command` 大概率被拦"无法验证开发者"。~~用命令行 `tar` 解压**不传播** → 不拦。~~ **← 这半句实测是错的，见 §5.1 订正** **[未验证：没有 Mac 可测]** 缓解：文档里给 `xattr -dr com.apple.quarantine <目录>` 一行 |
| **Windows SmartScreen** | 完全不签（ADR-003 决策 4）                                                                                              | 下载的 `.zip` 带 Mark-of-the-Web，解压出的 `.cmd`/`.exe` 首次运行会弹 SmartScreen，需点"仍要运行"。会随下载量累积信誉而缓解。`build-backends.yml:599` 已记载同一结论 **[报告]**                                                                                                                   |

**这两条都是"不签名"的既有后果，不是本方案引入的新问题** —— README 已经写了
"不签名：macOS 只做 ad-hoc，Windows 完全不签"。但**它们会成为用户第一次双击时看到的东西**，
所以必须写进包内的 README，否则"解开就能跑"这句话在 macOS 上是假的。

### 5.1 订正（2026-08-08，`bundle-launch`）：「命令行 `tar` 不传播 quarantine」是错的

**何时**：2026-08-08。**被谁**：`bundle-launch`（agent）。
**依据什么**：Meta Manager 在本轮任务里明确要求「发出去的错话没有主人之分」，
授权就地订正；原文用删除线保留，格式照 `ADR-003 §7.6` 先例。
**为什么就地改**：这半句**已经进了 v0.2.0 的分发物**（`OpenMemo.command` 的注释里
逐字抄了它），用户会照着做。判据照 ADR-003 §7.4：
**一条不实的断言，只能在它被读到的那一行修。**

`[CI 实测 run 31245628148 / 31247860854，macos-26]` 给归档打上
`com.apple.quarantine` 之后分别解压，逐个文件问 `xattr -p`：

| 解压方式                     | `OpenMemo.command`                              | `runtime/node` | sherpa 目录 |
| ---------------------------- | ----------------------------------------------- | -------------- | ----------- |
| 命令行 `tar xzf`             | **带**                                          | **带**         | **带**      |
| 「归档实用工具」（访达双击） | **带**                                          | **带**         | **带**      |
| `ditto -x -z`                | 不适用（`.tar.gz` 不是 zip：`bad file format`） | —              | —           |

三者读到的是**同一个值** `0083;<time>;Safari;<uuid>`。
阴阳对照齐备（阴性=命令行下载的归档 `No such xattr`；阳性=手工写入后读得回来）
→ **探针有效，这个阳性结果是可信的。**

> **代价说明白**：这不是一条"写得不够准"的话，是一条**用户会照着做、做了没用**的话。
> 他会据此认为自己已经排除了 quarantine 这个原因，然后去别处找问题。
> **比不给建议更糟。**

**正确的说法**（已进 `READ-ME-FIRST.txt` / README）：换解压方式**绕不开**；
标准做法是**右键 `OpenMemo.command` →「打开」一次**（Manager 2026-08-08 裁决 (A)，
它不清除任何隔离属性，只是 macOS 自己的放行手势）。
`xattr -dr` 作为备选写在文档里，**产品代码里一行都没有**。

另外两处顺带订正：

- 「双击 `.command` **大概率**被拦」→ **实测确定被拦**：
  `spctl -a -t open … OpenMemo.command` → `rejected` / `source=no usable signature`。
- 「我们原样携带 Node 官方签名**+公证**」中的"公证"本轮**没有独立核实**：
  实测到的是 `Authority=Developer ID Application: Node.js Foundation (HX7739G8FX)`
  - `flags=0x10000(runtime)`（硬化运行时）。**是否 stapled 公证票据未验** → 标 `[未验证]`。
    不影响结论：被拦的是我们自己的脚本，不是 `node`。

完整实测与两条 quarantine 路径的结论见 **`docs/design/D-18-launch-experience.md` §3–§4**。

---

## 6. 升级路径：装新版不能弄坏已有数据目录

**结论：天然安全，因为包里根本没有数据目录。**

- 数据目录由 `apps/daemon/src/config/paths.ts` 决定，优先级
  `OPENMEMO_DATA_DIR` > `--data-dir` > 机器级指针 `datadir.json` > OS 默认。
  **包解压到哪里都不影响它。**
- 升级 = 解压新目录、删旧目录。数据、组件、模型全在数据目录里，一个字节不动。
- **[实测佐证]** 我启动包时用 `OPENMEMO_POINTER_FILE` + `OPENMEMO_DATA_DIR` 指向 `/tmp`，
  `/api/health` 返回 `"dataDir":"/tmp/prebuilt-research/iso/data"`，
  并且事后核对机器指针 `~/.local/share/openmemo/datadir.json` 内容仍是 `/root/data-memo`、
  mtime 仍是 2026-08-04（早于本次作业），`:10000` 的 demo 仍返回 200。**没有越界。**
- **要注意的一条**：包**不要**内置 `OPENMEMO_DATA_DIR` 的默认值到启动脚本里。
  一旦写死，用户搬迁数据目录的功能（网页上"设置 → 数据目录"）就会被脚本悄悄覆盖 ——
  这正是 PROTOCOL §9 那类"全局单例被进程级配置带偏"的形状。**启动脚本只设
  `OPENMEMO_WEB_DIST`，其余一律不设。**
- 数据库 schema 迁移由 `packages/db/migrations/`（32 KB，2 个 `.sql`）负责，随包发出即可。

---

## 7. 代价与未知（逐条）

### 未验证 [未验证]

1. **Windows 与 macOS 的包一次都没装出来过。** 本机是 Linux x64。三平台里
   **只有 linux-x64 是实测**，另外两个是按实测分件换算。
2. **Gatekeeper / SmartScreen 的实际拦截行为没测过**（没有 Mac / Windows 机器）。
3. **`sherpa-onnx-{win-x64,darwin-arm64}` 只从 npm registry 读到了
   `unpackedSize` 与 `license`，没有落盘核对。** 它们是要随包发出去的东西，
   第二阶段必须在对应平台上真装一次再核。
4. **压缩后的 win / macos 体积是按 linux 的压缩比估的**，标 ［估算］。
5. **本包没有跑过 `cold-start-audit` 的判据**（"屏蔽宿主 PATH 的干净机器上真的转出非空文本"）。
   我的实测只证明了**启动 + 网页 200 + SQLite 原生模块加载**；转写还需要
   whisper-cli 与模型，那是运行时下载。**第二阶段必须补一条等价的 CI 判据。**

### UNKNOWN（取不到值，附原因）

6. **Node 22 的 SEA 是否支持 `mainFormat: "module"`** —— 我读到的是 v26.7.0 的文档，
   它没有标注 `mainFormat` 的引入版本。取不到 → 但这条**不影响结论**，因为 SEA 已因 §2.2 被否。
7. **`sherpa-onnx-linux-x64` 里 `libonnxruntime.so` 的许可证** —— 包内无 LICENSE 文件，
   无法从磁盘证实。上游 ONNX Runtime 是 MIT **[报告]**。
8. **`vercel/pkg` 是否已归档** —— 未独立核实，标 [报告]。不影响结论。

### 代价（选了方案 B 就要接受的）

9. **包是目录不是单文件**，用户要"解开"而不是"双击一个 exe"。
   （但归档本身是一个文件，满足用户原话。）
10. **`node_modules` 必须扁平化。** `.npmrc` 设了 `node-linker=isolated`（符号链接农场），
    **符号链接在 Windows 上的归档/解压会坏**。CI 里要么用 `node-linker=hoisted` 重装一次，
    要么写一个复制展平步骤（我实测用的是后者，可行）。
11. **`apps/web/dist` 必须由 `pnpm -r build` 产出**，而 `build:safe` 与 `typecheck` 都不产出。
    这意味着**打包 CI 里必然要跑一次 `vite build`** —— 在 CI runner 上跑没有 §7 的问题
    （那是共享工作树的规则），但**本机绝对不能跑**。第二阶段的本地验证一律
    `--outDir /tmp/prebuilt/`，或直接复用仓库里已有的 `apps/web/dist`（我这次就是这么做的）。
12. **三平台各一条 CI 腿**，形状照抄 `build-backends.yml`：per-platform job → 组装 →
    跑守卫（`check-elf-glibc` / `check-macho-minos`）→ 烟雾测试（解到别处、不给 PATH、启动、
    curl 网页）→ `upload-artifact`。**不需要 buildbox 容器**（不编译原生代码），
    这比 `build-backends.yml` 简单一档。

---

## 8. 需要用户裁决（等裁决后再进第二阶段）

**问题 1 —— 这些包发到哪里？**
如果是公开的 GitHub Release，那就是**公开分发**，§1.3 那三条合规义务（LICENSE 文件、
THIRD-PARTY-NOTICES、libsimple 的 MIT election）应当补齐；GPL 那条**仍然不触发**。
如果只是给用户自己在几台机器之间搬，那三条可以只做 THIRD-PARTY-NOTICES。
**请明确：公开可下载，还是自用分发？**

**问题 2 —— 要不要把 libsimple + sqlite-vec 放进包里？（我倾向：放）**

- 代价：每平台 **+5.4 MB**（占比 3%），**全 MIT，不碰 GPL**，不改变任何法律判断。
- 收益：开箱即可中文全文检索。**否则默认是 `tokenizer=trigram`，中文两字词搜索
  返回 0 条且不报任何错**（§3.3 实测日志）。
- 与判据 2 的关系：判据 2 的理由是"包会变 GB 级 + GPL 硬阻断"。**这两个组件两条都不占。**
  所以我认为它属于判据 2 想排除的范围之外，但**这是用户的判断，我不擅自做。**

**问题 3 —— sherpa-onnx 留还是去？**

- 留：macOS 包 178.9 MiB，Linux 162.8 MiB。
- 去：macOS 降到 **约 120 MiB**（省 58.8 MiB，33%），Linux 降到 130.9 MiB。
- 代价：失去流式 ASR 与 VAD（产品仍启动，`unavailableReason` 会如实说明）。
- 我**倾向于留**——省下的是体积，丢掉的是功能，而 37 MiB 的压缩包已经不算大。
  但如果用户在意 macOS 那 58.8 MiB，这是唯一的大杠杆。

---

## 9. 第二阶段实现清单（裁决后执行，此处仅备查）

1. `scripts/build-bundle.mjs`：组装 + 裁剪 + 扁平化 `node_modules` + 写
   `THIRD-PARTY-NOTICES`；包名走 `readProductVersion()`，形如
   `openmemo-0.2.0-linux-x64.tar.xz`（约定已写在 `scripts/lib/version.mjs`）。
2. `.github/workflows/build-bundles.yml`：三条腿，形状照抄 `build-backends.yml`
   （`workflow_dispatch` + `legs` 选择器 + `if-no-files-found: error`）。
3. 守卫：整树 `check-elf-glibc --max 2.34` + `check-macho-minos --max 13.3`；
   给 `check-elf-glibc.mjs` 补 `GLIBCXX_`/`CXXABI_`（§3.5）。
4. 烟雾测试：解到别处 → 屏蔽宿主 PATH → 启动 → `curl /` 得 200 且
   `curl /api/health` 的 `dataDir` 落在临时目录 → 进一步补 cold-start 转写判据。
5. `release-upload.mjs` 加许可证闸门（§1.2）。
6. 包内 README：写清 Gatekeeper / SmartScreen 首次运行会拦，以及绕过方式。

**本轮不做任何实现。** 以上仅为裁决后的执行路径。

---

## 10. 第一次真跑 CI 发现的两件事（2026-08-08）

两条都不是"代码写错了"那种发现，所以单独记在这里。

### 10.1 Windows：动态 import 绝对路径当场炸

`[CI 实测 run 31204790920]`

```
Error [ERR_UNSUPPORTED_ESM_URL_SCHEME]: ... On Windows, absolute paths must be
valid file:// URLs. Received protocol 'd:'
```

组装器用 `await import(join(REPO_ROOT, 'packages/downloader/dist/index.js'))`
去复用产品自己的解包器。**在 Linux/macOS 上这是对的，在 Windows 上不是** ——
`D:\...` 不是合法的 ESM specifier，必须 `pathToFileURL().href`。

值得记一条：它**只在 Windows 上出现，而且出现在第一步下载之后** ——
也就是说本机跑一万遍都不会看见。这正是"接 GitHub 换来的能力"要用来回答的那类问题。

### 10.2 ⚠️ macOS：四个**上游预编译**的二进制高于我们承诺的 13.3

`[CI 实测 run 31204790920]` 这条是**产品事实**，不是我们的缺陷，需要 Manager/用户裁决。

| 文件                                                   |      minos | 来源                           | 坏了丢什么      |
| ------------------------------------------------------ | ---------: | ------------------------------ | --------------- |
| `libonnxruntime.dylib` / `libonnxruntime.1.27.0.dylib` | **15.5.0** | sherpa-onnx npm                | 流式 ASR / VAD  |
| `sherpa-onnx.node`                                     | **14.0.0** | sherpa-onnx npm                | 同上            |
| `ext/vec0.dylib`                                       | **14.0.0** | sqlite-vec v0.1.9 官方 release | 语义 / 混合检索 |

**通过的**：`runtime/node` 11.0.0 · `better-sqlite3` 11.0.0 · **`ext/libsimple.dylib` 11.0.0**
· `libsherpa-onnx-{c,cxx}-api.dylib` 11.0.0。

含义，逐条：

- README 的平台表写着 **macOS arm64（≥ 13.3）**。在 **13.3 ≤ 系统 < 14.0** 的机器上，
  `vec0.dylib` **加载不了** → 语义检索没有；**< 15.5** 的机器上 sherpa **加载不了**
  → 流式 ASR / VAD 没有。
- **两者都是静默失效**：`loadExtensions()` 的契约就是"绝不阻塞启动"，
  sherpa 是 `await import()` 懒加载且容忍失败。用户看到的是"功能不见了"，不是报错。
  —— 这正是 README §"装得上、跑不了、自检看不见"那一族，现在有了确切数字。
- **好消息**：裁决 ② 的主要目标 `libsimple`（中文分词）是 **11.0.0**，
  在 13.3 上完全可用。**中文搜索这一条不受影响。**

**已做的**：`scripts/ci/check-bundle-macos-floors.mjs` 把一刀切换成分层 ——
CORE（node / better-sqlite3 / libsimple）仍然硬卡 13.3；可降级组各自**声明** floor，
**实测高于声明才红**。判据没有放松：上游再抬一档照样当场说话，
而已知事实不再每次伪装成新问题。

**没做的（需要裁决）**：README 的平台表现在与事实不完全一致。三个选项：

1. 保留 13.3，在平台表里注明这两个功能各自的 floor（我倾向这个 —— 诚实且不砍用户）；
2. 把 macOS floor 整体抬到 14.0 或 15.5（砍掉一批用户，换"表里只有一个数字"）；
3. macOS 包不带 sherpa-onnx（省 58.8 MiB，同时消掉 15.5 那一行）。

**README 是对外承诺，不在我的职权内** —— 已在 inbox 里升级。

### 10.3 daemon 的 `/api/health` **早于路由表**应答（真实窗口，未修）

`[CI 实测 run 31205369931, windows-2025]` 升级验证红在

```
✘ 建文件夹失败 HTTP 404：{"code":"NOT_FOUND","message":"no route for POST /api/folders"}
```

**而同一份代码在 Linux 与 macOS 上都是绿的。**

成因不是 Windows 特有缺陷，是一个一直存在的窗口被慢一点的机器撞上了：

- `/api/health` 由 `apps/daemon/src/http/server.ts:122` **直接应答，不经过路由表**；
- 业务路由是 `apps/daemon/src/main.ts:844` 的 `routers.push(...)`，发生在 server 建好**之后**。

于是「health 说 ok」与「路由表装完了」之间有一段真空。
`server.ts:39` 的注释里其实已经记着**单实例探测撞过同一个窗口** —— 它一直在那儿，
只是从来没有人在一台够慢的机器上撞到第二次。

**我这一侧改了**：升级验证的就绪判据换成一个真业务路由（等 `/api/folders` 不再 404）。
不加长 sleep —— 那只是把同一个竞态推给更慢的机器。

**窗口本身没修**：那属于 daemon 的启动顺序，不在本任务职权内。
影响面值得一提：任何"health 通了就开始打业务接口"的调用方都可能撞上，
包括单实例探测与前端首屏。**已升级 Manager。**

## 11. **e2e 腿测的是「包」，不是「树」**（v0.3.0 换来的一条，务必读完）

### 性质本身

> **四条 e2e 腿（`e2e-import` / `e2e-notes` / `e2e-record` / `e2e-runtime`）
> 验的是一批具体的预编译包，不是当前的 HEAD。**
>
> - 它们**绿**，只说明**那一批包**好 —— 不说明 HEAD 好。
> - HEAD 修好了，它们**不会自己变绿** —— 必须先**重新出包**，再对新包跑一遍。
> - 所以一条腿变红时，**第一个要问的不是「代码对不对」，而是
>   「我手里这个包是从哪个 commit 出来的」。**

这不是缺陷，是这套判据存在的**全部理由**：v0.2.0 的教训是「源码树跑绿证明不了包能用」，
于是判据被刻意对准了包。代价就是上面这条 —— 判据与树之间**天然有一个时间差**。

### 它已经咬过两次，形状完全一样

| 版本   | 发作方式                                                                     | 共同点           |
| ------ | ---------------------------------------------------------------------------- | ---------------- |
| v0.2.0 | CI **从没执行过启动器** → 用户双击打不开                                     | 判据没对准交付物 |
| v0.3.0 | e2e **从没跑过要发的那批包**（四条腿跑的都是更早的包，全在 `aa92cba3` 之前） | 判据没对准交付物 |

两次都**靠人记得**才可能发现，而 v0.3.0 那次是**用户追问**「确定各平台都验过了吗」
才查出来的 —— 也就是说，那一次人没记得。

### 已经做成结构性的那一半

本仓判据：**「一个需要人记得去填的参数，等价于一个迟早不会被填的参数。」** 清单同理。
所以「发布前跑过四条腿」不写成清单，写成**凭证 + 闸门**：

- **凭证**：每条腿三平台全绿后，发一个 artifact，名字是
  `e2e-attest-<leg>-<bundleRunId>`（`scripts/ci/emit-e2e-attestation.mjs`）。
  发凭证的 job `needs:` 全部平台且**不带任何 `if:`** —— 任何平台失败/跳过，
  它自己被跳过，**凭证根本不存在**（与 `bundles-complete`、`merge-manifest` 同一形状）。
- **判定落在名字上**，不在文件内容上：消费方只问「这个名字在不在」。
  名字里带 `bundleRunId` ⇒ **换一批包就是另一个名字，旧凭证自动失效**。
  这正是事故里缺的东西 —— 在此之前，「跑过 e2e」是一个**没有宾语**的句子。
- **闸门**：`release-upload.yml` 的 `e2e-gate` job，`upload` `needs:` 它
  （`scripts/ci/verify-e2e-attestation.mjs`）。四条腿的凭证不齐 ⇒ **没有上传这回事**。
  查不到、查不动、腿名对不上 —— **一律拒绝**；缺省是拒绝，不给"看起来没问题"留位置。
  只对含 `bundle-*` / `bundles-complete` 的 run 生效，且**跳过时会明说为什么跳过**
  （静默跳过的闸门等于没有闸门，PROTOCOL §11）。

### 刻意**没有**做的那一半，以及依据

**没有让每次 `build-bundles` 都自动跑四条腿。** 依据：

1. **多数 `build-bundles` 跑不是为了发布**（调试、单腿 `legs=linux`、改打包脚本）。
   四条腿 × 三平台是十几个 job，每条腿还要真下几百 MB 后端并真跑转写 ——
   把它挂在每次构建上，绝大多数开销买不到任何判断。
2. **「发布前」与「每次构建」是两个不同的时机。** 判据要挡的是"发出去的东西没验过"，
   不是"构建过的东西没验过"。挂错时机会让闸门变得昂贵又不精确。
3. 昂贵而多数时候无意义的门禁，最终会被人用 `legs=` / 跳过参数绕开 ——
   **那时它就变成了一条被删掉的守卫**，而这正是本仓反复吃亏的形状。

所以正确的形状是：**构建随便跑，发布必须查。** 闸门在发布那一侧，且不可绕过。
