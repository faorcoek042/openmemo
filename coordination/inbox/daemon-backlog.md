# inbox / daemon-backlog

## [2026-08-07 15:05] T-166 DONE —— 自检按包钉住 + 一条「修好了但产品路是死的」

---

# TL;DR（Manager 只读这里）

## 最重要的一条不在任务书上：**T-164 的自检回写，在任何真实机器上都写不进去**

`gates-fix §5.3` / T-164 把「自检结果回写 `InstalledBackendPack.selfTest`」做了、
用例 6 条全绿、反向验证也红过。**但它在产品里一次都没生效过，而且是必然的。**

认领规则是

```ts
if (asked.backend !== outcome.backendUsed) {
  拒绝写;
}
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

| #                                                | 结论                                                                                                                                                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **①** `POST /api/backends/selftest` 不收 pack id | ✅ **做了**。请求体里的 `{id}`（前端每张卡片本来就在发）现在**真的钉住那个包**：跑的是那个包目录里的 whisper-cli，结果**只**记到那个包上；那个包里没有 whisper-cli 就 `blocked` 并点名说明，**绝不回退到别的包再把结果记上去** |
| **②** 给旧安装记录回填 `priority`                | ✅ **不写用户的库，也不接目录 —— 而且这是有证据的结论，不是省事**。见下                                                                                                                                                        |

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

|                            | 找不到时        | 依据                                                                                                           |
| -------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------- |
| `selectedBackend`（T-162） | **回退 + 出声** | 不回退的话，一个装了一半的包会把整条转写链打死；而这个函数同时在解析 ffmpeg / yt-dlp                           |
| `packId`（T-166）          | **返回 `null`** | 它回答的是"**这一个**包行不行"。回退等于换个包去跑，再把结果记到用户点的那张卡片上 —— **发明一条不成立的证据** |

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

|          | 位置       | 改前                                             | 改后                                              |
| -------- | ---------- | ------------------------------------------------ | ------------------------------------------------- |
| 桶       | `by-name/` | 只翻 `asr`                                       | `vad` → `asr` → 扁平旧布局                        |
| 名       | —          | 三个写死的文件名                                 | `*.bin` 且含 `silero`                             |
| 收       | —          | `isGgmlModelFile`                                | 不变（读头四字节，正是 whisper 自己会检查的东西） |
| 实现份数 | —          | **2 份**（daemon 一份、pipeline 一份，规则不同） | **1 份**，daemon 那边改成调它                     |

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

|      §3 编号 | 项                                                         | 我这轮的状态                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -----------: | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
|            — | （不在 §3 上）**T-164 自检回写在真机上恒失败**             | ✅ **已修 + 已加根因护栏**。这是本轮最重的一条                                                                                                                                                                                                                                                                                                                                                                                       |
|            — | （不在 §3 上）`meta.sameSource: model.vad`                 | ✅ **已修**（插队项），两个出口现在共用一份规则                                                                                                                                                                                                                                                                                                                                                                                      |
|            — | （不在 §3 上）自检的 ASR 模型会挑中 VAD 权重               | ✅ **已修**。它是回写接通之后才会显形的                                                                                                                                                                                                                                                                                                                                                                                              |
|       **A1** | `/runtime` 对已装 ffmpeg 显示「Install 119 MB」            | ✅ **`ui-backlog` T-165 做掉了**（`f7fef9c`，`backendReconcile.ts`）。**我未碰**                                                                                                                                                                                                                                                                                                                                                     |
|       **A2** | 「推荐」徽章零信息量                                       | ✅ **`ui-backlog` T-165 做掉了**（`f7fef9c`）。**我未碰**                                                                                                                                                                                                                                                                                                                                                                            |
|       **A3** | `inapplicableKind` 白做了                                  | ✅ **`ui-backlog` T-165 做掉了**（`f7fef9c`，类型搬进 `@openmemo/shared`）。**我未碰**                                                                                                                                                                                                                                                                                                                                               |
|       **A4** | `openmemo-probe` 没有分发通道                              | ⛔ 我做不了（要建 release 资产）。⚠️ 收工前 `3ef8734`（T-167 ①「探针随包出厂」）落地了，这一条**可能已经解了**，请以那份回执为准                                                                                                                                                                                                                                                                                                     |
|       **A5** | `ytdlp-macos-arm64` arch 声明                              | ⛔ `vendor/manifests/` 是 `platform-backlog` 地盘，未碰                                                                                                                                                                                                                                                                                                                                                                              |
|       **A6** | `sourceBaseUrl` 是半截（`models.ts:953` 唯一写入、零读取） | ❌ **未做**，预算用完了。结论不变：`progress-audit` 建议删（连同 `SelectSourceRequest.baseUrl`），我同意。⚠️ `ui-backlog` 报「A-6 在 web 这一侧不欠债」——**daemon 侧那个零读取的字段仍然在**，两句话说的不是同一半                                                                                                                                                                                                                   |
|       **A7** | 组件「回滚」                                               | ⛔ 产品裁决（写进 ADR）                                                                                                                                                                                                                                                                                                                                                                                                              |
| **B15 / C7** | 老安装记录补 `role` 迁移                                   | ❌ **未做**，但给出定性：**与 ② 同形，而且更没得救** —— `roleMap.ts` 文件头自己写着「搬文件才需要迁移；不看目录就不需要」，四个读取方全部已改成扫全桶按 `role` 判。真正进 `skippedWithoutRole` 的是**记录里压根没有 `role` 字段**的那些，读取侧**无从补**（信息不在盘上），只能回查目录。**是否值得，与 ② 是同一道题**，建议一起裁。⚠️ 我**没有**在真实数据目录上核过 `skippedWithoutRole > 0`（`/root/data-memo` 禁碰）→ `[未验证]` |
| **C19 / B4** | `unpackArchive` 失败自清 → 写进契约 + 断言                 | ❌ **未做**，预算用完                                                                                                                                                                                                                                                                                                                                                                                                                |
|         其余 | —                                                          | 未碰，状态与 `backlog-work §3` 相同                                                                                                                                                                                                                                                                                                                                                                                                  |

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

| 撤掉什么（= 缺陷原状）                                        | 结果           | 红在哪（真实输出节选）                                                                                                             |
| ------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **M1** `packId` 对目录的硬过滤（钉住 = 无效果）               | ✔ 红 **5 + 2** | `✖ ★ 同一份布局：钉 cpu 得 cpu 包，钉 vulkan 得 vulkan 包`、`✖ ★ 同一份磁盘布局：点 CPU 卡片测 CPU 包，点 Vulkan 卡片测 Vulkan 包` |
| **M2** 钉住时也允许扁平命中                                   | ✔ 红 1         | `✖ ★ 单文件包的扁平命中也要先证明它属于那个包`                                                                                     |
| **M3** 钉住时仍报 `degraded`                                  | ✔ 红 1         | `degraded 报了真 —— 那会变成一个永远说不清指向谁的假红灯`                                                                          |
| **M4** 缺 `priority` 按"高于任何已知值"处理（② 的方向反过来） | ✔ 红 1         | `缺 priority 的默认值被改成了"高于已知值" —— 老 CPU 包会把新装的加速包顶掉`                                                        |
| **M5** 自检忽略 `packId`（回到 T-164：id 只是候选）           | ✔ 红 2         | `钉住 whispercpp-vulkan-linux-x64 却解析到了 …/whisper-bin-ubuntu-x64/whisper-cli`                                                 |
| **M6** 钉住找不到时回退到别的包                               | ✔ 红 1         | `钉住 whispercpp-cpu-linux-x64 却跑了 …/bin/runtime/whisper-cli —— 那个二进制不属于任何包`                                         |
| **M7** 自检 ASR 模型不再排除 silero                           | ✔ 红 1         | `自检挑了 …/by-name/asr/ggml-silero-v6.2.0.bin 当 ASR 模型`                                                                        |
| **M8** `discoverTools` 回到只翻 `by-name/asr`                 | ✔ 红 **3**     | `✖ ★ T-149 之后的正式位置 by-name/vad/ —— 缺陷原状下 CLI 那边是 null`                                                              |
| **M9** VAD 判据回到固定文件名清单                             | ✔ 红 1         | `✖ ★ 上游发一个新版本号也不许把任何一边打哑`                                                                                       |
| **M10** 认领规则回到 T-164 的字符串比对                       | ✔ 红 **4**     | `没写成：你点的是 whispercpp-cpu-linux-x64，而这次实际跑的是 whispercpp-cpu-linux-x64 包里的 whisper-cli` ← 恒假比较的原样复现     |
| **M11** 不再把 `backendUsed` 记进安装记录                     | ✔ 红 1         | `selfTest.backendUsed` 为 null                                                                                                     |

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

| 条                                                                                                                                    | 结果                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/dist`                                                                                                                       | ✅ **我没有构建过**。全程只跑 `pnpm build:safe`（`--filter "!@openmemo/web"`）、`npx tsc -b`、`node --test`；`vite build` / `pnpm -r build` **一次都没跑**。⚠️ **如实报告一条观测**：`apps/web/dist/index.html` mtime 是 `14:31:34`，晚于我开工（`build-info` 记的 `14:00:03`）——**那不是我**，而且结构上不可能是我：`apps/web/tsconfig.json` 是 `emitDeclarationOnly` + `outDir: dist-types`，`tsc -b` 碰不到 `dist/`。时间上最接近的是 T-165（`f7fef9c`，同一时段在改 `apps/web`），请 Manager 与 `ui-backlog` 对一下 —— 如果那是 Manager 授权的重启前构建就很好（`progress-audit 🔴1` 终于解了），不是的话 PROTOCOL §7 这条线又被跨了一次 |
| `pnpm -r build`                                                                                                                       | ✅ 未跑                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `:10000`                                                                                                                              | ✅ **一个请求都没发**（连 GET 都没有）。未重启、未 kill、未占用                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `/root/data-memo`                                                                                                                     | ✅ **未读未写**。所有验证走 `mkdtemp` 沙箱与 `/tmp/daemon-backlog/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 指针文件                                                                                                                              | ✅ sha256 仍是 `7f930979b85204d4c05b221f4c17a5cf5936a4d432a46488816727f60da233f3`（收工复核）。三个新测试全部在**模块顶层** `delete OPENMEMO_MODELS` 等，窗口为零、无清理代码（PROTOCOL §9-bis）                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `pkill -f`                                                                                                                            | ✅ 未用                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| release                                                                                                                               | ✅ 未建/未改/未删。`gh` 一次都没用                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 本机 whisper 转写                                                                                                                     | ✅ **一次都没跑**。`selfTestPin.test.ts` 刻意让夹具**没有 ASR 模型**，自检必然停在 `blocked` ——而"whisper-cli 解析到了谁"恰恰在跑之前就定下来了，`resolved` 里如实带着。夹具里的 `whisper-cli` 是 `#!/bin/sh; exit 0` 的壳，**从未被执行**                                                                                                                                                                                                                                                                                                                                                                                                   |
| 反向验证                                                                                                                              | ✅ 全部在 `/tmp/daemon-backlog/rv` 隔离副本（PROTOCOL §10），**先跑对照组**；共享树未被改动过一秒                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `findInBackendPacks()` / `resolveBackendTool()`                                                                                       | ✅ **没造第二个解析器**。钉住能力加在它自己身上，自检改成调它（此前它自己解析），VAD 也收成一份                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `grep -r` 陷阱                                                                                                                        | ✅ 全仓扫描用 Node 读 `git ls-files`，**含 NUL 字节的文件单独列出来**（实测 561 个文本 / 82 个二进制），不静默跳过                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 空集陷阱                                                                                                                              | ✅ 每条"找不到"的断言都配了**阳性对照**（先证明"不钉住时确实找得到一个"），否则 `null` 与"这条路本来就走不通"长得一样                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 新增 `src/**/*.test.ts` 登记                                                                                                          | ✅ 本轮新增测试在 `packages/pipeline/src/__tests__/` 与 `apps/daemon/src/{runtime,pipeline}/`，两个包的 tsconfig 都是 `include: ["src/**/*"]`；`tsconfig.test.json` 全仓**只有 `apps/web` 一个**，本轮没有新增 web 测试。两个包的 test 脚本前置守卫（源码 test 数 = dist test 数）本轮**真的响过一次**，所以它是活的                                                                                                                                                                                                                                                                                                                         |
| `.github/**` · `vendor/**` · `scripts/**`                                                                                             | ✅ **一个字未改**（`vendor/manifests/backends.json` 只用 Node 读过）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `apps/web/**`                                                                                                                         | ✅ **一个字未改**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `HANDOFF.md` / `00-CHARTER.md` / `BOARD.md` / `ROSTER.md` / `docs/adr/**` / `PENDING-USER-DECISIONS.md` / `README.md` / `SECURITY.md` | ✅ 一个字未改                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 派出的 subagent                                                                                                                       | 0 个                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## SHARED-CHANGE

