# llm-picker 回执

## TL;DR（≤ 25 行，Manager 只读这里）

- **T-126 DONE。模型选择从 `<input list=…>`（自由输入 + datalist）改成真 `<select>`，两处复用同一个新组件 `LlmModelSelect`。** 逃生口保留为下拉**最后一项**「自定义…」，选中后才出现文本框 —— 前任那条「厂商上新比我们发版快」的顾虑仍然成立，只是从**默认**降级成**例外**。
- **数字要说准：目录是 24 家 / 520 条，实际接进下拉的是 11 家 / 283 条。** 够不到的 **13 家 / 237 条**（qianfan 82 · siliconcloud 之外的 azura 35 · together 27 · mistralai 22 · groq 15 · doubao 13 · xai 12 · minimax 7 · kimicodingplan 7 · aliyun 6 · xiaomimimo 5 · zhipuaicodingplan 4 · minimaxtokenplan 2）**不是我漏了**，是「+ 添加服务商」只有 11 个预设（`LLM_PRESETS`），用户根本加不进那 13 家 —— 那是 **D-10 #24，归 `architect`**，他在上一份回执里明说「是一整块，我不想半做」。**我没有替他做，也没有假装做了。**
- **候选来源与「按用途分别配置」是同一份**：两处都走 `useLlmConfig().modelsFor()`，只是 `modelsFor` 内部从"前端手写的 11 家 × 2~3 个"改成读 `vendor/manifests/llm-providers.json`。**没有分叉，没有第二份清单。**
- **手写清单不是"少"的问题，是"错"的问题**：它只有 `deepseek-chat` / `deepseek-reasoner`，而**用户实际配的 `deepseek-v4-flash` 在旧下拉里根本不存在**。这就是"两处不统一"在型号层面的本体。
- **最容易丢数据的那一步已经堵死并实测**：`<select>` 遇到不在 options 里的 value 会**显示成空**，用户再点一次保存就真写空了。做法是「值不在候选里 ⇒ 自动进自定义模式，原值一个字符不改」，有专门用例（`gateway/未来的型号-v9`）。
- **用户真实配置实测未动**（`:10000` / `/root/data-memo`，全程只 GET）：`当前生效: DeepSeek · deepseek-v4-flash` 原样；编辑表单里下拉选中值仍是 `deepseek-chat`（= `llm.providers[0].model`，**它本来就与 defaultModelId 不同步**，见下方 ⚠️），候选 4 条 + 自定义，`datalist` 计数 0。截图 `/tmp/llm-picker/*.png`。
- **id 桥接**：目录里 Anthropic 叫 `claude`（另有 `zhipuai`/`qwen`/`siliconcloud`）。不桥接，用户给 Anthropic 打开下拉会看到**空清单**。加了 4 条别名 + 一条测试「任何预设都不许是空清单」。**这是临时桥，#24 落地后应删。**
- **SHARED-CHANGE：`apps/web/vite.config.ts` 新增 `resolve.alias['@manifests'] → vendor/manifests`**（配 `apps/web/src/types/manifests.d.ts` ambient 声明）。理由与代价写在两处注释里；不这么做的话 `rootDir: "src"` 会让 tsc 报 TS6059。
- **验证**：`tsc -b apps/web` **0** · `eslint apps/web/src` **0** · 组件测试 **123 条 / 121 pass / 0 fail / 2 skip**（新增 8 条，原 3 条断言 `datalist option` 的**改成断言新控件，没有删**）· 真 Chromium 实测 5 项。
- ⚠️ **仓库级 `tsc -b` 当前是红的，不是我造成的**：`model-mgmt` 正在改 `packages/shared/src/models.ts`（删掉了 `referenceBenchmark`），`apps/daemon/src/http/rest/state.ts:326-327` 还在用它。我这一侧 `tsc -b apps/web` 是 0。
- ⚠️ **我必须报一件事**：`vite build` 会重写 `apps/web/dist`，而 **`:10000` 的 daemon 正是从这个目录托管 SPA**（`resolveWebDist()` → `apps/web/dist`）。所以**演示实例现在跑的是我这次的构建**。我**没有**重启/kill 它、没有占用该端口、没有发任何写请求（只有 SPA 自己的 `POST /api/auth/session` 握手 ×2）。19:18 那次重启不是我做的（daemon 被别人重新构建过，`builtAt` 19:18:16）。
- ⚠️ **顺带发现一处既有不一致（我没动它）**：用户库里 `llm.defaultModelId = deepseek-v4-flash`，而 `llm.providers[0].model = deepseek-chat`。**只要有人打开 DeepSeek 的编辑表单点一次「确定」，`defaultModelId` 就会被静默改成 `deepseek-chat`**（`buildLlmSettingsPatch` 在 `activeId === provider.id` 时会一起写）。这不是本次引入的，但换成下拉之后更容易被误触。**要不要在这一轮修，请你裁决。**

