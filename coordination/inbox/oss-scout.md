# oss-scout 回执

## [2026-08-02 04:10] T-003 DONE

交付: `/root/memo/docs/research/R-03-oss-modules.md`（id: R-03, status: ready, TL;DR 20 行）

要点:
- D1–D12 各域 2–6 个候选 + 明确推荐，star/license/最近提交/发布日期**全部 2026-08-02 实地核实**（`gh api` + npm registry API + crates.io API + LICENSE 原文解码 + 官方文档 WebFetch）。
- 提出 **submodule / 包管理器 / 运行时下载 三分法判定规则**（§1，含决策树 + 3 条覆盖规则 R-A/R-B/R-C），结论是 C2「一律 submodule」不可字面执行，实际只有 6 个组件适合 submodule。
- 输出**许可证矩阵总表**（§3，40+ 条目，三级风险标注）+ FFmpeg 专题（§4）+ yt-dlp 专题（§5）+ 必须避免/需法务确认清单（§6）。
- 4 个已核实的硬坑：`ffmpeg-static` npm 是 GPL-3.0-or-later；yt-dlp 官方 release 二进制是 GPLv3+（仅 git 仓库/PyPI 是 Unlicense）；tldraw 专有许可；ten-vad 带非竞争条款。
- `vendor/` 布局 + `.gitmodules` 草案见 §7，**未执行任何 git 命令**（遵守边界，待 ADR 批准后由 T-011 执行）。

下一步建议:
- Manager 就 §1 判定规则写 ADR；同时批准 §6.1 的 CI 许可证白名单强制（`cargo-deny` + license-checker）。
- T-011 骨架搭建时必须实测 U-5（rusqlite bundled + load_extension 能否加载 libsimple/sqlite-vec）与 FFmpeg LGPL 自建（尤其 macOS）。
- `model-mgmt`(R-04) 请复用 §7.1 的 `vendor/manifests/*.json` 清单格式；模型权重许可证（L-5/U-3/U-4）整体移交 R-04。

需要 Manager 决策:
1. **C2 是否按 §1 三分法修订**（这是本文最核心的请求，其余结论都依赖它）。
2. **F1 是否采纳 §5.5 的双路径方案**（默认只做 RSS/直链，yt-dlp 降级为默认关闭的可选插件）。这直接决定商用可能性是否保留。
3. **shadcn/ui 的源码复制分发模式**与 C2「禁止复制粘贴源码」字面冲突，需 ADR 明确豁免（§2 D12 / §6.2 L-8）。
4. **是否启动法务咨询**：§6.2 列了 8 项（L-1 CLI 子进程边界、L-3 yt-dlp 分发风险、L-5 模型权重许可证为最紧要）。
5. D7 主推 `mind-elixir-core`（编辑优先，OPML/FreeMind 需自研 ~110 行序列化器）vs 备选 `simple-mind-map`（导出最全，含 xmind/pdf/md）——若产品更看重导出矩阵请回告切换。

派生 subagent 记录（未 kill，可复用）:
- `a8266c04711e120db` — FFmpeg 许可证证据收集（sonnet5，已完成）
- `a92ba69c2d5d1da17` — yt-dlp 法律/ToS/分发先例证据收集（sonnet5，已完成）

诚实声明:
- 本任务**未执行任何编译/构建**，所有"可行"结论均为基于文档与元数据的判断，标记为未跑通。
- 11 项未验证/UNKNOWN 已在文档 §8 列全，其中最关键：macOS 无维护中的 LGPL FFmpeg 预编译源（故必须自建）；所有模型权重许可证未核实。
- R-02（gpu-runtime）撰写时尚不存在，D3 的引擎选型结论以其为准，本文仅定集成方式。
