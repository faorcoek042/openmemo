# inbox / path-guard

## [2026-08-04 01:20] T-143 DONE

交付（**精确清单，未使用 `git add -A`**）：

| 文件 | 动作 | 归属 |
|---|---|---|
| `packages/runtime/src/assetPaths.ts` | 改（① realpath 复核 + `escaped` 字段） | **工作区** |
| `packages/runtime/src/assetPaths.test.ts` | 改（+6） | **工作区** |
| `packages/runtime/src/selfcheck.ts` | 改（① 越界分档） | **工作区** |
| `packages/runtime/src/selfcheck.test.ts` | 改（+1） | **工作区** |
| `packages/pipeline/src/subprocess/argGuard.ts` | 改（② platform 入参） | **工作区** |
| `packages/pipeline/src/subprocess/__tests__/argGuard.test.ts` | 改（+6） | ⚠️ 已被 `4ee1f4a`(T-142) 带走 |
| `apps/daemon/src/bootstrap/entrypoint.ts` | **新增**（③） | ⚠️ 已被 `4ee1f4a`(T-142) 带走 |
| `apps/daemon/src/bootstrap/entrypoint.test.ts` | **新增**（+10） | ⚠️ 已被 `4ee1f4a`(T-142) 带走 |
| `apps/daemon/src/main.ts` | 改（③ 用 `isDirectRun`） | ⚠️ 已被 `35a2635`(T-139) 带走 |
| `apps/daemon/src/http/media.ts` | 改（① 403 分支） | ⚠️ 已被 `35a2635`(T-139) 带走 |
| `apps/daemon/src/http/media.test.ts` | 改（+4） | ⚠️ 已被 `35a2635`(T-139) 带走 |
| `apps/daemon/src/storage/migrateAssets.ts` | 改（④ 分隔符） | ⚠️ 已被 `35a2635`(T-139) 带走 |
| `apps/daemon/src/storage/migrateAssets.test.ts` | 改（+6） | ⚠️ 已被 `35a2635`(T-139) 带走 |

---

# TL;DR

1. **① 的可利用性，准确结论：不能被外部访问者直接触发，但它是一个真实的"第二级放大器"。**
   我**真的复现了越界读取**（走产品的 HTTP 路由，把 `/etc/passwd` 从 `/media/asset/<ulid>`
   以 **200** 原样流了出来），修复后同一条路径 **403**。
   但**要走到那一步需要先具备两样东西里的任意一样：往数据目录里写一条软链的能力，
   或者数据库写权限。** 这两样，**一个鉴权关闭、绑 0.0.0.0 的外部 HTTP 访问者都没有**
   —— 我逐条追了 rel_path 的三个写入方、上传路由、导入路由和解包路由（§1）。
   **所以：这不是"demo 正在往公网漏 /etc/passwd"。** 它是"任何人只要往数据目录里
   放进一条软链（本地用户、恢复的备份、被污染的上游包），就能把它变成
   **无鉴权、带 Range 的任意文件读**"。值得修（守卫就 5 行），**但不值得当成正在被利用的漏洞报**。

2. **② 的结论要更正 platform 报告里的一句措辞。** `assertWithinRoot` 的 UNC 分支
   **在 Windows 上是会触发的**（那儿 `process.platform === 'win32'`）——
   它不是"Windows 没有防护"。真正的缺陷是**这条安全分支在 Linux 上不可达，因此从写下来
   就没有被任何东西执行过一次**，与假绿灯第 8 例**形状完全相同**。已把 platform 提成入参，
   6 条 win32 用例第一次在本机跑起来。

3. **同族全仓扫描（§4）：只有 2 处做解析后复核（realpath），其余 7 处路径边界判定全是词法的。**
   顺手抓到 **3 条 platform 那份 49 行清单里没有的**：
   - 🔴 **`notes.ts:186` 的 `importRoots` 闸门把 `/` 写死了 → Windows 上本地文件导入（F2）100% 返回 403**（`[实测]` 用 `path.win32` 复刻）；
   - 🔴 **`unpack.ts:201` 的软链目标校验是词法的**，`s→.` 加 `evil→s/../OUTSIDE.txt` 能骗过它（`[实测]` 词法说"在 destRoot 内"，内核真的读到了 destRoot 外的文件）；
   - 🟡 **`selfcheck.ts:390` 的前缀比较没有分隔符边界**，`/models-backup` 被算成 `/models` 内（`move.ts:82` 的注释亲口写过这个坑）。

4. **四条修复各自的反向验证都拿到了真红灯，输出在 §3。** 变异一律做在 `/tmp` 的副本上
   ——**因为今天有并行 agent 在重建共享 dist**，我第一次的"修复前"实测就是这么被污染的（§5）。

5. **门禁**：`tsc -b` **exit 0** · `eslint .` **exit 1，但唯一那条错在 `scripts/mutation-check.mjs`
   （`test-gaps` 的在飞文件，我没碰过 `scripts/`）**，排除它后 exit 0。
   db 47 / runtime 45 / pipeline 138 / llm 18 / mindmap 42 / daemon 269 / web 94+10+202 —— **全部 0 failed**。
   我新增 **34 条**（runtime +7、pipeline +6、daemon +21）。

6. ⚠️ **`git add -A` 第六、第七次**：我的 8 个文件被 `4ee1f4a`(T-142) 与 `35a2635`(T-139)
   两次提交扫了进去。**T-142 和 T-139 的提交里含有 T-143 的代码**，合并时请知悉。

---

# §1 ① 的可利用性 —— 逐条追出来的结论

