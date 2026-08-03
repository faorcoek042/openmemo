---
id: D-09
author: ui-polish
status: ready
date: 2026-08-03
depends_on: D-05（前端规范）, R-06（memo.ac 功能对比）, ADR-002/005（shadcn 豁免区）
---

## TL;DR（≤ 25 行，Manager 只读这里）

- **用户点名的两处提示，成因已用逐帧实测定死，不是"文案不够好"，是"根本没有反馈"。** 点「安装后端包」后逐帧记录页面文本：`t=+150 / +400 / +1000 / +2500 / +6000ms` 五次采样，**按钮文案不变、页面新增文本为空数组** —— 整整 6 秒零反馈，而后台其实已经在下载了（切到 `/tasks` 看得见）。模型页有反馈但**位置错了**：滚到第 4 张卡片点下载，「下载中」区块实测在 `top = -297px`，**在视口外**。
- **结论：反馈是存在的，只是不在用户眼睛所在的位置。** 修法不是改措辞，是**加一层与入口无关的全局 Toast**（`components/common/JobToaster.tsx`，挂在 App 外壳）。实测修后：**+200ms 就出现**「开始安装组件 · 中文分词器 libsimple（linux/x64）／排队中 · 0 B / 5.3 MB／可以离开此页面，安装会在后台继续」。
- **五阶段文案已落地**（`queued→resolving→downloading→verifying→installing`）。其中 **`verifying` 是唯一必须额外解释的一步**：大模型逐字节核对 SHA-256 要几十秒且**进度条不动**，不说清楚就会被当成卡死。已配脉动条 + 明确解释句。**`blocked` 一律不画成红色**（它是等依赖不是失败）。
- **「装完要干嘛」按三类分开说，其中第二类是我们踩过的"零报错假成功"**：装完 libsimple 后实测 `restartRequired.required=true` 而 `db.extensions.libsimple` 仍为 `false` —— 只说"安装成功"，用户回去搜中文照样搜不到。现已渲染成「已装好，但需要重启本地服务才会生效 · [立即重启]」，**按钮已端到端跑通**（daemon 自我重启，新 pid 就位，`restartRequired` 清零）。
- **🚨 但这条按钮同时暴露了一个必须由 Manager 处置的 daemon 缺陷（见 §5，非我职责范围）**：`apps/daemon/src/main.ts:750` 的自我重启会用**机器全局的 `~/.local/share/openmemo/datadir.json` 覆盖命令行 `--data-dir`**，而**正常启动时（`main.ts:131`）的优先级恰好相反**（命令行赢）。实测我的实例从 `/tmp/ui-polish-data2` 重启后跳到了**别人的** `/tmp/t106-real`。**在我加了 UI 重启按钮之后，这条路径对用户变得可达了** —— 用户的 `:10000` 演示实例一旦自我重启就会跳到该指针文件当前所指的 `/root/data-memo`，表现为"笔记全没了"。
- **逐页差距的前三条（按影响排序，均已修）**：
  ① **`/runtime` 是密度问题不是配色问题** —— 目录 14 个包里 9 个是 darwin/win32/arm64，**在一台 linux/x64 机器上永远装不了，却占着同等大小的卡片和约三分之二页高**；再加上每张卡"标题行右半边全空、按钮自己占一行"多出的 ~40px×14。已改为「适用的平铺 + 不适用的折叠成一行」+ 按钮上提到标题行 → **页面高度 4047px → 约 2100px（−48%）**。
  ② **`/onboarding` 套在完整外壳里渲染** —— 新用户第一屏同时看到三条黄色降级条幅和一整列还用不上的导航，与引导第一句"每一步都可以跳过"直接矛盾。已改为无外壳 + 垂直居中。
  ③ **原生表单控件完全裸奔** —— `/settings` 的语言/主题/六个服务商下拉和三个代理单选，浏览器给什么就是什么（亮色灰渐变、暗色系统深灰），既不跟 `--surface-*` 也不跟 `--radius-md`。一屏里同时出现"我们画的控件"和"浏览器画的控件"，是整个界面最像半成品的一处。已在 `index.css` 的 `@layer base` 统一（**单文件、零 owner 冲突**）。
- **memo.ac 取证结论修正了一个前提**：它**不是 antd**（package.json 里有，运行时 bundle 里 `colorPrimary`/`ConfigProvider`/`.ant-*` 一个都没有）。**真实栈与我们同源**：Tailwind + shadcn(Radix) + `lucide-react` + Sonner toast。品牌色 `#575bc7`，圆角 4/8/16，阴影两档，Button 32/36/40，侧栏 256px。**所以差距不在技术选型，全在密度与层级的执行**。它的下载反馈也是"行内细进度条（h-1.5）+ toast"，与本文的修法同构。
- **未验证/存疑**：`verifying` 阶段与 `blocked` 状态的 toast **未在真实场景触发过**（本机没有能稳定构造这两个状态的样本），仅按 `JOB_STEPS`/`JobBlockedEvent` 契约实现，**标记为未跑通**；`[立即重启]` 已跑通但正是它暴露了 §5 的缺陷。深色档只逐页目测 + 令牌层原本已过校验，**本次未新增任何颜色编码，因此未新跑对比度脚本**（无新增即无需校验）。
- **对其他 agent 的影响**：见 §6。`components/common/HealthBanner.tsx` 已成**死文件**（T-107 的 `ReadinessBanner` 取代了它的挂载点，并吸收了我加的 `restartRequired` 分支与 `health.*` 词条）—— 留着不删，等 Manager 裁决。

---

# 详细内容

> **诚实标记**：`[实测]` = 本次用真浏览器（Playwright/Chromium）跑出来并有截图/日志为证；
> `[取证]` = 从 `/root/memo-forensics/` 的 memo.ac v1.7.5 解包产物里 grep 到的事实；
> `[未跑通]` = 写了但没在真实条件下触发过；`UNKNOWN` = 查不到，不编。

## §0 方法与环境

| 项 | 值 |
|---|---|
| 浏览器 | Chromium（`pnpm dlx playwright install --with-deps chromium`），1440×900 / 1440×2600，DPR 2 |
| 被测实例 | **我自己的** daemon，`--port 17902 --data-dir /tmp/ui-polish-data2`，前端走 `vite --port 5199` 代理 |
| 语言 | 强制 `localStorage['openmemo.locale'] = 'zh-CN'`（见 §4.6 的语言缺陷） |
| 用户的 `:10000` 实例 | **全程只读，未重启、未改数据** |
| 收尾 | 我起的 daemon 与 vite 进程均已按 pid 逐个停止；**未使用 `pkill -f`** |

**截图目录**（仓库外，避免污染 git）：

```
/tmp/ui-polish/shots/
├── before-light/   改前 · 1440×900 · 14 页
├── before-tall/    改前 · 1440×2600（看整页高度）
├── after-light/    改后 · 1440×900 · 14 页
├── after-tall/     改后 · 1440×2600
├── after-dark/     改后 · 暗色档 · /models /runtime /settings /notes /capture
├── interaction/    ★ 点击「安装/下载」的逐帧记录（改前）
└── after/          ★ 改后的 toast 逐帧 + 完成态 + 就绪条幅展开态
```

关键对照：

| 说明 | 路径 |
|---|---|
| 改前 `/runtime`（14 张卡、6 行英文探测报错） | `/tmp/ui-polish/shots/before-tall/runtime.png` |
| 改后 `/runtime`（5 张 + 1 行折叠） | `/tmp/ui-polish/shots/after-tall/runtime.png` |
| 改前点安装后 6 秒（页面无变化） | `/tmp/ui-polish/shots/interaction/backend-install-06000ms.png` |
| 改后 +4s（toast + 速度 + ETA） | `/tmp/ui-polish/shots/after/toast-04000ms.png` |
| 改后完成态（需重启 + [立即重启]） | `/tmp/ui-polish/shots/after/crop-restart.png` |
| 改后滚动后点下载（反馈在视野内） | `/tmp/ui-polish/shots/after/model-scrolled-after.png` |
| 改前/改后 `/onboarding` | `before-light/onboarding.png` / `after-light/onboarding.png` |
| 暗色档 `/settings`（表单控件已跟随主题） | `/tmp/ui-polish/shots/after-dark/settings.png` |

