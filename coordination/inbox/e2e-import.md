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

---

## [2026-08-08 17:40] e2e-import(代理缺陷修复) DONE

交付:

- `packages/pipeline/src/subprocess/proxy.ts` —— 新增 `ProxyResolver` 类型
- `packages/pipeline/src/index.ts` —— `BuildRegistryOptions.proxy` **必填**并透传两个适配器
- `packages/pipeline/src/media/sources/{ytdlp,directHttp}.ts` —— 真的把代理递给子进程
- `packages/downloader/src/proxy.ts` —— 新增 `activeProxyConfig()`
- `apps/daemon/src/pipeline/setup.ts` —— 逐次解析的 `subprocessProxyResolver`
- `scripts/ci/proxy-coverage-audit.mjs`（新）—— 起真代理逐条量出网路径
- 守卫：`packages/pipeline/src/subprocess/__tests__/proxyCoverage.test.ts`（新）、
  `packages/pipeline/src/audio/__tests__/ffmpegProxyEnv.test.ts`（新）
- 提交 `f275deb`

要点:

- **先量后改**：6 条出网路径逐条实测，改前 2 条绕过代理，改后全部走代理。
- **没动子进程环境白名单** —— 那道防线与代理无关，正确修法是把配置递下去。
- 守卫已反向验证：**6 个变异体全部变红**，还原后全绿。
- `hasVideo` **不是零读者**（我上一轮判错了），已改成真值并端到端验证。
- `media_assets.mime` 判断为**不值得修**，理由见 §D。

需要 Manager 决策: 无。

### A. 每条出网路径实测（本机，真代理，非代码推断）

判据设计：探针主机名用一个**本机解析不出来**的 `.test` 名字。走代理时主机名由代理去解，
所以"通了"本身就是走了代理的证据；不走代理则 DNS 失败。不需要额外推断。

| 出网路径                        | 机制         | 改前     | 改后         |
| ------------------------------- | ------------ | -------- | ------------ |
| ① 模型/组件下载                 | 进程内 fetch | ✅ 走     | ✅ 走         |
| ② LLM API（openrouter 实测 200）| 进程内 fetch | UNKNOWN¹ | ✅ 走         |
| ③ direct-http probe（HEAD）     | 进程内 fetch | ✅ 走     | ✅ 走         |
| ④ ffprobe 远端读                | **子进程**   | UNKNOWN² | UNKNOWN²（单测守） |
| ⑤ yt-dlp probe                  | **子进程**   | ❌ **绕过** | ✅ 走      |
| ⑥ yt-dlp fetch                  | **子进程**   | ❌ **绕过** | ✅ 走      |
| ⑦ 改回 `off` 后立即生效         | —            | 未测     | ✅ 立即生效   |

¹ 头一轮挑了 `openai`，而 `canRefreshModelList()` 只对 `official-api`/`local-api` 为真，
其余 20 家会在**发请求之前** 400。改挑 `openrouter` 后测到了。
² 明文 http 上**结构性测不到**：`audio/ffmpeg.ts:45` 的
`REMOTE_PROTOCOLS = 'https,tls,tcp,crypto,httpproxy'` **不含 `http`**，ffprobe 在
`-protocol_whitelist` 就拒了，**一个包都不发**。"代理没看到 ffprobe"的真实含义是
"ffprobe 根本没跑"。改由 `ffmpegProxyEnv.test.ts` 守。

**规律**：进程内 `fetch` 由 `setGlobalDispatcher()` 一处接全局，call site 无从绕过；
**子进程**只认自己 argv 的 `--proxy` / 自己 env 的 `http_proxy`，**必须被显式告知**。
漏一个就是一个静默的洞。

### B. 怎么在不拆掉白名单防护的前提下把代理递下去

`buildChildEnv` 的 ALLOWED 白名单（POSIX 侧 `PATH/HOME/TMPDIR/LANG/LC_ALL/TZ`）
是参数注入防护的一部分：它拒绝**继承** `process.env` 里任何没列名的变量，
挡的是 `LD_PRELOAD` / `DYLD_INSERT_LIBRARIES` / `NODE_OPTIONS`。

代理变量本来就走另一条路 —— `proxyEnv()` 从**已校验的配置具名注入**
（`runner.ts` 原话「Proxy vars are added deliberately, never inherited」）。
**所以一个字都没动白名单**，只是把配置递下去：

1. `ProxyResolver = (targetUrl) => ProxyConfig | null` —— **按目标逐次解析**。
   不用快照，因为 `no_proxy` 与 http/https 的取舍本来就是每个目标各自的事；
   给所有目标一个统一答案，恰恰会在最需要代理的那群用户身上出错。
2. `BuildRegistryOptions.proxy` **必填**。可选字段会被原样漏掉，
   而漏掉之后一切照常工作 —— 在不需要代理的机器上，也就是我们所有的开发机上。
   （改成必填当场逼红了 3 个既有调用点，它们现在显式写 `proxy: () => null`。）
3. daemon 侧 `activeProxyConfig()` **每次现取**。

⚠️ 有一条**反向**用例专门钉住「白名单没被拆开」：把 `http_proxy` 塞进宿主 env，
断言它**不会**漏进子进程。

### C. `appliedImmediately` 现在是真话（两个方向都验了）

- **开**：registry 是 daemon **启动时**建的，代理是启动**之后**才 PATCH 进去的
  —— ⑤⑥ 照样走代理，**没有重启**。
- **关**：PATCH `mode=off` 之后下一次 yt-dlp **立刻不再**经过代理（代理命中 0 条）。
  只验一个方向的话，"配置被读到了"与"值被写死成代理"分不开。

### D. 守卫怎么保证下一条新增的出网路径不会再绕过去

| 守卫 | 拦什么 |
| ---- | ------ |
| `BuildRegistryOptions.proxy` 必填（编译期） | daemon 必须回答这个问题 |
| `proxyCoverage.test.ts` 扫 `run()/runOrThrow()` 调用点 | **新增的子进程调用点默认是红的** |
| 同上：`proxy: opts.proxy` 必须真的传给两个适配器 | 从构造里删掉时 TS 不报错，这条报 |
| 同上：`proxy` 不许被改回可选 | 防"顺手简化" |
| `ffmpegProxyEnv.test.ts` | 注入要生效；**白名单要仍然挡着继承** |

豁免走**逐调用点**的 `proxy-not-needed: 理由` 标记，不是文件级白名单 ——
`ytdlp.ts` 里既有出网的 probe/fetch，也有纯本地的 `--version`，文件级粒度只能二选一。
理由长在做决定的地方。

**反向验证**（`/root/rv-proxy` 隔离副本，不在共享树里做，PROTOCOL §10）：

| 变异 | 结果 |
| ---- | ---- |
| 对照组（不改） | pass 11 / fail 0 |
| A `proxy` 改成可选 | **红** |
| B registry 不递 proxy 给 YtDlpSource | **红** |
| C 不再拼 `--proxy` | **红** |
| D 新增一个没传 proxy 的出网调用点 | **红** |
| E `buildChildEnv` 不再注入代理 | **红** |
| F 把 `http_proxy` 加进继承白名单 | **红** |
| 还原后 | pass 11 / fail 0 |

