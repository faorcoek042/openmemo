---
id: D-11
author: ci-runner
status: ready
date: 2026-08-05
---

## TL;DR（≤ 25 行，Manager 只读这里）

- **CI 第一次真的跑起来了。** 在此之前仓库 138 个提交、零次 workflow 运行 ——
  不是"没人点"，是 **GitHub 从来没注册过那个 workflow**（成因见 §1，二分法查出来的）。
- **本文件的正文（§3）是本项目第一份非 Linux 的实测数据。** 在此之前，
  `platform` T-141 §3 的 49 条平台假设里有一半标着 `[推测]` / `[未验证：需真机]`，
  因为这台开发机只有 Linux x64。现在其中 **11 条有了真机证据**，
  **2 条被证伪**，**1 条 CI 结构上验不了**（§3.4，runner 是管理员，普通用户不是）。
- **平台矩阵按用户 2026-08-05 的当面指示裁到 8 个组合**（§2）。
  ⚠️ **偏离章程**：裁掉的 `linux-x64-rocm` 就是章程 §3 第 7 行的「Linux + AMD」。
  **裁掉之后 AMD 加速没有任何产物**，`docs/00-CHARTER.md:24,27` 那两行在产物层面为空。
  用户明确说"用不到"，记在这里是为了**日后没有人对着章程以为它被支持**。
- 同时裁掉的还有 `linux-arm64`（cpu+vulkan）与 `macos-x64`。
  ⚠️ 讽刺的一条：**`linux-arm64` 那两个 job 是本轮唯二全绿的 Linux job** ——
  删的不是坏的那些，是用不到的那些。
- 关键取舍：`ci.yml`（门禁，必须绿）与 `ci-crossplatform.yml`（探针，现在必然红）
  **刻意分成两个 workflow**。合并的唯一结局是有人给它加 `continue-on-error`，
  那就正好复现本仓最贵的那类 bug。
- 未验证/存疑：macOS metal 包为何是空的（§4.1）；ROCm 换 noble 后是否还有冲突
  （已裁掉，可能永远不会验）；Windows 无开发者模式下的 symlink 行为（§3.4）。
- 对其他 agent 的影响：**`test-gaps` / `platform` 请读 §3.3** ——
  跨平台测试红的 6 条里，**至少 4 条是测试自身写死了宿主假设**，不是产品 bug；
  但它们意味着那些用例**在非 Linux 上什么都没断言**。

---

# §1 为什么 138 个提交里一次 CI 都没跑过

## 1.1 结论

**首次推送（= 创建默认分支的那一次）没有被 GitHub 的 Actions workflow 索引器处理。**
与文件内容无关，与 action 版本无关，与账号/仓库设置无关。
**任何一次后续 push 都会把 `.github/workflows` 全量索引一遍**，届时所有 workflow 一起注册。

实践含义（反直觉，值得单独记）：

> 往一个空仓库首推之后，**要再推一次**（哪怕空提交），
> 否则 workflow 可能永远不注册 —— 而且**不会产生任何失败记录去提醒你**。
> 这就是"从来没跑过"能维持 138 个提交的机制：它连注册都过不去，所以永远不会红。

## 1.2 二分法（每一步都是实测）

| # | 做了什么 | 结果 |
|---|---|---|
| 1 | `gh api .../actions/workflows` | `total_count: 0`，而 `contents/.github/workflows` 里文件确实在（16873 B） |
| 2 | `gh api .../actions/permissions` | `{"enabled":true,"allowed_actions":"all"}` → **不是账号/仓库级禁用** |
| 3 | `gh api .../actions/cache/usage` | 正常返回 → Actions 子系统认识这个仓库 |
| 4 | 推一个 **8 行**的最小 `workflow_dispatch` 文件 | **25 秒内注册**（`total_count` 0→1）。同一时刻 `build-backends.yml` **仍然没注册** |
| 5 | 把旧 `build-backends.yml` **逐字节复制**成另一个文件名推上去 | **它注册了** → **内容不是原因** |
| 6 | `gh api .../events` | 首推只留下 `CreateEvent(ref=master)`，**没有 PushEvent** |

