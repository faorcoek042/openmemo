# Agent 协作协议 v1

所有 agent **必须**遵守。Meta Manager 是唯一的调度者与合并者。

## 0. 角色
- **Meta Manager**（主会话）：分派任务、读摘要、做决策、写 ADR、合并成果。不写业务代码。
- **Lead Agent**（opus5）：领域负责人，可再派 sub-subagent（琐碎活用 sonnet5）。
- **Worker Agent**（sonnet5）：执行明确定义的机械任务。

## 1. 通讯机制 = 共享文件系统（单一事实来源）

```
/root/memo/
├── docs/
│   ├── 00-CHARTER.md          # 项目章程（Manager 所有，只读）
│   ├── research/              # 研究报告  R-*.md
│   ├── design/                # 设计文档  D-*.md
│   └── adr/                   # 架构决策记录 ADR-NNN-*.md（仅 Manager 写）
├── coordination/
│   ├── PROTOCOL.md            # 本文件
│   ├── BOARD.md               # 任务看板（仅 Manager 写）
│   ├── ROSTER.md              # Agent 花名册（仅 Manager 写）
│   ├── inbox/<agent>.md       # Agent → Manager 的回执（Agent 写，追加）
│   └── tasks/T-NNN.md         # 任务卡（Manager 写规格，Agent 写进展）
```

### 规则
1. **写自己的文件，读别人的文件。** 除 `inbox/<自己>.md`、自己被分配的 `tasks/T-NNN.md`
   和自己交付的 `docs/**` 文件外，不得修改任何文件。避免写冲突。
2. **跨 agent 依赖靠文件，不靠猜。** 需要别人的产出时，读对方的 `docs/` 交付物。
   若尚不存在，在自己的 inbox 里写 `BLOCKED: 等待 <文件路径>`，然后先做不依赖它的部分。
3. **绝不修改他人的交付物。** 有异议 → 在自己 inbox 里写 `DISPUTE:` 条目，Manager 裁决。

## 2. 交付物格式（强制）

每份 `docs/**` 文档**必须**以这个块开头，Manager 只读这一块：

```markdown
---
id: R-01
author: <agent-name>
status: draft | ready | superseded
date: YYYY-MM-DD
---

## TL;DR（≤ 25 行，Manager 只读这里）
- 结论 1
- 结论 2
- 关键取舍：...
- 未验证/存疑：...   <-- 必填，没有就写"无"
- 对其他 agent 的影响：...

## 详细内容
（正文随意长）
```

## 3. 回执格式（`coordination/inbox/<agent>.md`，追加不覆盖）

```markdown
## [YYYY-MM-DD HH:MM] <TASK-ID> <STATUS>
STATUS ∈ DONE | PROGRESS | BLOCKED | DISPUTE | QUESTION
交付: <文件路径列表>
要点: <≤5 行>
下一步建议: <≤3 行>
需要 Manager 决策: <有则列出，无则写"无">
```

## 4. 诚实规则（不可协商）
- 没验证过的写 **"未验证"**。没跑通的写 **"未跑通"** 并附错误输出。
- 不允许编造 API、版本号、benchmark 数字。不确定就去查，查不到就标 `UNKNOWN`。
- 网络受限导致无法验证的，明确写 `无法联网验证`。

## 5. 派生 subagent 的规则
- Lead 可派 sub-subagent，但**自己名下同时运行的不得超过 2 个**（全局上限 4 由 Manager 控制）。
- 机械性工作（改文件名、批量重写、跑格式化、写样板代码）→ 用 sonnet5。
- 需要判断/设计/取舍的 → opus5。
- 派出去的 agent 完成后不要 kill，记录其 name/id 到自己的 inbox 以便复用。

## 6. 上下文节约
- 不要把大文件全文贴进回复。写到磁盘，回复里只给路径 + TL;DR。
- 读别人的文档时优先只读 TL;DR 块。
