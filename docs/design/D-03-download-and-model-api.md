---
id: D-03
author: model-mgmt
status: ready
date: 2026-08-02
implements: ADR-003 决策 6, ADR-004 全部, ADR-005 决策 3, ADR-006 决策 5, ADR-007 决策 1/2/3
inputs: R-04, R-02 §C.3, D-01, D-02, D-05, /root/memo-forensics
---

## TL;DR（≤ 25 行，Manager 只读这里）

- **统一下载器已实测跑通**：真下 `ggml-tiny.bin`（77,691,713 B）。两套验证脚本共 **53 项断言**：
  联网 28/29（唯一失败是瞬时 `fetch failed`，已隔离复测确认逻辑正确）、离线确定性 **25/25 全绿**。
- **断点续传已验证**：联网中断后重下**省掉 12.1 MB**；离线注入连接中断后 3.15 MB 只重传 1.75 MB。
- **SHA256 校验已验证，且补上了 Ollama 的缺口**：错哈希 → `CHECKSUM_MISMATCH`，**blob 与 partial 都不留**。
  更进一步：因为 HF/ModelScope 在 302 上暴露 `x-linked-etag`，我们能在**传输 0 字节前**就拒绝错文件。
- **修掉一个隐蔽真 bug**：`redirect:'follow'` 会丢掉 `x-linked-size`/`x-linked-etag`（实测 follow→null、
  manual→有值）→ 预校验形同虚设。改为手动逐跳跟随。这类"静默降级的安全检查"最危险。
- **`packages/shared` 现在是 F1–F5 的完整 SSE 契约**（ADR-007 决策 1）：事件从 14 → **28 个**，
  补齐 `transcribe.segment/partial`、`mindmap.delta`、`note.*`、`media.ready`、`record.state`、
  `job.blocked`、`sync.required`。payload 由 D-01 时序图推导（D-05 未给），**需 `architect` 确认**。
- **`Remediation` 已落地**（ADR-007 决策 2），同时挂在 `ApiErrorBody.remediation` 与 `job.blocked` 上
  —— 这是要求 2.1「不碰命令行」的机器可读支点。
- **双 ID 已对齐 D-02**：`jobId` 改 ULID（= `jobs.uid`），并把我原先的 job 状态机**并入 D-02 词表**
  （`state` 用 D-02 的 8 值，我原有的 `resolving/downloading/verifying/installing` 降为 `current_step`）。
  没有造第二套词汇。**模型 `id` 保持 slug**（D-02 `model_installs.model_id` 明确要求与 manifest id 一致）。
- **显存需求全部由 GGUF 头算出，无一手填**：8 MB Range 读头 → KV cache。实测 Qwen3-4B Q4_K_M
  @8K = **4130 MB**，其中 KV 占 1208 MB。只看"2.5 GB 文件 < 4 GB 显存"会直接 OOM。
- **manifest 已入 git 且 CI 可验**：14 个模型 + 10 个后端包，`--check` 对上游复核 **16/16 ok**。
  schema 当场抓到我自己的建模错误（Whisper 无 context 却填 0），已改为 `null`。
- **修掉全仓库唯一红灯**：`shared` 未导出 `ulid` —— 已修；顺带发现并修掉 `ulid.ts` 误引 `node:crypto`
  导致 `apps/web` 浏览器包被 Vite externalize（改用 Web Crypto，shared 现在零 `node:` 依赖）。
- **未验证/存疑**：archive 解压未实现（抛错不静默）；catalog Ed25519 验签未实现（已写规格）；
  `estimateGpuLayers` 与 RTF 外推系数仍未标定；backends.json 的 macOS/Vulkan whisper 包**上游不存在**
  （R-02 早已指出），需自建 CI 后补。
- **对其他 agent**：`gpu-runtime` 按 §3 硬件契约实现并复核 §6 统一下载器；`architect` 确认 §4 事件 payload；
  T-021/T-022/T-023 按 §7 线框图与 §4 事件表开工。

---

# 详细内容

## 1. 范围与文件所有权

| 路径 | 内容 |
|---|---|
| `packages/shared/src/**` | 契约：类型 + zod schema + 纯函数（fitness / ULID / SSE 编码） |
| `packages/downloader/src/**` | 统一下载器实现 |
| `packages/downloader/scripts/**` | 清单生成器 + 两套验证脚本（ADR-005 决策 3） |
| `vendor/manifests/*.json` | 模型与后端包清单（ADR-001 C 类，入 git） |

**`packages/shared` 是同构包**：被 `apps/daemon`（Node）与 `apps/web`（浏览器）同时 import，
因此**禁止任何 `node:` 引入**。我自己就踩过这个坑（见 §8.3），现已加为硬约束。

---

## 2. 模型注册表 schema

### 2.1 取证基线（ADR-004 决策 4）

我解包了 memo.ac 的 `app.asar`，发现它有**两套不一致的注册表**：

| 文件 | 条目 | 体积字段 | 哈希 | 量化 | 显存 |
|---|---|---|---|---|---|
| `presets/whisper-models.js` | 15 | `"77.7 MB"` **字符串** | `sha` = **40 位 SHA-1** | ❌ 无 | ❌ 无 |
| `plugins/extra-transcription-plugins.json` | — | `sizeBytes` **整数** | `sha256` ✅ | ❌ 无 | ❌ 无 |

