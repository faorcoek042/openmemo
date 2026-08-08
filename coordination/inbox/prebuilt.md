# inbox: prebuilt

## [2026-08-08 01:20] T-预编译包（调研阶段） DONE

交付: `docs/design/D-17-prebuilt-bundles.md`

要点:

- **GPL 不触发，可以发。** 三条独立成立的依据：① 生产依赖闭包 268 个包**零 GPL/AGPL/LGPL**（逐个读已安装 package.json 的 license 字段）；② ffmpeg/yt-dlp 由用户机器直连 BtbN / yt-dlp 官方 GitHub 取，我们的 Release 上只有 6 个资产且全是 MIT 的 whisper.cpp；③ 调用方式是 `spawn(绝对路径, argv, {shell:false})` —— 进程边界，非链接。
- **推荐形态：官方 node 二进制 + 目录 + 启动脚本；否掉 Node SEA。** 决定性理由：SEA 对我们**根本产不出单文件**（sherpa-onnx 的 `.node` 旁边有 3 个必须同目录的 `.so`），代价全付、好处拿不到；且 SEA 注入会摧毁 Node 官方在 macOS 上的签名+公证。
- **[实测] 该形态已在 /tmp 里装出来并跑通**：网页 HTTP 200、`db=better-sqlite3 sqlite=3.53.4`、`dataDir` 落在 /tmp。体积 linux-x64 **162.8 MiB / .tar.xz 37.4 MiB**（实测）；win-x64 ≈117.3 MiB、macos-arm64 ≈178.9 MiB（由实测分件推算）。
- **两个平台地板实测都是绿的**（用本仓自己的守卫跑官方 node 二进制）：darwin-arm64 `minos 11.0.0` ≤13.3 ✅、linux-x64 `GLIBC_2.28` ≤2.34 ✅。用户担心的 `minos 26.0.0` 不在这条路上。
- **最容易炸的是 `sherpa-onnx` 而不是 better-sqlite3**：后者是 prebuildify + N-API，一次安装拿到全部 8 平台、跨 Node 版本通用、无 install 脚本（用户机器不需要编译工具链）；前者是每平台一个 optional dep、**pnpm 只装宿主那一个**，跨平台打包必须显式去取，且独占 macOS 包 58.8 MiB。

需要 Manager 决策:

1. **这些包发到哪里？** 公开 Release = 公开分发 → 需补 LICENSE 文件 / THIRD-PARTY-NOTICES / libsimple 的 MIT election（GPL 那条**仍不触发**）。仅自用搬运则只需第二项。
2. **libsimple + sqlite-vec 要不要进包？** +5.4 MB/平台、全 MIT、不碰 GPL。不放的话默认 `tokenizer=trigram`，**中文两字词搜索返回 0 条且不报错**（已实测到该日志）。我倾向于放，但它与用户判据 2 的字面表述有张力，不擅自决定。
3. **sherpa-onnx 留还是去？** 去掉 macOS 包从 178.9 → 约 120 MiB，代价是失去流式 ASR/VAD。我倾向于留。

顺带发现（不属本任务，交 Manager 裁决）:

- **ADR-002:24 的 `@blocknote/xl-*` (GPL-3.0) ✅允许 是空头许可** —— 该包从未被采用（package.json / lockfile / node_modules / 源码四处 grep 全 0 命中），实际用的是 TipTap（全 MIT）。建议删掉那一行：留着等于给未来的人一张引入 GPL 编辑器的通行证。
- **`scripts/build-media-tools.sh` 会把 GPL 的 ffmpeg 重打包成我们的 pack**；`mirror-model-blobs.mjs` 的白名单没有许可证闸门；`release-upload.mjs` 只校验 sha256 不校验许可证。三者今天都没触发，但都是一步之遥且不会报错。建议给 `release-upload.mjs` 加闸门（判据照 §7 补充：跑错了也不造成后果）。
- `scripts/license-report.mjs` 的 `collectManifests()` 把 manifest 包装对象当成单个组件迭代，导致 **60 条 per-pack 的 `license.id`（含 7 条 GPL-3.0-or-later）从来没被读到**；committed 的 `license-report.md` 里 B 类是空的（生成当时采集失败，之后没重生成）。
- `check-elf-glibc.mjs` 只看 `GLIBC_`，看不到 `GLIBCXX_`/`CXXABI_`；better-sqlite3 的 linux-x64 prebuild 需要 `GLIBCXX_3.4.29`（GCC 11+）。承诺范围内安全，但守卫覆盖不到。
- `pnpm-workspace.yaml` 的 `onlyBuiltDependencies` 里 `esbuild` 是陈旧条目（vite 8 用 rolldown，esbuild 根本没装）。