F 这条尤其要紧：它挡住"为了让代理过去而拆掉白名单"这条错误修法。

⚠️ 自陈：A–D 头一轮只改 `src` 而测试跑的是 `dist`，所以 E 显示"不红" ——
那不是守卫的洞，是**我验证方法的洞**。改成直接变异 `dist` 下的产物后 E/F 都红。

### E. `hasVideo`：**我上一轮判错了，它不是零读者**

Manager 提醒的 `.mjs` 盲区**正中要害**。全类型 grep 之后：

```
apps/daemon/scripts/e2e-f2.mjs:185  'media.ready': [...,'hasVideo']   ← 真读者（契约断言）
packages/shared/openapi.yaml                                          ← 公开契约
```

上一轮只 grep 了 `.ts/.tsx` 所以看不见。按既定原则「有真实读者就补契约补测试」：
**没有删，改成真值** `hasVideo: result.media.audioOnly === false`
（`audioOnly` 是 ffprobe 探到的流信息，不是按扩展名猜的）。

端到端实测（`e2e-import-audit.mjs` 新增 SSE 断言，收 `media.ready` 逐条比对）：

```
✔ media.ready.hasVideo=false（PCM / WAV / 仅音轨）
✔ media.ready.hasVideo=false（MP3 / MPEG / 仅音轨）
✔ media.ready.hasVideo=false（AAC / MP4 / 仅音轨）
✔ media.ready.hasVideo=true （H.264+AAC / MP4 / **带视频**）
```

`ws/recorder.ts` 那处 `false` **没动**：现场录音本来就没有视频轨，那是真话；
而且该文件正被 F3 那一路改着。

### F. `media_assets.mime` 恒 NULL：**判断为不值得修**

能拿到的"真值"**比现在这个更不可信**：

- 上传那条路的 `contentType` 来自浏览器 multipart 里的一行字（E2E 脚本发的就是
  `application/octet-stream`）。真填进去，`/media` 就会用它替掉现在那个正确答案，
  **mp3 反而变得不可播**。
- 链接导入那条来自远端服务器的响应头，同样是对方说了算。

而现状是：mime 为空 → `/media` 按**扩展名** `guessMime()` 兜底，
`[CI 实测 run 31247374404]` 三平台 × 四种容器 Content-Type **全部正确**。
把"别人声称的类型"写进库，会挤掉"我们自己算得准的类型" —— 与 D-01 §8.5 同向。

**结论：保持 NULL。** 已在 `transcribe.ts` 的 `createAsset` 上方写明这是判断不是遗漏，
并注明将来的消费者应调 `guessMime()` 而不是读这一列。

### G. 自陈：第一版测量是错的，三条结论作废过

1. **undici 的 `ProxyAgent` 对明文 http 目标也发 CONNECT**（不只 https 才隧道）。
   我照着去 `netConnect` 一个解析不出来的主机 → 失败 → 客户端狂重试，
   一轮收到 **306,685 次 CONNECT**，把 89k/209k 这种数量级写成了"证据"。
   **数量级不对的证据比没有证据更危险 —— 它看起来像是测到了。**
   改成：探针主机的 CONNECT 在本地终结隧道，交给内置源站服务。
2. 把「路由层在发请求**之前**就 400」读成"绕过代理"。→ 改判 UNKNOWN。
3. 把「job 因缺 ASR 而 `blocked`、fetch 压根没跑」读成"绕过代理"。→ 装上 ASR 再测。
4. UA 判别写成"不是 OpenMemo 就算 yt-dlp"，而 direct-http 的 ranged 兜底**不带 UA**
   → 误算成 yt-dlp。改成认 yt-dlp 伪装的浏览器 UA 特征。
5. 守卫自己曾**假装在看**：从 `dist` 跑时 `../..` 落在 dist，而 `.d.ts` 也以 `.ts` 结尾
   被收进扫描集 → 一行真源码没看过却全绿。已改成向上找 package.json 再进 `src/`，
   并加了"必须读到实现文件"的前提自检。

### H. 门禁

| 门禁 | 结果 |
| ---- | ---- |
| `tsc -b` | ✅ 0 |
| `build:safe` | ✅ 0 |
| `lint-workflows` | ✅ 1147 条断言全过（13 个 workflow） |
| `check:orphans` | ✅ 没有新的零引用导出，基线没过期 |
| `eslint`（我的文件） | ✅ 0 |
| `format:check`（我的文件） | ✅ 通过 |
| `packages/pipeline` 测试 | ✅ **238 / fail 0**（含我新增的 11 条守卫） |
| `pnpm -r test` 合计 | 1558 条，**fail 3** |

⚠️ 那 3 条**不是我的**，证据确凿：全在 `apps/daemon/src/jobs/mergeWords.test.ts`，
报错是 `引擎 whisper.cpp 加载不了这个模型…（它要的是 ggml 格式）`，
抛自 commit **`749c949`**（模型格式那一路）新加的 `canEngineLoad` 校验拒绝了该用例的
夹具模型。我改的东西不碰 merge、不碰模型格式。开工时是 6 条，现在 3 条 —— 那一路在修。

### I. 共享树的两处摩擦（如实记，未擅自处置）

1. **`apps/daemon/src/jobs/runners/transcribe.ts` 是共享文件**：我在里面改 `hasVideo`
   的同时，模型格式那一路也在改它（约 100 行）。`git add` 会把他们**没写完**的代码
   一起提交。处置：用 `git hash-object` + `update-index --cacheinfo` 构造
   「HEAD 版本 + 只有我那两处改动」的 blob 来暂存。
   ⚠️ 后来发现 commit `749c949` 已经把工作区里我那两处改动**一并提交了**，
   所以最终我这条提交里**不含** `transcribe.ts`（暂存内容与 HEAD 相同）。
   `hasVideo` 的修复现在在 `749c949` 里，**不是我的提交**，但确实已经落地并验过。
2. **`.github/workflows/e2e-import.yml` 被别人改了**（把取包那步提成共享脚本，
   对应 `037a6ef`「消灭抄两份」）。那是合理的去重，**我没有回退、也没有暂存它**，
   留在工作区里由改动方自己提交。

⚠️ 全树 `format:check` / `eslint` 我最后一次检查时仍有别人在飞的文件红着，
我只对自己的文件跑 prettier，**没有把 `--write` 打进共享索引**。

---

## [2026-08-08 19:30] e2e-import(三平台实跑 + §11) DONE

交付: `.github/workflows/e2e-import.yml`、`scripts/ci/e2e-import-audit.mjs`（提交 `0303e53`）

要点:

- **三平台全绿：CI run `31253127981`**（linux-x64 / darwin-arm64 / win32-x64 全 success）。
- 头一轮 run `31252636757` **三平台全红**，只红在一条断言上 —— 而那是**对的**：
  包比修复旧。详见 §B，这条值得单独记。
- Manager 提醒的「取最近一次 success 可能选到残缺 run」**是真的会咬到我的**，已修（§C）。
- 没再撞到脚手架的问题；`unzip || tar` 我是**走共享脚手架**那一档，两条都有（§D）。
- §11 四条已逐条满足，端口那条做了反向验证（§A）。

