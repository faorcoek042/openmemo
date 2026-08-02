---
id: ADR-012
title: 模型/运行时管理页裁决（T-022）+ 基准数据出处规则细化
status: accepted
date: 2026-08-02
decider: Meta Manager
input: docs/design/D-03 §13, coordination/inbox/model-mgmt.md
---

## 真实链路验证（要求 2.2 已闭环）

真下 `ggml-base-q5_1`（59,707,625 B）：
```
POST /api/models/pull → 202 jobId=01KZ0KDT98V0JJS7CP53T94K17
再点一次 → deduplicated=true sameJob=true
SSE: job.created → sources.probed → job.progress(19/39/59/79/99%) → model.activated
     → model.installed → storage.changed → job.state(succeeded)
installed: integrity=ok sha256=422f1ae452ade6f3…  |  catalog: installed=true
DELETE 使用中的模型 → 409 MODEL_IN_USE + remediation
```
门禁 exit code 全 0；Zip-Slip 38/38；`verify-offline` 25/25；三份 manifest zod VALID。

## 决策 1：**`ReferenceBenchmark` 与 `benchmark` 分离 —— 批准，并细化 ADR-004 决策 3**

`model-mgmt` 遇到一个我的规则没覆盖的情况：`gpu-runtime` 实测的中文数字
（large-v3-turbo 2.7x 实时）是**有出处的真实测量**，但不是**用户本机**的测量。
他没有硬塞进 `benchmark`（语义是本机实测），而是**新建 `ReferenceBenchmark`**，
强制带出处（机器/后端/音频/时长/语言/置信度），UI 严格区分
「本机实测」vs「参考机实测，仅供参考」，且只在后端匹配时采用。

**批准，并据此细化 ADR-004 决策 3 的表述**：
> 禁止的是**编造**数字，不是禁止**有出处的测量**。
> 任何展示给用户的性能/质量数字必须能回答三个问题：**谁测的、在什么机器上测的、什么条件下测的**。
> 答不出任一项 → 不许显示。

他顺手删掉了 R-04 §9.2 原稿里的 `★★★★☆` 质量星级 —— 同样是无出处的数字。**正确。**

## 决策 2：**"本机无浏览器就不声称点通了" —— 表彰**

本机 chromium / firefox / playwright 均无，他**没有假装点过 DOM**，
改为验证构建产物被正常托管（`/models` 200）+ 组件文案确实在 shipped bundle 里（8/8 命中）。

这是本项目诚实规则的正确应用。**但验证缺口是真实的** → 见决策 5。

## 决策 3：`reference-server.mjs` 转给 `oss-scout` 照抄进 `apps/daemon` —— 批准

`apps/daemon` 目前**一个业务 endpoint 都没有**，`model-mgmt` 为了真跑链路
在自己领地写了 `reference-server.mjs`（同一份 shared 契约 + 真实下载器 + 真实 manifests + 真实 fitness）。

**这不是重复劳动，是把接口跑通了再交接。** 指派 `oss-scout` 照抄进 `apps/daemon`，**别另起炉灶**。

## 决策 4：ADR-011 的三条已落地，验收通过
1. `lang=zh` → base/small/tiny/medium 默认隐藏 + 说明「会把维基百科听成危机摆科」+ **可一键解除**；
   `lang=en` → base 恢复 `recommended`。**改的是默认值不是能力**，符合裁决。
2. **Zip-Slip 38/38 带真实攻击用例**：`../evil.txt`、POSIX/Windows/UNC 绝对路径、tar 真实 symlink、
   条目数/字节数上限、**谎报体积的 zip bomb**。攻击后 destDir 外零文件、symlink 从未创建。
   诚实限制：不支持 ZIP64，**检测到即报错不静默**。
3. `FitResult` 加 `speedTier`/`speedSource`，large-v3-turbo 标 **23 分钟/小时**并入 `reasonZh`
   → **"装得下"不再被读成"体验好"**。这正是我要的。

## 决策 5：浏览器 E2E —— **不进待环境清单，先尝试自己装**

`model-mgmt` 建议把"无浏览器"列入待用户提供环境。**我不同意就这样上报**：
本机是 Linux + 有网 + 磁盘 16 GB 可用，`playwright install chromium` 有很大机会直接成功。
**在向用户要资源之前，先自己试一次。** 指派 `model-mgmt` 尝试；装不上再进清单，并附真实报错。

理由：要求 2.1 / 2.2 的核心是"用户在网页上点几下"，而**至今没有任何一次真实的点击被验证过**。
这是当前最大的验证缺口，值得花一轮去关。

## 决策 6：Ed25519 验签已实现但生产未启用（无密钥），**供签名却无密钥时失败关闭绝不放行** —— 批准

"没有密钥就拒绝，而不是跳过验签"是正确的失败方向。

## 决策 7：i18n 统一 —— 排在 `architect` 的 locales 落地之后
`model-mgmt` 的两个 feature 目前用内联中文。不返工，等 T-021 的 i18n 基础设施就位后统一抽取。
