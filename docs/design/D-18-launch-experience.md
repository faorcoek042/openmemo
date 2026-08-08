---
id: D-18
author: bundle-launch
status: ready
date: 2026-08-08
input: 用户 2026-08-08 真机实测；D-17；ADR-003 §7/§7.6；CI run 31245628148 / 31246584116 / 31247860854 / 31248222725 / 31248489471
---

## TL;DR（≤ 25 行，Manager 只读这里）

- **判据改了**：从「包能被脚本跑起来」改成「**一个从浏览器下载了包的人，按他自然会做的
  动作，能不能看到 OpenMemo 的界面**」。旧判据是绿的，用户手里的包是坏的。
- **结构性成因（比三个 bug 都重要）**：`verify-bundle.sh:135` 只做 `need_file "$LAUNCHER"`，
  `cold-start-audit` 直接跑 `dist/main.js` —— **在本轮之前，没有任何一条 CI 腿执行过任何一个
  启动器**。不是"测得不够细"，是**那条路径一次都没被走过**。
- **Windows 真实报错原文**（`[CI 实测 run 31246584116]`，代码页 936）：
  `'m' is not recognized as an internal or external command,` —— 437 下不出现，
  **代码页是唯一变量**。成因不是"换行被吞"（GBK 的 trail byte 是 0x40–0xFE，
  0x0A 不可能被吞），是 GBK 在中文 `rem` 注释里**错位配对**，把 `rem` 的 `r`/`e` 吃掉，
  漏出一个 `m` 当命令执行。**修法：`.cmd` 整体纯 ASCII**（组装时 `die()` 硬拦）。
- **macOS 拦在哪一步**（`[CI 实测]`）：`spctl -a -t open OpenMemo.command` →
  **`rejected` / `source=no usable signature`**。拦的是**脚本自己**（未签名），
  不是 Node —— `runtime/node` 有 **Developer ID Application: Node.js Foundation (HX7739G8FX)**
  正式签名，带 quarantine 直接执行**照样跑通**（实测 `node-ran-ok`）。
  所以用户看到的是「**没有窗口打开**」：Terminal 根本没被启动。
- **⚠️ 我们发出去的解法是错的**：v0.2.0 的 `OpenMemo.command` 与 D-17 §5 都写着
  「用命令行 `tar` 解压不传播 quarantine → 不拦」。**实测：`tar` 也传播。**
  访达的「归档实用工具」与命令行 `tar` **两者都会**把属性传给解出来的每个文件。
- **quarantine 两条路径现在都有实测了**（ADR-003 §7.6 裁决 (A) 欠了半个月的那次测量）：
  **路径① 会被打上、且 `tar` 与「归档实用工具」都会传播**；
  **路径② 不会**（`[CI 实测 run 31247860854]`：包自带的 node 写下去的文件
  `No such xattr`，与 §4.1 的阳性对照并读后成立）。见 §4。
- **v0.2.0 把解法写在了 `OpenMemo.command` 里面** —— 而那正是 Gatekeeper 拦住的文件。
  **把说明书锁在了它要解释的那扇门后面。** 现在解法进 `READ-ME-FIRST.txt` + README + Release 正文。
- 需要用户拍板 1 件事：**macOS 首次运行怎么放行**（三选一，见 §7）。
  ⚠️ 清 quarantine 属于 Security Weaken，**我没有替他决定，也没有在代码里悄悄清**。

---

## 1. 判据为什么必须改

CI 跑的是 `start.sh --port … --data-dir …`：**从一个已经存在的 shell 里、带着参数、
由脚本驱动**。它证明「这个包能被脚本跑起来」。

用户做的是：浏览器点下载 → 双击归档 → 双击启动器。**两条路径只有"最后一个文件相同"。**

差别不在细节，在**入口本身**：

|          | 脚本驱动                      | 双击                          |
| -------- | ----------------------------- | ----------------------------- |
| 参数     | 有（`--port` / `--data-dir`） | **没有**                      |
| 环境变量 | 继承 CI 的                    | **只有系统默认的**            |
| 下载标记 | 没有（CI 用 curl/gh 取）      | **有**（MOTW / quarantine）   |
| 解压器   | `tar` / `unzip`               | **资源管理器 / 归档实用工具** |
| 错误去处 | CI 日志，永久可读             | **一个一秒后消失的窗口**      |

