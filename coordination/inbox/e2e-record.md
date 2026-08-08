# e2e-record（F3 录音 → 转写 → 时间轴）

## [2026-08-08 16:40] e2e-record DONE

交付:

- `.github/workflows/e2e-record.yml`（新建，三平台）
- `scripts/ci/e2e-record.mjs`（驱动，走真 HTTP/WS）
- `scripts/ci/e2e-record-assertions.mjs`（11 条纯函数断言）
- `scripts/ci/selftest-e2e-record.mjs`（**变异证明**，76 条，已挂进 `pnpm test:ci-scripts`）
- `scripts/ci/ws-client.mjs` + `scripts/ci/ws-client.smoke.mjs`（手写 RFC 6455 客户端 + 对真 daemon 的 smoke）
- `apps/daemon/src/ws/recorder.ts` + `recorder.test.ts`（修 1：录音的 `input_url`）
- `apps/daemon/src/jobs/runners/transcribe.ts` + `archiveIntoMedia.test.ts`（修 2：归档判断规范化路径）
- `package.json`（把变异证明接进 `test:ci-scripts`）

要点:

- **三平台全绿，每平台 20 条关键断言**：run **31248849155**（包来自 build-bundles run **31248640972**，commit `9539e4b`）。
- 这条腿**在 CI 上抓到两个真实产品缺陷**，都是 F3 主路径上的，都已修并有回归用例。
- 波形**确认是真的**：与独立计算逐桶逐值比对，751 桶 × 2 值全等。
- **重转之后词级时间戳还在**，且"模型真的换了"是拿稿子自报的 `modelId` 判的。
- 不许 `pnpm install`、不许源码树 —— 这条腿的前置条件只有「一个 Node」和「那个包」。

需要 Manager 决策: **有 1 条（见 §6「仍然是坏的」）—— F3 停止录音后的自动离线重跑在三平台全部失败，我把它留成了观测项而不是判据，需要裁决。**

---

## 1. 三个平台各自跑到哪一步、实际拿到什么

最终 run **31248849155**，包 = `build-bundles` run 31248640972 的 artifact（`openmemo-0.2.0-<target>`）。

| 平台                       | 结果             | 关键实测                                                             |
| -------------------------- | ---------------- | -------------------------------------------------------------------- |
| `ubuntu-24.04` linux-x64   | ✅ **20/20** | 转写文本是真的 JFK 原句；词级 26 词                                  |
| `macos-26` darwin-arm64    | ✅ **20/20** | 词级 25 词；换模型后 22 词                                           |
| `windows-2025` win32-x64   | ✅ **20/20** | 同上，逐条对齐                                                       |

三平台一致拿到的数：

```
录音会话      ready(sr=16000) → partial×14 / final×3 → stopped(segmentCount=3)  零 overrun 零 error
落盘资产      role=original state=ready mime=audio/wav bytes=384078
              （= 我推上去的 384034 字节 PCM + 44 字节 WAV 头，逐字节相同）
Range 回放    bytes 32044-64043/384078，32000 字节逐字节相等
波形          751 桶 × 2 值逐个相等；峰值 102/127，响 195 桶 / 静 281 桶；durationMs=12001
词级时间戳    1/1 段带词级时间戳，共 25~26 个词
换模型重转    ggml-tiny-q5_1.bin → ggml-tiny.en-q5_1.bin，重转后 2/2 段 22 词
VAD 未装      chunking=fixed，理由「未安装 VAD 模型 → 切分降级为固定窗口」，仍转出 1 段 / 107~108 字符
VAD 装上      chunking=vad，权重 ggml-silero-v6.2.0.bin；再转一次 job=succeeded
搜索 ?t=      命中的 startMs=120，落在真实段落起点上
网页壳        GET / → 200，3555 字节 HTML，引用 42 个 /assets/*，取样 8 个全 200
借宿主工具    5 个 tool.* 全是产品自己装的，**0 个借**；shim 零命中
```

`ubuntu-24.04` 上转出来的文本（tiny 模型，未做任何清洗）：

