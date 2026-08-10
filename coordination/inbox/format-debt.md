# format-debt

## [2026-08-08 14:05] format-debt DONE —— 全仓格式化 + `format:check` 接进 CI

交付:

- `72093b9` style: 全仓 prettier 格式化（365 个文件，纯格式化）
- `.github/workflows/ci.yml`（新增 `Format check` 步骤）
- `.prettierignore`（补 5 条**生成物**忽略，见下）
- `package.json`（`pnpm check` 加入 `format:check`）
- `packages/downloader/scripts/e2e-firstrun.mjs`（格式化打断了一条 eslint 指令，已修）
- `scripts/mutation-check.mjs`（更正一条今天已不成立的注释）
- 本文件

要点:

- **重新量的数是 508**，不是 476 / 481 / 403 —— 那三个都已过期。
- 格式化前后全量测试**逐 suite 计数完全一致**：1508/1508/0，这是"纯格式化"的证据。
- 格式化**打断了一条 `eslint-disable-next-line`**，全量测试抓不到，eslint 抓到了。
- prettier 3.9.6 在本仓**不是一次收敛**的：3 个文件要跑第二遍 `pnpm format`。
- 那两条"合理地不接"**今天仍然不该接，但两条的理由都已经过期**，已就地更正。

下一步建议:

- `verify-unpack.mjs` 的 53 条解包安全断言仍然**没有任何自动调用方**（见 §6）。
- prettier 非幂等那 3 处可以顺手改掉源文本，让 `pnpm format` 一次到不动点。

需要 Manager 决策: 见 §7（`coordination/inbox/**` 现在也被门禁盯着了，这是个取舍）

---

## 1. 到底多少个文件不合格：**508**

```
$ pnpm format:check
[warn] Code style issues found in 508 files. Run Prettier with --write to fix.
```

交叉核对过：`[warn]` 开头共 509 行，其中 1 行是 prettier 自己的汇总行，**508 个文件**。

按扩展名：`ts` 160、`js` 139、`md` 105、`mjs` 45、`tsx` 41、`json` 15、`yml/yaml` 3。
按目录：`apps/web` 216、`apps/daemon` 65、`coordination/inbox` 53、`packages/pipeline` 35、
`packages/downloader` 24，其余分散。

**508 里只有 367 个是版本库里的文件**，另外 141 个是被 git 忽略的生成物
（140 个 `apps/web/.test-out/**` + 1 个 `.claude/settings.local.json`）——
这条差异很重要，见 §4。

## 2. 「纯格式化」的证据：前后测试数**一模一样**

判据是任务里定的那条：格式化前后各跑一次全量测试，两次必须完全一致。

|              | tests | pass | fail | skipped | todo |
| ------------ | ----- | ---- | ---- | ------- | ---- |
| 格式化**前** | 1508  | 1508 | 0    | 0       | 0    |
| 格式化**后** | 1508  | 1508 | 0    | 0       | 0    |

而且不只是比总数 —— 我把 11 个 suite 的分项计数各自排序后逐行 `diff`，**输出为空**。
（总数相同但内部此消彼长，是这条判据最容易被糊弄过去的地方。）

### 2-bis 另一条独立证据：词袋比对

测试相同只能说明"行为没变"，不能直接说明"内容没变"。所以另做了一次机械比对：
把每个文件的**词元多重集**（标识符 / 数字 / 中日韩词串）取出来，前后对比。
prettier 只挪空白、换引号、补尾逗号、重排换行 —— 这些都不改词元。

结果：**367 个格式化文件里 367 个词袋完全相同**（把 markdown 强调符 `_`/`*`
从词元边界剥掉之后；不剥的话有 18 个 md 文件因 `*x*` → `_x_` 而不同）。
唯一 3 个词袋有差异的文件，正是我**手工改过**的那 3 个（`ci.yml` /
`.prettierignore` / `package.json`）—— 这个检查确实能抓到人工改动，不是空转。

### 2-ter 测试覆盖不到的那批文件另外验了

本仓有一批 e2e 驱动脚本**没有任何自动调用方**（`pnpm -r test` 碰不到它们），
所以"测试数一样"对它们是无效证明。补了两条机械检查：

- 改动过的 45 个 `.mjs`/`.js`：**全部 `node --check` 通过**（语法没坏）
- 改动过的 13 个 `.json`：**全部 `JSON.parse` 通过**

## 3. ⚠️ 格式化**确实弄坏了一样东西**（已修）—— 而测试抓不到它

`packages/downloader/scripts/e2e-firstrun.mjs`：

```
  292:3  warning  Unused eslint-disable directive (no problems were reported from 'no-undef')
  294:9  error    'document' is not defined                                                    no-undef
```

成因：那里原本是 `/* eslint-disable-next-line no-undef */`，盖住下一行的
`page.evaluate(() => [...document.querySelectorAll(...)])`。**prettier 把箭头体折到了下一行**，
于是 `document` 从"下一行"变成"下下行" —— 指令一个字没改、位置也没动，
**但它盖住的已经不是那一行了**。

这条值得单独记住的地方有两点：

1. **它是"纯格式化"这个说法的真实反例。** 格式化对 AST 是中性的，
   但对**任何按行号生效的东西**（eslint 行指令、`// prettier-ignore`、
   带行号的注释锚、覆盖率忽略标记）**不是中性的**。
2. **全量测试对它完全无感** —— 这个脚本没有任何自动调用方，1508 条测试一条都碰不到它。
   `[实测]` 前后测试数完全一致，而 eslint 是红的。
   **"测试数没变"证明不了"没坏"，只有把所有门禁都跑一遍才行。**

修法没有沿用 `disable-next-line`，改成**成对的 `disable` / `enable`**：
判据同 PROTOCOL §7 补充 —— **不依赖行号，下次再被重排也不会失效**。

反向验证：坏的那一版的红灯是**真实观测到的**（上面那段就是 `npx eslint .` 的原始输出，
退出码 1），修完退出码 0、`0 problems`。不是"改完看着对"。

顺带核了一遍**其它 6 条 `eslint-disable-next-line` 有没有被同样打断**：
eslint 默认就会把失配的指令报成 `Unused eslint-disable directive`，
而全仓只有上面这一处报了 —— 所以**只有这一条被打断**，其余 6 条仍然盖在正确的行上。

## 4. `.prettierignore` 今天忽略了什么

### 4.1 本来就有的（我没动）

