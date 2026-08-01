# 任务看板 — OpenMemo

> 仅 Meta Manager 写。Agent 只读。进展写到自己的 `coordination/inbox/<name>.md`。

## Wave 1 — 研究（进行中）

| ID | 任务 | 负责 agent | 模型 | 交付物 | 状态 |
|----|------|-----------|------|--------|------|
| T-001 | 研究 memo.ac 产品与技术实现 | `memo-researcher` | opus5 | `docs/research/R-01-memo-ac.md` | 🔵 进行中 |
| T-002 | 跨平台 GPU/ASR 运行时策略 | `gpu-runtime` | opus5 | `docs/research/R-02-runtime-gpu.md` | 🔵 进行中 |
| T-003 | 开源模块选型 + 许可证 + submodule 方案 | `oss-scout` | opus5 | `docs/research/R-03-oss-modules.md` | 🔵 进行中 |
| T-004 | 模型管理（网页内下载/切换/量化）方案 | `model-mgmt` | opus5 | `docs/research/R-04-model-mgmt.md` | 🔵 进行中 |

## Wave 2 — 架构（待启动，依赖 Wave 1）
| ID | 任务 | 状态 |
|----|------|------|
| T-010 | 总体架构设计 D-01（进程模型/IPC/前后端边界） | ⚪ 待启动 |
| T-011 | 仓库骨架 + submodule 落地 | ⚪ 待启动 |
| T-012 | 数据模型与存储设计 | ⚪ 待启动 |

## Wave 3 — 开发（待启动）
| ID | 任务 | 状态 |
|----|------|------|
| T-020 | 后端 daemon：任务队列 / 转写流水线 | ⚪ |
| T-021 | 前端：捕获 → 转写 → 笔记 UI | ⚪ |
| T-022 | 前端：运行时与模型管理页（要求 2.1 / 2.2 核心） | ⚪ |
| T-023 | 思维导图生成与编辑 | ⚪ |
| T-024 | 打包分发（mac/win/linux × GPU 后端） | ⚪ |

图例：⚪ 待启动 🔵 进行中 🟢 完成 🔴 阻塞
