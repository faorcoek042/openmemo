# inbox / catalog-truth

## [2026-08-06 14:35] T-149 DONE

交付:
- `vendor/manifests/models-asr-support.json`（删 2 处 `required-core`；+1 条实测 ModelScope 镜像）
- `vendor/manifests/models-whisper.json`（+11 条实测 ModelScope 镜像，**纯追加**）
- `vendor/manifests/README.md`（新增「`mirrors` 里多一条，不等于多一份冗余」一节）
- `apps/daemon/src/pipeline/modelCatalogTruth.test.ts`（**新增**，10 条守卫）
- `scripts/ci/cold-start-audit.mjs`（VAD 选择由「按 tag」改「按 role」，SHARED-CHANGE 见 §6）
- 提交 `e6cdb20`，**已 push**（6 个文件，逐个 `git add`，零 `-A`；`git show --stat` 核对过只有这 6 个）

---

# TL;DR

## ① `required-core`：**定性之后我删掉了它，而不是给它补一个 ASR**

**它的语义是"没有语义"** —— 这是查出来的，不是推的：

| 查了什么 | 结果 | 级别 |
|---|---|---|
| 谁消费这个标签 | **产品里零消费者**。daemon 只把 `tags` 原样透传（`state.ts:354`），网页只读 `recommended-default`（`ModelCard.tsx:52`）。**唯一的消费方是 `scripts/ci/cold-start-audit.mjs`** | 读源码 |
| 界面上怎么呈现 | **根本不呈现**。`ModelsPage.tsx:112` 是 `.filter((g) => g.role === role)`，而第 68 行 `const role: ModelRole = 'asr'` 写死 —— `role='vad'` 的两个条目**在网页上一个都看不到**（D-10 #10 独立记过同一件事） | 读源码 |
| 它标了什么 | 2 个模型，**全是 VAD，零个 ASR** | 清单实读 |
| 装完能不能转写 | **不能**（`model.asr fail(required)`） | CI 实测（D-11 §7.3 #1） |
| 「必需」这两个字今天还成立吗 | **不成立**。T-148 之后 VAD 缺失只让切分降级成固定窗口，转写照样出字 | 读源码（`vad.ts` / `vadStatus.ts` / `selfcheck.ts` 的 `required: false`） |

所以它同时错在三处：**没人执行、用户看不见、内容也是假的**。

> **给它补一个 ASR 只是把"假的承诺"换成"没人兑现的承诺"** —— 因为没有任何代码会去装它。
> 名字是一句承诺，而**从来没有任何地方定义过它**：名字自己长出了含义，然后那个含义是假的。
> → **删标签，并把"标签必须先有定义"变成机械守卫。**

判据的第二支「明确告诉用户还缺什么」**已经成立且不是我做的**：
`selfcheck` 的 `model.asr` 是 `fail(required)` + `remediation: 在「模型」页下载一个语音识别模型`。
⚠️ 但见 §4 第 3 条：**`model.vad` 那条 remediation 指向一个用户到不了的地方。**

## ② `hf-mirror`：**任务书的前提我只证实了一半，所以处置不是"删掉"**

`[本机实测 2026-08-06]` 我自己重测了一遍，`vad-fix` 的测量**完全正确**：

```
$ curl -I https://hf-mirror.com/…/resolve/9ffd54a…/ggml-silero-v6.2.0.bin
HTTP/2 308      location: https://huggingface.co/…      server: Caddy
```
`/resolve/<40 位 sha>/`、`/resolve/main/`、`/api/models/`、仓库页 **四种路径全部 308**（比 vad-fix 多测了后两种）。
**跟着跳过去落在哪** —— 这一条 vad-fix 没测，我补了：
```
$ curl -L … -w 'final=%{url_effective} code=%{http_code} size=%{size_download}'
final=https://huggingface.co/…   code=308   size=0
$ curl -I https://huggingface.co/…
curl: (28) Connection timed out after 20002 ms
```
**端到端证实：跟着"备用来源"走，落在一个从这里够不到的主源上。冗余确实是 0。**

### ★ 但「冗余是 0」只在**境外出口**成立，所以删掉是错的

```
$ curl https://hf-mirror.com/            → HTTP 200，14 KB 页面
   <title>HF-Mirror</title>
   "加速访问Hugging Face的门户。…帮助国内用户无障碍访问 Hugging Face 的资源。"
```
而 `packages/downloader/src/probe.ts` 开头的注释**早就写着**：
> it 308-redirects **non-CN** traffic straight back to huggingface.co

**这正是任务书点名的那条判据：「我拿不到那个文件」和「这里没有那个文件」是两回事。**
这是一个**中文产品**，`hf-mirror` 恰恰是给它的主要用户群用的。
按我这台境外机器的测量去删 39 条，等于**照着墙外的视角把墙内用户真正的冗余删掉**。

> 准确的结论是：**`hf-mirror` 是一条有地域条件的来源。**
> 对国内出口它是真镜像；对境外出口它与 `huggingface.co` 是同一个来源 —— 主源一挂两条一起挂。
> **缺陷不是"这条镜像是假的"，是"清单把一条有条件的来源当成了无条件的冗余"，而且这个条件在数据里没有任何表示。**

⚠️ 还有一条**元教训**：`probe.ts` 的注释里已经写着这个事实了。**注释知道，数据不知道** ——
39 处 `hf-mirror` 照旧被当成 39 份备份，`pack-publish`、`vad-fix`、我，三个人先后按"有两条来源"读过它。

### 处置：不删，改成"加真的"+"把没备份的写下来"

**加了 12 条真镜像，每一条都实测过 sha256 逐字符相符**（不是按文件名匹配）：

