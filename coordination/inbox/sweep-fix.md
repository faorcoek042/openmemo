# inbox / sweep-fix

## [2026-08-06 21:40] T-157 DONE —— `backlog-sweep` 剩下 11 条里最急的四条，全部完成

交付：**5 个提交**，逐个 `git add` 精确清单，**一次 `-A` 都没用过**。

| 提交      | 项   | 一句话                                                                 |
| --------- | ---- | ---------------------------------------------------------------------- |
| `4511e0b` | ①    | unpack 软链校验从词法改成解析后复核 —— **一次可复现的任意文件写**      |
| `6517f90` | ③    | 笔记列表能翻页了 —— 第 51 条起此前在界面上永远看不到                   |
| `a3afc99` | ④    | 下载源（镜像）UI —— 三个端点全真、前端两个 hook 零调用方               |
| `efe8fd4` | ②    | 拿掉"一键回滚"这句假话，**顺带修掉一条真 bug：更新失败会毁掉当前安装** |
| `1b0675b` | 门禁 | 「零调用方」扫描固化进 `scripts/` 并接进 `pnpm check`                  |

门禁：`tsc -b` **0** · `eslint .` **0** · `pnpm -r test` **1138 passed / 0 failed**
（开工基线 1100，我贡献 **38 条**：downloader +17 / daemon +6 / web +15）。
`pnpm check` 全绿。

---

# TL;DR（Manager 只读这里）

1. **① 的可利用性，准确结论：外部 HTTP 访问者不能触发；但它是一次真实的沙箱逃逸，
   而且比"越界读"重 —— 我复现的是**任意文件写**。**
   修复前的产物上，`destRoot` 之外的文件内容从 `SECRET-OUTSIDE-DESTROOT`
   被归档改写成了 `PWNED-BY-ARCHIVE`。**触发它需要先控制那个归档**：
   `unpackArchive` 全仓只有一个生产调用方（`install()`），`install()` 只有两个
   （后端包 / 模型拉取），两者的 `files` 都来自 `vendor/manifests/*.json` ——
   git 里钉死、zod 校验、https + 编译期 host 白名单、**每个文件的 sha256 在解包之前就已校验**。
   `[实测 grep]` 没有任何端点接受用户提供的 URL / 镜像 / manifest
   （`hf_repo` 导入是 501，`local_file` 导入**根本不走 unpack**）。
   → 准确表述：**这是供应链方向的最后一道闸**。它挡的是"一个被污染的后端包发出去了"
   与"以 daemon 的 uid（demo 上是 root）在模型库之外任意写文件"之间的那一步。
   **不是**"demo 此刻正在被利用"。

2. **② 我选了"拿掉 UI"，理由不是"回滚不重要"，是接上会造出一个更坏的东西。**
   实测发现坏的是**三处**不是一处（`.prev-` 从没被创建 + 索引键是目录名而查表键是组件 id，
   4 个已装组件里 3 个不同 + `rollback()` 也按 id 拼路径）。而现在接上会：
   让 `findInBackendPacks` 在 `.prev-*` 里挑到**旧二进制**（谁赢看 readdir 顺序）、
   几百 MB 无人回收也不进存储统计、模型是单文件会被 rename 成"不见了"。
   **要做完的四件事逐条写进了 `components.ts`。**
   ⚠️ **顺带查出并修掉一条真 bug**：`install()` 的 catch 里有 `fs.rm(finalDir)` ——
   temp-then-rename 之前的遗留清理，今天它删掉的是**上一版完整的安装**。
   于是「更新一次、解包失败」= 组件从"旧版可用"直接变成"没装"。
   修掉之后「更新失败不破坏当前版本」第一次成为真的，确认框可以照实说。

3. **门禁已固化**：`scripts/check-orphan-exports.mjs` + `scripts/orphan-exports-baseline.json`，
   接进 `pnpm check`。判据是**只准变少**的棘轮（新条目红；基线里已被接上的条目**也红**）。
   ⚠️ **顺带改了 `check` 一处，请知悉**：`pnpm -r build` → `tsc -b && pnpm build:safe`
   （见 §5，一个词可以改回去）。

4. **三条"我没做到/没验到"，写在前面**（详见 §6）：
   - ③ 排序次级键 `n.id DESC` **没能被任何用例证伪**：这台机器上的 SQLite 对该查询计划
     恰好稳定，我造不出能判定它的用例。它是**规范收紧**，不是被覆盖的行为。
   - ① 的**完整利用链没有构造**：我只证明了 unpack 这一级的原语，没有做出一个
     能通过 sha256 校验的恶意归档端到端跑通（那需要控制上游产物）。
   - ④ 的 `SourcesSection` 只在 jsdom 里点过，**没在真浏览器里点过**。

---

# §1 ① `unpack.ts` —— 可利用性说准，修法照本仓既定形状

## 1.1 先把机制说清（我复现了，输出在下面）

`resolveLinkTarget` 用 `path.resolve` 判断链接目标在不在 `destRoot` 内，
而 **`path.resolve` 按字面折叠 `..`，内核先跟随软链再折叠**：

```
s     -> "."                  词法 = destRoot 自己        → 放行
evil  -> "s/../OUTSIDE.txt"   词法 = destRoot/OUTSIDE.txt  → 放行
                              内核 = <destRoot 的父目录>/OUTSIDE.txt  🔴
```

`[实测]` 修复前的产物（`packages/downloader/dist/unpack.js`，`grep -ac realpath` = 0），
在 `/tmp` 隔离副本上喂进一个手搓的 tar.gz：

```
=== 攻击 A：条目 s(→".") → evil(→"s/../OUTSIDE.txt") → evil（普通文件）===
  unpack 成功返回（没有拒绝）
  ★ destRoot 外 OUTSIDE.txt 的内容 = "PWNED-BY-ARCHIVE\n"     ← 原本是 SECRET-OUTSIDE-DESTROOT
```

**这不是越界读，是任意文件写** —— 第三个条目是一个同名的普通文件，
`fs.writeFile` 穿过那条软链写到了 destRoot 之外。`path-guard` T-143 §4.2 A2 当时
只证到"词法说在内、内核读到了外"，写这一半是本轮补上的。

还有第二个形态，**只有"解包后复查"抓得住**：

```
=== 攻击 D：evil 在前、s 在后，且不写穿 ===
  修复前：unpack **成功返回**
  ★ 解包结束后，通过 destRoot/evil 读到 = "SECRET-OUTSIDE-DESTROOT\n"
```

