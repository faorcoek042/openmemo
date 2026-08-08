# inbox / ci-runner

## [2026-08-05 23:00] T-145 PROGRESS

交付:

- `docs/design/D-11-ci-platform-facts.md`（**主交付**，非 Linux 实测数据 + 章程偏离记录）
- 提交 `96d068a`（macOS/Windows/apt 实测修复）、`239ed94`（Node 22 测试发现 + 跨平台探针）、
  `0d4536b`（矩阵裁到 8 + D-11）—— **已 push**
- 新增 `.github/workflows/ci-crossplatform.yml`、`scripts/ci/platform-facts.mjs`
- 改 `.github/workflows/build-backends.yml`、`scripts/build-whisper.sh`、
  `scripts/check-test-scripts.mjs`、六个包的 `package.json`
- 诊断用的 `zz-*.yml` 两个探针**已删除并已从远端消失**（`actions/workflows` 现在只剩 3 个）

未做/未碰: 未改仓库可见性、未删仓库、未建 release、未改分支保护；未碰 `/root/data-memo`；
未写 `datadir.json`（`platform-facts.mjs` 只写 `os.tmpdir()`）；`:10000` 一次都没碰；
未跑 `pnpm -r build`；未用 `pkill -f`；未跑本地 whisper 转写。
每次推送前都 `git status` 对过清单，**三次提交全部用 `git commit -- <明确路径>` 形式**，
零 `git add -A`。第一次推送时 `ci-prep` 正在并发 `git add`，**它的暂存区被完整保住了**。

---

# TL;DR

1. **CI 真的跑起来了，`ci` 门禁是绿的（1m42s）。** 三个 workflow 全部注册、全部跑过真 job。

2. **① 的结论是二分法查出来的，不是推的 —— 而且我们（含我自己）先猜错了两次：**
   - ✘「四个 action 版本不存在」→ **假的**。`checkout@v6`/`setup-node@v6`/`upload-artifact@v6`/
     `download-artifact@v7` 四个 tag **全部存在**，逐个查到了 commit sha。它们只是不是最新。
   - ✘「等了 2 分钟以上，所以不是索引延迟」→ **方向错了**。
   - ✔ **真因：首次推送（创建默认分支那一次）没有被 Actions 索引器处理。**
     **任何一次后续 push 都会全量重新索引**。
     决定性证据：**把旧 `build-backends.yml` 逐字节复制成另一个文件名推上去，它当场注册了。**
   - → **实践含义**：空仓库首推之后要再推一次，否则 workflow 可能永远不注册，
     **而且不会产生任何失败记录去提醒你**。这就是"从来没跑过"能维持 138 个提交的机制。

3. **CI 抓到的第一个真 bug 是 Node 版本，不是平台**：本机 node **24.18.0** 全绿，
   CI 按 ADR-006 钉的 **Node 22.23.1** 当场红。**成因请以这条为准（Manager 的推测有一半不对）**：
   不是 `./errors.js → ./errors.ts` 的改写差异 —— 我实测过，Node 24 直接跑那个 `.ts`
   **一样** `ERR_MODULE_NOT_FOUND`。差别**纯粹在 `node --test` 的默认发现范围**：
   **Node 22 会把 `src/**/*.test.ts` 捞进来，Node 24 不会。**
   → 六个包改成加引号的 `node --test "dist/**/*.test.js"`，并把它变成机械守卫（反向验证过）。
   ⚠️ 差点踩的坑：`node --test dist` **实测在 Node 24 上被当成一个文件，输出
   `tests 1 / pass 1` 然后绿灯** —— 正是本仓最贵的那类假绿。

4. **`merge-manifest` 在第一轮的结论是 `skipped`** —— 不是"写出 `packs: []` 然后绿灯"。
   **C4 的修复在真跑里被证实了。** 并且顺带答了 `ci-prep` 标为 `[未跑通]` 的 `needs:`/skip
   语义：**全有或全无** —— 本轮 linux 有三个 leg 是 success 的，manifest 照样没跑。

5. **矩阵已按用户指令裁到 8 个**（见下 §矩阵），**章程偏离（AMD 没有产物）已写进
   `docs/design/D-11` §2.2**，带日期带原因。

6. **本机门禁**：`tsc -b` 0 · `eslint` 0 · `test:ci-scripts` 15+14 全过 ·
   `pnpm -r test` **868 passed / 0 failed**（868 = `ci-prep` 的 867+1 基线，我没有新增测试文件）。

---

# ★★ CI 告诉我们的、本地永远发现不了的事

> 判据：这一节每一条都**必须**是"这台 Linux x64 开发机在结构上不可能观测到"的。
> 每条都附真实日志片段。

## ① macOS 的 `/bin/bash` 是 **3.2**，空数组 + `set -u` 直接炸

```
==> host=darwin/arm64 backend=cpu jobs=3
scripts/build-whisper.sh: line 229: BACKEND_FLAGS[@]: unbound variable
```

探针独立复现：`8.set -u + empty array expansion` → darwin `exit=127 bash: A[@]: unbound variable`，
linux(5.2.21) 与 windows Git Bash(5.3.15) 都 `exit=0`。

Apple 因 GPLv3 把 `/bin/bash` 停在 2007 年那版；bash **4.4** 才把"空数组展开不算 unbound"修掉。
`BACKEND_FLAGS` 恰好只在 `backend=cpu` 时是空的 —— **这个 bug 只在 macOS + cpu 上存在**，
同一行在 ubuntu 上跑了几十次全绿。**本机没有 bash 3.2，装一个也不会有人想到去装。**

## ② `pnpm -r test` 的红绿取决于 **node 小版本**，而本机只有一个 node

