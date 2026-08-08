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

| #   | 做了什么                                                     | 结果                                                                               |
| --- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| 1   | `gh api .../actions/workflows`                               | `total_count: 0`，而 `contents/.github/workflows` 里文件确实在（16873 B）          |
| 2   | `gh api .../actions/permissions`                             | `{"enabled":true,"allowed_actions":"all"}` → **不是账号/仓库级禁用**               |
| 3   | `gh api .../actions/cache/usage`                             | 正常返回 → Actions 子系统认识这个仓库                                              |
| 4   | 推一个 **8 行**的最小 `workflow_dispatch` 文件               | **25 秒内注册**（`total_count` 0→1）。同一时刻 `build-backends.yml` **仍然没注册** |
| 5   | 把旧 `build-backends.yml` **逐字节复制**成另一个文件名推上去 | **它注册了** → **内容不是原因**                                                    |
| 6   | `gh api .../events`                                          | 首推只留下 `CreateEvent(ref=master)`，**没有 PushEvent**                           |

## 1.3 被证伪的两条猜测（都是我们自己先猜错的）

| 猜测                                        | 实测                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 「`actions/checkout@v6` 等四个 tag 不存在」 | **假的。** 四个全部存在，逐个 `git/ref/tags/<v>` 拿到了 commit sha：`checkout@v6`=`d23441a4…`、`setup-node@v6`=`24997072…`、`upload-artifact@v6`=`b7c566a7…`、`download-artifact@v7`=`37930b1c…`。它们只是**不是最新**（各仓最新为 v7.0.1 / v7.0.0 / v7.0.1 / v8.0.1），不是不存在。`platform` T-141 §4.6 当时查得是对的 |
| 「等了 2 分钟以上，所以不是索引延迟」       | **推理方向错了。** 不是"延迟"也不是"内容"，是**那一次推送**本身没被索引 —— 等多久都没用，再推一次就好了                                                                                                                                                                                                                  |

⚠️ **`[UNKNOWN]`**：GitHub 内部为何跳过首推的索引，我查不到官方说明。
第 6 条（缺 PushEvent）是**相关证据，不是机制证明**。
但结论本身（"与内容/版本无关，再推一次即可"）是第 4、5 两步**直接实测**出来的。

---

# §2 平台矩阵（用户 2026-08-05 裁定）

## 2.1 `build-backends.yml`：12 → **8**

| #   | runner           | arch  | backend  | 状态                                     |
| --- | ---------------- | ----- | -------- | ---------------------------------------- |
| 1   | macos-26         | arm64 | metal    | 保留                                     |
| 2   | macos-26         | arm64 | cpu      | 保留                                     |
| 3   | ubuntu-22.04     | x64   | cpu      | 保留（**刻意留 22.04 = glibc 基线**）    |
| 4   | ubuntu-24.04     | x64   | vulkan   | 保留（**从 22.04 改过来**，见 §4.2）     |
| 5   | ubuntu-24.04     | x64   | cuda     | 保留（**从 22.04 改过来**）              |
| 6   | windows-2025     | x64   | cpu      | 保留                                     |
| 7   | windows-2025     | x64   | vulkan   | 保留                                     |
| 8   | windows-2022     | x64   | cuda     | 保留（**理由未记录**，见下方注）         |
| ✂   | ubuntu-24.04     | x64   | **rocm** | **删** —— 用户不需要                     |
| ✂   | ubuntu-24.04-arm | arm64 | cpu      | **删** —— 用户不需要（本轮 **success**） |
| ✂   | ubuntu-24.04-arm | arm64 | vulkan   | **删** —— 用户不需要（本轮 **success**） |
| ✂   | macos-15-intel   | x64   | cpu      | **删** —— 用户不需要                     |

> ⚠️ **`windows-2022 / cuda` 这一格：是刻意保留的，但理由从没被写下来（Manager 复核 2026-08-08）。**
>
> 它在当年那轮逐格取舍里明确标着「保留」，**所以它不是遗留漂移**。但同表的
> `ubuntu-22.04` 写着「刻意留 22.04 = glibc 基线」，而这一格**什么都没写**。
>
> **我不去编一个理由**（最可能的猜测是 CUDA 12.4 与 MSVC 版本的兼容性，但那是猜的）。
> 标成 `UNKNOWN`：**它是刻意的，理由待补**。谁要动它，先把理由查出来再动；
> 谁知道理由，请补在这里。
>
> ### 追查结果（`e2e-notes` 2026-08-08）：**仍然是 `UNKNOWN`，但不必再查一遍了**
>
> 受命去 git 历史与 CI 日志里找真实理由。**没找到**，所以这一格照旧 `UNKNOWN`。
> 把找过的地方记下来，免得下一个人重做同一遍考古：
>
> | 查了什么                                           | 结果                                                                       |
> | -------------------------------------------------- | -------------------------------------------------------------------------- |
> | `git log -S "windows-2022"`（全历史，含 workflow） | 只有 3 个 commit 命中，最早是 `27d052f`（2026-08-02，**首版架构提交**）    |
> | `27d052f` 里那一行的上下文                         | 矩阵三行紧挨着，**cuda 那行没有任何解释性注释**                            |
> | 那一行**改过没有**                                 | **从未改过** —— 自引入起一直是 `windows-2022`                              |
> | 有没有 `windows-2025 + cuda` 的尝试                | **一次都没有**                                                             |
> | `docs/` `ADR` `coordination/` 里的相关讨论         | 只有描述性引用（D-04 §表、ci-runner 矩阵），**没有一处给理由**             |
> | `ci-runner` 那轮逐格取舍                           | 邻居都带 `←` 理由（`glibc 基线` / `jammy 没有 glslc`），**唯独这一格没有** |
> | CI 实测                                            | `windows-x64-cuda` 在 `windows-2022` 上 **success**（run `31155359839`）   |
>
> **推论（只到这一步，不再往前）**：这一格是**首版写下时就这么选的**，
> 当时 CI 一次都还没跑过 —— 也就是说它**不可能**来自"在 2025 上试过、失败了"的实测，
> 那条最顺口的猜测（CUDA × MSVC 兼容性）在本仓**没有任何证据支持**。
> 它更像是作者当时的一个先验选择，此后每一轮取舍都照抄了"保留"。
>
> ⚠️ **`windows-2022` 已被 GitHub 标记弃用**，所以这一格早晚要动。
> 动它的人请注意：**"它现在是绿的"不是"必须是 2022"的理由** ——
> 真要验，就是把 cuda 那条腿在 `windows-2025` 上跑一次，用结果说话。
> 那一步我**没有做**（会占用一台 runner 编 CUDA，且不在本次授权范围内）`[未验证]`。
>
> 顺带更正一次测量错误：Manager 此前报过「runner 版本散乱：macos-14 ×5、macos-15 ×3、
> macos-13 ×1、ubuntu-22.04 ×3」——**那是 grep 原始字符串把注释也数进去了**。
> 只看 `runs-on` 与矩阵里的 `runner:`，实际是 `ubuntu-24.04` ×18 / `macos-26` ×12 /
> `windows-2025` ×9 / `windows-2022` ×1。**那些注释恰恰是在解释为什么不用那些版本**
> （`macos-13` 已下架、`macos-14` 已弃用、`ubuntu-22.04` 上那份包列表装不上）。

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

| 探针                                               | linux/x64（对照）    | darwin/arm64                           | win32/x64                                |
| -------------------------------------------------- | -------------------- | -------------------------------------- | ---------------------------------------- |
| `os.release`                                       | 6.17.0-1020-azure    | 25.5.0                                 | 10.0.26100                               |
| `path.sep`                                         | `/`                  | `/`                                    | `\`                                      |
| **大小写不敏感文件系统**                           | `false`              | **`true`**                             | **`true`**                               |
| `chmod(0o755)` → mode                              | `755`                | `755`                                  | **`666`**                                |
| `access(X_OK)`                                     | true                 | true                                   | **true（尽管没有 x 位）**                |
| **`writeFile(mode:0o600)` → mode**                 | `600`                | `600`                                  | **`666`**                                |
| `symlink()`                                        | ok                   | ok                                     | **ok（runner 是管理员，见 §3.4）**       |
| `link()` 硬链接                                    | ok                   | ok                                     | ok                                       |
| `cp(verbatimSymlinks)` 含软链                      | ok                   | ok                                     | ok                                       |
| `` `file://`+path === pathToFileURL() ``           | **false**            | **false**                              | **false**                                |
| `join('dd','tmp','job','a.wav').split('/').length` | 4                    | 4                                      | **1**                                    |
| `isAbsolute('/media/x.wav')`                       | true                 | true                                   | **true**                                 |
| `isAbsolute('C:\\data\\x.wav')`                    | false                | false                                  | true                                     |
| `resolve('C:\\d\\m\\r.wav')`                       | `<cwd>/C:\d\m\r.wav` | `<cwd>/C:\d\m\r.wav`                   | `C:\d\m\r.wav`                           |
| `sh` / `bash`                                      | ok / 5.2.21          | ok / **3.2.57**                        | ok / 5.3.15（Git Bash）                  |
| `openssl`                                          | 3.0.13               | **3.6.3（有！）**                      | **3.6.3（有！）**                        |
| `taskkill`                                         | ENOENT               | ENOENT                                 | **exit 0（有）**                         |
| `find`                                             | GNU 4.9.0            | **`find: illegal option -- -`（BSD）** | **`FIND: Parameter format not correct`** |
| `zip` / `7z`                                       | 有 / 有              | 有 / 有                                | **无 / 有**                              |
| **`set -u` + 空数组展开**                          | exit 0               | **exit 127 `A[@]: unbound variable`**  | exit 0                                   |