需要 Manager 决策: 无。

### A. 这条腿现在满不满足 §11

协议里点名的三个实例有一个就是我这条（健康检查连上游离 daemon、0.5 秒报"就绪"）。逐条：

| §11 条款 | 此前 | 现在 |
| --- | --- | --- |
| 探测前先证明端口是空的 | ❌ 只在健康检查**之后**比 pid —— 能抓住但太晚 | ✅ `assertPortFree()` 在每次 spawn 前跑，不空**当场判失败** |
| 按 pid 收整棵进程树 | ⚠️ 只 `child.kill()`，Windows 上孙子进程会留下 | ✅ Windows 走 `taskkill /PID <pid> /T /F`（带超时）；**仍然按 pid，没用 pkill -f** |
| 一切外部命令带超时 | ⚠️ HTTP 调用没有上限 | ✅ 统一挂 `AbortSignal.timeout`（默认 120s）；ffmpeg 造样本本来就有 |
| 跳过不许渲染成成功 | ❌ F1 跳过时 push `ok:null` 然后 exit 0 | ✅ 见下 |

**"跳过"分两种，处置不同**（这一条我改得比原来重）：

- **非自愿跳过**（fixture 主机名没指向回环 = workflow 那步坏了）→ **当场判失败**。
  以前它会继续报绿，而 F1 一次都没跑过 —— 正是 §11 最廉价的那种发作。
- **显式 `--skip-f1`**（人的选择）→ 允许继续，但结论区必须单独喊
  「已执行的用例全部通过，但**本轮不是全量**」，把跳过的列出来。

**反向验证**（占住端口再跑）：

```
✘ E2E 导入审计中断：端口 19890 不是空的（EADDRINUSE）—— 启动 [cold] daemon 之前。
      PROTOCOL §11：起服务再探测的测试，探测前必须先证明端口是空的。
```

正是此前那个"0.5 秒报就绪"的场景，现在**立刻红**。

### B. 头一轮三平台全红 —— 而那是对的（这条比绿灯更值钱）

run **31252636757**（对 bundle run `31248640972`）：三平台**各自只有一条**失败，其余全过
（sha256 往返、206/416 Range、audio16k、F1 走 yt-dlp、借宿主 0 个）：

```
✘ [F2:f2-video.mp4] media.ready.hasVideo=false，期望 true（H.264+AAC / MP4 / **带视频**）—— 契约字段在说谎
```

追因：那个包的 head sha 是 **`9539e4b`（08-08 08:32Z）**，而 `hasVideo` 的修复在
**`749c949`（08-08 17:18）**才落地 —— `git merge-base --is-ancestor` 判定
**包早于修复**。所以断言是对的，**包是旧的**。

> **结论（结构性，建议记住）：这条腿验的是"用户下载的那个包"，
> 所以任何产品侧修复在**重新出包之前**都不会在这条腿上显形。**
> 换句话说：这条腿红了，第一件要问的不是"代码对不对"，而是
> **"我手里这个包是从哪个 commit 出来的"**。

处置：从当前 master 重新出包（build-bundles run **`31252923419`**，sha `20176f2f`，
三平台产物齐全），再跑 e2e-import run **`31253127981`** → 三平台全绿：

```
✔ media.ready.hasVideo=false（PCM / WAV / 仅音轨）
✔ media.ready.hasVideo=false（MP3 / MPEG / 仅音轨）
✔ media.ready.hasVideo=false（AAC / MP4 / 仅音轨）
✔ media.ready.hasVideo=true （H.264+AAC / MP4 / **带视频**）
✔ 产品报告 adapterId=yt-dlp，且 fixture 真的被取了 4 次
⚠️ **借宿主 PATH 的 (0)**：(无)      ✔ 一个都没借。
✔ 全部通过。
```

Windows 侧确认用的是包自带的解释器（`--require-node-runtime` 生效）：

```
解释器 = 包自带的 D:\a\...\openmemo-0.2.0-win-x64\runtime\node.exe
        （**不是**宿主的 C:\hostedtoolcache\windows\node\22.23.2\x64\node.exe）
```

### C. 「最近一次 success」这个坑**确实会咬到我**，已修

`[实测 2026-08-08]` 最近一次 `conclusion: success` 的 build-bundles run
**`31249135458` 只有 `bundle-darwin-arm64` 一个产物**（另外两条腿 skipped 也算 success）。
我的自动选取原本就是"取最近一次 success" —— 留空跑的话，linux/win 会死在
"artifact 不存在"，而那个错误**读起来像"我的腿坏了"**。

判据改成**这条腿要的那个产物在不在**，而不是"那一轮绿不绿"：往回最多找 15 次，
逐个查 artifacts 列表，命中即用；找不到就如实说找不到，**不拿残缺的 run 凑数**。
（Manager 说这条已派给 build-bundles 的主人从源头修 —— 我这条是消费侧的兜底，
两边不冲突：即使上游修好了，"我要的产物在不在"仍然是这条腿该自己确认的事。）

### D. 脚手架：没再撞到问题；`unzip || tar` 我属于"有"的那一档

我这条腿**走共享的 `scripts/ci/resolve-bundle.mjs`**，而它内部已经是
`unzip` → 失败回退 `tar` 的两级（并对两者都挂了 `spawnSync` 的 timeout）。
所以 Manager 问的"四条腿里两条有两条没有、没有的只是运气好"——**我这条现在是有的**，
而且不是我自己写了一份，是共享那一份带的。

本轮实测三平台的脚手架输出，**没有撞到任何新问题**：

```
win  : 归档 …win-x64.zip（51405797 B）→ 解开：unzip -q … → ✔ app/daemon/dist/main.js ✔ runtime/node.exe
linux: 归档 …linux-x64.tar.xz（43038116 B）→ 解开：tar -xJf … → ✔ app/daemon/dist/main.js ✔ runtime/node
```

Windows 上 `unzip` 这次是在的（Git Bash 带），所以**回退分支本轮没有被执行到** ——
也就是说"回退真的能用"这一条我**没有验到**，标 `[未验证]`。
（要真验它得在没有 `unzip` 的环境里跑，本轮不具备。）

⚠️ 我给共享脚手架**加了一个参数没有改它的代码**：`--require-node-runtime`。
脚手架自己写明"要 `runtime/node` 的腿自己加，我不替它们猜"，而我这条腿确实用包自带的
Node，所以补上了。**`resolve-bundle.mjs` 本身一个字没动。**

### E. 门禁

| 门禁 | 结果 |
| --- | --- |
| `pnpm -r test` | ✅ **1577 / fail 0**（基线 1558；+19 来自并行 agent，我没加测试） |
| `tsc -b` | ✅ 0 |
| `build:safe` | ✅ 0 |
| `test:ci-scripts` | ✅ 0 |
| `lint-workflows` | ✅ 1177 条断言全过（13 个 workflow） |
| `check:orphans` | ✅ 没有新的零引用导出，基线没过期 |
| `eslint` / `format:check`（我的文件） | ✅ 通过 |

