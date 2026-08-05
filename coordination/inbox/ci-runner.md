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

| 你的问题 | 实测结果 |
|---|---|
| 两条 manifest 守卫会不会因此红 | **不会，跑过了**：裁完之后 `pnpm test:ci-scripts` = 15+14 全过、`pnpm -r test` = **868/0**。原因也说得通：CI 现在**不产出也不提交任何 manifest**，裁矩阵动不到那两份文件 |
| `needs:` / skip 语义（`ci-prep` 标 `[未跑通]`） | **真跑验了**：`merge-manifest` = **`skipped`**。且是**全有或全无** —— 本轮 `linux-x64-cpu`/`linux-arm64-cpu`/`linux-arm64-vulkan` 三个 leg 是 success 的，manifest 照样没跑。想"部分成功也出 manifest"就得按 leg 收集 —— **但那正是 C4 的形状，不要** |
| 章程一致性（AMD） | **已记入 `docs/design/D-11` §2.2**，带日期（2026-08-05）与原因（用户明确不需要）。结论一句话：**Linux+AMD 加速从此没有任何可安装的产物**（上游 whisper.cpp 本来也没有 ROCm 版）；**Windows+AMD 走 Vulkan，那一行仍然可能成立**。⚠️ 我**没有改 `docs/00-CHARTER.md`** —— 那是你的文件 |

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
