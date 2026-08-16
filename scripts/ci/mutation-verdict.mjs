/**
 * 变异证明的**判决那一格**：`fn` 抛了 —— 到底抛的是「断言按设计判红」，
 * 还是「这条腿自己炸了」？
 *
 * ## 它治的病（v0.7.3 抓到过一次，今天还在）
 *
 * `mutation(id, fn)` 此前只问一件事：**抛没抛**。
 *
 * ```js
 * if (threw) { results.push({ id, status: 'MUT-OK' }); say(`✔ [变异] ${id} —— 如期变红：${threw.message}`); }
 * ```
 *
 * 于是任何抛出都变成了好消息。`[CI 实测 run 31629900327, win32-x64]` 的原话：
 *
 * ```
 * ✔ [变异] B10 的证伪能力（把「移动到文件夹」弄成死按钮，必须红）
 *   —— 如期变红：locator.click: Timeout 8000ms exceeded.
 *      waiting for locator('[data-testid="note-actions"]')
 * ```
 *
 * **那一轮变异体一次都没装上、整段函数体根本没跑到，却被记成"这条断言有牙齿"。**
 * 成因是导航去了错的页面（列表页而不是详情页）—— 一个**测试自己的缺陷**，
 * 伪装成了产品的好消息。
 *
 * 这与 `e2e-browser-assertions.mjs` 修的那条是**同一段逻辑的两面**：
 * 那边是「抛了之后没红被读成没红」，这边是「压根没判被读成如期变红」。
 *
 * ## 判据：**只有专用的那一种抛出**才算「断言判红」
 *
 * | 抛出的东西 | 判决 | 读作 |
 * |---|---|---|
 * | 什么都没抛 | `MUT-BAD` | 变异体存活 —— 这条断言证伪不了 |
 * | `AssertionFailed`（只有 `ok()` / `eq()` 抛这个） | `MUT-OK` | 断言**按设计**判红了 |
 * | `Undecided`（`undecided()` 抛的） | `MUT-UNKNOWN`(premise) | 前提没构造出来，这一轮什么都没证明 |
 * | **其它任何东西** | `MUT-UNKNOWN`(crash) | **这条腿炸了** —— 跑了，但什么都没证明 |
 *
 * ⚠️ 最后一行的三个判决**必须互不相同**：
 *   · 压成 `MUT-OK` = v0.7.3 那条假绿（腿炸了被读成断言有牙齿）；
 *   · 压成 `MUT-BAD` = 反方向的假指控（腿炸了被读成断言没牙齿）——
 *     那会让人去改一条**没有问题**的断言，比不报还坏；
 *   · 压成 `MUT-UNKNOWN` 才是事实：**跑了，什么都没证明。**
 *
 * ⚠️ `MUT-UNKNOWN` **不计入失败**（平台差异构造不出前提是常态，为它常红会训练所有人
 * 无视这盏灯）。所以它必须**响** —— `crash` 那一档由调用方打成 GitHub 的
 * `::warning` 注解，并计进"本轮无从判断"的清单。一个安静的 UNKNOWN
 * 就是把一种假绿换成另一种。
 *
 * ## ⚠️ 为什么是"抛的类型"而不是"消息长什么样"
 *
 * 想过按消息匹配（`/^locator\.|Timeout .* exceeded/`）。**否掉了**：那是拿散文当判据，
 * 本仓在 `unavailableReason` 上栽过两次、在 `先安装 CPU` 那条正则上栽过一次
 * （`e2e-runtime-assertions.mjs` 文件头有完整记录）。Playwright 换一句措辞、
 * 换一种语言，判据就悄悄退回"恒不命中"。**类型是结构，措辞是散文。**
 *
 * 证明在 `scripts/ci/selftest-mutation-verdict.mjs`：四档逐档正反都跑，
 * 并且把「老实现」和「一刀切成 UNKNOWN」两种退化实现写在用例里，
 * 各自必须在**不同**的那几条上失败 —— 单向的守卫两种退化都拦不住。
 */

/**
 * 断言**按设计**判红时抛的那一种。**只有 `ok()` / `eq()` 这类断言助手能抛它。**
 *
 * ⚠️ 别在产品逻辑或页面操作里 `throw new AssertionFailed(...)` 来"让变异变红" ——
 * 那等于把这道判据交回给写代码的人自觉，而自觉正是它要替换掉的东西。
 */
export class AssertionFailed extends Error {
  constructor(message) {
    super(message);
    this.name = 'AssertionFailed';
  }
}

