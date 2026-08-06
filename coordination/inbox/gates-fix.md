# inbox / gates-fix

## [2026-08-07 00:20] T-160 DONE —— 三条闸门 + 两条一行修复

---

# TL;DR（Manager 只读这里）

**四件全做完，外加你中途追加的第 5 件（第四个解析器归一）。死锁解开了，不是绕开。**

| # | 事 | 状态 | 撤掉后变红？ |
|---|---|---|---|
| ① | F3 / Paraformer 被只读不写的环境变量闸死 | ✅ 改成从**已安装模型库**发现；环境变量降级为覆盖 | ✅ 3 条红 |
| ①附 | **新查出**：sherpa 流式与 Paraformer **都带 `tokens.txt`**，互相顶掉 | ✅ 每个模型独占目录 | ✅（同上那 3 条里有一条专钉它） |
| ②-1 | `openmemo-probe` 没有分发通道 | ❌ **没做**（要动 release 资产，边界外）—— 但**接线侧已备好**，包里一有它就能被找到 | — |
| ②-2 | **L2 门禁自指死锁** | ✅ **解开了**。用 `AdvisoryGpu.candidateBackends` 这条**不依赖任何包**的独立证据 | ✅ 2 条变异各 3/1 条红 |
| ②-3 | 安装器写 `by-name/backend`、runtime 读 `bin/runtime` | ✅ probe / ggml 库 / whisper-cli 三处全部改读安装器真正写下的位置 | ✅ 3 条变异各 1 条红 |
| ②附 | **用户亲手复现的那个 409 就是我修的那一行** | ✅ 见 §2.4 | ✅ |
| ③ | F2 上传的笔记永远不能重新转写 | ✅ 一行 + **先证明测试原来看不见这个字段** | ✅ 1 条红 |
| ④ | `/api/health` 的 host 硬编码 | ✅ 报实际绑定地址 | ✅ 1 条红 |
| ⑤ | 「零调用方」门禁的 barrel 盲区 | ✅ 补回丢掉的第三档「只被再导出」：**21 条，其中 16 条连测试都没有** | ✅ 4 条变异全部被自检抓住 |

**基线**：`pnpm -r test` **1159 / 0**（1138 + 21 条新用例）· `tsc -b` 0 · `eslint` 0 ·
`check:sources` ✔ · `check:orphans` ✔（**棘轮基线一个字没动**：72 个，与之前逐字相同）。

**反向验证 8/8**：全部跑在 `/tmp` 的隔离副本上（PROTOCOL §10，形状照抄 `scripts/mutation-check.mjs`：
dist 复制 + `node_modules` 软链 + 假 HOME），**先跑对照组确认未变异的产物全绿**，再逐条撤掉。
脚本留在 `/tmp/gates-fix/reverse-verify.mjs`，可重跑。

**两条我没做、留给你派的**（§5）：Vulkan 补目录（**你已裁定别补，我同意**）、
`/runtime` 对已装 ffmpeg 显示「Install 119 MB」（定位已写到"哪两份记录、谁写谁读"这一级）。

---

# §1 ① F3 与 ADR-013 的中文引擎：判据从"环境变量"换成"模型装没装"

## 1.1 病灶

`apps/daemon/src/pipeline/setup.ts` 原文两处同形：

```ts
const streamDir = env['OPENMEMO_SHERPA_STREAM_DIR'];   // 剥注释后全仓 1 读 0 写
if (streamDir) { … 才构造引擎 … }
const paraDir = env['OPENMEMO_PARAFORMER_DIR'];        // 同上
if (paraDir)  { … 才构造引擎 … }
```

它们旁边的注释自己写着「正式做法是从**模型安装记录**读出来…这里只是过渡」。
**过渡没人回来收，就是永久。**

## 1.2 改法

顺序：**环境变量（覆盖，开发/自检用）> 已安装模型记录 > 不构造 + 说明原因**。

