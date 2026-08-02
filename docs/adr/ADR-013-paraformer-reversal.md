---
id: ADR-013
title: Paraformer 推翻 ADR-011 决策 2 + T-021/T-023 裁决
status: accepted
date: 2026-08-02
decider: Meta Manager
input: D-06 §15-§19, docs/SECURITY.md §2.2, T-021/T-023 回执
supersedes: ADR-011 决策 2
---

## 0. **Manager 更正：ADR-011 决策 2 作废**

我上一轮基于「中文必须用 large-v3-turbo，而它在 CPU 上只有 2.7x 实时」，
把 NVIDIA 机器上调为**唯一一个"缺硬件会实质影响产品可用性"的事项**，并如此上报用户。

`gpu-runtime` 本轮实测**推翻了这个前提**（他自己的话："这推翻了我上轮结论的一半"）：

| 同一段 `Zh-Twitter.ogg` 337s / 同一 VAD 切分 / 同一台无 GPU 机器 | whisper base | **paraformer-zh-small + 标点** | large-v3-turbo-q5_0 |
|---|---|---|---|
| 体积 | 148 MB | 357 MB | 547 MB |
| **合计 RTF** | 0.055（18x） | **0.0119（84x）** | 0.377（2.7x） |
| **1 小时录音耗时** | 3.3 分钟 | **43 秒** | **22 分钟** |
| 专有名词命中 | ~2/13 | **12/13** | 13/13 |
| 阿拉伯数字 / 词级时间戳 | ✅ / ✅ | ❌ / **❌** | ✅ / ✅ |

**Paraformer 比 turbo 快约 32 倍，专有名词 12/13。**
→ **无显卡的中文用户可以拿到 84x 实时。GPU 不再是中文可用性前提。**

**处置**：`PENDING-USER-DECISIONS.md` 的 A-2 从"最高优先级"**降回普通**。
GPU 仍值得做（英文 large 模型、LLM 推理、未来更大模型），但**不再是产品可用性的门槛**。

**教训（针对我自己）**：我在只有一个候选的实测数据时就把结论上报为"硬约束"。
`gpu-runtime` 当时的数据是对的，我的**推论过度**了——正确的做法是先问
"有没有别的引擎"，而不是直接把资源需求上报给用户。**这是本项目第二次由我造成的过度推论**
（第一次是 ADR-011 §0 的 TD-002 过早关闭）。

## 决策 1：中文离线默认引擎 = **Paraformer**，F5 中文降级为段级高亮

43 秒 vs 22 分钟是 30 倍差距，压倒性。但必须**如实暴露代价**：
- **无词级时间戳** → F5 中文**降级为段级高亮**，UI 明确说明，不假装。
- 无阿拉伯数字、英文全小写 → 同样标注。
- **用户可一键切到 large-v3-turbo** 换取词级时间戳 + 数字 + 13/13，代价是 22 分钟/小时。

这是一个真实的取舍，**让用户知情选择，而不是替他选了还不告诉他**。

## 决策 2：**「LLM 永远不产出时间戳」定为全项目规则**

`oss-scout` 的设计：只让 LLM 回段落编号，**时间与 quote 由我们从真实转写稿算**。
他写了测试喂"故意编造 `startMs=999999999` 和假 quote"的输出，断言其被**完全忽略**。

→ 这使 D-02 §3.5 第 2 层重定位**不可能失效**。
**推广为通则：LLM 的输出只能作为「指针」，不能作为「事实来源」。** 事实必须来自我们自己的数据。

## 决策 3：时间单位统一为 **整数毫秒** —— 采纳 `architect` 的建议

D-02 定整数毫秒，`shared` 的 SSE 用浮点秒。他已在边界做转换兜住，功能无碍。
但"同一概念两种单位"是长期 bug 温床。**裁定 SSE 也用整数毫秒**，指派 `model-mgmt`。

