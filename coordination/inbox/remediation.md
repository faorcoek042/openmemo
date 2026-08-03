# inbox / remediation

## [2026-08-04 00:45] T-140 DONE

## TL;DR（≤25 行）

- **验收终点走通了，真浏览器 + 隔离数据目录**：`warn | tool.ytDlp | 未找到` → 捕获页粘 YouTube 链接 → `POST /api/notes/probe` **422** → 错误块上出现服务端那句「查看如何支持该站点」→ 点它落到 **`/components`** → yt-dlp 卡片「安装 2026.07.04」→ 39,924,536 B 落盘 → 自检翻成 **`ok | tool.ytDlp | …/by-name/backend/yt-dlp`** → 同一条链接再 probe **200，`adapterId:"yt-dlp"`**。全程零命令行。截图 `/tmp/remediation/{1..4}*.png`。
- **A5 的根因不是"26 个地方都忘了传 prop"，是这个 prop 要错了东西。** remediation 是**服务端随错误发来的**，调用点对它没有任何额外信息可提供——要它传，等于要它把 daemon 的 action 表再抄一遍。26 个人都不抄，是**抄不出来**。→ `ErrorBlock` 改成**默认就渲染**，`onRemediate` 降级为"我能就地办"的覆盖点。
- **比 A5 更贵的一层在下面**：两张 `action → 路由` 表加起来认识 5 个 action，`[实测]` 扫 daemon 源码，**daemon 真正会发 15 个**，其中 `switch_source`/`configure_api_key` **daemon 一次都没发过**（表里占位的是空气），而它真发的 `installSiteExtractor`（= yt-dlp 缺失）**两张表都不认识**，一起落进 default → 用户被送去 `/models` 或 `/tasks`。**按钮点得动、跳得走、就是到不了能修的那一页。**
- 收拢成 `apps/web/src/lib/remediation/routes.ts` 一份（顺带闭合 **A15**），并带一条护栏：`routes.test.ts` **直接扫 `apps/daemon/src/**`** 把 action 全抠出来，断言每一个要么有路由、要么在 `UNROUTED_ACTIONS` 里**写明为什么没有**。daemon 以后新加 action 而前端没跟上 → 门禁红。
- **诚实计数：原来的 26 个调用点里，只有 2 个真的能拿到可执行补救**（捕获页 probe → `installSiteExtractor`；数据目录 → `useExistingDataDir` 就地重发）。第 3 个（导入 → `chooseAllowedFolder`）拿得到 remediation 但**故意不给按钮**（产品里没有目录选择器）。**其余 23 个背后的端点从不发 remediation，就是普通错误 —— 我没给它们凑按钮。**
- **另有 5 个 daemon 算好的补救，此前不可能被渲染 —— 与 prop 传不传无关**：`pull.error`/`del.error`/`select.error`/`selfTest.error` **全仓零渲染点**（点安装磁盘不够、点自检失败，界面上一个字都不显示）。补了 4 个 `<ErrorBlock>`，放出 `accept_license` / `free_disk` / `activate_model` / `install_backend` / `install_model`。
- **`/components` 的落点我选了 `/runtime` 的页头，不是第 8 条侧栏**，依据写在 `RuntimePage.tsx:118-142`：`[实测]` `GET /api/components` 的 8 条里 6 条 id 与 `/api/backends/catalog` 的包 id **逐字相同** → 它不是第四类东西，是同一批二进制的**另一个轴**；按 D-10 §3.2 的 R1（换掉它输出会变的才叫模型）它不归 `/models`；按 D-10 的 R3（同一问题只准一个出处）再开一条一级入口就是给"yt-dlp 装不装得上"开第二个出处。
- 🔴 **一条订正 debt-audit 的实测**：A4 说「唯一能装回来的那个页面用户走不到」——**`/runtime` 上其实一直有一张可用的 yt-dlp 安装卡**（`applicable:true, recommended:true`，T-132 加进 `backends.json` 时一并进了 backends catalog）。"唯一入口"这个说法不成立；成立的是「**`/components` 不可达**」与「**补救链是死的**」。
- 🔴 **另一条**：demo 的 `warn | tool.ytDlp | 未找到` 来自 `GET /api/selfcheck`，而 **web 界面没有任何一处读这个端点**。`/diagnostics` 读的是 `/api/health`，而 `health.pipeline.missing` 是 `[]`（不含 ytDlp）。**那句 warn 在界面上唯一会显形的地方就是 F1 的那条 422** —— 也就是本轮修的这条。`DiagnosticsPage.tsx:29` 还写着「selfcheck 只是 CLI，没有对应的 HTTP 端点」，**该端点已经存在**（⑤D 那族）。
- **反向验证 6 组，全贴真实输出**（§5），含"daemon 新增一个没人认领的 action"这条活体变异。
- ✅ `tsc -b` 0 · `pnpm -r test` **797 pass / 0 fail / 1 todo**（797 里我新增 **22 条**：12 单测 + 10 组件）。⚠️ `eslint .` **1 错**，在 `scripts/check-test-scripts.mjs:10`（`test-gaps` 的未跟踪新文件，不是我的，我没碰）。
- **SHARED-CHANGE 两处**（§7）：`ErrorBlock` 行为变更（签名未变）、`src/test/components.test.tsx` 追加。
- 未 `git add`、未 commit、未碰 `/root/data-memo`、**指针文件 sha256 前后一致**、未重启/占用 `:10000`、未跑 `pnpm -r build`（用的 `build:safe`）、未用 `pkill -f`、未跑本地 whisper 转写。