## 1.1 机制（这一半是真的，我复现了）

`assetCandidates` 的越界剔除是**纯字符串**运算（`resolve` 按字面折叠 `..`），
而 `open()` 走文件系统、**跟随符号链接**。两者对同一条路径给出相反答案：

```
<mediaRoot>/escape.wav -> /etc/passwd
  字符串层面：落在 mediaRoot 内 ✅
  open() 打开的：/etc/passwd
```

`[实测]` 走**产品真实 HTTP 路由**（`createMediaRoutes` + 真 `http.Server`），修复前：

```
对照：普通文件          good.wav      -> 200  "RIFFGOODAUDIO"
攻击A：资产是软链       escape.wav    -> 200  🔴 越界读取成功："root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1:..."
攻击B：祖先目录是软链   outdir/passwd -> 200  🔴 越界读取成功："root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1:..."
对照：合法两级相对软链  libwhisper.so -> 200  "ELFWHISPER"
```

修复后，同一份数据目录、同一批 uid：

```
对照：普通文件          good.wav      -> 200  "RIFFGOODAUDIO"
攻击A：资产是软链       escape.wav    -> 403  ASSET_OUT_OF_ROOT ...escapes media root via symlink
攻击B：祖先目录是软链   outdir/passwd -> 403  ASSET_OUT_OF_ROOT
对照：合法两级相对软链  libwhisper.so -> 200  "ELFWHISPER"      ← 没被误杀
```

> 顺带更正一个细节：platform 报的是 `/etc/hostname`，**本机那个文件是空的**（0 字节），
> 所以拿它当证据看不出"泄漏了什么"。我换成 `/etc/passwd`，证据是**逐字节比对的内容**。

## 1.2 攻击者怎样才能让一条指向外部的软链落进数据目录？

| 路径 | 能不能 | 依据 |
|---|---|---|
| **`unpack.ts` 解压上游包时写软链** | **能，但需要先控制那个包** | `unpack.ts:170-205` 的 `resolveLinkTarget` **是 target-based 校验**：绝对目标拒、词法解析出 destRoot 的拒。直白的 `evil -> /etc/passwd` 进不来。**但校验是词法的**，见 §4-B2：`s→.` 配 `evil→s/../OUTSIDE.txt` 能骗过它 `[实测]`。而包的 URL 与 sha256 **钉死在 `vendor/manifests/`**，`ALLOWED_DOWNLOAD_HOSTS` 白名单，**全仓没有任何端点接受用户提供的 URL 或 manifest** `[实测 grep]` → 需要污染上游产物或改盘上的 manifest |
| **`media_assets.rel_path` 由谁写入** | **全部由服务端生成，HTTP 客户端一个字都控制不了** | ① `transcribe.ts:298` → `archiveIntoMedia` 产出 `<noteUid>/<basename>`；② `recorder.ts:270` → 服务端拼的绝对路径；③ `migrateAssets.ts` → 重写既有行。**上传路由 `upload.ts:559` 的磁盘名是 `ulid() + 白名单扩展名`，注释亲口写着「与客户端输入**完全无关**」** `[读码]` |
| **让迁移把记录重挂到一条软链上** | **不能** | `indexFiles`（`migrateAssets.ts:76`）用的是 `dirent.isFile()`，**对软链为 false**（dirent 是 lstat 语义）→ 软链根本不进索引 `[读码]` |
| **`POST /api/notes/import` 指向一条软链** | 闸门本身挡不住，**但下游有 realpath 兜底** | `notes.ts:186` 是**词法**前缀比较且 `importRoots[0] = paths.dataDir`（`main.ts:781`）→ 软链能过这道。但 `localFile.ts:154` 紧接着调**基于 realpath 的** `assertWithinRoot(dataDir, input)`（`setup.ts:219` 传的就是同一个根）→ 被挡住 `[读码]` |

## 1.3 直接回答你的问题

> **「demo 绑 0.0.0.0、鉴权已关（`authMode()` 默认就是 `none`，`auth.ts:52`）、NAT 外可达 `:10000`。
> 不具备数据库写权限的外部访问者能不能触发？」**

**不能。** 我没有找到任何一条路径，能让一个**只有 HTTP** 的外部访问者做到下面任意一件事：

- 在数据目录下**创建一条软链**（上传写的是普通文件、名字是 ulid；解包要先控制钉死 sha256 的包）；
- **选择或写入 `rel_path`**（`/media/asset/<ulid>` 只接受 ULID，**从设计上就不接受路径参数**）。

**所以准确的表述是**：① 是一条**需要前置能力**才能利用的缺陷。
前置能力 = 「往数据目录里放进一条指向外部的软链」。谁具备？本地用户、
一次从别处恢复/rsync 过来的数据目录、被污染的上游产物、或者已经拿到文件写权限的攻击者。
**具备之后**，它把这条软链放大成 **无鉴权、支持 Range、可反复读的任意文件读**
（daemon 的 uid 能读的一切；demo 跑在 root 下）。

**我不打算把它说得更重**：说"外部访问者现在就能拖走 `/etc/passwd`"是不成立的。
**也不打算说得更轻**：机制是真的、复现是真的、守卫只有 5 行、而
`argGuard.assertWithinRoot` 从第一天起就是 realpath 的 —— 这份规则只是**漏学了同一课**。

---

# §2 四条改了什么

## ① `assetPaths.ts` —— 打开之后再 realpath 复核一次

`probeAssetFile` 在 `open()` 成功之后加一句 `realpath`，落到根外就拒掉并记进新字段 `escaped`。

