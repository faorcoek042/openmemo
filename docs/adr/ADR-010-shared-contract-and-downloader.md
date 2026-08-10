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
不转 T-020。~~解压是后端包安装的必经环节，属 ADR-003 决策 6 统一下载器的一部分。~~

> **解压那半仍然成立且已落地**（`packages/downloader/src/unpack.ts`，53 条安全断言在
> `scripts/verify-unpack.mjs`）。**被推翻的是 catalog 验签那半 —— 见文末 §附-A（2026-08-07）。**
> 本决策原文不许删，留作可追溯。
>
> ⚠️ **2026-08-10 追加**：§附-A 结尾"验签函数本身：保留……未执行，等用户看到证据后
> 再裁"已经有了后续 —— 见文末 §附-B。`verifyCatalogSignature` 现在有了第一个生产
> 调用方，但**不是**把 §附-A 删掉的那族远端加载器接回来，那族仍然是死代码。

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

---

# 附-A：决策 4 的「catalog Ed25519 验签」那半被推翻（2026-08-07）

**何时**：2026-08-07，T-171。
**被谁**：**用户本人**在 T-171 任务书里直接裁定（原话："上一位倾向删但没删……**现在我裁：删**"）。
不是 agent 自作主张：PROTOCOL §1 把 `docs/adr/**` 划给 Manager，本节由 agent 就地写，
**用户在同一份任务书里明确授权了这次就地改**（"我授权你这次就地改——原文用删除线保留，不许删原文"）。
做法照抄 ADR-003 §7.6 的先例。

**依据什么推翻**（用户给的三条理由，逐条抄录）：

1. **一个从未被调用、也没有任何测试的加密验签函数，"经过审查"是错觉。**
   留着它的最大风险不是它有 bug，是**下一个人会以为目录是被验签的** ——
   而今天目录的实际保障是编译期 host 白名单 + 强制 sha256，完全是另外两件东西。
2. **今天没有功能损失**：用户没有安装包、靠 `git pull` 更新，目录随仓走。
3. **将来真要做远端目录，应该对着那时候的约束重新设计**，而不是复活一份两个月没动过、
   从未运行过的实现。**git 历史留着它**（删除前 HEAD `26fdd1f`）。

## 实际执行到什么程度：**删了一半，另一半被证据挡下**

⚠️ **这一节记录的是真实发生的事，不是被下达的事。** 两者不同，差别必须留痕。

### 删掉了（零调用方，已核实）

`packages/downloader/src/manifest.ts` 里的三层降级远端目录加载器整族：

| 符号                                                      | 性质                               |
| --------------------------------------------------------- | ---------------------------------- |
| `loadManifest`                                            | 含全仓**唯一**一处取目录的 `fetch` |
| `loadModelManifest` / `loadBackendManifest`               | 它的两个出口                       |
| `LoadManifestOptions` / `LoadedManifest` / `ManifestTier` | 只为它们存在的类型                 |
| `CATALOG_TTL_MS` / `STALE_AFTER_MS`                       | 只为它们存在的常量                 |
| `readJson` / `fileAgeMs`                                  | 只为它们存在的私有辅助             |

`[T-171 实测]` 逐个核过调用方：全部**零生产调用方、零测试**，仅有同文件自引用 +
markdown 提及 + 基线 JSON 条目。棘轮基线随之 **72 → 70**（`loadBackendManifest` /
`loadModelManifest` 两条移除）——**只降不升，规矩没有被绕过**。

### 没有删：`verifyCatalogSignature`（**它有真实调用方**）

用户在同一份任务书里立了一条硬约束：**"你要拒绝删任何有真实调用方的东西，并回报给我"**
（本仓栽过一次：`toMarkdown` 有 daemon 调用方却被删，导出 500）。这条约束在这里触发了。

`[T-171 实测]` `packages/downloader/scripts/verify-unpack.mjs`：

- `:50` `const { verifyCatalogSignature } = await import(path.join(dist, 'manifest.js'));`
- `:584 :587 :591 :596` 四处实调用，第 9 节共 5 条断言
- 第 8 节另有 8 条断言调用 `signature.ts` 的三个导出

**对照组实测（删改之前跑的）：`53 passed, 0 failed`**，其中
`PASS  verifies correctly once a key IS supplied` —— 是拿**真实生成的 Ed25519 密钥对**
验一个**真签名**。

> **所以用户裁决理由 #1 的事实前提不成立**：这个函数**不是**"从未被调用、没有任何测试、
> 从来没有对着一个真实签名跑过"。它被调用、有 13 条断言、跑过真签名。
> 理由 #2（今天没有功能损失）与 #3（将来重新设计）**不受影响，仍然成立**，
> 所以远端加载器那族照删。

**爆炸半径（这是不删的决定性理由）**：`:50` 是**顶层 await 动态 import**。删掉 `manifest.ts`
→ `dist/manifest.js` 消失 → 该脚本在**模块加载阶段**就 `ERR_MODULE_NOT_FOUND` →
**整份脚本全挂，不只是第 9 节** → **53 条解包安全断言（zip-slip、绝对路径、软链逃逸、
zip 炸弹限额、可执行位保留）一起死**，而那正是 `docs/SECURITY.md:453` 与 `ADR-015:44`
引为「已实现」的证据来源。