即：解包"成功"，而 destRoot 里从此有一条通往外面的门 —— 之后任何遍历包目录的代码
（`findInBackendPacks` / `findFileInBackendPacks` / sqlite 扩展链接）都会跟过去。

## 1.2 谁能把一个恶意归档喂进解压流程 —— 逐条追出来的

| 路径                                 | 能不能                                    | 依据                                                                                                                                       |
| ------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `unpackArchive` 的调用方             | **只有一个**                              | `[实测 grep]` 全仓生产代码里只有 `installer.ts:243`                                                                                        |
| `install()` 的调用方                 | **只有两个**                              | `backends.ts:143`（后端包）、`models.ts:417`（模型拉取）                                                                                   |
| 这两处的 `files` 从哪来              | **`vendor/manifests/*.json`，git 里钉死** | zod 校验 + `ALLOWED_DOWNLOAD_HOSTS` 编译期白名单（只 https）；**sha256 在 `downloadFile` 里解包之前就已校验**                              |
| `POST /api/models/import`            | **到不了 unpack**                         | `hf_repo` → 501（`models.ts:748`，ADR-004 决策 5）；`local_file` → 只 `copyFile` 进 blob + `linkByName`，**没有任何 unpack 分支** `[读码]` |
| `POST /api/notes/import`（任意 URL） | **到不了 unpack**                         | 走媒体流水线（yt-dlp/ffmpeg），不经过 downloader                                                                                           |
| 换 manifest 目录                     | **要能设进程环境变量**                    | `OPENMEMO_MANIFEST_DIR` / `OPENMEMO_COMPONENTS_MANIFEST`，HTTP 客户端设不了                                                                |
| 自定义下载源                         | **不存在**                                | `sourceBaseUrl` 存得下来但**全仓没有任何下载路径读它**（见 §4）                                                                            |

**所以：**

- **不夸大**：一个鉴权关闭、绑 `0.0.0.0`、NAT 外可达的外部访问者**不能触发它**。
  说"demo 正在被利用"是不成立的。
- **也不轻描淡写**：机制是真的、复现是真的（**任意写**，不是任意读）、
  修复只是把一处词法比较换成解析后复核。它挡的是**供应链那一步**：
  一旦有一个被污染的后端包发出去（或有人改了盘上的 manifest），
  它就是"以 daemon 的 uid 在模型库之外任意写文件"——**demo 上 daemon 跑在 root 下**。
  照 `path-guard` 给的范本：这是**第二阶段放大器**，不是此刻正在漏东西。

## 1.3 修法（照 `assetPaths.ts` T-143 ① 的形状）

- 新增 `walk()`：**自己走 `lstat`/`readlink`**，容忍尾段不存在（tar 会先给
  `libwhisper.so` 再给它的目标）。
- 每个**条目落点** + 每条**链接目标**都过 `resolveWithinRoot()`；根用同一个 walker 解析。
- **解包结束后再复查一遍所有创建的链接** —— 条目顺序是攻击者选的（攻击 D）。
- 词法那一半 `platform` 提成入参（照 `store.ts:63` 的范式）。

**三个踩过的坑，写进了代码注释**（每个都是实测出来的）：

1. **`path.join`/`path.resolve` 会先把证据毁掉**：`path.join(d,'s','..','x')` 直接返回 `d/x`，
   逃逸在任何 syscall 发生之前就消失了。所以 walk 里对 `..` 一律走 `dirname(cur)`，
   绝不跨着 `..` 做 join。
2. **`fs.realpath` 不是内核**。`[实测]` 对同一条未折叠的路径：
   ```
   fs.realpathSync         → 抛 ENOENT
   fs.realpathSync.native  → /tmp/rp2-EkpKJ7/OUTSIDE.txt   （逃逸出去了）
   fs.readFileSync         → "X"                            （真的读到了）
   ```
   建在 `fs.realpath` 上的守卫会**在这里碰巧 fail-closed、在别处 fail-open**。
   （`path-guard` 记过"realpath 报 ENOENT"，本轮查清了它的成因：JS 实现与 native 不同调。）
3. **根必须用同一套规则解析**，否则数据目录一是软链就全盘误杀（T-143 ① 踩过）。

**没有误杀**：whisper.cpp 上游 tarball 的两级同目录 `.so` 链、数据目录里 `bin/ext/*`
那种带 `../..` 的相对链，各有用例钉着照常解析。
（`[实测]` `/root/data-memo` 里现存 11 条软链：8 条 whisper-bin 的同目录 `.so` 链 +
3 条 `bin/ext/*` 的两级 `../..` 链，两种形态都进了用例。**只读 `find`，一个字节没动。**）

---

# §2 ③ 笔记翻页

- daemon：`?offset=`，响应加 `total` / `limit` / `offset` / `hasMore`，显式标注成
  `ListNotesResponse`（**该契约此前零引用**）。`countNotes()` 与 `listNotes()`
  共用同一份 WHERE。排序补 `n.id DESC`（见 §6.1 的诚实说明）。
- web：`useInfiniteQuery`；页脚**常驻**一行「已显示 M / N 条」/「共 N 条，已全部显示」。
  **一页装得下时也要说话** —— 只在 `hasMore` 时才出声的话，用户分不出"就这些"和"被截断了"，
  而分不出正是这条缺陷的本体。

两个刻意的取舍：**不发 `limit`**（每页多少条只有 daemon 一个出处，
`getNextPageParam` 按实际返回条数推进，daemon 改默认值也不会跳着漏）；
**第一页不发 `offset=0`** —— 于是 `?starred=1` / `?folder=` 那两族用例的请求**逐字未变**，
`architect` 那 15 处桩一个都没动。

⚠️ **自己写的用例当场抓到我一次**：`offset` 校验第一版用 `Number(raw)`，
而 **`Number('')` 是 0** —— `?offset=` 被静默当成第一页，恰好是那段注释说不许发生的事。
已改成正则 + `Number.isSafeInteger`。

---

# §3 ② 组件回滚 —— 裁决与理由

## 3.1 现状比"没有回滚"更糟的那一半，其实不在按钮上

`ComponentCard:165` 的 `{c.rollbackVersion ? … : null}` —— `rollbackVersion` 恒为 null，
**这个按钮一次都没渲染过**，用户根本没见过它。
用户真正接触得到的是更新确认框里那句：

> · 旧版本会保留，出问题可以一键回滚

**它每次点更新都会说，而且是假的。** 所以最高价值的修复是这句话。

