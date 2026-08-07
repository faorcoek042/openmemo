# inbox / daemon-backlog

## [2026-08-07 15:05] T-166 DONE —— 自检按包钉住 + 一条「修好了但产品路是死的」

---

# TL;DR（Manager 只读这里）

## 最重要的一条不在任务书上：**T-164 的自检回写，在任何真实机器上都写不进去**

`gates-fix §5.3` / T-164 把「自检结果回写 `InstalledBackendPack.selfTest`」做了、
用例 6 条全绿、反向验证也红过。**但它在产品里一次都没生效过，而且是必然的。**

认领规则是
```ts
if (asked.backend !== outcome.backendUsed) { 拒绝写 }
```
`asked.backend` 是 `Backend` 枚举（`'cpu'`）。
`outcome.backendUsed` 由 `packages/runtime/src/selfTest.ts` 的 `parseBackendUsed()`
从 whisper 的 **stderr** 里解析，真实取值是 `'CPU'` / `'CPU (ggml-cpu-zen4)'` /
GPU 设备名 / `null`。**`'CPU' !== 'cpu'`** → 这条比较恒真 → **恒拒绝写** →
`selfTest` 照旧永远是 null → 「通过徽章 / 失败徽章 / anyFailed 横幅」三条 UI 分支照旧不亮。

**用例为什么没抓到**：它们喂的是 `backendUsed: 'cpu'` —— 一个**产品里不存在的形状**。
> 断言钉的是测试自己造的形状，不是产出方的真实形状。

已修，并留了一条正面护栏：拿 `parseBackendUsed()` 的**真实输出**（喂 whisper 真日志逐字样本）
走完整条认领链。这条护栏必须**正面写出来** —— 因为反过来的断言（"它们相等"）
是一条注定失败的断言，没有人会去写它。

## 点名的两条

| # | 结论 |
|---|---|
| **①** `POST /api/backends/selftest` 不收 pack id | ✅ **做了**。请求体里的 `{id}`（前端每张卡片本来就在发）现在**真的钉住那个包**：跑的是那个包目录里的 whisper-cli，结果**只**记到那个包上；那个包里没有 whisper-cli 就 `blocked` 并点名说明，**绝不回退到别的包再把结果记上去** |
| **②** 给旧安装记录回填 `priority` | ✅ **不写用户的库，也不接目录 —— 而且这是有证据的结论，不是省事**。见下 |

## ② 的结论：**读取侧已经在往对的方向兜底，目录回查救不了真正需要救的那些**

三条实测依据（不是推理）：

1. **今天一条都救不到。** `[实测 vendor/manifests/backends.json]` 12 个包里 priority ≠ 10 的只有两个：
   `whispercpp-vulkan-linux-x64`(80，**今天** `8cb3b35` 才进目录) 与
   `whispercpp-cuda-12.4-win-x64`(90，被 L2 probe 闸门挡着、网页装不上)。
   所以 T-162 之前能装上的记录，catalog priority **全是 10** —— 回填对它们之间的相对顺序**一个字都不改**。
2. **目录回查有结构性缺口，而且缺的正好是最该救的。** `[实测 git log vendor/manifests/backends.json]`
   `181e55b → 07584d9` 之间删掉了 5 个 `llamacpp-*` 加速包（priority 70–90）。
   **一条"缺 priority 就回查目录"的兜底，恰恰查不到已经被移出目录的那些包。**
3. **本机唯一可能出现的混合态，现在的默认值方向就是对的**：
   老 CPU 记录（无 priority → 0）遇上新 Vulkan 记录（80）→ **加速包赢**，正是 `priority` 想要的结果。

→ 所以：**不写用户的库**（`catalog-truth` 的先例成立），**也不把目录读进 `packages/pipeline`**
（那还要再造一个"vendor/manifests 在哪"的解析器 —— 本轮明令禁止的那件事）。
剩下的真实风险只有一个：**有人"顺手简化" `?? 0` 的方向**。已用两条断言正面钉住，
反向验证 M4 撤掉它必红。

## 插队那条：`meta.sameSource: model.vad 本地=warn 端点=ok` —— ✅ 已修，根因如你所判