> And so, my fellow Americans, ask not what your country can do for you, ask what you can do for your country.

## 2. 波形是不是真的 —— **是**

判据不是"有波形数据"（历史上那条编出来的正弦波也有数据、长度也对）。
驱动脚本手里有它推给 `/ws/recorder` 的**每一个字节**，所以能**不经过服务端**独立算一遍
min/max 峰值，再与 `/media/asset/<peaks uid>` 取回的 `.ompk` **逐桶逐值**比对：

```
✔ ★ 波形是真的从音频算出来的（逐桶与独立计算比对）
   751 桶 × 2 值逐个相等；峰值 102/127，响 195 桶 / 静 281 桶；durationMs=12001
```

「响 195 桶 / 静 281 桶」不是装饰，是**前提自检**：全静音或恒定包络时"逐桶相等"会恒真，
所以断言先要求这份音频本身有动态范围，不成立就报红。变异证明里专门有两条打这个前提
（送纯静音、送满量程方波），两条都必须红。

## 3. 重转之后词级时间戳还在吗 —— **在**

```
✔ ★ 模型真的换了 **且** 词级时间戳还在
   模型 ggml-tiny-q5_1.bin → ggml-tiny.en-q5_1.bin；
   重转前 1/1 段带词级时间戳，共 25 个词；重转后 2/2 段带词级时间戳，共 22 个词
```

两条都要过，**"模型真的换了"这一条盯的是稿子自报的 `modelId`**，不是"我在请求里写了什么"——
`transcribe.ts:205` 在指定模型未安装时会打一行 warn 然后**静默回退到自动选择**，
于是"请求里写了什么"与"实际用了什么"可以完全无关。这正是本仓栽过的第二种坏断言的形状。

## 4. CI 抓到的两个真实缺陷（都已修，都有 red→green 实证）

### 缺陷 ①：**每一条录音笔记的「重新转写」永久不可用**

`ws/recorder.ts` 建 `media_sources` 时不传 `originalUrl` → `input_url` 恒为 NULL →
`rest/notes.ts:648` 的 `canRetranscribe: input_url != null` **恒 false**（按钮永久禁用），
绕过按钮直接打端点，`rest/content.ts` 回 409。换语言、换模型、失败重跑，对录音一律不可用。

**同一缺陷本仓修过两次**：`rest/notes.ts`（本地导入）与 `http/upload.ts`（拖拽上传），
两处注释都写着同一段话。**录音是第三次，没跟上。**

`[CI 实测]` 拿**用户手里那个 v0.2.0 包**（build-bundles run 31208766871 的 artifact）跑，
run **31249295959**：

```
POST /api/notes/01KZG95PD2AWE3K7A50G20NR1J/retranscribe {modelId:asr/whisper-tiny-q5_1}
  → HTTP 409 {"code":"NO_SOURCE_INPUT","messageZh":"这条笔记没有记录原始输入，无法重跑"}
✘ 录音笔记可以被「重新转写」（input_url 不为空）
```

修后的包（31248640972）同一条：`HTTP 202，job 排上了`。**red → green 成对，用的是真产物。**

### 缺陷 ②：**macOS / Windows 上，重转一次就把录音搬走了**

`archiveIntoMedia` 那句「已经在 media/ 里就别动它」是 `relative()` —— **纯字符串运算**。
而 `mediaRoot` 与文件路径在真实系统上经常是同一目录的两种写法：

- macOS：`os.tmpdir()` 给 `/var/folders/…`，而 `/var` 是指向 `/private/var` 的符号链接；
- Windows：`%TEMP%` 是 8.3 短名（`C:\Users\RUNNER~1\…`），长名是 `…\runneradmin\…`。

判断落空 → 录音被 `rename()` 搬到 `<mediaRoot>/<noteUid>/` 并新插一条 `role='original'`。
两条用户可见的后果：**原来那条资产 404（播放器当场废）**、**`input_url` 指空（之后每次重转全失败）**。

`[CI 实测 run 31247843782]` macOS，第一次重转之后：

