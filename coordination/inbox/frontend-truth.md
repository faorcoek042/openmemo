# inbox / frontend-truth

## [2026-08-06 15:30] T-150 DONE（① 做完 · ② 6 项做完 5 项，第 6 项卡在一个不存在的端点）

交付: 提交 `f02332a`（18 个文件，逐个 `git add`，零 `-A`；`git show --stat` 核对过只有这 18 个）
需要 Manager 决策: 见 §7

---

# TL;DR

## ① 自检结果现在在界面上看得见了，而且分得出 ok / warn / fail

`GET /api/selfcheck` **早已存在**（`[实测]` demo 上返回 **25 条 / 200**），而 web 全仓**零调用点** ——
`remediation` 与 `vad-fix` 各查到一半，合起来是同一个洞。后果是具体的：自检里
「转写引擎缺失 / 中文分词退化 / 交给 whisper 的 VAD 权重它加载不了 / yt-dlp 没装」
这 20 多条结论，**用户在界面上一条都看不到**。

`/diagnostics` 现在页首就是「功能自检」区块：

| 做了什么 | 判据 |
|---|---|
| 按 `layer` 分组渲染**全部**检查项 | 分组顺序取数据里的首次出现顺序，**不写死 layer 白名单** —— 写死会让"daemon 新增一层"= "界面上悄悄少一层" |
| ok / warn / fail **三档视觉互不相同** | 断言里除了 `data-level` 还断**图标 class 三个值互不相同**：只断我自己写的属性，把三档全画成绿勾照样能过 |
| `required` 的失败项单独标出来 | "坏了"和"降级了"不是一回事 |
| 服务端算好的 `remediation` 原样显示 | daemon 连修复建议都发过来了，此前一个字都不显示 |
| 端点拿不到（老 daemon）→ 明说，且**不带塌整页** | 空白会被读成"没什么可报的" |
| 返回空集 → 明说**不算"一切正常"** | ⑤A-2「node --test 对空集返回绿」的同族 |
| **不设 `refetchInterval`** | 它会真跑子进程枚举设备、真建 FTS5 临时表、真读 8 条 `.so` 链。每 15 秒替用户跑一遍是拿他的 CPU 换一个他没在看的数字。跟着「重新检测」走（两个数据源一起刷） |

**那句过期注释**（`DiagnosticsPage.tsx:29`「selfcheck 只是 CLI、没有对应的 HTTP 端点」）
已订正 —— 但**不是删掉，是改写成一条带证据的订正**，保留了"曾经写着什么"（HANDOFF ⑤D-bis 的做法，
`DataLocationSection` 那次就是这么处理的）。理由：两名 agent 先后据它得出同一个错误结论，
下一个人需要知道**这里改过**，而不是看到一段没有历史的新文字。

> ⚠️ 我**没有**给这条加"源码里不许出现某句话"的正则护栏。
> 那正是今天触发六次的陷阱（`/\bEmphasis\b/` 匹到自己旁边的注释）：
> 我的订正文字里必然引用那句过期的话，正则会匹到我自己。
> 钉后果的那条护栏是「页面真的发出了 `GET /api/selfcheck`」——撤掉它当场红（§6 R3）。

## ② D-10 剩余 6 项：**做完 5 项，第 6 项卡死**

| # | 状态 | 一句话 |
|---|---|---|
| **#24** 24 家供应商目录 | ✅ **做完** | 写死的 11 个预设整体作废，换成目录 24 家 + `bucketProviders()` 三桶。**顺带拆掉了 D-10 §8-D1 那颗雷的前端一半**（见下） |
| **#27** `configFieldKeys` 表单 | ✅ **做完** | 字段逐家渲染；地址栏三档；目录声明但 daemon 不读的字段不给控件、但明说 |
| **#26** 刷新分流 | 🟡 **分流做了，按钮没做（有理由）** | 见下，**这是本轮唯一一处我主动偏离了 D-10 的字面要求** |
| **#28** 空状态 | ✅ **做完** | 说清为什么空 + 六个按钮在眼前 + **一家都不预选**（渲染一次零写请求） |
| **#9 / #10 / #29** 转写三分组 | ✅ **做完** | 推荐 / 实时字幕组件 / 更多档位（`speedClass` 三挡 + `superseded` 折叠）。VAD 与标点终于渲染得出来 |
| **#3** 探测式本地模型 | ❌ **没做，卡死** | `POST /api/llm/detect` **至今不存在**（`[实测]` daemon 路由表里没有）。`detectLocalBackends()` 只在 `jobs/runners/mindmap.ts` 与 `rest/selfcheck.ts` 内部调用。做出来只能是个假按钮 |