## 3.2 为什么不接上（四条，都实测过）

1. **`by-name/backend/` 是工具发现的搜索路径。** `pipeline/tools.ts` 的
   `findInBackendPacks()` 枚举该目录下**每一个**子目录（两层），取**第一个命中**
   （注释写着"newest first"，实际是 `readdir` 顺序）。多一个
   `whisper-bin-ubuntu-x64.prev-v1.9.1/`，`whisper-cli` 就有两个候选 ——
   **静默跑到旧二进制上**，本仓最贵的那类 bug。
2. **磁盘无人回收**：后端包最大 678 MB；`collectGarbage` 只认
   `orphan_blobs`/`stale_partials`，`buildStorage` 不统计 `.prev-*`，
   `discardRollback` 同样零调用方。
3. **索引键 ≠ 查表键**：`readRollbackVersions` 用**目录名**（= 归档名去扩展名），
   `listComponents` 用**组件 id**。`[实测]` `/root/data-memo/models/by-name/backend/`
   里是 `whisper-bin-ubuntu-x64` / `libsimple-linux-ubuntu-22.04` /
   `sqlite-vec-0.1.9-loadable-linux-x86_64` / `media-tools-linux-x64`，
   而组件 id 是 `whispercpp-cpu-linux-x64` / `libsimple-linux-x64` /
   `sqlite-vec-linux-x64` / `media-tools-linux-x64` —— **4 个里 3 个对不上**。
   `rollback()` 也按 id 拼路径，同样对不上。
4. **模型是单文件**：`rollbackKindOf('model')==='asr'`，而 `by-name/asr/ggml-base-q5_1.bin`
   是文件不是目录，`fs.rename` 会把它改名成 `xxx.bin.prev-<v>` → "模型不见了"。

要真做回滚需要的四件事（把备份挪出 `by-name/`、GC + 存储统计、保留策略、区分单文件与目录）
**逐条写进了 `components.ts` 的 `stashForRollback` 上方**，并登记进了 orphan 基线的 note。

## 3.3 拿掉之后失去了什么 —— 想清楚了，答案是"零"，然后补了一条真的

- **能力上失去零**：按钮本来就不渲染，端点本来就恒 409。
- **失去的是意图标记** → 已写进代码注释 + 基线 note + 本回执。
- **补上的是一条真保证**：`install()` 的 catch 里那句 `fs.rm(finalDir)` 会毁掉
  上一版完整的安装（三条失败路径逐条走过，没有一条需要它）。删掉之后
  「更新失败不破坏当前版本」第一次成立，确认框现在照实说这句 + 「成功后无法回退」。

---

# §4 ④ 下载源 UI

`GetSourcesResponse` 加 `available`（= 目录里真实出现过的 provider，由 daemon 算）。
没有它，前端只能写死一张会漂移的表，或者在用户点过测速之前什么都不显示。

新增 `useSelectSourceMutation` + `SourcesSection`（挂在模型页目录之后、磁盘占用之前 ——
用户需要它的确切时刻，是刚看到「所有下载源均失败」的时候，而那条横幅就在这一页）。

**三条刻意的诚实：**

1. **"优先"不是"只用"**：`orderSourcesForDownload` 只把钉住的源排到最前，其余仍作回退。
   界面照这个说 —— 让用户以为自己关掉了别的源，是又一句界面说了不算的话。
2. **没测过就说没测过**：`effective` 为 null 时不显示"当前源"，也不拿"自动"充数。
3. **不做"自定义源"**：契约里有 `baseUrl`、daemon 也存得下来（`models.ts:953`），
   但 `[实测 grep]` **全仓没有任何下载路径读过 `sourceBaseUrl`** ——
   做出来就是个填了必然无效的输入框。

顺带修好一个只有零调用方才会留住的错：`useSourceProbeMutation` 标的返回类型是 `{jobId}`，
而 daemon 发的是完整的 `GetSourcesResponse`。

⚠️ 还抓到我自己一次：`onSuccess` 里 `setQueryData` 之后又 `invalidateQueries`，
等于用一次新 GET 把刚拿到的测速结果盖掉（真 daemon 上因为 `lastProbes` 有状态而看不出来，
**只在 mock/测试里显形，但确实存在**）。已去掉那次失效。

⚠️ **端口段守卫当场抓到我**：`sourcesRest.test.ts` 第一版取 19860，与
`noteDetailContract.test.ts` 同段 → `testPorts.test.ts` 立刻红。已挪到 19900。

---

# §5 门禁：`scripts/check-orphan-exports.mjs`（`/tmp/backlog-sweep-orphans2.mjs` 的固化版）

交付两个文件 + 一处 `package.json` 改动：

- `scripts/check-orphan-exports.mjs`
- `scripts/orphan-exports-baseline.json`（**72 条**，带 note；`⚠️` 开头的是**已知开着的缺陷**）
- `package.json`：新增 `check:orphans`，并接进 `check`

**判据是只准变少的棘轮**：基线外的新条目红；基线里**已经被接上/删掉**的条目**也红**，
逼人来删那一行 —— 一份不会缩水的豁免名单，几轮之后就没人相信它了。

**三个自检写在检查之前**（针对今天反复踩的"工具返回空集 ≠ 没有"）：
① 文件清单非空且**包含 `src/` 第一层**（第一版那个残缺 glob 漏的就是这一类，
报出过 251 个假阳性，连 `createNoteRoutes` 都成了"零调用方"）；
② 导出总数不能少得离谱；③ 一个已知有调用方的名字必须**不**出现在结果里。
另：全程 Node 读文件不用 `grep`（它对含裸控制字节的文件整文件静默跳过）；统计前剥注释。

「只有测试引用」的 16 个**只打印不判红**（测试专用出口本来就该只有测试引用，
卷进棘轮只会逼人灌水），但清单照样打出来 —— 导图的 `fromMarkdown`/`fromOpml`/`fromFreeMind`
就在里面。

## ⚠️ 需要 Manager 知悉的一处越权判断

`check` 里的 `pnpm -r build` 换成了 `tsc -b && pnpm build:safe`。

理由：`pnpm -r build` 含 `vite build`，会覆盖 `:10000` 正在托管的 `apps/web/dist`
（PROTOCOL §7，两名 agent 踩过；`backlog-sweep` §需要 Manager 决策 4 也报过）。
**既然这次要让人更常跑 `check`，就不能让它带着这个后果**——
PROTOCOL §7 补充立的判据正是"跑错了也不会造成后果"。
**类型覆盖不减反增**：`[实测]` 往 `apps/web` 里塞一处类型错，根 `tsc -b` 当场报出来
（根 tsconfig 的 references 里就有 `./apps/web`）。
这是 `backlog-sweep` 挂着的决策 4，我自作主张先做了；**一个词可以改回去**。

