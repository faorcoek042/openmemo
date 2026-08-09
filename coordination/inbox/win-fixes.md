# inbox / win-fixes

## [2026-08-06 03:05] T-147 SHARED-CHANGE（申报，改动 2 行）

**要碰的文件**：`vendor/manifests/sqlite-ext.json`（`pack-publish` 的领地）
**改什么**：`libsimple-win32-x64` 与 `libsimple-win32-arm64` 两个包的
`providesFiles`，`"libsimple.dll"` → `"simple.dll"`。**只有这两行，别的一个字不动。**

**为什么非碰不可**：那两行**描述了一个不存在的文件**。
`[实测]` 把清单里那三个 URL 下下来 unzip（sha256 与清单逐字一致）：

```
libsimple-linux-ubuntu-22.04.zip → libsimple-linux-ubuntu-22.04/libsimple.so
libsimple-osx-arm64.zip          → libsimple-osx-arm64/libsimple.dylib
libsimple-windows-x64.zip        → libsimple-windows-x64/simple.dll   ← 没有 lib 前缀
```

Windows 的 zip 里**没有 `libsimple.dll` 这个文件**。这条错误声明和产品代码里
`libsimple${suffix}` 那行是同一个错误的两处显形，正是 Windows 上
`libsimple=false / tokenizer=trigram`（中文双字词搜不到、零报错）的成因。
改完之后清单变成"上游归档真实提供什么"，并被 `packages/pipeline` 的
`extensions.test.ts` 与代码的查找候选逐条对表 —— 任何一侧再漂移就当场红。

**冲突面**：`providesFiles` 全仓**没有任何运行期消费方**
（grep：只有 schema 定义 + `ytdlpInstall.test.ts` 的断言 + `emit-pack-manifest.mjs` 生成端，
而 `emit-pack-manifest` 只产出 backends 的 fragment，不写这份文件）。
`verify-offline.mjs` 读这份文件但只看 `linkInto` / `installPath`。
所以对 `pack-publish` 正在做的 ffmpeg/whisper 平台包**没有交集**（不同 pack、不同字段）。

**如果 `pack-publish` 有异议**：把这两行改回去不会让 Windows 重新变坏（代码两个名字都找），
只会让上面那条对表守卫变松。

---

## [2026-08-06 04:20] T-147 DONE

交付（全部已 push 到 master）:

- `98bcdf8` 产品修复：`packages/pipeline/src/tools.ts` 新增 `sqliteExtensionSources()`
- `80212c4` `packages/runtime/src/{assetPaths,selfcheck}.test.ts`（CI 实测那 5 条）
- `0588091` `packages/pipeline/src/subprocess/__tests__/argGuard.test.ts`、
  `packages/pipeline/src/media/__tests__/ytdlpRemoval.test.ts`、
  `apps/daemon/src/pipeline/ytdlpInstall.test.ts`、`apps/daemon/src/storage/migrateRecords.test.ts`、
  `scripts/check-tracked-sources.mjs`
- `d53ecfc` `apps/daemon/src/{bootstrap/entrypoint,http/upload,storage/restart-datadir}.test.ts`
- `11b4c71` `apps/daemon/src/testPorts.test.ts`

未碰: `vendor/manifests/`（申报了 SHARED-CHANGE 但**没有擅自改**，见上一条）、
`.github/workflows/`、`/root/data-memo`、`:10000`（一次都没碰）、`~/.local/share/openmemo/datadir.json`。
没跑 `pnpm -r build`、没用 `pkill -f`、没跑本地 whisper 转写。
四次推送前都 `git status` 对过在途改动，全部用 `git commit -- <明确路径>`，零 `git add -A`
（期间 `pack-publish` 正在改 `vendor/manifests/` 与 `.github/workflows/`，它的改动一次都没被我带上）。

---

# TL;DR

## ① Windows 上 libsimple 装成功却不加载 —— **不是加载问题，是名字问题**

**你列的五个猜测方向（动态库加载路径 / `.dll` 后缀 / VC 运行时 / 路径分隔符 /
SQLite 扩展在 Windows 上的额外要求）——** `[实测]` **一个都不是。**

真因：**上游 Windows 包里那个文件不叫 `libsimple.dll`，叫 `simple.dll`。**
把清单里那三个 URL 下下来 unzip（sha256 与清单逐字一致）：

```
libsimple-linux-ubuntu-22.04.zip → libsimple-linux-ubuntu-22.04/libsimple.so
libsimple-osx-arm64.zip          → libsimple-osx-arm64/libsimple.dylib
libsimple-windows-x64.zip        → libsimple-windows-x64/simple.dll   ← MSVC 不加 lib 前缀
```

而 `materializeSqliteExtensions` 按 `libsimple${suffix}` 拼名字去找 →
Windows 上永远找不到 → `bin/ext` 里没有它 → `文件不存在` → 静默降级 trigram。
`sqlite-vec` 三个平台都叫 `vec0.<后缀>`，所以它一直是好的 —— **那个不对称本身就是线索。**

**★ CI 实测的前后对照（同一个 workflow、同一份脚本）：**

```
修复前（ci-runner，上一版）  [warm] tokenizer=trigram  libsimple=false  sqliteVec=true
修复后（run 31037371404）    [warm] tokenizer=simple   libsimple=true   sqliteVec=true
                             ext.chineseSearch  ok  required=true  用户:1 推特:2 中国:1 服务:2
                             ext.jiebaDict      ok      ext.sqliteVec  ok  v0.1.9
```

**判据用的就是你要的那条**（`ext.chineseSearch` 四个双字词真的命中），不是"文件下下来了"。

顺带排掉两条会让人白忙的猜测（都是实测，不是推理）：

- **入口点没问题**：SQLite 无显式入口点时从文件名推 —— 去目录、跳过 `lib`、取到第一个 `.`
  之前的字母。`simple.dll` 与 `libsimple.dll` **都推出 `sqlite3_simple_init`**，
  而那是该 DLL 唯一的 `sqlite3_*` 导出（PE 导出表 2623 个导出，匹配 `sqlite3*` 的只有这一个）。
  所以"拷过去顺便改个名"是安全的 —— **但只对这两个名字安全**，改成别的当场加载不了。
