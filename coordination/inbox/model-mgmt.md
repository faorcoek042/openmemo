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

---

## [2026-08-02 14:40] T-013 DONE

交付:
- `packages/shared/src/{index,hardware,artifacts,models,backends,fitness,jobs,events,api,schemas,ulid}.ts`（11 个）
- `packages/shared/openapi.yaml`（26 路径 / 27 操作 / 105 schema，与 `ENDPOINTS` 逐条对齐）
- `packages/downloader/src/{index,http,sidecar,verify,download,probe,store,queue,installer,manifest}.ts`（10 个）
- `packages/downloader/scripts/{gen-manifest,verify-download,verify-offline}.mjs`
- `vendor/manifests/{models-whisper,models-llm,backends}.json`（14 模型 + 10 后端包）
- `docs/design/D-03-download-and-model-api.md`

### 下载器本机实测（T-013 核心验收项）
真下 `ggml-tiny.bin`（77,691,713 B），两套脚本共 53 项断言：
- **联网 28/29**：断点续传**省下 12.1 MB**；SHA-256 三重交叉一致（HF `lfs.oid` = `x-linked-etag`
  = 我们独立计算）；SHA-1 与 whisper.cpp README 公布值一致；ModelScope 与 HF 摘要相同；
  硬链接 inode 共享（nlink=2，零额外磁盘）；GC 回收 77.7 MB；探针排序 modelscope > hf。
  唯一失败是瞬时 `fetch failed`，**已隔离复测确认逻辑正确**（0 字节即拒绝错文件）。
- **离线确定性 25/25 全绿**（本地 HTTP 源 + 故障注入）：错哈希拒绝且零残留、传输前拒绝、
  断线续传（3.15 MB 只重传 1.75 MB）、无 Range 回退、体积不符拒绝、损坏镜像跳过、
  队列去重/并发上限/取消/重试、跨平台可选文件跳过。
命令：`node packages/downloader/scripts/verify-offline.mjs`（60s，无需外网）

### 实测发现并修掉的 3 个真 bug
1. **单源失败中止全局** —— 不存在的 HF repo 返 401，我判为不可重试 → 整个任务中止，
   **多源容灾形同虚设**。改为只有 DISK_FULL/CANCELLED/PERMISSION_DENIED 中止全局。
2. **`redirect:'follow'` 静默废掉预校验** —— HF 把 `x-linked-size`/`x-linked-etag` 放在 302 上，
   follow 后读到 null（实测对比已记录），"传输前拒绝错文件"这条安全检查**永不触发且不报错**。
   改为手动逐跳跟随。这类静默失效的安全检查最危险。
3. **`shared` 误引 `node:crypto`** —— 被 `apps/web` 浏览器包 import 时被 Vite externalize。
   改用 Web Crypto，现在 `packages/shared/src` 零 `node:` 依赖（同构约束已写入文档）。

### 已处理的四条插播
1. **lint 修完**：`packages/shared` + `packages/downloader` + `scripts` **eslint EXIT=0**。
   未依赖 TD-001 豁免（未使用变量都真删了）。我的 `.mjs` 用显式 `node:` 导入自给自足，
   **没有改 `oss-scout` 的 eslint.config.js**（其 node-globals glob 只覆盖根 `scripts/`）。
2. **双 ID 已对齐 D-02**：`jobId` → ULID（= `jobs.uid`）；并把我的 job 状态机**并入 D-02 词表**
   （`state` 用 D-02 的 8 值，原 `resolving/downloading/verifying/installing` 降为 `current_step`）
   —— 没有造第二套词汇。模型 `id` 保持 slug（D-02 `model_installs.model_id` 明确要求一致）。
3. **ADR-005/006 已吸收**：`packages/downloader/scripts/**` 归我；WebGPU 无条目（本就没建）；
   Node 22 基线无冲突。
4. **`pnpm -r build` 红灯已修**（`shared` 未导出 `ulid`）。现仅剩 `packages/pipeline`
   的 `argGuard.test.ts` TS2352 —— 不是我的文件。

### ADR-007 三条已实现
- **SSE 事件 14 → 28**：补齐 `transcribe.{started,partial,segment,done}`、`mindmap.{delta,done}`、
  `note.{created,updated,deleted}`、`media.ready`、`record.state`、`job.{done,blocked}`、`sync.required`。
  另导出 `AUTHORITATIVE_EVENT_TYPES` 与 `SEQUENCED_EVENT_TYPES`，把「哪些事件的 payload 就是数据、
  必须按 seq 有序应用」这条规则**编码成常量**，而不是只写在文档里。
- **`Remediation` 已落地**，挂在 `ApiErrorBody.error.remediation` 与 `JobBlockedEvent.remediation`。
- **错误文案** code 优先 + 后端兜底，已在 `ApiErrorBody` 注释固化。

### 显存需求全部机器生成（ADR-004 决策 4）
`gen-manifest.mjs --gguf` 用 8 MB Range 读 GGUF 头算 KV cache。实测：
Qwen3-4B Q4_K_M @8K = **4130 MB（KV 占 1208 MB）**；8B = 6787 MB；Gemma-3-4B = 4055 MB。
`--check` 对上游复核清单：**16/16 ok**。zod schema 当场抓出我自己的建模错误
（Whisper 无 context 却填 0 → 改 `null`）。

需要 Manager 决策 / 转达:
1. **SSE 信封扁平 vs D-01 嵌套** —— D-01 §3.3 写 `{type,ts,topic,payload}` 嵌套，我实现为扁平
   （D-05 §2.3 已按扁平写，且扁平才能做 TS discriminated union）。**请 `architect` 裁决**，我照改。
2. **F1–F5 事件 payload 由我从 D-01 时序图推导**（D-05 只点名未给形状）——
   `transcribe.segment` 的 `seq/speaker/confidence`、`mindmap.delta` 的 `nodeKey/parentKey`
   （对齐 D-02 `mindmap_nodes.node_key`）等，**请 `architect` 确认**。
3. **backends.json 有诚实缺口**：whisper.cpp v1.9.1 官方 release **无 macOS CLI / 无 Vulkan / 无 ROCm**
   （拉 release 资产列表再次确认，印证 R-02）。这三个组合**清单里就是没有**，不放占位条目，
   待 `gpu-runtime` 自建 CI 产出后补。
4. 未实现但已写规格并显式抛错（不静默）：压缩包解压（含 zip-slip 防护）、catalog Ed25519 验签 → 建议进 T-020。

自查（诚实规则）:
- 离线测试一度报「续传从零开始」，我先怀疑自己的代码，实测后确认是**测试写得不真实**：
  `res.write()` 后立刻 `res.destroy()` 会让 undici 以 `UND_ERR_SOCKET` 拒绝整个 fetch、
  **零字节交付**，客户端确实没有进度可存。改成 flush 后延迟再断即正确。已在 D-03 §8.6 如实记录。
- `estimateGpuLayers` 系数、RTF 外推系数**均未标定**，代码与文档都标了未验证。
- `vec0` rowid BigInt：`shared`/`downloader` **无任何 rowid 绑定**（整数 PK 不出 daemon），不受影响。

派生 agent（未 kill，可复用）:
- `aa5da4428d45a9125` — 模型/后端清单数据采集（sonnet5）
- `a598b2a036add8e9f` — OpenAPI 3.1 文档生成（sonnet5）
