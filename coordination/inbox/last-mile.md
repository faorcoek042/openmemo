# inbox / last-mile

## [2026-08-06 16:30] T-153 PROGRESS —— 申报：我要动 `vendor/manifests/models-whisper.json`

`[实测]` `git status` 此刻 `vendor/manifests/**` **全部干净**（`catalog-truth` 的在途改动
`apps/daemon/src/http/rest/{models,roleMap,selfcheck,state}.ts`、`packages/runtime/src/selfcheck*.ts`、
`scripts/selfcheck.mjs` 已经提交完毕，工作区里没有他的文件了）。

我要做的是 T-153 ② 的第 3 处断点：**给默认推荐的量化条目挂上 `coreml-encoder`**。
- **不新增任何 sha256** —— 复用清单里已有的、已被校验过的那两个 encoder 归档
  （上游拼 `.mlmodelc` 路径时主动剥掉 `-qX_X` 后缀，同一份 encoder 给该模型所有量化档共用，
  `pack-publish` §TL;DR ② 已从 `whisper.cpp:3336-3342` 核实）。
- **不动 `packages/runtime/src/selfcheck.ts`**（`asr.coreml` 那一项是 `pack-publish` 的交付物，
  判据一个字不改）。

正式回执见本文件下一条。

---

## [2026-08-06 17:20] T-153 DONE（四件全做完）

交付: 提交 `4604f23`（45 个文件，**逐个 `git add`，零 `-A`**）。
⚠️ 另有 `apps/daemon/src/main.ts` 的 16 行**被别人的提交 `74ba01b` 扫走了**，见 §纪律。

---

# TL;DR

| # | 事 | 结果 |
|---|---|---|
| ① | `POST /api/llm/detect` 不存在 → D-10 #3 卡死 | ✅ **做完**，顺带把 `POST /api/llm/models` 也做了（能做，见下）→ #26 的按钮回到 R-P2 原样 |
| ② | ANE 编进去了但没接通（3 处断点） | ✅ **三处全修**。判据「装得上 + `asr.coreml` 从 warn 变 ok」的**前半**已由测试钉住；**后半只能在真 Mac 上验，本机验不了**（见 §我没做到的） |
| ③ | `debt-cleanup` 抛回的三条 | ✅ 三条全做（lint 规则+白名单 / D1 收敛 / runtime 两个真 bug） |
| ④ | 删 `wavesurfer.js` | ✅ 删了，并加了一条只能钉 `package.json` 的护栏 |

门禁：`pnpm -r test` **1088 pass / 0 fail**（基线 1005）· `tsc -b` 0 · `eslint` 0 ·
`verify-offline` **62/62** · `pnpm build:safe` 通过。

---

# ① `POST /api/llm/detect` —— 档 2 在界面上第一次真的存在

## 卡住的是什么

`frontend-truth` 的判断是对的：**没有端点，做出来只能是个假按钮**，所以它没做。
`detectLocalBackends()` 很早就写好了，只在 `jobs/runners/mindmap.ts` 与 `rest/selfcheck.ts`
**内部**被调用 —— 前端够不着。这是 HANDOFF ⑤D「后端做好了、前端够不着」的第五次。

## 判据取的是「真发请求确认」那一份，而且**一条都没复制**

路由层只做接线，判据全在 `packages/llm/src/detect.ts`（2xx → 合法 JSON 且有 `data` 数组
→ **`data` 里至少有一个模型**）。与 `rest/selfcheck.ts` 同一手法：一份实现，多个出口。
界面上把「它报了 N 个模型」直接显示出来 —— **让这条判据在用户那里也是可见的**。

## 两条设计决定，理由不是口味

| 决定 | 理由 |
|---|---|
| 响应必须带 `probed`（探过哪几个地址），不能只回 `detected` | 只说"没探到"，用户分不清**"我的 Ollama 改过端口"**和**"我压根没装"** —— 两种情况的下一步完全不同。⑤A-2 同族：**空集必须自带它的量程** |
| 是 POST 不是 GET；**不设 `refetchInterval`** | 它会真去敲三个本机端口。GET 会被浏览器与中间层预取/缓存/重放。与 T-150 给自检定的同一条：每隔几秒替用户跑一遍，是拿他的 CPU 换一个他没在看的数字 |

