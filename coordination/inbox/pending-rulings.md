# 四条挂起裁决的分诊材料

## [2026-08-08 21:10] 分诊 DONE（只读审计，未改任何产品代码）

**结论先给：四条里 3 条今天已经不成立（早被做掉了，回执还写着开着），
只有第 1 条剩下一个真正需要你拍板的残留，而且它比原来那个问题小得多。**

判据沿用本仓的：**闭合的判据不是"回执里写了已完成"，而是"能在今天的代码/CI 里验到"。**
下面每条都给了我实际跑过/读过的证据位置。

---

## 一、四条逐条

### ① 模型列表要不要动态拉取（`memo-compare.md:216-217`）—— **大部分已闭合，剩一个小得多的问题**

**原问题**：520 条 provider 模型清单是 memo.ac 的人工策展快照，
是照搬（可能过时）还是走 `official-api` 动态拉？那位倾向"对主流几家动态拉"，但担心引入出网依赖。

**今天的实际形态：已经是混合方案，而且端到端接通了。** `[实测]`

| 环节     | 证据                                                                                 |
| -------- | ------------------------------------------------------------------------------------ |
| 静态底盘 | `vendor/manifests/llm-providers.json` = 24 家 / 520 条                               |
| 动态拉取 | `POST /api/llm/models` → `apps/daemon/src/llm/enumerate.ts` `listProviderModels()` |
| 真有 UI  | `LlmModelSelect.tsx:98` `useLlmModelsMutation()` → `llm/api.ts:262`（不是死代码）   |
| 三档措辞 | `unknown-provider` / `not-enumerable` / `no-base-url` 各有可执行的下一步            |

`modelListSource.type` 的**实测分布**：

- `official-api` **2** 家（openrouter、siliconcloud）
- `local-api` **2** 家（ollama、lmstudio）
- `official-doc` **20** 家 —— 人工从官方文档转录，**没有可枚举接口**

也就是说「对主流几家动态拉」这件事**已经做了**：凡是厂商自己提供列表接口的（4 家），
产品就去拉；剩下 20 家厂商**根本没有这个接口**，不是我们不想拉。

**⚠️ 你特别提醒的出网代价，实测不成立 —— 这条路早就在，而且已经被守着：**

- 它走的是 **daemon 进程内的全局 `fetch`**（`enumerate.ts:148` `opts.fetchImpl ?? fetch`），
  **不是子进程** ⇒ 你说的"子进程必须被显式告知，每次遗漏都是静默的"那条**不适用**；
- `scripts/ci/proxy-coverage-audit.mjs:568` **把 `/api/llm/models` 列为逐条实测的出网路径之一**，
  我本轮真跑了一遍：**exit 0**，脚本自己的结论是「每一条出网路径都走代理，与设置页的声称一致」。

所以**不是"新增一条出网路径"，而是"一条已存在、已接入代理、已被守卫覆盖的路径"**。

**另外，`ADR-016` 决策 3 已经隐含回答了大半**：LLM 只留在线（BYO API Key + 探测
已装的 Ollama/LM Studio），砍掉内置 llama.cpp。**整个 LLM 功能本来就要出网、要用户的 Key**；
拉模型列表用的是**同一个域名、同一份凭据**。拿"local-first 不宜新增云依赖"反对它，
在这一格上站不住 —— 那条立场约束的是**转写/模型权重**，不是用户自带的云 LLM。

#### 真正剩下的、需要你裁的那一条（比原问题小得多）

**20 家 `official-doc` 的清单是人工转录的快照，`checkedAt` 实测跨度 `2026-04-28` ~ `2026-05-31`
—— 今天已经 2.3 ~ 3.4 个月。**

- **用户可见后果**：新出的型号在下拉里没有；厂商下线的型号还在。
  用户选到一个已下线的型号 → 调用时报错，而错误来自厂商、不来自我们。
  ⚠️ **有兜底**：下拉里有「自定义…」可直接手填型号（`llm.ts` 的 `not-enumerable` 文案明说了）。
  所以这是**不方便**，不是**堵死**。
- **改的代价**：三种量级，从小到大
  1. 什么都不做，靠「自定义…」兜底 —— 0；
  2. 每次发版前人工核一遍 20 家文档 —— 每次几小时人工，且**没有守卫，漏了不会有人知道**；
  3. 做成"清单也能动态刷新" —— 那 20 家**没有 API**，只能抓文档页，
     **等于给 20 个 HTML 页面写 20 个解析器**，且它们随时改版。⚠️ 这一档我建议直接排除。
- **不改的代价**：清单持续变旧，速度约等于厂商发布新模型的速度。

**我的倾向（依据，不是裁决）**：走第 1 档 + 一条**廉价的诚实措辞**——
在下拉里把 `checkedAt` 显示出来（"清单核对于 2026-05-31，更新的型号请用『自定义…』"）。
依据是本仓一贯的判据：**做不到实时就别假装实时，但要让用户知道他看的是什么时候的东西**，
而这比"每次发版人工核 20 家"可持续，也比"写 20 个 HTML 解析器"便宜几个数量级。
⚠️ **`checkedAt` 今天有没有在界面上显示，我 `[未验证]`** —— 没去翻前端渲染路径。

---

### ② 「一个诚实的灰色链接，好过一个自信的错误高亮」（`wire-up.md:645`）—— **已闭合，且当时就被裁了**

**原问题**：侧栏文件夹链接高亮修准之后，点文件夹却仍列出全部笔记
（`GET /api/notes` 当时只认 `limit` / `starred`）。那位建议在 `?folder=` 落地前先把链接置灰，
并要求裁决"含不含后代"。

