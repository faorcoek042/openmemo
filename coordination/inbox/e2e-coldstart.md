# e2e-coldstart（最小包 + 空数据目录 + 什么都没装的用户）

## [2026-08-08 21:10] e2e-coldstart DONE（含一条 Windows 上的**真实崩溃**）

交付:

- `.github/workflows/e2e-coldstart.yml`（新建，三平台）
- `scripts/ci/e2e-coldstart.mjs`（新建，走用户会走的那条路）

要点:

- **首屏那句话三平台逐字复现了用户看到的那一行。**
- **从零到可用，在 CI 上三平台都走得通**（最终 `missing = []`）——
  也就是说**我没有复现用户的故障**，这条结论比"修好了"更重要，理由见 §3。
- **抓到一条 Windows 上的真实崩溃**：下模型时 daemon **整个挂掉**（exitCode=1），
  症状与用户报的「点了没反应」高度吻合。**不是我的脚本的问题**（§4）。
- 三条红查下去**有两条是我自己脚本的缺陷**，差点当成产品 bug 报上去（§6）。

需要 Manager 决策: **有 1 条 —— §4 那条崩溃归谁修（在 `packages/downloader`，不在我这一路的地界）。**

---

## 1. 三平台上「从零把产品用起来」到底卡在哪一步

最终确认 run **31261033206**（三平台全绿）＋ run **31261593715**（补上「不传 `--data-dir`」那一节后，Windows 红在崩溃上）。

| 步骤                          | linux-x64 | darwin-arm64 | win32-x64            |
| ----------------------------- | --------- | ------------ | -------------------- |
| 空数据目录启动                | ✅        | ✅           | ✅                   |
| 首屏自检 / 两个页面路由       | ✅        | ✅           | ✅                   |
| 硬件探测（探针缺席下）        | ✅ 有结果 | ✅           | ✅                   |
| 目录里有可装的包              | ✅ 6/25   | ✅ 6/25      | ✅ 6/25              |
| 装组件 → 重启 → 缺失清单变短  | ✅        | ✅           | ✅                   |
| 装模型                        | ✅        | ✅           | ✘ **daemon 崩溃**    |
| 终局 `missing`                | `[]`      | `[]`         | 走不到               |

**三平台首屏完全一致**（这一行就是用户看到的那句话的来源）：

```
pipeline.missing = ["ffmpeg","ffprobe","whisper-cli","asr-model"]
```

安装全部可装组件并重启之后：`["ffmpeg","ffprobe","whisper-cli","asr-model"] → ["asr-model"]`，
再装完 ASR 模型：`[]`。

## 2. 装组件那条路，每一步的真实响应

**id 一个都不是我写死的** —— 全部来自产品自己交出来的目录（这是本轮的硬纪律：
硬编码 id 直接 `POST install` 正是此前漏掉这一整类的原因）。

```
GET /api/runtime/hardware   → HTTP 200，真实结果（os/cpu/ram/gpus/backends 全在）
                              cpu.brand="AMD EPYC 7763 64-Core Processor" …
GET /api/backends/catalog   → 25 个包，产品自己判定 6 个可装（win32-x64 那格）：
                              whispercpp-cpu-win-x64, media-tools-win-x64, ytdlp-win-x64,
                              whispercpp-vulkan-win-x64, libsimple-win32-x64, sqlite-vec-win32-x64
POST /api/backends/install  → HTTP 202 {"jobId":"01KZGTABVXQ…"}
GET  /api/jobs/<id>         → succeeded
GET  /api/backends/installed→ 独立核对：它真的在（不信 job 自述）
（其余 5 个逐个同样装完）
重启                        → [daemon] 工具表已热刷新: missing [ffmpeg,ffprobe,whisper-cli,asr-model] → [ffmpeg,ffprobe,asr-model]
                              [daemon] 工具表已热刷新: missing [ffmpeg,ffprobe,asr-model] → [asr-model]
GET /api/models/catalog     → 20 个分组 / 35 个条目
POST /api/models/pull       → HTTP 202 {"jobId":…,"totalBytes":574041195,"deduplicated":false}
```

⚠️ **产品推荐的默认 ASR 模型是 `asr/whisper-large-v3-turbo-q5_0`（清单标 1666 MB，
实际 blob 574 MB）** —— 一个刚打开产品的用户，第一次点「安装模型」就要下这么大。
这不是缺陷，但**值得产品侧知道**：它是冷启动体验里最长的一段等待。

**没有发现隐含的先后依赖**：六个包互相独立，任意顺序装都行；装到一半重启，
已装的照常被认出来（`安装记录迁移：6/6 条已升级为相对路径`），**状态不丢**。

