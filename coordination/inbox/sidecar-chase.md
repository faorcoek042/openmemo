# inbox: sidecar-chase

## [2026-08-09] `installing` 进度：**设计与取证就位，实现没做**（BLOCKED — 我的上下文预算见底）

### 先说结论：这一轮我没有落地，原因不是判断它不重要

改动要落在 `packages/downloader/src/unpack.ts` —— **每一次下载都要走的那条路**，
而且它同时扛着 **zip-bomb 守卫**与**路径穿越守卫**。
我的上下文预算已到尾声，**在最后几步里改这条路，正是本仓一再吃亏的那种改法**
（§11 那族：一个看起来对的改动，代价由用户承担）。
**所以我停在设计与取证，把可以直接接手的东西写清楚。**

### ⚠️ Windows 那段实测：**没做**（这是本轮最大的缺口）

你点名"先答"的那条我**没有答**。那句「Windows 上可达数十秒到数分钟」
**至今仍是合理但未实测的推断**，标 `[未验证]`。
⚠️ **在它被实测之前，不该把它当成用户卡住的原因** ——
你自己也提醒过：如果 Windows 上那段也是毫秒级，**这条修法就只是改善，不是修复，
不能让它替真因背锅**。这句话现在仍然完全成立。

取证方式已经确定且不需要新打点：**接 `/api/events`，量
`step=installing` 到 `state=succeeded` 之间的毫秒数与事件条数**
（linux 实测是 **0 条 / 14ms**，见 `sidecar-crash.md` 上一条）。

### ★ 一个让实现可以不造假分母的实测发现

你叮嘱"拿不到条目总数就别造假分母"。**实际上两种格式都拿得到真分母**，
不需要编：

| 格式 | 真实分母 | 依据 |
|---|---|---|
| **zip** | **条目总数** | `unpack.ts:540` 从 End of Central Directory 读出 `entriesTotal`，**解包前就已知** |
| **tar.gz / tar.xz** | **字节偏移 / 总字节** | `unpack.ts:806` 是 `while (offset + TAR_BLOCK <= raw.length)` —— 它**先整个解压进 `raw`**，所以 `raw.length` 是已知的真值，`offset/raw.length` 是**真实**比例 |

⇒ **两条都能给出诚实的百分比**，一个都不用编。
（zip 报 `N/M 个文件`、tar 报字节比例；两者语义不同但都为真。）

### 建议的实现形状（接手者可直接照做）

1. `UnpackOptions` 加 `onEntry?: (done: number, total: number | null) => void`
   —— `total` 允许为 `null`，但按上表**两种格式其实都给得出**，`null` 只是留给未来的新格式。
2. 三个 `unpack*` 的条目循环里调它。
3. `installer.ts` 把它转成 `step: 'installing'` 的 `job.progress`，
   **走现有节流**（不要绕过 —— 解包几千个小文件同样能打满渲染循环，
   这条你已经点明，且与下载 8MB/s 那条是同一个理由）。
4. **`pct` 只在有真分母时给**，没有就只给"已解 N 个" —— 
   与 `pct: null` 不再被合并成 0 那条修复保持同一原则。

### chmod / 写清单要不要也发：**建议不发**，依据如下

`[实测 linux-x64，见 sidecar-crash.md]` `installing` 到 `succeeded` **整段只有 14ms**，
而这 14ms 里装着**解包 + chmod + 写清单三件事**。
也就是说 chmod 与写清单**各自都远在毫秒级以下** ——
给它们各发一个阶段事件，**只会多两层噪音，不会多一分信息**。

⚠️ 但这个依据**只在 linux 上成立**：如果 Windows 实测显示这 14ms 变成了几十秒，
**必须回来重新判断是哪一步慢的**（很可能是解包，但那时要有数才能说）。
**所以这条结论的有效期，取决于上面那个 Windows 实测。**

### 交接清单（按依赖顺序）

1. **先量 Windows**（不需要改代码，接 SSE 即可）—— 它决定后面两件事的性质。
2. 实现解包进度（形状见上，真分母两种都有）。
3. 变异证明：**摘掉解包进度 → 断言当场红**（你要求的，我没做）。

### 纪律

- 本轮**未改任何代码**；仓库只新增本文件。
- 未碰 `:10000`、`/root/data-memo`、机器指针；**未建/改/删 release**；
  未用任何形式的 `pkill`；未动他人在途文件。
- 未复制 `assertPortFree` / `killTree`（本轮没起 daemon）。

## [2026-08-09 11:05] T-185 ① 已实测 —— **推断被推翻**，②/③ 我没有照原样做（附理由与新交接）

交付：`.github/workflows/measure-install-phases.yml` + `scripts/ci/measure-install-phases.mjs`
（提交 `18b04c8` · `e6eb6a2` · `84f0541` · 及 409 退避那条）

### 一、先答你点名的那条：Windows 上 `installing → succeeded` 是**毫秒级**

`[CI 实测 windows-2025，接真事件流不轮询]`

| 包 | 体积 / 条目 | `installing → succeeded` | 其间事件 |
| --- | --- | --- | --- |
| `whispercpp-cpu-win-x64` | 4.0 MB / 18 | **5 ms** | **0 条** |
| `whispercpp-vulkan-win-x64` | 25.1 MB / 19 | **6 ms** | **0 条** |
| （linux 基准） | 6.8 MB / 23 | 3 ms | 0 条 |

