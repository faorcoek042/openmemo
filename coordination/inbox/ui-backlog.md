# inbox / ui-backlog

## [2026-08-07 15:05] T-165 DONE —— 点名两条 + §3 前端那部分

---

# TL;DR（Manager 只读这里）

| # | 事 | 用户此前会遇到什么 | 撤掉后变红？ |
|---|---|---|---|
| **①** | **`/runtime` 对已装的包显示「安装 119 MB」** | 装好的东西界面说没装，点下去把 119 MB 重下一遍 | ✅ **7 条变异全红** |
| **②** | **自测结果的三条 UI 分支** | 点了自测、`passed:true / 18.6x`，**刷新一下什么都没有** | ✅ **3 条变异全红**（含"点了之后界面不变"那条） |
| **③** | **`inapplicableKind` 白做了**（§3 A-3） | 「还没探测到」和「确认不支持」在屏幕上**长得一模一样**，用户以为自己机器不支持就不装了 | ✅ 2 条变异全红 |
| **④** | **「推荐」徽章零信息量**（§3 A-2） | `[实测 :10000]` 本机适用的 **6 个包全部**戴「推荐」徽章 + 主按钮 | ✅ 2 条变异全红 |
| **⑤** | **`/diagnostics` 在界面上没有常驻入口**（§3 B-12 的侧栏那半） | 只有**已经出问题**的人才找得到诊断页 —— 而"我想看看现在怎么样"是它的主要用途 | ✅ 1 条变异红 |
| **⑥** | 🆕 **一份组件测试的桩键写错了，一次都没命中过** | 无用户症状，但「/runtime 不许中英混排」这条**一直只覆盖了半页** | ✅ 1 条变异红 |

**门禁**（收尾时重跑，含 `daemon-backlog` 同期落地的改动）：
`pnpm -r test` **1259 / 0** · `tsc -b` 0 · `eslint .` 0 · `check:sources` ✔ · `check:orphans` ✔（棘轮基线一个字没动）。
开工基线 1214/0。**+45 里我贡献 24 条**（daemon 9 / web 15），其余是 `daemon-backlog` 同期加的。

**反向验证 16/16**，全部跑在 `/tmp/ui-backlog/rv` 的隔离副本（PROTOCOL §10），**两组都先跑对照组确认全绿**。
脚本可重跑：`/tmp/ui-backlog/reverse-verify.mjs`（web 9 条）、`/tmp/ui-backlog/reverse-verify-daemon.mjs`（daemon 7 条）。

## ⚠️ 两件需要你知道的

1. **`:10000` 现在跑的是 `5372a95a` 且 `dirty:true`（`builtAt` 14:32:32）** —— 也就是说
   **它是从一棵有未提交改动的工作树上构建的**，而那棵树里当时正好有我改到一半的前端。
   我没有构建 `apps/web/dist`（见 §6 纪律申报），但请你在合并完这一轮之后**再重建一次**，
   否则用户看到的可能是任何一个中间态。（这正是 §3 #8 那一条。）
2. **我动了 `packages/shared` 与两处 daemon 文件**，理由和边界见 §5，`git add` 前请逐块看 hunk。

---

# §1 ①「安装 119 MB」—— 我选了哪条修法，为什么

## 1.1 `gates-fix §5.2` 的两条路，我选第 1 条（启动对账）

> 判据（你给的）：**同一台机器上，「装没装」只准有一个回答的人。**

第 2 条（`/api/backends/catalog` 的 `installed` 改成「有 manifest **或** 文件都在」）**过不了这条判据**——
它只让那一格变绿，而同一台机器上：

| 读取方 | 现算之后 |
|---|---|
| `GET /api/backends/installed` | 仍然列不出它（它列的是 manifest） |
| `DELETE /api/backends/:id` | 仍然 **404「未安装该后端包」** → 用户看到「已安装」，点卸载，被告知没装 |
| `GET /api/components` 的 `installedVersion` | 仍然 `null`（`readInstalledVersions` 读 manifest） |
| `recordSelfTest()` | 仍然写不进去（按 id 找 manifest）→ **本轮 ② 那三条分支照样不亮** |

**那不是把两个答案变成一个，是变成三个。**

补一份记录则相反：B 补齐之后上面**四个读取方同时变对**，而"唯一事实来源是 manifest"这条不变 ——
没有引入任何新判据。**顺带还多修一件事**：`resolveBackendTool()`（T-162 `pack-select` 刚归一的那个）
要从安装记录里读 `backend` 与 `priority` 才能排序，没有记录的目录一律落到最后一档 ——
也就是说**这类目录上，T-162 那条修复此前是空转的**。补上记录，用户选的加速后端才真的排得上。

## 1.2 没有造出第三份「已安装」（你点名警告的那点）

判据全部是**安装器精确落点的查表**，不是搜索：

```
by-name/backend/<f.name>                    ← linkByName() 的硬链，安装器对每个文件无条件建
by-name/backend/<unpackDirName(f.name)>     ← 解包目录；安装器是 temp→rename，
                                              所以"目录在"本身就是"解包跑完了"的诚实信号
                                              （这句是安装器自己注释里的原话）
```

`unpackDirName` 是 **`@openmemo/downloader` 导出的那一份**，也正是 `readInstalledPackOrigins()`
反向用来把目录归属回包的那一份。**我没有再写一个"扫盘找已安装"的函数。**

## 1.3 补出来的记录**必须诚实** —— 这一半比"能补上"更重要

"补记录"最容易滑成"照着目录抄一份"，那是**发明一条不成立的证据**，比 `installed:false` 坏得多
（与 `recordSelfTest` 的认领防线是同一条原则）。所以：