- 新增 `modelStore.listInstalledModelRecords(modelsDir, role)`；
- 判据钉**文件形状**而不是 id / `family`：transducer = `encoder*.onnx + decoder*.onnx +
  joiner*.onnx + tokens.txt`（那正是 `OnlineRecognizer.modelConfig.transducer` 要的东西）。
  用 `family` 当唯一判据会漏掉老记录 —— 契约明写「`family === undefined` = 未知，
  **不得**当成空集过滤掉」；
- 标点模型（`role: punctuation`）同路解析，缺了不阻止引擎启用（但会一个标点都没有）。

## 1.3 「没装时明说未安装」怎么落到界面上

`PipelineBundle` 新增 `unavailableEngines: {id, reasonZh}[]`，`main.ts` 把它**并进**
`/api/health` 的 `pipeline.engines`。

> 为什么必须这么做：`candidates` 只装得下**构造成功**的引擎。模型没装时那个引擎
> 在列表里**根本不出现**，前端只能补一个没有理由、也没有下一步的"未安装"。
> 而真实原因 daemon 是知道的。

**web 一行代码都没改** —— `AsrEngineStatus.tsx` 现成就会渲染 `reason` +「去装运行时」按钮。

实测（隔离夹具，`buildPipeline` 真跑）：

```
没装：streamAvailable=false, streamModelId='none',
      unavailableEngines=[
        {sherpa-onnx, "未安装流式中文模型 —— 去「模型」页装 “sherpa 流式中文 zh-14M” 即可启用录音转文字"},
        {paraformer,  "未安装离线中文模型 —— 去「模型」页装 “Paraformer 中文 small” 即可启用（ADR-013：中文默认引擎）"}]
装上：streamAvailable=true,  streamModelId='streaming-zipformer-zh-14M'
      paraformerAvailable=true, 且 pipelineFor('zh').engineId === 'paraformer'   ← ADR-013 第一次真的生效
```

用例开头**显式断言三个环境变量全程 `undefined`** —— 否则"翻成 true"可能只证明了
"环境变量那条老路还能走"，而那正是要拆掉的东西。

## 1.4 ★ 顺手查出的第二条，此前没人提过：`tokens.txt` 互相顶掉

```
asr/sherpa-streaming-zh-14m  →  tokens.txt  48697 B  sha256 8b294db9…
asr/paraformer-zh-small      →  tokens.txt  75352 B  sha256 4b2d964e…
```

两条都是 `role: asr`，于是**都硬链到 `by-name/asr/tokens.txt`**，而 `linkByName()`
是 `rm(target)` 之后再 `link()` —— **后装的把先装的顶掉，两条安装记录仍然都指着它**。

后果不是"装不上"，是**装上了、跑起来了、词表是别人的**。
ADR-013 的中文默认引擎与 F3 流式引擎**只要同时装，就一定有一个拿着错的词表**。

> 与今天那条「VAD 两个变体差的是引擎不是量化档」同族：**同名不同物，而系统按名字工作。**

**修法**：`materializeModelDir()` 把每条记录摊进 `<modelsDir>/by-model/<id>/<原文件名>`，
锚点用 **blob**（内容寻址，从定义上不可能被同名文件覆盖），硬链、0 额外磁盘、幂等。
不直接把 blob 路径交给引擎的原因：sherpa 按**扩展名**校验（实测报错原文
`Please pass *.onnx ... Given '.../ggml-base.en.bin'`），而 blob 文件名没有扩展名。

用例里**先复现覆盖**（断言 `by-name/asr/tokens.txt` 确实被后装的顶成了 PARAFORMER-TOKENS），
再断言两个引擎各自拿到自己那份 —— 不先证明危险真实存在，后面那两条断言就可能在守一个不存在的东西。

---

# §2 ② 要求 2.1 的三处断点

## 2.1 断点①：`openmemo-probe` 没有分发通道 —— **没做，边界外**