## 3. ⚠️ 我**没有**复现用户的故障 —— 这条必须写在最前面

用户在 Windows 上「点安装模型完全没有任何反应」。
而这条腿在 **CI 的 Windows 上**：目录有 6 个可装、`POST` 拿到 202、job 跑到 succeeded、
重启后缺失清单真的变短。**HTTP 这一层是通的。**

所以他的故障**不在**「干净机器上的安装 HTTP 链路」。剩下的可能性（我**没有**逐条验证，标 `[未验证]`）：

1. **UI 层**（另有一路专门在解「点了没反应」）—— 按钮没接上、请求没发出、错误没渲染。
   这条腿只走 HTTP，**结构上覆盖不到点击**。
2. **他手里的 v0.3.0 release 资产 与 build-bundles 的 artifact 不是同一个东西** ——
   我测的是 artifact。`[未验证]`，建议有人比一次两者的 sha256。
3. **他的网络**（代理 / 企业防火墙挡住 GitHub Releases 与 HuggingFace）。
   CI runner 的出网是通的，这条在 CI 上**结构上验不了**。
4. **§4 那条崩溃**：daemon 一崩，页面上所有请求都失败 —— 表现就是「点了没反应」。
   **这条我复现了**，见下。

## 4. ★ 抓到的真东西：Windows 上下模型时 **daemon 整个崩掉**

`[CI 实测 run 31261593715，win32-x64]`：

```
POST /api/models/pull → 202 {"jobId":"01KZGVVTBV…","totalBytes":574041195}
✘ e2e-coldstart 中断：/api/jobs/01KZGVVTBV…: connect ECONNREFUSED 127.0.0.1:19810
   daemon: exitCode=1 signal=null pid=5168
   ── daemon 最后的输出 ──
      node:internal/fs/promises:784
        return await PromisePrototypeThen(
      Error: ENOENT: no such file or directory, rename
        'C:\…\data\models\blobs\sha256-394221709cd5….partial.jso…'
```

- **进程 exitCode=1** —— 不是任务失败，是**整个 daemon 没了**。
  用户视角：网页所有请求突然全挂，界面上"点什么都没反应"。**与他报的症状吻合。**
- 出事的地方：`packages/downloader/src/sidecar.ts:104-111` 的 `writeSidecar()`
  —— `writeFile(tmp)` → `rename(tmp, target)`，`tmp` 在两步之间消失了。
- 成因假设（**`[未验证]`，请勿当结论**）：同一个 `.partial` 的两次进度写并发，
  先到的那次 rename 走了 tmp，后到的那次 rename 扑空；
  Windows 的 rename 语义让这个窗口比 POSIX 宽。
  另一个候选是 `store.ts:264-265` 的 GC 会扫 `.partial.json.tmp`。
- **无论成因是哪个，`writeSidecar` 都不该让进程崩**：它是**断点续传的优化**，
  按它自己的注释，坏掉的最坏后果是"多下一遍"，而现在的后果是"整个产品挂掉"。

**我没有修它** —— 它在 `packages/downloader`，不在我这一路的地界，
而且成因还没定死（我只有一次实测）。**请 Manager 指派**。
我这条腿会一直红在这里，**修好之后自动变绿**。

## 5. 探针缺席这件事：如实报出来了，而且修好会自动变绿

```
自检   hw.probe   warn  required=false   openmemo-probe 未安装（后端能力未知）
目录   6 个后端带 unavailableReason:
       "probe did not complete: probe executable not found:
        C:\…\data\bin\runtime\openmemo-probe.exe"
```

**但它没有挡住从零可用这条路** —— CPU 那几个包不需要探测就判定为可装，
所以用户照样能把转写链装齐。探针缺席影响的是**GPU/加速后端选不出来**。

判据**刻意写成用户视角**（「目录里有没有可装的包」「装完缺失清单有没有变短」），
不写成「探针在不在」—— 所以另一路把探针放进包之后，**这条腿不用改一行就会变绿**。

## 6. 三条红里有两条是**我自己脚本的缺陷**（差点报成产品 bug）

`[CI 实测 run 31260530952]` 第一版三平台全红，逐条追下去：

| 现象                              | 真相                                                                 |
| --------------------------------- | -------------------------------------------------------------------- |
| 装完模型 `missing` 还有 asr-model | **我的锅**：在**全目录**找 `recommended-default`，挑中了 `llm/qwen3-4b-q4_k_m`（**2.4 GB 的大语言模型**）。推荐标签必须在 `role==='asr'` 内部找。 |
| 跑完 `missing` 还剩 ffmpeg/ffprobe | **我的锅**：只装了 `applicable[0]`，根本没装 media-tools。改成把产品判定可装的**全部**装一遍。 |
| Linux 首屏只报 `["asr-model"]`    | **我的锅**：默认屏蔽宿主工具，shim 在 Linux 上（无扩展名 + `chmod +x`）被产品当成"装了"，在 Windows 上（产品找 `.exe`、shim 是 `.cmd`）没被当成装了 —— **于是 Linux 那一行是我伪造的**，而它正是本腿第 1 问要答的东西。 |

