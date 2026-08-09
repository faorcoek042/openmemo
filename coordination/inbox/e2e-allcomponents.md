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

---

## [2026-08-09 22:05] 追加 DONE —— 不删 release 已落地；⚠️ 用户那条**不是**同一个原因

要点:

- 守卫做在**发布前的 `verify` job**（没有 `contents: write` 的那个），守的是**后果**不是动作。
- ⚠️ **`PROVIDER_UNREACHABLE` 与这个 404 不是同一件事** —— 用户的症状**没有**就此闭环，见 §2。
- 漂移检查对 v0.4.0 那批报「一致，没漂开」，三平台 6/6 装上。

需要 Manager 决策: 无（§2 是一条需要你知道的事实更正，不是请示）。

### 1. 「删 release 会被当场拦住」做在了哪一层

**先说清做不到的那一半**：仓库里**没有任何东西能在服务端拦住 `gh release delete`**
——没有 release 的分支保护，也没有服务端钩子。那是一条人在本地敲的命令。
所以我**没有**去做一个假装能拦住动作的东西，而是守**后果**：

| 做在哪 | 是什么 | 拦得住什么 | 拦不住什么 |
| --- | --- | --- | --- |
| `release-upload.yml` 的 **`verify` job**（发包前，**该 job 没有 `contents: write`**） | `check-release-refs.mjs --assert-live`：目录里指向**我们自己 release** 的地址逐个探，死一个就红 | **删了之后新包发不出去** —— 不依赖任何人记得什么 | 已经发出去的旧包（那批已经冻结了） |
| 人手里 | `check-release-refs.mjs --tag v0.3.0`：删之前问一句「还有谁指着它」 | 把"我以为没人用了"变成有名有姓的清单 | **"没问就删"** |

**只有第一行满足「跑错了也不会造成后果」**（PROTOCOL §7 补充），第二行是给人的。
我把这个边界原样写进了脚本头和 ADR-015 §8.4，没有把它说得更强。

`[实测]`：
```
--tag v0.4.0  → exit 1（6 个组件仍指着它）
--tag v0.3.0  → exit 0（已经没人指着了）
--assert-live → 6 个地址全部 206，exit 0
```

判据**只认我们自己的 release**：BtbN 的 ffmpeg 也长着 `releases/download/<tag>/` 的样子，
把上游算进来会让"我能不能删"得到一个**错误答案**（而且是偏保守、看起来还很像对的那种）。
这一条配了反向变异证明（`selftest-e2e-allcomponents` 15 → **19 条**）。

**ADR-015 §8** 按 §13 就地追加（§0–§7 一字未改），写了因果三段
（内嵌 ⇒ 出厂即冻结 ⇒ 删 = 打死已发出的包）、2026-08-09 那次的实测时间线、
以及为什么不选另外两条候选。

### 2. ⚠️ `PROVIDER_UNREACHABLE` **不是**这个 404 —— 用户那条还有第二个原因

你让我去核这两者会不会由同一个 404 产生。**核了，不是。** 证据：

```
packages/downloader/src/http.ts:62   if (status === 404) → HttpError('Not found', 404, 'NOT_FOUND')
packages/downloader/src/http.ts:68   if (status >= 500)  → 'PROVIDER_UNREACHABLE'
packages/downloader/src/http.ts:176  catch (连不上/DNS/TLS) → HttpError(msg, 0, 'PROVIDER_UNREACHABLE')
```

- **404 走的是 `NOT_FOUND` 这一支**，而且 `download.ts:299` 的 probe 失败分支用的是
  `toDownloadError(e).code` —— **原样保留错误码**，不会折叠成 UNREACHABLE。
- `[我刚实测]` GitHub 对被删除的 release 资产返回的是**干净的 `HTTP/2 404`**（不重定向），
  所以它一定落在 `NOT_FOUND` 那一支 —— 这也与我在 CI 上看到的 job 错误码
  （`NOT_FOUND`）完全一致。
- 用户看到的 `(1/3)` 是 `queue.ts:135` 的 `maxAttempts ?? 3` 重试计数。
- `PROVIDER_UNREACHABLE` 的真实来源是 **`status 0`：连不上 / DNS / TLS 失败**。

**结论：这是两个独立的原因，别让一个盖掉另一个。**