### 1.1 结构性成因：那条路径一次都没被走过

- `scripts/ci/verify-bundle.sh:135` = `need_file "$LAUNCHER"` —— 只验**存在**。
- `scripts/ci/cold-start-audit.mjs:240` 直接指向 `app/daemon/dist/main.js`。
- `scripts/ci/verify-bundle-upgrade.mjs:89` 同上。

`[实测 grep]` 全仓 `scripts/` + `.github/workflows/` 里，**没有任何一处执行启动器**。
所以三个启动器的**全部内容**（代码页、pause、缺件提示、要不要开浏览器）
从来没有被任何东西检验过 —— 它们只是"存在着"。

> **判据：一个从没被执行过的文件，不因为它被 `need_file` 检查过就变得可信。**

---

## 2. Windows：真实报错原文

### 2.1 先说清楚哪一条**不**成立

线索里说「UTF-8 无 BOM 的中文注释会让 cmd 把行尾吞掉」。**这条机制不成立**，
两个独立证据：

1. GBK 的 trail byte 范围是 **0x40–0xFE**（不含 0x7F）。换行符 `0x0A` **不在其中**，
   所以任何 lead byte 都**不可能**把行尾吞掉。（本机逐字节模拟，`[实测]`）
2. `[CI 实测 run 31245628148]` 逐行统计：非 ASCII 字节**全部落在 L2/L4/L5 三条 `rem` 行**，
   可执行行（L1、L6–L11）**是纯 ASCII**。

也就是说：**"注释里的中文会不会炸"这个问题，靠推理得到的答案是"不会"，而实测的答案是"会"**
—— 但会的方式和推理的完全不同。这正是本仓反复强调"别从代码推断症状"的那一格。

### 2.2 真实发生的事（`[CI 实测 run 31246584116]`）

同一个包、同一条命令，只改代码页：

```
代码页 437：
  > (node:6536) ExperimentalWarning: SQLite is an experimental feature ...
  > [daemon] ⚠️  流水线缺少工具: ffmpeg, ffprobe, whisper-cli, asr-model —— 相关任务会转 blocked
  > [daemon] 就绪 http://127.0.0.1:17650/#t=Ei_yC8jKM5tvuKqvNBFU47KAXDPseCwgfcjhKyxnsJM

代码页 936（中文 Windows 的默认值）：
  > 'm' is not recognized as an internal or external command,
  >
  > operable program or batch file.
  >
  > (node:8692) ExperimentalWarning: SQLite is an experimental feature ...
```

**`'m' is not recognized as an internal or external command,` 就是用户说的"提示出错"。**

成因：GBK 解码器在中文 `rem` 注释里错位配对（UTF-8 的字节序列不是合法 GBK），
把某一行 `rem` 的 `r`/`e` 当成了前一个字符的 trail byte 吃掉，**剩下的 `m` 漏出来当命令执行**。

### 2.3 三件同时成立的事

| #   | 事实                                                    | 级别             |
| --- | ------------------------------------------------------- | ---------------- |
| 1   | cp936 下打印一行 `'m' is not recognized…`               | `[CI 实测]`      |
| 2   | **结尾没有 `pause`** —— 出错时窗口随进程退出而关闭      | `[实测]`（静态） |
| 3   | **不会自动开浏览器**，只把带 token 的地址打印在控制台里 | `[CI 实测]`      |

②③ 合起来的后果比 ① 更重：**即使 daemon 起来了，用户也不知道自己该去哪。**
实测里 daemon 在两个代码页下**都起来了**（界面 200）—— 也就是说
用户很可能面对的是"一条报错 + 一串看不懂的日志 + 没有任何窗口弹出"，
然后合理地得出"它坏了"的结论。

### 2.4 修法

- **`.cmd` 整体纯 ASCII**，注释改英文；`build-bundle.mjs` 在组装时逐字节校验，
  发现非 ASCII **当场 `die()`**（判据：跑错了也不会造成后果，不是"记得别写中文"）。
