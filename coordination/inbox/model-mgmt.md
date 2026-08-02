# inbox: model-mgmt

## [2026-08-02 20:55] T-004 DONE

交付: `/root/memo/docs/research/R-04-model-mgmt.md`（id: R-04, status: draft, TL;DR 23 行）

要点:
- 业界拆解 9 个产品，均直读源码/官方文档（Ollama `server/download.go`、ComfyUI-Manager
  `manager_server.py`、textgen `download-model.py`、Vibe、Buzz、GPT4All `download.cpp`/`models3.json`、
  LM Studio / Jan / MacWhisper 文档）。**下载引擎抄 Ollama，目录分发抄 ComfyUI-Manager，
  "校验通过才算安装"抄 GPT4All**（唯一把校验做对的）。
- **实测验证的关键事实**：HF `lfs.oid` == `x-linked-etag` == 文件 SHA-256（三处交叉）；
  HF/ModelScope 均支持 Range（206）；**Qwen 官方在 ModelScope 有同名 repo，10/10 文件
  size+sha256 与 HF 逐字节相同** → 中文用户 LLM 主线有官方免翻墙源。
- **`hf-mirror.com` 从美国 IP 一律 308 跳回 HF（地理围栏），无法从本机验证其国内行为** ——
  §5.4 附了大陆复测脚本，需要一台大陆出口机器跑。
- 【设计利器，已验证】**8 MB Range 请求即可读出完整 GGUF 元数据**（layers/n_kv_head/key_length），
  不必下载 2.5 GB 文件 → 显存需求可由 CI 自动生成，不靠人工手填（GPT4All 的 `ramrequired` 是手填的）。
  据此算出 8K 上下文 KV cache ≈ 1.1 GB —— 只比"文件大小 vs 显存"会系统性偏乐观，LM Studio 就翻过车。
- 完整交付 §8 API（14 个 endpoint + JSON schema + 状态机 + 错误码表）、§9 五张 ASCII 线框图、
  §6 存储布局（内容寻址 blob + manifest + by-name 硬链接）、§7 三档判定规则表、§10 三层目录策略。

下一步建议:
- `gpu-runtime` 对齐 §7.1 的硬件描述 JSON 契约（我只依赖 6 个 ★ 字段），我可按其反馈改。
- 运行时（要求 2.1）与模型（要求 2.2）应**共用同一下载引擎与 SSE 通道**，我的 job 模型已预留 `kind` 扩展位。
- Wave 2 架构设计请把「模型下载服务」定为**独立于推理进程**的组件（下载不能被模型加载阻塞）。

需要 Manager 决策:
1. **hf-mirror 国内实测**——需一台大陆出口机器跑 §5.4 脚本，否则该分支只能标"未验证"上线。
2. **Gemma 权重能否自建 CDN 镜像**（Gemma Terms 有再分发限制）→ 建议转 `oss-scout`；
   不确定就首版只镜像 Qwen + whisper（均 Apache-2.0 / MIT）。
3. **是否接受"不编 WER 数字"**：我未找到口径一致、可引用的 Whisper WER/RTF 表，故标 `UNKNOWN`，
   改为产品内跑真实自测基准（§7.4）。若市场/文案需要对外准确率数字，需另立评测任务。

自查（诚实规则）:
- 我在初稿里把 Qwen3-8B 的字节数由"5.72 GB"反推成了具体整数，属于未经验证的数字。
  已重新实测并更正（§2.1），正确值为 5,720,761,152。**此类回填数字我已全文复核一遍。**
- 我派出的调研 agent 把 `ggml-tiny.bin`(77,691,713) 与 `ggml-tiny.en.bin`(77,704,715) 弄混，
  我已实测更正并写进 §3.1 作为"按体积判重会出错"的实例。
- §7.2 的 whisper overhead 表由官方 Memory usage 表反推，已回代验证 5/5 行且全部偏保守；
  但 `large-v3-turbo` 官方无数据，我按 large 估，标了未验证。
- §7.4 的 `flops_ratio` 外推系数、§7.3 的 `n_gpu_layers` 估算式均标注为未验证，需开发期实测校准。

派生 agent（按协议 §5 记录，未 kill，可复用）:
- `a5d437ac1abfd9895` — Ollama / ComfyUI-Manager / text-generation-webui API 与源码拆解（sonnet5）
- `afcf75ca3ecf69ef6` — LM Studio / Jan / GPT4All / Msty / AnythingLLM UX（sonnet5）
- `a143e6caa1c863031` — Vibe / Buzz / MacWhisper / whisper.cpp 官方分发（sonnet5）
