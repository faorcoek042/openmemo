---
id: R-04
author: model-mgmt
status: draft
date: 2026-08-02
---

## TL;DR（≤ 25 行，Manager 只读这里）

- **抄谁**：下载引擎抄 Ollama（16 分片 + Range 断点续传 + `.partial` sidecar + 指数退避重试，已读源码验证）；
  任务队列/目录分发抄 ComfyUI-Manager（远程 JSON 目录 + local/cache/remote 三模式降级 + 单 worker 串行队列）。
- **存储**：内容寻址 `blobs/sha256-<hex>` + `manifests/<role>/<id>.json` + `by-name/` 硬链接视图。
  已验证：HF 与 ModelScope 的同一 ggml 文件**字节完全一致**（sha256 相同，`cmp` 通过）→ 换镜像不需重下，天然去重。
- **进度推送选 SSE，不选 WebSocket**。理由：严格单向、走同一条 HTTP 鉴权/CORS 路径、`EventSource` 自带
  重连 + `Last-Event-ID` 重放。用**一条** ~~`/api/models/events`~~ 复用全部任务，规避 HTTP/1.1 六连接上限。
  实时 ASR 那种双向低延迟场景另开 ~~`/ws/transcribe`~~，不要为了统一而统一。
  > 📝 **落地时两个端点都改名了（2026-08-06 订正，原名保留在上）**：
  > `/api/models/events` → **全局唯一的 `/api/events`**（ADR-004 SSE 单流，见 `apps/daemon/src/http/server.ts:338`
  > 与 `docs/design/D-01-architecture.md:326`）；`/ws/transcribe` → **`/ws/recorder`**（`apps/daemon/src/ws/recorder.ts`）。
  > `grep -rn "api/models/events" apps packages` **零命中**。**照本文原名接 UI 会 404。**
  > 决策本身（SSE 而非 WS、单流复用）仍然成立。
- **国内下载（已实测）**：`hf-mirror.com` 从美国 IP 对 `/api/*` 和 `/resolve/*` 一律 308 跳回 huggingface.co
  → 它是地理围栏的，**本机无法验证其在国内的代理行为**（§5.4 附大陆复测脚本，请找人跑）。
- **重大利好（已验证）**：**Qwen 官方在 ModelScope 有同名 repo `Qwen/Qwen3-{4B,8B}-GGUF`，
  10/10 文件的 size 与 sha256 与 HF 逐字节相同**。whisper ggml 则只有社区搬运版（仍字节一致）。
  → 中文用户的 LLM 主线有官方免翻墙源。设计结论：**目录钉死 sha256，镜像退化为不可信传输通道**；
  首启并行探针测速自动选源（不用 GeoIP），用户可覆盖。
- **"能不能跑"**：Whisper 用 `内存 = 权重文件 + 每架构固定开销`（由 whisper.cpp README 官方表反推，
  quant 版本开销不缩水）；LLM 用真实 GGUF 头算 KV cache。**已验证可用 8 MB Range 请求读出完整 GGUF 元数据**
  （layers / n_kv_head / key_length），不必下载 2.5 GB 文件 → 目录可自动生成显存需求，不靠手填。
- **速度分档不编数字**：RTF 基准我查不到可信来源，改为后端装好后跑一次 10 秒自测样本，实测 RTF 缓存下来外推。
- **模型目录**：内置兜底 JSON（编译进二进制）→ 远程签名 JSON（Ed25519，公钥硬编码，ETag 缓存 24h）→
  仅"高级/自带模型"页才实时查 HF。不实时查 HF 做主目录：CN 不可达 + 匿名限流 500 req/300s（实测响应头）。
- **未验证/存疑**：hf-mirror 国内行为；MacWhisper 内部（闭源）；whisper 各模型 WER/RTF 具体数字（`UNKNOWN`，
  不编）；gemma3 的 SWA 会让实际 KV 小于我算的上界；Ollama `"verifying sha256 digest"` 不在 download.go 里。
- **对其他 agent 的影响**：`gpu-runtime` 请看 §7 的**硬件描述 JSON 契约提案**（我先假设，请对齐 R-02）。
  前端请照 §9 线框图做。架构组注意：模型管理必须是**独立于推理进程的下载服务**，不能塞进 whisper/llama 进程里。

---

# 详细内容

## 0. 本文档的证据等级约定

| 标记         | 含义                                                                       |
| ------------ | -------------------------------------------------------------------------- |
| **[已验证]** | 我在本机 `curl`/解析实测过，或直接 fetch 到源码/官方文档原文，命令附在文中 |
| **[文档]**   | 来自官方文档/源码原文，但我没有实际运行                                    |
| **[未验证]** | 推断、二手信息、或社区说法                                                 |
| `UNKNOWN`    | 查不到可信来源，**不编**                                                   |

本机出口 IP 实测为 **美国洛杉矶**（`AS25820 IT7 Networks`，`curl https://ipinfo.io/json`）。
这直接影响国内镜像的可验证性，见 §5。

---

## 1. 业界方案拆解

### 1.1 Ollama —— 下载引擎的黄金参考 [已验证：直接 fetch 源码与 docs]

**HTTP API（`docs/api.md` 原文）**

| Endpoint                                                 | 说明                                                                                                                                                        |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/pull`                                         | 请求体 `{model, insecure?, stream?}`。**"Cancelled pulls are resumed from where they left off, and multiple calls will share the same download progress."** |
| `GET /api/tags`                                          | 已安装模型列表                                                                                                                                              |
| `POST /api/show`                                         | 模型详情，含 `model_info`（`llama.context_length`、`llama.attention.head_count` 等）、`capabilities`                                                        |
| `DELETE /api/delete`                                     | 体 `{model}`                                                                                                                                                |
| `POST /api/copy` / `POST /api/create` / `POST /api/push` | 复制 / 构建（可 `quantize`）/ 上传                                                                                                                          |
| `GET /api/ps`                                            | 已载入显存的模型，含 `size_vram`、`expires_at`                                                                                                              |
| `HEAD /api/blobs/:digest` / `POST /api/blobs/:digest`    | blob 存在性探测 / 上传                                                                                                                                      |

`POST /api/pull` 的流式响应（NDJSON，逐行）：

```json
{"status": "pulling manifest"}
{"status": "pulling digestname", "digest": "digestname", "total": 2142590208, "completed": 241970}
{"status": "verifying sha256 digest"}
{"status": "writing manifest"}
{"status": "removing any unused layers"}
{"status": "success"}
```

> 文档明确写："Until any of the download is completed, the `completed` key may not be included."
> → **前端必须容忍 `completed` 缺失**。这是个容易踩的坑，我们的 schema 里要把它设为必填并由服务端补 0。

`GET /api/tags` 响应（原文示例）：

```json
{
  "models": [
    {
      "name": "deepseek-r1:latest",
      "model": "deepseek-r1:latest",
      "modified_at": "2025-05-10T08:06:48.639712648-07:00",
      "size": 4683075271,
      "digest": "0a8c266910232fd3291e71e5ba1e058cc5af9d411192cf88b6d30e92b6e73163",
      "details": {
        "parent_model": "",
        "format": "gguf",
        "family": "qwen2",
        "families": ["qwen2"],
        "parameter_size": "7.6B",
        "quantization_level": "Q4_K_M"
      }
    }
  ]
}
```

**存储布局** [文档：`docs/faq.mdx`]

- macOS `~/.ollama/models`；Linux `/usr/share/ollama/.ollama/models`；Windows `C:\Users\%username%\.ollama\models`；`OLLAMA_MODELS` 可覆盖。
- 结构：`models/manifests/<host>/<namespace>/<model>/<tag>`（JSON）+ `models/blobs/sha256-<hex>`（扁平、内容寻址）。
- 去重：多个 manifest 可引用同一 blob digest，只存一份；删除模型时只回收「独占引用」的 blob。
- 注：官方两份文档对 blob 文件名分隔符自相矛盾（`modelfile.mdx` 用 `sha256-`，`api.md` 用 `sha256:`）。
  `:` 在 Windows 路径非法，**我们一律用 `-`**。

**Registry 协议** [已验证：`curl https://registry.ollama.ai/v2/library/llama3.2/manifests/1b`]

```json
{
  "schemaVersion": 2,
  "mediaType": "application/vnd.docker.distribution.manifest.v2+json",
  "config": {
    "mediaType": "application/vnd.docker.container.image.v1+json",
    "digest": "sha256:4f65…",
    "size": 485
  },
  "layers": [
    {
      "mediaType": "application/vnd.ollama.image.model",
      "digest": "sha256:74701a8c…",
      "size": 1321082688
    },
    {
      "mediaType": "application/vnd.ollama.image.template",
      "digest": "sha256:966de95c…",
      "size": 1429
    },
    {
      "mediaType": "application/vnd.ollama.image.license",
      "digest": "sha256:fcc5a6be…",
      "size": 7711
    }
  ]
}
```

Docker Distribution v2 的**路径与信封**，但 layer 用自定义 media type。**不是**开箱即用的 OCI registry。

**下载实现 `server/download.go`** [已验证：直接 fetch 源码]

```go
const (
    numDownloadParts          = 16
    minDownloadPartSize int64 = 100 * format.MegaByte
    maxDownloadPartSize int64 = 1000 * format.MegaByte
)
const maxRetries = 6
var downloadStallTimeout = 30 * time.Second
```

- **分片**：`part = Total / 16`，钳制在 [100 MB, 1000 MB]，末片截断。
- **并发**：`errgroup` + `SetLimit(16)`，每片一个 stall 看门狗 goroutine（30s 无进展判定卡死）。
- **续传**：稀疏数据文件 `<blob>-partial` + 每片 JSON sidecar `<blob>-partial-<N>`（记 `Completed` 偏移）。
  `Prepare()` glob sidecar；有 sidecar 就跳过已完成片，**只在没有 sidecar 时才发 HEAD 取 Content-Length**。
  成功后删 sidecar、`os.Rename` 到最终路径。
- **Range**：每片 `Range: bytes=<start>-<stop-1>`，`io.NewOffsetWriter` 定位写，`io.CopyN` 限长。
- **重试**：每片 `maxRetries=6`；取消/`ENOSPC` 立即中止；stall 重试**不消耗重试预算**（`try--`）；
  其余错误指数退避 `2^try` 秒。重定向解析用二次方退避 + jitter（`rand.Float64()+0.5`）防惊群，禁止跨主机重定向。
- **校验**：`download.go` 里**没有** sha256 校验；digest 仅作缓存 key，已存在的 blob 靠 `os.Stat` 命中，不重新 hash。
  流式里那句 `"verifying sha256 digest"` 不在此文件，`UNKNOWN`（未定位）。
  → **我们的设计必须补上这一环**，见 §6.4。

### 1.2 ComfyUI-Manager —— 目录分发与任务队列的参考 [已验证：直接 fetch 源码]

**关键 endpoint（`glob/manager_server.py` 实读）**

```
GET  /externalmodel/getlist          # 模型目录（带 mode 参数）
POST /manager/queue/install_model    # 入队下载
POST /manager/queue/start            # 启动 worker
GET  /manager/queue/status           # {"total_count","done_count","in_progress_count","is_processing"}
POST /manager/queue/reset            # 换一个新的 queue.Queue()
GET/POST /manager/db_mode            # local | cache | remote
GET/POST /manager/channel_url_list   # 切换目录源
```

**队列设计**：stdlib `queue.Queue()` FIFO，`task_queue.put(("install-model", (ui_id, json_data)))`；
`/manager/queue/start` 起**单个** `threading.Thread` 串行消费。`install_model` 校验后立即返回 200（fire-and-forget）。

**目录格式 `model-list.json`**（fetch 时 538 条），每条：

```json
{
  "name": "TAEF1 Decoder",
  "type": "TAESD",
  "base": "FLUX.1",
  "save_path": "vae_approx",
  "description": "…",
  "reference": "https://github.com/madebyollin/taesd",
  "filename": "taef1_decoder.pth",
  "url": "https://github.com/madebyollin/taesd/raw/main/taef1_decoder.pth",
  "size": "4.71MB"
}
```

**注意它的缺陷**：`size` 是**字符串**（`"4.71MB"`），没有 `sha256`，没有结构化硬件需求。
→ 我们的目录 schema 必须用整数字节 + 强制 digest，见 §8.1。

**三模式降级 `core.get_data_by_mode(mode, filename, channel_url)`**：

| mode     | 行为                                                                                  |
| -------- | ------------------------------------------------------------------------------------- |
| `local`  | 只读随包 JSON，完全不联网                                                             |
| `cache`  | 本地缓存 < 1 天则用缓存，否则拉远程再缓存（缓存名 = `simple_hash(uri)+'_'+filename`） |
| `remote` | 每次实时拉 `channel_url + '/' + filename`                                             |

任何网络异常 → 静默回落 local（日志 `"switching to local mode"`）。另有独立的 `network_mode`：
`public` / `private`（内网自定义 channel）/ `offline`（永不联网）。**这套降级链值得直接照抄**，见 §10。

**进度推送**：不是轮询。后端 `PromptServer.instance.send_sync("cm-queue-status", {...})`，
前端 `js/model-manager.js` 里 `api.addEventListener("cm-queue-status", this.onQueueStatus)`
—— 走 ComfyUI 自带的 `/ws`。**面板打开时先 REST 拉一次** `GET /manager/queue/status` 拿初始计数，
之后交给推送。→ 这个「一次 REST 快照 + 后续流式增量」的模式我们要抄，见 §8.5。

**安全模型**（README 原文四档）：`strong` / `normal` / `normal-` / `weak`。
高危动作包括「下载不在白名单 `model-list.json` 里的非 `.safetensors` 模型」「任意 git URL 安装」「pip install」。
`allow_git_url_install` / `allow_pip_install` 与 `security_level` **解耦**，必须单独开。
`glob/security_check.py` 是**已知恶意包黑名单扫描器**（如 `ultralytics==8.3.41/42` 挖矿事件、
`litellm==1.82.7/8` 凭据外泄），**不是** pickle 格式扫描器。
→ 教训：**白名单 + 黑名单都不够，要用签名目录 + 内容 digest**，见 §10.3。

**镜像支持**：`HF_ENDPOINT` 环境变量可透明重写 `huggingface.co` URL。可选 aria2 后端
（`COMFYUI_MANAGER_ARIA2_SERVER` + `..._SECRET`，`aria2p` RPC，1s 轮询 `completed_length`）。
`manager_downloader.py` 里**未发现** sha256 校验。

### 1.3 text-generation-webui —— HF 拉取与量化过滤 [已验证：直接 fetch `download-model.py`]