| | 谁看到的 | 错误码 | 成因 | 现状 |
| --- | --- | --- | --- | --- |
| 原因 A | **CI（我）** | `NOT_FOUND` | 包内清单指向已删的 v0.3.0 → 404 | **已闭环**（不删 release + 新包指 v0.4.0） |
| 原因 B | **用户（中国网络）** | `PROVIDER_UNREACHABLE (1/3)` | **github.com 在网络层就连不上** | **未闭环** —— 就是那条 14/14 无兜底的分发缺口 |

所以：**用户那条「whisper.cpp · CPU 后端 下载源无法访问」极可能仍然是原因 B**，
而不是我修掉的这个 404。⚠️ 补一条我**没法验**的：他当时手里那个包的内嵌清单
到底指向 v0.3.0 还是 v0.4.0，我**没有他的包**，所以两个原因是否**同时**存在过
——`[未验证]`。但即使 A 也发生过，**B 独立成立**：代理配上之后他能装成功
（你提到的实测），而那恰恰证明问题在网络可达性，不在 URL 是否存在。

### 3. 漂移检查接进闸门后，对 v0.4.0 那批实测报什么

run **31298511557**（包 = build-bundles run 31297265067，commit `ea3ba76`）：

```
清单来源：**包内**（用户实际用的那一份）
ⓘ 包内清单与当前 checkout 一致（没有漂开）
── 结果：71 个文件，71 个至少有一个镜像可达 ──
✔ 本平台适用的后端包**全部**装上了：6/6（含 whispercpp-cpu / whispercpp-vulkan）
```

三平台**唯一剩下的红**仍是 26/71 只有 github 单一来源那条 —— 按你的裁决**保持红**
（判据是用户能不能装，不是 CI 能不能装）。

`attest` job 在这一轮**skipped**（腿是红的）—— 闸门行为正确：红腿不发凭证。

⚠️ 一条如实说明：`--assert-live` 我在**本机**跑过（6 个全 206），
但它**还没有在一次真实的 `release-upload` 运行里被执行过**（那要发一次包）。
所以「它接在闸门里会正常工作」是 `[未验证]` 的 —— 静态检查（`lint-workflows` 1582 条）
只能保证它语法与结构对。

### 4. 门禁（隔离 worktree 检出我自己那个 commit `07c0edf`）

| 门禁 | 结果 |
| --- | --- |
| `pnpm -r test` | **1615 / fail 0**（基线 1615） |
| `tsc -b` / `build:safe` | 0 / 0 |
| `eslint .`（全仓） | **0**（搬迁那位的文件这轮已修好） |
| `prettier --check .`（全仓） | 0 |
| `test:ci-scripts` | 0（含 19 条变异证明） |
| `check:orphans` | 零引用导出 **70**（基线 70） |
| `lint-workflows` | 1582 条断言全过（17 个 workflow） |

### 5. 仍然没做的

- **`mode=full`（39.4 GB）保持 `[未验证]`**（按指示不去跑一次可能塞不下的）。
- `--assert-live` 未经一次真实发布验证（见 §3 末）。
- `assertPortFree` 仍是重复的一份；提到 `scripts/ci/lib/` 继续不做。

---

## [2026-08-09 16:20] 追加 DONE —— 单一来源改成棘轮；v0.5.0 那批**三平台全绿、凭证已发**

要点:

- **v0.5.0 全绿**：run **31302119271**，三平台各 **11/11**，`attest` job **success**（凭证已出）。
- 那条永久红换成**棘轮**：已接受的接受，**基线之外新出现的才红**。
- 代理那句提示**在真实失败路径上验到了原文**（不是读代码）。

需要 Manager 决策: 无。

### 1. 「该重新变红」的条件我定成了什么

**棘轮，与 `check:orphans` 基线 70 同形。** 判据从「有没有单一来源」改成
**「单一来源有没有**新增**」**：

| 情形 | 结论 | 依据 |
| --- | --- | --- |
| 基线内的单一来源 | **接受**，只计数、逐条打印 | 用户 2026-08-09 裁决：有代理兜底就行 |
| **基线之外**新出现的单一来源 | **红** | 这才是意外（见下） |
| 基线里有、现在不是了 | 报 `stale` 提醒收紧，**不红** | 变好了不该拦人 |

**什么才算"意外"** —— 正是你点出的那两种：

