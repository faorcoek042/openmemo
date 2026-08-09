# dedup-audit 回执

## [2026-08-09 17:06] T-183 DONE（同一用途的多份实现：清单 + 判断，未动手合并）

**审计快照：commit `71459fc`。** ⚠️ 审计期间有四路在改代码，其中**两路正在改我审的东西**
（`packages/pipeline/src/tools.ts`、`apps/daemon/src/runtime/setup.ts`、
`packages/runtime/src/selfcheck.ts`，并新增未跟踪的 `packages/runtime/src/bundledRuntime.ts`）。
下文逐条标注「审计时的状态」与「是否已有在途修复」。

---

## 一、实证：两份实现给出不同答案（3 条，全部我自己跑出来的）

> 这是本轮真正的产出。三条都不是"看起来重复"，是**同一个输入、两个答案**。

### 实证 1 —— "whisper-cli 在哪"，同一时刻两个答案

复现脚本自建一个预编译包布局（包内 `runtime/probe/whisper-cli`，可执行）+ **一个后端包都没装**的数据目录：

```
包内自带的可执行文件： /tmp/…/pkg/runtime/probe/whisper-cli
已安装的后端包：      （无）

A  discoverTools().whisperCli   = /tmp/…/pkg/runtime/probe/whisper-cli   ← 找到了
B  resolveBackendTool()         = null                                    ← 没找到
```

- **A**（`packages/pipeline` 的 `discoverTools`，喂 `GET /api/selfcheck`）认三档：
  已安装后端包 → 系统 PATH → **包内兜底**。
- **B**（`resolveBackendTool`，喂 `POST /api/backends/selftest`）认：
  `OPENMEMO_WHISPER_CLI` → `bin/runtime` 手工布局 → 已安装后端包。**没有包内这一档，也没有系统 PATH。**

→ 用户被告知"缺 whisper-cli"，并被引导去装一个**他已经有**的东西。
与另一路报的现场（`GET /api/selfcheck` 给出路径、`POST …/selftest` 回 409 `resolved.whisperCli: null`）**同一个成因**。
⚠️ 这条**与版本无关地成立**：B 在 committed 与在途两版里都没有包内档（在途正在补，见下）。

### 实证 2 —— "端口是不是空的"，六份实现分两类，答案**相反**

造一个纯 TCP 占用者（bind 住端口但**不答 HTTP** —— 正是残留进程正在关闭时的样子）：

```
类 1「只问 HTTP」   → 端口是空的？ true
类 2「真的去 bind」 → 端口是空的？ false（EADDRINUSE）
```

| 实现 | HTTP 探测 | 真 bind | 判定 |
| --- | --- | --- | --- |
| `scripts/ci/e2e-notes-audit.mjs:~500` | ✔ | ✔ | 最强 |
| `scripts/ci/e2e-browser-audit.mjs` | ✔ | ✔ | 最强 |
| `scripts/ci/e2e-import-audit.mjs` | ✘ | ✔ | 够用（签名是 `(port, why)`） |
| `scripts/ci/e2e-allcomponents.mjs` | ✔ | ✘ | **会误判为空** |
| `scripts/ci/e2e-runtime-audit.mjs` | ✔ | ✘ | **会误判为空** |
| `scripts/ci/e2e-coldstart.mjs` | ✔ | ✘ | **会误判为空** |

**最值钱的一点：这个缺陷已经被其中一份自己写下来了。**
`e2e-notes-audit.mjs` 的注释原文：

> ★ 光问一句 HTTP **不够**。`[实测]` 上一个占用者正在关闭时，HTTP 请求已经连不上
> （看起来"空了"），而**套接字仍然是被占的** —— 于是 daemon 起来一 bind 就失败，
> 悄悄漂到下一个端口去。真正的判据不是"有没有人答话"，是"**我现在能不能占住它**"。

也就是说：**一份实现的注释，正是另外三份实现的判据不成立的证明。** 而那三份至今没跟上。

### 实证 3 —— "把这棵进程树收掉"，同一棵树两个结果

对一棵 `detached` 起的进程树（父 + 子），两份 killTree：

```
A  e2e-runtime-audit.mjs：process.kill(pid, SIGKILL)    父=已死  子=**还活着**
B  launcher-spawn.mjs   ：process.kill(-pid, SIGKILL)   父=已死  子=已死
```

