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
