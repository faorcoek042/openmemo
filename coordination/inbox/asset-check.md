# asset-check 回执

## [2026-08-03 23:05] T-136 DONE

### TL;DR（≤25 行）
- **成因不是我们猜的那个，但比猜的更糟：`rel_path` 这一列同时存在三种写入约定**
  （`transcribe.ts` 相对 `media/`；`migrateAssets.ts` 相对 `dataDir`；`recorder.ts` 绝对路径），
  而**读取方各挑各的基准**。自检写死 `<dataDir>/media` 一个基准 → 把 3 条好文件算成没了。
- **⚠️ 更要紧的是：那 3 条在线上是真的坏的 —— 播放 404。** `[实测 :10000 只读 GET]`
  `media/legacy/x.wav` 被拼成 `<dataDir>/media/media/legacy/x.wav`（**两个 media**）。
  播放端 `resolveAssetPath` 取的是「第一个**落在根内**的候选」，而候选①永远落在根内，
  于是 `extraRoots: [tmp, dataDir]` **从加进来那天起就是死代码**，一次都没被试过。
- **所以"红灯指错人"只对了一半，我必须直说**：告警**选中的行是对的**（那 3 条产品确实取不到），
  **说错的是原因** ——「文件已不存在 / 已被删除」是一句假话，3 个文件都在盘上。
- **`long.wav` 那条没有毛病。** `[实测]` 它是相对 `media/` 存的，文件就在 `media/long.wav`，
  线上播放 **206 正常**。任务里"相对但指错"的判断在这条记录上不成立 —— **不需要改用户库的记录**。
  （"相对但指错"这个**缺陷形态**是真的，迁移里确实没处理；我按它补了代码 + 4 条回归测试。）
- 判据全部换成**真的 `open()` + 读首 4 字节**（T-128 同一条标准），报告里给出十六进制证据
  和**程序真正找过的每一个位置**。
- 🆕 **`packages/runtime` 根本没有 `test` 脚本** —— 它那 391 行 `selfcheck.test.ts`（含 T-128
  那组"标杆"验证）**从来没在 `pnpm -r test` 里跑过**。已补上统一那一行。
- 门禁：`tsc -b` **exit 0** · `eslint .` **exit 0** · db 47 / **runtime 38（从 0 进门）** /
  pipeline 132 / daemon **196**（177→196：+15 是我，+4 是并行 agent）**全部 0 failed**。
  ⚠️ `apps/web` 有 **2 条红**，在 `src/lib/jobs/noteJobs.test.ts`（**T-138 的未跟踪新文件**，
  正在被另一个 agent 现场编辑）—— **不是我的改动**，我一个 web 文件都没碰。
- 反向验证：**三处独立变异体，全部真红，输出见下**；每次都先 `grep` 证明坏行在**即将运行的产物里**。
- **给 Manager**：改动只在代码，**没写用户库、没碰指针、没碰 `apps/web/dist`、没重启 `:10000`**。
  重启 demo 后那 3 条音频会立刻能播；启动迁移在用户库上是**零写入**（已在镜像库上实测）。

---

## 一、事实（全部 `[实测]`，可复现）

### 1. 用户库 `media_assets` 的真实形态

| id | role | rel_path | 文件实际在 | 线上播放（旧构建） |
|---|---|---|---|---|
| 1 | original | `long.wav` | `<dataDir>/media/long.wav` (37 MB) | **206 ✅** |
| 2 | audio16k | `media/legacy/job-01KZ12…-audio16k.wav` | `<dataDir>/media/legacy/…` | **404** |
| 3 | original | `jfk.wav` | `<dataDir>/jfk.wav` | **404** |
| 4 | audio16k | `media/legacy/job-01KZ1H…-audio16k.wav` | `<dataDir>/media/legacy/…` | **404** |

`:10000` 上逐条 `GET /media/asset/<uid>`（只读，带 Range 0-3）：