- Base URL：`os.environ.get("HF_ENDPOINT") or "https://huggingface.co"`（同样认 `HF_ENDPOINT`）。
- 列文件：`GET {base}/api/models/{model}/tree/{branch}`，分页游标是 base64 编码的 `{"file_name": "<path>"}:50`。
- 下载：`{base}/{model}/resolve/{branch}/{fname}`。
- **格式优先级**：若 safetensors 与 pytorch/pt/gguf 并存，只留 safetensors。
- **量化选择**：偏好文件名含 `q4_k_m`；若无，则**整个丢弃全部 `.gguf`**，只留非 GGUF 资产。
  → 这是个粗暴的硬编码策略，我们不抄，改用显式量化选择器（§9）。
- **并发/续传**：`thread_map(max_workers=4)`，块 1 MiB；本地文件存在时先 HEAD 读 `x-linked-size`
  （优先）或 `content-length`，本地 ≥ 远端则跳过，否则 `Range: bytes=<local>-` + `'ab'` 追加。
- **重试**：`max_retries=7`，指数退避 `2**attempt`。
- **校验**：sha256 取自 HF tree API 的 `dict[i]['lfs']['oid']`，但**只有加 `--check` 才跑**，
  正常下载后不自动校验。→ 我们**默认强制校验**。
- **落盘**：`user_data/models/{org}_{repo}`（非 main 分支加 `_{branch}`）；GGUF 单文件直接落 base 目录；
  另写 `huggingface-metadata.txt` 记录 sha256sum。
- **UI**（`modules/ui_model_menu.py` 原文）：下载框 label `"Download model or LoRA"`，
  info `"Enter the Hugging Face username/model path, for instance: facebook/galactica-125m. To specify a
branch, add it at the end after a ':' character…"`，配 `download_specific_file` 文本框
  （placeholder `"File name (for GGUF models)"`）与 `Download` / `Get file list` 两个按钮。
  加载器参数暴露得极多（`gpu_layers` slider info: _"Number of layers to offload to the GPU. -1 = auto."_、
  `ctx_size`、`cache_type` 含 `fp16/q8_0/q4_0/…`、`split_mode`、`tensor_split`、`no_mmap`、`mlock`…）。
  → **反面教材**：把 llama.cpp 全部旋钮直接抛给用户。我们只暴露「上下文长度」与「GPU 卸载：自动/手动」两项。

### 1.4 LM Studio / Jan / GPT4All / Msty / AnythingLLM

#### LM Studio —— 硬件适配 UI 的标杆（但估算器有已知缺陷）

**兼容性徽章原文**（社区文档交叉确认，**官方文档未给出阈值公式** → 规则本身 `UNKNOWN`）：

```
"Full GPU offload possible"        （绿色）
"Partial GPU offload possible"
"Some GPU offload possible"
"⚠️ Likely to large for this machine"   ← 官方文案自带拼写错误（应为 "too large"）
```

外加一个**绿色火箭图标**表示「这个量化档你的机器装得下」。Discover 页右上角常驻显示
本机「estimated RAM and VRAM capacities」。

⚠ **两个已验证的缺陷，我们必须避开**：

1. Settings > Hardware 里显示的显存是**总量而非可用量**（社区文档明确指出）。
   → 我们的 §7.3 用 `vram_free_mb`，拿不到才退回 `total × 0.85`。
2. GitHub issue `lmstudio-ai/lms#67`：双 RTX 3090 环境下徽章显示
   "Full GPU Offload Possible"，实际加载**直接 OOM 崩溃** —— 估算器不考虑多 GPU。
   → 我们的硬件契约（§7.1）把 `gpus` 设计为**数组**且带 `selected_gpu_index`，
   显存预算只算被选中的那张卡，不做跨卡求和。

**加载前估算器**（`lms load --estimate-only`，官方文档原文）：

```
$ lms load --estimate-only gpt-oss-120b
Model: openai/gpt-oss-120b
Estimated GPU Memory:   65.68 GB
Estimated Total Memory: 65.68 GB

Estimate: This model may be loaded based on your resource guardrails settings.
```

官方标注为 **beta**，且已知**未完全计入长文本生成时 KV cache 的增长**。
→ 这恰好印证 §4.2 的判断：KV cache 是这类估算最常见的漏项，我们从 GGUF 头精确算它。

**模型管理 REST API**（官方文档原文）：

```jsonc
// POST /api/v1/models/download   body: {"model":"ibm/granite-4-micro","quantization":"Q4_K_M"}
{ "job_id":"job_493c7c9ded", "status":"downloading",
  "total_size_bytes":2279145003, "started_at":"2025-10-03T15:33:23.496Z" }

// GET /api/v1/models/download/status/:job_id
{ "job_id":"job_493c7c9ded", "status":"completed",
  "total_size_bytes":2279145003, "downloaded_bytes":2279145003,
  "started_at":"…", "completed_at":"…" }
// downloading 时另有 bytes_per_second 与 estimated_completion
// status ∈ downloading | paused | completed | failed | already_downloaded
```

→ **这是 job-id + 轮询模型，没有推送**。我们的 §8.3/§8.4 的 job 对象刻意与之保持形状接近
（便于将来兼容），但**进度走 SSE 推送而非轮询**（§8.5）。注意它**没有 percent 字段**，
要客户端自己除 —— 我们同样只给字节，不给百分比（避免服务端/客户端四舍五入不一致）。

`GET /api/v0/models` 的字段（官方文档）：`id` / `object` / `type`(`llm`|`vlm`|`embeddings`) /
`publisher` / `arch` / `compatibility_type`(`gguf`|`mlx`) / `quantization` / `state` / `max_context_length`。
→ `compatibility_type` 与 `arch` 这两个字段值得抄进我们的 manifest（§6.4 已有 `format` / `arch`）。

**存储**：`~/.lmstudio/models/<publisher>/<model>/<file>.gguf`（保留 HF 目录结构）。
**校验**：所有抓取到的官方文档中**均未提及**下载后哈希校验 → `UNKNOWN`，疑似没有。

**LM Runtimes**：应用内下载 llama.cpp 引擎构建（CUDA 12 / Vulkan / ROCm / CPU，Apple Silicon 默认 MLX），
快捷键 `⌘⇧R`。官方 `/docs/cli/runtime` 页面抓取时 404，具体命令 `UNVERIFIED`。
→ **这正是章程要求 2.1 的同构问题**，请 `gpu-runtime` (R-02) 参考。运行时与模型是**两套独立的下载/安装流程**，
但应共用同一个下载引擎与 SSE 进度通道（我的 §8 设计已按此预留：job 有 `kind` 概念可扩展）。

**system requirements 原文**：macOS「16GB+ RAM recommended」；
Windows「At least 16GB of RAM is recommended」「at least 4GB of dedicated VRAM is recommended」
「**AVX2 instruction set support is required (for x64)**」。→ 印证 §7.1 需要 `cpu.features` 含 avx2。

`model.yaml`（LM Studio 推的跨平台模型规范 `modelyaml.org`）里有
`minMemoryUsageBytes: 4600000000` —— 但文档说明它是**展示用途，不参与自动决策**。
→ 又一个「有元数据但不用」的例子。我们的 `requirements` 是**真的参与** §7.3 决策的。

#### Jan —— 三档 fit 提示，文案值得直接借鉴

**兼容性 pill 的三个状态（官方文档原文）**：**"Fits"** / **"May be slow"** / **"Won't fit"**，
并明确标注 _"No data is downloaded to determine fit status."_（纯本地计算）。
**量化档分组**：**"Small"** / **"Balanced"** / **"Large"**，默认项打 **"Recommended"** 标签。

→ _\*这与我的 §7.3 三档（recommended / slow_* / unsupported）几乎完全同构，属独立收敛，增强信心。_*
我们的中文文案（「✅ 推荐」/「⚠️ 可以跑，会慢」/「⛔ 跑不动」）与之对应。
具体阈值算法官方**未公开** → `UNKNOWN`。

**存储**（官方文档）：Windows `%APPDATA%/Jan/data`、macOS `~/Library/Application Support/Jan/data`、
Linux `~/.local/share/Jan/data`。模型**按引擎分目录**：
`<data>/llamacpp/models/<org>/<repo>/`（内含 `model.yml` + `.gguf`）、`<data>/mlx/models/<model_id>/`，
引擎构建放 `<data>/llamacpp/backends/<version>/<backend>/`。

`model.yml` 里**有 `model_sha256` 字段**：

```yaml
model_path: llamacpp/models/janhq/Jan-v3-4B-base-instruct-gguf/Jan-v3-4b-base-instruct-Q4_K_XL.gguf
name: Jan-v3-4B-base-instruct-gguf
size_bytes: 2999182272
model_sha256: 1dc700f26bfb10e53d1b2daebd86d4c5f2accc50fe13acd863c59453f9abfa48
```

但**是否真的在下载后校验，文档未说明** → `UNKNOWN`。
另有「Settings > Llama.cpp > Delete All」批量删除并显示可回收空间 —— 我们的 §8.6 `/gc` 对应。

#### GPT4All —— 唯一把校验做对的，也是 `ramrequired` 的出处 [已验证：读源码 + 拉取真实 catalog]

`models3.json`（实拉，32 条）单条原文：

```json
{
  "order": "a",
  "md5sum": "a54c08a7b90e4029a8c2ab5b5dc936aa",
  "name": "Reasoner v1",
  "filename": "qwen2.5-coder-7b-instruct-q4_0.gguf",
  "filesize": "4431390720",
  "requires": "3.6.0",
  "ramrequired": "8",
  "parameters": "8 billion",
  "quant": "q4_0",
  "type": "qwen2",
  "description": "<ul><li>Based on …</li></ul>",
  "url": "https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/qwen2.5-coder-7b-instruct-q4_0.gguf",
  "chatTemplate": "{{- '<|im_start|>system\\n' }}…",
  "systemPrompt": ""
}
```

新条目改用 `sha256sum` 替代 `md5sum`。⚠ `filesize` 是**字符串**、`disableGUI` 是字符串 `"true"`
而 `embeddingModel` 是真布尔 —— **类型不一致，典型的手写 JSON 腐化**。
→ 我们的目录必须有 **schema 校验 + CI 强制**（§10.4）。

**下载与校验（`download.cpp`，值得抄）**：

- Qt `QNetworkAccessManager`，**HTTP `Range` 断点续传**，写入 `incomplete-<filename>` 临时文件；
  取消时**保留**已下载字节，按钮变 `Resume`。
- `HashAndSaveFile::hashAndSave()`：算 SHA-256（有 `sha256sum` 时）或 MD5，
  **不匹配就删掉临时文件并报错，只有匹配才 `rename()` 就位**。
  → **「校验通过才算安装」是唯一正确的语义**，我们的 §6.6 与 §8.7 状态机完全照此设计。
- ⚠ 但它下载时**关闭了 TLS 校验**（`VerifyNone`），把哈希当作唯一完整性关卡。
  **我们不学这条**：TLS 照常校验，哈希是额外一层（纵深防御）。
- UI：下载完成后显示 **"Calculating..."** + 转圈（正在算哈希）。
  → 我们的 `verifying` 状态（§8.7）对应，且给真实百分比而非转圈。

**`ramrequired` 的真实语义（源码）**：手工填写的整数 GB（见到的值 1/4/8/16），**不是算出来的**。
UI 逻辑：

```qml
visible: LLM.systemTotalRAMInGB() < ramrequired
text: "WARNING: Not recommended for your hardware. Model requires more memory (%1 GB) than your system has available (%2)."
```

`systemTotalRAMInGB()` 读的是**物理内存总量**（`/proc/meminfo` / `sysctl(HW_MEMSIZE)` /
`GlobalMemoryStatusEx`）——**不是可用内存，也完全不看显存**。
且**下载按钮从不禁用**，只是挂一行红字。

→ **这正是我们要超越的基线**：`ramrequired` 手填 + 只看总内存 + 不看显存 + 不看 KV cache。
我们的 §7.2/§7.3/§10.4（自动从 GGUF 头算）在每一项上都更严谨。
（不过「不禁用下载按钮、只警告」这个**产品决策是对的** —— 我的 §9.1 里 `unsupported` 档
按钮置灰，可能过于家长式；建议改为**可点击但需二次确认**，见 §9.6 补充。）

