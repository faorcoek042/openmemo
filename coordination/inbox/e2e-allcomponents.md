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