1. **一个本来有镜像的组件掉到了单一来源**（上游把 hf-mirror / ModelScope 那一份撤了）。
   `[实测]` 今天 46 个模型文件里 **42 个是多来源**，它们掉下来就是退化。
2. **新加的组件只配了一个源** —— 也红，逼一次**显式决定**，而不是顺手混进来。

**基线（`scripts/ci/single-source-baseline.json`，29 条，2026-08-09 实测）**：

```
后端包 25/25 全是单一来源  ← 已接受（代理兜底）
模型    4/46：
  vad/silero-vad-onnx            silero_vad.onnx（只在 raw.githubusercontent）
  asr/whisper-large-v3-turbo ×3  ggml-…-encoder.mlmodelc.zip（CoreML 可选件，只在 hf）
```

⚠️ 顺带修了判据本身的一个毛病：原来判的是"**是不是 github**"，
现在判的是"**去重后的主机数 < 2**"。前者会把上游 BtbN 的 ffmpeg 和我们自建的包
混为一谈，也答不了"从两个源掉到一个源"这种真正的退化 —— 而那恰恰是新判据要抓的。

**看得见、不沉默**：第 3 节仍然逐条打印总数、pack/model 分布、以及用户裁决那句原话，
只是它不再红。

### 2. 代理那句提示：**在真实失败路径上验到了，贴原文**

不是读代码 —— 第 7 节**真的去撞了一次失败**：把包内清单复制一份、
把一个**本平台适用**的小包指向一个必然 404 的 URL、
用产品自己支持的 `OPENMEMO_MANIFEST_DIR` 指过去（**包内原件一个字节没动**），
然后走真实安装路径。`[CI 实测 run 31302119271, linux]`：

```
拿 libsimple-linux-x64 做失败样本
安装 job：failed
错误全文：{"code":"NOT_FOUND",
  "message":"Failed while probing file size at github.com (before any bytes were
             transferred): Not found. If you are on a restricted network, set a proxy
             under Settings → Proxy and retry.",
  "messageZh":"连接 github.com 失败：卡在**探测文件大小**这一步，还没开始传字节。
               如果你在网络受限的地区，可在「设置 → 代理」里填一个代理再试。"}
```

**中英两句都在。** 而且它挂在 `download.ts:308` 的 **probe 失败**分支上 ——
那正是用户那条（连不上 / DNS / TLS，`PROVIDER_UNREACHABLE`）与本例（404，`NOT_FOUND`）
**共同经过的那一步**。所以用户撞到的那种失败也会带上这句。

⚠️ 边界如实说：`[未验证]` 我**没有**在真正的中国网络下验证过；
验到的是"**probe 失败这一步会带上这句**"，而用户那条正是 probe 失败。
另外，probe **成功之后**才出问题的失败（传输中断、哈希不符）**不带**这句 ——
哈希不符确实与代理无关，但"传到一半断了"可能相关，`[未验证]` 是否需要补。

### 3. 这一节自己也差点变成一盏空转的绿灯（前提断言救了它）

第一版按名字挑失败样本，linux 上挑中了 `libsimple-darwin-arm64` ——
**安装路由在下载之前就回 409「不适用于本机」**，根本没走到下载。

**是前提断言（「这一步必须真的失败」）当场把它抓住的**：

```
✘ ★ 下载失败时**真的**失败了（前提：这一步必须红，否则下面那条恒真）：job=HTTP 409
```

没有它的话，「代理提示出现了吗」会在一个**从未发生过的失败**上报绿 ——
正是这轮反复在防的那种空转。修了两处：样本只从**产品自己判定 applicable** 的那批里挑；
并用**全新的空数据目录**起（第 4 节已经把适用的包都装过，原目录上再装可能被去重）。

### 4. v0.5.0 那批的实测结果

run **31302119271**（包 = build-bundles run 31298961998，commit `ed82e74`）：

| 平台 | 结果 |
| --- | --- |
| linux-x64 | ✅ **11/11** |
| darwin-arm64 | ✅ **11/11** |
| win32-x64 | ✅ **11/11** |
| `attest` job | ✅ **success** —— 凭证 `e2e-attest-allcomponents-31298961998` 已发 |

11 条里包括：71 个文件逐镜像可达 / 长度与清单一致 / 魔数一致 / **单一来源无新增（棘轮）** /
本平台适用后端包全装上 / 抽中的模型全装上 / 缺件清单变短 / `tool.*` 无 fail /
**失败路径真的失败** / **失败消息带得出代理提示**。

