-

> ⚠️ **2026-08-07 订正：markmap 已整块摘除**（T-165b，`1b4df67`）。
> 适配器文件、两个 npm 依赖、界面那句「切到大纲视图将不显示 N 条关联线」全部删除 ——
> **产品里从来没有大纲视图**，那句话描述的功能不存在，所以是删除而不是改写。
> 本文中凡提到 markmap 的段落**均已不成立**，保留原文仅供追溯。
> ⚠️ **`toMarkdown` 不属于 markmap**，它在 `serialize/`（与 `toOpml`/`toFreeMind` 同侪），
> 且是 `GET /api/notes/:uid/export?what=mindmap&format=md` 的实现 —— **不要跟着一起删**。
> \--
> id: ADR-006
> title: 架构决策裁决（architect T-010 提交的 8 项）
> status: accepted
> date: 2026-08-02
> decider: Meta Manager
> input: docs/design/D-01-architecture.md, D-02-data-model.md, coordination/inbox/architect.md

---

## 决策 1：API Key 存储 = **明文 0600 + 明确告知**

采纳 `architect` 倾向。理由：`keytar` 已归档；我们是 web-first 无 Electron 架构，
接 OS keychain 跨平台成本高且不合拍；用户已定"仅个人自用"。

**强制条件**：设置页必须**显式告知**"API Key 以明文存储在 `<路径>`，权限 0600"，
不许含糊。schema 保留 `enc` 字段，日后可无损升级。

## 决策 2：端口 = **17650 固定**，冲突时确定性递增 + 明确警告

采纳。`architect` 的洞察是对的：**麦克风授权按 origin 隔离，端口一变 F3 每次要重新授权**
——这是固定端口的硬理由，不是偏好。

**补充规则**（`architect` 未覆盖的冲突场景）：

- 17650 被**我们自己的实例**占用 → 单实例锁生效，聚焦已有窗口，不启新进程。
- 17650 被**他人**占用 → 依次尝试 17651…17659，并在 UI **明确警告**
  "端口已变更，浏览器会要求重新授权麦克风"。不许静默漂移。
- "端口绑定即单实例锁"（原子、崩溃自动释放）这个设计**批准**，优于 lockfile。

## 决策 3：L0 浏览器 WebGPU 档 —— **降级为实验特性，不进 v1**

采纳 `architect` 的降级建议，并补充**我的理由**（这修订 ADR-003 的降级链）：

L0 的原始卖点是"零安装即可试用"。但**这个场景不存在**——用户必须先装 daemon 才能打开网页，
而 daemon 自带 L1 内置 CPU 后端（8–20MB，永不失败）。**L0 相对 L1 的边际价值很小。**

保留的唯一价值：AMD/冷门 GPU 上我们的原生后端全部失败时，WebGPU 或许还能用。
→ 保留为**实验特性**，`/ws/asr-worker` 协议**不进 v1**，不占 Wave 3 关键路径。

**ADR-003 的降级链修订为**：L1 内置 CPU（兜底）→ L2 按需下载加速后端；L0 移至实验。

## 决策 4：**不引入 workspace 层级**

采纳。只做 folders 树。日后要加只需一列 + 一次迁移，成本可控。避免过早抽象。

## 决策 5：双 ID 约定（内部整数 PK + 对外 ULID）—— **批准，已转达 T-013**

`architect` 指出这不是洁癖：FTS5 外部内容表的 `content_rowid` 与 sqlite-vec 的 rowid
关联**都要求整数**。技术强制。D-03 必须与 D-02 对齐。

## 决策 6：翻译 / 双语字幕 / 字幕导出 —— **不进 v1**

章程 F1–F5 未包含。memo.ac 有 30 个相关 IPC 通道，但那是它的范围不是我们的。
D-02 已预留表结构，**保留预留，不实现**。范围纪律优先。

## 决策 7：Node 基线 = **22**（`engines: ">=22"`）

采纳。依据 `architect` 核实：`better-sqlite3` v13 硬性要求 Node ≥ 22。
本机是 24.18.0，无冲突。需 `oss-scout`（`.nvmrc`/`engines`）与 `gpu-runtime`（CI matrix）同步。

## 决策 8：`mind-elixir-core` → `mind-elixir` —— **已订正 ADR-002**

纯事实订正（`architect` 核实上游：`mind-elixir-core` 在 npm 404，正确包名 `mind-elixir` v5.14.0）。
决策实质不变。**`oss-scout` 需检查 `package.json` 是否装错了包。**

`architect` 另核实：markmap 的 `Markmap.create()` 吃 `IPureNode`，可**直接构造节点树**，
省掉"我们的 schema → Markdown → markmap"两次有损转换。→ 这正好服务 ADR-002 的
"数据模型库无关"要求，`packages/mindmap` 按此实现。

## 附：所有权表补充

`packages/mindmap/**` 原**无 owner**。指派给 Wave 3 的 **T-023（思维导图生成与编辑）**。

## 附：上游报告订正（`architect` 核实）

- R-01 判定 memo.ac「无标签系统」**有误** —— `tag`/`note_tag`/`doc_tag` 三表实际存在。
- R-01「7 个 migration 文件 `[BIN]`」在 asar 中无法复现；memo.ac 实际**无任何 schema 版本机制**。
- → 已知会 `memo-researcher`。**R-01 的证据等级标签需复核**，其余结论不受影响。
