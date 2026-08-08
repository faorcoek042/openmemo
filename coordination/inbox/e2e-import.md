## [2026-08-08 16:10] e2e-import DONE

交付:

- `scripts/ci/e2e-import-audit.mjs`（新）—— F1/F2 端到端判据本体
- `.github/workflows/e2e-import.yml`（新）—— 三平台腿，用 build-bundles 的 artifact
- 提交 `d2a2a73`（主体）、`564b68b`（修 workflow 自己的一处必炸行）

要点:

- **三平台全绿**：CI run **31247374404**（linux-x64 / darwin-arm64 / win32-x64 全 success），
  用 build-bundles run `31246835406` 的**预编译包**跑，解释器是**包自带的 Node**。
- 6 个用例每平台都过：wav / mp3 / m4a / mp4(带视频) / 传绝对路径 / F1 链接导入。
- **借宿主工具 0 个**（三平台一致，判据用产品自己的 selfcheck `tool.*`）。
- 顺带查出**两个真实缺陷**（下面 §3），其中「代理永远到不了 yt-dlp」对国内用户是硬伤。

下一步建议:

1. 修「代理到不了 yt-dlp」——`BuildRegistryOptions` 加 `proxy` 并透传（§3.1）。
2. `hasVideo` 恒 false 且零读者，按 `degradationChain` 的先例删掉（§3.2）。
3. 这条腿目前是 `workflow_dispatch`；出包之后建议由 build-bundles 串起来自动跑。

需要 Manager 决策: 无。

---

# 1. 判据是什么 —— 以及为什么此前那条不算

用户的批评我认。此前 CI 验的是「产品能不能被脚本驱动着转出一段文本」
（`cold-start-audit.mjs` 第 7 节：import → job → transcript，判据是非空文本），
而交付的是「**人要用手打开并使用它**」。中间这些一条没测：

| 环节                                       | 此前覆盖 |
| ------------------------------------------ | -------- |
| 网页拖文件发的那个 multipart 上传          | **零**   |
| 播放器发的那个 `/media` Range 请求         | **零**   |
| 粘链接走 yt-dlp 取回那条链（`fetch` 分支） | **零**   |

第三条有旁证：`ytdlp.ts:169` 那条「EXIT CODE 101 IS SUCCESS HERE」的注释自陈
「only `probe` had ever been exercised end to end; `fetch` had not」——
也就是说**每一个视频的导入都曾经必然失败**，而没有任何测试会红。

## 判据本体：`assertPlayable()`

不是"数据库里有记录"，是七条一起成立：

1. `/api/notes/:uid` 里有 `role=original`、`state=ready`、带 `url` 的资产
2. 整体 GET → 200 + `Content-Length` 对 + `Content-Type` 对 + `Accept-Ranges: bytes`
3. **sha256 往返：导进去的文件与 `/media` 吐出来的字节逐字节相同**
4. `Range: bytes=0-1023` → **206** + `Content-Range` 对 + 字节等于文件头
5. `Range: bytes=-1024`（后缀）→ 206 + 字节等于文件尾
6. 越界 Range → **416** + `Content-Range: bytes */size`
7. `audio16k` 那份也取得到（F5 波形/时间轴联动的素材）

第 3 条最值钱：它同时否掉「落库了但文件丢了」「归档时截断了」「Range 偏移算错了」
—— 而这三种在"数据库里有一行"的判据下**全都是绿的**。

# 2. 三平台各自跑到哪一步、实际拿到什么

CI run **31247374404**，包来自 build-bundles run **31246835406**（v0.2.0 三个包）。

| 平台           | runner       | 包                                | 结果            |
| -------------- | ------------ | --------------------------------- | --------------- |
| linux-x64      | ubuntu-24.04 | `openmemo-0.2.0-linux-x64.tar.xz` | ✅ 6/6，借 0 个 |
| darwin-arm64   | macos-26     | `openmemo-0.2.0-darwin-arm64.tar.gz` | ✅ 6/6，借 0 个 |
| win32-x64      | windows-2025 | `openmemo-0.2.0-win-x64.zip`      | ✅ 6/6，借 0 个 |

三平台都确认「解释器 = 包自带的 Node，不是宿主的」，例如 Windows：