---

# §RV 反向验证（**全部跑在 `/tmp` 隔离副本**，PROTOCOL §10）

**没有在共享工作树里拆过任何一次修复，`apps/web/dist` 与仓库各 `dist` 全程零改动。**

## RV-1 unpack（`/tmp/sweep-fix/rv-dl`：`cp -a` 的 `packages/{downloader,shared}` + 软链根 node_modules）

```
控制组                                          26 pass / 0 fail
① resolveWithinRoot 退化成只做词法（事故原状）    ★ 4 红
② 撤掉「解包后复查每条链接」                      ★ 1 红（正是攻击 D 那条）
③ 撤掉「每个条目落点也要复查」                    ★ 1 红（正是攻击 B 那条）
④ 撤掉「根也要解析」                              ★ 1 红
⑤ platform 入参退回读宿主                        ★ 3 红
⑥ `root + sep` 退回裸 `startsWith(root)`         ★ 1 红
还原                                            26 pass / 0 fail
```

⚠️ **④ 第一版没红，变异体当场揭穿了我的用例**：只做"根是软链"不够 ——
`walk()` 从给定的根出发、不回头解析它，两边**恰好**都停在软链那一侧，比较照样成立。
补了一条**绝对软链**才让两边真的分叉。这条如实写进了用例注释。

## RV-2 笔记翻页 · daemon（`/tmp/sweep-fix/rv-notes`：`cp -a` 的 `apps/daemon` + `packages` + 软链 vendor）

```
控制组                                    13 pass / 0 fail
① 端点不再认 offset（事故原状）             ★ 1 红
② hasMore 恒 false                        ★ 1 红
③ total 只报本页条数                       ★ 2 红
④ countNotes 不认筛选条件                  ★ 2 红
⑤ 排序去掉唯一次级键                       ⚠️ **0 红 —— 见 §6.1**
⑥ offset 校验退回 Number()                 ★ 1 红
还原                                      13 pass / 0 fail
```

## RV-3 笔记翻页 · web（`/tmp/sweep-fix/rv-web`：`cp -a` 的 `.test-out` + `src` + 软链 node_modules）

```
控制组                        243 pass / 0 fail
① 只渲染第一页（事故原状）      ★ 1 红
② 「加载更多」写死不渲染        ★ 1 红
③ 页脚不说总数                 ★ 2 红
还原                          243 pass / 0 fail
```

## RV-4 下载源 UI

```
web   控制组 5/5 →  ① 选源不发请求 ★1红 · ② 「当前生效」不显示 ★2红 ·
                    ③ 可选项改成写死表 ★1红 · ④ 没测过时拿"自动"充数 ★1红 → 还原 5/5
daemon 控制组 3/3 → ① available 恒空 ★2红 · ② available 写死表 ★1红 ·
                    ③ 钉了源 effective 不认它 ★1红 → 还原 3/3
```

## RV-5 组件回滚

```
downloader 控制组 27/27 → 把 `rm(finalDir)` 放回 catch → ★「解包失败时，上一版的文件必须原封不动」红 → 还原 27/27
web        控制组  2/2  → 把"一键回滚"那句承诺放回确认框 → ★「更新确认框不许承诺可以一键回滚」红 → 还原 2/2
```

## RV-6 门禁自己（跑在 `/tmp/sweep-fix/gate/repo` —— 一个从 `git ls-files` 复刻出来的独立仓库）

```
① 现状                                  exit 0（绿）
② 新增一个零引用导出                     exit 1（红）✘ 1 个**新的**零引用导出
③ 基线里留一个已被接上的条目              exit 1（红）✘ 1 个条目已经不再是零引用导出
④ 把 main.ts 从索引里拿掉（探针自检）      exit 1（红）✘ 扫描器自检未通过
⑤ 还原                                  exit 0（绿）
```

## 断言写法（今天点名的那几个陷阱）

- **钉结构不钉关键词**：① 的判据一律是「destRoot 外那份文件的字节有没有变」，
  用独一无二的串 `SECRET-OUTSIDE-DESTROOT` 反查，**不匹配错误文案**；
  ③ 的判据是「翻完所有页的 uid 集合 == 全部笔记且不重复」，不是"页脚有字"；
  ② 的判据是「送到 `window.confirm` 的那串字」。
- **先证明用例钉的不是零**：① 就地复刻修复前的词法判据、断言它会放行；
  ④ 的"没有回滚按钮"旁边先断言**更新按钮在**（否则卡片没渲染时它照样绿）；
  daemon 的 `available ⊆ 清单` 前面先有**非空守卫**（空集会让子集断言恒真）。
- **写非空守卫先问"我要报告的量会不会把守卫压破"**：orphan 门禁的基线是 72 条，
  所以判据做成棘轮而不是"必须为 0"；空基线会让它变成一条永远红的门禁，脚本里专门挡了。
- 全程没有 `assert.equal(domNode, null)`（PROTOCOL §8）。

---

# §6 未验证 / 存疑（**这一节是本回执最重要的部分**）

## 6.1 ⚠️ ③ 的排序次级键**没有被任何断言覆盖**

`ORDER BY n.created_at DESC` → `ORDER BY n.created_at DESC, n.id DESC`。
理由是真的：同一毫秒建的笔记（批量导入必然发生）只按 `created_at` 排时，
相同键的相对顺序由 SQLite 自己定，`LIMIT/OFFSET` 会重复一条、漏掉另一条。

**但我造不出能判定它的用例。** 我专门写了 `apps/daemon/src/db/notesPaging.test.ts`，
把 8 条笔记的 `created_at` **钉成同一个值**（用例里先断言"确实只有 1 个不同的时间戳"），
然后每页 3 条翻到底 —— `[实测]` 把次级键去掉，**它照样绿**：
这台机器上的 SQLite 对该查询计划恰好是稳定的（按 rowid 扫）。

按 HANDOFF ⑤K「一条从未被任何断言覆盖过的规范，很可能从落笔那天起就是错的」的判据，
我**不能**说它被覆盖了。**它是一次规范收紧**（把顺序从"恰好如此"变成"规定如此"），
不是一条被证伪过的行为。留着它的理由是"不依赖未指定行为"，
不是"我验过它有用"。请 Manager 知悉这一条的性质。

