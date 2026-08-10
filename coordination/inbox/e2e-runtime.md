# e2e-runtime — 章程要求 2.1 / 2.2 的端到端 CI 腿

## [2026-08-08 17:55] e2e-runtime DONE

交付:

- `.github/workflows/e2e-runtime.yml`（新建，三平台 + 变异验证两个 job）
- `scripts/ci/e2e-runtime-audit.mjs`（新建，46 条具名断言 + 10 条变异）
- `scripts/ci/resolve-bundle-run.sh`（新建，取包判据的唯一一份）
- `apps/daemon/src/http/rest/state.ts`（修一个实测抓到的真缺陷，见下 ②）

提交: `42fbc41` → `8eb732a` → `037a6ef` → `f130abe` → `5df6679`（均已 push 到 origin/master）

**CI 实测**：`e2e-runtime` run **31250730491**（提交 `5df6679`，三平台 + 两个变异 job）

---

## 一、回报重点（Manager 点名要的四条）

### 1. 三个平台上「从网页装一个加速后端」到底能不能走完

**答案：三个平台都走不完 —— 装得上，但装完选不了。**

`[CI 实测 run 31250730491]`

| 平台        | 装加速包                              | 装完切过去（`POST /api/backends/select`）              |
| ----------- | ------------------------------------- | ------------------------------------------------------ |
| linux-x64   | ✅ `whispercpp-vulkan-linux-x64` 装上了 | ❌ **409 CONFLICT**「本机无法使用 vulkan：backend package not installed」 |
| darwin-arm64| ✅ `whispercpp-metal-macos-arm64` 装上了 | ❌ **409 CONFLICT**「本机无法使用 metal：backend package not installed」  |
| win32-x64   | ✅ `whispercpp-vulkan-win-x64` 装上了   | ❌ **409 CONFLICT**「本机无法使用 vulkan：backend package not installed」 |

**「backend package not installed」这句话此刻是假的** —— 包就是这一步刚装上的，
`/api/backends/installed` 里也确实有它。

成因与下面缺陷 ② 是**同一个**：`select` 那道闸门读 `state.hardware.backends[].installed`，
而 `RestState.hardware` 是 **daemon 启动时的快照**，装包不会刷新它。
于是 `installed` 恒为 false ⇒ `noVerdictYet` 为 false ⇒ 落进 409。

> **这是要求 2.1 主路径上的死胡同**：用户在网页上装完加速后端，
> 点"启用"得到一句"你没装这个包"。唯一的出路是重启 daemon，
> 而界面上没有任何东西告诉他这一点。

⚠️ 一条**此前的推断被 CI 证伪**了，记下来：我原以为托管 runner 上加速包
装不上（没有 GPU 硬件证据），所以这一格只能是 UNKNOWN。
**三个平台实际都装上了** —— advisory 探测在 GitHub runner 上确实看到了候选后端。
也就是说这一格不但验得了，而且验出了缺陷。

（真实 GPU 上「装完能不能真的跑起来加速」仍然是 UNKNOWN，托管 runner 给不出，
那需要 self-hosted。但**装 → 选**这一段与有没有真 GPU 无关，上面已经验到。）

### 2. `freedBytes` 是不是真的 —— **是真的**

`[本机实测]` 删 `vad/silero-vad-ggml`：

```
清单声明的体积      885098 B
事件里的 freedBytes 885098 B      ← model.removed（SSE）
实测磁盘减少        886355 B      ← 我自己 stat 整棵 models/ 树，前后各一次
差 1257 B = manifest + 索引文件（freedBytes 只统计 blob，不含它们）
```

`collectGarbage()` 是**逐个文件 stat 之后累加真实 size**，不是照清单抄。
判据写成「`freedBytes ≤ 实测` 且差 < 64 KB」，两半缺一半都能被糊弄：
只比上界会放过虚报，只比相等会因为无关日志写入随机变红。

⚠️ **`freedBytes` 只在 SSE 事件里**：`DELETE /api/models/:id` 回 204 无 body。
不订阅 `/api/events` 就根本看不到这个值 —— 界面若没订阅，用户看不到"释放了多少"。

⚠️ **本轮踩到一个自己的坑，值得记**：第一版把实测减少量算成了 `freedBytes` 的
**两倍**，把一个正确的值判成"编的"。成因是 `by-name/` 里是**硬链**，
我的 du 按路径求和、没按 inode 去重（`du(1)` 默认去重，所以手工核对时看不出差异）。
一个"地面真相"自己算错，比被测方算错更难发现。

### 3. 数据目录「搬」与「只切换」两条路 —— **都实测通过**

`[本机实测]`，全程走 `POST /api/settings/data-dir` + 产品自己的重启：

| 路径                              | 结果                                                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `moveExisting:true`（真搬）       | `moved:true strategy:rename files:6`；**源目录清空**；新位置有 openmemo.db；重启后 `health.dataDir` = 新路径 |
| `moveExisting:false`（只切换）    | `moved:false`；**源目录 openmemo.db 原样还在**；重启后 `health.dataDir` = 新路径                       |
| 字段缺席                          | 409 `NOT_A_DATA_DIR`，**一个字节没动**（缺省 = 不搬，T-174 的判据）                                    |
| 字段名写错（`movExisting`）       | 400 `UNKNOWN_FIELD`                                                                                    |
| `moveExisting:"false"`（字符串）  | 400 `BAD_MOVE_FLAG`                                                                                    |
| 试算 `dryRun`                     | `willMove` 随 flag 变（false→false, true→true）—— 复选框在传输层上真的存在了                          |
| 删掉数据目录后重启                | daemon 正常起来并**重建空库**（指针仍指向那里）                                                        |

「只切换不搬」的断言刻意写成「**源目录里 openmemo.db 还在**」而不是「条目数一样」：
daemon 干净关库会 checkpoint 掉 `-wal`/`-shm` 并删 `daemon.lock`，按条目数比会随机变红。

变异 `M-datadir-default-move`（把 T-174 的 bug 原样种回去）实测让
`A-DATADIR-DEFAULT-NOMOVE` 变红，输出是 `HTTP 202；源目录 openmemo.db 仍在=false`
—— **数据真的被搬走了**，护栏抓得住。

### 4. 发现的真实缺陷（三条，都有复现）

#### ① `active.json` 写 7 个 role、只读回 2 个 ⇒ 用户选的模型每次重启被静默清空 【已修】

`apps/daemon/src/http/rest/state.ts` `loadPersisted()` 原本只有：

```js
this.active.asr = typeof rec.asr === 'string' ? rec.asr : null;
this.active.llm = typeof rec.llm === 'string' ? rec.llm : null;
```

而 `persistActive()` 写的是 `JSON.stringify(this.active)` —— **全部 7 个 role**。
于是 vad / punctuation / diarization / embedding / tts 五个槽位读不回来。

`[本机实测]` 网页切 VAD → `active.json` 里确实写着它 → `POST /api/daemon/restart`
→ `GET /api/models/active` 回来 `vad: null`。文件没坏、零报错。
之后 pipeline 退回"任意已装记录（readdir 原序）"挑权重。

**这条正落在要求 2.2 的「切换」上，而产品装完组件后还会主动请用户重启** ——
也就是说这条路几乎必然被走到。

为什么能活这么久：`active` 声明处那句注释说得没错（初始化器漏 role 编译器会红），
但**这里是逐个属性赋值**，漏一个 role 类型完全合法。已改成按 `MODEL_ROLES` 遍历。
新增断言 `A-MODEL-SWITCH-PERSISTS` + 变异 `M-active-partial-load` 守着（实测变红）。

#### ② 刚装完 CPU 基础包，目录仍叫用户"请先安装 CPU 基础包" 【未修，报出来】

`[本机实测]` 装完 `whispercpp-cpu-linux-x64`、探针也跑通了（`ok:true devicesFound:1`），
此刻 `GET /api/backends/catalog` 对 vulkan 包给出的理由仍是
「尚未探测到硬件能力；**请先安装 CPU 基础包**，安装后会自动重新探测」。

成因：applicability 读 `RestState.hardware`，那是 **daemon 启动时的快照**；
装完包不会触发重新探测（全仓只有 `/api/backends/select` 会改写它，且只改
`selectedBackend`）。而运行时页问的就是这个端点。