```
ERR_MODULE_NOT_FOUND: Cannot find module
  /home/runner/work/openmemo/openmemo/packages/llm/src/errors.js
  imported from .../packages/llm/src/structured.test.ts
```

本机 v24.18.0 → 18 tests / 0 fail；CI v22.23.1 → 20 tests / **2 fail**。
`pnpm -r test` 在 llm 处 bail，**后面几个包一条都没跑**，所以第一轮只看得到一个包。

**本地永远发现不了的原因很具体**：ADR-006 决策 7 把基线钉在 Node 22，
而这台机器上装的是 Node 24。**"声明支持的版本"和"实际跑的版本"从来没有在同一台机器上对过。**

## ③ Windows 上 `{mode: 0o600}` 写下去，读回来是 **`666`**

```
3.write(mode 0o600)->mode      666
2.chmod(0o755)->mode           666
2.access(X_OK)                 true      X_OK 通过
```

T-141 #23 原本标着 `[推测]`。现在是实测：
**`runtime.json`（内含 auth token）、`datadir.json`、`tls-key.pem` 在 Windows 上对本机所有用户可读**，
而且没有 ACL 回退。
同一组数据也**证实了 `installer.ts:283-284` 的注释是对的**：Windows 上 `access(X_OK)`
根本不看 x 位，所以跳过 chmod 是正确处置。

## ④ macOS 与 Windows 的**默认**文件系统就是大小写不敏感的

```
1.fs.case-insensitive    linux=false    darwin=true    win32=true
```

T-141 §3 #7 之前是用 `mkfs.vfat` + loop mount **模拟**出来的。现在是真机：
**触发条件不需要用户做任何特殊操作**，`assetPaths.ts:49` 的大小写敏感前缀比较
在这两个平台上是默认路径而不是边缘情形。

## ⑤ Windows 上 `join(...).split('/')` 长度是 **1**

```
6.join('dd','tmp','job','a.wav').split("/").length    linux=4   darwin=4   win32=1
6.isAbsolute("/media/x.wav")                          三个平台全是 true
6.resolve("C:\d\m\r.wav")   linux=<cwd>/C:\d\m\r.wav   win32=C:\d\m\r.wav
```

→ T-141 #26（`migrateAssets.ts:93` 资产迁移在 Windows 上静默失效）与 #8 **双双证实**。

## ⑥ `pnpm check:sources` 在 Windows 上是坏的 —— **而 macOS 上是好的**

```
win32:  ✘ 没找到任何源码目录，检查脚本本身可能有问题     ← 步骤 failure
darwin: ✔ （绿）
7.find   linux=GNU 4.9.0   darwin=`find: illegal option -- -`   win32=`FIND: Parameter format not correct`
```

T-141 #30 预测"只有 Windows 会断"—— **完全正确，连范围都对**
（BSD find 认 `-type d`，只是不认 `--version`）。

## ⑦ Windows 三个后端**全部能编出来**，包括上游根本不提供的 Vulkan

```
whisper-cli.vcxproj    -> D:\a\...\.build\whisper-win32-x64-cpu\bin\Release\whisper-cli.exe
whisper-server.vcxproj -> D:\a\...\bin\Release\whisper-server.exe
```

