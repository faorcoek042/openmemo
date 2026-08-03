# inbox / models-page-fix

## [2026-08-03 20:55] T-129 DONE

### TL;DR（≤25 行，Manager 只读这里）

1. **问题 1（Tab 条消失）已修，成因如 `ui-polish` 所报**：切换条写在 `tab === 'asr' ? … : 'hidden'` 那个 section **里面**，切到语言模型就跟着整块被藏掉。已提到两个面板**之外**，并补 `role=tablist/tab/tabpanel` + `aria-selected`。「只显示这台机器能跑的」留在转写 Tab 内（它筛的是目录卡片，是内容不是骨架）。
2. **问题 2 的成因**：**三种猜测一个都不是**。zh-CN 词条**在**（522/522 键名对称，实测）、键名**对得上**、搬过来的两块 LLM 区**恰恰是这一页唯一做对了 `t()` 的部分**。真因是 **`/models` 页的骨架与卡片整片硬编码中文、根本不走 i18n**，而 `detectLocale()` 在非中文浏览器上返回 `en`（jsdom / 无痕 Chromium 的 `navigator.language` 就是 `en-US`）→ 同一屏 = 硬编码的中文 + i18n 出来的英文。**这正是 `ui-polish` 上一轮建议立的 T-022，只是这次从反方向被看见了。**
3. **修法**：把 `/models` 整条线搬进 i18n（新增 `models.*` **107 条 × 2 语言**，两份键名已断言对称）。现在两种语言下这一页都是**同一种语言**。
4. **裸 `**` 已消灭，但不是靠删星号**：新增 `components/common/Emphasis.tsx`（只认 `**…**`，不引 markdown 依赖、不用 `dangerouslySetInnerHTML`）。因为其中一处是**服务端下发的原文**（`packages/llm/src/secrets.ts:68` 的「API Key 以**明文**保存在 …」），ADR-006 要求它由服务端给（路径随 dataDir 变），**只能在渲染侧处理**。删星号还会把「明文」「在线」这两个必须被看见的词降回正文。
5. **星标筛选已修（你追加的那条）**：`NotesListPage` 现在读 `?starred=1`，标题、空态、列表三处都跟着走。**数据层是够的**：`GET /api/notes` 每条都带 `starred`（`rest/notes.ts:264`），端点只是不接受该过滤参数（同文件 :242）→ **前端过滤，没动 daemon**。⚠️ 代价我写在代码注释里：列表是 `limit=50` 的一页，超过 50 条后第 51 条之外的星标笔记不会出现。真修法是端点支持 `starred`，列为后续项。
6. **你追加的 MockNotice 渲染断言已补**，和 Tab 那条写在同一族里（`T-129 同族：显示条件不许被别人的条件包住`），表格里两个实例并列。3 条用例：全接通时版本戳仍在 / 还有模拟面时两个都在 / `health===null` 时整块不出现。
7. **反向验证 5 条全做了，真实输出见正文 §4**，5 条全部真的变红。
8. **过程中抓到一个会 OOM 掉整个测试进程的坑**（§5）：`assert.equal(domNode, null)` 失败时 node:test 会给 DOM 元素算 diff，`util.inspect` 顺着 parentNode/ownerDocument 展开整棵树 —— 实测涨到 **10.5 GB** 被 OOM killer 打死，表现是 `✖ components.test.js 'test failed'`、57 秒、后面用例一个都没跑。**这比"不红"更难查**。已改成布尔比较并把原委写进注释。
9. **验证**：`tsc -b`（全仓）**0** · `tsc -p apps/web/tsconfig.json` **0** · `eslint apps/web/src` **0** · `apps/web` 测试 **单测 27/27 + 组件 140 条 / 138 通过 / 0 失败 / 2 skipped**（本轮新增 **13** 条）。
10. **真浏览器复验**（自建 `vite dev --port 5203` 代理到 `:10000`，用完按 pid kill，端口已释放）：两种语言 × 两个 Tab 全对，切换条可见且点得回去，页面**零裸 `**`**，英文档全页仅剩 **17 个汉字 = 4 个服务商中文品牌名**（月之暗面 Kimi / 智谱 GLM / 阿里云百炼（通义）/ 硅基流动，属 `llm-catalog.ts`，本轮没动）。截图见 §6。
11. **纪律**：`apps/web/dist` **一次都没构建**（mtime 仍是 19:56:22，非我）；`:10000` 全程只读，非 GET 只有 SPA 自己的 `POST /api/auth/session` 握手；`/root/data-memo` 一个字节没写；没碰 daemon、没碰 `packages/**`、没碰 `vendor/**`。
12. **需要 Manager 决策**：见 §8（还有 4 处别人页面上的裸 `**`；星标端点要不要补；`/runtime` 是否照 `/models` 同样处理）。