---

交付（精确清单，未 `git add`）：

**新增**
- `apps/web/src/lib/remediation/routes.ts` —— 全仓唯一一份 `action → 路由` 表
- `apps/web/src/lib/remediation/routes.test.ts` —— 12 条，含扫 daemon 源码的护栏

**修改**
- `apps/web/src/components/common/ErrorBlock.tsx` —— **SHARED-CHANGE**，默认渲染补救按钮
- `apps/web/src/components/common/RemediationButton.tsx` —— 走共享表；`fallbackLabel`；无落点则不渲染
- `apps/web/src/components/common/JobToaster.tsx` —— 删掉第二张路由表，复用同一个按钮
- `apps/web/src/lib/api/client.ts` —— `ApiError` 不再丢掉 `labelZh` / `label`
- `apps/web/src/features/runtime/RuntimePage.tsx` —— `/components` 入口 + `select`/`selfTest` 错误渲染
- `apps/web/src/features/models/ModelsPage.tsx` —— `pull`/`del` 错误渲染
- `apps/web/src/features/settings/DataLocationSection.tsx` —— `useExistingDataDir` 就地补救
- `apps/web/src/app/i18n/locales/{zh-CN,en}.json` —— `runtime.componentsLink{,Hint}` 各 2 键
- `apps/web/tsconfig.test.json` —— 登记新单测（显式白名单）
- `apps/web/src/test/components.test.tsx` —— **SHARED-CHANGE**，追加 10 条

---

# 1. `/components` 放哪里 —— 结论与依据

## 1.1 先摆事实：三页今天各自问什么 `[实测]`

| 页 | 端点 | 它回答的问题 | 对象 |
|---|---|---|---|
| `/models` | `/api/models/catalog`+`/installed` | 转写/语言模型我要用哪一个 | 权重 |
| `/runtime` | `/api/backends/catalog`+`/installed`+`/api/runtime/hardware` | **这台机器**该装哪些二进制、装没装上、自检过没过 | 后端包（26 个，按平台） |
| `/components` | `/api/components` | 这个二进制**从哪来、钉在哪版、上游有没有新版、能不能回滚** | 组件（8 个） |

