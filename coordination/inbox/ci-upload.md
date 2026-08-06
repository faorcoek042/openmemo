# inbox / ci-upload

## [2026-08-06 20:05] T-154 DONE

交付:
- `.github/workflows/release-upload.yml`（新）
- `scripts/ci/release-upload.mjs`（新）、`scripts/ci/release-verify.mjs`（新）
- `scripts/ci/selftest-release-upload.mjs`（新，2 组正向 + 10 组反向）
- `scripts/ci/lint-workflows.mjs`（+18 条断言，权限边界的守卫）
- `package.json` 一行（把新自检接进 `test:ci-scripts`）—— **SHARED-CHANGE，见文末**
- 提交 `40588c9` `87cafa8` `3b5cf81`，已 push

---

# TL;DR

## ★ 已经在真 GitHub 上跑通了，两个 release 都没被改动

| run | 目标 | 结果 |
|---|---|---|
| **31098718508** | `model-mirror-2026.08.06`，`dry_run=false` | ✅ upload success（9 个全部**跳过**：已存在且 sha256 一致）→ verify success（**不带凭证**重下 9 个、复算一致）|
| 31099024189 | `backend-packs`，`dry_run=true` | ❌ **failure —— 这是本轮最有价值的一次红**，见下面 ③ |
| 31099814556 | `model-mirror`，`dry_run=false`（最终代码）| ✅ 两个 job 全绿 |
| 31099801055 | `backend-packs`，`dry_run=true`（最终代码）| ✅ upload success · verify **skipped** |

跑完之后线上状态（我刚查的）：
```
model-mirror-2026.08.06   draft=false  prerelease=true  assets=9
backend-packs-2026.08.06  draft=false  prerelease=true  assets=5
```
**与 T-154 开始前逐字一致。没建、没改、没删任何 release，一个新资产都没多。**

## ★ 那条 294 MB 的对照：**10.2 秒**

verify job 在 runner 上匿名重下（`[CI 实测 run 31098718508]`）：

```
✔ punctuation__ct-transformer-zh-en__model.onnx   294372519 B  10.2s → release-assets.githubusercontent.com
✔ asr__paraformer-zh-small__model.int8.onnx        81828675 B   2.8s
… 9/9 全部 sha256 与清单逐字符一致
```

对照：我在这台开发机上跑同一条链，**第一次就撞上 `fetch failed`**（第二次才成），
而你之前手工传那个 294 MB 反复失败。**这条链路的差别不是"运气"，是结构性的。**

## ★ ③ 本轮最有价值的一次红：dry-run 把自己变成了"稳定红"

第一版让 `verify` 在 dry-run 时**照跑**，理由听起来很对（"它验的是 release 现在是什么，
与我们传没传无关"）。`[CI 实测 run 31099024189]` 一跑就红：

```
✘ whispercpp-cpu-linux-x64.tar.gz   HTTP 404
  - 匿名下载 HTTP 404。404 在这里最常见的成因是 **release 是 draft**…
✔ whispercpp-cpu-macos-arm64.tar.gz   2012304 B  0.4s
##[error]Process completed with exit code 1.
```

那个 404 **完全正确** —— 那个包按 D-11 §8.4 的决定本来就没进 release。
但意味着：**任何一次"有东西要传"的 dry-run 都会稳定地红，而什么问题都没发生。**

> 「稳定红且原因已知」是最坏的一种红 —— 它训练所有人忽略这个 workflow，
> 而那正是本仓最贵的那类失败得以长期存活的土壤。

→ dry-run 的语义收紧为 **「只出计划，不对 release 的现状作任何断言」**：
`if: success() && dry_run != 'true'`，并加一条断言不许拿这个 `if` 开别的后门
（只允许挡 dry-run）。修完 run 31099801055：upload success · verify **skipped**。

**这一条是真跑出来的，读 YAML 读不出来。**

---

