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

| 位置 | 规则 |
|---|---|
| `apps/daemon/src/main.ts:131`（正常启动） | 冲突时日志明说"**本次使用 `opts.dataDir`**"——命令行赢 |
| `apps/daemon/src/main.ts:750`（自我重启） | 指针文件 ≠ argv 值 → **改写 argv**——指针文件赢 |

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