```
[A] 转写后的资产：
   role=original ... url=/media/asset/01KZG6XDJK...   ← 录音自己那条
   role=peaks    ...
   role=original ... url=/media/asset/01KZG6Y6GJ...   ← **多出来的第二条**
   role=audio16k ...
✘ [A] 重转之后原始录音仍然取得到字节：**HTTP 404**
[B] 转写 job：failed {"code":"RUNNER_ERROR","message":"no media source can handle this input"}
```

同一 run 的 Linux：一条 `original`、三次探针全 `HTTP 206`、三次重转全 succeeded。

> **这个 bug 在 Linux 上不可见** —— `/tmp` 既没有符号链接也没有短名。
> 它能一路活到用户手里，正是因为所有人都在 Linux 上开发。
> 所以回归用例用一个**符号链接**在 Linux 上把 macOS 那种写法差异造出来
> （`archiveIntoMedia.test.ts`，含一条**反向**用例：真在 media/ 外面的文件必须照旧被搬进来，
> 防止有人把判断"修"成永远不搬）。

修法：比较前两边都过 `realpathSync.native`。判据不是"记得传规范化的路径进来"，
是"**传什么写法进来结论都一样**"。

## 5. 这条腿自己的两个缺陷（第一次真跑抓到的，已修）

- **跳过的平台报了绿。** `legs=linux` 时 darwin/win32 两个 job **一步没跑却都是 success** ——
  过滤写在每个 step 的 `if` 上。`jobs.<id>.if` 拿不到 `matrix` 上下文，所以改成先用一个
  `plan` job 算矩阵：**被过滤掉的平台根本不会有 job**，界面上是"没有这一格"而不是绿勾。
- **`read ECONNRESET` 打断整条腿**，而 daemon 是活着的。Node 19 起全局 agent 默认 keepAlive。
  改成 `agent: false` + 只对连接类错误重试（拿到状态码的响应绝不重试）。

还有一条值得记的 `[实测]`：**`run:` 块里不能出现表达式定界符**，哪怕在 `#` 开头的行里 ——
那是 shell 正文不是 YAML 注释，GitHub 当场 `HTTP 422 An expression was expected` 拒收整个
workflow。对照：`cold-start-audit.yml:202` 有同样一对却没事，因为**它在 YAML 注释里**。
两边 YAML 都解析得动，`lint-workflows.mjs` 也照常放行（它明写自己不校验表达式）。

## 6. ⚠️ 仍然是坏的（需要 Manager 决策）

**停止录音后自动排的那个离线重跑，三平台全部失败。** 三平台同一形态：

```
ⓘ 停止录音后自动排的离线重跑：failed
  {"code":"RUNNER_ERROR","message":"…/whispercpp-vulkan-linux-x64/whisper-cli exited with code 3
   load_backend: loaded CPU backend from …/libggml-cpu-haswell.so
   error: failed to initialize whisper context"}
```

`[分析，未逐步验证]` 这一步的 payload **不带 `modelId`**，所以走 `active.json` 选型；
而 `active.json` 是"先装的赢"，本轮先装的 role=asr 模型是 **sherpa 流式那个**（onnx 转换器）——
whisper.cpp 拿到它就 `failed to initialize whisper context`。
**与 T-148 是同一个形状，只是换了一个 role**（那次是 VAD 的 onnx 抢了 ggml 的槽）。

用户可见的后果：**录完音，自动的那遍高质量转写默默失败**，笔记上只剩流式那份稿。

**我把它留成了观测项（`ⓘ`）而不是判据**，理由与代价都摆在这里：

- 改成判据 → 三平台立刻全红，而**修它要动引擎/模型选型**（`setup.ts` 那条 active 槽位规则），
  那不是我这一轮能顺手做完、也不是我该单方面动的地方；
- 留成观测项 → 这条腿现在是绿的，而 F3 的一条真实路径是坏的。

**这是一个我不该独自裁决的取舍，所以明确交上来。** 我的建议：先修选型，同一轮把这条改成判据。

## 7. 哪些环节在 CI 里**结构上**验不了