---

## §1 问题 1：Tab 切换条

`apps/web/src/features/models/ModelsPage.tsx`

改的是**结构**不是样式：切换条从 `<section className={tab === 'asr' ? 'space-y-3' : 'hidden'}>` 的**内部**提到了它的**兄弟**位置。

> **判据（和你给 MockNotice 写的那条是同一条）：一个元素的显示条件，必须是它自己的条件。**
> 切换条的显示条件是"我在 `/models` 上"，不是"当前 Tab 是转写"。嵌套让它继承了后者。

顺带补齐 ARIA：`role="tablist"` / `role="tab"` + `aria-selected` + `aria-controls` → `role="tabpanel"`（两个面板 `id="models-panel-asr|llm"`）。读屏用户此前拿不到"这两块是同一区域的两种内容"这层关系。

`?tab=` 仍是唯一的 Tab 状态来源（D-10 §1.2，既有测试 `★ D-10 §1.2` 仍绿），没有新增路由。

---

## §2 问题 2：混语言 —— 先定性，再动手

### 2.1 三种猜测逐条排除（都是实测，不是推断）

| 猜测 | 核实方式 | 结论 |
|---|---|---|
| 缺 zh-CN 词条 | 脚本拍平两份 locale 比键集合 | ❌ **522 = 522，差集两边都是空** |
| 键名对不上导致回退英文 | 逐个打印用到的 8 个 key 的 zh/en 值 | ❌ 全部存在且正确（`settings.llm` = 「AI 模型」…） |
| 搬迁漏了 `t()` 包装 | 通读 `LlmSettingsSection.tsx` / `PurposeBindingsSection.tsx` | ❌ **两块全程 `t()`，是这一页唯一做对 i18n 的部分** |

### 2.2 真因

`i18n/index.ts:detectLocale()`：没有 `localStorage['openmemo.locale']` 时按 `navigator.language` 判，非 `zh` 一律 `'en'`。你截图用的 Chromium 是 `en-US` → `lng='en'`。

于是同一屏上：

- 走 `t()` 的（LLM 两块、侧栏）→ **英文**；
- **硬编码中文**的（`/models` 的 h1、当前使用、Tab 标签、磁盘占用、全部模型卡片…）→ **中文**。

我在真浏览器里把这条钉死了（未设 locale，`navigator.language=en-US`）：

```
== 环境 == {"navLanguage":"en-US","htmlLang":"en","storedLocale":null}
== 侧栏 == ["New capture","All notes","Starred","Record",…,"Runtime","Models","Tasks","Settings"]
== h1 == 模型管理            ← 硬编码
== h2 == ["当前使用","AI models","Per-purpose models","磁盘占用"]   ← 中英各半，一行看尽
```

**注意侧栏其实也是英文的** —— 原描述说"左侧栏是中文"这一点与实测不符，我按实测写。

`ui-polish` 在 T-101 的回执里已经报过同一件事的**另一半**：「`/models` 与 `/runtime` 正文全硬编码中文不走 i18n，英文用户会看到'英文外壳 + 全中文正文'—— 请指派 T-022」。这次是同一个缺陷从反方向被看见。

### 2.3 修法与范围

新增 `models.*` 命名空间（zh-CN / en 各 107 条），覆盖 **6 个文件**：

| 文件 | 为什么在范围内 |
|---|---|
| `features/models/ModelsPage.tsx` | 就是出问题那一屏的骨架 |
| `features/models/components/StorageBreakdown.tsx` | **两个 Tab 都渲染**，和骨架同屏 |
| `.../ModelCard.tsx`、`.../DownloadRow.tsx`、`.../QuantSelector.tsx` | 转写 Tab 的正文。**只修骨架的话，点一下 Tab 就又是混排** —— 那叫半做 |
| `components/common/FitBadge.tsx` | 只被上面这几个 + 详情页用；不改的话卡片里仍有中文徽标 |
| `features/models/ModelDetailPage.tsx` | 「详情」一点就到，且它本来就带一处裸 `**` |

两条实现上的取舍写进了代码注释：

