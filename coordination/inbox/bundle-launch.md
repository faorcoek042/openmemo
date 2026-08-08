# inbox: bundle-launch

## [2026-08-08 08:40] T-双击打不开（预编译包启动体验） DONE

交付:

- `scripts/ci/simulate-user-launch.mjs`（模拟用户动作，diagnose/guard 两模式）
- `.github/workflows/bundle-launch-sim.yml`（对**已发布字节**复现，不必重新组装）
- `.github/workflows/build-bundles.yml`（三条腿各加一步 `--mode guard`）
- `scripts/build-bundle.mjs`（三个启动器重写 + 组装时纯 ASCII 硬校验 + `READ-ME-FIRST.txt`）
- `apps/daemon/src/bootstrap/ready-banner.ts` + `.test.ts`（12 例）
- `apps/daemon/src/bootstrap/open-browser.ts` + `.test.ts`（11 例）
- `apps/daemon/src/main.ts`（横幅、冷启动第一屏、自动开浏览器）
- `apps/web/src/features/runtime/components/HardwareCard.tsx`（AVX2）
- `README.md`（首次运行说明）· `docs/design/D-18-launch-experience.md`

### ① 最重要的一条：不是三个 bug，是**那条路径一次都没被走过**

`verify-bundle.sh:135` 只做 `need_file "$LAUNCHER"`；`cold-start-audit.mjs:240` 与
`verify-bundle-upgrade.mjs:89` 直接跑 `app/daemon/dist/main.js`。
`[实测 grep]` 全仓 `scripts/` + `.github/workflows/` **没有任何一处执行启动器**。

所以三个启动器的**全部内容**从来没被任何东西检验过 —— 它们只是"存在着"。
Manager 说的「CI 跑的是 `start.sh --port …`」其实还高估了：**连跑都没跑过。**

> 判据：**一个从没被执行过的文件，不因为它被 `need_file` 检查过就变得可信。**

### ② Windows 双击的真实报错原文

`[CI 实测 run 31246584116]` 同一个包、同一条命令，**只改代码页**：

```
代码页 936（中文 Windows 默认）：
  > 'm' is not recognized as an internal or external command,
  > operable program or batch file.
代码页 437：
  （没有这一行）
```

**线索 1 的结论对，机制错。** 不是"换行被吞"——GBK 的 trail byte 是 0x40–0xFE，
`0x0A` 不可能被吞（本机逐字节模拟 + CI 逐行统计双重排除；非 ASCII 字节
**全部落在 3 条 `rem` 行**，可执行行是纯 ASCII）。
真实机制是 GBK **错位配对**，把某行 `rem` 的 `r`/`e` 当成前一个字符的 trail byte 吃掉，
**剩下的 `m` 漏出来当命令执行**。

线索 2（无 `pause`）✅ 成立；线索 3（不自动开浏览器）✅ 成立。
⚠️ 但实测里 **daemon 在两个代码页下都起来了**（界面 200）——
也就是说用户看到的是"一条报错 + 一串看不懂的日志 + 没有任何窗口"，
然后合理地判定它坏了。**②③ 合起来比 ① 更伤人。**

### ③ macOS：Gatekeeper 拦在哪一步、用户看到什么

`[CI 实测]`

```
$ spctl -a -vvv -t open --context context:primary-signature OpenMemo.command
  rejected
  source=no usable signature        ← ★ 就是这道门
$ ./runtime/node -e '…'（带着 quarantine）
  exit=0  node-ran-ok               ← ★ Node 本身跑得起来
$ codesign -dvvv runtime/node
  Authority=Developer ID Application: Node.js Foundation (HX7739G8FX)
```

**拦的是未签名的 `.command` 脚本自己，不是 Node。**
端到端复现（`run 31248222725`，且**已先证端口洁净**）：

```
$ open OpenMemo.command      exit=null error=ETIMEDOUT
  [实测] 双击后界面 GET / => unreachable (never came up)
```

