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

---

## [2026-08-10 00:50] 任务 #65 ①②③ 完成 + 一条我自己造成的门禁红

交付（均已 push 并 `merge-base --is-ancestor` 复核）:
`2701469`（①②③）· `bd2f575`（格式化我的三个文件）· `5f54a41`（格式化 5d3cc8c 的三个文件）

# 第一句：**接进去了（`ci.yml`，Test 之后一步）；今天树上是绿的（本机 `✔ 18/18, exit 0`）。**

⚠️ **但它至今没有在 CI 上真的绿过一次** —— 那一格连着三轮都是 `skipped`，
因为**前面的步骤先红了**（先是 `Format check`，修好后变成 `Orphan-exports ratchet`）。
**`skipped` 不是 `passed`。** 标 `[未在 CI 上观测到绿]`。

---

## ① `--anchors-only` 进门禁

放在 `Test` **之后**，理由写进了 yml：18 条里有 6 条钉在 `apps/web/.test-out/**`，
那个目录是 `pnpm -r test` 里 web 的 test 脚本编出来的（`build:safe` 不编）——
放前面那 6 条会因"产物不存在"而红，是一条**假红**。

你要求的那件事（**别让人以为完整那一档可以不跑了**）写在四处：
- 步骤名就叫 `Mutation-spec anchors (只查锚点在不在 ≠ 规格还有牙齿)`；
- yml 注释里明写"这一步绿 ≠ 那一档可以不跑"；
- 脚本**成功**输出：「这只证明锚点还指得到东西，不证明改坏了还会红」；
- 脚本**失败**输出：除了修法，还专门解释「上面每条 ✘ 意味着那条规格现在**一次都没在测**
  （不是"测得不准"，是"没测"）」+「为什么 grep 源文件名找不到它们」。

`lint-workflows` 1687 条断言全过。

## ② 对照组失败不再传染成一片假绿

`controlled` 是 `Set`（只记"查过没有"）→ 改成 `Map<key, boolean>`（记**结论**）。
对照组没成立的组，**每一条都报 VOID，一个绿勾都不许有**。

反向验证（数据级改动、/tmp 隔离副本、仓库零改动）：把 daemon 那组的 `tests`
指向一个不存在的测试文件，让对照组真的红 ——

```
修复前：⚠ 对照组不绿 ×1  +  ✔ 红 ×5      ← 那 5 条什么都没证明
修复后：⚠ 对照组不绿 ×6  +  ✔ 红 ×0
```

## ③ `allUnknown` 不再 exit 0

新增 **3 = 跑起来了，但什么都没证明**，并在文件头补了退出码对照表：

```
0 通过 | 1 失败（断言 FAIL / 变异存活） | 2 跑不起来（前提没成立） | 3 什么都没证明
```

**没有只改退出码**：按你说的，想清楚了调用方怎么区分它和"真的失败了"——
不能塞进 1（会和"变异存活"混在一起，让人去修一个没坏的东西，正是
`ERR_MODULE_NOT_FOUND` 那条教训的形状），所以给它单独一个码；
只判"非 0"的调用方会当失败，**那个默认方向是对的：没验到就不该算验过**。
收尾还多打一行「退出码 N —— <含义>」，让**屏幕说的和退出码说的能被同一眼看到**。

⚠️ `[未实测]` 本机构造不出「目标断言全 UNKNOWN」的场景，这条只做了静态改动 +
语法/lint 校验。**已实测的是它的邻居**：`--mutate` 锚点失配仍然 exit 2。

## manager.ts 那件事的前置检查，写在哪

写进了 `scripts/mutation-check.mjs` **文件头**（`要重构被守护的文件之前，先读这一段`）：
改前存基线 → 重构 → 再跑 → `diff` 就是这次踩到的规格清单；踩到的**重新指锚点，不要删**。
放文件头而不是只放 inbox：**动这些规格的人一定会打开这个文件，不一定会翻 inbox。**

---

# ⚠️ 一条我自己造成的门禁红（已修，如实记）

`Format check` 红了，6 个文件未过 prettier，**其中三个是我 T-63 那几轮提交的**
（`installer.test.ts` / `unpack.test.ts` / `sourceIsGreppable.test.ts`）。

成因很具体：我那几轮跑的是 `tsc` + `eslint` + 按包 `test`，**没跑 `pnpm format:check`** ——
而它是 `d7b357c` 才接进 CI 的，我用的是它接进去**之前**的那套习惯。
**同一形状的又一例：一条我脑子里的检查清单，落后于仓库真实的门禁清单。**
判据不该是"记得多跑一个命令"，而应该是 `pnpm check`（它含 format:check）——
我以后按包验时也要跑一次它。

另外三个（`modelReconcile.*` / `store.test.ts`，来自 `5d3cc8c`）**不是我的**，
但 `Format check` 是**共享门禁**，红着五路都拿不到绿灯，而那三个文件已提交、
工作树干净、格式化碰不到任何人未提交的东西 —— 所以我单独一个提交（`5f54a41`）
把它们也格了，**提交信息里声明了作者身份归 5d3cc8c，并写明零语义改动、撞了以他们为准**。
`scripts/build-bundle.mjs` **没碰**：它此刻在别人手里未提交（其已提交版本是干净的）。

---

# 🔴 现在挡着门禁的不是我这条线

```
Orphan-exports ratchet  ✘
  ✘ 1 个**新的**零引用导出（基线里没有）：
     packages/shared/src/bundled.ts :: BundledModelId
```

