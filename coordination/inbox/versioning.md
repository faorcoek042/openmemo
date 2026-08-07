# versioning —— 回执

## [2026-08-08 01:05] T-VERSIONING DONE

交付:
- `docs/design/D-12-versioning.md`（方案与依据，TL;DR 在开头）
- `scripts/lib/version.mjs`（版本号唯一读取点）
- `scripts/check-version-sync.mjs`（守卫，7 条断言）
- `scripts/version-bump.mjs`（递增 + 写 CHANGELOG，一条命令）
- `CHANGELOG.md`（新建）
- `package.json`（version 0.0.0 → **0.2.0**，新增 `check:version` / `version:bump`，接进 `check` 与 `test:ci-scripts`）
- `apps/daemon/src/main.ts`（`VERSION` 由字面量改为 `BUILD_INFO.version`）
- `scripts/gen-build-info.mjs`（把 version 烘焙进 `dist/build-info.json`）
- `apps/web/src/components/common/MockNotice.tsx`（版本未知时不再显示成 `vunknown`；tooltip 说明四个信号分工）
- 9 个工作区 `package.json`：**删除** `version` 字段
- `scripts/ci/lint-workflows.mjs`（把新守卫登记进"必须被跑到"清单，+1 行）

要点:
1. **那两个数各自从哪来、为什么对不上**：界面上的 `v0.1.0` 来自
   `apps/daemon/src/main.ts:78` 手写的 `export const VERSION = '0.1.0'`；`package.json` 的
   `0.0.0` 是 `npm init` 默认值。`[实测]` 全仓读 `package.json` 只有 4 处，**没有一处读
   `version`**。所以不是"drift"，是**两条从未相交的线** —— 没有任何东西会让它们变。
2. **规则 `0.N.P`**：N = 第几个可用的东西，P = 针对**已交付**的那个 N 的修补。
   不用语义化（判断"破坏性"需要一个被破坏的人，本项目没有下游）；
   不用日期版本（`commitTime` 已在界面上答了"什么时候"，且会和
   `backend-packs-2026.08.07b` 撞脸，毁掉 README 第 12 行的区分）。
3. **递增 = 发布本身**。`pnpm version:bump "摘要"` 一次写 `package.json` + `CHANGELOG`。
   没跑它 = 没发布 = 本来就不该 bump，所以"忘了 bump"在结构上不存在。
   不用 commit 钩子（单位错了、不进克隆），不用 CI 自动（单位仍是 commit、会和人抢树）。
4. **单一事实来源 = 根 `package.json` 的 `version`**。其余 9 个是**删字段**而非同步值 ——
   拷贝存在本身就是分叉的前提，删掉就没有东西可以分叉。
   `[实测]` pnpm 10.15.0 对 private 包缺 `version` 无异议（/tmp 最小工作区，install + -r build 均 exit 0）。
5. **守卫只守一致性，不守"你该 bump 了"**：后者会在每次日常提交上变红，
   而一条永远红的守卫等于一条被删掉的守卫。守卫**今天就是绿的**。

### 守卫怎么保证它不再烂掉

`pnpm check:version` 已接进 `pnpm test:ci-scripts`（CI 门禁）与 `pnpm check`，
并在 `scripts/ci/lint-workflows.mjs` 的"新守卫必须真的被跑到"清单里登记了文件名 ——
被"顺手简化"掉时当场红。

`[实测]` 七条断言**逐条反向验证**，全部在 `/tmp/versioning/fake` 的隔离副本上做
（PROTOCOL §10：共享树里不做反向验证），共享树全程未被弄坏：

