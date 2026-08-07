# `features/mindmap/` —— 思维导图（F4）

**Owner：T-023。其他人只读**——改动请走 `features/README.md` 的共享区协议，不要直接改这个目录。
你同时独占 `packages/mindmap/**`（库无关的数据模型包），两者是同一个功能的两层，一起认领。

统一的目录形状、分片导出契约、依赖方向规则、设计令牌速查见上级 [`features/README.md`](../README.md)，本文件只写
`mindmap` 特有的部分。

## 职责范围（D-05 §1.2 路由表）

| 路由 | 页面 | 职责 |
|---|---|---|
| `/notes/:noteUid/mindmap` | 导图全屏 | F4：编辑、布局、导出 |

此外，`/notes/:noteUid` 笔记详情页右侧有一个 `?tab=mindmap` 的内嵌 Tab（该页面本身归 T-021），路由表原文
标注"导图 Tab 内嵌 T-023 的组件"——这是**唯一被明确允许的跨 feature 引用**：T-021 通过你的
`features/mindmap/index.ts` 导入只读预览组件嵌进笔记详情页。除此之外不要假设自己的组件会被别人 import，
`index.ts` 之外的东西默认视为 `features/mindmap` 私有。

## 数据模型库无关：`MindMapDoc` 是唯一事实来源

`packages/mindmap` 定义自己的 schema（`MindMapDoc`），这是 ADR-002 决策 3 的硬性要求，也是本 feature 最重要的
架构前提：**`mind-elixir`（可编辑主视图）只是这个 schema 的一个消费者**，不是数据源。
后端存的规范化表（`mindmap_nodes` + `edges` + `summaries` + `node_refs`）才是真相，`MindMapDoc` 是
map-of-nodes（不是嵌套树）+ `extensions` 命名空间的 JSON 表示（D-02 §2）。`packages/mindmap/package.json` 里
`dependencies` 只有 `@openmemo/shared` 一项——刻意的约束：**这个包本身禁止依赖任何渲染库**，加了
`mind-elixir` 依赖就等于违反 ADR-002 决策 3。真正的库桥接
（`MindMapDoc ⇄ mind-elixir NodeObj`）放渲染适配层（`features/mindmap/` 内），不要塞进 `packages/mindmap`。

**npm 包名订正**：`mind-elixir-core` 是 GitHub 仓库名，**在 npm 上 404**；真正发布的包名是 `mind-elixir`
（当前锁定 v5.14.0，`apps/web/package.json` 已按此写）。D-01/D-02/ADR-002/R-03/BOARD 都记录了这处订正，
装依赖前认准 `package.json` 里的名字，不要凭记忆写成 `-core`。

容易踩的字段坑：`MindElixirData` **没有 `linkData` 字段**，自由连线只有 `arrows`；`collapsed` 对应
`NodeObj.expanded`，**布尔取反**，语义相反，最容易写反（均见 D-02 §2.3 已核实的字段映射表）。

## ★ T-165：**没有大纲视图，markmap 已整块摘除**

> 这一节此前是两节：「markmap：直接构造 `IPureNode`，绕开两次有损转换」与
> 「切到 markmap 只读视图必须提示能力损失」。**两节描述的东西都不存在了**，所以是删不是改。

`markmap-lib` / `markmap-view` 两个依赖 **全仓零 import**，
`packages/mindmap` 的 `adapters/markmap.ts`（`toMarkmap` / `markmapLoss` / `IPureNode`）**零产品调用方**。
本轮把依赖、适配器、以及界面上那句提示**一起**删掉。

**判据不是"没用上所以删"，是"留着它界面就在说一句假话"**：
`MindmapView` 会渲染「切到**大纲视图**将不显示 N 条关联线与 M 个概要」，
而那个视图用户点不到；更进一步，那两样东西在现有的**任何**一条路径上都不会丢
——SVG/PNG 导出走的是 mind-elixir 的实时画布，自由连线与概要都在。
所以也**没有一句真话可以拿来替换它**，只能删。
（先例：T-153 摘掉 `wavesurfer.js`，同样是"零 import + 已有替代实现"。）