要它进用户机器，必须有一份 release 资产 + 一条 manifest 条目（`providesFiles` 或独立包）。
**「不建/改/删 release」是你给的硬边界**，所以我没碰。

但**接线侧我已经备好了**：包里一旦有 `openmemo-probe`，
`resolveRuntimeLayout()` 现在会从 `by-name/backend/**` 找到它，`backendDir` 自动跟到它的同级目录
（ggml 从二进制自身目录 dlopen，所以必须是同级）。有用例钉住这一格。

**要解开它需要什么**（给接手的人）：CI 已经在 `build-backends.yml:105,227,313` 构建 probe，
只是当 workflow artifact 丢着。缺的是「上传成 release 资产 + 在 `backends.json` 的 CPU 包里
加进 `providesFiles`（或单独一个小包）」。`ci-upload` 那条流水线已经铺好，"给它一份 SHA256SUMS 就能进"。

## 2.2 断点②：L2 门禁自指 —— **解开了**

### 环长什么样

```
cuda 包没装 → 没有 libggml-cuda.so → probe 枚举不到 CUDA 设备
           → backends.cuda.available === false → cuda 包被判"不适用" → 装不了
```

`unavailableReason` 自己把话说出来了：`"backend package not installed"`。
**T-044 那次的环是"没 probe"；ADR-014 让 CPU 包无条件可装、把 probe 带进来了 ——
但那不解这个环**：装了 probe，probe 依然只枚举得到"库已经在盘上"的后端。
所以"装 probe 也解不开"这句判断是对的。

### 出路：仓库里早就有、却一直被丢掉的第二路证据

`packages/runtime/src/detect/gpu.ts` 的 advisory 探测（nvidia-smi / sysfs DRM /
`system_profiler` / DXGI）产出 `AdvisoryGpu.candidateBackends`。
**它不依赖任何包** —— 这正是它能解环的原因：A 不再需要 B。
而它此前只被用来挑"偏好顺序"，`buildHardwareInfo` 把它整个丢掉了。

> 这条与今天反复出现的那一族**正好相反**：别的是"算出来了没人读"，
> 这条是"读了之后被丢掉"，而丢掉它的代价是整条 GPU 加速路径对所有人关闭。

### 新的 L2 规则（`packages/runtime/src/backends/applicability.ts`）

1. probe 确认枚举到可用设备 → 可装（不变，最强证据）；
2. **包没装** 且 advisory 认为本机硬件是它的候选 → 可装
   （"没装"永远不能成为"不该装"的理由 —— 那就是环本身）；
3. 其余 → 不可装，理由沿用 probe 给的那句。

**两条边界，缺一条就是"把闸门拆了"而不是"解开死锁"**：
- 没有匹配硬件仍然拒（否则会把 678 MB 的 CUDA 包推给一台没有 N 卡的机器）；
- **包一旦装上，probe 的裁决重新说了算**（装完之后 probe 已经有机会枚举了，
  它仍说"没有可用设备"就是真结论：驱动太老 / 只有软件渲染器。此时用弱证据推翻强证据是错的）。

规则 2 的安全性还有一条**实测**依据，写在 `manager.ts` 文件头：ggml 在加速包不可用时
**优雅降级**（"our job is not to prevent it; it is to explain it"）。

### 你说的那个受害者，正好落在解开的那一格

`AMD RYZEN AI MAX+ 395 w/ Radeon 8060S` → Linux advisory 走 `/sys/class/drm/card*/device/vendor`
读到 `0x1002` → `candidateBackends: ['vulkan']` → **`whispercpp-vulkan-linux-x64` 变成可装**。
（前提是它进了目录 —— 见 §5.1，你已裁定先别补，我同意。）

### 接线