- **`chcp 65001`**：管的是**渲染**不是解析 —— daemon 自己输出 UTF-8 中文，
  cp437 控制台上会是乱码。两者不要混为一谈。
- **CRLF 行尾** + `pause`（出错分支）+ **缺件预检**（最常见成因：直接在 zip 里双击，
  Windows 只解出你点的那一个文件）。
- **写 `.cmd` 时用 `latin1` 落盘并断言纯 ASCII**，避免任何编码器再引入高位字节。

### 2.5 Mark-of-the-Web（`[CI 实测]`）

- 资源管理器的「全部解压缩」（`Shell.Application.CopyHere`，与右键菜单同一条代码路径）
  **会把 MOTW 传播**给 `start.cmd` 与 `runtime\node.exe`（两者都读到 `ZoneId=3`）。
- 双击 `.cmd` 时 Windows 实际执行的是 `cmdfile="%1" %*`（`assoc`/`ftype` 实测）。
- **SmartScreen 的真实弹窗测不到**（无头 runner 没有交互会话）→ 见 §6 人工清单。

---

## 3. macOS：Gatekeeper 拦在哪一步、原话是什么

### 3.1 拦的是**脚本**，不是 Node（`[CI 实测 run 31245628148]`）

```
$ codesign -dvvv runtime/node
  Authority=Developer ID Application: Node.js Foundation (HX7739G8FX)
  Authority=Developer ID Certification Authority
  Authority=Apple Root CA
  Timestamp=Jun 23, 2026 at 1:53:47 PM
  flags=0x10000(runtime)          ← hardened runtime
  Runtime Version=15.0.0

$ spctl -a -vvv -t exec runtime/node
  exit=3
  rejected (the code is valid but does not seem to be an app)
  origin=Developer ID Application: Node.js Foundation (HX7739G8FX)

$ spctl -a -vvv -t open --context context:primary-signature OpenMemo.command
  exit=3
  rejected
  source=no usable signature          ← ★ 这一条就是用户撞到的那道门

$ ./runtime/node -e 'console.log("node-ran-ok")'     （文件带着 quarantine）
  exit=0
  node-ran-ok                          ← ★ Node 本身**跑得起来**
```

含义，逐条：

- **Node 二进制是正式 Developer ID 签名的**，带 quarantine 也能执行 —— 我们
  「原样携带 Node 官方签名」那个设计判断**是对的，而且现在有实测**。
- **被拦的是 `OpenMemo.command` 自己**：它是一个**未签名的 shell 脚本**，
  `source=no usable signature`。双击走 LaunchServices，Gatekeeper 在**打开脚本**
  这一步就拒绝了 —— **Terminal 根本没有被启动**。
- 所以用户的原话「**也没有窗口打开**」是精确的：不是窗口开了又关，是**从没开过**。

### 3.1-bis 端到端复现（`[CI 实测 run 31248222725]`，端口洁净已证）

```
✔ 端口 17650 干净（没有残留 daemon），④ 的结论才有意义
$ open OpenMemo.command（= 访达里双击）
  exit=null error=spawnSync open ETIMEDOUT
  等待 40s 看界面起没起来…
  [实测] 双击后界面 GET / => unreachable (never came up)
```

**这就是用户那句话的复现**：`open` 自己超时/被拒，40 秒内界面**从未起来**。

对照组（同一轮、同一个包，只把 quarantine 清掉以模拟"用户放行了"）：

```
> [daemon] 就绪 http://127.0.0.1:17650/#t=eFUQbPKAH9r4vOLBld23cJ8VR5BtXnuCo-iO3ZsFkgI
  进程: 已退出 code=0 · 界面 GET / => 200 · health => 200
✔ 放行后界面可达 (HTTP 200)
```

→ **包本身是好的，坏的只有"进不去"这一关。** 这一组对照很重要：
它把"macOS 上包坏了"和"macOS 上用户进不来"分开了，而两者的修法完全不同。

### 3.1-ter 这条守卫不是空的（非空洞性证明）

拿 **v0.2.0 那个已知坏掉的包**跑 `--mode guard`，它**恰好红在三条**上，
而且每一条都对应一个用户真的报回来的问题：