- **sha256 是现算的**，不是从目录里抄的。`by-name/backend/<name>` 就是那份归档的字节。
  **算出来对不上就不补** —— 那说明盘上躺着的是**另一个版本**。
  `[实测 :10000]` 真的有这一格：`pipeline.ffmpeg` 指着 `ffmpeg-n7.1.5-…tar.xz/`，
  而目录已经升到 `ffmpeg-n8.1.2-34-…`。把它记成"已安装 media-tools"是把**版本不对**伪装成一切正常。
- **`installedAt` 取那条链的 mtime**，不是 `Date.now()` —— 它不是现在装的。
- `verifiedAt` 才是"现在"：每个文件刚被逐字节校验过，`integrity: 'ok'` 是**挣来的**不是填的。
- `selfTest: null` —— 从来没跑过。
- **只对得上本机 os/arch 的包才参与**。不加这条的话，三个 `ytdlp-*` 在 `backends.json` 里
  **归档文件名逐字相同**（都叫 `yt-dlp`），补一个 linux 的会顺带把 macOS / arm64 那两个也宣布成已安装。

**失败不阻断启动**（一次修补不该把显示问题升级成宕机），**但必须出声**：
补了几个、为什么没补，逐条 `console.warn`。静默的自愈与静默的降级是同一族。

## 1.4 判据写在用例里，不是写在名字里

九条用例里有**四条是阴性对照**，钉的正是"不许乱认"：

```
✔ 单文件包与归档包都被认回来 —— /runtime 不再让用户把已装的东西重下一遍
✔ 判据不是"catalog 那一格变绿"：同一台机器上必须**卸得掉**      ← 这条是两种修法的分水岭
✔ 记录里必须带 priority —— 少了它，用户选的加速后端仍然排不上（T-162 空转）
✔ 补出来的记录不许撒谎：sha256 是现算的，installedAt 是文件的、不是"现在"
✔ 阴性对照一：盘上的字节与目录声明的对不上 → 不认（那是另一个版本）
✔ 阴性对照二：别的平台的包不许被顺带认领（三个 ytdlp 包归档名逐字相同）
✔ 阴性对照三：归档在、解包目录不在（装到一半）→ 不认
✔ 前提自检：真安装写下的记录不许被对账覆盖（它只补，不改）
✔ 前提自检：夹具真的没有预置任何 manifest（否则上面每一条都恒真）
```

---

# §2 ② 自测结果的 UI 分支 —— **确认过了，三条都会亮**；但缺的是第四条

`backlog-work` 把 daemon 侧的回写做了（`recordSelfTest()`，只写 `backend === backendUsed` 的包）。
我把界面这一半**真的跑了一遍**：三条分支（通过徽章 / 失败徽章 / `anyFailed` 横幅）**现在确实会亮**，
不需要改产品代码。**但它们此前一条断言都没有** —— 也就是说"会亮"这件事没有任何东西在守。

补的四条里，**第四条是新钉住的一格**，前三条只是把现状固定下来：

```
✔ 分支一：passed → 通过徽章 + 枚举到的设备数 + 实测 RTF + 出处时间
✔ 分支二：failed → 失败徽章 + **daemon 给的具体原因**，不是"出错了"
✔ 分支三：anyFailed → 顶部横幅；全部通过时不许出现（阳性对照）
✔ 接线：点一次「自检」→ 结果落库 → 徽章**当场**从「没有」变成「自检通过」   ← ★
```

★ 那一条钉的是 `useBackendSelfTestMutation` 的 `invalidateQueries`。
它被删掉时的症状是：请求发了、daemon 也写回了 manifest，**而页面不重新拉 `/backends/installed`**
—— 表现成"点了自检什么都没发生，刷新一下才看到"，**和回写没接上之前肉眼无法区分**。
而所有只断言"POST 发出去了"的用例在那种情况下**照样全绿**（变异 W5 实测：撤掉它，只有这一条红）。

---

# §3 §3 那 24 条的最新状态（**这份是最新的，`backlog-work §3` 的表已过期**）

> 判据没变：用户能不能撞上 > 会不会误导人 > 其它。
> **我处理过的标 ✅ / 🟡；没动的原样保留归属。**

## 🔴 A 组

| # | 项 | 状态 |
|---:|---|---|
| **1** | `/runtime` 对已装的包显示「安装 119 MB」 | ✅ **本轮做掉**（启动对账，见 §1）。⚠️ 它修的是"A 有 B 没有"；`[实测 :10000]` 那台机器上还有**另一格**：manifest 在、但盘上是 ffmpeg **7.1.5** 而目录已升到 **8.1.2** —— 那是「组件更新」的洞，不是这一条，**仍开着**，归 `model-mgmt` |
| **2** | 「推荐」徽章等于零信息量 | ✅ **本轮做掉**（收窄，不重算，见 §4.2） |
| **3** | `inapplicableKind` 白做了 | ✅ **本轮做掉**（并补进契约类型，见 §4.1） |
| **4** | `openmemo-probe` 没有分发通道 | ⬜ 未动。要 release 资产 = 硬边界外。归 `platform-backlog` / `pack-publish` |
| **5** | `ytdlp-macos-arm64` 声明 `arch:"arm64"` 却是 universal2 | ⬜ 未动（`vendor/manifests` 是 `runner-migrate` 的地盘） |
| **6** | `sourceBaseUrl` 是半截 | ⬜ 未动。**核过：web 这一侧不欠债** —— `features/models/api.ts:176` 明写"不提供 custom"并说明了理由，界面上没有任何入口。欠的是 daemon 存了一个零读取方的字段 + 契约里那个 `baseUrl`，归 `model-mgmt` |
| **7** | 组件「回滚」 | ⬜ 产品取舍，归你（写进 ADR） |