## 3.2 这张表对 T-141 §3 的判决

| T-141 条目                                      | 原证据级别             | 现在                                                                                                                                                                                                    |
| ----------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #7 大小写不敏感 FS 上的路径解析                 | `[实测但用 vfat 模拟]` | ✅ **证实**：macOS 与 Windows 的**默认文件系统就是不敏感的**，触发条件不需要用户做任何特殊操作                                                                                                          |
| #8 宿主绑定 `isAbsolute`                        | `[实测 Linux 侧]`      | ✅ **证实**：Windows 上 `isAbsolute('/media/x.wav')` 也是 `true`，两侧都会错                                                                                                                            |
| #26 `abs.split('/')` 硬编码                     | `[读码]`               | ✅ **证实**：Windows 上 `split('/').length === 1` → `matchBySuffix` 永远匹配不上 → **资产迁移静默失效**                                                                                                 |
| #23 `{mode:0o600}` 在 Windows 上失效            | `[推测]`               | ✅ **证实**：写 `0o600` 读回来是 **`666`**。`runtime.json`（**内含 auth token**）、`datadir.json`、`tls-key.pem` 在 Windows 上**对本机所有用户可读**                                                    |
| #10 Windows 跳过 chmod 是对的                   | `[读码]`               | ✅ **证实**：`chmod(0o755)` 在 Windows 上读回来仍是 `666`，而 `access(X_OK)` **照样返回 true** —— `installer.ts:283-284` 写的理由完全正确                                                               |
| #1 手拼 `file://`                               | `[实测]`               | ✅ **证实且更严重**：**三个平台全部 false**（Linux 上是空格转义，Windows 上是 `file://C:\…` vs `file:///C:/…` 两种形态）                                                                                |
| #2/#3 Windows 无 `taskkill` 兜底                | `[实测 grep]`          | ✅ **可修**：`taskkill` 在 Windows runner 上 exit 0 存在。缺的是我们的代码，不是系统                                                                                                                    |
| #21/#22 Windows 没有 openssl                    | `[推测]`               | 🔴 **在 runner 上被证伪**：windows-2025 上 `openssl version` = OpenSSL 3.6.3。⚠️ **但 runner 装了一堆开发工具，不能代表普通用户的机器** —— 这条改判为 `[未验证：需干净的 Windows]`                      |
| #30 `check-tracked-sources.mjs` 的 POSIX `find` | `[读码]+[推测]`        | ✅ **证实，且范围比预测的窄**：Windows 上 `pnpm check:sources` **真的红了**（`✘ 没找到任何源码目录`）；**macOS 上是绿的**（BSD find 认 `-type d`，只是不认 `--version`）。预测"只有 Windows 会断"是对的 |
| #13 `move.ts:470` 无 Windows 回退               | `[未验证：需真机]`     | ⚠️ **CI 结构上验不了**，见 §3.4                                                                                                                                                                         |
| bash 3.2 空数组（**T-141 没有这一条**）         | —                      | 🆕 **新发现**，见 §4.1                                                                                                                                                                                  |

## 3.3 跨平台跑 `pnpm -r test` 的结果（给 `test-gaps` / `platform`）

三台都跑到了 `Test` 这一步（**install / build:safe / typecheck 在 macOS 与 Windows 上全部成功**，
这本身是个好消息：TS 那一套在非 Linux 上编得出来）。

> ⚠️ **计数订正**：本节列的是 **6 条红**，但那是 `pnpm -r test` 被 `bail` **截断后**的计数。
> T-147 全量重跑得到 **14 条**。**此前 §5 第 2 条也照抄了"6 条"。** 下表的性质判断不变，只是不全。

| 平台         | 红在哪                                                                                                                                                                                                                                                                                                                      | 我的判断                                                                                                                                                                                                                                                                                                                             |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| darwin/arm64 | `packages/pipeline` `packages/pipeline/src/subprocess/__tests__/argGuard.test.ts:331`「★ under posix rules the same UNC string is merely a weird filename」`false !== true`（**此前写的是裸文件名 `argGuard.test.ts:313`；313 行是另一个用例 `backslash traversal is rejected under win32 rules` 里的 `assertRejected(`**） | **测试自身的宿主假设**：它用 `mkdtemp(tmpdir())` 造根，而 **macOS 的 `/var` 是指向 `/private/var` 的软链**，`assertWithinRoot` 会 realpath 候选、却拿**没 realpath 的 root** 去比 → 判为越界。<br>⚠️ 但它顺带暴露了一条**产品事实**：**任何经过软链的 managed root，在 macOS 上会被整体拒绝** —— 而 macOS 的默认 TMPDIR 就在软链后面 |
| win32/x64    | `packages/runtime` `assetPaths.test.js` 3 条：期望 `/d/media/a.wav`，实得 `D:\d\media\a.wav`                                                                                                                                                                                                                                | **测试写死了 POSIX 字符串**，产品代码用的是 `join`（是对的）。后果：**这三条用例在 Windows 上什么都没断言到**                                                                                                                                                                                                                        |
| win32/x64    | `packages/runtime` `selfcheck.test.js` 2 条：`'fail' !== 'ok'` / `'fail' !== 'warn'`                                                                                                                                                                                                                                        | 未定性。**疑似**测试造的假二进制没有 `.exe` 后缀，而 `discoverTools` 在 Windows 上找的是带 `.exe` 的名字（`packages/pipeline/src/tools.ts:437`，`discoverTools` 本身在 `:429`；**此前写的是 `tools.ts:346`，那一行是 sqlite 扩展物化循环里的 `findFileInBackendPacks`**）。`[推测，未验证]`                                          |
| win32/x64    | `pnpm check:sources` → `✘ 没找到任何源码目录，检查脚本本身可能有问题`                                                                                                                                                                                                                                                       | **产品/工具链真 bug**，即 T-141 #30。**这条守卫在 Windows 上是坏的，而它坏的方式是"报告脚本自己有问题"** —— 至少它没有静默返回绿。<br>✅ **T-147 已修**：`scripts/check-tracked-sources.mjs` 改用 Node 递归走目录，不再调外部 `find`                                                                                                 |

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

✅ **后续已定性并修掉（本段标题的"未定性"已过期）**：暂存目录**不是空的** —— 里面有且只有一个文件
`libggml-metal.so`。原因是 `GGML_BACKEND_DL=ON` 下 ggml 后端是 CMake **MODULE** 目标，
而 MODULE 在 Apple 平台上的后缀是 **`.so` 而不是 `.dylib`**，签名守卫的文件名 glob 只匹配了
`.dylib`/可执行文件 → 数出 0 个 → 报"stage dir is empty"。**要改的是模式，不是守卫**：
`build-backends.yml` 的模式已加 `*.so`（见该文件 `:182-193` 的注释）。
**此前这里写着"没修好。已加诊断：暂存目录为空时打印 `BIN_DIR` 的真实内容…（不改红绿，只让下一轮自带证据）"。**

值得注意的是 workflow 自己的注释就写着「Metal … 的 pack 其实装在核心包里」——
**矩阵却仍然单独构建一个 metal 包**。这个矛盾第一次真跑就撞上了；T-146 后已按注释办：
Metal 并进 macOS 核心包（`whispercpp-cpu-macos-arm64`，CPU+Metal+CoreML 一包带齐），见 §8.4。

**③ `ci-prep` 的 C5 修复在第一轮就救了场**：旧版那个"glob 不匹配就 `continue`、
零文件也绿灯"的签名检查，换成了"数了几个、零个就红"。
上面这条空包**正是被它抓住的** —— 否则会打出一个 0 字节的 macOS 包并绿灯。

## 4.2 Linux：三个后端全挂，全是环境名字问题

| job              | 报错原文                                                                                                                | 处置                                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| linux-x64-vulkan | `E: Unable to locate package glslc`                                                                                     | jammy 没有这个包。**同一份包列表在 `ubuntu-24.04-arm` 上同一轮是 success** → x64 改 24.04                    |
| linux-x64-cuda   | `E: Unable to locate package cuda-cublas-12-4` / `cuda-cublas-dev-12-4`                                                 | CUDA 11 之后 cuBLAS 改名到 `libcublas-*` → 改 sub-packages                                                   |
| linux-x64-rocm   | `rocm-hip-runtime : Depends: rocminfo (= 1.0.0.70201-81~22.04) but 5.0.0-1 is to be installed` … `held broken packages` | jammy 的 universe 自带老 ROCm 包，版本号压过 radeon 仓库。已改 noble，**但随即被用户裁掉，可能永远不会验证** |

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

1. ~~**macOS metal 包为空**~~ —— ✅ **已定性并已修**：包里其实**有**一个文件 `libggml-metal.so`，
   是签名守卫的 glob 少了 `*.so`（`GGML_BACKEND_DL=ON` 下 ggml 后端是 CMake MODULE 目标，
   而 MODULE 在 Apple 平台上用 `.so` 后缀、不是 `.dylib`）→ **要改的是模式，不是守卫**，模式已加 `*.so`。
   **此前写着"未定性，下一轮日志会自带 `BIN_DIR` 内容"。** 后续 T-146 进一步把 Metal 并进 macOS 核心包（见 §8.4）。