```
✘ 包内没有 READ-ME-FIRST.txt —— Gatekeeper 拦住时用户唯一读得到的东西
✘ 启动横幅里仍然带 `#t=<token>` —— 而默认鉴权是 none，这串东西不起任何作用
✘ 横幅里只有一个裸 URL，没有一句告诉用户该做什么的话
```

> **一条守卫的价值不在于它绿的时候，在于它红的时候红得对。**
> 这三条是拿真实的坏包验出来的，不是我构造的变异体。

### 3.2 ⚠️ 我们发出去的解法是错的（`[CI 实测]`）

v0.2.0 的 `OpenMemo.command` 与 D-17 §5 都写着：

> · 用命令行解压：`tar xzf openmemo-*.tar.gz`（**不传播 quarantine**）

**实测结果相反：**

| 解压方式                 | `OpenMemo.command`                              | `runtime/node` | sherpa 目录 |
| ------------------------ | ----------------------------------------------- | -------------- | ----------- |
| 命令行 `tar xzf`         | **带 quarantine**                               | **带**         | **带**      |
| 归档实用工具（访达双击） | **带 quarantine**                               | **带**         | **带**      |
| `ditto -x -z`            | 不适用（`.tar.gz` 不是 zip，`bad file format`） | —              | —           |

三者读到的都是同一个值 `0083;6a76d6d2;Safari;<uuid>`。

> **一条我们主动给出、用户会照着做、而且做了没用的建议，比不给建议更糟** ——
> 他会认为自己已经排除了这个原因。

### 3.3 v0.2.0 最要命的一条

那两行解法**写在 `OpenMemo.command` 的注释里**。而 Gatekeeper 拦的就是这个文件 ——
**它根本没被执行、也没被打开过，用户一个字都读不到。**

> **把说明书锁在了它要解释的那扇门后面。**

修法：解法必须出现在**不需要执行任何东西就能读到**的地方 ——
包内 `READ-ME-FIRST.txt`（新增）+ README + Release 正文，三处同文。

---

## 4. quarantine 两条路径：ADR-003 §7.6 欠的那次测量

§7.6 裁决选 (A)「先跑 §7.2 那条命令量一量」。**那次测量从来没有发生。** 现在有了。

### 4.1 必需的阴阳对照（缺了结论无效）

```
阴性对照 · gh/curl 下载的归档：
  xattr -p com.apple.quarantine <archive>
  exit=1  →  No such xattr: com.apple.quarantine        ← 命令行下载不打

阳性对照 · 手工写入后回读：
  exit=0  →  0083;6a76d6d2;Safari;080B8B92-...          ← 探针确实读得出
```

**两者不同 → 探针有效。** 阴性结果因此是有意义的（本仓在这上面栽过三次）。

### 4.2 两条路径的结论

| #   | 路径                         | 会不会被打上                           | 级别                                                  |
| --- | ---------------------------- | -------------------------------------- | ----------------------------------------------------- |
| ①   | 浏览器下载 + 解压            | **会，而且会传播给解出来的每一个文件** | `[CI 实测]` 传播那半；**打标记那半是 `[模拟]`**，见下 |
| ②   | daemon 自己下载（Node 写盘） | **不会**                               | `[CI 实测 run 31247860854]`                           |

#### 路径② 的实测（ADR-003 §7.2 的正题）

用**包自带的那个 node**（不是 runner 的 node —— 路径② 的定义就是"daemon 进程自己写的"）
下载并落盘，然后问这个文件：

```
$ 用包自带的 node 下载并写盘
  exit=0   written
$ xattr -p com.apple.quarantine <node 写的文件>
  exit=1
  xattr: /var/folders/.../downloaded-by-node.bin: No such xattr: com.apple.quarantine