| 条目                                                                                 | 是什么                     | 判断                                                                                                    |
| ------------------------------------------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------- |
| `vendor/whisper.cpp/` `vendor/sherpa-onnx/` `vendor/sqlite-vec/` `vendor/libsimple/` | 第三方源码（ADR-001 A 类） | **合理**。核过：这四条**恰好就是 `.gitmodules` 里的四个 submodule**，一个不多一个不少（共 7617 个文件） |
| `**/dist/` `**/build/` `**/*.tsbuildinfo` `pnpm-lock.yaml`                           | 构建产物 / 锁文件          | **合理**。顺带满足 PROTOCOL §7：`apps/web/dist` 被 `**/dist/` 盖住，格式化碰不到它                      |
| `apps/web/src/components/ui/`                                                        | shadcn/ui 复制进来的源码   | **合理但今天是空的**，见下                                                                              |

⚠️ 关于最后一条，一个如实的观察：**它今天实际只挡住 1 个文件**，
而且那个文件是 `SOURCE.md` —— 我们自己写的豁免说明，不是上游代码。
`git ls-files apps/web/src/components/ui/` 只有这一个，组件清单表格里写着"目前为空"。
也就是说"保持与上游一致便于 diff"这个理由**今天还用不上**。
我**没有动它**：它是 ADR-002 预先登记的豁免，是为将来加组件准备的，
现在收窄它只会让下一个加组件的人踩坑。记在这里只是让你知道它当前的实际覆盖面 = 1。

`vendor/manifests/`（7 个文件）**不在**忽略里，是对的 —— 它是我们自己写的清单，
不是第三方源码。这次它们被正常格式化了。

### 4.2 本轮**新加**的 5 条 —— 以及为什么这不是"把债藏起来"

新加：`**/.test-out/`、`**/dist-types/`、`.build/`、`license-report.json` /
`license-report.md`、`.claude/`。

先把最要紧的说清楚：**这 5 条一个版本库里的文件都没挡住。**

```
$ git ls-files | grep -E '(^|/)\.test-out/|(^|/)dist-types/|^\.build/|^\.claude/|^license-report\.(json|md)$'
（无输出，命中 0）
```

所以受门禁覆盖的**源码**一个没少，508 里那 367 个真文件**全部**被格式化、
且**全部**仍在 `format:check` 的射程内。加这几条**不改变任何一个源文件的命运**。

真正的理由是**门禁必须确定**。关键事实：**prettier 不读 `.gitignore`**，只读
`.prettierignore`。而 `apps/web/.test-out/` 这类目录**只在跑过测试之后才存在**。
实测这个链条：

```
全仓格式化到干净  →  pnpm format:check 绿
  →  跑一次 pnpm -r test（重新生成 .test-out）
  →  pnpm format:check 当场红 **95 个文件，其中 92 个是 .test-out/**
```

也就是**同一棵树会给出两种答案，取决于"你之前跑没跑过测试"**。
在 CI 上 `format:check` 排在 test 前面 → 永远绿；本地的人通常先跑测试 → 经常红。
**一条"本地红、CI 绿"的门禁，和一条永远红的门禁，对人的训练效果是同一个** ——
都教人别信这盏灯。这正是本仓一直在清的那个病（"没跑"和"跑了并通过"长得一样）的变体。

反向验证（在 `/tmp/pi-test` 隔离副本上做的，没碰共享树，**先跑对照组**）：

```
对照组 apps/web/src/control.js（故意写坏、不该被忽略）  →  被判红 ✓（证明检查在跑，不是空集）
apps/web/.test-out/artifact.js                         →  已忽略 ✓
.build/artifact.js                                     →  已忽略 ✓
packages/x/dist-types/artifact.js                      →  已忽略 ✓
.claude/settings.local.json                            →  已忽略 ✓
license-report.json                                    →  已忽略 ✓
```

`.claude/` 那条要单独说一句：**不加它时 `prettier --write .` 会去改写
`.claude/settings.local.json`** —— 那是本机 harness 配置，不是本仓源码
（被全局 gitignore 忽略，不在版本库里）。本轮第一次跑 `pnpm format` 时它**已经被改写过一次**。
`[未验证]` 我没有它的改写前副本可以逐字节比对（文件不在版本库里，也没有备份），
只能确认**改写后仍是合法 JSON、顶层键集不变（只有 `permissions`）**，
且 prettier 对 JSON 只改空白不改键值。加上这条之后不会再发生。

## 5. ⚠️ prettier 3.9.6 在本仓**不是一次收敛**的

跑完一遍 `pnpm format` 之后，`pnpm format:check` **仍然是红的**——有 3 个文件
prettier 自己的输出还不满足自己的检查：

| 文件                                          | 非幂等的成因                           |
| --------------------------------------------- | -------------------------------------- |
| `coordination/BOARD.md`                       | 一个嵌在 blockquote 里的 markdown 表格 |
| `docs/research/R-04-model-mgmt.md`            | 一处 `_`/`*` 混用且不配对的强调        |
| `packages/downloader/scripts/e2e-browser.mjs` | 一条链式调用的折行反复横跳             |

`[实测]` 在 `/tmp` 副本上逐轮打哈希，三个**都在第 2 遍到不动点**（第 1 遍改，第 2 遍不动）。
所以本轮跑了两遍 `pnpm format`。

**这件事必须写进 CI 注释**，否则下一个人的体验是"我明明跑了 format，CI 还是红"，
然后开始怀疑门禁坏了 —— 已经写进 `ci.yml` 的 `Format check` 步骤和
`package.json` 的 `_comment:check-format` 里了。

## 6. `pnpm check` 的成员今天全部有自动调用方了

先更正一处**旧对账里的错数**：`ci.yml` 里原本写着「`pnpm check` 的五个成员」，
**实际是六个** —— 漏数了 `node scripts/check-version-sync.mjs`。
结论不受影响（它确实有调用方），但**错的数目最容易被下一个人照抄**，已就地更正。

| `pnpm check` 的成员         | 自动调用方                                               |
| --------------------------- | -------------------------------------------------------- |
| `check-tracked-sources.mjs` | `ci.yml` → Tracked-sources guard；`ci-crossplatform.yml` |
| `check-orphan-exports.mjs`  | `ci.yml` → Orphan-exports ratchet                        |
| `tsc -b`                    | `ci.yml` → Typecheck                                     |
| `pnpm build:safe`           | `ci.yml` → Build (workspace packages)                    |
| `check-version-sync.mjs`    | **只经由** `test:ci-scripts` 的第一个成员（无独立步骤）  |
| `eslint .`                  | `ci.yml` → Lint                                          |