第二套明显更好，**我们以它为基线**。另注意旧表里的：

```js
"speed": 6, "quality": 2,          // 1–6 硬编码整数，无任何出处
"speedLabel": "common.fast",
```

→ ADR-004 决策 3 禁止编造数字，**这两个字段被删除**，替换为 `benchmark: BenchmarkResult | null`，
只有用户在本机跑过基准才有值。这是我们与 memo.ac 最本质的差别之一。

memo.ac 另外自建了 `Memo-large.zh.bin` / `.ja.bin`（`https://model.memo.ac/`，各 2.88 GB）——
说明它做了中日文微调模型。**我们首版不跟**（ADR-004 决策 2 已否决自建 CDN）。

### 2.2 我们的三处补充

| 字段 | 对应缺口 |
|---|---|
| `quantization` + `quantTier` | 缺口①：memo.ac 全部 f16，无量化选择。我们同一模型可有 q5_0/q8_0/f16 三档 |
| `requirements.{ram,vram,disk}RequiredMB` + `computedAtContext` | 缺口②：memo.ac 无 fit 预检 |
| `Backend` 枚举 6 值 | 缺口③：memo.ac 只有 cuda/metal/coreml |

`computedAtContext` 的设计要点：**显存数字脱离上下文长度就没有意义**（KV cache 与之线性相关），
所以必须把假设一起存。Whisper 与 context 无关，填 `null` —— **不是 0**，0 会被读成"在 0 上下文下算的"。
（这条是我的 zod schema 在校验清单时当场抓出来的，见 §8.4。）

### 2.3 schema 强制（CI 门禁）

`ModelManifestSchema` 除常规类型外还强制：

- `sizeBytes` 必须是**整数字节**，不接受任何格式化字符串（ComfyUI-Manager 的 `"4.71MB"`、
  GPT4All 的字符串 `filesize`、memo.ac 的 `"77.7 MB"` 全是反面教材）。
- `sha256` **必填**，64 位小写十六进制。
- URL 必须 `https://` 且 host 在**编译期白名单**内。
- `name` 不得含 `/`、`\`、`..`（路径穿越防护）。
- `totalSizeBytes` 必须等于非可选文件之和。
- `kvBytesPerToken` 必须与 GGUF 头字段自洽（防手改）。
- **同一 sha256 不得出现两个不同 size** —— 这条正是为 `ggml-tiny.bin`(77,691,713) 与
  `ggml-tiny.en.bin`(77,704,715) 相差 13,002 字节的教训而写。

---

## 3. 硬件描述契约（正式，供 `gpu-runtime` 实现）

定义在 `packages/shared/src/hardware.ts`。fitness 计算只依赖这 8 个字段：

```
cpu.features                      ★ 至少要有 "avx2"
ram.totalMB                       ★
unifiedMemory                     ★ Apple Silicon 必须为 true，缺了整套判断在 mac 上失效
gpus[].vramTotalMB                ★
gpus[].vramFreeMB                 ★ 拿不到填 null，我按 total×0.85 估
selectedBackend / selectedGpuIndex ★
disks[pathFor='models_root'].freeMB ★ 要模型目录所在卷，不是系统盘
```

两条来自 R-02 与竞品事故的硬约束：

1. **`available` 必须是真实枚举结果，不是文件存在性检测。** R-02 在本机实测到
   `libvulkan.so.1` 存在但无任何 GPU、无 `/dev/dri`。loader ≠ ICD ≠ 硬件。
2. **显存预算绝不跨卡求和。** LM Studio issue #67：双 3090 被标记
   "Full GPU Offload Possible"，实际加载直接 OOM。我们只算 `selectedGpuIndex` 那一张。

---

## 4. SSE 事件契约（ADR-007 决策 1）

### 4.1 事件全集（28 个）

| 域 | 事件 |
|---|---|
| 任务生命周期 | `job.created` `job.progress` `job.state` `job.done` `job.failed` `job.blocked` |
| 模型/后端/存储 | `model.installed` `model.removed` `model.activated` `backend.installed` `backend.removed` `storage.changed` `catalog.updated` `sources.probed` `hardware.changed` |
| F1/F2 导入 | `media.ready` |
| F1/F2/F3 转写 | `transcribe.started` `transcribe.partial` `transcribe.segment` `transcribe.done` |
| F3 录音 | `record.state` |
| F4 导图 | `mindmap.delta` `mindmap.done` |
| F5 笔记 | `note.created` `note.updated` `note.deleted` |
| 流控 | `sync.required` `keepalive` |

### 4.2 信封

```ts
interface SseEventBase {
  type: SseEventType;
  ts: string;      // ISO-8601
  topic: string;   // 合并/路由键：job:<ulid> / transcript:<ulid> / models / ...
}
```

`topic` 落地 D-01 §3.3 的 `域.动作[.阶段]` 寻址，是**250ms 节流的合并键**。

> **⚠️ 需 `architect` 裁决的一处偏差**：D-01 §3.3 写的是嵌套信封
> `{type, ts, topic, payload}`，我实现为**扁平**（字段在顶层）。理由：D-05 §2.3 已按扁平结构
> 写好（"已有完整 `DownloadJob` 载荷，直接写"），且扁平能让 TypeScript 在 `type` 上做干净的
> discriminated union。改成嵌套会让 D-05 返工。**我不单方面改，请裁决。**

### 4.3 两类事件，语义完全不同

D-01 §3.3 的总原则是「**事件只是"该去拉数据了"的提示，真相在 REST/DB**」。
但有 4 个事件是例外，它们的 payload **就是数据**：

```ts
export const AUTHORITATIVE_EVENT_TYPES = [
  'job.progress',          // 用完即弃，不进 Query 缓存
  'transcribe.partial',    // 易失，同 utteranceId 覆盖
  'transcribe.segment',    // 持久、有序、只追加
  'mindmap.delta',         // 持久、有序、只追加
];
export const SEQUENCED_EVENT_TYPES = ['transcribe.segment', 'mindmap.delta'];
```

`SEQUENCED_*` 带单调 `seq`：**严格递增应用、重复丢弃、发现缺口就整份重拉**。
这两个是「14 秒后就有字」与「导图渐进渲染」的载体，丢一条就是内容缺失，不能当提示处理。

### 4.4 F1–F5 关键 payload

```ts
// 通用进度：下载与流水线共用。step 是机器可读阶段名，UI 负责翻译成人话
JobProgressEvent  { jobId, step: 'fetch'|'demux'|'vad'|'asr'|'structure'|…,
                    pct, completedBytes, totalBytes, speedBps, etaSeconds, state }

