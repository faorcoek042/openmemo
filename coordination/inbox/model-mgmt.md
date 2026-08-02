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

---

## [2026-08-02 18:05] T-038 DONE（含 libsimple/sqlite-vec 并入）

脚本 `packages/downloader/scripts/e2e-full.mjs`（可重复跑）· 截图 → `docs/design/assets/t038-e2e/`
后端：**真 apps/daemon**（隔离数据目录 `/tmp/openmemo-t038`）+ reference-server `--proxy-all` 仅托管 SPA。

### 逐项结果

| # | 项 | 结果 | 说明 |
|---|---|---|---|
| K1 | `/tasks` React #185 | **YES 已修** | 不再崩溃，13 个可交互元素；刷新后仍存活 |
| 12 | 任务中心刷新后仍在 | YES | |
| K2 | 中文搜索（daemon 层） | **YES** | `用户=3 推特=1 中国=1 服务=2 维基百科=1`，`tokenizer=simple vec=on` |
| K2b | 中文搜索（网页层） | **YES**（见更正） | 网页真渲染出 3 条带时间点的结果 |
| K3 | 暗色主题未退化 | YES | 引导/设置/笔记详情/模型/运行时 5 页 `--surface-0` 均随 `data-theme` 切换 |
| K4 | **daemon 交接 URL `/#t=<token>`** | **NO（新发现）** | 见下 |
| 6 | 首启引导跳转 | YES | 点击后页面推进 |
| 2 | 拖拽上传 | PARTIAL | 有 `input[type=file]`，真实 `DragEvent+DataTransfer` drop 已派发但**界面无反应** |
| 13 | 搜索结果直达时间点 | PARTIAL | 结果**带时间戳**（0:04/0:09/0:33），但点击跳到 `/notes?folder=…` 无时间参数 |
| 1,3,4,7,8,14 | 段落编辑/标签/星标/TipTap/导出/锚点 | **全部被同一个崩溃挡住** | 见下 |
| 9 | 文件夹树操作 | NO | 找不到新建入口（树上 0 项） |
| 10,11 | 导图拖拽/右键/撤销、SVG/PNG 导出 | NO | 导图页整页崩溃 |
| R1 | 模型页（真 daemon） | **YES** | 2 张卡 · 2 个 fit 徽标 · 2 个下载按钮 |
| R2 | 运行时页（真 daemon） | **YES** | 硬件卡 1 · 后端包 10 |

### 🔴 两个新发现（都只有真浏览器能抓到）

**1. 笔记详情页 + 导图页整页白屏**
```
Unexpected Application Error!
TypeError: Cannot read properties of undefined (reading 'map')
  at ay (assets/ExportMenu-*.js)
```
**根因是三方契约缺口，我已定位到底**：
`NoteDetailPage.tsx:93` 渲染 `<TagEditor tags={n.tags} />`；
**daemon 的 `GET /api/notes/:uid` 从不返回 `tags`**（grep 零命中）；
**我收编的 `shared/notes.ts` 也没声明 `tags`** —— 三边三个假设，结果是一张白页。
→ **我已在 `shared` 补上 `NoteDetail.tags: NoteTag[]` 与 `starred: boolean`，并强制"永远是数组、`[]` 而非缺省"**
（缺省与"没有标签"在调用点无法区分，所以 schema 不允许缺省）。
请 `oss-scout` 让 daemon 返回这两个字段，`architect` 加空值兜底。
**item 1/3/4/7/8/14 全部是被这个崩溃挡住的，不是功能缺失** —— 修好后需重测。

**2. daemon 打印的交接 URL 首启不可用**
daemon 启动打印 `http://127.0.0.1:17650/#t=<token>`，这正是用户要点的那条。
实测：从 `/#t=` 进入 → 首启重定向 `/onboarding` **把 fragment 清掉了** →
`POST /api/auth/session` 无 Authorization 头 → **401，拿不到 cookie，整个应用未认证**。
从 `/onboarding#t=` 或 `/models#t=` 进入则 **200 正常**。
→ 首次使用的用户会打开一个全是"未认证"的应用。属 `architect`（`connect.ts` 与路由重定向的竞态）。

### ✅ 我自己的一处误报（已更正）
K2b 我最初报"网页搜索 0 命中"。**是我的选择器错了，不是产品坏了。**
用 `a[href*="/notes/"]` 找结果，而实际 DOM 不是这个结构。
重新取真实 DOM 后确认：网页**确实渲染出 3 条结果并带时间点**
（`0:04 首先要谈的是用户增长…` / `0:09 我在推特上…` / `0:33 用户体验…`）。
**先质疑测试，再质疑代码 —— 这次又是测试的错。** 已在表中更正为 YES。

