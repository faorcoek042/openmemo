# e2e-allcomponents（目录里每一个组件都真下一遍）

## [2026-08-09 12:20] e2e-allcomponents DONE（两条红都是真的）

交付:

- `.github/workflows/e2e-allcomponents.yml`（新建，三平台）
- `scripts/ci/e2e-allcomponents.mjs`（新建，A/B 两层）

要点:

- **A 层 100% 覆盖**：71 个文件、逐个逐镜像真发 Range 请求，**全部至少一个镜像可达**。
- **B 层实测跑出两条真红**：github-only 镜像 26/71；**whisper.cpp 包在三平台全部装不上**。
- 自陈：第一版的枚举断言口径错了，差点把 `role=llm` 报成产品缺陷（§5）。

需要 Manager 决策: **有 1 条 —— §3 那条「whisper.cpp 包三平台全部装不上」归谁修（我没查出真因）。**

---

## 1. 25 个包 + 30 个变体：跑通几个、跳过几个、失败几个

最终 run **31295507733**（`mode=sample`，三平台）。

### 后端包（25 个，逐个）

| 分类 | 个数 | 明细 |
| --- | --- | --- |
| **本平台适用 → 装成功** | **4** | `media-tools-*`、`ytdlp-*`、`libsimple-*`、`sqlite-vec-*` |
| **本平台适用 → 装失败** | **2** | linux：`whispercpp-cpu-linux-x64`、`whispercpp-vulkan-linux-x64`<br>macOS：`whispercpp-cpu-macos-arm64`、`whispercpp-metal-macos-arm64`<br>win：`whispercpp-cpu-win-x64`、`whispercpp-vulkan-win-x64` |
| **本平台不适用（正常，不是失败）** | **19** | 另外两个平台的包 + 需要探针才判得了的 GPU 包；**腿里逐个列出了目录给的理由** |

⚠️ **"不适用"与"适用却装失败"在输出里是分开的两段**，不适用的 19 个逐行打印了 id 与理由
（§11：跳过不许渲染成成功 —— 这次在包的粒度上也守住了）。

### 模型（30 个变体 / 16 组，`mode=sample`，预算 2600 MB）

- **真装了 18 个，全部成功**（`18/18`，地面真相取 `/api/models/installed`）：
  `vad/silero-vad-ggml`、`vad/silero-vad-onnx`、`asr/sherpa-streaming-zh-14m`、
  `punctuation/ct-transformer-zh-en`(285MB)、`asr/paraformer-zh-small`、
  whisper tiny/base 的 6 个量化档等。
- **没下的 12 个**（全部是 514 MB–4.07 GB 的 medium/large 档）逐条打印了 id 与体积：
  `whisper-medium-en-q5_0` … `whisper-large-v3-f16`(4073MB)。
- **A 层已逐个探过这 12 个的每一个镜像** —— 它们不是"没测"，是"没整下"。

## 2. 体量怎么处理的（以及为什么不是"只下小的"）

全量真下 **39.4 GB**（`[本机实测]` 由清单求和；即使"每组只取最小变体"也要 **20.6 GB**），
而 runner 可用磁盘只有十几 GB。**但"下不动"不该变成"只测小的"**，所以拆两层：

| | 覆盖面 | 每个组件做什么 | 抽样？ |
| --- | --- | --- | --- |
| **A 层** | **71 个文件 / 100%**（含本平台不适用的） | 每个镜像真发 Range 请求取 64 KB：可达 + **总长度 == 清单 sizeBytes** + 头部魔数对得上 | **不抽样** |
| **B 层** | 适用的包全部 + 模型按预算 | 产品自己的完整路径：下载→校验→解包→落位→记录→**真的可用** | 模型抽，**抽了谁/漏了谁逐条打印** |

抽样规则**写死且可复现**：先保证**每个 role 至少一个**（否则某类落位逻辑一次都走不到），
再在预算内从小到大补满。`mode=full` 一个不落（几十 GB，手动触发用）。