`[实测]` 两个目录的 id **高度重合**：`/api/components` 的 8 条里 **6 条**（`whispercpp-cpu-linux-x64` / `libsimple-linux-x64` / `sqlite-vec-linux-x64` / `media-tools-linux-x64` / `ytdlp-linux-x64` / `llamacpp-cpu-linux-x64`）与 `/api/backends/catalog` 的包 id **逐字相同**；另两条是 `sherpa-onnx-node` 与一个 ASR 模型。

**所以 `/components` 不是第四类东西，它是 `/runtime` 那批东西的另一个轴。**

## 1.2 三条判据（都用别人已经立好的规矩，不是我现编的）

1. **D-10 §3.2 的 R1 判据**：「换掉它输出会变的才叫模型」。换 yt-dlp 的版本，转出来的字**不变** → 它不是模型 → 不归 `/models`，归 `/runtime` 这一侧。
2. **D-10 的 R3**：「同一问题只准一个出处」。"yt-dlp 装不装得上"如果在侧栏出现第二个一级入口，就是给同一个问题开了两个出处 —— 而 `/runtime` 上**已经有一张可安装的 yt-dlp 卡**（见 §6 那条订正）。
3. **R-06 #3 的 memo.ac 取证**：它把 yt-dlp 做成可独立在线升级（`ytdlp:check-update` / `:download-version` / `:reset-to-builtin`），R-06 给我们记的是「❌ 完全没做」。**其实做了**（`/components` 整页 + `/api/components*`），只是**用户走不到** —— 这条对照本身就说明问题出在可达性，不出在缺功能。而 memo.ac 的侧栏 6 项里也**没有**组件项，它把这类东西放在应用/设置层。

## 1.3 落点

`RuntimePage` 页头右侧一条链接（`data-testid="runtime-components-link"`），文案「组件与来源 · 从哪下载 · 钉在哪版 · 更新/回滚」。加上 `installSiteExtractor` → `/components` 这条 remediation，一共**两条进入路径**。

## 1.4 我明确没做、留给 `architect` 的

D-10 §3.3 规划的 `/runtime` 页内「转写加速后端 / 功能组件」两分区，覆盖的**和 `/components` 是同一批东西**。D-10 写的时候**没看见这一页** —— 它的取证是在 `:10000` 上做的，而这一页当时不可达。两者最终怎么合并（页内分区 vs 独立页）是版面裁决，归 `architect`，**我只把路走通，不替它决定**。这条写进了 `RuntimePage.tsx:139-141` 的注释里。

---

# 2. 26 个调用点，逐个判断

判据：**这个调用点背后的端点，daemon 会不会给它发 remediation。** 这不是猜——`[实测]` 扫全仓 daemon 源码，会发 remediation 的端点只有 7 个：`server.ts`（全局 401/403）、`storage.ts`（data-dir）、`notes.ts`（probe/import）、`models.ts`（install/delete）、`jobs.ts`（pause/resume）、`backends.ts`（select）、`hardware.ts`（selftest）。

## 2.1 有真补救的：**2 个**（外加 1 个"有 remediation 但故意不给按钮"）

| 调用点 | 端点 | daemon 发的 action | 处置 |
|---|---|---|---|
| `CapturePage.tsx:170`（probe） | `POST /api/notes/probe` 422 `NO_MEDIA_SOURCE` | `installSiteExtractor`（`rest/notes.ts:144`） | ✅ **跳 `/components`** —— 本轮验收的那一条 |
| `DataLocationSection.tsx:385` | `POST /api/settings/data-dir` 409 | `useExistingDataDir`（`rest/storage.ts:266`） | ✅ **就地重发**（唯一一个传 `onRemediate` 的） |
| `CapturePage.tsx:214`（import） | `POST /api/notes/import` 403 | `chooseAllowedFolder`（`rest/notes.ts:196`） | ⛔ **故意不给按钮**：产品里没有目录选择器，允许的根已经在错误详情里，跳 `/capture` 是原地转圈（用户本来就在那儿） |

## 2.2 普通错误：**23 个**