（`notesPaging.test.ts` 本身仍然有用：`countNotes`/`listNotes` 同口径那条在变异 ④ 下真红。）

## 6.2 ① 的完整利用链**没有构造**

我证明的是 unpack 这一级的原语（手搓 tar.gz 直接喂 `unpackTarGz`）。
**没有**做出一个能通过 `vendor/manifests` 里 sha256 校验的恶意归档端到端跑通 ——
那需要控制上游产物，而这恰恰就是本条缺陷的前置条件本身。

## 6.3 ① 的残留：unpack 抛错之后，destRoot 里可能留着那条越界的软链

攻击 D 修复后 `unpack` **抛错**了，但抛错发生在解包后复查那一步，
此时那条链已经在盘上。`install()` 的 catch 会 `fs.rm(tmpDir)` 把整棵临时树删掉，
所以走产品路径没有残留；**但 `unpackArchive` 作为通用工具，失败时不自清**。
如实记下，没有改（改它要定义"失败时是否删除 destDir"的语义，超出本轮范围）。

## 6.4 ④ 只在 jsdom 里验过

`SourcesSection` 的 5 条组件用例跑在 jsdom 里。**没有在真浏览器里点过**，
也**没有真的跑过一次测速**（`POST /api/models/sources/probe` 会对外发请求，
测试里刻意不调它 —— 不该依赖外网，也不该在别人的机器上偷偷跑流量）。
`docs-public` 报的"这台机器连不上 HuggingFace、回落到 ModelScope"我**没有独立复现**，
引用的是它的实测。

## 6.5 macOS / Windows 一律未验

① 的 win32 半边全部是用显式 `platform` 入参在 **Linux 上**验的，**没有真机**。
这正是把 platform 提成入参的目的（让它**可以**被验），不等于它**已经**在真机上被验过。

## 6.6 一个我如实记下的"因为错误的理由通过"

写 ① 的 platform 用例时，我第一版拿**条目名** `a\..\..\Windows\win.ini` 当 win32 用例，
它确实被拒 —— 但拒它的是 `assertSafeEntryName`，那一段**按设计对两种分隔符都切、与平台无关**，
posix 下同样会拒。**那条用例根本没有执行到 platform 分支。**
→ 真正需要 platform 入参的是**链接目标**（不走 `assertSafeEntryName`）。
已改，并把这半句话本身写成了用例注释。

---

# §7 越界与申报

**动了别人的地界，逐条申报**（`git status` 确认动手时这些文件都不在别人的工作区里；
`ci-upload` 的 `.github/**` + `scripts/ci/**` 与 `docs-public` 的 `README.md` +
`docs/DEPLOYMENT.md` **一个字未动**）：

| 路径                                                                           | 归属                       | 说明                                                                                     |
| ------------------------------------------------------------------------------ | -------------------------- | ---------------------------------------------------------------------------------------- |
| `packages/downloader/src/{unpack,installer,components}.ts` + 两个测试          | `model-mgmt`               | ① 与 ②                                                                                   |
| `packages/shared/src/{api,notes}.ts`                                           | `daemon-contract`          | `ListNotesResponse` 补 4 个字段；`GetSourcesResponse` 补 `available`                     |
| `apps/daemon/src/db/repos.ts` + 新增 `db/notesPaging.test.ts`                  | `oss-scout`                | 翻页                                                                                     |
| `apps/daemon/src/http/rest/{notes,state}.ts` + 新增 `http/sourcesRest.test.ts` | `oss-scout`                | 翻页 / 下载源                                                                            |
| `apps/daemon/src/http/notesRest.test.ts`                                       | `notes-contract`           | 只**追加**一个 describe，未动任何既有用例                                                |
| `apps/web/src/features/{notes,models,components}/**`                           | `architect` / `model-mgmt` | 新增 `models/components/SourcesSection.tsx`                                              |
| `apps/web/src/lib/api/{notesCache,mock}.ts` + `notesCache.test.ts`             | `architect`                |                                                                                          |
| `apps/web/src/app/i18n/locales/{zh-CN,en}.json`                                | `frontend-truth`           | **只追加**：`notes` 段 +4 键、`models` 段 +1 个 `sources` 子对象。**没有重排任何已有键** |
| `apps/web/src/test/components.test.tsx`                                        | `architect`                | 追加 3 个 describe + `EMPHASIS_REGISTRY` 加 1 行                                         |
| `scripts/check-orphan-exports.mjs` · `scripts/orphan-exports-baseline.json`    | 新增                       | Manager 已批准固化                                                                       |
| `package.json`（根）                                                           | —                          | 见 §5 的越权说明                                                                         |

---

# §8 纪律自查

- ✅ **`/root/data-memo` 一个字节没碰**：只跑过只读的 `find -type l` / `ls`；
  `find /root/data-memo -newermt "2026-08-06 20:00"` **返回空**
- ✅ **数据目录指针**：收工核对 `sha256sum` = `7f930979…233f3`（与 `path-guard` T-143 记的一致），
  内容仍是 `{"dataDir":"/root/data-memo"}`，mtime 仍是 `08-04 01:06`。**从未调用会写指针的接口**
- ✅ **`:10000` 只读**：全程只发过 `GET /api/health` 与 `GET /api/models/sources`，
  未重启、未 kill、未占该端口；收工 `GET /api/health` 仍 **200**
- ✅ **`apps/web/dist` 未被构建**：mtime 仍是 **`08-06 18:17:06`**，早于我开工（20:11）。
  全程只跑 `pnpm build:safe` 与 `tsc -b`（后者写 `apps/web/dist-types/`，不是 `dist/`）
- ✅ **没跑 `pnpm -r build`**；并把 `check` 里那条也换掉了（§5）
- ✅ **没用 `pkill -f`**；本轮起过的 daemon 全部由 node:test 自己 `startDaemon`/`stop`，
  端口段 19900（守卫已确认与其它段间隔 ≥30）
- ✅ **没跑本地 whisper 转写**
- ✅ **没建/改/删任何 release**，没碰 `.github/**`、`scripts/ci/**`、`README.md`、
  `docs/DEPLOYMENT.md`、`HANDOFF.md`、`docs/00-CHARTER.md`、`docs/adr/**`、
  `coordination/{BOARD,ROSTER}.md`
