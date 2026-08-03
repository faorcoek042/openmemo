# `features/` —— Wave 3 并行主战场

这份文件是三个 feature owner（T-021 / T-022 / T-023）共同的地基说明。
具体到某个目录的规则见同级子目录的 `README.md`：
[`models/README.md`](./models/README.md)（T-022）、
[`runtime/README.md`](./runtime/README.md)（T-022）、
[`mindmap/README.md`](./mindmap/README.md)（T-023）。
本文件不重复子文件的细节，只讲**所有 feature 共用的形状与规则**。全部依据 `docs/design/D-05-frontend.md` §3，
有分歧以 D-05 原文为准，本文件过期时以 D-05 为准并请更新本文件。

## 为什么需要这份文件

三个任务要同时改同一个仓库。传统做法（大家都改 `routes.tsx`、都改全局 store）在一周后必然合不进去。
D-05 §3 的解法是**结构性**的，不是"记得别同时改"这种君子协议：
每人独占一个 `features/<name>/` 目录，两个天然的多方冲突点（路由聚合、SSE 绑定聚合）被拆成"每人写自己的分片，聚合文件只 import"。
读完这份文件应该能做到：不用跟另外两个任务的人开会，也知道往哪写、别人会怎么用你的产出。

## 所有权矩阵（硬约束，D-05 §3.2）

| 路径 | 独占 owner | 其他人 |
|---|---|---|
| `features/capture,notes,transcript,player,recorder,search,tasks,settings/**` | T-021 | 只读 |
| `features/runtime,models/**` | **T-022** | 只读 |
| `features/mindmap/**` + `packages/mindmap/**` | **T-023** | 只读 |
| `app/`、`lib/`、`components/`、`styles/`、`main.tsx`、`App.tsx`、`routes.tsx` | T-021 首建，之后为共享区 | 见下方"共享区变更协议" |

"只读"是字面意思：改别人目录里的文件，即使你觉得是顺手修个 bug，也会在合并时造成谁都说不清的冲突。发现问题 → 在
`coordination/inbox/<对方>.md` 提一句，或走 `DISPUTE:` 条目（`coordination/PROTOCOL.md` §1）。

## 每个 feature 内部的标准形状（D-05 §3.1）

```
features/<name>/
├── index.ts            对外唯一出口（正常情况下**没有别的 feature 会 import 它**，见下方依赖方向规则）
├── <Name>.routes.tsx   ★ 导出本 feature 的路由片段，由 src/routes.tsx 聚合
├── sse.ts              ★ 导出本 feature 的 SSE 绑定片段，由 lib/events/bindings.ts 聚合
├── api.ts              本域的 Query/Mutation hooks，用 app/query.ts 里的 qk 工厂取 key
├── store.ts             本域的 Zustand 切片（可选，只在需要跨组件共享瞬时状态时才建）
├── components/          本域私有组件（默认放这里，不要预判"以后会被复用"）
└── hooks/
```

统一形状的意义很直接：三个任务互相读代码时不用重新学一遍目录结构，`<Name>.routes.tsx` 和 `sse.ts` 这两个文件名
是硬约定，不是建议——聚合文件靠它俩才能自动发现你的 feature。

## 两个必须导出的分片：反冲突的核心手法

`routes.tsx`（应用路由表）和 `lib/events/bindings.ts`（SSE 绑定注册）是天然的三方冲突热点——每个 feature
都要往里加东西。如果三个人都直接改这两个文件，几乎每次提交都会在这两处产生合并冲突，而且冲突通常是"数组里加一行"
这种看似无害、实则每次都要人工合并的类型。

解法：这两个文件**只做聚合**，具体内容来自每个 feature 自己导出的分片：

- `<Name>.routes.tsx` 导出一个路由片段数组（React Router 的 `RouteObject[]` 或等价类型），
  `src/routes.tsx` 只 `import` 并 `...` 展开。
- `sse.ts` 导出一个 `SseBinding`（`(qc: QueryClient) => (() => void)[]`），
  `lib/events/bindings.ts` 只 `import` 并塞进数组依次调用。已经落地的参考实现见
  [`lib/events/bindings.ts`](../lib/events/bindings.ts) —— 注意它现在只聚合了 T-021 的 `notesSse` / `tasksSse`，
  T-022 / T-023 认领后各自在文件顶部按注释处追加一行 `import` + 一个数组项，不改其余内容。

**效果**：你只改自己 feature 目录里的那一个文件；聚合文件在 Wave 3 开工时由 T-021 一次性建好，之后基本不动，
新增一个 feature 才动一行。这是 D-05 全文档里被明确标注"最有实用价值"的一条设计，请不要绕开它直接改聚合文件——
哪怕只是"顺手加一行"，也会制造出下一个人要手工合并的冲突。

## 依赖方向规则（eslint 强制，D-05 §3.5）

```
features/*  ──可以──>  app/ · lib/ · components/ui · components/common · @openmemo/shared
features/A  ──禁止──>  features/B          ★ 横向依赖，需要复用就走"提升"
components/ui     ──禁止──> features/* · lib/api    （保持纯展示，可独立预览）
components/common ──禁止──> features/*
lib/*              ──禁止──> features/* · components/*
```