- `DownloadRow` 的 `STEP_LABEL` 与 `FitBadge` 的 `TIER_STYLE` 都是**模块级常量表**，里面改存 **key 不存文案** —— 存文案的话切语言不会重算这张表。
- **`{{context}}` 不能当插值名**：那是 i18next 的保留选项（key 变体用），tsc 直接报 TS2345。已改 `{{ctx}}` / `{{maxCtx}}`（两处），并在调用点写了原因。

**没碰**：`llm-catalog.ts` 的服务商品牌名（`月之暗面 Kimi` 等 4 个，是厂商中文注册名，英文界面照写是对的，且归 `llm-picker`/`architect`）；`/runtime`、`/settings` 等其它页面。

---

## §3 裸 `**`

新增 `apps/web/src/components/common/Emphasis.tsx`，接了两处（都在出问题那一屏）：

| 处 | 来源 | 为什么不能"删掉星号" |
|---|---|---|
| `settings.llmIntro` | locale 文件 | 删了「推荐用在线 API」就和正文一样平，而 ADR-016 要它是主路径 |
| `disclosure.messageZh/message` | **服务端**（`packages/llm/src/secrets.ts:68`） | ADR-006 要求路径由 daemon 给（随 dataDir 变，前端硬编码必然说错）。我**不能**改那份字符串，只能在渲染侧处理 |

另接了 `models.detail.benchNone`（详情页那句「我们**不显示论文里的准确率数字**」，同型，顺手）。

刻意的限制（写在文件头）：**不是 markdown 渲染器**，只认 `**…**`；**不用 `dangerouslySetInnerHTML`** —— 输入里有服务端字符串，当 HTML 解释就是一条注入面，拆成文本节点则完全没有这个面；未闭合的 `**` 原样保留。

---

## §4 反向验证（真实输出，不是"我认为它会红"）

每条都是：改坏 → 跑 `pnpm run test:components` → 贴输出 → 还原。

**① Tab 条塞回 hidden 分支**
```
ℹ tests 140  ℹ pass 136  ℹ fail 2
✖ ★ ?tab=llm 时切换条必须仍在页面上，且不在任何被隐藏的面板里 (20.372149ms)
  AssertionError [ERR_ASSERTION]: 切换条被一个 hidden 的祖先包住了（切到另一个 Tab 就会连它一起消失）
```
（同一次里另一条 `✖ ★ DataLocationSection 确实把 daemon 的 warningZh 接进了这个组件` 是 `storage-fix` 当时在途的，不是我的；它随后自己修好了，最终全绿。）

**② 骨架改回硬编码中文**（只把 h1 与「当前使用」两条改回去）
```
ℹ tests 140  ℹ pass 137  ℹ fail 1
✖ ★ 英文界面下 /models 不许渲染出硬编码中文（两个 Tab 都查） (15.571854ms)
  AssertionError: /models：英文界面上出现了硬编码中文 → ["模型管理Browse, download, switch"," no command line needed.当前使用TranscriptionNone sel"]
```
断言里直接把混排的那一截打出来了 —— 这正是用户看到的那种"一行里中英各半"。

**③ 撤掉星标过滤**
```
ℹ tests 140  ℹ pass 135  ℹ fail 3
✖ ★ /notes?starred=1 只列星标笔记；/notes 列全部
  AssertionError: 「星标」点进去和「全部笔记」一模一样 —— starred 查询参数没有被读
✖ ★ 标题必须跟着查询串走，不能两个入口都写「全部笔记」
✖ ★ 有笔记但一条都没加星时，给星标专属空态（而不是"还没有笔记"）
  AssertionError: 空态文案不对：全部笔记plain one0 分钟3天前
```

**④ 撤掉 `<Emphasis>`**
```
ℹ tests 140  ℹ pass 137  ℹ fail 1
✖ ★ 服务端下发的 disclosure 里的 ** 必须渲染成 <strong>，页面上看不到星号
  AssertionError: 页面上仍能看到裸的 ** → …API Key 以**明文**保存在 /tmp/x/secrets.json。…
```

**⑤ 撤掉 MockNotice 的版本戳修复**（改回 `if (mocked === 0) return null;`）
```
ℹ tests 140  ℹ pass 137  ℹ fail 1
✖ ★ 所有 API 面都接通（mocked === 0）时，daemon 版本戳仍然渲染 (5.918006ms)
  AssertionError: 全部接通后版本戳消失了 —— 而那正是最需要它的时刻（实际渲染：""）
```

