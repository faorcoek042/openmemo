---
id: ADR-001
title: 第三方依赖的引入方式 —— submodule / 包管理器 / 运行时下载 三分法
status: accepted
date: 2026-08-02
decider: Meta Manager
supersedes: CHARTER §4 C2 的字面表述
input: docs/research/R-03-oss-modules.md §1
---

## 背景

章程 C2 原文：「复用开源模块时，采用模块化调用 + git submodule 引入（`vendor/`），禁止直接复制粘贴源码。」

`oss-scout` 在 R-03 §1 论证了字面执行会产生 4 个具体故障：依赖解析崩坏（npm 无法参与版本求解、
React 双实例）、失去 semver 与安全告警（Dependabot/audit 只认 lockfile）、许可证污染叙事变弱
（把 GPL 组件拉进构建树会削弱"独立进程"论证）、仓库体积与 clone 时间灾难。

## 决策

**采纳三分法。** C2 的**立法本意**是「禁止复制粘贴源码、保留可追溯的上游、模块化调用」——
这个本意完整保留，只是实现手段按组件性质分流：

| 类别 | 判据 | 手段 | 适用组件 |
|------|------|------|----------|
| **A** | 我们需要自己编译 / 打补丁 / ABI 与模型格式强耦合需 pin commit | **git submodule** → `vendor/` | ffmpeg, whisper.cpp, sherpa-onnx, llama.cpp, sqlite-vec, libsimple |
| **B** | 纯语言级库（npm / crates.io），有 semver 与 lockfile | **包管理器 + lockfile** | react, tiptap, mind-elixir-core, tauri, … |
| **C** | 终端用户机器上的大二进制与模型权重 | **运行时下载 + SHA256 校验 + manifest 入 git** | GPU 后端二进制, GGUF/ONNX 模型权重 |

### 强制配套（不可省略，这是 C2 本意的落地保障）
1. **C 类的 manifest 必须入 git**（`vendor/manifests/*.json`，含 URL + SHA256 + 版本 + 许可证），
   保证"下载了什么"完全可追溯、可审计、可复现。
2. **所有 A/B/C 类组件都必须模块化调用**——通过明确的适配层接口，禁止把第三方 API 泄漏到业务代码。
3. **禁止复制粘贴源码**的约束**继续全域生效**，仅有 ADR-002 一项豁免。
4. **CI 强制许可证白名单**：`cargo-deny` + `license-checker`，命中黑名单直接 fail build。

## 后果
- ✅ 保留了 C2 的全部本意（可追溯上游、模块化、无复制粘贴），同时恢复了依赖解析与安全告警。
- ✅ 许可证隔离更强：GPL 风险组件走 C 类（运行时下载 + 子进程），物理上不进构建树。
- ⚠️ 引入了 manifest 维护成本 —— 必须有 CI 校验 manifest 与实际下载物一致，否则 C 类会失去可追溯性。
- ⚠️ **本决策修改了用户明确给出的约束 C1-C6 之一，已向用户明示待其确认。若用户坚持字面 C2，
  需回滚本 ADR 并接受上述 4 个故障。**
