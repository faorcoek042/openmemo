---
id: D-12
author: versioning
status: ready
date: 2026-08-08
---

## TL;DR（≤ 25 行，Manager 只读这里）

- **成因**：界面上的 `v0.1.0` 来自 `apps/daemon/src/main.ts` 里手写的
  `export const VERSION = '0.1.0'`；各 `package.json` 写的是 `0.0.0`。
  **两个数互不知道对方存在**，全仓没有任何代码读过 `package.json` 的 `version`。
  所以它不是"忘了更新"，是**没有任何东西会让它更新**。
- **规则**：`0.N.P`。**N = 第几个可用的东西**（递增 1 = 又交付了一个能跑的东西），
  P = 针对**已经交付出去**的那个 N 的修补。`0.` 永远是 0。
- **不用语义化**：判断"是不是破坏性"要有一个被破坏的人，本项目没有下游、不发 npm。
  留着 major/minor/patch 只是每次强迫人做一次无人受益的判断 —— 结局就是今天这个 `0.1.0`。
- **不用日期版本**：`commitTime` 已经在界面上答了"什么时候"，日期版本是重复；
  且会和 Releases 上的 `backend-packs-2026.08.07b` 撞脸，毁掉 README 第 12 行依赖的区分。
- **谁递增**：人，一条命令 `pnpm version:bump "摘要"`。不是 commit 钩子（单位错了 +
  不进克隆），不是 CI 自动（单位还是 commit + 会和人抢树）。
- **触发条件**：**有东西交到用户手上**。bump 这个动作**就是**发布本身 ——
  所以"忘了 bump"在结构上不存在：没发布就不需要 bump。
- **单一事实来源**：根 `package.json` 的 `version`。其余 9 个 `package.json` 的 `version`
  字段**已删除**（不是同步成一样 —— 是没有那个字段，于是没有东西可以分叉）。
  `[实测]` pnpm 10.15.0 对 private 包缺 `version` 无异议。
- **传播链**：根 `package.json` →（构建）`gen-build-info.mjs` → `apps/daemon/dist/build-info.json`
  → `BUILD_INFO.version` → `VERSION` → `/api/health` → 界面。跟着产物走，理由同 commit。
- **守卫**：`pnpm check:version`，已接进 `pnpm test:ci-scripts`（CI 门禁）与 `pnpm check`。
  它守**一致性**（今天就是绿的），**不守**"你是不是该 bump 了"（那会永远红）。
- **tag**：`v0.2.0`。和 `backend-packs-*` / `model-mirror-*` 刻意分开。tag ≠ Release。
- 对预编译包那位的影响：**根 `package.json` 的 `version` 就是权威值**，格式保证
  `^0\.\d+\.\d+$` 且文件名安全。读取请 `import { readProductVersion } from 'scripts/lib/version.mjs'`。
- 未验证/存疑：本轮**没有**创建任何 tag 或 release（纪律禁止）；tag 形状只是约定，无守卫。

## 详细内容

### 1. 今天的两个数各自从哪来

| 数字                       | 出处                                                          | 谁读它                                                                                                            |
| -------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `0.1.0`（界面显示的）      | `apps/daemon/src/main.ts:78` `export const VERSION = '0.1.0'` | `main.ts:366`/`:903` → `/api/health` 的 `version` → `connect.ts` → `MockNotice.tsx:97` `daemon v{health.version}` |
| `0.0.0`（package.json 的） | `npm init` 的脚手架默认值，10 个包全是它                      | **没有任何东西读它**                                                                                              |

关键事实：`[实测]` 全仓对 `package.json` 的读取只有 4 处
（`check-test-scripts.mjs:123` 读 `scripts.test`、`lint-workflows.mjs:380` 读
`scripts['test:ci-scripts']`、`mutation-check.mjs:333` 只做 `cpSync`、
`apps/web/src/lib/format/peaks.test.ts:118` 读 `name`/`dependencies`），
**没有一处读 `version`**。

所以"对不上"不是同步失败，是**两条从未相交的线**。这比 drift 更糟：drift 至少说明
曾经有人试图让它们一致，而这里从来没有那个意图存在过，因此也没有任何时刻会有人发现。

### 2. 规则：`0.N.P`，以及为什么不是别的

判据（用户给的）：**"用户一眼能看出这是第几个可用的东西、以及比上次新还是旧"**。
拆开就是两个要求：一个**序数**，和一个**可比较的序**。