T-149 把 `role=vad` 挪进 `by-name/vad/`，**只改了 daemon 那一边**。
`packages/pipeline` 的 `discoverTools()` 一直在按**三个写死的文件名**翻 `by-name/asr/`。
daemon 出口读 `bundle.tools.vadModel`（被 `resolveWhisperVadModel()` 覆盖过 → ok），
CLI 出口直接用 `discoverTools()` 的答案（→ warn）。

**用户侧后果不在自检里**：`vadModel` 从有值变 `null` → **离线转写的静音切分静默降级为固定窗口**，
断句变差，而模型页、安装记录、sha256 **全绿**。

⚠️ **没有只改那一行**（你点名要求的）：只把桶名改对的话，两边的**规则**仍然不同
（这边是固定名单、那边是"后缀+关键词"），上游发 `v7` 时会**再分叉一次**，而且仍然只有 CLI 那边哑掉。
所以规则收成**一份** `findWhisperVadWeights()`（桶 `vad`→`asr`→扁平旧布局；`*.bin` 且含 `silero`；
`isGgmlModelFile` 收口），daemon 那边的 by-name 兜底改成调它。
新增 `vadSameSource.test.ts`：每个场景**拿同一个 store 问两个出口，断言两个答案逐字相同**
—— 这是 `meta.sameSource` 的离线版，不需要跑着的 daemon 就能在 CI 上红。

## 「把没有变成有」之后，我回头扫了谁在拿它的缺席当前提（你交代的）

**扫出来一条真的**，而且它会变成比原来更坏的形状：

`apps/daemon/src/runtime/setup.ts` 的 `smallestInstalledModel()` 给自检挑 ASR 模型，
规则是「`by-name/asr/` 下按体积升序取第一个 `.bin`」。而 T-149 之前 VAD 权重就躺在这个桶里，
**它是这个桶里最小的那个**（silero ≈ 1 MB，whisper base ≈ 140 MB）→ 老布局的机器上**稳定**被挑中
→ whisper 拿 VAD 网络去转写 → `bad magic` → 自检 `passed:false`。

以前撞不上，**因为自检结果从来没落过库**：点一次看到一句失败，刷新就没了。
回写接通之后，同一个错误会变成一张好包卡片上**持续的**"自检失败"红字。已修（排除 `silero`，
与 `pipeline/setup.ts` 里 ASR 权重那条规则逐字相同）。

另外扫到一条**说谎的注释**并订正：`http/rest/backends.ts` 文件头写着
「★ 诚实边界：`selfTest` 恒为 `null`」—— 这句现在不成立了。

## 顺手清掉一个我自己制造的孤儿

`findInstalledModel()` 的唯一调用方被换成 `findWhisperVadWeights()` 之后成了零调用方导出。
**删了**（`D-08 §D12` 两轮前就点过它「又把 VAD 文件名写死了」——它今天以 `meta.sameSource` 红线的形式兑现）。
`check:orphans` 三档里第三档不会因为我多出一条。

## 门禁

`pnpm -r test` **1259 / 0** · `tsc -b` 0 · `eslint .` 0 · `check:sources` ✔ · `check:orphans` ✔（基线未动）
开工基线 1214/0。**+45 里我贡献 21 条**（pipeline 8 / daemon 13），另外 24 条是 `ui-backlog`(T-165) 同期加的。

**反向验证 11/11**，全部跑在 `/tmp/daemon-backlog/rv` 的隔离副本（PROTOCOL §10），
**先跑对照组**（4 组全绿）。脚本 `/tmp/daemon-backlog/rv.mjs` 可重跑。逐条见 §4。

## ⚠️ 边界申报：共享工作树里同时有别人在改

开工时 `git status` 干净。中途出现、**不是我的**：
`apps/web/**`、`packages/shared/{openapi.yaml,src/api.ts}`、`apps/daemon/src/http/rest/state.ts`、
`apps/daemon/src/http/rest/backendReconcile.{ts,test.ts}`、`apps/web/src/features/runtime/packStatus.ts`
（`ui-backlog` T-165）；`.github/workflows/build-backends.yml`、`scripts/build-*.sh`、
`scripts/ci/**`、`scripts/lib/`、根 `package.json`（`platform-backlog` / `runner-migrate`）。

