# inbox / loose-ends

## [2026-08-03 21:55] T-135 DONE

## TL;DR (≤25 lines)

- **④ 优先项做完了，而且过程本身就是这一轮最贵的产出**：给 `packages/pipeline` 补 test 脚本时，
  我**差点原样抄 daemon/db 的那一行**。抄了会得到「脚本加上了、全绿、132 条只跑了 6 条」。
  真因：`node --test dist/**/*.test.js` **没加引号**，sh 不认 `**`，把它展开成「恰好两层」。
- 🔴 **同一个缺陷在 `apps/daemon` 上是活的**：它的 test 脚本**只跑到 13 个测试文件里的 9 个**。
  被漏掉的 4 个里有 **7 条是红的**，已经红了约 7 小时、跨 6 个提交，而 `pnpm -r test` 一路报绿。
  `dist/daemon.test.js`（一层深）**大概从写下这个脚本那天起就一次没跑过**。
- **那 7 条红的判据我查清了：不是产品坏了，是测试的前提失效了。** 决定性实验：
  `OPENMEMO_AUTH=token node --test …` → **14/14 + 16/16 全绿**。鉴权默认值在 `d12ab1e` 被翻成
  `none`（用户显式决定），这些用例仍按「鉴权开着」写，却没有切档。**我一个字都没改**（§3）。
- 🔴 **`d12ab1e` 是 ⑤J 串档的第五例，也是最严重的一例**：把**鉴权默认关闭**这条改动，
  装进了一个标题为「docs: memo.ac 内置清单取证 (T-113)」、正文通篇讲竞品 LLM 目录的提交里。
- 🟡 `packages/db` 的同一行**今天是靠运气对的**（三个文件都在一层 → sh 匹配不到 → 原样交给 node）。
  **任何人加一个两层深的测试文件，另外三个会当场静默消失。**（§2.4 有一行复现）
- **TD-002 那 7 条：全过（8/8，含同文件的 registry robustness）**，无需转写，**没跑任何 whisper**。
  但 🟡 **它们仍然不覆盖产品真实的那条装配路径** —— 测试里 `buildRegistry()` 是把
  `packages/pipeline/src/index.ts:269 buildDefaultRegistry()` **手抄了一份**。
  **这正是 TD-002 当年过早关闭的同一个形状**，别再单凭这 7 条说"已验证"（§3.4）。
- **① 做完**：`secureContext.caps.*` 逐项说明真的渲染出来了（展开态），麦克风那条的 `**` 走
  `<Emphasis>`，**没删星号**。折叠态仍然一行（T-107 那条约束没被吃掉）。
- **② 做完**：daemon `layout()` 补 `purpose` 英文对应（7 条），前端接 `pickLocalized()`。
  语言切换器里的「中文」**没动** —— 那是语言名本身，不是缺陷。
- **③ 做完**：`ComponentCard` 接 `localizedName()`。
- **反向验证 7 组，全部真的变红，真实输出见 §5**（含一次 sh glob 的活体复现：132 → 6）。
- **门禁**：`tsc -b` 0 · `eslint .` 0 · `pnpm -r test` **rc=0** ——
  db 47 / **pipeline 132（新）** / web 单测 27 + 宿主 10 + 组件 162 / daemon 116。
- **纪律**：`apps/web/dist` **一次都没构建**（mtime 仍是 21:00:11，不是我）；`:10000` 只读、pid 2992138 全程存活；
  `/root/data-memo` 零写入；未用 `pkill`；未起任何长驻进程；未 commit；未派 subagent。
- **需要 Manager 决策：4 条，见 §6**（daemon glob 怎么修 + 那 7 条测试归谁 + 串档第五例 + TD-002 覆盖缺口）。

---

## §1 交付清单（**请勿 `git add -A`**，本轮我的改动只有这 7 个文件）

```bash
git add packages/pipeline/package.json                                   # ④ test 脚本 + 护栏
git add apps/daemon/src/http/storageLayout.test.ts                       # ② 新文件
git add apps/daemon/src/http/rest/storage.ts                             # ② purpose 成对 + 导出 layout
git add apps/web/src/features/settings/DataLocationSection.tsx           # ② 接 pickLocalized
git add apps/web/src/components/common/ReadinessBanner.tsx               # ① 逐项明细 + Emphasis
git add apps/web/src/features/components/components/ComponentCard.tsx    # ③ 接 localizedName
git add apps/web/src/test/components.test.tsx                            # ⚠️ SHARED，纯末尾追加 +332 行
git add coordination/inbox/loose-ends.md
```

`git diff --stat apps/web/src/test/components.test.tsx` = **332 insertions, 0 deletions**（纯追加，
`8a48568` T-133b 的改动在 HEAD 里，我的块叠在它上面，复读过合并结果）。
写作期间 Manager 合并了 `a99ef7b` / `2f1e753` / `8a48568` / `ed9b17d`，**没有夹带我的文件**（逐个 `git show --stat` 核过）。

---

## §2 ④ —— 这条比交办时看起来的要大

### 2.1 我差一点交出一个假绿灯

daemon 与 db 的 test 脚本都是这一行：

```json
"test": "node --test dist/**/*.test.js"
```

照抄进 `packages/pipeline` 会得到这个 —— **这是实测输出，不是推演**：

```
### [R-A] 把 test 脚本换成 daemon/db 用的那个写法：node --test dist/**/*.test.js
▶ materializeSqliteExtensions
✔ materializeSqliteExtensions (46.568999ms)
ℹ tests 6      ← 全包实际有 132 条
ℹ suites 1     ← 全包实际有 10 个测试文件
ℹ pass 6
ℹ fail 0
### exit=0     ← 绿的
```

成因：**pnpm 用系统 `sh` 跑脚本，sh 不认 `**`**，`dist/**/*.test.js` 等价于 `dist/*/*.test.js`
（恰好两层）。`packages/pipeline` 只有 `dist/__tests__/extensions.test.js` 是两层，
其余 9 个在 `dist/<域>/__tests__/` 三层 —— 于是 **126 条一声不吭地不存在**。