### #24 的真正难点不是"把 24 家列出来"，是**目录的 `kind` 和 daemon 的 `kind` 同名不同物**

`[读码]` 两个 `kind` 之间**没有任何编译期联系**：

```
vendor/manifests/llm-providers.json   kind ∈ {openai-compatible, anthropic-native,
                                             anthropic-compatible, google-native,
                                             mistral-native, ollama-native}      ← 协议族，6 种
settings['llm.providers'][i].kind     daemon 的 switch 只认
                                      {openai-compatible, anthropic, gemini}     ← 行为契约，3 种
```

**把目录的 kind 原样写进设置，Anthropic 会落进 `resolve.ts` 的 default 分支** ——
打一条 error、返回 `undefined`，用户看到的是"没配 LLM"，**而他明明刚配完**。

D-10 §8-D1 记的那颗雷 **daemon 侧已经拆了**（它现在按 `kind` 分派、不再按 id 字面量），
**但那次只拆了一半**：谁来把目录的 kind 翻译成行为契约，一直没人管，
因为在 #24 做之前根本没有人往设置里写目录数据。这一半今天补上了：

- `WIRE_KIND_BY_CATALOG_KIND` 是**总 `Record`** —— 目录新增一种协议族而没人表态，**构建就红**；
- 值为 `null` = 我们没有能驱动它的适配器 → 那家在界面上**照样列出来但点不动，并当场说明原因**。
  悄悄抹掉会让用户以为"这个产品不支持它"，而事实是"我们还没写它的适配器"。

**另一处同型的坑（这条 D-10 没提，是我对着适配器源码逐条核出来的）**：
目录里的 `baseUrl.default` 是**厂商文档上的地址**，不一定是我们适配器该收的那个，
两边各自往上拼路径，拼重了拼漏了都不报错：

| 家 | 目录给的 | 适配器还会拼 | 原样用的后果 |
|---|---|---|---|
| `gemini` | `…googleapis.com/v1beta` | `/${API_VERSION}`（`gemini.ts:164`，`API_VERSION='v1beta'`） | 请求 `…/v1beta/v1beta/models/…` |
| `ollama` | `http://127.0.0.1:11434` | `/chat/completions`（`openai-compatible.ts:119`） | 打到 Ollama 原生 API 的根上，不是 `/v1` |

`adapterBaseUrl()` 逐条校正并把理由写在旁边，测试钉的是**后果**（"不许以 `/v1beta` 结尾"），
不是"某个字段存在"。

### #26：**我把"按钮只给 4 家"改成了"一个按钮都不给"，这是本轮唯一一处偏离规格**

R-P2 的原话是「「刷新模型列表」按钮**只对** `canRefreshModelList(p)===true` 的 4 家渲染」。
实际做的时候撞上一条更硬的事实：

> `[实测]` **全仓没有任何端点能替前端枚举某家的模型** —— daemon 路由表里没有
> `/api/llm/models` 一类的东西（`grep` 全部 `'/api/…'` 字面量，46 条路由，一条都不是）。

所以那 4 家的按钮**同样是按不动的**。R-P2 想挡的正是"按不动的按钮"这件事，
它对 20 家成立的理由对 4 家一字不差地成立。→ **分流落在措辞上，三档各说各的真话**：