**两处真的重叠**（都申报过，`git add` 请逐 hunk 看）：
- `apps/daemon/src/http/rest/backends.ts` —— `ui-backlog` 在改 `InapplicableKind` 搬家（第 8–30 行、第 71–85 行）；
  **我只改了文件头那段注释**（订正"`selfTest` 恒为 null"），两块不相交。
- `packages/shared/src/backends.ts` —— 我加了一个**可选**字段 `BackendSelfTest.backendUsed?`。

中途撞到过**两次**别人写到一半的红（记在这里免得下一个人去查一个不存在的 bug）：

1. `backendReconcile.test.ts` 8 条红，成因是**他们自己夹具里的 mirror URL 不在 host 白名单**
   （`packs.N.files.0.mirrors.0.url: host must be one of …`）。几十分钟后自己没了，与本轮改动无关。
2. **收工那一刻 `tsc -b` 变红 3 条，不是我。** 成因是 §3 B-14（删 `markmap-lib`/`markmap-view`）
   正在进行中：`packages/mindmap/src/adapters/markmap.ts` **已被删**、`index.ts` 与
   `mindmap.test.ts` 已跟上，而 `timecode.test.ts:28` 那句 `import { toMarkmap } from
   './adapters/markmap.js'` **还没删**：
   ```
   packages/mindmap/src/index.ts(22,15):        TS2307 Cannot find module './adapters/markmap.js'
   packages/mindmap/src/mindmap.test.ts(13,52): TS2307 同上
   packages/mindmap/src/timecode.test.ts(28,27):TS2307 同上
   ```
   `git status` 显示 `packages/mindmap` 下的三处改动**都不是我的**（我这一轮没碰过这个包）。
   我自己那次完整门禁（`tsc -b` 0 / `eslint` 0 / `pnpm -r test` **1259 / 0**）跑在这次删除**之前**，
   删除之后我又重跑了一次 `pnpm -r test`：**仍是 1259 / 0**（dist 未重编，红只在类型层）。
   → 请 `oss-scout` 把 `timecode.test.ts` 那条 import 收掉。

---

# §1 ① 自检钉住某一个包 —— 改法与判据

## 1.1 钉住写在**唯一那个解析器**里，没有造第 N 个

`BackendToolPreference` 加一个可选 `packId`。**语义是硬限制，不是偏好**：

| | 找不到时 | 依据 |
|---|---|---|
| `selectedBackend`（T-162） | **回退 + 出声** | 不回退的话，一个装了一半的包会把整条转写链打死；而这个函数同时在解析 ffmpeg / yt-dlp |
| `packId`（T-166） | **返回 `null`** | 它回答的是"**这一个**包行不行"。回退等于换个包去跑，再把结果记到用户点的那张卡片上 —— **发明一条不成立的证据** |

配套两格，都容易漏：
- **扁平命中也要先证明属于那个包**：`by-name/backend/<name>` 是所有单文件包共用的一格，
  不查来源就等于"钉住"被一个同名文件绕过去（反向验证 M2）。
- **钉住时 `degraded` 恒 false**：不回退就没有"退了一档"这回事，报真会变成一个
  永远说不清指向谁的假红灯（M3）。

## 1.2 自检侧：钉住时**只**认那个包给的二进制

环境变量 `OPENMEMO_WHISPER_CLI` 与 `bin/runtime` 里的手工布局**都不属于任何包**。
钉住时拿它们去跑，认领只能落空（`packId` 为 null），用户点了自测却什么都记不下来 ——
而他看到的是"跑了"。所以钉住时这两条路一律不走。

> ⚠️ 这一格是**反向验证逼出来的**：M6 第一轮**存活**。追下去发现在原来的夹具里它是
> **等价变异**（`bin/runtime` 空、环境变量已清，两个分支算出来的东西逐字相同）。
> 补上夹具之后它才有分辨力，然后红了。
> —— 照 `pack-select §5.2` 那条：**一条存活的变异不一定说明测试不够，也可能说明那条变异什么都没改。**

## 1.3 认领依据换成**结构**

`runBackendSelfTest()` 现在交出 `packId` / `packBackend`，来源是
`resolveBackendTool()` 按安装记录把二进制所在目录反查回包 —— **与任何日志文字、任何目录名关键词无关**。
`recordSelfTest(modelsDir, { packId, requestedId }, outcome)`：