聚合脚本 `pnpm check` **本身**仍然没有自动调用方（这没问题 —— 它是给人用的便捷入口，
六个成员各自都被 CI 单独跑了；直接在 CI 调它会把 build 跑第二遍）。

本轮把 `format:check` 也加进了 `pnpm check`（排在最前面，它只要 prettier，不 build）。
理由不是"补全"，是防一个具体的坏味道：`format:check` 同一轮进了 `ci.yml`，
如果本地 `pnpm check` 不含它，就会出现**本地全绿、推上去 CI 红**。

### 6.1 那两条"合理地不接" —— **结论都仍然成立，但两条的理由都已经过期**

任务要求核实、不要照抄。核完的结果是：**两条都不该接进 CI（结论不变），
但它们各自写着的理由今天都已经不成立了**，已就地更正。

**(a) `check:selfcheck`（`scripts/selfcheck.mjs`）**

旧理由：「要真数据目录 + 跑着的 daemon」。逐条核：

- 「要跑着的 daemon」→ **今天不成立**。`const DAEMON = argOf('--daemon', null)`，
  所有用到它的地方都有 `if (!DAEMON) return null` 兜底，没 daemon 不会产生任何
  `required` 失败。daemon 是**可选**的。
- 「读机器级指针 `datadir.json`」→ **不成立，而且从来没成立过**。
  `grep -c 'datadir.json' scripts/selfcheck.mjs` = **0**。它自己算 `defaultDataDir()`。
  （这条关系到 PROTOCOL §9，所以特意查了 —— 它**不碰**那个全局单例。）
- 「要真数据目录」→ **成立**。`packages/runtime/src/selfcheck.ts` 里有多条
  `required: true` 的检查（ASR 模型、中文分词扩展等），空目录上必红，
  而 `selfcheck.mjs` 的退出码就是 `failures.length === 0 ? 0 : 1`。
  有 `OPENMEMO_DATA_DIR` / `OPENMEMO_MODELS` / `OPENMEMO_EXT_DIR` 覆盖，
  但**没有 fixture 模式** —— 指向空目录照样红。

**旧判断漏掉的最要紧一条**：`scripts/selfcheck.mjs` **本身其实已经有自动调用方了** ——
`scripts/ci/cold-start-audit.mjs:410` 会 `--data-dir ... --daemon ... --json` 地调它，
而那个脚本由 `build-bundles.yml` 与 `cold-start-audit.yml` 自动跑，
并且**拿它的退出码当判据**。所以准确的说法是：

> **脚本已经被 CI 真跑了**，只是跑在一条**先铺好真资产、再把 daemon 起起来**的
> 重型工作流里，而不是 `ci.yml` 的一个裸步骤。没有调用方的是
> **`check:selfcheck` 这个 npm 别名**，不是那个脚本。

→ **不接进 `ci.yml` 仍然正确**，但理由要换成"它已经在该在的地方被跑了"，
而不是"它跑不了"。

**(b) `scripts/mutation-check.mjs`**

结论仍然成立：**不进门禁**。但它文件头写的理由里有一句今天是**假的**：

```
（诚实地说：本仓库没有 CI、没有 git hook、`pnpm check` 也没人跑 ——
多加一条没人跑的门禁没有意义，所以这里不装作它是门禁。）
```

`.github/workflows/ci.yml` 今天在跑、push/PR 自动触发，`pnpm check` 六个成员
也全部有自动调用方了。留着这句会让下一个人推出「反正没 CI」这种今天错的结论 ——
本仓自己的话：**一条描述得很具体的错注释，比没有注释更能误导人**。已就地更正。

另外核了一遍**当初挡着它的隔离问题**：变异体已经跑在 `/tmp` 副本 + 假 `HOME`/
`XDG_DATA_HOME` 里（正是 PROTOCOL §9-bis 推论要求的形状），每个目标包还先跑对照组。
**所以今天不接是成本取舍（要几分钟、要先 build、它测的是护栏不是产品），
不再是"做不到"。**

### 6.2 顺手数到的、但**不在**本轮范围内的

`packages/downloader/scripts/verify-unpack.mjs` 装着 **53 条解包安全断言**
（zip-slip / 绝对路径 / 符号链接逃逸 / zip 炸弹），`docs/SECURITY.md` 与 ADR-015
都拿它当"这些控制已实现"的证据 —— 而它**没有任何自动调用方**。
`scripts/orphan-exports-baseline.json` 里已经记着这件事了。
同类的还有 20 个 e2e 驱动脚本（`apps/daemon/scripts/e2e-*.mjs`、
`packages/downloader/scripts/e2e-*.mjs`、`packages/mindmap/scripts/demo-f4.mjs`）。
**这是下一轮值得单独立一条的债**，形状和 `check:orphans` 当初那条一模一样：
锁造好了，挂在没人经过的门上。

## 7. 需要 Manager 决策：`coordination/inbox/**` 现在也被门禁盯着

53 个 `coordination/inbox/*.md` 这次被格式化了，而 `format:check` 进 CI 之后，
**agent 每次追加回执都要满足 prettier 的 markdown 风格**，否则 CI 红。

我**没有**把 `coordination/` 加进 `.prettierignore` —— 任务里明确说了不许为了让数字
好看而扩大忽略范围，而且 inbox 是版本库里的真文件，不是生成物。

但这条取舍你应该知道：prettier 对 markdown 主要动**表格对齐**和**强调符归一化**
（`*x*` → `_x_`），而 agent 手写的表格几乎不可能一次对齐。实际影响是
**写了表格的回执大概率会让 CI 红一次**，然后作者要跑一遍 `pnpm format`。

三个选项，我倾向 (1)：

1. **保持现状**：回执也守格式，作者跑 `pnpm format` 即可（一条命令，且 `pnpm check` 里也有）。
2. 把 `coordination/inbox/` 加进 `.prettierignore`：代价是这批文件从此无人管，
   而它们是版本库里的真内容 —— 这才是真正的"把债藏起来"。
3. 只对 markdown 关掉表格对齐：prettier 没有这个开关，做不到。

## 8. 门禁与纪律

全绿，基线**没有升**：

| 门禁                   | 结果                                         |
| ---------------------- | -------------------------------------------- |
| `pnpm -r test`         | **1508 / 1508 / fail 0**（= 基线，未升未降） |
| `npx tsc -b`           | 0                                            |
| `npx eslint .`         | 0（修掉 §3 那条之后；修之前是 1 error）      |
| `pnpm build:safe`      | 0                                            |
| `pnpm lint-workflows`  | ✔ 774 条断言全过（8 个 workflow）            |
| `pnpm test:ci-scripts` | 0                                            |
| `pnpm check:orphans`   | ✔ 无新增零引用导出，**基线 70**，无过期条目  |
| `pnpm format:check`    | ✔ All matched files use Prettier code style  |