```
01KZ12PF4PSAM5W50PVM52YP63 -> 206     ← long.wav
01KZ12PF4RF88SWAZE7GK20DHB -> 404
01KZ1H8Z7JQN65261TYYX566RA -> 404
01KZ1H8Z7JH9Z8M69M73CZD40Q -> 404
```

404 的 body 把病根写在脸上：

```json
{"code":"ASSET_FILE_MISSING",
 "message":"file missing: /root/data-memo/media/media/legacy/job-01KZ12HV9MRM3D27Q5MAZKGKBP-audio16k.wav"}
{"code":"ASSET_FILE_MISSING",
 "message":"file missing: /root/data-memo/media/jfk.wav"}
```

**两个 `media`。** 自检拿的是同一个错基准，所以它列出来的那 3 行**恰好就是产品取不到的那 3 行**。

### 2. 结论：这不是"红灯指错人"，是"红灯说错了原因"

- 选中的**行**是对的（那 3 条产品真的用不了）。
- 说出口的**话**是假的：`3 条文件已不存在` / `对应的媒体文件已被删除，相关笔记无法回放`。
  3 个文件一个没少。**用户会去翻备份、会怀疑自己误删** —— 后果和你描述的完全一样，
  只是成因不是"它把好的报成坏的"，而是"它把**坏的原因**说成了另一件事"。
- 而 `long.wav` 被"一个字没提"是**正确的**：它本来就是好的。

> 我把这条当成 T-136 里最需要如实说的一句：**任务书里的两条前提，一条对一半、一条不成立。**

### 3. 根因：一个列，三种写入约定，谁都没记下来

| 写入方 | 形态 | 例 |
|---|---|---|
| `jobs/runners/transcribe.ts`（T-095 起） | 相对 `<dataDir>/media` | `<noteUid>/audio16k.wav` |
| `storage/migrateAssets.ts` | **相对 `<dataDir>`** | `media/legacy/job-…-audio16k.wav`、`jfk.wav` |
| `ws/recorder.ts` | **绝对路径** | `<dataDir>/media/recordings/….wav` |

`migrateAssets` 自己写出来的形态，**播放端的主根解析不了** —— 上一次"只处理绝对路径"的迁移
不但漏了相对路径，**它产出的就是这批读不回来的记录**。

---

## 二、改了什么

| 文件 | 改动 |
|---|---|
| `packages/runtime/src/assetPaths.ts` 🆕 | **全项目唯一那份解析规则**：`mediaAssetRoots` / `assetCandidates`（纯函数，含越界剔除）/ `probeAssetFile`（`open()` + 读首 4 字节） |
| `packages/runtime/src/selfcheck.ts` | `assetsPresent` 改用同一份规则；判据 `access()` → 真读；detail 列出**找过的每个位置**+首 4 字节；**删掉"已被删除"这句断言** |
| `apps/daemon/src/http/media.ts` | 解析从「第一个落在根内」改成「第一个**真打得开**」；404 列出全部候选；`repos` 收窄成 `MediaRepos`（可测） |
| `apps/daemon/src/storage/migrateAssets.ts` | 判据从 `isAbsolute` 改成**读不读得到**；新增 `matchByTail`（记录**少了前缀**的那一半）；统一产出**规范形态**（能相对 media 根就相对 media 根）；归档目标 `media/legacy/…` → `legacy/…` |
| `packages/runtime/package.json` | 🆕 补上与 db/pipeline/daemon **完全同一行**的 `test` 脚本（含空集守卫） |
| 测试 | 🆕 `assetPaths.test.ts`(11) · 🆕 `media.test.ts`(11) · `selfcheck.test.ts` +7 · `migrateAssets.test.ts` 4→8 |