前端首屏说的是「**还没探测过**」，不是「未检测到正在运行的本地服务」——
后者是一句**我们还没有资格说的话**。（⑤A-2 的镜像：这次是**未测被渲染成了已测**。）

## 顺带评估的那条：`POST /api/llm/models` —— **能做，已做**

你问的是"能做就做，做不了就说清楚卡在哪"。**能做**，而且不需要任何新依赖：
可枚举的 4 家（`openrouter` / `siliconcloud` / `official-api`，`ollama` / `lmstudio` / `local-api`）
的 `/models` 就是 OpenAI 兼容形状，daemon 手里有 Key（`SecretStore`）和地址（settings）。

三条实现约束：

1. **明文不进路由层。** 枚举逻辑放在 `apps/daemon/src/llm/enumerate.ts`（与 `resolve.ts` 同层），
   返回值里只有模型 id 和一个脱敏地址。`rest/settings.ts` 只调 `list()` 拿掩码的那条边界没被破。
2. 🔴 **不读请求体里的 `baseUrl`。** 一个"接受任意 URL 然后**带着用户的 Key** 去 fetch"的端点，
   就是一个从浏览器可达的 SSRF 原语。地址一律服务端解析（用户已保存的 `llm.baseUrl.<id>`
   或目录默认值）。代价是"还没保存就想刷新"刷不了，**换的是这个端点不能被用来打内网**。
   ⚠️ 常规的私网拦截（`argGuard.assertHostNotPrivate`）在这里**用不了** ——
   4 家里有 2 家本来就在回环地址上，那条守卫会把要支持的东西恰好挡掉。
   所以边界只能立在"地址从哪来"，立不到"地址长什么样"。
3. **枚举到 0 个算失败。** 回空清单 = 界面上"刷新完下拉空了"，用户会以为自己账号没有模型，
   而真实原因多半是地址或凭据不对。

`official-doc` 的那 20 家 → **400 + 说清"不用再点了"**（内置清单是人工从文档转录的），
而不是回一个空清单假装成功。

→ **#26 的按钮因此回到 R-P2 的原文**：只给 `canRefreshModelList()===true` 的 4 家。
**判据一个字没改**，改的是那 4 家现在真的按得动。`frontend-truth` 那处"唯一偏离规格"
的前提消失了 —— 它当初的克制是对的，我保留了它写的原文并注明前提何时失效。

---

# ② ANE：三处断点全修，但**"变 ok"这一半我验不了**

| # | 断点 | 修法 | 谁钉住它 |
|---|---|---|---|
| 1 | **解包多一层同名目录**（真 bug） | `installer.ts` 在换入前压掉冗余顶层目录 | `packages/downloader/src/installer.test.ts`，**走真的 `install()`**（下载→sha256→硬链→解包→原子换入五个环节全过），断言 `coremldata.bin` 落在 `<X>.mlmodelc/` 第一层 —— 与 `checkCoreMl()` 逐字同一条判据 |
| 2 | **前端从不传 `includeOptional`** | `ModelCard` 加勾选框 → `ModelsPage` 原样传给 `POST /models/pull` | 组件测试断 **请求体里那个字段**，不是"勾选框变蓝了" |
| 3 | **只有 f16 挂了 encoder** | 给 `large-v3-q5_0` / `turbo-q5_0` / `turbo-q8_0` 挂上 | `modelCatalogTruth.test.ts` 的单来源清单被迫更新（它当场抓到了我） |

**判据收得很窄，这一条值得单说**：只在「顶层恰好一个条目 + 它是目录 + 名字**逐字**等于目标目录名」
时才压。任何更宽的规则（"只有一个目录就压"）都会改坏别的包的布局 ——
一个正当地把内容放在 `bin/` 下的后端包被压掉之后，`providesFiles` 里的路径全错，
**而且同样不会有任何东西报错**。测试里有一条专门钉这个边界。

**#3 不新增任何 sha256**：复用清单里已有的、已被校验过的那两个 encoder 归档。
依据是 `pack-publish` 从 `whisper.cpp:3336-3342` 核实的事实（拼 `.mlmodelc` 路径时
主动剥掉 `-qX_X` 后缀）。挂之前先断言"weights 名剥掉量化后缀 == encoder 名"，
对不上就不挂 —— **绝不猜**。tiny/base/small/medium 那几档**没挂**，因为我们没有它们的 sha256
（`pack-publish` 直连 HF 被网络策略挡住），编一个摘要出来比不挂糟得多。