```bash
$ sh -c 'echo dist/**/*.test.js'      # 在 apps/daemon 里
dist/db/richText.test.js dist/http/upload.test.js dist/jobs/lanes.test.js
dist/jobs/pipelineJobEvents.test.js dist/pipeline/ytdlpInstall.test.js
dist/storage/migrateAssets.test.js dist/storage/migrateRecords.test.js
dist/storage/move.test.js dist/storage/restart-datadir.test.js      ← 9 个，实际有 13 个
```

### 2.2 我写成了什么

```json
"test": "node -e \"<发现护栏>\" && node --test"
```

两处刻意：

1. **不给位置参数**，用 node 自己的默认发现（递归扫本包、跳过 `node_modules`）。
   实测与带引号的 glob 结果**逐条一致**（132 / 36 suites）。
   判据不是「要记得加引号」，是「**写错了也不会有后果**」—— 这条命令里已经没有会被 sh 吃掉的东西了。
   （与 §7 补充加 `build:safe` 是同一条道理。）
2. **前置护栏**，因为 `node --test` **对空集返回 exit 0**（⑤A-2，本项目已发生三次）：

```
$ node --test "dist/**/*.nosuchtest.js"
ℹ tests 0 … ℹ fail 0
rc=0                       ← 一个测试文件都没有，绿的
```

护栏断的是「**源码里有几个测试文件，dist 里就得有几个**」，所以它同时挡住"忘了 build"和"漏集"。

### 2.3 🔴 `apps/daemon` 上这个缺陷是活的（**只报不动**）

|          | 现在的脚本            | 带引号后                   |
| -------- | --------------------- | -------------------------- |
| 测试文件 | **9**                 | 13                         |
| 用例     | **113 pass / 0 fail** | 171：**164 pass / 7 fail** |

跑不到的 4 个文件：`dist/daemon.test.js`（**一层深**）、`dist/http/rest/content.export.test.js`、
`dist/http/rest/settings.roundtrip.test.js`、`dist/jobs/runners/retitle.test.js`（**三层深**）。
其中 `content.export`（22 条）与 `retitle`（6 条）是绿的，另外两个共 **7 条红**。

> ⚠️ 这也是我把 `storageLayout.test.ts` 放在 `src/http/` 而不是被测对象旁边 `src/http/rest/` 的原因
> —— 放对位置它会**一次都跑不到，而且不报错**。我在那个文件头写清了原委，
> 等 glob 修好之后应当把它挪回 `rest/` 旁边。**这是一处刻意的将就，不是我不知道它该放哪。**

### 2.4 🟡 `packages/db` 今天是靠运气对的

db 的三个测试文件都在 `dist/` 一层 → sh **匹配不到任何东西** → 按 POSIX 把 pattern **原样**交给 node
→ node 自己的 glob 认 `**` → 三个都跑到。**一旦有人加一个两层深的测试文件，另外三个当场消失**：

```
### 全部一层深时：sh 匹配不到，原样交给 node
dist/**/*.test.js
### 加了一个 dist/sub/c.test.js 之后：
dist/sub/c.test.js
↑ a.test.js 与 b.test.js 一声不吭地消失了
```

---

## §3 那 7 条红的：**是测试的前提失效了，不是产品坏了**（我一个字都没改）

### 3.1 现象

```
# apps/daemon，带引号跑全部 13 个文件
✖ 未认证请求被 401 拒绝            AssertionError: 200 !== 401
✖ 错误的 token 换不到 session
✖ cookie 通道的非 GET 请求缺 CSRF 头 → 403；带上则通过
✖ ★ 只带 cookie（无 Bearer）必须 200，且返回**可用的** CSRF 令牌
✖ 续签**复用同一个会话**（同一个 CSRF 令牌），不是每个标签新建一个
✖ 两者都无 → 仍 401，且带可执行的 remediation
✖ ★ 伪造/失效的 cookie → 必须 401（续签不等于放行任何 cookie）
ℹ tests 171  ℹ pass 164  ℹ fail 7
```

### 3.2 决定性实验（**先质疑测试，再质疑代码** —— ⑤A 规矩 2）

```
$ OPENMEMO_AUTH=token node --test dist/daemon.test.js
ℹ tests 14  ℹ pass 14  ℹ fail 0
$ OPENMEMO_AUTH=token node --test dist/http/rest/settings.roundtrip.test.js
ℹ tests 16  ℹ pass 16  ℹ fail 0
```

**产品没坏。** `OPENMEMO_AUTH` 的默认值在某次提交里从「开」翻成了 `none`（用户显式决定，
`auth.ts` 里有完整记录），而这些用例是在「鉴权必开」的年代写的，**没有切档**，
于是它们在 `none` 档下断言 `token` 档的行为。

**顺带证明了一件好事**：`token` 档**两个方向都还活着** ——
`auth.ts` 自己警告过的"把开关做成单向门"这次没有发生。

### 3.3 正确修法已经在同一个仓库里（**归 daemon owner，我不动**）

`settings.roundtrip.test.ts:118` 的 `CSRF 同源兜底` 那组早就把话说全了：

> ★ 这一组必须在 `OPENMEMO_AUTH=token` 下跑。默认档（none）连鉴权带 CSRF 一起跳过，
> 这些边界根本不存在 —— 若不显式切档，用例会"通过"得毫无意义，**或像这次一样变红却让人误以为是回归**。

照它加 `before/after` 切档即可（同时保住"开关的另一半"）。**我没有顺手改测试让它变绿。**

### 3.4 🟡 TD-002 那 7 条：全过，但**仍然没走产品真实的装配路径**

```
▶ TD-002 — the product survives removal of the GPL adapter
  ✔ resolves every core input WITHOUT the site extractor
  ✔ resolves the same inputs identically WITH the extractor enabled
  ✔ scores the GPL adapter strictly below every licence-clean adapter
  ✔ falls through to the extractor only AFTER the clean adapters actually decline
  ✔ never reaches the extractor when a clean adapter succeeds
  ✔ gives actionable remediation instead of a crash when the extractor is gone
  ✔ can toggle the adapter at runtime with no re-registration
▶ registry robustness
  ✔ a throwing adapter cannot take the registry down
ℹ tests 8  ℹ pass 8  ℹ fail 0
```

