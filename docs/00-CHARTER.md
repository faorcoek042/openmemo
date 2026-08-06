# 项目章程 — Memo 复刻版（代号：OpenMemo）

## 1. 目标
复刻 https://memo.ac/ 的核心体验：一个**本地优先（local-first）** 的 AI 笔记 / 知识捕获工具。
用户从任意音视频来源捕获内容 → 自动转写 → AI 结构化 → 生成思维导图 / 摘要 / 可检索笔记。

## 2. 必须包含的基础功能（用户明确要求）
| # | 功能 | 说明 |
|---|------|------|
| F1 | 音视频链接导入 | 粘贴 URL（YouTube/Bilibili/播客/通用直链）→ 下载/抽音轨 → 转写 |
| F2 | 本地媒体导入 | 拖拽本地 音频/视频 文件 → 转写 |
| F3 | 录音转文字 | 浏览器内实时录音 → 流式/批量 ASR |
| F4 | 思维导图整理 | 转写稿 → LLM 结构化 → 可交互思维导图（可编辑、可导出） |
| F5 | 笔记管理 | 列表/详情/搜索/标签；转写稿与原音频时间轴联动 |

## 3. 平台与硬件矩阵（硬性要求）

> ⚠️ **产物现状（2026-08-06 实测）—— 分两层看，此前本块把这两层混为一谈**
>
> **第一层：CI 能不能编出来。** `build-backends` run 31067558923 **9 个 job 全绿**，
> 含 macOS metal / Linux vulkan / Linux cuda / Win vulkan 四条腿。**路已经走通了。**
> `backend-packs-2026.08.06` 里有 5 个资产（含 145 MB 的 Linux CUDA）。
>
> **第二层：用户能不能在网页上装。** 5 个资产里**只有 1 个进了 `backends.json`**，
> 另外 4 个的下载数是 **0** —— 因为加速增量包在当前安装布局下装了必然无效
> （ggml 只在 whisper-cli 自身目录与 cwd 里找后端模块），故意没接进目录。
>
> **所以逐平台的实话是**：macOS-arm64（CPU+Metal+ANE 打进同一个自包含核心包）、
> Linux x64 CPU、Win x64 CPU 三行**网页可装**；Win x64 CUDA **在目录里但今天装不上**
> （L2 门禁 + `openmemo-probe` 无分发通道）；Win/Linux Vulkan 与 Linux CUDA **有产物、未进目录**；
> AMD ROCm **无产物且已被用户 2026-08-05 裁掉**，`linux-arm64` / `macos-x64` 同。
>
> ⚠️ **本块此前写着**「Win Vulkan 已交付」「Linux CUDA 无任何产物」「补产物这条路已被砍」
> —— 三条都错。根因是**把「有产物」和「网页可装」当成了一件事**。
> **对外口径请用第二层，不是第一层。**
必须在以下组合可用，且**加速后端由网页 UI 检测并配置**，不要求用户碰命令行：

| 平台 | 加速后端 |
|------|----------|
| macOS (Apple Silicon) | Metal / CoreML |
| macOS (Intel) | CPU (AVX2) |
| Windows + NVIDIA | CUDA |
| Windows + AMD | Vulkan / DirectML |
| Windows / Linux CPU | CPU (AVX2/AVX512) |
| Linux + NVIDIA | CUDA |
| Linux + AMD | ROCm / Vulkan |

**要求 2.1**：所有依赖 GPU 的组件，其安装与配置**通过网页完成**——网页检测硬件 → 推荐后端 → 下载对应预编译二进制 → 安装 → 自检 → 显示状态。
**要求 2.2**：模型的浏览、下载、切换、删除、量化选择，也**全部通过网页完成**（参考 memo.ac 的做法）。

## 4. 工程约束（用户明确要求）
- **C1** Git 管理代码。
- **C2** 复用开源模块时，采用**模块化调用 + git submodule** 引入（`vendor/` 目录），禁止直接复制粘贴源码。
- **C3** 本会话（meta manager）只做管理，不写代码。所有设计/开发/研究由 subagent 完成。
- **C4** subagent 可再派 subagent；琐碎工作交给 sonnet5。
- **C5** 同时运行的 subagent ≤ 4。
- **C6** subagent 完成后保留（不 kill），后续通过 SendMessage 复用，节约上下文。

## 5. 非目标（本阶段）
- 移动端 App、团队协作/多人实时编辑、云端账号体系、支付。

## 6. 质量门槛
- 每个交付物必须有可运行的验证方式（脚本 / 测试 / 截图）。
- 任何"我认为可以工作"的结论必须标注为未验证。