```
解释器 = 包自带的 dist\e2e-bundle\openmemo-0.2.0-win-x64\runtime\node.exe
        （**不是**宿主的 C:\hostedtoolcache\windows\node\22.23.2\x64\node.exe）
```

## 借宿主工具：0 个（三平台一致）

判据用产品自己的（`selfcheck.ts` 的 `tool.*`：路径在 storeRoot 底下 = 自己下的，
warn+detail 提到 PATH = 借的）。linux 实测：

```
tool.ffmpeg      ok  /tmp/openmemo-e2e-import-Y2JDHn/data/models/by-name/backend/ffmpeg-…/bin/ffmpeg
tool.ffprobe     ok  …同上
tool.whisperCli  ok  …/by-name/backend/whispercpp-vulkan-linux-x64/whisper-cli
tool.whisperVad  ok  …/by-name/backend/whispercpp-vulkan-linux-x64/whisper-vad-speech-segments
tool.ytDlp       ok  …/by-name/backend/yt-dlp
✅ 产品自己下载并校验的 (5)   ⚠️ 借宿主 PATH 的 (0)   ❌ 装不上 (0)
```

## F2：走网页真正发的那个请求

用 `POST /api/notes/upload`（multipart/form-data，字段名 `file`），与
`apps/web/src/features/capture/upload.ts:69` 同一形状 —— **不是**传路径那条。
浏览器读不到真实路径，所以"传路径"那条 API 网页根本用不上（另用 F2b 单独覆盖）。

样本用产品**自己下载的 ffmpeg**从 `vendor/whisper.cpp/samples/jfk.wav` 现造，各 5 秒：

```
f2-audio.wav  160078 B  PCM / WAV / 仅音轨
f2-audio.mp3   40941 B  MP3 / MPEG / 仅音轨
f2-audio.m4a   44453 B  AAC / MP4 / 仅音轨
f2-video.mp4   60015 B  H.264+AAC / MP4 / **带视频**
```

linux 实测（四例形状一致，此处摘 mp3 与 mp4）：

```
POST /api/notes/upload (40941 B) → HTTP 202 {"noteUid":…,"jobUid":…,"bytes":40941,
                                   "filename":"f2-audio.mp3","storedAs":"01KZG…DS.mp3"}
转写 job：succeeded (2.0s)
资产 3 个：original(ready,40941B,mime=null) audio16k(ready,?B,mime=null) peaks(ready,640B,…)
GET /media/asset/01KZG6515ZVBEVG168KB6ETK8G → 200  40941 B  Content-Type=audio/mpeg
                                              Content-Length=40941  Accept-Ranges=bytes
✔ sha256 往返一致（9a48de4ff5257fce… / 40941 B）—— 导进去的字节原样播得出来
Range bytes=0-1023  → 206  Content-Range=bytes 0-1023/40941      收到 1024 B
Range bytes=-1024   → 206  Content-Range=bytes 39917-40940/40941  收到 1024 B
Range bytes=41041-  → 416  Content-Range=bytes */40941

GET /media/asset/01KZG654WH9JPT7D0KSM86CCZZ → 200  60015 B  Content-Type=video/mp4
✔ sha256 往返一致（6042c6676ee401d6… / 60015 B）
```

四种容器的 `Content-Type` 全部正确：`audio/wav` / `audio/mpeg` / `audio/mp4` / `video/mp4`。

## F1：链接导入，走到了 yt-dlp，但只走到那一段

linux 实测：

```
openmemo-e2e-fixture.test → 127.0.0.1
fixture 服务器绑在 127.0.0.1:19801
粘的链接：http://openmemo-e2e-fixture.test:19801/clip.mp4
POST /api/notes/probe → HTTP 200 {…,"site":"openmemo-e2e-fixture.test","adapterId":"yt-dlp",…}
★ 产品说这条链接的解析者是：adapterId=yt-dlp
POST /api/notes/import → HTTP 202
── fixture 服务器收到 4 个请求（"谁去取的"的硬证据）──
   GET /clip.mp4  UA=Mozilla/5.0 (…) Chrome/144.0.0.0 …
   GET /clip.mp4  UA=… Chrome/148.0.0.0 …   ← 版本号每次都不同
转写 job：succeeded (4.0s)
→ /media 的 200 / 206 / 416 全部与 F2 同形，通过
```