### 两条旧断言被我改了方向，说明理由（⑤A-15 那一族）
`migrateAssets.test.ts` 原来写 `fs.readFile(join(dataDir, rel_path))` ——
**把"rel_path 相对 dataDir"这个当时的巧合写成了期望**，而同一列上 `transcribe.ts` 写的是相对
media 根。现在两条都改成**用播放端那份规则去读**（`readViaProduct`），钉的是"产品真的读得到"。

---

## 三、反向验证（三处独立变异体，真实输出）

每次都先 `grep` 产物，证明**坏的那行在我即将运行的那份 dist 里**（不靠"我还原了吗"）。

### 变异体 1 — 自检退回单一基准 + `access()`
```
=== 我即将运行的产物里，坏的那行在不在？ ===
538:            const MUTANT_T136_SELFCHECK = join(input.dataDir, 'media');

✖ ★ 三种历史路径形态都算"在"，缺的那条才报 —— 一条不多一条不少
  AssertionError: 应当只报 2 条，实际：
    4/5 条读不出来：audio16k→media/legacy/job-X-audio16k.wav；original→jfk.wav；original→really-gone.wav
✖ ★ 读不到时必须列出**找过哪些位置**，且不许断言"文件已被删除"
✖ ★ 全都读得到 → ok，且 detail 里带真读到的首 4 字节
  AssertionError: 没有可核对的证据：1 条资产都真的读到了内容（例：）
✖ ★ 0 字节的资产要报
ℹ tests 38 / pass 32 / fail 6
```
第一条就是**事故的一比一复现**：把盘上存在的 `media/legacy/…`、`jfk.wav` 报成读不出来。
（另有 1 条是变异体自身的副作用：我用 `join` 代替了 `resolve`，连带 `assetsContained` 变红。）

### 变异体 2 — 播放端退回「第一个落在根内的候选」
```
91: const MUTANT_T136_MEDIA = await probeAssetFile(roots, asset.rel_path);
94:   abs: MUTANT_T136_MEDIA.tried[0] ?? null,   // 事故形态

✖ ★ 相对 dataDir（migrateAssets 写的形态）—— 修复前这里是 404
  + body: '{"code":"ASSET_FILE_MISSING","message":"file missing:
           /tmp/om-media-XjRus3/media/media/legacy/job-X-audio16k.wav"}'   ← 两个 media
  + status: 404          - status: 200 / body: 'DATA-ROOT'
✖ ★ 裸文件名而文件在 dataDir 根上（用户库里的 jfk.wav）
  + message: 'file missing: /tmp/om-media-DkJK4o/media/jfk.wav'
✖ ★ 文件真的不在 → 404，且把找过的每个位置都列出来
ℹ tests 11 / pass 8 / fail 3
```
**与线上 404 的 message 逐字同形。**

### 变异体 3 — 迁移退回"只看 isAbsolute"
```
127: const MUTANT_T136_MIGRATE = true;   // 只把绝对路径当成需要迁移的

✖ ★ 相对但指错（记录 foo.wav / 文件在 media/legacy/foo.wav）→ 重挂到规范形态   0 !== 1
✖ ★ 相对且指错、但同名文件不止一个 → 不猜                                    0 !== 1
✖ ★ 相对且指错、但目标已被别的资产占用 → 不迁                                 0 !== 1
ℹ tests 8 / pass 5 / fail 3
```

还原后三处产物 `grep MUTANT_T136` 均为 **0 命中**，源码 0 命中。

---

## 四、正向验证（走产品真实路径，不是旁路）

### A. 已知状态的临时库（3 真在 / 1 真不在）
`/tmp/asset-check/dd`：`media/legacy/` 两份 + `jfk.wav` 在，**`media/long.wav` 故意不建**。
起一个 daemon（`--data-dir` + `--port 18136`，**没碰 :10000、没碰指针**）：

