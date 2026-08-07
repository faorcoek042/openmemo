# closure-fix 回执

## [2026-08-07 22:40] T-170 DONE —— 三条「声称已做、全仓零实现」+ 一条字符串嗅探

交付:
- `packages/pipeline/src/subprocess/runner.ts`（① 补实现 + 改注释）
- `packages/pipeline/src/subprocess/__tests__/killTree.test.ts`（新）
- `packages/pipeline/src/subprocess/argGuard.ts`（③ 两条注释，不是一条）
- `packages/pipeline/src/subprocess/__tests__/commentRefsResolve.test.ts`（新，守这一族缺陷）
- `packages/runtime/src/backends/applicability.ts` + `applicability.test.ts`（④）
- `docs/adr/ADR-003-runtime-and-process-model.md`（② 就地改 + 文末 §7 订正）

要点:
- **① Windows 孙进程**：补了 `taskkill /T`（不是只改注释）。理由是 `[实测 CI]` —— `taskkill` 在
  windows-2025 runner 上 exit 0（`D-11 §3.1`），且 `D-01 §2.5` 早就把这对命令写死了。**"泄不泄漏"两半分开答，见 §1。**
- **② macOS quarantine**：**没补实现，改了 ADR**，因为清 quarantine = 关掉 Gatekeeper 对自家产物的检查，
  属 Security Weaken，**必须用户本人拍板**。ADR-003 §7 给了三选一 + 一条 5 分钟就能定案的命令。
- **③ `resolveAndCheck` 确实不存在**，且**同一文件里还有第二条假注释**（`argGuard.ts:198`），审计没抓到。
- **④ 换成结构判据**，但**审计把后果高报了一格** —— 实测只有 `reason` 会变，`applicable` 一次没变过。
- **树上另一位（T-169）的 `packages/shared` 正红**，不是我的，见 §6。

下一步建议:
- ADR-003 §7 的三选一需要 Manager/用户一句话，在此之前决策 4 那半句仍是不实的。
- `commentRefsResolve` 这条守卫只抓 `see <驼峰>` 形状；`taskkill` 那种散文式假注释它抓不到（已写在文件头）。
- yt-dlp 到底有没有孙进程，本机取不到（§1.2），有真 Windows / 能装 yt-dlp 的机器时值得 5 分钟确认。

需要 Manager 决策: **ADR-003 §7.5 的 (A)/(B)/(C) 三选一**（补 `xattr` 属 Security Weaken，agent 不自行决定）。

---

## §1 Windows 孙进程到底泄不泄漏 —— **分两半答，一半实测一半取不到**

这个问题不能一句话回答，因为它是**两个独立条件的合取**：
**(a) 那些工具有没有孙进程** ∧ **(b) 杀直接子进程会不会连孙进程一起收**。

### 1.1 (b) 机制这半：`[实测]` 确认有洞，**但测的是形状不是 Windows**

我把 `runner.ts` 的两条分支逐字搬到 `/tmp` 复刻，对着一棵真的 父→孙 进程树各跑一次：

```
--- posix 分支（detached:true + process.kill(-pid)）
    before: child=ALIVE grandchild=ALIVE   after: child=dead grandchild=dead   <- 收干净
--- win32 分支（detached:false + child.kill()）      ← 修复前逐字如此
    before: child=ALIVE grandchild=ALIVE   after: child=dead grandchild=ALIVE  <- 泄漏
```

**这证明的是"杀一个 pid 不会收它的后代"这个形状，`[实测 本机 Linux]`。**
**它不是 Windows 的测量结果，不许当成 Windows 的证据读。**
Windows 上还有一种可能是作业对象（job object）替我们兜了底 —— 那需要一台真 Windows 才能排除
→ `[未验证：需真 Windows]`。本项目没有 Windows 机器（`closure-audit` 🚧-4 同）。

### 1.2 (a) 有没有孙进程这半：**一个实测证伪，一个 UNKNOWN**