## 1.3 被证伪的两条猜测（都是我们自己先猜错的）

| 猜测 | 实测 |
|---|---|
| 「`actions/checkout@v6` 等四个 tag 不存在」 | **假的。** 四个全部存在，逐个 `git/ref/tags/<v>` 拿到了 commit sha：`checkout@v6`=`d23441a4…`、`setup-node@v6`=`24997072…`、`upload-artifact@v6`=`b7c566a7…`、`download-artifact@v7`=`37930b1c…`。它们只是**不是最新**（各仓最新为 v7.0.1 / v7.0.0 / v7.0.1 / v8.0.1），不是不存在。`platform` T-141 §4.6 当时查得是对的 |
| 「等了 2 分钟以上，所以不是索引延迟」 | **推理方向错了。** 不是"延迟"也不是"内容"，是**那一次推送**本身没被索引 —— 等多久都没用，再推一次就好了 |

⚠️ **`[UNKNOWN]`**：GitHub 内部为何跳过首推的索引，我查不到官方说明。
第 6 条（缺 PushEvent）是**相关证据，不是机制证明**。
但结论本身（"与内容/版本无关，再推一次即可"）是第 4、5 两步**直接实测**出来的。

---

# §2 平台矩阵（用户 2026-08-05 裁定）

## 2.1 `build-backends.yml`：12 → **8**

| # | runner | arch | backend | 状态 |
|---|---|---|---|---|
| 1 | macos-26 | arm64 | metal | 保留 |
| 2 | macos-26 | arm64 | cpu | 保留 |
| 3 | ubuntu-22.04 | x64 | cpu | 保留（**刻意留 22.04 = glibc 基线**） |
| 4 | ubuntu-24.04 | x64 | vulkan | 保留（**从 22.04 改过来**，见 §4.2） |
| 5 | ubuntu-24.04 | x64 | cuda | 保留（**从 22.04 改过来**） |
| 6 | windows-2025 | x64 | cpu | 保留 |
| 7 | windows-2025 | x64 | vulkan | 保留 |
| 8 | windows-2022 | x64 | cuda | 保留 |
| ✂ | ubuntu-24.04 | x64 | **rocm** | **删** —— 用户不需要 |
| ✂ | ubuntu-24.04-arm | arm64 | cpu | **删** —— 用户不需要（本轮 **success**） |
| ✂ | ubuntu-24.04-arm | arm64 | vulkan | **删** —— 用户不需要（本轮 **success**） |
| ✂ | macos-15-intel | x64 | cpu | **删** —— 用户不需要 |

被删的四行**原样保留在 YAML 注释里**，恢复 = 把注释那几行放回去。

## 2.2 ★ 章程偏离（这一节是本文件存在的主要理由之一）

`docs/00-CHARTER.md` §3 的 7 行平台矩阵里有两行是 AMD：

```
docs/00-CHARTER.md:24  | Windows + AMD | Vulkan / DirectML |
docs/00-CHARTER.md:27  | Linux + AMD   | ROCm / Vulkan     |
```

- **Linux + AMD**：唯一的产物来源就是被裁掉的 `linux-x64-rocm` job
  （上游 whisper.cpp 至今**没有** ROCm 版本，见 `platform` T-141 §2.1）。
  → **2026-08-05 起，Linux+AMD 加速没有任何可安装的产物。**
- **Windows + AMD**：走 Vulkan，`windows-x64-vulkan` 保留了 —— 这一行**仍然可能成立**
  （本轮它编译 100% 成功，只死在打包那步，见 §4.3）。

**原因与日期**：用户 2026-08-05 当面指示「linux-arm64 和 macos-x64 和 linux-x64-rocm
这些我用不到」，Manager 已当面向用户复述过"裁掉 ROCm = AMD 那条没有产物"，用户确认。