```
[daemon] ⚠️ 媒体资产无法解析：#1 original: 记录指向 long.wav，新数据目录里找不到能对上的文件

datadir.assetsContained | ok   | 4 条资产全部落在 /tmp/asset-check/dd 内
datadir.assetsPresent   | warn | 1/4 条读不出来：original→long.wav
        （找过：…/media/long.wav、…/tmp/long.wav、…/long.wav）
remediation：⚠️ 这**不等于**文件被删除：更常见的是记录里的路径与文件实际位置对不上…

播放：long.wav → 404（并列出全部找过的位置）；其余三条 → 200，body 分别是
      LEG1-content / JFK-content / LEG2-content（内容各不相同，可反查读的是哪个文件）
```
**报出来的就是那一条，不多不少。**

### B. 用户库的镜像（4 条全在，文件名/位置逐一对齐）
```
migrateMediaAssets: migrated = 0 | unresolved = [] | notes = []
记录有没有被改动：一个字都没动 ✅

datadir.assetsPresent | ok | 4 条资产都真的读到了内容
   （例：long.wav → …/media/long.wav 首 4 字节 4c4f4e47）    ← "LONG" 的十六进制
播放：四条全 200，body = LONGDATA / LEG1DATA / JFK-DATA / LEG2DATA
```
### C. 两个出口仍然同源（T-119）
`node scripts/selfcheck.mjs --data-dir … --daemon …` → **`✔ 25 项逐 id 一致`**

---

## 五、顺带查到的、还没修的问题（一并列出，按严重度）

1. **`ws/recorder.ts:270` 把绝对路径存进 `rel_path`**（`relPath: this.#wavPath`）——
   正是 T-095 在 `transcribe.ts` 修掉的那个缺陷，**录音这条路径漏了**。
   用户库里目前没有录音资产，所以没爆。我**没有改它**：recorder 没有任何测试可依托，
   而它在真实录音链路上；改了没测 = 又一次"未验证的修复"。
   缓解：新迁移会在每次启动把这类行规范成相对路径（规则②，幂等）。
   **建议派一个带录音 harness 的活去修这一行。**
2. **`media/legacy/…`（相对 dataDir）这种形态目前靠第三个根兜底才读得到。**
   我**刻意没有**把用户库里那两条改写成 `legacy/…` —— 它们现在能读，
   改它等于对用户数据做一次没必要的写。若要彻底消灭二义性，那是一次单独的、
   需要你点头的数据迁移。
3. **大小写**：Linux 下 `rel_path` 大小写敏感，代码不做归一化。macOS/Windows 上
   大小写不符的记录会"碰巧"解析成功 —— 跨平台行为不一致，**我没有验证过**，标 `未验证`。
4. **`indexFiles` 的 `mediaRoot` 参数是 `void mediaRoot;`**（收着不用），
   `depth > 6` 的截断也没有任何提示 —— 深层目录里的文件找不回来时不会说明原因。小坑，未动。

---

## 六、可直接收进 HANDOFF「假绿灯家族」的判据（新形状：**红灯说错了原因**）

> | # | 事故 | 后果 |
> |---|---|---|
> | **20** | 🆕 **同一列有三种写入约定，而每个读取方各挑各的基准** —— `media_assets.rel_path` 被
> `transcribe.ts` 写成相对 `media/`、被 `migrateAssets.ts` 写成相对 `dataDir`、被
> `recorder.ts` 写成绝对路径。播放端 `resolveAssetPath` 取「第一个**落在根内**的候选」，
> 而候选①（`mediaRoot`）对任何相对路径**永远落在根内** → `extraRoots` 这个参数
> **自加入之日起就是死代码，一次都没被试过**。`[实测]` 用户库 4 条资产 **3 条播放 404**，
> 报文里是 `…/media/media/legacy/…`（**两个 media**）。自检拿同一个错基准算，
> 于是给出一句**假话**：「3 条文件已不存在 / 对应的媒体文件已被删除」——
> **那 3 个文件一个没少，全在盘上。**<br>
> **这一条最坏的地方不是它红，是它红得**言之凿凿**：** 它**选中的行是对的**，
> 只有**原因**是编的。人不会去质疑一条"细节这么具体"的告警，只会去翻备份、
> 怀疑自己误删；而这期间真正的病根（记录与文件位置对不上）连一次都不会被想到。
> **假红灯里最贵的一种，是"结论对、理由假"** —— 它比全错的红灯更难被推翻。<br>
> **规矩 1：一个字段有多种历史写法时，"解析规则"必须是全项目唯一的一份，**
> 由播放端、自检、迁移**共用同一个函数**；三份实现就等于三种真相。<br>
> **规矩 2：候选式解析要选「第一个**真能打开**的」，不是「第一个合法的」** ——
> 后者会让所有兜底分支静默失效，且**永远不报错**。<br>
> **规矩 3：告警文案不许替用户下诊断。** 说得出的只有"我在这几个位置找过，都没读到"
> （**把位置列全**）；说不出的（"被删了"）就别说。
> ✅ 已修（T-136）：`packages/runtime/src/assetPaths.ts` 三方共用 + `open()` 读首 4 字节，
> 三处变异体反向验证均真红。 |