---

## [2026-08-03 19:35] T-126 DONE

交付:
- `apps/web/src/components/common/llm/LlmModelSelect.tsx`（**新**，两处共用的唯一模型选择器）
- `apps/web/src/components/common/llm/llm-catalog.ts`（`MODELS_BY_PROVIDER` 删除 → 吃目录；新增 `catalogProviderFor` / `catalogNoteFor` / `LLM_CATALOG_STATS`）
- `apps/web/src/components/common/llm/LlmSettingsSection.tsx`、`PurposeBindingsSection.tsx`（各自的 `<input list>` + `<datalist>` 换成 `<LlmModelSelect>`）
- `apps/web/src/types/manifests.d.ts`（**新**，`@manifests/llm-providers.json` 的 ambient 声明）
- `apps/web/vite.config.ts`（`resolve.alias`）
- `apps/web/src/app/i18n/locales/{zh-CN,en}.json`（`settings.modelPicker.*` 8 条 + `settings.purposes.inheritOptionWith`）
- `apps/web/src/test/components.test.tsx`（3 条改写 + 8 条新增 + INV-1 那条收窄选择器）

### ① 为什么默认改成真下拉，而前任的顾虑仍然被照顾

前任的注释是：*"厂商上新模型比我们发版快，写死下拉会把新模型挡在外面。"*
**这条是真的**，而且比他说的更具体：24 家里 **20 家**的模型清单是 `official-doc`
（人工从文档转录，`checkedAt` 停在 2026-04~05），**根本没有端点可调**，必然会过时。

但它把**例外做成了默认**，代价两条：

1. **与用户看到的实物不一致。** memo.ac 是纯 `<select>`，用户已经就"统一"这件事说过三次。
2. **自由输入把"没有校验"伪装成了"更灵活"。** 打错一个字符 = 一个不存在的型号，
   界面**一个字都不会说**，直到某次生成导图时失败。

所以：**下拉是默认路径，「自定义…」是下拉的最后一项**。顾虑没被否定，只是不再收全体用户的税。
另外在下拉旁写一行 `内置清单 4 个 · 核对于 2026-05-02，可能已过时` ——
**让"可能过时"看得见，比假装它永远新鲜诚实**。
（「刷新模型列表」按钮**没做**：24 家里只有 4 家有可枚举端点，一律给按钮 = 20 个按不动的按钮。
这是 D-10 #26，归 `architect`；`catalogNoteFor().refreshable` 已经把判据备好了。）

### ② 复用：两处是同一个组件，不是两份长得像的代码

用户原话「**该统一和复用的地方要统一复用啊**」。此前两处各写一遍 `<input list=…>` + `<datalist>`，
连 `data-testid` 都不一样（`llm-model-input` vs `purpose-*-model`）。
现在两处都是 `<LlmModelSelect>`，放在 `components/common/llm/`（`architect` 刚把这批文件提到这里，
符合 features 之间禁止横向 import 的 lint 规则）。**没有造第二个 picker**，
和 `architect` 上一轮 `[更换]` 复用 `AsrModelPicker` 是同一条做法。

两处唯一的差异用参数表达，不用复制代码表达：

| | 「AI 模型」 | 「按用途分别配置」 |
|---|---|---|
| 空值 | 只在还没选过时出现（同 `AsrModelPicker`） | **常驻**「继承全局（deepseek-v4-flash）」 |
| 提交时机 | `commit="change"`（写本地 state） | `commit="blur"`（每次提交都会 PATCH） |

### ③ 数据源：一份，不是两份

`modelsFor()` 的签名与调用点**一个字没改**，只把内部的数据源换掉：

```
前：前端手写的 MODELS_BY_PROVIDER（11 家 × 2~3 个 = 27 条）
后：vendor/manifests/llm-providers.json（24 家 / 520 条，catalogVersion 2026.08.03）
```

**手写清单的问题不是"少"，是它是第二份事实。** 最直接的证据就在用户自己的库里：
目录里 deepseek 的默认型号早已是 `deepseek-v4-flash`（用户配的正是它），
而手写那份只有 `deepseek-chat` / `deepseek-reasoner` —— **用户配的型号在旧下拉里根本不存在**。

**怎么进的包**：`vite.config.ts` 加 `resolve.alias['@manifests']`，配 `src/types/manifests.d.ts`
的 ambient 声明。两个理由都不是审美：
- `apps/web/tsconfig.json` 的 `rootDir` 是 `src`，相对路径 import 会 TS6059；
- ambient 声明让 **tsc 完全不去读那 253 KB JSON**（否则要为 520 条模型推字面量类型）。
它的**代价**我在文件头写清楚了：ambient 声明是**断言不是校验**，manifest 形状变了 tsc 不会发现 ——
所以运行时读取处对缺字段全部做了 `?? []` 防御，且不假设任何 provider 一定存在。

