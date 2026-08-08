# inbox / ui-polish

## [2026-08-03 13:20] T-101 DONE

交付:

- `docs/design/D-09-ui-gap.md`（TL;DR + 逐页对比表 + 截图路径）
- `apps/web/src/components/common/JobToaster.tsx`（新增，全局安装/下载反馈层）
- `apps/web/src/app/i18n/locales/{zh-CN,en}.json`（`progress.*` 四个下载阶段 + `jobToast.*` + `health.restart*`；两份 key 数已校验相等 484/484）
- `apps/web/src/App.tsx`、`apps/web/src/index.css`（见下方 SHARED-CHANGE）
- `apps/web/src/components/common/AsrModelPicker.tsx`、`.../HealthBanner.tsx`
- `apps/web/src/features/recorder/RecorderPage.tsx`
- `apps/web/src/features/runtime/{RuntimePage.tsx,components/BackendPackCard.tsx,components/HardwareCard.tsx}`
- 截图（仓库外）：`/tmp/ui-polish/shots/{before-light,before-tall,after-light,after-tall,after-dark,interaction,after}/`
- memo.ac 取证（仓库外，未向仓库复制任何专有源码/资源）：`/tmp/ui-polish/memoac-visual.md`

要点:

- 用户点名的两处提示，成因是**实测出来的**不是猜的：点「安装后端包」后 5 次采样（+150/400/1000/2500/6000ms）按钮文案不变、页面新增文本恒为空数组 —— **6 秒零反馈**；模型页滚到第 4 张卡再点，「下载中」区块实测 `top=-297px`（视口外）。改后：**+200ms 出现 toast**，滚动场景 `top=777` 在视野内。
- 五阶段文案落地，`verifying` 明说"进度条不动是正常的，不是卡死"；`blocked` 不画成红色错误；装完按**模型 / SQLite 扩展 / 后端包**三类给不同出口。
- 「装完的假成功」已修：实测 `restartRequired.required=true` 而 `libsimple=false` → toast 渲染「已装好，但需要重启本地服务才会生效 · [立即重启]」，**按钮端到端跑通**。
- 逐页差距前三（均已修）：`/runtime` 密度（14 张等重卡 → 5 张 + 1 行折叠，页高 4047→~2100px）、`/onboarding` 套在完整外壳里（→ 无外壳）、原生表单控件裸奔（→ `@layer base` 统一，暗色已验）。
- `tsc -b` 通过；`eslint --max-warnings=0` 通过；`apps/web` 测试 90 项 / 0 失败。

下一步建议:

- `/settings` 五个子路由目前渲染同一张长页（D-05 §1.2 规定各自独立）—— 请指派 T-021/architect。
- `/models` 与 `/runtime` 正文全硬编码中文不走 i18n，英文用户会看到"英文外壳 + 全中文正文"—— 请指派 T-022。
- 若 `model-mgmt` 能构造 `verifying` / `blocked` 状态样本，我去补一次真机验证（目前这两态标记为未跑通）。

需要 Manager 决策:

1. **🚨 见下方 BUG 条目（daemon 自我重启劫持 `--data-dir`）—— 这条最急，直接威胁用户的 `:10000` 实例。**
2. `components/common/HealthBanner.tsx` 已成死文件（T-107 的 `ReadinessBanner` 接管挂载点并吸收了我的 `restartRequired` 分支与 `health.*` 词条）。我不删别人挂载链路上的历史文件，请裁决由谁清理。
3. `/settings` 的「主题」下拉仍显示未翻译的 `system / light / dark`——`<option>` 文案硬编码在 `SettingsPage.tsx`，需该文件 owner 配合。

---

## [2026-08-03 13:20] SHARED-CHANGE（先申报后改，已改）

- `apps/web/src/App.tsx` —— ① 挂载 `<JobToaster/>`；② `/onboarding` 走无外壳布局（首启第一屏不该同时出现三条降级条幅和一整列还用不上的导航，与"每一步都可以跳过"矛盾）。
  ⚠️ 期间 T-107 也在改本文件（`HealthBanner`+`SecureContextBanner`+`multiTab` 合并为 `ReadinessBanner`）。**两边改动已确认共存，无覆盖**：我复读了合并后的文件，`JobToaster` 与 chromeless 分支都在，`ReadinessBanner` 也在。