`detectRuntimeHardware()` 现在跑**一次** `detectGpus()`，同时喂给 `detectHardware()`
（新增可选 `advisory` 入参，避免 macOS 上 `system_profiler` 探两遍）与 `composeHardware()`，
并在 `RuntimeDetection.advisoryBackends` 里回传 → `RestState.advisoryBackends`
→ `backends.ts` 的 `applicability()` 传给 `isPackApplicable()`。

⚠️ `isPackApplicable` 的第 4 个参数是**可选**的（不破坏既有调用方），
但注释写死了：**能传而不传 = 选择了死锁**。用例里有一条专钉这个
（不传 → false，传 → true）。

### 我没有改的一件事，说明一下

`HardwareInfo.gpus` **仍然只装 probe 枚举到的设备**。
契约白纸黑字写着「MUST be populated by actually enumerating devices … never by
file-existence checks」「backends: **as proven by real enumeration**」。
把 advisory 的 GPU 塞进去会更"好看"（用户终于能看见自己的显卡），
但那是**单方面放宽一条别人写下的诚实约束**。要改，请你或 `model-mgmt` 拍板；
我走了显式传参这条路，代价是多一个参数，收益是没有动契约。

## 2.3 断点③：安装器写的目录 ≠ runtime 读的目录 —— 已修

```
安装器落点   <modelsRoot>/by-name/backend/<archive>/…   （backends.json 的包没有 linkInto）
runtime 只搜 <dataDir>/bin/runtime                       （空目录）
```

三处全部改成读安装器真正写下的位置：
- `resolveRuntimeLayout()` 的 **probe**；
- **ggml 后端库**（`backendDir` 在 probe 还没有分发通道时指向真的装了 ggml 库的那个目录，
  这样 `backendDirExists` 与断路器的驱动指纹说的都是实话，而不是恒 false）；
- `runBackendSelfTest()` 的 **whisper-cli**（见下）。

ggml 库的判据是**"ggml 会 dlopen 的那类文件"**（`libggml*.{so,dylib}` / `ggml*.dll`，
允许 `.0.15.1` 这种版本后缀），不是某个写死的名字 —— 写死名字等于每次上游改版都静默失效，
与"写死 `ggml-silero-v6.2.0.bin`"同一个坑。

## 2.4 ★ 用户亲手复现的那个 409，就是我修的那一行

用户点「自测」拿到：

```json
{ "code":"SELF_TEST_BLOCKED", "status":409,
  "details": { "missing":["whisper-cli"],
    "resolved": { "whisperCli": null,
      "model": "/root/data-memo/models/by-name/asr/ggml-base-q5_1.bin",
      "audio": "/root/memo/vendor/whisper.cpp/samples/jfk.wav" } } }
```

**同一台实例上**：`/api/daemon/status` 报 `missing: []`、`/api/selfcheck` 报 `tool.whisperCli ok`
并给出完整路径、文件确实在盘上（976,312 B）。

四个出口，两种答案 —— 因为第 4 个**自己解析、不吃流水线那份答案**，而且只搜 `bin/runtime`：

| # | 出口 | 答案 |
|---|---|---|
| 1 | `discoverTools()` → `findInBackendPacks()` | 找得到 |
| 2 | `/api/selfcheck` 读 bundle | 找得到 |
| 3 | 磁盘 | 在 |
| 4 | `runBackendSelfTest()`（`apps/daemon/src/runtime/setup.ts`，由 `hardware.ts` 的 `/api/backends/selftest` 调用） | **null** |

**按你的判据修的：不是给它补一条搜索路径（那是第五个实现），是让它去问 1 号本人。**
`runtime/setup.ts` 现在 `import { findInBackendPacks } from '@openmemo/pipeline'`，
probe 与 whisper-cli 都走它 —— 两边**不可能**再给出不同答案，因为是同一个函数。
（`bin/runtime` 那一支保留，那是将来 `linkInto` 生效时的正式布局。）

夹具里**真的 `chmod 0755`**：`findInBackendPacks` 用 `access(X_OK)`，安装器也确实会 chmod。
少这一步就会"测试里找不到、产品里找得到" —— 那种夹具比没有更坏。

