---
id: ADR-008
title: 流水线裁决（T-020）+ TD-002 关闭 + 安全缺口处置
status: accepted
date: 2026-08-02
decider: Meta Manager
input: docs/design/D-06-pipeline.md, coordination/inbox/gpu-runtime.md
---

## 实测结果（全部真跑，非设计意图）

| 场景 | 结果 |
|------|------|
| F2 本地文件 | 11.0s 音频 → **0.80s**，RTF 0.047（**21.3x**），1 chunk |
| F1 真实 URL | 2.66 MB / 220.2s → **9 chunk / 45 段 / 20.2s**，ASR RTF 0.045（**22.2x**） |
| 测试 | **75/75 全绿**，eslint 干净，`tsc -b` 干净，**未新增依赖**（用 Node 内置 `node:test`） |
| 命令注入 | 7 层全落地，**25 个攻击用例逐层对应**，全部拦住 |

## 决策 1：**TD-002 关闭** —— 从注释变成跑出来的事实

ADR-002 要求"GPL 组件架构上可替换"，`oss-scout` 曾指出这**只是注释、无代码强制**。

现在它被证明了：**F1 真实 URL 在 `enableSiteExtractor: false`（yt-dlp 全关）下完整跑通。**
不是声称可替换，是关掉之后真的还能用。

`gpu-runtime` 另补一条自我更正：**TD-002 真正的修正是"按 probe 回退"而非"按打分"**
—— 他第一版做错了，是测试逼出来的。

## 决策 2：`SubprocessRunner` 留在 `packages/pipeline` —— 追认

D-01 原写 daemon，`gpu-runtime` 放在了 pipeline。**追认 pipeline 位置**：
pipeline 是目前唯一消费者，放 daemon 会造成 `daemon → pipeline` 的反向依赖。
若日后 daemon 也需要 spawn，再提取为独立 `packages/subprocess`。
→ 请 `architect` 在 D-01 留痕订正（ADR-007 决策 6 的留痕要求同样适用）。

## 决策 3：F3 流式转写 —— **必须进 v1，立即排期**

F3（录音转文字）是**用户原始需求明确列出的功能**，不是可选项。
当前 `SherpaOnnxEngine` 只留了接口，是唯一没动的功能。**指派 `gpu-runtime` 下一轮完成。**

## 决策 4：两个已知 TOCTOU 缺口 —— **不阻塞 v1，但必须显式记录**

依据：产品是**个人自用 + daemon 绑 127.0.0.1 + token 鉴权**，攻击面需要本机已有恶意进程，
此前提下 TOCTOU 的实际风险很低。

**但不许静默放过**：要求在 `docs/SECURITY.md` 里逐条写明缺口位置、触发前提、
为何判定可接受、以及"若日后改为多用户/联网部署则必须修复"。
**风险被记录下来才叫接受风险，没记录就是忽略风险。**

---

# 附：真跑抓出的三个 bug（记录方法论价值，不是记过）

`gpu-runtime` 明确指出这三个 bug **只有真跑才能暴露**，静态检查和单元测试都看不见：

1. **`isSafeExecutable` 用宿主的 `path.isAbsolute` 判 Windows 路径**
   → 在 Linux 上跑时 CVE 分支**不可达**，`.bat` 测试**一直在为错误的理由通过**。
   ⚠️ 这类"测试通过但通过的理由是错的"是最危险的假绿灯。
2. **whisper 的 `offsets` 是绝对时间，他又加了一次偏移**
   → 220s 录音里出现 **419.9s** 的段落。**单 chunk 测试看不见，只有多 chunk 真跑能暴露。**
3. **chunk 边界重复转写**（whisper 会越过 `--duration`）
   → 加时间重叠去重后，段数 51→45，时间戳恢复单调。

**全项目结论：多 chunk / 长输入 / 跨平台路径，这三类必须真跑，单元测试给不出保证。**

# 附：三条实测得来的事实（写进实现规范）
- **VAD 不需要新依赖** —— whisper.cpp 自带 Silero，已在 L1 包里。**单位是厘秒不是秒**（易错）。
- **whisper v1.9.1 不输出 `avg_logprob`** → 置信度改用真实 token 概率均值，实测区间 0.65–0.93。
- GPU lane 互斥 **0 违例**；异常与 abort 两条路径都不泄漏 permit。

# 附：未验证清单（如实记录，进 A 类待环境）
yt-dlp 路径、真实 RSS feed、HLS、Windows/macOS、长音频、中途取消、**中文转写**。
→ 其中**中文转写必须补测**（产品主要面向中文用户），已排入下一轮。
