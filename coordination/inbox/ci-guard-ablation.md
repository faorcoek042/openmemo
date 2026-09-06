# ci-guard-ablation —— CI 守卫层消融审计（92 脚本 / 45,789 行）+ 四条裁决的落地回执

> **产出者**：`ci-guard-ablation`（#85）
> **起点 HEAD**：`23293d7`
> **未碰**：`packages/db|shared`、`apps/daemon/src/{db,media,jobs}`、`:10000`、`/root/demo-build`、`/root/data-memo`。
> 全程在 `git worktree`（`/root/wt-ci-guards`）里做，`/root/memo` 一个字节没动。
> **本地一条测试都没跑**（`pnpm test` / `pnpm -r test` 禁止）；判决交给 CI。
>
> **证据等级**：`[我核过]` 我跑过命令 / 做过消融，附输出 · `[读码]` 读过源码，附 `文件:行号` ·
> `[未验证]` 没人验过。

---

## 一、审计结论（Manager 已接受）

**92 个脚本里一个完全冗余的都没有。** 三组最像的都逐一比过，全部不冗余，而且互相在注释里点名分工。
唯一的真重复在**助手函数**上，不在守卫上（见下面欠账 ③）。

可达性分层 `[我核过]`（import/spawn 闭包，不是 grep 提及）：

| 层                                             | 数量 | 含义                     |
| ---------------------------------------------- | ---- | ------------------------ |
| `ci.yml` 推送门禁可达                          | 56   | 每次 push/PR 真跑        |
| 仅夜跑可达（8 条 cron 腿）                     | 13   | 每天一次                 |
| 仅 `workflow_dispatch` 可达                    | 23   | 多数一个月没跑过         |

---

## 二、本轮落地的四件事（全部带反向验证）

### ① T-163：`lint-workflows` 从手抄 7 条 → 扫描 `selftest-*` 全集

`[我核过]` 磁盘上 **29** 个 `selftest-*`，链上 29 个，而这道门只看得见 **7** 个
⇒ **另外 22 个里的任何一个被摘掉，`ci.yml` 一声不吭**。唯一兜底 `MIN_LINKS=25`
要删满 13 环才响，而且只在夜跑的 `ci-crossplatform.yml` 上。

判据本体挪进 `run-selftests-all.mjs::auditSelftestCoverage()` —— **不是为了分文件好看**，
是因为它在 `lint-workflows.mjs` 里根本没法被反向验证（顶层执行 + `process.exit()`，import 不进来）。

**反向验证**（`selftest-workflow-expiry.mjs` C 组，13 条）：

- **C3 ★★★**：把 `selftest-mutation-verdict.mjs` 从链里摘掉当夹具 ——
  **新实现红、老实现（手抄 7 条 + `includes()`）一声不吭**。这是唯一能证明这次改动
  换来了鉴别力的一条。
- **C5c**：老实现被一个**参数位**骗过（`node x.mjs --baseline selftest-bundle.mjs`
  满足 `includes()`，而那一环根本不跑它）；新实现按 `parseLink()` 取真正会执行的脚本。
- **C6**：扫到 0 个 ⇒ 红，且红的**第一读法是"扫描器坏了"**，不许同时报"这些没接链"。
- **C6f**：正好卡在地板上 ⇒ 绿（地板不是焊死在红上的）。

⚠️ **刻意没有豁免名单**。一份"这几个可以不接链"的例外表，第二天就是新的手抄名单。

### ② `selftest-launcher-path`：手写 LEGS 4 条 → 扫描 + 双向登记册

`[我核过]` 真正起 daemon 的脚本是 **11 个**，老名单认得 4 个。而它的 ⑤「前提自检」
只检查*登记的腿存在*，**从不检查*所有腿都被登记***。手抄名单错了**两次**：

- 漏了 `measure-install-phases.mjs`（它一直走启动器，只是没人知道）；
- 判据②只认 `spawnDaemon(` 一个名字 ⇒ 就算把 `e2e-coldstart` 加进名单，
  它也会被判成"没走启动器"（它用的是 `spawnViaLauncher()`）。

现在：入口名**从模块导出里取**；登记册与扫描结果**两个方向都要相等**（⑤a 漏登记红、
⑤b 登记陈了也红）；`direct` 那条哪天开始走启动器了 ⇒ **也红**（豁免必须会过期）。