- **路径分隔符没问题**：`sqlite3.c` 的 `DirSep(X)` 在 `SQLITE_OS_WIN` 下同时认 `/` 和 `\`。

⚠️ **一条我没法验、但必须写下来的**：`simple.dll` 依赖
`MSVCP140.dll` / `VCRUNTIME140.dll` / `VCRUNTIME140_1.dll`（PE 导入表实测）——
即 **VC++ 2015-2022 运行时**。GitHub 的 Windows runner 一定装了；**普通用户的机器不一定**。
node.exe 自己是静态链接 CRT 的，所以"能跑 daemon"不代表"能加载这个 DLL"。
按 D-11 §3.4 的判据（runner 上"能做到"不等于用户机器上"能做到"），
这条标 `[未验证：需一台干净的 Windows]`。真缺的时候症状与本次**完全一样**
（`tokenizer=trigram`、零报错），只是 `failures.libsimple` 会是加载错误而不是"文件不存在"。

**反向验证（本机，Linux）**：把 win32 的候选改回只有 `libsimple.dll` → **5 条当场红**
（`[win32] 汇到同一个 bin/ext` / `包里叫 simple.dll` / `win32 拷贝分支` /
`win32 必须去找 simple.dll` / `三个平台归档里的真实文件名`）；改回来 → 18/18 绿。
**这个 Windows bug 现在在这台 Linux 开发机上就能抓到。**

★ 旧的那份 T-093 回归测试**在 Windows 上一直是绿的**，因为 fixture 和产品代码
犯的是同一个错（都按 `libsimple${suffix}` 拼）。现在 fixture 用的是上游归档里的**真实文件名**。

## ② 那 6 条 —— **"6" 是被截断的计数，真实是 14 条**

`pnpm -r test` **遇到第一个失败的包就 bail**。D-11 §3.3 那张表只覆盖到 bail 那一刻，
`packages/pipeline` / `apps/daemon` 在非 Linux 上**一条都没轮到过**。
每修好一层，CI 就往前走一层，露出下一层：

| 轮次                | win32                                             | darwin                             |
| ------------------- | ------------------------------------------------- | ---------------------------------- |
| 起点（ci-runner）   | runtime 5 红，后面全没跑                          | pipeline 1 红（已由 ci-runner 修） |
| 修完 runtime        | runtime 47/47 ✅ → **pipeline 露出 5 红**         | runtime ✅ → pipeline 1 红         |
| 修完 pipeline       | pipeline 162/162 ✅ → **daemon 露出 3 红**        | pipeline ✅ → daemon 1 红          |
| 修完 daemon 那 3 条 | **daemon 又露出 2 红**（upload 415 + 端口扫描器） | **全绿**                           |

**14 条逐条定性**（真·宿主假设 12 / 允许 skip 1 / 真产品问题 1）：

| #   | 文件                                     | 定性                                                                                                | 修法                                                                      |
| --- | ---------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1-3 | `runtime/assetPaths`                     | 宿主假设：期望值写死 `'/d/media/a.wav'`                                                             | 根用 `resolve('/d')`、期望值用 `join()`；另加一条"候选必须用本平台分隔符" |
| 4-5 | `runtime/selfcheck`                      | 宿主假设：借 `/usr/bin/env` 当"一定存在的可执行文件"                                                | 自己造一个真文件；另加一条 fail 档把"没找到"与"借来的"分开                |
| 6-7 | `pipeline/ytdlpRemoval`                  | 宿主假设：`ffmpeg/ytDlp` 写死 `'/bin/sh'`（注释原文「/bin/sh always is」）                          | 改 `process.execPath` —— 按构造每个平台都有                               |
| 8   | `argGuard` 软链逃逸                      | 宿主假设：软链到 `/etc`，**而且失败被 `.catch` 吞了**                                               | 自己造根外目标 + 断言前置条件真的成立                                     |
| 9   | `argGuard` 根内软链出界                  | 宿主假设：`/etc/hostname` **macOS 上不存在** → 悬空链 → 词法回退 → 落回根内 → 守卫（正确地）不拦    | 同上                                                                      |
| 10  | `argGuard` UNC-under-posix               | 宿主假设：调用**强制** posix 规则，期望值却用宿主 `join()` 重拼（win32 的 join 会把反斜杠规范化掉） | 改成钉结构 + 一条反向用例（否则"放行一切"也满足）                         |
| 11  | `daemon/entrypoint` 对照组               | 宿主假设：路径写死 `/opt/...`，Windows 上 `pathToFileURL` 会补盘符 → **连对照组都失配**             | 用本平台形状造路径；并把对照命题换成各平台都真的更强版本                  |
| 12  | `daemon/restart-datadir`                 | 宿主假设：`readFileSync(pointer).includes(decoy)` —— JSON 会转义反斜杠                              | 解析 JSON 比字段（顺带更强）                                              |
| 13  | `daemon/testPorts`                       | **不是平台问题，是 CRLF**（见下）                                                                   | `split(/\r?\n/)` + 路径归一                                               |
| 14  | `daemon/upload` 413/415                  | 🔴 **真产品问题**，见下面「单独报给你」                                                             | **没修产品**，只把测试改成"只为那个真原因红"                              |
| —   | `ytdlpInstall`「没有可执行位就不算找到」 | **允许 skip**：Windows 上根本不存在"没有可执行位"这个状态                                           | 见下「唯一一条 skip」                                                     |

**第 13 条值得单独看**：它红的原因是 **git 在 Windows 上默认 `core.autocrlf=true`**，
扫描器 `split('\n')` 给每行留了 `\r`，而形态正则以 `(?:\/\/.*)?$` 收尾 ——
`.` 不匹配 `\r`、`$` 又要求到串尾，于是**带行尾注释的行整个归不了类**。本机复现：

```
CRLF（只按 \n 切）   rhs="19_700 + Math.floor(Math.random() * 10); // 同上"   认得出形态B: false
LF（按 \r?\n 切）    rhs="19_700 + Math.floor(Math.random() * 10)"           认得出形态B: true
```

**与平台无关**：任何人在 CRLF 检出的仓库里跑都会红。
👍 而它坏的时候**是出声的**——因为那个文件的文件头立过规矩「归不了类就当场红」。
换成"看不懂就跳过"，它会静默漏掉三段端口然后一直绿。

**唯一一条 skip，理由可检验**（`ytdlpInstall`「没有可执行位就不算找到」）：
Windows 上**不存在**"没有可执行位"这个状态 —— D-11 §3.1 实测 `chmod(0o755)` 读回来是 `666`、
`access(X_OK)` 对任何可读文件恒真（`installer.ts:283-284` 跳过 chmod 的理由正是这条）。
所以那儿不是 `return` 了事，而是**把这个前提本身钉住**：
断言 `access(X_OK)` 不抛、并且它必然"找得到"。**哪天 Windows 认可执行位了，这条会红，
上面那段"理由"当场被推翻，而不是继续被下一个人当真。**
（`extensions.test.ts` 里那条"造悬空软链"的 skip 同理：Windows 上造不出前置条件，
且注明了替代覆盖是哪条。）

## ③ 顺手闭合的一条：`pnpm check:sources` 在 Windows 上**从来没守过任何东西**

它调宿主 `find`，而 Windows 上解析到的是 `System32\find.exe`（文本搜索工具）→
catch → 返回 `[]` → 「✘ 没找到任何源码目录」→ 步骤红。改用 Node 走目录 +
`git check-ignore --stdin`（顺带避开 Windows 32KB 命令行上限）。

- 本机口径与旧 `find` **一致**：95 个目录。
- 反向验证（**在 /tmp 造的一次性仓库里做，仓库里没留任何状态**）：
  `.gitignore` 写 `models/` → exit 1 并精确指出 `apps/web/src/features/models`（事故原形）。
- `[CI 实测]` win32：`✔ 95 个源码目录均未被 .gitignore 匹配` —— 与 Linux 同一个数。

⚠️ **对 `.github/workflows/` 的连带影响（我没改，请 ci-runner / Manager 处置）**：
`ci-crossplatform.yml:99` 那一步现在名字叫
「Tracked-sources guard (**预期在 Windows 上红** —— 见 T-141 §3 第 30 条)」，
而它已经绿了。**一个描述得很具体的过期名字比没有名字更能误导人**
（与 ci-runner 那条「ci.yml 不许自动 push 触发」是同一形状：守卫该改，不是该删）。

---

# 🔴 单独报给你：一条真产品问题（不是测试的错）

**Windows 上，早退 4xx 之后客户端读不到我们刚写出去的那条响应。**

```
[CI 实测] ci-crossplatform run 31039060738，win32/x64（间歇性，同一条用例上一轮是绿的）
  not ok - 扩展名不在白名单 → 415，且不留任何文件      error: 'read ECONNRESET'
  not ok - 超出上限 → 413（…），半成品被删除            error: 'read ECONNRESET'
