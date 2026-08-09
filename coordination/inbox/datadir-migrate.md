# datadir-migrate 回执

## [2026-08-09 13:35] T-181 DONE（把「设置 → 数据目录」这条搬迁路验到底）

交付:

- `.github/workflows/e2e-datadir.yml`（新）+ `scripts/ci/datadir-migrate-audit.mjs`（新）——
  六格三平台的搬迁审计腿
- `[CI 实测]` run **31296921806** 三平台全绿：**win32 6/6 PASS 0 SKIP** · linux 5 PASS 1 SKIP · darwin 4 PASS 2 SKIP

**前一条「便携数据目录」任务已按用户改主意撤回。我当时只读了代码、没动过默认值，
所以没有需要回滚的东西**（转向时 `git status` 干净）。

---

### 一、Windows 上到底能不能真的移动 —— 答案是**能**，但有一个前提

`[CI 实测 run 31296921806, windows-2025]`

| 场景                        | 实际发生了什么                                                        | 界面说的         | 一致？ |
| --------------------------- | --------------------------------------------------------------------- | ---------------- | ------ |
| **同卷**                    | `strategy=rename`，`sourceRemoved=true`，**源目录真的消失**            | 「已移动」       | ✅     |
| **跨卷**（真跨设备 C:→D:）  | `rename` 如期 EXDEV → `strategy=copy`，**复制完源目录真的被删掉**      | 「已移动」       | ✅     |
| **DB 被握着时**（见下）     | `sourceRemoved=false`，**目标完整**，源目录残留                        | 「已复制…旧目录没能删掉」 | ✅ |

**结论：Windows 既能同卷 rename，也能跨卷 copy 后真删源。**
2026-08-08 那次「说已移动、其实没删」**不是 Windows 删不掉的问题** ——
是**当时有人握着 `openmemo.db`**。

⚠️ **跨卷这一格在 Windows runner 上是真的跨设备**（脚本先用一次 `rename` 探针确认拿到
`EXDEV` 才继续，`真跨设备=true`），不是同卷冒充。

#### 前提是什么 —— 这条我认为是本轮最该转出去的发现

**产品在调 `moveDataDir` 时，SQLite 句柄还开着。**
`apps/daemon/src/http/rest/storage.ts:510` 直接 `await moveDataDir(plan.from, plan.to)`，
全程没有 `db.close()`；而 `deps.db` 在**搬完之后**还要用来迁 `media_assets`（同文件 :531）。

- POSIX 允许 unlink 仍被打开的文件 → Linux/macOS 无感。
- **Windows 的 SQLite 共享模式不含 `FILE_SHARE_DELETE` → 删源必然失败。**
- 所以**生产环境的 Windows 用户，每一次搬迁都会落进「已复制、旧目录仍在」那条分支** ——
  界面说的是实话，但那不是他要的"移动"，而且旧目录里留着明文 `secrets.json`。

`[实测证据]` C4 用**真的 better-sqlite3 句柄**注入，Windows 上当场复现：
`sourceRemoved=false`、目标五类齐全、文案自动改口。**这就是用户 08-08 那次故障的完整成因。**

**建议（需 Manager 指派，我没有改产品代码）**：搬迁前先 `db.close()`，
搬完在**新位置**重新打开再迁 `media_assets`。⚠️ 有顺序约束：现在的代码是
「搬 → 用旧句柄迁资产 → 写指针 → 重启」，关库之后这条链要重排，不是一行改动。

---

### 二、「删源前必须逐文件校验」这条 —— **真的成立**（实测，非读码）

`[实测]` 五种坏法**逐一注入，全部被抓到**（三平台一致）：

| 注入                                   | 是否被拦 | 报的第一条                                                     |
| -------------------------------------- | -------- | -------------------------------------------------------------- |
| 缺文件                                 | ✅       | `缺失: media/a.mp3`                                             |
| 多文件                                 | ✅       | `多出: EXTRA`                                                   |
| 文件被截断                             | ✅       | `大小不一致: openmemo.db (1000 → 5)`                            |
| 符号链接目标被改写成绝对路径（T-128）  | ✅       | `链接目标不一致: … (libwhisper.so.1 → /旧路径/libwhisper.so.1)` |
| 链接被 deref 成真文件                  | ✅       | `类型不一致: bin/ext/libwhisper.so (符号链接 → 普通文件)`       |

