# 闭合审计 —— 「之前那些任务都闭合了吗」

> **产出者**：`closure-audit`（只读审计，零代码改动、零 commit、未碰 `:10000`、未碰 `/root/data-memo`、未写 `datadir.json`）
> **日期**：2026-08-07　**基准 HEAD**：`de1aca5`　**工作树**：clean（`git status --short` 空）
> **范围**：`coordination/inbox/` 全部 49 份 `.md` + `HANDOFF.md` + `docs/adr/` 16 篇 + `docs/design/` 11 篇
> **只写本文件。没有动任何人的回执。**

---

## 〇、判据与方法（先说清楚，免得这份台账变成下一个假绿灯）

**「闭合」= 我能在今天的代码 / 今天的 CI 里验到，不是「回执里写了已完成」。**

我用的三级证据：

| 级别 | 含义 |
|---|---|
| `[我核过]` | 我本人读了那一行代码 / 跑了那条命令 / 看了那个 run，并把行号或输出贴在下面 |
| `[报告]` | 只有回执这么说，我没独立核 |
| `[未验证]` / `UNKNOWN` | 我拿不到证据，并说明为什么拿不到 |

**为什么这份台账把重点压在 🟡 上**：这个项目反复栽的不是「没做」，是「做了、写了回执、而那条修复从来没触发过」。
最近一例是 `collapseRedundantTopLevel` —— 判据是"顶层恰好一个条目"，真包里有两个（`__MACOSX`），
于是它一次没生效，而所有夹具都是手搓的干净包。所以下面每一条 ✅ 我都要求「能触发」而不只是「存在」。

**已知的坑（我自己踩过一次）**：`HANDOFF.md` 最后更新是 **2026-08-03**，`debt-audit.md` / `architect.md` /
`gpu-runtime.md` / `oss-scout.md` / `platform.md` 也都是 08-03 前后。它们里面**大量**条目已被 08-06/08-07 的
`backlog-sweep` / `daemon-backlog` / `platform-backlog` / `ui-backlog` 闭掉了。
`backlog-sweep.md:23` 自己数过：**105 条里 61 条其实早做完了，只是写成了开着的样子**。
所以「回执里还写着开着」**不能**当作未闭合的证据 —— 下面每一条我都回代码里重核了。

---

## 一、总表

> 只列我**独立核过**的条目。看着像但我没核实的，一律不进这张表，进第七节。

