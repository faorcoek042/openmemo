# test-gaps —— 护栏本身的债（T-142）

# TL;DR

**门禁现在是 `843 passed / 0 failed / 1 todo`**（`tsc -b` 0 · `eslint .` 0）。
拆开说清楚，因为这个数字很容易被误读：

| 来源 | 条数 | 说明 |
|---|---|---|
| 我开工时实测的基线 | **674** | 交接给我的数字是 621，**开工时已经过期**（别人在这之前落了 ~53 条） |
| **`llm`(18) + `mindmap`(42) 进门禁** | **+60** | ⚠️ **不是新增测试**，是"本来就在、从没被够到"。我一行测试代码都没写 |
| **我新写的测试** | **+50** | `guard.test.ts` 23 · `noteDetail.test.ts` 14 · `client.test.ts` 13 |
| 同一窗口里别人落的 | +59 | runtime +6 · pipeline +6 · web 单测 +18 · web 组件 +17 · daemon +12 |
| **合计** | **843** | |

## 四件事的结果

1. **那 60 条（`llm` 18 + `mindmap` 42）：全绿，没有产品缺陷。** 如实报：这一路**没有**产出"产品真的坏了"。
   补了 `test` 脚本（与另外四个包**逐字相同**的那一行），并新加一条守卫
   `scripts/check-test-scripts.mjs` —— 它盯的是"有测试文件却没 test 脚本"这件事本身，
   因为那已经是**同一个坑的第五次**了，而此前没有任何东西在盯。
2. **E1/E2/E3 三个洞堵上了，判据是变异不是"我加了测试"。**
   **13 条变异（含 T-137 那三条点名实验的原样复现）全部变红**，真实输出贴在 §C。
   T-137 当时的结果是这些变异**全部存活**。
3. **变异做成可重复的了，但明确不是门禁** —— `scripts/mutation-check.mjs`，13 条清单，
   跑在 `/tmp` 隔离副本上（**绝不动仓库产物**）。这一条我本来准备说"不值得"，
   改主意的理由和放弃它的诱惑都写在 §D，请直接看那一节再裁决。
4. **反向验证过程中查出一个真的产品 bug + 一条活着的 §9 隐患**，见下。

## 🔴 要 Manager 处理的三条

1. **产品 bug（我没改，安全边界该单独派人）**：`apps/daemon/src/http/guard.ts:98-100`
   假设 `URL.hostname` 会剥掉 IPv6 方括号 —— `[实测]` Node 24 **不剥**，
   于是同源判断把 `[::1]` 拼成 `[[::1]]`，**永不相等**。
   后果：`checkHost` 放行 `[::1]`、`checkOrigin` 对同一地址**恒拒** ⇒
   谁用 `http://[::1]:port` 打开界面，**页面发出的每一个请求都 403**，整页全死。
   佐证同一处没写完：`:100` 的三元 **两个分支逐字相同**。
   我把断言写好了并标 `todo`（原样留着，修好即是回归），**不让它变成假红灯**。
2. **跑一次 `pnpm -r test` 会改写用户的全局数据目录指针**（PROTOCOL §9 那条线上的活口子）。
   `apps/daemon/src/storage/restart-datadir.test.ts:44` 把
   `~/.local/share/openmemo/datadir.json` 指到 `/tmp/om-rd-decoy-*`，`after()` 再还原。
   还原是真的（我 `cat` 逐字核过），但**测试跑的那几百毫秒里指针是坏的**，
   且**进程被 kill / 崩溃就永久留坏**。上一次这个形状让用户的 key、模型、转写"全部消失"。
   **不是我的任务范围，没动它**，请派人改成纯函数或换成可注入路径。
3. **与 `notes-contract` 的测试重复了**，两个文件都在测同一个端点：
   我的 `apps/daemon/src/http/rest/noteDetail.test.ts` 与他的
   `apps/daemon/src/http/noteDetailContract.test.ts`。**建议合并**，§E 列了逐条差异，
   合的时候按那张表核，别把只有一边有的断言丢掉。

## 我自己造过一盏假绿灯，如实记在这里

`assets[].state` 那条用例第一版是 `for (const a of assets) {...}` ——
而刚上传的笔记 `assets` 恒为 `[]`（真资产由转写 runner 落，这台机器没有 whisper），
**循环体一个断言都不执行，报绿**。形状和本轮要修的那 22 个存活变异**一模一样**。
抓到它的不是这条用例，是旁边那条 `assets.length > 0` 的红。
现在每个循环前面都有一条**显式数量断言**，理由写进了代码注释。

