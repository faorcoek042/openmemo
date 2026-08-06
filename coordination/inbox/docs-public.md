# inbox / docs-public

## [2026-08-06 20:05] T-156 DONE —— README 与部署手册

交付:
- `README.md`（**新建**，仓库此前一个都没有）
- `docs/DEPLOYMENT.md`（**新建**）
- 本回执

未碰: `:10000`（**一次请求都没发**）· `/root/data-memo`（未读未写）· `~/.local/share/openmemo/datadir.json`
（sha256 仍是 `7f930979…0da233f3`，与 `frontend-truth` 记录的**逐字符相同**）· `apps/web/dist`
（`index.html` mtime 仍是 `2026-08-06 18:17:06`，我动手前的值）· `BOARD.md` / `ROSTER.md` /
`docs/adr/**` / `00-CHARTER.md` / `HANDOFF.md` / `docs/design/**`（只读引用，一个字没改）·
`.github/**` 与 `scripts/ci/**`（`ci-upload` 的领地）· 没建/改/删 release · 没用 `pkill -f` ·
**本机没跑过一次 whisper 转写**。

---

# TL;DR

| # | 事 | 结果 |
|---|---|---|
| ① | 仓库公开却连 README 都没有 | ✅ 补上了。**逐平台照 D-11 与 CI 实测写，不照章程写** |
| ② | 部署手册 | ✅ `docs/DEPLOYMENT.md`，10 节，含三条运行时下限、数据目录四件事、密钥、备份/卸载、8 类故障排查 |
| ③ | 「写完自己跑一遍快速开始」这条判据 | ✅ **跑了**，在临时数据目录里。**跑出了 3 处要改文档的地方**（见 §2），改的是文档不是措辞 |
| ④ | GitHub 仓库描述文案 | 见 §5。**我没有调 API 改仓库设置**，交给你 |

**最重要的一条**：验证过程当场抓到 **HANDOFF.md 的一句话已经过期**，而我第一版 README 照抄了它 ——
「根 `package.json` 的 `build` 只走 `tsc -b`，不会产出 SPA bundle」。
`[本机实测]` 现在根 `build` 就是 `pnpm -r build`，两条完全等价。**如果我没真跑那一步，
这句假话会以"三份文档互相印证"的形态被复制到第四份里。** 两份新文档里都写了订正与"以 package.json 为准"。

---

# §1 我实际跑了什么（这一节是判据，不是流水账）

全部在 `/tmp/docs-public/` 下的临时数据目录里，指针文件一律用 `OPENMEMO_POINTER_FILE` 重定向到
`/tmp`（PROTOCOL §9-bis：**不是"写完记得擦"，是根本不写那个全局位置**）。端口用 18811 / 18812，
最后一次用默认 17650 起了 7 秒验证启动横幅，随即 `kill -TERM` 释放。

| 步骤 | 结果 |
|---|---|
| `pnpm build:safe` | ✅ 8 个包全 Done，`build-info: b017fc38+dirty @ 2026-08-06T19:41:26+08:00` |
| 网页 bundle（`vite build --outDir /tmp/docs-public/webdist`，PROTOCOL §7 的正解） | ✅ 构建成功；用 `OPENMEMO_WEB_DIST` 让 daemon 托管它 → `GET /` 200 / 3555 B / `<title>OpenMemo</title>` |
| 起 daemon（全新临时 dataDir） | ✅ `GET /api/health` 200；`GET /api/selfcheck` **25 条**，`{ok:7, warn:13, fail:5}` |
| **网页装组件**（`POST /api/backends/install`） | ✅ `sqlite-vec-linux-x64` / `libsimple-linux-x64` / `whispercpp-cpu-linux-x64` 三个 job 全 `succeeded` |
| `health.restartRequired` | ✅ 装完真的翻成 `true`，文案「中文分词器已安装，需重启生效」 |
| **网页触发自我重启**（`POST /api/daemon/restart`） | ✅ 换了 pid；`tokenizer` 从 `trigram` → `simple`，`libsimple`/`sqliteVec` 双 `true` |
| **网页拉模型**（`POST /api/models/pull`） | ✅ `asr/whisper-tiny-q5_1` 32 MB；**这台机器直连 HF 不通，job 的 `provider` 是 `modelscope`** —— 多镜像回退是真的 |
| 装完的自检 | ✅ `{ok:18, warn:7, fail:0}`；`ext.chineseSearch = ok 用户:1 推特:1 中国:1 服务:1` |
| **搬数据目录**（`POST /api/settings/data-dir`，`moveExisting:true`） | ✅ `strategy:"rename"` · 66 文件 / **11 条符号链接** / **`staleLinks: []`**；重启后 `backend.libLinks = ok（8 条链接全部可读到目标内容）`，`model.asr` 仍 ok |
| **删数据目录**（用户明确要求过的那条） | ✅ 运行中 `rm -rf` → `health` 200 / `notes` 200；停掉重启 → 自动重建空目录，回到冷启动的 7/13/5 |
| CLI 自检 `node scripts/selfcheck.mjs --data-dir <tmp>` | ✅ 按层渲染、exit 0 |
| CI run **31076010999** | ✅ `gh run view` 确认 `conclusion: success`，三平台三个 job 全绿；**逐条 grep 过 3025 行日志**，README 里那张平台表的每个数字都出自它 |