用户可见后果：**他被要求去做一件他刚做完的事**，页面上也没有任何东西
告诉他"重启一下就好"。这是要求 2.1 主路径上的死胡同。
重启后理由会变（变成 "backend package not installed"），所以是"会话内不刷新"，不是"永远错"。

未修的理由：修它要动 `RestState.hardware` 的刷新时机，牵涉 install 完成回调与
`backendReconcile`，不是我这条 CI 腿该顺手改的范围。脚本每轮都会把它报成 finding。

#### ③ 全新安装时断路器因为"探针还没装"就跳闸 【未修，报出来】

`[本机实测]` 全新数据目录、一个后端包都没装，用户在运行时页点一下「重新检测」
（= 第二发探测）就够了：

```
verdict=open  consecutiveFailures=2
blacklistedBackends=[cuda, vulkan, rocm, metal, coreml]
lastError=probe executable not found: <data>/bin/runtime/openmemo-probe
```

探针随后端包出厂，冷启动时必然不存在；而 `recordProbeOutcome()` 把
"文件不存在"和"驱动挂死"记成同一类失败，阈值 2 次即跳闸。
用户第一次打开诊断页就看到「加速后端断路器」告警 + 5 个加速后端全标停用，
**而他什么都还没做错**。判据与 T-168 同族：**没测过 ≠ 坏了**。

缓解（实测）：装上任意后端包后 `backendDir` 会从 `<data>/bin/runtime` 变成包目录，
断路器按 backendDir 分片，那条坏记录被**遗弃**而不是被治好 —— 症状消失、成因还在。

---

## 一之二、三平台 CI 实测总表（run 31250730491）

| job                     | 结果                        |
| ----------------------- | --------------------------- |
| 端到端 linux-x64        | **PASS 49 / FAIL 1 / UNKNOWN 0** |
| 端到端 darwin-arm64     | PASS 43 / FAIL 1 / UNKNOWN 6 |
| 端到端 win32-x64        | PASS 44 / FAIL 2 / UNKNOWN 5 |
| 变异验证 linux-x64（9 条） | ✅ **全部被抓住**            |
| 变异验证 darwin-arm64（M-driver-lie） | ✅ **被抓住**   |

**红的只有两类，都是产品的**：

- `A-ACCEL-SWITCH`（三平台）→ 上面第 1 节那条死胡同。
- `A-DATADIR-MOVE`（**仅 Windows**）→ 见下面缺陷 ④。

**UNKNOWN 逐条有名有姓**（不是通过）：

- `A-BREAKER-*`（macOS / Windows，4 条）：注入故障后 `runtime.probe` **回的是 `null`**，
  观测不到"探测真的跑了并且失败了" ⇒ 前提不成立，跳没跳闸说明不了断路器的死活。
  **Linux 上这 4 条全绿**（跳闸 → `retryAt−blacklistedAt == 60000` → 冷却期零探测 →
  半开 → 计数清零，且指纹全程未变）。
  为什么 macOS/Windows 上 `runtime.probe` 是 null：**UNKNOWN，本轮没查出来**。
  它只在这两个平台、且在装/卸/重装那一串动作之后出现，本机复现不出来。
- `A-CPU-NO-DRIVER-LIE`（macOS）：构造不出「装了但这次没探它」的后端。
- `A-MODEL-RESUME`（macOS / Windows）：只在 Linux 腿开 `--resume-test`。

#### 缺陷 ④：Windows 上"移动数据目录"用 copy 策略，而且**源目录没清空** 【新发现】

`[CI 实测]` `moved:true strategy:copy files:54`，但**源目录仍在**
（`源已空=false`）。用户点了"移动"，结果是**数据被复制了一份**：
旧位置的空间没有被释放，而界面告诉他已经移动完成。
Linux / macOS 上是 `strategy:rename`，源目录清空，正常。

---

## 二、这条腿覆盖了什么（46 条具名断言）

全部走 HTTP，用**预编译包 + 包自带的 Node**，屏蔽宿主 PATH。

- **2.1**：硬件探测/推荐 → 装 → 探针可用 → 重启生效 → 卸载（含幂等 404）→ 重装 →
  装加速包 → 切换 → 切回 CPU → 乱填 backend 400
- **别退化 A**：显式选 CPU 时，`installed=true 且 probed=false` 的后端**措辞不许声称驱动故障**，
  目录也不许标 `unsupported`（T-168）
- **别退化 B**：断路器 **跳闸 → `retryAt−blacklistedAt == 60000` → 冷却期内一发不探 →
  半开 → 彻底复位**（T-173）
- **2.2**：浏览目录 → 下载 → 地面真相核对 → 磁盘占用 → sha256 校验失败 → 断点续传 →
  切换 → 切换扛得住重启 → 删正在用的被拒 → 删除 → `freedBytes` 与实测比对 → 占用下降
- **数据目录**：查看/逐目录统计 → 试算 → 信封四条 → 真搬 → 只切换不搬 → 删掉后重建
- **自检**：`GET /api/selfcheck` **逐项**贴出（27 项的 id/status/required/detail），不是只看总数
- **借宿主几个**：用产品自己的 selfcheck 分类报数

### 断点续传（实测通过）

`[本机实测]` 用 `media-tools-linux-x64`（119 MB）：下到 4239168 B 时走
`/api/daemon/shutdown` 打断（**不是 kill**）→ blobs/ 里留下
`sha256-….partial` + `.partial.json` → 重启 → 重新 pull → `succeeded`、装上、
sha256 由产品自己校验。打断不成功时**如实报未验证**，绝不把"没打断成"写成"续传通过"。

### sha256 校验失败（实测通过）

篡改 blob 里的**一个字节**（长度不变，只有哈希变）→ `POST /api/models/verify`
→ job `failed`，`CHECKSUM_MISMATCH`，带期望/实测两个哈希。

---

## 三、变异验证：10 条，**CI 上全部被抓住**

判据不是"断言写了"而是"断言有牙齿"。每条变异 = 把一个安全性质拿掉，
指定的断言**必须**变红。变异跑在**包的独立副本**（mkdtemp）上，原包不动（PROTOCOL §10）。

下表"结果"列是 **CI 实测**（run 31250730491）：Linux 跑 9 条、macOS 跑 `M-driver-lie`
（它的前提「一个加速包装着、而这次探测没加载它」只有 macOS 构造得出）。
两个变异 job **都是 success**，即**没有一条变异存活**。

| 变异                     | 证明的断言                  | 结果        |
| ------------------------ | --------------------------- | ----------- |
| M-datadir-default-move   | A-DATADIR-DEFAULT-NOMOVE    | ✔ 抓住      |
| M-datadir-loose-envelope | A-DATADIR-UNKNOWN-FIELD     | ✔ 抓住      |
| M-freedbytes-fake        | A-FREEDBYTES-REAL           | ✔ 抓住      |
| M-breaker-no-retryat     | A-BREAKER-RETRYAT           | ✔ 抓住      |
| M-breaker-permanent      | A-BREAKER-HEAL              | ✔ 抓住      |
| M-uninstall-noop         | A-UNINSTALL-GONE            | ✔ 抓住      |
| M-model-inuse-guard-off  | A-MODEL-DELETE-ACTIVE-REFUSED | ✔ 抓住    |
| M-active-partial-load    | A-MODEL-SWITCH-PERSISTS     | ✔ 抓住      |
| M-pointer-hardcoded      | A-POINTER-EXTERNAL          | ✔ 抓住（见下）|
| M-driver-lie             | A-CPU-NO-DRIVER-LIE         | ✔ 抓住（macOS 腿） |

### ★ 变异抓到了**我自己**的一条假绿灯

`M-pointer-hardcoded`（让 `pointerFile()` 忽略环境变量）第一轮**存活**了：
`A-POINTER-EXTERNAL` 原本只断言"指针路径落在临时根里"，
而本脚本的第 2 层防线（假 HOME）让**兜底路径也落在临时根里** ——
于是"覆盖生效"和"覆盖失效但被兜底接住"在断言眼里长得一模一样。

这正是 Manager 点名的第二种假绿灯：**断言的是"报出来的值"，不是"实际用的值"**。
已改成**逐字全等于我设的那个路径**，改完变异当场变红、干净跑仍然绿。
两层防线从此各自独立，谁也不替谁掩盖。

### ★ 另一条被自己的断言抓出来的：屏蔽从来没生效过