纪律自查:

- 未碰 `:10000`（作业前后均返回 200）、未碰 `/root/data-memo`、**未碰机器指针**（内容仍是 `/root/data-memo`，mtime 仍为 2026-08-04，早于本次作业）。实测启动全程用 `OPENMEMO_POINTER_FILE` + `OPENMEMO_DATA_DIR` 指向 /tmp，端口用 17777/17778。
- 未跑 `pkill`。未建/改/删 release。未跑 `pnpm -r build` / `vite build`，`apps/web/dist` 只读（`du` 与 `cp`）。
- 未碰版本号相关文件；只**读** `scripts/lib/version.mjs` 的 `readProductVersion()`（当前 0.2.0），包名沿用它已写好的 `openmemo-<version>-<os>-<arch>.<ext>` 约定。

下一步建议:

- 等用户对上面 3 个问题裁决后再进第二阶段（实现清单见 D-17 §9）。
- 本轮**未做任何实现**，仅调研 + 设计文档。

---

## [2026-08-08 02:20] T-预编译包（第二阶段实现） PROGRESS

交付:

- `scripts/build-bundle.mjs`（组装器）· `.github/workflows/build-bundles.yml`（三平台腿）
- `scripts/ci/verify-bundle.sh`（出厂检查，26 条）· `scripts/ci/verify-bundle-upgrade.mjs`（升级安全性，10 条）
- `scripts/ci/check-bundle-macos-floors.mjs`（macOS 分层守卫）
- `LICENSE` · 包内自动生成的 `THIRD-PARTY-NOTICES`
- `scripts/ci/check-elf-glibc.mjs`（补 GLIBCXX_/CXXABI_）+ 自检 34 例
- `scripts/ci/release-upload.mjs`（许可证闸门）+ 自检 18 例（新增 RV11/RV12）
- `scripts/ci/mirror-model-blobs.mjs`（许可证闸门）· `scripts/build-media-tools.sh`（GPL 确认闸门）
- `scripts/ci/cold-start-audit.mjs`（新增 `--bundle`）· `docs/adr/ADR-002`（撤销那一行）
- `docs/design/D-17-prebuilt-bundles.md`（补实测结果 + §10 三条 CI 发现）

要点:

- **三个平台的包都在干净机器上真的转出了非空文本**（CI 实测，run 31204790920 / 31205369931）：
  linux-x64 / win-x64 / macos-arm64 各拿到 108 字符，**借宿主 PATH 的 0 个**。
  体积全部换成实测值：176.3/41.0 · 132.0/49.0 · 192.4/59.9 MiB（未压缩/归档）。
- **sherpa 漏取当场红**：组装器无降级路径（找不到即退出 1），`verify-bundle.sh` 对**解开后的归档**
  再验一次原生件数量。两侧都反向验证过（抽掉 sherpa → exit 1）。
- **升级不坏数据目录有证据**：旧安装写数据 →**整个删掉旧安装**→ 新安装（不同路径）读同一数据目录。
  10 条断言全绿，含"数据库没被重建"与"机器指针未被改动"。
- **裁决 ② 的收益是实测到的**：`tokenizer=simple vec=on`（此前 `trigram/off`）。
- 反向验证（/tmp 隔离副本，§10）：基线绿；植入 ffmpeg / 抽 libsimple / 抽 sherpa / 抽网页 / 抽 LICENSE
  **五个变异全部 exit 1**。

需要 Manager 决策（3 条，都是 CI 实测出来的**产品事实**，不是缺陷）:

1. **⚠️ macOS 平台表与事实不一致。** 四个**上游预编译**二进制高于 README 承诺的 13.3：
   `libonnxruntime*.dylib` **15.5.0**、`sherpa-onnx.node` **14.0.0**、`ext/vec0.dylib` **14.0.0**。
   通过的：node / better-sqlite3 / **libsimple** 全是 11.0.0（**中文搜索不受影响**）。
   后果是**静默失效**（loadExtensions 不阻塞启动；sherpa 是容忍失败的懒加载）。
   我已把守卫改成分层（CORE 硬卡 13.3，可降级组各自声明 floor，上游再抬一档仍当场红），
   但 **README 的平台表是对外承诺，不在我职权内**。三个选项见 D-17 §10.2，我倾向
   「保留 13.3 + 在表里注明这两个功能各自的 floor」。