纪律核对：

- **PROTOCOL §7**：全程 `pnpm build:safe`，从未跑 `pnpm -r build` / `vite build`。
  `apps/web/dist` 在格式化前后各做了一次全目录 sha256，**指纹相同**，一个字节没动。
  另外事前核过：508 个待格式化文件里**没有任何一个**在 `dist/` / `build/` /
  `node_modules/` 下。
- **PROTOCOL §10**：两次反向验证（`.prettierignore` 的 5 条规则、prettier 非幂等）
  **都在 `/tmp` 隔离副本上做**，共享树里没有出现过中间态；`.prettierignore`
  那次**先跑了对照组**确认检查不是空集。
- **共享索引**：两次 commit 前都核了 `git diff --cached --name-only` 的**全量**列表
  （不只是自己 `add` 的）。开工时索引是空的；两次 staged 数量与预期逐条相符。
- 没碰 `:10000`、没碰 `/root/data-memo`、没碰 `~/.local/share/openmemo/datadir.json`、
  没有 `pkill`、没有建/改/删 release。

## 9. 一处**不是**纯格式化的改动，如实记下来

`docs/research/R-04-model-mgmt.md` 有一行的强调符本来就是坏的（`_*…_*`，不配对），
prettier 给那个 `*` 加了转义：

```diff
-→ _*这与我的 §7.3 三档（recommended / slow_* / unsupported）几乎完全同构…_*
+→ _\*这与我的 §7.3 三档（recommended / slow_* / unsupported）几乎完全同构…_*
```

词元一个没少（词袋比对通过），但这是本轮**唯一一处字符层面新增内容**的改动，
渲染结果可能与之前不同。原文本身是坏的 markdown，prettier 的处理是合理的，
但"纯格式化"这个说法在这一行上有个星号，所以写在这里。

## 10. 提交为什么分两个

- `72093b9` —— **纯格式化，365 个文件**。这是 `pnpm format` 的输出，
  **一个字节的人工判断都没有**，将来 `git blame` 追一行代码时可以整跳过。
- 第二个提交 —— 接门禁（`ci.yml` / `.prettierignore` / `package.json`）
  - 两个**除了格式化还带人工改动**的文件（§3 的 eslint 修复、§6.1(b) 的注释更正）
  - 本文件。

那两个文件之所以从第一个提交里拿出来，正是为了保住第一个提交"可以整跳过"这个性质 ——
混进去就毁了。代价是第一个提交的树还不是完全格式化干净的（差那 2 个文件），
但那个提交**没有**引入 `format:check` 门禁，所以不存在"提交进去就是红的"的问题。

---

## [2026-08-10 21:55] test-ratchet DONE —— 给"静默删除守卫文件"上机器判据

交付:

- `aa6e42c` feat(gate): 测试文件棘轮（本体 + 基线 + 22 条自检）
- `4b5af43` ci(gate): 进 gate 一格 + 让"加了 step 却没被数到"当场变红
- `scripts/check-test-ratchet.mjs`、`scripts/test-ratchet-baseline.json`
- `scripts/ci/selftest-test-ratchet.mjs`（22 条，其中 **15 条 ★反向**）
- `scripts/ci/selftest-summarize-gate.mjs` ②-bis（四份名单逐条对齐）

要点:

- 判据是**事实**（在册文件现在还在不在），不看提交信息 —— 这次正是提交信息说了假话。
- **合法删除仍然可做**：挪进 `removed` + 写 `reason`，和 `check:orphans` 的 `note` 同姿势。
- `--update` **只增不减**，所以闭眼跑它**掩盖不了删除**（两条反向用例专钉这个）。
- 复用 orphan 棘轮的形状，**没有新增 job**，只加了 `gate` 的一格（#75 的教训）。
- ⚠️ **有一个残留缺口**，见 §4 —— 不要以为这条守卫全包了。

下一步建议:

- §4 那个缺口要不要堵（要改 CI 的 `fetch-depth`），请你定。
- `verify-unpack.mjs` 的 53 条解包安全断言至今仍无自动调用方（上一轮就报过）。

需要 Manager 决策: §4 的残留缺口 + §5 的新增摩擦，两条都写了我的倾向

### 1. 判据为什么是"文件在不在"

事故的形状你已经写清楚了，我只补一条**为什么不能用别的判据**：

- **不能用提交信息**（"有没有说删了东西"）：这次 `31d3ae3` 的信息写的是
  「只改注释，零行为变更」—— **判据一旦建立在提交信息上，说假话的那次正好绕过它**。
- **不能用 `git diff` / `--stat`**：那 191 行**是可见的**（`--stat` 里明明白白），
  **只是没人看**。把判据放在"有人会看"上，等于没有判据。
- **文件在不在是事实**，且在 CI 里自动可判。所以棘轮的键就是文件路径本身。

### 2. 形状（复用，没新写一套）

`scripts/check-test-ratchet.mjs` + `scripts/test-ratchet-baseline.json`，
和 `check-orphan-exports.mjs` / `orphan-exports-baseline.json` 同构：

| 情形 | 结果 |
| --- | --- |
| 在册文件消失 | **红**，逐个**点名**，并给三条出路（含"你多半是从陈旧索引提交的"） |
| 挪进 `removed` 且写了 `reason` | 绿 —— **合法删除必须还能做** |
| 挪进 `removed` 但没写 `reason`（或空白） | 红 |
| `removed` 里的文件又回到树上 | 红（豁免名单只准变短） |
| 直接把行从 `tracked` 里删掉 | 红（`floor` 抓） |
| 新增测试文件未登记 | 红，修法一条命令 `pnpm check:test-ratchet --update` |
| 扫到的测试文件 < 100，或探针文件不见 | 红，且归因说的是**"扫描范围坏了"**不是"测试变少了" |

两条防"守卫帮着擦指纹"的设计，这是整个东西的关键：

1. **`--update` 只增不减。** 如果它按当前树重新生成名单，那么
   「删掉测试 + 跑一次 --update」就把证据一起抹了。所以被删的文件会**一直留在名单里、
   一直红**，直到有人**手写一条 reason**。