**没跑的（如实）**：`pnpm install`（见 §3）· `pnpm -r build`（含 `vite build` 写 `apps/web/dist`，PROTOCOL §7 禁止）·
**任何一次真实转写**（用户明确禁止本机跑 whisper）。

---

# §2 ★ 跑出来的三处「文档要改」（这一节是这次验证的全部价值）

## 2.1 🔴 HANDOFF 的 `build` 那句已经过期，而我第一版照抄了

我第一版 README 写的是：「`pnpm -r build` 的 `-r` 不能省。根 `package.json` 的 `build` 走
TS project references，不带 `-r` 就不会产出网页 bundle。」——**照抄 HANDOFF ② 的原文。**

`[本机实测]` 打开 `package.json`：

```json
"build": "pnpm -r build",          ← 根 build 与 `pnpm -r build` 完全等价
"typecheck": "tsc -b",             ← 这一条才是「走 project references、不产出 bundle」的
"build:safe": "pnpm --filter \"!@openmemo/web\" -r build",
```

**真正会咬人的是另外两条**（`pnpm typecheck` 与 `pnpm build:safe` 都不产出网页），
而不是"忘了带 `-r`"。两份文档都改成按 `package.json` 写，并各留一句「HANDOFF 那句已过期，
以 `package.json` 为准」。

> 这正是今天在清的那类债的**生成机制**：一句过期的话被下一份文档当作事实引用，
> 引用得越多越像被印证过。**唯一能拦住它的就是真去跑一遍。**

## 2.2 `POST /api/backends/install` 的字段名是 `id` 不是 `packId`

我按直觉写 `{"packId": ...}` → `400 BAD_REQUEST / 缺少后端包 id`。
改 `{"id": ...}` 才对。文档里写的是实际跑通的那个。

## 2.3 `/components` 与 `/diagnostics` **不在侧栏**

`[读码 apps/web/src/App.tsx:56-69]` 侧栏只有 7 项（notes / starred / record / runtime / models / tasks / settings）。
`/components` 从 `/runtime` 页的链接进（`RuntimePage.tsx:146`），`/diagnostics` 由
`ReadinessBanner.tsx:228` 的按钮进。**两页都可达，但"侧栏点得到"是假的**，所以文档里
写的是"从 `/runtime` 进去（不在侧栏）"。

---

# §3 ⛔ 我写进文档但**没能亲自验证**的每一条（任务书点名要的清单）

按"我用了什么级别的证据"分档。**同一条不会在上面被写成已验证。**

## 3.1 完全没验、且文档里已标 `[未验证]` 的

| 条目 | 文档位置 | 状态 |
|---|---|---|
| **macOS ≥ 13.3 这条下限的真实症状** | DEPLOYMENT §1.2① | 我没有 Mac。`minos` 数值是 `pack-publish` 解包读 `LC_BUILD_VERSION` 得到的 `[CI 实测]`；「低于 13.3 会被 dyld 拒绝」这个**后果**没有人在真机上看到过 |
| **Windows 缺 VC++ 运行时的后果** | DEPLOYMENT §1.2③ | PE 导入表是 `[CI 实测]`，但 `win-fixes` 自己标的就是 `[未验证：需一台干净的 Windows]`，我原样沿用，没有加强 |
| **Linux glibc 2.38 那条** | DEPLOYMENT §1.2② | `objdump` 结果是 `[CI 实测]`；「在 Ubuntu 22.04 上加载失败」是**从符号版本推出来的**，没有人真在 22.04 上试过。而且那个包**根本不在目录里**，我在文档里明确写了"今天这条不伤用户" |
| **ANE：真机上 `asr.coreml` 从 warn 变 ok** | README 诚实一节 / DEPLOYMENT §8.3 | 照 `last-mile` 回执原文抄的 ⛔，**没有替它下结论**。`checkCoreMl()` 在非 darwin/arm64 上直接 return，这台机器产生不出这一项 |
| **macOS 48 倍慢里 ANE 占多少** | 同上 | `pack-publish` 标的是 `[未定性]`（runner 是虚拟化 3 核 M1），我在两份文档里都写了"不要把 48 倍全算到 ANE 头上" |
| **删除数据目录窗口内的写操作行为** | DEPLOYMENT §7.3 | ADR-016 当年就标了未测，至今没人补。我照写 `[未验证]` |
| **内存下限** | DEPLOYMENT §1.1 | 没有任何人做过测量，产品也不会因内存不足而拒绝。写了 `[未验证]` |