---

## [2026-08-04 01:05] T-142 DONE

交付（精确清单，**未 `git add`、未 commit**）：

**新增**
- `scripts/check-test-scripts.mjs` —— "有测试文件就必须有 test 脚本"跨包守卫
- `scripts/mutation-check.mjs` —— 变异检查（13 条清单，隔离副本）
- `apps/daemon/src/http/guard.test.ts` —— 23 条（22 pass + 1 todo）
- `apps/daemon/src/http/rest/noteDetail.test.ts` —— 14 条
- `apps/web/src/lib/api/client.test.ts` —— 13 条
- `coordination/inbox/test-gaps.md`（本文件）

**修改**
- `packages/llm/package.json`、`packages/mindmap/package.json` —— 补 `test` 脚本（+ `_comment:test`）
- `packages/db/package.json`、`packages/pipeline/package.json`、`packages/runtime/package.json`、
  `apps/daemon/package.json` —— 同一行前置 `check-test-scripts.mjs`，并把 `_comment:test` 里
  **已经过期的"三个包共用这一行"改成"六个包"**（`runtime` 早就是第四个了，那句话在我改之前就是错的）
- `apps/web/tsconfig.test.json` —— **只 append 三行**（`client.test.ts` / `client.ts` / `connect.ts`），
  没碰 `remediation` 和别人在同一文件里的行

**没碰**：任何产品实现文件（`rest/notes.ts` / `guard.ts` / `client.ts` / `mock.ts` 一个字没写）、
`apps/web/dist`（mtime 全程停在 `2026-08-03 23:53:32`）、`/root/data-memo`、
`~/.local/share/openmemo/datadir.json`（收尾时与开工备份**逐字比对通过**）、
`:10000`（只发过 GET，`health 200`，未重启未 kill 未占端口）。
未用 `pkill`、未跑 `pnpm -r build`、未跑本地 whisper 转写。

---

# §A 排序：22 个存活里为什么先修这三个

判据只有一条：**这个地方坏了，用户会怎样。** 不按"哪个好修"排。

| 顺位 | 条目 | 用户会怎样 | 为什么排这里 |
|---|---|---|---|
| **1** | **E1 `GET /api/notes/:uid` 整个端点从没被执行** | 打开任意一条笔记，看到的东西是错的或缺的 —— 而且**零报错** | 三个理由叠加：① 用户**现在**就在撞（T-139 的 A1/A1b 两个 P0 都长在这个端点上）；② 它是**假绿灯制造机**（判据 3）—— 这条债掩护着另外两条 P0，成本要按它掩护的东西算；③ `notes-contract` **此刻正在改这个端点的契约**，没有护栏就没有任何办法证明他改对了、更没办法防止它再退回去 |
| **2** | **E3 写请求静默回落 mock** | 点保存 → 界面显示成功 → **什么都没发生**。项目自己的定性是"比报错糟糕得多" | 静默排在会报错的前面（判据 2）。而且 `client.ts` 是**前端唯一的 HTTP 收口**：这里一条守卫塌了，影响的是**全部**写操作，不是某个页面。附带价值：它是"断言一个恒假前提"最干净的活样本，修它的过程本身就把方法立起来了 |
| **3** | **E2 Host/Origin 闸门可整段删除** | 任意网页把域名重绑到本机 → 读走用户全部笔记与 API key | 后果**最重**，但判据 1 把它压到第三：**产品代码今天是对的**，真攻击形状被正确拒绝，用户要撞上还需要先被诱导访问恶意站点。它是"未来某人删掉它没人知道"。**排第三不是因为它不要紧，是因为前两条今天就在伤人。**<br>（顺带：查它的过程里挖出了上面那个 IPv6 产品 bug） |

**没做的四条，理由写清楚**（都在 22 个存活里，我判断本轮不该抢）：

- **E7（另外 9 个端点从不执行）**：成本 L。段落编辑与搜索是真的重要，但那是**一整轮的量**，
  塞进本轮只会每条都做成浅的。**建议单独立一张卡**，按"用户能撞上"再排一次。