`ModelDetailPage:50` · `NotesListPage:67` · `TasksDrawer:41` · `RetranscribeButton:165` · `RuntimePage:163,179` · `MindmapPage:30,50` · `ModelsPage:417` · `GenerateMindmapButton:90` · `SearchPage:84` · `NoteDetailPage:114` · `StorageSettingsPage:26` · `ComponentsPage:140` · `TasksPage:20` · `ProxySettingsSection:260,271,308` · `CapturePage:262`（上传） · `LlmSettingsSection:95,138,139,140`

它们背后全是 GET 目录/列表或没有 remediation 的写操作。**daemon 从不给这些路径发 remediation，所以这里就是没有按钮，我没有编。**

> 有一个例外要说清楚：**任何一个**调用点都可能撞上全局 401（`openHandoffUrl`）或 403 CSRF（`reauth`）。这两个我列进 `UNROUTED_ACTIONS`：401 由 `ErrorBlock` 既有的 `isAuth`「重新连接」分支管（跳任何路由都只是带着同一个失效令牌再撞一次），403 由 `client.ts:316` 的 `shouldReauth()` 在请求层自愈、根本到不了 UI。

## 2.3 额外发现：5 个补救**此前不可能被渲染，与 prop 无关**

`[实测]` 这 4 个 mutation 的 `error` **全仓零渲染点**：

| mutation | 端点 | daemon 的 action | 用户看到的 |
|---|---|---|---|
| `ModelsPage` `pull` | `POST /api/models/:id/install` | `accept_license`(models.ts:353) / `free_disk`(:369) | 点安装磁盘不够 → **一个字都不显示** |
| `ModelsPage` `del` | `DELETE /api/models/:id` | `activate_model`(:597) | 删不掉正在用的模型 → 同上 |
| `RuntimePage` `select` | `POST /api/backends/select` | `install_backend`(backends.ts:330) | 同上 |
| `RuntimePage` `selfTest` | `POST /api/backends/selftest` | `install_backend`/`install_model`(hardware.ts:204←setup.ts:574) | 点自检 → 同上 |

三条 models 的错误都是**在建 job 之前**同步返回的，所以 `JobToaster` 也永远看不到它们。已补 4 个 `<ErrorBlock>`（`ModelsPage.tsx:430-431`、`RuntimePage.tsx:190-191`）。

## 2.4 我**知道**但没修的一个洞

`cancel_job`（`rest/jobs.ts:182`，暂停/继续 501 → 建议改为取消）**到不了任何 `<ErrorBlock>`**：`JobList.tsx:122` 的 `actions.pause.mutate()` 没有任何地方渲染 `isError` —— **点「暂停」是静默无反应**。它的补救是"就地取消这个 job"，不是跳转。没修的理由：pause/resume 本身就是未实现的功能，给一个未实现按钮配补救按钮价值低；且 `features/tasks` 是另一片。**记在这里，不在表里假装解决**（理由已写进 `UNROUTED_ACTIONS.cancel_job`）。

---

# 3. 那条被漏掉的 action 表

`[实测]` 扫 `apps/daemon/src/**/*.ts`（剥注释后）抠出的全部 remediation action，共 **15 个 / 17 处**：

```
accept_license           apps/daemon/src/http/rest/models.ts:353
activate_model           apps/daemon/src/http/rest/models.ts:597
cancel_job               apps/daemon/src/http/rest/jobs.ts:182
chooseAllowedFolder      apps/daemon/src/http/rest/notes.ts:196
configureLlm             apps/daemon/src/jobs/runners/mindmap.ts:104
free_disk                apps/daemon/src/http/rest/models.ts:369
installModel             apps/daemon/src/jobs/runners/transcribe.ts:158
installSiteExtractor     apps/daemon/src/http/rest/notes.ts:144
install_backend          apps/daemon/src/http/rest/backends.ts:330
install_backend          apps/daemon/src/runtime/setup.ts:277
install_backend          apps/daemon/src/runtime/setup.ts:574
install_model            apps/daemon/src/runtime/setup.ts:574
openHandoffUrl           apps/daemon/src/http/server.ts:252
reauth                   apps/daemon/src/http/server.ts:327
retry_probe              apps/daemon/src/runtime/setup.ts:284
transcribeFirst          apps/daemon/src/jobs/runners/mindmap.ts:72
useExistingDataDir       apps/daemon/src/http/rest/storage.ts:266
```