2. **`floor` 整数**（`tracked.length + removed.length >= floor`）。光有名单不够 ——
   把那行直接删掉，守卫就不知道它存在过。两个名单都只增不减，所以这个和单调不减。

探针刻意选**这次被删的那一个** `platformUnsupported.test.ts`：它再消失，第一时间说话。

### 3. 反向验证（都在 `/tmp` 隔离副本，PROTOCOL §10，都先跑对照组）

棘轮自身 **22 条自检，15 条是 ★反向**，每条在 `mkdtemp` 出来的**独立 git 仓**里跑。
关键几条：删 1 个 / 删 3 个**都要逐个点名**（不是只报数字）、
`--update` 之后**门禁依然红**、没写 reason 不放行、空白 reason 不算写、
未跟踪的草稿**不算数**（否则别人没写完的东西会让门禁红）、
基线读不到**不许当成放行**、以及一条我一开始漏了的：
**扫描看起来坏掉时 `--update` 也必须拒绝写基线** ——
否则一次误操作就能把 floor 从 150 洗成 20，**棘轮绿着失忆**。

（这条是自检自己抓出来的：我第一版的夹具用 `--update` 搭 20 文件的沙箱，
它红了 —— 被测脚本拒绝在扫描坏掉时生成基线。那是**正确行为**，我把它补成了一条断言。）

第二组反向验证针对我**新加的那条 drift 守卫**（②-bis）：

```
对照组：原样复制 → 绿 ✓（证明夹具能跑，不是空转）
★反向 A：删掉 gate.outputs 里那行              → 红 ✓
★反向 B：GATE_STEP_NAMES 里去掉                → 红 ✓
★反向 C：GATE_STEP_TEST_RATCHET env 去掉        → 红 ✓
★反向 D：加一个有 id 但没进 STEP_LABELS 的 step → 红 ✓，且点名 brand_new_check
```

### 4. ⚠️ 残留缺口 —— 请你定要不要堵

**本守卫的记忆存在版本库里。** 所以「把整棵树回退到一个更早的快照」这种提交，
会把测试文件**和基线一起**退回去 —— 两边一致，**守卫是绿的**。

说得更直白：**如果一个新测试是在陈旧索引的快照点之后加进来的，
那么用那份陈旧索引提交时，测试和它的基线登记会一起消失，本守卫抓不到。**
—— 也就是说，**这次事故的那一个文件，本守卫在最坏的时序下未必抓得到。**

我没有把这句藏起来，因为"以为有守卫"比"知道没守卫"更危险。

本守卫**确定能抓到**的是：任何**在基线登记之后**消失的文件（含绝大多数误删、
`rm` 掉、重构时顺手删、以及陈旧索引只覆盖部分路径的情形）。

要堵那个缺口，判据只能来自**版本库之外**：「`origin/master` 上的测试文件集
必须是当前提交的子集」。做法要改 `actions/checkout` 的 `fetch-depth`
（现在是浅克隆，没有历史）。**我没有擅自动 workflow 的 checkout 参数** ——
那会影响所有 job 的 checkout 时间，是你的取舍。倾向：值得做，作为**第二道**，
不替换现在这道（现在这道在本地 `pnpm check` 里也能跑，历史比对只能在 CI 里跑）。

### 5. 一个我选了、但你可能想推翻的取舍：新增未登记也判红

新增测试文件不登记 → 红。**理由**：基线不跟上新增，就永远保护不到**最危险的那一档**
——「刚加进来、还没被任何人记住」的文件，而这次删掉的正是这一种。

**代价**：树上 9 个 agent，每次新增测试都要多跑一条命令 + 多提交一个 JSON，
而 `scripts/test-ratchet-baseline.json` 是**单文件 150 行**，并发时会有冲突。

我认为可以接受，因为修法是**一条命令**且**闭眼跑也安全**（只增不减）。
但如果你觉得吵，把 `unregistered` 从 `problems` 里摘掉即可（改一行），
代价就是新文件要等下一次有人跑 `--update` 才进保护圈。

### 6. 接线 + 门禁

- `pnpm check:test-ratchet`（新别名）
- 进 `pnpm check` 链，排在 `check:orphans` 之后
- 自检进 `test:ci-scripts` → 因此 `ci.yml` 的「CI scripts self-test」和
  `ci-crossplatform.yml` **不用改一个字**就已经在跑
- `ci.yml` 的 `gate` 加了一格 `Test-file ratchet`（**step 不是 job**，#75），
  并补齐三态汇总的三处接线

门禁：lint-workflows ✔ **1737 条**（19 个 workflow）、selftest-summarize-gate ✔ **31 条**、
selftest-test-ratchet ✔ **22 条**、check-test-ratchet ✔ 150 在册、
我改的文件 eslint **0 error**、`format:changed` 绿。

纪律核对：

- **没有** `git stash`、**没有** `git checkout -- <file>`。
- 两次提交都是 **`git commit -- <明确路径>` 一步到位**。
  新文件必须先 `git add`（未跟踪的路径 `git commit -- ` 认不了），
  但 pathspec 提交**只取那几条路径**、忽略索引其余部分 —— 已逐次核对：
  另一条腿 stage 的 `apps/web/src/test/components.test.tsx`
  **两次都不在我的提交里，也一直原样留在索引里**。
- 提交前 `pnpm format:changed -- <路径>`（带参数，不是无参模式）。
- 每步绿了立刻 commit + push，没有攒着。
- 没碰 release / v0.7.0 tag / 发版；没碰 `:10000`、数据目录、机器级指针。

⚠️ **master 现在红在 lint**（`components.test.tsx:119-120` 两个未使用导入），
不是本轮引入的，**我没有去动它**。因为 Lint 排在我这一格前面，
在它修好之前，CI 里 `Test-file ratchet` 会显示为 **skipped / 未验证**
—— 这正是三态汇总该有的样子（"没跑"不会被写成"通过"）。
本地已实跑绿，见上。

### 7. §5 那条取舍：**实测在几分钟内推翻了它，我已经改了**（`42525e7`）

上面 §5 我写的是「新增未登记也判红，代价是并发冲突，你要觉得吵就摘掉」。
**不用等你定了 —— 它自己证明了自己不成立。**

棘轮落地（`aa6e42c`）之后**几分钟**，另一条腿提交了
`apps/daemon/src/http/rest/backendInstallAvailability.test.ts`，
master 当场红在我这一格。**红的原因不是有人删了东西，是有人加了测试。**

