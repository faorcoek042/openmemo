# inbox: test-host

## [2026-08-03 21:05] T-133 SHARED-CHANGE 申报（动手前）

我要改的共享文件，以及为什么必须是这几个：

| 文件 | 改动 | 兼容性 |
|---|---|---|
| `apps/web/src/test/host.tsx` | 把 `@testing-library/react` 从静态 import 改成**动态 import**（延迟到 `dom-env` 装好全局之后）；`type()` 首次调用时做一次一次性自检 | **完全向后兼容**：所有导出签名不变（`render`/`click`/`type`/`pressKey`/`blur` 本来就是 async），已有调用点一个字都不用改 |
| `apps/web/src/test/dom-env.ts` | 只加注释更正（jsdom 30 下 `'oninput' in document` 已经是 true，那段修补现在是死代码），**不删逻辑** | 无行为变化 |
| `apps/web/package.json` | `test:components` 前面**追加**一条新测试文件的 build+run（新增，不改原有那条） | 脚本名不变，`pnpm test` 行为不变（多跑一个套件） |
| `apps/web/src/test/host.test.tsx` | **新文件** | 无冲突 |

**不会碰** `apps/web/src/test/components.test.tsx`（`models-page-fix` 在改）。

---

## [2026-08-03 21:25] T-133 DONE

### TL;DR（≤25 行）

1. **根因和 `storage-fix` 报的现象一致，但病根不在它猜的地方 —— 也不在 `type()` 里。**
   `type()` 的写法（`fireEvent.change`）**从来就是对的**；坏的是 **react-dom 的模块初始化时机**。
2. `vite build --ssr` 把 `@testing-library/react` 这种外部依赖的 `import` **提升到包体最顶部**，
   而 `dom-env` 是相对导入、被**内联进包体** → react-dom 在**还没有 `window`** 时初始化 →
   `canUseDOM=false` → `isInputEventSupported=false` → 文本输入改走 IE 的 `onpropertychange`
   polyfill 分支，**`input`/`change` 事件被整段丢弃**。`<select>` 走另一条分支，所以它是好的。
   → 三种派发写法全都不管用，正是因为**问题在事件到达之前**。`[实测]` 见 §2。
3. 修法：`host.tsx` 里把 RTL 改成**动态 import**（求值时机落到包体内，dom-env 已跑完）。
   导出签名一个没改，150 条已有用例一个字没动。
4. **新增自证套件 `host.test.tsx`（14 条）**，判据一律是「**渲染出来的 state**」而不是 `input.value`
   —— 受控组件在缺陷状态下这两者恰好分叉，拿 DOM 值当判据等于再写一盏假绿灯。
5. **反向验证做了（§4）**：把宿主换回原版（`git show HEAD:` 那份），同一套 14 条 **10 条真的变红**，
   贴了真实输出，包括 react-dom 抛出的 `activeElement$1.attachEvent is not a function`。
6. **存量排查结论：一条"之前绿、现在红"的都没有（§5）。** 我用了 4 种方法交叉验，不是只跑一遍。
   同一棵源码树 A/B 两次跑：**150 tests / 148 pass / 0 fail / 2 skipped，两次完全一致**。
7. **原因不是"没人写过输入测试"，而是前几轮的人都绕过去了**：2 条直接 `{skip:true}`、
   1 条抽纯函数测规则、1 条改成直接渲染子组件 + 真 HTTP。**这个洞的代价是"少测"，不是"错测"。**
8. **但我找到了 3 个别的东西**：① `blur()` **重复触发 onBlur 两次**（RTL 的 `fireEvent.blur` 自带
   `focusOut`，宿主又补了一次）—— 已修，"失焦保存"这类组件在测试里会发**两条**请求；
   ② `components.test.tsx:105` 那段跳过理由的**诊断是错的**（写"onChange 触发得到但不重渲染"，
   实测 onChange **一次都没进**，调用次数 = 0）；③ 两条 SearchBox 用例**钉不住任何东西**（§6）。
9. **产品缺陷：一个都没找到。** 我把 6 条"以前根本跑不了"的输入→提交链路全跑了一遍
   （TagEditor / LLM apiKey / 代理×3 / 捕获 / 数据目录），请求方法、路径、请求体**全部正确**（§7）。
10. ⚠️ **`apps/web/dist` 在 21:00:11 被人重新构建过，不是我**（证据见 §9）。请核。
11. 门禁：`tsc -p apps/web/tsconfig.json = 0` · `eslint（我的 3 个文件）= 0` ·
    `pnpm --filter web test:components` = **host 14/14 + components 150（148 pass / 0 fail）** ·
    `test:unit 27/27`。未碰 `/root/data-memo`，未碰 `:10000`，全程没用 `pkill`。
12. **需要 Manager 决策**：那 2 行 `{skip:true}` 现在没理由了，但在 `models-page-fix` 手上的文件里；
    我在自己的新文件里重建了等价用例，**没动他那两行**。见 §8。

---

### 1. 交付与 `git add` 清单（**没有用 `git add -A`**）

```
git add apps/web/src/test/host.tsx \
        apps/web/src/test/host.test.tsx \
        apps/web/src/test/dom-env.ts \
        apps/web/package.json \
        coordination/inbox/test-host.md
```

`git diff --stat`：`package.json +4/−2` · `dom-env.ts +18/−0` · `host.tsx +147/−14` ·
`host.test.tsx` 新文件。**`components.test.tsx` 我一个字节没写**
（它现在的 `+399/−3` 是 `models-page-fix` 的，我全程只读）。

