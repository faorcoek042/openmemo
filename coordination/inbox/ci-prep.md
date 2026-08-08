# inbox / ci-prep

## [2026-08-05 22:15] T-144 DONE

交付:

- 提交 `07584d9`（摘 llama.cpp）、`bde374e`（修 CI 11 条）—— **均未 push**
- 新增 `.github/workflows/ci.yml`、`scripts/ci/{emit-pack-manifest,merge-backend-manifest,lint-workflows,selftest-ci-manifest}.mjs`、`scripts/ci/selftest-build-whisper.sh`
- 改 `.github/workflows/build-backends.yml`、`scripts/build-whisper.sh`、两份 manifest、`.gitmodules` 等

---

# TL;DR

1. **那 7 个包用户真的能看见、也真的能点。** `[实测]` 运行中的 `:10000`：
   `llamacpp-cpu-linux-x64 | applicable=true | recommended=true` ——
   它在 `/runtime` 的**主列表**里（不适用的才折叠），按钮**没有被禁用**，
   还被标成「推荐」。点下去会真的下载 16.4 MB 的 llama.cpp。
   **这就是「界面提供一个已被否决的功能」，与 `mindmap.emptyHint` 同族。**
   → 已整条摘除（submodule + 7 个包 + components 条目 + pin + 各 ignore 文件），
   `git submodule status` 干净（剩 4 个），`.git/modules/` 与 `.git/config` 均无残留。

2. **CI 的 11 条全部处理**，其中三条最狠的（C1 整份覆盖 manifest / C2 fragment
   与 schema 不兼容 / C4 全失败也绿灯）连同它们的**成因**一起改掉了：
   inline `node -e` 与 bash `printf` 搬成了**本地能跑的真脚本**。
   我判断 §4 里有 **1 条不该按盘点说的改**（C6，见下）。

3. **没有 act / actionlint / docker**（实测 `which` 全空），所以每个 job 的关键步骤
   抽成脚本真跑：`pnpm test:ci-scripts` = **258 + 15 + 14 条断言**。
   ⚠️ **它第一次跑就抓到了我自己写的两个错**（非法 job 键 `steps_note:`，会让
   GitHub 拒绝整份 workflow；以及一段新加的 inline `node -e`）——
   这正好是"只读 YAML 说修好了"会漏掉的那两类。

4. 🔴 **最要紧的一条状态**：`origin/master` 上现在挂着的**还是修之前那版
   `build-backends.yml`**（`if: always()` + `contents: write` 都在）。
   我的修复在本地 `bde374e`，**ahead 1，没推**。
   **今天按下那个按钮 = 11 条全部照原样发生。** 详见最后一节。

5. 基线：`tsc -b` 0 · `eslint` 0 · **868 passed / 0 failed**（867 + 我新增的 1 条守卫）。

---

# ① 那 7 个包到底能不能到用户手里 —— **能，链路上没有任何一环过滤 engine**

`[实测]` `curl :10000/api/backends/catalog`（只读 GET，未重启、未占端口）：

```
llamacpp-vulkan-win-x64      | applicable=false | kind=platform
llamacpp-cpu-win-x64         | applicable=false | kind=platform
llamacpp-cuda-13.3-win-x64   | applicable=false | kind=platform
llamacpp-vulkan-linux-x64    | applicable=false | kind=undetermined
llamacpp-cpu-linux-x64       | applicable=true  | kind=applicable | recommended=true   ← ★
llamacpp-rocm-linux-x64      | applicable=false | kind=undetermined
llamacpp-metal-macos-arm64   | applicable=false | kind=platform
```

`[读码]` 三段逐个核过，没有一处按 engine 过滤：

| 位置                                                              | 它做了什么                                                        |
| ----------------------------------------------------------------- | ----------------------------------------------------------------- |
| `apps/daemon/src/http/rest/backends.ts:242`                       | `state.backendCatalog.packs.map(...)` —— **整个目录原样映射出去** |
| `apps/web/src/features/runtime/RuntimePage.tsx:80-81`             | `applicable` 的进主列表，`!applicable` 的才折进 `<details>`       |
| `apps/web/src/features/runtime/components/BackendPackCard.tsx:82` | `disabled={installing \|\| !pack.applicable \|\| pendingCi}`      |