`A-NO-HOST-BORROW` 在本机红了，查下去是**我的 harness bug**：
`childEnv` 是模块级求值的，早于 `setUpMasking()` 把 shim 目录插进 PATH，
所以 daemon 拿到的一直是**没屏蔽的** PATH ——
日志一本正经打印「已屏蔽 7 个名字」，实际一次都没屏蔽。

**它在 GitHub 的 ubuntu runner 上永远不会显形**（那台机器本来就没有 ffmpeg，
屏没屏蔽输出一样）。是本机 `/usr/bin/ffmpeg` 真实存在才把它翻出来。
已改成 spawn 那一刻现算 PATH，并补了反向守卫 `A-MASK-EFFECTIVE`
（shim 必须真的被产品看见，否则就是屏蔽没生效）。

顺带修正了判据本身：屏蔽的设计意图是"让借用**可见**"，所以生效后产品**必然**
解析到 shim，「借用数 == 0」是个永远达不到、方向也不对的判据。拆成两句：
**红线**是"有没有解析到 shim 之外的真宿主路径"，**报数**是"几个落在 shim 上"
（= 不屏蔽的话产品会去借的就是这几个）。

---

## 四、PROTOCOL §9 / §9-bis 合规

真实机器指针 `~/.local/share/openmemo/datadir.json`（指向 `/root/data-memo`）
在本轮**全程未被触碰**，每一次运行前后都核对：

```
sha256=7f930979b85204d4c05b221f4c17a5cf5936a4d432a46488816727f60da233f3
mtime =2026-08-04 01:06:59.523602110 +0800   size=78
```

（含 `M-pointer-hardcoded` 那一发 —— 它**故意**让 daemon 去写"全局位置"，
而假 HOME 把它接到了临时根里。`scripts/mutation-check.mjs` 第一版正是栽在这条上。）

三层防线：① `OPENMEMO_POINTER_FILE` 重定向（模块级，窗口为零，不依赖任何 finally）；
② 子进程的 `HOME`/`XDG_DATA_HOME`/`APPDATA`/`USERPROFILE`/`LOCALAPPDATA` 全指向临时根，
所以**即便第 1 层被谁改坏，写下去的东西仍然落在 mkdtemp 里**；
③ 跑完核对 sha256+mtime（断言 `A-POINTER-UNTOUCHED`）。

全程**没有用过 `pkill`**：起停走产品自己的 `/api/daemon/restart` 与 `/api/daemon/shutdown`。
没碰 `:10000`、没碰 `/root/data-memo`、没建/改/删任何 release。
没动别人的在途文件（`main.ts` / `ws/recorder.ts` / `HardwareCard.tsx` / `package.json` /
`build-bundle.mjs` / `simulate-user-launch.mjs` / 另外三条 e2e 腿）。

---

## 五、门禁（在 worktree 检出自己那个 commit 上跑，避开别人的在途改动）

| 门禁              | 结果                                            |
| ----------------- | ----------------------------------------------- |
| `pnpm -r test`    | **1541 pass / 0 fail**（我没加测试，+33 来自我提交之前就在 HEAD 上的别人的提交） |
| `tsc -b`          | ✅ 0 错                                          |
| `eslint .`        | ✅ 0 错                                          |
| `build:safe`      | ✅                                               |
| `lint-workflows`  | ✅ 1113 条断言（13 个 workflow）                 |
| `test:ci-scripts` | ✅ 全绿                                          |
| `check:orphans`   | ✅ **70 / 基线 70**（没升）                      |
| `format:check`    | ✅ 我的文件全绿（跑了两遍到不动点）              |
| `check:sources`   | ✅ 96 个源码目录                                 |

⚠️ 仓库根 `prettier --check .` 此刻有 4 个 warn，全是**别人在途**的文件
（`packages/pipeline/src/index.ts`、`subprocess/__tests__/proxyCoverage.test.ts`、
`scripts/ci/proxy-coverage-audit.mjs` 等）。**我没有碰它们** —— 顺手格式化会把
别人没写完的东西带进我的提交。

⚠️ **worktree 门禁有个坑值得记**：第一次我把 `node_modules` 整个软链回主树，
于是 `@openmemo/*` 解析到了**主树里别人没提交的 packages/pipeline**，
`tsc -b` 报出 4 条根本不属于我这个 commit 的错。改成"三方依赖软链、
`@openmemo/*` 指向 worktree 自己的 packages"之后才是真的隔离。

---

## 六、CI 实测结果

- 第一次真跑 **run 31249523201：五个 job 全红，两个成因都不在产品上**，已修：
  - **抄了两份的 shell 只改了一份**：取包判据我在两个 job 里各写一遍，
    修「按 artifact 挑 run」时只改了前者 ⇒ mutations 腿继续按"最近一次成功"取件，
    而最近一次恰好是 `legs=macos` 的单腿 run ⇒ linux 变异 job 挂在 `Artifact not found`。
    → 提成 `scripts/ci/resolve-bundle-run.sh`，两个 job 调同一份。
    判据不是"记得两边一起改"，是**不可能只改一边**。
  - **macOS 的 bash 是 3.2，`$port）` 里那个全角括号会被算进变量名**：
    `line 12: port）: unbound variable`，两个 macOS job 都死在这。
    Linux 的 bash 5 完全正常，**本机也复现不出来** —— 只有真在 macOS runner 上跑才会显形。
    → 紧跟非 ASCII 的变量一律 `${port}`。
- 第二次 **run 31249873183**：又抓出三个成因，两个仍是我的
  （断路器拿了过期的探针路径；Windows 上 `.cmd` shim 挡不住只找 `.exe` 的
  `fromPath()` —— 那层屏蔽**从来没生效过**，而 runner 恰好也没装 ffmpeg，
  所以屏没屏蔽输出一模一样，是反向守卫 `A-MASK-EFFECTIVE` 把它逼出来的）；
  第三个是**包与脚本来自不同提交**（变异锚点在旧 artifact 里找不到）。
- 第三次 **run 31250206184**：改成对本次 checkout 组装的包跑之后，Linux 到了
  49/1；`M-driver-lie` 暴露出**这条变异改了等于没改**（替换的是拼接表达式的头一段，
  后半段又把值覆盖回去）。
- 第四次 **run 31250730491**（提交 `5df6679`）：**两个变异 job 全 success**，
  三条端到端腿的红只剩产品自己的两条。数据见第一之二节。

> 这两条正好印证用户那句话：**不在 CI 上真跑一遍，就不知道它到底能不能用。**
> 这两个缺陷都不是产品的，但它们会让这条腿在交付那天全红。

---

## 七、需要 Manager 决策

1. **缺陷 ②（目录不刷新）与 ③（冷启动断路器跳闸）要不要派人修？**
   两条都在要求 2.1 的主路径上、都有用户可见症状，但修它们要动
   `RestState.hardware` 的刷新时机与 `recordProbeOutcome()` 的失败分类，
   不在一条 CI 腿的职责范围内。我只报，没改。
2. **「Windows/Linux + 真实 GPU」这一格要不要 self-hosted runner？**
   目前它是 `UNKNOWN` 而不是绿 —— 托管 runner **结构上**给不出这个答案。
   在拿到之前，章程 §3 表格里 Windows CUDA / Linux Vulkan 那两格
   不应该被这条腿的绿灯背书。
3. **runner 版本**：任务书写的是 `macos-14`，我用的是 **`macos-26`** ——
   照抄 `cold-start-audit.yml` / `build-bundles.yml` 现用的那一组。
   darwin 包就是在 macos-26 上组装并做部署目标守卫的，换个 OS 版本验的不是同一件事。
   如果 Manager 要的就是 macos-14（验更低系统版本），那是**另一个问题**，
   应该单独加一格而不是替换。

下一步建议:

- 等 run 31249873183 出结果，把三平台的实际数字补进本回执与章程 §3。
- 缺陷 ① 已修并有变异守着；②③ 建议派一路专门处理。

---

## [2026-08-08 19:40] 三条裁定的修复 DONE

交付: `apps/daemon/src/http/rest/state.ts`、`backends.ts`、`models.ts`、`storage.ts`、
`apps/daemon/src/storage/move.ts`、`packages/runtime/src/probe/runProbe.ts`、
`scripts/ci/e2e-runtime-audit.mjs`，+3 个新测试文件。