**没有新开端点**：`packages/shared/src/providers.ts` 的文件头已经把这条定死了 ——
目录是随仓库分发的静态快照，*"a dropdown that is empty because the network is blocked is
worse than one that is slightly out of date"*。

### ④ 覆盖率（这一节是本回执最要紧的一段，别读成"已接入 520"）

| | 家数 | 模型数 |
|---|---|---|
| `vendor/manifests/llm-providers.json` 里有的 | **24** | **520** |
| **实际能出现在下拉里的** | **11** | **283** |
| 够不到的 | 13 | 237 |

11 家分别是：`deepseek`(4) `openai`(30) `anthropic→claude`(14) `gemini`(14) `moonshot`(13)
`zhipu→zhipuai`(16) `dashscope→qwen`(70) `siliconflow→siliconcloud`(66) `openrouter`(30)
`ollama`(25) `lmstudio`(1)。

**为什么够不到那 13 家**：模型下拉只在"某个已配置的 provider"上下文里存在，
而「+ 添加服务商」按钮来自 `LLM_PRESETS` 的 **11 个写死预设** ——
用户**没有任何入口**添加 qianfan / azura / together / mistralai / groq / doubao / xai /
minimax / kimicodingplan / aliyun / xiaomimimo / zhipuaicodingplan / minimaxtokenplan。
那是 **D-10 #24（`LLM_PRESETS` 整体换成目录 24 家 + `bucketProviders` 三桶）**，
`architect` 明确写了「是一整块，我不想半做」。**我没碰 `LLM_PRESETS`，也没有把它做一半。**
→ #24 落地后这 13 家会**自动**有候选（`modelsFor` 已经是目录驱动的），
同时 `CATALOG_ID_ALIASES` 那 4 条桥应该一起删掉。

### ⑤ 换控件最容易丢数据的那一步（已堵死 + 已测）

`<select>` 遇到**不在 options 里**的 value 会渲染成空。用户若配的是清单里没有的型号
（自定义网关、刚上新的型号），换控件的瞬间他会看到一个空下拉，**再点一次保存就真的写空了**。

做法：**`custom` 是派生值，不是 state** ——
`custom = forcedCustom || (value !== '' && !models.includes(value))`。
值不认识就自动进自定义模式，把原值原样填进文本框。
之所以必须是派生值：候选来自 `useSettingsQuery()`，**首帧是空数组**，
若把"是否自定义"存成 state，首帧算出的 `true` 会永远卡住。

用例：`★ 值不在候选里时自动进自定义模式，绝不把它显示成空（= 悄悄丢配置）`。

### ⑥ 测试（原有的没删，改成断言新控件）

原来 3 条断言 `datalist option` 的（旧行号 1829/1850/1858）——
**都改成按 testid 定位 `<select>` 取 `option`，断言的内容一条没弱化**：

| 原断言 | 现在 |
|---|---|
| 用户填的模型必须在分档候选里 | 同左，改查 `select[data-testid="purpose-chat-model"] option` |
| 两个区块候选同源 | 同左，两边各按自己的 testid 取 |
| —— | 另加 8 条见下 |

新增 8 条：① 两处都必须是 `<select>` 且全仓无 `datalist`；② 两处必须复用 `LlmModelSelect`（读源码断言）；
③ 候选来自目录（断 `deepseek-v4-flash` 在候选里 + `LLM_CATALOG_STATS` ≥ 24/520）；
④ id 桥接 4 条 + 不在目录的回 `undefined`；⑤ **任何预设都不许是空清单**；
⑥ 「自定义…」必须是最后一项且默认不出文本框；⑦ 不认识的值自动进自定义模式且原值不改；
⑧ 真实用户配置（deepseek-chat 选中 / deepseek-v4-flash 仍生效）。

**另外收窄了一条既有用例**：`★ INV-1：按用途分档的服务商下拉 ⊆ 已配置服务商清单` 原本查
`select option`（全部 select）。T-126 之后这一栏有**两个** select，不收窄的话它会把**模型型号**
当成服务商 id 去断言 —— 断言看起来还在跑、测的却是另一件事，比直接报错更坏。已改成按
`select[data-testid="purpose-chat-provider"]` 定位。

### ⑦ 真浏览器实测（Chromium，`:10000`，全程只 GET）

