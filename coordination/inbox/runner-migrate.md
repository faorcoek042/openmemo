# inbox / runner-migrate

## [2026-08-07 12:10] T-163 SHARED-CHANGE 申报（动 manifest 之前）

`git status --short` 此刻有 30 个改动文件，全部是 `pack-select` 那一片
（`packages/pipeline/src/tools.ts`、`packages/runtime/src/selfcheck.ts`、
`apps/daemon/src/**`、`apps/web/src/**`）加上我自己的四条。
**`vendor/manifests/` 没有任何人的在途改动。**

我接下来要改：

| 文件                                                                             | 改什么                                                                                                                                                                                                          | 冲突风险 |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `vendor/manifests/components.json`                                               | 只改 `media-tools-macos-arm64` 一条：`v7.1.4-3` → `v8.1.2-2`（`pinnedVersion` / `releaseUrl` / `sizeBytes` / `sha256` / `sha256Provenance`），并把该条的 `stableOnly` 由 `true` 放松成 `false`、补 `tagPattern` | 低       |
| `vendor/manifests/backends.json`                                                 | 同上那条的 `engineVersion` / 文件名 / `sizeBytes` / `sha256` / mirror URL / `totalSizeBytes`                                                                                                                    | 低       |
| `.github/workflows/build-backends.yml` · `scripts/ci/*` · `package.json`（一行） | 我的地盘（T-163 ①）                                                                                                                                                                                             | 低       |

**`stableOnly` 只对这一条放开，不动全局**（其它 21 条一个字节不改）。理由写进
`sha256Provenance`，不是只翻一个布尔值 —— 见下一条回执 §2。

反向验证一律跑在 `/tmp/runner-migrate/` 的隔离副本上（PROTOCOL §10）。

---

## [2026-08-07 05:30] T-163 DONE

# TL;DR

| #   | 事                                                       | 状态                                                                                                                                  |
| --- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| ①   | 三条 Linux 腿迁到 `ubuntu-24.04` **且**产物 GLIBC ≤ 2.34 | ✅ **两条判据都满足，CI 实测**（run **31147884172**，三腿全 success）                                                                 |
| ②   | macOS ffmpeg 升 8.1.2-2，`stableOnly` 只对这一条放开     | ✅ 完成，sha256 与 Mach-O `minos` 本机复核过                                                                                          |
| ③   | Vulkan 包补进 `backends.json`                            | ⛔ **没补，也不该由我补** —— `pack-select` 的前置已落地（`a7535c7`），但还差一件**只有你能做**的事：那个包**没有下载地址**。清单在 §3 |

提交：`3bb7a56`（①）· `0d01e8f`（②）· `b243a37` + `04259d6`（①的两轮 CI 修）。全部已 push。
门禁：`pnpm -r test` **1208 / 0** · `tsc -b` 0 · `eslint` 0 · `test:ci-scripts` 全绿 ·
`lint-workflows` **536** 条（+30）· `selftest-buildbox` **31** 条（含 10 条反向）。

---

# §1 ① —— **两条判据都满足了**

## 1.1 判据一：三条腿都在 `ubuntu-24.04` 上

`[CI 实测 run 31147884172]`，日志里每条腿的 `Set up job` 都打着 `Image: ubuntu-24.04`：

```
linux-x64-cpu      success
linux-x64-vulkan   success
linux-x64-cuda     success
macos / windows    skipped（我加的 legs 输入，见 §1.6）
merge-manifest     skipped（needs 有 skipped 就跳过 —— 半份矩阵不该合出目录，C4 的设计如此）
```

## 1.2 判据二：每个 ELF 最高 GLIBC ≤ 2.34（`objdump -T` 逐个验，不是抽验）

```
linux-x64-cpu      check-elf-glibc: 22 个 ELF，上限 GLIBC_2.34，实测最高 GLIBC_2.34  ✔
linux-x64-cpu      check-elf-glibc:  1 个 ELF（探针），上限 2.34，实测最高 2.34      ✔
linux-x64-vulkan   check-elf-glibc: 23 个 ELF，上限 GLIBC_2.34，实测最高 GLIBC_2.34  ✔
linux-x64-cuda     check-elf-glibc: 23 个 ELF，上限 GLIBC_2.34，实测最高 GLIBC_2.34  ✔
```

**注意它打印了"22 / 23 / 1 个"** —— 数到 0 个会当场红。

## 1.3 怎么做到的：**把「runner 标签」和「glibc 下限」解耦**

这两件事此前绑在同一个 `runs-on:` 上，于是来回横跳了两次
（T-145 为 glslc 挪到 24.04，下限被抬到 2.38；T-161 挪回 22.04 压回 2.34，撞上退役）。
你猜的方向（在 24.04 runner 里用容器编）**是对的，我验证了并做成了**：

- `runs-on` 只决定"谁来跑这个 job" → 跟着 GitHub 的排期走，随时可以再升到 26.04；
- 编译发生在 `scripts/ci/buildbox.Dockerfile` 造的 **glibc 2.35 容器**里；
- 判据仍然是 `check-elf-glibc.mjs`。**容器只是让基线容易满足，不是基线本身。**

`[CI 实测]` 同一个 job 里两行并排，这就是"解耦"这件事的全部证据：