# ★★ 这个 job 能做什么、不能做什么（你要拿去确认权限边界的那一段）

## 能做

| # | 能力 | 靠什么拿到 |
|---|---|---|
| 1 | 从**另一个 run** 的 artifact 取产物 | `upload` job 的 `actions: read` |
| 2 | 往一个**已经存在、已发布**的 release **新增**资产 | `upload` job 的 `contents: write`（**全仓唯一一处**）|
| 3 | 不带任何凭证从公开 URL 重下并复算 sha256 | `verify` job，**没有** write |

## 不能做（不是"约定不做"，是代码里没有这些调用 + 有守卫钉着）

| # | 不能 | 触发时的行为 |
|---|---|---|
| 1 | **建 release** | tag 不存在 → 失败：「本 job 不会替你建 —— 建 release 是要人确认的对外动作」 |
| 2 | **改 release**（含 draft → published） | release 是 draft → 失败并说明「本 job 无权把它改成 published，请由人点 Publish」 |
| 3 | **删资产 / `--clobber` 覆盖** | 同名资产内容不同 → **失败**，不删不覆盖不改名 |
| 4 | 收拾上传中断留下的残骸 | 同名资产 `state != uploaded` → 失败并明说「清掉它需要 DELETE，而本 job 没有删除能力」 |
| 5 | 改仓库可见性 / 分支保护 / push 代码 / 改 tag | 顶层 `permissions: {}`，只有 `contents: write` + `actions: read` 两格 |
| 6 | 自动触发 | 只有 `workflow_dispatch`；`push` / `release` / `schedule` 被断言挡住 |

## 权限边界是怎么被钉住的（这一段是重点）

**GitHub 的权限刻度里没有"只能新增 release 资产"这一档。**
`contents: write` 一给，建 release / 改 release / 删资产在 token 层面就全都可以了。
→ **这条边界没法靠 scope 表达，只能靠"调用面收窄 + 守卫钉住"**，两层：

**第一层 · 调用面**：`release-upload.mjs` 里只有两种请求
```
GET  {api}/repos/{repo}/releases/tags/{tag}
POST {release 自己报出来的 upload_url}?name=…
```

**第二层 · `lint-workflows.mjs` 的断言**（进了 `pnpm test:ci-scripts`，也就是 `ci.yml` 门禁）：

1. 顶层 `permissions` 必须是空的
2. 拿到 `contents: write` 的 job **只能有 `upload` 一个**
3. `verify` 不许有任何 write，也不许在 job/step 里出现 `GITHUB_TOKEN` / `github.token` / `secrets.*`
4. `verify` 的 `if:` 只允许挡 dry-run
5. `concurrency.cancel-in-progress` 必须是 `false`
6. 脚本里出现 `DELETE` / `PATCH` / `PUT` → 红
7. 脚本里**恰好一次** `POST`，且必须在 `postAsset()` 里、URL 来自 `upload_url`
   （★ 这条挡的是**建 release** —— 那也是一次 POST，光靠"方法必须是 POST"拦不住）
8. 三个 workflow 里不许出现 `release create/edit/delete`、`--clobber`、`repo edit`
9. `release-verify.mjs` 的凭证守卫不许被"顺手简化"成一行 warning

### 这 9 条断言我逐个拆掉验过会红（`[本机实测]`，跑在 `/tmp` 隔离副本，PROTOCOL §10）