> **写在这里是为了防两件事**：
> ① 日后有人对着章程问"AMD 呢"，答案在这里，带日期带原因；
> ② 更糟的那种 —— 有人以为它被支持，然后去装一个不存在的包。

## 2.3 `ci-crossplatform.yml`：4 → **3**

`ubuntu-24.04`（对照组）/ `macos-26` / `windows-2025`。
删掉 `macos-15-intel`：第一轮跑过一次，**结论与 darwin-arm64 逐条一致**
（bash 3.2、大小写不敏感、同一条 pipeline 测试红），没有任何一条事实是 Intel Mac 独有的。

---

# §3 ★ 真机事实表 —— 本项目第一份非 Linux 数据

来源：`ci-crossplatform` run 31016760141，`scripts/ci/platform-facts.mjs`。
三台 runner 同一份脚本、同一个 Node（v22.23.1）。**未加工的日志原文见 §3.1 表格。**

## 3.1 逐条对照

| 探针 | linux/x64（对照） | darwin/arm64 | win32/x64 |
|---|---|---|---|
| `os.release` | 6.17.0-1020-azure | 25.5.0 | 10.0.26100 |
| `path.sep` | `/` | `/` | `\` |
| **大小写不敏感文件系统** | `false` | **`true`** | **`true`** |
| `chmod(0o755)` → mode | `755` | `755` | **`666`** |
| `access(X_OK)` | true | true | **true（尽管没有 x 位）** |
| **`writeFile(mode:0o600)` → mode** | `600` | `600` | **`666`** |
| `symlink()` | ok | ok | **ok（runner 是管理员，见 §3.4）** |
| `link()` 硬链接 | ok | ok | ok |
| `cp(verbatimSymlinks)` 含软链 | ok | ok | ok |
| `` `file://`+path === pathToFileURL() `` | **false** | **false** | **false** |
| `join('dd','tmp','job','a.wav').split('/').length` | 4 | 4 | **1** |
| `isAbsolute('/media/x.wav')` | true | true | **true** |
| `isAbsolute('C:\\data\\x.wav')` | false | false | true |
| `resolve('C:\\d\\m\\r.wav')` | `<cwd>/C:\d\m\r.wav` | `<cwd>/C:\d\m\r.wav` | `C:\d\m\r.wav` |
| `sh` / `bash` | ok / 5.2.21 | ok / **3.2.57** | ok / 5.3.15（Git Bash） |
| `openssl` | 3.0.13 | **3.6.3（有！）** | **3.6.3（有！）** |
| `taskkill` | ENOENT | ENOENT | **exit 0（有）** |
| `find` | GNU 4.9.0 | **`find: illegal option -- -`（BSD）** | **`FIND: Parameter format not correct`** |
| `zip` / `7z` | 有 / 有 | 有 / 有 | **无 / 有** |
| **`set -u` + 空数组展开** | exit 0 | **exit 127 `A[@]: unbound variable`** | exit 0 |

## 3.2 这张表对 T-141 §3 的判决