| 条目 | 类 | 证据 | 主 |
|---|---|---|---|
| **孤儿导出棘轮 `check:orphans` 从来不在 CI 里跑** | 🟡 | `.github/workflows/ci.yml:120` 只有 `check:sources`；全仓 `grep -rn orphan .github/` 零命中；无 git hook | Manager |
| **棘轮判据有字符串字面量盲区：72 应为 76** | 🟡 | 我复刻其规则得 72（与基线一致）；加剥字符串字面量得 76，遮住 5 条 | Manager |
| `runner.ts:190` 注释声称 Windows 用 `taskkill` 杀进程树 —— 全仓零实现 | 🟡 | `runner.ts:190` 注释 vs `killTree` `runner.ts:198-210` win32 分支只 `child.kill()`；全仓 `taskkill` 仅此一条注释 | `platform-backlog` |
| ADR-003:83 声称 daemon 会清 macOS quarantine —— 全仓零实现 | 🟡 | `apps/`+`packages/` 零 `xattr`；`.github/workflows/build-backends.yml:207` 自己挂了 ⚠️ 说这条 ADR 声称不实 | Manager（改 ADR）/ `platform-backlog` |
| **TD-001**（重开 `noUnusedLocals`）ADR 与 tsconfig 给了相反的理由，无人调和 | 🟡 | `ADR-005:54` = 🔴未清、"Wave 3 前必须重开、Manager 验收"；`tsconfig.base.json:24-26` = 「刻意不开，已由 eslint 覆盖」 | Manager（裁一次） |
| `packages/shared` 零测试，且 `check-test-scripts` 结构上看不见它 | 🟡 | `find packages/shared -name '*.test.*'` 空；守卫只抓"有测试文件却没脚本"；CI 日志 8 个包无 shared | `test-gaps` |
| `argGuard.ts:109` 指向的 `resolveAndCheck` 全仓不存在 | 🟡 | `grep -rn resolveAndCheck` 只命中那条注释本身 | `path-guard` |
| **A-6** daemon 侧 `sourceBaseUrl` 零读取字段仍在 | ⛔ | `state.ts:103` 声明、`models.ts:953` 唯一写入、全仓零读取（`api.ts:177` 的 `[实测 grep]` 我复核过） | `daemon-backlog` |
| **C-19 / B-4** `unpackArchive` 失败自清 → 契约 + 断言 | ⛔ | `unpack.ts:939` 无契约段；`unpack.test.ts`/`installer.test.ts` 零"自清"断言 | `daemon-backlog` |
| `applicability.ts:219` `.includes('probe')` 字符串嗅探仍在 | ⛔ | 行还在（从 206 挪到 219）；daemon 同族已改结构判据（`backends.ts:114`） | `gates-fix` / `daemon-backlog` |
| **B15 / C-7** 老安装记录回 `role` | 🚧 | 建议"与 `priority` 一起裁"，等 Manager 一句话（`daemon-backlog.md:361`） | Manager |
| **A-5** `ytdlp-macos-arm64` 声明 `arch:"arm64"` 却是 universal2 | ⛔ | `backends.json:514-522` `arch:"arm64"` + `displayName` 写着 universal2；无 `ytdlp-macos-x64` | `platform-backlog` |
| 组件「回滚」永远不可用（`stashForRollback` 零调用方） | ⛔ | `downloader/components.ts:207` 零调用方 → `rollbackVersion` 恒 null；按钮已被 T-157② 拿掉并写明 | Manager（需一句 ADR） |
| `role=llm` 5 条 GGUF 仍被 `/api/models/catalog` 发出 | ⛔ | `models-llm.json` 5 条 `"role":"llm"`；`manifests.ts` 列目录全载。**但 UI 不渲染**（见展开） | `model-mgmt` |
| `describeSpeed()` 零调用方 → T-125 实测证据一条没进 UI | ⛔ | `shared/models.ts:244` 声明，全仓零 import；已登记在棘轮基线并带 ⚠️ note | `model-mgmt` |
| `statusTone.ts` 三个 tone 函数零调用方 | ⛔ | `statusTone.ts:71/78/96`，全仓零调用；已登记基线 | `ui-backlog` |
| `JobList` 的 pause/resume 错误零渲染 → 点了静默无反应 | ⛔ | `JobList.tsx:122,127` `actions.pause.mutate(...)`，同文件无 `isError` | `ui-backlog` |
| `mistralai` 驱动不了（无 `mistral-native` 适配器） | ⛔ | `llm-catalog.ts:114` `'mistral-native': null`；目录 `llm-providers.json:4491` 有这家 | `architect` |
| 根 `package.json` 的 `"build": "pnpm -r build"` 陷阱仍在 | ⛔ | `package.json` `build` 未改（`check` 改掉了，`build` 没有） | Manager |
| `format:check` 不是门禁 | ⛔ | 根脚本有 `format:check`，`ci.yml` 不调用 | Manager |
| `migrateAssets.ts:81` `void mediaRoot` + `depth>6` 静默截断 | ⛔ | `migrateAssets.ts:61,81` 逐字如此 | `daemon-backlog` |
| `defaultDataDir()` / `resolveStoreRoot()` 仍直读 `process.platform`，无 platform 入参 | ⛔ | `config/paths.ts:26`、`pipeline/tools.ts:100` | `path-guard` |
| Ed25519 目录验签：实现在、**生产零调用方 + 无密钥** | 🚧 | `signature.ts:104` `PUBLIC_KEY = null`；`verifyCatalogSignature` 全仓零调用；`manifest.ts:14` 自陈 | 等密钥（用户/Manager） |
| Windows / macOS / arm64 / musl 真机行为 | 🚧 | 无机器。CI 只有 GitHub 托管 runner，无真 N 卡 / 真 AMD / 真 Mac 交互 | 等硬件 |
| Vulkan 包 `GLIBC_2.38`、Windows VC++ 运行时 | 🚧 | `ADR-015:115-123` 自陈；我无 22.04/干净 Windows 可验 | 等真机 |
| 真 release / 真上传一个字节 | 🚧 | 建 release 是对外动作，规则要求用户本人确认 | 用户 |
| 真浏览器点一遍（全仓无 playwright/puppeteer） | 🚧 | `ADR-012:61-68` 立的"最大验证缺口"，至今无 e2e 依赖 | 需能开浏览器的人 |
| ★ `ws/recorder.ts` 绝对路径进 `rel_path`（asset-check:193 那条） | ✅ | `recorder.ts:326` `canonicalAssetRelPath()` + `recorder.test.ts` **本机跑 8/8 绿** | 已闭 |
| ★ `__MACOSX` 废掉整条 CoreML 修复（T-168 ①） | ✅ | `unpack.ts:187 isMacArchiveJunk` + 两处调用；`installer.test.ts:266` 真条目表；downloader **35/35 绿** | 已闭 |
| `/api/health` 的 `host` 硬编码 `127.0.0.1` | ✅ | `server.ts:134` `host: deps.host()`；`main.ts:370` `boundHost`；有 `healthHost.test.ts` | 已闭 |
| `upload.ts` 两处 `as never` | ✅ | 产品代码全仓零 `as never`（只剩测试夹具）；`as any` 仅 3 处 | 已闭 |
| `staleLinks`/`warningZh` 算了没接出来 | ✅ | `rest/storage.ts:348-349` 回传；`DataLocationSection.tsx:91,98,354` 渲染 | 已闭 |
| 侧栏「星标」筛选没实现 | ✅ | 服务端筛选 `notesCache.ts:47-53`；`activeNav.test.ts` 钉住 | 已闭 |
| `GET /api/notes` 无分页（A12） | ✅ | `rest/notes.ts:346-369` `?offset=` + 拒绝非法值 | 已闭 |
| `POST /api/llm/detect` 不存在（D-10 #3） | ✅ | `rest/llmRoutes.test.ts:85` + `LocalLlmSection.tsx:19` 消费方 | 已闭 |
| `activeJobId` 死代码 | ✅ | 已删并有回归断言 `components.test.tsx:4213`「不许回来」 | 已闭 |
| F4 导图无生成入口（A6） | ✅ | `features/mindmap/api.ts:62` POST 已接 | 已闭 |
| `POST /api/auth/session` 在 `AUTH=none` 下 401 → 全站无 SSE | ✅ | `server.ts:189-197` 已改并写明原委 | 已闭 |
| `POST /api/backends/selftest` 结果不回写（gates-fix §5.3） | ✅ | `rest/hardware.ts:271` 调 `recordSelfTest()`，`:430` 写 manifest | 已闭 |
| ADR-014 ② manifest 文件名硬编码 | ✅ | `rest/manifests.ts:50-72` 改成列目录 + 按内容判类型 | 已闭 |
| **A-4** `openmemo-probe` 无分发通道 | ✅ | `3ef8734`（T-167①）探针编进每个包；`build-backends` run 31155359839 9/9 绿 | 已闭 |
| `asr.coreml` 的 `required:false` 假绿灯 | ✅ | `runtime/selfcheck.ts:311+` 改无条件 `required:true`；`cold-start-audit` run **31167151669** 实测 `asr.coreml = ok` | 已闭 |
| D-10 #24「+ 添加服务商」够不到 13 家 | ✅ | `llm-providers.json` **24 家 / 520 条**；`LlmSettingsSection.tsx:324` 三桶驱动 | 已闭 |
| 一批测试从来没被执行过（C1/TD-002 族） | ✅ | `check-test-scripts.mjs` 挂进 6 个包共用行；CI 日志：**8 个含测试的包都有 test 脚本**，daemon 434 / web 274 / pipeline 222 全绿 | 已闭 |
| **C-24** HEAD 从未跑过 CI | ✅ | `ci.yml` 已 `on.push`；`gh run list` 近 15 次全部 push 触发 | 已闭 |
| ADR-016 空间管理②③（修改/移动数据目录） | ✅ | `storage/move.ts:317 moveDataDir` + `move.test.ts` 12+ 用例 + `rest/storage.ts:302` | 已闭 |
| ADR-016 决策 5 代理配置 | ✅ | `shared/proxy.ts` + `rest/proxy.ts`（脱敏、`no_proxy`、SOCKS5）+ ffmpeg SOCKS 局限如实透出 `proxy.ts:62-84` | 已闭 |
| `sqlite-ext.json` 的 `libsimple.dll` → `simple.dll` | ✅ | `grep -c simple.dll` = 2，`libsimple.dll` = 0 | 已闭 |
| **孤儿导出棘轮基线 = 72，没被抬过** | ✅ | 基线文件 `accepted` **72 条**；`git log` 该文件**只有一个提交**（`1b0675b`）；本机跑 checker：`零引用导出 72 个（基线 72 个）` + `✔ 没有新的零引用导出，基线也没有过期条目` | 已闭（但见 🟡-1/🟡-2） |
| ADR-016 决策 1/2/3：TTS、本地 ASR 扩容、内置 `llama.cpp` | ✂ | `ADR-016:24-36`，用户指令原文在案 | 已裁 |
| 翻译/双语字幕/字幕导出、说话人分离、workspace 层级 | ✂ | `ADR-006:57-60`、`ADR-011:82-84`、`ADR-006:48-50` | 已裁 |
| 桌面外壳 Tauri、离线全量安装包、代码签名证书 | ✂ | `ADR-003:31,81-93` | 已裁 |
| L0 浏览器 WebGPU / `/ws/asr-worker` | ✂ | `ADR-006:36-46`（降为实验特性，不进 v1） | 已裁 |
| 「可导入任意 HF GGUF」「真实 AMD 支持」对外口径 | ✂ | `ADR-016:73-76` 改口径不补实现 | 已裁 |
| macOS Intel 支持 | ✂ | 用户 2026-08-05 裁定（`progress-audit.md:175` 引） | 已裁 |
| 向量检索（`/api/search` `modes.semantic=false`） | ✂ | `HANDOFF.md:565` 标"已裁决的取舍，不是 bug" | 已裁 |
| ROCm 换 noble 的冲突复验 | ✂ | `ci-runner.md:233` 已被裁掉，"可能永远不会验证" | 已裁 |