| 文件                                    | 归属                                 | 我做了什么                                                                                                                                             | 冲突风险                                                        |
| --------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `packages/shared/src/backends.ts`       | `model-mgmt`                         | `BackendSelfTest` 加一个**可选**字段 `backendUsed?`。可选是刻意的：T-166 之前写下的记录没有它，必填在补齐所有构造点之前红是必然的（PROTOCOL §10 推论） | 低                                                              |
| `packages/pipeline/src/tools.ts`        | `pack-select` 刚交付                 | `BackendToolPreference` 加可选 `packId`；**不传时行为逐字不变**（有一条阴性对照专门钉这一点）。另删除零调用方的 `findInstalledModel`                   | 中低（`pack-select` 已交付，树上无其未完成改动）                |
| `apps/daemon/src/http/rest/backends.ts` | `model-mgmt` / **`ui-backlog` 在途** | **只改文件头注释**（订正一句已经不成立的话）                                                                                                           | ⚠️ **中**：该文件此刻有别人的未完成改动，两块不相交，见边界申报 |
| `apps/daemon/src/pipeline/setup.ts`     | `oss-scout` / `gpu-runtime`          | `resolveWhisperVadModel` 的 by-name 兜底改成调 pipeline 那一份，**结论不变、少一份实现**                                                               | 低                                                              |

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

