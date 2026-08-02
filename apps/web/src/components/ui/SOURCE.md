# shadcn/ui —— C2 豁免目录

> 依据：**ADR-002 决策 2**（唯一一项 C2「禁止复制粘贴源码」豁免）。

## 为什么这个目录是例外

shadcn/ui 的分发模式**就是**把源码复制进你的项目——它没有可依赖的上游 npm 包，
"你拥有这些代码"是它的设计意图。因此 ADR-001 的三分法（submodule / 包管理器 / 运行时下载）
对它都不适用。

## 豁免的两个条件（**必须遵守，否则豁免失效**）

1. **隔离**：所有 shadcn/ui 组件只能放在本目录（`apps/web/src/components/ui/`），
   不得与业务组件混放。业务组件放 `apps/web/src/components/` 的其他子目录。
2. **可追溯**：每次通过 CLI 添加组件后，**必须**在下方表格追加一行，
   记录来源 URL、添加日期、以及当时的 `shadcn` CLI 版本。
   这是维持 C2 立法本意（可追溯上游）的唯一手段。

## 来源与许可证

- 上游：https://github.com/shadcn-ui/ui
- 文档：https://ui.shadcn.com
- 许可证：**MIT**
- 底层依赖：Radix UI Primitives（MIT）、`class-variance-authority`（Apache-2.0）、
  `clsx`（MIT）、`tailwind-merge`（MIT）、`lucide-react`（ISC）
  —— 这些是正常的 npm 依赖（ADR-001 B 类），已声明在 `apps/web/package.json`。

## 已复制的组件清单

> 目前为空 —— T-011 只建目录与本说明文件，尚未添加任何组件。
> 添加者请照抄下面的表头格式追加行。

| 组件 | 来源 URL | shadcn CLI 版本 | 添加日期 | 添加者 |
| ---- | -------- | --------------- | -------- | ------ |
| _（无）_ | | | | |