**③④ 从「文本存在」换成「真的执行」** `[我核过]`：造一个临时"包"，放一个会写脚印的
启动器，调 `spawnViaLauncher()`，看脚印在不在、参数有没有透传。
消融证明：把共享模块退化成「不执行启动器、只留一个没人用的常量数组」——
**新判据红（脚印不存在），老判据（`code.includes('start.sh')`）全部通过**。

四次消融全部验证 `[我核过]`：漏登记红 / 登记陈了红 / 新增一条绕过启动器的腿红 /
`direct` 开始走启动器红。

### ③ `dependency-audit` 静态那一半接进 `ci.yml`

`[我核过]` 它此前唯一的自动调用方是 `cold-start-audit.yml`，**最后一次运行 2026-08-08**，
而它守的 `vendor/manifests/` 在那之后**改过 5 次**（08-10 ×3、08-24 ×2）。
本地 71 个下载文件、< 1s、不要网络不要 build。`--live` 那一半留在原处（网络抖动不该变成门禁红）。

接线由 `selftest-summarize-gate.mjs` 已有的那条断言兜着（"gate 里每个带 id 的 step
都在 STEP_LABELS 里"）；消融验证过：从 `GATE_STEP_NAMES` 里漏掉它 ⇒ 自检当场红 `[我核过]`。

### ④ 删除 `tool-discovery-timing.mjs` + 它的 workflow（唯一一个）

`[我核过]` 零个 `process.exit(1)`，任何缺陷状态下都绿；`gh run list` 显示**全历史只跑过 1 次**
（2026-08-10）。判据不是"它没用"，是**抽掉它没有任何一条判据失去主语**。
92 个脚本里唯一满足这个条件的。

**`platform-facts` / `probe-cpu-features` / `probe-cold-timing` 不删**，改为登记进
`check-workflow-expiry.mjs` 的新 `INSTRUMENTS` 表，每轮打印「仪表，不是门禁，永远 exit 0」。
⚠️ 表里写死了那个陷阱：`probe-cold-timing.yml` 里的 **`probe-warmup-verify.mjs` 是真守卫**
（产品声明被证伪就 exit 1），删仪表不许连 workflow 一起删。

---

## 三、🔴 需要 Manager 裁决：4 条「没人判过」的豁免

`selftest-launcher-path.mjs` 的登记册里有 4 条 `evidence: 'unexamined'`，**每轮绿的时候也会打印出来**。
它们不走启动器这件事是**事实**；那样**对不对没人判过**。我没有替它们编理由（那正是这道门要防的事）。

| 脚本                        | 现状                          | 要裁的                                     |
| --------------------------- | ----------------------------- | ------------------------------------------ |
| `e2e-allcomponents.mjs`     | `direct`，夜跑腿              | 启动器那一段归谁？还是它本来就不该管？     |
| `cold-start-audit.mjs`      | `direct`，由 e2e-notes 夜跑带 | 同上                                       |
| `proxy-coverage-audit.mjs`  | `direct`，夜跑腿              | 同上                                       |
| `verify-bundle-upgrade.mjs` | `direct`，build-bundles       | 同上                                       |

已裁的两条（不需要动）：`e2e-browser-audit` 归 `bundle-launch-sim` + 人工
（`coordination/inbox/e2e-browser.md:100`）；`e2e-coldstart` 是 `mixed`，§7 走启动器、
其余刻意直起（`launcher-spawn.mjs` 文件头写着"不传参数的那条路由 e2e-coldstart 覆盖"）。

---

## 四、立条目、这一轮不做

### ① 🔴 结构上不可测：判据写在顶层执行的脚本里 ⇒ 没有东西能喂它输入

判据写在顶层执行 + `process.exit()` 的脚本里 ⇒ **import 不进来 ⇒ 没有任何东西能喂它输入**。
这正是 `e2e-runtime-audit` 那条判据烂了三周的成因，而它**没有被消灭，只是最贵的那个被部分拆开了**。

⚠️ 标题原写着「**10 个文件、~460 处内联判据、15,400 行**」。那三个数**已经旧了**
（notes / import 两条已经抽出并接上自检，datadir 那条当时根本不在表里），
而且中间那个数是用一个**混了口径的计数**加出来的 —— 见下面那段。
**标题里不再写数**：要现状就跑 `node scripts/ci/count-verdict-sites.mjs`。