还原后最终：`单测 27/27` + `组件 140 / 138 pass / 0 fail / 2 skipped`（收尾复跑，全绿）。

---

## §5 ⚠️ 顺带抓到的一个"假红"陷阱（值得全组知道）

第一次跑反向验证 ① 时，我拿到的**不是红，是整个测试文件炸掉**：

```
✖ .test-out/components/components.test.js (57096.721553ms)
  'test failed'
ℹ tests 128  ℹ suites 27      ← 我的 4 个 suite 一个都没跑
```

追下去是 **OOM**：进程涨到 **10.5 GB** 被 OOM killer 打死（`rc=137`，整机 16 GB 当时只剩 189 MB）。

根因：我原来写的是

```ts
assert.equal(tabs.closest('.hidden'), null, '…');
```

失败时 `actual` 是一个 **jsdom 元素**，node:test 的报告器要为它算 diff，`util.inspect` 会顺着 `parentNode` / `ownerDocument` / React fiber 把整棵 DOM 连同 window 一起展开。

改成 `assert.ok(x === null, '…')`（actual 是 `false`）后，红得干干净净。

**这条比"测试没变红"更坏**：它看起来像环境问题，而且会把**同一进程里别人的用例也一起带走**（那次 storage-fix 的用例统计也是错的）。已写进用例注释。

> 规则：**组件测试里不要把 DOM 节点放进 `assert.equal` 的 actual/expected**。

---

## §6 真浏览器复验

自建 `vite dev --port 5203`（`OPENMEMO_DAEMON=http://127.0.0.1:10000`，只走代理读 demo 的真实数据）。

| 检查 | zh-CN | en |
|---|---|---|
| `?tab=llm` 时 Tab 条可见 | ✅ `126×33` | ✅ `232×33` |
| 点「转写」能回去 | ✅ URL → `/models?tab=asr`，目录面板可见 | ✅ 同左 |
| 页面含裸 `**` | ❌ 无 | ❌ 无 |
| 全页汉字数 | 478（整页中文） | **17**（= 4 个服务商中文品牌名） |
| 「当前生效 / In effect」 | `DeepSeek · deepseek-v4-flash` | 同左 |
| `/notes?starred=1` | 0 条 + 星标专属空态 | 同左 |
| `/notes` | 2 条 | 2 条 |
| 非 GET 请求 | 只有 SPA 自己的 `POST /api/auth/session` 握手 | 同左 |

> 演示库里那 2 条笔记**本来就都没加星**（`ui-polish` 上一轮也这么报的），所以浏览器里能验的是"星标页不再等于全部笔记"这一半；"加了星的会出现"那一半由组件测试的正例覆盖（2 条数据里 1 条 starred → 星标页正好 1 条）。**我没有去点星标按钮**（那是写请求，会改用户的库）。

截图（仓库外）：`/tmp/models-page-fix/shots/`
```
zh-CN-models-asr.png   zh-CN-models-llm.png   zh-CN-models-after-click-back.png
zh-CN-notes-all.png    zh-CN-notes-starred.png
en-models-asr.png      en-models-llm.png      en-models-after-click-back.png
en-notes-all.png       en-notes-starred.png
```
诊断脚本与日志：`/tmp/models-page-fix/{diag.mjs,shot.mjs,rev-*.log,final-all.log}`

---

## §7 提交清单（**请勿 `git add -A`**，本轮我的改动只有这 12 个文件）

```
git add apps/web/src/features/models/ModelsPage.tsx \
        apps/web/src/features/models/ModelDetailPage.tsx \
        apps/web/src/features/models/components/ModelCard.tsx \
        apps/web/src/features/models/components/DownloadRow.tsx \
        apps/web/src/features/models/components/QuantSelector.tsx \
        apps/web/src/features/models/components/StorageBreakdown.tsx \
        apps/web/src/features/notes/NotesListPage.tsx \
        apps/web/src/components/common/Emphasis.tsx \
        apps/web/src/components/common/FitBadge.tsx \
        apps/web/src/components/common/llm/LlmSettingsSection.tsx \
        apps/web/src/app/i18n/locales/zh-CN.json \
        apps/web/src/app/i18n/locales/en.json \
        apps/web/src/test/components.test.tsx \
        coordination/inbox/models-page-fix.md
```