- 20 家 `official-doc`：「内置清单 N 个 · 核对于 {{date}}，可能已过时」
- 4 家 `official-api`/`local-api`：「N 个 · 这家支持程序化刷新，但本地服务还没有对应接口」
- 不在目录里：「没有内置清单 —— 请选「自定义…」」

护栏两条：三档的**话必须不一样**，且**任何一档都不许有刷新按钮**。
（⚠️ 我第一版这条断言写的是 `assert.notEqual(a.txt, b.txt)` —— 反向验证时**它没红**，
因为两家的条目数和日期本来就不同。**那条断言钉住的是零**，已换掉，见 §6 R7。）

### #9/#10/#29：VAD 与标点终于渲染得出来 —— 而且**没有塞进转写列表**

`ModelsPage` 原来写死 `g.role === 'asr'`，`role=vad`（2 变体）与 `role=punctuation`（1 变体）
**在网页上一个都不存在**。你追加的那条说得对，后果比"少两张卡"重：

> daemon 的 `model.vad` remediation 写着「在「模型」页安装 `vad/silero-vad-ggml`」，
> **而那一页不渲染 VAD** —— 一条具体但无法执行的指引，用户会照着去做然后怀疑是自己没找到。

按你的提醒，我**先想了它该在哪一组**，结论与 D-10 §4.1 一致：进「**实时字幕组件**」，
和 sherpa 流式并列 —— 那一组的语义是「**一条链路上的三个零件，不是彼此的替代品**」。
分组判据是数据（`role ∈ {vad, punctuation}` 或 `tags` 含 `required-for-f3`），不写死 id。
测试有两半：**在 realtime 里** 且 **不在其它任何一组里** ——
只断前一半的话，"随手把过滤器放宽"照样绿（§6 R6 实测：那种改法只让"另一半"红）。

**顺带查出并修掉一处同源的坑**：`vad/silero-vad` 那一组两个变体的 `quantization`
**都是 `f16`**，差的是 `engines`（`sherpa-onnx` vs `whisper.cpp`，互相加载不了）。
量化选择器只标量化档 ⇒ **两行逐字相同的「F16」**，而 daemon 恰恰让用户来这里挑出 ggml 那一个。
选错的后果 T-148 已经付过一次（`bad magic` → 整单转写死）。
→ 同一组里 `engines` 真的不同时，选择器把 engine 一起标出来。判据是"这两个不可互换"的直接证据，
不是"role 是不是 vad"（后者只是它今天恰好的载体）。

**`required-core` 已确认在 web 侧零引用**（`grep apps/web/src` 0 命中），无死代码要清。

## ③ 三件顺带的（都不在题面里，但都是同一族缺陷）

1. **`NoteSummary` 换成共享契约**（补 `daemon-contract` 在 T-151 留下的那一半）。
   `source` / `coverAssetUid` / `folderUid` daemon 的列表端点**一个都不发** →
   `NotesListPage` 的**站点徽章在真实产品里从未渲染过**（用了可选链所以不崩，安静得多）。
   换成 `NoteListItem` 之后**当场编译报错三处**，那就是这次改动的反向验证本身（§6 R8）。
   徽章**删掉不是改名**，理由写进了注释：要在列表上显示来源，正确顺序是先在契约里加字段
   （加了这里会编译报错提醒有人来渲染它），而不是先在界面上摆一个空位。
   **同时把 mock 的列表响应改成逐字段投影** —— 它原来把整条 `MockNote`（含详情端点的字段）
   `as T` 扔出去，"mock 比真响应宽"这条缝一直开着，而那正是这一族缺陷的成因。
2. **模型卡描述走 `<Emphasis>`**：`vad/silero-vad` 的 `descriptionZh` 里带
   `**sherpa-onnx 引擎专用格式**`，此前**裸星号原样吐给用户**。与 T-129 修的那族同形，
   只是这次文字来自 **manifest** —— `EMPHASIS_REGISTRY` 那条护栏只扫 locale 文件，**扫不到 manifest**。
3. **`wavesurfer.js` 的裁决：不接，该删。** 见 §5。

---

# §2 交付清单（精确，18 个文件）