来自 `5d3cc8c`（内置模型落地）。按那条门禁自己给的三条出路（接上它 / 删掉它 /
登记进基线并写明为什么没有调用方），**这是他们的设计判断，我不替他们选**
（PROTOCOL：冲突报给你，别硬合）。

**在它修好之前，我那一格会一直 `skipped`** —— 所以「`--anchors-only` 在 CI 上真的绿过」
这件事仍然欠一次观测。

需要 Manager 决策:
1. `BundledModelId` 这条零引用导出派给内置模型那一路（一分钟的事，但要他们选出路）。
2. 修好后我这一格会第一次真跑；如果它那时红了，**红的会是"锚点失配"而不是别的** ——
   本机已经绿过，且 CI 与本机走的是同一条命令。

下一步建议:
1. 等 ratchet 解开后看一眼 `Mutation-spec anchors` 那一格的第一次真跑。
2. `manager.ts` 重构开工前，先按脚本文件头那段存一份 `--anchors-only` 基线。

---

## [2026-08-10 02:15] 陈旧 stash 的逐文件取证 —— **没拆，卡在一处**

交付: `dc1bef2`（PROTOCOL §15-bis，已 push 并 `merge-base --is-ancestor` 复核）

# 第一句：**有一处只存在于 stash 里。** 第二句：**没拆 —— 按你的规则 3 停下来报你。**

只存在于 stash 的那一处：

```
apps/web/src/test/__scratch_b11.tsx   （^3 未跟踪那一档，48 行）
   HEAD 里：没有        工作树里：没有
   文件第一行（作者自己写的）：/* 临时复现脚本（B11）—— 不提交，跑完删除。 */
```

**我已经把它另存到 `/tmp/win-fixes/stash-rescue/__scratch_b11.tsx`** ——
所以"先不拆、等你裁"的代价是零，而且拆不拆都不会丢内容。

它是什么：`e2e-browser` 那一路查 B11 时的一次性 jsdom 复现脚本，往
`NoteActionsMenu` 注入 404 `FOLDER_NOT_FOUND`，打印「新增文字」和
「FAIL_WORDS 命中没有」。**它的结论已经落地并被逐字记进了 HEAD**：
`ErrorBlock.tsx` 里那段注释就写着 `[实测] jsdom 复现：新增文字 = "文件夹不存在…"，
FAIL_WORDS 命中 = false`，而 `role="alert"` + `data-testid="error-block"` 也在 HEAD 里。

⚠️ **但"结论已落地"是我的判断，不是证据。** 按你写的第 3 条，
"只存在于 stash 里 ⇒ 停下来报"，我不替 `e2e-browser` 那一路决定它的 scratch 文件。
**你或他们说一句"扔"，我就 drop。**

---

# 逐文件核对（12 已跟踪 + 2 未跟踪）

`stash@{0}` 的基是 `2360bf1`；核对对象是当时的 HEAD `3aac781`。

## 已跟踪：12 个，**全部已在 HEAD**

| 文件 | 与 HEAD 的关系 | 对应到哪 |
|---|---|---|
| `apps/daemon/src/http/rest/hardware.ts` | **逐字一致** | 已提交 |
| `apps/daemon/src/runtime/layoutResolve.test.ts` | **逐字一致** | 已提交 |
| `apps/daemon/src/runtime/setup.ts` | **逐字一致** | 已提交 |
| `apps/web/src/components/common/ErrorBlock.tsx` | 重做，措辞不同 | HEAD 有 `role="alert"`(123) + `data-testid="error-block"`(124) |
| `apps/web/src/features/components/ComponentsPage.tsx` | 重做 | HEAD:157 `{update.isError ? <ErrorBlock …>}` |
| `apps/web/src/features/notes/NoteActionsMenu.tsx` | 重做 | HEAD:100 `onSuccess: close`；261/312 渲染 `rename.isError`/`del.isError`；旧的 `onError: () => close()` 已不存在 |
| `apps/web/src/features/runtime/components/BackendPackCard.tsx` | HEAD **更全** | HEAD:169 `pack.updateAvailable === true ? …`（那 2 行"缺"的是被改写的注释散文） |
| `docs/design/D-20-bundled-deps.md` | HEAD **更新一天且更准** | 见下 ★ |
| `packages/runtime/src/backends/applicability.test.ts` | HEAD 是**超集** | HEAD:193 `/本机组件|运行时|CPU 基础包/`（stash 只有后两个）；196 同一条"理由太短"断言 |
| `packages/runtime/src/backends/applicability.ts` | HEAD **更靠后** | HEAD:158-168 同一段 T-191 改写，并多一句"①已由 T-191① 修好，所以保留了它" |
| `packages/runtime/src/selfcheck.ts` | HEAD 已实现分叉 | HEAD:789-810，两句话按"装没装后端包"分叉，落到 809/810 两条文案 |
| `scripts/build-bundle.mjs` | HEAD **更新** | HEAD:985 等价的那行 say；995 起把 ffmpeg/ffprobe 放进 `runtime/probe/` |

★ **`D-20` 这一条正是你说的"pop 会盖掉更新版本"的活样本**：
stash 版是 **08-09** 的订正，HEAD 版是 **08-10** 的复核，而 08-10 那版**修正了 08-09 版
把两段署名挂反的错**（`Copyright (c) 2015, David Bonnet` 那段其实是 MIT/astring，
ISC 那段的版权人是 KFlash/meriyah）。**pop 一下正好把这个订正盖回去。**

## 未跟踪（`^3`）：2 个

