---
id: ADR-003
title: 进程模型、GPU 后端策略、签名与分发姿态
status: accepted
date: 2026-08-02
decider: Meta Manager
input: R-01 §B6/§B7, R-02 全文, R-04 §7
---

## 决策 1：进程模型 = **本地 daemon + 浏览器 UI（web-first）**

用户要求原文："**使用网页接入**"、"通过**你设计的网页**完成"。据此定架构基线：

```
┌─ 浏览器（任意）─────────────┐
│  React SPA                  │  ← 唯一 UI，所有功能（含装 GPU 后端、管模型）都在这
└──────────┬──────────────────┘
       HTTP / SSE / WS  (127.0.0.1 ONLY)
┌──────────┴──────────────────┐
│  本地 daemon (Node.js + TS) │  ← 任务队列、硬件探测、下载器、DB
└──────────┬──────────────────┘
       子进程 spawn（崩溃隔离）
┌──────────┴──────────────────────────────────────┐
│ ffmpeg │ yt-dlp │ whisper-cli │ llama-server │ probe │
└─────────────────────────────────────────────────┘
```

**理由**
- 直接满足"网页接入"，无需先解决 Electron/Tauri 之争即可开工。
- 原生组件一律**子进程**调用 → 崩溃隔离（R-02 建议）、许可证隔离、可独立升级。
- 桌面外壳（Tauri v2 包一层指向 daemon）**后置为可选**，不进 v1 关键路径。

**安全硬要求**（来自 R-01 §B "不要照抄" 清单）
- 所有监听 **必须绑 `127.0.0.1`**，绝不 `0.0.0.0`（memo.ac 的 `whisper-server` 犯了这个错）。
- 插件沙箱**禁用 `vm2`**（已废弃 + 已知逃逸漏洞），需要沙箱时用 `node:worker_threads` + 权限白名单。
- daemon 启动生成随机 token，网页需带 token 才能调 API，防止其他本地进程/恶意网页打我们的端口。

## 决策 2：ASR 引擎 = whisper.cpp 自建 CI（**批准**）

`gpu-runtime` 的核心请求（约 1 人周）**批准**。依据：官方 v1.9.1 release **无 macOS CLI、
无 Vulkan、无 ROCm**（已核实 `release.yml`），不自建则章程要求 2.1 在 mac 上直接不成立。

- **源码走 submodule，产物走运行时下载** —— 明确这是同一组件的两种引入方式并存，
  不与 ADR-001 冲突（回应 `gpu-runtime` 决策项 5）。
- 副引擎 `sherpa-onnx`（npm 有完整 per-platform 预编译）用于流式/VAD/说话人分离。
- **淘汰 `faster-whisper`**（Apple Silicon 不支持 MPS + cuDNN 需用户手动装）。
- LLM 线走 `llama.cpp` 官方预编译（矩阵极完整）→ **这条线不自建 CI**。

⚠️ **约束**：本机是 Linux x86_64 无 GPU。mac/Windows 产物**必须**靠 GitHub Actions runner，
而本仓库目前**无 remote**。→ 已上报用户：需要一个 GitHub 仓库才能产出 mac/Win 二进制。
在此之前：CI workflow 文件照写，**Linux 侧本机实测跑通**，mac/Win 标"未验证"。

## 决策 3：GPU 后端策略

基于 R-02 的实测（ggml `GGML_BACKEND_DL=ON` → 后端是可热插拔的独立 `.dll/.so`，
CPU 包与 CUDA 包结构 100% 一致，差集仅几个文件）：

**要求 2.1 的实现 = 往同一目录多丢几个文件。** 这是一等公民能力，不是 hack。

**降级链（L0 → L2）**
| 档 | 内容 | 体积 | 何时用 |
|---|---|---|---|
| L0 | 浏览器 WebGPU（transformers.js） | 0（零安装） | 首次打开即可试用，不装任何东西 |
| L1 | 内置 CPU 后端 | 8–20 MB | 永不失败的兜底 |
| L2 | 按需下载加速后端 | 见下 | 网页点一下装 |

**NVIDIA 默认后端**：采纳 `gpu-runtime` 的临时立场 —— **Vulkan 为默认**（~30 MB），
**CUDA 作为可选高性能包**（实测 677.9 MB）。理由：678 MB vs 30 MB 差 22 倍，
而**性能差距 = UNKNOWN**（R-02 诚实地拒绝编造：whisper.cpp 官方 bench 帖只有 CPU/WASM 数据）。
→ **spike 实测后可推翻本决策**，这是临时立场不是终局。

**探测硬要求**：文件存在性检测**不可信**（R-02 在本机发现反例：`libvulkan.so.1` 存在但无 GPU、
无 `/dev/dri`）→ 必须真正枚举设备。probe 跑独立子进程 + 10s 超时 + 失败熔断。

**自检**：安装后跑内嵌测试音频做**真实推理**（memo.ac 的做法，值得照抄），测出 RTF 展示给用户。

## 决策 4：签名与分发姿态 = **ad-hoc 签名，不买证书**

因用户已定"仅个人/自用"，`gpu-runtime` 的决策项 2（Apple $99/年 + Windows OV $129/年
+ 硬件令牌 $379）**全部不采购**。

- macOS：ad-hoc 签名（`codesign -s -`，Apple Silicon 上所有可执行文件的**最低要求**）
  + 首次运行时由 daemon 自动 `xattr -dr com.apple.quarantine` 清除隔离属性。
- Windows：不签名，用户自行通过 SmartScreen。
- **Developer ID / OV 证书路径完整写入文档**，作为日后商用时的升级路径。

## 决策 5：离线全量安装包 —— **不进 v1**

`gpu-runtime` 决策项 4 否决。个人自用场景无内网刚需，750 MB+ 的打包成本不值得。

## 决策 6：下载器统一

采纳 `gpu-runtime` 建议：**「后端包下载器」与「模型下载器」合并为同一组件**
（manifest + SHA256 + Range 断点续传 + 镜像切换）。R-02 §C.3 与 R-04 的设计必须收敛为一份。
由 `model-mgmt` 在 T-013 中主笔，`gpu-runtime` 复核。