- ✅ **没用 `git add -A`**：5 个提交每次都 `git add <精确清单>` 之后
  **立刻 `git diff --cached --name-only` 逐条核对**（Manager 刚犯过"17 个路径 add 进去 14 个"），
  并确认 `git status` 里没有漏网的
- ✅ 反向验证一律在 `/tmp` 隔离副本，仓库 dist 全程零改动

---

# §9 需要 Manager 决策

1. **`check` 里 `pnpm -r build` → `tsc -b && pnpm build:safe` 这处我先做了**（§5）。
   这是 `backlog-sweep` 挂着的决策 4。不同意的话一个词改回去。
2. **③ 的排序次级键没有被任何断言覆盖**（§6.1）。按 ⑤K 的判据，
   要么接受它是"规范收紧"这个定性，要么把它删掉。我建议留着并接受定性。
3. **`unpackArchive` 失败时不自清**（§6.3）：要不要给它定义"失败即删除 destDir"的语义？
   走产品路径没有残留（`install()` 会清），但它是个通用工具。
4. **① 建议同步给 `pack-publish`**：这条缺陷的前置条件是"控制归档"，
   而我们自己的 CI 就是那个上游。`build-backends.yml` 产出的包现在会被这套守卫检查，
   如果哪个上游 tarball 里真有带 `..` 的链接，安装会**当场失败**而不是静默逃逸 ——
   这是行为变化，值得让 `pack-publish` 知道。
5. **`sourceBaseUrl` 是一个存得下来但没人读的偏好**（§4）。
   要么实现"自定义源"（需要在 `orderSourcesForDownload` 之外做 URL 重写），
   要么把这个字段和 `SelectSourceRequest.baseUrl` 一起删掉。现在它是个半截。
6. **`backlog-sweep` 排序表里剩下的 7 条我一条没动**：#1（`openmemo-probe` 无分发通道）、
   #5（Vulkan/CUDA 包没进目录）、#6（Windows 子进程树）、#7（macOS quarantine）、
   #8（Windows 上传报"网络错误"）、#9（`/api/health` 的 `host` 硬编码）、
   #10（`result_json` 写得进读不回）、#11（转写稿内搜索）。
   其中 **#9 是一行改动且是安全结论的前提**，建议下一轮优先。

---

## [2026-08-10] B11 追查 + 「吞掉的错误」同族第二轮 —— 提交 `abce462`（已 push，`merge-base` 已复核）

# TL;DR（两句先答问）

1. **404 一跳都没被吞掉。** B11 报的「端点回了 404 FOLDER_NOT_FOUND，而界面一个字都没说」
   是**假指控** —— 产品一直在说话，是 B11 的判据看不见它（它钉的是关键词，
   而这条文案一个关键词都不含）。
2. **同族还有 16 处完全不出声 + 5 处条件性不出声。** 我本轮修了其中 3 处，
   **剩 13 + 5 未修**，逐条清单在 §3，按用户点击频率排了序。

⚠️ **另有一条必须报给你：B11 在门禁里是「空过」** —— 与 B6b 同病。见 §2。

---

# §1 B11：404 走到哪一层断的

**哪一层都没断。** `[实测 jsdom，走产品真实路径注入 404]`：

```
发出的请求   = [..., "PUT /notes/<uid>/folder"]
新增文字     = "文件夹不存在它可能刚被删掉了。侧栏刷新后重新选一个。查看详情"
面板还开着吗 = true
★ FAIL_WORDS 命中新增文字 = false
★ FAIL_WORDS 命中整页文字 = false
```

逐跳追下来，每一跳都是通的：

| 跳 | 位置 | 行为 |
|---|---|---|
| HTTP → client | `apps/web/src/lib/api/client.ts:395-401` | 404 落进 `isNotImplemented` 分支，但**写操作 `throw err`**（"写操作永不静默回落 mock"），不吞 |
| client → mutation | `features/notes/api.ts:391` `useMoveNoteToFolderMutation` | 只有 `onSuccess`，没有 `onError` 覆盖 → rejection 进 react-query 的 `isError` |
| mutation → UI | `NoteActionsMenu.tsx:117` `move.mutate(…, { onSuccess })` | **成功才收面板**，失败留在原地 |
| UI 渲染 | `NoteActionsMenu.tsx:233` | `{move.isError ? <ErrorBlock error={move.error} /> : null}` |

**是"当时只接了成功路径"还是"后来回归了"？两者都不是。**
这条路是 `0442b8e`（`feat(web): 文件夹改名 + 笔记移动到文件夹 —— 两条零调用者 mutation
接上入口，**失败会说话**`）落地时就接好的，错误文案 `errors.FOLDER_NOT_FOUND`
也是同一个提交加的。它从第一天起就是对的。

## 那 B11 为什么会红 —— 判据本身两个方向都坏

**① 假红（这次的直接原因）**
判据是关键词表：

```js
const FAIL_WORDS = /失败|错误|重试|无法|不可用|出错|error|failed|retry/i;
```

而产品对 `FOLDER_NOT_FOUND` 说的是「**文件夹不存在** / 它可能刚被删掉了。侧栏刷新后重新选一个。」
—— **一个关键词都不含**。

> **文案写得越好（不吼"错误！"，而是说清发生了什么 + 下一步怎么办），
> 关键词判据越判不出来。它在惩罚好文案。**

这是「钉关键词不钉结构」的又一例，而且是最贵的那种形态：**它把一个做对了的功能报成缺陷**，
于是有人会去"修"一个没有坏的东西。

**② 假绿（更要紧）** —— 见 §2。

---

# §2 ⚠️ B11 在门禁里是**空过** —— 与 B6b 同病，报给你

原判据的第二半：

```js
const before = innerText;  click(note-move-root);  const after = innerText;
moveSpoke = FAIL_WORDS.test(after.replace(before, ''));
```

`after.replace(before, '')` **只在 `before` 是 `after` 的连续子串时**才等于"新增文字"。
页面上任何**无关**文字变一个字，`replace` 就原样返回 `after` → **整页**被拿去匹配。
而 zh-CN 里命中该正则的词条有 **63 条**。

`[实测]` 复刻两种情形：

```
before ⊆ after  → diff = "文件夹不存在…"                   → false（红）
before ⊄ after  → diff = 整页（含别处的「失败/重试」）        → true （绿）
```

**绿的那次和"移动失败"没有半点关系。**

