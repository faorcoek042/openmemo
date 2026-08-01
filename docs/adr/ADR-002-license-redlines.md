---
id: ADR-002
title: 许可证红线、shadcn/ui 豁免、思维导图库选型
status: accepted
date: 2026-08-02
decider: Meta Manager
input: docs/research/R-03-oss-modules.md §2 §3 §6
---

## 决策 1：许可证黑名单（CI 强制，命中即 fail build）

以下组件**禁止进入发行物**，全部已由 `oss-scout` 于 2026-08-02 实地核实：

| 组件 | 问题 | 替代方案 |
|------|------|----------|
| `ffmpeg-static` (npm) | 自报 **GPL-3.0-or-later** 二进制 | 自建 LGPL-2.1+ FFmpeg（vendor submodule + CI 矩阵编译） |
| yt-dlp **官方 release 二进制** | PyInstaller 打包引入 **GPLv3+**（仅 git 仓库/PyPI 包是 Unlicense） | 见待决策项 D-2 |
| `tldraw` | 专有许可证，生产需付费 | `mind-elixir-core` (MIT) |
| `ten-vad` | 含"不得与 Agora 竞争"条款，非 OSI | `silero-vad` (MIT) |
| `@blocknote/xl-*` | GPL-3.0 | TipTap core (MIT)，不碰 `@tiptap-pro/*` |
| `@tiptap-pro/*` | 付费专有 | TipTap core (MIT) |
| Meilisearch | 含 BUSL-1.1 | SQLite FTS5 + libsimple(MIT 支) + sqlite-vec |
| Moonshine 非英语模型 | 非商用 | sherpa-onnx / whisper 系 |
| FFmpeg `--enable-nonfree` | 官方明文 **unredistributable** | 绝不启用；`--enable-gpl` 我们也用不到（纯音频） |

**FFmpeg 调用方式**：CLI 子进程调用 + 自建 LGPL-only 构建。依据 FSF 官方 FAQ `#MereAggregation`：
pipes/exec/命令行参数通常使程序保持独立作品。→ 见 ADR-001 A 类。

## 决策 2：shadcn/ui 的 C2 豁免（**唯一豁免项**）

shadcn/ui 的分发模式**就是**源码复制进项目（MIT，设计意图如此，不存在"上游包"可依赖），
与 C2「禁止复制粘贴源码」字面冲突。

**批准豁免**，条件：
- 复制来的组件全部隔离在 `src/components/ui/` 单一目录下，不与业务代码混放。
- 目录内保留 `SOURCE.md` 记录来源 URL + 复制时的 commit/版本 + 许可证，维持可追溯性（C2 本意）。
- 该目录下的文件**允许本地修改**（这正是 shadcn 的使用方式），但修改需在 git 历史中可见。

## 决策 3：思维导图库 = `mind-elixir-core` (MIT)

理由：用户需求原文是"**整理**思维导图"——**编辑交互是主路径，导出是次要路径**。
`mind-elixir-core` 编辑优先（内置撤销/拖拽/右键菜单），导出缺口（OPML/FreeMind）经评估约 110 行
自研序列化器即可补齐；反向选择 `simple-mind-map` 则要自己补编辑体验，成本高得多。

`simple-mind-map` 的导出矩阵（xmind/pdf/md）作为**参考实现**，我们照着补齐序列化器。

**可逆性**：两者都是"数据结构 → 渲染"的库，我们的思维导图数据模型必须**库无关**
（自有 schema + 适配层），使日后切换成本可控。这是硬性设计要求，写入 D-01 架构文档。

## 决策 4：法务咨询 —— 不阻塞开发，但列为发布前置

R-03 §6.2 的 8 项法务事项中，**L-5（模型权重许可证）已移交 R-04 由 `model-mgmt` 核实**，
这一项技术上可自行解决。其余（L-1 CLI 子进程边界、L-3 yt-dlp 分发风险等）属于真正的法律判断，
**Meta Manager 无权代替用户决定是否付费咨询律师**，已上报用户。

开发按"保守假设"推进：即**假设需要保留商用可能性**，因此严格执行上述黑名单。
若用户明确本项目仅个人/开源使用，可放宽并回滚部分限制。