```
预言机可信度先验过：ModelScope files API 报 Sha256=2aa269b785… 
                    实下 885,098 B 后 sha256sum = 2aa269b785…   ← 逐字符相同
```
| | 之前 | 之后 |
|---|---|---|
| 43 个文件里，**只有一个独立来源**的 | **29** | **17** |
| `vad/silero-vad-ggml`（T-148 那份权重） | 只有 HF | **HF + ModelScope** |
| 已有的 14 条 ModelScope 条目 | 未验过 | **14/14 全部 MATCH**（顺带查的，它们不是谎） |

**没找到可验证独立镜像的**：sherpa 三件套 / paraformer / 标点（ModelScope 上 `csukuangfj/*` 全部 `record not found`）。
这 17 个文件**写进了守卫里当断言对象** —— 「我们知道这些文件没有备份」要写下来，不能靠没人发现。

## ③ 分类错位：**不是同一根因**，而且"修法已经写好了、没人调用"

`[本机实测]`（跑编译后的产品代码，不是读注释）：

```
daemon      roleToStoreKind('vad')        = asr     ← 写盘走这条
downloader  bucketForRole('vad')          = vad     ← 本该走这条
downloader  STORE_KINDS = asr,llm,vad,punctuation,diarization,embedding,tts,backend   （8 个）
bucketForRole 的调用方数量 = 0
```

- `packages/downloader/src/store.ts:29-42` 的注释**明写这个 bug 已经用两条独立修正解掉了**
  （①一个 role 一个桶 ②role 写进安装记录）。**②真的落地了**（`findInstalledByRole` 扫全部 8 个桶、按 `rec.role` 过滤，`modelStore.ts` 在用），
  **①没有** —— daemon 的写盘路径还在用 T-027 时代的 `roleMap.ts`。
- 那个文件的注释今天是**假的**：它写着「`packages/downloader` 的 `StoreKind` 仍是 3 个（asr|llm|backend）」，实际是 8 个。
- **与 T-148 不是同一根因**。T-148 是「一个 role 一个槽位，而 VAD 是按引擎分的」；
  这条是「桶 ≠ role，daemon 的写盘路径早于那次修复」。**危险的那一半（从目录名推 role）已经修好了。**

**我没有修它**，理由是它不是清单问题、而且**单独改会当场造出一个更糟的 bug**：
`state.ts:291` 的 `listInstalled()` 只扫 `['asr','llm']` 两个桶 ——
把 `roleToStoreKind` 改对而不同时改它，**已装的 VAD 模型会从 `/api/models/installed` 里整个消失**。
这是一次带记录迁移的写盘布局变更，属于 `model-mgmt`。→ §5 决策 1。

## ④ submodule 那份权重：**不要从 submodule 取**

`vad/silero-vad-ggml` 与 `vendor/whisper.cpp/models/for-tests-silero-v6.2.0-ggml.bin`
sha256 逐字符相同（`2aa269b785…`，885,098 B，本机复核过）。**但不该拿它当下载源**，四条理由：

1. **终端用户机器上根本没有它。** `vendor/whisper.cpp` 是 submodule（`.gitmodules` + `pnpm submodules:init`），
   是编译用的源码树，**不进发行包**。"省一次网络往返"只在开发机/CI 上兑现 —— 而那正是网络往返最不痛的地方。
2. **它是上游的测试夹具**（文件名就写着 `for-tests-`）。拿一个上游随时可以清理的夹具当生产权重源，
   失败会以「文件不见了」的形态出现在没人预期的地方。
3. **它会多出一条获取路径。** `schemas.ts` 里 `LOOPBACK_HOSTS` 那段注释已经为同一件事做过取舍：
   宁可复用同一条下载路径（Range/续传/校验/去重/重试），也不要第二条会漏掉这些保证的路径。
4. **真正的问题是"下不到"，那个我已经修了** —— 这份权重现在有 ModelScope 镜像（实测 sha256 相符）。

**它的正确用途保留**：**离线的地面真相**。`vad-fix` 靠它在完全下不到 HF 的情况下证明了
「权重没问题、二进制没问题、版本没问题」。这个价值与"当下载源"是两回事，已记在此。

---

# §1 反向验证（四组，全部贴真实输出）

每组跑之前都 `grep` 过坏行确实在**即将运行的产物**里；R3 第一次跑因为**只 grep 了清单、没 grep dist**
而多红了两条（上一组的 `TAG_MEANINGS` 还留在 `dist` 里），**已重编后重跑，下面贴的是干净的那次**。
—— 这正是任务书点名的那个陷阱，我踩了一次，记在这里。

**R1 · 把 `required-core` 加回清单**（`grep` 确认：`models-asr-support.json:25,90` 命中）
```
✖ ★ 每个出现在清单里的标签，都必须在 TAG_MEANINGS 里写明含义
  AssertionError: 这些标签出现在目录里、却没有任何地方定义过它是什么意思 ——
                  required-core 就是这么长出一句假承诺的：required-core
ℹ tests 10 / pass 9 / fail 1
```

**R2 · 一比一还原事故当天**（清单里有 `required-core` + 表里声称 `claimsSufficiency: true`）
（`grep` 确认坏行在 `apps/daemon/dist/pipeline/modelCatalogTruth.test.js:84`）
```
✖ ★ 声称"这一组装完就够用"的标签，必须真的凑得出一条完整的转写链
  AssertionError: 标签 required-core 说"装完就够用"，实际上：
                  一个 role='asr' 的模型都没有（这一组里只有：vad）—— 装完仍然不能转写
✖ ★ role=vad 的条目不许再被标成"必需"（T-148 之后缺 VAD 只降级，不致命）
  AssertionError: …把它标成"装完就够用"是假承诺：
                  vad/silero-vad-ggml:required-core, vad/silero-vad-onnx:required-core
ℹ tests 10 / pass 8 / fail 2
```