按 9 个 agent 的并发频率，这盏灯会**经常为合法工作亮**。本仓的判据摆在那儿：
一条经常无理由变红的守卫会被所有人学会忽略 —— 而且会**连累它真正要抓的那件事**：
一旦大家习惯「又红了，跑下 --update 就好」，**真有文件被删那次也会被同样地跑过去**。

关键的一点是：**降级的代价比看上去小。** 表面上"新文件在登记前没保护"，
但 §4 那个残留缺口说明**那个窗口本来就是开的** —— 新文件的基线条目会和文件
**一起**被陈旧索引退回去，判红也拦不住。
**判红付出的是真代价（经常性假红），换来的是假保护。**

所以：`unregistered` → `ⓘ` 提示，不影响退出码。**红的仍然是红的**：
在册文件消失、`floor` 变小、`removed` 没写 `reason`、`removed` 里的文件又回来、
扫描范围坏掉、基线读不到。

并补了一条安全网用例，专钉"降级没有顺带把 missing 也放过"：
**同一次运行里既有未登记的新文件、又有消失的在册文件 → 必须红且点名消失的那个。**
自检 22 → **23 条**。

这条我自己改了没等你，因为它当时正把 master 红着；如果你更想要严格那一档，
改回来是一行（把 `problems.push('unregistered')` 放回去）。

### 8. CI 实跑结果（真 runner）

`31395002993`（提交 `4b5af43`）：

```
✓ Tracked-sources guard
✓ Orphan-exports ratchet
✓ Test-file ratchet (守卫文件不许静默消失)   ← 本轮新加这一格，真 runner 上绿
✓ CI scripts self-test                      ← 含我的 23 条 + summarize-gate 的 31 条
✗ Test                                       ← **不是本轮的**，见下
```

`Test` 那格红在 `packages/downloader` 的 T-198 取消用例
（`not ok — ★★ 取消一个正在跑的任务 → 立刻到达 cancelled` 等 6 条）。
核过：**本轮三个提交没有碰 `packages/downloader/src/` 下任何文件**
（改的全是 `scripts/`、`package.json`、`ci.yml`、本回执），
那几条用例最后一次被动是 `fdd041f`（T-198 那条腿）。**不是我的。**

### 9. ① 已落地，并在**真 runner 上**跑通了定点 fetch

`5afdc02` 已推。run **31400848426 = success**（gate / Format check / gate-summary 三个 job 全绿）。

真 runner 上那一格的原始输出，这是"它真的跑了"的证据，不是我本地的话：

```
git fetch --depth=1 --no-tags origin "$BASE_SHA" || true
 * branch  6e0b36c3fbc3cf023d14f0e6923ab1589fed9bdf -> FETCH_HEAD
✔ 测试文件棘轮：151 个在册（floor 151，removed 0），一个都没少
  历史比对已做（vs 6e0b36c3fbc3cf023d14f0e6923ab1589fed9bdf：基准 151 条全部还在，floor 151 → 151）
```

定点 fetch 在真 runner 上耗时 **约 1.07 秒**（14:56:52.33 → 14:56:53.39），
整个 step 约 1.4 秒。**没有动 `fetch-depth`**，代价只落在这一格。

⚠️ 仍然要记住 `--against` **只在给得出基准时**有效：force-push / 新分支首推 /
fetch 失败时它**不判红**，但会明说「历史比对**没跑成**」。
**绿输出里永远写清这次到底比没比** —— "没比对"和"比过且没问题"不许长得一样。

### 10. ③ `cancel-in-progress` 按 (a) 改了

`concurrency` 从「master 所有 push 共用一组、后来的杀掉在飞的」改成：

```yaml
group: ci-${{ github.event_name == 'push' && github.sha || github.ref }}
cancel-in-progress: ${{ github.event_name != 'push' }}
```

push 事件**每个提交自己一组**（全部并行、全部有判决）；PR 仍按 ref 分组并保留取消
（PR 上"最后一版绿"才是要的结论，中间版本被顶掉没有损失 —— 那才是取消真正有价值的场景）。

判据是量出来的：当天 **18/84 = 21.4% 的推送没有拿到任何判决**，
而取消换来的收益约等于 0（public 仓 + 全托管标准 runner ⇒ 免费；
当天领取延迟中位 **7.5 秒**、峰值并发 3 个 run，关掉后建模 5 个 run ≈ 10 个 job，
在免费 20 并发之内）。

**没有用 `queue: max`**：判决来得晚本身就削弱门禁，且该属性较新、
**没验证过本账号是否支持**，不为拿不准的属性冒配置错的风险。

#### 10-bis ✅ 已验证 —— 不再是"已配置未验证"

`[实测]` 2026-08-10 16:29–16:31，**两跑重叠 30 秒且都跑到了结论**：

```
f8cc1b7   起 16:29:32   止 16:30:43   failure
87e14e1   起 16:30:13   止 16:31:24   failure   ← 在上一跑还活着的时候开始的
```

改之前 `87e14e1` 那次推送会把 `f8cc1b7` 当场杀掉。
另：最近 **12 次运行 cancelled = 0**（对照改之前那天：84 次里 18 次，21.4%）。

⚠️ **这条证据的边界，别读成"问题解决了"**：它证明的只是**两跑重叠时不再互相取消**，
**不**证明 §11 那一档（非 head 提交）有任何改善；而且样本只有**一对**重叠 ——
要更强的证据，得看到**三跑以上同时活着也都拿到判决**。

### 11. ④ ⚠️ 按 SHA 分组之后**仍有一档拿不到判决** —— 靠纪律，不靠机器

**这一条是专门写给"以后来读的人"的，别把上面那条读成「现在每个提交都有判决了」。**

GitHub **只为一次 push 的 head 提交建 run**。所以：

> **一次推多个提交时，中间那些非 head 提交仍然拿不到任何判决。
> 按 SHA 分组也修不了这一档。**

`[实测]` 2026-08-10：93 个提交里 **9 个**落在这里，合计 **66/93 = 71% 有判决**。

裁决是**不上 merge queue** —— 那是重机械，为一个"中间态提交没被单独验"的缺口不值当。
它的最坏后果是**将来 bisect 时那几个点没有结论**，
**不是主干状态没被验**（head 提交是验过的）。

**所以这一档目前由纪律兜着：「每步绿了立刻 commit + push」，一次一个提交。
不是机器管住的。** 当天那 9 个就是批量推造成的。

同一句也写进了 `ci.yml` 的 concurrency 注释里 —— 因为改配置的人未必会来读这份回执，
而**删掉那段注释就等于宣称机器管住了它，而机器并没有**。