→ 用户那句「**也没有窗口打开**」是精确的：**Terminal 从没被启动**，
所以他既看不到界面，也看不到任何错误。

对照组（同一轮、同一个包，清掉 quarantine 模拟"放行了"）→ **界面 200**。
**包本身是好的，坏的只有"进不去"这一关。**

⚠️ **用户看到的确切弹窗原话取不到**（`UNKNOWN`）：无头 runner 没有 Finder /
LaunchServices 交互会话，弹窗文案属于 GUI 层。拿到的是**系统判定的原话**
（`rejected / source=no usable signature`）与**行为后果**（界面从未起来）。
人工验证清单见 D-18 §6.2。

### ④ ⚠️ 我们发出去的解法是错的（这条请 Manager 特别注意）

v0.2.0 的 `OpenMemo.command` 与 **D-17 §5** 都写着
「用命令行 `tar` 解压**不传播** quarantine → 不拦」。

`[CI 实测]` **相反：`tar` 也传播。** 命令行 `tar xzf` 与访达的「归档实用工具」
**两者都会**把属性传给 `OpenMemo.command` / `runtime/node` / sherpa 目录（同一个值）。

> 一条我们主动给出、用户会照着做、而且**做了没用**的建议，比不给建议更糟 ——
> 他会认为自己已经排除了这个原因。

**DISPUTE（不改他人交付物）**：D-17 §5 表格里那一格与实测冲突，请 Manager 裁决怎么改。

而且 v0.2.0 把解法**写在 `OpenMemo.command` 里面** —— 正是 Gatekeeper 拦住的那个文件：
**把说明书锁在了它要解释的那扇门后面。** 现在解法进包内 `READ-ME-FIRST.txt` + README
（Release 正文那一份请 Manager 发布时带上，文案见 D-18 §7 与 README）。

### ⑤ quarantine 两条路径（ADR-003 §7.6 裁决 (A) 欠的那次测量，现已还上）

阴阳对照齐备（缺了结论无效，本仓栽过三次）：
阴性=命令行下载的归档 `No such xattr`；阳性=手工写入后读得回来 → **探针有效**。

| 路径 | 结论 | 级别 |
| --- | --- | --- |
| ① 浏览器下载 + 解压 | **会被打上，且两种解压器都传播** | `[CI 实测]` 传播那半；**"浏览器打标记"那一刻是 `[模拟]`**（runner 上没有浏览器） |
| ② daemon 自己下载（Node 写盘） | **不会**（`No such xattr`） | `[CI 实测 run 31247860854]` |

**对 ADR-003 决策 4 的含义**：那条"由 daemon 自动清除"的缓解措施针对的是路径②，
而**路径② 根本不会被打上 → 该措施从一开始就不需要**（"缺了一环"的是论证，不是代码）。
**但决策 4 不能就此收工**：真正伤到用户的是**路径①**，而 ADR 原文从没讨论过它。
**我没有改 ADR-003**（Manager 地界），D-18 §4.3 是提交给它的输入。

### ⑥ 顺带修掉 Manager 新增的三条

- **鉴权关着却打 token**：横幅只在 `authRequired()` 时打；`OPENMEMO_AUTH=token`
  恢复路径保留，**两个方向都有用例**（只钉一边会把开关做成单向门 —— `auth.ts`
  注释里记着本仓正为此栽过）。
  ⚠️ `server.ts:317/322` 那两句指路牌**查证后不用改**：它们在
  `if (!authRequired()) { … return; }` **之后**，`none` 模式下**结构上不可达**，
  所以在 token 模式下依然是真话。（这是查证结论，不是假设。）
- **arm64 显示"不支持 AVX2"**：改成 `os.arch === 'x64'` 才渲染。
  **功能面无影响**（查证结论）：`manager.ts:267` 产出的 `isa` 字段**全仓零消费者**，
  只进 schema 不进任何判断 —— avx2 在 Apple Silicon 上没有误伤适配性计算。
  同族检查过：arm 分支只加 `neon/fp16/dotprod/asimd`，没有别的 x86 专属维度被渲染成"不支持"。