⚠️ `git status` 里同时还躺着 **daemon / packages/shared / vendor / features/components / JobToaster / DataLocationSection / selfcheck** 等一大批改动 —— **那些是 `storage-fix`、`job-events`、`handoff` 的，不是我的。**

⚠️ **`apps/web/src/test/components.test.tsx` 本轮被我和 `storage-fix` 同时改过**（他们在 ~709 行加 T-128 的用例，我在文件末尾追加）。两边共存无覆盖，我复读过合并后的文件。**但这是一个共享文件，合并时请留意。**

**我没有 commit** —— PROTOCOL §0 写着 Manager 是唯一合并者。

---

## §8 需要 Manager 决策 / 后续项

1. **还有 4 处词条带 `**` 而没有渲染器接着**（都在**别人**的页面，我只报不动）：
   `recorder.paraformerTradeoff`（录音页 + `WordLevelBadge`）、`settings.dataDir.needRestart`、`settings.dataDir.sizeScopeNote`（`DataLocationSection`，`storage-fix` 正在改这个文件）、`settings.proxy.testUsesSaved`（`ProxySettingsSection`）、`secureContext.microphone`。
   `<Emphasis>` 已经是公共组件，接上各只需一行。请裁决派给谁。
2. **`GET /api/notes` 要不要支持 `?starred=1`。** 今天前端过滤是可用的，但**只筛已取回的那一页（`limit=50`）**。笔记超过 50 条后星标页会漏。真修法在 daemon（`rest/notes.ts:242` 的 `listNotes(limit)` + repos 层）—— 你说过要动 daemon 先打招呼，所以我没动。
3. **`/runtime` 要不要照 `/models` 同样处理。** 它是 `ui-polish` 报的 T-022 的另一半，今天仍是整片硬编码中文，英文用户看到的是"英文外壳 + 中文正文"。本轮**没做**（超出 `/models` 的范围，且我不想半做）。
4. **`ModelsPage.tsx:148` 我加了一行类型谓词**（`(j): j is DownloadJob =>`）。原因：`job-events` 把 `useJobsQuery` 的返回改成了 `AnyJob[]`（`DownloadJob | PipelineJob`），而 TS 不顺着普通 `filter` 收窄联合类型，`tsc -p apps/web` 因此在**我的文件**里报红。判据仍是原来那句运行时 `kind === 'model'`，我只是把它告诉类型系统。**这是替 `job-events` 的契约变更补的消费侧**，如果他们打算统一用 `isDownloadJob()` 处理，这行可以换成那个 helper。
5. **组件测试的 OOM 陷阱（§5）** 建议进 PROTOCOL 或 `features/README.md`：**不要把 DOM 节点放进 `assert.equal`**。它会把"一条断言变红"变成"整个测试文件消失"，而统计数字看起来还是绿的。

---

## §9 环境收尾

- 我起过的进程：`vite --port 5203`（pid 2995644）。**按 pid `kill`，未用 `pkill -f`，已确认端口释放（curl → 000）**。
- **`apps/web/dist` 一次都没构建**：`index.html` mtime 仍是 `2026-08-03 19:56:22`（不是我建的）。组件测试用的是 `vite build --ssr … --outDir .test-out/components`，**不写 dist**（PROTOCOL §7）。
- 用户的 `:10000` 实例**全程只读**：未重启、未 kill、未占用该端口；收尾复核 `/api/health` 仍是 200。
- **`/root/data-memo` 一个字节没写**：全程只 GET，**没点过「确定」/「保存」/星标按钮**，非 GET 只有 SPA 自己的 `POST /api/auth/session` 握手。
- 未跑任何本地 whisper 转写（按新指令）。
- 未派生 subagent。未 commit。
- 所有诊断产物与截图写在 `/tmp/models-page-fix/`（仓库外）。

### 诚实声明

- §4 的 5 段 `✖ / AssertionError` **是实际输出复制过来的**，不是我预期的样子。
- §5 的 10.5 GB / `rc=137` 是实测（`ps -eo rss` + `Killed`），**第一次反向验证确实被它骗过一轮**，我把它写出来而不是重跑一次当没发生。
- `en.json` 里 **107 条新英文文案是我写的，未经母语校对**。
- 原描述里「左侧栏是中文」一条**与实测不符**（英文档下侧栏也是英文，§2.2 有原始输出）。不影响结论，但我按实测写。
- 星标那条：浏览器里只验到"星标页不再等于全部笔记"（库里 2 条都没星），正例由组件测试覆盖。**我没有为了截图去给用户的笔记加星。**