// 前置条件不满足 —— remediation 是要求 2.1 的支点
JobBlockedEvent   { jobId, blockedCode, messageZh, remediation: Remediation | null }

// 转写：partial 易失、segment 持久
TranscribePartialEvent { transcriptUid, utteranceId, text, startSec }
TranscribeSegmentEvent { transcriptUid, seq, startSec, endSec, text, speaker, confidence }
TranscribeDoneEvent    { transcriptUid, noteUid, segmentCount, rtf, partial }

// 导图渐进构建；parentKey 用 D-02 的 mindmap_nodes.node_key，客户端可直接挂载
MindmapDeltaEvent { mindmapUid, seq, nodes: [{ nodeKey, parentKey, text,
                                               sourceStartSec, sourceEndSec }] }
```

`TranscribeDoneEvent.partial = true` 表示提前结束但**前面的段仍然有效** ——
对应 D-05 §4.1 规则 6「转写在第 37 段失败，前 36 段仍完整显示」。

### 4.5 `Remediation`（ADR-007 决策 2）

```ts
interface Remediation {
  action: string;   // install_model | install_backend | free_disk | switch_source | configure_api_key
  params: Record<string, string | number | boolean | null>;
  labelZh: string;  label: string;
}
```

挂在两处：`ApiErrorBody.error.remediation` 与 `JobBlockedEvent.remediation`。

**为什么这个字段是刚需**：章程要求 2.1 是「用户不碰命令行」。一个只有文字的错误，
用户读完仍然不知道该点哪里 —— 只能去查文档、去命令行。有了 `action` + `params`，
前端直接渲染成一个按钮。**没有它，要求 2.1 在错误路径上就是没达成。**

### 4.6 前端必读的坑

`formatSseFrame()` 产出具名 `event:` 字段，因此这些消息**只会**派发到
`addEventListener('<type>', …)`，**`EventSource.onmessage` 永远不触发**。
必须遍历 `SSE_EVENT_TYPES` 逐一注册。（D-05 §2.3 已同样警告。）

---

## 5. 存储布局

```
<models_root>/
├── blobs/sha256-<hex>                    已校验内容，文件名即摘要
├── blobs/sha256-<hex>.partial[.json]     传输中 + 断点状态
├── manifests/<asr|llm|backend>/<id>.json 已安装记录
└── by-name/<kind>/<name>                 硬链接视图（人类与原生程序用）
```

| 平台 | 路径 | 理由 |
|---|---|---|
| macOS | `~/Library/Application Support/OpenMemo/models` | **不用 Caches**：系统会在磁盘紧张时清理，几 GB 模型被静默删掉是灾难（Buzz 就存在 `user_cache_dir`） |
| Windows | `%LOCALAPPDATA%\OpenMemo\models` | **不用 Roaming**：域环境会尝试同步 |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/openmemo/models` | XDG |

**内容寻址的四个收益**：跨镜像天然去重（实测 HF 与 ModelScope 字节一致）、断点状态与来源解耦、
校验内蕴（文件名即期望哈希）、多版本共存。
**`by-name/` 用硬链接不用符号链接**：Windows 上 `CreateHardLink` 无需特权，符号链接要开发者模式。

**GC 的安全序**：**先写 blob，后写 manifest**。中途崩溃只会留下孤儿 blob（GC 可回收）；
反过来会产生指向不存在文件的悬空 manifest —— 因此禁止。GC 采用扫描式而非引用计数
（计数文件崩溃后必然漂移，扫描永远正确）。

---

## 6. 统一下载器

### 6.1 血统与改进

抄 Ollama `server/download.go`：分片 Range、断点 sidecar、per-part stall 看门狗、指数退避+jitter。

**四处刻意不同**：