**注意这只解了 `selfTest` 恒 null 的一半**：自检现在**跑得起来**了，
但 `POST /api/backends/selftest` 的结果**没有写回 `InstalledBackendPack.selfTest`**
（`backends.ts` 里那条 `selfTest: null` 仍是唯一的写入方）。
所以「自检结果」「anyFailed 横幅」三条 UI 分支**仍然不会亮**，直到有人接上回写。
`hardware.ts` 的路由手里没有 store，接回写要跨到 `RestState` —— 那是 `model-mgmt` 地界，我没动。

---

# §3 ③④ 两条一行修复

## 3.1 ③ F2 上传的笔记永远不能重新转写

`apps/daemon/src/http/upload.ts`：`originalUrl: null` → `originalUrl: finalPath`。
修法本来就写在隔壁（`rest/notes.ts` 的本地导入分支为这件事专门修过一次），**upload 没跟上**。

⚠️ **补测试前先证明它原来会绿**：`upload.test.ts` 的假 Recorder 只记
`{noteId, kind, title}` —— `originalUrl` **根本不在里面**，那条 `assert.deepEqual(rec.sources, …)`
**不管产品往里写什么都是绿的**（`grep originalUrl upload.test.ts` = 空集，与 `progress-audit` 一致）。
现在字段进了 Recorder，并加了两条断言：
①`originalUrl === join(dir, storedAs)`；②**它必须等于喂给 job 的那个 `input`** ——
两者一旦分叉，重跑读到的就不是第一次转写的那个文件。

> 判据：**一个断言看不见的字段，等于没有断言。**

## 3.2 ④ `/api/health` 的 host 硬编码

`ServerDeps` 新增 `host: () => string`（与 `port` 同理必须是函数：地址在绑定成功后才由
`server.address()` 确定，而 handler 必须更早挂好）。`main.ts` 用新的
`boundAddress(server)`（`bootstrap/single-instance.ts`）取内核实际给的地址，`BIND_HOST` 兜底。
`runtime.json` 的 `host` 也改成同一个来源 —— 两条路径都会喂给 `AlreadyRunningError` 的提示 URL。

**live 实测坐实了它是错的**（只读观测，未重启）：

```
ss -ltnp → LISTEN 0.0.0.0:10000  users:(("MainThread",pid=3551644,…))
GET /api/health → "host": "127.0.0.1"
```

用例打在 `attachHttpHandlers` 上（`host: () => '0.0.0.0'` 的 deps），
**不**为了测试真去绑非回环地址（`0.0.0.0` 在 CI 上等于开一个对外口；`127.0.0.2` 在 macOS 上默认不存在）
——"为了测试去动机器状态"是 §9-bis 那条判据要挡的东西。
顺带钉住 health 不泄露 token。

---

# §4 ⑤「零调用方」门禁的 barrel 盲区 —— 补回丢掉的第三档

## 4.1 判据钉的是**语句**，不是文件名

原型说的是"只有 index 再导出"，但"叫不叫 `index.ts`"是命名约定、不是事实。
现在的做法：把每个文件里的 `export … from '…'` / `export * from '…'` **整段挖掉**再数一次命中。
命中归零 = 这个文件对它的引用**只是一次转发**。改名 barrel 也骗不过它。

## 4.2 与棘轮**定义上不相交**，所以基线一个字没动

`orphans` 仍按「含再导出在内的 `prod === 0`」算；新档要求 `prod > 0 && prodReal === 0`。
`check:orphans` 实测仍是 `72 个（基线 72 个）` ✔。**只打印不判红**（21 条一次性判红会逼人灌水）。

## 4.3 扫出来的