`/tmp/ui-polish/memoac-visual.md` = memo.ac 视觉语言取证全文（333 行，含每条的来源文件与 grep 命令）。
⚠️ 该目录是闭源专有代码解包产物，**未向仓库复制任何源码或资源**，只提取了规格数值。

---

## §1 ★ 用户点名的两处提示（本文最要紧的一节）

### 1.1 实测：点击之后用户到底看到了什么

脚本 `/tmp/ui-polish/pw/click.mjs`：点击后在 5 个时刻同时采样"按钮文案"与"页面上新出现的文本行"。

**「安装后端包」（`/runtime`）** `[实测]`

```
按钮点击前文案: "安装 5.3 MB"
  t=+150ms  按钮="安装 5.3 MB"  新出现文本=[]
  t=+400ms  按钮="安装 5.3 MB"  新出现文本=[]
  t=+1000ms 按钮="安装 5.3 MB"  新出现文本=[]
  t=+2500ms 按钮="安装 5.3 MB"  新出现文本=[]
  t=+6000ms 按钮="安装 5.3 MB"  新出现文本=[]
  顶栏按钮: []
```

**六秒，整页一个字都没变。** 但作业确实建好了 —— 同一次会话切到 `/tasks` 立刻看到：

```
进行中 (1)
llama.cpp · CPU 后端（Linux x64）
resolving          ← 顺带：这里漏了翻译，原样漏出机器枚举值
0 B / 16 MB  0%
```

**三条成因**（都能在代码里指到具体位置）：

1. `RuntimePage.tsx` **根本不渲染任何作业进度** —— 它没有 jobs 数据源，安装的进度只存在于 `/tasks`。
2. `BackendPackCard` 的 `installing` 绑的是 `install.isPending`，那**只覆盖 POST 本身**（~50ms）。POST 返回 202 后按钮立刻恢复原样，所以连"正在开始…"都几乎看不到。
3. 顶栏徽标 `activeCount` 读的是 `progressStore`，而 `progressStore` **只在收到 `job.progress` 后才有内容** —— 前几秒它是空的，徽标不出现。

**「下载模型」（`/models`）** `[实测]`：有反馈，但位置错了。

```
t=+150ms 新出现文本=["下载中（1）","正在选择下载源","取消","0 B / 25 MB · 0%"]
```

看起来没问题 —— 因为测试点的是第一张卡。改成"滚到第 4 张卡片再点"：

```
可下载按钮数= 3
[B] 下载中区块 top=-297 bottom=-169 视口高=900 在视野内=false
```

**「下载中」区块渲染在目录列表之上**，用户滚下去点完，反馈出现在视口上方 297px 处。屏幕上依然是"没反应"。

> **这就是用户原话「点击后的提示不明确」的全部成因：反馈存在，但不在用户眼睛所在的位置。**

### 1.2 修法：为什么是全局 Toast，而不是"在卡片里加进度条"

安装入口不止一个：`/runtime`、`/models`、`/capture` 的「去安装模型」、首启引导第 3 步、就绪条幅的「去修复」。
在每个入口各做一套局部进度，既重复又必然漏掉一两个；而且**作业活在 daemon 里、不属于任何一页**，用户点完就切走时局部进度直接消失。

→ **`apps/web/src/components/common/JobToaster.tsx`**，挂在 `App.tsx` 外壳。

- 数据源 = **已经在跑的那条全局 SSE**（`lib/events/bus`：`job.created` / `job.state` / `job.failed` / `job.blocked`）+ `progressStore`（已 200ms 节流）。
- **零新增 API 调用、零 mutation** → 不与"正在修配置保存链路"和"正在补模型选择"的人撞车。
- 遵守 D-05 §5.1：Toast 用于"异步动作的结果通知"，且**带动作的 toast 不自动消失**（成功 8s 后自动走；`blocked`/`failed`/`需重启` 永久留存）。
- 同屏最多 3 条，多的折成 `+N`（刷屏等于没提示）。

### 1.3 ★ 五阶段文案（`model-mgmt` 提供的阶段划分 → 落到词条）

词条位置：`apps/web/src/app/i18n/locales/{zh-CN,en}.json` 的 `progress.*` 与 `jobToast.*`。

| 阶段 | 主文案 | 副文案（**为什么必须有**） |
|---|---|---|
| `queued` | 排队中 | 正在等待下载通道空闲，稍后自动开始。 |
| `resolving` | 正在选择下载源 | 可以离开此页面，安装会在后台继续。 |
| `downloading` | 下载中 · 2.2 MB / 5.3 MB · 1.6 MB/s · 不到 1 分钟 | 同上（**"可以走开"要在这时候说**，D-05 §4.5：用户默认以为关页面 = 任务没了） |
| **`verifying`** | 正在校验完整性 | **文件已下完，正在逐字节核对 SHA-256。大模型这一步要几十秒，进度条不动是正常的，不是卡死。** |
| `installing` | 正在安装 | 正在解压并写入模型目录，马上就好。 |

两条硬规则：

1. **`verifying` 用脉动条（`indeterminate`）而不是不动的百分比。** 这一步没有可信进度，画一个卡在 87% 不动的条，比画脉动更像故障。ADR-004 决策 5（校验不过就丢弃）是对的安全设计，但**不解释它就会让正确的设计制造坏体验**。
2. **`blocked` 不是失败。** 它是在等依赖、条件满足会自动继续 → 用 warning 色 + 时钟图标 + 明说"这不是失败，条件满足后会自动继续"，并把服务端给的 `remediation.labelZh` 直接渲染成按钮。画成红色错误会让用户以为要重来一次。
3. **还在自动重试的 `failed` 不升级为红色**（`willRetry === true`）—— 但也不沉默，副文案改成"正在自动重试（第 2/5 次），不用管它"。

### 1.4 ★ 「装完之后要干嘛」按三类分开说

| 类型 | 装完之后 | UI |
|---|---|---|
| **模型** | 立刻可用 | ✅ 已安装 · **"已可直接使用，去捕获页粘一个链接就能转写。"** + `[去转写]`（跳 `/capture`）/ `[查看模型]` |
| **SQLite 扩展**（中文分词器 / 向量检索） | **必须重启才生效** | ✅ 已安装 · **"已装好，但需要重启本地服务才会生效。"** + `[立即重启]` |
| **后端包** | 装完即可被发现，**但正在跑的任务不换后端** | ✅ 已安装 · "已可被发现并使用；正在跑的任务不会中途换后端。" + `[查看运行时]` |

第二类的判据不是猜的 —— toast 在收到 `succeeded` 后**再问一次 `/api/health`**，读 `restartRequired.required`。`[实测]` 本机装完 libsimple 后：

```json
"restartRequired": {"required": true, "extensions": ["libsimple"], "messageZh": "中文分词器已安装，需重启生效", "endpoint": "/api/daemon/restart"},
"db": {"extensions": {"libsimple": false, "tokenizer": "trigram"}}
```

**装成功了但没生效。** 若 toast 只说"已安装"，用户回去搜中文照样搜不到，会判定"这软件坏了"——
这正是本项目反复强调的**零报错的假成功**，必须在成功提示里就说破。

### 1.5 改后实测 `[实测]`

```
t=+200ms toaster=1 新文本=["开始安装组件 · 中文分词器 libsimple（linux/x64）",
                          "排队中 · 0 B / 5.3 MB",
                          "可以离开此页面，安装会在后台继续"]
t=+4000ms 新文本=["1 个任务进行中",
                 "下载中 · 2.2 MB / 5.3 MB · 1.6 MB/s · 不到 1 分钟"]
12s 后   "已安装 · 中文分词器 libsimple（linux/x64）
          已装好，但需要重启本地服务才会生效。
          立即重启"
```