| # | 拆掉什么 | 结果 |
|---|---|---|
| ① | 根 `package.json` 的 name 改掉 | ✔ 红（自检：读错文件） |
| ② | 移走 `packages/llm/package.json` | ✔ 红（自检：清单对不上，防止对着不存在的路径报绿） |
| ③ | 给 `packages/db` 加回 `version` | ✔ 红 |
| ④ | 根 version 改成 `2026.08.08` | ✔ 红（格式 + 文件名安全） |
| ⑤ | `main.ts` 改回 `VERSION = '0.9.9'`（v0.1.0 的原始成因） | ✔ 红 |
| ⑥ | 改 version 不改 CHANGELOG | ✔ 红 |
| ⑦ | 改 version 不重建 | ✔ 红 |

还原后回到绿。另外守卫在**本轮真的红过一次**（不是演习）：根 version 改成 `0.2.0` 之后
`dist/build-info.json` 还是旧的，⑦ 当场拦下，跑 `pnpm build:safe` 才转绿。

`[实测]` 端到端（不是只比文件）：在假 `HOME` + `OPENMEMO_POINTER_FILE` 覆盖下
import 真实产物 `apps/daemon/dist/main.js`，得
`VERSION = "0.2.0"`、`BUILD_INFO.version = "0.2.0"`。
用户的 `~/.local/share/openmemo/datadir.json` 前后 sha256 一字未变（§9 / §9-bis）。

`[实测]` 顺手抓到并修掉一个自己的 bug：`version-bump.mjs` 原用
`toISOString().slice(0,10)`（UTC），本机 UTC+8，当地 2026-08-08 00:52 时它写出
`2026-08-07` —— 每天有 8 小时会把 CHANGELOG 日期写早一天。已改为本地日期并实测。

### 门禁（绑定在**我提交的那棵树**上，不是共享树跑到一半那次）

⚠️ 本轮共享工作树**极其繁忙**：我动手时 HEAD 是 `5769110`，交付时已经是 `d8c0926`，
中间落了 4 个提交（导图导出/搜索跳转、断路器冷却、预编译包组装器…），
同时还有第三位 agent 的 runtime/breaker 改动在飞。

第一次 `pnpm -r test` 因此**作废**（跑了 45 分钟后卡死在 `apps/web` 的
`components.test.js` 上，`do_epoll_wait`、CPU 时间冻在 2m11s、RSS 291MB）。
`[实测]` 291MB **不是** PROTOCOL §8 那个 10.5GB 的 OOM 形状，而是那位 agent
半保存状态的源码被 vite 打进 `.test-out` 所致；他们提交后复跑即恢复。
按 §10「撞上红灯的一方先判断是不是自己的」处理，未去动别人的文件。

在共享树上直接跑 `pnpm -r test` 会红 2 条，**已证明不是我的**：

```
✖ ★ 任何带 `**` 的词条都必须在登记表里
✖ T-129b 写了 `**` 就必须有人渲染它
   actual: ['settings.dataDir.externalTitle','settings.dataDir.resultMoved','settings.dataDir.resultPointed']
```

这三个 key 是 `git diff apps/web/src/app/i18n/locales/zh-CN.json` 里的 `+` 行，
属于数据目录那位在飞的改动；**我一个 i18n key 都没加、也没碰过 locale 文件**
（MockNotice 里沿用该文件既有的内联中文写法，正是为了不去碰别人正在改的 locale JSON）。

所以门禁在**隔离树**上跑：`git archive HEAD(3849239)` + **只叠加我的 20 个文件**，
`node_modules` / `vendor` 软链回真仓库（照 `scripts/mutation-check.mjs` §36 的形状）。
已核对该树的 locale JSON 与 HEAD 逐字节相同，即别人的在飞改动确实不在里面。

**最终结论跑在提交 `5c06654` 那棵树上**（`git archive HEAD` 导出，
`node_modules`/`vendor` 软链回真仓库），不是跑到一半那次检查：

