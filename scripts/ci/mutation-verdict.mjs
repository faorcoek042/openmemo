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
