/**
 * 服务端数据的防御性读取。
 *
 * ## 为什么需要这么一层
 *
 * 真浏览器实测里，笔记详情页**整页崩溃**：服务端在没有标签时回的是
 * `tags: undefined` 而不是 `[]`，前端 `n.tags.map(...)` 直接炸，
 * **14 项待补验里有 6 项被这一个崩溃全部挡住**。
 *
 * 契约侧当然要修（无标签给 `[]`）。但前端也必须防 —— 这和我在文件夹树那里写过的
 * 是同一条道理：**前端不能假设服务端一定做对了，一条坏数据不该让整页白屏。**
 * 上次我把防御写在了"防环"上却没防住"形状不对"，这次把它抽成公共工具，
 * 让"消费服务端数组"这件事默认就是安全的。
 *
 * ## 用法约定
 *
 * 凡是**来自服务端**的数组字段，一律经 `arr()` 再消费：
 * ```ts
 * arr(note.tags).map(...)        // ✅
 * note.tags.map(...)             // ❌ 一个 undefined 就整页白屏
 * ```
 * 本地构造的数组不需要 —— 那是我们自己的数据，形状由我们保证。
 */

/**
 * 把"可能不是数组"的值安全地当数组用。
 *
 * 非数组（`undefined` / `null` / 对象 / 字符串）一律返回**同一个**空数组常量 ——
 * 引用稳定很重要：每次返回新的 `[]` 会让 `useMemo`/依赖数组失效，
 * 进而把一次防御变成一个性能问题（甚至无限重渲染，参见 `/tasks` 那次事故）。
 */
const EMPTY: readonly never[] = Object.freeze([]);

export function arr<T>(value: readonly T[] | null | undefined): readonly T[] {
  return Array.isArray(value) ? value : (EMPTY as readonly T[]);
}

/** 数值字段：非有限值一律回退（避免 `NaN%` 之类漏进 UI）。 */
export function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 字符串字段：非字符串一律回退（避免 `[object Object]` 漏进 UI）。 */
export function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}