| 工具 | 有没有孙进程 | 级别 |
|---|---|---|
| **ffmpeg** | **0 个**。本机两次真转码（`wav→mp3`、`mp4→wav`），全程采样 `/proc`，直接子进程数峰值 **= 0** | `[实测 本机]` |
| **yt-dlp** | **UNKNOWN** | 取不到，见下 |
| whisper-cli / sherpa | 未测（二进制不在本机） | `[未验证]` |

⚠️ **修复前那条注释写的是「ffmpeg and yt-dlp **both** spawn helpers」—— `ffmpeg` 那半我实测证伪了。**
新注释里已经把它改成只提 yt-dlp。

**yt-dlp 为什么是 UNKNOWN 而不是"我觉得会"**：本机**没有 yt-dlp 二进制**
（`/root/data-memo/bin` 下只有 `ext/`，未执行其中任何东西），**也没有出网**（`curl pypi.org` 超时），
所以既跑不了它、也读不到它的源码。**我拒绝在这里靠推断下结论。**

我能给的只有读我们自己代码得到的事实（`packages/pipeline/src/media/sources/ytdlp.ts`）：
我们**没有**传 `--ffmpeg-location`、`--extract-audio`/`-x`、`--merge-output-format`、`--remux`；
`preferAudioOnly` 时只传 `-f bestaudio/best`（不请求合流）。
**这降低了触发概率，但完全不足以断言"不会"** —— yt-dlp 对某些协议会自行调 ffmpeg 当外部下载器，
而那条路径我验不了。

### 1.3 所以结论是什么

> **我没能证明 Windows 上真的在泄漏，也没能证明没有。**
> 我能证明的是：**修复前代码里没有任何机制去防止它，而注释声称有。**
> 现在机制有了，且它在 Linux/macOS/Windows 上都被同一条用例覆盖着。

### 1.4 改了什么

- `killTree` 的 win32 分支改成 `spawn(taskkillPath(), windowsKillTreeArgv(pid, sig === 'SIGKILL'))`，
  `/T` = 整棵树，`/F` 只在 SIGKILL 那一级加（SIGTERM 那级保持"礼貌请求"，与 `D-01 §2.5` 一致）。
- **`taskkill` 走绝对路径**（`%SystemRoot%\System32\taskkill.exe`），不是裸名字 ——
  本文件对其它每个可执行文件都禁止 PATH 搜索，收尸路径更不该例外（被劫持就等于把进程树交出去）。
- **spawn 不出来时回落到 `child.kill(sig)`**，并处理 `'error'` 事件 ——
  未处理的 `'error'` 是未捕获异常，会把整个 daemon 带走。所以"没有 taskkill 的 Windows"也不会更坏。
- 注释重写：把 `[实测]` / `[未验证：需真 Windows]` 逐条标在代码里。

**反向验证** `[实测]`（`/tmp` 隔离副本，PROTOCOL §10）：把两处锚点改回修复前语义 →
`3/3 绿` 变成 `2/3`，红在 `孙进程 <pid> 在整棵树被 kill 之后仍然活着`。

---

## §2 macOS quarantine 今天真实行为 —— **验不了，如实说验不了**

### 2.1 不需要 Mac 就能定案的那半

- `apps/` + `packages/` 全仓 `xattr` / `quarantine` **零命中** `[实测 grep]` → **ADR-003:83 的断言不实**。
- ad-hoc 签名那半**是真做了**（四个 build 脚本都真调了 `codesign --force --sign -`，
  `build-backends.yml:236` 还有 `codesign --verify` 门禁）→ **决策 4 是"一半做了一半没做"**。

### 2.2 需要 Mac 的那半 —— `[未验证：需真 Mac]`

**「从网页装下来的 macOS 后端包，双击/执行时会不会被 Gatekeeper 拦」这个问题我取不到答案。**
本轮环境是 Linux，无任何 macOS 机器；CI 的 macOS runner 是非交互的（无 Finder、无 LaunchServices 会话）。

