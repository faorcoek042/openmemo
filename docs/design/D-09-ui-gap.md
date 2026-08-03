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
