# backlog-sweep —— inbox 遗留项全量清扫回执

## [2026-08-06 20:40] T-155 DONE —— 35 份回执扫完、105 条定性、修了 4 条

交付: 3 个提交（`b97bed6` / `b017fc3` / `76e2749`），逐个 `git add`，**一次 `-A` 都没用过**。
本文件 = 清单 + 排期表。

未碰 `/root/data-memo`、未写 `~/.local/share/openmemo/datadir.json`、
未重启/未 kill/未占用 `:10000`（**全程只发过 GET**）、未跑 `pnpm -r build`、
**未构建 `apps/web/dist`**（mtime 仍是 `08-06 18:17`，早于我开工）、
未用 `pkill -f`、未跑本地 whisper 转写、未建/改/删 release。
`ci-upload` 的 `.github/` + `scripts/ci/` 与 `docs-public` 的 `README.md` + `docs/DEPLOYMENT.md`
在我工作期间一直在工作区里，**我一个都没 add**。

---

# TL;DR（Manager 只读这里）

## 四类的准确条数（去重后 **105** 条 + 5 条明说没查清）

| 类别 | 条数 | 一句话 |
|---|---:|---|
| ✅ **已被后续工作完成** | **61** | 与 `debt-cleanup` 的「60% 是写着没做实际做了」几乎逐字吻合（本轮 61/105 = **58%**） |
| 🔴 **仍开着 · 用户能撞上** | **15** | **我修掉 4 条**，剩 **11 条**，排序表见 §2 |
| 🟡 **仍开着 · 无用户可见症状** | **21** | 见 §3。里面藏着一条**真的沙箱逃逸**，单独标了 |
| ⚫ **已被决策取消** | **8** | 见 §4。其中一条的**依据被全项目引错了**，见下 |
| ❓ **明说没查清** | **5** | 见 §5。宁可留白，不猜进某一类 |

> 105 是**去重后**的数字。原始命中远多于此 —— 同一件事在 `gpu-runtime` 从 T-025 到 T-093
> 被提过五六次，算一条；跨四路重复的（`openmemo-probe`、`listInstalled` VAD 桶、三个被裁的平台…）
> 只计一次。

## 修了 4 条（都在第 2 类里，都做了反向验证）

| 提交 | 修了什么 | 用户侧的差别 |
|---|---|---|
| `b97bed6` | **T-151 有 3 个文件从来没被提交** | F1 链接导入 / F2 本地文件导入的笔记**至今没有波形**；只有浏览器录音有 |
| `b017fc3` | 下载失败时中文界面显示英文（`ERROR_MESSAGES_ZH` 零调用方） | 模型下载失败看到的是 `All download sources failed`，不是「所有下载源均失败」；且可重试的失败拿不到重试入口 |
| `76e2749` | **笔记删不掉、改不了名**（三条 mutation 零调用方）+ 移动笔记打错端点 | 一条笔记建出来就永远删不掉；而侧栏的「文件夹」反倒有删除按钮 |

门禁：`tsc -b` 0 · `eslint .` 0 · `pnpm -r test` **1100 passed / 0 failed**
（开工基线 1088，我贡献 **12 条**：downloader 6 + web 组件 6）。

## 四条本轮最该被记住的

1. **`b97bed6` 是「提交清单对了、执行漏了」。** `daemon-contract` 的 T-151 回执**逐行列出了 17 个该 add 的路径**，
   `2a45694` 只装进 14 个。漏掉的恰好是把「真波形」接到**导入/转写**那条路上的三个。
   commit message 写着「真波形」，而一半的用户路径上它不存在。
   → ⑤J「提交卫生」一直讲的是 `git add -A` **多**装东西，**这是它的镜像：照着清单 add 却少装。**
   两者的判据其实是同一条：**合并者必须逐条核对清单，而不是凭印象。**

2. **「零调用方」是本轮命中率最高的探针。** 我写了个全仓扫描（`export` 的标识符在**剥掉注释后**
   全仓零引用）：78 个零引用导出 + 17 个只有测试引用。第 2 类 15 条里有 **6 条**是它直接查出来的，
   而这 6 条在 35 份回执的文本里**一个字都没提** —— 因为没人认为自己写的东西没被接上。
   脚本在 `/tmp/backlog-sweep-orphans2.mjs`，**建议进 `scripts/`**。

3. **文案先于功能写好，是一张现成的地图。** `notes.rename` 在两份 locale 里躺了很多轮、**零处 `t()` 读它** ——
   `debt-cleanup` T-152 说过那 60 条死词条"最大的价值不是删掉，而是它是一张
   『哪些功能只写了文案』的地图"。这次照着地图找到了「笔记删不掉」。**那张地图还没走完。**