```

**与 §4.1 的阳性对照并读**（同一台机器、同一次运行里，手工写入的 quarantine 读得出来）
→ 这个阴性结果是**有意义**的，不是"探针坏了"。

#### 这条结论差点没拿到（过程如实记）

它前后跑了 **4 轮**才拿到，而前几轮拿不到**全是我自己探针的毛病**：

| 轮次 | 结果       | 原因                                                                  |
| ---- | ---------- | --------------------------------------------------------------------- |
| 1    | 没跑到     | 另两条腿卡死（`open -W` 永不返回 / 子进程握着管道），我取消了整个 run |
| 2    | 没跑到     | ③ 里一条 `--version` 步骤起了个长驻 daemon，卡死 28 分钟到超时        |
| 3    | **拿到了** | 加默认超时 + 把路径② **前移到所有诊断之前**                           |

> 中间我一度把它写成"已测：不会"。**它当时没有被测过。**
> 这与 §7.6 那次「裁决了要量、然后没人去量、而文档看起来像量过了」是同一个形状 ——
> 只不过这次是我自己。**先降级、量出来再升上去**，顺序不能反。

⚠️ **路径① 的诚实边界**：无头 runner 上没有浏览器，所以「Safari/Chrome 下载时打上
quarantine」这一步是我们**手工写入同一个属性**来模拟的（属性是真的，动作是模拟的）。
**Apple 的公开行为 `[报告]`；传播、拦截、报错原文全部 `[CI 实测]`。**

### 4.3 对 ADR-003 决策 4 的影响

- ADR 原文那条缓解措施写的是「**首次运行时由 daemon 自动清除**」，针对的是**路径②**。
  **实测路径② 根本不会被打上** → **那条缓解措施从一开始就不需要**。
  §7.6 裁决 (A) 想要的那个答案拿到了：**"缺了一环"的是论证，不是代码。**
- **但决策 4 不能就此收工。** 真正伤到用户的是**路径①**，而 ADR 原文
  **从来没有讨论过它**：浏览器下载 → 解压 → 双击，quarantine 会被打上并传播，
  Gatekeeper 拦在打开 `.command` 那一步。
  换句话说：**ADR 为一个不存在的问题准备了缓解措施，而真实存在的那个它没写。**
- 我**没有改 ADR-003**（那是 Manager 的地界）。本节就是提交给它的输入，
  §7 是需要用户拍板的那一条。
- 所以 §7.5 的三选一要重新表述 —— 见 §7。**这是 Manager/用户的地界，我不改 ADR。**

---

## 5. Linux（用户没报，同族检查）

`[CI 实测]` 不带任何参数跑 `./start.sh` → 界面 200，正常。

- **可执行位在**（`-rwxr-xr-x`），`xdg-open` 存在，**包内没有 `.desktop` 入口**。
- **文件管理器里双击 `.sh` 通常不会运行它** —— GNOME Files ≥3.30 默认不执行脚本，
  双击 = 用默认应用打开。`[报告]`：**无头 runner 上测不到**（没有 GUI 会话），
  见 §6 人工清单。
- 判断：Linux 用户绝大多数会从终端跑，**不值得为它引入 `.desktop`**
  （`.desktop` 自己也有"必须放到特定目录 + 也会被标记为不受信任"的一套问题）。
  但 `start.sh` 的注释里现在**明写**了"请在终端里跑"。

---

## 6. CI 覆盖到什么、覆盖不到什么

### 6.1 覆盖到了（`scripts/ci/simulate-user-launch.mjs`，已接进 `build-bundles.yml` 三条腿）

- 下载标记的**传播**：MOTW（Windows）/ quarantine（macOS）→ 解出来的文件
- **双击的等价执行路径**：Windows 经 `cmdfile="%1" %*` 的形态 + 指定代码页；macOS `open`
- Gatekeeper 的**判定结果与原话**（`spctl` / `codesign`）
- 启动器**真的被执行**，且**界面真的可达**（HTTP 200，不是"进程还活着"）
- **用户在窗口里读到的那段文字**本身：不许含 `#t=`、必须有一句人能照着做的话、
  不许混进 cmd.exe 的报错
- `.cmd` **纯 ASCII**（这条直接对应 §2.2 那个报错）

### 6.2 结构上覆盖不到 → **人工验证清单**

无头 runner 没有交互式 GUI 会话，以下三类**做不到就是做不到**，不假装：