- **E4（SSE 重放 + 任务重试/退避/租约）**：成本 M，失效表现是"重连后界面静默不再更新"和
  "两个 worker 抢同一条任务"。**该做，但它需要设计**（怎么在测试里造断线与并发 worker），
  不是补几条断言的事。
- **E5（扩展名白名单改成全放行仍 132/132 绿）**：判据上它属于 A11 那条不一致的一部分，
  **三份清单先统一、再一次性补护栏**更省 —— 现在补会补出"守住了其中一份"。
- **E6（迁移"已应用则跳过"分支从没走到）**：真实场景是"daemon 第二次启动"，
  成本 S，我判断它可以顺手做，但**排在上面三条之后就没时间了**。诚实说：是时间不够，不是不值得。

---

# §B 那 60 条跑出来什么样（第一优先）

`[实测]` 手工跑（`pnpm build:safe` 之后）：

```
packages/llm      ℹ tests 18 · pass 18 · fail 0
packages/mindmap  ℹ tests 42 · pass 42 · fail 0
```

**60 条全绿，没有一条红，没有产品缺陷可报。** 与 T-137 的预判一致。

接进门禁之后（`pnpm -r test`）：

```
packages/llm test: ✔ check-test-scripts: 7 个含测试的包都有 test 脚本 —— …
packages/llm test: ℹ tests 18 / pass 18 / fail 0
packages/mindmap test: ℹ tests 42 / pass 42 / fail 0
```

## 用的是统一的那一行，且**没留第七种写法**

六个包（`db` / `pipeline` / `runtime` / `llm` / `mindmap` / `daemon`）的 `scripts.test`
现在**逐字相同**（我用脚本核过 `new Set(...).size === 1`）：

```
node ../../scripts/check-test-scripts.mjs && node -e "<发现守卫>" && node --test
```

## 为什么还要加 `check-test-scripts.mjs`

原来那条 `node -e` 发现守卫断的是"源码里有几个测试文件，dist 里就有几个" ——
**它只能守已经有脚本的包**：它跑在包内部，包被 `pnpm -r test` 跳过时，它自己也被跳过。

而 `runtime`(38) 与 `llm`+`mindmap`(60) 全都是**压根没有脚本**那一类。
**`pnpm -r test` 对"某个包没有 test 脚本"这件事永远不会说一句话。** 这已经是第五次了。

守卫**必须挂在包的 `test` 脚本里**，不能挂根目录 —— 因为 `pnpm -r` **默认不含 workspace root**，
挂根上的守卫在真正被跑的那条命令里根本不会执行。
挂六份是刻意的冗余：删掉任何一个包的 `test` 脚本，守卫都还在。

### 反向验证（真实输出）

```
$ # M1：删掉 packages/llm 的 test 脚本
$ node scripts/check-test-scripts.mjs
✘ check-test-scripts:
  有测试文件却没有 test 脚本的包（pnpm -r test 会静默跳过它们，然后报绿）：
    - packages/llm —— 2 个 *.test.ts(x)，但 package.json 没有 test 脚本
  修法：照 packages/db 的 scripts.test 抄那一行（含前置发现守卫），别再发明第七种写法。
exit=1

$ # 还原后
✔ check-test-scripts: 7 个含测试的包都有 test 脚本 —— apps/daemon(19) apps/web(13)
  packages/db(3) packages/llm(2) packages/mindmap(2) packages/pipeline(10) packages/runtime(2)
exit=0
```

**M2（守卫自身的接线被拆光）第一次跑是假绿的，记在这里：**

```
$ # 把 6 处接线拆到只剩 1 处
$ node scripts/check-test-scripts.mjs
✔ check-test-scripts: 7 个含测试的包都有 test 脚本 —— …        ← 应该红，却绿了
exit=0
```

根因：我数接线点时把 `_comment:test` 也算进去了 —— **那些注释里也写着本文件名**。
于是"接线全被拆掉"这件事被它自己的说明文字掩盖住。修掉之后：

```
$ node scripts/check-test-scripts.mjs
✘ check-test-scripts:
  本守卫只剩 1 个接线点了 —— 它是靠"挂在多个包的 test 脚本上"活着的（见文件头）。
  少于 2 个接线点意味着再删一处它就彻底消失且无声。
exit=1
```

---

# §C E1 / E2 / E3：变异是判据，不是"我加了测试"

