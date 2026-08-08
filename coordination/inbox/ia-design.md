# ia-design 回执

## [2026-08-03 15:10] T-115 DONE

交付:

- `/root/memo/docs/design/D-10-model-ia.md`（id: D-10, status: draft, 881 行）
- 截图（仓库外）: `/tmp/ia-design/{models,models-llm-tab,runtime,settings}.png`

要点:

1. **实测到的不是"重复"，是"矛盾"**：`:10000` 上 `/models` 写「语言模型：未选择 —— 思维导图功能不可用」，
   同一时刻 `/settings` 写「当前生效：DeepSeek · deepseek-v4-flash」。前者读 `active.llm`（永远 `null`），
   后者读 `llm.defaultProviderId`。**有一个页面在谎报功能不可用。**
2. **`/models` 的「语言模型」Tab 装的是 ADR-016 已砍掉的东西**（4 张 GGUF 卡 + `/runtime` 7 个 llama.cpp 包，现在都点得动）。
3. 导航树定为：`模型` = 一个页面 `/models`，页内两 Tab（转写 / 语言模型）+ 页顶跨 Tab 常驻「当前使用」两行。
   设置页只留 通用 / 网络代理 / 数据位置 / 关于 + 一行指路牌。
4. 三个判断：本地/在线 = **分组不是 Tab**；运行时 **不算模型**；状态词 **统一轴与视觉、不统一动词**（只有 `使用中`/`异常` 逐字统一）。
5. 迁移表 **29 条**，每条到区块 + 文件:行 + 责任 agent；分 **P0 止血 / P0.5 拆雷 / P1 搬家 / P2 补件** 四批。

下一步建议:

1. **先裁决 §8-D1（最急）**，再让 `architect` 动 P1 —— 否则一改吃 24 家目录，Anthropic 立刻静默坏掉。
2. P0 三条（#7 #8 #12）不依赖任何新端点，可立即派 `architect` + `model-mgmt` + `gpu-runtime` 并行做。
3. `oss-scout` 补 `POST /api/llm/detect`，否则「本地模型」组只能让用户手填 IP（= ADR-016 档 2 没做）。

需要 Manager 决策:

- **D1 🚨（最急，卡住 P1）**：daemon 靠**硬编码 id** 分派 LLM 协议（`=== 'anthropic'`，`apps/daemon/src/llm/resolve.ts:89`），
  而新目录 `vendor/manifests/llm-providers.json` 的 id 是 **`claude`**（另有 `zhipuai`≠`zhipu`、`aliyun`/`qwen`≠`dashscope`、
  `siliconcloud`≠`siliconflow`）。**一旦按 R-P1 改吃 24 家目录，Anthropic 会落到 OpenAI 兼容分支，坏掉且不报错。**
  另同一处：`resolveConfiguredProvider()` **从不读 `llm.providers`**，今天靠前端"两边都写"维持一致。
  建议：分派改吃目录的 `kind` 字段，并让 daemon 读 `llm.providers` 成为唯一清单。
  跨 `apps/daemon`(`oss-scout`) + `packages/shared`(`model-mgmt`) 两个所有权域，**我不能改**。
- **D2**：`role=llm` 下架范围 —— 建议停用 manifest（服务端不再返回），但**保留**类型联合里的 `llm`
  （`active.llm`、`MISSING_LLM`、`gpu.llm` 通道都还在用这个词）。
- **D3**：一级导航「运行时」是否改名「本机组件」。建议改（"运行时"是工程师词汇），**路由 `/runtime` 不改**。
  影响 D-05 §1.1 与 `nav.runtime`，属 `architect` 的交付物，我不改他人交付物。

诚实标注:

- 全程**只读** `:10000`，未重启、未 PATCH、未下载。未使用 `pkill -f`；自起的 Chromium 进程随脚本退出。
- **零代码交付** —— `apps/web/src/**` 归 `architect`，我一行没碰。
- 我**写错过一版并已订正**：迁移表 #21 原按 R-06 转述写成"假引擎选择器待修"，实地一看
  `components/common/AsrModelPicker.tsx` **已经修好了**（走 `POST /api/models/activate`、只列 installed）。
  已改为"**别再造第二个**"。教训记在这里：R-06 的转述有时滞。
- 我**不同意 coordinator 转达的一条措辞并已订正**：空档位不能写"该档暂无中文模型"——
  `languages:['multi']` 的 whisper **是支持中文的**（ADR-013 原话）。写成 **R-M2**：
  语言维度不许按 `languages` 排他筛选，`multi` 必须落进每个语言格子。
  另实测发现 **`en × quality` 也是空的**，这一格没被提到。
- `model-mgmt` 新数据层的 4 条约束我**逐条读码/调接口核实**后采纳：`speedClass` 24 家目录、
  `bucketProviders` 三桶、`canRefreshModelList` 只 4 家、`configFieldKeys` 逐家不同、
  出厂 `configured: []`、`superseded` 标签实测在 large-v1/v2 上。

subagent（未 kill，可复用）:

- `a6acb6fdbef46fffe` — 前端 IA 全量清点（路由/三页区块/状态枚举/i18n 键），sonnet5
- `a6fd8721ec4ae2c43` — memo.ac v1.7.5 模型 IA 取证（导航/设置 12 项/47 条分组/状态词），sonnet5
