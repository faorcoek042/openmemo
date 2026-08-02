# `vendor/` —— 第三方组件的引入边界

本目录是 **ADR-001 三分法** 中 **A 类（git submodule）** 与 **C 类（运行时下载清单）** 的落地位置。

| 子目录              | 类别     | 内容                                                                |
| ------------------- | -------- | ------------------------------------------------------------------- |
| `vendor/<name>/`    | **A 类** | git submodule，pin 到 tag。见 `/.gitmodules`                        |
| `vendor/manifests/` | **C 类** | 运行时下载物清单（JSON，含 URL + SHA256 + 许可证）。见该目录 README |

**B 类（包管理器）不在本目录** —— 走各 `package.json` + `pnpm-lock.yaml`。

---

## A 类 submodule 现状

初始化：

```bash
pnpm submodules:init
# = git submodule update --init --depth 1 --recommend-shallow
```

| 路径                 | 上游                 | 许可证                  | pin       | 用途                                    |
| -------------------- | -------------------- | ----------------------- | --------- | --------------------------------------- |
| `vendor/whisper.cpp` | ggml-org/whisper.cpp | MIT                     | `v1.9.1`  | ASR 主引擎；需自建 CI（ADR-003 决策 2） |
| `vendor/llama.cpp`   | ggml-org/llama.cpp   | MIT                     | `b10223`  | 本地 LLM 推理（摘要/大纲/导图生成）     |
| `vendor/sherpa-onnx` | k2-fsa/sherpa-onnx   | Apache-2.0              | `v1.13.4` | 副引擎：流式 ASR + VAD + 说话人分离     |
| `vendor/sqlite-vec`  | asg017/sqlite-vec    | Apache-2.0              | `v0.1.9`  | SQLite 向量检索扩展                     |
| `vendor/libsimple`   | wangfenjin/simple    | **MIT**（双授权中选定） | `v0.7.1`  | SQLite FTS5 中文分词（jieba + 拼音）    |

> 以上 star / 许可证 / 版本均在 **2026-08-02** 由 `oss-scout` 实地核实（R-03 §2）。

### ⚖️ libsimple 的双授权选择（**必须书面留痕**）

`wangfenjin/simple` 的 LICENSE 原文：

> "This software is licensed under a dual license system (MIT or GPL version 3 or later versions of GPL).
> You are free to choose with which of both licenses (MIT or GPL) you want to use this library."

**OpenMemo 明确选择 MIT 分支。**
这条声明必须同时出现在最终分发物的第三方许可证清单里，否则可能被解读为 GPL-3.0。

### 为什么 FFmpeg 不在这里

R-03 §4.5 原本要求把 FFmpeg 源码 submodule 进来自建 LGPL-only 构建
（因为 **macOS 没有维护中的 LGPL 预编译源**：BtbN 只出 win/linux，gyan.dev 与 evermeet 全是 GPL 构建）。

**ADR-002 v2 放宽后此需求消失** —— 用户已明确"仅个人自用"，GPL 的分发义务不触发，
故改用 npm `ffmpeg-static`（GPL-3.0，B 类）。

> ⚠️ **升级路径**：若日后恢复商用/分发意图，必须把 FFmpeg 加回 `.gitmodules` 并自建 LGPL 构建。
> 为此 `packages/pipeline` 对 FFmpeg 的调用**必须走适配层**（见该包 `src/index.ts` 注释），
> 使这次回滚只需换适配层实现。

---

## 修改 submodule 内容的唯一合法途径（规则 R-B）

**禁止**直接编辑 `vendor/<name>/` 内的文件 —— `git submodule update` 会静默丢弃这些修改。

需要打补丁时：

1. fork 上游到本项目的 org；
2. 在 fork 上开分支、提交；
3. 改 `.gitmodules` 的 `url` 指向 fork，`git submodule sync`；
4. 在提交信息里写明：为什么改、是否已向上游提 PR（附链接）。

---

## 升级 submodule（规则 R-C）

一律 pin 到 tag，禁止跟踪分支。升级流程：

```bash
git -C vendor/<name> fetch --depth 1 origin tag <new-tag>
git -C vendor/<name> checkout <new-tag>
git add vendor/<name>
# 同步更新 .gitmodules 注释里的 pin 版本号，以及本文件的表格
```

升级必须走 PR，并触发 CI 全平台重编译（mac / win / linux × CPU/CUDA/Vulkan/ROCm/Metal）。