本轮我只动了自己的两个文件（`.github/workflows/e2e-import.yml`、
`scripts/ci/e2e-import-audit.mjs`）。**没有碰** `resolve-bundle.mjs`、`build-bundle.mjs`、
`build-bundles.yml`，也没有碰另外三路的文件。

---

## [2026-08-08 22:10] e2e-import(发布前闸门) DONE

交付:

- `scripts/ci/emit-e2e-attestation.mjs`（新）—— 发凭证
- `scripts/ci/verify-e2e-attestation.mjs`（新）—— 发布前闸门
- `.github/workflows/e2e-import.yml` —— 本腿新增 `attest` job
- `.github/workflows/release-upload.yml` —— 新增 `e2e-gate` job，`upload` needs 它
- `docs/design/D-17-prebuilt-bundles.md` §11 —— 把那条性质本身写下来
- 提交 `91f6168`

要点:

- 凭证放在**e2e 腿这一侧**，判定落在 **artifact 名字**上（与 `bundles-complete` 同形）。
- 消费方是 `release-upload.yml` 的 `e2e-gate` job —— **不过闸就没有上传这回事**。
- **不建议**每次 build-bundles 都跑四条腿，依据见 §C。
- 反向验证 7 条全部实测通过（§D）。
- ⚠️ **现在四条腿里只有 import 接上了**（我只能改自己的 workflow）。闸门因此对
  v0.3.0 那批包**正确地拒绝**，并把缺的三条点名 + 打出要加的步骤原文（§E）。

需要 Manager 决策: 另外三条腿各加一个 job（约 15 行）由谁来加 —— 我没动他们的文件。

### A. 凭证放在哪一侧、长什么样

**放在每条 e2e 腿自己的 run 里**，是一个 artifact：

```
名字：e2e-attest-<leg>-<bundleRunId>      ← 判定本身
内容：{ leg, bundleRunId, platforms[], e2eRunId, e2eCommit, emittedAt }  ← 只供事后审计
```

三条设计依据：

1. **判定落在名字上，不在内容上。** 消费方不下载、不解析、不需要相信文件里写了什么。
   一个需要读内容才能判定的凭证，迟早会有人读错。
   （与 `bundles-complete` 同一形状同一理由：PROTOCOL §11「绿灯必须能追溯到
   **这次 run 真的产出的东西**」，而 artifact 就是那个东西本身。）
2. **名字里带 `bundleRunId` ⇒ 换一批包就是另一个名字，旧凭证自动失效。**
   这正是事故里缺的那一环：在此之前，「跑过 e2e」是一个**没有宾语**的句子。
3. **发凭证的 job `needs:` 全部平台且不带任何 `if:`。** 任一平台失败或被跳过 →
   该 job 被跳过 → **凭证根本不存在**。"部分跑"的 run 里不会出现半真的凭证。

### B. 消费方怎么问

**不用问 —— 问不到就发不出去。** 闸门是 `release-upload.yml` 里的 `e2e-gate` job，
而 `upload`（全仓唯一有 `contents: write` 的 job）`needs: [e2e-gate]`：

- 先看 `run_id` 里有没有 `bundle-*` / `bundles-complete` 产物；
  **不是包**就明说"这批不是包，本项判定不适用"并放行
  （静默跳过的闸门等于没有闸门 —— 所以它会把这句话打出来）。
- 是包 → 跑 `verify-e2e-attestation.mjs --bundle-run <run_id>`，
  四条腿的凭证不齐就 exit 1，`upload` 根本不会开始。

手工也能问（不改任何东西，只读）：

```bash
GH_TOKEN=… GITHUB_REPOSITORY=faorcoek042/openmemo \
  node scripts/ci/verify-e2e-attestation.mjs --bundle-run <build-bundles run id>
```

**缺省是拒绝**：查不到、查不动（API 报错）、腿名对不上 —— 一律拒绝。
这道闸存在的全部理由就是挡住"没人记得去跑"，而"没人记得"在数据上的样子恰恰是"查不到"。

### C. 该不该每次 build-bundles 都自动跑四条腿 —— **我判断不该**

依据三条：

1. **多数 build-bundles 跑不是为了发布**（调试打包脚本、`legs=linux` 单腿、
   验证某个平台的构建）。四条腿 × 三平台是十几个 job，每条腿还要真下几百 MB 后端
   并真跑转写 —— 绝大多数开销买不到任何判断。
2. **「发布前」与「每次构建」是两个不同的时机。** 要挡的是"发出去的东西没验过"，
   不是"构建过的东西没验过"。挂错时机会让闸门既昂贵又不精确。
3. 昂贵而多数时候无意义的门禁，最终会被人用参数绕开 —— **那时它就变成一条被删掉的
   守卫**，正是本仓反复吃亏的形状（"一条永远红/永远烦的守卫等于没有守卫"）。

**正确形状：构建随便跑，发布必须查。** 闸门在发布那一侧，且不可绕过。

### D. 反向验证（全部本机实测）

| # | 造的情形 | 期望 | 实测 |
| - | -------- | ---- | ---- |
| 1 | 一批**从没跑过四条腿**的包（31248640972） | 拒绝 | ✅ exit 1，4/4 条腿点名 |
| 2 | `--bundle-run` 非纯数字 | 拒绝 | ✅ exit 1 |
| 3 | 腿名对不上（`e2e-ghostleg`，API 404） | 拒绝 | ✅ exit 1，"查不动"也算拒绝 |
| 4 | 发凭证侧：`--leg` 缺失 | exit 1 且**不写文件** | ✅ 文件不存在 |
| 5 | 发凭证侧：`--bundle-run` 带空格 | exit 1 且不写文件 | ✅ 文件不存在 |
| 6 | 发凭证侧：`--platforms` 为空 | exit 1 且不写文件 | ✅ 文件不存在 |
| 7 | **正向**：本腿对 31253583769 跑绿并发了凭证 | 放行 | ✅ exit 0 |

第 5 条不是凑数：`bundleRunId` 会**拼进 artifact 名字**，带一个空格就会生成
一个消费方**永远问不到**的名字 —— 那条腿看起来"发过凭证了"，闸门却永远说没有。
这是本轮最容易做出来的一种假通过，所以在发凭证那一侧就拒掉。

### E. 现状：四条腿里只有 `import` 接上了（如实报）

我只能改自己的 workflow，所以现在：

```
import    ✔ e2e-attest-import-31253583769（来自 e2e-import.yml run 31258300507）
notes     ✘ 没找到 e2e-attest-notes-31253583769
record    ✘ 没找到 e2e-attest-record-31253583769
runtime   ✘ 没找到 e2e-attest-runtime-31253583769
✘ **拒绝发布**：3/4 条腿没有对这批包的凭证。
```

**这不是闸门坏了，这就是它要拦的那件事** —— 它对 `v0.3.0` 那批包的回答是"没验全"，
而那正是事实（另外三条腿确实没对这批包发过凭证）。