`e2e-runtime-audit.mjs:713` 的本地 `killTree` **少一个负号** —— 只收组长，不收组。
而它启动 daemon 用的正是 `launcher-spawn.mjs` 的 `spawnDaemon`，那里是
`detached: true`（`launcher-spawn.mjs:168`），**daemon 自己就是组长、子进程另在组里**。
A 留下的残留进程正是 PROTOCOL §11 点名的那个假通过源头。

---

## 二、真重复（该合并）

### R-1 「找包内自带的 X」—— 审计时**仍未收敛**，共 **4 个出口**，只合了 2 个

| 出口 | 审计时（`71459fc`）怎么找 | 收敛？ |
| --- | --- | --- |
| 探针目录（`apps/daemon/src/runtime/setup.ts:281`） | `OPENMEMO_BUNDLED_PROBE_DIR` ?? `resolveBundledWhisperDir()`（模块相对） | ✅ |
| `vendor/manifests`（`http/rest/manifests.ts:119`） | env ?? 模块相对上溯 5 层 | ✅ |
| **whisper-cli**（`packages/pipeline/src/tools.ts:904`） | **只读 `OPENMEMO_BUNDLED_WHISPER_DIR`** | ❌ 第三个出口 |
| **自检 `resolveBackendTool()`**（`runtime/setup.ts:1011`） | **压根没有包内这一档** | ❌ **第四个出口（我这轮确认的）** |

→ 回答"今天到底收敛了没有"：**没有。审计时是 2/4。**
第三个出口的症状是「**能不能用取决于你从哪儿启动**」（启动器设 env 才看得见）；
第四个出口更糟 —— **即使经启动器启动，自检也看不见**（实证 1）。

⚠️ **已有在途修复（未提交，非我所做）**：新增 `packages/runtime/src/bundledRuntime.ts`
（`bundledRuntimeDir()` / `isBundledRuntimePath()`），并已接进 `tools.ts:912`、
`runtime/setup.ts:1038`、`selfcheck.ts`。**它的文件头列的三个消费者与我的结论一致**，
且它把"逐层向上找"而不是写死层数 —— 比现有两处的「上溯 5 层」更稳（包内 5 层、仓库 3 层）。
**判定：真重复，方向正确，已在被合并，我不重复动手。**

### R-2 `assertPortFree` —— 6 份，3 份判据不成立

- 位置：`scripts/ci/` 下 `e2e-{notes,browser,import,allcomponents,runtime,coldstart}-audit|.mjs` 各一份（表见实证 2）
- 同一个问题？**是** —— "起服务之前，这个端口是不是真的没人"
- 已矛盾？**是，实测相反**（实证 2）
- **判定：真重复，该合并**

⚠️ **合并方向必须取最强的那个（HTTP + 真 bind），不许按多数**。
"只问 HTTP"是 6 份里的 3 份，**是多数，但它是错的**。
一次照多数收敛，会把 notes/browser 两份**用实测换来的**判据一起抹掉。

### R-3 `killTree` —— 共享实现**早就 export 了**，仍有 5 份本地拷贝，其中 1 份是错的

`scripts/ci/launcher-spawn.mjs` 已经 `export function killTree` (:180) 与 `killTreeHard` (:201)。

| 消费者 | 用共享的？ |
| --- | --- |
| `e2e-import-audit.mjs:65` · `e2e-record.mjs:70` | ✅ import 了 |
| `e2e-coldstart.mjs:58` | ⚠️ **两份并存**：import 了共享的（只用在启动器进程 :967），**另有本地 `killTree` (:222)** 用在 daemon pid |
| `e2e-notes-audit.mjs:101` · `e2e-runtime-audit.mjs:90` | ❌ 只 import `spawnDaemon`，各留一份本地 killTree |

- 已矛盾？**是**（实证 3：`e2e-runtime-audit` 少负号，留下残留子进程）
- **判定：真重复，该合并** —— 而且成本极低：**要用的东西已经导出了，改成 import 即可。**
- 两位先后记过"该提到 `scripts/ci/lib/`"，**审计时 `scripts/ci/lib/` 仍不存在**。
  但我认为**不必新建 `lib/`**：`launcher-spawn.mjs` 已经是事实上的共享层，再搬一次只是换个位置。

---

## 三、刻意不对称（**不许合并**）

### N-1 `noteById` vs `noteByIdIncludingDeleted` —— 已有测试钉着 ✅