---

## [2026-08-07 17:10] T-168 DONE —— `backendDir` 单值缺口：**根因就是「未选中」与「不可用」共用一个字段**

---

# TL;DR（Manager 只读这里）

## 你的判断是对的：**是同一个字段，而且连"第二个字段"都不存在**

`BackendStatus` 只有 `available: boolean` + 一格自由文本 `unavailableReason`。
`manager.ts:210` 从 `installed && devices.length === 0` **推断**出"驱动缺失或过旧" ——
这条推断只有在"探针真的看过这个包"时才成立，而 `backendDir` 是单值的，
所以**任何时候装了两个包，其中一个必然没被看过**。

`[本机实测]`（真 `install()` 两个 Linux 包 → 真 `writeManifest` → 真 `prefs.json` →
真 `resolveRuntimeLayout()` + `detectRuntimeHardware()`，数据目录 `mkdtemp`）：

```
selectedBackend = "cpu"
backendDir      = <models>/by-name/backend/whispercpp-cpu-linux-x64
vulkan  installed=true available=false
        unavailableReason="installed but enumerated no devices (driver missing or too old)"
```

**它是假的**，而且探针自己的 stderr 就能证伪：

```
$ openmemo-probe <cpu 包目录>     2>&1 >/dev/null
load_backend: loaded CPU backend from …/libggml-cpu-zen4.so      ← 没有 Vulkan 这一行
$ openmemo-probe <vulkan 包目录>  2>&1 >/dev/null
ggml_vulkan: No devices found.
load_backend: loaded Vulkan backend from …/libggml-vulkan.so
```