三平台的 `adapterId` 都是 `yt-dlp`。

### 为什么必须绕这一圈（不是图省事）

产品自己的 SSRF 防线 `argGuard.ts:isPrivateOrReservedHost` 拒绝一切**字面**的
私有/回环地址（`localhost` / `*.local` / `*.internal` / `127/8` / `169.254/16` …）。
**这是正确行为** —— daemon 自己就绑在 127.0.0.1 上，放行回环等于把产品变成
confused deputy。所以不能改产品，也不该改产品。

改用一个**公网形状**的主机名（`.test`，RFC 6761 保留给测试），
由 workflow 在**一次性 runner** 的 hosts 文件里指向 127.0.0.1。于是链路自然变成：

- `validateHttpUrl` 只做**字面**判断 → 通过
- `DirectHttpSource`（score 80）先被试 → 它调 `assertHostNotPrivate()`，
  那个**真的解 DNS** → 解到 127.0.0.1 → 判私有 → 拒绝 → 落到下一个候选
- `YtDlpSource`（score 10）→ 只做字面判断 → **yt-dlp 真的被 spawn、真的发 HTTP、
  真的把字节下下来**

也就是说走的是 `registry.ts:90-105` 写好的那条 fallback 链，**不是绕过它**。

⚠️ **脚本自己绝不碰 hosts 文件**（PROTOCOL §9-bis：把它 kill -9 在最坏的那一行，
机器上不能留下东西）。解析不到时它如实报 `SKIPPED(主机名没指向回环)` 并打印需要的那一行。

# 3. 查出来的真实缺陷

## 3.1 【已证实 · 建议尽快修】用户配置的代理**永远到不了 yt-dlp**，F1 在墙内必失败

证据链（全部逐行核对过）：

| # | 事实 | 位置 |
| - | ---- | ---- |
| ① | `YtDlpSourceOptions.proxy` 存在且有注释「Outbound proxy. yt-dlp honours both http(s) and SOCKS」 | `packages/pipeline/src/media/sources/ytdlp.ts:62-63` |
| ② | 适配器内部确实用它 | `ytdlp.ts:106`、`ytdlp.ts:131`（`ytDlpProxyArgs(this.opts.proxy ?? null)`） |
| ③ | **唯一的生产构造点没传 `proxy`** | `packages/pipeline/src/index.ts:294`：`new YtDlpSource({ tools: opts.tools, cwd: opts.cwd })` |
| ④ | `BuildRegistryOptions` 里**根本没有** `proxy` 字段 | `packages/pipeline/src/index.ts:266-278` |
| ⑤ | `fetch()` 里的 `run({…})` 既没传 `proxy` 也没传 `env` | `ytdlp.ts:156-167` |
| ⑥ | 子进程环境是**白名单重建**的，代理变量不会被继承 | `subprocess/runner.ts:99-105`，POSIX 白名单 = `['PATH','HOME','TMPDIR','LANG','LC_ALL','TZ']`；注释自陈「Proxy vars are added deliberately, never inherited」 |

→ 结论：`--proxy` 这条路（②）和环境变量这条路（⑥）**同时断着**。
`PATCH /api/settings/proxy` 会 `applyProxyConfig()` 设全局 undici dispatcher，
所以**模型/后端包的下载确实走代理**；但 yt-dlp 是子进程，拿不到 dispatcher，
也拿不到 flag 和 env。

**用户视角**：在设置页填好代理 → 接口回 `appliedImmediately: true` → 模型能下下来
→ **粘一个 YouTube/B 站链接仍然直连**。UI 说代理生效了，F1 那条却没有。
考虑到这个产品的界面是中文的，这条基本等于"F1 对主要用户群不可用"。

修法建议：`BuildRegistryOptions` 加 `proxy?: ProxyConfig | null`，
`buildDefaultRegistry` 透传给 `YtDlpSource`（和 `DirectHttpSource`），
daemon 在 `setup.ts:357` 处从 `readProxyConfig(repos)` 取。
`setup.ts` 现在**一个 `proxy` 字都没有**（`grep -n proxy` 零命中）。