```
==> buildbox: 宿主 glibc     = ldd (Ubuntu GLIBC 2.39-0ubuntu8.7) 2.39
              编译环境 glibc = 2.35 ≤ 2.35 ✔      gcc 11.4.0 · cmake 3.22.1 · ccache 4.5.1 · node v22.23.1
```

### 为什么是 `docker run` 而不是 job 级 `container:`（这条我认真比过）

`container:` 更简洁，但它让**所有** step 都在容器里跑，于是
`jlumbroso/free-disk-space` 就再也够不着宿主的 `/usr/share/dotnet` 之类 ——
它会**成功地什么都没释放，并且照样报绿**。而 CUDA 那条腿真的需要那块盘
（容器的镜像层与可写层都落在宿主的 `/var/lib/docker` 上）。
所以宿主留给 action，只有编译/探针/烟雾测试三步进容器。

### 为什么 `BASE_IMAGE` 用会滚动的 `ubuntu:22.04` tag 而不是 digest

本仓一向敌视可变引用，所以这条要说清楚：我们依赖的性质是「glibc 是 2.35」，
它在 22.04 整个生命周期里固定，滚动的只是安全更新；而这条性质有硬守卫兜底。
钉 digest 反而会把编译工具链冻在一个已知有漏洞的版本上，去防一件已经被守卫防住的事。
（对照 ffmpeg：那是**发给用户的二进制本身**，没有第二道验证，所以必须钉。）

`[实测]` `ubuntu:18.04 / 20.04 / 22.04 / 24.04` 四个 tag 今天在 Docker Hub 上全部
pull 得到（registry manifest HTTP 200）—— 而 `ubuntu-18.04` 这个 **runner 标签**早就没了。
**镜像的寿命远长于 runner 标签的寿命**，这正是这次迁移要买的那条性质。

## 1.4 ★ 反向验证：**撤掉容器，CI 上真的变红**（这条是本任务的核心证据）

隔离方式：`/tmp/runner-migrate/rv-ci` 的**独立 clone** + 临时分支
`rv/t-163-no-buildbox`（PROTOCOL §10 —— 共享工作树全程没有被改成坏状态，
master 上的人看到的一直是好的那一版）。变异只有一处：把 `Build pack` / `Build probe`
的 `buildbox.sh` 前缀去掉，其余一字不动。

`[CI 实测 run 31149823227，linux-x64-cpu，failure at "Guard glibc floor"]`：

```
check-elf-glibc: 22 个 ELF，上限 GLIBC_2.34，实测最高 GLIBC_2.38
  ✘ GLIBC_2.38   .../whispercpp-cpu-linux-x64/libggml-base.so.0.15.1
  ✘ GLIBC_2.38   .../libggml-cpu-alderlake.so
  ✘ GLIBC_2.38   .../libggml-cpu-{cannonlake,cascadelake,cooperlake,haswell,icelake,ivybridge,…}.so
✘ 以下产物的 glibc 下限高于基线：
  .../libggml-base.so.0.15.1  需要 GLIBC_2.38
      (GLIBC_2.38) __isoc23_strtol
```

**22 个 ELF 全部从 2.34 跳到 2.38，符号点名到 `__isoc23_strtol`** —— 与 D-11 §8.2
当初实测到的三个符号是同一族。分支已删除（`git push --delete` 已确认，远端只剩 `master`）。

## 1.5 顺手暴露的一条：**探针此前不在守卫覆盖面里，而它是随包出厂的**

`Guard glibc floor` 只看 `stage_dir`（包内容），而 `dist/probe/openmemo-probe`
是单独 upload 的、`runtime/setup.ts` 在用户机器上跑的就是它。
22.04 上这一格**碰巧**安全（宿主就是基线），24.04 上就不是 ——
一个 GLIBC_2.39 的探针在 Debian 12 上起不来，而它挂掉的表现是
**"探测不到任何 GPU"，与"这台机器真的没有 GPU"在界面上完全一样**。
→ 补了第二条 guard（`--dir dist/probe`），CI 实测 1 个 ELF ≤ 2.34。
**这条是本次迁移顺手暴露的，不是原来就红的**，记在这里免得下次被当成回归。

## 1.6 其余顺手改的（都在我的地盘）

| 改动                                                           | 为什么                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CUDA 不再用 `Jimver/cuda-toolkit`                              | `[实测]` NVIDIA 的 `repos/ubuntu2404/` 最老只到 `cuda-nvcc-12-5`，`ubuntu2204/` 才有 12-4。宿主一升级，T-145 第二轮那两行 `no installation candidate` 必然重演。改成在 jammy 容器里按**真实包名**装 —— 顺带消掉该 action 把包名拼成 `cuda-<项>-<major>-<minor>` 那个坑（T-145 为 cuBLAS 烧过两轮真跑） |
| 烟雾测试搬进 `scripts/ci/smoke-linux-pack.sh` 并**在容器里跑** | 内联在 YAML 里的 50 行 shell 没有任何测试碰得到它（与 C1/C3 同一条理由）；更要紧的是：在 2.39 的宿主上跑它，证明的是一句弱得多的话 —— **判据要跑在下限那一侧才算数**                                                                                                                                   |
| `workflow_dispatch` 加 `legs` 输入                             | 本 workflow 只能整份 dispatch，一次烧 8 个 job（含两个 macOS）。T-161 有一轮 GitHub 故障，五条腿全死在 `Set up job`，唯一有信息量的只有 linux                                                                                                                                                          |
| `CCACHE_DIR` 在 job env 里写死                                 | `ggml-org/ccache-action` 的缓存目录是 `process.env.CCACHE_DIR \|\| $GITHUB_WORKSPACE/.ccache`，而它**不导出**这个变量（配置写在宿主 `$HOME/.config/ccache/`）。容器里 $HOME 不同 → ccache 回落到自己的默认路径 → **每次全量重编，且只表现为"CI 变慢了"**                                               |