临时文件全部已删：`__probe.tsx` / `__mut.test.tsx` / `__mut2.test.tsx` / `__host_before.tsx` /
`vite.config.t133ab.ts`，以及 `.test-out/{probe,probe-comp,mut,mut2,rev,ab-before,ab-after}`。
`git status --short` 里属于我的只有上面 5 个。

### 2. 独立复核：**不是 `type()` 的问题，是 react-dom 初始化时机的问题**

`storage-fix` 报的现象我全部复现了，**但它给的成因方向是错的**（它以为要换一种派发写法）。
我先做的是定性，不是动手。

**第一步：证明现象。** 最小受控输入框，三种写法逐个试（探针脚本，已删）：

```
--- baseline ---
el.value = "" state = ""
own "value" descriptor present (React value tracker) = true
_valueTracker = object
--- A: fireEvent.change（宿主今天用的写法）---
el.value = "AAA" state = "" onChange calls = 0
--- B: 原型链原生 setter + 派发 input ---
el.value = "BBB" state = "" onChange calls = 0
--- C: fireEvent.input ---
el.value = "CCC" state = "" onChange calls = 0
```

关键是 **`onChange calls = 0`**：不是"onChange 进了但 state 没提交"，是**一次都没进**。
`@testing-library/dom` 的 `setNativeValue`（`dist/events.js:115`）本来就是原型链原生 setter，
React 的 value tracker 也确实装上了 —— 也就是说"派发"这一侧**全都是对的**。

**第二步：定位到模块初始化。** 读 `react-dom-client.development.js:25428`：

```js
isInputEventSupported = !1;
canUseDOM && (isInputEventSupported = isEventSupported("input") && …);
```

`canUseDOM`（:25141）是 `typeof window !== 'undefined' && …`，**在模块初始化那一刻算一次**。
`isInputEventSupported=false` 时，`ChangeEventPlugin`（:19610）对文本输入框走
`getTargetInstForInputEventPolyfill` —— 那条分支**只认 `keyup`/`keydown`/`selectionchange`**，
`input`/`change` 直接被丢掉。`<select>` 走的是上面的 `shouldUseChangeEvent` 分支，不受影响。
**"下拉框好的、文本框是死的"这个形状，只有这一个解释。**

**第三步：证明它就是这条。** 同一段代码，只改 jsdom 装配与 RTL import 的先后：

```
[dom-last]  react-dom 初始化时 typeof window = undefined
[dom-last]  fireEvent.change → DOM="AAA" state=""    onChange=0
[dom-last]  <select> fireEvent.change → state="b"          ← 下拉框照样好

[dom-first] react-dom 初始化时 typeof window = object
[dom-first] fireEvent.change → DOM="AAA" state="AAA" onChange=1   ← 一个字没改，就好了
```

**第四步：证明产物里就是 `dom-last`。** 打出来的 `components.test.js` 前 21 行全是 `import`，
`new JSDOM(...)` 在**第 33 行**：

```
1: import { … } from "./assets/client-BO3UwfFh.js";
2: import { JSDOM } from "jsdom";                       ← 只是拿到构造函数
6: import { act, fireEvent, render } from "@testing-library/react";   ← react-dom 在这里初始化
…
33: var jsdomWindow = new JSDOM("<!doctype html>…")     ← 全局装配在这之后
```

`dom-env.ts` 文件头写着"必须是第一个 import"—— **这条在源码里成立，在产物里不成立**：
它是相对导入所以被**内联进包体**，而外部依赖的 import 被 rollup **提升到包体之前**。
拆成独立文件挡得住 ESM 的求值顺序，**挡不住打包器对外部依赖的提升**。

> 补充：仓库里**已经有人查对了**。`components/common/llm/PurposeBindingsSection.tsx:48`
> 的注释写着「vite 打包会 hoist import，dom-env 的全局装配跑在 react-dom 模块初始化之后，
> React 于是走 IE 的 attachEvent polyfill 路径」—— 与我的结论逐字一致。
> 那位（看上下文是 `llm-picker`）**查明了根因但没修**，把结论留在了注释里。
> 我是独立查的，查完才看到它；**这是佐证，不是我的依据**。

**顺带被 `canUseDOM=false` 拖下水的还有**（同一个根因，我没有一一验证，只读码列出）：
composition / beforeInput（IME 中文输入）、`animationend`/`transitionend` 的厂商前缀探测
（`style = {}` → `getVendorPrefixedEventName` 拿不到正确名字）。

### 3. 修法

**`host.tsx`：把 RTL 改成动态 import。**

```ts
const importRtl = () => import('@testing-library/react');
type Rtl = Awaited<ReturnType<typeof importRtl>>;
let rtlPromise: Promise<Rtl> | undefined;
async function rtl(): Promise<Rtl> { rtlPromise ??= importRtl(); return rtlPromise; }
```

动态 import 的**求值时机在包体里**，`dom-env` 已经跑完了。改完产物里
`@testing-library/react` 从静态 import 列表中消失（已核对）。
`render`/`click`/`type`/`pressKey`/`blur`/`flush` 本来就是 async，**签名一个没改**。
`@tanstack/react-query` 与 `react-router` 保持静态 import：已 grep 确认两者都不 import
`react-dom/client`，触发不了那次特性探测。

