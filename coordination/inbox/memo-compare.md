# memo-compare 回执

## [2026-08-03 03:05] T-072 DONE

交付: `/root/memo/docs/research/R-06-memo-ac-gap.md`

要点:
- **识别引擎两个可选的根因**：`apps/web/src/features/recorder/RecorderPage.tsx:49` 写死
  `useState<'paraformer'|'turbo'>`，非 manifest 驱动、值从不发给后端、`'turbo'` 在后端
  `EngineId` 三值联合里根本不存在；导入页 `CapturePage` 连引擎/模型/语言都没有。
  memo.ac 是本地 4 引擎 + 云端 4 家 = 8 条路径（forensics 原文核实）。
- **模型清单差距**：memo.ac ASR 模型条目 47（whisper 15 + sherpa 27 + parakeet 4 + funasr 1），
  我们 11。最大单点缺口是 sherpa 27→2，技术根因在 `paraformer.ts:257` 把 `modelConfig.paraformer`
  写死为单分支。
- **导航点不动已被 T-074（3bf3cfa）修掉**。git 全历史核实：`/settings` 从未被 `pending` 标记，
  用户感知的"设置也点不动"应归因于同 commit 修的握手竞态（满屏"未认证"）。
- 三列表 58 条：完全没做 18 · 做了但残 10 · 我们更好 15 · 相当/并列 9 · 章程明确不做 6。
- **纠正两处前人吹过头的结论**：① `POST /api/models/import` 的 `kind:'hf_repo'` 硬编码 501，
  "可导入任意 HF GGUF"不成立；② vulkan/rocm 后端包全是 llama.cpp，whisper.cpp 只有 cpu×2+cuda-win×1，
  "真 AMD 支持"目前**只覆盖 LLM 不覆盖 ASR**。站得住的是量化选择与显存 fit 预检（均已实测）。

下一步建议:
1. 引擎/模型选择器改 catalog 驱动，从 RecorderPage 提到导入页 + 设置页（数据源 `/api/models/catalog` 现成）。
2. 补 sherpa 离线分支 + SenseVoice 进目录 —— 中文体验最大缺口，成本最低。
3. 接通 `RecorderPage` ↔ `/ws/recorder`（后端是真的，前端是 mock，F3 端到端从未跑通）。

需要 Manager 决策:
- **FEATURE-COVERAGE.md 需大改**：B-1/B-2/B-3 三个"交付阻塞"实测全部已解（daemon 实有 42 条 REST + 2 条 WS，
  非 6 条）；另 5 处标 🔴 的实际已实现（拖拽/标签写入/导出/TipTap/onboarding）。
  同时要新增两条它没有的：N-1 前端引擎选择器与后端脱节、N-2 F3 端到端未跑通（矩阵标 🟢 属偏乐观）。
- **对外话术需修正**："真 AMD 支持"与"可导入任意 HF GGUF"两条目前不成立，是继续投入实现，还是改口径。
- 未派生任何 subagent 保留（两个 Explore 均为一次性事实提取，已完成）。

诚实声明:
- 全程只读 demo 实例（仅 GET），未写未重启。审计期间该实例被其他 agent 重启过一次
  （pid 2066756 → 2075454，绑定由 0.0.0.0 变回 127.0.0.1），非我所为。
- **未在真浏览器点击验证任何页面**，结论基于只读 API + 读源码 + 读 git 历史。
- memo.ac 为闭源专有代码，本次只提取事实性标识符与计数，**未复制其任何源码进本仓库**。
- 引用的 memo.ac GitHub issue 编号沿用 R-01，**本次未复核**，已在报告中标 [R1]。