**新增**
- `apps/web/src/features/models/asrSections.ts` —— 转写 Tab 分组规则（纯函数）
- `apps/web/src/features/models/asrSections.test.ts` —— 10 条

**修改**
- `apps/web/src/features/diagnostics/DiagnosticsPage.tsx` —— 自检区块 + 订正过期注释
- `apps/web/src/components/common/llm/llm-catalog.ts` —— **重写**：`LLM_PRESETS` 作废，目录驱动
- `apps/web/src/components/common/llm/LlmSettingsSection.tsx` —— **重写**：三桶 / `configFieldKeys` / 空状态
- `apps/web/src/components/common/llm/LlmModelSelect.tsx` —— #26 分流措辞 + `-note` testid
- `apps/web/src/features/models/ModelsPage.tsx` —— 三分组渲染 + `ASR_TAB_ROLES`
- `apps/web/src/features/models/components/QuantSelector.tsx` —— 变体只差 engine 时标出 engine
- `apps/web/src/features/models/components/ModelCard.tsx` —— 描述走 `<Emphasis>`
- `apps/web/src/features/notes/NotesListPage.tsx` —— 删掉从未渲染过的站点徽章
- `apps/web/src/lib/api/types.ts` —— `NoteSummary` = `NoteListItem`
- `apps/web/src/lib/api/mock.ts` —— **SHARED-CHANGE**，列表响应逐字段投影
- `apps/web/src/lib/api/notesCache.test.ts` —— 夹具收窄到真实形状
- `apps/web/src/lib/format/peaks.ts` —— wavesurfer 裁决写在这里
- `apps/web/src/app/i18n/locales/{zh-CN,en}.json` —— 新增 30 键（**两份对称**）
- `apps/web/src/test/components.test.tsx` —— **SHARED-CHANGE**，追加 22 条 + 订正 4 条旧断言
- `apps/web/tsconfig.test.json` —— 登记 `asrSections.test.ts`（显式白名单）

---

# §3 门禁

```
apps/web  tsc      0
apps/web  eslint   0
apps/web  单测     103 pass / 0 fail   （新增 10 条：asrSections）
apps/web  宿主     10  pass / 0 fail
apps/web  组件     226 pass / 0 fail   （新增 22 条：T-150 ① 6 条 + ② 16 条）
```

`pnpm -r test` 逐包：`llm 18/0` · `db 53/0` · `mindmap 51/0` · `pipeline 187/0` ·
`apps/web 103+10+226 全 0 fail` · `apps/daemon 311/0` ·
🔴 **`packages/runtime 26 pass / 25 fail`**。

> **那 25 条不是我的。** `[实测]` 是 `catalog-truth` 的在途改动：
> `selfcheck.ts` 加了必填探针 `installedByRole`，而 `selfcheck.test.ts` 还没跟上
> （`grep installedByRole selfcheck.test.ts` = **0**），
> 报错全是同一句 `TypeError: input.probes.installedByRole is not a function`。
> `git status` 显示 `packages/runtime/src/{selfcheck.ts,index.ts,selfcheck.test.ts}` 均在他名下。
> 同理 `tsc -b` 在 `packages/runtime/src/selfcheck.test.ts(39,3)` 红一条 ——
> **我一个字没碰 `packages/runtime`**。

---

# §4 反向验证（12 组，全部贴过真实红灯）

> 方法：改一处 → 跑 → 贴红 → 还原。每组都确认过 `grep -rn REVERSAL src/` 归零。

