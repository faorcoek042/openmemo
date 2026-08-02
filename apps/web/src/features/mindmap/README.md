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
架构前提：**`mind-elixir`（可编辑主视图）和 `markmap`（只读大纲视图）都只是这个 schema 的消费者**，不是数据源。
后端存的规范化表（`mindmap_nodes` + `edges` + `summaries` + `node_refs`）才是真相，`MindMapDoc` 是
map-of-nodes（不是嵌套树）+ `extensions` 命名空间的 JSON 表示（D-02 §2）。`packages/mindmap/package.json` 里
`dependencies` 只有 `@openmemo/shared` 一项——刻意的约束：**这个包本身禁止依赖任何渲染库**，加了
`mind-elixir`/`markmap` 依赖就等于违反 ADR-002 决策 3。真正的库桥接
（`MindMapDoc ⇄ mind-elixir NodeObj`、`MindMapDoc → markmap IPureNode`）放渲染适配层
（`features/mindmap/` 内），不要塞进 `packages/mindmap`。

**npm 包名订正**：`mind-elixir-core` 是 GitHub 仓库名，**在 npm 上 404**；真正发布的包名是 `mind-elixir`
（当前锁定 v5.14.0，`apps/web/package.json` 已按此写）。D-01/D-02/ADR-002/R-03/BOARD 都记录了这处订正，
装依赖前认准 `package.json` 里的名字，不要凭记忆写成 `-core`。

容易踩的字段坑：`MindElixirData` **没有 `linkData` 字段**，自由连线只有 `arrows`；`collapsed` 对应
`NodeObj.expanded`，**布尔取反**，语义相反，最容易写反（均见 D-02 §2.3 已核实的字段映射表）。

## markmap：直接构造 `IPureNode`，绕开两次有损转换

`markmap-lib` 的 `transform()` **只接受 Markdown 字符串**（内部走 `markdown-it` → HTML → `buildTree`），
不能直接喂 JSON 树；但 `markmap-view` 的 `Markmap.create()` 接受的是 `IPureNode` 对象
（`{ content: string; payload?: { fold?: number; […] }; children: IPureNode[] }`）。

如果照直觉写"`MindMapDoc` → 转成 Markdown 字符串 → 喂给 `transform()` → 拿到树 → 渲染"，等于把一份结构化数据
先降级成文本、再解析回结构，中间经过 `markdown-it` 通用解析器，**两次有损转换**。正确做法是
**由 `MindMapDoc` 直接构造 `IPureNode` 树**，喂给 `Markmap.create()`，完全绕开 `transform()`。
`toMarkdown(doc)` 只在**导出** Markdown 文件、"编辑 Markdown 源"这类显式入口用，**不出现在渲染路径上**
（D-02 §2.3 已核实，直接读了 `markmap-lib` v0.18.12 的 `transform.ts` 源码确认）。

字段映射：`text`/`richMd` → `content`（要求是 **HTML 字符串**，不是 Markdown，`richMd` 需要先渲染成安全 HTML
再塞进去）；`children` → `children`；`collapsed` → `payload.fold`（非 0 即折叠）；`refs`/`meta` 塞进
`payload` 的自定义键，markmap 会原样保留、不解释。

## 切到 markmap 只读视图必须提示能力损失

渲染器切换器是 `[编辑视图 mind-elixir] / [大纲视图 markmap]`（D-05 §4.6）。`IPureNode` 没有 `edges`
（自由连线）、`summaries`（概要）、逐节点 `style`、`icons` 对应字段，切换时这些信息**不会显示**，
不是 bug，是格式本身的表达力差异（D-02 §2.3 损失矩阵已核实）。**每次切到 markmap 视图都必须提示损失**，
文案参考 D-05 §4.6 给的例子："该视图不显示 N 条关联线与节点样式"（N 用当前文档的 `edges.length` 动态填）。
不要做成一次性 Toast 就完事——用户可能来回切换视图，每次切换都应该能看到（可以是切换按钮旁的常驻小字提示，
不需要每次都弹阻断层，阻断对话框按 D-05 §5.1 只留给两种全局场景，这不是其中之一）。

## 位图导出：SVG 序列化 + scale，禁止 html2canvas 截屏

导出走 `packages/mindmap` 直出（MD/OPML/FreeMind/JSON/SVG/PNG）。PNG/JPG 这类位图导出**必须用 SVG 序列化后
指定 `scale` 渲染，禁止用 `html2canvas` 截屏拿图**。这条是从竞品踩过的坑里抄来的教训：memo.ac 的 GitHub
issue #133 标题就是"思维导图下载图片，字看不清楚"——它们的实现正是 `html2canvas` 截屏（R-01 §C10 #8 实地翻了
memo.ac 的 bundle，`html2canvas` 出现 10 次），截屏方案在高 DPI 缩放下天然糊字，issue 最后"已关闭"但没修，
说明这类问题上线后很难补救。SVG 是矢量的，序列化后按需要的分辨率栅格化不会糊，`mind-elixir` 和 `markmap`
都原生支持导出 SVG，直接用。

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

## 必须导出的两个分片

- `Mindmap.routes.tsx` 导出 `/notes/:noteUid/mindmap` 的路由片段，由 `src/routes.tsx` 聚合。
- `sse.ts` 导出 `mindmapSse: SseBinding`，绑定 `mindmap.started` / `mindmap.delta` / `mindmap.done` /
  `mindmap.failed` 四个事件，由 `lib/events/bindings.ts` 聚合。

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
├── components/            MindElixirCanvas / MarkmapView / RendererSwitcher / ExportMenu …
└── hooks/                 useMindmapDelta（消费 mindmap.delta 做增量拼装）…

packages/mindmap/src/
├── index.ts               当前是占位骨架（T-011 建的），MindMapDoc 类型/normalize()/toMarkdown() 等由你实现
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