- `apps/web/src/index.css` —— ① `@layer base` 统一原生 `select`/`checkbox`/`radio`（当前完全裸奔，是"最像半成品"的一处，且与业务逻辑无关）；② 把 D-05 §7.4 早已规定的"正文行高 1.6"真正落到 `--text-*--line-height`（此前 tokens 里写了但没有任何一处生效）。**字号一个都没动。**
- `apps/web/src/features/runtime/**` 三个文件（呈现层，Manager 分派时明示"各 feature 的呈现层"归我）：折叠不适用的包、按钮上提到标题行、探测报错收进 `<details>`。**未碰任何 mutation / API 调用 / 业务判定。**
- `apps/web/src/features/recorder/RecorderPage.tsx:303` `showModel={false}` → `showModel`（Manager 转达的分工：由我改，`architect` 请勿重复动）。

---

## [2026-08-03 13:20] BUG（daemon，非我职责，请转派）

**自我重启会用机器全局指针文件劫持命令行 `--data-dir`。**

`[实测]` 我的实例以 `--data-dir /tmp/ui-polish-data2` 启动，点新加的 `[立即重启]` 后：

```
[daemon] 自我重启（user-requested）…
[daemon] 数据目录已变更，重启参数由 /tmp/ui-polish-data2 改为 /tmp/t106-real
[daemon] 新进程 pid=2199648 已就位，本进程退出
```

同一个 daemon 对同两个输入有**两条相反的优先级规则**：

| 位置                                      | 规则                                                  |
| ----------------------------------------- | ----------------------------------------------------- |
| `apps/daemon/src/main.ts:131`（正常启动） | 冲突时日志明说"**本次使用 `opts.dataDir`**"——命令行赢 |
| `apps/daemon/src/main.ts:750`（自我重启） | 指针文件 ≠ argv 值 → **改写 argv**——指针文件赢        |

指针文件是机器全局的 `~/.local/share/openmemo/datadir.json`，当前内容 `{"dataDir": "/root/data-memo"}`，
本次会话中已被不同 agent 改过至少两次。

**后果**：任何带显式 `--data-dir` 的实例一旦自我重启就会跳到该文件当时指向的目录。
**包括用户正在用的 `:10000`（`--data-dir /tmp/omdemo`）** —— 会跳到 `/root/data-memo`，
用户看到的是"笔记全没了"，而数据其实好端端在 `/tmp/omdemo`。

`main.ts:741` 的注释说明了改写 argv 的本意（搬完家不能回到被搬空的旧路径，这是对的），
缺的是**区分"指针变了是因为这个实例刚搬过家"与"全局指针本来就指向别处"**。

建议（不是我能改的）：只在**本进程这次运行期间真的执行过数据目录迁移**时才改写 argv。
**在修好之前，`[立即重启]` 对带 `--data-dir` 的实例是有风险的动作** ——
若 Manager 认为风险大于收益，我可以先把该按钮降级为"提示手动重启"，说一声即可。

---

## [2026-08-03 13:20] 环境收尾

- 我起过的进程：daemon `--port 17901 --data-dir /tmp/ui-polish-data`（pid 2163138）、
  daemon `--port 17902 --data-dir /tmp/ui-polish-data2`（pid 2185661 → 自我重启为 2199648）、
  vite `--port 5199`（pid 2163443/2163460/2186563）。
  **均已按 pid 逐个 `kill`，全程未使用 `pkill -f`。**
- 用户的 `:10000` 实例**全程只读**：只做过页面读取，未重启、未改数据、未对其发起任何写请求。
- 截图与取证产物全部写在 `/tmp/ui-polish/`（仓库外），`git status` 不受影响。

---

## [2026-08-03 13:20] 派生 agent 记录（供复用）

- `agentId ab33a8a621c119497`（sonnet5）—— memo.ac v1.7.5 解包产物的视觉语言取证，产出 `/tmp/ui-polish/memoac-visual.md`（333 行，每条标注来源文件与 grep 命令）。已完成，未 kill。

---

## [2026-08-03 15:50] T-114 DONE — 配色体系

交付:

- `docs/design/D-09-ui-gap.md` **§7（追加，未动 §0–§6 一个字）**：memo.ac 色板取证补完 / 旧色板不达标实测 / 新四层令牌 / 对比度实测表 / 状态色判定表 / 补验记录
- `apps/web/src/styles/tokens.css`、`apps/web/src/index.css`（**共享区，见下方 SHARED-CHANGE**）
- `apps/web/src/styles/tokens.contrast.test.ts`（新增）+ `apps/web/tsconfig.test.json` 登记一行
- `apps/web/src/components/common/statusTone.ts`（新增，状态→tone 唯一判定表）
- `apps/web/src/components/common/{StatusChip,ProgressMeter,BackendChip,ReadinessBanner,JobToaster,AsrEngineStatus,AsrModelPicker,Button}.tsx`
- `apps/web/src/features/{tasks/JobList,models/components/ModelCard,models/components/DownloadRow,settings/DataLocationSection,settings/PurposeBindingsSection,notes/TimeAnchor,onboarding/OnboardingPage}.*`
- `apps/web/src/app/i18n/locales/{zh-CN,en}.json`（`jobState.*` 8 条 + `jobToast.blocked*` 3 条，两份 key 已校验对称）
- 截图（仓库外）：`/tmp/ui-polish/shots/{palette-light,palette-dark,cmp-*,toast-verifying,toast-blocked}.png` + `c-before-{light,dark}/` `c-after-{light,dark}/`
- 取证/记录（仓库外）：`/tmp/ui-polish/memoac-color.md`、`status-inventory.md`、`contrast-report.txt`

要点:

1. **上一轮写的"本次未新增颜色编码，因此未跑对比度脚本"这条前提，这轮被实测推翻了。** 旧色板**两个主题里都有不达标项**，而且不达标的是最要紧的几处：**主按钮文案** 明 4.42 / 暗 3.64；`text-warning` 明档 **1.74**（等于看不见）；`text-good` 3.18；`text-serious` 2.50；`text-accent` 4.19；`text-critical` **暗档 3.62**；`--ink-muted` 明档 3.41；进度条 warning 填充 vs 轨道 **1.39**。
2. **成因一句话**：这套色是按「图表记号」的 3:1 线选的，而应用把它们当「文字」用（54 处 `text-*`），文字线是 4.5:1。D-05 §7.2 记的"配图标缓解"在"只当记号"的前提下成立，**前提换了、结论没跟着换，而且没有任何东西会报错**。
3. **改法**：每个语义色拆四层 —— `--status-X`（**锚点，D-05 §7.2 原值一个没动**）/ `-ink` / `-tint` / `-line`，另加 `-solid`（白字压在上面）。ink/tint/line **必须随主题变**。新增第 5 个语义位 `info`（此前"品牌主色"与"进行中状态色"共用 `--accent` 一个变量）。
4. **校验进 CI**：`tokens.contrast.test.ts` **从 tokens.css 现场解析**（不抄常量），**64 对实测 / 14 用例 / 全过**，并断言暗色两个作用域逐字相同（那两块是手工重复的）。
5. **状态色收进一张表**（`statusTone.ts`）。判据：**色相编码"要不要你管、急不急"，不是"好坏排名"**。由此「已安装」与「使用中」同为绿，靠 ✓/⚡ 区分 —— 正好落实 `StatusChip` 那条"永远同时给图标与文字"。修掉三条互相矛盾的旧写法（ModelCard 绿/蓝 vs BackendChip 灰/绿**恰好互换**；DownloadRow 同卡内 verifying 芯片蓝/进度条绿；JobList 唯一漏掉 verifying 且 fallback 露枚举值）。
6. **发现并修掉一个死令牌**：`text-success` **从来不存在**（`@theme` 里只有 `--color-good`），两处用它的地方渲染出来是**无色**的（`AsrEngineStatus.tsx:121`、`DataLocationSection.tsx:259`）。Tailwind 对不存在的类不报错。
7. **上一轮的两个 `[未跑通]` 都跑通了**（详见下方"补验"条目）。
8. `tsc -b` 通过；`eslint . --max-warnings=0` 通过；`apps/web` 测试 **110 / 108 通过 / 0 失败 / 2 skipped**。

下一步建议:

- `architect`：是否把 §7.3 的令牌表回写进 D-05 §7.2/§7.5（我不改别人的交付物）。**D-05 §7.2 的"四个锚点不随主题变"仍然成立**，新增的三层是随主题的。
- `model-mgmt`：`/models` 25 条平铺要做双轴卡片，**缺 `speedTier` 字段**（R-06 附录 B 已定论）。给了字段我就能做呈现层。
- `serious` 一档本机构造不出真实场景，**标 `[未跑通]`**，谁能构造请在 inbox 说一声。