而 `pendingCi` 来自 `pack.availability === 'pending-ci'`，**这 7 个包一个都没有
`availability` 字段**（`[实测]` 逐个打印过）→ `pendingCi` 恒 false
→ **按钮是活的**。

另外六个虽然折叠了，但仍然出现在「目录里有什么」这份清单里，
其中 `llamacpp-metal-macos-arm64` / `llamacpp-vulkan-*` **让平台矩阵看起来比实际全**
（`debt-audit` C16 与 `platform` §1.3-1 都单独点过这一条）。

**结论：不是"到不了用户"。是"到得了，而且是推荐位"。**

## 摘了什么

| 对象                                                                       | 前 → 后                                                                                                      |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `vendor/llama.cpp` submodule                                               | 工作副本 165 MB / `.git/modules` 36 MB → **0**。`deinit` → `git rm` → `rm -rf .git/modules/vendor/llama.cpp` |
| `git submodule status`                                                     | 5 条 → **4 条**，无半摘状态                                                                                  |
| `.git/config` 的 `submodule.*`                                             | 5 组 → 4 组，无残留                                                                                          |
| `vendor/manifests/backends.json`                                           | 15 包 → **8 包**                                                                                             |
| `vendor/manifests/components.json`                                         | 8 条 → **7 条**                                                                                              |
| `scripts/license-report.mjs`                                               | A 类 5 → **4**（`pnpm license:report` 实跑确认 `A:4`）                                                       |
| `.gitmodules` / `.prettierignore` / `.gitignore` 注释 / `vendor/README.md` | 全部同步                                                                                                     |

> ⚠️ **push 体量不受影响**：submodule 的内容从来没进过本仓库的对象库
> （gitlink 只是 40 字节的 SHA）。`.git` 现在 34 MiB。
> 省掉的 201 MB 是**克隆后 `submodules:init` 的时间与磁盘**，不是 push 大小。

## 保留了什么（按你的判据：它探的是用户自己装的东西）

`packages/llm/src/detect.ts` 的 `llama-server` 探测**原样保留** ——
与 Ollama / LM Studio 同档，是 ADR-016 决策 3 明确保留的档 2，
且 `[实测 grep]` 全仓**没有任何地方 spawn `llama-server`**，它走的是 HTTP 探测。

但改了一处：那条候选的 label 原文是「**内置** llama.cpp」。
**那是个会显示给用户的字符串**，而"内置"这条线已经不存在了 ——
改成「llama-server（本机）」。同族的三处注释（`llm/src/index.ts` 的"档 3"、
`types.ts` 与 `openai-compatible.ts` 的"内置 llama-server"）一并改成"本机"。

## 守卫（钉结构不钉关键词）

`apps/daemon/src/pipeline/ytdlpInstall.test.ts` 新增：

```ts
assert.deepEqual(
  packs.filter((p) => p.engine === 'llama.cpp').map((p) => p.id),
  [],
);
```

判据是 **`engine` 字段**，不是 `llamacpp-` 前缀 —— 换个包名照样红。
前面有一条 `packs.length >= 5` 的前提自检，防止"目录空了所以恒真"。

**反向验证（真实输出，两次都还原并复跑绿）：**

```
① 从 git HEAD 取回真条目塞进 backends.json：
  ✖ 目录里不得再出现本地 LLM 引擎的包（ADR-016 决策 3 砍掉内置 llama.cpp）
  AssertionError: ADR-016 砍掉了内置 LLM 线；这些包会出现在 /runtime 页上、可点、可下载
    actual: [ 'llamacpp-cpu-linux-x64' ],  expected: []
  ℹ pass 12  ℹ fail 1

② 只往 components.json 加回（模拟"删漏了一边"），跑 ytdlp-install 那条两份清单守卫：
  ✖ components.json 里每个"要下载的"组件都在 backends.json 里有安装通道
  AssertionError: 这些组件只在 components.json 里、没有安装通道，点「安装」会拿到 409：llamacpp-cpu-linux-x64
  ℹ pass 11  ℹ fail 1
```

**你点名要跑的那条守卫，删完是绿的**（`ℹ pass 13 / fail 0`），
上面②证明它在"删漏一边"时确实会红。

## 我**没有**动、但你该知道的一条