⚠️ 我这条腿此前那条红**已经不再挡发布**了。而且我**没有为了让它绿而降低标准**：
换掉的是一条为"已被裁决接受的状态"永远亮着的灯，
新加的两条（失败真的发生、代理提示可见）是**更严的**要求。

### 5. 门禁（隔离 worktree 检出 `268ae18`）

| 门禁 | 结果 |
| --- | --- |
| `pnpm -r test` | **1615 / fail 0**（基线 1615） |
| `tsc -b` / `build:safe` | 0 / 0 |
| `eslint .` / `prettier --check .`（全仓） | 0 / 0 |
| `test:ci-scripts` | 0（变异证明 19 → **24 条**） |
| `check:orphans` | 零引用导出 **70**（基线 70） |

新增的 5 条变异证明全是围绕棘轮的：基线内不红 / **本来两个源掉到一个 → 红** /
**新组件只配一个源 → 红** / 基线过期报 stale 不红 / `isSingleSource` 按去重主机数算。

### 6. 仍然没做的

- **`mode=full`（39.4 GB）保持 `[未验证]`**。
- `--assert-live` 仍未在一次真实 `release-upload` 运行里执行过（`[未验证]`）。
- probe 成功之后的失败是否也该带代理提示 —— `[未验证]`，见 §2 末。

---

## [2026-08-09 17:40] 追加 DONE —— 用户那批字节里**有** whisper-cli.exe；咬他的是自检那条链

要点:

- ⚠️ **先答第一问：`whisper-cli.exe` 在他那批字节里，479,232 B，`start.cmd` 也确实设了变量。** 不是打包缺陷。
- 咬他的是**自检那条解析链压根没有包内这一档**；我这条 `fromBundle()` 只读环境变量是**同族但不同处**，两条都修了。
- **对着他那批字节实测**：自检从 `null` 变成真的跑起来并通过（`rtf 0.135`、`7.39x`、`transcriptSimilarity 1`）。

需要 Manager 决策: 无。macOS 那一格 `[未验证]`，原因见 §5。

### 1. 用户那批字节里到底有没有 `whisper-cli.exe` —— **有**

拉的是他真正在用的那批（`build-bundles` run **31298961998** 的 `bundle-win-x64`），
**没有现建新包**：

```
runtime/probe/  ggml-base.dll 656,384 · ggml-cpu-x64.dll 776,704 · ggml.dll 67,584
                openmemo-probe.exe 21,068
                **whisper-cli.exe 479,232**          ← 在
                whisper-vad-speech-segments.exe 362,496
                **whisper.dll 1,366,016**            ← 在
start.cmd:  if not defined OPENMEMO_BUNDLED_WHISPER_DIR set "…=%DIR%runtime\probe"   ← 设了
            %DIR%runtime\probe                                                        ← 存在
```

**所以「没打进去」与「启动器没设变量」两条都排除。** 和你说的一样，① 解释不了他这一例。

### 2. 解析链每一档的实际返回值

自检走的是 `resolveBackendTool()`，它**只认已安装的后端包**，**从头到尾没有包内这一档**。
他那句「已安装的 `ytdlp-win-x64` 包里没有 `whisper-cli.exe` —— 不会拿别的包的二进制去跑」
说明解析器**看了已装包、正确地拒绝了**，然后 —— **没有下一档可落**，直接 `null`。

对着他那批字节（把修复后的 dist 覆盖进去，空数据目录，按启动器方式设环境变量）实测：

| | 修复前（调查那位实测） | 修复后（我实测） |
| --- | --- | --- |
| `GET /api/selfcheck` → `tool.whisperCli` | 找得到 | 找得到 |
| `POST /api/backends/selftest` → `resolved.whisperCli` | **null** | `…/runtime/probe/whisper-cli` |
| `resolved.audio` | **null** | `…/vendor/whisper.cpp/samples/jfk.wav` |
| 缺什么 | whisper-cli + model + audio | **只剩 `asr-model`**（仍报 `blocked` + remediation） |

### 3. 改了什么（三处同源，收敛成一份解析器）

新增 `packages/runtime/src/bundledRuntime.ts`。放 `runtime` 是因为 `pipeline → runtime`
这条依赖已存在（反过来不行），而 `shared` 被网页引用、不能碰 `node:fs`。