2. **跨平台测试的 ~~6~~ → 14 条红** —— §3.3 列的 6 条是 `pnpm -r test` **被 `bail` 截断后**的计数；
   T-147 全量重跑得到 **14** 条。**此前写着"6 条"。** 性质判断不变：多数是测试的宿主假设，
   但后果是"那些用例在非 Linux 上等于不存在"。
3. ~~**`pnpm check:sources` 在 Windows 上是坏的**~~ —— ✅ **T-147 已修**：`scripts/check-tracked-sources.mjs`
   改用 Node 自己递归走目录，不再调外部 `find`（Windows 上 `find` 是 `System32\find.exe`，一个文本搜索工具），
   各平台行为一致。**此前写着"T-141 #30 已被证实"。**
4. ~~**`ci.yml` 目前仍只有 `workflow_dispatch`**~~ —— ✅ **T-145 已放开**：`on:` 现为
   `workflow_dispatch` + `push: branches:[master]` + `pull_request:`（`build-backends.yml` 刻意保持手动）。
   **此前写着"一个'手动才跑的 CI'等于没有 CI，放开 `push`/`pull_request` 三行的时机是用户的决定"** ——
   用户已指示改为自动触发，`ci.yml` 文件头记了这件事。
5. **Windows 上 `0o600` 是 `666`** —— `runtime.json` 里的 auth token 对本机所有用户可读。
   这条现在**有实测证据**了，值得单独派人处理（需要 ACL 而不是 POSIX 位）。**仍未修**。

---

# §6 冷启动依赖来源审计（用户提问：「是不是都是现场下载的各个依赖？」）

> **全部结论来自干净 runner 的 CI 日志**（`cold-start-audit` run 31024880877 与 31026300122）。
> 本机的任何"能用"在这一节里都不算证据 —— 那台机器已经装好了一切，而它正是不该信的那台。

## 6.1 TL;DR

**答案是肯定的，但有两条例外，都在 npm 那条通道上。**

|                        | 结论                                                                                                                                                         | 证据            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| manifest 声明的下载    | **62 个文件，sha256 覆盖 100%，引用钉死 100%**                                                                                                               | §6.2            |
| 这些 URL 真的活着吗    | **62/62 HTTP 206**，且 8 MB 以下的**逐个重算 sha256 全部 MATCH**                                                                                             | §6.2            |
| 冷启动后工具从哪来     | **5/5 来自数据目录（产品自己下的），借宿主 PATH 的 = 0**                                                                                                     | §6.4            |
| 中文双字词真的搜得到吗 | **`ext.chineseSearch = ok`：用户:1 推特:2 中国:1 服务:2**                                                                                                    | §6.5            |
| 仓库里有二进制吗       | **没有。**最大的已跟踪文件 255 KB（JSON/PNG/文档）                                                                                                           | §6.2            |
| ⚠️ ~~例外 1~~          | ~~`ffmpeg-static` 在 `pnpm install` 期下 **79.8 MB** 的 ffmpeg，钉了 tag 但**无校验和**~~ → ✅ **T-145 已删除整条通道**（不是加锁，是**减少通道**），见 §7.4 | §6.3 / **§7.4** |
| ⚠️ ~~例外 2~~          | ~~`youtube-dl-exec` 打的是 `releases/**latest**` —— **不钉版本、无校验和**~~ → ✅ **T-145 已删除整条通道**，见 §7.4                                          | §6.3 / **§7.4** |

> ⚠️ **此前上面这两行把 `ffmpeg-static` 与 `youtube-dl-exec` 列为活着的例外**（"在 `pnpm install` 期无校验和地下二进制"），
> 而**同一份文档的 §7.4 已经宣布这两个包被删除** —— 这张 TL;DR 表当时没跟着改。
> 现状：两个包已从 `packages/pipeline` 的 `dependencies` 与 `onlyBuiltDependencies` 中移除
> （`package.json` 里只剩一条 `_comment:removed-deps` 说明串），CI 三平台反向断言 ✔ 不存在。
> **读者只读 §6.1 这张表，所以这里必须与 §7.4 一致。**

## 6.2 静态 + 实测：manifest 那条通道（`scripts/ci/dependency-audit.mjs`）

```
backends.json            8 个文件   sha256 8/8    可变引用 0   host: github.com
sqlite-ext.json         11 个文件   sha256 11/11  可变引用 0   host: github.com
models-asr-support.json 11 个文件   sha256 11/11  可变引用 0   host: huggingface.co, raw.githubusercontent.com
models-llm.json          5 个文件   sha256 5/5    可变引用 0   host: huggingface.co
models-whisper.json     27 个文件   sha256 27/27  可变引用 0   host: huggingface.co
                        ─────────
                        62 个文件
```

`--live` 从干净 runner 发真实请求：**唯一 URL 62 | 可达 62 | 不可达 0**，全部 `HTTP 206`。
`--verify-under 8` 把 8 MB 以下的**真下载下来重算 sha256**，逐条 `MATCH`，例如：

```
206  bytes 0-0/2327524   sha256 MATCH (2327524B)   vad/silero-vad-onnx/silero_vad.onnx
     https://raw.githubusercontent.com/snakers4/silero-vad/bfdc0193023f121ea5b3cc7b176dbed570a68a59/src/silero_vad/data/silero_vad.onnx
206  bytes 0-0/885098    sha256 MATCH (885098B)    vad/silero-vad-ggml/ggml-silero-v6.2.0.bin
     https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin
206  bytes 0-0/75352     sha256 MATCH (75352B)     asr/paraformer-zh-small/tokens.txt
     https://huggingface.co/csukuangfj/sherpa-onnx-paraformer-zh-small-2024-03-09/resolve/63ddc3cd0f2810b68289a7b3876e62ef5d53d6df/tokens.txt
```

**钉法**：GitHub 侧钉 release tag（`v1.9.1` / `2026.07.04` / `autobuild-2026-08-02-13-17` / `v0.7.1` / `v0.1.9`），
HuggingFace 侧钉 **commit SHA**（`/resolve/<40 位>/`）。
⚠️ 一条先前的存疑已排除：`models-llm.json` 的 `source.revision` 写的是 `"main"`，
但**实际 mirror URL 里带的是 commit**（`/resolve/bc640142c66e1fdd12af0bd68f40445458f3869b/`），
所以那是元数据漂移，不是真的没钉。

**submodule**：4 个全部钉在 tag 上 —— `libsimple v0.7.1` / `sherpa-onnx v1.13.4` /
`sqlite-vec v0.1.9` / `whisper.cpp v1.9.1`。

**仓库里的二进制：没有。** 最大的 15 个已跟踪文件全部是 JSON / PNG 截图 / Markdown，
最大 255 KB。

## 6.3 ⚠️ 第二条通道：`pnpm install`（**不受本仓 sha256 约束**）

`pnpm-workspace.yaml` 的 `onlyBuiltDependencies` 有 4 项，其中两项就是去下二进制的。
下面是**在 runner 的 `node_modules` 里抠出来的运行期证据**，不是读文档：

```
== ffmpeg-static ==
  version: 5.3.0
  binary-release-tag: "b6.1.1"            ← 钉死了
  scripts: {"install":"node install.js"}
  实际落地: node_modules/.pnpm/ffmpeg-static@5.3.0/.../ffmpeg   79,826,272 B

== youtube-dl-exec ==
  const YOUTUBE_DL_HOST =
    process.env.YOUTUBE_DL_HOST ??
    'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest'   ← ★ 不钉版本
  实际落地: node_modules/.pnpm/youtube-dl-exec@3.1.9.../bin/yt-dlp   3,071,553 B
```

三条要说清楚的：

1. **两者都没有 sha256 校验** —— 它们走各自 npm 包的下载逻辑，
   本仓 `packages/downloader` 那套「下完必校验、不过就换镜像、全失败就报错」**碰不到它们**。
2. **`youtube-dl-exec` 不钉版本**：`releases/latest` 意味着**今天装和明天装可能拿到不同的 yt-dlp**。
   而 `backends.json` 里那 4 个 `ytdlp-*` 包是**钉死 `2026.07.04` + 带 sha256** 的 ——
   **同一个工具，两条通道，一条严一条松。**
3. 落地大小也对不上：npm 那条是 **3.07 MB** 的纯 Python zipapp（运行时要机器上有 Python），
   manifest 那条是 **39.9 MB** 的自包含 `yt-dlp_linux`。**它们不是同一个东西。**

→ ~~建议（未实施，需 Manager 裁定）：`YOUTUBE_DL_SKIP_DOWNLOAD=1` +
让运行期只认 manifest 装出来的那个；`ffmpeg-static` 同理。~~