---

## 二、🟡 声称闭合但我验不到（**7 条**，本节写详细）

> 这一类的定义：**有人报了完成 / 有文档断言了某行为，而我在今天的代码里找不到它，或者找到了但它走不到 / 没人跑。**
> 每条都写：为什么我验不到 · 我试了什么 · 还缺什么才能定论。

---

### 🟡-1　孤儿导出棘轮「固化成门禁」了，但**这个门禁从来不在 CI 里跑**

**谁声称闭合**
- 提交 `1b0675b` 的标题：`ci: 「零调用方」扫描固化成门禁 —— 15 条用户可见缺陷里 6 条是它查出来的 (T-157)`
- `progress-audit.md:246`：`debt-cleanup 决策 6：死导出检测器何时装守卫 | ✅ **已装**（T-157）`
- `sweep-fix.md:45`：新增脚本 + 基线，**接进 `pnpm check`**

**我验到的**
- 脚本在：`scripts/check-orphan-exports.mjs`　`[我核过]`
- 基线在：`scripts/orphan-exports-baseline.json`，`accepted` **72 条**　`[我核过]`
- `package.json:24` `check:orphans` 在、`package.json:26` `check` 里也在　`[我核过]`
- **`.github/workflows/ci.yml` 从头到尾没有它。** CI 的静态检查只有一条：`ci.yml:120  run: pnpm check:sources`。
  `grep -rn "orphan" .github/` → **零命中**（唯二命中 `pnpm check:sources` 的是 `ci.yml:120` 和 `ci-crossplatform.yml:109`）　`[我核过]`
- **也没有 git hook**：`git config core.hooksPath` 空、`.git/hooks/` 除 `.sample` 外为空、无 `.husky` / `.githooks`　`[我核过]`
- `pnpm check` 本身**没有任何自动调用方** —— 它只在人手敲的时候跑。

**佐证（不是我说的）**：`scripts/mutation-check.mjs:22` 自己写着
> 「本仓库没有 CI、没有 git hook、**`pnpm check` 也没人跑** —— 多加一条没人跑的门禁没有意义」

那句话的前半截（"没有 CI"）今天已经过期（`ci.yml` 08-07 起 `on.push`），**后半截没有过期**。

**所以「已装门禁」这句话的真实状态是**：装了一把好锁，挂在一扇没人经过的门上。
今天棘轮是 72/72 没漏（我跑过，见 ✅ 那一行），**但这是因为最近改动恰好没引入新孤儿，不是因为有东西在挡**。

**要定论还缺什么**：不缺了。这条是我核实过的、可以直接定案的。
**最小修法（一行）**：`ci.yml` 在 `check:sources` 后面加一步 `run: pnpm check:orphans`。
⚠️ 别直接加 `pnpm check` —— 它里面含 `pnpm build:safe`，与 CI 已有的 build 步重复。

---

### 🟡-2　棘轮的判据本身有一个盲区：**基线该是 76 不是 72**，5 条被字符串字面量遮住了

这条是我在核 🟡-1 时顺手撞出来的，**没有任何回执提过它**。

**判据长什么样**（`check-orphan-exports.mjs:196-213`）：
1. 先 `stripComments()` 剥掉注释（`:118-123`）——**只剥注释，不剥字符串字面量**；
2. 统计三个数：`self`（同文件内命中数 − 1）、`test`、`prod`；
3. 只有 `prod === 0 && self === 0 && test === 0` 才判为"零引用导出"。

**盲区**：一个函数如果**在自己的错误信息字符串里写了自己的名字**，`self` 就 ≥ 1，
于是它**永远不会被这个门禁看见**，哪怕它零调用方、零测试。

**活样本**（`packages/downloader/src/manifest.ts`）：

```
L161: export async function verifyCatalogSignature(
L168:   'verifyCatalogSignature: a signature was supplied but no catalog signing key is ' +
```

我按脚本自己的 `stripComments` 剥过之后数：`self-file hits = 2 → self = 1` → 不判红。　`[我核过，node 一行复算]`

**量化**（我复刻了 `classify()` 的规则，两次运行只差"要不要同时剥字符串字面量"）：