每一条都是**先写测试跑绿，再亲手把被测行为改坏，确认真的红**。
变异一律做在**编译产物**上（产品源码一个字没动），改完先 `grep` 确认坏行**在即将运行的那份产物里**
（T-137 踩过 `mv` 让 mtime 倒退、`tsc -b` 跳过重建的坑）。

## E1 · `GET /api/notes/:uid` —— `apps/daemon/src/http/rest/noteDetail.test.ts`（14 条）

T-137 的原实验：换成 `sendJson(res,200,{})` → 196/196 全绿；换成 `throw` → **仍然全绿**；
逐字段删 `tags`/`starred`/`assets` → 全绿。原样复现：

```
### 对照：未变异        ℹ tests 14 · pass 14 · fail 0

===== N1 · handler 顶部 throw（T-137 原实验：196/196 全绿） =====
  坏行在即将运行的产物里: 348:  throw new Error('T-142 mutant: 端点根本没被执行过吗？');
  exit=1 ; tests 14 · pass 2 · fail 12

===== N2 · 整个响应换成空对象 {}（T-137 原实验：全绿） =====
  exit=1 ; tests 14 · pass 2 · fail 12

===== N3 · 删掉 tags 字段（T-137 原实验：全绿） =====
  exit=1 ; tests 14 · pass 13 · fail 1

===== N4 · 删掉 starred 字段（T-137 原实验：全绿） =====
  exit=1 ; tests 14 · pass 11 · fail 3

===== N5 · 删掉 assets 字段（T-137 原实验：全绿） =====
  exit=1 ; tests 14 · pass 12 · fail 2

===== N6 · 删掉 assets[].state（把 T-139 A1 那个 P0 原样种回去） =====
  已确认 'state: a.state' 不在即将运行的产物里
  exit=1 ; tests 14 · pass 13 · fail 1
    ✖ ★ `assets[].state` 必须发出来（T-139 A1：缺了它 `<audio>` 永远不进 DOM）

===== N7 · 删掉 bodyJson（把 T-139 A1b 那个 P0 原样种回去） =====
  已确认 'bodyJson: parseJsonOrNull' 不在即将运行的产物里
  exit=1 ; tests 14 · pass 12 · fail 2

### 还原后            ℹ tests 14 · pass 14 · fail 0
```

**三条红是我先猜错、追下去改的期望值，不是"看到红就把断言改宽"**，逐条交代：

| 我第一版猜的 | 实测 | 结论 |
|---|---|---|
| `GET /api/notes/upload` → 404 | **405** | **产品对，我错**：`upload.ts:465` 认领了这个路径、只是拒绝 GET。**这比 404 更能证明结论**（请求确实穿过了详情分支）。断言改成 405 + `code === 'METHOD_NOT_ALLOWED'` |
| `folderUid` → `null` | **一个 ULID** | **产品对，我错**：上传会把笔记放进默认文件夹。但我**没有**把断言放宽成"允许非 null" —— 改成了更强的判据：**它必须在 `/api/folders` 的树里查得到**（指到查不到的 uid = 笔记落在一个界面上不存在的文件夹里，而这条链上没有任何一层会报错） |
| `assets` 非空 | **空数组** | **我错，且我造了一盏假绿灯**：见 TL;DR。现在 `before()` 直接经仓储层落一条 `audio16k`（`createAsset` 的 INSERT 把 `state` 写死 `'ready'`，与真实转写路径是同一行 SQL），并加了显式数量断言 |

## E2 · Host/Origin 闸门 —— `apps/daemon/src/http/guard.test.ts`（23 条）

T-137 查实：**全仓没有任何测试文件 import 过 `guard.ts`**；两条以「DNS rebinding 防护」
命名的用例通过的理由和名字无关 —— 夹具用 `Host: evil.example.com`（**不带端口**），
403 来自**端口子句**，域名子句从来不是开火的那个。**而真实攻击一定带端口。**

本文件的判据：**每一条子句都要有一个"只有它能开火"的输入**，并配一个
**只把这一个字段改回合法**的对照 —— 两条合起来才能证明"拒绝来自这一条子句"。