**存储**：`~/.local/share/nomic.ai/GPT4All/`（Linux）、`~/Library/Application Support/nomic.ai/GPT4All/`（macOS）、
`C:\Users\%USERNAME%\AppData\Local\nomic.ai\GPT4All\`（Windows）。**扁平布局，无子目录**。
**UI 卡片的 5 列统计条**：`File size` / `RAM required` / `Parameters` / `Quant` / `Type`（纯文本，无彩色徽章）。
筛选只有 `All` / `Reasoning` 两个 pill，且实现是对 HTML `description` 做**子串匹配**（没有 tags 数组）——
又一个目录 schema 腐化的例子。

#### Msty / AnythingLLM —— 简略

| 维度     | Msty                                                                               | AnythingLLM                                                                                                    |
| -------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 模型来源 | 精选 + Model Hub（Ollama registry + HF GGUF 搜索）                                 | 内置 provider 下载 GGUF + 外部（Ollama / LM Studio / LocalAI …）                                               |
| 引擎     | 自动装配 Ollama / llama.cpp / MLX；onboarding 有硬件扫描 + Light↔Powerful 推荐滑块 | 无                                                                                                             |
| 进度 UI  | 侧栏活动安装徽章 + 面板内逐项进度 + 取消                                           | **仅右上角一个指示器**，无进度条/速度/ETA                                                                      |
| 存储     | 可直接指向 Ollama 目录（`~/.ollama/models`），路径可编辑                           | `%AppData%\anythingllm-desktop\storage\models\` 等                                                             |
| 校验     | 未见文档 → `UNKNOWN`                                                               | **确认没有** —— issue #4961 明确说 `@xenova/transformers` 下载无 SHA-256/许可校验，且被 close 为 "not planned" |
| 能不能跑 | 有硬件扫描 + "hardware-fit information"，阈值未公开                                | **无**，只有一句「本地推理是实验性的，可能崩溃」                                                               |

### 1.5 Whisper 专用应用（Vibe / Buzz / MacWhisper）与 whisper.cpp 官方分发

> 这一组**最贴近我们**（同为桌面 + Whisper + 网页/webview UI）。结论先行：
> **三个都做得不够好，我们有明确的超越空间。**

#### Vibe（Tauri + webview，架构与我们最像）[已验证：直接读源码]

多源 fallback 是它唯一值得抄的点 —— `desktop/src/lib/config.ts` 原文：

```ts
export const modelUrls = {
  default: [
    'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin',
    'https://huggingface.co/vibe-app/whisper-large-v3-turbo-gguf/resolve/main/ggml-large-v3-turbo.bin',
    'https://github.com/thewh1teagle/vibe/releases/download/model-files-v1.0/ggml-large-v3-turbo.bin',
  ],
  hebrew: [
    'https://huggingface.co/ivrit-ai/whisper-large-v3-turbo-ggml/resolve/main/ggml-model.bin',
  ],
};
```

`downloadModel` 依次尝试直到成功 —— 但**没有 digest**，换源换到的是不是同一份文件全靠信任。
（对比我们 §5.3 的做法。）

- **下载**（`src-tauri/src/cmd/download.rs`）：单流 `reqwest` `bytes_stream()`，
  **无 Range、无并发分片、无 checksum**。下到 `.part` 再原子 rename（这点对）。
  **取消后 `.part` 被删 → 重来一次要从 0 开始**。3 GB 模型下到 90% 断网 = 全白费。
- **进度**：Rust `window.emit("download_progress", (downloaded, total_size))` → 前端 `listen(...)`。
  节流阈值 2 MiB。另外调 `set_progress_bar` 写**系统任务栏/Dock 进度条** —— 这个原生细节值得抄。
  前端还做了「进度只增不减」的守卫（防重试时百分比回跳）。
- **存储**：`app_local_data_dir()`（macOS `~/Library/Application Support/<bundle-id>`、
  Windows `%LOCALAPPDATA%\<bundle-id>`、Linux `~/.local/share/<bundle-id>`），
  可被 Tauri Store 里的 `models_folder` 覆盖，设置页有「更改模型目录」。**与我们 §6.1 的选择一致，互相印证。**
- **能不能跑**：只有 `is_avx2_enabled()`（`is_x86_feature_detected!("avx2")`）+ GPU 设备选择器。
  **没有任何内存/显存与模型大小的匹配判断。**
- **模型清单**：`docs/models.md` 里的 emoji 散文（🌱 Tiny / ⚖️ Medium / 🚀 Large v3 Turbo「(Recommended)」），
  **应用内下拉只显示文件名，不显示体积**。

#### Buzz（Python/PyQt）[已验证：直接读源码]

- **多后端**：`ModelType` = `WHISPER`(openai-whisper) / `WHISPER_CPP` / `HUGGING_FACE` /
  `FASTER_WHISPER` / `OPEN_AI_WHISPER_API`。
- **下载**：HF 系走 `huggingface_hub.snapshot_download(repo_id, allow_patterns=[f"ggml-{name}.bin", …])`，
  跑在**独立 `multiprocessing.Process`** 里以便硬取消；3 次指数退避重试（5/10/20 s）；
  `max_workers=8`，**Windows 强制降为 1**（文件锁竞争 bug）。
- **校验的两套标准**（很有意思）：
  - OpenAI 原版 `.pt`：**有 sha256 校验** —— 期望值直接从 URL 路径里取（`url.split("/")[-2]`），不符就重下。
  - HF 系（含 whisper.cpp ggml）：**无内容校验**，改用哨兵文件 `.buzz_complete`（`DOWNLOAD_COMPLETE_MARKER`）
    标记"下完了"，靠它区分完整 vs 半截缓存。
    → **哨兵文件是个廉价的正确性补丁，但挡不住内容损坏。我们用 §6.6 的全量 hash。**
- **进度**：`ModelDownloader(QRunnable)` + `pyqtSignal(tuple)  # (current, total)`。
  但 `NO_PROGRESS_MODEL_TYPES = {HUGGING_FACE, FASTER_WHISPER, WHISPER_CPP}` →
  **这三类只能显示"转圈"不确定态**（`setRange(0,0)`），因为 `snapshot_download` 在子进程里拿不到回调。
  只有 OpenAI 单文件下载才有真正的 0–100% 进度条。
  → **教训：不要把下载委托给一个吞掉进度的黑盒库。我们自己实现下载器正是为此。**
- **存储**：`platformdirs.user_cache_dir("Buzz")/models`，可被 `BUZZ_MODEL_ROOT` 覆盖。
  ⚠ 它用的是 **cache dir**（macOS `~/Library/Caches/Buzz`）—— 正是我们 §6.1 明确避开的选择。
- **UI**：`QTreeWidget` 两个分组「Downloaded」/「Available for Download」，叶子是模型名。
  **不显示体积**（代码里 `WHISPER_MODEL_SIZES` 有近似字节数，但只用于本地文件完整性校验，没渲染到界面）。
  想知道该选哪个 → 点 ℹ️ 跳外部 FAQ 网页。
- **能不能跑**：只有平台可用性判断（Intel Mac 上隐藏 Faster-Whisper），**无资源判断**。
- 有个 `BUZZ_REDUCE_GPU_MEMORY` 环境变量，会自动给模型名加 `-q8_0`/`-q5_0` 后缀 ——
  **即"显存不够就自动降量化"，但藏在环境变量里，普通用户永远发现不了。这正该是个 UI 决策（我们的 §7.3）。**

#### MacWhisper [闭源，多数 `UNKNOWN`]

- 官网与文档**未公开**模型体积表、存储路径、下载源。
- 后端多路：**WhisperKit**（仅 Apple Silicon，"not supported on Intel-based machines"）、
  **ParakeetKit**、macOS 26+ 系统语音模型、以及云 API（OpenAI/Groq/Deepgram/ElevenLabs）。
- `mw` CLI 文档里的示例输出显示模型 ID 带后端前缀，且**有 Size 列**：
  `whisper-cpp:ggml-tiny.en`（Tiny (English Only), 80 MB）、`whisperkit:openai_whisper-small`（483 MB）、
  `parakeet-pro:nvidia_parakeet-v3_494MB`（494 MB）、`apple:en-GB`。
  → **`<backend>:<model>` 的命名空间是个好设计**，我们的 `id` 用 `<role>/<name>-<quant>`
  已经等价，但如果将来接入多后端（whisper.cpp / WhisperKit / faster-whisper），
  建议扩成 `<role>/<backend>/<name>-<quant>`。
- **CLI 不能下载模型**，必须先在 GUI 的「Manage Models」里装 —— 与我们章程要求 2.2 的方向一致。
- 存储路径、是否从 HF 下载：`UNKNOWN`（未公开）。

#### whisper.cpp 官方分发脚本 [已验证：直接读 `download-ggml-model.sh`]

```sh
src="https://huggingface.co/ggerganov/whisper.cpp"
pfx="resolve/main/ggml"
curl -L --fail --retry 5 --retry-delay 5 --retry-all-errors --retry-connrefused \
     ${HF_TOKEN:+--header "Authorization: Bearer $HF_TOKEN"} \
     --output ggml-"$model".bin $src/$pfx-"$model".bin
```

⚠ **重要负面结论**：该脚本**只认 `HF_TOKEN`，不认 `HF_ENDPOINT`**，`src` 是硬编码的。
→ **国内用户直接用官方脚本必然失败**，这正是我们必须自建下载器 + 镜像层的直接理由（§5）。
另：无 `-C -` / `--continue-at` → **不支持断点续传**；文件已存在则直接跳过且**不重新校验**。

脚本内置的模型名单（原文）：

```
tiny, tiny.en, tiny-q5_1, tiny.en-q5_1, tiny-q8_0,
base, base.en, base-q5_1, base.en-q5_1, base-q8_0,
small, small.en, small.en-tdrz, small-q5_1, small.en-q5_1, small-q8_0,
medium, medium.en, medium-q5_0, medium.en-q5_0, medium-q8_0,
large-v1, large-v2, large-v2-q5_0, large-v2-q8_0,
large-v3, large-v3-q5_0,
large-v3-turbo, large-v3-turbo-q5_0, large-v3-turbo-q8_0
```

`-tdrz`（tinydiarize 说话人切分）来自**另一个 repo**：`huggingface.co/akashmjn/tinydiarize-whisper.cpp`。
→ 我们的目录 schema 里 `source.repo` 必须是**每条目独立**的，不能全局假设一个 repo。（§6.4 已满足。）

#### 小结：我们相对这三者的具体改进点

| 能力              | Vibe         | Buzz                | MacWhisper | **OpenMemo（本方案）**          |
| ----------------- | ------------ | ------------------- | ---------- | ------------------------------- |
| 断点续传          | ❌           | 部分（依赖 hf_hub） | `UNKNOWN`  | ✅ Range 分片 + sidecar（§6.3） |
| 内容校验          | ❌           | 仅 OpenAI 系        | `UNKNOWN`  | ✅ 全量 sha256 强制（§6.6）     |
| 真实进度条        | ✅           | ❌（HF 系转圈）     | `UNKNOWN`  | ✅ SSE 字节级（§8.5）           |
| UI 显示体积       | ❌           | ❌                  | ✅         | ✅                              |
| 显存/内存适配判断 | ❌           | ❌                  | `UNKNOWN`  | ✅ 三档 + 预计耗时（§7）        |
| 量化选择器        | ❌           | 藏在环境变量        | `UNKNOWN`  | ✅ 一等公民（§9.2）             |
| 国内镜像          | ❌           | ❌                  | `UNKNOWN`  | ✅ 多源 + 自动测速（§5）        |
| 多源 fallback     | ✅（无校验） | ❌                  | `UNKNOWN`  | ✅（digest 钉死）               |

---

## 2. Hugging Face Hub API 实测

> 全部命令可复现。测试时间 2026-08-02，出口 IP 美国。

### 2.1 列出 repo 文件 + 体积 + digest [已验证]

```bash
curl -s "https://huggingface.co/api/models/ggerganov/whisper.cpp/tree/main"
```

单条返回：

```json
{
  "type": "file",
  "oid": "d144f735b005ae8cbfa04a49e22fe40faa24dbec",
  "size": 77691713,
  "lfs": {
    "oid": "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
    "size": 77691713,
    "pointerSize": 133
  },
  "xetHash": "518970a29bedb265f23ac48d486ddbc63bedffd90967b10140ae5ac61243acf3",
  "path": "ggml-tiny.bin"
}
```

**关键**：`lfs.oid` 就是文件内容的 **SHA-256**（下节验证它等于下载响应的 `x-linked-etag`）。
顶层 `oid` 是 git blob SHA-1，**不要拿它校验文件**。`xetHash` 是 HF 新 Xet 存储层的 CAS hash，另一套体系。

其他有用参数：

| 用法                                                            | 说明                                                                                                                              | 状态     |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `?recursive=true`                                               | 递归子目录                                                                                                                        | [文档]   |
| `?expand=true`                                                  | 追加 `lastCommit` + `securityFileStatus`（含 `avScan` / `pickleImportScan` / `protectAiScan` 结果）                               | [已验证] |
| `POST /api/models/{repo}/paths-info/{rev}` 体 `{"paths":[...]}` | **批量**取指定文件元数据，一次拿多个                                                                                              | [已验证] |
| `GET /api/models/{repo}`                                        | repo 级信息。GGUF repo 会带 `gguf` 字段：`{"total":8190735360,"architecture":"qwen3","context_length":40960,"chat_template":"…"}` | [已验证] |
| `GET /api/models?search=…&filter=gguf&limit=N`                  | 搜索                                                                                                                              | [已验证] |

**按量化过滤**：HF **没有**服务端的 quant filter。做法是拉 tree 后在客户端按文件名正则匹配
（`/-(Q[2-8]_[KM0-9_]*|IQ\d\w*|F16|BF16)\.gguf$/i`）。实测：

```bash
curl -s "https://huggingface.co/api/models/Qwen/Qwen3-8B-GGUF/tree/main" \
  | python3 -c "import json,sys;[print(f['path'],f['size']) for f in json.load(sys.stdin) if f['path'].endswith('.gguf')]"
# Qwen3-8B-Q4_K_M.gguf 5027783488
# Qwen3-8B-Q5_0.gguf   5720761152
# Qwen3-8B-Q5_K_M.gguf 5851112224
# Qwen3-8B-Q6_K.gguf   6725899040
# Qwen3-8B-Q8_0.gguf   8709518112
```

⚠ **分片 GGUF 陷阱** [已验证]：`Qwen/Qwen2.5-7B-Instruct-GGUF` 的文件是
`qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf` / `-00002-of-00002.gguf`。
**模型 ≠ 单文件**。我们的 manifest 必须是文件数组（§6.2），下载器要能把一组文件当一个原子任务。

### 2.2 下载 URL / Range / 限流 [已验证]

```bash
curl -sI -L "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin"
```

第一跳 `302`，重要响应头：

```
accept-ranges: bytes
x-linked-size: 77691713
x-linked-etag: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21"
x-repo-commit: 5359861c739e955e79d9a303bcbc70fb988958b1
x-hf-warning: unauthenticated; … Please set a HF_TOKEN to enable higher rate limits and faster downloads.
ratelimit: "resolvers";r=2999;t=51
ratelimit-policy: "fixed window";"resolvers";q=3000;w=300
location: https://us.aws.cdn.hf.co/xet-bridge-us/… (CloudFront 签名 URL，带 Expires)
```

`x-linked-etag` == tree API 的 `lfs.oid` == 文件 SHA-256。**三处一致，已交叉验证。**
→ 只需一次 HEAD 就能同时拿到「体积 + 校验和」，不必调 tree API。

**Range 支持**：

```bash
curl -s -L -D- -o /dev/null -H "Range: bytes=1000000-1000099" \
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin"
# HTTP/2 206
# content-range: bytes 1000000-1000099/77691713
# content-length: 100
```

✅ 首段与中段 Range 都返回 **206**，CDN 层也带 `accept-ranges: bytes`。**分片并发 + 断点续传可行。**

⚠ CDN 重定向是**带签名和 `Expires` 的临时 URL**。长时间下载中途重试时**必须重新走 `/resolve/` 拿新签名**，
不能缓存 CDN URL。Ollama 的 redirect-with-backoff 逻辑正是为此。

**限流（匿名，实测响应头）**：

| 策略                        | 配额 | 窗口  |
| --------------------------- | ---- | ----- |
| `api`（`/api/*`）           | 500  | 300 s |
| `resolvers`（`/resolve/*`） | 3000 | 300 s |

→ 目录若实时查 HF，一个用户刷几次页面就可能打满 `api` 配额（尤其共享出口 IP 的公司/校园网）。
**这是"不实时查 HF 做主目录"的硬理由**。

**Token**：公开 repo 匿名可下。Gated repo 实测：

```bash
curl -sI "https://huggingface.co/meta-llama/Llama-3.1-8B-Instruct/resolve/main/config.json"
# HTTP/2 401
# x-error-code: GatedRepo
# x-error-message: Access to model meta-llama/Llama-3.1-8B-Instruct is restricted. …
```

而 `GET /api/models/meta-llama/Llama-3.1-8B-Instruct` 匿名返回 200 且 `"gated":"manual"`。
→ **目录里必须标 `gated` 字段**，UI 要在下载前就提示「此模型需登录并同意许可」，而不是下到一半 401。
我们的默认清单**只收非 gated 模型**（Qwen / Gemma / bartowski 重打包版都不 gated）。

### 2.3 【设计利器】用 Range 读 GGUF 头，不下整个文件 [已验证]

GGUF 元数据在文件头部。实测用一个 8 MB Range 请求即可读出完整 KV：

```bash
curl -s -L -H "Range: bytes=0-8388607" -o head.gguf \
  "https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf"
# 解析结果（元数据实际消耗 5,932,859 字节）：
#   general.architecture = qwen3       qwen3.block_count = 36
#   qwen3.context_length = 40960       qwen3.embedding_length = 2560
#   qwen3.attention.head_count = 32    qwen3.attention.head_count_kv = 8
#   qwen3.attention.key_length = 128   qwen3.attention.value_length = 128
#   general.file_type = 15
```

