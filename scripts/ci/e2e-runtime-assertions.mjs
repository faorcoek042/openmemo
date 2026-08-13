/**
 * `e2e-runtime-audit.mjs` 里**判据本身**的那几行 —— 抽出来是为了能对它写证明。
 *
 * ## 为什么非抽不可（#106 顺带抓到的一条）
 *
 * `e2e-runtime-audit.mjs` 有 2800 行、全程顶层执行、最后 `process.exit()`，
 * **import 不进来**。于是它内部的判据一条都没法被喂输入 —— 而这一轮抓到的正是
 * 那种后果：
 *
 * ```js
 * // e2e-runtime-audit.mjs（修复前）
 * /先安装 CPU/.test(String(p.inapplicableReason ?? ''))
 * ```
 *
 * 这个正则匹配的是 **T-191 之前**的文案。现文案是「还没装过就**先装** CPU 基础包」——
 * `先安装 CPU` ≠ `先装 CPU`，所以它**从 T-191 那天起就再也没有匹配过任何东西**。
 * 一条恒不触发的检测：产品真的退化回那个 bug，它也不会说一个字。
 *
 * ★ 这是本周在清的第①类失效：**断言的东西在缺陷状态下也成立** ——
 *   只不过这里的"成立"是"恒为假 ⇒ 恒不报告"。
 *
 * ## 判据现在读结构
 *
 * `inapplicability.kind === 'hardware_not_probed_yet'`（`packages/shared/src/hardware.ts`
 * 的 `Inapplicability`）。**不是改成读那句英文** —— 那只是把"读中文散文"换成
 * "读英文散文"，下次措辞一动照样漂。本仓在拿散文当判据上已经栽过两次
 * （`unavailableReason` 那两条，`applicability.ts` 与 `rest/backends.ts` 各一处）。
 *
 * 证明在 `scripts/ci/selftest-e2e-runtime.mjs`：把这里的结构判据抽掉，那边当场红。
 */

/**
 * `Inapplicability` 里「还没探测到硬件能力」那一格的 kind。
 *
 * ⚠️ 与 `packages/shared/src/hardware.ts` 是**同一个字面量**，而这份文件是
 * `.mjs`、拿不到 TS 的类型检查。所以 `selftest-e2e-runtime.mjs` 里有一条
 * **契约漂移守卫**：这个字面量必须真的还在那个联合类型里。
 * 少了它，这条检测就会退回"恒不触发"——正是本次要修的那个形状。
 */
export const NOT_PROBED_YET_KIND = 'hardware_not_probed_yet';

/**
 * 这条目录条目是不是在说「**先去装 CPU 基础包，装完才测得出来**」。
 *
 * 用途只有一个：`e2e-runtime-audit.mjs` 拿它找出**用户刚装完 CPU 基础包、
 * 目录却仍然叫他去装 CPU 基础包**的那些条目 —— 一句让人去做他刚做完的事的话。
 *
 * ⚠️ 只认结构，**一个字符串都不匹配**。
 */
export function saysHardwareNotProbedYet(pack) {
  return pack?.applicable === false && pack?.inapplicability?.kind === NOT_PROBED_YET_KIND;
}

/**
 * 上面那条 + 「daemon 已经明确把它归到『还没测出来』那一档」。
 *
 * 两格由 daemon 的**同一次判断**同时产出（`rest/backends.ts` 的 `applicability()`），
 * 所以同时要求它们并不是重复：`inapplicableKind` 是给界面分档 / 排序用的粗分，
 * `inapplicability.kind` 是「具体卡在哪」。重启之后那一问要的是**两格都还这么说**，
 * 只中一格说明其中一格漂了，那本身就值得看见。
 */
export function stillSaysHardwareNotProbedYet(pack) {
  return saysHardwareNotProbedYet(pack) && pack?.inapplicableKind === 'undetermined';
}