> 另补一条到 ⑤A-2（`node --test` 对空集返回绿，第五次）：
> **`packages/runtime` 压根没有 `test` 脚本。** 它 391 行的 `selfcheck.test.ts`
> ——**包括 T-128 那组被当作"本项目验证标杆"的四段反向验证**——
> 从来没有在 `pnpm -r test` 里跑过一次。基线 `555` 里没有它，所以没人发现少了什么。
> **判据不是"测试写没写"，是"它有没有出现在那个数字里"。** 已补统一那一行（现 38 条）。

---

## 七、纪律自查

- ✅ **没写 `/root/data-memo`**（只 `cp` 出库文件；`ls -la` 显示 media/ 与 jfk.wav mtime 未变）
- ✅ **没碰数据目录指针**：开工前备份 + 收工核对，sha256 `7f930979…` **前后一致**，
  内容仍是 `{"dataDir":"/root/data-memo"}`。两次临时 daemon 都走 `--data-dir`
  （只有 `POST /api/storage/move` 会写指针，我没调）
- ✅ **`:10000` 只读**：全程只发 GET，未重启未 kill 未占端口，收工 `/api/health` 200
- ✅ **`apps/web/dist` 未被触碰**（mtime 停在 22:09，早于我开工）；构建一律 `pnpm build:safe`
- ✅ **没用 `pkill -f`**：两次都是 `ps -eo pid,args` 找 pid 再 `kill <pid>`
- ✅ **没跑 whisper 转写测试**
- ✅ 精确改动清单见 §二（新增 3 个文件、修改 6 个文件；`git add -A` 未使用）

### 门禁最终数字
```
tsc -b   exit 0
eslint . exit 0
packages/db       47 pass / 0 fail
packages/runtime  38 pass / 0 fail   ← 本轮才第一次进门禁（原本一条都没跑）
packages/pipeline 132 pass / 0 fail
apps/daemon       196 pass / 0 fail
apps/web          ⚠️ 2 fail —— src/lib/jobs/noteJobs.test.ts（T-138，别人的未跟踪新文件，
                     期间还从 1 fail 变成 2 fail，说明它正在被现场编辑）。与本任务无关。
```

### 需要 Manager 决策
1. **用户库那条 `long.wav` 不需要改** —— 请不要按任务书里的设想去改它，它是对的。
   四条记录**一条都不用动**，重启 demo 即可让那 3 条音频恢复播放。
2. 是否派活修 `ws/recorder.ts:270`（要带录音 harness）。
3. 是否要把 `media/legacy/…` 这种老形态统一改写成 `legacy/…`（**会写用户库**，我没做）。

### 未验证 / 存疑
- 大小写不敏感文件系统（macOS/Windows）上的解析行为 —— `无法在本机验证`。
- 我没在**真浏览器**里点过播放；证据是 `curl` 拿到的状态码与**逐字节内容**。