→ **目录构建流水线可以自动算出每个模型的 KV cache 与显存需求，而不是人工填表。**
这是本方案相对 GPT4All（手填 `ramrequired`）和 ComfyUI-Manager（完全没有）的实质优势。

---

## 3. Whisper 模型清单

### 3.1 权威体积（`huggingface.co/api/models/ggerganov/whisper.cpp/tree/main` 实测字节数）[已验证]

| 文件                               |            字节 |       MiB |
| ---------------------------------- | --------------: | --------: |
| `ggml-tiny.bin`                    |      77,691,713 |      74.1 |
| `ggml-tiny-q5_1.bin`               |      32,152,673 |      30.7 |
| `ggml-tiny-q8_0.bin`               |      43,537,433 |      41.5 |
| `ggml-base.bin`                    |     147,951,465 |     141.1 |
| `ggml-base-q5_1.bin`               |      59,707,625 |      56.9 |
| `ggml-base-q8_0.bin`               |      81,768,585 |      78.0 |
| `ggml-small.bin`                   |     487,601,967 |     465.0 |
| `ggml-small-q5_1.bin`              |     190,085,487 |     181.3 |
| `ggml-small-q8_0.bin`              |     264,464,607 |     252.2 |
| `ggml-medium.bin`                  |   1,533,763,059 |    1462.7 |
| `ggml-medium-q5_0.bin`             |     539,212,467 |     514.2 |
| `ggml-medium-q8_0.bin`             |     823,369,779 |     785.2 |
| `ggml-large-v2.bin`                |   3,094,623,691 |    2951.3 |
| `ggml-large-v3.bin`                |   3,095,033,483 |    2951.7 |
| `ggml-large-v3-q5_0.bin`           |   1,081,140,203 |    1031.1 |
| **`ggml-large-v3-turbo.bin`**      |   1,624,555,275 |    1549.3 |
| **`ggml-large-v3-turbo-q5_0.bin`** | **574,041,195** | **547.4** |
| `ggml-large-v3-turbo-q8_0.bin`     |     874,188,075 |     833.7 |

（`.en` 单语版体积与多语版**接近但不相同**，此处省略；repo 内 `.bin` 共 33 个。
⚠ 易错点：`ggml-tiny.bin` = 77,691,713 而 `ggml-tiny.en.bin` = 77,704,715，**相差 13,002 字节**。
我派出的调研 agent 就把这两个数字弄混过。**只差万分之二的体积差是内容寻址存在的意义**——
按体积/文件名判重会误判，按 sha256 不会。另有
`ggml-*-encoder.mlmodelc.zip` 系列 = **CoreML encoder**，macOS 走 ANE 加速时额外需要，
例如 `ggml-large-v3-encoder.mlmodelc.zip` = 1,175,711,232 B。**这是多文件模型的第二个例证。**）

### 3.2 运行内存（whisper.cpp 官方 README "Memory usage" 表）[文档]

| Model  | Disk    | Mem     |
| ------ | ------- | ------- |
| tiny   | 75 MiB  | ~273 MB |
| base   | 142 MiB | ~388 MB |
| small  | 466 MiB | ~852 MB |
| medium | 1.5 GiB | ~2.1 GB |
| large  | 2.9 GiB | ~3.9 GB |

⚠ 该表**没有 large-v3-turbo**，且是 F16 版数据。我据此反推出的公式见 §7.2。

### 3.3 速度与准确率（WER）

**`UNKNOWN` —— 我没有找到一份同时覆盖 tiny→large-v3-turbo、口径一致、可引用的 WER/RTF 表。**

已知的定性事实 [文档，whisper.cpp / OpenAI README]：

- 模型名不含 `.en` 即多语言；`-q5_0` / `-q8_0` / `-q5_1` 为量化版。
- `large-v3-turbo` 是 large-v3 的蒸馏解码器版本（解码层 32→4），F16 体积 1.5 GiB vs large-v3 的 2.9 GiB。
- `small.en-tdrz` 支持 tinydiarize 说话人切分标记。

**我拒绝在这里填编造的 WER 数字。** 替代方案见 §7.4：产品内跑真实自测基准，用实测值代替宣传值。
若 Manager 需要一份对外文案用的粗略排序，可用：`tiny < base < small < medium ≈ large-v3-turbo < large-v3`
（准确率），`large-v3 < medium < large-v3-turbo < small < base < tiny`（速度）——**标注为定性排序，非测量值**。

### 3.4 distil-whisper 值不值得纳入？—— **不纳入（首版）**

理由（whisper.cpp `models/README.md` 原文，[文档]）：

> "Initial support for https://huggingface.co/distil-whisper is available.
> **Currently, the chunk-based transcription strategy is not implemented, so there can be sub-optimal
> quality when using the distilled models with `whisper.cpp`.**"

distil-whisper 的速度优势**依赖 chunked long-form 推理**，而 whisper.cpp 没实现 → 在我们的技术栈里
拿不到它的收益，还要承担质量下降。**而 `large-v3-turbo-q5_0` 只有 547 MB，已经覆盖了
"又小又准" 这个生态位**（比 distil-large-v3 更省事，且是官方 ggml 分发）。

复议条件：whisper.cpp 实现 chunk-based 策略，或我们改用 faster-whisper/CTranslate2 后端。
另注：distil-whisper **只有英文**版是成熟的，而我们是中文优先产品 → 优先级更低。

### 3.5 推荐清单（首版目录）

> **单位约定（全文档 + UI 强制）**：面向用户一律用十进制 **MB/GB = 1e6 / 1e9 字节**
> （与操作系统「文件大小」显示、与 HF 页面一致）。**MiB/GiB 只出现在引用上游原文的表格里**。
> §3.1 的 MiB 列是 1024² 换算，本表是 1e6 换算，故数字不同 —— 这正是必须统一口径的原因。

| 目录条目                          | 文件                           | 体积 (MB=1e6) | 定位              |
| --------------------------------- | ------------------------------ | ------------: | ----------------- |
| `whisper/base-q5_1`               | `ggml-base-q5_1.bin`           |         60 MB | 最低配 / 快速预览 |
| `whisper/small-q5_1`              | `ggml-small-q5_1.bin`          |        190 MB | CPU 机器的默认    |
| `whisper/medium-q5_0`             | `ggml-medium-q5_0.bin`         |        539 MB | 中端平衡          |
| **`whisper/large-v3-turbo-q5_0`** | `ggml-large-v3-turbo-q5_0.bin` |    **574 MB** | **全局默认推荐**  |
| `whisper/large-v3-turbo`          | `ggml-large-v3-turbo.bin`      |       1.62 GB | 有显存就上        |
| `whisper/large-v3`                | `ggml-large-v3.bin`            |       3.10 GB | 最高质量          |
| `whisper/large-v3-q5_0`           | `ggml-large-v3-q5_0.bin`       |       1.08 GB | 高质量 + 省显存   |

macOS 条目额外挂 `ggml-<name>-encoder.mlmodelc.zip` 作为可选文件（`optional: true`, `platform: ["darwin"]`）。

---

## 4. LLM 模型清单（转写稿 → 思维导图，中文硬需求）

### 4.1 实测体积（HF tree API 字节数换算）[已验证]

| 模型                                               |  Q4_K_M |  Q5_K_M |     Q8_0 | 中文               |
| -------------------------------------------------- | ------: | ------: | -------: | ------------------ |
| **Qwen3-4B**（`Qwen/Qwen3-4B-GGUF`）               | 2.50 GB | 2.89 GB |  4.28 GB | 原生强             |
| **Qwen3-4B-Instruct-2507**（`unsloth/…-GGUF`）     | ~2.5 GB |       — |        — | 原生强，非思考模式 |
| **Qwen3-8B**（`Qwen/Qwen3-8B-GGUF`）               | 5.03 GB | 5.85 GB |  8.71 GB | 原生强             |
| Qwen3-1.7B（`Qwen/Qwen3-1.7B-GGUF`）               |       — |       — |  1.83 GB | 可用，质量下降     |
| **Gemma-3-4B-it**（`ggml-org/gemma-3-4b-it-GGUF`） | 2.49 GB |       — |  4.13 GB | 尚可               |
| Gemma-3-12B-it（`ggml-org/…`）                     | 7.30 GB |       — | 12.51 GB | 好但太大           |
| Llama-3.1-8B-Instruct（`bartowski/…`）             | 4.92 GB | 5.73 GB |  8.54 GB | **中文偏弱**       |
| Llama-3.2-3B-Instruct（`bartowski/…`）             | 2.02 GB | 2.32 GB |        — | 中文弱             |

⚠ `Qwen/Qwen2.5-7B-Instruct-GGUF` 是**分片**的（`-00001-of-00002.gguf`），首版不收，减少复杂度。
`unsloth` 的 `UD-*` / `IQ*` 超低位量化（IQ1_S 仅 1.08 GB）质量风险大，不进默认目录，只在"高级"页可见。

### 4.2 KV cache 精确计算（从真实 GGUF 头读出）[已验证]

公式：`KV_bytes_per_token = block_count × head_count_kv × (key_length + value_length) × bytes_per_elem`

| 模型          | layers | n_kv_head | k/v_len | f16 KV/token | 每 1K ctx |       8K ctx |  16K ctx |
| ------------- | -----: | --------: | ------: | -----------: | --------: | -----------: | -------: |
| Qwen3-4B      |     36 |         8 | 128/128 |      144 KiB |   144 MiB | **1.12 GiB** | 2.25 GiB |
| Qwen3-8B      |     36 |         8 | 128/128 |      144 KiB |   144 MiB | **1.12 GiB** | 2.25 GiB |
| Gemma-3-4B-it |     34 |         4 | 256/256 |      136 KiB |   136 MiB |     1.06 GiB | 2.12 GiB |
| Llama-3.1-8B  |     32 |         8 | 128/128 |      128 KiB |   128 MiB |     1.00 GiB | 2.00 GiB |

**这是本报告最有价值的数字之一**：8K 上下文的 KV cache ≈ **1.1 GB**，
相当于给每个模型凭空加了 1 GB 显存需求。只按「文件大小 vs 显存」判断能否运行（LM Studio 早期做法）会系统性偏乐观。

缓解手段（写进 UI）：

- `cache_type = q8_0` 可把 KV 砍半 → 8K ctx 约 0.56 GiB。llama.cpp 原生支持。
- 转写稿分块喂入，把默认 ctx 定在 **8192**，不要一上来就 32K。

⚠ 存疑：Gemma-3 使用滑动窗口注意力（SWA），llama.cpp 对 SWA 层只保留窗口内的 KV
→ 实际占用**低于**上表。上表是**上界**，安全但偏保守。`UNKNOWN` 具体折扣比例。

### 4.3 推荐

- **默认**：`Qwen3-4B-Instruct-2507 Q4_K_M`（≈2.5 GB）。中文原生、体积适中、非思考模式输出更适合结构化任务。
- **低配**：`Qwen3-1.7B Q8_0`（1.83 GB）。
- **高配**：`Qwen3-8B Q4_K_M`（5.03 GB）。
- **备选（许可/口味）**：`Gemma-3-4B-it Q4_K_M`（2.49 GB）。
- Llama 系列**不进默认目录**（中文相对弱，且 `meta-llama` 官方 repo 是 gated）。

---

## 5. 国内下载：镜像方案（重点调查）

### 5.1 hf-mirror.com —— **本机无法验证** [已验证「不可验证」这一事实]

```bash
curl -sI -L "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin"
# HTTP/2 308
# location: https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin
# server: Caddy
curl -s -i "https://hf-mirror.com/api/models/ggerganov/whisper.cpp"
# HTTP/2 308  →  location: https://huggingface.co/api/models/ggerganov/whisper.cpp
curl -sI "https://hf-mirror.com/"     # HTTP/2 200（首页正常，Caddy）
```

结论：**从美国 IP，hf-mirror.com 对 `/api/*` 和 `/resolve/*` 一律 308 跳回 huggingface.co**，
即它做了**地理围栏**，只为中国大陆流量提供代理。

→ **`无法联网验证`：我无法从本机确认 hf-mirror 在国内的可用性、限速、Range 支持、稳定性。**
必须由一台大陆出口的机器复测。我把复测脚本写在 §5.4。

已知（[文档]/[未验证]）：它遵循 `HF_ENDPOINT=https://hf-mirror.com` 这一约定 ——
**ComfyUI-Manager 与 text-generation-webui 的源码里都读 `HF_ENDPOINT`**（这两点我已验证），
说明该约定在生态里是事实标准。

### 5.2 ModelScope（魔搭）—— **实测可用** [已验证]

**文件列表 API**：

```bash
curl -s "https://www.modelscope.cn/api/v1/models/cjc1887415157/whisper.cpp/repo/files?Revision=master&Root="
```

返回 `{"Code":200,"Data":{"Files":[{...}]}}`，每条含 `Path` / `Size` / `Sha256` / `Revision`。
**自带 Sha256，比 HF 还直接**（HF 要从 `lfs.oid` 取）。实测该 repo 的
`ggml-tiny.bin` size = 77691713、`ggml-large-v3.bin` size = 3095033483 —— **与 HF 完全一致**。

**下载 + Range**：

```bash
curl -sI -L "https://www.modelscope.cn/models/cjc1887415157/whisper.cpp/resolve/master/ggml-tiny.bin"
# HTTP/1.1 200 … X-Linked-Etag: be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21
curl -s -L -D- -o ms.bin -H "Range: bytes=1000000-1000099" "…/resolve/master/ggml-tiny.bin"
# HTTP/1.1 302 →  HTTP/2 206
# content-range: bytes 1000000-1000099/77691713
```

**字节一致性验证**：同一 100 字节中段，HF 与 ModelScope 下载结果 `cmp` **完全相同**，
且 ModelScope 返回的 `X-Linked-Etag` 与 HF 的 `x-linked-etag`（`be07e048…`）**逐字符相同**。

> 这是整个镜像方案的基石：**同一模型在不同源上是同一份字节，因此内容 digest 可以跨源复用。**

#### 【重要】Qwen 官方在 ModelScope 上有同名 repo，且文件**逐字节相同** [已验证]

```bash
# 同时拉 HF 与 ModelScope 的文件表并逐项比对 size 与 sha256
```