- **真麦克风**。被替掉的只有这一个物理设备：脚本做浏览器做的事（连 `/ws/recorder`、等 `ready`、
  按真实时间节奏推 PCM16、发 `{"type":"stop"}`）。喂的是 `jfk.wav` 的真实 PCM，
  而浏览器发的本来就是 PCM16 裸字节（`asrStream.ts` 的 AudioWorklet，无容器无编码）。
  **服务端一段都没绕过**：升级闸门、鉴权、`RecorderSession`、落盘、WAV 头回填、资产入库、
  波形计算、重跑排队，全是产品代码在真端口上跑。
- **浏览器里的双向联动本身**（点段落→音频 seek、播放头→高亮当前段）是前端行为，
  没有浏览器就验不了。这条腿验的是**服务端把它需要的数据都给对了**：段落有序不重叠、
  与音频同一条时间轴、`?t=` 用的 `startMs` 落在真实段落起点上、Range 能按时间偏移取到对的字节。
  `seekParam.ts` 的夹取逻辑有自己的单测，**但"点了真的跳过去"没有端到端覆盖** → `UNKNOWN`。
- **`?t=` 那个链接是前端拼的**（`SearchPage.tsx:140`），HTTP 层看不到。已验的是它的原料。
- **流式识别的准确率**：目录里唯一的流式 ASR 是中文模型（`asr/sherpa-streaming-zh-14m`），
  样本是英语，所以识别内容**不作判据** —— 这一步证的是"音频真的被收到并处理了"
  （partial×14 / final×3 / segmentCount=3）。想验中文流式质量需要中文样本，本仓没有。
- **`GET /api/notes/:uid/anchors` 恒返回 0 个锚点** —— 锚点要正文里有 `[[t:…]]` 标记才有，
  录音笔记没有。这一格是 `ⓘ`，不是绿也不是红。
- **macOS 版本**：任务书写 `macos-14`，但全仓 8 个 workflow 里 `macos-14` 一次都没出现过，
  而 darwin 那个包**就是在 `macos-26` 上编出来的**。我照抄了 `cold-start-audit.yml` 现用的
  三个（`ubuntu-24.04` / `macos-26` / `windows-2025`）。在 macos-14 上跑会撞上另一件事
  （上游预编译 dylib 的 minos 高于 14，见 D-11 §8.0），那是 `check-bundle-macos-floors.mjs`
  的地界，混进来只会得到一个说不清在红什么的红。**这条差异请 Manager 确认是否接受。**

## 8. 断言的证伪能力（本仓栽过两次，所以单独说）

11 条断言全部是纯函数（`e2e-record-assertions.mjs`），每一条都在
`selftest-e2e-record.mjs` 里被喂过"本该让它变红"的输入，**共 76 条，每次 CI 都跑**：

- 真形状的输入**必须通过**（挡"恒假"的断言 —— 那种在门禁上等于没有）；
- 每个变异体**必须被拒**（挡"恒真"）；
- 变异体为空集**直接红**；
- meta：导出的每个 `check*` 都必须有变异证明，加了新断言忘了写证明当场红。

几条专门打本仓踩过的坑：

| 变异                                 | 打的是什么                                            |
| ------------------------------------ | ----------------------------------------------------- |
| 正弦波假波形（桶数/格式/时长全对）   | 「每条波形都是编的」那次事故                          |
| ★ 送纯静音 / 送满量程恒定包络        | **前提陷阱**：此时"逐桶相等"恒真，断言必须自己报前提不成立 |
| ★ 模型压根没换成                     | 静默回退 —— 盯复述而不盯事实的那类坏断言              |
| 重转之后 words 全没了                | T-164 ④ 的回归                                        |
| ★ 降级之后整单转写死了               | 「退了但也挂了」≠ 降级                                |
| ★ 只有 44 字节的空 WAV 头            | T-164 ② 那条"0 秒、打不开、状态却是就绪"的死笔记      |
| ★ 报告里一个 `tool.*` 都没有         | **前提陷阱**：此时"没借"恒真                          |

`ws-client.smoke.mjs` 另有 11 条，含**闸门反向断言**（Host 用域名 → 403、不带 Origin → 403）——
不先证明闸门真的在拦，"握手成功"那条绿灯什么都证明不了。