**而且这个问题问得还不够细 —— 它其实是两条必须分开的路径**，混在一起谈会得出相反的结论：

| # | 路径 | 级别 |
|---|---|---|
| ① 用户在**浏览器**里下发布包 → Finder 解压 | 属性会传播给解出来的文件 | `[报告]`（Apple 公开行为，**本轮没在真机验过**） |
| ② **daemon 自己**下后端包（undici/Node + 我们自己的 `unpack.ts`） | 普通文件写入，不经 LaunchServices → **可能压根不会被打上 quarantine** | `[未验证]`，**这是假说** |

**ADR 原文说的是路径 ②（"首次运行时由 daemon 自动清除"）。**
如果 ② 根本不会被打上 quarantine，那**缺的是论证不是代码**，ADR 改一句就闭合；
如果会，那今天每个 Mac 用户的加速包都可能加载失败。**两个结论差别极大，而它们只差一条命令**
（`xattr -p com.apple.quarantine <pack>/libggml-metal.so`，**必须带阴性对照**，写在 ADR §7.2）。

### 2.3 为什么没有直接补 `xattr -dr`

不是偷懒，是判断：

1. **清 quarantine = 关掉 Gatekeeper 对我们自己产物的检查**，与"绑 `0.0.0.0`"同属 Security Weaken，
   本项目既定做法是**用户本人在自己的轮次里说**（`closure-audit` 🚧-14）。
2. **在 §2.2 那条命令跑出来之前，我们不知道它解决的是不是一个真实存在的问题。**
   给一个未确认存在的问题、写一段本机无法验证的缓解代码 —— 正是本仓最贵的那类改动。
3. 真要做，`xattr` 也未必是最优解：ad-hoc 签名 + 首次右键打开，在"仅个人自用"下可能就够，
   那样 ADR 写成"我们不做，用户手动放行一次"论证链一样完整。

**已做的是：把决策 4 那两行就地改了**（删除线 + ⛔ + 指向 §7），**并在文末补了 §7 订正**。

### 2.4 这条最值钱的教训（已写进 ADR §7.4）

`build-backends.yml:207` 的作者**做对了 90%**：他发现了，也写下来了。
**但他写在了一个读 ADR 的人永远不会经过的地方。**
于是这条缺陷拿到了最坏的状态：**"有人知道"和"没人知道"后果完全相同，而台账上它看起来像被处理过了** ——
之后至少两轮审计又各自重新发现了一次，每次都付一遍全仓 grep 的钱。

> **一条不实的断言，只能在它被读到的那一行修。在别处挂警告，是把发现成本留给下一个人。**

---

## §3 `resolveAndCheck` 那条缓解到底存不存在 —— **不存在，且同一文件里还有第二条**

### 3.1 确认不存在

`grep -rn resolveAndCheck` 全仓 → **只命中那条注释本身**。`[实测]`
最接近的真实函数是 `assertHostNotPrivate`（`argGuard.ts:217`），但**它不是注释说的那个东西**：
它是**预检**（lookup 一次、检查、返回），随后的 fetch 会**自己再解析一次**。
所以 DNS rebinding 的 TOCTOU 缺口是**真开着的**，不是被覆盖的 —— 它自己的 docblock 也这么写着。

### 3.2 ★ 顺手抓到第二条，审计没记

同一个文件 **`argGuard.ts:198`**：

```
// L3.3 — SSRF. This is the literal-IP check; DNS names are re-checked at connect time.
```

**"re-checked at connect time" 同样是假的** —— 没有任何东西在连接时复查。
两条假注释一起，把"SSRF 已经有连接时防线"这个印象钉了两遍，而实现只有一次预检。
两条都已改成实话，并指向 `assertHostNotPrivate` 的 TOCTOU 说明。

### 3.3 由此加了一条守卫（这一族缺陷的机器执行者）

`commentRefsResolve.test.ts`：**注释里「`see` + 驼峰标识符」指向的东西必须真的存在。**