```
### 对照：未变异        ℹ tests 23 · pass 22 · fail 0 (todo 1)

===== D01 · checkHost 的域名规则整段删掉（T-137 原实验：196/196 全绿） =====
  坏行在即将运行的产物里: 42:    if (false) {
  exit=1 ; tests 23 · pass 19 · fail 3
    ✖ ★ 域名 + **正确端口** 必须被拒 —— 这才是真实 rebinding 的形状
    ✖ ★ `localhost` 也是域名，同样必须拒
    ✖ ★ 长得像 IP 的域名必须拒（`1.2.3.4.evil.com` / 段位越界的 `999.1.1.1`）

===== D02 · checkOrigin 的同源比较整段删掉（T-137 原实验：全绿） =====
  exit=1 ; tests 23 · pass 19 · fail 3
    ✖ ★ 跨源 Origin + **正确端口** 必须拒
    ✖ ★ Origin 是**另一个裸 IP** 也必须拒（不许照搬 Host 那条"允许 IP 字面量"）
    ✖ ★ 只把 Origin 换成跨源（其余不动）→ 拒

===== D03 · checkSecFetch 恒过（T-137 原实验：全绿） =====
  exit=1 ; tests 23 · pass 20 · fail 2

### 还原后            ℹ tests 23 · pass 22 · fail 0
```

⚠️ **同时钉住了"放宽的那一半"**：用户此前明确要求接受任意 IP 字面量（NAT/反代），
所以 `100.64.135.105:17650` / `[::1]:17650` 必须**通过**。
没有人钉它的话，下一个人"为了安全"把它收回只认回环，demo 从 NAT 外整个访问不了，
而且不会有任何测试变色。**"放宽"不等于"删掉了也没人知道"，也不等于"随时可以收回去"。**

## E3 · 写请求永不回落 mock —— `apps/web/src/lib/api/client.test.ts`（13 条）

**根因不是断言写松，是前提恒假**：`mock.ts` 从未被组件测试 bundle import ⇒
`registerMockFetcher` 从不被调用 ⇒ `mockFetcher` 恒为 `null` ⇒
所有被它守卫的分支在测试里**天然不可达**。那条用例"绿"是因为**根本没有 mock 可回落**。

所以这个文件**先把前提做成真的**：每组都注册一个"被调用就留痕"的假 mock，并**成对写** ——
读路径必须真的回落到它（**对照组，证明回落机制是活的**），写路径必须一次都不碰它。
少了前半，后半又会变成"断言一件不可能发生的事"。
断言全部读**被记录下来的 fetch 参数**（组件套件的 `stubApi` 连请求头都不记录）。

```
### 对照：未变异        ℹ tests 13 · pass 13 · fail 0

M3 删 missingEndpoints 快路径的 !isWrite  → exit=1 · pass 11 · fail 1
M4 删 isNotImplemented 分支的 !isWrite    → exit=1 · pass  9 · fail 3
M5 删 TypeError 分支的 !isWrite           → exit=1 · pass 11 · fail 1
M6 删 realFetch 里的 CSRF 头              → exit=1 · pass 11 · fail 1
M7 credentials 改成 'omit'                → exit=1 · pass 11 · fail 1
M8 删握手前置 await gate()                → exit=1 · pass 12 · fail 1
M9 删写请求补握手 isWrite && !hasCsrf()   → exit=1 · pass 12 · fail 1
```

**M8 第一次跑是绿的，这是本轮方法学上最值钱的一条，记全：**

```
===== M8 · 删掉握手前置 await gate() =====
  坏行在产物里: 346:    /* deleted gate */;
  exit=0 ; tests 12 · pass 12 · fail 0        ← 应该红，却绿了
```

我第一版把这条断言写成 **POST**。而写路径上还有第二个机制
（`if (isWrite && !hasCsrf()) await reHandshake()`），它出于**另一个理由**
（第二个标签页没有令牌）也会把握手排到业务请求前面 ——
**于是把 `await gate()` 整句删掉，那条断言依然通过**。

不是断言写松了，是**被另一条路径顶住了**：`gate()` 真正独占守护的只有**读**请求。
改成 GET 之后 M8 当场红。并且把两个机制**拆成两条用例分别钉**（M8 / M9），
因为合成一条会让删掉其中任意一个都不变色 —— 那正是我第一版踩到的坑。

**判据得选在"只有被测行为能让它成立"的地方。** 这是 HANDOFF #18 那条规矩的具体形态：
写完把名字遮住，问"这些断言什么时候会失败"——我第一次问出来的答案是"几乎不会"。

## E8 顺带闭合

`client.ts` 此前**不在 `tsconfig.test.json` 的 include 白名单里**，唯一覆盖是经由组件 bundle 的间接执行。
已登记（**只 append 三行**，没碰别人在同一文件里的行）。