| 文件 | 结论 |
|---|---|
| `apps/daemon/src/runtime/selfTestWrongCard.test.ts` | ✅ **已被跟踪**，首次提交 `5d30251`，与 stash 版**逐字一致**；工作树里也在 |
| `apps/web/src/test/__scratch_b11.tsx` | 🔴 **只在 stash 里**（见上） |

## 核对方法（以及它第一遍骗了我一次）

已跟踪的先 `git diff stash@{0}:<f> HEAD:<f>`：一致的直接过；
不一致的把 **stash 新增的每一行**拿去 HEAD 同名文件里找，找不到的再人工判"是不是
换了措辞的同一件事"（判据按你说的：**内容等价，不要求逐字**）。

⚠️ **第一遍那个脚本报「扫到 0 行新增、缺 0 行」，看起来 6 个文件全过** ——
实际是 `/tmp/win-fixes` 那个目录不在了，`> added.txt` 全部写失败。
**空集被报成了通过**，正是我这两轮一直在查的那个形状。
加了一条"扫到 0 行就判核对无效"的前提自检之后，真实数字才出来
（30 / 27 / 23 / 25 / 34 / 113 行）。这条已写进 §15-bis。

---

# §15-bis 已补（`dc1bef2`）

三条：① 不 pop/apply 整条，只读地取自己那部分；
② `drop` 前必须逐文件证明内容已在 HEAD ——「当时没丢数据」是关于**过去**的结论，
「现在可以扔」需要**现在**的证据；③ 有一处只在 stash 里就停下报 Manager，
**报之前先另存到 /tmp**，让"等一下再决定"的代价为零。
附了实测有效的核对命令 + 这次的结论当范例（含 D-20 那个"旧盖新"的活样本）。

---

需要 Manager 决策:
1. **`__scratch_b11.tsx` 扔不扔。** 它自称"不提交、跑完删除"，结论也已进 HEAD 的
   `ErrorBlock.tsx` 注释；副本在 `/tmp/win-fixes/stash-rescue/`。
   你或 `e2e-browser` 那一路说一句，我就 `git stash drop` 收尾。
2. 如果决定保留它，那它应该**进仓库**（否则下一个人还会面对同一颗雷）——
   但那是 `e2e-browser` 的文件，我不替他们提交。

未做/未碰: 没有 `pop`、没有 `apply`、没有 `drop`，stash 原样挂着；
`git stash list` 只有这一条（无其余条目）；`:10000`、`/root/data-memo`、机器级指针一律没碰；
工作树里别人的在途文件（`packages/shared/src/hardware.ts`、
`apps/web/src/lib/catalog/useModelCatalogNames.ts` 等）一个都没动。

---

## [2026-08-10 13:50] 陈旧 stash 已拆 —— `git stash list` 现在是空的

交付: `ff197dc`（PROTOCOL §15-bis 补完，已 push 并 `merge-base --is-ancestor` 复核）

# 第一句：**拆了。第二句：`git stash list` 现在是空的（条目数 = 0）。**

```
Dropped refs/stash@{0} (12023d03c188cbf8a1878ebe33876d8cce92135e)
条目数 = 0
```

## drop 前你要求的两项最后确认（都过了才动的）

| 确认项 | 结果 |
|---|---|
| `git stash list` 仍只有这一条 | ✔ 条目数 = 1（**没有冒出第二条**） |
| `/tmp` 副本还在、内容完整 | ✔ 48 行 / 2153 B，首行 = `/* 临时复现脚本（B11）—— 不提交，跑完删除。 */` |
| （我自己加的一项）副本与 stash 里那份逐字一致 | ✔ `diff` 无输出 |

## 拆的依据（写清楚，按你的要求）

1. **那个文件自己的第一行** —— 作者本人写下的处置意见：
   `/* 临时复现脚本（B11）—— 不提交，跑完删除。 */`
2. 作者已确认 B11 的工作**重做并提交**（`abce462`）
3. **结论逐字进了 HEAD**：`ErrorBlock.tsx` 注释里的
   `[实测] jsdom 复现：… FAIL_WORDS 命中 = false`，以及 `role="alert"` / `data-testid="error-block"`
4. `/tmp/win-fixes/stash-rescue/__scratch_b11.tsx` 留有副本

## 拆完之后的兜底（多留一手，如实记）

`git stash drop` 只是解引用，**对象本身在 gc 之前仍然可达**。我在 drop 前记下了两个 id，
drop 后立刻复验过它们还在：

```
stash commit      12023d03c188cbf8a1878ebe33876d8cce92135e   → git cat-file -t = commit ✔
未跟踪那一档 ^3   0cd3642240eaf43684bc4272058a1a2941e1bbdc   → git show <id>:apps/web/src/test/__scratch_b11.tsx ✔
```

⚠️ **但这条兜底有时效**（下一次 `git gc` 就没了），**不要拿它当保管方案** ——
真正的副本是 `/tmp` 那份。写在这里只是为了让"万一还要回头看"这件事在今天成本为零。

---

# §15-bis 已补完（`ff197dc`）

按你说的，把「核对脚本被空集骗过」那一次**单独提成一节**，因为它的形状是整条链条：

> **不可逆动作 ← 需要证据 ← 证据来自一份核对 ← 而那份核对本身可能是假绿。**
> 链条上任何一环无声失败，最终结果都是"删得很有把握"。

关键那句照你的措辞写进去了：**一个失败时报成通过的检查，比没有检查更危险** ——
没有检查时人会犹豫，有一份绿的检查时人会直接动手。

同时把范例补完整：**"停下来报"和"最终拆掉"都写了** —— 上一版只写到"报了 Manager"，
下一个人读到会以为这条纪律的结局就是"永远不拆"。现在两半都在，
连拆的依据（作者自己的第一行 + 三重佐证）也在。