/**
 * 第三种结局：**这一轮的前提没构造出来**，既不是通过也不是失败。
 *
 * （原本定义在 `e2e-browser-audit.mjs` 里，挪到这里是因为判决需要认得它 ——
 * 而那个文件全程顶层执行 + `process.exit()`，`import` 不进来。）
 */
export class Undecided extends Error {
  constructor(message) {
    super(message);
    this.name = 'Undecided';
  }
}

/** 抛一条「断言按设计判红」。`got !== undefined` 时把实得值附在后面。 */
export function assertOk(cond, msg, got, brief = (v) => String(v)) {
  if (cond !== true) {
    throw new AssertionFailed(`${msg}${got === undefined ? '' : `（实得：${brief(got)}）`}`);
  }
}

/** 抛一条「这一轮什么都没证明」。 */
export function markUndecided(msg) {
  throw new Undecided(msg);
}

/**
 * 变异证明的判决。
 *
 * `threw`：`fn()` 抛出来的东西（`null` / `undefined` = 什么都没抛）。
 * 返回 `{ status, kind, mark, detail, text }` —— 全是字符串（§8）。
 *
 *   · `status` ∈ `MUT-OK` | `MUT-BAD` | `MUT-UNKNOWN`
 *   · `kind`   ∈ `assertion` | `survived` | `premise` | `crash`
 *   · `mark`   ∈ `✔` | `✘` | `？`（日志行首那一个字）
 *   · `text`   是日志里跟在 id 后面的那一句
 */
export function classifyMutationThrow(threw, brief = (v) => String(v ?? '')) {
  if (threw === null || threw === undefined) {
    return {
      status: 'MUT-BAD',
      kind: 'survived',
      mark: '✘',
      detail: '变异体没让断言变红',
      text: '**没有变红**。这条断言证伪不了它，等于假绿灯。',
    };
  }
  if (threw instanceof Undecided) {
    return {
      status: 'MUT-UNKNOWN',
      kind: 'premise',
      mark: '？',
      detail: threw.message,
      text: `无从判断（前提没构造出来）：${brief(threw.message)}`,
    };
  }
  if (threw instanceof AssertionFailed) {
    return {
      status: 'MUT-OK',
      kind: 'assertion',
      mark: '✔',
      detail: threw.message,
      text: `如期变红：${brief(threw.message)}`,
    };
  }
  /*
   * ★ 到这里的都是**没人打算让它抛的东西**：Playwright 超时、页面崩了、
   *   选择器写错、`TypeError`、`fetch failed`…… 它们证明不了任何事。
   *   此前这一档被记成 `MUT-OK`，于是「测试自己坏了」长得和「产品被抓住了」一模一样。
   */
  const name = threw?.name ? String(threw.name) : typeof threw;
  const message = threw?.message !== undefined ? String(threw.message) : String(threw);
  return {
    status: 'MUT-UNKNOWN',
    kind: 'crash',
    mark: '？',
    detail: `【腿炸了，不是断言判红】${name}: ${message}`,
    text:
      '**这条腿自己炸了**，不是断言判红 —— 这一轮什么都没证明' + `（${name}: ${brief(message)}）`,
  };
}

/**
 * `crash` 那一档要喊出来的 GitHub 注解（`::warning`，不是 `::error` ——
 * 它不判红，但**不许安静**）。返回 `null` 表示这一档不用喊。
 */
export function mutationAnnotation(id, verdict) {
  if (verdict.kind !== 'crash') return null;
  const oneLine = String(verdict.detail)
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 300);
  return (
    `::warning title=变异 ${id} 什么都没证明::` +
    `这一轮不是"断言判红"，是**这条腿自己炸了** —— ${oneLine}。` +
    '它既没证明这条断言有牙齿，也没证明它没有。'
  );
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* 缺席：一条变异**根本没跑到**时，总表里只表现为"少几行"                        */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * ★ 上面四档全都建立在一个前提上：**`mutation()` 真的被调用了。**
 *
 * 它没被调用时，`results` 里连一行都不会有 —— 而"少一行"在任何一盏灯上都不亮：
 * 汇总表短了几行，`变异证明 N 条` 里的 N 小了几，没有一个字说"少的那几条去哪了"。
 *
 * `[实测语料 177 份 job 日志]` 至少 8 轮是这样的：
 *   · `e2e-browser` run 31484205254 win32：`✘ 审计中断：page.goto: Timeout 30000ms
 *     exceeded` ⇒ **4 条变异 0 行**；
 *   · `e2e-notes`   run 31634339688 linux：同形 ⇒ **10 条变异 0 行**。
 *
 * 整轮被掐断那种今天由「审计中断」一条红兜着（人能顺藤摸到），但
 * **没掐断却提前 return / 分支绕过**的那种，今天一个字都不会说。
 *
 * ## N 从哪来：**从源码本身数**，不另立一份清单
 *
 * 一份手抄的"本轮应有变异清单"只是把一个漂移换成另一个（加了变异忘了同步 ⇒
 * 少算一条 ⇒ 又是"少几行"）。所以直接扫**这个脚本自己的源码**里
 * `await mutation('<id>'` 的调用点 —— 调用点就是注册表，不存在第二份。
 *
 * ⚠️ 判据里有一条**扫描非空地板**：一条腿扫出 0 个调用点 = 提取器坏了
 * （改了写法、regex 漂了），而它坏掉的表现恰恰是"从此永远没有缺席"——
 * 又一个恒不触发的检查。所以 0 要当场红，调用方负责。
 */