**为什么不是"让 dom-env 排到更前面"**：对外部依赖做不到。真正order-independent 的做法是
`node --import` 预加载，代价是 package.json + 一份与 `dom-env.ts` 重复的 `.mjs`（会漂移）。
动态 import 是同等效果里最小的改动。

**`type()` 加了一次性自检**（`assertTypeReachesReact`）：首次调用时渲染一个最小受控输入框，
派发 change，断言**渲染出来的 state** 变了；不满足就抛错，错误信息直接指向本节。
一个进程只跑一次，成本是一次单节点渲染。
理由：**这类失效是静默的**。万一将来又有人加了一个静态的 `react-dom/client` import，
我要它当场**变红**，而不是再一次悄悄让所有输入用例空转。

**`blur()` 去掉了多余的 `fireEvent.focusOut`** —— 见 §6-①。

**`dom-env.ts` 只加注释**：① 更正"拆文件就能排第一"的说法；② 标注 jsdom 30 下
`'oninput' in document` **已经是 `true`**，那个 for 循环是死代码（保留作兜底），
并写明**当年那个 `attachEvent` 崩溃的真正病根是 `canUseDOM=false`，挂 `oninput` 在那种状态下一点用都没有**。

### 4. 反向验证（硬要求）—— 真实输出

方法：`git show HEAD:apps/web/src/test/host.tsx > __host_before.tsx`，用一份临时 vite 配置把
`./host` 别名到它，**其余源码一个字不动**，再跑同一套 `host.test.tsx`。
（不直接改回源文件：期间 `models-page-fix` 还在改 web，改共享文件会污染他的运行。）

确认用的确实是原版（产物里有静态 `import { act, fireEvent, render } from "@testing-library/react"`）。

```
ℹ tests 14   ℹ pass 4   ℹ fail 10
✖ ★ 受控 input：type() 之后 React 的 state 真的变了
  AssertionError: state 没变 —— onChange 没进到 React。…  '' !== '反向传播'
✖ ★ DOM 值与 state 必须同时对上
  AssertionError: React state —— 缺陷状态下这里会是空串   '' !== 'abc'
✖ ★ 输入后紧接着按键：keydown 处理器必须拿到新 state
  AssertionError: … + [] - [ '梯度' ]
✖ ★ 受控 textarea 同样能被驱动          '' !== '多行\n文本'
✖ 连续输入两次                          '' !== '一二'
✖ 清空输入框                            '' !== '临时'（连"前提"那句都过不去）
✖ ★ blur 触发 onBlur —— 而且只触发一次   + 'blurred×2'  - 'blurred×1'
✖ ★ 输入 + 失焦提交                      + ['', ''] - ['gpt-4o-mini']
✖ ★ TagEditor：输入标签名后回车，两条请求都要真的发出去
  AssertionError: 应发出两条 POST，实际：[]     0 !== 2
✖ ★ LlmSettingsSection：填入 Key 后保存，真的 PUT /secrets/llm.<id>.apiKey

✔ 受控 <select> 仍然可用           ← 它本来就是好的，钉的就是"别在修 input 时弄坏它"
✔ click 能驱动 setState
✔ ★ 回车真的跳到 /search?q=…        ← 见下面的说明，这两条不受宿主影响
✔ ★ 只有空白的查询不跳转
```

跑的时候 jsdom 还把 react-dom 抛的异常打了出来，**正是 `dom-env.ts` 注释里描述的那个**：

```
TypeError: activeElement$1.attachEvent is not a function
    at handleEventsForInputEventPolyfill (react-dom-client.development.js:3573:27)
TypeError: Cannot read properties of null (reading 'tag')
    at getInstIfValueChanged (react-dom-client.development.js:3538:24)
    at getTargetInstForInputEventPolyfill (react-dom-client.development.js:3582:16)
```

**诚实标注两点**：
- `TagEditor` 那条失败信息是 **`实际：[]`（零条请求）**。这就是这个 bug 的完整形状：
  **一条请求都没发出去，而 DOM 上的输入框看起来填好了。**
  如果当初把断言写成"不该发某某请求"，它会**永远是绿的**。
- **`✔ 回车真的跳到 /search?q=…` 这两条在原版宿主下也是绿的，我不把它们算进反向验证的战果。**
  原因是 `SearchBox` 的 input **不受控**（`onKeyDown` 里直接 `(e.target as HTMLInputElement).value`
  读 DOM），原生 setter 写进去的值它照样读得到。它们钉的是**产品行为**，不是宿主行为 —— 见 §6-③。
- 还原后：**14 / 14 pass**（§10 门禁）。

### 5. 存量排查：怎么排的、排了多少、结论

结论先说：**一条"之前绿、现在红"的都没有。** 用了 4 种方法，不是只跑一遍。

**方法 1 —— 同源 A/B 跑全套（最直接的判据）。**
期间别的 agent 一直在改 web 源码（我做过 md5 快照，实测 `BackendChip` / `RuntimePage` /
`BackendPackCard` / `HardwareCard` / `components.test.tsx` 在我这轮里都变过），
所以**不能**拿"改之前跑一次、改之后跑一次"来比 —— 那会把别人的改动算到我头上。
做法是：**同一时刻的同一棵源码树，只把宿主换掉**，前后各构建一份、各跑一次。

```
BEFORE（原版 host）  ℹ tests 150  ℹ suites 35  ℹ pass 148  ℹ fail 0  ℹ skipped 2   exit=0
AFTER （修好的 host）ℹ tests 150  ℹ suites 35  ℹ pass 148  ℹ fail 0  ℹ skipped 2   exit=0
```

