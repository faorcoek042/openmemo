# inbox / readme-trim

## [2026-08-06 22:40] T-158 DONE —— README 砍到 100 行

交付:

- `README.md`（**312 → 100 行**，19 个标题 → 7 个）
- `docs/DEPLOYMENT.md`（**634 → 759 行**：砍下来的东西全部挪进去了，另修了三处）
- 本回执

---

# TL;DR

| #   | 事                         | 结果                                                                                                                               |
| --- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| ①   | 行数                       | **312 → 100**（-68%）。标题层级 **19 → 7**                                                                                         |
| ②   | 第一屏                     | 前 18 行 = 这是什么（3 行）+ 能不能在你机器上跑（平台表 + 判据）；`## 快速开始` 落在**第 19 行**                                   |
| ③   | 「这份 README 的写法」整节 | ✅ **删了**（元评论）。它记的「187 条断言 113 条不成立」在 `coordination/inbox/debt-cleanup.md` §1 有原始记录，没丢                |
| ④   | 「已知不支持」             | ✅ **留在 README**，压成 5 行表 + 3 行下限提示（原来 40 行）                                                                       |
| ⑤   | 许可证                     | ✅ **4 行**（原 50 行）：本仓一句 + GPL 硬阻断一句 + 指向 `DEPLOYMENT.md` 附录 A / `pnpm license:report`                           |
| ⑥   | 砍掉的内容                 | ✅ **没有一条是直接删的**，全部挪进 `DEPLOYMENT.md`（§0 / §1.3 / §1.4 / §5 / §8.3 / 附录 A / 附录 B）。**唯一一条真的没挪的见 §4** |
| ⑦   | 改完自己再跑一遍快速开始   | ✅ **跑了**（临时数据目录 + 端口 18821）。**跑出一条 README 原文的假话**，见下                                                     |

**最重要的一条**：原 README 写「**默认监听 `0.0.0.0`**、鉴权默认关闭」——
`[读码 apps/daemon/src/bootstrap/single-instance.ts:32]` `BIND_HOST = process.env['OPENMEMO_HOST'] || '127.0.0.1'`，
**代码默认是 `127.0.0.1`**，而同一轮交付的 `DEPLOYMENT.md` §2.2 写的正是 `127.0.0.1`
—— **两份文档互相矛盾，而 README 那半是错的**。新 README 改成「绑定地址默认 `127.0.0.1`，
一旦设成 `0.0.0.0`，任何能路由到该 `IP:端口` 的人都能读写你全部的笔记」。
（`docs/SECURITY.md` 说的「当前默认绑 `0.0.0.0`」描述的是**这台机器上那个显式设了环境变量的部署实例**，
不是仓库默认；那是它的领地，**我没有改它** —— 见 §5 需要 Manager 决策。）

---

# §1 我实际跑了什么（判据，不是流水账）

全部在 `/tmp/readme-trim/` 下的临时数据目录，指针文件用 `OPENMEMO_POINTER_FILE` 重定向到 `/tmp`
（PROTOCOL §9-bis：不是"写完记得擦"，是根本不写那个全局位置）。端口 **18821**，跑完 `kill -TERM`。