| T-141 条目 | 原证据级别 | 现在 |
|---|---|---|
| #7 大小写不敏感 FS 上的路径解析 | `[实测但用 vfat 模拟]` | ✅ **证实**：macOS 与 Windows 的**默认文件系统就是不敏感的**，触发条件不需要用户做任何特殊操作 |
| #8 宿主绑定 `isAbsolute` | `[实测 Linux 侧]` | ✅ **证实**：Windows 上 `isAbsolute('/media/x.wav')` 也是 `true`，两侧都会错 |
| #26 `abs.split('/')` 硬编码 | `[读码]` | ✅ **证实**：Windows 上 `split('/').length === 1` → `matchBySuffix` 永远匹配不上 → **资产迁移静默失效** |
| #23 `{mode:0o600}` 在 Windows 上失效 | `[推测]` | ✅ **证实**：写 `0o600` 读回来是 **`666`**。`runtime.json`（**内含 auth token**）、`datadir.json`、`tls-key.pem` 在 Windows 上**对本机所有用户可读** |
| #10 Windows 跳过 chmod 是对的 | `[读码]` | ✅ **证实**：`chmod(0o755)` 在 Windows 上读回来仍是 `666`，而 `access(X_OK)` **照样返回 true** —— `installer.ts:283-284` 写的理由完全正确 |
| #1 手拼 `file://` | `[实测]` | ✅ **证实且更严重**：**三个平台全部 false**（Linux 上是空格转义，Windows 上是 `file://C:\…` vs `file:///C:/…` 两种形态） |
| #2/#3 Windows 无 `taskkill` 兜底 | `[实测 grep]` | ✅ **可修**：`taskkill` 在 Windows runner 上 exit 0 存在。缺的是我们的代码，不是系统 |
| #21/#22 Windows 没有 openssl | `[推测]` | 🔴 **在 runner 上被证伪**：windows-2025 上 `openssl version` = OpenSSL 3.6.3。⚠️ **但 runner 装了一堆开发工具，不能代表普通用户的机器** —— 这条改判为 `[未验证：需干净的 Windows]` |
| #30 `check-tracked-sources.mjs` 的 POSIX `find` | `[读码]+[推测]` | ✅ **证实，且范围比预测的窄**：Windows 上 `pnpm check:sources` **真的红了**（`✘ 没找到任何源码目录`）；**macOS 上是绿的**（BSD find 认 `-type d`，只是不认 `--version`）。预测"只有 Windows 会断"是对的 |
| #13 `move.ts:470` 无 Windows 回退 | `[未验证：需真机]` | ⚠️ **CI 结构上验不了**，见 §3.4 |
| bash 3.2 空数组（**T-141 没有这一条**） | — | 🆕 **新发现**，见 §4.1 |

## 3.3 跨平台跑 `pnpm -r test` 的结果（给 `test-gaps` / `platform`）

三台都跑到了 `Test` 这一步（**install / build:safe / typecheck 在 macOS 与 Windows 上全部成功**，
这本身是个好消息：TS 那一套在非 Linux 上编得出来）。

| 平台 | 红在哪 | 我的判断 |
|---|---|---|
| darwin/arm64 | `packages/pipeline` `argGuard.test.ts:313`「★ under posix rules the same UNC string is merely a weird filename」`false !== true` | **测试自身的宿主假设**：它用 `mkdtemp(tmpdir())` 造根，而 **macOS 的 `/var` 是指向 `/private/var` 的软链**，`assertWithinRoot` 会 realpath 候选、却拿**没 realpath 的 root** 去比 → 判为越界。<br>⚠️ 但它顺带暴露了一条**产品事实**：**任何经过软链的 managed root，在 macOS 上会被整体拒绝** —— 而 macOS 的默认 TMPDIR 就在软链后面 |
| win32/x64 | `packages/runtime` `assetPaths.test.js` 3 条：期望 `/d/media/a.wav`，实得 `D:\d\media\a.wav` | **测试写死了 POSIX 字符串**，产品代码用的是 `join`（是对的）。后果：**这三条用例在 Windows 上什么都没断言到** |
| win32/x64 | `packages/runtime` `selfcheck.test.js` 2 条：`'fail' !== 'ok'` / `'fail' !== 'warn'` | 未定性。**疑似**测试造的假二进制没有 `.exe` 后缀，而 `discoverTools` 在 Windows 上找的是带 `.exe` 的名字（`tools.ts:346`）。`[推测，未验证]` |
| win32/x64 | `pnpm check:sources` → `✘ 没找到任何源码目录，检查脚本本身可能有问题` | **产品/工具链真 bug**，即 T-141 #30。**这条守卫在 Windows 上是坏的，而它坏的方式是"报告脚本自己有问题"** —— 至少它没有静默返回绿 |

**给 Manager 的一句话**：跨平台的红**大部分不是产品坏了，是测试从来没在那些平台上跑过**。
但这两件事在后果上是同一件：**那些用例在 macOS / Windows 上等于不存在。**