**为什么门禁不会替你拦下来**：`scripts/check-orphan-exports.mjs:112` 的文件过滤是
`/\.tsx?$/` 且限定 `^(apps|packages)/[^/]+/src/` —— **`.mjs` 结构性地不在扫描范围内**。
所以基线把 `verifyCatalogSignature` 记成"孤儿"是**扫描器口径下的孤儿，不是真孤儿**。
基线 note 已就地订正（它此前写着"零单测"，那是错的）。

### 结论：本决策"catalog Ed25519 验签"部分的今天状态

- **远端目录这条线：明确不做 v1**，实现已删，git 历史留档。→ 这半**已推翻并执行**。
- **验签函数本身：保留**，因为它是 `verify-unpack.mjs` 的被测对象之一，且该脚本还承载
  53 条解包安全断言。→ 这半**未执行，等用户看到上面的证据后再裁**。
- 若用户看过证据仍要删，**正确切法是**：把 `verifyCatalogSignature` 并进 `signature.ts`、
  同步改 `verify-unpack.mjs:50` 的 import、再删 `manifest.ts` ——
  **绝不能只删文件了事**。

⚠️ **另一条没闭的**：`verify-unpack.mjs` 自己**没有任何自动调用方**（不在任何
`package.json` scripts、不在任何 workflow）。所以上面那 13+53 条断言"有人手敲才跑"。
这是一条独立的欠债，T-171 没动它。

---

# 附-B：§附-A 结尾"验签函数保留待裁"的裁决落地（2026-08-10）

**何时**：2026-08-10，D-20 §17（"检测更新"实现）。
**被谁**：本次任务在任务书里明确要求补写这一节（"ADR-012 决策 6 与 ADR-010 §决策4订正
需要'被取代'文档说明"），承接的是 §附-A 结尾悬置的那句"验签函数本身：保留……未执行，
等用户看到上面的证据后再裁"——这是那次悬置的后续，不是 agent 就地另起的新决定。
**依据什么**：D-20 §11.3 早就写好了接回远端目录必须满足的三条前提（签名+客户端钉死
公钥 / 验不过回退到包内那份 / 不许改已内置项的 sha256），§11.4 当时承认"上述任何代码
都没写"。本次是把这三条从设计写成代码，第一次让 `verifyCatalogSignature` 有生产调用方。

## 实际执行到什么程度

### 没有做的（§附-A 划的线，原样守住）

- **§附-A 删掉的那族远端加载器**（`loadManifest` / `loadModelManifest` /
  `loadBackendManifest` 及其专属类型/常量/私有辅助）**没有复活**，git 历史里躺着。
  本次新写的是另一条独立的调用链（`catalogUpdate.ts` → `apps/daemon/.../updates.ts`），
  不经过、也不依赖那族被删的代码——两者是平行的两件事，不是"把删掉的接回来"。
- 生产环境目前仍然**没有**真实远端目录可问（`OPENMEMO_CATALOG_UPDATE_URL` 未设），
  今天线上行为是诚实返回 `source: "not-configured"`，不是"现在真的会去下载/验证"。

### 做了的

- `manifest.ts` 的 `verifyCatalogSignature` 默认参数改为走新函数
  `resolveConfiguredCatalogPublicKey()`（`signature.ts`：环境变量覆盖 > 编译期默认值，
  与 `OPENMEMO_MANIFEST_DIR` 等既有套路一致）。**默认值本身没变**——CI/生产不设该
  环境变量时取值与改动前完全一致，仍是 `null`；`verify-unpack.mjs:706`
  "默认必须是 `OPENMEMO_CATALOG_PUBLIC_KEY === null`"那条断言未受影响，实测仍通过。
- 新增 `verifyCatalogSignatureSafe()`（fail-closed 但不抛异常）与全新文件
  `catalogUpdate.ts`（编排：host 白名单 → 拉取 → 验签 → 解析 → §11.3 前提 3 的
  钉死项完整性比对 → 求 diff），把 `verifyCatalogSignature` 接进了第一个、也是
  唯一一个生产调用方 —— `apps/daemon/src/http/rest/updates.ts` 的
  `GET /api/updates/check`。至此"生产调用方零"这句话不再成立。
- §附-A 记录的 13 条验签断言此前"结构上不可能让 CI 变红"（`verify-unpack.mjs`
  零自动调用方，这条本身仍然真实——脚本没有被接进任何 workflow）。本次新增
  `signature.test.ts` / `manifest.test.ts` / `catalogUpdate.test.ts`
  （`packages/downloader/src/`），编译进 `dist/**/*.test.js` 后被
  `pnpm -r test`（`.github/workflows/ci-crossplatform.yml:106`，三平台都跑）
  自动发现执行 —— **首次让这条验签逻辑具备"改坏了会被 CI 拦下"的能力**，
  不依赖任何人手动跑 `verify-unpack.mjs`。`verify-unpack.mjs` 本身未删、
  未改其模块形状，§附-A 记录的"删 `manifest.ts` 会带走 53 条解包安全断言"那条
  爆炸半径警告依然适用，本次没有触碰那份脚本。
- `[实测]` `pnpm --filter @openmemo/downloader build && pnpm --filter
@openmemo/downloader test` → 82 个用例（含上面新增的 17 个）**全部通过，0 失败**。

完整实现细节、三条前提各自的代码落点、CI 覆盖范围、给用户的密钥生成/签名命令，
见 `docs/design/D-20-bundled-deps.md` §17。