`vendor/manifests/models-llm.json` 里 **5 条 GGUF 语言模型还在**。
`HANDOFF.md:326` 与 `debt-audit` B4 已把它列为独立项，**owner 是 `model-mgmt`，
且明写"等 Manager 裁决停用范围"**，所以我没越界去删。

现状（`debt-audit` B4 `[实测]`，我未复测）：前端 `ModelsPage.tsx:66` 把 `role`
硬编码成 `'asr'` 并过滤，所以**页面上看不到**；但 `GET /api/models/catalog`
**仍然公开返回它们**，且 `descriptionZh` 还写着「默认推荐的语言模型」。
→ 谁把那个硬编码 `'asr'` 改活，5 条 2.5 GB 的死模型当场出现在界面上。
**这跟我刚清掉的是同一族，建议一并裁决。**

---

# ② CI 的 11 条

## 逐条

| #                                             | 处理                                                                                                     | 我的判断                                                                                        |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **C1** 整份覆盖 `backends.json`               | 改成 `scripts/ci/merge-backend-manifest.mjs`，按 id **upsert**                                           | 按盘点改 + **加了一条盘点没提的**：见下「上游优先」                                             |
| **C2** fragment 与 `BackendPackSchema` 不兼容 | 改成 `scripts/ci/emit-pack-manifest.mjs`（零依赖 node），`availability:"pending-ci"` + `mirrors:[]`      | 按盘点改。`pending-ci` 不是将就 —— schema 早就为它留了 superRefine 的例外，前端也会据此禁用按钮 |
| **C3** 顶层漏 `catalogVersion`                | merge 脚本沿用现有值，可 `--catalog-version` 覆盖                                                        | 按盘点改                                                                                        |
| **C4** `if: always()` → `packs: []` 绿灯      | **删掉**，另加两道                                                                                       | 按盘点改，见下「失败即红」                                                                      |
| **C5** 签名检查 glob 落空即静默通过           | 改成 `find` + **计数**，检了 0 个就红                                                                    | 按盘点改                                                                                        |
| **C6** `choco install ninja` 装了不用         | **删掉安装**，不加 `-G Ninja`                                                                            | ⚠️ **我没按盘点建议的那半边做**，理由见下                                                       |
| **C7** 硬编码 `.build/whisper-win32-*/bin`    | `build-whisper.sh` 把 `bin_dir`/`stage_dir`/`pack_id` 导出到 `$GITHUB_OUTPUT`；并新增 `bin/Release` 候选 | 按盘点改 + 修了盘点只是"怀疑"的那一半，见下                                                     |
| **C8** `$ORIGIN` 对 macOS 无效                | 照抄 `build-probe.sh:70-73` 的分平台写法                                                                 | 按盘点改                                                                                        |
| **C9** pack id `win32/darwin` vs `win/macos`  | 新增 `PACK_OS` 映射，id 用 `win`/`macos`，schema 的 `os` 字段仍是 `win32`/`darwin`                       | 按盘点改，选了**手写 manifest 已经在用**的那套                                                  |
| **C10** probe 名字对不上                      | `setup.ts:70` → `openmemo-probe`                                                                         | 按盘点改（`[实测 grep]` 全仓 6 处都用 `openmemo-probe`，只有这一行是另一个名字）                |
| **C11** 没有 TS 门禁                          | 新增 `.github/workflows/ci.yml`                                                                          | 按盘点改，**保持 workflow_dispatch-only**                                                       |

外加两条卫生项：`permissions` 从 `contents: write` **收窄到 `contents: read`**
（这个 workflow 不建 release、不推 commit，publish 步骤只 echo），加 `concurrency`。

## 我判断该偏离盘点的一条：**C6**

`platform` §4.7-6 给的是「显式 `-G Ninja`，**或**让 workflow 从脚本拿输出路径」。
我只做了后者，**并把 ninja 的安装删掉**，没有加 `-G Ninja`。

理由：Windows 上切 Ninja **还需要先把 MSVC 环境导进来**（`vcvarsall` 或
`ilammy/msvc-dev-cmd`），否则 `cl.exe` 不在 PATH，cmake 配置直接失败。
那是在一个**一次都没跑过**的 workflow 上再加一个**没测过**的活动部件。
而"多配置生成器把产物放在 `bin/Release`"这个后果，我已经在
`build-whisper.sh` 的 `BIN_DIR` 三候选里处理掉，**并且本地验证过**（见下）。
→ **少一个变量，且被验证覆盖**，比"两个都改、两个都没验"好。