**R3 · 删掉一条真镜像**（把 ggml VAD 的 ModelScope 条目拿掉）
```
✖ ★ "只有一个来源"的文件清单必须与记录在案的逐字相同
  AssertionError: 「哪些文件没有备份」这件事变了。…
  +   'vad/silero-vad-ggml  ggml-silero-v6.2.0.bin  [huggingface.co]',
      'vad/silero-vad-onnx  silero_vad.onnx  [raw.githubusercontent.com]'
ℹ tests 10 / pass 9 / fail 1
```

**R4 · 把 `hf-mirror` 当成独立来源**（= 事故当天清单被读成的样子）
（`grep` 确认 `dist/…test.js:189` 有 `REVERSAL-R4`）
```
✖ 别名折叠：hf-mirror.com 与 huggingface.co 算同一个来源
  AssertionError: + 'hf-mirror.com'  - 'huggingface.co'
✖ ★ "只有一个来源"的文件清单必须与记录在案的逐字相同
  -   'asr/paraformer-zh-small  am.mvn  [huggingface.co]',
  -   'asr/sherpa-streaming-zh-14m  encoder-epoch-99-avg-1.int8.onnx  [huggingface.co]',
  …（17 条里有 16 条凭空"有了备份"）
ℹ tests 10 / pass 8 / fail 2
```
> R4 这一屏就是这条 bug 的全貌：**把别名当独立来源，16 个没有备份的文件看起来都有备份。**

**R5 · CI 脚本那处改动的必要性证明（不是守卫，如实标注）**
拿真清单跑新旧两个筛选式：
```
旧筛选（按 tag: required-core）选中 0 个 ← VAD 一个都不装 → 冷启动审计的「切分方式」会退回固定窗口
新筛选（按 role: vad）        选中 2 个：vad/silero-vad-onnx, vad/silero-vad-ggml
```
⚠️ **这条只在本机证了"选择结果"**，没有真跑 `cold-start-audit`（要 daemon + 外网）。
真跑的判据是 `vad-fix` §5 那句 `✔ 切分方式 = VAD（按静音切分）` 必须保持不变 —— **标 `[未验证：待 CI]`**。

**还原确认**：`grep -rn REVERSAL` 在 `apps/`+`packages/`+`scripts/`+`vendor/` 命中 **0**
（4 处命中全在别人的 inbox 散文里）；`dist` 命中 **0**；清单里 `required-core` 命中 **0**。

# §2 守卫钉的是什么（10 条，`apps/daemon/src/pipeline/modelCatalogTruth.test.ts`）

选在 daemon 是因为 `platformPacks.test.ts` 已经是同一形状（读真 `vendor/manifests` 的清单守卫）。
⚠️ **`tsconfig.test.json` 那条纪律不适用于本文件**：只有 `apps/web` 有那份显式白名单；
`apps/daemon/tsconfig.json` 是 `include: ["src/**/*"]`，新测试自动进 `dist`。
已按该包 `test` 脚本的前置守卫核对过（源码 N 个 `*.test.ts` ⇔ dist N 个 `*.test.js`），
实跑 **302/302**（我之前是 292）。

① 三份清单过 schema + 模型数 ≥30（非空守卫）
② ★ 每个进目录的标签必须在 `TAG_MEANINGS` 里写明含义（18 个标签，非空）
③ 表里不许有清单中已不存在的标签（**这张表自己也会腐烂**）
④ ★ 声称"装完就够用"的标签必须真的够用
⑤ ★ **一比一复现**：把事故当天那两个 VAD 喂给同一个判定函数，必须被判否 + 理由要说出缺的是 `role='asr'`
   （**并有反面**：补上任意一个 ASR 必须判为够用，否则那是个"永远说不够"的死结论）
⑥ ★ `role=vad` 不许再被标成"必需"
⑦ 别名折叠正确（且 `modelscope`/`raw.githubusercontent` **不许**被折叠掉）
⑧ ★ 「只有一个来源」的 17 个文件清单逐字不变
⑨ provider 与 URL 主机名必须对得上（核对了 ≥60 条，数了几个说几个）
⑩ ModelScope 地址形状 + 末尾必须是该文件名（拼错只会在用户点下载时才 404）

两处**刻意的写法**，对应任务书点名的陷阱：
- ④ 今天 `claiming` 是空集 → 循环一条都不跑。所以判定函数的**活性由 ⑤ 用真数据证明**，
  并补了 `assert.deepEqual(claiming, [])` 把"今天为空"这件事本身钉住。
- ⑥ 的判据是「这个标签有没有声称完整性」，**不是「名字里有没有 required」** —— 钉后果不钉字面。
  （`required-for-f3` 因此合法留存：它说的是"少了它 F3 不成立"，不是"有它就够"。）

# §3 门禁

| | 结果 |
|---|---|
| `tsc -b` | **0** |
| `eslint`（我的两个文件） | **0** |
| `pnpm test:ci-scripts` | **15 + 14 全过** |
| `apps/daemon` | **302 / 0**（+10） |
| `packages` 五个 | llm 18 · db 53 · mindmap 51 · runtime 51 · pipeline **184/1** |

⚠️ **有两条红，都不是我的，我一个字节都没碰过那些文件**（`git diff --stat` 可核）：

1. `packages/pipeline` 的 `sourceIsGreppable`：
   `apps/web/src/test/components.test.tsx:5255 含字面控制字节 0x00` —— 前端线在途改动（该文件 +629 行）。
   `pnpm -r test` 会在这里 bail，所以我用 `pnpm -r --no-bail test` 才拿到 daemon 的数。