**逐条一致，零翻转。**

**方法 2 —— 调用点普查。** 全仓库只有 `components.test.tsx` 用这个宿主，
而 150 条用例里 **`type()` 一共只有 3 个调用点**：

| # | 位置 | 目标 | 修复前是不是假绿 | 判断 |
|---|---|---|---|---|
| 1 | `:162` SearchBox 回车跳转 | **不受控** input | 否（组件直接读 DOM 值） | 但**它钉不住任何东西**，见 §6-③ |
| 2 | `:174` SearchBox 空输入 | 同上 | 否 | **整条用例一个 assert 都没有**，见 §6-③ |
| 3 | `:2060` `__custom__` | `<select>` | 否（select 走另一条分支） | 真的在测 |

**"100+ 条组件测试里有多少在假绿"这个担心，答案是 0 条** —— 但不是因为运气好，
是因为**前几轮的人碰到这堵墙时都绕过去了**（方法 3）。

**方法 3 —— 把"被绕过去"的痕迹全找出来**（grep 测试与组件里的相关注释）：

| 处置 | 位置 | 代价 |
|---|---|---|
| 直接 `{ skip: true }` | `components.test.tsx:115`（TagEditor 回车 POST） | 该行为**零覆盖** |
| 直接 `{ skip: true }` | `components.test.tsx:374`（填 Key → PUT secrets） | 该行为**零覆盖** |
| 抽纯函数只测规则 | `PurposeBindingsSection.tsx:44` 的 `mergePurposeBinding` | 规则测到了，**接线没测** |
| 改成直接渲染子组件 + 真 HTTP | `components.test.tsx:713` 的 `StaleLinksWarning` | 组件测到了，**整条点击链没测** |

**这个洞的代价是"少测"，不是"错测"。** `storage-fix` 说它自己写出过一条假绿测试 ——
那条**没有进仓库**（它自己加前提断言抓出来了）。我核对了 §4 的失败形状，与它的描述一致。

**方法 4 —— 把绕过去的那些真的跑一遍**，看有没有产品缺陷被掩盖 → §7。

### 6. 顺带查出来的 3 个东西（都不是原任务，但都属于同一族）

**① `host.blur()` 会让 `onBlur` 跑两遍（已修，是真缺陷）。**
`@testing-library/react` 的 `fireEvent.blur` **自己就先派发 `focusOut` 再派发 `blur`**
（`dist/fire-event.js` 末尾，注释直接引了 React PR #19186）。宿主又手工补了一句
`fireEvent.focusOut(el)` → `focusout` 派发两次 → **`onBlur` 触发两次**。
后果：`SegmentRow`（`onBlur={commit}`）、`TagEditor`（`onBlur={commit}`）这类"失焦保存"
在测试里会发**两条**请求，于是断言只能写成 `length === 2`（把缺陷写成期望，家族 #15）
或者用 `find()` 悄悄吞掉重复 —— **两条路都会让真实的重复提交缺陷再也测不出来**。
它是被我新加的那条 `blurred×1` 用例抓出来的，反向验证里**真的红**（`'blurred×2'`），
说明这是**修复前就存在**的，不是我改出来的。`blur()` 在 `components.test.tsx` 里当前**零调用点**，
所以这次改动不影响任何现有用例。

**② 那段跳过理由的诊断是错的（`components.test.tsx:103-113`）。**
原文写「**onChange 触发得到**、但组件不重渲染，紧接着的 keydown 处理器仍持有旧闭包」。
实测 **`onChange calls = 0`，一次都没触发**。方向反了 —— 它把人引向"setState 提交时机"，
所以后面试的全是 `act` 包裹 / 让出微任务 / 真实定时器，**全在错误的方向上**。
这段注释建议连同那两行 skip 一起处置（§8）。

**③ 两条 SearchBox 用例钉不住任何东西（家族 #5 又一例）。**
`:160` 那条名叫「回车跳转到 `/search?q=…` 并对查询串做 URL 编码」，**但它从来没断言过 URL**
（原注释：「MemoryRouter 下用 location 断言不方便」），只断言了 `input.value` 还在。
`[实测]` 我做了变异：把 `SearchBox` 的 `navigate(...)` **整句删掉**，其余一字不改：

```
✔ （复刻 components.test.tsx:160 的断言）回车跳转 + URL 编码       ← 产品坏了，它还是绿的
✔ （复刻 components.test.tsx:172 的断言）空输入回车不跳转           ← 它本来就一个 assert 都没有
✖ ★ 换成"断言 URL"之后，同一个变异体必须变红
   AssertionError: + '/'  - '/search?q=%E5%8F%8D%E5%90%91%E4%BC%A0%E6%92%AD%20%26%20%E6%A2%AF%E5%BA%A6'
```

"MemoryRouter 下不方便"这个前提是错的：往树里塞一个读 `useLocation` 的探针就行。
我在 `host.test.tsx` 里补了两条**会红**的（上面第三行就是它的变异体版本），
**没有去改他那两条**（那个文件在 `models-page-fix` 手上）。

### 7. 产品缺陷排查：把"以前跑不了"的链路全跑一遍 —— **一个都没找到**

修好之后我把 6 条从来没被测过的「输入 → 提交」链路真的跑了，逐条核对了发出去的请求：

