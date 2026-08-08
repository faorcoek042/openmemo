---
id: ADR-014
title: 冷启动死锁 —— CPU 包豁免 probe 门禁
status: accepted
date: 2026-08-02
decider: Meta Manager
input: coordination/inbox/gpu-runtime.md (T-044 冷启动验证)
---

## 0. 结论先行：**当前一台干净机器装不起来，章程要求 2.1 第一步就断**

`gpu-runtime` 在全新空 dataDir 上只用 HTTP API 装机，**四步只走通一步**，
selfcheck 最终 **EXIT=1，失败 7 项**。

**这是本项目最重要的一次验证**，因为此前所有"跑通"都是在已手工装好东西的环境里做的。

## 1. 死锁（最致命）

```
POST /api/backends/install {"id":"whispercpp-cpu-linux-x64"} → 409
  probe did not complete: probe executable not found: /tmp/cold/bin/runtime/probe
```

本机 4 个包**全部** `applicable=false`，理由都是这一条。

**成因**：`applicability()` 要求 `hardware.backends[].available`，而该字段来自 probe ——
**而 probe 可执行文件本身就装在后端包里**。

> 装不了包 → 没有 probe → 探测不出"可用" → 装不了包。

## 2. 裁决：**CPU 包豁免 probe 门禁**（采纳 `gpu-runtime` 的建议）

理由是他给的，而且和 ADR-003 完全自洽：

> ADR-003 里 **CPU 是 L1「永不失败的兜底」，是让探测成为可能的前提**，
> 不该被探测结果反过来卡住；**只有 L2 加速包该按 probe gate**。

**规则**：

- **L1 CPU 后端包：无条件 `applicable=true`**，不查 probe、不查硬件。它是地基。
- **L2 加速包（CUDA/Vulkan/ROCm/Metal）：维持 probe gate**，探测不到就不给装。
- 这条同时呼应 ADR-003 附录 A.3：**L1 CPU 包是承重墙**（删光会 SIGABRT），
  既然不能删，就更不该装不上。

## 3. 另外三处冷启动断点（全部归 daemon）

| #   | 问题                                                                                                                                       | 后果                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2   | **manifest 文件名硬编码** —— `MODEL_MANIFEST_FILES = ['models-whisper.json','models-llm.json']`、`BACKEND_MANIFEST_FILE = 'backends.json'` | 磁盘上已有的 `models-asr-support.json`（含刚补的 `vad/silero-vad-ggml`）与 `sqlite-ext.json` **从不加载** → VAD / Paraformer / 标点 / 中文分词器**全都装不了** |
| 3   | **模型查找写死文件名** —— 装成 `by-name/asr/ggml-base-q5_1.bin`，daemon 只找 `ggml-base.en.bin`/`ggml-base.bin`                            | 装成功了仍然"找不到"                                                                                                                                           |
| 4   | **无扩展安装端点** —— `/api/extensions` 404，且 `installPath: bin/ext` 不是 backend store 布局                                             | 中文分词器网页装不了                                                                                                                                           |

**通则**：#2 和 #3 是同一个错误形状 —— **写死清单**。
改为**列目录**：manifest 目录下所有 `*.json` 都加载，模型目录下所有文件都是候选。
`gpu-runtime` 已就此更正自己上一轮的补丁：**"写死文件名列表本身就是错的"**。

#2 还是"上游做对了、下游不读"的又一例：`model-mgmt` 已按反馈补了 ggml 格式的 VAD，
**是 daemon 的硬编码文件名把它挡在外面**。

## 4. 本轮验掉的两项未验证（好消息）

- **熔断器**（`gpu-runtime` 在 T-012 标注的未验证项）：阈值 2、第 2 次失败熔断、
  驱动版本变化清除裁决、成功复位 —— **全部正确**。
- **下载器这一层实测是好的**：真下载、真校验、真硬链，`.partial` 续传文件确实生成。
  → **问题全在"目录里有没有这条"和"装完谁去找它"，不在下载本身。**

## 5. 仍未解决

`ffmpeg` / `ffprobe` 仍来自系统 `/usr/bin/`，产品路径上应来自安装包。已记入冷启动清单。

## 6. 记一句

`gpu-runtime` 原话：**"我没有为了让数字好看去绕过阻塞——装不上就是装不上，selfcheck 仍 EXIT=1。"**
一个能把自己的验收判成失败的验证，才是有用的验证。