2. `apps/web` 的 `test:unit` **编不过**：
   `noteAssets.test.ts(90,32): error TS2345 …Pick<NoteAsset,"state">` —— 与 `packages/shared/src/notes.ts`
   的在途改动（+151 行，`daemon-contract` 新建了 inbox）相配套的一半还没到。
   `eslint` 那 4 条 `no-unused-vars` 也全在 `components.test.tsx` 里。

**所以基线 931 这一轮对不上，原因在别人那儿**：非 web 部分是 650 → **660**（我 +10），web 部分编不过。

`prettier --check` 对我改的文件报 warn —— **但它们在 HEAD 就已经不合规**
（用 `git show HEAD:<f> | prettier --check --stdin-filepath <f>` 逐个验过），
且 `.github/workflows/` 里 `prettier|format:check` 命中 **0**，兄弟守卫文件
`platformPacks.test.ts` / `vadResolve.test.ts` 也都 NOT-FORMATTED。**不是我引入的回归，我也没去重排别人的文件。**

# §4 顺带查出、**没有修**的三条（都给了证据）

1. **`roleMap.ts` 的文档注释是假的** —— 写着 downloader 的 `StoreKind` 是 3 个，实际 8 个。
   而 `bucketForRole()`（正确的替代品）**0 个调用方**。见 TL;DR ③。
2. **`selfcheck.ts:174` 的 `NON_ASR_NAME` 正则是一条按文件名打的补丁**，
   它自己的注释写着「真正的修法是让安装记录带上 catalog 的 role」——
   **那个修法已经落地了**（`findInstalledByRole` 就在读 `rec.role`），只是这里还没用上。
   后果：ASR 是否就绪，今天仍然靠 `/silero|vad|punct|ct-transformer|speaker|diariz/i` 判定。
   **一个叫 `silero-asr-xxx` 的真 ASR 模型会被它判成"不是 ASR"。**
3. 🔴 **`model.vad` 的 remediation 指向一个用户到不了的地方** `[读源码推断]`：
   它说「在「模型」页安装 `vad/silero-vad-ggml`」，而 `/models` 只渲染 `g.role === 'asr'`
   —— **VAD 在那一页上不存在**（D-10 #10 独立记过，派给 `architect`）。
   `/models/vad%2Fsilero-vad-ggml` 直接敲 URL 能打开（`ModelDetailPage` 查的是 `catalog('all')`），
   **但没有任何导航到得了那里**。
   > 这是「假绿灯家族 D」的同族第五种形态：**不是开关关着，是"该出现的地方压根没渲染它"**。
   > 判据仍是那句：问"这个东西该在什么时候出现"，再问"它实际在什么时候出现"。

# §5 需要 Manager 决策

1. **`roleToStoreKind` 那条要不要派人修？** 是一次「写盘布局 + 记录迁移」的联动改动：
   `roleMap.ts` 改成 `bucketForRole` **必须同一次**把 `state.ts:291` 的 `listInstalled()`
   从 `['asr','llm']` 扩到全部 8 个桶，否则已装的 VAD/标点模型会从 `/api/models/installed` 消失。
   建议派 `model-mgmt`。**收益不只是目录名好看**：`selfcheck` 的 `NON_ASR_NAME` 正则可以一起删掉。
2. **`model.vad` 的 remediation 到不了（§4-3）要不要并进 D-10 #10 那张单？**
   它现在是一条**具体但无法执行**的指引 —— 比没有指引更糟，用户会以为是自己没找到。
3. **17 个文件仍然只有 HF 一个来源**（sherpa/paraformer/标点/一批 q8_0）。
   要不要建一个「把 sherpa 系模型镜像到我们自己的 GitHub Release」的任务？
   `github.com` 已在 `ALLOWED_DOWNLOAD_HOSTS` 里，`pack-publish` 那条线本来就在发 release。
4. **要不要把 `ORIGIN_ALIASES` 从测试提到 `packages/shared`**，让下载器的失败转移也知道
   「hf → hf-mirror」在境外是白跑一趟？我**没有做**，因为 `probe.ts` 实测已经会把它判成不可达
   （`redirect:'follow'` → 落到 HF → 超时 → `ok:false`），加了是锦上添花、但会动到大家都用的包。

# §6 SHARED-CHANGE 申报

动 `vendor/manifests/` 前的 `git status --short`（**06:15 逐字抄录**）：
```
 M apps/daemon/src/http/rest/notes.ts        M apps/web/src/components/common/llm/llm-catalog.ts
 M apps/daemon/src/http/ws.ts                M apps/web/src/features/diagnostics/DiagnosticsPage.tsx
 M apps/daemon/src/main.ts                   M apps/web/src/test/components.test.tsx
 M apps/daemon/src/ws/recorder.ts            M packages/runtime/src/assetPaths.ts
 M apps/web/src/app/i18n/locales/en.json     M packages/runtime/src/index.ts
 M apps/web/src/app/i18n/locales/zh-CN.json  M packages/shared/src/notes.ts
?? apps/daemon/src/ws/recorder.test.ts       ?? coordination/inbox/daemon-contract.md
```
更早（06:00）`vendor/manifests/backends.json` 还是 ` M`（`pack-publish` 在填 release URL），
到我动手时**已不在列**。

| 文件 | 归属 | 我做了什么 | 冲突风险 |
|---|---|---|---|
| `vendor/manifests/models-asr-support.json` | `model-mgmt` | 删 2 处 `required-core`；hf 与 hf-mirror **之间**插一条 modelscope | 🟢 低 |
| `vendor/manifests/models-whisper.json` | `model-mgmt` | **纯追加** 11 条 modelscope，既有条目一个字节没动 | 🟢 低 |
| `vendor/manifests/README.md` | `oss-scout` | **纯追加**文末一节 | 🟢 低 |
| `vendor/manifests/backends.json` · `components.json` · `sqlite-ext.json` · `llm-providers.json` · `models-llm.json` | `pack-publish` / `model-mgmt` | **一个字节都没动** | — |
| `scripts/ci/cold-start-audit.mjs` | `ci-runner`（`pack-publish` 也改过） | 一处筛选 `tags.includes('required-core')` → `m.role === 'vad'`，+ 改它上下两段注释。**改动全在 §3b 那一小块内**，别处未碰 | 🟡 中 —— rebase 时留意 |