```
只被再导出、零真实产品调用方：21 个，其中 16 个连测试都没有
     apps/web/src/features/folders/api.ts :: useMoveNoteMutation      (test=2)   ← 笔记移动到文件夹
   ⚠ apps/web/src/features/folders/api.ts :: useRenameFolderMutation  (test=0)   ← 文件夹改名
   ⚠ packages/pipeline/src/asr/postprocess.ts :: postprocessChinese / hasChineseNumerals
   ⚠ packages/pipeline/src/asr/whisperServer.ts :: WhisperServerEngine
   ⚠ packages/pipeline/src/benchmark/runBenchmark.ts :: runBenchmark / formatBenchmark / toBenchmarkResult
   ⚠ packages/pipeline/src/media/sources/rss.ts :: looksLikeFeed
   ⚠ packages/runtime/src/backends/manager.ts :: isAbiCompatible
   ⚠ packages/runtime/src/selfcheck.ts :: extensionFileName
   …（完整清单跑一次 `pnpm check:orphans` 即可）
```

**与 `progress-audit` 报的 28 有出入，我说清口径**：我要求**产品代码里的每一次命中都发生在
再导出语句里**。一个名字只要在任何非 barrel 的产品文件里出现过一次（哪怕是同名局部变量），
就掉出这一档。所以我的 21 是**更保守的子集**，不是"少查了 7 个"。要对齐到 28 得放松成
"只看 index.ts 是否是唯一引用方"，那会引入假阳性。**两个数都没错，是两把尺子。**

## 4.4 探针的探针（这条比上面都重要）

反向验证时我自己踩了一次：第一版自检**复述**了一遍分档规则，于是
"把分档那个 `else if` 整段删掉"这条变异**照样全绿** —— 复述出来的对照组只能证明复述自己是对的。
现在把 `scan()` 拆成 `classify(bodies)` + `scan()`，自检拿**写死的样本**跑 `classify()` 本身。

4 条变异，**全部被自检当场抓住（exit 1）**：

| 变异 | 结果 |
|---|---|
| `bodiesNoReexport.set(f, body)`（算对了、存错了） | ✔ 红 |
| 再导出正则打瞎 | ✔ 红 |
| 分档那个 `else if` 整段删掉 | ✔ 红 |
| `real` 又按未挖空的 body 算 | ✔ 红 |

阳性对照**刻意用写死的样本，不用仓库里的真实条目** —— 真实条目随时会被人接上
（那正是我们想要的结果），到那天自检会红在一件好事上，然后被顺手删掉。
**阳性对照必须是不会腐烂的。**

---

# §5 需要 Manager 决策 / 已派给别人的

## 5.1 `whispercpp-vulkan-linux-x64` 补不补进 `backends.json` —— **你已裁定别补，我同意**

门禁这一侧我已经解开（§2.2），所以现在**只剩包本身的两条阻碍**：
不自包含（依赖另一个包目录里的 ggml-base）、`GLIBC_2.38`。
在这两条消掉之前补进目录，是把"看不见"换成"**看得见点不动**"——那更糟。
你说另派一路做包，我不扛。**接手的人只要把包修好、补一条 manifest 条目，
用户那块 8060S 就能装上了 —— 门禁不会再挡。**

## 5.2 `/runtime` 对已装的 ffmpeg 显示「Install 119 MB」—— 定位到"哪两份记录、谁写谁读"

**全仓有两个互不相干的"已安装"概念**：

| | 判据 | 谁读 |
|---|---|---|
| A **盘上真的有文件** | `findInBackendPacks(storeRoot, name)` 扫 `by-name/backend/**` | `discoverTools()` → `pipeline.tools` → `/api/daemon/status` 的 `missing`；`/api/selfcheck` 的 `tool.ffmpeg` |
| B **有一份安装 manifest** | `manifests/backend/<id>.json` 存在 | `RestState.listInstalledBackends()` → `/api/backends/catalog` 的 `installed` → `/runtime` 页的按钮；`readInstalledVersions()`（`packages/downloader/src/components.ts:62`）→ `/api/components` 的 `installedVersion` |