模型页滚动后点击 `[实测]`：`toaster top=777 bottom=884 视口高=900 在视野内=true`
（改前是 `top=-297 … 在视野内=false`）。

`[立即重启]` 端到端 `[实测]`：daemon 日志 `自我重启（user-requested）… 新进程 pid=2199648 已就位，本进程退出`，
重启后 `/api/health` 的 `restartRequired.required` 变为 `false`。**同时暴露了 §5 的缺陷。**

---

## §2 memo.ac 视觉语言取证（`[取证]`，全文见 `/tmp/ui-polish/memoac-visual.md`）

**最重要的一条：它不是 antd。** `package.json` 里列了 antd，但运行时 bundle 里 `colorPrimary`、`ConfigProvider`、任何 `.ant-*` 类**一个都搜不到**。
真实栈 = **Tailwind + shadcn/ui（Radix 底层）+ `lucide-react` + Sonner toast** —— **与我们同源**。

| 维度 | memo.ac v1.7.5 | 我们（D-05 §7） | 判断 |
|---|---|---|---|
| 品牌色 | `#575bc7`（紫靛，两处互证：`--color-brand-color` 与 shadcn `--primary: 238 50% 56%`） | `#2a78d6`（蓝） | **不改**。我们的值经过对比度校验，换色要重跑全套校验，收益是"更像竞品"，不值得 |
| 圆角 | 4 / 8 / 16 px | 4 / 6 / 8 / 12 px | 我们更细，无需改 |
| 阴影 | 两档：`0 0 4px rgba(0,0,0,.1)` / `0 4px 8px rgba(0,0,0,.1)` + 一档品牌色调 | 两档 `--shadow-1/2` | 一致 |
| 控件高度 | Button 32/36/40，Input 36（比 shadcn 原装整体降一档） | Button 28/36/44（`sm/md/lg`） | 我们的 `sm=28px` 偏小；**`sm` 在本仓库被当默认用**，这是"整体偏小"的一个来源 → 见 §4.5 |
| 侧栏宽 | 256px 展开 / 48px 图标栏 | 208px（`w-52`） | 我们更窄，中文两字导航够用，不改 |
| 图标 | `lucide-react`，常按 16px 渲染 | `lucide-react`，`size-3.5/4` | 一致 ✅ |
| 空态 | **自绘插画** `default_no_data.png` + 弱化说明 | 纯 lucide 图标 + 文案 | **差距真实但成本高**（要画图），见 §4 表 |
| 加载态 | **手写骨架屏**（Tailwind 宽度占位条），无骨架屏库 | 一行"正在读取…"文字 | 差距真实，见 §4 表 |
| 下载反馈 | **行内 `h-1.5` 细进度条 + 16px 旋转图标 + 百分比，绝不弹模态**；模型未下载时 `toast.error(msg, {duration:2000})` | 见 §1 | **它的做法与本文修法同构** —— 我们的 toast 还多给了阶段解释与"装完干嘛" |
| 唯一用模态的地方 | 应用自更新（600px）："New version detected: v{{newVersion}}, upgrade now?" | — | 与 D-05 §5.1"阻断对话框只有两种"一致 |

**取证到的交互文案原文**（可引用，非源码）：
`"Downloading model..."`、`"{{name}} model is not downloaded. Please download a model first."`、`"Slow download? Install locally"`、`"About {{value}} required after installation."`、`"Downloading components"`、`"Drop to Install"`。

> 值得记一笔：memo.ac 有三条**硬编码绕过 i18next 的中文报错**（`当前选中的转写模型未下载` 等），
> 说明**这类"点了没反应/提示不清"的问题竞品同样没解决好**。我们在 §1 做的阶段解释与"装完干嘛"，
> 在取证范围内**没有在 memo.ac 里找到对应实现**。

**结论：差距不在技术选型，全在密度与层级的执行。** 下一节就是执行差距的清单。

---

## §3 逐页对比（memo.ac 怎么做 / 我们怎么做 / 差在哪 —— **差在哪必须指出成因**）

| 页面 | memo.ac `[取证]` | 我们（改前）`[实测]` | **具体差在哪（成因）** | 本次处置 |
|---|---|---|---|---|
| **`/runtime`** | 它把这类功能埋在设置里（R-01：因此"模型下载卡 0%"成 FAQ 第一） | 一级导航 ✅ 但 **14 张等重卡片、页高 4047px**；6 行英文探测报错顶在首屏 | **密度 + 层级**：9/14 是别的平台的包（darwin/win32/arm64），本机永远装不了却占同等视觉权重；每张卡"标题行右半边全空、按钮独占一行"多出 ~40px×14；`error.detail` 原样甩给用户（违反 D-05 §5.3 第 3 条） | ✅ 已改：不适用的折叠成一行；按钮上提到标题行；探测细节收进 `<details>`。**页高 4047 → ~2100px** |
| **`/models`** | 行内细进度条 + toast | 有「下载中」区块，但渲染在目录之上 | **位置**：滚动后反馈在视口外 297px（§1.1） | ✅ 全局 toast 兜住 |
| **`/onboarding`** | UNKNOWN（未取到首启流程） | **套在完整外壳里**：三条黄色降级条幅 + 一整列还用不上的导航 | **层级**：与引导第一句"每一步都可以跳过"直接矛盾；R-04 §1.5 要求"第一次不要让用户做任何配置决策"，更不该先读三条看不懂的告警 | ✅ 已改：无外壳 + 垂直居中 |
| **`/settings`** | shadcn 控件，全部自绘 | **原生 `<select>`/`<radio>` 完全裸奔**（5 个下拉 + 3 个单选） | **一致性**：一屏里同时出现"我们画的控件"和"浏览器画的控件"，亮色是灰渐变、暗色是系统深灰，既不跟 `--surface-*` 也不跟 `--radius-md`。**这一处与业务逻辑完全无关，却最像半成品** | ✅ 已改：`index.css` `@layer base` 统一（单文件零冲突） |
| **`/settings`（IA）** | UNKNOWN | D-05 §1.2 规定 `/settings/{general,asr,llm,storage,about}` 五个子路由；**实测五个 URL 渲染同一张长页**（`h=1343` 全等），无子导航 | **IA 未落地**：不是样式问题 | ❌ 未改（属 T-021/architect 的路由与页面结构，已在 inbox 提出） |
| **`/notes`（空态）** | **自绘插画** + 弱化文案 | lucide 图标 + 标题 + 一句提示 + 按钮 | **成分**：D-05 §5.4 要求"空态即入口，输入框直接可用"，我们只放了按钮；插画差距成本高 | ❌ 未改（跨 owner，见 §6） |
| **`/notes`（列表）** | 列表行高 UNKNOWN | **整页没有 H1、没有工具条**（排序/视图切换/筛选一个都没有） | **缺件**：不是"丑"，是功能位没做 | ❌ 未改（T-021 的页） |
| **`/tasks`** | — | 阶段名漏出机器枚举值 `resolving` | **词条缺失**：`JobList` 走 `t('progress.'+step)` 但 `progress.*` 里**没有 4 个下载阶段的 key**，`defaultValue` 兜底成原始英文 | ✅ 已补齐 `progress.{queued,resolving,downloading,verifying,installing}`（中英各一份） |
| **顶部条幅** | — | 三条通栏黄条约 140px；`[去修复]` 被 `flex-1` 推到窗口最右，**实测与正文相距约 1050px**，三个按钮纵向排成一列看不出属于哪句话 | **配对关系丢失**（费茨定律之前的问题） | ⚠️ 我改的 `HealthBanner` 已被 T-107 的 `ReadinessBanner` 取代（合并成一行 + 默认折叠，方向一致，效果更好）。**我的 `restartRequired` 分支与 `health.*` 词条已被其吸收** |
| **暗色档** | 有 | 令牌层正确（`@theme inline` + 双作用域），但裸奔的原生控件不跟随 | **同上** | ✅ 随 §3 第 4 行一并解决，见 `after-dark/settings.png` |