| 做不到的                                              | 为什么                                    | 人工怎么验（一次，5 分钟）               |
| ----------------------------------------------------- | ----------------------------------------- | ---------------------------------------- |
| SmartScreen / Gatekeeper **弹窗长什么样、原话是什么** | 需要 LaunchServices / Explorer 的交互会话 | 真机双击一次，截图                       |
| **浏览器打 quarantine 的那一刻**                      | runner 上没有浏览器                       | 用 Safari 下载后 `xattr -p` 一次         |
| **控制台窗口关掉之后还剩什么**                        | 窗口生命周期属于 GUI 会话                 | 真机双击一次，故意制造错误，看窗口留不留 |
| 中文 Windows 的**默认**代码页确实是 936               | runner 是 65001                           | 真机 `chcp` 一次                         |

> **一条如实说"这里我测不到"的结论，比一条假装覆盖了的 CI 腿更有价值。**
> 后者会让下一个人以为这格有人守着。

---

## 7. 需要用户拍板：macOS 首次运行怎么放行

⚠️ **清除 Gatekeeper 隔离属性属于 Security Weaken，我没有替他决定，
也没有在代码里悄悄清掉。** 三个选项，代价都写出来：

|                                      | 做法        | 用户要做什么                                                                           | 代价                                                          |
| ------------------------------------ | ----------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **(A) 不做，教用户放行**（我倾向）   | 保持不签名  | 首次**右键 → 打开**一次（macOS 15+ 可能要去「系统设置 → 隐私与安全性」点「仍要打开」） | 每个新用户被打扰一次；说明必须显眼                            |
| **(B) 我们在文档里推荐 `xattr -dr`** | 仍不签名    | 终端跑一次 `xattr -dr com.apple.quarantine <目录>`                                     | **等于对这些文件关掉 Gatekeeper**；用户得先信任来源           |
| **(C) 买 Apple Developer ID 并公证** | 签名 + 公证 | **什么都不用做**                                                                       | 99 美元/年 + 公证流程进 CI；与 ADR-003 决策 4「不买证书」冲突 |

**我倾向 (A)**：定位是本地自用，一次右键的代价换掉 99 美元/年与一条 CI 流程；
而 (B) 的实际效果与 (A) 相同却让用户亲手削弱一次安全检查。
**但这不是我的裁量权** —— (A)(B) 的说明文案都已经写好在 `READ-ME-FIRST.txt` 里，
用户选哪条我改哪条。

**无论选哪个，那句话都必须出现在用户看得到的地方**：Release 正文 + README +
包内 `READ-ME-FIRST.txt`。v0.2.0 的教训就是它只写在了被拦住的那个文件里。

---

## 8. 顺带修掉的三件（都是用户 2026-08-08 报的）

### 8.1 鉴权关着却打 token

`[CI 实测]` v0.2.0 的横幅原文：

```
[daemon] 就绪 http://127.0.0.1:17650/#t=j609AekS9fbml19C2VO5NV5NVKXwC24hTPAwnnDt5uA
```

而 `auth.ts` 的 `authMode()` 默认 `'none'`、`server.ts` 的鉴权闸门整段跳过 ——
**那串 token 不承担任何作用**。用户的原话：「怎么还有 token？不是早都删除了吗」。

- 修：横幅只在 `authRequired()` 时打 token；`OPENMEMO_AUTH=token` 的恢复路径**保留**。
- 抽成纯函数 `bootstrap/ready-banner.ts` + 12 条用例，**两个方向都钉**
  （只钉一个方向会把开关做成单向门 —— `auth.ts` 注释里记着本仓正为此栽过）。
- **`server.ts:317/322` 那两句指路牌不用改**：它们在 `if (!authRequired()) { … return; }`
  **之后**，`none` 模式下**结构上不可达**，所以在 token 模式下依然是真话。
  （这一条是查证结论，不是假设。）

### 8.2 Apple Silicon 上显示"不支持 AVX2"

`HardwareCard.tsx:72` 原来只判 `!features.includes('avx2')`，于是 M 系列 Mac 上**必然为真**，
还是红色告警色。AVX2 是 x86 专属维度，**在 arm64 上不存在这个概念**。