> **✅ 订正（2026-08-08，由 `e2e-runtime` 就地改，依据 PROTOCOL §13）**
>
> **已闭合，而且做得比这条建议更彻底：那两个包被整个删掉了，不是"跳过下载"。** `[实测]`
>
> - `packages/pipeline/package.json` 的 `_comment:removed-deps` 记着依据：
>   T-145 删除 `ffmpeg-static (^5.3.0)` 与 `youtube-dl-exec (^3.1.9)`，
>   判据是**减少通道**而不是给每条通道加锁 —— 与本节「同一个工具、两条通道、一严一松」同一条理由。
> - 删除前做了三查（全仓无 import/require、无按路径引用二进制、测试零出现），
>   删除后 `pnpm -r test` 不变、冷启动审计仍然 5/5 工具来自数据目录。
> - **而且现在有守卫**：`.github/workflows/cold-start-audit.yml` 里有一条**反向断言** ——
>   `ffmpeg-static` / `youtube-dl-exec` 不许再出现在 `node_modules` 里，出现即红。
>
> 所以这条不需要 Manager 再裁：`YOUTUBE_DL_SKIP_DOWNLOAD=1` 这个方案本身也随之作废
> （包都不在了，没有 postinstall 可跳）。

## 6.4 ★ 真跑一次冷启动：三分类表

做法：全新数据目录 + **在 PATH 最前面放同名假二进制屏蔽宿主工具**，
装完**重启**（`materializeSqliteExtensions()` 只在启动时跑），再跑 selfcheck。

**先记一条把我自己的假设证伪的事实** —— `ubuntu-24.04` runner **并不自带 ffmpeg**：

```
ffmpeg      (不在 PATH 上)      ffprobe     (不在 PATH 上)
yt-dlp      (不在 PATH 上)      whisper-cli (不在 PATH 上)
sqlite3     /usr/bin/sqlite3    python3     /usr/bin/python3    cmake  /usr/local/bin/cmake
```

冷启动基线（什么都没装时）**精确复现了 T-093 的事故形态**：

```
[cold] tokenizer=trigram  libsimple=false  sqliteVec=false
     failures.libsimple:  文件不存在：<data>/bin/ext/libsimple.so
     failures.sqlite-vec: 文件不存在：<data>/bin/ext/vec0.so
[daemon] db=better-sqlite3 sqlite=3.53.4 schema=v1 tokenizer=trigram vec=off
```

装 5 个包（目录里判定"适用于本机"的全部）→ **独立核对 `/api/backends/installed` 全部在列** →
重启 → `[warm] tokenizer=simple libsimple=true sqliteVec=true`。

**三分类（判据直接用产品自己的 `packages/runtime/src/selfcheck.ts:551-596`，没另发明）：**

> **此前这里写的是 `selfcheck.ts:390-434` —— 那一段在读符号链接、判悬空**，不是三分类判据。
> 判据在 `:551-596`：「装在 storeRoot 里 = ok；只在系统 PATH 上 = warn；没有 = fail」。

| 分类                        | 数量  | 是哪些                                                                        |
| --------------------------- | ----- | ----------------------------------------------------------------------------- |
| ✅ **产品自己下载并校验的** | **5** | `tool.ffmpeg` `tool.ffprobe` `tool.whisperCli` `tool.whisperVad` `tool.ytDlp` |
| ⚠️ **借宿主 PATH 的**       | **0** | （无）                                                                        |
| ❌ **装不上 / 不可用**      | **0** | （无）                                                                        |

每一条的路径都实打实落在数据目录里，例如：

```
tool.ffmpeg   ok  required  /tmp/openmemo-coldstart-2621/data/models/by-name/backend/ffmpeg-n7.1.5-…
tool.whisperCli ok required  /tmp/openmemo-coldstart-2621/data/models/by-name/backend/whisper-bin-ubuntu-x64/…
tool.ytDlp    ok            /tmp/openmemo-coldstart-2621/data/models/by-name/backend/yt-dlp
backend.libLinks ok required 8 条链接全部可读到目标内容
```

**屏蔽组与不屏蔽组结果完全一致** —— 因为这台 runner 本来就没有那些工具。
所以这一轮**没有观测到任何"悄悄回退到宿主"的行为**。
⚠️ 但屏蔽这一步仍然必须保留：结论不能建立在"这款镜像今天恰好没装 ffmpeg"上。
（第二轮的 daemon 日志顺带证明了**回退路径确实存在**：屏蔽时它报
`缺少工具: asr-model`——即 ffmpeg/ffprobe/whisper-cli **都"找到了"**，找到的正是我放的 shim。）

## 6.5 ★ 你点名要验的那条：libsimple / sqlite-vec 真的能用吗

判据不是"文件下下来了"，是**中文双字词真的搜得到**：

```
ext.chineseSearch   ok    required=true    用户:1 推特:2 中国:1 服务:2
ext.jiebaDict       ok                     <data>/bin/ext/dict
ext.sqliteVec       ok                     v0.1.9
```

**T-093 那次事故（7 个包全 `succeeded`、sha256 全过，而 daemon 起来是
`tokenizer=trigram vec=off`）在这一轮没有复现。** `materializeSqliteExtensions()`
把两个来源不同、目录结构不同的扩展链进了同一个 `bin/ext`，重启后 tokenizer 变成 `simple`。

## 6.6 这一轮**没有**验到的（如实列出）

| 项                                | 状态                 | 说明                                                                                                                                                                                                         |
| --------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `model.asr`                       | **fail（required）** | 冷启动**不会自动装 ASR 模型**。我的驱动只调了 `/api/backends/install`，**没有调 `/api/models/pull`** —— 所以这既是"产品的冷启动确实不含模型"，也是"我的审计没覆盖模型下载那条路"。两种读法都成立，别只取一种 |
| `model.vad`                       | warn                 | 同上，VAD 模型没装 → 切分降级为固定窗口                                                                                                                                                                      |
| `hw.probe`                        | warn                 | `openmemo-probe 未安装` —— 与 T-141 §2.6 一致                                                                                                                                                                |
| sherpa-onnx / paraformer 实际加载 | **未验**             | 模型没装，引擎没跑起来过                                                                                                                                                                                     |
| macOS / Windows 上的冷启动        | **未验**             | 本节全部结论只覆盖 `ubuntu-24.04`                                                                                                                                                                            |
| npm 那两个二进制的 sha256         | **不存在**           | 不是"没验"，是上游就没提供校验（§6.3）                                                                                                                                                                       |

`meta.sameSource ok — 25 项逐 id 一致（本地 1 失败 / 端点 1 失败）`：
CLI 与 `GET /api/selfcheck` 给出的是同一份答案，没有"网页绿而 CLI 红"。

## 6.7 审计工具自己犯的两个错（写下来，因为它们正是本节要查的形状）

1. **`dependency-audit.mjs` 第一版把 `onlyBuiltDependencies` 解析成了空**
   （正则要求列表项连续，而真实文件每项前面有一行 `#` 注释）。
   它**面不改色地打印「(空)」**，我差点把"pnpm install 期不下载任何二进制"当结论报上去 ——
   而真实答案是 4 个包、其中两个就是去下二进制的（§6.3）。
   → 改逐行解析 + 一条 sanity 断言：解析出 0 项就出声。

2. **`cold-start-audit.mjs` 第一版自己就是一个假绿。**
   它打 `GET /api/jobs?id=<id>`（该端点不认 `?id=`，直接返回整份列表），
   取 job 那行写的是 `arr.find(...) ?? arr[0]` —— **`?? arr[0]` 就是那个洞**。
   第一次真跑的输出是 `media-tools-linux-x64 succeeded (1.0s)`：**119 MB，1.0 秒**，
   而 1.0s 恰好是轮询间隔。一个用来查"是不是真的下载了"的脚本，
   报了一串它根本没等过的成功。
   → 改单条端点 + 找不到就如实说找不到 + **最后用 `/api/backends/installed` 做独立地面真相核对**。
   第二版因为字段名写错（是 `uid` 不是 `id`）仍然没认出 job，
   但它**红得诚实**：说"我不认识这条"，而不是拿别人的成功顶上。
   **同一个地方、两种失败方式，差别就是有没有那个 `?? arr[0]`。**

---

# §7 冷启动审计第二轮：三平台 + 拉模型 + 删掉 npm 那条通道

> 证据来源：`cold-start-audit` run 31028964565（三平台首跑）。

## 7.1 ★★ 最重要的一条：**macOS 上产品真的会去借宿主的 ffmpeg**

§6 的结论是「借宿主 PATH 的 = 0」。**那条结论只在 Linux 上成立。**
同一份脚本、同样屏蔽宿主工具，在 `macos-26` 上：

```
tool.ffmpeg      warn   .../maskbin/ffmpeg（来自系统 PATH，非本产品安装）
tool.ffprobe     warn   .../maskbin/ffprobe（来自系统 PATH，非本产品安装）
tool.whisperCli  warn   .../maskbin/whisper-cli（来自系统 PATH，非本产品安装）
tool.whisperVad  warn   未找到
tool.ytDlp       ok     .../data/models/by-name/backend/yt-dlp
```

**三个工具解析到了 `maskbin/` —— 也就是我放的假二进制。**
这不是脚本出错，这正是脚本要抓的东西：**产品在 macOS 上确实会回退到宿主 PATH。**

成因在上一行就写着：

```
目录共 19 个包，适用于本机 3 个：
  - ytdlp-macos-arm64
  - libsimple-darwin-arm64
  - sqlite-vec-darwin-arm64
```

~~**19 个包里只有 3 个适用于 macOS —— 没有 ffmpeg，没有 whisper-cli。**~~
这正是 `platform` T-141 §1.2 第 1 行预测的那一格（"macOS 装不了任何转写引擎，也没有 ffmpeg"），
**现在是从一次真实冷启动里量出来的，不是从 manifest 数出来的。**

