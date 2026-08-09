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