**「删除放在 try 之外」也成立**：`[实测]` 注入"源删不掉"后，
`ok=true`、`sourceRemoved=false`、`sourceIntact=true`、**目标五类齐全**——
**没有出现"回滚把唯一那份完整副本删掉"**。这条性质我按最坏情形试过，它守住了。

#### 但这里有一处**残留的不实**（新发现，建议转给对应的人）

`[实测 windows]` 删源失败后，源目录**残留的是 `models, openmemo.db`** ——
`secrets.json` 其实**已经被删掉了**（`fs.rm` 是删到一半才失败的）。
而文案无条件地说「**其中包含 secrets.json**」。

- 严重性远低于 08-08 那次（方向是**保守**的：让用户去看一个可能更干净的地方），
  但判据是 Manager 定的那条「**界面说的和实际发生的必须一致**」，这条仍然没满足。
- 同时 `sourceIntact: true` 在这一格**字面上不成立**：源已经是个残缺目录
  （字段的真实含义是"完整的那一份还在不在"，而它确实在 —— 在**目标**那边）。
- **建议**：文案改成**枚举实际残留了什么**（`fs.readdir` 一次即可），
  而不是假设 `secrets.json` 在里面。

---

### 三、五类数据是不是都真的到了新位置 —— **是**（逐类核，不是只看指针）

`[实测]` 每次搬迁后逐类断言，三平台一致：
**数据库** `openmemo.db` · **媒体** `media/a.mp3` · **模型** `models/by-name/backend/ggml.bin` ·
**组件** `bin/ext/libwhisper.so.1.9.1` · **运行时** `runtime/runtime.json` —— 缺失 **0**。
两级符号链接（`libwhisper.so → .so.1 → .so.1.9.1`）搬完仍可解析，`staleLinks=0`。

⚠️ **指针与重启这两步我没有端到端跑**（那要起 daemon）。读码所见：
搬成功后 `writeDataDirPointer(plan.to)`（storage.ts:538），
且重启时**显式**把新 `dataDir` 传下去而不是让它猜指针。标 `[未验证]`。

---

### 四、「只切换不搬」—— **没有退化**

`[实测]` `parseChangeRequest` 六种输入：
只给 `path` → `move=false`（**没表达过的意图不解释成"搬"**）；`moveExisting:false` → 不搬；
`moveExisting:true` → 搬；旧别名 `move` 同语义；**新旧别名冲突 → 400 拒绝**；
`moveExisting:"false"`（字符串）→ **400 拒绝，不猜**。

---

### 五、跨卷那格：哪里做到了、哪里没做到（§11，跳过不算通过）

| 平台        | 跨卷 | 说明                                                            |
| ----------- | ---- | --------------------------------------------------------------- |
| **windows** | ✅   | `D:` 真实存在且可写，探针确认 `EXDEV`                            |
| **linux**   | ✅   | `/dev/shm`(tmpfs) 与工作盘跨设备，探针确认 `EXDEV`               |
| **macos**   | ⛔ SKIP | runner 上没有第二个可写卷。**需要**：用 `hdiutil` 建 RAM disk + `newfs_hfs` 挂载才能补上 |

**C4（删源失败）在 linux/macOS 上是结构性测不到**：POSIX 允许 unlink 已打开的文件，
所以注入必然失效 —— 这不是缺陷，**这正是"为什么它只在 Windows 上出事"的答案**，
已写进 SKIP 文案。脚本对这两格一律报 SKIP 并在汇总里单列，**不混进 PASS**。

---

### 六、给文档那位的 README 补充（我没动 `README`/`docs/**`，请转）

那张"东西都下到哪了"的表**内容是对的**（默认位置没改），缺的是**它可以改**。建议在表下补：