## 顺带修了盘点只标为「推测」的那一半（C7）

`platform` 写的是「脚本的两个候选和 workflow 的硬编码路径**可能**都落空」。
我把它落实了：老代码只试 `bin` 与 `Release/bin`，而 MSVC 多配置生成器的落点是
**`bin/Release`**（whisper.cpp 设 `CMAKE_RUNTIME_OUTPUT_DIRECTORY=${BINARY_DIR}/bin`，
多配置在其后追加配置名）。更阴的一点：**`bin/` 目录此时是存在的**（它是
`bin/Release` 的父目录），所以老代码的 `[[ -d ]]` 会**选中一个空目录**并继续跑下去。
新逻辑三候选 + **要求目录里真有文件**，并在本地用桩 cmake 造出这个布局验过。

## C1 的一条盘点没提、但会造成真损坏的情况：**不许把 published 降级成 pending-ci**

按 id upsert 之后还有一个坑：CI 全矩阵会构建 `cpu-linux-x64` / `cpu-win-x64`，
而这两个 id **上游已经有直连包**（有真 URL）。CI 产物是 `pending-ci`（无 URL）。
直接 upsert = **把用户能用的下载地址换成一个装不了的空条目**。

→ merge 脚本的规则：**现有条目有真 mirror、进来的没有 → 保留现有的**，
并打 `::warning::` 说明。判据用「有没有真 URL」而不是只看 `availability` 字段，
因为手写 manifest 里有的条目根本没写那个字段（schema 有 `.default('published')`）。

这也符合 ADR-015（上游优先）。**没有做成"报错退出"**，因为跑一次全矩阵必然
撞上它，那样默认路径就永远是红的 —— 而它不是失败，是一条明确的策略，
日志与 job summary 里都逐条列出来了。

## C4「失败即红」做了三道

1. **删掉 `if: always()`** → 任一构建 job 失败 → workflow 结论 `failure`，
   `manifest` job **被跳过**，**一个字都不写**。
   ⚠️ 这一条是**按 GitHub 文档推理的，我没有真跑过**（标 `[未跑通]`）。
2. **merge 脚本对零 fragment 直接 exit 1** —— 因为
   `download-artifact` 在**一个 artifact 都没有**时是**成功**的。这条本地验过。
3. **`lint-workflows.mjs` 有断言挡着 `always()` / `continue-on-error` 被加回来。**
   删一行容易，挡住它回来才是修好。这条本地验过。

---

# ③ 静态验证：覆盖到哪一步，哪一步没覆盖

**本机没有 `act`、`actionlint`、`docker`**（`which` 全空，`[实测]`）。
所以按你说的第二条路走：**把每个 job 的关键步骤抽成本地可跑的脚本并真跑**。

`pnpm test:ci-scripts` = 三个脚本，**258 + 15 + 14 条断言，全绿**。

## 覆盖到了

