# `vendor/manifests/` —— C 类运行时下载物清单

> **所有权**：本目录的 `*.json` 归 `model-mgmt`（T-013）编写，见 BOARD.md 文件所有权表。
> `oss-scout`（T-011）只建目录与本格式说明，**不写任何 `*.json`**。

## 这是什么

**ADR-001 C 类**：终端用户机器上的大二进制与模型权重，**不进 git、不进 submodule**，
改为运行时下载。但"下载了什么"必须完全可追溯 —— 这就是 manifest 的职责。

**ADR-001 强制配套第 1 条**：

> C 类的 manifest **必须入 git**（含 URL + SHA256 + 版本 + 许可证），
> 保证"下载了什么"完全可追溯、可审计、可复现。

因此本目录的 `*.json` 是**唯一不被 `.gitignore` 排除的下载相关文件**。

## 消费方

- `packages/downloader` —— 统一下载器（GPU 后端包与模型权重共用，ADR-003 决策 6）
- `packages/runtime` —— GPU 后端包安装（章程要求 2.1）
- `apps/web` —— 模型浏览/下载/切换/删除/量化选择 UI（章程要求 2.2）

## 建议的文件划分

| 文件                      | 内容                                                                  |
| ------------------------- | --------------------------------------------------------------------- |
| `schema.json`             | 本目录所有清单的 JSON Schema（CI 用它校验）                           |
| `runtimes.json`           | GPU 后端运行时包（CPU / CUDA / Vulkan / ROCm / Metal），交叉引用 R-02 |
| `models.asr.json`         | Whisper / Paraformer 等 ggml·ONNX 权重                                |
| `models.vad.json`         | Silero VAD（`ggml-silero-*.bin` 等）                                  |
| `models.diarization.json` | sherpa-onnx segmentation + speaker embedding 模型                     |
| `models.llm.json`         | GGUF 权重                                                             |

> 最终划分由 `model-mgmt` 定，上表只是建议，不是约束。

## 每个条目至少要有的字段（**硬要求**）

以下四个字段缺一不可，否则 ADR-001 的可追溯性保证不成立：

| 字段      | 为什么必需                                                                                                      |
| --------- | --------------------------------------------------------------------------------------------------------------- |
| `url`     | 下载来源，可审计                                                                                                |
| `sha256`  | **校验通过才算安装**（ADR-004 决策 5，GPT4All 模式）。⚠️ Ollama 的 `download.go` 没做 SHA256 校验，我们必须补上 |
| `version` | 可复现                                                                                                          |
| `license` | 许可证可追溯（ADR-002 v2 保留的工程约束）                                                                       |

### 另外两条来自 ADR-004 的教训

- **判重一律按 SHA256，不按体积**。
  （`model-mgmt` 的派生 agent 曾把 `ggml-tiny.bin` 与 `ggml-tiny.en.bin` 搞混 —— 仅差 13,002 字节。）
- **显存需求不手填**：用 8 MB Range 请求读 GGUF 元数据由 CI 自动生成 `vramRequiredMB`，
  且**必须计入 KV cache**（实测 8K 上下文 ≈ 1.1 GB）。

### 模型注册表额外字段（ADR-004 决策 4，补 memo.ac 的硬缺口）

| 字段                               | 理由                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------ |
| `quantization`                     | memo.ac 硬缺口 ①：它的 whisper 模型全是 f16，无量化选择                  |
| `vramRequiredMB` / `ramRequiredMB` | memo.ac 硬缺口 ②：无显存/内存 fit 预检                                   |
| `backend`                          | 枚举扩到 `{cuda, vulkan, rocm, metal, coreml, cpu}`（memo.ac 只有 3 个） |

## 参考骨架

以下是 R-03 §7.1 给出的格式示例，**仅供 `model-mgmt` 参考，不是最终 schema**：

```json
{
  "$schema": "./schema.json",
  "component": "yt-dlp",
  "license": "GPL-3.0-or-later",
  "license_note": "官方 PyInstaller release 二进制是 GPLv3+；仅 git 仓库/PyPI 包是 Unlicense。ADR-002 v2 允许内置。",
  "upstream": "https://github.com/yt-dlp/yt-dlp",
  "version": "2026.07.04",
  "artifacts": [
    {
      "platform": "linux-x86_64",
      "url": "https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp_linux",
      "sha256": "TODO"
    }
  ]
}
```

> ℹ️ 注意：本骨架下 **yt-dlp 与 ffmpeg 实际都走 B 类**（npm `youtube-dl-exec` / `ffmpeg-static`
> 的 postinstall 获取二进制），不需要 manifest。上面只是格式示例。
> 若日后改回"运行时按需下载"（商用升级路径），再启用对应 manifest。