- **冷启动第一屏**：改成说清①这是正常的②下一步去哪③任务先排队不丢。
  不降级成 `console.log` —— 它确实是"功能不完整"，只是不该被读成故障。
  判据与 AVX2 那条同族：**「不适用/尚未完成」和「出错了」必须区分得开。**

### ⑦ launch-sim 覆盖到哪、覆盖不到什么

**覆盖到（已接进 `build-bundles.yml` 三条腿，`--mode guard`）**：
下载标记的**传播**、双击的**等价执行路径**（Windows 经 `cmdfile="%1" %*` + 指定代码页；
macOS `open`）、Gatekeeper 的**判定结果与原话**、**启动器真的被执行**且**界面真的可达**
（HTTP 200，不是"进程还活着"）、**用户读到的那段文字本身**（不许含 `#t=`、
必须有一句能照着做的话、不许混进 cmd 报错）、`.cmd` **纯 ASCII**。

**结构上覆盖不到（不假装，人工清单见 D-18 §6.2）**：
GUI 弹窗**长什么样/原话**、**浏览器打标记的那一刻**（runner 上没有浏览器，
我们手工写入同一个属性并标 `[模拟]`）、**控制台窗口关掉后还剩什么**、
中文 Windows 的默认代码页确实是 936（runner 是 65001，所以我显式切到 936 去测）。

**非空洞性已证**：拿 **v0.2.0 那个真实的坏包**跑 guard，**恰好红在三条**上，
每条都对应一个用户真报回来的问题（缺 READ-ME-FIRST / 横幅带 token / 只有裸 URL）。
不是我构造的变异体。

### ⑧ 我自己的探针出过三次错（如实申报，因为它们差点变成结论）

1. 第 1 轮 Windows 的"报错"是**我的命令写错了**（没用 `windowsVerbatimArguments`，
   Node 的 Windows 引号规则把 `cmd /c "…"` 改写了）。差一点就被我当成产品缺陷报上去。
2. 我把 macOS 卡死**归因给 `log show`**，翻日志才发现真凶是下一条
   `"OpenMemo.command" --version | head -20` —— `--version` 不是提前退出旗标，
   它**真的起了个 daemon**。错误归因差点被我写进文档。
3. 那个泄漏的 daemon 占着 17650，导致 ④「open 一个被拒绝的 .command」报出
   **界面可达 200** —— **一个本该失败的测试被残留进程变成了"通过"**。
   已加"④ 之前先探端口，脏了就判本步骤结论作废"。

> 三次都是同一个形状：**探针自己坏了，然后伪装成被测对象的性质。**
> 与 ADR-003 §7.2「没有对照组的阴性结果等于没测」是同一条。

### 门禁

`pnpm -r test` **1532 / fail 0**（基线 1508；+23 是我的新用例）· `npx tsc -b` clean ·
`pnpm lint-workflows` **1027 条 / 12 个 workflow** · `pnpm test:ci-scripts` **22 passed 0 failed** ·
`pnpm check:orphans` **没有新的零引用导出，基线没过期** · `pnpm format:check` 我的文件全绿
（prettier 跑两遍到不动点）。

⚠️ **`npx eslint .` 有别人的红，不是我的**：`scripts/ci/e2e-runtime-audit.mjs`
（未跟踪，另一路 agent 在途）4 条 no-unused-vars / no-useless-assignment。
**我名下的文件 eslint 全绿**（单独跑过）。未触碰该文件。

### 纪律自查

- 未碰 `:10000`（作业前后均 200）、未碰 `/root/data-memo`、**未碰机器指针**
  （内容仍是 `/root/data-memo`，`updatedAt` 仍为 2026-08-03，早于本次作业）。