> ## ⚠️ 先读计数口径 —— 这一列被误读过一次，代价是一整轮返工（2026-09-06 补）
>
> **口径**：一条「判据处」= **一个会影响退出码的判断点**。
>
> ⚠️ 原来那一列叫「内联断言」，而它**不是同一个口径数出来的**：
>
> | 写法                                                                                | 谁在用                                                       |
> | ----------------------------------------------------------------------------------- | ------------------------------------------------------------ |
> | `assert()`                                                                            | `e2e-runtime-audit`                                            |
> | `ok()` / `fail()` / `judge()`                                                         | notes / browser / import / coldstart / simulate / bundle       |
> | **布尔账本**：`rec()`/`record()` 收集 `PASS`/`FAIL`，末尾 `process.exit(fail>0?1:0)`  | `datadir-migrate-audit`、`proxy-coverage-audit`、`e2e-coldstart` |
> | `must()`                                                                              | `lint-workflows`（运行时条数远大于静态调用点）                 |
> | 没有助手，直接置 `exitCode = 1`                                                       | `cold-start-audit`                                             |
>
> 🔴 **按 `assert` 关键词数，会把布尔账本式的脚本系统性地压到 0~1 条。**
>
> 实例：`proxy-coverage-audit.mjs` 曾在本表记作「**1 条断言**」—— 那是 `assert` 关键词数，
> 而它根本不用 `assert`，真实判据处是 **11 处 `record()`**，覆盖七条出网路径。
> 「872 行 1 条断言」这个比例读起来像一条空转的守卫，于是有人据此去查它是不是仪表；
> 查完确认**它是守卫**（#97）。**那一轮返工是被计数口径带偏的，不是脚本的问题。**
> `datadir-migrate-audit.mjs` 更极端：`assert` 关键词数是 **0**，实际 **12 处 `rec()`** 覆盖八格。
>
> ⚠️ **别手抄下面的数字。** 它随每次提交变（本表的行数一列在两周里已经全部旧了一遍）。
> 要现在的数就跑 —— **口径已经写成可执行的**：
>
> ```sh
> node scripts/ci/count-verdict-sites.mjs
> ```
>
> ⚠️ **数它的时候别用 `grep -E '(^|[^a-z])name\('`。** `[我核过]` 本机的 `grep` 是
> **ugrep 7.8.4**，这条正则里「组内锚点 + 交替」**静默返回 0**，而 `0` 看起来就像
> "这个脚本一条判据都没有"。与 `530d8f6` 那条「macOS 上 `\b` 退化成字面 `b`」同族：
> **一个会因工具而异地返回 0 的计数器，比没有计数器更坏。**
> 上面那个脚本用 Node 的 RegExp，并且**数出 0 会出声**。

数字快照 `[我核过]` @ `34d8dda` + 本次提交（**只作快照；要现状请跑上面那条命令**）：

| 脚本                        | 行数  | 判据处 | 写法               | 抽出的判据模块                         | 自检喂输入                     |
| --------------------------- | ----- | ------ | ------------------ | -------------------------------------- | ------------------------------ |
| `e2e-runtime-audit.mjs`     | 3,018 | 55     | `assert()`         | `e2e-runtime-assertions` 361 行        | `selftest-e2e-runtime`         |
| `e2e-browser-audit.mjs`     | 2,586 | 45     | `ok()`             | `e2e-browser-assertions` 238 行        | `selftest-e2e-browser`         |
| `e2e-notes-audit.mjs`       | 2,048 | 55     | `ok()`/`judge()`   | ✅ `e2e-notes-assertions` 1,166 行      | ✅ `selftest-e2e-notes`         |
| `e2e-import-audit.mjs`      | 1,639 | 28     | `fail()`           | ✅ `e2e-import-assertions` 1,000 行     | ✅ `selftest-e2e-import`（#98） |
| 🔴 `cold-start-audit.mjs`   | 1,216 | **8**  | 直接置 `exitCode`  | 无                                     | **无**                         |
| `lint-workflows.mjs`        | 1,069 | 90 静态 / **1,978 运行时** | `must()` | 无                          | 部分（经 `run-selftests-all`） |
| `e2e-coldstart.mjs`         | 1,052 | **25** | **账本** `judge()` | 无                                     | 无                             |
| `simulate-user-launch.mjs`  | 928   | 33     | `ok()`/`fail()`    | 无                                     | 无                             |
| `proxy-coverage-audit.mjs`  | 926   | **11** | **账本** `record()`| 无                                     | 无                             |
| `datadir-migrate-audit.mjs` | 698   | **12** | **账本** `rec()`   | ✅ `datadir-migrate-assertions` 126 行  | ✅ `selftest-datadir-residue`   |
| `verify-bundle-upgrade.mjs` | 282   | 13     | `ok()`             | 无                                     | 无                             |