> **这些位置可以改。** 打开网页 →「设置 → 数据目录」，可以查看当前位置与各子目录占用大小，
> 也可以换到别的盘。换的时候可以选**把现有数据一并搬过去**，也可以只切换指向
> （只切换时，目标必须已经是一个 OpenMemo 数据目录，否则会被拒绝 —— 免得你得到一个空库、
> 以为笔记丢了）。
>
> **搬迁是先复制、逐文件校验通过之后才删除原目录**，中途失败不会两边各留一半。
> ⚠️ **Windows 上如果原目录没能删掉**（数据库文件仍被占用），界面会明确告诉你
> 「已复制、旧目录仍在」并给出路径 —— 这时**新位置的数据是完整的**，
> 旧目录需要你自己确认后删除（里面有明文的 `secrets.json`）。

（用词可自行精简；**「已复制 ≠ 已移动」和「旧目录含明文 secrets.json」两点建议保留** ——
这正是 08-08 那次不实所在。）

---

### 诚实声明

- **未改任何产品代码**：本轮新增的两个文件都是 CI 审计腿（workflow + 脚本）。
  两次提交都用 `git commit -- <pathspec>`，提交后 `git show --stat` 复核，
  **每次都只有我自己的文件**；期间别人在途的 `apps/web` i18n / `ModelCard.tsx` /
  `packages/downloader/src/download.ts` 等**一个都没被夹带**。
- **PROTOCOL §9**：全程 `mkdtemp` + `OPENMEMO_POINTER_FILE` 指到临时路径。
  真实机器指针 `~/.local/share/openmemo/datadir.json` **动工前记基线、收工再核**：
  sha256 `7f930979…233f3`、mtime `1785776819`、size 78 —— **三项完全一致，未被改动**。
  临时目录已清理干净（`/root/dd-audit-*`、`/tmp/ddaudit-*` 均无残留）。
- **PROTOCOL §11**：SKIP 一律单列、不计入 PASS。
  ⚠️ **上一版三条腿里有两条红是我脚本的缺陷，不是产品的**，已在
  `5344fa5` 里如实写明并修掉：① POSIX 分支把目标目录建在了自己设成只读的那个 holder 里；
  ② Windows 上 `fs.openSync` 带 `FILE_SHARE_DELETE`，注入根本不生效（它当时**报了 SKIP，
  没有假绿** —— 这条机制救了我一次）。
- **PROTOCOL §7**：workflow 用 `pnpm build:safe`，不碰 `apps/web/dist`。未跑 `pnpm -r build`。
- 未碰 `:10000`、`/root/data-memo`；未用 `pkill`；未建/改/删 release。
- `check:orphans` 本地跑过：**没有新的零引用导出**。新增文件已过 prettier（本仓需跑两遍）。
- `[未验证]`：搬迁后**指针写入与重启挂载新位置**未端到端跑（需起 daemon）；
  macOS 跨卷未覆盖（runner 无第二个卷）；**真机 Windows 上带 daemon 的完整搬迁**未跑
  —— 我复现的是同一个成因（真实 SQLite 句柄），不是同一条完整链路。
- `UNKNOWN`：`fs.rm` 在 Windows 上删到一半时的具体顺序（为什么 `secrets.json` 先没、
  `models` 与 `openmemo.db` 后留），只观察到结果，未追 libuv 实现。

## [2026-08-09 14:19] T-182 DONE（修我自己查出的根因：搬迁前关库）

交付:

- `apps/daemon/src/storage/moveWithDb.ts`（新）+ `moveWithDb.test.ts`（新，7 条）—— 关库/搬迁/重开的顺序编排
- `apps/daemon/src/http/rest/storage.ts` —— 走新编排；`moveMessageZh` 改成**枚举实际残留**
- `apps/daemon/src/storage/move.ts` —— 新增 `sourceResidue`（删源失败时 `readdir` 一次，不猜）
- `apps/daemon/src/main.ts` —— 注入 `closeDatabase` / `reopenDatabase`
- `scripts/ci/datadir-migrate-audit.mjs` —— 新增 **C7「产品自己的那条路」** + 指针重定向硬守卫
- 提交：`f91ac5c`（修复）· `7d4bfce`（C7+守卫）· `147fcac`（守卫收窄）· `b4d02e9`（lint）

### 一、修完之后 Windows 生产路径上还留不留旧目录 —— **同卷、跨卷都不留**