⚠️ **速度不是判据，我一次都没拿它说事**。那 48 倍里有虚拟化 3 核 M1 的因素，
`pack-publish` 标了 `[未定性]`，我没有把它算成纯 ANE 的账。

## 🔴 我验不了的那一半（如实）

判据的后半是「**macOS 上自检的 `asr.coreml` 从 warn 变 ok**」。本机是 Linux x64，
`checkCoreMl()` 第一行就是 `if (process.platform !== 'darwin' || process.arch !== 'arm64') return;`
—— 它在这台机器上**根本不会产生任何检查项**。所以：

- ✅ 「解包之后 `coremldata.bin` 在 `checkCoreMl()` 要找的那个位置」—— **已用真 `install()` 钉住**；
- ✅ 「界面上装得动」—— 组件测试钉住请求体；
- ⛔ 「真机上那一项真的从 warn 变成 ok」—— **未验证**。要一次 macOS runner 上的
  `cold-start-audit --transcribe`（带 `includeOptional`）才能闭环。
  **我没有触发 CI**（不在本任务范围，且 release/CI 归 `pack-publish`）。

---

# ③ `debt-cleanup` 抛回的三条

## 3.1 `no-restricted-imports`：规则补上了，**并且把它拦不住什么也钉住了**

`D-01:1061` / `SECURITY.md:109` / `D-06:330` 三份互相交叉引用，看起来像三重确认，
而那条规则**从来没存在过**。现在：

- `eslint.config.js` 一个禁令块（`apps/daemon/src/**` + `packages/*/src/**`）+ **7 文件白名单**（逐条定性）；
- 护栏测试 `packages/pipeline/src/subprocess/__tests__/childProcessAllowlist.test.ts`
  **真的 spawn 一次 eslint**（`--stdin --stdin-filename`，文件系统一个字节都不写），断四件事。

**三条边界，全部写进了 D-01 §8.4 / SECURITY.md L1 ③ / D-06**：

| 边界 | 说明 |
|---|---|
| 🔴 **拦不住动态 import** | `verify-offline.mjs:640` 的 `await import('node:child_process')`。**有一条断言专门钉住这个盲区** —— 就是为了防止下一份文档因为"有规则了"再次把这一格写成满格。它红了不代表出 bug，代表 eslint 变强了，那时要**同时**改文档 |
| **范围只到产品源码** | `scripts/**` / `verify-*.mjs` / `*.test.ts` 不在内。一并禁掉只会逼出十几条 `eslint-disable`，等于没有规则 |
| ⚠️ **`apps/web/**` 刻意不在范围内** | 不是遗漏：flat config 里同名规则是**整体覆盖不是合并**，圈进来会**悄悄吃掉**两条前端分层护栏。`[实测]` 把范围改成含 web，护栏测试当场红（见 §反向验证 R6） |

**准确口径**：「产品源码里 `child_process` 只能出现在这 7 个文件，由 lint 强制」。
**不是**「全项目唯一 spawn 出口」—— 那句今天仍然不成立（`whisperServer.ts` 那条真债 +
`packages/runtime` 的依赖方向），两条都在白名单表里记着。

## 3.2 D1 扩展名白名单：收敛成一份，变异会红

`packages/shared/src/media-extensions.ts` 一份，三个消费点 import 它 ——
**相等由构造保证，不靠测试比对**。`daemon ∖ pipeline = {mpeg,mpg}` 那个洞在结构上不可能再出现。

补齐了"拒绝"侧断言（这是本条的硬条件）：`[实测]` 把判定改成 `return true`
（`evil.exe` / `payload.sh` 全放行），**收敛前 187 条全绿**；现在当场红。

⚠️ **我复核 sub-agent 时收窄了一处**：它第一版把 `PIPELINE_MEDIA_EXTENSIONS` 写成
`∪ PLAYLIST_EXTENSIONS`，于是 `.m3u/.pls/.xspf/.asx/.wpl` 五个也进了 pipeline 的媒体白名单。
后果不是多五个字符串，是 **`directHttp.match()` 对它们的评分 30→80、`probe()` 的
`looksMedia` 直接成立** —— **产品会去抓取的远程 URL 范围变大了**，而这发生在一个
专门处理"间接寻址原语"的地方，且**没有人要求过**。
已收窄成 `∪ {.m3u8}`，并加了一条锚点断言：**相对收敛前恰好只多 `{mpeg,mpg}`**，
多一个少一个都红。**收敛的目标是"三份变一份"，不是"顺手把口子开大"。**