**这一轮订正了什么**：

- 🔴 `proxy-coverage-audit.mjs` **1 → 11**（`assert` 关键词 → 真实判据处）。就是它带偏的。
- 🔴 `e2e-coldstart.mjs` **16 → 25**。同样是账本式 —— `judge()` 里就写着
  `ledger.push(...)` + `if (!r.ok && fatal) exitCode = 1`。
- ➕ **补上 `datadir-migrate-audit.mjs`**，它此前**根本不在这张表里**，
  而它的 `assert` 关键词数是 0，正是最容易被判死的那一类。
- ✅ `e2e-notes-audit.mjs` 的「178 / 无 / 无」与 `e2e-import-audit.mjs` 的「无 / 无」
  都已被兑现（前者本节自己的建议，后者 #98）。那两格是**旧状态，不是现状**。
- `lint-workflows.mjs` 的「2,000 条」是**运行时**条数，与其余各行的**静态调用点**
  不是一个量纲，已分开写。

**重查结论**（判据是「有没有能判红的路径、红的条件是什么」，**不数关键词**）：

- **真守卫、判据正常，只是写法不带 `assert`** ⇒ **订正表，不动脚本**：
  上表 **11 个里的 10 个**，每一个都有明确的判红路径。
- **真守卫、判据确实薄** ⇒ **只登记，本轮不补**：🔴 **`cold-start-audit.mjs`** ——
  1,216 行、13 个 `hdr()` 分节，全文只有 **8 处**能置 `exitCode = 1`，且没有任何账本。
  它自己的注释（`:1138`）记着同一件事：「在此之前，第 8 节整节都是"只打印"」。
  `[读码]` **我没有逐节核对哪几节只打印不判** —— 那是下一个人的活，别把这句当结论抄走。
- **是仪表不是门禁** ⇒ **本表里一个都没有。** 仪表登记册在 `check-workflow-expiry.mjs`
  的 `INSTRUMENTS`，与这张表是两批东西，别混。

- **`lint-workflows.mjs` 仍然第二危险**：它在**推送门禁**上、运行时 1,978 条断言，
  **绝大多数没有任何一条被证明过会红**。T-163 那一条已抽出并反向验证，
  剩下的仍然是"读一遍觉得对"。

#### 🔴 第二轮：只重查这 11 个是不够的 —— 扫全量之后又多出两种写法

上面那一轮只重查了**这张表里的 11 个**。而这张表本身就是一份**手抄名单**，
于是第一版的 `count-verdict-sites.mjs` 照抄了它：**写死 11 条登记册，表里有谁就数谁**。
那正是本仓栽过三次的形状（`lint-workflows` 手抄 7 条 selftest / `selftest-launcher-path`
手写 4 条 LEGS，都是错了两次之后才改成扫描的）。**我自己刚修完那个病，转手又犯了一次。**

改成**扫全量 96 个 `scripts/ci/*.mjs`** 之后 `[我核过]`：

| 类别       | 个数 | 说明                                                     |
| ---------- | ---- | -------------------------------------------------------- |
| **守卫**   | 48   | 有能判红的路径                                           |
| **自检**   | 32   | 证明，不是守卫                                           |
| **仪表**   | 3    | 与 `INSTRUMENTS` 登记册**逐条一致**，没有错registration   |
| **判据库** | 14   | 被别人 import，本来就不该有 `exit`                       |

**又多认出两种写法**（原来只认到四种，说明"这一族"确实不止那两个）：

- ⑤ **`main()` 返回退出码** —— 判据是函数体里的 `return 1`，末尾 `.then((code) => process.exit(code))`。
  `probe-warmup-verify.mjs` 就是这种：`warm.ok && !after.ok` ⇒ `return 1`（**产品声明被证伪**）。
  它一度被扫描器数成 0 ——「那次红是对的」，红的内容正是"要么写法我不认识，要么我坏了"。