- `packId === null` → 不写（二进制不属于任何已装包），并说清楚为什么；
- `requestedId !== packId` → 不写（用户点的是 A，实际跑的是 B）。这条是**防线**不是主路径，
  钉住之后本不该发生；它红了说明钉住那一层被绕开了；
- 否则写进 `manifests/backend/<packId>.json`。

## 1.4 记录里多了一格 `backendUsed`（`BackendSelfTest.backendUsed?`，可选）

钉住之后出现了一种以前不存在的状态：跑的**确实**是 Vulkan 包里的 whisper-cli，
而 ggml 在这台机器上没枚举到设备、优雅退回 CPU 算完了 —— `passed` 为真，**加速没有生效**。
只记 `passed:true`，卡片上那句"自检通过"就变成一条不成立的证据。

`devicesFound: 0` 是同一件事的另一半证据（枚举不会撒谎），两个一起看才完整。

> **对 `ui-backlog` 的影响**：`BackendPackCard` 现在**能**拿到 `selfTest.backendUsed` 了。
> 建议在"自检通过"徽章旁把它显示出来（尤其当 `pack.backend !== 'cpu'` 而 `backendUsed` 是 CPU 时）。
> 我没有动 `apps/web` 一个字。

---

# §2 插队那条（VAD）的完整定性

| | 位置 | 改前 | 改后 |
|---|---|---|---|
| 桶 | `by-name/` | 只翻 `asr` | `vad` → `asr` → 扁平旧布局 |
| 名 | — | 三个写死的文件名 | `*.bin` 且含 `silero` |
| 收 | — | `isGgmlModelFile` | 不变（读头四字节，正是 whisper 自己会检查的东西） |
| 实现份数 | — | **2 份**（daemon 一份、pipeline 一份，规则不同） | **1 份**，daemon 那边改成调它 |

daemon 侧独有的两层证据（环境变量覆盖、按 `role` 读安装记录）**保留**，排在兜底之前 ——
它们只会让 daemon 找到**更多**，不会让两边给出不同的 `status`。
`resolveWhisperVadModel()` 原本的"名字对得上、内容不是 ggml"诊断也没丢：
`findWhisperVadWeights()` 收了一个 `onRejected` 回调，那条
「用户装了 VAD，结果比没装更糟」的告警照常出声。

**顺手把一个字面量也消掉了**：daemon 那边原来最后兜底写死 `ggml-silero-v6.2.0.bin`，
现在由同一条规则覆盖扁平旧布局，少一个会过期的名字。

---

# §3 `backlog-work §3`（剩余 24 条）里我处理过的条目 —— 状态更新

> ⚠️ **我没有去改 `coordination/inbox/backlog-work.md`**（PROTOCOL §1.3：不改他人交付物）。
> 下表按它的编号给出状态，请 Manager 合并时以此为准。
>
> ⚠️ **收工前 HEAD 动了两次**（`3ef8734` T-167①、`f7fef9c` T-165），
> `ui-backlog` 已在 `backlog-work §3` 上加了一条"本表已过期"的指针，并报 A-1/A-2/A-3 做掉。
> **A 组那几行以他们的 `ui-backlog.md §3` 为准，不以我下表为准** —— 我只对
> 「我未碰」这半句负责。我全部改动都是在这两次提交**之后**重跑的门禁（1259/0）。