### 12. ⚠️ 同一个病咬到了**我自己**，而且落在没有任何棘轮覆盖的文件上

老实交代一次回退，成因值得记下来：

**按 SHA 分组那条配置（`d265d5f`）是在一个独立 worktree 里改的**，
所以 `/root/memo` 工作区那份 `ci.yml` **从头到尾都是旧的** ——
worktree 用的是自己的分支，主工作区的 `master` 从来没有拿到过那次改动。

后来我在共享树上给 `ci.yml` 加 locale 那一格，用的是 read-modify-write：
**读到旧版 → 加上新 step → 整份写回**，于是把自己刚验证过的并发配置
**整段写回了旧版**。`git show --stat` 里那 50 行删除**我自己都没看见**，
而它还被别人的 `git push origin master` 一起带上了主干（我根本没推过那个提交）。

三条要记住的：

1. **和事故是同一个形状**：不报错、不冲突、diff 里可见但没人看。
   我一整天在给别人造判据，自己照样中招 —— 这恰恰说明**纪律确实拦不住**。
2. **它落在没有任何棘轮覆盖的文件上**：测试文件棘轮只看 `*.test.ts`，
   locale 守卫只看 `locales/*.json`，`ci.yml` **谁都没管**。
   守卫是按文件类型长出来的，而这个病是**按操作方式**发作的 —— 覆盖面永远追不上。
3. **worktree 是把双刃剑**：它让我在冻结期安全地干活（§9 那次），
   但也**制造了"主工作区那份文件永远是旧的"** 这个陷阱。
   下次在 worktree 里改共享文件，落地之后要么回主工作区确认内容一致，
   要么后续改动继续在同一个 worktree 里做。

**修法不是"下次小心"**：`scripts/ci/lint-workflows.mjs` 新增 3 条断言，
把那两行并发配置和 §11 那句"靠纪律不靠机器"**钉死**——
改口径可以，但必须**同时改断言**，也就是变成一次显式决定，而不是一次没人看见的回退。

反向验证（`/tmp/lw-test` 隔离副本，**先跑对照组**）：

```
对照组：原样复制                    → 绿 ✓（1747 条断言）
★反向 A：并发改回共用 github.ref     → 红 ✓（2 条，并写出必须长什么样）
★反向 B：删掉「非 head 提交」那句     → 红 ✓
```

### 13. 取消的"第二个来源"不存在 —— 是 §12 那次回退的下游

结论先说：**没有第二个来源。那两跑就是被 concurrency 取消的，用的是我回退掉的旧口径。**

判据是取消时 GitHub 自己写的那行注解，里面**带着分组名**：

```
Canceling since a higher priority waiting request for ci-refs/heads/master exists
```

`ci-refs/heads/master` = `ci-${{ github.ref }}` 展开的结果，也就是**旧的共享分组**。
按 SHA 分组时这里会是 `ci-<sha>`。

成因是一个**我先前没想到、但很要命**的性质：

> **GitHub 用的是「被跑的那个 commit **自己**那份 `ci.yml`」，不是当前 master 的那份。**

所以 §12 那次回退一落地，后面每个提交都**带着旧口径**去跑，于是又开始互相取消。
逐个核过：`7e30d57` / `e43db9a` 自己的 `ci.yml` 里就是 `group: ci-${{ github.ref }}`，
而没被取消的 `f8cc1b7` / `87e14e1` 带的是按 SHA 那版。

按「该提交自己带的口径」分组重新量（最近 60 次 run）：

| 该提交带的口径 | run 数 | cancelled | 比例 |
| --- | --- | --- | --- |
| **按 SHA** | 17 | **0** | **0.0%** |
| 共享 ref | 43 | 17 | 39.5% |

**按 SHA 那一档 0 取消**，17 次取消**全部**落在共享 ref 那一档。
回退窗口约 16:52–17:08，5 个提交带着旧口径，其中 2 个丢了判决；`52220e2` 之后恢复。

逐条排除（不是猜）：

- **有人手动 `gh run cancel`** → 排除。手动取消不会产生上面那行注解；
  且 `actor` / `triggering_actor` 都是推送者本人，没有第三方取消动作。
- **force-push / 提交被 rebase 掉** → 排除。两个 SHA 都在 master 上，注解也写明了原因。
- **GitHub 侧排队/资源策略** → 排除。注解明确指向 concurrency 分组。
- **某个 job 内部自己退出被记成 cancelled** → 排除。`Format check` 那个 job 是
  **success**，被取消的是还在跑的 `gate`，且带上述注解。

#### ⚠️ 一条要更正的更正

你提醒我别把「被后续推送取消的」当线索，说那是用改动前的模型解释改动后的现象。
**实际上那位作者是对的** —— 对**他那个提交**而言，生效的确实是旧口径，
后续推送确实杀了他那跑。**错的前提是"按 SHA 已经在生效"**，而它当时已经被我回退了。
他的申报是准确的，不该被当成错误前提。

#### 这件事本身又是同一个病的新变种

「配置在 master 上是对的」**不等于**「跑起来用的是它」——
中间隔着"这个提交里那份文件长什么样"。我核配置时看的是当前 master，
于是得出"分组是独占的"这个错误结论。**又一次看了错的东西然后相信自己是安全的。**

⚠️ 残留：`lint-workflows` 那 3 条断言能让**回退口径的提交变红**，
但那个提交**仍然会带着旧口径跑一次**，并且可能在那一次里取消掉别人的 run。
门禁能保证"回退会被发现"，不能保证"回退不产生任何后果"。

### 14. 「不许整文件重写」这条规矩的适用范围 = **所有共享的结构化配置文件**

原来这条是就着 locale 说的。**范围写窄了** —— 今天出事的三次里，有一次落在 `ci.yml`
（我自己那次），而 `ci.yml` 不是 locale。**病是按「操作方式」发作的，不是按文件类型。**

**规矩（适用于共享工作树 `/root/memo` 里的所有人）：**

> **对任何共享的结构化配置文件，只做行级增删改；
> 不许"读进来 → 在内存里改 → 整份写回"。**

**适用对象**（不是穷举，判据在下面）：

- `apps/web/src/app/i18n/locales/*.json`（locale）
- `.github/workflows/*.yml`（workflow）
- `package.json` / `pnpm-workspace.yaml` / `tsconfig*.json`
- `scripts/*-baseline.json`、`scripts/locale-allowlist.json` 等棘轮名单
- `.prettierignore` / `.gitignore` / `eslint.config.js`