2. **daemon 的 `/api/health` 早于路由表应答**（D-17 §10.3）。`server.ts:122` 直接答 health，
   而 `main.ts:844` 才 push 路由 —— 中间有真空。Windows 上撞到了（`POST /api/folders` 404），
   Linux/macOS 没撞到。`server.ts:39` 的注释显示**单实例探测早就撞过同一个窗口**。
   我只改了自己的就绪判据；**窗口本身没修**，属 daemon 启动顺序。
   影响面：任何"health 通了就打业务接口"的调用方，含单实例探测与前端首屏。
3. **`test:ci-scripts` 需要接上我的新守卫**，但根 `package.json` 当时有版本号 agent 的在途改动，
   按"逐文件 stage"我没有碰它。请在版本号那条线落地后补上
   `verify-bundle.sh` / `verify-bundle-upgrade.mjs` 的自检挂载（或授权我来做）。

不是我的红（如实申报，未触碰）:

- `pnpm check:orphans` 现有 **2 条新的零引用导出**：`apps/web/src/features/runtime/api.ts ::
useBreakerQuery / useBreakerResetMutation` —— 断路器那条线的在途产物（功能只做了一半）。
- `npx eslint .` 有 **1 条不是我的**：`packages/runtime/src/selfcheck.test.ts:1089 Irregular whitespace`。
  我名下的 3 条已修。

纪律自查:

- 未碰 `:10000`、`/root/data-memo`、机器指针（升级验证里有一条断言专门核对指针未被改动，全绿）。
- 未跑 `pkill`。**未建/改/删任何 release**（只 `workflow_dispatch` 跑 CI，权限是 `contents: read`）。
- 逐文件 stage，每次 commit 前 `git diff --cached --name-only` 核对；未碰 `apps/web`、
  `package.json`、`packages/runtime/src`、`apps/daemon/src`。
- 反向验证全部在 `/tmp` 隔离副本上做（§10），共享树未出现中间态。

---

## [2026-08-08 02:55] health 就绪契约 + 自检挂载 DONE

交付: `apps/daemon/src/http/server.ts` · `apps/daemon/src/main.ts` ·
`apps/daemon/src/bootstrap/single-instance.ts` · `apps/daemon/src/http/readiness.test.ts`（14 例）·
`scripts/ci/selftest-bundle.mjs`（13 例）· `package.json` · `scripts/ci/lint-workflows.mjs` ·
`scripts/ci/verify-bundle-upgrade.mjs`

### ② health 什么时刻开始答 200、在此之前答什么

- **200 的时刻**：`main.ts` 里 `routers.push(...)` 之后、**「就绪」横幅打印之前**置 `isReady = true`。
  判据：**横幅说"可以用了"和 health 说 200，必须是同一件事**，不允许两者不一致。
- **在此之前**：`/api/health` 回 **503** + `ready:false` + `status:'starting'`，
  **身份字段（app / dataDir / host / port / instanceId / version）原样给全**；
  本来会落到 404 的请求回 **503 `SERVICE_STARTING` + `retryable:true` + `Retry-After: 1`**。
- **为什么不是"让 health 晚点答"**：那只是把窗口挪个位置。判据是
  「health 说 ready 的时候它承诺的东西必须真的在」，所以做法是**让它在没装完时说实话**。
- **闸门位置**：404 **之前**、其余一切之后。health / 静态产物 / 会话握手 / models 路由
  在 ready 之前本来就能工作，这道门一个都不挡 —— "别把启动探测饿死"因此是
  **结构上成立**，不是靠逐条豁免。
- **反向**：ready 之后，真正不存在的端点**仍然是 404**（有独立用例钉着，
  防止"把 404 换成 503"被写成"永远回 503"而把真信号也吃掉）。
- ⚠️ `retryable` 是**显式给的 true**：`sendError` 默认 false，第一版漏给，
  实测响应体是 `"retryable":false` —— 一个几百毫秒就自己好的状态却说"重试没用"。

### ② 单实例与端口漂移改完之后还工作吗（实测）

**必须配套改的一半**：`probeExisting` 原本 `if (!res.ok) return undefined`。
只做上面那半会引入**比它修的更坏的 bug**：A 启动中(503) → B 撞 EADDRINUSE →
判定「端口上不是我们」→ **静默漂到 17651**，而端口漂移 = 浏览器换 origin =
**用户麦克风授权要重新点一次**。现在 200 与 503 都算"是我们自己"
（判据在 body 的 `app` 字段，不在状态码），其余状态码仍然不算。

`[本机实测]`

- 真 daemon 抓到窗口：**t≈400ms 时 health=503、`/api/folders`=503 SERVICE_STARTING**（此前 404）。
  窗口 **< 2s** —— 这正是 Linux/macOS 从没复现、Windows 复现了的原因。