| §3 编号 | 项 | 我这轮的状态 |
|---:|---|---|
| — | （不在 §3 上）**T-164 自检回写在真机上恒失败** | ✅ **已修 + 已加根因护栏**。这是本轮最重的一条 |
| — | （不在 §3 上）`meta.sameSource: model.vad` | ✅ **已修**（插队项），两个出口现在共用一份规则 |
| — | （不在 §3 上）自检的 ASR 模型会挑中 VAD 权重 | ✅ **已修**。它是回写接通之后才会显形的 |
| **A1** | `/runtime` 对已装 ffmpeg 显示「Install 119 MB」 | ✅ **`ui-backlog` T-165 做掉了**（`f7fef9c`，`backendReconcile.ts`）。**我未碰** |
| **A2** | 「推荐」徽章零信息量 | ✅ **`ui-backlog` T-165 做掉了**（`f7fef9c`）。**我未碰** |
| **A3** | `inapplicableKind` 白做了 | ✅ **`ui-backlog` T-165 做掉了**（`f7fef9c`，类型搬进 `@openmemo/shared`）。**我未碰** |
| **A4** | `openmemo-probe` 没有分发通道 | ⛔ 我做不了（要建 release 资产）。⚠️ 收工前 `3ef8734`（T-167 ①「探针随包出厂」）落地了，这一条**可能已经解了**，请以那份回执为准 |
| **A5** | `ytdlp-macos-arm64` arch 声明 | ⛔ `vendor/manifests/` 是 `platform-backlog` 地盘，未碰 |
| **A6** | `sourceBaseUrl` 是半截（`models.ts:953` 唯一写入、零读取） | ❌ **未做**，预算用完了。结论不变：`progress-audit` 建议删（连同 `SelectSourceRequest.baseUrl`），我同意。⚠️ `ui-backlog` 报「A-6 在 web 这一侧不欠债」——**daemon 侧那个零读取的字段仍然在**，两句话说的不是同一半 |
| **A7** | 组件「回滚」 | ⛔ 产品裁决（写进 ADR） |
| **B15 / C7** | 老安装记录补 `role` 迁移 | ❌ **未做**，但给出定性：**与 ② 同形，而且更没得救** —— `roleMap.ts` 文件头自己写着「搬文件才需要迁移；不看目录就不需要」，四个读取方全部已改成扫全桶按 `role` 判。真正进 `skippedWithoutRole` 的是**记录里压根没有 `role` 字段**的那些，读取侧**无从补**（信息不在盘上），只能回查目录。**是否值得，与 ② 是同一道题**，建议一起裁。⚠️ 我**没有**在真实数据目录上核过 `skippedWithoutRole > 0`（`/root/data-memo` 禁碰）→ `[未验证]` |
| **C19 / B4** | `unpackArchive` 失败自清 → 写进契约 + 断言 | ❌ **未做**，预算用完 |
| 其余 | — | 未碰，状态与 `backlog-work §3` 相同 |

**清了几条说几条：§3 那 24 条里我直接动了 0 条**，本轮的价值全在
「点名的两条 + 插队那条 + 顺着它们挖出来的三条 §3 上没有的真缺陷」。
其中 T-164 那条的性质值得单说：**它在 §3 上被记为"已修掉的 7 条之一"，而它没有生效过。**

---

# §4 反向验证（11/11，全部在 `/tmp/daemon-backlog/rv` 的隔离副本）

共享工作树全程没有坏过一秒：变异打在**副本的源码**上再 `npx tsc -b` 重编，不是改 `dist`。
锚点在源文件里必须**恰好出现一次**，否则脚本当场报错拒绝乱改；
变异体一律**类型合法的恒假条件**（`=== '__never_matches__'`），不用 `if (false)` ——
编译不过证明不了任何关于断言的事（`backlog-work` 的教训）。

```
=== ⓪ 对照组：未变异的副本必须全绿
  ✔ packages/pipeline: exit=0 pass=8 fail=0
  ✔ apps/daemon(selfTestPin):    exit=0 pass=6 fail=0
  ✔ apps/daemon(vadSameSource):  exit=0 pass=6 fail=0
  ✔ apps/daemon(selfTestRecord): exit=0 pass=7 fail=0
```

