---
id: ADR-007
title: 前端决策裁决（architect T-015 提交的 7 项）
status: accepted
date: 2026-08-02
decider: Meta Manager
input: docs/design/D-05-frontend.md, coordination/inbox/architect.md
---

## 决策 1：`SSE_EVENT_TYPES` 必须扩展 —— **最高优先级，Wave 3 硬阻塞**

`architect` 发现 `packages/shared` 的 `SSE_EVENT_TYPES` **只有 14 个事件，全是模型/下载域**，
F1–F5 的实时事件（`transcribe.segment` / `mindmap.delta` / pipeline `job.progress` / `note.*`）
**一个都没有**。

缺了它们，"14 秒后就有字"、流式字幕、渐进式导图**全部塌掉**，T-021/T-023 只能先写轮询再返工。

**裁决**：

- **规格由 `architect` 出**（写进 D-05，含事件名 + payload 形状 + 触发时机）。
- **实现由 `model-mgmt` 做**（他独占 `packages/shared`，不改所有权、不破坏边界）。
- **优先级高于 T-013 的其余部分。** 已直接转达。

## 决策 2：`ApiErrorBody` 补 `remediation?: {action, params}` —— **批准**

理由：章程**要求 2.1「用户不碰命令行」直接依赖它**。后端报错时必须给出**机器可读的补救动作**
（"下载 X 后端"、"清理磁盘"、"切换镜像源"），前端据此渲染一个按钮。
没有这个字段，用户只能看到错误文本然后无从下手——那就等于要求他去命令行。

## 决策 3：错误文案归属 = **`code` 查前端表优先 + 后端 `message` 兜底**

采纳 `architect` 建议。前端按 `code` 查 i18n 表（可本地化、可改文案不动后端），
后端 `message` 作为未知 code 的兜底。他已让两边按此实现，**两种结果都兼容**，无返工。

## 决策 4：补装前端依赖 —— **批准，指派 `oss-scout`**

已核实的版本（`architect` 实地核实）：

- `react-router@^8.3.0` —— ⚠️ **v8 移除了 `react-router-dom`**，需 Node ≥ 22.22.0
- `i18next@^26.3.6` + `react-i18next@^17.0.11` —— **版本联动，必须配套升**
- shadcn 底层库（见决策 7）、虚拟滚动库

## 决策 5：多标签页 = **Web Locks 选主 + BroadcastChannel 转播，但必须带降级**

采纳 `architect` 方案。问题是真实的：3 个标签 = 3 条 SSE，会吃掉 HTTP/1.1 六连接预算，
且与 D-01「第二条连接关掉旧的」冲突。

**但他明确标注 Safari 支持未核实** → **补充硬要求**：必须做特性检测，
`navigator.locks` 不可用时**降级回 D-01 原行为**（最后一个标签页胜出）。
这样无论 Safari 支持与否，产品行为都正确 —— **不去解决这个 UNKNOWN，而是让它无关紧要。**
（同 ADR-004 决策 1 处理 hf-mirror 的思路。）

## 决策 6：追认 D-01 订正批次 —— **批准**

`architect` 把 D-01 改成与实现一致：`/api`（原 `/api/v1`）、具名 SSE 事件、重放 256、
错误信封改用实现版本、token fragment 写法。

**文档跟随现实是对的**，不是让步。但要求：订正处必须在文档里留痕（标明原设计与订正原因），
否则后人无法判断这是深思熟虑还是随手改的。

## 决策 7：shadcn 底层库 = **Base UI** —— 批准

`architect` 核实：**shadcn/ui 已于 2026-07-03 把默认底层库从 Radix 换成 Base UI**
（`@base-ui/react` v1.6.0）。

采纳其工程性理由：**一个包 vs 十几个包** —— 这在 ADR-005 刚确立"许可证逐依赖登记"之后
是实打实的维护量差异；且它是 CLI 默认路径，**少一个"CI 忘传 `-b radix`"的静默出错点**。

⚠️ **连带修正**：仓库 `src/components/ui/SOURCE.md` 目前写的是"底层依赖 Radix"，
**不订正则 ADR-002 决策 2 的豁免条件（可追溯性）不成立**。指派 `oss-scout` 一并改掉。
另注意易混淆的旧包名 `@base-ui-components/react` 会踩坑。

---

# 附：D-05 中值得全项目沿用的三条

1. **§3.4 把聚合点变成分片导出** —— `routes.tsx` 和 SSE `bindings.ts` 是三方必然冲突的热点。
   每个 feature 导出自己的路由片段与绑定片段，聚合文件只在新增 feature 时动一行。
   配 §3.5 eslint 禁止 `features/A → features/B` 横向 import。
   **把写冲突结构性消灭，而不是靠君子协议。** 这正是我做文件所有权表想达到的效果，但他做得更彻底。
2. **状态三分判据一句话**："这个值刷新时是否需要一个以上组件重渲染？"
   否 → 高频瞬时流（播放位置 10Hz、进度 4Hz、partial 字幕）既不进 TanStack Query 也不进 React state。
3. **设计令牌颜色跑了校验脚本而不是目测** —— 明档 aqua 2.74:1 / yellow 2.11:1 低于 3:1，
   于是把"存储分解条必须带图例和数字标签"**从审美建议变成硬性要求**。

# 附：D-05 记录的三个静默坑（会让人浪费半天，全项目周知）

- `formatSseFrame()` 发 `event: <type>` → **`EventSource.onmessage` 永不触发**，必须逐类型 `addEventListener`。
- **Tailwind v4**：`@theme{}` 变量不能嵌套 → 明暗双档必须用 `:root`/`[data-theme]` + **`@theme inline`** 转发；
  写成普通 `@theme` **暗色永远不生效且不报错**。
- TanStack Query **没有**官方 SSE 指南（`architect` 诚实记录的否定结论），D-05 §2.3 映射表是社区共识；
  `experimental_streamedQuery` 用途不同，**别混用**。