---

未做/未碰: 没有 `pop`、没有 `apply`；除 `stash@{0}` 外没有其它 stash 条目存在过；
`:10000`（`ff24098b` / pid 491899）一次都没碰；`/root/data-memo`、机器级指针没碰；
没 `pkill`；别人在途的文件（`packages/shared/src/hardware.ts`、
`apps/web/src/lib/catalog/useModelCatalogNames.ts` 等）一个都没动；
两次提交都带 pathspec、按 hash push 并 `merge-base --is-ancestor` 复核，没用 `--amend`。

需要 Manager 决策: 无。

下一步建议:
1. `/tmp/win-fixes/stash-rescue/` 那份副本随 runner 生命周期存在；如果哪天要正式留档，
   该由 `e2e-browser` 那一路决定要不要把它变成一个正式的回归用例（它现在的形态是
   `console.log` + `assert.ok(true)`，**作为用例是零断言的**，不能直接提交）。
2. §15 这一族现在有了完整实例，建议下次有人要动 stash 时直接指 §15-bis。

---

## [2026-08-10 14:50] Format check 已解开 + 反复的根因判断（按要求：只出判断和代价，未实施）

交付: `21fcce4`（三个文件）· `8f5bd6b`（`hardware.ts`）· `50fc1d0`（PROTOCOL §15-ter）

# 第一句：**绿了**（run 31362717430，`8f5bd6b`）。下游 8 条第一次全跑出来，**全过**：

```
Format check                ✔        Build (workspace packages)   ✔
Typecheck                   ✔        Lint                         ✔
Tracked-sources guard       ✔  98 个源码目录均未被 .gitignore 匹配
Orphan-exports ratchet      ✔  没有新的零引用导出，基线也没有过期条目
CI scripts self-test        ✔  lint-workflows 1713 条断言全过 / 版本单一事实来源 0.6.0
Test                        ✔  **1774 / 0**
Mutation-spec anchors       ✔  **18 条锚点全部命中** ← 这一格**第一次在 CI 上真的绿**
gate 三态汇总（独立 job）    ✔
```

★ `Mutation-spec anchors` 此前三轮全是 `skipped`（被 Format check 挡在前面），
**"skipped 不是 passed"那句话到今天才兑现成一个真的 ✔。**

# 第二句：根因是**没有拦截点**，不是注意力；建议 **B + C，不建议 A**。

## 这一轮清了两批，第二批是**在我修第一批的那 20 分钟里落地的**

| 文件 | 谁带进来的 |
|---|---|
| `manifestLoadFailure.test.ts` | `b1ad406`（T-153） |
| `silentFailures.test.tsx` | `3aac781`（契约字段落地） |
| `backendStatusUnion.test.ts` | `75c0b6c`（T-194 判别联合） |
| `hardware.ts` | `3944c75`（T-193）← **我检查时它的已提交版本还是干净的**，等我推完才被提交 |

⚠️ **`hardware.ts` 那条最能说明问题**：我按纪律**没碰**它（当时只有别人在飞的工作树副本
没格式化，已提交版本是干净的）；结果那一路把工作树提交上去，未格式化的那版就成了 HEAD。
**不是漏网，是新来的。** 五次连红、四个不同作者、其中一次发生在修复窗口内 ——
**这排除了"某个人不小心"，它是结构性的。**

## 根因（三条，缺一不可）

1. **`format:check` 只存在于两个地方：`pnpm check` 和 CI。** 而 `pnpm check` 里含
   `pnpm build:safe`（几分钟），所以没有人跑它 —— 大家跑的是 `tsc -b` + `eslint` + 按包 `test`
   （我自己前几轮就是这么干的，也因此贡献过三个文件）。**慢，是它不被跑的全部原因。**
2. **唯一的执行点在 push 之后。** 也就是说，反馈到达时**代价已经产生**了。
3. ★ **代价不落在犯错的人身上。** Format check 是 `gate` 的**第一步**，
   它红一次，**下游 8 条对所有人一起消失**。犯错那一路照常继续；
   被挡住的是下一个想看门禁的人。**外部化的代价不会改变任何人的习惯。**

量化一下这一轮的实际损失：**连红 5 次 × 8 条 = 40 次检查没有发生**，
跨度约 4 小时 —— 这期间任何真回归都是不可见的。

## 三条路，逐条给代价

### A. 本地拦截（pre-commit hook）—— **我不建议**

做法：`.git/hooks/pre-commit` 里对**本次改动的文件**跑 `prettier --check`（秒级）。

- ✅ 在提交那一刻拦住，代价回到犯错者身上。
- 🔴 **`.git/hooks` 是机器级共享状态**（这棵树只有一个 `.git`）。装上去**对所有 lane
  立即生效且不可见** —— 没有人在 review 它，也没有人知道它什么时候被改过。
  **这正是 §9 / §15 那一族**：一个进程级的便利，写进了机器级的共享位置。
  钩子一旦有 bug（或者某一路的合法提交被它误拒），**五路一起卡住**。
- 🔴 "自动 `--write` 并重新 stage" 的变体**更糟**：它在提交过程中改文件，
  与 §12「pathspec 提交」直接冲突，还可能把别人的 hunk 悄悄带进来。
- 🟡 折中变体（**只警告不拒绝**，exit 0）没有上面两条风险，但它是劝告性的 ——
  不过 agent 会读输出，**可能已经够了**。如果要装钩子，**只装这一个变体**。

### B. 让 Format check 不再挡住下游 —— **建议做，而且它不削弱任何守卫**