- ⑥ **聚合谓词** —— 判断是**一条作用在整张表上的布尔式**（`summarize-gate.mjs` 的
  `exit(allPass ? 0 : 1)`），根本没有逐条判据处可数。它**是守卫、判据也正常**，
  只是「判据处」这个量纲对它不适用。

⚠️ 还核了一条**反方向**的：`probe-cold-timing.mjs` 登记在 `INSTRUMENTS` 里，
而它确实有一处 `process.exit(1)` —— 但那是结尾 rejection handler 里的
「**脚本自身出错**」，不是产品坏了。**登记是对的**，扫描器改成不把那一发算作判据处。
（把它算成判据，仪表就会被误报成守卫；一条每轮都红、每轮都没人要做的误报，
最后训练所有人忽略这道门。）

**结论：三类里，第三类（仪表冒充门禁）在全层 96 个里一个都没有；
仪表登记册与实际逐条一致。** 第二类仍然只有 `cold-start-audit.mjs` 一个。

⚠️ **不要再往这份文档里抄计数。** 第二版扫描器刻意**放弃精确计数**：
④ 收集器那一类要从退出决策倒着猜哪个数组是判据容器，而它**会猜错**
（先后在 `check-elf-glibc.mjs` 上挑中遍历用的 `stack`、在 `check-comment-facts.mjs`
上挑中"跳过不判"的 `narrated`）。**一个错的小数字，和当初那个「1 条断言」是同一种伤。**
现在输出的是 `≥N`，**只用来发现 0**，并由 `selftest-verdict-sites.mjs`
在推送门禁上反向验证（抽掉任一种写法的识别 ⇒ 当场红）。

### ② 🟡 `startDaemon` ×9 / `stopDaemon` ×8 / `waitForJob` ×6 / `which` ×6

各腿各写一份。与 `probe-mirror.mjs:90-115` 记的那次「两份手写 `probe()` 各藏一个真 bug」
**同形**，那段的原话值得抄在这里：

> **潜伏不是因为它对，是因为没有任何输入能让它错。**

仓里已经做过一轮收敛（`assertPortFree` / `killTree`，Manager 2026-08-09 裁决 R-2/R-3，
六份收成一份），这几个是**同一轮没收干净的**。

### ③ 🟡 `platform-scope.mjs:34` 是一句注释型断言（本轮顺手发现，未修）

它写着：

> `scripts/ci/lint-workflows.mjs` 钉住了"哪些脚本可以收窄"这份名单。
> **不许有"运行时自动豁免"的路径。**

`[我核过]` `grep -n "narrowTo" scripts/ci/lint-workflows.mjs` → **零命中**。那份名单不存在。
今天有 2 个自检调 `narrowTo()`；第 3 个加进来不会有任何东西说话，
而那句注释会让下一个人以为机器管着它。**与 #103 那一族同形。**

按裁决「顺带发现只立条目，不顺手接上」，本轮只登记，未实现。

### ④ 🟢 `e2e-allcomponents-assertions.mjs:170-185` 的 `ratchetSingleSource` 是**单向**棘轮

它算了 `stale` 却不让它影响 `ok`（注释里写明是刻意的）。对照 `xplat-ratchet.mjs:189-196`
的方向②：那一半是"整条棘轮不烂掉的全部关键"。后果是
`single-source-baseline.json` 的 29 条只能停在原地，没有任何力量逼人收紧。
不是缺陷，是一次设计取舍 —— 登记在这里是为了它别被忘掉。

---

## 五、明确**不做**的（Manager 已裁）

**`fixtures/xplat/*.tap.txt` 不缩。**

我量过：可缩到 215 + 57 行（1.19 MB → 22 KB，98.1%），五个标定常数（42 / 5 / 9 / 2292 / 2329）
原值成立，三种退化解析器在切片上照样被抓 `[我核过]`。切片留在 `/tmp/xplat-ablation/`，**不进仓**。

**裁决理由**（Manager）：省体积不是这一轮的目标。那是仓里唯一一份完整的真实
`node --test` TAP 语料；将来扩解析器认 `# skip` / 诊断块时，切片里没有那些形状，
再造一份真日志的成本远高于今天省下的 1 MB。

—— 也就是我自己在报告里写的那句：**「用未来的回归语料换今天的仓库体积，不是纯赚。」**