`[CI 实测 run 31298412129, windows-2025]` **C7 走的是产品自己的那条路**
（`createStorageRoutes` → 关库 → `moveDataDir` → 重开 → 迁 `media_assets` → 写指针），
真 SQLite 库、真 HTTP 请求、请求体与前端逐字节相同，然后去看文件系统：

| 场景 | HTTP | strategy | 关库/重开顺序 | **旧目录** | 界面文案 |
|---|---|---|---|---|---|
| **同卷** | 202 | `rename` | `close → reopen:C:\…\c7a-to` | **已消失** | 「已移动」 |
| **跨卷**（真 EXDEV，`C:` → `D:`） | 202 | `copy` | `close → reopen:D:\om-datadir-audit\…` | **已消失** | 「已移动」 |

**win32 8/8 PASS，0 SKIP。** 修之前这两格在生产路径上是**必然**留下旧目录的
（因为库一直开着）；现在两格都真的搬干净了，而且界面那句「已移动」是实话。

linux 7 PASS / 1 SKIP · darwin 5 PASS / 3 SKIP（macOS 无第二个卷，跨卷两格测不到）。

**注入式那一格（C4）仍然保留**并且仍然是 PASS：它证明的是**万一**删不掉时
目标还完整、文案会改口 —— 与 C7 回答的是两个不同的问题，两条都要。

### 二、关库失败路径的测试怎么写的

关键判断：**危险的不是搬迁，是搬迁失败之后库还开不开得起来。**
所以把顺序编排抽成 `moveWithDb.ts`，只依赖三个注入回调（`closeDb`/`reopenDb`/`move`），
不碰真实 fs 与 sqlite —— 这几条分支在真实环境里极难制造，而它们恰恰最危险。
七条不变量各一条用例：

1. 搬迁成功 → 在**新位置**重开；且**搬迁执行的那一刻库必须是关着的**（用例里直接断言 `db.openAt === null`）
2. **搬迁失败 → 必须开回原位置**，daemon 继续工作
3. **搬迁抛异常**（不是结构化失败）→ 同样开回原位置，不许让库停在关着的状态
4. **关库就失败 → 一步都不许往下走**（断言 `move` 根本没被调用），并仍尽力开回原位
5. 搬成功但新位置开不起来 → **退回原位置**重开（数据在新位置，但 daemon 得活着）
6. **连原位置都开不回来 → `databaseLost = true`**，必须能被调用方看见（路由把它翻成 500 +「请重启」）
7. 反向验证用例：模拟"失败后不重开"的坏实现，证明第 2 条断言**真的在看那件事**

**变异验证（在隔离 worktree 上做，PROTOCOL §10）**：
- 变异 A「不关库」→ **4 条红**（含路由层那条顺序用例）
- 变异 B「失败时不回原位」→ **2 条红**（第 2、3 条）
两个变异都被抓住，还原后 **583/583 全绿**。

另加一条**路由层**用例（`storage.dataDir.test.ts`）：真库、真路由、真搬迁，
断言 `dbEvents === ['close', 'reopen:<新位置>']`。
⚠️ 它断言的是**顺序不是结果** —— 因为在 Linux 上"忘了关库"从文件系统上**看不出任何区别**，
只有断言顺序才能让这个缺陷在任何平台上当场变红，而不必等到有人在 Windows 上试。

### 三、那句文案现在枚举出什么

`[CI 实测 windows-2025]` 原文：

> 已复制 6 个文件与 2 个符号链接到新位置并逐文件校验通过，正在重启以生效。
> ⚠️ 旧目录 `C:\…\c4-M9gI4C\src` **没能删掉，仍留在原地**。
> **里面还剩下：models、openmemo.db**，请自行确认后删除。

- `secrets.json` **不在残留里，所以这次一个字都没提它** —— 这正是上一轮那条保守假话被修掉的地方。
- 反过来当它**真在**残留里时，文案会点名并补一句「`secrets.json` 是明文的 API Key，注意别外传」。
- 残留为空时说「目录本身还在，但里面已经空了」，不列任何文件名。
- 三条各有一条用例钉着（`moveTruthfulness.test.ts`），其中「已被删掉时绝不许再声称它还在」是新增的。