> ✅ **T-146 已补齐（本节的计数与"没有 ffmpeg/whisper-cli"这半句已过期）**：
> 目录现有 **22 个包**，macOS arm64 适用 **5** 个 ——
> `whispercpp-cpu-macos-arm64`（转写引擎，CPU+Metal+CoreML 一包带齐）、
> `media-tools-macos-arm64`（`providesFiles: ["ffmpeg","ffprobe"]`）、
> `ytdlp-macos-arm64`、`libsimple-darwin-arm64`、`sqlite-vec-darwin-arm64`。
> 相关提交：`2075a88`（补齐 Windows / macOS 的 ffmpeg）、`1b2a39d`（macOS 核心包一次带齐 CPU + ANE + Metal）、`830ada9`（macOS 终于有了转写引擎）。
>
> **此前写着"19 个包里只有 3 个适用于 macOS —— 没有 ffmpeg，没有 whisper-cli"** ——
> 那是 run 31028964565 当时的事实。**但本节的产品结论不变**：
> "macOS 上产品会安静地回退去借宿主 PATH 的 ffmpeg，只给 `warn` 不给 `fail`"这个**行为**依然存在，
> 只是**触发条件已大幅收窄**（现在得是包装不上或被跳过时才会走到那条回退路径）。
> 下面的分析（为什么只有屏蔽后才看得见、`warn` 淹没在绿里）原样有效。

### 为什么这条只有屏蔽之后才看得见

一台真实的 Mac 上大概率装着 Homebrew 的 ffmpeg。那么：

> 产品会**安静地用上它**，selfcheck 会给一个 `warn`（不是 `fail`），
> 而 `warn` 在一片绿里几乎不会有人细看。
> 用户换一台没装 ffmpeg 的 Mac，同一个版本就突然不能用了 —— 而**没有任何东西变过**。

**这就是用户那句「我怕了你」问的东西的准确形态**，而它：

- 在 Linux 上**不存在**（19 个包里 5 个适用，ffmpeg/whisper 都有）；
- 在 CI 上**不屏蔽就看不见**（ubuntu runner 恰好没装 ffmpeg，macOS runner 也没有 ——
  所以真机上是 `warn+未找到`，而用户机器上会是 `warn+悄悄可用`）。

⚠️ **诚实边界**：runner 上 `tool.whisperVad` 是"未找到"，而不是借到了什么。
我们观测到的是「**产品会去 PATH 找**」这个**行为**，
至于用户机器上那个 ffmpeg 能不能真的完成转写，**没有验证过**。

## 7.2 三分类（按平台）

> 📅 **本表是 run 31028964565 当时（T-145 轮）的快照。** T-146 之后 macOS 侧已变：
> 目录 19 → **22 包**，darwin-arm64 适用 3 → **5**（加了 `whispercpp-cpu-macos-arm64` 与 `media-tools-macos-arm64`）。
> **表里的 macOS 列没有重测，不要当成当前值引用**；重测前请以 `vendor/manifests/*.json` 为准。

|                         | linux-x64                                                 | darwin-arm64                                                          |
| ----------------------- | --------------------------------------------------------- | --------------------------------------------------------------------- |
| ✅ 产品自己下载并校验的 | **5**：ffmpeg / ffprobe / whisperCli / whisperVad / ytDlp | **1**：ytDlp                                                          |
| ⚠️ 借宿主 PATH 的       | **0**                                                     | **3**：ffmpeg / ffprobe / whisperCli                                  |
| ❌ 装不上 / 不可用      | **0**                                                     | **1**：whisperVad                                                     |
| 适用的后端包            | 5 / 19                                                    | **3 / 19**（T-146 后为 **5 / 22**）                                   |
| `ext.chineseSearch`     | **ok**（用户:1 推特:2 中国:1 服务:2）                     | 装上了扩展（`[warm] tokenizer=simple libsimple=true sqliteVec=true`） |

**中文检索这条在两个平台都成立** —— libsimple / sqlite-vec 的 darwin-arm64 包
真的装上并生效了（冷启动时 macOS 找的是 `libsimple.dylib` / `vec0.dylib`，与 Linux 的 `.so` 不同，
这条路径也因此第一次被真机走过）。

## 7.3 补上 `/api/models/pull` 之后，那个含糊的红变成了两条具名结论

`[实测 linux]` 拉模型这一步现在真的跑了：

```
/api/models/catalog：20 个分组，展平后 35 个模型条目
目录里 role in {asr,vad} 且 required-core 的模型 2 个
  vad/silero-vad-onnx   succeeded (1.0s)
  vad/silero-vad-ggml   succeeded (2.0s)
── 独立核对：/api/models/installed 返回 2 条 ──
```

然后：

```
model.vad   ok    .../data/models/by-name/asr/ggml-silero-v6.2.0.bin
model.asr   fail  required   无可用 ASR 模型
                             （by-name/asr 下只有非 ASR 角色的文件：
                              ggml-silero-v6.2.0.bin, silero_vad.onnx）
```

**两条产品结论（不是审计缺口了）：**

1. 🔴 **目录里 `required-core` 的 asr/vad 模型一共 2 个，全是 VAD，没有一个 ASR。**
   也就是说：**照着 `required-core` 装完，仍然不能转写。**
   "冷装之后必须先自己挑一个 ASR 模型下载"——这是产品事实，应该写进首启引导，
   而不是让 selfcheck 的一条 `fail` 去承担这个信息。
2. 🟡 **两个 VAD 模型被链到了 `by-name/asr/` 底下**，`model.asr` 的报错原文
   （"by-name/asr 下只有非 ASR 角色的文件"）说明检查器知道它们不该在那儿。
   role → 目录 的映射疑似有问题。`[未定性]`

⚠️ **一条自我更正**：我在本机 smoke 时看到过 `meta.sameSource fail —— model.vad: 本地=warn 端点=ok`，
一度当成产品 bug。**CI 上是 `ok`（25 项逐 id 一致）。** 本机那次两个 VAD 只装成了一个
（另一个 `INTEGRITY_ALL_SOURCES_FAILED`，本机网络问题），是**半装状态**下的瞬时不一致。
**本机的红没有资格当结论 —— 这次它自己证明了这条规矩。**

## 7.4 npm 那条通道已经删掉（不是加锁）

`ffmpeg-static` 与 `youtube-dl-exec` **已从 `packages/pipeline` 的 dependencies
和 `onlyBuiltDependencies` 中删除**。删除前实测三查全空（无 import、无路径引用、
测试里零出现），删除后 `require.resolve` 双双 `MODULE_NOT_FOUND`，
`pnpm install` 少 52 个包，`pnpm -r test` 874/0 不变。

CI 上的反向断言（三平台）：

```
== ffmpeg-static / youtube-dl-exec 是否还在 node_modules 里 ==
  ✔ ffmpeg-static 不存在
  ✔ youtube-dl-exec 不存在
```

判据是**减少通道**而不是给每条通道加锁：「哪条是权威」这个问题
今天已经在 `/models` vs `/settings`、`defaultModelId` vs `providers[i].model`、
两张补救路由表上各栽过一次。

许可证义务换了记录的地方（已核对 `backends.json` 的 `license` 字段全是 `GPL-3.0-or-later`），
并且把 `license-report.mjs` 里那条**靠人记得**的纪律换成了守卫：
`onlyBuiltDependencies` 里没被覆盖的包 → **exit 1**（反向验证过）。

## 7.5 这一轮我自己犯的错（继续记账）

| #   | 错                                                                                   | 后果                                                      | 教训                                                                                                                               |
| --- | ------------------------------------------------------------------------------------ | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 3   | `/api/models/catalog` 是**分组**结构（`groups[].variants[]`），我按 `body.models` 取 | 拿到 0 个模型、照常往下走，打印出一句读起来像产品结论的话 | **本任务同一形状的第三次：工具安静地返回空集，被读成"没有"。** 现在空集会当场出声                                                  |
| 4   | job 的字段名是 **`jobId`**，我按 `uid` 比                                            | 每次都报"不认识这条 job"                                  | `jobs.ts:182` 的注释写「This is D-02 `jobs.uid`」—— **那说的是数据库列名，字段名在下一行**。一条准确但指向别处的注释同样能把人带偏 |
| 5   | `/tmp/install.log` 写在没有 `shell: bash` 的步骤里                                   | Windows pwsh 解析成 `D:\tmp\install.log` 当场炸           | 跨平台 workflow 里，**POSIX 路径 + 默认 shell = 只在两个平台上成立**                                                               |
| 6   | 观测用的 `find -perm` 把整步拖红                                                     | "反向核实"步骤红掉，**而它上面刚刚正确报出了结论**        | **一个用来看的步骤，不该有能力决定红绿**                                                                                           |

第 4 条修好之后，安装耗时立刻变得可信（14.1s / 52.3s / 28.1s），
而第一版全是 `1.0s`——**正好是轮询间隔**。

---

# §8 ★ 「产物被构建机的版本钉死」—— 同一族，三个平台各有一条

