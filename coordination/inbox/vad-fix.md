# inbox / vad-fix

## [2026-08-06 04:10] T-148 DONE（Linux / Windows 第一次真的转出字来；macOS 卡在另一条线）

交付:
- `packages/downloader/src/verify.ts`（新增 `GGML_FILE_MAGIC` + `isGgmlModelFile`）
- `apps/daemon/src/pipeline/setup.ts`（新增 `resolveWhisperVadModel`）+ `modelStore.ts`（`resolveActiveModel` 加 `accept`）
- `apps/daemon/src/pipeline/vadStatus.ts`（**新增**）+ `main.ts`（`/api/health` 出 `pipeline.vad`）
- `apps/daemon/src/jobs/runners/transcribe.ts`（降级出声 + 进 job 结果）
- `packages/pipeline/src/audio/vad.ts`（去 `-np`、`-vspd`→`-vsd`、结果头闸、`planAudioChunks`）
- `packages/pipeline/src/tools.ts`、`transcribe.ts`
- `packages/runtime/src/selfcheck.ts`（`model.vad` 换判据）
- `apps/web/.../DiagnosticsPage.tsx` + 两份 i18n（**新增「音频切分方式」一行**）
- `scripts/ci/cold-start-audit.mjs`（§7 追加切分方式判定）
- 护栏 **+31 条**：`packages/pipeline/src/audio/__tests__/vadDegradation.test.ts`（**新增** 20 条）、
  `apps/daemon/src/pipeline/vadResolve.test.ts`（**新增** 7 条）、`packages/runtime/src/selfcheck.test.ts`（+4 条）
- 提交 `a7b96b7`，已 push。CI `cold-start-audit` run **31069224572** 已出结果（见 §0）

需要 Manager 决策: 见文末 §7

---

# §0 ★ 判据：CI 上真的转出字来了（`[CI 实测]` run 31069224572，commit `a7b96b7`）

| 平台 | 转写 job | 拿到的文本 | 切分方式 | 判定 |
|---|---|---|---|---|
| **linux-x64** | `succeeded (2.1s)` | 1 段 / 108 字符 | **VAD（按静音）** | ✅ **通了** |
| **win32-x64** | `succeeded (4.6s)` | 1 段 / 108 字符 | **VAD（按静音）** | ✅ **通了（Windows 有史以来第一次）** |
| **darwin-arm64** | `failed` | (空) | VAD（按静音）✅ | 🔴 **卡在别处**：`maskbin/whisper-cli exited with code 127` —— **macOS 还没有 whisper 包**（等 release，`pack-publish` 那条线）。**VAD 这一环在 macOS 上也已经修好** |

两台成功的机器上，文本一字不差：

```
And so, my fellow Americans, ask not what your country can do for you,
ask what you can do for your country.
✔ 切分方式 = VAD（按静音切分），权重 …/by-name/asr/ggml-silero-v6.2.0.bin
```

**对照前一轮（run 31039460495，同一个脚本、同一个判据）**：

| | 上一轮 | 本轮 |
|---|---|---|
| linux-x64 转写步骤 | ✘ `whisper-vad-speech-segments exited with code 2` | ✅ succeeded |
| win32-x64 转写步骤 | ✘ 同上，一字不差 | ✅ succeeded |
| darwin-arm64 转写步骤 | ✘ whisper-cli 127 | ✘ whisper-cli 127（**同一条，未变，不属本任务**） |

⚠️ **三个 job 的整体结论仍是 `failure`，但红的不是这一步。**
红的是**对照组**那一步（`--no-mask`，**不带 `--transcribe`**）的
`model.asr fail (required) —— 无可用 ASR 模型`。
那是 D-11 §7.3 第 1 条早就定性过的**产品事实**（`required-core` 里一个 ASR 都没有），
**上一轮同一步同样是红的**，与本次改动无关。逐步比对：

```
上一轮 linux 红的步骤：  冷启动（屏蔽宿主工具）+ 转写可行性证明   ← 本次修掉了
                        对照组：不屏蔽宿主工具再跑一次           ← 仍红（旧账）
本轮   linux 红的步骤：  对照组：不屏蔽宿主工具再跑一次           ← 只剩这一条
```

---

# TL;DR

## ① `pack-publish` 的假设**被证伪了** —— 不是 v5/v6，是「role 相同、格式互不兼容」

