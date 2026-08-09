# 那两份清单该不该收敛 —— `backends.json` vs `components.json`

## 先答最要紧的那句

**审计时（修复前）两份清单已经有 4 个 id、8 处字段不一致**（`backends.json` vs
`components.json`；若把同一条守卫本来就一起查的第三份 `sqlite-ext.json` 也算进来，
是这 4 个 id 的全部字段，没有别的 id）。**全部是 `displayName`/`displayNameZh`
的措辞漂移，不是 license/尺寸/摘要——那三类字段全仓 23 对逐一核对，0 处不一致。**
4 处已在本轮直接修复并提交（见下方"发现的缺陷与修复"），不等这份文档的结论。

判据：Manager 给的门槛是"抽象要么减少下一次犯同一个错的概率,要么不值得做"
（`abstraction-audit.md`），今天不是问"该不该抽一个类型",是问"该不该合两个文件"——
门槛不变,只是把"形状"换成"数据"。**结论先说:不合并,把已经存在、已经在跑、已经
证明会红的那条守卫扩到 license 与展示名两个字段上。** 别默认"合并就是对的"——下面
逐条给理由。

---

## 1. 字段逐一列（不概述）

`backends.json`：`{schemaVersion, catalogVersion, generatedAt, packs: [...]}`，14 条。
`components.json`：`{schemaVersion, catalogVersion, generatedAt, note, components: [...]}`，
25 条（另有 `sqlite-ext.json` 的 10 条 sqlite 扩展包，同一套 pack 形状，被同一条守卫
一起核对，不算进 `backends.json` 头上）。

### 两边都有的字段（⇒ 有漂移风险，逐个核对过）

| 字段 | `backends.json`（每个 pack） | `components.json`（每个 component） | 本轮核对结果 |
| --- | --- | --- | --- |
| id | `id` | `id` | 用于配对，见下"覆盖面" |
| 展示名（英） | `displayName` | `displayName` | **4 处不一致，已修**（见下） |
| 展示名（中） | `displayNameZh` | `displayNameZh` | **4 处不一致，已修**（见下） |
| 许可证 id | `license.id`（结构化对象，含 `gated`/`requiresAcceptance`） | `provenance.license`（纯字符串） | 23 对全部一致（含本次一并核对的 CUDA/ytdlp 历史修复） |
| 许可证链接 | `license.url` | `provenance.licenseUrl` | 23 对全部一致 |
| 体积 | `totalSizeBytes`（= `files[].sizeBytes` 之和，单文件包时等于该文件大小） | `sizeBytes` | 23 对全部一致（已有守卫，见下） |
| 摘要 | `files[].sha256` | `sha256` | 23 对全部一致（已有守卫，见下） |
| 版本号（近似同义，字段名不同） | `engineVersion` | `pinnedVersion` | **不是同一个字段名**，语义大多数时候相同（如 `v1.9.1`），但 ffmpeg 系两条不同义：`engineVersion` 记 ffmpeg 自身版本串（如 `n8.1.2-34-g9b6c8969e0`），`pinnedVersion` 记上游 release tag（如 `autobuild-2026-07-31-14-10`）——**这不是 bug，是两个不同的事实碰巧放在长得像的位置**，`ffmpegStableOnly.test.ts` 已经单独为 `media-tools-macos-arm64` 这一条钉了"两边说的是同一个版本"的等价断言（处理 `v` 前缀），但**只钉了这一条，不是全部 id**——留作观察，不在本轮范围（不是"两份清单矛盾"，是"字段命名容易看错"，见下文第 4 节的"留观"）。

### 只在 `backends.json` 里的字段（⇒ 真正各管各的，不是重复）

`schemaVersion`（单条）、`engine`、`ggmlAbi`、`backend`、`tier`、`os`、`arch`、
`files[].{role,name,unpack,mirrors[].{provider,url,official}}`、`requiresDriver`、
`providesFiles`、`priority`、`benchmark`、`availability`、`catalogVersion`（单条）。
—— 全部是"装哪个包、装到哪、装完该有什么文件"这类**操作性**字段，
`components.json` 结构上没有对应槽位，也不需要有。