| # | 撤掉什么 | 红了哪几条 |
|---|---|---|
| **R1** | 三档图标全画成绿勾 | `✖ 三档共用了同一种画法 → ["…text-good","…text-good","…text-good"]` |
| **R2** | 整块自检区块 | 4 条（条数对不上 / warn 项没出现 / 拿不到时不说话 / 空集当绿灯） |
| **R3** | 查询改指回 `/api/health` | `✖ 诊断页没有请求过 /api/selfcheck，实际请求：["GET /health","GET /health"]` |
| **R4** | 「重新检测」只刷一半 | `✖ 「重新检测」只刷了 /api/health，自检那一半停在旧结果上` |
| **R5** | 目录只放出一部分家 | `✖ 这些服务商在界面上没有任何落点` + `✖ mistralai 从清单里消失了` |
| **R6** | `kind` 原样写进设置 / 不校正 baseUrl | `✖ claude 写进设置的 kind=anthropic-native，daemon 的 switch 认不出来`<br>`✖ GeminiProvider 会再拼一次 /v1beta` |
| **R7** | 表单退回"三件套 + 靠 isLocal 猜" | `✖ 按 isLocal 把 Key 框藏掉了` + `✖ mistralai 界面却给了一个可编辑的框` |
| **R8** | 清单出处不分流 | `✖ #26：人工转录的清单与可枚举的清单，说的话必须不一样` |
| **R9** | 拆掉出厂空状态 | `✖ #28：出厂空状态说清为什么空、下一步点哪，且一家都不预选` |
| **R10** | `ASR_TAB_ROLES` 退回 `['asr']` | 3 条（VAD 组不对 / VAD 卡片不在 / 描述那条也塌） |
| **R11** | VAD/标点直接混进转写列表 | 组件 1 条 + 单测 2 条（`✖ 而且只在那里`） |
| **R12** | superseded 平铺 / 选择器只标量化 / 描述不走 Emphasis | 各 1 条，含 `✖ 两个互相加载不了的变体在选择器里长得一模一样` |

## ★ 我自己写坏的两条断言（记账，HANDOFF #18 那条规矩当场兑现了两次）

1. **`assert.notEqual(a.txt, b.txt)` 钉住的是零。** 反向验证 R8 第一次跑**没红** ——
   两家的条目数与核对日期本来就不同（30/2026-05-31 vs 4/2026-05-02），
   哪怕分流整条拿掉、两边走同一句模板，它照样绿。
   换成按"说了什么"断（人工转录那档必须带日期，可枚举那档必须不带）之后当场红。