做法：把 `Format check` 从 `gate` 的第一步**挪成一个独立 job**（与 `gate` 并行）。

- ✅ **红的强度一点没变**：它失败，整个 run 仍然是 failure，分支保护照样拦。
- ✅ 变的只有**阻塞关系**：8 条下游不再因为一个空格而集体消失。
- ✅ **不碰 `MUST_FAIL_LOUDLY['ci.yml'] = ['gate']`**：那条约束管的是 `gate` **这个 job 的
  step 不许加 `if: always()`**；把检查挪到**另一个 job**不在它的射程内 ——
  这正是 `gate-summary`（`4700cbd`）用过的思路：**绕过限制而不拆护栏。**
- 💰 代价：多一个 runner + 一次 `pnpm install`（约 40s）。
  另：格式问题的反馈**更快**了（40s 出结果，而不是排在 5 分钟的 gate 里）。
- ⚠️ 唯一要想清楚的：它并行之后，**"gate 绿"不再蕴含"格式绿"** ——
  所以 `gate-summary` 的三态汇总里要把它也算进去，否则会出现"汇总说通过、run 是红的"。

### C. 给一条秒级的本地命令，并写进提交纪律 —— **建议做**

做法：加一个 `pnpm format:changed`（只对 `git diff --name-only origin/master` 的文件跑
`prettier --check`，约 0.2s），写进 §12 的提交清单。

- ✅ **它直接消掉根因 1**：不跑 `format:check` 的唯一原因是慢，0.2s 没有借口。
- ✅ 纯新增脚本，零风险，任何一路都可以自己决定跑不跑。
- 🟡 仍然依赖人去跑 —— 所以它**配 B 用**，不替代 B。

### 为什么不选"第四条：把 prettier 塞进 build"

`build:safe` 跑一次会把**别人在飞的文件**一起格式化 —— 又一次"作用域比你以为的宽"
（§15-ter 刚记的那个形状）。**直接否掉。**

## 我的建议

**B（结构，消掉爆炸半径）+ C（消掉"太慢所以不跑"这个根因）**，**不装拒绝式钩子**。
如果一定要钩子，只装**警告式**那个变体。

⚠️ 按你的要求，**这三条我一条都没有实施** —— 等你定。

---

未做/未碰: `:10000`（`ff24098b` / pid 491899）没碰；没碰任何 workflow 触发、
没改 e2e 相关文件（`a8266c04…` 的 `bundleRunId=31359723880` 那六条腿不受影响）；
`useModelCatalogNames.ts` / `features/runtime` 那一带一个没动；
没用 `git stash`；三次提交都带 pathspec、按 hash push 并 `merge-base --is-ancestor` 复核；没用 `--amend`。

需要 Manager 决策: B 和 C 做不做、做哪个。

下一步建议:
1. 先做 C（零风险、五分钟），它能立刻降低复发率；B 需要动 `ci.yml`，
   而此刻 `a8266c04…` 正在拿发布凭证，建议**等那六条腿跑完再动 workflow**。
2. B 落地时记得同步 `gate-summary` 的三态口径（见上面那条 ⚠️）。

---

## [2026-08-10 15:40] C 已落地：`pnpm format:changed`

交付: `8b6c1d1`（`scripts/format-changed.mjs` + `package.json` + PROTOCOL §12/§15-quater）

# 回报：口径我选了**第三个答案** —— 两个候选都没选

你问的是"相对 `HEAD` 还是相对 `origin/master`"。**两个都不用**，因为它们是同一类错误：

| 候选口径 | 为什么不能用 |
|---|---|
| `git diff --name-only HEAD`（工作树 vs HEAD） | 🔴 这棵树多路共享，它列的是**所有人**未提交的改动。照它去格式化 = 去动别人没写完的文件 —— **和我反对 pre-commit hook 的理由是同一条**（`.git/hooks` / `git stash` / `git checkout -- <f>` 全栽在"作用域比使用者以为的宽"） |
| `git diff --name-only origin/master`（工作树 vs 远端） | 🔴 同上，范围还更大 |

**我选的口径：作用域 = 你要提交的那几个文件，不多不少。**

1. **给了路径参数 → 就查这几个**，而且**照抄 `git commit -- ` 后面那一串**
   （§12 本来就强制你把它们列出来）。
   ★ **让"检查的范围"和"提交的范围"是同一份文本，它们就不可能漂移。**
   这是把 §15 那条判据（作用域要正好等于你以为的范围）**正着用**了一次 ——
   前面几条都是在讲它被违反的后果，这条是拿它当设计原则。
2. **没给参数 → 查 `origin/master..HEAD`**（我本地有、远端还没有 = 即将 push 的东西）。
   它只看**已提交**内容，**结构上不可能**碰到任何人未提交的工作。
   `origin/master` 不存在时**直接红并说清楚**，不偷偷退回"工作树 vs HEAD"那个坏口径。

## 空集不报绿（这一族今天已经咬过太多次）

- 显式给了路径、却一个存在的文件都没解析出来 → **exit 1**。
  路径打错时报绿是最坏的结果：**你以为查过了，其实一个字节都没看。**
- 无参数且没有待 push 的改动 → 明说「**没有检查任何东西**（这不是"通过"）」，
  不打 ✔。

## 不替代 `format:check`（按你的要求写进去了）

成功输出末尾固定带一句：**这不等于全仓格式正确**；
文件头与 §12 都写明 **"漏掉别人漏的"是它的设计，不是缺陷** —— 全仓那一档是 CI 的 `Format check`。

## 自证：它三次都是真阳性