提交: `b4957e4` → `8835880` → `5ec1c1c`（已 push）
**CI 实测 run 31252528894：五个 job 全绿**（此前四轮全红）。

| job                  | 结果                              |
| -------------------- | --------------------------------- |
| 端到端 linux-x64     | **PASS 49 / FAIL 0 / UNKNOWN 1**  |
| 端到端 win32-x64     | PASS 43 / FAIL 0 / UNKNOWN 6      |
| 端到端 darwin-arm64  | PASS 41 / FAIL 0 / UNKNOWN 7      |
| 变异验证 ×2          | ✅ 11 条变异全部被抓住            |

### ① 快照失效做成了什么形状：**从输入派生，不是靠人记得调**

`RestState.hardware` 保留为快照（探测要 spawn probe / nvidia-smi，不能每请求跑），
但**是否过期不再由人判断**，而是由一个廉价指纹决定：

```
machineFingerprint() = modelsRoot | prefs.selectedBackend | sorted(已装包 id)
```

只 readdir、不 spawn。`freshHardware()` 在指纹变了时才重探；
`handleBackendRoutes()` 入口与 `buildHardwareResponse()` 各调一次。

**为什么不是"在 install 后面补一次刷新"**：那是第 N 次修症状。

### 卸载 / 切换那几条路径**确实同病** —— 这是被实测确认的，不是推测

`hardwareSnapshot.test.ts` 逐条钉死（**都不调用任何 invalidate**）：

- 装一个包 → 快照必须失效 ✔
- **卸一个包 → 快照必须失效** ✔（"只在 install 后面补"漏掉的第一条）
- **切后端 → 快照必须失效** ✔（backendDir 单值，切了就该重探；漏掉的第二条）
- 重探后用户显式选过的后端不许被默认值盖掉 ✔
- 指纹没变时不重复探测 ✔
- `invalidateHardware()` 能强制失效（给指纹看不见的变化用，如断路器复位）✔

**守得住**：新增一个改变机器状态的动作时，只要它影响那三样之一，
**不写任何代码就已经被覆盖**；影响别的东西时，在这个文件里加一行
`hardwareSnapshotIsCurrent() === false` 就会当场把遗漏逼出来。

**修好的证据是措辞变了**（run 31250730491 → 31252071989 同一格）：

```
修前：409「本机无法使用 metal：backend package not installed」   ← 假话，包就是刚装的
修后：409「本机无法使用 metal：installed but enumerated no devices」← 测出来的真结论
```

⚠️ 顺带修掉我自己埋的一个坑：指纹初值留 `null` 会让第一个请求必然重探一遍
（白跑，且会冲掉调用方手里的 hardware —— `backendNotProbed.test.ts` 就是这么红的）。
改成在 `create()` 的 `reconcileBackends()` **之后**钉住。

### ② 断路器现在怎么分「还没装」和「装了但坏了」

判据落在 **`recordProbeOutcome()`**（唯一的记账点，交互探测与后台恢复探测都走它）：

- `missing_probe` / `missing_backend_dir` → **不计数**。这两种 `runProbe` 只做一次
  `existsSync`（微秒级、不 spawn、不碰驱动）= **什么都没测**。
- `timeout` / `crash` / `bad_output` / `exec_error` → 照旧计数、照旧跳闸。

计数**不清零**（卸包瞬间也会走到这里，清零等于抹掉一次真实的连续失败），
只更新 `lastError` 让"为什么没探到"仍然可见。

⚠️ **三个常量一个字未改**（`PROBE_TIMEOUT_MS` / `CIRCUIT_BREAKER_THRESHOLD` /
`BREAKER_COOLDOWN_MS`）——改的是"什么算一次失败"，不是"多久算超时""几次算坏"。
`breakerNotInstalled.test.ts` 7 条守着，其中两条专门钉**反方向**：
真故障必须照旧跳闸，这条修复不许把断路器整个关掉。

### ③ Windows 那条：我选了「如实说」

**没有**改成"让 Windows 也用 rename"（跨卷 rename 本来就会失败，copy 是必要退路）。

- `MoveResult` 新增结构化字段 **`sourceRemoved`**（不让调用方去正则匹配 `warningZh`）；
- 文案提成纯函数 `moveMessageZh()` 并按它分叉：源没删掉时**不出现"已移动"**，
  改说「已复制…并逐文件校验通过；⚠️ 旧目录 <path> 没能删掉，仍留在原地
  （其中包含 secrets.json），请自行确认后删除」；
- 顺带修掉 `sourceIntact` 在删源失败时恒为 `false` 的反话。

**删源前的完整性校验**：沿用既有的 `verifyTreesMatch()` —— 比的是
**路径集合 + 每个普通文件的字节数 + 每条符号链接的 readlink 目标**，
不是"看目录存不存在"。校验不过就删掉刚复制的那份、源一个字节不动；
过了才删源，且删源在 try **之外**（删到一半失败不许触发回滚把唯一完整的一份删掉）。

`moveTruthfulness.test.ts` 5 条守着，核心一条是「`sourceRemoved:false` ⇒
文案里不许出现"已移动"」，并要求点名 `secrets.json`
（"有个目录没删掉"听起来像洁癖问题，"里面有你的 API Key"才会让人真去处理）。

### 那三条红现在还剩几条：**0 条**

三平台全部 FAIL 0。剩下的都是 UNKNOWN，逐条有名有姓：

- `A-ACCEL-SWITCH`（三平台）：托管 runner 没有真 GPU，探针**如实**枚举不到设备，
  409 是真话。**已改成分清「拒绝」与「用假理由拒绝」**：包确实装着却被告知"没装"
  才是红；测出来的真结论是 UNKNOWN。**真 GPU 上能否切过去仍是 UNKNOWN。**
- `A-BREAKER-*`（macOS/Windows 4 条）：注入故障后 `runtime.probe` 回 `null`，
  观测不到"探测真的跑了并且失败了" ⇒ 前提不成立。**Linux 上这几条全绿**
  （跳闸 → retryAt−blacklistedAt==60000 → 冷却期零探测 → 半开 → 计数清零，指纹全程未变）。
  `runtime.probe=null` 的成因**仍然 UNKNOWN**，本轮没查出来，不硬编解释。
- `A-MODEL-RESUME`（macOS/Windows）：只在 Linux 腿开 `--resume-test`。
  Linux 上实测通过（打断留下 2 个 .partial → 重启 → 续上 → succeeded）。
  ⚠️ 上一轮（31252071989）这条在 Linux 上红过一次（`打断后重新下载 → failed`），
  本轮绿。**两次之间没改过续传相关代码，所以它可能是不稳定的**，`[未验证]` 是哪一种。

### 我这条腿按 §11 补了什么

- **起服务前先证明端口是空的**（`A-PORT-FREE`）：不空**当场判失败**并打印占用者
  自称的 pid/dataDir/version，不再继续跑下去拿一个追溯不到来源的绿；
- **收尾按 pid 收整棵进程树**（`killTree`，Windows 走 `taskkill /T /F`）：
  daemon 起不来、HTTP 关不掉两条路径都收；**没有用 `pkill -f`**；
- **所有 fetch 带超时**（health 3–5s、业务 120s）；
- 「跳过」一律渲染成 UNKNOWN，从来不是 PASS（本来就是这么做的）。

### 与其它腿的边界

F3 那一路动的是 `main.ts` + 模型槽；我这轮碰的是
`http/rest/{state,backends,models,storage}.ts`、`storage/move.ts`、
`probe/runProbe.ts` —— **没有交集**，`git status` 全程只有我自己的文件。

⚠️ 一次操作事故，已完全恢复、如实记下：我 `git commit --amend` 时 HEAD 已经被
另一路推进了一格，于是**我把别人的提交改写了**（`0853b8e` → 本地 `571861b`）。
发现后 `git diff` 确认只多了我那一个文件、他们的内容一个字未动，
`git reset --soft 0853b8e` 复位，再把我的改动作为独立提交推上去。
origin 上他们的提交始终是原样。**教训：多路并行时 `--amend` 前必须先看 HEAD 是不是自己的。**

### 门禁（worktree 检出 `8835880` 跑，避开别人的在途改动）