```
当前判据（只剥注释）零引用导出 = 72     ← 与基线 72 逐字吻合，说明我的复刻是对的
若同时剥掉字符串字面量        = 76
被字符串字面量遮住的          = 5
   apps/daemon/src/bootstrap/single-instance.ts :: PROBE_HOST
   apps/web/src/features/recorder/asrStream.ts  :: RecorderServerMessage
   packages/downloader/src/manifest.ts          :: verifyCatalogSignature   ← 见 🚧-1
   packages/downloader/src/probe.ts             :: PROBE_BYTES
   packages/runtime/src/childEnv.ts             :: pathVarSeparator
```

**为什么这条值得当 🟡 而不是"小坑"**：`progress-audit.md:215`（B1）已经因为**同一类原因**打过一次补丁 ——
当时是 barrel 再导出把 28 条遮住了，T-160 把那一档补回来（现在打印 21 条、不判红，我核过）。
**这是第二个同形盲区，而它遮住的 5 条里有一条是安全控制。**
「你最信任的探针在悄悄打折，而没人知道折了多少」这句话，T-160 之后仍然成立。

**要定论还缺什么**：不缺。我用脚本自己的规则复算出了 72（吻合）与 76（加剥字符串），差集逐条可列。
**注意**：我**没有**主张这 5 条都该判红 —— `PROBE_HOST` / `PROBE_BYTES` / `pathVarSeparator` 可能是正当的契约形状。
主张只有一条：**它们今天连"被清点"的机会都没有**，而基线的全部意义就是清点。

---

### 🟡-3　`runner.ts:190` 的注释声称 Windows 上用 `taskkill` 杀进程树 —— 全仓零实现

**声称在哪**（`packages/pipeline/src/subprocess/runner.ts:188-190`）：
```
// Own process group so the timeout can kill the whole tree (ffmpeg and yt-dlp
// both spawn helpers). On Windows this is emulated via taskkill below.
detached: process.platform !== 'win32',
```

**"below" 实际是什么**（同文件 `:198-210`）：
```js
const killTree = (sig) => {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      child.kill(sig);                 // ← 只杀直接子进程
    } else {
      process.kill(-child.pid, sig);   // ← 负 pid = 整个进程组
    }
  } catch { /* Already dead. */ }
};
```

**我验到的**：全仓 `grep -rn taskkill --include=*.ts apps/ packages/` → **只有 `runner.ts:190` 那一条注释本身**，
零实际调用。　`[我核过]`

**后果**：Windows 上超时 / 取消一条转写或下载时，`ffmpeg` / `yt-dlp` 派生出来的 helper 进程**不会被回收**。
而注释让下一个读代码的人相信它会。这正是本项目「注释描述了不存在的行为」那一族
（`backlog-sweep.md:141`、`platform.md:544` 各自独立记到过同一处，`progress-audit.md:275` 复核过）。

**为什么是 🟡 而不是单纯的 ⛔**：⛔ 的定义是"明确未做"。这一条在源码里被写成**已做**，
所以任何读这个文件的人（包括审计的人）默认它是闭的 —— 它的危险性来自那句注释，不只是来自缺失的实现。

**要定论还缺什么**：**一台真 Windows**。我能证明代码里没有 taskkill，
**我不能证明**用户实际会看到什么（孤儿进程会不会被 Windows 作业对象回收、`windowsHide` 有没有副作用）→ 标 `[未验证：需真机]`。

---

### 🟡-4　`ADR-003:83` 声称 daemon 下载后会清 macOS quarantine —— 全仓零实现

**声称在哪**：`docs/adr/ADR-003-runtime-and-process-model.md:81-88`（不买证书、走 ad-hoc 签名那一节），
其配套断言是 daemon 下载后清 `com.apple.quarantine`。ADR 状态 = `accepted`。

**我验到的**：
- `apps/` + `packages/` 里 `quarantine` / `xattr` **零命中**　`[我核过]`
- 仅有的两处提及都在构建侧且都是"这事没做"的语气：
  - `scripts/build-whisper.sh:680` — `# quarantine xattr after download. See D-04 §7 for the upgrade path.`
  - `.github/workflows/build-backends.yml:207` — `# ⚠️ ADR-003:83 claims the daemon clears com.apple.quarantine after download.`
    （**workflow 自己挂了一条 ⚠️ 说这条 ADR 的断言不实**，而 ADR 原文一个字没改）

**后果**：一份 `accepted` 的 ADR 在断言一个不存在的缓解措施，而这个缓解措施是"不买 $99 证书"这个决策的**成立条件**。
换句话说：ADR-003 决策 5 的论证链缺了一环，而缺的那一环只有在 workflow 注释里被人小声记了一笔。

**要定论还缺什么**：**一台真 Mac**。我能证明代码里没有清 quarantine 的动作；
**我不能证明**用户双击时 Gatekeeper 具体会怎样（daemon 是被 Node 启动的子进程，不是双击的 .app，路径可能不同）→ `[未验证：需真机]`。
**但 ADR 与实现不一致这半，不需要 Mac 就能定案。**

---

### 🟡-5　TD-001：ADR 说"必须重开"，`tsconfig` 给了一个相反的、永久性的理由，没人调和

**A 面**（`docs/adr/ADR-005-workspace-conventions.md`）：
- `:14-15` —「**但这是暂时豁免，不是永久决定。** 登记为技术债 **TD-001**」
- `:54` — 技术债表：`| TD-001 | 重开 noUnusedLocals/noUnusedParameters 并清理 | Wave 3 结束前 | 🔴 未清 |`，**验收人写的是 Manager**

**B 面**（`tsconfig.base.json:24-26`）：
```
// 刻意不开 noUnusedLocals / noUnusedParameters：
// 未使用变量是 lint 关注点，不该阻断编译（尤其多 agent 并行开发期间）。
// 已由 eslint 的 @typescript-eslint/no-unused-vars 覆盖，且有 `^_` 前缀豁免。
```
这不是"还没来得及重开"，这是**一个相反的永久决定**，而且写在代码里，没有回到 ADR 上。

**我验到的**：
- 两处原文逐字如上　`[我核过]`
- `eslint.config.js:39` 确实有 `@typescript-eslint/no-unused-vars`　`[我核过]`，所以 B 面的理由**技术上成立**
- 全仓只有 `model-mgmt.md:83` 一处提到 TD-001，是说自己"未依赖 TD-001 豁免"，**没有人来结这笔账**