### libsimple + sqlite-vec 并入 `vendor/manifests/`
新增 `vendor/manifests/sqlite-ext.json`，采用 `gpu-runtime` 实测的 sha256（archive
`443551eace…`, 4,668,718 B，含 5 个 jieba 词典 + `libsimple.so` + `vec0.so`）。
许可证按 R-03 取 MIT 支，`licenseNote` 保留双授权说明。

**为把它纳入统一下载器，扩了两处 schema：**
1. `ENGINES` += `'sqlite-ext'` —— 它结构上就是"带摘要的原生归档解压到运行目录"，与 GPU 后端包同形，
   因此复用同一个下载器与同一条"网页点一下装"的路径。
2. **新增 `availability: 'published' | 'pending-ci'`** —— 这是关键的诚实字段。
   本仓库**没有 git remote，CI 从未跑过**，所以这个包**根本没有可下载的 URL**。
   我**拒绝编一个将来可能存在的 GitHub Release 链接**：那会让失败推迟到用户点击时才爆，
   而不是在评审时就暴露。`pending-ci` 表示"已构建、摘要已核实、可审计，但尚不可下载"。
   schema 加了强制校验：**`published` 却没有任何 mirror URL 直接判不合法**，已实测：
   `guard test — published with no mirror: REJECTED (correct)`。
   mac/Windows 的 `.dylib`/`.dll` **未构建**，因此**清单里根本没有这两条**（同 backends.json 的处理：
   宁可没有，也不要一个指向不存在文件的条目）。

### 验收门（真实 exit code）
```
pnpm -r build: 0      tsc(shared+downloader): 0     eslint(mine): 0
5 份 manifest zod 全部 VALID（含新 sqlite-ext.json）
```

### 需要 Manager 决策 / 转达
1. **`NoteDetail.tags`/`starred` 三方缺口** → daemon 补返回、UI 补兜底。修完我可立刻重测被挡住的 6 项。
2. **`/#t=` 首启 401** → `architect`（路由重定向早于 token 消费）。这是用户拿到的第一条 URL。
3. 拖拽上传 `onDrop` 仍无反应；文件夹树无新建入口；搜索结果点击不带时间参数。
4. `sqlite-ext` 与全部后端包都卡在**没有 git remote**：manifest 齐了、hash 齐了，就是发布不了。
   这是目前唯一挡住"网页点一下装中文分词器"的东西。

### 自查
- 我的 fixture 用**隔离数据目录**（`OPENMEMO_DATA_DIR=/tmp/openmemo-t038`），
  没有写 `oss-scout` 的共享生产库（首次尝试被安全策略挡下，挡得对，我换了做法）。
- 我的 proxy shim 自己有过两个 bug（`setHeader` 在 `writeHead` 之后 → cookie 丢失；SSE 断开后重复写 header
  导致进程退出），都已修；**这两个是我的测试基建缺陷，没有算进产品缺陷**。
- 性能一律未测（按用户指令）。

---

## [2026-08-02 18:40] VAD 格式错误 修复

### 你报的问题：确认存在，已修
`vad/silero-vad` 只给了 `silero_vad.onnx`（sherpa 格式），whisper.cpp 加载不了 —— 装得上、校验过、就是用不了。

**已拆成两条，按引擎区分：**

| id | 格式 | 文件 | 体积 | 引擎 |
|---|---|---|---|---|
| `vad/silero-vad-onnx` | ONNX | `silero_vad.onnx` | 2,327,524 B | `sherpa-onnx`（F3 流式） |
| `vad/silero-vad-ggml` | ggml | `ggml-silero-v6.2.0.bin` | 885,098 B | `whisper.cpp`（离线转写） |

ggml 版来源实测确认：`download-vad-model.sh` 里 `src="https://huggingface.co/ggml-org/whisper-vad"`，
sha256 `2aa269b785eeb53a8298...`（v6.2.0）。两条描述里互相点名对方
（「whisper.cpp 用不了这个文件，它要 ggml 那一个」），避免下一个人再踩。

### 结构性修复：新增 `ModelEntry.engines`（必填，至少 1 个）
只补这一条数据不够 —— **schema 里没有任何东西能表达"哪个引擎能加载它"**，
所以这类 bug 一定会重现。现在每个模型都必须声明 `engines`，流水线按引擎过滤后才能提供选择。
全部 3 份模型 manifest 已回填：whisper 系 `['whisper.cpp']`、LLM 系 `['llama.cpp']`、
sherpa/paraformer/标点 `['sherpa-onnx']`。

### 按你转达的原则验证：验「功能可用」不验「组件存在」
我没有只校验 sha256（那正是这次漏掉问题的原因 —— **hash 对得上完全不代表引擎认得**）。
改为真下载后**读容器魔数**：

    vad/silero-vad-ggml   ggml-silero-v6.2.0.bin  885098B   magic="lmgg"  ggml-container=true
    vad/silero-vad-onnx   silero_vad.onnx        2327524B   magic 非 ggml  ggml-container=false