**今天：`?folder=<uid>` 已经实现，而且那个语义裁决已经做出并写在代码里。** `[实测]`

`apps/daemon/src/http/rest/notes.ts`（`GET /api/notes` 分支）：

- 收 `?folder=<uid>`，注释原文：**「**含子孙**（裁决）：文件夹是树，点父级期待的是"这个主题下的全部"」**；
- 递归在 SQL 里（`FOLDER_CLOSURE_CTE`），**与侧栏计数同一份定义**（不各算各的）；
- 认不出的 uid **400 `BAD_QUERY_PARAM`**，不静默返回全部
  （注释写明理由：静默会让手滑打错的 uid 得到"全部笔记"，而用户以为在看某个文件夹）。

**⇒ 这条不需要你再裁了。** "置灰链接"那个临时缓解措施也随之作废 ——
它当时的前提（筛选没实现）已经不成立。

---

### ③ pack-publish 的 3 处断点（`pack-publish.md:285`）—— **三条全部闭合** `[实测]`

| #   | 原断点                                       | 今天                                                                                                                                   |
| --- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 解包多一层同名目录 ⇒ `<X>/<X>/coremldata.bin` | **已修**：`installer.ts:251` `collapseRedundantTopLevel(tmpDir, basename(finalDir))`；`installer.test.ts:187` 专门断言 `coremldata.bin` 必须落在第一层 |
| 2   | 前端从不传 `includeOptional` ⇒ 界面装不了 encoder | **已修**：`ModelsPage.tsx:194/230` `handlePull(v, includeOptional)`；`ModelCard.tsx:29` 有勾选项                                    |
| 3   | 只有 f16 挂了 encoder，默认推荐的 q5_0 没挂  | **已修**：实测清单里 **5** 条挂了 `coreml-encoder`，**含默认推荐的 `asr/whisper-large-v3-turbo-q5_0`**                                |

第 3 条我是逐条解 `models-whisper.json` 数出来的（25 个条目里 5 个有该 role），不是读回执。

---

### ④ SSE 设计冲突：扁平 vs 嵌套（`model-mgmt.md:121`）—— **实质已裁决，但文档里还挂着"请裁决"**

**实质早就闭合**：

- **`ADR-010` 决策 2** 原文：「SSE 信封 = **扁平**，D-01 需订正 …… **裁定扁平**」；
- **D-01 已于 2026-08-02 订正**（文件头订正批次 ④ 明确写「SSE 信封改为扁平（原嵌套 `payload`，ADR-010 决策 2）」）；
- **实现就是扁平** —— 我上一轮 e2e 抓到的真实帧：
  `{"type":"model.removed","ts":"…","topic":"models","modelId":"…","freedBytes":885098}`，
  业务字段在顶层，没有 `payload` 包层。

**但 `D-03-download-and-model-api.md` 至今还挂着 4 处"待裁决"标记** `[实测]`：

- `:21` 「payload 由 D-01 时序图推导，**需 `architect` 确认**」
- `:176-179` 「**⚠️ 需 `architect` 裁决的一处偏差** …… **我不单方面改，请裁决。**」
- `:591` 表格第 6 行「SSE 信封扁平 vs D-01 嵌套 → **需 `architect` 裁决**」
- `:592` 表格第 7 行「F1–F5 事件 payload → **需 `architect` 确认**」

**这正是你说的 `ADR-003` quarantine 那个形状**：裁决做了、在**别处**记了（ADR-010 + D-01），
**原文一字未改**，于是今天任何人读 D-03 都会以为这事还开着 —— 而它已经闭合了 3 个月。

**对照组说明这是可以做对的**：`D-05-frontend.md:20` 就把同一批问题清理掉了，
原文写着「**此前这三条写着"需 Manager 裁决"**…… 全部已解决」，并逐条给了去向。
**D-03 没有做这一步。**

**我的倾向**：不需要你裁"扁平还是嵌套"（ADR-010 已裁），需要你派人**订正 D-03**
（照 D-05 的做法：保留原文 + 标注"已由 ADR-010 决策 2 裁定为扁平，D-01 已订正"）。
⚠️ **我没有动它** —— 它是别人的交付物。

---

## 二、有没有被别的决定隐含否决掉的

- ① **不被否决，反而被支持**：`ADR-016` 决策 3 明确保留"在线 LLM（BYO Key + 探测本地）"，
  出网是这条功能的前提，不是新增的负担。
- ②③④ 均与用户裁掉的那批（TTS / 移动端 / 协作 / 云账号 / 支付 / 多工作区 /
  macOS Intel / linux-arm64 / ROCm）**没有交集**。
- ⚠️ 我**只核了 `ADR-016` 与 `ADR-010`** 两份。其余 14 份 ADR 里有没有别的隐含否决，
  `[未验证]`。

---

## 三、顺带挖到的「声称闭合但验不到」

**只列我真的核过的那一条**（其余是线索，见下）：

### 已核实：`D-03` 的 4 处"待裁决"标记全部过期（见上 ④）

这条比那四条本身值钱：它说明**"裁决了但没回原文订正"这个动作在本仓是会漏的**，
而 D-05 证明它是可以补上的。建议把「裁决后回原文订正」写成流程的一步。

### 未核实的线索（**我没有逐条验，不许当结论用**）`[未验证]`

同一形状的"待裁决"标记在这几处还挂着，我**只是 grep 到，没有去对 ADR**：