对照修之前的两张表（`install_model` / `install_backend` / `free_disk` / `switch_source` / `configure_api_key`）：

- **命中 3 个**（`install_model` / `install_backend` / `free_disk`）；
- **`switch_source` 与 `configure_api_key` daemon 一次都没发过** —— 表里占的是空气。顺带说明 **A14**（`/models?panel=sources` 空 deep-link）今天不可能被触发，因为**没人发那个 action**；我把 `switch_source` 整条删了，而不是留着一个指向没人读的查询串的路由；
- **剩下 12 个全部落进 default**，包括 `installSiteExtractor`。

**同一个拼写问题在 daemon 内部也有**：`install_model`（HTTP）与 `installModel`（job blocked 事件）是同一件事的两种写法。表里两个都认，映到同一个落点，并在注释里写明。**这不是我该单方面改 daemon 的事**（改了会让旧前端认不出），列在 §8 给 Manager。

## 3.1 护栏

`routes.test.ts` 的守卫直接读 daemon 源码，断言 `daemon 发的 action ⊆ 有路由 ∪ 明写理由不给路由`，另加两条前提断言（源码目录找得到 / 扫得出 ≥10 个且三个定点 anchor 在）—— 因为**扫描正则失效 → 空集 → 断言假绿**是 ⑤A-2 那一族。

判据是**结构**（`action:` 出现在提到 remediation 的上下文里），不是关键词匹配某个具体动作名。扫描前**先剥注释**（被注释掉的 `action: 'foo'` 会造成假红），且块注释用**等量换行**替换 —— `[实测]` 第一版直接删块注释，把 `rest/notes.ts:144` 报成了 `:96`，**一条报错位置的护栏等于让下一个人多查一遍**。

---

# 4. `ApiError` 在离终点一行的地方把服务端文案扔了

`lib/api/client.ts` 原本：

```ts
this.remediation =
  (body.remediation as { action: string; params?: Record<string, unknown> } | undefined) ?? null;
```

**只留 `action` 和 `params`**。daemon 15 个发出点每一个都写了中文按钮文案（「查看如何支持该站点」/「去接受许可」/「直接使用此目录」…），信封里也确实带着 —— 在这一行被解析掉。就算 UI 渲染出按钮，按钮上也没有服务端那句话（会退化成 `installSiteExtractor` 这种原始 action 名，见 §5 反向验证 5 的真实输出）。

顺带去掉了那个 `as` 断言（规矩 5）：`ApiErrorBody['error'].remediation` 本来就是 `Remediation`，把契约交给编译器守。

---

# 5. 反向验证（6 组，真实输出）

> 方法：把修复逐条撤掉 → **先 grep 确认坏行在即将运行的产物里** → 跑 → 贴红 → 还原。

### 5.1 删掉 `installSiteExtractor` 的路由

产物核对：`grep -c installSiteExtractor .test-out/unit/lib/remediation/routes.js` → **1**（注释里那次，路由确实没了）

```
✖ ★ installSiteExtractor 落在 /components，不是 /models 也不是 /tasks
  AssertionError: + actual - expected
  + '/tasks'
  - '/components'

✖ ★ 每个 action 要么有路由，要么在 UNROUTED_ACTIONS 里写明为什么没有
  daemon 新发了这些 action，前端一条都不认识 —— 它们会静默落进 /tasks：
    installSiteExtractor（/root/memo/apps/daemon/src/http/rest/notes.ts:96）
  + [ 'installSiteExtractor（…notes.ts:96）' ]   - []
ℹ pass 61  ℹ fail 2
```
组件侧同一变异体：
```
✖ ★ 点下去落到 /components（不是 /models，也不是 /tasks）   actual:'/tasks'  expected:'/components'
✖ ★ 点「开始」→ 422 → 「查看如何支持该站点」→ /components   actual:'/tasks'  expected:'/components'
ℹ tests 200  ℹ pass 198  ℹ fail 2
```
（顺带：这次红灯里那个 `:96` 就是上面说的行号 bug，已修成等量换行，现在报 `:144`。）

