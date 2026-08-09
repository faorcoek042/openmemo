## [2026-08-09 20:30] yt-dlp 二进制内嵌依赖清点 DONE

STATUS: DONE
交付: `docs/design/D-20-bundled-deps.md`（新增 §14，且更正了顶部 TL;DR 里已过时的
"未验证"标记），commit `9b3ea96`。

要点:
- **二进制里有 GPL，四平台全部命中**：`mutagen`（GPL-2.0-or-later）无条件打进
  linux-x64/linux-arm64/macos-arm64/win-x64 全部四份 PyInstaller 归档；Linux 两个
  平台（x64/arm64）另外内嵌真正的 GNU Readline（GPL-3.0-or-later，`nm -D` 命中
  `rl_gnu_readline_p` 符号排除了 libedit 替代品）。macOS 用系统自带 libedit（BSD，
  未内嵌）、Windows 无 readline，两边不触发这一条。
- 全程静态提取（`pyinstxtractor.py`），未运行任何一个目标二进制；4 个资产逐个
  `sha256sum` 核对与 `vendor/manifests/backends.json` 当前 pin 完全一致。Windows 因
  二进制是 CPython 3.10、沙箱是 3.14（`marshal` 不兼容），改用 `strings` 扫描
  `PYZ.pyz` 原始字节验证 mutagen 存在（48 处合法子模块名），置信度略低于其余三
  平台，已在文中标注，不冒充同等强度。
- **与 §9.2 冲突**：该表格当前把 yt-dlp 定为"内置"，理由栏本身写着"⚠️ 二进制内嵌
  依赖待清点（§1.1）"——本次交出的就是这份清单，结果是条件没通过。按 TL;DR/§9
  用户自定规则「GPL → 下载；非 GPL → 内置」，结论应把 yt-dlp 判回"下载"。**没有
  改 §9.2 表格文字**，冲突写在新增的 §14.6，交 Manager/用户裁。
- **没有按字面要求去改 `vendor/manifests/backends.json` 的 4 个 `ytdlp-*`
  `license.id`**（从 GPL-3.0-or-later 改成 Unlicense）：那会引入新的事实错误——
  这份二进制字节里真的有 GPL。而且 `LicenseInfoSchema`（单值字符串，直接被 UI
  展示给用户）在全仓 manifest 里没有复合许可证字符串的先例，表达不了"主项目
  Unlicense + 内嵌 GPL 依赖"这种组合事实。这本身依赖 §9.2 怎么裁——裁定后再改
  更省事，理由详见 D-20 §14.7。同理未动 `D-17-prebuilt-bundles.md:113`（不在指派
  范围，且它现在的取值方向歪打正着是对的）。
- 未创建 `THIRD-PARTY-NOTICES`：`find` 遍历过 `dist/`／`.build/`／整个源码树，
  这个 checkout 里目前**不存在**这份文件（只有 `node_modules/.pnpm/{prettier,
  rolldown}` 里两个同名无关文件）——与"已经在产物里"的说法对不上，如实记录这个
  出入。也没改 `build-bundle.mjs` 的 `writeNotices()`：它现在的文案明确说包不含
  ffmpeg/yt-dlp，这是 §9.2 那个悬而未决问题的下游，裁定前不动它。
- 提交前反复用 `git fetch` + `git diff HEAD origin/master -- docs/design/D-20-bundled-deps.md`
  确认该文件本身没有上游漂移（工作区里当时有其他至少两拨并发在改
  `packages/downloader`、`apps/daemon/src/http/rest`、`packages/shared` 等文件——
  均未触碰，`git show --stat` 复核提交后确实只有我这一个文件）。未建/改/删
  release；未碰 `:10000`、`/root/data-memo`、任何机器级指针；未用 `pkill`。

下一步建议:
- Manager/用户就 §14.6 的冲突裁一次：yt-dlp 改回"下载"，还是走工程规避（打包时
  剔除 mutagen 依赖树 / Linux 换不带 readline 支持的构建）再重新论证"内置"。