> 三份 JSON 都做过 `JSON.stringify(JSON.parse(s),null,2)+'\n' === s` 的**往返一致性检查**
> （改前改后都成立），所以 diff 是最小的，不会因为程序化改写把整份文件重排。

# §7 纪律申报

- **`git add` 逐个文件**（6 个），零 `-A`。推送前重新 `git status` 对过在途改动。
- 构建**全程 `pnpm build:safe`**；`apps/web/dist` 一次都没写过。
  ⚠️ 我跑过一次 `apps/web` 的 `pnpm test`（为了给出完整门禁数字）——
  它内部的 `vite build --ssr … --outDir .test-out/{host,components}` **显式指定了 outDir**，
  不碰 `apps/web/dist`；实际它在 `test:unit` 的 `tsc` 那步就编不过，`vite` 一次都没跑到。
- `:10000` **一次请求都没发**；`/root/data-memo` 没读没写；
  `~/.local/share/openmemo/datadir.json` **没碰**（本任务全程只读 JSON 清单 + 跑纯函数测试，
  不启 daemon、不走任何搬迁路径）。
- 没有 `pkill -f`；没建/改/删 release；没改仓库可见性、分支保护。
- **本机没有跑过 whisper 转写**（一次 spawn 都没有）。
- 外网请求只发给 `hf-mirror.com` / `huggingface.co` / `www.modelscope.cn` / `api.github.com`，
  全是 GET/HEAD；唯一下载的是 885 KB 的 VAD 权重，落在 `/tmp/catalog-truth/`（为了验 sha256 预言机）。
- 临时文件全在 `/tmp/catalog-truth/`。

---

## [2026-08-06 15:45] T-149 追加交付（三条决策 + 一次我造成的在途红灯）

交付:
- `apps/daemon/src/http/rest/roleMap.ts`（`roleToStoreKind` 委托给 `bucketForRole`；槽位改自己穷举）
- `apps/daemon/src/http/rest/state.ts`（`listInstalled()` 扫全部桶 + 新增 `bucketOfInstalled` / `dropInstalledRecord`）
- `apps/daemon/src/http/rest/models.ts`（删 / 校验 / 安装 / 导入四处不再按 role 反算桶）
- `packages/runtime/src/selfcheck.ts`（**删掉两条按文件名判类型的正则**；新增 `listInstalledNamesByRole`；`model.vad` 指引改指新落点；一处错文案订正）
- `packages/runtime/src/index.ts` · `apps/daemon/src/http/rest/selfcheck.ts` · `scripts/selfcheck.mjs`（新探针的两个出口）
- `apps/daemon/src/pipeline/roleBucket.test.ts`（**新增**，16 条）· `packages/runtime/src/selfcheck.test.ts`（+2，改 3）
- `apps/daemon/src/pipeline/vadResolve.test.ts`（一处**今天已经是假的**的注释订正）

---

# TL;DR

## ★ 先认一件我造成的事：`packages/runtime` 那 25 条红是我的

`frontend-truth` 撞上的红**确实是我造成的**，成因有两条，都值得记：

1. **我在共享工作树里做反向验证。** R7–R11 每一组都要「把修复拆掉 → `pnpm build:safe` → 跑 → 还原」。
   在那几分钟里 `dist` 里装着**故意坏掉的代码**，而这台机器上同时有别的 agent 在跑 `pnpm -r test`。
   我每次都还原了、`grep -rn REVERSAL` 也一直是 0，**但"最终状态干净"救不了"过程中别人跑了一次"**。
2. **接口改成必填的那一刻，红是必然的。** `installedByRole` 我做成非可选（理由见下），
   于是 `selfcheck.test.ts` 的 `minimalProbes` 在我补上它之前**必然编译失败**。
   我确实在同一轮补上了，但**中间存在一个窗口**。

> **判据不是"我最后有没有还原"，是"在最坏的那一秒，别人看到的是什么"** —— 与 PROTOCOL §9-bis
> 那条（把测试 `kill -9` 在最坏的一行上，机器会留下什么）是同一条判据的另一个面。
> **可操作的教训**：反向验证应当在**独立 worktree / 独立 `--outDir`** 里做，或者至少
> 在开始前后各发一次公告。这一条我建议进 PROTOCOL，由你裁。

**现在的状态**：`tsc -b` 0 · `eslint` 0（全仓）· `test:ci-scripts` 15+14 · `pnpm -r test` **1028 / 0**。

## ① `roleToStoreKind` + `listInstalled()` 联动 —— 做完了，判据钉住了

`[本机实测]` 改前：

```
daemon      roleToStoreKind('vad')  = asr      ← 写盘走这条
downloader  bucketForRole('vad')    = vad      ← 本该走这条
bucketForRole 的调用方数量           = 0
```

改后 `roleToStoreKind` **不再持有自己的映射表**，直接 `return bucketForRole(role)`。

**你批准的联动我做了，而且比原计划多两处** —— 因为查下去发现同一个形状不止一处：