> **本节由 `pack-publish` 追加（T-146，2026-08-06）。** 正文其余部分属 `ci-runner`，我一个字没改。
> 起因：发布 macOS 包之前解包核对 `LC_BUILD_VERSION`，发现产物被钉在了构建机自己的系统版本上。
> Manager 指出这可能是一族而不是一条，让顺着查 Linux —— 查了，**三个平台各有一条**。

## 8.0 这一族的共同形状（**这一条才是要记住的**）

> **构建机总是那个"最新、装得最全"的环境，而用户的机器不是。**
> 凡是「不显式指定就取构建机当前值」的东西，都会把构建机的新度**焊进产物**，
> 而后果一律是**在用户机器上才显形**，且**一律不报错**：
> 装得上、校验过、自检看得见的那一层全绿，只有真正去执行时才死。
>
> 判据不是"能不能编出来"，是**"编出来的东西声明了什么下限"**。
> 这三条都不是靠读代码发现的，是**解开产物去读它的元数据**发现的。

| 平台    | 被钉死的东西                      | 谁定的                                              | 后果                                       |
| ------- | --------------------------------- | --------------------------------------------------- | ------------------------------------------ |
| macOS   | `LC_BUILD_VERSION.minos`          | `CMAKE_OSX_DEPLOYMENT_TARGET` 缺省 = 构建机系统版本 | 低版本 macOS 上 **dyld 直接拒绝加载**      |
| Linux   | 最高 `GLIBC_x.y` 符号版本         | 构建机的 glibc / GCC 版本                           | 老发行版上 **`dlopen` 失败**               |
| Windows | `MSVCP140` / `VCRUNTIME140*` 导入 | MSVC 工具链                                         | 没装 VC++ 可再发行组件的机器上**加载失败** |

## 8.1 macOS：`minos` = 构建机的系统版本（**已修**）

`[实测]` 解开 `whispercpp-cpu-macos-arm64.tar.gz`，逐个二进制读 `LC_BUILD_VERSION`：

```
修复前：12 个二进制全部  minos = 26.0.0   sdk = 26.5.0
修复后：12 个二进制全部  minos = 13.3.0   sdk = 26.5.0
```

runner 是 `macos-26`，而 CMake 不显式设部署目标时就取构建机自己的版本。
→ 那个包**只能在 macOS 26 上跑**，而 macOS 26 是最新版。
症状：下载成功 → sha256 通过 → 安装 `succeeded` → **一执行就死**，
而 selfcheck 只看得到"文件在"。

修法：`-DCMAKE_OSX_DEPLOYMENT_TARGET=13.3`（`scripts/build-whisper.sh`）。
**13.3 不是拍的**：上游自己的 `vendor/whisper.cpp/build-xcframework.sh:5` 写着
`MACOS_MIN_OS_VERSION=13.3` —— 同一份代码、上游测过的下限。

## 8.2 🔴 Linux：`whispercpp-vulkan-linux-x64` 需要 **GLIBC_2.38**（**未修**）

`[实测]` 三个 Linux 包逐个 ELF 跑 `objdump -T`，取最高 `GLIBC_x.y`：

| 包                            | 构建机（§2.1 矩阵） | 最高 GLIBC 需求 | 判定                                                   |
| ----------------------------- | ------------------- | --------------- | ------------------------------------------------------ |
| `whispercpp-cpu-linux-x64`    | **ubuntu-22.04**    | **2.34**        | ✅ Ubuntu 22.04 / Debian 12 都能跑                     |
| `whispercpp-cuda-linux-x64`   | ubuntu-24.04        | 2.27            | ✅ **碰巧**安全（只有一个 `.so`，用到的符号少）        |
| `whispercpp-vulkan-linux-x64` | ubuntu-24.04        | **2.38**        | 🔴 **Ubuntu 22.04(2.35) / Debian 12(2.36) 上加载失败** |

**具体是哪三个符号**（这让它不是推测）：

```
(GLIBC_2.38) __isoc23_strtoul
(GLIBC_2.38) __isoc23_strtoull
(GLIBC_2.38) __isoc23_strtol
```

C23 的 `strtol` 家族 —— GCC 13+ / glibc 2.38 起，编译器会把普通的 `strtol`
**自动重定向**到 `__isoc23_*` 变体。**源码一个字没改，换台机器编就多了一条运行时下限。**

发行版对照：`Ubuntu 22.04 = 2.35` · `Debian 12 = 2.36` · `Ubuntu 24.04 = 2.39` · `Debian 13 = 2.41`。

### 成因可以指名道姓，就在本文件里

- §2.1 的矩阵注释写着 `linux-x64-cpu` 「**刻意留 22.04 = glibc 基线**」；
- §4.2 记录 `linux-x64-vulkan` 因为 jammy 没有 `glslc` 包而**从 22.04 改到 24.04**。

**那次改动解决了编译问题，同时把运行时下限从 2.34 抬到了 2.38 —— 而没有人注意到。**
基线是刻意留的，偏离它却是顺手的：**一条靠"记得别动它"维持的基线，等价于一条迟早会被绕过的基线。**

### 为什么它比 macOS 那条更隐蔽

`GGML_BACKEND_DL=ON` 下，`dlopen` 失败**不是错误** —— 只是"这个后端没注册上"。
whisper 会照常用 CPU 跑完，**用户只会觉得"装了 Vulkan 包但没变快"**。
没有任何一处会说话：安装记录是成功的，sha256 是对的，自检里也没有对应的检查项。

### ⚠️ 给下一个想接这个包的人

`whispercpp-vulkan-linux-x64` **目前不在 `backends.json` 里**（另有原因，见 §8.4），
所以这条**眼下不伤用户**。但要接它之前，**必须先做下面二选一**：

1. **把 `linux-x64-vulkan` / `linux-x64-cuda` 两条构建腿挪回 `ubuntu-22.04`**
   —— 但 jammy 没有 `glslc`（§4.2 就是为此才挪走的），得另找 Vulkan SDK 的装法；**或者**
2. **加一条运行期检测把这件事说出来** —— 装之前比对本机 glibc 与包声明的下限，
   或装完真的 `dlopen` 一次并把结果报进 selfcheck。

**不要只看到"这个包能用"就接进去** —— 在 24.04 的机器上它确实能用，
而那正是这类 bug 每次都能溜过去的原因。

## 8.3 🟡 Windows：所有自建原生产物都依赖 VC++ 运行时（**未修**）

`[实测]` `objdump -p ggml-vulkan.dll`：

```
DLL Name: ggml-base.dll          ← ★ 跨包依赖，见 §8.4
DLL Name: vulkan-1.dll           （随显卡驱动安装，正常）
DLL Name: MSVCP140.dll
DLL Name: VCRUNTIME140.dll
DLL Name: VCRUNTIME140_1.dll     ← ★ VC++ 2015-2022 可再发行组件，干净 Windows 不自带
DLL Name: api-ms-win-crt-*.dll   （Universal CRT，Win10+ 自带，正常）
DLL Name: KERNEL32.dll
```

**这与 `win-fixes` 对 `simple.dll` 的实测结论是同一条**（他标注了「runner 一定有，
用户机器不一定」）。两边各查到一半，拼起来是：
**本产品所有自建的 Windows 原生产物都依赖 VC++ 运行时，而产品没有任何地方检查它在不在。**

## 8.4 🔴 顺带证实：**纯增量的加速包在本产品里结构上不可用**

三条**独立**证据指向同一结论 —— **加速包必须自包含**：

1. **ggml 只在两个地方找后端模块**（`vendor/whisper.cpp/ggml/src/ggml-backend-reg.cpp:479-489`）：
   `get_executable_path()`（whisper-cli 自己的目录）与 `fs::current_path()`。
   而安装器把每个包解到 `by-name/backend/<各自的归档名>/` —— 增量包的
   `libggml-vulkan.so` 与 whisper-cli **永远不在同一个目录**；cwd 是 job 的临时目录，也不是。
   `GGML_BACKEND_PATH` 环境变量存在，但 `packages/pipeline/src/subprocess/runner.ts:92-94`
   的 env 白名单里**没有它**。
2. **模块自己也解析不了依赖**：`ggml-vulkan.dll` 的导入表里有 `ggml-base.dll`，
   而它在**另一个包的目录里**。也就是说不只是"找不到这个模块"，
   是"**就算找到了，模块自己也加载不起来**"。
3. **反证**：目录里唯一**能用**的加速包 `whispercpp-cuda-12.4-win-x64`，
   它的 `providesFiles` 是 `["ggml-cuda.dll", "whisper-cli.exe"]` —— **它自带 whisper-cli**。

而 `scripts/build-whisper.sh` 里那句设计注释写的是
「L2 accel = **ONLY** the single ggml-`<backend>` shared library … Keeping it to just the
delta is what makes requirement 2.1 cheap」—— **写着 A，实现是 B，从来没人对过**。
该不一致已原样写进脚本注释（不是绕过它）。

**macOS 的 Metal 是这一族里唯一能就地解决的一格**：`GGML_METAL_EMBED_LIBRARY=ON`
把着色器编进二进制、不需要伴随资源文件，所以只要跟着核心包一起出厂位置就对了 ——
这也正是 `build-backends.yml` 自己的注释早就写着的「Metal … 的 pack 其实装在核心包里」，
以及 `packages/runtime/src/backends/applicability.ts:36-42` 那段
「Metal 看起来像 L2、行为像 L1」的依据。已实施：macOS 核心包现在自带
`libggml-cpu.so` + `libggml-metal.so` + `libwhisper.coreml.dylib`。