### 只在 `components.json` 里的字段（⇒ 真正各管各的，不是重复）

`category`、`provenance.{repoUrl,releaseUrl,submodulePath,submoduleCommit}`、
`upstream.{kind,repo,stableOnly,tagPattern,stableOnlyReason}`、`sha256Provenance`
（长文本取证记录）、顶层 `note`。—— 全部是"这东西从哪来、上游是谁、要不要检查更新"
这类**溯源/展示性**字段，`backends.json` 结构上没有、也不需要有。

**此外**：`components.json` 有 11 条 id（`libsimple-*` ×6、`sqlite-vec-*` ×4、
`sherpa-onnx-node`、`asr/whisper-large-v3-turbo-q5_0`）在 `backends.json` 里根本不存在
——因为它们不是"平台原生下载包"（sqlite 扩展在 `sqlite-ext.json`，sherpa-onnx 走 npm，
模型走 huggingface），`backends.json` 的 pack 形状（`os`/`arch`/`mirrors`/`unpack`）结构上
装不下这几类。**`components.json` 的覆盖面比 `backends.json` 严格更宽**，这是"两者不能
简单合并成一份"的第一条硬证据——合并意味着要么给这 11 条硬塞不适用的 pack 字段，
要么把 schema 拆成"此字段仅当 category=xxx 时存在"，两者都比现状复杂。

---

## 2. 两份清单现在有没有已经矛盾（本轮实测，不是复述）

**方法**：不是靠对名字，是把两个文件都读进来，按 `id` 配对，逐字段 `===` 比较，
覆盖 `backends.json`（14 条）+ `sqlite-ext.json`（10 条）× `components.json`（25 条），
共配上 23 对（2 条 `pending-ci` 的 whisper.cpp 包——`whispercpp-vulkan-win-x64` 与
`whispercpp-metal-macos-arm64`——尚未发布，`components.json` 里本来就查不到，
这是既有测试早就承认的正常状态，不算矛盾）。

**结果（修复前）**：

| id | 字段 | `backends.json`/`sqlite-ext.json` | `components.json` |
| --- | --- | --- | --- |
| whispercpp-cpu-linux-x64 | displayName | `whisper.cpp — CPU (Linux x64)` | `whisper.cpp CPU backend (Linux x64)` |
| whispercpp-cpu-linux-x64 | displayNameZh | `whisper.cpp · CPU 后端（Linux x64）` | `whisper.cpp CPU 后端（Linux x64）` |
| whispercpp-vulkan-linux-x64 | displayName | `whisper.cpp — Vulkan (Linux x64)` | `whisper.cpp Vulkan backend (Linux x64)` |
| whispercpp-vulkan-linux-x64 | displayNameZh | `whisper.cpp · Vulkan 后端（Linux x64）` | `whisper.cpp Vulkan 后端（Linux x64）` |
| libsimple-linux-x64 | displayName | `libsimple — Chinese FTS5 tokenizer (linux/x64)` | `libsimple Chinese FTS5 tokenizer (Linux x64)` |
| libsimple-linux-x64 | displayNameZh | `中文分词器 libsimple（linux/x64）` | `中文分词器 libsimple（Linux x64）` |
| sqlite-vec-linux-x64 | displayName | `sqlite-vec — vector search (linux/x64)` | `sqlite-vec vector search (Linux x64)` |
| sqlite-vec-linux-x64 | displayNameZh | `向量检索 sqlite-vec（linux/x64）` | `向量检索 sqlite-vec（Linux x64）` |