`pnpm -r test` **1577 pass / 0 fail**（基线 1558 + 我新增 19 条）、`tsc -b`、
`eslint`、`format:check`、`check:orphans` **70/70**、`lint-workflows` 1147、
`test:ci-scripts`、`check:sources`、`check:version` 全绿。

真实机器指针全程未变：`sha256=7f930979…`，`mtime=2026-08-04 01:06:59`。

---

## [2026-08-09 04:40] 0.4.0 那批包上三平台全红 —— 判定为**断言过期**，已修，凭证已发

提交 `29415a6`（判据修正 + 两条变异）、`32358e3`（其中一条变异改了等于没改，返工）。

### 结论先给

**三平台红在同一条断言上，判定：断言过期，不是产品回归。**
重跑后（`31273755455`）**六个作业全绿**，凭证 artifact
**`e2e-attest-runtime-31268366005`（377 B，未过期）已产出**。

### 三平台各自红在哪条 —— 三条是同一条

`[CI 实测 run 31272189218]`

| 平台         | 结果                    | 失败断言                                                                             |
| ------------ | ----------------------- | ------------------------------------------------------------------------------------ |
| linux-x64    | PASS 48 / FAIL 1 / UNKNOWN 1 | `A-NO-HOST-BORROW-REAL`：屏蔽被绕过 → `…/extracted/openmemo-0.4.0-linux-x64/runtime/probe/whisper-va…` |
| win32-x64    | PASS 42 / FAIL 1 / UNKNOWN 6 | 同一条，路径 `D:\a\…\openmemo-0.4.0-win-x64\runtime\probe\whisper-va…`                |
| darwin-arm64 | PASS 40 / FAIL 1 / UNKNOWN 7 | 同一条，路径 `/Users/runner/…/openmemo-0.4.0-darwin-arm64/runti…`                     |

**三平台只有这一条红，其余全过** —— 包括断路器那组（linux 上 UNKNOWN 只剩 1 条，
就是需要真 GPU 的 `A-ACCEL-SWITCH`）。这本身就是"不是包坏了"的第一个信号。

### 逐条判定：过期 / 回归

**判定：过期。依据是那个路径在包里面，而且我本机核过它是产品自己放进去的。**

- 报出来的路径是 `<解压出来的包>/runtime/probe/whisper-vad-speech-segments`；
- `[本机核实]` `scripts/build-bundle.mjs:855-861` **明写**把
  `whisper-vad-speech-segments` 与 `whisper-cli` 塞进 `runtime/probe/`，
  注释里的理由是「**为了不长出第二份 ggml**」（与探针共用）；`:912` 与 `:1015` 也印证同一目录。
  —— **我没有只信 CI 日志**（那份日志此刻已经取不到了，我是在提交里核的）。

**为什么它以前是对的**：原判据是「selfcheck 归到 `warn`(来自 PATH) 且路径不在 shim 目录
⇒ 借了宿主的」。在**包里一个工具都不带**的世界里，storeRoot 之外的路径必然来自宿主机器。
你说的第 3 条改动（CPU 基线转写链随包出厂）把这个前提拿掉了。

**排除回归的另一半**：我也按你说的查了"包内探针与显式选 cpu 打架"这条 ——
`A-CPU-NO-DRIVER-LIE` 没红，`A-ACCEL-*` 的行为与上一轮一致，
三平台失败断言**只有这一条**。没有证据指向回归。

### 判据改成什么（守的东西一个字没松）

真正的"借宿主" = 解析到的路径**既不在 shim 里、也不在包里**
（storeRoot 里的 selfcheck 本来就归 `ok`，进不到 `borrowed`）。
**产品去够宿主机器上的东西，仍然当场红。**
`A-MASK-EFFECTIVE` 的"产品自己装齐"一并算上包内那份，否则它会在同一处误红。
按 §13 在注释里写清了**此前预期什么、被哪次改动改变**，没有静悄悄改数字。

顺带在输出里新增一行 `ⓘ 包自己带的工具 N 个（**不算借宿主**）` 并列出来 ——
这个区分以后要一眼看得见，而不是藏在判据里。

### 变异债：还了两条，其中一条返工

你点名的那笔债（这两条断言至今没有变异证明）：

| 变异                       | 证明的断言                | 结果                       |
| -------------------------- | ------------------------- | -------------------------- |
| `M-path-never-consulted`   | `A-MASK-EFFECTIVE`        | ✔ 一次就被抓住             |
| `M-mask-bypassed`          | `A-NO-HOST-BORROW-REAL`   | ⚠️ **第一版存活**，返工后 ✔ |

⚠️ **`M-mask-bypassed` 第一版改了等于没改**：它让 `fromPath()` 返回
`/usr/local/host-only/<name>` —— **那个路径不存在**，多半在后续装配里被当作
"工具不可用"丢掉，压根没进 `borrowed` 分类，断言自然是绿的。
`[CI 实测 run 31273191033]` 当场报**变异存活**。
按本仓自己立过的判据（**改了等于没改的变异比没有变异更糟**）返工：
改成返回 `/bin/sh` —— POSIX runner 上必然存在、可执行，且既不在 shim 也不在包里。
重跑后被抓住。

**13 条变异的锚点我在包上逐条核过**：全部唯一命中且变异后语法通过
（这一步是为了不再用一个坏掉的变异作业去挡发布）。

### 重跑结果 —— 凭证发出来了

`run 31273755455`（`bundleSource=artifact`, `bundlesRunId=31268366005`）：

```
✔ 要求 2.1/2.2 端到端（linux-x64 / win32-x64 / darwin-arm64）
✔ 变异验证（linux-x64 / darwin-arm64）
✔ e2e 凭证（仅 artifact 模式，三平台全绿才发）
```

artifact 实测：**`e2e-attest-runtime-31268366005`  377 B  expired=false** ✅

（中间那次 `31273191033` 三条端到端已经全绿、凭证也发了，只是变异作业红；
`31273755455` 是把变异那条也修绿之后的确认跑。）

### 诚实标记

- `[本机核实]`：`build-bundle.mjs` 确实把那两个二进制放进 `runtime/probe/`。
- `[报告]`：三平台失败断言原文取自我第一次查询时抓到的输出；**该 run 的日志此刻已取不到**
  （`gh api .../logs` 与 `gh run view --log-failed` 都返回空），所以行内路径是截断的原文。
- `UNKNOWN`：无。
- 未碰 `:10000` / `/root/data-memo` / 机器级指针；未用 `pkill`；未建改删 release。

---

## 2026-08-09 · B6b 终于真的跑了一次（不是空过）

**先回答那个问题：这一轮 B6b 真执行了。** `[CI 实测 run 31318703812, win32-x64]`
读到 **146 条**任务 Toast 标题，全是 `正在准备 · Whisper 大模型 v2（Q8_0 量化）`，
**不含「安装」二字 ⇒ 真通过**。同一次运行的 linux/darwin 两腿报 **UNDECIDED**
（`整轮没采样到 downloading 阶段`）—— 空过与真过现在分得开了。

### 它此前为什么连着两轮"绿"

1. **前件为空**：门禁装 5.3 MB 小包，三平台都来不及出现「下载中」；
2. **选择器抓错**：`[data-testid="job-toaster"], [role="status"]` —— 这一页
   `[role="status"]` 不止一个，文档序第一个是**就绪横幅**，`querySelector` 取第一个。

两次都记成 PASS。所以这条判据**从来没有被真的验过一次**，却一直显示通过。

### 改了什么

- 选择器钉到 `job-toaster` > `job-toast-<jobId>` > 第一个 `<p>`（`titleFor()`）；
- 脚手架加**第三档 UNDECIDED**（此前只有 PASS/FAIL，"没采到"只能 `return` 一句话，
  仍记成 PASS）。不计入 `failed`（采不到常是平台差异），但**单独计数、汇总单独列**；
- B6b 元断言：`downloadingMoments === 0` **或**一条标题都没读到 → UNDECIDED。
  第二条是关键：**选择器再抓错也只会亮"无从判断"，不会伪装成通过**；
- B6c 那句 `return '……无从判断'` 同步改走 UNDECIDED；
- 借 D1 的大文件窗口喂 B6b（门禁不填 `diagnoseDownload` 时一行不执行）。

### 中途抓到的真原因（值得记）