| 时机 | 抓到什么 |
|---|---|
| 刚写完第一次跑 | **抓到它自己**没格式化 |
| 提交前跑 | 抓到我这次改的 `PROTOCOL.md` |
| 同上 | 抓到 `package.json` |

三种模式都实测：显式路径 ✔ / 路径打错 → exit 1 ✔ / 无参数空集 → 明说没检查 ✔。
耗时：直接跑 **0.54s**、经 pnpm **0.78s**（对照 `pnpm check` 几分钟）。

## 另外两件

- **§12** 加了一条提交纪律：提交前跑 `pnpm format:changed <照抄 pathspec>`，
  并写明它不替代 `format:check`、**口径不许换成 `git diff --name-only HEAD`**。
- **§15-quater**（你点名要收的那条）：证明"这是纯格式化"时，
  `--ignore-all-space` 与"去空白再比"**两个判据都会误报**（prettier 重排行、断行补尾逗号），
  正确判据是**把 HEAD 版喂给 prettier 看是否逐字节相同** = "我只做了 prettier 这一件事"。
  归到 §15-ter 旁边，因为它们同类：**一个看起来能证明的检查，其实证不了。**

## B 的排期（未动，等你放行）

`ci.yml` 一个字没碰。动的时候那条我自己点出的必须一起做：
并行之后 **"gate 绿"不再蕴含"格式绿"**，`gate-summary` 的三态口径要同步 ——
否则会出现"汇总说通过、run 是红的"，而那正好会长在刚建好的那个汇总上。

需要 Manager 决策: B 什么时候放行（六条 e2e 腿落定后）。

未做/未碰: `:10000`（`ff24098b` / pid 491899）没碰；`ci.yml` 没碰；e2e workflow 没碰；
别人在飞的 `main.ts` / `RuntimePage.tsx` / `BackendPackCard.tsx` / downloader 那几个
一个都没动（`git show --name-only` 复核：本次提交只有我那三个文件）；
没用 `git stash`、没用 `git checkout -- <file>`、没用 `--amend`；
新文件 `git add` 过；按 hash push 并 `merge-base --is-ancestor` 复核。

---

## [2026-08-10 16:40] ① 已清 · ② B 已落地 · **CI 还差最后一条，不是我的**

交付: `d0910f2`（格式化三个文件）· `22a0ce0`（B：Format check 独立 job）

# 第一句：**还没全绿。** `Format check` 已经绿且**独立**了，`gate` 红在**另一条**：`Orphan-exports ratchet`。

```
run 31370224187 (22a0ce0)
  Format check                      ✅ success   ← 新的独立 job，与 gate 并行
  typecheck + lint + test (gate)    ❌ failure   ← 红在 Orphan-exports ratchet
  gate 三态汇总                      ❌ failure   ← 正确地跟着红
```

★ **这正是 B 要买的东西**：以前格式一红，后面 8 条全灰，
**这条 orphan 违规被挡在后面看不见**；现在它第一次露出来了。

## ① 清红（第四次）

三个文件：`catalogDiskFreshness.test.ts`（`c926626`）、`components.test.tsx`（`e0ada01`）、
`list-models.test.ts`（`35ce6ef`）—— **都不是我的代码**。

⚠️ 这次和前三次不同：**三个文件此刻都被别人改着**（工作树 `M`）。
直接 `prettier --write` 再提交会夹带别人未提交的工作。所以先按 §15-quater 验：

```
prettier(HEAD:<f>)  vs  工作树那份   →  三个 sha 全等（d68b5247… / 44b1d31e… / 8bfa981a…）
```

**等价于"工作树那份恰好就是 HEAD 版跑一遍 prettier"** —— 那一路已经跑过 prettier
但还没提交，**这三个文件里没有任何人的语义改动**，所以提交它是安全的。
（没碰 `scripts/ci/e2e-import-audit.mjs`：它也脏着，但**不在 CI 失败名单里**。）

## ② B 已落地（`22a0ce0`）

- `Format check` → 独立 job，与 `gate` 并行；**没有加任何 `always()` / `continue-on-error`**。
- **红的强度没变**：它失败 ⇒ job 失败 ⇒ **整个 run failure**。
- **不碰 `MUST_FAIL_LOUDLY['ci.yml'] = ['gate']`**：挪到另一个 job 不在它射程内。
  `lint-workflows` **1726 条断言全过**（它把新 job 认了）。
- ★ **三态口径已同步**：`gate-summary` 改成 `needs: [gate, format]`，
  `GATE_STEP_FORMAT_CHECK` 读 `needs.format.result`。
  job result 与 step outcome 是**同一套词汇**，所以 `summarize-gate.mjs` **一个字没改**。

**反向验证了你点名那个风险**（喂进"gate 全绿 + 格式红"）：

```
结论：通过 8 / 失败 1 / 未验证 0（共 9）
⚠️ 未全部通过 —— 未验证不算通过，这一步会以非零退出。   exit=1
```

**汇总不可能在 run 红的时候说"通过"。** `selftest-summarize-gate` 27 条断言仍全过。

---

# 🔴 现在挡着全绿的唯一一条（**不是我的，我没动**）

```
Orphan-exports ratchet ✘
   零引用导出 70 个（基线 69 个）
   ✘ 1 个**新的**零引用导出：apps/web/src/features/tasks/api.ts :: JobsResponse
```

**来自 `e0ada01`（T-195，后端包卡片下载进度那一路）。** 证据：

- 那次提交把 `useJobsQuery` 提升到了 `apps/web/src/lib/api/jobs.ts`，
  而新位置用的是 **`@openmemo/shared` 的 `GetJobsResponse`**（`jobs.ts:18,26`）。
