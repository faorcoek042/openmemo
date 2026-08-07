# silent-guards —— 三条「守卫静默失效」的修复回执

> **产出者**：`silent-guards`（T-169）
> **起点 HEAD**：`10929ad`　**落地时 HEAD**：`eac1cdd`（期间 `closure-fix` 提交了 T-170，与本轮**零文件重叠**，已核）
> **来源**：`coordination/inbox/closure-audit.md` 的 🟡-1 / 🟡-2 / 🟡-6
> **未碰**：`:10000`、`/root/data-memo`、`~/.local/share/openmemo/datadir.json`。反向验证全部在 `/tmp` 隔离副本上做，已清理。

---

## [2026-08-07] T-169 DONE

交付:
- `.github/workflows/ci.yml`（新增 `Orphan-exports ratchet` 一步）
- `scripts/check-orphan-exports.mjs`（词法扫描器重写 + 3 条新不变量 + 1 组新自检）
- `scripts/orphan-exports-baseline.json`（72 → 72，**换了一条**）
- `scripts/check-test-scripts.mjs`（判据补「有源码却零测试」）
- `packages/shared/package.json` + `src/{schemas,contract,jobs}.test.ts`（0 → 31 条测试）

要点:
1. 棘轮门禁确实从来没在 CI 里跑过，已接进 `ci.yml`。**`ci.yml` 是全仓唯一自动触发的 workflow**，其余 5 个都是 `workflow_dispatch`。
2. 补剥字符串字面量时**牵出一个更大的洞**：老的 `stripComments()` 自己就是坏的，它让门禁对 6 个导出声明完全失明，并制造了至少 1 条基线假阳性。
3. 基线**没有从 72 抬到 76**。审计预测的 5 条里只有 1 条为真，同时修复反而消掉 1 条旧假阳性 → 72 换 72。**债没有增加，也没有被藏起来。**
4. `verifyCatalogSignature` **不是**「验签特性被静默关掉了」。详见下面第三节。

需要 Manager 决策: **2 条**（见第五节：目录验签整条线的去留、`::1` 白名单死条目要不要修）

---

## 一、① 棘轮门禁接进 CI

`[我核过]` 开工时复核了审计的三条证据，全部成立：`grep -rn orphan .github/` 零命中、
`git config core.hooksPath` 空且 `.git/hooks/` 只有 `.sample`、`pnpm check` 无任何自动调用方。

**改动**：`ci.yml` 在 `check:sources` 之后加一步 `run: pnpm check:orphans`。
按审计的提醒**没有**直接加 `pnpm check` —— 它含 `build:safe`，会和 CI 已有的 build 步重复。

### 「同一位置还躺着几条」—— 我逐条对了账

`pnpm check` 的五个成员，此前**只有 `check:orphans` 一条**不在 CI 里，现已补齐：

| `pnpm check` 成员 | 此前在 CI 里？ |
|---|---|
| `check:sources` | ✅ `ci.yml:119` |
| `check:orphans` | ❌ **本次补上** |
| `tsc -b` | ✅ `ci.yml:111` Typecheck |
| `build:safe` | ✅ `ci.yml:108` |
| `eslint .` | ✅ `ci.yml:114` Lint |

**但把范围放大到「所有守卫脚本」，还有 3 条没有自动调用方**（本轮**没有**动它们，理由逐条写清）：

| 守卫 | 状态 | 为什么这轮不接 |
|---|---|---|
| `format:check` | ❌ 无任何调用方 | **`[我实测]` 476 个文件不过**（审计里记的 403 是 `[报告]`，已过期）。现在接进 CI = 门禁永久红。判据照审计：**先统一格式再上门禁，别反过来**。 |
| `check:selfcheck`（`scripts/selfcheck.mjs`） | ⚠️ 有调用方但不自动 | 被 `scripts/ci/cold-start-audit.mjs:343` 调用，而 `cold-start-audit.yml` 是 `workflow_dispatch:`。它要**真数据目录 + 起 daemon + 装好后端**，塞进 `ci.yml` 那个 2 分钟的静态门禁里不合适。**留作已知缺口**。 |
| `scripts/mutation-check.mjs` | ⚠️ 无调用方 | **设计如此**，文件头明写「不进门禁」。不算欠债（审计同结论）。 |

⚠️ 顺带核到一件审计没提的事：**`ci-crossplatform.yml` 是 `workflow_dispatch:`**，
而且它里面**没有 lint、没有 `test:ci-scripts`**。也就是说「跨平台门禁」今天等于不存在，
`ci.yml`（ubuntu-24.04）是唯一自动跑的东西。→ 这条我没改，登记在这里。

---

## 二、② 棘轮判据的盲区 —— 比审计说的更深

### 审计说的那半：只剥注释、不剥字符串 —— 属实

`verifyCatalogSignature` 在自己的错误信息里写了自己的名字，`self` 因此恒 ≥ 1，永不判红。
**而「在错误信息里写自己的名字」是好习惯 —— 这个盲区专门遮蔽写得比较讲究的那部分代码。**

### ★ 牵出来的那半：老的 `stripComments()` 自己就是坏的（审计没发现）

补上剥字符串之后，脚本**自己的守卫**当场把我拦下来了 —— 15 个文件扫到文件尾还停在字符串里。
追下去，根因不在我新写的扫描器，在**已经跑了一个版本周期的老 `stripComments()`**。
它是三条正则，在**原始源码**上跑，不知道自己站在哪儿：