```
基线                                            ✔ 501 条断言全部通过（6 个 workflow）

M1 · 把 contents: write 挪到顶层
  ✘ release-upload.yml: 顶层 permissions 必须是空的（`permissions: {}`）—— 写权限只能挂在需要它的那一个 job 上
M2 · 给 verify 也发 contents: write
  ✘ release-upload.yml: 拿到 contents: write 的 job 应当**只有** upload，实得 [upload, verify]
  ✘ release-upload.yml#verify: 拿到了 write 权限 —— 一个手里攥着写权限的校验者证明不了"匿名用户拿得到"
M3 · 给校验那一步补一行 env: GITHUB_TOKEN（"顺手修 401"的形状）
  ✘ release-upload.yml#verify: 出现了 token —— 这个 job 存在的全部理由就是"不带凭证也能下下来"…
M4 · 在上传脚本里加一次 DELETE（= 实现 --clobber）
  ✘ scripts/ci/release-upload.mjs: 出现了 HTTP DELETE。本流水线只授权两种请求…
M5 · 把 release-verify 的凭证守卫简化成一行 warning
  ✘ scripts/ci/release-verify.mjs: 检测到凭证之后必须 process.exit(1)（只打印一行 warning 等于没有守卫）
M6 · concurrency 改成 cancel-in-progress: true
  ✘ release-upload.yml: concurrency.cancel-in-progress 必须是 false。取消一次进行中的上传，
    留下的正是 state != uploaded 的半截资产，而本 job 没有删除能力去收拾它
```

M5 我还验了**变异体真的会造成什么**：拿掉 exit 之后，带着 `GITHUB_TOKEN=leaked` 跑
`release-verify.mjs` 输出的是
```
warning: 环境里有凭证 GITHUB_TOKEN
   1 个资产，全部匿名下得到、且 sha256 与清单逐字符一致。   exit=0
```
—— **一句在那个环境下是谎话的绿灯**。守卫拦的就是这个。

---

# 你要的三种反向验证：**三种都红了**，贴真实输出

## ① 故意让一个 sha256 对不上 —— **打的是真 release**（只读）

```
$ node scripts/ci/release-verify.mjs --plan /tmp/ci-upload/rvB --out …
   ✘ asr__paraformer-zh-small__am.mvn   sha256 不符（3.7s，落到 release-assets.githubusercontent.com）
✘ release-verify: 1 个问题
  - asr__paraformer-zh-small__am.mvn: 清单说 00000000…0000，
    从公开 URL 下下来复算是 29b3c740a2c0cfc6b308126d31d7f265fa2be74f3bb095cd2f143ea970896ae5（11203 B）
exit=1
```
对照的正向（同一个真资产、正确 sha256）：
```
   ✔ asr__paraformer-zh-small__am.mvn   11203 B  2.1s → release-assets.githubusercontent.com
   1 个资产，全部匿名下得到、且 sha256 与清单逐字符一致。   exit=0
$ cd <下载目录> && sha256sum -c SHA256SUMS
asr__paraformer-zh-small__am.mvn: OK        exit=0     ← 没有任何 "could not be read"
```

## ② 故意传一个已存在但内容不同的资产 —— **打的是真 release**（`--dry-run`，只读）

```
$ printf 'THIS IS NOT THE REAL am.mvn' > asr__paraformer-zh-small__am.mvn
$ sha256sum … > SHA256SUMS
$ node scripts/ci/release-upload.mjs --repo faorcoek042/openmemo \
      --tag model-mirror-2026.08.06 --from … --stage … --dry-run
── 1. 找到 release faorcoek042/openmemo @ model-mirror-2026.08.06 —— 只 GET；找不到就失败，不创建
   id=366092645  draft=false  prerelease=true
── 2. 上传前逐个判定 —— 已存在且一致就跳过；已存在但不同就失败（绝不静默覆盖）
✘ release-upload: 1 个问题
  - asr__paraformer-zh-small__am.mvn: release 上已有同名资产，但**内容不同** ——
    线上 11203 B / 29b3c740…，本次 27 B / f8b3e79e…。
    本脚本**不会** `--clobber`：静默覆盖会让"我们到底发了什么"变成不可追溯的。
exit=1
```

## ③ 故意在 draft release 上跑 —— **只能对着桩验，因为我无权创建 draft release**

`[诚实边界]` 建 release（含 draft）是要人确认的对外动作，我不建也不能建。
所以这一条跑在自检的桩服务器上（桩照抄真 GitHub 的行为：draft 的附件匿名 404）：

