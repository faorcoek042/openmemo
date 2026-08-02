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

---

## [2026-08-02 16:20] T-022 DONE

交付:
- `apps/web/src/features/models/**`（10 文件）：ModelsPage / ModelDetailPage / StorageSettingsPage
  / api.ts / sse.ts / Models.routes.tsx / index.ts / components{ModelCard,QuantSelector,DownloadRow,StorageBreakdown}
- `apps/web/src/features/runtime/**`（6 文件）：RuntimePage / api.ts / sse.ts / Runtime.routes.tsx
  / index.ts / components{HardwareCard,BackendPackCard}
- `apps/web/src/components/common/{FitBadge,BackendChip,RemediationButton}.tsx`
- `packages/downloader/src/{unpack,signature}.ts` + `scripts/{verify-unpack,reference-server}.mjs`
- `packages/shared/src/{artifacts,models,fitness,schemas}.ts` 增补（ADR-011）
- `vendor/manifests/models-whisper.json` 增补 notRecommendedFor + referenceBenchmark
- `docs/design/D-03-download-and-model-api.md` §13

PROMOTE: features/models/components/FitBadge.tsx → components/common/FitBadge.tsx
PROMOTE: features/runtime/components/BackendChip.tsx → components/common/BackendChip.tsx
PROMOTE: (新建) → components/common/RemediationButton.tsx （models 与 runtime 双方都要）
SHARED-CHANGE: apps/web/src/routes.tsx — 按分片契约追加 modelsRoutes/runtimeRoutes 各一行
SHARED-CHANGE: apps/web/src/lib/events/bindings.ts — 按分片契约追加 modelsSse/runtimeSse 各一行
（两处都是聚合文件预留的注释位，未改其余内容）
⚠️ 未申报的共享改动：无。**未新增 i18n 词条**——我的两个 feature 用内联中文，
   避免改 T-021 的 `locales/*.json`。若 Manager 要求统一走 i18n，我再申报后补。

### 真实链路验证（不是 mock）
`apps/daemon` 目前只有 health/auth/events，**我的 27 个 endpoint 一个都没有**，而 daemon 不归我。
故我在自己领地写了 `packages/downloader/scripts/reference-server.mjs`：**同一份 shared 契约 +
真实下载器 + 真实 vendor/manifests + 真实 fitness 计算器**，并由它托管**真实构建的网页**。

实跑结果（`asr/whisper-base-q5_1`，59,707,625 B，真下）：
```
[1] POST /api/models/pull        → 202 jobId=01KZ0KDT98V0JJS7CP53T94K17
[2] 再点一次                      → deduplicated=true  sameJob=true   （防狂点）
[3] SSE job.created → job.state → sources.probed → job.progress ×N（19/39/59/79/99%）
    → model.activated → model.installed → storage.changed → job.state(succeeded)
    最终 state=succeeded  attempts=1  provider=hf
[4] GET /api/models/installed    → integrity=ok  sha256=422f1ae452ade6f3…
[5] GET /api/models/storage      → used=59.7 MB  Whisper base (Q5_1):60MB(使用中)
[6] GET /api/models/catalog      → installed=true  tier=recommended
[7] DELETE 使用中的模型           → 409 MODEL_IN_USE + remediation（可渲染成按钮）
✅ 完整链路跑通
```
**未自动化的部分（诚实标注）**：本机无浏览器（chromium/firefox/playwright 均无），
因此**没有点击真实 DOM**。已改为验证：① 网页构建产物由 daemon 正常托管（`/models` 返回 200）；
② 我的组件与文案确实在 shipped bundle 里（`模型管理`/`运行时与加速后端`/`models-download-button`
/`fit-badge`/`runtime-hardware-card`/`仍要显示`/`参考机实测`/`兜底后端` 全部命中）。
**没有"点了按钮"的证据，就不说点过。**

### ADR-011 三条已实现并实测
1. `notRecommendedFor` + 中文默认过滤（可一键解除）。实测：
   `lang=zh` → base/small/tiny/medium `notRecommendedForLanguage=true`（默认隐藏）；
   `lang=en` → base 恢复 `tier=recommended`。**改的是默认值不是能力**，与裁决一致。