| 项 | Ollama | 我们 | 理由 |
|---|---|---|---|
| SHA256 校验 | **没有**（digest 只作缓存 key，`os.Stat` 即命中） | **强制**，校验通过才 rename | ADR-004 决策 5 |
| 并发分片 | 16 | 上限 8，默认 4 | 桌面应用跑在家用宽带/热点上，16 条互相踩踏且触发 CDN 限速，ETA 全乱 |
| sidecar | 每片一个 JSON | 整文件一个 | 分片数已被压到 ≤8，单文件原子写更简单 |
| 换源 | — | **保留已下字节**，只清 validators | 摘要与来源无关（已验证 HF/ModelScope 字节一致） |

### 6.2 "校验通过才算安装"

抄 GPT4All（调研的九个产品里**唯一做对的**）：下到 `.partial` → 流式 SHA-256 →
不符则**删除并换源**，符合才原子 rename 成 blob。

⚠️ 但**不抄 GPT4All 关闭 TLS 校验**（它 `VerifyNone`，把哈希当唯一防线）。
我们 TLS 照常校验，哈希是**纵深防御的第二层**。

### 6.3 镜像策略（ADR-004 决策 1）

目录钉死 `sha256` → **镜像退化为不可信传输通道**。任何源下完校验通过即接受。
首次下载前并发探针（256 KB Range，5s 超时），按 `吞吐 / (1 + ttfb/1000)` 排序，
非官方源乘 0.8 降权。**不用 GeoIP** —— VPN、海外用户、企业代理都会判错，代价是用户卡在 0%。

**每源失败必须继续下一源**（这是实测发现的 bug，见 §8.2）：只有 `DISK_FULL`、
`CANCELLED`、`PERMISSION_DENIED` 才中止整个任务，因为换源救不了它们。

---

## 7. UI 线框图（供 T-022）

沿用 R-04 §9 的五张图，此处只列**与实现契约绑定的修订点**，其余见 R-04。

### 7.1 主页面