→ **Linux/Windows 的 Vulkan 与 CUDA 增量包因此暂不进目录**（§8.2 那条 glibc 也就暂时不伤用户）。
要接它们，得先让加速包自包含，或者补一条"把后端模块搬到引擎目录旁边"的机制
（`materializeSqliteExtensions()` 对 SQLite 扩展做的正是这件事，后端模块没有对应物）。

---

# §9 `openmemo-probe` 的分发通道 —— 以及**同一族的第四条**

> **本节由 `platform-backlog`（T-167，2026-08-07）追加。**
> 作者是 `ci-runner`，§1–§7 的正文一个字未改；§8 是 `pack-publish` 追加的（T-146）。
> 本节延续 §8.0 那条共同形状，补上它在**探针**这个产物上的第四次现形，
> 以及「探针为什么必须在包里」的三条独立依据。

## 9.0 结论先给

| #   | 事                                                      | 状态                            |
| --- | ------------------------------------------------------- | ------------------------------- |
| ①   | 探针**不能**单独分发 —— 它动态链接 ggml，裸跑起不来     | ✅ `[本机实测]`                 |
| ②   | 探针必须在**每一个**包里，不只是核心包                  | ✅ 三条依据，见 §9.2            |
| ③   | macOS 探针 `minos = 26.0.0`（§8.1 只修了包，没修探针）  | ✅ **已修**，`[CI 实测]` 13.3.0 |
| ④   | Windows 探针的导入表**不需要** VC++ 运行时（只有 UCRT） | ✅ `[本机实测]`，但见 §9.4      |
| ⑤   | 「探针发出去 → Windows 适用包 5 变 6」                  | ❌ **因果关系不成立**，见 §9.5  |

## 9.1 ① 探针**不是**自包含的可执行文件

`[本机实测 2026-08-07]`，对象是 `build-backends` run 31147884172 的
`packs-linux-x64-cpu` artifact 里那个 `dist/probe/openmemo-probe`（17,208 B）：

```
$ objdump -p openmemo-probe | grep -E 'NEEDED|RUNPATH'
  NEEDED   libggml-base.so.0
  NEEDED   libggml.so.0
  NEEDED   libc.so.6
  RUNPATH  $ORIGIN

$ ./openmemo-probe                       # 同目录没有那两个库
  error while loading shared libraries: libggml-base.so.0: cannot open shared object file

$ cp openmemo-probe <解开的 whispercpp-cpu-linux-x64>/ && cd 那个目录
$ env -u LD_LIBRARY_PATH ./openmemo-probe .
  {"schemaVersion":1,"ggmlVersion":"0.15.1","deviceCount":1,
   "devices":[{"name":"CPU","backendReg":"CPU","type":"cpu", …}]}
```

成因在 `scripts/build-probe.sh:68`：`LDFLAGS=( -L … -lggml-base -lggml )`。
它**从设计上就是**一个跟着 ggml 走的东西 —— `probe.c` 的文件头写着
「links only ggml-base + ggml；the backend .so files are dlopen'd at runtime by
`ggml_backend_load_all_from_path`」。

→ **把它当成 yt-dlp 那种"扁平落点的独立可执行文件"发出去，在用户机器上一次都启动不了。**
而它启动不了的表现是 `runProbe()` 返回失败 → 界面写「尚未探测到硬件能力」
—— **与"这台机器真的没有 GPU"在界面上完全一样**（§8.0 那条形状的又一次）。

## 9.2 ② 为什么必须在**每一个**包里，而不只是核心包

三条依据，任何一条单独都够：

1. **§9.1**：它要和 `libggml-base` 同目录才起得来。
2. `apps/daemon/src/runtime/setup.ts` 的 `backendDir` 定义就是 `path.dirname(probePath)`
   —— 产品从设计上假定"探针与 ggml 后端模块同目录"。
3. `probe.c:110` 只调一次 `ggml_backend_load_all_from_path(backend_dir)`：
   **它只能枚举与它同目录的那些后端**。只有核心包带探针时，装了 Vulkan 包的用户
   枚举不到 vulkan 设备 → `hardware.backends.vulkan.available` 恒 false。

`[本机实测]` 用**产品自己的** `resolveRuntimeLayout()` 在真 store 上验：

```
场景 cpu-only            probePath = <models>/by-name/backend/whisper-bin-ubuntu-x64.tar.gz/openmemo-probe
                         backendDir = 同目录          runProbe.ok = true   deviceCount = 1
场景 cpu+vulkan（未选）  probePath = <models>/by-name/backend/whispercpp-vulkan-linux-x64.tar.gz/openmemo-probe
                         ← priority 80 > 10，**加速包那份探针胜出，backendDir 自然对上**
场景 cpu+vulkan + 用户显式选 cpu
                         probePath 回到 CPU 包        ← 见 §9.3，这是**残留缺口**
```

→ T-167 的做法：`scripts/build-whisper.sh` 把探针编进**每个** stage
（在 strip / codesign 之前，两步一起管它），编不出来当场 die。
`[CI 实测 run 31155359839]`：linux-cpu 的 ELF 从 22 → **23**、linux-vulkan 23 → **24**、
macOS 的 Mach-O 12 → **13**，codesign 从 12 → **13** 个文件。

## 9.3 ⚠️ 残留缺口（**没修，交给 `daemon-backlog`**）

`backendDir` 是**单值**的，而 `resolveBackendTool()` 只挑一个包。于是：

> 用户显式选了 `cpu`（或同时装了两个加速包）时，探针只会看**一个**目录，
> 另一个已安装的加速包会被报成
> `installed but enumerated no devices (driver missing or too old)` ——
> **一句具体的、而且是错的诊断**（它在怪驱动，真实原因是探针看错了目录）。

`[本机实测]` 已复现（上面第三个场景）。**今天不伤人，因为今天根本没有探针**；
探针发出去之后它就成立了。建议的判据：

> `detectHardware` 应当对**每一个已安装的后端包目录**各跑一次探针并取并集，
> 而不是只跑 `dirname(probePath)` 那一个。
> 判据：CPU 包 + Vulkan 包同时装着、用户显式选 cpu 时，
> `hardware.backends.vulkan` 必须仍然报得出真实结论。

## 9.4 ③④ 两个平台的"构建机版本焊进产物"复查

**macOS（§8.1 的第四次现形）**。`[本机实测]` 同一轮 CI（run 31121718587）的两样产物：

```
whispercpp-cpu-macos-arm64.tar.gz 里的 20 个 Mach-O    minos = 13.3.0
dist/probe/openmemo-probe                              minos = 26.0.0   ← ★
```

§8.1 修的是 `build-whisper.sh`（`-DCMAKE_OSX_DEPLOYMENT_TARGET=13.3`），
`build-probe.sh` **是另一个文件，没人想到它**。这与 T-163 在 Linux 上说的是同一句话：
「守卫只看包的内容，而探针是单独 upload 的」——
**一个漏掉探针的守卫，在两个平台上各漏了一次。**

已修三件事：`build-probe.sh` 传 `-mmacosx-version-min`；13.3 与 2.34 收进
`scripts/lib/baselines.sh`（**同一个数字写在两个地方然后只改一个**，是这三次事故的共同成因）；
新增 `scripts/ci/check-macho-minos.mjs` 守卫 —— **纯 node 解析 Mach-O，不调 `otool`**，
所以它的 7 条反向用例能在 Linux 开发机上真的拿到红灯，而不必赌一次 macOS CI。
`[CI 实测 run 31155359839]` macos-arm64-cpu：`13 个 Mach-O … 实测最高 13.3.0`，探针在内。

**Windows（§8.3 的一格）**。`[本机实测]` `objdump -p openmemo-probe.exe` 的导入表：

```
KERNEL32.dll · api-ms-win-crt-{environment,heap,locale,math,private,runtime,stdio,string}-l1-1-0.dll
ggml-base.dll · ggml.dll
```

**没有 MSVCP140 / VCRUNTIME140** —— 探针自己是 UCRT（Win10+ 自带）。
⚠️ **但这不构成「Windows 上没问题」**：它链接的 `ggml-base.dll` / `ggml.dll` 仍然依赖
VC++ 可再发行组件（§8.3 未修）。探针会和它们一起起不来。

## 9.5 ⑤ ★「探针发出去 → Windows 适用包 5 变 6」——**因果关系不成立**

这条推断来自 `docs-public` §3.3，由三条证据拼成，其中第 2 条
（「探针为 null 时 L2 一律 `applicable:false`」）**在写下之后被 `gates-fix` T-160
（`4bb846e`）改掉了**：advisory 探测成了第二条独立证据。
被引用的那次 CI 观测（run 31076010999）早于 T-160。

`[本机实测]` 用**产品自己的** `evaluateApplicability()` 跑真目录（23 个包，Windows x64 占 6 个）：

| 场景                                               | 适用                                                 |
| -------------------------------------------------- | ---------------------------------------------------- |
| A 今天的 CI runner（无探针、无 NVIDIA）            | **5 / 6**，CUDA 被拒：「尚未探测到硬件能力」         |
| B 今天的真 N 卡 Windows（无探针，`nvidia-smi` 在） | **6 / 6** ← ★ **今天就是 6，不需要探针**             |
| C 探针发出去后的 CI runner（无 NVIDIA）            | **5 / 6**，理由变成「backend package not installed」 |
| D 探针发出去后的真 N 卡 Windows                    | **6 / 6**                                            |