| 文件                            |       HF 字节 | ModelScope 字节 | size 相同 | sha256 相同 |
| ------------------------------- | ------------: | --------------: | :-------: | :---------: |
| `Qwen3-8B-Q4_K_M.gguf`          | 5,027,783,488 |   5,027,783,488 |    ✅     |     ✅      |
| `Qwen3-8B-Q5_0.gguf`            | 5,720,761,152 |   5,720,761,152 |    ✅     |     ✅      |
| `Qwen3-8B-Q5_K_M.gguf`          | 5,851,112,224 |   5,851,112,224 |    ✅     |     ✅      |
| `Qwen3-8B-Q6_K.gguf`            | 6,725,899,040 |   6,725,899,040 |    ✅     |     ✅      |
| `Qwen3-8B-Q8_0.gguf`            | 8,709,518,112 |   8,709,518,112 |    ✅     |     ✅      |
| `Qwen3-4B-*.gguf`（5 个量化档） |             — |               — |  ✅ 全部  |   ✅ 全部   |

**10/10 文件的 size 与 sha256 完全一致。** 且 ModelScope 上的路径就是
`Qwen/Qwen3-4B-GGUF` —— **与 HF 的 repo id 逐字符相同**，是 Qwen 官方发布（`CommitMessage`:
`"Upload to Qwen/Qwen3-8B-GGUF on ModelScope hub"`，committer `Cherrytest`），不是社区搬运。

→ **对中文产品这是决定性的好消息**：我们推荐的 LLM 主线（Qwen3-4B / 8B）在国内有
**官方、免翻墙、可断点续传、且字节一致**的下载源。§5.3 的 provider 抽象因此可以做到
「同一个 repo id 换个 base URL 就行」，不需要为每个镜像单独维护映射表。

⚠ 反例：whisper 的 ggml 在 ModelScope 上**没有官方 repo**，只有社区个人上传
（`cjc1887415157/whisper.cpp` 等）。这两类必须区别对待：目录里给每个文件的镜像项加
`"official": true|false` 标记，非官方镜像**只在 sha256 匹配时才使用**（本来也是强制的），
并在探针排序时降权。

**搜索 API**（`PUT`，注意不是 GET）：

```bash
curl -s -X PUT "https://www.modelscope.cn/api/v1/dolphin/models" -H 'Content-Type: application/json' \
  -d '{"PageSize":20,"PageNumber":1,"SortBy":"Default","Name":"whisper.cpp"}'
```

实测大陆已有多个 whisper.cpp ggml 镜像 repo：`cjc1887415157/whisper.cpp`（下载 2358）、
`bkfengg/whisper-cpp`（2371）、`OllmOne/whisper.cpp`、`fenghs/whisper.cpp` 等。
⚠ **这些是社区个人上传的**，不是官方镜像，随时可能失效或内容不符。
→ **所以必须钉 sha256**：源不可信，内容可信。

### 5.3 我们的方案：**源可替换 + digest 钉死**

```
目录条目（可信，来自我们签名的 catalog）
  └── sha256: be07e048…   size: 77691713          ← 唯一的信任锚
      └── 来源候选（不可信，纯传输）
          ├── hf          https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin
          ├── hf-mirror   https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin
          ├── modelscope  https://www.modelscope.cn/models/<mirror>/resolve/master/ggml-tiny.bin
          └── memo-cdn    https://cdn.memo.ac/blobs/sha256-be07e048…
```

任何一个源下载完，校验 sha256 通过即接受；失败即丢弃并换源重试。
**这样社区镜像的不可信问题被彻底消解**，同时天然获得跨源续传（换源不用重下已完成分片，因为
分片状态是按 blob digest 存的，见 §6.3）。

### 5.4 自动选源：并行探针测速，不用 GeoIP

**不用 GeoIP 的理由**：VPN 用户、海外华人、公司代理、IPv6 —— GeoIP 判错的代价是「用户卡在 0%」。

探针算法（首次启动 + 每次下载失败 3 次后触发）：

1. 对每个 provider 并发发一个 `Range: bytes=0-262143`（256 KB）请求，目标是一个已知的小文件。
2. 记录 `ttfb_ms` 与 `throughput_kbps`，5 秒硬超时。
3. 排序 key：`score = throughput_kbps / (1 + ttfb_ms/1000)`，失败者 score = 0。
4. 结果写入 `state.json`，UI「设置 → 下载源」展示测速结果并允许手动锁定。

复测脚本（**请在大陆出口机器上跑**，补齐 §5.1 的空白）：

```bash
#!/usr/bin/env bash
# probe-mirrors.sh — 在中国大陆网络环境运行，回填 hf-mirror 数据
F="ggml-tiny.bin"
declare -A U=(
 [hf]="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$F"
 [hf-mirror]="https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/$F"
 [modelscope]="https://www.modelscope.cn/models/cjc1887415157/whisper.cpp/resolve/master/$F"
)
for k in "${!U[@]}"; do
  printf "%-12s " "$k"
  curl -sL -o /dev/null --max-time 20 -H "Range: bytes=0-262143" \
    -w "code=%{http_code} ttfb=%{time_starttransfer}s speed=%{speed_download}B/s size=%{size_download}\n" \
    "${U[$k]}" || echo "FAILED"
done
# 另需确认：hf-mirror 是否对 /api/models/*/tree/main 也代理（本机得到 308，国内未知）
```

### 5.5 兜底：我们自己的 CDN

给**默认清单里的 7 个 whisper + 4 个 LLM 模型**在自有对象存储上镜像一份，路径按 blob digest：
`https://cdn.memo.ac/blobs/sha256-<hex>`。
成本可控（约 25 GB × 副本），且是唯一我们能保证 SLA 的源。作为最后一档 fallback。
许可证：whisper ggml = MIT/Apache（whisper 权重 MIT）、Qwen3 = Apache-2.0、Gemma = Gemma Terms（**需保留条款、
再分发有限制 → 转交 `oss-scout` 确认 Gemma 是否可自建镜像分发**；不确定就只镜像 Qwen 与 whisper）。

---

## 6. 存储布局设计

### 6.1 各 OS 标准路径

| 平台    | 路径                                                                             | 理由                                                                              |
| ------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| macOS   | `~/Library/Application Support/OpenMemo/models`                                  | **不用 `~/Library/Caches`** —— 系统会在磁盘紧张时清理，几 GB 模型被静默删掉是灾难 |
| Windows | `%LOCALAPPDATA%\OpenMemo\models`（`C:\Users\<u>\AppData\Local\OpenMemo\models`） | **不用 Roaming** —— 域环境下漫游配置文件会尝试同步，几 GB 会拖垮登录              |
| Linux   | `${XDG_DATA_HOME:-~/.local/share}/openmemo/models`                               | XDG 规范；不用 `XDG_CACHE_HOME` 同理                                              |

覆盖顺序：`OPENMEMO_MODELS` 环境变量 > 设置里的自定义路径 > 上表默认。
UI 必须提供「更改模型目录」并**支持迁移**（同卷 rename，跨卷复制 + 校验 + 删除，带进度）。

### 6.2 目录结构

```
<models_root>/
├── blobs/
│   ├── sha256-be07e048e1e599ad…            # 最终 blob，文件名 = 内容 sha256（用 '-' 不用 ':'）
│   ├── sha256-394221709cd5ad1f….partial    # 下载中的稀疏数据文件
│   └── sha256-394221709cd5ad1f….partial.json   # 断点状态 sidecar
├── manifests/
│   ├── asr/whisper-large-v3-turbo-q5_0.json
│   └── llm/qwen3-4b-instruct-2507-q4_k_m.json
├── by-name/                                # 硬链接视图，仅为可读性/调试/外部工具
│   ├── asr/ggml-large-v3-turbo-q5_0.bin  ->  ../../blobs/sha256-3942…
│   └── llm/Qwen3-4B-Instruct-2507-Q4_K_M.gguf
├── catalog/
│   ├── catalog.json       catalog.json.sig       catalog.etag
│   └── bundled.json                              # 随包只读副本（实际编译进二进制，此处仅示意）
└── state.json                                    # 激活模型、下载源选择、迁移锁
```

**为什么内容寻址而不是直接按文件名存**

| 收益               | 说明                                                                               |
| ------------------ | ---------------------------------------------------------------------------------- |
| 跨源去重           | 已验证 HF 与 ModelScope 同文件字节一致 → 换镜像不重下                              |
| 跨模型去重         | 例：`large-v3` 与 `large-v3` 的某些 repack 完全相同；CoreML encoder 被多个条目共享 |
| 断点状态天然可复用 | 分片进度按 digest 存，与「用户当时选了哪个源」解耦                                 |
| 校验即免费         | 文件名本身就是期望的 hash                                                          |
| 多版本共存         | 目录换了 revision，旧 blob 仍在，可秒回滚                                          |

**为什么还要 `by-name/` 硬链接**：Ollama 那种纯 blob 目录对用户和排障极不友好
（"我的 5 GB 在哪"、"能不能手动拷进去"）。硬链接零额外磁盘占用；
Windows NTFS `CreateHardLinkW` **不需要管理员权限**（symlink 才需要开发者模式）——
所以用 hardlink 而非 symlink。跨卷不可硬链接时降级为不创建（记 warning，非致命）。

### 6.3 断点 sidecar 格式（`.partial.json`）

```json
{
  "schema": 1,
  "digest": "sha256:394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
  "total": 574041195,
  "created_at": "2026-08-02T12:00:00Z",
  "provider": "modelscope",
  "validators": { "etag": "\"be07e048…\"", "last_modified": null },
  "parts": [
    { "index": 0, "start": 0, "end": 143510298, "completed": 143510298 },
    { "index": 1, "start": 143510299, "end": 287020597, "completed": 60000000 },
    { "index": 2, "start": 287020598, "end": 430530896, "completed": 0 },
    { "index": 3, "start": 430530897, "end": 574041194, "completed": 0 }
  ]
}
```

规则：

- 分片数 = `clamp(ceil(total / 128MB), 1, 8)`。
  **注意：不抄 Ollama 的 16 并发。** Ollama 面向服务器；我们是桌面应用，16 条并发在家用路由器/移动热点上
  会互相踩踏且触发 CDN 限速。8 是上限，默认 4，可在设置里调。
- 换 provider 时**保留 parts 进度**，但把 `validators` 清空并重新 HEAD 校对 `total`；`total` 不符则整体作废重来。
- `.partial` 用稀疏文件（Linux/macOS 天然；Windows 用 `FSCTL_SET_SPARSE`），
  避免一开始就占满 3 GB 让用户误以为已下完。

### 6.4 manifest 格式

```json
{
  "schema": 1,
  "id": "asr/whisper-large-v3-turbo-q5_0",
  "role": "asr",
  "display_name": "Whisper large-v3-turbo (Q5_0)",
  "display_name_zh": "Whisper 大模型 v3 Turbo（Q5_0 量化）",
  "family": "whisper",
  "arch": "whisper",
  "format": "ggml",
  "quant": "q5_0",
  "languages": ["multilingual"],
  "files": [
    {
      "role": "weights",
      "name": "ggml-large-v3-turbo-q5_0.bin",
      "digest": "sha256:394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
      "size": 574041195,
      "optional": false
    },
    {
      "role": "coreml-encoder",
      "name": "ggml-large-v3-turbo-encoder.mlmodelc.zip",
      "digest": "sha256:…",
      "size": 0,
      "optional": true,
      "platforms": ["darwin-arm64"],
      "unpack": "zip"
    }
  ],
  "total_size": 574041195,
  "requirements": {
    "min_ram_mb": 1394, // = 574 (权重, MB=1e6) + 820 (large 级 overhead)，见 §7.2
    "est_vram_mb": 1394,
    "min_disk_mb": 632, // = 574 × 1.10，下载峰值
    "cpu_features": []
  },
  "source": {
    "provider": "huggingface",
    "repo": "ggerganov/whisper.cpp",
    "revision": "5359861c739e955e79d9a303bcbc70fb988958b1"
  },
  "license": { "id": "MIT", "gated": false, "url": "https://huggingface.co/ggerganov/whisper.cpp" },
  "installed_at": "2026-08-02T12:04:11Z",
  "verified_at": "2026-08-02T12:04:40Z",
  "catalog_version": "2026.08.01"
}
```

LLM 条目额外带（由 §2.3 的 GGUF 头解析自动生成）：

```json
"gguf": { "arch":"qwen3", "block_count":36, "head_count":32, "head_count_kv":8,
          "key_length":128, "value_length":128, "context_length":40960,
          "kv_bytes_per_token": 147456 }
```

### 6.5 引用计数与垃圾回收

- blob 无独立引用计数文件（易与真实状态漂移）。改为**扫描式 GC**：
  遍历 `manifests/**` 收集所有 digest → `blobs/` 里不在集合中的即孤儿。
- GC 触发：手动（UI「清理」）、删除模型后、启动时若上次异常退出。
- `.partial*` 超过 7 天未更新且无活跃任务 → 列为可清理。
- **GC 期间加全局锁**，禁止并发下载写入，避免删掉刚落盘还没写 manifest 的 blob。
  （先写 blob 再写 manifest，中间崩溃 → 孤儿 blob，被 GC 回收，安全。反过来会产生悬空 manifest，禁止。）

### 6.6 校验策略（补齐 Ollama 的短板）

| 时机                      | 动作                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 每片下载完                | 无（分片级不校验，成本高）                                                                                        |
| 全部分片完成、rename 之前 | **流式 sha256 全量校验**，与 manifest 的 `digest` 比对                                                            |
| 校验失败                  | 删除 `.partial`，标记该 provider 一次失败，换源自动重试一次，再失败则报错给 UI                                    |
| 已安装模型                | 提供 `POST /api/models/verify`，UI 上是「校验完整性」按钮；启动时**不**自动全量校验（几 GB 太慢），只比对文件大小 |
| 加载模型前                | 只比对 size + mtime（快速健全性检查）                                                                             |

---

## 7. 硬件适配决策逻辑

### 7.1 【契约提案】硬件描述 JSON —— 给 `gpu-runtime` (R-02) 对齐

> 这是我**假设**的接口，请 Manager 协调与 R-02 对齐。我只依赖下表标 ★ 的字段。

```jsonc
{
  "schema": 1,
  "detected_at": "2026-08-02T12:00:00Z",
  "os": { "platform": "windows", "arch": "x86_64", "version": "10.0.22631" },
  "cpu": {
    "brand": "AMD Ryzen 7 7840HS",
    "physical_cores": 8,
    "logical_cores": 16,
    "features": ["avx2", "fma", "f16c", "avx512f"],
  }, // ★
  "ram": { "total_mb": 32768, "available_mb": 21000 }, // ★
  "unified_memory": false, // ★ Apple Silicon = true
  "gpus": [
    {
      "index": 0,
      "vendor": "nvidia",
      "name": "NVIDIA GeForce RTX 4060 Laptop GPU",
      "vram_total_mb": 8188, // ★
      "vram_free_mb": 7100, // ★
      "driver": "560.94",
      "capabilities": { "cuda_cc": "8.9" },
      "backends": ["cuda", "vulkan"],
    },
  ],
  "backends": [
    { "id": "cuda", "available": true, "installed": true, "version": "12.4", "device_index": 0 },
    { "id": "vulkan", "available": true, "installed": false },
    { "id": "metal", "available": false },
    { "id": "cpu", "available": true, "installed": true, "isa": "avx2" },
  ],
  "selected_backend": "cuda", // ★
  "selected_gpu_index": 0, // ★
  "disks": [{ "mount": "C:\\", "path_for": "models_root", "free_mb": 240000, "total_mb": 900000 }], // ★
}
```