4. **「说话人分离归 ADR-016」是一处被全项目传播的错误归因。** ADR-016 通篇不含"说话人"/"diarization"
   字样，它的真实裁剪范围是 TTS / 本地 ASR 扩容 / 本地 LLM / 空间管理 / 代理配置。
   真正的依据是 **ADR-011 决策 6**。→ 建议订正 HANDOFF ⑥。

---

# §1 方法与去重口径（为什么这些数字可信）

## 1.1 四路并行

| 路 | 扫的 inbox | 原始条数 | 去重后计入 |
|---|---|---:|---:|
| `sweep-fe` | `architect`(161KB) · `ui-polish` · `models-page-fix` · `llm-picker` · `frontend-truth` · `test-host` | 32 | 32 |
| `sweep-rt` | `gpu-runtime`(128KB) · `platform` · `pack-publish` · `ci-runner` · `ci-prep` · `last-mile` · `vad-fix` · `win-fixes` · `ytdlp-install` | 39 | 39 |
| `sweep-be` | `oss-scout`(151KB) · `model-mgmt`(145KB) · `debt-audit`(123KB) + 13 份中小回执 | 26 (+5 未确认) | 19 |
| **我本人** | Manager 点名的 7 条 + 全仓结构化扫描 | — | 15 |

**去重口径**：同一件事在不同日期/不同 agent 的回执里反复出现 → 算一条，记最后一次被提到的时间。
跨路重复的只计一次，归先报的那一路，另一路记为「独立复核」。
`sweep-be` 的 26 条里有 7 条与其它路重复（`listInstalled` VAD 桶 ×2、llama.cpp 后端包、
macOS 无 ASR 后端、三个被裁平台、`models-llm.json` 的 5 条 GGUF），故只计 19。

## 1.2 判据：不许凭回执文字下结论

每条都对着**当前代码/清单/CI/运行中的 daemon** 核实。三种证据：
`[实测]` 跑过命令附输出 · `[读码]` `绝对路径:行号` · `[未能核实]` 明写出来（见 §5）。

### 两路给出了矛盾结论，我自己裁了

**`models-llm.json` 里 5 条 GGUF 到底用户看不看得见？**

- `sweep-rt` 说 🟡：「UI 上 `tab==='llm'` 只渲染 provider 配置，不渲染 GGUF 卡片，正常导航下不可达」
- `sweep-be` 说 🔴：「`[实测]` `curl GET /api/models/catalog` **它们现在就在响应里**，用户会看到 4 组可下载的本地权重」

**两条都是真的，但结论不同 —— 我自己去核了渲染那一端**：

```
[实测] curl /api/models/catalog → 20 组，其中 #4 #5 #6 #7 的 role 全是 'llm'（确实在发）
[读码] ModelsPage.tsx:73  const ASR_TAB_ROLES = ['asr','vad','punctuation']
       ModelsPage.tsx:128,139  .filter(g => ASR_TAB_ROLES.includes(g.role))   ← 两个渲染点都滤掉了
```

→ **裁定 🟡（第 3 类）**：清单与 API 仍在对外提供与 ADR-016 矛盾的内容，但产品 UI 上到不了。
`sweep-be` 那句"用户会看到 4 组可下载的权重"**不成立**，已撤下。
（记在这里是因为：「端点还在发」和「用户看得见」是两件事，**只查一端就会得出相反的排期结论**。）

### 踩到并绕开的陷阱

- **`grep -r` 静默跳过含 NUL 的文件**：判「零命中」前先 `file` 确认目标可 grep。
  例：判定 Windows `taskkill` 缺失前，先确认 `runner.ts` 是 `UTF-8 text`（296 行，无 NUL）。
- **剥注释再断言**：零调用方扫描用的是**剥掉块注释与行注释后**的文本 —— 否则
  `features/components/api.ts:5` 那句提到 `stashForRollback` 的注释会让它看起来"有调用方"。
- **`git ls-files 'apps/*/src/**/*.ts'` 会漏掉 `src/` 第一层的文件**（`main.ts` 就在里面）。
  第一版扫描因此报出 251 个假阳性，连 `createNoteRoutes` 都成了"零调用方"。
  **判据自检救了它**：我拿一个"不可能没有调用方"的名字去对照，当场发现文件清单是残缺的。
  → **工具静默返回空集 ≠ 没有；先证明你的探针能看见你已知存在的东西。**