## 🟠 B 组

| # | 项 | 状态 |
|---:|---|---|
| **8** | 重建 `apps/web/dist` 并重启 `:10000` | ⬜ **只有你能做，而且现在更急**：demo 正跑在一棵 **dirty 工作树**的构建上（见 TL;DR ⚠️1） |
| **9–11** | 章程 §3 订正块 / `PENDING-USER-DECISIONS §D` / `SECURITY.md §0` | ⬜ 归你 |
| **12** | C6 诊断页换 `/api/selfcheck` + `/diagnostics` `/components` 进侧栏 | ✅ **两半都齐了**。换数据源那半**在我开工前就已经做完了**（`DiagnosticsPage.tsx:169` 真打 `/api/selfcheck`，T-150 有 3 条用例钉着）—— §3 把它记成"L（换数据源）未做"是**过期信息**。侧栏那半本轮补上：**只加 `/diagnostics`，`/components` 刻意不加**（理由见 §4.3） |
| **13** | B8 `hf-mirror` 的口径 | ⬜ 归 `model-mgmt` |
| **14** | B2 `markmap-lib` / `markmap-view` 删不删 + `MindmapView` 那句「切到大纲视图」 | 🟡 **查清了，没动，理由见 §4.4 —— 需要你一句话拍板** |
| **15** | C7 老安装记录补 `role` 迁移 | ⬜ 归 `model-mgmt` |
| **16** | B7 ANE 真机验证 | ⬜ 归 `pack-publish` |

## 🟡 C 组（17–24）

⬜ **一条未动**，全部是需要你拍板的（`backlog-work §3` 的建议我没有异议）。

---

# §4 前端那几条的做法与判据

## 4.1 `inapplicableKind`：**它白做了的机制是「契约类型里没有这个字段」**

daemon 的 `rest/backends.ts` 花了一整段注释把「不可用」拆成三档并**真的发出来**，
它自己写明了要防什么：*"用户看到不可用会以为自己的机器不支持，然后就不装了。"*

`[实测 :10000]`：`whispercpp-vulkan-linux-x64` 的档位是 **`undetermined`**（probe 还没跑成），
而界面给它渲染的芯片文案是 **「不可用」** —— **它想防的那件事，就是它自己造成的。**

**为什么长期没人发现**：`GetBackendCatalogResponse` 里**根本没有 `inapplicableKind`**。
daemon 发、前端收不到、**TypeScript 一个字都不说**。
这与「写得进读不回 / 前后端键名对不上」（HANDOFF ⑤C，五次）是同一族 ——
只是这次丢在**类型**上而不是序列化上：发送方与接收方之间没有共享的类型，就没有任何东西在守这条线。

所以修法是**先补契约**（`packages/shared/src/api.ts` + `openapi.yaml`），
再把 daemon 那份本地定义改成从 shared 引用（**两份声明 = 迟早漂移**）。

界面上：三档各有各的芯片与解释，`undetermined` 用 info 档而不是 muted ——
否则"待检测"和"本机不支持"在视觉上还是一个样子，**拆开就白拆了**。

**缺档位时刻意不兜底成 `unsupported`**：默认值的选法与 `isUsableAsset`「字段缺失 ≠ 不可用」方向相反，
判据是同一条 —— **哪个默认值会让界面说一句不成立的话**。
"本机不支持"是一句关于用户硬件的结论，没有证据就说它，正是这个字段当初要防的那件事。
（变异 W2 专钉这一格。）

⚠️ **顺手查出、没修**：那条 `undetermined` 的原因文案是
「请先安装 CPU 基础包，安装后会自动重新探测」——**而这台机器上 CPU 包早就装了**。
它来自 `packages/runtime`，是 `platform-backlog` 的地盘，我没碰。记在这里免得下一个人以为是界面写的。

## 4.2 「推荐」徽章：**只收窄，不重算**

`[实测 :10000]` 本机适用的 6 个包**全部** `recommended:true` ——
因为它们的 `backend` 都是 `cpu`，而选中的后端就是 `cpu`。一页六个徽章 + 六个主按钮。

我**没有**在前端重算"该装哪个"（那会变成第二份结论，两份必然漂移）。
做的是一次**收窄**：服务端说不推荐的永远不会变推荐；服务端说推荐、**但用户根本没得选**时不渲染。

"有没有得选"的判据是**同一引擎、同一平台、还有别的后端**：
- `engine` —— ffmpeg 不是 whisper 的"备选"，拿它当备选是胡说；
- `os/arch` —— 别的平台的包不是这台机器的选项；
- `backend` 不同 —— 同一后端的两个包不构成"选哪种加速"的问题。

**刻意不看 `applicable`**：probe 结果会随安装状态翻转，徽章跟着忽明忽暗只会让人以为界面在抖，
而"有没有得选"这件事并不随之改变。

结果：`whisper.cpp`（CPU vs Vulkan）留下徽章，`ffmpeg` / `yt-dlp` / `libsimple` / `sqlite-vec` 四张卡摘掉。

⚠️ 第一版的页面级断言我写成**数整页有几个「推荐」**，结果被 `StatusChip` 的嵌套 `<span>` 蒙对
（外层与内层 `textContent` 都是「推荐」，1 个徽章数成 2）。**改成逐张卡断言**。
——「数出来的数字对不上」这次是幸运的，它至少红了；如果嵌套是偶数层，这条断言会**恰好通过**。

## 4.3 `/diagnostics` 进侧栏，**`/components` 刻意不进**

`/diagnostics` 全仓唯一的入口是 `ReadinessBanner` 里那个按钮，而那条横幅**一切正常时渲染 `null`**
—— **只有已经出问题的人才找得到诊断页**，而"我想看看现在到底怎么样"是它的主要用途，
章程要求 2.1 的最后一步写的就是"显示状态"。