**所以我验不到的是什么**：不是代码状态（代码状态很清楚），是**这笔债到底还欠不欠**。
两份都是权威文档，说的是相反的话，而 ADR 指定的验收人（Manager）从没签字。
台账上它永远是 🔴，实际上可能早就该划掉 —— **这种"永远红的一行"本身就是训练人忽略台账的东西**。

**要定论还缺什么**：Manager 的一句裁决 + 把裁决写回 `ADR-005:54`。
我**不能**替你裁：ADR-005 明写验收人是你。

---

### 🟡-6　`packages/shared` 零测试，而那道"测试从来没被执行过"的守卫**结构上看不见它**

**背景**：`scripts/check-test-scripts.mjs` 是为了终结"一批测试从来没被执行过"这个坑而立的守卫，
它的文件头逐条记了这个坑发生过的**五次**（daemon glob 漏跑 30%、pipeline 10 个只跑 1 个、db 靠巧合、runtime 压根没脚本、llm+mindmap 60 条没脚本）。
守卫本身有效：CI 日志 `✔ check-test-scripts: 8 个含测试的包都有 test 脚本`　`[我核过]`。

**盲区**：守卫的判据是 **「有测试文件 却 没有 test 脚本」**。
`packages/shared` 有 **0 个测试文件**，所以它**永远不触发**，`pnpm -r test` 也永远跳过它，两边都不出声。

**我验到的**：
- `find packages/shared -name '*.test.*'` → **空**　`[我核过]`
- `packages/shared/package.json` 的 `scripts.test` → `undefined`　`[我核过]`
- CI 日志里那 8 个包：`apps/daemon(43) apps/web(16) packages/db(4) packages/downloader(3) packages/llm(2) packages/mindmap(3) packages/pipeline(16) packages/runtime(5)` —— **没有 shared**　`[我核过]`

**为什么这条重要**：`packages/shared` 是**跨进程契约的那一份**（`schemas.ts` 的 zod、`models.ts`、`hardware.ts`、`providers.ts`、`proxy.ts`）。
本项目已知的多起事故形状都是"发送方与接收方对同一个字段理解不同"（T-144、T-165、`inapplicableKind` 那次）。
守着那条线的包，是唯一一个**没有任何测试、且没有任何门禁会为此出声**的包。

**已被记过一次但被判为超范围**：`last-mile.md:248` —「`packages/shared` 自己没有测试：加 test 脚本会牵动 `check-test-scripts.mjs` 跨包守卫，超出范围」。
我核过这个顾虑：**它不成立**。守卫只数 `*.test.ts(x)` 文件、只在"有文件没脚本"时报错；给 shared 加脚本不会影响别的包。

**要定论还缺什么**：不缺。这是一条可以直接派的活。

---

### 🟡-7　SSRF 守卫的注释指向一个不存在的函数 `resolveAndCheck`

**声称在哪**（`packages/pipeline/src/subprocess/argGuard.ts:108-109`，就在 `isPrivateOrReservedHost` 里）：
```
// Common internal TLDs; not exhaustive, and DNS rebinding still needs a re-check at
// connect time (see resolveAndCheck below).
```

**我验到的**：`grep -rn "resolveAndCheck" --include=*.ts apps/ packages/` → **只命中这条注释本身**，全仓没有这个函数。　`[我核过]`

**后果**：DNS rebinding 的 TOCTOU 缺口是真开着的（`backlog-sweep.md:167` 独立记过），
而这行注释让读者以为"下面有一个连接时复查"。SSRF 守卫是安全代码，
**一条指向不存在缓解措施的注释，在安全文件里比没有注释坏得多**。

顺带（同一段注释，`argGuard.ts:101`）：`Note our own daemon binds 127.0.0.1` ——
而 `HANDOFF.md:586` 记的 demo 实际绑 `0.0.0.0:10000`。这半我**没有**去核 demo（不许碰 `:10000`），标 `[未验证]`。

**要定论还缺什么**：不缺"注释指向空函数"这半。
"DNS rebinding 到底能不能被利用"那半需要构造完整利用链，我**没做**（`path-guard.md:596` 也自陈没做）→ `[未验证]`。

---

## 三、⛔ 明确未做，有主（能说清下一步）

> 全部我回代码核过。回执写着开着、而我核出来已经闭了的，**不在这里**（在 ✅ 里）。