## 3.3 `packages/runtime` 两个真 bug

| bug | 后果 | 判据 |
|---|---|---|
| `detect/system.ts` 缺 `killSignal` | 默认 SIGTERM 可被忽略 ⇒ 那个 `timeout` **不是上界**。这条路径跑的是 `lspci`/`wmic`/`sw_vers`，在**启动时**跑 —— daemon 卡在启动上，而唯一本该救它的东西正是坏掉的那个（ADR-014 同族） | **行为断言**：真起一个装了 SIGTERM handler 的子进程，断言 `run()` 在期限内 settle。断字面量的话，换成同样无效的 `'SIGINT'` 照样绿 |
| `selfTest.ts` **覆盖**而非前置 `LD_LIBRARY_PATH` | conda/nix/HPC 机器上原有搜索路径被整个丢掉 ⇒ 自检与真实转写解析出不同的库，**而自检正是用来预测真实路径的** | 断"原来有什么必须还在"，不是"我们要的那个在不在" |

三处 `execFile` 包装合并成 `childEnv.ts` 一份。顺带一条：空值时**不留前导分隔符**
（`":"` 开头在 glibc 下等价于 `"."`，会让子进程从 cwd 加载 `.so`）。

⚠️ 那个"永不 settle"的子进程测试**15 秒后自己退出** —— 这一条是给"测试失败时"准备的：
修复被撤掉时 SIGTERM 杀不掉它，不能因为跑了一次红灯就在机器上留一个孤儿进程（⑤H 同族）。

## 3.4 顺带：`packages/downloader` 是**第七个**接上 test 脚本的包

它此前**没有 test 脚本、也没有测试文件**。我加 `installer.test.ts` 的同一刻，
`scripts/check-test-scripts.mjs` 就把我拦下了 —— 那正是它存在的理由。
用的是六个包共用的那一行，没发明第八种写法。

---

# ④ `wavesurfer.js` 已删

`pnpm --filter @openmemo/web remove wavesurfer.js`（`package.json` −1 行、`pnpm-lock.yaml` −8 行）。
**理由没有重复写**（`peaks.ts` 文件头那段判决原样保留），只在末尾追加了"已执行"。

**加了一条护栏，因为这类债只能这么钉**：零 import 的依赖**不会被 tsc 发现**（没人引它）、
**不会被 eslint 发现**（没有 import 语句）、**不会被任何测试发现**（它不产生行为）——
它就是这么从第一个脚手架提交活到今天的。所以判据只能是"它在不在依赖清单里"。
守卫前有一条"读到的确实是 apps/web 的 package.json"，**且刻意不碰被检查的那个量**。

---

# §反向验证（9 组，全部贴过真实红灯，跑之前均 `grep` 确认坏行在即将运行的产物里）