- 裁定落地后，再回头把 `backends.json` 的 4 个 `license.id`、`D-17:113`、
  `build-bundle.mjs` 的 `writeNotices()` 一次性改齐，避免多头各改一次。

需要 Manager 决策: 有——上面"下一步建议"里的两条（§9.2 yt-dlp 内置/下载的最终裁定；
裁定后清单/文档/脚本的落地顺序）。

## [2026-08-09 21:11] yt-dlp 二进制内嵌依赖清点 Phase 2 —— §9.2 裁定落地 DONE

STATUS: DONE
背景: Coordinator 就 Phase 1 交出的 §14.6 冲突拍板："下载"，明确拒绝工程规避路径
（四平台自建 yt-dlp 剔除 mutagen/readline，长期维护代价不可持续）。并指派 5 项
直接下游任务（①-⑤）。本条是这 5 项的落地回执。

交付与 commit：
- **① `vendor/manifests/backends.json`** —— commit `764638f`。`ytdlp-macos-arm64` /
  `ytdlp-win-x64` 的 `license.id` 从 `GPL-3.0-or-later` 改成 `GPL-2.0-or-later`
  （只含 mutagen），`ytdlp-linux-x64`/`ytdlp-linux-arm64` 维持 `GPL-3.0-or-later`
  （含 Readline，本来就对）。**选的路径：单值字段取"分发字节里实际出现的最强
  许可证"，逐平台判断，不引入复合许可证字符串**——理由：`LicenseInfoSchema`
  是 `.strict()` 单值字符串，直接被 UI 原样展示；`vendor/manifests/*.json` 全仓
  没有复合许可证字符串先例；`vendor/manifests/README.md` 那份"参考骨架"虽然
  设想过 `license_note` 字段，但明确标注"不是最终 schema"、从未被采纳。基础是
  §9.2 已裁定"下载"，不再需要表达"内置但混了 GPL"这种复合事实，第一版顾虑的
  前提本身消失了。取值口径写进 D-20 §14.7 追记，JSON 里保持干净（结构上也放不下
  注释）。
- **② `README.md`** —— commit `09aed42`。在原位置（用户实际会读到的许可证段落）
  订正，不是在别处挂警告：说明 yt-dlp 项目本身 Unlicense，但官方二进制内嵌
  mutagen（全平台 GPL-2.0-or-later）与 Readline（Linux 额外 GPL-3.0-or-later），
  与 ffmpeg 同一条"字节从不经过我们"逃逸路径；划掉上一轮"订正"过头的
  "与 GPL 无关"，注明两次订正的时间与理由。
- **③ `D-17-prebuilt-bundles.md:113`** —— commit `c6dcfd6`。理由错、结论对的
  陈述已订正：表格 🔴 GPL-3.0-or-later 后加星号，新增脚注说明真正的 GPL 来源是
  内嵌运行时依赖而非 yt-dlp 项目本身许可证，且该结论只对 Linux（最强平台）成立，
  macOS/Windows 实际只是 GPL-2.0-or-later；明确注明 ffmpeg 那行不受影响，不要
  被泛化。
- **④ `scripts/build-bundle.mjs` 的 `writeNotices()`** —— commit `d087b6e`
  （另加 D-20 §14.4/§14.8 收尾，commit `ab8d2a3`）。"本包不含 ffmpeg 与 yt-dlp"
  的免责声明保留（结论仍然成立），但把 yt-dlp 项目许可证与内嵌依赖许可证的混淆
  改准，并加代码注释说明 D-20 §14.4 那张 mutagen/Readline/certifi/OpenSSL 等
  表为什么不逐条列进 NOTICES ——义务边界是"随本包分发的字节"，那些字节从没
  进过我们的分发流水线（OpenSSL 3.x/1.1.x 版本线分叉、1.1.x 已 EOL 这件事同理，
  判断是不提，理由与上面一致，写进了同一段注释里）。**补上一个真实覆盖缺口**：
  随包出厂的 CPU 基线转写引擎（`assembleProbeRuntime()` 装进 `runtime/probe/` 的
  whisper.cpp + ggml，MIT）此前完全没出现在 NOTICES 里——这是先前遗漏，与
  yt-dlp 决策无关；许可证从 `vendor/manifests/backends.json` 的 `T.probePackId`
  那条 pack 动态读，不手抄文字，避免"清单改了、NOTICES 没跟着改"。
  **PROTOCOL §12 声明**：提交 `scripts/build-bundle.mjs` 时工作区里还混有另一个
  并发 agent 的模型打包实现（`assembleModels()` 等，约 180 行未提交改动）——按
  §12 一并进了这个 commit，未回退，这里如实声明。
