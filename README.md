# OpenMemo

**本地部署的音视频笔记工具。** 粘链接 / 拖文件 / 浏览器里录音 → 抽音轨 → **在你自己的机器上**转成文字 →
交给你自己配置的在线大模型整理成思维导图与摘要 → 存进本机 SQLite,可全文检索(含中文分词)、与音频时间轴联动。

本地 daemon(Node/TS)+ 浏览器里的 React 单页,**不是 Electron**。装 GPU 加速后端、下载与切换模型,**全部在网页上点**。

## 装它

**没有安装包。** 没有 `.exe` / `.dmg` / `.AppImage`,也没有 npm 包 —— 唯一的方式是**克隆源码自己构建**。

⚠️ **Releases 页那些 `backend-packs-*` / `model-mirror-*` 不是给你下的。** 那是产品运行时自己去取的
后端二进制与模型;你在网页上点"安装",daemon 按钉死的 sha256 下载校验。手动下载没有用 ——
放哪、叫什么、要不要建硬链接全由安装器决定。

前置只有 **Node ≥ 22** 和 **pnpm 10.15.0**。ffmpeg / whisper / yt-dlp / CUDA **都不用预装**。

```bash
git clone https://github.com/faorcoek042/openmemo.git
cd openmemo
pnpm install
pnpm -r build                        # ★ 网页 bundle 只有这条会产出
node apps/daemon/dist/main.js        # 打开终端里打印的地址,默认 http://127.0.0.1:17650/
```

**进去之后先做两件事**,否则转写会 blocked:

1. **运行时**(`/runtime`)→ 装本机适用的组件(转写引擎、ffmpeg、yt-dlp、中文分词),装完点提示里的重启
2. **模型**(`/models`)→ 转写 Tab → 下一个语音识别模型
   ⚠️ **装完组件不等于能转写** —— 冷装之后一个模型都没有,自检会用 `model.asr fail` 告诉你

第一次要从网上取 **几百 MB 到 1 GB+**(依赖 + 组件 + 你选的模型:最小 ~30 MB,`large-v3-turbo` ~1.6 GB)。
全部在网页上点,可随时删掉重下。

### 东西都下到哪了

组件、模型、数据库、媒体文件**全在同一个数据目录**下,默认位置:

| 系统 | 默认数据目录 |
|---|---|
| Linux | `~/.local/share/openmemo/`(跟随 `XDG_DATA_HOME`) |
| macOS | `~/Library/Application Support/OpenMemo/` |
| Windows | `%APPDATA%\OpenMemo\` |

**这个位置可以改。** 网页上「设置 → 数据目录」能**查看、修改、整体搬走、统计各部分占多大**;
也可以启动时用 `--data-dir <路径>` 指定。**删掉整个数据目录不会弄坏程序本体** ——
下次启动会重建一个空的,组件和模型重新装即可。

⚠️ 记录"数据目录搬到哪了"的**指针文件**不在数据目录里(否则搬完就找不到了),
它固定在上表那个默认位置下的 `datadir.json`。**这一份是全机器共享的。**

## 能跑在哪

| 平台 | 状态 |
|---|---|
| **Linux x64**(glibc ≥ 2.34) | ✅ CPU;另有 Vulkan 包,**没在真 GPU 上验过** |
| **Windows x64**(需 VC++ 2015-2022 运行时) | ✅ CPU;CUDA 包**可能已经好了但验不了**(要真 N 卡) |
| **macOS arm64**(≥ 13.3,**部分功能要 ≥ 15.5**,见下) | ✅ CPU + Metal + ANE(ANE 仅 `large-v3-turbo`) |
| **AMD(ROCm)** · **macOS Intel** · **linux-arm64** | ❌ 不构建 |

判据是**「屏蔽宿主 PATH 的干净机器上真的转出非空文本」**,不是「代码写完了」。最近一轮
`cold-start-audit` run 31167151669 三平台各一次,5 个工具全由产品自己下载校验、**借宿主 PATH 的 0 个**。

⚠️ 有一族**装得上、跑不了、自检看不见**的下限(macOS < 13.3 · Linux glibc 过低 · Windows 缺 VC++):
下载成功、sha256 通过、安装记录 succeeded、自检全绿,**只有真正去执行时才死**。三条见
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) §1.2。

**macOS 的系统版本下限是分层的**(`[CI 实测]`,逐个二进制读 `LC_BUILD_VERSION`):

| 要用什么 | 最低 macOS | 来源 |
|---|---|---|
| 核心:转写、播放、笔记、**中文全文检索** | **11.0** | node · better-sqlite3 · libsimple 都是 11.0 |
| 向量检索(`vec0`)、流式 ASR / VAD(`sherpa-onnx`) | **14.0** | 上游预编译 |
| 同上的 ONNX 运行时 | **15.5** | 上游预编译 |

我们承诺 **13.3** 是因为 whisper.cpp 那个包;**13.3–14.x 上向量检索与流式 ASR 会静默失效**
——不报错,只是不工作。这几个数字来自上游的预编译产物,**不是我们能选的**。

## 你该知道的

- 🔴 **思维导图与摘要不是本地的** —— 要调你自己填的在线大模型 API(DeepSeek / OpenAI 兼容),
  转写稿的相关片段会发给那个服务商。不填 Key 时导入、转写、检索、播放、笔记编辑照常。
- **除此之外只有两件事出网**:你粘的那个链接,以及组件与模型的下载。**转写全程不出网。**
- 🔴 **鉴权默认关闭**,绑定地址默认 `127.0.0.1`。一旦设成 `0.0.0.0`,**任何能路由到这个 `IP:端口`
  的人都能读写你全部笔记** —— 先读 [`docs/SECURITY.md`](docs/SECURITY.md)。
  (非回环 + 明文 HTTP 下**录音会直接不可用**:浏览器只把 HTTPS 与 localhost 当安全上下文。)
- 🔴 **Windows 上 `0o600` 不生效**:你的 API Key(明文)与访问令牌对本机所有用户可读,**未修**。
- **不签名**:macOS 只做 ad-hoc,Windows 完全不签 —— 我们无法向你证明二进制没被篡改。
- **不做**:用浏览器 cookie 下载会员内容、TTS、移动端、协作、云账号、支付、
  **多工作区/项目分组**(用户 2026-08-08 裁定;笔记已有文件夹筛选与全文检索,再加一层分组边际收益低)。

## 许可证

`UNLICENSED`,无 LICENSE 文件 —— 个人自用项目(ADR-002)。
⚠️ ffmpeg 与 yt-dlp 是 **GPL-3.0-or-later**:自用不触发分发义务,**一旦要分发就是硬阻断**。
逐条清单见 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) 附录 A 或 `pnpm license:report`。

## 更多文档

| | |
|---|---|
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | **部署手册**:系统要求、端口绑定、数据目录、密钥、自检怎么读、备份恢复卸载、故障排查 |
| [`docs/SECURITY.md`](docs/SECURITY.md) | 威胁模型、子进程参数注入防护、**两个已知未修复的缺口** |
| [`docs/00-CHARTER.md`](docs/00-CHARTER.md) | 项目章程(F1–F5、平台矩阵、要求 2.1/2.2) |
| [`docs/design/D-11-ci-platform-facts.md`](docs/design/D-11-ci-platform-facts.md) | 上面那张平台表的事实来源 |
| [`docs/adr/`](docs/adr/) · [`HANDOFF.md`](HANDOFF.md) | 16 份架构决策记录 · 给下一个接手者 |