| # | 撤掉什么 | 真实输出（节选） |
|---|---|---|
| **R1** | 把 `wavesurfer.js` 加回 `apps/web/package.json` | `✖ ★ dependencies / devDependencies 里都不许出现 wavesurfer` · `+ ['wavesurfer.js']  - []` |
| **R2** | `prependPathVar` 退回"覆盖"写法 | `✖ ★ 原来有值时必须整个保留下来` · `+ '/packs/whispercpp'  - '/packs/whispercpp:/opt/conda/lib:/usr/local/lib'`（4 条红） |
| **R3** | `detect/system.ts` 拿掉 `killSignal` | `✖ ★ 忽略 SIGTERM 的子进程超时后，run() 仍然必须在期限内返回`：`'hung' !== 'settled'`，已耗时 6010ms。**第二条更难看**：`✖ 超时返回的是 ok:false` 实得 `{"ok":true,"stdout":""}` —— 15 秒后它把"没跑成"伪装成了空输出 |
| **R4** | eslint 规则的 `files` 改成匹配不到任何东西 | `✖ ★ 产品源码里 import node:child_process 必须报错`：`apps/daemon/src/http/rest/__probe__.ts 里 import node:child_process 没有被拦下 —— L1 又变回一句空话了` |
| **R5** | 把 `apps/web` 一起圈进那条规则的范围 | `✖ ★ 前端两条分层护栏仍然生效`：`features/A → features/B 不再报错了 —— flat config 里同名规则是整体覆盖，新块吃掉了它`（**这条证明我避开的那个坑是真的**） |
| **R6** | `main.ts` 摘掉 `createLlmRoutes` | detect 5 条 + models 4 条全红，含 `✖ ★ 它不是 404（T-150 卡死的全部内容就是这一条）` |
| **R7** | `LocalLlmSection` 首屏改说"没探到" / 不列探过的地址 / 不显示模型数 | 3 条各自红（第三条见下方"我自己写坏的断言"） |
| **R8** | `LlmModelSelect` 不渲染刷新按钮 | `✖ ★ #26…`：`可枚举的那 4 家必须有刷新按钮（lmstudio）—— daemon 侧 POST /api/llm/models 已经存在` |
| **R9** | `installer.ts` 不压那层冗余同名目录 | `✖ ★ zip 自带一层同名顶层目录时…`：`<X>.mlmodelc 里没有 coremldata.bin，whisper 会静默回退到 Metal/CPU。实际内容：["ggml-large-v3-turbo-encoder.mlmodelc"]` |
| **R10** | `ModelsPage` 不传 `includeOptional` / `ModelCard` 判据退化成"是不是 Mac" | 各 2~4 条红 |
| **R11** | `PIPELINE_MEDIA_EXTENSIONS` 改回 `∪ PLAYLIST_EXTENSIONS` | `✖ ★ T-153：pipeline 的集合相对收敛前恰好只多了 {mpeg,mpg}`：`多出来的不止 {mpeg,mpg}：.asx .m3u .mpeg .mpg .pls .wpl .xspf` |

`grep -rn REVERSAL` 在 `apps/**` `packages/**` `eslint.config.js` **全部归零**（源码与 dist 都查过）。

## ★ 我自己写坏的一条断言（记账，今天第 N 次同族）

「探到的每一条都要显示它报了几个模型」，我第一版写的是 `row.textContent.includes('2')`。
**它钉住的是零** —— 反向验证时把整段"报了几个模型"删掉，**照样绿**：
同一行里的 `http://127.0.0.1:11434/v1` 自带一个 `2`（在 `127` 里面）。
换成"整句词条渲染后的原文"之后，同一个变异当场红：
`没说它报了几个模型（期望包含「它报了 2 个模型」）→ Ollamahttp://127.0.0.1:11434/v1+ 添加`。

> **判据：断言必须钉"说了什么"，不是"出现过某个字符"。**
> 短字符串（数字、单字）在一行富文本里几乎必然命中别处 —— 它看起来在测内容，实际在测存在。

另一条：`installer.test.ts` 里手写 ZIP 时用了 `0o100644 << 16` ——
JS 位运算是 32 位有符号，溢出成负数，`writeUInt32LE` 当场 `ERR_OUT_OF_RANGE`。
**它红得诚实**（当场炸，不是静默写错），已改成 `* 0x10000` 并把原因写进注释。

---

# §我没做到 / 不确定的（如实列）

| 项 | 状态 |
|---|---|
| **macOS 上 `asr.coreml` 真的从 warn 变 ok** | ⛔ **未验证**。`checkCoreMl()` 在非 darwin/arm64 上直接 return，本机产生不出这一项。需要一次 macOS runner 上带 `includeOptional` 的 `cold-start-audit`。**我没触发 CI**（不在本任务范围） |
| tiny/base/small/medium 的 CoreML encoder | ⛔ **没挂**。我们没有它们的 sha256（HF 直连被网络策略挡住），**编一个摘要出来比不挂糟得多** |
| `POST /api/llm/models` 对**真厂商**发过请求吗 | ⛔ **没有**。不该拿用户的 Key 去试，也不该替他花钱。出网那条走注入 `fetch` 的单测（6 条），真机行为**未验证** |
| `POST /api/llm/detect` 探到过真的 Ollama 吗 | ⛔ **没有**。本机 11434/1234/18080 全部关闭（跑测试前确认过），所以 `detected` 恒空。**"探到"那条分支只被组件测试的桩覆盖过** |
| 真浏览器验证 | ⛔ **一次都没开**。「本地模型」折叠组与 CoreML 勾选框只有 tsc + eslint + 234 条组件测试背书，排版与观感未经人眼确认 |
| `LlmModelSelect` 的刷新按钮在「按用途分别配置」那一处 | 🟡 **刻意不给**（不传 `providerId`）：那里的候选是已配置服务商的子集，在那里刷新会让人以为刷的是那一栏 |
| `mistralai` | ⛔ 仍然驱动不了（`frontend-truth` 已定性），本轮没碰 |
| D-05 §7.3a 那句「**待决**：wavesurfer 要么用起来…」 | 🟡 **没改**。它是 `debt-cleanup` 刚订正过的交付物，PROTOCOL §1 规则 3 不许改别人的。裁决与执行都记在 `peaks.ts` 与本回执里。**建议 Manager 顺手把那句"待决"划掉** |
| `packages/shared` 自己没有测试 | 🟡 沿用 sub-agent 的判断：给它加 test 脚本会牵动 `check-test-scripts.mjs` 那条跨包守卫，超出范围。并集构造由 pipeline/daemon/web 三侧间接钉住 |