---

# §D 变异做成可重复的：我的判断是**做，但不是做成门禁**

任务给了我说"不值得"的许可，我认真考虑过用掉它。先说**反对的理由**，因为它们是真的：

1. **本仓库没有 CI、没有 git hook、没有 remote，`pnpm check` 有入口没人跑。**
   再加一条没人跑的门禁，是把 C4 那条债又抄一遍。
2. **行号锚的清单会在几天内烂掉**，然后开始报**假红** —— 而假红会训练人忽略告警，和假绿一样贵。
   T-137 自己的自评就是「每 3 个 `file:line` 引用约有 1 个已经指不到所述代码」。
3. **最要命的一条：我做这一轮时是直接 `sed` 改 `apps/daemon/dist/` 的。**
   那期间任何人跑 `pnpm -r test` 都会看到几条无法解释的红，然后去查一个根本不存在的 bug。
   本仓库随时有多个 agent 在跑测试，这不是假设 —— 我自己就在同一小时里看到过别人的
   `__t140_mutant.ts` 让 web 单测红了一条。**一个会污染别人判断依据的工具，比没有更糟。**

**改主意的原因是这三条都能被设计掉，且都不贵：**

- 第 3 条 → **跑在 `/tmp` 的隔离副本上**（`cp -a dist` + `node_modules` 软链回真仓库，
  跨包依赖照常解析）。`[实测]` 可行，daemon 那种要真起服务的测试也跑得起来。
  **它在结构上不可能碰到仓库产物。**
- 第 2 条 → **锚点是唯一的源文本，不是行号**。找不到或找到多处 → **当场报错并说清楚
  "代码动过了，请重新指锚点，别把这条删掉"**，绝不猜一个位置改下去。
- 第 1 条 → **不装作它是门禁**。文件头明写：门禁跑 `pnpm -r test`，
  这个在**改动被守护的那些文件时**手动跑。它测的是**护栏本身**，不是产品。

还加了一条防我自己的：**每组先跑未变异的对照组并要求全绿**。
不做这一步的话，一个本来就红的产物会让**每条变异都"被检测到"**，
存活率漂亮得不像话，而它什么都没证明 —— 这是变异测试自己最容易出的假绿。

## `[实测]` 全量输出

```
$ node scripts/mutation-check.mjs
  ✔ 红  E1-endpoint-dead
  ✔ 红  E1-state-dropped
  ✔ 红  E1-bodyJson-dropped
  ✔ 红  E1-tags-dropped
  ✔ 红  E2-host-domain-rule
  ✔ 红  E2-origin-sameorigin
  ✔ 红  E2-secfetch
  ✔ 红  E3-write-no-mock-notimpl
  ✔ 红  E3-write-no-mock-offline
  ✔ 红  E3-write-no-mock-shortcut
  ✔ 红  E3-csrf-header
  ✔ 红  E3-credentials
  ✔ 红  E3-handshake-gate

共 13 条：13 条被测出，0 条存活。
✔ mutation-check: 每一条被守护的行为，改坏了都会红。
exit=0
```

## 这个脚本自己的三种失败模式我都验过（不然它就是下一盏假绿灯）

```
$ # ① 锚点失效（第一次跑就真实遇到了，不是我造的）
E3-write-no-mock-notimpl: 锚点在 apps/web/.test-out/unit/lib/api/client.js 里出现 0 次（要求恰好 1 次）——
    代码动过了，请**重新指锚点**，别把这条删掉。
exit=1

$ # ② 对照组本来就不绿 → 整组作废，不当结论
SELFTEST-control-red: **对照组就不是绿的**（未变异时 exit=1）—— 本组全部作废。
exit=1

$ # ③ 存活（用一条等价变异——只改注释文字——自检）
  ✘ 存活  SELFTEST-equivalent
共 1 条：0 条被测出，1 条存活。
exit=1
```

**清单只收我这一轮亲手验过会红的 13 条。** 没有把 T-137 那 22 个存活里我没修的那些
先写进去占位 —— 那会让脚本一跑就一片红，三天之内没人再跑它。

---

# §E 与 `notes-contract` 的重复：合并时按这张表核

两个文件都在测 `GET /api/notes/:uid`。**我全程没碰他的实现，也没碰他的文件。**