选型本身没有变，而且这次摘除正是**兑现**它：用户的原话是"**整理**思维导图"，
整理 = 编辑，是主路径；markmap 是 Markdown → 图的单向渲染器，编辑能力弱。
D-01 / D-02 / D-05 / ADR-006 里关于 markmap 的段落**尚未同步**（那些是 architect / Manager 的交付物，
本 feature 不改别人的文档）——读到那几段时以本节为准。

⚠️ **`toMarkdown()` 保留，它不是 markmap 的一部分**：
它是 `GET /api/notes/:uid/export?what=mindmap&format=md` 的实现
（`apps/daemon/src/http/rest/content.ts` 的 `exportMindmap()`），删它会打掉一个真功能。

## 位图导出：SVG 序列化 + scale，禁止 html2canvas 截屏

导出走 `packages/mindmap` 直出（MD/OPML/FreeMind/JSON/SVG/PNG）。PNG/JPG 这类位图导出**必须用 SVG 序列化后
指定 `scale` 渲染，禁止用 `html2canvas` 截屏拿图**。这条是从竞品踩过的坑里抄来的教训：memo.ac 的 GitHub
issue #133 标题就是"思维导图下载图片，字看不清楚"——它们的实现正是 `html2canvas` 截屏（R-01 §C10 #8 实地翻了
memo.ac 的 bundle，`html2canvas` 出现 10 次），截屏方案在高 DPI 缩放下天然糊字，issue 最后"已关闭"但没修，
说明这类问题上线后很难补救。SVG 是矢量的，序列化后按需要的分辨率栅格化不会糊，`mind-elixir`
原生支持导出 SVG，直接用。

## 渐进渲染：消费 `mindmap.delta` 事件

生成过程走 `mindmap.delta` 渐进渲染（D-01 §5 F4、D-05 §11.3），**不要转圈等结果一次性回来**——LLM 生成一份
导图可能要几十秒，全程转圈等待的体验很差，服务端已经把流式产出按 ~250ms 批量成组发给你了。

事件序列（`packages/shared` 的 `MindMapNodeDraft`）：`mindmap.started`（1 条，含 `mindmapUid`/`jobId`）→
`mindmap.delta`（**data 类，有序必达，`seq` 单调递增，`nodes: MindMapNodeDraft[]`**，按 `seq` 顺序应用到
本地树，不要假设一次收全）→ `mindmap.done`（1 条，`nodeCount`/`edgeCount`/`revision`，落库后触发，此时要用
权威数据替换掉增量拼出来的草稿树，避免累积误差）→ 失败走 `mindmap.failed`，留意其
`degradedTo: 'heuristic' | null` 字段——`'heuristic'` 是"没有可用 LLM 时的启发式大纲"降级（D-01 §7.2），
UI 要说清楚"未配置 AI 模型，已生成基础大纲"（D-05 §5.2 原文），不要当普通失败处理。

最终规范化由 `packages/mindmap` 的 `normalize()` 做——流式阶段的 `MindMapNodeDraft`（`key`/`parentKey`/
`text`/`refs`）只是草稿，字段形状跟最终 `MindMapDoc` 不同，`done` 事件之后要切到规范化后的 `MindMapDoc`。

`summary.*` 事件（`summary.delta`/`summary.done`）虽然在 D-05 §11.3 和 `mindmap.*` 放在同一张表里（因为都是
"结构化域"、都是流式产出），但那是纯文本摘要 Tab 的数据，**不属于这个 feature**，你的 `sse.ts` 不需要绑定它。

## 必须导出的分片

- `Mindmap.routes.tsx` 导出 `/notes/:noteUid/mindmap` 的路由片段，由 `src/routes.tsx` 聚合。