2. Zip-Slip 防护 **38/38 断言全绿，带真实攻击用例**：`../evil.txt` / POSIX+Windows+UNC 绝对路径
   / tar 真实 symlink 条目 / 条目数上限 / 总字节上限 / **谎报体积的 zip bomb**（被 zlib
   `maxOutputLength` 拦下）。攻击后 destDir 外**零文件产生**、symlink **从未创建**。
   诚实限制：不支持 ZIP64，检测到即报错，不静默误解析。
3. 速度纳入判定：`FitResult` 加 `speedTier`/`speedSource`/`notRecommendedForLanguage`。
   实测 large-v3-turbo-q5_0 → **23 分钟/小时音频**，`speedTier=slow`，追加进 reasonZh。

### 关于"中文表现"数字的处理（你点名的那条标准）
我没有把 ADR-011 的实测 RTF 直接写进 `benchmark`（那个字段的语义是"用户本机实测"）。
新增了**独立类型 `ReferenceBenchmark`**，字段强制带出处：机器/后端/音频名/时长/语言/置信度，
UI 措辞严格区分「本机实测」vs「参考机实测，仅供参考」vs「速度未测量」。
且只在 `referenceBackend === selectedBackend` 时才采用 —— CUDA 的数字说明不了 CPU。
**ADR-004 决策 3 禁的是编造数字，不是禁有出处的真实测量**，这条界线我按此划。
量化选择器里 R-04 §9.2 原稿的 `★★★★☆` 质量星级**已删除**（同样是无出处的数字）。

### 验收门（真实 exit code）
```
tsc (shared+downloader): 0     pnpm --filter web build: 0
eslint (我的全部文件):    0     verify-offline.mjs: 0 (25/25)
verify-unpack.mjs:       0 (38/38)   三份 manifest zod: VALID
```

需要 Manager 决策 / 转达:
1. **`apps/daemon` 需要实现这 27 个 endpoint**。我的 `reference-server.mjs` 是可直接照抄的
   参考实现（真实下载器已接好），建议转给 `oss-scout`，**不要另起炉灶**。
2. **浏览器端到端测试缺环境** —— 无 chromium/playwright。建议进待环境清单；
   在此之前 UI 交互层只能靠构建产物验证，我不会声称点通了。
3. i18n：我的两个 feature 用内联中文（未改 T-021 的 locales）。要统一的话我再补。
4. `/models/benchmark` 端点已在 UI 接好，但参考服务器返回 501（需要真实推理后端）。
   等 `gpu-runtime` 的引擎接上后即可闭环。

自查（诚实规则）:
- 我派的 subagent 报告 eslint 失败，原因是它扫到了**我并发新建的** `reference-server.mjs`
  的未用 import（`ulid`）——不是它的锅。我已修，现在全绿。
- 离线测试 `[3] 续传` 曾报"从零开始"，追查后确认是**测试不真实**（`write()` 后立刻
  `destroy()` 让 undici 零字节交付），非代码缺陷，已在 D-03 §8.6 记录。
- `estimateGpuLayers` 与 RTF 外推系数仍**未标定**，UI 上一律写"估算/约"，未当确定值展示。

---

## [2026-08-02 17:10] T-027 DONE（含 B-1 与契约收编）

### 1. 装浏览器：**成功**
```
pnpm dlx playwright install --with-deps chromium   → EXIT=0
Chrome for Testing 151.0.7922.34 → /root/.cache/ms-playwright/chromium-1234
node -e "chromium.launch()" → browser OK | chromium 151.0.7922.34
```
**不需要向用户要环境。** 你驳回我的建议是对的 —— 我不该在没试过之前就上报缺资源。
已把 `playwright` 加为 `packages/downloader` 的 devDependency（ADR-011 决策 3 授权，此处申报）。

### 2. 真实点击结果：**32 YES / 3 PARTIAL / 5 NO**
脚本 `packages/downloader/scripts/e2e-browser.mjs`（可重复跑）
截图 19 张 + `report.json` → **`docs/design/assets/t027-e2e/`**

**要求 2.2 —— 真实点击已闭环**
```
点「下载 60 MB」→ 进度行出现 → 观察到 100% → job=succeeded
量化选择器展开 3 档 · fit 徽标 9 个 · 磁盘分解含图例与字节标签
中文默认过滤：卡片 2 张 →（点「仍要显示」）→ 6 张   ← ADR-011 真的生效
```
**要求 2.1 —— 页面真实渲染**：硬件卡显示真实 CPU/内存/无 GPU，10 个后端包、16 个状态芯片。