`/components` **不加**，这是查过之后的决定不是漏了：它已经有一个入口（`/runtime` 页头，T-140 补的），
而 D-10 §3.2 的 R3 是「同一问题只准一个出处」。诊断页不同 —— 它现在的出处数是 **0**。

断言钉的是 `aria-current`「**恰好一项高亮**」而不是"这条链接在"：
`activeNavTarget` 存在的理由就是至多一项，而"加进侧栏却忘了登记进高亮判定"的症状恰恰是
**它不亮、别人替它亮**，且什么都不报。

## 4.4 🟡 markmap / 「切到大纲视图」—— 查清了，**需要你一句话**

`MindmapView.tsx:187` 渲染的是：

> 「切到**大纲视图**将不显示 {{edges}} 条关联线与 {{summaries}} 个概要」

`[实测]` **产品里没有大纲视图**：`toMarkmap` / `toMarkdown` 在 `apps/web` 里**零调用方**，
`markmap-lib` / `markmap-view` 两个依赖同样零 import。也就是说这句话在描述一个用户**做不到的动作**的后果。

**我没有直接删掉它，原因是这一条被两件事锁住了**：

1. 删掉这句就没人调 `markmapLoss` 了 → 它变成零引用导出 → **`check:orphans` 的棘轮基线会从 72 变 73，当场红**。
   要么同一次把 `adapters/markmap.ts` 一起摘掉，要么动基线 —— 两件都不是我该单方面决定的。
2. **改文案改不出真话**：这两样东西（关联线、概要）在产品**现有的任何一条路径上都不会丢**
   （SVG/PNG 导出走的是 mind-elixir 的实时画布，它们都在）。
   也就是说没有一句"真的、且有用"的话可以替换它 —— **正确的动作是整块拿掉，连同 markmap 依赖**。

**不决会怎样**：思维导图面板会继续对每一个用户提到一个不存在的「大纲视图」，
并且两个零 import 的依赖继续挂在供应链上（License / 审计面）。
**建议**：连同 §3 #14 一起交给 `oss-scout` 一次做完（摘依赖 + 摘 `adapters/markmap.ts` + 摘这句话 + 降基线）。

## 4.5 🆕 顺手抓到的一条：**一份组件测试的桩，一次都没命中过**

`components.test.tsx` 的 `stubRuntimePage()` 里硬件那一格的键写的是 `'/hardware'`，
而 `useHardwareQuery()` 打的是 **`/runtime/hardware`**（T-153 把它提升到 `lib/api/hardware.ts` 时换的路径）。
于是那份桩**从来没有匹配过任何请求** → 查询 404 → `hw` 恒 `undefined` → **`<HardwareCard>` 一次都没被渲染过**。

后果：「/runtime 不许中英混排」这条**一直只覆盖了半页**，而**少覆盖的那部分不会有任何东西告诉你**
（HANDOFF ⑤A-18 的同一形状：断言跑过了，但跑的不是它以为的那段）。

修了键，并补了一条**探针的探针**：断硬件卡里那些**只可能来自桩数据**的字段（`Stub CPU`），
不是"页面渲染出来了"。变异 W9 实测：键写回去，这条当场红。

---

# §5 交付文件（**请 `git add` 后用 `git diff --cached --name-only` 逐条核对**）

## 契约（新碰的地盘，申报）

```
packages/shared/src/api.ts       + export type InapplicableKind + catalog pack 上的可选字段
packages/shared/openapi.yaml     + inapplicableKind（enum + 为什么可选）
```

> ⚠️ `packages/shared/src/backends.ts` **是 `daemon-backlog` 在改的**，我一个字没碰 —— 我只动了 `api.ts`。

## daemon（申报：开工时 `git status` 干净，中途 `daemon-backlog` 出现在 `hardware.ts` / `runtime/setup.ts` / `pipeline/setup.ts` / `pipeline/tools.ts`，**这些我都没碰**）

```
apps/daemon/src/http/rest/backendReconcile.ts       ★ 新增：启动对账（判据全在文件头）
apps/daemon/src/http/rest/backendReconcile.test.ts  ★ 新增：9 条（其中 4 条阴性对照）
apps/daemon/src/http/rest/state.ts                  + reconcileBackends()（create() 里调一次）
apps/daemon/src/http/rest/backends.ts               InapplicableKind 改为从 shared 引用；导出 currentPlatform()
```

⚠️ **`state.ts` 与 `backends.ts` 我只加了独立的块**，没动别人那几行。
⚠️ `state.ts` 里那个 import **必须保持静态**：daemon 的 dist 目前没有任何对本地模块的动态 `import()`，
   这条性质保证了"重建产物时正在跑的进程不会半新半旧"（`gates-fix §8` 靠它才敢重建 dist）。
   注释已经写在 import 上方。

## web

```
apps/web/src/features/runtime/packStatus.ts               ★ 新增：档位与推荐的纯决策
apps/web/src/features/runtime/components/BackendPackCard.tsx  用档位渲染芯片 + 解释行；推荐由外部传入
apps/web/src/features/runtime/RuntimePage.tsx             算 recommendedIds 并传下去
apps/web/src/components/common/BackendChip.tsx            + 3 个状态（not-installed 含义收窄）
apps/web/src/App.tsx                                      侧栏 + /diagnostics
apps/web/src/app/i18n/locales/{zh-CN,en}.json             + runtime.chip ×3、runtime.kind ×2、nav.diagnostics
                                                          （只在原位追加，既有键顺序一个没动）
apps/web/src/test/components.test.tsx                     +15 条；并修掉 stubRuntimePage 那个从没命中的桩键
```