- 修：`hw.os.arch === 'x64' && !includes('avx2')` 才渲染。`hw.os.arch` 本来就在 `HardwareInfo` 里。
- **功能面没有受影响**（查证结论）：`manager.ts:267` 的 `isa` 字段全仓**零消费者**，
  只进 schema 不进任何判断 —— 也就是说 avx2 在 Apple Silicon 上**没有**误伤适配性计算。
- 同族检查：`detect/system.ts:161` 在 arm 上只加 `neon/fp16/dotprod/asimd`，
  **没有别的 x86 专属维度被渲染成"不支持"**。

### 8.3 冷启动第一屏读起来像"坏了"

原文：`[daemon] ⚠️  流水线缺少工具: ffmpeg, ffprobe, whisper-cli, asr-model —— 相关任务会转 blocked`

内容是对的，但对刚双击开包的人来说：一个警告符号 + 一串没见过的名字 + 一个看不懂的状态词。

- 修成三件事：① 说清这是首次启动的正常状态、不是出错；② 下一步去哪（设置 → 组件）；
  ③ 代价是什么（任务先排队，不丢）。**不降级成 `console.log`** —— 它确实是
  "功能还不完整"，只是不该被读成故障。
- 判据与 8.2 同族：**「尚未完成的一步」和「出错了」必须区分得开。**

### 8.4 还剩一条噪音（未改，交 Manager）

`(node:6536) ExperimentalWarning: SQLite is an experimental feature and might change at any time`

它是**用户看到的第一行**，而且长得像"这软件在用实验性功能"。
来源是 Node 自己（`node:sqlite`）。可用 `--no-warnings` 或 `--disable-warning=ExperimentalWarning`
在启动器里压掉，但那会**连带压掉真正的警告** —— 这是个取舍，不在本轮职权内。

---

## 9. 修完之后的实测（`[CI 实测 run 31248489471]`，三条腿全绿）

同一条 `simulate-user-launch.mjs`，`--mode guard`，跑在**从 HEAD 新组装的包**上：

### Windows（`start.cmd` 现在 1884 字节 · 纯 ASCII · CRLF 59/59）

```
✔ start.cmd 纯 ASCII —— 任何 OEM 代码页都不会把它解坏
▶ 代码页 936 下双击
  > [daemon] 以下组件还没装: ffmpeg, ffprobe, whisper-cli, asr-model
  > [daemon]    这是首次启动的正常状态，不是出错了。
  > [daemon]    打开网页后在「设置 → 组件」里点安装，装好会自动生效（不用重启）。
  > [daemon]    在此之前，转写类任务会先排队等着（blocked），不会丢。
  > [daemon] 就绪。请在浏览器里打开这个地址：
  > [daemon]     http://127.0.0.1:17650/
  > [daemon]     要停止 OpenMemo：回到这个窗口按 Ctrl+C，或直接关掉窗口。
✔ 代码页 936: 界面可达 (HTTP 200)
✔ 启动横幅不含 token（鉴权关闭时不该出现）
✔ 横幅里有一句人能照着做的话（提到"浏览器"）
✔ 有 pause：出错信息会停在屏幕上
```

**cp936 下那行 `'m' is not recognized…` 消失了**，且地址里不再有 `#t=`。

### macOS

```
✔ 包内有 READ-ME-FIRST.txt（Gatekeeper 拦住时用户唯一读得到的东西）
✔ 放行后界面可达 (HTTP 200)
✔ 启动横幅不含 token
⚠️ [已知事实·待用户裁决] 双击（open）后界面不可达 —— Gatekeeper 拦在 LaunchServices
```

⚠️ **macOS 那条仍然拦着，而且这是对的**：它走 `known()` 通道 ——
**照样打印、照样刺眼，但不判定失败**。理由：修它需要用户拍板（§7），
而**一条永远红的门禁等于没有门禁**（人会开始忽略它，于是它再也挡不住真正的回归）。
判据与 `check-bundle-macos-floors.mjs` 那次分层同源：**已知事实不该每次伪装成新问题。**

### 三条腿的耗时（`coldStart=false`）

linux 2m9s · macos 4m7s · windows 2m43s —— **这条腿很便宜**，
没有理由不每次都跑。