- **我自己差点报出一条假的**：以为 `warningsZh`（VAD 降级警告）到不了用户。追下去发现
  `vadHealth()` 走 `/api/health` **是通的**，`[实测]` demo 上就是
  `{chunking:'fixed', reasonZh:'未安装 VAD 模型 → 切分降级为固定窗口'}`。**已撤回。**

## 1.3 反向验证一律跑在 `/tmp` 隔离副本（PROTOCOL §10）

**没有在共享工作树里拆过任何一次修复**，所以不存在"别人在那一秒跑了一次"的窗口。逐组输出见 §RV。

---

# §2 🔴 第 2 类：仍开着且用户能撞上 —— 排序表（可直接拿来排期）

已修 4 条见 TL;DR。**下面 11 条按「用户最快撞上」排序。**

排序判据：**「点得到但恒不可用」排在「压根没有」前面** —— 前者同时消耗用户的信任和排查时间，
后者至少是诚实的。平台特定的排在全平台之后（除非后果是数据不可见）。

| # | 项 | 用户会看到什么 | 平台 | 归属 | 动哪些文件 | 规模 |
|---:|---|---|---|---|---|---|
| **1** | **`openmemo-probe` 没有任何分发通道** | `[实测]` 全仓 manifest 的 `providesFiles` 里**没有任何包带这个可执行文件**（CPU 包只有 `whisper-cli`），而 `selfcheck.ts:529` 的补救文案写着"安装后端包后会带上 openmemo-probe"。于是目录里**已经能点**的 `whispercpp-cuda-12.4-win-x64` 永远显示"尚未探测到硬件能力"，装了 CPU 包重探也不变。**有 N 卡的 Windows 用户拿不到任何加速。** demo 上 `hw.probe` 现在就是 warn | 全平台 | `gpu-runtime` + `pack-publish` | `vendor/manifests/backends.json`（给它条目，或塞进 CPU 包的 `providesFiles`）· `build-backends.yml` | M |
| **2** | **笔记超过 50 条之后，第 51 条起在界面上永远看不到** | `[读码]` `GET /api/notes` 只认 `limit`（默认 50 / 上限 200）、`starred`、`folder` —— **没有 `offset` / `cursor` / `page`**；`useNotesQuery` 又根本不传 `limit`。也就是说列表页恒定只有前 50 条，**没有翻页、没有"加载更多"、没有总数、一个字的提示都没有**。F5「笔记管理」是章程功能，而它在第 51 条上静默失效 | 全平台 | `oss-scout` + `architect` | `apps/daemon/src/http/rest/notes.ts` + `repos.listNotes()` 加游标 · `features/notes/{api.ts,NotesListPage.tsx}` | M |
| **3** | **下载源（镜像）UI 完全没有** | `useModelsSourcesQuery` / `useSourceProbeMutation` **零调用方**，而且**根本没有 `select` 的 hook**。daemon 三个端点全是真的（`[实测]` `GET /api/models/sources` → 200 `{selected:"auto",effective:null,probes:[]}`）。HF 不通时用户看到"所有下载源均失败"（我刚让它变成中文）**却没有任何自救入口** | 全平台，大陆用户尤甚 | `model-mgmt` + `architect` | `features/models/` 新一个 Section · `api.ts` 补 `useSelectSourceMutation` | M |
| **4** | **组件「回滚」永远不可用** | 前端有完整回滚 UI（`ComponentCard.tsx:165`「回滚到 {version}」+ 确认 + mutation），daemon 有端点，`listComponents` 会扫 `.prev-<version>` 目录 —— 但**创建那个目录的 `stashForRollback` 零调用方**。于是 `rollbackVersion` 恒为 `null`，按钮**永远不出现**。上游一次发布换格式就把组件换坏时（VAD 那次已经真的发生过），用户没有退路。⚠️ `components.ts:86` 注释写着「The installer parks the superseded tree as `<name>.prev-<version>`」——`[实测]` `installer.ts` 里 `.prev` **零命中**，注释在说谎 | 全平台 | `model-mgmt` | `packages/downloader/src/{installer,components}.ts` | M（**需先裁决**，见 §决策 1） |
| **5** | **Linux/Win 的 Vulkan/CUDA 加速包编出来了但没进目录** | 有 Vulkan/CUDA 能力的 Linux 用户、有 Vulkan 的 Windows 用户在模型页**只看得到 CPU**。根因两条且都实测过：Vulkan 包需要 `GLIBC_2.38`（Ubuntu 22.04=2.35 / Debian 12=2.36 加载失败）；增量包的导入表依赖另一个包目录里的 `ggml-base.dll`，**不自包含** | Linux / Win | `pack-publish` | `build-backends.yml` · `scripts/build-whisper.sh` | L |
| **6** | **Windows 上子进程树杀不干净** | 转写超时/取消后，ffmpeg / yt-dlp 派生的 helper 进程残留，占 CPU 或锁住输出文件，直到用户手动结束。⚠️ `runner.ts:190` 注释写着「On Windows this is emulated via **taskkill** below」——`[实测]` 全仓 `taskkill` **只有这一处注释，零实际调用**；win32 分支就是光秃秃的 `child.kill(sig)` | Win | `gpu-runtime` | `packages/pipeline/src/subprocess/runner.ts`（真调 `taskkill /T /F /PID` 或用 Job Object） | S |
| **7** | **macOS Gatekeeper 的 quarantine 属性从未被摘掉** | mac 用户网页装完后端包，首次运行可能被拦（"无法验证开发者" / "已损坏"）。D-04 §7 把"daemon 下载后自动 `xattr -dr com.apple.quarantine`"写成了设计，`[实测]` 全仓 `xattr`/`quarantine` **0 命中**，从未落地 | macOS | `pack-publish` | `packages/downloader/src/installer.ts` | S |
| **8** | **Windows 上传超限/格式不支持显示"网络错误"** | 用户看到含糊的"网络错误"，而不是"文件超过大小限制"。根因是 `upload.ts:794-814` 的半关闭 socket 缓解在 Windows 上会漏（CI run 31039060738 间歇复现 ECONNRESET） | Win | `oss-scout` | `apps/daemon/src/http/upload.ts` | M（**是设计取舍**，`win-fixes` 自己说"不该顺手动"） |
| **9** | **`GET /api/health` 的 `host` 硬编码 `'127.0.0.1'`** | `[读码]` `server.ts:121` 就是字面量，而 demo 实际绑 `0.0.0.0:10000`。任何读这个字段判断"是不是只绑回环"的人或脚本会得到**相反的安全结论** —— 而这恰是 T-111 反复强调的那个前提。HANDOFF ⑥ 上一版就报过，至今未修 | 全平台 | `oss-scout` | `apps/daemon/src/http/server.ts:121`（回填真实 bind 地址，或改名并另加字段） | S |
| **10** | **job 的 `result_json` 写得进读不回**（⑤C 家族第 N 例） | `queue.succeed()` 里存着 `mergeSummary` / `warningsZh` / `rtf` / `chunking` / `segmentCount`，`[读码]` **没有任何端点或事件把它交出去**：`PipelineJob` 没有 result 字段，`scheduler.ts:208` 只从里面抠一个 uid。症状：离线重跑合并完，横幅只说"已保留 N 段"，说不出"已更新 N 段" | 全平台 | `daemon-contract` + `architect` | `packages/shared/src/jobs.ts` · `apps/daemon/src/jobs/events.ts` · `RecorderPage.tsx` | S |
| **11** | **转写稿内搜索 / 折叠 / J·K·L 快捷键缺失** | `TranscriptList.tsx` 自称要处理"3 小时讲座 3000+ 段"，实际只有虚拟滚动 + 跟随播放 + 点击跳转。长稿子只能滚轮翻找 | 全平台 | `architect` | `features/transcript/{TranscriptList,SegmentRow}.tsx` | M（**这是新功能不是缺陷修复**，排最后是因为它不"坏"，只是"没有"） |