A 层抓的正是用户撞的那一类（下载源不可达 / URL 失效 / 文件被换掉），
它便宜到**没有资格抽样**；B 层贵，所以它抽 —— 但它抽掉的部分被 A 层兜住了。

## 3. ★ 抓到的真东西：whisper.cpp 包在**三平台全部装不上**

```
linux   whispercpp-cpu-linux-x64      failed  1.0s   {"code":"NOT_FOUND","messageZh":"未找到"}
        whispercpp-vulkan-linux-x64   failed  1.0s   同上
macOS   whispercpp-cpu-macos-arm64    failed  1.0s
        whispercpp-metal-macos-arm64  failed  1.1s
win     whispercpp-cpu-win-x64        failed  1.0s
        whispercpp-vulkan-win-x64     failed  2.9s
```

**而同一轮里 media-tools / ytdlp / libsimple / sqlite-vec 四个全部 succeeded。**
也就是说：**失败的恰好是、且只是 whisper.cpp 那一族**，三平台一致。

几条能排除的：

- **不是下载源问题** —— A 层同一轮探过这两个包的 URL：`206`，总长度与清单**逐字节一致**。
  失败只用了 1.0 秒（`whispercpp-vulkan-win-x64` 2.9s），不是超时。
- **不是"目录里没有"** —— 它们在 `/api/backends/catalog` 里，且 `applicable=true`
  （否则 install 路由会回 409 CONFLICT，不是这个）。
- 错误码 `NOT_FOUND` 来自**安装 job 内部**，不是 `POST /api/backends/install` 那个 404
  （路由的 404 会让我拿不到 jobUid，而我拿到了）。

**真因我没查出来，标 `UNKNOWN`。** 但影响要说清楚：
`whispercpp-vulkan-*` / `whispercpp-metal-*` **不在包内**，
所以这条红的用户后果是 **GPU 加速当前在三个平台上都装不上**。
CPU 那一条因为 v0.4.0 起引擎已随包出厂，用户未必察觉。

这可能与 Manager 提到的第三条已知问题（「界面在让用户下载一个已经随包出厂的东西」）同源，
**那位在答**。我**没有去修**（不是我的地界，且真因未定）。**请指派。**

## 4. ★ 「CI 可达 ≠ 用户可达」这条局限写在哪

**写在腿自己的输出里，而且写了两遍**：第 0 节开头（还没跑任何东西之前）、
台账末尾（看完结论之后再重申一次）。原文：

> ⚠️ **CI 可达 ≠ 用户可达。** GitHub runner 就在 GitHub 自己的网络里，
> github.com 对它永远是通的；而用户 `[真机实测，中国网络]` 装
> `whispercpp-cpu-win-x64` 是 `0 B / 4.0 MB`、「下载源无法访问 (1/3)」。
> **所以这条腿很可能全绿，而用户仍然装不上。**

**能在 CI 上诚实回答的那一半是镜像结构**，它与我从哪儿跑无关，所以我把它做成了断言：

```
✘ ★ 每个组件都至少有一个非 github 的镜像（否则中国用户装不上）
   只有 github 系来源的文件：**26 / 71**
```

`[本机实测 由清单求和]` 后端包 **14 个文件全部只有 `github.com`，一条备用来源都没有**；
模型那边 huggingface(34) + hf-mirror(33) + ModelScope(25)。
**这正是用户撞上的那条**，Manager 说有人在修 —— 本腿如实报出来，修好会自动变绿。

## 5. 自陈：第一版的枚举断言口径错了，差点报成产品缺陷

`[CI 实测 run 31295033171]` 三平台都红在「目录枚举与清单对得上」：目录 30 / 清单 35。
追下去差的**恰好是 5 个 `role=llm`** —— `/api/models/catalog` 不列 LLM。
**是我拿总数硬比，不是产品少了东西。**

改成按 role 分开逐 id 核对之后这条转绿。同时把 LLM 那 5 个**单列成覆盖缺口**：