- 未跑 `pkill`。**未建/改/删任何 release**（只 `workflow_dispatch` 跑 CI）。
- ⚠️ `simulate-user-launch.mjs` **硬拦非一次性环境**（`CI=true` 或显式旗标才跑）：
  它的价值正在于"不带任何环境变量启动"，而那会解析机器级指针 →
  在共享开发机上等于直接动用户的数据目录。判据照 §7 补充：**跑错了也不能造成后果。**
- 逐文件 stage，每次 commit 前核对 `git diff --cached --name-only` **全量**列表；
  期间另一路 agent 的 `e2e-*` / `ws/recorder.*` / `package.json` 一次都没进过我的索引。

需要 Manager / 用户决策:

1. **★ macOS 首次运行怎么放行（三选一，见 D-18 §7）** ——
   (A) 不签名，教用户右键→打开一次（**我倾向**）；(B) 文档推荐 `xattr -dr`；
   (C) 买 Developer ID 并公证（99 美元/年，与 ADR-003 决策 4 冲突）。
   ⚠️ **清 quarantine 属于 Security Weaken，我没有替用户决定，也没有在代码里悄悄清。**
   无论选哪个，**那句话必须进 Release 正文**（README 与包内已就位）。
2. **D-17 §5 那格与实测冲突**（"命令行 tar 不传播"）—— DISPUTE，请裁决怎么改。
3. **ADR-003 决策 4** 需要按 §5 的实测重述：路径② 的缓解措施不需要，
   但路径① 从没被讨论过。**我没有改 ADR。**
4. 一条**未改**的噪音：`(node:NNNN) ExperimentalWarning: SQLite is an experimental feature…`
   是用户看到的第一行。压掉它要用 `--disable-warning=ExperimentalWarning`，
   但那会**连带压掉真正的警告** —— 取舍，不在本轮职权内。

---

## [2026-08-08 09:00] 收尾三件 + PROTOCOL 候选条款

### ① `READ-ME-FIRST.txt` 会不会也被拦 —— **实测：不会**

`[CI 实测 run 31249135458, macos-26]` 同一棵树、同一个 quarantine 值下的对照：

| 文件                | 带 quarantine      | `spctl -t open`                           | 实际能不能用                                  |
| ------------------- | ------------------ | ----------------------------------------- | --------------------------------------------- |
| `OpenMemo.command`  | **是**             | `rejected` / `source=no usable signature` | ✘ `open` 超时/被拒，界面从未起来               |
| `READ-ME-FIRST.txt` | **是**（同一个值） | `rejected` / `source=no usable signature` | ✅ `cat` 读出全部 **2622 字节**；`open` **exit=0** |

**裁决 (A) 的落地前提成立**：用户被挡住的那一刻，读得到那份告诉他怎么办的文件。

> ⚠️ 顺带量出一条方法论，值得单记：**`spctl` 的判决不能用来预测"文档能不能打开"。**
> 它对 `.txt` **也**答 `rejected` —— 它回答的是「当作**代码执行**」的策略，
> 不是「当作**文档打开**」的策略。同一个判决、同一个属性，两个相反的实际结果。
> **我要是拿 `spctl` 当唯一判据，就会得出"说明书也打不开"的错误结论并去做无用的返工。**

`UNKNOWN`：GUI 层（TextEdit 有没有真弹出来）无交互会话，取不到。

### ② D-17 §5 已就地订正

新增 §5.1，原文那半句用 ~~删除线~~ 保留 + 就地挂"见 §5.1 订正"。
写清了何时/被谁/依据什么，附实测表与阴阳对照。顺带订正另两处：
「大概率被拦」→ 实测确定被拦；「Node 官方签名**+公证**」的"公证"**本轮未独立核实**，
已标 `[未验证]`（实测到的是 Developer ID 签名 + 硬化运行时）。

### ③ ADR-003 已就地改（依你授权），论证链**闭合了一半、另一半改了位置**

