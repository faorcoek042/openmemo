# Agent 花名册

> 仅 Meta Manager 写。Agent 完成任务后**保留**（不 kill），后续通过 SendMessage 复用其上下文。
> Agent 句柄由 Meta Manager 在会话内持有。

> ⚠️ **本表停在项目第 1 个提交（2026-08-02），已严重过期，仅供追溯。**
>
> - 此前 4 行全标「🔵 进行中」，而 **`BOARD.md` 的 Wave 1 表把同一批 T-001…T-004 标为 🟢 全部完成**
>   —— 两份 coordination 文档互相矛盾。
> - 实际参与的 agent 远不止 4 个：`coordination/inbox/` 有 **32 份**报告，均未登记在册。
> - **处置建议**：重建或删除。若保留，请指向 `coordination/inbox/`。

| 代号 | 角色 | 模型 | 领域上下文（复用价值） | 状态 |
|------|------|------|----------------------|------|
| `memo-researcher` | 竞品/产品研究 | opus5 | memo.ac 全貌、同类产品 UX、功能优先级 | 🔵 T-001 进行中 |
| `gpu-runtime` | 运行时/GPU 加速 | opus5 | 硬件检测、ASR 引擎、二进制分发、签名公证 | 🔵 T-002 进行中 |
| `oss-scout` | 开源选型/合规 | opus5 | 各域候选库、许可证矩阵、submodule 策略 | 🔵 T-003 进行中 |
| `model-mgmt` | 模型管理系统 | opus5 | HF API、模型清单、下载/存储设计、镜像 | 🔵 T-004 进行中 |

## 复用原则
1. **优先复用**已有 agent，而不是新建 —— 它们已经加载了领域上下文，新建等于重复烧 token。
2. 新任务若落在某 agent 的领域内 → SendMessage 追加任务。
3. 只有开辟全新领域时才新建 agent，并立即登记到本表。
4. 并发上限 4（Manager 全局控制）。Lead agent 自己派的 sub-subagent 同时 ≤2。