| # | 条目 | 我核到的证据 | 下一步 | 主 |
|---|---|---|---|---|
| 1 | **A-6** `sourceBaseUrl` daemon 侧零读取字段 | `rest/state.ts:103` 声明 · `rest/models.ts:953` 唯一写入 · 全仓零读取（`apps/web/.../models/api.ts:177` 的 `[实测 grep]` 我复核过；web 侧已刻意不做"自定义源"输入框，`SourcesSection.tsx:35`） | **删**它，连同 `SelectSourceRequest.baseUrl`（`progress-audit` B5 与 `daemon-backlog` 同意见） | `daemon-backlog` |
| 2 | **C-19 / B-4** `unpackArchive` 失败自清契约 | `unpack.ts:939` 函数签名上无契约说明（文件头只讲安全属性）；`unpack.test.ts` / `installer.test.ts` 零"失败后 destDir 干净"断言 | 按 `progress-audit` B4：**不改行为**，在签名上明写契约 + 加一条断言 | `daemon-backlog` |
| 3 | `applicability.ts:219` 字符串嗅探 | 行仍在。**我把 `daemon-backlog.md:606` 的判断修正了一处**：那条说"我的新文案不含 probe 一词，与本次改动无交互"——对；但它**不是死代码**，`manager.ts:217` 在 `probe.ok === false` 时给所有后端 `probe did not complete: …`，`.every()` 能命中。真正的问题是它**要求全部六个后端都匹配**，且 T-168 新增的文案（`manager.ts:237-245`，不含 `probe`）一旦出现在任一后端上，这条就静默失效 | 换成 `status.probed !== true` 结构判据（daemon 侧 `backends.ts:114` 已是这个写法，两边对齐即可） | `gates-fix` |
| 4 | **A-5** `ytdlp-macos-arm64` universal2 却声明 `arch:"arm64"` | `backends.json:514-522` + `components.json:312`；无 `ytdlp-macos-x64` 条目 | `platform-backlog.md:519` 给了两条路并选了①（收窄 displayName 承诺），且说明为什么要等 release 之后一起改 —— **这个"等"是有理由的，别当拖延** | `platform-backlog` |
| 5 | 组件「回滚」永不可用 | `downloader/components.ts:207 stashForRollback` 零调用方 → `:154 rollbackVersion` 恒 null。T-157② 已把假按钮拿掉并在 `ComponentCard.tsx:164-179` 写清四条原因 | 用户可见的谎言已消除。剩下的是**要不要做**：`progress-audit` C3 建议「明确 v1 不做并写进 ADR，别继续挂着」 | Manager（一句 ADR） |
| 6 | `role=llm` 5 条 GGUF 仍在目录里 | `models-llm.json` 5 条 `"role":"llm"`；唯一的标记是 `speedEvidence.reason="out_of_scope"`（`shared/models.ts:282` 只是一句速度文案，**不下架任何东西**）；`rest/manifests.ts` 列目录全载 → `/api/models/catalog?role=llm` 仍返回它们。**但我核到 UI 不渲染**：`ModelsPage.tsx:74 ASR_TAB_ROLES = ['asr','vad','punctuation']`，LLM Tab 只有在线服务商区块 | 严重度比多份回执写的低（**今天用户看不到**）。剩下是目录卫生 + API 契约 | `model-mgmt` |
| 7 | `describeSpeed()` 零调用方 | `shared/models.ts:244` 声明，全仓零 import。**已在棘轮基线里带 ⚠️ note**（`orphan-exports-baseline.json:235`），note 原文：「HANDOFF ③ 写着「读 rtf 要走 describeSpeed()」，而 UI 全走 speedClass。T-125 实测的 9/35 条 measured 证据一条都没进 UI」 | 要么补断言接上，要么改 HANDOFF 那条规范 | `model-mgmt` |
| 8 | `statusTone.ts` 三个 tone 零调用方 | `statusTone.ts:71/78/96`；均在基线里 | T-114 立的规矩没人执行 —— 要么接上要么删 | `ui-backlog` |
| 9 | `JobList` pause/resume 错误零渲染 | `JobList.tsx:122,127` 直接 `.mutate()`，同文件无 `isError` 分支 | 点「暂停」失败时静默无反应。补 `<ErrorBlock>`（同页已有 4 个的写法） | `ui-backlog` |
| 10 | `mistralai` 驱动不了 | `llm-catalog.ts:114` `'mistral-native': null`；目录里这家在（`llm-providers.json:4487-4493`）。前端用总 `Record` 强制表态（新协议族没人表态就构建红），处理是诚实的 | 补 `mistral-native` 适配器，或在界面逐家说明原因（`LLM_CATALOG_STATS.supported` 已备好这个口径） | `architect` |
| 11 | 根 `"build": "pnpm -r build"` 陷阱仍在 | `package.json` `check` 已换成 `tsc -b && pnpm build:safe`，**但 `build` 本身没换** —— 陷阱只是挪开了（`progress-audit` B3 原话） | 一行改动 | Manager |
| 12 | `format:check` 不是门禁 | 根脚本有，`ci.yml` 不调。`ci-prep.md:409` `[报告]` 说全仓 403 个文件不过（**我没跑，太慢** → `[未验证]`） | 先统一格式再上门禁，别反过来 | Manager |
| 13 | `migrateAssets.ts` 收着 `mediaRoot` 不用 + `depth>6` 静默截断 | `:61` 签名收它、`:81` `void mediaRoot;`；`walk` 里 `if (depth > 6) return;` 无任何提示 | 深目录里的文件找不回来时不会说明原因。小坑 | `daemon-backlog` |
| 14 | 三份数据根推导仍直读 `process.platform` | `config/paths.ts:26 defaultDataDir()`、`pipeline/tools.ts:100 resolveStoreRoot()` 均无 platform 入参（对照正确范式：`downloader/store.ts:63 defaultModelsRoot(platform=…)`） | `path-guard.md:480` 明说三份合一超出 T-143 范围。**注**：`resolveStoreRoot(dataDir)` 已接线，daemon 路径上到不了那个兜底 | `path-guard` |
| 15 | `rel_path` 大小写归一化 | `apps/daemon/src/storage/` 无 `toLowerCase`；Linux 敏感、mac/Win 不敏感 → 跨平台行为不一致 | `asset-check.md:201` 自陈本机验不了 | `path-guard` |

---

## 四、🚧 阻塞（**不算欠债**，但要说清卡在什么上）

| # | 卡住的东西 | 卡在什么上 | 我核到的 |
|---|---|---|---|
| 1 | **目录 Ed25519 验签** | **没有密钥**。`signature.ts:104` `OPENMEMO_CATALOG_PUBLIC_KEY: string \| null = null` | 实现是完整的且 fail-closed（给了签名却无密钥 → 抛，不是返 true）。**但生产零调用方**：`loadManifest` 从不调它，`manifest.ts:14` 自陈。⚠️ 叠加 🟡-2：它连棘轮都看不见 |
| 2 | **B15 / C-7 老记录回 `role`** | **等 Manager 一句裁决**。`daemon-backlog.md:361` 论证：读取侧无从补（信息不在盘上），四个读取方已改成扫全桶按 `role` 判，建议与 `priority` 回填**一起裁** | 我**没有**在真实数据目录上核 `skippedWithoutRole > 0`（`/root/data-memo` 禁碰）→ `[未验证]` |
| 3 | 真 release / 真上传一个字节 | 建 release（含 draft）是对外动作，规则要求用户本人确认 | `pack-publish.md:594`、`ci-upload.md:322` `[报告]` |
| 4 | Windows / macOS / arm64 / musl 一切真机行为 | 无机器。GitHub 托管 runner 能编能测，但**没有真 N 卡、没有真 AMD、没有交互式 Mac、没有干净 Windows** | `platform.md:544-560` 列了必须真机的 10 类 `[报告]` |
| 5 | Vulkan 包 `GLIBC_2.38`（22.04/Debian 12 静默加载失败） | 需要一台 22.04 | `ADR-015:115-123` 自陈 `[报告]`；我无该发行版 |
| 6 | Windows VC++ 运行时依赖 | 需要一台干净 Windows | `ADR-015:121-123` `[报告]` |
| 7 | Linux CUDA 包在没装 CUDA 的机器上能否用 | 需要一台没装 CUDA 工具链的机器（runner 上装了，`ldd` 看不出来） | `amd-vulkan.md:525` `[报告]` |
| 8 | 真浏览器点一遍 | 全仓无 playwright / puppeteer（`ADR-012:61-68` 当年就把它定为"当前最大验证缺口"） | `[我核过：无 e2e 依赖]` |
| 9 | 云 LLM 真 Key 往返（Anthropic / Gemini / DeepSeek） | 无 Key / 无出网 | `HANDOFF.md:552`、`last-mile.md:242-243` `[报告]` |
| 10 | 代理在**真实可用**的代理后面测 | 只做过死代理反证法（证明流量改道，未证明经代理能出网） | `HANDOFF.md:553`、`gpu-runtime.md:1512` `[报告]` |
| 11 | 重建 `apps/web/dist` + 重启 `:10000` | **只有 Manager 能做**（PROTOCOL §7）。在此之前多轮前端修复用户一条都看不见 | `ui-backlog.md:150`、`backlog-work.md:224` `[报告]`。我未碰 `:10000` |
| 12 | `PENDING-USER-DECISIONS.md` / 章程 §3 / `SECURITY.md` 的订正 | **只有 Manager 能写那几个文件** | `gates-fix.md:382`、`backlog-work.md:225-232` `[报告]` |
| 13 | 会员内容 cookie（yt-dlp `--cookies`） | **需用户拍板**：`--cookies` 是任意文件读取入口，`--cookies-from-browser` 读全站凭据 | `HANDOFF.md:581` `[报告]` |
| 14 | 绑 `0.0.0.0` / 放宽 Host 校验 / 同源免 CSRF | **需用户本人在自己的轮次里说**（权限系统判为 Security Weaken 并拒绝） | `oss-scout.md:1232,1910` `[报告]` |