**全部是纯内存单测，不 spawn、不联网、不转写 —— 本轮没有跑任何 whisper。**

但要如实说清它们**没有**覆盖什么：测试里的 `buildRegistry()`（`ytdlpRemoval.test.ts:38`）
是把产品的 `buildDefaultRegistry()`（`packages/pipeline/src/index.ts:269`）**手抄了一份**，
`enableExtractor` 由用例自己传。于是：

- 产品那边默认值改了（`opts.enableSiteExtractor ?? true`）、注册顺序改了、少注册一个适配器 —— **这 7 条全不变色**；
- 而 T-132 实测查明，**F1 真正断掉的那道闸门恰恰就在这一层**（daemon 的 `siteExtractorEnabled()` 默认关着，
  自检报 `ok`、`tried:` 里连 yt-dlp 都不出现）。

**这与 TD-002 当年过早关闭是同一个形状**：测试走的是一条为测试而设的旁路。
今天这个洞由 `apps/daemon/src/pipeline/ytdlpInstall.test.ts` 从 daemon 那一层补上了（**而且它真的会跑**，两层深），
所以现在不是裸的 —— 但**别再单凭这 7 条说「GPL 组件架构上可替换」已验证**。
最小修法是让用例改调 `buildDefaultRegistry()`；**归 `gpu-runtime`，我只报不动。**

---

## §4 ①②③ 的改法

### ① `secureContext.caps.*`：算出来了就得给出去

`ReadinessBanner.tsx` 的 `ReadinessItem` 新增 `details?: readonly string[]`，
secure-context 那条填 `blocked.map((c) => t(\`secureContext.caps.${c.key}\`))`，
展开态渲染成一个 `<ul data-testid="readiness-caps-secure-context">`，**每条走 `<Emphasis>`**。

- **折叠态一个字都没多**（T-107 的「七行文字不是动作，是墙」没被吃掉），既有断言
  「非安全上下文只占一行，且默认折叠」仍绿。
- 麦克风那条 `**录音转文字不可用**` 渲染成 `<strong>`，**没删星号** ——
  它是四项里唯一**功能级不可用**的，删掉标记就跟其余三项一样平了。
- `EMPHASIS_REGISTRY` 里 `'secureContext.caps.microphone': []` 那条**现在有渲染点了**，
  但登记表结构没变（那条 `[]` 是 `models-page-fix` 留的，
  它的配套断言是"登记为无渲染点的词条不许被任何地方引用"—— 我引用的是**模板字面量**
  `caps.${c.key}`，不是 `'secureContext.caps.microphone'` 这个字面串，所以那条断言仍然成立且仍然绿）。
  ⚠️ **这一点我要明说**：那条断言现在是**过时的**（它描述的事实已经不成立了），
  只是恰好因为我用了模板拼接才没红。**建议 Manager 让 `models-page-fix` 把这条登记改成实际渲染点。**
  我没有去改别人的登记表。

**`featureKey` 仍然没有消费者**（`lib/secure-context.ts:32`，四个值 recorder/multiTab/storage/copy）。
我没有为它凭空造 4 条 `secureContext.features.*` 词条 —— 那是替别人的功能做决定，且英文无人校对。**只报不动。**

### ② `purposeZh` 成对

- `apps/daemon/src/http/rest/storage.ts` 的 `layout()`：7 条各补一份 `purpose`（英文）。
- `DataLocationSection.tsx`：`{e.purposeZh}` → `{pickLocalized(i18n.language, e.purposeZh, e.purpose)}`。
  类型上 `purpose?: string` **是可选的** —— 前端可以比 daemon 新，老 daemon 只给中文时
  `pickLocalized` 的空串回落会显示中文，**比显示一片空白好得多**（有专门一条用例钉住）。
- **契约两头都测**：前端那条是"英文界面下这一块不许有汉字"，daemon 那条在
  `apps/daemon/src/http/storageLayout.test.ts` —— 只测前端等于只测"我发了什么"
  （⑤C「写得进读不回」出过五次，全是这个形状）。
- **语言切换器的「中文」一个字没动**：语言名本来就该用它自己的语言写。
  daemon 侧那条断言我也按这个判据写：管的是 `purpose*` 字段的内容，**不是"全仓不许出现汉字"**。

⚠️ **同一个响应里还有 4 处只有中文的字段**：`externalFiles[].{purposeZh,whyOutsideZh,riskZh}` 与
顶层 `noteZh`。**它们今天没有任何渲染点**（全仓 grep：`apps/web` 零引用），
所以我没有为看不见的文字编英文。**只报不动**，形状与 `caps.*` 那条同族。

### ③ `ComponentCard`

`{c.displayNameZh}` → `{localizedName(locale, c)}`。`vendor/manifests/components.json`
**8 条组件每一条都同时有** `displayName` 与 `displayNameZh`（实测逐条打印过），
`packages/shared` 的 `ComponentStatus` 两个字段也都在 —— 数据齐全、契约齐全。

⚠️ 这张卡**其余部分仍然整片硬编码中文**（「有新版本」「目录钉定」「来源」…），
那是 `ui-polish` 在 T-101 报的 **T-022 的又一半**，与本条不是同一个缺陷。
**本轮没做**（超出交办范围，且我不想半做）。所以我的断言钉在 `h3` 上，不是"整页无汉字"。

---

## §5 反向验证（7 组，**真实输出**，每组撤掉后都已还原）

**[R-A] ④ 抄 daemon 的那一行** —— 见 §2.1（132 → **6**，exit 0）。

**[R-B] ④ 假装 TD-002 那个文件没编出来（dist 少一个）**