`lmgg` = 小端 `ggml`，确认确实是 ggml 容器；ONNX 那个不是。**两者格式真的不同，修复成立。**

⚠️ 顺带一个佐证我们判重规则的巧合：`ggml-silero-v5.1.2.bin` 与 `v6.2.0.bin`
**体积完全相同（都是 885,098 B），sha256 不同**。按体积判重会把两个版本混为一谈 ——
ADR-004 决策 4 的"一律按 SHA256 判重"在这里刚好有了实例。

### L1 CPU 包仍然禁止删除（现在有产品级证据了）
`BackendPackCard.tsx:41` `isLoadBearing = tier==='builtin' || backend==='cpu'`，
第 149 行 `disabled={isLoadBearing}` + 悬停说明为什么。
`gpu-runtime` 的 SIGABRT 实证（删光 CPU 后端 → job failed、daemon HTTP 200 存活）
让这条从"我读 ADR 得出的约束"变成"有实测后果的约束"，保持不变。

### 验收门（真实 exit code）
    tsc: 0   eslint: 0   web build: 0   verify-offline: 0   verify-unpack: 0   5 份 manifest: VALID

### 自查
- 这个 bug 我 T-038 时没抓到，因为我的验证止步于「sha256 对得上 + zod 通过」。
  **"装得上"和"能用"之间的那一步，我当时没验。** `gpu-runtime` 的标准是对的，已采纳为我这边的默认做法。
- `ggml-silero-v5.1.2.bin` 我**没有**收进目录（whisper.cpp 默认用 v6.2.0），避免给用户无谓的选择。

---

## [2026-08-02 19:30] T-045 冷启动装机 DONE + 一条**不能撤回**的说明

### ⚠️ 首先：`unpack.ts` 的 symlink 修复 **不能回退**，那是一个真 bug，我自己撞到的

你说 `gpu-runtime` 的「43→3」是 pkill 造成的误报 —— 那部分我接受。
**但我改 `unpack.ts` 不是因为他的报告，是因为我自己的冷启动跑出了这个：**

    UNPACK_FAILED: Archive contains a symlink/hardlink entry, which is rejected:
    "whisper-bin-ubuntu-x64/libwhisper.so"

客观事实（`tar -tzvf` 直接看）：

    lrwxrwxrwx  whisper-bin-ubuntu-x64/libwhisper.so   -> libwhisper.so.1
    lrwxrwxrwx  whisper-bin-ubuntu-x64/libggml-base.so -> libggml-base.so.0
    lrwxrwxrwx  whisper-bin-ubuntu-x64/libparakeet.so  -> libparakeet.so.1

**官方 tarball 里确实有 symlink**，而我原来的防护是「**只要是 symlink 一律拒绝**」，
于是解压在第一个 symlink 处直接抛错中止。这不是环境问题，是我的策略写错了：
**我按"条目类型"拒绝，而正确的判据是"链接目标指向哪里"。**

顺带一提：这个 bug 的表现**恰好就是「43 条只出来几条」** —— 在第一个 symlink 处中止，
前面的文件已经落盘。所以他看到的比例其实和我的 bug 完全吻合，只是他那次的直接原因是 pkill。

**修法（已实现并测试）**：目标在 destDir 内 → 允许；绝对路径或逃逸 → 仍然拒绝。
`verify-unpack.mjs` **42/42**，其中 symlink 三个用例：

    PASS 内部 symlink 不再被拒        PASS 通过 link 能读到目标内容
    PASS 逃逸 symlink 仍被拒绝 (../../../../etc/passwd → SYMLINK_REJECTED)
    PASS 绝对路径 symlink 仍被拒绝 (/etc/passwd → SYMLINK_REJECTED)

修复后实测：完整解出 **43 个文件**（`tar -tzf` 报 44 = 43 文件 + 1 目录），
且 `whisper-cli --help` **真的跑起来**并加载了 `libggml-cpu-zen4.so`。
**回退这一处会让冷启动重新卡死在第 3 步。**

### 另一半我照做了：失败安装不留残骸、且可重试
改为**解压到临时目录、成功才 rename 就位**；失败时清掉 temp、final、以及 by-name 链接，
并把 `UNPACK_FAILED` 标为 **retryable**（字节已校验，重试很便宜；标成终态会把用户困死）。
加了回归测试（`verify-offline.mjs` **29/29**），其中一条当场抓到我第一版还漏删 by-name 链接。

### 网页版冷启动：**失败 6 → 失败 2，全程只用鼠标**