需要 Manager 决策:

1. **见下方 BUG 条目：`job.blocked` 的 toast 分支此前在真实运行中不可达 —— 我已在前端兜住，但根因在契约层，需要裁决是否补 shared 的流水线 job 表示。**
2. D-05 §7.2 的回写归属（见上）。

---

## [2026-08-03 15:50] SHARED-CHANGE（先申报后改，已改）

- `apps/web/src/styles/tokens.css` —— **架构上属 `architect` 的交付（D-05 §7.5 指定）。**
  改动：① 新增 `--status-{good,warning,serious,critical,info}-{ink,tint,line}` 与两个 `-solid`；
  ② `--accent` 拆成块面色 `--accent` + 文字色 `--accent-ink`；③ `--ink-muted` / `--line` 明暗两档各补足一档。
  **`--status-{good,warning,serious,critical}` 四个锚点、`--surface-0/1/2`、`--data-1..4` 一个都没动** ——
  图表色板的六项校验是对着这些表层跑的，动了就得全部重跑，而它们本身没问题。
  依据是实测数值不是偏好，全部写进 D-09 §7.2/§7.4，并有 CI 断言兜底。
- `apps/web/src/index.css` —— `@theme inline` 转发新令牌；**`--color-good` 等重定向到 ink 档**
  （仓库里 54 处 `text-{good,warning,...}` 全是文字/图标，重定向后 54 个调用点一行不用改就达标；
  需要实心块+白字的 2 处改用 `bg-{good,critical}-solid`）。
- `apps/web/tsconfig.test.json` —— 加一行，把新测试登记进 `include`（该文件是显式白名单，不加就编出 0 个测试 = 假绿灯）。
- 全仓 `text-accent` → `text-accent-ink`（26 处，机械替换，`text-accent-fg` 用负向匹配避开）。

⚠️ **并发提示**：本轮期间 `apps/web/src/components/common/AsrModelPicker.tsx` 与
`features/recorder/RecorderPage.tsx` 有别的 agent 在同时改（`useActiveAsrModel` / `rerunModelLabel`）。
我的改动与之**共存无覆盖**（我复读过合并后的文件）。期间 tsc 一度报
`RecorderPage.tsx: Cannot find name 'ASR_ENGINE_LABELS'` —— **不是我的改动**，
对方随后自行修好，我**没有碰**那个文件的那几行。

---

## [2026-08-03 15:50] 补验（上一轮的两个 `[未跑通]`）

**① `verifying` —— 跑通。** 真下 874 MB 的 `asr/whisper-large-v3-turbo-q8_0`：

```
t=+180000ms  正在校验完整性 · 874 MB / 874 MB
             文件已下完，正在逐字节核对 SHA-256。大模型这一步要几十秒，进度条不动是正常的，不是卡死。
t=+180600ms  已安装 · 已可直接使用，去捕获页粘一个链接就能转写。| [查看模型] [去转写]
```

截图 `/tmp/ui-polish/shots/toast-verifying.png`。

**② `blocked` —— 跑通，但过程中发现它此前根本不可达。** 见下方 BUG。

---

## [2026-08-03 15:50] BUG（契约层，已在前端兜住，根因需裁决）

**`job.blocked` 的 toast 分支在真实运行中不可达 —— 后果是一条零报错的卡住。**

`[实测]` 没装 ASR 模型时 `POST /api/notes/import` → **202**，笔记停在 `processing`，**页面上一个字都没有**。

| 环节                           | 事实                                                                                                                                                                                                                                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `job.blocked` 的发送方         | **只有** `apps/daemon/src/jobs/runners/{transcribe,mindmap}.ts`                                                                                                                                                                                                                           |
| 这两类 job 发 `job.created` 吗 | **不发，且是刻意的** —— `apps/daemon/src/jobs/events.ts:15-24` 与 `http/rest/notes.ts:239` 都写着：`JobCreatedEvent` 要求一个完整的 `DownloadJob`（`kind`/`totalBytes`/`parts`/`fileIndex`…），转写/导图 job **填不进那个形状**；注释里已写"已报 Manager：shared 需要补流水线 job 的表示" |
| `JobToaster.upsert`            | "没见过 `job.created` 就不补建 toast"（防止刷新页面时补建历史 toast）                                                                                                                                                                                                                     |