**三个刻意的设计，每个都有用例钉住：**

1. **判据是"解析结果在不在根内"，不是"路上有没有软链"** —— 按类型一刀切会把产品自己的
   后端拆掉。`libwhisper.so → .so.1 → .so.1.9.1` 两级相对链**照常 200**，
   `selfcheck.test.ts` 里 T-128 那 6 条**一条没动、全绿**（§3 附输出）。
2. **`realpath` 跟完整条路** —— 祖先**目录**是软链同样挡住，不是只看最后一段。
3. ⚠️ **根也必须 realpath。** 这是加守卫时最容易自伤的一步：拿 `realpath(候选)` 去比
   **词法的**根，只要数据目录自己是经由软链访问的（macOS 的 `os.tmpdir()` = `/var/…` →
   `/private/var/…`；`/home → /mnt/home` 这类布局也很常见），**整个媒体库当场全 403**。
   我第一版就是这么写的，靠自己加的那条用例抓住的。单独有变异体验证（§3）。

**残留 TOCTOU 如实记下**：realpath 与调用方随后的 `createReadStream(abs)` 之间仍有窗口。
收窄它要把 fd 一路传给调用方，那是另一次改动；现在它与 `assertWithinRoot` **处在同一水位**
（D-06 §9 已记录该性质）。**我刻意没有把 `abs` 改成 realpath 的值** —— `migrateAssets.ts:142`
拿 `.abs` 去算要写回数据库的 `rel_path`，改它的含义就等于**动用户的库**。

**连带改了两个调用方，因为不改它们就会说假话**（⑤A-20 规矩 3）：

- `media.ts`：软链出界报 **403 ASSET_OUT_OF_ROOT**，不许报成 404「文件不存在」——
  文件明明在，只是不许从这里读。
- `selfcheck.ts`：软链出界算进 **`assetsContained` 的 fail**。不改的话它会
  **一边报「N 条资产全部落在 dataDir 内」，一边指着一条指向 `/etc` 的软链** ——
  正是本项目定义的最贵那种假红灯：**结论对、理由假**。变异体输出见 §3。

## ② `assertWithinRoot` —— platform 提成入参

```ts
export async function assertWithinRoot(managedRoot, candidate, platform = process.platform)
```

照抄 `isSafeExecutable` 的形状。同时：

- 词法运算全部换成 `platform === 'win32' ? win32 : posix` 的那一份；
- **`import { isAbsolute, posix, relative, resolve, win32 }` 改成 `import { posix, win32 }`** ——
  宿主绑定的那三个名字**不在作用域里，就不会被顺手用上**。判据不是"要记得别用"，
  是"用错了也做不到"；
- 顺手修了 `realpathOrResolve` 里一个只有跨平台才显形的 bug：它在 fallback 里调**宿主的**
  `resolve(p)`，会把 `C:\root\x` 改写成 `<cwd>/C:\root\x`。现在收已解析的绝对路径、原样返回。

### ⚠️ 我要更正 platform 报告里的一句措辞

它写的是「`assertWithinRoot` 还在读宿主 `process.platform` —— 正是 `isSafeExecutable` 刚修掉的那个 bug」，
并给出实测 `UNC -> {"ok":true}`。**这个实测是真的，但它的含义不是"Windows 上没有防护"**：

- **在 Windows 上，`process.platform` 就是 `'win32'`，那条 UNC 分支照样触发。** 从来不是 Windows 上的洞。
- **在 Linux 上分支不可达**，`\\server\share\evil` 被解析成 `<root>/\\server\share\evil` ——
  一个**名字里带反斜杠的文件，仍然在根内**。古怪，但**不是越界**。

所以这一条的实质是：**一条安全分支从写下来那天起没有被任何东西执行过一次**。
这正是假绿灯第 8 例的形状（`.bat` 测试"因为错误的理由通过"），也值得同一个修法。
我把这半句话本身写成了一条用例（`★ under posix rules the same UNC string is merely a weird filename`），
免得下一个人只读到"UNC 被判成合法子路径"就以为 Linux 上有洞。

## ③ `main.ts:1075` —— 具体形态查清了，是**五种**，不是一种

原写法 ``import.meta.url === `file://${process.argv[1]}` `` 是**手拼** URL 而不是**转换** URL。
`[实测]` 本机 Linux x64，逐个目录名跑真 Node：

| 目录名 | `import.meta.url` | 手拼结果 | 匹配 |
|---|---|---|---|
| `plain` | `…/plain/probe.js` | 同左 | ✅ |
| `my dir` | `…/my%20dir/probe.js` | `…/my dir/probe.js` | 🔴 |
| `笔记` | `…/%E7%AC%94%E8%AE%B0/…` | `…/笔记/…` | 🔴 |
| `a#b` | `…/a%23b/probe.js` | `…/a#b/probe.js` | 🔴 |
| `a?b` | `…/a%3Fb/probe.js` | `…/a?b/probe.js` | 🔴 |
| `a%b` | `…/a%25b/probe.js` | `…/a%b/probe.js` | 🔴 |

**不止空格和中文**：`#` `?` `%` 在 URL 里各有语法含义，各自中招，成因不是同一个"忘了编码空格"。

**而且 `pathToFileURL` 一个人修不好第二种形态**：`import.meta.url` 是**解析过软链**的真路径，
`process.argv[1]` 是用户敲的那条。经由启动软链调用（`/usr/local/bin/openmemo → …/dist/main.js`，
包管理器与安装包的标准做法）时两者天生不同 `[实测]`：