---

# §3 🟡 第 3 类：仍开着但无用户可见症状（21 条）

**不排期，但每条都写清了"什么时候会变成第 2 类"。**

## 🔺 这一类里最要紧的一条（是安全问题，不是洁癖）

| 项 | 现状 |
|---|---|
| **`packages/downloader/src/unpack.ts` 的软链目标校验是纯词法的，可以被绕过** | `[读码]` 全文件 `realpath`/`lstat`/`readlink` **0 命中**；`resolveLinkTarget()` 只做 `path.resolve` 字符串运算。构造：条目 ① `s` → 目标 `"."`（真实创建为指向 destRoot 自身的符号链接，`resolved===root` **通过检查**）；条目 ② `evil` → 目标 `"s/../OUTSIDE.txt"` —— 词法上 `s` 与 `..` 抵消，落在 `destRoot/OUTSIDE.txt`**通过检查**，但真实文件系统会**先解析 `s`** 再走 `..`，落到 destRoot 的**父目录**。**一次真实的沙箱逃逸。** 触发条件是解包一个恶意构造的归档包（供应链面），日常路径踩不到 —— 所以列在第 3 类，但**它是这一类里唯一一条我建议尽快排的** |

## 其余 20 条

| 项 | 现状 | 什么时候会变成 🔴 |
|---|---|---|
| ANE 的 `asr.coreml` 从 warn 变 ok **未在真机验证** | 接线三处都改好了（`4604f23`），但 `cold-start-audit` / `ci-crossplatform` 最近一次运行仍停在 T-153 之前 | 修错了的话 mac 用户 48× 延迟（实测 101.7s vs 2.1s）且无提示。**要一次 macOS runner** |
| `models-llm.json` 5 条 GGUF 仍在 `/api/models/catalog` 里发出去 | `[实测]` API 确实在发（4 组），但 `ModelsPage.tsx:128,139` 两个渲染点都按 `['asr','vad','punctuation']` 滤掉了 → UI 不可达。详见 §1.2 的裁定 | 任何直读 API/manifest 的集成、或有人放宽那个 filter 时 |
| `packages/shared` 的 engine 枚举仍留 `'llama.cpp'` 字面量 | 类型上允许构造一个被裁掉的值，但没有清单会产出它 | 有人照着枚举写新代码时 |
| DNS rebinding TOCTOU（SSRF 一次解析，fetch 独立重解析） | SECURITY.md 记为"本机单用户场景已接受的低优先级风险"。⚠️ `argGuard.ts:109` 注释引用的 `resolveAndCheck` **全仓不存在** | 一旦对外暴露且有多用户 |
| **根 `package.json` 的 `check` 脚本仍含 `pnpm -r build`** | 它含 `vite build`，会覆盖 `:10000` 在服务的 `dist`。`build:safe` 已存在但 `check` 没用它 | **这就是本轮被反复叮嘱"别跑 `pnpm -r build`"的成因本身。PROTOCOL §7 补充立的判据是"跑错了也不会造成后果"—— 这一条还没做到** |
| `whisperServer.ts` 是 pipeline 里第二处直接 `import node:child_process` | 绕开了 `runner.ts` 的守卫层（进程组 kill / 超时 / 参数校验） | 与 §2 #6 的 Windows taskkill 缺口叠加时 |
| Windows 上 `runtime.json`（鉴权 token）与 TLS 私钥用裸 `0o600`，实测等效 666 | 无 `win32` 的 ACL 分支 | 多用户 Windows 机器上，其他账户能读走 token |
| `move.ts` 的 `fs.cp({verbatimSymlinks})` 无 Windows EPERM 回退 | ⚠️ **CI 上结构性验不出来**：GitHub Windows runner 以管理员跑，天生有 `SeCreateSymbolicLinkPrivilege` | 普通 Windows 用户账户搬数据目录时 |
| `selfcheck.ts:571` 的 `fromStore` 前缀比较没有分隔符边界 | `p.startsWith(storeRoot)` 未补 `path.sep` → `<storeRoot>-backup/...` 会被算成"装在 store 内"（绿） | 同名前缀的兄弟目录真实存在时 |
| `migrateAssets.ts:81` 收着 `mediaRoot` 不用；`depth > 6` 截断无任何日志 | 深层嵌套目录里的资产会悄悄变得不可索引，没人报错 | 有人真的建了 7 层以上的资产目录 |
| `migrateRecords.ts` 从未给老安装记录回填 `role` | 全文搜不到赋值逻辑，只有两处类型声明 | 早于 role 字段引入的极老记录参与 role 分派时 |
| `modelStore.ts:230` `resolveExtensionDir` 兜底不识别 `.dll` | 只有全部链接失败才走到，今天走不到 | — |
| `cold-start-audit` 对照组 `[warm] tokenizer=undefined` | 未定性，很可能是审计脚本自己的日志解析 bug | — |
| T-150 新增的 3 块 UI 从未在真浏览器点过 | jsdom 通过 ≠ 真浏览器可用 | 需要一次能开浏览器的验证 |
| **`describeSpeed()` / `SPEED_CLASS_*` 零调用方** | HANDOFF ③「三条唯一出处约定」第 2 条写着「读的时候走 `describeSpeed()`，别自己读 `.rtf`」——`[实测]` **它零调用方**，UI 全走 `speedClass`（按体积人工分档的目录常量） | T-125 实测出来的 9/35 条 `measured` 证据**一条都没进 UI**，用户分不出"实测"和"估计" |
| **`statusTone.ts` 的 `jobStepTone`/`installStateTone`/`capabilityTone` 零调用方** | T-114 立的"状态色收拢成一份"，三个函数没有调用方 | 各渲染点自己挑颜色 → 就是这个文件头警告过的那种不一致 |
| `auth.ts` 的 `checkCsrf` 零调用方 | 真实现是 `checkCsrfDetailed`，这是遗留别名，**纯死码，不是安全洞**（我核实过） | — |
| **`markmap-lib` / `markmap-view` 是零 import 的依赖** | `[实测]` 全仓只有一句注释提到它们。与 T-153 删掉的 `wavesurfer.js` 同一族 | 供应链面 + 打包体积。动的是 `apps/web/package.json`（`oss-scout`）+ lockfile |
| `fromMarkdown`/`fromOpml`/`fromFreeMind` 只有测试引用 | 导图**导入**三种格式没有产品入口（导出是通的） | 章程 F4 只要求"可导出"，所以不算缺陷 |
| 全仓另有 **78 个零引用导出 + 17 个只有测试引用的导出** | `debt-cleanup` 复核过其中 32 个、刻意没删（有几个是有意留的） | 扫描脚本见 §6 |

