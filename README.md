# OpenMemo

**本地部署的音视频笔记工具。** 粘一个链接、拖一个文件、或者直接在浏览器里录音
→ 自动抽音轨 → **在你自己的机器上**转成文字 → 交给你自己配置的在线大模型整理成思维导图与摘要
→ 存进本机的 SQLite，可全文检索（含中文分词）、可与音频时间轴联动。

形态是 **本地 daemon（Node/TypeScript）+ 浏览器里的 React 单页应用**，不是 Electron。
装 GPU 加速后端、下载与切换模型，**全部在网页上点**，不需要碰命令行。

---

## 这份 README 的写法

本项目在文档上栽过跟头：一次逐条复核发现 187 条文档断言里有 113 条已经不成立，
其中最贵的一类是「文档写着没做、代码其实做了」——它让人去重做一件已完成的事，
或者以为某个功能不存在而绕开它。

所以**这里每一条能力声明都带出处**，没核实过的一律不写：

| 标记 | 含义 |
|---|---|
| `[CI 实测 run N]` | GitHub Actions 的干净 runner 上跑出来的，run 号可查 |
| `[本机实测]` | 在一台 Linux x64 开发机上跑过，本文写作时（2026-08-06）现跑的 |
| `[读码 文件:行]` | 读过源码，给出位置 |
| `[未验证]` | 没人验过。**这个词在本文出现了很多次，那是故意的** |

---

## 数据去哪了

- **音视频原件、转写稿、笔记、思维导图、检索索引** —— 全部在本机一个数据目录里
  （SQLite 主库 + 文件），默认位置见 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)。
- **转写全程不出网。** ffmpeg / whisper.cpp / VAD 都是本机子进程，音频不发给任何人。
  `[CI 实测 run 31076010999]` 三个平台各跑了一次「屏蔽宿主 PATH 的全新机器 →
  从网页装组件 → 拉模型 → 走产品真实路径转写 → 拿到非空文本」。
- **会出网的只有三件事，逐条说清楚**：
  1. **你自己粘的链接** —— yt-dlp / ffmpeg 去下载它（这是 F1 的定义）。
  2. **组件与模型的下载** —— GitHub / HuggingFace / ModelScope，每个文件都有钉死的
     sha256，下完必校验（`[CI 实测]` 清单里 62 个文件 sha256 覆盖 100%，
     见 `docs/design/D-11-ci-platform-facts.md` §6.2）。
  3. 🔴 **思维导图与摘要 —— 调你自己填的在线大模型 API。**
     转写稿的相关片段会发到那个服务商（DeepSeek / OpenAI 兼容接口 / …）。
     **这一半不是本地的，本文不粉饰它。** ADR-016 记录了这是用户的明确决定
     （「语言模型我们不要本地自己接模型做，要和 memo 一样，接入在线模型 API」）。
     不填 Key 时：导入、转写、检索、播放、笔记编辑照常，只有思维导图/摘要不可用
     `[本机实测]` 自检项 `llm.tier1` 会报 `warn 未配置（provider=无 key=无）`。

---

## 现在真的能做什么

### 逐平台（判据是「干净机器上真的转出字来」，不是「代码写完了」）

来源：`cold-start-audit` **run 31076010999**（`conclusion: success`，三平台三个 job 全绿）。
每个平台跑两组：**屏蔽宿主 PATH**（保证不是借了机器上已有的 ffmpeg）与不屏蔽的对照组，两组结论一致。

| 平台 | 目录里适用的包 | 产品自己下载并校验的工具 | 借宿主 PATH 的 | 真的转出非空文本 |
|---|---|---|---|---|
| **Linux x64** | 5 / 22 | **5** | **0** | ✅ 2.1s |
| **Windows x64** | 5 / 22 | **5** | **0** | ✅ 3.6s |
| **macOS arm64（Apple Silicon）** | 5 / 22 | **5** | **0** | ✅ 106.1s |

那 5 个工具是 `ffmpeg` / `ffprobe` / `whisper-cli` / `whisper-vad-speech-segments` / `yt-dlp`。
三个平台转出来的文本一字不差（108 字符，肯尼迪就职演说那句），切分方式都是「VAD（按静音）」。

> **macOS 那个 106 秒不是笔误。** 自检里写着原因：`asr.coreml warn 未启用 ANE ——
> 转写会走 Metal/CPU（功能正常，只是慢）`。runner 还是虚拟化的 3 核 M1，
> 这两个因素没有拆开过，所以**不要把 48 倍差距全算到 ANE 头上**。