`cpu` / `vulkan` / `cuda` 三个 job 全部编译 100% 成功，只死在打包那一步。
→ **章程 §3 第 4 行「Windows + AMD」仍有希望**（上游没有 Windows Vulkan whisper，我们能自己编）。
→ 并且 `bin\Release\` 证实了 `platform` C7 对 MSVC 多配置布局的预测，
`ci-prep` 的三候选探测第一次真跑就用上了。

## ⑧ Windows 的 zip **exit 0，文件却写到了没人看的地方**

```
==> stripping symbols
emit-pack-manifest: archive not found: dist/packs/whispercpp-cpu-win-x64.zip
```

`--out dist/packs` 是相对路径，zip 那条要先 `cd` 到 stage 的父目录 →
归档落在 `.build/…/stage/dist/packs/`。**tar 那条没这毛病纯属运气**：
`tar -C` 是在**打开归档之后**才切目录的。
→ 三个 Windows job 全部因此失败，**而这条在 Linux 上永远不会发生（Linux 走 tar 分支）**。

## ⑨ ⚠️ 一条 CI **结构上验不了**的 —— 必须写下来，否则会被误当成"已验证"

```
4.symlink()    win32=ok（created）
7.openssl      win32=exit 0, OpenSSL 3.6.3
```

两条都**看起来**推翻了 T-141 #13 / #21。**它们不能这么用**：

> GitHub 的 Windows runner **以管理员身份运行**，天然持有 `SeCreateSymbolicLinkPrivilege`；
> 而且装了一大堆开发工具。**runner 不能代表普通用户的机器。**
>
> **判据：runner 上"能做到"不等于用户机器上"能做到"；只有 runner 上"做不到"才是硬结论。**

所以 `move.ts:470` 无 Windows 回退那条，**仍然是 `[未验证：需一台普通 Windows]`**。

---

# 矩阵（裁完的最终形态，请对）

## `build-backends.yml`：12 → **8 个构建 leg**（+ 1 个 manifest job，共 9）

```
保留  macos-26     / arm64 / metal
保留  macos-26     / arm64 / cpu
保留  ubuntu-22.04 / x64   / cpu      ← 刻意留 22.04：glibc 基线
保留  ubuntu-24.04 / x64   / vulkan   ← 本次从 22.04 改过来（jammy 没有 glslc）
保留  ubuntu-24.04 / x64   / cuda     ← 同上
保留  windows-2025 / x64   / cpu
保留  windows-2025 / x64   / vulkan
保留  windows-2022 / x64   / cuda
✂ 删  ubuntu-24.04     / x64   / rocm
✂ 删  ubuntu-24.04-arm / arm64 / cpu
✂ 删  ubuntu-24.04-arm / arm64 / vulkan
✂ 删  macos-15-intel   / x64   / cpu
```

（YAML 实测计数：`build-backends` 8+1，`ci-crossplatform` 3，`ci` 1。四行删除的内容原样留在注释里。）

## `ci-crossplatform.yml`：4 → **3**

`ubuntu-24.04`（对照组）/ `macos-26` / `windows-2025`。
删 `macos-15-intel`：第一轮跑过一次，**结论与 darwin-arm64 逐条一致**，没有 Intel Mac 独有的事实。

## 你点名的三处连带影响，逐条实测

| 你的问题                                        | 实测结果                                                                                                                                                                                                                                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 两条 manifest 守卫会不会因此红                  | **不会，跑过了**：裁完之后 `pnpm test:ci-scripts` = 15+14 全过、`pnpm -r test` = **868/0**。原因也说得通：CI 现在**不产出也不提交任何 manifest**，裁矩阵动不到那两份文件                                                                                                             |
| `needs:` / skip 语义（`ci-prep` 标 `[未跑通]`） | **真跑验了**：`merge-manifest` = **`skipped`**。且是**全有或全无** —— 本轮 `linux-x64-cpu`/`linux-arm64-cpu`/`linux-arm64-vulkan` 三个 leg 是 success 的，manifest 照样没跑。想"部分成功也出 manifest"就得按 leg 收集 —— **但那正是 C4 的形状，不要**                                |
| 章程一致性（AMD）                               | **已记入 `docs/design/D-11` §2.2**，带日期（2026-08-05）与原因（用户明确不需要）。结论一句话：**Linux+AMD 加速从此没有任何可安装的产物**（上游 whisper.cpp 本来也没有 ROCm 版）；**Windows+AMD 走 Vulkan，那一行仍然可能成立**。⚠️ 我**没有改 `docs/00-CHARTER.md`** —— 那是你的文件 |

---

# 我撤回的一处改动（诚实条目）

我一度按 linux job 的 apt 报错，把 **windows** job 的 CUDA `sub-packages` 也从
`cublas`/`cublas_dev` 改成 `libcublas*`。**然后发现没有证据支持**：
`windows-x64-cuda` 的「Install CUDA toolkit」**本来就是成功的**，它只死在后面的 zip。
两边走的是完全不同的安装器（apt vs NVIDIA 网络安装器），名字映射不同，**不能互相推**。
→ 已改回原样，理由写进 YAML。**没坏就别按另一个平台的错误去"修"。**

---

# 仍然未定性 / 未修的

1. **macOS metal 包为空**（`macos-arm64-metal`）：编译 100% 成功
   （`[100%] Built target whisper-server`）、ad-hoc 签名跑了，然后
   `emit-pack-manifest: stage dir is empty`。**没修好**，只加了诊断
   （空包时打印 `BIN_DIR` 真实内容与 `*ggml*` 实际位置，不改红绿）。
   ⚠️ 注意 workflow 自己的注释就写着「Metal 的 pack 其实装在核心包里」，
   **矩阵却仍单独构建一个 metal 包** —— 这个矛盾第一次真跑就撞上了。
   👍 顺带一提：**`ci-prep` 的 C5 修复在第一轮就救了场** ——
   旧版那个"零文件也绿灯"的检查会让这个 0 字节包直接过。

2. **跨平台 `pnpm -r test` 红 6 条**（详见 `D-11` §3.3）。判断：**至少 4 条是测试自身
   写死了宿主假设**，不是产品 bug —— 但后果是同一件事：**那些用例在 macOS/Windows 上
   等于不存在**。建议派给 `test-gaps`：
   - darwin：`argGuard.test.ts:313` 用 `mkdtemp(tmpdir())` 造根，而 **macOS 的 `/var`
     是指向 `/private/var` 的软链** → `assertWithinRoot` realpath 候选、却拿没
     realpath 的 root 去比 → 判越界。⚠️ 它顺带暴露一条**产品事实**：
     **任何经过软链的 managed root 在 macOS 上会被整体拒绝**，而 macOS 默认 TMPDIR 就在软链后面。
   - win32：`assetPaths.test.js` 3 条期望 `/d/media/a.wav`，实得 `D:\d\media\a.wav`（测试写死 POSIX）。
   - win32：`selfcheck.test.js` 2 条 `'fail' !== 'ok'`。**未定性**，`[推测]` 是假二进制没带 `.exe`。

3. **ROCm 换 noble 之后是否还有冲突** —— 已被裁掉，可能永远不会验证。标 `[未验证]`。

4. **`ci.yml` 目前只有 `workflow_dispatch`** —— 一个"手动才跑的 CI"等于没有 CI。
   放开 `push`/`pull_request` 三行的时机是用户的决定（`ci.yml` 文件头已写明）。

---

需要 Manager 决策:

1. **`ci.yml` 的 `push`/`pull_request` 三行什么时候放开？** 现在它绿了、跑一次 1m42s。
   在放开之前，"CI 接上了"这件事只在有人手动点的时候成立。
2. **跨平台的 6 条测试红派给谁？** 我判断是 `test-gaps` 的活（是测试的宿主假设，
   不是产品 bug），但其中「macOS 上经软链的 managed root 被整体拒绝」那条是产品性质，
   可能要 `path-guard`。
3. **macOS metal 单独成包这件事本身要不要保留？** workflow 注释说它装在核心包里，
   矩阵却单独建 —— 这是设计问题不是 CI 问题。

下一步建议:

1. 等第二轮（run 31017917421 / 31017923588）跑完，按真实日志继续迭代 —— 尤其是 metal 空包那条。
2. `ci.yml` 放开自动触发。
3. Windows 上 `0o600` → `666` 那条（token 对本机所有用户可读）现在**有实测证据**了，值得单独派人。

---

## [2026-08-05 23:15] T-145 PROGRESS（第二轮结果 + 第三轮已排队）

### 第二轮（run 31017917421）：`4 success / 3 failure / 1 进行中`

| job                    | 第一轮      | 第二轮          | 说明                                                                          |
| ---------------------- | ----------- | --------------- | ----------------------------------------------------------------------------- |
| linux-x64-cpu          | ✅          | ✅              | —                                                                             |
| **linux-x64-vulkan**   | ❌ glslc    | **✅**          | 换 ubuntu-24.04 **生效**                                                      |
| **macos-arm64-cpu**    | ❌ bash 3.2 | **✅**          | bash 3.2 修复**生效** ⚠️ **但包是坏的**，见下                                 |
| **windows-x64-vulkan** | ❌ zip      | **✅**          | zip 修复**生效**。`whispercpp-vulkan-win-x64.zip (21M)`，含 `ggml-vulkan.dll` |
| windows-x64-cpu        | ❌ zip      | ❌ **新的一层** | 包**打出来了**（17 files / 3.8M），死在下一步 probe 冒烟测试                  |
| macos-arm64-metal      | ❌ 空包     | ❌ **已定性**   | 见下                                                                          |
| linux-x64-cuda         | ❌ 包名     | ❌ **我改错了** | 见下                                                                          |
| windows-x64-cuda       | ❌ zip      | 进行中          | —                                                                             |

### ★★ 第二轮最重要的发现：**macos-arm64-cpu 是绿的，包却是坏的**

`-DGGML_BACKEND_DL=ON` 让后端变成运行时加载的 **MODULE**，而 CMake 对
`add_library(... MODULE)` 在 **Apple 平台上用 `.so` 后缀，不是 `.dylib`**。
真机日志逐行印证（这四行是同一个 job 里的连续输出）：

```
[ 21%] Linking CXX shared library ../../bin/libggml-base.dylib   ← SHARED → dylib
[ 33%] Linking CXX shared module  ../../../bin/libggml-blas.so   ← MODULE → .so
[ 46%] Linking CXX shared module  ../../../bin/libggml-metal.so  ← MODULE → .so
[ 60%] Linking CXX shared module  ../../bin/libggml-cpu.so       ← MODULE → .so
```

脚本按 `SO_EXT=dylib` 去找，分裂成两种后果 —— **危险的是绿的那种**：

- **metal**：一个都没匹配 → 暂存空 → **红**（被 `ci-prep` 的 C5 族守卫接住）
- **cpu**：`libggml-cpu.so` 没匹配上，**但别的 dylib 匹配上了** → 暂存非空 →
  打出 1.4 MB 的 tar.gz → **job success**。实测内容只有 8 个文件、
  **没有任何 ggml 后端模块**：
  ```
  ==> pack: .../whispercpp-cpu-macos-arm64.tar.gz (1.4M)
  ==> contents:
    libggml-base.0.15.1.dylib   libggml.0.15.1.dylib
    libwhisper.1.9.1.dylib      libparakeet.1.9.1.dylib     whisper-cli
  ```
  对照同一轮 Windows 的包：**17 个文件 3.8 MB，含 10 个 `ggml-cpu-*.dll`**。

> **BACKEND_DL 模式下没有后端模块 = `whisper-cli` 一个后端都注册不到 = 不能推理。**
> 也就是说，这条流水线在第二轮**打出了一个绿灯的、能下载的、装上去用不了的 macOS 包**。
> 这正是本项目最贵的那类 bug，而且**只有真 macOS runner 才看得见**
> —— 它在 Linux 上不可能发生（Linux 的 SHARED 与 MODULE 都是 `.so`）。

已修（`de98f34`）：模块后缀与共享库后缀分开（`MOD_EXT`），
**并加了守卫**：核心包里没有 `ggml-cpu*` 模块就 `die` 并打印 `BIN_DIR` 实际内容。
判据不是"记得把后缀写对"，是"写错了会当场红"。

### 其余两条

- **windows-x64-cpu**：zip 修好了，**本仓第一个 Windows whisper 包成功产出**
  （`whispercpp-cpu-win-x64.zip 3.8M`），随后死在**新的一层**：

  ```
  ==> built: dist/probe/openmemo-probe.exe (60K)
  ==> smoke test:
  error: probe did not produce output
  ```

  成因正是 `platform` T-141 §3 **第 18 条**点过名的那条（当时 `[读码]`，现在实测）：
  冒烟测试只设 `LD_LIBRARY_PATH`/`DYLD_LIBRARY_PATH`，**在 Windows 上这两个变量都是死的**。
  → 已修：三个变量一起设，失败时打印库目录内容。

- **linux-x64-cuda：我连着改错两次，这是第三次改，标 `[未验证]`**
  ```
  第一轮 sub-packages "cublas"    → E: Unable to locate package cuda-cublas-12-4
  第二轮 sub-packages "libcublas" → E: Unable to locate package cuda-libcublas-12-4
  ```
  该 action 把 `sub-packages` 每一项都拼成 `cuda-<项>-<major>-<minor>`，
  所以改名字没用 —— cuBLAS 得走 `non-cuda-sub-packages`。
  第二轮还顺带证明**CUDA 必须留在 22.04**：
  `Package 'cuda-nvcc-12-4' has no installation candidate`（在 noble 上）——
  NVIDIA 的 `ubuntu2404` 仓库里没有 12.4 这一代。已改回 `ubuntu-22.04`。

### 第三轮

`run 31019163756`，状态 **pending**（排在第二轮的 `windows-x64-cuda` 后面，
`concurrency.cancel-in-progress: false`）。**我没有等到它出结果**，
上面所有"已修"都要以第三轮日志为准。

### 新增的一条给 Manager

**`ci-crossplatform` 第二轮与第一轮完全一致**（linux 绿，darwin/win 红），
因为我没有动那 6 条测试 —— 它们的定性见 `D-11` §3.3，建议派 `test-gaps`。

---

## [2026-08-05 23:50] T-145 PROGRESS（第三轮：**3/12 → 5/8 绿**）

### 第三轮（run 31019163756）

| job                | 第一轮      | 第二轮              | 第三轮                          |
| ------------------ | ----------- | ------------------- | ------------------------------- |
| linux-x64-cpu      | ✅          | ✅                  | ✅                              |
| linux-x64-vulkan   | ❌ glslc    | ✅                  | ✅                              |
| linux-x64-cuda     | ❌ 包名     | ❌ 包名             | **过了 apt，正在编译**          |
| macos-arm64-cpu    | ❌ bash 3.2 | ⚠️ **绿但包是坏的** | ✅ **包是真的了**               |
| macos-arm64-metal  | ❌ 空包     | ❌ 空包             | ❌ **包有了，卡在签名验证模式** |
| windows-x64-cpu    | ❌ zip      | ❌ probe            | ✅                              |
| windows-x64-vulkan | ❌ zip      | ✅                  | ✅                              |
| windows-x64-cuda   | ❌ zip      | （被我取消）        | 编译中                          |

**已确认 5 绿 / 1 红（已修待验）/ 2 编译中。** 第一轮是 3 绿 / 8 红 / 1 skip（共 12）。

### macos-arm64-cpu：从「绿灯的坏包」变成真包

```
第二轮   8 staged files / 1.4M / 没有任何 ggml 后端模块
第三轮  10 staged files / 1.8M：
   libggml-cpu.so                811952   ← 之前整个缺失
   libggml-blas.so                72800   ← 之前整个缺失
   whisper-server / whisper-bench / whisper-vad-speech-segments   ← 之前也都缺
   libggml-base / libggml / libwhisper / libparakeet / whisper-cli
