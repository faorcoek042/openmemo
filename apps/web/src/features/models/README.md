# `features/models/` —— 模型管理（章程要求 2.2）

**Owner：T-022。其他人只读**——改动请走 `features/README.md` 的共享区协议，不要直接改这个目录。

统一的目录形状、分片导出契约、依赖方向规则、设计令牌速查见上级 [`features/README.md`](../README.md)，本文件只写
`models` 特有的部分。

## 职责范围（D-05 §1.2 路由表）

| 路由 | 页面 | 职责 |
|---|---|---|
| `/models` | 模型管理 | 章程 2.2：目录、量化选择、fit 徽标、下载、导入、存储 |
| `/models/:modelId` | 模型详情 | 变体、许可证、跑基准 |

`/settings/storage` 也归你（复用你的 storage API，见 D-05 §1.2 该行）；`/settings/asr` 的模型选择器和
`/onboarding` 的装模型步骤**复用你导出的组件**，但那两个页面本身分别归 T-021 / T-021+T-022 共建，不是你的路由。

## 线框以 R-04 §9 / D-03 为准，D-05 不重画

`/models` `/models/:id` `/settings/storage` 的具体线框、字段、交互细节**以
`docs/research/R-04-model-mgmt.md` §9（UI 线框图）与 `docs/design/D-03*`（模型管理设计文档）为准**。
D-05 §1.3 明确说了它只定三件事：① 这些页面在导航里的位置；② 必须复用 `components/ui`、`components/common`
与设计令牌；③ 哪些组件要提升到 `components/common/`。不要照着 D-05 的只言片语重新设计交互，R-04 §9 已经画好了
主页面、量化选择器展开态、下载中状态（行内+抽屉）、详情弹层、空态五张线框图，直接抄。

R-04 §9.6 给了几条容易漏掉的实现约束，摘几条最容易踩坑的：
- 挂载顺序是**先并行拉 `catalog`/`jobs`/`storage` 快照，再订阅 SSE**，反过来会漏事件或重复计数。
- 下载进度节流到 ≥200ms 更新一次（服务端也限流到 4 次/秒/job），不然 8MB/s 下载会把 React 渲染打满。
- `unsupported` 档**不禁用下载按钮**，点击弹二次确认即可——估算必然有误差，硬禁用会把"估算可能错"变成
  "功能缺失"，用户没法自救。唯一真正禁用的是 `blocked`（磁盘不够是确定性事实）。

## 必须导出的两个分片

- `Models.routes.tsx` 导出 `/models`、`/models/:modelId` 的路由片段，由 `src/routes.tsx` 聚合。
- `sse.ts` 导出 `modelsSse: SseBinding`，绑定模型下载/校验相关的 `job.progress`（`kind` 过滤模型域）等事件，
  由 `lib/events/bindings.ts` 聚合。

**为什么是分片导出而不是直接改聚合文件**：`routes.tsx` 和 `bindings.ts` 同时被 T-021/T-022/T-023 三方写，
直接改会在几乎每次提交里产生"数组里加一行"式的合并冲突。分片模式下你只改
`features/models/Models.routes.tsx` 和 `features/models/sse.ts` 这两个自己独占的文件，聚合文件里对应的
`import` 由建立聚合文件的一方（T-021）在你认领后加一行——你不用等，也不用碰那两个共享文件。
参考已落地的聚合实现：[`lib/events/bindings.ts`](../../lib/events/bindings.ts)，命名照抄它现在给 `notes`/`tasks`
的模式。

## 目录标准形状

```
features/models/
├── index.ts
├── Models.routes.tsx
├── sse.ts
├── api.ts            useModelsCatalogQuery / useModelsInstalledQuery / useModelsStorageQuery / useModelPullMutation …
├── store.ts           下载队列的瞬时状态（进度、暂停/取消），可选
├── components/
└── hooks/
```

`app/query.ts` 的 `qk` 工厂已经预留了 `qk.models.{catalog,installed,storage,sources}` 和
`qk.backends.{catalog,installed}`（后者是 runtime 用的，但模型详情页要显示"这台机器能不能跑"也会用到）——
直接用，不要在 `models/api.ts` 里重新拼 query key 字符串数组。

## 可以用 / 不可以用

可以：`app/`、`lib/`（含 `lib/api` 的 REST 客户端、`lib/format`）、`components/ui`、`components/common`、
`@openmemo/shared`。

不可以：import 其它 `features/*`（`features/runtime`、`features/mindmap` 等）。需要复用就走"提升到
`components/common` + 在 `coordination/inbox/<自己>.md` 申报"，不要图省事直接 import 邻居的组件——
横向依赖是三方并行合不进去的头号原因（见上级 README 的依赖方向规则一节）。

## 必须提升的两个组件：`ModelPicker` / `FitBadge`

这两个组件用到的地方不止 `/models`：`/settings/asr` 的默认转写模型选择器、`/onboarding` 第三步"装第一个 ASR
模型"都要用同一套选择器和 fit 徽标（D-05 §1.3 第③条硬约束）。因此**从一开始就把它们建在
`components/common/ModelPicker.tsx` 和 `components/common/FitBadge.tsx`**，不要先放进
`features/models/components/` 再"以后需要时挪"——这是 D-05 §3.1 目录树注释里明确标出的提升项
（`ModelPicker.tsx  BackendChip.tsx  FitBadge.tsx   ← 由 T-022 从 features/models 提升`），提前知道会被复用，
就不用等"第二个 feature 需要时才提升"这条默认规则。提升动作仍然要在 `coordination/inbox/<自己>.md`
写一行 `PROMOTE: ...` 申报，留痕迹。

## fitness 只渲染，不重算

`packages/shared/src/api.ts` 里 `fitness: FitResult` 字段的注释写得很直白：
"Computed server-side. The web UI renders this and MUST NOT recompute the rules — a second implementation
would drift from fitness.ts." 内存/显存够不够、走哪个 tier（推荐/可跑但慢/跑不动）全部是服务端算好发下来的
`fitness.tier` + `fitness.reason_zh` 之类的字段，前端只管渲染文案和徽标颜色，不要在前端另写一套"能不能跑"
的判断逻辑——两套规则迟早会对不上，而且调试起来分不清是哪一层算错的。

## 设计令牌与状态色

颜色一律用上级 README 列出的语义类（`bg-surface-*`、`text-ink*`、`bg-accent*`、`text-good/warning/serious/critical`、
`bg-data-*`），禁止硬编码十六进制。这个 feature 里最容易犯规则的地方是 fit 徽标和下载进度条：
"推荐"用 `text-good` 配 ✅ 图标，"可跑但慢"用 `text-warning` 配 ⚠️ 图标，"跑不动"用 `text-critical` 配 ⛔ 图标，
**图标和"推荐"/"可跑但慢"/"跑不动"这几个字必须跟颜色一起出现**——warning/serious 两档在亮色背景下对比度不到
3:1（校验脚本实测，见上级 README），只画一个色块用户可能根本看不出区别。存储占用分解条用 `bg-data-1..4`
四色固定顺序（模型/后端/媒体/缓存），必须配图例和字节数标签，不能只画色条。