| 处 | 原来 | 现在 |
| --- | --- | --- |
| `pipeline` 的 `fromBundle()` | 只读 `OPENMEMO_BUNDLED_WHISPER_DIR` ⇒ **不经启动器**起的 daemon 与 `scripts/selfcheck.mjs` 看不见 | 共用解析器：环境变量优先，取不到就**从模块位置向上找** `runtime/probe` |
| daemon 自检 `resolveBackendTool()` 那条 | **没有包内这一档** | 补上，**排在最后** |
| `runtime` 的 `selfcheck.ts` 标签 | 「来自系统 PATH，非本产品安装 —— 用户机器上不一定有」 | ok +「随预编译包出厂」 |

⚠️ **不写死上溯层数**：包内 `app/node_modules/@openmemo/*/dist` 上溯 5 层是包根，
仓库 `packages/*/dist` 上溯 3 层是仓库根 —— 层数不同，所以逐层向上找
「有没有 `runtime/probe`」。仓库根下没有 `runtime/` 目录（已核实），
所以开发树上它一定返回 `null`，那也是对的。

⚠️ **顺序守住了**：**已安装包 > 环境变量/手工布局 > 包内兜底**。
包内只有 CPU 后端，排到前面会让装了 CUDA/Vulkan 的人自检跑包内 CPU，**RTF 就是错的**
—— 那比"自检说没有"更糟，因为它给出一个看起来正常的错数字。
**钉住某个包自测那一支不加兜底**，缺前提照旧 `blocked`，判据一点没放宽。

### 4. `jfk.wav`：按原路径原名打进包，零代码改动

`repoSampleAudio()` 上溯 4 层在包内正是包根 —— **代码早就在找对地方，只是那儿一直是空的**，
所以 `audio: null` 对**每个包用户**都是必然。打包日志：
`✔ vendor/whisper.cpp/samples/jfk.wav（0.3 MiB，原名不可改）`。

**原名生效的证据**：装上 `whisper-tiny` 之后再点自检 ——

```
status:"ran"  passed:true
rtf 0.13527   speedup 7.39x   backendUsed CPU   audioSeconds 11
**transcriptSimilarity: 1**
summary: Self-test passed on CPU backend: 11.0s of audio in 1.49s — about 7x real time
```

`transcriptSimilarity: 1` 只有在自检用上**内置参考文本**时才可能 —— 而它靠的就是 `jfk.wav` 这个名字。

顺带一条**它做对了、值得留着**的行为：`recorded: false`，理由
「这次跑的 whisper-cli 不属于任何已安装的后端包…无法认领 —— 不会随便挑一个包记上去」。
包内那份确实不属于任何包卡片，**它没有去冒领**。

### 5. 三平台上自检真的能跑起来吗

| 平台 | 结论 |
| --- | --- |
| linux-x64 | ✅ **实测跑起来并通过**（上面那组数，对着 v0.5.0 真包 + 修复后的 dist） |
| win32-x64 | 包已产出（run 31305488356），`e2e-allcomponents` 未回归；**自检那一跑 `[未验证]`** |
| darwin-arm64 | ⚠️ **拿不到包** —— 打包在**别人那条**「模拟用户动作（双击/Gatekeeper）」步骤上失败（`ditto: cpio read error`、横幅文案断言），**排在 upload-artifact 之前**，所以没有产物。**`[未验证]`** |

`[实测]` 我这一步在三平台的打包日志里都是绿的（`④-quater … 0.3 MiB`），
macOS 只是**后面**别人那步红了。**我没有碰他们的文件。**

`e2e-allcomponents` 对新包（linux）**全绿**（run 31305857150），无回归。

### 6. 「正在安装」那条：**我没量，明说**

用户装的是**后端包**，与此前量过的模型下载不是同一条路径，上次那组数不能套。
这一轮我把预算花在了定位与三处修复上，**没有量**。`[未验证]`，建议另派。

### 7. 门禁（隔离 worktree 检出 `3c4543e`）

| 门禁 | 结果 |
| --- | --- |
| `pnpm -r test` | **1615 / fail 0**（基线 1615） |
| `tsc -b` / `build:safe` | 0 / 0 |
| `eslint .` / `prettier --check .`（全仓） | 0 / 0 |
| `test:ci-scripts` | 0 |
| `check:orphans` | 零引用导出 **70**（基线 70） |