```
Error: test discovery broken: 10 source test files vs 9 compiled in dist —— 先 pnpm build:safe；node --test 对空集/漏集一律返回绿
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @openmemo/pipeline@0.0.0 test
### exit=1
```

**[R-①a] 撤掉逐项明细，退回只取 `blocked.length`**

```
ℹ tests 162  ℹ pass 159  ℹ fail 3
✖ ★ 展开后逐项列出失去的能力，且与 detectBlockedCapabilities() 逐条对齐
  AssertionError: 展开后没有任何逐项明细 —— 计数之外一个字都没有
✖ ★ 麦克风那条的 ** 必须渲染成 <strong>，页面上看不到裸星号
  AssertionError: 「录音转文字不可用」应渲染成 <strong>，实际 strong = []
✖ ★ ReadinessBanner 必须真的 import Emphasis（注释里提一句不算）
  AssertionError: 逐项说明没有从 detectBlockedCapabilities() 接出来
```

**[R-①b] 明细保留，但不走 `<Emphasis>`（直接吐词条原文）**

```
ℹ tests 162  ℹ pass 160  ℹ fail 2
✖ ★ 麦克风那条的 ** 必须渲染成 <strong>，页面上看不到裸星号
  AssertionError: 页面上仍能看到裸的 ** → …·**录音转文字不可用** —— 浏览器只在安全上下文下开放麦克风。·多标签页选
```

**[R-②a] 前端改回直接渲染 `e.purposeZh`**

```
ℹ tests 162  ℹ pass 160  ℹ fail 2
✖ ★ 英文界面下目录清单不许出现汉字 —— 它此前是 /settings 上 81 个汉字的来源
  AssertionError: → ["his directoryopenmemo.db笔记、转写稿、标签、导图（SQLite 主库）lo","gs运行日志（可随时删）The daemon reports the "]
✖ ★ 前端确实走了 pickLocalized，而不是又写死一份
  AssertionError: 仍有地方直接渲染 e.purposeZh —— 英文界面会退回中文
```

**[R-②b] daemon 少给一条 `purpose`（logs）**

```
ℹ tests 3  ℹ pass 2  ℹ fail 1
✖ 每一条都同时有 purpose 与 purposeZh，且都不是空的
  AssertionError: 这些目录缺一份用途文案 —— 前端在那个语言下没有任何可回落的东西：logs
```

**[R-②c] daemon 把中文原样抄进 `purpose`（字段在、内容没变）**

```
ℹ tests 3  ℹ pass 2  ℹ fail 1
✖ purpose 里不许出现汉字，purposeZh 里必须有汉字（防两边互相抄）
  AssertionError: backups 的 purpose 里有汉字，等于没给英文：数据库备份
```

**[R-③] `ComponentCard` 改回写死 `displayNameZh`**

```
ℹ tests 162  ℹ pass 160  ℹ fail 2
✖ ★ 英文界面下卡片标题用 displayName，不是 displayNameZh
  AssertionError: 英文界面上仍然显示中文名 —— 英文版一直就在目录里，只是没被挑出来
✖ ★ ComponentCard 真的 import 了 localizedName（不是注释里提一句）
  AssertionError: 仍有地方直接渲染 c.displayNameZh
```

### 5.1 两个"验证手段自己有缺陷"的坑，我按你说的绕开了

1. **断源码断结构，不断关键词。** 三条源码断言全部断 **import 语句**
   （`/^import \{[^}]*\bX\b[^}]*\} from '[^']*\/Y';$/m`），不是 `/\bX\b/` ——
   后者会被自己旁边的注释骗过去（`models-page-fix` T-129b §A④ 的原案）。
   我在 `ReadinessBanner.tsx` 与 `ComponentCard.tsx` 的注释里**都提到了 `<Emphasis>` / `localizedName`**，
   所以那个假绿的面是真实存在的 —— 反向验证 [R-①a] / [R-③] 证明它现在红得掉。
2. **DOM 节点绝不进 `assert.equal`**（PROTOCOL §8）。新增用例里所有存在性判断都是
   `assert.ok(el, msg)` / `assert.ok(!container.querySelector(sel), msg)`，
   比较的都是布尔或字符串，**没有一处把 Element 放进 actual/expected**。
3. 顺带把三条源码断言从 `assert.match(src, re)` 改成 `assert.ok(re.test(src))`：
   前者失败时会把**整份源码**（40+ KB）打进报告，把真正的结论淹掉。第一次跑 [R-①a] 时就撞上了。

### 5.2 桩数据用的是目录真实形状

- `②` 的桩：`purpose` + `purposeZh` **成对**给（还有一条**只给 `purposeZh`** 的，专门测回落）。
- `③` 的桩：抄 `components.json` 里 `libsimple-linux-x64` 的真实两份名字。
- `①` 的期望值**从 `zh-CN.json` 现场读**（`secureContext.caps[c.key]`），不是我手打的一句话 ——
  词条改了断言自动跟着改，不会退化成一张过期的对照表。

---

## §6 需要 Manager 决策

1. **🔴 `apps/daemon` 的 test glob 怎么修（§2.3）。** 一行的事（加引号或去掉位置参数），
   但**修完 `pnpm -r test` 会立刻红 7 条**。所以它和第 2 条必须一起裁决，否则修的人会被迫去动别人的测试。
   顺带请一并看 `packages/db`（§2.4，今天靠运气对）。修好后请把
   `apps/daemon/src/http/storageLayout.test.ts` 挪回 `src/http/rest/` 被测对象旁边。
2. **🔴 那 7 条鉴权用例归谁改（§3）。** 判据已经查清（前提失效，不是回归），
   修法在同一个文件里就有现成范本（`before` 里切 `OPENMEMO_AUTH=token`）。**归 `oss-scout`。**
   ⚠️ 别顺手把断言改成"200 也算过"—— 那会把 `token` 档的全部边界一起删掉。