- 老的本地 `JobsResponse` 因此**没有消费方了**：全仓严格 grep（排除 `GetJobsResponse`）
  只剩**定义那一行**，外加 `dist-types` 里的产物副本 —— **真实引用 0 处**。

⇒ 看起来是**搬家之后留下的死类型**，不是"功能做了一半"。

⚠️ **但删别人的类型是语义改动，不是格式化，我不替那一路决定。**
棘轮自己给的三条出路（接上它 / 删掉它 / 登记进基线并写明理由）里，
证据指向**删掉**；`e0ada01` 那一路一句话我就能执行（约一分钟）。
⚠️ 棘轮的提示里明写「**别只为了让门禁变绿而登记**」，所以我也不会去动基线。

需要 Manager 决策: **`JobsResponse` 怎么处置**（删 / 登记 / 接上）——
这是三平台构建前的最后一格。

下一步建议:
1. 定了之后我立刻执行并盯到全绿，然后报你，你再让 `a6553151…` 触发构建。
2. ⚠️ 我**没有**触发任何构建、**没有**碰 release（按纪律）。

未做/未碰: `:10000`（`ff24098b` / pid 491899）没碰；没触发任何 workflow 构建；
没碰 `scripts/ci/verify-e2e-attestation.mjs` / `emit-e2e-attestation.mjs`（`a1f778cf…` 在动）；
别人在飞的 `e2e-import-audit.mjs` 没动；没用 `git stash` / `git checkout -- <file>` / `--amend`；
两次提交都带 pathspec、按 hash push 并 `merge-base --is-ancestor` 复核。

---

## [2026-08-10 19:20] ③ ✅ · CheckStatus 第四态 ✅ · ② 落地但**尚未生效** · ① 未做（撞到接缝）

交付（均已 push 并 `merge-base --is-ancestor` 复核）:
`f2dc294`（③）· `3d38f5f`（CheckStatus 第四态 + 前端）· `1e47907`（② + 共用判定）

# 逐条状态

| | 状态 | 说明 |
|---|---|---|
| ③ hw.cpu 硬件预言 | ✅ **已生效** | 措辞三句分开、`remediation` 置 null、第四态 |
| CheckStatus 第四态 | ✅ **已生效** | 含前端渲染（否则只修一半） |
| ② tool.* | ⚠️ **代码在，但production 里还没生效** | 见下 |
| ① 首屏横幅 | ❌ **未做** | 撞到同一个接缝，见下 |

## ③（`f2dc294`）

空的 `features` 有三个真实生产者（win32 PowerShell 被执行策略挡住 / 命令跑通没解析出东西 /
非三大平台 default 无条件 `[]`），而自检把它读成"测过了，没有"。
措辞按你的要求**三句分开**，用词抄 `FitBadge.tsx:99-105` 已经在用的那句，没重新发明；
`remediation` 置 `null`（原来那句不是动作，是结论）。

## CheckStatus 第四态（`3d38f5f`）

`'unavailable'` = **没有答案，也没有下一步**；`remediation` 必须为 null；
`counts` 单独一档（**不并进 warn**，并进去第三态就消失了）；`ok:` 判据不动。
⚠️ **没动 `notProbed()` 的 warn**（T-119：id 集合不变）。

★ **同时改了 `DiagnosticsPage`**：它的 `LevelIcon` 是"不是 ok 也不是 warn 就画红叉"，
新态不接的话 daemon 侧"不再永久红"那半**在界面上等于没做**。
⚠️ 顺带避开一个本仓栽过的坑：我先写的 `text-muted` **全仓零命中**，
而 Tailwind 对不存在的类不报错（⑤A-16）—— 改用真实在用的 `text-ink-muted`。

## ② —— 代码落地了，但**还没有人调它**（如实说）

`hasInstallablePackProviding()` 放在 `backends/applicability.ts`（**一处判定**，
①② 都该调它）；`SelfCheckProbes` 加了**可选** `canInstallBinary`；
`!found` 分叉、守卫齐全（判据钉**因果**而不是 `r.ok`，因为那个场景里本来就有别的 required 失败）。

⚠️⚠️ **但 daemon 还没有传这个探针**，所以线上行为**一个字都没变** ——
探针缺席时按设计退回原行为。**这正是本仓那条「算好发出、离终点一行被丢掉」**，
我不想让它以"已修复"的名义留在这儿，所以明说。

# 🔴 我撞到的接缝（① 和 ② 收尾共用同一个）

**`buildPipeline(paths: AppPaths)` 只拿得到 `paths`，拿不到后端目录。**
而 ①② 都需要问「目录里有没有一条装得到的包给出这个二进制」。三条路，代价不同：

| 方案 | 代价 |
|---|---|
| (a) 在 `buildPipeline` 里加载 catalog | 给**冷启动热路径**加一次清单 I/O + 一条新耦合；`buildPipeline` 目前是纯的 |
| (b) 在 `main.ts:484-496` 序列化 health 时算（那里可能已有 catalog） | `buildPipeline` 保持纯；但要确认 catalog 在那一刻真的可得 |
| (c) health 处理器里惰性算 | 每次轮询都算一次，或者要自己做缓存 |

**我倾向 (b)**，但没有验证 catalog 在 `main.ts` 那一刻是否已加载 —— **没验证的我不写**。

## ① 还剩什么（设计已就绪，含你标红的陷阱）