---

# §4 ⚫ 第 4 类：已被决策取消（8 条）

| 项 | 依据 | 核实 |
|---|---|---|
| `linux-x64-rocm`（AMD ROCm） | **用户 2026-08-05 当面裁掉** | `build-backends.yml` 矩阵已删；`backends.json` 无 rocm 条目；上游 whisper.cpp 本来也不发 ROCm |
| `linux-arm64`（cpu + vulkan） | 用户 2026-08-05 裁掉 | 矩阵已删。D-11 §2.1 记着"被删的这两个 job 是本轮唯二全绿的 Linux job" |
| `macos-x64`（Intel Mac） | 用户 2026-08-05 裁掉 | `build-backends.yml` / `ci-crossplatform.yml` 矩阵均已删（后者 4 → 3） |
| 内置 llama.cpp 本地 LLM（7 个包） | ADR-016 §3「只留在线，砍掉内置」 | 清理由 `07584d9`(T-144①) 完成，submodule 已摘，`ytdlpInstall.test.ts` 有守卫断言 `engine==='llama.cpp'` 的包必须为空。⚠️ **模型目录侧的 5 条 GGUF 未清**，记在第 3 类 —— **裁决≠清理已完成，两者分开记账** |
| TTS | ADR-016 §1 | 原文"不做"，整体裁剪 |
| 本地 ASR 模型族扩容（sherpa 多模型分派 / SenseVoice / Qwen3-ASR / AMD ASR 自建 CI） | ADR-016 §2 | 原文"不再扩容，但已做的保留" —— Paraformer 与 sherpa 流式 zh-14M 保留 |
| 「可导入任意 HF GGUF」（`kind:'hf_repo'` 硬编码 501） | ADR-016 附录「改口径不补实现」 | `models.ts:745-752` 仍是 501，注释理由与裁决一致 —— **是决定不做，不是没做完** |
| **说话人分离**（`speakerLabel` 恒 null） | **ADR-011 决策 6，不是 ADR-016** | ⚠️ **本轮唯一一处认知订正**：`ADR-016-user-scope-cuts.md` 通篇不含"说话人"/"diarization"字样。真正依据是 `ADR-011:82-84`「章程 F1–F5 未包含…D-02 已预留表，保留不实现」 |