3. **🔴 ⑤J 串档第五例，且是最严重的一例。** `d12ab1e`（14:16）标题是
   「docs: memo.ac 内置清单取证 —— 24 家供应商 / 520 条模型 (T-113)」，正文通篇讲竞品 LLM 目录，
   实际装着 `apps/daemon/src/http/{auth.ts,server.ts}` 的改动 —— **即"鉴权默认关闭"这条**。
   前四例污染的是"F3 是怎么接通的"这类问题；**这一例污染的是"鉴权是什么时候、被谁、依据什么关掉的"**。
   建议在 HANDOFF ⑤J 的表里补这一行（我没改 HANDOFF，那是 `handoff` 的交付物）。
4. **🟡 TD-002 的覆盖缺口（§3.4）** 要不要立任务：让那 7 条改调 `buildDefaultRegistry()`。归 `gpu-runtime`。

### 附：三条"只报不动"（别人地界）

- `secureContext.featureKey` 仍无消费者（§4①）。
- `EMPHASIS_REGISTRY` 里 `'secureContext.caps.microphone': []` **现在过时了**（§4①）—— 归 `models-page-fix`。
- `rest/storage.ts` 响应里另外 4 个只有中文的字段，**今天没有渲染点**（§4②）。
- `ComponentCard` 其余部分整片硬编码中文 = T-022 的又一半（§4③）—— 归 `ui-polish` / `architect`。

---

## §7 门禁

```
tsc -b                      → rc=0，0 错
eslint .                    → rc=0，0 错 0 warning
pnpm build:safe             → rc=0（**没有跑过 pnpm -r build，也没跑过 vite build**）
pnpm -r test                → rc=0
  packages/db               47  pass / 0 fail
  packages/pipeline        132  pass / 0 fail   ← 本轮新接进来的，此前从来没被跑过
  apps/web  test:unit       27  pass / 0 fail
  apps/web  test:host       10  pass / 0 fail
  apps/web  test:components 162 pass / 0 fail / 0 skipped（本轮新增 12 条）
  apps/daemon              116  pass / 0 fail（本轮新增 3 条：113 → 116）
```

`pnpm -r test` 的 `Scope` 从 3 个有测试的包变成 **4 个**。

---

## §8 环境与纪律

- **`apps/web/dist` 一次都没构建**：`index.html` mtime 仍是 `2026-08-03 21:00:11`（`ytdlp-install` 那次的产物，不是我）。
  验证构建全程只用 `pnpm build:safe`；组件测试走 `vite build --ssr … --outDir .test-out/components`，不写 dist。
- **`:10000` 只读**：全程只 `GET /api/health`；收尾复核 200，pid **2992138** 存活（未重启、未 kill、未占该端口）。
- **`/root/data-memo` 零写入**：一个字节没碰，连列目录都没有。
- **未用 `pkill`**：本轮没有起任何长驻进程（没起 daemon、没起 vite dev），因此一次 `kill` 都没执行。
- **未跑任何本地 whisper 转写**（按用户指令）。④ 的 132 条**全部是纯内存单测**，
  不 spawn 子进程、不联网、不需要模型 —— **没有任何一条因此被标 `[未跑通]`**。
- 未 commit。未派生 subagent。未碰 `apps/web/src/test/{host.tsx,dom-env.ts}`、`tsconfig.test.json`
  （`test-host` 的地界；它的 T-133/T-133b 已在我写作期间被合并，我的用例**零文本输入依赖**，
  只用 `click()` + `querySelector` + 源码断言，逐条 grep 确认过）。
- 临时产物都在仓库外：`/tmp/rev.py`、`/tmp/unrev.sh`、`/tmp/loose-ends-pkg.bak.json`。
  `find . -name '*.revbak'` 全仓 **0 命中**（反向验证的备份已全部还原并删除）。

---

## §9 诚实声明

- §2 / §3 / §5 的每一段带 `✖` / `AssertionError` / `ℹ tests` 的输出**都是从终端复制的**，
  不是我预期的样子。[R-A] 那个 `tests 6 / exit=0` 尤其是 —— 那是我**差点交出去的东西**。
- **④ 的 7 条我全跑通了，没有一条需要真转写，所以没有 `[未跑通]`。**
- **反向验证 [R-②b] 之后我被自己骗过一次**：还原源码后重跑仍是 `2 pass 1 fail`。
  真因是 `mv` 恢复备份时 mtime 倒退，**`tsc -b` 的增量判断没认出文件变了，dist 是旧的**。
  `touch` 后重建即 3/3 绿。**我把它写出来而不是当作没发生** —— 这条同样是"验证手段自己有缺陷"的一族，
  凡是"改源码 → 重建 → 跑测试"的反向验证都可能踩到。
- §3 的结论「产品没坏」依据的是 `OPENMEMO_AUTH=token` 下 14/14 + 16/16 全绿这一个实验。
  我**没有**在真浏览器里验过 token 档的完整握手往返 —— 那超出本轮范围。
- `layout()` 的 **7 条英文用途文案是我写的，未经母语校对**。
- 本轮**没有开真浏览器复核**（改动都有组件测试覆盖，且我不想为截图去动 `:10000` 或起服务）。
  所以「英文界面下 /settings 汉字数 81 → 0」这句我**只从组件测试的断言层面说得准**，
  **整页汉字数我没有实测**，不声称。
- `packages/pipeline` 与 `apps/daemon` 都不是我的常驻地界，两处改动都做了 SHARED-CHANGE 式的说明。

---

## [2026-08-03 22:35] T-135b DONE —— Manager 四条追加指令的回执

## TL;DR (≤25 lines)

- **1. `apps/daemon` 的 test 脚本已修。** 用的是 pipeline 里验证过的那套（node 默认发现 + 前置守卫），
  **不是换个通配符**。效果：**116 → 177**（同一棵树、同一次构建，只是脚本换了）。
  之前那 61 条不是新写的，是**一直存在、一直没被跑到**的。
- **2. `packages/db` 一起修了，三个包用的是逐字相同的一行**（db / pipeline / daemon）。
  `apps/web` 是**必须保留的例外**，理由是实测出来的：它不能用默认发现，
  否则 `.test-out/{components,host}` 会被一起扫进来、组件套件在单测那一步再跑一遍。
  它的 glob **一直是带引号的**（正确），我给它补了**另一个面**的守卫：
  `tsconfig.test.json` 的 include 是显式白名单，**新写一个单测忘了加进去 = 永远不跑且零提示**。