- `llm/qwen3-4b-q4_k_m`、`llm/qwen3-4b-q5_k_m`、`llm/qwen3-8b-q4_k_m`、
  `llm/qwen3-1.7b-q8_0`、`llm/gemma-3-4b-it-q4_k_m`
- **A 层照常逐个探过它们的每一个镜像**（URL 可达性与哪个端点列它无关）；
- **B 层覆盖不到它们**（不在 `/api/models/catalog` 里）；
- 它们归 `/api/llm/models` 那条线，**用户能否从那里装上：`[未验证]`**。

## 6. 门禁（隔离 worktree 检出我自己那个 commit）

共享树里有文档那位的 3 个未提交文件，所以门禁没在共享树上跑。

| 门禁 | 结果 |
| --- | --- |
| `pnpm -r test` | **1600 / fail 0**（基线 1600） |
| `tsc -b` | 0 |
| `eslint .`（全仓） | 0 |
| `prettier --check .`（全仓） | 0 |
| `test:ci-scripts` | 0 |
| `check:orphans` | 零引用导出 **70**（基线 70） |
| `lint-workflows` | 1505 条断言全过（16 个 workflow） |

## 7. 纪律与欠账

- **跑完自己清**：脚本 `finally` 里 `rmSync` 掉临时目录，workflow 另有 `always()` 的兜底
  并再打一次 `df -h`（几 GB 的东西不留在 runner 上）。
- §11：起服务前 `assertPortFree`、按 **pid** 收进程树、外部调用全部带超时、
  **被打断不许渲染成"全部成立"**（台账会明说"其余没有跑到"）。
  **没有用 `pkill`（含 `-0`）。**
- 欠账（如实记）：
  - **这条腿的断言仍无变异证明**（`e2e-record` 那套纯函数 + selftest 是对的做法）。
    这是我第三次记它了，仍然没做。
  - `assertPortFree` 又抄了一份（第 N+1 份）。提到 `scripts/ci/lib/` 的事仍未做
    —— Manager 说过那批文件有人在改，本轮继续不做。
  - `mode=full`（39.4 GB）**从来没有真跑过**，`[未验证]` 它在 runner 磁盘上是否装得下。

---

## [2026-08-09 18:10] 追加 DONE —— `NOT_FOUND` 定位到了；三平台 GPU 加速现在装得上

要点:

- **真因是"包内清单指向一个已被删除的 release"，不是产品代码 bug。** Manager 的第一假设成立。
- **上一轮我把真因记成 UNKNOWN，是因为我这条腿自己读错了清单** —— A 层读 checkout、B 层跑包内。
- **三平台 6/6 后端包全部装上，含 GPU 加速**（Metal / Vulkan）。
- 记了三次的债还了：**15 条变异证明**，已挂进 `test:ci-scripts`。

需要 Manager 决策: **有 1 条 —— §4「删 release 会打死所有已发出去的旧包」是发布策略问题，不是代码问题。**

### 1. `NOT_FOUND` 到底是哪一步抛的：**下载那一步，HTTP 404**

不是解析、不是 `providesFiles`、不是落位。完整调用序列（每一步都已核实）：

```
① 包 openmemo-0.4.0-linux-x64
   ← build-bundles run 31268366005，commit 99995b8，2026-08-09 01:00
   包内 vendor/manifests/backends.json：
     whispercpp-cpu-linux-x64 → …/releases/download/v0.3.0/whispercpp-cpu-linux-x64.tar.gz
     media-tools-linux-x64    → …/BtbN/FFmpeg-Builds/…（**上游**，不是我们的 release）

② ddccef4  2026-08-09 03:58  「目录与来源页指向 v0.4.0」——**比打包晚约 3 小时**
   git merge-base --is-ancestor ddccef4 99995b8 → **不包含**（包里还是 v0.3.0）

③ v0.3.0 release 被删除
   gh release list → 只剩 v0.4.0 与 model-mirror-2026.08.06

④ curl 实测（我刚跑的）：
     404  v0.3.0/whispercpp-cpu-linux-x64.tar.gz
     206  v0.4.0/whispercpp-cpu-linux-x64.tar.gz

⑤ 安装 job 的下载步骤拿到 404 → 1 秒内失败 → 向上报 NOT_FOUND
```