它的假设：*清单钉 v6、`tools.ts:449` 第一个写 v5 → 版本对不上*。三条独立证据推翻它：

| 查了什么 | 结果 |
|---|---|
| `tools.ts` 那张候选表 | **v6.2.0 一直在里面**（第二个），文件真在就找得到 |
| whisper.cpp v1.9.1 支不支持 v6.2.0 | **支持**。`models/download-vad-model.sh:33` 明写 `silero-v5.1.2 silero-v6.2.0` |
| 那个文件的 magic 到底对不对 | **对**。而且不用联网就能验 —— 见下 |

**它下不到 HF，我也下不到（`hf-mirror.com` 只是 308 跳回 huggingface.co，不是镜像）。
但那份权重一直躺在仓库里**：

```
vendor/whisper.cpp/models/for-tests-silero-v6.2.0-ggml.bin
  885,098 B   2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987
清单 vad/silero-vad-ggml
  885,098 B   2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987   ← 逐字符相同
头 4 字节 6c 6d 67 67 = GGML_FILE_MAGIC(0x67676d6c) 小端  ✔
```

`[本机实测]` 拿 **CI 那台机器装的同一个上游二进制**
（`/tmp/ci-runner/localsmoke3/…/whisper-vad-speech-segments`）喂这份权重：

```
Detected 4 speech segments:
Speech segment 0: start = 32.00, end = 227.00
…                                                rc=0
```

**权重没问题、二进制没问题、版本没问题。**

## ② 真正的根因：**只按 `role` 挑模型，把 sherpa 的 ONNX 交给了 whisper.cpp**

目录里 `role: 'vad'` 底下有**两个互相加载不了**的文件，而且两条清单条目自己就写着：

```
vad/silero-vad-onnx   engines:["sherpa-onnx"]   “whisper.cpp CANNOT load this file”
vad/silero-vad-ggml   engines:["whisper.cpp"]   “The sherpa-onnx engine CANNOT load this file”
```

`apps/daemon/src/http/rest/models.ts:488` 的激活规则是 `activateOnSuccess || !state.active[role]`
—— **先装的那个赢**。目录里 onnx 排在 ggml 前面，于是任何一次冷装 `required-core` 之后：

```
active.json  →  {"vad":"vad/silero-vad-onnx", …}
```

这份 `active.json` 我不是推的，是从 **`ci-runner` 那次真实冷启动留下的数据目录里逐字读的**
（`/tmp/ci-runner/localsmoke3/data/models/active.json`）。

`buildPipeline` 调 `resolveActiveModel(modelsDir,'vad')` → 照单交出 ONNX →
`whisper-vad-speech-segments -vm silero_vad.onnx` → **`bad magic` → exit 2 → 整单转写死**。

`[本机实测]` 端到端复现（走产品自己的 `detectSpeechSegments`，非重写）：

```
=== 旧解析器（只按 role）===
  vadModel = …/by-name/asr/silero_vad.onnx
  ✘ whisper-vad-speech-segments exited with code 2
    read_audio_data: trying to decode with miniaudio
    whisper_vad_init_from_file_with_params: loading VAD model from '…/silero_vad.onnx'
    whisper_vad_init_with_params: invalid model data (bad magic)     ← ★ -np 拿掉才有的两行
    error: failed to initialize whisper context
=== 新解析器（whisper 必须能加载）===
  vadModel = …/by-name/asr/ggml-silero-v6.2.0.bin
  ✔ 4 段: 320-2270 3270-4410 5380-7680 8160-10620
```

**除最后两行外与 CI 日志逐字节相同。**

> 一句话：**「谁能加载它」这个信息一直写在安装记录的 `engines` 字段里
> （`models.ts:452` 的注释还专门解释了为什么要写进去），而解析器从来没读过它。**

这也解释了任务书里那句「装了 VAD 比不装 VAD 更糟」为什么是**确定性**的而不是概率性的：
目录顺序固定，所以每一台冷装的机器都会挑中 ONNX。

## ③ 顺带查出**第二条同族的雷**（还没炸，但已经上膛）

`vad.ts` 一直在发 `-vspd`。`[本机实测]`：

```
$ whisper-vad-speech-segments … -vspd 250
error: unknown argument: -vspd          ← 打在 stderr
rc=0                                     ← ★ exit(0)
stdout 0 字节                            ← ★ 空
```