- 单实例：A 跑着时启 B → `exit 5`「另一个 OpenMemo 实例正在使用同一个数据目录 /
  数据目录锁生效」，**17802 无人监听 = 没有漂移**。
- `[CI 实测 run 31208766871]` 三平台全绿；**Windows 的升级验证现在等的是 health 200**
  并通过 —— 也就是说这条契约在当初暴露 bug 的那个平台上被端到端验证了。

`[反向验证，/tmp 隔离 worktree，PROTOCOL §10]` 三个变异各自变红、还原后 14/14 绿：

- RV-1 探测不认 503（会导致端口漂移）→ **3 红**
- RV-2 未 ready 时回 404 而非 503 → **2 红**
- RV-3 health 永远说 ready → **2 红**

### ③ 自检挂载后的断言数

- `lint-workflows`：**769 条断言 / 8 个 workflow**（此前 768）。
- `selftest-bundle.mjs`：**13 例**（4 正向 + 9 反向），已进 `test:ci-scripts`
  并钉进 lint-workflows 的必跑清单（摘掉会当场红，已验证）。
- 非空洞性已证：把 `verify-bundle.sh` 的 GPL 反向断言整段删掉，
  **那个守卫自己仍然报绿**（`检查了 25 条，失败 0 条` —— 25 仍 ≥ 20 的下限），
  只有新自检会红。也就是说这 13 例买到的正是"少检查一条却报绿"那一类。

### 门禁（隔离 worktree 检出 `97534c8` 跑）

`pnpm -r test` **1503 / fail 0**（上轮 1462）· `tsc -b` clean · `eslint` clean ·
`build:safe` 0 · `lint-workflows` 769/8 · `test:ci-scripts` EXIT=0 · `check:orphans` 绿。

### 一条要提醒 Manager 的操作风险

`git` 的**索引是三个 agent 共享的**。这轮我 `git add` 自己那 8 个文件后，
`git diff --cached --name-only` 里混进了**别人已 stage 的 `coordination/inbox/ui-backlog.md`**，
已 `git restore --staged` 剔除。**"逐文件 stage"不够，必须每次 commit 前核对 `--cached` 全量列表**
—— 只看自己 add 了什么会漏掉别人先 stage 的东西。

需要 Manager 决策: 无。

---

## [2026-08-08 18:50] ①「跳过」渲染成「成功」 + ② --out 相对路径 DONE

交付: `.github/workflows/build-bundles.yml`（新增 `complete` job）·
`scripts/ci/emit-bundles-complete.mjs`（新）· `.github/workflows/e2e-{notes,import,record}.yml`（收敛）·
`scripts/build-bundle.mjs`（`--out` 绝对化 + `--print-paths`）· `scripts/ci/selftest-bundle.mjs`（13→20 例）

### ① 判定放在**消费方**，由**生产方**发一个正面凭证 —— 依据

- **不能"让 skipped 算失败"**：手动只跑单平台是合法用法（`legs` 就是为此加的），
  判红会训练所有人忽略红灯 —— 而那正是本仓最贵的失败得以长期存活的土壤。
- **`conclusion` 在结构上装不下"产物在不在"**：它是 job 结果的汇总，
  而**跳过既非成功也非失败**。拿它当判据，问的问题和答的问题就不是同一个。
- **§11 的判据是「绿灯必须能追溯到这次 run 真的产出的东西」** ——
  而 **artifact 就是那个东西本身**。所以判定必须落在 artifact 上，不能落在 conclusion 上。

实现：`complete` job `needs: [linux, macos, windows]` 且**不带任何 `if:`**。
任一腿跳过/失败它就跳过 ⇒ 那种 run 里**根本不存在** `bundles-complete` 这个 artifact。
消费方问"有没有完整一套"就是问这个名字在不在。与 `build-backends.yml` 的
`merge-manifest` 同形同理（C4：`if: always()` 曾让三条腿全挂写出 `packs: []` 然后报绿）。
`emit-bundles-complete.mjs` 缺件时 exit 1 且**一个字节都不写**（说半句真话的凭证比没有更糟），
三平台版本号不一致也拒（那说明不是同一次构建的产物）。

### 四个消费方**全部**覆盖到了（而且是收敛，不是逐个打补丁）

判定逻辑此前有**三份拷贝**。三份都写对了同一件事，但那不是安全 ——
`resolve-bundle-run.sh` 的文件头记着它诞生的原因：同一段 shell 抄了两份、只修了一份。