### 5.2 把 `ErrorBlock` 的渲染条件改回 `api?.remediation && onRemediate`

产物核对：`grep -c "api?.remediation && onRemediate" .test-out/components/components.test.js` → **2**（一处注释 + 一处代码，坏行在产物里）
```
✖ ★ 一个 prop 都不传，补救按钮就得在（这正是 26 处全都不传的那个前提）  actual:false expected:true
✖ ★ 按钮上写的是服务端那句话                                        actual:''    expected:'查看如何支持该站点'
✖ ★ 点下去落到 /components（不是 /models，也不是 /tasks）
✖ ★ 点「开始」→ 422 → 「查看如何支持该站点」→ /components
ℹ tests 200  ℹ pass 196  ℹ fail 4
```

### 5.3 删掉 `/runtime` 上那条 `<Link to="/components">`

产物核对：`grep -c runtime-components-link .test-out/components/assets/RuntimePage*.js` → **0**（链接确实不在产物里）
```
✖ ★ 从 /runtime 点得到 /components —— 且落地的真是那一页，不只是 URL 变了
ℹ tests 200  ℹ pass 199  ℹ fail 1
```

### 5.4 从 `routes.tsx` 摘掉 `...componentsRoutes`

（这一条钉的是**路由注册**：5.3 那条仍然会绿，因为 href 还在。两件事必须分开钉。）
```
✖ ★ /components 这个地址真的渲染出组件页（路由被摘掉时必须红）
  actual: 0   expected: 1
ℹ tests 200  ℹ pass 199  ℹ fail 1
```

### 5.5 让 `ApiError` 重新丢掉 `labelZh`

```
✖ ★ 按钮上写的是服务端那句话（labelZh 一度在 ApiError 构造函数里被解析掉）
  actual:   'installSiteExtractor'
  expected: '查看如何支持该站点'
ℹ tests 200  ℹ pass 199  ℹ fail 1
```
（红灯里 `actual` 正是原始 action 名 —— 这就是"渲染出来了但没有服务端那句话"的样子。）

### 5.6 **活体变异**：模拟 daemon 新增一个前端还不认识的 action

临时写入 `apps/daemon/src/http/rest/__t140_mutant.ts`（内含 `remediation:{action:'brandNewActionNobodyClaimed',…}`），跑完**立刻删除并核对 0 残留**：
```
✖ ★ 每个 action 要么有路由，要么在 UNROUTED_ACTIONS 里写明为什么没有
  brandNewActionNobodyClaimed（/root/memo/apps/daemon/src/http/rest/__t140_mutant.ts:4）
  actual: [ 'brandNewActionNobodyClaimed（…__t140_mutant.ts:4）' ]   expected: []
ℹ pass 74  ℹ fail 1
```
→ **这条护栏钉的正是本轮 bug 的成因**：daemon 加了 action，前端没跟上，从前**不会有任何东西说一句话**。

---

# 6. 端到端实测（真浏览器 · 我自己的临时数据目录）

环境：daemon `node dist/main.js --data-dir /tmp/remediation/data --port 17651`（**不是** `:10000`），`vite --port 5211` 代理到它。`[实测]` `GET /api/health` → `dataDir=/tmp/remediation/data`。

起始态与 demo 一致：
```
warn | tool.ytDlp | 未找到
```