## 1.7 两个 CI 才暴露、本机绿的 bug（如实记）

**(a) 自检本机 25/25 绿、CI 上 11 条红。** 成因不是逻辑是环境：真 runner 自己设着
`GITHUB_OUTPUT` / `GITHUB_ENV` / `GITHUB_STEP_SUMMARY`，`buildbox.sh` 会断言它们落在
挂载根底下 —— **被测脚本按设计红了，而用例把那当成"功能坏了"**。
与 T-145 那条「本机 node 24 绿、CI node 22 红」同族：**一个会随宿主环境改变结论的自检，
等于没有自检**。修法是每次调用从显式擦干净的环境出发，并补两条用例把这件事本身钉住
（含"把擦除拿掉同一条必须红"，否则那个擦除只是摆设）。

**(b) 一个"为了让 node 能用"的挂载，把编译环境换掉了一半。**
`[CI 实测 run 31147246480]` cpu/vulkan 成功、**cuda 死在 `Build pack`**：

```
CMake Error: Could not find CMAKE_ROOT !!!
Modules directory not found in /usr/local/share/cmake-3.31
```

链条整条静默：cuda 腿跑 `free-disk-space` → 删掉 `/opt/hostedtoolcache` →
`command -v node` 回落到 `/usr/local/bin/node` → 我把宿主的 `/usr/local/bin`
**同路径**挂进容器 → 盖住容器自己的那一个 → **容器的 cmake 3.22 被宿主的 3.31 顶掉**，
而那个二进制是给 glibc 2.39 编的、Modules 目录又没挂进来。
修法两条都是结构性的：node 改挂**单个文件**到 `/opt/buildbox/node/`；
任何同路径挂载落在系统目录一律**当场红**并说清后果。

**(c) 两处 SIGPIPE。** `ldd --version | head -1` 在 `pipefail` 下会随机返回 141
（本机复现：同一条自检两次跑出不同结果）。同族的
`ldd | grep 'not found' | grep -q 'libggml'`（T-161 的内联版本）在匹配行 **≥150** 时
会把红**吞掉**（`[实测]` 阈值：≤120 命中、≥150 被吞，分界在管道缓冲区）。
⚠️ **诚实边界**：真包不会有 150 条 not found，所以后者在实际输入上不会发生 ——
我没有把它说成"已经在害人"。两处一起改成"先取回文本再匹配"。

---

# §2 ② macOS ffmpeg 7.1.4-3 → 8.1.2-2

## 2.1 改法：**只放开这一条，并把"为什么这一条可以"写下来**

`stableOnly` 只在 `media-tools-macos-arm64` 上改成 `false`，其余 23 条一个字节没动
（`UpstreamSource` 本来就是每个组件各自一份，`upstream.ts:131` 的 `.filter` 读的就是这一条自己的值）。

同时做了三件对冲，不是只翻一个布尔值：

1. **新增 `UpstreamSource.stableOnlyReason` 字段**（`packages/shared/src/components.ts`），
   把理由和那个布尔值写在**同一个位置**。
   > 一个悄悄从 true 翻成 false 的布尔值，和一条写下了代价与对冲的例外，在 diff 里长得一样。
2. **补 `tagPattern` `^v\d+\.\d+\.\d+-\d+$`** —— 拿掉 prerelease 过滤之后，
   它是唯一还挡着别的 tag 家族溜进来的东西。
3. **守卫 `apps/daemon/src/pipeline/ffmpegStableOnly.test.ts`**（3 条，钉结构不钉版本号）。
   反向验证 5 条，跑在 `/tmp/runner-migrate/rv-mf` 隔离副本（**先跑对照组确认未变异时全绿**）：
   翻回 true / 删 tagPattern / 删理由 / 只改一份清单 / 白名单里留一个不存在的 id —— **五条全部变红**。

## 2.2 为什么这一条可以（写进了 manifest，这里是摘要）

`[实测 2026-08-07，匿名 API]` jellyfin-ffmpeg 最近 30 个 release：
**6 条 8.x（`v8.1.2-2/-1`、`v8.1.1-4/-3/-2/-1`）全部 `prerelease=true`**，
而 `/releases/latest` 返回 `v7.1.4-3`。
→ `stableOnly: true` 在这里过滤掉的**不是"不稳定的版本"，是整个 8.x 世代**；
它把这个组件永久钉死在 7.x，而这件事从字段名上完全看不出来。
上游查不到把 8.x 转正的 roadmap（issue 里只有一条无关 bug）→ 标 `UNKNOWN`。

放松的代价被两件事框住：① 升级检查只**报告**、从不自动改安装；② tagPattern 收窄。

## 2.3 我自己复核过的（不是转述 `amd-vulkan`）