`run 31317995697` 里 downloading 采到 **127** 轮、标题仍然 **0 条** —— 不是选择器，
是**顺序**：`JobToaster` 的列表是 SSE 喂出来的 React state，`page.goto` 整页导航会把
它连同 SPA 一起重挂；任务在导航**之前**发起，`job.created` 早过去了，Toast 层永远空。
先落页再 POST 就有了。

> **附带产品观察（只记不改）：任务进行中刷新页面，Toast 就不再出现**
> （任务中心里还在，Toast 层空）。对转瞬即逝的通知也许可接受，但这是真实行为差异。

### 另外两问的答案

- **ETA 不是产品缺口，是我的正则错了。** 界面根本不写「剩余」/「ETA」；
  `lib/format/time.ts:70 approxEta()` 出的是「不到 1 分钟 / 约 N 分钟 / 约 N 小时」，
  由 `JobToaster.tsx:369`、`JobList.tsx:100`、`NoteProgressLine.tsx:68` 以 ` · ${eta}` 拼行尾。
  按实际文案改写后：`run 31318703812` **ETA=true（在变）**。上一轮报的"0 个不同值"是我的锅。
- **`unpacking-percent-frozen` 只适用于「带压缩包的安装」。** 后端包必经解压；
  模型看清单 `files[].unpack`，`asr/whisper-large-v2-q8_0` 是单个 `.bin`、无 `unpack`
  ⇒ **这条模型路径压根没有解压阶段**。这就是 D1 阶段序列里没有「正在解压」的原因 ——
  不是没推事件。适用范围已写进登记项。

### 不是我的那条

`B11 移动失败时界面必须说话`：**只在填了 `diagnoseDownload` 的两次运行里红**
（`31317995697`/`31318703812`），无诊断的门禁 `31316142174` 三平台全绿。
失败文本是真的像缺陷（`端点回了 404 FOLDER_NOT_FOUND，而界面一个字都没说`），
但它对时序敏感、且**不在门禁路径上**。**没动它。**

---

## 2026-08-10 · 第 3 环「还能下载更多模型」·在 :10000 上走真实用户路径

**先回答两句话。**

**① 大模型下下来之后，真的转出非空文本了。** `[用户可达 · 本机实测]`
`asr/whisper-large-v3-turbo-f16`（1,624,555,275 B）经**网页上的量化档选择器 + 「Download 1.6 GB」按钮**装上，
`activate` 到 asr 槽后上传 `jfk.wav`（11 秒真人英语），9 秒转完，转出：

> 「And so, my fellow Americans, ask not what your country can do for you, ask what you can do for your country.」

判据是**文本**不是状态：`segments=1`、108 字符、`transcript.modelId=ggml-large-v3-turbo.bin`、`engineId=whisper.cpp`。

**② 有一处在说假话——准确说是"该说话时全程沉默"：**
**只要点开过量化选择器，这一次下载就不会有任何任务 Toast。**（详见下面的对照组。）
其余部分没抓到谎话：百分比/字节/速度/ETA 全程在动，阶段文案没倒退，没漏 ASCII 枚举值。

### 走的是哪条路（不许手塞文件）

`/models?tab=asr` → `model-card-asr/whisper-large-v3-turbo` → 点 `models-quant-selector`
（**它不是 `<select>`，是 popover listbox**）→ 选单里三档实测：
`Q5_0 574 MB / 1.4 GB`、`Q8_0 874 MB / 1.7 GB`、`F16 1.6 GB / 2.4 GB`，右列适配语「Runs, but slowly」
→ 点 F16 → 按钮文案从「Download 574 MB」变成「**Download 1.6 GB**」→ 点它。
**换档真的生效**（按钮金额跟着变，最终装的确实是 f16）。

### 界面上那几个数：动了

`[本机实测 · 247 秒 · 945 个采样点]` 不同值个数：**百分比 92 · 字节 219 · 速度 39 · ETA 9**。
ETA 文案是 `about 4 min → about 2 min → about 1 min`，**在变**。
（对照：`asr/whisper-small-f16` 488 MB 那轮 61/157/34/4；`medium-q5_0` 539 MB 那轮 70/162/34/3。）

### ★ 缺陷：点开过量化选择器 ⇒ 整轮没有任务 Toast（**只报不改**）

五轮对照，**完全可复现**：

| # | 模型 / 体积 | 有没有碰量化选择器 | 任务 Toast |
|---|---|---|---|
| 1 | turbo-q5_0 574 MB | **没碰**（默认档） | **有** |
| 2 | turbo-f16 1.6 GB | 点开 + 选 F16 | **一条都没有** |
| 3 | small-f16 488 MB | 点开 + 选 F16 | **一条都没有** |
| 4 | tiny-q5_1 32 MB | **没碰**（默认档） | **有** |
| 5 | medium-q5_0 539 MB | 点开 + **选原本就选中的那一档** | **一条都没有** |

第 5 轮是关键：**选的还是原来那一档**，Toast 照样消失 ⇒ 触发条件是
「**点开过那个选择器**」，**不是**「选了非默认档」。给下一个人省一次二分。

- 有 Toast 时它是对的：标题 `Downloading model · …` / `Preparing · …`，阶段行
  `Working · 0 B / 32 MB` → `Choosing a download source · …` → `Downloading · 22 MB / 32 MB · 3.7 MB/s · less than a minute`。
- 没 Toast 时**不是全黑**：模型卡上的进度照常走，`/api/jobs` 里 `kind=model state=running step=downloading` 也在。
  丢的是**那一层浮层反馈**。
- ⚠️ 影响面正好打在 2.2 上：**认真挑量化档的用户 = 最需要反馈的用户**，恰恰一条 Toast 都收不到。

### 切回小模型：**确认真的生效**（不是只有标记变）

`activate(base-q5_1)` → `/api/health` 的 `pipeline.modelPath` 从
`ggml-large-v3-turbo.bin` 变回 `ggml-base-q5_1.bin` → **再传一次同一段音频**：
`transcript.modelId=ggml-base-q5_1.bin`、107 字符、2 秒转完（大模型那次 9 秒）。
两次权重文件不同 ⇒ **切换对下一次转写真的起作用**。
（顺带一个质量差的旁证：large 断出「And so, my fellow Americans」有逗号，base 没有。）
daemon 环境里**没有** `OPENMEMO_ASR_MODEL`，不存在"被环境变量静默压过"。

### 第 5 环 runtime 探测：**没跟上，但这次不该跟**

装完 1.6 GB 模型前后 `/api/runtime/hardware` **逐字段相同**：
`detectedAt` 都是 `04:09:34.719Z`、`selectedBackend=cpu`、`installedBackends=['cpu']`、
`probe.ran=true ok=true`、breaker `closed / consecutiveFailures=0 / fingerprint=6be652b896c4852b`。
查了两个 commit：`7986be9` 的指纹按**后端包内容**算、`d14b14e` 的「更新」按钮在
**BackendPackCard**（后端包）上 —— 两者管的都是**后端包**，装模型本来就不该动它们。
⇒ 这次的"没变"是对的，不是漏。**但也就意味着这两条改动这次并没有被验到** `[未验证]`。
真要验必须走**后端包安装/升级**那条路（而且 `BackendPackCard.tsx` 眼下有别人在改）。

### 另外两条观察（都只报）

- **中英混排**：界面是英文（`Download 1.6 GB` / `Downloading` / `less than a minute`），
  模型名却是中文（`Whisper 超小模型（Q5_1 量化）`）。Toast 标题因此长成
  `Downloading model · Whisper 超小模型（Q5_1 量化）`。**`[未验证]` 是不是只在
  navigator.language=en 的无头浏览器里这样**——真人浏览器可能是中文，形状会不同。
- `GET /api/jobs` 里模型任务的 `name` 与 `createdAt` 都是 `null`（mindmap 任务有）。
  Toast 的名字是 SSE `job.created` 带的，**REST 这一路没有** —— 刷新页面后任务中心
  拿不到名字。与我 8-09 记的「进行中刷新 ⇒ Toast 不再出现」是同一族问题。

### 我动了什么 / 没动什么

- **只走产品 HTTP 路**；没手塞文件、没碰 `/root/data-memo` 里已有的东西、没停任何进程。
- 新增：5 个模型（共约 3.2 GB，**按要求没删**）+ 2 条取证笔记（`第3环取证 大模型/小模型`）。
- **活动模型已还原成 `asr/whisper-base-q5_1`**，`/api/health` `ready=true`。
- 磁盘：**9.3 GB 可用**（81%）。
- 那 298 MB「无法识别的残留」**一个字节都没动**。