**坑 A —— 幽灵块注释**（`apps/daemon/src/http/rest/storage.ts:83`）：
```
// 说"可随时删"必须是真的：转写产物现在会**归档进 media/**，
```
`media/**` 里那个 `/*` 在一条**行注释**里，但块注释正则不知道，
于是从这里开了一个幽灵块注释，**一路吃到第 116 行的下一个 `*/`** ——
`[实测]` 33 行真代码被删，其中就有 `export function createStorageRoutes(deps: StorageRoutesDeps)`。

**坑 B —— 行注释正则咬坏模板字面量**（`apps/web/src/lib/secure-context.ts`）：
```js
return `${protocol}//${host}`;
```
那条 `([^:"'`])\/\/[^\n]*` 用「`//` 前面不是 `:`」来避开 `https://`，
这里 `//` 前面是 `}` → 把 `//${host}`;` 连同整行删掉，留下一个**没闭合的模板字面量**。

**量化 `[我实测]`**：老 `stripComments()` 让 **6 个导出声明**对门禁完全隐形 ——
`AUTH_MODE`（两处）、`createStorageRoutes`、`MINDMAP_SAVE_SUPPORTED`、`UnpackResult`、`MEDIA_EXTENSIONS`。
`storage.ts` 一个文件就被删掉 4138 / 11512 字符（36%）。

> **两遍扫描在结构上就是错的**：第一遍不认识字符串，就必然会咬坏字符串；
> 第二遍再想认字符串，读到的已经是被咬坏的文本了。
> → 改成**一遍词法扫描**，注释 / 字符串 / 模板 `${}` / 正则字面量同时认。

### 那 5 条逐条表态（**结论与审计不同，附各自证据**）

审计用它自己的复刻算出「加剥字符串 = 76，遮住 5 条」。我用真扫描器复算，**5 条里只有 1 条为真**：

| 审计点名的条目 | 我的结论 | 证据 |
|---|---|---|
| `single-instance.ts :: PROBE_HOST` | ❌ **误报** | `:139` `` `${scheme}://${PROBE_HOST}:${port}/api/health` `` —— 引用在模板 `${}` 里，那是**真代码**。审计的复刻把整个模板连 `${}` 一起吞了。 |
| `probe.ts :: PROBE_BYTES` | ❌ **误报** | `:46` `` `bytes=0-${PROBE_BYTES - 1}` `` 同上。 |
| `childEnv.ts :: pathVarSeparator` | ❌ **误报** | `:49` `` `${dir}${pathVarSeparator(platform)}${existing}` `` 同上。 |
| `asrStream.ts :: RecorderServerMessage` | ❌ **误报** | `:82 :126 :128 :217` 四处**普通类型标注**，与字符串无关。它之所以看着像孤儿，是**坑 B** 把该文件后半段吞了。 |
| `manifest.ts :: verifyCatalogSignature` | ✅ **真的** | 全仓唯一一次自我提及在自己的错误信息里；生产零调用方、零单测。 |

**外加一条审计不知道的**：`rest/storage.ts :: StorageRoutesDeps` 是**基线里躺着的假阳性**
（`:103` 一直有真引用，是坑 A 把那一行吞了）。修好后它自动掉出名单，脚本的「基线只准变短」当场逼我删。

### 基线怎么动的：**72 → 72，一换一**

- 删 `StorageRoutesDeps`（假阳性，已不再是孤儿 —— 规矩要求基线变短）
- 增 `verifyCatalogSignature`（真孤儿，带长 note）

**没有出现「判据变严所以数字变大」的情况**，因为同一次修复也消掉了旧的假阳性。
**基线只许降不许升这条规矩没有被破，也没有被绕过。**

### 反向验证 `[实测，7 组，全部在 /tmp 隔离副本上跑，先跑对照组]`

对照组（副本未改动）绿；逐条拆掉后：

| 变异 | 结果 |
|---|---|
| ① 剥字符串这一步拆掉 | 🔴 仓库级不变量 +「verifyThing / mentionedOnlyInText 阳性对照」同时红 |
| ② 模板 `${}` 保留拆掉 | 🔴「usedInTemplate 被误判成孤儿」 |
| ③ 正则字面量识别拆掉 | 🔴 15 个 `.tsx` 收尾停在字符串里 |
| ④ 换回老的三条正则 `stripComments` | 🔴 声明清单漂移 |
| ⑤ 正则判据换回黑名单写法（我真踩过的 JSX bug） | 🔴 大批 `.tsx` 失步 |
| ⑥ 真加一个零调用方导出 | 🔴「1 个新的零引用导出」—— 棘轮本体仍然灵 |
| ⑦ 往基线塞一条不存在的条目 | 🔴「基线里有 1 个条目已经不再是零引用导出」 |

⚠️ 变异①第一次只让**自检**红、真实扫描一格没动 —— 因为 `scan()` 直接调 `scanSource()`
而自检调 `prepare()`，**两边不是同一个入口**。已改成同一个入口，注释里记了这一笔：
*自检守的必须是真实路径，否则它证明的只是自检自己还活着。*

### 新增的三条不变量（这次的教训固化下来）

1. **剥字符串不许改变导出声明清单**（声明不可能长在字符串里 → 变了就是失步）。测试文件豁免，理由写在代码里：lint 类夹具会把源码当字符串喂进去。
2. **扫描器不许扫到文件尾还停在字符串/模板里**（有引号没配上）。
3. **全仓「剥字符串后有变化的文件数」不许为 0**（这一步被简化掉时，它失效的样子和"本来就没有字符串"一模一样）。

---

## 三、★ `verifyCatalogSignature` 到底是不是「验签特性没启用」

**结论：不是。它比那个更彻底，但危害小得多 —— 缺的不是密钥，是整条远端目录管线。**

`[我核过]` 逐条：

1. **生产根本没有远端目录可验。** 目录是 `vendor/manifests/*.json`，**git 已跟踪、随仓库发布**；
   daemon 走 `apps/daemon/src/http/rest/manifests.ts:73 listManifestFiles()` 的 `fs.readdir` **本地读盘**，全程不联网。
2. **会联网取目录的那个加载器自己就是死代码。** `packages/downloader/src/manifest.ts:75 loadManifest`
   （含全仓**唯一**一处取目录的 `fetch`，`:88`）**零调用方**；它的两个出口
   `loadBackendManifest` / `loadModelManifest` 也零调用方 —— **这两条本来就已经在棘轮基线里躺着**。
   所以缺的不是「给验签接上调用方」，是**「远端目录这条线整条没做」**。
3. **函数本身是对的**：fail-closed（给了签名却无密钥 → 抛，不返 true），底下是真的 `crypto.verify` Ed25519。
4. **全仓没有任何签名数据**：无 `.sig`、目录 JSON 里无 `signature` 字段、**没有任何脚本会签目录**。
5. **今天真正承重的完整性控制是另外两条**：编译期下载域名白名单 + 每个产物强制 sha256
   （`packages/shared/src/schemas.ts:39-95`）。→ 所以本轮 ③ 的测试**第一个就测它们**。
6. **当前状态是被 ADR 明确批准过的**：
   - `ADR-012` 决策 6：「Ed25519 验签已实现但生产未启用（无密钥），供签名却无密钥时失败关闭绝不放行 —— 批准」
   - `ADR-010` 决策 4：「未实现且**显式抛错不静默**，批准该选择」

**所以处理方式是「登记进基线并写清楚」，不是删、也不是接线**：
删它等于推翻一条 accepted ADR，那是 Manager 的决定；
接线则需要先有「远端目录」这个东西，而那条线整条不存在。
基线 note 里把上面 6 条压缩写进去了，**下一个人看到的是地图，不是一句"已豁免"**。

> 一个附带结论，比这条本身更值得记：**这个零调用方的安全控制此前没有任何机制会发现它** ——
> 棘轮看不见它（字符串盲区），`pnpm -r test` 覆盖不到它（`packages/downloader` 没有 signature 测试，
> 唯一的覆盖在 `scripts/verify-unpack.mjs` 里，而那个脚本**也没有任何自动调用方**）。
> 三层守卫在同一个点上同时失明，形状与 ①②③ 完全一致。

---

## 四、③ `packages/shared` 零测试

### 守卫判据修在哪

`check-test-scripts.mjs:95` 原本是 `if (n === 0) continue;` —— **零测试文件直接跳过**。
于是 `packages/shared`（17 个源文件、0 个测试）永不触发，`pnpm -r test` 也永远跳过它，两边都不出声。

改成：**有源码却零测试 → 直接红**，另设 `NO_TEST_EXEMPT` 白名单（**刻意留空**，加之前得写清理由）。
`[实测]` 改完立刻红在 `packages/shared —— 17 个源文件，0 个测试文件`，且**全仓只有它一个**。

`last-mile.md:248` 当年担心「加 test 脚本会牵动跨包守卫」—— 审计核过不成立，**我实测也确认**：
守卫从 8 个包变成 9 个包，其余包一格没动。

### 补了哪 31 条，为什么是这几条

判据是**「坏掉的时候两边都不报错」**，不是「把覆盖率填上去」：

| 文件 | 测什么 | 为什么它会咬人 |
|---|---|---|
| `schemas.test.ts`（11） | 下载域名白名单 / https / 回环例外、sha256 形状、字节数必须是整数 | 见第三节第 5 点：**这是今天真正承重的两条完整性控制**，而它们全住在这个此前零测试的包里。放宽 zod schema 不会让任何东西变红 —— 上层看到的只是"校验通过"。**最要紧的一条**是后缀相似域名（`huggingface.co.evil.com`）必须拒绝：只要有人把精确相等改成 `endsWith`，它们会全部变成合法下载源。 |
| `contract.test.ts`（12） | `CONTRACT_VERSION` 语义 + SSE 线格式 + 事件类型表自洽 | `CONTRACT_VERSION` 是 daemon↔web 唯一的握手位，**没有任何 schema 描述它**，两边各自手写字段名；改它 = 宣布旧前端必须一起换。SSE 帧少一个换行 → 浏览器**永远不 dispatch**，而服务端 write 成功、连接正常、没有异常、进度条只是不动了。 |
| `jobs.test.ts`（8） | 任务状态机表级不变量 | `JOB_TRANSITIONS` 写错一个状态名 → `canTransition()` **恒 false** → 任务卡住不动，不抛异常。另钉死 `succeeded` 是吸收态、终态只能经 `queued` 复活（直接跳回 `running` 会绕过租约，同一任务两个执行者写同一个文件）。 |

**没有**为了凑数写 getter/setter 类断言。31 条里每一条都对着一种具体错法。

### 反向验证 `[实测，5 组，/tmp 隔离副本，先跑对照组 31/0 绿]`

| 变异 | 结果 |
|---|---|
| A 域名白名单改成 `endsWith` 后缀匹配 | 🔴「后缀相似的域名必须拒绝」+「子域名不自动继承信任」 |
| B SSE 帧结尾空行掉一个 | 🔴「帧必须以空行结束」 |
| C `succeeded` 加一条出边 | 🔴「succeeded 是吸收态」 |
| D 悄悄 bump `CONTRACT_VERSION` | 🔴「钉在当前值上」绊线 |
| E `data` 改成缩进美化 JSON | 🔴「data 必须是单行 JSON」 |

⚠️ 第一次跑对照组就是红的（隔离副本解析不到 `zod`）—— **对照组红的时候后面的变异结果一律不作数**，
已修好（软链回真实 `node_modules`，只读）后重跑，对照组 31/0 绿，五组变异才逐一确认。

---

## 五、需要 Manager 决策（2 条）

1. **目录验签整条线的去留。** 今天是「实现在、fail-closed、无密钥、无远端目录、无签名产物、无签名脚本」。
   三条路：① 明确 v1 不做远端目录 → 把 `loadManifest` 那一族（含验签）一起删，基线跟着变短；
   ② 保留现状 → 维持基线 note 不动；③ 真做 → 需要密钥 + 签名脚本 + 发布通道。
   **我倾向 ①**（死代码越久越像活的），但它推翻 ADR-010/012 两条 accepted 决策，我不能自己裁。

2. **`LOOPBACK_HOSTS` 里的 `::1` 是一条永远命中不了的死条目。** `[我实测]`
   `LOOPBACK_HOSTS` 写的是 `'::1'`，而 `new URL('http://[::1]/x').hostname` 返回 **`'[::1]'`（带方括号）**，
   `includes()` 恒为 false —— IPv6 回环上的本机自建产物**永远下载不了**。
   **本轮没有修**：改它是把安全校验**放宽**（`[::1]` 从拒绝变放行），本仓库对放宽安全校验一律要求本人拍板；
   且当前方向是 fail-closed，不修不会有安全后果。
   已在 `schemas.test.ts` 里用一条**钉住当前真实行为**的用例把这个不一致记下来，并写明「要修就连这条用例一起改」。

---

## 六、门禁

| 门禁 | 结果 |
|---|---|
| `pnpm -r test` | **1341 pass / 0 fail** |
| `npx tsc -b` | ✅ |
| `npx eslint .` | ✅ |
| `pnpm build:safe` | ✅ |
| `pnpm lint-workflows` | ✅ 562 条断言 / 6 个 workflow |
| `pnpm test:ci-scripts` | ✅ 22 passed / 0 failed |
| `pnpm check:orphans` | ✅ 72 / 基线 72 |
| `check-test-scripts` | ✅ 9 个包（此前 8 个） |

⚠️ **1341 与任务书给的基线 1301 差 40，其中只有 31 条是我的。**
另外 9 条不是我的：`closure-fix` 在我开工期间提交了 `eac1cdd`（T-170），
新增了 `killTree.test.ts` / `commentRefsResolve.test.ts` / `applicability.test.ts`。
`[我核过]` `git status --short` 全程只有我那 8 个文件，**shared 之外我没碰过任何测试文件**；
两边改动**零文件重叠**。

---

## 七、我没做 / 没验的

- **`format:check` 没接进 CI**（476 个文件不过，接了就是永久红）。已在第一节写清判据。
- **`ci-crossplatform.yml` 仍是手动，且缺 lint 与 `test:ci-scripts`** —— 本轮没动，登记在案。
- **`::1` 那条没修**（见第五节 2）。
- **`scripts/verify-unpack.mjs` 仍无任何自动调用方** —— 它是 signature.ts 唯一的覆盖来源。本轮没动。
- **词法扫描器仍是近似**：`return /re/…` 这类位置认不出正则（前驱是标识符字符），属**保守**错法（少剥不失步）。
  真失步由第二节末尾那三条不变量兜住，`[实测]` 当前全仓 0 处失步、0 处声明漂移。
- **没跑 `scripts/mutation-check.mjs`**（无调用方、要先 build，且与本轮改动无关）。

---

## [2026-08-07 23:0x] T-171 DONE（用户裁定的三条，②③ 全做，① 做了一半并拒绝了另一半）

> **产出者**：`T-171`　**起点 HEAD**：`26fdd1f`
> **来源**：用户对本文件第五节两条待裁 + 第七节 `ci-crossplatform` 缺口的直接裁定
> **未碰**：`:10000`（只读核对了它托管什么）、`/root/data-memo`、`~/.local/share/openmemo/datadir.json`
> （跑 `pnpm -r test` 前后 `md5sum -c` 核对过，`OK`，内容仍是 `/root/data-memo`）。
> 反向验证 **8 组全部在 `/tmp` 隔离副本**上做，先跑对照组，做完即清理（§10）。

交付:
- `packages/downloader/src/manifest.ts`（删掉远端目录加载器整族，227 行 → 62 行）
- `scripts/orphan-exports-baseline.json`（**72 → 70**，只降不升；并订正了一条**写错了的** note）
- `docs/adr/ADR-010-…md`（决策 4 删除线 + 新增 §附-A）、`docs/adr/ADR-012-…md`（决策 6 删除线 + 新增 §附-B）
- `packages/shared/src/schemas.ts`（`unbracketHost()` + 两段成因注释）
- `packages/shared/src/schemas.test.ts`（那条"钉住缺陷"的用例改成"钉住修复"，另加一条配对反向用例）
- `.github/workflows/ci-crossplatform.yml`（补 `pnpm lint` + `pnpm test:ci-scripts`）
- `scripts/ci/lint-workflows.mjs`（+14 条断言，让上面那两步**少一条就当场红**）

要点:
1. **① 撞到了真实调用方，我按用户的指令拒绝删并回报。** `verifyCatalogSignature` 有调用方
   `packages/downloader/scripts/verify-unpack.mjs`，**用户裁定理由 #1 的事实前提不成立**（详见第一节）。
2. **② 修了，并且找到了那"第二处坑"—— 但它不在我以为的地方**：同族比对点全仓 12 处，
   真踩坑的**只有 `schemas.ts` 一处**；而**第二处早在 T-142 就发生过并已修**，是同一个错误假设的**第一次**发作。
3. **③ 补齐了，`format:check` 按判断没接**（`[我实测]` **481 个**文件不合格，不是 476 也不是 403）。
4. ⚠️ **顺带撞见一次疑似 §7 违规（不是我做的，但用户的 demo 可能已经被换掉）** —— 见第四节。

需要 Manager/用户决策: **2 条**（第五节）

---

## 一、① 删远端目录管线 —— **拒绝了其中一半，这是回报重点**

### 逐个核调用方的结果

用户的硬约束原话：「**你要拒绝删任何有真实调用方的东西，并回报给我。**」这条**触发了**。

| 符号 | 真实调用方 | 处理 |
|---|---|---|
| `loadManifest`（含全仓唯一取目录的 `fetch`） | **零** | ✅ 已删 |
| `loadModelManifest` / `loadBackendManifest` | **零** | ✅ 已删 |
| `LoadManifestOptions` / `LoadedManifest` / `ManifestTier` | **零** | ✅ 已删 |
| `CATALOG_TTL_MS` / `STALE_AFTER_MS` | **零** | ✅ 已删 |
| `readJson` / `fileAgeMs`（私有） | **零** | ✅ 已删 |
| **`verifyCatalogSignature`** | **`verify-unpack.mjs:50` + `:584 :587 :591 :596`** | ⛔ **拒绝删** |
| `signature.ts` 三个导出（`verifyEd25519` / `parseEd25519PublicKey` / `OPENMEMO_CATALOG_PUBLIC_KEY`） | **同上，全部被消费** | ⛔ **整个文件都不能删** |

### 为什么拒绝：三条证据

**(a) 用户裁定理由 #1 的事实前提不成立。** 原话是「一个**从未被调用、也没有任何测试**的加密验签函数……
**它从来没有对着一个真实签名跑过**」。`[我实测，删改之前跑的对照组]`：

```
[8] Ed25519 detached-signature verification      ← 8 条
[9] verifyCatalogSignature fails closed …        ← 5 条
  PASS  verifies correctly once a key IS supplied   ← 拿真实生成的 Ed25519 密钥对验真签名
  53 passed, 0 failed  (0.1s)
```

它被调用、有 13 条断言、**跑过真签名**。理由 #2（今天没有功能损失）与 #3（将来重新设计）
不受影响 → **所以远端加载器那族照删，只是验签函数留下**。

**(b) 爆炸半径比"删一个函数"大得多。** `verify-unpack.mjs:50` 是**顶层 await 动态 import**：
删掉 `manifest.ts` → `dist/manifest.js` 消失 → **模块加载阶段**就 `ERR_MODULE_NOT_FOUND` →
**整份脚本全挂**，连带**53 条解包安全断言**（zip-slip / 绝对路径 / 软链逃逸 / zip 炸弹限额 /
可执行位保留）一起死 —— 而那正是 `docs/SECURITY.md:453` 与 `ADR-015:44` 引为「已实现」的证据来源。
**这就是 `toMarkdown` 那次的形状**，只是这次调用方是 `.mjs` 而不是 daemon。

**(c) 门禁结构性地拦不住这一刀。** `check-orphan-exports.mjs:112` 的过滤是 `/\.tsx?$/` 且限定
`^(apps|packages)/[^/]+/src/` —— **`.mjs` 根本不在扫描范围内**。所以基线把它记成"孤儿"是
**扫描器口径下的孤儿，不是真孤儿**。

> ⚠️ **上一轮那条基线 note 里有一处硬错误**：它写着这个函数「生产零调用方、**零单测**」。
> 前半对，**后半错**。我已就地订正，并把「为什么棘轮看不见 `.mjs`」写进去 ——
> 否则下一个人会照着 note 再删一次。**这条 note 本身就差点变成那个"假地图"。**

### 删干净了吗

`[我实测]` 删后 `dist/manifest.js` 里 `loadManifest` / `CATALOG_TTL_MS` / `STALE_AFTER_MS`
**零残留**（唯一命中是我在文件头写的墓志铭注释，刻意保留）。
`verify-unpack.mjs` 重新构建后复跑 **仍 53 passed / 0 failed** —— **没打断调用方**。
基线 **72 → 70**（移除 `loadBackendManifest` / `loadModelManifest`），**只降不升**。

### ADR 怎么改的

照 ADR-003 §7.6 的先例：**原文加删除线保留，不删**，另起订正节写清「何时、被谁、依据什么推翻」。
- `ADR-010` 决策 4 → 新增 **§附-A**（含逐符号删除清单、拒绝删的完整证据、以及"若仍要删的正确切法"）
- `ADR-012` 决策 6 → 新增 **§附-B**（订正"未启用（无密钥）"这个措辞暗示的不存在的未来）

两处都**明确记录了"实际执行到什么程度 ≠ 被下达的范围"**，并写明"失败关闭绝不放行"那半**未被推翻**。

---

## 二、② `::1` —— 修了，而"第二处坑"的答案和预期不一样

### 修法：**两边都剥，不是两边都包**

`schemas.ts` 加了 `unbracketHost()`，比对前剥掉首尾方括号，**名单里仍存裸 `'::1'`**。
这是照抄 `apps/daemon/src/http/guard.ts:127-128` 的方向，理由是那里已经写死的判据：
剥法**对任何一边用哪种书写约定都成立**，不依赖 `URL.hostname` 到底带不带方括号。
（另一种修法是往名单里加 `'[::1]'` —— 能用，但那正是"依赖某一边的约定"，不选。）

### ★ "同一个坑还有没有第二处" —— 有，但它**已经修了两个月**，而且是**第一次**发作

全仓 12 处 `URL.hostname` / IPv6 字面量比对点逐个核过，**今天真踩坑的只有 `schemas.ts` 一处**：

| 位置 | 结论 |
|---|---|
| `packages/shared/src/schemas.ts:86` | 🔴 **就是本次修的这处** |
| `apps/daemon/src/http/guard.ts:127-131` | ✅ **同一个坑，T-142 已修** —— 见下 |
| `packages/pipeline/src/subprocess/argGuard.ts:105`（SSRF 守卫） | ✅ 进函数第一行就剥，**没这个坑** |
| `packages/shared/src/proxy.ts:171` | ✅ 剥了 |
| `packages/llm/.../openai-compatible.ts:284-285` | ✅ 两种形式都列了，行为对（`'::1'` 那支是死的，冗余但不咬人） |
| `apps/daemon/src/http/guard.ts:11` `ALLOWED_HOSTS` | ✅ 同上，且 `guard.test.ts:99-102` 已记为"到不了的分支，不是 bug" |
| `apps/daemon/src/http/auth.ts:270,280` | ✅ 比的是 `.host` vs Host 头，**两边都带括号**，对得上 |
| `single-instance.ts:38` / `tls.ts:91` / `pipeline/proxy.ts:94` / `llm-catalog.ts:170` | ✅ **不是 URL 解析结果**，裸/带括号各自都是正确写法 |

### 那次"IPv6 回环永久 403"事故：**同源，而且顺序反了**

`[我核过]` commit **`7ff7e73`**（2026-08-04，T-142b）+ `test-gaps.md:497-503` + `guard.ts:99-126`
+ 回归测试 `guard.test.ts:161-214` + 变异守卫 `mutation-check.mjs:159-169`（`E2-ipv6-sameorigin`）。

**根因逐字相同**：「`URL.hostname` 会剥掉 IPv6 方括号」这个假设是错的（WHATWG 规定必须带）。
两次只是**猜错的方向不同**：

| | T-142（`guard.ts`，已修） | 本次（`schemas.ts`） |
|---|---|---|
| 错法 | 以为不带 → 主动**再包**一层 → `[[::1]]` | 以为不带 → 名单里存**裸的** |
| 后果 | 用 `http://[::1]:port` 打开界面，**每个带 Origin 的请求都 403，整页全死** | IPv6 回环上的本机自建产物**永远下载不了** |
| 方向 | fail-closed（恒拒） | fail-closed（恒拒） |
| 为何没人发现 | **daemon 打印的启动地址是 IPv4** | 同上 |

> **最值得记的一笔**：`guard.ts:119-120` 当年把教训写成了「改成两边都剥……**也就不会再被同一个
> 假设坑一次**」。而**那句话写下的时候，`schemas.ts` 已经在被同一个假设坑着了**。
> 「修了一处并写下教训」≠「同族全部清了」—— 教训写在**被修的那处**，看不到它的人正是还在踩坑的那处。
> 我已把这段串联写进 `schemas.ts` 的注释，双向指向 `guard.ts:99-126` 与 `7ff7e73`。

### ⚠️ 我自己写错了一条注释，当场实测抓出来并改了

第一版注释我照抄 `guard.ts:123-125` 写了「**不**把 `::1` 与 `0:0:0:0:0:0:0:1` 归一化」。
`[实测]` 这在本文件里**是假的**：

```
new URL('http://[0:0:0:0:0:0:0:1]/x').hostname === '[::1]'      ← WHATWG 自己压缩了
new URL('http://[::ffff:127.0.0.1]/x').hostname === '[::ffff:7f00:1]'
```

成因是**两边的输入不同**：`schemas.ts` 比的两侧**都**过 `new URL`（已被规范化），
而 `guard.ts` 比的是 `URL.hostname` vs **原始 Host 头**（没解析过）。注释已改成实测结论，
并加了一条用例钉住 —— 它变红就意味着 Node 的 URL 序列化行为变了，而**有两处代码建立在它之上**。

### 测试怎么动的：31 → 32（**删 1 加 2**）

- 原「⚠️ 已知缺陷：`::1` 是死条目」→ 改写成「IPv6 回环 `[::1]` 也放行」，**两个断言都动了**（上一位交代过）
- ★ 新增配对反向用例「**剥的是包装，不是判据**」：`[2001:db8::1]` / `[fe80::1]` / `[fd00::1]` /
  `[::ffff:127.0.0.1]` / `[::]` **必须仍被拒**，https 侧同理。防的是把"剥括号"顺手做成"含冒号就算回环"。

### 反向验证 `[实测，4 组，/tmp 隔离副本，先跑对照组]`

⚠️ 第一次搭副本时对照组是 **`tests 0`** —— 正是本仓警告过的「空集返回绿」。
**对照组不绿，后面一律不作数**，修好（用仓库自带 tsc）后对照组 **32/0 绿**才开始。

| 变异 | 结果 |
|---|---|
| M1 比较时不剥括号（退回修复前） | 🔴「IPv6 回环 `[::1]` 也放行」 |
| M2 `unbracketHost` 被"简化"成恒等 | 🔴 同上 |
| M3 放宽成「含冒号就算回环」 | 🔴「**剥的是包装，不是判据**」 |
| M4 从 `LOOPBACK_HOSTS` 删掉 `::1` | 🔴「IPv6 回环 `[::1]` 也放行」 |

还原后对照组回到 32/0，副本已删。**四组各自红在正确的那一条上**（M3 红在配对用例上，正是它存在的理由）。

---

## 三、③ `ci-crossplatform.yml` 补了什么

补了两步，**位置照 `ci.yml` 的相对顺序**，`if: ${{ !cancelled() }}` 沿用本文件既有约定：

| 步骤 | 说明 |
|---|---|
| `pnpm lint` | 此前**完全没有** → 「跨平台」在 lint 这一格上等于不存在 |
| `pnpm test:ci-scripts` | 此前**完全没有** |

**两步都写了预测和判据**（照本文件末尾那条 `check:sources` 的先例 —— 预测要么被证实要么被推翻）：
- lint：eslint 的 import 解析吃**文件系统大小写敏感性**（`import './Foo'` 引 `foo.ts` 在 Linux 红、
  另两平台绿）。`[未验证，需真机]`
- `test:ci-scripts`：**预期在 macOS / Windows 上红**，而那正是要它的理由（探针不是门禁）。
  判据：7 个自检里 `selftest-buildbox.sh` / `selftest-build-whisper.sh` 是 bash 脚本，用到
  `mktemp` / `sed` / `grep` / `ldd`；Windows 的 Git Bash **没有 `ldd`**，macOS 的 BSD `sed -i`
  与 GNU 不兼容。→ 预期形状「Linux 绿、另两平台在这一步红」。`[未验证，需真机]`
  **红了不要加 `continue-on-error`**（文件头 ⚠️ 那条判据），要么修脚本，要么按平台收窄。

### ★ 顺手把这两步钉住了 —— 否则删掉它和"本来就没有"长得一样

`scripts/ci/lint-workflows.mjs` **+14 条断言**（纯新增，0 删除）：`ci-crossplatform.yml` 必须含
`pnpm lint` / `pnpm test:ci-scripts` / `pnpm typecheck` / `pnpm -r test`，不许出现 `pnpm -r build`，
且**不许在保留 `!cancelled()` 的同时加 `on.push`**（把文件头那条"要转门禁必须先删 `!cancelled()`"
的判据变成可执行断言）。

这一组由 `pnpm test:ci-scripts` 的第一步跑，而它在 `ci.yml` 里 ⇒ **有自动调用方**，不是又一把挂在空门上的锁。

反向验证 `[实测，4 组，/tmp 隔离副本，对照组 576 条/6 workflow 绿]`：

| 变异 | 结果 |
|---|---|
| W1 删掉 lint 步骤 | 🔴 `缺 \`pnpm lint\`` |
| W2 删掉 test:ci-scripts 步骤 | 🔴 `缺 \`pnpm test:ci-scripts\`` |
| W3 保留 `!cancelled()` 却加 `on.push` | 🔴 |
| W4 `build:safe` 换成 `pnpm -r build` | 🔴 |

### `format:check` —— **按判断没接**，理由留在了代码里

`[我实测 2026-08-07]` `npx prettier --check .` → **481 个文件不合格**
（审计记 403、上一位实测 476，**两个都已过期，别再引用**）。
今天接进去 = 一条永远红的门禁，而本仓自己写过「一条永远红的守卫等于一条被删掉的守卫」。

我**没有顺手 format**（用户要求"说出来，别顺手做"）。
→ **建议单开一个任务**，理由不只是"量大"：一次 `pnpm format` 会碰几百个文件，
与任何并行改动都必然冲突，按 PROTOCOL §10 推论它**得独占一个提交窗口**。
判据与顺序已写进 `ci-crossplatform.yml` 的 ⛔ 注释块 + `lint-workflows.mjs` 的 ⚠️，
**免得下一个人"帮忙"把它接上**。

---

## 四、⚠️ 顺带撞见的：一次疑似 §7 违规（**不是我做的**，但用户的 demo 可能已被换掉）

`[我实测]` `apps/web/dist` 下 **全部 61 个文件**的 mtime 都是 **2026-08-07 22:22:51** ——
这是**一次完整的 `vite build`**。而 `apps/daemon/src/http/static.ts:2,45` 确认 daemon
托管的就是 `apps/web/dist`，也就是 §7 说的"用户唯一能从 NAT 外访问的入口"。

**我能证明不是我**（证据链）：

| 时刻 | 事件 |
|---|---|
| 22:16:54 | 我第一次 `pnpm build:safe`（= `pnpm --filter "!@openmemo/web" -r build`，**排除 web**） |
| **22:22:51** | **`apps/web/dist` 61 个文件被整体重写。那一秒仓库里没有任何其它文件变动。** |
| 22:56:2x | 我的 `pnpm -r test`（web 用例走 `vite build --outDir .test-out/…`，**不写 dist**） |
| 22:57:26 | 我第二次 `pnpm build:safe` |

我全程只跑过 `build:safe` / `--filter @openmemo/shared build` / `npx tsc -b`。
`apps/web/tsconfig.json` 的 `outDir` 是 **`dist-types/`** 不是 `dist`，所以 `tsc -b` 也写不到那里。

**谁做的：`UNKNOWN`** —— 我拿不到证据。构建进程已退出（`ps` 里只剩 08-02 起的两个 dev server），
没有构建日志。我只能证明**不是我的任何一条命令**。同期树上确有另一个 agent 在工作：
`.github/workflows/probe-cold-timing.yml` 与 `scripts/ci/probe-cold-timing.mjs` 是**未跟踪新文件**
（mtime 22:48），**不是我的，我没有 stage 它们**。

**我没有动它**（§7：`apps/web/dist` 只由 Manager 在重启前统一构建；我去"修"就是第二次违规）。
→ **Manager 重启 demo 前请先确认 `apps/web/dist` 是不是你要的那一版。**

> 这条正好是 §7 那句话的活样本：「进程没重启、版本号没变、页面却已经是别人的半成品了。
> **没有任何东西会报错。**」—— 今天它是靠 `find -printf '%T+'` 撞出来的，不是靠任何守卫。
> **建议**：`scripts/ci/dependency-audit.mjs:9` 的文件头已经把"别人刚构建的 `apps/web/dist`"
> 列为要查的东西，但我没核实它是否真在查、有没有自动调用方 → `[未验证]`，留给下一位。

---

## 五、需要 Manager / 用户决策（2 条）

1. **`verifyCatalogSignature` 到底还删不删。** 我按你的硬约束拒绝了，证据在第一节与 `ADR-010 §附-A`。
   若看过证据仍要删，**正确切法是**：把它并进 `signature.ts` → 同步改 `verify-unpack.mjs:50` 的 import
   → 再删 `manifest.ts`。**绝不能只删文件**（会连带 53 条解包安全断言）。
   我倾向**保留**：它今天的成本只是一个文件，而收益是 `signature.ts` 唯一的覆盖来源不被打断。
2. **`format:check` 那 481 个文件要不要单开任务清。** 见第三节末。需要一个独占的提交窗口。

---

## 六、门禁

| 门禁 | 结果 |
|---|---|
| `pnpm -r test` | **1342 pass / 0 fail**（基线 1341，**+1 全是我的**：shared 删 1 加 2） |
| `npx tsc -b` | ✅ exit 0 |
| `npx eslint .` | ✅ exit 0 |
| `pnpm build:safe` | ✅ exit 0 |
| `pnpm lint-workflows` | ✅ **605 条 / 7 个 workflow**（剔除他人在途的未跟踪文件后为 **576 条 / 6 个**；我新增 14 条） |
| `pnpm test:ci-scripts` | ✅ 22 passed / 0 failed |
| `pnpm check:orphans` | ✅ **70 / 基线 70**（72 → 70，只降不升） |
| `verify-unpack.mjs` | ✅ **53 passed / 0 failed**（删改前后各跑一次，未打断） |
| `~/.local/share/openmemo/datadir.json` | ✅ `md5sum -c` OK，仍是 `/root/data-memo`（§9-bis） |

⚠️ **`lint-workflows` 的 workflow 计数从 6 变 7 不是我造成的** —— 第 7 个是另一个 agent 的未跟踪
`probe-cold-timing.yml`。我用剔除它的隔离副本复算得 576/6，两个数都如实记在这里。

---

## 七、我没做 / 没验的

- **`verifyCatalogSignature` 没删**（第一节，等你裁）。
- **`format:check` 没接、也没跑 format**（481 个文件，建议单开任务）。
- **`ci-crossplatform.yml` 仍是 `workflow_dispatch`，我刻意没改成自动触发** —— 文件头写着
  「探针的红不能拖着门禁一起红」，改它需要先删掉全部 `!cancelled()`（我已把这条钉成断言）。**这是设计，不是欠债。**
- **新加的两步在 macOS / Windows 上到底是什么结果：`[未验证，需真机]`。** 我只有 Linux，
  预测与判据写在 workflow 注释里，**跑完请回来更新那段话**（那份文件自己的规矩）。
- **`verify-unpack.mjs` 仍无任何自动调用方** —— 它承载 53+13 条安全断言，却"有人手敲才跑"。
  本轮没动，**这是我认为当前最值钱的一条剩余欠债**。
- **`apps/web/dist` 被谁重写：`UNKNOWN`**（第四节），我没动它。
- **`dependency-audit.mjs` 是否真在查"别人刚构建的 dist"、有没有调用方：`[未验证]`**。
- **没跑 `scripts/mutation-check.mjs`**（无调用方、要先 build）。我另做了 8 组自己的隔离变异替代。
- **`single-instance.ts:38` 有一个软肋我没修**（`OPENMEMO_HOST='[::1]'` 会让 `IS_PUBLIC_BIND` 误判成
  "绑在公网"并误报启动告警）。**不是本次那个坑**（它不来自 `URL.hostname`），且改它碰的是公网绑定
  告警路径，超出授权范围 → 登记在此。