```
argv[1]         = /tmp/…/link.js
import.meta.url = file:///tmp/…/plain/probe.js     ← 已经 realpath 过
旧写法匹配? 🔴    只换 pathToFileURL 仍然 🔴
```

所以修法是 `pathToFileURL` **再加一次 realpath 比对**，提成 `bootstrap/entrypoint.ts` 的纯函数
`isDirectRun(moduleUrl, argv1)` —— **提成函数是为了让它能被测试执行**：
`main.ts` 一被 import 就会拉起整条启动链，那意味着这一行**只能靠人肉验证**，
而这正是它坏了这么久没人发现的原因。

**端到端实证（跑的是真 daemon，不是纯函数）**，同一条命令、同一个含空格的路径：

```
A) 修复前：node "/tmp/path-guard/sp/my dir/dist/main.js" --port 18143 --data-dir …
   退出码 = 0
   标准输出/错误行数 = 0
   数据目录里建了东西吗：（空）
   → 打印零行、退出码 0、什么都没启动。systemd/launchd 下表现为「服务反复"成功"退出」。

B) 修复后：同一条命令
   [daemon] 就绪 http://127.0.0.1:18143/#t=…
   GET /api/health -> 200
```

## ④ `migrateAssets.ts:93` —— 这里有**两个**分隔符 bug，不是一个

```ts
const parts = abs.split('/').filter(Boolean);   // ← 只是第一个
...
if (all.has(cand)) return cand;                 // ← 第二个在这
```

1. `split('/')` 切不开 `C:\dd\tmp\job\a.wav`（只切出 1 段）；
2. **就算切开了**，比对的另一方 `all` 里存的是 `relative()` 产出的**宿主分隔符**路径
   （Windows 上是 `tmp\job\a.wav`），而候选是用 `/` 拼的 → `all.has()` **永不命中**。

**只修第 1 条，函数照样永远返回 undefined，而且看起来像是修好了。**
现在两边都归一化，用归一化后的键去查，**返回的仍然是索引里的原始条目**
（调用方要 `join(dataDir, hit)`，形态必须与文件系统一致 —— 单独有用例钉这一点）。

分隔符做成**入参**（默认宿主 `sep`），照抄 `downloader/store.ts:63` `defaultModelsRoot`
—— platform 报告认定的**全仓唯一**把平台做成参数的地方。不这么写，Windows 那半边就只能
靠一台 Windows 真机验证，也就是永远不会被验证。

**「迁移后仍能解析」的覆盖**：`migrateAssets.test.ts` 原有 8 条断言的判据就是
`readViaProduct()`（走播放端那份解析规则真的读回内容），**8 条一条没动、全绿**；
我新增的 6 条钉 Windows 那半边 + 一条**"posix 行为一个字都不许变"**（这是用户库真正跑的那条）。

---

# §3 反向验证 —— 五个变异体，全部真红

**变异一律做在 `/tmp` 的副本上，不动仓库共享 dist**（原因见 §5）。
每次都先证明「我即将运行的产物里，坏的那行在/不在」。

### 变异 1 —— ① 的守卫整段删掉
```
=== 我即将运行的产物里，守卫还在不在？（0 = 已删掉） ===  0
控制组（未变异的同一份副本）：tests 17 / pass 17 / fail 0

✖ ★ 根内的软链指向根外 → 拒绝，且根外内容一个字节都不出来
    AssertionError: 越界的软链不许被选中
    + '/tmp/om-ap-pgcwyb/media/escape.wav'
    - null
✖ ★ 祖先**目录**是软链同样挡住（realpath 要跟完整条路，不是只看最后一段）
✖ ★ 越界候选之后还有能用的候选 → 不许因为前面那条被拒就整条记录失败
✔ ★ 合法的两级相对软链照常解析（`libwhisper.so → .so.1 → .so.1.9.1`，T-128 那 8 条）
✔ ★ 数据目录本身经由软链访问时**不许全盘误杀**（macOS 的 /var → /private/var 形态）
ℹ tests 17 / pass 14 / fail 3
```
（后两条在变异体下仍绿是**对的** —— 它们钉的是"别误杀"，不依赖这段守卫。）

### 变异 2 —— 只撤掉「根也要 realpath」那一半
```
=== 根 realpath 还在不在？（0 = 已撤掉） ===  0
✖ ★ 数据目录本身经由软链访问时**不许全盘误杀**（macOS 的 /var → /private/var 形态）
ℹ tests 17 / pass 16 / fail 1
```

### 变异 3 —— ② 的 platform 退回读宿主
```
变异体 platform 入参命中数 = 0     宿主读取命中数 = 1
真产物 platform 入参命中数 = 1     宿主读取命中数 = 0
控制组：tests 32 / pass 32 / fail 0

✖ ★ UNC path is rejected under win32 rules
✖ ★ drive-relative path is rejected under win32 rules
✖ ★ absolute drive path outside the root is rejected under win32 rules
✖ ★ a legitimate win32 child is still accepted (the guard must not reject everything)
ℹ tests 32 / pass 28 / fail 4
```
> 如实说明：我写的 5 条 win32 用例里，**「反斜杠 `..` 穿越」那条在变异体下仍然绿** ——
> posix 规则下 `..\..\Windows\win.ini` 恰好也以 `..` 开头，于是**因为正确的结果、错误的理由**通过。
> 它钉住了行为，但**不是这条修复的鉴别器**。剩下 4 条是。