---

## 五、✂ 已裁掉（不是债，别再有人去做）

按 ADR 与用户指令，逐条给出处。**建议下一个 agent 开工前先读 `ADR-016`，否则会去做已经被砍掉的东西。**

| 裁掉什么 | 出处 |
|---|---|
| TTS（memo.ac 有 Kokoro，我们不做） | `ADR-016:24-25` |
| 本地 ASR 扩容：sherpa 多模型族分派 / SenseVoice / Qwen3-ASR / Omnilingual / AMD ASR 自建 CI | `ADR-016:28`（✅ 保留 Paraformer 与 sherpa 流式 zh-14M，用户明说「已经做那两个留着」） |
| 追平 memo.ac 的 47 条 ASR 模型 | `ADR-016:32`（差距**接受**） |
| 内置 LLM：档 3 `llama.cpp` / `llama-server` 整体下线 | `ADR-016:35`（✅ 保留 BYO API Key、探测已装 Ollama/LM Studio） |
| 「可导入任意 HF GGUF」对外口径 | `ADR-016:73-74`（`kind:'hf_repo'` 硬编码 501，**改口径不补实现**） |
| 「真实 AMD 支持」对外口径 | `ADR-016:75-76`（只覆盖 LLM 不覆盖 ASR） |
| workspace 层级 | `ADR-006:48-50`（`ADR-016:61-63` 追认结论、否定原理由） |
| 翻译 / 双语字幕 / 字幕导出 | `ADR-006:57-60`（D-02 保留预留表，不实现） |
| 说话人分离 | `ADR-011:82-84` |
| L0 浏览器 WebGPU / `/ws/asr-worker` | `ADR-006:36-46`（降为实验特性，不进 v1） |
| 桌面外壳 Tauri | `ADR-003:31` |
| 离线全量安装包 | `ADR-003:91-93` |
| 代码签名证书（Apple $99 / Windows OV $129 / 硬件令牌 $379） | `ADR-003:81-88`（走 ad-hoc 签名）⚠️ 但见 🟡-4 |
| 自建模型 CDN | `ADR-004:24-27` |
| 法务咨询（R-03 §6.2 的 8 项） | `ADR-002:67-69`（全部降级为文档记录） |
| `tldraw` / `@tiptap-pro/*` | `ADR-002:25-27` |
| `build-sqlite-ext.sh` 停用；`build-media-tools.sh` 降可选；`build-whisper.sh` 不进默认流程 | `ADR-015:48-49` |
| **A-1 GitHub 仓库这条硬阻塞** | `ADR-015:56-57` **已撤销**。⚠️ `ADR-003:53-55` 与 `ADR-010:39` 仍把它当阻塞前提，`PENDING-USER-DECISIONS.md` 里"唯一硬阻塞"的说法已过期（`HANDOFF.md:583`） |
| macOS Intel 支持 | 用户 2026-08-05 裁定 |
| 向量检索（`/api/search` 的 `modes.semantic=false`） | `HANDOFF.md:565`「已裁决的取舍，不是 bug」 |
| ROCm 换 noble 后的冲突复验 | `ci-runner.md:233`（"可能永远不会验证"） |

---

## 六、顺带查到的三处口径冲突（不是欠债，但会让下一个人算错账）

1. **A-2（NVIDIA 机器）的优先级**：`ADR-011:60` 写"最高优先级"，`ADR-013:29` 已降回普通 —— **ADR-011 原文没有就地标注失效**，两篇都是 `accepted`。
2. **`ADR-006` 的 YAML frontmatter 是坏的**：第 1 行是孤立的 `-`，`:2-7` 是 08-07 追加的 markmap 摘除订正块，第 8 行 `--`，真正的 `status: accepted` 在**第 11 行**（其余 15 篇都在第 4 行）。**任何按 frontmatter 解析 ADR 的脚本会漏掉这一篇。**　`[报告]`（来自 ADR 扫描，我未逐字节复核 frontmatter）
3. **`ADR-015` 自建 vs 上游**：`:47-49` 定「我们不托管任何东西」，`:66-140`（08-07 由 `platform-backlog` 追加）又把 4 个 whisper.cpp 包改回自建托管。是**例外不是撤销**，但同一个 `date: 2026-08-02` 的文件里两段读起来相反，`:73-79` 的四个 id 是唯一权威清单。　`[报告]`

---

## 七、我没能审到的地方（**别把这份当成审全了**）

如实列。这一节不是免责声明，是**下一个人该从哪儿接着挖**的地图。

### 7.1 环境 / 权限限制