| 消费方 | 改前 | 改后 |
|---|---|---|
| `e2e-runtime` | 已用 `resolve-bundle-run.sh` | 不动 |
| `e2e-notes` | `gh run list --status=success --limit 1` + 存在性检查→**取不到就红** | 改调共享脚本 |
| `e2e-import` | 自己一份"往回找"的拷贝（逻辑对，但是第三份） | 改调共享脚本 |
| `e2e-record` | **只认显式 `bundleRunId`，没传就死在 `run-id:` 空串** | 没传就走共享脚本往回找 |
| Manager（手工发 release） | 「取最近一次成功」 | `resolve-bundle-run.sh bundles-complete` |

`grep` 复核：`.github/workflows/` 下已**无任何** "最近一次 success" 判据。

### ★ 反向验证（真跑，不是推理）

**造了"两条腿跳过"的情形** —— `legs=linux`，`[CI 实测 run 31252840410]`：

```
✓ bundle-linux-x64      ← 跑了
- bundle-win-x64        ← skipped
- bundle-macos-arm64    ← skipped
- bundles-complete      ← **跟着 skipped（正是判据所在）**
conclusion: success     ← 陷阱仍在，且我们没试图改它
artifacts: bundle-linux-x64   ← **没有 bundles-complete**
```

消费方当场拒绝：
- `resolve-bundle-run.sh bundles-complete` → **exit 1**，并给出处置建议（跑 legs=all 或显式指定）
- `resolve-bundle-run.sh bundle-darwin-arm64` → **跳过 31252840410**，往回选中 31252437851

**正面路径也验了** `[CI 实测 run 31253028609，legs=all]`：`bundles-complete` job 跑了 17s，
凭证识别出 3 个平台（`.tar.xz` / `.zip` / `.tar.gz`，版本 0.2.0），
`resolve-bundle-run.sh bundles-complete` 选中它。

### ② `--out` 相对路径

病灶：`makeArchive()` 的 `tar` 带 `cwd: OUT_ROOT`，归档路径**跨了一次 cwd 边界**。
`[/tmp 隔离实测]` 还原 `resolve()` 后：`outRoot="rel/out"`、`archive="rel/out/…"`，
tar 以 `cwd=rel/out` 再解析一次 ⇒ 实际落到 `rel/out/rel/out/…`，**而脚本 exit 0**。
下游 glob 匹配不到，表现成"这次构建没有产物"，与"构建失败"长得完全不一样。

修法：`--out` / `--cache` 在 parse 时 `resolve()`。新增 `--print-paths`（只打印解析结果、
不碰网络不写盘），让这条性质**可测** —— 真跑一次要下 ~180 MB，那正是它此前漏掉的原因。
用例 ⑩⑪⑫ 覆盖相对 / 绝对 / 含 `..`；`[/tmp 隔离实测]` 还原修复后 ⑩ 的 `isAbsolute` 断言当场红。

### 门禁（隔离 worktree 检出 `20176f2`）

`pnpm -r test` **1577 / fail 0**（基线 1558）· `tsc -b` clean · `eslint` clean ·
`build:safe` 0 · `lint-workflows` **1177 条 / 13 workflow** · `test:ci-scripts` EXIT=0
（`selftest-bundle` **20 例**）· `check:orphans` 绿。

### 纪律

- 已按**新收的 §12** 事后复核 `git show --stat 20176f2`：**恰好 7 个文件，无夹带**。
  本条回执改用 `git commit -- <pathspec>` 提交。
- `/tmp` 我清了自己的约 650 MB（`bundletest` / `bt2` / `rv` / `prebuilt-research` / 旧 worktree）；
  只留 `/tmp/bundlecache` 46 MB（Node/sherpa/ext 归档缓存，删了要重下几百 MB）。
  当前 `/tmp` 4.0G / 12G。隔离 worktree 用完即删。
- 未碰 `:10000`、`/root/data-memo`、机器指针；未 `pkill`；**未建/改/删任何 release**
  （只 `workflow_dispatch`，workflow 权限是 `contents: read`）。
- 未碰另两路的文件（`apps/**`、`packages/**`、`main.ts` 与模型槽）。

需要 Manager 决策: 无。

⚠️ 一条**遗留事实**（不是我引入的，也没被我消除）：**部分跑的 run，
`conclusion` 仍然是 `success`。** 我没有去改它 —— 按你给的判据，
手动跑单平台是合法用法，不该被判红。现在的保证是"**消费方问得到真话**"，
而不是"conclusion 变得诚实"。任何新的消费方**只要还去读 `conclusion`，
就仍然会被骗** —— 这条建议写进给下一个人的文档里。