---

# §纪律

| 条 | 结果 |
|---|---|
| `apps/web/dist` 未被覆盖 | ✅ `index.html` mtime 仍是 `2026-08-06 02:15:09`（我动手前）。构建**全程 `pnpm build:safe`**，一次 `pnpm -r build` / `vite build` 都没跑（组件测试走 `--ssr --outDir .test-out/`） |
| `:10000` 只读 | ✅ **一个请求都没发**，未重启、未 kill、未占用。pid `3333930` 仍在 |
| `/root/data-memo` | ✅ 未读未写，mtime 仍是 `2026-08-06 02:15:14` |
| `datadir.json` 指针 | ✅ sha256 `7f930979…0da233f3`，与 `frontend-truth` 记录的**逐字符相同**，未碰 |
| `pkill -f` | ✅ 未用 |
| release / 仓库可见性 / 分支保护 | ✅ 一个都没碰 |
| 本机 whisper 转写 | ✅ **一次都没跑** |
| `git add` | ✅ **逐个文件，45 个，零 `-A`**。见下方两条申报 |
| 起过的服务 | 测试自己起的：daemon 用 **19800–19819** 段（`testPorts.test.ts` 当场把我第一版的 19880 抓了 —— 与 `noteDetailContract` 的 19860 只隔 20）；downloader 测试的桩服务器绑 `:0`（OS 分配） |
| 临时文件 | `/tmp/lm-*.bak`（仓库外），已用完 |

## 🔴 申报 1：PROTOCOL §10（反向验证不许在共享工作树里做）—— **我违反了**

那条规则是 `3755e0a` 在 **15:54** 加进来的，而我 15:00–17:10 一直在共享工作树里做反向验证。
**我是读了 PROTOCOL 之后开工的，读到的是没有 §10 的那一版**，中途没有重读 —— 这是我的疏漏，
不是不知道。如实交代时间窗，供撞上红灯的人核对：

| 大致时段 | 哪个包的 `dist` 里装着故意坏掉的代码 | 表现 |
|---|---|---|
| ~16:05 | `apps/web/.test-out/unit` | `peaks.test.ts` 1 条红 |
| ~16:10 / ~16:15 | `packages/runtime/dist` | `childEnv.test.ts` 4 条 / 2 条红（**其中一次那个子进程会活 15 秒**） |
| ~16:25 / ~16:28 | 无（改的是 `eslint.config.js`，只影响 `pnpm lint` 与那一个测试文件） | `childProcessAllowlist.test.ts` 1 条红 |
| ~16:45 | `apps/daemon/dist` | `llmRoutes.test.ts` 9 条红 |
| ~16:50 / ~17:00 | `apps/web/.test-out/components` | 各 1–4 条红 |
| ~16:58 | `packages/downloader/dist` | `installer.test.ts` 1 条红 |
| ~17:05 | `packages/shared/dist` → 传导到 `packages/pipeline/dist` | `argGuard.test.ts` 2 条红 |

**每一组都在同一分钟内还原并重建**，`grep -rn REVERSAL` 收尾归零；但按 §10 的判据，
「最终状态干净」救不了「过程中别人跑了一次」。**如果你在上面这些时段撞到过红，先看这张表。**
下次照 `scripts/mutation-check.mjs` 的形状跑在 `/tmp` 副本上。

## 🔴 申报 2：我 `git add` 的 `apps/daemon/src/main.ts` **被别人的提交扫走了**