- **3. 那 7 条鉴权用例已改，判据按你给的那条来做的**：不是"让它变绿"，是
  **"默认值再翻一次也不该让它红"**。新增 `pinAuthMode()`，用例**显式声明自己要哪一档**。
  🔬 **判据实验（不是 env 覆盖，是真把默认值翻过去）**：把 `auth.ts` 的默认改成 `token` 后
  跑**全部** daemon 测试 → **177/177 全绿**。两个方向 + 默认翻转，三种情况全跑了（§B）。
- **同时补上了 T-134 的自动化覆盖。** 把那 7 条钉到 `token` 之后，`none` 档就一条覆盖都没有了 ——
  **那等于把洞换个位置再挖一遍**。T-134 的反向验证当时是**手工**跑的、没留用例，
  所以新增「鉴权关闭档」一组 3 条（握手必须 200 + `authMode:'none'` + 写请求免 CSRF）。daemon 14 → 17。
- **4. TD-002 那段警告已经写进代码**：`ytdlpRemoval.test.ts` 文件头三节
  （覆盖什么 / 不覆盖什么 / 从没被跑过），并在 `buildRegistry()` 上方单独标注
  **"这是 `buildDefaultRegistry()` 的手抄副本，不是它本身"**。
- **HANDOFF 两处已回写**：⑤J 补第五例 `d12ab1e`（含 commit 号与后果分析）；
  ⑤A 补 **#19**（sh 吃掉 `**`）；「测试怎么跑」一节同步到 4 个包 + 新的基线数字，
  并特别注明 **daemon 113→177 不是有人写了 64 条新测试**，拿旧数字做基线会对不上。
- **反向验证 6 组，全部真的变红，真实输出见 §C。** 其中 [R-5] 重演了 `AUTH_MODE` 单向门：
  让 `authMode()` 忽略环境变量，**pin 自己当场红**并说清"想要 token、实际 none"。
- **门禁**：`tsc -b` 0 · `eslint .` rc=0 零输出 · `pnpm -r test` rc=0 ——
  db 47 / pipeline 132 / web 27+10+162 / **daemon 177** = **555 passed, 0 failed**。
- **纪律不变**：`apps/web/dist` mtime 仍是 21:00:11（一次都没构建）；`:10000` 只读、pid 2992138 存活；
  `/root/data-memo` 零写入；未用 `pkill`；未 commit。**精确清单见 §E。**
- **§D 是你点名要的那段教训**（`mv` 让 mtime 倒退 → `tsc -b` 增量判断被绕过 → 我跑的是旧产物）。

---

## §A 四件事分别做了什么

### A1 · `apps/daemon` 的 test 脚本（最优先）

```diff
- "test": "node --test dist/**/*.test.js"
+ "_comment:test": "★ T-135：不要写成 node --test dist/**/*.test.js …（长注释，讲清三个包各自的实测后果）"
+ "test": "node -e \"<发现守卫>\" && node --test"
```

**同一棵树、同一次构建，只换脚本**：

|           | 旧脚本       | 新脚本       |
| --------- | ------------ | ------------ |
| 测试文件  | 9            | **13**       |
| 用例      | **116** pass | **177** pass |
| exit code | 0            | 0            |

**两个都是"绿"**，这正是它最坏的地方。你说的那句我原样记在 HANDOFF ⑤A-19 里了：
**它污染的是判断依据本身**——据「门禁全绿」做过的每一次决定，当时都建立在一个漏跑 30% 的脚本上。

守卫是**必需**不是可选，理由已实测：

```
$ node --test "dist/**/*.nosuchtest.js"
ℹ tests 0 … ℹ fail 0
rc=0                     ← 空集，绿
```

### A2 · `packages/db` 与全仓扫描

全仓 10 个 workspace，有 `test` 脚本的是 **4 个**（其余 5 个包没有测试脚本，靠包内 `verify-*.mjs`）：

| 包                  | 改前                            | 改后                 | 说明                                                                 |
| ------------------- | ------------------------------- | -------------------- | -------------------------------------------------------------------- |
| `packages/db`       | `node --test dist/**/*.test.js` | **统一**             | 你的定性完全对：**它正确的原因是 sh 匹配不到、原样透传**，不是写对了 |
| `packages/pipeline` | （T-135 我写的那版）            | **统一**（逐字相同） |                                                                      |
| `apps/daemon`       | 同 db                           | **统一**（逐字相同） |                                                                      |
| `apps/web`          | `test:unit` + `test:components` | **保留结构，补守卫** | 见下                                                                 |

**`apps/web` 为什么必须是例外 —— 这是实测出来的，不是我不想统一**：

```
$ node --test .test-out/unit          # 目录参数：Node 24 把它当模块去 require
Error: Cannot find module '/root/memo/apps/web/.test-out/unit'
$ node --test                          # 默认发现：会把 .test-out/{components,host} 一起扫进来
                                       # → 组件套件在单测这一步被重复跑一遍
```

所以 web 必须显式指路径，而**它的 glob 一直是带引号的**（`\".test-out/unit/**/*.test.js\"`）——
带引号 = sh 不碰 = node 自己的 glob 生效，**这一条本来就是对的，我没有动它**。

但它有**另一个面**的漏集风险，而且是结构性的：`tsconfig.test.json` 的 `include` 是一张
**显式白名单**（当前 3 个单测文件）。新写一个 `src/**/*.test.ts` 却忘了加进去，
它**永远不会被编译、也永远不会被跑，一个字都不报** —— 该文件自己的注释里已经写着这条隐患。
所以给它补的守卫断的是：`src/**/*.test.ts` 的数量必须等于 `.test-out/unit/**/*.test.js` 的数量。