| 脚本                                   | 覆盖的 job 步骤                                                                                                                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/ci/lint-workflows.mjs`        | YAML 能否解析 · **job/step 键名是否 GitHub 认识**（非法键会让整份 workflow 被拒） · `needs:` 指向的 job 存在 · `${{ steps.X.outputs.Y }}` 的 X 在同 job 有 `id:` · **失败即红**（禁 `always()`/`continue-on-error`） · T-144 各条改动的定点断言   |
| `scripts/ci/selftest-ci-manifest.mjs`  | `merge-manifest` job 整条：fragment 生成 → **真 `validateBackendManifest`** → upsert → 落盘。含 6 条反向用例                                                                                                                                      |
| `scripts/ci/selftest-build-whisper.sh` | 三个构建 job 的 `Build pack` 步骤里**除编译外的全部逻辑**：用桩 `cmake` 造出真实目录布局，`build-whisper.sh` **原封不动跑它自己的代码**。桩 `uname` 让本机走到 **win / macos 两条分支**（`platform` §3.2 说的"从写下来那天起没被执行过"的那一类） |

`[实测]` 我还把 merge job 的真实命令按 CI 的样子跑了一遍
（`GITHUB_STEP_SUMMARY=... node scripts/ci/merge-backend-manifest.mjs --fragments <dir> --dry-run`），
summary 表格正常产出，且 `sha256sum` 确认**真的 `backends.json` 一个字节没动**。

## **没有**覆盖到（`[未跑通]` / `[未验证]`）

- **真编译**（cmake/MSVC/CUDA/ROCm/Vulkan/Metal 全部没跑）
- **`needs:` 的 job 跳过语义** —— 「全部构建失败 → workflow 红且 merge 不跑」
  这条**只是按 GitHub 文档推理**，`[未跑通]`
- **runner label 与 action tag 是否仍存在** —— 沿用 `platform` 2026-08-02 的核实结果，我没重核
- **`npm i -g pnpm@10.15.0` → `pnpm install --frozen-lockfile`** 这条安装链在 runner 上
  （本机 `pnpm install --frozen-lockfile` 跑过，`Lockfile is up to date`）
- **`pnpm -r test` 在一台干净 runner 上会不会全绿** —— 本机有数据目录、有已装组件，
  runner 上没有。测试大多有降级路径（日志里能看到 `vec=off` / `缺少工具 → blocked`），
  但**我不能保证**，`[未验证]`
- **macOS 的 `@loader_path` 是否真的让包可重定位**（C8）—— 需要真机
- **Windows 的 zip/7z 打包分支** —— 本机 `zip`/`7z` 都没有，那两个 case 用了 `--no-package`

## 反向验证：每条防线都造了坏输入，都拿到了真红灯

全部**验完即还原**，并复跑确认回到绿。

```
[A] 旧 printf fragment 喂真 schema
    ✔ ★反向：旧 fragment 被真 schema 拒绝，且理由点名了缺失/多余字段
    （断言逐个检查错误里是否提到 displayName / totalSizeBytes / requiresDriver /
      license / providesFiles / priority / catalogVersion —— 钉字段名，不钉文案）

[B] 零 fragment（模拟三个构建全挂 + download-artifact 空手而归）
    ✔ ★反向：零 fragment 必须失败
    + 断言 `manifest 被改动了` → 证明失败路径**一个字都没写**

[C] 坏 fragment  → merge exit 1 + 文件未改
[D] 缺 catalogVersion 的合并结果（= 旧 inline 逻辑的产物）→ schema 拒
[E] published 却无 mirror → superRefine 拒（错误里含 "mirror"）
[F] stage 为空 → emit 失败，理由是「构建没有产出任何文件」而不是 schema 报错

[G] 把 `if: always()` + 一个非法 job 键加回 workflow：
    ✘ lint-workflows: 3 个问题（共 260 条断言）
      - build-backends.yml#manifest: job 键 `steps_note` 不是 GitHub 认识的键（会被整份拒绝）
      - build-backends.yml#manifest: job 上有 `if: always()` —— 依赖的构建全失败时它照样会跑，
        写出一个空 manifest 并让整个 workflow 绿灯。这正是 C4。
      - build-backends.yml: manifest job 不该有任何 if:（C4 的那行 always() 已删）
    EXIT=1

[H] 回退 C8/C9（rpath 改回无条件 $ORIGIN、pack id 改回 HOST_OS）：
    ✘ win: pack id 不对 / ✘ macos: pack id 不对 / ✘ macos: rpath 不对
    ✘ 11 passed, 3 failed   EXIT=1

[I] 变异 emitter（把 catalogVersion 从 fragment 里拿掉）：
    ✘ 10 passed, 5 failed   REAL EXIT=1