> ⚠️ **订正（T-139，实测）**：这里原来还写着"`sse.ts` 导出 `mindmapSse`，绑定
> `mindmap.started/delta/done/failed` 四个事件"。**那个文件不需要存在，那四个事件里有两个 daemon 从不发。**
>
> daemon 在导图落库后同时发 `mindmap.done` 与 `note.updated{changed:['mindmap']}`，
> 而 `features/notes/sse.ts` 一直订阅着后者并 invalidate `qk.mindmap(noteUid)`；
> `mindmap.started` / `mindmap.failed` 全仓无人发布，`mindmap.delta` 被 runner **刻意不发**
> （`runners/mindmap.ts` 里写明理由：契约要求 `mindmapUid`，而它要落库后才有）。
> 再补一个 `mindmapSse` 只会造出第二个"导图变了"的触发源，且它覆盖不到手工编辑的 `PATCH`
> 那条路径（那条只发 `note.updated`）。
>
> "生成完页面不更新"的真正原因在 `MindmapView.tsx`（渲染器不换图），已修；
> 取证过程见 `coordination/inbox/notes-contract.md` §C10。

**为什么是分片导出而不是直接改聚合文件**：这两个聚合文件同时被 T-021/T-022/T-023 三方写，直接改会在几乎每次
提交里产生"数组里加一行"式的合并冲突。分片模式下你只改 `features/mindmap/Mindmap.routes.tsx` 和
`features/mindmap/sse.ts` 这两个自己独占的文件，聚合文件里对应的 `import` 由建立聚合文件的一方（T-021）在你
认领后加一行——你不用等，也不用碰那两个共享文件。参考已落地的聚合实现：
[`lib/events/bindings.ts`](../../lib/events/bindings.ts)，命名照抄它现在给 `notes`/`tasks` 的模式。

## 目录标准形状

```
features/mindmap/
├── index.ts             对外唯一出口：全屏页面 + 供 T-021 内嵌的只读预览组件
├── Mindmap.routes.tsx
├── sse.ts
├── api.ts                useMindmapQuery / useMindmapExportMutation …（qk.mindmap(noteUid) 已在 app/query.ts 预留）
├── store.ts               编辑态（选中节点、折叠状态、渲染器切换）的瞬时状态，可选
├── components/            MindElixirCanvas / ExportMenu …（没有 RendererSwitcher：只有一个渲染器）
└── hooks/                 useMindmapDelta（消费 mindmap.delta 做增量拼装）…

packages/mindmap/src/
├── index.ts               MindMapDoc 类型 / normalize() / toMarkdown() 等（toMarkdown 是导出端点在用的那一份）
```

## 可以用 / 不可以用

可以：`app/`、`lib/`（含 `lib/api`、`lib/format`）、`components/ui`、`components/common`、`@openmemo/shared`、
`@openmemo/mindmap`（你自己的包）。

不可以：import 其它 `features/*`（`features/notes`、`features/models` 等）。需要复用就走"提升到
`components/common` + 在 `coordination/inbox/<自己>.md` 申报"。反过来，T-021 从 `features/mindmap/index.ts`
引入你的只读预览组件是唯一的例外（见上文"职责范围"一节），你要保证这个导出的组件接口稳定，改 props 形状
最好先在 inbox 说一声，免得把 T-021 的笔记详情页悄悄弄坏。

## 设计令牌与状态色

颜色一律用上级 README 列出的语义类（`bg-surface-*`、`text-ink*`、`bg-accent*`、
`text-good/warning/serious/critical`、`bg-data-*`），禁止硬编码十六进制——节点的自定义颜色（`style.color`/
`branchColor`）是用户数据本身，不受此约束；但**导图之外的 UI 外壳**（工具栏、渲染器切换器、导出菜单、
生成中/失败提示）必须用令牌。生成失败、LLM 降级到启发式大纲这类状态必须图标 + 文字标签同时出现，
不能只变色——例如降级提示用 `text-warning` 配 ⚠️ 图标和"已生成基础大纲"文字，而不是单纯给条幅换个颜色。