---

# §5 ❓ 明说没查清的 5 条（**留白，不猜进某一类**）

| 项 | 为什么没查清 |
|---|---|
| debt-audit C19「job 的 kind/type 字段重复」 | `events.ts` 里 `pipelineKindOf(type)` 与独立 `type` 字段共存，判不出是有害重复还是合理的派生视图 |
| debt-audit A11「扩展名白名单不一致」 | 在 `notes.ts`/`storage/*.ts` 搜 `extname`/`ALLOWED_EXT` 0 命中，**定位不到原条目所指的代码位置** |
| debt-audit C5「SSE reason 取值不一致」/ C9「dead `x.*` 事件」 | 需要 daemon 发送方与前端监听方交叉核对，跨两路职责，为避免结论冲突未重复核实 |
| debt-audit D1–D14 文档债系列 | 确认了 T-152 那批提交存在（`08d61b5`/`0c22d86`/`8f54b51`），但未逐条比对现存文档文本 |
| daemon 测试脚本 glob 引号 bug / 4 个曾不跑的测试文件 / 7 条过时 auth 用例 | `auth.ts` 的注释用过去时描述"两条 CSRF 边界用例已经变红"，暗示已随 `authMode()` 改造解决，但未逐一重跑确认 |

---

# §6 我修的 4 条 —— 成因与判据

## 6.1 `b97bed6` T-151 的 3 个文件从来没被提交

