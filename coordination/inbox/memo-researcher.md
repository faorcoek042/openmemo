# memo-researcher 回执

## [2026-08-02 05:10] T-001 DONE

交付: /root/memo/docs/research/R-01-memo-ac.md
要点:

- memo.ac = MemoAI，Pemo LLC，**闭源 Electron 应用**（仅 Win x64 / macOS arm64，无 Linux）。GitHub 仓库只是 Release+Issue 托管（18KB，无源码、无 License）。
- 技术栈已**二进制取证**（下载并解包官方 v1.7.5 macOS 包，app.asar 42,370 文件）：React+antd6+MobX+Vite；思维导图=**markmap**；ASR=whisper.cpp 1.8.6 + sherpa-onnx + FunASR + Parakeet；URL 导入=内置 yt-dlp+bun；说话人=pyannote 外挂；DB=SQLite+knex。
- **章程 2.1 的答案**：CUDA 以 `whisper-cublas-12.2.0-bin-x64.zip` 形式**应用内下载→解压到 addon/whisper/win32/x64/cublas→存在性自检**；硬件探测用 systeminformation + nvidia-smi + nvcc；IPC 通道名与进度事件格式已抄录在 R-01 B6.2。
- **章程 2.2 的答案**：模型目录是声明式注册表（`presets/whisper-models.js` + `plugins/extra-transcription-plugins.json`），字段 size/speed/quality/lang/downloadLink/sha，引擎与模型解耦按 platform+arch 分发；342 个 IPC 通道全清单在 R-01 B7.2。
- **memo.ac 的两个硬缺口 = 我们的差异点**：① 无量化选择（whisper 全 f16）；② 无显存/内存 fit 预检。另：AMD GPU 实际不支持（首页宣传不实）、不支持 Linux、不能导入任意 HF 模型。

下一步建议:

- 设计阶段直接复用 R-01 B7.2 的注册表 schema，**补 `quantization` 与 `vramRequiredMB` 两个字段**，并把后端从 {cuda,metal,coreml} 扩到 {cuda,vulkan,rocm,metal,coreml,cpu}。
- 思维导图选型建议直接定 markmap（MIT），并规避其导出模糊问题（用 SVG 序列化而非截屏）。
- 明确不要照抄的两处：`vm2` 插件沙箱（已废弃且有逃逸漏洞）、`whisper-server --host 0.0.0.0`（应绑 127.0.0.1）。

需要 Manager 决策:

1. **Windows 包未解包**（NSIS，本机无 7z/p7zip）。R-01 中"memo.ac 仅支持 CUDA、无 Vulkan/DirectML"的结论**仅基于 macOS 包 + 官方文档**，标为未验证。是否需要我安装 7z 或用 Windows 环境复核？（不复核不影响我们的设计决策，因为我们本来就要做 Vulkan/ROCm。）
2. 取证产物在 `/tmp/memoac/`（tmpfs，重启即失），含 memo.ac 的 whisper 模型注册表原文、引擎插件注册表、342 个 IPC 通道清单。**是否需要落盘到仓库内**（如 `docs/research/assets/`）供 D-* 设计 agent 直接引用？我未擅自写入以遵守文件边界。
3. 提示：我的 WebSearch 工具全程返回 API 错误，网络检索由 sonnet subagent 代执行；curl 与二进制取证均正常。若后续任务重度依赖 WebSearch，请知悉此限制。

派生 subagent 记录（未 kill，可复用）:

- `a9a1a803aae6e6abf` (sonnet) — memo.ac 全网评测/社区/GitHub issue 检索
- `a6345fe86492cf99f` (sonnet) — MemoAI GitHub Release 资产与 issue 取证
- `a25e1a60d138f606e` (sonnet) — 竞品 GPU/模型管理 UX 基准（LM Studio / Jan / MacWhisper / Buzz / Vibe / GPUStack 等），结论与 R-04 高度重叠
- `aa640a5d9d542a778` (sonnet) — memo.ac 全站页面（releases/blog/integration/privacy/terms）内容提取