理由很直白：横向依赖（`features/A` import `features/B` 的东西）是"三个人并行开发、一周后合不进去"最常见的死法——
一旦 A 依赖了 B 内部的某个组件，B 的任何重构都可能悄悄破坏 A，而 B 完全不知道 A 在用它。
禁止横向依赖之后，唯一的复用路径就是**提升到 `components/common/`**，提升动作强制要 inbox 申报（见下），
冲突在结构上就被消灭了，不用靠自觉。

## 共享区变更协议（D-05 §3.3）

1. **默认只读**——`app/` `lib/` `components/` `styles/` 不是你的目录。
2. **只增不改优先**：往 `components/common/` 或 `lib/` 新增文件不需要申报，但要遵守本文的命名与依赖规则。
3. **修改既有共享文件**：先在 `coordination/inbox/<自己>.md` 写一行
   `SHARED-CHANGE: <路径> — <原因>`，再改。先申报后改，Manager 事后审——不是等批准，是留痕迹方便回溯冲突原因。
4. **提升（promotion）**：一个组件被第二个 feature 需要时，才把它从 `features/X/components/` 移到 `components/common/`，
   移动方必须在 inbox 申报一行 `PROMOTE: <原路径> → components/common/<Name>.tsx`。
   不要预先猜测哪些组件会被复用——过早提升会造出没人用的抽象，之后没人敢删。
5. **`components/ui/`（shadcn）**：只能通过 CLI 新增，且必须在 `components/ui/SOURCE.md` 追加一行记录。
   禁止手改已生成组件；要做变体用 `cva` 在 `components/common/` 包一层，不要碰 `ui/` 原文件。

## 命名约定（D-05 §3.6）

| 类型 | 约定 | 例 |
|---|---|---|
| 组件文件 | `PascalCase.tsx`，一个文件一个默认导出组件 | `ModelCard.tsx` |
| hooks | `use*.ts` | `useHardwareProbe.ts` |
| Zustand | `*.store.ts`，导出 `use<Name>Store` | `downloadQueue.store.ts` |
| Query hooks | `api.ts` 内，`useXxxQuery` / `useXxxMutation` | `useModelsCatalogQuery` |
| 路由片段 | `<Name>.routes.tsx` | `Models.routes.tsx` |
| SSE 片段 | `sse.ts`，导出 `<name>Sse` | `models/sse.ts` 导出 `modelsSse` |
| 类型 | 与 `@openmemo/shared` 同名类型禁止本地重定义，一律 import | — |
| i18n key | `<feature>.<区块>.<语义>` | `models.card.fitBadge.blocked` |
| test id | `data-testid="<feature>-<element>"` | `models-download-button` |

## 设计令牌速查（D-05 §7，详见 `styles/tokens.css`）

所有视觉颜色一律用下面这些语义 Tailwind 工具类，**禁止硬编码十六进制颜色**——原因不是洁癖：
`tokens.css` 里每个值都跑过对比度/明度带/CVD 分离校验（见文件头注释），硬编码颜色绕开了这层校验，
主题切换（亮/暗）也会直接失效，因为这些颜色只有语义令牌层会跟着 `[data-theme]` 走。

`bg-surface-0`（页底，也是卡片内的**内嵌**字段：输入框 / pre / 标签片）/
`bg-surface-1`（卡片、侧栏、顶栏）/ `bg-surface-2`（弹层、抽屉、toast）、
`text-ink` / `text-ink-secondary` / `text-ink-muted`、`border-line`、
`hover:bg-fill-hover` / `active:bg-fill-active`（交互填充）、
`bg-accent` / `text-accent-fg` / `text-accent-ink`（链接与选中文字）/ `bg-accent-tint`（品牌淡底）、
`text-good` / `text-warning` / `text-serious` / `text-critical`（状态色）、
`bg-data-1` `bg-data-2` `bg-data-3` `bg-data-4`（分类色，固定顺序：模型/后端/媒体/缓存，超过 4 类归"其他"，不要新造颜色）。

> **T-124 起表层只有两档**：`--surface-2` 与 `--surface-1` 同值，弹层靠 `shadow-e2` + `border-line` 抬升。
> 明档卡片已经是纯白（没有更亮的一档），暗档再亮就压不住主按钮块面的 3:1。
> 因此 **不要再用"表层差一档"表达 hover / 选中**：hover 用 `bg-fill-hover`，
> 选中用 `bg-accent-tint text-accent-ink`（语义，不是层级）。旧写法 `hover:bg-surface-2`
> 在明档实测只有 1.02:1，等于没有反馈。

### 状态色的硬规则

**状态绝不只用颜色表达，必须图标 + 文字标签同时出现。** 这不是审美偏好：`--status-warning` 在亮色背景下对比度只有
1.79:1，`--status-serious` 只有 2.57:1，两者都低于 WCAG 的 3:1 门槛——这是校验脚本跑出来的事实，
是**设计取舍**（换成达标的颜色会牺牲彩度/可读性），不是漏做校验。缓解手段就是图标 + 标签兜底：
色弱用户或对比度不够的场景，文字和图标仍能传达状态。任何地方画一个纯色圆点/纯色徽标表示状态，评审都不会通过。
状态色也不得被拿来当"第 5 个分类色"用，否则状态语义就废了。