```

每次反向验证前都先 `grep` 确认坏行**在即将运行的产物里**：

- `[G]/[H]/[I]` 的目标是脚本/YAML 本身，直接 grep 到了行号；
- `[A]–[F]` 与 llama.cpp 那两条走的是 `apps/daemon/dist/**`，测试**直接读源 JSON**
  （`REPO_ROOT/vendor/manifests/`，不经 dist），所以 grep 源文件即可，已 grep。

⚠️ **有一次翻车值得记下来**：`[I]` 我第一次是用 `node ... | tail -30; echo $?` 看退出码，
拿到 `EXIT=0` —— 那是 `tail` 的退出码，不是 node 的。改成重定向到文件再读 `$?`
才看到真的 `EXIT=1`。**管道会把退出码吃掉**，反向验证时尤其危险，因为它长得像"没红"。

## 一个我自己制造、又被自己的工具抓到的错

`lint-workflows.mjs` 第一次跑就红了两条，**都是我刚写进去的**：

1. 我在 `windows` job 里放了一个 `steps_note:` 用来挂 YAML 锚点。
   YAML 解析完全正常，本地读也正常，但 **GitHub 会因为不认识这个 job 键而拒绝整份 workflow**。
2. 我在 merge job 里为了打 summary 又加了一段 inline `node -e` —— 正是 C1/C3/C4 的成因。
   改成让 merge 脚本自己往 `$GITHUB_STEP_SUMMARY` 写。

**这两个都是"读一遍 YAML 完全看不出来"的错。** 它们是这份工具存在的最好理由。

---

# ④ 🔴 第一次手动触发 CI 之前，还有什么可能炸

> 按「会不会毁东西 / 会不会假绿」排序。你拿这份决定按不按那个按钮。

## 0. **先看这条：GitHub 上现在挂的是修之前那一版**

`[实测]` `git show origin/master:.github/workflows/build-backends.yml`：

```
53:permissions:
54:  contents: write        ← 没收窄
329:    name: merge-manifest
331:    if: always()        ← C4 还在
```

`git branch -vv` → `master ... [origin/master: ahead 1]`。
**我的 CI 修复（`bde374e`）在本地，没推。`origin/master` 上也还没有 `ci.yml`。**

→ **现在按 build-backends 的 Run workflow = 11 条原样发生。**
→ **先推 `bde374e`，再按按钮。** 顺序反了没有第二次机会：
C1 会把 `backends.json` 覆盖成只含本次产物，C4 会让它绿着通过。

（另：`zz-ci-runner-probe.yml`（`b44d574`）是 T-145 的探针，不是我的。
我 `git add` 前对过 `git status`，**没有把它扫进我的提交**。）

## 0-bis. 🔴 **`zz-verbatim-old-bb.yml` 是一颗上了膛的旧版**（提交 `4b15b28`，T-145，在我之后）

我交完之后 T-145 又提交了 `.github/workflows/zz-verbatim-old-bb.yml`
——「旧 `build-backends.yml` 的逐字节副本」，用来做二分诊断。`[实测 grep]` 它里面：

```
41:  workflow_dispatch:                                  ← 可以被点
54:  contents: write                                     ← 没收窄
331:    if: always()                                     ← C4 原样
363:  fs.writeFileSync("vendor/manifests/backends.json", ...)   ← C1 原样
```

**它和真正的那个 workflow 用的是同一个 `name: build-backends`**（第 27 行）——
在 GitHub 的 Actions 侧栏里，**两个条目会显示成一模一样的名字**，
文件名不会显示。点错一个，跑的就是 11 条原样的旧版。

- 损害有上限：它把 manifest 写在 **runner 上**然后 upload-artifact，**不 commit、不 push**，
  所以**仓库不会被改坏**。
- 但它会**在三个构建全挂时绿灯通过并产出一个 `packs: []` 的 artifact** ——
  正是 C4 那个形状。谁把那个 artifact 当成"CI 跑出来的目录"，就中招了。

**这是 T-145 的文件，我按 PROTOCOL §1.3 没有动它，在这里提出来。**
建议二选一：**诊断完立刻删掉**，或**至少把 `name:` 改掉、把 `manifest` job 摘掉**
（诊断的是"GitHub 认不认这个文件"，用不着那个会写东西的 job）。

> 我**没有**给 `lint-workflows.mjs` 加「两个 workflow 不许同名」这条断言 ——
> 加上去当场会红，而红的是别人正在用的诊断文件。**探针清掉之后值得补上**：
> 同名在 UI 上完全不可分辨，是只有机器查得出来的那一类。

## 1. 三个构建 job 里**只有 Linux CPU / Vulkan 两条命令真的在物理机上跑过**

workflow 头部原本就写着这句，**它依然成立**。我改的是"产物出来之后怎么处理"，
**没有改、也没有验证任何编译路径**。macOS / Windows / CUDA / ROCm / arm64 六类
全是照文档写的。**第一次跑大概率有 job 会挂。**

好消息是：挂了现在会**红**，而且**不会写出任何 manifest**（C4 的三道防线）。
**建议第一次不要跑全矩阵** —— 用 `whisper_ref` 留空 + 只看一两个 job 的话做不到
（矩阵是写死的），所以更现实的做法是：**接受第一次会红，看它红在哪一步**。

## 2. **`ci.yml` 那条更值得先按，但它有一个我验不了的前提**

`ci.yml` 不需要任何编译器、不需要 submodule（`[实测]` 全仓只有
`license-report.mjs` 读 submodule 目录，而 CI 不跑它；`apps/web` 的 `@manifests`
别名只指向 `vendor/manifests/`，是跟踪文件）。**它是投入产出比最高的一条。**

但 `pnpm -r test` 那 868 条在**一台干净 runner** 上会不会全绿，我**没法验证**
（本机有数据目录、有已装的 whisper/libsimple/sqlite-vec）。
从日志看测试大多有降级路径（`vec=off`、`⚠️ 流水线缺少工具 → 转 blocked`），
但**这是观察，不是保证**。`[未验证]`

→ **建议先按 `ci` 那个按钮，再按 `build-backends`。** 它便宜、无副作用、
且它红的话说明的是代码问题，不是 runner 环境问题。

## 3. **T-145 正在查的那件事没解决之前，按钮可能根本不存在**

`b44d574` 的提交信息写着「诊断 GitHub 为何不注册 workflow」。
如果 GitHub 侧还没把 workflow 注册出来，**上面两条都无从谈起**。
我没有碰远端、没有 fetch、也没去查那个问题（不在我的任务里），
但它是**时间上的前置条件**。

（一个不需要联网就能提的常见成因，供 T-145 参考：`workflow_dispatch` 的
「Run workflow」按钮**只在该 workflow 文件存在于仓库的默认分支上时**才出现。
GitHub 新建仓库的默认分支通常是 `main`，而本仓库是 `master` ——
如果远端默认分支不是 `master`，按钮就不会出现。`[推测，未验证]`）

## 4. `permissions: contents: read` 之后，publish 那条路彻底封死了（这是对的，但要知道）

原来是 `contents: write`。我收窄了，因为这个 workflow **不建 release、不推 commit**
—— publish 步骤只 echo 两行提醒。
但如果日后真要接发布，**必须同时**改回 `write` **并且**解决"包没有下载地址"这件事：
CI 产物现在一律 `availability: "pending-ci"` + `mirrors: []`，
**前端会禁用它们的安装按钮**。这是诚实的状态，不是 bug。

## 5. 合并结果**不会自动进仓库**

merge job 把 `backends.json` 写在 runner 上并 `upload-artifact`，**没有 commit、没有 push**
（原来也没有，我保持不变）。要落地得人工把 artifact 下下来对一遍。
→ **好事**：CI 跑坏了不会污染仓库。
→ **要知道**：跑完之后仓库里的 manifest 不会变，别以为它失效了。

## 6. 两条与本次改动无关、但会在第一次 CI 上咬人的

- **`pnpm check` 里藏着 §7 的雷。** `package.json` 的
  `"check": "... && pnpm -r build && eslint ."` —— **`pnpm -r build` 含 `vite build`**，
  会覆盖用户正在 `:10000` 上看的 `apps/web/dist`。PROTOCOL §7 补充要求一律
  `pnpm build:safe`，但 `check` 这条没跟着改。
  **我的 `ci.yml` 刻意不调 `pnpm check`，用的是 `build:safe` + `typecheck` + `lint` 拆开的写法**，
  并在 `lint-workflows.mjs` 里加了一条断言挡住 `pnpm -r build` 出现在 ci.yml 里。
  但**本地那条 `pnpm check` 的雷还在**，建议单独派人拆。
- **`pnpm format:check` 全仓 403 个文件不过**（`[实测]`，与本次改动无关的既有状态）。
  所以**我没有把它放进 `ci.yml`** —— 放进去第一次就是红的，而且红的是 400 个
  跟本次无关的文件。要接的话得先做一次全仓 `prettier --write`，那是独立的一件事。

## 7. 一条我改了、但只有真跑才知道对不对的

`build-whisper.sh` 现在**要求 runner 上有 `node`**（fragment 由 node 生成）。
三个构建 job 我都加了 `actions/setup-node@v6`。
`emit-pack-manifest.mjs` 是**零依赖**的（只用 node 内置模块），所以构建 job
**不需要 `pnpm install`**。这一点本地验过（脚本没有任何外部 import），
但 **runner 上 `node` 在 PATH 里**这件事只有真跑才知道 —— 脚本里有
`command -v node || die` 的显式检查，所以失败会说人话。

---

# ⑤ 纪律

- ✅ **零 `git push`、零 `git remote add`、零 CI 触发。** 远端是别人加的
  （提交 `b44d574` 之前就已存在），我只读过本地的 remote-tracking ref，**没有 fetch、没有推**。
- ✅ **`git add` 前逐次 `git status` 对过。** 第二次提交前发现多了一个
  `.github/workflows/zz-ci-runner-probe.yml` —— **不是我的**（T-145 的），
  没有 add，随后它被它自己的 owner 提交了。两个提交的 `--stat` 都逐文件核对过，
  **没有一个别人的文件混进来**。
- ✅ **`:10000` 只读**（只发过 `GET /api/backends/catalog` 与 `/api/health`），
  未重启、未 kill、未占该端口。
- ✅ **`/root/data-memo` 一个字节没碰**；**没有读也没有写 `~/.local/share/openmemo/datadir.json`**；
  没调用任何会写指针的接口。
- ✅ **构建一律 `pnpm build:safe`**，**没跑过 `pnpm -r build`**，`apps/web/dist` 未被触碰。
- ✅ **没用 `pkill -f`**、**没用 `git add -A`**、**没跑本地 whisper 转写测试**、
  **没有真编译 whisper.cpp**（用桩 cmake，省掉共享机器的 CPU）。
- ⚠️ **动过一次仓库文件用于反向验证**：`vendor/manifests/{backends,components}.json`、
  `scripts/build-whisper.sh`、`scripts/ci/emit-pack-manifest.mjs`、
  `.github/workflows/build-backends.yml`。**每次都先备份到 `/tmp/ci-prep/`、
  验完立刻还原、并复跑确认回绿**；这些都是 git 跟踪的仓库文件，**不是机器级状态**
  （PROTOCOL §9/§9-bis 针对的是后者）。最终 `git status` 与两个提交的 `--stat` 已证明还原干净。
- 📦 **新增了一个 devDependency：`yaml@2.9.0`**（root，`-Dw`）。
  `lint-workflows.mjs` 需要解析 YAML，而它本来只在 pnpm store 里作为传递依赖存在
  —— 按 store 路径 import 会钉死版本号，是个迟早会断的写法。
  `pnpm-lock.yaml` **+3 行**，`pnpm install --frozen-lockfile` 实跑通过。

# ⑥ 基线

```
tsc -b     : 0
eslint .   : 0
pnpm -r test : 868 passed / 0 failed   （基线 867 + 我新增的 1 条 llama.cpp 守卫）
pnpm test:ci-scripts : 258 + 15 + 14 条断言全绿
pnpm check:sources   : ✔ 95 个源码目录均未被 .gitignore 匹配
pnpm license:report  : 合计 11 项 — A:4（原 A:5）
```

# ⑦ 需要 Manager 决策

1. **推送顺序**：`bde374e` 必须**先推**再按任何按钮，否则跑的是 11 条原样的旧版。
   （我不推，等你。）
2. **`models-llm.json` 那 5 条 GGUF 要不要一起下架？** 与我刚清掉的是同一族
   （ADR-016 决策 3），owner 是 `model-mgmt`，`HANDOFF.md:326` 明写"等 Manager 裁决"。
   现状是前端硬过滤挡着、端点仍公开返回、文案还写着「默认推荐的语言模型」。
3. **`packages/shared` 的 `engine` 枚举里还留着 `'llama.cpp'`**
   （`schemas.ts:273,353`、`backends.ts:26`）。删掉它能从类型层面封死回流，
   但那是 contract 包、不是我的交付物，且新增的测试守卫已经挡住了实际风险。
   **要不要删，请裁决。**
4. **`pnpm check` 里的 `pnpm -r build`**（§7 的雷，见 ④-6）要不要现在拆。
5. **`ci.yml` 什么时候放开 push 触发**。现在是 `workflow_dispatch`-only（按你的要求），
   三行注释已写好。**一个"手动才跑的 CI"等于没有 CI** —— 别忘了这一步。