而 B11 测的那条笔记是脚本自己造的 **64 字节假 WAV**（`e2e-browser-audit.mjs` 里
`writeFileSync(dummyPath, Buffer.alloc(64))`），在空数据目录里**必然转写失败** ——
它的状态文字会从「转写中」翻成「失败」。**那一翻恰好落在两次快照之间与否，
就决定了 B11 是绿还是红。** 门禁跑得快、诊断运行跑得慢（大文件下载在抢资源），
这正好解释了「只在诊断运行里红」。

> **结论：B11 从来没有真正检查过它声称检查的那件事。**
> 红是假指控，绿是整页扫到了别处的词。**判据从没被真正检查过 —— 与 B6b 完全同形。**

## 已修

- 判据换成**结构**：面板**仍开着** **且** 面板**内部**出现 `[data-testid="error-block"]`
  且文字非空。"面板内部"是关键 —— 不许被页面别处的错误（比如那条失败的转写任务）顶替。
- `ErrorBlock` 加 `role="alert"` + `data-testid="error-block"`。
  **这不是测试脚手架**：此前读屏用户点完按钮**完全不会被告知**动作失败了。
- 原来 `page.click(...).catch(() => {})` 把点击失败吞了 —— 于是"请求压根没发出去"
  也会被报成「界面一个字都没说」。现在单独记录并打印诊断串。

---

# §3 同族扫描：**16 处完全不出声 + 5 处条件性**

判据：**任何一个用户点出来的写操作，失败时界面必须说话。**
先确认两条全局前提（它们决定了所有判定）：

- `app/query.ts` 的 `createQueryClient()` **没有任何全局 mutation 错误处理**
  （`defaultOptions.mutations` 只有 `retry: 0`，全仓也没有 `new MutationCache({onError})`）
  → **没有兜底，每一处都得自己说话。**
- `JobToaster` **不能当兜底**：它订阅的是 SSE 的 `job.failed`/`job.blocked`，
  只在 job **建起来之后**才有话说；同步返回的 4xx/5xx（建 job 之前就拒了）它永远看不到。

## 本轮已修 3 处

| 位置 | 原状 |
|---|---|
| `NoteActionsMenu.tsx:110` **删除** | `onError: () => close()` 卸载整个下拉，而 `del.isError` **零渲染点**。⚠️ 旁边注释写着"错误由 mutation 自己的状态呈现"——**那个渲染点不存在**。**一句写着"已经处理了"的注释比没有注释更糟**：下一个人读到就不会再去查 |
| `NoteActionsMenu.tsx:95` **改名** | `onSettled: close` 成功失败都收起 ⇒ 失败等于静默 |
| `ComponentsPage.tsx:80` **安装/更新** | `await update.mutateAsync()` 在 `try{}finally{}` 里**没有 catch**，调用点是 `void handleUpdate(x)`；`update.isError` 全仓零渲染点（`ComponentCard` 连 `error` 这个词都没出现过）。sha256 对不上 / 上游 404 / 磁盘满 —— 界面什么都没有 |

⚠️ **`ComponentsPage.update` 这条要更正一个前提**：上一轮「7 处 `void mutateAsync` 全部补上」
在这个文件里**只加了 `check` 那一行**，`update` **从头到尾不在那份名单上**。
所以它是**当时漏的**，不是刻意留的。

## 剩下 13 处完全不出声（按用户点击频率排序，未修）

| # | 位置 | 动作 | 失败时用户看到 |
|---:|---|---|---|
| 1 | `features/tasks/JobList.tsx:125` | 暂停任务 | 什么都没有。⚠️ daemon 对 pause/resume 回 **501 + `cancel_job` remediation**（`rest/jobs.ts:182`），**那条建议在产品里到不了屏幕**。`lib/remediation/routes.ts:174` 自己记着这个洞 |
| 2 | `JobList.tsx:130` | 继续任务 | 同上 |
| 3 | `JobList.tsx:137` | 重试任务 | 同上 |
| 4 | `JobList.tsx:144` | 取消任务 | 同上（`:116` 那个 `<p>` 渲染的是 **job 数据里的** error，不是 mutation 的） |
| 5 | `components/common/AsrModelPicker.tsx:158` | 切换 ASR 模型 | 下拉**悄悄弹回旧值**，零文案 |
| 6 | `components/common/llm/PurposeBindingsSection.tsx:97` | 按用途绑定模型 | 什么都没有。⚠️ 本组件持有**自己那份** `usePatchSettingsMutation()`，`:176` 的 ErrorBlock 属于 `LlmSettingsSection` 的另一个实例，救不了这里 |
| 7 | `PurposeBindingsSection.tsx:215` | 重置全部绑定 | 同上 |
| 8 | `features/folders/FolderTree.tsx:35` | **新建文件夹** | 什么都没有。⚠️ 同一个文件的改名(:113)/删除(:235)**都修了，就漏这个**；而 `:245` 那句注释写着"我刚清完 14 处吞错误的，不新增第 15 处" |
| 9 | `features/notes/TagEditor.tsx:32` | 加标签 | 整个文件零错误 UI |
| 10 | `TagEditor.tsx:45` | 删标签 | 同上 |
| 11 | `features/transcript/TranscriptList.tsx:147` | 段落编辑 | 只回滚缓存；文字"跳回原样"，用户分不清"服务端拒了"和"我没改动" |
| 12 | `TranscriptList.tsx:148` | 段落还原 | 同上 |
| 13 | `features/notes/NotesListPage.tsx:169` | 星标 | `onError` 只做乐观回滚；只看到"星星弹回去" |

## 另外 5 处条件性不出声（渲染点在，但在某些状态下够不着）

| 位置 | 什么时候够不着 |
|---|---|
| `features/notes/NoteEditor.tsx:82` 正文保存 | 失败后徽标停在「未保存」，**与"还在防抖/正在打字"完全同形**，没有一个字提到失败 |
| `features/models/ModelDetailPage.tsx:223` 校验 | `verify.isError` 的渲染点(:213)在 `bench ? … : …` 的 **else 分支**里，而按钮在无条件 section 里 ⇒ **已跑过基准的模型，校验失败零表达** |
| `features/models/ModelsPage.tsx:355 / :356 / :584` 取消/重试/GC | 三个按钮渲染在 tabpanel **之外**（两个 tab 下都可见），而它们的 ErrorBlock(:499/:500/:501) 在 `className={tab==='asr' ? … : 'hidden'}` 的面板**之内** ⇒ **`?tab=llm` 下点这三个，错误块被 `hidden` 吞掉** |