顺带：我**对 v0.3.0 实际发出去的那批包**（build-bundles run **31253583769**）
补跑了一遍本腿 —— run **31258300507**，三平台全绿，凭证已发。
所以 import 这一格现在对已发布的 v0.3.0 是**有据可查**的。

另外三条腿接上只需在各自 workflow 末尾加一个 job（闸门失败时会把这段原样打出来）：

```yaml
attest:
  needs: [<矩阵 job 名>] # 不带任何 if: —— 任一平台失败/跳过 → 凭证不存在
  steps:
    - run: node scripts/ci/emit-e2e-attestation.mjs --leg <notes|record|runtime> \
             --bundle-run "${{ needs.<job>.outputs.bundle_run_id }}" \
             --platforms linux-x64,darwin-arm64,win32-x64 --out dist/e2e-attest.json
    - uses: actions/upload-artifact@v6
      with:
        name: e2e-attest-<leg>-${{ needs.<job>.outputs.bundle_run_id }}
        path: dist/e2e-attest.json
        if-no-files-found: error
```

（需要各腿把实际用到的 bundle run id 抬成 job output，我这条腿是
`outputs: { bundle_run_id: steps.bundle.outputs.run_id }`。）

### F. 门禁

`pnpm -r test` **1578 / fail 0**（基线 1577）、`tsc -b` 0、`build:safe` 0、
`test:ci-scripts` 0、`lint-workflows` **1228 条断言全过**、`check:orphans` 干净、
`eslint` / `format:check`（我的文件）通过。

按 PROTOCOL §12 提交：`git commit -- <pathspec>`（新文件先 `git add -N`），
**提交后**用 `git show --stat` 复核 —— 恰好 5 个文件，全是我的。

---

## [2026-08-09 01:20] e2e-import(接完四条腿 + 补齐 v0.3.0) DONE

交付: `.github/workflows/e2e-{notes,record,runtime}.yml`（各加 attest job）、
`scripts/ci/verify-e2e-attestation.mjs`（抖动重试 + 逐腿触发提示）。
提交 `fcce6e3`、`387b7d9`。

要点:

- **闸门现在对 `v0.3.0` 那批包放行**（build-bundles run `31253583769`，四条腿凭证齐全）。
- `e2e-notes` 两种模式：**只有发布审计模式发凭证**，与 Manager 判断一致（§B）。
- **选了重跑，不补发** —— 补发会让凭证不再等于"这条腿真的跑过这批包"（§C）。
- 三条腿的改动**全是纯新增、零删除**（53/53/55 行），没碰它们的断言/矩阵/其它。
- 顺带修掉闸门自己的一个抖动缺陷和一句会把人送进 422 的提示（§D）。

需要 Manager 决策: 无。

### A. 闸门对 v0.3.0 那批的最终答案：**放行**

```
import    ✔ e2e-attest-import-31253583769（来自 e2e-import.yml   run 31258300507）
notes     ✔ e2e-attest-notes-31253583769（来自 e2e-notes.yml     run 31258972781）
record    ✔ e2e-attest-record-31253583769（来自 e2e-record.yml   run 31258974214）
runtime   ✔ e2e-attest-runtime-31253583769（来自 e2e-runtime.yml run 31258975830）
✔ 四条腿都对 build-bundles run 31253583769 跑绿过 —— 这批包可以发。   （exit 0）
```

对照：一批没验过的包（`31248640972`）仍然 **exit 1**，四条腿逐条点名。

### B. `e2e-notes` 两种模式怎么处理 —— **只有发布审计模式发凭证**（同意 Manager）

`assembleFromSource=true`（默认）跑的是**本次 checkout 现场组装**的包。
那是**回归门禁**：它证明的是"当前代码组装出来的东西好"。

它**不能给一批已发布的包背书**，理由不是保守，是**两者根本不是同一堆字节**：
包里有 Node 运行时、web bundle、SQLite 扩展、各平台原生模块，
现场组装与发布产物之间隔着一整条 `build-bundles` 流水线（还有 glibc 地板守卫、
部署目标守卫、归档/解档）。拿前者的绿去发后者的凭证，等于让闸门相信一件它没验过的事
—— 而这个闸门存在的**全部理由**就是挡住这种"看起来验过了"。

所以 `attest` 上挂 `if: ${{ !inputs.assembleFromSource }}`。

同一条判据在另外两条腿上的对应物（形状不同，逻辑同源）：

| 腿 | 只有这种情况才发凭证 | 为什么 |
| --- | --- | --- |
| `e2e-notes` | `assembleFromSource=false` | 现场组装 ≠ 已发布的那堆字节 |
| `e2e-record` | `legs=all` | 它能只跑一个平台；那种 run 里 `needs` 照样成功，发三平台凭证就是假话 |
| `e2e-runtime` | `bundleSource=artifact` | 同 notes：`checkout` 模式是回归门禁 |
| `e2e-import` | （无模式开关，恒三平台） | — |

⚠️ **三处 `if:` 管的都是「模式」，不是「结果」。** 结果由 `needs:` 管住
（GitHub 对带 `needs` 的 job 默认要求 needs 全 success，普通布尔表达式**不会**解除它）。
注释里写明：**永远不要改成 `always()` / `!cancelled()`** —— 那会解除该要求，
于是"部分跑"也能发凭证，而那正是本机制要挡的事。

### C. 补凭证 vs 重跑：**选了重跑**

判据是 Manager 给的那句：「如果补发凭证意味着'凭证不再等于这条腿真的跑过这批包'，
那就重跑」。**它确实意味着。**

- artifact **不能事后塞进一个已完成的 run**。所谓"补发"只能是从**另一个 run**
  （或本机）造一张同名凭证传上去。
- 那样一来，凭证与"真的跑过测试的那次执行"之间的绑定就断了 ——
  凭证存在，而产出它的那次 run 什么都没验。**这正是 §11 要挡的假通过**，
  由本机制自己制造出来就更荒唐。

所以三条腿都**对着同一批包（`31253583769`）真跑了一遍**，三平台全绿后由各自的
`attest` job 发凭证。四个 run 号见 §A。
（`e2e-import` 上一轮已经这么做过：run `31258300507`。）

### D. 顺带修掉的两个缺陷（都是这一轮实测撞出来的）

**① 闸门自己会抖。** 第一次问 v0.3.0 那批时 `record` 那格拿到
`net/http: TLS handshake timeout`，闸门**拒绝了一批其实已经验全的包**。

拒绝本身没错（"我没问到"决不能渲染成"它没问题"），但：

> 一道会因为网络抖动随机变红的闸门，会训练所有人「先重跑一次再说」——
> 而那正是「学会忽略它」的第一步。

与本仓那条「一条永远红的守卫等于一条被删掉的守卫」同族，**这是它的抖动版**：
不是永远红，是随机红，后果一样。修法是两件事同时成立：
传输层失败重试 3 次吸收抖动；**重试用尽仍失败照旧拒绝**。
HTTP 4xx **不重试** —— 那不是抖动，那就是答案（例如"这条腿的 workflow 不存在"）。