**没留第三个"碰巧"**：db / pipeline / daemon 三行逐字相同；web 是有实测理由的例外，
理由写进了它自己的 `_comment:test:unit` 和 HANDOFF「测试怎么跑」。

### A3 · 7 条鉴权用例（你授权后改的）

新增 `apps/daemon/src/http/authMode.testkit.ts` → `pinAuthMode(mode)`：

- 在 `describe` 里注册 `before`/`after`，**用例显式声明自己要哪一档**，默认值从此只是默认值；
- **钉完立刻回读一次 `authMode()` 断言生效** —— 因为"设 env 这个动作本身可能不生效"
  正是 `AUTH_MODE` 单向门那次的形态（那时它是模块加载时求值的 `export const`）。
  前提不成立就**当场红**，而不是让后面几十条断言去表达它。

改了三处：

| 位置                                              | 改法                                                                                                                        |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `daemon.test.ts` 「鉴权链路」                     | 加 `pinAuthMode('token')` + 一段说明为什么它红了却没人看见                                                                  |
| `settings.roundtrip.test.ts` 「仅凭 cookie 续签」 | 加 `pinAuthMode('token')` + 说明                                                                                            |
| `settings.roundtrip.test.ts` 「CSRF 同源兜底」    | 就地写的 before/after **换成同一个 helper**（它原来的注释是对的、做法也是对的，**只是隔壁那组没照做**，我把这句写进注释了） |

**断言一个字没改。** 没有把 401 改成"200 也算过"—— 那会把 token 档的全部边界一起删掉。

### A3-bis · 顺带补上 T-134 的自动化覆盖（**这不是加戏，是不把洞换个位置再挖一遍**）

把那 7 条钉到 `token` 之后，`none` 档（当前默认）就**一条覆盖都没有了**。
而 T-134 的反向验证当时是**手工**跑的（两个方向都跑了，写在 commit message 里），
**没有留下任何自动化用例**。所以新增 `daemon.test.ts` 的「鉴权关闭档」一组 3 条：

- ★ 不带任何凭据的握手必须 200（否则前端 `authed` 恒 false，**全站 SSE 从不建立**）+ `authMode:'none'` + 仍发 CSRF 令牌
- 未认证的 GET 直接放行（正是上面那条 401 断言的**反面**）
- 写请求不带 CSRF 头也放行

**开关的两个方向现在都有人守。**

### A4 · TD-002 的警告落进代码

`packages/pipeline/src/media/__tests__/ytdlpRemoval.test.ts` 文件头新增三节：

1. **这 7 条不足以宣布「TD-002 已验证」** —— 点名它曾被过早关闭过一次，
   并具体写出**今天仍带着同一个形状的缺口**：本文件的 `buildRegistry()` 是
   `buildDefaultRegistry()`（`src/index.ts`）的**手抄副本**，所以产品那边改默认值 / 改注册顺序 /
   少注册一个适配器 / daemon 把提取器整个关掉 —— **这 7 条全不变色**；
   而最后那一条**真的发生过**（T-132：自检 `ok`、磁盘上装着、F1 回 422、`tried:` 里连 yt-dlp 都没有）。
2. **它到底证明了什么**（✅ registry 这一层 / ❌ 产品真实装配、❌ daemon 会不会注册），
   并指明另一半在 `apps/daemon/src/pipeline/ytdlpInstall.test.ts`：**两边合起来才算验过**。
3. **这 7 条从写下来那天起一次都没被跑过** ——
   「为一次事故补了回归测试」和「那些回归测试真的在跑」是两件事。

另在 `buildRegistry()` 正上方单独标了一行：**「这是手抄副本，不是它本身；改它之前先读文件头」**
—— 文件头容易被跳过，而改这个函数的人一定会看到紧挨着它的那句。

---

## §B 判据实验：**默认值再翻一次也不该让它们红**

不是 env 覆盖，是**真的把 `auth.ts` 里的默认值翻过去**再跑全部 daemon 测试：

```
### 把 authMode() 的默认从 none 翻成 token（模拟"默认值再翻一次"）
ℹ tests 177  ℹ suites 40  ℹ pass 177  ℹ fail 0
```

**全绿 —— 而且是整个 daemon 套件，不只是我改的那两个文件**，说明没有别的用例暗中依赖默认值。

两个方向的 env 也都跑了（改动落地后）：

```
########## OPENMEMO_AUTH=token
--- dist/daemon.test.js                  ℹ tests 17  ℹ pass 17  ℹ fail 0
--- dist/http/rest/settings.roundtrip.test.js   ℹ tests 16  ℹ pass 16  ℹ fail 0
########## OPENMEMO_AUTH=none
--- dist/daemon.test.js                  ℹ tests 17  ℹ pass 17  ℹ fail 0
--- dist/http/rest/settings.roundtrip.test.js   ℹ tests 16  ℹ pass 16  ℹ fail 0
```

**默认档（不设 env）** 同样 17/17 与 16/16。三种情况全绿。

---

## §C 反向验证（6 组，真实输出，每组都已还原）

**[R-1] `apps/daemon` 换回旧的那一行**（就是今天一直在跑的那个）

```
ℹ tests 116  ℹ suites 25  ℹ pass 116  ℹ fail 0
rc=0                                             ← 绿
### 已还原
ℹ tests 177  ℹ suites 40  ℹ pass 177  ℹ fail 0
```

**同一棵树、同一次构建，61 条用例的差别，两边都是 exit 0。**

**[R-2] daemon：假装有个测试文件没编出来**

```
Error: test discovery broken: 14 source test files vs 13 compiled in dist —— 先 pnpm build:safe；node --test 对空集/漏集一律返回绿
Exit status 1
```

**[R-3] db：同上**

```
Error: test discovery broken: 3 source test files vs 2 compiled in dist —— …
Exit status 1
```

**[R-4] 撤掉两处 `pinAuthMode`（回到依赖默认值）**