**新增的 `src/**/*.test.ts`：0 个**，所以 `apps/web/tsconfig.test.json` 无需改动
（我加的用例都在走 vite 那条道的 `components.test.tsx` 里）。

**未 commit、未 push**（没接到指令）。

---

# §6 反向验证（16/16，两组都在 `/tmp/ui-backlog/rv` 的隔离副本）

**共享工作树全程没有坏过一秒** —— 变异打在副本的**源码**上再重新编译，不是改 dist。
锚点在源文件里必须**恰好出现一次**，否则脚本当场报错拒绝乱改。

## web 组（`reverse-verify.mjs`，对照组 265/265 先绿）

| 撤掉什么（= 缺陷原状） | 红在哪 |
|---|---|
| W1 三档合并回一句话 | 4 条：undetermined 被说成「不可用」/ unsupported / platform / **三档互不相同** |
| W2 缺档位时兜底成 `unsupported` | 1 条：「没给档位时不许替它说话」 |
| W3 `isMeaningfulRecommendation` 改回 `pack.recommended` | 3 条 |
| W4 `RuntimePage` 不再把收窄结果传下去 | 1 条：接线 |
| W5 自检后不再 `invalidateQueries` | 1 条：**只有"点了之后界面真的变"那条红** |
| W6 `selfTest` 拿不到卡片 | 3 条 |
| W7 `anyFailed` 恒假 | 1 条 |
| W8 侧栏拿掉 `/diagnostics` | 1 条 |
| W9 硬件桩的键写回 `/hardware` | 1 条：**我新补的那条探针的探针** |

## daemon 组（`reverse-verify-daemon.mjs`，对照组 9/9 先绿）

| 撤掉什么 | 红在哪 |
|---|---|
| D1 启动时不再对账 | **5 条** |
| D2 不再核对 sha256 | 阴性对照一（"盘上是另一个版本"） |
| D3 不再按 os/arch 过滤 | 阴性对照二（三个 ytdlp 归档名相同） |
| D4 不再要求解包目录存在 | 阴性对照三（装到一半） |
| D5 `installedAt` 写成"现在" | 「补出来的记录不许撒谎」 |
| D6 `priority` 不进记录 | 「T-162 空转」那条 |
| D7 已有记录也重写一遍 | 「它只补，不改」 |

⚠️ 三条变异（D2/D4、W3）**刻意写成类型合法的恒假条件**（`&& f.name === '__never_matches__'`、
`return true || …`），不是 `if (false)`。理由：`backlog-work` 上一轮踩过 ——
**变异后编译不过只证明"改坏了编译不了"，不证明测试抓得住**。
脚本里对"编译不过"这种情况**判为变异体无效并算作存活**，不让它冒充红灯。

**把名字遮住之后这些断言什么时候会失败**（自问自答）：
- W1/W2 → 有人把三档合回一句话，或者在没有证据时替 daemon 断言用户的硬件不支持；
- W3/W4 → 有人把收窄改回原样（六个徽章），或者算了却没传下去；
- W5/W6/W7 → 自检结果到不了界面的**任何一段**：没回写、没重新拉、横幅条件写坏；
- W8 → 侧栏那条被拿掉，或加了却没登记进高亮判定；
- W9 → 组件测试的桩接错层/写错键（**这一条守的是别的用例的有效性**）；
- D1–D7 → 对账被拿掉，或者被放宽成"看见目录就认"（四条阴性对照各守一个放宽方向）。

---

# §7 我核过、但**没有**采信别人自述的几处

| 别人写的 | 我怎么核的 | 结论 |
|---|---|---|
| `gates-fix §5.2`「B 的写入方全仓只有 `startPackInstall()` 一处」 | 自己扫 `writeManifest('backend'` | ✔ 属实（本轮之后是两处：多了对账，且它只写"缺的那些"） |
| `progress-audit §4⑪`「`inapplicableKind` 前端零命中」 | `grep` + **读契约类型** | ✔ 属实，**并查出机制**：契约类型里根本没这个字段（他们没说这一层） |
| `progress-audit §4⑩`「22 个包里 21 个声明 cpu」 | 打 live `/api/backends/catalog` 逐条数 | ⚠️ **订正**：目录现在 **23** 个包，本机**适用的 6 个**全部 `recommended:true`。方向对，数字与口径都变了（Vulkan 包 08-07 才进目录） |
| `backlog-work §2.6`「三条 UI 分支现在会亮」 | **真的渲染了一遍**（4 条用例） | ✔ 属实。但**此前一条断言都没有**，等于没人守 |
| `§3 #12`「C6 换数据源 = L，未做」 | 读 `DiagnosticsPage.tsx` + 跑 T-150 那 3 条 | ❌ **过期**：换数据源那半**早就做完了**，只欠侧栏 |
| `§3 #6` `sourceBaseUrl`「前端有半截」 | 读 `features/models/api.ts` | ⚠️ **订正**：web 这一侧不欠债，它明写"不提供 custom"并说明了理由。欠的全在 daemon + 契约 |
| 用户症状「`/runtime` 对已装 ffmpeg 显示 Install 119 MB」 | 打 live `/api/backends/catalog` | ⚠️ **今天在 demo 上已经不复现**（`media-tools-linux-x64` 有 manifest）。但 119 MB = `totalSizeBytes 124,917,816` **逐字对得上**，而产生它的那个中间态按设计可复现 —— 所以修的是机制不是那一次现象 |

---

# §8 纪律申报

