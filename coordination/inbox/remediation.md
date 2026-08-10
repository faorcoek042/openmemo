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

| 页            | 端点                                                         | 它回答的问题                                               | 对象                    |
| ------------- | ------------------------------------------------------------ | ---------------------------------------------------------- | ----------------------- |
| `/models`     | `/api/models/catalog`+`/installed`                           | 转写/语言模型我要用哪一个                                  | 权重                    |
| `/runtime`    | `/api/backends/catalog`+`/installed`+`/api/runtime/hardware` | **这台机器**该装哪些二进制、装没装上、自检过没过           | 后端包（26 个，按平台） |
| `/components` | `/api/components`                                            | 这个二进制**从哪来、钉在哪版、上游有没有新版、能不能回滚** | 组件（8 个）            |

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

| 调用点                          | 端点                                          | daemon 发的 action                            | 处置                                                                                                              |
| ------------------------------- | --------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `CapturePage.tsx:170`（probe）  | `POST /api/notes/probe` 422 `NO_MEDIA_SOURCE` | `installSiteExtractor`（`rest/notes.ts:144`） | ✅ **跳 `/components`** —— 本轮验收的那一条                                                                       |
| `DataLocationSection.tsx:385`   | `POST /api/settings/data-dir` 409             | `useExistingDataDir`（`rest/storage.ts:266`） | ✅ **就地重发**（唯一一个传 `onRemediate` 的）                                                                    |
| `CapturePage.tsx:214`（import） | `POST /api/notes/import` 403                  | `chooseAllowedFolder`（`rest/notes.ts:196`）  | ⛔ **故意不给按钮**：产品里没有目录选择器，允许的根已经在错误详情里，跳 `/capture` 是原地转圈（用户本来就在那儿） |

## 2.2 普通错误：**23 个**

`ModelDetailPage:50` · `NotesListPage:67` · `TasksDrawer:41` · `RetranscribeButton:165` · `RuntimePage:163,179` · `MindmapPage:30,50` · `ModelsPage:417` · `GenerateMindmapButton:90` · `SearchPage:84` · `NoteDetailPage:114` · `StorageSettingsPage:26` · `ComponentsPage:140` · `TasksPage:20` · `ProxySettingsSection:260,271,308` · `CapturePage:262`（上传） · `LlmSettingsSection:95,138,139,140`

它们背后全是 GET 目录/列表或没有 remediation 的写操作。**daemon 从不给这些路径发 remediation，所以这里就是没有按钮，我没有编。**

> 有一个例外要说清楚：**任何一个**调用点都可能撞上全局 401（`openHandoffUrl`）或 403 CSRF（`reauth`）。这两个我列进 `UNROUTED_ACTIONS`：401 由 `ErrorBlock` 既有的 `isAuth`「重新连接」分支管（跳任何路由都只是带着同一个失效令牌再撞一次），403 由 `client.ts:316` 的 `shouldReauth()` 在请求层自愈、根本到不了 UI。

## 2.3 额外发现：5 个补救**此前不可能被渲染，与 prop 无关**

`[实测]` 这 4 个 mutation 的 `error` **全仓零渲染点**：

| mutation                 | 端点                           | daemon 的 action                                                | 用户看到的                          |
| ------------------------ | ------------------------------ | --------------------------------------------------------------- | ----------------------------------- |
| `ModelsPage` `pull`      | `POST /api/models/:id/install` | `accept_license`(models.ts:353) / `free_disk`(:369)             | 点安装磁盘不够 → **一个字都不显示** |
| `ModelsPage` `del`       | `DELETE /api/models/:id`       | `activate_model`(:597)                                          | 删不掉正在用的模型 → 同上           |
| `RuntimePage` `select`   | `POST /api/backends/select`    | `install_backend`(backends.ts:330)                              | 同上                                |
| `RuntimePage` `selfTest` | `POST /api/backends/selftest`  | `install_backend`/`install_model`(hardware.ts:204←setup.ts:574) | 点自检 → 同上                       |

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