---

## §4 已落地的改动清单

| 文件 | 改动 | 归属确认 |
|---|---|---|
| `components/common/JobToaster.tsx` **（新增）** | 全局安装/下载反馈层：五阶段 + `verifying` 解释 + `blocked≠失败` + 装完三类出口 + `remediation` 按钮 | `components/common/` 只增不改，D-05 §3.3 规则 2 免申报 |
| `App.tsx` | 挂载 `<JobToaster/>`；`/onboarding` 走无外壳布局 | 共享区 → **已在 inbox 申报 `SHARED-CHANGE`** |
| `app/i18n/locales/{zh-CN,en}.json` | 补 `progress.*` 四个下载阶段 + `jobToast.*` 23 条 + `health.restart*` 4 条。**两份 key 数量已校验相等（484/484，对称差为空）** | `app/**` 属我 |
| `index.css` | `@layer base` 统一 `select` / `checkbox` / `radio`；把 D-05 §7.4 的"正文 1.6"真正落到 `--text-*--line-height` | 共享区 → 已申报 |
| `components/common/AsrModelPicker.tsx` | 修 `Whisper base (Q5_1) (q5_1)` 量化重复（归一化大小写与 `_`/`-` 后判重） | `components/common/` |
| `features/recorder/RecorderPage.tsx` | `showModel={false}` → `showModel`（该保护在选择器变真之后已过时） | 呈现层；**与 `architect` 的分工已在 inbox 声明由我改** |
| `features/runtime/RuntimePage.tsx` | 不适用包折叠；抽 `renderPack` 避免两处漂移 | 呈现层，已申报 |
| `features/runtime/components/BackendPackCard.tsx` | 动作按钮上提到标题行（省 ~40px/卡） | 呈现层，已申报 |
| `features/runtime/components/HardwareCard.tsx` | 探测失败原因收进 `<details>`（D-05 §5.3 第 3 条） | 呈现层，已申报 |
| `components/common/HealthBanner.tsx` | 加了 `restartRequired` 分支 + 动作贴近正文。**该文件现已无人挂载**（见 §6） | — |

**验证**：`pnpm exec tsc -b` 通过；`pnpm exec eslint apps/web/src --max-warnings=0` 通过；
`apps/web` 测试 **90 项 / 88 通过 / 0 失败 / 2 skipped**。

### 4.5 明确**没有**做的事，以及为什么

- **没有改字号。** memo.ac 的控件比我们高一档（Button 32/36/40 vs 我们 28/36/44），但字号系统与 D-05 §7.4 一致。整体放大是**全仓改动**，会踩到三个 owner 正在改的文件，收益不确定 → 只调了行高（中文在 `text-xs`/`1.33` 下确实发闷，1.6 是 D-05 早就写了但从未生效的规定值）。
- **没有换品牌色。** 我们的 `#2a78d6` 通过了对比度校验，换成 memo.ac 的 `#575bc7` 要重跑全套校验，收益只是"更像竞品"。
- **没有新增任何颜色编码** → 因此本次**未新跑对比度脚本**（无新增即无需校验）。存储分解条的图例与数字标签保持原样。
- **没有碰 `components/ui/`**（shadcn 豁免区，ADR-002/005）。
- **没有碰任何业务逻辑与 mutation**。唯一新增的网络调用是 toast 成功后读一次公开的 `/api/health`，以及 `[立即重启]` 打 `/api/daemon/restart`（daemon 自己在 `/api/health` 里公布的端点）。

---

## §5 🚨 必须由 Manager 处置：自我重启会劫持 `--data-dir`

**这不属于我的改动范围，但它是被我加的 `[立即重启]` 按钮暴露出来的，且现在对用户可达。**

`[实测]` 我的实例以 `--data-dir /tmp/ui-polish-data2` 启动，点 `[立即重启]` 后 daemon 日志：

```
[daemon] 自我重启（user-requested）…
[daemon] 数据目录已变更，重启参数由 /tmp/ui-polish-data2 改为 /tmp/t106-real
[daemon] 新进程 pid=2199648 已就位，本进程退出
```

**同一个 daemon 对同两个输入有两条相反的优先级规则：**

| 位置 | 规则 |
|---|---|
| `apps/daemon/src/main.ts:131` **正常启动** | 指针文件与 `--data-dir` 冲突时 → 日志明说"**本次使用 `opts.dataDir`**"（命令行赢） |
| `apps/daemon/src/main.ts:750` **自我重启** | 指针文件 ≠ argv 里的值 → **改写 argv**（指针文件赢） |

指针文件是**机器全局**的：`~/.local/share/openmemo/datadir.json`（当前内容 `{"dataDir": "/root/data-memo"}`，本次会话中已被不同 agent 改过至少两次）。

**后果**：任何带显式 `--data-dir` 启动的实例，**一旦自我重启就会跳到该文件当时指向的目录**。
包括用户正在用的 `:10000`（`--data-dir /tmp/omdemo`）—— 它会跳到 `/root/data-memo`，用户看到的是"**笔记全没了**"，
而数据其实好端端在 `/tmp/omdemo`。

`main.ts:741` 的注释说明了改写 argv 的**本意**（搬完数据目录后不能回到被搬空的旧路径，这是对的），
缺的是**区分"指针变了是因为这个实例刚搬过家"还是"全局指针本来就指向别处"**。

**我的建议（仅供裁决，不是我能改的）**：只在**本进程这次运行期间真的执行过数据目录迁移**时才改写 argv；
或让改写只在 `pointer` 是由本进程写入时生效。**在修好之前，`[立即重启]` 对带 `--data-dir` 的实例是有风险的动作。**

---

## §6 对其他 agent 的影响 / 待裁决

1. **`components/common/HealthBanner.tsx` 已成死文件。** T-107 的 `ReadinessBanner` 接管了 `App.tsx` 的挂载点，并已吸收我加的 `restartRequired` 分支与 `health.restart*` 词条（我读了它的代码确认过）。我**不删**别人挂载链路上的历史文件，请 Manager 裁决由谁清理。
2. **`/settings` 五个子路由渲染同一页**（D-05 §1.2 规定各自独立）。属 T-021/architect 的路由结构，不是样式，我没动。
3. **`/settings` 的「主题」下拉仍显示 `system / light / dark` 三个未翻译的原始值。** 词条我可以加，但 `<option>` 的文案在 `SettingsPage.tsx` 里是硬编码字符串，需要该文件的 owner 一起改。
4. **`/models` 与 `/runtime` 两页正文全是硬编码中文**，不走 i18n。中文用户看不出问题，**英文用户会看到"英文外壳 + 全中文正文"**（`before-light/models.png` 就是这个状态）。这是 T-022 名下两页的大工程，我只报告不动手。
5. **`RecorderPage.tsx:303` 的 `showModel` 由我打开**（Manager 转达的分工），`architect` 请勿重复改。
6. `JobToaster` 的 **`verifying` 与 `blocked` 两个状态未在真实场景触发过** `[未跑通]`。若 `model-mgmt` 能构造出这两个状态的样本，请在 inbox 说一声，我去补一次真机验证。

---
---

# 【追加】§7 配色体系（T-114 · ui-polish 第二轮 · 2026-08-03）

> 本节是**追加**，上面 §0–§6 是第一轮（T-101）的内容，一个字都没改。
> 诚实标记沿用文件头的约定：`[实测]` / `[取证]` / `[未跑通]` / `UNKNOWN`。

## TL;DR（追加 · Manager 只读这里）