**我对 R-02 的具体请求**（若字段名不同，请告知，我改）：

1. `unified_memory` 必须有。Apple Silicon 上「显存」概念不同，缺了这个字段整套判断会错。
2. `vram_total_mb` 与 `vram_free_mb` **都要**。只有 total 会在多应用抢显存时误判为"推荐"。
   拿不到 free 就填 `null`，我按 `total × 0.85` 估。
3. `cpu.features` 至少要有 `avx2`（llama.cpp / whisper.cpp 的预编译 CPU 后端普遍需要）。
4. `disks[].path_for: "models_root"` —— 我需要**模型目录所在卷**的剩余空间，不是系统盘。
5. 该 JSON 应可通过 `GET /api/runtime/hardware` 取得，并在硬件/后端变化时通过 SSE 广播
   `hardware.changed` 事件，我收到后重算全部模型的适配标签。

### 7.2 内存需求公式

> 公式中所有 `_mb` 一律为 **`bytes / 1e6`**（十进制 MB）。上游 whisper.cpp 表里的 MiB 已换算过。

**Whisper（whisper.cpp）**

由官方 Memory usage 表反推（`Mem - Disk`）：tiny 194 MB、base 239 MB、small 363 MB、
medium 490 MB、large 787 MB。故：

```
whisper_mem_mb = weights_file_mb + overhead(arch)

overhead:  tiny 200 | base 250 | small 380 | medium 520 | large/large-v3-turbo 820   (MB)
```

**为什么是「加常数」而不是「乘系数」**：whisper 的计算缓冲区尺寸取决于模型维度，**与量化无关**。
用乘法系数会让 `large-v3-q5_0`（1031 MiB）被算成 ~1.2 GB，实际它的激活缓冲仍是 large 规模（~800 MB），
真实需求约 1.9 GB。**乘法会系统性低估量化模型**，这是个真实的坑。

回代验证（F16）：tiny 79+200=279（官方 273 ✓）、base 149+250=399（388 ✓）、small 489+380=869（852 ✓）、
medium 1610+520=2130（2100 ✓）、large 3113+820=3933（3900 ✓）。**全部略微保守，符合预期。**
`large-v3-turbo` 官方表没有，我按 large 的 820 MB 算 —— **[未验证]**，turbo 解码层少，实际应更低（更保守，可接受）。

**LLM（llama.cpp）**

```
llm_mem_mb = weights_file_mb × 1.05
           + kv_bytes_per_token × ctx × kv_quant_factor / 1048576
           + 300                                   // 计算图 / 激活 / 分配器余量

kv_quant_factor:  f16 = 1.0 | q8_0 = 0.5 | q4_0 = 0.25
```

`kv_bytes_per_token` 由目录构建时从 GGUF 头算出（§2.3、§4.2 已验证可行）。

示例：Qwen3-4B Q4_K_M @ 8192 ctx, f16 KV
= 2385×1.05 + 147456×8192/1048576 + 300 = 2504 + 1152 + 300 = **3956 MB**。
→ 一张 4 GB 显存的卡**跑不满**，必须提示切 `q8_0` KV（降到 3380 MB）或降 ctx。
**如果只看"2.5 GB 文件 < 4 GB 显存 → 推荐"，用户会直接 OOM。**

### 7.3 三档判定规则表

先定义可用预算：

```
if unified_memory:                                  # Apple Silicon
    VRAM_budget = ram.total_mb × 0.65               # 保守；macOS 默认 wired limit 约 70~75%
else if selected_backend != "cpu" and gpus[selected_gpu_index]:
    VRAM_budget = (vram_free_mb ?? vram_total_mb × 0.85) × 0.92    # 0.92 留驱动/显示输出
else:
    VRAM_budget = 0

RAM_budget  = ram.total_mb × 0.75                   # 留给 OS + 应用 + 浏览器
DISK_needed = total_size_mb × 1.10                  # 下载中 partial + 最终文件的峰值
Need        = §7.2 算出的 mem_mb
```

判定（**自上而下，短路**）：

| #   | 条件                                                                                       | 结果              | UI 文案（中/英）                                                  |
| --- | ------------------------------------------------------------------------------------------ | ----------------- | ----------------------------------------------------------------- |
| 1   | `disks[models_root].free_mb < DISK_needed`                                                 | `blocked_disk`    | 磁盘空间不足（还需 X GB） / Not enough disk space                 |
| 2   | `requirements.cpu_features` ⊄ `cpu.features`                                               | `unsupported`     | CPU 不支持（需要 AVX2） / CPU lacks AVX2                          |
| 3   | `Need > RAM_budget`                                                                        | `unsupported`     | 内存不足，跑不动 / Too large for this machine                     |
| 4   | `VRAM_budget > 0` 且 `Need ≤ VRAM_budget`                                                  | **`recommended`** | ✅ 推荐 · 可全部载入显存 / Full GPU offload                       |
| 5   | `VRAM_budget == 0` 且 `Need ≤ RAM_budget × 0.5` 且 `role == asr` 且 `whisper_size ≤ small` | **`recommended`** | ✅ 推荐（CPU） / Recommended (CPU)                                |
| 6   | `VRAM_budget == 0` 且 `Need ≤ RAM_budget × 0.5` 且 `role == llm` 且 `params_b ≤ 4`         | **`recommended`** | ✅ 推荐（CPU，较慢） / Recommended (CPU)                          |
| 7   | `VRAM_budget > 0` 且 `Need ≤ VRAM_budget + RAM_budget`                                     | `slow_partial`    | ⚠️ 可以跑，会慢 · 部分层在显存（约 N/L 层） / Partial GPU offload |
| 8   | 其余（`Need ≤ RAM_budget`）                                                                | `slow_cpu`        | ⚠️ 可以跑，很慢 · 纯 CPU / Runs on CPU, slow                      |

**规则 7 的可卸载层数估算**（仅 LLM，给用户看的具体数字）：

```
weights_only_mb   = weights_file_mb × 1.05
kv_mb             = KV 部分
usable_for_weights = max(0, VRAM_budget - kv_mb - 300)
n_gpu_layers ≈ floor(block_count × usable_for_weights / weights_only_mb)   # 钳制到 [0, block_count]
```

（近似：假设各层权重等大。实际 embedding/output 层更大 → 这是**乐观**估计，UI 文案用「约」。[未验证]）

**"边界带"处理**：当 `Need` 落在 `VRAM_budget` 的 ±8% 内时，不给 `recommended`，
降级为 `slow_partial` 并提示「显存刚好卡在临界，建议选低一档量化」。
硬阈值在边界上翻脸是这类 UI 最常见的差评来源。

### 7.4 速度分档：跑真实基准，不编数字

**问题**：`recommended` 只保证「装得下」，不保证「跑得快」。
在 8 核 CPU 上用 `large-v3` 转 1 小时音频可能要 40 分钟 —— 装得下，但产品上不可接受。

**方案**：后端安装/切换完成后，自动跑一次微基准：

1. 随包一段 **10 秒** 16 kHz 单声道 WAV（`vendor/whisper.cpp/samples/jfk.wav` 即可，约 11 s）。
2. 用当前后端 + `base-q5_1`（57 MB，下载快）跑一次，测得 `rtf_base = wall_seconds / audio_seconds`。
3. 外推到其他模型：`rtf_model ≈ rtf_base × (flops_ratio)`，
   `flops_ratio` 用参数量比近似 —— 相对 base：small ≈ 3.2×，medium ≈ 9.9×，
   large-v3 ≈ 20×，large-v3-turbo ≈ 8×（**编码器同 large，解码层 32→4**）。
   ⚠ 这些 ratio 我按参数量/层数推算，**[未验证]**，需要实测校准。
4. 首次真实转写完成后，用**实测 RTF 回写覆盖**外推值。越用越准。
5. UI 展示：「预计 1 小时音频约需 X 分钟」——**这才是用户真正关心的指标**，
   比 "medium / ★★★☆" 有用得多。

若 `rtf_model > 0.5`（转 1 小时要超过 30 分钟），即使内存够，也把标签从 `recommended`
降为 `slow_*` 并显示预计耗时。

---

## 8. HTTP API 设计

Base：`http://127.0.0.1:{port}/api`。
鉴权：启动时生成随机 token，写入 `state.json`，前端从主进程取；所有请求带 `Authorization: Bearer <token>`。
CORS：仅允许我们自己的 origin（`app://` 或 `http://127.0.0.1:{ui_port}`）。
**理由**：本地 daemon 的 11434 式裸端口是真实攻击面（任意网页可 fetch localhost）。Ollama 靠 `OLLAMA_ORIGINS`
控制，我们从一开始就默认关严。

### 8.1 `GET /api/models/catalog`

Query：`role=asr|llm|all`（默认 all）、`refresh=true|false`（默认 false，用缓存）、`lang=zh|en`。

```jsonc
{
  "catalog_version": "2026.08.01",
  "source": "remote", // remote | cache | bundled
  "fetched_at": "2026-08-02T09:00:00Z",
  "stale": false, // true 时 UI 显示「离线目录」横幅
  "hardware_snapshot_id": "hw-9f3a…", // 用于判断 fitness 是否还新鲜
  "models": [
    {
      "id": "asr/whisper-large-v3-turbo",
      "role": "asr",
      "family": "whisper",
      "display_name": "Whisper large-v3-turbo",
      "display_name_zh": "Whisper 大模型 v3 Turbo",
      "description_zh": "目前速度与准确率平衡最好的多语种模型，中文表现优秀。",
      "languages": ["multilingual"],
      "tags": ["recommended-default", "multilingual"],
      "license": { "id": "MIT", "gated": false },
      "variants": [
        // ← 量化档
        {
          "quant": "q5_0",
          "label": "Q5_0（推荐）",
          "total_size": 574041195,
          "files": [
            {
              "role": "weights",
              "name": "ggml-large-v3-turbo-q5_0.bin",
              "digest": "sha256:394221709cd5ad1f…", // ← 唯一信任锚，见 §5.3
              "size": 574041195,
              // 镜像必须逐文件显式列出：ModelScope 上 whisper 的 repo 路径与 HF 不同，
              // 不能靠"换 base URL"推导。Qwen 系则路径相同（§5.2），但仍显式写，不搞特例。
              "mirrors": [
                {
                  "provider": "hf",
                  "official": true,
                  "url": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin",
                },
                {
                  "provider": "hf-mirror",
                  "official": false,
                  "url": "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin",
                },
                {
                  "provider": "modelscope",
                  "official": false, // 社区搬运，靠 digest 兜底
                  "url": "https://www.modelscope.cn/models/cjc1887415157/whisper.cpp/resolve/master/ggml-large-v3-turbo-q5_0.bin",
                },
                {
                  "provider": "memo-cdn",
                  "official": true,
                  "url": "https://cdn.memo.ac/blobs/sha256-394221709cd5ad1f…",
                },
              ],
            },
          ],
          "requirements": {
            "min_ram_mb": 1394,
            "est_vram_mb": 1394,
            "min_disk_mb": 632,
            "cpu_features": [],
          },
          "installed": false,
          "fitness": {
            // ← 服务端算好，前端不重算
            "tier": "recommended", // recommended | slow_partial | slow_cpu
            // | unsupported | blocked_disk
            "reason_code": "full_gpu_offload",
            "reason_zh": "可全部载入显存（需 1.4 GB / 可用 6.9 GB）",
            "reason_en": "Full GPU offload (needs 1.4 GB of 6.9 GB available)",
            "est_minutes_per_audio_hour": 4.2, // null = 尚未基准测试
            "est_gpu_layers": null,
          },
        },
        { "quant": "q8_0", "label": "Q8_0", "total_size": 874188075, "…": "…" },
        { "quant": "f16", "label": "F16（完整精度）", "total_size": 1624555275, "…": "…" },
      ],
    },
  ],
}
```

设计要点：

- **`fitness` 由服务端计算**。前端不该复刻 §7.3 的规则表（两处实现必然漂移）。
- `size` 一律是**整数字节**（ComfyUI-Manager 用 `"4.71MB"` 字符串是反面教材）。
- `digest` **必填**。
- 「模型」与「量化档」是两层：列表按模型折叠，展开选 quant。这是 LM Studio 的做法，也是唯一合理的信息架构。

### 8.2 `GET /api/models/installed`

```jsonc
{
  "models": [
    {
      "id": "asr/whisper-large-v3-turbo-q5_0",
      "role": "asr",
      "display_name": "Whisper large-v3-turbo (Q5_0)",
      "quant": "q5_0",
      "total_size": 574041195,
      "installed_at": "2026-08-02T12:04:11Z",
      "verified_at": "2026-08-02T12:04:40Z",
      "integrity": "ok", // ok | unverified | corrupt | missing_files
      "active": true,
      "catalog_version": "2026.08.01",
      "update_available": null, // 或 { "to_catalog_version": "…", "reason": "…" }
      "files": [
        {
          "name": "ggml-large-v3-turbo-q5_0.bin",
          "digest": "sha256:394221…",
          "size": 574041195,
          "path": "<models_root>/by-name/asr/ggml-large-v3-turbo-q5_0.bin",
        },
      ],
    },
  ],
  "active": { "asr": "asr/whisper-large-v3-turbo-q5_0", "llm": null },
}
```

### 8.3 `POST /api/models/pull`

```jsonc
// 请求
{
  "id": "asr/whisper-large-v3-turbo",
  "quant": "q5_0",
  "provider": "auto", // auto | hf | hf-mirror | modelscope | memo-cdn
  "include_optional": ["coreml-encoder"],
  "activate_on_success": true,
}
```

```jsonc
// 202 Accepted
{
  "job_id": "job_01J8…",
  "state": "queued",
  "model_id": "asr/whisper-large-v3-turbo-q5_0",
  "total_bytes": 574041195,
  "events_url": "/api/models/events?job=job_01J8…",
}
```

**幂等**：同一 `(model_id)` 已有活跃 job → 返回 **200** 和既有 `job_id`，不新建。
（Ollama 文档明确说 "multiple calls will share the same download progress"，同样的语义。）

兼容模式：`POST /api/models/pull?stream=ndjson` 直接返回 NDJSON 流（Ollama 风格），供 CLI/脚本用。
网页 UI 不走这条。

### 8.4 job 状态与控制

```
GET  /api/models/jobs                 -> { "jobs": [ Job, … ] }
GET  /api/models/jobs/:job_id         -> Job
POST /api/models/jobs/:job_id/cancel  -> 204   # 保留 .partial，可续
POST /api/models/jobs/:job_id/retry   -> 202   # 失败后重试，复用 .partial
POST /api/models/jobs/:job_id/pause   -> 204
POST /api/models/jobs/:job_id/resume  -> 202
```