| 处 | 原来 | 不改会怎样 |
|---|---|---|
| `state.ts` `listInstalled()` | 写死扫 `['asr','llm']` | **已装的 VAD 从 `/api/models/installed` 里整个消失**（你给的判据） |
| `models.ts` 删除 | `removeManifest(roleToStoreKind(role))` | 旧布局下删的是**空桶**，而 `fs.rm` 是 `{force:true}` —— **返回 204、事件也发了、记录还在** |
| `models.ts` 校验 | `writeManifest(roleToStoreKind(role))` | 旧布局下会在新桶写出**第二份**记录 → 同一个模型列两次 |
| `models.ts` 安装/导入 | 直接写新桶 | 旧机器上重装一次会留下**两份**记录 → 现在先 `dropInstalledRecord` 再写（就地自愈） |

**⚠️ 还有一处差点被我改坏，记在这里**：`roleToActivationSlot` 原来是
`roleToStoreKind(role) === 'llm' ? 'llm' : 'asr'`。桶恒等之后
`bucketForRole('embedding') === 'embedding' ≠ 'llm'`，这句话会把 **embedding / tts
从 llm 槽悄悄挪到 asr 槽** —— 形状没变、编译不报错、行为反了。
改成自己穷举 + 穷尽性检查，并单独一条用例钉住。**这是"改一处、翻另一处"的典型，
它不会以任何形式报错。**

### 不迁移，改成"读的时候不看目录"

旧记录（VAD 躺在 `manifests/asr/`）**原地不动**。理由：搬文件才需要迁移，
而每一个读取方现在都扫全部桶、按记录里的 `role` 判断。
迁移会动 `by-name/` 硬链与记录里的 `relPath`，那是一次可能把用户装好的东西弄丢的写操作 ——
**为了目录名好看去冒那个险，不值。**

## ② `model.vad` 的指引 —— 对准了 `frontend-truth` 的新落点，并加了一条防漂移守卫

新文案（`selfcheck.ts`）：

> 在「模型」页→转写→**「实时字幕组件」**一组里安装 `vad/silero-vad-ggml`
> （直达：`/models/vad%2Fsilero-vad-ggml`）。两个 VAD 变体体积与量化都一样，
> 差别在**引擎**：ggml 那个给 whisper.cpp，`vad/silero-vad-onnx` 给 sherpa 流式，**两者不能互换**。

三件事各有理由：
- **分组名逐字对齐** `asrSections.ts` 的 `realtime` 组 + i18n `models.section.realtime`。
- **直达地址保留**：那是不依赖列表分组的第二条路（`ModelDetailPage` 查 `catalog('all')`，不过滤 role）。
- **写明"不能互换"**：`frontend-truth` 发现两个变体 `quantization` 都是 `f16`、
  真正差的是 engine —— **选错的代价 T-148 已经付过一次**（sherpa 的 ONNX 被喂给 whisper）。

★ **守卫**：`roleBucket.test.ts` 里那条会**从 `apps/web` 的 i18n JSON 里读**分组名，
再断言 `runSelfCheck()` 吐出来的 remediation 里真的有这几个字。
期望值不抄字面量 —— 任何一边改名都会红。反向验证（把分组名改成「语音活动检测」）：

```
✖ ★ 指引里的分组名必须与 i18n 里那一条逐字相同（两处字符串必然漂移）
  AssertionError: 指引里没有提到界面上那一组的名字「实时字幕组件」，用户照做会找不到：
                  在「模型」页→转写→**「语音活动检测」**一组里安装 `vad/silero-vad-ggml`
```

> 这条守的是一种**不会让任何东西变红**的错：daemon 说去 A 组找，界面上那一组叫 B。
> 用户照做、找不到、怀疑是自己的问题 —— 与它要修的那个 bug 一模一样，只是换了个名字。

## ③ 那条正则删了，而且**它真的会误杀**，不是理论风险

删掉的两条：
```
NON_ASR_NAME    = /silero|vad|punct|ct-transformer|speaker|diariz/i   （T-067）
VAD_WEIGHT_NAME = /silero|vad/i                                       （T-148）
```
`NON_ASR_NAME` **自己的注释就写着**「真正的修法是让安装记录带上 catalog 的 role」——
而那条修法在 `9683ae3` 就落地了。**又一例"写好了没人调用"。**

`[本机实测]` 用真 CLI（`node scripts/selfcheck.mjs --data-dir <tmp>`）跑一遍，
数据目录里放一条 `role:'asr'` 但名字叫 `silero-asr-en-v1.bin` 的记录：

```
改前判据（正则）→ 被 /silero/ 剔掉 → model.asr = ✘ 无        ← 装好了却报没装（假红灯）
改后判据（role）→ ✔ ASR 模型  silero-asr-en-v1.bin
```
同一次跑还证实**旧布局照样读得到**（记录在 `manifests/asr/` 下，role=vad 一样找得到）。

### ★ 顺带抓到一句我自己差点放过去的错文案

同一次 CLI 实跑里，一条 **ggml** 的 VAD 记录被这句话描述成：

```
已装的 VAD 权重 whisper.cpp 用不了（ggml-silero-v6.2.0.bin，那是 sherpa 引擎的 ONNX 格式）
                                    ↑ 它就是 ggml 那一份
```
原文案把「解析器没交出可加载权重」直接说成「你装的是 ONNX」—— **那是猜的**：
也可能是 ggml 但文件读不到 / 被截断 / 权限不对。
改成只说观测到的事实：「已装的 VAD 权重 whisper.cpp **一个都加载不了**（已装：…）」。
**一句描述得很具体的错话，比不说更能把人带偏**（HANDOFF D-bis 同族）。
⚠️ 这条**是我这轮改动才让它变得可达的**（旧正则只挑得出 ONNX），如实记账。

## ④ 17 个单一来源文件 —— **评估完了：值得做，但只做其中 406 MB 的 9 个；上传不由我做**

你要的两个数：