**真浏览器专属检查（4/4 通过）**
- SSE `EventSource` readyState=1，收到 7 条 `job.progress`
- **`onmessage` 陷阱确认避开**：具名帧确实不触发 `onmessage`，逐类型 `addEventListener` 是必须的
- **暗色主题真的生效**：`--surface-0` `#f9f9f7` → `#0d0d0d`（不是 architect 担心的"静默不生效"）
- 无 pageerror

### 3. ⚠️ 我的结论有一部分**已过期**，必须说明
我的 E2E 跑于 **07:36 UTC**，而 `T-032`/`T-034` 在我跑的**同时**合入。
我测的是**旧构建产物**。因此以下 3 条我报的 🔴 **是过期数据，不是当前状态**：

| 我报的 | 真实情况（源码复核） |
|---|---|
| F5 TipTap 编辑器 🔴 | **已实现**：`NoteEditor.tsx` 存在且已接进 `NoteDetailPage.tsx:168` |
| F5 笔记导出 🔴 | **已实现**：`ExportMenu.tsx` + `export.ts` + `export.test.ts`，接在 `:94` |
| F5 标签 UI 🔴 | **已实现**：`TagEditor.tsx` 接在 `:93` |

**我没有重新验证它们能不能点** —— 因为 web 构建当前是红的（见下）。
把过期快照当成当前事实上报，就是这个项目反复出现的"假绿灯"，所以我明确标出来。

**仍然可信的 🔴/PARTIAL（与 T-032/034 无关）**
- **`/tasks` 崩溃**：`Minified React error #185`（= 无限 setState 循环），整页 0 个可交互元素，
  React Router 捕获后显示 "Unexpected Application Error!"。截图 `10-route--tasks.png`。
  ⚠️ 需确认 T-034 的 M-5 是否已修；**我测到的是崩的**。
- 设置页无 API Key 输入框（B-3）—— 但 T-032 声称已关闭，同样可能过期。
- F2 只有 `input[type=file]`，**没有任何拖拽提示文案**（`onDrop` 空函数那条对得上）。

### 4. ⛔ web 构建当前是红的（两个原因，一个是我的）
```
apps/web/src/features/notes/sse.ts(109,23): Property 'startSec' does not exist … Did you mean 'startMs'?
apps/web/src/features/notes/export.test.ts(1,32): Cannot find module 'node:test'
```
- **第 1 条是我造成的**，且是你裁决的 SSE 毫秒统一。**修法是 2 行**（`architect`）：
  `startMs: toMs(e.startSec)` → `startMs: e.startMs`，`endMs: toMs(e.endSec)` → `endMs: e.endMs`，
  然后可以**删掉 `toMs` 整个适配层** —— 这正是这次统一的收益。
- 第 2 条是 `export.test.ts` 缺 `node:test` 类型（web tsconfig 未含 node types），**不是我的文件**。
- **我没有改他们的文件**（所有权）。这两条修完 web 就绿，我可以立刻重跑 E2E 复验第 3 节。

### 5. B-1 模型目录补齐：**已完成，且真下载验证过**
`vendor/manifests/models-asr-support.json` —— 4 个模型，zod VALID：

| id | role | 文件数 | 体积 | 许可 |
|---|---|---|---|---|
| `vad/silero-vad` | vad | 1 | 2.3 MB | MIT |
| `asr/sherpa-streaming-zh-14m` | asr | 4 | 25.4 MB | Apache-2.0 |
| `asr/paraformer-zh-small` | asr | 3 | 81.9 MB | Apache-2.0 |
| `punctuation/ct-transformer-zh-en` | punctuation | 2 | 298.6 MB | Apache-2.0 |

**真实下载 + SHA256 校验实跑通过**（不是只过 schema）：
```
vad/silero-vad (2.3 MB, 1 files) … OK 1 files verified in 5.6s
asr/sherpa-streaming-zh-14m (25.4 MB, 4 files) … OK 4 files verified in 67.7s
  encoder…int8.onnx 21621684 sha256 1c556ea57cec… ✓   （4 个文件逐个校验）
```
**三个关键决定**：
1. **不用 sherpa 的 tar.bz2，改用 HF 上的散文件。** 原因：bzip2 不在 `node:zlib` 里，
   支持它要么引依赖要么手写解码器。改用散文件后**完全不需要解压**，
   而且只取 int8 权重，zh-14M 从 74 MB 降到 **25.4 MB**。是更好的方案，不是将就。