**规律**：全部 4 个漂移的 id 都是 **`-linux-x64` 这一个平台变体**；其余全部 19 个
（其中包括同一批 `libsimple-*`/`sqlite-vec-*` 的其他平台变体）都已经是"新版式"
（em-dash + 小写 os/arch）。可以合理推断：`components.json` 里这 4 条是最早写的那批，
后来展示名统一改版式时，`backends.json`/`sqlite-ext.json` 跟着改了，`components.json`
这 4 条被漏掉——**与 ytdlp 那次"改一份漏另一份"是同一个故障模式，只是这次是措辞不是
法律事实**。license/size/sha256 **零处**不一致——说明已有的那条体积摘要守卫
（见第 3 节）确实在起作用，只是它没有覆盖 license 与展示名这两类字段。

**已直接修复**（这轮允许的例外：发现真矛盾就地修，单独提交）：
把上面 4 个 id 的 `displayName`/`displayNameZh` 在 `components.json` 里改成与
`backends.json`/`sqlite-ext.json` 一致（后者的版式是全仓 19/23 已经在用的那个，
判定为"当前标准"）。修复后重新跑同一个脚本核对：23 对、0 处不一致。

---

## 3. 谁在真的读这两份文件（不是"理论上应该读"，是 grep + 读源码确认的）

### `backends.json`

- **`packs[].files[].{sha256,sizeBytes,mirrors}`**：**活的、操作性的读者**。
  `apps/daemon/src/http/rest/backends.ts` 的 `startPackInstall()` 用它做真实下载/
  断点续传/校验；`apps/daemon/src/http/rest/components.ts` 的"更新组件"动作
  （`POST /api/components/:id/update`）**同样调用 `startPackInstall()`**——也就是说
  组件页点"更新"，实际下载校验用的字节来源始终是 `backends.json`，不是
  `components.json` 里的 `sizeBytes`/`sha256`。另外 `scripts/ci/dependency-audit.mjs`
  用它做"是不是现场下载、有没有钉版本、有没有 sha256"的静态审计（CI 门禁）。
- **`packs[].license`（结构化对象 `{id,gated,url,requiresAcceptance}`）**：
  **实测零读者**。逐处确认：
  - `apps/daemon/src/http/rest/backends.ts`/`backendReconcile.ts`——grep `\.license\b`
    零命中；不存在针对 backend pack 的 gating 逻辑。
  - `apps/web` 全仓——`.license` 只在两处出现：`ModelsPage.tsx`/`ModelDetailPage.tsx`
    （读的是**模型目录**的 `license`，与 `backends.json` 的 pack 是两个完全不同的
    manifest/端点）和 `components.json` 一侧的 `provenance.license`。`RuntimePage.tsx`
    （backend pack 在网页上唯一的展示位）不读 `pack.license`。`surfaces.ts`（API 类型
    表面）里连 "license" 这个词都没有。
  - `scripts/license-report.mjs`：文档注释写着"C 类运行时下载物 → manifest 的
    license 字段"，**意图**读它，但**实现有独立于本任务的 bug**——`collectManifests()`
    把整份 JSON 当成一个 item 处理（`Array.isArray(json) ? json : [json]`），从不下钻
    `.packs[]`/`.components[]`，本仓 7 个 manifest 文件没有一个是数组、也没有一个有
    顶层 `.license`，所以这段代码对**每一份** manifest 都恒定输出 `license: 'UNKNOWN'`
    ——**这不是"没人读"，是"写了个读者但读错了地方"，是另一处缺陷，不属于两份清单
    互相矛盾，本轮不修（不是 `backends.json`/`components.json` 之间的事），单独报给
    Manager 定去处**。
  - `gated`/`requiresAcceptance` 这套机制本身**是活的**——但只服务于模型目录
    （`ModelsPage.tsx:205`、`apps/daemon/src/http/rest/models.ts:348`），
    与 `backends.json` 的 pack 完全无关。
  - 结论：`pack.license` 字段**在今天的产品里是死数据**——但性质与"零调用方，直接删"
    的 `loadManifest`/`verifyCatalogSignature` 先例不同：那两个函数是真的没人管；
    这个字段有**明确写下来的意图**（license-report.mjs 的注释、`BINARY_PAYLOAD_LICENSES`
    数组旁的大段注释都说"许可证记在 backends.json 的 license 字段里"），只是**唯一
    该读它的脚本坏了**。不建议删字段，建议修 `license-report.mjs`（另一个任务）。