## 3.2 有别人的实测、但**我没有独立复核**（`[报告]` 级）

| 条目 | 文档位置 | 来源 |
|---|---|---|
| **F1 链接导入的全链路**（真下载 → 转写） | README F5 表 | `gpu-runtime` 2026-08-02 在这台机器上跑过（`adapter: yt-dlp \| downloaded 252182 bytes`）。我**没有复跑**（会打真实站点），CI 也不跑它。文档里明确标了 `[报告]` 与"我没有独立复核" |
| **`hf-mirror.com` 只是 308 跳回 HF** | DEPLOYMENT §8.6 | `catalog-truth` + `vad-fix` 两方独立实测。我只间接观测到"HF 直连不通、自动换 ModelScope 成功"，**没有单独测 hf-mirror** |
| **搬家的 `fs.cp` 会改写相对软链**那段事故史 | DEPLOYMENT §3.4 | `[读码 move.ts:11-31,459-474]` + T-128 的记载。我验的是**修复后的结果**（`staleLinks: []` / `libLinks ok`），**没有把修复拆掉复现故障** —— PROTOCOL §10 不许在共享工作树里做反向验证 |
| **Windows / macOS 上的一切行为** | 全文 | 本机只有 Linux x64。所有非 Linux 结论一律来自 `run 31076010999` 的日志或别人的回执，**我一条都没声称是自己验的** |
| **`meta.sameSource`（网页与 CLI 同源）** | DEPLOYMENT §6 | D-11 §6.6 的 CI 实测。我分别跑过两个出口、结果一致，但**没有逐 id 比对过** |

## 3.3 我做了**推断**的地方（只有一处，明确标出来）

**「Windows + NVIDIA CUDA 今天装不上」** —— README 诚实一节 + DEPLOYMENT §1.3。
这条是三份证据合起来得出的，不是任何一份直接说的：

1. `[本机实测]` `GET /api/runtime/hardware` → cuda/vulkan/rocm/metal 四条全是
   `probe did not complete: probe executable not found`；
2. `[读码 packages/runtime/src/backends/applicability.ts:91-97]` 探针为 `null` 时 L2 一律 `applicable:false`；
3. `[CI 实测 run 31076010999]` Windows runner 上"适用于本机"的包正好 **5 个，不含 CUDA**
   （目录里 Windows 平台的包其实有 6 个）；
4. `grep openmemo-probe vendor/manifests/*.json` → **0 命中**（CI 会构建它，没有任何清单提供下载地址）。

第 3 条是**直接观测**，所以我认为这条结论站得住 —— 但**它是我拼出来的，不是现成的**，
所以放在这里而不是当成引用。`pack-publish` 的遗留表里只写了「`openmemo-probe` 的分发通道 ⛔ 老债还在」，
**没有人把它和"Windows CUDA 包因此装不上"连起来说过。**

## 3.4 一处我**故意没写进文档**的

`.gitmodules` 文件头的注释仍写着「FFmpeg … 改用 npm `ffmpeg-static`（GPL-3.0，B 类）」——
而 `ffmpeg-static` **已被 T-145 整条删除**（D-11 §7.4）。这是一条真的过期注释，
但它在仓库根目录、属于构建配置而非我的交付物，且改动它会牵动许可证叙事。
**没改，报上来由你裁。** 一行 diff 的事，要改的话建议改成「FFmpeg 走 `vendor/manifests/backends.json`
的 `media-tools-*` 包（GPL-3.0-or-later，C 类运行时下载）」。

---

# §4 两份文档的取舍（三条，理由不是口味）