## 9. 门禁

本机（`TMPDIR` 见下）：

| 门禁              | 结果                                   |
| ----------------- | -------------------------------------- |
| `pnpm -r test`    | **1535 / fail 0**（基线 1508；我 +4，其余是并行的其他 agent 加的） |
| `tsc -b`          | 0                                      |
| `eslint`（我的文件） | 0                                      |
| `build:safe`      | 0                                      |
| `lint-workflows`  | 1027 条断言全过（12 个 workflow）      |
| `test:ci-scripts` | 0（已含我的 76 条变异证明）            |
| `check:orphans`   | 零引用导出 **70**（基线 70），没有新增 |
| `format:check`（我的文件） | 全过（跑了两遍到不动点）      |

⚠️ 两条如实说明：

1. **全仓 `eslint .` 与 `prettier --check .` 在我提交时是红的**，红在
   `scripts/ci/e2e-import-audit.mjs`（5 个未使用的 import）与
   `apps/daemon/src/bootstrap/open-browser.ts`（格式）—— **都是并行的其他 agent 正在写的文件**，
   不在我的改动集里。我没有碰它们（PROTOCOL §1/§3）。
2. **`/tmp` 在这台开发机上是满的**（tmpfs 12G，100%，8294 个条目，来自历次 agent 的产物）。
   `pnpm -r test` 大量用 `mkdtemp(tmpdir())`，满的时候会挂。我**没有删任何人的目录**，
   而是把自己的 `TMPDIR` 指到 `/var/tmp/e2e-record`。
   ⚠️ 第一次我指到了 `/root/tmp-e2e`，**5 条用例当场红** —— 它们断言
   「指针/模型根必须在 tmpdir 里**且不在 `$HOME` 底下**」（PROTOCOL §9-bis 那组守卫）。
   **护栏是对的，红的是我。** 换到 `/var/tmp` 后全绿。这条建议 Manager 关注：
   `/tmp` 再满下去，所有人的 `pnpm -r test` 都会以看起来像别的原因的方式挂掉。

## 10. 用到的 CI run（全部真实，可复查）

| run                                   | 是什么                        | 结果                                                        |
| ------------------------------------- | ----------------------------- | ----------------------------------------------------------- |
| `build-bundles` **31246835406**       | 含修 ① 的包（`c59b152`）      | 三平台 success                                              |
| `build-bundles` **31248640972**       | 含修 ①② 的包（`9539e4b`）     | 三平台 success                                              |
| `e2e-record` **31246863443**          | 第一次真跑（v0.2.0 包，linux）| 失败 —— 抓到本腿的假绿与 ECONNRESET                          |
| `e2e-record` **31247324575**          | 三平台（含修 ① 的包）         | linux 17/17 ✅；mac/win 各 4 红                              |
| `e2e-record` **31247843782**          | 加了资产探针再跑              | 拿到 404 + 重复 `original` 的直接证据 → 定位到缺陷 ②        |
| `e2e-record` **31248849155**          | 三平台（含修 ①② 的包）        | **三平台各 20/20 全绿**                                     |
| `e2e-record` **31249295959**          | 拿 **v0.2.0 原包**再跑一次    | 409 `NO_SOURCE_INPUT` —— 缺陷 ① 的 red 侧实证               |

## 11. 下一步建议

1. **先修 §6 的 active 槽位选型**（自动重跑挑到 sherpa 模型交给 whisper.cpp），
   同一轮把那条观测项改成判据。这是 F3 现在唯一还坏着的路径。
2. `?t=` 的"点了真的跳过去"需要一个带浏览器的腿才能收口；在那之前它是 `UNKNOWN`。
3. `/tmp` 清理需要一个所有人认账的规则，否则它会以"测试莫名其妙挂了"的形式持续咬人。

---

## [2026-08-08 18:35] e2e-record 追加 DONE —— 自动重跑那条：**修了根因，观测已翻成门禁**

交付:

- `apps/daemon/src/pipeline/modelStore.ts`（根因修复：`ModelQuery.engine` 必填 + `MODEL_FORMAT_BY_ENGINE` + `canEngineLoad`）
- `apps/daemon/src/pipeline/engineModelFormat.test.ts`（新，6 条契约用例）
- `apps/daemon/src/pipeline/setup.ts`（两处调用点：VAD / ASR 都要说出引擎；删掉手写的 `accept`）
- `apps/daemon/src/jobs/runners/transcribe.ts`（先定引擎再解析模型 + 一道响亮失败的闸）
- `apps/daemon/src/pipeline/vadResolve.test.ts`（前提断言改写 —— 旧写法现在编译不过了）
- `scripts/ci/e2e-record.mjs`（那条观测 → **判据**）

要点:

- **三平台全绿，每平台 21 条断言**（比上一轮多的那条就是新翻上来的门禁）。
- 选的是**结构性修法**，不是退而求其次。
- 顺带申报两件不体面的事（§5）：一次共享索引竞态把我的改动吞了、把别人的带了进来；
  以及我第一版的闸把"没装模型"说成"格式不对"，被别人的 T-164 回归用例当场抓住。

需要 Manager 决策: 无（§5 两条是申报，不是请示）。

### 1. 根因在哪一层

不在任何一个调用点。在**查询的形状**上：

```
resolveActiveModel(dir, 'asr')      ← 回答「这个 role 下的某个模型」
调用方真正要问的                     ← 「这个 role 下、**我这个引擎加载得动**的那个」
```

**引擎从来不是查询的一部分**，所以"把 A 引擎的模型交给 B 引擎"在类型上完全合法，
只能靠每个调用点自己记得加判断。于是同一根因换了四次面目：

| 面目                                            | 当时的补法                     |
| ----------------------------------------------- | ------------------------------ |
| T-148 sherpa 的 `silero_vad.onnx` 当成 whisper 的 VAD | 调用点加 `accept: isGgmlModelFile` |
| `by-name/asr` 下的 VAD 当成 ASR                 | 调用点加 `excludes:'silero'`（**按文件名**） |
| ASR 与 VAD 解析到同一个文件                     | 调用点加 `asrIsActuallyVad` 路径相等判断 |
| **本轮** `asr/sherpa-streaming-zh-14m` 交给 whisper.cpp | 前三道补丁**一个都没接住** |

前三道补丁**全都在 `setup.ts` 的同一屏里**，一道叠一道 —— 这本身就是根因还在的证据。

还有一处旁证：`pipelineFor()` 的返回类型注释自己写着
「**该引擎自己的**模型路径 —— 传错会让 sherpa 拿 ggml .bin 当 ONNX 加载而崩」。
**危险是已知的，只是被写成了散文**，没有任何东西执行它。

### 2. 我选了结构性修法，理由与代价

两条一起生效，缺一条都退回"靠记性"：

1. **`ModelQuery.engine` 必填** —— 不说"谁来加载"就拿不到路径。
   漏判不再是"忘了加一句"，而是**编译不过**。
   `[实测]` 这一条改完，`tsc -b` 当场逼出 **4 个**调用点（setup ×2、transcribe ×1、测试 ×1）。
2. **`MODEL_FORMAT_BY_ENGINE` 是 `satisfies Record<AsrEngineId, ModelFormat>`** ——
   将来加引擎，不声明它读什么格式就编译不过，而不是默默继承"什么都能读"。

判据仍是**文件内容**（ggml 那 4 字节正是 whisper.cpp 自己会检查的），
不是文件名、也不是安装记录里的字段 —— `InstallRecordLike` **根本没有 `engines` 这一项**，
按它过滤等于按一个不存在的东西过滤。陌生格式一律判"不能加载"：
错判成不能 → 用户看到"没有可用模型"；错判成能 → 用户看到引擎崩在一个看不懂的 exit code 上。

**代价（如实说）**：`resolveActiveModel` / `resolveModelById` 的签名变了，
调用方必须改。这正是我要的代价 —— 它是一次性的、编译器帮你找全的，
而旧的代价是"每个新调用点都可能再漏一次"，无限期、且只在用户机器上显形。

