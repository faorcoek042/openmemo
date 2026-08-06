# OpenMemo 部署手册

> 面向**要真正把它跑起来并长期用下去**的人。想先知道这是什么，看 [`../README.md`](../README.md)。
>
> **证据标记**（与 README 同一套）：`[CI 实测 run N]` · `[本机实测]`（一台 Linux x64 开发机，
> 2026-08-06 现跑）· `[读码 文件:行]` · `[未验证]`。**没核实过的不写。**
>
> ⚠️ 本文档里出现最多的一个词是「**它坏的时候什么都不说**」。
> 本项目最贵的几类故障全是这个形状：装得上、校验过、自检绿，只有真正去用时才死。
> 下面凡是标 🔴 的段落，都属于这一族。

---

## §1 系统要求

### 1.1 跑 daemon 本身

| 项 | 要求 | 出处 |
|---|---|---|
| Node.js | **≥ 22**（`.nvmrc` = 22；开发机上跑的是 24.18.0） | `[本机实测]` `package.json` `engines` |
| pnpm | **10.15.0**（`packageManager` 字段已钉死） | `[本机实测]` |
| 磁盘 | 装完组件 + 一个 tiny 模型约 **47 MB**；换成 large-v3 量化档要几个 GB | `[本机实测]` `GET /api/models/storage` → `usedBytes: 46,931,219` |
| 内存 | 未做过下限测量，**`[未验证]`**。自检会报本机内存，但没有任何一处会因为内存不足而拒绝 | — |
| 网络 | 首次要能访问 `github.com`；模型走 `huggingface.co`，够不到时**会自动换 `modelscope.cn` 镜像** | `[本机实测]` 这台机器直连 HF 不通，模型是从 ModelScope 下下来的 |

`git submodule` **不需要初始化** —— submodule 只在自己编译原生产物时用得上，
跑产品用的是下载来的预编译包。`[CI 实测 run 31076010999]` 冷启动流程里没有 `submodules:init` 这一步。

### 1.2 🔴 运行时下限：三条「装得上、跑不了、自检看不见」

这三条**不是靠读代码发现的，是把产物解开读它的元数据发现的**
（`docs/design/D-11-ci-platform-facts.md` §8）。共同形状：

> 构建机总是那个最新、装得最全的环境，而用户的机器不是。
> 凡是「不显式指定就取构建机当前值」的东西，都会把构建机的新度焊进产物，
> 而后果一律在用户机器上才显形，且**一律不报错**。

#### ① macOS：必须 **≥ 13.3**

`[CI 实测，解包读 `LC_BUILD_VERSION`]` 修复前 12 个二进制全部 `minos = 26.0.0`
（= runner 的系统版本，也就是**只能在最新版 macOS 上跑**）；修复后全部 `minos = 13.3.0`。

- 13.3 不是拍脑袋定的：上游 `vendor/whisper.cpp/build-xcframework.sh:5` 写着
  `MACOS_MIN_OS_VERSION=13.3`，同一份代码、上游测过的下限。
- 清单里已声明：`whispercpp-cpu-macos-arm64` 的 `requiresDriver.macosVersion = "13.3"`
  `[本机实测 vendor/manifests/backends.json]`。ffmpeg 那个包声明的是 `12.0`。
- **低于 13.3 的症状**：下载成功 → sha256 通过 → 安装 `succeeded` → **一执行就被 dyld 拒绝**。

#### ② Linux：glibc

`[CI 实测，`objdump -T` 逐个 ELF 取最高 `GLIBC_x.y`]`：

| 包 | 构建机 | 最高 GLIBC 需求 | 判定 |
|---|---|---|---|
| **`whispercpp-cpu-linux-x64`（目录里唯一的 Linux 引擎）** | ubuntu-22.04 | **2.34** | ✅ Ubuntu 22.04 / Debian 12 都能跑 |
| `whispercpp-vulkan-linux-x64` | ubuntu-24.04 | **2.38** | 🔴 Ubuntu 22.04(2.35) / Debian 12(2.36) 上加载失败 |

发行版对照：`Ubuntu 22.04 = 2.35` · `Debian 12 = 2.36` · `Ubuntu 24.04 = 2.39` · `Debian 13 = 2.41`。

**今天这条不伤用户**：那个 vulkan 包**不在** `backends.json` 里（另有原因，D-11 §8.4），
所以你装不到它。写在这里是给**日后想把它接进目录的人**看的 —— 接之前必须先满足二选一：
把构建腿挪回 ubuntu-22.04（但 jammy 没有 `glslc`，得另找 Vulkan SDK 装法），
或者加一条运行期检测（比对本机 glibc / 装完真 `dlopen` 一次并报进自检）。

> 顺带记一条更隐蔽的：`GGML_BACKEND_DL=ON` 下 `dlopen` 失败**不算错误**，只是"这个后端没注册上"。
> whisper 会照常用 CPU 跑完，**用户只会觉得"装了加速包但没变快"**，
> 安装记录是成功的、sha256 是对的、自检里也没有对应检查项。