**总共多大**：5.33 GB / 17 个文件。**但风险完全不均匀**，拆开看结论就变了：

| 组 | 文件 | 体积 | 主源挂了会怎样 |
|---|---|---|---|
| A：whisper q8_0 档 + turbo 的 CoreML zip | 8 | **4.87 GB** | **有替代**。每一个都有同模型的 q5_0/q5_1/f16 兄弟，而那些**已经有 ModelScope 镜像**（本轮加的）。用户仍装得上同一档位能用的模型 |
| B：sherpa 流式三件套 + Paraformer + 中文标点 | 9 | **406 MB** | ★ **一个替代都没有**，而且整组都在**中文路径**上：F3 实时字幕、`recommended-default-zh` 的离线引擎、以及"不装中文输出就是一整段没标点的字"的标点模型 |

**谁来保证同步**：**没有同步问题**，这条我实测核过了 ——
17 个的下载 URL **全部钉在不可变引用上**（HF 的 40 位 commit sha / GitHub 的 commit sha），
清单里还有 sha256。**镜像一份钉死的 blob 不会"变旧"：它要么逐字节相同，要么校验当场失败。**
需要人维护的是"上游出了新版我们跟不跟"，而**那件事今天已经是人工改清单**，与镜不镜像无关。

⚠️ 一处自我更正：我第一版的"是否钉死"正则只认 `/resolve/<40hex>/` 与 `/raw/<40hex>/`，
把 `raw.githubusercontent.com/<owner>/<repo>/<sha>/<path>` 形式的 `silero_vad.onnx`
误报成"未钉"。**实际 17 个全部钉死。** 正则太窄，不是数据有问题。

**结论：做 B 组（406 MB / 9 个），不做 A 组。** 为一个已经有替代品的东西建 4.87 GB 的影子仓库，
收益低、体积大。

**但上传不是我做** —— 纪律明写「不建/不改/不删 release」。→ §5 决策 1，请派给 `pack-publish`；
需要的清单（id / 文件名 / sha256 / 上游 URL）在 `vendor/manifests/models-asr-support.json` 里齐全，
9 个文件就是 `asr/sherpa-streaming-zh-14m`(4) + `asr/paraformer-zh-small`(3) + `punctuation/ct-transformer-zh-en`(2)。

---

# §A 反向验证（六组，全部贴真实输出，全部先 `grep` 过 **dist**）

⚠️ **上一轮我在这里踩过坑（只 grep 清单没 grep dist），这一轮六组全部先 grep 产物。**

**R6 · `listInstalled()` 退回只扫 `['asr','llm']`**（`grep dist/http/rest/state.js:207` 命中）
```
✖ ★★ 判据：已装的 VAD 必须仍然出现在 /api/models/installed 里
  AssertionError: 改桶之后旧记录读不到了 —— 用户会看到"我装过的东西没了"，而且没有任何报错
  -   'vad/silero-vad-onnx'
✖ ★ 同一个 id 在新旧两个桶里都有（重装过的旧机器）→ 只出现一次
  + 'old-copy.bin'   - 'ggml-silero-v6.2.0.bin'
ℹ tests 15 / pass 13 / fail 2
```

**R7 · `roleToStoreKind` 退回 T-027 的自有映射表**（`grep dist/http/rest/roleMap.js:8` 命中）
```
✖ ★ 七个 role 逐个对齐 —— 两处映射表必然漂移，所以只许有一处
  AssertionError: vad 的桶两边算出来不一样 —— 这正是 VAD 落进 by-name/asr 的成因
ℹ tests 15 / pass 14 / fail 1
```

**R8 · 桶恒等 + 槽位退回"由桶推导"**（这才是那个危险组合；`grep dist:56` 命中）
```
✖ ★ 激活槽位**不能**跟着桶一起变：embedding / tts 仍归 llm 槽
ℹ tests 15 / pass 14 / fail 1
```
⚠️ 我第一次把 R7 与 R8 一起打，**R8 没红** —— 因为老映射表下 `roleToStoreKind('embedding')==='llm'`，
推导出来仍然对。**两个 bug 互相掩盖，与 ① 里那对是同一种形状。** 拆开单独打才红。

**R9 · 删除退回"按 role 算桶"**（`grep dist/http/rest/state.js:241` 命中）
```
✖ ★ 删除必须把旧桶里的那条也删掉（否则 204 之后模型还在）
ℹ tests 15 / pass 14 / fail 1
```

**R10 · 把 `NON_ASR_NAME` 正则放回去**（`grep packages/runtime/dist/selfcheck.js:554` 命中）
```
✖ ★ 名字里带 silero 的**真** ASR 模型必须算 ASR（旧正则在这里会误杀）
  AssertionError: 记录里 role=asr，就该算 ASR —— 名字里有什么字与它无关
✖ ★ 没写 role 的老记录：不猜，但必须把"跳过了几条"说出来
  AssertionError: 跳过的范围要如实进返回值，不能静默吞掉
ℹ tests 35 / pass 33 / fail 2
```

**R11 · 把指引里的分组名改成一个界面上不存在的名字**（见 TL;DR ②）

**还原确认**：`grep -rn REVERSAL` 源码 **0**、`dist` **0**。

# §B 两处"我跳过了 N 条"必须出声

`findInstalledByRole` 对**没写 `role`** 的老记录一律跳过（`store.ts` 的规矩：不从目录名猜）。
那条规矩是对的，但**跳过 ≠ 没有** —— 不报出来的话，一个装满模型的旧库会被自检说成「无」，
用户会去重装已经装好的东西。所以 `listInstalledNamesByRole` 返回
`{ names, skippedWithoutRole }`，`model.asr` 的 detail 里会多一句
「另有 N 条安装记录没写 role，一律不猜类型（重装一次即可补上）」。（HANDOFF ⑤A 规矩 6。）