```

probe 冒烟测试也真的吐 JSON 了（`"schemaVersion": 1`）。

### macos-arm64-metal：**第一次产出了非空的 metal 包**，然后被守卫拦下 —— 拦得对

```
emit-pack-manifest: wrote …/whispercpp-metal-macos-arm64.json (1 staged files)
==> pack: …/whispercpp-metal-macos-arm64.tar.gz (160K)
  libggml-metal.so   828512
…
verified 0 signed file(s)
::error::checked 0 files under … — the pack is empty or the name patterns drifted
```

签名验证的模式是 `*.dylib|*whisper-cli|*whisper-server|*openmemo-probe`，
而这个包里**只有一个 `libggml-metal.so`** —— 同一个 `.so` 根因的第三处显形。

> 👍 **`ci-prep` 的 C5 守卫在这里第二次证明了自己**：它没有静默放过，
> 而是明确说"我一个都没检查到"。**要改的是模式，不是守卫。**
> （`build-whisper.sh` 的签名那步用 `-name '*.dylib' -o -perm -u+x`，
> `.so` 带可执行位，所以它们**本来就被签了**，只是没被验。）

已修（`ff99099`）：模式补上 `*.so` 与两个新二进制。**待第四轮验证。**

### windows-x64-cpu：probe 的 PATH 修复生效

```
==> pack: D:/a/.../whispercpp-cpu-win-x64.zip (3.8M)
==> built: dist/probe/openmemo-probe.exe (60K)
==> smoke test:
  "schemaVersion": 1,