### 变异 4 —— ③ 退回手拼 `file://`
```
变异体里的实现（肉眼可核）：
  return Boolean(argv1) && moduleUrl === `file://${argv1}`;
控制组：tests 10 / pass 10 / fail 0

✖ 空格 → daemon 必须仍然启动
✖ 中文 → daemon 必须仍然启动
✖ 井号（URL 里是 fragment 分隔符） → daemon 必须仍然启动
✖ 问号（URL 里是 query 分隔符） → daemon 必须仍然启动
✖ 百分号（URL 里是转义引导符） → daemon 必须仍然启动
✖ ★ 经由软链调用：`pathToFileURL` 一个人也修不好，必须再比一次 realpath
ℹ tests 10 / pass 4 / fail 6
```

### 变异 5 —— ④ 的 `matchBySuffix` 退回 `split('/')`
```
--- 我即将运行的产物里的实现 ---
101:function matchBySuffix(abs, all, pathSep = sep) {
102-    const parts = abs.split('/').filter(Boolean);
控制组：tests 14 / pass 14 / fail 0

✖ ★ 失效的 Windows 绝对路径 → 按最长后缀找回来（旧写法在这里永远返回 undefined）
✖ ★ 返回的是**索引里的原始条目**（调用方要拿它 join，形态必须与文件系统一致）
ℹ tests 14 / pass 12 / fail 2
```

### 变异 6 —— `selfcheck` 的「软链出界算越界」这一档删掉
```
=== 该分支还在吗（应为 0）: 0
✖ ★ 根内的软链指向根外 → assetsContained 必须报 fail，不许说"全部落在 dataDir 内"
    AssertionError: 软链出界必须算越界：2 条资产全部落在 /tmp/om-sc-assets-k68VtY 内
    'ok' !== 'fail'
```
**那句 `2 条资产全部落在 … 内` 就是它会说出口的假话**，而其中一条是指向 `/etc` 的软链。

### T-128 那 8 条 `.so` 没有被误杀（用户点名要保的）
```
▶ ★ T-128 后端 .so 符号链接可解析
  ✔ 两级相对链完好 → 全部读得到内容
  ✔ ★ 链接指向已消失的旧数据目录 → 必须报读不到（事故的精确形态）
  ✔ ★ 悬空链接的 lstat 是成功的 —— 证明"组件存在"这个判据本身就是假绿灯
  ✔ ★ 断链 → runSelfCheck 报 fail，且 remediation 指出是搬家造成的
  ✔ 链接完好 → ok
  ✔ ★ 没装后端包 → warn 而不是 fail
```

### 断言写法：钉结构，不钉关键词（今天已经踩了三次的那个坑）
- ① / media / selfcheck 的判据一律是**「根外那份文件的字节有没有出现在返回值/响应体里」**，
  用一个独一无二的串（`SECRET-OUTSIDE-ROOT`）反查 —— **不是**匹配 note 里的某个词。
- ③ 的期望值由 `node:url` 的 `pathToFileURL` **独立算出来**，不重复被测代码的写法
  （否则只能证明"我写的和我写的一样"）；每条还**先断言旧写法确实失配**，
  免得哪天 Node 改了行为、用例静默变成空断言。
- ④ 的 Windows 用例**先就地复刻一遍旧实现并断言它返回 `undefined`**，证明这条用例钉的不是零。
- 全程没有 `assert.equal(domNode, null)`（PROTOCOL §8）。

---

# §4 同族全仓扫描 —— **我是怎么扫的**，以及扫出了什么

## 4.1 方法（五轮 grep，每轮的口径写在这里备查）

| # | 扫什么 | 命令口径 | 命中 |
|---|---|---|---|
| 1 | 宿主 `process.platform` / `os.platform()` | `grep -rn "process\.platform\|os\.platform()"` 于 `apps/*/src packages/*/src`，排除 `*.test.ts` 与 `__tests__` | **38 处** |
| 2 | 宿主绑定的 `isAbsolute` / `relative`（排除已显式限定 `win32.` / `posix.` 的） | 同上 + `grep -v "win32\.\|posix\."` | **27 处** |
| 3 | 对文件系统路径 `split('/')` / `split(sep)` | 同上 | **11 处** |
| 4 | **词法边界检查**（`startsWith(<root>)`）—— ① 的同族 | `grep -rn "startsWith(.*[Rr]oot\|startsWith(dataDir\|startsWith(destRoot\|startsWith(base"` | **9 处** |
| 5 | 谁做了**解析后复核**（`realpath`） | `grep -rn "realpath"` | **2 处** |

> ⚠️ **扫描过程中被工具骗过一次，如实记下**：`packages/pipeline/dist/subprocess/argGuard.js`
> 里 `CONTROL_CHARS = /[<裸控制字节>]/` 让 `file(1)` 把它判成 `data`，于是
> **`grep` 静默跳过整个文件**（无输出、exit 1，看起来就像"0 命中"）。
> 我最初那几次「产物里有没有坏行」的核对因此**什么都没验到**。必须加 `-a`。
> **这条正好打在本项目最依赖的那条纪律上（"反向验证前先 grep 确认坏行在产物里"）——
> 校验工具本身可以静默失灵。** 建议写进 HANDOFF。

## 4.2 结论：**只有 2 处做解析后复核，7 处路径边界判定全是词法的**

| 位置 | 词法/realpath | 判断 |
|---|---|---|
| `packages/pipeline/src/subprocess/argGuard.ts` `assertWithinRoot` | ✅ realpath | 从第一天就对 |
| `packages/runtime/src/assetPaths.ts` `probeAssetFile` | ✅ realpath | **本轮补上（①）** |
| `apps/daemon/src/http/rest/notes.ts:186` | 🔴 词法 + 写死 `/` | 见 A1 |
| `packages/downloader/src/unpack.ts:162,201` | 🔴 词法 | 见 A2 |
| `apps/daemon/src/http/static.ts:83` | 🟡 词法（用了 `sep`） | 静态目录里若有指向外部的软链会被服务出去。风险低（`dist` 是我们自己产的），但同族 |
| `packages/downloader/src/store.ts:336` | 🟡 词法（用了 `sep`） | 安装记录越界检查 |
| `packages/runtime/src/selfcheck.ts:390` | 🔴 词法 + **没有分隔符边界** | 见 A3 |
| `apps/daemon/src/storage/migrateAssets.ts:202,265` | 🟡 词法（用了 `sep`） | 有边界，词法层面正确 |
| `apps/daemon/src/storage/move.ts:86` | 🟡 `relative()` 判定 | `:82` 的注释明确说明**为什么不用前缀比较**，是全仓写得最讲究的一处 |

## 4.3 platform 那份 49 行清单里**没有**的三条新发现

### 🔴 A1 —— `notes.ts:186`：`importRoots` 闸门把 `/` 写死了 → **Windows 上 F2 本地导入 100% 失败**

```ts
const ok = deps.importRoots.some((root) => real === root || real.startsWith(root + '/'));
```

`[实测]` 用 `path.win32` 复刻，输入是**数据目录里一个完全合法的文件**：

```
root  = C:\Users\me\openmemo-data
input = C:\Users\me\openmemo-data\clip.mp3
real  = C:\Users\me\openmemo-data\clip.mp3
产品的判据 real===root || real.startsWith(root+"/")  => false
=> 🔴 403 PATH_NOT_ALLOWED —— Windows 上本地文件导入(F2)100% 不可用
对照：用 root + win32.sep 判 => true
```

**这条比 platform 报告里的 `migrateAssets` 那条严重**：那条是"资产迁移静默失效"，
这条是**一个主功能（F2 本地文件导入）在 Windows 上必然报 403**。
同时它**还缺 realpath**（① 的同族），只是被下游 `localFile.ts:154` 的
`assertWithinRoot` 兜住了（§1.2）。

> **我没有改它** —— `apps/daemon/src/http/rest/notes.ts` 正在被 `notes-contract` 现场编辑
> （`git status` 显示 M，且已进 `35a2635`）。改它一定撞车。

### 🔴 A2 —— `unpack.ts:201`：软链目标校验是**词法**的，能被中间软链骗过

`path.resolve` 按字面折叠 `..`，**文件系统不折叠**。`[实测]`：

```
destRoot      = /tmp/pg-unpack-jN3sWW/dest
归档里的条目1 : s     -> "."                    （词法 = destRoot 本身 → unpack 判定允许）
归档里的条目2 : evil  -> "s/../OUTSIDE.txt"
unpack.ts:201 的词法判据 → 落在 destRoot 内吗: true  ( /tmp/…/dest/OUTSIDE.txt )
内核实际读到的内容: "I-AM-OUTSIDE-DESTROOT"        ← destRoot 之外的文件
```

**利用前提**：要能控制那个归档 —— 而 URL + sha256 钉死在 `vendor/manifests/`、
host 走白名单、**没有任何端点接受用户提供的 URL** `[实测 grep]`。
所以这是**供应链方向**的缺陷，不是远程可达的洞。**我没有改它**（属 `packages/downloader`，
且修法要么改成解压后逐条 realpath 复核、要么禁掉链接指向链接，需要单独设计）。

> 副产品：**`fs.realpathSync` 在这个形状上与内核不同调** —— 内核读得到，
> Node 的 realpath 报 ENOENT `[实测]`。我在 ① 里用的 `fs.promises.realpath`
> 因此可能对某些路径抛错；代码里那条 `catch` **是 fail-closed 的**（拒掉该候选），
> 方向是安全的；而且 `assetCandidates` 的输出**永远不含 `..`**（`resolve` 已折叠），
> 不会踩到这个形状。

### 🟡 A3 —— `selfcheck.ts:390`：前缀比较**没有分隔符边界**

```ts
const fromStore = (p) => p !== null && p.startsWith(input.storeRoot);
```
`[实测]`：
```
/root/data-memo/models/asr/x.bin          startsWith(storeRoot) = true
/root/data-memo/models-backup/asr/x.bin   startsWith(storeRoot) = true   🔴 -backup 被算成 store 内
```
**`move.ts:82` 的注释亲口写过这个坑**：「用 `relative()` 而不是字符串前缀比较：
`/data` 与 `/data-backup` 前缀相同但毫无关系」—— **同一个仓库里，一处知道、一处不知道。**
后果是分类错误（把 `models-backup` 里的工具报成"装在 dataDir 里"），不是安全边界。
**我没有改它**：它在 `selfcheck.ts`（热区），本轮我已经为 ① 动过该文件一次，
再叠一个无关改动会让这次改动难以审阅。

## 4.4 第二类：宿主 `platform` 决定**路径语义**（②/④ 的同族）

38 处 `process.platform` 里，绝大多数读宿主是**正确的**（选 `.so/.dll/.dylib` 后缀、
`.exe` 后缀、信号语义、env 白名单、chmod、mmap —— 代码就跑在那台机器上）。
**真正属于这一族的是「用宿主平台去解释一段可能来自别处的路径」或「分支在本机永不可达因而从未被执行」**：

| 位置 | 状态 |
|---|---|
| `argGuard.ts` `isSafeExecutable` | ✅ 已修（假绿灯 #8） |
| `argGuard.ts` `assertWithinRoot` | ✅ **本轮修（②）** |
| `migrateAssets.ts` `matchBySuffix`/`matchByTail` | ✅ **本轮修（④）** |
| `downloader/store.ts:63` `defaultModelsRoot(platform = …)` | ✅ 原本就对 —— **全仓的正确范式** |
| 🔴 `apps/daemon/src/config/paths.ts:28,32` | **未修**：三平台数据根推导，只读宿主、无入参 |
| 🔴 `packages/pipeline/src/tools.ts:100,104` | **未修**：**同一件事的第二份拷贝**，同样无入参 |
| 🔴 `packages/runtime/src/assetPaths.ts:58` | **未修**：`isAbsolute` 宿主绑定（platform #8）。属跨平台，按用户裁定未动 |
| 🔴 `packages/pipeline/src/media/sources/localFile.ts:51` | **未修**：`isAbsolute` 宿主绑定 |
| 🟡 `runtime/probe/runProbe.ts:193` | 路径**列表**分隔符（`;` vs `:`），只喂给 `LD_/DYLD_` → Windows 上是死代码 |
| 🟡 `main.ts:627`、`transcribe.ts:185` | `modelPath.split('/').pop()` 对**文件系统路径**硬编码 `/` —— ④ 的同族，Windows 上"模型 id"会显示成整条路径。**显示层，未修** |

> **`paths.ts:28` 与 `tools.ts:100` 是同一段逻辑的两份拷贝，而 `store.ts:63` 是第三份、
> 且只有它做对了。** 这一族的根治不是逐个加入参，是**把三份合成一份带 platform 入参的**。
> 那会动到 `apps/daemon` 与 `packages/pipeline` 的启动路径，**超出 T-143 的范围，我没有做。**

---

# §5 一件必须报出来的事：并行 agent 重建了共享 dist，污染了我第一次的"修复前"实测

我按纪律先 `grep` 了 `packages/runtime/dist/assetPaths.js`，确认**没有** `realpath`（= 修复前的产物），
然后跑复现脚本 —— **结果直接是 403**。追下去发现：

```
packages/runtime/src/assetPaths.ts   00:44:57   ← 我改源码
packages/runtime/dist/assetPaths.js  00:45:54   ← 别人跑了一次构建，把我的在飞改动编了进去
apps/daemon/dist/http/media.js       00:45:55
```

**grep 的那一刻产物是旧的，跑脚本的那一刻已经是新的。** 纪律本身没错，
但它默认「产物只有我在动」——**这台机器上不成立**。

所以后面所有反向验证我都改成：**把 dist 复制到 `/tmp/path-guard/` 再变异**，
用一个 ESM `resolve` hook 把 `@openmemo/runtime` 指到副本，**仓库共享产物全程零改动**。
副作用是别人也不会因为我的变异体而看到假红灯。

> **建议加进 PROTOCOL**：变异/反向验证**不要在仓库的 dist 上做**，
> 复制到自己的 `/tmp` 目录再改。理由不是"怕自己忘了还原"，是
> **"还原之前的那几十秒里，别人的门禁跑在你的变异体上"**，而且双方都不会知道。

---

# §6 门禁数字

```
tsc -b     exit 0
eslint .   exit 1  ⚠️ 唯一一条错在 scripts/mutation-check.mjs:276 'mkdirSync' is not defined
                      —— test-gaps 的在飞文件（01:07 修改），我全程没碰过 scripts/。
                      --ignore-pattern 排除它之后 exit 0。
packages/db        tests 47  pass 47  fail 0
packages/runtime   tests 45  pass 45  fail 0   （38 → 45，+7 是我）
packages/pipeline  tests 138 pass 138 fail 0   （132 → 138，+6 是我）
packages/llm       tests 18  pass 18  fail 0
packages/mindmap   tests 42  pass 42  fail 0
apps/daemon        tests 269 pass 269 fail 0   （235 → 269，其中 +21 是我）
apps/web           tests 94 + 10 + 202，全部 pass，fail 0
```

**我新增 34 条**：assetPaths +6 · selfcheck +1 · argGuard +6 · entrypoint +10 · media +4 · migrateAssets +6。

**关于基线 641**：开工时我实测的非 web 合计是 **512**（db47/runtime38/pipeline132/llm18/mindmap42/daemon235），
现在是 **555**。差额 43 里 **34 条是我**，其余是 `notes-contract` 与 `test-gaps` 同期加的。
`apps/web` 现在是 306，我一个 web 文件都没碰。**所以"641"这个数字在我开工时就已经在动了，
我不拿它做对照，只报每个包的前后值。**

**开工时的基线污染，如实记下**：我第一次跑 `apps/daemon` 时是
`tests 235 / pass 221 / fail 0 / cancelled 13`，13 条 cancelled 全在
`notes-contract` 当时还没写完的 `noteDetail.test.ts` 里（`startDaemon` 抛错整个 suite 被取消）。
**不是我的**，且现已被他们自己修好（现在 0 cancelled）。

**新测试文件的登记**：`entrypoint.test.ts` 在 `apps/daemon`，
其 `tsconfig.json` 是 `include: ["src/**/*"]`，**自动编译**；
`tsconfig.test.json` 那份显式白名单**只存在于 `apps/web`**，本轮无 web 改动，**无需登记**。
各包 test 脚本前置的「源码里几个 `.test.ts`，dist 里就得有几个 `.test.js`」守卫已随每次
`pnpm test` 执行通过（空集/漏集会当场抛错）。

---

# §7 纪律自查

- ✅ **`/root/data-memo` 一个字节没碰**：所有临时 daemon 都走 `--data-dir /tmp/path-guard/…`
- ✅ **数据目录指针**：开工前备份、收工 `cat` + `sha256sum` **逐一比对**（不是"我还原了吗"）：
  `7f930979b85204d4c05b221f4c17a5cf5936a4d432a46488816727f60da233f3` 前后一致，
  内容仍是 `{"dataDir":"/root/data-memo"}`。**从未调用会写指针的接口**
- ✅ **`:10000` 只读**：全程只发过 `GET /api/health`（200），未重启、未 kill、未占该端口
- ✅ **`apps/web/dist` 不是我碰的**，但**它今天被人动过，请核查**：
  开工时它的 mtime 是 `23:53:32`，收尾时变成了 **`01:02:57`**。
  证据链表明不是我：① 我只跑 `pnpm build:safe`（`--filter "!@openmemo/web"`，根本不含 web）；
  ② 我在 `apps/web` 只跑过 `pnpm test`，而它的三个脚本**全部 `--outDir .test-out/…`**
  （`test:unit` → `.test-out/unit`、`test:host` → `.test-out/host`、`test:components` → `.test-out/components`），
  实测我那次的产物落在 `.test-out/components` 与 `.test-out/host`，**时间戳是 `01:09:44`——
  比 `dist` 的 `01:02:57` 晚了 7 分钟**，时间上也不可能是它写的。
  → **§7 那条线今天很可能又被人踩了一次**，建议 Manager 在重启 demo 前确认 `dist` 是谁的产物
- ✅ **没用 `pkill -f`**：临时 daemon 起在 **18143**，`setsid` + 记录 pid，
  按 pid `kill`；收尾发现 setsid 的子进程 pid 与我记的不同，**用 `ps -p` 查出真 pid 再单杀**，
  收工复查 `ss -ltn` 18143 已释放
- ✅ **没跑本地 whisper 转写**；T-128 那 8 条 `.so` 链的解析用例**全绿**（§3）
- ✅ **没用 `git add -A`**，没 commit、没 push（精确清单在文首表格）
- ✅ **没改他人交付物**：`notes.ts`（`notes-contract` 在飞）、`unpack.ts`、`paths.ts`、
  `tools.ts`、`scripts/**` 一个字未动，全部只写进本回执
- ✅ 变异体一律建在 `/tmp/path-guard/`，**仓库 dist 全程零改动**

---

# §8 需要 Manager 决策

1. **⚠️ 提交串档（`git add -A` 第六、第七次）**：我的 8 个文件被
   `4ee1f4a`(T-142 `test-gaps`) 与 `35a2635`(T-139 `notes-contract`) 扫走了。
   **那两个提交的消息里没有一个字提到 T-143**。要不要补一条说明提交 / 还是就地记进 ADR？
2. **A1（`notes.ts:186`）要不要现在派活？** 它让 **Windows 上 F2 本地导入必然 403** ——
   按用户"先还 Linux 债"的裁定它属于跨平台，但它是**一条 `+ '/'` 改 `+ sep` 的改动**，
   而且那个文件正被 `notes-contract` 占着。建议**等 T-139 合并后单派**。
3. **A2（`unpack.ts` 词法软链校验）要不要单开安全任务？** 与 ① 同族、同一课，
   但**需要重新设计**（解压后逐条 realpath 复核 vs 禁止链接指向链接），不是一行的事。
4. **`paths.ts` / `tools.ts` / `store.ts` 三份重复的三平台根目录推导要不要合并？**
   这是②/④ 那一族的**根治**手段（platform 报告也指到这里），但会动启动路径，需要单独排期。
5. **建议把两条写进 HANDOFF**：
   - **⑤A 新增一例**：「**校验工具本身会静默失灵**」——`grep` 对含裸控制字节的产物
     整文件跳过（无输出、exit 1，长得和"0 命中"一模一样），
     而本项目最核心的纪律恰恰是"反向验证前先 grep 确认坏行在产物里"。判据：`grep` 一律加 `-a`。
   - **PROTOCOL 新增一条**：**变异实验不要在仓库 dist 上做**，复制到自己的 `/tmp` 再改
     —— 理由是"还原之前那几十秒里，别人的门禁跑在你的变异体上"，双方都不会知道（§5 有实例）。

# §9 未验证 / 存疑

- **残留 TOCTOU**：① 的 realpath 与调用方 `createReadStream(abs)` 之间的窗口**仍在**，
  能实时替换软链的攻击者可以钻。收窄要把 fd 传给调用方，**本轮未做**。
- **macOS / Windows 上的行为一律 `[未验证]`**：②③④ 的 win32 半边全部是用
  `path.win32` / 显式 `platform` 入参在 **Linux 上**验的，**没有真机**。
  这正是这几条修法的目的（让它们**可以**被验），不等于它们**已经**在真机上被验过。
- **A2 的完整利用链未构造**：我只证明了「词法判定说在内、内核读到了外」这一步，
  **没有**做出一个能通过 `sha256` 校验的恶意归档端到端跑通。
- **① 的可利用性结论**基于我对 rel_path 三个写入方 + 上传/导入/解包四条路径的通读。
  我**没有**做全端口的黑盒扫描；若有我没读到的路由能创建软链或写 rel_path，结论要改。