**为什么偏偏是 whispercpp 一族**：它是**唯一托管在我们自己 release 上**的一族。
`media-tools`/`ytdlp` 指上游 BtbN、`libsimple`/`sqlite-vec` 也指上游 —— 删我们的 release 打不到它们。
这与"同一轮里其余四个全部 succeeded"完全吻合。

**和"目录重指 v0.4.0 / 删了 v0.3.0"有关系吗：就是它。** 第一假设成立，不需要往下猜。

### 2. 我这条腿自己的洞（这才是我该修的那部分）

上一轮同一次 run 里两句自相矛盾的话：

```
A 层  whispercpp-cpu-linux-x64 → 206，长度与清单逐字节一致
B 层  whispercpp-cpu-linux-x64 → NOT_FOUND，1.0 秒
```

**因为两层读的根本不是同一份清单**：A 层读 **checkout**（v0.4.0，活的），
B 层跑 **包内**（v0.3.0，死的）。我当时把真因记成了 `UNKNOWN` —— 而真因就摆在这条缝里。

修了两处：

1. **A 层改读包内那一份**（用户的 daemon 用的就是它；包里没有才退回 checkout）。
   现在输出第一行就是 `清单来源：**包内**（用户实际用的那一份）`。
2. **新增「包内清单 vs 当前 checkout 漂开了哪些」** —— 这是那个 bug 的**一句话诊断**。
   有它的话上一轮直接会打出 `whispercpp-cpu-linux-x64: 包内 v0.3.0 → 目录 v0.4.0`，
   我不用追半天。漂开本身只警告（新包总比旧包新），**判红的是 A 层"包内那个 URL 还活着没有"**。

### 3. 修完之后：三平台 GPU 加速能不能装上了 —— **能**

run **31297551682**（包 = build-bundles run 31297265067，commit `ea3ba76`，目录已是 v0.4.0）：

| 平台 | 后端包 | GPU 加速那一个 |
| --- | --- | --- |
| linux-x64 | **6/6 装上** | `whispercpp-vulkan-linux-x64` **succeeded** |
| darwin-arm64 | **6/6 装上** | `whispercpp-metal-macos-arm64` **succeeded**（11.4s） |
| win32-x64 | **6/6 装上** | `whispercpp-vulkan-win-x64` **succeeded**（2.9s） |

同一轮里 `清单来源：**包内**`、`包内清单与当前 checkout 一致（没有漂开）`——
两条新增的诊断都如实反映了"这次包是新的"。

三平台**唯一剩下的红**是 26/71 只有 github 单一来源那条（下面 §5）。

### 4. ⚠️ 需要决策：**删 release 会打死所有已经发出去的旧包**

这不是代码 bug，所以我没改代码，但它是一条**结构性风险**，请 Manager 定策：

> 包**内嵌**清单（我上一轮亲手加的 `vendor/manifests`，为的是修"组件页空的"）。
> 内嵌意味着**包出厂那一刻，它要下载的 URL 就被冻住了**。
> 于是**删掉一个 release，就永久打死所有还指着它的、已经在用户机器上的包** ——
> 用户不会知道发生了什么，他只看到"点安装没反应 / 下载失败"。
> 这一次是我们自己在 CI 上撞到的；下一次撞到的是用户。

三条候选（我不替你选）：

1. **不再删 release**（最便宜，纯策略；代价是 release 列表会长）。
2. **daemon 启动时用包内清单做兜底、但优先拉一份远端目录**（真修，代价是新增一条出网路径与它自己的失败模式）。
3. **发新包时保留旧 tag 的 asset 副本**（兼容旧包，代价是存储与流程复杂度）。

⚠️ 无论选哪条，**这条腿现在都能当场抓到它**：包内 URL 一旦失效，
「每一个组件至少有一个镜像真的可达」立刻红，且漂移诊断会点名是哪一族、从哪个 tag 漂到哪个。