`Job` 对象：

```jsonc
{
  "job_id": "job_01J8…",
  "model_id": "asr/whisper-large-v3-turbo-q5_0",
  "display_name": "Whisper large-v3-turbo (Q5_0)",
  "state": "downloading", // queued | resolving | downloading | verifying
  // | installing | done | failed | cancelled | paused
  "provider": "modelscope",
  "total_bytes": 574041195,
  "completed_bytes": 231000000, // 服务端保证存在，即使为 0（不学 Ollama 的可选字段）
  "speed_bps": 8400000,
  "eta_seconds": 41,
  "parts": [{ "index": 0, "completed": 143510298, "total": 143510299 }, "…"],
  "current_file": "ggml-large-v3-turbo-q5_0.bin",
  "file_index": 0,
  "file_count": 1,
  "attempt": 1,
  "max_attempts": 3,
  "error": null, // { "code":"CHECKSUM_MISMATCH","message_zh":"…","retryable":true }
  "started_at": "…",
  "updated_at": "…",
}
```

**错误码**（前端据此决定文案与按钮）：

| code                                   | 可重试     | UI 动作                                                   |
| -------------------------------------- | ---------- | --------------------------------------------------------- |
| `NETWORK_TIMEOUT` / `CONNECTION_RESET` | ✅         | 自动重试，第 3 次后提示「换个下载源」                     |
| `CHECKSUM_MISMATCH`                    | ✅         | 自动换源重试 1 次；再失败 → 「该源文件损坏，已切换到 X」  |
| `DISK_FULL`                            | ❌         | 「磁盘空间不足」+ 跳转清理页                              |
| `GATED_REPO`                           | ❌         | 「该模型需要登录 Hugging Face 并同意许可」+ 填 token 入口 |
| `RATE_LIMITED`                         | ✅（延迟） | 「下载源限流，X 秒后重试」                                |
| `PROVIDER_UNREACHABLE`                 | ✅         | 自动换下一个 provider                                     |
| `INTEGRITY_ALL_SOURCES_FAILED`         | ❌         | 「所有下载源都失败」+ 一键提交诊断                        |

**并发策略**：全局同时下载数默认 **2**，可设 1–4。
超出的入队（ComfyUI-Manager 式 FIFO）。**理由**：并发多个大模型只会瓜分同一条带宽，
还让每个都变慢、ETA 全不准。用户心智上「一个一个下完」更好。
单个模型内部才用 4 分片并发（§6.3）。

### 8.5 进度推送：**SSE**（决策 + 理由）

```
GET /api/models/events            # 全局流，复用所有 job + 目录 + 硬件事件
GET /api/models/events?job=<id>   # 可选过滤
```

> 📝 **端点名已在落地时改掉（2026-08-06 订正，原名保留在上）**：真实端点是**全局唯一的
> `/api/events`**（`apps/daemon/src/http/server.ts:338`），不是 `/api/models/events` ——
> 后者全仓 grep **零命中**。ADR-004 把 SSE 收敛成**一条全局流**（见 `docs/design/D-01-architecture.md:326`），
> 比本文设想的"每个域一条"更进一步。同理，下文提到的实时 ASR 通道 `/ws/transcribe`
> 实际叫 **`/ws/recorder`**（`apps/daemon/src/ws/recorder.ts`）。**照本文原名接 UI 会 404。**

```
id: 1042
event: job.progress
data: {"job_id":"job_01J8…","completed_bytes":231000000,"total_bytes":574041195,
       "speed_bps":8400000,"eta_seconds":41,"state":"downloading"}

id: 1043
event: job.state
data: {"job_id":"job_01J8…","state":"verifying"}

id: 1044
event: model.installed
data: {"model_id":"asr/whisper-large-v3-turbo-q5_0","active":true}

id: 1045
event: storage.changed
data: {"used_bytes":1832000000,"free_bytes":251658240000}

: keepalive
```

**为什么 SSE 而不是 WebSocket**

| 维度                  | SSE                                                                                 | WebSocket                                             | 结论                                                           |
| --------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------- |
| 通信方向              | 单向 server→client                                                                  | 双向                                                  | 我们的控制指令走 REST POST 已经够了；WS 的双向性**没有被用到** |
| 与 REST 共用鉴权/CORS | ✅ 就是普通 HTTP GET，同一套 middleware                                             | ❌ Upgrade 握手，鉴权/Origin 校验是**另一条代码路径** | 本地 daemon 的攻击面，少一条路径少一处漏                       |
| 断线重连              | ✅ `EventSource` 原生自动重连 + `Last-Event-ID` 请求头 → **服务端可重放漏掉的事件** | ❌ 全部手写                                           | 用户刷新页面/合盖唤醒后进度不丢，是刚需                        |
| 代理/杀软兼容         | 好（就是普通 HTTP 响应）                                                            | 企业代理与部分杀软会拦 Upgrade                        | Windows 企业环境真实存在                                       |
| 实现复杂度            | 后端一个 `text/event-stream` handler                                                | 需要连接管理、心跳、帧处理                            | —                                                              |
| 二进制                | ❌                                                                                  | ✅                                                    | 我们只传 JSON                                                  |
| 连接数上限            | HTTP/1.1 每 origin **6 条**                                                         | 无此限制                                              | ⚠ 见下方缓解                                                   |

**关键缓解措施**：**只开一条** `/api/models/events` 全局流，**绝不为每个下载任务开一条**。
否则 3 个下载 + 转写进度 + 运行时安装就能吃满 6 条，页面后续 fetch 会直接挂住 —— 这是 SSE 最经典的翻车方式。
若 daemon 启用 HTTP/2（推荐，多路复用），该限制消失。

**明确的例外**：**实时录音转写（F3）应该用 WebSocket**（`/ws/transcribe`），因为那是真双向 + 二进制音频帧。
不要为了「架构统一」把模型下载也塞进 WS，也不要为了统一把实时 ASR 塞进 SSE。**按场景选传输。**

**降级路径**：若 `EventSource` 不可用或流断开超过 15 s，前端自动降级为轮询
`GET /api/models/jobs`（2 s 间隔）。这也是 ComfyUI-Manager 的「打开面板先 REST 拉一次快照」思路 ——
我们把它固化为：**页面挂载必先 `GET /api/models/jobs` 拿全量快照，再订阅 SSE 增量**。
否则错过在页面加载前发生的事件。

### 8.6 其余 endpoint

```
DELETE /api/models/:id?keep_blobs=false
  -> 204。删 manifest + by-name 链接；keep_blobs=false 时立刻 GC 独占 blob。
     若该模型正被加载 → 409 {"code":"MODEL_IN_USE"}，UI 提示先切换。

POST /api/models/activate
  Req : { "role": "asr", "id": "asr/whisper-large-v3-turbo-q5_0" }
  Resp: { "role":"asr", "active":"…", "previous":"…", "reload_required": true }
  语义：只改「当前角色使用哪个模型」的持久化状态 + 触发推理进程换载。
        与下载完全解耦（用户可以装 5 个只激活 1 个）。
  409 若模型未安装或 integrity != ok。

GET  /api/models/active            -> { "asr": "…", "llm": "…" }

POST /api/models/verify            Req {"id":"…"} -> 202 {job_id}（复用 job/SSE 机制）

GET  /api/models/storage
  -> { "models_root": "C:\\Users\\u\\AppData\\Local\\OpenMemo\\models",
       "volume": { "free_bytes": 251658240000, "total_bytes": 966367641600 },
       "used_bytes": 1832000000,
       "breakdown": [ { "model_id":"…","display_name":"…","bytes":574041195,"active":true } ],
       "reclaimable": { "orphan_blobs_bytes": 0, "stale_partials_bytes": 143510298,
                        "inactive_models_bytes": 1258000000 } }

POST /api/models/gc                Req {"targets":["orphan_blobs","stale_partials"]} -> 200 {freed_bytes}

GET  /api/models/sources           -> { "selected":"auto","effective":"modelscope",
                                        "probes":[{"id":"modelscope","ok":true,"ttfb_ms":38,
                                                   "throughput_kbps":11200,"probed_at":"…"}] }
POST /api/models/sources/probe     -> 202 {job_id}（结果走 SSE `sources.probed`）
POST /api/models/sources/select    Req {"provider":"auto"|"hf"|…} -> 200

POST /api/models/import            # 用户自带模型：本地文件 / 直链 / HF repo id
  Req: { "kind":"local_file", "path":"D:\\models\\my.gguf", "role":"llm" }
     | { "kind":"hf_repo", "repo":"unsloth/Qwen3-4B-Instruct-2507-GGUF",
         "file":"Qwen3-4B-Instruct-2507-Q4_K_M.gguf", "role":"llm" }
  -> 202 {job_id}；服务端解析 GGUF 头自动填 requirements（§2.3）
  ⚠ 安全：本地导入不校验 digest（用户自己的文件）；hf_repo 导入先 HEAD 取 x-linked-etag 作为期望 digest。
     UI 必须显示「自定义模型，非官方目录」标记。

  ★ 落地口径修正（ADR-016）：`kind:"hf_repo"` **不实现，返回 501，且这是终态而非待办**。
    上面那个"HEAD 取 x-linked-etag 当期望 digest"的设计有个说不通的地方：
    x-linked-etag 是**同一次响应**里由**同一个来源**给的，拿它去校验它自己发来的字节，
    等于让被验方自证 —— 与 ADR-004 决策 5「digest 必须来自 git 里的清单」直接冲突。
    真正的权威 digest 只能来自我们仓库里钉死的 manifest，而任意 HF repo 没有这个前提。
    用户已确认「本地转写有 whisper 就够了」，因此**不补实现、改口径**：
    对外不再宣称"可导入任意 HF GGUF 模型"。`local_file` 保留（用户自己的文件，风险自负且已告知）。

GET  /api/models/migrate/target-check?path=D:\\OpenMemoModels  -> 空间/权限预检
POST /api/models/migrate           Req {"path":"…"} -> 202 {job_id}
```

### 8.7 状态机

```
              ┌──────────┐
   pull ─────>│  queued  │
              └────┬─────┘
                   v
              ┌──────────┐  provider 探测/解析 CDN 签名 URL
              │ resolving│
              └────┬─────┘
                   v
   pause ◄───┐┌──────────────┐┌──> cancel ──> cancelled (.partial 保留)
             ││ downloading  ││
   resume ──►└└──────┬───────┘┘
                     v
              ┌──────────────┐  全量 sha256
              │  verifying   │──失败──> 换源 ──> resolving（attempt+1）
              └──────┬───────┘          └─耗尽─> failed
                     v
              ┌──────────────┐  写 manifest + by-name 硬链接 + 解压可选文件
              │  installing  │
              └──────┬───────┘
                     v
                   done ──(activate_on_success)──> POST /api/models/activate
```

---

## 9. UI 线框图

### 9.1 主页面：模型管理

```
┌───────────────────────────────────────────────────────────────────────────────────────────────┐
│  设置  ›  模型管理                                                    [ ⟳ 刷新目录 ]  [ ⚙ ]  │
├───────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                               │
│  ┌─ 当前使用 ──────────────────────────────────────────────────────────────────────────────┐  │
│  │  🎙 转写模型   Whisper large-v3-turbo (Q5_0)   574 MB   ✅ 已校验        [ 切换 ▾ ]     │  │
│  │  🧠 语言模型   ⚠ 未选择 —— 思维导图功能不可用                        [ 去安装 → ]     │  │
│  └─────────────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                               │
│  ┌─ 你的硬件 ──────────────────────────────────────────────────────────────────────────────┐  │
│  │  NVIDIA RTX 4060 Laptop · 显存 8.0 GB（可用 6.9 GB） · 内存 32 GB · 后端 CUDA 12.4 ✅   │  │
│  │  模型目录 C:\Users\u\AppData\Local\OpenMemo\models · 剩余 234 GB       [ 更改位置 ]     │  │
│  └─────────────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                               │
│  ┌───────────────┬───────────────────────────────────────────────────────────────────────┐   │
│  │ 🎙 转写模型   │ 🧠 语言模型  │  📦 已安装 (3)  │  ⬇ 下载中 (1)                        │   │
│  └───────────────┴───────────────────────────────────────────────────────────────────────┘   │
│                                                                                               │
│  [🔍 搜索模型…            ]   语言 [ 全部 ▾ ]  排序 [ 推荐 ▾ ]   ☑ 只显示这台机器能跑的      │
│                                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │ ✅推荐  Whisper large-v3-turbo                                    ★ 官方默认           │  │
│  │         多语种 · 中文优秀 · 速度与准确率平衡最好                                        │  │
│  │         量化 [ Q5_0 — 574 MB ▾ ]   需显存 ~1.4 GB   预计 1 小时音频 ≈ 4 分钟           │  │
│  │         ✅ 可全部载入显存（需 1.4 GB / 可用 6.9 GB）                                    │  │
│  │                                                    [ ℹ 详情 ]  [    ⬇ 下载    ]        │  │
│  ├─────────────────────────────────────────────────────────────────────────────────────────┤  │
│  │ ✅推荐  Whisper large-v3                                                                │  │
│  │         多语种 · 最高准确率 · 较慢                                                      │  │
│  │         量化 [ Q5_0 — 1.08 GB ▾ ]  需显存 ~1.9 GB   预计 1 小时音频 ≈ 11 分钟          │  │
│  │         ✅ 可全部载入显存（需 1.9 GB / 可用 6.9 GB）                                    │  │
│  │                                                    [ ℹ 详情 ]  [    ⬇ 下载    ]        │  │
│  ├─────────────────────────────────────────────────────────────────────────────────────────┤  │
│  │ 📦已安装 Whisper small                                              ● 当前未使用        │  │
│  │         多语种 · 轻量 · 适合低配机器                                                    │  │
│  │         Q5_1 — 190 MB   已安装于 2026-08-01   ✅ 已校验                                 │  │
│  │                                       [ ⭐ 设为默认 ] [ ✓ 校验 ] [ 🗑 删除 ]           │  │
│  ├─────────────────────────────────────────────────────────────────────────────────────────┤  │
│  │ ⚠️可跑但慢  Whisper large-v3（F16 完整精度）                                            │  │
│  │         量化 [ F16 — 3.10 GB ▾ ]  需内存 ~3.9 GB                                        │  │
│  │         ⚠️ 显存不足，部分层将在 CPU 运行 · 预计 1 小时音频 ≈ 38 分钟                    │  │
│  │            💡 改选 Q5_0 量化即可全部载入显存                        [ 仍要下载 ]        │  │
│  ├─────────────────────────────────────────────────────────────────────────────────────────┤  │
│  │ ⛔跑不动  Qwen3-32B                                                                     │  │
│  │         Q4_K_M — 19.8 GB   需内存 ~22 GB / 本机 32 GB 可用 24 GB… 显存 8 GB            │  │
│  │         ⛔ 内存不足，无法运行                                       [ 仍要下载 ]        │  │
│  │            （按钮**不禁用**，点击弹二次确认。理由见 §9.6 第 7 条）                       │  │
│  └─────────────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                               │
│  ┌─ 磁盘占用 ──────────────────────────────────────────────────────────────────────────────┐  │
│  │  模型共占用 3.23 GB                                                                     │  │
│  │  ██████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  3.23 GB / 236 GB 可用            │  │
│  │  ├ Whisper large-v3-turbo Q5_0  574 MB  ● 使用中                                        │  │
│  │  ├ Whisper small Q5_1           190 MB                                                  │  │
│  │  ├ Qwen3-4B-Instruct Q4_K_M    2.50 GB  ● 使用中                                        │  │
│  │  └ 可清理：未完成的下载 137 MB · 孤立文件 0 B          [ 🧹 清理 137 MB ]              │  │
│  └─────────────────────────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 9.2 量化选择器（展开态）

点击 `[ Q5_0 — 547 MB ▾ ]` 展开：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  选择量化档位                                              Whisper large-v3-turbo │
├──────────┬──────────┬────────────┬──────────────┬───────────────────────────┤
│  量化     │  体积    │  需显存    │  相对质量    │  这台机器                  │
├──────────┼──────────┼────────────┼──────────────┼───────────────────────────┤
│ ● Q5_0   │  574 MB  │  ~1.4 GB   │  ★★★★☆      │  ✅ 推荐 · 全显存 · ≈4 分钟/小时 │
│ ○ Q8_0   │  874 MB  │  ~1.7 GB   │  ★★★★★      │  ✅ 可以 · 全显存 · ≈5 分钟/小时 │
│ ○ F16    │ 1.62 GB  │  ~2.4 GB   │  ★★★★★      │  ✅ 可以 · 全显存 · ≈5 分钟/小时 │
├──────────┴──────────┴────────────┴──────────────┴───────────────────────────┤
│  💡 Q5_0 在体积和质量间平衡最好，绝大多数场景推荐。                          │
│     ★ 为相对质量参考，非精确测量值。                                        │
│                                                        [ 取消 ]  [ 确认 ]   │
└─────────────────────────────────────────────────────────────────────────────┘
```