```
┌───────────────────────────────────────────────────────────────────────────────────────┐
│  设置 › 模型管理                                              [ ⟳ 刷新目录 ]  [ ⚙ ]   │
├───────────────────────────────────────────────────────────────────────────────────────┤
│  ┌─ 当前使用 ────────────────────────────────────────────────────────────────────┐    │
│  │ 🎙 转写模型  Whisper large-v3-turbo (Q5_0)  574 MB  ✅ 已校验     [ 切换 ▾ ]  │    │
│  │ 🧠 语言模型  ⚠ 未选择 —— 思维导图不可用                        [ 去安装 → ] │    │
│  └──────────────────────────────────────────────────────────────────────────────┘    │
│  ┌─ 你的硬件 ────────────────────────────────────────────────────────────────────┐    │
│  │ RTX 4060 Laptop · 显存 8.0 GB（可用 6.9 GB） · 内存 32 GB · CUDA 12.4 ✅      │    │
│  │ 模型目录 C:\Users\u\AppData\Local\OpenMemo\models · 剩余 234 GB [ 更改位置 ]  │    │
│  └──────────────────────────────────────────────────────────────────────────────┘    │
│  [🎙 转写模型] [🧠 语言模型] [📦 已安装 (3)] [⬇ 下载中 (1)]                          │
│  [🔍 搜索…]  语言[全部▾] 排序[推荐▾]  ☑ 只显示这台机器能跑的                          │
│  ┌──────────────────────────────────────────────────────────────────────────────┐    │
│  │ ✅推荐  Whisper large-v3-turbo                              ★ 官方默认       │    │
│  │        多语种 · 中文优秀 · 速度与准确率平衡最好                              │    │
│  │        量化 [ Q5_0 — 574 MB ▾ ]  需显存 ~1.4 GB                              │    │
│  │        ✅ 可全部载入显存（需 1.4 GB / 可用 6.9 GB）                           │    │
│  │        准确率 ⓘ 未测量  [ 跑基准 ]        ← ADR-004 决策 3：宁可空也不编      │    │
│  │                                          [ ℹ 详情 ] [    ⬇ 下载    ]        │    │
│  ├──────────────────────────────────────────────────────────────────────────────┤    │
│  │ ⚠️可跑但慢  Qwen3 8B (Q4_K_M)   5.03 GB   需 6.8 GB（含 8K 上下文 KV 1.2 GB） │    │
│  │        ⚠️ 显存不足，部分层在 CPU（约 26/36 层在显存）                         │    │
│  │           💡 改用 Q4_K_M + q8_0 KV 缓存可全部载入        [ 仍要下载 ]        │    │
│  ├──────────────────────────────────────────────────────────────────────────────┤    │
│  │ ⛔跑不动  Qwen3 32B (Q4_K_M)   19.8 GB   需 ~22 GB / 本机可用 24 GB，显存 8 GB │    │
│  │        ⛔ 内存不足                                       [ 仍要下载 ]        │    │
│  │           （按钮**不禁用**，点击弹二次确认 —— 见 §7.4）                       │    │
│  └──────────────────────────────────────────────────────────────────────────────┘    │
│  ┌─ 磁盘占用 ────────────────────────────────────────────────────────────────────┐    │
│  │ 模型共占用 3.23 GB   ████████░░░░░░░░░░░░░░░░  3.23 GB / 236 GB 可用          │    │
│  │ ├ Whisper large-v3-turbo Q5_0  574 MB ● 使用中                               │    │
│  │ ├ Whisper small Q5_1           190 MB                                        │    │
│  │ ├ Qwen3-4B-Instruct Q4_K_M    2.50 GB ● 使用中                               │    │
│  │ └ 可清理：未完成下载 137 MB · 孤立文件 0 B      [ 🧹 清理 137 MB ]           │    │
│  └──────────────────────────────────────────────────────────────────────────────┘    │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

### 7.2 量化选择器

```
┌──────────────────────────────────────────────────────────────────────────┐
│ 选择量化档位                                       Whisper large-v3-turbo │
├──────────┬─────────┬───────────┬───────────────────────────────────────┤
│ 量化      │ 体积    │ 需显存    │ 这台机器                               │
├──────────┼─────────┼───────────┼───────────────────────────────────────┤
│ ● Q5_0   │ 574 MB  │ ~1.4 GB   │ ✅ 推荐 · 可全部载入显存                │
│ ○ Q8_0   │ 874 MB  │ ~1.7 GB   │ ✅ 可以 · 可全部载入显存                │
│ ○ F16    │ 1.62 GB │ ~2.4 GB   │ ✅ 可以 · 可全部载入显存                │
├──────────┴─────────┴───────────┴───────────────────────────────────────┤
│ 💡 Q5_0 在体积和质量间平衡最好。                                          │
│ ⓘ 本表不含"质量星级" —— 我们没有可信的 WER 数据源，不编造（ADR-004 决策3）│
│                                                    [ 取消 ]  [ 确认 ]   │
└──────────────────────────────────────────────────────────────────────────┘
```

> R-04 §9.2 原稿有一列 `★★★★☆` 相对质量。**本文删掉了它** ——
> ADR-004 决策 3 已成全项目标准，星级同样是没有出处的数字，留着就是自打嘴巴。

### 7.3 下载中

```
│ ⬇下载中  Qwen3-4B-Instruct (Q4_K_M)                                        │
│        ███████████████░░░░░░░░░░░░░  52%   1.30 GB / 2.50 GB              │
│        8.4 MB/s · 剩余约 2 分钟 · 来源 ModelScope（自动选择）              │
│                              [ ⏸ 暂停 ] [ ✕ 取消 ] [ 切换源 ▾ ]           │
│ 🔍校验中  Whisper large-v3-turbo (Q5_0)  正在校验完整性… ████████░░ 78%   │
│ ⚠失败    Qwen3-8B  校验和不匹配，已自动切换到 hf-mirror 重试（第 2/3 次） │
│ ⛔失败    Qwen3-8B  所有下载源均失败      [ 重试 ] [ 诊断 ] [ 移除 ]       │
```

**ETA 文案规则**（D-05 §4.1 规则 4）：只在有依据时显示，且四舍五入到「约 X 分钟」。
**不显示「剩余 03:47」这种假精确** —— 实测速率波动很大（本机 0.5–0.6 MB/s 之间跳）。

### 7.4 前端实现约束（T-022 必读）

1. **禁止在前端复刻 fitness 规则**，只渲染 `fitness.tier` + `fitness.reasonZh`。服务端算好。
2. **挂载顺序**：并行拉 `catalog` + `jobs` + `storage` → 渲染 → 再订阅 SSE。
   先订阅后拉快照会漏事件或重复计数。
3. **只开一条 EventSource**（D-05 §2.3 已用 Web Locks 选主）。
4. 进度节流 ≥200 ms；服务端已按 4 Hz/topic 限。
5. **面向用户一律十进制 MB/GB（1e6/1e9）**，与操作系统文件大小显示一致；MiB 只出现在技术详情。
6. **`unsupported` 档不要禁用下载按钮** —— 改为二次确认。
   我们的估算必然有误差（LM Studio 的 beta 估算器就翻过车），**硬禁用会把估算错误变成"功能缺失"，
   用户无法自救**。唯一真正禁用的是 `blocked_disk`（磁盘不够是确定事实，不是估算）。
7. **准确率字段初始为空 + 一个「跑基准」按钮**，不要显示任何未测量的质量数字。

---

## 8. 实测验证

### 8.1 两套脚本

| 脚本 | 性质 | 结果 |
|---|---|---|
| `packages/downloader/scripts/verify-download.mjs` | 真实网络，对 HF/ModelScope 下 77 MB | **28/29** |
| `packages/downloader/scripts/verify-offline.mjs` | 本地 HTTP 源，确定性、可注入故障 | **25/25** |

联网实测节选（原始输出）：

```
[1] fresh chunked download + SHA-256 verification
  PASS  downloaded and verified            PASS  size matches manifest — 77691713 bytes
  PASS  blob filename is its digest        PASS  independent re-hash matches
[2] PASS  SHA-1 matches whisper.cpp README — bd577a113a864445…
[3] PASS  served from cache                PASS  zero bytes transferred
[4] PASS  sidecar records real progress — 12.1 MB already done
    PASS  resume transferred less than full file — transferred 65.6 MB of 77.7 MB (saved 12.1 MB)