### `components.json`

- **`provenance.license`/`licenseUrl`**：**活的、用户直接看到的读者**。
  `ComponentCard.tsx`（组件卡片展示"许可证 {c.provenance.license}"）与
  `ComponentsPage.tsx`（安装/更新前 `window.confirm()` 弹窗文案里直接拼
  `` `许可证：${c.provenance.license}` ``）。**这正是当初 CUDA 包被标成 MIT
  会让用户看到假信息的那条路径。**
- **`sizeBytes`/`sha256`**：读者是 `ComponentCard.tsx`（展示体积、判断"是否可下载"
  的布尔条件 `c.sha256 !== '' && c.sha256 !== 'n/a' && c.sizeBytes > 0`），**只用于展示
  与前端判断，不用于真正校验下载字节**——真正的字节校验永远走 `backends.json` 的
  `files[].sha256`（见上）。这意味着：就算 `components.json` 的 `sizeBytes`/`sha256`
  与实际不符，**不会**导致装错文件，只会**显示错的数字**——虽然仍是缺陷，但爆炸半径
  比我最初设想的小。
- **`category`/`submodulePath`/`submoduleCommit`/`upstream.*`/`sha256Provenance`**：
  各自有独立、真实的读者：`category` 驱动 `rollbackKindOf()` 的回滚路由；
  `submodulePath`/`submoduleCommit` 由 `ComponentCard.tsx` 直接展示；`upstream.*` 喂给
  `packages/downloader/src/upstream.ts` 的"检查更新"逻辑；`sha256Provenance` 展示取证
  长文本。——这些字段**没有** `backends.json` 对应物，也**不应该有**：它们回答的是
  "这东西从哪来、能不能查到新版本"，`backends.json` 回答的是"往哪下载、装完该有什么
  文件"，两个问题结构不同。

### Schema 校验的不对称（也是不建议合并的一条理由）

`backends.json` 有 `BackendManifestSchema`/`BackendPackSchema`（`.strict()` zod 校验，
`packages/shared/src/schemas.ts`），`platformPacks.test.ts` 第一条测试就是
"backends.json 通过 schema 校验"。**`components.json` 没有任何 zod schema**——
`packages/downloader/src/components.ts` 的 `loadComponentRegistry()` 只做
`JSON.parse(...) as ComponentRegistry`（裸类型断言）+ 一句手写的
`schemaVersion === 1 && Array.isArray(components)` 检查。合并成一份文件意味着要么
给 `components.json` 现在没有的 11 类字段（`category`≠pack 的字段）也套上 `.strict()`
——工作量不小且这轮以外的范围，要么放弃 `backends.json` 现有的强校验，两者都不是
"顺手合并"能达到的效果。

---

## 4. 结论：不合并，扩现有守卫；`engineVersion`/`pinnedVersion` 留观不动

**判断（对照 `abstraction-audit.md` 的门槛）**：

- **不合并**。理由不是"怕麻烦"，是三条独立的结构性证据都指向"这是两个不同问题域，
  只是共享了几个事实"：① `components.json` 覆盖面比 `backends.json` 宽（11 条 id
  结构性装不进 pack 形状）；② 两者的读者群体不同且互不替代（`backends.json` 喂操作
  逻辑+CI 审计，`components.json` 喂用户可读的展示/确认文案+更新检查）；
  ③ schema 校验制度不对称（一份 `.strict()`、一份裸断言），合并前必须先解决这个落差，
  这本身就是一次范围之外的重构。这与 `abstraction-audit.md` ③"对照组先行"的结论
  同构：**形状相似不等于可以共用代码**，这里是"字段名相似不等于该塞进一个文件"。