⚠️ 未验证：`DirectHttpSource` / ffmpeg 那几条路径的代理是否完整。
`RunOptions.proxy` 的注释写着「which is exactly why HTTP_PROXY never reached ffmpeg
**before**」，读起来像已修，但我**没有逐个调用点核实**，标 `[未验证]`。

## 3.2 【已证实 · 影响小】`hasVideo` 恒为 `false`，且**零读者**

全仓 `grep hasVideo` 只有 4 处：

```
apps/daemon/src/jobs/runners/transcribe.ts:382   hasVideo: false,   ← 字面量
apps/daemon/src/ws/recorder.ts:390               hasVideo: false,   ← 字面量
apps/daemon/src/jobs/events.ts:227               hasVideo: boolean; ← 类型声明
packages/shared/src/events.ts:270                hasVideo: boolean; ← 类型声明
```

两个生产者都写死 `false`，**没有任何消费者**（前端一处都不读）。
所以它**不会**导致"视频文件看不到播放器"（网页是按资产/mime 判断的，本轮实测
`Content-Type: video/mp4` 完全正确）。它是一个**恒假且没人读的契约字段** ——
与被删掉的 `degradationChain` 同一形状，建议照先例删，或者真的从
`result.media.audioOnly` 算出来。

## 3.3 【观测】`media_assets.mime` 对 `original` / `audio16k` 恒为 NULL

`transcribe.ts:334-349` 的 `createAsset({…})` 没传 `mime`。三平台实测都是
`original(ready,…,mime=null) audio16k(ready,…,mime=null)`，只有 `peaks` 有 mime。

今天无害：`/media` 会 `guessMime(abs)` 按扩展名兜底，本轮四种容器的 Content-Type
全对。但 `NoteAsset.mime: string | null` 这个契约字段实际恒 null，
将来任何按 `asset.mime` 判断的消费者都会拿到 null。

## 3.4 【我自己的 workflow 的缺陷 · 已修】`ls` 多 glob 在 `set -e` 下必炸

第一次真跑（run **31247156655**）**三条腿同时死**在这一行：

```bash
ARCHIVE=$(ls dist/e2e-src/*.tar.xz dist/e2e-src/*.zip dist/e2e-src/*.tar.gz 2>/dev/null | head -1)
```

三个 glob 里必然有两个匹配不到 → `ls` 非零退出 → `set -e` 当场带走整步。
退出码 **2 / 1 / 2**（linux / macOS / windows）与「GNU ls 用 2、BSD ls 用 1」逐一对上。
`2>/dev/null` 只吞掉了**信息**，没吞掉**退出码** —— 这一行看起来是防御性的，实际是引爆点。

记在这里是因为它正是本任务在查的那个形状：**这条 workflow 自己就是
"从来没被执行过所以看起来没问题"**。已改成 `for` + `-f` 逐个测，并在本机用
`set -euo pipefail` 复现 + 验证过修复（`564b68b`）。

## 3.5 【我自己的脚本的缺陷 · 已修】"端口上有东西应答" ≠ "我起的那个 daemon 起来了"

本机第一轮：上一轮跑剩的 daemon 还占着 19800，健康检查**当场就绿（0.5s）**，
而我 spawn 的那个因端口冲突以 exit 4 死了。于是后面整整一节都在跟**别人的 daemon**
说话（它的数据目录我已经 `rm` 掉了，在一个装满的 tmpfs 上），拿到一串 `DISK_FULL`
—— 那串错误看起来像产品有毛病，其实是我连错了进程。

修法用产品自己摆好的东西：`/api/health` 的 `pid` / `dataDir`
（`server.ts:151-175` 的注释写明这几个身份字段就是给 EADDRINUSE 之后认人用的）。
**假的红灯和假的绿灯一样贵。**

顺带一条正面记录：daemon 的端口冲突检测做得很好，报错同时给出**双方的 dataDir**，
是我能一眼定位的原因。

## 3.6 【已修】失败发生的地方与失败显形的地方隔了 60 行