- `docs/design/D-03-...md:591,592`（同 ④，已含在上面）
- `docs/design/D-05-frontend.md:792` §6.2「服务端文案与客户端文案的边界（有张力，需 Manager 裁决）」
- `docs/design/D-09-ui-gap.md:313` §6「对其他 agent 的影响 / 待裁决」
- `docs/design/D-10-model-ia.md:861` §8「需 Manager 裁决」
- `docs/design/D-11-ci-platform-facts.md:448`「建议（未实施，需 Manager 裁定）：`YOUTUBE_DL_SKIP_DOWNLOAD=1` …」

**为什么不替你核完**：逐条核要把每份 ADR 与实现都读一遍，
按本轮 `backlog-sweep` 的比例（105 条里 61 条早做完了）**大概率多数已闭合**，
但"大概率"不是证据。这五条值得单独派一轮，判据与本轮相同。

---

## 四、纪律与诚实声明

- **全程只读**：没有改任何产品代码，没有改别人的回执/设计文档。唯一写入是本文件。
- 跑过的唯一一个会出网的东西是 `scripts/ci/proxy-coverage-audit.mjs`（它本来就是审计脚本，
  exit 0）。没碰 `:10000`、`/root/data-memo`、机器级指针；没用 `pkill -f`；没建/改/删 release。
- **数字来源**：24 家 / 520 条 / 4 家可枚举 / 20 家 official-doc / `checkedAt` 跨度
  全部是**程序解析 `llm-providers.json` 数出来的**，不是抄回执。
  ⚠️ 我第一次 grep 把可枚举数得成 7 —— 因为 `official-doc` 的 URL 里也含 "api"
  （`api-docs.deepseek.com`）。**按 `modelListSource.type` 重数才是 4**，以 4 为准。
- `[未验证]`：`checkedAt` 有没有在界面上显示；D-05/D-09/D-10/D-11 那四处标记是否也已过期。
- `UNKNOWN`：无。

**我没有替你裁任何一条。** ①剩下的那个残留、④的 D-03 订正，都还等你拍板。

---

## [2026-08-08 22:30] 裁决执行 + 5 处同形标记复核 + HANDOFF 同步 DONE

按 PROTOCOL §13 就地改原文（删除线保留 + 写清何时/被谁/依据什么），
**越界改了 5 份 `docs/` 交付物**，在此申报，请追认。

### ① `checkedAt` 是否已渲染 —— **已经有了，没重做** `[实测]`

你裁的是"把 `checkedAt` 露在下拉框里"。**它今天就在**：

- `LlmModelSelect.tsx:230-232` → i18n key `settings.modelPicker.note`
- `zh-CN.json` 原文：**「内置清单 {{n}} 个 · 核对于 {{date}}，可能已过时」**
- 数据来源 `llm-catalog.ts:274` ← `spec.modelListSource.checkedAt`
- 那 4 家可枚举的走另一条文案 `noteApi`（「点『刷新』问一次它现在真正有哪些」）

⇒ **这条裁决无需任何改动即已满足**，我没有重做。

### ④ `D-03` 那 4 处「请裁决」—— 已就地改

`docs/design/D-03-download-and-model-api.md`，4 处全部处理：`:21`（payload 确认）、
`:176-180`（信封偏差的整段引用块）、表格第 6 行、表格第 7 行。
格式照 `ADR-003 §7.6` / `D-05:20`：原文删除线保留，新块写明
**裁决出处（`ADR-010` 决策 2）+ D-01 订正时间（2026-08-02）+ 实测证据**
（我上一轮 e2e 抓到的真实帧是扁平的；`SSE_EVENT_TYPES` 今天 30 个且各有具名 payload 接口）。

### ⑤ 那 5 处同形标记 —— **逐条判定结果（3 闭合 / 1 混合 / 1 部分）**

| 出处                | 判定                | 证据                                                                                                                                                                          |
| ------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D-05 §6.2**       | ✅ **已闭合**       | 本节建议的方案就是今天的实现：`i18n/index.ts:13` 逐字写着「按 `code` 查 `errors.<CODE>`，`message`/`messageZh` 只作兜底」；`errors` 节有 **13 个具名 CODE**。临时方案已成长期方案 |
| **D-09 §6**         | ⚠️ **混合**（6 条） | #1 **闭合**（`HealthBanner.tsx` 文件已不存在）；#2 **仍成立**（`settings/:section` 仍渲染同一页）；#3 **仍成立**（`<option>system</option>` 三行硬编码）；#4 **大部分闭合**（`en.json` models 136 / runtime 72 条）；#5 纯知会；#6 仍成立 `[未验证]` |
| **D-10 §8-D1**      | ✅ **已闭合**       | `llm/resolve.ts:76-78` 已改成**先读目录的 `kind`** 分派，硬编码 id 只作老配置兜底，且兜底 `:86` **`anthropic` 与 `claude` 两个都认** ⇒「P1 一上线就坏」的风险不存在了            |
| **D-10 §8-D2/D3**   | ❌ **仍成立**       | D2：`models-llm.json` 今天仍在（5 条），且 `manifests.ts` 已改成**列目录加载所有 `*.json`**，所以它会被加载 —— "停用 manifest 还是只隐藏 Tab"没人裁过。D3：`nav.runtime` 仍是 `"运行时"` |
| **D-11:448**        | ✅ **已闭合，且更彻底** | 建议是 `YOUTUBE_DL_SKIP_DOWNLOAD=1`；**实际是把两个包整个删了**（`packages/pipeline/package.json` 的 `_comment:removed-deps` 记着依据与三查过程），而且 `cold-start-audit.yml` 有**反向断言**不许它们再出现 |