CPU 包里**根本没有** `libggml-vulkan.so`（实测目录清单，23 个文件里一个 vulkan 都没有）。
把偏好改成 `vulkan` 再跑，**同一句话逐字不变** —— 而那一次它是真的
（本机有 AMD 核显，但容器里没有 `/dev/dri`，Vulkan ICD 枚举不到物理设备）。

> **同一句话，一次为真一次为假 —— 这个字段承载不了两种状态。这就是根因。**

## 它不止一处出口，而且有一条**闭环锁死**

| 出口                               | 缺陷原状             | 用户看到                             |
| ---------------------------------- | -------------------- | ------------------------------------ |
| `/runtime`「为什么这些后端不可用」 | 原样渲染那句话       | 「驱动缺失或过旧」→ 去折腾没坏的驱动 |
| `catalog` 的 `inapplicableKind`    | 落到 `'unsupported'` | 一个完好的包被标「本机不支持」       |
| `POST /api/backends/select`        | 409 CONFLICT         | **选了 CPU 之后再也选不回 Vulkan**   |

第三条是闭环：选 cpu → 包排序把 cpu 包排最前 → `backendDir` 指向 cpu 包 →
探测报 `vulkan.available=false` → 想选回 vulkan 被 409 拒绝，
**而拦住他的那个 `false`，正是他自己上一次选择造成的**。
唯一出路是卸掉 CPU 包或手改 `prefs.json`。
`[实测]` 这一格是从真实探测结果推出来的（`vulkan.available===false` 是量出来的），
**`[未验证]` 我没有起 daemon 发真的 HTTP 请求**，改后的行为由 7 条路由级用例钉住。