顺带**收敛**：VAD 那处手写的 `accept: isGgmlModelFile` 删掉，改由格式表回答。
本轮的意义就是不让同一条规则在每个调用点各写一遍。

另加一道**响亮失败**（这是 Manager 说的"退而求其次"那一档，我两档都做了）：
引擎与模型在 transcribe runner 里第一次真正碰面时对一次账，守的是**绕过解析器的那些路**
（`OPENMEMO_ASR_MODEL`、`scanByName` 兜底、用户手工拷进 `by-name/` 的文件）。
报错直接说出是谁拿了谁的模型，而不是 `whisper-cli exited with code 3`。

### 3. 三平台的自动重跑，实测是什么结果

| 平台         | e2e-record run   | 包（build-bundles run） | 结果             |
| ------------ | ---------------- | ----------------------- | ---------------- |
| linux-x64    | **31251250308**  | 31250595475             | ✅ **21/21** |
| win32-x64    | **31252050628**  | 31250595475             | ✅ **21/21** |
| darwin-arm64 | **31252656659**  | 31252437851             | ✅ **21/21** |

三平台那一条都是：

```
✔ ★ 停止录音后，产品自己发起的那次离线重跑必须成功
```

修复前同一条（run 31248849155，三平台一字不差）：

```
ⓘ 停止录音后自动排的离线重跑：failed
  {"code":"RUNNER_ERROR","message":"…/whispercpp-*/whisper-cli exited with code 3
   error: failed to initialize whisper context"}
```

**red → green 成对，两侧都是真产物、真 runner。**

### 4. 那条断言翻成门禁之后长什么样

```js
if (stopped?.rerunJobUid) {
  const st = await waitForJob(stopped.rerunJobUid);
  if (st.state !== 'succeeded') { /* 把 job.error 全文打出来再判 */ }
  judge('★ 停止录音后，产品自己发起的那次离线重跑必须成功', {
    ok: st.state === 'succeeded',
    reason: st.state === 'succeeded' ? 'succeeded'
      : `${st.state} —— ${st.detail}；用户录完音什么都没做错，这一步失败他只会看到一条转写任务挂了`,
  });
} else {
  judge('★ 停止录音后必须自动排一次离线重跑', { ok: false, reason:
    `没有排（segmentCount=…）。recorder.ts 只在流式产出 ≥1 段时才排 —— 所以这里红有两种读法：` +
    `要么排队那一段坏了，要么流式引擎这一轮一段都没识别出来。两种都要查。` });
}
```

两条要点：**"没排队"也是红**（否则一个把 enqueue 弄没的退化会把门禁静默关掉），
且红的时候**先把 `job.error` 全文打出来**再判 —— `waitForJob` 只截 400 字符，
第一轮真跑正好断在最关键的那个字上。

### 5. 申报两件不体面的事

**① 共享索引竞态：我的 commit 749c949 少了一半、还带走了别人两个 hunk。**

我按纪律做了 hunk 级暂存（`git apply --cached` 只放我那几个 hunk，并核对过
`git diff --cached --name-only` 与暂存内容里没有别人的标记）。**核对当时是干净的。**
但在 `git apply --cached` 与 `git commit` 之间，另一路 agent 提交了一次，
**共享索引被刷掉** —— 结果 749c949 里 `transcribe.ts` 只有对方的两个 hunk
（`mime` 那段注释、`hasVideo: result.media.audioOnly === false`），我的一个没进。

- 我的改动一直安全地留在工作区，已在 **66718b0** 原样补上并当场 `git show` 核对。
- 对方那两个 hunk 的**内容是对的、也是他们想要的**，所以我**没有回滚** ——
  回滚等于把别人的成果从 master 删掉。代价是那两处的作者署名记在了我的 commit 上，
  **在此申报**，请对方知悉（他们再提交时会发现那两处已无差异，不会重复）。