`speech.cpp:37` 的 `--help` 写着 `-vspd`，**parser 里没有这个分支**（`:62-72`）；
认不出的参数走 `vad_print_usage(); exit(0);`。
下游 `parseVadOutput('')` → `[]` → transcribe 读成「这段音频没有语音」→
**零 chunk → 空转写 + job 成功**。
今天没炸只因为**没有任何调用方设过 `minSpeechDurationMs`**。

同族还有一条：`speech.cpp:67-68` 把 `-vsd` 绑了两次，第二个分支（min-silence）不可达
且赋给的是 min-speech 变量 —— 也就是说这个例子**根本表达不了 min-silence**。
所以我把 `minSilenceDurationMs` 字段**删掉**了：一个注定不生效的字段比没有更糟。

## ④ 三条修法（对应任务书 ①②）

| # | 修了什么 | 判据 |
|---|---|---|
| 1 | VAD 权重按**内容**挑：读头四字节比 `GGML_FILE_MAGIC` | 与 `whisper_vad_init_with_params`（`whisper.cpp:4779-4785`）的第一步逐字对应 |
| 2 | 去掉 `-np` | 失败路径说话；成功路径照旧安静（`runOrThrow` 只在非零退出时才带出 stderr） |
| 3 | VAD 跑挂 → 退回固定窗口 **+ 三处出声** | 见 §3 |

**为什么按内容而不是按 `engines` 字段**：老安装记录里**没有** `engines`（后加的），
按字段过滤会把一份完全能用的权重误判成不能用。按内容判则新记录、老记录、
用户手工拷进来的文件一视同仁 —— 而且钉的正是 whisper 自己会检查的那四个字节。
（HANDOFF ⑤A 规矩 7：断言要钉后果，不要钉形式。）

## ⑤ 关于 `-np`：它**从来没有**带来过它注释里声称的好处

原注释：`// machine-readable: suppress everything except the results`。
`[本机实测]` 同一次成功运行，带与不带 `-np` 的 **stdout 逐字节相同**：

```
带 -np    stdout: "\nDetected 4 speech segments:\nSpeech segment 0: …"   stderr 3 行
不带 -np  stdout: "\nDetected 4 speech segments:\nSpeech segment 0: …"   stderr 35 行
```

`parseVadOutput` 只读 stdout。**`-np` 只关掉诊断通道，对"机器可读"零贡献。**
一条描述了不存在收益的注释，换来的是三种失败在日志上完全无法区分。

---

# §1 定性过程（每一步的证据级别）

| 步骤 | 结论 | 级别 |
|---|---|---|
| 读 `speech.cpp` 两个 `return 2` | `:116` 那条文案与 CI 一致；`read_audio_data` 打到了 miniaudio 说明音频读到了 | 读源码，与 `pack-publish` 一致 |
| 读 `whisper.cpp:4731-5090` | VAD 初始化有 **5 条** `return nullptr` 路径（打不开 / bad magic / unknown tensor / wrong shape / backend init），**全部**经 `WHISPER_LOG_ERROR` | 读源码 |
| 试连 HF / hf-mirror | HF 直连超时；**`hf-mirror.com` 对 `/resolve/**` 一律 308 跳回 huggingface.co** ⇒ 清单里那条 mirror 提供的冗余是 0 | 本机实测 |
| 在仓库里找到同一份权重 | `vendor/whisper.cpp/models/for-tests-silero-v6.2.0-ggml.bin` sha256 与清单**逐字符一致** | 本机实测 |
| 用 CI 的上游二进制跑那份权重 | rc=0，4 段 ⇒ **权重与二进制都没问题** | 本机实测 |
| 空路径 / 不存在 / ONNX 三种输入 | 带 `-np` 时输出**逐字节相同**，全是 `failed to initialize whisper context` + exit 2 | 本机实测 |
| 读 `active.json`（真实冷启动留下的） | `"vad":"vad/silero-vad-onnx"` | 本机实测（读 `ci-runner` 的临时目录） |
| 跑 `resolveActiveModel(dir,'vad')` | 返回 `…/silero_vad.onnx` | 本机实测（调编译后的产品代码） |
| 端到端喂给 `detectSpeechSegments` | 复现 CI 那条错误 | 本机实测 |

**我没有绕开产品代码去"模拟"任何一步** —— 复现用的是 `apps/daemon/dist` 与
`packages/pipeline/dist` 里编译出来的同一份函数。