| 条 | 结果 |
|---|---|
| `apps/web/dist` | ✅ **未构建**。`vite build` 我只以 `--ssr … --outDir .test-out/{components,host}` 的形式跑过（那就是 `pnpm test` 自己那条命令），**从未不带 `--outDir` 跑过**；`npx tsc -b` 对 web 的 `outDir` 是 `dist-types/`（已 gitignore）。⚠️ `index.html` 的 mtime 是 `14:31:34`，与 daemon 的 `builtAt=06:32:32Z` 差 62 秒、且它报 `commit 5372a95a dirty:true` —— **那是你在我工作期间的一次重建+重启，不是我** |
| `pnpm -r build` / `pnpm build:safe` | ✅ 未跑（`build:safe` 被沙箱拦下，我改用 `npx tsc -b`，效果等价且不碰 web 产物） |
| `:10000` | ✅ **只发过 GET**（`/api/health`、`/api/backends/catalog`、`/api/components`）。未重启、未 kill、未占用；**没有起过任何 dev server**（本轮不需要，组件测试就是渲染真组件） |
| `/root/data-memo` | ✅ 未读未写 |
| 指针文件 | ✅ sha256 仍是 `7f930979b85204d4c05b221f4c17a5cf5936a4d432a46488816727f60da233f3`（逐字节与 `gates-fix` 记录的相同）。新增用例在**模块顶层**钉 `OPENMEMO_MODELS` / `OPENMEMO_EXT_DIR` 到 `mkdtemp`（PROTOCOL §9-bis，窗口为零，无清理代码） |
| `pkill -f` | ✅ 未用 |
| release / `gh` | ✅ 未建/未改/未删，`gh` 一次都没用 |
| 本机 whisper 转写 | ✅ **一次都没跑**。自检那几条用例全部只渲染前端，`recordSelfTest` 那一侧不是我这轮碰的 |
| 反向验证 | ✅ 全部在 `/tmp/ui-backlog/rv`，共享工作树没有坏过一秒 |
| `daemon-backlog` 的地盘（`hardware.ts` / `runtime/setup.ts` / `pipeline/setup.ts` / `selfTestRecord.test.ts`） | ✅ **一个字未碰** |
| `platform-backlog` 的地盘（`packages/pipeline/**`、`.github/**`、`scripts/ci/**`、`vendor/manifests/**`） | ✅ **一个字未碰**（`vendor/manifests` 只读过） |
| `packages/shared/src/backends.ts` | ✅ 未碰（`daemon-backlog` 在改）。我只动了 `api.ts` 与 `openapi.yaml` |
| `HANDOFF.md` / `00-CHARTER.md` / `BOARD.md` / `ROSTER.md` / `docs/adr/**` / `PENDING-USER-DECISIONS.md` / `README.md` / `SECURITY.md` | ✅ 一个字未改 |
| 别人的 inbox | ⚠️ **在 `backlog-work.md §3` 表头上加了两行指针**（指向本文件 §3），因为你要求"别让下一个人重做"。**没有改他们的任何一行内容。** 若你认为这违反 PROTOCOL §1，删掉那两行即可，本文件 §3 是完整的 |
| 派出的 subagent | 0 个 |

---

# §9 中途撞到的别人的中间态（记下来免得下一个人去查一个不存在的 bug）

`npx tsc -b` 在 14:2x 报过 7 条：

```
apps/daemon/src/http/rest/selfTestRecord.test.ts(94,48): error TS2345:
  Argument of type 'string' is not assignable to parameter of type 'SelfTestClaim'
```

**不是我的** —— `SelfTestClaim` 是 `daemon-backlog` 正在往 `hardware.ts` 里加的类型，
几分钟后自己没了。与 `backlog-work` 上一轮撞到的 `toInstalledRecord` 那次同族。

---

## [2026-08-07 16:20] T-165b DONE —— markmap 整块摘除 + 自测「跑通了」≠「加速用上了」

# TL;DR

| # | 事 | 结果 |
|---|---|---|
| **A** | **markmap 整块摘除**（§3 B-14，你拍板） | ✅ 依赖 + 适配器 + 文案 + 词条一起走。**⚠️ 一处必须偏离你的指令，见下** |
| **B** | **卡片上显示这次自测实际用的是哪个后端**（`daemon-backlog` T-166 转达） | ✅ 并且把「跑通了」与「加速真的用上了」**分成两档**渲染 |

**门禁**：`pnpm -r test` **1265 / 0** · `tsc -b` 0 · `eslint` 0 · `check:sources` ✔ ·
`check:orphans` ✔ —— **零引用导出 72（基线 72），没有变大**，且 `markmap` 在报告的**每一档里零命中**。

**反向验证累计 22/22**（web 15 + daemon 7），全部在 `/tmp/ui-backlog/rv` 隔离副本，对照组先绿。

---

## ⚠️ A-0 必须偏离你指令的一处：**`toMarkdown` 不能删，它在产品路径上**

你的执行要求写的是：

> `toMarkmap` / `toMarkdown` / `markmapLoss` 一起走，别留半截

**`toMarkdown` 不能走。** 我上一轮的措辞害了这一条 —— 我写的是
「`toMarkmap` / `toMarkdown` 在 **`apps/web`** 里零调用方」，那句话是对的，
但它在 **daemon** 里有调用方，而且是用户点得到的功能：

```
apps/daemon/src/http/rest/content.ts:428
  case 'md': case 'markdown':
    return { body: toMarkdown(doc, { includeTimestamps: true }), mime: 'text/markdown…' };
```

即 `GET /api/notes/:uid/export?what=mindmap&format=md`，前端入口在
`features/notes/ExportMenu.tsx:43`。**删掉它 = 导出 Markdown 当场 500。**

`toMarkdown` 也确实不属于 markmap：它是 `serialize/` 那一族（MD / OPML / FreeMind），
与 `toOpml` / `toFreeMind` 同级；只是当年的注释把它写成"与 markmap 的桥"，
才让它看起来像 markmap 的一部分（那句注释本轮改掉了）。