| 撤掉什么（= 缺陷原状） | 结果 | 红在哪（真实输出节选） |
|---|---|---|
| **M1** `packId` 对目录的硬过滤（钉住 = 无效果） | ✔ 红 **5 + 2** | `✖ ★ 同一份布局：钉 cpu 得 cpu 包，钉 vulkan 得 vulkan 包`、`✖ ★ 同一份磁盘布局：点 CPU 卡片测 CPU 包，点 Vulkan 卡片测 Vulkan 包` |
| **M2** 钉住时也允许扁平命中 | ✔ 红 1 | `✖ ★ 单文件包的扁平命中也要先证明它属于那个包` |
| **M3** 钉住时仍报 `degraded` | ✔ 红 1 | `degraded 报了真 —— 那会变成一个永远说不清指向谁的假红灯` |
| **M4** 缺 `priority` 按"高于任何已知值"处理（② 的方向反过来） | ✔ 红 1 | `缺 priority 的默认值被改成了"高于已知值" —— 老 CPU 包会把新装的加速包顶掉` |
| **M5** 自检忽略 `packId`（回到 T-164：id 只是候选） | ✔ 红 2 | `钉住 whispercpp-vulkan-linux-x64 却解析到了 …/whisper-bin-ubuntu-x64/whisper-cli` |
| **M6** 钉住找不到时回退到别的包 | ✔ 红 1 | `钉住 whispercpp-cpu-linux-x64 却跑了 …/bin/runtime/whisper-cli —— 那个二进制不属于任何包` |
| **M7** 自检 ASR 模型不再排除 silero | ✔ 红 1 | `自检挑了 …/by-name/asr/ggml-silero-v6.2.0.bin 当 ASR 模型` |
| **M8** `discoverTools` 回到只翻 `by-name/asr` | ✔ 红 **3** | `✖ ★ T-149 之后的正式位置 by-name/vad/ —— 缺陷原状下 CLI 那边是 null` |
| **M9** VAD 判据回到固定文件名清单 | ✔ 红 1 | `✖ ★ 上游发一个新版本号也不许把任何一边打哑` |
| **M10** 认领规则回到 T-164 的字符串比对 | ✔ 红 **4** | `没写成：你点的是 whispercpp-cpu-linux-x64，而这次实际跑的是 whispercpp-cpu-linux-x64 包里的 whisper-cli` ← 恒假比较的原样复现 |
| **M11** 不再把 `backendUsed` 记进安装记录 | ✔ 红 1 | `selfTest.backendUsed` 为 null |

**把名字遮住之后这些断言什么时候会失败**（自问自答）：
- M1/M2/M5/M6 → 任何人让"钉住"退化成一档偏好，或让钉住的那次走上一条不属于该包的二进制；
- M3 → 任何人让不回退的路径也报降级（假红灯）；
- M4 → 任何人翻转"未知 priority"的默认方向；
- M7 → 任何人拿掉自检 ASR 模型的 silero 排除（含"顺手简化"）；
- M8/M9 → 任何人让两个自检出口的 VAD 规则再次分叉（换桶、或换回文件名清单）；
- M10/M11 → 任何人再拿日志文字当认领依据，或把"跑通了"和"加速用上了"合并成一件事。

## 4.1 我自己踩的两个坑，如实记下

1. **夹具的 ggml 魔数写反了**：`GGML_FILE_MAGIC = 0x67676d6c` 是按 **UInt32LE** 读的，
   落盘应是 `6c 6d 67 67`。我第一版手写 ASCII `'ggml'`（`67 67 6d 6c`），
   于是**两个出口都返回 null，用例"红得很整齐"** —— 差点被读成"这两边确实一致"。
   改成从产出方 `import { GGML_FILE_MAGIC }` 再 `writeUInt32LE`。
2. **反向验证脚手架第一版把跨包变异吃掉了，而且装成了"变异存活"**：
   `apps/daemon/node_modules/@openmemo/pipeline` 是**相对**软链（`../../../../packages/pipeline`）。
   我把整个 `node_modules` 软链回真仓库 → 它解析到**真仓库**的 `packages/pipeline/dist`，
   于是打在副本 pipeline 源码上的变异 daemon 侧一个字都看不见，报出来是 `✘ 存活`。
   改成 `cp -a` 每个包自己的 `node_modules`（保留软链本身），相对链才在副本内闭合。
   → **"变异存活"有三种成因：断言不够、等价变异、以及脚手架根本没把变异送到位。**

---

# §5 交付文件（**请 `git add` 后用 `git diff --cached --name-only` 逐条核对**）