**中文双字词真的搜得到**（判据不是"扩展文件下下来了"）：
`[CI 实测 run 31076010999]` 三平台 `ext.chineseSearch = ok`，命中 `用户:1 推特:2 中国:1 服务:2`。
`[本机实测]` 同一条在这台开发机上是 `用户:1 推特:1 中国:1 服务:1`。

### 五个基础功能（章程 F1–F5）

| # | 功能 | 状态 |
|---|---|---|
| F1 | 音视频**链接**导入（YouTube / Bilibili / 播客 / 直链） | yt-dlp 随产品下载并校验，`[CI 实测]` 三平台都装上了。全链路（真下载 → 转写）在 2026-08-02 被 `gpu-runtime` 在这台机器上真跑过一次（`adapter: yt-dlp \| downloaded 252182 bytes`）—— 这条是 `[报告]`，**我没有独立复核，CI 也不跑它**（会打真实站点）。同一轮它还查出并修掉了「yt-dlp 命中 `--max-downloads` 返回 101 被当成失败」这个让 F1 对每个视频都失败的 bug |
| F2 | **本地文件**导入（拖拽音频/视频） | ✅ 就是 `run 31076010999` 里那条路径（`/api/notes/import` → 转写 → 取转写稿） |
| F3 | **录音转文字**（浏览器内录音 → 流式 ASR） | 前端已接通 `[读码 features/recorder/asrStream.ts]`：AudioWorklet 采集 → Int16 帧推 `/ws/recorder`。⚠️ **需要安全上下文**：`http://<局域网 IP>` 下浏览器不给麦克风，见「诚实一节」 |
| F4 | 思维导图整理 | ✅ 已有真实产物；⚠️ **依赖在线 LLM**，没 Key 就不可用 |
| F5 | 笔记管理（列表/详情/搜索/标签/时间轴联动） | ✅ 全文检索含中文分词，见上 |

---

## 快速开始

**前置**：Node ≥ 22（`.nvmrc` = 22）· pnpm 10.15.0（`packageManager` 字段已钉死）。
不需要预装 ffmpeg / whisper / yt-dlp / CUDA —— 那些是产品自己去下载的。
**不需要 `git submodule`**：submodule 只在自己编译原生产物时才用得上。

```bash
git clone https://github.com/faorcoek042/openmemo.git
cd openmemo

pnpm install          # ① 依赖
pnpm -r build         # ② 构建（★ 必须带 -r，见下）
node apps/daemon/dist/main.js        # ③ 启动
```

然后浏览器打开终端里打印的那个地址（默认 `http://127.0.0.1:17650/`）。

**第一次进去先做两件事**，否则转写会转成 blocked：

1. 左侧「**运行时**」（`/runtime`）→ 安装本机适用的组件包（转写引擎、ffmpeg、yt-dlp、中文分词）。
2. 左侧「**模型**」（`/models`）→ 转写 Tab → 下载一个语音识别模型。
   ⚠️ **装完组件不等于能转写** —— 冷装之后目录里一个 ASR 模型都没有，这是产品事实
   （见 D-11 §7.3），自检会用 `model.asr fail` 明确告诉你。

装完组件后页面会提示需要重启，点它即可（daemon 自己重启，不用回终端）。

### 三条会咬人的细节

- **网页 bundle 只有 `pnpm -r build` 会产出。** `[本机实测 package.json]` 根 `build` 就是
  `pnpm -r build`（两条等价）。但另外两条命令**都不会**产出网页：
  `pnpm typecheck`（= `tsc -b`）不行 —— `apps/web` 的 tsconfig 是 `emitDeclarationOnly`；
  `pnpm build:safe`（= `pnpm --filter "!@openmemo/web" -r build`）也不行 —— 它是**故意**排除网页的。
  只跑这两条的话，daemon 起来之后 `GET /` 是空的。
  ⚠️ `HANDOFF.md` 里"根 `build` 只走 `tsc -b`"那句已经过期，以 `package.json` 为准。
- **端口默认 17650**，被占用时会在 `17650..17659` 里顺延，并且**会明确告诉你漂移了**
  （端口一变，浏览器的麦克风授权要重新点一遍 `[读码 bootstrap/single-instance.ts:38-45]`）。
- **只有两个命令行旗标**：`--port` 与 `--data-dir`。没有 `--host`，绑定地址走环境变量
  `OPENMEMO_HOST`。`OPENMEMO_PORT` **不存在**。

### 这几步的证据