- **语义化版本**（major/minor/patch）：三档里没有一档是序数。而且分档需要判断
  "这算破坏性改动吗" —— 这个判断需要一个**被破坏的对象**。本项目个人自用、
  没有下游消费者、不发 npm，那个对象不存在。留着它只会让每次发布都要做一次没有依据的判断，
  而没有依据的判断的稳定结局，就是**根本不做** —— 也就是今天这个从没动过的 `0.1.0`。
- **日期版本**（`2026.08.08`）：序完美，序数没有 —— 它答不了"第几个"。
  另外两条本仓特有的反对理由：
  1. **重复**。界面上已经有 `commitTime`（提交时间），而且比日期版本更精确。
     版本号再带一个日期，占着位置却不提供任何新信息。
  2. **撞脸**。Releases 页上现有 5 个 tag 形如 `backend-packs-2026.08.07b` /
     `model-mirror-2026.08.06`。README 第 12 行明确告诉用户**那些不是给他下的**。
     产品版本也用日期，就会和它们长得一模一样，那句话就失效了。
- **`0.N.P`**：`N` 直接就是序数，整数比大小就是序。两个要求一次满足。

三段式不是为了假装语义化，而是硬约束：npm/pnpm 校验 `version` 必须是合法 semver，
下游包名生成也预期 `X.Y.Z`。既然必须有三段，就给第三段一个**事实性**（而非价值性）的触发：

> `P` +1 的条件是「**N 已经交到用户手上了，但它坏了**」。
> 这是个可以查证的事实（发出去了没有），不需要判断轻重。

`0.` 永远是 0，含义是"个人自用，不对任何人承诺稳定性" —— 因为没有那个"任何人"。

### 3. 谁递增、什么时候递增

**谁**：人，跑 `pnpm version:bump "这一版交付了什么"`（`--fix` 走 P）。

排除的方案：

- **commit 钩子**：单位错了。它数 commit，而"跑的是哪一份代码"已经由 commit 号回答；
  再加一个随 commit 走的数字，信息量为零，"第几个**可用**的东西"更是答不了。
  次要理由：钩子不随克隆走，换台机器就静默消失 —— 本仓已经有过"需要人记住的规则
  等价于迟早被违反的规则"的结论（PROTOCOL §7 补充）。
- **CI 自动**：CI 在每次 push 上跑，单位仍是 commit 不是交付；且 CI 往主干回写 commit
  会和正在干活的 agent 抢树（PROTOCOL §10 关心的正是"过程中别人看到了什么"）。

**什么时候**：**有东西交到用户手上的时候。** 注意这条的性质 ——

> `pnpm version:bump` **就是**"发布"这个动作。
> 没跑它 = 没发布 = **本来就不该 bump**。

所以"人会忘"这个风险不需要用守卫去追，它在结构上不成立。这一点决定了守卫该守什么
（下一节）。

### 4. 单一事实来源与传播链

```
package.json (version: "0.2.0")          ← 唯一权威。其余 9 个 package.json 没有 version 字段
        │
        │  scripts/lib/version.mjs :: readProductVersion()   ← 唯一读取点
        ├──────────────► scripts/check-version-sync.mjs      （守卫）
        ├──────────────► scripts/version-bump.mjs            （递增 + 写 CHANGELOG）
        └──────────────► scripts/gen-build-info.mjs          （构建时烘焙）
                                │
                                ▼
                 apps/daemon/dist/build-info.json  { version, commit, commitTime, dirty, builtAt }
                                │
                                ▼
                 main.ts  BUILD_INFO.version → export const VERSION
                                │
                                ▼
                 GET /api/health → { version, build: { commit, commitTime, dirty, builtAt, startedAt } }
                                │
                                ▼
                 MockNotice.tsx   "daemon v0.2.0 · 08-08 00:40 · 起 16:52"
```

两个设计点：

1. **其余 9 个 `package.json` 是删字段，不是同步值。**
   同步方案要靠一个脚本维持 10 份拷贝，而**拷贝存在本身就是分叉的前提**。
   字段不存在，就没有东西可以分叉。这是结构上的解决而非纪律上的。
   `[实测 2026-08-08]` pnpm 10.15.0 在 /tmp 最小工作区里对 private 包缺 `version`
   无异议：`pnpm install` 与 `pnpm -r build` 均 exit 0。
2. **版本号跟着产物走，不在启动时读 `package.json`。** 理由与 `gen-build-info.mjs`
   开头论证"不在启动时读 git"完全一样：daemon 跑的是上次构建的 `dist/`，
   bump 了没重建就会**显示新版本却跑着旧代码**。另外解包发行版里
   `dist/main.js` 旁边不保证有根 `package.json`（`files` 只列了 `dist`）。
   读不到时 daemon 报 `unknown`，界面显示"版本未知" —— 诚实，且不伪装成版本号。