- **上一轮明确写了"本次未新增任何颜色编码，因此未新跑对比度脚本"。这一轮跑了，结果是：旧色板在两个主题里都有不达标项，而且不达标的是最要紧的几处。** `[实测]`
  - **主按钮的文案**（`--accent-fg` 压在 `--accent` 上）：明档 **4.42:1**、暗档 **3.64:1** —— 全站点击最多的一行字，两档都低于 4.5:1。
  - `text-warning` 明档 **1.74:1**。这不是"颜色偏浅"，是**看不见**。`text-good` 3.18、`text-serious` 2.50、`text-accent` 4.19，明档四个全不达标。
  - `text-critical` **暗档 3.62:1** —— 暗档同样有洞，而 D-05 §7.5 记的是"暗色全部五项 PASS"。
  - `--ink-muted`（承载"需显存 ~512 MB"这类**说明正文**）明档 **3.41:1**。
  - 进度条 **填充 vs 轨道**：warning **1.39:1** —— 橙黄色的条压在浅蓝轨道上，看不出走到哪了。
- **成因是一句话：这套色是按「图表记号」的 3:1 线选的，而应用把它们当「文字」用（54 处 `text-*`），文字线是 4.5:1。** D-05 §7.2 把 warning/serious 低于 3:1 记为"设计取舍 + 配图标缓解"，那个取舍在"只当记号"的前提下成立；前提换了，结论没跟着换，**而且没有任何东西会报错**。
- **改法不是调深几个色，是把每个语义色拆成四层**：`--status-X`（锚点，**D-05 §7.2 原值一个没动**）/ `-ink`（文字与图标）/ `-tint`（淡底与进度条轨道）/ `-line`（描边）；另加 `-solid`（白字压在上面的实心块）。**ink/tint/line 必须随主题变** —— "在浅底能读"和"在深底能读"是互斥的（深红 `#c12e2e` 在暗底只有 2.7:1）。
- **新增第 5 个语义位 `info`**：此前"品牌主色"和"进行中状态色"共用 `--accent` 一个变量，改一个就动另一个。
- **对比度不是目测的，是 CI 里的断言**：`apps/web/src/styles/tokens.contrast.test.ts` **从 `tokens.css` 现场解析**（不抄常量，抄了就等于允许分叉），**64 对实测、14 个用例、全部通过**。它还断言暗色两个作用域逐字相同 —— 那两块是手工重复的，最容易悄悄分叉。
- **状态色收进一张判定表**（`components/common/statusTone.ts`）。判据一句话：**色相编码的是「要不要你管、急不急」，不是「好坏排名」**。推论：**「已安装」与「使用中」同为绿**，靠 ✓ / ⚡ 图标区分 —— 这正好落实了 `StatusChip` 那条"永远同时给图标与文字"的断言：**颜色少扛一点区分职责，可读性反而更高**。
- 由此修掉三条**互相矛盾**的旧写法 `[实测]`：① 「已安装/使用中」在 `ModelCard`（绿/蓝）与 `BackendChip`（灰/绿）**恰好互换**；② `DownloadRow` 同一张卡里 `verifying` 芯片是蓝、正下方进度条是绿；③ `JobList` 是六个渲染点里唯一没有 `verifying` 分支的，且 fallback 把机器枚举值（`queued`/`cancelled`）直接当标签显示。
- **另修一个死令牌**：`text-success` **从来就不存在**（`@theme` 里只有 `--color-good`），用它的两处（`AsrEngineStatus.tsx:121` 引擎"可用"的对勾、`DataLocationSection.tsx:259` "需重启"提示）**渲染出来是无色的**。Tailwind 对不存在的类不报错，所以它活了很久。
- **上一轮标记 `[未跑通]` 的两个 toast 状态，这一轮都用真样本跑通了** `[实测]`：
  - `verifying` —— 真下了 874 MB 的 whisper-large-v3-turbo-q8_0，`t=+180000ms` 抓到「正在校验完整性 · 874 MB / 874 MB」+ 那句"进度条不动是正常的，不是卡死"。
  - `blocked` —— **跑的过程中发现它在真实运行里根本不可达，并修好了**：`job.blocked` 的唯一发送方是 transcribe / mindmap 两个 runner，而这两类 job **刻意不发 `job.created`**（`apps/daemon/src/jobs/events.ts` 有整段注释说明原因），`upsert` 又规定"没见过 created 就不补建"。代价不是少一条提示：**没装 ASR 模型时导入媒体，POST 返回 202、笔记停在 `processing`，页面上一个字都没有**。修后 `t=+400ms` 出现「暂时无法继续 · 转写任务已暂停 / 尚未安装语音识别模型 / 这不是失败，条件满足后会自动继续。/ [去安装语音识别模型]」。
- **未验证/存疑**：`serious` 一档在本机没有真实触发场景，只做了令牌与校验，**未在真实状态下截图**。`/models` 目录页 25 条平铺**没做**（memo-compare 已定论：要做「语言 × 速度」双轴卡片，而我们的 manifest **缺速度轴**，`quantTier` 是体积轴 —— 属 `model-mgmt`）。LLM 供应商品牌色注册表**未做**（memo-compare 已核实 memo.ac 24 家全无 color 字段，要自定，本轮没排上）。
- **对其他 agent 的影响**：`tokens.css` / `index.css` 是共享区，已按协议申报（见 inbox）；D-05 §7.2「状态色四个都不随主题变」的**锚点仍然成立**，新增的三层是随主题的，请 `architect` 裁决是否把这一节回写进 D-05。

---

## §7.1 memo.ac 色板取证补完 `[取证]`

上一轮取到了品牌色与表层，**success 标着 UNKNOWN**。本轮补完（全文 `/tmp/ui-polish/memoac-color.md`，193 行，每条附来源文件与 grep 命令；**未向仓库复制任何专有源码或资源**）：

| 角色 | memo.ac 明档 | memo.ac 暗档 | 来源 |
|---|---|---|---|
| 品牌主色 | `#575bc7` | 同（暗档不覆盖） | `--color-brand-color` / shadcn `--primary: 238 50% 56%` |
| 页底 / 卡片 | `#f1f5f9` / `#ffffff` | `#181921` / `#272934` | `--color-bg-content` / `--color-bg-element` |
| 分隔线 | `#e3e9ed` | `#373948` | `--color-line` |
| 主 / 次 / 三级文字 | `#323232` / `#525866` / `#87939d` | `#dfdfdf` / `#b5b5b5` / `#87939d` | `--color-text-*` |
| 信息 / 链接 | `#01a0ff` | — | `--color-status-link` |
| 警告 | `#f29416` | — | `--color-status-activity` |
| 危险 | `#ed4622` | — | `--color-status-danger` |
| **成功** | **没有自定义令牌**：状态映射里直接用 Tailwind `green-500 #22c55e` / `green-600 #16a34a` | 同（静态类，无暗档覆盖） | 状态 `switch` 函数 + 模型"未下载"块 |
| 中性阶 | shadcn 原装 **Slate**（`--muted #f1f5f9`、`--secondary #64748b`） | `#272934`（手改，偏离 slate 阶）/ `#94a3b8` | dist CSS `:root` + dark `@media` |
| Sonner richColors | 成功 `hsl(140,100%,27%)` 字 / `hsl(143,85%,96%)` 底 | `hsl(150,86%,65%)` / `hsl(150,100%,6%)` | JS bundle 内联 `<style>`，**Sonner 原装未定制** |

**三条比色值更有用的结论：**