- **`:10000` 的 demo：一次都没碰。** 所以所有"运行实例上的实测"（demo 侧 5 条 warn、`yt-dlp 未找到`、`gpus: []`、`assetsPresent` 3 条缺失、真实 `/api/health` 返回体）我**全部拿不到**，一律标 `[报告]`。`HANDOFF.md:46-54` 那 5 条 warn 我一条都没复核。
- **`/root/data-memo`：一次都没碰。** 所以任何"用户真实库里现在是什么样"的判断我都做不了。**直接受影响的**：C-7 的 `skippedWithoutRole > 0` 到底成不成立 → `UNKNOWN`；`media/legacy/…` 那两条二义性记录是否还在 → `UNKNOWN`。
- **无 GPU / 无 Mac / 无 Windows / 无 22.04 / 无干净机器。** 第四节 🚧 里 4-7 条我只能核代码，核不到行为。
- **无浏览器、无 playwright。** 所有前端结论都是**读码 + 组件测试**得来的，**没有一次真实点击**。`ADR-012:61-68` 把这个定为"当前最大验证缺口"，**今天仍然是**。
- **无出网 / 无 API Key。** 云 LLM、真下载、镜像 sha256 全部核不到。

### 7.2 我主动没做的（时间/风险取舍，请知悉）

- **没跑全量 `pnpm -r test`**（几分钟起步）。我只跑了三处**针对性**的：
  `apps/daemon` 的 `dist/ws/recorder.test.js`（**8/8 绿**）、`packages/downloader` 全量（**35/35 绿**）、`scripts/check-orphan-exports.mjs`（✔）。
  全量的绿色我用的是 **CI run 31180565261** 的日志（daemon 434 / web 274 / pipeline 222，fail 0）→ 这一条是 `[CI 记录]` 不是 `[我本机跑过]`。
- **没跑 `pnpm format:check`**（`ci-prep.md:409` 报 403 个文件不过）→ 那个数字我标 `[未验证]`。
- **没跑 `scripts/mutation-check.mjs`**（要几分钟 + 先 build）。所以"这些护栏改坏了真会红"这句话，我**没有**独立验过一次。
  顺带核到：`mutation-check.mjs` **没有任何调用方**（不在 `package.json`、不在 `.github/`）——**这是设计如此**，它的文件头明写"不进门禁"，所以我**不**把它算成 🟡。
- **没构造任何安全利用链**（unpack 软链逃逸、DNS rebinding TOCTOU）。这两条我只核到"代码在不在"，核不到"能不能被利用"。

### 7.3 我扫过但**没有逐条回代码核**的（量太大，只能抽核）

- **`debt-audit.md`（123 KB，08-03）的 A/B/C/D/E 五档约 60 个 ID。** 我抽核了 A1/A3/A6/A12/C5/C17/C19/B4 等约 10 条，其中**多数已闭**。
  **剩下约 50 条我一条没核** —— 而按 `backlog-sweep.md:23` 的比例（105 条里 61 条已闭），这 50 条里大概率**一半以上早就闭了**。
  ⚠️ **别把 `debt-audit.md` 当今天的欠债清单读。**
- **`architect.md`（161 KB）/ `oss-scout.md`（151 KB）/ `model-mgmt.md`（145 KB）/ `gpu-runtime.md`（128 KB）**：均为 08-03 前后。我只核了被后续回执点名的交叉项。
  这四份里的"未实现/未验证清单"我**没有**逐条回代码核 → 它们没进本文档的总表。
- **`docs/design/` 的 11 份（共 ~700 KB）：我只读了目录和被 ADR/回执点名的片段，没有通读。**
  `debt-audit.md:151-164`（D 档）报告 D-01 的 F1/F2 端点规格整片虚构、D-07/D-08 约 1/3 的 `file:line` 已指不到、D-05 硬禁忌清单指向 7 个不存在的组件 —— **这些我一条都没核**，标 `[报告]`。
  **如果要我猜下一个 🟡 富矿在哪，是这里。**
- **`coordination/BOARD.md` / `ROSTER.md` / `FEATURE-COVERAGE.md`：没读。** `HANDOFF.md:282,625-628` 明说这三份严重过期、且 `FEATURE-COVERAGE.md` "两个方向都偏过"。读它们只会把噪声引进来。

### 7.4 我知道自己可能算错的地方

- **HANDOFF.md 是 08-03 的。** 我把它当**候选源**用、逐条回代码核，核出来它 ④ 那张"在途/未闭环"表 10 行里**至少 6 行已闭**（`:322` `:323` `:324` `:327` `:328`→部分 `:329`/`:330` 仍未验）。
  **HANDOFF 本身现在就是一份过期台账** —— 这可能是比下面任何单条都更该先处理的一件事。
- **本文档的 ✅ 一栏是"我能验到"，不是"没有问题"。** 例：ADR-016 的数据目录管理我核到 ②③ 有实现有测试，
  但 `ADR-016:59` 那条「**未测**：删除窗口内的写操作行为（SQLite 文件已删但 fd 仍开）」我**同样没测**，它至今没人补（`docs-public.md:107` 独立记到过同一条）。
- **我没有交叉核对提交先后。** 几处回执互相矛盾时（例：`platform-backlog.md:911` 说 `asr.coreml` 的 `required` 没改 / `:1148` 说改了），
  我一律**回代码看现在是什么**（现在是 `required: true`），而**没有**去还原谁先谁后。所以本文档回答"今天是什么状态"，不回答"当时谁说错了"。

---

## 八、如果只做三件事

1. **给 `ci.yml` 加一行 `pnpm check:orphans`**（🟡-1）。一行，把已经造好的锁挂到有人经过的门上。
2. **把棘轮的 `stripComments` 补成 `stripComments + stripStrings`**（🟡-2），基线从 72 变 76，把那 5 条逐条表态。
   顺手看一眼 `verifyCatalogSignature` —— 一个零调用方的安全控制，此前**没有任何机制**会替你发现它。
3. **裁 TD-001**（🟡-5）。ADR 指定你验收，而那一行已经红了整个项目周期。要么划掉，要么真去开。

---

*本报告的每一条 ✅ / ⛔ / 🟡 都附了我自己核过的行号或命令输出；`[报告]` 是转述、`[未验证]` 是拿不到、`UNKNOWN` 是不知道并说明了为什么。没有一个数字是猜出来填的。*