### 5. 守卫：`scripts/check-version-sync.mjs`

接进 `pnpm test:ci-scripts`（CI 门禁跑）与 `pnpm check`；并在
`scripts/ci/lint-workflows.mjs` 的"新守卫必须真的被跑到"清单里登记了名字，
被"顺手简化"掉时会当场红。

它检查（自检先行，照 `check-orphan-exports.mjs` 的规矩）：

| #   | 断言                                                    | 抓的是                     |
| --- | ------------------------------------------------------- | -------------------------- |
| ①   | 根 `package.json` 的 `name === 'openmemo'`              | 我读的是我以为的文件吗     |
| ②   | 清单里 9 个包都存在、数量 ≥ 8                           | 扫描器对着不存在的路径报绿 |
| ③   | 9 个包**都没有** `version` 字段                         | 有人把副本加回来           |
| ④   | 根 `version` 匹配 `^0\.\d+\.\d+$` 且文件名安全          | 格式漂移；下游包名会拼它   |
| ⑤   | `main.ts` 的 `VERSION` 来自 `BUILD_INFO.version`        | **v0.1.0 的原始成因复发**  |
| ⑥   | `CHANGELOG.md` 最新条目 == 根 `version`                 | 版本变了但没说变了什么     |
| ⑦   | `dist/build-info.json` 的 `version` == 根（构建过才查） | 改完没重建，界面在报旧值   |

**它刻意不做的事**：不检查"你是不是该 bump 了"。

那种守卫（如"距上次 bump 已 N 个 commit"）会在**每一次日常提交**上变红，
而本仓刚得出过结论：**一条永远红的守卫等于一条被删掉的守卫**。
更根本的是它守不住东西 —— "这东西现在能交给用户了吗"是人的判断，机器没有依据。
递增靠 §3 的结构保证，守卫只守一致性，于是它**今天就是绿的**，只在真分叉时红。

⑥ 之所以能既有用又不常红：版本号和 CHANGELOG 由 `version:bump` **一次写入**，
正常路径下不可能不一致；只有人手改了其中一个才红 —— 而那正是要抓的。

`[实测]` 本轮接上守卫时它**当场红了一次**：根 `version` 已改为 `0.2.0` 而
`dist/build-info.json` 还是旧的（⑦）。跑 `pnpm build:safe` 后转绿。
这既是它有效的证据，也说明⑦不是装饰。

### 6. tag 形状

产品版本 tag：**`v0.2.0`**（`v` + semver）。

现有 5 个 release 的 tag 是 `backend-packs-2026.08.06/07/07b`、`model-mirror-2026.08.06`,
形状是 `<种类>-<日期>`，**没有 `v` 前缀**。README 第 12 行：
"⚠️ **Releases 页那些 `backend-packs-*` / `model-mirror-*` 不是给你下的。**"

`v` 前缀让产品版本与那两类**一眼可分**，同时 README 那句话继续成立（它点名的是那两个前缀，
产品 tag 不在其列）。

两点提醒：

- **tag ≠ GitHub Release。** 打 tag 不会往 Releases 页加任何东西，
  所以 README 那句"Releases 页那些不是给你下的"不会因为打了 `v0.2.0` 而失效。
- 本轮**没有创建任何 tag**（纪律禁止建/改/删 release，且打 tag 是不可撤销的推送动作）。
  `version:bump` 只**打印**建议的 `git tag` 命令，不替人执行。
  因此 tag 与 `package.json` 的一致性**目前无守卫** —— 见 §7。

### 7. 已知缺口（诚实记录）

- **tag 一致性无守卫。** 守卫不能依赖 tag：浅克隆 / 新克隆里 tag 可能不存在，
  那条守卫会在无关的机器上变红 —— 又回到"永远红"的老问题。
  目前靠 `version:bump` 打印命令 + 人执行。`[未验证]` 没有实际打过 tag。
- **⑦ 在没构建过的树上跳过。** 会明确打印"跳过"而不是静默通过。
  CI 的门禁顺序是 `build:safe` → … → `test:ci-scripts`，所以在 CI 里它一定被执行到。
- **`0.1.0` 这一条 CHANGELOG 条目没有日期**，因为它根本不对应某一次交付
  （它是一个从没动过的字面量）。写成 `（无日期）` 而不是编一个。