1. **它的状态色不成体系。** 同一个"进行中"，任务胶囊用 `amber-500`，TTS 转圈用 `blue-500`；成功色**只有静态 Tailwind 类、没有暗档变体**（暗档下 `green-600` 在 `#272934` 上偏暗）。它的暗档侧栏 `--sidebar-primary` 还是未改的 shadcn 样板蓝 `#1d4ed8`，和自家品牌紫 `#575bc7` 对不上。**照抄它的配色没有价值**。
2. **它的「底 / 字 / 边」三件套值得抄。** 出现频次最高的写法是 `bg-{c}-500/10` + `border-{c}-500/30~60` + `text-{c}-600/700`（暗档 `text-{c}-300/400`）—— 淡底 + 描边 + 深字。我们此前的状态芯片是**裸文字**，扫视时"这是个状态"要靠读文案才知道。本轮 `StatusChip` 的 `variant="soft"` 就是这个形态。
3. **它没有图表 / 存储分解类的分类色**（bundle 里零 recharts / PieChart / BarChart）。我们的 `--data-1..4` 无参照可比，保持不动。

**品牌色仍然不换。** 我们的蓝有完整校验记录，换成它的紫要重跑全套（含 CVD 分离），收益只是"更像竞品"。

---

## §7.2 旧色板的实测不达标项 `[实测]`

判据：**文字与图标 4.5:1（WCAG 1.4.3）/ 非文字 3:1（1.4.11）**。表层取最不利的一档（明档 `--surface-0 #f9f9f7`，暗档 `--surface-2 #242422`）。

| 令牌 | 用在哪 | 明档 | 暗档 | 判定 |
|---|---|---|---|---|
| `--accent-fg` on `--accent` | **主按钮文案** | **4.42** | **3.64** | ❌ 两档都不过 |
| `--accent`（当文字，`text-accent` 28 处） | 链接、"进行中" | **4.19** | 4.79 | ❌ 明档不过 |
| `--status-warning` | `text-warning` | **1.74** | 9.49 | ❌ 明档**几乎不可见** |
| `--status-serious` | `text-serious` | **2.50** | 6.60 | ❌ 明档不过 |
| `--status-good` | `text-good` | **3.18** | 5.19 | ❌ 明档不过 |
| `--status-critical` | `text-critical` | 4.56 | **3.62** | ❌ **暗档**不过 |
| `--ink-muted` | 说明正文 | **3.41** | 4.33 | ❌ 两档都擦边/不过 |
| `--line` vs 卡片底 | 卡片边界 | **1.29** | **1.24** | ⚠️ 见下 |
| 进度条填充 vs 轨道 | meter | warning **1.39** · good 2.53 | — | ❌ 非文字 3:1 不过 |

**关于 `--line` 那一行，要单独说，因为它不是无障碍问题而是"界面发糊"的直接成因**：明档 `--surface-1`（卡片 `#fcfcfb`）与 `--surface-0`（页底 `#f9f9f7`）之间只差 **1.03:1** —— 也就是说**卡片和页面底板在明档几乎是同一个颜色，卡片边界完全由那条 1.29:1 的线承担，而它太淡了**。作为对照，GitHub 的 `#d0d7de` 对白底是 **1.45:1**。已补到 **1.42:1**（暗档 1.24 → 1.53）。

---

## §7.3 新令牌（`apps/web/src/styles/tokens.css`）

### 结构：四层 + 一个实心档

| 层 | 判据 | 用在哪 |
|---|---|---|
| `--status-X` | **保持 D-05 §7.2 原值不动** | 语义锚点；图表侧的既有校验不受影响 |
| `--status-X-ink` | 对表层 **≥4.5:1**、对自身 tint 也 **≥4.5:1** | 文字、图标、进度条填充 |
| `--status-X-tint` | 与表层可分辨（≥1.1:1） | 芯片淡底、进度条轨道 |
| `--status-X-line` | 对表层 **≥3:1** | 芯片描边、左侧强调边 |
| `--status-X-solid` | **白字 ≥4.5:1**，块面对明暗两档表层都 ≥3:1 | 实心块（危险按钮、引导页已完成步骤） |

### 明档

| 角色 | 锚点 | ink（文字） | tint（淡底） | line（描边） |
|---|---|---|---|---|
| good | `#0ca30c` | **`#097a09`** | `#daf0da` | `#0ca30c` |
| warning | `#fab219` | **`#916403`** | `#fcefd2` | `#bb8004` |
| serious | `#ec835a` | **`#b94315`** | `#faebe4` | `#e76330` |
| critical | `#d03b3b` | **`#c12e2e`** | `#f6e1e0` | `#d03b3b` |
| info | `#2570cd` | **`#2267bd`** | `#dee8f5` | `#2570cd` |

> warning 的 ink 是棕金 `#916403` 而不是琥珀 —— **任何琥珀色要在近白底上当文字读，都只能走到棕金**，这是色度决定的，不是审美选择。

### 暗档

| 角色 | ink | tint | line |
|---|---|---|---|
| good | `#0db10d` | `#173516` | `#0ca30c` |
| warning | `#fab219` | `#473819` | `#fab219` |
| serious | `#ec835a` | `#442f26` | `#ec835a` |
| critical | **`#dd7373`**（浅红，`#d03b3b` 在暗底只有 3.24） | `#3e2120` | `#d03b3b` |
| info | `#5a9be9` | `#203042` | `#3987e5` |

### 主色与中性阶

| 令牌 | 旧 | 新 | 为什么 |
|---|---|---|---|
| `--accent`（块面） | `#2a78d6` / `#3987e5` | **`#2570cd`（明暗共用）** | 判据是"白字压上去要 ≥4.5"。暗档原来更糟（3.64），所以两档统一到一个能扛白字的深蓝 |
| `--accent-ink`（文字） | 无（复用 `--accent`） | `#2267bd` / `#5a9be9` | 块面与文字在暗档要求**相反方向**，必须是两个变量 |
| `--ring` | `= --accent` | `= --accent-ink` | 暗档焦点环要亮才看得见 |
| `--ink-muted` | `#898781`（两档同值） | `#6f6d68` / `#a3a199` | 它承载的是说明正文，不是装饰 |
| `--line` | `#e1e0d9` / `#2c2c2a` | `#d7d6cb` / `#3a3a37` | 见 §7.2 末段 |
| `--status-good-solid` / `--status-critical-solid` | 无 | `#118011` / `#d03b3b` | 白字压在上面的那一档 |

**表层（`--surface-0/1/2`）与 `--data-1..4` 一个都没动** —— 图表色板的六项校验是对着这些表层跑的，动了就得全部重跑，而它们本身没有问题。

**⚠️ 一处刻意的取舍**：`--accent` 从 `#2a78d6` 移到 `#2570cd` 后，它不再与分类槽 1（`--data-1: #2a78d6`）同值。这是**有意的**：`--data-1` 属图表色板（已校验、按 CVD 排过序），`--accent` 属界面块面色（判据是白字对比度）。两者判据不同，本来就不该共用一个值。

### 工具类的映射（`index.css`）

**`text-good` / `bg-good` 指向的是 ink 档而不是锚点档**，这是刻意的：仓库里 54 处 `text-{good,warning,serious,critical}` **全部**是文字或图标，把工具类指到 ink 档，**54 个调用点一行都不用改就全部达标**。需要"实心块 + 白字"的地方（危险按钮、引导页步骤圆点）改用 `bg-{good,critical}-solid`（共 2 处）。

---

## §7.4 对比度校验：脚本 + 实测数值 `[实测]`

**校验不是一次性脚本，是 CI 里的断言** —— 因为这套色**曾经被校验过一次然后悄悄失效**（§7.2 的成因）。

- 位置：`apps/web/src/styles/tokens.contrast.test.ts`（已登记进 `apps/web/tsconfig.test.json`）
- 跑法：`pnpm --filter @openmemo/web test:unit`
- 它**从 `tokens.css` 现场解析**三个作用域（`:root` / `@media dark` / `:root[data-theme='dark']`），不抄常量 —— 抄一份就等于允许两边分叉
- 对比度算法与 D-05 §7.5 所用的校验器同源（WCAG 相对亮度），数值可直接对照