| 步骤 | 谁验过 |
|---|---|
| `pnpm install --frozen-lockfile` | `[CI 实测 run 31076010999]` 三平台 success |
| `pnpm build:safe`（= 除网页外的全部包） | `[CI 实测 同上]` + `[本机实测 2026-08-06 19:41]` 8 个包全 Done |
| 网页 bundle（`vite build`） | `[本机实测]` 构建进 `/tmp` 后由 daemon 托管，`GET /` → 200、3555 B、`<title>OpenMemo</title>`（协作纪律不允许我写进仓库里的 `apps/web/dist`，所以走的是 `OPENMEMO_WEB_DIST`） |
| 启动 daemon（全新临时数据目录） | `[本机实测]` `GET /api/health` 200 |
| 网页装组件 → 重启 → 中文检索生效 | `[本机实测]` 装 `libsimple` + `sqlite-vec` → `POST /api/daemon/restart` → `tokenizer` 从 `trigram` 变 `simple`，`ext.chineseSearch = ok` |
| 网页拉模型 | `[本机实测]` `asr/whisper-tiny-q5_1` 32 MB 下载完成，自检 `model.asr` 从 `fail` 变 `ok`；**这台机器直连 HuggingFace 不通，是自动换到 ModelScope 镜像下下来的** |
| **本机跑一次真实转写** | ⛔ **没跑**（用户明确要求不要在这台机器上跑 whisper 转写）。转写这条路的证据全部来自 CI |

---

## 章程要求 2.1 / 2.2：GPU 组件与模型全在网页里装

这是本项目的核心卖点，也是它与"下载一个二进制包然后自己配环境变量"那类工具的区别。

**要求 2.1 原文**：所有依赖 GPU 的组件，其安装与配置通过网页完成 ——
网页检测硬件 → 推荐后端 → 下载对应预编译二进制 → 安装 → 自检 → 显示状态。
**要求 2.2 原文**：模型的浏览、下载、切换、删除、量化选择，也全部通过网页完成。

落在哪几页（路径都是真的，`[读码 apps/web/src/features/*/*.routes.tsx]`）：

| 页面 | 路径 | 干什么 |
|---|---|---|
| **运行时** | `/runtime` | 硬件信息 + 后端包目录：逐个显示体积/来源/许可证，点一下就装，装完能单独跑自检 |
| **模型** | `/models` | 转写模型（含量化档位选择）+ 语言模型两个 Tab；下载、切换、删除、磁盘占用分解 |
| **组件与来源** | `/components` | 每个组件的完整来源链：源码 commit → 发布页 → 二进制 → sha256 → 许可证；可单独更新与回滚。**从 `/runtime` 页进去**（不在侧栏） |
| **诊断** | `/diagnostics` | 全部自检项，见下 |

`[本机实测]` 整条链在这台机器上真的走通了，全程只发 HTTP 请求、没碰命令行：

```
POST /api/backends/install {"id":"libsimple-linux-x64"}     → 202，job succeeded
POST /api/backends/install {"id":"whispercpp-cpu-linux-x64"} → 202，job succeeded
POST /api/models/pull      {"id":"asr/whisper-tiny-q5_1"}    → 202，job succeeded（走 ModelScope 镜像）
POST /api/daemon/restart                                     → 202，daemon 自己换了进程
自检：fail 5 → fail 0
```

**自检不是摆设。** `GET /api/selfcheck` 返回 25 条，`/diagnostics` 页把它们**全部**渲染出来
（按层分组，分组顺序取数据里的首次出现顺序，**不写死白名单** —— 写死会让"daemon 新增一层"
变成"界面上悄悄少一层"）。`[本机实测]` 冷启动时 `{ok:7, warn:13, fail:5}`，装完变 `{ok:18, warn:7, fail:0}`。

---

## 诚实一节：已知不支持 / 未验证的

**这一节比上面那些表更重要。** 照 `docs/design/D-11-ci-platform-facts.md` 与各 agent 回执的原始标注写，
没有在这里做任何"应该可以"的推断。

### 明确不支持（有产物层面的事实，不是"暂时没做"）

| 组合 | 状况 |
|---|---|
| **Linux + AMD（ROCm）** | 🔴 **没有任何产物。** 唯一的产物来源是 `linux-x64-rocm` 构建腿，用户 2026-08-05 明确裁掉；上游 whisper.cpp 至今也没有 ROCm 版本。章程 §3 那一行在产物层面是空的，章程里已加订正块。**不要对着章程去装一个不存在的包。** |
| **Linux + NVIDIA（CUDA）** | 🔴 **目录里没有 CUDA 包。** 已经能编出来，但按 D-11 §8.4 的三条证据「纯增量的加速包在本产品里结构上不可用」，**不接进目录**。Linux 上目前只有 CPU 后端。 |
| **Windows + AMD（DirectML）** | 🔴 无产物。Vulkan 那条我们自己能编出来，但同样卡在 §8.4，**未接入**。 |
| **macOS Intel（x64）** | ✂ 用户 2026-08-05 明确裁掉，不构建。 |
| **linux-arm64** | ✂ 同上裁掉。（讽刺的一条：它那两个构建腿曾是唯二全绿的 Linux job，删的不是坏的那些，是用不到的那些。） |