**⇒ 5 处里 3 处该划掉、1 处只剩一半、1 处（D-10 D2/D3）是真的还在等你裁。**
所有判定都已按 §13 就地写进对应文档，未删原文。

### 追加：`HANDOFF.md` 已同步到今天

**划掉 3 条经核实已不成立的**（原文保留删除线 + 证据）：

- `health.host` 写死 `127.0.0.1` → `server.ts:172` 已是 `host: deps.host()`
- `upload.ts:656,663` 两处 `as never` → 该文件 `:664` 自己写着「已删（T-130）」
- 搬迁 `warningZh` 只做一半 → `DataLocationSection.tsx:485` 已渲染，
  且渲染条件是 `warningZh` 本身（不依赖 `staleLinks` 非空）

**收窄 1 条**：`verifying`/`blocked` —— `blocked` 已补验，`verifying` 与 `serious` 仍无真实场景。

**补上此前完全没有的一大批**：v0.3.0 预编译包已发布、四条 e2e 腿、要求 2.1 死胡同已修
（附成因：启动快照 → 指纹派生）、断路器冷却/半开 + 「探针还没装不算失败」、
代理覆盖全部出网路径、`format:check` 进门禁、PROTOCOL §11/§12/§13。

#### ⚠️ 我**保留**了哪些未决项，以及为什么

新开一节「**结构上验不了 —— 验不了不是没做，不许因为 CI 全绿就划掉**」：

1. **Windows + NVIDIA CUDA** —— 托管 runner 没有 N 卡。
   `[CI 实测]` 加速包**能装上**、`select` 如实回 409「installed but enumerated no devices」，
   即**"装"验到了、"装完真能加速"没有**。保留理由：这是覆盖率缺口，不是功能缺失。
2. **真 GPU 上的加速效果（三平台）** —— 同上；我那条腿里 `A-ACCEL-SWITCH`
   在三个平台**刻意是 UNKNOWN 而不是绿**，因为绿会是假的。
3. **macOS 分层下限的静默失效** —— `[CI 实测]` `vec0.dylib` minos **14.0.0**
   ⇒ 13.3–13.x 上**向量检索加载不了**；`sherpa-onnx.node` 14.0.0 /
   `libonnxruntime*.dylib` **15.5.0** ⇒ < 15.5 上**流式 ASR 加载不了**；
   **两者都静默**。而 README 承诺 ≥ 13.3。
   保留理由：**「还要不要继续宣称支持 13.3」是产品决策，至今没人裁**
   （`check-bundle-macos-floors.mjs` 文件头自己也这么写）。
4. **`windows-2022 / cuda` 保留的理由 `UNKNOWN`** —— D-11 记着：自首版架构提交起
   从未改过、理由从没被写下来，CI 上是 success。**不知道就写 UNKNOWN，不编一个理由。**

### 越界申报（PROTOCOL §13 要求）

按 §1 `docs/**` 归 Manager。本轮我就地改了 **5 份**：
`D-03`、`D-05`、`D-09`、`D-10`、`D-11`，外加 `HANDOFF.md`。
依据是 §13「**谁发现原文不实，谁就地改 …… 宁可越界改对，不要守界烂着**」。
**全部保留原文删除线**，未删任何一句。请追认。

### 没碰的

- `README.md` / `docs/DEPLOYMENT.md` —— **另一位正在改**（`git status` 里是他未提交的改动），
  我一个字没动，也没把它们纳入提交。
- `docs/design/D-17` —— 发布前置门禁那位的地界，只读未改。
- 产品代码**一行未改**（本轮全部是文档订正）。
- 没碰 `:10000`、`/root/data-memo`、机器级指针；没用 `pkill -f`；没建/改/删 release。

### 诚实标记

- `[未验证]`：D-09 §6 #4 的「UI 正文是否 100% 走 i18n」（我用 `en.json` 词条数与 `t()`
  调用数做的判断，没有逐行分离注释与 JSX 文本）；D-09 §6 #6；D-10 §8-D1 的建议 ②
  （daemon 是否已让 `llm.providers` 成为唯一清单）。
- `UNKNOWN`：`windows-2022/cuda` 的保留理由 —— 全历史只有 3 个 commit 命中且从未改过。

---

## [2026-08-08 23:55] 裁决 ② / ③ 执行 DONE

提交 `4c94775`（代码）+ 本条回执。门禁在隔离 worktree 检出 `4c94775` 上跑：
**`pnpm -r test` 1589 pass / 0 fail**（基线 1578 + 我新增 11 条）、`tsc -b`、`eslint`、
`format:check`、`check:orphans` **70/70**、`lint-workflows` 1292 全绿。

### ② macOS 分层下限 —— 三档实际文案（真实输出，不是我编的）

判定逻辑做成纯函数后，我用注入版本号真跑了一遍 `runSelfCheck`，以下是**原样复制**：

**macOS 13.3（我们承诺的下限）—— 两项都 `warn`**

```
[warn] os.macos.semanticSearch  required=false
 zh: 你的 macOS 是 13.3，低于 14.0 —— 语义检索与混合检索用不了（关键词全文检索不受影响，
     仍然可用）。这不是故障，也不是你配错了：sqlite-vec v0.1.9 官方 macos-aarch64 产物的
     minos = 14.0.0，而本产品承诺的下限是 13.3，所以这台机器上核心功能（转写、播放、笔记、
     中文全文检索）全都正常。
 en: Your macOS is 13.3, below 14.0 — semantic and hybrid search are unavailable (keyword
     full-text search still works). This is not a fault and not a misconfiguration: the
     official sqlite-vec v0.1.9 macos-aarch64 build has minos = 14.0.0. Core features
     (transcription, playback, notes, Chinese full-text search) work fine here.
 补救: 升级到 macOS 14.0 或更高即可启用；不升级也不影响核心功能
[warn] os.macos.streamingAsr  —— 同形，下限 15.5，丢的是「录音实时字幕」
     （录完之后的整段转写不受影响）
```