| 条                                 | 结果                                                                                                                                                                                                                                                            |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/dist` 未被覆盖           | ✅ `index.html` 时间戳仍是 `Aug 3 23:53`（我动手前）。构建全程用 `pnpm build:safe`                                                                                                                                                                              |
| `:10000` 只读                      | ✅ 只发过 GET（`/api/health`、`/api/selfcheck`、`/api/components`、`/api/backends/catalog`）。未重启、未 kill、未占用                                                                                                                                           |
| 自起服务端口                       | ✅ daemon `17651` + vite `5211`（避开 5194/5196/5199/5203/5207），**跑完按 PID `kill`，未用 `pkill -f`**，已核对端口释放                                                                                                                                        |
| `/root/data-memo`                  | ✅ 未读写。所有安装落在 `/tmp/remediation/data`                                                                                                                                                                                                                 |
| `datadir.json` 指针（PROTOCOL §9） | ✅ **动手前备份 + 事后 sha256 逐字核对一致**：`7f930979b85204d4c05b221f4c17a5cf5936a4d432a46488816727f60da233f3`，内容仍是 `{"dataDir":"/root/data-memo"}`。核实过只有 `POST /api/settings/data-dir` 会写它（`rest/storage.ts:231,331`），`--data-dir` 启动不写 |
| 本地 whisper 转写                  | ✅ 未跑                                                                                                                                                                                                                                                         |
| `git add -A` / commit              | ✅ 未做（精确清单在交付段）                                                                                                                                                                                                                                     |
| 临时变异体残留                     | ✅ `apps/daemon/src/http/rest/__t140_mutant.ts` 已删，核对 0 残留                                                                                                                                                                                               |

---

## [2026-08-10 02:20] T-192 任务中心「点不进历史记录」追查 — PROGRESS（诊断阶段；**A 档已于 03:10 落地，见下条**）

### 一句话

**三种可能里的第 1 种：功能没做 —— 任务中心的行从来就不是可点的。**
但**不是"要从零造个功能"**：契约里为这个动作留的字段在发、动作本身也已经在产品里跑着（只在瞬时 Toast 上），**断的是任务中心把字段解析掉了 + 行上没有任何 handler**。

### 用户现在到底怎么看历史记录

1. **"有哪些任务跑过"看得到，而且真的持久** —— `:10000` 此刻列着 6 条，最早 8 月 2 日（8 天前）。服务端口径 `pipelineJobs.list(50)` + 下载队列（`rest/jobs.ts:79`），即**最近 50 条流水线任务**。
2. **"从某一条任务点进它做出来的东西" —— 做不到。** 今天唯一办法：侧栏「全部笔记」→ **按标题自己对**（job 的 `displayName` 就是笔记标题，对得上，但界面上没有任何地方告诉他可以这么对）。
3. 那个**正确的出口只在任务刚跑完的几秒内、以 Toast 形式出现一次**（`JobToaster.tsx:476-486` 的「去看笔记」），刷新 / 切页 / 手动关掉 / 在另一个标签页 —— 四种情况全丢（这四种正是 `tasks/api.ts:243-249` 自己列的）。

> **任务中心本来就是为了补 Toast 的易失性才做的持久层（`api.ts:10-31` 白纸黑字），却唯独没继承 Toast 唯一那个出口。**

### 实测证据（真浏览器，`:10000` 只读，`/tmp/tasks-click/probe.mjs`）

先确认安全：`GET /api/jobs` 6 条**全是 `succeeded`** ⇒ 按 `JobList.tsx:131-155` 四个动作按钮一个都不渲染 ⇒ 点行不可能触发任何 mutation。

```
① 任务中心行数 = 6   当前 URL = /tasks
② 第一行体检（结构判据）：
    tag=LI  onclickAttr=null  role=null  tabindex=null  cursor="auto"
    anchorCount=0  anchorHrefs=[]  buttonCount=0  buttonTexts=[]
    text="JFK 就职演说片段 | 已完成"