## 修法：给这两种状态各一格，**不动选择逻辑**

`BackendStatus` 新增**必填**字段 `probed: boolean` —— 「本次探测**有没有真的加载过**这个后端的库」。
判据是结构性的、可测的：**这个后端的 ggml 库在不在被扫描的那个目录里**
（`ggml_backend_load_all_from_path` 只从那一个目录 dlopen）。
库在而没枚举到设备 = 真的驱动/硬件结论（**这句照旧报得出来**，有阴性对照钉着）；
库不在 = 它没有过机会，**任何关于驱动的话都不许说**。

改后同一台机器：

```
sel=cpu     vulkan reason="installed, but this detection run did not load it: only the backend
                           directory currently in use is scanned (…/whispercpp-cpu-linux-x64),
                           and this backend's library is not in it. This is not a driver or
                           hardware fault — nothing was measured about it. Select this backend,
                           or run the self-test on that pack, to get a real answer."
sel=vulkan  vulkan reason="installed but enumerated no devices (driver missing or too old)"  ← 真结论，保留
```

**为什么必填而不是可选**：这个类型全仓只有一个真实产出方（`buildHardwareInfo`），
两个调用方都是我改的。可选字段允许下一个人跳过它，然后拿到一个**建立在零证据上的、看起来很像样的答案**
—— 那正是本缺陷的形状。必填让编译器替我们问这个问题。
（PROTOCOL §10 推论：必填字段的改动一次提交到位，本轮就是。）

## ★ `backendDir` 该不该改成多值：**不该，而且改了会更坏**（这是结论，不是省事）

建议里的修法是「对每个已装包各跑一次探针取并集」。我**没有**这么做，四条依据：

1. **探针必须描述"真的会被用到的那套运行时"。** `[本机实测]` 探针与 `whisper-cli`
   走的是**同一个** `resolveBackendTool()` 排序，三种偏好下**都落在同一个包目录**：
   ```
   sel=cpu     probe→whispercpp-cpu-linux-x64     whisper-cli→whispercpp-cpu-linux-x64     same=true
   sel=vulkan  probe→whispercpp-vulkan-linux-x64  whisper-cli→whispercpp-vulkan-linux-x64  same=true
   sel=null    probe→whispercpp-vulkan-linux-x64  whisper-cli→whispercpp-vulkan-linux-x64  same=true
   ```
   取并集会报 `vulkan.available=true`，而每一次转写仍然跑在 CPU 包的二进制上 ——
   **这是同一个谎的镜像，而且更坏**：`selectedBackend` 会跟着翻到 vulkan（manager.ts:231
   取"第一个 available"），于是界面说在用 Vulkan、实际在用 CPU。假阴性换成假阳性。
2. **代价是 N × 10s。** macOS 上探针已经在 CI 上稳定超时（D-11 §9.8），并集探测把一个
   尚未定性的超时乘以包数；断路器还是按 `backendDir` 分片的，得跟着重做。
3. **"这台机器到底能不能跑 Vulkan"已经有主了**：advisory 探测（`AdvisoryGpu.candidateBackends`），
   它**按设计不依赖任何包是否安装**，正是 ADR-014 / T-160 用来解环的那路证据。并集不是它的替代品。
4. **并集在常见情形下是冗余的**：`[实测]` Vulkan 包里带着**完整的** `libggml-cpu-*.so` 15 个
   **外加** `libggml-vulkan.so` —— 探加速包的目录本来就把 CPU 一起探了。

> **结构限制保留；改掉的是"拿一次单目录扫描当作对每一个已装包的裁决"。**

## 边界（这次**没有**解决的）

- **没有让"未选中的加速包"在不选中它的情况下拿到真结论。** 要真结论只有两条路：
  选中它，或者对那个包点自测（T-166 已经把 `POST /api/backends/selftest {id}` 钉到具体包）。
  文案里把这两条都写出来了。