---

## [2026-08-03 21:05] T-129b DONE —— Manager 四条决策的回执

### TL;DR（≤25 行）

1. **决策 1（另外 4 处裸 `**`）已做完**，共接了 **5 个渲染点**（比报的 4 处多一个，见第 3 条）：
   `RecorderPage`（正文，`<Emphasis>`）· `WordLevelBadge`（**`title=` 属性 → 新加的 `stripEmphasis()`**）· `ProxySettingsSection` · `DataLocationSection` ×2。
2. **`secureContext.caps.microphone` 我没接线，因为它今天根本没有渲染点** —— 这不是我漏了，是另一个缺陷：`detectBlockedCapabilities()` 逐项算出了「你具体失去哪几项能力」（`lib/secure-context.ts:60-86`），而 `ReadinessBanner.tsx:103` **只用了 `blocked.length`** 去填一个计数文案，**每项的具体说明连同 `caps.*` 四条词条一起被丢掉了**。已写进登记表并标 `[]`，另立一条给 Manager（§B.4）。
3. **决策 3（`/runtime` i18n）已做完**，过程中又抓出**两处报告里没有的**：① `RuntimePage` 底部那句 RTF 提示是**硬编码 JSX**，标记直接写在源码里（`是**本机实测值**` / `**估算**`）—— 连词条都不是，页面上一直显示着星号；② `BackendChip`（共享组件）的五个状态词全是硬编码中文，**是我新写的测试把它抓出来的**，不是我读出来的。
4. **🔎 抓到第三类混语言，也修了**：`/runtime` 英文档跑完 i18n 后仍残留 13 个汉字，逐个追下去全是 **`pack.displayNameZh`** —— 而 `vendor/manifests/backends.json` 里 **15 个包每一个都同时有 `displayName` 与 `displayNameZh`**，`packages/shared` 的类型里两个字段也都在。**数据齐全、契约齐全，只是渲染时写死取了中文那一份。** 新增 `lib/format/localized.ts`（`localizedName` / `localizedDescription`，缺哪份就回落到另一份），接到 `ModelCard` / `ModelDetailPage` / `ModelsPage` / `BackendPackCard`。**修完英文档 `/runtime` 汉字数 13 → 0。**
5. **决策 4 已照办**：`ModelsPage.tsx` 那行类型谓词旁加了 `⏳ 待 job-events 契约落地后可换` 的注释，并写明「**这不是最终形态**，别照着它在别处复制一份」。**没改它本身。**
6. **决策 2（`?starred=1` 端点）我没动**，注释里那句「真修法在端点」按你说的保留了。
7. **反向验证 6 条，全部真的变红，输出见 §A。** 其中第 4 条**第一次没红** —— 我写的 `/\bEmphasis\b/.test(src)` 匹到了自己旁边那句注释里的「走 `<Emphasis>`」。**一条断言被自己的文档骗过去了**，比不写更坏。已改成断 **import 语句**，再验证真红。
8. **测试新增 12 条**（T-129b 组），组件测试 **150 条 / 148 通过 / 0 失败 / 2 skipped**；单测 27/27。
9. **`test-host` 的文本输入缺陷不影响我**：本轮全部 25 条新增用例**没有一条用到 `type()` / `fireEvent.change` / 受控文本框**（只用 `click()` + `querySelector` + 源码断言）。已逐条 grep 确认。**我没有碰 `host.tsx`。**
10. **验证**：`tsc -b`（全仓）**0** · `eslint`（我碰过的全部路径）**0** · 真浏览器两语言 × 4 页复核，**零裸 `**`**。
11. **纪律**：没构建 `apps/web/dist`（21:00:11 那次不是我，我一次都没跑过 `vite build`）· `:10000` 只读，非 GET 只有 `POST /api/auth/session` 握手 · `/root/data-memo` 零写入 · vite dev 用完按 pid kill，端口已释放。
12. **仍需 Manager**：见 §B（三条，都是别人地界的发现，我只报不动）。

---

## §A 反向验证（6 条，真实输出）

**① `/runtime` 骨架改回硬编码中文**
```
ℹ tests 150  ℹ pass 147  ℹ fail 1
✖ ★ 英文界面下 /runtime 不许渲染出硬编码中文 (13.73658ms)
  AssertionError: 英文界面上出现了硬编码中文 → ["运行时与加速后端Detect hardware → recomm"]
```