`apps/daemon/src/db/repos.softDelete.test.ts:71` 的用例名就写着
「★ 笔记：删之后 `noteByIdIncludingDeleted` 仍然读得到 —— **这个不对称是刻意的**」。
理由（job 中心的标题查找要看得见已删的行，**任务比笔记活得久**）**已经写在代码里，不只在某人脑子里**。
**判定：不许合并，且现状合格，不需要补文档。**

### N-2 `killTree` vs `killTreeHard` —— 是一对，不是重复

`launcher-spawn.mjs` 的两个导出分别是 SIGTERM 与 SIGKILL 两档（Windows 侧对应带不带 `/F`）。
`e2e-notes-audit` 的本地 `killTree(proc, signal)` 是把这两档压成一个参数 —— **形状不同、意图相同**。
**判定：合并到共享的那一对时，不许把两档压成一个**（"先温和后强硬"是刻意的升级顺序）。

### N-3 端口检查的签名差异 **不是**刻意不对称

`(label)` / `(port, why)` / `(port, label)` 三种签名并存，但它们回答的是同一个问题。
签名差异是各写各的的副产物，不是设计。**判定：合并时统一成 `(port, label)`，无需保留差异。**

---

## 四、已经收敛的（**别再动**，列出来是为了不被下一个人重复"发现"）

**CI 取包脚手架 `scripts/ci/resolve-bundle.mjs`** —— 真的抽干净了：
`e2e-{import,coldstart,allcomponents,record,runtime,browser,notes}.yml` 与 `build-bundles.yml`
**8 个 workflow 全部用它**；全仓再没有第二处自己解包/找包根的地方
（`grep unzip/tar/bsdtar` 只命中 `resolve-bundle.mjs` 自己）。
**判定：这一族已收敛，不在待办里。**

---

## 五、UNKNOWN（说不清，留着，列给你）

- **错误码与文案**：`PROVIDER_UNREACHABLE` / `MODEL_IN_USE` / `NOT_A_DATA_DIR` 等出现在
  `apps/web/src/features/models/ModelsPage.tsx`、`packages/shared/src/jobs.ts`、
  `apps/daemon/src/http/rest/{models,storage}.ts`。**产出方与消费方各有一份是正常的**，
  我**没有**找到"同一种失败被翻成两种不同的话"的实证。
  但我这一轮**只做了定位、没有逐码比对文案**，所以**标 `UNKNOWN`，不列为真重复也不宣布干净**。
- `e2e-import-audit.mjs` 的 `assertPortFree` **只 bind、不问 HTTP**：
  少一层"谁在占"的诊断信息，但判据本身是强的。**是刻意精简还是漏写，我判断不了。**

---

## 六、诚实声明

- **只读审计，未合并、未改任何产品代码。** 本轮只新增这一份回执。
- 三条实证均为**我自己写脚本跑出来的**，脚本在 `/tmp/dedup/`（未入仓）：
  `proof.mjs`（whisper-cli 两答案）· `proof3.mjs`（端口两答案）· `proof4.mjs`（进程树两结果）。
  全部只操作自建的临时目录与**自己起的进程**；**没有用 `pkill`**，收尾按自己的 pid 收。
- ⚠️ **实证 1 的 A 侧走的是 `packages/pipeline/dist`，而该 dist 是从`带在途改动的工作区`编出来的**
  （`dist/tools.js` 比 `src/tools.ts` 新 1.5 秒）。**这不影响实证 1 的结论** ——
  B 侧（`resolveBackendTool`）在 committed 与在途两版里都没有包内档，我逐版看过。
  但**另一条只演示"env 未设就找不到"的脚本（`proof2.mjs`）无法区分两版**（我的合成布局不与模块相邻），
  所以它**没有被我用作证据**，R-1 里"第三个出口"的判定依据是**读 committed 源码**（`71459fc:tools.ts:904`）。
- `[报告]`（非我所验）：另一路报的 `GET /api/selfcheck` 与 `POST /api/backends/selftest`
  的真机现场，我**没有**在真 daemon 上复现，只在解析器层复现了同一个成因。
- **在途、非我所做**：`packages/runtime/src/bundledRuntime.ts` 及其接线正在收敛 R-1 的四个出口。
  我把它记为「已有在途修复」而不是「已修复」—— 它**审计时尚未提交**。
- 未碰 `:10000`、`/root/data-memo`、机器级指针；未建/改/删 release；未跑构建。
- **没有为凑数把不该合的列成该合的**：真重复 **3 条**（R-1/R-2/R-3），
  刻意不对称 **3 条**（N-1/N-2/N-3），已收敛 **1 条**，`UNKNOWN` **2 条**。
