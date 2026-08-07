# OpenMemo

**本地部署的音视频笔记工具。** 粘一个链接、拖一个文件、或在浏览器里录音 → 自动抽音轨 → **在你自己的机器上**转成文字 →
交给你自己配置的在线大模型整理成思维导图与摘要 → 存进本机 SQLite，可全文检索（含中文分词）、与音频时间轴联动。
**本地 daemon（Node/TS）+ 浏览器里的 React 单页，不是 Electron**；装 GPU 加速后端、下载与切换模型，**全部在网页上点**。

## 能跑在哪

| 平台 | 今天的真实状态 |
|---|---|
| **Linux x64**（glibc ≥ 2.34） | ✅ 通，CPU；目录里另有 Vulkan 包，**没在真 GPU 上验过** |
| **Windows x64**（需 VC++ 2015-2022 运行时） | ✅ 通，CPU；CUDA 包见下面「已知不支持」 |
| **macOS arm64**（≥ 13.3） | ✅ 通，CPU + Metal + ANE（ANE 仅 `large-v3-turbo`，见下） |
| 其余组合（AMD · macOS Intel · linux-arm64） | ❌ 见下面「已知不支持」 |

判据是**「屏蔽宿主 PATH 的干净机器上真的转出非空文本」**，不是「代码写完了」：CI `cold-start-audit` run
31160171438 三平台各一次，5 个工具全由产品自己下载校验、借宿主 PATH 的 **0** 个；同一轮里
Linux 与 Windows 的硬件探针首次报出 `ok`（各枚举到 1 个设备）。逐条证据与三条运行时下限见
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) §1。

## 快速开始

### 先说清楚要下什么

**这个项目没有安装包。** 装它的唯一方式是**克隆源码然后自己构建**——没有 `.exe`、没有 `.dmg`、
没有 `.AppImage`，也没有 npm 包。个人自用项目，不做分发（ADR-002）。

⚠️ **GitHub 的 Releases 页那几个 `backend-packs-*` / `model-mirror-*` 不是给你下的。**
它们是**产品自己在运行时去取**的后端二进制与模型镜像——你在网页上点"安装"，daemon 按目录里
钉死的 sha256 下载并校验。手动下载它们没有用：解压出来放哪、叫什么名字、要不要建硬链接，
全部由安装器决定，不是拖到某个目录就能生效的。

所以你要做的只有一件事：**把整个仓库 clone 下来**。

前置：Node ≥ 22（`.nvmrc` = 22）· pnpm 10.15.0。**不需要**预装 ffmpeg / whisper / yt-dlp / CUDA
（产品自己下载），也**不需要** `git submodule`（只在自己编译原生产物时才用得上）。

```bash
git clone https://github.com/faorcoek042/openmemo.git
cd openmemo
pnpm install
pnpm -r build                        # ★ 网页 bundle 只有这条会产出，见下
node apps/daemon/dist/main.js        # 打开终端里打印的地址，默认 http://127.0.0.1:17650/
```

**下载量的实话**：仓库本身很小，但第一次用完整功能要从网上取 **几百 MB 到 1 GB+** ——
`pnpm install` 的依赖、ffmpeg 与 yt-dlp（各几十 MB）、转写引擎（几 MB）、
以及**你选的语音识别模型**（最小 ~30 MB，`large-v3-turbo` 约 1.6 GB）。
这些**都在网页上点，不用碰命令行**，也都可以随时删掉重下。

**第一次进去先做两件事**，否则转写会转成 blocked：

1. 左侧「**运行时**」（`/runtime`）→ 装本机适用的组件（转写引擎、ffmpeg、yt-dlp、中文分词）。
   装完页面会提示重启，点它即可（daemon 自己重启，不用回终端）。
2. 左侧「**模型**」（`/models`）→ 转写 Tab → 下载一个语音识别模型。
   ⚠️ **装完组件不等于能转写** —— 冷装之后一个 ASR 模型都没有，自检会用 `model.asr fail` 告诉你。

三条会咬人的细节：

- **网页 bundle 只有 `pnpm -r build` 会产出**（根 `build` 与它等价）。`pnpm typecheck` 与
  `pnpm build:safe` **都不会** —— 只跑那两条的话，daemon 起来之后 `GET /` 是空的。
  （`HANDOFF.md` 里「根 `build` 只走 `tsc -b`」那句已过期，以 `package.json` 为准。）
- **`/components`（组件来源链与许可证）与 `/diagnostics`（全部自检）不在侧栏**，
  分别从 `/runtime` 页和就绪横幅进去。
- **端口默认 17650**，被占用时在 `17650..17659` 里顺延并明确告诉你漂移了（端口一变，浏览器的
  麦克风授权要重新点一遍）。命令行**只有** `--port` 与 `--data-dir`：没有 `--host`
  （绑定地址走 `OPENMEMO_HOST`），也没有 `OPENMEMO_PORT`。

## 已知不支持