（⚠ 实现注意：`★` 列必须标注为**相对参考而非测量值**。见 §3.3，我们没有可信 WER 数据源。）

### 9.3 下载中（行内 + 抽屉）

行内态：

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ ⬇下载中  Qwen3-4B-Instruct-2507 (Q4_K_M)                                                 │
│         ███████████████████████░░░░░░░░░░░░░░░░░░░░░░░░  52%   1.30 GB / 2.50 GB        │
│         8.4 MB/s · 剩余约 2 分 21 秒 · 来源 ModelScope（自动选择）                       │
│                                                    [ ⏸ 暂停 ]  [ ✕ 取消 ]  [ 切换源 ▾ ] │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

其他状态行：

```
│ 🔍校验中  Whisper large-v3-turbo (Q5_0)   正在校验完整性…  ████████░░ 78%              │
│ ⚠失败    Qwen3-8B (Q4_K_M)   校验和不匹配，已自动切换到 hf-mirror 重试（第 2/3 次）    │
│ ⛔失败    Qwen3-8B (Q4_K_M)   所有下载源均失败                [ 重试 ] [ 诊断 ] [ 移除 ]│
│ ⏸已暂停  Whisper large-v3 (F16)   已下载 1.2 GB / 2.9 GB     [ ▶ 继续 ]  [ ✕ 取消 ]   │
```

下载队列抽屉（右下角常驻，可折叠）：

```
┌─ 下载队列 (2 进行中 · 1 排队) ──────────────────── [－] ┐
│ ⬇ Qwen3-4B-Instruct Q4_K_M   ███████░░░  52%   2m21s   │
│ ⬇ Whisper large-v3   Q5_0    ██░░░░░░░░  18%   4m02s   │
│ ⏳ Gemma-3-4B-it     Q4_K_M   排队中（第 1 位）          │
│ ─────────────────────────────────────────────────────  │
│ 总计 3.1 GB / 6.0 GB · 合计 11.2 MB/s   [ 全部暂停 ]   │
└────────────────────────────────────────────────────────┘
```

### 9.4 详情弹层

```
┌───────────────────────────────────────────────────────────────────────────┐
│  Whisper large-v3-turbo                                              [✕]  │
├───────────────────────────────────────────────────────────────────────────┤
│  多语种自动语音识别模型。large-v3 的蒸馏版本，解码层由 32 减至 4，        │
│  速度大幅提升而准确率接近 large-v3。中文表现优秀。                        │
│                                                                           │
│  架构      whisper (ggml)          许可      MIT                          │
│  语言      多语种（含中文）        来源      ggerganov/whisper.cpp        │
│  版本      revision 5359861c       目录版本  2026.08.01                   │
│                                                                           │
│  ── 文件 ───────────────────────────────────────────────────────────────  │
│  ggml-large-v3-turbo-q5_0.bin                             574.0 MB        │
│    sha256:394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2│
│  ☐ CoreML 编码器（仅 macOS，启用 ANE 加速）              +1.17 GB  可选   │
│                                                                           │
│  ── 这台机器 ───────────────────────────────────────────────────────────  │
│  ✅ 推荐 · 可全部载入显存                                                 │
│     需要 ~1.4 GB，RTX 4060 Laptop 可用 6.9 GB                             │
│     预计 1 小时音频约需 4 分钟（基于本机实测基准）                        │
│                                                                           │
│  ── 下载源 ─────────────────────────────────────────────────────────────  │
│  ● 自动（当前：ModelScope · 11.2 MB/s）                                   │
│  ○ Hugging Face      ○ hf-mirror.com      ○ ModelScope      ○ memo.ac CDN │
│                                                    [ 重新测速 ]           │
│                                                                           │
│                                       [ 取消 ]  [   ⬇ 下载 574 MB   ]    │
└───────────────────────────────────────────────────────────────────────────┘
```

### 9.5 空态 / 首次引导

```
┌───────────────────────────────────────────────────────────────────────────┐
│                                                                           │
│                          🎙  还没有安装转写模型                            │
│                                                                           │
│        我们检测到你的设备：NVIDIA RTX 4060 Laptop · 8 GB 显存             │
│        推荐安装 Whisper large-v3-turbo (Q5_0) —— 574 MB，中文效果好        │
│                                                                           │
│                    [  一键安装推荐模型（574 MB）  ]                       │
│                                                                           │
│                         或  [ 浏览全部模型 ]                              │
│                                                                           │
│        💡 检测到你可能在中国大陆网络，已自动选择 ModelScope 下载源         │
│           下载速度慢？[ 更换下载源 ]                                       │
└───────────────────────────────────────────────────────────────────────────┘
```

### 9.6 前端实现约束（给 T-022）

1. **禁止在前端复刻 fitness 规则**。只渲染 `fitness.tier` + `fitness.reason_zh`。
2. **挂载顺序**：`GET /api/models/catalog` + `GET /api/models/jobs` + `GET /api/models/storage`
   （并行）→ 渲染 → 订阅 `GET /api/models/events`。**不要先订阅再拉快照**（会漏事件或重复计数）。
3. **只开一条 EventSource**，全页共享，放在 store 层，不要每个组件一条。
4. 进度条更新节流到 **≥200 ms**，否则 8 MB/s 下 SSE 事件会打满 React 渲染。
   服务端也做同样节流：`job.progress` 每 job 最多 **4 次/秒**。
5. `total_size` 是字节整数，格式化在前端做（`GB` 用 1e9 显示给用户，`GiB` 只出现在技术详情里 —— 统一口径，避免"547 MB 还是 523 MiB"的困惑）。
6. 所有破坏性操作（删除、清理、更改目录）需二次确认，并显示将释放的字节数。
7. **【修订】`unsupported` 档不要把下载按钮置灰。** §9.1 线框图里画的是禁用态，
   经 GPT4All 源码比对后我改主意了 —— 它的做法（永远可点，只挂红字警告）在产品上更对：
   我们的估算必然有误差（LM Studio 的 beta 估算器就翻过车，见 §1.4），
   **硬禁用会把估算错误变成"功能缺失"，用户无法自救**。
   改为：按钮可点，点击弹二次确认「预计需要 22 GB，本机可用 8 GB，很可能失败或极慢。仍要下载？」
   —— 保留用户的最终决定权。唯一真正禁用的是 `blocked_disk`（磁盘不够是确定性事实，不是估算）。

---

## 10. 模型目录的维护策略

### 10.1 三层结构（推荐方案）

| 层              | 内容                                                   | 更新方式             | 何时使用                            |
| --------------- | ------------------------------------------------------ | -------------------- | ----------------------------------- |
| **L1 内置**     | `catalog.bundled.json` 编译进二进制                    | 随版本发布           | 永远可用的兜底；全新安装 + 无网络时 |
| **L2 远程**     | `https://cdn.memo.ac/catalog/v1/catalog.json` + `.sig` | 随时热更新，无需发版 | 默认路径                            |
| **L3 实时查询** | HF / ModelScope API                                    | 用户输入时实时查     | **仅**"高级 → 自带模型"页           |

**为什么不硬编码（纯 L1）**：新模型（如下一个 whisper 版本、Qwen3.5）要等发版才能上，
且体积/digest 一旦上游改动就全线失效。

**为什么不实时查 HF 做主目录（纯 L3）**：

1. 国内不可达（§5）；
2. 匿名限流 **500 req / 300 s**（实测响应头），共享出口 IP 会被打满；
3. HF 上一个模型有 20+ 个量化文件，**没有"哪个好"的信息**，需要我们策展；
4. 无法附加我们自己的 `requirements` / `fitness` 元数据；
5. 上游 repo 被删/改名会直接让功能消失。
   （LM Studio 敢实时查，是因为它有自己的服务端做中间层——我们没有，也不需要。）

**为什么 L2 是主路径**：ComfyUI-Manager 的 `local/cache/remote` 三模式已经在生产中验证了这个形态。

### 10.2 获取与缓存

```
启动 / 用户点刷新
   ↓
GET https://cdn.memo.ac/catalog/v1/catalog.json
    If-None-Match: <catalog/catalog.etag>
   ↓
304 → 用磁盘缓存，source="cache", stale=false
200 → 验签（§10.3）→ 通过则写盘 + 更新 etag，source="remote"
                    → 验签失败 → 丢弃，回落，并上报遥测（可能是 CDN 被投毒）
超时/失败 → 磁盘缓存（不论多旧）→ source="cache", stale = (age > 7d)
          → 磁盘缓存也没有 → L1 内置，source="bundled", stale=true
```

TTL：**24 小时**内不重复请求（除非用户手动刷新）。UI 在 `stale=true` 时显示：

```
ℹ 当前使用离线模型目录（最后更新于 12 天前）。联网后将自动更新。   [ 立即重试 ]
```

### 10.3 签名（这是 ComfyUI-Manager 的教训）

目录里含**任意下载 URL**。若 CDN 或 DNS 被劫持，攻击者可让应用下载任意文件。
ComfyUI-Manager 的应对是「白名单 + security_level」，仍然不够
（它自己的 `security_check.py` 就是在事后补挂已知恶意包黑名单）。

我们的做法：

1. `catalog.json` 用 **Ed25519** 私钥签名，产出 `catalog.json.sig`；**公钥硬编码在二进制里**。
2. 验签失败 → **完全拒绝**，回落到缓存/内置，不做任何降级放行。
3. 目录内每个文件条目**必须**有 `sha256`；下载后强制校验（§6.6）。
   → 即便某个镜像源被投毒，内容对不上就被丢弃。
4. 用户自带模型（L3 / `POST /api/models/import`）走独立路径，UI 明确标注「非官方目录」，
   且**不允许**它覆盖官方条目的 id。
5. 目录里只允许 `https://` URL；host 必须在编译期常量白名单内
   （`huggingface.co`、`hf-mirror.com`、`www.modelscope.cn`、`cdn.memo.ac`）。

### 10.4 目录构建流水线（我们自己的 CI）

这条流水线是**自动化**的，把 §2.3 的 GGUF Range 技巧用起来：

```
1. 读 sources.yaml（人工策展：哪些 repo / 哪些 quant 进目录）
2. 对每个条目：
   a. GET  https://huggingface.co/api/models/{repo}/tree/{rev}   → size
   b. HEAD .../resolve/{rev}/{file}                              → x-linked-etag = sha256
      （交叉校验 a 的 lfs.oid，两者必须一致，否则 CI 失败）
   c. 若 .gguf：Range bytes=0-8388607 → 解析 GGUF 头
      → block_count / head_count_kv / key_length / value_length / context_length
      → 算出 kv_bytes_per_token 与 requirements
   d. 若 whisper ggml：按 §7.2 的 overhead 表算 requirements
   e. 探测 ModelScope 镜像是否存在同 sha256 的文件 → 填 mirrors[]
3. 生成 catalog.json → Ed25519 签名 → 发布到 CDN
4. 同步把默认清单的 blob 推到 cdn.memo.ac/blobs/sha256-<hex>
5. 每日定时跑：若上游 sha256 变了 → 告警（上游改文件是真实风险），人工确认后才发布
```

**收益**：`requirements`（显存需求）不再是人肉填写的猜测值——
这正是 GPT4All（手填 `ramrequired`）和 ComfyUI-Manager（干脆没有）做不到的。

### 10.5 离线兜底总结

| 场景              | 行为                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| 完全离线首次启动  | L1 内置目录可浏览；点下载报「无网络」；已装模型正常用                                                      |
| 离线但已装模型    | 全功能可用，模型页显示 `stale` 横幅                                                                        |
| CDN 挂了，HF 可达 | L2 失败 → 缓存/内置目录 → 下载源自动选 HF（目录与下载源是**解耦**的）                                      |
| 内网/隔离环境     | 设置里可指定自定义 `catalog_url` + 自定义 provider base URL；或直接 `POST /api/models/import` 导入本地文件 |

---

## 11. 待办 / 交给别人的问题

| #   | 问题                                                                                                   | 归属                    |
| --- | ------------------------------------------------------------------------------------------------------ | ----------------------- |
| 1   | `hf-mirror.com` 在**中国大陆网络**的可用性/限速/Range/tree API 代理情况 —— §5.4 有脚本，需大陆机器复测 | Manager 找人复测        |
| 2   | 硬件描述 JSON 契约（§7.1）与 R-02 对齐                                                                 | `gpu-runtime` + Manager |
| 3   | Gemma 权重的再分发许可（我们能否自建 CDN 镜像）                                                        | `oss-scout`             |
| 4   | whisper 各模型的 WER —— 当前 `UNKNOWN`。若产品要对外宣称准确率，需自建评测集                           | 后续任务                |
| 5   | §7.4 的 `flops_ratio` 外推系数需实测校准                                                               | 开发期                  |
| 6   | Gemma-3 SWA 使实际 KV < 我算的上界，折扣比例 `UNKNOWN`                                                 | 开发期实测              |