- 教训：**`git diff --cached` 的核对只在"核对那一刻"成立。** 共享索引下，
  暂存与提交之间存在窗口，而窗口里别人的一次提交就能把它清空。
  可靠的做法是 `git commit -- <pathspec>`（直接读工作区，不经过索引）
  或在独立 worktree 里提交。后面几个 commit 我都改用了前者，并且**提交后立刻 `git show` 核对**。

**② 我第一版的那道闸把"没装模型"说成"格式不对"。**

`canEngineLoad` 对"文件不在"和"格式不对"都回 false —— 挑候选时这样很对，
但在那道闸里它们是两回事。第一版没分，`mergeWords.test.ts` 里 **3 条 T-164 回归用例当场红**
（它们的夹具声明了一个从不创建的 modelPath）。**那个红是对的，红的是我这道闸**（df2310d 已修）。
一道用来"让失败可诊断"的闸，第一版自己把人往错误方向指 —— 记在这里。

### 6. 别人的东西，我没动，但报一下

- `scripts/ci/resolve-bundle.mjs`（2824e03 提成的共享脚手架）**没有先建输出目录**，
  直接 `tar -C <out>` → 三条 e2e 腿一起红在
  `EXTRACT_FAILED — tar: unpacked: Cannot open: No such file or directory`
  （`[CI 实测]` run 31250861440）。**我没有改他们的脚本**，只在自己的 workflow 里
  加了一行 `mkdir -p unpacked` 解堵（86f1706）。他们随后自己修好了（脚本里已有 `mkdirSync`），
  我那一行现在是无害的幂等，可删。
- 同一次重构把 `--require runtime/node` 写死了，Windows 上包自带的是 `node.exe` ——
  win 腿红在 `MISSING_ENTRIES 缺 1 项：runtime/node`，而**包其实是好的**
  （`[CI 实测]` run 31251628013，一个纯粹的假红）。他们已用 `--require-node-runtime` 修好（0853b8e）。
- `build-bundles` 的 macOS 腿一度红在**别人新加的**「模拟用户动作（Gatekeeper）」步骤上
  （`ditto: cpio read error: bad file format`），且它排在 upload-artifact 之前，
  于是**拿不到 macOS 包**。我等他们修好后才跑成 macOS 那一腿（包 = run 31252437851）。

### 7. 门禁（在**独立 worktree** 里跑我自己那个 commit，不受别人在途改动干扰）

工作区当时有三路 agent 的未提交改动，所以按 Manager 说的另开 worktree
（`git worktree add --detach <我的 commit>`，`node_modules` 用链接，
**但 `@openmemo/*` 重新指向 worktree 自己的包** —— 第一次没重指，
结果 tsc 红在别人**未提交**的 `BuildRegistryOptions.proxy` 必填上，那不是我的红）。

| 门禁              | 结果                                        |
| ----------------- | ------------------------------------------- |
| `pnpm -r test`    | **1558 / fail 0**（基线 1552，+6 = 我新增的 6 条契约用例） |
| `tsc -b`          | 0                                           |
| `eslint .`（全仓）  | 0                                           |
| `prettier --check .`（全仓） | 0                                |
| `lint-workflows`  | 1147 条断言全过（13 个 workflow）           |
| `test:ci-scripts` | 0（22 passed）                              |
| `check:orphans`   | 零引用导出 **70**（基线 70），无新增        |

基线只升不降那一侧：测试 1552 → 1558（只加不减），orphans 70 → 70。

### 8. 仍然没收口的

- **`?t=` "点了真的跳过去"** 仍是 `UNKNOWN` —— 要一条带浏览器的腿。服务端一侧已验（命中的 `startMs` 落在真实段落起点上）。
- **`GET /api/notes/:uid/anchors` 恒 0 个锚点**：锚点要正文里有 `[[t:…]]`，录音笔记没有。是 `ⓘ`，不是绿也不是红。
- **流式识别的准确率**：目录里唯一的流式 ASR 是中文模型，样本是英语，所以识别**内容**不作判据（只判"音频真的被收到并处理了"）。要验中文流式质量得先有中文样本。
- `macos-14` vs `macos-26` 那条差异同上一份回执 §7，仍待 Manager 确认。
