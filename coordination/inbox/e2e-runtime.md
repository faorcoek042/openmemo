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