**所以摘除范围 = markmap 适配器 + 依赖 + 文案，不含 `serialize/markdown.ts`。**
这一点我在守卫用例里写成了**显式的阳性对照**，免得下一个人照着你那句话再删一次：

```
assert.equal(typeof mod['toMarkdown'], 'function', '前提自检：导出端点用的 toMarkdown 不许被误删');
```

## A-1 删了什么

```
删  packages/mindmap/src/adapters/markmap.ts        toMarkmap / markmapLoss / escapeHtml / IPureNode
改  packages/mindmap/src/index.ts                   去掉再导出 + 写清为什么摘、以及 toMarkdown 为何保留
改  packages/mindmap/src/mindmap.test.ts            删掉「markmap 适配器」整个 describe（3 条）
改  packages/mindmap/src/timecode.test.ts           见 A-2（这条有损失，我说清楚）
改  packages/mindmap/src/types.ts                   两处现在时的"markmap 也是消费者"改成事实
改  packages/mindmap/src/serialize/markdown.ts      删掉"且是与 markmap 的桥"，补上它真正的调用方
改  apps/web/src/features/mindmap/MindmapView.tsx   删掉那句提示（**删不是改写**，理由写在原位）
改  apps/web/src/features/mindmap/README.md         两节 markmap 内容 → 一节"为什么没有大纲视图"
改  apps/web/src/app/i18n/locales/{zh-CN,en}.json   删 mindmap.markmapLoss
改  apps/web/package.json                           删 markmap-lib / markmap-view
改  pnpm-lock.yaml                                  **-649 行**（markmap 拖着 cheerio / katex / markdown-it / d3-flextree 一整棵树）
```

**文案是删不是改写**，按你说的。理由写在删除处的注释里：那两样东西（自由连线、概要）
在现有的**任何**一条路径上都不会丢（SVG/PNG 导出走 mind-elixir 的实时画布），
所以**没有一句真话可以拿来替换它** —— 改写只会产生第二句需要读者判断真假的话。

### lockfile 的处理方式（申报）

用的是 **`pnpm install --lockfile-only`**，不是 `pnpm install`。
理由是 PROTOCOL §10 的同一条判据（"在最坏的那一秒，别人看到的是什么"）：
`daemon-backlog` 与 `platform-backlog` 正在跑 `pnpm -r test`，
一次真装会在他们脚下换 `node_modules`。
`[实测]` `/root/memo/node_modules` 的 mtime 前后逐字未变（`1786002434`）。
代价：那两个包的**文件**还留在 `node_modules` 里，下一次真装才会被清掉 —— 没有任何东西 import 它们。

## A-2 `timecode.test.ts` 有**损失**，我不打算糊过去

那个文件是一条真事故的护栏：`formatTimestamp` 曾有两份，
`adapters/markmap.ts` 给 `1:30`、`serialize/markdown.ts` 给 `01:31`。它有三层：
① 基准向量 ② **两个导出器互相比对** ③ 结构守卫（只许有一份实现）。

**markmap 一走，第 ② 层就没有第二方了。** 我把它降级成"钉住 Markdown 这一条"，
并在文件头**写清楚哪一段空了**：

> 原来那条能抓住"有人把两份实现又拆开、且写得不一样"，现在抓不住了 ——
> 这一格改由第 ③ 条承担，而它只在**新出现一份定义**时红，抓不住"改坏了唯一那一份"。
> 那一格由第 ① 条的基准向量守。**三层各守一段，删掉一层就该说清楚哪一段空了。**

保下来的那一半是**载重**的：`toMarkdown` 就是导出端点真正吐给用户的字节，
断言里那个 `[1:30]` / 不许出现 `01:31` 会**逐字**出现在用户下载到的 `.md` 里。

## A-3 棘轮：**没有变大**，而且 markmap 从每一档里消失了

```
零引用导出 72 个（基线 72 个）· 只有测试引用 15 个 · 只被再导出 21 个
✔ 没有新的零引用导出，基线也没有过期条目
```

`pnpm check:orphans | grep -i markmap` → **零命中**（此前 `toMarkmap` / `escapeHtml`
落在「只被再导出、零真实产品调用方」那一档里）。

⚠️ **一处我不敢把功劳算在自己头上**：「只被再导出」那一档前后都是 21。
`daemon-backlog` 同期落了 T-166，新增的导出可能正好补上了我摘掉的位置。
**我没有单独测量过这个差值，所以不声称"它因为我而变小"** —— 我能证明的是
"没有变大" + "markmap 零命中"，那两条是实测的。

## A-4 守卫：**两个方向的"半截"都钉住**

「半截」才是这一族真正的失败形态，而且两个方向都真实存在过：
- 删了依赖没删文案 → 界面继续提一个不存在的视图；
- 删了文案没删依赖 → 两个零 import 的包继续挂在供应链上，
  而且下一个人会以为"既然依赖还在，那视图大概是要做的"，把文案加回来。

所以 4 条断言**同时**覆盖：`package.json` 的依赖、`@openmemo/mindmap` 的导出、
两份 locale 的词条、以及**渲染出来的界面**。手法与 `peaks.test.ts` 那条
「不许再导出 mockPeaks」同族。

⚠️ 界面那条**刻意喂一份带 `edges` 与 `summaries` 的文档** ——
缺陷版本正是靠这两个字段非零才显示那句话，拿空文档去测**把缺陷放回去也照样绿**。

---

# B 卡片上要看得出「这次自测实际用的是哪个后端」

## B-1 先认一件事：我上一轮那 4 条断言，钉的位置是对的，前提是错的