机制：`detect/gpu.ts` 的 Windows 分支先跑 `nvidia-smi`，成功就给
`candidateBackends: ['cuda','vulkan']`；`Get-CimInstance Win32_VideoController`
那条**永远只给 `['vulkan']`**，且软件适配器被 `SOFTWARE_ADAPTER_NAMES` 过滤。
GitHub 的 `windows-2025` runner 没有 NVIDIA 驱动 → 没有 `nvidia-smi` → cuda 永不入选。

**两条结论**：

1. **「Windows CUDA 包今天装不上」这句话要限定到"没有 N 卡的机器"** ——
   而那是**正确行为**，不是缺陷。有 N 卡的 Windows 上它今天就是可装的。
2. **这条判据没法在 CI 上验**，因为把它从 5 变到 6 需要一块真 NVIDIA 卡，
   而任何 GitHub 托管 runner 都没有。**不是"还没验"，是"这个 runner 结构上验不了"。**
   探针真正买到的是另一样东西：`hw.probe` 从
   `warn: openmemo-probe 未安装（后端能力未知）` 变成 `ok: N 个设备, ggml 0.15.1`
   （`[本机实测]` 逐行复刻 `selfcheck.ts` 的那一条，喂真 store，两种形状各跑一遍）。

## 9.6 🔴 还差的那一步：**Linux 与 Windows 的核心包指的是上游，不是我们编的**

`vendor/manifests/backends.json` 现状：

| 包                             | 来源                                                      | 里面会有探针吗            |
| ------------------------------ | --------------------------------------------------------- | ------------------------- |
| `whispercpp-cpu-linux-x64`     | `ggml-org/whisper.cpp` 的 `whisper-bin-ubuntu-x64.tar.gz` | ❌ 上游的包，我们加不进去 |
| `whispercpp-cpu-win-x64`       | `ggml-org/whisper.cpp` 的 `whisper-bin-x64.zip`           | ❌ 同上                   |
| `whispercpp-cuda-12.4-win-x64` | `ggml-org` 的 `whisper-cublas-12.4.0-bin-x64.zip`         | ❌ 同上                   |
| `whispercpp-cpu-macos-arm64`   | **我们自己编的**                                          | ✅                        |
| `whispercpp-vulkan-linux-x64`  | **我们自己编的**                                          | ✅                        |

→ **探针要到达 Linux 与 Windows 用户，前两条必须换成我们自己的构建。**
两个包我们本来就在编、CI 每轮都产出，只是目录一直指向上游。
换与不换的取舍、以及 Windows CUDA 那条（上游包没有探针，装上之后会落进 §9.3 那个缺口）
写在 `coordination/inbox/platform-backlog.md`，**需要 Manager 拍板 + 一次 release**。

## 9.7 §9.6 那一步已经落地（2026-08-07）—— 以及 Windows CUDA 为什么**刻意不动**

**§9.6 说的"还差的那一步"做完了。** Manager 2026-08-07 裁定「Linux / Windows 核心包
换成我们自建的」，依据就是 §9.1–§9.2：上游归档里永远不会有我们的探针。
例外写进了 **ADR-015 §7**（含代价与未知的逐条清单，不是一句"换了"）。

`[本机实测 2026-08-07]` **走产品真实安装路径**验完整条链
（真 manifest 条目 → 真 `install()` 分片下载 → 校验 sha256 → 解包 → 硬链 →
真 `resolveRuntimeLayout()` → 真 `runProbe()` 子进程；数据目录是 `mkdtemp`，
不启 daemon、不写指针）：

```
url  https://github.com/faorcoek042/openmemo/releases/download/backend-packs-2026.08.07b/whispercpp-cpu-linux-x64.tar.gz
install() → 1 个文件，4.6s
resolveRuntimeLayout()  probeExists=true  backendDir=<models>/by-name/backend/whispercpp-cpu-linux-x64
runProbe()              ok=true   ggml 0.15.1 / f049fff9   deviceCount=1   CPU/type=cpu
自检 hw.probe           status=ok  detail='1 个设备, ggml 0.15.1'      ← 此前是 warn「openmemo-probe 未安装」
findInBackendPacks(whisper-cli) = <models>/by-name/backend/whispercpp-cpu-linux-x64/whisper-cli
```

⚠️ **只在 Linux x64 上验到了这一步。** Windows / macOS 的同一条链是
`[未验证]` —— 要一轮 `cold-start-audit --transcribe`，判据仍是
「屏蔽宿主 PATH 的干净机器上真的转出非空文本」。

### Windows CUDA：**状态是「可能已经好了，但验不了」，不是「坏的」**

Manager 2026-08-07 裁定**先不动它**，理由是 §9.5 那张表：

- 判据（「适用包 5 变 6」）本身站不住 —— **有 N 卡的 Windows 今天就是 6/6**，
  `gates-fix` T-160 的 advisory 逃生口已经解开它；
- **任何 GitHub 托管 runner 都验不了这一格**：把它从 5 变到 6 需要一块真 NVIDIA 卡。

所以它现在的准确状态是：

> 🟡 **`whispercpp-cuda-12.4-win-x64` 在有 NVIDIA 驱动的 Windows 上"应该"可装且可用，
> 但没有任何人在真硬件上看到过。** 要收这一格，**必须一台带 NVIDIA GPU 的 Windows**，
> CI 替代不了。

同时如实记下**它没有探针**（上游包，我们加不进去），因此装上它之后会落进 §9.3
那个 `backendDir` 单值缺口：探针会从我们的 CPU 包解析出来，看不到 cuda，
于是把它报成 `installed but enumerated no devices (driver missing or too old)`
—— **一句具体的、而且是错的诊断**。这一条已转给 `daemon-backlog`。

**刻意不做的**：不为了让某个数字变好看去换成我们自建的 Windows CUDA 包
（我们只编 `--cuda-arch 86;89`，比上游的 fat 包窄；换了会让老/新卡的用户一无所有）。

## 9.8 换包之后的三平台冷启动实测（`cold-start-audit`，**换包前后同一个 workflow**）

`[CI 实测]` run **31152458527**（`8cb3b35`，换包前）对比 run **31160171438**
（`ec29792`，换包后）。两轮只差目录里那四条 —— 判据仍是
「屏蔽宿主 PATH 的干净机器上，从网页装 → 拉模型 → 走真实转写路径拿到非空文本」。

| 平台             | `hw.probe` 换包前                            | `hw.probe` 换包后                                    | 适用包 | 转写                       |
| ---------------- | -------------------------------------------- | ---------------------------------------------------- | -----: | -------------------------- |
| **linux-x64**    | `warn` openmemo-probe 未安装（后端能力未知） | ✅ **`ok` 1 个设备, ggml 0.15.1**                    |  6 → 6 | succeeded 2.1s，108 字符   |
| **win32-x64**    | `warn` openmemo-probe 未安装（后端能力未知） | ✅ **`ok` 1 个设备, ggml 0.15.1**                    |  5 → 5 | succeeded 3.7s，108 字符   |
| **darwin-arm64** | `warn` openmemo-probe 未安装（后端能力未知） | 🟡 **`warn` probe timed out after 10000ms (killed)** |  5 → 5 | succeeded 111.8s，108 字符 |

三平台都是「产品自己下载并校验的 (5) · 借宿主 PATH 的 (0) · 装不上/不可用 (0)」——
**换包没有弄坏任何东西**，而 Linux 与 Windows 上「网页检测硬件」这一步第一次真的有了答案。

### 🟡 macOS 那一格：**探针找到了，但它超时**

这是**新的、实测出来的**一条，不是回归：换包前那台机器上根本没有探针（报"未安装"），
现在它在包里、被解析到了、被启动了，**然后 10 秒没返回**。两次自检**两次都超时**
（`CIRCUIT_BREAKER_THRESHOLD = 2`，所以断路器会跳闸并拉黑加速后端）。

- **`UNKNOWN`：成因没有定性。** 最可能是 `ggml_backend_load_all_from_path` 在
  加载 `libggml-metal.so` 时的 Metal 设备初始化，而 GitHub 的 macOS runner 是
  **虚拟化的 3 核 M1**（同一台机器上转写要 111.8 s，Linux 只要 2.1 s —— 53 倍）。
  我**分不清**「10 秒对这台 runner 太短」「虚拟化 macOS 上 Metal 初始化会挂」
  与「真有 bug」这三者，日志里也没有探针的 stderr。**要一台真 Mac 才能定性。**
- **刻意不做的**：不去调大 `PROBE_TIMEOUT_MS`。它是 ADR-003 决策 3 定死的 10 秒，
  **把一个常量改大让 warn 消失，正是本仓最该避免的动作** —— 那会把"探针在这台机器上挂了"
  变成"探针在这台机器上慢"，而两者需要的处置完全不同。
- **实测到的后果边界**：断路器跳闸拉黑的是加速后端，但 macOS 的 `metal` 走
  `isAlwaysApplicable`（applicability.ts:36-42「看起来像 L2、行为像 L1」），
  所以 Metal 包仍然可装；这一轮转写照常成功。**没有观测到用户可见的损坏。**