**macOS 14.6 —— 语义检索回来了，流式 ASR 仍 `warn`**

```
[ok]   os.macos.semanticSearch : macOS 14.6 ≥ 14.0，语义 / 混合检索（sqlite-vec）可用
[warn] os.macos.streamingAsr   : 你的 macOS 是 14.6，低于 15.5 —— 录音实时字幕用不了…
```

**macOS 15.5+ —— 两项都 `ok`**

```
[ok] os.macos.semanticSearch : macOS 15.5 ≥ 14.0，…可用
[ok] os.macos.streamingAsr   : macOS 15.5 ≥ 15.5，…可用
```

**版本取不到 —— `warn`，但说的是"取不到"**

```
[warn] zh: 没能取到 macOS 系统版本，无法判断 语义 / 混合检索（sqlite-vec） 是否可用（需要 ≥ 14.0）
       补救: 手动核对：终端跑 sw_vers -productVersion，低于 14.0 则该功能不可用
```

#### 我选了 `warn` + `required:false`，理由

CLI 退出码的规则是 `status === 'fail' && required`（`scripts/selfcheck.mjs:493`）。

- 在一台 13.3 的 Mac 上「语义检索不可用」**是事实，不是故障** —— 那台机器**完全符合
  我们对外承诺的下限**。报 `fail` 会让它自检退出码变 1，
  即**你点名不许的"会常态变红的门禁"**，而常态红等于训练所有人忽略它。
- `warn` 永远不参与红绿，所以这两项**不会**让任何一条 CI 腿变红。
- **取不到版本也用 `warn`**，但文案完全不同：说"没能取到，无法判断"，
  并给出手动核对命令。**不假设够新**（那会把洞盖回去）、**不假设太旧**（那是假警报）。
- **非 darwin 上这两项根本不出现**（与 `asr.coreml` 同一条规矩）—— 一个在 Linux 上
  永远 ok 的检查项是纯噪音。

#### 在 Linux 上怎么验的 / 什么没验

判定被拆成纯函数 `evaluateOsFloors(floors, productVersion)`，**11 条测试**覆盖：
13.3 / 14.0 / 14.6 / 15.5 / 15.4.9 / 26.0 / null / 空串 / 非数字。
两条**边界**单独钉：`15.5.0` 必须算达标（写成 `>` 会把一台正常机器报成不可用）。

- `[未验证:需真 Mac]` —— **"一台真 13.3 的 Mac 上自检确实打印这段话"**。
  托管 runner 给不了 13.3 的 macOS，这一格结构上验不了；但判定逻辑有人守。
- Darwin→macOS 用**查表不用公式**：Apple 在 Darwin 25 把产品号从 16 跳到 **26**，
  任何"加 11"的算法都会在那里算错，**而算错的结果是一个看起来很确定的错版本号**。
  未知一律回 `null`，让上层如实说"取不到"。

### 同形的其它下限：我找到几条

**一条同族、一条结构上不可能有、一条 UNKNOWN。**

| 平台        | 结论                                                                                                                                                                                   |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **macOS**   | 2 条（本轮已做）                                                                                                                                                                          |
| **Linux**   | **结构上今天不可能有缺口**：`check-elf-glibc.mjs --dir <整个包> --max 2.34` 是对**整包**跑的，而 2.34 正是我们承诺的下限 ⇒ 包里任何一个 ELF 都不可能高于承诺。所以没有对应自检项，不是漏了 |
| **Windows** | ⚠️ **同族，且今天完全没有测量** —— `build-bundles.yml` 自己写着「Windows 上没有 ELF / Mach-O 守卫可跑」。VC++ 2015-2022 只写在 `docs/DEPLOYMENT.md`，**没有任何打包期测量、也没有运行时自检** |

Windows 那条我**没有做**，理由是不能猜：要给它一个诚实的自检项，先得知道包里每个 DLL
到底要哪个 VC++ 版本，而**今天没有任何东西在量它**。`[未验证]` 它是否真的静默
（`DEPLOYMENT.md:698` 暗示缺 VC++ 时会有加载错误，那可能是"响亮"的）。
→ **建议单独派一轮**：先量（打包期加 Windows 侧守卫），再决定要不要自检项。
我在 `osFloors.ts` 的注释里写明了「这里没有 Windows 项是已知未做，不是漏了」。

### ③ 逐条处置

**`<option>system</option>` 硬编码 —— 顺手修了。** 3 个键 + 3 行 JSX
（`app.themeSystem/themeLight/themeDark`，中英都加）。它旁边的标签「主题」本来就是
翻译过的，用户看到的是半截中文。代价确实成比例。

**`settings/:section` 五个 section 渲染同一页 —— 不修，已在 D-09 §6 的复核块里写明理由。**
拆页要动路由结构 + 五个 section 的挂载，属 `architect` 的骨架；
而它今天**没有用户可见故障**（每个 section 都到得了、内容都在）。
按 §13 我已经把它从"待裁决"改成有明确判定的条目，不再挂着"请裁决"的样子。