2. **`#27 Ollama 那条也钉住了零。** 旧规则「`isLocal` 就不给 Key 框」与新规则
   （`configFieldKeys`）对 Ollama **给出同一个答案**，所以把实现退回旧规则它照样绿。
   补了 **LM Studio** 那条：它**是本地服务，但目录里声明了 `apiKey`** ——
   这才是把两条规则分开的那个样本。补完之后 R7 才真的红。

另有一条**期望值写法本身恒真**（`.sort((a,b)=>actual.indexOf(a)-actual.indexOf(b))`
让 deepEqual 对任何排列都成立），也已换成直接比数组。

---

# §5 `wavesurfer.js`：**不接，该删**（你问的那条）

`[读码]` 现状：`package.json` 里挂着 `^7.12.11`，**全仓零 import**；
而 `features/player/Waveform.tsx` 已经用 112 行 canvas 把 `.ompk` 峰值画出来了，
`NoteDetailPage.tsx:93` 是 `decodeOmpk` 的第一个调用方（T-151 之后真的有数据了）。

判据不是"哪个更好看"，是**它能替我们做的那件事，我们刚好不要**：

1. wavesurfer 的核心价值是「**在浏览器里解码音频** + 画 + 交互」。
   **解码那一半我们明确不做** —— `decodeAudioData` 一个 2 小时的文件占数百 MB 并阻塞主线程
   （D-01 §5 F5 定的），峰值改由 daemon 预生成。接进来只用得上它的绘制层。
2. 绘制层这边我们有两条它给不了的性质：**完全不进 React**（播放位置 ~10Hz，走 React 拖垮整页）
   与**直接读 CSS 变量**（明暗主题切换零 JS 参与）。换成它这两条都得自己再补一遍。
3. 留一个零 import 的依赖，最贵的不是 1.5 MB 和许可证清单里那一行，
   而是**它让读代码的人以为波形是它画的** —— 与本轮修的那几处过期注释同一种成本。

**结论写进了 `lib/format/peaks.ts` 的文件头**（那是全仓唯一还提到 wavesurfer 的地方），
`.ompk` 格式本身不绑任何库，删掉它这个文件一个字节都不用改。

⚠️ **执行归 `debt-cleanup`，我没做**：删依赖要动 `pnpm-lock.yaml`（全仓共享）+ 跑一次
`pnpm install`，而此刻至少三名 agent 在跑测试。命令就一行：
`pnpm --filter @openmemo/web remove wavesurfer.js`。

---

# §6 我没做 / 做不到的（如实列）

| 项 | 状态 |
|---|---|
| **D-10 #3 探测式本地模型** | ⛔ **卡死**。`POST /api/llm/detect` 至今不存在（`[实测]` daemon 路由表 46 条，无此项）。Ollama/LM Studio 仍留在「常用」桶里（它们本来就在目录的置顶六家中），**没有** D-10 §4.2 那个折叠的 `[探测本机]` 组。做出来只能是个假按钮 |
| 「刷新模型列表」按钮 | ⛔ **故意不做**，理由见 #26 那段。**需要 daemon 侧先有 `POST /api/llm/models`** |
| `mistralai` | ⛔ **驱动不了**：`mistral-native` 没有适配器，且它的 `baseUrl.default` 是 `null` + `editable:false`，连"当成 OpenAI 兼容凑合用"所需的地址都拿不到。界面上**列出来但点不动 + 说明原因**，没有编一个 `https://api.mistral.ai/v1` 出来 |
| 装完 VAD 后卡片会不会显示"已安装" | 🟡 **未验，且我怀疑不会**。`catalog-truth` §5-1 报了 `state.ts:291` 的 `listInstalled()` 只列 `['asr','llm']` 两个桶 —— 那意味着装好的 VAD 不会出现在 `GET /api/models/installed` 里。**那是 daemon 侧**，我没碰。渲染这半已经就位，那半修好即可闭环 |
| `geminiProvider` 的地址校正 | 🟡 **只在本机按源码推演**，没有真发过一次 Gemini 请求（没有 Key，也不该拿用户的 Key 去试） |
| 真浏览器验证 | ⛔ **一次都没开**。三块新界面（诊断自检区块 / 24 家三桶 / 转写三分组）**只有 tsc + eslint + 236 条组件/单测背书**，排版与观感未经人眼确认。这是本轮我唯一不能自证的一环 |
| `role=vad` 的 `notRecommendedForLanguage` 过滤 | 🟡 未特殊处理：VAD/标点走的是与 ASR 同一条 ADR-011 过滤。目录里它们没有 `notRecommendedFor`，所以今天不受影响 |
| D-10 §4.1.3 的「空档位兜底文案」 | ⛔ **没做，也不该做**：那是给"语言 × 档位"二维矩阵用的，而 **R-M2 明确禁止按 `languages` 排他筛选**。我只按 `speedClass` 一维分档，空档直接不渲染（画一个空标题只会让人问"是不是还没做完"） |

---

# §7 需要 Manager 决策

1. **`POST /api/llm/detect` 派给谁？** D-10 #23 原本派 `oss-scout`，至今未交付。
   没有它，D-10 #3 与 §4.2 的整个「本地模型」折叠组都做不了 —— 现在 Ollama/LM Studio
   靠"预填好本机地址 + 不要 Key"凑合可用，但那是**让用户猜自己装没装**，正是 ADR-016 档 2 想避免的。
2. **`POST /api/llm/models`（枚举某家的模型）要不要做？** 有了它 #26 的按钮才有意义
   —— 只对 4 家（openrouter / siliconcloud / ollama / lmstudio），其余 20 家仍然只显示 `checkedAt`。
   **没有它之前我不会加这个按钮。**
3. **`listInstalled()` 只列 asr/llm 两个桶**（`catalog-truth` §5-1 已报）：
   现在 VAD/标点在界面上看得见、装得动，但**装完可能不会显示"已安装"**。
   建议与他那条并成一张单派给 `model-mgmt`。