| 链路 | 实际请求（真实输出） | 结论 |
|---|---|---|
| TagEditor 输入标签名 + 回车 | `POST /tags {name:"播客"}` → `POST /notes/n1/tags {tagUids:["t9"]}` | ✅ 两步都对，uid 用的是服务端回的 |
| LLM 填 Key 保存 | `PATCH /settings {…}` + `PUT /secrets/llm.openai.apiKey {value:"sk-test-12345"}` | ✅ 路径与请求体都对 |
| LLM **不填** Key 保存（对照） | 只有 `PATCH /settings`，**无 PUT / 无 DELETE** | ✅ 没有误删已有 Key |
| 代理：填 httpProxy 保存 | `PATCH {httpProxy:"http://127.0.0.1:7890", mode:"manual"}` | ✅ 只发改过的字段 + mode |
| 代理：noProxy 文本域 | `PATCH {noProxy:["localhost",".cn","192.168.1.5"], mode:"manual"}` | ✅ 逗号切分与 trim 都对 |
| 代理：**脱敏保护** | 只改 socks5 时 `PATCH {socks5:…, mode:"manual"}`，**body 里没有 `***`** | ✅ 这条最要紧，没把脱敏值写回去 |
| 捕获页：输入链接回车 | `POST /notes/probe {input:"https://example.com/watch?v=abc"}` | ✅ |
| 数据目录：输入路径点应用 | `POST /settings/data-dir {path:"/new/place", moveExisting:true}` | ✅ storage-fix 当时绕过去的正是这条 |

顺带确认了两个"按钮该不该亮"的状态位（它们**只有**在输入能驱动 state 时才有意义）：
代理页 `proxy-save` 从 `disabled=true` 变 `false`、`proxy-unsaved` 提示出现；
数据目录的「应用」按钮变可点。**旧宿主里这些 disabled 永远是 `true`** ——
也就是说，哪怕有人当初写了"点保存应该发请求"的用例，它也只会是"点了一个灰按钮，什么都没发生"。

这些探查用例跑完就删了（属于 `components.test.tsx` 的地盘，我不占）。
**只有 TagEditor 与 LLM apiKey 两条我留了下来**，因为它们是"skip 的理由已经不成立"的直接证据。

### 8. 需要 Manager 决策

1. **`components.test.tsx:115` 与 `:374` 那两行 `{ skip: true }` 现在没有理由了。**
   我在 `host.test.tsx` 的「存量回收」里重建了等价用例并**实跑通过**，但**没有动他那两行**
   —— 那个文件 `models-page-fix` 正在改（+399/−3）。
   建议：由他或下一轮统一删掉那两行 + `:103-113` 那段诊断错误的注释（见 §6-②）。
   如果他直接改活那两条，我这边的两条就是重复覆盖，**到时候删我的那两条即可**，别删他的。
2. **`components.test.tsx:160/:172` 那两条 SearchBox 用例建议替换掉**（§6-③）。
   我已经把会红的版本写好放在 `host.test.tsx` 里，可以直接搬过去。
3. **`PurposeBindingsSection` 的 `onBlur → PATCH` 接线现在可以真的测了**（§6-① 修完之后
   失焦不会再重复触发）。那是 `llm-picker` 的地盘，我没有越界去补。
4. **`apps/web/dist` 被人重建过**（§9），按协议 §7 这条线只该由你在重启前统一构建。请核。

### 9. ⚠️ `apps/web/dist` 在 21:00:11 被重新构建 —— 不是我，证据如下

```
$ ls -la --time-style=full-iso apps/web/dist/assets | head -4
drwxr-xr-x  2026-08-03 21:00:11.129702602 +0800 .
-rw-r--r--  2026-08-03 21:00:11.128930099 +0800 AsrModelPicker-DVAr4Xaa.js
-rw-r--r--  2026-08-03 21:00:11.128947490 +0800 Button-BFh2v34V.js
```

（`storage-fix` 上一轮记录的 dist mtime 是 `19:56:22`，现在是 `21:00:11`。）

我不是它的作者，理由三条：
1. 那是一次**完整 SPA 构建**（`index.html` + `modulepreload` + `AsrModelPicker` / `Button` /
   `CapturePage` 等按路由切分的 chunk）。我这轮**每一条** `vite build` 都是
   `--ssr <单个测试文件> --outDir <显式路径>`，产物形状是**单文件**，产不出这个。
2. 我的第一条构建命令的产物时间戳是 **20:55:12**（`/tmp/test-host/probe/__probe.js`），
   之后到 21:02 之间我在读 react-dom 源码和跑 `order.mjs` 探针，**没有构建**。
3. 我所有 outDir 都在 `.test-out/*` 或 `/tmp/test-host/*`，且全部已清理。

**建议**：`:10000` 上的页面现在很可能是别人的半成品（没报错、没重启、版本号也没变）。
按协议 §7 该由你统一重建。我**没有**去动它 —— 那不是我的文件。

### 10. 门禁（真实 exit code）

```
tsc -p apps/web/tsconfig.json                       = 0
eslint（host.tsx / host.test.tsx / dom-env.ts）      = 0   （首轮有 1 个
   consistent-type-imports warning，已改成 Awaited<ReturnType<typeof importRtl>> 消除）
pnpm --filter web test:host                         14 tests / 14 pass / 0 fail
pnpm --filter web test:components                   host 14/14 → components 150 (148 pass / 0 fail / 2 skipped)
pnpm --filter web test:unit                         27 tests / 27 pass / 0 fail
```