③ 真的点一下：
   点击事件被派发了吗 = true  {"tag":"SPAN","defaultPrevented":false,
                              "path":"SPAN < DIV < LI < UL < SECTION < DIV"}
   URL 变了吗 = false (/tasks → /tasks)
   点击后新增 API 请求 = ["GET /api/events","GET /api/health","GET /api/folders"]（都是轮询，与点击无关）
   控制台报错 = (无)
④ 整行其它位置（进度条区/空白处）再点：URL 不变
⑤ 双击：URL 不变
⑥ 行内可聚焦元素数 = 0   ← 键盘用户同样到不了
```

**为什么这排除了第 2 种（有 handler 但无效）**：捕获期监听器证明**点击事件确实完整冒泡到了 LI 和 UL**，`defaultPrevented:false` —— **没有任何东西吞它、没有 `preventDefault`、没有父元素抢**。事件到齐了，只是**路径上一个监听器都没有**。`cursor:auto`（连"这里能点"的手型都没有）与 `tabindex=null` 是同一结论的旁证。

### 断在哪一跳（file:line）

| 跳 | 状态 |
|---|---|
| daemon 算 | ✅ `:10000` 6 条 job **每条都带 `noteUid`**（实测） |
| 契约声明 | ✅ `packages/shared/src/jobs.ts:302-303` 原话：<br>`/** Owning note, so the UI can offer "open the note" without a lookup table. */`<br>`noteUid: string | null;` —— **契约就是为这个动作准备的** |
| **前端 DTO** | 🔴 **`apps/web/src/features/tasks/api.ts:52-69` 的 `MergedJob` 里没有 `noteUid`**，`mergeOne()`（`:71-113`）**两个分支都没拷贝它** → 字段在这里被解析掉 |
| 渲染 | 🔴 `apps/web/src/features/tasks/JobList.tsx:86` 的 `<li>` 是纯展示节点，无 `onClick` / `<Link>` / `role` / `tabindex` |
| 同一动作的既有实现 | ✅ `apps/web/src/components/common/JobToaster.tsx:476-486` `navigate('/notes/'+noteUid)`，`data-testid="job-toast-goto-note"` —— **已上线、已验证，只活在瞬时层** |

**这与我 T-140 修的 `ApiError` 丢 `labelZh` 是同一形状**：服务端算好并发出，客户端在离终点一行的地方把它解析掉，全程零报错。也是 `debt-audit` C11「daemon 发了、前端一处都不读的字段」那一族。

### 落地页真有他要的东西吗（判据不是"跳转发生了"）

实测三个候选落点，全部有实质内容（`/tmp/tasks-click/landing.mjs`）：

```
transcribe job → /notes/01KZ1H8Y…      标题 ["JFK 就职演说片段","转写稿"]  正文 183 字
                                        "And so my fellow Americans, ask not what your country can do for you…"