```
tests 14 | pass 14 | fail 0        （64 对实测，全表见 /tmp/ui-polish/contrast-report.txt）

──── 明档  最不利表层 #f9f9f7 ····
PASS  明档 --ink-muted                                      4.9:1  (需 4.5)   ← 旧值 3.41
PASS  明档 --accent-ink                                    4.66:1  (需 4.5)   ← 旧值 4.19
PASS  明档 --accent-fg on --accent（主按钮）                  4.91:1  (需 4.5)   ← 旧值 4.42
PASS  明档 --status-good-ink vs 表层                        5.24:1  (需 4.5)   ← 旧值 3.18
PASS  明档 --status-warning-ink vs 表层                     4.95:1  (需 4.5)   ← 旧值 1.74
PASS  明档 --status-serious-ink vs 表层                     5.14:1  (需 4.5)   ← 旧值 2.50
PASS  明档 --status-critical-ink vs 表层                    5.39:1  (需 4.5)
PASS  明档 --status-info-ink vs 表层                        5.32:1  (需 4.5)
PASS  明档 --status-{good,warning,serious,critical,info}-ink on 自身 tint
                                       4.53 / 4.57 / 4.66 / 4.53 / 4.53 :1  (需 4.5)
PASS  明档 --ring                                          5.32:1  (需 3)
PASS  明档 --status-*-line                    3.18 / 3.21 / 3.20 / 4.56 / 4.66 :1  (需 3)

──── 暗档  最不利表层 #242422 ····
PASS  暗档 --ink-muted                                     6.01:1  (需 4.5)   ← 旧值 4.33
PASS  暗档 --accent-ink                                    5.41:1  (需 4.5)
PASS  暗档 --accent-fg on --accent（主按钮）                  4.91:1  (需 4.5)   ← 旧值 3.64
PASS  暗档 --status-critical-ink vs 表层                    5.02:1  (需 4.5)   ← 旧值 3.62
PASS  暗档 --status-{good,warning,serious,info}-ink vs 表层  5.41 / 8.48 / 5.89 / 5.41 :1
PASS  暗档 --status-*-ink on 自身 tint          4.70 / 6.20 / 4.74 / 4.69 / 4.67 :1  (需 4.5)
PASS  暗档 --accent 块面                                    3.17:1  (需 3)
PASS  暗档 --status-*-line                    4.64 / 8.48 / 5.89 / 3.24 / 4.27 :1  (需 3)

PASS  --status-good-solid 上的白字                           5.1:1  (需 4.5)
PASS  --status-good-solid 块面 vs 明档页底 / 暗档抬升面      4.84 / 3.05 :1  (需 3)
PASS  --status-critical-solid 上的白字                       4.8:1  (需 4.5)
PASS  --status-critical-solid 块面 vs 明档页底 / 暗档抬升面   4.56 / 3.24 :1  (需 3)
```

第 14 个用例是**防分叉断言**：暗色的两个作用域（`@media (prefers-color-scheme: dark)` 与 `:root[data-theme='dark']`）必须逐字相同。那两块是手工重复的，D-05 §7.5 要求两处都写 —— 手工重复的东西迟早会分叉，所以给它一条断言。

---

## §7.5 状态色成体系（`components/common/statusTone.ts`）

### 判据（一句话说得清才是好规则）

> **色相编码的是「要不要你管、急不急」，不是「好坏排名」。**

| tone | 含义 | 覆盖的状态 |
|---|---|---|
| `good` | 没问题，不用管 | 已安装、已完成、就绪、**使用中** |
| `info` | 正在发生，等着就行 | 排队后的 running / resolving / downloading / **verifying** / installing |
| `warning` | **要你处理，但不是失败** | `blocked`、能力降级、装完待重启 |
| `serious` | 能用，但结果会变差 | 走了降级路径、模拟数据 |
| `critical` | 坏了，必须处理 | `failed`、自检失败、能力**缺失** |
| `neutral` | 不适用 / 还没开始 | 未安装、`queued`、`paused`、`cancelled` |

**推论：「已安装」与「使用中」同为 `good`。** 区分交给**图标**（✓ 对 ⚡）与文字。这不是妥协 —— `StatusChip` 本来就有一条断言"永远同时给图标与文字"，**让颜色少扛一点区分职责，正是那条断言想要的结果**；反过来，用两个颜色去表达"都挺好，只是一个正在被用"，对色觉障碍用户等于没表达。

### 修掉的三条矛盾 `[实测，逐处指到行]`

| # | 现象 | 位置 | 处置 |
|---|---|---|---|
| 1 | **「已安装/使用中」在两处恰好互换**：`ModelCard` 绿/蓝，`BackendChip` 灰/绿。用户在两页之间切换学到的规则是反的 | `features/models/components/ModelCard.tsx:70`、`components/common/BackendChip.tsx:29-53` | 统一为 已安装 = `good`+✓、使用中 = `good`+⚡；「可安装」是**动作邀请不是状态**，退出状态色 |
| 2 | 同一张卡里 `verifying` 是两个颜色：芯片 `running`（蓝）、正下方进度条写死 `good`（绿） | `features/models/components/DownloadRow.tsx:78` 与 `:102` | 两处统一 `info`。verifying 的特殊性由**脉动条 + 那句解释**承担，不靠换色 |
| 3 | `JobList` 是六个渲染点里**唯一没有 `verifying` 分支**的；fallback 把机器枚举值当标签渲染 | `features/tasks/JobList.tsx:61-73`、`:90-95` | 走 `jobStateTone()`；补 `indeterminate={verifying}`；补 `jobState.*` 词条（中英各 8 条，两份 key 已校验对称） |

### 另外两处

- **死令牌 `text-success`**：`@theme` 里**从来没有** `--color-success`（只有 `--color-good`）。用它的两处 —— `AsrEngineStatus.tsx:121`（引擎"可用"的对勾）与 `DataLocationSection.tsx:259`（"需重启"提示）—— **渲染出来是无色的**。Tailwind 对不存在的类不报错，所以它活了很久。已改 `text-good`。
- **就绪条幅报轻了严重度**：折叠态图标写死 `text-warning`（琥珀 = "该修一下"），但同一件「流水线缺件」在诊断页是 `fail`（红 = "这坏了"）。**条幅的全部作用就是预警，报轻了等于没报。** 已给每条 item 加必填 `tone`，汇总取 `worstTone()`（最严重那条），展开后每条也带自己的严重度图标。

### 进度条：轨道跟着 tone 走

原来轨道写死 `--accent-track`（浅蓝），填充却会换成 warning / critical，实测 warning 填充 vs 蓝轨道 **1.39:1** —— **而"填充与轨道能否分辨"就是进度条的全部意义**。现在轨道 = `--status-X-tint`、填充 = `--status-X-ink`，明暗两档全部 ≥4.5:1。

---

## §7.6 落地清单（本轮改动）

