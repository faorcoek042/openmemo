/**
 * 服务端下发的**双语字段**该挑哪一份。
 *
 * ## 为什么需要这个
 *
 * `/models` 与 `/runtime` 的正文有一大半不是我们的文案，是**目录数据**：
 * 模型组名、后端包名、描述、fit 判定的原因句。把页面骨架搬进 i18n 之后，
 * 英文界面上剩下的中文**全部来自这里** —— `[实测]` 英文档 `/runtime` 残留 13 个汉字，
 * 逐个查过去全是 `pack.displayNameZh`。
 *
 * 而这些字段**英文版本一直是存在的**：
 * - `vendor/manifests/backends.json` 15 个包**每一个都同时有** `displayName` 与 `displayNameZh`；
 * - `packages/shared/src/{backends,models,components}.ts` 的类型里两个字段也都在；
 * - 模型侧还有 `descriptionZh` / `descriptionEn` 成对。
 *
 * 也就是说：**数据齐全、契约齐全，只是渲染时被写死取了中文那一份**。
 * 这不是"缺翻译"，是"有翻译没用上" —— 修法是一行，不是一次翻译工程。
 *
 * ## 判据
 *
 * 按 i18n 当前语言选，且**缺的那一份一律回落到另一份而不是显示空**：
 * 一个空的模型名比一个语言不对的模型名糟糕得多（前者用户不知道自己在看什么）。
 */

/** 当前是否中文界面。只判前缀 —— `zh-CN` / `zh-TW` / `zh` 都算。 */
function prefersZh(locale: string): boolean {
  return locale.toLowerCase().startsWith('zh');
}

/**
 * 挑一对 `{ zh, en }` 里合适的那份。
 *
 * ⚠️ 两边都可能是空串（目录里确实有条目只填了一边），所以用 `||` 而不是 `??`：
 * 空串必须触发回落，否则界面上会出现一块什么都没有的地方。
 */
export function pickLocalized(
  locale: string,
  zh: string | null | undefined,
  en: string | null | undefined,
): string {
  const z = zh ?? '';
  const e = en ?? '';
  return prefersZh(locale) ? z || e : e || z;
}

/** 目录条目的显示名。字段名照 `packages/shared` 的契约。 */
export function localizedName(
  locale: string,
  entry: { displayName?: string | null; displayNameZh?: string | null },
): string {
  return pickLocalized(locale, entry.displayNameZh, entry.displayName);
}

/** 目录条目的描述。 */
export function localizedDescription(
  locale: string,
  entry: { descriptionEn?: string | null; descriptionZh?: string | null },
): string {
  return pickLocalized(locale, entry.descriptionZh, entry.descriptionEn);
}
