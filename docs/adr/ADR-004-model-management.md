---
id: ADR-004
title: 模型管理策略 —— 镜像源、模型目录、差异化功能
status: accepted
date: 2026-08-02
decider: Meta Manager
input: R-04 全文, R-01 §B7
---

## 决策 1：镜像源 —— **运行时探测，不预设**

`model-mgmt` 报告 `hf-mirror.com` 从美国 IP 一律 308 跳回 HF（地理围栏），**无法从本机验证国内行为**。
Manager 也没有大陆机器可测。

**不去解决这个未知，而是设计成不需要知道答案：**
- 模型源做成**可配置源列表**（HF / hf-mirror / ModelScope / 用户自填）。
- 首次下载前**并发探测**各源（发 HEAD/Range 小请求测连通性与速度），自动选最快可用源。
- 失败自动切换下一源，UI 显示当前使用的源并允许手动覆盖。
- → 无论 hf-mirror 在国内是否可用，产品行为都正确。**该项 UNKNOWN 被架构消解，不再是风险。**

**已验证的利好照单全收**：`Qwen3-{4B,8B}-GGUF` 在 ModelScope 与 HF **10/10 文件 size+sha256 逐字节相同**
（`model-mgmt` 实测）→ 中文用户的 LLM 主线有官方免翻墙源，列为国内默认。

## 决策 2：不自建模型 CDN

`model-mgmt` 决策项 2 否决。个人自用场景不值得承担带宽成本与权重再分发的许可证审查。
Gemma 等权重受限的模型 → 走"用户自行接受上游条款后下载"，UI 里跳转上游页面。

## 决策 3：**批准拒绝编造 WER 数字**

`model-mgmt` 拒绝填写未经核实的 Whisper WER，改为**产品内跑真实基准**。
**这是正确判断，予以表彰并作为全项目标准**：宁可显示"未测量"，也不显示编造的数字。

落地：模型详情页的"准确率"字段初始为空，用户点"跑基准"后用内嵌测试音频实测本机数据。
这比任何论文数字都更有意义（用户关心的是**他自己机器上**的表现）。

## 决策 4：模型注册表 schema —— 以 memo.ac 为基线并补齐其缺口

采纳 `memo-researcher` 建议：直接复用 R-01 §B7.2 取证到的注册表 schema
（`size/speed/quality/lang/downloadLink/sha`，引擎与模型解耦按 platform+arch 分发），**并补**：

| 补充字段 | 理由 |
|---|---|
| `quantization` | **memo.ac 硬缺口 ①**：它的 whisper 模型全是 f16，无量化选择 |
| `vramRequiredMB` / `ramRequiredMB` | **memo.ac 硬缺口 ②**：无显存/内存 fit 预检，只在网页文档写"最低 8G" |
| `backend` 枚举扩展 | memo.ac 只有 `{cuda, metal, coreml}`；我们扩到 `{cuda, vulkan, rocm, metal, coreml, cpu}` |

**显存需求不手填**：采纳 `model-mgmt` 的已验证方案 —— **8 MB Range 请求读出完整 GGUF 元数据**，
由 CI 自动生成 `vramRequiredMB`，且**必须计入 KV cache**（实测 8K 上下文 ≈ 1.1 GB）。
`model-mgmt` 指出 LM Studio 的估算器就因漏算 KV 和多 GPU 而翻过车 —— 不重蹈覆辙。

**判重不按体积**：`model-mgmt` 派生 agent 曾把 `ggml-tiny.bin` 与 `ggml-tiny.en.bin` 搞混（仅差 13,002 字节）。
→ **一律按 SHA256 判重**，体积仅作展示。这个教训写进实现规范。

## 决策 5：借鉴对象已定案（照抄谁）

- 下载引擎 → **Ollama**（16 分片 / Range / sidecar 续传）。但**注意 Ollama 的 `download.go` 没有 SHA256 校验**
  （`model-mgmt` 读源码发现）→ **我们必须补上**。
- 目录分发三级降级（remote → cache → local）→ **ComfyUI-Manager**。
- **"校验通过才算安装"** → **GPT4All**，九个产品中唯一做对的。
- 进度推送 → **SSE**（单向、与 REST 共用鉴权、`EventSource` 自带重连 + `Last-Event-ID` 重放）。
  **硬约束：只开一条全局 SSE 流**，否则撞 HTTP/1.1 六连接上限。实时录音转写另开 WebSocket。

## 我们相对 memo.ac 的差异化（产品需求，写入 D-01）
1. 量化选择（memo.ac 无）
2. 显存/内存 fit 预检 + "能不能跑"三档判定（memo.ac 无）
3. 真实 Linux 支持（memo.ac 无）
4. 真实 AMD 支持（memo.ac 首页宣称有，代码里 provider 枚举只有 `["cpu","cuda"]`，宣传不实）
5. 可导入任意 HF GGUF 模型（memo.ac 不支持，是其用户抱怨热点）

> ⚠️ **2026-08-06 订正：本句已不成立。** `apps/daemon/src/http/rest/models.ts:728-733` 对
> `kind === 'hf_repo'` **硬返回 501**。当前实际能力是「从固定 manifest 目录里选」，不是「任意 HF」。
> 要么补上「用户手工提供 SHA-256」的导入路径，要么把这句从对外话术里撤掉。