**② 闸门给的补救命令会把人送进 422。** 拒绝时原本打一句通用的
`-f bundleRunId=…`，而四条腿的输入各不相同（`assembleFromSource` /
`legs=all` / **`bundlesRunId` 多一个 s**）。**一句会 422 的提示比不给提示更糟：
它让人以为是闸门坏了。** 改成逐腿登记，实测四条命令各自正确。

### E. 授权边界

Manager 授权范围是"在三条腿里各加 attest job，别动别的"。实际改动：

```
.github/workflows/e2e-notes.yml   | 53 +++++  （纯新增，0 删除）
.github/workflows/e2e-record.yml  | 53 +++++  （纯新增，0 删除）
.github/workflows/e2e-runtime.yml | 55 +++++  （纯新增，0 删除）
```

两处例外要报备（都是 attest 必需的最小改动，不是"别的东西"）：

- `e2e-notes` 的 `e2e` job、`e2e-runtime` 的 `audit` job 各加了一个 `outputs:`
  （把实际用到的 bundle run id 抬到 job 级）。**不这么做就只能在 attest 里重新
  `resolve-bundle-run.sh` 一次，而那可能解析到另一次 run** —— 绑定就断了。
- `e2e-record` **一行都没改它原有的 job**：它的 `bundleRunId` 必填无默认，
  输入本身就是权威值，所以 attest 直接绑输入。**没有给它加默认值**（作者的理由成立）。

`D-17` 本轮**没有再碰**（Manager 说有人在动）。

### F. 门禁

`pnpm -r test` **1589 / fail 0**（基线 1578）、`tsc -b` 0、`build:safe` 0、
`test:ci-scripts` 0、`lint-workflows` **1292 条断言全过**、`check:orphans` 干净、
`eslint` / `format:check`（我的文件）通过。

⚠️ 全树 `format:check` 我最后一次检查时红在 `docs/DEPLOYMENT.md` 与
`docs/design/D-03-download-and-model-api.md` —— **那是另外两位正在动的文档**，
我没有碰（`pnpm format` 会 `--write` 整棵树并塞进共享索引）。

---

## [2026-08-09 05:30] e2e-import(四条腿改走启动器) DONE + 1 条阻塞缺陷

交付: `scripts/ci/launcher-spawn.mjs`（新）、`scripts/ci/selftest-launcher-path.mjs`（新）、
四条腿脚本、`package.json`（挂守卫）。提交 `0ad3b09`。

要点:

- **四条腿都真的从启动器起了**（`main.js` 在四个文件的**可执行代码里出现 0 次**）。
- **探针修复在启动器路径上实测生效**：`cpu available=true probed=true`（§C）。
- ⚠️ **查出一条阻塞缺陷：双击之后「组件目录是空的」** —— 用户装不了任何组件（§D）。
  它**不归我改**（在 `build-bundle.mjs` / `manifests.ts`），但它会让四条腿现在全红。
- 守卫反向验证 3 个变异全红、还原全绿（§B）。

需要 Manager 决策: §D 那条派给谁修 —— 修好之前四条腿对**包**跑不绿。

### A. 四条腿是不是都真的从启动器起了

是。共享模块 `launcher-spawn.mjs` 是**唯一**起 daemon 的入口，它**不接受调用方传
daemon 入口**，只收 `bundleDir`。源码树回退也收进模块内部，于是**腿的源码里
一次都不会出现入口路径** —— "别再直接起 main.js"从一条要记住的纪律，
变成一件做不到的事。

```
腿                        可执行代码里的 main.js    import 共享模块
e2e-import-audit.mjs              0                    ✔
e2e-notes-audit.mjs               0                    ✔
e2e-record.mjs                    0                    ✔
e2e-runtime-audit.mjs             0                    ✔
```

四条腿都**不再预设** `OPENMEMO_WEB_DIST` / `OPENMEMO_EXT_DIR` /
`OPENMEMO_BUNDLED_PROBE_DIR` —— 预设了就等于"看起来在走启动器"而实际又架空一次，
`assertNoLauncherOverrides()` 会当场拦下。
变异验证要**显式**写 `allowLauncherOverrides: true` 才放行（`e2e-notes` 那条
"把 EXT_DIR 指到空目录证明中文检索会红"正需要它）——那五个字就是它在申明"我是故意的"。

### B. 三平台收尾（§11：按 pid 收整棵树，绝不 pkill -f）

**统一意图是对的，统一拼写是错的** —— 启动器形状不同，收法就不同：

| 平台 | 启动器最后一行 | pid 是谁 | 收法 |
| --- | --- | --- | --- |
| Linux / macOS | `exec "$DIR/runtime/node" dist/main.js "$@"` | **就是 daemon**（exec 换掉了 shell） | `detached:true` 自成组 + `kill(-pid, SIGTERM)` |
| Windows | `"%DIR%runtime\node.exe" dist\main.js %*`（批处理**没有 exec**） | **cmd.exe**，node.exe 是它的子进程 | `taskkill /PID <pid> /T /F` |

`[本机实测]` POSIX 上 `health.pid === proc.pid`（41815 等多次一致），**exec 的推理成立**。
Windows 上因此**不能比 pid**（会把一次正确的启动判成"别人的 daemon"），改比
`dataDir` —— 它是本轮 `mkdtemp` 出来的唯一路径，别的 daemon 报不出同一个。
`[未验证]` Windows 的 taskkill 收尾本轮**没有在真 Windows 上跑过**（见 §E）。

**守卫**（`selftest-launcher-path.mjs`，已挂进 `test:ci-scripts`）：
**先剥注释**只看可执行代码 —— 这几个文件的注释里大量出现 `main.js`，因为它们
正是在解释"为什么不再直接起它"；一条会把解释文字当成违规的守卫，
会逼人把解释删掉，那是在惩罚说清楚的人。断言只涉及**符号在不在**：

反向验证（隔离副本）：

| 变异 | 结果 |
| --- | --- |
| 对照组 | ✔ 21 条断言全过 |
| 腿里重新写出入口路径 | **红**（指出是哪一行） |
| 腿不再 import 共享模块 | **红** |
| 共享模块少一个平台的启动器拼写 | **红** |
| 还原 | ✔ 全绿 |

### C. 探针修复在启动器路径上：**实测生效**（这是这条改动值不值的唯一证据）

先复现了 D-17 §11 那条性质：拿 `v0.3.0` 的包（build run `31253583769`，sha `aa92cba3`）
试，`probeExists=false` —— 因为那个包**早于**探针修复 `5413369`（`merge-base` 判定）。
**包比修复旧，不是修复不生效。**

于是从当前 master 重新出包（build-bundles run **`31263239505`**，sha `d941d133`），
包里确实多了 `runtime/probe`。走**启动器**起，`[Linux 本机实测]`：

```
probe: ran=true ok=true probeExists=true devicesFound=1
       path=<bundle>/runtime/probe/openmemo-probe   ← 正是启动器设的 BUNDLED_PROBE_DIR
   cuda     available=false probed=false  backend package not installed
   vulkan   available=false probed=false  backend package not installed
   ...
   cpu      available=true  probed=true
```

**`cpu available=true probed=true` —— 就是要的那一行。**
对照：同一个包**旧口径**（直接起入口、不设该变量）报的是
`probe did not complete: probe executable not found` —— 六个后端全红。