==> probe OK
```

### 一条流程说明

第二轮的 `windows-x64-cuda` 跑了 32 分钟仍未结束，把第三轮**堵在队列里**
（`concurrency.cancel-in-progress: false`）。我 `gh run cancel` 了**第二轮** ——
第三轮跑的是同一份代码的超集，取消不丢信息。**没有取消过任何别人发起的 run。**

### 交接状态（我停在这里）

- **待验证**：第四轮（metal 签名模式 `*.so`）—— 我**没有**发起第四轮，
  因为第三轮的两个 CUDA job 还在编译，发了也是排队。
  **发起方式**：`gh workflow run build-backends.yml --ref master`。
- **两个 CUDA job 的结果我没等到**，标 `[未验证]`。
  linux-x64-cuda 已经**过了 apt 那一关**（前两轮都死在那里），这一条算部分验证。

---

## [2026-08-06 00:55] T-145 PROGRESS（自动触发 + 冷启动依赖审计 + 产品 bug）

交付: `docs/design/D-11-ci-platform-facts.md` **新增 §6**（冷启动依赖来源审计）、
提交 `3628df2` `5f89833` `2d7774e` `1d2da8c` —— 均已 push。

# TL;DR

## ① 用户问的「是不是都是现场下载的」——**是，但有两条例外，都在 npm 那条通道上**

**全部证据来自干净 runner 的 CI 日志**（`cold-start-audit` run 31026300122）。

|                      | 结论                                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| manifest 那条通道    | **62 个下载文件，sha256 100%，钉死引用 100%，URL 62/62 可达（HTTP 206）**，8 MB 以下的**逐个重算 sha256 全部 MATCH** |
| 冷启动后工具从哪来   | **✅ 产品自己下的 5 个 / ⚠️ 借宿主 PATH 的 0 个 / ❌ 装不上 0 个**                                                   |
| 你点名要验的中文检索 | **`ext.chineseSearch = ok`（required）：用户:1 推特:2 中国:1 服务:2** —— T-093 那次事故**没有复现**                  |
| 仓库里有二进制吗     | **没有**。最大的已跟踪文件 255 KB（JSON/PNG/文档）。你查的 0.2 MB 是对的                                             |
| ⚠️ **例外 1**        | `ffmpeg-static` 在 `pnpm install` 期下 **79,826,272 B** 的 ffmpeg，钉了 tag `b6.1.1` 但**无校验和**                  |
| ⚠️ **例外 2**        | `youtube-dl-exec` 打的是 `api.github.com/repos/yt-dlp/yt-dlp/releases/**latest**` —— **不钉版本、无校验和**          |

**例外 2 值得单独看**：同一个 yt-dlp，**两条通道一严一松** ——
`backends.json` 里那条钉死 `2026.07.04` + 带 sha256（39.9 MB 自包含二进制），
npm 那条不钉版本、不校验（3.07 MB 纯 Python zipapp，运行时还要机器上有 Python）。
**它们不是同一个东西。**

## ② 冷启动基线**精确复现了 T-093 的事故形态**，然后被修复路径解掉

```
[cold] tokenizer=trigram  libsimple=false  sqliteVec=false
     failures.libsimple: 文件不存在：<data>/bin/ext/libsimple.so
装 5 个包 → /api/backends/installed 独立核对全部在列 → 重启
[warm] tokenizer=simple   libsimple=true   sqliteVec=true
ext.chineseSearch ok  用户:1 推特:2 中国:1 服务:2
```

## ③ 一条把我自己的假设证伪的事实：**ubuntu runner 并不自带 ffmpeg**

我在脚本和 workflow 注释里都断言过它自带。宿主基线实测：
`ffmpeg/ffprobe/yt-dlp/whisper-cli` **全都不在 PATH 上**，自带的只有 `sqlite3/python3/cmake`。
→ 已在两处更正。**屏蔽那一步照留**：结论不能建立在"这款镜像今天恰好没装"上。
（不过第二轮的 daemon 日志顺带证明**回退路径确实存在**：屏蔽时它报「缺少工具: asr-model」，
即 ffmpeg/ffprobe/whisper-cli 都"找到了"—— 找到的正是我放的 shim。）

## ④ ★ 审计工具**自己犯了两次本任务在查的那个错**（必须写下来）

1. `dependency-audit.mjs` 把 `onlyBuiltDependencies` 解析成空，**面不改色打印「(空)」**。
   我差点把"pnpm install 期不下载任何二进制"当结论报上去。真实答案是 4 个包。
2. `cold-start-audit.mjs` 第一版**自己就是假绿**：打了个不认 `?id=` 的端点，
   然后 `arr.find(...) ?? arr[0]` —— 输出 `media-tools-linux-x64 succeeded (1.0s)`，
   **119 MB，1.0 秒**，而 1.0s 恰好是轮询间隔。
   → 改单条端点 + 找不到就说找不到 + **最后用 `/api/backends/installed` 做独立地面真相核对**。
   第二版字段名还写错了（是 `uid` 不是 `id`），但它**红得诚实**。
   **同一个地方、两种失败方式，差别就是有没有那个 `?? arr[0]`。**

## ⑤ ci.yml 已改自动触发，**并且已被真实 push 触发验证过**

`on: push(branches:[master]) + pull_request + workflow_dispatch`。
实测：`event=push` 的 run 连续三次 success（1m3s / 1m1s / 58s）。
`build-backends` 保持手动。`concurrency + cancel-in-progress: true` 本来就有。

**刻意不加 `paths` 过滤**，三条理由（写进了 ci.yml 文件头）：
① 只要 1m42s，省不下什么；
② 被 `paths` 过滤掉的检查在分支保护里显示为「未运行」而不是「通过」，
docs-only 的 PR 会永远卡在 `Expected — waiting for status`；
③ ★ **它和本仓在清的假绿家族是同一个形状**：「没跑」和「跑了并通过」长得一模一样。

★ `lint-workflows.mjs` 里那条「ci.yml 不许自动 push 触发」**在我改的当天就红了，而且红得对** ——
它拦住的不是错误，是一个**已经过期的前提**。我把它**翻成正向断言**（没有自动触发才是违规），
并补了「branches 必须限定 master」「不许出现 paths 过滤」两条。**守卫该改，不是该删。**

## ⑥ 那条产品相关的跨平台 bug 已修（比我上次说的更精确）

`assertWithinRoot`：**托管根在软链后面时，任何「即将创建」的文件被判为越界。**
上次我说的是"整体拒绝"，**不准确** —— 实测是**半好的**：

```
exists.wav     ok            ← 已存在的文件正常
newfile.wav    path_escape   ← ★ 错：即将创建的
sub/new.wav    path_escape   ← ★ 错
../escape      path_escape   ← 对
/etc/hostname  path_escape   ← 对
```

**读得了、写不了**，现场看起来像权限问题。
机制：`realpathOrResolve` 对不存在的路径回退到词法路径（这是对的），
于是 root realpath 过、target 没有，两边不在同一个坐标系。
macOS 上 `/var` 和 `/tmp` **本身就是软链**，默认 TMPDIR 就触发。
→ 候选相对**已 realpath 的 root** 展开。三条逃逸路径逐条反向验证仍然拦得住。
→ 新增 6 条用例（3 正 3 反），用自造软链根，**在 Linux 上也能红** —— 本来就该在本机抓到。

## ⑦ build-backends 第 4 轮：**8/8 全绿在望**

`macos-arm64-metal` 的 `*.so` 签名模式修复**生效**，已 success。
截至写这行：**7 success + windows-x64-cuda 仍在编译**（该 job 单独要 30+ 分钟）。
第 1 轮是 3 绿 / 8 红 / 1 skip（共 12）。

---

需要 Manager 决策:

1. **npm 那两条通道要不要收口？** 建议 `YOUTUBE_DL_SKIP_DOWNLOAD=1` +
   运行期只认 manifest 装出来的 yt-dlp（那条是钉死且带 sha256 的）。
   `ffmpeg-static` 同理。**我没有动**，因为它会改变 `pnpm install` 的行为，超出 T-145 范围。
2. **`model.asr` 在冷启动后是 `fail(required)`** —— 冷启动不会自动装 ASR 模型。
   这既是产品事实、也是我审计的覆盖缺口（我只调了 `/api/backends/install`，
   **没调 `/api/models/pull`**）。要不要把模型下载也纳入冷启动审计？
3. 跨平台那 6 条测试红里，**产品相关的那条已修**；其余 5 条是测试的宿主假设，
   定性见 D-11 §3.3，建议派 `test-gaps`。

下一步建议:

1. 等 windows-x64-cuda 收尾，确认 build-backends 8/8。
2. `cold-start-audit` 加 `/api/models/pull`，把 paraformer + VAD 也纳入，
   然后 `model.asr` 才有资格从 fail 变 ok。
3. 把 `cold-start-audit` 铺到 macOS / Windows —— 本节结论目前只覆盖 ubuntu-24.04。

---

## [2026-08-06 01:40] T-145 PROGRESS（两条决策都已执行）

交付: `docs/design/D-11-ci-platform-facts.md` **新增 §7**、提交 `f313dca` `065d841`（已 push）

# TL;DR

## ★★ 最重要的一条：**§6 的「借宿主 PATH = 0」只在 Linux 上成立**

同一份脚本、同样屏蔽宿主工具，在 `macos-26` 上：

```
tool.ffmpeg      warn   .../maskbin/ffmpeg（来自系统 PATH，非本产品安装）
tool.ffprobe     warn   .../maskbin/ffprobe（来自系统 PATH，非本产品安装）
tool.whisperCli  warn   .../maskbin/whisper-cli（来自系统 PATH，非本产品安装）
tool.ytDlp       ok     .../data/models/by-name/backend/yt-dlp
```

**三个工具解析到了我放的假二进制** —— 产品在 macOS 上**确实会回退到宿主 PATH**。
成因就在上一行：**19 个包里只有 3 个适用于 macOS，没有 ffmpeg、没有 whisper-cli。**

**这正是用户那句「我怕了你」问的东西的准确形态**：
一台真实的 Mac 上大概率装着 Homebrew 的 ffmpeg → 产品**安静地用上它** →
selfcheck 给的是 `warn` 不是 `fail` → 一片绿里没人会细看 →
用户换一台没装的 Mac，同一个版本突然不能用，**而没有任何东西变过**。

**这条只有屏蔽之后才看得见**，而且它在 Linux 上根本不存在。
—— 三平台这件事本身就已经付清了成本。

⚠️ 诚实边界：runner 上是「借到了我的 shim」，我们观测到的是**「产品会去 PATH 找」这个行为**；
至于用户机器上那个 Homebrew ffmpeg 能不能真的跑完转写，**没验过**。

## 三分类（按平台）

|                 | linux-x64 | darwin-arm64                       |
| --------------- | --------- | ---------------------------------- |
| ✅ 产品自己下的 | **5**     | **1**（只有 ytDlp）                |
| ⚠️ 借宿主 PATH  | **0**     | **3**（ffmpeg/ffprobe/whisperCli） |
| ❌ 装不上       | **0**     | **1**（whisperVad）                |
| 适用后端包      | 5/19      | **3/19**                           |

中文检索**两个平台都成立**（macOS 找的是 `libsimple.dylib`/`vec0.dylib`，
与 Linux 的 `.so` 不同，这条路径第一次被真机走过）。

## ① npm 那条通道：**删掉了，不是加锁**

先查"还用不用得上"，**实测三查全空**：无 import / 无路径引用 / 测试里零出现。
删除后 `require.resolve` 双双 MODULE_NOT_FOUND、`pnpm install` 少 **52 个包**、
`pnpm -r test` **874/0 不变**、冷启动仍然 5/5（Linux）。
CI 三平台反向断言：`✔ ffmpeg-static 不存在 / ✔ youtube-dl-exec 不存在`。

`ffmpeg-static` 的结论回答你的问题：**没人用，纯历史遗留** —— 所以删掉，不是加 integrity。

★ 并把 `license-report.mjs` 里那条**靠人记得**的纪律换成了守卫
（原注释：「每新增一个"会下载二进制"的依赖，都必须在这里补一行」）。
现在 `onlyBuiltDependencies` 里没被覆盖的包 → **exit 1**（反向验证过）。
许可证义务没丢：`backends.json` 里 yt-dlp/ffmpeg 全是 `GPL-3.0-or-later`。

★ 顺带更正 `ci.yml` 一条**具体但虚假**的注释（「测试会用到那两个二进制」——假的）。
**一条描述得很具体的错注释比没有注释更能误导人**：它会让下一个想删依赖的人以为动不得。

## ② 补上 `/api/models/pull` —— 那个含糊的红变成两条具名结论

```
拉模型：vad/silero-vad-onnx succeeded (1.0s) / vad/silero-vad-ggml succeeded (2.0s)
        独立核对 /api/models/installed 返回 2 条
model.vad  ok
model.asr  fail required  无可用 ASR 模型（by-name/asr 下只有非 ASR 角色的文件：
                          ggml-silero-v6.2.0.bin, silero_vad.onnx）
```

1. 🔴 **目录里 `required-core` 的 asr/vad 模型一共 2 个，全是 VAD，没有一个 ASR。**
   **照着 required-core 装完，仍然不能转写。** 这应该写进首启引导，
   而不是让 selfcheck 的一条 fail 去承担这个信息。
2. 🟡 **两个 VAD 模型被链到了 `by-name/asr/` 底下** —— role→目录 映射疑似有问题。`[未定性]`

两条都是**产品问题不是 CI 问题**，我没有修（超出 T-145 范围）。

⚠️ **一条自我更正**：我本机 smoke 时看到 `meta.sameSource fail（model.vad 本地=warn 端点=ok）`，
一度当成产品 bug。**CI 上是 ok（25 项逐 id 一致）** —— 本机那次是"两个 VAD 只装成一个"的
半装状态下的瞬时不一致。**本机的红没有资格当结论，这次它自己证明了这条规矩。**

## 我这一轮又犯的四个错（继续记账，全在 D-11 §7.5）

| #   | 错                                                                              | 教训                                                                                         |
| --- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 3   | `/api/models/catalog` 是分组结构，我按 `body.models` 取 → 拿到 0 个还照常往下走 | **同一形状第三次：工具安静返回空集，被读成"没有"**。现在空集当场出声                         |
| 4   | job 字段名是 `jobId`，我按 `uid` 比                                             | `jobs.ts:182` 注释写的是**数据库列名**，字段名在下一行。**准确但指向别处的注释同样能带偏人** |
| 5   | `/tmp/install.log` 写在没 `shell: bash` 的步骤里                                | Windows pwsh 解析成 `D:\tmp\...` 当场炸                                                      |
| 6   | 观测用的 `find -perm` 把整步拖红                                                | **一个用来看的步骤，不该有能力决定红绿**                                                     |

第 4 条修好后安装耗时立刻可信（14.1s/52.3s/28.1s），第一版全是 `1.0s` —— 正好是轮询间隔。

## Windows 冷启动：**仍未跑通**

第一轮死在我那两处 workflow 假设（第 5、6 条），已修并重新 dispatch，
**结果我没等到**。Windows 的冷启动结论目前是 `[未验证]`。

---

需要 Manager 决策:

1. **macOS 的 ffmpeg / whisper 缺口怎么办**（§7.1）。这是产品能力问题不是 CI 问题：
   要么补 manifest（`platform` T-141 §2.2 给过 `eugeneware/ffmpeg-static` 的 darwin 条目，
   host 已在允许名单里），要么在 macOS 上把"借到宿主 ffmpeg"从 `warn` 升成显式告知。
   **现状是最坏的一种：能用，但用的是别人机器上的东西，而且只给了个 warn。**
2. **`required-core` 里没有 ASR 模型** —— 首启引导要不要补一步"挑一个 ASR 模型"？
3. VAD 模型落在 `by-name/asr/` 下，role 映射要不要查？

下一步建议:

1. 等最新一轮 cold-start-audit 出 Windows 结果。
2. build-backends 第 4 轮只剩 windows-x64-cuda（其余 7 个已 success）。
3. macOS 那条 ffmpeg 缺口，建议单独派人（它决定章程 §3 第 1/2 行成不成立）。

---

## [2026-08-06 01:55] T-145 — Windows 冷启动结果（两条产品 bug）

Windows workflow 的两处假设修好后，`win32-x64` 第一次真的跑到了冷启动。**两条新发现：**

### 🔴 ① `scripts/selfcheck.mjs` 在 Windows 上**根本跑不起来**（已修 `cb85a74`）

```
selfcheck crashed: Error [ERR_UNSUPPORTED_ESM_URL_SCHEME]:
  On Windows, absolute paths must be valid file:// URLs. Received protocol 'd:'
```

`await import(`${REPO_ROOT}/packages/.../index.js`)` —— `D:\a\...` 的 `D:` 被当成 URL scheme。

★ **与 `platform` T-141 §3 第 1 条同一族**（`main.ts:1075` 手拼 `file://`）。
**同一个教训、同一个仓库、第二个文件。** 而 T-141 #1 那处**至今未修** ——
现在它有了一个被实测证明的兄弟。建议派人扫一遍这一族（全仓 `import(` + 手拼路径）。

后果：**在 Windows 上，「产品有没有装好」这个问题连问都问不出来** ——
而 selfcheck 恰恰是本项目用来对抗静默降级的那件工具。

### 🔴 ② Windows 上 libsimple 装了但没加载 —— **T-093 的形状在 Windows 复现**（未修）

```
装完 4 个适用包（job succeeded + /api/backends/installed 全部确认在列）→ 重启 →
  [warm] tokenizer=trigram   libsimple=false   sqliteVec=true
```

**`sqlite-vec` 加载成功，`libsimple` 没有** → 中文检索静默退回 trigram。
冷启动时它找的是 `...\data\bin\ext\libsimple.dll`。
**Linux 与 macOS 上同一条路径都是 `libsimple=true`。**

这正是你点名要我验的那一条（「要验到中文双字词真的搜得到，而不是文件下下来了」）：
**Linux ✅ / macOS ✅（扩展装上了）/ Windows ❌**。
产品问题，超出 T-145 范围，我没有修。

### 三平台冷启动最终对照

|                 | linux-x64               | darwin-arm64                       | win32-x64                    |
| --------------- | ----------------------- | ---------------------------------- | ---------------------------- |
| 适用后端包      | 5/19                    | **3/19**                           | 4/19                         |
| ✅ 产品自己下的 | 5                       | 1                                  | _selfcheck 崩溃，测不出_     |
| ⚠️ 借宿主 PATH  | 0                       | **3**（ffmpeg/ffprobe/whisperCli） | _同上_                       |
| 扩展（重启后）  | `simple` / vec ✅       | `simple` / vec ✅                  | **`trigram` / libsimple ❌** |
| 宿主自带        | sqlite3, python3, cmake | —                                  | python3 only                 |

（Windows 的三分类要等 selfcheck 修复后重跑才有 —— 那个修复已 push，**结果我没等到**。）