| 门禁 | 结果（提交 `5c06654`） |
|---|---|
| `pnpm build:safe` | ✔ exit 0 |
| `pnpm check:version`（新） | ✔ exit 0 |
| `npx tsc -b` | ✔ exit 0 |
| `npx eslint .` | ✔ exit 0 |
| `pnpm lint-workflows` | ✔ **768** 条断言全过（**8** 个 workflow） |
| `pnpm test:ci-scripts` | ✔ 22 passed / 0 failed（含新守卫，排在链首） |
| `pnpm check:orphans` | ✔ 无新增零引用导出；基线 **70**（未升） |
| `pnpm -r test` | ✔ **1462 tests / 1462 pass / 0 fail**，`Scope: 9 of 10`，含 `apps/web` 447 条 |

（`lint-workflows` 从 628/7 涨到 768/8、测试数涨到 1462，都是因为期间预编译包那位的
`build-bundles.yml` 与三个 workflow 相关提交落地 —— 不是我加的。）

中途在"HEAD=3849239 + 只叠加我的 20 个文件"的隔离树上也全绿过一次
（`1433 pass / 0 fail`），那次用于**把我的改动和别人的在飞改动分离**，
证明红灯不是我的；上表才是绑定在最终提交上的那次。

**关于 1433 vs 基线 1349（+84）**：`[实测]` 我**一个测试文件都没加**。
`git diff --stat 5769110..HEAD -- '*.test.ts' '*.test.tsx'` = 8 个文件、2020 行新增，
全部来自这期间落地的别人的提交（`content.mindmapExport.test.ts` 234 行、
`storage.dataDir.test.ts` 401、`breakerRecovery.test.ts` 275、`components.test.tsx` +650 等）。
基线上升与本次改动无关；`check:orphans` 那条**只许降不许升**的基线稳在 70。

下一步建议:
1. Manager 重启 demo 前跑 `pnpm build:safe`，否则界面仍显示旧版本（守卫⑦会提醒）。
2. 产品 tag 用 `v0.2.0`（与 `backend-packs-*` / `model-mirror-*` 刻意分开）。
   本轮**没有创建任何 tag/release**（纪律禁止）。tag ≠ Release，打 tag 不会往 Releases 页加东西，
   所以 README 第 12 行继续成立。
3. tag 与 `package.json` 的一致性**目前无守卫**（守卫不能依赖 tag：浅克隆里 tag 可能不存在，
   那条守卫会在无关机器上永远红）。已在 D-12 §7 记为已知缺口。

需要 Manager 决策:
- 起点定为 `0.2.0`（而非 0.1.0 / 1.0.0）：`0.1.0` 是一个从没动过的字面量、不代表某次交付，
  把它记为"第 1 个"、本次为"第 2 个"。若 Manager 认为该另起编号，改根 `package.json`
  一处 + `pnpm check:version` 会指出 CHANGELOG 也要跟着改。

### 给「预编译包」那位（`prebuilt`）

- **权威值 = 根 `/root/memo/package.json` 的 `version` 字段**，当前 `0.2.0`。
- 格式保证：`^0\.\d+\.\d+$`，且 `^[A-Za-z0-9.-]+$`（**文件名安全**：无空格、无 `+`、
  无 Windows 非法字符）。守卫④会拦住任何破坏这两条的改动。
- **请不要自己写 `JSON.parse(readFileSync('package.json')).version`**。用
  `import { readProductVersion, productTag } from '<repo>/scripts/lib/version.mjs'`
  —— 那是唯一读取点，多一个读取点就多一次分叉机会。
- 建议包名形状：`openmemo-<version>-<os>-<arch>.<ext>`，例如 `openmemo-0.2.0-win-x64.zip`。
- 产品 tag `v0.2.0` 与你的 `backend-packs-*` 是**两套编号**，不要互相推导。
- 我没有改 `.github/workflows/**`、`docs/design/D-17-*`、`coordination/inbox/prebuilt.md`。
  唯一碰到你邻近区域的是 `scripts/ci/lint-workflows.mjs` **+1 行**（把新守卫加进
  "必须被跑到"的文件名清单），无逻辑改动。