**判据（比清单重要）：** 只要一个文件满足
**「多个 agent 会各自往里加东西」+「整份重写在语法上完全合法」**，它就在范围内。
这两条一凑齐，就出现那个致命性质：**你把别人刚加的东西覆盖掉，
不报错、不冲突、git 也不提示** —— 只有碰巧有人读到中间态才暴露。

**具体禁止的姿势**（三次事故用的都是这个）：

```
读整份 → JSON.parse / yaml.parse → 改对象 → 整份 stringify 写回
读整份 → python/node 字符串替换 → 整份写回        ← 我那次
```

**替代姿势：** 用 `Edit`/`sed` 做**定点行级**修改；改完 `git diff --stat` 看一眼
**增删行数是不是和你以为的一样**（我那次 `-50` 就在 `--stat` 里明明白白，我没看）。

⚠️ **额外一条，来自我自己那次**：如果你在**独立 worktree** 里改过共享文件，
主工作区那份**不会跟着变**。落地之后要么回主工作区确认内容一致，
要么后续改动继续在同一个 worktree 里做。否则你下一次 read-modify-write
读到的就是**旧版**，然后把自己刚做的改动整段写回去 —— 这就是 `e64de10`。

**机器兜底目前只覆盖三种文件**：locale（`check:locale`）、测试文件（`check:test-ratchet`）、
`ci.yml` 的并发口径（`lint-workflows` 3 条断言）。**其余全靠上面这条纪律。**
别把这三道守卫读成"配置文件都有人看着了"。

### 15. ⚠️ 一个**没人看着**的盲点：三道守卫都只查存在性，不查实质

**这一节不是"我们检查过了没问题"。是"我们知道这里没人看，并且量过为什么暂时不建灯"。**

#### ① 盲点确实存在

- 测试文件棘轮：只看**路径还在不在**。把 `platformUnsupported.test.ts` 截成
  `export {};` —— 五条判据**全绿**。
- locale 守卫：只看 **key 集合**。把每条翻译的值都换成空字符串 —— **全绿**。
- 契约字段门禁：只看**目录下有没有读取**。把卡片渲染换成 `{null}` —— **全绿**
  （另一路实测过）。

三道都在问「它还在吗」，没有一道在问「它还有牙齿吗」。

#### ② 量过了：当前没有便宜的机器判据

最显而易见的候选是**断言总数棘轮**。`[实测]` 758 个提交：

| 口径 | 触发次数 | 误报 | 真阳性 |
| --- | --- | --- | --- |
| 严格「总数不许下降」 | 3 | **2（67%）** | 1 |
| 弱化「某文件掉到 0」 | **0** | 0 | 0 |
| 弱化「某文件掉破 50%」 | **0** | 0 | 0 |

而那**唯一一次真阳性**（`31d3ae3` 整文件删除）**已经被现有的测试文件棘轮抓到** ——
也就是说严格口径 = **零边际收益 + 2 次误报**；弱化口径 = **零噪音也零信号**，
建了和没建在行为上无法区分，只多出一层维护面和一个"这里有人看着"的错觉。

更要命的是总量口径**结构性地漏**：历史上 3 次测试文件删除，它只抓到 1 次，
另外 2 次被**同一提交里的新增**掩盖掉了（`6dcae5a` 删掉一个 44 条断言的文件，
总数反而涨了）。按文件计存在性的现有形状**免疫**这种掩盖 —— 这反过来说明
现在这道守卫的形状是对的，而这个候选不是。

**并且前提本身不成立**：`[实测]` 758 个提交里，**「文件还在但内容被掏空」
（>60% 字节缩水）一次都没发生过**；放宽到 >30% 只有 1 例，且是合法的去重搬家。

结论：**不建。** 一道天天为合法工作亮的灯，比一个诚实的空缺更坏 ——
它会先训练所有人忽略它，然后连它旁边那些真判据一起被忽略。

#### ③ 将来什么条件下值得重估

出现下面**任意一条**就该把这节拿出来重算，别等"感觉该做了"：

1. **真出事一次**：出现一次「文件还在、断言被删光/改成永真」的事故 ——
   届时基础发生率不再是 0，收益侧的数就变了。
2. **有了更细的口径**：例如按 AST 数「有效断言」（能区分"3 条弱断言合并成 1 条强的"
   与"删掉 2 条"），把今天 67% 的误报压下去。今天用正则数出来的量做不到这件事。
3. **突变检查那一档进了常规通道**：`mutation-check` 完整档才是真正回答
   "改坏了会不会红"的东西。它一旦有了自动调用方，这个盲点就被从另一侧堵上了，
   这里也就不必再单独建灯。

#### ④ 顺带：那 62 个"裸奔"文件，量完发现**大部分并不裸奔**

审计里我说有 62 个可执行测试/守卫文件不在任何棘轮射程内。**量完要收回一半**：

- `[实测]` 762 个提交里，这批文件的删除/改名事件 **= 0**。把棘轮扩过去
  会是**零触发**：0 真阳性、0 误报、**零信号**，代价是基线多 52 条、
  在 9 个 agent 共用的那份 JSON 上把冲突面再抬约 40%。
- **17 个 selftest 全部已经被硬保护**：它们逐个按名字写在 `test:ci-scripts`
  的 `&&` 链里，删任何一个 → `ERR_MODULE_NOT_FOUND` → 退出码 1。
  而且 `lint-workflows` 还钉住了其中 6 条**调用行本身**（"没被跑到的自检等于不存在"）。
  **比棘轮更强** —— 棘轮只说"文件没了"，这个连"文件在但没人跑"都挡。
- `apps/web/src/test/host.tsx` 由**编译期解析**保护：三个 `.test.tsx` 相对 import 它，
  它没了 → SSR 构建解析不到 → `pnpm -r test` 当场红。
- `apps/web/src/__smoke__/render.tsx` 反过来 —— 它**本来就是零引用**
  （已在 `orphan-exports-baseline.json` 里挂着），给它上棘轮等于**把死代码钉死**。

真正**一点保护都没有**的是 **14 个**：`check-contract-fields-shown.mjs`（本轮已接上）、
6 个 `apps/daemon/scripts/e2e-*.mjs`、4 个 `packages/downloader/scripts/e2e-*.mjs`、
`e2e-allcomponents-assertions.mjs`、`proxy-coverage-audit.mjs`、`__smoke__/render.tsx`。
**而它们也从没被删过**（0/0）。所以正确的修法不是第二份 JSON 基线，
而是**用已经证明有效的那个机制**：把它们按名字写进一条真的会跑的链。