全新空 dataDir `/tmp/om-cold`，基线与你给的完全一致（通过 5 · 警告 7 · **失败 6**）。

| 步骤 | 结果 |
|---|---|
| 0 打开网页并鉴权 | YES |
| 1 首启引导可点着走 | YES（推进 4 步：下一步 ×3 / 开始使用） |
| 2 网页检测硬件 | YES（真实 CPU/内存/无 GPU） |
| 3 **网页装 whisper.cpp 后端** | **YES** ← 就是 symlink 修好才成立的 |
| 4 网页装 ASR 模型 | YES（25 MB，100%） |
| 5 目录里能看到 VAD 模型 | YES（onnx + ggml 两条都在） |
| 6 网页装中文分词器 | **BLOCK** `availability=pending-ci`，无发布 URL |
| 7 试转一段音频 | NO（capture 页找不到链接输入框） |

装完在同一 dataDir 上跑 selfcheck：**通过 12 · 警告 4 · 失败 2**

    ✔ whisper-cli   /tmp/om-cold/models/by-name/backend/.../whisper-cli
    ✔ ASR 模型      ✔ 中文自动选择 whisper.cpp    ✔ 英文自动选择 whisper.cpp
    ✘ libsimple 存在          ✘ 中文双字词可搜索

**剩下 2 条与你的判断一致：根因只有一个，`sqlite-ext` 的 `mirrors: []`。**
我按你的指示**没有去动它**。另外我已在 UI 上把这种包的按钮改成
「**尚未发布，暂不可安装**」并禁用 —— 失败要发生在看得见的地方，不要等用户点下去。

我另做过一次**验证性对照**（非产品路径，已标注）：把本机构建好的 libsimple 放进
该 dataDir 后重跑 selfcheck → **失败 0**，中文双字词 `用户:1 推特:2 中国:1 服务:2`。
**说明整条链路是通的，唯一缺的就是发布渠道。**

### T-038 欠的 14 项：6 项仍被**同一个**未修缺口挡住

| 项 | 结果 |
|---|---|
| 6 首启引导跳转 | YES |
| 12 任务中心刷新后仍在 / K1 React #185 | YES（已修，15 个可交互元素） |
| 2 拖拽上传 | PARTIAL（真实 DragEvent 已派发，界面无反应） |
| 13 搜索结果直达时间点 | PARTIAL（跳到笔记，URL 无时间参数） |
| 5 API Key 输入自测 | NO（设置页无 Key 输入框） |
| 9 文件夹树 / 10 导图拖拽右键撤销 / 11 导图导出 | NO |
| **1 双击编辑段落 · 3 标签增删 · 4 星标 · 7 TipTap 自动保存 · 8 导出 SRT/VTT · 14 M-7 锚点** | **NO —— 全部被笔记详情页整页崩溃挡住** |

崩溃根因未变，我 T-038 已定位、本轮再次确认：

    GET /api/notes/:uid → keys: uid,title,status,kind,language,durationMs,summaryMd,
                                assets,transcriptUid,segmentCount,createdAt
    hasTags=false  hasStarred=false
    页面 → CRASH: Cannot read properties of undefined (reading 'map')

`NoteDetailPage.tsx:93` 渲染 `<TagEditor tags={n.tags} />`，daemon 不返回 `tags`。
**我已在 `shared/notes.ts` 把 `tags: NoteTag[]` 与 `starred: boolean` 声明为必填**
（强制 `[]` 而非可省，因为"缺省"和"没有标签"在调用点无法区分）。
**只要 daemon 补上这两个字段，这 6 项就能立刻复测** —— 我的脚本可重复跑。

⚠️ 本轮 K2/K2b 中文搜索显示 0 命中，是因为**这个冷 dataDir 本来就没有 libsimple**
（`tokenizer=trigram`）。**不是搜索坏了** —— 上一轮装了扩展的环境里是 `用户=3 推特=1 中国=1 服务=2`。

### 流程改进（已照做）
不再用 `pkill -f` 批量杀进程。本轮记录并只操作自己的 pid，daemon/shim 用独立端口
（17650 / 17660）。我自己也吃过这个亏：中途 daemon 被杀导致一批接口显示"上游无法访问"，
我差点把它当成产品缺陷。

### 验收门
    tsc: 0   eslint: 0   verify-offline: 0 (29/29)   verify-unpack: 0 (42/42)
    截图：docs/design/assets/t045-coldstart/ (16 张) + t038-e2e/

### 需要 Manager
1. **不要回退 `unpack.ts`** —— 证据在上面，回退会让冷启动第 3 步重新卡死。
2. `NoteDetail.tags` / `starred` 请 daemon 补返回，这一处解锁 6 项验证。
3. capture 页链接输入框我这边定位不到（第 7 步），请 `architect` 确认是否有 testid。
