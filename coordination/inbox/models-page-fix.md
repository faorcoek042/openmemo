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