4. **`wavesurfer.js` 删除动作**给 `debt-cleanup`（§5，命令一行）。
5. **`packages/runtime` 现在红 25 条**（`catalog-truth` 在途，`selfcheck.test.ts` 没跟上新探针）。
   合并前需要他补完，否则 `pnpm -r test` 不绿。

---

# §8 纪律核对

| 条 | 结果 |
|---|---|
| `apps/web/dist` 未被覆盖 | ✅ `index.html` 时间戳仍是 `2026-08-06 02:15:09`（我动手前）。**全程没跑过 `vite build`（组件测试走的是 `--ssr --outDir .test-out/`，不碰 dist）**，也没跑 `pnpm -r build` |
| `:10000` 只读 | ✅ 只发过 3 次 GET（`/api/selfcheck` ×2、`/api/models/catalog` ×1）。未重启、未 kill、未占用 |
| 自起服务 | ✅ **一个都没起**（本轮全部验证走 node:test + jsdom，不需要真 daemon）。端口 `5194/5196/5199/5203/5207/5211/5231` 一个都没碰 |
| `/root/data-memo` | ✅ 未读未写，mtime 仍是 `2026-08-06 02:15:14` |
| `datadir.json` 指针 | ✅ sha256 `7f930979…0da233f3`，内容仍是 `{"dataDir":"/root/data-memo"}`，未碰 |
| `pkill -f` | ✅ 未用（本轮没起过任何进程） |
| `git add` | ✅ **逐个文件，18 个，零 `-A`**。`git status` 对过在途改动：`apps/daemon/**`、`packages/runtime/**`、`scripts/selfcheck.mjs`、`apps/daemon/src/pipeline/roleBucket.test.ts` 是别人的，**一个都没 add**。`git show --stat f02332a` 核对只有我这 18 个 |
| 字面 NUL | ✅ 提交前扫过 `apps/web/src/**` 全部文件：**0 命中**。⚠️ 中途我确实在测试里写过 `'\x00'` 这个**转义序列**（源码里是 4 个 ASCII 字符，不是 NUL 字节），已经换成 `'__no_checked_at__'` —— 你报的那次瞬时 NUL 很可能与它有关，现在这条路径没了 |
| 临时文件 | ✅ 在 `/tmp/frontend-truth/`（仓库外） |
| 变异体残留 | ✅ `grep -rn REVERSAL apps/web/src` = 0 |

## SHARED-CHANGE 申报（两处）

| 文件 | 我做了什么 | 冲突风险 |
|---|---|---|
| `apps/web/src/test/components.test.tsx` | 末尾**追加** 3 个 describe（22 条）；**订正 4 条旧断言**（详见下） | 🟡 中 —— 这个文件多人写 |
| `apps/web/src/lib/api/mock.ts` | `MockNote` 去掉 `coverAssetUid`/`source`，`/notes` 响应改逐字段投影 | 🟡 中 —— `daemon-contract` 上一轮刚改过它 |

**订正的 4 条旧断言（不是删，是换了判据并写明为什么）**：
- 「在线优先：预设里在线排在本地之前」→ 依据从写死的 `LLM_PRESETS.tier` 换成目录的
  `MAINSTREAM_PROVIDER_IDS` 顺序（那张写死清单已作废）；
- 「每个预设都必须有候选」→ 范围从"11 个预设"扩到"整份目录 24 家"，
  并把它注释里那句「那一步是 D-10 #24，本轮没做」订正成"已做"；
- 「英文界面不许中文」里剥品牌名的数据源 `LLM_PRESETS` → `CATALOG_PRESETS`；
- `#26` 与 `#27` 两条**我自己写的**弱断言（§4 末尾那两条），当轮换掉。

**给 `catalog-truth`**：你 §4-3 报的「`model.vad` 的 remediation 指向一个不渲染 VAD 的页面」
——**渲染这半已经修好**（VAD 与标点进「实时字幕组件」组，量化选择器会把
`sherpa-onnx` / `whisper.cpp` 标出来，用户挑得出 ggml 那一份）。
你那半（`roleToStoreKind` / `listInstalled`）修好即可闭环，见 §7-3。