### 目录里有、但今天装不上的

- **`whispercpp-cuda-12.4-win-x64`（Windows + NVIDIA）** —— 包在目录里，但它是 L2（需硬件探针门控），
  而 **`openmemo-probe` 至今没有分发通道**：CI 会构建它，但没有任何 manifest 提供它的下载地址。
  `[本机实测]` `GET /api/runtime/hardware` 里 cuda/vulkan/rocm/metal 四条全是
  `probe did not complete: probe executable not found`；
  `[读码 packages/runtime/src/backends/applicability.ts:91-97]` 探针为 null 时 L2 一律不适用；
  `[CI 实测 run 31076010999]` Windows runner 上"适用于本机"的包正好是 **5 个，不含 CUDA**。
  → **实际后果：Windows 上今天只有 CPU 后端能装。**

### 已编进去、但没在真机上验证过的

- **Apple 神经引擎（ANE / CoreML）** —— macOS 核心包里**已经带了** `libwhisper.coreml.dylib`
  `[CI 实测，包解开数过]`，链路上原先的 3 处断点也都修好了（解包多一层同名目录 / 前端不传
  `includeOptional` / 默认推荐的量化档没挂 encoder）。
  ⛔ **但"真机上自检的 `asr.coreml` 从 warn 变成 ok"这一半从来没被验证过** ——
  `checkCoreMl()` 第一行就在非 darwin/arm64 上直接 return，开发机是 Linux，产生不出这一项。
  `[CI 实测 run 31076010999]` 上那一项仍然是 `warn 未启用 ANE`（跑的是 tiny，没装 encoder）。
  这条按 `last-mile` 回执的原始标注抄录，**没有替它下结论**。
- **tiny / base / small / medium 的 CoreML encoder** —— ⛔ **没挂**。我们没有它们的 sha256
  （直连 HF 被网络策略挡住），**编一个摘要出来比不挂糟得多**。

### 运行时下限（装得上、跑不了、自检看不见的那一类）

见 [`docs/DEPLOYMENT.md` §1](docs/DEPLOYMENT.md)。三条：macOS ≥ 13.3、
Linux 侧 glibc、Windows 的 VC++ 运行时。**这一族的共同形状是：下载成功、sha256 通过、
安装记录 succeeded、自检全绿，只有真正去执行时才死。**

### 其它

- **代码签名**：不买证书。macOS 只做 ad-hoc 签名，Windows 完全不签。
  也就是说**我们无法向你证明二进制没被篡改**，只能靠 HTTPS + sha256 清单（ADR-003 决策 4）。
- **默认监听 `0.0.0.0`、鉴权默认关闭** —— 这是用户的显式决定，不是疏忽。
  它意味着任何能路由到该 `IP:端口` 的人都能读写你全部的笔记。
  部署前请务必读 [`docs/SECURITY.md`](docs/SECURITY.md) 的「当前真实姿态」一节。
- **非回环地址 + 明文 HTTP 下录音功能不可用** —— 浏览器只把 HTTPS 与 localhost 当安全上下文，
  `navigator.mediaDevices` 直接是 undefined。daemon 启动时会就这一条单独警告
  `[读码 apps/daemon/src/main.ts:911-916]`。
- **`0o600` 在 Windows 上不生效** —— `[CI 实测]` 写 `0o600` 读回来是 `666`，
  即 `runtime.json`（内含访问令牌）与 `secrets.json`（内含你的 API Key）
  **对本机所有用户可读**。需要 ACL 而不是 POSIX 位，**未修**。
- **浏览器 cookie 下载会员内容**：memo.ac 有，我们**明确不做**，理由是安全设计而不是工作量
  （`docs/SECURITY.md` §4.1）。
- **不做的**：TTS、移动端 App、团队协作、云端账号、支付。

---

## 许可证

### 本仓库