#### ③ Windows：VC++ 2015-2022 可再发行组件

`[CI 实测，PE 导入表]` 我们自建的原生产物（如 `ggml-vulkan.dll`）导入
`MSVCP140.dll` / `VCRUNTIME140.dll` / `VCRUNTIME140_1.dll`；
上游 libsimple 的 `simple.dll` 同样如此。

- GitHub 的 Windows runner 一定装了这套运行时，**普通用户的干净 Windows 不一定**。
- **`node.exe` 自己是静态链接 CRT 的**，所以"daemon 能跑起来"完全不代表"这些 DLL 能加载"。
- **产品没有任何地方检查它在不在。**
- 缺失时的症状：`tokenizer=trigram`、中文双字词搜不到、**零报错**
  （`failures.libsimple` 会是加载错误而不是"文件不存在"）。
- 判定级别：`[未验证：需一台干净的 Windows]` —— 按 D-11 §3.4 的判据
  「runner 上"能做到"不等于用户机器上"能做到"，只有 runner 上"做不到"才是硬结论」。

**处置**：装一次微软官方的 [Visual C++ Redistributable (x64)](https://aka.ms/vs/17/release/vc_redist.x64.exe)。
成本几十秒，能一次排掉这一整类问题。

### 1.3 平台矩阵（能装什么）

`[CI 实测 run 31076010999]`，判据是「屏蔽宿主 PATH 的干净机器上真的转出非空文本」：

| 平台 | 适用包 | 后端 | 结论 |
|---|---|---|---|
| Linux x64 | 5 / 22 | 只有 CPU | ✅ 通 |
| Windows x64 | 5 / 22 | 只有 CPU（CUDA 包见下） | ✅ 通 |
| macOS arm64 | 5 / 22 | CPU + Metal + CoreML **同在核心包里** | ✅ 通 |
| linux-arm64 / macOS Intel / Linux ROCm | — | — | ✂ 用户 2026-08-05 明确裁掉，无产物 |

🔴 **Windows + NVIDIA CUDA 今天装不上。** 包（`whispercpp-cuda-12.4-win-x64`）在目录里，
但它是 L2、需要硬件探针门控，而 **`openmemo-probe` 至今没有分发通道**
（CI 会构建它，没有任何 manifest 提供下载地址）。
`[本机实测]` `GET /api/runtime/hardware` 里 cuda/vulkan/rocm/metal 四条全是
`probe did not complete: probe executable not found`；
`[CI 实测]` Windows runner 上"适用于本机"的包正好 5 个，不含 CUDA。

---

## §2 端口与绑定

### 2.1 端口

- 默认 **17650**；被占用时在 `17650..17659` 里顺延 `[读码 bootstrap/single-instance.ts:18-19]`。
- 用 `--port <n>` 指定。**`OPENMEMO_PORT` 这个环境变量不存在。**
- 端口漂移会**显式告诉你**，因为浏览器的 localStorage / cookie / **麦克风授权**
  全部按 origin（scheme+host+port）隔离 —— 端口一变，F3 录音的授权要重新点一遍。
  所以**长期部署请显式钉死 `--port`**，别依赖默认顺延。
- 单实例互斥靠的就是端口绑定本身（唯一"原子 + 进程死了自动释放"的机制），
  不是 lockfile。`runtime/runtime.json` 只是元数据 sidecar。

### 2.2 绑定地址

| 变量 | 默认 | 说明 |
|---|---|---|
| `OPENMEMO_HOST` | **`127.0.0.1`** | 只认显式设置。设成 `0.0.0.0` 才对外可达 |

🔴 **两条必须一起知道的后果：**

**① 非回环 + 明文 HTTP ⇒ 录音功能（F3）直接不可用。**
浏览器只把 HTTPS 与 localhost 当作安全上下文，`http://<IP>` 下
`navigator.mediaDevices` 与 `navigator.locks` **都是 undefined**——
**任何浏览器都一样，不是浏览器旧**。界面上只会说一句"当前浏览器不支持"。
daemon 启动时会就这一条单独警告 `[读码 apps/daemon/src/main.ts:911-916]`：

```
[daemon] ⚠️  此地址下录音功能不可用（浏览器仅将 HTTPS 与 localhost 视为安全上下文，与浏览器版本无关）。
```

**② 鉴权默认关闭。** `OPENMEMO_AUTH` 默认 `none`，只有精确等于 `token` 才开启。
在 `0.0.0.0` + 无鉴权的组合下：**任何能路由到该 `IP:端口` 的人都能读取、修改、删除你的
全部笔记、转写稿与音频**，并可覆盖/删除 `secrets.json`。
这是用户 2026-08 的显式决定（原话「反正也是本地运行的东西」），**不是疏忽**，
但 `docs/SECURITY.md` 已如实指出：在 NAT 后经端口映射可达时，那个前提并不成立。

### 2.3 NAT 场景（机器在 NAT 后、只有特定端口能从外部访问）

```bash
OPENMEMO_HOST=0.0.0.0 OPENMEMO_TLS=self-signed \
OPENMEMO_TLS_HOSTS=<你从外部访问用的 IP 或域名> \
node apps/daemon/dist/main.js --port 17650
```

- `OPENMEMO_TLS=self-signed`（也接受 `1` / `true`）会生成自签证书到
  `<数据目录>/runtime/tls-cert.pem` + `tls-key.pem`（0600），有效期 825 天，
  剩余不足 7 天会自动重签（过期证书浏览器**硬拒**，比没有证书更糟）。
- **需要机器上有 `openssl`。** 生成失败会**当场抛错，不会静默降级成明文** ——
  用户显式要了 TLS，悄悄给他明文等于让他以为录音能用而实际不能
  `[读码 bootstrap/tls.ts:124-131]`。
- 证书 SAN 自动包含 `localhost` / `127.0.0.1` / `::1` / 本机所有非回环网卡地址。
  **NAT 外部那个 IP 不在本机网卡上，我们猜不到** → 用 `OPENMEMO_TLS_HOSTS` 显式加进去，
  不加也能用，只是浏览器会多报一次"名称不匹配"。
- 浏览器会拦一次自签证书：点「高级 → 继续前往（不安全）」。**这是正常的，不是出错了。**

**更推荐的组合**：`OPENMEMO_HOST=127.0.0.1` + SSH 端口转发。
那样"本地运行"是真的，关掉鉴权也没有暴露面，而且 `localhost` 天然是安全上下文，录音直接能用。

### 2.4 恢复鉴权

```bash
OPENMEMO_AUTH=token         # 恢复 token 鉴权
OPENMEMO_HOST=127.0.0.1     # 恢复只绑回环
```

⚠️ `OPENMEMO_AUTH=token` 恢复的是「token 鉴权 + **打了折的** CSRF」，不是原始形态：
CSRF 有一层同源兜底（`Sec-Fetch-Site` 缺失也算通过），
**任何能自设 `Origin` 与 `Host` 头的非浏览器客户端仍可绕过 CSRF 这一层**，只剩 token 作为防线。
细节与裁决理由见 `docs/SECURITY.md`「CSRF 同源兜底」。

---

## §3 数据目录

用户对这一块提过四个明确要求：**定义、修改、移动、统计大小**（ADR-016 决策 4）。
四个都在网页上（`/settings`「数据位置」区块），下面写的是它们背后的事实。

### 3.1 定义：在哪

**默认位置**（`[读码 apps/daemon/src/config/paths.ts:26-36]`）：

| 系统 | 路径 |
|---|---|
| Linux | `$XDG_DATA_HOME/openmemo`，缺省 `~/.local/share/openmemo` |
| macOS | `~/Library/Application Support/OpenMemo` |
| Windows | `%APPDATA%\OpenMemo`（缺省 `~\AppData\Roaming\OpenMemo`） |

**优先级**（`[读码 paths.ts:93-96]`，从高到低）：

```
OPENMEMO_DATA_DIR  >  --data-dir  >  指针文件  >  OS 默认
```

`--data-dir` 与指针文件冲突时 daemon **会出声**，不会安静地挑一个
`[本机实测]`：

```
[daemon] ℹ️  指针文件指向 /tmp/…/data2，但命令行 --data-dir 指定了 /tmp/…/data3，本次使用 /tmp/…/data3。
[daemon]    若你想用迁移后的位置，去掉 --data-dir 即可（不传时会自动读指针）。
```

**里面有什么**（`GET /api/settings/data-dir` 的 `entries`，网页上逐条显示，`[本机实测]`）：

| 子目录 | 装什么 | 能删吗 |
|---|---|---|
| `openmemo.db` | 笔记、转写稿、标签、导图（SQLite 主库，WAL 模式） | ❌ 删了就没了 |
| `media/` | 导入与录制的音视频原件 | ❌ 删了笔记的音频就没了 |
| `models/` | 下载的模型与后端包 | ⚠️ 可删，**可重新下载** |
| `logs/` | 运行日志 | ✅ 随时可删 |
| `tmp/` | 转写过程的临时文件 | ✅ 随时可删，**不含已入库资产** |
| `backups/` | 数据库备份（**只有 schema 升级前的自动备份**，见 §7） | ⚠️ 删了就失去回滚点 |
| `runtime/` | 运行时状态与访问令牌（含 TLS 私钥） | ✅ 可删，重启重建 |
| `secrets.json` | 🔴 **你的第三方 API Key，明文** | 见 §4 |
| `bin/ext/` | libsimple / sqlite-vec 扩展的汇聚目录（**软链**到 `models/` 下的真实文件） | ⚠️ 见 §3.4 |

### 3.2 🔴 数据目录**外面**还有一个文件：指针

```
<OS 默认数据目录>/datadir.json        # 例：~/.local/share/openmemo/datadir.json
```

它记录"数据目录搬到哪了"。**它必须在数据目录外面** —— 放进去就会跟着一起搬走，
搬完就再也找不到新位置了（鸡生蛋）。

⚠️ **它是全机器共享的一份，而且它坏掉的方式非常难认**：
如果它指向一个已被删除的目录，daemon 下次启动（含自我重启）会**按它去那个不存在的位置建空目录**,
表现就是「笔记全没了」—— 而数据一个字节都没丢。
这在本项目里真实发生过一次：用户的 API Key、模型、转写记录在界面上全部"消失"，
自检从 `ok:20 fail:0` 掉到 `ok:7 fail:5`，实际数据完好无损。

- 产品自己会告诉你这件事：`GET /api/settings/data-dir` 的 `externalFiles` 里就有它，
  带 `whyOutsideZh` 与 `riskZh` `[本机实测]`。
- 可用 `OPENMEMO_POINTER_FILE` 覆盖位置（一台机器上跑多个隔离实例时用得上）。
- **删除数据目录时，请把这个指针文件一起删。**

### 3.3 修改与移动

网页：`/settings` →「数据位置」→「更改位置」，填新路径，勾选「一并移动已有数据」。
底层是 `POST /api/settings/data-dir`。

`[本机实测]` 真跑了一次（源目录里已装好 4 个包 + 1 个模型）：

```
POST /api/settings/data-dir  {"path":"/tmp/…/data2","moveExisting":true}
→ {"ok":true,"moved":true,"strategy":"rename","bytes":133486005,
   "files":66,"links":11,"staleLinks":[],"restartRequired":true}
```

**两条策略**（`[读码 storage/move.ts:433-532]`）：

- **同一文件系统 → `rename`**（内核级原子，快）；
- **跨文件系统 → `EXDEV` → 退化成 复制 → 校验 → 删源**。
  校验比的是「相对路径集合 + 普通文件字节数 + **符号链接的目标**」，比不上就不删源。

**搬家时有任务在跑会被拒绝** —— 搬到一半任务还在写文件，必然不一致。

### 3.4 ⚠️ 搬完之后要看什么（这一条是用一次真实事故换来的）

**曾经的故障**：用户把数据目录搬到新位置后，whisper 后端**完全无法加载**。
根因是两处，一处比一处安静：

1. `fs.cp` **默认会把相对符号链接改写成指向【源目录】的绝对路径**，
   而紧接着源目录就被删了 → 8 条 `.so` 链接当场全部悬空。
   修法是 `verbatimSymlinks: true`（`move.ts:474`，**不要删这个选项**）。
2. 当时的校验函数 `measureTree()` / `verifyTreesMatch()` **显式跳过符号链接** ——
   于是它们一边报告"两棵树一致"，一边对唯一坏掉的东西闭着眼。
   现在这个文件的规则是：**跳过 = 撒谎。** 符号链接要么被校验，要么就别声称两棵树一致。

**已修。但搬完请自己看两个地方**（都不需要命令行）：

| 看哪 | 期望 | `[本机实测]` 搬完后的真实值 |
|---|---|---|
| 搬家接口返回的 `staleLinks` | **空数组** | `[]` |
| `/diagnostics` 页的 `backend.libLinks` | **ok** | `ok — 8 条链接全部可读到目标内容` |

顺带一提，`backend.libLinks` 这一项**不能用 `lstat()` 实现**（它不跟随链接，对彻底悬空的链接
照样返回成功），产品用的是 `open()` + 读 4 字节：悬空 → ENOENT，指向空文件 → 读不满
`[读码 packages/runtime/src/selfcheck.ts:374-405]`。

搬完还要看第三个地方：`datadir.assetsContained` / `datadir.assetsPresent` 两项应为 `ok`，
它们回答的是"媒体资产还在不在、还读不读得到"。
（`media_assets` 表里的路径引用会在搬家后自动迁移；`storage/migrateAssets.ts` 的判据是
**按播放端那套规则能不能真的读到内容**，而不是路径长得像相对还是绝对 ——
「相对但指错」比绝对路径失效更隐蔽。）

### 3.5 统计大小

- 网页 `/settings`「数据位置」：**总占用 + 逐子目录分解 + 卷剩余/总量**。
  只给总数是不够的：用户知道"占了 3 GB"却不知道该删哪个。
- 网页 `/models`：按模型/后端包逐条列体积，可单独删除，另有一键 GC。
- 接口：`GET /api/settings/data-dir`（含 `usage.bytes` / `files` / `links`）、
  `GET /api/models/storage`（含 `breakdown[]`）。

---

## §4 密钥存放在哪（明文，而且我们必须这么告诉你）

```
<数据目录>/secrets.json      文件权限 0600、目录 0700
```

**产品自己会把这句话渲染在设置页上**，原文由服务端下发、前端不许改写成"安全存储"之类的含糊说法
（`[读码 packages/llm/src/secrets.ts:56-73]`，`GET /api/secrets` 的 `disclosure` 字段）：

> API Key 以**明文**保存在 `<路径>`（文件权限 0600、目录 0700）。
> 本机上有权限读取该文件的程序都能看到它。若不接受，请改用本地模型（无需 API Key）。

`[本机实测]` `GET /api/secrets` 确实返回了这段原文，且 `secrets` 数组里只有掩码值 ——
**接口层永不回显明文**（`SecretStore` 的接口**刻意不含 `get()`**）。

**为什么是明文**：ADR-006 决策 1 —— `keytar` 已归档，我们是 web-first 无 Electron 架构，
接 OS keychain 跨平台成本高且不合拍，v1 用明文文件 + **强制显式告知**。
schema 里保留了 `enc` 字段，日后可无损升级到 keychain / aes-gcm。

🔴 **Windows 上 `0o600` 不生效**：`[CI 实测]` 写 `0o600` 读回来是 `666`。
即 `secrets.json` 与 `runtime/runtime.json`（内含访问令牌）
**对本机所有用户可读**。需要 ACL 而不是 POSIX 位，**未修**。

---

## §5 组件与模型装在哪（全在网页上）

| 要做的事 | 去哪一页 | 落到磁盘哪 |
|---|---|---|
| 装转写引擎 / ffmpeg / yt-dlp / 中文分词扩展 | **`/runtime`**（侧栏「运行时」） | `<数据目录>/models/by-name/backend/<归档名>/` |
| 看某个组件的来源链与许可证、单独更新/回滚 | **`/components`**（从 `/runtime` 页进去，不在侧栏） | 同上 |
| 下载/切换/删除转写模型、选量化档 | **`/models`** → 转写 Tab | `<数据目录>/models/by-name/asr/` |
| 装 VAD（切分）与标点模型 | **`/models`** → 转写 Tab →「实时字幕组件」一组 | 同上 |
| 填在线大模型 API Key、选模型 | **`/models`** → 语言模型 Tab（`/settings` 上只有一个指路牌，不重复一份） | `<数据目录>/secrets.json` |
| 代理（中文网络下下不动模型时的前置条件） | **`/settings`** →「代理」 | 库里 |
| 看全部自检 | **`/diagnostics`** | — |

SQLite 扩展是个例外：它们被**汇聚**（软链/Windows 上拷贝）到 `<数据目录>/bin/ext/`，
因为两个扩展来源不同、目录结构也不同，而 SQLite 只认一个加载目录。
这一步**只在启动时做**，所以装完扩展必须重启才生效 —— 网页会提示，点一下 daemon 自己重启。

`[本机实测]` 整条链走通（只发 HTTP，没碰命令行）：

```
POST /api/backends/install {"id":"sqlite-vec-linux-x64"}      → 202 · job succeeded
POST /api/backends/install {"id":"libsimple-linux-x64"}       → 202 · job succeeded
   GET /api/health → restartRequired.required = true「中文分词器已安装，需重启生效」
POST /api/daemon/restart                                       → 202
   GET /api/health → tokenizer 从 "trigram" 变 "simple"，libsimple/sqliteVec 双 true
POST /api/backends/install {"id":"whispercpp-cpu-linux-x64"}  → 202 · job succeeded
POST /api/models/pull      {"id":"asr/whisper-tiny-q5_1"}     → 202 · job succeeded（ModelScope 镜像）
```

⚠️ **装完组件 ≠ 能转写。** 冷装之后目录里一个 ASR 模型都没有，
这是产品事实（D-11 §7.3），不是 bug。自检会用 `model.asr fail` 明确说出来，
并给出可点的去处。

---

## §6 自检怎么读

**入口**：网页 `/diagnostics`（页首就是「功能自检」区块），或 `GET /api/selfcheck`，
或命令行 `pnpm check:selfcheck`。三者给的是同一份答案 —— CI 里有一条
`meta.sameSource` 专门断言"没有网页绿而 CLI 红"。

`[本机实测]` 当前返回 **25 条**，`/diagnostics` 把它们**全部**渲染出来
（按 `layer` 分组，分组顺序取数据里的首次出现顺序，**不写死 layer 白名单** ——
写死会让"daemon 新增一层"变成"界面上悄悄少一层"）。

### 三档的含义

| 档 | 含义 |
|---|---|
| **ok** | 装在数据目录里、且真的能用 |
| **warn** | 功能可用但降级，**或者：它是从系统 PATH 借来的** ← 见下 |
| **fail** | 不可用。带 `required` 的 fail 会挡住相关功能 |

🔴 **`warn` 这一档里藏着本项目最贵的那类问题，值得单独说。**
`tool.ffmpeg` 报 `warn ...（来自系统 PATH，非本产品安装 —— 用户机器上不一定有）` 时，
意思是：**产品悄悄用上了你机器上已有的那个 ffmpeg**。
今天它能用，你换一台没装 ffmpeg 的机器，同一个版本就突然不能用了 ——
**而没有任何东西变过**。所以 CI 的冷启动审计**必须屏蔽宿主 PATH** 才看得见这条。

`[本机实测]` 这台开发机上 `tool.ffmpeg` / `tool.ffprobe` 正好是这个 `warn`
（`/usr/bin/ffmpeg`，机器上本来就有）；`[CI 实测 run 31076010999]` 三个平台的
「借宿主 PATH 的」都是 **0**。

### 冷启动 → 装完的典型轨迹（`[本机实测]`）

```
全新数据目录            counts {ok:7,  warn:13, fail:5}
装 4 个组件 + 1 个模型   counts {ok:18, warn:7,  fail:0}
```

冷启动时那 5 条 fail 是：`tool.whisperCli`、`model.asr`、`ext.chineseSearch`、
`engine.select.zh`、`engine.select.en` —— 全部是"还没装东西"，不是坏了。

### 装完之后仍然会剩的 warn（都正常）

| warn | 意味着 |
|---|---|
| `hw.probe 未安装` | GPU 能力未知 → L2 加速包一律不适用（见 §1.3） |
| `model.vad 未安装` | 切分降级为固定窗口。**能转写，只是质量下降** |
| `llm.tier1 未配置` | 没填 API Key → 思维导图/摘要会转 blocked |
| `llm.tier2 未探测到 Ollama / LM Studio` | 正常，你没装本地推理服务 |
| `asr.coreml 未启用 ANE`（**仅 Apple Silicon**） | 转写会走 Metal/CPU，**功能正常，只是慢**。这条 warn 正是它该起的作用：慢是有名有姓的，不是"macOS 就是慢" |
| `datadir.assetsPresent：N 条文件已不存在` | ⚠️ **别把这条当噪声关掉** —— 它查出过真问题 |

---

## §7 备份、恢复、卸载

### 7.1 备份

**没有一键备份按钮，如实说。** `backups/` 目录里只有**数据库 schema 升级前的自动备份**
（`openmemo-v<旧版本>-<时间戳>.db`，`[读码 packages/db/src/migrate.ts:96-99]`），
它是回滚点，不是你的日常备份。

**日常备份 = 复制数据目录。** 但有一条不能省：

> 🔴 **先把 daemon 停掉，再复制。**
> 主库是 **WAL 模式**（`[本机实测]` `health.db.journalMode = "wal"`），
> 运行中直接 `cp openmemo.db` 会拿到一个**缺了 WAL 里最新事务**的库。
> daemon 正常退出时会做 `wal_checkpoint(TRUNCATE)`（`[读码 main.ts:944-948]`），
> 停完再复制就是干净的。

```bash
# 1) 停（SIGTERM 会走优雅退出：POSIX 宽限 15s，Windows 4s）
kill -TERM <pid>          # 或网页上退出，或 POST /api/daemon/shutdown
# 2) 复制整个数据目录
cp -a ~/.local/share/openmemo /backup/openmemo-$(date +%F)
# 3) 想省空间可以跳过 models/（几个 GB，都能重新下载）
```

**验证备份是否可用**：把备份目录当数据目录起一次，看 `/diagnostics`：
`datadir.assetsPresent` 与 `backend.libLinks` 两项都 ok，才算真的完整
（前者查媒体资产读不读得到，后者查扩展软链有没有在复制中被改写）。

### 7.2 恢复

```bash
node apps/daemon/dist/main.js --data-dir /backup/openmemo-2026-08-06
```

想让它成为默认位置，用网页的「更改位置」搬过去（会一并更新指针文件），
或者直接编辑 `<OS 默认数据目录>/datadir.json`。

### 7.3 卸载

用户的原始要求是：**「删除不要影响程序本体运行」**（ADR-016）。

`[本机实测]` 现跑了一遍：

```
运行中 rm -rf <数据目录>   →  GET /api/health 200 · GET /api/notes 200   （进程没死）
停掉再重启                →  自动重建空目录，health/notes 200，自检回到冷启动的 7/13/5
```

产品自己也是这么说的（`GET /api/settings/data-dir` 的 `noteZh`，`[本机实测]`）：

> 这是一个独立文件夹，删除它不会影响程序本体运行（下次启动会重建空目录）。
> 但请注意 `externalFiles` 里列出的那个指针文件也需要一并删除。

**完整卸载 = 三步**：

1. 停 daemon；
2. 删数据目录；
3. 🔴 **删指针文件** `<OS 默认数据目录>/datadir.json` ——
   不删的话，下次启动会按它去一个不存在的位置建空目录（见 §3.2）；
4. 删仓库目录本身（源码 + `node_modules`）。

⚠️ `[未验证]`：**删除窗口内的写操作行为**（SQLite 文件已删但 fd 仍开着时正好在写）没有测过。
ADR-016 当年就标了这一条，至今没有人补上。

---

## §8 故障排查

按"症状"排，每条都给根因和判据，而不是"试试重启"。

### 8.1 装了 VAD 之后，转写反而全部失败（✅ 已修）

**症状**：冷装完 → 导入 → 转写 job 直接 failed，
日志里 `whisper-vad-speech-segments exited with code 2` /
`whisper_vad_init_with_params: invalid model data (bad magic)`。
**「装了 VAD 比不装 VAD 更糟」，而且是确定性的，不是偶发。**

**根因**（`vad-fix` T-148 查实）：目录里 `role: 'vad'` 下有两个**互相加载不了**的文件 ——
`vad/silero-vad-onnx`（sherpa 用）与 `vad/silero-vad-ggml`（whisper.cpp 用）。
旧的解析器**只按 `role` 挑**，而激活规则是"先装的那个赢"，目录里 onnx 排在前面 ——
于是每一台冷装的机器都会把 sherpa 的 ONNX 交给 whisper.cpp。

> 一句话：**「谁能加载它」这个信息一直写在安装记录的 `engines` 字段里，而解析器从来没读过它。**

**处置**：升级到含 `a7b96b7` 的版本即可。`[CI 实测 run 31076010999]` 三平台的切分方式
都是「VAD（按静音切分）」，权重是 `ggml-silero-v6.2.0.bin`。
真出问题时的判据在 `/diagnostics` 的「音频切分方式」一行，以及 job 结果里的降级说明 ——
**降级现在会出声，不再是静默走固定窗口。**

### 8.2 Windows 上中文搜不到（✅ 已修）

**症状**：装了中文分词扩展、安装记录 `succeeded`、sha256 全过，
但中文双字词一个都搜不到，`health.db.extensions.tokenizer` 是 `trigram`，**零报错**。

**根因**（`win-fixes` T-147 实测，把上游三个 zip 下下来 unzip 数出来的）：

```
libsimple-linux-ubuntu-22.04.zip → libsimple.so
libsimple-osx-arm64.zip          → libsimple.dylib
libsimple-windows-x64.zip        → simple.dll     ← MSVC 不加 lib 前缀
```

产品按 `libsimple${suffix}` 拼名字，**Windows 的包里根本没有 `libsimple.dll` 这个文件**。
排掉的猜测（都是实测，不是推理）：入口点没问题、路径分隔符没问题、动态库搜索路径没问题。

**处置**：已修，两个名字都找。`[CI 实测 run 31076010999]` Windows 上
`ext.chineseSearch = ok`，命中 `用户:1 推特:2 中国:1 服务:2`。
**判据是"四个中文双字词真的搜到了"，不是"文件下下来了"。**

⚠️ 如果你在 Windows 上仍然看到 `tokenizer=trigram`：看 `health.db.extensions.failures.libsimple`
的原文 —— 如果它是**加载错误**而不是"文件不存在"，八成是缺 VC++ 运行时（§1.2 ③）。

### 8.3 macOS 上转写特别慢（正常，但有名有姓）

`[CI 实测 run 31076010999]` 同一段 108 字符的音频：Linux 2.1s · Windows 3.6s · **macOS 106.1s**。

自检里写着原因：`asr.coreml warn 未启用 ANE —— 转写会走 Metal/CPU（功能正常，只是慢）：
ggml-tiny-q5_1.bin → 缺 ggml-tiny-encoder.mlmodelc`。

**两条诚实边界**：

- runner 是虚拟化的 3 核 M1，这个因素与 ANE 因素**没有被拆开过**，
  所以**不要把 48 倍差距全算到 ANE 头上**（`[未定性]`）。
- CoreML encoder 目前只给 large-v3 / turbo 的几个档位挂了
  （tiny/base/small/medium **没挂**，因为我们没有它们的 sha256，
  **编一个摘要出来比不挂糟得多**）。
- 「真机上装了 encoder 之后 `asr.coreml` 从 warn 变 ok」这一半 **`[未验证]`** ——
  开发机是 Linux，`checkCoreMl()` 在非 darwin/arm64 上直接 return。

⚠️ 如果 `asr.coreml` 报的是 **fail** 而不是 warn，那是另一回事：
目录在但里面没有 `coremldata.bin`，whisper 会**静默回退**，
你看到的是"装了 ANE 却没变快"而没有任何东西报错。

### 8.4 网页打开是空白 / `GET /` 没有内容

网页 bundle 没构建出来。能产出它的**只有** `pnpm -r build`（根 `build` 与它等价，
`[本机实测 package.json]`）。另外两条常见命令都不会：

- `pnpm typecheck`（= `tsc -b`）—— `apps/web` 的 tsconfig 是 `emitDeclarationOnly`；
- `pnpm build:safe`（= `pnpm --filter "!@openmemo/web" -r build`）—— **故意**排除网页。

⚠️ `HANDOFF.md` 里"根 `build` 只走 `tsc -b`，不会产出 SPA bundle"那句已经过期，以 `package.json` 为准。

也可以用 `OPENMEMO_WEB_DIST=<某个已构建的目录>` 让 daemon 去别处托管
`[本机实测]` —— `GET /` 返回 200 / 3555 B / `<title>OpenMemo</title>`。

### 8.5 「笔记全没了」

**先别慌，八成一个字节都没丢。** 按顺序查三件事：

1. `GET /api/health` 的 `dataDir` 是不是你以为的那个；
2. 指针文件 `<OS 默认数据目录>/datadir.json` 指向哪（§3.2）；
3. 启动日志里有没有那句「指针文件指向 X，但命令行 --data-dir 指定了 Y」。

这三条覆盖了本项目里出现过的**全部**"数据消失"事故 —— 每一次真实原因都是
**挂到了另一个数据目录上**，而不是数据没了。

### 8.6 模型下不动

- 先看 `/settings` →「代理」→「测试连接」。它**区分**「代理不通」与「上游不通」，
  这两种情况的下一步完全不同。
- 中文网络下直连 `huggingface.co` 通常不通。产品的下载器是**多镜像**的：
  下完必校验 sha256，不过就换下一个镜像，全失败才报错。
  `[本机实测]` 这台机器直连 HF 不通，`asr/whisper-tiny-q5_1` 是自动换到
  `modelscope.cn` 下下来的（job 的 `provider` 字段写着 `modelscope`）。
- ⚠️ **`hf-mirror.com` 不是第二个来源**：`[实测]` 它对 `/resolve/…` 四种路径全部
  308 跳回 `huggingface.co`，跟着跳过去就超时。它在境外出口下等于零冗余
  （境内出口下另说，所以没有删掉它）。

### 8.7 端口被占 / 起不来

- daemon 会在 `17650..17659` 里顺延并**明确告诉你漂移了**。全被占用时会说
  「端口 X..Y 全部被占用，无法启动。请用 --port 指定其它端口」。
- 同一个数据目录**不支持两个实例并存**，会拒绝启动并提示用 `--port` 换端口。

### 8.8 「装了加速包但没变快」

这是 §1.2 ② 那一族的通用症状：`dlopen` 失败在 `GGML_BACKEND_DL=ON` 下不算错误，
whisper 会照常用 CPU 跑完。安装记录成功、sha256 正确、自检里也没有对应检查项。

**今天你大概率碰不到它**：Linux/Windows 的 Vulkan/CUDA 增量包**都没有接进目录**
（D-11 §8.4：三条独立证据表明"纯增量的加速包在本产品里结构上不可用" ——
ggml 只在 whisper-cli 自己的目录与 cwd 找后端模块，而安装器把每个包解到各自的目录；
模块自己的导入表还依赖着**另一个包目录里**的 `ggml-base`）。
macOS 的 Metal 是这一族里唯一能就地解决的一格，所以它**跟核心包一起出厂**。

---

## §9 环境变量速查

只列部署时真正会用到的。全部 `[读码]` 自各自的定义点。

| 变量 | 默认 | 作用 |
|---|---|---|
| `OPENMEMO_HOST` | `127.0.0.1` | 绑定地址。非回环 + 明文 ⇒ 录音不可用（§2.2） |
| `OPENMEMO_AUTH` | `none` | 只有精确等于 `token` 才开鉴权 |
| `OPENMEMO_DATA_DIR` | — | 数据目录，**优先级最高** |
| `OPENMEMO_POINTER_FILE` | `<OS 默认数据目录>/datadir.json` | 指针文件位置。一机多实例时用 |
| `OPENMEMO_TLS` | 关 | `self-signed` / `1` / `true` → 自签 HTTPS |
| `OPENMEMO_TLS_HOSTS` | — | 逗号分隔，额外写进证书 SAN（NAT 外部地址） |
| `OPENMEMO_WEB_DIST` | 自动解析 `apps/web/dist` | 换个目录托管网页 |
| `OPENMEMO_MODELS` / `OPENMEMO_EXT_DIR` | 数据目录下 | 模型根 / 扩展汇聚目录 |
| `OPENMEMO_DB_DRIVER` | 自动 | 强制 `better-sqlite3` 或 `node:sqlite` |

**命令行只有两个旗标**：`--port` 与 `--data-dir`。**没有 `--host`，也没有 `OPENMEMO_PORT`。**

---

## §10 部署前的检查清单

```
[ ] Node ≥ 22 · pnpm 10.15.0
[ ] macOS 用户：系统 ≥ 13.3
[ ] Windows 用户：装了 VC++ 2015-2022 可再发行组件（x64）
[ ] Linux 用户：glibc ≥ 2.34（Ubuntu 22.04 / Debian 12 以上）
[ ] pnpm install && pnpm -r build（★ 带 -r）
[ ] 显式钉死 --port，别依赖默认顺延（端口一变，麦克风授权要重点）
[ ] 决定绑定地址：回环 + SSH 转发（推荐） / 0.0.0.0 + TLS + 知道鉴权是关着的
[ ] 决定数据目录位置，并记住外面还有一个指针文件
[ ] /runtime 装组件 → 重启 → /models 装一个 ASR 模型
[ ] /diagnostics 看一眼：fail 应为 0；剩下的 warn 逐条对照 §6 确认都是预期内的
[ ] 特别确认 tool.ffmpeg 不是「来自系统 PATH」——是的话，换一台机器就会坏
[ ] 读一遍 docs/SECURITY.md 的「当前真实姿态」，确认你接受那个安全姿态
```