**B 的写入方全仓只有一处**：`apps/daemon/src/http/rest/backends.ts` 的 `startPackInstall()`
里那句 `await state.store.writeManifest('backend', pack.id, record)`。

于是任何**不经过这条路**落到盘上的文件，都会出现"A 说有、B 说没有"：
冷启动脚本 / 手工解包 / 旧版本的安装流程 / **或者安装中途崩在 `writeManifest` 之前**
（安装器刻意是"blob 先落、manifest 最后写"，这个中间态按设计就会发生）。
`media-tools-linux-x64` 在 `backends.json` 与 `components.json` 里**id 逐字相同**，
所以不是 id 对不上，是**那台机器上没有 B**。

**给接手的人的判据**（沿用你说的那条）：同一台机器上，「装没装」只准有一个回答的人。
两条路可选，我倾向两条都做：
1. `startPackInstall()` 是唯一写入方 → 启动时补一次**对账**：`providesFiles` 全部能被
   `findInBackendPacks()` 找到、却没有 manifest 的包，回填一份记录（与 `migrateInstallRecords` 同族）；
2. `/api/backends/catalog` 的 `installed` 改成「有 manifest **或** `providesFiles` 全部可发现」。

只做 2 会让"已装"变成一个每次现算的量；只做 1 会漏掉将来再出现的中间态。
**先例可抄**：`canonicalAssetRelPath` 就是"读取侧和写入侧各归一过一次"。

## 5.3 `POST /api/backends/selftest` 的结果没有回写（`selfTest` 恒 null 的另一半）

见 §2.4 末尾。自检现在跑得起来了，但结果到不了 `InstalledBackendPack.selfTest`，
三条 UI 分支仍然不亮。要接需要跨到 `RestState`（拿 store + 知道是哪个 pack），是 `model-mgmt` 地界。

## 5.4 `PENDING-USER-DECISIONS.md §D` 需要订正

它把 ADR-013「中文默认 = Paraformer」列为"已拍板生效"。
**在今天之前它一次都没生效过**（`engine_id` 一直是 `whisper.cpp`）。
现在代码通了，但**要等一次重建 + 重启，而且用户得先装 Paraformer 模型**。
建议把那条改成「已实现，未默认安装」。这份文件只有你能写。

---

# §6 反向验证（8/8，全部在 /tmp 隔离副本）

对照组先跑：5 组测试文件在**未变异**的产物上全绿 —— 不先证明这一点，
下面每一条"红"都不证明任何事（变异测试最容易出的假绿就是"产物本来就是坏的"）。

| 撤掉什么 | 结果 | 红在哪 |
|---|---|---|
| `listInstalledModelRecords` 恒返回 `[]`（回到只认环境变量） | ✔ exit 1 | 3 条：流式翻 true / Paraformer 可用 / tokens 不串 |
| L2 解环分支（`installed !== true && advisory.includes`） | ✔ exit 1 | 3 条：解环 / 不许放水 / `isPackApplicable` 传参 |
| L2「probe 从未跑过 + 有独立证据」那一支 | ✔ exit 1 | 1 条 |
| 从安装器落点找 ggml 库 | ✔ exit 1 | `backendDirExists` 回到恒 false |
| probe 问 `findInBackendPacks()` | ✔ exit 1 | probe 永远 missing |
| 自检问 `findInBackendPacks()` | ✔ exit 1 | 回到用户那个 `409 missing:["whisper-cli"]` |
| `originalUrl: finalPath` → `null` | ✔ exit 1 | 上传成功路径那条 |
| `host: deps.host()` → `'127.0.0.1'` | ✔ exit 1 | health host 那条 |

外加门禁脚本 4 条变异（§4.4），全部被自检抓住。

---

# §7 交付文件（**请 `git add` 后用 `git diff --cached --name-only` 逐条核对**）