| 断言 | 他的 `noteDetailContract.test.ts` | 我的 `rest/noteDetail.test.ts` |
|---|---|---|
| `state` 存在且是 `media_assets` 那一列的真值 | ✅ | ✅（我只断言"存在且是字符串"——刚上传的资产本来就可能还在处理中，把状态值写死才是把 bug 写成期望） |
| `state:'ready'` 时 url 真的取得回字节 | ✅ **只有他有** | ❌ |
| `bodyJson` 往返 / 是对象不是字符串 / 没写过时为 null | ✅ | ✅（前两条重复） |
| GET 的输出原样喂回 PATCH 必须幂等 | ✅ **只有他有** | ❌ |
| 顶层键必须齐 | ✅ **只有他有** | ❌ |
| 404 NOTE_NOT_FOUND | ✅ | ✅（重复） |
| **非 ULID 段位落到后续路由（405，不被详情分支吃掉）** | ❌ | ✅ **只有我有** |
| **`tags` 是数组且无标签时为 `[]`** | ❌ | ✅ **只有我有** |
| **`starred` 写进去能从详情端点读回来（往返）** | ❌ | ✅ **只有我有** |
| **`assets[].url` 与该 asset 的 `uid` 一致** | ❌ | ✅ **只有我有** |
| **`folderUid` 必须在 `/api/folders` 的树里查得到** | ❌ | ✅ **只有我有** |
| **详情与列表对同一条笔记的 `title`/`starred` 逐字一致** | ❌ | ✅ **只有我有** |
| `canRetranscribe`/`segmentCount`/`createdAt` 类型 | ❌ | ✅ **只有我有** |

**建议**：合成一个文件，重复的三条去掉一边即可。
`mutation-check.mjs` 里 4 条 E1 变异指向的是**我这个文件**，合并后记得改 `tests:` 那一行
（改错了不会假绿 —— 对照组会报"测试文件不存在"）。

---

# §F 顺带查实、但**我没有改**的三条

1. **`ALLOWED_HOSTS` 里的 `'::1'`（不带方括号）永远匹配不到。**
   拆 host 的正则 `^(\[[^\]]+\]|[^:]+)(?::(\d+))?$` 对任何裸 IPv6 直接 no-match，
   先一步返回 `unparsable Host`。有效的是 `'[::1]'`。
   **这不是 bug**（行为正确，RFC 7230 本来就要求方括号），是一条到不了的分支。记录，不动。
2. **`HANDOFF.md` 有三处需要更新**（我不改别人的交接文档）：
   - `:161`「`pnpm -r test` 会跑有 test 的 **4** 个包」→ 现在是 **7** 个
   - `:177`「`downloader` / `llm` / `mindmap` / `runtime` / `shared` **没有 `test` 脚本**」
     → `runtime`/`llm`/`mindmap` 三个都有了；且那句「它们的验证脚本是包内的 `verify-*.mjs`」
     对 `llm`/`mindmap` **从来就是错的** —— 它们有真的 `*.test.ts`，只是没人跑
   - `:180` 最近一次全绿记录 `555` → **843**（拆分见 TL;DR，别直接拿去当基线）
   - `:169`「db / pipeline / daemon **三个包**的 test 脚本必须保持同一行」→ **六个包**
3. **`packages/downloader` 的 13 个验证脚本仍然零 npm 入口**（T-137 的 C2）。
   本轮的守卫**盯不到它** —— 它没有 `*.test.ts`，判据不适用。
   要盯得改判据（"包内有 `verify-*.mjs` 就必须有入口"），但那条判据我拿不准会不会误伤
   （那些脚本刻意做成可独立运行的 e2e）。**没做，明说。**

下一步建议:
1. 先裁决 §E 的合并（我建议 `notes-contract` 先合，我后合；红着等会训练人忽略红灯）
2. 派人修 §TL;DR 的 IPv6 产品 bug + `restart-datadir.test.ts` 写全局指针那条
3. E7（9 个端点）单独立卡；E4/E5/E6 按 §A 末尾的理由排

需要 Manager 决策:
- §E 的合并顺序与归并到哪个文件
- `guard.ts` 的 IPv6 修复派给谁（安全边界，我判断该单独复核，不该顺手改）
- `mutation-check.mjs` 要不要写进 HANDOFF 的"怎么验"一节（我建议写，但**明确标注它不是门禁**）