**`models-llm.json` 今天到底影响了什么 —— 答案：`[实测]` 用户看不到，但 API 还发着。**

- 服务端：`manifests.ts` 已改成**列目录加载所有 `*.json`**，所以这 5 条
  （`llm/qwen3-4b-q4_k_m` 等）**确实进了 `/api/models/catalog` 的响应**，服务端无过滤。
- 前端：`ModelsPage.tsx:73` 的 `ASR_TAB_ROLES = ['asr','vad','punctuation']` 把它们**滤掉了**，
  转写 Tab 上一条都不显示；语言模型 Tab 显示的是在线 provider，不是这些 GGUF 权重。
- ⇒ **今天没有用户可见缺陷**。但它是一条**活着的 API 面**：
  `POST /api/models/pull` 直接喂 `llm/qwen3-8b-q4_k_m` 仍然能下载一个 ADR-016 已经砍掉的东西，
  而且任何客户端（或哪天有人把 role 白名单放宽）都会把它显示出来。
  **所以这是"一条该被写清的历史 + 一个待收口的 API 面"，不是今天的故障。**
  D2 的范围问题（停用 manifest 还是只隐藏）**仍然需要你裁**，我没有替你定。

**`nav.runtime` 仍是"运行时" —— 说清它到底哪里不对：其实没有"不对"。**
D-10 §8-D3 的原意是**用词偏好**："运行时"是工程师词汇，建议改叫"本机组件"，
**路由 `/runtime` 不改**。也就是说：**没有任何东西是坏的**，
它是一次产品命名判断，需要的是"要不要改这个词"的一句话，不是修复。
我按原样保留并在 D-10 的复核块里写明了这一点。

### 边界申报

- **没碰** `README.md` / `docs/DEPLOYMENT.md` / `docs/SECURITY.md` —— `docs-sync` 正在改。
  ⚠️ `prettier --check .` 报 `docs/DEPLOYMENT.md` 未格式化，**那是他工作区里的未提交改动，
  我刻意没有 `--write` 它**（格式化会把他的东西带进我的提交）。我的文件全部已格式化。
- **没碰** `.github/workflows/**` —— 另一位在接凭证。
- 本轮我动的 `docs/`：**零**（上一轮动的 5 份已提交，本轮只动代码 + 本回执）。
- 没碰 `:10000`、`/root/data-memo`、机器级指针；没用 `pkill -f`；没建/改/删 release。

### 诚实标记

- `[未验证:需真 Mac]`：13.3 真机上的实际打印。
- `[未验证]`：Windows 缺 VC++ 时的失败是否**静默**（DEPLOYMENT 暗示有加载错误）。
- `UNKNOWN`：包里各 DLL 各自要求的 VC++ 版本 —— **今天没有任何东西在量它**。

---

## [2026-08-09 00:40] 裁决 ① / ② 执行 DONE

提交 `93eec54`。门禁在隔离 worktree 检出该 commit 上跑：
**`pnpm -r test` 1593 pass / 0 fail**（基线 1589 + 我新增 4 条）、`tsc -b`、`eslint`、
`format:check`、`check:orphans` **70/70** 全绿。

### ① 那个 API 面关在哪一层 —— **`RestState.create()` 里，目录加载之后**

`apps/daemon/src/http/rest/state.ts` 新增 `withoutRetiredRoles()`：
在 `loadModelCatalog()` **之后、构造 `RestState` 之前**把 `role=llm` 摘掉。

**为什么是这一层（而不是前端、也不是删文件）**

- `/api/models/catalog` 与 `findCatalogModel()`（**`POST /api/models/pull` 的入口**）
  **读的是同一份 `this.modelCatalog`** —— 在它被构造之前摘掉，
  **一处收口，两条路一起堵**。这是全链上唯一一个能同时堵住两者的点。
- **不在前端加过滤**：你划的底线，前端过滤是装饰不是闸门。
  而且实测已经证明了这一点 —— 前端**本来就**滤掉了（`ASR_TAB_ROLES`），
  可 API 面照样是活的。
- **不删 `models-llm.json`**：删文件会让下一个人看不出这里曾经有过什么、为什么没了，
  于是很可能加回来 —— §13 那张表就是这么来的。

**一个刻意的例外，写进了注释**：**已装在盘上的记录不受影响**。
`listInstalled()` 读 `manifests/` 下的安装记录而不是这份目录 ——
用户此前装过的东西不该因为我们改了主意就从界面消失，那是"数据在界面上消失"那一族。
**关的是新的下载入口，不是已有的东西。**

**对照实验（证明它本来真的是活的）**：绕过过滤直接问加载器 ——
`role=llm` 交出 **5 条**（`llm/qwen3-4b-q4_k_m` …），总条目 **35**；
过滤后目录里 `role=llm` 为 **0**。

**守卫** `apps/daemon/src/http/rest/retiredRoles.test.ts` 4 条，
夹具**直接用真清单里的条目**（手搓过一版，连撞两轮 schema 校验，
而那些字段与要验的事情毫无关系；用真条目还让"那 5 条进不来"字面为真）：

1. 目录里不许再出现那 5 个 id
2. **`findCatalogModel()` 按 id 也必须找不到** —— 这条才是 pull 的闸门，
   只测列表会漏掉"看不见但拉得到"这种最难发现的形态
3. **反方向**：`asr` / `vad` 一条都不许被误伤（"把什么都过滤掉"同样能骗过前两条）
4. `role=llm` 一条不剩

### ADR-016 / D-10 里那段历史怎么写的