---

# §2 为什么自检当时是绿的（这条比 bug 本身更值得记）

事故那一轮 `selfcheck` 报 `model.vad **ok** …/by-name/asr/ggml-silero-v6.2.0.bin`，
而 daemon 手里拿的是 `silero_vad.onnx`。**两句话都不假，因为它们说的不是同一个东西**：

| 出口 | 怎么解析 VAD 权重 | 得到 |
|---|---|---|
| `scripts/selfcheck.mjs`（CLI） | `pl.discoverTools()` → 按**文件名**在 `by-name/asr` 里找 | `ggml-silero-v6.2.0.bin` ✅ |
| daemon / `/api/selfcheck` | `resolveActiveModel(dir,'vad')` → 按 **role + active.json** | `silero_vad.onnx` ❌ |

而 `meta.sameSource` **只比 id 与 status，不比 detail**（`scripts/selfcheck.mjs:391-393`
写得很清楚，理由也正当：detail 里有路径这类本来就该不同的东西）。
两边都因为「文件存在」判成 `ok` ⇒ **`25 项逐 id 一致`**。

> **两个出口解析出了两个不同的文件，而同源校验在结构上看不见这件事** ——
> 因为它比的是结论，不是过程。这不是 `meta.sameSource` 写错了，
> 是「文件在不在」这个判据太弱，弱到两边都能用它得出同一个绿灯。

所以我把判据换成了「whisper.cpp 加载得了吗」：**同一个错误状态，两个出口现在都会报出来**。

---

# §3 降级要"说出来"—— 三处，缺一不可（按你的裁决做的）

你的原话：**退回固定窗口 + 自检出现一条明确的 warn/fail + 用户在界面上看得见。**

| 层 | 做了什么 |
|---|---|
| 转写结果 | `TranscribeResult` 新增 `chunking: 'vad' \| 'fixed'` 与 `warningsZh[]`。**调用方拿不到结果就拿不到这个事实**（不是可选的旁路信息） |
| daemon | 退回时 `console.warn`；job 成功 payload 带 `chunking` + `warningsZh` |
| 自检 | `model.vad` 判据从 `access(R_OK)` 换成 `isGgmlModelFile`。三档：`ok` 能加载／`fail` 交出来的文件加载不了／`warn` 没有可用的（**并说清是"一个都没装"还是"装的那个 whisper 用不了"**） |
| 界面 | 诊断页「流水线」组新增 **「音频切分方式」** 一行，读 `/api/health` 的 `pipeline.vad`，非 VAD 时黄灯 + 「去修」跳 `/models` |

**⚠️ 我特意堵了一个自己差点造出来的新假绿灯**：
`buildPipeline` 只知道**静态**那一半（权重挑到没有）。权重挑对了、二进制却跑失败时，
只报静态那一半的话，诊断页会在**每一次转写都降级**的情况下显示绿灯。
所以加了 `vadStatus.ts`：转写 runner 观测到运行期失败就把这一格标脏，`/api/health` 优先报运行期事实。
**进程内变量，不落盘** —— 按 PROTOCOL §9 的判据（`kill -9` 在最坏的一行上会留下什么）：什么都不留。
落盘反而会造出"修好了还一直报红"的假红灯。

**没有做成 required=true**：只装了 sherpa ONNX 对流式用户是完全合法的选择，
报红会是假红灯（HANDOFF ⑤B）。降级是 `warn`，「交出去一个加载不了的文件」才是 `fail`。

---

# §4 反向验证（四组，全部贴真实输出）

跑之前都 `grep` 过坏行确实在**即将运行的产物**里（`dist/**/*.js`），跑完全部还原，
`grep -rn REVERSAL` 全仓 0 命中。

**R1 · 把解析器退回「只按 role 挑」**（事故那天的那一行）
```
✖ ★ 两个都装了、active.json 指着 ONNX：仍然必须交出 ggml 那一份
  AssertionError: 交给 whisper-vad-speech-segments 的那份权重必须真的能被它加载
✖ ★ 只装了 sherpa 的 ONNX：宁可说"没有"，也不许把它交出去
  AssertionError: 交出去 = whisper 报 bad magic = 整单转写死
✖ ★ 环境变量覆盖同样要过这一关（`OPENMEMO_VAD_MODEL` 指到 ONNX 上）
  AssertionError: 开发用的逃生口不该有"绕过正确性"的权力
ℹ tests 7 / pass 4 / fail 3
```