| 决定 | 理由 |
|---|---|
| **README 不放"架构图 / 技术栈徽章 / roadmap"** | 它们是最容易过期又最没人复核的东西。README 只回答四个问题：这是什么 · 现在真能干什么 · 怎么跑 · 哪些是假的 |
| **"诚实一节"放在快速开始之后、许可证之前，而不是塞到最后** | 放最后等于没写。里面那五条（AMD 无产物 / Linux CUDA 不接 / macOS Intel 已裁 / Windows CUDA 装不上 / ANE 未在真机验证）**每一条都能让人白忙半天** |
| **平台表的判据写成"干净机器上真的转出非空文本"，并把这句话印在表旁边** | 上一版这张表三个平台全红，不是因为退步，是因为这个问题第一次被问出口。**判据一旦松掉，表就会自己变绿** |

另外：README 里那句「`[未验证]` 这个词在本文出现了很多次，那是故意的」是刻意留的 ——
它把"这份文档承认自己有边界"变成读者第一屏就能看到的东西。

---

# §5 GitHub 仓库描述的建议文案（**我没有改仓库设置**，交给你）

`gh repo edit --description` 那条命令我一次都没敲。三个长度档任选：

**① 一句话（推荐，115 字符，GitHub 描述框放得下）**

```
本地部署的音视频笔记工具：链接/文件/录音 → 本机转写 → 在线大模型整理成思维导图。GPU 组件与模型全部在网页里安装。
```

**② 更短（要压到 80 字符以内时）**

```
本地优先的音视频笔记工具 —— 本机转写 + 思维导图，组件与模型全在网页里装。
```

**③ 英文（如果要双语）**

```
Local-first audio/video note-taking: on-device transcription, LLM mind-maps, and GPU backends installed entirely from the web UI.
```

配套建议（都不是我能改的）：

- **Topics**：`whisper-cpp` `local-first` `speech-to-text` `mindmap` `self-hosted` `sqlite` `typescript` `note-taking`
- **不要**在描述里写"支持 CUDA / AMD / 全平台加速" —— 那正是章程 §3 里已被订正掉的那几行。
- Website 字段留空（没有官网，填了就是第一条假话）。

---

# §6 纪律

| 条 | 结果 |
|---|---|
| `:10000` 只读 | ✅ **一个请求都没发**（用户在用它预览）。pid `3478074` 全程未变，端口未被占用、未重启、未 kill |
| `/root/data-memo` | ✅ 未读未写，mtime 仍是 `2026-08-06 18:17:11` |
| 全局指针 `~/.local/share/openmemo/datadir.json` | ✅ sha256 `7f930979b85204d4c05b221f4c17a5cf5936a4d432a46488816727f60da233f3`，与 `frontend-truth` / `last-mile` 记录的**逐字符相同**；mtime 仍是 `2026-08-04 01:06:59`。**我起的每一个实例都用 `OPENMEMO_POINTER_FILE` 重定向到 /tmp** |
| `apps/web/dist` | ✅ 未被覆盖，`index.html` mtime 仍是 `2026-08-06 18:17:06`。**一次 `pnpm -r build` / 裸 `vite build` 都没跑**，验证走 `--outDir /tmp/docs-public/webdist` |
| `pkill -f` | ✅ 未用。停自己的实例一律 `kill -TERM <pid>`，pid 从 `GET /api/health` 取 |
| release / 仓库可见性 / 分支保护 / 仓库描述 | ✅ 一个都没碰（`gh` 只用过只读的 `run view`） |
| 本机 whisper 转写 | ✅ **一次都没跑**。装了 `whispercpp-cpu-linux-x64` 与 tiny 模型，但**没有创建任何转写 job** |
| `.github/**` · `scripts/ci/**` | ✅ 未碰（`ci-upload` 在途：`package.json` 与 `scripts/ci/lint-workflows.mjs` 改动全程避开） |
| `BOARD.md` / `ROSTER.md` / `docs/adr/**` / `00-CHARTER.md` | ✅ 只读。要改的地方写进本回执（§3.4）而不是自己动手 |
| `HANDOFF.md` / `docs/design/**` | ✅ 引用而未改写。发现 HANDOFF 一处过期（§2.1），**订正写在我自己的文档里** |
| `git add` | ✅ **逐个文件，3 个，零 `-A`**（`README.md` · `docs/DEPLOYMENT.md` · 本文件） |
| 起过的服务 | 端口 **18811 / 18812**（临时 dataDir），以及最后 7 秒的 **17650**（验证默认端口横幅，已 `kill -TERM` 释放）。全部已停 |
| 临时文件 | `/tmp/docs-public/`（仓库外）。数据目录与临时 webdist 已删，只留 4 份日志备查 |

## 建议 Manager 顺手处理的两件（都不是我能写的文件）

1. `.gitmodules` 文件头那条已过期的 `ffmpeg-static` 注释（§3.4，一行 diff）。
2. 仓库描述 + topics（§5）。