**决定要不要试之前，先看这一节。**

| 组合 | 状况 |
|---|---|
| **Linux + AMD（ROCm）** | 🔴 **没有任何产物**：唯一的构建腿已被裁掉，上游 whisper.cpp 也没有 ROCm 版本。章程 §3 那一行在产物层面是空的 |
| **Linux + NVIDIA（CUDA）· Windows + AMD** | 🔴 **目录里没有这些包**：能编出来，但纯增量的加速包在本产品里结构上不可用，**不接进目录** |
| **Windows + NVIDIA（CUDA）** | ⚠️ **包在目录里，可能已经好了，但验不了**：探针分发通道已打通（CI 实测 Windows 报 `ok`），挡路的那条已不存在 —— 但要确认它真的能用**需要一块真 NVIDIA 卡**，任何托管 runner 都验不到 |
| **macOS Intel · linux-arm64** | ✂ 用户 2026-08-05 明确裁掉，不构建 |
| **Apple 神经引擎（ANE / CoreML）** | ✅ **已修**（run 31167151669 实测 `asr.coreml = ok`）：此前 encoder 解包后多套一层同名目录 → whisper.cpp 找不到 `coremldata.bin` → 静默回退到 Metal/CPU，且**界面上没有任何提示**。tiny/base/small/medium 的 encoder **仍然没挂**（没有它们的 sha256），只有 `large-v3-turbo` 能走 ANE |

还有一族**装得上、跑不了、自检看不见**的下限（macOS < 13.3、Linux glibc、Windows 缺 VC++ 运行时）：
下载成功、sha256 通过、安装记录 succeeded、自检全绿，**只有真正去执行时才死**。三条逐个写在
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) §1.2。

## 有一半不是本地的，以及别的诚实条目

- 🔴 **思维导图与摘要要调你自己填的在线大模型 API**（DeepSeek / OpenAI 兼容接口 / …），
  转写稿的相关片段会发到那个服务商 —— 这是用户的明确决定（ADR-016）。不填 Key 时导入、转写、
  检索、播放、笔记编辑照常，只有思维导图/摘要不可用。
- **除此之外只有两件事出网**：你自己粘的那个链接（yt-dlp 去下载它），以及组件与模型的下载（GitHub /
  HuggingFace / ModelScope，每个文件都有钉死的 sha256，下完必校验）。**转写全程不出网** ——
  ffmpeg / whisper.cpp / VAD 都是本机子进程。
- **鉴权默认关闭**（`OPENMEMO_AUTH` 默认 `none`，用户显式决定）。绑定地址默认 `127.0.0.1`，一旦设成
  `0.0.0.0`，任何能路由到该 `IP:端口` 的人都能读写你全部的笔记 —— 部署前请读
  [`docs/SECURITY.md`](docs/SECURITY.md) 的「当前真实姿态」。**非回环地址 + 明文 HTTP 下录音
  还会直接不可用**：浏览器只把 HTTPS 与 localhost 当安全上下文。
- **代码签名：不买证书**（macOS 只做 ad-hoc，Windows 完全不签）——
  我们无法向你证明二进制没被篡改，只能靠 HTTPS + sha256 清单。
- **`0o600` 在 Windows 上不生效**：`secrets.json`（你的 API Key，明文）与 `runtime.json`
  （访问令牌）对本机所有用户可读，**未修**。
- **不做的**：用浏览器 cookie 下载会员内容（安全设计使然，不是工作量问题）、TTS、移动端 App、
  团队协作、云端账号、支付。

## 许可证

本仓库 `package.json` 写的是 **`UNLICENSED`**，也没有 LICENSE 文件 —— 个人自用项目（ADR-002 v2）。
上游组件的逐条清单见 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) 附录 A，或跑 `pnpm license:report`。
⚠️ ffmpeg 与 yt-dlp 是 **GPL-3.0-or-later**：个人自用不触发分发义务，**一旦要分发就是硬阻断**
（那之前先读 ADR-002 的「升级路径」）。

## 更多文档

| 文件 | 内容 |
|---|---|
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | **部署手册**：系统要求与运行时下限、端口绑定、数据目录、密钥、自检怎么读、备份恢复卸载、故障排查、许可证清单 |
| [`docs/SECURITY.md`](docs/SECURITY.md) | 威胁模型、子进程参数注入防护、**两个已知未修复的缺口** |
| [`docs/00-CHARTER.md`](docs/00-CHARTER.md) | 项目章程（F1–F5、平台矩阵、要求 2.1/2.2） |
| [`docs/design/D-11-ci-platform-facts.md`](docs/design/D-11-ci-platform-facts.md) | **逐平台真实能力的事实来源**，上面那张平台表来自它 |
| [`docs/adr/`](docs/adr/) · [`HANDOFF.md`](HANDOFF.md) | 16 份架构决策记录 · 给下一个接手者：现在什么状态、下一步干什么、哪些坑别再踩 |