`daemon-contract` 的 T-151 回执**逐行列出了 17 个该 add 的路径**（`inbox/daemon-contract.md:295-312`），
`2a45694` 只装进 14 个。漏的三个：

```
apps/daemon/src/jobs/runners/transcribe.ts    ③ 转写后产 peaks（+ deps.dataDir）
apps/daemon/src/main.ts                       两处 deps 补 dataDir
apps/daemon/src/storage/migrateAssets.ts      ① canonicalRel 改用共享那一份
```

**判据不是"文件在不在"，是"后果还在不在"**：
`[实测]` `git grep -n generatePeaksAsset HEAD` 在提交前只有 `ws/recorder.ts` **一个**调用方。
即：浏览器录音有真波形，**F1 链接导入 / F2 本地文件导入的笔记一条都没有** —— 而这两条恰恰是
用户最常走的路。commit message 写着「真波形」，一半的用户路径上它不存在。

顺带：`migrateAssets.ts` 仍带着自己那份 `canonicalRel`。T-151 ① 声称"三个写入方共用同一份"，
落地的只有两个 —— 而这一列的全部意义就是"搬家之后还读得回来"。

## 6.2 `b017fc3` 下载失败时中文界面显示的是英文

`JobList.tsx:115` 是 `i18n.language.startsWith('zh') ? job.error.messageZh : job.error.message`，
而 `queue.ts:206` 把**同一个英文串**同时塞进两个字段。中文用户看到的是
`All download sources failed` / `Access denied (403)` / `Disk full` / `Permission denied`
（四条都是 `download.ts`/`http.ts`/`installer.ts` 真实抛出的原文）。

`ERROR_MESSAGES_ZH` 那 16 条中文 + `ERROR_RETRYABLE` 那 16 条可重试性，**全仓零调用方**。
顺带修好第二半：`retryable: err.retryable ?? false` 让一次**可重试**的失败（超时/限流/换源可救的
校验失败）被报成不可重试 → 界面上没有重试入口。现在兜底查码本。

**刻意的例外**：`INTERNAL` 与未登记的码保留原始 detail。`INTERNAL` 的字面意思就是"我不知道发生了什么"，
此时 detail 是唯一线索，翻成"内部错误"是把仅有的信息换成一句废话。

## 6.3 `76e2749` 笔记删不掉、改不了名

`useDeleteNoteMutation` / `useRenameNoteMutation` / `useMoveNoteMutation` 早就写好了，
daemon 三个端点也都是真的，**缺的只有调用方**：全仓对这三个 hook 的引用只有
「定义」和「`index.ts` 再导出」。而同一个页面上，**侧栏的「文件夹」有删除按钮**
（`FolderTree.tsx:155`）—— 容器能删，里面的东西不能删。

**顺带查出一个会静默失败的错端点**：`useMoveNoteMutation` 发 `PATCH /api/notes/:uid {folderUid}`，
而 `rest/content.ts` 的 PATCH 处理器**根本不读 `folderUid`**（只认 title/bodyJson/bodyText/
summaryMd/language/anchors），然后照样回 `200 {ok:true}`。真实端点是
`PUT /api/notes/:uid/folder`（`rest/organize.ts:419`）。
**它能错这么久正是因为它零调用方** —— 没人走的路上的坑不会有人掉进去。

**不用 `window.confirm`**：jsdom 不实现它（打一行 "Not implemented" 返回 undefined），
于是组件测试里"点了删除"永远走不到删除那一步，测试会以"确认框返回假"的名义变绿 ——
⑤A 那一族，一条永远不会失败的断言。确认态做成组件自己的状态。

---

# §RV 反向验证（**全部跑在 `/tmp` 隔离副本上**，PROTOCOL §10）

**没有在共享工作树里拆过任何一次修复。**

## RV-1 downloader（`/tmp/backlog-sweep-rv/`：`cp -a` 出的 `packages/{downloader,shared}` + 软链根 `node_modules`）

```
基线                                   10 pass / 0 fail
① messageZh 改回 detail（事故原状）      ★ 3 条红   → 10 pass 7 / fail 3
② retryable 改回 ?? false               ★ 1 条红   → 10 pass 9 / fail 1
还原                                    10 pass / 0 fail
```

## RV-2 web 组件（`/tmp/bs-rv-web/`：`cp -a` 出的 `.test-out` + 软链 `apps/web/node_modules`）

在**编译产物**上做变异，每次都先确认坏行确实在即将运行的那份 bundle 里：