三条**各自都对**，合起来 = blocked 分支永远不会触发。**这类"三个正确的局部决策拼出一个错误的整体"正是最难被任何单方发现的缺陷** ——
三个文件分属三个 owner，每个 owner 看自己那份都没问题。

**我这一侧已修（不动契约）**：`JobBlockedEvent` 本来就带齐了要紧的两件事（`messageZh` 为什么停、`remediation` 怎么办），缺的只是标题；
按 `blockedCode` 给一个通用名即可（未知 code 落到"后台任务已暂停"，宁可笼统也不编一个具体但可能是错的名字）。
修后 `[实测]` `t=+400ms` 出现「暂时无法继续 · 转写任务已暂停 / 尚未安装语音识别模型 / 这不是失败，条件满足后会自动继续。/ [去安装语音识别模型]」，
截图 `/tmp/ui-polish/shots/toast-blocked.png`。

**请 Manager 裁决**：要不要按 daemon 注释里已提的方案补 shared 的流水线 job 表示（那样 toast 能显示真实笔记标题，
`/tasks` 也能列出转写任务 —— 目前 `/api/jobs` 只返回下载类 job，转写任务在任务中心里**同样看不到**）。
在补上之前，我这层是可用的兜底，不是替代品。

---

## [2026-08-03 15:50] 环境收尾

- 我起过的进程：daemon `--port 17903 --data-dir /tmp/ui-polish-data3`（pid 2273208→2273211，后为 2303598）、
  vite `--port 5198`（pid 2273547）。**均按 pid 逐个 `kill`，全程未用 `pkill -f`。**
- 用户的 `:10000` 实例**全程只读**：未重启、未改数据、未发任何写请求。
- 期间为构造 `blocked` 真样本，**只对我自己的 `/tmp/ui-polish-data3`** 做过一次"把 models 目录挪走再挪回"，已还原。
- 曾为截配色总览板临时放过 `apps/web/public/__ui-polish-board.html`，**已删除，`public/` 目录也已移除**（仓库无残留）。
- 所有截图与取证产物写在 `/tmp/ui-polish/`（仓库外）。

---

## [2026-08-03 19:45] T-124 DONE — 表层与品牌配色（"看得出来变了"）

### TL;DR

1. **表层动了，四个位置的像素值都可复现** `[实测]`（同一台 Chromium、同一份数据、同两页取样）：
   页底 `#f9f9f7→#edf0f5`（暗 `#0d0d0d→#14161d`）、卡片/侧栏/顶栏 `#fcfcfb→#ffffff`（暗 `#1a1a19→#242732`）、
   侧栏选中项 `#ffffff→#e2e4fa`（暗 `#242422→#2a2e5c`）、主按钮 `#2570cd→#575bc7`（暗 `#6268d5`）。
2. **取值照 memo.ac 收敛，不是自由发挥** `[取证]`：`--color-bg-content #f1f5f9` / `--color-bg-element #ffffff`
   （暗 `#181921`/`#272934`）、品牌 `#575bc7` 用的是它的**原值**。
3. **对比度校验没被放松，从 64 对加到 88 对，全过。** 新增的 24 条正是"两块背景之间没有差"这类缺陷的判据
   （表层可分辨、淡底 vs 表层、**半透明 hover/active 合成之后**的底与压在上面的文字）。
   新阈值 1.06 **明确标注为本仓库自定、不是 WCAG**。
4. **新断言当场抓到两处不达标，改的是颜色不是阈值**：`--ink-muted` 压在按下态上明 4.17 / 暗 3.91
   → 收紧 ink-muted + active 填充 10%/12%→9%/10% → 两档都 4.57。
5. **暗档面色的上限是被 3:1 卡死的**：面亮到 `#262a36` 时主按钮块面与 critical 实心块**同时**跌到 2.98:1，
   所以最终停在 `#242732`（比 memo.ac 的 `#272934` 略深）。**颜色让位判据。**
6. 修掉三处"看不见的交互态"：hover 18 处（明档实测 **1.02:1**）、侧栏选中（同色于 hover）、量化选择器选中行。
7. **副产品**：选中态一变醒目，立刻暴露侧栏「全部笔记」与「星标」**永远同时高亮**（`NavLink` 不比查询串）。已修。
8. `tsc -b` 0 · `eslint apps/web/src` 0 · `apps/web` 测试 **124 项 / 122 通过 / 0 失败 / 2 skipped**。

交付:

- `docs/design/D-09-ui-gap.md` **§8（追加，§0–§7 一个字没改）**：改动量复盘 / 新令牌表 / 逐条改动量与实测 / 新断言 / 调用点 / 两个别人家的 bug
- 代码（**精确文件清单见下方"提交清单"，22 个文件，全部在 `apps/web/src` 内**）
- 截图（仓库外）：`/tmp/ui-polish/t124/{before,after,cmp}/` —— `cmp/` 是**前后并排**（左 BEFORE 右 AFTER），明暗各 4 张
- 实测记录（仓库外）：`/tmp/ui-polish/contrast-report-t124.txt`（88 行 PASS / 0 FAIL）、`palette.py`（色板计算器）、`shot.cjs` / `shot-popover.cjs`

要点:

- **上一轮不是做错了，是范围选窄了。** T-114 的 diff 里表层改动**是 0**，而界面上占面积最大的就是表层
  —— 所以"配色改了但看不出来"是必然结果，不是错觉。§7.9 当时白纸黑字写了"表层与 data 色没动"及其理由
  （图表色板的六项校验是对着旧表层跑的）。本轮不是推翻那个理由，是**付掉它的代价**：动表层 → 重跑校验 → 该调的调。
- **明暗两档现在都只有两级表层**（`--surface-2 == --surface-1`），弹层靠阴影+描边抬升。
  明档是因为卡片已经是纯白（没有更亮的一档，memo.ac 同样只有两档）；暗档是因为再亮就压不住 3:1。
  已在 `features/README.md` 的令牌速查里写清"**不要再用表层差一档表达 hover/选中**"。
- `--accent-track` 更名 `--accent-tint`（6 处类名）：T-114 之后进度条轨道已改用 `--status-*-tint`，"track"这个名字不成立了。
- **品牌换靛紫还有个语义收益**：旧的 accent 蓝与 info 蓝、`--data-1` 蓝是同一族，品牌色没有信息量。
  现在 **靛紫 = 品牌与可点，蓝 = 正在发生**。
- **`/models` 的 IA 复验**：Tab 两个都在、`?tab=` 进 URL、「当前使用」两行都渲染 —— **正常**。
  但发现一个 bug，见下方 BUG 条目 ①。

下一步建议:

- **`apps/web/dist` 需要重建才能让 `:10000` 看到最终状态。** `[实测]` 当前 dist（19:33 构建，不是我建的）
  **已经含新配色 CSS**（grep 到 `#edf0f5`/`#575bc7`/`#242732`/`--fill-hover`，旧的 `#f9f9f7` 已消失），
  但**不含 19:35 之后的两处改动**：侧栏高亮修复（App.tsx）与 `<select>` 底色（index.css）。
  重建命令 `pnpm --filter @openmemo/web build`。**我没跑，也没碰那个实例** —— 由 Manager 决定时机。
- `model-mgmt`：`speedTier` 到位后叫我，`/models` 双轴卡片我接着做（本轮 25 条平铺按吩咐保持现状）。
- `architect` / Manager：D-05 §7.1/§7.2 的回写（见下方"需要 Manager 决策"）。

需要 Manager 决策:

1. **D-05 §7.1（表层与墨色）、§7.2（品牌）两张表已经与代码不一致，请裁决回写。** 详见 SHARED-CHANGE 条目。
2. dist 重建时机（见上）。
3. 两个别人家的 bug 该派给谁（见 BUG 条目）。

---

## [2026-08-03 19:45] SHARED-CHANGE / 规则变更申报（先申报后改，已改）

**① `apps/web/src/styles/tokens.css`（架构上属 `architect`，D-05 §7.5 指定）**
表层、墨色、品牌三组值全部重写；四个状态锚点 `--status-{good,warning,serious,critical}`
与 `--data-1..4` **一个字没动**。新增 `--fill-hover` / `--fill-active`，`--accent-track` 更名 `--accent-tint`。

**② 与 D-05 的冲突：我选择"改文档"而不是"绕过"，但不改别人的交付物。**
Manager 的指示是「要么改规则要么守规则，别偷偷例外」。D-05 §7.1/§7.2 是 `architect` 的交付物，
PROTOCOL §1.3 又规定"绝不修改他人的交付物"。两条同时满足的做法是：
**把新规则写进我自己的交付物 D-09 §8，并在文件头与本条目里明写"§8 取代 D-05 §7.1/§7.2 的对应表"，
然后请 Manager 裁决回写。** 我没有偷偷例外，也没有代替 architect 改他的文档。
（`tokens.css` 文件头第 61–67 行写明了这条关系，任何人打开文件就能看到，不用去翻 inbox。）