⚠️ **只在 Linux 上实测**。macOS / Windows 标 `[未验证]`，原因见 §E。

### D. ⚠️ 查出的真实缺陷：**双击之后「组件目录是空的」**（阻塞）

这正是"走启动器"立刻换来的东西 —— 旧口径**结构上看不见**它。

`[实测]` 走启动器起 v0.3.0 的包：

```
backends catalog packs = 0        ← 设置→组件 页面是空的
models  catalog groups = 0
```

根因（逐步验过，不是推断）——`apps/daemon/src/http/rest/manifests.ts:92` 的
`resolveManifestDir()` 三级回退：

1. `OPENMEMO_MANIFEST_DIR` —— 启动器**没设**，包里也没人设
2. 模块相对 `<bundle>/vendor/manifests` —— **包里根本没有 `vendor/`**
   （`ls` 只有 LICENSE / READ-ME-FIRST.txt / THIRD-PARTY-NOTICES / app / ext / runtime / start.sh）
3. `process.cwd()/vendor/manifests` —— 启动器 `cd "$DIR/app/daemon"`，
   于是指向 `<bundle>/app/daemon/vendor/manifests`，**也不存在**

→ 空目录。

**为什么 CI 一直没看见**：旧口径直接起入口，`cwd` 是**仓库检出**，
而那里 `vendor/manifests` **存在** —— 第 3 级回退恰好命中，**把这个 bug 完整地掩盖了**。
这就是"CI 直接起 main.js"这个盲区的实际代价。

**反证**（确定根因，不是猜）：同一个包、同样走启动器，只额外给
`OPENMEMO_MANIFEST_DIR=<真的 manifests 目录>` →

```
packs = 25     （从 0 变 25）
```

**用户后果**：双击打开 → 设置→组件 里一个包都没有 → 装不了 ffmpeg / whisper / yt-dlp
→ 转写、导入全都用不了。与"CI 没经历过空数据目录 → 装不了组件"同一族，
但这次是**更早一步**：连目录都看不到。

**修法建议**（我**没有动**，`build-bundle.mjs` 与产品代码都不是我的）：
把 `vendor/manifests` 随包出厂（放到包根，第 2 级回退就命中），
或让启动器设 `OPENMEMO_MANIFEST_DIR`。**前者更好**：第 2 级是模块相对的，
不依赖 cwd，也就不会再被"从哪儿启动"影响。

⚠️ **在它修好之前，四条腿对着包跑不绿** —— 它们现在会诚实地红在"必需的后端包没装上"。
那不是腿坏了，是腿终于看见了。

### E. 没做到 / 未验证（如实列）

- **三平台 CI 实跑没做**：本轮把预算用在了定位 §D 那条根因上。四条腿现在会红在 §D，
  跑 CI 只会得到一片"必需的包没装上"，**证明不了启动器那一段**。
  修好 §D 之后再跑才有意义。标 `[未验证]`：macOS / Windows 的启动器路径、
  Windows 的 `taskkill /T` 收尾、macOS quarantine 那一段。
- **本机只验了 Linux**（`start.sh`）：pid 相同、按组收尾、探针生效、目录为空 —— 四条都实测。
- `pnpm -r test` 本轮在 `apps/web` 处 bail（6 红，全在 `/diagnostics` 那组），
  而 `apps/web` 有**另一位未提交的改动**（i18n locales / ReadinessBanner / RuntimePage）。
  **我一个字都没碰 apps/web**；我改的四条腿所属的包全部 fail 0。
  基线 1593 因此本轮**没有量到**，标 `[未验证]`。
- `tsc -b` 0、`build:safe` 0、`lint-workflows` 1399、`check:orphans` 干净、
  `test:ci-scripts` 0（含新守卫）、我的文件 `eslint`/`format:check` 通过。

---

## [2026-08-09 09:40] e2e-import(脏树提示) DONE

交付: `scripts/dirty-tree-notice.mjs`（新）、`scripts/check-test-scripts.mjs`、
`package.json`。提交 `659347a`。

要点:

- 挂**三处**，依据是"`pnpm -r` 不含 workspace root"这一条实测事实（§A）。
- 干净树**输出 0 字节**；脏树列文件 + 两个方向都说；两侧 exit 均 0（§B）。
- 给 `pnpm -r test` 增加约 **254 ms**（实测，非估算，§C）。
- 提交前它就**当场证明了自己**：`test:ci-scripts` 的红是别人在飞的改动（§D）。

需要 Manager 决策: 无。

### A. 挂在哪三处，为什么不是更多也不是更少

**先量再挂**。`[实测]` `pnpm -r check:version` 回的是
`Scope: 9 of 10 workspace projects` / `None of the selected packages has ...` ——
**`pnpm -r` 不含 workspace root**。也就是说 root 的 `package.json`
**在结构上没有任何办法**给 `pnpm -r test` 挂前置步骤，而那恰恰是最常跑的一条。

| 挂点 | 覆盖的命令 | 依据 |
| --- | --- | --- |
| `scripts/check-test-scripts.mjs` | **`pnpm -r test`** | `[实测]` 9 个含测试的包里 **8 个**的 test 脚本都调它（只有 `@openmemo/web` 不调），是 `-r test` 唯一必经的一处 |
| root `check`（前 + 后） | `pnpm check` | 它是 root 脚本，`&&` 链能挂前后各一次 |
| root `test:ci-scripts`（前 + 后） | `pnpm test:ci-scripts` | 同上；Manager 问的"是不是同病"——是，它同样会被在途改动带红 |

**没挂**的：`build` / `build:safe` / `lint` / `format:check` / `typecheck`。
理由是它们不产出"绿了就能对 master 下结论"的判断 —— 挂上去只是噪音，
而噪音会让这条提示更快被忽略。

⚠️ 已知缺口（如实标）：单独跑 `pnpm --filter @openmemo/web test` 不会出声
（web 的 test 脚本不调 `check-test-scripts.mjs`）。**不修**：它从不单独构成一次
`-r` 跑，为它去改第 10 个 package.json 的收益不抵改动面。标 `[已知不覆盖]`。

**尾部那一次（`--after`）只在全绿时才跑** —— `&&` 链天然如此，而那正好是
"绿了也别误判"该出现的时机。⚠️ `pnpm -r test` 那条**没有**尾部提示：
root 挂不上去（同上），所以两个方向的话都写进了**前置**那一段。这是结构限制，不是遗漏。

### B. 两侧真实输出

**脏树**（本机当时 7 处在途改动）：

```
──────────────────────────────────────────────────────────────────────────────
  ⚠️ 工作区不干净：7 处未提交改动。**本次测的不是 master。**
──────────────────────────────────────────────────────────────────────────────
      M README.md
      M docs/DEPLOYMENT.md
      M package.json
      ...
  本次测的是 **master ∪ 上面这些未提交改动** —— 一个从来没有存在过的组合，
  没有任何人承诺过它是绿的。所以：
     · **红了** → 先看那些改动，不要直接归因于 master（有人为此派错过工）。
     · **绿了** → 也**不能**据此说 master 是绿的：你验的不是它。

  要对 master 下结论，按 PROTOCOL §12 在隔离 worktree 上检出你自己那个 commit 再跑。
──────────────────────────────────────────────────────────────────────────────
```