Playwright 走一遍（`/tmp/remediation/walk.mjs`）：
```
步骤 1  打开 /capture
步骤 2  粘链接 + 点「开始」
        probe 结果： POST /api/notes/probe → 422
步骤 3  补救按钮数量 = 1 文案「查看如何支持该站点」
步骤 4  点「查看如何支持该站点」→ 落地 /components
步骤 5  页面里有 yt-dlp 吗： true
```
接着点安装（`/tmp/remediation/install.mjs`）：
```
步骤 6  yt-dlp 卡片上的安装按钮： 1 → 安装 2026.07.04
        确认框： 安装「yt-dlp 站点解析器（Linux x64）」2026.07.04？
步骤 7  点了安装，等下载…
        t+5s   installedVersion=null
        t+10s  installedVersion=null
        t+15s  installedVersion="installed"
  POST /api/components/ytdlp-linux-x64/update → 202
```
落盘与自检：
```
39924536 /tmp/remediation/data/models/by-name/backend/yt-dlp   (-rwxr-xr-x)
自检： ok | tool.ytDlp | /tmp/remediation/data/models/by-name/backend/yt-dlp
```
**回到起点复验**（同一条链接，装完再 probe 一次）：
```
http=200
{"title":"Rick Astley - Never Gonna Give You Up …","adapterId":"yt-dlp","durationMs":213000,…}
```

截图：`/tmp/remediation/1-capture-error.png`（错误块 + 补救按钮）· `2-components.png`（落地组件页）· `3-ytdlp-card.png` · `4-installed.png`。

## 6.1 🔴 两条订正 `debt-audit`（都是实测，不是意见）

**订正 1 —— A4 的「唯一入口」不成立。** `[实测]` `GET :10000/api/backends/catalog` 里就有：
```
ytdlp-linux-x64   applicable=True  installed=False  backend=cpu  recommended=True
```
也就是说 **`/runtime` 上一直有一张可点的 yt-dlp 安装卡**（T-132 往 `backends.json` 补条目时一并进了 backends catalog，而 `ComponentCard.tsx:130` 那句注释写在那之前）。所以「唯一能装回来的那个页面用户走不到」这句**不成立**；成立的是两条更窄的事实：**`/components` 不可达**，以及**补救链是死的**。这条不影响 T-140 该做的事，但影响"到底有多急"的判断，必须报上来。

**订正 2 —— 那句 warn 在界面上根本没有出处。** demo 的 `warn | tool.ytDlp | 未找到` 来自 `GET /api/selfcheck`，而 **web 全仓没有任何一处读这个端点**（`grep`）。`/diagnostics` 读的是 `/api/health`，`[实测]` demo 上 `health.pipeline.missing` 是 `[]` —— 不含 ytDlp。所以「从那句 warn 一路点到安装」在字面上做不到：**它在界面上唯一会显形的地方就是 F1 的那条 422**，也就是本轮打通的这条。

顺带：`DiagnosticsPage.tsx:29` 的注释还写着「目前 selfcheck 只是 CLI，**没有对应的 HTTP 端点**，所以这一页给不出功能级结论」—— `[实测]` `GET /api/selfcheck` **返回 26 条结果、200**。又一例 ⑤D「后端做好了没人回来开」，而且**它正压着一页比 `/api/health` 强得多的诊断信息**。建议单开一张卡（见 §8）。

---

# 7. SHARED-CHANGE 申报（两处）

## 7.1 `components/common/ErrorBlock.tsx` —— 行为变更，**签名未变**

- `ErrorBlockProps` 的字段与类型**一个都没改**（`onRemediate?: (action, params) => void` 原样保留）；
- 变的是**渲染条件**：`api?.remediation && onRemediate` → `api?.remediation`。
- **对现有 26 个调用点的影响**：它们全都没传 `onRemediate`，此前渲染 `null`，现在会在**服务端真的发了 remediation 时**多出一个按钮。按 §2 的实测，实际会多出按钮的只有 `CapturePage.tsx:170` 一处。其余 25 处行为逐字不变。
- 按钮文案优先级：服务端 `labelZh` → `label` → 调用方给的 `fallbackLabel`（`ErrorBlock` 传的是本地 `errors.<CODE>.action`）→ 原始 action 名。**旧行为把本地文案排在服务端前面**，那对 `errors.UNAUTHENTICATED.action`（"重新连接"）这类**根本不是补救文案**的键是错的。
- ⚠️ 给正在改 `NoteDetailPage.tsx` 的 `notes-contract`：你那两处 `<ErrorBlock>`（`NoteDetailPage.tsx:114`）背后是 `GET /api/notes/:uid`，daemon 不给它发 remediation，**你看到的渲染结果不会有任何变化**。