export function extractMutationIds(sourceText) {
  const out = [];
  /*
   * ★ 只认**语句位置**上的调用：行首（缩进之后）紧跟着 `await mutation(`。
   *
   * ## 为什么不是"先剥注释再找"（第一版就是那么写的，被自己的地板抓了）
   *
   * 剥注释的动机是真的：本模块的说明里就写着「`await mutation('<id>'` 的调用点
   * 就是注册表」——**那句话自己长得像一个调用点**，不处理就会每轮报一条幽灵缺席。
   * 但用 `/\/\*[\s\S]*?\*\//` 去剥块注释会踩到一件事：
   *
   * ```js
   * // e2e-notes-audit.mjs:1473，一个**字符串**里的 HTTP Accept 头
   * accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*∕*;q=0.8',
   * ```
   *
   * `*∕*` 里含着一个 `/` `*` —— 剥注释的正则把它当成块注释**开始**，
   * 一路吃到下一个真正的 `*∕`，**连着吞掉了 `F5-e4` 那条真变异**。
   * `[CI 实测 PR #66 第一版]` 表现为 notes 只数到 9 条（地板 10）当场红。
   * 那条地板是为"提取器漂了"立的，它第一次触发抓的正是提取器自己。
   *
   * 行首锚定不需要理解字符串，也就没有这一类坑：
   *   · JSDoc 里那句说明，缩进之后是 `*`，不是 `await` ⇒ 天然排除；
   *   · `// await mutation('x')` 缩进之后是 `/` ⇒ 排除；
   *   · 行尾注释 `foo(); // await mutation('x')` 行首是 `foo` ⇒ 排除；
   *   · 字符串里的 `*∕*`、`http://` 一概无关。
   *
   * ⚠️ 代价：`if (x) await mutation(...)` 这种**非语句位置**的调用数不到。
   *   仓里今天一个都没有；真有人这么写，下面那条非空地板/棘轮会当场红 ——
   *   这正是地板存在的意义：提取器与被提取者一起漂时，有人喊。
   *
   * ⚠️ 上面示例里的斜杠是用别的字符写的（`∕` U+2215），否则这段注释本身
   *   又会变成下一个 `*∕*` 事故。
   */
  for (const m of String(sourceText ?? '').matchAll(
    /^[ \t]*await\s+mutation\(\s*'((?:[^'\\]|\\.)*)'/gm,
  )) {
    const id = m[1].replace(/\\'/g, "'");
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * 声明了、但这一轮**一行都没有**的那些变异。
 *
 * `results` 是审计脚本的总表（`{ id, status }`）。只看 `MUT-` 开头的行 ——
 * 一条变异跑到了就一定会留下 `MUT-OK` / `MUT-BAD` / `MUT-UNKNOWN` 之一。
 */
export function absentMutations(declaredIds, results) {
  const seen = new Set(
    (results ?? [])
      .filter((r) => String(r?.status ?? '').startsWith('MUT-'))
      .map((r) => String(r.id)),
  );
  return (declaredIds ?? []).filter((id) => !seen.has(id));
}

/** 缺席那一档要喊出来的 GitHub 注解（`::warning`，与 crash 同级：不判红，但不许安静）。 */
export function absenceAnnotation(absentIds, declaredCount) {
  if (!absentIds || absentIds.length === 0) return null;
  const list = absentIds
    .join('、')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 300);
  return (
    `::warning title=有 ${absentIds.length} 条变异这一轮根本没跑到::` +
    `本轮声明 ${declaredCount} 条变异，其中 ${absentIds.length} 条**一行都没有** —— ` +
    `${list}。它们既没证明这条断言有牙齿，也没证明它没有。`
  );
}