**R2+R5 · 把 `-np` 放回去、`-vsd` 改回 `-vspd`**
```
✖ ★ 绝不能出现 `-np`：它会把 whisper 五种加载失败压成同一句话
✖ ★ min-speech-duration 必须发 `-vsd`，发 `-vspd` 会换来一份空转写 + 绿灯
✖ 只发 parser 真的认识的那几个开关
  AssertionError: 这些 flag 例子不认识，会让它 exit(0) 并吐空 stdout：-vspd
ℹ tests 20 / pass 17 / fail 3
```

**R3+R6 · 拆掉降级、拆掉「没有结果头就不算跑过」的闸**
```
✖ ★ exit 0 + 空 stdout 必须抛，不能当成"这段音频没有语音"   Missing expected exception
✖ usage 文本（例子把 --help 打到 stderr、stdout 全空）不算答案  Missing expected exception
✖ 抛出来的话里要带上退出码与实际输出，否则又是一条查不动的错误
✖ ★ VAD 抛错 → 退回固定窗口，而不是把整单转写打死
✖ ★ 退回时必须留下一条给人看的话，而且带得上原始失败原因
ℹ tests 20 / pass 15 / fail 5
```

**R4 · 自检退回「文件在不在」**
```
✖ ★ 文件在、但不是 ggml → fail（旧判据在这里给的是 ok）
  AssertionError: 存在性检查会把它读成 ok —— 那正是事故那天的样子
ℹ tests 33 / pass 32 / fail 1
```

## 我在写护栏时自己犯的一个错（记账）

`isGgmlModelFile` 的夹具第一版写的是 `Buffer.from('ggml')` —— **红了**。
`GGML_FILE_MAGIC = 0x67676d6c` 按**大端**看才拼成 `"ggml"`，而 ggml 是**小端**写盘的，
真权重头四字节是 `6c 6d 67 67`（`xxd` 出来是 `lmgg`）。
我把这条连同"为什么"写进了那条用例的注释里，免得下一个人照直觉再来一遍 ——
**一个按直觉写就必然写错、且错了会得到"判定永远不通过"的地方，值得留下路标。**

---

# §5 判据：真的转出字来（✅ 已拿到，见 §0）

`cold-start-audit` run **31069224572**（commit `a7b96b7`），三平台。
我在 §7 里追加了一段**切分方式判定**（~20 行），红绿刻意分两档：
**`rejected` 非空**（装了一份 whisper 用不了的权重）→ 红；单纯没装 VAD → 只打印不判红
（那是合法降级，报红就是假红灯）。三个平台这一档都打印出了
`✔ 切分方式 = VAD（按静音切分）` —— 也就是说 **macOS 上 VAD 解析这一环同样修好了**，
它只是后面缺 whisper 二进制。

我也**避开了 `pack-publish` 踩过的那个坑**：脚本挑 ASR 模型这段没动，
上一轮它已经挑对了 `asr/whisper-tiny-q5_1`（whisper.cpp 这条链、英语样本），
不是那个中文流式 onnx。本轮转出来的正是英语原文，**说明挑的引擎也确实是对的那条**。

# §6 我没做 / 做不到的（如实列）

| 项 | 状态 |
|---|---|
| macOS 上真的转出字 | ⛔ **本任务修不了** —— `[CI 实测]` 它已经走过 VAD 那一环（`✔ 切分方式 = VAD`），死在 `whisper-cli` 127：**缺 whisper 包，等 release**（`pack-publish` 那条线） |
| `cold-start-audit` 对照组的 `model.asr fail` | ⛔ **旧账，没动**。对照组不带 `--transcribe`，因此不拉 ASR 模型，而 `required-core` 里本来就没有 ASR（D-11 §7.3 #1 的产品结论）。**它让这个 workflow 恒红** —— 恒红会训练人忽略告警，建议单独派人裁（要么对照组也拉模型，要么把这条改成 warn） |
| `models.ts:488`「先装的赢」的激活规则 | ⛔ **刻意没动**。它对 ASR/LLM 是合理的，对 VAD 出问题是因为"一个 role 一个槽位"这个前提不成立（VAD 是**按引擎**分的）。正确的修法是让**消费方**说清自己要什么 —— 已经这么做了。改激活规则会牵动 sherpa 那条线，超出本任务 |
| `hf-mirror` 那条 mirror 其实不提供冗余 | ⛔ 只是查到并记在这里（`vendor/manifests/` 归 `pack-publish`，动它要先申报）。**影响面**：`models-*.json` 里所有 `hf-mirror` 条目在 HF 不可达时同样不可达 |
| 用户机器上"装了 ONNX 没装 ggml"的历史状态怎么自愈 | 🟡 **不会自动装**。现在会在自检与诊断页明确说"去装 `vad/silero-vad-ggml`"，但没有一键修复 |
| 本机跑 whisper **转写** | ⛔ 按用户指示**一次都没跑**。我只跑了 `whisper-vad-speech-segments`（11 秒样本的语音分段，不是转写），那是定性所必需 |
| `packages/downloader` 至今**没有 `test` 脚本** | ⛔ 没加。新函数的护栏放在 pipeline/daemon/runtime 三个已有脚本的包里。`check-test-scripts.mjs` 目前不报它（该包 0 个测试文件），**但谁往那个包里加第一个测试就会被它拦下** |