- 决策 4 那半句：`~~首次运行时由 daemon 自动清除~~` → **无需此缓解**（路径② 实测不会被打上）。
- 新增 **§9**：§9.1 路径② 实测（含阴阳对照）· §9.2 路径①（ADR 从没讨论过的那条）·
  §9.3 你的裁决 (A) 与"那句话必须出现在 Gatekeeper 拦不住的地方" · §9.4 逐条 UNKNOWN。

**闭合状态如实说**：
- ✅ **§7.6 裁决 (A) 问的那个问题闭合了**：缓解措施针对的是一个不存在的问题。
  而且 §7.6 当时"别拿可能是假的前提去消耗用户一次决策"的判断**被证明是对的**。
- ✅ **决策 4 现在有完整论证链**：不买证书 + 路径② 无需缓解 + 路径① 用右键放行处理。
- ⚠️ **但它闭合在一个 ADR 原本没写的地方**：真正咬人的是路径①。
  我在 §9.2 明写了「ADR 为一个不存在的问题准备了缓解措施，而真实存在的那个它没写」。
- ⚠️ **剩余 UNKNOWN 不影响决策，但不许当成已知**：GUI 弹窗原话、
  "浏览器打标记那一刻"（我们是 `[模拟]`）、Node 是否 stapled 公证、
  macOS 15+ 右键→打开是否仍有效。四条都在 §9.4。

### ④ PROTOCOL 候选条款（你定要不要收）

> ## N. 残留进程会把「本该失败」变成「假通过」—— 而且是静默的
>
> 本轮**三个 agent 各撞了一次**同一个形状：
>
> - `bundle-launch`：一条诊断步骤把 daemon 起了起来并泄漏，占着 17650。
>   于是「open 一个被 Gatekeeper 拒绝的 `.command`」这一步**报出界面可达 HTTP 200** ——
>   而那个 200 是**泄漏进程**应答的，`open` 自己是 ETIMEDOUT。
>   差一点就据此报告"macOS 双击是好的"，而用户手里的包明明打不开。
> - 另一路 agent 的健康检查连上了同端口的游离 daemon，得到同样性质的假绿。
>
> **为什么它比测试失败危险得多**：失败会被查，**假通过不会**。
> 它还会**反向**污染结论 —— 你会去修一个不存在的问题，或者宣布一个坏掉的东西是好的。
>
> 与 §9-bis / §10 是同一族的第三面：
>
> - §9-bis 问：**在最坏的那一行 `kill -9`，机器上还剩下什么？**
> - §10 问：**在最坏的那一秒，别人看到的是什么？**
> - 这一条问：**我这次测到的"通过"，会不会根本不是我启动的那个东西给的？**
>
> 所以：
>
> - **任何"起服务再探测"的测试，探测前必须先证明那个端口是空的**，
>   并在不空时**当场判失败**（而不是继续跑下去拿一个无意义的绿）。
> - **收尾按 pid 收整棵进程树**（Windows 上 `child.kill()` 杀不掉 cmd.exe 底下的 node.exe；
>   POSIX 上 `exec` 之后才是同一个 pid）。**仍然按 pid，不许 `pkill -f`** ——
>   模式匹配会打到别人的进程，那是另一种越界。
> - **一切外部命令带超时。** 没有超时的步骤既会拖死整条腿，
>   又会在被杀时把孙子进程留下来 —— 上面两个后果它一个人全占。
> - **判据**：一个绿灯，必须能追溯到**是我这次启动的那个东西**给的。
>   追溯不到，它就不是证据。

### 门禁（本轮收尾后复跑）

见下一条 commit 的正文；`check:orphans` 基线 70 未动，测试基线 1541 未降。

需要 Manager 决策:

1. 上面 ④ 那段 PROTOCOL 候选条款要不要收进 `coordination/PROTOCOL.md`（**我没有动那个文件**）。
2. Release 正文那份 macOS 首次运行说明（文案见 `READ-ME-FIRST.txt` / README / D-18 §7），
   **由你发布时写** —— 我没有建/改/删任何 release。