改：
```
packages/pipeline/src/tools.ts                  BackendToolPreference.packId（硬钉）+ findWhisperVadWeights()
                                                + 删除零调用方的 findInstalledModel + ByNameBucket
packages/pipeline/src/index.ts                  导出调整（+findWhisperVadWeights / +ByNameBucket / −findInstalledModel）
packages/shared/src/backends.ts                 BackendSelfTest.backendUsed?（**可选**，老记录没有）
apps/daemon/src/runtime/setup.ts                runBackendSelfTest 接受 packId、交出 packId/packBackend；
                                                smallestInstalledModel 排除 silero
apps/daemon/src/http/rest/hardware.ts           路由把 {id} 钉给自检 + recordSelfTest 换成结构认领 + 响应带 packId
apps/daemon/src/http/rest/backends.ts           ⚠️ **只改文件头注释**（订正"selfTest 恒为 null"）—— 与 ui-backlog 共用此文件
apps/daemon/src/pipeline/setup.ts               resolveWhisperVadModel 的 by-name 兜底改调 pipeline 那一份
apps/daemon/src/http/rest/selfTestRecord.test.ts 改写为结构认领 + 新增「产出方真实形状」护栏（6→7 条）
```

新增：
```
packages/pipeline/src/__tests__/backendPackPin.test.ts   8 条（钉住规则 + ② 排序方向）
apps/daemon/src/runtime/selfTestPin.test.ts              6 条（自检钉包的接线，**一次推理都不跑**）
apps/daemon/src/pipeline/vadSameSource.test.ts           6 条（meta.sameSource 的离线版）
coordination/inbox/daemon-backlog.md                     本文件
```

**未 commit、未 push**（没接到指令）。要我提交就说一声，我按 hunk 挑。

---

# §6 纪律申报

| 条 | 结果 |
|---|---|
| `apps/web/dist` | ✅ **我没有构建过**。全程只跑 `pnpm build:safe`（`--filter "!@openmemo/web"`）、`npx tsc -b`、`node --test`；`vite build` / `pnpm -r build` **一次都没跑**。⚠️ **如实报告一条观测**：`apps/web/dist/index.html` mtime 是 `14:31:34`，晚于我开工（`build-info` 记的 `14:00:03`）——**那不是我**，而且结构上不可能是我：`apps/web/tsconfig.json` 是 `emitDeclarationOnly` + `outDir: dist-types`，`tsc -b` 碰不到 `dist/`。时间上最接近的是 T-165（`f7fef9c`，同一时段在改 `apps/web`），请 Manager 与 `ui-backlog` 对一下 —— 如果那是 Manager 授权的重启前构建就很好（`progress-audit 🔴1` 终于解了），不是的话 PROTOCOL §7 这条线又被跨了一次 |
| `pnpm -r build` | ✅ 未跑 |
| `:10000` | ✅ **一个请求都没发**（连 GET 都没有）。未重启、未 kill、未占用 |
| `/root/data-memo` | ✅ **未读未写**。所有验证走 `mkdtemp` 沙箱与 `/tmp/daemon-backlog/` |
| 指针文件 | ✅ sha256 仍是 `7f930979b85204d4c05b221f4c17a5cf5936a4d432a46488816727f60da233f3`（收工复核）。三个新测试全部在**模块顶层** `delete OPENMEMO_MODELS` 等，窗口为零、无清理代码（PROTOCOL §9-bis） |
| `pkill -f` | ✅ 未用 |
| release | ✅ 未建/未改/未删。`gh` 一次都没用 |
| 本机 whisper 转写 | ✅ **一次都没跑**。`selfTestPin.test.ts` 刻意让夹具**没有 ASR 模型**，自检必然停在 `blocked` ——而"whisper-cli 解析到了谁"恰恰在跑之前就定下来了，`resolved` 里如实带着。夹具里的 `whisper-cli` 是 `#!/bin/sh; exit 0` 的壳，**从未被执行** |
| 反向验证 | ✅ 全部在 `/tmp/daemon-backlog/rv` 隔离副本（PROTOCOL §10），**先跑对照组**；共享树未被改动过一秒 |
| `findInBackendPacks()` / `resolveBackendTool()` | ✅ **没造第二个解析器**。钉住能力加在它自己身上，自检改成调它（此前它自己解析），VAD 也收成一份 |
| `grep -r` 陷阱 | ✅ 全仓扫描用 Node 读 `git ls-files`，**含 NUL 字节的文件单独列出来**（实测 561 个文本 / 82 个二进制），不静默跳过 |
| 空集陷阱 | ✅ 每条"找不到"的断言都配了**阳性对照**（先证明"不钉住时确实找得到一个"），否则 `null` 与"这条路本来就走不通"长得一样 |
| 新增 `src/**/*.test.ts` 登记 | ✅ 本轮新增测试在 `packages/pipeline/src/__tests__/` 与 `apps/daemon/src/{runtime,pipeline}/`，两个包的 tsconfig 都是 `include: ["src/**/*"]`；`tsconfig.test.json` 全仓**只有 `apps/web` 一个**，本轮没有新增 web 测试。两个包的 test 脚本前置守卫（源码 test 数 = dist test 数）本轮**真的响过一次**，所以它是活的 |
| `.github/**` · `vendor/**` · `scripts/**` | ✅ **一个字未改**（`vendor/manifests/backends.json` 只用 Node 读过） |
| `apps/web/**` | ✅ **一个字未改** |
| `HANDOFF.md` / `00-CHARTER.md` / `BOARD.md` / `ROSTER.md` / `docs/adr/**` / `PENDING-USER-DECISIONS.md` / `README.md` / `SECURITY.md` | ✅ 一个字未改 |
| 派出的 subagent | 0 个 |