- **没有动 `apps/web` 一个字**（照 T-166 的先例）。UI 渲染的就是那句话，源头说真话它就跟着真。
  ⚠️ 但 `probed` 现在拿得到了，见下面「需要 Manager 转达」。
- **没有动包选择逻辑**（`findInBackendPacks` 的排序一个字未改）——
  你的判据里点名不要改它，我复核后同意：选中 cpu 时加速包不被使用是**正确行为**。

---

# §1 改了什么（请 `git add` 后逐条核对）

改：

```
packages/shared/src/hardware.ts        BackendStatus 新增必填 probed: boolean（含判据与实测记录）
packages/shared/src/schemas.ts         zod 镜像 +probed
packages/shared/openapi.yaml           BackendStatus.probed（进 required）
packages/runtime/src/backends/manager.ts       BuildHardwareInfoInput.probedBackends（必填）
                                               + 理由阶梯新增 `!probed` 一档，排在"设备>0"之前
                                               + available ⟹ probed 的不变式
packages/runtime/src/backends/applicability.ts 解环通道的条件从 `!installed` 放宽到
                                               `!installed || !probed`（文件头自己写的前提被证伪）
packages/runtime/src/index.ts                  detectHardware 接上 probedBackendsInDir + 导出
apps/daemon/src/runtime/setup.ts               composeHardware 接上**同一个**函数（不另写一份）
apps/daemon/src/http/rest/backends.ts          inapplicableKind：结构判据排在字符串嗅探前面
                                               + select 闸门改成"有真结论才拒"（解锁死）
packages/downloader/scripts/reference-server.mjs  mock 补 probed + 把编的驱动理由改成实话
packages/runtime/src/backends/applicability.test.ts  夹具补 probed；"装了就不解环"那条补 probed:true
```

新增：

```
packages/runtime/src/probe/probedBackends.ts              扫描器（唯一实现）
packages/runtime/src/backends/notProbedVsUnavailable.test.ts  9 条
apps/daemon/src/http/rest/backendNotProbed.test.ts            7 条
```

## 1.1 判据独立于被测者

`notProbedVsUnavailable.test.ts` 里有一条**不吃我自己的正则**：文件名清单取自
`vendor/manifests/backends.json` 里**真实出厂**的 `providesFiles`，断言
「CPU 包映射不出 vulkan」「Vulkan 包同时映射出 cpu 与 vulkan」。
上游改文件名时它会红，而不是继续报绿（照 `probeShipping.test.ts` §678 那条）。

daemon 侧那条 `★ 判据不依赖文案` 同理：把 `unavailableReason` 抹成空串，
`inapplicableKind` 的结论也不许变 —— 钉住"结构判据排在正则前面"。

---

# §2 反向验证 8/8（全部在 `/tmp/backenddir-gap/rv` 隔离副本，PROTOCOL §10）

**先跑对照组**（未变异副本 9+9+7 全绿，不绿则整轮作废）。变异打在**副本源码**上再
`tsc -b` 重编（不是改 dist）；锚点必须**恰好出现一次**否则脚本拒绝；
变异体一律类型合法的真实表达式。`node_modules` 用 `cp -a` 整棵带过来 ——
软链回真仓库会把跨包变异**吃掉并伪装成"变异存活"**（`daemon-backlog §4.1` 第 2 条）。
脚本 `/tmp/backenddir-gap/rv.mjs` 可重跑。

| 变异（= 缺陷原状）                                    | 结果   | 红在哪                                                                                 |
| ----------------------------------------------------- | ------ | -------------------------------------------------------------------------------------- |
| **M1** `probed` 不再看目录，探针跑了就算探过          | ✔ 红 2 | `✖ 显式选 CPU 时，已装的 Vulkan 包不许被说成驱动有问题` / `✖ 两种情形给出的话必须不同` |
| **M2** 目录扫描不看文件名（"顺手简化"）               | ✔ 红 1 | `✖ 真的读一次磁盘：读不出来的目录必须返回空集` + 出厂清单那条                          |
| **M3** 目录读不到时谎称六个后端都加载过               | ✔ 红 1 | 同上                                                                                   |
| **M4** 解环通道退回只看 `installed`                   | ✔ 红 1 | `✖ T-168：装了、但这次探测根本没加载它 → 那不是裁决`                                   |
| **M5** `inapplicableKind` 退回只嗅探字符串            | ✔ 红 3 | `✖ 装了但这次没探它 → undetermined`                                                    |
| **M6** select 闸门退回「available 不为真就 409」      | ✔ 红 2 | `✖ 装了但这次没探它 → 必须放行`                                                        |
| **M7** ★ 让 `probed` 恒为假（= 把真驱动诊断一起删掉） | ✔ 红 2 | `✖ 阴性对照：探针真的加载过它却没枚举到设备 → 驱动那句必须照旧报得出来`                |
| **M8** 枚举到设备不再蕴含 `probed`                    | ✔ 红 1 | `✖ available 为真时 probed 必须也为真`                                                 |