[6] PASS  failed over to a working mirror — used hf after 2 attempt(s)
[7] PASS  ModelScope content digest identical to HF — same digest as HF (77.7 MB)
[8] PASS  hardlink shares one inode (no extra disk) — inode 1217019, nlink 2
    PASS  GC reclaims after manifest removal — freed 77.7 MB
[9]       hf          ok=true ttfb=1585ms  102 KB/s
          modelscope  ok=true ttfb=1381ms  163 KB/s
    PASS  ranking produced an ordering — modelscope > hf
```

**跨源三重校验**：同一文件的 HF `lfs.oid` == HF `x-linked-etag` == 我们下载后独立计算的 SHA-256
== ModelScope `Sha256`，且 SHA-1 与 whisper.cpp README 公布值一致。

离线注入故障实测：
```
[1] PASS 错哈希 → CHECKSUM_MISMATCH，目录内 0 个残留文件
[2] PASS 源声明的摘要不符 → 传输前拒绝
[3] PASS 连接中断后续传 — 3.15 MB 只重传 1.75 MB
[4] PASS 源不支持 Range → 单流回退仍校验通过
[5] PASS 体积不符 → SIZE_MISMATCH，传输前拒绝
[6] PASS 损坏镜像被跳过，好镜像接管
[7] PASS 去重/并发上限(peak=2)/取消/重试；jobId 是合法 ULID
[8] PASS 硬链接、跨平台可选文件跳过、按摘要去重
```

### 8.2 实测发现的真 bug 之一：单源失败中止全局

联网测试 [6] 第一次直接崩掉：不存在的 HF repo 返回 **401**（HF 不泄露 repo 是否存在），
我把它归为不可重试 → **整个任务中止，根本不会尝试第二个镜像**。
多源容灾在"第一个源返回任何不可重试错误"时形同虚设。

修复：区分「该源不可重试」与「所有源都没救」。只有 `DISK_FULL`/`CANCELLED`/`PERMISSION_DENIED`
中止全局，其余一律继续下一源。

### 8.3 真 bug 之二：`redirect:'follow'` 静默废掉预校验

实测对比同一 URL：

```
follow → status=206, x-linked-size=null,      x-linked-etag=null
manual → status=302, x-linked-size=2497280256, x-linked-etag="7485fe6f…"
```

HF/ModelScope 把体积与内容摘要放在 **302 上**，不在 CDN 的最终响应上。
用 `redirect:'follow'` 时两个头都读不到 → 「传输前拒绝错文件」这条安全检查**永远不会触发**，
而且**不报错、不告警**，只是静默失效。改为手动逐跳跟随，逐跳吸收 header。
修复后实测：

```
local advertises a different digest (43c5ef5aa93d…)   ← 0 字节传输即拒绝
```

**这类"静默降级的安全检查"是最危险的缺陷** —— 功能测试全绿，防线却不存在。

### 8.4 schema 抓到我自己的建模错误

`computedAtContext` 我原本给 Whisper 填 `0`，zod 校验直接拒绝（要求 > 0）。
0 会被读成「在 0 上下文下计算的」，是错的；Whisper 根本与 context 无关，正确表示是 `null`。
已改 4 处（类型 / schema / 生成器 / 清单）。**这正是给清单加 schema 门禁的价值。**

### 8.5 真 bug 之三：`shared` 误引 `node:crypto` 污染浏览器包

`pnpm -r build` 输出：
```
Module "node:crypto" has been externalized for browser compatibility,
imported by "/root/memo/packages/shared/dist/ulid.js"
```
`packages/shared` 被 `apps/web` 的浏览器包 import，任何 `node:` 引入都会被 Vite externalize
→ 运行时炸。改用 Web Crypto (`globalThis.crypto.getRandomValues`)，
现在 `grep -rn "from 'node:" packages/shared/src/` **零命中**。

### 8.6 一个诚实的更正

离线测试最初报「续传从零开始」。我一度以为是续传 bug，实测后确认是**测试写错了**：
`res.write()` 后立刻 `res.destroy()` 会让 undici 直接以 `UND_ERR_SOCKET` 拒绝整个 `fetch()`，
**一个字节都不交付给 body reader** —— 客户端确实没有任何进度可存。
真实中断会先交付几 MB（联网测试省下 12.1 MB 即为证）。
改成 flush 后延迟 50ms 再断，续传立刻正确。**是测试不真实，不是代码有错**，如实记录。

### 8.7 清单与上游一致性

```
$ node packages/downloader/scripts/gen-manifest.mjs --check
  ok  llm/qwen3-4b-q4_k_m/Qwen3-4B-Q4_K_M.gguf
  … (16 行)