**③ `apps/web/src/index.css`** —— 转发 `--color-fill-{hover,active}` / `--color-accent-tint`；
`@layer base` 的 `<select>` 底色 `--surface-1` → `--surface-0`（它绝大多数出现在卡片里，同色等于只剩一条边框；
与同页 `<input>` 已有的 `bg-surface-0` 对齐）。

**④ `apps/web/src/App.tsx`** —— 侧栏选中态改品牌淡底 + 修 `NavLink` 不比查询串导致的双高亮。

**⑤ `apps/web/src/features/README.md`（令牌速查，公共契约）** —— 三条更新：
表层只剩两档、hover/选中改用 `bg-fill-hover` / `bg-accent-tint`、补上新令牌名。
**这条必须改**：不改的话，别的 agent 会继续照旧文照抄 `hover:bg-surface-2`，而那个写法现在是明确失效的。

**⑥ 18 处 `hover:bg-surface-*` → `hover:bg-fill-hover`，6 处 `bg-accent-track` → `bg-accent-tint`**
（机械替换，跨 8 个 feature 文件，均为呈现层类名，未碰任何逻辑）。

⚠️ **并发提示**：本轮期间 `apps/web/dist` 被别的 agent（或 Manager）在 19:33 重建过一次，
当时我的 `tokens.css`/`index.css` 已落盘、`App.tsx` 还没改完 —— **产物因此是个中间态**（恰好无害，
但下次谁重建 dist 前最好先看一眼有没有人正在改前端）。我**没有**碰 dist，也没有碰 `:10000`。

---

## [2026-08-03 19:45] BUG（**不是我的文件，只报不动**）

**① `/models?tab=llm` 时 Tab 切换条自己消失了。** `[实测]`
`apps/web/src/features/models/ModelsPage.tsx:285` 整段 `<section className={tab === 'asr' ? … : 'hidden'}>`，
**而两个 Tab 按钮就写在这个 section 里面**（287–305 行）。于是切到「语言模型」之后，
页面上**再没有切回「转写」的控件**（只能靠侧栏「模型」链接绕回默认 Tab）。
修法：把那一条 `<div className="flex rounded-md border …">` 提到 section 外面。
截图 `/tmp/ui-polish/t124/after/light-models-llm.png`。
**我没动** —— 该文件本轮有 `model-mgmt` 在改（`speedTier`），怕撞车。

**② 侧栏「星标」筛选根本没实现。** `[实测]`
`/notes?starred=1` 的标题仍是「全部笔记」，列表也是全部笔记（两条都没加星）。
`grep -rn starred features/notes/NotesListPage.tsx` 只有**渲染星标图标**与**切换星标**，
**没有任何一处读查询参数**。也就是说侧栏那一项点进去和「全部笔记」完全一样。
截图 `/tmp/ui-polish/t124/after/light-notes-starred.png`。属 notes 的 owner。

> 这两条都是**这轮改配色才看见的**：①以前 Tab 条不显眼没人注意切不回去；
> ②以前侧栏高亮是 1.02:1 的看不见，两项同时"亮"也发现不了，自然也没人去点。

---

## [2026-08-03 19:45] 提交清单（**请勿 `git add -A`**，本轮我的改动只有这 22 个文件）

```
apps/web/src/styles/tokens.css
apps/web/src/styles/tokens.contrast.test.ts
apps/web/src/index.css
apps/web/src/App.tsx
apps/web/src/features/README.md
apps/web/src/components/common/Button.tsx
apps/web/src/components/common/JobToaster.tsx
apps/web/src/components/common/PanelBoundary.tsx
apps/web/src/components/common/ProgressMeter.tsx
apps/web/src/components/common/StatusChip.tsx
apps/web/src/components/common/llm/LlmSettingsSection.tsx
apps/web/src/features/capture/CapturePage.tsx
apps/web/src/features/components/components/ComponentCard.tsx
apps/web/src/features/folders/FolderTree.tsx
apps/web/src/features/models/components/QuantSelector.tsx
apps/web/src/features/models/components/StorageBreakdown.tsx
apps/web/src/features/notes/ExportMenu.tsx
apps/web/src/features/notes/NoteEditor.tsx
apps/web/src/features/notes/NotesListPage.tsx
apps/web/src/features/notes/TagEditor.tsx
apps/web/src/features/search/SearchPage.tsx
apps/web/src/features/transcript/SegmentRow.tsx
apps/web/src/features/transcript/WordHighlight.tsx
docs/design/D-09-ui-gap.md
```