**建议排期**：#1–#4（任务操作）一组，#5–#7（模型/绑定下拉）一组，#8–#13（笔记域）一组，
条件性那 5 处单独一组（它们改的是**布局**不是回调，别混进来）。
我没有一次全做 —— `apps/web` 现在至少两路在动，一次改 18 处必然撞车。

---

# §4 腿

新增 `apps/web/src/test/silentFailures.test.tsx` + `test:silent` 脚本（**独立 bundle**）。
**没有并进 `components.test.tsx`：动手时那个文件正被另一路改着。**

5 条断言，全部钉结构（`[data-testid="error-block"]` + 面板/输入框是否还在），**一条都不钉词**。

## 反向验证（/tmp 隔离副本，仓库产物零改动，PROTOCOL §10）

```
控制组                                        5 pass / 0 fail
① 摘掉 del 的错误渲染点                        ★「删除失败」红
② 把 onError: close 放回去（事故原状）          ★「删除失败」红
③ 摘掉 rename 的错误渲染点                     ★「改名失败」红
④ 摘掉 move 的错误渲染点（B11 真该抓的那个）     ★ 2 条红
⑤ 摘掉 role="alert"                          ★「结构标记」红
⑥ 把渲染条件写成恒真                           ★「还没失败时不许有错误块」红
还原                                          5 pass / 0 fail
```

⚠️ **反向验证抓到我自己一次，如实记下**：第 ⑥ 条守卫**第一版是空的**。
我原来写的是"移动**成功之后**不许有错误块"，而移动成功会 `setMode('menu')`，
**面板连同错误块一起卸载** —— "没有错误块"是**卸载**保证的，跟渲染条件写成什么完全无关，
恒真变异照样绿。改成"面板刚打开、还没点任何东西"才具备鉴别力。
（这正是 B11 那个病的同形：**一条因为正确的结果、错误的理由通过的断言**。）

---

# §5 「任务进行中刷新页面，Toast 回不来」—— 我的判断

**结论：算缺陷，但很轻；而且正确的修法不是"重放 Toast"。**

按你给的判据（用户中途刷新还能不能知道任务状态）逐条核实：

| 刷新后 | 状态 |
|---|---|
| Toast 层 | **空**（`JobToaster` 的列表由 SSE `job.created` 喂养，已发生的事件不重放） |
| 侧栏「任务」入口 | **在**（`App.tsx:78`，静态导航项，任何页面都可见） |
| `/tasks` 页面 | **有**，且是活的：`useJobsQuery` 先拉快照、再叠 SSE 增量 |

所以答案是：**能知道，但要他自己想起来去点「任务」。**

**为什么不建议重放 Toast**：Toast 是**瞬时通知**，刷新丢掉瞬时通知是几乎所有应用的正常行为；
把已经发生过的 `job.created` 重放，会让用户每次刷新都被一堆旧通知糊一脸 —— 那是更糟的设计。

**真正的缺口不是 Toast 没了，是刷新之后没有任何"有东西在跑"的环境信号**：
`[实测 grep]` 侧栏那个「任务」是个**静态图标，没有徽标/计数**。

**建议（未做，等你排期）**：给侧栏「任务」加一个「进行中 N」的徽标。
数据源现成（`useJobsQuery` + SSE，`TasksPage`/`JobList` 已经在用），成本小；
而且它同时覆盖**没刷新但切到别的页、或把 Toast 手动关掉**这一整类情况 ——
比重放 Toast 覆盖面宽得多。
我没有直接做：这是一个**新的 UI 元素**（产品决定），而且 `apps/web` 正热。

---

# §6 ⚠️ 一次事故：我的未提交改动被别人的 `git stash` 卷走

本轮中途 HEAD 从 `8b6a651` 跳到 `2360bf1`，**我在 `apps/web` 的三处未提交改动
连同那个 scratch 复现文件一起消失了**（`git status` 显示三个文件干净 = 回到 HEAD）。
`scripts/ci/` 那处因为不在 `apps/web` 下，侥幸活着。

另一路的回执标题里写着「**一次被 stash 卷走的事故**」—— 与现象吻合。
我**重做了一遍并立刻提交+push**，没有硬合任何东西。

**建议写进 PROTOCOL**：`git stash` 是**全工作区**操作，在多 agent 共享工作树里
等价于"把别人正在写的东西拿走"，而且**被拿走的一方看不到任何报错** ——
它和"我还没写"长得一模一样。判据与 §10 同源：**在最坏的那一秒，别人看到的是什么。**

---

# §7 纪律自查

- ✅ **没碰 `:10000`**（pid 2037 全程未动）、**没碰 `/root/data-memo`**、**没碰机器级指针**
- ✅ **没用 `pkill -f`**（含 `-0`）；本轮没有起过任何 daemon
- ✅ **没用 `--amend`**；push 用具体 hash（`git push origin abce462:master`），
  push 后 `git merge-base --is-ancestor abce462 origin/master` **复核通过**
- ✅ **新文件显式 `git add`**（`silentFailures.test.tsx`），`git add` 后
  `git diff --cached --name-only` **逐条核对 = 6 个，与预期一致**
- ✅ **没有夹带别人的文件**：`docs/design/D-20-bundled-deps.md`（他人在改）全程未暂存
- ✅ scratch 复现文件**已删除，未提交**
- ✅ 反向验证全部在 `/tmp/sf2/` 的隔离副本上，**仓库源码与 `.test-out` 零改动**
- ✅ **没有构建 `apps/web/dist`**（只用 `vite build --ssr --outDir .test-out/…`）
- ✅ 门禁：`tsc -b` **0** · `eslint` **0** · `prettier --check` **通过** ·
  `apps/web` 测试 **136+10+323+5 = 474，0 failed**

# §8 未验证 / UNKNOWN

- **B11 修好之后没有在真浏览器里跑过。** 本地没有可直接 `require` 的 playwright
  （模块在 `node_modules/.pnpm/` 下，脚本有 `PLAYWRIGHT_MODULE` 逃生口），
  且跑一次完整审计要起 daemon + 下大文件。**新判据的正确性是靠 jsdom 等价复现
  + 6 个变异证明的，不是靠真浏览器。** 建议下一次 e2e 运行时留意它。
- **"诊断运行里那次红，具体是不是被转写失败文字翻面导致"** —— 机制我用构造复刻证明了，
  但**那两次具体运行的页面文字我没有取到**，标 `[未验证]`。
- 剩下 13 + 5 处静默失败**只做了静态判定**（读码 + 渲染点核对），**没有逐处实跑**。