⚠️ **仓库级 `tsc -b` 与 `pnpm -r test` 我没跑**（你说了当前是红的，正主是 `models-page-fix`
的 `ModelsPage.tsx` 与 `job-events` 的 `upload.test.js`）。我只验我这侧，**不冒领也不掩盖**。
注：我跑 `tsc -p apps/web/tsconfig.json` 时它是 **0** —— 说明 `ModelsPage.tsx` 那条 TS2322
在我跑的那一刻已经被他修掉了。**这是观察，不是我的功劳。**

### 11. 自查（诚实规则）

- **`test:components` 现在会先跑 `test:host`**。这是刻意的顺序：宿主一旦退化，
  后面那 150 条**不会报错，只会静默地少测一大片** —— 先看到宿主那条红，
  才不会有人跑去怀疑产品。脚本名与既有行为都没变，别人不用改任何调用方式。
- **`type()` 里的一次性自检有成本**：每个测试进程首次调用 `type()` 时多渲染一个单节点组件。
  实测整套 14 条 `duration_ms ≈ 735`，与自检前同量级。**我认为值**，理由见 §3。
- **动态 import 不是 order-independent 的终极解**。如果将来有人在测试图里加一个**静态**的
  `react-dom/client` import（比如把 `__smoke__/render.tsx` 拉进组件测试），
  提升会再次跑到前面。**那种情况下现在会当场抛错**（自检），不会再静默 —— 但**它确实还能被打破**，
  我如实写在这里。彻底的做法是 `node --import` 预加载，代价是多一份会漂移的 `.mjs`。
- **我没有验的**：composition / IME 与 animation/transition 事件是否也随之恢复正常。
  两者受同一个 `canUseDOM` 影响，我**读码判断**应该一起好了，但**没有写测试证明**，不声称。
- **`__smoke__/render.tsx` 我没碰**。它自己建 jsdom + `createRoot`，走的是另一条道，
  是否有同样的顺序问题**我没查**（不在本任务范围）。
- **A/B 那两次跑之间源码树没变**：`components.test.tsx` 的 md5 在两次构建前后都是
  `a47e7609bb14b0552962df9caab73268`，已核。
- 全程**没有用 `pkill`**（`storage-fix` 上轮的教训）。没起任何服务、没占任何端口，
  `:10000`（pid 2992138）事后确认仍在。**没碰 `/root/data-memo`**。
- **临时文件全部删干净**，`git status --short` 里属于我的只有 §1 那 5 个。

---

## [2026-08-03 22:10] T-133 续办 DONE（两个决策点执行 + 收进 HANDOFF 的判据）

### TL;DR（≤25 行）

1. **两个决策都执行了。** `components.test.tsx` 已释放，我直接改的：
   2 行 `{skip:true}` 空壳 → **真用例**；2 条 SearchBox 弱断言 → **断言 URL 的版本**。
2. **那段诊断错误的注释一并改掉了**（你点名的）。原文说「onChange **触发得到**、
   但组件不重渲染」——方向反了，后来的人因此一直在"提交时机"上试。
   新注释写的是实测事实（**onChange 调用次数 = 0**）+ 真正的根因 + 指向 `host.tsx` 的说明。
3. **顺带把 `components.test.tsx` 文件头那句也改了**：它写着「`./host` 必须是第一个 import」
   —— 这正是 T-133 证伪的那句话。留着它，下一个人还会以为顺序有保证。
4. **`host.test.tsx` 里的重复覆盖已删**（我上一轮为了不碰他文件而重建的那 4 条）。
   本文件现在**只剩宿主自证 10 条**：产品行为归产品测试，宿主行为归这里。