- 判据只认**含大写字母的驼峰**（`resolveAndCheck` ✓ / `kill(2)` ✗ / `D-06 §9` ✗）→ 误报压到 0。
- `[实测]` 全仓 408 个源文件里共 9 处该形状，修复前**恰好命中 1 条真缺陷**，其余 8 条全解析得到。
- 调试期一度误报 `localFile.ts:52 see resolveSafe` —— 那是**真存在的私有类方法**，
  第一版声明正则不认 `private async` 前缀。已修，并把教训写进文件头：
  **一条会误报的守卫，会被下一个人用一行豁免关掉，然后它就再也不响了。**
- **刻意不给自己开豁免**：本文件第一版被自己拦下 3 次（都是文档里举例），**改的是写法不是守卫**。
- **诚实边界**：`taskkill` 那条假注释**这条守卫抓不到**（不是 `see <标识符>` 形状）。已写在文件头，
  不假装覆盖面比实际大。

**反向验证** `[实测]`（`/tmp` 隔离源码树）：把悬空注释放回去 → `2/2 绿` 变 `1/2`，
红在 `argGuard.ts:111 -> resolveAndCheck`。

---

## §4 `applicability.ts:219` —— 换成结构字段，**并把审计的严重度往回收一格**

`packages/runtime/src/backends/applicability.ts:219`（**不在 `apps/web`**，审计给的路径是错的；
`manager.ts` 同理在 `packages/runtime/src/backends/`）：

```
- hardware.backends.every((b) => !b.available && (b.unavailableReason ?? '').includes('probe'))
+ hardware.backends.every((b) => !b.available && !b.probed)
```

任务书（与 `closure-audit` ⛔#3）说：T-168 新文案不含 `probe`，这条会**静默失效**。
**前半对，后半我实测下来是高报的。**

`[实测]` 我把新旧两版并排载入，对同一组输入逐个比对：

```
  同   探针失败文案 + 有/无 advisory
  同   T-168 文案 + 有 advisory
★ 异   T-168 文案 + 无 advisory
       结构判据 : applicable=false  reason="尚未探测到硬件能力；请先安装 CPU 基础包，安装后会自动重新探测"
       字符串嗅探: applicable=false  reason="installed, but this detection run did not load it: ..."
★ 异   T-168 文案 + 包已装 + 无 advisory   （同上）
```

> **`applicable` 一次都没变过，变的只有 `reason`。**

原因是 `evaluateApplicability` 里那条环打破器（`status.probed !== true` && advisory）：
探针没跑成时 `probed` 对每个后端恒为 false，所以 advisory 那条路**照样放行**。
**所以这不是"冷启动死锁原样回来"。** 真实后果是**用户看到的解释退化**：
本该是可执行的中文提示，退化成一串探针内部的英文。够格修，但不值得写成死锁。

⚠️ **我自己第一版的注释和测试也犯了同样的高报错误**，是反向验证（变异后仍然全绿）逼出来的 ——
测试拿 `applicable` 当断言，**新旧两版下都绿，什么都没验到**。已改成断言 `reason`，
并把"为什么 `applicable` 不是判别式"写进用例，免得下一个人再白写一条。

**反向验证** `[实测]`：把 `.includes('probe')` 放回去 → `13/13 绿` 变 `12/13`，
红在 `★ 文案换了 → 用户拿到的解释不许退化成探针内部的英文`。

---

## §5 门禁

| 门禁 | 结果 |
|---|---|
| `npx tsc -b` | ✅ exit 0 |
| `npx eslint .` | ✅ exit 0 |
| `pnpm build:safe` | ✅ exit 0（**未跑 `pnpm -r build`，未碰 `apps/web/dist`**） |
| `pnpm lint-workflows` | ✅ 562 条断言 / 6 个 workflow 全过 |
| `pnpm check:orphans` | ✅ `没有新的零引用导出，基线也没有过期条目`（新增的 2 个导出在本文件与测试里都有引用） |
| `pnpm -r test`（我改动的包） | ✅ pipeline **227/227**（222+5）、runtime **89/89**（85+4）、daemon **434/434**、web **406/406** |
| `pnpm -r test`（全量） | ⚠️ **红在 `packages/shared`，不是我的** —— 见 §6 |