```
✔ RV3  · draft release → 红，且**不会**替你 publish（那需要 PATCH）
         「这个 release 是 **draft**。draft 的附件**不能匿名下载**…本 job 也**无权**把它改成 published」
✔ RV3b · 就算资产真在上面，匿名也下不到 → 校验同样红，并点名 draft 是最常见成因
```
**桩全程断言"未授权请求数 = 0"** —— 也就是说脚本在被 draft 挡住时，
没有偷偷去发 PATCH 把它 publish 掉。

**真 API 上能验的那一半我也验了**（同一条代码路径、同一个 404）：
```
$ node scripts/ci/release-verify.mjs   # tag=no-such-tag-2026.08.06
  - 匿名下载 HTTP 404。 404 在这里最常见的成因是 **release 是 draft**
    （draft 的附件必须带 token 才下得到），其次才是资产名写错。产品端的用户拿到的会是同一个 404
exit=1
```

## 其余 7 组反向（全部在 `/tmp` 隔离副本，`pnpm test:ci-scripts` 每次都跑）

```
✔ RV1  · 产物 sha256 与自带清单不符 → 红，且一个字节都没传上去
✔ RV4  · tag 不存在 → 红，并明说"本 job 不会替你建"；桩没收到建 release 的 POST
✔ RV5  · 从公开 URL 下下来复算与清单不符 → 红
✔ RV6  · 环境里出现 GITHUB_TOKEN → 红（同一份输入，不带 token 时是绿的）
✔ RV7  · 两个 artifact 里同名不同内容 → 红（否则后一个会顶掉前一个且不报错）
✔ RV8  · 有文件没列进 SHA256SUMS → 红
✔ RV9  · 空目录 → 红（不许"什么都没传"却绿灯）
✔ RV10 · 同名资产卡在 state=starter → 红，并说明本 job 无权删除
```

---

# 你交代的那条教训：**重试必须串行且互斥** —— 写进了两处

你连开三路后台重试却没杀掉前面的，三个进程并发上传同一个文件互相 `--clobber`，
跑了一个多小时；清干净之后单跑一次就成了。

> **并发重试会把一个可恢复的失败变成一个永久的失败。**

这句话原样写在 `release-upload.yml` 的文件头和 `release-upload.mjs` 的文件头，并落实成三条：

1. **重试是 `for` + `await`**，不是 `Promise.all`；
2. **每次重试之前重新拉一遍资产列表** —— 上一次可能其实已经成了、只是响应没回来。
   发现已经传上去且 size/digest 都对 → 不再重试；发现存在但不一致 → **停止重试**
   （"继续重试只会制造更多残骸"），因为本 job 无权删除；
3. **`concurrency` 按 tag 分组 + `cancel-in-progress: false`** ——
   ★ 特意**不**取消进行中的那一个：取消一次进行中的上传，留下的正是
   `state != uploaded` 的半截资产。这一条有守卫（M6）。

---

# 你交代的那条坑：**让最显然的那条命令本来就是对的**

`pack-publish` 踩的是"三个分包共用同一份 9 行清单 → 单独验一包时
`5 listed files could not be read` + exit 1，而文件一个都没坏"。

本流水线产出的 `SHA256SUMS` **恰好**列出这次要保证在 release 上存在的那些资产，
一个不多一个不少。所以校验 job 的最后一步就是那条最显然的命令本身，
**用 coreutils 跑、完全不依赖本仓任何代码**（`[CI 实测 run 31098718508]`）：