---

## 2026-08-10 · 第 5 环「runtime 探测完成」·在 :10000 上真升了一次后端包

**先回答两句话。**

**① 同 id 换内容，"变了"这件事**产品现在**真的能发现**——但我要把话说准：
能发现它的是 **`updateAvailable`（按 `files[].sha256` 集合比，`backends.ts:395-413`）**，
`[用户可达 · 本机实测]` 它让「更新」按钮**出现→点完消失**。
而 `7986be9` 那个 `machineFingerprint()` 的**值本身 HTTP 上不可见**，
我没法引一个"变前/变后"的数 ⇒ **指纹值 `[未验证]`**，它要保障的行为 `[用户可达]`。
另一个同名不同物的 `driverFingerprint`（断路器用）**没变**（`6be652b896c4852b`），
**这是对的**：它 hash 的是 whisper 后端目录的探针+库，我升的是 ffmpeg。

**② 「更新」按钮出现了，点了也真的成功了。** `[用户可达 · 本机实测]`
`media-tools-linux-x64`：装的是 ffmpeg `n7.1.5-12-g1fdbca85aa`(sha `47b2cc48…`)，
目录里是 `n8.1.2-34-g9b6c8969e0`(sha `8c8b2897…`) —— **现成的"同 id 不同内容"，不用伪造**。
点 `backend-update-media-tools-linux-x64`「Update」→ 安装记录变成 `n8.1.2`、`integrity ok`、
**按钮消失**（卡片只剩 Uninstall）→ `selfcheck` 的 `tool.ffmpeg` 指向
`…/ffmpeg-n8.1.2-…/bin/ffmpeg` ⇒ **真正在用的二进制也换了**，不是只改了记录。

### ★ 但第 3 条没成立：**装完探测并没有自动跟上**（`[用户可达]` 复现两次）

- 升 112 MB 的 media-tools 全程：`/api/runtime/hardware` 的 `detectedAt` **纹丝不动**（`05:10:28`）；
- 又重装了一次 61 KB 的 `sqlite-vec-linux-x64`：**还是不动**（`05:21:45`）；
- 我手工发一次 `?refresh=1`，它才动，且**一动就露馅**——被缓存住的那份里：
  `detectedAt`、**磁盘可用空间**（刚下完 112 MB，数就该变）、内存、探针耗时**全是旧的**。

⇒ **`?refresh=1` 这条并没有自愈**，原因是结构性的，值得写死在这儿：

> **产品里有两份互相独立的硬件快照，各有各的失效规则，`7986be9` 只修了其中一份。**
> · `state.ts` 的快照：受 `machineFingerprint()` 把关（hash 已装 manifest 的 JSON），
>   服务 `/api/backends/*` 与模型目录的适配判断 —— **这份被修好了**；
> · `hardware.ts:181-193` 的 `cached`：**只认 `?refresh=1`**，服务 `/runtime` 那张硬件卡。
>   而全站唯一发 `refresh=1` 的地方是 `useHardwareRefresh()`，
>   只被 `BreakerNotice` 在**断路器 open→closed 那一瞬**调用。
> ⇒ 只要断路器不跳，那张卡上的「Probed at …」「9.0 GB free of 53 GB」
>   **可以停留在 daemon 启动后的第一次探测上，任意久**。

**没顺手改。** 修法方向（不由本腿定）：装/升/卸后端包之后一并作废 `hardware.ts` 那份 `cached`，
或让它也走 `machineFingerprint()` 那道闸 —— 两份快照两套规则本身才是根因。

### ff24098「重装即自删」：**修好了**（`[用户可达]`，两次独立证据）

这一轮做的正是"重装同一个 id"：
- media-tools 升级后：文件在、`integrity ok`、新解包目录 `13:17` 建好；
- sqlite-vec 重装后：`vec0.so` **在**（`13:24` 重新解出，159,816 B），
  且 `selfcheck` 的 `ext.sqliteVec` 仍是 `v0.1.9` **可加载** ——
  不只是"文件在那儿"，是**真的还能用**。

### 界面全程说的话（沿用那套判据）

Toast **有**（这次没碰量化选择器）：标题 `Preparing · ffmpeg / ffprobe（Linux x64）`。
字节 `47 MB / 112 MB → 76 MB / 112 MB`、速度 `6.3 → 4.8 MB/s`、ETA `about 3 min`——**在动**。
`selfcheck` 25 ok / 2 warn / 0 fail（两条 warn 是"没装 VAD 模型"和"没装 Ollama"，都属实）。
⚠️ 后端包这条路上**没有百分比**（整轮 `pct=null`，只有字节/速度/ETA）；模型那条路上有。`[未验证]` 是否有意为之。

### ★ 另一处在说假话（只报不改）

**已安装卡片显示的是"目录里的版本"，不是"你装的那个版本"。**
升级**前**卡片原文：`Installed · ffmpeg n8.1.2-34-g9b6c8969e0 · 112 MB`，
而那台机器上装的是 **n7.1.5**（113 MB）。用户看不出自己落后了，
**唯一的线索是那颗「更新」按钮存在**。⇒ 「Installed」+ 新版本号连读就是一句假话。

### 顺带一条（磁盘）

升级**不回收**上一版：`ffmpeg-n7.1.5-…tar.xz/` 解包目录仍在，
加上更早的 `media-tools-linux-x64/{ffmpeg,ffprobe}`（各 139 MB，`Aug 2`，**已不被使用**）
一共约 279 MB 死重。现在 **9.0 GB 可用**。

### 我动了什么

- 只走产品的路：**点网页上的「更新」** + `POST /api/backends/install {id}`（sqlite-vec 那次）。
- 没手塞文件、没改活动模型（仍是 `asr/whisper-base-q5_1`）、没停进程；pid **491899 全程没变**。
- 那 298 MB「无法识别的残留」没动。
- 我自己发过**一次** `?refresh=1`（取证需要），**这是我发的，不是网页发的** —— 别把它读成"网页会刷"。

---

## 2026-08-10 · 「不知道」被当成失败 —— 同一个混淆的另一个方向

**先回答两句话。**

**① `B6` 降级之后，darwin 那条腿上 B6 本身是绿的 —— 而且不是靠降级绿的。**
`[CI 实测 run 31364427061, darwin-arm64]`：`B6 采样：共 2 轮，其中 2 轮界面上有进度指示`，
抓到了「正在选择下载源」⇒ **PASS**。这一轮采样窗口够，降级那条根本没触发。
⚠️ 但那条腿**整体仍然红**，红在**另一条**断言上（见文末），不是 B6。

**② 变异 harness 现在按退出码分三档，并且已在真 CI 上跑出来了。**
`[CI 实测 run 31365414371, darwin-arm64, artifact 模式]`：
```
##[warning] 目标断言在本 runner 上全是 UNKNOWN（前提构造不出来），
            这条变异这次什么都没证明 —— 既没被抓住，也不代表它存活
──────── 本格变异小结 ────────
  抓住：（无）
  未验证（前提构造不出来，不是存活）： M-driver-lie
  存活：（无）
```
**这一格的结论是 success。** 此前同一件事被报成 `::error:: 变异存活`。

### 错在哪（是我自己漏的）

`e2e-runtime.yml` 那个循环写的是 `if node …; then 抓住 else 存活 fi` —— **只有两档**；
而脚本的退出码是**三态**（文件头就有表）：`3 = 跑起来了，但什么都没证明`。
**这个 3 是我后来加的，却没同步改这个消费方。** 加一个新状态而不追它的消费方，
表现出来就是"沉默地归进最近的那一档" —— 这次归进了最坏的那一档。

现在：`0=抓住 / 3=未验证 / 其它=存活`。未验证**不算通过也不算失败**，
但**不许安静消失**：`::warning::` 注解 + 终端小结 + `$GITHUB_STEP_SUMMARY`，三处都写。

### `B6` 怎么分「没采到」和「采到了但是错的」

⚠️ **没有把"真的没有阶段文案"一起降级掉。** 用**两个不同的 DOM 出口**：
- 机会信号 = **安装进度**（字节数/百分比）出现过几轮；
- 判据本身 = **阶段文案**。