```
匿名下载全部 32,894,656 字节 → sha256 397642a17f0e34882875f3127cc065b8f225a3d5b0fc4c068c1fe6ad49e5485c
GitHub Releases API 的 digest 逐字符一致 ✔
Mach-O（ffmpeg 与 ffprobe **各解一遍**，两个都是 45 条 load command）：
  LC_BUILD_VERSION  minos = 12.0.0（sdk 26.5.0）—— 与 7.1.4-3 相同，**没有被抬高**
  LC_LOAD_DYLIB     各 26 条，全部指向 /System/Library/Frameworks 与 /usr/lib
  LC_RPATH 0 条 · LC_CODE_SIGNATURE 有 · 归档解开仍是扁平的 ffmpeg + ffprobe
→ requiresDriver.macosVersion 保持 "12.0"，不用改。
```

> 一处与 `amd-vulkan` 回执的**小出入**，按实测为准：它 §2.3 写 27 条 `LC_LOAD_DYLIB`，
> 我两个二进制各数到 **26** 条（它自己写进 `components.json` 的 7.1.4-3 那条也是 26）。
> 不影响结论（全部是系统路径），但既然不一致就摆出来。

⚠️ jellyfin 的 mac 构建脚本里**没有任何 `MACOSX_DEPLOYMENT_TARGET`**，跑在 `macos-latest` 上 ——
minos 这次没漂是**运气不是保证**（D-11 §8.1 同族）。**每次移动这个 pin 都要重跑这条检查**，
已写进 `sha256Provenance`。

## 2.4 ⚠️ 顺带查到、**刻意没有抹平**的一条（给你判）

我原本想断言"全仓只有这一条 `stableOnly: false`"—— **查了之后发现那是错的**，
所以断言改了、话也改了：

| 组件                                                   | 状态                                                                 | 影响 |
| ------------------------------------------------------ | -------------------------------------------------------------------- | ---- |
| `whispercpp-cpu-macos-arm64`                           | 显式 `false`，**没有理由**                                           | 见下 |
| `media-tools-{linux,win}-x64`                          | 字段缺省（= 同样不过滤），但有 `tagPattern` 收着                     | 低   |
| `sherpa-onnx-node` / `asr/whisper-large-v3-turbo-q5_0` | 缺省，且 kind 是 npm / huggingface —— **那两个分支根本不看这个字段** | 无   |

第一条值得单说：它指向**我们自己的仓库** `faorcoek042/openmemo`，
而 `[实测]` 那里只有两个 release（`backend-packs-2026.08.06`、`model-mirror-2026.08.06`），
**两个都是 `prerelease=true`**。
→ 也就是说，哪天有人"顺手统一"把它改成 `stableOnly: true`，
**它的升级检查会一个候选都找不到**，然后表现为 `latestVersion: null` 加一句安静的 checkError。
我没有替它编一段理由（那是把"我不知道"伪装成"我知道"），
而是把它列进守卫的白名单并把上面这段证据写在旁边 —— 白名单里躺着一个已不存在的 id
也会当场红，免得它变成一张没人看的免死金牌。

---

# §3 ③ Vulkan 包 —— **前置消了一条，还差一条，而那条只有你能做**

`pack-select` 的 `a7535c7`（T-162）已落地，`amd-vulkan` §1.3 那条「解析器按 `readdir`
取第一个」**不再是阻碍**。但顺序是「先修解析器 → **再发包** → 再补目录」，
中间那步卡在我的边界外：

**那个包没有下载地址。** fragment 是 `availability: "pending-ci"` + `mirrors: []`，
产物只在 GitHub Actions 的 artifact 里。要补进目录就得有 release 资产，
而我**不建 / 不改 / 不删 release**（本轮 `gh` 只用于 `run list/view` 与 `workflow run`）。

## ⚠️ 一条会让人拿错文件的提醒

`amd-vulkan` 交给你的那份清单（`29,495,375 B` / `fa6feb61…636f`，来自 run **31121718587**）
**已经过期了** —— 那是 22.04 runner 上编的。本轮换了编译环境（容器 + 同版本工具链），
产物是新构建，**sha256 必然不同**。要发就发新的：

| 文件                                 | 来源                                                                    | 说明                                                                                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `whispercpp-vulkan-linux-x64.tar.gz` | `build-backends` run **31147884172**，artifact `packs-linux-x64-vulkan` | 23 个 ELF 全部 ≤ GLIBC_2.34；`providesFiles` 含 `whisper-cli`；relocatable；`libggml-vulkan.so` 从**包内**解析到 `libggml-base.so.0` |
| `whispercpp-cpu-linux-x64.tar.gz`    | 同 run，`packs-linux-x64-cpu`                                           | 22 个 ELF ≤ 2.34 + 探针 1 个 ≤ 2.34                                                                                                  |
| `whispercpp-cuda-linux-x64.tar.gz`   | 同 run，`packs-linux-x64-cuda`                                          | 23 个 ELF ≤ 2.34。⚠️ 但见下一行                                                                                                      |

⚠️ **Linux CUDA 那个包我不建议发**：`amd-vulkan` 查到的那条仍然成立 ——
`ggml-cuda` 动态链 `CUDA::cudart`，而打包只拷了 Windows 命名的 `cudart64_*.dll`，
Linux 侧一个都没拷。本轮 `ldd` 实测把它照出来了（`libcudart.so.12 => /usr/local/cuda/...`，
即**由构建环境提供**）。发出去就是"装了没用"。