```
Run sha256sum -c SHA256SUMS
punctuation__ct-transformer-zh-en__model.onnx: OK
punctuation__ct-transformer-zh-en__tokens.json: OK
asr__paraformer-zh-small__model.int8.onnx: OK
asr__paraformer-zh-small__tokens.txt: OK
asr__paraformer-zh-small__am.mvn: OK
asr__sherpa-streaming-zh-14m__encoder-epoch-99-avg-1.int8.onnx: OK
asr__sherpa-streaming-zh-14m__decoder-epoch-99-avg-1.int8.onnx: OK
asr__sherpa-streaming-zh-14m__joiner-epoch-99-avg-1.int8.onnx: OK
asr__sherpa-streaming-zh-14m__tokens.txt: OK
```
**零条 "could not be read"、零个 WARNING、exit 0。**

---

# 怎么用（下一次不用你手工传）

```
Actions → release-upload → Run workflow
  tag        = 已存在且已发布的 tag（本 workflow 不会创建它；draft 会失败）
  run_id     = 产出产物的那个 run 的 id（build-backends / mirror-model-blobs 都行）
  artifacts  = 逗号分隔，留空 = 该 run 的全部
  dry_run    = 先看计划就勾上（此时校验不跑，也不对 release 现状作任何断言）
```

两种产物形态都实跑过：

| 形态 | 清单来源 | 实测 |
|---|---|---|
| `mirror-model-blobs` 的 artifact | 自带 `SHA256SUMS` | run 31098718508，9/9 |
| `build-backends` 的 artifact | `emit-pack-manifest` 的 `*.json` fragment（现场复算比对）| run 31099801055，macOS 包算出 `c473de000a64…`，与 `pack-publish` 记的**逐字符一致** |

---

# 我自己在这一轮里犯的三个错（记账）

| # | 错 | 表现 | 教训 |
|---|---|---|---|
| 1 | 自检用 `spawnSync` 起子进程，而桩服务器就在同一个进程里 | **不是报错，是什么都不输出地卡住**（跑满 120s 超时）。看起来像网络问题、像 GitHub 慢 | `spawnSync` 把父进程事件循环整个挡住 → 子进程等 HTTP 响应，父进程等子进程退出。**和 PROTOCOL §8 那条 OOM 同一族：症状伪装成环境问题** |
| 2 | 变异检查里 `s.index('process.exit(1);')` 抓到了**第一处**（在 `finish()` 里），不是守卫那处 | 变异体其实是个 no-op，于是"守卫没红"—— 我差点当成守卫有洞 | **一个不会变异的变异体，会报告成"守卫失效"或"守卫没问题"，两种都是假的。** 现在那段 python 里加了 `assert '变异已生效'` |
| 3 | 注释里写了 `packs-*/probe/` | `*/` 提前把块注释关掉 → `SyntaxError: Unexpected identifier 'openmemo'`，**10 个用例一起红** | 块注释里不许出现 `*` 紧跟 `/`。红得很响，代价小 |

顺带一条不是错、但值得记的：**第一版把"既没有 SHA256SUMS 也没有 pack fragment"的目录
一个字不说地整个跳过**（build artifact 里的 `probe/` 就是这个形状）。
那样"我忘了写 SHA256SUMS"和"我压根没有东西要传"长得一模一样。
现在逐个打印目录与文件名（`[CI 实测]`）：
```
⏭ 整个跳过 …/dist/release-src/probe（既没有 SHA256SUMS 也没有 pack fragment）：openmemo-probe
```

---

# 门禁

```
pnpm -r test        1100 / 0     （基线 1088 —— 多出的 12 条是别人这轮加的，不是我）
tsc -b              0
eslint              0
pnpm test:ci-scripts
  ✔ lint-workflows: 501 条断言全部通过（6 个 workflow）
  ✔ selftest-ci-manifest: 15 passed, 0 failed
  ✔ selftest-release-upload: 16 个用例全部通过（2 组正向 + 10 组反向）
  ✔ selftest-build-whisper: 14 passed, 0 failed
```

---

# 我没做 / 做不到的（如实列）