**`ADR-016` 决策 3 下面加了「执行补记」**（原文一字未改，补记在其后）：
点名那 5 个 id、写清 `[实测]` 当时"服务端零过滤 + 前端挡住"的真实状态与对照数字、
引用你的裁决理由原话（**不许留半个功能 / 它是活的只是今天没人走**）、
写明关在哪一层与为什么不是前端、为什么不删 manifest、以及那个"已装记录不受影响"的例外。

**`D-10 §8` 的 D2 / D3 两行**：把我上一轮写的"仍成立"用删除线划掉，改成
**已裁并已执行（2026-08-08）**，各自写明做法与出处。D2 那条特别记了一句：
本条当年建议的"保留类型联合里的 `llm`"**照办了** ——
`active.llm`、`MISSING_LLM`、`gpu.llm` 全部未动。

### ② 导航文案改完之后，还有没有别处面向用户写着"运行时"

**有，而且比 `nav.runtime` 多得多 —— 一共 11 处，全改了。**

只改导航会得到「点进去叫本机组件、别处叫你去运行时页」，
那正是本仓「同一个问题两个出处」的形状，所以我没有只改那一处：

| 位置                                     | 处数    | 说明                                                                             |
| ---------------------------------------- | ------- | ---------------------------------------------------------------------------------- |
| `locales/{zh-CN,en}.json`                | **5**   | `nav.runtime`、`runtime.title`、`onboarding.openRuntime`、`asr.goInstallRuntime`、`jobToast.gotoRuntime`（中英各改） |
| `packages/runtime/src/selfcheck.ts`      | **7**   | 补救文案里的「运行时」页 → 「本机组件」页 —— **这些是诊断页给用户的下一步指引**，不改就会把人指向一个已经不叫那个名字的页面 |
| `apps/web/src/test/components.test.tsx`  | 2 处断言 | 跟着改（否则测试红）                                                              |

英文对应：`nav.runtime` = **`Local components`**，
`runtime.title` = `Local components and acceleration backends`，其余同族。

**刻意没动的一处**：`apps/daemon/src/http/rest/storage.ts:98`
`purposeZh: '运行时状态与访问令牌'` —— 那描述的是数据目录下 `runtime/` **这个目录本身**，
不是那个页面，「运行时状态」在那里是准确的。

**路由 `/runtime` 一个字没动** —— 按你说的，URL 是可分享物，
README / DEPLOYMENT / 各处文档与任务书都写着它。

⚠️ 顺带一个**没有撞上但值得知道**的事实：`nav` 里**没有** `components` 条目
（`/components`「组件与来源」页不在侧栏，D-10 §3.2 刻意不给它第二个一级入口），
所以「本机组件」这个名字**今天不会和侧栏里任何一项撞车**。
如果将来有人把 `/components` 放进侧栏，这两个名字会很接近 —— 记在这里。

### 边界申报（四路并行）

提交时工作区里有**另外三路**的在途改动，我用 `git commit -- <pathspec>` 逐文件点名，
`git show --stat` 复核确认只有我的 8 个文件：

- **没碰**（探针/冷启动那路）：`apps/daemon/src/runtime/setup.ts`、`scripts/build-bundle.mjs`、`package.json`
- **没碰**（浏览器那路）：`scripts/ci/e2e-browser-audit.mjs`（未跟踪）
- **没碰**（文档同步那路）：`docs/DEPLOYMENT.md`、`coordination/inbox/docs-sync.md`、`scripts/ci/check-doc-freshness.mjs`
- ⚠️ **与浏览器那路有一处潜在重叠**：我改了 `apps/web/src/test/components.test.tsx` 的
  **2 处断言**（因为我改了 locale，不改它必红）与 `locales/*.json` 的 5 个键。
  他此刻没有改这两个文件（`git status` 为证），但**他那条腿会驱动真浏览器断言界面文案** ——
  如果他手里有写死「运行时」的断言，会在他那边红。**在此说明边界，请他以本次文案为准。**

### 诚实标记

- `[实测]` 对照实验、过滤前后条目数、11 处文案的位置与处数，都是程序数出来/跑出来的。
- `[未验证]`：改完文案之后**真浏览器上的视觉效果**（我没跑那条腿，那是别人的地界）。
- `UNKNOWN`：无。

---

## [2026-08-09 02:10] 三条用户可感知缺口：① ② 已修，③ 未做（如实报）

提交 `5f46e6e`（① ②）+ `a8b6bed`（顺手修好 master 上红着的 format 门禁）。
门禁在隔离 worktree 检出 `5f46e6e` 上跑：**1600 pass / 0 fail**、`tsc -b`、`eslint`、
`check:orphans` **70/70** 全绿。

### ① 「测速」现在点下去，用户看到什么（真实文案）

**修前**：`void benchmark.mutateAsync(...)` 把 rejection 丢掉，服务端回 501 ——
**点了什么都不发生，按钮看起来是坏的**。这正是用户报的三条之一。

**修后**：按钮下方渲染 `ErrorBlock`，文案按 `code` 查本地表（`errors.NOT_IMPLEMENTED`）：

- **zh** 标题：「**测速」还没有实现**」
  正文：「真实的速度要在你这台机器上跑一次推理才算数，而这一步还没接通。
  产品不会拿论文或厂商标称的数字充数 —— 所以这里宁可空着，也不给你一个假的。」
- **en** 标题：`Benchmarking is not implemented yet`
  正文：`A real speed number has to come from running inference on your own machine,
  and that step is not wired up yet. The product will not fill it in with numbers
  from a paper or a vendor page — better blank than fake.`