### 5. 剩下那条红：26/71 只有 github 单一来源

按 Manager 的说明，这是**分发缺口**而不是代码缺陷：代理已实测可用（配代理后
`CONNECT raw.githubusercontent.com:443`、安装 succeeded），**用户可以自救**；
真正的中国托管要花钱要维护，**先不做**。

这条腿**保持红**，因为它的判据是"用户能不能装上"而不是"我们的 CI 能不能装上"。
后端包 **14/14 无兜底**这个数会一直摆在输出里，直到有人给它加来源。

### 6. 记了三次的债：变异证明（这轮还了）

判据抽成纯函数 `scripts/ci/e2e-allcomponents-assertions.mjs`，
`scripts/ci/selftest-e2e-allcomponents.mjs` **15 条全过**，已挂进 `pnpm test:ci-scripts`。

为什么这轮非补不可，写在文件头上：上一轮台账上**并排两条红**——
一条是产品的（whispercpp 装不上），一条是**我判据写错的**（枚举拿总数硬比），
**它们长得一模一样**，我差点把后者当缺陷报上去。

覆盖的变异（★ = 直接对应真实事故）：

| 变异 | 打的是什么 |
| --- | --- |
| ★ 所有镜像都不可达 | 本轮 v0.3.0 → 404 那一类 |
| ★★ URL 活着但**换了文件**（长度不符） | 比 404 更隐蔽：存在性检查会放行 |
| 魔数与后缀不符 | 拿到一页 HTML 错误页 |
| ★ 一个镜像都没配 | 用户根本无从下载 |
| ★ 全 github 来源 / 反向：有非 github 的不许算进去 | 防判断被改成恒真 |
| ★★ **空集必须报"前提不成立"** | 本仓反复发作：`[].every()` 恒真 |
| ★★ 包内 v0.3.0 / 目录 v0.4.0 → 点名 whispercpp | 本轮真实复现 |

### 7. 接进发布闸门（Manager 要求）

- `verify-e2e-attestation.mjs` 默认腿列表加 `allcomponents`（现为
  `import,notes,record,runtime,browser,allcomponents`）。
- workflow 加 `attest` job。⚠️ 发凭证有**两个**条件，第二个是这条腿独有的：
  **`legs=all` 且 `bundleRunId` 非空**。
  留空时 `resolve-bundle-run.sh` 是**按 artifact 名**各自解析的，
  三个平台完全可能落到**不同批**的包上 —— 那种 run 里"三平台都绿"是真的，
  但拿去发一张钉着某个 `bundleRunId` 的凭证**就是伪证**。
- `[实测]` run 31297551682 里 attest job **skipped**（腿是红的）—— 闸门行为正确。

### 8. 门禁（隔离 worktree 检出我自己那个 commit）

| 门禁 | 结果 |
| --- | --- |
| `pnpm -r test` | **1615 / fail 0**（基线 1600） |
| `tsc -b` / `build:safe` | 0 / 0 |
| `test:ci-scripts` | 0（含我新加的 15 条变异证明） |
| `check:orphans` | 零引用导出 **70**（基线 70） |
| `lint-workflows` | 1577 条断言全过（17 个 workflow） |
| `prettier --check .` | 我漏跑了新文件，已补（见下） |
| `eslint .` | 红在 `scripts/ci/datadir-migrate-audit.mjs` —— **数据目录搬迁那位的在途文件，不是我的，没动** |

自陈：新写的 `selftest-e2e-allcomponents.mjs` 我只跑了 eslint 没跑 prettier，
门禁当场红，已单独一个 commit 补上。

### 9. 仍然没做的

- **`mode=full`（39.4 GB）依然没真跑过** —— 按 Manager 指示**保持 `[未验证]`**，
  不为了好看去跑一次可能塞不下的。
- `assertPortFree` 仍是第 N+1 份拷贝；提到 `scripts/ci/lib/` 的事继续不做（那批文件仍有人在改）。