**你要我补目录的话**：给我 release tag + 资产上传完成的确认，我十分钟内把
`backends.json` 那条补上（`ggmlAbi 0.15.1` / `backend vulkan` / `os linux` / `arch x64` /
`tier downloadable`，sha256 我会自己重下复算，不抄 CI 的 fragment）。
**在那之前我不抢跑** —— 现在补进去只是多一个装了没用的按钮。

---

# §4 需要你决策

1. **发不发 Linux 的三个包**（§3）。发的话请建 tag，我不建 release。
   建议只发 cpu + vulkan，CUDA 那条先留着（缺 cudart，装了没用）。
2. **`whispercpp-cpu-macos-arm64` 那条无理由的 `stableOnly: false`**（§2.4）——
   要不要补一段理由 / 或者顺手把我们自己的 release 从 prerelease 转正。
   我没动它，因为那不是我的调查范围。
3. **Windows / macOS 那五条腿本轮没跑**（我用 `legs=linux` 只跑了 Linux）。
   它们的 runner 标签没动（`windows-2025` / `macos-26`），但**没有实测**，标 `[未验证]`。
   要不要单独跑一轮 `legs=windows` / `legs=macos`。

---

# §5 我没做 / 做不到的（如实列）

| 项                                                       | 状态                                                                                                                                                                                                                                   |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows / macOS 腿在本轮的表现                           | ⏳ **未验证** —— 我只跑了 `legs=linux`。它们的定义我一个字没改                                                                                                                                                                         |
| 「Vulkan 后端在真 AMD 硬件上真的被用上了」               | ⛔ **本机与 CI 都验不了**。这台开发机是 KVM 虚拟机、没有任何真实 GPU（`/sys/class/drm`、`/dev/dri`、`/dev/kfd` 全不存在；`/runtime` 上那行 "Radeon 8060S" 是 **CPU 型号串**）。判据全程退到"产物的 GLIBC 下限"与"包自包含"这一可验证层 |
| Linux CUDA 包在没装 CUDA 的机器上能不能用                | 🔴 **不能**，见 §3 最后一行。本轮 `ldd` 把它照出来了，但这不是我的修复范围                                                                                                                                                             |
| BtbN win64 n8.1 的 PE 导入表                             | ⚠️ `UNKNOWN`（沿用 `amd-vulkan` 的标注，我没有下 167 MB 去 dump）                                                                                                                                                                      |
| jellyfin 何时把 8.x 转正                                 | ⚠️ `UNKNOWN`，查不到 roadmap                                                                                                                                                                                                           |
| `ubuntu:22.04` 之后怎么办（22.04 标准支持 2027-04 结束） | 未做。但**这次改动正是为了让那次迁移只改一行 `BASE_IMAGE`**，而不是再横跳一次 runner                                                                                                                                                   |

---

# §6 纪律申报

- **`:10000` 全程零请求**，未重启、未 kill、未占用该端口。
- **`/root/data-memo` 与 `~/.local/share/openmemo/datadir.json` 一个字节没读没写。**
- **没有建 / 改 / 删任何 release。** `gh` 只用了 `run list` / `run view` / `api …/logs`（只读）
  与 `workflow run`（dispatch）。
- **`apps/web/dist` 未被触碰** —— 全程只跑 `pnpm build:safe`，一次 `pnpm -r build` / `vite build` 都没跑。
- **没有 `pkill -f`；本机一次 whisper 转写都没跑。** 跑过的只有只读的 `objdump` / `curl` / `tar` /
  一次 33 MB 的 ffmpeg 下载（用于复算 sha256 与解析 Mach-O，没有执行那两个 Mach-O 二进制）。
- **反向验证全部在 `/tmp` 隔离副本**（PROTOCOL §10）：
  `rv-lint`（lint-workflows 5 条变异）· `rv-mf`（manifest 5 条变异，**先跑对照组**）·
  `rv-sigpipe`（管道吞红）· **`rv-ci`（独立 clone + 临时分支 `rv/t-163-no-buildbox`，
  用完 `git push --delete` 已删，远端只剩 `master`）**。共享工作树在整个过程中**没有被改成坏状态**。
- **`git add` 逐个文件**，三次提交都用 `git diff --cached --name-only` 核对过；
  别人的 30 个在途改动一个都没被 add 进来。
- 新加的 pin 过了「只许钉月末 tag」那道守卫：本轮**没有新增任何 BtbN pin**
  （macOS 走 jellyfin，`ffmpegPinRot.test.ts` 那条守卫只管 BtbN，实测仍绿）。
  新引入的外部引用只有两条，都不是可变引用：
  `cuda-keyring_1.1-1_all.deb`（带版本号的固定文件名，HTTP 200 实测）与
  `ubuntu:22.04`（理由见 §1.3，且有硬守卫兜底）。
- 派出的 subagent：**0 个**。

## SHARED-CHANGE（实际改动，与开头的申报对照）