**没有裁「要不要做 benchmark」** —— 按你说的，那是产品决定，今天不动。
判据只落在「不许静默失败」上。

⚠️ 两条新文案我本来写了 `**…**`，但 `ErrorBlock` 与那个 `<p>` **都不走 `<Emphasis>`** ——
会把裸标记吐给用户。**去掉了**，而不是去登记表里登记一个不实的声明
（组件测试里那条"带 `**` 必须在登记表里"当场抓到了它，护栏有效）。

### ② 我选了「给恢复路径」，依据

**依据是：数据事实上还在盘上。** 把它叫作"永久删除"会是一句**新的假话**，
而且是隐私方向的（用户以为抹掉了，其实那行还在库里）。所以选可逆。

- `repos.restoreNote(uid)`：`deleted_at = NULL`，返回是否真改了一行；
- `POST /api/notes/:uid/restore`；
- ⚠️ **它必须排在按 uid 取笔记那一段之前** —— 那段用 `noteByUid()`，
  而它**按设计查不到已删的**（那条过滤是对的，不改）。排后面的话，
  这个端点会变成一个**永远够不到的实现**：装了、单测过了、用户点了永远 404。
  测试第 2 条专门钉这个顺序。
- 前端：删成功后菜单切到「已删除 · 撤销」——**撤销入口出现在他刚动手的地方**，
  而不是另建一个回收站页面（回收站也可以做，但"删错了立刻能回来"是这条路上
  最先需要、也最便宜的那一半）。撤销失败也渲染，不静默。
- ⚠️ 顺手改掉一句**已经不实的文案**：`notes.deleteHint` 原文写着
  「当前界面上没有恢复入口」—— 那句当时是实话，现在不是了（§13 同一条）。

**4 条 HTTP 往返测试**（真 daemon）：删→恢复→重新出现在列表；
没删过 / 不存在的 uid 都 404，**不编一个成功**。

### ③ **没做，如实报** —— 但你要的那个核实我做完了

**「零调用者」我按你的提醒核了，含 `.mjs`：** 两条 hook
（`useRenameFolderMutation` / `useMoveNoteMutation`）全仓引用**只有三类**：
定义本身、barrel 再导出、以及**回执/文档/脚本注释里的文字**
（`scripts/check-orphan-exports.mjs:62-63` 那两处是**注释**，不是调用）。
**没有任何 `.mjs`/`.cjs` 真的调用它们** —— 与那次验签函数的形状不同，
那次是脚本真在用而孤儿检查器只扫 `.tsx?`。**结论：零调用者成立。**

接线位置也踩好点了：`useMoveNoteMutation` → `NoteActionsMenu`（已挂在
`NoteDetailPage.tsx:196`，已有改名/删除两项，加"移动到文件夹"是同一处）；
`useRenameFolderMutation` → `FolderTree`（今天**没有任何改名入口**）。

**没做的原因**：本轮时间用在 ① ② 上（① 你要求最先做，② 牵出服务端 + 前端 + 测试）。
**我不把它做一半** —— 半个 UI 比没有更糟。留给下一轮，接线点与核实结论都在上面。

### 横扫 `void mutateAsync` 同形 —— **14 处，其中 9 处完全不渲染错误**

给真浏览器那位（**我没有动这些文件**，都在他地界）：

| 文件 | mutation | 是否渲染错误 |
| --- | --- | --- |
| `features/runtime/RuntimePage.tsx` | `install` | ❌ **0** |
| `features/runtime/RuntimePage.tsx` | `remove` | ❌ **0** |
| `features/models/ModelsPage.tsx` | `activate` | ❌ 0 |
| `features/models/ModelsPage.tsx` | `cancelJob` | ❌ 0 |
| `features/models/ModelsPage.tsx` | `retryJob` | ❌ 0 |
| `features/models/ModelsPage.tsx` | `gc` | ❌ 0 |
| `features/models/ModelDetailPage.tsx` | `verify` | ❌ 0 |
| `features/models/StorageSettingsPage.tsx` | `gc` | ❌ 0 |
| `features/components/ComponentsPage.tsx` | `check` | ❌ 0 |
| `features/models/ModelsPage.tsx` | `del` | ✅ 有 |
| `features/models/components/SourcesSection.tsx` | `probe` / `select` | ✅ 有 |
| `features/runtime/RuntimePage.tsx` | `select` / `selfTest` | ✅ 有 |

⚠️ **`RuntimePage` 的 `install` / `remove` 那两条最值得先看** —— 它们正是
「本机组件页点安装没反应」的落点，与用户报的症状同一族。

### 越界申报

- `a8b6bed`：`docs/research/memoac/F1-F5-PARITY.md` **纯格式化，零语义改动**。
  它由 `6da92ef` 提交时漏了 prettier，于是 **master 上 `format:check` 对所有人都是红的**。
  不是我的文件，但一条对谁都红的门禁等于没有门禁。已在 commit message 里写明。
- **没碰**三路在途：`packages/downloader/src/sidecar.ts`、`scripts/ci/launcher-spawn.mjs`、
  `scripts/build-bundle.mjs`、`scripts/ci/e2e-*.mjs`、`docs/adr/ADR-003`、
  `packages/pipeline/src/tools.ts` 等，`git show --stat` 已复核只有我的 8 个文件。

### 诚实标记

- `[未验证]`：撤销面板与 `ErrorBlock` 在**真浏览器**里的视觉效果（组件测试 312 全绿，
  但真浏览器那条腿今天仍因缺 playwright 没跑起来）。
- `UNKNOWN`：无。