`daemon-backlog` 查出：认领规则 `pack.backend === outcome.backendUsed` 里，
左边是枚举 `'cpu'`、右边是 whisper 的**日志文字** `'CPU'` / `'CPU (ggml-cpu-zen4)'`
→ **恒不相等 → 恒拒绝回写 → `selfTest` 恒 null**。
也就是说我上一轮"确认三条 UI 分支确实会亮"时，**它们在真机上一次都没亮过**。

我钉的是渲染分支（那一层是对的、现在也仍然对），**但前提在更下游，我没有下探到那一层**。
教训记在这里：**"我确认它会亮"必须问一句"喂给它的那个形状，产品真的产得出来吗"。**
T-164 那 6 条用例喂的 `backendUsed: 'cpu'` 就是产品从不产出的形状。

## B-2 现在加的这一档：「跑通了」≠「加速真的用上了」

`daemon-backlog` 的那句判据我照抄进了代码注释：

> **一张 Vulkan 卡片写着"自测通过"、而它其实静默跑的是 CPU ——
> 这两种情况在界面上目前无法区分。**

新增 `selfTestVerdict(packBackend, selfTest)`（`packStatus.ts` 纯函数）：

| 档 | 何时 | 卡片上 |
|---|---|---|
| `passed` | 跑通 + 枚举到设备（或它本来就是 CPU 包） | 绿「自检通过」 |
| **`passed-not-accelerated`** | 跑通、**但零设备**、且这不是 CPU 包 | **黄「跑通了，但加速没有生效」+ 一句解释** |
| `failed` | 真失败 | 红（不变） |

外加**无条件原样显示** `backendUsed`：「实际用上的后端：CPU (ggml-cpu-zen4)」。

## B-3 ★ 判据用 `devicesFound`，**一个字符串都不比**

这一条是从 T-166 那个 bug 里直接抄的教训，写在函数注释里：

> `backendUsed` 是**日志文字**，不是 `Backend` 枚举。拿它做判断就是把刚修好的坑再挖一遍。
> 判据是 `devicesFound`（枚举不会撒谎，R-02 §A.0），
> `backendUsed` 只**原样显示** —— 显示原文永远诚实，解析它才会出错。

有一条用例专门钉这个手法：喂 `backendUsed: 'Llvmpipe (LLVM 17, 256 bits)'`
（一个谁都不认识、且不含 "CPU" 字样的字符串）+ 零设备，**正确实现必须仍然判成"加速没生效"**。
任何"看文字里有没有 CPU"的实现在这一条上当场红。

**并且每一条用例喂的都是 `parseBackendUsed()` 真会产出的那几种形状**
（`'CPU (ggml-cpu-zen4)'` / GPU 设备名 / 字段缺失），不是我自己造的 `'cpu'`。

## B-4 三条阴性对照（防的是把它做过头）

- **CPU 包**枚举到 0 个 GPU 设备是正常的 → **不许**报"加速没生效"（假红灯会训练人忽略告警）；
- **真枚举到设备**时不许报警，且两种情况渲染出的文本**必须不同**（否则等于没区分）；
- **老记录没有 `backendUsed`**（T-166 之前写下的）→ 一个字都不说，不编
  —— 与 `inapplicableKind` 缺失时不许兜底成"本机不支持"是同一条判据。

---

# 反向验证（本轮新增 6 条，累计 22/22）

| | 撤掉什么 | 红在哪 |
|---|---|---|
| W10 | 把那句「切到大纲视图…」放回界面 | 界面守卫 |
| W11 | markmap 依赖放回 `package.json` | 依赖守卫 |
| W12 | **探针的探针**：把守卫里的禁用名换成一个确实还导出着的名字 | 导出守卫 —— 证明它**能**红 |
| W13 | 「跑通了」与「加速用上了」合并回一句 | 2 条（含那条"不许解析 backendUsed"） |
| W14 | 不再原样显示 `backendUsed` | 2 条（含阳性对照） |
| W15 | 对 CPU 包也判"加速没生效" | 假红灯那条 |

W12 值得单独说：`@openmemo/mindmap` 在隔离副本里是经 `node_modules` 软链解析到**真包**的，
所以"把适配器加回去"这种变异在副本里做不出来。改成变异**守卫自己**
（禁用名换成 `toMindElixir`，一个确实还在的导出）—— 它红了，就证明 `name in mod`
这个机制真的在检查一个活模块，而不是在一个空对象上恒真。

---

# 你转达的第三件：`smallestInstalledModel()` 选中 VAD 权重

我这一侧对得上：我加的那档 `passed-not-accelerated` 与它**不冲突也不掩盖** ——
它产出的是 `passed:false`（`bad magic`），走的是红色失败分支并**原样显示 daemon 给的原因**，
上一轮那条用例（「失败徽章 + daemon 给的具体原因，不是"出错了"」）正好钉着这一格。
修在 daemon 侧，界面这边不需要再动。

# 纪律申报（增量）

| 条 | 结果 |
|---|---|
| `apps/web/dist` | ✅ 未构建（`vite build` 仍只以 `--outDir .test-out/…` 跑过） |
| `pnpm install` | ⚠️ **只跑过 `--lockfile-only`**，`node_modules` mtime 前后逐字未变（见 A-1 末） |
| `:10000` | ✅ 本段全程**零请求** |
| `docs/design/**` · `docs/adr/**` | ✅ 未碰。D-01 / D-02 / D-05 / ADR-006 里关于 markmap 的段落**仍是旧的**，需要你或 `architect` 同步；`features/mindmap/README.md` 里已注明"读到那几段时以本节为准" |
| `daemon-backlog` / `platform-backlog` 的文件 | ✅ 未碰（`docs/design/D-11-*` 的改动是他们的） |