**包大 6 倍，那一段没有变长。** 所以「Windows 上要解归档 + Defender 逐文件实时扫，
可达数十秒到数分钟」这个推断，**在 25 MB 以内被实测推翻**。

⇒ **按你的规则如实说：用户的「停在正在安装」另有原因，解包进度只是改善不是修复。
我没有让它替真因背锁。**

### 二、一个把前提改掉的结构性发现：**解包根本不在 `installing` 窗口里**

`DownloadProgress['phase']` 只有 `resolving | downloading | verifying`
（`download.ts:50`）—— **downloader 里压根没有 `installing` 这个 phase**；
而 `unpackArchive` 在 `installFiles` **内部**被调用（`installer.ts:265`），**一个事件都不发**；
`ctx.setStep('installing')` 是 daemon 在 `installFiles` **返回之后**才设的（`backends.ts:249`）。

⇒ **解包期间，界面上最后一个 step 仍然是 `verifying`。**
交接单里那句「`installing` 的显示时长 ≡ 解包 + chmod + 写清单」**不成立** ——
`installing` 窗口里只有 `writeManifest` + 扩展链接，那正是量到的 5ms。

解包在哪？在**最后一个 `verifying` 事件到 `installing` 之间**那段。实测：

- Windows / 4.0 MB：`verifying pct=1` t=677 → `installing` t=718 = **41 ms**
- Windows / 25.1 MB：t=882 → t=1053 = **171 ms**（6 倍体积 → 4 倍耗时，量级一致）

**所以即使解包真的慢，用户看到的也会是「正在校验完整性」卡住，不是「正在安装」。**
这一条直接改变 ② 该往哪儿发事件 —— 也是我不照原样实现的主要原因。

### 三、唯一量到的"黑窗"在别处：**macOS `warming`，10.6 秒 0 事件**

`[CI 实测 macos-26]` `whispercpp-metal-macos-arm64`：

```
t=   660ms  job.progress  step=warming  pct=1
t= 11237ms  backend.installed              ← 中间 10.6 秒，0 个事件
t= 11239ms  job.state     state=succeeded
```

`installing → succeeded` 名义上 10633 ms，但**时间全在 `warming` 之后那一段**，
与解包无关。**这是本轮量到的唯一一个数量级足以让人以为"卡住"的窗口**
（比 install 窗口大 3 个数量级）。两次独立运行都复现（16.9s / 10.6s）。

### 四、②/③：**我没有做，理由如下（不是没时间）**

1. 前提被推翻：按 ① 的数，解包进度**修不了用户报的那个症状**。
2. 落点错了：真要发，也该发在 `verifying → installing` 那段，或**先给 downloader 加一个
   `unpacking` phase**，而不是往 `installing` 里塞 —— 这是**契约改动**（`packages/shared` 的 job step），
   已超出"加个回调"的范围，值得你先裁一次。
3. `unpack.ts` 同时扛 zip-bomb 与路径穿越两道守卫，**在前提未定时改它**正是本仓一再吃亏的那种改法。

**真分母那条结论仍然成立且可直接用**（zip 的 `entriesTotal` 解包前已知；tar 的 `offset/raw.length` 为真值），
接手者不必重查。

### 五、建议的下一步（按证据排序，供你裁决）

1. **查 macOS `warming` 那 10.6 秒**（唯一有数的黑窗）—— 它是什么、能不能分段播报。
2. 若仍要做解包进度：**先定 phase 契约**（新增 `unpacking`？还是把解包并入 `installing` 并提前 `setStep`），再动 `unpack.ts`。
3. 678 MB 的 CUDA 包**在 GitHub runner 上结构性量不到**（无 N 卡 → 正确 409），
   要它的数得有真 N 卡机器。按 171ms / 25MB 线性外推是 **≈4.6 秒** ——
   **那是算术不是实测**，我不拿它当结论。

### 诚实声明

- 三个平台的数都来自 `/api/events` **真事件流**（不轮询，"太短没抓到"在构造上被排除）。
- ⚠️ **我自己造成过一次假数据并已修**：第一版只按"最小"挑包，三平台都挑中 macOS 的
  Metal 包，windows/linux 上 **409** 却仍 exit 0，报出「整段没有 installing」——
  **那和"产品真的不发 installing"长得一模一样**。现在按 os/arch 过滤，且
  安装被拒 / 没观察到 installing / 没等到终态**一律红**（§11）。
- `[未验证]`：**真实用户机器上的 Defender 行为**。GitHub Windows runner 的实时扫描
  是否与用户机器等价，我不知道 —— 标 `UNKNOWN`。所以我的结论限定为
  「**在 CI windows-2025 上、25 MB 以内的包**」，不外推到所有 Windows 机器。
- `[未验证]`：678 MB CUDA 包（结构性量不到，见上）。
- 未碰 `:10000`、`/root/data-memo`、机器级指针；未建/改/删 release；未用 `pkill`；
  端口与收尾用的是刚收敛的共享 `assertPortFree` / `killTree`。
- **`packages/downloader` 我一行没改**（②/③ 未做），故未撞到你提的那条 Windows 已知红。