| 检查 | 结果 |
|---|---|
| 「当前使用 · 语言模型」 | `DeepSeek deepseek-v4-flash` —— **原样，没丢** |
| 「AI 模型」的模型控件 | `<select data-testid="llm-model-select">`，选中值 `deepseek-chat` |
| 候选 | `["deepseek-chat","deepseek-v4-flash","deepseek-v4-pro","deepseek-reasoner","__custom__"]` |
| 全页 `datalist` 计数 | **0** |
| 三个用途档的模型控件 | 三个 `<select>`，各 6 项（继承全局 + 4 型号 + 自定义） |
| 选「自定义…」 | 文本框出现（`purpose-translate-model-custom`），提示语与占位符正确 |
| 非 GET 请求 | 只有 SPA 自己的 `POST /api/auth/session` ×2（握手），**零设置写入** |

截图：`/tmp/llm-picker/01-llm-tab.png`（全页）、`04-ai-model-select.png`、`05-purpose-custom.png`。

下一步建议:
1. **D-10 #24 归 `architect`**：`LLM_PRESETS` → 目录 24 家 + `bucketProviders` 三桶。做完那 13 家 / 237 条自动有候选，`CATALOG_ID_ALIASES` 同时删掉。
2. **D-10 #26 的「刷新模型列表」**：判据我已备好（`catalogNoteFor().refreshable`，只有 openrouter / siliconcloud / ollama / lmstudio 四家为 true）。
3. `llm.defaultModelId` 与 `llm.providers[*].model` 的双写不同步（见 TL;DR 最后一条），建议单独立项。

需要 Manager 决策:
- **`apps/web/dist` 是共享产物**：`:10000` 的 daemon 直接托管它，任何 agent 跑 `vite build` 都会换掉演示实例正在提供的前端。要不要给各 agent 规定"验证构建一律用 `--outDir` 到 `/tmp`"？（我这次是构建完才意识到，已在诚实声明里报了。）
- 上面 TL;DR 最后一条那个**点一次「确定」就会静默改掉 `defaultModelId`** 的既有缺陷，本轮修不修。

### ⑧ 我**没有提交**，请你按这份清单精确 add

写这份回执时工作区里同时躺着 **4 个 agent 的在途改动**（`ui-polish` 的令牌改名、
`model-mgmt` 的 `models.ts`/`schemas.ts`、downloader 脚本…），且仓库级 `tsc -b` 是红的。
这种状态下我提交只会把别人做了一半的东西一起带走 —— 尤其
**`LlmSettingsSection.tsx` 同时被 `ui-polish` 改过一行 className**
（`bg-accent-track/20` → `bg-accent-tint/20`，令牌已在 `tokens.css` 里存在，是好的），
我一 add 就会把他那一行拆到我的提交里。
PROTOCOL §0 写着"Manager 是唯一的合并者"，所以我把树留给你。

```
git add apps/web/src/components/common/llm/LlmModelSelect.tsx \
        apps/web/src/components/common/llm/llm-catalog.ts \
        apps/web/src/components/common/llm/LlmSettingsSection.tsx \
        apps/web/src/components/common/llm/PurposeBindingsSection.tsx \
        apps/web/src/types/manifests.d.ts \
        apps/web/vite.config.ts \
        apps/web/src/app/i18n/locales/zh-CN.json \
        apps/web/src/app/i18n/locales/en.json \
        apps/web/src/test/components.test.tsx \
        coordination/inbox/llm-picker.md
```

（`LlmSettingsSection.tsx` 那一行 className 是 `ui-polish` 的，不是我的 —— 一起进也行，
但请知道它属于他那批。）

诚实声明:
- **没有重启/kill `:10000`，没有占用该端口，没有对它发过任何写请求。** 但 `vite build` 重写了
  `apps/web/dist`，而该实例正是从这个目录托管 SPA —— **它现在跑的是我这次的构建**。这条必须算在我头上。
  19:18 的那次 daemon 重启不是我做的（`builtAt` 19:18:16，daemon 被别人重新构建过）。
- **`tsc -b`（全仓）当前红**，报在 `apps/daemon/src/http/rest/state.ts:326-327`
  （`ModelEntry` 上没有 `referenceBenchmark`）—— 源头是 `model-mgmt` 正在改的
  `packages/shared/src/models.ts`（该字段被删）。**不是我引入的，我也没去动别人的文件。**
  我这一侧 `tsc -b apps/web` 为 **0**。
- 「实际接进下拉 11 家 / 283 条」是**程序算出来的**（按 `LLM_PRESETS` 的 id 逐个过目录 + 别名表求和），不是估的。
- **`en.json` 的 8 条英文文案未经母语校对**，是我写的。
- **未提交任何东西**（理由见 ⑧）。工作区里我碰过的文件就是 ⑧ 里那 10 个，一个不多。
- 未派生任何 subagent。
- 没有改 `className`（`ui-polish` 在并行做配色），没有改 `vendor/manifests/*.json`（`model-mgmt` 在做 `speedTier`），
  没有改 `packages/shared/**`，没有改 daemon。