16 file(s) checked, 0 problem(s).
```

CI 应定期跑：**上游改动一个已钉住的文件正是需要人来看的时刻**（供应链信号）。

---

## 9. 显存需求的自动生成

```
1. GET /api/models/{repo}/tree/{rev}        → sizeBytes + lfs.oid(=SHA-256)
2. GET .../resolve/... Range: bytes=0-8MB   → 解析 GGUF 头（不下载 2.5 GB）
3. kvBytesPerToken = blockCount × headCountKv × (keyLength+valueLength) × 2
4. need = 权重×1.05 + KV(ctx) + 300MB
```

实测输出：

| 模型 | layers | n_kv_head | KV/token | 8K ctx 总需求 | 其中 KV |
|---|---:|---:|---:|---:|---:|
| Qwen3-4B Q4_K_M | 36 | 8 | 147,456 B | **4130 MB** | 1208 MB |
| Qwen3-8B Q4_K_M | 36 | 8 | 147,456 B | **6787 MB** | 1208 MB |
| Gemma-3-4B Q4_K_M | 34 | 4 | 139,264 B | **4055 MB** | 1141 MB |
| Qwen3-1.7B Q8_0 | 28 | 8 | 114,688 B | **3166 MB** | 940 MB |

**KV cache 约 1.2 GB，占 4B 模型总需求的 29%。** 只比较「文件大小 vs 显存」的估算器
（LM Studio 的 beta 估算器官方承认未完全计入 KV 增长）会系统性偏乐观，用户点了就 OOM。

Whisper 用另一套公式：`need = 权重 + 每架构固定开销`（tiny 200 / base 250 / small 380 /
medium 520 / large 820 MB）。**加常数而非乘系数**：whisper 计算缓冲由模型维度决定，
**不随量化缩小**。乘法会把 `large-v3-q5_0`（1081 MB）算成 ~1.2 GB，实际需 ~1.9 GB ——
**对我们主推的量化模型系统性低估**。回代官方 Memory usage 表 5/5 行全部略保守。

⚠️ 存疑：Gemma-3 用滑动窗口注意力，llama.cpp 对 SWA 层只保留窗口内 KV → 实际低于上表。
上表是**上界**，安全但偏保守。折扣比例 `UNKNOWN`。

---

## 10. 清单内容

| 文件 | 条目 | 说明 |
|---|---|---|
| `vendor/manifests/models-whisper.json` | 9 模型 / 11 文件 | turbo(q5_0/q8_0/f16)、v3(q5_0/f16)、medium、small、base、tiny；含 2 个 macOS CoreML encoder（可选） |
| `vendor/manifests/models-llm.json` | 5 模型 | Qwen3 4B(q4_k_m/q5_k_m)、8B(q4_k_m)、1.7B(q8_0)、Gemma-3-4B(q4_k_m) |
| `vendor/manifests/backends.json` | 10 包 | llama.cpp × {win,linux,mac} × {cpu,vulkan,cuda,rocm,metal}；whisper.cpp × {linux-cpu, win-cpu, win-cuda} |

**Qwen 系全部三源**（HF / ModelScope 官方同名 repo / hf-mirror）。
ModelScope 上 `Qwen/Qwen3-4B-GGUF` 与 HF **10/10 文件 size+sha256 逐字节相同**（已实测）
→ 中文用户主线有官方免翻墙源。

**Gemma** 标 `requiresAcceptance: true` + 跳转上游（ADR-004 决策 2：不自建镜像、不再分发受限权重）。

⚠️ **backends.json 的诚实缺口**：whisper.cpp v1.9.1 官方 release **没有 macOS CLI、没有 Vulkan、
没有 ROCm**（R-02 早已核实，我这次拉 release 资产列表再次确认：只有 ubuntu-x64/arm64、Win32/x64、
blas、cublas-11.8/12.4、xcframework）。这三个组合的包**现在不存在**，需 `gpu-runtime` 自建 CI
产出后才能补进清单。**清单里没有就是没有，不放占位条目。**

---

## 11. 遗留与待办

| # | 事项 | 状态 |
|---|---|---|
| 1 | 压缩包解压（zip / tar.gz）+ zip-slip 防护 | ✅ **已实现**（T-022，ADR-011 决策 5）。手写 ZIP/tar 解析器，零新依赖。38 项断言全绿，含真实攻击用例 |
| 2 | catalog Ed25519 验签 | ✅ **已实现但生产未启用** —— 无签名密钥，`OPENMEMO_CATALOG_PUBLIC_KEY = null`，供签名却无密钥时**失败关闭**（抛错，绝不放行） |
| 3 | `estimateGpuLayers` 系数标定 | 未验证，需实测 llama.cpp `-ngl` 行为 |
| 4 | RTF 外推系数 | 未标定，首个真实转写后回写 |
| 5 | whisper.cpp macOS/Vulkan/ROCm 包 | 上游不存在，待自建 CI |
| 6 | SSE 信封扁平 vs D-01 嵌套 | **需 `architect` 裁决**（§4.2） |
| 7 | F1–F5 事件 payload | 由我推导，**需 `architect` 确认**（§4.4） |
| 8 | `vec0` rowid 必须 BigInt | 已知会；`packages/shared` 无 rowid 绑定，不受影响（§12） |

---

## 12. 关于 `vec0` rowid 与 BigInt

`oss-scout` 实测 sqlite-vec 的 `vec0` 虚拟表 rowid 绑 JS `number` 必失败，须用 `BigInt`。

**`packages/shared` 与 `packages/downloader` 不受影响**：这两个包里没有任何 rowid 绑定 ——
双 ID 约定的**整数 PK 侧完全不出 daemon**，我这边只出现对外 ULID（`jobId`）与
目录 slug（`model_installs.model_id`）。绑定发生在 `packages/db`，由该包负责用 BigInt。
我在 `hardware.ts`/`jobs.ts` 中也未使用任何 `number` 型数据库主键。


---

## 13. T-022 增补：解压防护、中文模型策略、速度纳入判定

### 13.1 解压与 Zip-Slip 防护（ADR-011 决策 5）

`packages/downloader/src/unpack.ts` —— 手写 ZIP（EOCD → 中央目录 → 本地头，method 0/8）
与 tar.gz（gunzip + 512 字节头，含 ustar / GNU longname / PAX）解析器。**零新增 npm 依赖。**

拒绝的条目类型（每一条都有攻击用例证明，不是声称）：

| 攻击 | 结果 |
|---|---|
| `../evil.txt` | `PATH_TRAVERSAL`，且 destDir 外**无任何文件产生** |
| `/etc/evil-posix.txt` | `PATH_TRAVERSAL` |
| `C:\evil-windows.txt` | `PATH_TRAVERSAL` |
| `\\server\share\evil.txt`（UNC） | `PATH_TRAVERSAL` |
| tar 中的**真实 symlink 条目** | `SYMLINK_REJECTED`，且**符号链接从未被创建** |
| 50 条目 vs `maxEntries=10` | `LIMIT_EXCEEDED` |
| 200 KB vs `maxTotalBytes=1000` | `LIMIT_EXCEEDED` |
| **头部谎报体积**的 zip bomb | 被 zlib `maxOutputLength` 拦下 |

两道闸门：`assertSafeEntryName()`（快速可读，按 `/` 与 `\` 双分隔符切分，防 Windows 重解释）
+ `path.resolve` 前缀比对（**权威判定**）。执行位按 ZIP external attrs / tar mode 还原
（后端包里有 `llama-server` 这类可执行文件，丢了 +x 就跑不起来），Windows 上跳过 chmod。

**已知限制（诚实记录）**：不支持 ZIP64 —— **检测到即明确报错**，不静默误解析。

`packages/downloader/scripts/verify-unpack.mjs` **38/38 全绿**，fixtures 全部运行时构造
（不提交二进制），ZIP 用手写 writer（本机无 `zip` 命令），tar.gz 用真实 GNU tar。

### 13.2 中文模型策略（ADR-011 决策 1）

catalog 新增 `notRecommendedFor?: string[]`。这**不是能力开关** —— 模型照样能跑，
它记录的是我们**实测**过该语言下输出不可接受。base 在中文上不是"稍差"，是听错词：

> 维基百科 → 危机摆科 · 华尔街日报 → 花耳街日报 · 谷歌 → 古歌
> · 迈克尔杰克逊逝世 → 麦克尔结克训试事

`fitness.ts` 新增 **规则 1b**，置于内存规则**之前**：装得下但把「维基百科」听成「危机摆科」的模型，
按任何有用的定义都不叫"推荐"。

UI（`ModelsPage.tsx`）：界面语言为中文时**默认隐藏**这些变体，并显示
「已隐藏 N 个…（小模型会把「维基百科」听成「危机摆科」）[仍要显示]」。
**必须可一键看回来** —— 静默隐藏会让用户以为产品没有这些模型；
且英文转写时 base 在弱机器上仍是合理选择，一刀切会误伤。

实测验证：

```
lang=zh:  base/small/tiny/medium → notRecommendedForLanguage=true（默认隐藏）
lang=en:  base → tier=recommended, notRecommendedForLanguage=false（恢复可用）
```

### 13.3 速度纳入判定（ADR-011 决策 2）

「装得下」与「用得了」是两个问题。中文必须用 large-v3-turbo，而它在 CPU 上
1 小时录音要跑 22 分钟 —— 只答前者会误导用户。

`FitResult` 新增三个字段：

```ts
speedTier: 'fast' | 'moderate' | 'slow' | 'very_slow' | 'unknown'
speedSource: 'measured_here' | 'reference_machine' | 'none'
notRecommendedForLanguage: boolean
```

阈值按真实测量定：≤6 分钟/小时 fast，≤15 moderate，≤40 slow，其余 very_slow
（base RTF 0.055 → 3.3 分钟 → fast；large-v3-turbo RTF 0.377 → 22.6 分钟 → slow）。
`slow`/`very_slow` 时把耗时**追加进 `reasonZh`**，让"能跑"不会被读成"体验好"。

**新增 `ReferenceBenchmark` 类型**，与 `BenchmarkResult` **刻意分开**，两者永不混淆：

| 类型 | 含义 | UI 措辞 |
|---|---|---|
| `benchmark` | 在**用户机器**上实测 | 「本机实测」 |
| `referenceBenchmark` | 在**我们的参考机**上实测 | 「参考机实测，仅供参考」 |
| 都没有 | — | 「速度未测量」 |

ADR-004 决策 3 禁的是**编造数字**，不是禁**有出处的真实测量**。因此
`ReferenceBenchmark` 的每个字段都是为了让出处可审计：哪台机器、哪个后端、
哪段音频、多长、什么语言、平均置信度。**缺这些的数字才正是我们拒绝的那种。**
且只有 `referenceBackend === selectedBackend` 时才采用 —— CUDA 的数字说明不了 CPU 的表现。