---

# §7 需要 Manager 决策

1. **诊断页读的是 `/api/health`，不是 `/api/selfcheck`**（该文件头部注释写的"selfcheck 只是 CLI、
   没有 HTTP 端点"**已经过期**，端点早就有了）。我这次是给 `/api/health` 加字段、页面加一行
   —— **没有改数据源**，因为换数据源是整页重写，属于别人的界面。
   要不要单开一条让诊断页直接吃 `/api/selfcheck`？那能一次性消掉"两套检查项"这个长期分叉。
2. **`vendor/manifests/` 我一个字没动**（`pack-publish` 在途）。但有两条建议要你派给它：
   ① `hf-mirror` 那些条目实测不提供任何冗余（308 跳回源站），**要么换真镜像，要么别声称是 mirror**；
   ② `vad/silero-vad-ggml` 的权重与 `vendor/whisper.cpp/models/for-tests-silero-v6.2.0-ggml.bin`
   **sha256 完全相同** —— 也就是说 submodule 里已经有一份，冷启动却要再从 HF 下一次 885 KB。
3. **上游 `speech.cpp` 的两个 bug**（`-vspd` 无分支、`-vsd` 绑了两次）要不要给 whisper.cpp 提 issue/PR。

---

# §8 纪律申报

- **`git add` 逐个文件**（17 个），没有 `-A`。`git status` 里当时没有别人的在途改动。
- 构建**全程 `pnpm build:safe`**；`apps/web/dist/index.html` 时间戳 `02:15:09` 未变（我的工作从 03:00 开始）。
- `:10000` **一次请求都没发**；`/root/data-memo` **没读没写**（mtime 未变）；
  `~/.local/share/openmemo/datadir.json` 没碰（08-04 的时间戳）。
- 没有 `pkill -f`；没有建 release / 改可见性 / 改分支保护。
- 临时文件在 `/tmp/vad-fix/`。**读过 `/tmp/ci-runner/localsmoke3/`（只读）** —— 那是 `ci-runner`
  一次真实本机冷启动留下的数据目录，`active.json` 与那个上游 whisper 包都是从那里取的地面真相。

## SHARED-CHANGE 申报

| 文件 | 归属 | 我做了什么 | 冲突风险 |
|---|---|---|---|
| `scripts/ci/cold-start-audit.mjs` | `ci-runner` / `pack-publish`（在途） | §7 末尾**纯追加** ~20 行切分方式判定 | 🟡 中 —— `pack-publish` 上一轮也改过这个文件，rebase 时留意 |
| `packages/runtime/src/selfcheck.ts` | `storage-fix` / `gpu-runtime` / `pack-publish` | 改写 `model.vad` 一项 + 加一个正则常量 + 加一行 import | 🟡 中 —— 只动这一项，不碰 `asr.coreml` 等其它检查 |
| `packages/runtime/src/selfcheck.test.ts` | 同上 | 在既有 describe 里**插入**一个子 describe | 低 |
| `apps/daemon/src/http/rest/models.ts` | `model-mgmt` | **没改**（只读了 `:488` 那条激活规则并在 §6 说明为什么不动） | 无 |
| `apps/web/.../DiagnosticsPage.tsx` + 2 份 i18n | 前端线 | 加一行 Row + 3 个 key（插在 `asrEngine` 之后） | 低 |
