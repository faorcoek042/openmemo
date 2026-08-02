# `features/runtime/` —— 运行时与加速后端（章程要求 2.1）

**Owner：T-022。其他人只读**——改动请走 `features/README.md` 的共享区协议，不要直接改这个目录。

统一的目录形状、分片导出契约、依赖方向规则、设计令牌速查见上级 [`features/README.md`](../README.md)，本文件只写
`runtime` 特有的部分。

## 职责范围（D-05 §1.2 路由表）

| 路由 | 页面 | 职责 |
|---|---|---|
| `/runtime` | 运行时与加速后端 | 章程 2.1：硬件卡片、后端包列表、安装/自检/切换 |

## 章程要求 2.1 是什么，为什么这个页面存在

原文（`docs/00-CHARTER.md`）：
> 所有依赖 GPU 的组件，其安装与配置**通过网页完成**——网页检测硬件 → 推荐后端 → 下载对应预编译二进制 →
> 安装 → 自检 → 显示状态。

也就是说这个页面要闭环覆盖**硬件检测 → 推荐后端 → 下载 → 安装 → 自检 → 显示状态**这六步，全程在网页里完成，
用户全程不碰命令行、不手动装 CUDA/驱动、不用去读 README 找二进制链接。D-05 §1.1 解释了为什么"运行时"是侧栏
一级导航而不是埋进设置：memo.ac 把这类功能埋在设置里，导致"模型下载卡 0%"成了 FAQ 里最高频的问题——
一级导航是产品判断，不是审美选择。

## 线框以 R-04 §9 / D-03 为准，D-05 不重画

`/runtime` 的具体线框、字段、交互细节**以 `docs/research/R-04-model-mgmt.md` §9 与
`docs/design/D-03*`（运行时/后端管理设计文档）为准**。D-05 §1.3 只规定三件事：① 这个页面在导航里的位置；
② 必须复用 `components/ui`、`components/common` 与设计令牌；③ 哪个组件要提升到 `components/common/`。
不要凭空发挥交互细节，硬件检测/后端安装的具体流程状态机以 R-04 §7（硬件适配决策逻辑）与 §8（HTTP API 设计）
里的状态机为准。

## 必须导出的两个分片

- `Runtime.routes.tsx` 导出 `/runtime` 的路由片段，由 `src/routes.tsx` 聚合。
- `sse.ts` 导出 `runtimeSse: SseBinding`，绑定后端安装/自检进度相关的事件，由 `lib/events/bindings.ts` 聚合。

**为什么是分片导出而不是直接改聚合文件**：这两个聚合文件同时被 T-021/T-022/T-023 三方写，直接改会在几乎每次
提交里产生"数组里加一行"式的合并冲突。分片模式下你只改 `features/runtime/Runtime.routes.tsx` 和
`features/runtime/sse.ts` 这两个自己独占的文件，聚合文件里对应的 `import` 由建立聚合文件的一方（T-021）在你
认领后加一行——你不用等，也不用碰那两个共享文件。参考已落地的聚合实现：
[`lib/events/bindings.ts`](../../lib/events/bindings.ts)，命名照抄它现在给 `notes`/`tasks` 的模式
（导出 `<name>Sse`，注册进 `BINDINGS` 数组）。

## 目录标准形状

```
features/runtime/
├── index.ts
├── Runtime.routes.tsx
├── sse.ts
├── api.ts            useHardwareQuery / useBackendsCatalogQuery / useBackendsInstalledQuery / useBackendInstallMutation …
├── store.ts           安装/自检进度的瞬时状态，可选
├── components/
└── hooks/
```

`app/query.ts` 的 `qk` 工厂已经预留了 `qk.runtime.hardware` 和 `qk.backends.{catalog,installed}`——直接用，
不要在 `runtime/api.ts` 里重新拼 query key。`qk.runtime.hardware` 在 `app/query.ts` 的 `STALE_TIME_OVERRIDES`
里被标注为要放宽 `staleTime` 到 5 分钟（因为硬件探测实测可达数秒级，不该每次挂载都重跑），沿用这个约定。

## 可以用 / 不可以用

可以：`app/`、`lib/`（含 `lib/api` 的 REST 客户端、`lib/format`）、`components/ui`、`components/common`、
`@openmemo/shared`。

不可以：import 其它 `features/*`（`features/models`、`features/mindmap` 等）。需要复用就走"提升到
`components/common` + 在 `coordination/inbox/<自己>.md` 申报"。注意 `runtime` 和 `models` 虽然都归你
（T-022），但它们仍然是两个独立的 feature 目录，同样不能互相 import——两者的复用件（比如同时要显示"这台机器
能跑什么"的逻辑）也要走提升，不要因为是"自己人"就走捷径：今天省一次申报，以后拆分 ownership 时会很难查清
谁依赖了谁。

## 必须提升的组件：`BackendChip`

后端状态芯片（CUDA/Vulkan/CPU 等，及其安装/可用状态）不止 `/runtime` 用得到——模型详情页要显示"这台机器当前
用哪个后端跑"，任务中心的失败任务里也可能要显示"因为后端未安装而 blocked"。从一开始就建在
`components/common/BackendChip.tsx`，不要先放 `features/runtime/components/` 再挪
（D-05 §3.1 目录树注释明确标出这一项：`BackendChip.tsx   ← 由 T-022 从 features/models 提升`）。
提升动作要在 `coordination/inbox/<自己>.md` 写一行 `PROMOTE: ...` 申报。

## 自检失败必须显示真实原因

这是本 feature 最容易被简化掉、但明确写进了错误映射表（D-05 §5.2）的一条：**后端自检失败**属于"持久条幅"
呈现层级，文案必须给**真实原因**，例如"你的算力架构 sm_120 不被此构建支持"，而不是笼统的"自检失败"或
"出错了"。原因来自 R-01 对 memo.ac 的调研（§C11 #9）：一句"失败"逼用户去翻日志或提 issue，而我们已经在服务端
拿到了具体的失败原因（架构不兼容、驱动版本过旧、二进制损坏等），不透传等于把已知信息又藏回黑箱。
配套动作按钮固定两个：`[改用 CPU]`（L1 CPU 兜底永远可用，ADR-006 决策 3）`[重试自检]`。
同一条规则也适用于"自动降级"场景（比如 CUDA 加载失败自动切到 Vulkan）：必须用一次性 Toast 明确告知，
绝不静默换后端——用户不该靠"感觉变慢了"发现后端被换掉了（D-05 §5.3 三条呈现原则第一条）。

## 设计令牌与状态色

颜色一律用上级 README 列出的语义类（`bg-surface-*`、`text-ink*`、`bg-accent*`、
`text-good/warning/serious/critical`、`bg-data-*`），禁止硬编码十六进制。`BackendChip` 的已安装/未安装/自检失败
三态必须图标 + 文字标签同时出现，不能只变色——比如自检失败用 `text-critical` 配 ⛔ 图标和"自检失败"文字，
而不是单纯把芯片背景染红：`--status-warning`/`--status-serious` 在亮色背景下对比度不到 3:1，
纯靠颜色区分状态对部分用户是不可读的（详见上级 README 状态色一节）。