## 3.4 ⚠️ 一条 CI **结构上验不了**的（必须写下来，否则会被误当成"已验证"）

T-141 #13：`apps/daemon/src/storage/move.ts:470` 的 `fs.cp({verbatimSymlinks:true})`
是唯一没有 Windows EPERM 回退的链接路径，预测是"无开发者模式 → 搬家永远失败"。

**探针在 windows-2025 上 `symlink()` 成功了。** 这**不构成对该预测的证伪**：

> GitHub 的 Windows runner **以管理员身份运行**，天然持有 `SeCreateSymbolicLinkPrivilege`。
> 普通用户在未开启开发者模式时**没有**这个特权。
> **runner 不能代表用户的机器**，这条只能靠一台真正的普通 Windows 机器来验。

同理适用于 §3.2 里 openssl 那条。
**判据：runner 上"能做到"不等于用户机器上"能做到"；只有 runner 上"做不到"才是硬结论。**

---

# §4 第一次真跑 `build-backends` 的结果（run 31014564498，12 个 job）

`3 success / 8 failure / 1 skipped`。全部日志已逐条读过。

## 4.1 macOS：两个新 bug，一个未定性

**① `BACKEND_FLAGS[@]: unbound variable`（macos-arm64-cpu 与 macos-x64-cpu 双双）**

```
==> host=darwin/arm64 backend=cpu jobs=3
scripts/build-whisper.sh: line 229: BACKEND_FLAGS[@]: unbound variable
```

`set -u` + **空数组** + **bash 3.2**。macOS 的 `/bin/bash` 至今是 3.2
（Apple 因 GPLv3 停在 2007 年那版），bash 4.4 才把"空数组展开不算 unbound"修掉。
`BACKEND_FLAGS` 恰好在 `backend=cpu` 时是空的 —— **这个 bug 只在 macOS + cpu 上存在**，
同一行在 ubuntu（bash 5.x）上跑了几十次都是绿的。
探针独立复现了这条：`8.set -u + empty array expansion` 在 darwin 上 `exit=127`。
→ 已修：`${ARR[@]+"${ARR[@]}"}`。

**② macos-arm64-metal：编译 100% 成功，暂存目录却是空的（未定性）**

```
[100%] Linking CXX executable ../../bin/whisper-server
[100%] Built target whisper-server
==> ggml ABI: 0.15.1
==> stripping symbols
==> ad-hoc signing (codesign -s -)
emit-pack-manifest: stage dir is empty: .../stage/whispercpp-metal-macos-arm64
```

**没修好。** 已加诊断：暂存目录为空时打印 `BIN_DIR` 的真实内容与 `*ggml*` 的实际位置
（不改红绿，只让下一轮自带证据）。
值得注意的是 workflow 自己的注释就写着「Metal … 的 pack 其实装在核心包里」——
**矩阵却仍然单独构建一个 metal 包**。这个矛盾第一次真跑就撞上了。

**③ `ci-prep` 的 C5 修复在第一轮就救了场**：旧版那个"glob 不匹配就 `continue`、
零文件也绿灯"的签名检查，换成了"数了几个、零个就红"。
上面这条空包**正是被它抓住的** —— 否则会打出一个 0 字节的 macOS 包并绿灯。

## 4.2 Linux：三个后端全挂，全是环境名字问题

| job | 报错原文 | 处置 |
|---|---|---|
| linux-x64-vulkan | `E: Unable to locate package glslc` | jammy 没有这个包。**同一份包列表在 `ubuntu-24.04-arm` 上同一轮是 success** → x64 改 24.04 |
| linux-x64-cuda | `E: Unable to locate package cuda-cublas-12-4` / `cuda-cublas-dev-12-4` | CUDA 11 之后 cuBLAS 改名到 `libcublas-*` → 改 sub-packages |
| linux-x64-rocm | `rocm-hip-runtime : Depends: rocminfo (= 1.0.0.70201-81~22.04) but 5.0.0-1 is to be installed` … `held broken packages` | jammy 的 universe 自带老 ROCm 包，版本号压过 radeon 仓库。已改 noble，**但随即被用户裁掉，可能永远不会验证** |

