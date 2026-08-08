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