## 决策 4：补齐 `shared` 缺的事件与字段 —— 批准，指派 `model-mgmt`
- `x.transcribe.replaced`（F3 三个数字的唯一来源，后端已能算出）—— **不可选**
- `x.media.asset.ready`（波形异步生成，没它 F5 时间轴画不出来）—— **不可选**
- `transcribe.segment` / `partial` **补 `noteUid`** → 可删掉 `architect` 现有的映射适配层

## 决策 5：模型目录标注 `<2B 可能内容重复` —— 批准，指派 `model-mgmt`

`oss-scout` 实测（同稿同流水线只换模型）：**0.6B 重复率 43.3%（×9 复读同一句）→ 1.7B 9.1%**。
**schema 校验拦不住语义垃圾** —— 这是选型信息，用户有权知道。

## 决策 6：`json_object` 不是强约束 —— 写入实现规范

实测 llama-server + Qwen3 用 `json_object` 会返回**带 markdown 围栏的文本**，`JSON.parse` 直接失败。
**只有 `json_schema` 是语法级约束。任何档位都必须走鲁棒提取。**

## 决策 7：`oss-scout` 对 ADR-011 ② 的更正 —— 接受
`packages/db` **并非"尚无 schema"**，T-016 就落了 26 表 57 索引，`edited_at`/`text_raw` 从一开始就在。
是 `gpu-runtime` 的信息过期、我未核实即转述。本轮已实跑验证完整契约（未编辑判定 / `text_raw` /
`is_active` 多版本切换+回退 全 ✅）。

## 决策 8：越界申报全部追认
`architect` 的 `apps/web/package.json` 加 4 依赖（ADR-011 决策 3 后已合规）+ 根 `eslint.config.js`
加三段规则（纯新增）；`gpu-runtime` 加 `sherpa-onnx-node`（已授权）。

---

# 附：本轮三个"防护在 A 路径有效就以为 B 路径也有效"的实例

1. **`gpu-runtime` 查出自己的漏洞**：本地 `.m3u8` 导入可越过受管根目录 ——
   **协议白名单救不了，因为播放列表用的是我们故意启用的 `file` 协议**。
   他自己指出这与 ADR-011 §0 的 TD-002 假绿灯**同构**。
2. **`gpu-runtime` 的金丝雀教训**：第一次用 `.txt` 做恶意 HLS 测试，
   挡住它的其实是 **ffmpeg 自己的 `allowed_segment_extensions`**，不是我们的白名单。
   换 `.ts` 才隔离出真正起作用的层。**"挡住了"不等于"是我们挡住的"。**
3. **`oss-scout` 的修复无效**：`extractJson` 的"误导性错误"bug，
   **第一次修时他把检测放在了内层扫描之后，等于没修** —— 顺序反了不会让任何用例变红，
   是他自己写的断言逼出来的。

# 附：安全实测（真实攻击验证）
恶意 HLS 三变体（`file:` / `concat:` / `subfile:`）：
对照组 `Opening 'file:///tmp/attack/secret.ts' for reading`（**攻击真实成立**）
→ 我们的白名单 `Protocol 'file' not on whitelist!`（**全挡住**）。HLS 真实 VOD 60s 端到端通过。

# 附：`architect` 的两条实战验证
1. **§3.4 反冲突设计已被实战检验**：T-022 并行落地 models/runtime 两个 feature，
   只在 `routes.tsx` 和 `bindings.ts` 各加 1 行 import + 1 个数组项，**零冲突零协调**。
   从"我认为可行"变成"已经这么发生过"。
2. **真实 DOM 渲染抓到纯读代码看不出的 bug**：`approxEta()` 自带"about/约"前缀，
   套进模板渲染成 `about about 22 min`。**这就是不满足于 curl 的理由。**

# 附：全仓库状态（Manager 亲自核实）
`pnpm -r build` **9/9 全绿，EXIT=0**（首次）。测试 118 pass + 104 pass + 76 pass。
`architect` 报告的 `packages/llm` 构建失败已被 `oss-scout` 同轮修掉，**我跑过确认，未转述过期信息**。