```
基线                                        T-155 6 条全绿
① 确认按钮不再发请求（菜单长得一模一样）        ★「点删除→二次确认→真的发出 DELETE」红
② 重命名不发请求                              ★「输入新标题回车→PATCH」红
③ 移动改回 PATCH /notes/:uid（缺陷原状）        ★「移动打的是 PUT …/folder」红
三次还原                                     6 条全绿
```

变异 ① 是这组里最要紧的一条：它证明断言钉的是**请求真的发出去了**，
而不是"菜单里有个删除字样" —— 后者在变异 ① 下照样绿。

⚠️ 第一次尝试变异时我用 `sed` 改产物，**改完测试一条都没跑**（语法坏了）。
如果只看"没有红"就会得出"变异不起作用"的错误结论 —— 所以每次变异后都先确认
**套件本身还在跑**（6 条都在），再看红了几条。

---

# §7 交出的工具与清单

- **`/tmp/backlog-sweep-orphans2.mjs`** —— 全仓零调用方扫描（**剥注释**、区分「零引用」/
  「只有测试引用」/「只有 index 再导出」）。本轮第 2 类 15 条里有 **6 条**是它直接查出来的，
  而这 6 条在 35 份回执文本里一个字都没提。
  **建议进 `scripts/`**，理由与 `check-tracked-sources.mjs` 同：这类缺陷不会有人主动报告
  （没人认为自己写的东西没被接上），只能靠机器扫。
  ⚠️ 用之前先验它的文件清单是不是完整的 —— 第一版用 `git ls-files 'apps/*/src/**/*.ts'`
  漏掉了 `src/` 第一层，报出 251 个假阳性。
- `/tmp/bs-fulltest.log` —— 1100/0 的完整输出。

---

# §需要 Manager 决策

1. **第 2 类 #4（组件回滚）需要一个产品裁决再动手**：`stashForRollback` 会把旧版目录整个留在盘上，
   后端包动辄几百 MB。要不要留、留几份、什么时候丢（`discardRollback` 同样零调用方）？
   裁决之前我没动它 —— 但**现在这个状态是最坏的**：UI 承诺了回滚、代码保证它永远不可用。
2. **第 3 类那条 unpack 软链逃逸建议提前排**（是安全问题不是洁癖）。修法明确：
   校验改成基于 `realpath` 而不是 `path.resolve` 字符串运算。
3. **`markmap-lib` / `markmap-view` 两个零 import 的依赖要不要删**（同 T-153 删 wavesurfer 的先例）。
   动 `apps/web/package.json`（`oss-scout` 地界）+ lockfile，我没碰。
4. **根 `package.json` 的 `check` 脚本仍含 `pnpm -r build`**。PROTOCOL §7 补充立的判据是
   "跑错了也不会造成后果" —— 这一条还没做到。建议改成 `build:safe`。
5. **ANE 真机验证需要一次 macOS runner**（`cold-start-audit`/`ci-crossplatform` 停在 T-153 之前）。
6. **「说话人分离归 ADR-016」这个错误归因已在多处传播**（见 §4），建议在 HANDOFF ⑥
   「已明确裁决」那节把依据订正为 ADR-011 决策 6。
7. **HANDOFF ③ 的「三条唯一出处约定」第 2 条与现实不符**（`describeSpeed()` 零调用方，
   UI 全走 `speedClass`）。这与 ⑤K 那次「一条从未被任何断言覆盖过的规范，很可能从落笔那天起就是错的」
   同形 —— 要么补断言，要么改规范。

---

# §越界与申报

**动了别人的地界，逐条申报**（相关 agent 当时均未在跑，只有 `ci-upload` 与 `docs-public` 在）：

| 路径 | 归属 | 说明 |
|---|---|---|
| `packages/downloader/src/queue.ts` + 新增 `queue.test.ts` | `model-mgmt` | |
| `apps/web/src/app/i18n/locales/{zh-CN,en}.json` | `frontend-truth` | **只在 `notes` 段插了 4 个键，没有重排任何已有键** —— diff 就是 +4 行 |
| `apps/web/src/features/{notes,folders}/**` + `test/components.test.tsx` | `architect` | 新增 `NoteActionsMenu.tsx` |
| `apps/daemon/src/{main.ts,jobs/runners/transcribe.ts,storage/migrateAssets.ts}` | `oss-scout` | 内容是 `daemon-contract` 写好且已列进它自己提交清单的，我只是把漏掉的补提交 |

**没碰**：`.github/**`、`scripts/ci/**`（`ci-upload` 在跑）、`README.md`、`docs/DEPLOYMENT.md`
（`docs-public` 在跑）、`HANDOFF.md`、`docs/00-CHARTER.md`、`coordination/{BOARD,ROSTER}.md`、
任何 `docs/adr/**`。