## 4.3 Windows：**三个后端全部编译成功**，全部死在同一行

```
whisper-cli.vcxproj    -> D:\a\...\.build\whisper-win32-x64-cpu\bin\Release\whisper-cli.exe
whisper-server.vcxproj -> D:\a\...\bin\Release\whisper-server.exe
==> ggml ABI: unknown
==> stripping symbols
emit-pack-manifest: archive not found: dist/packs/whispercpp-cpu-win-x64.zip
```

- **好消息（新事实）**：`cpu` / `vulkan` / `cuda` 三个 Windows 后端**都能编出来**。
  上游 whisper.cpp 没有 Windows Vulkan 版（T-141 §2.1），而**我们自己能编**
  —— 章程 §3 第 4 行「Windows + AMD」因此仍有希望。
- **`bin\Release\`**：`platform` C7 预测的 MSVC 多配置布局**完全正确**，
  `ci-prep` 的三候选探测（`bin` → `bin/Release` → `Release/bin`）**第一次真跑就用上了**。
- **真 bug**：`--out dist/packs` 是**相对路径**，而 zip 那条要先 `cd` 到 stage 的父目录 ——
  **zip exit 0，文件写进了 `.build/…/stage/dist/packs/` 这个没人看的地方**。
  tar 那条没这毛病**纯属运气**：`tar -C` 是在**打开归档之后**才切目录的。
  → 已修：`OUT_DIR` 先解析成绝对路径（Windows 用 `pwd -W` 取 Windows 形态，
  不去赌 Git-for-Windows 的参数路径转换 —— 7z/zip 是原生 exe）。
- ⚠️ **一处我撤回的改动**：我一度按 Linux 的报错把 Windows job 的 CUDA sub-packages
  也改成 `libcublas*`，**然后发现没有证据**：windows-x64-cuda 的「Install CUDA toolkit」
  **是成功的**。两边走的是完全不同的安装器。**没坏就别按另一个平台的错误去"修"** ——
  已改回原样并把理由写进 YAML。

## 4.4 ★ `merge-manifest` = `skipped` —— C4 的修复在真跑里被证实

第一轮 8 个 job 失败，`merge-manifest` 的结论是 **`skipped`**，
**不是 success、不是 "写出 `packs: []` 然后绿灯"**。

这同时回答了 `ci-prep` 标为 `[未跑通]` 的 `needs:` / skip 语义问题：

> `needs: [macos, linux, windows]` + **没有** `if: always()`
> → 只要上游任一 job（含 matrix 中任一 leg）失败，`manifest` 就 **skip**。
> **注意这是"全有或全无"**：本轮 `linux-x64-cpu` / `linux-arm64-cpu` /
> `linux-arm64-vulkan` 三个 leg 是 **success** 的，`manifest` 照样没跑。
> → 想要"部分成功也出 manifest"，得改成按 leg 收集 —— **但那正是 C4 的形状，不要**。

---

# §5 遗留（按优先级）

1. **macOS metal 包为空** —— 未定性，下一轮日志会自带 `BIN_DIR` 内容。
2. **跨平台测试的 6 条红** —— §3.3，多数是测试的宿主假设，但后果是"那些用例在非 Linux 上等于不存在"。
3. **`pnpm check:sources` 在 Windows 上是坏的** —— T-141 #30 已被证实。
4. **`ci.yml` 目前仍只有 `workflow_dispatch`** —— 一个"手动才跑的 CI"等于没有 CI。
   放开 `push` / `pull_request` 三行的时机是用户的决定（`ci.yml` 文件头已写明）。
5. **Windows 上 `0o600` 是 `666`** —— `runtime.json` 里的 auth token 对本机所有用户可读。
   这条现在**有实测证据**了，值得单独派人处理（需要 ACL 而不是 POSIX 位）。