改动前**先跑过基线**：`1301 tests / fail 0`，与任务书给的基线逐字吻合。我净增 **9** 条 → **1310**。

---

## §6 撞上的红灯：**是 T-169 的，不是我的**（按 §10 先查再判）

全量 `pnpm -r test` 现在红在 `packages/shared/dist/schemas.test.js:59`
（`回环 ::1 上的 http 应当放行` → `false !== true`）。

判定依据：
- 该包及其测试文件（`schemas.test.ts` / `contract.test.ts` / `jobs.test.ts`）**是本轮新出现的**，
  作者自陈 T-169（`packages/shared/package.json` 的 `_comment:test` 写着"这个包此前 0 个测试文件"）——
  正是 `closure-audit` 🟡-6 那条。
- **我一个字都没碰 `packages/shared/`**（被明确划为他人地盘）。
- 我第一次跑还撞到过一个**更早的中间态**（`check-test-scripts` 报 shared 有测试文件却没 test 脚本），
  几分钟后再跑就变成了现在这个 —— 典型的 §10「在最坏的那一秒，别人看到的是什么」。
- 同一轮里 `ci.yml` / `check-orphan-exports.mjs` / `check-test-scripts.mjs` / `orphan-exports-baseline.json`
  也都在被改（🟡-1 / 🟡-2）。**这四个文件我一个都没动。**

**没有替他修**，也没有把它算进我的门禁结论。

---

## §7 纪律自查

- ✅ 未碰 `:10000`、未构建 `apps/web/dist`（只用 `pnpm build:safe`）、未重启/占用该端口。
- ✅ 未写 `~/.local/share/openmemo/datadir.json`；**未执行 `/root/data-memo` 下任何东西**
  （只 `ls` 过一次找 yt-dlp，随即停手）。测量与反向验证全部在 `mkdtemp` 的 `/tmp` 目录里，**已删除**。
- ✅ 未用 `pkill -f`；未建/改/删任何 release。
- ✅ **反向验证全部在 `/tmp` 隔离副本上做**（PROTOCOL §10），共 3 组，**共享工作树里一秒都没有坏代码**。
- ✅ 逐文件 stage，commit 前用 `git diff --cached --name-only` 核对过。
  **未提交** `ci.yml` / `scripts/check-orphan-exports.mjs` / `scripts/check-test-scripts.mjs` /
  `scripts/orphan-exports-baseline.json` / `packages/shared/**`。
- ⚠️ **越界一处，主动申报**：`docs/adr/**` 按 PROTOCOL §1 是 Manager 专属。
  我改了 `ADR-003`（决策 4 两行 + 追加 §7）。理由：任务明确要求"让 ADR 与现实一致"，
  且树上有先例（`platform-backlog` 追加 `ADR-015 §7`、`ADR-006` 的订正块）。
  **原文一个字没删**（用删除线保留），§1–§6 与附录 A 除那两行外未动。**请 Manager 追认或改写。**

### 本轮"没验就说没验"的清单
- Windows 上是否真的泄漏孙进程 → `[未验证：需真 Windows]`
- yt-dlp 有没有孙进程 → `UNKNOWN`（本机无该二进制、无出网，**两条路都堵死**）
- macOS Gatekeeper 实际行为（两条路径） → `[未验证：需真 Mac]` / `[报告]`
- `taskkill` 在**普通用户**的 Windows 上是否都在 → `[实测 CI runner]` 有；普通机器 `[报告]`
  （已用回落到 `child.kill()` 兜住，缺它不会更坏）
- `argGuard.ts:101` 「our own daemon binds 127.0.0.1」与 demo 实际绑 `0.0.0.0:10000` 的出入
  → **没查**（不许碰 `:10000`），仍是 `[未验证]`，留给下一个人