## SHARED-CHANGE

| 文件 | 归属 | 我做了什么 | 冲突风险 |
|---|---|---|---|
| `packages/shared/src/backends.ts` | `model-mgmt` | `BackendSelfTest` 加一个**可选**字段 `backendUsed?`。可选是刻意的：T-166 之前写下的记录没有它，必填在补齐所有构造点之前红是必然的（PROTOCOL §10 推论） | 低 |
| `packages/pipeline/src/tools.ts` | `pack-select` 刚交付 | `BackendToolPreference` 加可选 `packId`；**不传时行为逐字不变**（有一条阴性对照专门钉这一点）。另删除零调用方的 `findInstalledModel` | 中低（`pack-select` 已交付，树上无其未完成改动） |
| `apps/daemon/src/http/rest/backends.ts` | `model-mgmt` / **`ui-backlog` 在途** | **只改文件头注释**（订正一句已经不成立的话） | ⚠️ **中**：该文件此刻有别人的未完成改动，两块不相交，见边界申报 |
| `apps/daemon/src/pipeline/setup.ts` | `oss-scout` / `gpu-runtime` | `resolveWhisperVadModel` 的 by-name 兜底改成调 pipeline 那一份，**结论不变、少一份实现** | 低 |

---

# §7 需要 Manager 决策 / 转达

1. **（转 `ui-backlog`）`BackendPackCard` 现在拿得到 `selfTest.backendUsed`。**
   建议在"自检通过"徽章旁把它显示出来 —— 尤其 `pack.backend !== 'cpu'` 而 `backendUsed` 是 CPU 时。
   否则一张 Vulkan 卡片上的"自检通过"与"它真的用上了 Vulkan"长得一模一样。
   `devicesFound: 0` 已经在渲染，两个一起看才完整。**我没有动 `apps/web`。**
2. **（裁决）老记录回填：`priority`（②）与 `role`（C7）是同一道题，建议一起裁。**
   我这轮对 `priority` 给的答案是"不写、也不回查目录"，依据在 TL;DR 三条实测。
   `role` 那条的读取侧**无从补**（信息不在盘上），要救只能回查目录 ——
   而回查目录同样救不到已被移出目录的包。**建议一并明确"不做，写进 ADR"**，
   否则它会一直以"自检里一条会出声、不会自愈的噪声"的形式挂着，长期训练人忽略自检输出。
3. **（确认）`apps/web/dist` 在 `14:31:34` 被重建过，不是我。** 见 §6 第一行。
   如果那是 Manager 的重启前构建，那很好（`progress-audit 🔴1` 终于解了）；
   如果不是，请查一下是谁 —— PROTOCOL §7 那条线又被跨了一次。
4. **（记账，不需要动作）T-164 那条的教训值得进 HANDOFF：**
   > **一个模块的输出被另一个模块拿去做相等比较时，判据必须来自产出方，不能来自用例。**
   > `'CPU' !== 'cpu'` 这条恒假比较通过了 6 条用例、一轮反向验证和一次交付评审 ——
   > 因为每一条证据用的都是**测试自己造的那个形状**。