**② `/runtime` 的 RTF 提示撤掉 `<Emphasis>`**
```
✖ ★ RTF 那句提示不许把裸 ** 吐给用户（它原本是硬编码在 JSX 里的）
  AssertionError: 页面上仍能看到裸的 ** → …提示：自检里的 RTF 是**本机实测值**；模型卡片上的“预计耗时”是由它外推的**估算**，外推系数尚未标定，仅供参考。
```

**③ `title=` 撤掉 `stripEmphasis`**
```
✖ ★ title= 这类属性位置只能脱标记：tooltip 里绝不许出现星号
  AssertionError: tooltip 里出现了裸标记：代价：**没有逐字时间戳**（字幕高亮到句、不到字）、…
```

**④ 撤掉 `DataLocationSection` 的两处 `<Emphasis>`** —— **第一次没红**：
```
ℹ tests 150  ℹ pass 148  ℹ fail 0        ← ⚠️ 假绿
```
成因：我的断言是 `/\bEmphasis\b/.test(src)`，而我在改动旁留了一句注释写着"走 `<Emphasis>`"，
**正则匹到了注释**。改成断 import 之后重跑：
```
ℹ tests 150  ℹ pass 147  ℹ fail 1
✖ ★ 登记的每个渲染点都必须真的 import Emphasis / stripEmphasis（不是注释里提一句）
  AssertionError: features/settings/DataLocationSection.tsx 渲染了带 ** 的 settings.dataDir.needRestart，却没有 import Emphasis/stripEmphasis —— 用户会看到裸星号
```
> 这条和上一轮那个 OOM 是同一类：**验证手段自己有缺陷时，你拿到的绿灯是假的。**
> 判据改成"import 在不在"之后就没有这个面了 —— 未使用的 import 过不了 eslint，所以 import 在 ⇒ 它一定被用了。

**⑤ `BackendChip` 的状态词改回写死中文**
```
✖ ★ 英文界面下 /runtime 不许渲染出硬编码中文
  AssertionError: → ["eration backend packsCPU使用中whisper.cpp CPURecomme"]
```

**⑥ 撤掉 `localizedName` / `localizedDescription`**（第三类混语言）
```
✖ ★ 英文界面下 /models 不许渲染出硬编码中文（两个 Tab 都查）
  AssertionError: → ["chine can runRecommended假装的转写模型一段用来占位的中文描述Details"]
```
> 为了让这条真的能红，我把两个页面的桩数据改成了**目录的真实形状**
> （`displayName` + `displayNameZh` 成对、`descriptionEn` + `descriptionZh` 成对）。
> 原来的桩全是 ASCII，测的其实只有"我们自己的文案"，**测不到目录数据这一层**。

---

## §B 需要 Manager（三条，都是别人地界）

1. **`secureContext.caps.*` 四条词条 + `featureKey` 全部算了但没渲染。**
   `detectBlockedCapabilities()` 返回的是"具体哪几项能力被挡住"（麦克风 / Web Locks / sessionStorage / 剪贴板），
   `ReadinessBanner` 只取了 `.length`。用户看到「有 N 项能力不可用」，**看不到是哪 N 项**，
   而其中「麦克风」是唯一功能级不可用的一项。这是**信息算出来了又丢掉**，不是文案问题。归 `ReadinessBanner` 的 owner。
2. **`/settings` 英文档仍有 81 个汉字，来源是 daemon 而不是前端**：
   `apps/daemon/src/http/rest/storage.ts:38` 的 `purposeZh`（「笔记、转写稿、标签、导图（SQLite 主库）」等 5 条）
   —— 这个字段**只有 Zh 一份，没有英文对应**，与 `displayName/displayNameZh` 成对的做法不一致。
   前端无法修（没有可回落的英文）。要么 daemon 补 `purpose`，要么把这几条搬进前端词条。**归 daemon owner**（`storage-fix` 刚在改那个文件）。
   （另：`/settings` 里的「中文」是语言切换器的选项名，**那是对的**，语言名本来就该用它自己的语言写。）
3. **`features/components/components/ComponentCard.tsx` 也用 `displayNameZh`**，同第 4 类。
   本轮没碰 —— 那个文件此刻有别的 agent 在改（`git status` 里是 M）。`localizedName()` 已是公共 helper，接上是一行。

---

## §C 本轮新增/修改文件（**请勿 `git add -A`**）