改：
```
apps/daemon/src/bootstrap/single-instance.ts     boundAddress()
apps/daemon/src/http/server.ts                   ServerDeps.host + health 用它
apps/daemon/src/main.ts                          boundHost 接线 + engines 并入 unavailableEngines
apps/daemon/src/http/upload.ts                   originalUrl: finalPath
apps/daemon/src/http/upload.test.ts              Recorder 记 originalUrl + 两条断言
apps/daemon/src/pipeline/modelStore.ts           listInstalledModelRecords / materializeModelDir
apps/daemon/src/pipeline/setup.ts                两道闸门换成模型发现 + unavailableEngines
apps/daemon/src/runtime/setup.ts                 布局解析归一到 findInBackendPacks + advisoryBackends
apps/daemon/src/http/rest/hardware.ts            detectLocalHardware 回传整份 RuntimeDetection
apps/daemon/src/http/rest/state.ts               RestState.advisoryBackends
apps/daemon/src/http/rest/backends.ts            把 advisoryBackends 传给 isPackApplicable
packages/runtime/src/backends/applicability.ts   解环规则 + 两条边界
packages/runtime/src/index.ts                    DetectHardwareOptions.advisory（避免探两遍）
scripts/check-orphan-exports.mjs                 第三档「只被再导出」+ classify() 拆分 + 自检
```

新增：
```
apps/daemon/src/pipeline/chineseEngineResolve.test.ts   5 条
apps/daemon/src/runtime/layoutResolve.test.ts           5 条
apps/daemon/src/http/healthHost.test.ts                 3 条
packages/runtime/src/backends/applicability.test.ts     8 条
```

**未 commit、未 push**（没接到指令）。要我提交就说一声。

---

# §8 纪律申报

| 条 | 结果 |
|---|---|
| `apps/web/dist` | ✅ **未构建**。全程只跑 `pnpm build:safe`（`pnpm --filter "!@openmemo/web" -r build`）与 `tsc -b`。⚠️ 开工时它的 mtime 是 `22:58:25`，与 daemon 的 `builtAt=14:58:25Z` 逐秒相同 —— **那是你重启前的那次构建，不是我**（我第一条命令晚于它） |
| `pnpm -r build` / `vite build` | ✅ 未跑 |
| `apps/daemon/dist` | ⚠️ **重建了**（`pnpm build:safe`，`pnpm check` 自己就跑这条）。核过：daemon dist 里**没有任何对本地模块的动态 `import()`**，所以正在跑的进程不会半新半旧 |
| `:10000` | ✅ **只发过 GET**（`/api/health`）。未重启、未 kill、未占用；另用 `ss -ltnp` 只读观测过监听地址 |
| `/root/data-memo` | ✅ **未读未写**（只通过 daemon 的只读 API 与 `ss` 观测） |
| 指针文件 | ✅ sha256 仍是 `7f930979b85204d4c05b221f4c17a5cf5936a4d432a46488816727f60da233f3` |
| `pkill -f` | ✅ 未用 |
| release | ✅ 未建/未改/未删。`gh` 一次都没用 |
| 本机 whisper 转写 | ✅ **一次都没跑**。①的验证走的是"装上模型后 `streamAvailable` 翻转"，没有真跑推理；layout 那条用例里**刻意让 ASR 模型缺席**，保证它只能 `blocked`、不可能真跑 |
| 反向验证 | ✅ 全部在 `/tmp/gates-fix/` 与 `mkdtemp` 沙箱里，**共享工作树全程没有坏过一秒** |
| `HANDOFF.md` / `00-CHARTER.md` / `BOARD.md` / `ROSTER.md` / `docs/adr/**` / `PENDING-USER-DECISIONS.md` | ✅ 只读引用，一个字未改（要改的写进 §5 交给你） |
| `README.md` / `docs/DEPLOYMENT.md` / `SECURITY.md` | ✅ 未碰 |
| 派出的 subagent | 0 个 |