第三条尤其值得记：**屏蔽宿主工具对 `e2e-record` 是对的**（那里要让"借用"可见），
**对这条腿是错的** —— 这条要的是"用户那台干净机器"，不是"有一个坏掉的 ffmpeg"。
现在默认不屏蔽，并加了一条断言：**宿主 PATH 上有流水线工具就当场判红**
（这一问在这台 runner 上答不了，不是打一行小字然后照常报绿）。

还有第四条，发作在**我自己的汇报层**：整条腿被异常打断时，收尾台账照样打
「✔ 13 条关键断言全部成立」，**而进程正以 exitCode=1 退出** ——
「还没跑到的」被渲染成「跑过且通过的」，正是 §11 那种假绿。已修（明确区分"被打断"）。

## 7. 首屏那句「缺少工具」，我建议怎么改

现在用户打开看到的（daemon 横幅，三平台一致）：

```
[daemon] 以下组件还没装: ffmpeg, ffprobe, whisper-cli, asr-model
[daemon]    这是首次启动的正常状态，不是出错了。
[daemon]    打开网页后在「设置 → 组件」里点安装，装好会自动生效（不用重启）。
[daemon]    在此之前，转写类任务会先排队等着（blocked），不会丢。
```

**这段其实已经写得很好了** —— 它明说"不是出错了"、给了去处、说了后果。
`[实测]` 自检里 6 条 required 的红**每一条都带 remediation**，界面据它渲染"去安装"。

真正的问题在**顺序与措辞的第一印象**：第一行是"**缺**"，安慰在第二行。
一个刚双击的人读到的第一个词是缺失。建议（这是我的判断，不是实测结论）：

1. **把"正常"提到第一行**：`首次启动：还需要下载 4 个组件（约 XXX MB），这是正常的`。
2. **给出体积与时长量级** —— 现在用户不知道 `asr-model` 是 574 MB，
   点下去等十分钟会以为卡死了。这是"点了没反应"的另一种成因。
3. **"组件"改成用户认得的词**：`ffmpeg/ffprobe` → "音视频处理"，
   `whisper-cli` → "语音识别引擎"，`asr-model` → "语音识别模型"。
   现在这四个是**内部 id**，用户搜不到也读不懂。
4. 终端横幅与网页首屏**用同一句话**（我只验了终端横幅那份，网页那份 `[未验证]`）。

## 8. 结构上做不到的（人工清单）

这条腿走 HTTP，**覆盖不到点击**。以下必须人工在真机上过一遍：

- [ ] 双击 `start.cmd` / `OpenMemo.command`，浏览器自动打开
- [ ] `/runtime` 页面上「安装」按钮**点下去有反应**（进度条动、按钮变态）
- [ ] `/models` 页面上「安装模型」同上
- [ ] 下载失败时界面**说得出原因**（断网试一次）
- [ ] 装到一半关窗口再打开，进度不丢
- [ ] 用户的 v0.3.0 **release 资产** 与 build-bundles artifact 的 sha256 是否一致

## 9. 门禁（隔离 worktree 检出我自己那个 commit）

| 门禁              | 结果                                   |
| ----------------- | -------------------------------------- |
| `pnpm -r test`    | **1593 / fail 0**（基线 1589，我没加用例，+4 是同树其他 agent 的） |
| `tsc -b`          | 0                                      |
| `eslint .`（全仓）  | 0                                      |
| `prettier --check .`（全仓） | 0                           |
| `lint-workflows`  | 1399 条断言全过（15 个 workflow）      |
| `test:ci-scripts` | 0                                      |
| `check:orphans`   | 零引用导出 **70**（基线 70）           |

## 10. 欠账（如实记，没做就是没做）

- **这条腿的断言没有变异证明。** `e2e-record` 那套（纯函数 + `selftest-*`）是对的做法，
  这条腿的断言目前是内联的。**没做**，建议下一轮补 —— 在那之前，
  它的证伪能力只由"它真的红过四次、每次都指对了地方"这件事间接支撑。
- **`assertPortFree` / `killTree` 是同一份逻辑的第 N 份拷贝**
  （`e2e-runtime-audit.mjs` 等各有一份）。该提成 `scripts/ci/lib/`，
  但那要动别的 agent 正在改的文件，本轮**没动**。