## 7.2 `src/test/components.test.tsx` —— 追加 10 条

追加在**文件末尾**（`describe('T-140 ①/②/③')`），并在既有 import 行上加了一个符号（`ErrorBlock`）。为避开与 `wire-up` 的并发写，追加用的是 shell `>>` 而不是按行匹配的编辑。期间 `wire-up` 提交了 `8ecac4f`，把我当时已落盘的用例一并带进了那个提交（我们共用同一份工作区，无分支）—— **已核对我的 4 处 `T-140` 标记与 `runtime-components-link` 断言都在**。

---

# 8. 需要 Manager 决策 / 交给别人的

1. **`/runtime` 页内「功能组件」分区 与 `/components` 怎么合并** → `architect`（D-10 §3.3 + 本文 §1.4）。我只做了可达性，没动版面。
2. **daemon 的 action 命名两套拼写**（`install_model` vs `installModel`；`configureLlm`/`installSiteExtractor`/`transcribeFirst` 是 camelCase，`free_disk`/`accept_license` 是 snake_case）。前端两个都认了，但这是**契约层的不一致**，改 daemon 会让旧前端认不出，需要裁决与迁移窗口。
3. **`/api/selfcheck` 没有任何界面在读**（§6.1 订正 2）。它比 `/api/health` 强得多（26 条，含 `tool.ytDlp` / `backend.libLinks` / `ext.chineseSearch` 这些功能级探针）。建议给 `/diagnostics` 单开一张卡 —— 那正是"用户能自己看出哪里坏了"的前置条件。**不在本轮范围，未做。**
4. **`JobList` 的 pause/resume 错误零渲染**（§2.4）：点「暂停」静默无反应。
5. 🟡 `eslint .` 现在有 **1 个错**：`scripts/check-test-scripts.mjs:10:41 no-irregular-whitespace`。那是 `test-gaps` 的未跟踪新文件，**我没有碰它**，报出来免得被算在本轮头上。

---

# 9. 纪律核对

| 条 | 结果 |
|---|---|
| `apps/web/dist` 未被覆盖 | ✅ `index.html` 时间戳仍是 `Aug 3 23:53`（我动手前）。构建全程用 `pnpm build:safe` |
| `:10000` 只读 | ✅ 只发过 GET（`/api/health`、`/api/selfcheck`、`/api/components`、`/api/backends/catalog`）。未重启、未 kill、未占用 |
| 自起服务端口 | ✅ daemon `17651` + vite `5211`（避开 5194/5196/5199/5203/5207），**跑完按 PID `kill`，未用 `pkill -f`**，已核对端口释放 |
| `/root/data-memo` | ✅ 未读写。所有安装落在 `/tmp/remediation/data` |
| `datadir.json` 指针（PROTOCOL §9） | ✅ **动手前备份 + 事后 sha256 逐字核对一致**：`7f930979b85204d4c05b221f4c17a5cf5936a4d432a46488816727f60da233f3`，内容仍是 `{"dataDir":"/root/data-memo"}`。核实过只有 `POST /api/settings/data-dir` 会写它（`rest/storage.ts:231,331`），`--data-dir` 启动不写 |
| 本地 whisper 转写 | ✅ 未跑 |
| `git add -A` / commit | ✅ 未做（精确清单在交付段） |
| 临时变异体残留 | ✅ `apps/daemon/src/http/rest/__t140_mutant.ts` 已删，核对 0 残留 |