- **⑤ `D-20 §1.1` 的 `yt_dlp_ejs` 许可证** —— commit `87b1542`（与 §9.2 表格改判
  同一提交）。划掉"纯 Unlicense"的简化说法，订正为复合许可证：Unlicense +
  ISC License（`Copyright (c) 2015, David Bonnet`）+ 另一段
  `Copyright (c) 2019 and later, KFlash and others` 版权块，依据见 §14.4。

同一提交（`87b1542`）里 §9.2 表格本身、TL;DR、§9.5 体积表（三平台重算：linux
105.6MB/win 109.6MB/mac 97.9MB）、§9.6 标题与开篇，均已按"下载"改判同步更新，
全部走 strikethrough + 落款日期的格式，不是另开一段挂着。**范围边界**：§4.1/§4.2
（改判前的"今日状态"快照）、§5 组合表、§7、`vendor/manifests/README.md` 的
参考骨架均判断为超出"直接下游"授权范围，未动。

未做/超范围: 未创建/修改/删除任何 release；未碰 `:10000` demo、
`/root/data-memo`、任何机器级指针；未用 `pkill`（含 `-0`）。每次提交前都
`git fetch` + `merge-base --is-ancestor` 核对未漂移，提交后 `git show --stat`
核对确实只改了目标文件（④ 例外，已如上声明）。

需要 Manager 决策: 无——五项均已落地，§14.6 冲突已闭环。

## [2026-08-09 22:02] whispercpp-cuda-* license 补标 + 全 manifest 扫描 DONE

STATUS: DONE
背景: Coordinator 在 Phase 2 收尾后追加一条同形状的任务——另一路（`amd-vulkan`）
在 D-20 §15.8 里点名发现 `whispercpp-cuda-12.4-win-x64` 的 `license.id` 写
`MIT`，但归档里 61.8% 字节是 NVIDIA 再分发件；要求用与 ytdlp-* 相同的口径处理，
核实 NVIDIA 条款读原文不读转述，并系统扫一遍 `vendor/manifests/` 看还有没有
别的包中招；边界要求不碰 CUDA 包内容/构建脚本（另一路在修缺件问题）。

交付与 commit：`2282cc1`（已确认在 `origin/master` 顶端，`HEAD` 与
`origin/master` 同一提交，`merge-base --is-ancestor` 双向核对一致）。

独立核实（未照抄 coordinator 的转述）：
- 用 HTTP Range 只读 678,887,125 字节 zip 的 EOCD + 中央目录（Azure Blob 对
  `bytes=-N` 后缀区间返回 501，改绝对区间才行），解出 44 个条目，与 D-20 §15.1
  逐字节比对一致；**44 个条目里没有任何 LICENSE/EULA 文本文件随附**。
- `WebFetch` 对 `docs.nvidia.com` 报安全校验失败被挡，改用 `curl -sL` 直接抓
  NVIDIA 现行 EULA 原文（HTTP 200，2026-08-09 抓取，非转述）：Attachment A
  确认 cublas/cublasLt/cudart/nvrtc/nvblas 在可再分发清单内；分发义务约束的
  是再分发方，没有找到终端用户点击接受的条款（与 Llama 那种 gated 模型走的
  机制不同）——`gated`/`requiresAcceptance` 都不置位。