（`git status` 里同时还有 daemon / downloader / shared / vendor 的改动，**那些不是我的**。）

**我没有 commit** —— PROTOCOL §0 写着 Manager 是唯一合并者。

---

## [2026-08-03 19:45] 环境收尾

- 我起过的进程：daemon `--port 17910 --data-dir /tmp/ui-polish-data4`（pid 2562646）、
  vite `--port 5196`（pid 2579661/2579663）。**均按 pid 逐个 `kill`，全程未用 `pkill -f`，已确认全部退出。**
- 临时数据目录 `/tmp/ui-polish-data4` 已删除。它是 `/root/data-memo` 的**部分拷贝**
  （db + media + runtime + bin，74 MB），`models/` 用的是**软链**（只读，从未写入），
  删除时先删链再删目录 —— 已复核 `/root/data-memo/models` 仍在、`/root/data-memo` 仍是 514 MB。
  **未拷贝 `secrets.json`。**
- 用户的 `:10000` 实例**全程只读**：未重启、未 kill、未占用该端口、未发任何写请求；
  收尾时复核 `/api/health` 仍是 200。**我也没有重建 `apps/web/dist`。**
- 指针文件 `~/.local/share/openmemo/datadir.json` **未被我修改**（daemon 只在"搬家"接口里写它，
  我用的是 `--data-dir` 且没碰数据位置功能）—— 上一轮报的那条 daemon 缺陷本轮没有被触发。
- 所有截图与取证产物写在 `/tmp/ui-polish/`（仓库外），`git status` 不受影响。

---

## [2026-08-03 19:55] T-124 更正 + 一条**已经发生**的串档事故（追加，不覆盖上面）

**① 上面的"提交清单"要去掉一行。** `apps/web/src/components/common/llm/LlmSettingsSection.tsx`
**已经不在我的未提交改动里了** —— 它被 **`e896e2b`（19:27，T-126「模型选择改真下拉」）** 提交带走了。
`git show e896e2b -- .../LlmSettingsSection.tsx` 里有这两行，那正是我 19:22 做的机械替换：

```
-   activeId === p.id ? 'border-accent bg-accent-track/20' : 'border-line',
+   activeId === p.id ? 'border-accent bg-accent-tint/20'  : 'border-line',
```

**这不是那位 agent 的错**，是"我改了共享区、它同时在提交"这个时间窗的必然结果 ——
和 Manager 说的"第三次同类事故"是同一件事，只是这次方向反过来（**我的改动被别人的提交带走**）。
所以正确的清单是上面那 24 行**去掉这一行**（其余 23 项仍全部未提交、可精确 `git add`）。

**② 由此产生了一个当前 HEAD 上真实存在的悬空引用** `[实测]`：

| 查询                                                                  | 结果            |
| --------------------------------------------------------------------- | --------------- |
| `git show HEAD:.../LlmSettingsSection.tsx \| grep -c bg-accent-tint`  | **1**（用了）   |
| `git show HEAD:apps/web/src/index.css \| grep -c accent-tint`         | **0**（没定义） |
| `git show HEAD:apps/web/src/styles/tokens.css \| grep -c accent-tint` | **0**（没定义） |

也就是说：**现在从 HEAD 干净检出，LLM 服务商卡片的"选中"底色会渲染成——没有底色。**
Tailwind 对不存在的类**不报错**（和上一轮抓到的 `text-success` 是同一种失败模式）。
**我的 `tokens.css` + `index.css` 一落地，这个洞就自动闭合**，不需要额外动作 ——
但在合并之前它是真实存在的，所以写在这里而不是等谁去发现。

**③ PROTOCOL §7（19:28 新增，禁止验证构建覆盖 `apps/web/dist`）我全程遵守**：
本轮**一次 `vite build` 都没跑**（截图用的是 `vite dev` + 我自己的 5196 端口），
`apps/web/dist` 我没写过。当前 dist 是 19:33 别人构建的中间态（含我的新配色 CSS，
不含 19:35 之后的侧栏高亮修复与 `<select>` 底色）——**重建时机仍归 Manager**。