⚠️ **一处诚实的限制**：枚举的是**失败那一刻的快照**（`fs.rm` 失败后立即 `readdir`）。
`[实测]` Windows 上同一次里，编排内拿到的是 `models, openmemo.db`，
而审计脚本稍后再读只剩 `openmemo.db` —— 多半是 Windows 的 delete-pending
（句柄一放就真的消失），但**成因我没有追下去，标 `UNKNOWN`**。
方向仍是保守的（可能多列一个已经消失的条目），但比"无条件声称 secrets.json"准确得多。

### 四、给文档那位的 README 补充（**按修复后的实际情况更新，替换我上一版**）

> **这些位置可以改。**「设置 → 数据目录」里可以查看当前位置与各子目录占用，也可以换到别的盘。
> 换的时候可以选**把现有数据一并搬过去**，也可以只切换指向（只切换时目标必须已经是一个
> OpenMemo 数据目录，否则会被拒绝 —— 免得你得到一个空库、以为笔记丢了）。
>
> **搬迁是先复制、逐文件校验通过之后才删除原目录**，中途失败不会两边各留一半；
> 搬迁期间数据库会被关闭并在新位置重新打开，**因此 Windows 上同卷与跨卷都能真正搬走、
> 不会留下旧目录**（`[CI 实测]` win32 同卷 rename / 跨卷 copy 均已验证）。
> 万一原目录仍未能删掉，界面会**列出里面实际剩下的东西**并给出路径，请自行确认后删除。

（⚠️ 上一版我写的是「Windows 上如果原目录没能删掉…」那句 —— **那是修复前的现实，别再抄**。）

### 诚实声明

- **PROTOCOL §9**：动工前记基线、收工再核 —— 真实指针 `7f930979…233f3`、
  mtime `1785776819`、size 78，**三项完全一致，未被改动**。临时目录（含 `/dev/shm`）已清干净。
  另外**把这条纪律做成了机器会拦的东西**：审计脚本会走产品路径写指针，
  所以它现在在「没设 `OPENMEMO_POINTER_FILE`」或「它就是本机机器级指针」时**直接 exit 2**。
  反向验证过三种输入（不设 / 指向真指针 / 指向 RUNNER_TEMP）。
- **PROTOCOL §12**：四次提交全部 `git commit -- <pathspec>`，**按 hash 复核**（不是 HEAD，
  HEAD 期间被别人推进过好几次）。每次都只有我自己的文件；
  别人在途的 `state.ts` / `apps/web/*` / `packages/downloader/*` **一个都没被夹带**。
- **PROTOCOL §10**：变异验证**跑在隔离 worktree** 上（`git worktree add` 检出我自己那个 commit），
  没有在共享树里拆过修复。worktree 已删除。
- **PROTOCOL §7**：只用 `pnpm build:safe`，没跑过 `pnpm -r build`。
- ⚠️ **我自己造成过两轮红，都不是产品的**，已在提交信息里如实写明：
  ① 指针守卫第一版写成「拒绝 $HOME 底下任何路径」，误伤了 GitHub runner 的 `$RUNNER_TEMP`
  （`/home/runner/work/_temp`），linux/macOS 直接 exit 2；**一条过宽的安全检查和一条不生效的一样有害**。
  ② C4 重构后忘了摘 import，`ci-crossplatform` 三条腿全红在同一个文件的 lint 上。
- `[报告]`（非我所验）：`ci-crossplatform` run 31298418469 仍有 darwin/win32 红，
  **落在 `packages/downloader`**（边车并发 EPERM、解包软链拒绝）——
  那是下载器那两路的在途区域，不是我的。**我的 daemon 用例在那一轮的 Windows 上逐条 `ok`**（已核对日志）。
- `[未验证]`：**真机 Windows 上带完整 daemon（含 JobQueue/Repos 等 11 处消费方）的搬迁 + 自我重启**
  没跑过 —— C7 起的是真路由与真库，但不是完整 daemon 进程。
  失败路径要求的重启我在代码里接了 `requestRestart(dataDir: plan.from)`，**其真实重启效果未端到端验证**。
- `UNKNOWN`：Windows 上 `fs.rm` 部分失败后残留条目会随时间变少的具体机制（疑似 delete-pending，未追）。