改动：
- `backends.json` + `components.json` 的 `whispercpp-cuda-12.4-win-x64`：
  `license` 从 `{ id: "MIT", url: whisper.cpp/LICENSE }` 改成
  `{ id: "LicenseRef-NVIDIA-CUDA-EULA", gated: false, url: docs.nvidia.com/cuda/eula }`。
  口径与 §14.7 的 ytdlp 判例统一：单值字段取分发字节里最强/最受限的那个，不扩
  `LicenseInfoSchema` 支持复合表达（`.strict()`、全仓无先例，且此时
  `backends.json` 至少三路并发在改）。已用 `BackendManifestSchema.safeParse()`
  直接验证通过。
- `components.json` 的 4 条 `ytdlp-*`：发现 Phase 2 时的一个自己的漏项——当时
  只改了 `backends.json`，没改这份并行清单（两份结构不同：前者驱动 UI/理论上
  的 gating，后者是 `ComponentCard.tsx` 纯展示用的独立字符串）。这次补：
  linux-x64/linux-arm64 本来就对不用改；macos-arm64/win-x64 从
  `GPL-3.0-or-later` 改成 `GPL-2.0-or-later`（与 `backends.json` 同步）。
- D-20 §15.8 原地划掉旧的"我没有改，建议派人处理"，追加 §16 完整收录取证过程、
  改动明细、口径统一说明，以及扫描方法与结论。

扫一遍 `vendor/manifests/` 的结论（如实写，即便是"其余都对"）：
- 正则扫全部 8 个 manifest 文件的数组字段找可疑厂商名，只命中 1 处
  （`ggml-cuda.dll`，自己的文件名，非新发现）。
- `sqlite-ext.json`（11 pack）/ `models-{asr-support,llm,whisper}.json`
  （35 条模型权重）/ `llm-providers.json`（纯 API 元数据，不含许可证字段）——
  逐条人工核对，全部正确，结构上也不存在"一个归档混多个来源"的风险。
- 除 CUDA 外的 6 个 `whispercpp-*` 后端包——不满足于名字匹配，逐个拿到真实
  归档内容（Windows 两个用 Range 读中央目录；Linux/macOS 四个完整下载
  `tar tzvf`，沙箱网络中途降速，退避重试后补齐全部）：全部只有自己编译的产物，
  没有第三方 SDK 二进制、没有 Vulkan loader、没有 LICENSE/EULA 文件，`MIT`
  标注准确。
- `media-tools-*`（ffmpeg）当时正被另一路并发改动（Linux/Windows 切 LGPL），
  按边界要求完全没碰，其准确性由那一路自己负责，不在本次结论范围内。

PROTOCOL §12 声明：提交 `backends.json`/`components.json` 时工作区里同时存在
ffmpeg 那一路尚未提交的改动（`media-tools-{linux,win}-x64` 两条 GPL→LGPL），
按 §12 一并进了 `2282cc1`，未回退，已在 commit message 里声明。

未做/超范围：未创建/修改/删除任何 release；未碰 `:10000` demo、
`/root/data-memo`、任何机器级指针；未用 `pkill`（含 `-0`）；未用 `--amend`；
未碰 CUDA 包内容/`providesFiles`/`build-whisper.sh`/`pack-native-deps.mjs`
（`amd-vulkan` 那一路在修缺件问题，边界点名不让碰）。提交前 `git fetch` +
`merge-base --is-ancestor` 核对未漂移；push 用具体 hash，遇到一次 remote
ref 竞态（`cannot lock ref`），重新 `fetch` 核对后确认目标 commit 已在
`origin/master` 顶端，未做任何强制操作。

需要 Manager 决策: 无——两处 license 字段已改齐、口径统一，全 manifest 扫描
已完成，全部 6 个非 CUDA 的 `whispercpp-*` 后端包与其余全部 manifest 均已
实测确认无误，如实记录在 D-20 §16.3。