- **该做的是"加守卫"，而且这条守卫不是要新发明的**——`platformPacks.test.ts` 里
  T-146③ 那个 describe block**已经存在、已经在跑、这次修复前后都实测通过**：
  第一条守 id 覆盖面（"每个可下载的包都在 components.json 里查得到"），第二条守
  `sizeBytes`/`sha256` 相等，且用 `checked >= 15` 防"零个也算通过"的假绿——这正是
  Manager 提到的"21 条守卫会不会真的红"那类风险的**反例**：它不是靠"编译产物里找
  源码文本"钉的，是直接读两份 JSON 做值比较，机制上不存在"锚点漂移但测试不知道"
  的问题。
- **本轮做的**：在同一个 describe block 里加第三条测试，把 `license.id`/`license.url`
  与 `displayName`/`displayNameZh` 也纳入同样的"逐 id 相等 + `checked >= 15`"检查——
  与既有两条**同一个模式、同一个文件、同一套写法**，不是另起一条新机制。
  **已反向验证**：本机把 `whispercpp-cpu-linux-x64` 的 `provenance.license` 从 `MIT`
  改成 `Apache-2.0`（临时改在磁盘副本上，跑完立即用原文件复原，未提交），
  重跑 `npx tsx --test src/pipeline/platformPacks.test.ts`，新增的那条测试**真的红了**，
  报错精确指出 `whispercpp-cpu-linux-x64 两份清单的 license 对不上 + 'Apache-2.0' - 'MIT'`；
  复原后重跑，16/16 全绿。**这条守卫会真的喊，不是看起来在守。**
- **`engineVersion` vs `pinnedVersion` 留观，本轮不动**：两者字段名相似、大多数条目
  语义相同，但 ffmpeg 系两条（`media-tools-linux-x64`/`media-tools-win-x64`）语义
  确实不同（一个是 ffmpeg 自身版本串，一个是上游 release tag），不能无脑要求逐字相等。
  已有 `ffmpegStableOnly.test.ts` 为 `media-tools-macos-arm64` 单独钉了"处理版本前缀
  后二者等价"的断言，但只覆盖 1/23 条，不是全集——**这属于`abstraction-audit.md`
  的"只出现两次/形状不统一，待观察不动手"那一类，不是"够格立刻抽"，因为要把它
  做成通用断言，先得回答"哪些 id 的两个版本字段允许不同义、哪些必须同义"，
  那份判断本身还没人做过，不该我在这轮替 Manager 猜。**

---

## 已提交内容

1. `vendor/manifests/components.json`：4 个 id（`whispercpp-cpu-linux-x64`、
   `whispercpp-vulkan-linux-x64`、`libsimple-linux-x64`、`sqlite-vec-linux-x64`）的
   `displayName`/`displayNameZh` 改为与 `backends.json`/`sqlite-ext.json` 一致。
2. `apps/daemon/src/pipeline/platformPacks.test.ts`：T-146③ 新增一条测试，
   核对 `license.id`/`license.url`/`displayName`/`displayNameZh` 在两份清单里
   逐 id 相等；`PackLike` 接口补上对应字段类型。
3. 本文档。

## 未做、留给 Manager 或下一轮的

- `scripts/license-report.mjs` 的 `collectManifests()` 从不下钻 `.packs[]`/
  `.components[]`，对全部 7 份 manifest 恒定输出 `UNKNOWN`——独立缺陷，不属于
  "两份清单互相矛盾"，本轮未修，需要单独排期。
- `engineVersion`/`pinnedVersion` 的通用等价断言——见上方"留观"，需要先有
  "哪些 id 允许不同义"的判断，我不该替 Manager 定。
- `[未验证]` 本轮核对的是 `backends.json`+`sqlite-ext.json` vs `components.json`
  三份之间的交集（23 对）；`llm-providers.json`/`models-*.json` 这几份未纳入本次
  逐字段核对（它们服务的是模型/LLM 目录，与"两份清单"这个具体问题不是同一个提问
  范围，未做不等于"查过没问题"，标 `UNKNOWN`）。