于是：
- `progressVisibleSamples === 0` ⇒ 整轮没在屏幕上见过安装在进行 ⇒ **UNDECIDED**；
- 进度出现过、阶段文案却一条都没有 ⇒ **界面是哑的** ⇒ **照样红**。

拿阶段文案自己判断"有没有机会看阶段文案"是循环论证，所以必须换一个出口。
非法文案 / ASCII token / 阶段倒退三条**一个字没松**。

### ③ macOS 只装 1 个后端包：**该修，而且"runner 时间预算"这个理由不成立**

darwin-arm64 的目录里有**两个**都装得下的 whisper 包：
- `whispercpp-cpu-macos-arm64` **2,015,162 B**
- `whispercpp-metal-macos-arm64` **2,005,577 B**，`requiresDriver: null`

**2 MB。** 时间预算挡不住它。而 macOS 是**唯一**能构造这条前提的平台
（Metal 是 L1，每台 Mac 都有；Linux/Windows 的加速包没有 GPU 硬件证据装不上，那是正确行为）。
⇒ **前提在唯一能构造它的地方也没被构造** = `A-CPU-NO-DRIVER-LIE` 在**所有**平台上永远 UNKNOWN
= **一条永远不工作的守卫**。这与"永远红的门禁等于没有门禁"是同一件事的第三种形态。

⚠️ 但**具体是哪一步把 metal 滤掉的，我 `[未验证]`** —— harness 自己会在
`A-ACCEL-INSTALL` 的 UNKNOWN 详情里打印逐个候选的 `inapplicableKind:reason`，
**那串字符串就是决定怎么修的依据**（是适配判定太严？还是候选筛选只取一个？）。
两次取那条 darwin 日志都取空了，没硬猜。**按吩咐没动 harness 的安装逻辑。**

### 还红着的（都不是这两条，也不在我这一轮的范围里）

- `e2e-browser` darwin：`[变异] B6 的证伪能力（没注入故障那轮不该有错误话）` → **MUT-BAD**。
  这是**另一个** B6（「安装失败时界面必须说话」）的变异，与阶段文案那条同名不同物。**没碰。**
- `e2e-runtime` 三条 2.1/2.2 腿 + 现组装模式下的变异腿：
  组装阶段就挂了 —— `✘ 找不到 vendor/whisper.cpp/samples/jfk.wav —— submodule 没检出`。
  这是你说"另有安排"的①②③那一族，**没碰**；我改用 `bundleSource=artifact` 绕过它，
  才让变异循环真的跑到。
- `A-MODEL-SHA256-FAIL`：**没碰**（已派给别人）。

---

## 2026-08-10 · 收尾两件：MUT-BAD 的真相，和 Metal 那个 `[未验证]`

**先回答两句话。**

**① MUT-BAD 是判据问题，不是产品缺陷 —— 而且坑是我这一轮自己新挖的两个。**
**② Metal 那一步定位到了，而且结论和大家（包括我）之前的判断相反：**
**没有任何一步过滤 Metal —— 它在 darwin 上装成功了。**

### ② 先说 Metal，因为它推翻了上一轮的判断

两条独立证据：

1. **本机跑策略函数**（纯函数，合成 darwin 输入）：
   `evaluateApplicability({pack:metal/darwin/arm64, platform:darwin/arm64, backends:…})`
   在**探针没跑过 / 探针跑过但 metal 不可用 / 全不可用**三种输入下一律
   `{applicable:true, tier:'l1'}`；`isAlwaysApplicable('metal','darwin')===true`。
   （`packages/runtime/src/backends/applicability.ts:72-86` 把 metal-on-darwin 硬编码成 L1，
   根本不读 `gpus[]`、探针结果、`requiresDriver`、系统版本。）
2. **darwin 真日志**（`gh api /actions/jobs/<id>/logs` 拿到的，`gh run view --log` 两次都空）：
```
   → 装加速包 whispercpp-metal-macos-arm64（backend=metal，1.9 MB）
   ✔ A-ACCEL-INSTALL   whispercpp-metal-macos-arm64 → succeeded
   ? A-ACCEL-SWITCH    UNKNOWN — select 回 409「本机无法使用 metal：
                       installed but enumerated no devices (driver missing or too old)」
   ? A-CPU-NO-DRIVER-LIE UNKNOWN — 没有任何「installed=true 且 probed=false」的后端
                       （已装包=whispercpp-cpu-macos-arm64）
```

⇒ **第二个包装上了。** 那句 UNKNOWN 详情里的
「要构造它需要同一台机器上装得下两个后端包，**而加速包在这里装不上**」
**是一句错话** —— 同一轮日志往上三行就写着它装成功了。
**是这句错话把分诊和我一起带偏的**（我据此判"应该修安装逻辑、2 MB 挡不住"——**那个判断作废**）。

**真正的前提是另一件事**：这条断言要的是「装着、**而这一次探测没有加载它**」（`installed=true 且 probed=false`）。
而这台 runner 上 metal **被探了**（所以才有 409 里那句"enumerated no devices"）⇒ `probed=true`
⇒ 前提天然不成立。**不是包装不上，是"装了却没被探"这个状态在这里造不出来。**

⚠️ **所以我没有动 harness 的安装逻辑**（本来打算改的那个方向是错的）。
留给下一步的是两件**不同**的事，请你定：
- **(a) 那句 UNKNOWN 详情要改**——它现在陈述了一个与同轮事实相反的原因，
  是这一整条误诊链的源头。（`e2e-runtime-audit.mjs` 眼下是 `aa4ba3da…` 的地盘，我没碰。）
- **(b) 要不要让 `A-CPU-NO-DRIVER-LIE` 的前提变得可构造** —— 需要一次"探测只扫一个
  backendDir、把已装的另一个晾着"的场景。这动的是**探测/选择那一层**，不是安装逻辑。

### ① MUT-BAD：判据问题，两个坑都是我这一轮新挖的

**原因**：基线取 `base1.replace(base0,'')`，只要这 1.2 秒页面还在渲染，
增量就会带上 `/runtime` 本来就该有的「CUDA/Vulkan/… **不可用**」五条，
而 `FAIL_WORDS` 里正好有「不可用」⇒ 谓词为真 ⇒ 断言没红 ⇒ 记成"变异存活"。
**量到的是渲染时序。** 加了"先等页面静下来"之后 `[CI 实测 win32 run 31366579943]` **MUT-OK**。

darwin 仍红，暴露出我自己的两个错：

- **诊断挂错了分支**：我把命中词塞进 `ok()` 的**失败**消息里，
  而这条变异出问题的那一面**恰恰是 `ok()` 通过** ⇒ 诊断永远不会打印。
  **诊断挂在断言失败那条路上，等于在它最需要说话的那一刻沉默。** 改成无条件 `say()`。
- **归因缺一道闸**：静止判定通过之后那 1.2 秒页面**又**可能变（`/runtime` 有轮询重画）。
  现在 `base1 !== base0` ⇒ 报**无从判断**，不报"变异存活"。

### ①-bis `B6` 的门槛：1 个瞬间不算看过

`[CI 实测 darwin run 31366579943]` `progressVisibleSamples===1` 就宣判"那一处真的是哑的"并且红。
**一个瞬间支撑不起"从来没有"** —— 上一轮同一台机器采到 2 个瞬间就抓到文案并且绿。
**n=1 时结论随运气翻面，那不是判据，是抛硬币。**
改成：`< 3` 个"看得见安装在进行"的瞬间 ⇒ 无从判断；`≥ 3` 还一条文案都没有 ⇒ **照样红**。
⚠️ 判据没松（仍要求中文阶段文案），松的是**"我看够了没有"这个前提**——
前提不成立时本来就不该下结论。

### 同名不同物已拆

`B6`（阶段文案，含 B6b/B6c）↔ `B6`（安装失败必须说话）→ 后者改 **B12**；
`B7`（llm 落地页）↔ `B7`（复制诊断必须出声）→ 后者改 **B13**。**判据一字未改，只改名。**

### 还红着、不是我的

`e2e-browser` win32 这轮红在 `B1「立即测速」点下去有反应` —— 上一轮 win32 是绿的，
我这轮只动了 `mutation()` 三态、B12/B13 改名和 B12 变异体，**都碰不到 B1**。按疑似 flake 报你。