`[实测]` `git show --stat 74ba01b`（"docs: T-150 追加 …"，17:07）里有
`apps/daemon/src/main.ts | 16 +++++` —— **那 16 行是我的**（`createLlmRoutes` 接线）。
我在 17:05 左右 `git add` 了它，对方随后提交时把索引里已暂存的内容一起带走了。

**代码本身没问题**（内容是对的、门禁是绿的），坏的是**归属**：
一次 daemon 路由改动躺在一个标题写着"docs"的提交里，`git log --oneline` 上完全看不出来。
这是 HANDOFF ⑤J 那一族的**反方向**：不是我 `-A` 扫走别人，是我暂存的东西被别人带走。

**我没有去改写他的提交**（那会动别人的历史）。请 Manager 知悉即可。
> **可推广的一条**：`git add` 之后到自己 `git commit` 之前的那段窗口，
> 在多 agent 共享工作树里**不是安全的**。要么 add 完立刻 commit，要么别提前 add。

## SHARED-CHANGE 申报（5 处）

| 文件 | 归属 | 我做了什么 | 风险 |
|---|---|---|---|
| `apps/daemon/src/main.ts` | 多人 | **只加我那 16 行**；把工作区里别人在途的两行 `dataDir: paths.dataDir,`（配 `transcribe.ts` / `ws/recorder`）**逐行剔除后才 add**，`git diff --cached` 逐条核对过 | 低（已核） |
| `apps/web/src/test/components.test.tsx` | 多人热区 | 追加 8 条；**订正 1 条旧断言 + 它的名字**（#26 那条"两档都不给假按钮"，前提已消失）；`EMPHASIS_REGISTRY` 加 2 条 | 🟡 中 |
| `apps/daemon/src/pipeline/modelCatalogTruth.test.ts` | `catalog-truth` | 单来源清单 +2 行（**是它的守卫逼我更新的**，并写清"不是丢了镜像，是同一个归档挂到了另外两个条目上"） | 低 |
| `apps/web/src/features/runtime/api.ts` | `architect` | `useHardwareQuery` **提升**到 `lib/api/hardware.ts`，此处改为再导出（分层护栏禁止 features/A → features/B；**再导出而不是复制**，两处共用同一个 queryKey，硬件不会被多探一次） | 低 |
| `apps/web/tsconfig.test.json` | `frontend-truth` | 追加 2 行（sub-agent 的 `capture/upload.test.ts`）。⚠️ sub-agent 实测：把 `looksLikeMedia` 改回写死正则，**`tsc -b` 与 `eslint` 都是 0** —— 不加这个测试，web 那半个分叉没有任何东西挡得住 | 低 |

**未碰**：`packages/runtime/src/selfcheck.ts`（`asr.coreml` 判据一个字没改）、
`vendor/manifests/` 除 `models-whisper.json` 外的全部、`coordination/BOARD.md` / `ROSTER.md` /
`docs/adr/**` / `00-CHARTER.md`（PROTOCOL §1）。

---

# §需要 Manager 决策

1. **macOS 上闭环 ANE**：需要一次 macOS runner 的 `cold-start-audit --transcribe`，
   拉一个挂了 encoder 的模型并带 `includeOptional:['coreml-encoder']`，看 `asr.coreml` 是否变 `ok`。
   **归 `pack-publish`**（CI 与 release 是它的地界）。这是本轮唯一没闭合的判据。
2. **tiny/base/small/medium 的 encoder 要不要挂**：需要先拿到它们的 sha256。
   `pack-publish` 报过 HF 直连被网络策略挡住，它是从 ModelScope 三份镜像交叉验证的
   （`[未直连 HF 核实]`）。**要挂就得先解决"摘要从哪来且可信"**，我没有编。
3. **D-05 §7.3a 那句「待决：wavesurfer 要么用起来…」** 现在有答案了（已删除），
   但那是 `debt-cleanup` 的交付物，我按 PROTOCOL §1 没动。建议顺手划掉。
4. **`apps/daemon/src/main.ts` 的归属**（申报 2）：一次路由改动躺在标题写"docs"的提交里。
   要不要在 BOARD 或 HANDOFF 上留一句，随你。
5. **`whisperServer.ts` 那条真债还在**：它是 `packages/pipeline` 里第二处 import
   `child_process` 的地方，违反本包自己的不变量（长驻服务 vs run-to-completion）。
   现在它在 lint 白名单里**并写明了"债还在"** —— 不是被赦免，是被记账。