| 步骤（README 里的原话）                                                           | 结果                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm build:safe`                                                                 | ✅ 8 个包全 Done，`build-info: 935f9d7f @ 2026-08-06T21:39:14+08:00`                                                                                                                                                                                                                                   |
| 网页 bundle（`vite build --outDir /tmp/readme-trim/webdist`，PROTOCOL §7 的正解） | ✅ 成功；`OPENMEMO_WEB_DIST` 托管 → `GET /` **200 / 3555 B / `<title>OpenMemo</title>`**                                                                                                                                                                                                               |
| 起 daemon（全新临时 dataDir）                                                     | ✅ 启动横幅原文「流水线缺少工具: whisper-cli, asr-model —— 相关任务会转 blocked」，正是 README 那句"否则转写会转成 blocked"的出处                                                                                                                                                                      |
| 冷启动自检                                                                        | ✅ `GET /api/selfcheck` **25 条**，`{ok:7, warn:13, fail:5}`，fail 是 `tool.whisperCli / model.asr / ext.chineseSearch / engine.select.zh / engine.select.en`                                                                                                                                          |
| **网页装组件**（`POST /api/backends/install {"id":…}`）                           | ✅ `sqlite-vec-linux-x64` + `libsimple-linux-x64` 两个 job `succeeded`                                                                                                                                                                                                                                 |
| 安装接口字段名（前一轮踩过的坑）                                                  | ✅ **复现了**：`{"packId":…}` → `400 BAD_REQUEST / 缺少后端包 id`。已写进 `DEPLOYMENT.md` §5                                                                                                                                                                                                           |
| 「装完页面会提示重启」                                                            | ✅ `health.restartRequired.required = true`，文案「中文分词器已安装，需重启生效」                                                                                                                                                                                                                      |
| **网页触发自我重启**（`POST /api/daemon/restart`）                                | ✅ 202，pid `3530938 → 3536876`；`tokenizer` `trigram → simple`，`libsimple`/`sqliteVec` 双 true                                                                                                                                                                                                       |
| 装完自检                                                                          | ✅ `{ok:11, warn:10, fail:4}`；`ext.chineseSearch = ok 用户:1 推特:1 中国:1 服务:1`（与文档里的数字逐字符相同）                                                                                                                                                                                        |
| 「5 / 22 个包适用」这个数字                                                       | ✅ `GET /api/backends/catalog` → **22 个包，5 个 applicable**，正好是 `whispercpp-cpu / media-tools / ytdlp / libsimple / sqlite-vec`                                                                                                                                                                  |
| 「`/components` 与 `/diagnostics` 不在侧栏」                                      | ✅ `[读码 App.tsx:56-69]` 侧栏 7 项；入口是 `RuntimePage.tsx:146` 与 `common/ReadinessBanner.tsx:228`（README 写的"就绪横幅"就是它）                                                                                                                                                                   |
| 「只有 `--port` / `--data-dir` 两个旗标」                                         | ✅ `[读码 main.ts:1062-1064]` 只 `indexOf('--port')` 与 `indexOf('--data-dir')`；`grep -rn OPENMEMO_PORT apps packages scripts` → **0 命中**                                                                                                                                                           |
| 「`pnpm typecheck` 不产出网页」                                                   | ✅ `apps/web/tsconfig.json:13` `emitDeclarationOnly: true`；`build:safe` 的 filter 是 `!@openmemo/web`                                                                                                                                                                                                 |
| 「HANDOFF 那句已过期」                                                            | ✅ 仍然过期：`HANDOFF.md:110` 还写着 `"build": "tsc -b"`，而根 `package.json` 是 `pnpm -r build`                                                                                                                                                                                                       |
| 许可证清单（附录 A 每个数字）                                                     | ✅ 现读 manifests：`backends.json` 11 包 + `sqlite-ext.json` 11 包 = **22**；GPL 的是 media-tools(3) 与 ytdlp(4)，yt-dlp 钉的是 `engineVersion 2026.07.04`；模型 25 + 5 + 5 条的 license 字段逐个数过；`git submodule status` 确认 v1.9.1 / v1.13.4 / v0.1.9 / v0.7.1；根目录**确实没有 LICENSE 文件** |

**没跑的（如实）**，三条：

1. `pnpm install` —— 会动 `node_modules`，而 `progress-audit` 可能同时在跑 `pnpm -r test`。CI 每次都跑这一步。
2. `pnpm -r build` —— 含 `vite build`，PROTOCOL §7 禁止。验的是它的两个等价片段（`build:safe` + `vite build --outDir /tmp`）。
3. **装转写引擎与拉 ASR 模型** —— `whispercpp-cpu-linux-x64` 的安装被权限闸门拦下
   （判定为逼近"不要在本机跑 whisper"这条用户边界），我**没有绕过**，因此本轮也没有拉 `asr/whisper-tiny-q5_1`。
   这两步是**上一轮 `docs-public` 跑通并记录的**，我沿用它的结论，没有声称是自己验的。
   **本机一次真实转写都没有跑。**

---

# §2 砍了什么、挪到哪（逐条可核对）

| README 原节（行数）                                                    | 去向                                                                                                                                                           |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 「这份 README 的写法」（16 行）                                        | 🗑 **删除**。证据标记表挪进 `DEPLOYMENT.md` 文件头（并改成自包含，不再写"与 README 同一套"）；「187/113」那段项目史**没有挪**，见 §4                            |
| 「数据去哪了」（20 行，含出网三件事 + LLM 那条）                       | → `DEPLOYMENT.md` **§0 数据放在哪、什么会出网**（一字不减，含 ADR-016 原话与 `llm.tier1` 的 warn 原文）。README 保留压缩版两条                                 |
| 「现在真的能做什么」平台表 + 5 个工具 + 108 字符 + 中文命中数（22 行） | → `DEPLOYMENT.md` **§1.3**（表加了两列，把 CI 的 2.1s/3.6s/106.1s 与"两组对照"一起收进去）。README 只留 4 行平台表 + 2 行判据                                  |
| F1–F5 表（9 行，含 F1 的 `[报告]` 标注与那个 `--max-downloads` bug）   | → `DEPLOYMENT.md` **§1.4**（新增小节，逐字保留）                                                                                                               |
| 「章程要求 2.1/2.2」整节（32 行）                                      | → 与 `DEPLOYMENT.md` **§5** 完全重合（页面表 + 安装链 HTTP 日志 + 自检 25 条），**属于重复段落，不再复述**。README 只留快速开始里的两步与 `/components` 那条坑 |
| 「这几步的证据」表（10 行）                                            | → 拆进 `DEPLOYMENT.md` 文件头（"本机从未跑过一次真实转写"那条边界）与 §5                                                                                       |
| 诚实一节 5 个子标题（60 行）                                           | → `DEPLOYMENT.md` §1.3「明确不支持」表 + §1.3 CUDA 段 + §8.3（ANE：新增"产物这一半是好的"）+ §5（代码签名）。README 压成 5 行表 + 3 行下限提示                 |
| 许可证整节（50 行）                                                    | → `DEPLOYMENT.md` **附录 A**（三类表全在，含 GPL 与 license-report 两个偏差的说明）。README 留 4 行                                                            |
| 仓库结构（12 行）                                                      | → `DEPLOYMENT.md` **附录 B**                                                                                                                                   |

**判据**：`README.md` 里今天写的每一条，`DEPLOYMENT.md` 里都能找到它的出处与边界；
砍掉的每一条，要么在 `DEPLOYMENT.md` 里，要么在 §4 里被点名。

---

# §3 顺手清掉的（`DEPLOYMENT.md` 自身，任务书点名要看的）

| 位置                    | 问题                                                                                    | 处置                                                         |
| ----------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| §7.3                    | 写着「完整卸载 = **三步**」，底下列了 **4** 条                                          | 改成「四步」                                                 |
| §1.2② 末尾的 blockquote | 与 §8.8 讲的是同一件事（`GGML_BACKEND_DL=ON` 下 `dlopen` 失败不算错误），整段重复       | 压成两行 + 「展开见 §8.8」                                   |
| §1.2①②、附录 A          | `` `[CI 实测，解包读 `LC_BUILD_VERSION`]` `` 这类**嵌套反引号**在 Markdown 里会渲染错位 | 改成 `**[CI 实测]**（…）`                                    |
| 文件头                  | 「本文档里出现最多的一个词是……」是关于文档自己的元评论                                  | 改写成实质陈述（故障的共同形状），并把证据标记表补全成自包含 |

---

# §4 ⛔ 我砍掉、但**没能挪走**的（唯一一条）

**「这份 README 在文档上栽过跟头」那段项目史** —— 原文：一次逐条复核发现 187 条文档断言里
113 条已不成立，其中最贵的一类是"文档写着没做、代码其实做了"。

- **为什么不挪**：它既不是部署信息（放 `DEPLOYMENT.md` 是错位），也不是给用户看的
  （README 的读者是想跑这个东西的人，不是想了解我们工程史的人）。任务书也明确说元评论不该进 README。
- **它没有丢**：原始记录在 `coordination/inbox/debt-cleanup.md` §1（「核了 187 条，113 条已不成立」），
  比 README 里那两句详细得多。
- **我认为它值得留在某处**：最合适的位置是 `HANDOFF.md`（"哪些坑别再踩"），
  但那不是我的交付物，**没动**。要不要加由 Manager 定。

另外**一并砍掉、我认为可以不再要**的两条（列出来供复核）：
① 「`[未验证]` 这个词在本文出现了很多次，那是故意的」—— 这句关于文档自身的话我挪进了
`DEPLOYMENT.md` 文件头的标记说明里（那里它是使用说明，不是自我评论）；
② 「仓库里没有二进制，最大已跟踪文件 255 KB」—— 挪进附录 B，README 里不再提（读者不关心）。

---

# §5 需要 Manager 决策（2 条）

1. 🔴 **`docs/SECURITY.md` 与代码/`DEPLOYMENT.md` 就"默认绑定地址"不一致。**
   - `SECURITY.md:25 / :36 / :59 / :238` 说「daemon **默认监听 `0.0.0.0`**」；
   - `[读码 single-instance.ts:32]` 仓库默认是 **`127.0.0.1`**，只有显式设 `OPENMEMO_HOST` 才变。
   - 我的判断：SECURITY 描述的是**这台机器上那个部署实例**（它显式设了环境变量），
     用词是「默认」造成了歧义 —— 一个新用户 `git clone` 之后拿到的是 `127.0.0.1`。
   - **我没有改 SECURITY.md**（不是我的交付物，PROTOCOL §1）。建议改成「本部署实例绑 `0.0.0.0`（显式配置）」。
     README 现在写的是按代码来的那一版。
2. `.gitmodules` 文件头那条已过期的 `ffmpeg-static` 注释 —— `docs-public` §3.4 已经报过，**至今没改**。
   我同样没动（仓库根目录、构建配置，非我交付物）。

---

# §6 纪律

| 条                                                                  | 结果                                                                                                                                                                    |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `:10000` 只读                                                       | ✅ **一个请求都没发**；pid `3478074` 全程未变，端口未被占用/重启/kill                                                                                                   |
| `/root/data-memo`                                                   | ✅ 未读未写，mtime 仍是 `2026-08-06 18:17:11`                                                                                                                           |
| 全局指针 `~/.local/share/openmemo/datadir.json`                     | ✅ sha256 `7f930979…0da233f3`、mtime `2026-08-04 01:06:59`，与 `docs-public` 记录的**逐字符相同**；我起的实例一律 `OPENMEMO_POINTER_FILE=/tmp/readme-trim/pointer.json` |
| `apps/web/dist`                                                     | ✅ 未被覆盖，`index.html` mtime 仍是 `2026-08-06 18:17:06`。**没跑过一次 `pnpm -r build` / 裸 `vite build`**，验证一律 `--outDir /tmp/readme-trim/webdist`              |
| `pkill -f`                                                          | ✅ 未用。停自己的实例用 `kill -TERM <pid>`，pid 取自 `GET /api/health`                                                                                                  |
| 本机 whisper 转写                                                   | ✅ **一次都没跑**；连转写引擎包与 ASR 模型都**没有安装**（见 §1 第 3 条）                                                                                               |
| release / 仓库设置 / 分支                                           | ✅ 一个都没碰（`gh` 一次都没敲）                                                                                                                                        |
| `BOARD.md` / `ROSTER.md` / `docs/adr/**` / `00-CHARTER.md`          | ✅ 只读。要改的写进本回执 §5，没自己动手                                                                                                                                |
| `HANDOFF.md` / `docs/SECURITY.md` / `docs/design/**` / `.github/**` | ✅ 只读引用，一个字没改                                                                                                                                                 |
| 代码 / 测试                                                         | ✅ 一行没动（本轮是纯文档改动，基线 1138/0 不受影响）                                                                                                                   |
| `git add`                                                           | ✅ **逐个文件、零 `-A`**，add 后用 `git diff --cached --name-only` 核对过（见下）                                                                                       |
| 起过的服务                                                          | 端口 **18821**（临时 dataDir），已 `kill -TERM` 释放                                                                                                                    |
| 临时文件                                                            | `/tmp/readme-trim/`（仓库外），只留日志备查                                                                                                                             |