```
ℹ tests 177  ℹ pass 170  ℹ fail 7
✖ 未认证请求被 401 拒绝
✖ 错误的 token 换不到 session
✖ cookie 通道的非 GET 请求缺 CSRF 头 → 403；带上则通过
✖ ★ 只带 cookie（无 Bearer）必须 200，且返回**可用的** CSRF 令牌
✖ 续签**复用同一个会话**（同一个 CSRF 令牌），不是每个标签新建一个
✖ 两者都无 → 仍 401，且带可执行的 remediation
✖ ★ 伪造/失效的 cookie → 必须 401（续签不等于放行任何 cookie）
```

↑ **一模一样的 7 条**回来了。

**[R-5] 让 `authMode()` 忽略环境变量（重演 `AUTH_MODE` 单向门）—— 看 pin 自己会不会红**

```
AssertionError [ERR_ASSERTION]: 钉鉴权档没有生效（想要 token，实际 none）—— 后面每一条断言都会在错误的前提下跑
'none' !== 'token'
```

↑ 这正是 pin 里那句回读断言存在的理由：**没有它，症状会表现成"7 条业务断言莫名其妙全红"，
而真因是"前提根本没设上"** —— 那会把人引向去改断言。

**[R-6] web：新写一个单测但忘了加进 `tsconfig.test.json` 的 include**

```
Error: test discovery broken: 4 个 src/**/*.test.ts vs 3 个编进 .test-out/unit —— 新加的单测要写进 tsconfig.test.json 的 include；node --test 对空集/漏集一律返回绿
 ELIFECYCLE  Command failed with exit code 1.
```

---

## §D ⚠️ 教训：**反向验证时，先确认你跑的真是刚改过的那份产物**

上一轮 [R-②b] 我被骗过一次：改坏 → 变红（对）→ 还原 → **重跑仍然红**。

真因不是没还原干净，是 **`mv` 把备份文件还原回去时带的是更早的 mtime**，
`tsc -b` 的增量判断因此认为"源码没变"，**根本没重新编译** —— 我跑的是**改坏那一版的 dist**。

这和 `models-page-fix` 被自己注释里的一句话骗过、`test-host` 发现覆盖率看不出空断言，
是**同一族：验证手段自己有缺陷**。它特别阴，因为表现是"修复没生效"，
会把人推去改一个根本没坏的东西。

**本轮的做法（已成为我每次还原后的固定动作）**：

```bash
/tmp/unrev.sh <file> && touch <file> && pnpm --filter <pkg> build
grep -c "<改坏时才有的那行字面量>" <pkg>/dist/<对应产物>.js     # 必须是 0
```

§B / §C 里每一次还原后我都跑了这个 `grep -c … → 0` 的确认，输出在终端里。
**判据：不要问"我还原了吗"，要问"我现在跑的这份产物里，改坏的那行还在不在"。**

---

## §E 精确提交清单（**请勿 `git add -A`**）

```bash
# 1 + 2 · 测试脚本统一
git add apps/daemon/package.json
git add packages/db/package.json
git add packages/pipeline/package.json
git add apps/web/package.json                       # 只改 test:unit + 加 _comment:test:unit

# 3 · 7 条鉴权用例 + 开关的另一半
git add apps/daemon/src/http/authMode.testkit.ts    # 新文件
git add apps/daemon/src/daemon.test.ts
git add apps/daemon/src/http/rest/settings.roundtrip.test.ts

# 4 · TD-002 警告落进代码
git add packages/pipeline/src/media/__tests__/ytdlpRemoval.test.ts

# 回写
git add HANDOFF.md                                  # ⑤J 第五例 + ⑤A #19 + 「测试怎么跑」
git add coordination/inbox/loose-ends.md
```

⚠️ `apps/web/package.json` 上一次动它的是 `test-host`（`a99ef7b`）。
我**只改了 `test:unit` 一条并新增一条 `_comment:test:unit`**，`test:host` / `test:components` 一个字没动。
⚠️ `HANDOFF.md` 是 `handoff` 的交付物，我按你的指令改了三处（⑤J / ⑤A#19 / 「测试怎么跑」），
**都是追加或订正过期事实，没有删改别人写的结论**。

---

## §F 门禁

```
tsc -b        → rc=0，0 错
eslint .      → rc=0，零输出
pnpm build:safe → rc=0（**全程没跑过 pnpm -r build / vite build**）
pnpm -r test  → rc=0
  packages/db               47
  packages/pipeline        132
  apps/web  test:unit       27
  apps/web  test:host       10
  apps/web  test:components 162
  apps/daemon              177   ← 本轮 116 → 177（+61 是"回来了"，不是"新写的"）
  ────────────────────────────
  合计                      555 passed / 0 failed / 0 skipped
```

---

## §G 诚实声明

- §A/§B/§C 里每一段带 `ℹ tests` / `✖` / `Error:` 的输出**都是从终端复制的**。
- **daemon 从 116 涨到 177，没有一条是"我新写的测试凑出来的"**：我新增的只有 3 条
  （`none` 档那一组）+ 上一轮的 3 条（storageLayout）。剩下 **58 条是本来就存在、从没被跑到过的**。
- **`apps/web` 我没有强行统一成和另外三个包一样** —— 理由是实测的（默认发现会把组件套件扫进来、
  目录参数在 Node 24 上直接报 MODULE_NOT_FOUND），两条命令的原始输出在 §A2。
  如果你认为仍应统一，请裁决，我不自作主张。
- **TD-002 那个缺口我只写了注释，没有动那 7 条的实现**（改成调 `buildDefaultRegistry()` 归 `gpu-runtime`）。
  注释里明写了"最小改进（尚未做）"，**没有把它说成已经修了**。
- `pinAuthMode` 放在 `src/http/authMode.testkit.ts`（不是 `*.test.ts`，所以不会被当成测试文件、
  也不会被发现守卫计数）—— 这一点我实测确认过：daemon 的守卫读到的是 **14 个源测试文件 / 14 个产物**。
- **本轮没有开真浏览器，没有起任何长驻进程，因此一次 `kill` 都没执行。**
- 未跑任何本地 whisper 转写。未派生 subagent。未 commit。