mindmap  job  → /notes/01KZ1H8Y…/mindmap  真实导图节点："JFK 就职演说片段 | 公民责任号召 | 呼吁公民为国家贡献力量"
另一条笔记     → /notes/01KZ12HV…      标题 ["孤儿回收测试","转写稿"]     正文 19,827 字
```

### 选项梯子（**请 Manager 定做到哪一档，我没有自作主张动手**）

- **A｜最小（约 15 行）** —— `MergedJob` 带上 `noteUid`；`JobRow` 在**有 `noteUid`** 时把**标题**渲染成 `<Link>`（`transcribe` → `/notes/:uid`，`mindmap` → `/notes/:uid/mindmap`）。**复用 `JobToaster` 已验证的落点，不造第二套**。顺带把行内可聚焦元素从 0 变成 1（键盘可达）。
  ⚠️ 只给**流水线**任务：`DownloadJob`（`shared/jobs.ts:213-224`）**没有 `noteUid`**，只有 `targetId`。按 `JobToaster.tsx:473` 自己立的规矩「没有 noteUid 就不给按钮，而不是给一个点了跳到模型页的假出口」，下载类任务**不给链接**。
- **B｜中** —— A + **整行可点**。⚠️ 我不推荐先做这个：非终态的行上有 4 个动作按钮（暂停/继续/重试/取消），整行点击与它们抢事件，正是"点击被别的元素吃掉"那一类的温床 —— 而那恰好是这次要排除的第 2 种。
- **C｜大** —— 真做任务详情页 `/tasks/:jobId`。**后端已具备**：`GET /api/jobs/:jobId` 实测 **200**（`rest/jobs.ts:95`）。能承载 attempt / 错误 / 时间线。但这是新页面 + 新路由 + 新 IA，属"大功能"，按指示**不自作主张**。

### 冲突提醒

`apps/web/src/features/tasks/{JobList.tsx,api.ts}` **此刻正被另一路改着**（未提交：`JobList.tsx` +24 = `actionError` 的 `<ErrorBlock>`；`api.ts` +40 = `countUnfinishedJobs` / `useUnfinishedJobCount` 侧栏徽标）。选项 A 要动 `MergedJob` 接口 + `mergeOne` + `JobRow` 标题行 —— **与其在 `JobRow` 的改动区域相邻**。动手前需要与 `a75a8a6c…` 对一次。

### 纪律核对

未改任何产品代码 · 未 `git add` / commit / stash · `:10000` 只发 GET 且只点了**零按钮**的 succeeded 行（未重启、未 kill、未占端口） · 未碰 `/root/data-memo` · 探针脚本在仓库外 `/tmp/tasks-click/`。

---

## [2026-08-10 03:10] T-192 A 档落地 — DONE

### TL;DR

- **A 档落地了。** 任务行的**标题**变成通往「这条任务做出来的东西」的链接（`/notes/:uid`），落点与 `JobToaster.tsx` 完成态按钮**逐字相同**。
- **真浏览器复验（我自己的 vite dev，只读代理到 demo 数据）**：`href=/notes/01KZ1H8Y…` · `cursor` 从 `auto` 变 `pointer` · **可聚焦元素 0 → 1** · **Tab 第 16 次停在链接上、直接回车就进去了**（全程不用鼠标） · 落地页出现真实转写文字 `And so my fellow Americans…` · **全程零写请求**、零页面异常。
- **反向验证 4 组，逐组贴红**。其中第 3 组（"图省事给每行都套链接"）**只让那一条鉴别腿变红** —— 证明它不是恒真。
- **笔记已被删**：daemon 回 `404 NOTE_NOT_FOUND`，`NoteDetailPage` 渲染 `ErrorBlock` → 界面说「笔记不存在 / 它可能已被删除。」。**已加腿钉住**，并用变异体（把 `note.isError` 改成 `return null` 造白屏）验证它会红。
- **"为什么不整行可点"写在 `JobList.tsx:101-107` 的注释里**，理由就是这次刚排除掉的第 2 种失败模式。
- ✅ `tsc -b` 0 · `eslint apps/web/src` 0 · web 全套 **509 pass / 0 fail**（158+10+332+9），其中本轮新增 **7 条**。`check-contract-fields-shown.mjs` 通过。

### 改了什么（精确清单）

| 文件 | 改动 |
|---|---|
| `apps/web/src/features/tasks/api.ts` | `MergedJob` 补 `noteUid`；`mergeOne()` 两个分支 + transient 分支各自如实赋值；新增导出 `jobResultHref()` |
| `apps/web/src/features/tasks/JobList.tsx` | 标题按 `href` 渲染成 `<Link data-testid="job-result-link">`，无落点时退回 `<span>` |
| `apps/web/src/test/components.test.tsx` | `job()` 工厂补 `noteUid: null`；追加 7 条腿 |

**三处赋值都是"如实"而不是"填个值"**：流水线取 `job.noteUid`；下载类恒 `null`（`DownloadJob` 契约上就没有这个字段）；transient 那一支也是 `null` —— 内存快照里没有 noteUid（`features/tasks/sse.ts:25` 记着这件事），**宁可那一瞬间没有链接，也不编一个可能指错的 uid**。

### 键盘可达的断言长什么样

```ts
const focusables = li.querySelectorAll(
  'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])',
).length;
assert.equal(focusables > 0, true, '已完成的行上一个可聚焦元素都没有 —— 鼠标点不了，键盘也 Tab 不到');
```

⚠️ **刻意用 `succeeded` 的行**：非终态的行会渲染暂停/取消等按钮，那些按钮会把这个计数顶成非 0 ——
于是断言会在**最该失败的那种行上恒真**。选 `succeeded` 才让这条腿有鉴别力（也正是 demo 上的真实状态：6 条全 succeeded）。

真浏览器侧另有一条端到端复验：Tab 到链接 → 按 Enter → URL 真的变成 `/notes/:uid`。

### 反向验证（4 组，真实输出）

| # | 变异 | 结果 |
|---|---|---|
| 1 | `mergeOne` 里 `noteUid: job.noteUid` → `null`（撤掉接线） | **7 条腿全红** |
| 2 | `JobList` 渲染侧 `{href ? (` → `{false ? (`（撤掉链接） | **7 条腿全红** |
| 3 | `jobResultHref` 改成 `` `/notes/${noteUid ?? ''}` ``（**图省事：每行都给链接**） | **只有「下载类不给假出口」那一条红** —— 鉴别力成立 |
| 4 | `NoteDetailPage` 的 `if (note.isError)` → `return null`（造白屏） | **「笔记已被删必须说话」那条红**：<br>`AssertionError: 笔记已被删时点进去是白屏 —— 那就是在修第 1 种失败模式的时候造出了第 2 种` |

第 3 组是这次特意设计的：它和第 1/2 组**互为鉴别** —— 功能被删 → 1、2 红；功能被做过头 → 3 红。
变异体全部还原并核对 `grep -c MUTANT` = 0。

### 一条我没有做成"跳转发生了"的地方

最强那条腿本来想断言**转写段落的文字**出现在落地页上，`[实测]` 做不到：`TranscriptList` 用
`@tanstack/react-virtual`，jsdom 里滚动容器高度恒 0，`getVirtualItems()` 返回空 ——
**段落在这个宿主里永远渲染不出来，与产品无关**（真浏览器上有：`:10000` 那条笔记渲染出
`And so my fellow Americans…`，另一条 19,827 字）。

所以没有退化成关键词匹配，也没有把断言删掉，而是换成**四条结构判据**：
① 路由真的变成 `/notes/:uid`；② 落地页上出现 `[data-testid="note-actions"]`；
③ 页面上出现**只有笔记接口才给得出的标题**（刻意与任务行的 displayName 取不同字符串，
所以点击前必然为假 —— 这三条都配了"前提"断言防恒真）；④ 打桩记录里真的有
`GET /notes/:uid` 与 `GET /notes/:uid/transcript`。理由写在用例下方，免得下一个人以为是漏了。

### 纪律

`git commit` 带 pathspec（提交时索引里有别人 `git add` 的 `catalogDescriptionRank.test.ts`，**没被卷进来**）· 未 `git stash` · 未 `--amend` · `:10000` 全程只读（vite dev 代理过去，实测**零写请求**）· 未碰 `/root/data-memo` / 机器级指针 · 未 `pkill -f`（vite 按 PID kill，端口已释放）· 门禁那条 `packStatus.ts :: isActivePack` 是别人的，未碰。

---

## [2026-08-10 05:40] T-199 ① ② DONE

**② `40e8f40` · ① `db30c25`**，均已 `merge-base --is-ancestor` 复核进 origin/master。

### ② DownloadRow 影子守卫

一行局部重绑（**没抽 helper**，禁令天然满足）：服务端行说这活停了就把 `live` 整份置空，六个字段连同 `ratio` 一起对。

判据**不是** `TERMINAL_JOB_STATES`（漏 `paused`/`blocked`），**也不是** `isActiveJobState()`（它是反过来的谓词，刻意把这两个算作"还没结束"）；`queued` **刻意排除在外**——那是"还没开始"，内存合法领先，算进来会让刚点下去的下载倒退回 0%。

🔴 **一条对简报的更正**：简报给的复现路径「点这行「暂停」→ 服务端行变 `paused`」**今天走不通**——`DownloadRow` 根本没有暂停按钮，`DownloadQueue` 也没有暂停实现（`rest/jobs.ts` 对 pause/resume 直接回 501）。`paused`/`blocked` 今天**零生产者**，我把它们写进守卫是**照 `JOB_TRANSITIONS` 契约布防**，不是照实现。**今天真正会踩到的是 `cancelled` / `failed`**（取消一个正在下的模型）。这一点已如实写进代码注释，免得下一个人以为它验证过 paused。

反向验证 3 组：撤守卫 → 5 条红；退回终态表 → paused/blocked 两条红（正好钉住要害）；守卫做过头 → running/queued 两条红。

### ① corrupt 模型「选得中、跑不了」

只改 C，A/B 不动。谓词复用 B 已有的 `requireIntegrityOk` 契约（`=== 'ok'`），**没发明第三套**。跑不了的 **`disabled` 但不隐藏**，原因写进选项文案。

`/models` 顶部拆三态，`corrupt` 给 critical + 新词条；两份 locale **只新增 key、未重排**。

其中一条腿钉的是**性质本身**：逐个枚举 `integrity` 的四个值，可选性必须与 B 逐格相同——将来加第五个值会立刻要求作者回来表态。

反向验证 3 组：C 退回旧判据 → 3 条红；chip 两态合并 → 2 条红；一刀切全禁 → 2 条红。

### 两条判据自查

- **没用关键词判据**：`/models` 那三条钉 `[data-testid="asr-integrity-chip"]` 这一枚芯片的文字。第一版用整页 `includes` 当场被自己咬到——我新加的选项后缀「（校验未通过，选了也跑不了）」含有芯片那句「校验未通过」，`unverified` 那条因此误红。**同一个词出现在两处，关键词判据分不清是谁说的**（B11 同坑），于是加了结构锚点。
- **没有"由卸载/跳转保证的恒真"**：每一族都配了**反向鉴别腿**（守卫做过头 / 每行都给链接 / 一刀切全禁），单靠"做没做"过不了。

### 共享树上的两次踩踏（都已消解，记下来）

1. `components.test.tsx` 的 `useProgressStore` 导入与另一路**互相礼让成了谁都没导入** —— 我加、对方加、双方各自撤，来回三轮，中间整棵树 `ReferenceError`。最后合并成一行 `{ pushProgress, useProgressStore }` 收口。
2. 同文件里对方的新用例引用 `bus` 但未导入，树红；我准备补时对方已自行补上。

**判据不是"谁的锅"，是共享单 bundle 测试文件上"加导入"这个动作没有幂等性** —— 两边同时做就必然撞。建议 Manager 考虑给组件测试拆第二个 bundle（`silentFailures.test.tsx` 已有先例）。

### 纪律

`git commit -- <明确路径>` 两次（提交时索引里都有别人 `git add` 的文件，`git show --stat` 逐次核对**只含我的**）· 未 stash / 未 `checkout --` / 未 `-a` / 未 `--amend` · `pnpm format:changed --write -- <同一份 pathspec>` · 未碰 release/tag · 未碰 `features/tasks/*` 与 `packages/downloader/src/queue.ts`。
遗留红：`apps/web/src/features/models/sse.ts` 的 `TERMINAL_JOB_STATES`/`useProgressStore` 未定义（另一路在途，非我），我提交时该文件已由对方修好。
