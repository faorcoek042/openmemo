---
id: ADR-015
title: 上游预编译优先 —— 停止自建，发布渠道阻塞消解
status: accepted
date: 2026-08-02
decider: 用户（指令）/ Meta Manager（落地）
supersedes: ADR-003 决策 2（自建 whisper.cpp CI）的适用范围
---

## 用户指令（2026-08-02）
> **"自用不一定要发布，一定要 GitHub 链接吗，是为了 runner 验证？"**
> **"尽量下载上游编译打包好的二进制来调用"**

## 0. Manager 认错：我把"硬阻塞"判错了

我在最终报告里把"没有 GitHub 发布渠道"列为**唯一硬阻塞**。用户一句反问点破：
**个人自用根本不需要我们自己发布。**

我的错误链条是：批准自建 → 自建出产物 → 产物要发布 → 需要发布渠道 → 报成硬阻塞。
**而链条第一环就不该成立** —— 上游本来就有现成的。

## 1. 逐组件核实结果（`gpu-runtime` 实地核实，**7/7 全部可改上游**）

| 组件 | 上游产物 | 结论 |
|---|---|---|
| **sqlite-vec** | `v0.1.9` loadable × linux/macos/windows + **官方 checksums.txt**；linux-x86_64 61,507B sha256 `b959baa1…d5d7`（与 checksums.txt 逐字一致） | **改上游** |
| **libsimple** | `v0.7.1` 12 个 zip；ubuntu-22.04 5,337,804B sha256 `0c9a7a57…42a5`，含 `libsimple.so` + **完整 dict（含 `pos_dict/`）** | **改上游** |
| **whisper.cpp** | `v1.9.1` Linux x64/arm64 CPU ✅、Win CPU/BLAS/CUDA ✅；**仍无 macOS CLI / Vulkan / ROCm / Linux CUDA** | Linux/Win **改上游**；其余**自建停** |
| **llama.cpp** | 官方矩阵极完整 | **上游**（本就不该自建） |
| **sherpa-onnx** | npm 全平台 1.13.4 | **上游**，已在用 |
| **ffmpeg/ffprobe** | BtbN 有**不可变日期 tag**，资产名带完整版本号 | **改上游 + 钉日期 tag** |
| **yt-dlp** | `2026.07.04` 四平台 + 官方 SHA2-256SUMS | **上游**，已在用 |

## 2. `gpu-runtime` 的自我更正
> **我在 T-037 从源码自建 `libsimple`/`sqlite-vec`，上游本来就有预编译，
> 而且 libsimple 的比我打的还全（多了 `pos_dict/`）。我当时没看上游 releases 就开编。**

→ 一周多的自建工作，起因是**没先查上游**。这条记录下来。

## 3. 两个技术前置，都已解决
- **"移动靶"**：BtbN 除 `latest` 外还有**不可变日期 tag**，钉它则 sha256 稳定。
- **`.tar.xz`**：`model-mgmt` 已用 `xz-decompress`（MIT，WASM，不依赖系统 `xz`——
  因为默认 Windows 装机没有）。与 `.tar.gz` **共用同一个 tar 提取器**，
  **不存在第二条提取路径**，故自动继承全部防护。`verify-unpack` **53/53**。

## 4. 决策
1. **manifest 一律填上游地址 + 钉不可变版本 tag + sha256。** 我们不托管任何东西。
2. **`build-sqlite-ext.sh` 停用**；`build-media-tools.sh` 降为可选重打包；
   `build-whisper.sh` 保留但**不进默认流程**；CI 降为**按需触发**。
3. **ADR-003 决策 2（自建 whisper.cpp CI）的适用范围收窄**为：
   仅当用户实际需要 **macOS / Vulkan / ROCm** 时才启用。Linux/Windows 走上游。
4. **本地托管方案保留但降为兜底**（`http://127.0.0.1:<port>/local-artifacts/`）。
   `model-mgmt` 否决了 `file://`，理由成立：**Node `fetch` 读不了 → 必须在下载器开分支 →
   那条分支会绕过 Range/续传/校验/去重/重试 —— 第二条代码路径正是漏洞来源。**

## 5. **`PENDING-USER-DECISIONS.md` 的 A-1（GitHub 仓库）撤销**
不再是阻塞。mac/Windows 二进制若日后需要，才重新提出。

## 6. 一项未完成（如实记录）
**ffmpeg 钉死 tag 的 sha256 未取到** —— 119 MB 在本机网络两次都停在 85 MB。
名称/大小已从 API 核实、内容含 `ffprobe` 是 T-050 实测，
但**该文件 sha256 落 manifest 前必须补**。