| 文件                                                    | 归属                             | 我做了什么                                                              | 与申报的差异                                                                                                                                      |
| ------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vendor/manifests/{components,backends}.json`           | `pack-publish` / `catalog-truth` | 只改 `media-tools-macos-arm64` 一条                                     | 无                                                                                                                                                |
| `packages/shared/src/components.ts`                     | `model-mgmt`                     | **新增一个可选字段** `stableOnlyReason?: string` + 文档注释，零行为改动 | ⚠️ **超出开头的申报**：写的时候才发现，把理由塞进未声明的 JSON 字段是本仓 C2 那一族（"4 个未声明字段"），所以改成正式加一个可选字段。可选是刻意的 |
| `package.json`                                          | 公共                             | 一行：把 `selftest-buildbox.sh` 接进 `test:ci-scripts`                  | 无                                                                                                                                                |
| `apps/daemon/src/pipeline/ffmpegStableOnly.test.ts`     | **新文件（我的）**               | 刻意**不改** `amd-vulkan` 的 `ffmpegPinRot.test.ts`                     | 无                                                                                                                                                |
| `.github/workflows/build-backends.yml` · `scripts/ci/*` | 我的地盘                         | ①的主体                                                                 | 无                                                                                                                                                |

---

## [2026-08-07 06:40] T-163 ③ DONE + cold-start-audit 回执

# TL;DR

| 事                            | 结果                                                                                                                                                                                          |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vulkan 包补进目录             | ✅ `8cb3b35`。sha256 **我自己匿名重下复算**，没抄你的、也没抄 CI fragment                                                                                                                     |
| `backend.selection` 报 vulkan | ✅ **CI 上真的拿到了**（`cold-start-audit` run **31152458527**，linux-x64）：`选中 未选择（按 priority 挑） → 实际使用 whispercpp-vulkan-linux-x64（backend=vulkan）`，并且用它**真转写成功** |
| macOS ffmpeg 8.1.2            | ✅ **第一次在真 Mac 上跑起来了**（同一 run，macos-26），已把 manifest 里「未在 Mac 上运行过」那句订正                                                                                         |
| ⚠️ 那一 run 是 **failure**    | **不是我这轮引入的** —— 三个平台同一条 `meta.sameSource fail`，成因是 **T-149（`9ab2ada`）** 的桶迁移，已本机复现并定位到行。详见 §3                                                          |

---

# §1 复算与核对（按你说的，一个字没抄）

`[本机实测]` 匿名从 release URL 全量重下（`env -u GITHUB_TOKEN -u GH_TOKEN`）：

```
whispercpp-cpu-linux-x64.tar.gz      http=200  6,746,006 B
  3113d0d6443eb8293d0b68d992994ac5535575240d8c51b21cb5885408838154
whispercpp-vulkan-linux-x64.tar.gz   http=200  29,491,623 B
  62187d4a9610e2806a07fe0cd00cc27e68aaa7b026805c74e1896470e4ce9473
```

与你给的两个值**逐字符一致**。解开之后我又自己跑了一遍守卫：
`check-elf-glibc: 23 个 ELF，上限 GLIBC_2.34，实测最高 GLIBC_2.34`，
`providesFiles` 23 个含 `whisper-cli` 与 `libggml-vulkan.so`。

**第三次独立确认**：`cold-start-audit` 里产品自己的安装器又下了一遍并校验 sha256 —— 通过。

## 每个字段的来源（都不是拍的）

| 字段             | 值                    | 依据                                                                                                           |
| ---------------- | --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `priority`       | 80                    | `emit-pack-manifest.mjs:95` 的 `PRIORITY` 表（CI 自己那份），不是我挑的数                                      |
| `engineVersion`  | `v1.9.1`              | `git -C vendor/whisper.cpp describe --tags`                                                                    |
| `ggmlAbi`        | `0.15.1`              | 包里 `libggml.so.0.15.1` 的 soname                                                                             |
| `providesFiles`  | 23 条                 | 与 emit 脚本同一判据（只算真文件、basename、排序）                                                             |
| `requiresDriver` | `{"vulkanApi":"1.2"}` | **这个包自己的源码**：`ggml-vulkan.cpp:6528` `if (api_version < VK_API_VERSION_1_2) { "Vulkan 1.2 required" }` |

> `requiresDriver` 这条特意说明：`emit-pack-manifest.mjs` 的注释明确反对「照抄 llama.cpp 文档里的数字」，
> 并写着「真测出来了用 `--requires-driver` 传进来」。我填的不是抄来的，是从**要发出去的那份源码**里读的行号。

## ⚠️ 一处订正 `amd-vulkan` 回执

它写 `engineVersion: f049fff9（submodule 没有 tag 所以 git describe 回落到 sha）`。
`[实测]` submodule **就在 `v1.9.1` 这个 tag 上**，`git describe --tags` 返回 `v1.9.1`。
所以目录里这条与旁边的 `whispercpp-cpu-linux-x64` 版本号一致，不是一串 sha。

## 只补了 vulkan，**没有**动 `whispercpp-cpu-linux-x64`

你发了两个资产，我只接了一个，理由是它自己那条守卫：目录里 `whispercpp-cpu-linux-x64`
现在指向**上游** `whisper-bin-ubuntu-x64.tar.gz`。用我们自建的同 id 顶掉它，正是
ADR-015「上游预编译优先」与 `merge-backend-manifest` 那条「CI 产物不许顶掉有真下载地址的上游包」
要挡的形状（`selftest-ci-manifest` ④ 专门验这一条）。
**要换的话我需要你先拍板 ADR-015 这一格**，材料我有：我们那个 6.7 MB（上游 9.4 MB）、
14 个 CPU 变体、GLIBC 下限被守卫钉在 2.34；上游那个的 glibc 下限**我们从来没验过**。

---

# §2 `backend.selection` —— 两处证据，一处是你要的那条

## 2.1 ★ CI 冷启动实测（run 31152458527，linux-x64，全新数据目录）

```
目录共 23 个包，适用于本机 6 个：
  - whispercpp-cpu-linux-x64
  - whispercpp-vulkan-linux-x64          ← 新进目录的这个
  …
whispercpp-vulkan-linux-x64      succeeded  (1.0s)
whispercpp-vulkan-linux-x64      ✅ 真的在已安装列表里

backend.selection   ok   选中 未选择（按 priority 挑） → 实际使用 whispercpp-vulkan-linux-x64（backend=vulkan）
tool.whisperCli     ok   …/by-name/backend/whispercpp-vulkan-linux-x64/whisper-cli
```

并且**它真的干活了**：`POST /api/notes/import → 转写 job：succeeded (2.1s)`，
拿到非空文本（jfk.wav 那句 "And so, my fellow Americans…"）。

> **判据只到这一层**：这台 runner 上没有真 GPU。上面证明的是
> 「**选中并跑起来的是 vulkan 那个包的 whisper-cli**」，
> **不是**「GPU 真的被用上了」。ggml 在没有可用设备时会 `No devices found.` 退回 CPU 跑 ——
> 而正因为这个包是**自包含**的（自带全套 CPU 模块），退回来也不会更差。

## 2.2 本机定向验证：四种情形，用的是产品自己的那条链

`[本机实测]` 用**产品自己的** `install()` 把两个真包装进 `/tmp` 的临时 store
（`target.kind='backend'`，与 `apps/daemon/src/http/rest/backends.ts:194` 逐字同形），
再跑 `scripts/selfcheck.mjs --json` 读 `backend.selection`：

```
① 只装 CPU 包                          → 实际使用 whispercpp-cpu-linux-x64（backend=cpu）
② CPU + Vulkan，用户没选过（按 priority）→ 实际使用 whispercpp-vulkan-linux-x64（backend=vulkan）
③ 同上但 prefs 里显式选了 cpu           → 选中 cpu    → whispercpp-cpu-linux-x64
④ prefs 里显式选了 vulkan               → 选中 vulkan → whispercpp-vulkan-linux-x64
```

③ 那条是关键：**用户的明确选择压过 priority** —— 这正是 `pack-select` 规则 1 的语义，
而在 T-162 之前 `selectedBackend` 只驱动两个展示徽章。

## 2.3 ⚠️ 这台开发机上装不上（是闸门在正确工作，不是坏了）

`[本机实测]` 跑产品自己的 `evaluateApplicability`：

```
detectGpus.gpus      = []
advisoryCandidates   = []
whispercpp-cpu-linux-x64      applicable=true   tier=l1
whispercpp-vulkan-linux-x64   applicable=false  tier=l2  「尚未探测到硬件能力；请先安装 CPU 基础包…」
```

而 GitHub 的 runner 上 advisory 认出了候选，所以那边装得上。
**两边行为不同是对的**：L2 闸门要的就是"这台机器有没有相应硬件的证据"。
用户那台有 AMD 卡的机器落在 runner 那一格，不是这台 KVM 的这一格。

---

# §3 ⚠️ 那一 run 是 failure —— **先说清楚不是我这轮引入的**

三个平台**同一条**：

```
model.vad        warn   已装的 VAD 权重 whisper.cpp 一个都加载不了（已装：ggml-silero-v6.2.0.bin、silero_vad.onnx）→ 切分降级为固定窗口
meta.sameSource  fail   model.vad: 本地=warn 端点=ok
```

## 3.1 为什么可以肯定不是我的

**macOS 与 Windows 的目录里根本没有 Vulkan 包**（它只有 linux/x64 一条），
而它们**failure 的那一条一模一样**。这一条单独就足以定性。

## 3.2 成因（已本机复现，定位到行）

`[实测]` 对比两次审计里模型落盘的位置：

```
上一轮 run 31076010999（commit 1f49530）：by-name/asr/ggml-silero-v6.2.0.bin   → model.vad ok
本轮   run 31152458527（commit 8cb3b35）：by-name/vad/ggml-silero-v6.2.0.bin   → model.vad warn
```

桶变了。变它的是 **T-149 `9ab2ada`「一个 role 一个桶」** ——
`git show 1f49530:apps/daemon/src/http/rest/roleMap.ts` 里 `case 'vad': … return 'asr'`，
T-149 之后 `roleToStoreKind` 委托给 `bucketForRole`，于是 `bucketForRole('vad') === 'vad'`。

**而 `packages/pipeline/src/tools.ts:764-771` 那一侧没跟着改**：

```ts
const vadModel = overrides.vadModel ?? (await findInstalledModel(
    storeRoot, 'asr',                      // ← 仍然在 asr 桶里找
    ['ggml-silero-v6.2.0.bin', …], isGgmlModelFile));
```

`[本机实测]` 同一个 store、只改桶，其余一字不动：

```
装进 by-name/asr/  → discoverTools.vadModel = …/by-name/asr/ggml-silero-v6.2.0.bin
装进 by-name/vad/  → discoverTools.vadModel = null          ← 本轮 CI 上的那一格
```

**上一轮审计跑在 `1f49530`，那是 T-149 之前** —— 所以本轮是 T-149 之后的**第一次冷启动**，
也就是这条不一致第一次有机会显形。审计正是干这个的。

## 3.3 后果与建议（不是我的地盘，我没动）

后果：**离线转写的静音切分静默降级为固定窗口**，断句变差，而
「模型页显示已安装」「安装记录齐全」「sha256 全对」—— 全都是绿的。
本仓最贵的那类形状，又一格。

建议给接手的人（`pack-select` 正在这个文件里，或者 T-149 的原作者）：
`findInstalledModel` 该按 `bucketForRole(role)` 找，并**同时兼容 `asr` 老布局**
（T-149 之前装的用户，权重还躺在 `by-name/asr/`）。
判据现成：`meta.sameSource` 已经把这条抓出来了，修完它必须变绿。

⚠️ 顺带一条：`meta.sameSource` 说「本地=warn 端点=ok」——
**端点那一侧为什么是 ok，我没有查**。两个出口对同一件事给出不同答案本身是第二个问题，
标 `UNKNOWN` 交给接手的人。

---

# §4 顺带在 CI 上被证实的两条（都是本轮改动）

| 条                                               | 证据                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS ffmpeg 8.1.2-2 **第一次在真 Mac 上跑起来** | run 31152458527 / macos-26：下载 32,894,656 B → 安装器校验 sha256 → 走产品真实路径转写 jfk.wav **succeeded**，拿到非空文本。已把 `components.json` 里「未在 Mac 上运行过 —— 全部是静态分析」那句订正掉（那句在 8.1.2 落地前是对的，现在不是了）。⚠️ 仍未验证：低于 macOS 26 的系统（minos 声明 12.0，但 runner 是 26 ——「新系统上跑得起来」不构成「老系统上跑得起来」的证据，D-11 §3.4） |
| Linux ffmpeg 8.1.2                               | 三平台 `tool.ffmpeg ok`，路径含 `ffmpeg-n8.1.2-34-g9b6c8969e0-linux64-gpl-8.1`                                                                                                                                                                                                                                                                                                           |

---

# §5 顺带修掉一条**被我自己的改动弄失效的守卫**（这条值得单说）

`selftest-ci-manifest.mjs` 的夹具把 `whispercpp-vulkan-linux-x64` 当成"目录里还没有的包"。
我把它真的补进目录之后：

- ③「新包被加进来」**红了** —— 好，它在说真话（`packs.length + 1` 对不上，因为变成了 upsert）；
- ⑤「★反向：坏 fragment 必须失败」**静默变绿** —— merge 先按 ADR-015 认出"同 id 且上游有真 URL"
  就跳过了那个 fragment，**根本没走到 schema 校验**，于是 exit 0。
  **一条反向用例失去了它要验的东西，而它看起来完全正常。**

夹具改用 `UNRELEASED_PACK_ID`（`whispercpp-vulkan-linux-arm64`）并**断言它确实不在目录里** ——
哪天它也被发布了，这条前提会当场红，而不是又一次悄悄变味。

> 记一句给以后：**把一个东西"从假的变成真的"，会让所有拿它当假的的测试失去意义**，
> 而其中只有一部分会红。红的那部分是运气。

---

# §6 纪律申报（本段）

- **`:10000` 零请求**；未重启、未 kill、未占用。起过的服务只有 `install.mjs` 的本地文件操作（不监听端口）。
- **`/root/data-memo` 未读未写**；指针文件全程用 `OPENMEMO_POINTER_FILE` 指到 `/tmp/runner-migrate/sel/pointer.json`
  （**模块外显式指定，窗口为零**，PROTOCOL §9-bis），真指针 `~/.local/share/openmemo/datadir.json` 一个字节没碰。
- **没有建 / 改 / 删任何 release**。`gh` 只用了 `run list/view/download`、`api …/logs`（只读）与 `workflow run`。
- `apps/web/dist` 未被触碰（只跑 `pnpm build:safe` 与单包 `--filter` 构建）。
- **没有 `pkill -f`**；本机 whisper 转写**一次都没跑**（`--transcribe` 是 CI runner 上跑的，不是本机）。
- `git add` 逐个文件核对；别人的在途改动一个没带上。
- 反向验证与所有临时 store 全在 `/tmp/runner-migrate/`。

## SHARED-CHANGE（本段新增）

| 文件                                  | 归属                             | 我做了什么                                                          | 冲突风险 |
| ------------------------------------- | -------------------------------- | ------------------------------------------------------------------- | -------- |
| `vendor/manifests/backends.json`      | `pack-publish` / `catalog-truth` | 新增 `whispercpp-vulkan-linux-x64` 一条（66 行，纯新增）            | 低       |
| `vendor/manifests/components.json`    | 同上                             | 新增同 id 的来源条目；订正 macOS ffmpeg 那条的「未在 Mac 上运行过」 | 低       |
| `scripts/ci/selftest-ci-manifest.mjs` | 我的地盘                         | 夹具换 id + 补前提断言（见 §5）                                     | 低       |
