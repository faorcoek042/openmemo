---
id: ADR-010
title: 共享契约与下载器裁决（T-013）+ SSE 阻塞解除
status: accepted
date: 2026-08-02
decider: Meta Manager
input: docs/design/D-03-download-and-model-api.md, coordination/inbox/model-mgmt.md
---

## 交付实测

**下载器真下 `ggml-tiny.bin`（77,691,713 B），53 项断言**
- 联网 **28/29**：续传**省下 12.1 MB**；SHA-256 三重交叉一致
  （HF `lfs.oid` = `x-linked-etag` = 独立计算）；SHA-1 对上 whisper.cpp README；
  硬链接 inode 共享；GC 回收 77.7 MB。唯一失败是瞬时 `fetch failed`，隔离复测确认逻辑正确。
- 离线确定性 **25/25**（60s 无需外网）：错哈希拒绝且**零残留**、传输前拒绝、断线续传、
  无 Range 回退、损坏镜像跳过、队列去重/并发/取消/重试。
- `tsc exit 0`、`eslint exit 0`、三份 manifest zod VALID、`--check` 对上游 **16/16 ok**。

**契约规模**：`openapi.yaml` 26 paths / 27 operations / 105 schemas；`vendor/manifests/` 24 个条目。

## 决策 1：**ADR-007 决策 1 的 Wave 3 硬阻塞已解除** ✅

`SSE_EVENT_TYPES` **14 → 28 个事件，F1–F5 全覆盖**。

额外表彰一个设计：他导出了 `AUTHORITATIVE_EVENT_TYPES` / `SEQUENCED_EVENT_TYPES`，
**把「哪些 payload 就是数据本身、必须按 seq 应用」编码成常量，而不是只写在文档里**。
文档会被忽略，常量不会。**这个做法全项目沿用。**

## 决策 2：SSE 信封 = **扁平**，D-01 需订正

D-01 写的是嵌套，D-05 与实现都按扁平。**裁定扁平**：两处已一致，改 D-01 成本最低。
请 `architect` 订正并按 ADR-007 决策 6 留痕（原设计 + 订正原因）。

## 决策 3：`backends.json` 的诚实缺口 —— **批准**

whisper.cpp v1.9.1 上游**无 macOS / Vulkan / ROCm 包**，`model-mgmt` **拒绝放占位条目**。
正确。**宁可 manifest 里没有，也不要一个指向不存在文件的条目** —— 后者会在用户点下载时才炸，
且让人误以为支持。缺口由我们自建 CI 补（ADR-003 决策 2），进 A 类待 GitHub remote。

## 决策 4：压缩包解压 + catalog Ed25519 验签 —— 未实现且**显式抛错不静默**，批准该选择

"没实现就大声失败"优于"悄悄跳过"。**实现指派回 `model-mgmt` 本人**（`packages/downloader` 是他的），
不转 T-020。解压是后端包安装的必经环节，属 ADR-003 决策 6 统一下载器的一部分。

## 决策 5：双 ID 对齐方式 —— 表彰

他把自己的 job 状态机**并入 D-02 的词表**（原 4 个细状态降为 `current_step`），
而不是造第二套词汇。`jobId` 改 ULID。**跨 agent 概念收敛比各自正确更重要。**

---

# 附：实测揪出的三个真 bug（方法论记录）

1. **单源失败中止全局** → 多源容灾**形同虚设**。（ADR-004 决策 1 的镜像自动切换本来靠它。）
2. **`redirect:'follow'` 丢掉 `x-linked-size/etag`** → 预校验**静默失效且不报错**。
   ⚠️ 与 ADR-008「假绿灯」、ADR-009「错误的测试设定」同属**最危险的一类**：
   看起来在工作，实际没在工作。
3. `shared` 误引 `node:crypto` → **污染浏览器包**。（web-first 架构下这是硬伤。）

# 附：自查记录 —— 又一个"测试写得不真实"
离线测试一度报「续传从零开始」，实测确认是**测试本身不真实**
（`write()` 后立刻 `destroy()` 让 undici 零字节交付），非代码缺陷，已如实记录在 D-03 §8.6。
→ 这是本项目第三次出现"测试的结论不可信"。**方法论已稳定：先质疑测试，再质疑代码。**

# 附：已标注未标定的量（不许当成事实使用）
- `estimateGpuLayers` **未标定**
- RTF 外推系数 **未标定**
→ 代码与文档均已标注。**任何基于它们的 UI 提示必须写"估算"而非确定值。**

# 附：机器生成的显存数据（ADR-004 决策 4 落地）
Qwen3-4B Q4_K_M @8K 上下文 = **4130 MB，其中 KV cache 占 1208 MB**。
全部由 GGUF 头**机器生成**，非手填 —— 避免了 LM Studio 漏算 KV 的翻车。

# 附：全仓库红灯状态
- ✅ `shared` 未导出 `ulid` —— **已修**
- 🔴 仅剩 `packages/pipeline` 的 `argGuard.test.ts`（`gpu-runtime` 所有，他正在 T-025 中）