**干净树**（隔离 worktree `git worktree add`，未提交改动 0 处）：

```
输出字节数: 0      exit=0
```

**两侧退出码都是 0。** 它永远不会让任何命令变红 —— 树脏是常态不是故障，
做成红门禁就是本仓那条「一条永远红的守卫等于一条被删掉的守卫」。
连它自己抛异常也被 try/catch 吞掉：一个"提醒你别误判"的东西，
绝不能反过来变成别人排查的噪音源。

### C. 耗时（**实测，每个数都是量出来的**）

先解决"会打 9 遍"：`[实测]` 同一次 `pnpm -r` 里 9 个包看到的 `process.ppid`
**完全相同**（都是 `98087`，因为都由同一个 pnpm 进程拉起）。用 ppid 当键写一个
**零字节**标记文件 ⇒ 同一次调用只打一遍；不同调用 ppid 不同，**并发的两个人不会互相吞掉**。

两处优化，也都量过：

- **去重检查放在 `git status` 之前** —— 否则后 8 次白付一遍 33.6 ms。
- **做成可 import 的函数而不是只有 CLI** —— 省掉 8 次 node 进程启动。

| 项 | 中位耗时 |
| --- | --- |
| `git status --porcelain` 单独 | **33.6 ms** |
| `check-test-scripts.mjs` 基线（摘掉提示） | **56.3 ms** |
| 同上 · 首次（含 git status） | **123.2 ms**（+66.9） |
| 同上 · 已去重 | **79.7 ms**（+23.4） |
| 已去重时函数本身 | **0.004 ms** |

→ 对 `pnpm -r test` 的总增量 ≈ **66.9 + 8 × 23.4 ≈ 254 ms**，
即一条约 5 分钟命令的 **~0.08%**。**无网络调用。**

去重实测：`pnpm -r exec` 跑 9 个包 → `工作区不干净` 只出现 **1 次**。

### D. 它在提交前就证明了自己（不是我编的场景）

跑门禁时 `pnpm test:ci-scripts` 红了：

```
✘ DEPLOYMENT §1.3 目录条数
   在 docs/DEPLOYMENT.md 里找不到声明值 —— 是不是被改写了？
```

按老习惯，这一红很容易被读成"master 坏了"。而提示同时打出的文件列表里就有
`M docs/DEPLOYMENT.md`、`M scripts/ci/check-doc-freshness.mjs` ——
**那是文档那一路正在改的东西**（Manager 说的"另有一路在改文档"，他们中途回来了）。
`[核实]` 我一个字都没碰 `docs/`。

这正是它要挡的那次事故的**同一形状**，而这次**当场就说清了**。

### E. 门禁

`tsc -b` 0、`build:safe` 0、`lint-workflows` 1399、`check:orphans` 干净、
我的三个文件 `eslint` / `format:check` 通过。

⚠️ `pnpm test:ci-scripts` 与 `pnpm -r test` 本轮**没有量到干净的基线**：
工作区里有文档那一路的在途改动（见 §D），按我自己新加的这条提示 ——
**在那里红不能归因于 master，在那里绿也不能证明 master 绿**。
所以基线 1600 标 `[未验证]`，不假称量过。
（这条腿自己就该是第一个遵守它的。）

---

## 2026-09-06 · 抽判据时抓到的四条空转，**全修了**（Manager 裁决）

#98 把这条腿从「结构上不可测」变成可测时，抓到四条「把修法抽掉它也不红」，
当时一条都没改、各留一个会说话的桩。裁决是**四条全修**，理由逐字：
它们**每一条都正好是「判据和它声称守的东西对不上」**。

| # | 空转 | 修成什么样 |
|---|---|---|
| ① | `media.ready` 收不到 ⇒ 只 `say` 不 `fail`，`ok` 保持 true ⇒ 总表「✔ 通过」 | **第三态**（不是 `fail` —— 收不到可能是真未决）：进 `undecideds`、进 `--undecided-out` 计数、总表那行改 ⊘ |
| ② | `adapterId` 被测量、被打印，**从来不进判决** | `checkFetchedByYtdlp()`：断**哪个适配器**，不是"有没有人来取"（DirectHttp 去取也让 `fixtureHits` 涨） |
| ③ | `ffmpeg 不在 storeRoot` —— (a) 结构上不可能红 + (b) 真响起来那天说假话 | (b) `isUnderRoot()` 照 `isWithinImportRoots` 原修法；(a) 判据改吃 **realpath 之后**的路径 |
| ④ | 文档列的七格里，Content-Type 与 `416 + Content-Range` **只在注释里存在** | 两格都补上。⚠️ 产品两处**都做对了**（`media.ts` 逐字发了），是守卫没在看 |

`--undecided` 从写死改成真管道（六条腿现在都在这条管道上）。

### 🔴 待办：**这一轮的修法一次都没在真 runner 上跑过**

这条腿要预编译包 + 真装几百 MB 后端 + 真跑 5～6 次转写，本地跑不了，
而它只在 `schedule` 与 `workflow_dispatch` 时跑。

⇒ **下一次 `workflow_dispatch`（钉 `bundleRunId`）时重点看三件事**：

1. **②** `adapterId` 是不是真的稳定回 `yt-dlp`。这一轮把它接进了判决 ——
   如果 registry 的 fallback 链在某个平台上落到别处，F1 会**当场红**。
   那正是设计（链变了必须有人知道），但第一次跑要有人在场判断
   「是链真的变了」还是「我把期望写窄了」。
2. **④** 四种容器的 `Content-Type` 是不是逐字等于扩展名判出来的那个。
   `[CI 实测 run 31247374404]` 说三平台 × 四容器全部正确，但那是**在这一格被补上之前**
   量的；现在它是判据，第一次跑才算真的验过。
3. **①** `media.ready` 在三个平台上到底收不收得到。凭证里的 `undecided`
   从今天起是个**真数**：它不是 0 的话，说明那条 SSE 在某台 runner 上没按时到。

⚠️ **在那之前，本轮的判决只覆盖到「纯函数判据 + 接线」这一层**
（`selftest-e2e-import.mjs` 207 条、`leg-coverage --leg import` 17/20）。
端到端那一层是 `[未验证]`，别当成验过了。

### 核过、**不立条目**的一条

`hasVideo` 是不是"没有真实生产者的契约字段"（裁决里问的那句）—— **有真生产者**：
`apps/daemon/src/jobs/runners/transcribe.ts` 的 `hasVideo: result.media.audioOnly === false`，
而 `audioOnly` 来自适配器**实际探到**的流信息
（`localFile.ts` / `directHttp.ts` 里 `probed.streams.every((s) => s.type !== 'video')`，走 ffprobe）。
它**曾经**是写死的 `false`，后来被改成真值 —— 而那次改动没被判成"零读者可以删"，
靠的就是本腿这一格。⇒ 产品侧没有欠账，不立条目。