2. **`ModelRole` 扩到 D-02 的 7 值**（`asr/llm/vad/punctuation/diarization/embedding/tts`）。
   VAD 和标点模型**不是 ASR**，塞进 `asr` 会让 VAD 网occupy转写模型槽位。
3. **新增 `capabilityCaveats`**（ADR-013 决策 1），Paraformer 三条代价已写死进目录：
   「无词级时间戳，只有段级」「数字输出为中文而非阿拉伯数字」「英文一律小写」，UI 直接渲染。

**host 白名单实测更正**：GitHub release 资源 302 跳到 **`release-assets.githubusercontent.com`**，
**不是**常被假设的 `objects.githubusercontent.com`。已补进白名单（还补了 `raw.githubusercontent.com`）。

**语言默认值**：`ImportNoteRequest.language` 的注释已写死警告 ——
whisper 无 `-l` 会**静默把中文翻译成英文**，调用方必须显式传值。

### 6. 契约收编：F1/F2/F5 已并入 `packages/shared`
新增 `packages/shared/src/notes.ts` + zod schema。**以 `oss-scout` 的形状为准，逐字收编**：
`POST /api/notes/import` → `{noteUid, jobUid, status}`、`GET /api/notes`、`GET /api/notes/:uid`、
`GET /api/notes/:uid/transcript` → `{transcript, segments[]}`、`DELETE /api/notes/:uid`、
`GET /api/search` → `{query, hits[], modes}`、`GET /media/asset/:uid`。
**公告：以 `shared` 为准。** 我一处都没改他的形状 —— 跑通的实现优先于我的偏好。无 DISPUTE。
时间单位在本文件统一为**整数毫秒**（对齐 D-02 §1.1）。

### 7. SSE 收尾（你排的第 4 项，已一并做完）
- `transcribe.{segment,partial,started}` 全部加 `noteUid` → `architect` 可删映射层
- `transcribe.replaced`、`media.asset.ready` **升为一等事件**（从 `x.` 扩展区转正）
- 时间单位全面改毫秒：`startMs/endMs/durationMs/elapsedMs/sourceStartMs/sourceEndMs`
- 事件总数 28 → **30**

### 8. 我自己代码里的真 bug（真浏览器抓出来的，已修）
**下载完成后模型从列表里消失。** `base-q5_1` 在 zh 下被 `notRecommendedFor` 过滤，
用户刚下完就看不见了 —— 看起来像"下载失败"，而且删不掉、切不了。
修法：**已安装/正在使用的变体永不隐藏**。过滤器是"推荐该装哪个"的机制，
不该剥夺用户对自己已装文件的可见性与控制权。截图 `06-models-installed.png` 是修复前的证据。

### 需要 Manager 决策 / 转达
1. **请 `architect` 改那 2 行**（`features/notes/sse.ts:109-110`）+ 修 `export.test.ts` 的 node 类型，
   web 就绿。修完**我可以立刻重跑 E2E**，把第 3 节的过期结论换成当前事实。
2. **`/tasks` 的 React #185 崩溃**请确认 T-034 是否已修 —— 我测到的版本是崩的。
3. 我的 E2E 脚本已可重复运行，建议进 CI（需要 `reference-server.mjs` + daemon 同时起）。
4. 本轮**未测性能**，按用户指令。

### 自查（诚实规则）
- 最大的一条：**我的部分结论是过期快照**，已在第 3 节逐条标出并用源码复核更正。
  没有把"我跑的时候是这样"包装成"现在就是这样"。
- 第一次 E2E 报"下载进度 0%"，追查后是**我的测试太早 reload**，任务其实 succeeded；
  已改为用 `/api/jobs` 的 job state 判定完成，而不是猜 DOM。
- daemon 在测试中途挂过两次，导致 notes/search/settings 的接口调用显示"上游无法访问"。
  那些 🔴 里**混有环境问题**，我没有把它们算作产品缺陷。