本机一轮里 whispercpp 包因下载源抖动没装上，而产品找不到 `whisper-cli` 时
**回退到 PATH**（`tools.ts:850` 的 `findInBackendPacks(…) ?? fromPath(…)`）；
PATH 上放着本脚本的屏蔽 shim，于是**六个用例全部**失败在
`maskbin/whisper-cli exited with code 127` —— 读起来像「转写坏了」，
实际是「后端包没装上」，而真正的原因在 60 行之前打印过、被淹没了。

已在装包处立闸：缺哪个说哪个，并明写它会以什么面目在后面爆炸。
另外对**产品自己标了 `retryable:true` 的**失败重试一次（`retryable:false` 的一次都不重试）。

# 4. 结构上在 CI 里验不了的（这一段也是结论）

- **真外网 + 真站点解析器**：yt-dlp 的 YouTube/Bilibili 页面解析、签名解密、限速、
  年龄/地区/同意墙 —— 本轮喂的是直链，走的是 yt-dlp 的 **generic 提取器**。
  站点专用提取器**在 CI 上结构性地验不了**：它要求真的去抓那些站点，
  既不可靠（反爬、地区差异）也不合适。
- **DirectHttpSource（许可证干净的那一支）**：它的 `assertHostNotPrivate()` 会解 DNS，
  本地回环 fixture 必然被它判私有。**用回环 fixture 验 F1，就只能验 yt-dlp 那一支** ——
  二者互斥，不是我漏了。要验直链那一支需要一个真的公网 media URL。
- **TLS / https 那一段**：fixture 是明文 http。
- **代理**：见 §3.1 —— 产品侧根本没接上，无从验起。
- `hosts` 文件那一行是 workflow 在一次性 runner 上加的；**在没有这一步的环境里
  F1 会诚实地报 SKIPPED**，不会假绿。

# 5. 门禁

本机（2026-08-08）：

| 门禁               | 结果                                                                 |
| ------------------ | -------------------------------------------------------------------- |
| `pnpm -r test`     | ✅ **fail 0**，11 个包共 **1532** 条（基线 1508；+24 来自并行 agent，我没加测试） |
| `tsc -b`           | ✅ 无输出                                                            |
| `build:safe`       | ✅ exit 0                                                            |
| `test:ci-scripts`  | ✅ 22 passed, 0 failed                                               |
| `lint-workflows`   | ✅ 1027 条断言全过（12 个 workflow）                                 |
| `check:orphans`    | ✅ 没有新的零引用导出，基线也没有过期条目                            |
| `eslint`（我的文件） | ✅ 0                                                                 |
| `format:check`（我的文件） | ✅ 通过                                                       |

⚠️ **全树的 `eslint` / `format:check` 在我检查的那一刻是红的，但红在别人的在飞文件上**，
我一个字都没动（PROTOCOL §1）：

- `scripts/build-bundle.mjs:821` —— 真的语法错误（`Parsing error: ',' expected`），
  看内容是 bundle-launch 那一路正在写 quarantine 说明
- `scripts/ci/e2e-runtime-audit.mjs`、`scripts/ci/simulate-user-launch.mjs` —— 另一路的新文件
- 早些时候还见过 `apps/daemon/src/bootstrap/open-browser.ts`、`scripts/ci/e2e-record.mjs`、
  `scripts/ci/ws-client.mjs`

`pnpm format` 会 `--write` 整棵树，那样就把别人正在编辑的文件也改了并塞进**共享索引**，
所以我只对自己的两个文件跑了 prettier。提交前核对过 `git diff --cached --name-only`
的全量列表，两次提交分别只有 2 个 / 1 个文件，全是我自己的。

# 6. 边界自查

- 没碰 `:10000`、没碰 `/root/data-memo`、没碰 `~/.local/share/openmemo/datadir.json`
  （脚本每次 `mkdtemp` + `OPENMEMO_POINTER_FILE` 重定向，模块级设定、窗口为零）
- 没用 `pkill`（只 kill 自己 spawn 的 pid）
- 没建/改/删 release
- 没动 `start.cmd` / `OpenMemo.command` / quarantine（那是 bundle-launch 那一路的）
- 没改别人的 workflow —— 新建 `.github/workflows/e2e-import.yml`
- 端口用 198xx 段，避开 :10000 / 17650 / 冷启动审计的 197xx
- 脚本**不修改 hosts 文件**；那一步只发生在 workflow 里的一次性 runner 上