**M7 是刻意加的**：它证明阴性对照**有牙齿** —— 否则"把驱动诊断整句删掉"也能全绿，
而那是本次改动最像成功的失败方式（把假阳性换成假阴性）。

---

# §3 门禁

`pnpm -r test` **1287 / 0**（开工基线 1270，+17 全是我加的：runtime 9 + daemon 7 + applicability 1）
· `npx tsc -b` **0** · `npx eslint .` **0** · `pnpm build:safe` 全部 Done
· `check:sources` ✔ · `check:orphans` ✔（"没有新的零引用导出"，两个新导出都有引用）

⚠️ **门禁跑在 `9ca6c01` 之后**：开工时 HEAD 是 `e28f5e5`，中途别人提交了
`9ca6c01 feat(ci): 补上 includeOptional 入口 + 让探针超时可诊断`。
逐文件核对**与我零重叠**（他动 `.github/workflows/cold-start-audit.yml`、
`packages/runtime/src/selfcheck.ts`、`scripts/ci/cold-start-audit.mjs`；
我动 `packages/runtime/src/backends/**` 与 `probe/probedBackends.ts`）。
`test:ci-scripts` **没跑**（我一个字没碰 `.github/**` 与 `scripts/ci/**`）。

---

# §4 纪律申报

| 条                                                                                          | 结果                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/dist`                                                                             | ✅ **未构建**。全程只跑 `pnpm build:safe`（输出可见：shared/db/downloader/llm/mindmap/runtime/pipeline/daemon **八个包，没有 web**）、`npx tsc -b`、`node --test`；`vite build` / `pnpm -r build` **一次都没跑**。⚠️ 如实报一条观测（与上一轮同形）：`apps/web/dist/{,assets/,index.html}` mtime 全部是 `16:20:20.7203–.7208`，比 commit `e28f5e5` 的提交时间 `16:20:19` 晚一秒。**`UNKNOWN`：我无法归因**，只能排除自己 —— `build:safe` 按 `--filter "!@openmemo/web"` 过滤，`gen-build-info.mjs` 只写 `apps/daemon/dist/build-info.json`（已读源码确认）。**不猜是谁**，请 Manager 与那次提交的作者对一下 |
| `pnpm -r build`                                                                             | ✅ 未跑                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `:10000`                                                                                    | ✅ **一个请求都没发**。未重启、未 kill、未占用；本轮起的端口只有 node:test 自己的 ≥19000 段                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `/root/data-memo`                                                                           | ✅ **未读未写**。全部验证在 `mkdtemp`（`/tmp/om-backenddir-*`）与 `/tmp/backenddir-gap/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 指针文件                                                                                    | ✅ 开工与收工两次核对，sha256 均为 `7f930979b85204d4c05b221f4c17a5cf5936a4d432a46488816727f60da233f3`，内容仍是 `/root/data-memo`。复现脚本在**第一行**就 `delete` 掉 `OPENMEMO_{MODELS,DATA_DIR,EXT_DIR,PROBE,BACKEND_DIR,WHISPER_CLI,ASR_MODEL,POINTER_FILE}`；新增的 daemon 用例在**模块顶层**钉 `OPENMEMO_MODELS`/`OPENMEMO_EXT_DIR` 到 tmp，窗口为零、无清理代码（PROTOCOL §9-bis）                                                                                                                                                                                                                    |
| `pkill -f`                                                                                  | ✅ 未用（一次 kill 都没有）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| release / `gh`                                                                              | ✅ 未建/未改/未删。只用过一次匿名 `fetch` 列 release 资产名（只读）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 本机 whisper 转写                                                                           | ✅ **一次都没跑**。跑过的二进制只有 `openmemo-probe`（只读枚举，两个目录各一次）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 反向验证                                                                                    | ✅ 全部在 `/tmp/backenddir-gap/rv` 隔离副本，**先跑对照组**；共享工作树未坏过一秒；跑完已 `rm -rf`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 只造一个解析器                                                                              | ✅ `probedBackendsInDir()` 一份实现，`detectHardware()` 与 daemon 的 `composeHardware()` 都调它                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 空集陷阱                                                                                    | ✅ 每条"找不到/不许出现"的断言都配阳性对照（先证明另一种情形下确实找得到），否则 `false` 与"这条路本来就走不通"长得一样                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `.github/**` · `vendor/**` · `scripts/**` · `apps/web/**` · ADR / CHARTER / BOARD / HANDOFF | ✅ **一个字未改**（`vendor/manifests/backends.json` 只用 Node 读过）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 派出的 subagent                                                                             | 1 个（只读扫 `BackendStatus` 的全部消费方，未改任何文件）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## SHARED-CHANGE