```
git add apps/web/src/features/runtime/RuntimePage.tsx \
        apps/web/src/features/runtime/components/BackendPackCard.tsx \
        apps/web/src/features/runtime/components/HardwareCard.tsx \
        apps/web/src/components/common/BackendChip.tsx \
        apps/web/src/components/common/Emphasis.tsx \
        apps/web/src/lib/format/localized.ts \
        apps/web/src/features/models/ModelsPage.tsx \
        apps/web/src/features/models/ModelDetailPage.tsx \
        apps/web/src/features/models/components/ModelCard.tsx \
        apps/web/src/features/recorder/RecorderPage.tsx \
        apps/web/src/features/transcript/WordLevelBadge.tsx \
        apps/web/src/features/settings/DataLocationSection.tsx \
        apps/web/src/features/settings/ProxySettingsSection.tsx \
        apps/web/src/app/i18n/locales/zh-CN.json \
        apps/web/src/app/i18n/locales/en.json \
        apps/web/src/test/components.test.tsx \
        coordination/inbox/models-page-fix.md
```

新增词条 `runtime.*` **54 条 × 2 语言**（两份键名已断言对称，全库 693 = 693）。

⚠️ **`apps/web/src/test/components.test.tsx` 与 `apps/web/src/features/settings/DataLocationSection.tsx` 本轮仍是共享文件**
（`test-host` 在同一个测试目录里加 `host.test.tsx` / `__mut*.test.tsx`，`storage-fix` 之前改过 DataLocationSection）。
我复读过合并后的文件，共存无覆盖。

`git status` 里的 daemon / packages / vendor / `features/components` / `features/tasks` / `JobToaster` / `test/host*.tsx` / `test/__mut*.tsx` 改动**不是我的**。

---

## §D 验证

| 项 | 结果 |
|---|---|
| `tsc -b`（全仓） | **0** |
| `eslint`（我碰过的全部路径） | **0** |
| `apps/web` 单测 | **27 / 27** |
| `apps/web` 组件测试 | **150 条 / 148 通过 / 0 失败 / 2 skipped**（本轮新增 12 条，累计 25 条） |

⚠️ 全仓 `eslint apps/web/src` 此刻有 1 error + 3 warning，**全在 `test/host.test.tsx`、`test/__mut*.test.tsx`、`test/host.tsx`** —— `test-host` 在途，不是我的。我对自己碰过的路径单独跑过，rc=0。

**真浏览器复核**（自建 `vite dev --port 5203` 代理 `:10000`，全程只 GET）：

| 页面 | zh-CN 汉字 | en 汉字 | 裸 `**` |
|---|---|---|---|
| `/runtime` | 312 | **0** ✅（修 `displayNameZh` 前是 13） | 无 |
| `/models?tab=llm` | 478 | 17（= 4 个服务商中文品牌名，属 `llm-catalog.ts`，未动） | 无 |
| `/record` | 206 | **0** | 无 |
| `/settings` | 387 | 81（daemon 的 `purposeZh` + 语言切换器的「中文」，见 §B.2） | 无 |

截图：`/tmp/models-page-fix/shots2/{zh-CN,en}-{runtime,models-llm,recorder,settings}.png`
反向验证日志：`/tmp/models-page-fix/rev2-*.log`

---

## §E 诚实声明

- §A 的 6 段输出**是实际复制的**，包括第 ④ 条那次 **`fail 0` 的假绿** —— 我把它写出来而不是直接贴改好之后的红。
- **`/runtime` 的 `runtime.*` 54 条英文文案是我写的，未经母语校对。**
- **`secureContext.caps.microphone` 我没接线**，理由在 §B.1。**这一条 Manager 说的"4 处"里我只做了 3 处** —— 第 4 处不是"没做"，是"今天没有地方可做"，我没有为了凑数去顺手实现一个别人的功能。
- 第三类混语言（`displayNameZh`）**不在 Manager 的四条决策里**，是我在浏览器复核时发现英文档还剩 13 个汉字才追出来的。它在 `/models` 与 `/runtime` 的范围内，所以我做了；`ComponentCard` 同型但在别人手上，我只报（§B.3）。
- **没有碰 `host.tsx`**（`test-host` 在改，且你说要先打招呼）。本轮新增用例**零文本输入依赖**，已逐条 grep 确认，不受那个缺陷影响。
- 未 commit。未派生 subagent。未跑 `vite build`。未跑本地 whisper 转写。