# §C 一处设计取舍：为什么 `installedByRole` 是**必填**探针

做成可选（`installedByRole?:`）等于留了一条「没实现时悄悄退回按文件名猜」的暗道，
而那条暗道正是这次要拆掉的东西。做成必填的代价是**接口变更那一刻会红**（就是本次那 25 条），
收益是**两个出口（daemon / CLI）不可能有一个忘了接** —— 而"两个出口给出不同答案"
正是 T-148 里 `model.vad` 两边都绿的机制（vad-fix §2）。
`[本机实测]` 两个出口都真跑过：daemon 走 `roleBucket.test.ts`（16 条），
CLI 走 `node scripts/selfcheck.mjs --data-dir <tmp>` 真实输出（见 TL;DR ③）。

# §D 门禁

| | 结果 |
|---|---|
| `tsc -b` | **0** |
| `eslint .`（**全仓**，不只是我的文件） | **0** |
| `pnpm test:ci-scripts` | 15 + 14 全过 |
| `pnpm -r test` | **1028 / 0**（llm 18 · db 53 · mindmap 51 · runtime 53 · pipeline 187 · web 103+10+226 · daemon 327） |

上一轮回执里记的那两条红（`components.test.tsx` 的 NUL 字节、`noteAssets.test.ts` 的 TS2345）
**已被 `debt-cleanup` 与 `daemon-contract` 各自修掉**，现在全仓是干净的。

`prettier --check` 对我改的文件仍报 warn，与上一轮同因：**它们在 HEAD 就已经不合规**
（逐个 `git show HEAD:<f> | prettier --check --stdin-filepath <f>` 验过），
`.github/workflows/` 里 `prettier|format:check` 命中 **0**。**不是我引入的回归。**

# §E 关于 `debt-cleanup` 那条控制字节（你点名要我看的）

我这轮所有新建/改动的 **16 个文件**逐字节扫过：**字面控制字节 0 个**，
`git diff --stat` 全部能正常渲染行数（不是 `Bin ... 0 insertions(+)`）。

你说的"同一族的另一种形态"我认：我那次是 **grep 了错的目标**（清单而不是 dist），
`argGuard.ts` 那次是 **grep 被目标本身骗过**（NUL 让它静默跳过）。
两者的共同点是**"我以为我查过了"这句话本身没有任何东西在守**。
→ 这轮六组反向验证我把 "先 grep 即将运行的产物" 写进了每一组的步骤，输出贴在 §A。

# §F 需要 Manager 决策

1. **B 组 9 个文件（406 MB）镜像到自家 release，派给 `pack-publish`。**
   我做完了评估（无同步负担、总量可控、是唯一没有替代品的一组），但**不建 release** 是纪律。
2. **反向验证要不要规定在独立 worktree 里做？**（见 TL;DR 开头那条我造成的在途红灯）
   我建议进 PROTOCOL：**判据不是"最后有没有还原"，是"在最坏的那一秒别人看到什么"。**
3. **老记录的 `role` 要不要补一次迁移？** `migrateRecords.ts` 今天不补 `role`，
   于是没写 role 的旧记录在自检里会被算进 `skippedWithoutRole`（会出声，但不会自愈）。
   补它的正确做法是从 catalog 按 id 回填，属于 `model-mgmt` 的活。

# §G 纪律申报（本轮追加部分）

- **`git add` 逐个文件**，零 `-A`；提交前 `git status` 对过在途改动。
- 构建**全程 `pnpm build:safe`**；`apps/web/dist` 一次都没写过。
- **`:10000` 一次请求都没发**；`/root/data-memo` 没读没写。
- **`~/.local/share/openmemo/datadir.json` 没碰** —— 已核对时间戳仍是 `2026-08-04 01:06:59`。
  新测试 `roleBucket.test.ts` 在**模块顶层**设 `OPENMEMO_MODELS` / `OPENMEMO_EXT_DIR` 到 tmp（窗口为零），
  并**自带两条断言**守着这个重定向（PROTOCOL §9-bis 那条"覆盖要有人守"）。
  跑 CLI 自检时一律显式 `--data-dir /tmp/...`。
- 没有 `pkill -f`；没建/改/删 release；没改仓库可见性、分支保护；**本机没跑过 whisper 转写**。
- 外网请求：本轮 0 次（镜像验证在上一轮已完成）。

## SHARED-CHANGE 申报（追加）

| 文件 | 归属 | 我做了什么 | 冲突风险 |
|---|---|---|---|
| `packages/runtime/src/selfcheck.ts` · `.test.ts` · `index.ts` | `storage-fix` / `gpu-runtime` / `pack-publish` / `vad-fix` | 删两条正则、加一个探针与一个导出、改 `model.asr`/`model.vad` 两项 | 🟡 中 —— **本轮那 25 条红就出在这里**，已修完 |
| `apps/daemon/src/http/rest/{state,models,roleMap,selfcheck}.ts` | `model-mgmt`（已不在） | 见交付清单 | 🟢 低 |
| `apps/daemon/src/pipeline/vadResolve.test.ts` | `vad-fix`（已 DONE） | **只改一段注释**：原文说 `roleToStoreKind('vad')==='asr'`「是有意的」，那句话今天是假的。夹具本身一行未动（它现在的身份是"老机器的历史布局"，钉的是向后兼容） | 🟢 低 |
| `scripts/selfcheck.mjs` | `ci-runner` / 通用 | 加一个探针接线（纯追加 8 行） | 🟢 低 |
| `apps/web/**` | `frontend-truth` | **一个字节都没动**（只**读**了 `asrSections.ts` 与 i18n 来对齐文案，并把 i18n 当成测试的期望值来源） | — |