```

- 注意是 **`read` ECONNRESET**，不是 write —— **响应根本没被收到**，不是收到了之后连接才断。
- `upload.ts:797-806` 的注释说明产品**知道**这个风险并做了缓解：
  `Connection: close` + `req.resume()` 丢弃剩余请求体 + 2 秒兜底 destroy，
  注释原话「不能直接 destroy socket：内核接收缓冲里还有未读数据时 close 会发 RST，
  **客户端可能连我们刚写出去的 413 都读不到**（经典的"上传超限却报 ECONNRESET"）」。
  **那套缓解在 Linux/macOS 上有效，在 Windows 上会漏。**
- 用户可见后果：Windows 上传超大或不支持的文件，界面**很可能显示"网络错误"而不是
  "文件超过上限"** —— 一条正确的产品拒绝，被显示成一个假的故障。
- **我没有改产品代码**：这条在安全相关的早退路径上，改法（何时关 socket / 要不要 linger）
  是设计决定，不该由我顺手动。
- 我改的是**测试的记账方式**：以前它在 `write EPIPE` 上就崩了（**一条断言都没跑到**，
  红得没有信息量）；现在「响应头已到手就按响应结算」，于是它**只会为那个真原因红** ——
  即"客户端确实没拿到响应"。反向验证：把产品的 413 改成 400 → 该用例当场红；改回 → 17/17 绿。
- ⚠️ **我刻意没让测试接受 ECONNRESET**。那样它会变绿，而用户看到的仍然是"网络错误" ——
  正是本仓最贵的那类假绿。`ci-crossplatform` 是探针 workflow（D-11 §2.3 刻意与门禁分开），
  **让它为一条真问题红着是它存在的意义。**

# 🟡 另外三条观察（不紧急，但写下来免得日后当成"已验证"）

1. **`apps/daemon/src/pipeline/modelStore.ts:230`** `resolveExtensionDir` 只认
   `libsimple.so` / `libsimple.dylib`，**没有 `.dll`**。它只是 `materializeSqliteExtensions`
   一个都没链上时的兜底，所以今天不影响结果；但注意**光加 `.dll` 也修不好**它 ——
   Windows 包里那个 dll 还多嵌一层，那个判断在结构上就落不到实处。
2. **安装记录里的 `relPath` 用的是本平台分隔符**（`relative()` 的产物，读写两侧一致，
   今天不是 bug）。含义：**一份数据目录不能跨操作系统搬。**没有任何地方声称它能，
   写在这里是因为 `migrateAssets.ts` 那边**是**做了分隔符归一的 —— 两处约定不同。
3. **`cold-start-audit` 的对照组那一轮打印 `[warm] tokenizer=undefined`**
   （屏蔽组是正常的 `simple/true/true`，且两组的 `ext.chineseSearch` 都是 ok）。
   看起来是 ci-runner 那个脚本第二轮的日志解析问题，不是产品问题。
   `[未定性]`，我没有动它的脚本。

# 诚实边界（每条结论的证据级别）

| 结论                                                               | 级别                                                                       |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Windows 上 `ext.chineseSearch = ok（用户:1 推特:2 中国:1 服务:2）` | **CI 实测**（run 31037371404，win32-x64）                                  |
| 上游三个 zip 里的真实文件名                                        | **实测**（下载 + sha256 与清单一致 + unzip 列表）                          |
| `simple.dll` 只导出 `sqlite3_simple_init`、依赖 VC 运行时          | **实测**（PE 导出/导入表）                                                 |
| SQLite 从文件名推入口点、`DirSep` 认反斜杠                         | **读码**（better-sqlite3 13.0.2 内置 sqlite3.c，行号已写进注释）           |
| 拆掉修复 → 5 条红                                                  | **本机实测**（先 grep 确认坏行在即将运行的产物里，跑完已还原并复验 18/18） |
| runtime / pipeline / web 在 win32+darwin 全绿                      | **CI 实测**（run 31038276704 / 31039060738）                               |
| upload 413/415 在 Windows 上读不到响应                             | **CI 实测**，但**间歇性**（同一条用例两轮结果不同）                        |
| `simple.dll` 在没装 VC 运行时的机器上能否加载                      | **未验证：需一台干净的 Windows**                                           |
| `modelStore.ts` 那条兜底的实际后果                                 | **读码推断**，未构造场景验证                                               |

需要 Manager 决策:

1. **`vendor/manifests/sqlite-ext.json` 那两行要不要改成 `simple.dll`**（SHARED-CHANGE 已申报，
   **我没动**）。不改也不会让 Windows 重新变坏（代码两个名字都找），只是清单继续说着一件
   归档里不存在的事。
2. **upload 早退响应在 Windows 上读不到** —— 谁来修？这是 `apps/daemon/src/http/upload.ts`
   的设计问题，且在安全相关的早退路径上。
3. **`ci-crossplatform.yml:99` 那一步的名字已经过期**（写着"预期在 Windows 上红"，现在绿了）。
   我按边界没碰 workflow。

下一步建议:

1. 等 run 31039891282（我推的最后一版）出结果 —— 预期 win32 只剩 upload 那 2 条真问题。
2. `cold-start-audit` 在 Windows 上重跑一次（`pack-publish` 的 Windows ffmpeg 包已进 master），
   `tool.ffmpeg/ffprobe` 那两条 required fail 应该会一起消掉。
3. CRLF 那条建议扫一遍同类：仓库里所有"读源码文本再用正则判断"的守卫
   （`scripts/*.mjs` 里有好几个）。我只修了撞上的那一个。

---

## [2026-08-06 04:45] T-147 —— 最后一轮 CI 结果（run 31039891282，commit `11b4c71`）

```
linux-x64 (control)  success
win32-x64            success   ← ★ 本仓第一次 Windows 全绿
darwin-arm64         failure   ← 只剩 upload 413 那一条，且是**间歇性**的
```

**win32 全绿的明细**（`Test` 步骤逐包）：
`llm 18/18 · db 47/47 · mindmap 42/42 · runtime 47/47 · pipeline 162/162 ·
web 94+10+202 · daemon 278/278` —— 加上 `check:sources ✔ 95` 与 typecheck，
**win32-x64 这个 job 从头到尾没有一处红。**

**唯一剩下的那条，两轮的表现正好相反 —— 这本身就是证据：**

| 轮次        | win32                                    | darwin                         |
| ----------- | ---------------------------------------- | ------------------------------ |
| 31039060738 | upload 415 + 413 红（`read ECONNRESET`） | 全绿                           |
| 31039891282 | **全绿**                                 | upload 413 红（`write EPIPE`） |

同一条用例、同一份代码，两个平台各红过一次、也各绿过一次，
而 **linux 从来没红过**。这排除了"某个平台的固定差异"，指向上面那条产品问题的
真实形状：**早退 4xx 的连接收尾是一场竞速，Linux 上稳赢，非 Linux 上不一定。**

⚠️ **我没有把它改绿。** 让测试接受 `ECONNRESET`/`EPIPE` 会让这条永远绿，
而用户在 Windows/macOS 上仍然会看到"网络错误"而不是"文件超过上限" ——
那正是本仓最贵的那类假绿。`ci-crossplatform` 是探针 workflow，
**为一条真问题间歇性地红着，是它存在的意义。**

（另：`apps/daemon` 的用例数 273 → 278，多出来的 5 条里有我加的
`selfcheck` fail 档 1 条与 `assetPaths` 分隔符 1 条，其余来自并发的 `pack-publish`。）

---

## [2026-08-06 05:10] T-147 —— 三条决策的执行结果

### ③ `ci-crossplatform.yml:99` 的过期步骤名 → **已改**（`75e662a`，已 push）

```
旧  Tracked-sources guard (预期在 Windows 上红 —— 见 T-141 §3 第 30 条)
新  Tracked-sources guard (三平台都应为绿 —— T-141 §3 第 30 条已由 T-147 修复)
```

只动了步骤名与上面那段注释，`run:` 一个字没动。注释里写清了**为什么这句被改**
（它曾经是对的、现在不是了；留着会让下一个人以为这里的红是正常的，从而不去查一个真的红）。
动之前确认 `pack-publish` 不在同一文件里：它改的是 `cold-start-audit.yml`，
`ci-crossplatform.yml` 上一次改动是 `0d4536b`（ci-runner / T-145）。
`pnpm test:ci-scripts` 15+14 全过（含 `lint-workflows` 那组守卫）。

顺带把 `extensions.test.ts` 里关于清单的那段说明改成**当前**状态
（原文写着"待裁定"，而你已经裁定了）—— 同一条理由：**一条过期的说明也是错的说明。**

### ① `sqlite-ext.json` 那两行 → **我改不了，原样交给你或 `pack-publish`**

**结论先说：改动内容在下面，一行不差，谁有权限谁执行。**

我按你说的两条路都试了：

1. **跟 `pack-publish` 协调** —— `SendMessage` 返回
   `No agent named 'pack-publish' is reachable`。它是你的 agent、不是我的 teammate，
   我够不着它，协调只能走 inbox 文件（异步，它不一定会读我的）。
2. **直接改** —— **权限层拦了两次**，理由是「`vendor/manifests/` 是 pack-publish 的
   活跃领地，而它无法验证边界是否真的被解除」。**这个拦截是对的**，我没有绕。

我做过的非重叠核对（供你判断，不构成授权）：

- `sqlite-ext.json` 自 `1b4df88`（T-097）起**没有任何人动过**；
- `pack-publish` 的 T-146 改的是 `backends.json` / `components.json`（`2075a88`）；
- 它回执里写的下一步是「release 批下来后补 **macOS whisper 的两条 manifest**」——
  那是 `backends.json`，与这两行零重叠。

**要执行的改动（全部，就这两处）：**

```
vendor/manifests/sqlite-ext.json
  packs[id="libsimple-win32-x64"].providesFiles    ["libsimple.dll"] → ["simple.dll"]
  packs[id="libsimple-win32-arm64"].providesFiles  ["libsimple.dll"] → ["simple.dll"]
```

一条命令（在仓库根跑，带自检，改错会当场断）：

```bash
python3 - <<'EOF'
p='vendor/manifests/sqlite-ext.json'
s=open(p,encoding='utf-8').read()
assert s.count('"libsimple.dll"')==2, s.count('"libsimple.dll"')   # 只有那两处
open(p,'w',encoding='utf-8').write(s.replace('"libsimple.dll"','"simple.dll"'))
EOF
```

**执行后不需要改任何测试**：`packages/pipeline` 那条清单对表守卫两种读法都接受
（`simple.dll` 本来就在查找候选里）。执行前后 `pnpm -r test` 都应是绿的。
**也不会让 Windows 重新变坏** —— 产品代码两个名字都找；变的只是清单不再描述一个不存在的文件。

⚠️ 如果最后决定**不改**，请把 `extensions.test.ts:323` 那段说明一起改掉 ——
它现在写着"Manager 已裁定改成 simple.dll，尚未执行"。**留着它就又造出一条过期说明。**

### ② upload 早退那条 → **不派人，已记进清单**

收到，理由我认同（间歇性、有明确症状、不阻断功能，而 `vad-fix` T-148 是
"三个平台没有一个能完成转写"）。我不动它。**测试保持严格**：
它现在只会为那个真原因红（客户端确实没拿到响应），不会因为记账问题红。

---

## 你收进 HANDOFF 的那两条，我这边的原始材料

**「测试和被测代码共享同一个错误假设时，测试不会失败——它会确认那个错误。」**
原始形态在 `packages/pipeline/src/__tests__/extensions.test.ts`：
旧 fixture 写的是 `writeFile(join(nested, \`libsimple${suffix}\`), 'LIBSIMPLE')` ——
和产品代码**同一个表达式**。所以它在 Windows 上造出一个 `libsimple.dll`，
产品去找 `libsimple.dll`，**找到了**，绿灯。而真实归档里那个文件叫 `simple.dll`。
👉 这一族的判据我建议写成：**fixture 里凡是"上游给什么"的部分，都不许由被测代码的
同一个表达式生成，必须来自独立观测**（下载、unzip、抄清单、抄真机日志）。
现在那张 `ARCHIVE` 表就是这么来的，并且注释里明写了「不要把这张表改成用 `${suffix}` 拼」。

**「bail 模式下"还剩 N 条"这个数字本身不可信」** —— 补一个可操作的推论：
`pnpm -r test` 报的是"**到目前为止撞到的**"，不是"总共有的"。
想知道总数，要么 `--no-bail`，要么像这次一样**一层一层修着走**
（我这轮走了四层：runtime 5 → pipeline 5 → daemon 3 → daemon 2，共 14，起点报的是 6）。

---

## [2026-08-09 21:05] 任务 #63 DONE（含附带的 1795 ms 黑窗）

交付（已 push）:
- `f17a2aa` 产品修复 ① 软链逃逸守卫在 Windows 上空转 + ② 边车替换 EPERM
  （⚠️ 这条的 **message 没覆盖它自己的全部内容**，见下面「自我申报」）
- `d9b7ffd` 产品修复 ③ 校验阶段 1795 ms 黑窗（附带任务）
- `72dbb01` 用例修复 ④ downloader 修完后露出的下一层（pipeline 两条宿主假设）

# 回报你点名的三问

## 1. 红的根因

**`packages/downloader` 在 Windows 上 7 红，是两条独立的产品缺陷。**

### ① 软链逃逸守卫**整个是空转的**（4 红）— 安全相关

根因不在守卫的判据里，在它的**根**：

```
'C:\Users\x\dest'.split(/[\\/]+/)  →  ['C:', 'Users', 'x', 'dest']
path.win32.join('C:\', 'C:')       →  'C:\C:'          ← 盘符成了一段路径
```

`resolveRoot()` 把整条绝对路径喂给按段前进的 `walk()`，于是解析出来的根是
`C:\C:\Users\…\dest` —— **一个不存在的路径**。此后每次 `lstat` 都落空，
**没有任何东西会被认成软链**，而 `real.startsWith(rootReal + sep)` 在那棵幻影树里
对一切候选恒真。

> **守卫没有变红，它变成了恒真。** T-157 那次修复的全部内容 ——
> resolve-then-check 这一半 —— **在 Windows 上从落地那天起就没有执行过一行**。
> POSIX 上恰好是对的（前导空段被跳过），所以它能一直藏着。

这正是你说的那条主线教训的又一例：**"CI 结构上看不见"**。
守卫在那儿、测试在那儿、代码走过去了，只是它检查的那棵树不存在。

### ② 边车的原子替换会 EPERM（3 红）

`rename` 到已存在目标走 `MoveFileEx(REPLACE_EXISTING)`；目标正被另一次替换持有句柄时
Windows 返回 ACCESS_DENIED → **EPERM**。实测 600 次并发调用 **44 次失败（7.3%）**。

**并发源不是测试造的**：`download.ts` 那个 2s `setInterval` 与收尾写的重叠 ——
和你提到的 `writeSidecar` 那次 ENOENT 事故**同一个源，第二种失败方式**，
后果也一样（抛出去 → daemon 退出 exitCode=1 → 用户看到"点按钮完全没反应"）。
唯一 tmp 名解掉了 ENOENT，但**替换同一个 target 本身**仍会互撞 —— 那一层它没覆盖到。

## 2. 是用例的问题，还是产品在 Windows 上的真 bug

| | 定性 | 修在哪 |
|---|---|---|
| ① 软链逃逸守卫空转 | 🔴 **产品真 bug（安全相关）** | `unpack.ts` |
| ② 边车替换 EPERM | 🔴 **产品真 bug** | `sidecar.ts` |
| ③ 1795 ms 黑窗（附带） | 🔴 **产品真 bug**（漏传参数） | `download.ts` |
| ④ 后来露出的 pipeline 两条 | 🟡 用例的宿主假设 | 两个 test 文件 |

④ 是**修完 ①② 之后 CI 才走到的下一层**（又一次"bail 截断计数"）：
- `backendSelect.test.ts`：夹具落 `whisper-cli`，产品在 win32 上找 `whisper-cli.exe`
  → 那几条用例在 Windows 上测的不是"选包对不对"，是"名字对不对"。
- `sourceIsGreppable.test.ts`：`endsWith('packages/…/argGuard.ts')` 是写死的 POSIX 串，
  而 `files` 由 `join()` 造出。**这条"前提自检"自己成了那个不成立的前提**，
  于是"源码必须是纯文本"那条守卫在 Windows 上从未生效。

## 3. 有没有削任何用例

**没有。一条都没删、没跳过、没放宽。** 净增：`unpack.test.ts` +6 条、
`installer.test.ts` +1 条（共 +11 处断言）。
你点名要保持绿的两道守卫：zip 炸弹与路径穿越/软链 —— **后者正是这次修好的那条**
（它此前在 Windows 上根本没在守）。

# CI 实测（判据不是"参数传上了"）

```
run 31313108614 / win32-x64:  packages/downloader  49 / 49  ✅   （修复前 33/40，7 红）
                              darwin-arm64 Test 步骤也转绿
```

反向验证（本机 Linux，**这个 Windows 缺陷现在在这里就抓得到**）：
- `splitAbsolute` 改回 `rest: abs` → 新增 4 条当场红
- 给 `resolveRoot` 注入幻影根 → **14 条**逃逸/误杀用例全红（证明守卫真的在拦，不是恒真）
- ③ 把回调改回 `undefined` + 起点改回满格 → 用例当场红，并把旧行为原样打了出来：
  `★ 校验期间只报了 1 条事件 …{"phase":"verifying","done":9437184,"total":9437184}`
  —— **恰好一条、且是满格的**，那 1.8 秒黑窗就是这么来的
- ② 的 EPERM 在 POSIX 上复现不了（内核不产生该 errno），**只能靠 CI**，已由上面那轮验证

# ⚠️ 自我申报：我踩了 §12 的一个新形态

`f17a2aa` 的 message **只描述了它一半的内容**（写了软链守卫，没写 sidecar EPERM）。

成因：我 `git commit` 之后发现消息没覆盖 sidecar，于是 `git commit --amend` 去补 ——
**而在这两条命令之间，另一位把原提交推了出去**。amend 出来的新 hash 与远端分叉，
`git push` 被拒。我**没有 force-push**，改为 `git reset --mixed origin/master`
（不动工作树，别人的脏文件原封不动）后只重建第二个提交。

> **§12 说的是"检查与行动之间世界会变"；这次变的是"提交与改提交之间"。**
> 推论：**`--amend` 只对"确信还没被推出去"的提交安全，而共享 clone 里没人能确信这一点。**
> 正确做法是消息一次写对，写漏了就用**新提交**补说明，不要回头改历史。
> 被漏掉的那段说明现在在 `d9b7ffd` 的 message 尾部与 `sidecar.ts` 的 40 行注释里。

# ⚠️ 当前 master 是红的，但**不是这条线的红**

我推完 `72dbb01` 之后那一轮（run 31313661935）**三个平台全红**，逐条核过：

| 红 | 归属 | 证据 |
|---|---|---|
| `Lint`（三平台） | 别人 | `scripts/ci/ffmpeg-lgpl-verify.mjs` 两条 `no-useless-assignment` |
| `Test` 在 `packages/llm` bail | 别人 | `extractJson`「截断的输出报被截断」——**linux 也红**，平台无关；上一轮 win32 还是 18/18 |
| `CI scripts self-test`（mac/win） | 别人/历史 | `check-elf-glibc` 调 `objdump`，那两个平台没有 —— 与 `check:sources` 调 `find` 同族 |

**后果对我这条线**：`packages/llm` 在 `packages/pipeline` **之前**，所以 ④ 那两条修复
**在 Windows CI 上还没被跑到**，标 `[未验证：CI 上未跑到]`（本机 `packages/pipeline` 238/238）。
①②③ 已由 run 31313108614 验证，不受影响。

⚠️ 我**没有去动别人的红**（PROTOCOL：冲突报给你，别硬合）。

# 门禁口径（如实记）

本机 `pnpm -r test` / `tsc` / `eslint` 此刻**被共享脏树污染** —— 跑出来的红
（`JobToaster.tsx` 缺 `stepLabelOf`、上面那两条 lint、未跟踪的 `store.test.ts`
对着在改的 `store.ts` 红 1 条）**没有一条落在我碰过的文件上**。
按你这一轮加的纪律，我没有拿它当结论，改为按包验：
`packages/pipeline` **238/238** · `packages/downloader` **52/53**（那 1 条即上述未跟踪的新文件）。

需要 Manager 决策:
1. `packages/llm` 的 `extractJson` 红与 `ffmpeg-lgpl-verify` 的 lint 红**挡住了整条 Windows 线**
   —— 在它们修好之前，`packages/pipeline` 之后的所有包（含 `apps/daemon`）在 Windows 上
   **一条都跑不到**。派给谁？
2. `check-elf-glibc` 的自检在 macOS/Windows 上必然红（依赖 `objdump`）。
   与 `check:sources` 那条同一族：**一条永远红的守卫等价于被删掉的守卫**。要不要一并治？

下一步建议:
1. 等 1 修好后重跑 `ci-crossplatform`，确认 ④ 那两条在 Windows 上真的绿。
2. Windows 线的下一层大概率还在后面（`apps/daemon` 至今**从没在 Windows 上跑完过**）。

---

## [2026-08-09 22:10] ② 与用户 bug 的对照 —— **对不上，这条排除**

# 第一句（你要的直接回答）

**不会。** 在 **v0.5.0 上，边车 EPERM 不会让 daemon 退出** —— 我上一份回执里
「后果同样是 daemon 退出」那句**是错的**，它描述的是 `d941d13` **之前**的形状，
而 `d941d13` 是 v0.5.0 的祖先。**我把一段已经被修掉的历史当成了现状。**

**单用户装一个包撞上的概率：约 `W/2000`，`W` 是一次写边车的窗口宽度。**
本机实测 `W`：p50 **0.18 ms** / p99 **0.45 ms** / max **1.13 ms**（753 B 的真实边车，2000 次）
→ **每个文件 0.009% ~ 0.06%**。Windows 更慢，就算按 10× 放宽也只有 **0.1% ~ 0.25%**。
**与 7.3% 差三到四个数量级** —— 那个数是 200 轮 × 3 并发、背靠背零间隔压出来的，
**套到单用户身上是错的**，你点名要防的正是这个。

---

# 逐条坐实

## 1 ⚠️「EPERM → daemon 退出」这一环**在 v0.5.0 上不成立**（两层保护，都在）

`git show v0.5.0:` 直接读的，不是推的：

| 层 | 位置（v0.5.0 的树） | 行为 |
|---|---|---|
| 定时器那次写 | `packages/downloader/src/download.ts:427` | `void persist().catch(e => { lastPersistError = e })` —— **有 catch**，只记不抛 |
| 进程兜底 | `apps/daemon/src/main.ts:1322-1335` `installCrashGuards()` | `unhandledRejection` → 打印 + **注释原话「daemon 不会因此退出」**；`uncaughtException` 刻意不接管 |

**是有意的 fail-soft，不是未捕获异常，也不是 fail-fast。**
唯一会冒泡的是**被 await 的**那几次（`download.ts:396 / 496 / 519`）——
它们冒泡成 `downloadWithSources` 的 `catch`（`download.ts:252`）→ 换下一个镜像 →
全失败则抛 `INTEGRITY_ALL_SOURCES_FAILED` → **任务失败并显示错误**。
**不是冻住。**

## 2 v0.5.0 里有没有这个缺陷（按拓扑判，不看时间戳）

```
git merge-base --is-ancestor d941d13 v0.5.0   → 真（v0.5.0 已含那三处保护）
git merge-base --is-ancestor v0.5.0 d941d13   → 假（两者互不为祖先）
```

- ✅ v0.5.0 **有**唯一 tmp 名（不会 ENOENT）、**有** `.catch`、**有** crash guard。
- 🔴 v0.5.0 **没有**我这次加的 rename 重试 → **EPERM 这条路径在 v0.5.0 上确实存在**，
  但它的后果只到「这次下载失败并报错」或「一条 console 警告」，**到不了「daemon 没了」**。

## 3 单用户的真实并发度：**最多两个写者，且大部分情况下只有一个**

`persist()` 有 `sidecarDirty` 闸门，而且**先清标志再 await**：

```
const persist = async () => { if (sidecarDirty) { sidecarDirty = false; await writeSidecar(...) } }
```

- 定时器 persist ↔ `finally` 里的 persist：**不可能重叠** —— 前者已经把 `dirty` 清了，
  而 worker 都已返回、不会再置脏，后者直接空转。
- 定时器 persist ↔ `download.ts:519` 的**无条件** `writeSidecar`：**这才是唯一的碰撞点**。
  需要「最后一次定时器 tick 恰好落在收尾写的那 `W` 毫秒里」，
  而 tick 每 **2000 ms** 才一次 → `P ≈ W/2000`，**每个文件一次机会**。

> **照实说**：即使真撞上，输的那一方要么是定时器（→ 只有一条 console 警告），
> 要么是收尾写（→ 任务失败并报错）。**两种都不是「没有后续进展」。**

## 4 daemon 真退出的话，界面**不会冻住，会非常显眼**

| 位置 | 表现 |
|---|---|
| 黑窗口 | `start.cmd` 走 `:failed` 分支：`OpenMemo stopped with exit code N` + `The real error is printed ABOVE this line` + **`pause`（窗口停住等按键，不会消失）** |
| 浏览器 | 所有请求失败 → `markSurface(..., 'offline')`（`client.ts:404`）→ 整个界面进入**「本地服务未启动」**离线态，不是某一条任务不动 |

**所以和用户的描述对不上**：他说的是「任务中心停在正在安装」，
而 daemon 退出会让他看到一个写着英文报错、等他按键的黑窗口 + 全站离线提示。

## 5 给用户的指令（不需要翻日志，两句话就能定/排）

daemon **没有日志文件**，stdout/stderr 直接打在 `start.cmd` 那个控制台窗口里。所以：

> **① 卡住的那会儿，启动 OpenMemo 的那个黑色命令行窗口还在吗？里面最后几行写的是什么？**
>   - 出现 `OpenMemo stopped with exit code ...` / `Press any key to continue` → daemon 死了
>   - 还在、没有这段 → **daemon 活着，这条线索排除**
>
> **② 卡住时刷新一下网页、或点开「设置」页 —— 还能正常打开吗？**
>   - 能打开 → daemon 活着（同上，排除）
>   - 显示「本地服务未启动」/ 整站离线 → daemon 死了
>
> **③（只在 daemon 活着时有意义）那个黑窗口里能不能搜到这一行：**
>   `[downloader] 周期性写断点续传边车失败过`
>   - 有 → 确实撞上了边车写失败，**但它被正确降级了**，不是卡住的原因
>   - 没有 → 边车这条路径连发生都没发生

# 结论

**② 解释不了用户那个 bug，我不认领它。** 三个理由任一条都足够：
① v0.5.0 上它到不了「daemon 退出」；② 单用户概率比那个 7.3% 低三四个数量级；
③ 就算发生，表现是「任务报错」或「一条控制台警告」，**不是「没有后续进展」**。

**这是第四个被打掉的假设。** 我这条修复本身仍然值得留着（它消掉了一个真实存在、
只是很罕见的失败路径，且已在 win32 CI 上验过 49/49），
但**它不是用户那条报告的解释**。

⚠️ **自我更正**：上一份回执里「后果也一样（抛出去 → daemon 退出 exitCode=1）」那句是错的。
成因是我照抄了 `sidecar.ts` 注释里那段**事故当时**的描述，没有回头确认那条链
**在今天的树上是否还成立** —— 而它早在 `d941d13` 就被切断了，并且随 v0.5.0 发出去了。
**一段准确记录了历史的注释，被我当成了现状。** 与本仓 ⑤A 那族同形：
注释说的是真的，只是它说的是**过去**。

需要 Manager 决策:
1. 「正在安装」那一半（Toast 标题在整个 `active` 期恒定）另一路已经在查 —— **那一半仍然成立**，
   而"没有后续进展"这一半现在**四个假设全空**。建议下一步不要再猜成因，
   而是**先让用户回答上面①②那两句**：它们能一刀把"daemon 死没死"切开，
   而这两条分支后面要查的东西完全不同。
2. 如果用户回答"daemon 活着、页面正常"，那问题就在**任务态本身**（job 没推进/没发事件），
   与进程存活无关 —— 那条线我这轮量过的两个数（后端包 5-6ms、模型 `installing` 9ms）
   加上刚修的 1795 ms 黑窗，说明**事件是有的**，所以要查的是"事件发了但界面没更新"。

---

## [2026-08-09 23:40] 任务 #65 —— 31 条锚点式规格的体检

交付: `43bbfdf`（已 push，`merge-base --is-ancestor` 复核过）

# 第一句：**0 条静默通过。**

逐条验的，不抽样，也不是读代码得出的结论。

| 文件 | 规格数 | 锚点失配时 | 证据 |
|---|---|---|---|
| `scripts/mutation-check.mjs` | **18**（你说 12） | **18/18 `⚠ 锚点失效` + exit 1** | 把每条锚点改成不可能匹配的文本后整跑一次 |
| `scripts/ci/e2e-runtime-audit.mjs` | **13**（你说 9） | **13/13 `✘ 变异锚点在 … 出现 0 次` + exit 2** | 逐个 `--mutate <id>` 跑了 13 次 |

**合计 31 条，不是 21。** 两边都落在你说的"烦人但安全"那一档：
`hits !== 1` → 当场报错停下来，**不是恒真**。

验法（照上一轮那套）：**只动数据、不动判定逻辑** ——
在 `MUTATIONS` 数组定义之后插一行把 `find` 接上一段不可能出现的文本，
其余代码一个字不改，跑在 `/tmp` 的隔离副本上（仓库零改动）。

---

# 但"能红"≠"有人看" —— 真风险在这里，而且已经兑现了一次

完整那一档要先 build、起沙箱、把测试跑 N 遍，几分钟起步，**所以（有意地）不进门禁**。
代价是：**锚点烂掉这件事没有任何人在看。**

所以加了一档 `--anchors-only`：只做字符串比对，**实测 0.086s**。
**它第一次跑就抓到一条哑弹：**

```
✘ E1-state-dropped  锚点出现 0 次（要求 1 次）
```

烂在 T-151 ⑥ 那次重构：`state: a.state` → `state: assetStateOf(a.state)`。
**从那天起这条规格什么都没测。** 它不是"静默通过"（完整那一档会报 ANCHOR 并 exit 1），
是**没人跑那一档** —— 你担心的哑弹是真的，只是成因不在机制里，在使用频率里。

已按脚本自己的指示**重新指锚点**（原话「请重新指锚点，别把这条删掉」），
**规格没改**（仍是"把 state 整个从载荷里拿掉"），并真跑了一遍确认它还有牙齿：
`✔ 红  E1-state-dropped`。

新档的输出末尾特意写了一句「**这不证明它们还抓得住变异**」——
免得下一个人拿这一档的绿去替代完整那一档。**我没有把它接进门禁**（那是你的决定）。

**它正好补上你说的那条纪律缺口**：锚点钉的是 `dist/**/*.js`，
所以"按源文件名 grep 谁在钉它"对这一族无效（grep `manager.ts` 找不到，得 grep `manager.js`）。
改完直接 `node scripts/mutation-check.mjs --anchors-only`，秒级告诉你踩了哪几条。
**`manager.ts` 那次重构可以直接用它当前置检查。**

⚠️ 我**没有**给 `e2e-runtime-audit.mjs` 加同款，理由是它自己的设计明确禁止：
它的 `file` 是"包内后缀"，注释原话「包的内部布局不该被抄进这里，抄了就等于把两份
布局知识钉死在两个文件里」。要在仓库侧解析同样的后缀，就得再写一份布局知识。
而它的锚点检查本来就在 `--mutate` 跑的**头几秒**（`setUpMasking()` 之后立刻），
失配 exit 2，**不需要跑完**。标 `[按设计不加，非遗漏]`。

---

# 顺带登记：本轮看到的其它「失败时无声」形状（只记，不修）

1. **`mutation-check.mjs` 的对照组失败会"传染"成假绿。**
   一个 (pkg,tests) 组的对照组不绿时，**只有该组第一条**被记 `VOID` 并进 `problems`；
   `controlled.add()` 之后，**同组其余各条直接跳过对照检查**，拿着一个本来就红的包去跑变异，
   于是 `detected` 恒真 → 报 `✔ 红`。整轮仍然 exit 1（第一条已进 problems），
   所以不是静默通过，**但逐条报告里会出现一片证明不了任何事的 ✔ 红**。
2. **`e2e-runtime-audit.mjs` 的 `allUnknown` → exit 0。**
   目标断言全是 UNKNOWN 时，它**诚实地打印**「这条变异在这里什么都证明不了 / 如实报为未验证」
   然后 **exit 0**。只看退出码的调用方会把它读成"守卫已验证"。
   （它自己说清楚了，所以不是假绿；但**退出码与文字不同调**，值得记一笔。）
3. **我自己在本轮踩的一次（现场标本）**：第一版隔离副本少拷了兄弟模块，
   跑出来 `ERR_MODULE_NOT_FOUND` 而 exit=1，而我当时的判据是"exit 非 0 就算红" ——
   差一点把「因为别的原因失败」记成「因为锚点失配而失败」。
   **只看退出码，分不开"我要测的那个原因"和"别的原因"。**
   改成同时 grep 那条具体消息（`变异锚点在`）才把两者分开 —— 最终结果里
   `exit=2` 与 `锚点失效提示=1` 是**两个条件一起**成立的。

---

需要 Manager 决策:
1. **`--anchors-only` 要不要接进门禁？** 0.086s，只依赖 `dist/**` 已构建。
   接进去的效果是：**任何人改动被守护的文件、忘了更新锚点，当场红**，
   而不是像 `E1-state-dropped` 那样死掉几周没人知道。
   （前置：要求先 `pnpm build:safe` + `web test:unit`，门禁里本来就有这两步。）
2. 上面第 1 条（对照组传染）要不要修？一行判断的事，但它不属于本轮任务，我没动。

下一步建议:
1. `manager.ts` 那次重构开跑前先 `node scripts/mutation-check.mjs --anchors-only` 存一份基线，
   改完再跑一次 —— 差集就是"这次重构踩到的规格清单"，比 grep 准。
2. 完整那一档建议在 `manager.ts` 重构**落地后**跑一次全量（几分钟），
   确认那 8 种结局的规格不只是"锚点还在"，而是"还抓得住"。