`package.json` 里写的是 **`UNLICENSED`**，且仓库根目录**没有 LICENSE 文件**
`[本机实测 ls]`。这是一个个人自用项目（ADR-002 v2：用户已明确"仅个人/自用，不追求商用、
不上应用商店"）。**如果你打算分发它，先读 ADR-002 的「升级路径」一节** ——
主要工作是自建 LGPL 版 FFmpeg，以及把 yt-dlp 改回可选插件。

### 上游组件（这才是许可证真正要看的地方）

事实来源是 `scripts/license-report.mjs`（`pnpm license:report`），产物 `license-report.md` / `.json`。

**A 类 —— git submodule（`vendor/`，我们自己编译）**

| 组件 | 版本 | 许可证 |
|---|---|---|
| whisper.cpp | v1.9.1 | **MIT** |
| sherpa-onnx | v1.13.4 | **Apache-2.0** |
| sqlite-vec | v0.1.9 | **Apache-2.0** |
| libsimple（SQLite 中文分词） | v0.7.1 | 上游 MIT **OR** GPL-3.0 双授权 —— **本项目选择 MIT** |

**C 类 —— 运行时下载的二进制（`vendor/manifests/backends.json`，逐条带 sha256）**

| 组件 | 许可证 | 备注 |
|---|---|---|
| **ffmpeg / ffprobe**（`media-tools-*`） | 🔴 **GPL-3.0-or-later** | Linux/Windows 用 BtbN 的 gpl 构建，macOS 用 jellyfin-ffmpeg |
| **yt-dlp**（`ytdlp-*`） | 🔴 **GPL-3.0-or-later** | 4 个平台，钉死 tag `2026.07.04` |
| whisper.cpp 二进制包（`whispercpp-*`） | MIT | |
| libsimple / sqlite-vec 二进制包 | MIT | |

**模型权重**

| 来源 | 许可证 |
|---|---|
| Whisper ggml 全部 25 条 | **MIT** |
| silero-vad | MIT |
| **sherpa 流式 zh-14M / Paraformer 中文 / 中英标点（ct-transformer）** | **Apache-2.0** |
| Qwen3 系列（本地 LLM，ADR-016 后已不再作为主路径） | Apache-2.0 |
| Gemma-3-4b | Gemma Terms of Use（**不是 OSI 许可证**） |

> ⚠️ **GPL 那两行是这份清单里唯一需要动脑子的地方。** 个人自用不触发 GPL 的分发义务
> （GPL 约束的是分发行为），所以 ADR-002 v2 允许直接内置。
> **一旦你要分发这个东西，这两条就是硬阻断。**

> ⚠️ 另外两条如实说明：① `license-report.md` 里 C 类那 7 行显示 `UNKNOWN`，
> 那是报告脚本按**清单文件**粒度统计的结果，不是说这些组件没有许可证 ——
> 真实的许可证在 `backends.json` 每个 pack 的 `license` 字段里，上表就是从那里读出来的
> `[本机实测]`。② 报告里的 B 类（npm 依赖）是空的，因为 `pnpm licenses list` 采集失败了，
> **不是"没有 npm 依赖"**。

---

## 仓库结构

```
apps/daemon      本地 daemon（HTTP + WS + 任务队列 + SQLite）
apps/web         React SPA（daemon 直接托管它的构建产物）
packages/        shared / db / downloader / llm / mindmap / pipeline / runtime
vendor/          4 个 git submodule + manifests/（组件与模型目录，逐条 sha256）
scripts/         构建原生产物、许可证报告、自检、CI 自测
docs/            章程 / ADR / 设计文档 / 安全说明 / 本文档的部署篇
coordination/    多 agent 协作产物（协议、任务卡、回执）
```

**仓库里没有二进制。** `[CI 实测]` 最大的已跟踪文件是 255 KB（JSON / PNG 截图 / Markdown）。

---

## 更多文档

| 文件 | 内容 |
|---|---|
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | **部署手册**：系统要求、端口绑定、数据目录、密钥、备份恢复卸载、故障排查 |
| [`docs/SECURITY.md`](docs/SECURITY.md) | 威胁模型、7 层子进程参数注入防护、**两个已知未修复的缺口** |
| [`docs/00-CHARTER.md`](docs/00-CHARTER.md) | 项目章程（F1–F5、平台矩阵、要求 2.1/2.2） |
| [`docs/design/D-11-ci-platform-facts.md`](docs/design/D-11-ci-platform-facts.md) | **逐平台真实能力的事实来源**，本 README 的平台表来自它 |
| [`docs/adr/`](docs/adr/) | 16 份架构决策记录 |
| [`HANDOFF.md`](HANDOFF.md) | 给下一个接手者：现在什么状态、下一步干什么、哪些坑别再踩 |