1. 用上面的判定把 `missing[]` 拆成"还装得到"与"本平台没有可下载的包"；
   🔴 **`asr-model` 必须排除在新态外** —— 模型不按平台圈定
   （只有可选的 `coreml-encoder` sidecar 带 `os: darwin`，ggml 底模没有平台字段）。
   否则一台没装模型的 Intel Mac 会被告知"本平台没有可下载的组件包"——
   **一句和正在修的那句一模一样形状的新假话。**
2. `PipelineBundle` + `main.ts:490` 的 health `pipeline` 多一个字段；
3. `ReadinessBanner.tsx:190` 那条 `tone:'critical'` 分叉：装不到时**不许**承诺下载量/耗时、
   **不许**把「去修复」指向 `/runtime`（那页会把这些包如实渲染成「其它平台」）；
4. 两份 locale **只新增 key**（三路正在动那两个文件）。

需要 Manager 决策: **接缝走 (a)/(b)/(c) 哪条**。定了我接着做 ①，并把 ② 的 daemon 侧一起接上
（两者共用同一处判定，本来就该一次接完）。

未做/未碰: `:10000` 没碰；没建/改/删 release、没打 tag、没触发构建；
没用 `git stash` / `git checkout -- <file>` / `--amend` / `-a`；
三次提交都带 pathspec、按 hash push 并 `merge-base --is-ancestor` 复核；
未跟踪的 `backendInstallAvailability.test.ts`（别人在飞、编译不过）没动；locale 一个字没改。

---

## [2026-08-10 22:05] 我那条红已清 —— 当前 master 的红换人了

交付: `63df9fd`（撤掉没有消费者的谓词，已 push 并 `merge-base --is-ancestor` 复核）

# 第一句：**我造成的那条红没了。** `[CI 实测 run 31395275433]` `✔ 没有新的零引用导出，基线也没有过期条目`

按你给的第 2 条走的：**把提交自洽掉，没有改基线把它"允许"掉**。
谓词会和它的消费者一起再提交 —— 那本来也是更好的历史。

⚠️ 你提醒的那行我记下了：`只有测试引用 16 个` —— **守卫测试不算消费者**，
所以"补几条腿"救不了孤儿棘轮。我没走那条歪路。

# 接缝：你裁的 (b) 我验了，结论是**它需要先解决一个时序问题**

按你的条件①先验证 —— **catalog 在自检跑的那一刻可能根本还没加载**：

```
models.ts:124   statePromise ??= RestState.create(deps)      ← 懒的
state.ts:643    注释原话「RestState.create() 是**懒的** —— 只在第一次命中
                /api/models/* 之类的路由时才真正执行」
```

`/api/selfcheck` 不走那条路由，所以它跑的时候 `backendCatalog` 可能是**未加载**状态。

⇒ **你的条件② 因此不是可选项，是承重的**：谓词返回值不能是 `boolean`。
把"没加载"当成"目录里没有" ⇒ 用户读到「本平台目前没有可下载的组件包」——
**一句因为时序意外而产生的、和我们正在修的那句一模一样形状的新假话。**
所以再提交时是 `'yes' | 'no' | 'unknown'`，调用方拿到 `unknown` **什么都不说，保持原样**。

⇒ 按你的条件①「未加载不许在那里补一次加载」：走法是从 `models.ts` 已有的
`statePromise` 上开一个**非强制的窥视口**（已加载就给、没加载就说 unknown），
**不新建缓存**（再造一份缓存 = 再造一份影子状态）。这两条我都写进了 `63df9fd` 的提交信息里，
免得下次又只落半边。

# 🔴 现在挡着 master 的是另一条，**不是我的**

```
✘ Test-file ratchet (守卫文件不许静默消失)
   + apps/daemon/src/http/rest/backendInstallAvailability.test.ts
   修法就一条命令：pnpm check:test-ratchet --update
   然后把 scripts/test-ratchet-baseline.json 一起提交。
```

**属于刚推 `16a5f42`（T-196 ④「install 闸门也读 availability」）的那一路** ——
那个测试文件是他们这次新加的，而这条棘轮**新增也要红**
（它自己的理由写得很好：基线不跟上新增，就永远保护不到「刚加进来、还没被任何人记住」
那一档 —— 而今天那次事故删掉的正是这一种）。

⚠️ **我没有替他们跑那条命令**，两个理由：
1. 那是他们的文件、他们的提交，一条命令而已；
2. ⚠️ 更要紧的：`check-test-ratchet` 扫的是 `git ls-files`（已跟踪文件）。
   此刻树上有多路**未提交**的新测试文件，谁去跑 `--update` 都应该**在自己那次提交的
   上下文里跑**，否则很容易把别人还没提交的东西一起写进基线 —— 那就是往一条
   反影子状态的守卫里种影子状态。

需要 Manager 决策: 把这条转给 `16a5f42` 那一路（一条命令 + 提交基线）。

# 我这边的下一步（等你放行）

接缝已经验清楚，① 和 ② 的 daemon 侧可以一次接完：
`hasInstallablePackProviding` 改三态 → 从 `models.ts` 开非强制窥视口 →
自检 `canInstallBinary` 接上 → `setup.ts` 拆 `missing[]`（🔴 **`asr-model` 排除在外**）→
横幅分叉（装不到时**不承诺下载量/耗时、不把「去修复」指向 `/runtime`**）→ locale 只新增 key。

未做/未碰: 没碰 release / v0.7.0 tag / 发版；没碰 `:10000`；
没用 `git stash` / `git checkout -- <file>` / `-a`；
提交带 pathspec 一步到位，`git show --stat` 复核只含我那一个文件；
别人在飞的 `backends.ts`（TS18047）、未跟踪的那些测试文件一个都没动。