5. **数字**：`151 tests / 151 pass / 0 fail / **0 skipped**`（上一轮是 150/148/0/**2 skipped**）。
   宿主自证 10/10。`test:components` 真实 exit code = **0**。
6. **反向验证做了两组，都贴真实输出（§续-3）**：
   - **A：换回缺陷宿主** → 新恢复的两条**真的红**：`应发出两条 POST，实际：[]`（零请求）；
     LLM 那条更说明问题 —— **`PATCH /settings` 发出去了、`PUT` 没有**，
     也就是**设置写进去了而 API Key 静默没写**。断言只盯 PATCH 的话，它会是绿的。
   - **B：把 `navigate(...)` 整句删掉** → 新的 SearchBox 断言**真的红**：
     `+ '/'  - '/search?q=%E5%8F%8D%E5%90%91…'`。旧断言在同一个变异体上是绿的。
7. **诚实标注**：A 组里 SearchBox 那两条**没有变红**（`SearchBox` 的 input 不受控，
   直接从 DOM 读值）。它们钉的是**产品行为**不是宿主行为，我不把它们算进 A 组战果。
8. **你要收进 HANDOFF 的判据写在 §续-4**，我把它归成家族第 18 例，并给了判据与配套动作。
9. `pnpm build:safe` 收到，以后验证构建一律用它。**这一轮我一次构建都没跑**
   （只有 `vite build --ssr --outDir .test-out/*` 的测试打包），`apps/web/dist` 未被触碰。
10. 门禁：`tsc -p apps/web/tsconfig.json` 真实 **exit=0** · `eslint`（我的 4 个文件）**exit=0** ·
    `test:components` **exit=0**。纪律照旧：无 `pkill`、未碰 `/root/data-memo`、`:10000` 只读。

---

### 续-1. 这一轮改了什么（`git add` 清单）

```
git add apps/web/src/test/components.test.tsx \
        apps/web/src/test/host.test.tsx \
        coordination/inbox/test-host.md
```

⚠️ `git status` 里另有 `apps/daemon/src/http/rest/storage.ts`、
`apps/web/src/components/common/ReadinessBanner.tsx`、
`apps/web/src/features/settings/DataLocationSection.tsx`、
`packages/pipeline/package.json` 处于修改态 —— **不是我的**，是这一轮新开工的 agent
（在做 `pickLocalized` 那条线）。我一个字没碰，别把它们加进我的提交。

| 位置 | 原状 | 现状 |
|---|---|---|
| `components.test.tsx` TagEditor | `{skip:true}` 空壳 + 一段**诊断错误**的注释 | `★ 输入标签名后回车：两条请求都要真的发出去`（`POST /tags` → `POST /notes/n1/tags`，逐条核对 body） |
| `components.test.tsx` LlmSettingsSection | `{skip:true}` 空壳 | `★ 填入 Key 后保存：真的 PUT …` + **新增**一条对照 `★ 不填 Key 直接保存：不许发 PUT，也不许发 DELETE` |
| `components.test.tsx` SearchBox ×2 | 断言 `input.value` / **零断言** | 两条都改成断言 `useLocation()` 探针读到的真实 URL |
| `components.test.tsx` 文件头 | 「`./host` 必须是第一个 import」 | 改成「保持第一，但**别把这一行当成保证**」+ 指向 `host.tsx` T-133 |
| `host.test.tsx` | 14 条（含 4 条重复覆盖） | **10 条，只剩宿主自证**；删除处留了一段说明去向的注释 |

**为什么多加了一条"不填 Key"的对照**（超出你列的两条）：恢复的那条只证明"填了会写"。
而这个表单最容易出错的是**另一半** —— 留空的语义是"保持原样"，`LlmSettingsSection` 里
是靠 `apiKey === '' ? undefined : apiKey` 表达的。写错一个字符就变成**每次保存都删掉用户的 Key**，
而"填了能写"那条**照样绿**。两条合起来才算把这个分支钉住。

### 续-2. 那段注释错在哪（你点名的，展开写一次）

```
原文：本宿主里**文本输入引发的 setState 不会提交** ——
      onChange 触发得到、但组件不重渲染，紧接着的 keydown 处理器仍持有旧闭包。
实测：onChange 调用次数 = 0。一次都没进。
```

差别不是措辞。**它把人指向了"提交时机"** —— 所以后面写着"act 包裹 / act 内让出微任务 /
关掉 act 环境走真实定时器 / 多轮宏任务等待也都试过"，**四种尝试全在错误的方向上**，
而且每一种都"合理"。真正的根因在**事件到达之前**（react-dom 初始化时 `canUseDOM=false`），
从"提交时机"这个方向出发，试到天亮也碰不到它。

**一段写错方向的注释比没有注释更糟**：没有注释的人会自己去查，
有这段注释的人会接着往下试 —— 它把后来者的搜索空间**裁掉了正确的那一半**。

### 续-3. 反向验证（两组，真实输出）

#### A 组 —— 把宿主换回缺陷版本（`git show a99ef7b^:…/host.tsx`），源码其余部分一字不动

```
ℹ tests 151   ℹ pass 149   ℹ fail 2   ℹ skipped 0

✖ ★ 输入标签名后回车：两条请求都要真的发出去
  AssertionError: 应发出两条 POST，实际：[]
  0 !== 2

✖ ★ 填入 Key 后保存：真的 PUT /secrets/llm.<id>.apiKey，且请求体是原样的 key
  AssertionError: 应发出 PUT，实际写请求：
  [{"path":"/settings","method":"PATCH","body":{"llm.providers":[…],
    "llm.baseUrl.openai":"https://api.openai.com/v1",
    "llm.defaultProviderId":"openai","llm.defaultModelId":"gpt-4o-mini"}}]
```

**第二条的 `actual` 值得单独看**：`PATCH /settings` **发出去了**，`PUT /secrets/...` **没有**。
点击是好的（`click` 不受这个 bug 影响），只有输入那一半是死的 ——
所以缺陷状态下的真实后果是「**设置保存成功，API Key 静默丢失**」。
如果当初那条用例写的是"点保存应该发 PATCH"，它会**一直是绿的**，
而用户那边是"我明明填了 Key，怎么一直报未授权"。

**诚实标注**：A 组里 SearchBox 那两条**没红**（`SearchBox` 的 input **不受控**，
`onKeyDown` 直接 `(e.target as HTMLInputElement).value` 读 DOM，原生 setter 写进去的值它读得到）。
它们钉的是产品行为，与宿主无关 —— 所以才需要 B 组。

#### B 组 —— 把 `SearchBox` 里的 `navigate(...)` **整句删掉**（真文件、真变异，跑完已还原）

```
ℹ tests 151   ℹ pass 150   ℹ fail 1

✖ ★ 回车真的跳到 /search?q=…，且查询串被 URL 编码
  AssertionError: 没跳转 —— 而旧断言（只看 input.value）在这种情况下照样是绿的
  + actual - expected
  + '/'
  - '/search?q=%E5%8F%8D%E5%90%91%E4%BC%A0%E6%92%AD%20%26%20%E6%A2%AF%E5%BA%A6'
```

对照：**同一个变异体下，被替换掉的两条旧用例是全绿的**（上一轮 §6-③ 已贴）。
还原后 `git diff` 对 `SearchBox.tsx` 为空，`navigate(...)` 那行在位。

（"空白查询不跳转"那条在 B 组不会红 —— 删掉 navigate 之后它本来就不跳。
它防的是**反方向**的回归：哪天有人把 `if (v)` 去掉，空搜索就会跳到 `/search?q=`。
我不声称它被 B 组验过。）

### 续-4. ★ 请收进 HANDOFF「假绿灯家族」的判据（第 18 例）

> **#18 测试的名字和它实际断言的东西可以完全无关，而且没有任何机制会发现。**
>
> `[实测]` `components.test.tsx` 有一条名叫「**回车跳转到 `/search?q=…` 并对查询串做 URL 编码**」
> 的用例，断言里**从头到尾没有出现过 `/search` 三个字** —— 它只断言了 `input.value` 还在
> （理由写在注释里：「MemoryRouter 下用 location 断言不方便」，而这个前提**也是错的**：
> 塞一个读 `useLocation` 的探针就行）。把 `SearchBox` 的 `navigate(...)` **整句删掉**，
> 它**照样绿**。同一个 describe 下的第二条「空输入回车不跳转」更彻底：**整条用例一个 assert 都没有**，
> 只要不抛错就算过。
>
> 这是继 **#15「旧断言把 bug 写成了期望」** 之后的同族第二例。两者的共同点是
> **测试文件本身在撒谎，而撒谎的那一部分不参与任何检查**：
> #15 的谎在断言的**内容**里，#18 的谎在断言与名字的**落差**里。
>
> **为什么没有任何机制会发现**：名字是字符串，断言是代码，两者之间**不存在任何约束**。
> 编译器不看、类型不看、lint 不看、覆盖率更不看 —— 覆盖率只问"这行代码跑没跑过"，
> 而这条用例**确实跑过了** `SearchBox` 的每一行（包括 `navigate` 那行的所在函数）。
> 它是覆盖率报告上的一条绿线。
>
> ### ★ 由此立的规矩
> 1. **读测试先读断言，别读名字。** 名字是作者的**意图**，断言才是**证据**。
>    评审一条用例时，把名字遮住，问"这些断言在什么情况下会失败"。
> 2. **答不上"它什么时候会红"的用例，等于没写。** 最快的检验是**变异**：
>    把被测行为**整句删掉**，跑一遍。不红 → 这条用例钉住的是零。
>    （本轮两次都是这么定性的：删 `navigate(...)`、换回缺陷宿主。）
> 3. **"不方便断言"要当成技术债记，不能当成降级断言的理由。**
>    这条的注释诚实写了"不方便"，然后就地把断言降成了 `input.value` ——
>    **诚实地记下妥协，不等于妥协是对的**。本例里那个"不方便"其实是 5 行代码的事。
> 4. **零断言的用例必须显式标注**（`skip` 或注释说明它只测"不抛错"）。
>    一条 `await` 完就 `unmount` 的用例，混在同一个 describe 里看不出来。

### 续-5. 需要 Manager 决策

**无。** 上一轮列的 4 条：①②（两处 skip、SearchBox 两条）**本轮已执行**；
③（`PurposeBindingsSection` 的 `onBlur → PATCH` 现在可测了）仍**建议**由该模块的人补 ——
它属于 `llm-picker` 的地盘，且现在有 `blur()` 只触发一次的保证，写起来是直的；
④（`apps/web/dist`）你已查明并用 `pnpm build:safe` 从机制上关掉了，我这边照办。

### 续-6. 自查（诚实规则）

- **B 组变异改的是真文件**（`SearchBox.tsx`），不是复制品。跑完立刻还原并核对：
  `git status` 中该文件已不在修改列表，`navigate(...)` 在第 43 行。
  上一轮我用别名指到副本，是因为当时别人在改 web；**这一轮工作区干净，所以做了更忠实的那种**。
- **A 组我没有改回源文件**，仍用别名指向 `git show a99ef7b^:` 的那份，理由同上一轮：
  临时把共享文件改坏，别人这一刻正好跑测试就会读到一个假红。临时配置与副本**跑完即删**。
- **`tsc` 中途见过一次红**（`DataLocationSection.tsx(281) TS2304: Cannot find name 'pickLocalized'`），
  是新开工那位在途的状态，**几分钟后再跑就是 exit=0**。我**没有**把它算成自己的问题，
  也没有去改他的文件 —— 如实记一笔，因为"看见红先问这个红是不是真的、是不是我的"是本项目的规矩。
- **`host.test.tsx` 从 14 条减到 10 条**，减掉的是**重复**不是覆盖：
  那 4 条已经原样搬进 `components.test.tsx` 的对应 describe，且本轮 A/B 两组反向验证都覆盖到了。
  总用例数 150 → **151**（净增 1 条，是我多加的"不填 Key"对照）；**skipped 2 → 0**。
- **仍未验的**：composition / IME 与 animation/transition 事件是否随 `canUseDOM` 一起恢复正常
  （读码判断是，但没写测试，不声称）；`__smoke__/render.tsx` 那条独立的 jsdom 道没查。
- 本轮**没有跑过任何构建**（`pnpm -r build` / `vite build` 不带 `--ssr` 的形态一次都没有）。
  所有打包都是 `vite build --ssr <单文件> --outDir .test-out/*`。`apps/web/dist` 未被触碰。