| 文件 | 改动 | 归属 |
|---|---|---|
| `styles/tokens.css` | 四层状态令牌 + info 位 + accent 拆块面/文字 + ink-muted / line 补足 | **共享区，已申报 SHARED-CHANGE** |
| `index.css` | `@theme inline` 转发新令牌；`--color-good` 等重定向到 ink 档 | **共享区，已申报** |
| `styles/tokens.contrast.test.ts` **（新增）** | 64 对对比度断言 + 暗档双作用域防分叉 | 新文件，零冲突 |
| `tsconfig.test.json` | 登记上面这个测试（一行） | **共享区，已申报** |
| `components/common/statusTone.ts` **（新增）** | 状态 → tone 的唯一判定表 | `components/common/` 只增不改，D-05 §3.3 免申报 |
| `components/common/StatusChip.tsx` | 加 `info` tone、`variant="soft"`（淡底+描边+深字） | `components/common/` |
| `components/common/ProgressMeter.tsx` | 轨道跟随 tone；加 `info` | `components/common/` |
| `components/common/BackendChip.tsx` | 语义与模型侧对齐 | `components/common/` |
| `components/common/ReadinessBanner.tsx` | 严重度感知（`tone` 必填 + `worstTone`） | `components/common/` |
| `components/common/JobToaster.tsx` | verifying 统一 `info`；**blocked 分支修成可达**（见 §7.7） | `components/common/` |
| `components/common/AsrEngineStatus.tsx` | 死令牌 `text-success` → `text-good` | `components/common/` |
| `components/common/AsrModelPicker.tsx` | 已安装列表按模型族 `<optgroup>` 分组 | `components/common/` |
| `features/tasks/JobList.tsx` | 走 `jobStateTone`；补 verifying 脉动；fallback 不再露枚举值 | 呈现层 |
| `features/models/components/{ModelCard,DownloadRow}.tsx` | 见 §7.5 表 | 呈现层 |
| `features/settings/{DataLocationSection,PurposeBindingsSection}.tsx` | 死令牌；`bg-accent-track`+文字（3.71:1）→ `bg-info-tint`（4.53:1） | 呈现层 |
| `features/notes/TimeAnchor.ts` | 同上（时间锚点小胶囊，明档 3.71 / 暗档 2.82 → 均 ≥4.5） | 呈现层 |
| `features/onboarding/OnboardingPage.tsx` | 已完成步骤圆点 `bg-good` → `bg-good-solid`（白字 3.35 → 5.10） | 呈现层 |
| `components/common/Button.tsx` | `danger` 底 → `bg-critical-solid` | `components/common/` |
| `app/i18n/locales/{zh-CN,en}.json` | `jobState.*` 8 条 + `jobToast.blocked{Transcribe,Mindmap,Generic}` 3 条，**两份 key 已校验对称** | `app/**` 属我 |
| 全仓 `text-accent` → `text-accent-ink` | 26 处，`text-accent-fg` 未误伤（负向匹配） | 机械替换 |

**验证**：`pnpm exec tsc -b` 通过；`pnpm exec eslint . --max-warnings=0` 通过；`apps/web` 测试 **110 项 / 108 通过 / 0 失败 / 2 skipped**（其中 14 项是本轮新增的对比度断言）。

---

## §7.7 补验：`verifying` 与 `blocked` `[实测]`

上一轮这两个状态标着 `[未跑通]`（"本机没有能稳定构造这两个状态的样本"）。本轮都构造出来了。

### `verifying` —— 直接跑通

真下载 `asr/whisper-large-v3-turbo-q8_0`（874 MB），逐帧采样：

```
t=+100ms    开始下载模型 · Whisper 大模型 v3 Turbo（Q8_0 量化）| 排队中 · 0 B / 874 MB
t=+3400ms   正在选择下载源 · 0 B / 874 MB
t=+4900ms   下载中 · 6.9 KB / 874 MB · 6.9 KB/s · 约 35 小时
t=+119000ms 下载中 · 577 MB / 874 MB · 5.0 MB/s · 不到 1 分钟
t=+180000ms 正在校验完整性 · 874 MB / 874 MB
            文件已下完，正在逐字节核对 SHA-256。大模型这一步要几十秒，进度条不动是正常的，不是卡死。
t=+180600ms 已安装 · 已可直接使用，去捕获页粘一个链接就能转写。 | [查看模型] [去转写]
```

截图 `/tmp/ui-polish/shots/toast-verifying.png`。盾牌图标与脉动条现在都是 `info` 蓝，与 `DownloadRow` 一致（旧实现这里是绿、那里是蓝）。

### `blocked` —— 跑的过程中发现它**根本不可达**，并修好了

第一次构造（没装 ASR 模型 → 导入媒体）：`POST /api/notes/import` 返回 **202**，笔记停在 `processing`，**页面上零反馈**。查因：

| 环节 | 事实 |
|---|---|
| `job.blocked` 的发送方 | **只有** `apps/daemon/src/jobs/runners/{transcribe,mindmap}.ts` |
| 这两类 job 会发 `job.created` 吗 | **不会**，且是**刻意的** —— `apps/daemon/src/jobs/events.ts` 与 `http/rest/notes.ts:239` 都有注释：`JobCreatedEvent` 要求一个完整的 `DownloadJob`（`kind`/`totalBytes`/`parts`/`fileIndex`…），流水线 job **填不进那个形状**，"已报 Manager：shared 需要补流水线 job 的表示" |
| `JobToaster.upsert` | "没见过 `job.created` 就不补建 toast" |

三条合起来 = **`blocked` 分支在真实运行中不可达**。这不是"少一条提示"，这是**零报错的卡住**：用户导入一个文件，什么都不会发生，笔记永远停在"处理中"。

修法**不需要动契约**：`JobBlockedEvent` 已经带齐了真正要紧的两件事（`messageZh` 为什么停、`remediation` 怎么办），缺的只是一个标题。按 `blockedCode` 给一个说得出口的名字即可（未知 code 落到"后台任务已暂停" —— 宁可笼统，也不编一个具体但可能是错的名字）。

修后 `[实测]`：

```
POST /api/notes/import -> 202
t=+400ms  暂时无法继续 · 转写任务已暂停
          尚未安装语音识别模型
          这不是失败，条件满足后会自动继续。
          [去安装语音识别模型]  [任务中心]
```

截图 `/tmp/ui-polish/shots/toast-blocked.png`。**琥珀不是红**（它在等依赖，不是失败），时钟图标，按钮文案直接来自服务端的 `remediation.labelZh`。

---

## §7.8 截图

```
/tmp/ui-polish/shots/
├── palette-light.png / palette-dark.png   ★ 配色总览板（全部令牌 + 落到芯片/进度条/卡片/按钮）
├── c-before-light/ c-before-dark/         改前 · 8 页 / 5 页
├── c-after-light/  c-after-dark/          改后 · 同上
├── cmp-light-chips-and-banner.png         ★ 前后对照：状态文字与卡片边界
├── cmp-light-cards.png                    ★ 前后对照：卡片密度与边框
├── cmp-dark-runtime.png                   ★ 前后对照（暗档）：后端芯片语义 + 卡片边界
├── cmp-light-diagnostics.png              前后对照：诊断页三档严重度
├── toast-verifying.png                    ★ §7.7 真样本
└── toast-blocked.png                      ★ §7.7 真样本（修后才存在）
```

对比度全表：`/tmp/ui-polish/contrast-report.txt`。memo.ac 色板取证全文：`/tmp/ui-polish/memoac-color.md`。
状态色清点原始记录：`/tmp/ui-polish/status-inventory.md`。

---

## §7.9 明确**没有**做的事

- **`/models` 目录页 25 条平铺没动。** memo-compare 已定论（R-06 附录 B）：memo.ac 的解法是「语言 × 速度」双轴筛选卡片，任一时刻只显示 1～3 张。**我们少一根轴** —— `quantTier` 是体积轴不是速度轴（tiny-f16 与 large-v3-f16 都落进 `full`，速度差几十倍）。这需要 manifest 加 `speedTier`，属 `model-mgmt`。本轮只做了**已安装**列表的 `<optgroup>` 族分组（呈现层，零 schema 依赖）。
- **LLM 供应商品牌色注册表没做。** memo-compare 已核实 memo.ac 的 24 家供应商**全无 color 字段**，要自定。等 `architect` 的 LLM 配置统一落地后再排。
- **`serious` 一档没有真实截图。** 令牌与校验都做了，但本机构造不出走降级路径的真实场景 —— 标 `[未跑通]`，不假装验过。
- **没有换品牌色相**（理由同上一轮），**没有碰 `components/ui/`**（shadcn 豁免区，ADR-002/005），**没有碰任何业务逻辑与 mutation**（`JobToaster` 的 blocked 修复只加了一个本地字符串，未新增任何网络调用）。
- **表层与 `--data-1..4` 没动** —— 图表色板的六项校验是对着这些表层跑的。