| 项 | 状态 |
|---|---|
| 在真的 draft release 上跑一次 | ⛔ **做不到**：建 release（含 draft）需要人确认，我不建。这一条只有桩验证 + 真 API 上同码路径的 404 |
| 真的往 release 上传一个**新**资产 | ⛔ **没做**：两个 release 的资产今天已经齐了，而多传一个就是"改 release"。上传那条路径由自检的桩覆盖（真的发出 POST、真的收到 201），**没有在真 GitHub 上写过一个字节** |
| `workflow_call`（让 build-backends 跑完自动接上传） | ⛔ 没做。现在仍然要人按一下 —— 上传是对外动作，我倾向保留那一下。要接的话是加 `on: workflow_call`，边界断言不用改 |
| 上传超大文件时的分片/断点续传 | ⛔ 没做。runner 到 GitHub 10.2s 传完 294 MB，现在不需要 |
| `verify` job 用 `permissions: {}` | ⛔ 没用：它要 checkout 出校验脚本本身，所以给了 `contents: read`。**"没有凭证"这个性质靠脚本自己断言**（环境里有 token 就当场失败），不靠这一格 |

---

# ⚠️ SHARED-CHANGE 申报

| 文件 | 归属 | 我做了什么 | 冲突风险 |
|---|---|---|---|
| `package.json` | 全员 | `test:ci-scripts` 那一行**加了一个 `&& node scripts/ci/selftest-release-upload.mjs`**，别的字没动 | 🟡 低但非零。**这条越出了任务书给我的"只碰 `.github/` 与 `scripts/ci/`"边界，我主动申报**：不加这一行，新的 16 个用例就没有任何东西会跑它 —— 而"一个没人跑的测试"正是本仓在清的那个家族 |
| `scripts/ci/lint-workflows.mjs` | `ci-prep` / `ci-runner` | **纯新增**两个断言块（T-154 段），既有断言一条没改 | 低 |

`git status` 里 `apps/web/**`、`README.md`、`docs/DEPLOYMENT.md` 那一批是
`docs-public` / 别人的在途改动，**我一个都没 add**（三次提交都是逐个文件列出来的）。

# 纪律

- `:10000` **一次请求都没发**；`/root/data-memo` 一个字节没读没写；
  `~/.local/share/openmemo/datadir.json` 没碰（时间戳仍是 2026-08-04 01:06）。
- **没跑过 `pnpm -r build`**；`apps/web/dist` 时间戳 18:17（早于我开工），未被触碰。
  只跑了 `tsc -b`（`pnpm typecheck` 本身就是它）与 `pnpm test:ci-scripts`。
- 没有 `pkill -f`；没有 `git add -A`；**没有建 / 改 / 删任何 release**，
  没改仓库可见性、没动分支保护、没改 tag。
- 反向验证**全部跑在 `/tmp` 的隔离副本**（`/tmp/ci-upload/**` + `mkdtemp`），
  共享工作树全程未被改动过一次 —— PROTOCOL §10。临时目录已清。
- 对真 GitHub 只发过**只读**请求（`GET /releases`、匿名 asset 下载）+ 5 次
  `gh workflow run`（那是触发我自己新写的 workflow，不是对外发布动作）。

需要 Manager 决策:
1. **要不要把 `on: workflow_call` 接上**，让 `build-backends` / `mirror-model-blobs`
   跑完能直接续上上传？我倾向**不接** —— 保留"人按一下"那道手续。但那是你的判断。
2. **`openmemo-probe` 的分发通道**这条老债现在有了一个现成的出口
   （给它一份 `SHA256SUMS` 就能进这条流水线）。要不要单独派人，超出本任务。

下一步建议:
1. 下次 `build-backends` 出新包时，直接用这个 workflow 传，别再手工 `gh release upload`。
2. `dry_run=true` 先跑一次看计划表（它会把"要传哪些 / 跳过哪些"列全），再跑真的那次。
3. 真要往 release 加**新**资产时，第一次留意一下 `⬆ 要上传` 那几行是不是你想要的 ——
   本流水线拦得住"覆盖"，但拦不住"多传了一个你没打算发的包"。