| 文件                                                              | 归属                        | 我做了什么                                                                                                                                                                       | 冲突风险                                           |
| ----------------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `packages/shared/src/hardware.ts` + `schemas.ts` + `openapi.yaml` | `model-mgmt`                | `BackendStatus` 加**必填** `probed`。必填是刻意的，理由见 TL;DR                                                                                                                  | 中：契约变更，但全仓只有一个真实产出方，已全部补齐 |
| `packages/runtime/src/backends/manager.ts` / `applicability.ts`   | `gpu-runtime` / `gates-fix` | 加一档理由 + 放宽解环条件。**`applicability.ts` 文件头那套推理没有被推翻**，我改的是它自己写下的一个前提（"装上之后 probe 已经有过机会"）—— 那个前提在单值 `backendDir` 下不成立 | 中低                                               |
| `apps/daemon/src/http/rest/backends.ts`                           | `model-mgmt` / `ui-backlog` | 改了 `inapplicableKind` 与 select 闸门两处；**没碰** `InapplicableKind` 类型、`startPackInstall`、`toInstalledRecord`                                                            | 中：该文件近期多人动过，请逐 hunk 看               |
| `packages/downloader/scripts/reference-server.mjs`                | `downloader`                | mock 补字段 + 改掉编造的驱动理由                                                                                                                                                 | 低（仅开发用参考服务器）                           |

---

# §5 需要 Manager 决策 / 转达

1. **（转 `ui-backlog`）`BackendStatus.probed` 现在拿得到了。**
   `HardwareCard.tsx` 的「为什么这些后端不可用」列表原样渲染 `unavailableReason`，
   源头说真话之后它已经不骗人了，所以**不改也不错**。但两条建议：
   (a) `probed === false` 的那几行语气应当与"真结论"不同（它不是故障，是"没测"）；
   (b) 那句话现在**很长**（含目录全路径），11px 等宽单行会很难看。
   ⚠️ 另有一条与我无关但顺手看到的：`unavailableReason` **完全没有走 i18n**，
   daemon 的英文原样出现在中文界面里；且分隔符写死全角 `：`，英文界面也是它。
   **我没有动 `apps/web`。**
2. **（记账）`applicability.ts:206` 还留着一条字符串嗅探**
   （`(b.unavailableReason ?? '').includes('probe')` 判断"probe 从没跑过"）。
   我**没有动它**：我的新文案不含 `probe` 一词，且该条要求**每一个**后端都匹配，
   与本次改动无交互（已核对）。但它与我这轮删掉的那条是同一族地雷 ——
   建议下一轮换成结构字段，理由与 T-144 相同。
3. **（记账）这次的教训值得进 HANDOFF：**
   > **一个"没有结论"被存进"结论"字段时，它一定会被当成结论读出来。**
   > `available: false` 同时表示「测过、不行」和「压根没测」，于是产品必须**猜**是哪一种 ——
   > 而猜出来的那句话足够具体（"驱动缺失或过旧"），用户会照着去修一个没坏的东西。
   > 判据不是"让它别报错"，是"**报出来的话必须是真的**"；
   > 做法是给"不知道"一个自己的格子，而不是给它挑一句听起来最像的话。
